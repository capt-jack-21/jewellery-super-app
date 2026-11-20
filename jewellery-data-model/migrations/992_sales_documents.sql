-- 992_sales_documents.sql — Sales scope S1–S23, part 2 of 3: bill header / line / old-gold / payment / credit-note / estimate columns
--   for contract 0.9.0, and the guardrail CHECKs.
-- TEST DB ONLY until Adithya approves a dev redeploy. 100_sales.sql is applied and immutable: everything here is ALTER / new objects.
-- Issued documents stay immutable through the existing 100_sales guards (issued_doc_guard / child_guard / no_delete) and grants:
-- every new column is set only in the INSERT by sales_writer and is in no UPDATE grant.
--
-- Legacy rows. Headers that are UPDATEd after insert (invoice: cancel / IRN; credit_note: store-credit redemption; estimate: edits)
-- get row_rev: NULL on rows written before 992, DEFAULT 1 on new rows, and excluded from every INSERT / UPDATE grant so the app
-- cannot null it. The 0.9.0 rules on those tables are ordinary (validated) CHECKs "row_rev IS NULL OR ...": enforced on every new
-- row, never re-checked against legacy rows (a NOT VALID CHECK would be re-checked when a legacy bill is cancelled and could block it).
-- Children that are never updated (invoice_line, invoice_old_metal, credit_note_line) use NOT VALID CHECKs; existing columns' FKs are
-- NOT VALID (RI is only re-checked when the key column changes). All NOT VALID constraints are listed in README "Sales 991+".
-- No new functions or triggers beyond aa_version / zz_audit.

