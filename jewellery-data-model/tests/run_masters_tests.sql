-- 976–981 masters scope (frozen 2026-10-28). Run as app_rw after run_tests.sql (seed + earlier tests already ran).
\set ON_ERROR_STOP 1
\pset footer off
\pset tuples_only on
CREATE FUNCTION pg_temp.expect_error(p_sql text, p_label text, p_like text DEFAULT '%') RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  BEGIN EXECUTE p_sql;
  EXCEPTION WHEN others THEN
    IF SQLERRM LIKE p_like THEN RETURN 'PASS  ' || p_label || '  -> ' || SQLERRM; END IF;
    RAISE EXCEPTION 'FAIL  % wrong error: %', p_label, SQLERRM;
  END;
  RAISE EXCEPTION 'FAIL  % : statement unexpectedly succeeded', p_label;
END $$;
CREATE FUNCTION pg_temp.check(ok boolean, p_label text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN IF ok THEN RETURN 'PASS  ' || p_label; END IF; RAISE EXCEPTION 'FAIL  %', p_label; END $$;
-- columns as name:format_type[:NN], in ordinal order; p_only limits to the listed columns (altered tables)
CREATE FUNCTION pg_temp.cols(p_tbl regclass, p_only text[] DEFAULT NULL) RETURNS text LANGUAGE sql AS $$
  SELECT string_agg(attname || ':' || format_type(atttypid, atttypmod) || CASE WHEN attnotnull THEN ':NN' ELSE '' END, ',' ORDER BY attnum)
  FROM pg_attribute WHERE attrelid = p_tbl AND attnum > 0 AND NOT attisdropped AND (p_only IS NULL OR attname = ANY (p_only)) $$;
-- every non-owner grant on the table and its columns, sorted
CREATE FUNCTION pg_temp.acl(p_tbl regclass) RETURNS text LANGUAGE sql AS $$
  SELECT string_agg(x, ',' ORDER BY x) FROM (
    SELECT coalesce(g.rolname, 'PUBLIC') || ':' || a.privilege_type AS x
    FROM pg_class c, aclexplode(c.relacl) a LEFT JOIN pg_roles g ON g.oid = a.grantee
    WHERE c.oid = p_tbl AND a.grantee <> c.relowner
    UNION ALL
    SELECT coalesce(g.rolname, 'PUBLIC') || ':' || a.privilege_type || '(' || att.attname || ')'
    FROM pg_attribute att, aclexplode(att.attacl) a LEFT JOIN pg_roles g ON g.oid = a.grantee
    WHERE att.attrelid = p_tbl AND att.attacl IS NOT NULL) t $$;
CREATE FUNCTION pg_temp.std_acl(p_ro boolean DEFAULT true, p_writers boolean DEFAULT true) RETURNS text LANGUAGE sql AS $$
  SELECT string_agg(x, ',' ORDER BY x) FROM unnest(
    ARRAY['app_rw:SELECT','app_rw:INSERT','app_rw:UPDATE','app_rw:DELETE']
    || CASE WHEN p_ro THEN ARRAY['app_ro:SELECT'] ELSE '{}' END
    || CASE WHEN p_writers THEN ARRAY['sales_writer:SELECT','inventory_writer:SELECT','orders_writer:SELECT','purchases_writer:SELECT','refinery_writer:SELECT'] ELSE '{}' END) x $$;
-- RLS, triggers, row lifecycle: insert (t1) -> update bumps version -> audit row -> t2 isolation -> partner block
CREATE FUNCTION pg_temp.lifecycle(p_code text, p_tbl regclass, p_insert text, p_update text, p_audited boolean,
                                  p_policies text DEFAULT 'no_partner_access,tenant_isolation') RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_id uuid; v int; n bigint; t1 constant text := '00000000-0000-0000-0000-000000000001';
BEGIN
  IF NOT (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = p_tbl)
     OR (SELECT string_agg(polname, ',' ORDER BY polname) FROM pg_policy WHERE polrelid = p_tbl) IS DISTINCT FROM p_policies THEN
    RAISE EXCEPTION 'FAIL  % % RLS/policies: %', p_code, p_tbl, (SELECT string_agg(polname, ',' ORDER BY polname) FROM pg_policy WHERE polrelid = p_tbl);
  END IF;
  RAISE NOTICE 'PASS  %a % RLS enabled+forced, policies %', p_code, p_tbl, p_policies;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = p_tbl AND tgname = 'aa_version' AND tgfoid = 'platform.bump_version'::regproc)
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = p_tbl AND tgname = 'zz_audit') <> p_audited THEN
    RAISE EXCEPTION 'FAIL  % % triggers (aa_version, zz_audit=%)', p_code, p_tbl, p_audited;
  END IF;
  RAISE NOTICE 'PASS  %b % aa_version trigger; zz_audit %', p_code, p_tbl, CASE WHEN p_audited THEN 'present' ELSE 'absent (by design)' END;
  EXECUTE p_insert || ' RETURNING ' || CASE WHEN p_tbl = 'masters.kyc_document_secret'::regclass THEN 'kyc_document_id' ELSE 'id' END INTO v_id;
  EXECUTE format('SELECT version FROM %s WHERE %s = %L', p_tbl, CASE WHEN p_tbl = 'masters.kyc_document_secret'::regclass THEN 'kyc_document_id' ELSE 'id' END, v_id) INTO v;
  IF v <> 1 THEN RAISE EXCEPTION 'FAIL  % % insert version %', p_code, p_tbl, v; END IF;
  EXECUTE p_update || format(' WHERE %s = %L RETURNING version', CASE WHEN p_tbl = 'masters.kyc_document_secret'::regclass THEN 'kyc_document_id' ELSE 'id' END, v_id) INTO v;
  IF v <> 2 THEN RAISE EXCEPTION 'FAIL  % % update version %', p_code, p_tbl, v; END IF;
  RAISE NOTICE 'PASS  %c % insert -> version 1, update -> version 2', p_code, p_tbl;
  BEGIN
    EXECUTE format('UPDATE %s SET version = 99 WHERE %s = %L', p_tbl, CASE WHEN p_tbl = 'masters.kyc_document_secret'::regclass THEN 'kyc_document_id' ELSE 'id' END, v_id);
    RAISE EXCEPTION 'FAIL  % % client set version', p_code, p_tbl;
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'FAIL%' THEN RAISE; END IF;
    RAISE NOTICE 'PASS  %d % client cannot set version (%)', p_code, p_tbl, SQLERRM;
  END;
  SELECT count(*) INTO n FROM platform.audit_event WHERE table_name = p_tbl::text AND row_id = v_id AND action IN ('INSERT','UPDATE');
  IF p_audited AND n < 2 OR NOT p_audited AND n <> 0 THEN RAISE EXCEPTION 'FAIL  % % audit rows %', p_code, p_tbl, n; END IF;
  RAISE NOTICE 'PASS  %e % audit: % INSERT/UPDATE events for the row', p_code, p_tbl, n;
  -- tenant 2
  PERFORM set_config('app.tenant_id', '00000000-0000-0000-0000-000000000002', false);
  EXECUTE format('SELECT count(*) FROM %s', p_tbl) INTO n;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL  % % tenant 2 sees % rows', p_code, p_tbl, n; END IF;
  BEGIN
    EXECUTE replace(p_insert, 'platform.current_tenant()', quote_literal(t1) || '::uuid');
    RAISE EXCEPTION 'FAIL  % % tenant 2 inserted a tenant-1 row', p_code, p_tbl;
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM NOT LIKE '%row-level security%' THEN RAISE; END IF;
  END;
  PERFORM set_config('app.tenant_id', t1, false);
  RAISE NOTICE 'PASS  %f % tenant 2 sees 0 rows and cannot insert for tenant 1 (RLS)', p_code, p_tbl;
  -- partner session (tenant still set)
  PERFORM set_config('app.partner_id', '00000000-0000-0000-0000-0000000000a1', false);
  EXECUTE format('SELECT count(*) FROM %s', p_tbl) INTO n;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL  % % partner sees % rows', p_code, p_tbl, n; END IF;
  BEGIN
    EXECUTE p_insert;
    RAISE EXCEPTION 'FAIL  % % partner inserted', p_code, p_tbl;
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM NOT LIKE '%row-level security%' THEN RAISE; END IF;
  END;
  PERFORM set_config('app.partner_id', '', false);
  RAISE NOTICE 'PASS  %g % partner session sees 0 rows and cannot insert', p_code, p_tbl;
END $$;
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-000000000001',false),
       set_config('app.user_id','00000000-0000-0000-0000-000000000a01',false) \g /dev/null

\echo '--- 976–981 masters scope'
-- shared fixtures (tenant 1)
INSERT INTO platform.file(tenant_id, id, area, object_key, original_name, content_type, size_bytes, sha256) VALUES
 (platform.current_tenant(), '00000000-0000-0000-0000-0000000f9001', 'attachments', 'attachments/t1/design-lh102-1.jpg', 'lh102-1.jpg', 'image/jpeg', 1000, sha256('p1')),
 (platform.current_tenant(), '00000000-0000-0000-0000-0000000f9002', 'attachments', 'attachments/t1/design-lh102-2.jpg', 'lh102-2.jpg', 'image/jpeg', 1000, sha256('p2')),
 (platform.current_tenant(), '00000000-0000-0000-0000-0000000f9003', 'attachments', 'attachments/t1/kyc-pan-front.jpg', 'pan.jpg', 'image/jpeg', 1000, sha256('k1')),
 (platform.current_tenant(), '00000000-0000-0000-0000-0000000f9004', 'exports', 'exports/t1/designs.xlsx', 'designs.xlsx', 'application/vnd.ms-excel', 100, sha256('x1'));
INSERT INTO masters.vendor(tenant_id, id, code, name, kinds, gstin, state_code)
VALUES (platform.current_tenant(), '00000000-0000-0000-0000-0000000e7001', 'KAR-01', 'Murugan Karigar', '{smith}', NULL, '33'),
       (platform.current_tenant(), '00000000-0000-0000-0000-0000000e7002', 'DSG-01', 'Kovai Designs', '{designer,supplier}', '33ABCDE1234F1Z5', '33');
