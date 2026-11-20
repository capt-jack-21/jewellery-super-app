-- 996_sales_gstr1_exclude_receipt_reversal.sql — GSTR-1 / credit-note report excludes payment-restoration notes.
-- TEST DB ONLY until approved for dev. Lead decision / Ironhide request 10 Nov 2026.
-- 140_reports.sql is APPLIED and immutable; 995's distributed hash is also left untouched.
-- No new functions / triggers / grants. CREATE OR REPLACE preserves view OID, ownership, ACL and dependencies;
-- security_invoker stays true (caller RLS), security_barrier stays as before (unset). All existing columns keep name/order/type.
--
-- gstr1_doc_summary has document counts, NOT tax amount columns. hsn_summary / daily_sales have invoice amounts only;
-- there is no separate CDNR / CDNUR view. cancellations is the sole credit-note amount/list report: filter it too so consumers
-- aggregating its total exclude receipt_reversal. It has no tax-breakdown columns; tax exports aggregating credit-note buckets
-- must use the same kind <> 'receipt_reversal' predicate (app/reports contract).
--
-- IMPORTANT: filter the count, NOT the source rows for the document summary: from_no/to_no still cover the entire numbered series,
-- including excluded receipt_reversal notes at the ends. Series/gap views from 140 are deliberately UNCHANGED and see ALL kinds.
-- Existing total convention is preserved: includes cancelled tax invoices; credit-note total counts only tax-facing note kinds.
-- New appended bigint columns:
--   excluded_receipt_reversal_count = omitted note count (0 for invoices)
--   total_in_series = actual document rows of ALL kinds, including cancelled/excluded (not missing sequence numbers)
-- Reconciliation: total_in_series = (total - cancelled) + cancelled + excluded_receipt_reversal_count.
-- A numerical range containing real gaps also needs reports.series_summary.gap_count; excluding a payment reversal is NOT a gap.
CREATE OR REPLACE VIEW reports.gstr1_doc_summary WITH (security_invoker = true) AS
SELECT tenant_id, branch_id, fy, 'tax_invoice' AS doc_type, min(doc_no) AS from_no, max(doc_no) AS to_no,
       count(*) AS total, count(*) FILTER (WHERE status = 'cancelled') AS cancelled,
       0::bigint AS excluded_receipt_reversal_count, count(*) AS total_in_series
FROM sales.invoice GROUP BY 1,2,3
UNION ALL
SELECT tenant_id, branch_id, fy, 'credit_note', min(doc_no), max(doc_no),
       count(*) FILTER (WHERE kind <> 'receipt_reversal'), 0,
       count(*) FILTER (WHERE kind = 'receipt_reversal'), count(*)
FROM sales.credit_note GROUP BY 1,2,3;

-- Tax-facing credit-note list / amount input; series and audit views must NOT be filtered.
CREATE OR REPLACE VIEW reports.cancellations WITH (security_invoker = true) AS
SELECT c.tenant_id, c.branch_id, c.doc_no AS credit_note_no, c.kind, i.doc_no AS invoice_no, c.total, c.reason, c.created_by, c.issued_at
FROM sales.credit_note c JOIN sales.invoice i ON i.tenant_id = c.tenant_id AND i.id = c.invoice_id
WHERE c.kind <> 'receipt_reversal';
