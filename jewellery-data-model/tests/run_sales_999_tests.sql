-- TEST CLUSTER ONLY. -v upgrade_998=1 probes populated 998 -> 999 inside the
-- upgrade-from-990 runner; 0 probes head. No fixtures or DDL survive ROLLBACK.
-- Covers NB-1 (pins NOT NULL + FK), NB-1a (template document type), NB-2 (19 Sales) and INF-1 (30 non-Sales).
\set ON_ERROR_STOP 1
\pset tuples_only on
\pset footer off
CREATE FUNCTION pg_temp.p999_check(ok boolean,label text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN IF ok THEN RETURN 'PASS  '||label; END IF; RAISE EXCEPTION 'FAIL  %',label; END $$;
CREATE FUNCTION pg_temp.p999_error(stmt text,label text,pattern text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
 BEGIN EXECUTE stmt;
 EXCEPTION WHEN others THEN
  IF SQLERRM LIKE pattern THEN RETURN 'PASS  '||label||' -> '||SQLERRM; END IF;
  RAISE EXCEPTION 'FAIL  % wrong error: %',label,SQLERRM;
 END;
 RAISE EXCEPTION 'FAIL  % unexpectedly succeeded',label;
END $$;
CREATE FUNCTION pg_temp.p999_ins(p jsonb) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE cols text; r uuid;
BEGIN
 SELECT string_agg(quote_ident(k),',') INTO cols FROM jsonb_object_keys(p) k;
 EXECUTE format('INSERT INTO sales.document_print(%s) SELECT %s FROM jsonb_populate_record(NULL::sales.document_print,$1) RETURNING id',cols,cols) INTO r USING p;
 RETURN r;
END $$;
BEGIN;
SET LOCAL SESSION AUTHORIZATION app_migrator;
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-000000000001',true),
 set_config('app.partner_id','',true),set_config('app.branch_scope','',true),
 set_config('app.user_id','00000000-0000-0000-0000-000000000a01',true) \g /dev/null
SELECT pg_temp.p999_check(NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user)
 AND (SELECT relforcerowsecurity FROM pg_class WHERE oid='sales.document_print'::regclass)
 AND (SELECT count(*)>=2 FROM platform.tenant), 'P999-1 owner non-superuser/no BYPASSRLS sees tenant directory; FORCE RLS stays on');
INSERT INTO platform.branch(tenant_id,id,company_id,code,name,bill_series_prefix,state_code)
VALUES(platform.current_tenant(),'00000000-0000-0000-0000-00000000b999','00000000-0000-0000-0000-00000000c001','P999','999 fixture','P999','33');
SET LOCAL ROLE sales_writer;
INSERT INTO sales.doc_series(tenant_id,branch_id,doc_type,fy,prefix)
VALUES(platform.current_tenant(),'00000000-0000-0000-0000-00000000b999','tax_invoice',platform.fy_of(current_date),'P999I');
UPDATE sales.doc_series SET next_no=next_no+1 WHERE branch_id='00000000-0000-0000-0000-00000000b999'
 RETURNING next_no-1 AS seq,fy \gset
INSERT INTO sales.invoice(tenant_id,branch_id,company_id,fy,doc_seq,doc_no,customer_snapshot,place_of_supply,gst_type,rate_snapshot,
 gross_value,taxable_value,cgst,sgst,invoice_total,net_payable,paid_amount,balance_due,created_by,
 salesperson_id,making_gst_treatment,round_off_to,pan_required,pan_on_file)
VALUES(platform.current_tenant(),'00000000-0000-0000-0000-00000000b999','00000000-0000-0000-0000-00000000c001',:'fy',:seq,'P999I000001','{}','33','intra','{}',
 1000,1000,15,15,1030,1030,1030,0,platform.current_user_id(),'00000000-0000-0000-0000-0000000057a0','composite',1,false,false)
RETURNING id AS inv \gset
SELECT jsonb_build_object('tenant_id',platform.current_tenant(),'branch_id','00000000-0000-0000-0000-00000000b999',
 'doc_type','estimate','doc_id',gen_random_uuid(),'print_no',1,'copy','original','paper','A4','printed_by',platform.current_user_id(),
 'template_id','01a1c455-29fa-7963-88e9-d3cf6e2a8240','template_version',1)::text AS base \gset
\if :upgrade_998
SELECT pg_temp.p999_check((SELECT count(*)=19 FROM pg_constraint WHERE connamespace='sales'::regnamespace AND NOT convalidated)
 AND (SELECT count(*)=30 FROM pg_constraint WHERE connamespace IN('masters'::regnamespace,'inventory'::regnamespace) AND NOT convalidated
       AND conname IN('stone_standard_cent_band','diamond_rate_period','diamond_rate_rates_nonneg','diamond_rate_has_key','diamond_rate_stone_fk','diamond_rate_shape_fk','diamond_rate_clarity_fk','diamond_rate_colour_fk','diamond_rate_cut_fk','diamond_rate_vendor_fk','var_metal_fk','var_sub_item_fk','var_one_mc_basis','var_one_wastage_basis','var_nonneg','var_weight_band','tag_pieces_check','tag_stone_le_gross','lot_line_tagged_check','stock_transfer_dispatched_chk','stock_transfer_received_chk','stock_transfer_approved_chk','stock_transfer_cancelled_chk','stock_transfer_received_after_dispatch','stock_transfer_requested_by_fk','stock_transfer_approved_by_fk','stock_transfer_received_by_fk','stock_transfer_line_received_chk','stock_transfer_line_what','stock_take_closed_chk'))
 AND (SELECT count(*)=49 FROM pg_constraint WHERE NOT convalidated),
 'P999-U1 998 baseline has the 19 Sales + 30 non-Sales NOT VALID constraints (49 in the whole catalogue)');
RESET ROLE;
-- Template fixtures span partner + tenant scope, so they are written by the test superuser (scope_write
-- would require a partner context for the partner rows; partner_no_tenant_templates then forbids the tenant row).
RESET SESSION AUTHORIZATION;
-- Deliberately use different versions: scope precedence must outrank version.
INSERT INTO branding.print_template(id,scope,partner_id,tenant_id,doc_type,version,body_key,is_active) VALUES
 ('00000000-0000-4000-8000-000000009991','partner','00000000-0000-0000-0000-0000000000a1',NULL,'estimate',7,'999/partner-estimate',true),
 ('00000000-0000-4000-8000-000000009992','tenant',NULL,platform.current_tenant(),'estimate',2,'999/tenant-estimate',true),
 ('00000000-0000-4000-8000-000000009993','partner','00000000-0000-0000-0000-0000000000a1',NULL,'credit_note',9,'999/partner-cn',true);
-- Explicit inactive 998 fallback must remain usable when no active receipt row exists.
UPDATE branding.print_template SET is_active=false WHERE scope='platform' AND doc_type='receipt';
-- sales_writer has no SELECT on branding.print_template: read the seeded inactive tenant invoice v2 here.
SELECT id AS inactive_id FROM branding.print_template WHERE scope='tenant' AND doc_type='invoice' AND version=2 \gset
SET LOCAL SESSION AUTHORIZATION app_migrator;
SET LOCAL ROLE sales_writer;
SELECT pg_temp.p999_ins(:'base'::jsonb||'{"template_id":null,"template_version":null}'::jsonb) AS est_print \gset
SELECT pg_temp.p999_ins(:'base'::jsonb||jsonb_build_object('doc_type','invoice','doc_id',:'inv','template_id',NULL,'template_version',NULL)) AS inv_print \gset
SELECT pg_temp.p999_ins(:'base'::jsonb||jsonb_build_object('doc_type','credit_note','doc_id',gen_random_uuid(),'template_id',NULL,'template_version',NULL)) AS cn_print \gset
SELECT pg_temp.p999_ins(:'base'::jsonb||jsonb_build_object('doc_type','payment_receipt','doc_id',gen_random_uuid(),'template_id',NULL,'template_version',NULL)) AS receipt_print \gset
SELECT pg_temp.p999_ins(:'base'::jsonb||jsonb_build_object('doc_type','invoice','doc_id',:'inv','print_no',2,'copy','duplicate','reprint_reason','Partial pin fixture',
 'template_id',:'inactive_id','template_version',NULL)) AS partial_print \gset
RESET ROLE;
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-000000000002',true) \g /dev/null
INSERT INTO platform.app_user(tenant_id,id,name,phone)
VALUES(platform.current_tenant(),'00000000-0000-0000-0000-000000009999','999 test user','9000000999');
SELECT set_config('app.user_id','00000000-0000-0000-0000-000000009999',true) \g /dev/null
SET LOCAL ROLE sales_writer;
SELECT pg_temp.p999_ins(:'base'::jsonb||jsonb_build_object('tenant_id',platform.current_tenant(),'branch_id','00000000-0000-0000-0000-00000000b002',
 'printed_by',platform.current_user_id(),'doc_type','payment_receipt','doc_id',gen_random_uuid(),'template_id',NULL,'template_version',NULL)) AS other_print \gset
RESET ROLE;
RESET SESSION AUTHORIZATION;
CREATE TEMP TABLE p999_before ON COMMIT DROP AS SELECT id,to_jsonb(p)-'template_id'-'template_version' data FROM sales.document_print p WHERE template_version IS NULL;
SELECT pg_temp.p999_check((SELECT count(*)=6 FROM p999_before),'P999-U2 six legacy NULL/partial pins, all four document types plus second tenant');
SAVEPOINT unavailable;
DELETE FROM branding.print_template WHERE id='01a1c455-29fa-7811-b4b1-95efbd5b9ea5';
SET LOCAL SESSION AUTHORIZATION app_migrator;
SELECT pg_temp.p999_error(:'migration_sql','P999-U3 missing effective/fallback template aborts atomically','999: cannot backfill print pin%');
RESET SESSION AUTHORIZATION;
SELECT pg_temp.p999_check((SELECT count(*)=6 FROM sales.document_print WHERE id IN(SELECT id FROM p999_before) AND template_version IS NULL)
 AND (SELECT count(*)=49 FROM pg_constraint WHERE NOT convalidated),
 'P999-U4 failed backfill leaves every old pin and all 49 validation flags unchanged');
ROLLBACK TO unavailable;
SAVEPOINT partial_conflict;
-- est_print belongs to tenant 1; the house audit chain requires the row's tenant context (context is tenant 2 here).
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-000000000001',true) \g /dev/null
UPDATE sales.document_print SET template_version=999 WHERE id=:'est_print';
SET LOCAL SESSION AUTHORIZATION app_migrator;
SELECT pg_temp.p999_error(:'migration_sql','P999-U5 conflicting partial version aborts; no silent replacement','999: cannot backfill print pin%');
RESET SESSION AUTHORIZATION;
ROLLBACK TO partial_conflict;
SAVEPOINT legacy_bad;
SELECT pg_get_constraintdef(oid) AS stock_def FROM pg_constraint WHERE conrelid='sales.invoice_line'::regclass AND conname='invoice_line_stock_check' \gset
SELECT pg_get_constraintdef(oid) AS total_def FROM pg_constraint WHERE conrelid='sales.invoice_line'::regclass AND conname='invoice_line_total_sum_check' \gset
SELECT pg_get_constraintdef(oid) AS item_def FROM pg_constraint WHERE conrelid='sales.invoice_line'::regclass AND conname='invoice_line_item_fk' \gset
SET LOCAL SESSION AUTHORIZATION app_migrator;
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-000000000001',true) \g /dev/null
ALTER TABLE sales.invoice_line DROP CONSTRAINT invoice_line_stock_check, DROP CONSTRAINT invoice_line_total_sum_check, DROP CONSTRAINT invoice_line_item_fk;
SET LOCAL ROLE sales_writer;
INSERT INTO sales.invoice_line(tenant_id,invoice_id,line_no,item_id,description,purity_code,fineness,hsn,gross_wt,net_wt,rate_id,rate_per_g,
 metal_value,mc_type,mc_value,mc_amount,taxable_value,tax_rule_id,tax_rate,hsn_sac_applied,composite_supply,cgst,sgst,line_total)
VALUES(platform.current_tenant(),:'inv',1,'00000000-0000-0000-0000-00000000dead','Invalid legacy fixture','22K',916,'7113',1,1,
 (SELECT id FROM rates.metal_rate WHERE kind='sale' LIMIT 1),1000,1000,'flat',0,0,1000,
 (SELECT id FROM masters.tax_rule WHERE scope='tenant' AND code='GOLD_JEWELLERY'),3,'7113',false,15,15,999);
RESET ROLE;
ALTER TABLE sales.invoice_line ADD CONSTRAINT invoice_line_stock_check :stock_def,
 ADD CONSTRAINT invoice_line_total_sum_check :total_def, ADD CONSTRAINT invoice_line_item_fk :item_def;
SELECT pg_temp.p999_error(:'migration_sql','P999-U6 bad historical CHECK and FK reported with tenant/count/IDs; no financial rewrite',
 '999: legacy violations:%invoice_line_item_fk=1%invoice_line_stock_check=1%invoice_line_total_sum_check=1%');
RESET SESSION AUTHORIZATION;
SELECT pg_temp.p999_check((SELECT count(*)=6 FROM sales.document_print WHERE id IN(SELECT id FROM p999_before) AND template_version IS NULL),
 'P999-U7 financial audit failure rolls back all earlier print-pin remediation');
ROLLBACK TO legacy_bad;
SAVEPOINT unknown_pin;
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-000000000001',true) \g /dev/null
UPDATE sales.document_print SET template_id='00000000-0000-4000-8000-00000000dead',template_version=1 WHERE id=:'inv_print';
SET LOCAL SESSION AUTHORIZATION app_migrator;
SELECT pg_temp.p999_error(:'migration_sql','P999-U13 legacy complete pin to an unknown template version reported with tenant/count/IDs',
 '999: legacy violations:%sales.document_print.document_print_template_fk=1%');
RESET SESSION AUTHORIZATION;
SELECT pg_temp.p999_check(NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname IN('document_print_template_fk','print_template_id_version_doc_type_uq','print_template_id_version_uq'))
 AND NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='sales.document_print'::regclass AND attname='template_doc_type' AND NOT attisdropped)
 AND (SELECT count(*)=5 FROM sales.document_print WHERE id IN(SELECT id FROM p999_before) AND id<>:'inv_print' AND template_version IS NULL)
 AND (SELECT template_id='00000000-0000-4000-8000-00000000dead' FROM sales.document_print WHERE id=:'inv_print'),
 'P999-U14 template-FK audit failure leaves no column/UNIQUE/FK and no pin repair behind');
