-- 971_provision_tenant_bill_prefix.sql — provision_tenant gains a trailing p_bill_series_prefix text DEFAULT NULL
-- so a custom first-branch bill series prefix is set atomically. NULL/blank -> upper(p_branch_code) (old behaviour).
-- The value is upper-cased, then validated against the branch CHECK rule. The 15-arg version is dropped (a 16-arg
-- function with a default next to it would make 13–15-arg calls ambiguous); existing positional calls keep working.
-- Owner, SECURITY DEFINER, search_path, PUBLIC revoke and the app_admin grant are kept; audit event now has the prefix.

DROP FUNCTION platform.provision_tenant(text,text,uuid,text,text,text,text,text,text,text,text,text,text,text,text);

CREATE FUNCTION platform.provision_tenant(
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
ALTER FUNCTION platform.provision_tenant(text,text,uuid,text,text,text,text,text,text,text,text,text,text,text,text,text) OWNER TO tenant_provisioner;
REVOKE EXECUTE ON FUNCTION platform.provision_tenant(text,text,uuid,text,text,text,text,text,text,text,text,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.provision_tenant(text,text,uuid,text,text,text,text,text,text,text,text,text,text,text,text,text) TO app_admin;
