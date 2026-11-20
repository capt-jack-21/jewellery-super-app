-- 991-993 sales (freeze S1-S23 + Ironhide contract 0.9.0 needs + relayed lead defaults). Run as app_rw after run_inventory_tests.sql. TEST DB ONLY.
-- Every invoice this file COMMITS is on branch CBE (b001), so the 30-way concurrency check in run_all.sh
-- (count(*) = max(doc_seq) for tenant 1) still holds; credit-sale / excess / 0% GST / MDU issues are rolled back.
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
-- insert one row from a jsonb object (only the keys given are inserted, so column defaults / grants apply) -> id
CREATE FUNCTION pg_temp.ins(p_tbl regclass, p jsonb) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE c text; r uuid;
BEGIN
  SELECT string_agg(quote_ident(k), ',') INTO c FROM jsonb_object_keys(p) k;
  EXECUTE format('INSERT INTO %s (%s) SELECT %s FROM jsonb_populate_record(NULL::%s, $1) RETURNING id', p_tbl, c, c, p_tbl) INTO r USING p;
  RETURN r;
END $$;
CREATE FUNCTION pg_temp.bad(p_tbl text, p jsonb, p_label text, p_like text) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.expect_error(format('SELECT pg_temp.ins(%L::regclass, %L::jsonb)', p_tbl, p::text), p_label, p_like) $$;
CREATE FUNCTION pg_temp.policies(p_tbl regclass) RETURNS text LANGUAGE sql AS $$
  SELECT string_agg(polname, ',' ORDER BY polname) FROM pg_policy WHERE polrelid = p_tbl $$;
-- any table-level / column-level grant of p_priv on p_tbl, to anyone but the owner
CREATE FUNCTION pg_temp.granted(p_tbl regclass, p_priv text) RETURNS text LANGUAGE sql AS $$
  SELECT coalesce(string_agg(DISTINCT coalesce(g.rolname, 'PUBLIC'), ',' ORDER BY coalesce(g.rolname, 'PUBLIC')), '') FROM (
    SELECT a.grantee FROM pg_class c, aclexplode(c.relacl) a WHERE c.oid = p_tbl AND a.grantee <> c.relowner AND a.privilege_type = p_priv
    UNION ALL
    SELECT a.grantee FROM pg_attribute att JOIN pg_class c ON c.oid = att.attrelid, aclexplode(att.attacl) a
    WHERE att.attrelid = p_tbl AND att.attacl IS NOT NULL AND a.grantee <> c.relowner AND a.privilege_type = p_priv) x
  LEFT JOIN pg_roles g ON g.oid = x.grantee $$;

SELECT set_config('app.tenant_id','00000000-0000-0000-0000-000000000001',false),
       set_config('app.user_id','00000000-0000-0000-0000-000000000a01',false),
       set_config('app.partner_id','',false), set_config('app.branch_scope','',false) \g /dev/null

\echo '--- SS fixtures (tenant 1, CBE): salesperson, tag SLT-01, rule / rate ids'
INSERT INTO hr.staff(tenant_id, id, code, name, branch_id, is_salesperson)
VALUES (platform.current_tenant(), '00000000-0000-0000-0000-0000000991a1', 'SP-991', 'Meena (sales)', '00000000-0000-0000-0000-00000000b001', true);
INSERT INTO inventory.tag(tenant_id, id, branch_id, tag_no, item_id, purity_id, hallmark_exempt, gross_wt, net_wt, mc_type, counter_id, box_id)
VALUES (platform.current_tenant(), '00000000-0000-0000-0000-0000000991f1', '00000000-0000-0000-0000-00000000b001', 'SLT-01',
        '00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000022', true, 4.000, 4.000, 'per_gram',
        '00000000-0000-0000-0000-0000000c9871', '00000000-0000-0000-0000-0000000b9871');
SELECT (SELECT id FROM masters.tax_rule WHERE scope = 'tenant' AND code = 'GOLD_JEWELLERY') AS rule_id,
       (SELECT id FROM masters.tax_rule WHERE scope = 'platform' AND code = 'ZERO_RATED') AS zero_rule_id,
       (SELECT id FROM rates.metal_rate WHERE kind = 'sale' LIMIT 1) AS sale_rate,
       (SELECT id FROM rates.metal_rate WHERE kind = 'old_metal' LIMIT 1) AS om_rate,
       platform.fy_of((now() AT TIME ZONE 'Asia/Kolkata')::date) AS ist_fy \gset

\echo '--- SS1 structure: new tables, columns, RLS policies, house triggers, NOT VALID list'
SELECT pg_temp.check((SELECT count(*) FROM pg_class WHERE oid IN ('sales.shop_setting'::regclass, 'sales.invoice_due'::regclass, 'sales.payment_receipt'::regclass,
                        'sales.payment_receipt_tender'::regclass, 'sales.document_print'::regclass) AND relrowsecurity AND relforcerowsecurity) = 5,
  'SS1a 5 new sales tables, RLS enabled + forced');
SELECT pg_temp.check(pg_temp.policies('sales.shop_setting') = 'no_partner_access,tenant_isolation'
                 AND pg_temp.policies('sales.invoice_due') = 'branch_scope,insert_at_issue,no_partner_access,tenant_isolation'
                 AND pg_temp.policies('sales.payment_receipt') = 'branch_scope,insert_against_due,no_partner_access,tenant_isolation'
                 AND pg_temp.policies('sales.payment_receipt_tender') = 'insert_with_receipt,no_partner_access,tenant_isolation'
                 AND pg_temp.policies('sales.document_print') = 'branch_scope,no_partner_access,print_cancelled_snapshot,printed_by_self,tenant_isolation'
                 AND pg_temp.policies('sales.estimate') LIKE '%edit_until_closed%insert_not_billed%',
  'SS1b policies: ' || pg_temp.policies('sales.invoice_due') || ' / ' || pg_temp.policies('sales.payment_receipt') || ' / ' || pg_temp.policies('sales.payment_receipt_tender')
  || ' / ' || pg_temp.policies('sales.document_print') || ' / estimate ' || pg_temp.policies('sales.estimate'));
SELECT pg_temp.check((SELECT string_agg(tgrelid::regclass::text, ',' ORDER BY tgrelid::regclass::text) FROM pg_trigger
                      WHERE tgname = 'aa_version' AND tgfoid = 'platform.bump_version'::regproc AND tgrelid IN ('sales.shop_setting'::regclass,
                        'sales.estimate'::regclass, 'sales.invoice_due'::regclass)) = 'sales.estimate,sales.invoice_due,sales.shop_setting'
                 AND (SELECT count(*) FROM pg_trigger WHERE tgname = 'zz_audit' AND tgrelid IN ('sales.shop_setting'::regclass, 'sales.invoice_due'::regclass,
                        'sales.payment_receipt'::regclass, 'sales.payment_receipt_tender'::regclass, 'sales.document_print'::regclass,
                        'sales.invoice_old_metal'::regclass)) = 6,
  'SS1c aa_version on shop_setting / estimate / invoice_due; zz_audit on the 5 new tables + invoice_old_metal (rate overrides)');
SELECT pg_temp.check(NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                       WHERE c.relnamespace = 'sales'::regnamespace AND NOT t.tgisinternal
                         AND c.relname IN ('shop_setting','invoice_due','payment_receipt','payment_receipt_tender','document_print')
                         AND t.tgname NOT IN ('aa_version','zz_audit')),
  'SS1d no triggers on the new tables beyond aa_version / zz_audit (no new DB functions)');
SELECT pg_temp.check((SELECT count(*) FROM pg_attribute WHERE attrelid = 'sales.invoice'::regclass AND NOT attisdropped AND attname IN
                       ('row_rev','supply_type','customer_gstin','making_gst_treatment','round_off_to','cess','zero_gst','zero_gst_reason','zero_gst_print_note',
                        'bill_discount','discount_reason','old_gold_excess','old_gold_excess_payout','pan_required','pan_on_file','cash_amount','warnings',
                        'credit_sale','making_service_rate')) = 19
                 AND (SELECT count(*) FROM pg_attribute WHERE attrelid = 'sales.invoice_line'::regclass AND NOT attisdropped AND attname IN
                       ('stock_kind','purity_id','counter_id','box_id','chargeable_wt','gross_value','bill_discount_share','cess')) = 8
                 AND (SELECT count(*) FROM pg_attribute WHERE attrelid = 'sales.invoice_old_metal'::regclass AND NOT attisdropped AND attname IN
                       ('valuation_basis','server_rate_per_g','override_rate_per_g','override_reason','overridden_by','rate_overridden','inventory_ref_id')) = 7
                 AND (SELECT attgenerated FROM pg_attribute WHERE attrelid = 'sales.invoice_old_metal'::regclass AND attname = 'rate_overridden') = 's'
                 AND (SELECT count(*) FROM pg_attribute WHERE attrelid = 'sales.invoice_payment'::regclass AND NOT attisdropped AND attname IN
                       ('payment_mode_id','card_machine_id','cheque_date','bank_name')) = 4
                 AND (SELECT count(*) FROM pg_attribute WHERE attrelid = 'sales.credit_note'::regclass AND NOT attisdropped AND attname IN
                       ('row_rev','customer_id','customer_snapshot','cess','round_off','refund_amount','due_reduced','store_credit_amount')) = 8
                 AND (SELECT count(*) FROM pg_attribute WHERE attrelid = 'sales.credit_note_line'::regclass AND NOT attisdropped AND attname IN
                       ('cess','stock_kind','restock_counter_id','restock_box_id')) = 4
                 AND (SELECT count(*) FROM pg_attribute WHERE attrelid = 'sales.estimate'::regclass AND NOT attisdropped AND attname IN
                       ('row_rev','version','computation','notes','updated_by','updated_at')) = 6
                 AND NOT EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = 'sales'::regnamespace
                                 AND NOT a.attisdropped AND a.attname ~ 'aadhaar|pan_enc|pan_no|^pan$'),
  'SS1e new columns: invoice 19 (incl. 0.9.1 credit_sale, making_service_rate), line 8, old metal 7 (incl. 0.9.1 overridden_by, generated rate_overridden), payment 4, credit note 8, credit-note line 4, estimate 6; no Aadhaar / PAN value column in sales');
SELECT pg_temp.check((SELECT count(*)=0 FROM pg_constraint WHERE NOT convalidated AND connamespace='sales'::regnamespace),
 'SS1f 999 validates all 19 documented legacy Sales constraints');
SELECT pg_temp.check(NOT has_column_privilege('sales_writer', 'sales.invoice', 'row_rev', 'INSERT') AND NOT has_column_privilege('sales_writer', 'sales.credit_note', 'row_rev', 'INSERT')
                 AND NOT has_column_privilege('app_rw', 'sales.estimate', 'row_rev', 'INSERT') AND NOT has_column_privilege('app_rw', 'sales.estimate', 'row_rev', 'UPDATE')
                 AND NOT has_column_privilege('sales_writer', 'sales.estimate', 'row_rev', 'UPDATE')
                 AND has_column_privilege('sales_writer', 'sales.invoice', 'cash_amount', 'INSERT') AND has_column_privilege('app_rw', 'sales.estimate', 'computation', 'UPDATE'),
  'SS1g row_rev (0.9.0 rules marker; NULL = legacy row) is server-set: not insertable / updatable by any app role');

\echo '--- SD settings defaults and CHECKs'
SELECT pg_temp.check(NOT EXISTS (SELECT 1 FROM sales.shop_setting), 'SD1 no settings row yet (app falls back to column defaults)');
INSERT INTO sales.shop_setting(tenant_id, updated_by) VALUES (platform.current_tenant(), platform.current_user_id());
SELECT pg_temp.check((SELECT making_gst_treatment || '|' || coalesce(making_tax_rule_code, '-') || '|' || coalesce(making_service_rate::text, '-') || '|' || credit_note_rounding || '|' || pan_required_above
                             || '|' || cash_limit_amount || '|' || cash_limit_mode || '|' || discount_warn_pct || '|' || discount_override_pct
                             || '|' || zero_gst_print_note || '|' || estimate_validity_days || '|' || default_paper || '|' || return_window_days
                             || '|' || return_refund_default || '|' || old_gold_enabled || '|' || old_gold_valuation_basis || '|' || old_gold_excess_handling
                             || '|' || version FROM sales.shop_setting)
  = 'composite|-|-|follow_invoice|200000.00|200000.00|block|5.00|10.00|GST charged at 0%|0|A4|15|store_credit|true|stated_purity|separate_purchase|1',
  'SD2 defaults: composite making GST, no separate-making rule, making_service_rate NULL (no default), PAN 2 lakh, cash limit 2 lakh block, discount warn 5% / override 10%, 0% note, A4, 15-day returns: '
  || (SELECT making_gst_treatment || '|' || coalesce(making_tax_rule_code, '-') || '|' || coalesce(making_service_rate::text, '-') || '|' || credit_note_rounding || '|' || pan_required_above
                             || '|' || cash_limit_amount || '|' || cash_limit_mode || '|' || discount_warn_pct || '|' || discount_override_pct
                             || '|' || zero_gst_print_note || '|' || estimate_validity_days || '|' || default_paper || '|' || return_window_days
                             || '|' || return_refund_default || '|' || old_gold_enabled || '|' || old_gold_valuation_basis || '|' || old_gold_excess_handling
                             || '|' || version FROM sales.shop_setting));