ROLLBACK TO unknown_pin;
SAVEPOINT type_mismatch;
-- NB-1a legacy complete pin: an ESTIMATE print pinned to the platform INVOICE template v1 (998 has no FK, so it exists).
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-000000000001',true) \g /dev/null
UPDATE sales.document_print SET template_id='01a1c455-29fa-769b-84f9-377a9bcdab46',template_version=1 WHERE id=:'est_print';
SET LOCAL SESSION AUTHORIZATION app_migrator;
SELECT pg_temp.p999_error(:'migration_sql','P999-U16 legacy estimate print pinned to an invoice template reported with tenant/count/ID',
 '999: legacy violations: tenant=sri-lakshmi sales.document_print.template_doc_type_mismatch=1 ids={'||:'est_print'||'}%');
RESET SESSION AUTHORIZATION;
SELECT pg_temp.p999_check(NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname IN('document_print_template_fk','print_template_id_version_doc_type_uq'))
 AND NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='sales.document_print'::regclass AND attname='template_doc_type' AND NOT attisdropped)
 AND (SELECT count(*)=5 FROM sales.document_print WHERE id IN(SELECT id FROM p999_before) AND id<>:'est_print' AND template_version IS NULL)
 AND (SELECT template_id='01a1c455-29fa-769b-84f9-377a9bcdab46' AND template_version=1 FROM sales.document_print WHERE id=:'est_print')
 AND (SELECT count(*)=49 FROM pg_constraint WHERE NOT convalidated),
 'P999-U17 mismatched-type abort changes nothing: no column/UNIQUE/FK, mismatched pin kept, other pins still NULL, 49 flags unchanged');
