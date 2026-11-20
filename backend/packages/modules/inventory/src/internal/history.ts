import { type InventoryActor } from './actor';
import { invalid } from './errors';
import { many } from './db';
import { getTag } from './tags';

/**
 * Tag history (0.8.3): one newest-first stream merged from
 *   ledger      inventory.stock_ledger rows of the piece (move_out / move_in are shown once, as the move)
 *   move        inventory.location_move (counter / tray moves)
 *   transfer    inventory.stock_transfer_line (when the piece was put on a transfer; note = the transfer's current status)
 *   adjustment  inventory.stock_adjustment (requested; note = kind, status and reason)
 *   stock_check inventory.stock_take_scan (the piece was scanned)
 *   status / label_print / edit  platform.audit_event UPDATE rows on inventory.tag (zz_audit): a status change (reason from the
 *               explicit inventory.tag.status_changed row), a label print count change, or other descriptive edits (note lists
 *               the fields). Location- and weight-only updates are skipped (they are the move / adjustment entries).
 * Keyset paging on (at, k) with an opaque cursor; limit 1-100, default 25.
 */
export interface TagHistoryEntry {
  at: string; kind: 'ledger' | 'move' | 'transfer' | 'label_print' | 'adjustment' | 'edit' | 'status' | 'stock_check';
  movement: string | null; from: Loc | null; to: Loc | null; status_before: string | null; status_after: string | null;
  source_type: string | null; source_id: string | null; source_no: string | null; actor_id: string | null; note: string | null;
}
type Loc = { branch_id: string; counter_id: string | null; tray_id: string | null };
const SKIP_EDIT = ['version', 'status', 'counter_id', 'box_id', 'gross_wt', 'net_wt', 'stone_wt', 'pieces', 'branch_id', 'label_printed_at', 'label_print_count',
  'updated_at'];

const enc = (c: { at: string; k: string }) => Buffer.from(JSON.stringify(c)).toString('base64url');
function dec(s: string): { at: string; k: string } {
  try {
    const c = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as { at?: unknown; k?: unknown };
    if (typeof c.at === 'string' && typeof c.k === 'string' && !Number.isNaN(Date.parse(c.at.replace(' ', 'T')))) return { at: c.at, k: c.k };
  } catch { /* fall through */ }
  return invalid('cursor', 'not a cursor from this list');
}
const uuidTs = (col: string) => `to_timestamp((('x' || substr(replace(${col}::text, '-', ''), 1, 12))::bit(48)::bigint) / 1000.0)`;

