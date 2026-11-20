import { withModuleRole } from '@jw/db';
import { type OrdersActor, need, needBranch } from './actor';
import { checkVersion, fail, invalid } from './errors';
import { audit, many, mg, one } from './db';
import { loadRepairForFlow, loadRepairLocked, getRepair, lossOf, type Repair, type RepairLine } from './repairs';
import { loadSettings } from './settings';

/**
 * Repair vendor flow (O8). A repair line goes to a vendor (issue), may be taken back before the vendor returns it (unissue), and is
 * received back with its weight checked against the shop tolerance. The repair status is derived from its lines, never set by the client:
 *   received -> issued_to_vendor (a line is out) -> received_from_vendor (lines are back, none out, not all done) -> ready (every live line back).
 * Written only as orders_writer; the repair row is locked and the checks repeated before any change. No Sales / Inventory call is made here.
 */
const VENDOR_KINDS = ['repair_vendor', 'smith'];
const MONEY = /^\d{1,10}(\.\d{1,2})?$/;
const W3 = /^\d{1,7}(\.\d{1,3})?$/;
const cents = (s: string): bigint => { const [i, f = ''] = s.split('.'); return BigInt(i) * 100n + BigInt((f + '00').slice(0, 2)); };
export interface IssueInput { vendor_id: string; vendor_charge?: string | null; vendor_note?: string | null }
export interface ReceiveBackInput { received_wt: string; vendor_charge?: string | null; loss_override_reason?: string | null }

const vendorOk = async (id: string): Promise<boolean> => !!(await one(`SELECT 1 AS x FROM masters.vendor WHERE id = $1 AND is_active AND kinds && $2::text[]`, [id, VENDOR_KINDS]));
function inFlow(r: Repair): void {
  if (!['received', 'issued_to_vendor', 'received_from_vendor'].includes(r.status)) fail(409, 'repair_not_open', `repair is ${r.status}; vendor work can only change before it is ready`);
}
const lineOf = (r: Repair, lineId: string): RepairLine => {
  const l = r.lines.find((x) => x.id === lineId);
  if (!l) fail(404, 'not_found', 'repair line');
  if (l.status !== 'active') fail(409, 'line_cancelled', 'this line was taken off the repair');
  return l;
};
/** The vendor charge must lie inside the repair type's vendor charge limits. */
async function checkVendorCharge(typeId: string, charge: string | null | undefined): Promise<void> {
  if (charge == null) return;
  if (!MONEY.test(charge)) invalid('vendor_charge', 'amount, up to 2 decimals');
  const t = await one<{ min: string | null; max: string | null }>(`SELECT min_vendor_charge::text AS min, max_vendor_charge::text AS max FROM masters.repair_type WHERE id = $1`, [typeId]);
  const c = cents(charge);
  if (t && ((t.min !== null && c < cents(t.min)) || (t.max !== null && c > cents(t.max))))
    fail(422, 'validation_failed', `vendor charge is outside the repair type limits (${t.min ?? 'no minimum'} to ${t.max ?? 'no maximum'})`,
      [{ path: 'vendor_charge', code: 'charge_out_of_range', message: `must be between ${t.min ?? '0'} and ${t.max ?? 'any amount'}` }]);
}
/** Derive and store the repair status from its live lines (inside the orders_writer block). */
async function syncStatus(repairId: string, c: { query: (q: string, p: unknown[]) => Promise<unknown> }): Promise<void> {
  const r = (await many<{ n: number; out: number; back: number }>(
    `SELECT count(*)::int AS n,
            (count(*) FILTER (WHERE issued_at IS NOT NULL AND received_at IS NULL))::int AS out,
            (count(*) FILTER (WHERE received_at IS NOT NULL))::int AS back
       FROM orders.repair_line WHERE repair_id = $1 AND status = 'active'`, [repairId]))[0];
  const status = r.n > 0 && r.back === r.n ? 'ready' : r.out > 0 ? 'issued_to_vendor' : r.back > 0 ? 'received_from_vendor' : 'received';
  await c.query(`UPDATE orders.repair SET status = $2 WHERE id = $1`, [repairId, status]);
}

/** Give a line to a vendor (orders.repair.vendor). The weight issued is the line's gross weight. */
export async function issueRepairLine(a: OrdersActor, repairId: string, lineId: string, p: IssueInput, ifVersion?: number): Promise<Repair> {
  need(a, 'orders.repair.vendor');
  const cur = await loadRepairForFlow(a, repairId);
  needBranch(a, cur.branch_id);
  const l0 = lineOf(cur, lineId);
  if (p.vendor_note != null && (typeof p.vendor_note !== 'string' || p.vendor_note.length > 500)) invalid('vendor_note', 'at most 500 characters');
  if (!(await vendorOk(p.vendor_id))) fail(422, 'unknown_reference', 'vendor_id', [{ path: 'vendor_id', code: 'unknown_reference', message: 'no active vendor (repair vendor or smith) with this id' }]);
  await checkVendorCharge(l0.repair_type_id, p.vendor_charge);
  const check = (r: Repair): void => {
    checkVersion('repair', r.version, ifVersion);
    inFlow(r);
    const l = lineOf(r, lineId);
    if (l.issued_at !== null) fail(409, 'line_already_issued', 'this line is already with a vendor or back from one');
  };
  check(cur);
  await withModuleRole('orders_writer', async (c) => {
    check(await loadRepairLocked(a, repairId));
    await c.query(`UPDATE orders.repair_line SET vendor_id = $2, vendor_charge = $3::numeric, vendor_note = $4, issued_at = now() WHERE id = $1`,
      [lineId, p.vendor_id, p.vendor_charge ?? null, p.vendor_note ?? null]);
    await syncStatus(repairId, c);
  });
  await audit('orders.repair.issue', 'orders.repair', repairId, { line_id: lineId, vendor_id: p.vendor_id, weight: l0.gross_wt });
  return getRepair(a, repairId);
}