ROLLBACK TO type_mismatch;
SAVEPOINT partial_wrong_type;
-- Legacy partial pin whose ID names a template of ANOTHER type: the backfill must not complete it across types.
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-000000000001',true) \g /dev/null
UPDATE sales.document_print SET template_id='01a1c455-29fa-7963-88e9-d3cf6e2a8240' WHERE id=:'partial_print';
SET LOCAL SESSION AUTHORIZATION app_migrator;
SELECT pg_temp.p999_error(:'migration_sql','P999-U18 partial invoice pin naming the estimate template aborts; backfill never crosses document types',
 '999: cannot backfill print pin tenant=sri-lakshmi row='||:'partial_print'||' type=invoice old=(01a1c455-29fa-7963-88e9-d3cf6e2a8240,<NULL>)%');
RESET SESSION AUTHORIZATION;
ROLLBACK TO partial_wrong_type;
SAVEPOINT nonsales_bad;
-- INF-1: violating legacy rows outside Sales (owner drops the check/FK, writes the row, re-adds it NOT VALID: same definition).
SET LOCAL SESSION AUTHORIZATION app_migrator;
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-000000000001',true),
 set_config('app.user_id','00000000-0000-0000-0000-000000000a01',true) \g /dev/null
SELECT pg_get_constraintdef(oid) AS vwb_def FROM pg_constraint WHERE conrelid='masters.value_addition_rule'::regclass AND conname='var_weight_band' \gset
SELECT pg_get_constraintdef(oid) AS vmf_def FROM pg_constraint WHERE conrelid='masters.value_addition_rule'::regclass AND conname='var_metal_fk' \gset
SELECT pg_get_constraintdef(oid) AS tsg_def FROM pg_constraint WHERE conrelid='inventory.tag'::regclass AND conname='tag_stone_le_gross' \gset
ALTER TABLE masters.value_addition_rule DROP CONSTRAINT var_weight_band, DROP CONSTRAINT var_metal_fk;
ALTER TABLE inventory.tag DROP CONSTRAINT tag_stone_le_gross;
INSERT INTO masters.value_addition_rule(tenant_id,id,scope,metal_id,weight_from,weight_to)
VALUES(platform.current_tenant(),'00000000-0000-4000-8000-00000000999a','customer','00000000-0000-0000-0000-00000000dead',5,1);
UPDATE inventory.tag SET stone_wt=gross_wt+1 WHERE id='00000000-0000-0000-0000-00000000f002';
ALTER TABLE masters.value_addition_rule ADD CONSTRAINT var_weight_band :vwb_def, ADD CONSTRAINT var_metal_fk :vmf_def;
ALTER TABLE inventory.tag ADD CONSTRAINT tag_stone_le_gross :tsg_def;
SELECT pg_temp.p999_error(:'migration_sql','P999-U19 non-Sales legacy CHECK + FK violations (inventory, masters) reported with tenant/count/IDs',
 '999: legacy violations: tenant=sri-lakshmi inventory.tag.tag_stone_le_gross=1 ids={00000000-0000-0000-0000-00000000f002}; tenant=sri-lakshmi masters.value_addition_rule.var_metal_fk=1 ids={00000000-0000-4000-8000-00000000999a}; tenant=sri-lakshmi masters.value_addition_rule.var_weight_band=1 ids={00000000-0000-4000-8000-00000000999a};%');