INSERT INTO masters.stone_standard(tenant_id, id, kind, code, name, cent_from, cent_to) VALUES
 (platform.current_tenant(), '00000000-0000-0000-0000-0000000e5001', 'stone', 'DIA', 'Diamond', NULL, NULL),
 (platform.current_tenant(), '00000000-0000-0000-0000-0000000e5002', 'stone', 'RUBY', 'Ruby', NULL, NULL),
 (platform.current_tenant(), '00000000-0000-0000-0000-0000000e5003', 'clarity', 'VVS1', 'VVS1', NULL, NULL),
 (platform.current_tenant(), '00000000-0000-0000-0000-0000000e5004', 'colour', 'EF', 'E-F', NULL, NULL),
 (platform.current_tenant(), '00000000-0000-0000-0000-0000000e5005', 'cent_group', '10-20', '10-20 cents', 10, 20);
INSERT INTO accounts.account_group(tenant_id, id, name, nature) VALUES (platform.current_tenant(), '00000000-0000-0000-0000-0000000ac001', 'Sundry Creditors (976 test)', 'liability');
INSERT INTO accounts.account_head(tenant_id, id, group_id, name, kind, vendor_id) VALUES
 (platform.current_tenant(), '00000000-0000-0000-0000-0000000ac101', '00000000-0000-0000-0000-0000000ac001', 'Murugan Karigar A/c', 'vendor', '00000000-0000-0000-0000-0000000e7001'),
 (platform.current_tenant(), '00000000-0000-0000-0000-0000000ac102', '00000000-0000-0000-0000-0000000ac001', 'Card clearing (976 test)', 'bank', NULL);
INSERT INTO accounts.cash_counter(tenant_id, id, branch_id, name) VALUES (platform.current_tenant(), '00000000-0000-0000-0000-0000000cc001', '00000000-0000-0000-0000-00000000b001', 'Till 1');
INSERT INTO masters.counter(tenant_id, id, branch_id, code, name) VALUES (platform.current_tenant(), '00000000-0000-0000-0000-0000000c0001', '00000000-0000-0000-0000-00000000b001', 'C1', 'Bridal');

-- ===== 976 design + photos =====
SELECT pg_temp.check(pg_temp.cols('masters.design') =
  'tenant_id:uuid:NN,id:uuid:NN,code:character varying(30):NN,name:text:NN,item_id:uuid:NN,sub_item_id:uuid,purity_id:uuid,designer_id:uuid,'
  'description:text,approx_gross_wt:platform.weight_g,approx_net_wt:platform.weight_g,approx_stone_wt:numeric(12,3),size:text,tags:text[]:NN,'
  'is_active:boolean:NN,version:integer:NN,created_at:timestamp with time zone:NN', 'D1 masters.design columns/types/nullability (weights numeric(12,3))');
SELECT pg_temp.check(pg_temp.cols('masters.design_photo') =
  'tenant_id:uuid:NN,id:uuid:NN,design_id:uuid:NN,file_id:uuid:NN,sort_order:integer:NN,is_primary:boolean:NN,caption:text,version:integer:NN,created_at:timestamp with time zone:NN',
  'D2 masters.design_photo columns');
SELECT pg_temp.check(pg_temp.acl('masters.design') = pg_temp.std_acl() AND pg_temp.acl('masters.design_photo') = pg_temp.std_acl(),
  'D3 design/design_photo grants exactly: app_rw CRUD, app_ro + 5 module writers SELECT');
SELECT pg_temp.lifecycle('D4', 'masters.design',
  $q$INSERT INTO masters.design(tenant_id, id, code, name, item_id, purity_id, designer_id, approx_gross_wt, approx_net_wt, approx_stone_wt, tags)
     VALUES (platform.current_tenant(), '00000000-0000-0000-0000-0000000de102', 'LH-102', 'Lakshmi haram', '00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000022',
             '00000000-0000-0000-0000-0000000e7002', 42.500, 40.120, 1.250, '{bridal,temple}')$q$,
  $q$UPDATE masters.design SET name = 'Lakshmi haram (temple)'$q$, true);
SELECT pg_temp.lifecycle('D5', 'masters.design_photo',
  $q$INSERT INTO masters.design_photo(tenant_id, design_id, file_id, is_primary)
     VALUES (platform.current_tenant(), '00000000-0000-0000-0000-0000000de102', '00000000-0000-0000-0000-0000000f9001', true)$q$,
  $q$UPDATE masters.design_photo SET caption = 'front'$q$, true);
SELECT pg_temp.expect_error($$INSERT INTO masters.design_photo(tenant_id, design_id, file_id, is_primary)
  SELECT platform.current_tenant(), id, '00000000-0000-0000-0000-0000000f9002', true FROM masters.design WHERE code = 'LH-102'$$,
  'D6 only one primary photo per design', '%design_photo_one_primary%');
INSERT INTO masters.design_photo(tenant_id, design_id, file_id, sort_order) SELECT platform.current_tenant(), id, '00000000-0000-0000-0000-0000000f9002', 1 FROM masters.design WHERE code = 'LH-102';
SELECT pg_temp.check((SELECT count(*) FROM masters.design_photo p JOIN platform.file f ON f.tenant_id = p.tenant_id AND f.id = p.file_id) = 2, 'D7 photos are platform.file rows (2 linked)');
SELECT pg_temp.expect_error($$INSERT INTO masters.design_photo(tenant_id, design_id, file_id) SELECT platform.current_tenant(), id, '00000000-0000-0000-0000-0000000f2e01' FROM masters.design WHERE code = 'LH-102'$$,
  'D8 photo cannot use another tenant''s file (composite FK)', '%design_photo_file_fk%');
SELECT pg_temp.expect_error($$INSERT INTO masters.design(tenant_id, code, name, item_id) VALUES (platform.current_tenant(), 'LH-102', 'dup', '00000000-0000-0000-0000-000000000901')$$,
  'D9 design code unique per tenant', '%design_code_uq%');
SELECT pg_temp.expect_error($$INSERT INTO masters.design(tenant_id, code, name, item_id, approx_gross_wt, approx_net_wt) VALUES (platform.current_tenant(), 'X-1', 'x', '00000000-0000-0000-0000-000000000901', 1, 2)$$,
  'D10 approx net weight cannot exceed gross', '%design_net_le_gross%');
SELECT pg_temp.expect_error($$INSERT INTO masters.design(tenant_id, code, name, item_id, approx_gross_wt) VALUES (platform.current_tenant(), 'X-2', 'x', '00000000-0000-0000-0000-000000000901', -1)$$,
  'D11 negative weight rejected (weight_g domain)', '%weight_g%');
DELETE FROM masters.design WHERE code = 'LH-102';
SELECT pg_temp.check((SELECT count(*) FROM masters.design_photo) = 0, 'D12 deleting a design removes its photo links (files stay)');
SELECT pg_temp.check((SELECT count(*) FROM platform.file WHERE id IN ('00000000-0000-0000-0000-0000000f9001','00000000-0000-0000-0000-0000000f9002')) = 2, 'D12 files kept');
INSERT INTO masters.design(tenant_id, id, code, name, item_id) VALUES (platform.current_tenant(), '00000000-0000-0000-0000-0000000de001', 'RG-7', 'Solitaire ring', '00000000-0000-0000-0000-000000000901');

-- ===== 977 stones / rate per carat =====
SELECT pg_temp.check(pg_temp.cols('masters.diamond_rate', ARRAY['cent_group_id','stone_id','rate_unit','effective_to','is_active','version','sale_rate_per_ct']) =
  'cent_group_id:uuid,sale_rate_per_ct:platform.money:NN,stone_id:uuid,rate_unit:text:NN,effective_to:date,is_active:boolean:NN,version:integer:NN',
  'S1 diamond_rate new columns; cent_group optional; sale rate money numeric(14,2)');
SELECT pg_temp.check(pg_temp.cols('masters.stone_standard', ARRAY['is_active','version']) = 'is_active:boolean:NN,version:integer:NN', 'S2 stone_standard is_active/version');
SELECT pg_temp.lifecycle('S3', 'masters.stone_standard',
  $q$INSERT INTO masters.stone_standard(tenant_id, kind, code, name) VALUES (platform.current_tenant(), 'shape', 'RND', 'Round')$q$,
  $q$UPDATE masters.stone_standard SET name = 'Round brilliant'$q$, true,
  'no_partner_access,tenant_isolation');
SELECT pg_temp.lifecycle('S4', 'masters.diamond_rate',
  $q$INSERT INTO masters.diamond_rate(tenant_id, stone_id, cent_group_id, clarity_id, colour_id, sale_rate_per_ct, purchase_rate_per_ct, effective_from)
     VALUES (platform.current_tenant(), '00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e5005', '00000000-0000-0000-0000-0000000e5003',
             '00000000-0000-0000-0000-0000000e5004', 85000.00, 70000.00, '2026-11-01')$q$,
  $q$UPDATE masters.diamond_rate SET sale_rate_per_ct = 86000$q$, true);
INSERT INTO masters.diamond_rate(tenant_id, stone_id, rate_unit, sale_rate_per_ct, effective_from)
VALUES (platform.current_tenant(), '00000000-0000-0000-0000-0000000e5002', 'per_ct', 12000, '2026-11-01');
SELECT pg_temp.check((SELECT count(*) FROM masters.diamond_rate WHERE stone_id = '00000000-0000-0000-0000-0000000e5002' AND cent_group_id IS NULL) = 1,
  'S5 colour stone (ruby) priced per carat without a size band');
SELECT pg_temp.expect_error($$INSERT INTO masters.diamond_rate(tenant_id, sale_rate_per_ct, effective_from) VALUES (platform.current_tenant(), 1, '2026-11-01')$$,
  'S6 a rate needs a stone type or a cent group', '%diamond_rate_has_key%');
SELECT pg_temp.expect_error($$INSERT INTO masters.diamond_rate(tenant_id, stone_id, clarity_id, sale_rate_per_ct, effective_from) VALUES (platform.current_tenant(), '00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-00000000dead', 1, '2026-11-01')$$,
  'S7 clarity must exist (FK, enforced for new rows)', '%diamond_rate_clarity_fk%');
SELECT pg_temp.expect_error($$INSERT INTO masters.diamond_rate(tenant_id, stone_id, rate_unit, sale_rate_per_ct, effective_from) VALUES (platform.current_tenant(), '00000000-0000-0000-0000-0000000e5001', 'per_gram', 1, '2026-11-01')$$,
  'S8 rate_unit per_ct|per_piece only', '%diamond_rate_rate_unit_check%');
