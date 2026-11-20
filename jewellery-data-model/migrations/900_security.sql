-- 900_security.sql — Row-Level Security (forced, every mode) and module ownership grants.
-- Re-runnable: drops/recreates policies. Run last, and re-run after adding tables.

-- ===================== RLS =====================
DO $$
DECLARE r record;
BEGIN
  -- 1. tenant isolation on every table that has tenant_id (except scope-aware branding tables)
  FOR r IN
    SELECT c.table_schema, c.table_name
    FROM information_schema.columns c JOIN information_schema.tables t USING (table_schema, table_name)
    WHERE c.column_name = 'tenant_id' AND t.table_type = 'BASE TABLE'
      AND c.table_schema IN ('platform','billing','notifications','masters','rates','hr','accounts','inventory',
                             'approvals','sales','orders','purchases','refinery','branding')
      AND (c.table_schema, c.table_name) NOT IN (('branding','theme'),('branding','custom_domain'),('branding','sender_config'),('branding','print_template'),('masters','tax_rule'),('masters','sales_policy'))
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', r.table_schema, r.table_name);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', r.table_schema, r.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I.%I', r.table_schema, r.table_name);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I.%I
                     USING (tenant_id = platform.current_tenant())
                     WITH CHECK (tenant_id = platform.current_tenant())$p$, r.table_schema, r.table_name);
  END LOOP;

  -- 2. optional branch sub-scope: when app.branch_scope ('uuid,uuid') is set, restrict rows carrying branch_id
  FOR r IN
    SELECT c.table_schema, c.table_name
    FROM information_schema.columns c JOIN information_schema.tables t USING (table_schema, table_name)
    WHERE c.column_name = 'branch_id' AND t.table_type = 'BASE TABLE'
      AND c.table_schema IN ('masters','rates','hr','accounts','inventory','approvals','sales','orders','purchases','refinery')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS branch_scope ON %I.%I', r.table_schema, r.table_name);
    EXECUTE format($p$CREATE POLICY branch_scope ON %I.%I AS RESTRICTIVE
                     USING (coalesce(current_setting('app.branch_scope', true), '') = ''
                            OR branch_id IS NULL
                            OR branch_id::text = ANY (string_to_array(current_setting('app.branch_scope', true), ',')))$p$,
                   r.table_schema, r.table_name);
  END LOOP;
END $$;

-- P3: a partner (reseller) session never sees shop data. Restrictive policy on every tenant table outside
-- branding and billing: rows are hidden whenever app.partner_id is set, even if app.tenant_id is also set.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.table_schema, c.table_name
    FROM information_schema.columns c JOIN information_schema.tables t USING (table_schema, table_name)
    WHERE c.column_name = 'tenant_id' AND t.table_type = 'BASE TABLE'
      AND c.table_schema IN ('platform','notifications','masters','rates','hr','accounts','inventory',
                             'approvals','sales','orders','purchases','refinery')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS no_partner_access ON %I.%I', r.table_schema, r.table_name);
    EXECUTE format($p$CREATE POLICY no_partner_access ON %I.%I AS RESTRICTIVE
                     USING (platform.current_partner() IS NULL) WITH CHECK (platform.current_partner() IS NULL)$p$,
                   r.table_schema, r.table_name);
  END LOOP;
END $$;