-- ======================================================================================================
-- 1. sales.invoice (header)
-- ======================================================================================================
ALTER TABLE sales.invoice ADD COLUMN row_rev smallint;
ALTER TABLE sales.invoice ALTER COLUMN row_rev SET DEFAULT 1;
ALTER TABLE sales.invoice
  ADD COLUMN supply_type            text NOT NULL DEFAULT 'b2c',
  ADD COLUMN customer_gstin         platform.gstin,                   -- S22 B2B buyer GSTIN as billed (GSTR-1 B2B)
  ADD COLUMN making_gst_treatment   text,                             -- S5 snapshot of shop_setting.making_gst_treatment
  ADD COLUMN round_off_to           numeric(4,2),                     -- S8 snapshot of masters.gst_config.round_off_to
  ADD COLUMN cess                   platform.money NOT NULL DEFAULT 0, -- separately rounded tax head (0 today)
  ADD COLUMN zero_gst               boolean NOT NULL DEFAULT false,   -- S17
  ADD COLUMN zero_gst_reason        text,
  ADD COLUMN zero_gst_print_note    text,                             -- snapshot of shop_setting.zero_gst_print_note
  ADD COLUMN bill_discount          platform.money NOT NULL DEFAULT 0, -- S7 bill-level part of discount (spread as invoice_line.bill_discount_share)
  ADD COLUMN discount_reason        text,                             -- required by the app when sales.price.override_min was used
  ADD COLUMN old_gold_excess        platform.money NOT NULL DEFAULT 0, -- S6 old gold worth more than the bill, paid out (refund_on_bill)
  ADD COLUMN old_gold_excess_payout text,
  ADD COLUMN pan_required           boolean,                          -- S10 flags only, never the PAN (PAN stays encrypted on masters.customer)
  ADD COLUMN pan_on_file            boolean,
  ADD COLUMN cash_amount            platform.money NOT NULL DEFAULT 0, -- S11 cash tendered at issue
  ADD COLUMN warnings               jsonb NOT NULL DEFAULT '[]',      -- e.g. ["cash_limit_exceeded","large_discount"] (warn mode)
  ADD COLUMN credit_sale            boolean NOT NULL DEFAULT false,   -- 0.9.1 S9: net payable > 0 and nothing paid at issue (sales.invoice.credit_sale)
  ADD COLUMN making_service_rate    numeric(5,2),                     -- 0.9.1 S5: snapshot of shop_setting.making_service_rate (separate mode only)
  -- validated: hold for legacy rows through the column defaults / NULLs
  ADD CONSTRAINT invoice_row_rev_check CHECK (row_rev = 1),
  ADD CONSTRAINT invoice_supply_type_check CHECK (supply_type IN ('b2c','b2b') AND (supply_type = 'b2b') = (customer_gstin IS NOT NULL)),
  ADD CONSTRAINT invoice_making_gst_treatment_check CHECK (making_gst_treatment IN ('composite','separate')),
  ADD CONSTRAINT invoice_round_off_to_check CHECK (round_off_to IN (0.01, 0.10, 0.50, 1.00) AND abs(round_off) * 2 <= round_off_to),
  ADD CONSTRAINT invoice_zero_gst_check CHECK (
        (NOT zero_gst AND zero_gst_reason IS NULL AND zero_gst_print_note IS NULL)
     OR (zero_gst AND length(trim(coalesce(zero_gst_reason, ''))) >= 5 AND length(trim(coalesce(zero_gst_print_note, ''))) >= 1
         AND cgst = 0 AND sgst = 0 AND igst = 0 AND cess = 0)),
  ADD CONSTRAINT invoice_old_gold_excess_check CHECK (old_gold_excess >= 0 AND old_gold_excess_payout IN ('cash','bank_transfer')
        AND (old_gold_excess > 0) = (old_gold_excess_payout IS NOT NULL)),
  ADD CONSTRAINT invoice_pan_check CHECK (NOT pan_required OR pan_on_file),
  ADD CONSTRAINT invoice_cash_warnings_check CHECK (cash_amount >= 0 AND jsonb_typeof(warnings) = 'array'),
  -- 0.9.0 rules for new rows (row_rev = 1)
  ADD CONSTRAINT invoice_required_check CHECK (row_rev IS NULL OR (making_gst_treatment IS NOT NULL AND round_off_to IS NOT NULL
        AND pan_required IS NOT NULL AND pan_on_file IS NOT NULL AND salesperson_id IS NOT NULL)),
  ADD CONSTRAINT invoice_credit_sale_check CHECK (row_rev IS NULL OR credit_sale = (net_payable > 0 AND paid_amount = 0)),
  ADD CONSTRAINT invoice_making_service_rate_check CHECK ((making_service_rate IS NULL OR (making_service_rate > 0 AND making_service_rate <= 100))
        AND (row_rev IS NULL OR (making_gst_treatment = 'separate') = (making_service_rate IS NOT NULL))),
  ADD CONSTRAINT invoice_doc_no_check CHECK (row_rev IS NULL OR doc_no ~ '^[A-Za-z0-9/-]{1,16}$'),       -- GST rule 46
  ADD CONSTRAINT invoice_taxable_sum_check CHECK (row_rev IS NULL OR taxable_value = gross_value - discount),
  ADD CONSTRAINT invoice_total_sum_check CHECK (row_rev IS NULL OR invoice_total = taxable_value + cgst + sgst + igst + cess + round_off),
  ADD CONSTRAINT invoice_net_payable_check CHECK (row_rev IS NULL OR (net_payable = invoice_total - old_metal_value + old_gold_excess
        AND (old_gold_excess = 0 OR net_payable = 0))),
  ADD CONSTRAINT invoice_gst_split_check CHECK (row_rev IS NULL OR (gst_type = 'intra' AND igst = 0) OR (gst_type = 'inter' AND cgst = 0 AND sgst = 0)),
  ADD CONSTRAINT invoice_amounts_check CHECK (row_rev IS NULL OR (gross_value >= 0 AND discount >= 0 AND bill_discount BETWEEN 0 AND discount
        AND taxable_value >= 0 AND cgst >= 0 AND sgst >= 0 AND igst >= 0 AND cess >= 0 AND old_metal_value >= 0 AND net_payable >= 0
        AND paid_amount >= 0 AND balance_due >= 0 AND cash_amount <= paid_amount)),
  ADD CONSTRAINT invoice_seller_gstin_check CHECK (row_rev IS NULL OR seller_gstin IS NULL OR (seller_gstin ~ '^[0-9]{2}[A-Z0-9]{13}$'
        AND (gst_type = 'intra') = (left(seller_gstin, 2) = place_of_supply::text)));
