import { withSavepoint } from '@jw/db';
import { type InventoryActor, need, needBranch, canSeeBranch } from './actor';
import { checkVersion, fail, invalid } from './errors';
import { audit, ledger, lockTag, lockTags, many, one, tx, writeTag, gm, mg, iso } from './db';
import { loadSettings } from './settings';
import { TAG_NO_MAX, renderTagNo, tagScopeKey } from './numbering';
import { type TagStatus, assertTransition, TAG_STATUSES } from './statuses';

export interface TagCreate {
  item_id: string; purity_id?: string; sub_item_id?: string | null; design_id?: string | null;
  gross_wt: string; stone_wt?: string; net_wt?: string; pieces?: number; huid?: string | null; size?: string | null;
  counter_id?: string | null; box_id?: string | null; mc_type?: 'per_gram' | 'percent' | 'flat' | 'per_piece'; mc_value?: string | number;
  wastage_pct?: string | number; received_on?: string | null; lot_line_id?: string | null;
  /** 0.8.2: descriptive columns of the contract TagInput / BulkTagInput */
  hsn?: string | null; value_addition_rule_id?: string | null; min_wastage_pct?: string | number | null; max_wastage_pct?: string | number | null;
  min_sale_value?: string | number | null; max_sale_value?: string | number | null; huid_charge?: string | number; hallmark_exempt?: boolean;
  cost_value?: string | number | null; cover_wt?: string; loop_wt?: string;
  /** 987 (Perceptor, 0.8.3): supplier's lot / batch reference, 1-60 chars; written by app_rw (inventory_writer has no UPDATE on it). */
  vendor_lot_ref?: string | null;
}
export interface CreatedTag { id: string; tag_no: string; skipped_numbers: string[] }

const MAX_SKIPS = 50;
/** Next number of a scope: locks the tag_counter row (INSERT … ON CONFLICT DO NOTHING, then UPDATE … RETURNING). */
async function nextTagNo(scopeKey: string, startNo: number): Promise<number> {
  const c = tx();
  await c.query(`INSERT INTO inventory.tag_counter(tenant_id, scope_key, next_no) VALUES (platform.current_tenant(), $1, $2) ON CONFLICT DO NOTHING`, [scopeKey, startNo]);
  const r = await c.query<{ n: string }>(`UPDATE inventory.tag_counter SET next_no = greatest(next_no, $2) + 1, updated_at = now()
      WHERE tenant_id = platform.current_tenant() AND scope_key = $1 RETURNING (next_no - 1)::text AS n`, [scopeKey, startNo]);
  return Number(r.rows[0].n);
}
export async function validateLocation(branchId: string, counterId?: string | null, boxId?: string | null): Promise<void> {
  if (boxId && !counterId) invalid('box_id', 'a tray needs its counter');
  if (counterId) {
    const ctr = await one<{ branch_id: string }>(`SELECT branch_id FROM masters.counter WHERE id = $1`, [counterId]);
    if (!ctr) fail(422, 'unknown_reference', 'counter_id');
    if (ctr.branch_id !== branchId) fail(422, 'location_mismatch', 'counter is not in this branch');
  }
  if (boxId) {
    const bx = await one<{ counter_id: string }>(`SELECT counter_id FROM masters.box WHERE id = $1`, [boxId]);
    if (!bx) fail(422, 'unknown_reference', 'box_id');
    if (bx.counter_id !== counterId) fail(422, 'location_mismatch', 'tray is not on this counter');
  }
}

/** Tagging from a lot line: the lot is open, in this branch, for this item, and the line has pieces left (0.8.3). */
async function checkLotLine(lineId: string, branchId: string, itemId: string, pieces: number, k: number): Promise<void> {
  const l = await one<{ pieces: number; tagged_pieces: number; item_id: string; branch_id: string; status: string }>(
    `SELECT l.pieces, l.tagged_pieces, l.item_id, lot.branch_id, lot.status FROM inventory.lot_line l JOIN inventory.lot lot ON lot.id = l.lot_id
      WHERE l.id = $1 FOR UPDATE OF l`, [lineId]) ?? fail(422, 'unknown_reference', `tags[${k}].lot_line_id`);
  if (l.status === 'closed') fail(409, 'lot_not_open', 'the lot is closed');
  if (l.branch_id !== branchId) fail(422, 'location_mismatch', 'the lot is in another branch');
  if (l.item_id !== itemId) invalid(`tags[${k}].item_id`, 'the lot line is for another item', 'lot_item_mismatch');
  if (l.pieces > 0 && l.tagged_pieces + pieces > l.pieces)
    fail(422, 'lot_line_exhausted', `the lot line has ${Math.max(l.pieces - l.tagged_pieces, 0)} untagged piece(s) left`);
}
/** open → tagged once every line with pieces is fully tagged. */
async function markLotTagged(lineId: string): Promise<void> {
  await tx().query(`UPDATE inventory.lot o SET status = 'tagged' WHERE o.id = (SELECT lot_id FROM inventory.lot_line WHERE id = $1) AND o.status = 'open'
      AND NOT EXISTS (SELECT 1 FROM inventory.lot_line l WHERE l.lot_id = o.id AND l.tagged_pieces < l.pieces)`, [lineId]);
}