SELECT pg_temp.expect_error($$INSERT INTO sales.shop_setting(tenant_id) VALUES (platform.current_tenant())$$, 'SD3 one settings row per shop', '%shop_setting_one_per_shop%');
SELECT pg_temp.expect_error($$UPDATE sales.shop_setting SET making_service_rate = 0$$, 'SD4 making_service_rate is a GST % with 0 < rate <= 100', '%shop_setting_making_service_rate_check%');
SELECT pg_temp.expect_error($$UPDATE sales.shop_setting SET making_service_rate = 100.01$$, 'SD4b making_service_rate <= 100', '%shop_setting_making_service_rate_check%');
SELECT pg_temp.expect_error($$UPDATE sales.shop_setting SET cash_limit_mode = 'ignore'$$, 'SD5 cash_limit_mode warn | block only', '%cash_limit_mode_check%');
SELECT pg_temp.expect_error($$UPDATE sales.shop_setting SET discount_warn_pct = 12$$, 'SD6 discount warning threshold <= override threshold', '%shop_setting_discount_order_check%');
SELECT pg_temp.expect_error($$UPDATE sales.shop_setting SET default_paper = 'A3'$$, 'SD7 paper A4 | A5 | thermal_80mm', '%default_paper_check%');
SELECT pg_temp.expect_error($$UPDATE sales.shop_setting SET receipt_no_format = 'RCT-FIXED'$$, 'SD8 receipt number format must contain {SEQ}', '%receipt_no_format_check%');
WITH u AS (UPDATE sales.shop_setting SET making_gst_treatment = 'separate', cash_limit_mode = 'warn' RETURNING version)
  SELECT pg_temp.check((SELECT version FROM u) = 2, 'SD9 separate mode may be set without a rule code or rate (app blocks billing while the rate is NULL); edit bumps version');
WITH u AS (UPDATE sales.shop_setting SET making_service_rate = 18.00 RETURNING making_service_rate)
  SELECT pg_temp.check((SELECT making_service_rate FROM u) = 18.00, 'SD9b per-shop making_service_rate set (18.00 %)');
UPDATE sales.shop_setting SET making_gst_treatment = 'composite', making_service_rate = NULL, cash_limit_mode = 'block';
SELECT pg_temp.expect_error($$DELETE FROM sales.shop_setting$$, 'SD10 settings row cannot be deleted', '%permission denied%');
SELECT pg_temp.check(EXISTS (SELECT 1 FROM platform.audit_event WHERE table_name = 'sales.shop_setting' AND action = 'UPDATE'), 'SD11 settings changes audited (zz_audit)');
SELECT pg_temp.check((SELECT rate = 0 AND cgst_rate = 0 AND sgst_rate = 0 AND igst_rate = 0 AND component = 'other' FROM masters.tax_rule WHERE scope = 'platform' AND code = 'ZERO_RATED')
                 AND NOT EXISTS (SELECT 1 FROM masters.tax_rule WHERE code ILIKE '%MAKING_SEPARATE%'),
  'SD12 platform ZERO_RATED rule seeded (0/0/0/0); no separate-making rule seeded (awaits CA)');

\echo '--- SP permissions (global catalogue, preset roles)'
SELECT (SELECT string_agg(code || ':' || roles, ' ' ORDER BY code) FROM (
          SELECT p.permission_code AS code, string_agg(p.role_code, ',' ORDER BY p.role_code) AS roles FROM platform.system_role_permission p
          WHERE p.permission_code IN ('sales.invoice.view','sales.estimate.create','sales.payment.receive','sales.invoice.reprint','sales.invoice.zero_gst',
                                      'sales.invoice.credit_sale','sales.old_gold.rate_override','sales.settings.edit','sales.receipt.reverse')
          GROUP BY p.permission_code) x) AS perm_map \gset
SELECT pg_temp.check(:'perm_map'
  = 'sales.estimate.create:cashier,manager,owner,salesperson sales.invoice.credit_sale:manager,owner sales.invoice.reprint:cashier,manager,owner '
    'sales.invoice.view:cashier,manager,owner,salesperson sales.invoice.zero_gst:owner sales.old_gold.rate_override:manager,owner '
    'sales.payment.receive:cashier,manager,owner sales.receipt.reverse:manager,owner sales.settings.edit:owner',
  'SP1 9 new codes, approved mapping (zero_gst owner only; credit_sale / old-gold override / receipt.reverse owner+manager; settings.edit owner only): ' || :'perm_map');

\echo '--- SG grants: money documents written only by sales_writer, never updated except the listed due columns, never deleted'
SELECT pg_temp.check(pg_temp.granted('sales.invoice_due', 'INSERT') = 'sales_writer' AND pg_temp.granted('sales.invoice_due', 'UPDATE') = 'sales_writer'
                 AND pg_temp.granted('sales.payment_receipt', 'INSERT') = 'sales_writer' AND pg_temp.granted('sales.payment_receipt', 'UPDATE') = ''
                 AND pg_temp.granted('sales.payment_receipt_tender', 'INSERT') = 'sales_writer' AND pg_temp.granted('sales.payment_receipt_tender', 'UPDATE') = ''
                 AND pg_temp.granted('sales.document_print', 'INSERT') = 'sales_writer' AND pg_temp.granted('sales.document_print', 'UPDATE') = ''
                 AND pg_temp.granted('sales.shop_setting', 'UPDATE') = 'app_rw' AND pg_temp.granted('sales.invoice', 'INSERT') = 'sales_writer',
  'SG1 writers: dues / receipts / tenders / prints = sales_writer (receipts and prints append-only); settings = app_rw');
SELECT pg_temp.check(pg_temp.granted('sales.invoice_due', 'DELETE') || pg_temp.granted('sales.payment_receipt', 'DELETE') || pg_temp.granted('sales.payment_receipt_tender', 'DELETE')
                     || pg_temp.granted('sales.document_print', 'DELETE') || pg_temp.granted('sales.shop_setting', 'DELETE')
                     || pg_temp.granted('sales.invoice_due', 'TRUNCATE') || pg_temp.granted('sales.payment_receipt', 'TRUNCATE') || pg_temp.granted('sales.document_print', 'TRUNCATE') = '',
  'SG2 nobody (but the owner) can DELETE / TRUNCATE dues, receipts, tenders, prints, settings');
SELECT pg_temp.check(NOT has_column_privilege('sales_writer', 'sales.payment_receipt', 'received_at', 'INSERT') AND NOT has_column_privilege('sales_writer', 'sales.payment_receipt', 'received_on', 'INSERT')
                 AND NOT has_column_privilege('sales_writer', 'sales.invoice_due', 'received_after_issue', 'INSERT') AND NOT has_column_privilege('sales_writer', 'sales.invoice_due', 'original_due', 'UPDATE')
                 AND NOT has_column_privilege('sales_writer', 'sales.document_print', 'printed_at', 'INSERT')
                 AND NOT has_table_privilege('app_ro', 'sales.document_print', 'INSERT') AND NOT has_table_privilege('app_ro', 'sales.payment_receipt', 'INSERT'),
  'SG3 server-set columns (received_on/at, printed_at) and fixed amounts not writable');
SELECT pg_temp.check(NOT has_column_privilege('sales_writer', 'sales.invoice', 'zero_gst', 'UPDATE') AND NOT has_column_privilege('sales_writer', 'sales.invoice', 'bill_discount', 'UPDATE')
                 AND NOT has_column_privilege('sales_writer', 'sales.invoice', 'warnings', 'UPDATE') AND NOT has_column_privilege('sales_writer', 'sales.invoice', 'customer_gstin', 'UPDATE')
                 AND NOT has_table_privilege('sales_writer', 'sales.invoice_line', 'UPDATE') AND NOT has_table_privilege('sales_writer', 'sales.invoice_old_metal', 'UPDATE')
                 AND NOT has_column_privilege('sales_writer', 'sales.credit_note', 'refund_amount', 'UPDATE') AND NOT has_column_privilege('sales_writer', 'sales.credit_note', 'store_credit_amount', 'UPDATE')
                 AND NOT has_table_privilege('sales_writer', 'sales.credit_note', 'DELETE'),
  'SG4 new bill / line / old-gold / credit-note columns are insert-only (no edit after issue)');
SELECT pg_temp.check(has_table_privilege('app_ro', 'sales.v_invoice_list', 'SELECT') AND has_table_privilege('app_ro', 'sales.v_invoice_balance', 'SELECT')
                 AND NOT has_table_privilege('app_ro', 'sales.shop_setting', 'UPDATE') AND NOT has_table_privilege('app_worker', 'sales.payment_receipt', 'SELECT')
                 AND NOT has_table_privilege('app_worker', 'sales.shop_setting', 'SELECT') AND NOT has_table_privilege('inventory_writer', 'sales.payment_receipt', 'INSERT'),
  'SG5 app_ro reads the views for Reports, app_worker no access, inventory_writer cannot write receipts');

\echo '--- SE estimates: own counter (gaps OK), version, cancelled / expired / billed are frozen'
BEGIN;
INSERT INTO platform.doc_counter(tenant_id, branch_id, doc_type, fy, prefix)
VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', 'estimate', :'ist_fy', 'EST-') ON CONFLICT DO NOTHING;
UPDATE platform.doc_counter SET next_no = next_no + 2 WHERE tenant_id = platform.current_tenant() AND branch_id = '00000000-0000-0000-0000-00000000b001'
   AND doc_type = 'estimate' AND fy = :'ist_fy'
RETURNING 'EST-CBE-' || replace(substr(fy, 3), '-', '') || '-' || lpad((next_no - 2)::text, 5, '0') AS est_no,
          'EST-CBE-' || replace(substr(fy, 3), '-', '') || '-' || lpad((next_no - 1)::text, 5, '0') AS est_no_b \gset
INSERT INTO sales.estimate(tenant_id, branch_id, estimate_no, customer_id, salesperson_id, created_by, computation)
VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', :'est_no', '00000000-0000-0000-0000-000000000d01',
        '00000000-0000-0000-0000-0000000991a1', platform.current_user_id(), '{"lines":[{"tag":"SLT-01"}],"total":29298.36}') RETURNING id AS est_id \gset
INSERT INTO sales.estimate(tenant_id, branch_id, estimate_no, customer_id, created_by, computation)
VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', :'est_no_b', '00000000-0000-0000-0000-000000000d01', platform.current_user_id(),
        '{"lines":[{"loose":"22K","net_wt":2}]}') RETURNING id AS est_b \gset
COMMIT;
SELECT pg_temp.check((SELECT count(*) FROM sales.estimate WHERE id IN (:'est_id', :'est_b') AND row_rev = 1 AND version = 1 AND status = 'draft') = 2,
  'SE1 two estimates numbered from platform.doc_counter (estimate); row_rev 1, version 1, draft');
