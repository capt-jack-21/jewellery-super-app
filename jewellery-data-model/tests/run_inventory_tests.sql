-- 987–990 inventory scope (Adithya GO 2026-11-05; 990 scan outcomes). Run as app_rw after run_masters_tests.sql. TEST DB ONLY until 990 is on dev.
-- Helpers copied from run_masters_tests.sql (pg_temp is per session).
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
-- acl equality against an explicit list
CREATE FUNCTION pg_temp.acl_is(p_tbl regclass, p_expected text[]) RETURNS boolean LANGUAGE sql AS $$
  SELECT pg_temp.acl(p_tbl) IS NOT DISTINCT FROM (SELECT string_agg(x, ',' ORDER BY x) FROM unnest(p_expected) x) $$;
CREATE FUNCTION pg_temp.writers_select() RETURNS text[] LANGUAGE sql AS $$
  SELECT ARRAY['sales_writer:SELECT','inventory_writer:SELECT','orders_writer:SELECT','purchases_writer:SELECT','refinery_writer:SELECT'] $$;
-- tag fixture (hallmark-exempt so the HUID index is not involved)
CREATE FUNCTION pg_temp.mk_tag(p_id text, p_no text, p_branch text, p_purity text, p_gross numeric, p_net numeric,
                               p_counter text DEFAULT NULL, p_box text DEFAULT NULL, p_status text DEFAULT 'in_stock',
                               p_received date DEFAULT NULL, p_lot_line text DEFAULT NULL) RETURNS void LANGUAGE sql AS $$
  INSERT INTO inventory.tag(tenant_id, id, branch_id, tag_no, item_id, purity_id, hallmark_exempt, gross_wt, net_wt, mc_type,
                            counter_id, box_id, status, received_on, lot_line_id)
  VALUES (platform.current_tenant(), p_id::uuid, p_branch::uuid, p_no, '00000000-0000-0000-0000-000000000901', p_purity::uuid, true,
          p_gross, p_net, 'per_gram', p_counter::uuid, p_box::uuid, p_status, p_received, p_lot_line::uuid) $$;
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-000000000001',false),
       set_config('app.user_id','00000000-0000-0000-0000-000000000a01',false),
       set_config('app.partner_id','',false), set_config('app.branch_scope','',false) \g /dev/null

\echo '--- 987–990 inventory scope'
-- fixtures (tenant 1): second branch MDU, counters IV1/IV2 (CBE), IV3 (MDU), IV4 (CBE, stock check only), trays, purities G750 (active, rated) + G585 (inactive, no rate)
INSERT INTO platform.branch(tenant_id, id, company_id, code, name, bill_series_prefix, state_code) VALUES
 (platform.current_tenant(), '00000000-0000-0000-0000-00000000b987', '00000000-0000-0000-0000-00000000c001', 'MDU', 'Madurai', 'MDU', '33');
INSERT INTO masters.counter(tenant_id, id, branch_id, code, name) VALUES
 (platform.current_tenant(), '00000000-0000-0000-0000-0000000c9871', '00000000-0000-0000-0000-00000000b001', 'IV1', 'Inv one'),
 (platform.current_tenant(), '00000000-0000-0000-0000-0000000c9872', '00000000-0000-0000-0000-00000000b001', 'IV2', 'Inv two'),
 (platform.current_tenant(), '00000000-0000-0000-0000-0000000c9873', '00000000-0000-0000-0000-00000000b987', 'IV3', 'Inv three'),
 (platform.current_tenant(), '00000000-0000-0000-0000-0000000c9874', '00000000-0000-0000-0000-00000000b001', 'IV4', 'Inv four');
INSERT INTO masters.box(tenant_id, id, counter_id, code, name) VALUES
 (platform.current_tenant(), '00000000-0000-0000-0000-0000000b9871', '00000000-0000-0000-0000-0000000c9871', 'TR-IV1', 'Tray one'),
 (platform.current_tenant(), '00000000-0000-0000-0000-0000000b9872', '00000000-0000-0000-0000-0000000c9872', 'TR-IV2', 'Tray two');
INSERT INTO masters.purity(tenant_id, id, metal_id, code, fineness, huid_required, is_active) VALUES
 (platform.current_tenant(), '00000000-0000-0000-0000-0000000987a8', '00000000-0000-0000-0000-0000000000e1', 'G750', 750, true, true),
 (platform.current_tenant(), '00000000-0000-0000-0000-0000000985a8', '00000000-0000-0000-0000-0000000000e1', 'G585', 585, true, false);
INSERT INTO rates.metal_rate(tenant_id, branch_id, purity_id, kind, rate_date, rate_per_g) VALUES
 (platform.current_tenant(), NULL, '00000000-0000-0000-0000-0000000987a8', 'sale', (now() AT TIME ZONE 'Asia/Kolkata')::date, 5000),
 (platform.current_tenant(), NULL, '00000000-0000-0000-0000-0000000987a8', 'old_metal', (now() AT TIME ZONE 'Asia/Kolkata')::date, 4800),
 (platform.current_tenant(), '00000000-0000-0000-0000-00000000b987', '00000000-0000-0000-0000-0000000987a8', 'sale', (now() AT TIME ZONE 'Asia/Kolkata')::date, 5100);

\echo '--- shop settings (tag format, approver, toggles)'
SELECT pg_temp.check(pg_temp.cols('inventory.shop_setting') = 'tenant_id:uuid:NN,id:uuid:NN,tag_prefix:character varying(8):NN,tag_separator:character varying(1):NN,'
  || 'tag_branch_segment:boolean:NN,tag_item_segment:boolean:NN,tag_segment_order:text:NN,tag_start_no:bigint:NN,tag_digits:smallint:NN,'
  || 'transfer_no_format:text:NN,adjustment_no_format:text:NN,adjustment_approver:text:NN,photos_enabled:boolean:NN,ageing_enabled:boolean:NN,ageing_bucket_days:integer[]:NN,updated_by:uuid,updated_at:timestamp with time zone:NN,version:integer:NN',
  'IS0 inventory.shop_setting columns');
SELECT pg_temp.check((SELECT pg_get_expr(adbin, adrelid) FROM pg_attrdef WHERE adrelid = 'inventory.shop_setting'::regclass AND adnum = (SELECT attnum FROM pg_attribute WHERE attrelid = 'inventory.shop_setting'::regclass AND attname = 'transfer_no_format')) = '''TRF-{BRANCH}-{FY}-{SEQ:5}''::text'
                 AND (SELECT pg_get_expr(adbin, adrelid) FROM pg_attrdef WHERE adrelid = 'inventory.shop_setting'::regclass AND adnum = (SELECT attnum FROM pg_attribute WHERE attrelid = 'inventory.shop_setting'::regclass AND attname = 'adjustment_no_format')) = '''ADJ-{BRANCH}-{FY}-{SEQ:5}''::text',
  'NF1 transfer_no_format / adjustment_no_format defaults TRF-/ADJ-{BRANCH}-{FY}-{SEQ:5}');
SELECT pg_temp.expect_error($$INSERT INTO inventory.shop_setting(tenant_id, transfer_no_format) VALUES (platform.current_tenant(), repeat('X', 65) || '{SEQ:5}')$$,
  'NF2 transfer_no_format length capped at 64', '%shop_setting_transfer_no_format_check%');
SELECT pg_temp.expect_error($$INSERT INTO inventory.shop_setting(tenant_id, adjustment_no_format) VALUES (platform.current_tenant(), '')$$,
  'NF2 adjustment_no_format cannot be empty', '%shop_setting_adjustment_no_format_check%');
SELECT pg_temp.expect_error($$INSERT INTO inventory.shop_setting(tenant_id, adjustment_no_format) VALUES (platform.current_tenant(), 'ADJ-{BRANCH}')$$,
  'NF2 a number format must contain a {SEQ} / {SEQ:n} token', '%shop_setting_adjustment_no_format_check%');
SELECT pg_temp.lifecycle('IS1', 'inventory.shop_setting',
  $q$INSERT INTO inventory.shop_setting(tenant_id) VALUES (platform.current_tenant())$q$,
  $q$UPDATE inventory.shop_setting SET updated_by = '00000000-0000-0000-0000-000000000a01'$q$, true);
SELECT pg_temp.check((SELECT tag_prefix = 'T' AND tag_separator = '' AND tag_start_no = 1 AND tag_digits = 6 AND NOT tag_branch_segment AND NOT tag_item_segment
                        AND adjustment_approver = 'owner_or_manager' AND NOT photos_enabled AND NOT ageing_enabled AND ageing_bucket_days = '{30,90,180,365}'
                      FROM inventory.shop_setting), 'IS2 defaults: T + 6 digits from 1, owner_or_manager approver, photos off, ageing off, buckets 30/90/180/365');