RESET SESSION AUTHORIZATION;
SELECT pg_temp.p999_check((SELECT count(*)=49 FROM pg_constraint WHERE NOT convalidated)
 AND (SELECT count(*)=6 FROM sales.document_print WHERE id IN(SELECT id FROM p999_before) AND template_version IS NULL)
 AND NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname IN('document_print_template_fk','print_template_id_version_doc_type_uq'))
 AND (SELECT stone_wt>gross_wt FROM inventory.tag WHERE id='00000000-0000-0000-0000-00000000f002')
 AND (SELECT count(*)=1 FROM masters.value_addition_rule WHERE id='00000000-0000-4000-8000-00000000999a'),
 'P999-U20 non-Sales audit failure validates nothing, repairs no pin and rewrites no stock/master row');
ROLLBACK TO nonsales_bad;
SET LOCAL SESSION AUTHORIZATION app_migrator;
\ir ../migrations/999_sales_print_pins_validate_legacy.sql
RESET SESSION AUTHORIZATION;
SELECT pg_temp.p999_check((SELECT count(*)=6 AND bool_and(to_jsonb(p)-'template_id'-'template_version'-'template_doc_type'=b.data) FROM p999_before b JOIN sales.document_print p USING(id)),
 'P999-U8 backfill preserves every non-pin print field (timestamp/document/copy/actor)');
