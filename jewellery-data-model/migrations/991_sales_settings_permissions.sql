-- 991_sales_settings_permissions.sql — Sales scope S1–S23 (docs/freeze/sales-freeze.md; contract 0.9.0 schema needs from Ironhide),
--   part 1 of 3: typed per-shop sales settings, the new sales permission codes, the platform 0% GST tax rule.
-- TEST DB ONLY until Adithya approves a dev redeploy (via Ultra Magnus). Builds on 100_sales.sql; 000–990 untouched.
-- No new DB functions or triggers beyond the house aa_version (platform.bump_version) and zz_audit (platform.enable_audit).

-- ---------- 1. sales.shop_setting: one row per shop (no row = these defaults) ----------
-- Single source for the app's sales settings. Supersedes (left in place, no data change, not read by 0.9.0):
--   masters.sales_policy (making GST / old gold / return window), platform.setting 'sales.pan_required_above' and 'invoice.rounding'.
-- Bill round-off stays in masters.gst_config.round_off_to (effective-dated, default 1.00 = nearest rupee) and is snapshotted per bill.
-- Every value used on a bill is ALSO snapshotted on the bill (making_gst_treatment, round_off_to, pan_required, zero_gst_print_note,
-- old-metal valuation_basis), so changing a setting never changes an issued bill.
CREATE TABLE sales.shop_setting (
  tenant_id                uuid NOT NULL REFERENCES platform.tenant(id),
  id                       uuid NOT NULL DEFAULT platform.uuid_v7(),
  -- GST on making charges. 'composite' (default) = taxed with the metal under the jewellery rule (rate from masters.tax_rule,
  -- 3% today, never hard-coded). 'separate' = making billed as a service: the SAC / component come from the tax rule named in
  -- making_tax_rule_code (optional pointer), the RATE from making_service_rate (0.9.1 CA ruling: per shop, NO default).
  -- The app blocks billing in separate mode while making_service_rate is NULL (422 making_service_rate_not_set).
  making_gst_treatment     text NOT NULL DEFAULT 'composite'
                           CONSTRAINT shop_setting_making_gst_treatment_check CHECK (making_gst_treatment IN ('composite','separate')),
  making_tax_rule_code     text,
  making_service_rate      numeric(5,2)                         -- GST % on separately billed making (same unit as masters.tax_rule.rate)
                           CONSTRAINT shop_setting_making_service_rate_check CHECK (making_service_rate IS NULL OR (making_service_rate > 0 AND making_service_rate <= 100)),
  credit_note_rounding     text NOT NULL DEFAULT 'follow_invoice'
                           CONSTRAINT shop_setting_credit_note_rounding_check CHECK (credit_note_rounding IN ('follow_invoice','exact')),
  -- S10 PAN asked when the bill total is at or above this (Rule 114B). PAN itself stays encrypted on masters.customer.
  pan_required_above       platform.money NOT NULL DEFAULT 200000.00
                           CONSTRAINT shop_setting_pan_required_above_check CHECK (pan_required_above > 0),
  -- S11 cash on ONE bill (s.269ST): the app warns or blocks when cash >= the limit. Settings only, no DB enforcement.
  cash_limit_amount        platform.money NOT NULL DEFAULT 200000.00
                           CONSTRAINT shop_setting_cash_limit_amount_check CHECK (cash_limit_amount > 0),
  cash_limit_mode          text NOT NULL DEFAULT 'block'
                           CONSTRAINT shop_setting_cash_limit_mode_check CHECK (cash_limit_mode IN ('warn','block')),
  -- S7 discount (as % of the bill before discount): above warn_pct = warning + daily summary; above override_pct needs sales.price.override_min
  discount_warn_pct        numeric(5,2) NOT NULL DEFAULT 5.00
                           CONSTRAINT shop_setting_discount_warn_pct_check CHECK (discount_warn_pct BETWEEN 0 AND 100),
  discount_override_pct    numeric(5,2) NOT NULL DEFAULT 10.00
                           CONSTRAINT shop_setting_discount_override_pct_check CHECK (discount_override_pct BETWEEN 0 AND 100),
  -- S17 0% GST: note printed on the bill (snapshotted into sales.invoice.zero_gst_print_note)
  zero_gst_print_note      text NOT NULL DEFAULT 'GST charged at 0%'
                           CONSTRAINT shop_setting_zero_gst_print_note_check CHECK (length(trim(zero_gst_print_note)) BETWEEN 1 AND 200),
  -- S13 estimates valid for N days (0 = until the end of the IST day)
  estimate_validity_days   int NOT NULL DEFAULT 0
                           CONSTRAINT shop_setting_estimate_validity_days_check CHECK (estimate_validity_days BETWEEN 0 AND 90),
  -- S19 default paper
  default_paper            text NOT NULL DEFAULT 'A4'
                           CONSTRAINT shop_setting_default_paper_check CHECK (default_paper IN ('A4','A5','thermal_80mm')),
  -- S16 returns: whole lines only (credit_note_line UNIQUE(invoice_line_id)); window checked by the app; default settlement
  return_window_days       int NOT NULL DEFAULT 15
                           CONSTRAINT shop_setting_return_window_days_check CHECK (return_window_days BETWEEN 0 AND 365),
  return_refund_default    text NOT NULL DEFAULT 'store_credit'
                           CONSTRAINT shop_setting_return_refund_default_check CHECK (return_refund_default IN ('store_credit','cash','bank_transfer')),
  -- S6 old-gold exchange on the bill
  old_gold_enabled         boolean NOT NULL DEFAULT true,
  old_gold_valuation_basis text NOT NULL DEFAULT 'stated_purity'
                           CONSTRAINT shop_setting_old_gold_valuation_basis_check CHECK (old_gold_valuation_basis IN ('stated_purity','fine_24k')),
  old_gold_excess_handling text NOT NULL DEFAULT 'separate_purchase'
                           CONSTRAINT shop_setting_old_gold_excess_handling_check CHECK (old_gold_excess_handling IN ('refund_on_bill','separate_purchase')),
  -- estimate / payment-receipt numbers (gaps allowed): rendered by the app, stored in estimate.estimate_no / payment_receipt.receipt_no.
  -- Tokens as inventory.shop_setting: {BRANCH}, {FY} (e.g. 2627), {SEQ:n}. Counter: platform.doc_counter 'estimate' / 'sales_receipt'.
  estimate_no_format       text NOT NULL DEFAULT 'EST-{BRANCH}-{FY}-{SEQ:5}'
                           CONSTRAINT shop_setting_estimate_no_format_check CHECK (char_length(estimate_no_format) BETWEEN 1 AND 64 AND estimate_no_format ~ '\{SEQ(:[1-9][0-9]?)?\}'),
  receipt_no_format        text NOT NULL DEFAULT 'RCT-{BRANCH}-{FY}-{SEQ:5}'
                           CONSTRAINT shop_setting_receipt_no_format_check CHECK (char_length(receipt_no_format) BETWEEN 1 AND 64 AND receipt_no_format ~ '\{SEQ(:[1-9][0-9]?)?\}'),
  updated_by               uuid,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  version                  int NOT NULL DEFAULT 1,
  CONSTRAINT shop_setting_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT shop_setting_one_per_shop UNIQUE (tenant_id),
  CONSTRAINT shop_setting_discount_order_check CHECK (discount_warn_pct <= discount_override_pct),
  CONSTRAINT shop_setting_updated_by_fk FOREIGN KEY (tenant_id, updated_by) REFERENCES platform.app_user(tenant_id, id)
);
COMMENT ON TABLE sales.shop_setting IS 'Sales settings, one row per shop (no row = column defaults). Only sales.settings.edit (owner) may change it (app). Supersedes masters.sales_policy and platform.setting sales.pan_required_above / invoice.rounding for the app; round-off comes from masters.gst_config.round_off_to.';
COMMENT ON COLUMN sales.shop_setting.making_tax_rule_code IS 'Optional pointer to the masters.tax_rule (SAC code + component making) used for separately billed making. The rule supplies the SAC code and component only; its rate is NOT used: the rate is making_service_rate. No rule is seeded.';
COMMENT ON COLUMN sales.shop_setting.making_service_rate IS 'sales.making_service_rate (contract 0.9.1): GST % (0 < rate <= 100, unit as masters.tax_rule.rate) on making billed as a separate service. NULL = unset, no default (CA ruling). The app blocks billing in separate mode while NULL; snapshotted on each bill as sales.invoice.making_service_rate.';
CREATE TRIGGER aa_version BEFORE INSERT OR UPDATE ON sales.shop_setting FOR EACH ROW EXECUTE FUNCTION platform.bump_version();
SELECT platform.enable_audit('sales.shop_setting');