ALTER TABLE sales.invoice
  ADD CONSTRAINT invoice_salesperson_fk FOREIGN KEY (tenant_id, salesperson_id) REFERENCES hr.staff(tenant_id, id) NOT VALID,
  ADD CONSTRAINT invoice_cash_counter_fk FOREIGN KEY (tenant_id, cash_counter_id) REFERENCES accounts.cash_counter(tenant_id, id) NOT VALID;
COMMENT ON COLUMN sales.invoice.row_rev IS 'NULL = written before 992 (legacy, 0.9.0 CHECKs not applied); 1 = 0.9.0 rules. Server default, not insertable / updatable.';
COMMENT ON COLUMN sales.invoice.credit_sale IS '0.9.1: true iff net_payable > 0 and paid_amount = 0 at issue (CHECK, new rows). Needs sales.invoice.credit_sale (app). Not tied to status: a credit sale can later be cancelled by credit note.';
COMMENT ON COLUMN sales.invoice.making_service_rate IS '0.9.1: GST % on separately billed making, snapshot of shop_setting.making_service_rate. Required when making_gst_treatment = separate, NULL when composite (new rows).';
COMMENT ON COLUMN sales.invoice.discount IS 'total discount = sum(invoice_line.discount) + bill_discount';
COMMENT ON COLUMN sales.invoice.balance_due IS 'balance due AT ISSUE (immutable). Current balance: sales.invoice_due / sales.v_invoice_balance (993).';
COMMENT ON COLUMN sales.invoice.net_payable IS 'invoice_total - old_metal_value + old_gold_excess (>= 0; when old gold exceeds the bill, net 0 and the excess is paid out)';
CREATE INDEX invoice_doc_no_prefix_idx ON sales.invoice (tenant_id, doc_no text_pattern_ops);
CREATE INDEX invoice_salesperson_idx ON sales.invoice (tenant_id, salesperson_id, doc_date);

-- ======================================================================================================
-- 2. sales.invoice_line — S3, S4, S7, S8, S14, S23 (never updated: NOT VALID for existing columns)
-- ======================================================================================================
ALTER TABLE sales.invoice_line
  ADD COLUMN stock_kind          text,                              -- 'tag' | 'loose' (goods lines); NULL for service lines
  ADD COLUMN purity_id           uuid,
  ADD COLUMN counter_id          uuid,                              -- sold-from location = restock target on cancel / return
  ADD COLUMN box_id              uuid,
  ADD COLUMN chargeable_wt       platform.weight_g,                 -- net_wt + wastage_wt
  ADD COLUMN gross_value         platform.money,                    -- metal + making + stone + hallmark, before discounts
  ADD COLUMN bill_discount_share platform.money NOT NULL DEFAULT 0,
  ADD COLUMN cess                platform.money NOT NULL DEFAULT 0,
  ADD CONSTRAINT invoice_line_stock_kind_check CHECK (stock_kind IN ('tag','loose')),
  ADD CONSTRAINT invoice_line_purity_fk FOREIGN KEY (tenant_id, purity_id) REFERENCES masters.purity(tenant_id, id),
  ADD CONSTRAINT invoice_line_counter_fk FOREIGN KEY (tenant_id, counter_id) REFERENCES masters.counter(tenant_id, id),
  ADD CONSTRAINT invoice_line_box_fk FOREIGN KEY (tenant_id, box_id) REFERENCES masters.box(tenant_id, id);
