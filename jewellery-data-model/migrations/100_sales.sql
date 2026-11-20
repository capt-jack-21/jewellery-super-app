-- 100_sales.sql — estimates, invoices (single gapless series), old-gold exchange, payments,
-- credit notes (cancellation & returns, own gapless series), advances, chit schemes.
-- All pricing / GST / old-gold / payment / cancellation LOGIC lives in the NestJS sales module.
-- The DB keeps minimal guardrails only: locked gapless counters, immutability of issued documents,
-- write access only for the sales_writer role, audit, RLS and constraints.
-- There is exactly ONE invoice series per branch per FY. No backup/alternate series exist.
SET search_path = sales, platform, public;

-- ---------- numbering (INV-1) ----------
CREATE TABLE sales.doc_series (
  tenant_id uuid NOT NULL, branch_id uuid NOT NULL,
  doc_type text NOT NULL CHECK (doc_type IN ('tax_invoice','credit_note')),   -- the ONLY gapless series
  fy text NOT NULL CHECK (fy ~ '^[0-9]{4}-[0-9]{2}$'),
  prefix text NOT NULL,
  next_no int NOT NULL DEFAULT 1 CHECK (next_no >= 1),
  PRIMARY KEY (tenant_id, branch_id, doc_type, fy),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES platform.branch(tenant_id, id)
);

-- Number allocation is done by the app inside the issuing transaction (no function needed):
--   INSERT INTO sales.doc_series(tenant_id, branch_id, doc_type, fy, prefix) VALUES (...) ON CONFLICT DO NOTHING;
--   UPDATE sales.doc_series SET next_no = next_no + 1 WHERE <key> RETURNING next_no - 1 AS seq, prefix;
-- The UPDATE row lock serialises issuers; rollback releases the number. Guards below make this the only
-- possible pattern (counter can only move +1, and the allocated number must be used before COMMIT).

-- Non-statutory numbering (estimates, advance/chit receipts, orders, repairs, purchases, vouchers, transfers,
-- memos, refinery jobs, ...): gaps are acceptable, so no guards. The app uses this plain counter
-- (UPDATE ... RETURNING) or ordinary Postgres sequences.
CREATE TABLE platform.doc_counter (
  tenant_id uuid NOT NULL, branch_id uuid NOT NULL, doc_type text NOT NULL, fy text NOT NULL,
  prefix text NOT NULL, next_no bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, branch_id, doc_type, fy),
  CHECK (doc_type NOT IN ('tax_invoice','credit_note')),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES platform.branch(tenant_id, id)
);

-- ---------- idempotency (double-submit protection for invoice issue) ----------
-- The sales module inserts the client's Idempotency-Key in the issuing transaction; a retry with the same key
-- hits the unique constraint and the app returns the original invoice instead of issuing a second one.
-- Retention 24 h: a pg-boss job (app_worker) deletes rows older than 24 h (policy + grant in 900_security.sql).
CREATE TABLE sales.idempotency_key (
  tenant_id  uuid NOT NULL REFERENCES platform.tenant(id),
  key        text NOT NULL CHECK (length(key) BETWEEN 8 AND 200),
  invoice_id uuid,
  request_hash text,                        -- optional: detect same key with a different payload
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);
CREATE INDEX idempotency_key_created_idx ON sales.idempotency_key (created_at);