ALTER TABLE sales.shop_setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales.shop_setting FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sales.shop_setting USING (tenant_id = platform.current_tenant()) WITH CHECK (tenant_id = platform.current_tenant());
CREATE POLICY no_partner_access ON sales.shop_setting AS RESTRICTIVE USING (platform.current_partner() IS NULL) WITH CHECK (platform.current_partner() IS NULL);

REVOKE ALL ON sales.shop_setting FROM PUBLIC, app_rw, app_ro, app_worker;
GRANT SELECT, INSERT, UPDATE ON sales.shop_setting TO app_rw;                 -- never deleted (no row = defaults)
GRANT SELECT ON sales.shop_setting TO app_ro, sales_writer;

-- ---------- 2. permission codes (pattern of 982/986/987) ----------
-- Reused, not duplicated: sales.invoice.issue, sales.invoice.cancel, sales.return.issue, sales.price.override_min, sales.discount.give.
-- Role mapping = Ironhide's §11 + lead defaults (credit_sale, old_gold.rate_override) + sales.settings.edit (owner only) +
-- sales.receipt.reverse (owner, manager) — all approved by the lead 9 Nov 2026.
-- To change the mapping before this file is applied on dev, edit the (role, code) list below; after that, a new migration.
INSERT INTO platform.permission(code, module, description) VALUES
 ('sales.invoice.view',            'sales', 'View the bill list and look up bills, credit notes and receipts'),
 ('sales.estimate.create',         'sales', 'Create, edit, cancel and convert estimates'),
 ('sales.payment.receive',         'sales', 'Record a later payment receipt against a bill with a balance due'),
 ('sales.invoice.reprint',         'sales', 'Reprint a bill / credit note / estimate (printed as DUPLICATE, logged)'),
 ('sales.invoice.zero_gst',        'sales', 'Bill at 0% GST (reason and print note required, audited)'),
 ('sales.invoice.credit_sale',     'sales', 'Issue a fully unpaid bill (credit sale); part-paid bills need no extra permission'),
 ('sales.old_gold.rate_override',  'sales', 'Override the server old-gold rate on an exchange line (reason required)'),
 ('sales.settings.edit',           'sales', 'Change sales settings (GST on making, PAN and cash limits, discounts, returns, old gold, print)'),
 ('sales.receipt.reverse',         'sales', 'Reverse a wrong payment receipt (append-only reversal receipt with a reason; restores the balance due)');
