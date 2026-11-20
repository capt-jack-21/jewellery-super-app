-- seeds/verify_demo.sql — read-only checks of the demo seed (run as the DB superuser/owner on TEST; prints no secrets)
\pset footer off
SELECT t.slug, t.status, p.slug AS partner, (SELECT count(*) FROM platform.branch b WHERE b.tenant_id=t.id) AS branches,
       (SELECT string_agg(u.username, ',' ORDER BY u.username) FROM platform.app_user u WHERE u.tenant_id=t.id) AS users
FROM platform.tenant t LEFT JOIN platform.partner p ON p.id=t.partner_id WHERE t.slug LIKE 'demo-%' ORDER BY 1;
SELECT r.tbl, r.rows FROM (
  SELECT format('%I.%I',c.table_schema,c.table_name) tbl,
         (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) n FROM %I.%I x WHERE tenant_id IN (SELECT id FROM platform.tenant WHERE slug LIKE ''demo-%%'')',c.table_schema,c.table_name),false,true,'')))[1]::text::int rows
  FROM information_schema.columns c JOIN information_schema.tables it USING (table_schema,table_name)
  WHERE c.column_name='tenant_id' AND it.table_type='BASE TABLE' AND c.table_schema NOT IN ('pg_catalog','information_schema','migrator')) r
WHERE r.rows > 0 ORDER BY 1;
SELECT 'platform.tenant (demo)' tbl, count(*) FROM platform.tenant WHERE slug LIKE 'demo-%'
UNION ALL SELECT 'platform.partner (demo)', count(*) FROM platform.partner WHERE slug LIKE 'demo-%'
UNION ALL SELECT 'platform.partner_user (demo)', count(*) FROM platform.partner_user pu JOIN platform.partner p ON p.id=pu.partner_id WHERE p.slug LIKE 'demo-%'
UNION ALL SELECT 'platform.platform_admin (all)', count(*) FROM platform.platform_admin;