SELECT pg_temp.expect_error($$INSERT INTO masters.diamond_rate(tenant_id, stone_id, sale_rate_per_ct, effective_from, effective_to) VALUES (platform.current_tenant(), '00000000-0000-0000-0000-0000000e5001', 1, '2026-11-01', '2026-11-01')$$,
  'S9 effective_to after effective_from', '%diamond_rate_period%');
SELECT pg_temp.expect_error($$INSERT INTO masters.diamond_rate(tenant_id, stone_id, sale_rate_per_ct, effective_from) VALUES (platform.current_tenant(), '00000000-0000-0000-0000-0000000e5001', -5, '2026-11-01')$$,
  'S10 negative rate rejected', '%diamond_rate_rates_nonneg%');

-- ===== 978 making-charge / wastage rules =====
SELECT pg_temp.check(pg_temp.cols('masters.value_addition_rule', ARRAY['purity_id','design_id','mc_percent','effective_from','effective_to','priority','is_active','version']) =
  'purity_id:uuid,design_id:uuid,mc_percent:platform.pct,effective_from:date,effective_to:date,priority:integer:NN,is_active:boolean:NN,version:integer:NN',
  'V1 value_addition_rule new columns');
SELECT pg_temp.lifecycle('V2', 'masters.value_addition_rule',
  $q$INSERT INTO masters.value_addition_rule(tenant_id, scope, item_id, mc_per_gram, wastage_pct, weight_from, weight_to)
     VALUES (platform.current_tenant(), 'customer', '00000000-0000-0000-0000-000000000901', 450.00, 8.000, 0, 10)$q$,
  $q$UPDATE masters.value_addition_rule SET wastage_pct = 7.5$q$, true);
INSERT INTO masters.value_addition_rule(tenant_id, scope, design_id, mc_percent, effective_from) VALUES (platform.current_tenant(), 'customer', '00000000-0000-0000-0000-0000000de001', 12.5, '2026-11-01');
INSERT INTO masters.value_addition_rule(tenant_id, scope, item_id, flat_mc, flat_wastage) VALUES (platform.current_tenant(), 'customer', '00000000-0000-0000-0000-000000000902', 250.00, 0.150);
SELECT pg_temp.check((SELECT count(*) FROM masters.value_addition_rule WHERE mc_per_gram IS NOT NULL OR mc_percent IS NOT NULL OR flat_mc IS NOT NULL) = 3,
  'V3 per-gram (category), percent (product/design) and fixed MC rules all stored');
SELECT pg_temp.expect_error($$INSERT INTO masters.value_addition_rule(tenant_id, scope, item_id, mc_per_gram, mc_percent) VALUES (platform.current_tenant(), 'customer', '00000000-0000-0000-0000-000000000901', 1, 1)$$,
  'V4 one making-charge basis per rule', '%var_one_mc_basis%');
SELECT pg_temp.expect_error($$INSERT INTO masters.value_addition_rule(tenant_id, scope, item_id, wastage_pct, flat_wastage) VALUES (platform.current_tenant(), 'customer', '00000000-0000-0000-0000-000000000901', 1, 1)$$,
  'V5 one wastage basis per rule', '%var_one_wastage_basis%');
SELECT pg_temp.expect_error($$INSERT INTO masters.value_addition_rule(tenant_id, scope, item_id, mc_percent) VALUES (platform.current_tenant(), 'customer', '00000000-0000-0000-0000-000000000901', 101)$$,
  'V6 MC percent 0–100', '%var_mc_percent_range%');
SELECT pg_temp.expect_error($$INSERT INTO masters.value_addition_rule(tenant_id, scope, item_id, weight_from, weight_to) VALUES (platform.current_tenant(), 'customer', '00000000-0000-0000-0000-000000000901', 10, 5)$$,
  'V7 weight band to > from', '%var_weight_band%');
SELECT pg_temp.expect_error($$INSERT INTO masters.value_addition_rule(tenant_id, scope, design_id) VALUES (platform.current_tenant(), 'customer', '00000000-0000-0000-0000-00000000dead')$$,
  'V8 design must exist', '%var_design_fk%');
SELECT pg_temp.expect_error($$INSERT INTO masters.value_addition_rule(tenant_id, scope, effective_from, effective_to) VALUES (platform.current_tenant(), 'customer', '2026-11-02', '2026-11-01')$$,
  'V9 rule period to > from', '%var_period%');

-- ===== 979 customers / vendors / staff / KYC / metal openings =====
SELECT pg_temp.check(pg_temp.cols('masters.customer', ARRAY['name','phone','dob','anniversary','gstin','pan_enc','pan_last4','pan_key_id','address','kyc_status','kyc_verified_at','kyc_verified_by','is_active','version']) =
  'name:text:NN,phone:character varying(15),dob:date,anniversary:date,gstin:platform.gstin,pan_enc:bytea,pan_last4:character varying(4),'
  'address:jsonb:NN,pan_key_id:text,kyc_status:text:NN,kyc_verified_at:timestamp with time zone,kyc_verified_by:uuid,is_active:boolean:NN,version:integer:NN',
  'C1 customer has name/mobile/address/PAN(enc)/GSTIN/KYC/birthday/anniversary + version (no aadhaar_last4, 984)');
SELECT version AS v0 FROM masters.customer WHERE id = '00000000-0000-0000-0000-000000000d01' \gset
WITH u AS (UPDATE masters.customer SET kyc_status = 'pending' WHERE id = '00000000-0000-0000-0000-000000000d01' RETURNING version)
  SELECT pg_temp.check((SELECT version FROM u) = :v0 + 1, 'C2 customer update bumps version by 1 (aa_version)');
SELECT pg_temp.expect_error($$UPDATE masters.customer SET kyc_status = 'verified' WHERE id = '00000000-0000-0000-0000-000000000d01'$$,
  'C3 verified KYC needs kyc_verified_at', '%customer_kyc_verified_consistent%');
SELECT pg_temp.expect_error($$UPDATE masters.customer SET kyc_status = 'ok' WHERE id = '00000000-0000-0000-0000-000000000d01'$$, 'C4 kyc_status CHECK', '%customer_kyc_status_check%');
SELECT pg_temp.check(pg_temp.cols('masters.vendor', ARRAY['gstin','pan','pan_enc','pan_key_id','pan_last4','version']) =
  'gstin:platform.gstin,pan:character varying(10),pan_enc:bytea,pan_key_id:text,pan_last4:character varying(4),version:integer:NN',
  'C5 vendor PAN ciphertext/key/last4 + version (no aadhaar_last4, 984)');
SELECT pg_temp.expect_error($$UPDATE masters.vendor SET pan_enc = convert_to('ABCDE1234F','UTF8'), pan_key_id = 'k', pan_last4 = '234F' WHERE code = 'KAR-01'$$,
  'C6 vendor rejects plaintext PAN in pan_enc', '%vendor_pan_ciphertext%');
SELECT pg_temp.expect_error($$UPDATE masters.vendor SET pan_enc = '\x9f'::bytea || sha256('n') WHERE code = 'KAR-01'$$,
  'C7 vendor PAN ciphertext needs key id + last4', '%vendor_pan_all_or_none%');
WITH u AS (UPDATE masters.vendor SET pan_enc = '\x9f'::bytea || sha256('n') || sha256('v'), pan_key_id = 'pan-2026-10', pan_last4 = '234F' WHERE code = 'KAR-01' RETURNING version)
  SELECT pg_temp.check((SELECT version FROM u) = 2, 'C8 vendor stores PAN ciphertext; update bumps version');
SELECT pg_temp.check(pg_temp.cols('hr.staff', ARRAY['is_active','is_salesperson','photo_file_id','version']) =
  'is_active:boolean:NN,is_salesperson:boolean:NN,photo_file_id:uuid,version:integer:NN', 'C9 hr.staff is_active/is_salesperson/photo/version');
INSERT INTO hr.staff(tenant_id, id, code, name, branch_id, is_salesperson, photo_file_id)
VALUES (platform.current_tenant(), '00000000-0000-0000-0000-0000000057a1', 'SP-01', 'Kavya (sales)', '00000000-0000-0000-0000-00000000b001', true, '00000000-0000-0000-0000-0000000f9003');
WITH u AS (UPDATE hr.staff SET is_active = false WHERE code = 'SP-01' RETURNING version)
  SELECT pg_temp.check((SELECT version FROM u) = 2, 'C10 staff (salesperson) soft-disable bumps version');
SELECT pg_temp.check((SELECT count(*) FROM pg_trigger WHERE tgname = 'zz_audit' AND tgrelid IN ('masters.customer'::regclass,'masters.vendor'::regclass,'hr.staff'::regclass)) = 0,
  'C11 customer/vendor/staff not row-audited (audit rows would copy PAN ciphertext to app_ro-readable audit_event)');
SELECT pg_temp.check(pg_temp.cols('masters.kyc_document') =
  'tenant_id:uuid:NN,id:uuid:NN,party_type:text:NN,customer_id:uuid,vendor_id:uuid,staff_id:uuid,doc_type:text:NN,number_last4:character varying(4),'
  'front_file_id:uuid:NN,back_file_id:uuid,status:text:NN,verified_at:timestamp with time zone,verified_by:uuid,expires_on:date,is_active:boolean:NN,'
  'version:integer:NN,created_at:timestamp with time zone:NN', 'K1 kyc_document columns (no secret column)');
SELECT pg_temp.check(pg_temp.cols('masters.kyc_document_secret') =
  'tenant_id:uuid:NN,kyc_document_id:uuid:NN,number_enc:bytea:NN,number_key_id:text:NN,version:integer:NN,created_at:timestamp with time zone:NN', 'K2 kyc_document_secret columns');
SELECT pg_temp.check(pg_temp.acl('masters.kyc_document') = pg_temp.std_acl(), 'K3 kyc_document grants: app_rw CRUD, app_ro + writers SELECT');
SELECT pg_temp.check(pg_temp.acl('masters.kyc_document_secret') = pg_temp.std_acl(false, false), 'K4 kyc_document_secret grants: app_rw only (no app_ro, no writers)');
SELECT pg_temp.lifecycle('K5', 'masters.kyc_document',
  $q$INSERT INTO masters.kyc_document(tenant_id, id, party_type, customer_id, doc_type, number_last4, front_file_id)
     VALUES (platform.current_tenant(), '00000000-0000-0000-0000-0000000ec001', 'customer', '00000000-0000-0000-0000-000000000d01', 'pan', '234F', '00000000-0000-0000-0000-0000000f9003')$q$,
  $q$UPDATE masters.kyc_document SET status = 'verified', verified_at = now(), verified_by = '00000000-0000-0000-0000-000000000a01'$q$, true);