SELECT pg_temp.expect_error($$INSERT INTO inventory.shop_setting(tenant_id) VALUES (platform.current_tenant())$$, 'IS3 one settings row per shop', '%shop_setting_one_per_shop%');
SELECT pg_temp.expect_error($$UPDATE inventory.shop_setting SET tag_prefix = 'ab'$$, 'IS4 prefix upper-case A-Z0-9 only', '%shop_setting_tag_prefix_check%');
SELECT pg_temp.expect_error($$UPDATE inventory.shop_setting SET tag_separator = '_'$$, 'IS4 separator in '''', -, /', '%shop_setting_tag_separator_check%');
SELECT pg_temp.expect_error($$UPDATE inventory.shop_setting SET tag_digits = 13$$, 'IS4 digit count 1..12', '%shop_setting_tag_digits_check%');
SELECT pg_temp.expect_error($$UPDATE inventory.shop_setting SET tag_digits = 3, tag_start_no = 1000$$, 'IS4 start number must fit the digit count', '%shop_setting_tag_start_fits%');
SELECT pg_temp.expect_error($$UPDATE inventory.shop_setting SET adjustment_approver = 'anyone'$$, 'IS5 approver owner_only | owner_or_manager', '%shop_setting_adjustment_approver_check%');
SELECT pg_temp.expect_error($$UPDATE inventory.shop_setting SET ageing_bucket_days = '{}'$$, 'IS6 at least one ageing bucket', '%shop_setting_ageing_buckets_check%');
SELECT pg_temp.expect_error($$UPDATE inventory.shop_setting SET ageing_bucket_days = '{0,30}'$$, 'IS6 bucket bounds >= 1 day', '%shop_setting_ageing_buckets_check%');
SELECT pg_temp.expect_error($$UPDATE inventory.shop_setting SET ageing_bucket_days = '{30,NULL}'$$, 'IS6 no NULL bucket bound', '%shop_setting_ageing_buckets_check%');
SELECT pg_temp.expect_error($$UPDATE inventory.shop_setting SET ageing_bucket_days = '{1,2,3,4,5,6,7,8,9}'$$, 'IS6 at most 8 buckets', '%shop_setting_ageing_buckets_check%');
WITH u AS (UPDATE inventory.shop_setting SET adjustment_approver = 'owner_only' RETURNING adjustment_approver, version)
SELECT pg_temp.check((SELECT adjustment_approver = 'owner_only' AND version = 3 FROM u), 'IS7 owner-only adjustment approval setting stored (version bumped)');
SELECT pg_temp.check((SELECT array_agg(role_code ORDER BY role_code) FROM platform.system_role_permission WHERE permission_code = 'inventory.settings.edit') = '{owner}',
  'IS8 inventory.settings.edit (who may change the approver/format/toggles) is owner-only');

\echo '--- tag numbering: counter + uniqueness + format change'
SELECT pg_temp.check(pg_temp.cols('inventory.tag_counter') = 'tenant_id:uuid:NN,scope_key:character varying(40):NN,next_no:bigint:NN,updated_at:timestamp with time zone:NN'
                 AND (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'inventory.tag_counter'::regclass)
                 AND (SELECT string_agg(polname, ',' ORDER BY polname) FROM pg_policy WHERE polrelid = 'inventory.tag_counter'::regclass) = 'no_partner_access,tenant_isolation'
                 AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'inventory.tag_counter'::regclass AND NOT tgisinternal),
  'TN1 tag_counter (tenant, scope_key) -> next_no; forced RLS; no triggers (doc_counter style)');
INSERT INTO inventory.tag_counter(tenant_id, scope_key, next_no) VALUES (platform.current_tenant(), 'T', 1) ON CONFLICT DO NOTHING;
WITH a AS (UPDATE inventory.tag_counter SET next_no = greatest(next_no, 1) + 3, updated_at = now()
           WHERE tenant_id = platform.current_tenant() AND scope_key = 'T' RETURNING next_no - 3 AS first_no)
SELECT pg_temp.check((SELECT first_no FROM a) = 1, 'TN2 block of 3 numbers allocated from 1 (UPDATE ... RETURNING)');
WITH a AS (UPDATE inventory.tag_counter SET next_no = greatest(next_no, 1) + 1 WHERE tenant_id = platform.current_tenant() AND scope_key = 'T' RETURNING next_no - 1 AS first_no)
SELECT pg_temp.check((SELECT first_no FROM a) = 4, 'TN2 next allocation continues at 4');
INSERT INTO inventory.tag_counter(tenant_id, scope_key, next_no) VALUES (platform.current_tenant(), 'T', 1) ON CONFLICT DO NOTHING;
SELECT pg_temp.check((SELECT next_no FROM inventory.tag_counter WHERE scope_key = 'T') = 5, 'TN2 ensure-row INSERT ... ON CONFLICT DO NOTHING keeps the counter');
SELECT pg_temp.expect_error($$INSERT INTO inventory.tag_counter(tenant_id, scope_key) VALUES (platform.current_tenant(), 'cbe x')$$, 'TN3 scope_key = rendered upper-case prefix', '%tag_counter_scope_key_check%');
SELECT pg_temp.expect_error($$UPDATE inventory.tag_counter SET next_no = 0$$, 'TN3 next_no >= 1', '%tag_counter_next_no_check%');
SELECT pg_temp.mk_tag('00000000-0000-0000-0000-00000098f001', 'T000001', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000987a8', 2.100, 2.000,
                      '00000000-0000-0000-0000-0000000c9871', '00000000-0000-0000-0000-0000000b9871');
SELECT pg_temp.mk_tag('00000000-0000-0000-0000-00000098f002', 'T000002', '00000000-0000-0000-0000-00000000b987', '00000000-0000-0000-0000-0000000987a8', 2.000, 2.000,
                      '00000000-0000-0000-0000-0000000c9873');
SELECT pg_temp.expect_error($$SELECT pg_temp.mk_tag('00000000-0000-0000-0000-00000098f0ff', 'T000001', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-000000000022', 1, 1)$$,
  'TN4 tag number unique per shop (23505 -> app skips the number)', '%tag_tenant_id_tag_no_key%');
SELECT pg_temp.check((SELECT array_agg(a.attname ORDER BY k.n) FROM pg_constraint c, unnest(c.conkey) WITH ORDINALITY k(attnum, n), pg_attribute a
                      WHERE c.conname = 'tag_tenant_id_tag_no_key' AND c.conrelid = 'inventory.tag'::regclass AND a.attrelid = c.conrelid AND a.attnum = k.attnum) = '{tenant_id,tag_no}',
  'TN4 uniqueness is (tenant_id, tag_no): per shop');
-- format change: CBE-RNG-000001 (branch + item segments, '-' separator); existing tags keep their stored text
UPDATE inventory.shop_setting SET tag_prefix = '', tag_separator = '-', tag_branch_segment = true, tag_item_segment = true, tag_start_no = 1, tag_digits = 6;
INSERT INTO inventory.tag_counter(tenant_id, scope_key, next_no) VALUES (platform.current_tenant(), 'CBE-RING-', 1) ON CONFLICT DO NOTHING;
WITH a AS (UPDATE inventory.tag_counter SET next_no = greatest(next_no, 1) + 1 WHERE tenant_id = platform.current_tenant() AND scope_key = 'CBE-RING-' RETURNING next_no - 1 AS n)
SELECT pg_temp.mk_tag('00000000-0000-0000-0000-00000098f003', 'CBE-RING-' || lpad(n::text, 6, '0'), '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000987a8', 1, 1) FROM a;
SELECT pg_temp.check((SELECT tag_no FROM inventory.tag WHERE id = '00000000-0000-0000-0000-00000098f003') = 'CBE-RING-000001'
                 AND (SELECT tag_no FROM inventory.tag WHERE id = '00000000-0000-0000-0000-00000098f001') = 'T000001'
                 AND (SELECT count(*) FROM inventory.tag_counter) = 2,
  'TN5 after a format change new tags use a new counter scope; old tag text unchanged (stored, never recomputed)');
-- format change back to 'T' + 4 digits collides with the seeded T0001/T0002: those numbers are skipped (gap-tolerant)
SELECT pg_temp.expect_error($$SELECT pg_temp.mk_tag('00000000-0000-0000-0000-00000098f0fe', 'T0001', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-000000000022', 1, 1)$$,
  'TN6 a format change that re-renders an existing tag number is rejected (unique), never duplicated', '%tag_tenant_id_tag_no_key%');
SELECT pg_temp.expect_error($$SELECT pg_temp.mk_tag('00000000-0000-0000-0000-00000098f0fd', repeat('X', 31), '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-000000000022', 1, 1)$$,
  'TN7 rendered tag text max 30 chars', '%too long%');
UPDATE inventory.shop_setting SET tag_prefix = 'T', tag_separator = '', tag_branch_segment = false, tag_item_segment = false;

\echo '--- tag attributes, status CHECK, label, versioning'
SELECT pg_temp.check(pg_temp.cols('inventory.tag', ARRAY['design_id','hsn','value_addition_rule_id','received_on','label_payload','label_printed_at','label_print_count','rfid_epc','version'])
  = 'design_id:uuid,hsn:character varying(8),value_addition_rule_id:uuid,received_on:date,label_payload:text,label_printed_at:timestamp with time zone,label_print_count:integer:NN,rfid_epc:character varying(32),version:integer:NN',
  'IT1 tag gains design, HSN, VA rule, received_on, label fields, rfid_epc (room), version');
SELECT pg_temp.check((SELECT relforcerowsecurity FROM pg_class WHERE oid = 'inventory.tag'::regclass)
                 AND (SELECT string_agg(polname, ',' ORDER BY polname) FROM pg_policy WHERE polrelid = 'inventory.tag'::regclass) = 'branch_scope,no_partner_access,tenant_isolation'
                 AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'inventory.tag'::regclass AND tgname = 'aa_version')
                 AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'inventory.tag'::regclass AND tgname = 'zz_audit'),
  'IT2 tag: forced RLS tenant_isolation + no_partner_access + branch_scope; aa_version + zz_audit');
SELECT pg_temp.check((SELECT version FROM inventory.tag WHERE id = '00000000-0000-0000-0000-00000098f001') = 1
                 AND (SELECT bool_and(version >= 1) FROM inventory.tag), 'IT3 new tag version 1; existing tags have a version');
WITH u AS (UPDATE inventory.tag SET label_printed_at = now(), label_print_count = label_print_count + 1, hsn = '711319', received_on = (now() AT TIME ZONE 'Asia/Kolkata')::date
           WHERE id = '00000000-0000-0000-0000-00000098f001' RETURNING version, label_print_count)
SELECT pg_temp.check((SELECT version = 2 AND label_print_count = 1 FROM u), 'IT3 app_rw records a label print / HSN / received date; version bumps to 2');
SELECT pg_temp.expect_error($$UPDATE inventory.tag SET version = 9 WHERE id = '00000000-0000-0000-0000-00000098f001'$$, 'IT3 app_rw cannot set tag version', '%permission denied%');
SELECT pg_temp.expect_error($$UPDATE inventory.tag SET hsn = '71A3' WHERE id = '00000000-0000-0000-0000-00000098f001'$$, 'IT4 tag HSN digits only', '%tag_hsn_check%');
SELECT pg_temp.expect_error($$UPDATE inventory.tag SET design_id = '00000000-0000-0000-0000-00000000dead' WHERE id = '00000000-0000-0000-0000-00000098f001'$$, 'IT4 design must exist in the shop', '%tag_design_fk%');
INSERT INTO masters.design(tenant_id, id, code, name, item_id) VALUES (platform.current_tenant(), '00000000-0000-0000-0000-0000000de987', 'IV-987', 'Inventory test ring', '00000000-0000-0000-0000-000000000901');
UPDATE inventory.tag SET design_id = '00000000-0000-0000-0000-0000000de987' WHERE id = '00000000-0000-0000-0000-00000098f001';
SELECT pg_temp.check((SELECT barcode_payload = 'T000001' AND item_code = 'RING' AND purity_code = 'G750' AND counter_code = 'IV1' AND tray_code = 'TR-IV1' AND hsn = '711319'
                             AND design_code = 'IV-987' AND label_print_count = 1
                      FROM inventory.v_tag_label WHERE tag_id = '00000000-0000-0000-0000-00000098f001'), 'IT5 v_tag_label: payload = tag_no, item/purity/design/counter/tray codes, HSN');
SELECT pg_temp.expect_error($$SELECT pg_temp.mk_tag('00000000-0000-0000-0000-00000098f0fc', 'TX-BAD', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-000000000022', 1, 1, NULL, NULL, 'available')$$,
  'IT6 status CHECK rejects unknown status (available is stored as in_stock)', '%tag_status_check%');
SELECT pg_temp.mk_tag('00000000-0000-0000-0000-00000098f004', 'TX-REP', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000987a8', 1, 1, NULL, NULL, 'repair');
SELECT pg_temp.check((SELECT string_agg(m.v[1], ',' ORDER BY m.n) FROM pg_constraint c,
                      regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''', 'g') WITH ORDINALITY m(v, n)
                      WHERE c.conname = 'tag_status_check' AND c.conrelid = 'inventory.tag'::regclass)
                     = 'in_stock,reserved,sold,on_approval,repair,melting,in_transit,returned_to_vendor,melted,written_off',
  'IT6 status CHECK is exactly: in_stock(available), reserved, sold, on_approval, repair, melting, in_transit, returned_to_vendor, melted, written_off');
SELECT pg_temp.expect_error($$UPDATE inventory.tag SET status = 'melting' WHERE id = '00000000-0000-0000-0000-00000098f004'$$, 'IT7 app_rw cannot change tag status', '%permission denied%');
SELECT pg_temp.expect_error($$UPDATE inventory.tag SET gross_wt = 9 WHERE id = '00000000-0000-0000-0000-00000098f004'$$, 'IT7 app_rw cannot change tag weights (adjustment flow only)', '%permission denied%');
BEGIN;
SET LOCAL ROLE inventory_writer;
UPDATE inventory.tag SET status = 'melting' WHERE id = '00000000-0000-0000-0000-00000098f004';
COMMIT;
SELECT pg_temp.check((SELECT status = 'melting' AND version = 2 FROM inventory.tag WHERE id = '00000000-0000-0000-0000-00000098f004'), 'IT7 inventory_writer moves a piece repair -> melting (version 2)');
SELECT pg_temp.expect_error($$UPDATE inventory.tag SET rfid_epc = 'abc' WHERE id = '00000000-0000-0000-0000-00000098f004'$$, 'IT8 rfid_epc not editable by app_rw yet (room only)', '%permission denied%');
SELECT pg_temp.check(EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'inventory' AND indexname = 'tag_rfid_epc_uq'), 'IT8 rfid_epc unique per shop when set (partial index)');
-- vendor_lot_ref: supplier lot / batch reference
SELECT pg_temp.check(pg_temp.cols('inventory.tag', ARRAY['vendor_lot_ref']) = 'vendor_lot_ref:text'
                 AND (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'tag_vendor_lot_ref_check' AND conrelid = 'inventory.tag'::regclass) LIKE '%char_length(vendor_lot_ref) >= 1%char_length(vendor_lot_ref) <= 60%',
  'IT9 tag.vendor_lot_ref: nullable text, CHECK length 1-60');
SELECT pg_temp.expect_error($$UPDATE inventory.tag SET vendor_lot_ref = '' WHERE id = '00000000-0000-0000-0000-00000098f004'$$, 'IT9 vendor_lot_ref rejects an empty string', '%tag_vendor_lot_ref_check%');
SELECT pg_temp.expect_error($$UPDATE inventory.tag SET vendor_lot_ref = repeat('V', 61) WHERE id = '00000000-0000-0000-0000-00000098f004'$$, 'IT9 vendor_lot_ref rejects 61 characters', '%tag_vendor_lot_ref_check%');
UPDATE inventory.tag SET vendor_lot_ref = repeat('V', 60) WHERE id = '00000000-0000-0000-0000-00000098f004';
SELECT pg_temp.check((SELECT vendor_lot_ref = repeat('V', 60) FROM inventory.tag WHERE id = '00000000-0000-0000-0000-00000098f004'), 'IT9 app_rw sets a 60-character vendor_lot_ref');
UPDATE inventory.tag SET vendor_lot_ref = NULL WHERE id = '00000000-0000-0000-0000-00000098f004';
SELECT pg_temp.check((SELECT vendor_lot_ref IS NULL FROM inventory.tag WHERE id = '00000000-0000-0000-0000-00000098f004')
                 AND (SELECT count(*) FROM inventory.tag WHERE vendor_lot_ref IS NOT NULL) = 0,
  'IT9 vendor_lot_ref NULL accepted (cleared, and new tags default to NULL)');
SELECT pg_temp.check(has_column_privilege('app_rw', 'inventory.tag', 'vendor_lot_ref', 'UPDATE') AND has_column_privilege('app_rw', 'inventory.tag', 'vendor_lot_ref', 'INSERT')
                 AND has_column_privilege('app_ro', 'inventory.tag', 'vendor_lot_ref', 'SELECT')
                 AND NOT has_column_privilege('inventory_writer', 'inventory.tag', 'vendor_lot_ref', 'UPDATE') AND NOT has_column_privilege('sales_writer', 'inventory.tag', 'vendor_lot_ref', 'UPDATE')
                 AND NOT has_column_privilege('app_ro', 'inventory.tag', 'vendor_lot_ref', 'UPDATE'),
  'IT9 vendor_lot_ref grant follows the descriptive-column pattern: app_rw UPDATE (INSERT is table-level), not inventory_writer / sales_writer / app_ro');

