import { one, many, asWriter, audit, outbox, iso, newId, payStatusSql } from './db';
import { fail } from './errors';
import { type SalesActor, need, needAny, needBranch } from './actor';
import { V } from './validate';
import { parseTender, type TenderIn } from './request';
import { checkTenders, redeemStoreCredit, tenderRows } from './tenders';
import { loadShop } from './settings';
import { nextCounterNo } from './numbering';
import { issueReversalNote, creditNoteView } from './credit-notes';
import { invoiceView } from './invoices';
import { d, m2, sum } from './num';

/**
 * S9 later receipts (993/994) and receipt reversal (993/995). The invoice row never changes; invoice_due moves money between buckets with
 * guarded UPDATEs (rowCount 1). Store credit on receipts: tender rows first, then the guarded balance_available draw-down (994 guard).
 */
interface DueRow { invoice_id: string; doc_no: string; branch_id: string; status: string; customer_id: string | null; balance_due: string | null; cash_total: string }
async function lockDue(invId: string): Promise<DueRow> {
  // Same lock order as cancellation / returns: invoice first, then its due. Read balances only AFTER the lock.
  await asWriter((c) => c.query(`SELECT id FROM sales.invoice WHERE id = $1 FOR UPDATE`, [invId]));
  const i = await one<DueRow>(`SELECT i.id AS invoice_id, i.doc_no, i.branch_id, i.status, d.customer_id, d.balance_due::text, b.cash_total::text
      FROM sales.invoice i LEFT JOIN sales.invoice_due d ON d.tenant_id = i.tenant_id AND d.invoice_id = i.id
      JOIN sales.v_invoice_balance b ON b.tenant_id = i.tenant_id AND b.invoice_id = i.id WHERE i.id = $1`, [invId]);
  if (!i) fail(404, 'not_found', 'invoice');
  // serialise receipts / reversals / returns on one bill: lock the due row (sales_writer holds UPDATE on it)
  if (i.balance_due !== null) await asWriter((c) => c.query(`SELECT 1 FROM sales.invoice_due WHERE invoice_id = $1 FOR UPDATE`, [invId]));
  return (await one<DueRow>(`SELECT i.id AS invoice_id, i.doc_no, i.branch_id, i.status, d.customer_id, d.balance_due::text, b.cash_total::text
      FROM sales.invoice i LEFT JOIN sales.invoice_due d ON d.tenant_id = i.tenant_id AND d.invoice_id = i.id
      JOIN sales.v_invoice_balance b ON b.tenant_id = i.tenant_id AND b.invoice_id = i.id WHERE i.id = $1`, [invId]))!;
}

export async function receiptView(id: string): Promise<Record<string, unknown>> {
  const r = await one<Record<string, unknown> & { total: string }>(`SELECT r.id, r.receipt_no, r.invoice_id, i.doc_no AS invoice_no, r.branch_id, r.customer_id,
      r.received_on::text, ${iso('r.received_at', 'received_at')}, r.received_by, r.total::text, r.note, r.reverses_receipt_id, r.reversal_reason,
      (SELECT rv.id FROM sales.payment_receipt rv WHERE rv.tenant_id = r.tenant_id AND rv.reverses_receipt_id = r.id) AS reversed_by_receipt_id,
      (coalesce((SELECT d.original_due FROM sales.invoice_due d WHERE d.tenant_id = r.tenant_id AND d.invoice_id = r.invoice_id), 0)
        - coalesce((SELECT d.due_reduced FROM sales.invoice_due d WHERE d.tenant_id = r.tenant_id AND d.invoice_id = r.invoice_id), 0)
        - (SELECT sum(x.total) FROM sales.payment_receipt x WHERE x.tenant_id = r.tenant_id AND x.invoice_id = r.invoice_id
             AND (x.received_at, x.id) <= (r.received_at, r.id)))::text AS balance_due_after
    FROM sales.payment_receipt r JOIN sales.invoice i ON i.tenant_id = r.tenant_id AND i.id = r.invoice_id WHERE r.id = $1`, [id]);
  if (!r) fail(404, 'not_found', 'receipt');
  const t = await tenderRows('payment_receipt_tender', 'receipt_id', id);
  const bda = d(r.balance_due_after as string);
  return { ...r, total: m2(r.total), balance_due_after: m2(bda.lt(0) ? 0 : bda), adjusted_balance_due_after: m2(bda.lt(0) ? 0 : bda), tenders: t.map((x) => ({ ...x, amount: m2(x.amount as string) })) };
}

