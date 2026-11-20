-- seeds/demo_todays_rates.sql — today's (IST) SHOP-WIDE sale + old_metal rates for every active metal/purity of the
-- demo shops, so rates.v_todays_rate_status / platform.v_billing_unlocked show them as set. Data only, idempotent:
-- a (purity, kind) that already has a shop-wide rate dated today is skipped (WHERE NOT EXISTS), so re-running and
-- real rates entered by a user are never overwritten. source = 'demo_seed'. One transaction; aborts on an unknown slug.
-- Runs with app_rw privileges (dev_seed login): one tenant at a time via set_config, tenants resolved by slug.
--   psql -X -q -v ON_ERROR_STOP=1 -f seeds/demo_todays_rates.sql                       # the 5 demo shops
--   psql -X -q -v ON_ERROR_STOP=1 -v slugs=demo-cbe-sri-valli -f seeds/demo_todays_rates.sql
-- Values (INR per gram, pure basis x fineness/1000): GOLD 7,850, SILVER 98, PLATINUM 3,150; old_metal = 97% of sale.
-- Metals with other codes are skipped (NOTICE). Needs 985 only for the views, not for the inserts. NOT run on dev here.
\set ON_ERROR_STOP 1
\if :{?slugs}
\else
\set slugs 'demo-cbe-sri-valli,demo-chn-kanchi-thangam,demo-mdu-meenakshi-gold,demo-tpr-kongu-jewel,demo-slm-shevaroy'
\endif
SELECT set_config('seed.slugs', :'slugs', false) \g /dev/null
BEGIN;
DO $$
DECLARE s text; t uuid; n int; today date := (now() AT TIME ZONE 'Asia/Kolkata')::date; skipped text;
BEGIN
  PERFORM set_config('app.partner_id', '', true);
  FOREACH s IN ARRAY string_to_array(current_setting('seed.slugs'), ',') LOOP
    s := lower(btrim(s));
    CONTINUE WHEN s = '';
    SELECT r.tenant_id INTO t FROM platform.resolve_tenant(s) r;
    IF t IS NULL THEN RAISE EXCEPTION 'unknown tenant slug %', s; END IF;
    PERFORM set_config('app.tenant_id', t::text, true);
    INSERT INTO rates.metal_rate(tenant_id, purity_id, kind, rate_date, rate_per_g, source)
    SELECT t, p.id, k.kind, today,
           round(b.base * p.fineness / 1000 * CASE k.kind WHEN 'sale' THEN 1 ELSE 0.97 END, 2), 'demo_seed'
    FROM masters.purity p
    JOIN masters.metal m ON m.tenant_id = p.tenant_id AND m.id = p.metal_id AND m.is_active
    JOIN (VALUES ('GOLD', 7850::numeric), ('SILVER', 98), ('PLATINUM', 3150)) b(code, base) ON b.code = upper(m.code)
    CROSS JOIN (VALUES ('sale'), ('old_metal')) k(kind)
    WHERE p.tenant_id = t AND p.is_active
      AND NOT EXISTS (SELECT 1 FROM rates.metal_rate r WHERE r.tenant_id = t AND r.purity_id = p.id AND r.kind = k.kind
                        AND r.rate_date = today AND r.branch_id IS NULL)
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS n = ROW_COUNT;
    SELECT string_agg(code, ',') INTO skipped FROM masters.metal
     WHERE tenant_id = t AND is_active AND upper(code) NOT IN ('GOLD','SILVER','PLATINUM');
    RAISE NOTICE 'demo rates %: % inserted%', s, n, coalesce(' (no demo price for ' || skipped || ')', '');
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
COMMIT;
