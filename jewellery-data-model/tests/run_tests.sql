-- run as app_rw (the API role). Business logic is in the app; these tests exercise the DB guardrails only.
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
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-000000000001',false),
       set_config('app.user_id','00000000-0000-0000-0000-000000000a01',false) \g /dev/null

\echo '--- RLS / tenant isolation'
SELECT pg_temp.check((SELECT count(*) FROM inventory.tag) = 2, 'tenant1 sees its 2 tags');
SELECT pg_temp.check((SELECT count(*) FROM platform.branch) = 1, 'tenant1 sees only its branch');
SELECT pg_temp.expect_error($$INSERT INTO masters.metal(tenant_id, code, name, default_hsn)
       VALUES ('00000000-0000-0000-0000-000000000002','SILVER','Silver','7113')$$, 'cannot write a row for another tenant', '%row-level security%');
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-000000000002',false) \g /dev/null
SELECT pg_temp.check((SELECT count(*) FROM inventory.tag) = 0, 'tenant2 sees none of tenant1 tags');
SELECT pg_temp.check((SELECT count(*) FROM masters.metal) = 1, 'tenant2 sees only its own metal');
SELECT set_config('app.tenant_id','',false) \g /dev/null
SELECT pg_temp.check((SELECT count(*) FROM masters.metal) = 0, 'no tenant set => no rows');
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-000000000001',false) \g /dev/null

\echo '--- constraints'
SELECT pg_temp.expect_error($$INSERT INTO inventory.tag(tenant_id, branch_id, tag_no, item_id, purity_id, gross_wt, net_wt, mc_type)
  VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-00000000b001','T9999','00000000-0000-0000-0000-000000000901',
          '00000000-0000-0000-0000-000000000022',1,1,'flat')$$, 'HUID mandatory (CHECK) unless hallmark_exempt', '%tag_check%');
SELECT pg_temp.expect_error($$INSERT INTO inventory.tag(tenant_id, branch_id, tag_no, item_id, purity_id, huid, gross_wt, net_wt, mc_type)
  VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-00000000b001','T9998','00000000-0000-0000-0000-000000000901',
          '00000000-0000-0000-0000-000000000022','AB12CD',1,1,'flat')$$, 'HUID unique per tenant', '%tag_huid_uq%');
SELECT pg_temp.expect_error($$INSERT INTO inventory.tag(tenant_id, branch_id, tag_no, item_id, purity_id, huid, gross_wt, net_wt, mc_type)
  VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-00000000b001','T9997','00000000-0000-0000-0000-000000000901',
          '00000000-0000-0000-0000-000000000022','QQ11QQ',1,2,'flat')$$, 'net weight cannot exceed gross', '%check%');

SELECT pg_temp.expect_error($$INSERT INTO inventory.tag(tenant_id, branch_id, tag_no, item_id, purity_id, huid, gross_wt, net_wt, mc_type)
  VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-00000000b001','T9996','00000000-0000-0000-0000-000000000901',
          '00000000-0000-0000-0000-000000000022','ab12xy',1,1,'flat')$$, '(e) lowercase HUID rejected (app must upper-case)', '%check%');
SELECT pg_temp.expect_error($$INSERT INTO inventory.tag(tenant_id, branch_id, tag_no, item_id, purity_id, huid, gross_wt, net_wt, mc_type)
  VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-00000000b001','T9995','00000000-0000-0000-0000-000000000901',
          '00000000-0000-0000-0000-000000000022','AB12X',1,1,'flat')$$, '(e) 5-char HUID rejected', '%check%');
SELECT pg_temp.expect_error($$INSERT INTO inventory.tag(tenant_id, branch_id, tag_no, item_id, purity_id, huid, gross_wt, net_wt, mc_type)
  VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-00000000b001','T9994','00000000-0000-0000-0000-000000000901',
          '00000000-0000-0000-0000-000000000022','AB12X-',1,1,'flat')$$, '(e) non-alphanumeric HUID rejected', '%check%');

\echo '--- module ownership by grants'
SELECT pg_temp.expect_error($$INSERT INTO orders.repair(tenant_id, branch_id, repair_no, customer_id)
  VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', 'R1', '00000000-0000-0000-0000-000000000d01')$$,
  '(b) app_rw cannot write orders directly', '%permission denied%');
SELECT pg_temp.expect_error($$INSERT INTO purchases.purchase(tenant_id, branch_id, purchase_no, purchase_date, vendor_id, gst_type)
  VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', 'P1', current_date, gen_random_uuid(), 'intra')$$,
  '(b) app_rw cannot write purchases directly', '%permission denied%');
SELECT pg_temp.expect_error($$INSERT INTO refinery.bag(tenant_id, branch_id, bag_no, metal_id)
  VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', 'B1', gen_random_uuid())$$,
  '(b) app_rw cannot write refinery directly', '%permission denied%');
BEGIN;
SET LOCAL ROLE orders_writer;
INSERT INTO platform.doc_counter(tenant_id, branch_id, doc_type, fy, prefix) VALUES (platform.current_tenant(),
  '00000000-0000-0000-0000-00000000b001', 'repair', platform.fy_of(current_date), 'CBE/RPR/') ON CONFLICT DO NOTHING;
UPDATE platform.doc_counter SET next_no = next_no + 1 WHERE doc_type = 'repair' RETURNING next_no - 1 AS rno \gset
INSERT INTO orders.repair(tenant_id, branch_id, repair_no, customer_id)
  VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', 'CBE/RPR/' || :rno, '00000000-0000-0000-0000-000000000d01');
SELECT pg_temp.check(true, '(b) orders_writer can create a repair (numbered from non-gapless counter)');
SELECT pg_temp.expect_error($$INSERT INTO inventory.stock_ledger(tenant_id) VALUES (platform.current_tenant())$$,
  '(b) orders_writer cannot change stock', '%permission denied%');
SELECT pg_temp.expect_error($$INSERT INTO sales.invoice(tenant_id) VALUES (platform.current_tenant())$$,
  '(b) orders_writer cannot write invoices', '%permission denied%');
COMMIT;
BEGIN;
SET LOCAL ROLE purchases_writer;
SELECT pg_temp.expect_error($$UPDATE inventory.tag SET status = 'returned_to_vendor'$$, '(b) purchases_writer cannot change tag status', '%permission denied%');
SET LOCAL ROLE refinery_writer;
SELECT pg_temp.expect_error($$INSERT INTO inventory.stock_ledger(tenant_id) VALUES (platform.current_tenant())$$,
  '(b) refinery_writer cannot change stock', '%permission denied%');
ROLLBACK;

\echo '--- (f) only tax invoices & credit notes are gapless'
BEGIN; SET LOCAL ROLE sales_writer;
SELECT pg_temp.expect_error($$INSERT INTO sales.doc_series(tenant_id, branch_id, doc_type, fy, prefix)
  VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', 'estimate', '2026-27', 'E/')$$,
  '(f) estimates cannot use the gapless series table', '%check%');
ROLLBACK;
INSERT INTO platform.doc_counter(tenant_id, branch_id, doc_type, fy, prefix) VALUES (platform.current_tenant(),
  '00000000-0000-0000-0000-00000000b001', 'estimate', platform.fy_of(current_date), 'CBE/EST/');
UPDATE platform.doc_counter SET next_no = next_no + 5 WHERE doc_type = 'estimate';
SELECT pg_temp.check((SELECT next_no FROM platform.doc_counter WHERE doc_type = 'estimate') = 6, '(f) estimate counter may skip (gaps allowed)');
SELECT pg_temp.expect_error($$INSERT INTO platform.doc_counter(tenant_id, branch_id, doc_type, fy, prefix) VALUES (platform.current_tenant(),
  '00000000-0000-0000-0000-00000000b001', 'tax_invoice', '2026-27', 'X/')$$, '(f) tax invoices cannot use the non-gapless counter', '%check%');

SELECT pg_temp.expect_error($$INSERT INTO sales.invoice(tenant_id) VALUES ('00000000-0000-0000-0000-000000000001')$$, 'app_rw cannot INSERT invoice', '%permission denied%');
SELECT pg_temp.expect_error($$INSERT INTO inventory.stock_ledger(tenant_id) VALUES ('00000000-0000-0000-0000-000000000001')$$, 'app_rw cannot INSERT stock_ledger', '%permission denied%');
SELECT pg_temp.expect_error($$UPDATE inventory.tag SET status='sold' WHERE tag_no='T0001'$$, 'app_rw cannot change tag status (column grant)', '%permission denied%');
SELECT pg_temp.check((SELECT count(*) FROM (SELECT 1) x WHERE true) = 1 AND
  (SELECT has_column_privilege('app_rw','inventory.tag','size','UPDATE')), 'app_rw can edit descriptive tag columns');
SELECT pg_temp.expect_error($$INSERT INTO accounts.ledger_entry(tenant_id) VALUES ('00000000-0000-0000-0000-000000000001')$$, 'app_rw cannot INSERT ledger_entry', '%permission denied%');

\echo '--- issue invoices via sales module role (app computes values)'
\set tag 00000000-0000-0000-0000-00000000f001
\ir issue_invoice_uow.sql
\set tag ''
\ir issue_invoice_uow.sql
SELECT pg_temp.check((SELECT array_agg(doc_no ORDER BY doc_seq) FROM sales.invoice) =
   ARRAY['CBE/'||replace(substr(platform.fy_of(current_date),3),'-','')||'/000001','CBE/'||replace(substr(platform.fy_of(current_date),3),'-','')||'/000002'], 'two invoices numbered 1,2');
SELECT pg_temp.check((SELECT status FROM inventory.tag WHERE tag_no='T0001') = 'sold', 'tag sold via inventory role in same txn');
SELECT pg_temp.check((SELECT count(*) FROM sales.invoice_line_tax) = 4, 'per-component tax snapshot rows stored');

\echo '--- INV-1 counter guardrails'
BEGIN;
SET LOCAL ROLE sales_writer;
SELECT pg_temp.expect_error($$UPDATE sales.doc_series SET next_no = next_no + 1 WHERE doc_type='tax_invoice';
                              SET CONSTRAINTS ALL IMMEDIATE$$, 'allocating a number without issuing is rejected (no gaps)', '%allocated but not used%');
SELECT pg_temp.expect_error($$UPDATE sales.doc_series SET next_no = 1 WHERE doc_type='tax_invoice'$$, 'counter rewind rejected', '%only advance by 1%');
SELECT pg_temp.expect_error($$UPDATE sales.doc_series SET next_no = next_no + 5 WHERE doc_type='tax_invoice'$$, 'counter skip rejected', '%only advance by 1%');
SELECT pg_temp.expect_error($$INSERT INTO sales.invoice (tenant_id, branch_id, company_id, fy, doc_seq, doc_no, doc_date, customer_snapshot,
   place_of_supply, gst_type, rate_snapshot, gross_value, taxable_value, invoice_total, net_payable, created_by)
   VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-00000000c001',
   platform.fy_of(current_date), 99, 'MANUAL-99', current_date, '{}', '33', 'intra', '{}', 1, 1, 1, 1, platform.current_user_id())$$,
   '(d) client-supplied invoice number 99 rejected', '%not the number allocated%');
SELECT pg_temp.expect_error($$INSERT INTO sales.invoice (tenant_id, branch_id, company_id, fy, doc_seq, doc_no, doc_date, customer_snapshot,
   place_of_supply, gst_type, rate_snapshot, gross_value, taxable_value, invoice_total, net_payable, created_by)
   SELECT platform.current_tenant(), branch_id, '00000000-0000-0000-0000-00000000c001', fy, next_no, prefix || lpad(next_no::text, 6, '0'),
          current_date, '{}', '33', 'intra', '{}', 1, 1, 1, 1, platform.current_user_id()
   FROM sales.doc_series WHERE doc_type = 'tax_invoice'$$,
   '(d) client-supplied "next" number without allocating from the counter rejected', '%not the number allocated%');
SELECT pg_temp.expect_error($$INSERT INTO sales.invoice_line SELECT * FROM sales.invoice_line LIMIT 1$$,
   'cannot add lines to an already-issued invoice', '%transaction that issued the parent%');
SELECT pg_temp.expect_error($$UPDATE sales.invoice SET invoice_total = 1$$, 'sales role cannot edit invoice amounts (column grant)', '%permission denied%');
SELECT pg_temp.expect_error($$UPDATE sales.invoice SET status = 'cancelled' WHERE doc_seq = 1$$, 'cancel without credit note rejected', '%cancellation credit note%');
SELECT pg_temp.expect_error($$DELETE FROM sales.invoice$$, 'sales role cannot DELETE invoice', '%permission denied%');
ROLLBACK;
SELECT pg_temp.expect_error($$DELETE FROM sales.invoice$$, 'app_rw cannot DELETE invoice', '%permission denied%');
SELECT pg_temp.expect_error($$TRUNCATE sales.invoice$$, 'app_rw cannot TRUNCATE invoice', '%permission denied%');

\echo '--- cancellation = credit note (own series) + status change, one transaction'
BEGIN;
SET LOCAL ROLE sales_writer;
INSERT INTO sales.doc_series(tenant_id, branch_id, doc_type, fy, prefix) VALUES (platform.current_tenant(),
   '00000000-0000-0000-0000-00000000b001', 'credit_note', platform.fy_of(current_date), 'CBE/CN/' || right(platform.fy_of(current_date), 2) || '/') ON CONFLICT DO NOTHING;
UPDATE sales.doc_series SET next_no = next_no + 1 WHERE doc_type = 'credit_note' RETURNING next_no - 1 AS cn_seq, prefix AS cn_prefix \gset
INSERT INTO sales.credit_note (tenant_id, branch_id, fy, doc_seq, doc_no, doc_date, invoice_id, kind, reason, taxable_value, cgst, sgst, total, created_by,
       round_off, refund_mode, refund_amount)
SELECT platform.current_tenant(), branch_id, fy, :cn_seq, :'cn_prefix' || lpad(:'cn_seq', 6, '0'), current_date, id, 'cancellation',
       'Customer changed mind', taxable_value, cgst, sgst, invoice_total, platform.current_user_id(), round_off, 'cash', invoice_total
FROM sales.invoice WHERE doc_seq = 1 RETURNING id AS cn_id \gset
INSERT INTO sales.credit_note_line (tenant_id, credit_note_id, invoice_line_id, taxable_value, cgst, sgst, igst, line_total)
SELECT tenant_id, :'cn_id', id, taxable_value, cgst, sgst, igst, line_total FROM sales.invoice_line
 WHERE invoice_id = (SELECT id FROM sales.invoice WHERE doc_seq = 1);
UPDATE sales.invoice SET status = 'cancelled', cancelled_at = now(), cancel_credit_note_id = :'cn_id' WHERE doc_seq = 1;
COMMIT;
SELECT pg_temp.check((SELECT status FROM sales.invoice WHERE doc_seq = 1) = 'cancelled', 'invoice cancelled via credit note, row retained');
SELECT pg_temp.check((SELECT count(*) FROM notifications.outbox WHERE topic = 'alert.invoice_cancelled'
                        AND payload->>'credit_note_id' = :'cn_id' AND payload->>'reason' = 'Customer changed mind') = 1,
                     'INV-5: credit-note trigger wrote cancellation alert to outbox (app inserted none)');
BEGIN; SET LOCAL ROLE sales_writer;
SELECT pg_temp.expect_error($$UPDATE sales.invoice SET status = 'issued', cancel_credit_note_id = NULL WHERE doc_seq = 1$$, 'un-cancel rejected', '%cannot change status%');
SELECT pg_temp.expect_error($$UPDATE sales.credit_note SET balance_available = 999999$$, 'credit note balance cannot increase', '%only decrease%');
ROLLBACK;

