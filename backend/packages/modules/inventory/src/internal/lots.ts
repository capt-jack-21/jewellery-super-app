import { withSavepoint } from '@jw/db';
import { type InventoryActor, canSeeBranch, need, needBranch } from './actor';
import { checkVersion, fail, invalid } from './errors';
import { audit, branchCode, gm, ledger, many, mg, nextDocNo, one, tx, type LedgerRow } from './db';
import { validateLocation } from './tags';
import { docPrefixOf, indianFY, renderDocNo, todayIST } from './numbering';
import { branches, pageArgs, page, type Page, type PageQ } from './lists';

/**
 * Lots (0.8.3): stock receipts waiting to be tagged (inventory.lot / lot_line, 080). A PATCH adds, changes and (0.8.4) deletes lines;
 * app_rw may DELETE a lot_line only under 987 rw_delete_open_lot_only (lot open / tagged, nothing tagged from the line).
 * Status: open → tagged (every line with pieces fully tagged, set by createTags) → closed (closeLot). Only open lots are edited.
 */
export const LOT_NO_FORMAT = 'LOT-{BRANCH}-{FY}-{SEQ:5}';
export const LOT_INPUT_TYPES = ['other', 'purchase', 'order_receipt', 'refinery'] as const;
export interface LotLineInput {
  id?: string; item_id: string; sub_item_id?: string | null; purity_id?: string | null; pieces: number;
  gross_wt: string; stone_wt?: string; net_wt: string; other_wt?: string;
}
export interface LotInput {
  branch_id: string; vendor_id?: string | null; ref_invoice_no?: string | null; hallmark_centre?: string | null; hallmark_ref?: string | null;
  received_on?: string; lot_no?: string; entry_type?: (typeof LOT_INPUT_TYPES)[number]; lines: LotLineInput[];
  /** service calls only (not in the HTTP contract): the order / purchase this lot came from */
  ref_id?: string | null;
}
export type LotPatch = Partial<Omit<LotInput, 'branch_id' | 'lot_no' | 'entry_type'>>;
export interface LotLine {
  id: string; item_id: string; sub_item_id: string | null; purity_id: string | null; pieces: number; gross_wt: string; stone_wt: string;
  net_wt: string; other_wt: string; purchase_line_id: string | null; tagged_pieces: number; tagged_gross_wt: string;
  remaining_pieces: number; remaining_gross_wt: string; version: number;
}
export interface Lot {
  id: string; lot_no: string; entry_type: string; branch_id: string; vendor_id: string | null; ref_invoice_no: string | null;
  hallmark_centre: string | null; hallmark_ref: string | null; received_on: string; ref_id: string | null; status: 'open' | 'tagged' | 'closed';
  created_by: string | null; version: number; lines: LotLine[];
  totals: { pieces: number; gross_wt: string; net_wt: string; tagged_pieces: number; remaining_gross_wt: string };
}
const HEAD = `id, lot_no, entry_type, branch_id, vendor_id, ref_invoice_no, hallmark_centre, hallmark_ref, received_on::text, ref_id, status, created_by, version`;
const LINE = `id, lot_id, item_id, sub_item_id, purity_id, pieces, gross_wt::text, stone_wt::text, net_wt::text, other_wt::text, purchase_line_id,
  tagged_pieces, tagged_gross_wt::text, greatest(pieces - tagged_pieces, 0) AS remaining_pieces,
  greatest(gross_wt - tagged_gross_wt, 0)::numeric(14,3)::text AS remaining_gross_wt, version`;