SELECT pg_temp.expect_error($$INSERT INTO platform.doc_counter(tenant_id, branch_id, doc_type, fy, prefix)
   VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', 'tax_invoice', '2099-00', 'X')$$, 'SE2 doc_counter can never number tax invoices', '%check%');
WITH u AS (UPDATE sales.estimate SET notes = 'Customer wants size 14', computation = '{"lines":[{"tag":"SLT-01"}],"total":29000}', updated_by = platform.current_user_id(),
           updated_at = now() WHERE id = :'est_id' AND version = 1 RETURNING version)
  SELECT pg_temp.check((SELECT version FROM u) = 2, 'SE3 open estimate editable with If-Match (version 1 -> 2)');
SELECT pg_temp.expect_error(format($q$UPDATE sales.estimate SET status = 'billed', invoice_id = (SELECT id FROM sales.invoice ORDER BY doc_seq LIMIT 1) WHERE id = %L$q$, :'est_id'),
  'SE4 app_rw cannot mark an estimate billed (only sales_writer while issuing)', '%row-level security%');
SELECT pg_temp.expect_error(format($q$UPDATE sales.estimate SET invoice_id = (SELECT id FROM sales.invoice ORDER BY doc_seq LIMIT 1) WHERE id = %L$q$, :'est_id'),
  'SE5 invoice_id only together with status billed', '%estimate_billed_check%');
SELECT pg_temp.expect_error($$INSERT INTO sales.estimate(tenant_id, branch_id, estimate_no, status, invoice_id, created_by)
   VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', 'EST-X', 'billed', (SELECT id FROM sales.invoice ORDER BY doc_seq LIMIT 1), platform.current_user_id())$$,
  'SE6 an estimate cannot be inserted as billed', '%row-level security%');
SELECT pg_temp.expect_error(format($q$UPDATE sales.estimate SET computation = '[]' WHERE id = %L$q$, :'est_b'), 'SE7 computation must be a JSON object', '%estimate_computation_check%');
SELECT pg_temp.expect_error(format($q$UPDATE sales.estimate SET row_rev = NULL WHERE id = %L$q$, :'est_b'), 'SE8 row_rev not updatable by the app', '%permission denied%');
INSERT INTO sales.estimate(tenant_id, branch_id, estimate_no, created_by) VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', 'EST-CXL-1', platform.current_user_id()) RETURNING id AS est_c \gset
UPDATE sales.estimate SET status = 'cancelled' WHERE id = :'est_c';
WITH u AS (UPDATE sales.estimate SET status = 'draft' WHERE id = :'est_c' RETURNING 1) SELECT pg_temp.check(count(*) = 0, 'SE9 cancelled estimate is frozen (status cancelled added)') FROM u;
INSERT INTO sales.estimate(tenant_id, branch_id, estimate_no, created_by) VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', 'EST-EXP-1', platform.current_user_id()) RETURNING id AS est_x \gset
UPDATE sales.estimate SET status = 'expired' WHERE id = :'est_x';
WITH u AS (UPDATE sales.estimate SET notes = 'x' WHERE id = :'est_x' RETURNING 1) SELECT pg_temp.check(count(*) = 0, 'SE10 expired estimate is frozen') FROM u;
INSERT INTO sales.estimate(tenant_id, branch_id, estimate_no, created_by) VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', 'EST-OPEN-1', platform.current_user_id()) RETURNING id AS est_d \gset

\echo '--- SI issue one part-paid B2B bill merging 2 estimates: tag + loose lines, bill discount, old gold at an override rate, split tenders, due row, stock moved'
BEGIN;
SET LOCAL ROLE sales_writer;
UPDATE sales.doc_series SET next_no = next_no + 1
 WHERE tenant_id = platform.current_tenant() AND branch_id = '00000000-0000-0000-0000-00000000b001' AND doc_type = 'tax_invoice' AND fy = platform.fy_of(current_date)
RETURNING next_no - 1 AS seq, prefix, fy \gset
SELECT jsonb_build_object('tenant_id', platform.current_tenant(), 'branch_id', '00000000-0000-0000-0000-00000000b001', 'company_id', '00000000-0000-0000-0000-00000000c001',
   'fy', :'fy', 'doc_seq', :seq, 'doc_no', :'prefix' || lpad(:'seq', 6, '0'), 'customer_id', '00000000-0000-0000-0000-000000000d01',
   'customer_snapshot', '{"name":"Priya","phone":"9876543210","gstin":"33AAAAA0000A1Z5"}'::jsonb, 'seller_gstin', '33ABCDE1234F1Z5', 'place_of_supply', '33',
   'gst_type', 'intra', 'salesperson_id', '00000000-0000-0000-0000-0000000991a1', 'rate_snapshot', '{"22K":7000,"old_22K":6800}'::jsonb,
   'gross_value', 43445, 'discount', 645, 'bill_discount', 200, 'discount_reason', 'Festival offer', 'taxable_value', 42800, 'cgst', 642, 'sgst', 642, 'igst', 0, 'cess', 0,
   'round_off', 0, 'round_off_to', 1.00, 'invoice_total', 44084, 'old_metal_value', 9800, 'net_payable', 34284, 'paid_amount', 20000, 'balance_due', 14284,
   'supply_type', 'b2b', 'customer_gstin', '33AAAAA0000A1Z5', 'making_gst_treatment', 'composite', 'pan_required', false, 'pan_on_file', true,
   'cash_amount', 15000, 'warnings', '["large_discount"]'::jsonb, 'estimate_ids', jsonb_build_array(:'est_id', :'est_b'), 'created_by', platform.current_user_id())::text AS inv \gset
SELECT pg_temp.bad('sales.invoice', :'inv'::jsonb || '{"invoice_total":44085,"net_payable":34285,"balance_due":14285}', 'SI1 bill total = taxable + CGST + SGST + IGST + cess + round-off', '%invoice_total_sum_check%');
SELECT pg_temp.bad('sales.invoice', :'inv'::jsonb || '{"gross_value":43446}', 'SI2 taxable = gross - discount', '%invoice_taxable_sum_check%');
SELECT pg_temp.bad('sales.invoice', :'inv'::jsonb || '{"net_payable":34000,"balance_due":14000}', 'SI3 net payable = total - old gold (+ excess)', '%invoice_net_payable_check%');
SELECT pg_temp.bad('sales.invoice', :'inv'::jsonb || '{"old_gold_excess":100,"old_gold_excess_payout":"cash","net_payable":34384,"balance_due":14384}',
                   'SI4 old-gold excess only when old gold exceeds the bill (net 0)', '%invoice_net_payable_check%');
SELECT pg_temp.bad('sales.invoice', :'inv'::jsonb || '{"cgst":0,"sgst":0,"igst":1284}', 'SI6 intra-state bill cannot carry IGST', '%invoice_gst_split_check%');
SELECT pg_temp.bad('sales.invoice', :'inv'::jsonb || '{"seller_gstin":"29ABCDE1234F1Z5"}', 'SI7 intra-state only when seller GSTIN state = place of supply', '%invoice_seller_gstin_check%');
SELECT pg_temp.bad('sales.invoice', :'inv'::jsonb || '{"customer_gstin":null}', 'SI8 B2B needs the customer GSTIN', '%invoice_supply_type_check%');
SELECT pg_temp.bad('sales.invoice', :'inv'::jsonb || '{"supply_type":"b2c"}', 'SI9 B2C bill cannot carry a customer GSTIN', '%invoice_supply_type_check%');
SELECT pg_temp.bad('sales.invoice', :'inv'::jsonb || '{"round_off":0.60,"invoice_total":44084.60,"net_payable":34284.60,"balance_due":14284.60}', 'SI10 |round-off| <= half of round_off_to', '%invoice_round_off_to_check%');
SELECT pg_temp.bad('sales.invoice', :'inv'::jsonb || '{"round_off_to":0.25}', 'SI11 round_off_to one of 0.01 / 0.10 / 0.50 / 1.00 (gst_config)', '%invoice_round_off_to_check%');
SELECT pg_temp.bad('sales.invoice', :'inv'::jsonb || '{"bill_discount":700}', 'SI12 bill discount is part of (<=) the total discount', '%invoice_amounts_check%');
SELECT pg_temp.bad('sales.invoice', :'inv'::jsonb || '{"cash_amount":25000}', 'SI13 cash at issue <= paid at issue', '%invoice_amounts_check%');
SELECT pg_temp.bad('sales.invoice', :'inv'::jsonb || '{"zero_gst":true}', 'SI14 0% GST needs reason, print note and zero taxes', '%invoice_zero_gst_check%');
SELECT pg_temp.bad('sales.invoice', :'inv'::jsonb || '{"pan_required":true,"pan_on_file":false}', 'SI15 PAN required but not on file blocks the bill', '%invoice_pan_check%');
SELECT pg_temp.bad('sales.invoice', :'inv'::jsonb || '{"salesperson_id":null}', 'SI16 salesperson required on new bills', '%invoice_required_check%');
SELECT pg_temp.bad('sales.invoice', :'inv'::jsonb || '{"making_gst_treatment":null}', 'SI17 making-GST snapshot required on new bills', '%invoice_required_check%');
SELECT pg_temp.bad('sales.invoice', :'inv'::jsonb || '{"making_gst_treatment":"separate"}', 'SI17b separate making needs the making_service_rate snapshot (0.9.1)', '%invoice_making_service_rate_check%');
SELECT pg_temp.bad('sales.invoice', :'inv'::jsonb || '{"making_service_rate":18}', 'SI17c composite bill carries no making_service_rate', '%invoice_making_service_rate_check%');
SELECT pg_temp.bad('sales.invoice', :'inv'::jsonb || '{"credit_sale":true}', 'SI17d part-paid bill is not a credit sale (credit_sale = net > 0 AND paid 0)', '%invoice_credit_sale_check%');
SELECT pg_temp.bad('sales.invoice', :'inv'::jsonb || jsonb_build_object('doc_no', 'CBE/INV/2026-27/' || lpad(:'seq', 6, '0')), 'SI18 doc_no max 16 chars, A-Z 0-9 / - (GST rule 46)', '%invoice_doc_no_check%');
SELECT pg_temp.bad('sales.invoice', :'inv'::jsonb || '{"warnings":{"x":1}}', 'SI19 warnings is a JSON array', '%invoice_cash_warnings_check%');
SELECT pg_temp.bad('sales.invoice', :'inv'::jsonb || '{"salesperson_id":"00000000-0000-0000-0000-0000000dead1"}', 'SI20 salesperson must be an hr.staff row', '%invoice_salesperson_fk%');
SELECT pg_temp.bad('sales.invoice', :'inv'::jsonb || '{"row_rev":null}', 'SI21 row_rev cannot be sent by the app', '%permission denied%');
SELECT pg_temp.ins('sales.invoice', :'inv'::jsonb) AS inv_id \gset
SELECT jsonb_build_object('tenant_id', platform.current_tenant(), 'invoice_id', :'inv_id', 'line_no', 2, 'item_id', '00000000-0000-0000-0000-000000000902',
   'stock_kind', 'loose', 'purity_id', '00000000-0000-0000-0000-000000000022', 'counter_id', '00000000-0000-0000-0000-0000000c9871', 'box_id', '00000000-0000-0000-0000-0000000b9871',
   'description', 'Loose 22K by weight', 'purity_code', '22K', 'fineness', 916, 'hsn', '7113', 'gross_wt', 2, 'net_wt', 2, 'rate_id', :'sale_rate', 'rate_per_g', 7000,
   'wastage_pct', 5, 'wastage_wt', 0.1, 'chargeable_wt', 2.1, 'metal_value', 14700, 'mc_type', 'flat', 'mc_value', 300, 'mc_amount', 300, 'gross_value', 15000,
   'bill_discount_share', 200, 'taxable_value', 14800, 'tax_rule_id', :'rule_id', 'tax_rate', 3, 'hsn_sac_applied', '7113', 'composite_supply', true,
   'cgst', 222, 'sgst', 222, 'cess', 0, 'line_total', 15244)::text AS l2 \gset
SELECT pg_temp.bad('sales.invoice_line', :'l2'::jsonb || '{"stock_kind":"tag"}', 'SI22 stock_kind tag <=> tag_id set', '%invoice_line_stock_check%');
SELECT pg_temp.bad('sales.invoice_line', :'l2'::jsonb || '{"purity_id":null}', 'SI23 goods line needs purity_id (stock_ledger key)', '%invoice_line_stock_check%');
SELECT pg_temp.bad('sales.invoice_line', :'l2'::jsonb || '{"chargeable_wt":2.0}', 'SI24 chargeable weight = net + wastage', '%invoice_line_weights_check%');
SELECT pg_temp.bad('sales.invoice_line', :'l2'::jsonb || '{"gross_value":15001}', 'SI25 line gross = metal + making + stone + hallmark; taxable = gross - discounts', '%invoice_line_taxable_sum_check%');
SELECT pg_temp.bad('sales.invoice_line', :'l2'::jsonb || '{"line_total":15000}', 'SI26 line total = taxable + taxes + cess', '%invoice_line_total_sum_check%');
SELECT pg_temp.bad('sales.invoice_line', :'l2'::jsonb || '{"igst":1,"line_total":15245}', 'SI27 line is CGST+SGST or IGST, not both', '%invoice_line_gst_split_check%');
SELECT pg_temp.bad('sales.invoice_line', :'l2'::jsonb || '{"mc_type":"per_kilo"}', 'SI28 making type per_gram | percent | flat | per_piece', '%invoice_line_mc_type_check%');
SELECT pg_temp.bad('sales.invoice_line', :'l2'::jsonb || '{"stock_kind":"tag","tag_id":"00000000-0000-0000-0000-0000000dead2"}', 'SI29 line tag must exist', '%invoice_line_tag_fk%');
SELECT pg_temp.bad('sales.invoice_line', :'l2'::jsonb || '{"rate_id":"00000000-0000-0000-0000-0000000dead3"}', 'SI30 line rate must be a rates.metal_rate row', '%invoice_line_rate_fk%');
SELECT pg_temp.ins('sales.invoice_line', :'l2'::jsonb) AS line2 \gset
SELECT pg_temp.ins('sales.invoice_line', jsonb_build_object('tenant_id', platform.current_tenant(), 'invoice_id', :'inv_id', 'line_no', 1, 'stock_kind', 'tag',
   'tag_id', '00000000-0000-0000-0000-0000000991f1', 'item_id', '00000000-0000-0000-0000-000000000901', 'purity_id', '00000000-0000-0000-0000-000000000022',
   'counter_id', '00000000-0000-0000-0000-0000000c9871', 'box_id', '00000000-0000-0000-0000-0000000b9871',
   'description', 'Gold ring', 'purity_code', '22K', 'fineness', 916, 'hsn', '7113', 'gross_wt', 4, 'net_wt', 4, 'chargeable_wt', 4, 'rate_id', :'sale_rate', 'rate_per_g', 7000,
   'metal_value', 28000, 'mc_type', 'per_gram', 'mc_value', 100, 'mc_amount', 400, 'huid_charge', 45, 'gross_value', 28445, 'discount', 445, 'taxable_value', 28000,
   'tax_rule_id', :'rule_id', 'tax_rate', 3, 'hsn_sac_applied', '7113', 'composite_supply', true, 'cgst', 420, 'sgst', 420, 'line_total', 28840)) AS line1 \gset
SELECT gen_random_uuid() AS om_ledger \gset
SELECT jsonb_build_object('tenant_id', platform.current_tenant(), 'invoice_id', :'inv_id', 'line_no', 1, 'purity_id', '00000000-0000-0000-0000-000000000022',
   'purity_code', '22K', 'description', 'Old chain', 'gross_wt', 1.5, 'less_wt', 0.1, 'net_wt', 1.4, 'touch_pct', 91.6, 'fine_wt', 1.282,
   'rate_id', :'om_rate', 'valuation_basis', 'stated_purity', 'server_rate_per_g', 6800, 'override_rate_per_g', 7000, 'override_reason', 'Matched competitor exchange rate',
   'overridden_by', platform.current_user_id(), 'rate_per_g', 7000, 'amount', 9800, 'inventory_ref_id', :'om_ledger')::text AS om \gset
SELECT pg_temp.bad('sales.invoice_old_metal', :'om'::jsonb || '{"override_reason":null}', 'SI31 old-gold rate override needs a reason', '%invoice_old_metal_override_check%');
SELECT pg_temp.bad('sales.invoice_old_metal', :'om'::jsonb || '{"overridden_by":null}', 'SI31b old-gold rate override needs overridden_by (0.9.1)', '%invoice_old_metal_override_check%');
SELECT pg_temp.bad('sales.invoice_old_metal', :'om'::jsonb || '{"override_rate_per_g":null,"override_reason":null,"rate_per_g":6800,"amount":9520}', 'SI31c no override => overridden_by must be NULL', '%invoice_old_metal_override_check%');
SELECT pg_temp.bad('sales.invoice_old_metal', :'om'::jsonb || '{"overridden_by":"00000000-0000-0000-0000-0000000dead4"}', 'SI31d overridden_by must be a platform.app_user', '%invoice_old_metal_overridden_by_fk%');
SELECT pg_temp.bad('sales.invoice_old_metal', :'om'::jsonb || '{"rate_overridden":false}', 'SI31e rate_overridden is generated (not writable)', '%rate_overridden%');
SELECT pg_temp.bad('sales.invoice_old_metal', :'om'::jsonb || '{"rate_per_g":6800,"amount":9520}', 'SI32 applied rate = override, else server rate', '%invoice_old_metal_required_check%');
SELECT pg_temp.bad('sales.invoice_old_metal', :'om'::jsonb || '{"server_rate_per_g":null}', 'SI33 server rate and valuation basis required', '%invoice_old_metal_required_check%');
SELECT pg_temp.bad('sales.invoice_old_metal', :'om'::jsonb || '{"net_wt":1.5}', 'SI34 old gold net = gross - less', '%invoice_old_metal_weights_check%');
SELECT pg_temp.ins('sales.invoice_old_metal', :'om'::jsonb) AS om_id \gset
INSERT INTO sales.invoice_payment (tenant_id, invoice_id, line_no, mode, amount) VALUES (platform.current_tenant(), :'inv_id', 1, 'cash', 15000);
INSERT INTO sales.invoice_payment (tenant_id, invoice_id, line_no, mode, reference, bank_name, amount) VALUES (platform.current_tenant(), :'inv_id', 2, 'upi', 'UTR0099', 'SBI', 5000);
SELECT jsonb_build_object('tenant_id', platform.current_tenant(), 'branch_id', '00000000-0000-0000-0000-00000000b001', 'invoice_id', :'inv_id',
   'customer_id', '00000000-0000-0000-0000-000000000d01', 'original_due', 14284, 'balance_due', 14284)::text AS due \gset
SELECT pg_temp.bad('sales.invoice_due', :'due'::jsonb || '{"original_due":14000,"balance_due":14000}', 'SI35 due row must carry the bill''s own balance_due', '%row-level security%');
SELECT pg_temp.ins('sales.invoice_due', :'due'::jsonb) AS due_id \gset
WITH u AS (UPDATE sales.estimate SET status = 'billed', invoice_id = :'inv_id' WHERE id IN (:'est_id', :'est_b') RETURNING 1)
  SELECT pg_temp.check(count(*) = 2, 'SI36 two estimates merged into this bill (estimate_ids), converted by sales_writer in the issuing transaction') FROM u;
SELECT pg_temp.expect_error(format($q$UPDATE sales.estimate SET status = 'billed', invoice_id = %L WHERE id = %L$q$, :'inv_id', :'est_d'),
  'SI37 an open estimate not listed in invoice.estimate_ids cannot be billed to it', '%row-level security%');
SET LOCAL ROLE inventory_writer;
UPDATE inventory.tag SET status = 'sold' WHERE id = '00000000-0000-0000-0000-0000000991f1';
INSERT INTO inventory.stock_ledger (tenant_id, id, branch_id, tag_id, item_id, purity_id, movement, direction, pieces, gross_wt, net_wt, fine_wt,
                                    source_module, source_type, source_id, counter_id, box_id) VALUES
 (platform.current_tenant(), gen_random_uuid(), '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000991f1', '00000000-0000-0000-0000-000000000901',
  '00000000-0000-0000-0000-000000000022', 'sale', -1, 1, 4, 4, 3.664, 'sales', 'invoice', :'inv_id', '00000000-0000-0000-0000-0000000c9871', '00000000-0000-0000-0000-0000000b9871'),
 (platform.current_tenant(), gen_random_uuid(), '00000000-0000-0000-0000-00000000b001', NULL, '00000000-0000-0000-0000-000000000902',
  '00000000-0000-0000-0000-000000000022', 'sale', -1, 0, 2, 2, 1.832, 'sales', 'invoice', :'inv_id', '00000000-0000-0000-0000-0000000c9871', '00000000-0000-0000-0000-0000000b9871'),
 (platform.current_tenant(), :'om_ledger', '00000000-0000-0000-0000-00000000b001', NULL, NULL,
  '00000000-0000-0000-0000-000000000022', 'old_metal_in', 1, 0, 1.5, 1.4, 1.282, 'sales', 'invoice_old_metal', :'om_id', NULL, NULL);
COMMIT;
SELECT pg_temp.check((SELECT supply_type || '|' || customer_gstin || '|' || bill_discount || '|' || making_gst_treatment || '|' || round_off_to || '|' || balance_due
                             || '|' || cash_amount || '|' || row_rev || '|' || (warnings->>0) FROM sales.invoice WHERE id = :'inv_id')
                     = 'b2b|33AAAAA0000A1Z5|200.00|composite|1.00|14284.00|15000.00|1|large_discount',
  'SI38 bill stored: B2B GSTIN, bill discount, making-GST + round-off snapshots, balance at issue, cash at issue, warnings, row_rev 1');
SELECT pg_temp.check((SELECT payment_status || '|' || balance_due || '|' || paid_at_issue || '|' || cash_total || '|' || line_count FROM sales.v_invoice_list WHERE invoice_id = :'inv_id')
                     = 'part_paid|14284.00|20000.00|15000.00|2',
  'SI39 v_invoice_list: part_paid, balance 14284, paid at issue 20000, cash 15000, 2 lines: '
  || (SELECT payment_status || '|' || balance_due || '|' || paid_at_issue || '|' || cash_total || '|' || line_count FROM sales.v_invoice_list WHERE invoice_id = :'inv_id'));
SELECT pg_temp.check((SELECT status FROM inventory.tag WHERE id = '00000000-0000-0000-0000-0000000991f1') = 'sold'
                 AND (SELECT count(*) FROM inventory.stock_ledger WHERE source_type = 'invoice' AND source_id = :'inv_id' AND movement = 'sale') = 2
                 AND (SELECT inventory_ref_id FROM sales.invoice_old_metal WHERE id = :'om_id') = (SELECT id FROM inventory.stock_ledger WHERE source_type = 'invoice_old_metal' AND source_id = :'om_id'),
  'SI40 tag sold + loose sale (movement sale, tag NULL, counter/tray) + old gold held as loose old metal (item NULL) linked by inventory_ref_id');
SELECT pg_temp.check(EXISTS (SELECT 1 FROM platform.audit_event WHERE table_name = 'sales.invoice_old_metal' AND row_id = :'om_id' AND action = 'INSERT')
                 AND (SELECT rate_overridden AND overridden_by = '00000000-0000-0000-0000-000000000a01' AND server_rate_per_g = 6800 AND rate_per_g = 7000
                      FROM sales.invoice_old_metal WHERE id = :'om_id')
                 AND (SELECT NOT credit_sale AND making_service_rate IS NULL FROM sales.invoice WHERE id = :'inv_id'),
  'SI41 old-gold override stored (server 6800, applied 7000, rate_overridden, overridden_by) and audited; part-paid bill credit_sale false');
BEGIN; SET LOCAL ROLE sales_writer;
SELECT pg_temp.expect_error(format($q$UPDATE sales.invoice SET zero_gst = true WHERE id = %L$q$, :'inv_id'), 'SI42 issued bill: new columns not editable', '%permission denied%');
SELECT pg_temp.expect_error(format($q$UPDATE sales.invoice_old_metal SET override_rate_per_g = 8000 WHERE id = %L$q$, :'om_id'), 'SI43 old-gold line not editable', '%permission denied%');
SELECT pg_temp.expect_error(format($q$DELETE FROM sales.invoice_due WHERE id = %L$q$, :'due_id'), 'SI44 due row cannot be deleted', '%permission denied%');
SELECT pg_temp.expect_error(format($q$SELECT pg_temp.ins('sales.invoice_line', %L::jsonb || '{"line_no":3}')$q$, :'l2'), 'SI45 no lines added after issue', '%transaction that issued the parent%');
SELECT pg_temp.expect_error(format($q$SELECT pg_temp.ins('sales.invoice_due', %L::jsonb)$q$, :'due'), 'SI46 no due row after the issuing transaction', '%');
ROLLBACK;
SELECT pg_temp.expect_error(format($q$UPDATE sales.invoice_due SET balance_due = 0 WHERE id = %L$q$, :'due_id'), 'SI47 app_rw cannot change a balance due', '%permission denied%');
WITH u AS (UPDATE sales.estimate SET notes = 'late edit' WHERE id IN (:'est_id', :'est_b') RETURNING 1) SELECT pg_temp.check(count(*) = 0, 'SE11 billed estimates are frozen') FROM u;

\echo '--- SR later payment receipts (append-only, split tenders, same-transaction rules)'
BEGIN; SET LOCAL ROLE sales_writer;
INSERT INTO platform.doc_counter(tenant_id, branch_id, doc_type, fy, prefix)
VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', 'sales_receipt', :'ist_fy', 'RCT-') ON CONFLICT DO NOTHING;
UPDATE platform.doc_counter SET next_no = next_no + 1 WHERE tenant_id = platform.current_tenant() AND branch_id = '00000000-0000-0000-0000-00000000b001'
   AND doc_type = 'sales_receipt' AND fy = :'ist_fy' RETURNING 'RCT-CBE-' || replace(substr(fy, 3), '-', '') || '-' || lpad((next_no - 1)::text, 5, '0') AS r1_no \gset
SELECT jsonb_build_object('tenant_id', platform.current_tenant(), 'branch_id', '00000000-0000-0000-0000-00000000b001', 'fy', :'ist_fy', 'receipt_no', :'r1_no',
   'invoice_id', :'inv_id', 'customer_id', '00000000-0000-0000-0000-000000000d01', 'total', 4284, 'received_by', platform.current_user_id())::text AS r1 \gset
SELECT pg_temp.bad('sales.payment_receipt', :'r1'::jsonb || '{"received_by":"00000000-0000-0000-0000-000000000a02"}', 'SR1 received_by must be the session user', '%row-level security%');
SELECT pg_temp.bad('sales.payment_receipt', :'r1'::jsonb || jsonb_build_object('invoice_id', (SELECT id FROM sales.invoice WHERE id <> :'inv_id' AND status = 'issued' LIMIT 1)),
                   'SR2 receipt only against a bill with a balance-due row', '%row-level security%');
SELECT pg_temp.bad('sales.payment_receipt', :'r1'::jsonb || '{"received_at":"2020-01-01T00:00:00Z"}', 'SR3 received_at is server-set', '%permission denied%');
SELECT pg_temp.bad('sales.payment_receipt', :'r1'::jsonb || '{"fy":"2020-21"}', 'SR4 receipt fy must match its IST date', '%payment_receipt_fy_check%');
SELECT pg_temp.ins('sales.payment_receipt', :'r1'::jsonb) AS r1_id \gset
INSERT INTO sales.payment_receipt_tender(tenant_id, receipt_id, line_no, mode, amount) VALUES (platform.current_tenant(), :'r1_id', 1, 'cash', 2000);
INSERT INTO sales.payment_receipt_tender(tenant_id, receipt_id, line_no, mode, reference, amount) VALUES (platform.current_tenant(), :'r1_id', 2, 'upi', 'UTR000111', 2284);
SELECT pg_temp.expect_error(format($q$INSERT INTO sales.payment_receipt_tender(tenant_id, receipt_id, line_no, mode, amount) VALUES (platform.current_tenant(), %L, 3, 'advance', 1)$q$, :'r1_id'),
  'SR5 receipt tenders: cash / UPI / cards / bank transfer / cheque / credit_note only', '%payment_receipt_tender_mode_check%');
SELECT pg_temp.expect_error(format($q$INSERT INTO sales.payment_receipt_tender(tenant_id, receipt_id, line_no, mode, credit_note_id, amount)
   VALUES (platform.current_tenant(), %L, 3, 'cash', (SELECT c.id FROM sales.credit_note c JOIN sales.invoice i ON i.tenant_id = c.tenant_id AND i.id = c.invoice_id
                                                       WHERE coalesce(c.customer_id, i.customer_id) = '00000000-0000-0000-0000-000000000d01' LIMIT 1), 1)$q$, :'r1_id'),
  'SR6 credit_note_id only on a credit_note (store-credit) tender', '%payment_receipt_tender_credit_note_check%');
SELECT pg_temp.expect_error(format($q$INSERT INTO sales.payment_receipt_tender(tenant_id, receipt_id, line_no, mode, cheque_date, amount) VALUES (platform.current_tenant(), %L, 3, 'upi', current_date, 1)$q$, :'r1_id'),
  'SR7 cheque_date only on cheque tenders', '%payment_receipt_tender_cheque_check%');
SELECT pg_temp.expect_error(format($q$INSERT INTO sales.payment_receipt_tender(tenant_id, receipt_id, line_no, mode, credit_note_id, amount)
   VALUES (platform.current_tenant(), %L, 3, 'credit_note', (SELECT c.id FROM sales.credit_note c JOIN sales.invoice i ON i.tenant_id = c.tenant_id AND i.id = c.invoice_id
                                                              WHERE coalesce(c.customer_id, i.customer_id) IS DISTINCT FROM '00000000-0000-0000-0000-000000000d01' LIMIT 1), 1)$q$, :'r1_id'),
  'SR8 store credit of another customer cannot be tendered on this receipt (994 policy)', '%row-level security%');
WITH u AS (UPDATE sales.invoice_due SET balance_due = balance_due - 4284, received_after_issue = received_after_issue + 4284, last_receipt_id = :'r1_id', updated_at = now()
           WHERE tenant_id = platform.current_tenant() AND invoice_id = :'inv_id' AND balance_due >= 4284 RETURNING 1)
  SELECT pg_temp.check(count(*) = 1, 'SR9 due decremented with the guarded UPDATE (rowCount 1)') FROM u;
WITH u AS (UPDATE sales.invoice_due SET balance_due = balance_due - 50000, received_after_issue = received_after_issue + 50000
           WHERE tenant_id = platform.current_tenant() AND invoice_id = :'inv_id' AND balance_due >= 50000 RETURNING 1)
  SELECT pg_temp.check(count(*) = 0, 'SR10 over-payment: guarded UPDATE matches 0 rows (app rejects)') FROM u;
SELECT pg_temp.expect_error(format($q$UPDATE sales.invoice_due SET balance_due = balance_due - 50000, received_after_issue = received_after_issue + 50000 WHERE invoice_id = %L$q$, :'inv_id'),
  'SR11 balance due can never go negative', '%invoice_due_balance_check%');
SELECT pg_temp.expect_error(format($q$UPDATE sales.invoice_due SET balance_due = balance_due - 1 WHERE invoice_id = %L$q$, :'inv_id'),
  'SR12 due buckets must add up to the original due', '%invoice_due_buckets_check%');
COMMIT;
BEGIN; SET LOCAL ROLE sales_writer;
SELECT pg_temp.expect_error(format($q$INSERT INTO sales.payment_receipt_tender(tenant_id, receipt_id, line_no, mode, amount) VALUES (platform.current_tenant(), %L, 3, 'cash', 1)$q$, :'r1_id'),
  'SR13 no tenders added to a receipt after its transaction', '%row-level security%');
SELECT pg_temp.expect_error(format($q$UPDATE sales.payment_receipt SET total = 1 WHERE id = %L$q$, :'r1_id'), 'SR14 receipts are append-only (no UPDATE)', '%permission denied%');
ROLLBACK;
BEGIN; SET LOCAL ROLE sales_writer;
UPDATE platform.doc_counter SET next_no = next_no + 1 WHERE tenant_id = platform.current_tenant() AND branch_id = '00000000-0000-0000-0000-00000000b001'
   AND doc_type = 'sales_receipt' AND fy = :'ist_fy' RETURNING 'RCT-CBE-' || replace(substr(fy, 3), '-', '') || '-' || lpad((next_no - 1)::text, 5, '0') AS r2_no \gset
SELECT pg_temp.ins('sales.payment_receipt', :'r1'::jsonb || jsonb_build_object('receipt_no', :'r2_no', 'total', 1000)) AS r2_id \gset
INSERT INTO sales.payment_receipt_tender(tenant_id, receipt_id, line_no, mode, reference, cheque_date, bank_name, amount)
VALUES (platform.current_tenant(), :'r2_id', 1, 'cheque', '000123', (now() AT TIME ZONE 'Asia/Kolkata')::date, 'Canara Bank', 1000);
UPDATE sales.invoice_due SET balance_due = balance_due - 1000, received_after_issue = received_after_issue + 1000, last_receipt_id = :'r2_id', updated_at = now()
 WHERE invoice_id = :'inv_id' AND balance_due >= 1000;
COMMIT;
SELECT pg_temp.expect_error(format($q$DELETE FROM sales.payment_receipt WHERE id = %L$q$, :'r2_id'), 'SR15 receipts never deleted', '%permission denied%');
SELECT pg_temp.check((SELECT payment_status || '|' || balance_due || '|' || receipts_total || '|' || paid_amount || '|' || cash_total FROM sales.v_invoice_balance WHERE invoice_id = :'inv_id')
                     = 'part_paid|9000.00|5284.00|25284.00|17000.00',
  'SR16 v_invoice_balance after 2 receipts (cash+UPI, cheque): balance 9000, receipts 5284, paid 25284, cash 17000: '
  || (SELECT payment_status || '|' || balance_due || '|' || receipts_total || '|' || paid_amount || '|' || cash_total FROM sales.v_invoice_balance WHERE invoice_id = :'inv_id'));

\echo '--- SC return the ring (whole line): credit note reduces the due, part cash refund, rest store credit; tag restocked'
BEGIN; SET LOCAL ROLE sales_writer;
UPDATE sales.doc_series SET next_no = next_no + 1
 WHERE tenant_id = platform.current_tenant() AND branch_id = '00000000-0000-0000-0000-00000000b001' AND doc_type = 'credit_note' AND fy = platform.fy_of(current_date)
RETURNING next_no - 1 AS cn_seq, prefix AS cn_prefix \gset
SELECT jsonb_build_object('tenant_id', platform.current_tenant(), 'branch_id', '00000000-0000-0000-0000-00000000b001', 'fy', :'fy', 'doc_seq', :cn_seq,
   'doc_no', :'cn_prefix' || lpad(:'cn_seq', 6, '0'), 'invoice_id', :'inv_id', 'kind', 'sales_return', 'reason', 'Ring size does not fit',
   'customer_id', '00000000-0000-0000-0000-000000000d01', 'customer_snapshot', '{"name":"Priya","phone":"9876543210"}'::jsonb,
   'taxable_value', 28000, 'cgst', 420, 'sgst', 420, 'cess', 0, 'round_off', 0, 'total', 28840, 'refund_mode', 'cash', 'refund_amount', 5000, 'due_reduced', 9000,
   'store_credit_amount', 14840, 'balance_available', 14840, 'created_by', platform.current_user_id())::text AS cn \gset
SELECT pg_temp.bad('sales.credit_note', :'cn'::jsonb || '{"store_credit_amount":14841,"balance_available":14841}', 'SC1 total = refund + due reduced + store credit', '%credit_note_settlement_check%');
SELECT pg_temp.bad('sales.credit_note', :'cn'::jsonb || '{"balance_available":14841}', 'SC2 store-credit balance starts at (<=) store_credit_amount', '%credit_note_settlement_check%');
SELECT pg_temp.bad('sales.credit_note', :'cn'::jsonb || '{"customer_id":null}', 'SC3 store credit needs a customer', '%credit_note_settlement_check%');
SELECT pg_temp.bad('sales.credit_note', :'cn'::jsonb || '{"refund_mode":"store_credit"}', 'SC4 refund_mode store_credit <=> no cash refund', '%credit_note_settlement_check%');
SELECT pg_temp.bad('sales.credit_note', :'cn'::jsonb || '{"refund_mode":"bank"}', 'SC5 new credit notes use bank_transfer, not legacy bank', '%credit_note_refund_mode_check%');
SELECT pg_temp.bad('sales.credit_note', :'cn'::jsonb || '{"round_off":1}', 'SC6 credit-note total = taxable + taxes + cess + round-off', '%credit_note_total_sum_check%');
SELECT pg_temp.bad('sales.credit_note', :'cn'::jsonb || jsonb_build_object('doc_no', 'CBE/CN/2026-27/' || lpad(:'cn_seq', 6, '0')), 'SC7 credit-note doc_no max 16 chars (GST rule 46)', '%credit_note_doc_no_check%');
SELECT pg_temp.ins('sales.credit_note', :'cn'::jsonb) AS cn_id \gset
INSERT INTO sales.credit_note_line (tenant_id, credit_note_id, invoice_line_id, taxable_value, cgst, sgst, igst, cess, line_total, stock_kind, restock_counter_id, restock_box_id)
VALUES (platform.current_tenant(), :'cn_id', :'line1', 28000, 420, 420, 0, 0, 28840, 'tag', '00000000-0000-0000-0000-0000000c9871', '00000000-0000-0000-0000-0000000b9871');
SELECT pg_temp.expect_error(format($q$INSERT INTO sales.credit_note_line (tenant_id, credit_note_id, invoice_line_id, taxable_value, cgst, sgst, igst, line_total)
   VALUES (platform.current_tenant(), %L, %L, 1, 0, 0, 0, 1)$q$, :'cn_id', :'line1'), 'SC8 returns are whole lines: a line can be credited once', '%duplicate key%');
WITH u AS (UPDATE sales.invoice_due SET balance_due = balance_due - 9000, due_reduced = due_reduced + 9000, updated_at = now()
           WHERE invoice_id = :'inv_id' AND balance_due >= 9000 RETURNING 1)
  SELECT pg_temp.check(count(*) = 1, 'SC9 credit note reduces the due in the same transaction') FROM u;
SET LOCAL ROLE inventory_writer;
UPDATE inventory.tag SET status = 'in_stock' WHERE id = '00000000-0000-0000-0000-0000000991f1';
INSERT INTO inventory.stock_ledger (tenant_id, branch_id, tag_id, item_id, purity_id, movement, direction, pieces, gross_wt, net_wt, fine_wt, source_module, source_type, source_id, counter_id, box_id)
VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000991f1', '00000000-0000-0000-0000-000000000901',
        '00000000-0000-0000-0000-000000000022', 'sales_return', 1, 1, 4, 4, 3.664, 'sales', 'credit_note', :'cn_id', '00000000-0000-0000-0000-0000000c9871', '00000000-0000-0000-0000-0000000b9871');