-- ---------- estimates (not tax documents; own series, may be abandoned) ----------
CREATE TABLE sales.estimate (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  branch_id uuid NOT NULL, estimate_no text, estimate_date date NOT NULL DEFAULT current_date,
  customer_id uuid, salesperson_id uuid,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','approved','denied','billed','expired')),
  valid_until timestamptz, rate_locked boolean NOT NULL DEFAULT false,
  payload jsonb NOT NULL DEFAULT '{}',   -- draft lines/old metal/payments as captured by the UI (estimates are not tax documents)
  est_total platform.money,
  invoice_id uuid,
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES platform.branch(tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES masters.customer(tenant_id, id),
  FOREIGN KEY (tenant_id, salesperson_id) REFERENCES hr.staff(tenant_id, id)
);
CREATE UNIQUE INDEX estimate_no_uq ON sales.estimate (tenant_id, branch_id, estimate_no);
SELECT platform.enable_audit('sales.estimate');

-- ---------- tax invoice ----------
CREATE TABLE sales.invoice (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  branch_id uuid NOT NULL, company_id uuid NOT NULL,
  fy text NOT NULL, doc_seq int NOT NULL, doc_no text NOT NULL,       -- server-assigned only
  doc_date date NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Kolkata')::date, issued_at timestamptz NOT NULL DEFAULT now(),
  customer_id uuid, customer_snapshot jsonb NOT NULL,                 -- name, phone, gstin, address, state at issue time
  seller_gstin text, place_of_supply platform.state_code NOT NULL,
  gst_type text NOT NULL CHECK (gst_type IN ('intra','inter')),
  print_category text,                     -- 'GOLD'/'SILVER' label only — NOT a separate series
  salesperson_id uuid, cash_counter_id uuid,
  rate_snapshot jsonb NOT NULL,            -- day rates printed on bill
  gross_value platform.money NOT NULL, discount platform.money NOT NULL DEFAULT 0,
  taxable_value platform.money NOT NULL,
  cgst platform.money NOT NULL DEFAULT 0, sgst platform.money NOT NULL DEFAULT 0, igst platform.money NOT NULL DEFAULT 0,
  round_off numeric(6,2) NOT NULL DEFAULT 0,
  invoice_total platform.money NOT NULL,   -- taxable + tax + round_off
  old_metal_value platform.money NOT NULL DEFAULT 0,
  net_payable platform.money NOT NULL,     -- invoice_total - old metal
  paid_amount platform.money NOT NULL DEFAULT 0,
  balance_due platform.money NOT NULL DEFAULT 0,
  estimate_ids uuid[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','cancelled')),
  cancelled_at timestamptz, cancel_credit_note_id uuid,
  irn text, irn_ack_at timestamptz,        -- e-invoice (only these may be set later, by sales functions)
  created_by uuid NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, branch_id, fy, doc_seq),
  UNIQUE (tenant_id, doc_no),
  CHECK (net_payable = paid_amount + balance_due),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES platform.branch(tenant_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company(tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES masters.customer(tenant_id, id)
);
CREATE INDEX invoice_date_idx ON sales.invoice (tenant_id, branch_id, doc_date);
CREATE INDEX invoice_customer_idx ON sales.invoice (tenant_id, customer_id);

CREATE TABLE sales.invoice_line (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  invoice_id uuid NOT NULL, line_no int NOT NULL,
  line_kind text NOT NULL DEFAULT 'goods' CHECK (line_kind IN ('goods','service')),
  tag_id uuid, item_id uuid NOT NULL, sub_item_id uuid,
  description text NOT NULL,
  -- snapshots (never re-read from masters after issue)
  purity_code text NOT NULL, fineness platform.fineness NOT NULL, hsn varchar(8) NOT NULL, huid varchar(6) CHECK (huid ~ '^[A-Z0-9]{6}$'),
  pieces int NOT NULL DEFAULT 1,
  gross_wt platform.weight_g NOT NULL, stone_wt platform.weight_g NOT NULL DEFAULT 0, net_wt platform.weight_g NOT NULL,
  rate_id uuid NOT NULL, rate_per_g numeric(12,2) NOT NULL,
  wastage_pct platform.pct NOT NULL DEFAULT 0, wastage_wt platform.weight_g NOT NULL DEFAULT 0,
  metal_value platform.money NOT NULL,
  mc_type text NOT NULL, mc_value numeric(12,2) NOT NULL, mc_amount platform.money NOT NULL,
  stone_amount platform.money NOT NULL DEFAULT 0, huid_charge platform.money NOT NULL DEFAULT 0,
  discount platform.money NOT NULL DEFAULT 0,
  taxable_value platform.money NOT NULL,
  -- tax snapshot: principal rule applied to the line (full per-component breakdown in invoice_line_tax)
  tax_rule_id uuid NOT NULL, tax_rate numeric(5,2) NOT NULL, hsn_sac_applied varchar(8) NOT NULL,
  composite_supply boolean NOT NULL,
  cgst platform.money NOT NULL DEFAULT 0, sgst platform.money NOT NULL DEFAULT 0, igst platform.money NOT NULL DEFAULT 0,
  line_total platform.money NOT NULL,
  stones jsonb NOT NULL DEFAULT '[]',      -- snapshot of tag_stone rows
  approval_request_id uuid,                -- if priced below tag guardrail
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, invoice_id, line_no),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES sales.invoice(tenant_id, id)
);
-- Per-component tax snapshot (metal / making / stone / hallmark / service): the rule id AND the rates
-- as applied, so later rule changes never alter an issued invoice.
CREATE TABLE sales.invoice_line_tax (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  invoice_line_id uuid NOT NULL,
  component text NOT NULL CHECK (component IN ('metal','making','stone','hallmark','service','other')),
  tax_rule_id uuid NOT NULL REFERENCES masters.tax_rule(id) ON DELETE RESTRICT,
  hsn_sac varchar(8) NOT NULL, composite_supply boolean NOT NULL,
  taxable_value platform.money NOT NULL,
  rate numeric(5,2) NOT NULL, cgst_rate numeric(5,2) NOT NULL, sgst_rate numeric(5,2) NOT NULL,
  igst_rate numeric(5,2) NOT NULL, cess_rate numeric(5,2) NOT NULL DEFAULT 0,
  cgst platform.money NOT NULL DEFAULT 0, sgst platform.money NOT NULL DEFAULT 0,
  igst platform.money NOT NULL DEFAULT 0, cess platform.money NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, invoice_line_id, component),
  CHECK (cgst_rate + sgst_rate = rate AND igst_rate = rate),
  CHECK ((cgst = 0 AND sgst = 0) OR igst = 0),        -- intra XOR inter
  FOREIGN KEY (tenant_id, invoice_line_id) REFERENCES sales.invoice_line(tenant_id, id)
);
ALTER TABLE sales.invoice_line ADD FOREIGN KEY (tax_rule_id) REFERENCES masters.tax_rule(id) ON DELETE RESTRICT;

-- Mark tax rules as used (locks them, see masters.tax_rule_guard). Owner-run so it works for platform rules too.
CREATE FUNCTION sales.mark_tax_rule_used() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = masters, pg_temp AS $$
BEGIN
  UPDATE masters.tax_rule SET first_used_at = now() WHERE id = NEW.tax_rule_id AND first_used_at IS NULL;
  RETURN NULL;
END $$;
CREATE TRIGGER mark_tax_rule_used AFTER INSERT ON sales.invoice_line FOR EACH ROW EXECUTE FUNCTION sales.mark_tax_rule_used();
CREATE TRIGGER mark_tax_rule_used AFTER INSERT ON sales.invoice_line_tax FOR EACH ROW EXECUTE FUNCTION sales.mark_tax_rule_used();

CREATE UNIQUE INDEX invoice_line_tag_uq ON sales.invoice_line (tenant_id, invoice_id, tag_id) WHERE tag_id IS NOT NULL;
CREATE INDEX invoice_line_tag_idx ON sales.invoice_line (tenant_id, tag_id);

CREATE TABLE sales.invoice_old_metal (     -- old-gold exchange inside the bill
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  invoice_id uuid NOT NULL, line_no int NOT NULL,
  purity_id uuid NOT NULL, purity_code text NOT NULL, description text,
  gross_wt platform.weight_g NOT NULL, less_wt platform.weight_g NOT NULL DEFAULT 0,   -- dust/stone/less
  net_wt platform.weight_g NOT NULL, touch_pct platform.pct NOT NULL, fine_wt platform.weight_g NOT NULL,
  rate_id uuid NOT NULL, rate_per_g numeric(12,2) NOT NULL,
  amount platform.money NOT NULL,
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, invoice_id, line_no),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES sales.invoice(tenant_id, id)
);

