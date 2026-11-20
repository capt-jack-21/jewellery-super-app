import { type InventoryActor, need, needBranch } from './actor';
import { fail, invalid } from './errors';
import { ledger, lockTags, one, tx, gm, mg, type LedgerRow } from './db';
import { validateLocation } from './tags';
import { requireLoose } from './loose';
import { MOVABLE } from './statuses';

export interface LooseMoveLine {
  item_id: string; purity_id: string; from_counter_id: string | null; from_tray_id?: string | null; pieces?: number; gross_wt: string; net_wt: string;
}
export interface MoveInput {
  branch_id: string; to_counter_id: string | null; to_tray_id?: string | null; tag_ids?: string[]; loose?: LooseMoveLine[]; reason?: string | null;
}
/**
 * Counter / tray moves inside one branch (inventory.move: owner, manager and — lead decision 3 — salesperson by default;
 * branch-scoped roles only in their own branch). Not a branch transfer. location_move row + move_out / move_in ledger pair.
 */
export async function moveStock(a: InventoryActor, m: MoveInput): Promise<{ move_ids: string[] }> {
  need(a, 'inventory.move');
  needBranch(a, m.branch_id);
  const tagIds = m.tag_ids ?? [], loose = m.loose ?? [];
  if (!tagIds.length && !loose.length) fail(422, 'empty_move', 'nothing to move');
  if (m.reason != null && (m.reason.trim().length < 3 || m.reason.length > 300)) invalid('reason', '3-300 characters');
  const toC = m.to_counter_id ?? null, toB = m.to_tray_id ?? null;
  await validateLocation(m.branch_id, toC, toB);
  const ids: string[] = [];
  const insertMove = async (v: unknown[]) => ids.push((await one<{ id: string }>(
    `INSERT INTO inventory.location_move(tenant_id, branch_id, tag_id, item_id, purity_id, pieces, gross_wt, net_wt, from_counter_id, from_box_id,
       to_counter_id, to_box_id, reason, moved_by) VALUES (platform.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`, v))!.id);
  const rows: LedgerRow[] = [];
  const tags = tagIds.length ? await lockTags(tagIds) : new Map();
  for (const id of tagIds) {
    const t = tags.get(id)!;
    if (t.status === 'written_off') fail(409, 'tag_written_off', `${t.tag_no} is written off`);
    if (t.branch_id !== m.branch_id) fail(409, 'wrong_branch', `${t.tag_no} is not in this branch`);
    if (!MOVABLE.has(t.status)) fail(409, 'tag_not_available', `${t.tag_no} is ${t.status}`);
    if (t.counter_id === toC && t.box_id === toB) fail(422, 'same_location', `${t.tag_no} is already there`);
    await insertMove([m.branch_id, id, null, null, t.pieces, t.gross_wt, t.net_wt, t.counter_id, t.box_id, toC, toB, m.reason ?? null, a.userId]);
    await tx().query(`UPDATE inventory.tag SET counter_id = $2, box_id = $3 WHERE id = $1`, [id, toC, toB]);
    const base = { branch_id: m.branch_id, tag_id: id, item_id: t.item_id, purity_id: t.purity_id, pieces: t.pieces, gross_wt: t.gross_wt, net_wt: t.net_wt,
      source_type: 'location_move', source_id: ids[ids.length - 1], user_id: a.userId };
    rows.push({ ...base, movement: 'move_out', direction: -1, counter_id: t.counter_id, box_id: t.box_id },
              { ...base, movement: 'move_in', direction: 1, counter_id: toC, box_id: toB });
  }
  for (const [k, l] of loose.entries()) {
    const fromC = l.from_counter_id ?? null, fromB = l.from_tray_id ?? null;
    if (fromC === toC && fromB === toB) invalid(`loose[${k}]`, 'already there', 'same_location');
    await validateLocation(m.branch_id, fromC, fromB);
    const g = mg(l.gross_wt), n = mg(l.net_wt), p = l.pieces ?? 0;
    if (g <= 0n || n < 0n || n > g || p < 0) invalid(`loose[${k}].gross_wt`, '0 < gross, 0 ≤ net ≤ gross');
    await requireLoose(m.branch_id, l.item_id, l.purity_id, fromC, fromB, p, g, n);
    await insertMove([m.branch_id, null, l.item_id, l.purity_id, p, gm(g), gm(n), fromC, fromB, toC, toB, m.reason ?? null, a.userId]);
    const base = { branch_id: m.branch_id, item_id: l.item_id, purity_id: l.purity_id, pieces: p, gross_wt: gm(g), net_wt: gm(n),
      source_type: 'location_move', source_id: ids[ids.length - 1], user_id: a.userId };
    rows.push({ ...base, movement: 'move_out', direction: -1, counter_id: fromC, box_id: fromB },
              { ...base, movement: 'move_in', direction: 1, counter_id: toC, box_id: toB });
  }
  await ledger(rows);
  return { move_ids: ids };
}

/** Loose (non-tag) stock receipt into a location: non_tag_in ledger row. */
export async function receiveLoose(a: InventoryActor, r: { branch_id: string; counter_id?: string | null; tray_id?: string | null; item_id: string;
  purity_id: string; gross_wt: string; net_wt: string; pieces?: number; lot_line_id?: string | null }): Promise<LooseBalance> {
  need(a, 'inventory.tag.create');
  needBranch(a, r.branch_id);
  await validateLocation(r.branch_id, r.counter_id, r.tray_id);
  const it = await one<{ stock_type: string }>(`SELECT stock_type FROM masters.item WHERE id = $1`, [r.item_id]) ?? fail(422, 'unknown_reference', 'item_id');
  if (it.stock_type === 'tag') invalid('item_id', 'tagged items are tagged, not received loose', 'tag_item');
  const g = mg(r.gross_wt), n = mg(r.net_wt);
  if (g <= 0n || n < 0n || n > g) invalid('gross_wt', '0 < gross, 0 ≤ net ≤ gross');
  await ledger([{ branch_id: r.branch_id, item_id: r.item_id, purity_id: r.purity_id, movement: 'non_tag_in', direction: 1, pieces: r.pieces ?? 0,
    gross_wt: gm(g), net_wt: gm(n), source_type: r.lot_line_id ? 'lot_line' : 'loose_receipt', source_id: r.lot_line_id ?? r.item_id, user_id: a.userId,
    counter_id: r.counter_id ?? null, box_id: r.tray_id ?? null }]);
  // 0.8.8: the resulting balance at that key (contract 201 LooseStock), read back from v_loose_stock in this transaction
  return (await one<LooseBalance>(`SELECT branch_id, counter_id, box_id AS tray_id, item_id, purity_id, pieces::int, gross_wt::text, net_wt::text, fine_wt::text
      FROM inventory.v_loose_stock WHERE branch_id = $1 AND counter_id IS NOT DISTINCT FROM $2::uuid AND box_id IS NOT DISTINCT FROM $3::uuid
       AND item_id = $4 AND purity_id = $5`, [r.branch_id, r.counter_id ?? null, r.tray_id ?? null, r.item_id, r.purity_id]))!;
}
/** One row of inventory.v_loose_stock (contract LooseStock, without labels). */
export interface LooseBalance { branch_id: string; counter_id: string | null; tray_id: string | null; item_id: string; purity_id: string; pieces: number;
  gross_wt: string; net_wt: string; fine_wt: string | null }
