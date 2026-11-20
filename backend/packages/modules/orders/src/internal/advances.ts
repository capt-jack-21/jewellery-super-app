import { withModuleRole } from '@jw/db';
import { type OrdersActor, need, needBranch } from './actor';
import { fail, invalid } from './errors';
import { audit } from './db';
import { loadForFlow, type Order } from './orders';
import { salesPort, type AdvanceRow } from './ports';

/**
 * O2: an advance against an order, in money or in metal (fine-gram balance). Sales owns the advance table and the receipt number; Orders
 * checks the order, locks its row, asks Sales through the port (as the session role, never inside the orders role) and, when the advance
 * carries a rate, keeps ONE locked rate per gram on the order (no expiry or cap in v1). One transaction: a Sales refusal changes nothing here.
 */
export interface AdvanceIn {
  kind: 'amount' | 'metal'; amount?: string; purity_id?: string; weight?: string; lock_rate_per_g?: string | null; purpose?: string | null; received_on?: string;
}
const RATE = /^\d{1,9}(\.\d{1,2})?$/;

function openForAdvance(o: Order): void {
  if (!['open', 'in_production', 'ready'].includes(o.status)) fail(409, 'order_not_open', `order is ${o.status}; an advance can be taken only while the order is open, in production or ready`);
  if (!o.customer_id) fail(409, 'order_needs_customer', 'add the customer to the order before taking an advance');
}
function rateRule(o: Order, rate: string | null | undefined): void {
  if (rate == null) return;
  if (!RATE.test(rate) || Number(rate) <= 0) invalid('lock_rate_per_g', 'positive amount, up to 2 decimals');
  if (o.rate_locked_per_g !== null && Number(o.rate_locked_per_g) !== Number(rate))
    fail(409, 'rate_already_locked', `the order already has a locked rate of ${o.rate_locked_per_g} per gram`);
}

export async function takeAdvance(a: OrdersActor, orderId: string, p: AdvanceIn): Promise<AdvanceRow> {
  need(a, 'orders.advance.take');
  const cur = await loadForFlow(a, orderId, false);
  needBranch(a, cur.branch_id);
  if (p.kind !== 'amount' && p.kind !== 'metal') invalid('kind', "'amount' or 'metal'");
  openForAdvance(cur);
  rateRule(cur, p.lock_rate_per_g);
  // 1. lock the order row (orders role; lasts to the end of the transaction) and repeat the checks on the locked row
  const o = await withModuleRole('orders_writer', async () => { const x = await loadForFlow(a, orderId, true); openForAdvance(x); rateRule(x, p.lock_rate_per_g); return x; });
  // 2. Sales, as the session role
  const adv = await salesPort().takeAdvance(a, { branch_id: o.branch_id, customer_id: o.customer_id!, order_id: o.id, kind: p.kind, amount: p.amount,
    purity_id: p.purity_id, weight: p.weight, locked_rate_per_g: p.lock_rate_per_g ?? null, purpose: p.purpose ?? null, received_on: p.received_on });
  // 3. the order keeps the locked rate
  if (p.lock_rate_per_g != null && o.rate_locked_per_g === null)
    await withModuleRole('orders_writer', async (c) => { await c.query(`UPDATE orders.customer_order SET rate_locked_per_g = $2 WHERE id = $1`, [orderId, p.lock_rate_per_g]); });
  await audit('orders.order.advance', 'orders.customer_order', orderId, { advance_id: adv.id, receipt_no: adv.receipt_no, kind: adv.kind, rate_locked: p.lock_rate_per_g ?? null });
  return adv;
}

export async function listAdvances(a: OrdersActor, orderId: string): Promise<AdvanceRow[]> {
  need(a, 'orders.order.view');
  const o = await loadForFlow(a, orderId, false);
  needBranch(a, o.branch_id);
  return salesPort().listAdvances(orderId);
}