SELECT pg_temp.lifecycle('K6', 'masters.kyc_document_secret',
  $q$INSERT INTO masters.kyc_document_secret(tenant_id, kyc_document_id, number_enc, number_key_id)
     VALUES (platform.current_tenant(), '00000000-0000-0000-0000-0000000ec001', '\x9f'::bytea || sha256('n') || sha256('kyc'), 'kyc-2026-10')$q$,
  $q$UPDATE masters.kyc_document_secret SET number_key_id = 'kyc-2026-11'$q$, false);
SELECT pg_temp.expect_error($$INSERT INTO masters.kyc_document_secret(tenant_id, kyc_document_id, number_enc, number_key_id)
  VALUES (platform.current_tenant(), '00000000-0000-0000-0000-0000000ec001', convert_to('123412341234','UTF8') || convert_to('123412341234123412','UTF8'), 'k')$$,
  'K7 KYC number must be ciphertext, never readable text', '%kyc_document_secret_ciphertext%');
SELECT pg_temp.expect_error($$INSERT INTO masters.kyc_document(tenant_id, party_type, customer_id, vendor_id, doc_type, front_file_id)
  VALUES (platform.current_tenant(), 'customer', '00000000-0000-0000-0000-000000000d01', '00000000-0000-0000-0000-0000000e7001', 'pan', '00000000-0000-0000-0000-0000000f9003')$$,
  'K8 exactly one party per KYC document', '%kyc_document_one_party%');
SELECT pg_temp.expect_error($$INSERT INTO masters.kyc_document(tenant_id, party_type, vendor_id, doc_type, front_file_id, status)
  VALUES (platform.current_tenant(), 'vendor', '00000000-0000-0000-0000-0000000e7001', 'passport', '00000000-0000-0000-0000-0000000f9003', 'verified')$$,
  'K9 verified document needs verified_at', '%kyc_document_verified_consistent%');
SELECT pg_temp.expect_error($$INSERT INTO masters.kyc_document(tenant_id, party_type, staff_id, doc_type, front_file_id, number_last4)
  VALUES (platform.current_tenant(), 'staff', '00000000-0000-0000-0000-0000000057a1', 'voter_id', '00000000-0000-0000-0000-0000000f9003', '12a4')$$,
  'K10 number_last4 format', '%kyc_document_number_last4_check%');
INSERT INTO masters.kyc_document(tenant_id, party_type, vendor_id, doc_type, front_file_id) VALUES (platform.current_tenant(), 'vendor', '00000000-0000-0000-0000-0000000e7001', 'gstin_certificate', '00000000-0000-0000-0000-0000000f9003');
INSERT INTO masters.kyc_document(tenant_id, party_type, staff_id, doc_type, front_file_id) VALUES (platform.current_tenant(), 'staff', '00000000-0000-0000-0000-0000000057a1', 'driving_licence', '00000000-0000-0000-0000-0000000f9003');
SELECT pg_temp.check((SELECT string_agg(party_type, ',' ORDER BY party_type) FROM masters.kyc_document) = 'customer,staff,vendor', 'K11 KYC documents for customer, vendor (karigar) and staff');
SELECT pg_temp.expect_error($$INSERT INTO masters.kyc_document(tenant_id, party_type, customer_id, doc_type, front_file_id)
  VALUES (platform.current_tenant(), 'customer', '00000000-0000-0000-0000-000000000d01', 'pan', '00000000-0000-0000-0000-0000000f2e01')$$,
  'K12 KYC scan cannot be another tenant''s file', '%kyc_document_front_fk%');
SELECT pg_temp.check(pg_temp.cols('accounts.party_opening_metal') =
  'tenant_id:uuid:NN,id:uuid:NN,account_head_id:uuid:NN,metal_id:uuid:NN,purity_id:uuid,weight:numeric(12,3):NN,as_of:date:NN,note:text,version:integer:NN,created_at:timestamp with time zone:NN',
  'O1 party_opening_metal columns (weight numeric(12,3), signed)');
SELECT pg_temp.check(pg_temp.acl('accounts.party_opening_metal') = 'accounts_writer:SELECT,app_ro:SELECT,app_rw:INSERT,app_rw:SELECT,app_rw:UPDATE',
  'O2 party_opening_metal grants: app_rw SELECT/INSERT/UPDATE (no DELETE), app_ro + accounts_writer SELECT');