CREATE TABLE sales.invoice_payment (       -- split payments
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  invoice_id uuid NOT NULL, line_no int NOT NULL,
  mode text NOT NULL CHECK (mode IN ('cash','upi','debit_card','credit_card','bank_transfer','cheque',
                                      'gift_voucher','advance','chit','credit_note')),
  provider text, reference text,
  amount platform.money NOT NULL CHECK (amount > 0),
  advance_id uuid, chit_enrolment_id uuid, credit_note_id uuid,
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, invoice_id, line_no),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES sales.invoice(tenant_id, id)
);

-- ---------- credit notes (own gapless series) ----------
CREATE TABLE sales.credit_note (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  branch_id uuid NOT NULL, fy text NOT NULL, doc_seq int NOT NULL, doc_no text NOT NULL,
  doc_date date NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Kolkata')::date, issued_at timestamptz NOT NULL DEFAULT now(),
  invoice_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('cancellation','sales_return')),
  reason text NOT NULL CHECK (length(trim(reason)) >= 5),
  taxable_value platform.money NOT NULL,
  cgst platform.money NOT NULL DEFAULT 0, sgst platform.money NOT NULL DEFAULT 0, igst platform.money NOT NULL DEFAULT 0,
  total platform.money NOT NULL,
  refund_mode text NOT NULL DEFAULT 'store_credit' CHECK (refund_mode IN ('store_credit','cash','bank','reversal')),
  balance_available platform.money NOT NULL DEFAULT 0 CHECK (balance_available >= 0),   -- usable store credit for future bills
  created_by uuid NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, branch_id, fy, doc_seq), UNIQUE (tenant_id, doc_no),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES sales.invoice(tenant_id, id)
);
CREATE TABLE sales.credit_note_line (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  credit_note_id uuid NOT NULL, invoice_line_id uuid NOT NULL,
  taxable_value platform.money NOT NULL,
  cgst platform.money NOT NULL, sgst platform.money NOT NULL, igst platform.money NOT NULL,
  line_total platform.money NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, invoice_line_id),      -- a line can be credited once
  FOREIGN KEY (tenant_id, credit_note_id) REFERENCES sales.credit_note(tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_line_id) REFERENCES sales.invoice_line(tenant_id, id)
);
ALTER TABLE sales.invoice_payment ADD FOREIGN KEY (tenant_id, credit_note_id) REFERENCES sales.credit_note(tenant_id, id);

