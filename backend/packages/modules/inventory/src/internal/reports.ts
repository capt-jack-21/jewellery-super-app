import { type InventoryActor, need, branchScope, needBranch } from './actor';
import { fail } from './errors';
import { many, one, gm, mg } from './db';
import { loadSettings } from './settings';
import { todayIST } from './numbering';
import { withLabels, type LabelFields } from './labels';

/** Branch filter: an explicit branch (checked), else every branch the caller may see. */
function scopeFilter(a: InventoryActor, branchId?: string | null): string[] | null {
  if (branchId) { needBranch(a, branchId); return [branchId]; }
  const s = branchScope(a);
  return s === null ? null : [...s];
}

/** 0.8.2 typed StockValuation.includes: which value components the totals contain (stone_value / making / gst come later). */
export interface StockValuationIncludes { metal: true; loose: boolean; stone_value: boolean; making: boolean; gst: boolean }
/** Ageing bucket code + label: first bucket is 0–(N−1) days, last is N+ days. */
export function ageBucket(from: number, to: number | null): { code: string; label: string } {
  return to === null ? { code: `${from}_plus`, label: `${from}+ days` } : { code: `${from}_${to}`, label: `${from}–${to} days` };
}
const VAL_GROUP = { purity: 'v.purity_id', metal: 'p.metal_id', branch: 'v.branch_id', counter: 'v.branch_id, v.counter_id', item: 'v.item_id, v.purity_id' } as const;
/** I11 valuation from v_stock_valuation: total_value with value_basis (metal only for now). */
export async function stockValuation(a: InventoryActor, q: { branch_id?: string | null; group_by?: keyof typeof VAL_GROUP; include_loose?: boolean } = {}) {
  need(a, 'inventory.valuation.view');
  const g = q.group_by ?? 'purity';
  if (!(g in VAL_GROUP)) fail(422, 'validation_failed', 'group_by');
  const br = scopeFilter(a, q.branch_id);
  const where = `($1::uuid[] IS NULL OR v.branch_id = ANY($1)) AND ($2 OR v.stock_kind = 'tag')`;
  const keys = VAL_GROUP[g];
  const sel = keys.split(', ').map((k) => `${k} AS ${k.split('.')[1]}`).join(', ');
  const rows = await many<Record<string, unknown>>(`SELECT ${sel}, ${g === 'purity' || g === 'item' ? 'max(v.rate_per_g)::text AS rate_per_g, max(v.rate_scope) AS rate_scope, max(v.rate_kind) AS rate_kind,' : ''}
      sum(v.pieces)::int AS pieces, sum(v.gross_wt)::numeric(14,3)::text AS gross_wt, sum(v.net_wt)::numeric(14,3)::text AS net_wt,
      coalesce(sum(v.metal_value), 0)::numeric(16,2)::text AS metal_value, coalesce(sum(v.total_value), 0)::numeric(16,2)::text AS total_value,
      'metal' AS value_basis
    FROM inventory.v_stock_valuation v JOIN masters.purity p ON p.id = v.purity_id
    WHERE ${where} GROUP BY ${keys} ORDER BY ${keys}`, [br, q.include_loose ?? true]);
  const tot = (await one<Record<string, string>>(`SELECT coalesce(sum(v.pieces), 0)::int AS pieces, coalesce(sum(v.gross_wt), 0)::numeric(14,3)::text AS gross_wt,
      coalesce(sum(v.net_wt), 0)::numeric(14,3)::text AS net_wt, coalesce(sum(v.metal_value), 0)::numeric(16,2)::text AS metal_value,
      coalesce(sum(v.total_value), 0)::numeric(16,2)::text AS total_value, 'metal' AS value_basis,
      coalesce(array_agg(DISTINCT v.purity_id) FILTER (WHERE v.rate_id IS NULL), '{}') AS missing
    FROM inventory.v_stock_valuation v WHERE ${where}`, [br, q.include_loose ?? true]))!;
  const { missing, ...totals } = tot as Record<string, unknown>;
  return { as_of: new Date().toISOString(), rate_date: todayIST(), value_basis: 'metal' as const, group_by: g,
    includes: { metal: true, loose: q.include_loose ?? true, stone_value: false, making: false, gst: false } satisfies StockValuationIncludes,
    rows, totals, missing_rate_purity_ids: missing as string[] };
}