\echo '--- INV-6 reconciliation, INV-3 audit'
SELECT pg_temp.check((SELECT count(*) FROM reports.series_gaps) = 0, 'series_gaps returns zero rows');
SELECT pg_temp.check((SELECT count(*) FROM platform.audit_event WHERE table_name = 'sales.invoice') >= 3, 'invoice inserts/updates audited');
SELECT pg_temp.check(platform.audit_verify('00000000-0000-0000-0000-000000000001') IS NULL, 'hash chain verifies');
SELECT pg_temp.expect_error($$UPDATE platform.audit_event SET action='x'$$, 'app_rw cannot UPDATE audit', '%permission denied%');
SELECT pg_temp.expect_error($$DELETE FROM platform.audit_event$$, 'app_rw cannot DELETE audit', '%permission denied%');
SELECT pg_temp.expect_error($$INSERT INTO platform.audit_event(tenant_id, seq, action, prev_hash, hash) VALUES (platform.current_tenant(), 9999, 'x', '\x00', '\x00')$$,
       'app_rw cannot forge audit rows', '%permission denied%');

\echo '--- GST configuration'
-- 5 platform rules: the 4 GST defaults + ZERO_RATED (0% GST, seeded by 991)
SELECT pg_temp.check((SELECT count(*) FROM masters.tax_rule WHERE scope = 'platform') = 5 AND
                     (SELECT count(*) FROM masters.tax_rule WHERE scope = 'tenant') = 2, 'tenant reads platform defaults + own rules');
SELECT pg_temp.expect_error($$INSERT INTO masters.tax_rule(scope, tenant_id, code, component, metal_code, code_type, hsn_sac, rate, cgst_rate, sgst_rate, igst_rate, effective_from)
   VALUES ('tenant', platform.current_tenant(), 'X', 'metal', 'GOLD', 'HSN', '7113', 3, 1.5, 1.5, 3, current_date + 1)$$, 'overlapping effective period rejected', '%tax_rule_%excl%');
SELECT pg_temp.expect_error($$INSERT INTO masters.tax_rule(scope, tenant_id, code, component, code_type, hsn_sac, rate, cgst_rate, sgst_rate, igst_rate, effective_from)
   VALUES ('tenant', platform.current_tenant(), 'X', 'stone', 'HSN', '7102', 3, 1, 1, 3, current_date + 1)$$, 'CGST+SGST must equal rate', '%check%');
SELECT pg_temp.expect_error($$INSERT INTO masters.tax_rule(scope, code, component, code_type, hsn_sac, rate, cgst_rate, sgst_rate, igst_rate, effective_from)
   VALUES ('platform', 'X', 'stone', 'HSN', '7102', 3, 1.5, 1.5, 3, current_date + 1)$$, 'tenant cannot create platform rule', '%row-level security%');
UPDATE masters.tax_rule SET effective_to = '2027-01-01' WHERE scope = 'tenant' AND code = 'GOLD_JEWELLERY';
INSERT INTO masters.tax_rule(scope, tenant_id, code, component, metal_code, code_type, hsn_sac, rate, cgst_rate, sgst_rate, igst_rate, effective_from)
VALUES ('tenant', platform.current_tenant(), 'GOLD_JEWELLERY_2027', 'metal', 'GOLD', 'HSN', '7113', 5, 2.5, 2.5, 5, '2027-01-01');
SELECT pg_temp.check(true, 'rate change = close old rule + open new rule (no overlap)');
-- reference lookup the app's tax service uses: tenant rule beats platform default
SELECT pg_temp.check((SELECT rate FROM masters.tax_rule WHERE component = 'metal' AND metal_code = 'GOLD'
   AND daterange(effective_from, effective_to) @> DATE '2027-02-01'
   ORDER BY (scope = 'tenant') DESC LIMIT 1) = 5, 'effective-dated lookup picks the 2027 tenant rule');
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-000000000002',false) \g /dev/null
SELECT pg_temp.check((SELECT count(*) FROM masters.tax_rule WHERE scope = 'tenant') = 0, 'tenant2 cannot see tenant1 tax rules');
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-000000000001',false) \g /dev/null

\echo '--- branding data + RLS (resolution itself is app logic; reference query below)'
WITH t AS (SELECT * FROM branding.theme WHERE scope = 'tenant'), p AS (SELECT * FROM branding.theme WHERE scope = 'partner'),
     d AS (SELECT * FROM branding.theme WHERE scope = 'platform')
SELECT pg_temp.check(coalesce(t.app_name, p.app_name, d.app_name) = 'GoldDesk' AND coalesce(t.logo_key, p.logo_key, d.logo_key) = 'tenant/t1/logo.svg'
   AND coalesce(t.favicon_key, p.favicon_key, d.favicon_key) = 'platform/fav.ico'
   AND (d.colors || coalesce(p.colors,'{}') || coalesce(t.colors,'{}')) = '{"bg":"#ffffff","accent":"#d4af37","primary":"#880000"}',
   'tenant->partner->platform resolution over visible rows')
FROM d LEFT JOIN p ON true LEFT JOIN t ON true;
WITH u AS (UPDATE branding.theme SET app_name='Hacked' WHERE scope IN ('partner','platform') RETURNING 1)
  SELECT pg_temp.check(count(*) = 0, 'tenant cannot edit partner/platform theme') FROM u;
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-000000000002',false) \g /dev/null
SELECT pg_temp.check((SELECT count(*) FROM branding.theme) = 1, 'direct tenant sees only platform theme');
SELECT pg_temp.check((SELECT count(*) FROM branding.sender_config) = 0, 'tenant2 sees no partner sender config');
SELECT set_config('app.tenant_id','',false), set_config('app.partner_id','00000000-0000-0000-0000-0000000000a1',false) \g /dev/null
SELECT pg_temp.check((SELECT count(*) FROM platform.v_partner_tenant_directory) = 1, 'partner session sees only its tenant (directory)');
SELECT pg_temp.check((SELECT count(*) FROM branding.theme WHERE scope = 'tenant') = 1, 'partner sees its tenants'' themes');
SELECT set_config('app.partner_id','',false) \g /dev/null
SELECT pg_temp.check((SELECT tenant_id FROM branding.custom_domain WHERE hostname = 'billing.srilakshmi.in') = '00000000-0000-0000-0000-000000000001',
       'verified custom domain resolvable pre-auth (no tenant set)');
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-000000000001',false) \g /dev/null
SELECT pg_temp.expect_error($$UPDATE branding.print_template SET is_active = true WHERE version = 2$$, 'two active templates per type rejected', '%print_template_one_active%');

\echo '--- N16/N19 tax rule immutability, no back-dating, delete only if unreferenced'
SELECT pg_temp.check((SELECT first_used_at IS NOT NULL FROM masters.tax_rule WHERE scope='tenant' AND code='MAKING_COMPOSITE'), 'DB marks rule as used on first invoice line');
SELECT pg_temp.expect_error($$INSERT INTO masters.tax_rule(scope, tenant_id, code, component, code_type, hsn_sac, rate, cgst_rate, sgst_rate, igst_rate, effective_from)
   VALUES ('tenant', platform.current_tenant(), 'BACKDATED', 'stone', 'HSN', '7102', 3, 1.5, 1.5, 3, current_date - 1)$$, 'N16 back-dated effective_from rejected', '%in the past%');
SELECT pg_temp.expect_error($$UPDATE masters.tax_rule SET rate = 5, cgst_rate = 2.5, sgst_rate = 2.5, igst_rate = 5 WHERE scope='tenant' AND code='MAKING_COMPOSITE'$$,
   'N16 referenced rule: rate change rejected', '%only effective_to NULL%');
SELECT pg_temp.expect_error($$UPDATE masters.tax_rule SET effective_to = current_date - 1 WHERE scope='tenant' AND code='MAKING_COMPOSITE'$$,
   'N19 referenced rule: effective_to in the past rejected', '%only effective_to NULL%');
SELECT pg_temp.expect_error($$UPDATE masters.tax_rule SET effective_to = '2030-01-01' WHERE scope='tenant' AND code='GOLD_JEWELLERY'$$,
   'N19 referenced rule: moving an already-set effective_to rejected', '%only effective_to NULL%');
UPDATE masters.tax_rule SET effective_to = current_date + 30 WHERE scope='tenant' AND code='MAKING_COMPOSITE';
SELECT pg_temp.check(true, 'N19 referenced rule: effective_to NULL -> future date allowed');
SELECT pg_temp.expect_error($$DELETE FROM masters.tax_rule WHERE scope='tenant' AND code='MAKING_COMPOSITE'$$, 'N16 referenced rule cannot be deleted (FK RESTRICT)', '%foreign key%');
INSERT INTO masters.tax_rule(scope, tenant_id, code, component, code_type, hsn_sac, rate, cgst_rate, sgst_rate, igst_rate, effective_from)
VALUES ('tenant', platform.current_tenant(), 'UNUSED_STONE', 'stone', 'HSN', '7102', 3, 1.5, 1.5, 3, current_date + 1);
WITH d AS (DELETE FROM masters.tax_rule WHERE code = 'UNUSED_STONE' RETURNING 1)
SELECT pg_temp.check(count(*) = 1, 'N16 unreferenced rule can be deleted') FROM d;

\echo '--- per-tenant sales policy: platform defaults + tenant override'
SELECT pg_temp.check((SELECT making_gst_treatment = 'composite' AND old_gold_valuation_basis = 'stated_purity'
        AND old_gold_excess_handling = 'separate_purchase' AND return_settlement_default = 'store_credit' AND return_window_days = 15
        FROM masters.sales_policy WHERE scope = 'platform'), 'platform default policy seeded (composite, stated purity, purchase voucher, store credit, 15 days)');
SELECT pg_temp.check((SELECT rate FROM masters.tax_rule WHERE scope='platform' AND code='MAKING_COMPOSITE') = 3
        AND (SELECT composite_supply FROM masters.tax_rule WHERE scope='platform' AND code='MAKING_COMPOSITE'), 'platform default: making composite 3% with metal');
SELECT pg_temp.check((SELECT return_window_days FROM masters.sales_policy WHERE daterange(effective_from, effective_to) @> current_date
        ORDER BY (scope = 'tenant') DESC LIMIT 1) = 15, 'tenant without override reads platform default');
INSERT INTO masters.sales_policy(scope, tenant_id, making_gst_treatment, making_tax_rule_code, old_gold_valuation_basis, old_gold_excess_handling,
       credit_note_rounding, return_settlement_default, return_window_days, effective_from)
VALUES ('tenant', platform.current_tenant(), 'separate', 'MAKING_SEPARATE', 'fine_24k', 'refund_on_bill', 'exact', 'refund', 30, current_date);
SELECT pg_temp.check((SELECT return_window_days FROM masters.sales_policy WHERE daterange(effective_from, effective_to) @> current_date
        ORDER BY (scope = 'tenant') DESC LIMIT 1) = 30, 'tenant override wins (30 days, separate making, 24K basis)');
SELECT pg_temp.expect_error($$INSERT INTO masters.sales_policy(scope, tenant_id, making_gst_treatment, old_gold_valuation_basis, old_gold_excess_handling,
       credit_note_rounding, return_settlement_default, return_window_days, effective_from)
       VALUES ('tenant', platform.current_tenant(), 'separate', 'stated_purity', 'separate_purchase', 'exact', 'refund', 7, current_date + 5)$$,
       'separate making needs a rule code; overlapping tenant policy rejected', '%');
WITH u AS (UPDATE masters.sales_policy SET return_window_days = 99 WHERE scope = 'platform' RETURNING 1)
SELECT pg_temp.check(count(*) = 0, 'tenant cannot change platform default policy') FROM u;
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-000000000002',false) \g /dev/null
SELECT pg_temp.check((SELECT return_window_days FROM masters.sales_policy WHERE daterange(effective_from, effective_to) @> current_date
        ORDER BY (scope = 'tenant') DESC LIMIT 1) = 15 AND (SELECT count(*) FROM masters.sales_policy WHERE scope='tenant') = 0,
        'tenant2 still on platform default, cannot see tenant1 override');
INSERT INTO masters.gst_config(tenant_id, effective_from) VALUES (platform.current_tenant(), current_date);
SELECT pg_temp.check((SELECT rounding_level FROM masters.gst_config) = 'invoice', 'N1 gst_config.rounding_level defaults to invoice');
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-000000000001',false) \g /dev/null

\echo '--- redemption of advance + credit note in one invoice transaction (no DB function)'
INSERT INTO sales.advance(tenant_id, id, branch_id, receipt_no, customer_id, kind, amount, balance)
VALUES (platform.current_tenant(), '00000000-0000-0000-0000-0000000ad001', '00000000-0000-0000-0000-00000000b001', 'ADV-1',
        '00000000-0000-0000-0000-000000000d01', 'amount', 10000, 10000);
SELECT pg_temp.expect_error($$UPDATE sales.advance SET balance = 0$$, 'app_rw cannot change advance balance (column grant)', '%permission denied%');
-- store-credit credit note (sales return of invoice 2)
BEGIN;
SET LOCAL ROLE sales_writer;
UPDATE sales.doc_series SET next_no = next_no + 1 WHERE doc_type = 'credit_note' RETURNING next_no - 1 AS cn_seq, prefix AS cn_prefix \gset
INSERT INTO sales.credit_note (tenant_id, branch_id, fy, doc_seq, doc_no, doc_date, invoice_id, kind, reason, taxable_value, total,
       refund_mode, balance_available, created_by, customer_id, store_credit_amount)
SELECT platform.current_tenant(), branch_id, fy, :cn_seq, :'cn_prefix' || lpad(:'cn_seq', 6, '0'), current_date, id, 'sales_return',
       'Size exchange', 5000, 5000, 'store_credit', 5000, platform.current_user_id(), '00000000-0000-0000-0000-000000000d01', 5000
FROM sales.invoice WHERE doc_seq = 2 RETURNING id AS sc_id \gset
COMMIT;
-- the redemption unit of work
BEGIN;
SET LOCAL ROLE sales_writer;
UPDATE sales.doc_series SET next_no = next_no + 1 WHERE doc_type = 'tax_invoice' RETURNING next_no - 1 AS seq, prefix, fy \gset
INSERT INTO sales.idempotency_key(tenant_id, key) VALUES (platform.current_tenant(), 'idem-redeem-0001');
INSERT INTO sales.invoice (tenant_id, branch_id, company_id, fy, doc_seq, doc_no, doc_date, customer_id, customer_snapshot, place_of_supply,
   gst_type, rate_snapshot, gross_value, taxable_value, cgst, sgst, invoice_total, net_payable, paid_amount, balance_due, created_by,
   salesperson_id, making_gst_treatment, round_off_to, pan_required, pan_on_file, cash_amount)
VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-00000000c001', :'fy', :seq,
   :'prefix' || lpad(:'seq', 6, '0'), DATE '2020-01-01', '00000000-0000-0000-0000-000000000d01', '{"name":"Priya"}', '33', 'intra', '{}',
   20000, 20000, 300, 300, 20600, 20600, 20600, 0, platform.current_user_id(),
   '00000000-0000-0000-0000-0000000057a0', 'composite', 1.00, false, false, 12600)
