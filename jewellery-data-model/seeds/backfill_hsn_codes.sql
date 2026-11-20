-- seeds/backfill_hsn_codes.sql — copy platform.hsn_code_default (983) into masters.hsn_code for EXISTING tenants.
-- New tenants get the codes from provision_tenant; this is only for tenants provisioned before 983.
-- Data only, idempotent (ON CONFLICT DO NOTHING on hsn_code_uq), one transaction, aborts on an unknown slug.
-- Runs with app_rw privileges (the dev_seed login): forced RLS means one tenant at a time via set_config, and tenants
-- cannot be listed, so pass slugs explicitly (from the admin console tenant list):
--   psql -X -q -v ON_ERROR_STOP=1 -v slugs=demo-cbe-sri-valli,demo-chn-kanchi-thangam -f seeds/backfill_hsn_codes.sql
-- NOT run on dev by the data-model work; whoever applies 983 on dev runs it afterwards (needs 980 + 983 applied).
\set ON_ERROR_STOP 1
SELECT set_config('backfill.slugs', :'slugs', false) \g /dev/null
BEGIN;
DO $$
DECLARE s text; t uuid; n int;
BEGIN
  PERFORM set_config('app.partner_id', '', true);
  FOREACH s IN ARRAY string_to_array(current_setting('backfill.slugs'), ',') LOOP
    s := lower(btrim(s));
    CONTINUE WHEN s = '';
    SELECT r.tenant_id INTO t FROM platform.resolve_tenant(s) r;
    IF t IS NULL THEN RAISE EXCEPTION 'unknown tenant slug %', s; END IF;
    PERFORM set_config('app.tenant_id', t::text, true);
    INSERT INTO masters.hsn_code(tenant_id, code_type, code, description, uqc)
    SELECT t, d.code_type, d.code, d.description, d.uqc FROM platform.hsn_code_default d ORDER BY d.sort_order
    ON CONFLICT (tenant_id, code_type, code) DO NOTHING;
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE NOTICE 'hsn backfill %: % inserted', s, n;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
COMMIT;