SELECT pg_temp.p999_check((SELECT template_id='00000000-0000-4000-8000-000000009992' AND template_version=2 FROM sales.document_print WHERE id=:'est_print')
 AND (SELECT template_id='00000000-0000-4000-8000-000000009993' AND template_version=9 FROM sales.document_print WHERE id=:'cn_print'),
 'P999-U9 tenant > partner > platform independent of version');
SELECT pg_temp.p999_check((SELECT template_id=:'inactive_id' AND template_version=2 FROM sales.document_print WHERE id=:'partial_print')
 AND (SELECT template_id=(SELECT id FROM branding.print_template WHERE scope='tenant' AND tenant_id='00000000-0000-0000-0000-000000000001' AND doc_type='invoice' AND version=1) FROM sales.document_print WHERE id=:'inv_print'),
 'P999-U10 complete missing version from exact inactive ID; NULL invoice pin uses active tenant template');
SELECT pg_temp.p999_check((SELECT count(*)=2 AND bool_and(template_id='01a1c455-29fa-7811-b4b1-95efbd5b9ea5' AND template_version=1)
 FROM sales.document_print WHERE id IN(:'receipt_print',:'other_print')),
 'P999-U11 payment_receipt -> receipt mapping; fixed inactive v1 fallback; second tenant visible to migrator loop');
SELECT pg_temp.p999_check((SELECT count(*)=6 FROM platform.audit_event WHERE table_name='sales.document_print' AND action='UPDATE' AND row_id IN(SELECT id FROM p999_before) AND user_id IS NULL),
 'P999-U12 six house-audited backfills, no impersonated user');