-- ---------- advances & chit ----------
CREATE TABLE sales.advance (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  branch_id uuid NOT NULL, receipt_no text NOT NULL, received_on date NOT NULL DEFAULT current_date,
  customer_id uuid NOT NULL, purpose text,
  kind text NOT NULL CHECK (kind IN ('amount','metal')),
  amount platform.money NOT NULL DEFAULT 0,
  purity_id uuid, weight platform.weight_g, locked_rate_per_g numeric(12,2),
  balance platform.money NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','partly_redeemed','redeemed','refunded','cancelled')),
  order_id uuid,
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, receipt_no),
  CHECK (balance >= 0),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES masters.customer(tenant_id, id)
);
ALTER TABLE sales.invoice_payment ADD FOREIGN KEY (tenant_id, advance_id) REFERENCES sales.advance(tenant_id, id);

CREATE TABLE sales.chit_scheme (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  name text NOT NULL, kind text NOT NULL CHECK (kind IN ('amount','weight')),
  instalment_amount platform.money NOT NULL, duration_months int NOT NULL,
  bonus_rule jsonb NOT NULL DEFAULT '{}',   -- e.g. {"waive_last_instalment":true} or {"mc_discount_pct":50}
  is_active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, name)
);
CREATE TABLE sales.chit_enrolment (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  scheme_id uuid NOT NULL, customer_id uuid NOT NULL, branch_id uuid NOT NULL,
  enrol_no text NOT NULL, start_date date NOT NULL, maturity_date date NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','matured','redeemed','closed_early','defaulted')),
  accumulated_amount platform.money NOT NULL DEFAULT 0, accumulated_weight platform.weight_g NOT NULL DEFAULT 0,
  redeemed_amount platform.money NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, enrol_no),
  FOREIGN KEY (tenant_id, scheme_id) REFERENCES sales.chit_scheme(tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES masters.customer(tenant_id, id)
);
CREATE TABLE sales.chit_instalment (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  enrolment_id uuid NOT NULL, instalment_no int NOT NULL, paid_on date NOT NULL,
  amount platform.money NOT NULL, mode text NOT NULL, reference text,
  rate_per_g numeric(12,2), weight_credited platform.weight_g,
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, enrolment_id, instalment_no),
  FOREIGN KEY (tenant_id, enrolment_id) REFERENCES sales.chit_enrolment(tenant_id, id)
);
ALTER TABLE sales.invoice_payment ADD FOREIGN KEY (tenant_id, chit_enrolment_id) REFERENCES sales.chit_enrolment(tenant_id, id);

-- =====================================================================
-- GUARDRAILS (the only logic in this schema)
-- =====================================================================