RETURNING id AS rinv \gset
UPDATE sales.idempotency_key SET invoice_id = :'rinv' WHERE key = 'idem-redeem-0001';
INSERT INTO sales.invoice_payment (tenant_id, invoice_id, line_no, mode, amount, advance_id) VALUES (platform.current_tenant(), :'rinv', 1, 'advance', 3000, '00000000-0000-0000-0000-0000000ad001');
INSERT INTO sales.invoice_payment (tenant_id, invoice_id, line_no, mode, amount, credit_note_id) VALUES (platform.current_tenant(), :'rinv', 2, 'credit_note', 5000, :'sc_id');
INSERT INTO sales.invoice_payment (tenant_id, invoice_id, line_no, mode, amount) VALUES (platform.current_tenant(), :'rinv', 3, 'cash', 12600);
SELECT pg_temp.expect_error($$UPDATE sales.advance SET balance = balance - 3001 WHERE receipt_no = 'ADV-1'$$, 'over-redeeming an advance (beyond its payment) rejected', '%exceeds advance payments%');
SELECT pg_temp.expect_error($$UPDATE sales.credit_note SET balance_available = balance_available - 5001 WHERE id = '$$ || :'sc_id' || $$'$$, 'over-redeeming store credit rejected', '%');
UPDATE sales.advance SET balance = balance - 3000, status = 'partly_redeemed' WHERE receipt_no = 'ADV-1';
UPDATE sales.credit_note SET balance_available = balance_available - 5000 WHERE id = :'sc_id';
COMMIT;
SELECT pg_temp.check((SELECT balance FROM sales.advance WHERE receipt_no = 'ADV-1') = 7000
                 AND (SELECT balance_available FROM sales.credit_note WHERE id = :'sc_id') = 0, 'advance 10000->7000 and store credit 5000->0 redeemed in one invoice tx');
SELECT pg_temp.check((SELECT doc_date FROM sales.invoice WHERE id = :'rinv') = (now() AT TIME ZONE 'Asia/Kolkata')::date,
                     'doc_date forced to server IST date (client sent 2020-01-01)');
BEGIN; SET LOCAL ROLE sales_writer;
SELECT pg_temp.expect_error($$UPDATE sales.advance SET balance = balance - 1 WHERE receipt_no = 'ADV-1'$$, 'redemption outside an invoice tx rejected', '%exceeds advance payments%');
SELECT pg_temp.expect_error($$UPDATE sales.credit_note SET balance_available = -1 WHERE id = '$$ || :'sc_id' || $$'$$, 'store credit cannot go below 0', '%');
SELECT pg_temp.expect_error($$INSERT INTO sales.idempotency_key(tenant_id, key) VALUES (platform.current_tenant(), 'idem-redeem-0001')$$,
       'duplicate idempotency key rejected', '%idempotency_key_pkey%');
INSERT INTO sales.idempotency_key(tenant_id, key, created_at) VALUES (platform.current_tenant(), 'idem-expired-0001', now() - interval '25 hours');
COMMIT;

\echo '--- N8 outbox ref fields: credit-note alert written only by trigger, one per note'
SELECT pg_temp.check((SELECT count(*) FROM notifications.outbox WHERE ref_type = 'credit_note' AND ref_id = :'sc_id' AND alert_type = 'sales_return') = 1,
       'N8 trigger fills ref_type=credit_note, ref_id, alert_type (one row)');
SELECT pg_temp.expect_error($$INSERT INTO notifications.outbox(tenant_id, topic, payload) VALUES (platform.current_tenant(), 'alert.invoice_cancelled', '{}')$$,
       'app cannot write a cancellation alert without alert_type (CHECK)', '%check%');
SELECT pg_temp.expect_error($$INSERT INTO notifications.outbox(tenant_id, topic, payload, ref_type, ref_id, alert_type)
       VALUES (platform.current_tenant(), 'alert.sales_return', '{}', 'credit_note', '$$ || :'sc_id' || $$', 'sales_return')$$,
       'N8 app cannot set alert_type (column grant)', '%permission denied%');
INSERT INTO notifications.outbox(tenant_id, topic, payload, ref_type, ref_id) VALUES (platform.current_tenant(), 'bill.whatsapp', '{}', 'invoice', :'rinv');
SELECT pg_temp.check(true, 'N8 app may set ref_type/ref_id on ordinary messages');
SELECT pg_temp.expect_error($$INSERT INTO notifications.outbox(tenant_id, topic, payload, ref_type) VALUES (platform.current_tenant(), 'x', '{}', 'invoice')$$,
       'N8 ref_type without ref_id rejected', '%check%');
SELECT pg_temp.check(EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'outbox_alert_uq'
       AND indexdef LIKE '%UNIQUE%(tenant_id, ref_type, ref_id, alert_type) WHERE (alert_type IS NOT NULL)%'), 'N8 partial unique index (tenant_id, ref_type, ref_id, alert_type) present');

\echo '--- N10 issued invoice immutable except guarded issued -> cancelled'
BEGIN; SET LOCAL ROLE sales_writer;
DO $$
DECLARE c record; n int := 0;
BEGIN
  FOR c IN SELECT column_name FROM information_schema.columns WHERE table_schema = 'sales' AND table_name = 'invoice'
           AND column_name NOT IN ('status','cancelled_at','cancel_credit_note_id','irn','irn_ack_at') LOOP
    BEGIN
      EXECUTE format('UPDATE sales.invoice SET %I = %I WHERE doc_seq = 2', c.column_name, c.column_name);
      RAISE EXCEPTION 'FAIL  column % of an issued invoice was updatable', c.column_name;
    EXCEPTION WHEN insufficient_privilege THEN n := n + 1;
    END;
  END LOOP;
  RAISE NOTICE 'PASS  N10 all % non-status invoice columns are not updatable by the sales role', n;
END $$;
SELECT pg_temp.expect_error($$UPDATE sales.invoice SET irn = 'X' WHERE doc_seq = 1$$, 'N10 cancelled invoice frozen (even IRN)', '%frozen%');
UPDATE sales.invoice SET irn = 'IRN-2', irn_ack_at = now() WHERE doc_seq = 2;
SELECT pg_temp.expect_error($$UPDATE sales.invoice SET irn = 'IRN-X' WHERE doc_seq = 2$$, 'N10 IRN stamped once only', '%already stamped%');
SELECT pg_temp.expect_error($$UPDATE sales.invoice SET status = 'draft' WHERE doc_seq = 2$$, 'N10 issued -> other status rejected', '%check%');
ROLLBACK;

\echo '--- weights numeric(12,3), HUID check on tags + invoice lines, languages, onboarding'
SELECT pg_temp.check((SELECT count(*) FROM information_schema.columns c
        WHERE c.table_schema IN ('masters','inventory','sales','purchases','refinery','orders','accounts')
          AND (c.column_name LIKE '%\_wt' OR c.column_name LIKE '%weight%' OR c.column_name IN ('loss_wt','diff_gross','tare_weight','approx_wt'))
          AND NOT (c.numeric_precision = 12 AND c.numeric_scale = 3)
          AND c.data_type = 'numeric' AND c.domain_name IS NULL) = 0
     AND (SELECT numeric_precision FROM information_schema.domains WHERE domain_name = 'weight_g') = 12,
     'every weight column / weight_g domain is numeric(12,3)');
INSERT INTO inventory.tag(tenant_id, branch_id, tag_no, item_id, purity_id, huid, gross_wt, net_wt, mc_type)
VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001','TBIG','00000000-0000-0000-0000-000000000901',
        '00000000-0000-0000-0000-000000000022','BIG123',123456789.123,123456789.123,'flat');
SELECT pg_temp.check((SELECT gross_wt FROM inventory.tag WHERE tag_no='TBIG') = 123456789.123, '12,3 weight stored exactly (123456789.123 g)');
SELECT pg_temp.check((SELECT count(*) FROM pg_constraint WHERE pg_get_constraintdef(oid) LIKE '%huid%[A-Z0-9]{6}%'
        AND conrelid IN ('inventory.tag'::regclass, 'sales.invoice_line'::regclass)) = 2, 'HUID uppercase CHECK present on inventory.tag AND sales.invoice_line');
SELECT pg_temp.check((SELECT default_language FROM platform.tenant) = 'en', 'tenant default_language defaults to en');
UPDATE platform.app_user SET language = 'ta' WHERE name = 'Cashier One';
SELECT pg_temp.check((SELECT coalesce(u.language, t.default_language) FROM platform.app_user u JOIN platform.tenant t ON t.id = u.tenant_id
        WHERE u.name = 'Cashier One') = 'ta', 'user language override (ta) over tenant default');
SELECT pg_temp.expect_error($$UPDATE platform.app_user SET language = 'Tamil'$$, 'invalid language code rejected', '%check%');
-- K: platform.language lookup (950) — every language column references it
SELECT pg_temp.check((SELECT string_agg(code, ',' ORDER BY code) FROM platform.language) = 'en,hi,kn,ml,ta,te'
       AND (SELECT native_name FROM platform.language WHERE code = 'ta') = 'தமிழ்', 'K1 platform.language has en/ta/hi/te/kn/ml with native names');
SELECT pg_temp.expect_error($$UPDATE platform.app_user SET language = 'fr'$$, 'K2 user language must exist in platform.language', '%foreign key%');
SELECT pg_temp.expect_error($$UPDATE platform.tenant SET default_language = 'fr'$$, 'K3 tenant default_language must exist in platform.language', '%foreign key%');
SELECT pg_temp.expect_error($$INSERT INTO branding.print_template(scope, tenant_id, doc_type, version, body_key, print_language, numeral_system)
  VALUES ('tenant', platform.current_tenant(), 'receipt', 9, 'tpl/t1/receipt-fr.hbs', 'fr', 'latin')$$, 'K4 print_language must exist in platform.language', '%foreign key%');
SELECT pg_temp.expect_error($$INSERT INTO notifications.template(tenant_id, topic, channel, locale, body)
  VALUES (platform.current_tenant(), 'k5.topic', 'sms', 'fr', 'x')$$, 'K5 notification template locale must exist in platform.language', '%foreign key%');
SELECT pg_temp.expect_error($$INSERT INTO platform.language VALUES ('fr','French','Français')$$, 'K6 API cannot add languages', '%permission denied%');
INSERT INTO branding.print_template(scope, tenant_id, doc_type, version, body_key, print_language, numeral_system)
VALUES ('tenant', platform.current_tenant(), 'receipt', 1, 'tpl/t1/receipt-ta.hbs', 'ta', 'tamil');
SELECT pg_temp.check((SELECT numeral_system FROM branding.print_template WHERE doc_type='receipt' AND scope='tenant') = 'tamil', 'print template language ta + tamil numerals');
SELECT pg_temp.expect_error($$INSERT INTO branding.print_template(scope, tenant_id, doc_type, version, body_key, numeral_system)
       VALUES ('tenant', platform.current_tenant(), 'receipt', 2, 'k', 'klingon')$$, 'unknown numeral system rejected', '%check%');
INSERT INTO platform.onboarding_progress(tenant_id, step, status, completed_at) VALUES (platform.current_tenant(), 'shop_profile', 'completed', now());
SELECT pg_temp.expect_error($$INSERT INTO platform.onboarding_progress(tenant_id, step) VALUES (platform.current_tenant(), 'shop_profile')$$, 'onboarding step unique per tenant', '%duplicate key%');
SELECT pg_temp.expect_error($$INSERT INTO platform.onboarding_progress(tenant_id, step, status) VALUES (platform.current_tenant(), 'todays_rates', 'completed')$$, 'completed step needs completed_at', '%check%');
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-000000000002',false) \g /dev/null
SELECT pg_temp.check((SELECT count(*) FROM platform.onboarding_progress) = 0, 'onboarding progress isolated by RLS');
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-000000000001',false) \g /dev/null