ALTER TABLE sales.invoice_line
  ADD CONSTRAINT invoice_line_tag_fk FOREIGN KEY (tenant_id, tag_id) REFERENCES inventory.tag(tenant_id, id) NOT VALID,
  ADD CONSTRAINT invoice_line_item_fk FOREIGN KEY (tenant_id, item_id) REFERENCES masters.item(tenant_id, id) NOT VALID,
  ADD CONSTRAINT invoice_line_rate_fk FOREIGN KEY (tenant_id, rate_id) REFERENCES rates.metal_rate(tenant_id, id) NOT VALID,
  ADD CONSTRAINT invoice_line_stock_check CHECK ((line_kind = 'service' AND stock_kind IS NULL)
        OR (line_kind = 'goods' AND stock_kind IS NOT NULL AND (stock_kind = 'tag') = (tag_id IS NOT NULL) AND purity_id IS NOT NULL
            AND chargeable_wt IS NOT NULL AND gross_value IS NOT NULL)) NOT VALID,
  ADD CONSTRAINT invoice_line_mc_type_check CHECK (mc_type IN ('per_gram','percent','flat','per_piece')) NOT VALID,
  ADD CONSTRAINT invoice_line_weights_check CHECK (net_wt <= gross_wt AND stone_wt <= gross_wt AND pieces >= 1
        AND (chargeable_wt IS NULL OR chargeable_wt = net_wt + wastage_wt)) NOT VALID,
  ADD CONSTRAINT invoice_line_amounts_check CHECK (metal_value >= 0 AND mc_amount >= 0 AND stone_amount >= 0 AND huid_charge >= 0
        AND discount >= 0 AND bill_discount_share >= 0 AND taxable_value >= 0 AND cgst >= 0 AND sgst >= 0 AND igst >= 0 AND cess >= 0
        AND rate_per_g >= 0) NOT VALID,
  ADD CONSTRAINT invoice_line_taxable_sum_check CHECK (line_kind <> 'goods' OR (gross_value = metal_value + mc_amount + stone_amount + huid_charge
        AND taxable_value = gross_value - discount - bill_discount_share)) NOT VALID,
  ADD CONSTRAINT invoice_line_total_sum_check CHECK (line_total = taxable_value + cgst + sgst + igst + cess) NOT VALID,
  ADD CONSTRAINT invoice_line_gst_split_check CHECK ((cgst = 0 AND sgst = 0) OR igst = 0) NOT VALID;

