-- seeds/check_sales_not_valid_predeploy.sql — READ-ONLY pre-deploy check for the Sales migrations 991–997, for a DB at the
-- 000–990 state (dev, 9 Nov 2026), BEFORE 991+ run. For each of the 19 constraints that 992 adds NOT VALID it counts the existing
-- rows that would make a later VALIDATE fail once 991+ have run.
-- Columns that 992 adds are evaluated as the value they get on existing rows (no backfill in 991–997):
--   invoice_line: stock_kind, purity_id, chargeable_wt, gross_value = NULL; bill_discount_share, cess = 0
--   invoice_old_metal: valuation_basis, server_rate_per_g, override_rate_per_g = NULL
--   credit_note_line: cess = 0
-- BY CONSTRUCTION two constraints count every legacy row of their table (columns NULL on existing rows): invoice_line_stock_check
-- (every legacy goods line) and invoice_old_metal_required_check (every legacy old-gold line). They are reported with kind=by_design;
-- validating them needs a backfill or they stay NOT VALID (enforced on new rows only). All others are kind=data.
-- Output (psql -At):
--   col|<object>|present|<true/false>|expected_at_990|<true/false>     state markers (pg_attribute / to_regclass, not privilege-filtered)
--   shop|<slug>|<table.constraint>|<kind>|<violations>                    one row per shop per constraint
--   count|<table.constraint>|<kind>|<violations>                          one row per constraint, summed over the shops
--   row|<slug>|<table>|<constraint>|<id>|<non-personal columns as json>   offending rows (max 50 per constraint per shop; ids/amounts only)
-- Read-only: default_transaction_read_only on, BEGIN READ ONLY … ROLLBACK, SELECTs only; never validates. Runs with dev_seed (app_rw)
-- privileges under RLS: one tenant per slug via app.tenant_id.
--   psql -X -q -At -v ON_ERROR_STOP=1 -v slugs=<slug1>,<slug2> -f seeds/check_sales_not_valid_predeploy.sql
-- Refuses (still read-only) unless the DB is at the 990 state: 990's stock_take_scan.result present and no 991+ object
-- (sales.shop_setting, sales.invoice.row_rev, sales.invoice_line.stock_kind, sales.invoice_old_metal.valuation_basis, sales.payment_receipt).
\set ON_ERROR_STOP 1
SET default_transaction_read_only = on;
SELECT set_config('nvsales.slugs', :'slugs', false) \g /dev/null
BEGIN READ ONLY;
SELECT set_config('nvsales.cols',
  (SELECT jsonb_agg(jsonb_build_array(o.obj, CASE WHEN c.col IS NULL THEN to_regclass(c.tbl) IS NOT NULL
                                                  ELSE EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass(c.tbl)
                                                               AND a.attname = c.col AND a.attnum > 0 AND NOT a.attisdropped) END,
                                      c.at990) ORDER BY c.ord)::text
   FROM (VALUES (1,'inventory.stock_take_scan','result',true),
                (2,'sales.invoice','salesperson_id',true),(3,'sales.invoice','cash_counter_id',true),(4,'sales.estimate','invoice_id',true),
                (5,'sales.invoice_line','tag_id',true),(6,'sales.invoice_line','mc_type',true),(7,'sales.invoice_old_metal','purity_id',true),
                (8,'sales.invoice','row_rev',false),(9,'sales.invoice_line','stock_kind',false),(10,'sales.invoice_line','gross_value',false),
                (11,'sales.invoice_old_metal','valuation_basis',false),(12,'sales.credit_note_line','cess',false),
                (13,'sales.shop_setting',NULL,false),(14,'sales.payment_receipt',NULL,false)) c(ord, tbl, col, at990)
   CROSS JOIN LATERAL (SELECT c.tbl || coalesce('.' || c.col, '') AS obj) o), true) \g /dev/null