\echo '--- per-piece photos (toggle)'
INSERT INTO platform.file(tenant_id, id, area, object_key, original_name, content_type, size_bytes, sha256) VALUES
 (platform.current_tenant(), '00000000-0000-0000-0000-0000000f9871', 'attachments', 'att/t1/tag987-1.jpg', 'ring-front.jpg', 'image/jpeg', 1000, decode(repeat('ab', 32), 'hex')),
 (platform.current_tenant(), '00000000-0000-0000-0000-0000000f9872', 'attachments', 'att/t1/tag987-2.jpg', 'ring-side.jpg', 'image/jpeg', 1000, decode(repeat('cd', 32), 'hex'));
SELECT pg_temp.check(NOT (SELECT photos_enabled FROM inventory.shop_setting), 'PH1 photos toggle off by default');
WITH u AS (UPDATE inventory.shop_setting SET photos_enabled = true RETURNING photos_enabled) SELECT pg_temp.check((SELECT photos_enabled FROM u), 'PH1 owner turns per-piece photos on');
SELECT pg_temp.lifecycle('PH2', 'inventory.tag_photo',
  $q$INSERT INTO inventory.tag_photo(tenant_id, tag_id, file_id, is_primary) VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000098f001', '00000000-0000-0000-0000-0000000f9871', true)$q$,
  $q$UPDATE inventory.tag_photo SET caption = 'Front'$q$, true);
SELECT pg_temp.expect_error($$INSERT INTO inventory.tag_photo(tenant_id, tag_id, file_id, is_primary) VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000098f001', '00000000-0000-0000-0000-0000000f9872', true)$$,
  'PH3 one primary photo per piece', '%tag_photo_one_primary%');
SELECT pg_temp.expect_error($$INSERT INTO inventory.tag_photo(tenant_id, tag_id, file_id) VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000098f001', '00000000-0000-0000-0000-0000000f9871')$$,
  'PH3 same file once per piece', '%tag_photo_file_uq%');
SELECT pg_temp.expect_error($$INSERT INTO inventory.tag_photo(tenant_id, tag_id, file_id) VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000098f001', '00000000-0000-0000-0000-00000000dead')$$,
  'PH3 photo must be a platform.file of the shop', '%tag_photo_file_fk%');
INSERT INTO inventory.tag_photo(tenant_id, tag_id, file_id, sort_order) VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000098f001', '00000000-0000-0000-0000-0000000f9872', 1);
DELETE FROM inventory.tag_photo WHERE file_id = '00000000-0000-0000-0000-0000000f9872';
SELECT pg_temp.check((SELECT count(*) FROM inventory.tag_photo WHERE tag_id = '00000000-0000-0000-0000-00000098f001') = 1, 'PH4 app_rw adds and removes a piece photo');

\echo '--- lots (bulk tagging from a purchase)'
INSERT INTO inventory.lot(tenant_id, id, branch_id, lot_no, entry_type, received_on) VALUES
 (platform.current_tenant(), '00000000-0000-0000-0000-0000009870a1', '00000000-0000-0000-0000-00000000b001', 'L987', 'purchase', (now() AT TIME ZONE 'Asia/Kolkata')::date - 100);
SELECT pg_temp.lifecycle('LT1', 'inventory.lot',
  $q$INSERT INTO inventory.lot(tenant_id, branch_id, lot_no, entry_type) VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', 'L987-LC', 'opening')$q$,
  $q$UPDATE inventory.lot SET hallmark_centre = 'BIS CBE'$q$, true, 'branch_scope,no_partner_access,tenant_isolation');
SELECT pg_temp.lifecycle('LT2', 'inventory.lot_line',
  $q$INSERT INTO inventory.lot_line(tenant_id, id, lot_id, item_id, purity_id, pieces, gross_wt, net_wt) VALUES (platform.current_tenant(), '00000000-0000-0000-0000-0000009870b1', '00000000-0000-0000-0000-0000009870a1', '00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-0000000987a8', 3, 6, 6)$q$,
  $q$UPDATE inventory.lot_line SET tagged_pieces = 1, tagged_gross_wt = 2$q$, true, 'no_partner_access,rw_delete_open_lot_only,tenant_isolation');
SELECT pg_temp.expect_error($$UPDATE inventory.lot_line SET tagged_pieces = -1 WHERE id = '00000000-0000-0000-0000-0000009870b1'$$, 'LT3 tagged pieces >= 0', '%lot_line_tagged_check%');
SELECT pg_temp.expect_error($$UPDATE inventory.lot_line SET purchase_line_id = '00000000-0000-0000-0000-00000000dead' WHERE id = '00000000-0000-0000-0000-0000009870b1'$$, 'LT3 lot line links a real purchase line', '%lot_line_purchase_line_fk%');

\echo '--- counter / tray moves (insert-only history)'
SELECT pg_temp.check((SELECT string_agg(polname, ',' ORDER BY polname) FROM pg_policy WHERE polrelid = 'inventory.location_move'::regclass) = 'branch_scope,no_partner_access,tenant_isolation'
                 AND (SELECT relforcerowsecurity FROM pg_class WHERE oid = 'inventory.location_move'::regclass)
                 AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'inventory.location_move'::regclass AND tgname = 'zz_audit'),
  'MV1 location_move: forced RLS with branch_scope; audited');
UPDATE inventory.tag SET counter_id = '00000000-0000-0000-0000-0000000c9872', box_id = '00000000-0000-0000-0000-0000000b9872' WHERE id = '00000000-0000-0000-0000-00000098f001';
INSERT INTO inventory.location_move(tenant_id, branch_id, tag_id, from_counter_id, from_box_id, to_counter_id, to_box_id, reason, moved_by) VALUES
 (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-00000098f001', '00000000-0000-0000-0000-0000000c9871', '00000000-0000-0000-0000-0000000b9871',
  '00000000-0000-0000-0000-0000000c9872', '00000000-0000-0000-0000-0000000b9872', 'display change', '00000000-0000-0000-0000-000000000a01');
SELECT pg_temp.check((SELECT count(*) FROM inventory.location_move WHERE tag_id = '00000000-0000-0000-0000-00000098f001') = 1
                 AND EXISTS (SELECT 1 FROM platform.audit_event WHERE table_name = 'inventory.location_move' AND action = 'INSERT'),
  'MV2 tag moved IV1/TR-IV1 -> IV2/TR-IV2: tag location updated + move row + audit event');
SELECT pg_temp.expect_error($$INSERT INTO inventory.location_move(tenant_id, branch_id, tag_id, from_counter_id, to_counter_id, moved_by) VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-00000098f001', '00000000-0000-0000-0000-0000000c9872', '00000000-0000-0000-0000-0000000c9872', '00000000-0000-0000-0000-000000000a01')$$,
  'MV3 a move must change counter or tray', '%location_move_changes%');
SELECT pg_temp.expect_error($$INSERT INTO inventory.location_move(tenant_id, branch_id, to_counter_id, moved_by) VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000c9872', '00000000-0000-0000-0000-000000000a01')$$,
  'MV3 a move names a tag or loose item + purity + quantity', '%location_move_what%');
SELECT pg_temp.expect_error($$INSERT INTO inventory.location_move(tenant_id, branch_id, tag_id, to_box_id, moved_by) VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-00000098f001', '00000000-0000-0000-0000-0000000b9871', '00000000-0000-0000-0000-000000000a01')$$,
  'MV3 a tray needs its counter', '%location_move_box_needs_counter%');
SELECT pg_temp.expect_error($$UPDATE inventory.location_move SET reason = 'x'$$, 'MV4 move history cannot be edited', '%permission denied%');
SELECT pg_temp.expect_error($$DELETE FROM inventory.location_move$$, 'MV4 move history cannot be deleted', '%permission denied%');
SELECT set_config('app.branch_scope', '00000000-0000-0000-0000-00000000b987', false) \g /dev/null
SELECT pg_temp.check((SELECT count(*) FROM inventory.location_move) = 0 AND (SELECT count(*) FROM inventory.tag WHERE branch_id = '00000000-0000-0000-0000-00000000b001') = 0
                 AND (SELECT count(*) FROM inventory.tag WHERE id = '00000000-0000-0000-0000-00000098f002') = 1,
  'MV5 branch-scoped session (MDU) sees no CBE moves or tags, sees its own tag');
SELECT pg_temp.expect_error($$INSERT INTO inventory.location_move(tenant_id, branch_id, tag_id, from_counter_id, to_counter_id, moved_by) VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-00000098f001', '00000000-0000-0000-0000-0000000c9872', '00000000-0000-0000-0000-0000000c9871', '00000000-0000-0000-0000-000000000a01')$$,
  'MV5 branch-scoped session cannot record a move in another branch', '%row-level security%');
SELECT set_config('app.branch_scope', '', false) \g /dev/null

