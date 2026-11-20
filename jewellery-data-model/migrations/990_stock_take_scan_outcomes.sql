-- 990_stock_take_scan_outcomes.sql — Inventory 0.8.5 follow-up (§13 item 2): store scan outcomes on
-- inventory.stock_take_scan so reloads and other phones see matched/extra + reason, and bump duplicate
-- counts without rewriting the scan row. TEST DB ONLY until Adithya approves a dev deploy through Ultra Magnus.
-- No new DB functions or triggers (stock_take_scan stays unaudited / unversioned by design).
-- 987–989 are applied on dev and immutable; this file ALTERs the 988 table and CREATE OR REPLACE-s the 989 view.

-- ---------- 1. columns (nullable first so upgrade can backfill, then NOT NULL + CHECKs) ----------
ALTER TABLE inventory.stock_take_scan
  ADD COLUMN result            text,
  ADD COLUMN extra_reason      text,
  ADD COLUMN extra_note        text,
  ADD COLUMN duplicate_count   integer NOT NULL DEFAULT 0,
  ADD COLUMN last_duplicate_at timestamptz;

COMMENT ON COLUMN inventory.stock_take_scan.result IS
  'matched = code resolved to an expected tag; extra = unexpected (unknown / other branch / other location / wrong status). Set by the app on INSERT; missing expected tags have no scan row (see v_stock_take_report).';
COMMENT ON COLUMN inventory.stock_take_scan.extra_reason IS
  'NULL when result = matched; required when result = extra. Values: unknown_code, other_branch, other_location, wrong_status.';
COMMENT ON COLUMN inventory.stock_take_scan.extra_note IS
  'Optional free text (≤40 chars) only when extra_reason = wrong_status (e.g. the tag status the app saw).';
COMMENT ON COLUMN inventory.stock_take_scan.duplicate_count IS
  'How many times this code was scanned again after the first (app bumps on unique-violation ignore); 0 = first scan only.';
COMMENT ON COLUMN inventory.stock_take_scan.last_duplicate_at IS
  'When the app last bumped duplicate_count; NULL if never re-scanned.';

-- Backfill existing rows with the same expected-set logic the 989 view used (wrong status → 'wrong_status', not status_||…).
-- Fresh installs after 988 have zero scan rows here; upgrade from a 989 DB may have some.
UPDATE inventory.stock_take_scan sc
SET result = v.result,
    extra_reason = v.extra_reason
FROM (
  SELECT sc2.tenant_id, sc2.id,
         CASE WHEN exp.tag_id IS NOT NULL THEN 'matched' ELSE 'extra' END AS result,
         CASE
           WHEN exp.tag_id IS NOT NULL THEN NULL
           WHEN sc2.tag_id IS NULL THEN 'unknown_code'
           WHEN t.branch_id IS DISTINCT FROM s.branch_id THEN 'other_branch'
           WHEN t.status NOT IN ('in_stock','reserved') THEN 'wrong_status'
           ELSE 'other_location'
         END AS extra_reason
  FROM inventory.stock_take_scan sc2
  JOIN inventory.stock_take s ON s.tenant_id = sc2.tenant_id AND s.id = sc2.stock_take_id
  LEFT JOIN inventory.tag t ON t.tenant_id = sc2.tenant_id AND t.id = sc2.tag_id
  LEFT JOIN LATERAL (
    SELECT t2.id AS tag_id
    FROM inventory.tag t2
    WHERE t2.tenant_id = sc2.tenant_id AND t2.id = sc2.tag_id
      AND t2.branch_id = s.branch_id
      AND t2.status IN ('in_stock','reserved')
      AND (s.counter_id IS NULL OR t2.counter_id = s.counter_id)
      AND (s.box_id IS NULL OR t2.box_id = s.box_id)
  ) exp ON true
  WHERE sc2.result IS NULL
) v
WHERE sc.tenant_id = v.tenant_id AND sc.id = v.id;

