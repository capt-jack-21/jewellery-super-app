import { withSavepoint } from '@jw/db';
import { type InventoryActor, need, needBranch } from './actor';
import { checkVersion, fail, invalid } from './errors';
import { many, one, tx, iso } from './db';
import { requestAdjustment } from './adjustments';
import { validateLocation } from './tags';
import { withLabels } from './labels';

export interface StockCheck {
  id: string; branch_id: string; counter_id: string | null; tray_id: string | null; status: 'open' | 'closed' | 'cancelled';
  started_at: string; started_by: string | null; closed_at: string | null; closed_by: string | null; notes: string | null; version: number;
}
export const CHECK_COLS = `id, branch_id, counter_id, box_id AS tray_id, status, ${iso('started_at')}, started_by, ${iso('closed_at')}, closed_by, notes, version`;
async function load(id: string, lock = false): Promise<StockCheck> {
  return (await one<StockCheck>(`SELECT ${CHECK_COLS} FROM inventory.stock_take WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [id])) ?? fail(404, 'not_found', 'stock check');
}
export type StockCheckCounts = { expected: number; scanned: number; matched: number; missing: number; extra: number };
export const ZERO_COUNTS: StockCheckCounts = { expected: 0, scanned: 0, matched: 0, missing: 0, extra: 0 };
/** Live counts from v_stock_take_report. Empty scope (no expected / scanned rows) → all zeros — never null/absent. */
export async function counts(id: string): Promise<StockCheckCounts> {
  return (await one<StockCheckCounts>(
    `SELECT count(*) FILTER (WHERE result <> 'extra')::int AS expected, (SELECT count(*)::int FROM inventory.stock_take_scan WHERE stock_take_id = $1) AS scanned,
            count(*) FILTER (WHERE result = 'matched')::int AS matched, count(*) FILTER (WHERE result = 'missing')::int AS missing,
            count(*) FILTER (WHERE result = 'extra')::int AS extra
       FROM inventory.v_stock_take_report WHERE stock_take_id = $1`, [id])) ?? { ...ZERO_COUNTS };
}
export async function countsForIds(ids: string[]): Promise<Map<string, StockCheckCounts>> {
  const out = new Map<string, StockCheckCounts>(ids.map((id) => [id, { ...ZERO_COUNTS }]));
  if (!ids.length) return out;
  // unnest + LEFT JOIN so every id gets a row even when the view is empty for that check
  const rows = await many<StockCheckCounts & { id: string }>(
    `SELECT st.id, count(*) FILTER (WHERE r.result <> 'extra')::int AS expected,
            (SELECT count(*)::int FROM inventory.stock_take_scan sc WHERE sc.stock_take_id = st.id) AS scanned,
            count(*) FILTER (WHERE r.result = 'matched')::int AS matched, count(*) FILTER (WHERE r.result = 'missing')::int AS missing,
            count(*) FILTER (WHERE r.result = 'extra')::int AS extra
       FROM unnest($1::uuid[]) AS st(id)
       LEFT JOIN inventory.v_stock_take_report r ON r.stock_take_id = st.id
      GROUP BY st.id`, [ids]);
  for (const r of rows) out.set(r.id, { expected: r.expected, scanned: r.scanned, matched: r.matched, missing: r.missing, extra: r.extra });
  return out;
}
/** 0.8.2: extra_reason is a stable enum; the view's status_<status> becomes wrong_status + extra_note = the tag status. */
export const EXTRA_REASONS = ['unknown_code', 'other_branch', 'other_location', 'wrong_status'] as const;
export type ExtraReason = (typeof EXTRA_REASONS)[number];
export function extraReason(v: string | null | undefined): { extra_reason: ExtraReason | null; extra_note: string | null } {
  if (!v) return { extra_reason: null, extra_note: null };
  if (v.startsWith('status_')) return { extra_reason: 'wrong_status', extra_note: v.slice(7) };
  return { extra_reason: (EXTRA_REASONS as readonly string[]).includes(v) ? (v as ExtraReason) : 'other_location', extra_note: null };
}
/** Start a live check for a branch / counter / tray. One open check per exact scope (409 check_already_open). */
export async function startStockCheck(a: InventoryActor, i: { branch_id: string; counter_id?: string | null; tray_id?: string | null; notes?: string | null }) {
  need(a, 'inventory.stock_check.run');
  needBranch(a, i.branch_id);
  await validateLocation(i.branch_id, i.counter_id, i.tray_id);
  await tx().query(`SELECT pg_advisory_xact_lock(hashtext('stock_take:' || platform.current_tenant()::text || $1))`, [i.branch_id]);
  const open = await one<{ id: string }>(`SELECT id FROM inventory.stock_take WHERE branch_id = $1 AND status = 'open'
      AND counter_id IS NOT DISTINCT FROM $2::uuid AND box_id IS NOT DISTINCT FROM $3::uuid`, [i.branch_id, i.counter_id ?? null, i.tray_id ?? null]);
  if (open) fail(409, 'check_already_open', open.id);
  const r = (await one<{ id: string }>(`INSERT INTO inventory.stock_take(tenant_id, branch_id, counter_id, box_id, status, started_by, notes)
     VALUES (platform.current_tenant(), $1, $2, $3, 'open', $4, $5) RETURNING id`, [i.branch_id, i.counter_id ?? null, i.tray_id ?? null, a.userId, i.notes ?? null]))!;
  // 0.8.6: same shape as GET — counts always present (zeros when the scope has no stock)
  const s = await load(r.id);
  return { ...s, counts: await counts(s.id) };
}
export async function getStockCheck(a: InventoryActor, id: string) {
  need(a, 'inventory.stock.view');
  const s = await load(id);
  needBranch(a, s.branch_id);
  return { ...s, counts: await counts(id) };
}
/** Classify a scan against the check's live expected set (990 backfill logic). Stores wrong_status + status note, not status_<x>. */
async function classifyScan(stockTakeId: string, tagId: string | null): Promise<{ result: 'matched' | 'extra'; extra_reason: ExtraReason | null; extra_note: string | null }> {
  if (!tagId) return { result: 'extra', extra_reason: 'unknown_code', extra_note: null };
  const row = await one<{ matched: boolean; other_branch: boolean; wrong_status: boolean; tag_status: string | null }>(
    `SELECT (t.branch_id = s.branch_id AND t.status IN ('in_stock','reserved')
              AND (s.counter_id IS NULL OR t.counter_id = s.counter_id)
              AND (s.box_id IS NULL OR t.box_id = s.box_id)) AS matched,
            (t.branch_id IS DISTINCT FROM s.branch_id) AS other_branch,
            (t.status NOT IN ('in_stock','reserved')) AS wrong_status,
            t.status AS tag_status
       FROM inventory.stock_take s CROSS JOIN inventory.tag t
      WHERE s.id = $1 AND t.id = $2`, [stockTakeId, tagId]);
  if (!row) return { result: 'extra', extra_reason: 'unknown_code', extra_note: null };
  if (row.matched) return { result: 'matched', extra_reason: null, extra_note: null };
  if (row.other_branch) return { result: 'extra', extra_reason: 'other_branch', extra_note: null };
  if (row.wrong_status) return { result: 'extra', extra_reason: 'wrong_status', extra_note: (row.tag_status ?? '').slice(0, 40) || null };
  return { result: 'extra', extra_reason: 'other_location', extra_note: null };
}
/**
 * Record one scan (tag_no, HUID or RFID). Idempotent: the same code — or another code of the same piece — again returns the first
 * scan with duplicate=true and bumps duplicate_count (990). Unknown codes are kept as extra (unknown_code).
 * On the test DB (990) result/extra_reason/extra_note are stored on INSERT.
 */
export async function recordScan(a: InventoryActor, id: string, rawCode: string) {
  need(a, 'inventory.stock_check.run');
  const code = (rawCode ?? '').trim().toUpperCase();
  if (!code || code.length > 64) invalid('code', '1-64 characters');
  const s = await load(id);
  needBranch(a, s.branch_id);
  if (s.status !== 'open') fail(409, 'check_closed', `stock check is ${s.status}`);
  const tag = await one<{ id: string; tag_no: string }>(
    `SELECT id, tag_no FROM inventory.tag WHERE tag_no = $1::text OR huid = $1::text OR rfid_epc = $1::text ORDER BY (tag_no = $1::text) DESC LIMIT 1`, [code]);
  const outcome = await classifyScan(id, tag?.id ?? null);
  type ScanRow = { id: string; scanned_at: string; result: 'matched' | 'extra'; extra_reason: string | null; extra_note: string | null };
  let duplicate = false;
  let scan: ScanRow | undefined;
  try {
    scan = await withSavepoint(async (c) => (await c.query<ScanRow>(
      `INSERT INTO inventory.stock_take_scan(tenant_id, stock_take_id, scanned_code, tag_id, scanned_by, result, extra_reason, extra_note)
       VALUES (platform.current_tenant(), $1, $2, $3, $4, $5, $6, $7)
       RETURNING id, ${iso('scanned_at')}, result, extra_reason, extra_note`,
      [id, code, tag?.id ?? null, a.userId, outcome.result, outcome.extra_reason, outcome.extra_note])).rows[0]);
  } catch (e) {
    if ((e as { code?: string }).code !== '23505') throw e;
    duplicate = true;
    // 990: only duplicate_count / last_duplicate_at may be updated
    scan = await one<ScanRow>(
      `UPDATE inventory.stock_take_scan SET duplicate_count = duplicate_count + 1, last_duplicate_at = now()
        WHERE id = (SELECT id FROM inventory.stock_take_scan WHERE stock_take_id = $1 AND (scanned_code = $2 OR tag_id = $3)
                     ORDER BY scanned_at LIMIT 1)
        RETURNING id, ${iso('scanned_at')}, result, extra_reason, extra_note`, [id, code, tag?.id ?? null]);
    if (!scan) {
      scan = await one<ScanRow>(`SELECT id, ${iso('scanned_at')}, result, extra_reason, extra_note FROM inventory.stock_take_scan
          WHERE stock_take_id = $1 AND (scanned_code = $2 OR tag_id = $3) ORDER BY scanned_at LIMIT 1`, [id, code, tag?.id ?? null]);
    }
  }
  return { scan_id: scan!.id, code, tag_id: tag?.id ?? null, tag_no: tag?.tag_no ?? null, result: scan!.result,
    extra_reason: (scan!.extra_reason as ExtraReason | null) ?? null, extra_note: scan!.extra_note ?? null,
    duplicate, scanned_at: scan!.scanned_at, counts: await counts(id) };
}
export async function undoScan(a: InventoryActor, id: string, scanId: string): Promise<void> {
  need(a, 'inventory.stock_check.run');
  const s = await load(id);
  needBranch(a, s.branch_id);
  if (s.status !== 'open') fail(409, 'check_closed', `stock check is ${s.status}`);
  const r = await tx().query(`DELETE FROM inventory.stock_take_scan WHERE id = $1 AND stock_take_id = $2`, [scanId, id]);
  if (!r.rowCount) fail(404, 'not_found', 'scan');
}
export async function stockCheckReport(a: InventoryActor, id: string, result?: 'matched' | 'missing' | 'extra') {
  need(a, 'inventory.stock.view');
  const s = await load(id);
  needBranch(a, s.branch_id);
  // 0.8.6 / 990: view prefers stored scan outcomes (+ extra_note). List/report rows are first-scan rows → duplicate false.
  // 0.8.8: the piece status is sent once, as the documented `status` (the undocumented duplicate `tag_status` is no longer sent).
  const rows = await many<Record<string, unknown> & { extra_reason: string | null; extra_note: string | null }>(
    `SELECT result, extra_reason, extra_note, tag_id, tag_no, scanned_code, ${iso('scanned_at')}, item_id, purity_id,
      gross_wt::text, net_wt::text, tag_status AS status, tag_branch_id AS branch_id, counter_id, box_id AS tray_id FROM inventory.v_stock_take_report
     WHERE stock_take_id = $1 AND ($2::text IS NULL OR result = $2) ORDER BY result, tag_no NULLS LAST, scanned_code`, [id, result ?? null]);
  return withLabels(rows.map((r) => {
    const er = extraReason(r.extra_reason);
    return { ...r, ...er, extra_note: r.extra_note ?? er.extra_note, duplicate: false };
  }), { branch_id: 'branch', item_id: 'item', purity_id: 'purity', counter_id: 'counter', tray_id: 'tray' });
}
/** Close (inventory.stock_check.close). create_adjustments: one pending full_write_off (reason loss) per missing piece. */
export async function closeStockCheck(a: InventoryActor, id: string, i: { create_adjustments?: boolean; notes?: string | null } = {}, ifVersion?: number) {
  need(a, 'inventory.stock_check.close');
  const s = await load(id, true);
  needBranch(a, s.branch_id);
  checkVersion('stock check', s.version, ifVersion);
  if (s.status !== 'open') fail(409, 'check_closed', `stock check is ${s.status}`);
  const missing = await many<{ tag_id: string; tag_no: string }>(`SELECT tag_id, tag_no FROM inventory.v_stock_take_report WHERE stock_take_id = $1 AND result = 'missing'`, [id]);
  const final = await counts(id);
  await tx().query(`UPDATE inventory.stock_take SET status = 'closed', closed_at = now(), closed_by = $2, notes = coalesce($3, notes) WHERE id = $1`, [id, a.userId, i.notes ?? null]);
  const created_adjustment_ids: string[] = [];
  if (i.create_adjustments) {
    need(a, 'inventory.adjustment.request');
    for (const m of missing) {
      const t = (await one<{ pieces: number; gross_wt: string; net_wt: string }>(`SELECT pieces, gross_wt::text, net_wt::text FROM inventory.tag WHERE id = $1`, [m.tag_id]))!;
      created_adjustment_ids.push((await requestAdjustment(a, { branch_id: s.branch_id, kind: 'full_write_off', tag_id: m.tag_id, delta_pieces: -t.pieces,
        delta_gross_wt: `-${t.gross_wt}`, delta_net_wt: `-${t.net_wt}`, reason_code: 'loss', reason: `Missing in stock check ${id}` })).id);
    }
  }
  // 0.8.8: the contract (and the web client) name is created_adjustment_ids; the server sent adjustment_ids
  return { ...(await load(id)), counts: final, created_adjustment_ids };
}
export async function cancelStockCheck(a: InventoryActor, id: string, ifVersion?: number) {
  need(a, 'inventory.stock_check.close');
  const s = await load(id, true);
  needBranch(a, s.branch_id);
  checkVersion('stock check', s.version, ifVersion);
  if (s.status !== 'open') fail(409, 'check_closed', `stock check is ${s.status}`);
  await tx().query(`UPDATE inventory.stock_take SET status = 'cancelled', closed_at = now(), closed_by = $2 WHERE id = $1`, [id, a.userId]);
  const done = await load(id);
  return { ...done, counts: await counts(id) };
}