SELECT pg_temp.lifecycle('O3', 'accounts.party_opening_metal',
  $q$INSERT INTO accounts.party_opening_metal(tenant_id, account_head_id, metal_id, purity_id, weight, as_of)
     VALUES (platform.current_tenant(), '00000000-0000-0000-0000-0000000ac101', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-000000000022', -125.375, '2026-04-01')$q$,
  $q$UPDATE accounts.party_opening_metal SET note = 'karigar holds our 22K'$q$, true);
SELECT pg_temp.expect_error($$INSERT INTO accounts.party_opening_metal(tenant_id, account_head_id, metal_id, purity_id, weight, as_of)
  VALUES (platform.current_tenant(), '00000000-0000-0000-0000-0000000ac101', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-000000000022', 1, '2026-04-01')$$,
  'O4 one opening per party/metal/purity', '%party_opening_metal_uq%');
SELECT pg_temp.expect_error($$DELETE FROM accounts.party_opening_metal$$, 'O5 app_rw cannot DELETE metal openings', '%permission denied%');
-- secret columns: only app_rw (and owner) can read; non-secret columns stay readable
SELECT pg_temp.check(NOT EXISTS (
         SELECT 1 FROM pg_roles r,
              (VALUES ('masters.vendor','pan_enc'),('masters.vendor','pan_key_id'),
                      ('masters.kyc_document_secret','number_enc'),('masters.kyc_document_secret','number_key_id')) AS v(tbl, col)
         WHERE r.rolname IN ('app_ro','app_worker','app_admin','platform_writer','notifications_writer','platform_lookup','tenant_provisioner',
                             'sales_writer','inventory_writer','accounts_writer','orders_writer','purchases_writer','refinery_writer')
           AND has_column_privilege(r.rolname, v.tbl::regclass, v.col, 'SELECT')),
       'P1 no role but app_rw can read vendor PAN / KYC number ciphertext or key ids');
SELECT pg_temp.check(NOT has_column_privilege('app_ro', 'masters.vendor', 'pan', 'SELECT') AND NOT has_table_privilege('app_ro', 'masters.kyc_document_secret', 'SELECT'),
       'P2 app_ro cannot read legacy plaintext vendor.pan or the KYC secret table');
SELECT pg_temp.check(has_column_privilege('app_ro', 'masters.vendor', 'pan_last4', 'SELECT') AND has_column_privilege('app_ro', 'masters.vendor', 'version', 'SELECT')
                 AND has_column_privilege('purchases_writer', 'masters.vendor', 'gstin', 'SELECT') AND has_column_privilege('purchases_writer', 'masters.vendor', 'pan_last4', 'SELECT')
                 AND has_column_privilege('app_ro', 'masters.customer', 'kyc_status', 'SELECT') AND has_column_privilege('sales_writer', 'masters.customer', 'version', 'SELECT')
                 AND has_column_privilege('app_ro', 'hr.staff', 'is_salesperson', 'SELECT') AND has_column_privilege('sales_writer', 'hr.staff', 'is_active', 'SELECT')
                 AND has_column_privilege('app_ro', 'masters.kyc_document', 'number_last4', 'SELECT'),
       'P3 new non-secret columns readable by app_ro and module writers (last4, version, kyc_status, is_salesperson)');
SELECT pg_temp.check(NOT has_column_privilege('app_ro', 'masters.customer', 'pan_enc', 'SELECT') AND NOT has_column_privilege('app_ro', 'hr.staff', 'pan_enc', 'SELECT'),
       'P4 customer/staff PAN ciphertext still hidden from app_ro after 979');

-- ===== 980 counters, trays, HSN, payment modes, card machines =====
SELECT pg_temp.check(pg_temp.cols('masters.counter', ARRAY['is_active','version']) = 'is_active:boolean:NN,version:integer:NN'
                 AND pg_temp.cols('masters.box', ARRAY['tare_weight','name','is_active','version']) = 'tare_weight:platform.weight_g:NN,name:text,is_active:boolean:NN,version:integer:NN',
  'H1 counter/box(tray) is_active/version; tray name; tare weight numeric(12,3)');
SELECT pg_temp.lifecycle('H2', 'masters.counter',
  $q$INSERT INTO masters.counter(tenant_id, branch_id, code, name) VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', 'C2', 'Silver')$q$,
  $q$UPDATE masters.counter SET name = 'Silver & coins'$q$, true, 'branch_scope,no_partner_access,tenant_isolation');
SELECT pg_temp.lifecycle('H3', 'masters.box',
  $q$INSERT INTO masters.box(tenant_id, counter_id, code, name, tare_weight) VALUES (platform.current_tenant(), '00000000-0000-0000-0000-0000000c0001', 'TR-01', 'Bangles tray', 120.500)$q$,
  $q$UPDATE masters.box SET is_active = false$q$, true);
SELECT pg_temp.check(pg_temp.cols('masters.hsn_code') =
  'tenant_id:uuid:NN,id:uuid:NN,code_type:text:NN,code:character varying(8):NN,description:text:NN,uqc:character varying(3),is_active:boolean:NN,version:integer:NN,created_at:timestamp with time zone:NN',
  'H4 hsn_code columns (no rate column: rates stay in tax_rule)');
SELECT pg_temp.check(pg_temp.acl('masters.hsn_code') = (SELECT string_agg(x, ',' ORDER BY x) FROM unnest(string_to_array(pg_temp.std_acl(), ',') || 'tenant_provisioner:INSERT'::text) x) AND pg_temp.acl('masters.payment_mode') = pg_temp.std_acl()
                 AND pg_temp.acl('masters.card_machine') = pg_temp.std_acl(), 'H5 hsn_code/payment_mode/card_machine grants: app_rw CRUD, app_ro + writers SELECT (+ tenant_provisioner INSERT on hsn_code, 983)');
INSERT INTO masters.hsn_code(tenant_id, code_type, code, description, uqc) VALUES (platform.current_tenant(), 'HSN', '7113', 'Articles of jewellery of precious metal', 'GMS')
  ON CONFLICT DO NOTHING;   -- fresh seed already has it (983); upgrade seed ran before 980
SELECT pg_temp.lifecycle('H6', 'masters.hsn_code',
  $q$INSERT INTO masters.hsn_code(tenant_id, code_type, code, description, uqc) VALUES (platform.current_tenant(), 'HSN', '7114', 'Articles of goldsmiths'' wares', 'GMS')$q$,
  $q$UPDATE masters.hsn_code SET description = 'Goldsmiths'' wares'$q$, true);
SELECT pg_temp.check((SELECT t.rate FROM masters.hsn_code h JOIN masters.tax_rule t ON t.code_type = h.code_type AND t.hsn_sac = h.code
                      WHERE h.code = '7113' AND t.code = 'GOLD_JEWELLERY' AND t.scope = 'tenant') = 3.00,
  'H7 HSN joins to its GST rate in masters.tax_rule (configurable, not stored on hsn_code)');
SELECT pg_temp.expect_error($$INSERT INTO masters.hsn_code(tenant_id, code_type, code, description) VALUES (platform.current_tenant(), 'HSN', '71A3', 'x')$$, 'H8 HSN code format', '%hsn_code_code_check%');
SELECT pg_temp.expect_error($$INSERT INTO masters.hsn_code(tenant_id, code_type, code, description) VALUES (platform.current_tenant(), 'HSN', '7113', 'dup')$$, 'H9 HSN unique per tenant/type', '%hsn_code%uq%');
SELECT pg_temp.lifecycle('H10', 'masters.payment_mode',
  $q$INSERT INTO masters.payment_mode(tenant_id, id, code, name, kind, account_head_id, requires_reference, requires_card_machine)
     VALUES (platform.current_tenant(), '00000000-0000-0000-0000-0000000aa001', 'HDFC_CARD', 'HDFC card', 'credit_card', '00000000-0000-0000-0000-0000000ac102', true, true)$q$,
  $q$UPDATE masters.payment_mode SET sort_order = 2$q$, true);
SELECT pg_temp.expect_error($$INSERT INTO masters.payment_mode(tenant_id, code, name, kind, requires_card_machine) VALUES (platform.current_tenant(), 'CASH2', 'Cash', 'cash', true)$$,
  'H11 only card/UPI modes may require a card machine', '%payment_mode_card_kinds%');
SELECT pg_temp.expect_error($$INSERT INTO masters.payment_mode(tenant_id, code, name, kind) VALUES (platform.current_tenant(), 'BTC', 'Bitcoin', 'crypto')$$,
  'H12 payment mode kind limited to invoice_payment modes', '%payment_mode_kind_check%');
INSERT INTO masters.bank_account(tenant_id, id, owner_type, company_id, bank_name, ifsc, holder_name, account_no_enc, account_key_id, account_last4)
VALUES (platform.current_tenant(), '00000000-0000-0000-0000-0000000ba001', 'company', '00000000-0000-0000-0000-00000000c001', 'HDFC Bank', 'HDFC0001234',
        'Sri Lakshmi Jewellers', '\x9f'::bytea || sha256('n') || sha256('settle'), 'bank-2026-10', '9876');
SELECT pg_temp.lifecycle('H13', 'masters.card_machine',
  $q$INSERT INTO masters.card_machine(tenant_id, id, branch_id, cash_counter_id, code, provider, terminal_id, merchant_id, settlement_bank_account_id, mdr_pct)
     VALUES (platform.current_tenant(), '00000000-0000-0000-0000-0000000cb001', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000cc001',
             'POS-1', 'HDFC', 'T1234567', 'M98765432', '00000000-0000-0000-0000-0000000ba001', 1.800)$q$,
  $q$UPDATE masters.card_machine SET mdr_pct = 1.750$q$, true,
  'branch_scope,no_partner_access,tenant_isolation');
SELECT pg_temp.expect_error($$INSERT INTO masters.card_machine(tenant_id, branch_id, code, provider, terminal_id) VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', 'POS-2', 'HDFC', 'T1234567')$$,
  'H14 terminal id unique per provider', '%card_machine_tid_uq%');
SELECT pg_temp.expect_error($$INSERT INTO masters.card_machine(tenant_id, branch_id, code, provider, terminal_id, supports) VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', 'POS-3', 'HDFC', 'T7654321', '{cash}')$$,
  'H15 card machine supports card/UPI only', '%card_machine_supports_check%');
SELECT set_config('app.branch_scope', '00000000-0000-0000-0000-00000000b0ff', false) \g /dev/null
SELECT pg_temp.check((SELECT count(*) FROM masters.card_machine) = 0, 'H16 branch_scope hides card machines of other branches');
SELECT set_config('app.branch_scope', '', false) \g /dev/null
SELECT pg_temp.check(pg_temp.cols('sales.invoice_payment', ARRAY['payment_mode_id','card_machine_id']) = 'payment_mode_id:uuid,card_machine_id:uuid', 'H17 invoice_payment links payment mode + card machine (nullable)');
SELECT pg_temp.check(has_column_privilege('sales_writer', 'sales.invoice_payment', 'payment_mode_id', 'INSERT') AND has_column_privilege('sales_writer', 'sales.invoice_payment', 'card_machine_id', 'INSERT')
                 AND NOT has_table_privilege('app_rw', 'sales.invoice_payment', 'INSERT'), 'H18 only sales_writer inserts payments (with mode/machine); app_rw still cannot');
SELECT pg_temp.check((SELECT count(*) FROM pg_constraint WHERE conrelid = 'sales.invoice_payment'::regclass AND conname IN ('invoice_payment_mode_fk','invoice_payment_machine_fk')) = 2,
  'H19 invoice_payment FKs to payment_mode / card_machine (same tenant)');

-- ===== 981 import / export =====
SELECT pg_temp.check((SELECT pg_get_constraintdef(oid) LIKE '%designs%card_machines%' FROM pg_constraint WHERE conname = 'import_job_kind_check')
                 AND (SELECT pg_get_constraintdef(oid) LIKE '%designs%card_machines%' FROM pg_constraint WHERE conname = 'import_mapping_profile_kind_check'),
  'X1 import_job/import_mapping_profile kinds include the master entities');
INSERT INTO platform.import_mapping_profile(tenant_id, kind, name, mapping) VALUES (platform.current_tenant(), 'designs', 'Design sheet', '{"Design No":"code"}');
INSERT INTO platform.import_job(tenant_id, kind, file_key, created_by) VALUES (platform.current_tenant(), 'designs', 'imports/t1/designs.xlsx', '00000000-0000-0000-0000-000000000a01');
SELECT pg_temp.check((SELECT count(*) FROM platform.import_job WHERE kind = 'designs') = 1, 'X2 a designs import job and mapping profile are accepted');
SELECT pg_temp.expect_error($$INSERT INTO platform.import_job(tenant_id, kind, file_key, created_by) VALUES (platform.current_tenant(), 'invoices', 'x', '00000000-0000-0000-0000-000000000a01')$$,
  'X3 unknown import kind still rejected', '%import_job_kind_check%');
SELECT pg_temp.check(pg_temp.cols('platform.export_job') =
  'tenant_id:uuid:NN,id:uuid:NN,branch_id:uuid,kind:text:NN,format:text:NN,filters:jsonb:NN,status:text:NN,file_id:uuid,row_count:integer,error:text,'
  'created_by:uuid:NN,created_at:timestamp with time zone:NN,started_at:timestamp with time zone,finished_at:timestamp with time zone,version:integer:NN',
  'X4 export_job columns');
SELECT pg_temp.check(pg_temp.acl('platform.export_job') = 'app_ro:SELECT,app_rw:INSERT,app_rw:SELECT,app_rw:UPDATE', 'X5 export_job grants: app_rw SELECT/INSERT/UPDATE, app_ro SELECT, no worker/writers');
SELECT pg_temp.lifecycle('X6', 'platform.export_job',
  $q$INSERT INTO platform.export_job(tenant_id, kind, format, created_by) VALUES (platform.current_tenant(), 'designs', 'xlsx', '00000000-0000-0000-0000-000000000a01')$q$,
  $q$UPDATE platform.export_job SET status = 'completed', file_id = '00000000-0000-0000-0000-0000000f9004', row_count = 1, finished_at = now()$q$, true);
SELECT pg_temp.expect_error($$INSERT INTO platform.export_job(tenant_id, kind, status, created_by) VALUES (platform.current_tenant(), 'designs', 'completed', '00000000-0000-0000-0000-000000000a01')$$,
  'X7 a completed export must have its file', '%export_job_completed_has_file%');
SELECT pg_temp.expect_error($$INSERT INTO platform.export_job(tenant_id, kind, filters, created_by) VALUES (platform.current_tenant(), 'designs', '[]', '00000000-0000-0000-0000-000000000a01')$$,
  'X8 filters must be a JSON object', '%export_job_filters_check%');
SELECT pg_temp.expect_error($$DELETE FROM platform.export_job$$, 'X9 app_rw cannot DELETE export jobs', '%permission denied%');


-- ===== 982 item/sub_item/floor versioning, floor.code, permissions, old_gold =====
SELECT pg_temp.check(pg_temp.cols('masters.item', ARRAY['is_active','version']) = 'is_active:boolean:NN,version:integer:NN'
                 AND pg_temp.cols('masters.sub_item', ARRAY['is_active','version']) = 'is_active:boolean:NN,version:integer:NN'
                 AND pg_temp.cols('masters.floor', ARRAY['code','is_active','version']) = 'code:character varying(10),is_active:boolean:NN,version:integer:NN',
  'G1 item/sub_item/floor have is_active + version; floor.code');
SELECT pg_temp.check((SELECT count(DISTINCT tgrelid) FROM pg_trigger WHERE tgname = 'aa_version' AND tgrelid IN (
        'masters.item'::regclass,'masters.sub_item'::regclass,'masters.stone_standard'::regclass,'masters.diamond_rate'::regclass,'masters.value_addition_rule'::regclass,
        'masters.customer'::regclass,'masters.vendor'::regclass,'masters.floor'::regclass,'masters.counter'::regclass,'masters.box'::regclass,'hr.staff'::regclass)) = 11,
  'G2 aa_version on all 11 Ironhide master tables');
SELECT version AS iv0 FROM masters.item WHERE id = '00000000-0000-0000-0000-000000000901' \gset
WITH u AS (UPDATE masters.item SET short_code = 'RNG' WHERE id = '00000000-0000-0000-0000-000000000901' RETURNING version)
  SELECT pg_temp.check((SELECT version FROM u) = :iv0 + 1, 'G3 item update bumps version');
SELECT pg_temp.lifecycle('G4', 'masters.sub_item',
  $q$INSERT INTO masters.sub_item(tenant_id, item_id, code, name) VALUES (platform.current_tenant(), '00000000-0000-0000-0000-000000000901', 'SOL', 'Solitaire')$q$,
  $q$UPDATE masters.sub_item SET is_active = false$q$, true);
SELECT pg_temp.lifecycle('G5', 'masters.floor',
  $q$INSERT INTO masters.floor(tenant_id, branch_id, code, name) VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', 'GF', 'Ground floor')$q$,
  $q$UPDATE masters.floor SET name = 'Ground'$q$, true, 'branch_scope,no_partner_access,tenant_isolation');
SELECT pg_temp.expect_error($$INSERT INTO masters.floor(tenant_id, branch_id, code, name) VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', 'GF', 'dup')$$,
  'G6 floor code unique per branch', '%floor_branch_code_uq%');
INSERT INTO masters.floor(tenant_id, branch_id, name) VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', 'Legacy floor (no code)');
SELECT pg_temp.check(true, 'G7 floors without a code still allowed (existing rows)');
SELECT pg_temp.check((SELECT count(*) FROM platform.permission WHERE module = 'masters' AND code ~ '\.(view|manage)$') = 22
                 AND (SELECT count(*) FROM platform.system_role_permission WHERE role_code = 'owner' AND permission_code ~ '^masters\..*\.(view|manage)$') = 22
                 AND (SELECT count(*) FROM platform.system_role_permission WHERE role_code = 'manager' AND permission_code ~ '^masters\..*\.(view|manage)$') = 22
                 AND (SELECT count(*) FROM platform.system_role_permission WHERE role_code IN ('salesperson','cashier') AND permission_code LIKE 'masters.%.view') = 22
                 AND NOT EXISTS (SELECT 1 FROM platform.system_role_permission WHERE role_code IN ('salesperson','cashier') AND permission_code LIKE 'masters.%.manage'),
  'G8 22 masters view/manage permissions; owner+manager all, salesperson/cashier view only');
SELECT pg_temp.check((SELECT count(*) FROM platform.role r JOIN platform.system_role_permission p ON p.role_code = r.system_role_code
                      WHERE r.tenant_id = platform.current_tenant() AND r.system_role_code = 'cashier' AND p.permission_code IN ('masters.designs.view','masters.designs.manage')) = 1,
  'G9 existing tenant''s cashier role resolves masters.designs.view but not manage (no backfill rows needed)');
SELECT pg_temp.check(pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'invoice_payment_mode_check')) LIKE '%old_gold%'
                 AND pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'payment_mode_kind_check')) LIKE '%old_gold%',
  'G10 invoice_payment.mode and payment_mode.kind allow old_gold');
