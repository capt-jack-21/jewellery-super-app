-- seeds/check_inventory_not_valid.sql — READ-ONLY pre-check for the NOT VALID constraints added in 987–989.
-- For every NOT VALID constraint those files add, count the EXISTING rows that would make validating it fail.
-- Output: one row per constraint (constraint | violations), summed over the given shops. Zero everywhere = safe to VALIDATE.
-- This file never validates a constraint, writes or changes anything: it runs inside BEGIN READ ONLY … ROLLBACK and only SELECTs.
-- Runs with app_rw privileges (the dev_seed login; app_ro also works: SELECT only). Forced RLS means one tenant at a time via
-- set_config, and tenants cannot be listed, so pass slugs explicitly (from the admin console tenant list):
--   psql -X -q -v ON_ERROR_STOP=1 -v slugs=<slug1>,<slug2> -f seeds/check_inventory_not_valid.sql
-- CHECK semantics: a row violates only when the expression is FALSE (NULL passes). FK semantics (MATCH SIMPLE): a row violates
-- only when every FK column is non-NULL and no referenced row exists.
-- Tested on the VPS test DB only (tests/run_all.sh NV1–NV5). NOT run on dev by the data-model work.
\set ON_ERROR_STOP 1
SELECT set_config('nvcheck.slugs', :'slugs', false) \g /dev/null
BEGIN READ ONLY;
DO $$
DECLARE s text; t uuid; n int := 0; cur jsonb; acc jsonb;
BEGIN
  PERFORM set_config('app.partner_id', '', true);
  PERFORM set_config('app.branch_scope', '', true);
  FOREACH s IN ARRAY string_to_array(current_setting('nvcheck.slugs'), ',') LOOP
    s := lower(btrim(s));
    CONTINUE WHEN s = '';
    SELECT r.tenant_id INTO t FROM platform.resolve_tenant(s) r;
    IF t IS NULL THEN RAISE EXCEPTION 'unknown tenant slug %', s; END IF;
    PERFORM set_config('app.tenant_id', t::text, true);
    SELECT jsonb_build_object(
      -- 987
      'inventory.tag.tag_pieces_check',
        (SELECT count(*) FROM inventory.tag x WHERE (x.pieces >= 1) IS FALSE),
      'inventory.tag.tag_stone_le_gross',
        (SELECT count(*) FROM inventory.tag x WHERE (x.stone_wt <= x.gross_wt) IS FALSE),
      'inventory.lot_line.lot_line_tagged_check',
        (SELECT count(*) FROM inventory.lot_line x WHERE (x.tagged_pieces >= 0) IS FALSE),
      -- 988 stock_transfer
      'inventory.stock_transfer.stock_transfer_dispatched_chk',
        (SELECT count(*) FROM inventory.stock_transfer x
          WHERE (x.status NOT IN ('in_transit','received','returned') OR (x.dispatched_at IS NOT NULL AND x.dispatched_by IS NOT NULL)) IS FALSE),
      'inventory.stock_transfer.stock_transfer_received_chk',
        (SELECT count(*) FROM inventory.stock_transfer x
          WHERE (x.status <> 'received' OR (x.received_at IS NOT NULL AND x.received_by IS NOT NULL)) IS FALSE),
      'inventory.stock_transfer.stock_transfer_approved_chk',
        (SELECT count(*) FROM inventory.stock_transfer x WHERE (x.status IN ('draft','cancelled') OR x.approved_by IS NOT NULL) IS FALSE),
      'inventory.stock_transfer.stock_transfer_cancelled_chk',
        (SELECT count(*) FROM inventory.stock_transfer x WHERE (x.status <> 'cancelled' OR x.cancelled_at IS NOT NULL) IS FALSE),
      'inventory.stock_transfer.stock_transfer_received_after_dispatch',
        (SELECT count(*) FROM inventory.stock_transfer x
          WHERE (x.received_at IS NULL OR x.dispatched_at IS NULL OR x.received_at >= x.dispatched_at) IS FALSE),
      'inventory.stock_transfer.stock_transfer_requested_by_fk',
        (SELECT count(*) FROM inventory.stock_transfer x WHERE x.requested_by IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM platform.app_user u WHERE u.tenant_id = x.tenant_id AND u.id = x.requested_by)),
      'inventory.stock_transfer.stock_transfer_approved_by_fk',
        (SELECT count(*) FROM inventory.stock_transfer x WHERE x.approved_by IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM platform.app_user u WHERE u.tenant_id = x.tenant_id AND u.id = x.approved_by)),
      'inventory.stock_transfer.stock_transfer_received_by_fk',
        (SELECT count(*) FROM inventory.stock_transfer x WHERE x.received_by IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM platform.app_user u WHERE u.tenant_id = x.tenant_id AND u.id = x.received_by)),
      -- 988 stock_transfer_line
      'inventory.stock_transfer_line.stock_transfer_line_received_chk',
        (SELECT count(*) FROM inventory.stock_transfer_line x WHERE (NOT x.received OR x.received_at IS NOT NULL) IS FALSE),
      'inventory.stock_transfer_line.stock_transfer_line_what',
        (SELECT count(*) FROM inventory.stock_transfer_line x
          WHERE (x.tag_id IS NOT NULL OR (x.item_id IS NOT NULL AND x.purity_id IS NOT NULL)) IS FALSE),
      -- 988 stock_take
      'inventory.stock_take.stock_take_closed_chk',
        (SELECT count(*) FROM inventory.stock_take x WHERE (x.status = 'open' OR x.closed_at IS NOT NULL) IS FALSE)
    ) INTO cur;
    acc := CASE WHEN acc IS NULL THEN cur
                ELSE (SELECT jsonb_object_agg(k, (acc ->> k)::bigint + (cur ->> k)::bigint) FROM jsonb_object_keys(cur) k) END;
    RAISE NOTICE 'not-valid check %: % violating row(s)', s, (SELECT sum(v::bigint) FROM jsonb_each_text(cur) e(k, v));
    n := n + 1;
  END LOOP;
  IF n = 0 THEN RAISE EXCEPTION 'no tenant slugs given (-v slugs=a,b)'; END IF;
  PERFORM set_config('nvcheck.counts', acc::text, true);
END $$;
SELECT k AS constraint_name, v::bigint AS violations
FROM jsonb_each_text(current_setting('nvcheck.counts')::jsonb) e(k, v)
ORDER BY k;
ROLLBACK;