SELECT pg_temp.p999_check((SELECT count(*)=6 FROM p999_before b JOIN sales.document_print p USING(id)
   JOIN branding.print_template x ON x.id=p.template_id AND x.version=p.template_version AND x.doc_type=p.template_doc_type)
 AND (SELECT count(*)=2 FROM sales.document_print WHERE id IN(:'receipt_print',:'other_print') AND template_doc_type='receipt')
 AND (SELECT convalidated FROM pg_constraint WHERE conrelid='sales.document_print'::regclass AND conname='document_print_template_fk'),
 'P999-U15 every backfilled pin satisfies the validated (template_id, template_version, template_doc_type) FK; payment_receipt -> receipt');
SELECT pg_temp.p999_check((SELECT count(*)=0 FROM pg_constraint WHERE NOT convalidated),
 'P999-U21 upgraded populated DB: 19 Sales + 30 non-Sales constraints validated, 0 NOT VALID left');
\endif
RESET ROLE;
RESET SESSION AUTHORIZATION;
SELECT pg_temp.p999_check((SELECT count(*)=2 AND bool_and(attnotnull) FROM pg_attribute WHERE attrelid='sales.document_print'::regclass AND attname IN('template_id','template_version')),
 'P999-2 both print pin columns physically NOT NULL');
SELECT pg_temp.p999_check((SELECT count(*)=0 FROM pg_constraint WHERE connamespace='sales'::regnamespace AND NOT convalidated),
 'P999-3 all 19 S2/S14/S23 legacy constraints convalidated=true (no Sales NOT VALID debt)');
SELECT pg_temp.p999_check((SELECT count(*)=30 FROM pg_constraint WHERE connamespace IN('masters'::regnamespace,'inventory'::regnamespace) AND convalidated
       AND conname IN('stone_standard_cent_band','diamond_rate_period','diamond_rate_rates_nonneg','diamond_rate_has_key','diamond_rate_stone_fk','diamond_rate_shape_fk','diamond_rate_clarity_fk','diamond_rate_colour_fk','diamond_rate_cut_fk','diamond_rate_vendor_fk','var_metal_fk','var_sub_item_fk','var_one_mc_basis','var_one_wastage_basis','var_nonneg','var_weight_band','tag_pieces_check','tag_stone_le_gross','lot_line_tagged_check','stock_transfer_dispatched_chk','stock_transfer_received_chk','stock_transfer_approved_chk','stock_transfer_cancelled_chk','stock_transfer_received_after_dispatch','stock_transfer_requested_by_fk','stock_transfer_approved_by_fk','stock_transfer_received_by_fk','stock_transfer_line_received_chk','stock_transfer_line_what','stock_take_closed_chk'))
 AND (SELECT count(*)=0 FROM pg_constraint WHERE NOT convalidated),
 'P999-18 all 30 non-Sales constraints (977/978 masters, 987/988 inventory) convalidated=true; 0 NOT VALID in the whole catalogue (INF-1)');
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-000000000001',true),
 set_config('app.user_id','00000000-0000-0000-0000-000000000a01',true),set_config('app.partner_id','',true),set_config('app.branch_scope','',true) \g /dev/null
-- Inactive tenant + partner estimate versions (superuser fixture; sales_writer itself has no SELECT on templates).
INSERT INTO branding.print_template(id,scope,partner_id,tenant_id,doc_type,version,body_key,is_active) VALUES
 ('00000000-0000-4000-8000-000000009994','partner','00000000-0000-0000-0000-0000000000a1',NULL,'estimate',6,'999/partner-estimate-v6',false),
 ('00000000-0000-4000-8000-000000009995','tenant',NULL,'00000000-0000-0000-0000-000000000001','estimate',5,'999/tenant-estimate-v5',false);
SET LOCAL ROLE sales_writer;
SELECT pg_temp.p999_error(format('SELECT pg_temp.p999_ins(%L::jsonb)',(:'base'::jsonb||'{"template_id":null}'::jsonb)::text),
 'P999-4 module writer NULL ID rejected','%null value in column "template_id"%');
SELECT pg_temp.p999_error(format('SELECT pg_temp.p999_ins(%L::jsonb)',(:'base'::jsonb||'{"template_version":null}'::jsonb)::text),
 'P999-5 module writer NULL version rejected','%null value in column "template_version"%');
SELECT pg_temp.p999_error(format('SELECT pg_temp.p999_ins(%L::jsonb)',(:'base'::jsonb||'{"template_version":0}'::jsonb)::text),
 'P999-6 module writer zero version rejected','%document_print_template_version_check%');