function withLines(h: Omit<Lot, 'lines' | 'totals'>, raw: (LotLine & { lot_id?: string })[]): Lot {
  const lines = raw.map(({ lot_id: _l, ...l }) => ({ ...l, gross_wt: gm(mg(l.gross_wt)), stone_wt: gm(mg(l.stone_wt)), net_wt: gm(mg(l.net_wt)),
    other_wt: gm(mg(l.other_wt)), tagged_gross_wt: gm(mg(l.tagged_gross_wt)) }));
  const sum = (f: (l: LotLine) => bigint) => gm(lines.reduce((s, l) => s + f(l), 0n));
  return { ...h, lines, totals: { pieces: lines.reduce((s, l) => s + l.pieces, 0), gross_wt: sum((l) => mg(l.gross_wt)), net_wt: sum((l) => mg(l.net_wt)),
    tagged_pieces: lines.reduce((s, l) => s + l.tagged_pieces, 0), remaining_gross_wt: sum((l) => mg(l.remaining_gross_wt)) } };
}
async function load(id: string, lock = false): Promise<Lot> {
  const h = await one<Omit<Lot, 'lines' | 'totals'>>(`SELECT ${HEAD} FROM inventory.lot WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [id])
    ?? fail(404, 'not_found', 'lot');
  return withLines(h, await many<LotLine>(`SELECT ${LINE} FROM inventory.lot_line WHERE lot_id = $1 ORDER BY id`, [id]));
}
async function visibleLot(a: InventoryActor, id: string, lock = false): Promise<Lot> {
  const l = await load(id, lock);
  if (!canSeeBranch(a, l.branch_id)) fail(404, 'not_found', 'lot');
  return l;
}
export async function getLot(a: InventoryActor, id: string): Promise<Lot> {
  need(a, 'inventory.stock.view');
  return visibleLot(a, id);
}

const W = /^\d{1,7}(\.\d{1,3})?$/;
/** Shape + masters checks of one line; returns the purity to store (line, else the item's default, else null). */
async function checkLine(l: LotLineInput, k: number): Promise<string | null> {
  const p = `lines.${k}`;
  if (!Number.isInteger(l.pieces) || l.pieces < 0) invalid(`${p}.pieces`, 'integer ≥ 0');
  for (const f of ['gross_wt', 'net_wt', 'stone_wt', 'other_wt'] as const) {
    const v = l[f];
    if (v !== undefined && !W.test(String(v))) invalid(`${p}.${f}`, 'decimal string, up to 3 dp');
  }
  const g = mg(l.gross_wt), n = mg(l.net_wt);
  if (g <= 0n || n > g) fail(422, 'invalid_weights', `${p}: 0 < gross_wt and net_wt ≤ gross_wt`, [{ path: `${p}.net_wt`, code: 'invalid_weights', message: 'net ≤ gross, gross > 0' }]);
  const it = await one<{ is_active: boolean; purity_id: string | null }>(`SELECT is_active, purity_id FROM masters.item WHERE id = $1`, [l.item_id])
    ?? fail(422, 'unknown_reference', `${p}.item_id`);
  if (!it.is_active) fail(422, 'inactive_master', `${p}.item_id`);
  if (l.purity_id) {
    const pu = await one<{ is_active: boolean }>(`SELECT is_active FROM masters.purity WHERE id = $1`, [l.purity_id]) ?? fail(422, 'unknown_reference', `${p}.purity_id`);
    if (!pu.is_active) fail(422, 'inactive_master', `${p}.purity_id`);
  }
  return l.purity_id ?? it.purity_id ?? null;
}
async function checkVendor(id: string | null | undefined): Promise<void> {
  if (!id) return;
  // never select pan / pan_enc
  const v = await one<{ is_active: boolean }>(`SELECT is_active FROM masters.vendor WHERE id = $1`, [id]) ?? fail(422, 'unknown_reference', 'vendor_id');
  if (!v.is_active) fail(422, 'inactive_master', 'vendor_id');
}
function checkHeader(i: LotPatch): void {
  const len = (f: 'ref_invoice_no' | 'hallmark_centre' | 'hallmark_ref', max: number) => {
    const v = i[f];
    if (v != null && (typeof v !== 'string' || v.length > max)) invalid(f, `at most ${max} characters`);
  };
  len('ref_invoice_no', 40); len('hallmark_centre', 100); len('hallmark_ref', 60);
  if (i.received_on !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(i.received_on)) invalid('received_on', 'YYYY-MM-DD');
  if (i.lines !== undefined && (!Array.isArray(i.lines) || i.lines.length < 1 || i.lines.length > 200)) invalid('lines', '1-200 lines');
}
async function insertLine(lotId: string, l: LotLineInput, purity: string | null): Promise<void> {
  await tx().query(`INSERT INTO inventory.lot_line(tenant_id, lot_id, item_id, sub_item_id, purity_id, pieces, gross_wt, stone_wt, net_wt, other_wt)
     VALUES (platform.current_tenant(), $1, $2, $3, $4, $5, $6::numeric, coalesce($7::numeric, $6::numeric - $8::numeric), $8::numeric, coalesce($9::numeric, 0))`,
    [lotId, l.item_id, l.sub_item_id ?? null, purity, l.pieces, l.gross_wt, l.stone_wt ?? null, l.net_wt, l.other_wt ?? null]);
}

/** Manual lot (inventory.tag.create at the branch). lot_no from LOT-{BRANCH}-{FY}-{SEQ:5} unless given (409 duplicate_lot_no). */
export async function createLot(a: InventoryActor, i: LotInput): Promise<Lot> {
  need(a, 'inventory.tag.create');
  needBranch(a, i.branch_id);
  checkHeader(i);
  const type = i.entry_type ?? 'other';
  if (!(LOT_INPUT_TYPES as readonly string[]).includes(type)) invalid('entry_type', LOT_INPUT_TYPES.join(' | '));
  await checkVendor(i.vendor_id);
  const purities: (string | null)[] = [];
  for (const [k, l] of i.lines.entries()) purities.push(await checkLine(l, k));
  const code = await branchCode(i.branch_id);
  const given = i.lot_no?.trim();
  if (given !== undefined && (given.length < 1 || given.length > 30)) invalid('lot_no', '1-30 characters');
  const fy = indianFY(todayIST());
  let id: string | undefined;
  for (let attempt = 0; !id && attempt < 50; attempt++) {
    const no = given ?? renderDocNo(LOT_NO_FORMAT, { branchCode: code, fy },
      await nextDocNo(i.branch_id, 'lot', fy, docPrefixOf(LOT_NO_FORMAT, { branchCode: code, fy })));
    if (no.length > 30) fail(422, 'invalid_lot_no', 'the generated lot number is longer than 30 characters');
    try {
      id = await withSavepoint(async (c) => (await c.query<{ id: string }>(
        `INSERT INTO inventory.lot(tenant_id, branch_id, lot_no, entry_type, vendor_id, ref_invoice_no, hallmark_centre, hallmark_ref, received_on, created_by, ref_id)
         VALUES (platform.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8::date, $9, $10) RETURNING id`,
        [i.branch_id, no, type, i.vendor_id ?? null, i.ref_invoice_no ?? null, i.hallmark_centre ?? null, i.hallmark_ref ?? null,
          i.received_on ?? todayIST(), a.userId, i.ref_id ?? null])).rows[0].id);
    } catch (e) {
      if ((e as { code?: string }).code !== '23505') throw e;
      if (given !== undefined) fail(409, 'duplicate_lot_no', `lot ${given} already exists in this branch`);
      // a manually numbered lot took this number: try the next one
    }
  }
  if (!id) fail(409, 'duplicate_lot_no', 'no free lot number');
  for (const [k, l] of i.lines.entries()) await insertLine(id!, l, purities[k]);
  return load(id!);
}

/**
 * Edit an OPEN lot. lines = the whole list: entries with id update that line, without id add one. A line never drops below what is
 * tagged (422 below_tagged) and a tagged line keeps its item (422 line_tagged). Omitting a line deletes it (0.8.4, same transaction):
 * a line with tagged pieces or a piece pointing at it → 409 line_tagged. The DB backs this up (987 rw_delete_open_lot_only: lot open
 * or tagged, tagged_pieces = 0, no tag references the line); a delete it blocks touches 0 rows, mapped by removeLotLine.
 */
export async function updateLot(a: InventoryActor, id: string, p: LotPatch, ifVersion?: number): Promise<Lot> {
  need(a, 'inventory.tag.create');
  if (!p || !Object.keys(p).length) invalid('(body)', 'empty patch');
  checkHeader(p);
  const lot = await visibleLot(a, id, true);
  needBranch(a, lot.branch_id);
  checkVersion('lot', lot.version, ifVersion);
  if (lot.status !== 'open') fail(409, 'lot_not_open', `lot is ${lot.status}`);
  if (p.vendor_id !== undefined) await checkVendor(p.vendor_id);
  if (p.lines) {
    const byId = new Map(lot.lines.map((l) => [l.id, l]));
    const ids = p.lines.filter((l) => l.id).map((l) => l.id!);
    if (new Set(ids).size !== ids.length) invalid('lines', 'a line is listed twice');
    for (const [k, l] of p.lines.entries()) if (l.id && !byId.has(l.id)) invalid(`lines.${k}.id`, 'not a line of this lot', 'unknown_reference');
    const dropped = lot.lines.filter((l) => !ids.includes(l.id));
    if (dropped.length === lot.lines.length && !p.lines.length) invalid('lines', 'a lot keeps at least one line');
    const refd = dropped.length ? new Set((await many<{ lot_line_id: string }>(
      `SELECT DISTINCT lot_line_id FROM inventory.tag WHERE lot_line_id = ANY($1::uuid[])`, [dropped.map((l) => l.id)])).map((r) => r.lot_line_id)) : new Set<string>();
    for (const l of dropped)
      if (l.tagged_pieces > 0 || mg(l.tagged_gross_wt) > 0n || refd.has(l.id)) fail(409, 'line_tagged', `lot line ${l.id} has tagged pieces and cannot be removed`);
    const purities: (string | null)[] = [];
    for (const [k, l] of p.lines.entries()) {
      purities.push(await checkLine(l, k));
      const cur = l.id ? byId.get(l.id)! : undefined;
      if (cur && cur.tagged_pieces > 0) {
        if (l.item_id !== cur.item_id) invalid(`lines.${k}.item_id`, 'a line with tagged pieces keeps its item', 'line_tagged');
        if (l.pieces < cur.tagged_pieces || mg(l.gross_wt) < mg(cur.tagged_gross_wt))
          fail(422, 'below_tagged', `lines.${k}: ${cur.tagged_pieces} piece(s) / ${cur.tagged_gross_wt} g already tagged`,
            [{ path: `lines.${k}.pieces`, code: 'below_tagged', message: 'below what is already tagged' }]);
      }
    }
    for (const l of dropped) await removeLotLine(id, l.id);
    for (const [k, l] of p.lines.entries()) {
      if (!l.id) { await insertLine(id, l, purities[k]); continue; }
      await tx().query(`UPDATE inventory.lot_line SET item_id = $2, sub_item_id = $3, purity_id = $4, pieces = $5, gross_wt = $6::numeric,
          stone_wt = coalesce($7::numeric, $6::numeric - $8::numeric), net_wt = $8::numeric, other_wt = coalesce($9::numeric, 0) WHERE id = $1`,
        [l.id, l.item_id, l.sub_item_id ?? null, purities[k], l.pieces, l.gross_wt, l.stone_wt ?? null, l.net_wt, l.other_wt ?? null]);
    }
  }
  const has = (k: keyof LotPatch) => Object.prototype.hasOwnProperty.call(p, k);
  // always touch the header so the lot version moves with any line change (aa_version)
  await tx().query(`UPDATE inventory.lot SET vendor_id = CASE WHEN $2 THEN $3::uuid ELSE vendor_id END,
      ref_invoice_no = CASE WHEN $4 THEN $5 ELSE ref_invoice_no END, hallmark_centre = CASE WHEN $6 THEN $7 ELSE hallmark_centre END,
      hallmark_ref = CASE WHEN $8 THEN $9 ELSE hallmark_ref END, received_on = coalesce($10::date, received_on) WHERE id = $1`,
    [id, has('vendor_id'), p.vendor_id ?? null, has('ref_invoice_no'), p.ref_invoice_no ?? null, has('hallmark_centre'), p.hallmark_centre ?? null,
      has('hallmark_ref'), p.hallmark_ref ?? null, p.received_on ?? null]);
  // removing the last untagged line can leave every remaining line fully tagged: same rule as tagging (open → tagged)
  await tx().query(`UPDATE inventory.lot o SET status = 'tagged' WHERE o.id = $1 AND o.status = 'open'
      AND EXISTS (SELECT 1 FROM inventory.lot_line l WHERE l.lot_id = o.id AND l.tagged_pieces > 0)
      AND NOT EXISTS (SELECT 1 FROM inventory.lot_line l WHERE l.lot_id = o.id AND l.tagged_pieces < l.pieces)`, [id]);
  return load(id);
}
/** DELETE one lot line as app_rw. RLS (rw_delete_open_lot_only) turns a refused delete into 0 rows, not an error: say why. */
async function removeLotLine(lotId: string, lineId: string): Promise<void> {
  const r = await tx().query(`DELETE FROM inventory.lot_line WHERE id = $1 AND lot_id = $2`, [lineId, lotId]);
  if (r.rowCount) return;
  const why = await one<{ status: string; tagged: boolean }>(`SELECT lot.status, (l.tagged_pieces > 0 OR EXISTS (SELECT 1 FROM inventory.tag t
      WHERE t.lot_line_id = l.id)) AS tagged FROM inventory.lot_line l JOIN inventory.lot lot ON lot.id = l.lot_id WHERE l.id = $1 AND l.lot_id = $2`, [lineId, lotId]);
  if (!why) fail(404, 'not_found', 'lot line');
  if (why!.tagged) fail(409, 'line_tagged', `lot line ${lineId} has tagged pieces and cannot be removed`);
  if (why!.status !== 'open' && why!.status !== 'tagged') fail(409, 'lot_not_open', `lot is ${why!.status}`);
  fail(409, 'line_tagged', `lot line ${lineId} could not be removed`);
}

/**
 * Close a lot. remainder none: 409 lot_has_remainder when any line has untagged pieces / weight. to_loose: each remainder becomes
 * loose stock (ledger non_tag_in as inventory_writer, source lot_line) at the branch / counter / tray; net is pro rata to gross.
 * Closing a closed lot returns it unchanged.
 */
export async function closeLot(a: InventoryActor, id: string, i: { remainder?: 'none' | 'to_loose'; counter_id?: string | null; tray_id?: string | null } = {},
  ifVersion?: number): Promise<Lot> {
  need(a, 'inventory.tag.create');
  const lot = await visibleLot(a, id, true);
  needBranch(a, lot.branch_id);
  checkVersion('lot', lot.version, ifVersion);   // 0.8.4: If-Match (HTTP: 428 when missing); a closed lot at its current version is returned as is
  if (lot.status === 'closed') return lot;
  const mode = i.remainder ?? 'none';
  if (!['none', 'to_loose'].includes(mode)) invalid('remainder', 'none | to_loose');
  const rest = lot.lines.filter((l) => l.remaining_pieces > 0 || mg(l.remaining_gross_wt) > 0n);
  if (mode === 'none' && rest.length) fail(409, 'lot_has_remainder', `${rest.length} line(s) still have untagged stock; close with remainder to_loose`);
  if (mode === 'to_loose' && rest.length) {
    if (i.tray_id && !i.counter_id) invalid('counter_id', 'a tray needs its counter', 'tray_needs_counter');
    await validateLocation(lot.branch_id, i.counter_id ?? null, i.tray_id ?? null);
    const rows: LedgerRow[] = [];
    for (const [k, l] of rest.entries()) {
      if (!l.purity_id) invalid(`lines.${k}.purity_id`, 'the line and its item have no purity; set one before posting to loose stock', 'purity_required');
      const g = mg(l.gross_wt), r = mg(l.remaining_gross_wt);
      const n = g > 0n ? (mg(l.net_wt) * r) / g : 0n;
      rows.push({ branch_id: lot.branch_id, item_id: l.item_id, purity_id: l.purity_id!, movement: 'non_tag_in', direction: 1, pieces: l.remaining_pieces,
        gross_wt: gm(r), net_wt: gm(n), source_type: 'lot_line', source_id: l.id, user_id: a.userId, counter_id: i.counter_id ?? null, box_id: i.tray_id ?? null });
    }
    await ledger(rows);
    await audit('inventory.lot.remainder_to_loose', 'inventory.lot', id, { lines: rows.map((r) => ({ lot_line_id: r.source_id, pieces: r.pieces, gross_wt: r.gross_wt, net_wt: r.net_wt })),
      counter_id: i.counter_id ?? null, tray_id: i.tray_id ?? null });
  }
  await tx().query(`UPDATE inventory.lot SET status = 'closed' WHERE id = $1`, [id]);
  return load(id);
}

export async function listLots(a: InventoryActor, q: PageQ & { branch_id?: string | null; q?: string; ids?: string[]; status?: string; vendor_id?: string;
  entry_type?: string } = {}): Promise<Page<Lot>> {
  need(a, 'inventory.stock.view');
  const { limit, cursor } = pageArgs(q);
  if (q.q !== undefined && q.q.length > 100) invalid('q', 'at most 100 characters');
  if (q.ids && (q.ids.length < 1 || q.ids.length > 100)) invalid('ids', '1-100 ids');
  const like = q.q ? `${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
  const res = await page<Omit<Lot, 'lines' | 'totals'>>(`SELECT ${HEAD} FROM inventory.lot WHERE ($1::uuid[] IS NULL OR branch_id = ANY($1)) AND ($2::uuid IS NULL OR id < $2)
      AND ($3::text IS NULL OR lot_no ILIKE $3 OR ref_invoice_no ILIKE $3) AND ($4::uuid[] IS NULL OR id = ANY($4)) AND ($5::text IS NULL OR status = $5)
      AND ($6::uuid IS NULL OR vendor_id = $6) AND ($7::text IS NULL OR entry_type = $7)`,
    [branches(a, q.branch_id), cursor, like, q.ids ?? null, q.status ?? null, q.vendor_id ?? null, q.entry_type ?? null], limit);
  const lines = res.items.length ? await many<LotLine & { lot_id: string }>(`SELECT ${LINE} FROM inventory.lot_line WHERE lot_id = ANY($1::uuid[]) ORDER BY id`,
    [res.items.map((l) => l.id)]) : [];
  return { items: res.items.map((h) => withLines(h, lines.filter((l) => l.lot_id === h.id))), next_cursor: res.next_cursor };
}
