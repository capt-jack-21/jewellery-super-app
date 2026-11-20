-- 000_bootstrap.sql  — run ONCE as a superuser. Everything after this runs as app_migrator.
-- Roles
--   app_migrator : owns all objects, runs migrations (NOT superuser, no BYPASSRLS)
--   app_rw       : the NestJS API login role (no BYPASSRLS, not owner, no DELETE/TRUNCATE on protected tables)
--   app_ro       : reporting / read replica role (SELECT on reports.* views only + masters)
--   app_worker   : pg-boss worker (reads/marks notifications.outbox)
--   app_admin    : platform admin console (P23): tenants/partners/billing/usage only, never shop data
--   <module>_writer : NOLOGIN module roles holding the write grants on a module's protected tables
--                     (only sales_writer can insert invoices, only inventory_writer can append to the
--                     stock ledger / change tag status). The app assumes them with SET LOCAL ROLE.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['app_migrator'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS CREATEROLE', r);
    END IF;
  END LOOP;
  FOREACH r IN ARRAY ARRAY['app_rw','app_ro','app_worker','app_admin'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS', r);
    END IF;
  END LOOP;
  FOREACH r IN ARRAY ARRAY['platform_writer','sales_writer','inventory_writer','notifications_writer',
                           'accounts_writer','purchases_writer','refinery_writer','orders_writer',
                           'platform_lookup','tenant_provisioner'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOBYPASSRLS', r);
    END IF;
    EXECUTE format('GRANT %I TO app_migrator WITH ADMIN OPTION', r);  -- so migrator can ALTER ... OWNER TO
  END LOOP;
END $$;

-- One schema per functional module
DO $$
DECLARE s text;
BEGIN
  FOREACH s IN ARRAY ARRAY['platform','billing','notifications','masters','rates','hr','accounts',
                           'inventory','approvals','sales','orders','purchases','refinery','reports','branding'] LOOP
    EXECUTE format('CREATE SCHEMA IF NOT EXISTS %I AUTHORIZATION app_migrator', s);
    EXECUTE format('REVOKE ALL ON SCHEMA %I FROM PUBLIC', s);
  END LOOP;
END $$;

-- (database-level CREATE granted by the provisioning script)
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- app_migrator may create objects owned by app_worker (the pgboss schema, 035_pgboss.sql)
GRANT app_worker TO app_migrator;

-- btree_gist (PostgreSQL contrib, ships with core packages; trusted): overlap-exclusion on effective-dated
-- tax rules. The ONLY extension used. gen_random_uuid()/sha256() are core built-ins (PG13+/PG11+); pgcrypto is NOT needed.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Module roles are NOLOGIN. The API (app_rw) is a member WITH INHERIT FALSE, so it has none of their
-- rights by default; the NestJS sales/inventory unit-of-work does `SET LOCAL ROLE sales_writer` /
-- `SET LOCAL ROLE inventory_writer` inside the request transaction (granted in 900_security.sql).
-- platform_writer owns the audit trigger function (needs CREATE on its schema).
GRANT USAGE, CREATE ON SCHEMA platform TO platform_writer, platform_lookup, tenant_provisioner;
GRANT USAGE ON SCHEMA billing TO platform_lookup;   -- partner tenant directory (025)
GRANT USAGE, CREATE ON SCHEMA notifications TO notifications_writer;   -- owns notifications.credit_note_alert()

-- ---------------------------------------------------------------------------
-- Schema-change guard: DDL / DROP in module schemas is allowed only for app_migrator (migrations).
-- Any other session user, including a superuser such as postgres, is blocked. app_worker (pg-boss) may do
-- DDL only inside schema pgboss (pg-boss creates/migrates its own tables at startup). Allowed migration DDL is
-- logged to public.schema_change_log.
-- (A superuser can still ALTER EVENT TRIGGER ... DISABLE: that is itself DDL outside the module schemas
-- and should be monitored at the OS / pgaudit level.)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.schema_change_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  session_user_name text NOT NULL, command_tag text NOT NULL,
  object_type text, schema_name text, object_identity text
);
REVOKE ALL ON public.schema_change_log FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.guard_ddl() RETURNS event_trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE obj record;
BEGIN
  FOR obj IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
    IF session_user = 'app_worker' AND coalesce(obj.schema_name, '') <> 'pgboss' AND coalesce(obj.schema_name, '') NOT LIKE 'pg\_temp%' THEN
      RAISE EXCEPTION 'schema change (%) on % by app_worker blocked: app_worker may only change schema pgboss',
        obj.command_tag, obj.object_identity;
    END IF;
    IF obj.schema_name IN ('platform','billing','notifications','masters','rates','hr','accounts','inventory',
                           'approvals','sales','orders','purchases','refinery','reports','branding') THEN
      IF session_user <> 'app_migrator' THEN
        RAISE EXCEPTION 'schema change (%) on % by % blocked: only app_migrator may change module schemas',
          obj.command_tag, obj.object_identity, session_user;
      END IF;
      INSERT INTO public.schema_change_log(session_user_name, command_tag, object_type, schema_name, object_identity)
      VALUES (session_user, obj.command_tag, obj.object_type, obj.schema_name, obj.object_identity);
    END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.guard_drop() RETURNS event_trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE obj record;
BEGIN
  FOR obj IN SELECT * FROM pg_event_trigger_dropped_objects() LOOP
    IF session_user = 'app_worker' AND coalesce(obj.schema_name, 'pgboss') NOT IN ('pgboss', 'pg_toast') AND obj.schema_name NOT LIKE 'pg\_temp%' THEN
      RAISE EXCEPTION 'DROP of % by app_worker blocked: app_worker may only change schema pgboss', obj.object_identity;
    END IF;
    IF obj.schema_name IN ('platform','billing','notifications','masters','rates','hr','accounts','inventory',
                           'approvals','sales','orders','purchases','refinery','reports','branding') THEN
      IF session_user <> 'app_migrator' THEN
        RAISE EXCEPTION 'DROP of % by % blocked: only app_migrator may change module schemas', obj.object_identity, session_user;
      END IF;
      INSERT INTO public.schema_change_log(session_user_name, command_tag, object_type, schema_name, object_identity)
      VALUES (session_user, 'DROP', obj.object_type, obj.schema_name, obj.object_identity);
    END IF;
  END LOOP;
END $$;

DROP EVENT TRIGGER IF EXISTS guard_ddl;
CREATE EVENT TRIGGER guard_ddl ON ddl_command_end EXECUTE FUNCTION public.guard_ddl();
DROP EVENT TRIGGER IF EXISTS guard_drop;
CREATE EVENT TRIGGER guard_drop ON sql_drop EXECUTE FUNCTION public.guard_drop();
