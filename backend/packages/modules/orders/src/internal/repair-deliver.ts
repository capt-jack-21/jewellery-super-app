import { withModuleRole } from '@jw/db';
import { type OrdersActor, need, needBranch } from './actor';
import { checkVersion, fail, invalid } from './errors';
import { audit, one } from './db';
import { getRepair, loadRepairForFlow, loadRepairLocked, type Repair } from './repairs';
import { salesPort } from './ports';

/**
 * O9: deliver the repair and bill it through Sales as a SERVICE bill (repair type SAC, GST by the service rule). The repair must be ready
 * (every live line back). One service line per live repair line; the charge is the line's customer charge, or the `charges` sent here
 * (inside the repair type's customer limits; a line with neither cannot be billed). The repair's money advances are applied as payment; the
 * rest is paid by `payments` or stays as a credit-sale balance. One transaction: if Sales refuses, the repair is untouched.
 */
export interface RepairDeliverIn {
  salesperson_id: string; cash_counter_id?: string | null; place_of_supply?: string | null; pan?: string | null; expected_total?: string | null;
  payments?: unknown[]; apply_advances?: boolean; charges?: { line_id: string; amount: string }[];
}
export interface RepairDeliverResult { repair: Repair; invoice_id: string; invoice_no: string; advances_applied: { advance_id: string; amount: string }[] }
const BILL_KEYS = ['salesperson_id', 'cash_counter_id', 'place_of_supply', 'pan', 'expected_total', 'payments'] as const;
const MONEY = /^\d{1,10}(\.\d{1,2})?$/;
const cents = (s: string): bigint => { const [i, f = ''] = s.split('.'); return BigInt(i) * 100n + BigInt((f + '00').slice(0, 2)); };

function ready(r: Repair): void {
  if (r.status !== 'ready') fail(409, 'repair_not_ready', `repair is ${r.status}; only a ready repair (every piece back from the vendor) can be delivered`);
}
export async function deliverRepair(a: OrdersActor, repairId: string, p: RepairDeliverIn, ifVersion?: number): Promise<RepairDeliverResult> {
  need(a, 'orders.repair.deliver');
  const cur = await loadRepairForFlow(a, repairId);
  needBranch(a, cur.branch_id);
  if (typeof p.salesperson_id !== 'string') invalid('salesperson_id', 'required');
  checkVersion('repair', cur.version, ifVersion);
  ready(cur);
  const r = await withModuleRole('orders_writer', async () => { const x = await loadRepairLocked(a, repairId); checkVersion('repair', x.version, ifVersion); ready(x); return x; });
  const live = r.lines.filter((l) => l.status === 'active');
  if (!live.length) fail(409, 'repair_has_nothing_to_deliver', 'no live piece on this repair');
  const sent = new Map<string, string>();
  for (const [k, c] of (p.charges ?? []).entries()) {
    if (!live.some((l) => l.id === c.line_id)) invalid(`charges.${k}.line_id`, 'not a live line of this repair');
    if (sent.has(c.line_id)) invalid(`charges.${k}.line_id`, 'the same line twice');
    if (typeof c.amount !== 'string' || !MONEY.test(c.amount)) invalid(`charges.${k}.amount`, 'amount, up to 2 decimals');
    sent.set(c.line_id, c.amount);
  }
  const lines: { description: string; sac: string | null; amount: string }[] = [];
  const changed: { id: string; amount: string }[] = [];
  for (const [k, l] of live.entries()) {
    const amount = sent.get(l.id) ?? l.customer_charge;
    if (amount === null || amount === undefined) fail(422, 'validation_failed', `no charge for ${l.repair_type_name}: send it in charges`, [{ path: `charges.${k}`, code: 'charge_required', message: 'the line has no charge yet' }]);
    if (cents(amount) <= 0n) invalid(`charges.${k}.amount`, 'must be above 0', 'charge_required');
    const t = await one<{ sac: string | null; min: string | null; max: string | null }>(`SELECT sac, min_customer_charge::text AS min, max_customer_charge::text AS max FROM masters.repair_type WHERE id = $1`, [l.repair_type_id]);
    if (t && ((t.min !== null && cents(amount) < cents(t.min)) || (t.max !== null && cents(amount) > cents(t.max))))
      fail(422, 'validation_failed', `charge is outside the repair type limits (${t.min ?? 'no minimum'} to ${t.max ?? 'no maximum'})`,
        [{ path: `charges.${k}.amount`, code: 'charge_out_of_range', message: `must be between ${t.min ?? '0'} and ${t.max ?? 'any amount'}` }]);
    lines.push({ description: l.description ? `${l.repair_type_name} - ${l.description}` : l.repair_type_name, sac: t?.sac ?? null, amount });
    if (l.customer_charge === null || cents(l.customer_charge) !== cents(amount)) changed.push({ id: l.id, amount });
  }
  const sp = salesPort();
  const advance_ids = p.apply_advances === false ? [] : (await sp.listRepairAdvances(repairId)).filter((x) => x.kind === 'amount' && ['open', 'partly_redeemed'].includes(x.status)).map((x) => x.id);
  const bill = Object.fromEntries(BILL_KEYS.filter((k) => p[k] !== undefined).map((k) => [k, p[k]]));
  // Sales, as the session role
  const inv = await sp.issueRepairInvoice(a, { repair_id: r.id, branch_id: r.branch_id, customer_id: r.customer_id, advance_ids, bill, lines });
  await withModuleRole('orders_writer', async (c) => {
    for (const x of changed) await c.query(`UPDATE orders.repair_line SET customer_charge = $2 WHERE id = $1`, [x.id, x.amount]);
    await c.query(`UPDATE orders.repair SET status = 'delivered', delivered_invoice_id = $2 WHERE id = $1`, [repairId, inv.id]);
  });
  await audit('orders.repair.deliver', 'orders.repair', repairId, { invoice_id: inv.id, doc_no: inv.doc_no, advances: inv.advances, charges_changed: changed.length });
  return { repair: await getRepair(a, repairId), invoice_id: inv.id, invoice_no: inv.doc_no, advances_applied: inv.advances };
}
