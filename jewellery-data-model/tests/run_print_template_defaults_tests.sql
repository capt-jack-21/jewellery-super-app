-- 998 platform defaults, test superuser connection on VPS TEST DB only. All fixtures and reruns roll back.
-- -v upgrade_997=1 probes 997 with data -> 998; 0 tests head. migration_sql is the actual 998 file supplied by run_all.sh.
\set ON_ERROR_STOP 1
\pset tuples_only on
\pset footer off
CREATE FUNCTION pg_temp.tpl998_check(ok boolean,label text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN IF ok THEN RETURN 'PASS  '||label; END IF; RAISE EXCEPTION 'FAIL  %',label; END $$;
CREATE FUNCTION pg_temp.tpl998_error(stmt text,label text,pattern text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
 BEGIN EXECUTE stmt;
 EXCEPTION WHEN others THEN
   IF SQLERRM LIKE pattern THEN RETURN 'PASS  '||label||' -> '||SQLERRM; END IF;
   RAISE EXCEPTION 'FAIL  % wrong error: %',label,SQLERRM;
 END;
 RAISE EXCEPTION 'FAIL  % unexpectedly succeeded',label;
END $$;
BEGIN;
CREATE TEMP TABLE tpl998_expected(id uuid,doc_type text,body_key text) ON COMMIT DROP;
INSERT INTO tpl998_expected VALUES
 ('01a1c455-29fa-769b-84f9-377a9bcdab46','invoice','tpl/platform/invoice.hbs'),
 ('01a1c455-29fa-7963-88e9-d3cf6e2a8240','estimate','tpl/platform/estimate.hbs'),
 ('01a1c455-29fa-7856-b4ed-a3710fd91ec1','credit_note','tpl/platform/credit_note.hbs'),
 ('01a1c455-29fa-7811-b4b1-95efbd5b9ea5','receipt','tpl/platform/receipt.hbs');
CREATE TEMP TABLE tpl998_old_rows ON COMMIT DROP AS SELECT id,to_jsonb(t) AS data FROM branding.print_template t WHERE scope<>'platform';
SELECT count(*) AS audit_before FROM platform.audit_event \gset
\if :upgrade_997
SELECT pg_temp.tpl998_check(NOT EXISTS(SELECT 1 FROM branding.print_template WHERE scope='platform')
 AND EXISTS(SELECT 1 FROM tpl998_old_rows), 'TU0 997 baseline has tenant template data but no platform defaults');
SET LOCAL SESSION AUTHORIZATION app_migrator;
\ir ../migrations/998_print_template_platform_defaults.sql
RESET SESSION AUTHORIZATION;
SELECT pg_temp.tpl998_check(NOT EXISTS(SELECT 1 FROM tpl998_old_rows o LEFT JOIN branding.print_template t USING(id) WHERE to_jsonb(t) IS DISTINCT FROM o.data)
 AND (SELECT count(*) FROM platform.audit_event)=:audit_before,
 'TU1 997 -> 998 preserves all existing tenant/partner templates; platform rows correctly create no tenant audit-chain entries');
\endif
SELECT pg_temp.tpl998_check((SELECT count(*)=4 AND bool_and(t.scope='platform' AND t.partner_id IS NULL AND t.tenant_id IS NULL AND t.version=1
 AND t.paper='A4' AND t.print_language='en' AND t.numeral_system='latin' AND t.engine='handlebars' AND t.body_key=e.body_key AND t.doc_type=e.doc_type AND t.is_active
 AND t.row_version=1 AND substring(t.id::text,15,1)='7' AND substring(t.id::text,20,1) IN ('8','9','a','b'))
 FROM tpl998_expected e JOIN branding.print_template t USING(id)),
 'TD1 all four fixed UUIDv7 defaults have exact scope/type/version/body/paper/language/numerals/engine/active values');
CREATE TEMP TABLE tpl998_before ON COMMIT DROP AS SELECT id,to_jsonb(t) AS data FROM branding.print_template t WHERE id IN (SELECT id FROM tpl998_expected);
SET LOCAL SESSION AUTHORIZATION app_migrator;
\ir ../migrations/998_print_template_platform_defaults.sql
RESET SESSION AUTHORIZATION;
SELECT pg_temp.tpl998_check(NOT EXISTS(SELECT 1 FROM tpl998_before b LEFT JOIN branding.print_template t USING(id) WHERE to_jsonb(t) IS DISTINCT FROM b.data)
 AND (SELECT count(*) FROM branding.print_template WHERE scope='platform' AND doc_type IN ('invoice','estimate','credit_note','receipt'))=4
 AND (SELECT count(*) FROM platform.audit_event)=:audit_before,
 'TD2 rerunning actual 998 is a no-op (rows, created_at, row_version, config and tenant audit unchanged)');
-- Collision cases run the actual migration text through an exception catcher, not a copied implementation.
SAVEPOINT conflicting_version;
SET LOCAL SESSION AUTHORIZATION app_migrator;
-- At head, committed prints pin the platform invoice and 999's RESTRICT FK forbids deleting it; this collision case
-- models the pre-999 catalogue, so drop that FK inside the savepoint only (rolled back below).
ALTER TABLE sales.document_print DROP CONSTRAINT IF EXISTS document_print_template_fk;
DELETE FROM branding.print_template WHERE id='01a1c455-29fa-769b-84f9-377a9bcdab46';
INSERT INTO branding.print_template(id,scope,doc_type,version,body_key,is_active)
VALUES('00000000-0000-4000-8000-000000009981','platform','invoice',1,'tpl/existing/platform-invoice.hbs',true);
SELECT pg_temp.tpl998_error(:'migration_sql','TD3 different platform v1 ID fails loudly via version_uq guard, never silently replaced','998: conflicting platform invoice v1 id%');
SELECT pg_temp.tpl998_check(EXISTS(SELECT 1 FROM branding.print_template WHERE id='00000000-0000-4000-8000-000000009981' AND body_key='tpl/existing/platform-invoice.hbs')
 AND NOT EXISTS(SELECT 1 FROM branding.print_template WHERE id='01a1c455-29fa-769b-84f9-377a9bcdab46'), 'TD4 conflicting existing row left intact on failure');
ROLLBACK TO SAVEPOINT conflicting_version;
SAVEPOINT conflicting_values;
SET LOCAL SESSION AUTHORIZATION app_migrator;
UPDATE branding.print_template SET paper='A5' WHERE id='01a1c455-29fa-769b-84f9-377a9bcdab46';
SELECT pg_temp.tpl998_error(:'migration_sql','TD5 published ID with different values fails loudly (no overwrite)','998: published template id%has different values%');
ROLLBACK TO SAVEPOINT conflicting_values;
SAVEPOINT conflicting_active;
SET LOCAL SESSION AUTHORIZATION app_migrator;
-- At head, committed prints pin the platform invoice and 999's RESTRICT FK forbids deleting it; this collision case
-- models the pre-999 catalogue, so drop that FK inside the savepoint only (rolled back below).
ALTER TABLE sales.document_print DROP CONSTRAINT IF EXISTS document_print_template_fk;
DELETE FROM branding.print_template WHERE id='01a1c455-29fa-769b-84f9-377a9bcdab46';
INSERT INTO branding.print_template(scope,doc_type,version,body_key,is_active) VALUES('platform','invoice',2,'tpl/existing/platform-invoice-v2.hbs',true);
SELECT pg_temp.tpl998_error(:'migration_sql','TD6 another active platform version fails loudly (no auto-deactivation)','998: another platform invoice version is active%');
ROLLBACK TO SAVEPOINT conflicting_active;
-- Model a genuinely fresh direct shop and the five demo shops' seeded partner/default-language layout. No per-shop template row.
RESET SESSION AUTHORIZATION;
INSERT INTO platform.partner(id,slug,legal_name) VALUES('00000000-0000-4000-8000-000000009980','template-partner-998','Template test partner');
CREATE TEMP TABLE tpl998_shops(id uuid,slug text,partner_id uuid) ON COMMIT DROP;
INSERT INTO tpl998_shops VALUES
 ('00000000-0000-4000-8000-000000009990','template-fresh-998',NULL),
 ('00000000-0000-4000-8000-000000009991','demo-cbe-sri-valli','00000000-0000-4000-8000-000000009980'),
 ('00000000-0000-4000-8000-000000009992','demo-chn-kanchi-thangam',NULL),
 ('00000000-0000-4000-8000-000000009993','demo-mdu-meenakshi-gold',NULL),
 ('00000000-0000-4000-8000-000000009994','demo-tpr-kongu-jewel','00000000-0000-4000-8000-000000009980'),
 ('00000000-0000-4000-8000-000000009995','demo-slm-shevaroy',NULL);
INSERT INTO platform.tenant(id,slug,display_name,partner_id) SELECT id,slug,'Template test '||slug,partner_id FROM tpl998_shops;
GRANT SELECT ON tpl998_shops,tpl998_expected TO app_rw;
SET LOCAL ROLE app_rw;
DO $$
DECLARE shop record; expected record; picked uuid; n int;
BEGIN
 PERFORM set_config('app.partner_id','',true);
 FOR shop IN SELECT * FROM tpl998_shops ORDER BY slug LOOP
   PERFORM set_config('app.tenant_id',shop.id::text,true);
   FOR expected IN SELECT * FROM tpl998_expected LOOP
     -- Exactly the current Sales printDefaults selection (settings.ts), under app_rw / forced RLS.
     SELECT id INTO picked FROM branding.print_template WHERE doc_type=expected.doc_type AND is_active
       ORDER BY (scope='tenant') DESC,version DESC LIMIT 1;
     IF picked IS DISTINCT FROM expected.id THEN RAISE EXCEPTION 'FAIL TD7 % lookup for % got %, expected %',shop.slug,expected.doc_type,picked,expected.id; END IF;
   END LOOP;
   SELECT count(*) INTO n FROM branding.print_template WHERE scope='tenant';
   IF n<>0 THEN RAISE EXCEPTION 'FAIL TD7 fixture has per-shop template rows'; END IF;
   RAISE NOTICE 'PASS  TD7 % resolves all 4 platform IDs through current Sales lookup, no per-shop template/activation',shop.slug;
 END LOOP;
END $$;
SELECT set_config('app.tenant_id','00000000-0000-4000-8000-000000009990',true) \g /dev/null
SELECT pg_temp.tpl998_check((SELECT count(*)=4 FROM branding.print_template WHERE id IN (SELECT id FROM tpl998_expected))
 AND (SELECT count(*)=0 FROM branding.print_template WHERE tenant_id=platform.current_tenant()),
 'TD8 platform rows RLS-visible, but tenant-only template-list API query omits them (app follow-up, not an activation requirement)');
RESET ROLE;
SELECT pg_temp.tpl998_check((SELECT attnotnull=NOT :upgrade_997::boolean FROM pg_attribute WHERE attrelid='sales.document_print'::regclass AND attname='template_id'),
 'TD9 document_print.template_id nullability matches staged/head state');
SELECT pg_temp.tpl998_check((SELECT attnotnull=NOT :upgrade_997::boolean FROM pg_attribute WHERE attrelid='sales.document_print'::regclass AND attname='template_version'),
 'TD10 document_print.template_version nullability matches staged/head state');
ROLLBACK;
SELECT pg_temp.tpl998_check(NOT EXISTS(SELECT 1 FROM platform.tenant WHERE slug='template-fresh-998'), 'TD11 lookup/collision fixtures fully rolled back');