-- P3: partners read the SaaS billing of their own shops (plans, subscriptions, our invoices, usage)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['subscription','subscription_invoice','usage_meter'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS partner_billing_read ON billing.%I', t);
    EXECUTE format($p$CREATE POLICY partner_billing_read ON billing.%I FOR SELECT
                     USING (platform.current_partner() IS NOT NULL
                            AND tenant_id IN (SELECT platform.partner_tenant_ids()))$p$, t);
    -- P23 admin console reads billing and usage of every shop
    EXECUTE format('DROP POLICY IF EXISTS admin_read ON billing.%I', t);
    EXECUTE format('CREATE POLICY admin_read ON billing.%I FOR SELECT TO app_admin USING (true)', t);
  END LOOP;
END $$;

-- P23 admin console: all tenants and partners, create / suspend
DROP POLICY IF EXISTS admin_all ON platform.tenant;
CREATE POLICY admin_all ON platform.tenant TO app_admin USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS admin_all ON platform.partner;
CREATE POLICY admin_all ON platform.partner TO app_admin USING (true) WITH CHECK (true);

-- pg-boss worker drains the outbox across tenants
-- The single shared worker drains all tenants (simpler and cheaper than one worker per tenant). It can
-- only SELECT and UPDATE delivery columns, never INSERT/DELETE, so it cannot fabricate or remove alerts.
DROP POLICY IF EXISTS worker_all ON notifications.outbox;
DROP POLICY IF EXISTS worker_read ON notifications.outbox;
DROP POLICY IF EXISTS worker_update ON notifications.outbox;
CREATE POLICY worker_read ON notifications.outbox FOR SELECT TO app_worker USING (true);
CREATE POLICY worker_update ON notifications.outbox FOR UPDATE TO app_worker USING (true) WITH CHECK (true);

-- tenants & partners: a tenant sees itself; a partner session (app.partner_id) sees its tenants
ALTER TABLE platform.tenant ENABLE ROW LEVEL SECURITY;  ALTER TABLE platform.tenant FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_self ON platform.tenant;
-- A shop reads its own tenant row. Partners do NOT read platform.tenant directly: they use
-- platform.v_partner_tenant_directory (name, status, plan, subscription status only) and partner_tenant_ids().
DROP POLICY IF EXISTS tenant_update_language ON platform.tenant;
DROP POLICY IF EXISTS tenant_insert ON platform.tenant;
DROP POLICY IF EXISTS lookup_read ON platform.tenant;
DROP POLICY IF EXISTS provisioner_insert ON platform.tenant;
CREATE POLICY tenant_self ON platform.tenant FOR SELECT
  USING (id = platform.current_tenant() AND platform.current_partner() IS NULL);
-- the shop may change its own default_language (column grant below); nothing else, never another tenant
CREATE POLICY tenant_update_language ON platform.tenant FOR UPDATE
  USING (id = platform.current_tenant() AND platform.current_partner() IS NULL)
  WITH CHECK (id = platform.current_tenant() AND platform.current_partner() IS NULL);
CREATE POLICY tenant_insert ON platform.tenant FOR INSERT
  WITH CHECK (pg_has_role(current_user, 'platform_writer', 'MEMBER'));          -- migrator / seed only
CREATE POLICY lookup_read ON platform.tenant FOR SELECT TO platform_lookup USING (true);   -- resolve_tenant, directory
CREATE POLICY provisioner_insert ON platform.tenant FOR INSERT TO tenant_provisioner WITH CHECK (true);

ALTER TABLE platform.partner ENABLE ROW LEVEL SECURITY; ALTER TABLE platform.partner FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS partner_self ON platform.partner;
CREATE POLICY partner_self ON platform.partner
  USING (id = platform.current_partner()
         OR id = (SELECT t.partner_id FROM platform.tenant t WHERE t.id = platform.current_tenant())
         OR pg_has_role(current_user, 'platform_writer', 'MEMBER'))
  WITH CHECK (pg_has_role(current_user, 'platform_writer', 'MEMBER'));

-- branding: read = platform default + own partner + own tenant; write = own level only
CREATE OR REPLACE FUNCTION branding.my_partner() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = platform, pg_temp AS $$
  SELECT coalesce(platform.current_partner(),
                  (SELECT partner_id FROM platform.tenant WHERE id = platform.current_tenant())) $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['theme','custom_domain','sender_config','print_template'] LOOP
    EXECUTE format('ALTER TABLE branding.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE branding.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS scope_read ON branding.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS scope_write ON branding.%I', t);
    EXECUTE format($p$CREATE POLICY scope_read ON branding.%I FOR SELECT USING (
        tenant_id = platform.current_tenant()
        OR (partner_id IS NOT NULL AND partner_id = branding.my_partner())
        OR (%s)
        OR (%s))$p$, t,
        -- a partner sees its shops' theme/domains/sender, but NOT a shop's own print templates (they may carry shop
        -- data such as bank details / terms); it only sees its own partner defaults and the platform ones.
        CASE WHEN t = 'print_template' THEN 'false'
             ELSE $x$tenant_id IS NOT NULL AND tenant_id IN (SELECT platform.partner_tenant_ids())$x$ END,
        CASE WHEN t IN ('theme','print_template') THEN $x$scope = 'platform'$x$ ELSE 'false' END);
    EXECUTE format($p$CREATE POLICY scope_write ON branding.%I FOR ALL
        USING ((tenant_id IS NOT NULL AND tenant_id = platform.current_tenant())
            OR (partner_id IS NOT NULL AND partner_id = platform.current_partner())
            OR (tenant_id IS NULL AND partner_id IS NULL AND pg_has_role(current_user, 'platform_writer', 'MEMBER')))
        WITH CHECK ((tenant_id IS NOT NULL AND tenant_id = platform.current_tenant())
            OR (partner_id IS NOT NULL AND partner_id = platform.current_partner())
            OR (tenant_id IS NULL AND partner_id IS NULL AND pg_has_role(current_user, 'platform_writer', 'MEMBER')))$p$, t);
  END LOOP;
END $$;

-- idempotency keys: pg-boss cleanup may read/delete only rows older than 24 h, across tenants
DROP POLICY IF EXISTS worker_cleanup_read ON sales.idempotency_key;
DROP POLICY IF EXISTS worker_cleanup ON sales.idempotency_key;
CREATE POLICY worker_cleanup_read ON sales.idempotency_key FOR SELECT TO app_worker USING (created_at < now() - interval '24 hours');
CREATE POLICY worker_cleanup ON sales.idempotency_key FOR DELETE TO app_worker USING (created_at < now() - interval '24 hours');

-- tax rules: tenants read platform defaults + their own; write only their own; platform rows by platform_writer
ALTER TABLE masters.tax_rule ENABLE ROW LEVEL SECURITY; ALTER TABLE masters.tax_rule FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tax_read ON masters.tax_rule;
DROP POLICY IF EXISTS tax_write ON masters.tax_rule;
CREATE POLICY tax_read ON masters.tax_rule FOR SELECT USING (scope = 'platform' OR tenant_id = platform.current_tenant());
CREATE POLICY tax_write ON masters.tax_rule FOR ALL
  USING ((scope = 'tenant' AND tenant_id = platform.current_tenant())
      OR (scope = 'platform' AND pg_has_role(current_user, 'platform_writer', 'MEMBER')))
  WITH CHECK ((scope = 'tenant' AND tenant_id = platform.current_tenant())
      OR (scope = 'platform' AND pg_has_role(current_user, 'platform_writer', 'MEMBER')));

ALTER TABLE masters.sales_policy ENABLE ROW LEVEL SECURITY; ALTER TABLE masters.sales_policy FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS policy_read ON masters.sales_policy;
DROP POLICY IF EXISTS policy_write ON masters.sales_policy;
CREATE POLICY policy_read ON masters.sales_policy FOR SELECT USING (scope = 'platform' OR tenant_id = platform.current_tenant());
CREATE POLICY policy_write ON masters.sales_policy FOR ALL
  USING ((scope = 'tenant' AND tenant_id = platform.current_tenant())
      OR (scope = 'platform' AND pg_has_role(current_user, 'platform_writer', 'MEMBER')))
  WITH CHECK ((scope = 'tenant' AND tenant_id = platform.current_tenant())
      OR (scope = 'platform' AND pg_has_role(current_user, 'platform_writer', 'MEMBER')));

-- pre-auth host -> tenant lookup: verified hostnames are public (DNS) so any API session may read them
DROP POLICY IF EXISTS verified_host_lookup ON branding.custom_domain;
CREATE POLICY verified_host_lookup ON branding.custom_domain FOR SELECT USING (status = 'verified');

-- ===================== GRANTS =====================
-- baseline: nobody but the owner has anything
DO $$
DECLARE s text;
BEGIN
  FOREACH s IN ARRAY ARRAY['platform','billing','notifications','masters','rates','hr','accounts','inventory',
                           'approvals','sales','orders','purchases','refinery','reports','branding'] LOOP
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM app_rw, app_ro, app_worker, PUBLIC', s);
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO app_rw, app_ro, platform_writer, sales_writer, inventory_writer, notifications_writer, accounts_writer', s);
    EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO app_ro', s);   -- reports role: read only, everywhere
    EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO app_rw', s);
  END LOOP;
END $$;
GRANT USAGE ON SCHEMA notifications, platform, branding TO app_worker;

-- app_rw (API) — module CRUD where the module owns ordinary rows
GRANT INSERT, UPDATE ON ALL TABLES IN SCHEMA masters, hr, approvals TO app_rw;
GRANT INSERT, UPDATE ON platform.doc_counter TO app_rw;   -- non-gapless numbering
GRANT DELETE ON ALL TABLES IN SCHEMA masters, hr TO app_rw;          -- masters may be removed if unreferenced (FKs protect)
GRANT INSERT ON rates.metal_rate TO app_rw;                          -- corrections = new row (no UPDATE/DELETE grant)
GRANT INSERT, UPDATE ON accounts.account_group, accounts.account_head, accounts.cash_counter, accounts.voucher TO app_rw;
GRANT INSERT, UPDATE ON inventory.lot, inventory.lot_line, inventory.tag_stone, inventory.stock_transfer,
                       inventory.stock_transfer_line, inventory.box_weight_check, inventory.stock_take TO app_rw;
GRANT INSERT ON inventory.tag TO app_rw;
-- column-level: app_rw may edit descriptive tag fields, never status / location
GRANT UPDATE (counter_id, box_id, size, mc_type, mc_value, wastage_pct, min_wastage_pct, max_wastage_pct,
              min_sale_value, max_sale_value, huid_charge, cost_value, huid, hallmark_exempt) ON inventory.tag TO app_rw;
GRANT DELETE ON inventory.tag_stone TO app_rw;
GRANT INSERT, UPDATE ON sales.estimate, sales.chit_scheme, sales.chit_instalment TO app_rw;
GRANT INSERT ON sales.advance, sales.chit_enrolment TO app_rw;
GRANT UPDATE (purpose, status, order_id) ON sales.advance TO app_rw;               -- never balance
GRANT UPDATE (status, maturity_date, accumulated_amount, accumulated_weight) ON sales.chit_enrolment TO app_rw;
GRANT INSERT, UPDATE ON platform.company, platform.branch, platform.setting, platform.app_user, platform.role,
                       platform.user_role, platform.user_session, platform.licence, platform.device,
                       platform.otp_challenge, platform.import_job, platform.onboarding_progress TO app_rw;
GRANT DELETE ON platform.setting TO app_rw;                -- remove an override = fall back to the platform default
-- global catalogues (permission, system_role, system_role_permission, setting_default, onboarding_step): read only

-- P23 admin console role: tenants, partners, platform admins, billing and usage; nothing else
GRANT USAGE ON SCHEMA platform, billing, branding TO app_admin;
GRANT SELECT, INSERT ON platform.tenant, platform.partner TO app_admin;
GRANT UPDATE (status, suspended_at, suspend_reason, display_name, partner_id) ON platform.tenant TO app_admin;
GRANT UPDATE (status) ON platform.partner TO app_admin;
GRANT SELECT ON platform.platform_admin, billing.plan, billing.subscription, billing.subscription_invoice, billing.usage_meter TO app_admin;
GRANT SELECT ON platform.setting_default, platform.onboarding_step TO app_admin;
-- operator credentials are visible to the admin console only
REVOKE ALL ON platform.platform_admin FROM app_rw, app_ro, app_worker;
GRANT DELETE ON platform.user_role TO app_rw;
GRANT INSERT (tenant_id, id, topic, payload, priority, available_at, ref_type, ref_id) ON notifications.outbox TO app_rw;   -- never alert_type
GRANT INSERT, UPDATE ON notifications.template, notifications.in_app_alert TO app_rw;
GRANT INSERT, UPDATE, DELETE ON branding.theme, branding.custom_domain, branding.sender_config TO app_rw;
GRANT INSERT, UPDATE ON branding.print_template TO app_rw;
GRANT SELECT ON platform.v_billing_unlocked TO app_rw, app_ro;
GRANT INSERT, UPDATE ON billing.subscription, billing.subscription_invoice, billing.usage_meter TO app_rw;
-- NOT granted to app_rw: any write on sales.invoice*, sales.credit_note*, sales.doc_series,
-- inventory.stock_ledger, inventory.tag(status, branch_id), accounts.ledger_entry, platform.audit_*.

-- app_worker (pg-boss)
GRANT SELECT ON notifications.outbox TO app_worker;
GRANT USAGE ON SCHEMA sales TO app_worker;
GRANT SELECT, DELETE ON sales.idempotency_key TO app_worker;   -- 24 h retention job only (RLS limits to old rows)
GRANT UPDATE (status, attempts, available_at, claimed_at, claimed_by, sent_at, last_error) ON notifications.outbox TO app_worker;
GRANT SELECT, INSERT ON notifications.in_app_alert TO app_worker;
DROP POLICY IF EXISTS worker_insert ON notifications.in_app_alert;
CREATE POLICY worker_insert ON notifications.in_app_alert FOR ALL TO app_worker USING (true) WITH CHECK (true);
GRANT SELECT ON ALL TABLES IN SCHEMA branding TO app_worker;

-- module roles: the API assumes them with SET LOCAL ROLE inside a transaction (no inherited rights)
GRANT sales_writer, inventory_writer, accounts_writer, orders_writer, purchases_writer, refinery_writer
   TO app_rw WITH INHERIT FALSE, SET TRUE;
GRANT USAGE ON SCHEMA platform, masters, rates, inventory, orders, purchases, refinery, sales, accounts
   TO orders_writer, purchases_writer, refinery_writer;

-- orders / purchases / refinery modules: write only their own schema (+ non-gapless counters); stock moves
-- still go through inventory_writer (they have NO write on inventory.*)
GRANT SELECT ON ALL TABLES IN SCHEMA platform, masters, rates, inventory, orders TO orders_writer;
GRANT INSERT, UPDATE ON ALL TABLES IN SCHEMA orders TO orders_writer;
GRANT SELECT ON sales.invoice, sales.advance TO orders_writer;
GRANT SELECT ON ALL TABLES IN SCHEMA platform, masters, rates, inventory, purchases TO purchases_writer;
GRANT INSERT, UPDATE ON ALL TABLES IN SCHEMA purchases TO purchases_writer;
GRANT SELECT ON ALL TABLES IN SCHEMA platform, masters, rates, inventory, refinery, purchases TO refinery_writer;
GRANT SELECT ON sales.invoice_old_metal TO refinery_writer;
GRANT INSERT, UPDATE ON ALL TABLES IN SCHEMA refinery TO refinery_writer;
GRANT INSERT, UPDATE ON platform.doc_counter TO orders_writer, purchases_writer, refinery_writer, sales_writer;
GRANT USAGE ON SCHEMA platform, masters, rates, inventory, approvals, sales, hr, notifications, accounts TO sales_writer, inventory_writer, accounts_writer;

-- sales module: the ONLY writer of tax documents and counters
GRANT SELECT ON ALL TABLES IN SCHEMA platform, masters, rates, inventory, approvals, sales, hr TO sales_writer;
GRANT INSERT ON sales.invoice, sales.invoice_line, sales.invoice_line_tax, sales.invoice_old_metal, sales.invoice_payment,
                sales.credit_note, sales.credit_note_line TO sales_writer;
GRANT UPDATE (status, cancelled_at, cancel_credit_note_id, irn, irn_ack_at) ON sales.invoice TO sales_writer;
GRANT UPDATE (balance_available) ON sales.credit_note TO sales_writer;
GRANT INSERT, UPDATE ON sales.doc_series TO sales_writer;
GRANT INSERT, UPDATE ON sales.estimate TO sales_writer;
GRANT INSERT ON sales.idempotency_key TO sales_writer;   -- SELECT via baseline
GRANT UPDATE (invoice_id) ON sales.idempotency_key TO sales_writer;
GRANT UPDATE (balance, status) ON sales.advance TO sales_writer;                    -- redemption (guarded by G4b)
GRANT UPDATE (redeemed_amount, status) ON sales.chit_enrolment TO sales_writer;     -- chit redemption
GRANT UPDATE ON approvals.request TO sales_writer;
GRANT INSERT (tenant_id, id, topic, payload, priority, available_at, ref_type, ref_id) ON notifications.outbox TO sales_writer;
-- notifications_writer: owner of the credit-note alert trigger; the only role that may set alert_type
GRANT USAGE ON SCHEMA sales TO notifications_writer;
GRANT SELECT ON sales.invoice TO notifications_writer;
GRANT SELECT, INSERT ON notifications.outbox TO notifications_writer;

-- inventory module: the ONLY writer of the stock ledger and tag status/location
GRANT SELECT ON ALL TABLES IN SCHEMA platform, masters, inventory TO inventory_writer;
GRANT INSERT ON inventory.stock_ledger TO inventory_writer;
GRANT UPDATE (status, branch_id) ON inventory.tag TO inventory_writer;

-- accounts module: the ONLY writer of the ledger
GRANT SELECT ON ALL TABLES IN SCHEMA accounts TO accounts_writer;
GRANT INSERT ON accounts.ledger_entry TO accounts_writer;

-- platform_writer: owner of the audit trigger function (hash chain)
GRANT SELECT ON platform.audit_chain_head, platform.audit_event, platform.tenant TO platform_writer;
GRANT INSERT, UPDATE ON platform.audit_chain_head TO platform_writer;
GRANT INSERT ON platform.audit_event TO platform_writer;

-- ===== platform access additions (v1.4) =====
-- partner users / sessions: visible only inside their own partner context
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['partner_user','partner_session'] LOOP
    EXECUTE format('ALTER TABLE platform.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE platform.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS partner_isolation ON platform.%I', t);
    EXECUTE format($p$CREATE POLICY partner_isolation ON platform.%I
                     USING (partner_id = platform.current_partner()) WITH CHECK (partner_id = platform.current_partner())$p$, t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON platform.partner_user, platform.partner_session TO app_rw;
REVOKE ALL ON platform.partner_user, platform.partner_session FROM app_ro, app_worker;

-- platform admin sessions: admin console only
ALTER TABLE platform.platform_admin_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.platform_admin_session FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS admin_all ON platform.platform_admin_session;
CREATE POLICY admin_all ON platform.platform_admin_session TO app_admin USING (true) WITH CHECK (true);
REVOKE ALL ON platform.platform_admin_session FROM app_rw, app_ro, app_worker;
GRANT SELECT, INSERT ON platform.platform_admin_session TO app_admin;
GRANT UPDATE (last_seen_at, revoked_at) ON platform.platform_admin_session TO app_admin;

-- shop may change its own default language only
GRANT UPDATE (default_language) ON platform.tenant TO app_rw;

-- OTP delivery: API inserts ciphertext; worker reads and deletes after sending; nobody updates
REVOKE ALL ON platform.otp_delivery FROM app_rw;
GRANT INSERT ON platform.otp_delivery TO app_rw;              -- write-only for the API
REVOKE ALL ON platform.otp_delivery FROM app_ro;
GRANT SELECT, DELETE ON platform.otp_delivery TO app_worker;
DROP POLICY IF EXISTS worker_drain ON platform.otp_delivery;
CREATE POLICY worker_drain ON platform.otp_delivery FOR ALL TO app_worker USING (true) WITH CHECK (false);
REVOKE ALL ON platform.otp_challenge FROM app_ro;                -- hashes are not report data

-- imports
GRANT SELECT, INSERT ON platform.import_row_error TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.import_mapping_profile TO app_rw;

-- a partner context never sees shop print templates, even with tenant context also set
DROP POLICY IF EXISTS partner_no_tenant_templates ON branding.print_template;
CREATE POLICY partner_no_tenant_templates ON branding.print_template AS RESTRICTIVE
  USING (platform.current_partner() IS NULL OR scope <> 'tenant')
  WITH CHECK (platform.current_partner() IS NULL OR scope <> 'tenant');

-- narrow definer roles
GRANT SELECT (id, slug, status, partner_id, display_name) ON platform.tenant TO platform_lookup;
GRANT SELECT (tenant_id, plan_code, status, current_period_end) ON billing.subscription TO platform_lookup;
GRANT SELECT (code, name) ON billing.plan TO platform_lookup;
DROP POLICY IF EXISTS lookup_read ON billing.subscription;
CREATE POLICY lookup_read ON billing.subscription FOR SELECT TO platform_lookup USING (true);
GRANT EXECUTE ON FUNCTION platform.resolve_tenant(text) TO app_rw;          -- pre-login: no tenant context yet
GRANT SELECT ON platform.v_partner_tenant_directory TO app_rw;
GRANT INSERT ON platform.tenant, platform.company, platform.branch, platform.app_user, platform.role,
                platform.user_role, platform.onboarding_progress TO tenant_provisioner;
GRANT SELECT ON platform.role, platform.system_role, platform.onboarding_step TO tenant_provisioner;
GRANT EXECUTE ON FUNCTION platform.provision_tenant(text,text,uuid,text,text,text,text,text,text,text,text,text,text,text) TO app_admin;

-- functions: only the audit appender is privileged
REVOKE EXECUTE ON FUNCTION platform.audit_append(uuid,text,text,uuid,jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.audit_append(uuid,text,text,uuid,jsonb,jsonb) TO app_rw;   -- semantic events (print, login, export)

-- Read access for app_ro on tables created by future migrations (run as app_migrator, the object owner)
DO $$
DECLARE s text;
BEGIN
  FOREACH s IN ARRAY ARRAY['platform','billing','notifications','masters','rates','hr','accounts','inventory',
                           'approvals','sales','orders','purchases','refinery','reports','branding'] LOOP
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA %I GRANT SELECT ON TABLES TO app_ro', s);
  END LOOP;
END $$;
