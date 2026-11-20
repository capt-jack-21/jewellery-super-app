import { withModuleRole } from '@jw/db';
import { type OrdersActor, need, needBranch } from './actor';
import { checkVersion, fail, invalid } from './errors';
import { audit } from './db';
import { getOrder, loadForFlow, type Order } from './orders';
import { salesPort } from './ports';
import { loadSettings } from './settings';

/**
 * O6: deliver the order and bill it through Sales. The order must be ready (every live line received). Sales issues ONE tax invoice for the
 * received pieces (tags reserved > sold), at the order's locked rate under the shop's rate rule (locked | lower_of), with the order's money
 * advances applied as payment; whatever is still due is paid by the payments sent here (or stays as a credit-sale balance). All in one
 * transaction: if Sales refuses, the order is untouched. The bill is linked to the order (sales.invoice.order_id).
 */
export interface DeliverIn {
  salesperson_id: string; cash_counter_id?: string | null; place_of_supply?: string | null; bill_discount?: string; discount_reason?: string | null;
  pan?: string | null; expected_total?: string | null; payments?: unknown[]; apply_advances?: boolean;
}
export interface DeliverResult { order: Order; invoice_id: string; invoice_no: string; advances_applied: { advance_id: string; amount: string }[] }
const BILL_KEYS = ['salesperson_id', 'cash_counter_id', 'place_of_supply', 'bill_discount', 'discount_reason', 'pan', 'expected_total', 'payments'] as const;

function ready(o: Order): void {
  if (o.status !== 'ready') fail(409, 'order_not_ready', `order is ${o.status}; only a ready order (every piece received) can be delivered`);
  if (!o.customer_id) fail(409, 'order_needs_customer', 'a shop order has no customer to bill');
}
export async function deliverOrder(a: OrdersActor, orderId: string, p: DeliverIn, ifVersion?: number): Promise<DeliverResult> {
  need(a, 'orders.order.deliver');
  const cur = await loadForFlow(a, orderId, false);
  needBranch(a, cur.branch_id);
  if (typeof p.salesperson_id !== 'string') invalid('salesperson_id', 'required');
  checkVersion('order', cur.version, ifVersion);
  ready(cur);
  // 1. lock the order row and repeat the checks on the locked row
  const o = await withModuleRole('orders_writer', async () => { const x = await loadForFlow(a, orderId, true); checkVersion('order', x.version, ifVersion); ready(x); return x; });
  const tagIds = o.lines.filter((l) => l.status === 'received').map((l) => l.received_tag_id!);
  if (!tagIds.length) fail(409, 'order_has_nothing_to_deliver', 'no received piece on this order');
  const settings = await loadSettings();
  const sp = salesPort();
  const advance_ids = p.apply_advances === false ? [] : (await sp.listAdvances(orderId)).filter((x) => x.kind === 'amount' && ['open', 'partly_redeemed'].includes(x.status)).map((x) => x.id);
  const bill = Object.fromEntries(BILL_KEYS.filter((k) => p[k] !== undefined).map((k) => [k, p[k]]));
  // 2. Sales, as the session role (stock and the bill are written under Sales' / Inventory's own roles)
  const inv = await sp.issueOrderInvoice(a, { order_id: o.id, branch_id: o.branch_id, customer_id: o.customer_id!, tag_ids: tagIds, locked_rate_per_g: o.rate_locked_per_g,
    rate_rule: settings.rate_rule, advance_ids, bill });
  // 3. the order and its lines
  await withModuleRole('orders_writer', async (c) => {
    await c.query(`UPDATE orders.order_line SET status = 'delivered' WHERE order_id = $1 AND status = 'received'`, [orderId]);
    await c.query(`UPDATE orders.customer_order SET status = 'delivered' WHERE id = $1`, [orderId]);
  });
  await audit('orders.order.deliver', 'orders.customer_order', orderId, { invoice_id: inv.id, doc_no: inv.doc_no, rate_rule: settings.rate_rule, rate_locked: o.rate_locked_per_g, advances: inv.advances });
  return { order: await getOrder(a, orderId), invoice_id: inv.id, invoice_no: inv.doc_no, advances_applied: inv.advances };
}
