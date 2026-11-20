import { type InventoryActor, branchScope, canSeeBranch, need, needBranch } from './actor';
import { fail, invalid } from './errors';
import { withLabels } from './labels';
import { many, one, iso } from './db';
import { VIEW_COLS, type TagView } from './tags';
import { T_COLS, linesOf } from './transfers';
import { ADJ_COLS } from './adjustments';
import { CHECK_COLS, extraReason, countsForIds, type StockCheck } from './stockchecks';
import { TAG_STATUSES, TERMINAL } from './statuses';
/** 0.8.5: GET /tags with no status filter = in stock only (every status except the terminal ones, written_off included). */
export const DEFAULT_TAG_STATUSES: readonly string[] = TAG_STATUSES.filter((s) => !TERMINAL.has(s));

/**
 * List endpoints (0.8.2): keyset pages ordered by id DESC (uuid v7 = creation order). cursor = the last id of the previous page.
 * Branch scope: branch_id given → must be in scope (403 branch_scope); absent → every branch the caller can see.
 */
export interface Page<T> { items: T[]; next_cursor: string | null }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface PageQ { limit?: number; cursor?: string | null }
export function pageArgs(q: PageQ): { limit: number; cursor: string | null } {
  const limit = q.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) invalid('limit', '1-200');
  if (q.cursor != null && !UUID.test(q.cursor)) invalid('cursor', 'not a cursor from this list');
  return { limit, cursor: q.cursor ?? null };
}
/** null = all branches; else the allowed ids (narrowed to branchId when given). */
export function branches(a: InventoryActor, branchId?: string | null): string[] | null {
  if (branchId) { needBranch(a, branchId); return [branchId]; }
  const s = branchScope(a);
  return s === null ? null : [...s];
}
export async function page<T extends { id: string }>(sql: string, params: unknown[], limit: number): Promise<Page<T>> {
  const rows = await many<T>(`${sql} ORDER BY id DESC LIMIT ${limit + 1}`, params);
  const more = rows.length > limit;
  const items = more ? rows.slice(0, limit) : rows;
  return { items, next_cursor: more ? items[items.length - 1].id : null };
}

