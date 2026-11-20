import { withModuleRole } from '@jw/db';
import { type OrdersActor, need, needBranch } from './actor';
import { checkVersion, fail, invalid } from './errors';
import { audit, one } from './db';
import { getOrder, loadForFlow, type Order } from './orders';
import { salesPort, stockPort } from './ports';
import { loadSettings } from './settings';

/**
 * Order status flow (O3 / O4). Status is derived by the module, never set by the client:
 *   open --assign a line--> in_production --(all live lines received: O5)--> ready --(billed: O6)--> delivered
 *   unassigning the last assigned line returns the order to open; cancel is allowed from open / in_production while no piece is received.
 * Written only as orders_writer; the order row is locked before the checks are repeated, so two people cannot assign the same line.
 */
const VENDOR_KINDS = ['smith', 'supplier', 'designer'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export interface AssignInput { vendor_id: string; vendor_due: string; vendor_note?: string | null }
export interface CancelInput { reason: string }
export interface ReceiveInput {
  gross_wt: string; stone_wt?: string; net_wt?: string; huid?: string | null; size?: string | null; counter_id?: string | null; tray_id?: string | null; received_on?: string;
}
const W3 = /^\d{1,7}(\.\d{1,3})?$/;

async function vendorOk(id: string): Promise<boolean> {
  return !!(await one(`SELECT 1 AS x FROM masters.vendor WHERE id = $1 AND is_active AND kinds && $2::text[]`, [id, VENDOR_KINDS]));
}
function liveOrder(o: Order): void {
  if (!['open', 'in_production'].includes(o.status)) fail(409, 'order_not_open', `order is ${o.status}; vendor work can only change while it is open or in production`);
}

/** Shop setting advance_required: a customer order needs a live advance before it goes to a vendor (a shop order has no customer, so no advance). */
async function advanceRule(o: Order): Promise<void> {
  if (o.order_type !== 'customer' || !(await loadSettings()).advance_required) return;
  const taken = (await salesPort().listAdvances(o.id)).some((x) => !['cancelled', 'refunded'].includes(x.status));
  if (!taken) fail(409, 'advance_required', 'this shop needs an advance before the order goes to a vendor; take an advance first');
}

export async function assignLine(a: OrdersActor, orderId: string, lineId: string, p: AssignInput, ifVersion?: number): Promise<Order> {
  need(a, 'orders.order.assign');
  const cur = await loadForFlow(a, orderId, false);
  needBranch(a, cur.branch_id);
  if (!cur.lines.some((l) => l.id === lineId)) fail(404, 'not_found', 'order line');
  if (typeof p.vendor_due !== 'string' || !DATE.test(p.vendor_due)) invalid('vendor_due', 'YYYY-MM-DD');
  if (p.vendor_due < cur.order_date) invalid('vendor_due', 'must not be before the order date');
  if (p.vendor_note != null && p.vendor_note.length > 500) invalid('vendor_note', 'at most 500 characters');
  if (!(await vendorOk(p.vendor_id))) fail(422, 'unknown_reference', 'vendor_id', [{ path: 'vendor_id', code: 'unknown_reference', message: 'no active vendor (smith, supplier or designer) with this id' }]);
  const check = (o: Order): void => {
    checkVersion('order', o.version, ifVersion);
    liveOrder(o);
    const l = o.lines.find((x) => x.id === lineId);
    if (!l || l.status !== 'pending') fail(409, 'line_not_pending', `line is ${l?.status ?? 'missing'}; only a pending line can be assigned`);
  };
  check(cur);
  await advanceRule(cur);   // Sales is asked as the session role, so before the orders_writer block
  await withModuleRole('orders_writer', async (c) => {
    check(await loadForFlow(a, orderId, true));
    await c.query(`UPDATE orders.order_line SET status = 'assigned', vendor_id = $2, vendor_due = $3::date, vendor_note = $4, assigned_at = now() WHERE id = $1`,
      [lineId, p.vendor_id, p.vendor_due, p.vendor_note ?? null]);
    await c.query(`UPDATE orders.customer_order SET status = 'in_production' WHERE id = $1`, [orderId]);
  });
  await audit('orders.order.assign', 'orders.customer_order', orderId, { line_id: lineId, vendor_id: p.vendor_id, vendor_due: p.vendor_due });
  return getOrder(a, orderId);
}

export async function unassignLine(a: OrdersActor, orderId: string, lineId: string, ifVersion?: number): Promise<Order> {
  need(a, 'orders.order.assign');
  const cur = await loadForFlow(a, orderId, false);
  needBranch(a, cur.branch_id);
  if (!cur.lines.some((l) => l.id === lineId)) fail(404, 'not_found', 'order line');
  const check = (o: Order): void => {
    checkVersion('order', o.version, ifVersion);
    liveOrder(o);
    const l = o.lines.find((x) => x.id === lineId);
    if (!l || l.status !== 'assigned') fail(409, 'line_not_assigned', `line is ${l?.status ?? 'missing'}; only an assigned line can be taken back from the vendor`);
  };
  check(cur);
  await withModuleRole('orders_writer', async (c) => {
    const o = await loadForFlow(a, orderId, true);
    check(o);
    await c.query(`UPDATE orders.order_line SET status = 'pending', vendor_id = NULL, vendor_due = NULL, vendor_note = NULL, assigned_at = NULL WHERE id = $1`, [lineId]);
    const stillOut = o.lines.some((l) => l.id !== lineId && ['assigned', 'received'].includes(l.status));
    await c.query(`UPDATE orders.customer_order SET status = $2 WHERE id = $1`, [orderId, stillOut ? 'in_production' : 'open']);
  });
  await audit('orders.order.unassign', 'orders.customer_order', orderId, { line_id: lineId });
  return getOrder(a, orderId);
}

export async function cancelOrder(a: OrdersActor, orderId: string, p: CancelInput, ifVersion?: number): Promise<Order> {
  need(a, 'orders.order.cancel');
  const cur = await loadForFlow(a, orderId, false);
  needBranch(a, cur.branch_id);
  const reason = typeof p.reason === 'string' ? p.reason.trim() : '';
  if (reason.length < 3 || reason.length > 500) invalid('reason', '3 to 500 characters');
  const check = async (o: Order): Promise<void> => {
    checkVersion('order', o.version, ifVersion);
    if (!['open', 'in_production'].includes(o.status)) fail(409, 'order_not_cancellable', `order is ${o.status}; only an open or in-production order can be cancelled`);
    if (o.lines.some((l) => ['received', 'delivered'].includes(l.status))) fail(409, 'order_has_received_piece', 'a finished piece is already received for this order');
    // until O2 an advance can exist only through the Sales module; refusing keeps a customer's money from being orphaned
    if (await one(`SELECT 1 AS x FROM sales.advance WHERE order_id = $1 AND status IN ('open','partly_redeemed')`, [orderId]))
      fail(409, 'advance_outstanding', 'refund or redeem the advance taken for this order first');
  };
  await check(cur);
  await withModuleRole('orders_writer', async (c) => {
    await check(await loadForFlow(a, orderId, true));
    await c.query(`UPDATE orders.order_line SET status = 'cancelled' WHERE order_id = $1 AND status <> 'cancelled'`, [orderId]);
    await c.query(`UPDATE orders.customer_order SET status = 'cancelled', cancel_reason = $2, cancelled_at = now(), cancelled_by = $3 WHERE id = $1`, [orderId, reason, a.userId]);
  });
  await audit('orders.order.cancel', 'orders.customer_order', orderId, { reason });
  return getOrder(a, orderId);
}

/**
 * O5: the vendor brings the finished piece back. Inventory makes the lot (order_receipt), tags the piece and reserves it for the order;
 * the line becomes received and points at the tag. When every live line is received the order becomes ready.
 * All in one transaction: if Inventory refuses (HUID, weights, counter), nothing changes here either.
 */
export async function receiveLine(a: OrdersActor, orderId: string, lineId: string, p: ReceiveInput, ifVersion?: number): Promise<Order> {
  need(a, 'orders.order.receive');
  const cur = await loadForFlow(a, orderId, false);
  needBranch(a, cur.branch_id);
  if (!cur.lines.some((l) => l.id === lineId)) fail(404, 'not_found', 'order line');
  for (const f of ['gross_wt', 'stone_wt', 'net_wt'] as const) if (p[f] !== undefined && !W3.test(String(p[f]))) invalid(f, 'decimal string, up to 3 decimals');
  if (typeof p.gross_wt !== 'string') invalid('gross_wt', 'required');
  if (p.received_on !== undefined && !DATE.test(p.received_on)) invalid('received_on', 'YYYY-MM-DD');
  const check = (o: Order): void => {
    checkVersion('order', o.version, ifVersion);
    if (o.status !== 'in_production') fail(409, 'order_not_in_production', `order is ${o.status}; a piece can be received only while it is in production`);
    const l = o.lines.find((x) => x.id === lineId);
    if (!l || l.status !== 'assigned') fail(409, 'line_not_assigned', `line is ${l?.status ?? 'missing'}; only a line given to a vendor can be received`);
  };
  check(cur);
  const line = cur.lines.find((l) => l.id === lineId)!;
  // 1. lock the order row (orders_writer; the lock lasts to the end of the transaction) and repeat the checks on the locked row
  const o = await withModuleRole('orders_writer', async () => { const x = await loadForFlow(a, orderId, true); check(x); return x; });
    // 2. stock, as the session role (Inventory switches its own role; the orders role must not be active here)
  const piece = await stockPort().receivePiece(a, { branch_id: o.branch_id, order_id: o.id, order_no: o.order_no, vendor_id: line.vendor_id!, item_id: line.item_id,
    purity_id: line.purity_id, pieces: line.pieces, gross_wt: p.gross_wt, stone_wt: p.stone_wt, net_wt: p.net_wt, huid: p.huid ?? null, size: p.size ?? line.size,
    counter_id: p.counter_id ?? null, box_id: p.tray_id ?? null, received_on: p.received_on });
  // 3. the line and the order
  await withModuleRole('orders_writer', async (c) => {
    await c.query(`UPDATE orders.order_line SET status = 'received', received_tag_id = $2 WHERE id = $1`, [lineId, piece.tag_id]);
    const allIn = o.lines.every((l) => l.id === lineId || ['received', 'delivered', 'cancelled'].includes(l.status));
    await c.query(`UPDATE orders.customer_order SET status = $2 WHERE id = $1`, [orderId, allIn ? 'ready' : 'in_production']);
  });
  await audit('orders.order.receive', 'orders.customer_order', orderId, { line_id: lineId });
  return getOrder(a, orderId);
}
