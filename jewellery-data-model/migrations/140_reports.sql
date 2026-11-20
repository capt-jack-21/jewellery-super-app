-- 140_reports.sql — read-only views (security_invoker => caller's RLS applies). No tables in this schema.
SET search_path = reports, platform, public;

-- INV-6: gaps in every gapless series (must return zero rows)
CREATE VIEW reports.series_gaps WITH (security_invoker = true) AS
WITH issued AS (
  SELECT tenant_id, branch_id, 'tax_invoice'::text AS doc_type, fy, doc_seq FROM sales.invoice
  UNION ALL
  SELECT tenant_id, branch_id, 'credit_note', fy, doc_seq FROM sales.credit_note
)
SELECT s.tenant_id, s.branch_id, s.doc_type, s.fy, n AS missing_seq
FROM sales.doc_series s
CROSS JOIN LATERAL generate_series(1, s.next_no - 1) n
WHERE s.doc_type IN ('tax_invoice','credit_note')
  AND NOT EXISTS (SELECT 1 FROM issued i WHERE i.tenant_id = s.tenant_id AND i.branch_id = s.branch_id
                    AND i.doc_type = s.doc_type AND i.fy = s.fy AND i.doc_seq = n);

CREATE VIEW reports.series_summary WITH (security_invoker = true) AS
SELECT s.tenant_id, s.branch_id, s.doc_type, s.fy, s.prefix, s.next_no - 1 AS last_issued,
       (SELECT count(*) FROM reports.series_gaps g WHERE g.tenant_id = s.tenant_id AND g.branch_id = s.branch_id
          AND g.doc_type = s.doc_type AND g.fy = s.fy) AS gap_count
FROM sales.doc_series s WHERE s.doc_type IN ('tax_invoice','credit_note');

CREATE VIEW reports.stock_balance WITH (security_invoker = true) AS
SELECT tenant_id, branch_id, item_id, purity_id,
       sum(direction * pieces) AS pieces, sum(direction * gross_wt) AS gross_wt,
       sum(direction * net_wt) AS net_wt, sum(direction * fine_wt) AS fine_wt
FROM inventory.stock_ledger GROUP BY 1,2,3,4;

CREATE VIEW reports.daily_sales WITH (security_invoker = true) AS
SELECT tenant_id, branch_id, doc_date, count(*) FILTER (WHERE status = 'issued') AS bills,
       count(*) FILTER (WHERE status = 'cancelled') AS cancelled,
       sum(taxable_value) FILTER (WHERE status = 'issued') AS taxable,
       sum(cgst + sgst + igst) FILTER (WHERE status = 'issued') AS gst,
       sum(invoice_total) FILTER (WHERE status = 'issued') AS total
FROM sales.invoice GROUP BY 1,2,3;

CREATE VIEW reports.hsn_summary WITH (security_invoker = true) AS   -- GSTR-1 HSN table input
SELECT i.tenant_id, i.branch_id, i.fy, date_trunc('month', i.doc_date)::date AS month, l.hsn,
       sum(l.net_wt) AS net_wt, sum(l.taxable_value) AS taxable, sum(l.cgst) AS cgst, sum(l.sgst) AS sgst, sum(l.igst) AS igst
FROM sales.invoice i JOIN sales.invoice_line l ON l.tenant_id = i.tenant_id AND l.invoice_id = i.id
GROUP BY 1,2,3,4,5;

CREATE VIEW reports.gstr1_doc_summary WITH (security_invoker = true) AS  -- INV-6 cross-check
SELECT tenant_id, branch_id, fy, 'tax_invoice' AS doc_type, min(doc_no) AS from_no, max(doc_no) AS to_no,
       count(*) AS total, count(*) FILTER (WHERE status = 'cancelled') AS cancelled
FROM sales.invoice GROUP BY 1,2,3
UNION ALL
SELECT tenant_id, branch_id, fy, 'credit_note', min(doc_no), max(doc_no), count(*), 0 FROM sales.credit_note GROUP BY 1,2,3;

CREATE VIEW reports.huid_register WITH (security_invoker = true) AS
SELECT t.tenant_id, t.branch_id, t.huid, t.tag_no, t.status, t.gross_wt, t.net_wt, p.code AS purity,
       l.invoice_id, i.doc_no AS invoice_no, i.doc_date
FROM inventory.tag t JOIN masters.purity p ON p.tenant_id = t.tenant_id AND p.id = t.purity_id
LEFT JOIN sales.invoice_line l ON l.tenant_id = t.tenant_id AND l.tag_id = t.id
LEFT JOIN sales.invoice i ON i.tenant_id = l.tenant_id AND i.id = l.invoice_id
WHERE t.huid IS NOT NULL;

CREATE VIEW reports.cancellations WITH (security_invoker = true) AS
SELECT c.tenant_id, c.branch_id, c.doc_no AS credit_note_no, c.kind, i.doc_no AS invoice_no, c.total, c.reason, c.created_by, c.issued_at
FROM sales.credit_note c JOIN sales.invoice i ON i.tenant_id = c.tenant_id AND i.id = c.invoice_id;

CREATE VIEW reports.vendor_balance WITH (security_invoker = true) AS
SELECT e.tenant_id, h.vendor_id, e.metal_id, sum(e.amount_dr - e.amount_cr) AS amount_balance,
       sum(e.pure_wt_dr - e.pure_wt_cr) AS fine_wt_balance
FROM accounts.ledger_entry e JOIN accounts.account_head h ON h.tenant_id = e.tenant_id AND h.id = e.account_head_id
WHERE h.vendor_id IS NOT NULL GROUP BY 1,2,3;