INSERT INTO masters.payment_mode(tenant_id, code, name, kind) VALUES (platform.current_tenant(), 'OLD_GOLD', 'Old gold exchange', 'old_gold');
SELECT pg_temp.check(true, 'G11 old_gold payment mode accepted');


-- ===== 983 follow-ups =====
SELECT pg_temp.check((SELECT count(*) FROM platform.permission WHERE code = 'platform.export.run') = 1
                 AND (SELECT string_agg(role_code, ',' ORDER BY role_code) FROM platform.system_role_permission WHERE permission_code = 'platform.export.run') = 'manager,owner',
  'F1 platform.export.run exists; owner+manager have it, salesperson/cashier do not');
SELECT pg_temp.check(pg_temp.acl('platform.export_job') = 'app_ro:SELECT,app_rw:INSERT,app_rw:SELECT,app_rw:UPDATE'
                 AND NOT has_table_privilege('app_rw', 'platform.import_job', 'DELETE'),
  'F2 export_job grants mirror import_job: app_rw SELECT/INSERT/UPDATE, no DELETE; app_ro SELECT; no writers');
SELECT pg_temp.lifecycle('F3', 'platform.export_job',
  $q$INSERT INTO platform.export_job(tenant_id, kind, format, filters, created_by) VALUES (platform.current_tenant(), 'customers', 'csv', '{"branch":"CBE"}', '00000000-0000-0000-0000-000000000a01')$q$,
  $q$UPDATE platform.export_job SET status = 'running', started_at = now()$q$, true);
SELECT pg_temp.expect_error($$DELETE FROM platform.export_job$$, 'F4 app_rw still cannot DELETE export jobs', '%permission denied%');
SELECT pg_temp.check(NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'masters.item'::regclass AND confrelid = 'masters.hsn_code'::regclass)
                 AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hsn_code_tenant_code_uq')
                 AND (SELECT hsn FROM masters.item WHERE id = '00000000-0000-0000-0000-000000000901') = '7113'
                 AND (SELECT hsn FROM masters.item WHERE id = '00000000-0000-0000-0000-000000000902') = '7113',
  'F5 items untouched by 983: no item->hsn_code FK, no extra hsn_code key, seeded items keep hsn 7113');
SELECT pg_temp.check((SELECT count(*) FROM platform.hsn_code_default) = 12
                 AND (SELECT count(*) FROM platform.hsn_code_default WHERE code_type = 'SAC') = 1
                 AND NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'platform.hsn_code_default'::regclass AND attname ~ 'rate' AND NOT attisdropped)
                 AND (SELECT count(*) FROM platform.hsn_code_default d JOIN masters.tax_rule t ON t.code_type = d.code_type AND t.hsn_sac = d.code
                      WHERE d.code = '7113') >= 1,
  'F6 platform.hsn_code_default: 11 HSN + 1 SAC, no rate column, joins tax_rule by code_type+code');
SELECT pg_temp.expect_error($$INSERT INTO masters.kyc_document(tenant_id, party_type, customer_id, doc_type, front_file_id)
  VALUES (platform.current_tenant(), 'customer', '00000000-0000-0000-0000-000000000d01', 'aadhaar', '00000000-0000-0000-0000-0000000f9003')$$,
  'F8 aadhaar KYC document rejected (983)', '%kyc_document_doc_type_check%');
DO $$
DECLARE t text; n int := 0;
BEGIN
  FOREACH t IN ARRAY ARRAY['pan','passport','voter_id','driving_licence','gstin_certificate','other'] LOOP
    INSERT INTO masters.kyc_document(tenant_id, party_type, customer_id, doc_type, front_file_id)
    VALUES (platform.current_tenant(), 'customer', '00000000-0000-0000-0000-000000000d01', t, '00000000-0000-0000-0000-0000000f9003');
    n := n + 1;
  END LOOP;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'kyc_document_doc_type_check')
     <> 'CHECK ((doc_type = ANY (ARRAY[''pan''::text, ''passport''::text, ''voter_id''::text, ''driving_licence''::text, ''gstin_certificate''::text, ''other''::text])))' THEN
    RAISE EXCEPTION 'FAIL  F9 doc_type list: %', (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'kyc_document_doc_type_check');
  END IF;
  RAISE NOTICE 'PASS  F9 each allowed KYC type accepted (% types) and the list is exactly pan/passport/voter_id/driving_licence/gstin_certificate/other', n;
END $$;
SELECT pg_temp.check(NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attname = 'aadhaar_last4' AND NOT attisdropped
                                   AND attrelid IN ('masters.customer'::regclass,'hr.staff'::regclass,'masters.vendor'::regclass))
                 AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname IN ('customer_aadhaar_last4_check','staff_aadhaar_last4_check','vendor_aadhaar_last4_check')),
  'A1 984: aadhaar_last4 and its format checks gone from customer, staff and vendor');
SELECT pg_temp.expect_error($$UPDATE masters.customer SET aadhaar_last4 = '1234'$$, 'A2 writing aadhaar_last4 now fails (column gone)', '%column "aadhaar_last4"%does not exist%');
SELECT pg_temp.check((SELECT string_agg(role_code, ',' ORDER BY role_code) FROM platform.system_role_permission WHERE permission_code = 'masters.kyc.reveal') = 'manager,owner'
                 AND (SELECT module FROM platform.permission WHERE code = 'masters.kyc.reveal') = 'masters',
  'A3 masters.kyc.reveal exists; owner+manager only (salesperson/cashier do not)');
SELECT pg_temp.check(pg_temp.cols('hr.staff', ARRAY['department','designation']) = 'department:text,designation:text', 'A4 hr.staff free-text department/designation (nullable text)');
SELECT pg_temp.expect_error($$UPDATE hr.staff SET department = repeat('x', 101) WHERE code = 'SP-01'$$, 'A5 department max 100 chars', '%staff_department_len%');
SELECT pg_temp.expect_error($$UPDATE hr.staff SET designation = '' WHERE code = 'SP-01'$$, 'A5 designation not empty', '%staff_designation_len%');
WITH u AS (UPDATE hr.staff SET department = 'Sales', designation = 'Senior salesperson' WHERE code = 'SP-01' RETURNING department, designation)
  SELECT pg_temp.check((SELECT department || '/' || designation FROM u) = 'Sales/Senior salesperson', 'A6 app_rw writes department/designation');
SELECT pg_temp.check(NOT EXISTS (
         SELECT 1 FROM pg_attribute att, aclexplode(att.attacl) a
         WHERE att.attrelid = 'hr.staff'::regclass AND att.attname = 'name' AND a.privilege_type = 'SELECT' AND a.grantee <> 0
           AND a.grantee::regrole::text NOT IN ('app_rw','app_migrator')
           AND NOT (has_column_privilege(a.grantee, 'hr.staff'::regclass, 'department', 'SELECT') AND has_column_privilege(a.grantee, 'hr.staff'::regclass, 'designation', 'SELECT')))
                 AND has_column_privilege('app_ro', 'hr.staff', 'designation', 'SELECT') AND NOT has_column_privilege('app_ro', 'hr.staff', 'pan_enc', 'SELECT'),
  'A7 every staff reader (app_ro, sales_writer, ...) reads department/designation; PAN ciphertext still hidden');
