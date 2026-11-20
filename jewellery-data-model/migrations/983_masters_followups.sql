-- 983_masters_followups.sql — follow-ups to 976–982 (frozen). Test DB only so far; not on dev.
--  1. platform.export.run permission (owner, manager)
--  2. platform.export_job app_rw grants mirror platform.import_job: SELECT, INSERT, UPDATE, no DELETE (re-asserted)
--  3. standard HSN/SAC codes: platform.hsn_code_default (global list, no rates) copied into masters.hsn_code by
--     provision_tenant for new tenants. Existing tenants: seeds/backfill_hsn_codes.sql (per tenant, not run here:
--     the migrator has no BYPASSRLS and cannot see other tenants under forced RLS).
--  4. masters.kyc_document.doc_type no longer allows 'aadhaar'
-- Not here (later / pending): vendor.pan drop, item.hsn FK, other Aadhaar columns, design tags.

-- 1. ------------------------------------------------------------------------------------------------------------
INSERT INTO platform.permission(code, module, description) VALUES ('platform.export.run', 'platform', 'Run data exports');
INSERT INTO platform.system_role_permission(role_code, permission_code)
VALUES ('owner', 'platform.export.run'), ('manager', 'platform.export.run');

-- 2. ------------------------------------------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON platform.export_job TO app_rw;

-- 3. ------------------------------------------------------------------------------------------------------------
CREATE TABLE platform.hsn_code_default (   -- global catalogue (no tenant_id, like platform.permission); rates live in tax_rule
  code_type   text NOT NULL CHECK (code_type IN ('HSN','SAC')),
  code        varchar(8) NOT NULL CHECK (code ~ '^[0-9]{4,8}$'),
  description text NOT NULL,
  uqc         varchar(3) CHECK (uqc ~ '^[A-Z]{3}$'),
  sort_order  int NOT NULL,
  CONSTRAINT hsn_code_default_pkey PRIMARY KEY (code_type, code)
);
INSERT INTO platform.hsn_code_default(code_type, code, description, uqc, sort_order) VALUES
 ('HSN','7113','Articles of jewellery and parts thereof, of precious metal or metal clad with precious metal','GMS',10),
 ('HSN','7114','Articles of goldsmiths'' or silversmiths'' wares and parts thereof','GMS',20),
 ('HSN','7117','Imitation jewellery','NOS',30),
 ('HSN','7118','Coin','NOS',40),
 ('HSN','7106','Silver, unwrought or in semi-manufactured forms, or in powder form','GMS',50),
 ('HSN','7108','Gold, unwrought or in semi-manufactured forms, or in powder form','GMS',60),
 ('HSN','7110','Platinum, unwrought or in semi-manufactured forms, or in powder form','GMS',70),
 ('HSN','7101','Pearls, natural or cultured, whether or not worked or graded','CTS',80),
 ('HSN','7102','Diamonds, whether or not worked, but not mounted or set','CTS',90),
 ('HSN','7103','Precious (other than diamonds) and semi-precious stones, not mounted or set','CTS',100),
 ('HSN','7104','Synthetic or reconstructed precious or semi-precious stones','CTS',110),
 ('SAC','9988','Manufacturing services on physical inputs owned by others (job work)',NULL,120);
REVOKE ALL ON platform.hsn_code_default FROM PUBLIC;
GRANT SELECT ON platform.hsn_code_default TO app_rw, app_ro, app_admin, tenant_provisioner;
-- provisioning (SECURITY DEFINER, owner tenant_provisioner) writes the tenant's copy under the tenant context it sets
GRANT USAGE ON SCHEMA masters TO tenant_provisioner;
GRANT INSERT ON masters.hsn_code TO tenant_provisioner;

-- 4. ------------------------------------------------------------------------------------------------------------
-- No Aadhaar documents for now (Adithya, 2026-10-28). Same spellings as 979; 'gstin_certificate' is 979's GSTIN value.
-- Other Aadhaar columns (customer/vendor/staff aadhaar_last4) are untouched.
ALTER TABLE masters.kyc_document DROP CONSTRAINT kyc_document_doc_type_check;
ALTER TABLE masters.kyc_document ADD CONSTRAINT kyc_document_doc_type_check
  CHECK (doc_type IN ('pan','passport','voter_id','driving_licence','gstin_certificate','other'));

