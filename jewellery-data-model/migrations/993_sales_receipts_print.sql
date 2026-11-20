-- 993_sales_receipts_print.sql — Sales scope S1–S23, part 3 of 3: stored balance due for part-paid / credit bills, later payment
--   receipts with split tenders, print / DUPLICATE log, balance and bill-list views.
-- TEST DB ONLY until Adithya approves a dev redeploy. No new functions or triggers beyond aa_version / zz_audit;
-- "same transaction" and "only once" rules are RESTRICTIVE policies + grants (pattern of 988).

-- ---------- 1. sales.invoice_due: current balance of a bill issued with balance_due > 0 (part-paid or credit sale) ----------
-- invoice.balance_due is the balance AT ISSUE and immutable. The app creates this row in the issuing transaction and later moves
-- money between buckets; the CHECK keeps original_due = balance_due + received_after_issue + due_reduced, balance never < 0.
-- Receipt:     UPDATE sales.invoice_due SET balance_due = balance_due - :amt, received_after_issue = received_after_issue + :amt,
--                last_receipt_id = :rid, updated_at = now() WHERE tenant_id = .. AND invoice_id = .. AND balance_due >= :amt  -> rowCount 1
-- Credit note: same with due_reduced instead of received_after_issue (credit_note.due_reduced).
CREATE TABLE sales.invoice_due (
  tenant_id            uuid NOT NULL REFERENCES platform.tenant(id),
  id                   uuid NOT NULL DEFAULT platform.uuid_v7(),
  branch_id            uuid NOT NULL,
  invoice_id           uuid NOT NULL,
  customer_id          uuid NOT NULL,                    -- a bill with a balance always has a customer to follow up
  original_due         platform.money NOT NULL CONSTRAINT invoice_due_original_check CHECK (original_due > 0),
  balance_due          platform.money NOT NULL CONSTRAINT invoice_due_balance_check CHECK (balance_due >= 0),
  received_after_issue platform.money NOT NULL DEFAULT 0 CONSTRAINT invoice_due_received_check CHECK (received_after_issue >= 0),
  due_reduced          platform.money NOT NULL DEFAULT 0 CONSTRAINT invoice_due_reduced_check CHECK (due_reduced >= 0),
  last_receipt_id      uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  version              int NOT NULL DEFAULT 1,
  CONSTRAINT invoice_due_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT invoice_due_invoice_uq UNIQUE (tenant_id, invoice_id),
  CONSTRAINT invoice_due_buckets_check CHECK (balance_due + received_after_issue + due_reduced = original_due),
  CONSTRAINT invoice_due_branch_fk FOREIGN KEY (tenant_id, branch_id) REFERENCES platform.branch(tenant_id, id),
  CONSTRAINT invoice_due_invoice_fk FOREIGN KEY (tenant_id, invoice_id) REFERENCES sales.invoice(tenant_id, id),
  CONSTRAINT invoice_due_customer_fk FOREIGN KEY (tenant_id, customer_id) REFERENCES masters.customer(tenant_id, id)
);
CREATE INDEX invoice_due_open_idx ON sales.invoice_due (tenant_id, branch_id, customer_id) WHERE balance_due > 0;
CREATE TRIGGER aa_version BEFORE INSERT OR UPDATE ON sales.invoice_due FOR EACH ROW EXECUTE FUNCTION platform.bump_version();
SELECT platform.enable_audit('sales.invoice_due');