\echo '--- settings: platform defaults (N14 PAN, INV-5 alert thresholds, P11 session timeout) and tenant override'
CREATE FUNCTION pg_temp.setting(k text, b uuid DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$
  SELECT coalesce((SELECT value FROM platform.setting WHERE key = k AND branch_id = b),
                  (SELECT value FROM platform.setting WHERE key = k AND branch_id IS NULL),
                  (SELECT value FROM platform.setting_default WHERE key = k)) $$;
SELECT pg_temp.check(pg_temp.setting('sales.pan_required_above') = '200000.00'::jsonb, 'N14 PAN threshold default 200000.00');
SELECT pg_temp.check(pg_temp.setting('alerts.cancellation.alert_every') = 'true'::jsonb
                 AND pg_temp.setting('alerts.cancellation.escalate_per_branch_per_day') = '5'::jsonb, 'INV-5 defaults: alert every cancellation, escalate above 5/branch/day');
SELECT pg_temp.check(pg_temp.setting('auth.session_timeout_minutes') = '30'::jsonb, 'P11 session timeout default 30 min');
INSERT INTO platform.setting(tenant_id, key, value) VALUES (platform.current_tenant(), 'sales.pan_required_above', '150000.00'),
       (platform.current_tenant(), 'alerts.cancellation.escalate_per_branch_per_day', '3'), (platform.current_tenant(), 'auth.session_timeout_minutes', '10');
INSERT INTO platform.setting(tenant_id, branch_id, key, value) VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', 'auth.session_timeout_minutes', '5');
SELECT pg_temp.check(pg_temp.setting('sales.pan_required_above') = '150000.00'::jsonb AND pg_temp.setting('alerts.cancellation.escalate_per_branch_per_day') = '3'::jsonb,
       'tenant override wins (PAN 1.5L, escalate above 3)');
SELECT pg_temp.check(pg_temp.setting('auth.session_timeout_minutes', '00000000-0000-0000-0000-00000000b001') = '5'::jsonb, 'branch override wins over tenant (5 min)');
SELECT pg_temp.expect_error($$INSERT INTO platform.setting(tenant_id, key, value) VALUES (platform.current_tenant(), 'sales.pan_limit_typo', '1')$$, 'unknown setting key rejected', '%foreign key%');
SELECT pg_temp.expect_error($$UPDATE platform.setting SET value = '"ten"' WHERE key = 'auth.session_timeout_minutes' AND branch_id IS NULL$$, 'wrong value type rejected', '%expects integer%');
SELECT pg_temp.expect_error($$UPDATE platform.setting SET value = '2.5' WHERE key = 'alerts.cancellation.escalate_per_branch_per_day'$$, 'integer setting rejects 2.5', '%expects integer%');
SELECT pg_temp.expect_error($$UPDATE platform.setting_default SET value = '1' WHERE key = 'sales.pan_required_above'$$, 'tenant cannot change platform defaults', '%permission denied%');
DELETE FROM platform.setting WHERE key = 'alerts.cancellation.escalate_per_branch_per_day';
SELECT pg_temp.check(pg_temp.setting('alerts.cancellation.escalate_per_branch_per_day') = '5'::jsonb, 'removing the override falls back to the platform default');
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-000000000002',false) \g /dev/null
SELECT pg_temp.check(pg_temp.setting('sales.pan_required_above') = '200000.00'::jsonb, 'tenant2 unaffected by tenant1 override');
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-000000000001',false) \g /dev/null

\echo '--- P5/P7 system roles only (custom roles deferred)'
SELECT pg_temp.check((SELECT array_agg(code ORDER BY rank) FROM platform.system_role) = '{owner,manager,salesperson,cashier}', 'P5 four preset roles');
SELECT pg_temp.check((SELECT count(*) FROM platform.permission) = (SELECT count(*) FROM platform.system_role_permission WHERE role_code = 'owner'), 'P7 owner holds every permission');
SELECT pg_temp.check(NOT EXISTS (SELECT 1 FROM platform.system_role_permission WHERE role_code IN ('cashier','salesperson')
       AND permission_code IN ('sales.invoice.cancel','sales.discount.give','rates.edit','reports.view')), 'P7 cashier/salesperson cannot cancel, discount, edit rates, see reports');
SELECT pg_temp.expect_error($$INSERT INTO platform.role(tenant_id, name, system_role_code) VALUES (platform.current_tenant(), 'Billing lead', 'billing_lead')$$, 'P6 custom role rejected (deferred)', '%foreign key%');
SELECT pg_temp.expect_error($$INSERT INTO platform.role(tenant_id, name) VALUES (platform.current_tenant(), 'Nameless')$$, 'role must map to a system role', '%null value%');
SELECT pg_temp.expect_error($$INSERT INTO platform.system_role_permission VALUES ('cashier','sales.invoice.cancel')$$, 'tenant cannot change preset permissions', '%permission denied%');

\echo '--- P8 password login identity, P9 OTP'
UPDATE platform.app_user SET username = 'cashier1' WHERE name = 'Cashier One';
SELECT pg_temp.expect_error($$UPDATE platform.app_user SET username = 'cashier1' WHERE name = 'Sales No-Perm'$$, 'P8 username unique per tenant', '%duplicate key%');
SELECT pg_temp.expect_error($$UPDATE platform.app_user SET username = 'Cashier1' WHERE name = 'Sales No-Perm'$$, 'P8 username must be lowercase', '%check%');
SELECT pg_temp.expect_error($$INSERT INTO platform.app_user(tenant_id, name) VALUES (platform.current_tenant(), 'No login')$$, 'P8 user needs username or mobile', '%check%');
INSERT INTO platform.otp_challenge(tenant_id, user_id, channel, code_hash, expires_at)
VALUES (platform.current_tenant(), '00000000-0000-0000-0000-000000000a01', 'whatsapp', sha256('123456'), now() + interval '5 minutes');
SELECT pg_temp.expect_error($$INSERT INTO platform.otp_challenge(tenant_id, user_id, channel, code_hash, expires_at)
       VALUES (platform.current_tenant(), '00000000-0000-0000-0000-000000000a01', 'sms', sha256('1'), now() + interval '1 hour')$$, 'P9 OTP validity capped at 15 min', '%check%');
SELECT pg_temp.expect_error($$UPDATE platform.otp_challenge SET attempts = 6$$, 'P9 OTP max 5 attempts', '%check%');
SELECT pg_temp.expect_error($$INSERT INTO platform.otp_challenge(tenant_id, user_id, channel, code_hash, expires_at)
       VALUES (platform.current_tenant(), '00000000-0000-0000-0000-000000000a01', 'email', sha256('1'), now() + interval '1 minute')$$, 'P9 OTP channel sms/whatsapp only', '%check%');

\echo '--- P10 counter devices, sessions'
INSERT INTO platform.device(tenant_id, id, branch_id, name, fingerprint_hash)
VALUES (platform.current_tenant(), '00000000-0000-0000-0000-0000000de001', '00000000-0000-0000-0000-00000000b001', 'Counter 1', sha256('dev-1'));
SELECT pg_temp.expect_error($$UPDATE platform.device SET status = 'approved' WHERE name = 'Counter 1'$$, 'P10 approval needs approver + time', '%check%');
UPDATE platform.device SET status = 'approved', approved_by = '00000000-0000-0000-0000-000000000a01', approved_at = now() WHERE name = 'Counter 1';
SELECT pg_temp.expect_error($$INSERT INTO platform.device(tenant_id, branch_id, name, fingerprint_hash)
       VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', 'Clone', sha256('dev-1'))$$, 'P10 same device fingerprint cannot register twice', '%duplicate key%');
INSERT INTO platform.user_session(tenant_id, user_id, device_id, token_hash, expires_at)
VALUES (platform.current_tenant(), '00000000-0000-0000-0000-000000000a01', '00000000-0000-0000-0000-0000000de001', sha256('tok-1'), now() + interval '12 hours'),
       (platform.current_tenant(), '00000000-0000-0000-0000-000000000a01', '00000000-0000-0000-0000-0000000de001', sha256('tok-2'), now() + interval '12 hours');
UPDATE platform.device SET status = 'revoked', revoked_at = now(), revoked_by = '00000000-0000-0000-0000-000000000a01', revoke_reason = 'lost' WHERE name = 'Counter 1';
SELECT pg_temp.check((SELECT count(*) FROM platform.user_session WHERE revoked_at IS NOT NULL AND revoke_reason = 'device_revoked') = 2,
       'P10 revoking a lost device logs out its 2 live sessions');
SELECT pg_temp.expect_error($$INSERT INTO platform.user_session(tenant_id, user_id, device_id, token_hash, expires_at)
       VALUES (platform.current_tenant(), '00000000-0000-0000-0000-000000000a01', '00000000-0000-0000-0000-0000000dffff', sha256('t'), now())$$, 'session device must be registered', '%foreign key%');

\echo '--- P15 onboarding wizard, P17 domains/HTTPS, P21 imports'
SELECT pg_temp.check((SELECT count(*) FROM platform.onboarding_step) = 10 AND (SELECT max(seq) FROM platform.onboarding_step) = 10
       AND (SELECT array_agg(code ORDER BY seq) FROM platform.onboarding_step) = '{shop_profile,gst,branches,metals_purities,gst_rates,todays_rates,users_roles,branding,printers_language,import}',
       'P15 exactly the 10 agreed wizard steps, in order');
SELECT pg_temp.check((SELECT array_agg(code ORDER BY seq) FROM platform.onboarding_step WHERE required_for_billing) = '{shop_profile,gst,metals_purities,gst_rates,todays_rates}'
       AND NOT EXISTS (SELECT 1 FROM platform.onboarding_step WHERE code = 'devices'), 'P15 billing-unlock steps flagged; no devices step');
SELECT pg_temp.check((SELECT NOT billing_unlocked AND missing_steps = '{gst,metals_purities,gst_rates,todays_rates}' FROM platform.v_billing_unlocked),
       'P15 v_billing_unlocked: locked, lists the 4 missing required steps');
INSERT INTO platform.onboarding_progress(tenant_id, step, status, completed_at)
SELECT platform.current_tenant(), code, 'completed', now() FROM platform.onboarding_step WHERE code IN ('gst','metals_purities','gst_rates','todays_rates');
INSERT INTO platform.onboarding_progress(tenant_id, step, status) VALUES (platform.current_tenant(), 'branches', 'skipped');
SELECT pg_temp.check((SELECT billing_unlocked AND missing_steps = '{}' FROM platform.v_billing_unlocked), 'P15 billing unlocked once the 5 required steps are complete (optional steps skipped/pending)');
SELECT pg_temp.check((SELECT count(*) FROM platform.v_billing_unlocked) = 1, 'P15 view shows only the caller''s tenant (RLS)');
SELECT pg_temp.expect_error($$INSERT INTO platform.onboarding_progress(tenant_id, step) VALUES (platform.current_tenant(), 'step_11')$$, 'P15 unknown wizard step rejected', '%foreign key%');
SELECT pg_temp.check((SELECT s.code FROM platform.onboarding_step s LEFT JOIN platform.onboarding_progress p ON p.step = s.code AND p.status IN ('completed','skipped')
       WHERE p.id IS NULL ORDER BY s.seq LIMIT 1) = 'users_roles', 'P15 resume point = first incomplete step (users_roles)');
INSERT INTO branding.custom_domain(hostname, tenant_id) VALUES ('shop.example.in', platform.current_tenant());
SELECT pg_temp.expect_error($$UPDATE branding.custom_domain SET tls_status = 'active', tls_expires_at = now() + interval '90 days' WHERE hostname = 'shop.example.in'$$,
       'P17 no certificate for an unverified domain', '%check%');
INSERT INTO platform.import_job(tenant_id, id, kind, file_key, created_by) VALUES
 (platform.current_tenant(), '00000000-0000-0000-0000-00000000f001', 'customers', 'imports/t1/customers.csv', '00000000-0000-0000-0000-000000000a01');
SELECT pg_temp.expect_error($$UPDATE platform.import_job SET status = 'completed' WHERE id = '00000000-0000-0000-0000-00000000f001'$$, 'P21 dry run can never write data', '%check%');
UPDATE platform.import_job SET status = 'validated', total_rows = 100, ok_rows = 98, error_rows = 2, error_report_key = 'imports/t1/err.csv';
SELECT pg_temp.expect_error($$INSERT INTO platform.import_job(tenant_id, kind, file_key, dry_run, created_by)
       VALUES (platform.current_tenant(), 'customers', 'k', false, '00000000-0000-0000-0000-000000000a01')$$, 'P21 real import without a dry run rejected', '%check%');
INSERT INTO platform.import_job(tenant_id, kind, file_key, dry_run, dry_run_of, created_by)
VALUES (platform.current_tenant(), 'customers', 'imports/t1/customers.csv', false, '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-000000000a01');
SELECT pg_temp.check(true, 'P21 real import after dry run accepted');
-- I: import_job.mapping_snapshot (970) — set once during upload/dry run, immutable, required to commit
UPDATE platform.import_job SET mapping_snapshot = '{"Name":"name","Mobile":"phone"}' WHERE id = '00000000-0000-0000-0000-00000000f001';
SELECT pg_temp.check((SELECT mapping_snapshot->>'Mobile' FROM platform.import_job WHERE id = '00000000-0000-0000-0000-00000000f001') = 'phone', 'I1 mapping_snapshot set at dry run (validated, from NULL)');
SELECT pg_temp.expect_error($$UPDATE platform.import_job SET mapping_snapshot = '{"Name":"email"}' WHERE id = '00000000-0000-0000-0000-00000000f001'$$, 'I2 snapshot change rejected', '%immutable%');
SELECT pg_temp.expect_error($$UPDATE platform.import_job SET mapping_snapshot = NULL WHERE id = '00000000-0000-0000-0000-00000000f001'$$, 'I3 snapshot reset to NULL rejected', '%immutable%');
SELECT pg_temp.expect_error($$UPDATE platform.import_job SET status = 'importing' WHERE NOT dry_run AND dry_run_of = '00000000-0000-0000-0000-00000000f001'$$, 'I4 commit without snapshot rejected', '%requires mapping_snapshot%');
INSERT INTO platform.import_job(tenant_id, id, kind, file_key, status, created_by) VALUES
 (platform.current_tenant(), '00000000-0000-0000-0000-00000000f002', 'customers', 'imports/t1/bad.csv', 'failed', '00000000-0000-0000-0000-000000000a01');
SELECT pg_temp.expect_error($$UPDATE platform.import_job SET mapping_snapshot = '{"a":"b"}' WHERE id = '00000000-0000-0000-0000-00000000f002'$$, 'I5 snapshot cannot be set after the dry run failed', '%only be set while%');
SELECT pg_temp.expect_error($$INSERT INTO platform.import_job(tenant_id, kind, file_key, dry_run, dry_run_of, status, mapping_snapshot, created_by)
  VALUES (platform.current_tenant(), 'customers', 'k', false, '00000000-0000-0000-0000-00000000f002', 'importing', '{"a":"b"}', '00000000-0000-0000-0000-000000000a01')$$,
  'I6 commit after a failed dry run rejected', '%passed dry run%');
UPDATE platform.import_job SET mapping_snapshot = '{"Name":"name","Mobile":"phone"}' WHERE NOT dry_run AND dry_run_of = '00000000-0000-0000-0000-00000000f001';
UPDATE platform.import_job SET status = 'importing' WHERE NOT dry_run AND dry_run_of = '00000000-0000-0000-0000-00000000f001';
UPDATE platform.import_job SET status = 'completed' WHERE NOT dry_run AND dry_run_of = '00000000-0000-0000-0000-00000000f001';
SELECT pg_temp.check((SELECT status FROM platform.import_job WHERE NOT dry_run AND dry_run_of = '00000000-0000-0000-0000-00000000f001') = 'completed', 'I7 snapshot set on upload then commit after passed dry run accepted');
SELECT pg_temp.expect_error($$INSERT INTO platform.import_job(tenant_id, kind, file_key, mapping_snapshot, created_by)
  VALUES (platform.current_tenant(), 'customers', 'k', '[1]', '00000000-0000-0000-0000-000000000a01')$$, 'I8 snapshot must be a JSON object', '%import_job_mapping_snapshot_object%');
SELECT pg_temp.check((SELECT count(*) FROM platform.audit_event WHERE table_name IN ('platform.device','platform.import_job','platform.setting')) >= 6, 'P20 device/import/setting changes are in the audit chain');
SELECT pg_temp.check(platform.audit_verify(platform.current_tenant()) IS NULL, 'P20 audit chain intact');

\echo '--- print templates: platform -> partner -> shop'
CREATE FUNCTION pg_temp.tpl(d text) RETURNS text LANGUAGE sql AS $$
  SELECT body_key FROM branding.print_template WHERE doc_type = d AND is_active
  ORDER BY CASE scope WHEN 'tenant' THEN 1 WHEN 'partner' THEN 2 ELSE 3 END LIMIT 1 $$;
SELECT set_config('app.tenant_id','',false), set_config('app.partner_id','00000000-0000-0000-0000-0000000000a1',false) \g /dev/null
INSERT INTO branding.print_template(scope, partner_id, doc_type, version, body_key, is_active) VALUES
 ('partner','00000000-0000-0000-0000-0000000000a1','receipt',1,'tpl/p1/receipt.hbs',true),
 ('partner','00000000-0000-0000-0000-0000000000a1','invoice',1,'tpl/p1/invoice.hbs',true);
SELECT pg_temp.check(true, 'partner creates default print templates for its shops');
SELECT pg_temp.check((SELECT count(*) FROM branding.print_template WHERE scope = 'tenant') = 0, 'partner cannot see a shop''s own templates (shop data)');
SELECT pg_temp.expect_error($$INSERT INTO branding.print_template(scope, tenant_id, doc_type, version, body_key) VALUES ('tenant','00000000-0000-0000-0000-000000000001','estimate',9,'x')$$,
       'partner cannot write a shop''s template', '%row-level security%');
SELECT pg_temp.expect_error($$INSERT INTO branding.print_template(scope, doc_type, version, body_key) VALUES ('platform','estimate',9,'x')$$,
       'partner cannot write platform templates', '%row-level security%');
SELECT set_config('app.partner_id','',false), set_config('app.tenant_id','00000000-0000-0000-0000-000000000001',false) \g /dev/null
SELECT pg_temp.check(pg_temp.tpl('invoice') = 'tpl/t1/invoice-v1.hbs', 'shop override wins for invoice');
SELECT pg_temp.check(pg_temp.tpl('receipt') = 'tpl/p1/receipt.hbs', 'shop with no active receipt gets its partner''s default');
SELECT pg_temp.check(pg_temp.tpl('estimate') = 'tpl/platform/estimate.hbs', 'no shop/partner estimate -> platform default');
WITH u AS (UPDATE branding.print_template SET body_key = 'hacked' WHERE scope IN ('partner','platform') RETURNING 1)
SELECT pg_temp.check(count(*) = 0, 'shop cannot edit partner/platform templates') FROM u;
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-000000000002',false) \g /dev/null
SELECT pg_temp.check(pg_temp.tpl('invoice') = 'tpl/platform/invoice.hbs' AND pg_temp.tpl('receipt') = 'tpl/platform/receipt.hbs',
       'direct shop (no partner) gets platform defaults, never partner templates');
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-000000000001',false) \g /dev/null
SELECT set_config('app.tenant_id','',false), set_config('app.partner_id','00000000-0000-0000-0000-0000000000a1',false) \g /dev/null
SELECT pg_temp.check(pg_temp.tpl('receipt') = 'tpl/p1/receipt.hbs', 'partner previews its own default');
SELECT set_config('app.partner_id','',false), set_config('app.tenant_id','00000000-0000-0000-0000-000000000001',false) \g /dev/null

\echo '--- P3 reseller sees branding + billing only, never shop data (even with app.tenant_id also set)'
SELECT set_config('app.partner_id','00000000-0000-0000-0000-0000000000a1',false) \g /dev/null
DO $$
DECLARE r record; n int := 0; seen text[] := '{}'; c bigint;
BEGIN
  FOR r IN SELECT c.table_schema s, c.table_name t FROM information_schema.columns c JOIN information_schema.tables tb USING (table_schema, table_name)
           WHERE c.column_name = 'tenant_id' AND tb.table_type = 'BASE TABLE'
             AND c.table_schema IN ('platform','notifications','masters','rates','hr','accounts','inventory','approvals','sales','orders','purchases','refinery') LOOP
    BEGIN
      EXECUTE format('SELECT count(*) FROM %I.%I WHERE tenant_id = %L', r.s, r.t, '00000000-0000-0000-0000-000000000001') INTO c;
    EXCEPTION WHEN insufficient_privilege THEN c := 0;   -- write-only tables (otp_delivery): not readable at all
    END;
    IF c > 0 THEN seen := seen || (r.s || '.' || r.t); END IF;
    n := n + 1;
  END LOOP;
  IF cardinality(seen) > 0 THEN RAISE EXCEPTION 'FAIL  partner can see shop rows in %', seen; END IF;
  RAISE NOTICE 'PASS  P3 partner session sees 0 rows in all % shop tables (sales, inventory, customers, accounts, audit, ...)', n;
END $$;
SELECT pg_temp.check((SELECT count(*) FROM sales.invoice) = 0 AND (SELECT count(*) FROM masters.customer) = 0
                 AND (SELECT count(*) FROM inventory.tag) = 0 AND (SELECT count(*) FROM accounts.voucher) = 0, 'P3 explicit: invoices, customers, tags, vouchers hidden');
SELECT pg_temp.expect_error($$INSERT INTO masters.metal(tenant_id, code, name, default_hsn) VALUES (platform.current_tenant(), 'PT', 'Platinum', '7113')$$,
       'P3 partner cannot write shop data', '%row-level security%');
SELECT pg_temp.check((SELECT count(*) FROM billing.subscription) = 1 AND (SELECT tenant_id FROM billing.subscription) = '00000000-0000-0000-0000-000000000001',
       'P3 partner sees billing of its own shop only (not tenant2)');
SELECT pg_temp.check((SELECT count(*) FROM branding.theme WHERE scope = 'tenant') = 1, 'P3 partner still manages its shops'' branding');
SELECT set_config('app.partner_id','',false) \g /dev/null
SELECT pg_temp.check((SELECT count(*) FROM sales.invoice) > 0, 'shop session (no partner) still sees its invoices');
SELECT pg_temp.expect_error($$SELECT * FROM platform.platform_admin$$, 'P23 app_rw cannot read platform operator accounts', '%permission denied%');
\echo '--- v1.4 platform schema requests'
-- R2 resolve_tenant (pre-login, no context)
SELECT set_config('app.tenant_id','',false) \g /dev/null
SELECT pg_temp.check((SELECT count(*) FROM platform.tenant) = 0, 'R2 app_rw without context cannot read platform.tenant');
SELECT pg_temp.check((SELECT tenant_id = '00000000-0000-0000-0000-000000000001' AND status = 'active' AND partner_id = '00000000-0000-0000-0000-0000000000a1'
                      FROM platform.resolve_tenant('SRI-LAKSHMI')), 'R2 resolve_tenant(slug) returns id/status/partner pre-login');
SELECT pg_temp.check((SELECT count(*) FROM platform.resolve_tenant('nope')) = 0, 'R2 unknown slug -> no row');
SELECT pg_temp.check((SELECT pg_get_function_result('platform.resolve_tenant(text)'::regprocedure)) = 'TABLE(tenant_id uuid, status text, partner_id uuid)',
       'R2 returns only tenant_id, status, partner_id (no PII)');
SELECT pg_temp.check((SELECT prosecdef AND proconfig @> '{"search_path=pg_catalog, pg_temp"}' FROM pg_proc WHERE oid = 'platform.resolve_tenant(text)'::regprocedure),
       'R2 SECURITY DEFINER with fixed search_path');
-- R3 partner users / sessions
SELECT set_config('app.partner_id','00000000-0000-0000-0000-0000000000a1',false) \g /dev/null
INSERT INTO platform.partner_user(partner_id, id, name, email, password_hash, role)
VALUES (platform.current_partner(), '00000000-0000-0000-0000-0000000000d1', 'Reseller Admin', 'admin@reseller.in', '$argon2id$x', 'partner_admin');
INSERT INTO platform.partner_session(partner_id, partner_user_id, token_hash, expires_at)
VALUES (platform.current_partner(), '00000000-0000-0000-0000-0000000000d1', sha256('tok'), now() + interval '8 hours');
SELECT pg_temp.expect_error($$INSERT INTO platform.partner_session(partner_id, partner_user_id, token_hash, expires_at)
       VALUES (platform.current_partner(), '00000000-0000-0000-0000-0000000000d1', 'plain-token', now())$$, 'R3 partner session token must be a 32-byte hash', '%check%');
SELECT pg_temp.expect_error($$INSERT INTO platform.partner_user(partner_id, name, email, password_hash)
       VALUES ('00000000-0000-0000-0000-0000000000a2', 'x', 'x@y.in', 'h')$$, 'R3 cannot create a user for another partner', '%row-level security%');
SELECT set_config('app.partner_id','00000000-0000-0000-0000-0000000000a2',false) \g /dev/null
SELECT pg_temp.check((SELECT count(*) FROM platform.partner_user) + (SELECT count(*) FROM platform.partner_session) = 0, 'R3 other partner sees no users/sessions');
SELECT set_config('app.partner_id','',false), set_config('app.tenant_id','00000000-0000-0000-0000-000000000001',false) \g /dev/null
SELECT pg_temp.check((SELECT count(*) FROM platform.partner_user) = 0, 'R3 shop session sees no partner users');
-- R4 platform admin sessions
SELECT pg_temp.expect_error($$SELECT * FROM platform.platform_admin_session$$, 'R4 app_rw cannot read platform admin sessions', '%permission denied%');
-- R5 default_language
WITH u AS (UPDATE platform.tenant SET default_language = 'ta' RETURNING 1) SELECT pg_temp.check(count(*) = 1, 'R5 shop updates its own default_language') FROM u;
SELECT pg_temp.check((SELECT default_language FROM platform.tenant) = 'ta', 'R5 new language visible');
WITH u AS (UPDATE platform.tenant SET default_language = 'hi' WHERE id = '00000000-0000-0000-0000-000000000002' RETURNING 1)
  SELECT pg_temp.check(count(*) = 0, 'R5 cannot touch another tenant''s language') FROM u;
SELECT pg_temp.expect_error($$UPDATE platform.tenant SET display_name = 'X'$$, 'R5 other tenant columns not updatable', '%permission denied%');
SELECT set_config('app.partner_id','00000000-0000-0000-0000-0000000000a1',false) \g /dev/null
WITH u AS (UPDATE platform.tenant SET default_language = 'hi' RETURNING 1) SELECT pg_temp.check(count(*) = 0, 'R5 partner context cannot change a shop''s language') FROM u;
SELECT set_config('app.partner_id','',false) \g /dev/null
UPDATE platform.tenant SET default_language = 'en';
-- R6 provisioning
SELECT pg_temp.expect_error($$SELECT platform.provision_tenant('x','x',NULL,'x',NULL,NULL,'33','M','Main','O','9000000999','owner','h')$$,
       'R6 app_rw cannot provision tenants', '%permission denied%');
-- R7 import row errors / R11 mapping profiles
INSERT INTO platform.import_row_error(tenant_id, import_job_id, row_no, column_name, code, message, raw)
VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000f001', 7, 'huid', 'invalid_huid', 'HUID must be 6 characters', '{"huid":"AB12"}');
SELECT pg_temp.check((SELECT code FROM platform.import_row_error WHERE row_no = 7) = 'invalid_huid', 'R7 import_row_error stores row_no/column/code/message/raw');
SELECT pg_temp.expect_error($$INSERT INTO platform.import_row_error(tenant_id, import_job_id, row_no, code, message)
       VALUES (platform.current_tenant(), gen_random_uuid(), 1, 'x', 'x')$$, 'R7 error row must belong to an import job', '%foreign key%');
-- R8 OTP: no plaintext
INSERT INTO platform.otp_challenge(tenant_id, id, user_id, channel, code_hash, expires_at)
VALUES (platform.current_tenant(), '00000000-0000-0000-0000-0000000000c9', '00000000-0000-0000-0000-000000000a01', 'sms', sha256('481516'), now() + interval '5 minutes');
INSERT INTO platform.otp_delivery(tenant_id, otp_challenge_id, channel, key_id, ciphertext, expires_at)
VALUES (platform.current_tenant(), '00000000-0000-0000-0000-0000000000c9', 'sms', 'otp-2026-10', '\x9f'::bytea || sha256('n') || sha256('c'), now() + interval '5 minutes');
SELECT pg_temp.expect_error($$INSERT INTO platform.otp_challenge(tenant_id, user_id, channel, code_hash, expires_at)
       VALUES (platform.current_tenant(), '00000000-0000-0000-0000-000000000a01', 'sms', '481516', now() + interval '5 minutes')$$, 'R8 otp_challenge rejects a plaintext code', '%check%');
SELECT pg_temp.expect_error($$INSERT INTO platform.otp_delivery(tenant_id, otp_challenge_id, channel, key_id, ciphertext, expires_at)
       VALUES (platform.current_tenant(), '00000000-0000-0000-0000-0000000000c9', 'sms', 'k1', '481516', now() + interval '5 minutes')$$, 'R8 otp_delivery rejects a bare code', '%check%');
SELECT pg_temp.expect_error($$INSERT INTO platform.otp_delivery(tenant_id, otp_challenge_id, channel, key_id, ciphertext, expires_at)
       VALUES (platform.current_tenant(), '00000000-0000-0000-0000-0000000000c9', 'sms', 'k1', convert_to('Your JewelOS login code is 481516. Do not share.', 'UTF8'), now() + interval '5 minutes')$$,
       'R8 otp_delivery rejects a readable message', '%check%');
SELECT pg_temp.expect_error($$INSERT INTO platform.otp_delivery(tenant_id, otp_challenge_id, channel, key_id, ciphertext, expires_at)
       VALUES (platform.current_tenant(), '00000000-0000-0000-0000-0000000000c9', 'sms', 'k1', '\x9f'::bytea || sha256('n'), now() + interval '11 minutes')$$,
       'R8 otp_delivery expiry capped at 10 min', '%check%');
SELECT pg_temp.expect_error($$SELECT * FROM platform.otp_delivery$$, 'R8 API cannot read back delivery ciphertext', '%permission denied%');
SELECT pg_temp.check(NOT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema NOT IN ('pg_catalog','information_schema','pgboss')
           AND (column_name ~ '(^|_)(otp|otp_code|verification_code|plain_code|code_plain)$'
                OR (table_name IN ('otp_challenge','otp_delivery') AND data_type NOT IN ('uuid','bytea','timestamp with time zone','smallint')
                    AND column_name NOT IN ('channel','key_id')))),
       'R8 catalog: no column can hold a plaintext OTP');
-- R9 partner context hides shop print templates even with tenant context
SELECT set_config('app.partner_id','00000000-0000-0000-0000-0000000000a1',false) \g /dev/null
SELECT pg_temp.check((SELECT count(*) FROM branding.print_template WHERE scope = 'tenant') = 0, 'R9 partner+tenant context sees no shop print templates');
SELECT pg_temp.expect_error($$INSERT INTO branding.print_template(scope, tenant_id, doc_type, version, body_key, is_active)
       VALUES ('tenant', platform.current_tenant(), 'receipt', 9, 'tpl/x.hbs', false)$$, 'R9 partner+tenant context cannot write shop templates', '%row-level security%');
-- R10 partner tenant directory
SELECT pg_temp.check((SELECT count(*) FROM platform.v_partner_tenant_directory) = 1
                 AND (SELECT tenant_id FROM platform.v_partner_tenant_directory) = '00000000-0000-0000-0000-000000000001'
                 AND (SELECT plan_code || '/' || subscription_status || '/' || tenant_status FROM platform.v_partner_tenant_directory) = 'standard/active/active',
       'R10 partner directory lists only its own shop with plan + subscription status');
SELECT pg_temp.check((SELECT array_agg(column_name::text ORDER BY ordinal_position) FROM information_schema.columns
                      WHERE table_schema = 'platform' AND table_name = 'v_partner_tenant_directory')
                     = '{tenant_id,display_name,tenant_status,plan_code,plan_name,subscription_status}', 'R10 directory exposes no other columns');
SELECT pg_temp.check((SELECT count(*) FROM platform.tenant) = 0, 'R10 partner cannot read platform.tenant directly');
SELECT set_config('app.partner_id','00000000-0000-0000-0000-0000000000a2',false), set_config('app.tenant_id','',false) \g /dev/null
SELECT pg_temp.check((SELECT count(*) FROM platform.v_partner_tenant_directory) = 0, 'R10 another partner sees none of these shops');
SELECT set_config('app.partner_id','',false), set_config('app.tenant_id','00000000-0000-0000-0000-000000000001',false) \g /dev/null
SELECT pg_temp.check((SELECT count(*) FROM platform.v_partner_tenant_directory) = 0, 'R10 shop session gets an empty directory');
-- R11 mapping profile, version, bill_series_prefix
INSERT INTO platform.import_mapping_profile(tenant_id, kind, name, mapping)
VALUES (platform.current_tenant(), 'stock', 'Old software export', '{"Tag No":"tag_no","Gross Wt":"gross_weight"}');
SELECT pg_temp.expect_error($$INSERT INTO platform.import_mapping_profile(tenant_id, kind, name, mapping)
       VALUES (platform.current_tenant(), 'stock', 'Old software export', '{}')$$, 'R11 mapping profile name unique per kind', '%duplicate key%');
UPDATE platform.branch SET name = 'Coimbatore RS Puram' WHERE code = 'CBE' AND version = 1;
SELECT pg_temp.check((SELECT version FROM platform.branch WHERE code = 'CBE') = 2, 'R11 trigger increments version on update');
WITH u AS (UPDATE platform.branch SET name = 'Stale edit' WHERE code = 'CBE' AND version = 1 RETURNING 1)
  SELECT pg_temp.check(count(*) = 0, 'R11 stale version updates 0 rows (app reports conflict)') FROM u;
SELECT pg_temp.expect_error($$UPDATE platform.branch SET version = 99 WHERE code = 'CBE'$$, 'R11 client cannot set version', '%version is maintained%');
SELECT pg_temp.check((SELECT count(*) FROM pg_trigger WHERE tgname = 'aa_version') = 49, 'R11 version trigger on all 49 editable tables (17 earlier + 20 from 976–982 + 9 from 987–988 inventory + 3 from 991–993 sales: shop_setting, estimate, invoice_due)');
SELECT pg_temp.check((SELECT bill_series_prefix FROM platform.branch WHERE code = 'CBE') = 'CBE', 'R11 branch.bill_series_prefix stored');
SELECT pg_temp.expect_error($$UPDATE platform.branch SET bill_series_prefix = 'cbe 1' WHERE code = 'CBE'$$, 'R11 bill_series_prefix format enforced', '%check%');
\echo '--- v1.5 platform schema requests'
-- S1 resolve_partner
SELECT set_config('app.tenant_id','',false) \g /dev/null
SELECT pg_temp.check((SELECT partner_id = '00000000-0000-0000-0000-0000000000a1' AND status = 'active' FROM platform.resolve_partner('KOVAI-RESELL')),
       'S1 resolve_partner(slug) returns partner_id/status pre-login');
SELECT pg_temp.check((SELECT count(*) FROM platform.resolve_partner('nope')) = 0, 'S1 unknown partner slug -> no row');
SELECT pg_temp.check(pg_get_function_result('platform.resolve_partner(text)'::regprocedure) = 'TABLE(partner_id uuid, status text)'
                 AND (SELECT prosecdef AND proconfig @> '{"search_path=pg_catalog, pg_temp"}' AND proowner = 'platform_lookup'::regrole
                      FROM pg_proc WHERE oid = 'platform.resolve_partner(text)'::regprocedure), 'S1 definer, fixed search_path, owned by platform_lookup, minimal row');
-- S2 rate limit buckets (no tenant RLS; key-scoped)
INSERT INTO platform.rate_limit_bucket(bucket_key, window_start, count)
VALUES ('login.tenant:00000000-0000-0000-0000-000000000001:' || encode(sha256('cashier1'), 'hex'), date_trunc('minute', now()), 1)
ON CONFLICT (bucket_key, window_start) DO UPDATE SET count = platform.rate_limit_bucket.count + 1, updated_at = now();
UPDATE platform.rate_limit_bucket SET count = count + 4, locked_until = now() + interval '15 minutes' WHERE bucket_key LIKE 'login.tenant:%';
SELECT pg_temp.check((SELECT count = 5 AND locked_until > now() FROM platform.rate_limit_bucket WHERE bucket_key LIKE 'login.tenant:%'), 'S2 pre-login counter + lockout');
SELECT pg_temp.expect_error($$INSERT INTO platform.rate_limit_bucket(bucket_key, window_start) VALUES ('otp.send:00000000-0000-0000-0000-000000000001:9000000001', now())$$,
       'S2 bucket key cannot carry a raw phone/username', '%check%');
SELECT pg_temp.expect_error($$INSERT INTO platform.rate_limit_bucket(bucket_key, window_start, count) VALUES ('login.admin:-:' || encode(sha256('x'),'hex'), now(), -1)$$,
       'S2 count cannot be negative', '%check%');
SELECT pg_temp.check(NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'platform' AND table_name = 'app_user'
                                 AND column_name IN ('failed_logins','locked_until')), 'S2 duplicate per-user lockout columns removed');
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-000000000002',false) \g /dev/null
SELECT pg_temp.check((SELECT count(*) FROM platform.rate_limit_bucket) >= 1, 'S2 buckets are key-scoped, not tenant RLS');
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-000000000001',false) \g /dev/null
-- S3 import_job -> mapping profile (same tenant and kind)
INSERT INTO platform.import_job(tenant_id, kind, file_key, created_by, mapping_profile_id)
SELECT platform.current_tenant(), 'stock', 'imports/t1/stock2.xlsx', '00000000-0000-0000-0000-000000000a01', id
FROM platform.import_mapping_profile WHERE name = 'Old software export';
SELECT pg_temp.check((SELECT count(*) FROM platform.import_job WHERE mapping_profile_id IS NOT NULL) = 1, 'S3 import job records its mapping profile');
SELECT pg_temp.expect_error($$INSERT INTO platform.import_job(tenant_id, kind, file_key, created_by, mapping_profile_id)
       SELECT platform.current_tenant(), 'customers', 'imports/t1/c.xlsx', '00000000-0000-0000-0000-000000000a01', id
       FROM platform.import_mapping_profile WHERE name = 'Old software export'$$, 'S3 profile of another kind rejected', '%import_job_mapping_profile_fk%');
