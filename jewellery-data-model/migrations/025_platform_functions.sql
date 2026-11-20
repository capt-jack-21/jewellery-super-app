-- 025_platform_functions.sql — the few approved platform DB functions/views, plus optimistic-concurrency columns.
-- Exceptions to the "logic lives in the app" rule (approved, like the audit writer): they need to cross RLS in a
-- narrow, fixed way (pre-login lookup, partner directory) or must be atomic (tenant provisioning). No pricing logic.

-- ---------- optimistic concurrency: version on editable platform / branding tables ----------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['platform.partner','platform.tenant','platform.company','platform.branch','platform.app_user',
                           'platform.role','platform.setting','platform.device','platform.import_mapping_profile',
                           'platform.partner_user','branding.theme','branding.custom_domain','branding.print_template',
                           'branding.sender_config'] LOOP
    EXECUTE format('ALTER TABLE %s ADD COLUMN IF NOT EXISTS version int NOT NULL DEFAULT 1', t);
    EXECUTE format('CREATE TRIGGER aa_version BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION platform.bump_version()', t);
  END LOOP;
END $$;

-- ---------- pre-login tenant lookup ----------
-- Owned by platform_lookup (NOLOGIN), which may read only (id, slug, status, partner_id) of platform.tenant through
-- its own RLS policy (900_security.sql). Returns no PII.
CREATE FUNCTION platform.resolve_tenant(p_slug text)
RETURNS TABLE (tenant_id uuid, status text, partner_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT t.id, t.status, t.partner_id FROM platform.tenant t WHERE t.slug = lower(p_slug)
$$;
ALTER FUNCTION platform.resolve_tenant(text) OWNER TO platform_lookup;
REVOKE EXECUTE ON FUNCTION platform.resolve_tenant(text) FROM PUBLIC;

-- tenant ids of the current partner (used by branding/billing RLS so partners never need direct tenant access)
CREATE FUNCTION platform.partner_tenant_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT t.id FROM platform.tenant t
  WHERE platform.current_partner() IS NOT NULL AND t.partner_id = platform.current_partner()
$$;
ALTER FUNCTION platform.partner_tenant_ids() OWNER TO platform_lookup;

-- ---------- partner tenant directory: name, status, plan and subscription status only ----------
CREATE VIEW platform.v_partner_tenant_directory AS
SELECT t.id AS tenant_id, t.display_name, t.status AS tenant_status,
       s.plan_code, p.name AS plan_name, s.status AS subscription_status
FROM platform.tenant t
LEFT JOIN LATERAL (SELECT plan_code, status FROM billing.subscription bs WHERE bs.tenant_id = t.id
                   ORDER BY current_period_end DESC LIMIT 1) s ON true
LEFT JOIN billing.plan p ON p.code = s.plan_code
WHERE platform.current_partner() IS NOT NULL AND t.partner_id = platform.current_partner();
ALTER VIEW platform.v_partner_tenant_directory OWNER TO platform_lookup;   -- runs with the owner's narrow rights

-- ---------- atomic tenant provisioning (thin: inserts only) ----------
-- Creates tenant, company, first branch, the four preset roles, the owner user, and the 10 onboarding rows.
-- Settings are NOT copied: a new shop inherits platform.setting_default / platform-scope sales_policy and tax rules
-- until it overrides them. Owned by tenant_provisioner, which has INSERT on exactly these tables.
CREATE FUNCTION platform.provision_tenant(
  p_slug text, p_display_name text, p_partner_id uuid,
  p_legal_name text, p_gstin text, p_pan text, p_state_code text,
  p_branch_code text, p_branch_name text,
  p_owner_name text, p_owner_phone text, p_owner_username text, p_owner_password_hash text,
  p_language text DEFAULT 'en')
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_tenant uuid := platform.uuid_v7(); v_company uuid := platform.uuid_v7(); v_branch uuid := platform.uuid_v7();
        v_owner uuid := platform.uuid_v7(); v_prev text := current_setting('app.tenant_id', true);
        v_prev_user text := current_setting('app.user_id', true);
BEGIN
  INSERT INTO platform.tenant(id, partner_id, slug, display_name, status, default_language)
  VALUES (v_tenant, p_partner_id, lower(p_slug), p_display_name, 'trial', p_language);
  PERFORM set_config('app.tenant_id', v_tenant::text, true);
  PERFORM set_config('app.user_id', v_owner::text, true);
  INSERT INTO platform.company(tenant_id, id, legal_name, gstin, pan, state_code)
  VALUES (v_tenant, v_company, p_legal_name, p_gstin, p_pan, p_state_code);
  INSERT INTO platform.branch(tenant_id, id, company_id, code, name, bill_series_prefix, state_code)
  VALUES (v_tenant, v_branch, v_company, upper(p_branch_code), p_branch_name, upper(p_branch_code), p_state_code);
  INSERT INTO platform.app_user(tenant_id, id, name, phone, username, password_hash, default_branch_id)
  VALUES (v_tenant, v_owner, p_owner_name, p_owner_phone, p_owner_username, p_owner_password_hash, v_branch);
  INSERT INTO platform.role(tenant_id, name, system_role_code) SELECT v_tenant, name, code FROM platform.system_role;
  INSERT INTO platform.user_role(tenant_id, user_id, role_id)
  SELECT v_tenant, v_owner, id FROM platform.role WHERE tenant_id = v_tenant AND system_role_code = 'owner';
  INSERT INTO platform.onboarding_progress(tenant_id, step) SELECT v_tenant, code FROM platform.onboarding_step;
  PERFORM set_config('app.tenant_id', coalesce(v_prev, ''), true);
  PERFORM set_config('app.user_id', coalesce(v_prev_user, ''), true);
  RETURN v_tenant;
END $$;
ALTER FUNCTION platform.provision_tenant(text,text,uuid,text,text,text,text,text,text,text,text,text,text,text) OWNER TO tenant_provisioner;
REVOKE EXECUTE ON FUNCTION platform.provision_tenant(text,text,uuid,text,text,text,text,text,text,text,text,text,text,text) FROM PUBLIC;