/**
 * Tag pieces (I1). Each number is rendered from shop_setting at creation and stored in tag.tag_no; numbers already used
 * (e.g. imported) are skipped. Posts a 'tagged' ledger row per piece. Whole request in the caller's transaction.
 */
export async function createTags(a: InventoryActor, branchId: string, rows: TagCreate[]): Promise<CreatedTag[]> {
  need(a, 'inventory.tag.create');
  needBranch(a, branchId);
  if (!rows.length || rows.length > 200) invalid('tags', '1-200 pieces');
  const s = await loadSettings();
  const branch = await one<{ code: string }>(`SELECT code FROM platform.branch WHERE id = $1`, [branchId]) ?? fail(422, 'unknown_reference', 'branch_id');
  const out: CreatedTag[] = [];
  for (const [k, r] of rows.entries()) {
    const item = await one<{ code: string; purity_id: string | null; mc_type: string; mc_value: string; stock_type: string }>(
      `SELECT code, purity_id, mc_type, mc_value::text, stock_type FROM masters.item WHERE id = $1`, [r.item_id]) ?? fail(422, 'unknown_reference', `tags[${k}].item_id`);
    if (item.stock_type !== 'tag') invalid(`tags[${k}].item_id`, 'item is not a tagged item', 'not_tag_item');
    const purityId = r.purity_id ?? item.purity_id ?? invalid(`tags[${k}].purity_id`, 'required');
    const pur = await one<{ huid_required: boolean }>(`SELECT huid_required FROM masters.purity WHERE id = $1`, [purityId]) ?? fail(422, 'unknown_reference', `tags[${k}].purity_id`);
    const huid = r.huid ? r.huid.toUpperCase() : null;
    if (huid && !/^[A-Z0-9]{6}$/.test(huid)) invalid(`tags[${k}].huid`, '6 characters A-Z 0-9');
    if (!huid && pur.huid_required) invalid(`tags[${k}].huid`, 'HUID is required for this purity', 'huid_required');
    const gross = mg(r.gross_wt), stone = mg(r.stone_wt ?? '0'), net = r.net_wt !== undefined ? mg(r.net_wt) : gross - stone;
    if (gross <= 0n || stone < 0n || stone > gross || net <= 0n || net > gross) invalid(`tags[${k}].net_wt`, 'weights: 0 < net ≤ gross, stone ≤ gross');
    const pieces = r.pieces ?? 1;
    const vlr = r.vendor_lot_ref == null ? null : r.vendor_lot_ref.trim();
    if (vlr !== null && (vlr.length < 1 || vlr.length > 60)) invalid(`tags[${k}].vendor_lot_ref`, '1-60 characters');
    if (!Number.isInteger(pieces) || pieces < 1) invalid(`tags[${k}].pieces`, '≥ 1');
    await validateLocation(branchId, r.counter_id, r.box_id);
    if (r.lot_line_id) await checkLotLine(r.lot_line_id, branchId, r.item_id, pieces, k);
    const scope = tagScopeKey(s.tag_format, { branchCode: branch.code, itemCode: item.code });
    const skipped: string[] = [];
    let created: { id: string; tag_no: string } | undefined;
    while (!created) {
      const tagNo = renderTagNo(s.tag_format, { branchCode: branch.code, itemCode: item.code }, await nextTagNo(scope, s.tag_format.start_no));
      if (tagNo.length > TAG_NO_MAX) fail(422, 'tag_no_too_long', 'the tag number format renders more than 30 characters');
      try {
        created = await withSavepoint((c) => c.query<{ id: string; tag_no: string }>(
          `INSERT INTO inventory.tag(tenant_id, branch_id, tag_no, lot_line_id, item_id, sub_item_id, design_id, purity_id, huid, hallmark_exempt,
             pieces, gross_wt, stone_wt, net_wt, size, counter_id, box_id, mc_type, mc_value, wastage_pct, received_on, tagged_by,
             hsn, value_addition_rule_id, min_wastage_pct, max_wastage_pct, min_sale_value, max_sale_value, huid_charge, cost_value, cover_wt, loop_wt, vendor_lot_ref)
           VALUES (platform.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21,
             $22, $23, $24, $25, $26, $27, coalesce($28::numeric, 0), $29, coalesce($30::numeric, 0), coalesce($31::numeric, 0), $32)
           RETURNING id, tag_no`,
          [branchId, tagNo, r.lot_line_id ?? null, r.item_id, r.sub_item_id ?? null, r.design_id ?? null, purityId, huid, r.hallmark_exempt ?? !huid, pieces,
           gm(gross), gm(stone), gm(net), r.size ?? null, r.counter_id ?? null, r.box_id ?? null, r.mc_type ?? item.mc_type,
           r.mc_value ?? item.mc_value, r.wastage_pct ?? 0, r.received_on ?? null, a.userId,
           r.hsn ?? null, r.value_addition_rule_id ?? null, r.min_wastage_pct ?? null, r.max_wastage_pct ?? null, r.min_sale_value ?? null,
           r.max_sale_value ?? null, r.huid_charge == null ? null : String(r.huid_charge), r.cost_value ?? null, r.cover_wt ?? null, r.loop_wt ?? null, vlr]).then((q) => q.rows[0]));
      } catch (e) {
        const pe = e as { code?: string; constraint?: string };
        if (pe.code === '23505' && pe.constraint === 'tag_tenant_id_tag_no_key') {
          skipped.push(tagNo);
          if (skipped.length >= MAX_SKIPS) fail(409, 'tag_no_exhausted', `${MAX_SKIPS} numbers in a row are taken; change the start number`);
          continue;
        }
        if (pe.code === '23505' && pe.constraint === 'tag_huid_uq') fail(409, 'huid_exists', `tags[${k}].huid is already on another tag`);
        if (pe.code === '23503') fail(422, 'unknown_reference', `tags[${k}]: ${pe.constraint ?? 'reference'}`);
        if (pe.code === '23514') fail(422, 'check_violation', `tags[${k}]: ${pe.constraint ?? 'check'}`);
        throw e;
      }
    }
    if (r.lot_line_id) {
      await tx().query(`UPDATE inventory.lot_line SET tagged_pieces = tagged_pieces + $2, tagged_gross_wt = tagged_gross_wt + $3::numeric WHERE id = $1`,
        [r.lot_line_id, pieces, gm(gross)]);
      await markLotTagged(r.lot_line_id);
    }
    await ledger([{ branch_id: branchId, tag_id: created.id, item_id: r.item_id, purity_id: purityId, movement: 'tagged', direction: 1,
      pieces, gross_wt: gm(gross), net_wt: gm(net), source_type: 'tag', source_id: created.id, user_id: a.userId,
      counter_id: r.counter_id ?? null, box_id: r.box_id ?? null }]);
    out.push({ ...created, skipped_numbers: skipped });
  }
  return out;
}