SELECT pg_temp.expect_error($$INSERT INTO platform.import_job(tenant_id, kind, file_key, created_by, mapping_profile_id)
       VALUES (platform.current_tenant(), 'stock', 'k', '00000000-0000-0000-0000-000000000a01', gen_random_uuid())$$, 'S3 unknown/other-tenant profile rejected', '%import_job_mapping_profile_fk%');
-- S4 customer PAN ciphertext
UPDATE masters.customer SET pan_enc = '\x9f'::bytea || sha256('n') || sha256('c'), pan_key_id = 'pan-2026-10', pan_last4 = '234F'
WHERE id = (SELECT id FROM masters.customer ORDER BY id LIMIT 1);
SELECT pg_temp.check((SELECT count(*) FROM masters.customer WHERE pan_key_id = 'pan-2026-10' AND pan_last4 = '234F') = 1, 'S4 PAN stored as ciphertext + key id + last4');
SELECT pg_temp.expect_error($$UPDATE masters.customer SET pan_enc = convert_to('ABCDE1234F','UTF8'), pan_key_id = 'k', pan_last4 = '234F'$$, 'S4 plaintext PAN rejected', '%check%');
SELECT pg_temp.expect_error($$UPDATE masters.customer SET pan_enc = '\x9f'::bytea || sha256('n'), pan_key_id = NULL, pan_last4 = '234F'$$, 'S4 ciphertext requires key id', '%check%');
SELECT pg_temp.check((SELECT data_type FROM information_schema.columns WHERE table_schema = 'masters' AND table_name = 'customer' AND column_name = 'pan_enc') = 'bytea'
                 AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'masters' AND table_name = 'customer' AND column_name = 'pan'),
       'S4 customer has no plaintext PAN column');