const AGE_GROUP = { item: 'item_id', design: 'design_id', purity: 'purity_id', counter: 'counter_id' } as const;
/** Ageing (optional; 409 feature_disabled when off). since = COALESCE(received_on, IST tagged date); age_basis received | tagged. */
export async function stockAgeing(a: InventoryActor, q: { branch_id?: string | null; group_by?: keyof typeof AGE_GROUP; include_rows?: boolean; limit?: number } = {}) {
  need(a, 'inventory.ageing.view');
  const s = await loadSettings();
  if (!s.ageing_enabled) fail(409, 'feature_disabled', 'stock ageing is turned off in inventory settings');
  const g = q.group_by ?? 'item';
  if (!(g in AGE_GROUP)) fail(422, 'validation_failed', 'group_by');
  const col = AGE_GROUP[g];
  const br = scopeFilter(a, q.branch_id);
  const bounds = [...new Set(s.ageing_bucket_days)].sort((x, y) => x - y);
  const agg = await many<{ key_id: string | null; bucket_no: number; pieces: number; gross_wt: string; net_wt: string; oldest: number }>(
    `SELECT ${col} AS key_id, bucket_no, sum(pieces)::int AS pieces, sum(gross_wt)::numeric(14,3)::text AS gross_wt, sum(net_wt)::numeric(14,3)::text AS net_wt,
            max(age_days)::int AS oldest
       FROM inventory.v_tag_ageing WHERE ($1::uuid[] IS NULL OR branch_id = ANY($1)) GROUP BY 1, 2 ORDER BY 1, 2`, [br]);
  const empty = () => Array.from({ length: bounds.length + 1 }, (_, b) => {
    const from_days = b === 0 ? 0 : bounds[b - 1];
    const to_days = b < bounds.length ? bounds[b] - 1 : null;
    return { ...ageBucket(from_days, to_days), from_days, to_days, pieces: 0, gross_wt: '0.000', net_wt: '0.000' };
  });
  const groups = new Map<string, { key_id: string | null; label: string; buckets: ReturnType<typeof empty>; oldest_days: number }>();
  const totals = empty();
  const add = (x: { pieces: number; gross_wt: string; net_wt: string }, y: { pieces: number; gross_wt: string; net_wt: string }) => {
    x.pieces += y.pieces; x.gross_wt = gm(mg(x.gross_wt) + mg(y.gross_wt)); x.net_wt = gm(mg(x.net_wt) + mg(y.net_wt));
  };
  for (const r of agg) {
    const k = r.key_id ?? '';
    if (!groups.has(k)) groups.set(k, { key_id: r.key_id, label: r.key_id ?? '(none)', buckets: empty(), oldest_days: 0 });
    const gr = groups.get(k)!;
    add(gr.buckets[r.bucket_no], r); add(totals[r.bucket_no], r);
    gr.oldest_days = Math.max(gr.oldest_days, r.oldest);
  }
  const rows = q.include_rows ? await many<Record<string, unknown>>(
    `SELECT tag_id, tag_no, age_days, since::text, age_basis, item_id, purity_id, counter_id, gross_wt::text, net_wt::text
       FROM inventory.v_tag_ageing WHERE ($1::uuid[] IS NULL OR branch_id = ANY($1)) ORDER BY age_days DESC, tag_no LIMIT $2`, [br, Math.min(q.limit ?? 100, 500)]) : undefined;
  return { as_of: todayIST(), basis: 'received_or_tagged' as const, group_by: g, bucket_days: bounds, groups: [...groups.values()], totals, rows, next_cursor: null };
}

/** I4 loose stock balances. */
export async function looseStock(a: InventoryActor, q: { branch_id?: string | null; item_id?: string; purity_id?: string; counter_id?: string; tray_id?: string } = {}) {
  need(a, 'inventory.stock.view');
  const br = scopeFilter(a, q.branch_id);
  return many<Record<string, unknown>>(`SELECT branch_id, counter_id, box_id AS tray_id, item_id, purity_id, pieces::int, gross_wt::text, net_wt::text, fine_wt::text
      FROM inventory.v_loose_stock WHERE ($1::uuid[] IS NULL OR branch_id = ANY($1)) AND ($2::uuid IS NULL OR item_id = $2) AND ($3::uuid IS NULL OR purity_id = $3)
       AND ($4::uuid IS NULL OR counter_id = $4) AND ($5::uuid IS NULL OR box_id = $5) ORDER BY branch_id, counter_id NULLS FIRST, box_id NULLS FIRST, item_id`,
    [br, q.item_id ?? null, q.purity_id ?? null, q.counter_id ?? null, q.tray_id ?? null]);
}