-- ======================================================================================================
-- 3. sales.invoice_old_metal — S6 (never updated). Lead default: server rate + optional override with reason, audited.
-- ======================================================================================================
ALTER TABLE sales.invoice_old_metal
  ADD COLUMN valuation_basis     text,                              -- snapshot of shop_setting.old_gold_valuation_basis
  ADD COLUMN server_rate_per_g   numeric(12,2),                     -- today's old_metal rate the server offered
  ADD COLUMN override_rate_per_g numeric(12,2),                     -- set only with sales.old_gold.rate_override
  ADD COLUMN override_reason     text,
  ADD COLUMN overridden_by       uuid,                              -- 0.9.1: the user who overrode (holds sales.old_gold.rate_override)
  ADD COLUMN rate_overridden     boolean GENERATED ALWAYS AS (override_rate_per_g IS NOT NULL) STORED,   -- 0.9.1 contract 'rate_overridden'
  ADD COLUMN inventory_ref_id    uuid,                              -- the old_metal_in stock_ledger row written in the same transaction
  ADD CONSTRAINT invoice_old_metal_valuation_basis_check CHECK (valuation_basis IN ('stated_purity','fine_24k')),
  ADD CONSTRAINT invoice_old_metal_override_check CHECK ((override_rate_per_g IS NULL AND override_reason IS NULL AND overridden_by IS NULL)
        OR (override_rate_per_g > 0 AND length(trim(coalesce(override_reason, ''))) BETWEEN 5 AND 200 AND overridden_by IS NOT NULL)),
  ADD CONSTRAINT invoice_old_metal_overridden_by_fk FOREIGN KEY (tenant_id, overridden_by) REFERENCES platform.app_user(tenant_id, id),
  ADD CONSTRAINT invoice_old_metal_ledger_fk FOREIGN KEY (tenant_id, inventory_ref_id) REFERENCES inventory.stock_ledger(tenant_id, id)
        DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE sales.invoice_old_metal
  ADD CONSTRAINT invoice_old_metal_purity_fk FOREIGN KEY (tenant_id, purity_id) REFERENCES masters.purity(tenant_id, id) NOT VALID,
  ADD CONSTRAINT invoice_old_metal_rate_fk FOREIGN KEY (tenant_id, rate_id) REFERENCES rates.metal_rate(tenant_id, id) NOT VALID,
  ADD CONSTRAINT invoice_old_metal_required_check CHECK (valuation_basis IS NOT NULL AND server_rate_per_g IS NOT NULL
        AND rate_per_g = coalesce(override_rate_per_g, server_rate_per_g)) NOT VALID,
  ADD CONSTRAINT invoice_old_metal_weights_check CHECK (net_wt = gross_wt - less_wt AND fine_wt <= net_wt AND touch_pct > 0 AND touch_pct <= 100) NOT VALID,
  ADD CONSTRAINT invoice_old_metal_amount_check CHECK (rate_per_g > 0 AND amount >= 0) NOT VALID;
COMMENT ON COLUMN sales.invoice_old_metal.server_rate_per_g IS 'Contract 0.9.1 server_rate: today''s old-metal rate offered by the server (Rs/g).';
COMMENT ON COLUMN sales.invoice_old_metal.override_rate_per_g IS 'Rate entered under sales.old_gold.rate_override (Rs/g); NULL = no override. Applied rate rate_per_g = coalesce(override_rate_per_g, server_rate_per_g).';
COMMENT ON COLUMN sales.invoice_old_metal.rate_overridden IS 'Contract 0.9.1 rate_overridden / overridden: generated, override_rate_per_g IS NOT NULL. Not writable.';
COMMENT ON COLUMN sales.invoice_old_metal.overridden_by IS 'Contract 0.9.1 overridden_by: platform.app_user who overrode; required with override_reason when overridden, NULL otherwise.';
SELECT platform.enable_audit('sales.invoice_old_metal');

-- ======================================================================================================
-- 4. sales.invoice_payment — tender details (never updated)
-- ======================================================================================================
-- payment_mode_id / card_machine_id (+ FKs) already exist since 980; only the cheque / bank details are new.
ALTER TABLE sales.invoice_payment
  ADD COLUMN cheque_date     date,
  ADD COLUMN bank_name       text;

