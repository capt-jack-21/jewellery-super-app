-- seeds/check_inventory_not_valid_predeploy.sql — READ-ONLY pre-deploy variant of check_inventory_not_valid.sql, for a DB at
-- the 000–986 state (dev today), BEFORE 987–989 run. For each of the 14 constraints that 987–988 add NOT VALID, it counts the
-- existing rows that would make validating it fail once 987–989 have run.
-- Columns that 987–989 add are evaluated as the value they get on existing rows. 987–989 have no backfills and no defaults on
-- these columns, so every one of them is NULL:
--   stock_transfer.dispatched_by, stock_transfer.cancelled_at, stock_transfer_line.received_at.
-- Output (psql -At), three result sets:
--   col|<table.column>|present|<true/false>|expected_at_986|<true/false>   referenced columns (information_schema)
--   count|<table.constraint>|<violations>                                one row per constraint, summed over the shops
--   row|<slug>|<table>|<constraint>|<id>|<relevant columns as json>      offending rows (max 200 per constraint per shop)
-- Read-only: BEGIN READ ONLY … ROLLBACK, SELECTs only; never validates a constraint. Runs with dev_seed (app_rw) privileges; app_ro also works.
--   psql -X -q -At -v ON_ERROR_STOP=1 -v slugs=<slug1>,<slug2> -f seeds/check_inventory_not_valid_predeploy.sql
-- Aborts (still read-only) if the DB is not at the 986 state: a 986 column is missing, or a 987–989 column already exists
-- (then use seeds/check_inventory_not_valid.sql instead).
\set ON_ERROR_STOP 1
SELECT set_config('nvpre.slugs', :'slugs', false) \g /dev/null
BEGIN READ ONLY;
SELECT set_config('nvpre.cols',
  (SELECT jsonb_agg(jsonb_build_array(c.tbl || '.' || c.col,
          EXISTS (SELECT 1 FROM information_schema.columns i WHERE i.table_schema = 'inventory' AND i.table_name = c.tbl AND i.column_name = c.col),
          c.at986) ORDER BY c.ord)::text
   FROM (VALUES (1,'tag','pieces',true),(2,'tag','stone_wt',true),(3,'tag','gross_wt',true),
                (4,'lot_line','tagged_pieces',true),
                (5,'stock_transfer','status',true),(6,'stock_transfer','dispatched_at',true),(7,'stock_transfer','received_at',true),
                (8,'stock_transfer','received_by',true),(9,'stock_transfer','approved_by',true),(10,'stock_transfer','requested_by',true),
                (11,'stock_transfer','dispatched_by',false),(12,'stock_transfer','cancelled_at',false),
                (13,'stock_transfer_line','received',true),(14,'stock_transfer_line','tag_id',true),(15,'stock_transfer_line','item_id',true),
                (16,'stock_transfer_line','purity_id',true),(17,'stock_transfer_line','received_at',false),
                (18,'stock_take','status',true),(19,'stock_take','closed_at',true)) c(ord, tbl, col, at986)), true) \g /dev/null
