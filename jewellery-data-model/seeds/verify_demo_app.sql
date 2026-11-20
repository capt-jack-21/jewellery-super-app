-- seeds/verify_demo_app.sql — read-only: billing unlock per demo shop and partner visibility, via the API role app_rw
\pset footer off
\t on
SELECT format($f$SET ROLE app_rw; SET app.tenant_id = %L; SELECT %L AS shop, billing_unlocked, missing_steps FROM platform.v_billing_unlocked; RESET app.tenant_id; RESET ROLE;$f$, id, slug)
FROM platform.tenant WHERE slug LIKE 'demo-%' AND slug NOT LIKE 'demo-deleted-%' ORDER BY slug \gexec
SELECT format($f$SET ROLE app_rw; SET app.partner_id = %L;
  SELECT 'partner directory: ' || string_agg(display_name || ' [' || tenant_status || ']', ', ' ORDER BY display_name) FROM platform.v_partner_tenant_directory;
  SELECT 'partner sees customers: ' || (SELECT count(*) FROM masters.customer) || ', items: ' || (SELECT count(*) FROM masters.item)
      || ', rates: ' || (SELECT count(*) FROM rates.metal_rate);
  RESET app.partner_id; RESET ROLE;$f$, id) FROM platform.partner WHERE slug = 'demo-partner-kovai' \gexec