COMMIT;
SELECT pg_temp.check((SELECT payment_status || '|' || balance_due || '|' || credited_to_due || '|' || refunded_total FROM sales.v_invoice_balance WHERE invoice_id = :'inv_id') = 'paid|0.00|9000.00|5000.00'
                 AND (SELECT status FROM inventory.tag WHERE id = '00000000-0000-0000-0000-0000000991f1') = 'in_stock'
                 AND (SELECT refund_amount || '|' || due_reduced || '|' || store_credit_amount || '|' || balance_available || '|' || row_rev FROM sales.credit_note WHERE id = :'cn_id')
                     = '5000.00|9000.00|14840.00|14840.00|1',
  'SC10 bill paid (due 0 via credit note), tag back in stock, note split 5000 cash / 9000 due / 14840 store credit: '
  || (SELECT payment_status || '|' || balance_due || '|' || credited_to_due || '|' || refunded_total FROM sales.v_invoice_balance WHERE invoice_id = :'inv_id'));
BEGIN; SET LOCAL ROLE sales_writer;
SELECT pg_temp.expect_error(format($q$UPDATE sales.credit_note SET store_credit_amount = 0 WHERE id = %L$q$, :'cn_id'), 'SC11 credit-note settlement split not editable', '%permission denied%');
SELECT pg_temp.expect_error(format($q$UPDATE sales.credit_note SET balance_available = 14841 WHERE id = %L$q$, :'cn_id'), 'SC12 store credit can only go down', '%');
ROLLBACK;