-- G1. Counter can only advance by exactly 1, never rewind; series rows start at 1. (INV-1)
CREATE FUNCTION sales.doc_series_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.next_no <> 1 THEN RAISE EXCEPTION 'series must start at 1 (INV-1)'; END IF;
  ELSIF NEW.next_no <> OLD.next_no + 1 OR (to_jsonb(NEW) - 'next_no') <> (to_jsonb(OLD) - 'next_no') THEN
    RAISE EXCEPTION 'series counter may only advance by 1 (INV-1)';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER doc_series_guard BEFORE INSERT OR UPDATE ON sales.doc_series FOR EACH ROW EXECUTE FUNCTION sales.doc_series_guard();

-- G2. A number allocated for a gapless series must be used by a document before COMMIT (deferred). (INV-1)
CREATE FUNCTION sales.doc_series_used() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = sales, platform, pg_temp AS $$  -- deferred: runs at COMMIT under whatever role is active then
DECLARE cur sales.doc_series;
BEGIN
  SELECT * INTO cur FROM sales.doc_series WHERE tenant_id = NEW.tenant_id AND branch_id = NEW.branch_id
     AND doc_type = NEW.doc_type AND fy = NEW.fy;
  IF cur.doc_type = 'tax_invoice' AND NOT EXISTS (SELECT 1 FROM sales.invoice WHERE tenant_id = cur.tenant_id
       AND branch_id = cur.branch_id AND fy = cur.fy AND doc_seq = cur.next_no - 1) THEN
    RAISE EXCEPTION 'invoice number % allocated but not used (would create a gap, INV-1)', cur.next_no - 1;
  ELSIF cur.doc_type = 'credit_note' AND NOT EXISTS (SELECT 1 FROM sales.credit_note WHERE tenant_id = cur.tenant_id
       AND branch_id = cur.branch_id AND fy = cur.fy AND doc_seq = cur.next_no - 1) THEN
    RAISE EXCEPTION 'credit note number % allocated but not used (would create a gap, INV-1)', cur.next_no - 1;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER doc_series_used AFTER UPDATE ON sales.doc_series
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION sales.doc_series_used();

-- G3. Issued documents: only sales_writer inserts; number must be the one just allocated in this
--     transaction's series and FY must match the document date. Afterwards immutable except the
--     issued -> cancelled transition (which must point at a cancellation credit note) and IRN stamping. (INV-2/INV-4)
CREATE FUNCTION sales.issued_doc_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_type text := TG_ARGV[0]; v_next int; v_free text[];
BEGIN
  IF current_user <> 'sales_writer' THEN
    RAISE EXCEPTION '% on sales.% requires the sales module role (INV-2/INV-4)', TG_OP, TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'INSERT' THEN
    -- doc_date is the server's Asia/Kolkata date at issue; any client value is overwritten (no offline/back-dated bills)
    NEW.doc_date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
    IF NEW.fy <> platform.fy_of(NEW.doc_date) THEN RAISE EXCEPTION 'fy % does not match doc_date %', NEW.fy, NEW.doc_date; END IF;
    SELECT next_no INTO v_next FROM sales.doc_series WHERE tenant_id = NEW.tenant_id AND branch_id = NEW.branch_id
       AND doc_type = v_type AND fy = NEW.fy;
    IF v_next IS NULL OR NEW.doc_seq <> v_next - 1 THEN
      RAISE EXCEPTION 'doc_seq % is not the number allocated from sales.doc_series (INV-1)', NEW.doc_seq;
    END IF;
    NEW.issued_at := now();
    RETURN NEW;
  END IF;
  v_free := CASE v_type WHEN 'tax_invoice' THEN ARRAY['status','cancelled_at','cancel_credit_note_id','irn','irn_ack_at']
                        ELSE ARRAY['balance_available'] END;
  IF (to_jsonb(NEW) - v_free) IS DISTINCT FROM (to_jsonb(OLD) - v_free) THEN
    RAISE EXCEPTION 'issued % % is immutable (INV-4)', v_type, OLD.doc_no;
  END IF;
  IF v_type = 'tax_invoice' THEN
    IF OLD.status = 'cancelled' AND (NEW.status, NEW.cancel_credit_note_id) IS DISTINCT FROM (OLD.status, OLD.cancel_credit_note_id) THEN
      RAISE EXCEPTION 'cancelled invoice % cannot change status', OLD.doc_no;
    END IF;
    IF OLD.status = 'cancelled' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN   -- N10: cancelled = fully frozen
      RAISE EXCEPTION 'cancelled invoice % is frozen', OLD.doc_no;
    END IF;
    IF OLD.irn IS NOT NULL AND (NEW.irn, NEW.irn_ack_at) IS DISTINCT FROM (OLD.irn, OLD.irn_ack_at) THEN
      RAISE EXCEPTION 'IRN of invoice % is already stamped', OLD.doc_no;
    END IF;
    IF NEW.status = 'cancelled' AND OLD.status = 'issued' AND NOT EXISTS (
         SELECT 1 FROM sales.credit_note c WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.cancel_credit_note_id
           AND c.invoice_id = NEW.id AND c.kind = 'cancellation') THEN
      RAISE EXCEPTION 'invoice % can only be cancelled by a cancellation credit note (INV-4)', OLD.doc_no;
    END IF;
  ELSIF NEW.balance_available > OLD.balance_available THEN
    RAISE EXCEPTION 'credit note balance can only decrease';
  ELSIF NEW.balance_available < OLD.balance_available
        AND OLD.balance_available - NEW.balance_available > (
          SELECT coalesce(sum(p.amount), 0) FROM sales.invoice_payment p JOIN sales.invoice i
              ON i.tenant_id = p.tenant_id AND i.id = p.invoice_id
           WHERE p.tenant_id = NEW.tenant_id AND p.credit_note_id = NEW.id AND p.mode = 'credit_note' AND i.issued_at = now()) THEN
    RAISE EXCEPTION 'credit note % redemption exceeds the credit_note payments of the invoice issued in this transaction', OLD.doc_no;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoice_guard BEFORE INSERT OR UPDATE ON sales.invoice
  FOR EACH ROW EXECUTE FUNCTION sales.issued_doc_guard('tax_invoice');