export interface TagView {
  id: string; tag_no: string; barcode_payload: string; branch_id: string; item_id: string; purity_id: string; status: TagStatus; pieces: number; gross_wt: string;
  stone_wt: string; net_wt: string; huid: string | null; counter_id: string | null; tray_id: string | null; received_on: string | null;
  mc_type: 'per_gram' | 'percent' | 'flat' | 'per_piece'; mc_value: string; wastage_pct: string;
  tagged_at: string; vendor_lot_ref: string | null; label_print_count: number; label_printed_at: string | null; version: number;
}
/** 0.8.7: + barcode_payload, mc_type, mc_value, wastage_pct (contract Tag; the piece page showed "undefined · —"); box_id → tray_id as the contract names it.
 *  0.8.9: + label_print_count (int, 0 = never printed) and label_printed_at (timestamptz text like tagged_at; null = never printed), both straight
 *  from inventory.tag (987), which printLabels updates. Shared by GET /tags/{id}, /tag-lookup/{tagNo}, GET /tags, POST /tags(/bulk), PATCH, bulk-update. */
export const VIEW_COLS = `id, tag_no, COALESCE(label_payload, tag_no::text) AS barcode_payload, branch_id, item_id, purity_id, status, pieces, gross_wt::text,
  stone_wt::text, net_wt::text, huid, counter_id, box_id AS tray_id, mc_type, mc_value::text, wastage_pct::text,
  received_on::text, ${iso('tagged_at')}, vendor_lot_ref, label_print_count, ${iso('label_printed_at')}, version`;
