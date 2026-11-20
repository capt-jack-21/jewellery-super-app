import { one, many, asWriter } from './db';
import { fail } from './errors';
import type { TenderIn } from './request';
import { d, m2 } from './num';

/**
 * S9 tender checks shared by issue and receipts: payment_mode_id must be of the same kind (and active), a reference / card machine when the
 * mode requires one; store credit (mode credit_note) only from a credit note of the same customer with enough balance_available
 * (409 store_credit_insufficient). Redemption itself is redeemStoreCredit() after the tender rows are written (G3 / 994 guard).
 */
export async function checkTenders(tenders: TenderIn[], customerId: string | null, path = 'payments', lock = false): Promise<void> {
  const perNote = new Map<string, number[]>();
  for (const [i, t] of tenders.entries()) {
    const p = `${path}[${i}]`;
    if (t.payment_mode_id) {
      const pm = await one<{ kind: string; is_active: boolean; requires_reference: boolean; requires_card_machine: boolean }>(
        `SELECT kind, is_active, requires_reference, requires_card_machine FROM masters.payment_mode WHERE id = $1`, [t.payment_mode_id]);
      if (!pm) fail(422, 'unknown_reference', 'payment_mode_id', [{ path: `${p}.payment_mode_id`, code: 'unknown_reference', message: 'no such payment mode' }]);
      if (!pm.is_active) fail(422, 'inactive_master', 'payment mode is inactive', [{ path: `${p}.payment_mode_id`, code: 'inactive_master', message: 'inactive' }]);
      if (pm.kind !== t.mode) fail(422, 'validation_failed', 'payment mode kind differs from mode', [{ path: `${p}.payment_mode_id`, code: 'invalid', message: `kind is ${pm.kind}` }]);
      if (pm.requires_reference && !t.reference) fail(422, 'validation_failed', 'reference required', [{ path: `${p}.reference`, code: 'required', message: 'required for this payment mode' }]);
      if (pm.requires_card_machine && !t.card_machine_id) fail(422, 'validation_failed', 'card machine required', [{ path: `${p}.card_machine_id`, code: 'required', message: 'required for this payment mode' }]);
    }
    if (t.card_machine_id && !(await one(`SELECT 1 FROM masters.card_machine WHERE id = $1 AND is_active`, [t.card_machine_id])))
      fail(422, 'unknown_reference', 'card_machine_id', [{ path: `${p}.card_machine_id`, code: 'unknown_reference', message: 'no active card machine' }]);
    if (t.mode === 'credit_note') perNote.set(t.credit_note_id!, [...(perNote.get(t.credit_note_id!) ?? []), i]);
  }
  for (const [cn, idx] of perNote) {
    const want = idx.reduce((s, i) => s.plus(d(tenders[i].amount)), d(0));
    const n = await one<{ customer_id: string | null; inv_customer: string | null; balance_available: string }>(
      `SELECT c.customer_id, i.customer_id AS inv_customer, c.balance_available::text FROM sales.credit_note c
         JOIN sales.invoice i ON i.tenant_id = c.tenant_id AND i.id = c.invoice_id WHERE c.id = $1${lock ? ' FOR UPDATE OF c' : ''}`, [cn]);
    const p = `${path}[${idx[0]}].credit_note_id`;
    if (!n) fail(422, 'unknown_reference', 'credit_note_id', [{ path: p, code: 'unknown_reference', message: 'no such credit note' }]);
    if (!customerId || (n.customer_id ?? n.inv_customer) !== customerId)
      fail(422, 'validation_failed', 'store credit belongs to another customer', [{ path: p, code: 'invalid', message: 'store credit of another customer' }]);
    if (d(n.balance_available).lt(want)) fail(409, 'store_credit_insufficient', `store credit available ₹${m2(n.balance_available)}, asked ₹${m2(want)}`);
  }
}
/**
 * Draws store credit down: guarded UPDATE (balance_available >= amount, rowCount 1) as sales_writer, after the invoice_payment /
 * payment_receipt_tender rows of this transaction exist (issued_doc_guard counts them). Concurrent use of the same note: the row lock
 * serialises; the loser sees the lower balance and gets 409 store_credit_insufficient.
 */
