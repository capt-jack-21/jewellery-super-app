import { one, many, audit, todayIST } from './db';
import { fail, invalid } from './errors';
import { type SalesActor, need, needBranch } from './actor';
import { nextCounterNo } from './numbering';
import { d, m2, w3, r3 } from './num';

/**
 * Order / repair advances (O2). Sales owns sales.advance: Orders asks for an advance through a port and never writes the table.
 * Money advance: balance = amount. Metal advance: weight (gross grams of the purity) and a FINE-gram balance = weight x fineness / 1000
 * (rounded to the milligram); the money balance stays 0. The balances change afterwards only through Sales functions run as sales_writer
 * (guard triggers). The receipt number is a non-gapless counter ('advance_receipt'), format below until a shop setting exists.
 * Permission: orders.advance.take (the caller is the Orders module; there is no Sales HTTP route for this).
 */
export const ADVANCE_NO_FORMAT = 'ADV-{BRANCH}-{FY}-{SEQ:5}';
const MONEY = /^\d{1,10}(\.\d{1,2})?$/;
const WT = /^\d{1,7}(\.\d{1,3})?$/;
const RATE = /^\d{1,9}(\.\d{1,2})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface AdvanceInput {
  branch_id: string; customer_id: string; order_id?: string | null; repair_id?: string | null; kind: 'amount' | 'metal';
  amount?: string; purity_id?: string; weight?: string; locked_rate_per_g?: string | null; purpose?: string | null; received_on?: string;
}
export interface AdvanceView {
  id: string; receipt_no: string; branch_id: string; customer_id: string; order_id: string | null; repair_id: string | null; kind: 'amount' | 'metal'; received_on: string;
  amount: string; purity_id: string | null; weight: string | null; locked_rate_per_g: string | null; balance: string; balance_fine_g: string;
  status: string; purpose: string | null;
}
const COLS = `a.id, a.receipt_no, a.branch_id, a.customer_id, a.order_id, a.repair_id, a.kind, a.received_on::text, a.amount::text, a.purity_id, a.weight::text,
  a.locked_rate_per_g::text, a.balance::text, a.balance_fine_g::text, a.status, a.purpose`;
type Row = Omit<AdvanceView, 'amount' | 'weight' | 'locked_rate_per_g' | 'balance' | 'balance_fine_g'> & {
  amount: string; weight: string | null; locked_rate_per_g: string | null; balance: string; balance_fine_g: string };
const shape = (r: Row): AdvanceView => ({ ...r, amount: m2(r.amount), weight: r.weight === null ? null : w3(r.weight),
  locked_rate_per_g: r.locked_rate_per_g === null ? null : m2(r.locked_rate_per_g), balance: m2(r.balance), balance_fine_g: w3(r.balance_fine_g) });

export async function advanceView(id: string): Promise<AdvanceView> {
  const r = await one<Row>(`SELECT ${COLS} FROM sales.advance a WHERE a.id = $1`, [id]);
  if (!r) fail(404, 'not_found', 'advance');
  return shape(r);
}
/** Advances of one repair, oldest first. */
export async function listRepairAdvances(repairId: string): Promise<AdvanceView[]> {
  return (await many<Row>(`SELECT ${COLS} FROM sales.advance a WHERE a.repair_id = $1 ORDER BY a.receipt_no, a.id`, [repairId])).map(shape);
}
/** Advances of one order, oldest first. */
export async function listAdvances(orderId: string): Promise<AdvanceView[]> {
  return (await many<Row>(`SELECT ${COLS} FROM sales.advance a WHERE a.order_id = $1 ORDER BY a.receipt_no, a.id`, [orderId])).map(shape);
}

export async function takeAdvance(a: SalesActor, i: AdvanceInput): Promise<AdvanceView> {
  need(a, 'orders.advance.take');
  needBranch(a, i.branch_id);
  if (i.kind !== 'amount' && i.kind !== 'metal') invalid('kind', "'amount' or 'metal'");
  if (i.received_on !== undefined && !DATE.test(i.received_on)) invalid('received_on', 'YYYY-MM-DD');
  if (i.locked_rate_per_g != null && (!RATE.test(i.locked_rate_per_g) || d(i.locked_rate_per_g).lte(0))) invalid('locked_rate_per_g', 'positive amount, up to 2 decimals');
  let amount = '0.00'; let weight: string | null = null; let fine = '0.000'; let purity: string | null = null;
  if (i.kind === 'amount') {
    if (typeof i.amount !== 'string' || !MONEY.test(i.amount) || d(i.amount).lte(0)) invalid('amount', 'positive amount, up to 2 decimals');
    if (i.purity_id || i.weight) invalid('weight', 'a money advance carries no weight or purity');
    amount = m2(i.amount!);
  } else {
    if (typeof i.weight !== 'string' || !WT.test(i.weight) || d(i.weight).lte(0)) invalid('weight', 'positive weight in grams, up to 3 decimals');
    if (!i.purity_id) invalid('purity_id', 'required for a metal advance');
    if (i.amount !== undefined && d(i.amount).gt(0)) invalid('amount', 'a metal advance carries no money amount');
    const p = await one<{ fineness: string; is_active: boolean }>(`SELECT fineness::text, is_active FROM masters.purity WHERE id = $1`, [i.purity_id]);
    if (!p) invalid('purity_id', 'unknown purity', 'not_found');
    if (!p!.is_active) invalid('purity_id', 'purity is inactive');
    const f = d(p!.fineness);
    fine = w3(r3(d(i.weight).times(f.gt(100) ? f.dividedBy(1000) : f.dividedBy(100))));   // 916 -> 0.916, 91.6 -> 0.916
    weight = w3(i.weight!); purity = i.purity_id!;
    if (d(fine).lte(0)) invalid('weight', 'too small: the fine weight rounds to zero');
  }
  const shop = await one<{ id: string }>(`SELECT id FROM masters.customer WHERE id = $1`, [i.customer_id]);
  if (!shop) invalid('customer_id', 'unknown customer', 'not_found');
  const { no } = await nextCounterNo(i.branch_id, 'advance_receipt', ADVANCE_NO_FORMAT);
  const row = await one<{ id: string }>(`INSERT INTO sales.advance(tenant_id, branch_id, receipt_no, received_on, customer_id, purpose, kind, amount, purity_id, weight,
      locked_rate_per_g, balance, balance_fine_g, order_id, repair_id)
    VALUES (platform.current_tenant(), $1, $2, coalesce($3::date, $4::date), $5, $6, $7, $8, $9, $10, $11, $8, $12, $13, $14) RETURNING id`,
    [i.branch_id, no, i.received_on ?? null, await todayIST(), i.customer_id, i.purpose ?? null, i.kind, amount, purity, weight,
      i.locked_rate_per_g == null ? null : m2(i.locked_rate_per_g), fine, i.order_id ?? null, i.repair_id ?? null]);
  const v = await advanceView(row!.id);
  await audit('sales.advance.take', 'sales.advance', v.id, { receipt_no: v.receipt_no, kind: v.kind, amount: v.amount, weight: v.weight, balance_fine_g: v.balance_fine_g, order_id: v.order_id, repair_id: v.repair_id });
  return v;
}