\echo '--- SN gapless series per branch per FY; credit sale, old-gold excess and 0% GST bills (rolled back)'
SELECT next_no AS inv_next FROM sales.doc_series WHERE tenant_id = platform.current_tenant() AND branch_id = '00000000-0000-0000-0000-00000000b001'
   AND doc_type = 'tax_invoice' AND fy = platform.fy_of(current_date) \gset
BEGIN; SET LOCAL ROLE sales_writer;
INSERT INTO sales.doc_series(tenant_id, branch_id, doc_type, fy, prefix)
VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b987', 'tax_invoice', platform.fy_of(current_date), 'MDU/2627/') ON CONFLICT DO NOTHING;
UPDATE sales.doc_series SET next_no = next_no + 1 WHERE tenant_id = platform.current_tenant() AND branch_id = '00000000-0000-0000-0000-00000000b987'
   AND doc_type = 'tax_invoice' AND fy = platform.fy_of(current_date) RETURNING next_no - 1 AS mdu_seq \gset
SELECT pg_temp.check(:mdu_seq = 1 AND :inv_next > 1, 'SN1 each branch has its own series (MDU starts at 1 while CBE is at ' || :inv_next || ')');
SELECT pg_temp.expect_error($$SET CONSTRAINTS ALL IMMEDIATE$$, 'SN2 number allocated but not used is rejected (no gaps)', '%');
ROLLBACK;
SELECT jsonb_build_object('tenant_id', platform.current_tenant(), 'branch_id', '00000000-0000-0000-0000-00000000b001', 'company_id', '00000000-0000-0000-0000-00000000c001',
   'customer_id', '00000000-0000-0000-0000-000000000d01', 'customer_snapshot', '{"name":"Priya"}'::jsonb, 'place_of_supply', '33', 'gst_type', 'intra', 'rate_snapshot', '{}'::jsonb,
   'salesperson_id', '00000000-0000-0000-0000-0000000991a1', 'making_gst_treatment', 'composite', 'round_off_to', 1.00, 'pan_required', false, 'pan_on_file', false,
   'gross_value', 10000, 'taxable_value', 10000, 'cgst', 150, 'sgst', 150, 'invoice_total', 10300, 'created_by', platform.current_user_id())::text AS rb \gset