CREATE TRIGGER credit_note_guard BEFORE INSERT OR UPDATE ON sales.credit_note
  FOR EACH ROW EXECUTE FUNCTION sales.issued_doc_guard('credit_note');

-- G4. Child rows: only sales_writer, only in the transaction that issued the parent (parent.issued_at is
--     forced to now() = transaction start, stable across savepoints), never updated.
CREATE FUNCTION sales.child_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_issued timestamptz;
BEGIN
  IF TG_OP <> 'INSERT' OR current_user <> 'sales_writer' THEN
    RAISE EXCEPTION '% on sales.% is not allowed (INV-2/INV-4)', TG_OP, TG_TABLE_NAME;
  END IF;
  EXECUTE TG_ARGV[0] INTO v_issued USING NEW.tenant_id, to_jsonb(NEW);
  IF v_issued IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'rows can only be added to sales.% in the transaction that issued the parent (INV-4)', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER child_guard BEFORE INSERT OR UPDATE ON sales.invoice_line FOR EACH ROW EXECUTE FUNCTION sales.child_guard(
  'SELECT issued_at FROM sales.invoice WHERE tenant_id = $1 AND id = ($2->>''invoice_id'')::uuid');
CREATE TRIGGER child_guard BEFORE INSERT OR UPDATE ON sales.invoice_old_metal FOR EACH ROW EXECUTE FUNCTION sales.child_guard(
  'SELECT issued_at FROM sales.invoice WHERE tenant_id = $1 AND id = ($2->>''invoice_id'')::uuid');
CREATE TRIGGER child_guard BEFORE INSERT OR UPDATE ON sales.invoice_payment FOR EACH ROW EXECUTE FUNCTION sales.child_guard(
  'SELECT issued_at FROM sales.invoice WHERE tenant_id = $1 AND id = ($2->>''invoice_id'')::uuid');
