-- 995_sales_reversal_store_credit.sql — Sales: reversing a receipt that was (partly) paid with store credit.
-- TEST DB ONLY until Adithya approves a dev redeploy. Lead decision 9 Nov 2026 19:56 IST.
-- No new functions or triggers; sales.issued_doc_guard() (100 / 994) is NOT changed: credit-note balances stay decrease-only.
--
-- A receipt with credit_note tenders can now be reversed (993 policy insert_against_due no longer blocks it). The store credit it
-- consumed is NOT put back on the original credit notes (their balances stay reduced). Instead, in the reversal's transaction the
-- app issues ONE NEW credit note of kind 'receipt_reversal' for the same customer:
--   * reversal_receipt_id -> the reversal receipt (FK); UNIQUE = at most one such note per reversal.
--   * invoice_id = the original receipt's invoice (credit_note.invoice_id is NOT NULL; the policy below requires the same invoice).
--   * no credit_note_line rows (nothing is returned); taxable_value / cgst / sgst / igst / cess / round_off = 0 (CHECK): it moves money
--     already received back into store credit and is not a GST credit note. GST returns / the CDN report must skip kind 'receipt_reversal'.
--   * settlement: refund_mode 'store_credit', refund_amount 0, due_reduced 0, store_credit_amount = total > 0 (CHECK);
--     balance_available = store_credit_amount at insert (policy), then decrease-only through the unchanged guard.
--   * amount = sum of the credit_note tenders of the reversed receipt: enforced by the RESTRICTIVE INSERT policy below
--     (aggregate, so not expressible as a CHECK / FK). The reversal must be recorded in this transaction (received_at = now()),
--     same branch, invoice and customer.
--   * numbering: a real credit note — next number of the GAPLESS sales.doc_series 'credit_note' of the branch and FY (G1 / G2 / G3
--     unchanged: allocate, insert in the same transaction).
--   * INV-5: like every credit note it enqueues exactly one owner alert, of its OWN type (lead 9 Nov 20:06 IST, section 5):
--     topic alert.receipt_reversal / alert_type receipt_reversal ("Payment reversed" in the app; no title text is stored in the DB).
-- That a reversal of a store-credit receipt is ALWAYS accompanied by its note is app-enforced (the note is inserted after the
-- reversal row in the same transaction; the reversal cannot see a later row).
-- App flow (sales.receipt.reverse): allocate receipt no; INSERT reversal payment_receipt; UPDATE invoice_due (full receipt amount
-- back to balance_due, 993, unchanged); if the original had credit_note tenders: allocate doc_series credit_note; INSERT credit_note
-- (kind receipt_reversal, reversal_receipt_id, store_credit_amount = balance_available = total = sum of those tenders).

-- 1. kind 'receipt_reversal' (superset of the 100 list; legacy rows unaffected)
ALTER TABLE sales.credit_note DROP CONSTRAINT credit_note_kind_check;
ALTER TABLE sales.credit_note
  ADD COLUMN reversal_receipt_id uuid,
  ADD CONSTRAINT credit_note_kind_check CHECK (kind IN ('cancellation','sales_return','receipt_reversal')),
  ADD CONSTRAINT credit_note_reversal_uq UNIQUE (tenant_id, reversal_receipt_id),
  ADD CONSTRAINT credit_note_reversal_fk FOREIGN KEY (tenant_id, reversal_receipt_id) REFERENCES sales.payment_receipt(tenant_id, id),
  ADD CONSTRAINT credit_note_receipt_reversal_check CHECK (
        (kind = 'receipt_reversal') = (reversal_receipt_id IS NOT NULL)
    AND (reversal_receipt_id IS NULL
         OR (row_rev = 1 AND refund_mode = 'store_credit' AND refund_amount = 0 AND due_reduced = 0
             AND store_credit_amount = total AND total > 0
             AND taxable_value = 0 AND cgst = 0 AND sgst = 0 AND igst = 0 AND cess = 0 AND round_off = 0)));
COMMENT ON COLUMN sales.credit_note.reversal_receipt_id IS 'Set only on kind receipt_reversal: the reversal payment_receipt whose store-credit tenders this note gives back (995). UNIQUE: one note per reversal. Amount = sum of the credit_note tenders of the reversed receipt (policy insert_receipt_reversal).';