SELECT 'col|' || (e ->> 0) || '|present|' || (e ->> 1) || '|expected_at_990|' || (e ->> 2)
FROM jsonb_array_elements(current_setting('nvsales.cols')::jsonb) e;
DO $$
DECLARE s text; t uuid; n int := 0; cur jsonb; acc jsonb; shops jsonb := '[]'; rows jsonb := '[]'; bad text;
BEGIN
  SELECT string_agg(e ->> 0, ', ') INTO bad FROM jsonb_array_elements(current_setting('nvsales.cols')::jsonb) e WHERE (e ->> 1) <> (e ->> 2);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'DB is not at the 000–990 state (object presence differs: %); this pre-check is only for a DB before 991+', bad;
  END IF;
  PERFORM set_config('app.partner_id', '', true);
  PERFORM set_config('app.branch_scope', '', true);
  FOREACH s IN ARRAY string_to_array(current_setting('nvsales.slugs'), ',') LOOP
    s := lower(btrim(s));
    CONTINUE WHEN s = '';
    SELECT r.tenant_id INTO t FROM platform.resolve_tenant(s) r;
    IF t IS NULL THEN RAISE EXCEPTION 'unknown tenant slug %', s; END IF;
    PERFORM set_config('app.tenant_id', t::text, true);
    WITH v AS (
      SELECT 'sales.invoice' tbl, 'invoice_salesperson_fk' con, x.id, jsonb_build_object('doc_no', x.doc_no, 'salesperson_id', x.salesperson_id) cols
        FROM sales.invoice x WHERE x.salesperson_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM hr.staff y WHERE y.tenant_id = x.tenant_id AND y.id = x.salesperson_id)
      UNION ALL SELECT 'sales.invoice', 'invoice_cash_counter_fk', x.id, jsonb_build_object('doc_no', x.doc_no, 'cash_counter_id', x.cash_counter_id)
        FROM sales.invoice x WHERE x.cash_counter_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM accounts.cash_counter y WHERE y.tenant_id = x.tenant_id AND y.id = x.cash_counter_id)
      UNION ALL SELECT 'sales.invoice_line', 'invoice_line_tag_fk', x.id, jsonb_build_object('invoice_id', x.invoice_id, 'line_no', x.line_no, 'tag_id', x.tag_id)
        FROM sales.invoice_line x WHERE x.tag_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM inventory.tag y WHERE y.tenant_id = x.tenant_id AND y.id = x.tag_id)
      UNION ALL SELECT 'sales.invoice_line', 'invoice_line_item_fk', x.id, jsonb_build_object('invoice_id', x.invoice_id, 'line_no', x.line_no, 'item_id', x.item_id)
        FROM sales.invoice_line x WHERE NOT EXISTS (SELECT 1 FROM masters.item y WHERE y.tenant_id = x.tenant_id AND y.id = x.item_id)
      UNION ALL SELECT 'sales.invoice_line', 'invoice_line_rate_fk', x.id, jsonb_build_object('invoice_id', x.invoice_id, 'line_no', x.line_no, 'rate_id', x.rate_id)
        FROM sales.invoice_line x WHERE NOT EXISTS (SELECT 1 FROM rates.metal_rate y WHERE y.tenant_id = x.tenant_id AND y.id = x.rate_id)
      -- stock_kind, purity_id, chargeable_wt, gross_value are NULL on existing rows -> every legacy goods line fails (by design)
      UNION ALL SELECT 'sales.invoice_line', 'invoice_line_stock_check', x.id, jsonb_build_object('invoice_id', x.invoice_id, 'line_no', x.line_no, 'line_kind', x.line_kind)
        FROM sales.invoice_line x WHERE ((x.line_kind = 'service' AND NULL::text IS NULL)
              OR (x.line_kind = 'goods' AND NULL::text IS NOT NULL)) IS FALSE
      UNION ALL SELECT 'sales.invoice_line', 'invoice_line_mc_type_check', x.id, jsonb_build_object('invoice_id', x.invoice_id, 'line_no', x.line_no, 'mc_type', x.mc_type)
        FROM sales.invoice_line x WHERE (x.mc_type IN ('per_gram','percent','flat','per_piece')) IS FALSE
      UNION ALL SELECT 'sales.invoice_line', 'invoice_line_weights_check', x.id,
             jsonb_build_object('invoice_id', x.invoice_id, 'line_no', x.line_no, 'gross_wt', x.gross_wt, 'net_wt', x.net_wt, 'stone_wt', x.stone_wt, 'pieces', x.pieces)
        -- 997: new stock_kind arrives NULL, so the zero-piece loose exception is FALSE; chargeable_wt arrives NULL.
        FROM sales.invoice_line x WHERE (x.net_wt <= x.gross_wt AND x.stone_wt <= x.gross_wt
          AND (NULL::numeric IS NULL OR NULL::numeric = x.net_wt + x.wastage_wt)
          AND (x.line_kind = 'service' OR x.gross_wt > 0)
          AND (x.pieces >= 1 OR (NULL::text IS NOT DISTINCT FROM 'loose' AND x.pieces = 0 AND x.net_wt > 0))) IS FALSE
      UNION ALL SELECT 'sales.invoice_line', 'invoice_line_amounts_check', x.id, jsonb_build_object('invoice_id', x.invoice_id, 'line_no', x.line_no)
        FROM sales.invoice_line x WHERE (x.metal_value >= 0 AND x.mc_amount >= 0 AND x.stone_amount >= 0 AND x.huid_charge >= 0 AND x.discount >= 0
              AND x.taxable_value >= 0 AND x.cgst >= 0 AND x.sgst >= 0 AND x.igst >= 0 AND x.rate_per_g >= 0) IS FALSE
      UNION ALL SELECT 'sales.invoice_line', 'invoice_line_taxable_sum_check', x.id, jsonb_build_object('invoice_id', x.invoice_id, 'line_no', x.line_no)
        FROM sales.invoice_line x WHERE (x.line_kind <> 'goods' OR (NULL::numeric = x.metal_value + x.mc_amount + x.stone_amount + x.huid_charge
              AND x.taxable_value = NULL::numeric - x.discount - 0)) IS FALSE
      UNION ALL SELECT 'sales.invoice_line', 'invoice_line_total_sum_check', x.id,
             jsonb_build_object('invoice_id', x.invoice_id, 'line_no', x.line_no, 'taxable_value', x.taxable_value, 'line_total', x.line_total)
        FROM sales.invoice_line x WHERE (x.line_total = x.taxable_value + x.cgst + x.sgst + x.igst + 0) IS FALSE
      UNION ALL SELECT 'sales.invoice_line', 'invoice_line_gst_split_check', x.id, jsonb_build_object('invoice_id', x.invoice_id, 'line_no', x.line_no)
        FROM sales.invoice_line x WHERE ((x.cgst = 0 AND x.sgst = 0) OR x.igst = 0) IS FALSE
      UNION ALL SELECT 'sales.invoice_old_metal', 'invoice_old_metal_purity_fk', x.id, jsonb_build_object('invoice_id', x.invoice_id, 'line_no', x.line_no, 'purity_id', x.purity_id)
        FROM sales.invoice_old_metal x WHERE NOT EXISTS (SELECT 1 FROM masters.purity y WHERE y.tenant_id = x.tenant_id AND y.id = x.purity_id)
      UNION ALL SELECT 'sales.invoice_old_metal', 'invoice_old_metal_rate_fk', x.id, jsonb_build_object('invoice_id', x.invoice_id, 'line_no', x.line_no, 'rate_id', x.rate_id)
        FROM sales.invoice_old_metal x WHERE NOT EXISTS (SELECT 1 FROM rates.metal_rate y WHERE y.tenant_id = x.tenant_id AND y.id = x.rate_id)
      -- valuation_basis / server_rate_per_g are NULL on existing rows -> every legacy old-gold line fails (by design)
      UNION ALL SELECT 'sales.invoice_old_metal', 'invoice_old_metal_required_check', x.id, jsonb_build_object('invoice_id', x.invoice_id, 'line_no', x.line_no)
        FROM sales.invoice_old_metal x WHERE (NULL::text IS NOT NULL AND NULL::numeric IS NOT NULL) IS FALSE
      UNION ALL SELECT 'sales.invoice_old_metal', 'invoice_old_metal_weights_check', x.id,
             jsonb_build_object('invoice_id', x.invoice_id, 'line_no', x.line_no, 'gross_wt', x.gross_wt, 'less_wt', x.less_wt, 'net_wt', x.net_wt, 'fine_wt', x.fine_wt, 'touch_pct', x.touch_pct)
        FROM sales.invoice_old_metal x WHERE (x.net_wt = x.gross_wt - x.less_wt AND x.fine_wt <= x.net_wt AND x.touch_pct > 0 AND x.touch_pct <= 100) IS FALSE
      UNION ALL SELECT 'sales.invoice_old_metal', 'invoice_old_metal_amount_check', x.id,
             jsonb_build_object('invoice_id', x.invoice_id, 'line_no', x.line_no, 'rate_per_g', x.rate_per_g, 'amount', x.amount)
        FROM sales.invoice_old_metal x WHERE (x.rate_per_g > 0 AND x.amount >= 0) IS FALSE
      UNION ALL SELECT 'sales.credit_note_line', 'credit_note_line_total_sum_check', x.id,
             jsonb_build_object('credit_note_id', x.credit_note_id, 'taxable_value', x.taxable_value, 'line_total', x.line_total)
        FROM sales.credit_note_line x WHERE (x.line_total = x.taxable_value + x.cgst + x.sgst + x.igst + 0) IS FALSE
      UNION ALL SELECT 'sales.estimate', 'estimate_invoice_fk', x.id, jsonb_build_object('estimate_no', x.estimate_no, 'invoice_id', x.invoice_id)
        FROM sales.estimate x WHERE x.invoice_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM sales.invoice y WHERE y.tenant_id = x.tenant_id AND y.id = x.invoice_id)
    ), k(key) AS (VALUES ('sales.invoice.invoice_salesperson_fk'),('sales.invoice.invoice_cash_counter_fk'),
        ('sales.invoice_line.invoice_line_tag_fk'),('sales.invoice_line.invoice_line_item_fk'),('sales.invoice_line.invoice_line_rate_fk'),
        ('sales.invoice_line.invoice_line_stock_check'),('sales.invoice_line.invoice_line_mc_type_check'),('sales.invoice_line.invoice_line_weights_check'),
        ('sales.invoice_line.invoice_line_amounts_check'),('sales.invoice_line.invoice_line_taxable_sum_check'),('sales.invoice_line.invoice_line_total_sum_check'),
        ('sales.invoice_line.invoice_line_gst_split_check'),('sales.invoice_old_metal.invoice_old_metal_purity_fk'),('sales.invoice_old_metal.invoice_old_metal_rate_fk'),
        ('sales.invoice_old_metal.invoice_old_metal_required_check'),('sales.invoice_old_metal.invoice_old_metal_weights_check'),
        ('sales.invoice_old_metal.invoice_old_metal_amount_check'),('sales.credit_note_line.credit_note_line_total_sum_check'),('sales.estimate.estimate_invoice_fk'))
    SELECT (SELECT jsonb_object_agg(k.key, (SELECT count(*) FROM v WHERE v.tbl || '.' || v.con = k.key)) FROM k),
           rows || coalesce((SELECT jsonb_agg(jsonb_build_array(s, r.tbl, r.con, r.id, r.cols) ORDER BY r.tbl, r.con, r.id)
                             FROM (SELECT v.*, row_number() OVER (PARTITION BY v.con ORDER BY v.id) rn FROM v) r WHERE r.rn <= 50), '[]')
      INTO cur, rows;
    shops := shops || (SELECT jsonb_agg(jsonb_build_array(s, k, v::bigint)) FROM jsonb_each_text(cur) e(k, v));
    acc := CASE WHEN acc IS NULL THEN cur
                ELSE (SELECT jsonb_object_agg(k, (acc ->> k)::bigint + (cur ->> k)::bigint) FROM jsonb_object_keys(cur) k) END;
    RAISE NOTICE 'sales pre-deploy not-valid check %: % violating row(s)', s, (SELECT sum(v::bigint) FROM jsonb_each_text(cur) e(k, v));
    n := n + 1;
  END LOOP;
  IF n = 0 THEN RAISE EXCEPTION 'no tenant slugs given (-v slugs=a,b)'; END IF;
  PERFORM set_config('nvsales.counts', acc::text, true);
  PERFORM set_config('nvsales.shops', shops::text, true);
  PERFORM set_config('nvsales.rows', rows::text, true);
END $$;
SELECT 'shop|' || (r ->> 0) || '|' || (r ->> 1) || '|'
       || CASE WHEN r ->> 1 ~ '(invoice_line_stock_check|invoice_old_metal_required_check)$' THEN 'by_design' ELSE 'data' END || '|' || (r ->> 2)
FROM jsonb_array_elements(current_setting('nvsales.shops')::jsonb) r ORDER BY r ->> 0, r ->> 1;
SELECT 'count|' || k || '|' || CASE WHEN k ~ '(invoice_line_stock_check|invoice_old_metal_required_check)$' THEN 'by_design' ELSE 'data' END || '|' || v
FROM jsonb_each_text(current_setting('nvsales.counts')::jsonb) e(k, v) ORDER BY k;
SELECT 'row|' || (r ->> 0) || '|' || (r ->> 1) || '|' || (r ->> 2) || '|' || (r ->> 3) || '|' || (r -> 4)::text
FROM jsonb_array_elements(current_setting('nvsales.rows')::jsonb) r;
ROLLBACK;