-- S7 version trigger vs print_template.version
SELECT pg_temp.check((SELECT version FROM branding.print_template WHERE scope = 'tenant' AND doc_type = 'invoice' AND is_active) = 1, 'S7 setup');
UPDATE branding.print_template SET config = '{"x":1}' WHERE scope = 'tenant' AND doc_type = 'invoice' AND is_active;
SELECT pg_temp.check((SELECT version || '/' || row_version FROM branding.print_template WHERE scope = 'tenant' AND doc_type = 'invoice' AND is_active) = '1/2',
       'S7 update bumps row_version, never the template document version');
INSERT INTO branding.print_template(scope, tenant_id, doc_type, version, body_key, row_version)
VALUES ('tenant', platform.current_tenant(), 'invoice', 7, 'tpl/t1/invoice-v7.hbs', 42);
SELECT pg_temp.check((SELECT version || '/' || row_version FROM branding.print_template WHERE body_key = 'tpl/t1/invoice-v7.hbs') = '7/1',
       'S7 explicit template version kept on INSERT; row_version forced to 1');
INSERT INTO platform.import_mapping_profile(tenant_id, kind, name, mapping, version) VALUES (platform.current_tenant(), 'customers', 'v-test', '{}', 9);
SELECT pg_temp.check((SELECT version FROM platform.import_mapping_profile WHERE name = 'v-test') = 1, 'S7 app-supplied version on INSERT is reset to 1');
\echo '--- v1.6 least privilege: every writer role app_rw can SET into cannot read secrets'
DO $$
DECLARE w text; p text; n_roles int := 0; n int := 0; leaks text[] := '{}'; parts text[];
BEGIN
  FOR w IN SELECT r.rolname FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid
           WHERE m.member = 'app_rw'::regrole AND m.set_option ORDER BY 1 LOOP
    n_roles := n_roles + 1;
    FOREACH p IN ARRAY ARRAY['platform.app_user.password_hash','platform.app_user.mfa_secret_enc','platform.partner_user.password_hash',
                            'platform.platform_admin.password_hash','platform.platform_admin.mfa_secret_enc',
                            'platform.otp_challenge.code_hash','platform.otp_delivery.ciphertext',
                            'platform.user_session.token_hash','platform.partner_session.token_hash','platform.platform_admin_session.token_hash',
                            'platform.rate_limit_bucket.bucket_key','platform.rate_limit_bucket.locked_until',
                            'masters.customer.pan_enc','masters.customer.pan_key_id','hr.staff.pan_enc','hr.staff.pan_key_id','masters.vendor.pan_enc','masters.vendor.pan_key_id','masters.kyc_document_secret.number_enc','masters.kyc_document_secret.number_key_id',
                     'masters.bank_account.account_no_enc','masters.bank_account.account_key_id','branding.custom_domain.verification_token'] LOOP
      parts := string_to_array(p, '.');
      BEGIN
        EXECUTE format('SET LOCAL ROLE %I', w);
        EXECUTE format('SELECT %I FROM %I.%I LIMIT 1', parts[3], parts[1], parts[2]);
        leaks := leaks || (w || ':' || p);
        RESET ROLE;
      EXCEPTION WHEN insufficient_privilege THEN n := n + 1;   -- subtransaction rollback also undoes SET LOCAL ROLE
      END;
    END LOOP;
    -- and the module still has the reference data it needs
    EXECUTE format('SET LOCAL ROLE %I', w);
    PERFORM name, bill_series_prefix FROM platform.branch LIMIT 1;
    PERFORM id, name, username FROM platform.app_user LIMIT 1;
    PERFORM key, value FROM platform.setting_default LIMIT 1;
    PERFORM id, display_name, status FROM platform.tenant LIMIT 1;
    IF has_any_column_privilege(w, 'masters.customer', 'SELECT') THEN   -- accounts_writer has no masters access at all
      PERFORM id, name, pan_last4 FROM masters.customer LIMIT 1;
    END IF;
    RESET ROLE;
  END LOOP;
  IF cardinality(leaks) > 0 THEN RAISE EXCEPTION 'FAIL  writer roles can read secrets: %', leaks; END IF;
  IF n_roles < 6 THEN RAISE EXCEPTION 'FAIL  expected >= 6 SET-able writer roles, found %', n_roles; END IF;
  RAISE NOTICE 'PASS  L1 % writer roles x % secret columns: all % reads denied (creds, OTP, sessions, rate limits, PAN, bank, DNS token)', n_roles, n / n_roles, n;
  RAISE NOTICE 'PASS  L2 every writer role still reads branch/user names, settings, tenant identity, customer name+pan_last4';
END $$;
SELECT pg_temp.check(NOT EXISTS (
         SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid,
              unnest(ARRAY['platform.audit_event','platform.audit_chain_head','platform.import_job','platform.import_row_error',
                           'platform.partner','platform.licence','platform.export_job']::regclass[]) AS t(rel)
         WHERE m.member = 'app_rw'::regrole AND m.set_option AND has_table_privilege(r.rolname, t.rel, 'SELECT')),
       'L3 writer roles have no SELECT on audit/import/export/partner/licence tables');
SELECT pg_temp.check(NOT EXISTS (
         SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid, pg_class c
         WHERE m.member = 'app_rw'::regrole AND m.set_option AND c.relnamespace = 'branding'::regnamespace AND c.relkind IN ('r','v')
           AND has_table_privilege(r.rolname, c.oid, 'SELECT')),
       'L4 writer roles have no branding reads');
SELECT pg_temp.check((SELECT count(*) FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid
                      WHERE m.member = 'app_rw'::regrole AND m.set_option
                        AND has_table_privilege(r.rolname, 'platform.doc_counter', 'UPDATE')) = 4,
       'L5 doc_counter write kept for sales/orders/purchases/refinery writers only');
\echo '--- v1.7 sensitive columns'
SELECT pg_temp.expect_error($$INSERT INTO hr.staff(tenant_id, code, name, branch_id, pan_enc, pan_key_id, pan_last4)
       VALUES (platform.current_tenant(), 'S-PAN1', 'Plain', '00000000-0000-0000-0000-00000000b001', convert_to('ABCDE1234F','UTF8'), 'k', '234F')$$,
       'M1 hr.staff rejects plaintext PAN', '%check%');
SELECT pg_temp.expect_error($$INSERT INTO hr.staff(tenant_id, code, name, branch_id, pan_enc)
       VALUES (platform.current_tenant(), 'S-PAN2', 'NoKey', '00000000-0000-0000-0000-00000000b001', '\x9f'::bytea || sha256('n'))$$,
       'M2 hr.staff PAN ciphertext requires key id + last4', '%check%');
INSERT INTO hr.staff(tenant_id, code, name, branch_id, pan_enc, pan_key_id, pan_last4)
VALUES (platform.current_tenant(), 'S-PAN3', 'Enc', '00000000-0000-0000-0000-00000000b001', '\x9f'::bytea || sha256('n') || sha256('c'), 'pan-2026-10', '234F');
SELECT pg_temp.check((SELECT pan_last4 FROM hr.staff WHERE code = 'S-PAN3') = '234F', 'M3 hr.staff stores PAN ciphertext + key id + last4');
SELECT pg_temp.check(NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attname LIKE '%aadhaar%' AND NOT attisdropped
                                   AND attrelid IN (SELECT oid FROM pg_class WHERE relnamespace::regnamespace::text IN ('masters','hr','platform','sales','accounts'))),
       'M4 no aadhaar column anywhere (984 dropped customer/staff/vendor aadhaar_last4)');
SELECT pg_temp.check(NOT EXISTS (
         SELECT 1 FROM pg_roles r,
              (VALUES ('masters.customer','pan_enc'),('masters.customer','pan_key_id'),('hr.staff','pan_enc'),('hr.staff','pan_key_id'),('masters.vendor','pan_enc'),('masters.vendor','pan_key_id'),('masters.kyc_document_secret','number_enc'),('masters.kyc_document_secret','number_key_id'),
                      ('masters.bank_account','account_no_enc'),('masters.bank_account','account_key_id'),
                      ('platform.app_user','password_hash'),('platform.app_user','mfa_secret_enc'),
                      ('branding.custom_domain','verification_token')) AS v(tbl, col)
         WHERE r.rolname IN ('app_ro','app_worker','app_admin','platform_writer','notifications_writer','platform_lookup','tenant_provisioner',
                             'sales_writer','inventory_writer','accounts_writer','orders_writer','purchases_writer','refinery_writer')
           AND NOT (v.tbl = 'branding.custom_domain' AND r.rolname = 'app_worker')
           AND has_column_privilege(r.rolname, v.tbl::regclass, v.col, 'SELECT')),
       'M5 catalog: no role except app_rw (and app_worker for the DNS token) can read PAN/bank/credential columns');
SELECT pg_temp.check(has_column_privilege('sales_writer', 'hr.staff', 'name', 'SELECT') AND has_column_privilege('app_ro', 'hr.staff', 'pan_last4', 'SELECT')
                 AND has_column_privilege('app_ro', 'masters.vendor', 'name', 'SELECT'), 'M6 non-secret staff/vendor columns still readable');
\echo '--- v1.8 bank accounts'
INSERT INTO masters.bank_account(tenant_id, owner_type, company_id, bank_name, branch_name, ifsc, holder_name,
                                 account_no_enc, account_key_id, account_last4, is_default, print_on_invoice)
VALUES (platform.current_tenant(), 'company', '00000000-0000-0000-0000-00000000c001', 'State Bank of India', 'RS Puram', 'SBIN0001234',
        'Sri Lakshmi Jewellers', '\x9f'::bytea || sha256('n') || sha256('acct'), 'bank-2026-10', '4321', true, true);
