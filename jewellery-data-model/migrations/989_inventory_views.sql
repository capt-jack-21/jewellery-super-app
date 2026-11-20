-- 989_inventory_views.sql — Inventory scope I2 (label data), I4/I5 (stock by location, loose stock), I8 (stock-check report),
-- I11 (valuation), ageing, I12 (opening stock import kind). Views only (security_invoker: the caller's RLS and grants apply).
-- TEST DB ONLY until Adithya approves a dev redeploy. No functions or triggers.
-- "In stock" everywhere = tag.status NOT IN ('sold','melted','returned_to_vendor','written_off') (on approval / repair / melting / in transit /
-- reserved pieces are still the shop's stock).

-- ---------- I2 label data (what the tag printer prints) ----------
CREATE VIEW inventory.v_tag_label WITH (security_invoker = true) AS
SELECT t.tenant_id, t.branch_id, t.id AS tag_id, t.tag_no,
       coalesce(t.label_payload, t.tag_no) AS barcode_payload,
       t.huid, t.hallmark_exempt,
       i.code AS item_code, i.name AS item_name, si.name AS sub_item_name, d.code AS design_code, d.name AS design_name,
       p.code AS purity_code, t.pieces, t.gross_wt, t.stone_wt, t.net_wt, t.size,
       t.mc_type, t.mc_value, t.wastage_pct,
       coalesce(t.hsn, si.hsn, i.hsn) AS hsn,
       c.code AS counter_code, bx.code AS tray_code,
       t.label_printed_at, t.label_print_count
FROM inventory.tag t
JOIN masters.item i ON i.tenant_id = t.tenant_id AND i.id = t.item_id
JOIN masters.purity p ON p.tenant_id = t.tenant_id AND p.id = t.purity_id
LEFT JOIN masters.sub_item si ON si.tenant_id = t.tenant_id AND si.id = t.sub_item_id
LEFT JOIN masters.design d ON d.tenant_id = t.tenant_id AND d.id = t.design_id
LEFT JOIN masters.counter c ON c.tenant_id = t.tenant_id AND c.id = t.counter_id
LEFT JOIN masters.box bx ON bx.tenant_id = t.tenant_id AND bx.id = t.box_id;

-- ---------- I4 loose (non-tag) stock balance per branch / counter / tray / item / purity, from the ledger ----------
CREATE VIEW inventory.v_loose_stock WITH (security_invoker = true) AS
SELECT l.tenant_id, l.branch_id, l.counter_id, l.box_id, l.item_id, l.purity_id,
       sum(l.direction * l.pieces)::bigint            AS pieces,
       sum(l.direction * l.gross_wt)::numeric(12,3)   AS gross_wt,
       sum(l.direction * l.net_wt)::numeric(12,3)     AS net_wt,
       sum(l.direction * l.fine_wt)::numeric(12,3)    AS fine_wt
FROM inventory.stock_ledger l
WHERE l.tag_id IS NULL
GROUP BY l.tenant_id, l.branch_id, l.counter_id, l.box_id, l.item_id, l.purity_id
HAVING sum(l.direction * l.pieces) <> 0 OR sum(l.direction * l.gross_wt) <> 0 OR sum(l.direction * l.net_wt) <> 0;

-- ---------- I5 tagged stock by location ----------
CREATE VIEW inventory.v_tag_stock_location WITH (security_invoker = true) AS
SELECT t.tenant_id, t.branch_id, t.counter_id, t.box_id, t.item_id, t.purity_id, t.status,
       count(*)::bigint AS tags, sum(t.pieces)::bigint AS pieces,
       sum(t.gross_wt)::numeric(12,3) AS gross_wt, sum(t.stone_wt)::numeric(12,3) AS stone_wt, sum(t.net_wt)::numeric(12,3) AS net_wt
FROM inventory.tag t
WHERE t.status NOT IN ('sold','melted','returned_to_vendor','written_off')
GROUP BY t.tenant_id, t.branch_id, t.counter_id, t.box_id, t.item_id, t.purity_id, t.status;

-- ---------- I8 stock-check report: matched / missing / extra ----------
-- expected = tags at the session's branch (and counter / tray when the session is scoped) with status in_stock or reserved,
-- evaluated live (the app exports the report when it closes the session if a frozen copy is needed).
CREATE VIEW inventory.v_stock_take_report WITH (security_invoker = true) AS
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
       CASE WHEN r.is_expected AND r.scan_id IS NOT NULL THEN 'matched' WHEN r.is_expected THEN 'missing' ELSE 'extra' END AS result,
       CASE WHEN r.is_expected THEN NULL
            WHEN r.tag_id IS NULL THEN 'unknown_code'
            WHEN t.branch_id <> s.branch_id THEN 'other_branch'
            WHEN t.status NOT IN ('in_stock','reserved') THEN 'status_' || t.status
            ELSE 'other_location' END AS extra_reason,
       r.tag_id, t.tag_no, sc.scanned_code, sc.scanned_at, sc.scanned_by,
       t.item_id, t.purity_id, t.gross_wt, t.net_wt, t.status AS tag_status, t.branch_id AS tag_branch_id, t.counter_id, t.box_id
FROM r
JOIN inventory.stock_take s ON s.tenant_id = r.tenant_id AND s.id = r.stock_take_id
LEFT JOIN inventory.stock_take_scan sc ON sc.tenant_id = r.tenant_id AND sc.id = r.scan_id
LEFT JOIN inventory.tag t ON t.tenant_id = r.tenant_id AND t.id = r.tag_id;

-- ---------- I11 valuation at today's rate — metal value only for now ----------
-- Rate: today's (IST) rates.metal_rate for the purity, the branch's own row first, else shop-wide; latest effective_from wins.
-- Tagged / manufactured stock uses kind 'sale'; loose stock without an item (old metal) uses kind 'old_metal'.
-- No rate today -> rate_per_g, metal_value and total_value are NULL (the UI shows "rate not set"). No cost data is exposed.
-- Layout for later stone / making value without breaking callers:
--   stock  -> what is valued (one row per tag or loose balance)
--   metal  -> rate lookup + metal_value
--   final  -> total_value = metal_value today. A later migration adds a stone / making CTE, appends stone_value and
--             making_value columns at the END (CREATE OR REPLACE VIEW only appends), changes total_value to the sum and
--             value_basis to e.g. 'metal+stone+making'. Callers that sum total_value keep working; value_basis tells them what is in it.
CREATE VIEW inventory.v_stock_valuation WITH (security_invoker = true) AS
WITH stock AS (
  SELECT t.tenant_id, t.branch_id, t.counter_id, t.box_id, 'tag'::text AS stock_kind, t.id AS tag_id, t.tag_no,
         t.item_id, t.purity_id, t.status, t.pieces::bigint AS pieces, t.gross_wt::numeric(12,3) AS gross_wt, t.net_wt::numeric(12,3) AS net_wt
  FROM inventory.tag t WHERE t.status NOT IN ('sold','melted','returned_to_vendor','written_off')
  UNION ALL
  SELECT l.tenant_id, l.branch_id, l.counter_id, l.box_id, 'loose', NULL, NULL, l.item_id, l.purity_id, NULL, l.pieces, l.gross_wt, l.net_wt
  FROM inventory.v_loose_stock l
), metal AS (
  SELECT s.*,
         CASE WHEN s.item_id IS NULL THEN 'old_metal' ELSE 'sale' END AS rate_kind,
         r.id AS rate_id,
         CASE WHEN r.id IS NULL THEN NULL WHEN r.branch_id IS NULL THEN 'shop' ELSE 'branch' END AS rate_scope,
         r.rate_per_g,
         round(s.net_wt * r.rate_per_g, 2)::numeric(14,2) AS metal_value
  FROM stock s
  LEFT JOIN LATERAL (
    SELECT m.id, m.branch_id, m.rate_per_g FROM rates.metal_rate m
    WHERE m.tenant_id = s.tenant_id AND m.purity_id = s.purity_id
      AND m.kind = CASE WHEN s.item_id IS NULL THEN 'old_metal' ELSE 'sale' END
      AND m.rate_date = (now() AT TIME ZONE 'Asia/Kolkata')::date
      AND (m.branch_id IS NULL OR m.branch_id = s.branch_id)
    ORDER BY (m.branch_id IS NULL), m.effective_from DESC, m.id DESC
    LIMIT 1) r ON true
)
SELECT m.tenant_id, m.branch_id, m.counter_id, m.box_id, m.stock_kind, m.tag_id, m.tag_no, m.item_id, m.purity_id, m.status,
       m.pieces, m.gross_wt, m.net_wt, m.rate_kind, m.rate_id, m.rate_scope, m.rate_per_g,
       m.metal_value,
       m.metal_value::numeric(14,2) AS total_value,          -- = metal_value until stone / making value is added
       'metal'::text AS value_basis                          -- what total_value includes
FROM metal m;
COMMENT ON VIEW inventory.v_stock_valuation IS 'Stock valuation at today''s rate. total_value = metal_value for now (value_basis = ''metal''); stone / making value will be appended later without changing existing columns.';

-- ---------- ageing (only for shops with inventory.shop_setting.ageing_enabled) ----------
-- since = coalesce(tag.received_on, IST date of tag creation). inventory.tag has no created_at column: tagged_at
-- (NOT NULL DEFAULT now(), set when the tag row is created) is its creation time. Opening-stock imports carry the older
-- received_on. age_basis = 'received' when received_on is used, else 'tagged'. The lot's received_on is NOT used.
-- Buckets from shop_setting.ageing_bucket_days
-- (sorted, de-duplicated): bucket 0 = below the first bound; bucket n = at least the n-th bound.
CREATE VIEW inventory.v_tag_ageing WITH (security_invoker = true) AS
SELECT t.tenant_id, t.branch_id, t.counter_id, t.box_id, t.id AS tag_id, t.tag_no, t.item_id, t.design_id, t.purity_id, t.status,
       t.pieces, t.gross_wt, t.net_wt,
       t.received_on, s0.age_basis, a.since, a.age_days, b.bucket_no,
       CASE WHEN b.bucket_no = 0 THEN 0 ELSE th.bounds[b.bucket_no] END AS bucket_from_days,
       th.bounds[b.bucket_no + 1] - 1 AS bucket_to_days,
       CASE WHEN b.bucket_no = 0 THEN '0-' || (th.bounds[1] - 1)
            WHEN b.bucket_no = cardinality(th.bounds) THEN th.bounds[b.bucket_no] || '+'
            ELSE th.bounds[b.bucket_no] || '-' || (th.bounds[b.bucket_no + 1] - 1) END || ' days' AS bucket_label
FROM inventory.tag t
JOIN inventory.shop_setting ss ON ss.tenant_id = t.tenant_id AND ss.ageing_enabled
CROSS JOIN LATERAL (SELECT array_agg(d ORDER BY d) AS bounds FROM (SELECT DISTINCT unnest(ss.ageing_bucket_days) AS d) x) th
CROSS JOIN LATERAL (SELECT coalesce(t.received_on, (t.tagged_at AT TIME ZONE 'Asia/Kolkata')::date) AS since,
                           CASE WHEN t.received_on IS NOT NULL THEN 'received' ELSE 'tagged' END::text AS age_basis) s0
CROSS JOIN LATERAL (SELECT s0.since, greatest((now() AT TIME ZONE 'Asia/Kolkata')::date - s0.since, 0) AS age_days) a
CROSS JOIN LATERAL (SELECT (SELECT count(*) FROM unnest(th.bounds) d WHERE d <= a.age_days)::int AS bucket_no) b
WHERE t.status NOT IN ('sold','melted','returned_to_vendor','written_off');

-- ---------- grants: the views read through the caller's own table grants and RLS ----------
REVOKE ALL ON inventory.v_tag_label, inventory.v_loose_stock, inventory.v_tag_stock_location, inventory.v_stock_take_report,
              inventory.v_stock_valuation, inventory.v_tag_ageing FROM PUBLIC, app_rw, app_ro, app_worker;
GRANT SELECT ON inventory.v_tag_label, inventory.v_loose_stock, inventory.v_tag_stock_location, inventory.v_stock_take_report,
                inventory.v_stock_valuation, inventory.v_tag_ageing TO app_rw, app_ro;
GRANT SELECT ON inventory.v_loose_stock, inventory.v_tag_stock_location TO inventory_writer;

-- ---------- I12 opening stock import: reuses import kind 'stock' (tagged pieces + loose stock) ----------
COMMENT ON COLUMN platform.import_job.kind IS 'what is imported; ''stock'' = opening stock (tagged pieces with tag_no/weights/HUID, and loose stock by item + purity), ''opening_balances'' = party money/metal openings';