/** Take a line back from the vendor before it was received (orders.repair.vendor). */
export async function unissueRepairLine(a: OrdersActor, repairId: string, lineId: string, ifVersion?: number): Promise<Repair> {
  need(a, 'orders.repair.vendor');
  const cur = await loadRepairForFlow(a, repairId);
  needBranch(a, cur.branch_id);
  lineOf(cur, lineId);
  const check = (r: Repair): void => {
    checkVersion('repair', r.version, ifVersion);
    inFlow(r);
    const l = lineOf(r, lineId);
    if (l.issued_at === null) fail(409, 'line_not_issued', 'this line is not with a vendor');
    if (l.received_at !== null) fail(409, 'line_already_received', 'this line is already back from the vendor');
  };
  check(cur);
  await withModuleRole('orders_writer', async (c) => {
    check(await loadRepairLocked(a, repairId));
    await c.query(`UPDATE orders.repair_line SET vendor_id = NULL, vendor_charge = NULL, vendor_note = NULL, issued_at = NULL WHERE id = $1`, [lineId]);
    await syncStatus(repairId, c);
  });
  await audit('orders.repair.unissue', 'orders.repair', repairId, { line_id: lineId });
  return getRepair(a, repairId);
}

/** loss in basis points of the weight issued; exceeded = strictly more than the tolerance (a loss exactly at the tolerance is accepted). */
function lossExceeds(issued: string, received: string, tolerancePct: string): boolean {
  const [i, f = ''] = tolerancePct.split('.');
  const tolBp = BigInt(i) * 100n + BigInt((f + '00').slice(0, 2));
  const g = mg(issued);
  return (g - mg(received)) * 10000n > g * tolBp;
}

/**
 * Receive a line back from the vendor with the weight now (orders.repair.vendor). Loss = weight issued - weight received; a loss above the
 * shop tolerance (default 1.00 %) BLOCKS the receipt (422 loss_exceeds_tolerance). It is accepted only when the caller holds
 * orders.repair.loss_override AND gives a reason; the reason and the person are kept on the line. A gain is not a loss and needs no override.
 */
export async function receiveRepairLine(a: OrdersActor, repairId: string, lineId: string, p: ReceiveBackInput, ifVersion?: number): Promise<Repair> {
  need(a, 'orders.repair.vendor');
  const cur = await loadRepairForFlow(a, repairId);
  needBranch(a, cur.branch_id);
  const l0 = lineOf(cur, lineId);
  const check = (r: Repair): void => {
    checkVersion('repair', r.version, ifVersion);
    inFlow(r);
    const l = lineOf(r, lineId);
    if (l.issued_at === null) fail(409, 'line_not_issued', 'this line is not with a vendor');
    if (l.received_at !== null) fail(409, 'line_already_received', 'this line is already back from the vendor');
  };
  check(cur);
  if (typeof p.received_wt !== 'string' || !W3.test(p.received_wt) || mg(p.received_wt) <= 0n) invalid('received_wt', 'decimal string above 0, up to 3 dp');
  const reason = p.loss_override_reason?.trim() || null;
  if (p.loss_override_reason != null && (reason === null || reason.length < 3 || reason.length > 300)) invalid('loss_override_reason', '3-300 characters');
  await checkVendorCharge(l0.repair_type_id, p.vendor_charge);
  const tolerance = (await loadSettings()).repair_loss_tolerance_pct;
  const exceeded = lossExceeds(l0.gross_wt, p.received_wt, tolerance);
  if (exceeded && !reason) {
    const loss = lossOf(l0.gross_wt, p.received_wt)!;
    fail(422, 'validation_failed', `weight loss ${loss.pct}% is above the shop tolerance of ${tolerance}%; a person with the override permission can accept it with a reason`,
      [{ path: 'received_wt', code: 'loss_exceeds_tolerance', message: `loss ${loss.wt} g (${loss.pct}%) is above ${tolerance}%` }]);
  }
  if (exceeded) need(a, 'orders.repair.loss_override');
  await withModuleRole('orders_writer', async (c) => {
    check(await loadRepairLocked(a, repairId));
    await c.query(
      `UPDATE orders.repair_line SET received_wt = $2::numeric, received_at = now(), vendor_charge = coalesce($3::numeric, vendor_charge),
         loss_override_reason = $4, loss_override_by = $5 WHERE id = $1`,
      [lineId, p.received_wt, p.vendor_charge ?? null, exceeded ? reason : null, exceeded ? a.userId : null]);
    await syncStatus(repairId, c);
  });
  const loss = lossOf(l0.gross_wt, p.received_wt)!;
  await audit(exceeded ? 'orders.repair.receive_loss_override' : 'orders.repair.receive', 'orders.repair', repairId,
    { line_id: lineId, issued_wt: l0.gross_wt, received_wt: p.received_wt, loss_wt: loss.wt, loss_pct: loss.pct, tolerance_pct: tolerance, ...(exceeded ? { reason } : {}) });
  return getRepair(a, repairId);
}