SELECT pg_temp.check((SELECT data_type FROM information_schema.columns WHERE table_schema = 'platform' AND table_name = 'audit_event' AND column_name = 'action') = 'text'
                 AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'platform.audit_event'::regclass AND contype = 'c')
                 AND has_function_privilege('app_rw', 'platform.audit_append(uuid,text,text,uuid,jsonb,jsonb)', 'EXECUTE'),
  'A8 audit_event.action is free text (no CHECK) and app_rw may call platform.audit_append');
SELECT platform.audit_append(platform.current_tenant(), 'kyc.reveal', 'masters.kyc_document', '00000000-0000-0000-0000-0000000ec001', NULL,
       jsonb_build_object('field', 'number', 'reason', 'customer verification at counter')) AS reveal_seq \gset
SELECT pg_temp.check((SELECT action = 'kyc.reveal' AND table_name = 'masters.kyc_document' AND row_id = '00000000-0000-0000-0000-0000000ec001'
                             AND user_id = '00000000-0000-0000-0000-000000000a01' AND old_row IS NULL AND new_row = '{"field": "number", "reason": "customer verification at counter"}'
                      FROM platform.audit_event WHERE tenant_id = platform.current_tenant() AND seq = :reveal_seq),
  'A9 app_rw records a kyc.reveal event (table, row, field, user; no secret value) in the hash chain');
SELECT pg_temp.expect_error($$SELECT platform.audit_append('00000000-0000-0000-0000-000000000002', 'kyc.reveal', 'masters.kyc_document', NULL, NULL, '{}')$$,
  'A10 reveal event cannot be written for another tenant', '%audit tenant mismatch%');
SELECT pg_temp.expect_error($$INSERT INTO platform.hsn_code_default(code_type, code, description, sort_order) VALUES ('HSN','7116','x',1)$$,
  'F7 app_rw cannot change the global HSN default list', '%permission denied%');

-- ===== conventions across all 976–981 tables =====
SELECT pg_temp.check(NOT EXISTS (
         SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_temp%' AND n.nspname NOT LIKE 'pg_toast%'
           AND p.proname ~ '(design|kyc|hsn|payment_mode|card_machine|export_job|opening_metal|stone_rate)'),
  'Z1 no new DB functions for the masters scope (business logic in the app)');
SELECT pg_temp.check((SELECT bool_and(format_type(a.atttypid, a.atttypmod) = 'uuid' AND pg_get_expr(d.adbin, d.adrelid) = 'platform.uuid_v7()')
                      FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                      WHERE a.attname = 'id' AND a.attrelid IN ('masters.design'::regclass,'masters.design_photo'::regclass,'masters.kyc_document'::regclass,
                            'accounts.party_opening_metal'::regclass,'masters.hsn_code'::regclass,'masters.payment_mode'::regclass,'masters.card_machine'::regclass,'platform.export_job'::regclass))
                 AND (SELECT count(*) FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum WHERE a.attname = 'id' AND a.attrelid IN ('masters.design'::regclass,'masters.design_photo'::regclass,'masters.kyc_document'::regclass,
                            'accounts.party_opening_metal'::regclass,'masters.hsn_code'::regclass,'masters.payment_mode'::regclass,'masters.card_machine'::regclass,'platform.export_job'::regclass)) = 8,
  'Z2 every new table uses uuid ids defaulting to platform.uuid_v7()');
\echo '--- 985 rates scope'
SELECT pg_temp.check(pg_temp.cols('rates.metal_rate', ARRAY['derived_from_id','derived_rate_per_g']) = 'derived_from_id:uuid,derived_rate_per_g:numeric(14,2)'
                 AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'rates' AND table_name = 'metal_rate' AND column_name = 'effective_to'),
  'R1/R2 metal_rate gains derived_from_id + derived_rate_per_g numeric(14,2); no effective_to');
INSERT INTO rates.metal_rate(tenant_id, id, purity_id, kind, rate_date, rate_per_g, derived_from_id, derived_rate_per_g)
SELECT platform.current_tenant(), '00000000-0000-0000-0000-0000000985a1', purity_id, 'sale', rate_date, 6450, id, 6416.00
FROM rates.metal_rate WHERE kind = 'sale' AND rate_date = (now() AT TIME ZONE 'Asia/Kolkata')::date ORDER BY effective_from LIMIT 1;
SELECT pg_temp.check((SELECT rate_per_g <> derived_rate_per_g FROM rates.metal_rate WHERE id = '00000000-0000-0000-0000-0000000985a1'),
  'R2 derived rate stored with its base row; edited value kept alongside the computed one');
SELECT pg_temp.expect_error($$INSERT INTO rates.metal_rate(tenant_id, purity_id, kind, rate_date, rate_per_g, derived_rate_per_g)
  VALUES (platform.current_tenant(), '00000000-0000-0000-0000-000000000022', 'sale', current_date, 1, 1)$$, 'R2 derived value needs its base row', '%metal_rate_derived_chk%');
SELECT pg_temp.expect_error($$INSERT INTO rates.metal_rate(tenant_id, purity_id, kind, rate_date, rate_per_g, derived_from_id, derived_rate_per_g)
  VALUES (platform.current_tenant(), '00000000-0000-0000-0000-000000000022', 'sale', current_date, 1, '00000000-0000-0000-0000-00000000dead', 1)$$, 'R2 base row must exist in the shop', '%metal_rate_derived_from_fk%');
SELECT pg_temp.expect_error($$UPDATE rates.metal_rate SET rate_per_g = 1 WHERE id = '00000000-0000-0000-0000-0000000985a1'$$, 'R4 rates are insert-only (history kept)', '%permission denied%');
SELECT pg_temp.check(EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'rates.metal_rate'::regclass AND tgname = 'zz_audit')
                 AND (SELECT relforcerowsecurity FROM pg_class WHERE oid = 'rates.metal_rate'::regclass)
                 AND (SELECT count(*) FROM pg_policy WHERE polrelid = 'rates.metal_rate'::regclass AND polname IN ('tenant_isolation','no_partner_access','branch_scope')) = 3,
  'R3/R4 metal_rate audited, forced RLS with tenant_isolation, no_partner_access, branch_scope (shop-wide rows stay visible)');
SELECT pg_temp.check((SELECT string_agg(role_code, ',' ORDER BY role_code) FROM platform.system_role_permission WHERE permission_code = 'rates.edit') = 'manager,owner',
  'R6 rates.edit (rate change) for owner + manager only');
SELECT pg_temp.check(pg_temp.cols('rates.v_todays_rate_status') = 'tenant_id:uuid,branch_id:uuid,todays_rate_set:boolean,missing_metal_codes:text[],old_metal_rate_set:boolean,missing_old_metal_codes:text[]',
  'R9 rates.v_todays_rate_status columns');
SELECT pg_temp.check((SELECT todays_rate_set AND missing_metal_codes = '{}' AND old_metal_rate_set FROM rates.v_todays_rate_status WHERE branch_id = '00000000-0000-0000-0000-00000000b001')
                 AND (SELECT todays_rate_set AND billing_unlocked FROM platform.v_billing_unlocked),
  'R9 one branch, GOLD shop-wide sale + old_metal today: branch set, shop unlocked');
INSERT INTO platform.branch(tenant_id, id, company_id, code, name, bill_series_prefix, state_code) VALUES
 (platform.current_tenant(), '00000000-0000-0000-0000-00000000b985', '00000000-0000-0000-0000-00000000c001', 'TPR', 'Tiruppur', 'TPR', '33');
-- SILVER exists (MV9) with no purity, so it is not yet a metal the shop sells; adding an active purity makes it one
SELECT pg_temp.check((SELECT bool_and(todays_rate_set) FROM rates.v_todays_rate_status), 'R9 active metal without an active purity is not required');
INSERT INTO masters.purity(tenant_id, id, metal_id, code, fineness, huid_required)
SELECT platform.current_tenant(), '00000000-0000-0000-0000-000000098925', id, '925', 925, false FROM masters.metal WHERE code = 'SILVER';
SELECT pg_temp.check((SELECT count(*) FILTER (WHERE NOT todays_rate_set AND missing_metal_codes = '{SILVER}') FROM rates.v_todays_rate_status) = 2
                 AND (SELECT NOT todays_rate_set AND NOT billing_unlocked AND missing_steps = '{todays_rates}' FROM platform.v_billing_unlocked),
  'R9 new active metal without a rate: both branches locked listing SILVER; shop locked, todays_rates missing');
INSERT INTO rates.metal_rate(tenant_id, branch_id, purity_id, kind, rate_date, rate_per_g)
VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b985', '00000000-0000-0000-0000-000000098925', 'sale', (now() AT TIME ZONE 'Asia/Kolkata')::date, 99);
SELECT pg_temp.check((SELECT todays_rate_set AND missing_metal_codes = '{}' FROM rates.v_todays_rate_status WHERE branch_id = '00000000-0000-0000-0000-00000000b985')
                 AND (SELECT NOT todays_rate_set AND missing_metal_codes = '{SILVER}' FROM rates.v_todays_rate_status WHERE branch_id = '00000000-0000-0000-0000-00000000b001')
                 AND (SELECT NOT billing_unlocked FROM platform.v_billing_unlocked),
  'R9 branch override covers SILVER for that branch only; other branch still missing; shop still locked');
SELECT pg_temp.check((SELECT todays_rate_set FROM rates.v_todays_rate_status WHERE branch_id = '00000000-0000-0000-0000-00000000b985')
                 AND (SELECT count(*) FROM rates.v_todays_rate_status) = 2, 'R9 per-branch view honours forced RLS / branch rows of this shop only');
