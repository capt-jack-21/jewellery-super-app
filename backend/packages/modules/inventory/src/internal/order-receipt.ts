import { type InventoryActor } from './actor';
import { gm, mg } from './db';
import { createLot } from './lots';
import { createTags, transitionTag, type TagView, getTag } from './tags';

/**
 * Orders O5: a finished piece comes back from the vendor. One call, in the caller's transaction:
 *   1. a lot of entry type order_receipt (vendor, order number as the reference, ref_id = the order),
 *   2. the piece is tagged from that lot (the shop's tag number format, HUID rules, ledger row 'tagged'),
 *   3. the new tag is reserved for the order (in_stock → reserved).
 * Orders checks its own permission (orders.order.receive) and the order state before calling; receiving a piece implies tagging it,
 * so the Inventory permission for tagging is added here (the caller still needs access to the branch).
 */
export interface OrderReceiptInput {
  branch_id: string; order_id: string; order_no: string; vendor_id: string; item_id: string; purity_id: string; pieces: number;
  gross_wt: string; stone_wt?: string; net_wt?: string; huid?: string | null; size?: string | null; counter_id?: string | null; box_id?: string | null;
  received_on?: string;
}
export interface OrderReceiptResult { lot_id: string; lot_no: string; tag_id: string; tag_no: string; tag: TagView }
export async function receiveOrderPiece(a: InventoryActor, i: OrderReceiptInput): Promise<OrderReceiptResult> {
  const ia: InventoryActor = { ...a, permissions: new Set([...a.permissions, 'inventory.tag.create', 'inventory.stock.view']) };
  // net weight defaults to gross - stone (as for any tag); the lot line carries the same figure
  const net = i.net_wt ?? gm(mg(i.gross_wt) - mg(i.stone_wt ?? '0'));
  const lot = await createLot(ia, { branch_id: i.branch_id, vendor_id: i.vendor_id, entry_type: 'order_receipt', ref_invoice_no: i.order_no, ref_id: i.order_id,
    received_on: i.received_on, lines: [{ item_id: i.item_id, purity_id: i.purity_id, pieces: i.pieces, gross_wt: i.gross_wt, stone_wt: i.stone_wt,
      net_wt: net }] });
  const [created] = await createTags(ia, i.branch_id, [{ item_id: i.item_id, purity_id: i.purity_id, pieces: i.pieces, gross_wt: i.gross_wt, stone_wt: i.stone_wt,
    net_wt: net, huid: i.huid ?? null, size: i.size ?? null, counter_id: i.counter_id ?? null, box_id: i.box_id ?? null,
    received_on: i.received_on ?? null, lot_line_id: lot.lines[0].id }]);
  await transitionTag(created.id, 'reserved', 'order_reserve');
  return { lot_id: lot.id, lot_no: lot.lot_no, tag_id: created.id, tag_no: created.tag_no, tag: await getTag(ia, created.id) };
}
/** Orders: a piece that was reserved for an order goes back to free stock (cancel / release). Same transaction as the caller. */
export async function releaseOrderPiece(tagId: string): Promise<void> {
  await transitionTag(tagId, 'in_stock', 'order_release');
}
