-- 920_platform_functions_v15.sql — resolve_partner; provision_tenant gains p_deployment_mode and writes its own
-- 'tenant.provisioned' audit event (app_admin never needs audit_append). Grants in 960.

-- pre-login partner lookup (partner portal hostname / slug -> partner); no PII
CREATE FUNCTION platform.resolve_partner(p_slug text)
RETURNS TABLE (partner_id uuid, status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT p.id, p.status FROM platform.partner p WHERE p.slug = lower(p_slug)
$$;
ALTER FUNCTION platform.resolve_partner(text) OWNER TO platform_lookup;
REVOKE EXECUTE ON FUNCTION platform.resolve_partner(text) FROM PUBLIC;

-- the 14-argument version (applied in 025) is replaced by the 15-argument one
DROP FUNCTION platform.provision_tenant(text,text,uuid,text,text,text,text,text,text,text,text,text,text,text);

-- Creates tenant (with deployment_mode shared/dedicated/onprem), company, first branch, the four preset roles, the owner
-- user, and the 10 onboarding rows. Owned by tenant_provisioner, which has INSERT on exactly these tables.
CREATE FUNCTION platform.provision_tenant(
  p_slug text, p_display_name text, p_partner_id uuid,
  p_legal_name text, p_gstin text, p_pan text, p_state_code text,
  p_branch_code text, p_branch_name text,
  p_owner_name text, p_owner_phone text, p_owner_username text, p_owner_password_hash text,
  p_language text DEFAULT 'en', p_deployment_mode text DEFAULT 'shared')
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_tenant uuid := platform.uuid_v7(); v_company uuid := platform.uuid_v7(); v_branch uuid := platform.uuid_v7();
        v_owner uuid := platform.uuid_v7(); v_prev text := current_setting('app.tenant_id', true);
        v_prev_user text := current_setting('app.user_id', true);
BEGIN
  INSERT INTO platform.tenant(id, partner_id, slug, display_name, status, default_language, deployment_mode)
  VALUES (v_tenant, p_partner_id, lower(p_slug), p_display_name, 'trial', p_language, p_deployment_mode);  -- CHECK on tenant
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
  -- semantic audit event (row-level events for branch/app_user/role/user_role come from their zz_audit triggers);
  -- written here so callers (app_admin) never need audit_append themselves
  PERFORM platform.audit_append(v_tenant, 'tenant.provisioned', 'platform.tenant', v_tenant, NULL,
          jsonb_build_object('slug', lower(p_slug), 'partner_id', p_partner_id, 'deployment_mode', p_deployment_mode,
                             'company_id', v_company, 'branch_id', v_branch, 'owner_user_id', v_owner,
                             'by', coalesce(nullif(current_setting('app.admin_id', true), ''), session_user::text)));
  PERFORM set_config('app.tenant_id', coalesce(v_prev, ''), true);
  PERFORM set_config('app.user_id', coalesce(v_prev_user, ''), true);
  RETURN v_tenant;
END $$;
ALTER FUNCTION platform.provision_tenant(text,text,uuid,text,text,text,text,text,text,text,text,text,text,text,text) OWNER TO tenant_provisioner;
REVOKE EXECUTE ON FUNCTION platform.provision_tenant(text,text,uuid,text,text,text,text,text,text,text,text,text,text,text,text) FROM PUBLIC;