export async function getTag(a: InventoryActor, id: string): Promise<TagView> {
  need(a, 'inventory.stock.view');
  const t = await one<TagView>(`SELECT ${VIEW_COLS} FROM inventory.tag WHERE id = $1`, [id]);
  if (!t || !canSeeBranch(a, t.branch_id)) fail(404, 'not_found', 'tag');
  return t;
}
/** Barcode / HUID / RFID lookup (scanner). */
export async function lookupTag(a: InventoryActor, code: string): Promise<TagView> {
  need(a, 'inventory.stock.view');
  const c = code.trim().toUpperCase();
  const t = await one<TagView>(`SELECT ${VIEW_COLS} FROM inventory.tag WHERE tag_no = $1::text OR huid = $1::text OR rfid_epc = $1::text ORDER BY (tag_no = $1::text) DESC LIMIT 1`, [c]);
  if (!t || !canSeeBranch(a, t.branch_id)) fail(404, 'not_found', 'tag');
  return t;
}
/**
 * POST /tags/{id}/status — manual reserve / repair / melting and back (inventory.tag.status). Never sold / written_off here:
 * written_off only through an approved full_write_off; a written_off piece never changes again (409 tag_written_off).
 */
export async function changeTagStatus(a: InventoryActor, id: string, to: TagStatus, reason: string, ifVersion?: number): Promise<TagView> {
  need(a, 'inventory.tag.status_change');
  if (!(TAG_STATUSES as readonly string[]).includes(to)) invalid('status', 'unknown status');
  if (!reason || reason.trim().length < 3) invalid('reason', 'at least 3 characters');
  const t = await lockTag(id);
  needBranch(a, t.branch_id);
  checkVersion('tag', t.version, ifVersion);
  assertTransition(t.status, to, 'manual');
  await writeTag(id, { status: to });
  await audit('inventory.tag.status_changed', 'inventory.tag', id, { from: t.status, to, reason: reason.trim() });
  return getTag(a, id);
}
/**
 * Descriptive edits (TagPatch): the columns app_rw may UPDATE on inventory.tag (960 + 987 column grants, checked on the test DB),
 * minus counter_id / box_id (→ moves) and the label print counters (→ /labels). stones are not editable here (422 field_not_editable).
 * Weights / pieces → adjustments, status → /status, branch → transfers.
 */
export const TAG_EDITABLE = ['design_id', 'hsn', 'value_addition_rule_id', 'size', 'mc_type', 'mc_value', 'wastage_pct', 'min_wastage_pct', 'max_wastage_pct',
  'min_sale_value', 'max_sale_value', 'huid_charge', 'cost_value', 'huid', 'hallmark_exempt', 'received_on', 'label_payload',
  'vendor_lot_ref'] as const;