export async function redeemStoreCredit(tenders: TenderIn[]): Promise<{ credit_note_id: string; amount: string }[]> {
  const sums = new Map<string, ReturnType<typeof d>>();
  for (const t of tenders) if (t.mode === 'credit_note') sums.set(t.credit_note_id!, (sums.get(t.credit_note_id!) ?? d(0)).plus(d(t.amount)));
  const out: { credit_note_id: string; amount: string }[] = [];
  for (const [cn, amt] of [...sums.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const r = await asWriter((c) => c.query(`UPDATE sales.credit_note SET balance_available = balance_available - $2::numeric
        WHERE tenant_id = platform.current_tenant() AND id = $1 AND balance_available >= $2::numeric`, [cn, m2(amt)]));
    if (r.rowCount !== 1) fail(409, 'store_credit_insufficient', 'store credit balance is lower than the amount (used elsewhere meanwhile)');
    out.push({ credit_note_id: cn, amount: m2(amt) });
  }
  return out;
}
/**
 * O6: advance tenders (internal mode 'advance', built only by the order-delivery path). Pre-checks give clean errors; redeemAdvances() does the
 * guarded draw-down after the invoice_payment rows exist (advance_guard allows a decrease only up to the advance payments of THIS transaction's bill).
 */
const advanceSums = (tenders: TenderIn[]): Map<string, ReturnType<typeof d>> => {
  const sums = new Map<string, ReturnType<typeof d>>();
  for (const t of tenders) if (t.mode === 'advance') sums.set(t.advance_id!, (sums.get(t.advance_id!) ?? d(0)).plus(d(t.amount)));
  return sums;
};
export async function checkAdvances(tenders: TenderIn[], customerId: string | null, orderId: string | null, repairId: string | null = null): Promise<void> {
  for (const [id, want] of advanceSums(tenders)) {
    const a = await one<{ customer_id: string; order_id: string | null; repair_id: string | null; kind: string; status: string; balance: string; receipt_no: string }>(
      `SELECT customer_id, order_id, repair_id, kind, status, balance::text, receipt_no FROM sales.advance WHERE id = $1`, [id]);
    if (!a) fail(422, 'unknown_reference', 'advance_id', [{ path: 'payments', code: 'unknown_reference', message: `no such advance ${id}` }]);
    if (a.customer_id !== customerId || a.order_id !== orderId || a.repair_id !== repairId) fail(422, 'validation_failed', 'the advance belongs to another customer, order or repair', [{ path: 'payments', code: 'invalid', message: `advance ${a.receipt_no} is not for this bill` }]);
    if (a.kind !== 'amount') fail(409, 'advance_is_metal', `advance ${a.receipt_no} is a metal advance; only money advances are applied as payment`);
    if (!['open', 'partly_redeemed'].includes(a.status)) fail(409, 'advance_not_open', `advance ${a.receipt_no} is ${a.status}`);
    if (d(a.balance).lt(want)) fail(409, 'advance_insufficient', `advance ${a.receipt_no} has ₹${m2(a.balance)} left, asked ₹${m2(want)}`);
  }
}
export async function redeemAdvances(tenders: TenderIn[], orderId: string | null, repairId: string | null = null): Promise<{ advance_id: string; amount: string }[]> {
  const out: { advance_id: string; amount: string }[] = [];
  for (const [id, amt] of [...advanceSums(tenders).entries()].sort(([x], [y]) => x.localeCompare(y))) {
    const r = await asWriter((c) => c.query(`UPDATE sales.advance SET balance = balance - $2::numeric,
          status = CASE WHEN balance - $2::numeric = 0 THEN 'redeemed' ELSE 'partly_redeemed' END
        WHERE tenant_id = platform.current_tenant() AND id = $1 AND kind = 'amount' AND order_id IS NOT DISTINCT FROM $3 AND repair_id IS NOT DISTINCT FROM $4 AND status IN ('open', 'partly_redeemed')
          AND balance >= $2::numeric`, [id, m2(amt), orderId, repairId]));
    if (r.rowCount !== 1) fail(409, 'advance_insufficient', 'the advance balance is lower than the amount (used elsewhere meanwhile)');
    out.push({ advance_id: id, amount: m2(amt) });
  }
  return out;
}
export async function tenderRows(table: 'invoice_payment' | 'payment_receipt_tender', fk: string, id: string): Promise<Record<string, unknown>[]> {
  return many(`SELECT line_no, mode, payment_mode_id, amount::text, reference, card_machine_id, cheque_date::text, bank_name, credit_note_id
      FROM sales.${table} WHERE ${fk} = $1 ORDER BY line_no`, [id]);
}