-- ---------- 2. sales.payment_receipt: payment received later against a bill (append-only; own counter, gaps allowed) ----------
CREATE TABLE sales.payment_receipt (
  tenant_id     uuid NOT NULL REFERENCES platform.tenant(id),
  id            uuid NOT NULL DEFAULT platform.uuid_v7(),
  branch_id     uuid NOT NULL,
  fy            text NOT NULL,
  receipt_no    text NOT NULL,                             -- shop_setting.receipt_no_format + platform.doc_counter 'sales_receipt'
  received_on   date NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Kolkata')::date,   -- server-assigned (not in the INSERT grant)
  received_at   timestamptz NOT NULL DEFAULT now(),                                -- server-assigned (not in the INSERT grant)
  received_by   uuid NOT NULL,                             -- = session user (policy)
  invoice_id    uuid NOT NULL,
  customer_id   uuid NOT NULL,
  total         platform.money NOT NULL,                   -- = sum of its tenders (app); negative only on a reversal
  note          text,
  -- reversal (lead decision 9 Nov 2026): a wrong receipt is never edited or deleted; a REVERSAL receipt is appended with
  -- total = -original total, same invoice, a reason, and no tenders. Each receipt can be reversed at most once; a reversal
  -- cannot be reversed. Same invoice + same amount are enforced by the composite FK below (no trigger).
  reverses_receipt_id uuid,
  reversed_total      platform.money,                      -- = the original receipt's total (FK target), > 0
  reversal_reason     text,
  CONSTRAINT payment_receipt_total_check CHECK (
        (reverses_receipt_id IS NULL AND reversed_total IS NULL AND reversal_reason IS NULL AND total > 0)
     OR (reverses_receipt_id IS NOT NULL AND reversed_total > 0 AND total = -reversed_total
         AND length(trim(coalesce(reversal_reason, ''))) BETWEEN 5 AND 200)),
  CONSTRAINT payment_receipt_reversal_key UNIQUE (tenant_id, id, invoice_id, total),
  CONSTRAINT payment_receipt_reverses_uq UNIQUE (tenant_id, reverses_receipt_id),
  CONSTRAINT payment_receipt_reverses_fk FOREIGN KEY (tenant_id, reverses_receipt_id, invoice_id, reversed_total)
        REFERENCES sales.payment_receipt(tenant_id, id, invoice_id, total),
  CONSTRAINT payment_receipt_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT payment_receipt_no_uq UNIQUE (tenant_id, receipt_no),
  CONSTRAINT payment_receipt_fy_check CHECK (fy ~ '^[0-9]{4}-[0-9]{2}$' AND fy = platform.fy_of(received_on)),
  CONSTRAINT payment_receipt_branch_fk FOREIGN KEY (tenant_id, branch_id) REFERENCES platform.branch(tenant_id, id),
  CONSTRAINT payment_receipt_invoice_fk FOREIGN KEY (tenant_id, invoice_id) REFERENCES sales.invoice(tenant_id, id),
  CONSTRAINT payment_receipt_customer_fk FOREIGN KEY (tenant_id, customer_id) REFERENCES masters.customer(tenant_id, id),
  CONSTRAINT payment_receipt_received_by_fk FOREIGN KEY (tenant_id, received_by) REFERENCES platform.app_user(tenant_id, id)
);
CREATE INDEX payment_receipt_invoice_idx ON sales.payment_receipt (tenant_id, invoice_id);
CREATE INDEX payment_receipt_date_idx ON sales.payment_receipt (tenant_id, branch_id, received_on);
ALTER TABLE sales.invoice_due ADD CONSTRAINT invoice_due_last_receipt_fk FOREIGN KEY (tenant_id, last_receipt_id) REFERENCES sales.payment_receipt(tenant_id, id);
SELECT platform.enable_audit('sales.payment_receipt');
COMMENT ON COLUMN sales.payment_receipt.reverses_receipt_id IS 'Set on a reversal receipt (sales.receipt.reverse): the receipt it reverses. FK (tenant_id, reverses_receipt_id, invoice_id, reversed_total) -> (tenant_id, id, invoice_id, total) forces same invoice and same amount; total = -reversed_total; reversed_total > 0 so a reversal cannot be reversed; UNIQUE = at most once. Reversals carry no tenders. The app restores the due: UPDATE invoice_due SET balance_due = balance_due + x, received_after_issue = received_after_issue - x WHERE received_after_issue >= x (rowCount 1). If the original had credit_note tenders, the app also issues one credit note of kind receipt_reversal for their sum (995).';