-- 2. total = taxable + taxes + cess + round-off for every 0.9.0 note except receipt_reversal (no tax; total = store credit, CHECK above)
ALTER TABLE sales.credit_note DROP CONSTRAINT credit_note_total_sum_check;
ALTER TABLE sales.credit_note ADD CONSTRAINT credit_note_total_sum_check
  CHECK (row_rev IS NULL OR kind = 'receipt_reversal' OR total = taxable_value + cgst + sgst + igst + cess + round_off);

-- 3. a receipt_reversal note: same transaction as its reversal, same branch / invoice / customer, exact amount, full balance
CREATE POLICY insert_receipt_reversal ON sales.credit_note AS RESTRICTIVE FOR INSERT
  WITH CHECK (reversal_receipt_id IS NULL
              OR (balance_available = store_credit_amount
                  AND EXISTS (SELECT 1 FROM sales.payment_receipt r
                              WHERE r.tenant_id = credit_note.tenant_id AND r.id = credit_note.reversal_receipt_id
                                AND r.reverses_receipt_id IS NOT NULL AND r.received_at = now()
                                AND r.branch_id = credit_note.branch_id AND r.invoice_id = credit_note.invoice_id
                                AND r.customer_id = credit_note.customer_id
                                AND credit_note.store_credit_amount = (
                                      SELECT coalesce(sum(t.amount), 0) FROM sales.payment_receipt_tender t
                                       WHERE t.tenant_id = r.tenant_id AND t.receipt_id = r.reverses_receipt_id AND t.mode = 'credit_note'))));

-- 4. grants: the 992 column-level INSERT grant lists the columns that existed then; add the new one (sales_writer only)
GRANT INSERT (reversal_receipt_id) ON sales.credit_note TO sales_writer;

-- 5. owner alert type receipt_reversal (lead 9 Nov 2026 20:06 IST). 100_sales is applied and NOT edited: the alert function is
--    replaced here. The ONLY change: both CASE expressions map kind 'receipt_reversal' to alert.receipt_reversal / receipt_reversal
--    (before: every non-cancellation kind -> sales_return). Everything else (columns, payload, priority, ref, SECURITY DEFINER,
--    search_path, owner notifications_writer, trigger) is unchanged. The outbox CHECKs from 030 are widened (old rows unaffected).
ALTER TABLE notifications.outbox DROP CONSTRAINT outbox_alert_type_check;
ALTER TABLE notifications.outbox ADD CONSTRAINT outbox_alert_type_check
  CHECK (alert_type IN ('invoice_cancelled','sales_return','receipt_reversal'));
DO $$
DECLARE c text;
BEGIN
  -- the unnamed 030 table CHECK ((topic IN (...)) = (alert_type IS NOT NULL)); exactly one such constraint
  SELECT conname INTO STRICT c FROM pg_constraint
   WHERE conrelid = 'notifications.outbox'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%topic%alert.sales_return%alert_type IS NOT NULL%';
  EXECUTE format('ALTER TABLE notifications.outbox DROP CONSTRAINT %I', c);
END $$;
ALTER TABLE notifications.outbox ADD CONSTRAINT outbox_alert_topic_check
  CHECK ((topic IN ('alert.invoice_cancelled','alert.sales_return','alert.receipt_reversal')) = (alert_type IS NOT NULL));

CREATE OR REPLACE FUNCTION notifications.credit_note_alert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = notifications, sales, pg_temp AS $$
BEGIN
  INSERT INTO notifications.outbox(tenant_id, topic, payload, priority, ref_type, ref_id, alert_type)
  SELECT NEW.tenant_id, CASE NEW.kind WHEN 'cancellation' THEN 'alert.invoice_cancelled' WHEN 'receipt_reversal' THEN 'alert.receipt_reversal' ELSE 'alert.sales_return' END,
         jsonb_build_object('credit_note_id', NEW.id, 'credit_note_no', NEW.doc_no, 'invoice_id', NEW.invoice_id,
                            'invoice_no', i.doc_no, 'amount', NEW.total, 'reason', NEW.reason,
                            'user_id', NEW.created_by, 'branch_id', NEW.branch_id, 'at', NEW.issued_at), 1,
         'credit_note', NEW.id, CASE NEW.kind WHEN 'cancellation' THEN 'invoice_cancelled' WHEN 'receipt_reversal' THEN 'receipt_reversal' ELSE 'sales_return' END
  FROM sales.invoice i WHERE i.tenant_id = NEW.tenant_id AND i.id = NEW.invoice_id;
  RETURN NULL;
END $$;