BEGIN; SET LOCAL ROLE sales_writer;
UPDATE sales.doc_series SET next_no = next_no + 1 WHERE tenant_id = platform.current_tenant() AND branch_id = '00000000-0000-0000-0000-00000000b001'
   AND doc_type = 'tax_invoice' AND fy = platform.fy_of(current_date) RETURNING next_no - 1 AS cseq, prefix AS cprefix, fy AS cfy \gset
SELECT (:'rb'::jsonb || jsonb_build_object('fy', :'cfy', 'doc_seq', :cseq, 'doc_no', :'cprefix' || lpad(:'cseq', 6, '0'),
        'net_payable', 10300, 'paid_amount', 0, 'balance_due', 10300, 'credit_sale', false))::text AS cinv \gset
SELECT pg_temp.bad('sales.invoice', :'cinv'::jsonb, 'SN3a fully unpaid bill must be flagged credit_sale (0.9.1)', '%invoice_credit_sale_check%');
SELECT pg_temp.ins('sales.invoice', :'cinv'::jsonb || '{"credit_sale":true}') AS credit_inv \gset
SELECT pg_temp.ins('sales.invoice_due', jsonb_build_object('tenant_id', platform.current_tenant(), 'branch_id', '00000000-0000-0000-0000-00000000b001', 'invoice_id', :'credit_inv',
        'customer_id', '00000000-0000-0000-0000-000000000d01', 'original_due', 10300, 'balance_due', 10300)) AS credit_due \gset
SELECT pg_temp.check((SELECT payment_status || '|' || balance_due FROM sales.v_invoice_balance WHERE invoice_id = :'credit_inv') = 'unpaid|10300.00',
  'SN3 credit sale (fully unpaid; app requires sales.invoice.credit_sale): due row + payment_status unpaid');
ROLLBACK;
BEGIN; SET LOCAL ROLE sales_writer;
UPDATE sales.doc_series SET next_no = next_no + 1 WHERE tenant_id = platform.current_tenant() AND branch_id = '00000000-0000-0000-0000-00000000b001'
   AND doc_type = 'tax_invoice' AND fy = platform.fy_of(current_date) RETURNING next_no - 1 AS xseq, prefix AS xprefix, fy AS xfy \gset
SELECT (:'rb'::jsonb || jsonb_build_object('fy', :'xfy', 'doc_seq', :xseq, 'doc_no', :'xprefix' || lpad(:'xseq', 6, '0'),
        'old_metal_value', 11300, 'old_gold_excess', 1000, 'old_gold_excess_payout', 'cash', 'net_payable', 0, 'paid_amount', 0, 'balance_due', 0,
        'making_gst_treatment', 'separate', 'making_service_rate', 18))::text AS xinv \gset
SELECT pg_temp.bad('sales.invoice', :'xinv'::jsonb || '{"old_gold_excess_payout":null}', 'SI5 old-gold excess needs a payout mode (cash | bank_transfer)', '%invoice_old_gold_excess_check%');
SELECT pg_temp.bad('sales.invoice', :'xinv'::jsonb || '{"old_gold_excess_payout":"upi"}', 'SI5b excess payout is cash or bank_transfer only', '%invoice_old_gold_excess%');
SELECT pg_temp.ins('sales.invoice', :'xinv'::jsonb) AS excess_inv \gset
SELECT pg_temp.check((SELECT net_payable = 0 AND old_gold_excess = 1000 AND NOT credit_sale AND making_gst_treatment = 'separate' AND making_service_rate = 18
                        FROM sales.invoice WHERE id = :'excess_inv'),
  'SN4 old gold (11300) worth more than the bill (10300): net 0 (not a credit sale), excess 1000 paid out in cash; separate making at the 18% snapshot');
ROLLBACK;
BEGIN; SET LOCAL ROLE sales_writer;
UPDATE sales.doc_series SET next_no = next_no + 1 WHERE tenant_id = platform.current_tenant() AND branch_id = '00000000-0000-0000-0000-00000000b001'
   AND doc_type = 'tax_invoice' AND fy = platform.fy_of(current_date) RETURNING next_no - 1 AS zseq, prefix AS zprefix, fy AS zfy \gset
SELECT (:'rb'::jsonb || jsonb_build_object('fy', :'zfy', 'doc_seq', :zseq, 'doc_no', :'zprefix' || lpad(:'zseq', 6, '0'), 'cgst', 0, 'sgst', 0, 'invoice_total', 10000,
        'net_payable', 10000, 'paid_amount', 10000, 'cash_amount', 10000, 'zero_gst', true, 'zero_gst_reason', 'Export under LUT (test)',
        'zero_gst_print_note', 'GST charged at 0%'))::text AS zinv \gset
SELECT pg_temp.bad('sales.invoice', :'zinv'::jsonb || '{"cgst":150,"sgst":150,"invoice_total":10300,"net_payable":10300,"paid_amount":10300}', 'SZ1 0% GST bill cannot carry tax', '%invoice_zero_gst_check%');
SELECT pg_temp.bad('sales.invoice', :'zinv'::jsonb || '{"cess":1,"invoice_total":10001,"net_payable":10001,"paid_amount":10001}', 'SZ2 0% GST bill cannot carry cess', '%invoice_zero_gst_check%');
SELECT pg_temp.bad('sales.invoice', :'zinv'::jsonb || '{"zero_gst_reason":"no"}', 'SZ3 0% GST reason at least 5 characters', '%invoice_zero_gst_check%');
SELECT pg_temp.ins('sales.invoice', :'zinv'::jsonb) AS zinv_id \gset
SELECT pg_temp.ins('sales.invoice_line', jsonb_build_object('tenant_id', platform.current_tenant(), 'invoice_id', :'zinv_id', 'line_no', 1, 'stock_kind', 'loose',
   'item_id', '00000000-0000-0000-0000-000000000902', 'purity_id', '00000000-0000-0000-0000-000000000022', 'description', 'Coin', 'purity_code', '22K', 'fineness', 916,
   'hsn', '7113', 'gross_wt', 1, 'net_wt', 1, 'chargeable_wt', 1, 'rate_id', :'sale_rate', 'rate_per_g', 10000, 'metal_value', 10000, 'mc_type', 'flat', 'mc_value', 0,
   'mc_amount', 0, 'gross_value', 10000, 'taxable_value', 10000, 'tax_rule_id', :'zero_rule_id', 'tax_rate', 0, 'hsn_sac_applied', '7113', 'composite_supply', false,
   'line_total', 10000)) AS zline \gset
SELECT pg_temp.check((SELECT zero_gst AND zero_gst_print_note = 'GST charged at 0%' FROM sales.invoice WHERE id = :'zinv_id')
                 AND (SELECT tax_rule_id FROM sales.invoice_line WHERE id = :'zline') = :'zero_rule_id',
  'SZ4 0% GST bill with reason + print note accepted; line snapshots the platform ZERO_RATED rule');
ROLLBACK;
SELECT pg_temp.check((SELECT next_no FROM sales.doc_series WHERE tenant_id = platform.current_tenant() AND branch_id = '00000000-0000-0000-0000-00000000b001'
                        AND doc_type = 'tax_invoice' AND fy = platform.fy_of(current_date)) = :inv_next
                 AND NOT EXISTS (SELECT 1 FROM sales.doc_series WHERE branch_id = '00000000-0000-0000-0000-00000000b987'),
  'SN5 rolled-back issues release their numbers (CBE next_no unchanged, no MDU series left)');
SELECT pg_temp.check((SELECT count(*) FROM reports.series_gaps) = 0, 'SN6 no gaps in any tenant-1 invoice / credit-note series');
SELECT pg_temp.check((SELECT next_no FROM platform.doc_counter WHERE tenant_id = platform.current_tenant() AND branch_id = '00000000-0000-0000-0000-00000000b001'
                        AND doc_type = 'sales_receipt' AND fy = :'ist_fy') = 3,
  'SN7 receipts numbered from platform.doc_counter (sales_receipt), next = 3');

\echo '--- SK store credit tendered on a later receipt (994: guard counts receipt tenders of this transaction)'
BEGIN; SET LOCAL ROLE sales_writer;
UPDATE sales.doc_series SET next_no = next_no + 1 WHERE tenant_id = platform.current_tenant() AND branch_id = '00000000-0000-0000-0000-00000000b001'
   AND doc_type = 'tax_invoice' AND fy = platform.fy_of(current_date) RETURNING next_no - 1 AS kseq, prefix AS kprefix, fy AS kfy \gset
SELECT pg_temp.ins('sales.invoice', :'rb'::jsonb || jsonb_build_object('fy', :'kfy', 'doc_seq', :kseq, 'doc_no', :'kprefix' || lpad(:'kseq', 6, '0'),
        'net_payable', 10300, 'paid_amount', 0, 'balance_due', 10300, 'credit_sale', true)) AS inv2 \gset
SELECT pg_temp.ins('sales.invoice_due', jsonb_build_object('tenant_id', platform.current_tenant(), 'branch_id', '00000000-0000-0000-0000-00000000b001', 'invoice_id', :'inv2',
        'customer_id', '00000000-0000-0000-0000-000000000d01', 'original_due', 10300, 'balance_due', 10300)) AS due2 \gset
COMMIT;
BEGIN; SET LOCAL ROLE sales_writer;
UPDATE platform.doc_counter SET next_no = next_no + 1 WHERE tenant_id = platform.current_tenant() AND branch_id = '00000000-0000-0000-0000-00000000b001'
   AND doc_type = 'sales_receipt' AND fy = :'ist_fy' RETURNING 'RCT-CBE-' || replace(substr(fy, 3), '-', '') || '-' || lpad((next_no - 1)::text, 5, '0') AS r3_no \gset
SELECT pg_temp.ins('sales.payment_receipt', :'r1'::jsonb || jsonb_build_object('receipt_no', :'r3_no', 'invoice_id', :'inv2', 'total', 3000)) AS r3_id \gset
INSERT INTO sales.payment_receipt_tender(tenant_id, receipt_id, line_no, mode, credit_note_id, amount) VALUES (platform.current_tenant(), :'r3_id', 1, 'credit_note', :'cn_id', 3000);
SELECT pg_temp.expect_error(format($q$UPDATE sales.credit_note SET balance_available = balance_available - 3001 WHERE id = %L$q$, :'cn_id'),
  'SK1 store credit cannot be reduced by more than the credit_note tenders of this transaction', '%redemption exceeds%');
WITH u AS (UPDATE sales.credit_note SET balance_available = balance_available - 3000 WHERE tenant_id = platform.current_tenant() AND id = :'cn_id'
           AND balance_available >= 3000 RETURNING balance_available)
  SELECT pg_temp.check((SELECT balance_available FROM u) = 11840, 'SK2 receipt paid with 3000 store credit: guarded UPDATE of balance_available (rowCount 1, 14840 -> 11840)');
SELECT pg_temp.expect_error(format($q$UPDATE sales.credit_note SET balance_available = balance_available + 1 WHERE id = %L$q$, :'cn_id'),
  'SK3 store credit still can only go down (guard unchanged)', '%can only decrease%');
SELECT pg_temp.expect_error(format($q$UPDATE sales.credit_note SET reason = 'changed reason' WHERE id = %L$q$, :'cn_id'),
  'SK4 credit note otherwise immutable (guard unchanged)', '%');
WITH u AS (UPDATE sales.invoice_due SET balance_due = balance_due - 3000, received_after_issue = received_after_issue + 3000, last_receipt_id = :'r3_id', updated_at = now()
           WHERE invoice_id = :'inv2' AND balance_due >= 3000 RETURNING balance_due)
  SELECT pg_temp.check((SELECT balance_due FROM u) = 7300, 'SK5 due of the credit-sale bill reduced by the store-credit receipt') FROM u;
COMMIT;
BEGIN; SET LOCAL ROLE sales_writer;
SELECT pg_temp.ins('sales.payment_receipt', :'r1'::jsonb || jsonb_build_object('receipt_no', 'RCT-SK-OVERDRAW', 'invoice_id', :'inv2', 'total', 7300)) AS r4_id \gset
INSERT INTO sales.payment_receipt_tender(tenant_id, receipt_id, line_no, mode, credit_note_id, amount) VALUES (platform.current_tenant(), :'r4_id', 1, 'credit_note', :'cn_id', 7300);
INSERT INTO sales.payment_receipt_tender(tenant_id, receipt_id, line_no, mode, credit_note_id, amount) VALUES (platform.current_tenant(), :'r4_id', 2, 'credit_note', :'cn_id', 7300);
WITH u AS (UPDATE sales.credit_note SET balance_available = balance_available - 14600 WHERE tenant_id = platform.current_tenant() AND id = :'cn_id'
           AND balance_available >= 14600 RETURNING 1)
  SELECT pg_temp.check(count(*) = 0, 'SK6 overdraw (14600 > 11840 left): guarded UPDATE matches 0 rows, app rejects') FROM u;
