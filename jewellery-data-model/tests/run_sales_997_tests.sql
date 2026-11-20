-- 997 regression, VPS TEST DB only. Test superuser connection, app_migrator session for DDL, writer roles for app DML.
-- -v upgrade_996=1 tests populated 996 -> 997; 0 tests head. Entire fixture / migration probe rolls back.
\set ON_ERROR_STOP 1
\pset tuples_only on
\pset footer off
CREATE FUNCTION pg_temp.p997_check(ok boolean, label text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN IF ok THEN RETURN 'PASS  '||label; END IF; RAISE EXCEPTION 'FAIL  %',label; END $$;
CREATE FUNCTION pg_temp.p997_error(stmt text,label text,pattern text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  BEGIN EXECUTE stmt;
  EXCEPTION WHEN others THEN
    IF SQLERRM LIKE pattern THEN RETURN 'PASS  '||label||' -> '||SQLERRM; END IF;
    RAISE EXCEPTION 'FAIL  % wrong error: %',label,SQLERRM;
  END;
  RAISE EXCEPTION 'FAIL  % unexpectedly succeeded',label;
END $$;
CREATE FUNCTION pg_temp.p997_ins(tbl regclass,p jsonb) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE cols text; r uuid;
BEGIN
  SELECT string_agg(quote_ident(k),',') INTO cols FROM jsonb_object_keys(p) k;
  EXECUTE format('INSERT INTO %s (%s) SELECT %s FROM jsonb_populate_record(NULL::%s,$1) RETURNING id',tbl,cols,cols,tbl) INTO r USING p;
  RETURN r;
END $$;
CREATE FUNCTION pg_temp.p997_bad(tbl text,p jsonb,label text,pattern text) RETURNS text LANGUAGE sql AS $$
 SELECT pg_temp.p997_error(format('SELECT pg_temp.p997_ins(%L::regclass,%L::jsonb)',tbl,p::text),label,pattern) $$;
BEGIN;
SET LOCAL SESSION AUTHORIZATION app_migrator;
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-000000000001',true),
       set_config('app.user_id','00000000-0000-0000-0000-000000000a01',true),
       set_config('app.partner_id','',true),set_config('app.branch_scope','',true) \g /dev/null
INSERT INTO platform.branch(tenant_id,id,company_id,code,name,bill_series_prefix,state_code)
VALUES(platform.current_tenant(),'00000000-0000-0000-0000-00000000b997','00000000-0000-0000-0000-00000000c001','P997','997 test only','P997','33');
SET LOCAL ROLE sales_writer;
INSERT INTO sales.doc_series(tenant_id,branch_id,doc_type,fy,prefix)
VALUES(platform.current_tenant(),'00000000-0000-0000-0000-00000000b997','tax_invoice',platform.fy_of(current_date),'P997I'),
      (platform.current_tenant(),'00000000-0000-0000-0000-00000000b997','credit_note',platform.fy_of(current_date),'P997C');
SELECT jsonb_build_object('tenant_id',platform.current_tenant(),'branch_id','00000000-0000-0000-0000-00000000b997','company_id','00000000-0000-0000-0000-00000000c001',
 'customer_id','00000000-0000-0000-0000-000000000d01','customer_snapshot','{}'::jsonb,'place_of_supply','33','gst_type','intra','rate_snapshot','{}'::jsonb,
 'salesperson_id','00000000-0000-0000-0000-0000000057a0','making_gst_treatment','composite','round_off_to',1,'pan_required',false,'pan_on_file',false,
 'gross_value',1000,'taxable_value',1000,'cgst',15,'sgst',15,'invoice_total',1030,'net_payable',1030,'paid_amount',1030,'balance_due',0,'created_by',platform.current_user_id())::text AS inv_base \gset
UPDATE sales.doc_series SET next_no=next_no+1 WHERE branch_id='00000000-0000-0000-0000-00000000b997' AND doc_type='tax_invoice' RETURNING next_no-1 AS seq,fy \gset
SELECT pg_temp.p997_ins('sales.invoice',:'inv_base'::jsonb||jsonb_build_object('fy',:'fy','doc_seq',:seq,'doc_no','P997I000001')) AS cancelled_inv \gset
UPDATE sales.doc_series SET next_no=next_no+1 WHERE branch_id='00000000-0000-0000-0000-00000000b997' AND doc_type='tax_invoice' RETURNING next_no-1 AS seq \gset
SELECT pg_temp.p997_ins('sales.invoice',:'inv_base'::jsonb||jsonb_build_object('fy',:'fy','doc_seq',:seq,'doc_no','P997I000002',
 'gross_value',2000,'taxable_value',2000,'cgst',30,'sgst',30,'invoice_total',2060,'net_payable',2060,'paid_amount',2060)) AS live_inv \gset
SELECT jsonb_build_object('tenant_id',platform.current_tenant(),'invoice_id',:'live_inv','line_no',1,'stock_kind','loose','purity_id','00000000-0000-0000-0000-000000000022',
 'item_id','00000000-0000-0000-0000-000000000902','description','Loose by weight','purity_code','22K','fineness',916,'hsn','7113','pieces',1,'gross_wt',2,'net_wt',2,'chargeable_wt',2,
 'rate_id',(SELECT id FROM rates.metal_rate WHERE kind='sale' LIMIT 1),'rate_per_g',500,'metal_value',1000,'mc_type','flat','mc_value',0,'mc_amount',0,'gross_value',1000,'taxable_value',1000,
 'tax_rule_id',(SELECT id FROM masters.tax_rule WHERE scope='tenant' AND code='GOLD_JEWELLERY'),'tax_rate',3,'hsn_sac_applied','7113','composite_supply',false,'cgst',15,'sgst',15,'line_total',1030)::text AS line_base \gset
SELECT pg_temp.p997_ins('sales.invoice_line',:'line_base'::jsonb) AS existing_line \gset
SELECT jsonb_build_object('tenant_id',platform.current_tenant(),'branch_id','00000000-0000-0000-0000-00000000b997','fy',:'fy',
 'customer_id','00000000-0000-0000-0000-000000000d01','reason','Test whole line return','taxable_value',1000,'cgst',15,'sgst',15,'total',1030,'refund_mode','cash','refund_amount',1030,
 'created_by',platform.current_user_id())::text AS cn_base \gset
UPDATE sales.doc_series SET next_no=next_no+1 WHERE branch_id='00000000-0000-0000-0000-00000000b997' AND doc_type='credit_note' RETURNING next_no-1 AS seq \gset
SELECT pg_temp.p997_ins('sales.credit_note',:'cn_base'::jsonb||jsonb_build_object('invoice_id',:'cancelled_inv','kind','cancellation','doc_seq',:seq,'doc_no','P997C000001')) AS cancel_cn \gset
UPDATE sales.invoice SET status='cancelled',cancelled_at=now(),cancel_credit_note_id=:'cancel_cn' WHERE id=:'cancelled_inv';
SELECT jsonb_build_object('tenant_id',platform.current_tenant(),'branch_id','00000000-0000-0000-0000-00000000b997','doc_type','invoice','doc_id',:'live_inv',
 'print_no',1,'copy','original','paper','A4','template_id','01a1c455-29fa-769b-84f9-377a9bcdab46','template_version',1,'printed_by',platform.current_user_id())::text AS print_base \gset
-- A real existing original and positive-piece line at 996 must survive the migration unchanged.
SELECT pg_temp.p997_ins('sales.document_print',:'print_base'::jsonb) AS existing_print \gset
SELECT (to_jsonb(p)-'doc_cancelled')::text AS print_before FROM sales.document_print p WHERE id=:'existing_print' \gset
SELECT to_jsonb(l)::text AS line_before FROM sales.invoice_line l WHERE id=:'existing_line' \gset
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
\if :upgrade_996
SELECT pg_temp.p997_bad('sales.invoice_line',:'line_base'::jsonb||'{"line_no":2,"pieces":0}',
 'PU0 996 rejects a zero-piece loose line (baseline)','%invoice_line_weights_check%');
SELECT pg_temp.p997_bad('sales.document_print',:'print_base'::jsonb||jsonb_build_object('doc_id',:'cancelled_inv','copy','duplicate','reprint_reason','Cancelled before first print'),
 'PU1 996 rejects first duplicate even for a cancelled bill (baseline)','%document_print_original_check%');
RESET ROLE;
SET LOCAL SESSION AUTHORIZATION app_migrator;
\ir ../migrations/997_sales_print_cancelled_and_loose_weight.sql
SET LOCAL ROLE sales_writer;
SELECT pg_temp.p997_check((SELECT NOT doc_cancelled AND to_jsonb(p)-'doc_cancelled'=:'print_before'::jsonb FROM sales.document_print p WHERE id=:'existing_print')
 AND (SELECT to_jsonb(l)=:'line_before'::jsonb FROM sales.invoice_line l WHERE id=:'existing_line'),
 'PU2 996 -> 997 existing print history and line rows unchanged; old snapshot defaults false');
\endif
SELECT pg_temp.p997_check((SELECT convalidated=NOT :upgrade_996::boolean FROM pg_constraint WHERE conrelid='sales.invoice_line'::regclass AND conname='invoice_line_weights_check')
 AND (SELECT count(*)=CASE WHEN :upgrade_996::boolean THEN 19 ELSE 0 END FROM pg_constraint WHERE connamespace='sales'::regnamespace AND NOT convalidated)
 AND NOT has_column_privilege('sales_writer','sales.document_print','doc_cancelled','UPDATE'),
 'PN0 weights validation matches staged/head state; snapshot immutable; no new function/trigger');
SELECT (:'print_base'::jsonb||jsonb_build_object('doc_id',:'cancelled_inv','copy','duplicate','doc_cancelled',true,'reprint_reason','Cancelled before first print'))::text AS cancel_print \gset
SELECT pg_temp.p997_bad('sales.document_print',:'cancel_print'::jsonb||'{"copy":"original"}', 'PN1 cancelled bill can never print ORIGINAL','%document_print_original_check%');
SELECT pg_temp.p997_bad('sales.document_print',:'cancel_print'::jsonb||'{"doc_cancelled":false}', 'PN2 cannot lie about cancellation snapshot','%print_cancelled_snapshot%');
SELECT pg_temp.p997_bad('sales.document_print',:'print_base'::jsonb||'{"copy":"duplicate","reprint_reason":"First print"}',
 'PN3 live bill first print must still be ORIGINAL','%document_print_original_check%');
SELECT pg_temp.p997_bad('sales.document_print',:'cancel_print'::jsonb||jsonb_build_object('doc_id',:'live_inv'),
 'PN4 live invoice cannot claim a cancelled snapshot','%print_cancelled_snapshot%');
SELECT pg_temp.p997_bad('sales.document_print',:'cancel_print'::jsonb||'{"reprint_reason":"no"}', 'PN5 first cancelled DUPLICATE still requires 3-200 character reason','%document_print_reason_check%');
SELECT pg_temp.p997_bad('sales.document_print',:'cancel_print'::jsonb||'{"print_no":0}', 'PN6 print number still at least 1','%document_print_print_no_check%');
SELECT pg_temp.p997_ins('sales.document_print',:'cancel_print'::jsonb) AS cancelled_print \gset
SELECT pg_temp.p997_bad('sales.document_print',:'cancel_print'::jsonb, 'PN7 print number still unique per document','%document_print_no_uq%');
SELECT pg_temp.p997_bad('sales.document_print',:'print_base'::jsonb||'{"print_no":2}', 'PN8 later ORIGINAL still blocked','%document_print_original_check%');
SELECT pg_temp.p997_bad('sales.document_print',:'cancel_print'::jsonb||'{"print_no":2,"printed_by":"00000000-0000-0000-0000-000000000a02"}',
 'PN9 printed_by must still be session user','%printed_by_self%');
SELECT pg_temp.p997_ins('sales.document_print',:'print_base'::jsonb||'{"print_no":2,"copy":"duplicate","reprint_reason":"Customer requested copy"}') AS later_print \gset
RESET ROLE;
RESET SESSION AUTHORIZATION;
SET LOCAL ROLE app_rw;
SELECT pg_temp.p997_check((SELECT doc_cancelled AND copy='duplicate' AND print_no=1 FROM sales.document_print WHERE id=:'cancelled_print')
 AND (SELECT count(*)=3 FROM platform.audit_event WHERE table_name='sales.document_print' AND row_id IN (:'existing_print',:'cancelled_print',:'later_print') AND action='INSERT'),
 'PN10 cancelled-before-print bill prints DUPLICATE 1 (renderer stamps CANCELLED), normal original/duplicate and cancellation prints audited');
SET LOCAL ROLE sales_writer;
SELECT pg_temp.p997_error(format('UPDATE sales.document_print SET doc_cancelled=false WHERE id=%L',:'cancelled_print'),
 'PN11 print history remains append-only','%permission denied%');
-- Non-invoice documents keep the existing first-original rule, including a cancelled ESTIMATE (not an issued bill).
-- Each print pins the 998 template of its own document type (999 FK includes the document type).
SELECT pg_temp.p997_bad('sales.document_print',:'cancel_print'::jsonb||jsonb_build_object('doc_type','credit_note','doc_id',:'cancel_cn','template_id','01a1c455-29fa-7856-b4ed-a3710fd91ec1'),
 'PN12 credit notes cannot use invoice cancellation snapshot','%document_print_original_check%');
SELECT pg_temp.p997_ins('sales.document_print',:'print_base'::jsonb||jsonb_build_object('doc_type','credit_note','doc_id',:'cancel_cn','template_id','01a1c455-29fa-7856-b4ed-a3710fd91ec1')) AS cn_print \gset
INSERT INTO sales.estimate(tenant_id,branch_id,estimate_no,created_by) VALUES(platform.current_tenant(),'00000000-0000-0000-0000-00000000b997','P997E',platform.current_user_id()) RETURNING id AS est \gset
UPDATE sales.estimate SET status='cancelled' WHERE id=:'est';
SELECT pg_temp.p997_ins('sales.document_print',:'print_base'::jsonb||jsonb_build_object('doc_type','estimate','doc_id',:'est','template_id','01a1c455-29fa-7963-88e9-d3cf6e2a8240')) AS est_print \gset
SELECT pg_temp.p997_check((SELECT count(*)=2 AND bool_and(NOT doc_cancelled AND print_no=1 AND copy='original') FROM sales.document_print WHERE id IN (:'cn_print',:'est_print')),
 'PN13 credit note and cancelled estimate keep first ORIGINAL with doc_cancelled=false (bill-only rule)');
-- Loose zero-piece goods: allowed only with weight; a tagged row, negative pieces or zero goods weight is rejected.
SELECT (:'line_base'::jsonb||'{"line_no":2,"pieces":0}')::text AS zero_loose \gset
SELECT pg_temp.p997_bad('sales.invoice_line',:'zero_loose'::jsonb||'{"stock_kind":"tag","tag_id":"00000000-0000-0000-0000-00000000f001"}',
 'PW1 zero-piece TAG line rejected','%invoice_line_weights_check%');
SELECT pg_temp.p997_bad('sales.invoice_line',:'zero_loose'::jsonb||'{"gross_wt":0,"net_wt":0,"chargeable_wt":0}',
 'PW2 zero-weight goods line rejected','%invoice_line_weights_check%');
SELECT pg_temp.p997_bad('sales.invoice_line',:'zero_loose'::jsonb||'{"pieces":-1}', 'PW3 negative loose pieces rejected','%invoice_line_weights_check%');
SELECT pg_temp.p997_bad('sales.invoice_line',:'zero_loose'::jsonb||'{"net_wt":3,"chargeable_wt":3}', 'PW4 net<=gross remains','%invoice_line_weights_check%');
SELECT pg_temp.p997_bad('sales.invoice_line',:'zero_loose'::jsonb||'{"stone_wt":3}', 'PW5 stone<=gross remains','%invoice_line_weights_check%');
SELECT pg_temp.p997_bad('sales.invoice_line',:'zero_loose'::jsonb||'{"chargeable_wt":3}', 'PW6 chargeable=net+wastage remains','%invoice_line_weights_check%');
SELECT pg_temp.p997_ins('sales.invoice_line',:'zero_loose'::jsonb) AS loose_line \gset
SELECT pg_temp.p997_check((SELECT pieces=0 AND stock_kind='loose' AND net_wt=2 FROM sales.invoice_line WHERE id=:'loose_line'),
 'PW7 weight-only loose line accepted (0 pieces, 2g)');
SELECT pg_temp.p997_ins('sales.invoice_line',:'line_base'::jsonb||'{"line_no":3,"line_kind":"service","stock_kind":null,"pieces":1,"gross_wt":0,"net_wt":0,"chargeable_wt":0}') AS service_line \gset
SELECT pg_temp.p997_check((SELECT gross_wt=0 AND pieces=1 FROM sales.invoice_line WHERE id=:'service_line'), 'PW8 zero-weight service line behaviour unchanged');
-- Whole-line return of zero-piece loose metal: no qty column exists on credit_note_line; original FK carries it.
UPDATE sales.doc_series SET next_no=next_no+1 WHERE branch_id='00000000-0000-0000-0000-00000000b997' AND doc_type='credit_note' RETURNING next_no-1 AS seq \gset
SELECT pg_temp.p997_ins('sales.credit_note',:'cn_base'::jsonb||jsonb_build_object('invoice_id',:'live_inv','kind','sales_return','doc_seq',:seq,'doc_no','P997C000002',
 'refund_mode','store_credit','refund_amount',0,'store_credit_amount',1030,'balance_available',1030)) AS return_cn \gset
INSERT INTO sales.credit_note_line(tenant_id,credit_note_id,invoice_line_id,taxable_value,cgst,sgst,igst,line_total,stock_kind)
VALUES(platform.current_tenant(),:'return_cn',:'loose_line',1000,15,15,0,1030,'loose');
SELECT pg_temp.p997_error(format($q$INSERT INTO sales.credit_note_line(tenant_id,credit_note_id,invoice_line_id,taxable_value,cgst,sgst,igst,line_total,stock_kind)
 VALUES(platform.current_tenant(),%L,%L,1000,15,15,0,1030,'loose')$q$,:'return_cn',:'loose_line'),
 'PW9 zero-piece return still whole-line at most once','%duplicate key%');
SET LOCAL ROLE inventory_writer;
INSERT INTO inventory.stock_ledger(tenant_id,branch_id,item_id,purity_id,movement,direction,pieces,gross_wt,net_wt,fine_wt,source_module,source_type,source_id)
VALUES(platform.current_tenant(),'00000000-0000-0000-0000-00000000b997','00000000-0000-0000-0000-000000000902','00000000-0000-0000-0000-000000000022','sale',-1,0,2,2,1.832,'sales','invoice',:'live_inv'),
      (platform.current_tenant(),'00000000-0000-0000-0000-00000000b997','00000000-0000-0000-0000-000000000902','00000000-0000-0000-0000-000000000022','sales_return',1,0,2,2,1.832,'sales','credit_note',:'return_cn');
RESET ROLE;
RESET SESSION AUTHORIZATION;
SET LOCAL ROLE app_rw;
SELECT pg_temp.p997_check((SELECT n.stock_kind='loose' AND l.pieces=0 AND l.net_wt=2 FROM sales.credit_note_line n JOIN sales.invoice_line l ON l.tenant_id=n.tenant_id AND l.id=n.invoice_line_id WHERE n.credit_note_id=:'return_cn')
 AND (SELECT count(*)=2 AND sum(direction*pieces)=0 AND sum(direction*net_wt)=0 AND bool_and(tag_id IS NULL) FROM inventory.stock_ledger WHERE branch_id='00000000-0000-0000-0000-00000000b997')
 AND EXISTS(SELECT 1 FROM inventory.stock_ledger WHERE source_type='credit_note' AND source_id=:'return_cn' AND pieces=0 AND net_wt=2 AND direction=1),
 'PW10 credit note returns 0-piece loose line; restock has 0 pieces / +2g, invoice sale -2g; refs correct, weights reconcile');
SELECT pg_temp.p997_check(NOT EXISTS(SELECT 1 FROM reports.series_gaps WHERE branch_id='00000000-0000-0000-0000-00000000b997'),
 'PW11 no invoice/credit-note numbering gaps');
ROLLBACK;
SELECT pg_temp.p997_check(NOT EXISTS(SELECT 1 FROM platform.branch WHERE id='00000000-0000-0000-0000-00000000b997'), 'PU3 full 997 fixture rolled back');
