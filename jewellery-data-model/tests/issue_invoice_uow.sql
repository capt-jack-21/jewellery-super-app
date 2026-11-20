-- Reference of what the NestJS sales module does in ONE transaction (pricing computed in the app).
-- Inputs (psql vars): :tag  (tag uuid or empty for a non-tag line)
BEGIN;
SET LOCAL ROLE sales_writer;
INSERT INTO sales.doc_series(tenant_id, branch_id, doc_type, fy, prefix)
VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', 'tax_invoice', platform.fy_of(current_date),
        'CBE/' || replace(substr(platform.fy_of(current_date), 3), '-', '') || '/') ON CONFLICT DO NOTHING;
UPDATE sales.doc_series SET next_no = next_no + 1
 WHERE tenant_id = platform.current_tenant() AND branch_id = '00000000-0000-0000-0000-00000000b001'
   AND doc_type = 'tax_invoice' AND fy = platform.fy_of(current_date)
RETURNING next_no - 1 AS seq, prefix, fy \gset
SELECT id AS rule_id FROM masters.tax_rule WHERE scope = 'tenant' AND code = 'GOLD_JEWELLERY' \gset
INSERT INTO sales.invoice (tenant_id, branch_id, company_id, fy, doc_seq, doc_no, doc_date, customer_snapshot, place_of_supply,
   gst_type, rate_snapshot, gross_value, taxable_value, cgst, sgst, round_off, invoice_total, net_payable, paid_amount, balance_due, created_by,
   salesperson_id, making_gst_treatment, round_off_to, pan_required, pan_on_file, cash_amount)
VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-00000000c001', :'fy', :seq,
   :'prefix' || lpad(:'seq', 6, '0'), current_date, '{"name":"Cash customer"}', '33', 'intra', '{"22K":7000}',
   81615, 81615, 1224.23, 1224.22, -0.45, 84063, 84063, 84063, 0, platform.current_user_id(),
   '00000000-0000-0000-0000-0000000057a0', 'composite', 1.00, false, false, 84063)
RETURNING id AS inv_id \gset
INSERT INTO sales.invoice_line (tenant_id, invoice_id, line_no, tag_id, item_id, purity_id, description, purity_code, fineness, hsn, huid,
   gross_wt, stone_wt, net_wt, rate_id, rate_per_g, wastage_pct, wastage_wt, metal_value, mc_type, mc_value, mc_amount,
   stone_amount, huid_charge, taxable_value, tax_rule_id, tax_rate, hsn_sac_applied, composite_supply, cgst, sgst, line_total,
   stock_kind, chargeable_wt, gross_value)
SELECT platform.current_tenant(), :'inv_id', 1, nullif(:'tag','')::uuid, '00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000022', 'Gold Ring', '22K', 916, '7113',
   (SELECT huid FROM inventory.tag WHERE id = nullif(:'tag','')::uuid),
   10, 0.5, 9.5, (SELECT id FROM rates.metal_rate WHERE kind = 'sale' LIMIT 1), 7000, 8, 0.76, 71820, 'per_gram', 500, 4750,
   5000, 45, 81615, :'rule_id', 3, '7113', false, 1224.23, 1224.22, 84063.45,
   CASE WHEN :'tag' = '' THEN 'loose' ELSE 'tag' END, 10.26, 81615
RETURNING id AS line_id \gset
INSERT INTO sales.invoice_line_tax (tenant_id, invoice_line_id, component, tax_rule_id, hsn_sac, composite_supply, taxable_value,
   rate, cgst_rate, sgst_rate, igst_rate, cgst, sgst)
VALUES (platform.current_tenant(), :'line_id', 'metal', :'rule_id', '7113', false, 76865, 3, 1.5, 1.5, 3, 1152.98, 1152.97),
       (platform.current_tenant(), :'line_id', 'making', (SELECT id FROM masters.tax_rule WHERE scope='tenant' AND code='MAKING_COMPOSITE'),
        '7113', true, 4750, 3, 1.5, 1.5, 3, 71.25, 71.25);
INSERT INTO sales.invoice_payment (tenant_id, invoice_id, line_no, mode, amount) VALUES (platform.current_tenant(), :'inv_id', 1, 'cash', 84063);
-- stock movement through the inventory module role, same transaction
SET LOCAL ROLE inventory_writer;
UPDATE inventory.tag SET status = 'sold' WHERE id = nullif(:'tag','')::uuid;
INSERT INTO inventory.stock_ledger (tenant_id, branch_id, tag_id, item_id, purity_id, movement, direction, pieces, gross_wt, net_wt, fine_wt,
                                    source_module, source_type, source_id)
VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', nullif(:'tag','')::uuid, '00000000-0000-0000-0000-000000000901',
        '00000000-0000-0000-0000-000000000022', 'sale', -1, 1, 10, 9.5, 8.702, 'sales', 'invoice', :'inv_id');
COMMIT;