SELECT pg_temp.expect_error(format($q$UPDATE sales.credit_note SET balance_available = balance_available - 14600 WHERE id = %L$q$, :'cn_id'),
  'SK7 overdraw can never take store credit below 0', '%balance_available%');
ROLLBACK;
BEGIN; SET LOCAL ROLE sales_writer;
SELECT pg_temp.expect_error(format($q$UPDATE sales.credit_note SET balance_available = balance_available - 1 WHERE id = %L$q$, :'cn_id'),
  'SK8 no tender in this transaction: store credit cannot be reduced (guard unchanged)', '%redemption exceeds%');
ROLLBACK;
SELECT pg_temp.check((SELECT balance_available FROM sales.credit_note WHERE id = :'cn_id') = 11840
                 AND (SELECT payment_status || '|' || balance_due || '|' || receipts_total FROM sales.v_invoice_balance WHERE invoice_id = :'inv2') = 'part_paid|7300.00|3000.00',
  'SK9 after commit: store credit 11840, credit-sale bill part_paid with 7300 due');

\echo '--- SV receipt reversal: append-only negative receipt, same invoice + amount (composite FK), reason, at most once, restores the due'
BEGIN; SET LOCAL ROLE sales_writer;
UPDATE platform.doc_counter SET next_no = next_no + 1 WHERE tenant_id = platform.current_tenant() AND branch_id = '00000000-0000-0000-0000-00000000b001'
   AND doc_type = 'sales_receipt' AND fy = :'ist_fy' RETURNING 'RCT-CBE-' || replace(substr(fy, 3), '-', '') || '-' || lpad((next_no - 1)::text, 5, '0') AS rv_no \gset
SELECT (:'r1'::jsonb || jsonb_build_object('receipt_no', :'rv_no', 'total', -4284, 'reverses_receipt_id', :'r1_id', 'reversed_total', 4284,
        'reversal_reason', 'UPI credit belonged to another bill'))::text AS rv \gset
SELECT pg_temp.bad('sales.payment_receipt', :'rv'::jsonb || '{"total":-4283,"reversed_total":4283}', 'SV1 reversal must be for the exact amount of the original', '%payment_receipt_reverses_fk%');
SELECT pg_temp.bad('sales.payment_receipt', :'rv'::jsonb || jsonb_build_object('invoice_id', :'inv2'), 'SV2 reversal must be against the same invoice', '%payment_receipt_reverses_fk%');
SELECT pg_temp.bad('sales.payment_receipt', :'rv'::jsonb || '{"reversal_reason":"oops"}', 'SV3 reversal reason 5-200 characters', '%payment_receipt_total_check%');
SELECT pg_temp.bad('sales.payment_receipt', :'rv'::jsonb || '{"total":4284}', 'SV4 reversal total is the negated original', '%payment_receipt_total_check%');
SELECT pg_temp.bad('sales.payment_receipt', :'rv'::jsonb || '{"total":-4284,"reversal_reason":null,"reversed_total":null,"reverses_receipt_id":null}', 'SV5 negative total only on a reversal', '%payment_receipt_total_check%');
SAVEPOINT sv6;
SELECT pg_temp.check(pg_temp.ins('sales.payment_receipt', :'rv'::jsonb || jsonb_build_object('receipt_no', 'RCT-SV-SC', 'invoice_id', :'inv2', 'reverses_receipt_id', :'r3_id',
                       'reversed_total', 3000, 'total', -3000)) IS NOT NULL,
  'SV6 a receipt paid with store credit can be reversed (995: block lifted; its credit comes back as a receipt_reversal note, see SW)');
ROLLBACK TO SAVEPOINT sv6;
SELECT pg_temp.ins('sales.payment_receipt', :'rv'::jsonb) AS rv_id \gset
SELECT pg_temp.bad('sales.payment_receipt', :'rv'::jsonb || '{"receipt_no":"RCT-SV-TWICE"}', 'SV7 a receipt can be reversed at most once', '%payment_receipt_reverses_uq%');
SELECT pg_temp.bad('sales.payment_receipt', :'rv'::jsonb || jsonb_build_object('receipt_no', 'RCT-SV-REV2', 'reverses_receipt_id', :'rv_id'),
                   'SV8 a reversal cannot be reversed', '%payment_receipt_reverses_fk%');
SELECT pg_temp.expect_error(format($q$INSERT INTO sales.payment_receipt_tender(tenant_id, receipt_id, line_no, mode, amount) VALUES (platform.current_tenant(), %L, 1, 'cash', 1)$q$, :'rv_id'),
  'SV9 reversals carry no tenders', '%row-level security%');
WITH u AS (UPDATE sales.invoice_due SET balance_due = balance_due + 4284, received_after_issue = received_after_issue - 4284, last_receipt_id = :'rv_id', updated_at = now()
           WHERE tenant_id = platform.current_tenant() AND invoice_id = :'inv_id' AND received_after_issue >= 4284 RETURNING balance_due)
  SELECT pg_temp.check((SELECT balance_due FROM u) = 4284, 'SV10 reversal restores the due (received_after_issue -> balance_due, buckets CHECK holds)');
COMMIT;
SELECT pg_temp.check((SELECT payment_status || '|' || balance_due || '|' || receipts_total || '|' || paid_amount || '|' || cash_total FROM sales.v_invoice_balance WHERE invoice_id = :'inv_id')
                     = 'part_paid|4284.00|1000.00|21000.00|15000.00'
                 AND EXISTS (SELECT 1 FROM platform.audit_event WHERE table_name = 'sales.payment_receipt' AND row_id = :'rv_id' AND action = 'INSERT'),
  'SV11 after reversing R1 (4284: cash 2000 + UPI): balance 4284, receipts net 1000, cash total excludes the reversed receipt; reversal audited: '
  || (SELECT payment_status || '|' || balance_due || '|' || receipts_total || '|' || paid_amount || '|' || cash_total FROM sales.v_invoice_balance WHERE invoice_id = :'inv_id'));
SELECT pg_temp.expect_error(format($q$UPDATE sales.payment_receipt SET reversal_reason = 'edited reason' WHERE id = %L$q$, :'rv_id'), 'SV12 reversal itself is append-only', '%permission denied%');

\echo '--- SW reversal of a mixed cash + store-credit receipt: the store-credit part comes back as ONE new receipt_reversal credit note (995)'
SELECT pg_temp.check((SELECT count(*) FROM pg_attribute WHERE attrelid = 'sales.credit_note'::regclass AND attname = 'reversal_receipt_id' AND NOT attisdropped) = 1
                 AND pg_temp.policies('sales.credit_note') LIKE '%insert_receipt_reversal%'
                 AND has_column_privilege('sales_writer', 'sales.credit_note', 'reversal_receipt_id', 'INSERT')
                 AND NOT has_column_privilege('sales_writer', 'sales.credit_note', 'reversal_receipt_id', 'UPDATE')
                 AND pg_get_functiondef('sales.issued_doc_guard'::regproc) LIKE '%credit note balance can only decrease%',
  'SW0 995 structure: credit_note.reversal_receipt_id (insert-only, sales_writer), policy insert_receipt_reversal; issued_doc_guard unchanged (decrease-only)');
SELECT (SELECT balance_available FROM sales.credit_note WHERE id = :'cn_id') AS cn_before \gset
BEGIN; SET LOCAL ROLE sales_writer;
UPDATE platform.doc_counter SET next_no = next_no + 1 WHERE tenant_id = platform.current_tenant() AND branch_id = '00000000-0000-0000-0000-00000000b001'
   AND doc_type = 'sales_receipt' AND fy = :'ist_fy' RETURNING 'RCT-CBE-' || replace(substr(fy, 3), '-', '') || '-' || lpad((next_no - 1)::text, 5, '0') AS rm_no \gset
SELECT pg_temp.ins('sales.payment_receipt', :'r1'::jsonb || jsonb_build_object('receipt_no', :'rm_no', 'invoice_id', :'inv2', 'total', 1200)) AS rm_id \gset
INSERT INTO sales.payment_receipt_tender(tenant_id, receipt_id, line_no, mode, amount) VALUES (platform.current_tenant(), :'rm_id', 1, 'cash', 500);
INSERT INTO sales.payment_receipt_tender(tenant_id, receipt_id, line_no, mode, credit_note_id, amount) VALUES (platform.current_tenant(), :'rm_id', 2, 'credit_note', :'cn_id', 700);
UPDATE sales.credit_note SET balance_available = balance_available - 700 WHERE tenant_id = platform.current_tenant() AND id = :'cn_id' AND balance_available >= 700;
UPDATE sales.invoice_due SET balance_due = balance_due - 1200, received_after_issue = received_after_issue + 1200, last_receipt_id = :'rm_id', updated_at = now()
 WHERE tenant_id = platform.current_tenant() AND invoice_id = :'inv2' AND balance_due >= 1200;
COMMIT;
-- the reversal: one transaction = reversal receipt + due restore + receipt_reversal credit note
BEGIN; SET LOCAL ROLE sales_writer;
UPDATE platform.doc_counter SET next_no = next_no + 1 WHERE tenant_id = platform.current_tenant() AND branch_id = '00000000-0000-0000-0000-00000000b001'
   AND doc_type = 'sales_receipt' AND fy = :'ist_fy' RETURNING 'RCT-CBE-' || replace(substr(fy, 3), '-', '') || '-' || lpad((next_no - 1)::text, 5, '0') AS rw_no \gset
SELECT pg_temp.ins('sales.payment_receipt', :'r1'::jsonb || jsonb_build_object('receipt_no', :'rw_no', 'invoice_id', :'inv2', 'total', -1200, 'reverses_receipt_id', :'rm_id',
        'reversed_total', 1200, 'reversal_reason', 'Receipt keyed against the wrong bill')) AS rw_id \gset
WITH u AS (UPDATE sales.invoice_due SET balance_due = balance_due + 1200, received_after_issue = received_after_issue - 1200, last_receipt_id = :'rw_id', updated_at = now()
           WHERE tenant_id = platform.current_tenant() AND invoice_id = :'inv2' AND received_after_issue >= 1200 RETURNING balance_due)
  SELECT pg_temp.check((SELECT balance_due FROM u) = 7300, 'SW1 due restored by the FULL receipt amount (1200 = cash 500 + store credit 700): 6100 -> 7300');
UPDATE sales.doc_series SET next_no = next_no + 1
 WHERE tenant_id = platform.current_tenant() AND branch_id = '00000000-0000-0000-0000-00000000b001' AND doc_type = 'credit_note' AND fy = platform.fy_of(current_date)
RETURNING next_no - 1 AS rcn_seq, prefix AS rcn_prefix \gset
SELECT jsonb_build_object('tenant_id', platform.current_tenant(), 'branch_id', '00000000-0000-0000-0000-00000000b001', 'fy', :'fy', 'doc_seq', :rcn_seq,
   'doc_no', :'rcn_prefix' || lpad(:'rcn_seq', 6, '0'), 'invoice_id', :'inv2', 'kind', 'receipt_reversal', 'reason', 'Store credit returned: receipt reversed',
   'customer_id', '00000000-0000-0000-0000-000000000d01', 'customer_snapshot', '{"name":"Priya"}'::jsonb, 'reversal_receipt_id', :'rw_id',
   'taxable_value', 0, 'cgst', 0, 'sgst', 0, 'igst', 0, 'cess', 0, 'round_off', 0, 'total', 700, 'refund_mode', 'store_credit', 'refund_amount', 0, 'due_reduced', 0,
   'store_credit_amount', 700, 'balance_available', 700, 'created_by', platform.current_user_id())::text AS rcn \gset
SELECT pg_temp.bad('sales.credit_note', :'rcn'::jsonb || '{"total":699,"store_credit_amount":699,"balance_available":699}',
  'SW2 note amount must equal the store-credit tenders of the reversed receipt (700)', '%row-level security%');
SELECT pg_temp.bad('sales.credit_note', :'rcn'::jsonb || '{"balance_available":600}', 'SW3 note starts with its full balance', '%row-level security%');
SELECT pg_temp.bad('sales.credit_note', :'rcn'::jsonb || jsonb_build_object('reversal_receipt_id', :'rm_id'), 'SW4 note must point at a reversal (not the original receipt)', '%row-level security%');
SELECT pg_temp.bad('sales.credit_note', :'rcn'::jsonb || '{"invoice_id":null}' || jsonb_build_object('invoice_id', :'inv_id'), 'SW5 note on the reversed receipt''s own invoice', '%row-level security%');
SELECT pg_temp.bad('sales.credit_note', :'rcn'::jsonb || '{"reversal_receipt_id":null}', 'SW6 kind receipt_reversal <=> reversal_receipt_id', '%credit_note_receipt_reversal_check%');
SELECT pg_temp.bad('sales.credit_note', :'rcn'::jsonb || '{"taxable_value":600,"cgst":50,"sgst":50}', 'SW7 receipt_reversal note carries no taxable value / GST', '%credit_note_receipt_reversal_check%');
SELECT pg_temp.bad('sales.credit_note', :'rcn'::jsonb || '{"refund_mode":"cash","refund_amount":700,"store_credit_amount":0,"balance_available":0}',
  'SW8 receipt_reversal note is store credit only (cash refund split fails the amount match; CHECK backs it)', '%row-level security%');