\echo '--- loose stock by location (ledger)'
BEGIN;
SET LOCAL ROLE inventory_writer;
INSERT INTO inventory.stock_ledger(tenant_id, branch_id, counter_id, box_id, item_id, purity_id, movement, direction, pieces, gross_wt, net_wt, fine_wt, source_module, source_type, source_id) VALUES
 (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000c9871', NULL, '00000000-0000-0000-0000-000000000902', '00000000-0000-0000-0000-0000000987a8', 'opening', 1, 5, 10, 10, 7.5, 'inventory', 'import_job', '00000000-0000-0000-0000-0000009870c1'),
 (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000c9871', NULL, '00000000-0000-0000-0000-000000000902', '00000000-0000-0000-0000-0000000987a8', 'move_out', -1, 2, 4, 4, 3, 'inventory', 'location_move', '00000000-0000-0000-0000-0000009870c2'),
 (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000c9872', '00000000-0000-0000-0000-0000000b9872', '00000000-0000-0000-0000-000000000902', '00000000-0000-0000-0000-0000000987a8', 'move_in', 1, 2, 4, 4, 3, 'inventory', 'location_move', '00000000-0000-0000-0000-0000009870c2'),
 (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', NULL, NULL, NULL, '00000000-0000-0000-0000-0000000987a8', 'old_metal_in', 1, 0, 3, 3, 2.25, 'sales', 'invoice', '00000000-0000-0000-0000-0000009870c3');
COMMIT;
SELECT pg_temp.check((SELECT string_agg(coalesce(c.code, '-') || '/' || coalesce(b.code, '-') || '/' || coalesce(i.code, 'OLD') || ':' || l.pieces || 'pc:' || l.gross_wt || 'g', ' ' ORDER BY c.code NULLS LAST)
                      FROM inventory.v_loose_stock l LEFT JOIN masters.counter c ON c.id = l.counter_id LEFT JOIN masters.box b ON b.id = l.box_id LEFT JOIN masters.item i ON i.id = l.item_id
                      WHERE l.purity_id = '00000000-0000-0000-0000-0000000987a8') = 'IV1/-/COIN:3pc:6.000g IV2/TR-IV2/COIN:2pc:4.000g -/-/OLD:0pc:3.000g',
  'LS1 v_loose_stock: opening 5 pc on IV1, 2 pc moved to IV2/TR-IV2 (move_out/move_in), old metal at branch level');
SELECT pg_temp.check((SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'stock_ledger_movement_check' AND conrelid = 'inventory.stock_ledger'::regclass)
                     LIKE ALL (ARRAY['%move_out%','%move_in%','%non_tag_in%','%adjustment%','%transfer_in%'])
                 AND pg_temp.cols('inventory.stock_ledger', ARRAY['counter_id','box_id']) = 'counter_id:uuid,box_id:uuid',
  'LS2 ledger gains counter_id/box_id and move_out/move_in; existing movements kept');
SELECT pg_temp.check((SELECT sum(tags) = 1 AND sum(net_wt) = 2.000 FROM inventory.v_tag_stock_location WHERE counter_id = '00000000-0000-0000-0000-0000000c9872' AND box_id = '00000000-0000-0000-0000-0000000b9872'),
  'LS3 v_tag_stock_location: tagged stock per branch/counter/tray (the moved tag is on IV2/TR-IV2)');

\echo '--- branch transfers: in_transit -> received'
SELECT pg_temp.lifecycle('TR1', 'inventory.stock_transfer',
  $q$INSERT INTO inventory.stock_transfer(tenant_id, transfer_no, from_branch_id, to_branch_id) VALUES (platform.current_tenant(), 'TR987-LC', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-00000000b987')$q$,
  $q$UPDATE inventory.stock_transfer SET remarks = 'lifecycle'$q$, true, 'branch_scope,no_partner_access,tenant_isolation');
SELECT pg_temp.mk_tag('00000000-0000-0000-0000-00000098f005', 'TX-TRF', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000987a8', 3, 3);
INSERT INTO inventory.stock_transfer(tenant_id, id, transfer_no, from_branch_id, to_branch_id, requested_by) VALUES
 (platform.current_tenant(), '00000000-0000-0000-0000-0000009870d1', 'TR987', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-00000000b987', '00000000-0000-0000-0000-000000000a02');
INSERT INTO inventory.stock_transfer_line(tenant_id, id, transfer_id, tag_id, gross_wt, net_wt) VALUES
 (platform.current_tenant(), '00000000-0000-0000-0000-0000009870d2', '00000000-0000-0000-0000-0000009870d1', '00000000-0000-0000-0000-00000098f005', 3, 3);
SELECT pg_temp.expect_error($$UPDATE inventory.stock_transfer SET status = 'approved' WHERE id = '00000000-0000-0000-0000-0000009870d1'$$, 'TR2 approval needs approved_by', '%stock_transfer_approved_chk%');
UPDATE inventory.stock_transfer SET status = 'approved', approved_by = '00000000-0000-0000-0000-000000000a01' WHERE id = '00000000-0000-0000-0000-0000009870d1';
SELECT pg_temp.expect_error($$UPDATE inventory.stock_transfer SET status = 'in_transit' WHERE id = '00000000-0000-0000-0000-0000009870d1'$$, 'TR3 in_transit needs dispatched_at + dispatched_by', '%stock_transfer_dispatched_chk%');
UPDATE inventory.stock_transfer SET status = 'in_transit', dispatched_at = now() - interval '1 hour', dispatched_by = '00000000-0000-0000-0000-000000000a01' WHERE id = '00000000-0000-0000-0000-0000009870d1';
BEGIN;
SET LOCAL ROLE inventory_writer;
UPDATE inventory.tag SET status = 'in_transit' WHERE id = '00000000-0000-0000-0000-00000098f005';
INSERT INTO inventory.stock_ledger(tenant_id, branch_id, tag_id, item_id, purity_id, movement, direction, pieces, gross_wt, net_wt, source_module, source_type, source_id)
VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-00000098f005', '00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-0000000987a8', 'transfer_out', -1, 1, 3, 3, 'inventory', 'stock_transfer', '00000000-0000-0000-0000-0000009870d1');
COMMIT;
SELECT pg_temp.check((SELECT status FROM inventory.tag WHERE id = '00000000-0000-0000-0000-00000098f005') = 'in_transit'
                 AND (SELECT status FROM inventory.stock_transfer WHERE id = '00000000-0000-0000-0000-0000009870d1') = 'in_transit', 'TR3 dispatched: transfer + piece in_transit');
SELECT pg_temp.expect_error($$UPDATE inventory.stock_transfer SET status = 'received' WHERE id = '00000000-0000-0000-0000-0000009870d1'$$, 'TR4 received needs received_by + received_at', '%stock_transfer_received_chk%');
SELECT pg_temp.expect_error($$UPDATE inventory.stock_transfer SET status = 'received', received_by = '00000000-0000-0000-0000-000000000a02', received_at = now() - interval '2 hours' WHERE id = '00000000-0000-0000-0000-0000009870d1'$$,
  'TR4 cannot be received before it was dispatched', '%stock_transfer_received_after_dispatch%');
SELECT pg_temp.expect_error($$UPDATE inventory.stock_transfer_line SET received = true WHERE id = '00000000-0000-0000-0000-0000009870d2'$$, 'TR5 a received line records received_at', '%stock_transfer_line_received_chk%');
UPDATE inventory.stock_transfer_line SET received = true, received_at = now(), received_by = '00000000-0000-0000-0000-000000000a02' WHERE id = '00000000-0000-0000-0000-0000009870d2';
UPDATE inventory.stock_transfer SET status = 'received', received_by = '00000000-0000-0000-0000-000000000a02', received_at = now() WHERE id = '00000000-0000-0000-0000-0000009870d1';
BEGIN;
SET LOCAL ROLE inventory_writer;
UPDATE inventory.tag SET status = 'in_stock', branch_id = '00000000-0000-0000-0000-00000000b987' WHERE id = '00000000-0000-0000-0000-00000098f005';
INSERT INTO inventory.stock_ledger(tenant_id, branch_id, tag_id, item_id, purity_id, movement, direction, pieces, gross_wt, net_wt, source_module, source_type, source_id)
VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b987', '00000000-0000-0000-0000-00000098f005', '00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-0000000987a8', 'transfer_in', 1, 1, 3, 3, 'inventory', 'stock_transfer', '00000000-0000-0000-0000-0000009870d1');
COMMIT;
SELECT pg_temp.check((SELECT status = 'received' AND version = 4 AND received_by IS NOT NULL FROM inventory.stock_transfer WHERE id = '00000000-0000-0000-0000-0000009870d1')
                 AND (SELECT status = 'in_stock' AND branch_id = '00000000-0000-0000-0000-00000000b987' FROM inventory.tag WHERE id = '00000000-0000-0000-0000-00000098f005')
                 AND (SELECT received AND version = 2 FROM inventory.stock_transfer_line WHERE id = '00000000-0000-0000-0000-0000009870d2')
                 AND (SELECT count(*) FROM platform.audit_event WHERE table_name = 'inventory.stock_transfer_line' AND row_id = '00000000-0000-0000-0000-0000009870d2') = 2,
  'TR6 receiving branch confirms: transfer received (version 4), piece in_stock at MDU, line received + audited');
SELECT set_config('app.branch_scope', '00000000-0000-0000-0000-00000000b987', false) \g /dev/null
SELECT pg_temp.check((SELECT count(*) FROM inventory.stock_transfer WHERE transfer_no = 'TR987') = 1, 'TR7 receiving branch (scope = to_branch) sees the transfer');
SELECT set_config('app.branch_scope', '00000000-0000-0000-0000-00000000b999', false) \g /dev/null
SELECT pg_temp.check((SELECT count(*) FROM inventory.stock_transfer WHERE transfer_no = 'TR987') = 0, 'TR7 an unrelated branch scope does not see it');
SELECT set_config('app.branch_scope', '', false) \g /dev/null
-- transfer / adjustment numbering: unique per shop; counter home = platform.doc_counter
SELECT pg_temp.check((SELECT string_agg(pg_get_constraintdef(oid), ' | ' ORDER BY conname) FROM pg_constraint
                      WHERE conrelid IN ('inventory.stock_transfer'::regclass, 'inventory.stock_adjustment'::regclass) AND contype = 'u'
                        AND (conname = 'stock_adjustment_no_uq' OR pg_get_constraintdef(oid) LIKE '%transfer_no%'))
                     = 'UNIQUE (tenant_id, adjustment_no) | UNIQUE (tenant_id, transfer_no)',
  'NF3 transfer_no and adjustment_no are each unique per shop');
SELECT pg_temp.expect_error($$INSERT INTO inventory.stock_transfer(tenant_id, transfer_no, from_branch_id, to_branch_id) VALUES (platform.current_tenant(), 'TR987', '00000000-0000-0000-0000-00000000b987', '00000000-0000-0000-0000-00000000b001')$$,
  'NF3 duplicate transfer_no in the same shop rejected', '%stock_transfer_tenant_id_transfer_no_key%');
INSERT INTO platform.doc_counter(tenant_id, branch_id, doc_type, fy, prefix) VALUES
 (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', 'stock_transfer', '2026-27', 'TRF-CBE-2627-'),
 (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', 'stock_adjustment', '2026-27', 'ADJ-CBE-2627-');
WITH u AS (UPDATE platform.doc_counter SET next_no = next_no + 1 WHERE tenant_id = platform.current_tenant() AND branch_id = '00000000-0000-0000-0000-00000000b001'
             AND doc_type IN ('stock_transfer','stock_adjustment') AND fy = '2026-27' RETURNING doc_type, next_no - 1 AS issued)
  SELECT pg_temp.check((SELECT string_agg(doc_type || '=' || issued, ',' ORDER BY doc_type) FROM u) = 'stock_adjustment=1,stock_transfer=1',
  'NF4 app_rw keeps transfer/adjustment counters in platform.doc_counter per branch + FY (UPDATE ... RETURNING)');
-- transfer lines: loose stock from a counter / tray
SELECT pg_temp.check(pg_temp.cols('inventory.stock_transfer_line', ARRAY['from_counter_id','from_box_id']) = 'from_counter_id:uuid,from_box_id:uuid'
                 AND (SELECT string_agg(pg_get_constraintdef(oid), ' | ' ORDER BY conname) FROM pg_constraint
                      WHERE conrelid = 'inventory.stock_transfer_line'::regclass AND conname IN ('stock_transfer_line_from_box_fk','stock_transfer_line_from_counter_fk'))
                     = 'FOREIGN KEY (tenant_id, from_box_id) REFERENCES masters.box(tenant_id, id) | FOREIGN KEY (tenant_id, from_counter_id) REFERENCES masters.counter(tenant_id, id)',
  'TL1 stock_transfer_line from_counter_id / from_box_id: nullable, tenant-safe FKs (tenant_id, id)');
SELECT pg_temp.expect_error($$INSERT INTO inventory.stock_transfer_line(tenant_id, transfer_id, item_id, purity_id, pieces, gross_wt, net_wt, from_box_id) VALUES (platform.current_tenant(), '00000000-0000-0000-0000-0000009870d1', '00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-0000000987a8', 1, 1, 1, '00000000-0000-0000-0000-0000000b9871')$$,
  'TL2 a tray implies its counter', '%stock_transfer_line_box_needs_counter%');
SELECT pg_temp.expect_error($$INSERT INTO inventory.stock_transfer_line(tenant_id, transfer_id, item_id, purity_id, pieces, gross_wt, net_wt, from_counter_id) VALUES (platform.current_tenant(), '00000000-0000-0000-0000-0000009870d1', '00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-0000000987a8', 1, 1, 1, '00000000-0000-0000-0000-0000000c98ff')$$,
  'TL3 from_counter_id must be a counter of this shop', '%stock_transfer_line_from_counter_fk%');
INSERT INTO inventory.stock_transfer_line(tenant_id, id, transfer_id, item_id, purity_id, pieces, gross_wt, net_wt, from_counter_id, from_box_id) VALUES
 (platform.current_tenant(), '00000000-0000-0000-0000-0000009870d5', '00000000-0000-0000-0000-0000009870d1', '00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-0000000987a8', 2, 3.5, 3.4,
  '00000000-0000-0000-0000-0000000c9871', '00000000-0000-0000-0000-0000000b9871');
SELECT pg_temp.check((SELECT from_counter_id = '00000000-0000-0000-0000-0000000c9871' AND from_box_id = '00000000-0000-0000-0000-0000000b9871' FROM inventory.stock_transfer_line WHERE id = '00000000-0000-0000-0000-0000009870d5'),
  'TL4 loose line records its source counter + tray');

\echo '--- stock check: matched / missing / extra'
SELECT pg_temp.lifecycle('SC1', 'inventory.stock_take',
  $q$INSERT INTO inventory.stock_take(tenant_id, branch_id, started_by) VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-000000000a01')$q$,
  $q$UPDATE inventory.stock_take SET notes = 'lifecycle'$q$, true, 'branch_scope,no_partner_access,tenant_isolation');
SELECT pg_temp.mk_tag('00000000-0000-0000-0000-00000098f011', 'TK-01', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000987a8', 1, 1, '00000000-0000-0000-0000-0000000c9874');
SELECT pg_temp.mk_tag('00000000-0000-0000-0000-00000098f012', 'TK-02', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000987a8', 1, 1, '00000000-0000-0000-0000-0000000c9874', NULL, 'reserved');
SELECT pg_temp.mk_tag('00000000-0000-0000-0000-00000098f013', 'TK-03', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000987a8', 1, 1, '00000000-0000-0000-0000-0000000c9874');
SELECT pg_temp.mk_tag('00000000-0000-0000-0000-00000098f014', 'TK-04', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000987a8', 1, 1, '00000000-0000-0000-0000-0000000c9874', NULL, 'repair');
SELECT pg_temp.mk_tag('00000000-0000-0000-0000-00000098f015', 'TK-05', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000987a8', 1, 1, '00000000-0000-0000-0000-0000000c9871');
INSERT INTO inventory.stock_take(tenant_id, id, branch_id, counter_id, started_by) VALUES
 (platform.current_tenant(), '00000000-0000-0000-0000-0000009870e1', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000c9874', '00000000-0000-0000-0000-000000000a01');
INSERT INTO inventory.stock_take_scan(tenant_id, stock_take_id, scanned_code, tag_id, scanned_by, result, extra_reason, extra_note)
SELECT platform.current_tenant(), '00000000-0000-0000-0000-0000009870e1', v.code, v.tag::uuid, '00000000-0000-0000-0000-000000000a02', v.result, v.reason, v.note
FROM (VALUES
  ('TK-01',   '00000000-0000-0000-0000-00000098f011', 'matched', NULL,             NULL),
  ('TK-02',   '00000000-0000-0000-0000-00000098f012', 'matched', NULL,             NULL),
  ('TK-04',   '00000000-0000-0000-0000-00000098f014', 'extra',   'wrong_status',   'repair'),
  ('TK-05',   '00000000-0000-0000-0000-00000098f015', 'extra',   'other_location', NULL),
  ('T000002', '00000000-0000-0000-0000-00000098f002', 'extra',   'other_branch',   NULL),
  ('ZZZ-999', NULL,                                   'extra',   'unknown_code',   NULL)
) v(code, tag, result, reason, note);
SELECT pg_temp.check((SELECT string_agg(result || ':' || coalesce(tag_no, scanned_code) || coalesce('(' || extra_reason || ')', '') || coalesce('{' || extra_note || '}', ''), ' ' ORDER BY result, coalesce(tag_no, scanned_code))
                      FROM inventory.v_stock_take_report WHERE stock_take_id = '00000000-0000-0000-0000-0000009870e1')
  = 'extra:T000002(other_branch) extra:TK-04(wrong_status){repair} extra:TK-05(other_location) extra:ZZZ-999(unknown_code) matched:TK-01 matched:TK-02 missing:TK-03',
  'SC2 counter IV4 check: stored outcomes — 2 matched, 1 missing, extras = other branch / wrong_status+note / other counter / unknown code');
SELECT pg_temp.expect_error($$INSERT INTO inventory.stock_take_scan(tenant_id, stock_take_id, scanned_code, tag_id, result) VALUES (platform.current_tenant(), '00000000-0000-0000-0000-0000009870e1', 'TK-01', '00000000-0000-0000-0000-00000098f011', 'matched')$$,
  'SC3 same code scanned twice is rejected', '%stock_take_scan_code_uq%');
SELECT pg_temp.expect_error($$INSERT INTO inventory.stock_take_scan(tenant_id, stock_take_id, scanned_code, tag_id, result) VALUES (platform.current_tenant(), '00000000-0000-0000-0000-0000009870e1', 'HUID-OF-TK01', '00000000-0000-0000-0000-00000098f011', 'matched')$$,
  'SC3 same piece counted once per session (by any code)', '%stock_take_scan_tag_uq%');
DELETE FROM inventory.stock_take_scan WHERE stock_take_id = '00000000-0000-0000-0000-0000009870e1' AND scanned_code = 'ZZZ-999';
SELECT pg_temp.check((SELECT count(*) FROM inventory.v_stock_take_report WHERE stock_take_id = '00000000-0000-0000-0000-0000009870e1' AND result = 'extra') = 3, 'SC4 undo a wrong scan (DELETE) while open');
SELECT pg_temp.expect_error($$UPDATE inventory.stock_take_scan SET scanned_code = 'x'$$, 'SC4 scan identity columns cannot be edited', '%permission denied%');
UPDATE inventory.stock_take_scan SET duplicate_count = 2, last_duplicate_at = now()
 WHERE stock_take_id = '00000000-0000-0000-0000-0000009870e1' AND scanned_code = 'TK-01';
SELECT pg_temp.check((SELECT duplicate_count = 2 AND last_duplicate_at IS NOT NULL AND extra_note IS NULL AND result = 'matched'
                      FROM inventory.v_stock_take_report WHERE stock_take_id = '00000000-0000-0000-0000-0000009870e1' AND scanned_code = 'TK-01')
                 AND (SELECT extra_note = 'repair' AND extra_reason = 'wrong_status' FROM inventory.v_stock_take_report
                      WHERE stock_take_id = '00000000-0000-0000-0000-0000009870e1' AND scanned_code = 'TK-04')
                 AND (SELECT duplicate_count = 2 AND last_duplicate_at IS NOT NULL FROM inventory.stock_take_scan
                      WHERE stock_take_id = '00000000-0000-0000-0000-0000009870e1' AND scanned_code = 'TK-01'),
  'SC4b app_rw may UPDATE duplicate_count/last_duplicate_at only; view exposes them and stored extra_note');
SELECT pg_temp.expect_error($$UPDATE inventory.stock_take_scan SET result = 'extra', extra_reason = 'unknown_code' WHERE scanned_code = 'TK-01'$$,
  'SC4b result/extra_reason are insert-only (no UPDATE grant)', '%permission denied%');
SELECT pg_temp.expect_error($$INSERT INTO inventory.stock_take_scan(tenant_id, stock_take_id, scanned_code, result, duplicate_count) VALUES (platform.current_tenant(), '00000000-0000-0000-0000-0000009870e1', 'DUP-INS', 'matched', 3)$$,
  'SC4b INSERT cannot name duplicate_count', '%permission denied%');
SELECT pg_temp.expect_error($$INSERT INTO inventory.stock_take_scan(tenant_id, stock_take_id, scanned_code, result, last_duplicate_at) VALUES (platform.current_tenant(), '00000000-0000-0000-0000-0000009870e1', 'DUP-INS2', 'matched', now())$$,
  'SC4b INSERT cannot name last_duplicate_at', '%permission denied%');
SELECT pg_temp.check(has_column_privilege('app_rw', 'inventory.stock_take_scan', 'result', 'INSERT')
                 AND has_column_privilege('app_rw', 'inventory.stock_take_scan', 'extra_reason', 'INSERT')
                 AND has_column_privilege('app_rw', 'inventory.stock_take_scan', 'extra_note', 'INSERT')
                 AND NOT has_column_privilege('app_rw', 'inventory.stock_take_scan', 'duplicate_count', 'INSERT')
                 AND NOT has_column_privilege('app_rw', 'inventory.stock_take_scan', 'last_duplicate_at', 'INSERT')
                 AND has_column_privilege('app_rw', 'inventory.stock_take_scan', 'duplicate_count', 'UPDATE')
                 AND has_column_privilege('app_rw', 'inventory.stock_take_scan', 'last_duplicate_at', 'UPDATE')
                 AND NOT has_column_privilege('app_rw', 'inventory.stock_take_scan', 'result', 'UPDATE'),
  'SC4b column privs: INSERT result/extra_*; no INSERT duplicate_*; UPDATE duplicate_* only');
SELECT pg_temp.expect_error($$INSERT INTO inventory.stock_take_scan(tenant_id, stock_take_id, scanned_code, result) VALUES (platform.current_tenant(), '00000000-0000-0000-0000-0000009870e1', 'NO-RESULT', 'bogus')$$,
  'SC4c result CHECK allows only matched|extra', '%stock_take_scan_result_check%');
SELECT pg_temp.expect_error($$INSERT INTO inventory.stock_take_scan(tenant_id, stock_take_id, scanned_code, result, extra_reason) VALUES (platform.current_tenant(), '00000000-0000-0000-0000-0000009870e1', 'BAD-PAIR', 'matched', 'unknown_code')$$,
  'SC4c matched cannot carry extra_reason', '%stock_take_scan_result_reason_chk%');
SELECT pg_temp.expect_error($$INSERT INTO inventory.stock_take_scan(tenant_id, stock_take_id, scanned_code, result) VALUES (platform.current_tenant(), '00000000-0000-0000-0000-0000009870e1', 'BAD-EXTRA', 'extra')$$,
  'SC4c extra requires extra_reason', '%stock_take_scan_result_reason_chk%');
SELECT pg_temp.expect_error($$INSERT INTO inventory.stock_take_scan(tenant_id, stock_take_id, scanned_code, result, extra_reason, extra_note) VALUES (platform.current_tenant(), '00000000-0000-0000-0000-0000009870e1', 'BAD-NOTE', 'extra', 'unknown_code', 'x')$$,
  'SC4c extra_note only with wrong_status', '%stock_take_scan_extra_note_reason_chk%');
SELECT pg_temp.expect_error($$INSERT INTO inventory.stock_take_scan(tenant_id, stock_take_id, scanned_code, result, extra_reason, extra_note) VALUES (platform.current_tenant(), '00000000-0000-0000-0000-0000009870e1', 'LONG-NOTE', 'extra', 'wrong_status', repeat('x', 41))$$,
  'SC4c extra_note max 40 chars', '%stock_take_scan_extra_note_check%');
-- Stored value wins over live derivation: TK-03 is expected+missing; insert a scan that claims matched even though we could have derived otherwise — then a deliberate extra with stored wrong_status on an in_stock expected tag is not possible (matched/extra CHECK + expected set). Prefer-stored: change nothing on TK-04 (repair) but view already shows stored wrong_status; add a scan for an in_stock expected tag at another counter stored as matched would require being that tag — instead insert unknown as extra and assert view equals stored.
INSERT INTO inventory.stock_take_scan(tenant_id, stock_take_id, scanned_code, tag_id, scanned_by, result, extra_reason)
VALUES (platform.current_tenant(), '00000000-0000-0000-0000-0000009870e1', 'PREFER-1', NULL, '00000000-0000-0000-0000-000000000a02', 'extra', 'unknown_code');
SELECT pg_temp.check((SELECT result = 'extra' AND extra_reason = 'unknown_code' AND duplicate_count = 0 AND last_duplicate_at IS NULL AND extra_note IS NULL
                      FROM inventory.v_stock_take_report WHERE stock_take_id = '00000000-0000-0000-0000-0000009870e1' AND scanned_code = 'PREFER-1')
                 AND (SELECT result = 'missing' AND extra_reason IS NULL AND scanned_code IS NULL FROM inventory.v_stock_take_report
                      WHERE stock_take_id = '00000000-0000-0000-0000-0000009870e1' AND tag_id = '00000000-0000-0000-0000-00000098f013'),
  'SC4d view prefers stored scan outcomes; missing expected tags still have no scan row');
DELETE FROM inventory.stock_take_scan WHERE stock_take_id = '00000000-0000-0000-0000-0000009870e1' AND scanned_code = 'PREFER-1';
SELECT pg_temp.expect_error($$UPDATE inventory.stock_take SET status = 'closed' WHERE id = '00000000-0000-0000-0000-0000009870e1'$$, 'SC5 closing needs closed_at', '%stock_take_closed_chk%');
SELECT pg_temp.expect_error($$UPDATE inventory.stock_take SET status = 'done', closed_at = now() WHERE id = '00000000-0000-0000-0000-0000009870e1'$$, 'SC5 status open | closed | cancelled', '%stock_take_status_check%');
SELECT pg_temp.expect_error($$INSERT INTO inventory.stock_take(tenant_id, branch_id, box_id) VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000b9871')$$,
  'SC5 tray-scoped check names its counter', '%stock_take_box_needs_counter%');
UPDATE inventory.stock_take SET status = 'closed', closed_at = now(), closed_by = '00000000-0000-0000-0000-000000000a01' WHERE id = '00000000-0000-0000-0000-0000009870e1';
SELECT pg_temp.check((SELECT status = 'closed' AND version = 2 FROM inventory.stock_take WHERE id = '00000000-0000-0000-0000-0000009870e1')
                 AND col_description('inventory.stock_take'::regclass, (SELECT attnum FROM pg_attribute WHERE attrelid = 'inventory.stock_take'::regclass AND attname = 'scanned_tag_ids')) LIKE 'DEPRECATED%',
  'SC6 session closed by a user (version 2); scanned_tag_ids marked deprecated');
SELECT pg_temp.check((SELECT string_agg(action, ',' ORDER BY action) FROM platform.audit_event
                      WHERE table_name = 'inventory.stock_take' AND row_id = '00000000-0000-0000-0000-0000009870e1') = 'INSERT,UPDATE'
                 AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'inventory.stock_take'::regclass AND tgname = 'zz_audit'),
  'SC7 session start (INSERT) and close (UPDATE) are audited via zz_audit on stock_take: exactly one row each');
SELECT pg_temp.check(NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'inventory.stock_take_scan'::regclass AND NOT tgisinternal),
  'SC7 stock_take_scan has no audit/version trigger (volume; covered by the audited session)');
SELECT pg_temp.check(pg_temp.cols('inventory.stock_take_scan', ARRAY['result','extra_reason','extra_note','duplicate_count','last_duplicate_at'])
  = 'result:text:NN,extra_reason:text,extra_note:text,duplicate_count:integer:NN,last_duplicate_at:timestamp with time zone',
  'SC8 scan outcome columns: result NOT NULL, extra_reason/note nullable, duplicate_count NOT NULL, last_duplicate_at');

\echo '--- stock adjustments with approval'
SELECT pg_temp.lifecycle('AD1', 'inventory.stock_adjustment',
  $q$INSERT INTO inventory.stock_adjustment(tenant_id, branch_id, kind, tag_id, delta_gross_wt, delta_net_wt, reason_code, reason, requested_by) VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', 'weight_loss', '00000000-0000-0000-0000-00000098f001', -0.010, -0.010, 'polishing', 'Polished', '00000000-0000-0000-0000-000000000a02')$q$,
  $q$UPDATE inventory.stock_adjustment SET reason = 'Polished at counter'$q$, true, 'branch_scope,no_partner_access,tenant_isolation');
INSERT INTO inventory.stock_adjustment(tenant_id, id, branch_id, kind, tag_id, delta_gross_wt, delta_net_wt, reason_code, reason, requested_by) VALUES
 (platform.current_tenant(), '00000000-0000-0000-0000-0000009870f1', '00000000-0000-0000-0000-00000000b001', 'weight_loss', '00000000-0000-0000-0000-00000098f001', -0.100, -0.100, 'polishing', 'Re-polish', '00000000-0000-0000-0000-000000000a02');
SELECT pg_temp.check(pg_temp.cols('inventory.stock_adjustment', ARRAY['status','requested_by','requested_at','decided_by','decided_as_role','decided_at','decision_note'])
  = 'status:text:NN,requested_by:uuid:NN,requested_at:timestamp with time zone:NN,decided_by:uuid,decided_as_role:text,decided_at:timestamp with time zone,decision_note:text',
  'AD2 approval columns: status, requested_by/at, decided_by, decided_as_role, decided_at, decision_note');
SELECT pg_temp.expect_error($$INSERT INTO inventory.stock_adjustment(tenant_id, branch_id, kind, tag_id, delta_gross_wt, reason_code, reason, requested_by) VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', 'weight_loss', '00000000-0000-0000-0000-00000098f001', 0.5, 'polishing', 'wrong sign', '00000000-0000-0000-0000-000000000a02')$$,
  'AD3 weight_loss must reduce weight', '%stock_adjustment_sign%');
SELECT pg_temp.expect_error($$INSERT INTO inventory.stock_adjustment(tenant_id, branch_id, kind, tag_id, reason_code, reason, requested_by) VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', 'correction', '00000000-0000-0000-0000-00000098f001', 'other', 'nothing', '00000000-0000-0000-0000-000000000a02')$$,
  'AD3 an adjustment changes something', '%stock_adjustment_nonzero%');
SELECT pg_temp.expect_error($$INSERT INTO inventory.stock_adjustment(tenant_id, branch_id, kind, delta_pieces, reason_code, reason, requested_by) VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', 'piece_loss', -1, 'loss', 'missing piece', '00000000-0000-0000-0000-000000000a02')$$,
  'AD3 names a tag or loose item + purity', '%stock_adjustment_what%');
SELECT pg_temp.expect_error($$UPDATE inventory.stock_adjustment SET status = 'approved' WHERE id = '00000000-0000-0000-0000-0000009870f1'$$, 'AD4 approval records approver, role and time', '%stock_adjustment_decision%');
SELECT pg_temp.expect_error($$UPDATE inventory.stock_adjustment SET decided_by = '00000000-0000-0000-0000-000000000a01' WHERE id = '00000000-0000-0000-0000-0000009870f1'$$, 'AD4 a pending request has no decision yet', '%stock_adjustment_decision%');
SELECT pg_temp.expect_error($$UPDATE inventory.stock_adjustment SET status = 'approved', decided_by = '00000000-0000-0000-0000-000000000a01', decided_at = now(), decided_as_role = 'cashier' WHERE id = '00000000-0000-0000-0000-0000009870f1'$$,
  'AD4 approver role owner | manager', '%stock_adjustment_decided_as_role_check%');
UPDATE inventory.stock_adjustment SET status = 'approved', decided_by = '00000000-0000-0000-0000-000000000a01', decided_at = now(), decided_as_role = 'owner', decision_note = 'ok'
WHERE id = '00000000-0000-0000-0000-0000009870f1';
BEGIN;
SET LOCAL ROLE inventory_writer;
UPDATE inventory.tag SET gross_wt = gross_wt - 0.100, net_wt = net_wt - 0.100 WHERE id = '00000000-0000-0000-0000-00000098f001';
INSERT INTO inventory.stock_ledger(tenant_id, branch_id, tag_id, item_id, purity_id, movement, direction, gross_wt, net_wt, source_module, source_type, source_id)
VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-00000098f001', '00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-0000000987a8', 'adjustment', -1, 0.100, 0.100, 'inventory', 'stock_adjustment', '00000000-0000-0000-0000-0000009870f1');
COMMIT;
SELECT pg_temp.check((SELECT gross_wt = 2.000 AND net_wt = 1.900 FROM inventory.tag WHERE id = '00000000-0000-0000-0000-00000098f001')
                 AND (SELECT status = 'approved' AND decided_as_role = 'owner' AND decided_at IS NOT NULL FROM inventory.stock_adjustment WHERE id = '00000000-0000-0000-0000-0000009870f1'),
  'AD5 approved adjustment: inventory_writer applies the new weights + adjustment ledger row');
SELECT pg_temp.check((SELECT array_agg(role_code ORDER BY role_code) FROM platform.system_role_permission WHERE permission_code = 'inventory.adjustment.approve') = '{manager,owner}'
                 AND (SELECT adjustment_approver FROM inventory.shop_setting) = 'owner_only',
  'AD6 approve permission: owner + manager; this shop is owner_only (the app checks the setting)');
SELECT set_config('app.branch_scope', '00000000-0000-0000-0000-00000000b987', false) \g /dev/null
SELECT pg_temp.check((SELECT count(*) FROM inventory.stock_adjustment) = 0, 'AD7 branch-scoped session (MDU) sees no CBE adjustments');
SELECT set_config('app.branch_scope', '', false) \g /dev/null
SELECT pg_temp.expect_error($$DELETE FROM inventory.stock_adjustment$$, 'AD7 adjustments are never deleted (cancel instead)', '%permission denied%');
SELECT pg_temp.check(pg_temp.cols('inventory.stock_adjustment', ARRAY['approval_request_id']) = 'approval_request_id:uuid'
                 AND (SELECT confrelid = 'approvals.request'::regclass FROM pg_constraint WHERE conname = 'stock_adjustment_approval_request_fk' AND conrelid = 'inventory.stock_adjustment'::regclass)
                 AND (SELECT convalidated FROM pg_constraint WHERE conname = 'stock_adjustment_approval_request_fk' AND conrelid = 'inventory.stock_adjustment'::regclass),
  'AD8 approval_request_id: nullable uuid, validated FK to approvals.request');
SELECT pg_temp.expect_error($$UPDATE inventory.stock_adjustment SET approval_request_id = '00000000-0000-0000-0000-00000000dead' WHERE id = '00000000-0000-0000-0000-0000009870f1'$$,
  'AD8 approval_request_id must point at an existing approvals.request in the shop', '%stock_adjustment_approval_request_fk%');
INSERT INTO approvals.request(tenant_id, id, action_code, branch_id, ref_type, ref_id, requested_by)
VALUES (platform.current_tenant(), '00000000-0000-0000-0000-0000009870f9', 'inventory.adjustment.approve', '00000000-0000-0000-0000-00000000b001', 'stock_adjustment', '00000000-0000-0000-0000-0000009870f1', '00000000-0000-0000-0000-000000000a02');
UPDATE inventory.stock_adjustment SET approval_request_id = '00000000-0000-0000-0000-0000009870f9' WHERE id = '00000000-0000-0000-0000-0000009870f1';
SELECT pg_temp.check((SELECT approval_request_id = '00000000-0000-0000-0000-0000009870f9' FROM inventory.stock_adjustment WHERE id = '00000000-0000-0000-0000-0000009870f1')
                 AND (SELECT count(*) FROM inventory.stock_adjustment WHERE approval_request_id IS NULL) >= 1,
  'AD8 adjustment linked to its approvals.request; unlinked adjustments stay NULL');
-- full write-off: the only route to the terminal tag status written_off
SELECT pg_temp.expect_error($$INSERT INTO inventory.stock_adjustment(tenant_id, branch_id, kind, item_id, purity_id, delta_pieces, delta_gross_wt, delta_net_wt, reason_code, reason, requested_by) VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', 'full_write_off', '00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-0000000987a8', -1, -1, -1, 'loss', 'lost loose', '00000000-0000-0000-0000-000000000a02')$$,
  'AD9 full_write_off names a tag (whole tagged piece)', '%stock_adjustment_full_write_off_tag%');
SELECT pg_temp.mk_tag('00000000-0000-0000-0000-00000098f041', 'TW-01', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000987a8', 2, 2, '00000000-0000-0000-0000-0000000c9871');
SELECT pg_temp.expect_error($$INSERT INTO inventory.stock_adjustment(tenant_id, branch_id, kind, tag_id, delta_pieces, delta_gross_wt, delta_net_wt, reason_code, reason, requested_by) VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', 'full_write_off', '00000000-0000-0000-0000-00000098f041', -1, 0, 0, 'loss', 'lost piece', '00000000-0000-0000-0000-000000000a02')$$,
  'AD9 full_write_off removes pieces and weight (all deltas negative)', '%stock_adjustment_sign%');
INSERT INTO inventory.stock_adjustment(tenant_id, id, branch_id, kind, tag_id, delta_pieces, delta_gross_wt, delta_net_wt, reason_code, reason, requested_by) VALUES
 (platform.current_tenant(), '00000000-0000-0000-0000-0000009870fa', '00000000-0000-0000-0000-00000000b001', 'full_write_off', '00000000-0000-0000-0000-00000098f041', -1, -2, -2, 'loss', 'Piece lost at exhibition', '00000000-0000-0000-0000-000000000a02');
UPDATE inventory.stock_adjustment SET status = 'approved', decided_by = '00000000-0000-0000-0000-000000000a01', decided_at = now(), decided_as_role = 'owner'
WHERE id = '00000000-0000-0000-0000-0000009870fa';
SELECT pg_temp.expect_error($$UPDATE inventory.tag SET status = 'written_off' WHERE id = '00000000-0000-0000-0000-00000098f041'$$, 'AD10 app_rw cannot set written_off (status changes via inventory_writer only)', '%permission denied%');
BEGIN;
SET LOCAL ROLE inventory_writer;
UPDATE inventory.tag SET status = 'written_off' WHERE id = '00000000-0000-0000-0000-00000098f041';
COMMIT;
SELECT pg_temp.check((SELECT status = 'written_off' FROM inventory.tag WHERE id = '00000000-0000-0000-0000-00000098f041')
                 AND NOT EXISTS (SELECT 1 FROM inventory.v_stock_valuation WHERE tag_id = '00000000-0000-0000-0000-00000098f041')
                 AND NOT EXISTS (SELECT 1 FROM inventory.v_tag_stock_location WHERE status = 'written_off'),
  'AD10 approved full write-off: inventory_writer sets status written_off (accepted); piece leaves valuation and location stock');
SELECT pg_temp.check((SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'stock_adjustment_kind_check' AND conrelid = 'inventory.stock_adjustment'::regclass) LIKE '%full_write_off%',
  'AD10 stock_adjustment kind full_write_off exists (terminal tag status reached only through it, enforced by the app)');

\echo '--- valuation at today''s rate (branch override)'
SELECT pg_temp.mk_tag('00000000-0000-0000-0000-00000098f021', 'TV-585', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000985a8', 1, 1);
SELECT pg_temp.check((SELECT rate_scope = 'shop' AND rate_per_g = 5000 AND metal_value = 9500.00 FROM inventory.v_stock_valuation WHERE tag_id = '00000000-0000-0000-0000-00000098f001'),
  'VL1 CBE tag: shop-wide sale rate 5000 x 1.900 g = 9500.00');
SELECT pg_temp.check((SELECT rate_scope = 'branch' AND rate_per_g = 5100 AND metal_value = 10200.00 FROM inventory.v_stock_valuation WHERE tag_id = '00000000-0000-0000-0000-00000098f002'),
  'VL2 MDU tag: branch override 5100 wins over shop-wide -> 10200.00');
SELECT pg_temp.check((SELECT string_agg(coalesce(c.code, '-') || ':' || v.rate_kind || ':' || v.metal_value, ' ' ORDER BY c.code NULLS LAST)
                      FROM inventory.v_stock_valuation v LEFT JOIN masters.counter c ON c.id = v.counter_id
                      WHERE v.stock_kind = 'loose' AND v.purity_id = '00000000-0000-0000-0000-0000000987a8') = 'IV1:sale:30000.00 IV2:sale:20000.00 -:old_metal:14400.00',
  'VL3 loose stock valued per location; loose old metal at the old_metal rate (4800 x 3 g)');
SELECT pg_temp.check((SELECT rate_per_g IS NULL AND metal_value IS NULL AND rate_scope IS NULL FROM inventory.v_stock_valuation WHERE tag_id = '00000000-0000-0000-0000-00000098f021'),
  'VL4 no rate set today for the purity -> rate and value NULL (not zero)');
SELECT pg_temp.check(NOT EXISTS (SELECT 1 FROM inventory.v_stock_valuation v JOIN inventory.tag t ON t.id = v.tag_id WHERE t.status IN ('sold','melted','returned_to_vendor','written_off'))
                 AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'inventory' AND table_name = 'v_stock_valuation' AND column_name LIKE '%cost%'),
  'VL5 sold / melted / returned / written-off pieces excluded; no cost column');
SELECT pg_temp.check(NOT EXISTS (SELECT 1 FROM inventory.v_stock_valuation WHERE total_value IS DISTINCT FROM metal_value OR value_basis <> 'metal')
                 AND (SELECT total_value FROM inventory.v_stock_valuation WHERE tag_id = '00000000-0000-0000-0000-00000098f001') = 9500.00
                 AND (SELECT string_agg(column_name::text, ',' ORDER BY ordinal_position) FROM information_schema.columns
                      WHERE table_schema = 'inventory' AND table_name = 'v_stock_valuation' AND ordinal_position > 16) = 'rate_per_g,metal_value,total_value,value_basis'
                 AND (SELECT data_type || ':' || numeric_precision || ',' || numeric_scale FROM information_schema.columns
                      WHERE table_schema = 'inventory' AND table_name = 'v_stock_valuation' AND column_name = 'total_value') = 'numeric:14,2',
  'VL7 valuation: total_value = metal_value (value_basis metal) for now; stone/making can be appended later');
SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000002', false) \g /dev/null
SELECT pg_temp.check((SELECT count(*) FROM inventory.v_stock_valuation) = 0 AND (SELECT count(*) FROM inventory.v_stock_take_report) = 0
                 AND (SELECT count(*) FROM inventory.v_loose_stock) = 0, 'VL6 views are security_invoker: tenant 2 sees none of tenant 1 stock');
SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000001', false) \g /dev/null

\echo '--- ageing (toggle + configurable buckets)'
SELECT pg_temp.mk_tag('00000000-0000-0000-0000-00000098f031', 'TA-045', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000987a8', 1, 1, NULL, NULL, 'in_stock', (now() AT TIME ZONE 'Asia/Kolkata')::date - 45);
SELECT pg_temp.mk_tag('00000000-0000-0000-0000-00000098f032', 'TA-400', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000987a8', 1, 1, NULL, NULL, 'in_stock', (now() AT TIME ZONE 'Asia/Kolkata')::date - 400);
SELECT pg_temp.mk_tag('00000000-0000-0000-0000-00000098f033', 'TA-LOT', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000987a8', 1, 1, NULL, NULL, 'in_stock', NULL, '00000000-0000-0000-0000-0000009870b1');
INSERT INTO inventory.tag(tenant_id, id, branch_id, tag_no, item_id, purity_id, hallmark_exempt, gross_wt, net_wt, mc_type, status, tagged_at)
VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000098f034', '00000000-0000-0000-0000-00000000b001', 'TA-T50', '00000000-0000-0000-0000-000000000901',
        '00000000-0000-0000-0000-0000000987a8', true, 1, 1, 'per_gram', 'in_stock', now() - interval '50 days');
SELECT pg_temp.check((SELECT count(*) FROM inventory.v_tag_ageing) = 0, 'AG1 ageing off (default): the ageing view returns nothing');
UPDATE inventory.shop_setting SET ageing_enabled = true, ageing_bucket_days = '{90,30,30}';
SELECT pg_temp.check((SELECT string_agg(tag_no || ':' || age_basis || ':' || age_days || ':' || bucket_no || ':' || bucket_label, ' ' ORDER BY tag_no) FROM inventory.v_tag_ageing
                      WHERE tag_id IN ('00000000-0000-0000-0000-00000098f031','00000000-0000-0000-0000-00000098f032','00000000-0000-0000-0000-00000098f033',
                                       '00000000-0000-0000-0000-00000098f034','00000000-0000-0000-0000-00000098f005'))
  = 'TA-045:received:45:1:30-89 days TA-400:received:400:2:90+ days TA-LOT:tagged:0:0:0-29 days TA-T50:tagged:50:1:30-89 days TX-TRF:tagged:0:0:0-29 days',
  'AG2 ageing on, buckets {90,30,30} sorted + de-duplicated: 0-29 / 30-89 / 90+; age from received_on (basis received), else tag creation IST date (basis tagged); lot date not used');
SELECT pg_temp.check((SELECT received_on IS NULL AND since = (now() AT TIME ZONE 'Asia/Kolkata')::date - 50 FROM inventory.v_tag_ageing WHERE tag_id = '00000000-0000-0000-0000-00000098f034')
                 AND (SELECT received_on = since FROM inventory.v_tag_ageing WHERE tag_id = '00000000-0000-0000-0000-00000098f032')
                 AND pg_temp.cols('inventory.v_tag_ageing', ARRAY['received_on','age_basis']) = 'received_on:date,age_basis:text',
  'AG5 received_on exposed (informational); since = received_on when set, else created (tagged_at) IST date');
SELECT pg_temp.check(NOT EXISTS (SELECT 1 FROM inventory.v_tag_ageing a JOIN inventory.tag t ON t.id = a.tag_id WHERE t.status IN ('sold','melted','returned_to_vendor','written_off')),
  'AG3 ageing lists stock only');
UPDATE inventory.shop_setting SET ageing_enabled = false;
SELECT pg_temp.check((SELECT count(*) FROM inventory.v_tag_ageing) = 0, 'AG4 turning ageing off hides the view again');

\echo '--- opening stock import kind'
INSERT INTO platform.import_job(tenant_id, kind, file_key, created_by) VALUES (platform.current_tenant(), 'stock', 'imports/t1/opening-stock-987.xlsx', '00000000-0000-0000-0000-000000000a01');
SELECT pg_temp.check((SELECT count(*) FROM platform.import_job WHERE file_key = 'imports/t1/opening-stock-987.xlsx' AND kind = 'stock') = 1
                 AND col_description('platform.import_job'::regclass, (SELECT attnum FROM pg_attribute WHERE attrelid = 'platform.import_job'::regclass AND attname = 'kind')) LIKE '%opening stock%',
  'IM1 opening stock import uses import kind ''stock'' (tagged + loose), documented on the column');

\echo '--- line deletes: lot lines while the lot is open + untagged, transfer lines while draft (RLS, no trigger)'
SELECT set_config('app.branch_scope', '', false) \g /dev/null
INSERT INTO inventory.lot(tenant_id, id, branch_id, lot_no, entry_type, status) VALUES
 (platform.current_tenant(), '00000000-0000-0000-0000-0000009871a1', '00000000-0000-0000-0000-00000000b001', 'L987-DO', 'purchase', 'open'),
 (platform.current_tenant(), '00000000-0000-0000-0000-0000009871a2', '00000000-0000-0000-0000-00000000b001', 'L987-DT', 'purchase', 'tagged'),
 (platform.current_tenant(), '00000000-0000-0000-0000-0000009871a3', '00000000-0000-0000-0000-00000000b001', 'L987-DC', 'purchase', 'open');
INSERT INTO inventory.lot_line(tenant_id, id, lot_id, item_id, purity_id, pieces, gross_wt, net_wt, tagged_pieces) VALUES
 (platform.current_tenant(), '00000000-0000-0000-0000-0000009871b1', '00000000-0000-0000-0000-0000009871a1', '00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-0000000987a8', 2, 4, 4, 0),   -- open, untagged        -> deletable
 (platform.current_tenant(), '00000000-0000-0000-0000-0000009871b2', '00000000-0000-0000-0000-0000009871a1', '00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-0000000987a8', 2, 4, 4, 1),   -- open, tagged_pieces 1 -> blocked
 (platform.current_tenant(), '00000000-0000-0000-0000-0000009871b3', '00000000-0000-0000-0000-0000009871a1', '00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-0000000987a8', 2, 4, 4, 0),   -- open, a tag points at it -> blocked
 (platform.current_tenant(), '00000000-0000-0000-0000-0000009871b4', '00000000-0000-0000-0000-0000009871a2', '00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-0000000987a8', 2, 4, 4, 0),   -- lot 'tagged' (not closed), untagged -> deletable
 (platform.current_tenant(), '00000000-0000-0000-0000-0000009871b5', '00000000-0000-0000-0000-0000009871a3', '00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-0000000987a8', 2, 4, 4, 0),   -- lot closed below -> blocked
 (platform.current_tenant(), '00000000-0000-0000-0000-0000009871b6', '00000000-0000-0000-0000-0000009871a1', '00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-0000000987a8', 2, 4, 4, 0);   -- open, untagged, kept for the tenant-2 attempt
UPDATE inventory.lot SET status = 'closed' WHERE id = '00000000-0000-0000-0000-0000009871a3';
SELECT pg_temp.mk_tag('00000000-0000-0000-0000-00000098f051', 'TD-LL', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000987a8', 2, 2, NULL, NULL, 'in_stock', NULL, '00000000-0000-0000-0000-0000009871b3');
WITH d AS (DELETE FROM inventory.lot_line WHERE id IN ('00000000-0000-0000-0000-0000009871b1', '00000000-0000-0000-0000-0000009871b4') RETURNING id)
  SELECT pg_temp.check((SELECT count(*) FROM d) = 2, 'LD1 app_rw deletes untagged lot lines on an open lot and on a tagged (not closed) lot');
SELECT pg_temp.check((SELECT count(*) FROM platform.audit_event WHERE table_name = 'inventory.lot_line' AND action = 'DELETE' AND row_id IN ('00000000-0000-0000-0000-0000009871b1', '00000000-0000-0000-0000-0000009871b4')) = 2
                 AND (SELECT old_row->>'lot_id' FROM platform.audit_event WHERE table_name = 'inventory.lot_line' AND action = 'DELETE' AND row_id = '00000000-0000-0000-0000-0000009871b1') = '00000000-0000-0000-0000-0000009871a1',
  'LD1 each lot_line delete writes a DELETE audit row with the old row');
WITH d AS (DELETE FROM inventory.lot_line WHERE id = '00000000-0000-0000-0000-0000009871b5' RETURNING id)
  SELECT pg_temp.check((SELECT count(*) FROM d) = 0, 'LD2 closed lot: delete filtered (0 rows)');
WITH d AS (DELETE FROM inventory.lot_line WHERE id = '00000000-0000-0000-0000-0000009871b2' RETURNING id)
  SELECT pg_temp.check((SELECT count(*) FROM d) = 0, 'LD2 open lot, line with tagged_pieces > 0: delete filtered (0 rows)');
WITH d AS (DELETE FROM inventory.lot_line WHERE id = '00000000-0000-0000-0000-0000009871b3' RETURNING id)
  SELECT pg_temp.check((SELECT count(*) FROM d) = 0, 'LD2 open lot, line a tag points at (tagged_pieces 0): delete filtered (0 rows)');
SELECT pg_temp.check((SELECT count(*) FROM inventory.lot_line WHERE id IN ('00000000-0000-0000-0000-0000009871b2', '00000000-0000-0000-0000-0000009871b3', '00000000-0000-0000-0000-0000009871b5', '00000000-0000-0000-0000-0000009871b6')) = 4
                 AND NOT EXISTS (SELECT 1 FROM platform.audit_event WHERE table_name = 'inventory.lot_line' AND action = 'DELETE' AND row_id IN ('00000000-0000-0000-0000-0000009871b2', '00000000-0000-0000-0000-0000009871b3', '00000000-0000-0000-0000-0000009871b5')),
  'LD2 blocked lot lines still exist and have no DELETE audit');
INSERT INTO inventory.stock_transfer(tenant_id, id, transfer_no, from_branch_id, to_branch_id, status, requested_by, approved_by, dispatched_at, dispatched_by, received_at, received_by, cancelled_at, cancelled_by) VALUES
 (platform.current_tenant(), '00000000-0000-0000-0000-0000009871c1', 'TD-DRAFT', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-00000000b987', 'draft',      '00000000-0000-0000-0000-000000000a02', NULL, NULL, NULL, NULL, NULL, NULL, NULL),
 (platform.current_tenant(), '00000000-0000-0000-0000-0000009871c2', 'TD-APPR',  '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-00000000b987', 'approved',   '00000000-0000-0000-0000-000000000a02', '00000000-0000-0000-0000-000000000a01', NULL, NULL, NULL, NULL, NULL, NULL),
 (platform.current_tenant(), '00000000-0000-0000-0000-0000009871c3', 'TD-TRAN',  '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-00000000b987', 'in_transit', '00000000-0000-0000-0000-000000000a02', '00000000-0000-0000-0000-000000000a01', now() - interval '2 hours', '00000000-0000-0000-0000-000000000a02', NULL, NULL, NULL, NULL),
 (platform.current_tenant(), '00000000-0000-0000-0000-0000009871c4', 'TD-RECV',  '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-00000000b987', 'received',   '00000000-0000-0000-0000-000000000a02', '00000000-0000-0000-0000-000000000a01', now() - interval '2 hours', '00000000-0000-0000-0000-000000000a02', now(), '00000000-0000-0000-0000-000000000a01', NULL, NULL),
 (platform.current_tenant(), '00000000-0000-0000-0000-0000009871c5', 'TD-RETN',  '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-00000000b987', 'returned',   '00000000-0000-0000-0000-000000000a02', '00000000-0000-0000-0000-000000000a01', now() - interval '2 hours', '00000000-0000-0000-0000-000000000a02', NULL, NULL, NULL, NULL),
 (platform.current_tenant(), '00000000-0000-0000-0000-0000009871c6', 'TD-CANC',  '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-00000000b987', 'cancelled',  '00000000-0000-0000-0000-000000000a02', NULL, NULL, NULL, NULL, NULL, now(), '00000000-0000-0000-0000-000000000a01');
INSERT INTO inventory.stock_transfer_line(tenant_id, id, transfer_id, item_id, purity_id, pieces, gross_wt, net_wt) VALUES
 (platform.current_tenant(), '00000000-0000-0000-0000-0000009871d1', '00000000-0000-0000-0000-0000009871c1', '00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-0000000987a8', 1, 1, 1),
 (platform.current_tenant(), '00000000-0000-0000-0000-0000009871d7', '00000000-0000-0000-0000-0000009871c1', '00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-0000000987a8', 1, 1, 1),   -- kept for the tenant-2 attempt
 (platform.current_tenant(), '00000000-0000-0000-0000-0000009871d2', '00000000-0000-0000-0000-0000009871c2', '00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-0000000987a8', 1, 1, 1),
 (platform.current_tenant(), '00000000-0000-0000-0000-0000009871d3', '00000000-0000-0000-0000-0000009871c3', '00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-0000000987a8', 1, 1, 1),
 (platform.current_tenant(), '00000000-0000-0000-0000-0000009871d4', '00000000-0000-0000-0000-0000009871c4', '00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-0000000987a8', 1, 1, 1),
 (platform.current_tenant(), '00000000-0000-0000-0000-0000009871d5', '00000000-0000-0000-0000-0000009871c5', '00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-0000000987a8', 1, 1, 1),
 (platform.current_tenant(), '00000000-0000-0000-0000-0000009871d6', '00000000-0000-0000-0000-0000009871c6', '00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-0000000987a8', 1, 1, 1);
WITH d AS (DELETE FROM inventory.stock_transfer_line WHERE id = '00000000-0000-0000-0000-0000009871d1' RETURNING id)
  SELECT pg_temp.check((SELECT count(*) FROM d) = 1, 'TD1 app_rw deletes a line of a draft transfer');
SELECT pg_temp.check((SELECT count(*) FROM platform.audit_event WHERE table_name = 'inventory.stock_transfer_line' AND action = 'DELETE' AND row_id = '00000000-0000-0000-0000-0000009871d1'
                        AND old_row->>'transfer_id' = '00000000-0000-0000-0000-0000009871c1') = 1,
  'TD1 the transfer_line delete writes a DELETE audit row with the old row');
WITH d AS (DELETE FROM inventory.stock_transfer_line WHERE id IN ('00000000-0000-0000-0000-0000009871d2', '00000000-0000-0000-0000-0000009871d3', '00000000-0000-0000-0000-0000009871d4', '00000000-0000-0000-0000-0000009871d5', '00000000-0000-0000-0000-0000009871d6') RETURNING id)
  SELECT pg_temp.check((SELECT count(*) FROM d) = 0, 'TD2 approved / in_transit / received / returned / cancelled transfers: line deletes filtered (0 rows)');
SELECT pg_temp.check((SELECT string_agg(s.status, ',' ORDER BY s.status) FROM inventory.stock_transfer_line l JOIN inventory.stock_transfer s ON s.tenant_id = l.tenant_id AND s.id = l.transfer_id
                      WHERE l.id IN ('00000000-0000-0000-0000-0000009871d2', '00000000-0000-0000-0000-0000009871d3', '00000000-0000-0000-0000-0000009871d4', '00000000-0000-0000-0000-0000009871d5', '00000000-0000-0000-0000-0000009871d6')) = 'approved,cancelled,in_transit,received,returned'
                 AND NOT EXISTS (SELECT 1 FROM platform.audit_event WHERE table_name = 'inventory.stock_transfer_line' AND action = 'DELETE' AND row_id IN ('00000000-0000-0000-0000-0000009871d2', '00000000-0000-0000-0000-0000009871d3', '00000000-0000-0000-0000-0000009871d4', '00000000-0000-0000-0000-0000009871d5', '00000000-0000-0000-0000-0000009871d6')),
  'TD2 the five blocked lines still exist and have no DELETE audit');
SELECT set_config('app.branch_scope', '00000000-0000-0000-0000-00000000b0ff', false) \g /dev/null
WITH d AS (DELETE FROM inventory.stock_transfer_line WHERE id = '00000000-0000-0000-0000-0000009871d7' RETURNING id)
  SELECT pg_temp.check((SELECT count(*) FROM d) = 0, 'TD3 branch_scope still applies: an unrelated branch cannot delete a draft line');
WITH d AS (DELETE FROM inventory.lot_line WHERE id = '00000000-0000-0000-0000-0000009871b6' RETURNING id)
  SELECT pg_temp.check((SELECT count(*) FROM d) = 0, 'LD3 branch_scope still applies: an unrelated branch cannot delete an open lot line');
SELECT set_config('app.branch_scope', '', false) \g /dev/null
SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000002', false) \g /dev/null
WITH d AS (DELETE FROM inventory.lot_line WHERE id = '00000000-0000-0000-0000-0000009871b6' RETURNING id)
  SELECT pg_temp.check((SELECT count(*) FROM d) = 0, 'LD4 another tenant cannot delete an open, untagged lot line (0 rows)');
WITH d AS (DELETE FROM inventory.stock_transfer_line WHERE id = '00000000-0000-0000-0000-0000009871d7' RETURNING id)
  SELECT pg_temp.check((SELECT count(*) FROM d) = 0, 'TD4 another tenant cannot delete a draft transfer line (0 rows)');
SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000001', false) \g /dev/null
SELECT pg_temp.check((SELECT count(*) FROM inventory.lot_line WHERE id = '00000000-0000-0000-0000-0000009871b6') = 1 AND (SELECT count(*) FROM inventory.stock_transfer_line WHERE id = '00000000-0000-0000-0000-0000009871d7') = 1,
  'LD4/TD4 the tenant-1 lines survived the tenant-2 and other-branch attempts');
SELECT pg_temp.check((SELECT string_agg(polname || ':' || polcmd::text || ':' || CASE WHEN polpermissive THEN 'permissive' ELSE 'restrictive' END || ':' || array_to_string(ARRAY(SELECT rolname FROM pg_roles WHERE oid = ANY (polroles)), ','), ' ' ORDER BY polname)
                      FROM pg_policy WHERE polname IN ('rw_delete_open_lot_only','rw_delete_draft_only'))
                     = 'rw_delete_draft_only:d:restrictive:app_rw rw_delete_open_lot_only:d:restrictive:app_rw'
                 AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid IN ('inventory.lot_line'::regclass, 'inventory.stock_transfer_line'::regclass) AND NOT tgisinternal
                                 AND tgtype & 8 = 8 AND tgname <> 'zz_audit')
                 AND (SELECT count(*) FROM pg_trigger WHERE tgrelid IN ('inventory.lot_line'::regclass, 'inventory.stock_transfer_line'::regclass) AND tgname = 'zz_audit' AND tgtype & 8 = 8) = 2,
  'LD5 enforcement: RESTRICTIVE FOR DELETE policies TO app_rw; no delete trigger except zz_audit (fires on DELETE on both tables)');
SELECT pg_temp.check((SELECT string_agg(DISTINCT coalesce(g.rolname, 'PUBLIC'), ',') FROM pg_class c, aclexplode(c.relacl) a LEFT JOIN pg_roles g ON g.oid = a.grantee
                      WHERE c.oid IN ('inventory.lot_line'::regclass, 'inventory.stock_transfer_line'::regclass) AND a.privilege_type = 'DELETE' AND a.grantee <> c.relowner) = 'app_rw'
                 AND NOT has_table_privilege('app_ro', 'inventory.lot_line', 'DELETE') AND NOT has_table_privilege('app_worker', 'inventory.lot_line', 'DELETE')
                 AND NOT has_table_privilege('inventory_writer', 'inventory.lot_line', 'DELETE') AND NOT has_table_privilege('purchases_writer', 'inventory.lot_line', 'DELETE')
                 AND NOT has_table_privilege('app_ro', 'inventory.stock_transfer_line', 'DELETE') AND NOT has_table_privilege('app_worker', 'inventory.stock_transfer_line', 'DELETE')
                 AND NOT has_table_privilege('inventory_writer', 'inventory.stock_transfer_line', 'DELETE') AND NOT has_table_privilege('sales_writer', 'inventory.stock_transfer_line', 'DELETE'),
  'LD6 DELETE on lot_line / stock_transfer_line granted to app_rw only; app_ro, app_worker and module writers have none');

\echo '--- grants per role'
SELECT pg_temp.check(pg_temp.acl_is('inventory.shop_setting', ARRAY['app_rw:SELECT','app_rw:INSERT','app_rw:UPDATE','app_ro:SELECT'] || pg_temp.writers_select())
                 AND pg_temp.acl_is('inventory.tag_counter', ARRAY['app_rw:SELECT','app_rw:INSERT','app_rw:UPDATE','app_ro:SELECT'] || pg_temp.writers_select())
                 AND pg_temp.acl_is('inventory.tag_photo', ARRAY['app_rw:SELECT','app_rw:INSERT','app_rw:UPDATE','app_rw:DELETE','app_ro:SELECT'] || pg_temp.writers_select())
                 AND pg_temp.acl_is('inventory.location_move', ARRAY['app_rw:SELECT','app_rw:INSERT','app_ro:SELECT'] || pg_temp.writers_select())
                 AND pg_temp.acl_is('inventory.stock_take_scan', ARRAY['app_rw:SELECT','app_rw:DELETE','app_rw:INSERT(tenant_id)','app_rw:INSERT(id)','app_rw:INSERT(stock_take_id)','app_rw:INSERT(scanned_code)','app_rw:INSERT(tag_id)','app_rw:INSERT(scanned_by)','app_rw:INSERT(scanned_at)','app_rw:INSERT(result)','app_rw:INSERT(extra_reason)','app_rw:INSERT(extra_note)','app_rw:UPDATE(duplicate_count)','app_rw:UPDATE(last_duplicate_at)','app_ro:SELECT'] || pg_temp.writers_select())
                 AND pg_temp.acl_is('inventory.stock_adjustment', ARRAY['app_rw:SELECT','app_rw:INSERT','app_rw:UPDATE','app_ro:SELECT'] || pg_temp.writers_select()),
  'GR1 new tables: app_rw as listed (no DELETE except photos/scans), app_ro + module writers SELECT, nothing for PUBLIC/app_worker');
SELECT pg_temp.check(pg_temp.acl_is('inventory.v_stock_valuation', ARRAY['app_rw:SELECT','app_ro:SELECT']) AND pg_temp.acl_is('inventory.v_tag_ageing', ARRAY['app_rw:SELECT','app_ro:SELECT'])
                 AND pg_temp.acl_is('inventory.v_stock_take_report', ARRAY['app_rw:SELECT','app_ro:SELECT']) AND pg_temp.acl_is('inventory.v_tag_label', ARRAY['app_rw:SELECT','app_ro:SELECT'])
                 AND pg_temp.acl_is('inventory.v_loose_stock', ARRAY['app_rw:SELECT','app_ro:SELECT','inventory_writer:SELECT'])
                 AND pg_temp.acl_is('inventory.v_tag_stock_location', ARRAY['app_rw:SELECT','app_ro:SELECT','inventory_writer:SELECT'])
                 AND (SELECT bool_and(c.reloptions @> ARRAY['security_invoker=true']) FROM pg_class c WHERE c.relnamespace = 'inventory'::regnamespace AND c.relkind = 'v' AND c.relname IN ('v_tag_label','v_loose_stock','v_tag_stock_location','v_stock_take_report','v_stock_valuation','v_tag_ageing')) ,
  'GR2 views: app_rw + app_ro SELECT (inventory_writer: loose/location balances); all security_invoker');
SELECT pg_temp.check(has_column_privilege('app_rw', 'inventory.tag', 'label_print_count', 'UPDATE') AND has_column_privilege('app_rw', 'inventory.tag', 'design_id', 'UPDATE')
                 AND has_column_privilege('app_rw', 'inventory.tag', 'counter_id', 'UPDATE')
                 AND NOT has_column_privilege('app_rw', 'inventory.tag', 'tag_no', 'UPDATE') AND NOT has_column_privilege('app_rw', 'inventory.tag', 'gross_wt', 'UPDATE')
                 AND NOT has_column_privilege('app_rw', 'inventory.tag', 'version', 'UPDATE') AND NOT has_column_privilege('app_rw', 'inventory.tag', 'rfid_epc', 'UPDATE')
                 AND has_column_privilege('inventory_writer', 'inventory.tag', 'gross_wt', 'UPDATE') AND has_column_privilege('inventory_writer', 'inventory.tag', 'status', 'UPDATE')
                 AND NOT has_column_privilege('inventory_writer', 'inventory.tag', 'tag_no', 'UPDATE') AND NOT has_column_privilege('sales_writer', 'inventory.tag', 'gross_wt', 'UPDATE')
                 AND NOT has_table_privilege('app_rw', 'inventory.tag', 'DELETE'),
  'GR3 tag columns: app_rw label/design/location; tag_no, weights, version, rfid never via app_rw; inventory_writer status/branch/weights; no DELETE');
SELECT pg_temp.check(NOT has_table_privilege('app_worker', 'inventory.shop_setting', 'SELECT') AND NOT has_table_privilege('app_worker', 'inventory.v_stock_valuation', 'SELECT')
                 AND NOT has_table_privilege('app_ro', 'inventory.stock_adjustment', 'INSERT') AND NOT has_table_privilege('app_ro', 'inventory.tag_counter', 'UPDATE')
                 AND NOT has_table_privilege('inventory_writer', 'inventory.stock_adjustment', 'UPDATE') AND NOT has_table_privilege('sales_writer', 'inventory.location_move', 'INSERT'),
  'GR4 app_worker no inventory access; app_ro and module writers read-only on the new tables');
SELECT pg_temp.check((SELECT string_agg(r || '=' || n, ' ' ORDER BY r) FROM (
                        SELECT role_code AS r, count(*) AS n FROM platform.system_role_permission WHERE permission_code LIKE 'inventory.%'
                          AND permission_code NOT IN ('inventory.tag.view_cost','inventory.transfer.approve') GROUP BY role_code) x)
                     = 'cashier=1 manager=15 owner=16 salesperson=4',
  'GR5 16 new inventory permissions: owner all, manager all but settings.edit, salesperson view/print/scan/move, cashier view');
SELECT pg_temp.check((SELECT string_agg(permission_code, ',' ORDER BY permission_code COLLATE "C") FROM platform.system_role_permission WHERE role_code = 'salesperson' AND permission_code LIKE 'inventory.%')
                     = 'inventory.move,inventory.stock.view,inventory.stock_check.run,inventory.tag.print_label',
  'GR6 salesperson inventory permissions: move, stock.view, stock_check.run, tag.print_label');
SELECT pg_temp.check((SELECT string_agg(conrelid::regclass::text, ',' ORDER BY 1) FROM pg_constraint WHERE contype = 'f' AND confrelid = 'platform.permission'::regclass) = 'platform.system_role_permission',
  'GR6 role permissions are only the global system_role_permission catalogue: every shop''s salesperson role gets inventory.move, no per-tenant rows to backfill');
\echo 'ALL INVENTORY (987–989) TESTS DONE'