SELECT 'col|' || (e ->> 0) || '|present|' || (e ->> 1) || '|expected_at_986|' || (e ->> 2)
FROM jsonb_array_elements(current_setting('nvpre.cols')::jsonb) e;
DO $$
DECLARE s text; t uuid; n int := 0; cur jsonb; acc jsonb; rows jsonb := '[]'; bad text;
BEGIN
  SELECT string_agg(e ->> 0, ', ') INTO bad FROM jsonb_array_elements(current_setting('nvpre.cols')::jsonb) e WHERE (e ->> 1) <> (e ->> 2);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'DB is not at the 000–986 state (column presence differs: %); after 987–989 use seeds/check_inventory_not_valid.sql', bad;
  END IF;
  PERFORM set_config('app.partner_id', '', true);
  PERFORM set_config('app.branch_scope', '', true);
  FOREACH s IN ARRAY string_to_array(current_setting('nvpre.slugs'), ',') LOOP
    s := lower(btrim(s));
    CONTINUE WHEN s = '';
    SELECT r.tenant_id INTO t FROM platform.resolve_tenant(s) r;
    IF t IS NULL THEN RAISE EXCEPTION 'unknown tenant slug %', s; END IF;
    PERFORM set_config('app.tenant_id', t::text, true);
    WITH v AS (
      -- 987
      SELECT 'inventory.tag' tbl, 'tag_pieces_check' con, x.id, jsonb_build_object('tag_no', x.tag_no, 'pieces', x.pieces) cols
        FROM inventory.tag x WHERE (x.pieces >= 1) IS FALSE
      UNION ALL SELECT 'inventory.tag', 'tag_stone_le_gross', x.id, jsonb_build_object('tag_no', x.tag_no, 'gross_wt', x.gross_wt, 'stone_wt', x.stone_wt)
        FROM inventory.tag x WHERE (x.stone_wt <= x.gross_wt) IS FALSE
      UNION ALL SELECT 'inventory.lot_line', 'lot_line_tagged_check', x.id, jsonb_build_object('lot_id', x.lot_id, 'tagged_pieces', x.tagged_pieces)
        FROM inventory.lot_line x WHERE (x.tagged_pieces >= 0) IS FALSE
      -- 988 stock_transfer (dispatched_by, cancelled_at do not exist yet -> NULL after 988)
      UNION ALL SELECT 'inventory.stock_transfer', 'stock_transfer_dispatched_chk', x.id,
             jsonb_build_object('transfer_no', x.transfer_no, 'status', x.status, 'dispatched_at', x.dispatched_at, 'dispatched_by', NULL)
        FROM inventory.stock_transfer x
        WHERE (x.status NOT IN ('in_transit','received','returned') OR (x.dispatched_at IS NOT NULL AND NULL::uuid IS NOT NULL)) IS FALSE
      UNION ALL SELECT 'inventory.stock_transfer', 'stock_transfer_received_chk', x.id,
             jsonb_build_object('transfer_no', x.transfer_no, 'status', x.status, 'received_at', x.received_at, 'received_by', x.received_by)
        FROM inventory.stock_transfer x WHERE (x.status <> 'received' OR (x.received_at IS NOT NULL AND x.received_by IS NOT NULL)) IS FALSE
      UNION ALL SELECT 'inventory.stock_transfer', 'stock_transfer_approved_chk', x.id,
             jsonb_build_object('transfer_no', x.transfer_no, 'status', x.status, 'approved_by', x.approved_by)
        FROM inventory.stock_transfer x WHERE (x.status IN ('draft','cancelled') OR x.approved_by IS NOT NULL) IS FALSE
      UNION ALL SELECT 'inventory.stock_transfer', 'stock_transfer_cancelled_chk', x.id,
             jsonb_build_object('transfer_no', x.transfer_no, 'status', x.status, 'cancelled_at', NULL)
        FROM inventory.stock_transfer x WHERE (x.status <> 'cancelled' OR NULL::timestamptz IS NOT NULL) IS FALSE
      UNION ALL SELECT 'inventory.stock_transfer', 'stock_transfer_received_after_dispatch', x.id,
             jsonb_build_object('transfer_no', x.transfer_no, 'dispatched_at', x.dispatched_at, 'received_at', x.received_at)
        FROM inventory.stock_transfer x WHERE (x.received_at IS NULL OR x.dispatched_at IS NULL OR x.received_at >= x.dispatched_at) IS FALSE
      UNION ALL SELECT 'inventory.stock_transfer', 'stock_transfer_requested_by_fk', x.id, jsonb_build_object('transfer_no', x.transfer_no, 'requested_by', x.requested_by)
        FROM inventory.stock_transfer x WHERE x.requested_by IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM platform.app_user u WHERE u.tenant_id = x.tenant_id AND u.id = x.requested_by)
      UNION ALL SELECT 'inventory.stock_transfer', 'stock_transfer_approved_by_fk', x.id, jsonb_build_object('transfer_no', x.transfer_no, 'approved_by', x.approved_by)
        FROM inventory.stock_transfer x WHERE x.approved_by IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM platform.app_user u WHERE u.tenant_id = x.tenant_id AND u.id = x.approved_by)
      UNION ALL SELECT 'inventory.stock_transfer', 'stock_transfer_received_by_fk', x.id, jsonb_build_object('transfer_no', x.transfer_no, 'received_by', x.received_by)
        FROM inventory.stock_transfer x WHERE x.received_by IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM platform.app_user u WHERE u.tenant_id = x.tenant_id AND u.id = x.received_by)
      -- 988 stock_transfer_line (received_at does not exist yet -> NULL after 988)
      UNION ALL SELECT 'inventory.stock_transfer_line', 'stock_transfer_line_received_chk', x.id,
             jsonb_build_object('transfer_id', x.transfer_id, 'received', x.received, 'received_at', NULL)
        FROM inventory.stock_transfer_line x WHERE (NOT x.received OR NULL::timestamptz IS NOT NULL) IS FALSE
      UNION ALL SELECT 'inventory.stock_transfer_line', 'stock_transfer_line_what', x.id,
             jsonb_build_object('transfer_id', x.transfer_id, 'tag_id', x.tag_id, 'item_id', x.item_id, 'purity_id', x.purity_id)
        FROM inventory.stock_transfer_line x WHERE (x.tag_id IS NOT NULL OR (x.item_id IS NOT NULL AND x.purity_id IS NOT NULL)) IS FALSE
      -- 988 stock_take
      UNION ALL SELECT 'inventory.stock_take', 'stock_take_closed_chk', x.id, jsonb_build_object('status', x.status, 'closed_at', x.closed_at)
        FROM inventory.stock_take x WHERE (x.status = 'open' OR x.closed_at IS NOT NULL) IS FALSE
    ), k(key) AS (VALUES ('inventory.tag.tag_pieces_check'),('inventory.tag.tag_stone_le_gross'),('inventory.lot_line.lot_line_tagged_check'),
        ('inventory.stock_transfer.stock_transfer_dispatched_chk'),('inventory.stock_transfer.stock_transfer_received_chk'),
        ('inventory.stock_transfer.stock_transfer_approved_chk'),('inventory.stock_transfer.stock_transfer_cancelled_chk'),
        ('inventory.stock_transfer.stock_transfer_received_after_dispatch'),('inventory.stock_transfer.stock_transfer_requested_by_fk'),
        ('inventory.stock_transfer.stock_transfer_approved_by_fk'),('inventory.stock_transfer.stock_transfer_received_by_fk'),
        ('inventory.stock_transfer_line.stock_transfer_line_received_chk'),('inventory.stock_transfer_line.stock_transfer_line_what'),
        ('inventory.stock_take.stock_take_closed_chk'))
    SELECT (SELECT jsonb_object_agg(k.key, (SELECT count(*) FROM v WHERE v.tbl || '.' || v.con = k.key)) FROM k),
           rows || coalesce((SELECT jsonb_agg(jsonb_build_array(s, r.tbl, r.con, r.id, r.cols) ORDER BY r.tbl, r.con, r.id)
                             FROM (SELECT v.*, row_number() OVER (PARTITION BY v.con ORDER BY v.id) rn FROM v) r WHERE r.rn <= 200), '[]')
      INTO cur, rows;
    acc := CASE WHEN acc IS NULL THEN cur
                ELSE (SELECT jsonb_object_agg(k, (acc ->> k)::bigint + (cur ->> k)::bigint) FROM jsonb_object_keys(cur) k) END;
    RAISE NOTICE 'pre-deploy not-valid check %: % violating row(s)', s, (SELECT sum(v::bigint) FROM jsonb_each_text(cur) e(k, v));
    n := n + 1;
  END LOOP;
  IF n = 0 THEN RAISE EXCEPTION 'no tenant slugs given (-v slugs=a,b)'; END IF;
  PERFORM set_config('nvpre.counts', acc::text, true);
  PERFORM set_config('nvpre.rows', rows::text, true);
END $$;
SELECT 'count|' || k || '|' || v FROM jsonb_each_text(current_setting('nvpre.counts')::jsonb) e(k, v) ORDER BY k;
SELECT 'row|' || (r ->> 0) || '|' || (r ->> 1) || '|' || (r ->> 2) || '|' || (r ->> 3) || '|' || (r -> 4)::text
FROM jsonb_array_elements(current_setting('nvpre.rows')::jsonb) r;
ROLLBACK;