SELECT pg_temp.p999_error(format('SELECT pg_temp.p999_ins(%L::jsonb)',(:'base'::jsonb||'{"template_version":-1}'::jsonb)::text),
 'P999-7 module writer negative version rejected','%document_print_template_version_check%');
SELECT pg_temp.p999_check(pg_temp.p999_ins(:'base'::jsonb||jsonb_build_object('doc_id',gen_random_uuid())) IS NOT NULL,
 'P999-8 valid exact non-null positive pin accepted');
SELECT pg_temp.p999_error(format('SELECT pg_temp.p999_ins(%L::jsonb)',(:'base'::jsonb||jsonb_build_object('doc_id',gen_random_uuid(),'template_id','00000000-0000-4000-8000-00000000dead'))::text),
 'P999-13 raw insert with unknown template uuid rejected','%document_print_template_fk%');
SELECT pg_temp.p999_error(format('SELECT pg_temp.p999_ins(%L::jsonb)',(:'base'::jsonb||jsonb_build_object('doc_id',gen_random_uuid(),'template_version',2))::text),
 'P999-14 raw insert with unknown version of a real template rejected','%document_print_template_fk%');
SELECT pg_temp.p999_check(
 pg_temp.p999_ins(:'base'::jsonb||jsonb_build_object('doc_id',gen_random_uuid(),'template_id','00000000-0000-4000-8000-000000009995','template_version',5)) IS NOT NULL
 AND pg_temp.p999_ins(:'base'::jsonb||jsonb_build_object('doc_id',gen_random_uuid(),'template_id','00000000-0000-4000-8000-000000009994','template_version',6)) IS NOT NULL
 AND pg_temp.p999_ins(:'base'::jsonb||jsonb_build_object('doc_id',gen_random_uuid(),'template_id','01a1c455-29fa-7963-88e9-d3cf6e2a8240','template_version',1)) IS NOT NULL,
 'P999-15 tenant writer pins valid tenant, partner and platform template versions (inactive allowed; FK check bypasses RLS)');
SELECT pg_temp.p999_error(format('SELECT pg_temp.p999_ins(%L::jsonb)',(:'base'::jsonb||jsonb_build_object('doc_id',gen_random_uuid(),'template_id','01a1c455-29fa-769b-84f9-377a9bcdab46'))::text),
 'P999-19 raw insert: ESTIMATE print pinned to the platform INVOICE template v1 rejected (NB-1a)','%document_print_template_fk%');
SELECT pg_temp.p999_check(
 pg_temp.p999_ins(:'base'::jsonb||jsonb_build_object('doc_id',gen_random_uuid())) IS NOT NULL
 AND pg_temp.p999_ins(:'base'::jsonb||jsonb_build_object('doc_type','invoice','doc_id',:'inv','print_no',7,'copy','duplicate','reprint_reason','Type match fixture',
       'template_id','01a1c455-29fa-769b-84f9-377a9bcdab46')) IS NOT NULL
 AND pg_temp.p999_ins(:'base'::jsonb||jsonb_build_object('doc_type','credit_note','doc_id',gen_random_uuid(),'template_id','01a1c455-29fa-7856-b4ed-a3710fd91ec1')) IS NOT NULL
 AND pg_temp.p999_ins(:'base'::jsonb||jsonb_build_object('doc_type','payment_receipt','doc_id',gen_random_uuid(),'template_id','01a1c455-29fa-7811-b4b1-95efbd5b9ea5')) IS NOT NULL,
 'P999-20 raw inserts with the matching template type pass for all 4 document types (estimate, invoice, credit_note, payment_receipt -> receipt)');
SELECT pg_temp.p999_error(format('SELECT pg_temp.p999_ins(%L::jsonb)',(:'base'::jsonb||jsonb_build_object('doc_type','payment_receipt','doc_id',gen_random_uuid(),
   'template_id','01a1c455-29fa-769b-84f9-377a9bcdab46'))::text),
 'P999-21 raw insert: payment_receipt print pinned to the invoice template rejected','%document_print_template_fk%');
SELECT pg_temp.p999_error(format('SELECT pg_temp.p999_ins(%L::jsonb)',(:'base'::jsonb||jsonb_build_object('doc_type','credit_note','doc_id',gen_random_uuid(),
   'template_id','01a1c455-29fa-7811-b4b1-95efbd5b9ea5'))::text),
 'P999-22 raw insert: credit_note print pinned to the receipt template rejected','%document_print_template_fk%');