CREATE TABLE sales.payment_receipt_tender (                -- split tenders of a receipt; insert-only, same transaction as the receipt
  tenant_id       uuid NOT NULL REFERENCES platform.tenant(id),
  id              uuid NOT NULL DEFAULT platform.uuid_v7(),
  receipt_id      uuid NOT NULL,
  line_no         int NOT NULL CONSTRAINT payment_receipt_tender_line_check CHECK (line_no >= 1),
  mode            text NOT NULL CONSTRAINT payment_receipt_tender_mode_check
                  CHECK (mode IN ('cash','upi','debit_card','credit_card','bank_transfer','cheque','credit_note')),
  payment_mode_id uuid,                                   -- masters.payment_mode picked, if any
  card_machine_id uuid,
  reference       text,                                   -- UTR / approval code / cheque no.
  cheque_date     date,
  bank_name       text,
  credit_note_id  uuid,                                   -- store credit used (mode credit_note) — hook, see policy below
  amount          platform.money NOT NULL CONSTRAINT payment_receipt_tender_amount_check CHECK (amount > 0),
  CONSTRAINT payment_receipt_tender_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT payment_receipt_tender_line_uq UNIQUE (tenant_id, receipt_id, line_no),
  CONSTRAINT payment_receipt_tender_credit_note_check CHECK ((mode = 'credit_note') = (credit_note_id IS NOT NULL)),
  CONSTRAINT payment_receipt_tender_cheque_check CHECK (mode = 'cheque' OR cheque_date IS NULL),
  CONSTRAINT payment_receipt_tender_receipt_fk FOREIGN KEY (tenant_id, receipt_id) REFERENCES sales.payment_receipt(tenant_id, id),
  CONSTRAINT payment_receipt_tender_mode_fk FOREIGN KEY (tenant_id, payment_mode_id) REFERENCES masters.payment_mode(tenant_id, id),
  CONSTRAINT payment_receipt_tender_machine_fk FOREIGN KEY (tenant_id, card_machine_id) REFERENCES masters.card_machine(tenant_id, id),
  CONSTRAINT payment_receipt_tender_cn_fk FOREIGN KEY (tenant_id, credit_note_id) REFERENCES sales.credit_note(tenant_id, id)
);
CREATE INDEX payment_receipt_tender_receipt_idx ON sales.payment_receipt_tender (tenant_id, receipt_id);
SELECT platform.enable_audit('sales.payment_receipt_tender');

-- ---------- 3. sales.document_print: every print; print 1 = ORIGINAL, later prints DUPLICATE with a reason ----------
CREATE TABLE sales.document_print (
  tenant_id        uuid NOT NULL REFERENCES platform.tenant(id),
  id               uuid NOT NULL DEFAULT platform.uuid_v7(),
  branch_id        uuid NOT NULL,                         -- branch of the document (branch_scope)
  doc_type         text NOT NULL CONSTRAINT document_print_doc_type_check CHECK (doc_type IN ('invoice','credit_note','estimate','payment_receipt')),
  doc_id           uuid NOT NULL,                         -- polymorphic (no FK): id in the table named by doc_type
  print_no         int NOT NULL CONSTRAINT document_print_print_no_check CHECK (print_no >= 1),   -- app: max + 1; 23505 = retry
  copy             text NOT NULL CONSTRAINT document_print_copy_check CHECK (copy IN ('original','duplicate')),
  paper            text NOT NULL CONSTRAINT document_print_paper_check CHECK (paper IN ('A4','A5','thermal_80mm')),
  language         text,
  numerals         text,
  template_id      uuid,                                  -- branding.print_template
  template_version int,
  reprint_reason   text,
  printed_by       uuid NOT NULL,                         -- = session user (policy)
  printed_at       timestamptz NOT NULL DEFAULT now(),    -- server-assigned (not in the INSERT grant)
  CONSTRAINT document_print_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT document_print_no_uq UNIQUE (tenant_id, doc_type, doc_id, print_no),
  CONSTRAINT document_print_original_check CHECK ((print_no = 1) = (copy = 'original')),
  CONSTRAINT document_print_reason_check CHECK (copy = 'original' OR length(trim(coalesce(reprint_reason, ''))) BETWEEN 3 AND 200),
  CONSTRAINT document_print_branch_fk FOREIGN KEY (tenant_id, branch_id) REFERENCES platform.branch(tenant_id, id),
  CONSTRAINT document_print_language_fk FOREIGN KEY (language) REFERENCES platform.language(code),
  CONSTRAINT document_print_printed_by_fk FOREIGN KEY (tenant_id, printed_by) REFERENCES platform.app_user(tenant_id, id)
);
CREATE INDEX document_print_doc_idx ON sales.document_print (tenant_id, doc_type, doc_id);
SELECT platform.enable_audit('sales.document_print');