SELECT pg_temp.ins('sales.credit_note', :'rcn'::jsonb) AS rcn_id \gset
SELECT pg_temp.expect_error(format($q$DO $d$ DECLARE s int; p text; BEGIN
     UPDATE sales.doc_series SET next_no = next_no + 1 WHERE tenant_id = platform.current_tenant() AND branch_id = '00000000-0000-0000-0000-00000000b001'
        AND doc_type = 'credit_note' AND fy = platform.fy_of(current_date) RETURNING next_no - 1, prefix INTO s, p;
     PERFORM pg_temp.ins('sales.credit_note', %L::jsonb || jsonb_build_object('doc_seq', s, 'doc_no', p || lpad(s::text, 6, '0')));
   END $d$$q$, :'rcn'), 'SW9 at most one receipt_reversal credit note per reversal', '%credit_note_reversal_uq%');
COMMIT;
SELECT pg_temp.check((SELECT kind || '|' || total || '|' || store_credit_amount || '|' || balance_available || '|' || (doc_seq = :rcn_seq) || '|' || reversal_receipt_id
                        FROM sales.credit_note WHERE id = :'rcn_id') = 'receipt_reversal|700.00|700.00|700.00|true|' || :'rw_id'
                 AND (SELECT balance_available FROM sales.credit_note WHERE id = :'cn_id') = :cn_before - 700
                 AND NOT EXISTS (SELECT 1 FROM sales.credit_note_line WHERE credit_note_id = :'rcn_id')
                 AND (SELECT count(*) FROM reports.series_gaps) = 0
                 AND EXISTS (SELECT 1 FROM platform.audit_event WHERE table_name = 'sales.credit_note' AND row_id = :'rcn_id' AND action = 'INSERT'),
  'SW10 one new note (700 = the store-credit tender), next gapless credit-note number, no lines, audited; original note stays reduced ('
  || :cn_before || ' -> ' || (SELECT balance_available FROM sales.credit_note WHERE id = :'cn_id') || ')');
BEGIN; SET LOCAL ROLE sales_writer;
UPDATE platform.doc_counter SET next_no = next_no + 1 WHERE tenant_id = platform.current_tenant() AND branch_id = '00000000-0000-0000-0000-00000000b001'
   AND doc_type = 'sales_receipt' AND fy = :'ist_fy' RETURNING 'RCT-CBE-' || replace(substr(fy, 3), '-', '') || '-' || lpad((next_no - 1)::text, 5, '0') AS r5_no \gset
SELECT pg_temp.ins('sales.payment_receipt', :'r1'::jsonb || jsonb_build_object('receipt_no', :'r5_no', 'invoice_id', :'inv2', 'total', 200)) AS r5_id \gset
INSERT INTO sales.payment_receipt_tender(tenant_id, receipt_id, line_no, mode, credit_note_id, amount) VALUES (platform.current_tenant(), :'r5_id', 1, 'credit_note', :'rcn_id', 200);
SELECT pg_temp.expect_error(format($q$UPDATE sales.credit_note SET balance_available = balance_available - 201 WHERE id = %L$q$, :'rcn_id'),
  'SW11 new note: redemption bounded by this transaction''s tenders (guard unchanged)', '%redemption exceeds%');
WITH u AS (UPDATE sales.credit_note SET balance_available = balance_available - 200 WHERE tenant_id = platform.current_tenant() AND id = :'rcn_id'
           AND balance_available >= 200 RETURNING balance_available)
  SELECT pg_temp.check((SELECT balance_available FROM u) = 500, 'SW12 guard-protected decrease works on the new note (700 -> 500)');
SELECT pg_temp.expect_error(format($q$UPDATE sales.credit_note SET balance_available = balance_available + 1 WHERE id = %L$q$, :'rcn_id'),
  'SW13 new note is decrease-only too', '%can only decrease%');
UPDATE sales.invoice_due SET balance_due = balance_due - 200, received_after_issue = received_after_issue + 200, last_receipt_id = :'r5_id', updated_at = now()
 WHERE tenant_id = platform.current_tenant() AND invoice_id = :'inv2' AND balance_due >= 200;
COMMIT;
SELECT pg_temp.check((SELECT payment_status || '|' || balance_due || '|' || receipts_total FROM sales.v_invoice_balance WHERE invoice_id = :'inv2') = 'part_paid|7100.00|3200.00'
                 AND (SELECT balance_available FROM sales.credit_note WHERE id = :'cn_id') = :cn_before - 700
                 AND (SELECT balance_available FROM sales.credit_note WHERE id = :'rcn_id') = 500,
  'SW14 after commit: bill due 7100 (receipts net 3200), new note 500 left, original note unchanged by the reversal: '
  || (SELECT payment_status || '|' || balance_due || '|' || receipts_total FROM sales.v_invoice_balance WHERE invoice_id = :'inv2'));

SELECT pg_temp.check((SELECT string_agg(topic || ':' || alert_type, ',') FROM notifications.outbox WHERE ref_type = 'credit_note' AND ref_id = :'rcn_id') = 'alert.receipt_reversal:receipt_reversal'
                 AND (SELECT string_agg(topic || ':' || alert_type, ',') FROM notifications.outbox WHERE ref_type = 'credit_note' AND ref_id = :'cn_id') = 'alert.sales_return:sales_return'
                 AND (SELECT (payload->>'amount')::numeric FROM notifications.outbox WHERE ref_type = 'credit_note' AND ref_id = :'rcn_id') = 700
                 AND (SELECT prosecdef AND pg_get_userbyid(proowner) = 'notifications_writer' FROM pg_proc WHERE oid = 'notifications.credit_note_alert'::regproc),
  'SW15 reversal note raises exactly one receipt_reversal owner alert ("Payment reversed"), no sales-return alert; the SC sales return still raises sales_return; function still SECURITY DEFINER owned by notifications_writer');

\echo '--- SL document_print: print 1 = ORIGINAL, later prints DUPLICATE with a reason'
BEGIN; SET LOCAL ROLE sales_writer;
INSERT INTO sales.document_print(tenant_id, branch_id, doc_type, doc_id, print_no, copy, paper, language, numerals, printed_by, template_id, template_version)
VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', 'invoice', :'inv_id', 1, 'original', 'A4', 'en', 'western', platform.current_user_id(), '01a1c455-29fa-769b-84f9-377a9bcdab46', 1);
SELECT pg_temp.expect_error(format($q$INSERT INTO sales.document_print(tenant_id, branch_id, doc_type, doc_id, print_no, copy, paper, printed_by, template_id, template_version)
   VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', 'invoice', %L, 2, 'original', 'A4', platform.current_user_id(), '01a1c455-29fa-769b-84f9-377a9bcdab46', 1)$q$, :'inv_id'),
  'SL1 only print 1 is the ORIGINAL', '%document_print_original_check%');
SELECT pg_temp.expect_error(format($q$INSERT INTO sales.document_print(tenant_id, branch_id, doc_type, doc_id, print_no, copy, paper, printed_by, template_id, template_version)
   VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', 'invoice', %L, 2, 'duplicate', 'A4', platform.current_user_id(), '01a1c455-29fa-769b-84f9-377a9bcdab46', 1)$q$, :'inv_id'),
  'SL2 a DUPLICATE needs a reprint reason (3-200 chars)', '%document_print_reason_check%');
INSERT INTO sales.document_print(tenant_id, branch_id, doc_type, doc_id, print_no, copy, paper, reprint_reason, printed_by, template_id, template_version)
VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', 'invoice', :'inv_id', 2, 'duplicate', 'thermal_80mm', 'Customer lost copy', platform.current_user_id(), '01a1c455-29fa-769b-84f9-377a9bcdab46', 1);
SELECT pg_temp.expect_error(format($q$INSERT INTO sales.document_print(tenant_id, branch_id, doc_type, doc_id, print_no, copy, paper, reprint_reason, printed_by, template_id, template_version)
   VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', 'invoice', %L, 2, 'duplicate', 'A4', 'again', platform.current_user_id(), '01a1c455-29fa-769b-84f9-377a9bcdab46', 1)$q$, :'inv_id'),
  'SL3 print numbers are unique per document', '%document_print_no_uq%');
SELECT pg_temp.expect_error(format($q$INSERT INTO sales.document_print(tenant_id, branch_id, doc_type, doc_id, print_no, copy, paper, reprint_reason, printed_by, template_id, template_version)
   VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', 'invoice', %L, 3, 'duplicate', 'A4', 'again', '00000000-0000-0000-0000-000000000a02', '01a1c455-29fa-769b-84f9-377a9bcdab46', 1)$q$, :'inv_id'),
  'SL4 printed_by must be the session user', '%row-level security%');
SELECT pg_temp.expect_error(format($q$INSERT INTO sales.document_print(tenant_id, branch_id, doc_type, doc_id, print_no, copy, paper, language, reprint_reason, printed_by, template_id, template_version)
   VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', 'invoice', %L, 3, 'duplicate', 'A4', 'xx', 'again', platform.current_user_id(), '01a1c455-29fa-769b-84f9-377a9bcdab46', 1)$q$, :'inv_id'),
  'SL5 language must be a platform.language', '%document_print_language_fk%');
SELECT pg_temp.expect_error($$UPDATE sales.document_print SET copy = 'original'$$, 'SL6 print log not editable', '%permission denied%');
COMMIT;
SELECT pg_temp.expect_error(format($q$INSERT INTO sales.document_print(tenant_id, branch_id, doc_type, doc_id, print_no, copy, paper, reprint_reason, printed_by, template_id, template_version)
   VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', 'invoice', %L, 3, 'duplicate', 'A4', 'again', platform.current_user_id(), '01a1c455-29fa-769b-84f9-377a9bcdab46', 1)$q$, :'inv_id'),
  'SL7 app_rw cannot write the print log (sales_writer only)', '%permission denied%');
SELECT pg_temp.expect_error($$DELETE FROM sales.document_print$$, 'SL8 print log not deletable', '%permission denied%');
SELECT pg_temp.check((SELECT string_agg(print_no || ':' || copy, ',' ORDER BY print_no) FROM sales.document_print WHERE doc_id = :'inv_id') = '1:original,2:duplicate'
                 AND (SELECT count(*) FROM platform.audit_event WHERE table_name = 'sales.document_print' AND action = 'INSERT') >= 2,
  'SL9 print 1 original + print 2 duplicate logged and audited');

\echo '--- SX RLS isolation on the new tables and views'
DO $$
DECLARE t text; n bigint;
BEGIN
  PERFORM set_config('app.tenant_id', '00000000-0000-0000-0000-000000000002', false);
  FOREACH t IN ARRAY ARRAY['sales.shop_setting','sales.invoice_due','sales.payment_receipt','sales.payment_receipt_tender','sales.document_print',
                           'sales.v_invoice_balance','sales.v_invoice_list'] LOOP
    EXECUTE 'SELECT count(*) FROM ' || t INTO n;
    IF n <> 0 THEN RAISE EXCEPTION 'FAIL  SX1 tenant 2 sees % rows in %', n, t; END IF;
  END LOOP;
  BEGIN
    INSERT INTO sales.shop_setting(tenant_id) VALUES ('00000000-0000-0000-0000-000000000001');
    RAISE EXCEPTION 'FAIL  SX1 tenant 2 wrote a tenant-1 settings row';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'PASS  SX1 tenant 2 sees 0 rows in the 5 new tables + 2 views and cannot write tenant-1 settings';
  PERFORM set_config('app.tenant_id', '00000000-0000-0000-0000-000000000001', false);
  PERFORM set_config('app.partner_id', '00000000-0000-0000-0000-0000000000a1', false);
  FOREACH t IN ARRAY ARRAY['sales.shop_setting','sales.invoice_due','sales.payment_receipt','sales.payment_receipt_tender','sales.document_print'] LOOP
    EXECUTE 'SELECT count(*) FROM ' || t INTO n;
    IF n <> 0 THEN RAISE EXCEPTION 'FAIL  SX2 partner session sees % rows in %', n, t; END IF;
  END LOOP;
  PERFORM set_config('app.partner_id', '', false);
  RAISE NOTICE 'PASS  SX2 partner session sees nothing in the new sales tables';
  PERFORM set_config('app.branch_scope', '00000000-0000-0000-0000-00000000b987', false);
  IF (SELECT count(*) FROM sales.invoice_due) + (SELECT count(*) FROM sales.payment_receipt) + (SELECT count(*) FROM sales.document_print) <> 0 THEN
    RAISE EXCEPTION 'FAIL  SX3 MDU-scoped session sees CBE dues / receipts / prints';
  END IF;
  PERFORM set_config('app.branch_scope', '', false);
  IF (SELECT count(*) FROM sales.payment_receipt) <> 7 THEN RAISE EXCEPTION 'FAIL  SX3 unscoped session should see 7 receipts'; END IF;
  RAISE NOTICE 'PASS  SX3 branch_scope hides CBE dues, receipts and prints from an MDU-only session';
END $$;
\echo 'ALL SALES (991-993) TESTS DONE'
