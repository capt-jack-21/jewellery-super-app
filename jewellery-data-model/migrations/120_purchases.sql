-- 120_purchases.sql — vendor purchase, vendor settlement (cash/metal, rate-cut), old-metal purchase from customers
SET search_path = purchases, platform, public;

CREATE TABLE purchases.purchase (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  branch_id uuid NOT NULL, purchase_no text NOT NULL, purchase_date date NOT NULL,
  vendor_id uuid NOT NULL, vendor_invoice_no text, gst_type text NOT NULL CHECK (gst_type IN ('intra','inter','none')),
  taxable_value platform.money NOT NULL DEFAULT 0, gst_amount platform.money NOT NULL DEFAULT 0,
  total_amount platform.money NOT NULL DEFAULT 0, total_fine_wt platform.weight_g NOT NULL DEFAULT 0,
  payment_due_days int, status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','cancelled')),
  lot_id uuid,
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, branch_id, purchase_no),
  FOREIGN KEY (tenant_id, vendor_id) REFERENCES masters.vendor(tenant_id, id),
  FOREIGN KEY (tenant_id, lot_id) REFERENCES inventory.lot(tenant_id, id)
);
SELECT platform.enable_audit('purchases.purchase');
CREATE TABLE purchases.purchase_line (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  purchase_id uuid NOT NULL, item_id uuid NOT NULL, purity_id uuid NOT NULL,
  pieces int NOT NULL DEFAULT 0, gross_wt platform.weight_g NOT NULL, less_wt platform.weight_g NOT NULL DEFAULT 0,
  net_wt platform.weight_g NOT NULL, touch_pct platform.pct NOT NULL, wastage_pct platform.pct NOT NULL DEFAULT 0,
  fine_wt platform.weight_g NOT NULL,           -- settled in metal unless rate_per_g fixed
  mc_type text, mc_amount platform.money NOT NULL DEFAULT 0, hallmark_charge platform.money NOT NULL DEFAULT 0,
  stone_amount platform.money NOT NULL DEFAULT 0, rate_per_g numeric(12,2), amount platform.money NOT NULL DEFAULT 0,
  gst_rate platform.pct NOT NULL DEFAULT 3,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, purchase_id) REFERENCES purchases.purchase(tenant_id, id)
);

CREATE TABLE purchases.vendor_settlement (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  branch_id uuid NOT NULL, settlement_no text NOT NULL, settled_on date NOT NULL,
  vendor_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('cash_to_cash','cash_to_metal','metal_to_cash','metal_to_metal')),
  amount platform.money NOT NULL DEFAULT 0,
  metal_id uuid, gross_wt platform.weight_g, touch_pct platform.pct, fine_wt platform.weight_g NOT NULL DEFAULT 0,
  rate_cut_per_g numeric(12,2),                    -- converts metal dues to cash (or vice versa)
  discount_amount platform.money NOT NULL DEFAULT 0, discount_wt platform.weight_g NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','reversed')),
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, settlement_no),
  FOREIGN KEY (tenant_id, vendor_id) REFERENCES masters.vendor(tenant_id, id)
);
SELECT platform.enable_audit('purchases.vendor_settlement');

CREATE TABLE purchases.old_metal_purchase (     -- standalone buy of old gold from a customer
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  branch_id uuid NOT NULL, voucher_no text NOT NULL, purchased_on date NOT NULL,
  customer_id uuid NOT NULL, purity_id uuid NOT NULL,
  gross_wt platform.weight_g NOT NULL, less_wt platform.weight_g NOT NULL DEFAULT 0, net_wt platform.weight_g NOT NULL,
  touch_pct platform.pct NOT NULL, fine_wt platform.weight_g NOT NULL,
  test_method text CHECK (test_method IN ('xrf','touchstone','fire_assay')), test_photo_key text,
  rate_id uuid, rate_per_g numeric(12,2) NOT NULL, amount platform.money NOT NULL,
  kyc_ref text,
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, branch_id, voucher_no),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES masters.customer(tenant_id, id)
);