ALTER TABLE inventory.stock_take_scan
  ALTER COLUMN result SET NOT NULL,
  ADD CONSTRAINT stock_take_scan_result_check CHECK (result IN ('matched','extra')),
  ADD CONSTRAINT stock_take_scan_extra_reason_check
    CHECK (extra_reason IS NULL OR extra_reason IN ('unknown_code','other_branch','other_location','wrong_status')),
  ADD CONSTRAINT stock_take_scan_result_reason_chk
    CHECK ((result = 'extra') = (extra_reason IS NOT NULL)),
  ADD CONSTRAINT stock_take_scan_extra_note_check
    CHECK (extra_note IS NULL OR char_length(extra_note) <= 40),
  ADD CONSTRAINT stock_take_scan_extra_note_reason_chk
    CHECK (extra_note IS NULL OR extra_reason = 'wrong_status'),
  ADD CONSTRAINT stock_take_scan_duplicate_count_check CHECK (duplicate_count >= 0);

COMMENT ON TABLE inventory.stock_take_scan IS
  'one row per scanned code in a stock check; result/extra_reason/extra_note stored by the app; re-scan of the same code is a unique violation (app bumps duplicate_count); no audit (volume)';

-- ---------- 2. grants: column-level INSERT (never duplicate_*); UPDATE only duplicate_* ----------
-- 988 granted table-level INSERT; revoke and re-grant the allowed columns so INSERT cannot name duplicate_count / last_duplicate_at
-- (same pattern as notifications.outbox in 960). Defaults still fill those columns on insert.
REVOKE INSERT ON inventory.stock_take_scan FROM app_rw;
GRANT INSERT (tenant_id, id, stock_take_id, scanned_code, tag_id, scanned_by, scanned_at,
              result, extra_reason, extra_note) ON inventory.stock_take_scan TO app_rw;
GRANT UPDATE (duplicate_count, last_duplicate_at) ON inventory.stock_take_scan TO app_rw;

-- ---------- 3. v_stock_take_report: prefer stored scan outcomes; missing = expected tag with no scan row ----------
-- Existing columns keep name/type/order (CREATE OR REPLACE may only append). Appended: extra_note, duplicate_count, last_duplicate_at.
CREATE OR REPLACE VIEW inventory.v_stock_take_report WITH (security_invoker = true) AS
WITH expected AS (
  SELECT s.tenant_id, s.id AS stock_take_id, t.id AS tag_id
  FROM inventory.stock_take s
  JOIN inventory.tag t ON t.tenant_id = s.tenant_id AND t.branch_id = s.branch_id AND t.status IN ('in_stock','reserved')
                      AND (s.counter_id IS NULL OR t.counter_id = s.counter_id)
                      AND (s.box_id IS NULL OR t.box_id = s.box_id)
), r AS (
  SELECT e.tenant_id, e.stock_take_id, e.tag_id, sc.id AS scan_id, true AS is_expected
  FROM expected e
  LEFT JOIN inventory.stock_take_scan sc ON sc.tenant_id = e.tenant_id AND sc.stock_take_id = e.stock_take_id AND sc.tag_id = e.tag_id
  UNION ALL
  SELECT sc.tenant_id, sc.stock_take_id, sc.tag_id, sc.id, false
  FROM inventory.stock_take_scan sc
  WHERE NOT EXISTS (SELECT 1 FROM expected x WHERE x.tenant_id = sc.tenant_id AND x.stock_take_id = sc.stock_take_id AND x.tag_id = sc.tag_id)
)
SELECT s.tenant_id, s.id AS stock_take_id, s.branch_id, s.status AS stock_take_status,
       CASE WHEN r.is_expected AND r.scan_id IS NULL THEN 'missing' ELSE sc.result END AS result,
       CASE WHEN r.scan_id IS NULL THEN NULL ELSE sc.extra_reason END AS extra_reason,
       r.tag_id, t.tag_no, sc.scanned_code, sc.scanned_at, sc.scanned_by,
       t.item_id, t.purity_id, t.gross_wt, t.net_wt, t.status AS tag_status, t.branch_id AS tag_branch_id, t.counter_id, t.box_id,
       sc.extra_note, sc.duplicate_count, sc.last_duplicate_at
FROM r
JOIN inventory.stock_take s ON s.tenant_id = r.tenant_id AND s.id = r.stock_take_id
LEFT JOIN inventory.stock_take_scan sc ON sc.tenant_id = r.tenant_id AND sc.id = r.scan_id
LEFT JOIN inventory.tag t ON t.tenant_id = r.tenant_id AND t.id = r.tag_id;

COMMENT ON VIEW inventory.v_stock_take_report IS
  'Stock-check report: missing = expected tag with no scan row; matched/extra (+ extra_reason/extra_note/duplicate_*) come from stock_take_scan when a scan exists.';