INSERT INTO platform.system_role_permission(role_code, permission_code) VALUES
 ('owner','sales.invoice.view'),           ('manager','sales.invoice.view'),   ('salesperson','sales.invoice.view'),   ('cashier','sales.invoice.view'),
 ('owner','sales.estimate.create'),        ('manager','sales.estimate.create'),('salesperson','sales.estimate.create'),('cashier','sales.estimate.create'),
 ('owner','sales.payment.receive'),        ('manager','sales.payment.receive'),                                        ('cashier','sales.payment.receive'),
 ('owner','sales.invoice.reprint'),        ('manager','sales.invoice.reprint'),                                        ('cashier','sales.invoice.reprint'),
 ('owner','sales.invoice.zero_gst'),
 ('owner','sales.invoice.credit_sale'),    ('manager','sales.invoice.credit_sale'),
 ('owner','sales.old_gold.rate_override'), ('manager','sales.old_gold.rate_override'),
 ('owner','sales.settings.edit'),
 ('owner','sales.receipt.reverse'),       ('manager','sales.receipt.reverse');

-- ---------- 3. platform 0% GST rule (S17) ----------
-- invoice_line.tax_rule_id / invoice_line_tax.tax_rule_id are NOT NULL, so a 0% bill still snapshots a rule. One platform rule,
-- component 'other', usable for every head (line_tax keeps its own component). Not per component: a 'making' 0% rule on HSN 7113
-- would overlap MAKING_COMPOSITE in the tax_rule EXCLUDE constraint. No separate-making SAC rule is seeded (lead decision 9 Nov 2026;
-- the rate is the per-shop shop_setting.making_service_rate).
INSERT INTO masters.tax_rule(scope, code, description, component, metal_code, code_type, hsn_sac, rate, cgst_rate, sgst_rate, igst_rate,
                             composite_supply, principal_component, effective_from)
VALUES ('platform', 'ZERO_RATED', '0% GST supply (reason + print note on the bill; sales.invoice.zero_gst)', 'other', NULL, 'HSN', '7113',
        0, 0, 0, 0, false, NULL, '2017-07-01');