SELECT pg_temp.check((SELECT bank_name || '/' || ifsc || '/' || account_last4 || '/' || version FROM masters.bank_account WHERE print_on_invoice)
                     = 'State Bank of India/SBIN0001234/4321/1', 'B1 valid company bank account stored (readable fields + last4)');
SELECT pg_temp.expect_error($$INSERT INTO masters.bank_account(tenant_id, owner_type, company_id, bank_name, ifsc, holder_name, account_no_enc, account_key_id, account_last4)
       VALUES (platform.current_tenant(), 'company', '00000000-0000-0000-0000-00000000c001', 'HDFC', 'HDFC0000001', 'X', convert_to('50100012344321','UTF8'), 'k', '4321')$$,
       'B2 plaintext account number rejected', '%check%');
SELECT pg_temp.expect_error($$INSERT INTO masters.bank_account(tenant_id, owner_type, company_id, bank_name, ifsc, holder_name, account_no_enc, account_last4)
       VALUES (platform.current_tenant(), 'company', '00000000-0000-0000-0000-00000000c001', 'HDFC', 'HDFC0000001', 'Holder', '\x9f'::bytea || sha256('n'), '4321')$$,
       'B3 ciphertext without key id rejected', '%null value%');
SELECT pg_temp.expect_error($$INSERT INTO masters.bank_account(tenant_id, owner_type, company_id, bank_name, ifsc, holder_name, account_no_enc, account_key_id, account_last4)
       VALUES (platform.current_tenant(), 'company', '00000000-0000-0000-0000-00000000c001', 'HDFC', 'hdfc000001', 'Holder', '\x9f'::bytea || sha256('n'), 'k', '4321')$$,
       'B4 IFSC format enforced', '%check%');
SELECT pg_temp.expect_error($$INSERT INTO masters.bank_account(tenant_id, owner_type, company_id, bank_name, ifsc, holder_name, account_no_enc, account_key_id, account_last4, is_default)
       VALUES (platform.current_tenant(), 'company', '00000000-0000-0000-0000-00000000c001', 'HDFC', 'HDFC0000001', 'Holder', '\x9f'::bytea || sha256('n2'), 'k', '9999', true)$$,
       'B5 one default account per owner', '%bank_account_one_default%');
SELECT pg_temp.expect_error($$INSERT INTO masters.bank_account(tenant_id, owner_type, company_id, vendor_id, bank_name, ifsc, holder_name, account_no_enc, account_key_id, account_last4)
       VALUES (platform.current_tenant(), 'vendor', NULL, NULL, 'HDFC', 'HDFC0000001', 'Holder', '\x9f'::bytea || sha256('n3'), 'k', '1111')$$,
       'B6 vendor account needs a vendor (exactly one owner)', '%check%');
SELECT pg_temp.check(NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE column_name = 'bank_accounts'), 'B7 old bank_accounts jsonb columns removed');
DO $$
DECLARE w text; n int := 0; leaks text[] := '{}';
BEGIN
  FOR w IN SELECT r.rolname FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid WHERE m.member = 'app_rw'::regrole AND m.set_option LOOP
    IF has_any_column_privilege(w, 'masters.bank_account', 'SELECT') THEN
      EXECUTE format('SET LOCAL ROLE %I', w);
      PERFORM bank_name, branch_name, ifsc, holder_name, account_last4, is_default, print_on_invoice FROM masters.bank_account;
      RESET ROLE;
      n := n + 1;
    END IF;
  END LOOP;
  IF NOT has_any_column_privilege('sales_writer', 'masters.bank_account', 'SELECT') THEN RAISE EXCEPTION 'FAIL  sales_writer cannot read bank details for print'; END IF;
  RAISE NOTICE 'PASS  B8 % writer roles (incl. sales_writer for invoice print) read bank name/IFSC/holder/last4', n;
END $$;
WITH x AS (UPDATE masters.bank_account SET branch_name = 'R.S. Puram' WHERE print_on_invoice AND version = 1 RETURNING version)
  SELECT pg_temp.check((SELECT version FROM x) = 2, 'B9 bank_account version incremented by trigger') ;
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-000000000002',false) \g /dev/null
SELECT pg_temp.check((SELECT count(*) FROM masters.bank_account) = 0, 'B10 RLS: other tenant sees no bank accounts');
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-000000000001',false) \g /dev/null
-- 972 masters.metal / masters.purity version + is_active
SELECT pg_temp.check((SELECT count(*) FROM information_schema.columns WHERE table_schema = 'masters' AND table_name IN ('metal','purity')
        AND ((column_name = 'version' AND data_type = 'integer' AND column_default = '1')
          OR (column_name = 'is_active' AND data_type = 'boolean' AND column_default = 'true')) AND is_nullable = 'NO') = 4,
       'MV3 metal/purity have version int NOT NULL DEFAULT 1 and is_active boolean NOT NULL DEFAULT true');
SELECT pg_temp.check((SELECT count(*) FROM pg_trigger WHERE tgname = 'aa_version' AND NOT tgisinternal
        AND tgfoid = 'platform.bump_version'::regproc AND tgrelid IN ('masters.metal'::regclass, 'masters.purity'::regclass)) = 2,
       'MV4 aa_version trigger (platform.bump_version) on metal and purity');
SELECT pg_temp.check((SELECT bool_and(version = 1 AND is_active) FROM masters.metal) AND (SELECT bool_and(version = 1 AND is_active) FROM masters.purity),
       'MV5 seeded metal/purity rows start at version 1, active');
WITH x AS (UPDATE masters.metal SET name = 'Gold (22K/18K)' WHERE id = '00000000-0000-0000-0000-0000000000e1' RETURNING version)
  SELECT pg_temp.check((SELECT version FROM x) = 2, 'MV6 metal update bumps version 1 -> 2');
WITH x AS (UPDATE masters.purity SET is_active = false WHERE id = (SELECT min(id::text)::uuid FROM masters.purity) RETURNING version, is_active)
  SELECT pg_temp.check((SELECT version = 2 AND NOT is_active FROM x), 'MV7 purity soft-disable bumps version');
UPDATE masters.purity SET is_active = true WHERE NOT is_active;
SELECT pg_temp.expect_error($$UPDATE masters.metal SET version = 99 WHERE id = '00000000-0000-0000-0000-0000000000e1'$$,
       'MV8 manual version change rejected', '%maintained by the database%');
WITH x AS (INSERT INTO masters.metal(tenant_id, code, name, default_hsn, version) VALUES (platform.current_tenant(), 'SILVER', 'Silver', '7113', 42) RETURNING version)
  SELECT pg_temp.check((SELECT version FROM x) = 1, 'MV9 insert resets version to 1');
SELECT pg_temp.check(NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid IN ('masters.metal'::regclass, 'masters.purity'::regclass)
        AND attname IN ('version','is_active') AND attacl IS NOT NULL
        AND attacl::text <> '{accounts_writer=r/app_migrator}')   -- 985: v_todays_rate_status column read for accounts_writer
        AND (SELECT relacl::text FROM pg_class WHERE oid = 'masters.metal'::regclass) = (SELECT relacl::text FROM pg_class WHERE oid = 'masters.purity'::regclass)
        AND (SELECT relacl::text FROM pg_class WHERE oid = 'masters.metal'::regclass) = (SELECT relacl::text FROM pg_class WHERE oid = 'masters.item'::regclass)
        AND NOT has_table_privilege('accounts_writer', 'masters.metal', 'SELECT')
        AND NOT has_column_privilege('accounts_writer', 'masters.metal', 'version', 'SELECT'),
       'MV10 no new grants: no column ACLs on new columns; metal/purity ACL = masters.item ACL');
-- 973 platform.idempotency_key
SELECT pg_temp.check((SELECT string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' ORDER BY ordinal_position)
        FROM information_schema.columns WHERE table_schema = 'platform' AND table_name = 'idempotency_key')
        = 'tenant_id:uuid:NO,scope:text:NO,key:text:NO,request_hash:text:NO,response_status:smallint:NO,response_body:jsonb:NO,'
          'created_at:timestamp with time zone:NO,expires_at:timestamp with time zone:NO', 'IK1 idempotency_key columns, types, NOT NULL');
SELECT pg_temp.check((SELECT pg_get_indexdef(indexrelid) FROM pg_index WHERE indrelid = 'platform.idempotency_key'::regclass AND indisprimary)
        LIKE '%(tenant_id, scope, key)' AND EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'platform' AND indexname = 'idempotency_key_expires_idx'
        AND indexdef LIKE '%(expires_at)'), 'IK2 unique (tenant_id, scope, key) and expires_at index');
SELECT pg_temp.check((SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'platform.idempotency_key'::regclass)
        AND (SELECT string_agg(polname, ',' ORDER BY polname) FROM pg_policy WHERE polrelid = 'platform.idempotency_key'::regclass)
            = 'no_partner_access,rw_delete_expired_only,tenant_isolation,worker_purge,worker_purge_read', 'IK3 RLS enabled+forced; tenant, no_partner_access, worker purge policies');
INSERT INTO platform.idempotency_key(tenant_id, scope, key, request_hash, response_status, response_body)
VALUES (platform.current_tenant(), 'POST /v1/settings/gst-config/{id}/replace', 'idem-gst-0001', encode(sha256('body1'),'hex'), 200, '{"id":"r1"}');
SELECT pg_temp.check((SELECT expires_at - created_at FROM platform.idempotency_key WHERE key = 'idem-gst-0001') = interval '24 hours', 'IK4 default TTL 24 h');
SELECT pg_temp.expect_error($$INSERT INTO platform.idempotency_key(tenant_id, scope, key, request_hash, response_status, response_body)
       VALUES (platform.current_tenant(), 'POST /v1/settings/gst-config/{id}/replace', 'idem-gst-0001', 'h2', 200, '{}')$$,
       'IK5 duplicate (tenant, scope, key) rejected', '%idempotency_key_pkey%');
INSERT INTO platform.idempotency_key(tenant_id, scope, key, request_hash, response_status, response_body)
VALUES (platform.current_tenant(), 'POST /v1/masters/customers', 'idem-gst-0001', 'h3', 201, '{}');
SELECT pg_temp.check((SELECT count(*) FROM platform.idempotency_key WHERE key = 'idem-gst-0001') = 2, 'IK6 same key under another scope is a different entry');
SELECT pg_temp.expect_error($$INSERT INTO platform.idempotency_key(tenant_id, scope, key, request_hash, response_status, response_body)
       VALUES (platform.current_tenant(), 'POST /v1/x', '', 'h', 200, '{}')$$, 'IK7 empty key rejected', '%check%');
SELECT pg_temp.expect_error($$INSERT INTO platform.idempotency_key(tenant_id, scope, key, request_hash, response_status, response_body)
       VALUES (platform.current_tenant(), 'POST /v1/x', repeat('k', 256), 'h', 200, '{}')$$, 'IK8 256-char key rejected', '%check%');
INSERT INTO platform.idempotency_key(tenant_id, scope, key, request_hash, response_status, response_body)
VALUES (platform.current_tenant(), 'POST /v1/x', repeat('k', 255), 'h', 200, '{}');
SELECT pg_temp.expect_error($$INSERT INTO platform.idempotency_key(tenant_id, scope, key, request_hash, response_status, response_body)
       VALUES (platform.current_tenant(), 'gst-config', 'k-scope', 'h', 200, '{}')$$, 'IK9 scope must be METHOD /v1/route', '%check%');
SELECT pg_temp.expect_error($$INSERT INTO platform.idempotency_key(tenant_id, scope, key, request_hash, response_status, response_body)
       VALUES (platform.current_tenant(), 'GET /v1/settings', 'k-get', 'h', 200, '{}')$$, 'IK10 GET is not an idempotent-write scope', '%check%');
SELECT pg_temp.expect_error($$INSERT INTO platform.idempotency_key(tenant_id, scope, key, request_hash, response_status, response_body)
       VALUES (platform.current_tenant(), 'POST /v1/x', 'k-status', 'h', 42, '{}')$$, 'IK11 response_status must be 100..599', '%check%');
SELECT pg_temp.expect_error($$INSERT INTO platform.idempotency_key(tenant_id, scope, key, request_hash, response_status, response_body, created_at, expires_at)
       VALUES (platform.current_tenant(), 'POST /v1/x', 'k-exp', 'h', 200, '{}', now(), now())$$, 'IK12 expires_at must be after created_at', '%idempotency_key_expiry_after_create%');
-- an expired row for the worker purge test (run_worker_tests.sql)
INSERT INTO platform.idempotency_key(tenant_id, scope, key, request_hash, response_status, response_body, created_at, expires_at)
VALUES (platform.current_tenant(), 'POST /v1/settings/gst-config/{id}/replace', 'idem-gst-expired', 'h', 200, '{}', now() - interval '25 hours', now() - interval '1 hour');
SELECT pg_temp.expect_error($$UPDATE platform.idempotency_key SET response_status = 500$$, 'IK13 app_rw cannot UPDATE idempotency keys', '%permission denied%');
WITH d AS (DELETE FROM platform.idempotency_key WHERE key = 'idem-gst-0001' RETURNING 1)
  SELECT pg_temp.check(count(*) = 0, 'IK14 app_rw cannot delete a live key (0 rows)') FROM d;
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-000000000002',false) \g /dev/null
SELECT pg_temp.check((SELECT count(*) FROM platform.idempotency_key) = 0, 'IK15 other tenant sees no idempotency keys');
INSERT INTO platform.idempotency_key(tenant_id, scope, key, request_hash, response_status, response_body, created_at, expires_at)
VALUES (platform.current_tenant(), 'POST /v1/settings/gst-config/{id}/replace', 'idem-t2-expired', 'h', 200, '{}', now() - interval '25 hours', now() - interval '1 hour');
SELECT pg_temp.expect_error($$INSERT INTO platform.idempotency_key(tenant_id, scope, key, request_hash, response_status, response_body)
       VALUES ('00000000-0000-0000-0000-000000000001', 'POST /v1/x', 'k-cross', 'h', 200, '{}')$$, 'IK16 cannot write a key for another tenant', '%row-level security%');
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-000000000001',false), set_config('app.partner_id','00000000-0000-0000-0000-0000000000a1',false) \g /dev/null
SELECT pg_temp.check((SELECT count(*) FROM platform.idempotency_key) = 0, 'IK17 partner session sees no idempotency keys (even with app.tenant_id set)');
SELECT pg_temp.expect_error($$INSERT INTO platform.idempotency_key(tenant_id, scope, key, request_hash, response_status, response_body)
       VALUES (platform.current_tenant(), 'POST /v1/x', 'k-partner', 'h', 200, '{}')$$, 'IK18 partner cannot insert idempotency keys', '%row-level security%');
