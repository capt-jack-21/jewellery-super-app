-- seeds/dev_demo_cleanup.sql — removes ONLY the demo data created by dev_demo_5_shops.sql. Data only, no DDL. Re-runnable.
-- Scope: tenants with slug LIKE 'demo-%' and partners with slug LIKE 'demo-%'. Never touches platform_admin
-- or any non-demo tenant/partner. Run as app_migrator:  psql -v ON_ERROR_STOP=1 -f seeds/dev_demo_cleanup.sql
--
-- Limits imposed by the immutability rules (by design, NOT bypassed):
--  * platform.audit_event is append-only (forbid trigger on UPDATE/DELETE/TRUNCATE): the demo tenants' audit rows stay,
--    and deleting audited rows (users, roles, branches, rates, ...) appends their DELETE events.
--  * platform.tenant has no DELETE policy for app_migrator (only admin_all TO app_admin). When the tenant row cannot be
--    deleted it is TOMBSTONED: slug -> 'demo-deleted-<id8>', status 'suspended', partner_id NULL, and its
--    audit_chain_head is kept (so the hash chain never restarts over the retained audit rows). All other rows go.
--    Run by a role that may delete tenants, the tenant row and chain head are deleted as well (audit rows remain).
\set ON_ERROR_STOP 1
BEGIN;
DO $clean$
DECLARE
  t record; tbl record; n bigint; left_rows bigint; pass int; progressed boolean; deleted bigint;
  skip constant text[] := ARRAY['platform.tenant','platform.audit_event','platform.audit_chain_head'];
BEGIN
  IF current_setting('app.partner_id', true) IS DISTINCT FROM NULL AND current_setting('app.partner_id', true) <> '' THEN
    RAISE EXCEPTION 'unset app.partner_id first';
  END IF;
  FOR t IN SELECT id, slug FROM platform.tenant WHERE slug LIKE 'demo-%' ORDER BY slug LOOP
    PERFORM set_config('app.tenant_id', t.id::text, true);
    -- delete every tenant-owned row (any table with a tenant_id column), multi-pass until FK order is satisfied
    FOR pass IN 1..15 LOOP
      progressed := false; left_rows := 0;
      FOR tbl IN SELECT format('%I.%I', c.table_schema, c.table_name) AS fq
                 FROM information_schema.columns c JOIN information_schema.tables it
                   ON it.table_schema = c.table_schema AND it.table_name = c.table_name AND it.table_type = 'BASE TABLE'
                 WHERE c.column_name = 'tenant_id' AND c.table_schema NOT IN ('pg_catalog','information_schema','migrator')
                   AND format('%I.%I', c.table_schema, c.table_name) <> ALL (skip)
                 ORDER BY 1 LOOP
        EXECUTE format('SELECT count(*) FROM %s WHERE tenant_id = $1', tbl.fq) INTO n USING t.id;
        CONTINUE WHEN n = 0;
        BEGIN
          EXECUTE format('DELETE FROM %s WHERE tenant_id = $1', tbl.fq) USING t.id;
          GET DIAGNOSTICS deleted = ROW_COUNT;
          IF deleted > 0 THEN progressed := true; END IF;
          IF deleted < n THEN left_rows := left_rows + (n - deleted); END IF;
        EXCEPTION WHEN foreign_key_violation THEN
          left_rows := left_rows + n;
        END;
      END LOOP;
      EXIT WHEN left_rows = 0;
      IF NOT progressed THEN RAISE EXCEPTION 'demo cleanup stuck for % (% rows left; RLS or FK)', t.slug, left_rows; END IF;
    END LOOP;
    -- tenant row: delete if this role may, else tombstone
    BEGIN
      DELETE FROM platform.audit_chain_head WHERE tenant_id = t.id;
      DELETE FROM platform.tenant WHERE id = t.id;
      GET DIAGNOSTICS deleted = ROW_COUNT;
      IF deleted = 0 THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'no tenant delete'; END IF;
      RAISE NOTICE 'demo tenant % deleted', t.slug;
    EXCEPTION WHEN raise_exception OR insufficient_privilege THEN
      IF t.slug NOT LIKE 'demo-deleted-%' THEN
        UPDATE platform.tenant SET slug = 'demo-deleted-' || left(replace(id::text,'-',''), 12),
               status = 'suspended', suspended_at = coalesce(suspended_at, now()), suspend_reason = 'demo cleanup',
               partner_id = NULL
         WHERE id = t.id;
        GET DIAGNOSTICS deleted = ROW_COUNT;
        IF deleted = 0 THEN RAISE EXCEPTION 'cannot tombstone %', t.slug; END IF;
      END IF;
      RAISE NOTICE 'demo tenant % emptied and tombstoned (tenant DELETE not permitted for %)', t.slug, current_user;
    END;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);

  -- demo partners: their logins/sessions/branding, then the partner (tenants were unlinked above)
  FOR t IN SELECT id, slug FROM platform.partner WHERE slug LIKE 'demo-%' LOOP
    PERFORM set_config('app.partner_id', t.id::text, true);   -- partner_isolation on partner_user/session, branding
    FOR tbl IN SELECT format('%I.%I', c.table_schema, c.table_name) AS fq
               FROM information_schema.columns c JOIN information_schema.tables it
                 ON it.table_schema = c.table_schema AND it.table_name = c.table_name AND it.table_type = 'BASE TABLE'
               WHERE c.column_name = 'partner_id' AND c.table_schema NOT IN ('pg_catalog','information_schema')
                 AND format('%I.%I', c.table_schema, c.table_name) NOT IN ('platform.tenant','platform.partner_user')
    LOOP
      EXECUTE format('DELETE FROM %s WHERE partner_id = $1', tbl.fq) USING t.id;
    END LOOP;
    DELETE FROM platform.partner_user WHERE partner_id = t.id;
    PERFORM set_config('app.partner_id', '', true);
    DELETE FROM platform.partner WHERE id = t.id;
    GET DIAGNOSTICS deleted = ROW_COUNT;
    IF deleted = 0 THEN RAISE EXCEPTION 'demo partner % not deleted (RLS)', t.slug; END IF;
    RAISE NOTICE 'demo partner % deleted', t.slug;
  END LOOP;
END $clean$;
COMMIT;