/** Immutable print projection: the balance is AT RECEIPT ISSUE, never the live adjusted balance alias.
 * Older receipts may recover it ONLY from the first append-only invoice_due audit bearing their last_receipt_id.
 * No as-at inference from current dues or masters. Collection/reversal flags are immutable; current REVERSED is an envelope stamp.
 */
export async function receiptSnapshot(id: string): Promise<Record<string, unknown>> {
  const receipt = await receiptView(id);
  const inv = await invoiceView(receipt.invoice_id as string, true);
  if (!inv.seller) fail(422, 'invoice_print_snapshot_missing', 'receipt parent has no immutable seller snapshot');
  const atIssue = await one<{ amount: string }>(`SELECT coalesce(new_row->>'receipt_balance_due_at_issue', new_row->>'balance_due') AS amount
    FROM platform.audit_event WHERE tenant_id = platform.current_tenant() AND
      ((row_id = $1 AND table_name = 'sales.payment_receipt' AND action IN ('sales.payment.receive','sales.receipt.reverse')
         AND new_row ? 'receipt_balance_due_at_issue')
       OR (table_name = 'sales.invoice_due' AND new_row->>'last_receipt_id' = $1::text AND new_row ? 'balance_due'))
    ORDER BY seq LIMIT 1`, [id]);
  if (!atIssue?.amount) fail(422, 'receipt_print_snapshot_missing', 'no immutable receipt-issue balance audit; refusing current-balance reconstruction');
  const { balance_due_after, adjusted_balance_due_after, reversed_by_receipt_id, ...fixed } = receipt;
  void balance_due_after; void adjusted_balance_due_after; void reversed_by_receipt_id;
  return { ...fixed, kind: receipt.reverses_receipt_id ? 'reversal' : 'collection', seller: inv.seller, customer: inv.customer,
    invoice_date: inv.doc_date, adjusted_balance_due_at_issue: m2(atIssue.amount) };
}

