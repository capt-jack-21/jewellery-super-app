import { withModuleRole } from '@jw/db';
import { fail } from './errors';
import { many, one, writeTag, mg } from './db';
import { assertTransition, type TagStatus } from './statuses';
import { looseBalance } from './loose';

/**
 * Stock services Sales calls inside ITS request transaction (S14 / S23 / S6 / S15 / S16). Inventory stays the only writer of
 * inventory.tag status and inventory.stock_ledger; Sales passes the bill / credit note as the source (source_module 'sales').
 */
export interface SaleTag {
  id: string; tag_no: string; branch_id: string; item_id: string; sub_item_id: string | null; purity_id: string; status: TagStatus;
  pieces: number; gross_wt: string; stone_wt: string; net_wt: string; counter_id: string | null; box_id: string | null;
  huid: string | null; hallmark_exempt: boolean; hsn: string | null; mc_type: string; mc_value: string; wastage_pct: string;
  min_wastage_pct: string | null; max_wastage_pct: string | null; min_sale_value: string | null; max_sale_value: string | null; huid_charge: string;
}
/** reservedTagIds: tags that may be sold although reserved (the pieces of the order being delivered; Sales passes them, Orders names them). */
export interface SaleStockCtx { branchId: string; userId: string; sourceType: string; sourceId: string; reservedTagIds?: readonly string[] }
export interface LooseSaleRow { item_id: string; purity_id: string; counter_id: string | null; box_id: string | null; pieces: number; gross_wt: string; net_wt: string }
export interface RestockRow extends LooseSaleRow { tag_id: string | null }

const COLS = `id, tag_no, branch_id, item_id, sub_item_id, purity_id, status, pieces, gross_wt::text, stone_wt::text, net_wt::text, counter_id, box_id,
  huid, hallmark_exempt, hsn, mc_type, mc_value::text, wastage_pct::text, min_wastage_pct::text, max_wastage_pct::text,
  min_sale_value::text, max_sale_value::text, huid_charge::text`;