export async function listTags(a: InventoryActor, q: PageQ & { branch_id?: string | null; counter_id?: string; tray_id?: string; item_id?: string;
  design_id?: string; purity_id?: string; lot_id?: string; status?: string[]; tagged_from?: string; tagged_to?: string } = {}): Promise<Page<TagView>> {
  need(a, 'inventory.stock.view');
  const { limit, cursor } = pageArgs(q);
  for (const s of q.status ?? []) if (!(TAG_STATUSES as readonly string[]).includes(s)) invalid('status', `unknown status ${s}`);
  return page<TagView>(`SELECT ${VIEW_COLS} FROM inventory.tag t WHERE ($1::uuid[] IS NULL OR branch_id = ANY($1)) AND ($2::uuid IS NULL OR id < $2)
      AND ($3::uuid IS NULL OR counter_id = $3) AND ($4::uuid IS NULL OR box_id = $4) AND ($5::uuid IS NULL OR item_id = $5)
      AND ($6::uuid IS NULL OR design_id = $6) AND ($7::uuid IS NULL OR purity_id = $7)
      AND ($8::uuid IS NULL OR lot_line_id IN (SELECT id FROM inventory.lot_line WHERE lot_id = $8))
      AND ($9::text[] IS NULL OR status = ANY($9)) AND ($10::date IS NULL OR (tagged_at AT TIME ZONE 'Asia/Kolkata')::date >= $10)
      AND ($11::date IS NULL OR (tagged_at AT TIME ZONE 'Asia/Kolkata')::date <= $11)`,
    [branches(a, q.branch_id), cursor, q.counter_id ?? null, q.tray_id ?? null, q.item_id ?? null, q.design_id ?? null, q.purity_id ?? null,
      q.lot_id ?? null, q.status?.length ? q.status : [...DEFAULT_TAG_STATUSES], q.tagged_from ?? null, q.tagged_to ?? null], limit);
}
export async function listTransfers(a: InventoryActor, q: PageQ & { branch_id?: string | null; status?: string; direction?: 'in' | 'out' } = {}) {
  need(a, 'inventory.stock.view');
  const { limit, cursor } = pageArgs(q);
  const b = branches(a, q.branch_id);
  const p = await page<{ id: string }>(`SELECT ${T_COLS} FROM inventory.stock_transfer WHERE ($2::uuid IS NULL OR id < $2) AND ($3::text IS NULL OR status = $3)
      AND ($1::uuid[] IS NULL OR (($4::text IS NULL OR $4 = 'out') AND from_branch_id = ANY($1)) OR (($4::text IS NULL OR $4 = 'in') AND to_branch_id = ANY($1)))`,
    [b, cursor, q.status ?? null, q.direction ?? null], limit);
  // 0.8.8: each row carries its lines (contract Transfer requires lines; the list sent none)
  const lines = await linesOf(p.items.map((i) => i.id));
  return { ...p, items: p.items.map((i) => ({ ...i, lines: lines.get(i.id)! })) };
}
export async function listStockChecks(a: InventoryActor, q: PageQ & { branch_id?: string | null; status?: string } = {}) {
  need(a, 'inventory.stock.view');
  const { limit, cursor } = pageArgs(q);
  const p = await page<StockCheck>(`SELECT ${CHECK_COLS} FROM inventory.stock_take WHERE ($1::uuid[] IS NULL OR branch_id = ANY($1)) AND ($2::uuid IS NULL OR id < $2)
      AND ($3::text IS NULL OR status = $3)`, [branches(a, q.branch_id), cursor, q.status ?? null], limit);
  // 0.8.6: each item carries live counts (zeros when empty) — FE Running / open-list read counts.* without optional chaining
  const cmap = await countsForIds(p.items.map((i) => i.id));
  return { ...p, items: p.items.map((i) => ({ ...i, counts: cmap.get(i.id)! })) };
}
export async function listAdjustments(a: InventoryActor, q: PageQ & { branch_id?: string | null; status?: string; tag_id?: string } = {}) {
  need(a, 'inventory.stock.view');
  const { limit, cursor } = pageArgs(q);
  return page<{ id: string }>(`SELECT ${ADJ_COLS} FROM inventory.stock_adjustment WHERE ($1::uuid[] IS NULL OR branch_id = ANY($1)) AND ($2::uuid IS NULL OR id < $2)
      AND ($3::text IS NULL OR status = $3) AND ($4::uuid IS NULL OR tag_id = $4)`, [branches(a, q.branch_id), cursor, q.status ?? null, q.tag_id ?? null], limit);
}
/** Ledger rows; direction is exposed as 'in' | 'out' (0.8.2; the DB stores +1 / -1). */
export async function listLedger(a: InventoryActor, q: PageQ & { branch_id?: string | null; tag_id?: string; item_id?: string; movement?: string;
  source_id?: string; from?: string; to?: string } = {}) {
  need(a, 'inventory.stock.view');
  const { limit, cursor } = pageArgs(q);
  return page<{ id: string }>(`SELECT id, ${iso('occurred_at', 'at')}, branch_id, counter_id, box_id AS tray_id, movement, CASE WHEN direction > 0 THEN 'in' ELSE 'out' END AS direction,
      tag_id, (SELECT tag_no FROM inventory.tag t WHERE t.id = l.tag_id) AS tag_no, item_id, purity_id, pieces, gross_wt::text, net_wt::text, fine_wt::text,
      source_module, source_type, source_id, user_id
      FROM inventory.stock_ledger l WHERE ($1::uuid[] IS NULL OR branch_id = ANY($1)) AND ($2::uuid IS NULL OR id < $2)
      AND ($3::uuid IS NULL OR tag_id = $3) AND ($4::uuid IS NULL OR item_id = $4) AND ($5::text IS NULL OR movement = $5)
      AND ($6::uuid IS NULL OR source_id = $6) AND ($7::date IS NULL OR (occurred_at AT TIME ZONE 'Asia/Kolkata')::date >= $7)
      AND ($8::date IS NULL OR (occurred_at AT TIME ZONE 'Asia/Kolkata')::date <= $8)`,
    [branches(a, q.branch_id), cursor, q.tag_id ?? null, q.item_id ?? null, q.movement ?? null, q.source_id ?? null, q.from ?? null, q.to ?? null], limit);
}

