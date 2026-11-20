-- 975_platform_referenced_object_keys.sql — for the object-storage cleanup job (app_worker): given candidate object keys,
-- return the ones still referenced by platform.file.object_key, platform.import_job.file_key or .error_report_key,
-- across all tenants. Only keys from the input come back (no tenant ids, no other keys). Capped at 1000 keys per call.
-- Owner pattern = resolve_tenant / provision_tenant: a dedicated NOLOGIN, NOSUPERUSER, NOBYPASSRLS role with column-level
-- SELECT on exactly the three key columns plus a SELECT policy for that role (FORCE RLS stays on for everyone else).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'object_key_lookup') THEN
    -- PG16+: CREATEROLE gives the creator ADMIN on the new role; 'set' also lets it ALTER ... OWNER TO the role
    PERFORM set_config('createrole_self_grant', 'set', true);
    CREATE ROLE object_key_lookup NOLOGIN NOSUPERUSER NOBYPASSRLS;   -- roles are cluster-wide: guard for re-created DBs
  END IF;
  IF NOT pg_has_role(current_user, 'object_key_lookup', 'SET') THEN
    GRANT object_key_lookup TO app_migrator WITH SET TRUE, INHERIT FALSE;
  END IF;
END $$;
GRANT USAGE, CREATE ON SCHEMA platform TO object_key_lookup;   -- CREATE: needed to own a function here (same as platform_lookup in 000)

GRANT SELECT (object_key) ON platform.file TO object_key_lookup;
GRANT SELECT (file_key, error_report_key) ON platform.import_job TO object_key_lookup;
CREATE POLICY object_key_lookup_read ON platform.file       FOR SELECT TO object_key_lookup USING (true);
CREATE POLICY object_key_lookup_read ON platform.import_job FOR SELECT TO object_key_lookup USING (true);

CREATE FUNCTION platform.referenced_object_keys(p_keys text[])
RETURNS SETOF text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF coalesce(cardinality(p_keys), 0) > 1000 THEN   -- cardinality = total elements (also for multi-dim arrays)
    RAISE EXCEPTION 'referenced_object_keys: at most 1000 keys per call (got %)', cardinality(p_keys)
      USING ERRCODE = '22023';                      -- invalid_parameter_value
  END IF;
  RETURN QUERY
    SELECT DISTINCT k.key
    FROM pg_catalog.unnest(p_keys) AS k(key)        -- NULL / empty array -> no rows
    WHERE k.key IS NOT NULL
      AND (EXISTS (SELECT 1 FROM platform.file f WHERE f.object_key OPERATOR(pg_catalog.=) k.key)
        OR EXISTS (SELECT 1 FROM platform.import_job j WHERE j.file_key OPERATOR(pg_catalog.=) k.key)
        OR EXISTS (SELECT 1 FROM platform.import_job j WHERE j.error_report_key OPERATOR(pg_catalog.=) k.key));
END $$;
-- ACL first, while app_migrator still owns it (it only has SET, not INHERIT, on object_key_lookup, so after the owner
-- change it could no longer revoke/grant); the ACL moves with the ownership change.
REVOKE ALL ON FUNCTION platform.referenced_object_keys(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.referenced_object_keys(text[]) TO app_worker;
ALTER FUNCTION platform.referenced_object_keys(text[]) OWNER TO object_key_lookup;
