-- 994_sales_store_credit_receipts.sql — Sales scope S9/S12 (lead decision 9 Nov 2026): store credit can be tendered on a later
-- payment receipt. TEST DB ONLY until Adithya approves a dev redeploy (via Ultra Magnus). 100_sales.sql is applied and immutable:
-- the guard is replaced here with CREATE OR REPLACE FUNCTION (same signature, same triggers invoice_guard / credit_note_guard).
--
-- The ONLY change to sales.issued_doc_guard() (G3), credit_note UPDATE branch: a decrease of credit_note.balance_available is
-- now bounded by the credit_note tenders of the invoice issued in this transaction (unchanged) PLUS the credit_note tenders
-- (sales.payment_receipt_tender, mode credit_note, this credit note) of receipts recorded in this transaction (received_at = now()).
-- Everything else (INSERT rules, invoice immutability / cancel / IRN rules, "balance can only decrease") is byte-identical to 100.
-- The error message of that one branch names receipts too.
--
-- App flow for a store-credit tender on a receipt (one transaction, SET LOCAL ROLE sales_writer):
--   INSERT payment_receipt; INSERT payment_receipt_tender (mode credit_note, credit_note_id);
--   UPDATE sales.credit_note SET balance_available = balance_available - :amt WHERE tenant_id = :t AND id = :cn AND balance_available >= :amt
--     -> rowCount must be 1 (else insufficient store credit); grant: UPDATE (balance_available) to sales_writer (900/960, unchanged);
--   UPDATE sales.invoice_due ... (guarded, as for any receipt).
-- No new function, no new trigger. sales_writer already has SELECT on payment_receipt / payment_receipt_tender (993).

CREATE OR REPLACE FUNCTION sales.issued_doc_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
           WHERE p.tenant_id = NEW.tenant_id AND p.credit_note_id = NEW.id AND p.mode = 'credit_note' AND i.issued_at = now())
        + (SELECT coalesce(sum(t.amount), 0) FROM sales.payment_receipt_tender t JOIN sales.payment_receipt r
              ON r.tenant_id = t.tenant_id AND r.id = t.receipt_id
           WHERE t.tenant_id = NEW.tenant_id AND t.credit_note_id = NEW.id AND t.mode = 'credit_note' AND r.received_at = now()) THEN
    RAISE EXCEPTION 'credit note % redemption exceeds the credit_note tenders of the invoice issued / receipts recorded in this transaction', OLD.doc_no;
  END IF;
  RETURN NEW;
END $$;

-- Lift the 993 hook: tenders of mode credit_note are now allowed on a receipt (still only in the receipt's own transaction and
-- never on a reversal). The credit note must belong to the receipt's customer (credit_note.customer_id, or the customer of the
-- bill it was issued against for credit notes written before 992).
DROP POLICY insert_with_receipt ON sales.payment_receipt_tender;
CREATE POLICY insert_with_receipt ON sales.payment_receipt_tender AS RESTRICTIVE FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM sales.payment_receipt r WHERE r.tenant_id = payment_receipt_tender.tenant_id
                      AND r.id = payment_receipt_tender.receipt_id AND r.received_at = now() AND r.reverses_receipt_id IS NULL
                      AND (payment_receipt_tender.credit_note_id IS NULL OR EXISTS (
                           SELECT 1 FROM sales.credit_note c JOIN sales.invoice ci ON ci.tenant_id = c.tenant_id AND ci.id = c.invoice_id
                           WHERE c.tenant_id = payment_receipt_tender.tenant_id AND c.id = payment_receipt_tender.credit_note_id
                             AND coalesce(c.customer_id, ci.customer_id) = r.customer_id))));