/** Counter / tray moves (inventory.location_move, 988), newest first. counter_id matches from or to; from / to are IST dates. */
const MOVE_COLS = `id, branch_id, tag_id, (SELECT tag_no FROM inventory.tag t WHERE t.id = m.tag_id) AS tag_no,
      item_id, purity_id, pieces, gross_wt::text, net_wt::text, from_counter_id, from_box_id AS from_tray_id, to_counter_id, to_box_id AS to_tray_id,
      reason, moved_by, ${iso('moved_at')}`;
/** 0.8.8: the LocationMove rows just written (POST /moves answers { items: LocationMove[], moved }; it sent bare ids). */
export async function locationMovesByIds(ids: string[]) {
  if (!ids.length) return [];
  return many<Record<string, unknown>>(`SELECT ${MOVE_COLS} FROM inventory.location_move m WHERE id = ANY($1::uuid[]) ORDER BY id`, [ids]);
}
export async function listLocationMoves(a: InventoryActor, q: PageQ & { branch_id?: string | null; tag_id?: string; counter_id?: string; from?: string; to?: string } = {}) {
  need(a, 'inventory.stock.view');
  const { limit, cursor } = pageArgs(q);
  const res = await page<Record<string, unknown> & { id: string }>(`SELECT ${MOVE_COLS} FROM inventory.location_move m
     WHERE ($1::uuid[] IS NULL OR branch_id = ANY($1)) AND ($2::uuid IS NULL OR id < $2) AND ($3::uuid IS NULL OR tag_id = $3)
       AND ($4::uuid IS NULL OR from_counter_id = $4 OR to_counter_id = $4)
       AND ($5::date IS NULL OR (moved_at AT TIME ZONE 'Asia/Kolkata')::date >= $5) AND ($6::date IS NULL OR (moved_at AT TIME ZONE 'Asia/Kolkata')::date <= $6)`,
    [branches(a, q.branch_id), cursor, q.tag_id ?? null, q.counter_id ?? null, q.from ?? null, q.to ?? null], limit);
  return { items: await withLabels(res.items, { branch_id: 'branch', item_id: 'item', purity_id: 'purity', from_counter_id: 'counter', to_counter_id: 'counter',
    from_tray_id: 'tray', to_tray_id: 'tray' }), next_cursor: res.next_cursor };
}
/** Scans of one stock check, newest first (inventory.stock_check.run at its branch; 404 when the check is not visible). */
export async function listStockCheckScans(a: InventoryActor, id: string, q: PageQ = {}) {
  need(a, 'inventory.stock_check.run');
  const { limit, cursor } = pageArgs(q);
  const s = await one<{ branch_id: string }>(`SELECT branch_id FROM inventory.stock_take WHERE id = $1`, [id]);
  if (!s || !canSeeBranch(a, s.branch_id)) fail(404, 'not_found', 'stock check');
  needBranch(a, s!.branch_id);
  // 0.8.6 / 990: outcomes live on stock_take_scan; list rows are the first-scan row → duplicate always false (re-scans bump duplicate_count only).
  const res = await page<{ id: string; extra_reason: string | null; extra_note: string | null }>(
    `SELECT sc.id, sc.scanned_code AS code, sc.tag_id, t.tag_no, sc.scanned_by, ${iso('sc.scanned_at')},
            sc.result, sc.extra_reason, sc.extra_note
       FROM inventory.stock_take_scan sc LEFT JOIN inventory.tag t ON t.id = sc.tag_id
      WHERE sc.stock_take_id = $1 AND ($2::uuid IS NULL OR sc.id < $2)`, [id, cursor], limit);
  return { items: res.items.map((s) => {
    const er = extraReason(s.extra_reason);
    return { ...s, ...er, extra_note: s.extra_note ?? er.extra_note, duplicate: false };
  }), next_cursor: res.next_cursor };
}