-- ---------- 4. RLS ----------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sales.invoice_due','sales.payment_receipt','sales.payment_receipt_tender','sales.document_print'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %s USING (tenant_id = platform.current_tenant()) WITH CHECK (tenant_id = platform.current_tenant())', t);
    EXECUTE format('CREATE POLICY no_partner_access ON %s AS RESTRICTIVE USING (platform.current_partner() IS NULL) WITH CHECK (platform.current_partner() IS NULL)', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['sales.invoice_due','sales.payment_receipt','sales.document_print'] LOOP
    EXECUTE format($p$CREATE POLICY branch_scope ON %s AS RESTRICTIVE
                     USING (coalesce(current_setting('app.branch_scope', true), '') = ''
                            OR branch_id::text = ANY (string_to_array(current_setting('app.branch_scope', true), ',')))$p$, t);
  END LOOP;
END $$;
-- invoice_due: only in the transaction that issued the bill, with the bill's own branch / customer / balance_due
CREATE POLICY insert_at_issue ON sales.invoice_due AS RESTRICTIVE FOR INSERT
  WITH CHECK (balance_due = original_due
              AND EXISTS (SELECT 1 FROM sales.invoice i WHERE i.tenant_id = invoice_due.tenant_id AND i.id = invoice_due.invoice_id
                          AND i.status = 'issued' AND i.issued_at = now() AND i.branch_id = invoice_due.branch_id
                          AND i.customer_id = invoice_due.customer_id AND i.balance_due = invoice_due.original_due));
-- payment_receipt: only against an issued bill that has a due row, same branch and customer; received_by = the session user.
-- A receipt paid (partly) with store credit can be reversed too (lead 9 Nov 19:56): the store-credit part is given back as a NEW
-- credit note of kind receipt_reversal (995); the original credit notes' balances stay reduced (G3 unchanged).
CREATE POLICY insert_against_due ON sales.payment_receipt AS RESTRICTIVE FOR INSERT
  WITH CHECK (received_by = platform.current_user_id()
              AND EXISTS (SELECT 1 FROM sales.invoice i JOIN sales.invoice_due d ON d.tenant_id = i.tenant_id AND d.invoice_id = i.id
                          WHERE i.tenant_id = payment_receipt.tenant_id AND i.id = payment_receipt.invoice_id AND i.status = 'issued'
                            AND i.branch_id = payment_receipt.branch_id AND d.customer_id = payment_receipt.customer_id));
-- tenders: only in the transaction that created the receipt. Store credit (mode credit_note) is a HOOK, blocked here until the lead
-- approves extending 100_sales issued_doc_guard (credit_note branch) to count payment_receipt_tender rows of this transaction;
-- without that change the credit note's balance cannot be reduced for a receipt. Lifting it = drop "AND mode <> 'credit_note'".
CREATE POLICY insert_with_receipt ON sales.payment_receipt_tender AS RESTRICTIVE FOR INSERT
  WITH CHECK (mode <> 'credit_note'
              AND EXISTS (SELECT 1 FROM sales.payment_receipt r WHERE r.tenant_id = payment_receipt_tender.tenant_id
                          AND r.id = payment_receipt_tender.receipt_id AND r.received_at = now() AND r.reverses_receipt_id IS NULL));
CREATE POLICY printed_by_self ON sales.document_print AS RESTRICTIVE FOR INSERT
  WITH CHECK (printed_by = platform.current_user_id());

-- ---------- 5. views (security_invoker: the caller's RLS applies) ----------
-- S9 / S11: current balance and payment status of every bill
CREATE VIEW sales.v_invoice_balance WITH (security_invoker = true) AS
SELECT i.tenant_id, i.branch_id, i.id AS invoice_id, i.status, i.net_payable,
       i.paid_amount                                                        AS paid_at_issue,
       coalesce(r.receipts_total, 0)::numeric(14,2)                         AS receipts_total,
       coalesce(cn.refunded_total, 0)::numeric(14,2)                        AS refunded_total,
       coalesce(d.due_reduced, 0)::numeric(14,2)                            AS credited_to_due,
       (i.paid_amount + coalesce(r.receipts_total, 0))::numeric(14,2)       AS paid_amount,
       CASE WHEN i.status = 'cancelled' THEN 0 ELSE coalesce(d.balance_due, i.balance_due) END::numeric(14,2) AS balance_due,
       CASE WHEN i.status = 'cancelled' THEN 'cancelled'
            WHEN coalesce(d.balance_due, i.balance_due) = 0 THEN 'paid'
            WHEN i.paid_amount + coalesce(r.receipts_total, 0) = 0 THEN 'unpaid'
            ELSE 'part_paid' END                                            AS payment_status,
       (i.cash_amount + coalesce(r.cash_total, 0))::numeric(14,2)           AS cash_total
FROM sales.invoice i
LEFT JOIN sales.invoice_due d ON d.tenant_id = i.tenant_id AND d.invoice_id = i.id
LEFT JOIN LATERAL (SELECT sum(pr.total) AS receipts_total,
                          sum((SELECT coalesce(sum(t.amount), 0) FROM sales.payment_receipt_tender t
                               WHERE t.tenant_id = pr.tenant_id AND t.receipt_id = pr.id AND t.mode = 'cash'
                                 AND NOT EXISTS (SELECT 1 FROM sales.payment_receipt rv WHERE rv.tenant_id = pr.tenant_id
                                                 AND rv.reverses_receipt_id = pr.id))) AS cash_total
                   FROM sales.payment_receipt pr WHERE pr.tenant_id = i.tenant_id AND pr.invoice_id = i.id) r ON true
LEFT JOIN LATERAL (SELECT sum(c.refund_amount) AS refunded_total FROM sales.credit_note c
                   WHERE c.tenant_id = i.tenant_id AND c.invoice_id = i.id) cn ON true;

-- S20 bill list
CREATE VIEW sales.v_invoice_list WITH (security_invoker = true) AS
SELECT i.tenant_id, i.branch_id, i.id AS invoice_id, i.doc_no, i.doc_date, i.fy, i.issued_at, i.status,
       i.customer_id, i.customer_snapshot->>'name' AS customer_name, i.customer_snapshot->>'phone' AS customer_phone,
       i.supply_type, i.customer_gstin, i.salesperson_id, i.zero_gst,
       (SELECT count(*) FROM sales.invoice_line l WHERE l.tenant_id = i.tenant_id AND l.invoice_id = i.id)::int AS line_count,
       i.invoice_total, i.old_metal_value, i.net_payable,
       b.paid_at_issue, b.receipts_total, b.refunded_total, b.credited_to_due, b.paid_amount, b.balance_due, b.payment_status, b.cash_total
FROM sales.invoice i
JOIN sales.v_invoice_balance b ON b.tenant_id = i.tenant_id AND b.invoice_id = i.id;

-- ---------- 6. grants ----------
REVOKE ALL ON sales.invoice_due, sales.payment_receipt, sales.payment_receipt_tender, sales.document_print,
              sales.v_invoice_balance, sales.v_invoice_list FROM PUBLIC, app_rw, app_ro, app_worker;
GRANT SELECT ON sales.invoice_due, sales.payment_receipt, sales.payment_receipt_tender, sales.document_print,
                sales.v_invoice_balance, sales.v_invoice_list TO app_rw, app_ro, sales_writer;
-- money documents and the print log: written only by sales_writer (SET LOCAL ROLE in the app transaction); never deleted
GRANT INSERT (tenant_id, id, branch_id, invoice_id, customer_id, original_due, balance_due) ON sales.invoice_due TO sales_writer;
GRANT UPDATE (balance_due, received_after_issue, due_reduced, last_receipt_id, updated_at) ON sales.invoice_due TO sales_writer;
GRANT INSERT (tenant_id, id, branch_id, fy, receipt_no, received_by, invoice_id, customer_id, total, note,
              reverses_receipt_id, reversed_total, reversal_reason) ON sales.payment_receipt TO sales_writer;
GRANT INSERT ON sales.payment_receipt_tender TO sales_writer;
GRANT INSERT (tenant_id, id, branch_id, doc_type, doc_id, print_no, copy, paper, language, numerals, template_id, template_version,
              reprint_reason, printed_by) ON sales.document_print TO sales_writer;