export async function getTagHistory(a: InventoryActor, tagId: string, q: { limit?: number; cursor?: string | null } = {}) {
  await getTag(a, tagId);   // inventory.stock.view + branch visibility (else 404)
  const limit = q.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) invalid('limit', '1-100');
  const c = q.cursor ? dec(q.cursor) : null;
  const rows = await many<Omit<TagHistoryEntry, 'from' | 'to'> & { k: string; fb: string | null; fc: string | null; ft: string | null;
    tb: string | null; tc: string | null; tt: string | null }>(`
    WITH h AS (
      SELECT l.occurred_at AS at, 'l:' || l.id AS k, 'ledger' AS kind, l.movement,
             CASE WHEN l.direction < 0 THEN l.branch_id END AS fb, CASE WHEN l.direction < 0 THEN l.counter_id END AS fc, CASE WHEN l.direction < 0 THEN l.box_id END AS ft,
             CASE WHEN l.direction > 0 THEN l.branch_id END AS tb, CASE WHEN l.direction > 0 THEN l.counter_id END AS tc, CASE WHEN l.direction > 0 THEN l.box_id END AS tt,
             NULL::text AS status_before, NULL::text AS status_after, l.source_type, l.source_id,
             CASE l.source_type WHEN 'stock_transfer' THEN (SELECT transfer_no FROM inventory.stock_transfer s WHERE s.id = l.source_id)
                                WHEN 'stock_adjustment' THEN (SELECT adjustment_no FROM inventory.stock_adjustment s WHERE s.id = l.source_id) END AS source_no,
             l.user_id AS actor_id, NULL::text AS note
        FROM inventory.stock_ledger l WHERE l.tag_id = $1 AND l.movement NOT IN ('move_out', 'move_in')
      UNION ALL
      SELECT m.moved_at, 'm:' || m.id, 'move', NULL, m.branch_id, m.from_counter_id, m.from_box_id, m.branch_id, m.to_counter_id, m.to_box_id,
             NULL, NULL, 'location_move', m.id, NULL, m.moved_by, m.reason
        FROM inventory.location_move m WHERE m.tag_id = $1
      UNION ALL
      SELECT ${uuidTs('tl.id')}, 't:' || tl.id, 'transfer', NULL, s.from_branch_id, NULL, NULL, s.to_branch_id, NULL, NULL,
             NULL, NULL, 'stock_transfer', s.id, s.transfer_no, s.requested_by, s.status
        FROM inventory.stock_transfer_line tl JOIN inventory.stock_transfer s ON s.id = tl.transfer_id WHERE tl.tag_id = $1
      UNION ALL
      SELECT d.requested_at, 'a:' || d.id, 'adjustment', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
             NULL, NULL, 'stock_adjustment', d.id, d.adjustment_no, d.requested_by, d.kind || ' ' || d.status || ': ' || d.reason
        FROM inventory.stock_adjustment d WHERE d.tag_id = $1
      UNION ALL
      SELECT sc.scanned_at, 's:' || sc.id, 'stock_check', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
             NULL, NULL, 'stock_take', sc.stock_take_id, NULL, sc.scanned_by, sc.scanned_code
        FROM inventory.stock_take_scan sc WHERE sc.tag_id = $1
      UNION ALL
      SELECT e.occurred_at, 'e:' || lpad(e.seq::text, 20, '0'),
             CASE WHEN e.old_row->>'status' IS DISTINCT FROM e.new_row->>'status' THEN 'status'
                  WHEN e.old_row->'label_print_count' IS DISTINCT FROM e.new_row->'label_print_count' THEN 'label_print' ELSE 'edit' END,
             NULL, NULL, NULL, NULL, NULL, NULL, NULL,
             CASE WHEN e.old_row->>'status' IS DISTINCT FROM e.new_row->>'status' THEN e.old_row->>'status' END,
             CASE WHEN e.old_row->>'status' IS DISTINCT FROM e.new_row->>'status' THEN e.new_row->>'status' END,
             NULL, NULL, NULL, e.user_id,
             CASE WHEN e.old_row->>'status' IS DISTINCT FROM e.new_row->>'status' THEN
                    (SELECT r.new_row->>'reason' FROM platform.audit_event r WHERE r.table_name = 'inventory.tag' AND r.row_id = e.row_id
                        AND r.action = 'inventory.tag.status_changed' AND r.new_row->>'to' = e.new_row->>'status'
                        AND r.occurred_at BETWEEN e.occurred_at - interval '10 seconds' AND e.occurred_at + interval '10 seconds'
                      ORDER BY abs(r.seq - e.seq) LIMIT 1)
                  WHEN e.old_row->'label_print_count' IS DISTINCT FROM e.new_row->'label_print_count' THEN
                    'copies: ' || ((e.new_row->>'label_print_count')::int - coalesce((e.old_row->>'label_print_count')::int, 0))
                  ELSE 'changed: ' || x.changed END
        FROM platform.audit_event e
        CROSS JOIN LATERAL (SELECT string_agg(n.key, ', ' ORDER BY n.key) AS changed FROM jsonb_each(e.new_row) n
                             WHERE n.value IS DISTINCT FROM e.old_row->n.key AND n.key <> ALL($4::text[])) x
       WHERE e.table_name = 'inventory.tag' AND e.row_id = $1 AND e.action = 'UPDATE'
         AND (e.old_row->>'status' IS DISTINCT FROM e.new_row->>'status' OR e.old_row->'label_print_count' IS DISTINCT FROM e.new_row->'label_print_count'
              OR x.changed IS NOT NULL)
    )
    SELECT to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at, k, kind, movement, fb, fc, ft, tb, tc, tt, status_before, status_after, source_type, source_id, source_no, actor_id, note
      FROM h WHERE ($2::timestamptz IS NULL OR (at, k) < ($2::timestamptz, $3::text)) ORDER BY h.at DESC, h.k DESC LIMIT ${limit + 1}`,
    [tagId, c?.at ?? null, c?.k ?? null, SKIP_EDIT]);
  const more = rows.length > limit;
  const page = more ? rows.slice(0, limit) : rows;
  const items: TagHistoryEntry[] = page.map(({ k: _k, fb, fc, ft, tb, tc, tt, ...r }) => ({ ...r,
    from: fb ? { branch_id: fb, counter_id: fc, tray_id: ft } : null, to: tb ? { branch_id: tb, counter_id: tc, tray_id: tt } : null }));
  const last = page[page.length - 1];
  return { items, next_cursor: more ? enc({ at: last.at, k: last.k }) : null };
}