/**
 * Stock on hand (0.8.3): tagged pieces from v_tag_stock_location (every status except sold, melted, returned_to_vendor and
 * written_off) plus loose balances from v_loose_stock (status null), grouped by location (branch, counter, tray), item, purity or
 * status. 0.9.0: tag_count = number of tags (pieces of a multi-piece tag count once in tag_count, all in tag_pieces); 0 on loose-only rows.
 * fine_wt = net × fineness (tags) + the loose ledger fine. Rows carry RefLabels; totals = the sum of every row.
 */
const SUMMARY_GROUPS = {
  location: { cols: ['branch_id', 'counter_id', 'box_id'], labels: { branch_id: 'branch', counter_id: 'counter', tray_id: 'tray' } },
  item: { cols: ['item_id'], labels: { item_id: 'item' } },
  purity: { cols: ['purity_id'], labels: { purity_id: 'purity' } },
  status: { cols: ['status'], labels: {} },
} as const;
export type SummaryGroup = keyof typeof SUMMARY_GROUPS;
const KEYS = ['branch_id', 'counter_id', 'box_id', 'item_id', 'purity_id', 'status'] as const;
export async function stockSummary(a: InventoryActor, q: { branch_id?: string | null; group_by?: SummaryGroup; include_loose?: boolean } = {}) {
  need(a, 'inventory.stock.view');
  const g = q.group_by ?? 'location';
  if (!(g in SUMMARY_GROUPS)) fail(422, 'validation_failed', 'group_by: location | item | purity | status');
  const cols = SUMMARY_GROUPS[g].cols as readonly string[];
  const sel = KEYS.map((k) => (cols.includes(k) ? `u.${k}` : `NULL::${k === 'status' ? 'text' : 'uuid'} AS ${k}`)).join(', ');
  const rows = await many<Record<string, unknown>>(`
    WITH u AS (
      SELECT v.branch_id, v.counter_id, v.box_id, v.item_id, v.purity_id, v.status, v.tags AS tc, v.pieces AS tp, v.gross_wt AS tg, v.net_wt AS tn,
             0::bigint AS lp, 0::numeric AS lg, 0::numeric AS ln,
             round(v.net_wt * CASE WHEN p.fineness > 1 THEN p.fineness / 1000.0 ELSE p.fineness END, 3) AS fine
        FROM inventory.v_tag_stock_location v JOIN masters.purity p ON p.id = v.purity_id
       WHERE ($1::uuid[] IS NULL OR v.branch_id = ANY($1))
      UNION ALL
      SELECT branch_id, counter_id, box_id, item_id, purity_id, NULL, 0, 0, 0, 0, pieces, gross_wt, net_wt, fine_wt
        FROM inventory.v_loose_stock WHERE $2 AND ($1::uuid[] IS NULL OR branch_id = ANY($1))
    )
    SELECT ${sel}, sum(tc)::int AS tag_count, sum(tp)::int AS tag_pieces, sum(tg)::numeric(14,3)::text AS tag_gross_wt, sum(tn)::numeric(14,3)::text AS tag_net_wt,
           sum(lp)::int AS loose_pieces, sum(lg)::numeric(14,3)::text AS loose_gross_wt, sum(ln)::numeric(14,3)::text AS loose_net_wt,
           sum(fine)::numeric(14,3)::text AS fine_wt
      FROM u GROUP BY ${cols.map((c) => `u.${c}`).join(', ')} ORDER BY ${cols.map((c) => `u.${c} NULLS FIRST`).join(', ')}`,
    [scopeFilter(a, q.branch_id), q.include_loose ?? true]);
  const shaped: Record<string, unknown>[] = rows.map(({ box_id, ...r }) => ({ ...r, tray_id: box_id as string | null }));
  const sum = (f: string) => gm(shaped.reduce((s, r) => s + mg(String(r[f])), 0n));
  const totals = { branch_id: null, counter_id: null, tray_id: null, item_id: null, purity_id: null, status: null,
    tag_count: shaped.reduce((s, r) => s + Number(r.tag_count), 0),
    tag_pieces: shaped.reduce((s, r) => s + Number(r.tag_pieces), 0), tag_gross_wt: sum('tag_gross_wt'), tag_net_wt: sum('tag_net_wt'),
    loose_pieces: shaped.reduce((s, r) => s + Number(r.loose_pieces), 0), loose_gross_wt: sum('loose_gross_wt'), loose_net_wt: sum('loose_net_wt'),
    fine_wt: sum('fine_wt') };
  return { group_by: g, as_of: new Date().toISOString(), rows: await withLabels(shaped, SUMMARY_GROUPS[g].labels as LabelFields), totals };
}