-- ======================================================================================================
-- 5. sales.credit_note / credit_note_line — S15, S16 (whole-line returns: credit_note_line UNIQUE(invoice_line_id) from 100)
-- ======================================================================================================
ALTER TABLE sales.credit_note ADD COLUMN row_rev smallint;
ALTER TABLE sales.credit_note ALTER COLUMN row_rev SET DEFAULT 1;
-- refund_mode: API naming bank_transfer. Legacy 'bank' rows stay valid; new rows cannot use 'bank'.
ALTER TABLE sales.credit_note DROP CONSTRAINT credit_note_refund_mode_check;
ALTER TABLE sales.credit_note
  ADD COLUMN customer_id         uuid,                               -- store-credit owner (lookup by customer)
  ADD COLUMN customer_snapshot   jsonb,
  ADD COLUMN cess                platform.money NOT NULL DEFAULT 0,
  ADD COLUMN round_off           numeric(6,2) NOT NULL DEFAULT 0,
  -- settlement: total = refund_amount (paid out now via refund_mode) + due_reduced (lowers sales.invoice_due) + store_credit_amount
  ADD COLUMN refund_amount       platform.money NOT NULL DEFAULT 0,
  ADD COLUMN due_reduced         platform.money NOT NULL DEFAULT 0,
  ADD COLUMN store_credit_amount platform.money NOT NULL DEFAULT 0,
  ADD CONSTRAINT credit_note_row_rev_check CHECK (row_rev = 1),
  ADD CONSTRAINT credit_note_refund_mode_check CHECK (refund_mode IN ('store_credit','cash','bank','bank_transfer','reversal')
        AND (row_rev IS NULL OR refund_mode <> 'bank')),
  ADD CONSTRAINT credit_note_customer_fk FOREIGN KEY (tenant_id, customer_id) REFERENCES masters.customer(tenant_id, id),
  ADD CONSTRAINT credit_note_doc_no_check CHECK (row_rev IS NULL OR doc_no ~ '^[A-Za-z0-9/-]{1,16}$'),
  ADD CONSTRAINT credit_note_total_sum_check CHECK (row_rev IS NULL OR total = taxable_value + cgst + sgst + igst + cess + round_off),
  ADD CONSTRAINT credit_note_settlement_check CHECK (row_rev IS NULL OR (
        refund_amount >= 0 AND due_reduced >= 0 AND store_credit_amount >= 0
        AND total = refund_amount + due_reduced + store_credit_amount
        AND balance_available <= store_credit_amount                         -- starts equal (app), only decreases (G3)
        AND (refund_mode = 'store_credit') = (refund_amount = 0)
        AND (store_credit_amount = 0 OR customer_id IS NOT NULL)
        AND taxable_value >= 0 AND cgst >= 0 AND sgst >= 0 AND igst >= 0 AND cess >= 0));
COMMENT ON COLUMN sales.credit_note.row_rev IS 'NULL = written before 992 (legacy); 1 = 0.9.0 rules. Server default, not insertable / updatable.';
CREATE INDEX credit_note_store_credit_idx ON sales.credit_note (tenant_id, customer_id) WHERE balance_available > 0;
CREATE INDEX credit_note_invoice_idx ON sales.credit_note (tenant_id, invoice_id);

ALTER TABLE sales.credit_note_line
  ADD COLUMN cess               platform.money NOT NULL DEFAULT 0,
  ADD COLUMN stock_kind         text,
  ADD COLUMN restock_counter_id uuid,                               -- where the returned / cancelled stock goes back
  ADD COLUMN restock_box_id     uuid,
  ADD CONSTRAINT credit_note_line_stock_kind_check CHECK (stock_kind IN ('tag','loose')),
  ADD CONSTRAINT credit_note_line_counter_fk FOREIGN KEY (tenant_id, restock_counter_id) REFERENCES masters.counter(tenant_id, id),
  ADD CONSTRAINT credit_note_line_box_fk FOREIGN KEY (tenant_id, restock_box_id) REFERENCES masters.box(tenant_id, id);
ALTER TABLE sales.credit_note_line
  ADD CONSTRAINT credit_note_line_total_sum_check CHECK (line_total = taxable_value + cgst + sgst + igst + cess) NOT VALID;