CREATE TRIGGER child_guard BEFORE INSERT OR UPDATE ON sales.invoice_line_tax FOR EACH ROW EXECUTE FUNCTION sales.child_guard(
  'SELECT i.issued_at FROM sales.invoice_line l JOIN sales.invoice i ON i.tenant_id = l.tenant_id AND i.id = l.invoice_id
    WHERE l.tenant_id = $1 AND l.id = ($2->>''invoice_line_id'')::uuid');
CREATE TRIGGER child_guard BEFORE INSERT OR UPDATE ON sales.credit_note_line FOR EACH ROW EXECUTE FUNCTION sales.child_guard(
  'SELECT issued_at FROM sales.credit_note WHERE tenant_id = $1 AND id = ($2->>''credit_note_id'')::uuid');

-- G4b. Advance redemption: balance can only DECREASE by at most the advance payments recorded on the invoice
--      issued in this same transaction (insert the invoice_payment first, then decrement). CHECK keeps it >= 0.
--      Increases (restoring an advance after a cancellation) only alongside a cancellation credit note in this tx.
CREATE FUNCTION sales.advance_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_paid numeric;
BEGIN
  IF NEW.balance = OLD.balance THEN RETURN NEW; END IF;
  IF current_user <> 'sales_writer' THEN RAISE EXCEPTION 'advance balance changes only via the sales module role'; END IF;
  IF NEW.balance < OLD.balance THEN
    SELECT coalesce(sum(p.amount), 0) INTO v_paid FROM sales.invoice_payment p
      JOIN sales.invoice i ON i.tenant_id = p.tenant_id AND i.id = p.invoice_id
     WHERE p.tenant_id = NEW.tenant_id AND p.advance_id = NEW.id AND p.mode = 'advance' AND i.issued_at = now();
    IF OLD.balance - NEW.balance > v_paid THEN
      RAISE EXCEPTION 'advance % redemption % exceeds advance payments % on the invoice issued in this transaction',
        OLD.receipt_no, OLD.balance - NEW.balance, v_paid;
    END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM sales.credit_note c JOIN sales.invoice_payment p
                      ON p.tenant_id = c.tenant_id AND p.invoice_id = c.invoice_id AND p.advance_id = NEW.id
                     WHERE c.tenant_id = NEW.tenant_id AND c.kind = 'cancellation' AND c.issued_at = now()) THEN
    RAISE EXCEPTION 'advance balance may only be restored together with a cancellation credit note';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER advance_guard BEFORE UPDATE ON sales.advance FOR EACH ROW EXECUTE FUNCTION sales.advance_guard();

-- G5. No DELETE / TRUNCATE of issued documents or counters, for any role including the owner. (INV-4)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['invoice','invoice_line','invoice_line_tax','invoice_old_metal','invoice_payment',
                           'credit_note','credit_note_line','doc_series'] LOOP
    EXECUTE format('CREATE TRIGGER no_delete BEFORE DELETE ON sales.%I FOR EACH ROW EXECUTE FUNCTION platform.forbid()', t);
    EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON sales.%I FOR EACH STATEMENT EXECUTE FUNCTION platform.forbid()', t);
  END LOOP;
END $$;

-- G6. Audit (hash-chained, INV-3)
SELECT platform.enable_audit('sales.invoice');
SELECT platform.enable_audit('sales.credit_note');
SELECT platform.enable_audit('sales.advance');
SELECT platform.enable_audit('sales.doc_series');

-- G7. INV-5: every credit note enqueues exactly one owner/branch-admin alert in the SAME transaction.
--     The function is owned by notifications_writer, the only role with INSERT on outbox.alert_type, so this trigger is the only possible writer of these alerts; a unique index makes it one per note.
CREATE FUNCTION notifications.credit_note_alert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = notifications, sales, pg_temp AS $$
BEGIN
  INSERT INTO notifications.outbox(tenant_id, topic, payload, priority, ref_type, ref_id, alert_type)
  SELECT NEW.tenant_id, CASE NEW.kind WHEN 'cancellation' THEN 'alert.invoice_cancelled' ELSE 'alert.sales_return' END,
         jsonb_build_object('credit_note_id', NEW.id, 'credit_note_no', NEW.doc_no, 'invoice_id', NEW.invoice_id,
                            'invoice_no', i.doc_no, 'amount', NEW.total, 'reason', NEW.reason,
                            'user_id', NEW.created_by, 'branch_id', NEW.branch_id, 'at', NEW.issued_at), 1,
         'credit_note', NEW.id, CASE NEW.kind WHEN 'cancellation' THEN 'invoice_cancelled' ELSE 'sales_return' END
  FROM sales.invoice i WHERE i.tenant_id = NEW.tenant_id AND i.id = NEW.invoice_id;
  RETURN NULL;
END $$;
ALTER FUNCTION notifications.credit_note_alert() OWNER TO notifications_writer;
CREATE TRIGGER credit_note_alert AFTER INSERT ON sales.credit_note FOR EACH ROW EXECUTE FUNCTION notifications.credit_note_alert();
