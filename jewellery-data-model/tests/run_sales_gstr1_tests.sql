-- 996 GSTR-1/CDN regression. Run as test superuser on VPS TEST DB, after tests/seed.sql; everything rolls back.
-- -v upgrade_995=1 probes 995 -> 996 with existing numbered notes and view metadata; 0 tests the already-migrated head.
\set ON_ERROR_STOP 1
\pset footer off
\pset tuples_only on
CREATE FUNCTION pg_temp.gstr_check(ok boolean, label text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN IF ok THEN RETURN 'PASS  ' || label; END IF; RAISE EXCEPTION 'FAIL  %', label; END $$;
BEGIN;
SET LOCAL SESSION AUTHORIZATION app_migrator;
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-000000000001',true),
       set_config('app.user_id','00000000-0000-0000-0000-000000000a01',true),
       set_config('app.partner_id','',true), set_config('app.branch_scope','',true) \g /dev/null
CREATE TEMP TABLE gstr_meta ON COMMIT DROP AS
SELECT oid, relname, relowner, relacl, reloptions, pg_get_viewdef(oid) AS definition,
       (SELECT jsonb_agg(jsonb_build_array(attname, atttypid, atttypmod, attcollation) ORDER BY attnum)
          FROM pg_attribute WHERE attrelid = c.oid AND attnum > 0 AND NOT attisdropped) AS cols
  FROM pg_class c WHERE oid IN ('reports.gstr1_doc_summary'::regclass, 'reports.cancellations'::regclass,
                                'reports.series_summary'::regclass, 'reports.series_gaps'::regclass);
INSERT INTO platform.branch(tenant_id,id,company_id,code,name,bill_series_prefix,state_code)
VALUES(platform.current_tenant(),'00000000-0000-0000-0000-00000000b996','00000000-0000-0000-0000-00000000c001','G996','GSTR test only','G996','33');
SET LOCAL ROLE sales_writer;
INSERT INTO sales.doc_series(tenant_id,branch_id,doc_type,fy,prefix)
VALUES (platform.current_tenant(),'00000000-0000-0000-0000-00000000b996','tax_invoice',platform.fy_of(current_date),'G996I'),
       (platform.current_tenant(),'00000000-0000-0000-0000-00000000b996','credit_note',platform.fy_of(current_date),'G996C');
UPDATE sales.doc_series SET next_no = next_no + 1 WHERE branch_id='00000000-0000-0000-0000-00000000b996' AND doc_type='tax_invoice'
RETURNING next_no - 1 AS seq, fy \gset
INSERT INTO sales.invoice(tenant_id,branch_id,company_id,fy,doc_seq,doc_no,customer_id,customer_snapshot,place_of_supply,gst_type,rate_snapshot,
  salesperson_id,making_gst_treatment,round_off_to,pan_required,pan_on_file,gross_value,taxable_value,cgst,sgst,invoice_total,net_payable,paid_amount,balance_due,credit_sale,created_by)
VALUES(platform.current_tenant(),'00000000-0000-0000-0000-00000000b996','00000000-0000-0000-0000-00000000c001',:'fy',:seq,'G996I000001',
  '00000000-0000-0000-0000-000000000d01','{}','33','intra','{}','00000000-0000-0000-0000-0000000057a0','composite',1,false,false,1000,1000,15,15,1030,1030,0,1030,true,platform.current_user_id())
RETURNING id AS inv \gset
INSERT INTO sales.invoice_due(tenant_id,branch_id,invoice_id,customer_id,original_due,balance_due)
VALUES(platform.current_tenant(),'00000000-0000-0000-0000-00000000b996',:'inv','00000000-0000-0000-0000-000000000d01',1030,1030);
-- note 1: real taxable sales return, 103 store credit (100 taxable, 3 GST)
UPDATE sales.doc_series SET next_no=next_no+1 WHERE branch_id='00000000-0000-0000-0000-00000000b996' AND doc_type='credit_note' RETURNING next_no-1 AS seq \gset
INSERT INTO sales.credit_note(tenant_id,branch_id,fy,doc_seq,doc_no,invoice_id,kind,reason,customer_id,taxable_value,cgst,sgst,total,store_credit_amount,balance_available,created_by)
VALUES(platform.current_tenant(),'00000000-0000-0000-0000-00000000b996',:'fy',:seq,'G996C000001',:'inv','sales_return','First normal note','00000000-0000-0000-0000-000000000d01',100,1.5,1.5,103,103,103,platform.current_user_id())
RETURNING id AS cn1 \gset
-- original mixed receipt (70 cash, 30 store credit); original note remains reduced when reversed
INSERT INTO sales.payment_receipt(tenant_id,branch_id,invoice_id,customer_id,receipt_no,fy,total,received_by)
VALUES(platform.current_tenant(),'00000000-0000-0000-0000-00000000b996',:'inv','00000000-0000-0000-0000-000000000d01','G996R1',:'fy',100,platform.current_user_id())
RETURNING id AS receipt \gset
INSERT INTO sales.payment_receipt_tender(tenant_id,receipt_id,line_no,mode,amount,credit_note_id)
VALUES(platform.current_tenant(),:'receipt',1,'cash',70,NULL),(platform.current_tenant(),:'receipt',2,'credit_note',30,:'cn1');
UPDATE sales.credit_note SET balance_available=balance_available-30 WHERE id=:'cn1' AND balance_available>=30;
UPDATE sales.invoice_due SET balance_due=balance_due-100,received_after_issue=received_after_issue+100 WHERE invoice_id=:'inv' AND balance_due>=100;
INSERT INTO sales.payment_receipt(tenant_id,branch_id,invoice_id,customer_id,receipt_no,fy,total,received_by,reverses_receipt_id,reversed_total,reversal_reason)
VALUES(platform.current_tenant(),'00000000-0000-0000-0000-00000000b996',:'inv','00000000-0000-0000-0000-000000000d01','G996REV1',:'fy',-100,platform.current_user_id(),:'receipt',100,'Wrong bill payment')
RETURNING id AS reversal \gset
UPDATE sales.invoice_due SET balance_due=balance_due+100,received_after_issue=received_after_issue-100 WHERE invoice_id=:'inv' AND received_after_issue>=100;
-- note 2: payment reversal (not a GST note), 30 store credit
UPDATE sales.doc_series SET next_no=next_no+1 WHERE branch_id='00000000-0000-0000-0000-00000000b996' AND doc_type='credit_note' RETURNING next_no-1 AS seq \gset
INSERT INTO sales.credit_note(tenant_id,branch_id,fy,doc_seq,doc_no,invoice_id,kind,reason,customer_id,taxable_value,total,store_credit_amount,balance_available,created_by,reversal_receipt_id)
VALUES(platform.current_tenant(),'00000000-0000-0000-0000-00000000b996',:'fy',:seq,'G996C000002',:'inv','receipt_reversal','Restore store credit','00000000-0000-0000-0000-000000000d01',0,30,30,30,platform.current_user_id(),:'reversal');
-- note 3: another real taxable sales return, 206 cash refund (200 taxable, 6 GST). Reversal is now IN THE MIDDLE.
UPDATE sales.doc_series SET next_no=next_no+1 WHERE branch_id='00000000-0000-0000-0000-00000000b996' AND doc_type='credit_note' RETURNING next_no-1 AS seq \gset
INSERT INTO sales.credit_note(tenant_id,branch_id,fy,doc_seq,doc_no,invoice_id,kind,reason,customer_id,taxable_value,cgst,sgst,total,refund_mode,refund_amount,created_by)
VALUES(platform.current_tenant(),'00000000-0000-0000-0000-00000000b996',:'fy',:seq,'G996C000003',:'inv','sales_return','Second normal note','00000000-0000-0000-0000-000000000d01',200,3,3,206,'cash',206,platform.current_user_id());
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
RESET ROLE;
RESET SESSION AUTHORIZATION;
SET LOCAL ROLE app_rw;
\if :upgrade_995
SELECT pg_temp.gstr_check((SELECT total FROM reports.gstr1_doc_summary WHERE branch_id='00000000-0000-0000-0000-00000000b996' AND doc_type='credit_note')=3
  AND (SELECT sum(total) FROM reports.cancellations WHERE branch_id='00000000-0000-0000-0000-00000000b996')=339,
  'GU0 995 baseline has 3 numbered notes; old tax-facing list wrongly includes the 30 payment-restoration amount (339)');
RESET ROLE;
SET LOCAL SESSION AUTHORIZATION app_migrator;
\ir ../migrations/996_sales_gstr1_exclude_receipt_reversal.sql
SELECT pg_temp.gstr_check(NOT EXISTS(SELECT 1 FROM gstr_meta m JOIN pg_class c ON c.oid=m.oid
  WHERE c.relowner<>m.relowner OR c.relacl IS DISTINCT FROM m.relacl OR c.reloptions IS DISTINCT FROM m.reloptions
     OR m.cols IS DISTINCT FROM (SELECT jsonb_agg(jsonb_build_array(attname,atttypid,atttypmod,attcollation) ORDER BY attnum)
          FROM pg_attribute WHERE attrelid=c.oid AND attnum BETWEEN 1 AND jsonb_array_length(m.cols) AND NOT attisdropped)),
  'GU1 995 -> 996 preserves existing view OIDs, column names/order/types, ACLs, owners, invoker/barrier options');
\endif
RESET ROLE;
RESET SESSION AUTHORIZATION;
SET LOCAL ROLE app_rw;
SELECT pg_temp.gstr_check((SELECT from_no||'|'||to_no||'|'||total||'|'||cancelled||'|'||excluded_receipt_reversal_count||'|'||total_in_series
  FROM reports.gstr1_doc_summary WHERE branch_id='00000000-0000-0000-0000-00000000b996' AND doc_type='credit_note')='G996C000001|G996C000003|2|0|1|3',
  'GT1 middle receipt_reversal excluded from tax document count: 2 counted, 0 cancelled, 1 excluded, 3 in series; full range 1..3');
SELECT pg_temp.gstr_check((SELECT sum(c.total)=309 AND sum(n.taxable_value)=300 AND sum(n.cgst+n.sgst+n.igst+n.cess)=9 AND count(*)=2
  FROM reports.cancellations c JOIN sales.credit_note n ON n.tenant_id=c.tenant_id AND n.doc_no=c.credit_note_no
  WHERE c.branch_id='00000000-0000-0000-0000-00000000b996')
  AND NOT EXISTS(SELECT 1 FROM reports.cancellations WHERE kind='receipt_reversal'),
  'GT2 credit-note report/amount input excludes receipt_reversal: normal notes 309 total, taxable 300, GST 9 (not 339 total)');
SELECT pg_temp.gstr_check(NOT EXISTS(SELECT 1 FROM reports.series_gaps WHERE branch_id='00000000-0000-0000-0000-00000000b996')
  AND (SELECT last_issued=3 AND gap_count=0 FROM reports.series_summary WHERE branch_id='00000000-0000-0000-0000-00000000b996' AND doc_type='credit_note'),
  'GT3 all three numbered notes count for continuity: no false gap at receipt_reversal sequence 2');
SELECT pg_temp.gstr_check(NOT EXISTS(SELECT 1 FROM reports.gstr1_doc_summary WHERE total_in_series<>(total-cancelled)+cancelled+excluded_receipt_reversal_count)
  AND (SELECT total=1 AND cancelled=0 AND excluded_receipt_reversal_count=0 AND total_in_series=1 FROM reports.gstr1_doc_summary
       WHERE branch_id='00000000-0000-0000-0000-00000000b996' AND doc_type='tax_invoice'),
  'GT4 reconciliation holds for both document kinds; existing total includes cancelled, net counted = total - cancelled');
RESET ROLE;
SET LOCAL SESSION AUTHORIZATION app_migrator;
SELECT pg_temp.gstr_check(NOT EXISTS(SELECT 1 FROM gstr_meta m JOIN pg_class c ON c.oid=m.oid WHERE m.relname IN ('series_gaps','series_summary') AND pg_get_viewdef(c.oid)<>m.definition)
  AND (SELECT bool_and(reloptions=ARRAY['security_invoker=true']) FROM pg_class WHERE oid IN ('reports.gstr1_doc_summary'::regclass,'reports.cancellations'::regclass)),
  'GT5 series view definitions unchanged; both replaced views keep invoker=true and barrier unset');
SET LOCAL ROLE sales_writer;
-- a genuine missing sequence, visible before the deferred allocated-must-be-used guard fires (never committed)
SAVEPOINT real_gap;
UPDATE sales.doc_series SET next_no=next_no+1 WHERE branch_id='00000000-0000-0000-0000-00000000b996' AND doc_type='credit_note';
RESET ROLE;
RESET SESSION AUTHORIZATION;
SET LOCAL ROLE app_rw;
SELECT pg_temp.gstr_check((SELECT array_agg(missing_seq) FROM reports.series_gaps WHERE branch_id='00000000-0000-0000-0000-00000000b996' AND doc_type='credit_note')=ARRAY[4]
  AND (SELECT last_issued=4 AND gap_count=1 FROM reports.series_summary WHERE branch_id='00000000-0000-0000-0000-00000000b996' AND doc_type='credit_note'),
  'GT6 real unfilled number 4 still reported (not the excluded number 2)');
ROLLBACK TO SAVEPOINT real_gap;
-- receipt_reversal at the END must still extend to_no. Allocate a second receipt/reversal and note at sequence 4 (no edits).
SET LOCAL ROLE sales_writer;
INSERT INTO sales.payment_receipt(tenant_id,branch_id,invoice_id,customer_id,receipt_no,fy,total,received_by)
VALUES(platform.current_tenant(),'00000000-0000-0000-0000-00000000b996',:'inv','00000000-0000-0000-0000-000000000d01','G996R2',:'fy',10,platform.current_user_id()) RETURNING id AS r2 \gset
INSERT INTO sales.payment_receipt_tender(tenant_id,receipt_id,line_no,mode,amount,credit_note_id) VALUES(platform.current_tenant(),:'r2',1,'credit_note',10,:'cn1');
UPDATE sales.credit_note SET balance_available=balance_available-10 WHERE id=:'cn1' AND balance_available>=10;
INSERT INTO sales.payment_receipt(tenant_id,branch_id,invoice_id,customer_id,receipt_no,fy,total,received_by,reverses_receipt_id,reversed_total,reversal_reason)
VALUES(platform.current_tenant(),'00000000-0000-0000-0000-00000000b996',:'inv','00000000-0000-0000-0000-000000000d01','G996REV2',:'fy',-10,platform.current_user_id(),:'r2',10,'Another wrong payment') RETURNING id AS rv2 \gset
UPDATE sales.doc_series SET next_no=next_no+1 WHERE branch_id='00000000-0000-0000-0000-00000000b996' AND doc_type='credit_note' RETURNING next_no-1 AS seq \gset
INSERT INTO sales.credit_note(tenant_id,branch_id,fy,doc_seq,doc_no,invoice_id,kind,reason,customer_id,taxable_value,total,store_credit_amount,balance_available,created_by,reversal_receipt_id)
VALUES(platform.current_tenant(),'00000000-0000-0000-0000-00000000b996',:'fy',:seq,'G996C000004',:'inv','receipt_reversal','Restore more credit','00000000-0000-0000-0000-000000000d01',0,10,10,10,platform.current_user_id(),:'rv2');
RESET ROLE;
RESET SESSION AUTHORIZATION;
SET LOCAL ROLE app_rw;
SELECT pg_temp.gstr_check((SELECT to_no='G996C000004' AND total=2 AND excluded_receipt_reversal_count=2 AND total_in_series=4
  FROM reports.gstr1_doc_summary WHERE branch_id='00000000-0000-0000-0000-00000000b996' AND doc_type='credit_note')
  AND NOT EXISTS(SELECT 1 FROM reports.series_gaps WHERE branch_id='00000000-0000-0000-0000-00000000b996'),
  'GT7 excluded endpoint extends to_no to 4, tax count remains 2; both excluded notes still close their series slots');
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-000000000002',true) \g /dev/null
SELECT pg_temp.gstr_check(NOT EXISTS(SELECT 1 FROM reports.gstr1_doc_summary WHERE branch_id='00000000-0000-0000-0000-00000000b996')
  AND NOT EXISTS(SELECT 1 FROM reports.cancellations WHERE branch_id='00000000-0000-0000-0000-00000000b996'),
  'GT8 caller RLS still hides tenant-1 reports from tenant 2');
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-000000000001',true),set_config('app.partner_id','00000000-0000-0000-0000-0000000000a1',true) \g /dev/null
SELECT pg_temp.gstr_check(NOT EXISTS(SELECT 1 FROM reports.gstr1_doc_summary WHERE branch_id='00000000-0000-0000-0000-00000000b996')
  AND NOT EXISTS(SELECT 1 FROM reports.cancellations WHERE branch_id='00000000-0000-0000-0000-00000000b996'),
  'GT9 caller no-partner-access policy unchanged');
SELECT set_config('app.partner_id','',true) \g /dev/null
SET LOCAL ROLE app_ro;
SELECT pg_temp.gstr_check((SELECT total=2 FROM reports.gstr1_doc_summary WHERE branch_id='00000000-0000-0000-0000-00000000b996' AND doc_type='credit_note')
  AND (SELECT count(*)=2 FROM reports.cancellations WHERE branch_id='00000000-0000-0000-0000-00000000b996'),
  'GT10 existing app_ro SELECT grants work with caller RLS');
ROLLBACK;
SELECT pg_temp.gstr_check(NOT EXISTS(SELECT 1 FROM platform.branch WHERE id='00000000-0000-0000-0000-00000000b996'),
  'GT11 entire report fixture rolled back (branch, notes, receipts, audit/outbox, counters)');