-- ======================================================================================================
-- 6. sales.estimate — S13: cancelled status, version, computation; frozen once billed / expired / cancelled;
--    many estimates -> one invoice (invoice.estimate_ids), each estimate billed exactly once
-- ======================================================================================================
ALTER TABLE sales.estimate ADD COLUMN row_rev smallint;
ALTER TABLE sales.estimate ALTER COLUMN row_rev SET DEFAULT 1;
ALTER TABLE sales.estimate DROP CONSTRAINT estimate_status_check;
ALTER TABLE sales.estimate
  ADD COLUMN version     int NOT NULL DEFAULT 1,
  ADD COLUMN computation jsonb NOT NULL DEFAULT '{}',              -- last computed bill (lines, taxes, totals) for the UI / If-Match
  ADD COLUMN notes       text,
  ADD COLUMN updated_by  uuid,
  ADD COLUMN updated_at  timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT estimate_row_rev_check CHECK (row_rev = 1),
  ADD CONSTRAINT estimate_status_check CHECK (status IN ('draft','pending_approval','approved','denied','billed','expired','cancelled')),
  ADD CONSTRAINT estimate_computation_check CHECK (jsonb_typeof(computation) = 'object'),
  ADD CONSTRAINT estimate_billed_check CHECK (row_rev IS NULL OR (status = 'billed') = (invoice_id IS NOT NULL)),
  ADD CONSTRAINT estimate_updated_by_fk FOREIGN KEY (tenant_id, updated_by) REFERENCES platform.app_user(tenant_id, id);
ALTER TABLE sales.estimate
  ADD CONSTRAINT estimate_invoice_fk FOREIGN KEY (tenant_id, invoice_id) REFERENCES sales.invoice(tenant_id, id) NOT VALID;
CREATE TRIGGER aa_version BEFORE INSERT OR UPDATE ON sales.estimate FOR EACH ROW EXECUTE FUNCTION platform.bump_version();
CREATE INDEX estimate_invoice_idx ON sales.estimate (tenant_id, invoice_id) WHERE invoice_id IS NOT NULL;
-- (a) billed / expired / cancelled rows are frozen for everyone (UPDATE matches 0 rows);
-- (b) only sales_writer may set 'billed', and only to an invoice issued in this transaction (issued_at = now()) in the same branch
--     whose estimate_ids lists this estimate. app_rw can never bill.
CREATE POLICY edit_until_closed ON sales.estimate AS RESTRICTIVE FOR UPDATE
  USING (status NOT IN ('billed','expired','cancelled'))
  WITH CHECK (status <> 'billed'
              OR (current_user = 'sales_writer'
                  AND EXISTS (SELECT 1 FROM sales.invoice i WHERE i.tenant_id = estimate.tenant_id AND i.id = estimate.invoice_id
                              AND i.branch_id = estimate.branch_id AND i.status = 'issued' AND i.issued_at = now()
                              AND estimate.id = ANY (i.estimate_ids))));
CREATE POLICY insert_not_billed ON sales.estimate AS RESTRICTIVE FOR INSERT
  WITH CHECK (status <> 'billed' AND invoice_id IS NULL);

-- ======================================================================================================
-- 7. grants: row_rev is never client-writable (column-level INSERT / UPDATE instead of table-level)
-- ======================================================================================================
DO $$
DECLARE c text;
BEGIN
  SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO c FROM pg_attribute
   WHERE attrelid = 'sales.invoice'::regclass AND attnum > 0 AND NOT attisdropped AND attname <> 'row_rev';
  REVOKE INSERT ON sales.invoice FROM sales_writer;
  EXECUTE format('GRANT INSERT (%s) ON sales.invoice TO sales_writer', c);
  SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO c FROM pg_attribute
   WHERE attrelid = 'sales.credit_note'::regclass AND attnum > 0 AND NOT attisdropped AND attname <> 'row_rev';
  REVOKE INSERT ON sales.credit_note FROM sales_writer;
  EXECUTE format('GRANT INSERT (%s) ON sales.credit_note TO sales_writer', c);
  SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO c FROM pg_attribute
   WHERE attrelid = 'sales.estimate'::regclass AND attnum > 0 AND NOT attisdropped AND attname <> 'row_rev';
  REVOKE INSERT, UPDATE ON sales.estimate FROM app_rw, sales_writer;
  EXECUTE format('GRANT INSERT (%1$s), UPDATE (%1$s) ON sales.estimate TO app_rw, sales_writer', c);
END $$;