SELECT pg_temp.p999_error(:'migration_sql','P999-9 non-owner migration refuses before changing data','999: run as owner app_migrator%');
RESET ROLE;
RESET SESSION AUTHORIZATION;
SELECT pg_temp.p999_error(format('SELECT pg_temp.p999_ins(%L::jsonb)',(:'base'::jsonb||jsonb_build_object('doc_id',gen_random_uuid(),'template_doc_type','invoice'))::text),
 'P999-23 template_doc_type is generated: not even the superuser can write it','%template_doc_type%');
SELECT pg_temp.p999_check(NOT has_column_privilege('sales_writer','sales.document_print','template_doc_type','INSERT')
 AND has_column_privilege('sales_writer','sales.document_print','template_doc_type','SELECT'),
 'P999-24 sales_writer reads but has no INSERT grant on the generated template_doc_type');
SELECT pg_temp.p999_error($d$DELETE FROM branding.print_template WHERE id='00000000-0000-4000-8000-000000009995'$d$,
 'P999-16 a template version referenced by a print cannot be deleted','%document_print_template_fk%');
SELECT pg_temp.p999_error($d$UPDATE branding.print_template SET doc_type='invoice' WHERE id='00000000-0000-4000-8000-000000009995'$d$,
 'P999-25 a referenced template version cannot change its document type (ON UPDATE RESTRICT)','%document_print_template_fk%');
SELECT pg_temp.p999_check((SELECT convalidated AND confdeltype='r' AND confupdtype='r' AND confrelid='branding.print_template'::regclass
   AND conkey::int[]=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='sales.document_print'::regclass AND attname='template_id'),
                         (SELECT attnum FROM pg_attribute WHERE attrelid='sales.document_print'::regclass AND attname='template_version'),
                         (SELECT attnum FROM pg_attribute WHERE attrelid='sales.document_print'::regclass AND attname='template_doc_type')]::int[]
   AND confkey::int[]=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='branding.print_template'::regclass AND attname='id'),
                         (SELECT attnum FROM pg_attribute WHERE attrelid='branding.print_template'::regclass AND attname='version'),
                         (SELECT attnum FROM pg_attribute WHERE attrelid='branding.print_template'::regclass AND attname='doc_type')]::int[]
   FROM pg_constraint WHERE conrelid='sales.document_print'::regclass AND conname='document_print_template_fk')
 AND (SELECT count(*)=1 FROM pg_constraint WHERE conrelid='sales.document_print'::regclass AND confrelid='branding.print_template'::regclass AND contype='f')
 AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='branding.print_template'::regclass AND conname='print_template_id_version_doc_type_uq' AND contype='u')
 AND NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='branding.print_template'::regclass AND conname='print_template_id_version_uq')
 AND (SELECT attgenerated='s' AND pg_get_expr(d.adbin,d.adrelid) LIKE '%payment_receipt%receipt%'
        FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
       WHERE a.attrelid='sales.document_print'::regclass AND a.attname='template_doc_type')
 AND to_regclass('sales.document_print_template_idx') IS NOT NULL,
 'P999-17 composite FK (template_id, template_version, template_doc_type) -> print_template(id, version, doc_type) validated, RESTRICT; UNIQUE(id,version,doc_type); superseded 2-column UNIQUE absent; stored generated mapping; index present');
CREATE TEMP TABLE p999_rerun ON COMMIT DROP AS SELECT id,to_jsonb(p) data FROM sales.document_print p;
SELECT count(*) AS audit_before FROM platform.audit_event \gset
SET LOCAL SESSION AUTHORIZATION app_migrator;
\ir ../migrations/999_sales_print_pins_validate_legacy.sql
RESET SESSION AUTHORIZATION;
SELECT pg_temp.p999_check(NOT EXISTS(SELECT 1 FROM p999_rerun b JOIN sales.document_print p USING(id) WHERE to_jsonb(p)<>b.data)
 AND (SELECT count(*)=:audit_before FROM platform.audit_event), 'P999-10 rerun idempotent: print bytes/audit unchanged');
SELECT pg_temp.p999_check(current_setting('app.tenant_id')='00000000-0000-0000-0000-000000000001'
 AND current_setting('app.user_id')='00000000-0000-0000-0000-000000000a01'
 AND (SELECT relforcerowsecurity AND relrowsecurity FROM pg_class WHERE oid='sales.document_print'::regclass),
 'P999-11 caller context restored and forced RLS never disabled');
ROLLBACK;
SELECT pg_temp.p999_check(NOT EXISTS(SELECT 1 FROM platform.branch WHERE id='00000000-0000-0000-0000-00000000b999'),'P999-12 entire fixture/migration probe rolled back');