export type TagChanges = Partial<Record<(typeof TAG_EDITABLE)[number], string | number | boolean | null>>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUM = /^\d{1,12}(\.\d{1,4})?$/;
/** Per-field shape checks (the DB checks the rest: 23514 → 422 check_violation, 23503 → 422 unknown_reference, 23505 huid → 409). */
const FIELD: Record<(typeof TAG_EDITABLE)[number], (v: unknown) => string | null> = {
  design_id: (v) => (v === null || (typeof v === 'string' && UUID.test(v)) ? null : 'uuid or null'),
  value_addition_rule_id: (v) => (v === null || (typeof v === 'string' && UUID.test(v)) ? null : 'uuid or null'),
  hsn: (v) => (v === null || (typeof v === 'string' && /^[0-9]{4,8}$/.test(v)) ? null : '4-8 digits'),
  size: (v) => (v === null || (typeof v === 'string' && v.length >= 1 && v.length <= 20) ? null : '1-20 characters'),
  mc_type: (v) => (['per_gram', 'percent', 'flat', 'per_piece'].includes(v as string) ? null : 'per_gram | percent | flat | per_piece'),
  mc_value: (v) => (NUM.test(String(v)) && v !== null ? null : 'non-negative decimal'),
  wastage_pct: (v) => (v !== null && NUM.test(String(v)) && Number(v) <= 100 ? null : '0-100'),
  min_wastage_pct: (v) => (v === null || (NUM.test(String(v)) && Number(v) <= 100) ? null : '0-100 or null'),
  max_wastage_pct: (v) => (v === null || (NUM.test(String(v)) && Number(v) <= 100) ? null : '0-100 or null'),
  min_sale_value: (v) => (v === null || NUM.test(String(v)) ? null : 'non-negative amount or null'),
  max_sale_value: (v) => (v === null || NUM.test(String(v)) ? null : 'non-negative amount or null'),
  huid_charge: (v) => (v !== null && NUM.test(String(v)) ? null : 'non-negative amount'),
  cost_value: (v) => (v === null || NUM.test(String(v)) ? null : 'non-negative amount or null'),
  huid: (v) => (v === null || (typeof v === 'string' && /^[A-Za-z0-9]{6}$/.test(v)) ? null : '6 letters / digits or null'),
  hallmark_exempt: (v) => (typeof v === 'boolean' ? null : 'boolean'),
  received_on: (v) => (v === null || (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) ? null : 'YYYY-MM-DD or null'),
  label_payload: (v) => (v === null || (typeof v === 'string' && v.length >= 1 && v.length <= 512) ? null : '1-512 characters or null'),
  vendor_lot_ref: (v) => (v === null || (typeof v === 'string' && v.trim().length >= 1 && v.trim().length <= 60) ? null : '1-60 characters or null'),
};
function checkChanges(changes: Record<string, unknown>): TagChanges {
  const keys = Object.keys(changes ?? {});
  if (!keys.length) invalid('changes', 'empty patch');
  const bad = keys.filter((k) => !(TAG_EDITABLE as readonly string[]).includes(k));
  if (bad.length) fail(422, 'validation_failed', 'not editable here (location → moves, weights → adjustments, status → /status)',
    bad.map((k) => ({ path: `changes.${k}`, code: 'field_not_editable', message: 'not editable here' })));
  const errs = keys.map((k) => ({ k, m: FIELD[k as keyof typeof FIELD](changes[k]) })).filter((x) => x.m);
  if (errs.length) fail(422, 'validation_failed', 'invalid tag fields', errs.map((x) => ({ path: `changes.${x.k}`, code: 'invalid', message: x.m! })));
  const c = { ...changes } as TagChanges;
  if (typeof c.huid === 'string') c.huid = c.huid.toUpperCase();
  if (typeof c.vendor_lot_ref === 'string') c.vendor_lot_ref = c.vendor_lot_ref.trim();
  return c;
}
async function applyChanges(id: string, c: TagChanges): Promise<void> {
  const keys = Object.keys(c) as (keyof TagChanges)[];
  const set = keys.map((k, n) => `${k} = $${n + 2}`).join(', ');
  try {
    await withSavepoint((cl) => cl.query(`UPDATE inventory.tag SET ${set} WHERE id = $1`, [id, ...keys.map((k) => c[k] ?? null)]));
  } catch (e) {
    const pe = e as { code?: string };
    if (pe.code === '23503') fail(422, 'unknown_reference', 'design_id / value_addition_rule_id');
    if (pe.code === '23505') fail(409, 'huid_taken', 'this HUID is already on another piece');
    if (pe.code === '23514') fail(422, 'check_violation', (e as { constraint?: string }).constraint ?? 'tag check');
    throw e;
  }
}
export async function patchTag(a: InventoryActor, id: string, changes: Record<string, unknown>, ifVersion?: number): Promise<TagView> {
  need(a, 'inventory.tag.edit');
  const c = checkChanges(changes);
  const t = await lockTag(id);
  needBranch(a, t.branch_id);
  if (t.status === 'written_off') fail(409, 'tag_written_off', `${t.tag_no} is written off`);
  checkVersion('tag', t.version, ifVersion);
  await applyChanges(id, c);
  return getTag(a, id);
}
/** Same change on ≤ 200 tags, each guarded by its version; any stale → 412 listing the stale ids; all-or-nothing. */
export async function bulkUpdateTags(a: InventoryActor, items: { id: string; version: number }[], changes: Record<string, unknown>): Promise<TagView[]> {
  need(a, 'inventory.tag.edit');
  if (!items?.length || items.length > 200) invalid('items', '1-200');
  if (new Set(items.map((i) => i.id)).size !== items.length) invalid('items', 'a tag is listed twice', 'duplicate_tag');
  const c = checkChanges(changes);
  const tags = await lockTags(items.map((i) => i.id));
  const stale = items.filter((i) => tags.get(i.id)!.version !== i.version);
  for (const i of items) {
    const t = tags.get(i.id)!;
    needBranch(a, t.branch_id);
    if (t.status === 'written_off') fail(409, 'tag_written_off', `${t.tag_no} is written off`);
  }
  if (stale.length) fail(412, 'version_mismatch', 'some tags were changed by someone else',
    stale.map((i) => ({ path: `items.${items.indexOf(i)}.version`, code: 'stale', message: `${i.id} is now version ${tags.get(i.id)!.version}` })));
  for (const i of items) await applyChanges(i.id, c);
  await audit('inventory.tag.bulk_updated', 'inventory.tag', null, { tag_ids: items.map((i) => i.id), fields: Object.keys(c) });
  return many<TagView>(`SELECT ${VIEW_COLS} FROM inventory.tag WHERE id = ANY($1::uuid[]) ORDER BY tag_no`, [items.map((i) => i.id)]);
}
/** Service call for other modules' flows (sale, approval memo, vendor return, refinery). Checks the transition table. */
export async function transitionTag(id: string, to: TagStatus, via: Exclude<Parameters<typeof assertTransition>[2], 'manual' | 'full_write_off'>): Promise<void> {
  const t = await lockTag(id);
  assertTransition(t.status, to, via);
  await writeTag(id, { status: to });
}