INSERT INTO rates.metal_rate(tenant_id, purity_id, kind, rate_date, rate_per_g)
VALUES (platform.current_tenant(), '00000000-0000-0000-0000-000000098925', 'sale', (now() AT TIME ZONE 'Asia/Kolkata')::date, 97.50);
SELECT pg_temp.check((SELECT bool_and(todays_rate_set) AND bool_and(NOT old_metal_rate_set AND missing_old_metal_codes = '{SILVER}') FROM rates.v_todays_rate_status)
                 AND (SELECT todays_rate_set AND billing_unlocked AND missing_steps = '{}' FROM platform.v_billing_unlocked),
  'R9 all branches set: unlocked; missing SILVER old_metal rate is only reported (old_metal_rate_set false)');
UPDATE masters.metal SET is_active = false WHERE code = 'SILVER';
SELECT pg_temp.check((SELECT bool_and(old_metal_rate_set) FROM rates.v_todays_rate_status), 'R9 inactive metal is ignored');
UPDATE masters.metal SET is_active = true WHERE code = 'SILVER';
SELECT pg_temp.check((SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute WHERE attrelid = 'platform.v_billing_unlocked'::regclass AND attnum > 0)
                     = '{tenant_id,missing_steps,billing_unlocked,todays_rate_set}', 'R9 view keeps its columns, appends todays_rate_set');
SELECT pg_temp.check(NOT EXISTS (SELECT 1 FROM pg_class c, aclexplode(c.relacl) a WHERE c.oid = 'platform.v_billing_unlocked'::regclass AND a.grantee NOT IN (0, c.relowner)
                                 AND NOT (has_table_privilege(a.grantee, 'rates.v_todays_rate_status', 'SELECT') AND has_table_privilege(a.grantee, 'rates.metal_rate', 'SELECT')
                                          AND has_column_privilege(a.grantee, 'masters.metal', 'code', 'SELECT') AND has_column_privilege(a.grantee, 'masters.metal', 'is_active', 'SELECT')
                                          AND has_column_privilege(a.grantee, 'masters.purity', 'metal_id', 'SELECT') AND has_column_privilege(a.grantee, 'masters.purity', 'is_active', 'SELECT')
                                          AND has_table_privilege(a.grantee, 'platform.branch', 'SELECT'))),
  'R9 every v_billing_unlocked reader can read v_todays_rate_status and its tables');
SELECT pg_temp.check(NOT has_table_privilege('accounts_writer', 'masters.metal', 'SELECT') AND NOT has_column_privilege('accounts_writer', 'masters.metal', 'name', 'SELECT')
                 AND NOT has_column_privilege('accounts_writer', 'masters.purity', 'fineness', 'SELECT'),
  'R9 accounts_writer gets only the 4+4 metal/purity columns the view needs');
INSERT INTO branding.print_template(scope, tenant_id, doc_type, version, body_key, paper, is_active)
VALUES ('tenant', platform.current_tenant(), 'rate_card', 1, 'tpl/t1/rate-card-v1.hbs', 'A4', true);
SELECT pg_temp.check((SELECT count(*) FROM branding.print_template WHERE doc_type = 'rate_card' AND is_active) = 1, 'R11 rate card is a print_template kind');
SELECT pg_temp.expect_error($$INSERT INTO branding.print_template(scope, tenant_id, doc_type, version, body_key) VALUES ('tenant', platform.current_tenant(), 'rate_board', 1, 'x')$$,
  'R11 unknown doc_type still rejected', '%print_template_doc_type_check%');
SET app.tenant_id = '00000000-0000-0000-0000-000000000002';
INSERT INTO platform.onboarding_progress(tenant_id, step, status, completed_at)
SELECT platform.current_tenant(), code, 'completed', now() FROM platform.onboarding_step WHERE required_for_billing ON CONFLICT DO NOTHING;
SELECT pg_temp.check((SELECT NOT billing_unlocked AND NOT todays_rate_set AND missing_steps = '{todays_rates}' FROM platform.v_billing_unlocked),
  'R9 all wizard steps done but no rate today: billing stays locked, todays_rates listed');
SET app.tenant_id = '00000000-0000-0000-0000-000000000001';
\echo '--- 986 backend gaps'
INSERT INTO platform.rate_limit_bucket(bucket_key, window_start, count)
VALUES ('kyc.reveal:00000000-0000-0000-0000-000000000001:00000000-0000-0000-0000-000000000a01', date_trunc('minute', now()), 1);
SELECT pg_temp.check((SELECT count FROM platform.rate_limit_bucket WHERE bucket_key LIKE 'kyc.reveal:%') = 1, 'B1 kyc.reveal:<tenant>:<user> bucket accepted');
SELECT pg_temp.expect_error($$INSERT INTO platform.rate_limit_bucket(bucket_key, window_start) VALUES ('kyc.reveal:-:00000000-0000-0000-0000-000000000a01', now())$$, 'B1 kyc.reveal needs a tenant uuid', '%bucket_key_check%');
SELECT pg_temp.expect_error($$INSERT INTO platform.rate_limit_bucket(bucket_key, window_start) VALUES ('kyc.reveal:00000000-0000-0000-0000-000000000001:' || encode(sha256('x'),'hex'), now())$$, 'B1 kyc.reveal second part must be a uuid, not a hash', '%bucket_key_check%');
SELECT pg_temp.expect_error($$INSERT INTO platform.rate_limit_bucket(bucket_key, window_start) VALUES ('kyc.reveal:00000000-0000-0000-0000-000000000001:00000000-0000-0000-0000-000000000a01:ABCD1234F', now())$$, 'B1 no trailing payload (no PAN in keys)', '%bucket_key_check%');
SELECT pg_temp.expect_error($$INSERT INTO platform.rate_limit_bucket(bucket_key, window_start) VALUES ('kyc.peek:00000000-0000-0000-0000-000000000001:00000000-0000-0000-0000-000000000a01', now())$$, 'B1 other prefixes still rejected', '%bucket_key_check%');
INSERT INTO platform.rate_limit_bucket(bucket_key, window_start) VALUES ('otp.verify:-:00000000-0000-0000-0000-000000000a01', date_trunc('minute', now()));
SELECT pg_temp.check(true, 'B1 existing login/otp key forms still accepted');
SELECT pg_temp.check(has_column_privilege('app_rw', 'platform.file', 'deleted_at', 'UPDATE') AND NOT has_column_privilege('app_rw', 'platform.file', 'original_name', 'UPDATE')
                 AND NOT has_table_privilege('app_rw', 'platform.file', 'DELETE'), 'B2 app_rw has UPDATE(deleted_at) on platform.file (974), nothing else');
SELECT pg_temp.check(col_description('hr.staff'::regclass, (SELECT attnum FROM pg_attribute WHERE attrelid = 'hr.staff'::regclass AND attname = 'department_id')) LIKE 'DEPRECATED%'
                 AND col_description('hr.staff'::regclass, (SELECT attnum FROM pg_attribute WHERE attrelid = 'hr.staff'::regclass AND attname = 'designation_id')) LIKE 'DEPRECATED%'
                 AND pg_temp.cols('hr.staff', ARRAY['department_id','designation_id']) = 'department_id:uuid,designation_id:uuid', 'B3 staff department_id/designation_id kept, marked deprecated');
SELECT pg_temp.check(pg_temp.cols('accounts.cash_counter', ARRAY['is_active']) = 'is_active:boolean:NN' AND pg_temp.cols('hr.department', ARRAY['is_active']) = 'is_active:boolean:NN'
                 AND pg_temp.cols('hr.designation', ARRAY['is_active']) = 'is_active:boolean:NN'
                 AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'customer_group' AND column_name = 'is_active' AND table_schema = 'masters'),
  'B4 is_active NOT NULL on cash_counter, department, designation (customer_group untouched)');
WITH d AS (INSERT INTO hr.department(tenant_id, name) VALUES (platform.current_tenant(), 'Billing 986') RETURNING is_active),
     g AS (INSERT INTO hr.designation(tenant_id, name) VALUES (platform.current_tenant(), 'Cashier 986') RETURNING is_active),
     c AS (INSERT INTO accounts.cash_counter(tenant_id, branch_id, name) VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', 'Counter 986') RETURNING is_active)
SELECT pg_temp.check((SELECT is_active FROM d) AND (SELECT is_active FROM g) AND (SELECT is_active FROM c), 'B4 new rows default active');
WITH u AS (UPDATE hr.department SET is_active = false WHERE name = 'Billing 986' RETURNING is_active)
SELECT pg_temp.check((SELECT NOT is_active FROM u) AND has_column_privilege('app_ro', 'hr.department', 'is_active', 'SELECT')
                 AND has_column_privilege('app_ro', 'accounts.cash_counter', 'is_active', 'SELECT'), 'B4 app_rw deactivates; app_ro reads is_active');
SELECT pg_temp.expect_error($$UPDATE hr.designation SET is_active = NULL$$, 'B4 is_active not null', '%null value%');
INSERT INTO platform.import_mapping_profile(tenant_id, kind, name, mapping) VALUES (platform.current_tenant(), 'floors', 'Floor sheet', '{"Floor":"name"}');
INSERT INTO platform.import_job(tenant_id, kind, file_key, created_by) VALUES (platform.current_tenant(), 'floors', 'imports/t1/floors.xlsx', '00000000-0000-0000-0000-000000000a01'),
                                                                              (platform.current_tenant(), 'bank_accounts', 'imports/t1/banks.xlsx', '00000000-0000-0000-0000-000000000a01');
SELECT pg_temp.check((SELECT count(*) FROM platform.import_job WHERE kind IN ('floors','bank_accounts')) = 2, 'B5 import kinds floors + bank_accounts accepted');
WITH e AS (INSERT INTO platform.export_job(tenant_id, kind, format, created_by) VALUES (platform.current_tenant(), 'floors', 'csv', '00000000-0000-0000-0000-000000000a01') RETURNING kind)
SELECT pg_temp.check((SELECT kind FROM e) = 'floors', 'B5 export kind floors accepted');
SELECT pg_temp.expect_error($$INSERT INTO platform.export_job(tenant_id, kind, created_by) VALUES (platform.current_tenant(), 'floor', '00000000-0000-0000-0000-000000000a01')$$, 'B5 unknown export kind still rejected', '%export_job_kind_check%');
SELECT pg_temp.expect_error($$INSERT INTO platform.import_mapping_profile(tenant_id, kind, name, mapping) VALUES (platform.current_tenant(), 'floor', 'x', '{}')$$, 'B5 unknown kind still rejected', '%import_mapping_profile_kind_check%');
\echo 'ALL MASTERS (976–981) TESTS DONE'