SELECT set_config('app.partner_id','',false) \g /dev/null
SELECT pg_temp.check((SELECT count(*) FROM platform.idempotency_key) = 4, 'IK19 shop sees its own 4 keys again');
DO $$
DECLARE extra text;
BEGIN
  -- direct ACL entries only (inherited membership e.g. pg_write_all_data is not a grant on this table)
  SELECT string_agg(coalesce(g.rolname, 'PUBLIC') || ':' || a.privilege_type, ',' ORDER BY 1) INTO extra
  FROM pg_class c, aclexplode(c.relacl) a LEFT JOIN pg_roles g ON g.oid = a.grantee
  WHERE c.oid = 'platform.idempotency_key'::regclass AND a.grantee <> c.relowner
    AND (coalesce(g.rolname, 'PUBLIC') || ':' || a.privilege_type) NOT IN ('app_rw:SELECT','app_rw:INSERT','app_rw:DELETE','app_worker:SELECT','app_worker:DELETE');
  IF extra IS NOT NULL THEN RAISE EXCEPTION 'FAIL  IK20 unexpected grants on platform.idempotency_key: %', extra; END IF;
  IF NOT (has_table_privilege('app_rw','platform.idempotency_key','INSERT') AND has_table_privilege('app_rw','platform.idempotency_key','DELETE')
          AND has_table_privilege('app_worker','platform.idempotency_key','DELETE')) THEN
    RAISE EXCEPTION 'FAIL  IK20 missing app_rw INSERT/DELETE or app_worker DELETE'; END IF;
  RAISE NOTICE 'PASS  IK20 grants exactly: app_rw SELECT+INSERT+DELETE, app_worker SELECT+DELETE (no UPDATE anywhere, no app_ro/app_admin/PUBLIC)';
  -- effective DELETE (incl. membership): only the two grantees + owner/admin chain
  SELECT string_agg(r.rolname, ',' ORDER BY r.rolname) INTO extra FROM pg_roles r
  WHERE has_table_privilege(r.oid, 'platform.idempotency_key', 'DELETE') AND NOT r.rolsuper
    AND r.rolname NOT IN ('app_rw','app_worker','app_migrator','pg_write_all_data');
  IF extra IS NOT NULL THEN RAISE EXCEPTION 'FAIL  IK26 unexpected effective DELETE holders: %', extra; END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members WHERE roleid = 'pg_write_all_data'::regrole) THEN RAISE EXCEPTION 'FAIL  IK26 pg_write_all_data has members'; END IF;
  IF pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'platform.idempotency_key'::regclass)) <> 'app_migrator' THEN RAISE EXCEPTION 'FAIL  IK26 owner'; END IF;
  RAISE NOTICE 'PASS  IK26 effective DELETE only app_rw, app_worker + owner chain (app_migrator owner, superusers, member-less pg_write_all_data)';
END $$;
-- 973 app_rw expired-key reuse (rw_delete_expired_only)
INSERT INTO platform.idempotency_key(tenant_id, scope, key, request_hash, response_status, response_body, created_at, expires_at)
VALUES (platform.current_tenant(), 'POST /v1/settings/gst-config/{id}/replace', 'idem-gst-reuse', 'old', 200, '{"v":1}', now() - interval '25 hours', now() - interval '1 hour');
DO $$
DECLARE n int;
BEGIN   -- one transaction: delete the expired key, re-insert the same key
  DELETE FROM platform.idempotency_key WHERE scope = 'POST /v1/settings/gst-config/{id}/replace' AND key = 'idem-gst-reuse' AND expires_at <= now();
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL  IK27 expired own-tenant key not deleted (%)', n; END IF;
  INSERT INTO platform.idempotency_key(tenant_id, scope, key, request_hash, response_status, response_body)
  VALUES (platform.current_tenant(), 'POST /v1/settings/gst-config/{id}/replace', 'idem-gst-reuse', 'new', 201, '{"v":2}');
  RAISE NOTICE 'PASS  IK27 app_rw deletes its expired key and re-inserts the same key in one transaction';
END $$;
SELECT pg_temp.check((SELECT request_hash = 'new' AND expires_at > now() FROM platform.idempotency_key WHERE key = 'idem-gst-reuse'), 'IK28 re-used key holds the new response, live again');
WITH d AS (DELETE FROM platform.idempotency_key WHERE key = 'idem-gst-reuse' RETURNING 1)
  SELECT pg_temp.check(count(*) = 0, 'IK29 the re-inserted (live) key cannot be deleted') FROM d;
WITH d AS (DELETE FROM platform.idempotency_key WHERE key = 'idem-t2-expired' RETURNING 1)
  SELECT pg_temp.check(count(*) = 0, 'IK30 app_rw cannot delete another tenant''s expired key') FROM d;
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-000000000002',false) \g /dev/null
SELECT pg_temp.check((SELECT count(*) FROM platform.idempotency_key WHERE key = 'idem-t2-expired') = 1, 'IK30 other tenant''s expired key still there');
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-000000000001',false) \g /dev/null
SELECT pg_temp.expect_error($$UPDATE platform.idempotency_key SET expires_at = now() + interval '1 day' WHERE key = 'idem-gst-reuse'$$,
       'IK31 still no UPDATE for app_rw', '%permission denied%');
-- 974 platform.file
SELECT pg_temp.check((SELECT string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' ORDER BY ordinal_position)
        FROM information_schema.columns WHERE table_schema = 'platform' AND table_name = 'file')
        = 'tenant_id:uuid:NO,id:uuid:NO,area:text:NO,object_key:text:NO,original_name:text:NO,content_type:text:NO,size_bytes:bigint:NO,'
          'sha256:bytea:NO,created_by:uuid:YES,created_at:timestamp with time zone:NO,deleted_at:timestamp with time zone:YES', 'F1 platform.file columns, types, nullability');
SELECT pg_temp.check((SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'platform.file'::regclass)
        AND (SELECT string_agg(polname, ',' ORDER BY polname) FROM pg_policy WHERE polrelid = 'platform.file'::regclass) = 'no_partner_access,tenant_isolation',
       'F2 RLS enabled+forced with tenant_isolation, no_partner_access');
INSERT INTO platform.file(tenant_id, id, area, object_key, original_name, content_type, size_bytes, sha256, created_by)
VALUES (platform.current_tenant(), '00000000-0000-0000-0000-0000000f1e01', 'imports', 'imports/t1/customers-2026-10.csv', 'customers.csv', 'text/csv', 2048,
        sha256('file1'), '00000000-0000-0000-0000-000000000a01');
WITH x AS (INSERT INTO platform.file(tenant_id, area, object_key, original_name, content_type, size_bytes, sha256)
        VALUES (platform.current_tenant(), 'exports', 'exports/t1/stock.xlsx', 'stock.xlsx', 'application/vnd.ms-excel', 0, sha256('f2')) RETURNING id, created_at)
  SELECT pg_temp.check((SELECT id IS NOT NULL AND created_at IS NOT NULL FROM x), 'F3 id/created_at default; size 0 and NULL created_by allowed');
SELECT pg_temp.expect_error($$INSERT INTO platform.file(tenant_id, area, object_key, original_name, content_type, size_bytes, sha256) VALUES (platform.current_tenant(), 'scans','imports/t1/a.csv','x','text/csv',1,sha256('a'))$$,
       'F4 area CHECK (scans rejected)', '%file_area_check%');
SELECT pg_temp.expect_error($$INSERT INTO platform.file(tenant_id, area, object_key, original_name, content_type, size_bytes, sha256) VALUES (platform.current_tenant(), 'imports','imports/t1/b.csv','','text/csv',1,sha256('b'))$$,
       'F5 empty original_name rejected', '%file_original_name_check%');
SELECT pg_temp.expect_error($$INSERT INTO platform.file(tenant_id, area, object_key, original_name, content_type, size_bytes, sha256) VALUES (platform.current_tenant(), 'imports','imports/t1/c.csv',repeat('n',256),'text/csv',1,sha256('c'))$$,
       'F6 256-char original_name rejected', '%file_original_name_check%');
SELECT pg_temp.expect_error($$INSERT INTO platform.file(tenant_id, area, object_key, original_name, content_type, size_bytes, sha256) VALUES (platform.current_tenant(), 'imports','imports/t1/d.csv','d','text/csv',-1,sha256('d'))$$,
       'F7 negative size rejected', '%file_size_bytes_check%');
SELECT pg_temp.expect_error($$INSERT INTO platform.file(tenant_id, area, object_key, original_name, content_type, size_bytes, sha256) VALUES (platform.current_tenant(), 'imports','imports/t1/e.csv','e','text/csv',1,'\x00'::bytea)$$,
       'F8 sha256 must be 32 bytes', '%file_sha256_check%');
SELECT pg_temp.expect_error($$INSERT INTO platform.file(tenant_id, area, object_key, original_name, content_type, size_bytes, sha256) VALUES (platform.current_tenant(), 'exports','imports/t1/customers-2026-10.csv','dup','text/csv',1,sha256('x'))$$,
       'F9 object_key unique (even across areas)', '%file_object_key_uq%');
SELECT pg_temp.expect_error($$INSERT INTO platform.file(tenant_id, area, object_key, original_name, content_type, size_bytes, sha256, created_by)
       VALUES (platform.current_tenant(), 'imports', 'imports/t1/f.csv', 'f', 'text/csv', 1, sha256('f'), '00000000-0000-0000-0000-00000000dead')$$,
       'F10 created_by must be a user of the same tenant', '%file_created_by_fk%');
-- grant guard
SELECT pg_temp.expect_error($$DELETE FROM platform.file$$, 'F11 app_rw cannot DELETE files', '%permission denied%');
SELECT pg_temp.expect_error($$UPDATE platform.file SET object_key = 'x'$$, 'F12 app_rw cannot UPDATE object_key', '%permission denied%');
SELECT pg_temp.expect_error($$UPDATE platform.file SET size_bytes = 1$$, 'F12 app_rw cannot UPDATE size_bytes', '%permission denied%');
SELECT pg_temp.expect_error($$UPDATE platform.file SET original_name = 'y', deleted_at = now()$$, 'F12 app_rw cannot UPDATE other columns alongside deleted_at', '%permission denied%');
WITH u AS (UPDATE platform.file SET deleted_at = now() WHERE object_key = 'exports/t1/stock.xlsx' RETURNING deleted_at)
  SELECT pg_temp.check((SELECT deleted_at IS NOT NULL FROM u), 'F13 app_rw soft-deletes (UPDATE deleted_at)');
DO $$
DECLARE extra text;
BEGIN
  SELECT string_agg(x, ',' ORDER BY x) INTO extra FROM (
    SELECT coalesce(g.rolname, 'PUBLIC') || ':' || a.privilege_type AS x
    FROM pg_class c, aclexplode(c.relacl) a LEFT JOIN pg_roles g ON g.oid = a.grantee
    WHERE c.oid = 'platform.file'::regclass AND a.grantee <> c.relowner
    UNION ALL
    SELECT coalesce(g.rolname, 'PUBLIC') || ':' || a.privilege_type || '(' || att.attname || ')'
    FROM pg_attribute att, aclexplode(att.attacl) a LEFT JOIN pg_roles g ON g.oid = a.grantee
    WHERE att.attrelid = 'platform.file'::regclass AND att.attacl IS NOT NULL) t
  WHERE x NOT IN ('app_rw:SELECT','app_rw:INSERT','app_rw:UPDATE(deleted_at)','app_ro:SELECT');
  IF extra IS NOT NULL THEN RAISE EXCEPTION 'FAIL  F14 unexpected grants on platform.file: %', extra; END IF;
  IF NOT has_column_privilege('app_rw','platform.file','deleted_at','UPDATE') OR has_table_privilege('app_rw','platform.file','UPDATE')
     OR has_table_privilege('app_worker','platform.file','SELECT') THEN RAISE EXCEPTION 'FAIL  F14 grant shape'; END IF;
  RAISE NOTICE 'PASS  F14 grants exactly: app_rw SELECT+INSERT+UPDATE(deleted_at), app_ro SELECT, app_worker none';
  SELECT string_agg(r.rolname, ',' ORDER BY r.rolname) INTO extra FROM pg_roles r
  WHERE has_table_privilege(r.oid, 'platform.file', 'DELETE') AND NOT r.rolsuper AND r.rolname NOT IN ('app_migrator','pg_write_all_data');
  IF extra IS NOT NULL THEN RAISE EXCEPTION 'FAIL  F15 unexpected effective DELETE holders: %', extra; END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members WHERE roleid = 'pg_write_all_data'::regrole)
     OR pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'platform.file'::regclass)) <> 'app_migrator' THEN RAISE EXCEPTION 'FAIL  F15 owner chain'; END IF;
  RAISE NOTICE 'PASS  F15 effective DELETE only owner chain (app_migrator owner, superusers, member-less pg_write_all_data)';
END $$;
-- import_job.file_id
UPDATE platform.import_job SET file_id = '00000000-0000-0000-0000-0000000f1e01' WHERE id = '00000000-0000-0000-0000-00000000f001';
SELECT pg_temp.check((SELECT f.original_name FROM platform.import_job j JOIN platform.file f ON f.tenant_id = j.tenant_id AND f.id = j.file_id
        WHERE j.id = '00000000-0000-0000-0000-00000000f001') = 'customers.csv', 'F16 import_job.file_id links to the same-tenant file');
SELECT pg_temp.check(EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'platform' AND indexname = 'import_job_file_idx'), 'F17 index on import_job(tenant_id, file_id)');
SELECT pg_temp.expect_error($$UPDATE platform.import_job SET file_id = '00000000-0000-0000-0000-00000000dead' WHERE id = '00000000-0000-0000-0000-00000000f001'$$,
       'F18 import_job.file_id must exist', '%import_job_file_fk%');
-- RLS: other tenant
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-000000000002',false) \g /dev/null
SELECT pg_temp.check((SELECT count(*) FROM platform.file) = 0, 'F19 other tenant sees no files');
SELECT pg_temp.expect_error($$INSERT INTO platform.file(tenant_id, area, object_key, original_name, content_type, size_bytes, sha256)
       VALUES ('00000000-0000-0000-0000-000000000001', 'imports', 'imports/t1/sneak.csv', 's', 'text/csv', 1, sha256('s'))$$,
       'F20 other tenant cannot insert a file for tenant 1', '%row-level security%');
INSERT INTO platform.file(tenant_id, id, area, object_key, original_name, content_type, size_bytes, sha256)
VALUES (platform.current_tenant(), '00000000-0000-0000-0000-0000000f2e01', 'attachments', 'attachments/t2/photo.jpg', 'photo.jpg', 'image/jpeg', 10, sha256('t2'));
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-000000000001',false) \g /dev/null
SELECT pg_temp.expect_error($$UPDATE platform.import_job SET file_id = '00000000-0000-0000-0000-0000000f2e01' WHERE id = '00000000-0000-0000-0000-00000000f001'$$,
       'F21 import_job cannot link another tenant''s file (composite FK)', '%import_job_file_fk%');
WITH u AS (UPDATE platform.file SET deleted_at = now() WHERE id = '00000000-0000-0000-0000-0000000f2e01' RETURNING 1)
  SELECT pg_temp.check(count(*) = 0, 'F22 cannot soft-delete another tenant''s file (0 rows)') FROM u;
-- partner
SELECT set_config('app.partner_id','00000000-0000-0000-0000-0000000000a1',false) \g /dev/null
SELECT pg_temp.check((SELECT count(*) FROM platform.file) = 0, 'F23 partner session sees no files (even with app.tenant_id set)');
SELECT pg_temp.expect_error($$INSERT INTO platform.file(tenant_id, area, object_key, original_name, content_type, size_bytes, sha256)
       VALUES (platform.current_tenant(), 'imports', 'imports/p/x.csv', 'x', 'text/csv', 1, sha256('p'))$$, 'F24 partner cannot insert files', '%row-level security%');
SELECT set_config('app.partner_id','',false) \g /dev/null
SELECT pg_temp.check((SELECT count(*) FROM platform.file) = 2, 'F25 shop sees its own 2 files again');
\echo 'ALL APP_RW TESTS DONE'