/** TagLabel (contract): the documented v_tag_label columns, in contract order. tenant_id / branch_id / hallmark_exempt / design_name /
 *  label_printed_at stay server-side (0.8.8: they were sent undocumented). The piece's label_printed_at is on the Tag (0.8.9). */
const LABEL_COLS = `tag_id, tag_no, barcode_payload, item_code, item_name, sub_item_name, design_code, purity_code, hsn, gross_wt::text, stone_wt::text,
  net_wt::text, pieces, huid, size, mc_type, mc_value::text, wastage_pct::text, counter_code, tray_code, label_print_count`;
export interface TagLabelRow {
  tag_id: string; tag_no: string; barcode_payload: string; item_code: string; item_name: string; sub_item_name: string | null; design_code: string | null;
  purity_code: string; hsn: string | null; gross_wt: string; stone_wt: string; net_wt: string; pieces: number; huid: string | null; size: string | null;
  mc_type: string; mc_value: string; wastage_pct: string; counter_code: string | null; tray_code: string | null;
  copies: number; duplicate: boolean; label_print_count: number;
}
/** TagLabelBatch (contract): what POST /labels and POST /tags/bulk (print_labels) return. */
export interface TagLabelBatch {
  doc_type: 'tag_label'; generated_at: string; template_id: string | null; template_version: number | null; barcode_format: 'code128' | 'qr';
  labels: TagLabelRow[];
}
/** The shop's active tag_label print template (own first, else the platform default); barcode_format from its config, default code128. */
async function activeLabelTemplate(): Promise<{ template_id: string | null; template_version: number | null; barcode_format: 'code128' | 'qr' }> {
  const t = await one<{ id: string; version: number; fmt: string | null }>(
    `SELECT id, version, config->>'barcode_format' AS fmt FROM branding.print_template
      WHERE doc_type = 'tag_label' AND is_active AND (tenant_id = platform.current_tenant() OR tenant_id IS NULL)
      ORDER BY (tenant_id IS NULL), version DESC LIMIT 1`, []);
  return { template_id: t?.id ?? null, template_version: t?.version ?? null, barcode_format: t?.fmt === 'qr' ? 'qr' : 'code128' };
}

/**
 * I2 labels: rows of v_tag_label; marks printed (count + time). reprint=false refuses already-printed tags (409 already_printed).
 * 0.8.7: reprint_reason may be null / missing on a normal print; reprint=true needs 3-200 chars (422 validation_failed, path reprint_reason).
 * 0.8.8: returns the contract TagLabelBatch (doc_type tag_label, generated_at, template, barcode_format); each row carries copies and
 * duplicate (= printed before this request), and label_print_count after it. Same checks and writes as before.
 */