-- same 16-arg signature, owner, SECURITY DEFINER, search_path, grants and audit event as 971; only the HSN copy is new
CREATE OR REPLACE FUNCTION platform.provision_tenant(
  p_slug text, p_display_name text, p_partner_id uuid,
  p_legal_name text, p_gstin text, p_pan text, p_state_code text,
  p_branch_code text, p_branch_name text,
  p_owner_name text, p_owner_phone text, p_owner_username text, p_owner_password_hash text,
  p_language text DEFAULT 'en', p_deployment_mode text DEFAULT 'shared',
  p_bill_series_prefix text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_tenant uuid := platform.uuid_v7(); v_company uuid := platform.uuid_v7(); v_branch uuid := platform.uuid_v7();
        v_owner uuid := platform.uuid_v7(); v_prev text := current_setting('app.tenant_id', true);
        v_prev_user text := current_setting('app.user_id', true);
        v_prefix text := upper(coalesce(nullif(btrim(p_bill_series_prefix), ''), p_branch_code));
BEGIN
  -- same rule as the platform.branch.bill_series_prefix CHECK (010); checked up front for a clear error, nothing written yet
  IF v_prefix IS NULL OR v_prefix !~ '^[A-Z0-9][A-Z0-9/-]{0,11}$' THEN
    RAISE EXCEPTION 'invalid bill series prefix %: 1-12 chars, A-Z 0-9 / -, starting with a letter or digit', quote_nullable(p_bill_series_prefix)
      USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO platform.tenant(id, partner_id, slug, display_name, status, default_language, deployment_mode)
  VALUES (v_tenant, p_partner_id, lower(p_slug), p_display_name, 'trial', p_language, p_deployment_mode);  -- CHECK on tenant
  PERFORM set_config('app.tenant_id', v_tenant::text, true);
  PERFORM set_config('app.user_id', v_owner::text, true);
  INSERT INTO platform.company(tenant_id, id, legal_name, gstin, pan, state_code)
  VALUES (v_tenant, v_company, p_legal_name, p_gstin, p_pan, p_state_code);
  INSERT INTO platform.branch(tenant_id, id, company_id, code, name, bill_series_prefix, state_code)
  VALUES (v_tenant, v_branch, v_company, upper(p_branch_code), p_branch_name, v_prefix, p_state_code);
  INSERT INTO platform.app_user(tenant_id, id, name, phone, username, password_hash, default_branch_id)
  VALUES (v_tenant, v_owner, p_owner_name, p_owner_phone, p_owner_username, p_owner_password_hash, v_branch);
  INSERT INTO platform.role(tenant_id, name, system_role_code) SELECT v_tenant, name, code FROM platform.system_role;
  INSERT INTO platform.user_role(tenant_id, user_id, role_id)
  SELECT v_tenant, v_owner, id FROM platform.role WHERE tenant_id = v_tenant AND system_role_code = 'owner';
  INSERT INTO platform.onboarding_progress(tenant_id, step) SELECT v_tenant, code FROM platform.onboarding_step;
  -- 983: standard HSN/SAC codes from the platform default list (no rates; GST stays in masters.tax_rule)
  INSERT INTO masters.hsn_code(tenant_id, code_type, code, description, uqc)
  SELECT v_tenant, code_type, code, description, uqc FROM platform.hsn_code_default ORDER BY sort_order;
  -- semantic audit event (row-level events for branch/app_user/role/user_role come from their zz_audit triggers);
  -- written here so callers (app_admin) never need audit_append themselves
  PERFORM platform.audit_append(v_tenant, 'tenant.provisioned', 'platform.tenant', v_tenant, NULL,
          jsonb_build_object('slug', lower(p_slug), 'partner_id', p_partner_id, 'deployment_mode', p_deployment_mode, 'bill_series_prefix', v_prefix,
                             'company_id', v_company, 'branch_id', v_branch, 'owner_user_id', v_owner,
                             'by', coalesce(nullif(current_setting('app.admin_id', true), ''), session_user::text)));
  PERFORM set_config('app.tenant_id', coalesce(v_prev, ''), true);
  PERFORM set_config('app.user_id', coalesce(v_prev_user, ''), true);
  RETURN v_tenant;
END $$;
