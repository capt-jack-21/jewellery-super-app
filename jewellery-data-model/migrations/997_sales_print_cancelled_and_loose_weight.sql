-- 997_sales_print_cancelled_and_loose_weight.sql — cancelled-before-print invoices; zero-piece weight-only loose sales.
-- TEST DB ONLY. 991–996 (distributed hashes) and applied migrations are untouched. No new functions or triggers.
--
-- 1. doc_cancelled is an immutable print-time snapshot, NOT a FK to mutable invoice.status (old originals must remain valid after
--    a later cancellation). Existing print rows get false: preserve their history, do not claim they were printed after cancellation.
--    New invoice prints verify tenant, document id, branch and current status through a RESTRICTIVE INSERT policy. App should lock
--    the invoice row (FOR SHARE) in its print transaction to serialize with cancellation. Renderer stamps CANCELLED when true.
--    Cancelled invoices: every copy DUPLICATE, INCLUDING print 1, with the existing 3–200 character reason.
--    Non-cancelled invoices: print 1 ORIGINAL, all later prints DUPLICATE (unchanged). print_no >= 1, per-document UNIQUE, printed_by,
--    branch / tenant / partner RLS, printed_at default, append-only grants and zz_audit unchanged. Contiguous max+1 stays app-enforced.
--    Other types (credit_note, estimate, payment_receipt) retain the original rule and must use doc_cancelled=false; this is a BILL
--    cancellation rule, not estimate-status rendering. Credit notes / receipts have no cancelled status; cancelled estimates remain
--    estimates (first ORIGINAL, later DUPLICATE). Their app template may show estimate status separately.
ALTER TABLE sales.document_print ADD COLUMN doc_cancelled boolean NOT NULL DEFAULT false;
ALTER TABLE sales.document_print DROP CONSTRAINT document_print_original_check;
ALTER TABLE sales.document_print ADD CONSTRAINT document_print_original_check CHECK (
  (doc_type = 'invoice' OR NOT doc_cancelled)
  AND CASE WHEN doc_cancelled THEN copy = 'duplicate' ELSE (print_no = 1) = (copy = 'original') END);
CREATE POLICY print_cancelled_snapshot ON sales.document_print AS RESTRICTIVE FOR INSERT
  WITH CHECK (doc_type <> 'invoice'
              OR EXISTS (SELECT 1 FROM sales.invoice i WHERE i.tenant_id = document_print.tenant_id AND i.id = document_print.doc_id
                         AND i.branch_id = document_print.branch_id AND (i.status = 'cancelled') = document_print.doc_cancelled));
GRANT INSERT (doc_cancelled) ON sales.document_print TO sales_writer;
COMMENT ON COLUMN sales.document_print.doc_cancelled IS 'Print-time invoice cancellation snapshot (verified by INSERT policy). True => DUPLICATE stamped CANCELLED, even print 1, with a reason. Other doc types false. Old print history is never rewritten. Renderer stamps CANCELLED; app locks invoice FOR SHARE when printing.';

-- 2. ONE of the 19 NOT VALID Sales constraints is replaced, still NOT VALID (legacy rows are NOT scanned or rewritten).
--    The original net<=gross, stone<=gross and chargeable=net+wastage checks remain. Only stock_kind loose can use pieces=0,
--    with positive net weight; NULL legacy stock_kind is NOT treated as loose (IS NOT DISTINCT FROM avoids NULL passing a CHECK).
--    All physical goods require positive gross weight (reject zero-weight sales); service lines keep their zero-weight behaviour
--    and pieces>=1. No new NOT VALID constraint: the count stays 19 until Wheeljack validates the two separate approved constraints.
ALTER TABLE sales.invoice_line DROP CONSTRAINT invoice_line_weights_check;
ALTER TABLE sales.invoice_line ADD CONSTRAINT invoice_line_weights_check CHECK (
    net_wt <= gross_wt AND stone_wt <= gross_wt
    AND (chargeable_wt IS NULL OR chargeable_wt = net_wt + wastage_wt)
    AND (line_kind = 'service' OR gross_wt > 0)
    AND (pieces >= 1 OR (stock_kind IS NOT DISTINCT FROM 'loose' AND pieces = 0 AND net_wt > 0))) NOT VALID;
-- Restock audit (no widening needed elsewhere): credit_note_line has NO pieces/weight fields, only its immutable invoice_line_id
-- FK and UNIQUE(invoice_line_id) (whole-line return). App takes the original line's pieces/weights and emits a sales_return or
-- cancel_reversal stock_ledger row: direction=+1, pieces=0, positive grams, tag_id NULL, item/purity, source_module=sales,
-- source_type=credit_note, source_id=credit_note.id; consistency with original line and ledger source is app-enforced (no cross-row
-- trigger). 080 stock_ledger already defaults pieces to 0 and has no positive-pieces constraint. 988 location_move accepts pieces=0
-- if gross_wt>0; lot_line permits pieces>=0. 987 tag_pieces_check remains >=1; tag invoice lines cannot use zero pieces.
-- Neither invoice_line_stock_check nor invoice_old_metal_required_check (the two approved VALIDATE constraints) is changed.