export async function printLabels(a: InventoryActor, tagIds: string[], opts: { copies?: number; reprint?: boolean; reprint_reason?: string | null } = {}): Promise<TagLabelBatch> {
  need(a, 'inventory.tag.print_label');
  if (!tagIds.length || tagIds.length > 500) invalid('tag_ids', '1-500');
  const copies = opts.copies ?? 1;
  if (!Number.isInteger(copies) || copies < 1 || copies > 5) invalid('copies', '1-5');
  const reason = typeof opts.reprint_reason === 'string' ? opts.reprint_reason.trim() : '';
  if (opts.reprint && (reason.length < 3 || reason.length > 200)) invalid('reprint_reason', 'a reprint needs a reason of 3-200 characters', 'required');
  const rows = await many<Omit<TagLabelRow, 'copies' | 'duplicate'> & { branch_id: string }>(
    `SELECT branch_id, ${LABEL_COLS} FROM inventory.v_tag_label WHERE tag_id = ANY($1::uuid[]) ORDER BY tag_no`, [tagIds]);
  if (rows.length !== new Set(tagIds).size) fail(404, 'not_found', 'tag');
  for (const r of rows) needBranch(a, r.branch_id);
  if (!opts.reprint && rows.some((r) => r.label_print_count > 0)) fail(409, 'already_printed', 'send reprint=true to print again');
  await tx().query(`UPDATE inventory.tag SET label_printed_at = now(), label_print_count = label_print_count + $2 WHERE id = ANY($1::uuid[])`, [tagIds, copies]);
  if (opts.reprint) await audit('inventory.label.reprint', 'inventory.tag', null, { tag_ids: tagIds, copies, reason });
  return { doc_type: 'tag_label', generated_at: new Date().toISOString(), ...(await activeLabelTemplate()),
    labels: rows.map(({ branch_id: _b, ...r }) => ({ ...r, copies, duplicate: r.label_print_count > 0, label_print_count: r.label_print_count + copies })) };
}

/** Photos (optional feature, off by default → 409 feature_disabled). */
export async function addTagPhoto(a: InventoryActor, tagId: string, fileId: string, opts: { is_primary?: boolean; caption?: string } = {}): Promise<TagPhoto> {
  need(a, 'inventory.tag.photos');
  if (!(await loadSettings()).photos_enabled) fail(409, 'feature_disabled', 'photos are turned off in inventory settings');
  const t = await lockTag(tagId);
  needBranch(a, t.branch_id);
  const n = await one<{ n: number }>(`SELECT count(*)::int n FROM inventory.tag_photo WHERE tag_id = $1`, [tagId]);
  if (n!.n >= 10) fail(409, 'too_many_photos', 'at most 10 photos per piece');
  if (opts.is_primary) await tx().query(`UPDATE inventory.tag_photo SET is_primary = false WHERE tag_id = $1 AND is_primary`, [tagId]);
  try {
    // 0.8.8: returns the contract TagPhoto (was { id } only)
    return await withSavepoint(async (c) => (await c.query<TagPhoto>(
      `INSERT INTO inventory.tag_photo(tenant_id, tag_id, file_id, sort_order, is_primary, caption, created_by)
       VALUES (platform.current_tenant(), $1, $2, $3, $4, $5, $6) RETURNING ${PHOTO_COLS}`,
      [tagId, fileId, n!.n, opts.is_primary ?? n!.n === 0, opts.caption ?? null, a.userId])).rows[0]);
  } catch (e) {
    const pe = e as { code?: string; constraint?: string };
    if (pe.code === '23505') fail(409, 'already_attached', 'this file is already on the piece');
    if (pe.code === '23503') fail(422, 'unknown_reference', 'file_id');
    throw e;
  }
}
export async function removeTagPhoto(a: InventoryActor, tagId: string, photoId: string): Promise<void> {
  need(a, 'inventory.tag.photos');
  const t = await lockTag(tagId);
  needBranch(a, t.branch_id);
  const r = await tx().query(`DELETE FROM inventory.tag_photo WHERE id = $1 AND tag_id = $2`, [photoId, tagId]);
  if (!r.rowCount) fail(404, 'not_found', 'photo');
}
export interface TagPhoto { id: string; tag_id: string; file_id: string; caption: string | null; is_primary: boolean; sort_order: number; created_at: string; version: number }
const PHOTO_COLS = `id, tag_id, file_id, caption, is_primary, sort_order, ${iso('created_at')}, version`;
/** Photos of a visible piece, primary first then sort_order (inventory.stock.view; 404 when the piece is not visible). No url: the client
 *  asks GET /v1/files/{file_id}/url (the inventory resolver below grants it to anyone who can see the piece). */