/** Scan resolution (S1): tag number, HUID or the label / barcode payload → tag id (read-only; undefined = unknown). */
export async function findTagForSale(code: string): Promise<string | undefined> {
  const c = code.trim();
  return (await one<{ id: string }>(`SELECT id FROM inventory.tag WHERE tag_no = $1 OR upper(huid) = upper($1) OR label_payload = $1 OR rfid_epc = $1
      ORDER BY (tag_no = $1) DESC, id LIMIT 1`, [c]))?.id;
}
/** Read (lock = FOR UPDATE in id order, for issue) tags for a sale; missing ids are absent from the map. */
export async function tagsForSale(ids: string[], lock: boolean): Promise<Map<string, SaleTag>> {
  const uniq = [...new Set(ids)].sort();
  if (!uniq.length) return new Map();
  const rows = await many<SaleTag>(`SELECT ${COLS} FROM inventory.tag WHERE id = ANY($1::uuid[]) ORDER BY id${lock ? ' FOR UPDATE' : ''}`, [uniq]);
  return new Map(rows.map((r) => [r.id, r]));
}
/** Stock.validateSellable: 409 with the reason a piece cannot be sold at this branch. */
export function assertSellable(t: SaleTag, branchId: string, reservedOk = false): void {
  const code: Partial<Record<TagStatus, string>> = { sold: 'tag_sold', reserved: 'tag_reserved', on_approval: 'tag_on_approval',
    in_transit: 'tag_in_transit', repair: 'tag_in_repair', melting: 'tag_not_sellable', melted: 'tag_not_sellable',
    returned_to_vendor: 'tag_not_sellable', written_off: 'tag_not_sellable' };
  if (t.status !== 'in_stock' && !(reservedOk && t.status === 'reserved')) fail(409, code[t.status] ?? 'tag_not_sellable', `tag ${t.tag_no} is ${t.status}`);
  if (t.branch_id !== branchId) fail(409, 'tag_other_branch', `tag ${t.tag_no} is at another branch`);
  if (!t.huid && !t.hallmark_exempt) fail(409, 'huid_missing', `tag ${t.tag_no} has no HUID and is not hallmark-exempt`);
}
async function ledgerRow(r: { branch_id: string; tag_id: string | null; item_id: string | null; purity_id: string; movement: string; direction: 1 | -1;
  pieces: number; gross_wt: string; net_wt: string; counter_id: string | null; box_id: string | null }, ctx: SaleStockCtx): Promise<string> {
  return withModuleRole('inventory_writer', async (c) => {
    const res = await c.query<{ id: string }>(
      `INSERT INTO inventory.stock_ledger(tenant_id, branch_id, tag_id, item_id, purity_id, movement, direction, pieces, gross_wt, net_wt,
                                          fine_wt, source_module, source_type, source_id, user_id, counter_id, box_id)
       SELECT platform.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8::numeric, $9::numeric,
              round($9::numeric * CASE WHEN p.fineness > 1 THEN p.fineness / 1000.0 ELSE p.fineness END, 3),
              'sales', $10, $11, $12, $13, $14
         FROM masters.purity p WHERE p.id = $4 RETURNING id`,
      [r.branch_id, r.tag_id, r.item_id, r.purity_id, r.movement, r.direction, r.pieces, r.gross_wt, r.net_wt,
       ctx.sourceType, ctx.sourceId, ctx.userId, r.counter_id, r.box_id]);
    if (res.rowCount !== 1) fail(422, 'unknown_reference', 'purity_id');
    return res.rows[0].id;
  });
}
/** Stock.markSold: in_stock / reserved → sold, ledger 'sale' (-1) at the piece's counter / tray. Tags must be locked by the caller. */
export async function markSold(tagIds: string[], ctx: SaleStockCtx): Promise<void> {
  const tags = await tagsForSale(tagIds, true);
  for (const id of [...tagIds].sort()) {
    const t = tags.get(id);
    if (!t) fail(404, 'not_found', 'tag');
    assertSellable(t, ctx.branchId, ctx.reservedTagIds?.includes(t.id) ?? false);
    assertTransition(t.status, 'sold', 'sale');
    await writeTag(t.id, { status: 'sold' });
    await ledgerRow({ branch_id: t.branch_id, tag_id: t.id, item_id: t.item_id, purity_id: t.purity_id, movement: 'sale', direction: -1,
      pieces: t.pieces, gross_wt: t.gross_wt, net_wt: t.net_wt, counter_id: t.counter_id, box_id: t.box_id }, ctx);
  }
}
/** Location lock for loose stock (two bills selling from the same balance serialise here). */
async function lockLoose(branchId: string, r: LooseSaleRow): Promise<void> {
  await one(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`loose:${branchId}:${r.item_id}:${r.purity_id}:${r.counter_id ?? '-'}:${r.box_id ?? '-'}`]);
}
/** Stock.sellLoose (S23): 409 insufficient_loose_stock unless the exact location holds it; ledger 'sale' (-1). */
export async function sellLoose(rows: LooseSaleRow[], ctx: SaleStockCtx): Promise<void> {
  const keyed = [...rows].sort((a, b) => `${a.item_id}${a.purity_id}${a.counter_id}${a.box_id}`.localeCompare(`${b.item_id}${b.purity_id}${b.counter_id}${b.box_id}`));
  for (const r of keyed) await lockLoose(ctx.branchId, r);
  // sum per location first (two lines from the same balance)
  const need = new Map<string, { r: LooseSaleRow; pieces: bigint; gross: bigint; net: bigint }>();
  for (const r of rows) {
    const k = `${r.item_id}|${r.purity_id}|${r.counter_id}|${r.box_id}`;
    const n = need.get(k) ?? { r, pieces: 0n, gross: 0n, net: 0n };
    n.pieces += BigInt(r.pieces); n.gross += mg(r.gross_wt); n.net += mg(r.net_wt);
    need.set(k, n);
  }
  for (const n of need.values()) {
    const b = await looseBalance(ctx.branchId, n.r.item_id, n.r.purity_id, n.r.counter_id, n.r.box_id);
    if (b.pieces < n.pieces || b.gross < n.gross || b.net < n.net) fail(409, 'insufficient_loose_stock', 'not enough loose stock at that location');
  }
  for (const r of rows)
    await ledgerRow({ branch_id: ctx.branchId, tag_id: null, item_id: r.item_id, purity_id: r.purity_id, movement: 'sale', direction: -1,
      pieces: r.pieces, gross_wt: r.gross_wt, net_wt: r.net_wt, counter_id: r.counter_id, box_id: r.box_id }, ctx);
}
/** Stock.oldMetalIn (S6): old gold received on a bill, ledger 'old_metal_in' (+1, item_id NULL, branch level). Returns ledger ids in order. */
export async function oldMetalIn(rows: { purity_id: string; gross_wt: string; net_wt: string }[], ctx: SaleStockCtx): Promise<string[]> {
  const ids: string[] = [];
  for (const r of rows)
    ids.push(await ledgerRow({ branch_id: ctx.branchId, tag_id: null, item_id: null, purity_id: r.purity_id, movement: 'old_metal_in', direction: 1,
      pieces: 0, gross_wt: r.gross_wt, net_wt: r.net_wt, counter_id: null, box_id: null }, ctx));
  return ids;
}
/**
 * Stock.returnToStock (S15 / S16): tags sold → in_stock at the given counter / tray (ledger +1), loose quantities +1 there.
 * movement 'sales_return' for returns, 'cancel_reversal' for cancellations.
 */
export async function returnToStock(rows: RestockRow[], ctx: SaleStockCtx & { movement: 'sales_return' | 'cancel_reversal' }): Promise<void> {
  const tags = await tagsForSale(rows.filter((r) => r.tag_id).map((r) => r.tag_id!), true);
  for (const r of rows) {
    if (r.tag_id) {
      const t = tags.get(r.tag_id);
      if (!t) fail(404, 'not_found', 'tag');
      assertTransition(t.status, 'in_stock', 'sales_return');
      await writeTag(t.id, { status: 'in_stock', branch_id: ctx.branchId });
      // location columns are app_rw-updatable (moves.ts pattern)
      await one(`UPDATE inventory.tag SET counter_id = $2, box_id = $3 WHERE id = $1`, [t.id, r.counter_id, r.box_id]);
      await ledgerRow({ branch_id: ctx.branchId, tag_id: t.id, item_id: t.item_id, purity_id: t.purity_id, movement: ctx.movement, direction: 1,
        pieces: t.pieces, gross_wt: t.gross_wt, net_wt: t.net_wt, counter_id: r.counter_id, box_id: r.box_id }, ctx);
    } else {
      await ledgerRow({ branch_id: ctx.branchId, tag_id: null, item_id: r.item_id, purity_id: r.purity_id, movement: ctx.movement, direction: 1,
        pieces: r.pieces, gross_wt: r.gross_wt, net_wt: r.net_wt, counter_id: r.counter_id, box_id: r.box_id }, ctx);
    }
  }
}