/** POST /v1/sales/invoices/{id}/payments */
export async function receivePayment(a: SalesActor, invId: string, body: unknown): Promise<string> {
  need(a, 'sales.payment.receive');
  const v = new V(); const o = v.obj(body, '', ['tenders', 'note'], ['tenders']);
  const tenders: TenderIn[] = v.arr(o.tenders, 'tenders', { min: 1, max: 10 }).map((t, k) => parseTender(v, t, `tenders[${k}]`));
  const note = v.str(o.note, 'note', { optional: true, max: 300, trim: true }) ?? null; v.done();
  const inv = await lockDue(invId);
  needBranch(a, inv.branch_id);
  if (inv.status === 'cancelled') fail(409, 'invoice_cancelled', `invoice ${inv.doc_no} is cancelled`);
  if (inv.balance_due === null || d(inv.balance_due).isZero()) fail(409, 'invoice_fully_paid', `invoice ${inv.doc_no} is fully paid`);
  const total = sum(tenders.map((t) => d(t.amount)));
  if (total.gt(d(inv.balance_due))) fail(422, 'overpayment', `receipt ₹${m2(total)} exceeds the balance due ₹${m2(inv.balance_due)}`, [{ path: 'tenders', code: 'overpayment', message: `due ${m2(inv.balance_due)}` }]);
  await checkTenders(tenders, inv.customer_id, 'tenders');
  // S11 cash limit across the bill: at issue + receipts not reversed + this one
  const shop = await loadShop();
  const cash = d(inv.cash_total).plus(sum(tenders.filter((t) => t.mode === 'cash').map((t) => d(t.amount))));
  const cashNow = tenders.some((t) => t.mode === 'cash');
  const warnings: string[] = [];
  if (cashNow && cash.gte(d(shop.cash_limit_amount))) {
    if (shop.cash_limit_mode === 'block')
      fail(422, 'cash_limit_exceeded', `cash on one bill must stay below ₹${m2(shop.cash_limit_amount)} (s.269ST); with this receipt it is ₹${m2(cash)}`,
        [{ path: 'tenders', code: 'cash_limit_exceeded', message: 'over the cash limit' }]);
    warnings.push('cash_limit_exceeded');
  }
  const { fy, no } = await nextCounterNo(inv.branch_id, 'sales_receipt', shop.receipt_no_format);
  const id = await newId();
  await asWriter(async (c) => {
    await c.query(`INSERT INTO sales.payment_receipt(tenant_id, id, branch_id, fy, receipt_no, received_by, invoice_id, customer_id, total, note)
      VALUES (platform.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9)`, [id, inv.branch_id, fy, no, a.userId, invId, inv.customer_id, m2(total), note]);
    for (const [k, t] of tenders.entries())
      await c.query(`INSERT INTO sales.payment_receipt_tender(tenant_id, receipt_id, line_no, mode, payment_mode_id, card_machine_id, reference, cheque_date, bank_name, credit_note_id, amount)
        VALUES (platform.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [id, k + 1, t.mode, t.payment_mode_id, t.card_machine_id, t.reference, t.cheque_date, t.bank_name, t.credit_note_id, m2(t.amount)]);
    const u = await c.query(`UPDATE sales.invoice_due SET balance_due = balance_due - $2::numeric, received_after_issue = received_after_issue + $2::numeric,
        last_receipt_id = $3, updated_at = now() WHERE tenant_id = platform.current_tenant() AND invoice_id = $1 AND balance_due >= $2::numeric`, [invId, m2(total), id]);
    if (u.rowCount !== 1) fail(422, 'overpayment', 'the balance due changed meanwhile');
  });
  const redeemed = await redeemStoreCredit(tenders);
  await audit('sales.payment.receive', 'sales.payment_receipt', id, { receipt_no: no, invoice_id: invId, invoice_no: inv.doc_no, total: m2(total),
    modes: tenders.map((t) => t.mode), store_credit: redeemed, warnings, receipt_balance_due_at_issue: m2(d(inv.balance_due).minus(total)) });
  await outbox('sales.payment_received', { receipt_id: id, receipt_no: no, invoice_id: invId, total: m2(total) });
  return id;
}

/**
 * POST /v1/sales/invoices/{id}/payments/{receipt_id}/reversal — ONE transaction:
 * 1. reversal payment_receipt (total = −original, reverses_receipt_id, reversed_total, reason; no tenders);
 * 2. invoice_due restored by the full receipt amount (guarded);
 * 3. if the original had credit_note tenders: ONE new credit note kind receipt_reversal for their sum (995) — the original notes stay reduced.
 * Once per receipt (409 receipt_already_reversed); a reversal cannot be reversed (409 receipt_is_reversal). sales.receipt.reverse (owner / manager).
 */
export async function reverseReceipt(a: SalesActor, invId: string, receiptId: string, body: unknown): Promise<{ reversal_id: string; credit_note_id: string | null }> {
  need(a, 'sales.receipt.reverse');
  const v = new V(); const o = v.obj(body, '', ['reason'], ['reason']);
  const reason = v.str(o.reason, 'reason', { min: 5, max: 200, trim: true }); v.done();
  const inv = await lockDue(invId);
  needBranch(a, inv.branch_id);
  const r = await one<{ id: string; invoice_id: string; total: string; receipt_no: string; reverses_receipt_id: string | null; customer_id: string; branch_id: string }>(
    `SELECT id, invoice_id, total::text, receipt_no, reverses_receipt_id, customer_id, branch_id FROM sales.payment_receipt WHERE id = $1 AND invoice_id = $2`, [receiptId, invId]);
  if (!r) fail(404, 'not_found', 'receipt');
  if (r.reverses_receipt_id) fail(409, 'receipt_is_reversal', 'a reversal cannot be reversed');
  if (await one(`SELECT 1 FROM sales.payment_receipt WHERE reverses_receipt_id = $1`, [receiptId])) fail(409, 'receipt_already_reversed', `receipt ${r.receipt_no} was already reversed`);
  if (inv.status === 'cancelled') fail(409, 'invoice_cancelled', `invoice ${inv.doc_no} is cancelled`);
  const sc = await one<{ s: string }>(`SELECT coalesce(sum(amount), 0)::text AS s FROM sales.payment_receipt_tender WHERE receipt_id = $1 AND mode = 'credit_note'`, [receiptId]);
  const storeCredit = d(sc!.s);
  const shop = await loadShop();
  const { fy, no } = await nextCounterNo(r.branch_id, 'sales_receipt', shop.receipt_no_format);
  const id = await newId();
  await asWriter(async (c) => {
    try {
      await c.query(`INSERT INTO sales.payment_receipt(tenant_id, id, branch_id, fy, receipt_no, received_by, invoice_id, customer_id, total, note,
          reverses_receipt_id, reversed_total, reversal_reason) VALUES (platform.current_tenant(), $1, $2, $3, $4, $5, $6, $7, -$8::numeric, NULL, $9, $8::numeric, $10)`,
        [id, r.branch_id, fy, no, a.userId, invId, r.customer_id, m2(r.total), receiptId, reason]);
    } catch (e) {
      if ((e as { code?: string }).code === '23505') fail(409, 'receipt_already_reversed', `receipt ${r.receipt_no} was already reversed`);
      throw e;
    }
    const u = await c.query(`UPDATE sales.invoice_due SET balance_due = balance_due + $2::numeric, received_after_issue = received_after_issue - $2::numeric,
        last_receipt_id = $3, updated_at = now() WHERE tenant_id = platform.current_tenant() AND invoice_id = $1 AND received_after_issue >= $2::numeric`, [invId, m2(r.total), id]);
    if (u.rowCount !== 1) fail(409, 'receipt_not_reversible', 'the bill no longer holds this receipt in its received total (credited by a return?)');
  });
  const cn = storeCredit.gt(0)
    ? await issueReversalNote(a, { reversal_id: id, invoice_id: invId, branch_id: r.branch_id, customer_id: r.customer_id, amount: storeCredit,
        reason: `Reversal of receipt ${r.receipt_no}: ${reason}`.slice(0, 500) })
    : null;
  await audit('sales.receipt.reverse', 'sales.payment_receipt', id, { receipt_no: no, reverses_receipt_id: receiptId, reverses_receipt_no: r.receipt_no, invoice_id: invId,
    amount: m2(r.total), store_credit_returned: m2(storeCredit), credit_note_id: cn, reason, receipt_balance_due_at_issue: m2(d(inv.balance_due!).plus(d(r.total))) });
  await outbox('sales.payment_reversed', { receipt_id: id, reverses_receipt_id: receiptId, invoice_id: invId, amount: m2(r.total), credit_note_id: cn });
  return { reversal_id: id, credit_note_id: cn };
}
export async function reversalView(x: { reversal_id: string; credit_note_id: string | null }): Promise<Record<string, unknown>> {
  return { reversal: await receiptView(x.reversal_id), store_credit_note: x.credit_note_id ? await creditNoteView(x.credit_note_id) : null };
}

/** GET /v1/sales/invoices/{id}/payments */
export async function invoicePayments(a: SalesActor, invId: string): Promise<Record<string, unknown>> {
  needAny(a, ['sales.invoice.view']);
  const b = await one<{ branch_id: string; net_payable: string; paid_amount: string; balance_due: string; payment_status: string }>(
    `SELECT b.branch_id, b.net_payable::text, b.paid_amount::text, b.balance_due::text, ${payStatusSql('b')} AS payment_status FROM sales.v_invoice_balance b WHERE b.invoice_id = $1`, [invId]);
  if (!b) fail(404, 'not_found', 'invoice');
  needBranch(a, b.branch_id);
  const at = await tenderRows('invoice_payment', 'invoice_id', invId);
  const rs = await many<{ id: string }>(`SELECT id FROM sales.payment_receipt WHERE invoice_id = $1 ORDER BY received_at, id`, [invId]);
  const receipts = [];
  for (const r of rs) receipts.push(await receiptView(r.id));
  const refunds = await many<Record<string, unknown>>(`SELECT id AS credit_note_id, CASE WHEN refund_amount > 0 THEN refund_mode ELSE 'store_credit' END AS mode,
      (refund_amount + store_credit_amount)::text AS amount, ${iso('issued_at', 'at')} FROM sales.credit_note
      WHERE invoice_id = $1 AND kind <> 'receipt_reversal' AND refund_amount + store_credit_amount > 0 ORDER BY issued_at, id`, [invId]);
  return { invoice_id: invId, net_payable: m2(b.net_payable), at_issue: at.map((x) => ({ ...x, amount: m2(x.amount as string) })), receipts,
    refunds: refunds.map((x) => ({ ...x, amount: m2(x.amount as string) })), paid_amount: m2(b.paid_amount), balance_due: m2(b.balance_due), payment_status: b.payment_status };
}