export async function listTagPhotos(a: InventoryActor, tagId: string): Promise<TagPhoto[]> {
  await getTag(a, tagId);
  return many<TagPhoto>(`SELECT ${PHOTO_COLS} FROM inventory.tag_photo WHERE tag_id = $1 ORDER BY is_primary DESC, sort_order, id`, [tagId]);
}
/** Caption / sort_order / is_primary (inventory.tag.photos). is_primary true moves the primary here; false on the primary → 422 (pick another one). */
export async function updateTagPhoto(a: InventoryActor, tagId: string, photoId: string,
  p: { caption?: string | null; is_primary?: boolean; sort_order?: number }, ifVersion?: number): Promise<TagPhoto> {
  need(a, 'inventory.tag.photos');
  if (!p || !Object.keys(p).length) invalid('(body)', 'empty patch');
  if (p.caption != null && (typeof p.caption !== 'string' || p.caption.length > 200)) invalid('caption', 'at most 200 characters');
  if (p.sort_order !== undefined && (!Number.isInteger(p.sort_order) || p.sort_order < 0)) invalid('sort_order', 'integer ≥ 0');
  if (!(await loadSettings()).photos_enabled) fail(409, 'feature_disabled', 'photos are turned off in inventory settings');
  const t = await one<{ branch_id: string }>(`SELECT branch_id FROM inventory.tag WHERE id = $1 FOR UPDATE`, [tagId]);
  if (!t || !canSeeBranch(a, t.branch_id)) fail(404, 'not_found', 'tag');
  needBranch(a, t!.branch_id);
  const ph = await one<TagPhoto>(`SELECT ${PHOTO_COLS} FROM inventory.tag_photo WHERE id = $1 AND tag_id = $2 FOR UPDATE`, [photoId, tagId]) ?? fail(404, 'not_found', 'photo');
  checkVersion('photo', ph.version, ifVersion);
  if (p.is_primary === false && ph.is_primary) invalid('is_primary', 'a piece keeps one primary photo: make another photo primary instead', 'primary_required');
  if (p.is_primary === true && !ph.is_primary) await tx().query(`UPDATE inventory.tag_photo SET is_primary = false WHERE tag_id = $1 AND is_primary`, [tagId]);
  const has = (k: string) => Object.prototype.hasOwnProperty.call(p, k);
  await tx().query(`UPDATE inventory.tag_photo SET caption = CASE WHEN $2 THEN $3 ELSE caption END, sort_order = coalesce($4, sort_order),
      is_primary = coalesce($5, is_primary) WHERE id = $1`, [photoId, has('caption'), p.caption ?? null, p.sort_order ?? null, p.is_primary ?? null]);
  return (await one<TagPhoto>(`SELECT ${PHOTO_COLS} FROM inventory.tag_photo WHERE id = $1`, [photoId]))!;
}
/** platform file access (GET /v1/files/{id}/url, area attachments): a piece photo is readable by anyone who can see the piece. */
export async function tagPhotoFileAccess(file: { id: string }, auth: InventoryActor): Promise<boolean> {
  if (!auth.permissions.has('inventory.stock.view')) return false;
  const rows = await many<{ branch_id: string }>(`SELECT t.branch_id FROM inventory.tag_photo p JOIN inventory.tag t ON t.id = p.tag_id WHERE p.file_id = $1`, [file.id]);
  return rows.some((r) => canSeeBranch(auth, r.branch_id));
}
/** label_payload right after create (app_rw UPDATE column; no version check — the caller just created the pieces). */
export async function setLabelPayloads(rows: { id: string; label_payload: string }[]): Promise<void> {
  for (const r of rows) {
    if (r.label_payload.length < 1 || r.label_payload.length > 512) invalid('label_payload', '1-512 characters');
    await tx().query(`UPDATE inventory.tag SET label_payload = $2 WHERE id = $1`, [r.id, r.label_payload]);
  }
}
