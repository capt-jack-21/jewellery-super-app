import { one, many, asWriter, audit, outbox, iso, newId } from './db';
import { fail } from './errors';
import { type SalesActor, need, needAny, needBranch, branchScope } from './actor';
import { V, isObj } from './validate';
import { allocateGapless } from './numbering';
import { loadShop, roundOffTo } from './settings';
import { invoiceView } from './invoices';
import { stockPort, type ReturnRow } from './ports';
import { d, m2, allocate, sum, ZERO, type Dec } from './num';

/**
 * S15 cancellation / S16 whole-line returns / 995 receipt-reversal store credit. Credit notes are gapless per branch per FY (current FY,
 * D24), written only as sales_writer; issued_doc_guard keeps them immutable except balance_available (decrease-only, G3).
 * GST: kind receipt_reversal is NOT a tax document (no lines, no tax) — the GST views (gstCreditNotes) exclude it.
 */
export const GST_CN_KINDS = ['cancellation', 'sales_return'] as const;
export const CN_KINDS = ['cancellation', 'sales_return', 'receipt_reversal'] as const;

interface InvHead { id: string; doc_no: string; branch_id: string; status: string; customer_id: string | null; customer_snapshot: Record<string, unknown>;
  doc_date: string; invoice_total: string; round_off_to: string; balance_due: string; due_balance: string | null }
async function lockInvoice(id: string): Promise<InvHead> {
  await asWriter((c) => c.query(`SELECT id FROM sales.invoice WHERE id = $1 FOR UPDATE`, [id]));
  const i = await asWriter(async (c) => (await c.query<InvHead>(`SELECT i.id, i.doc_no, i.branch_id, i.status, i.customer_id, i.customer_snapshot, i.doc_date::text,
      i.invoice_total::text, coalesce(i.round_off_to, 1)::text AS round_off_to, i.balance_due::text,
      (SELECT d.balance_due::text FROM sales.invoice_due d WHERE d.tenant_id = i.tenant_id AND d.invoice_id = i.id) AS due_balance
    FROM sales.invoice i WHERE i.id = $1 FOR UPDATE OF i`, [id])).rows[0]);
  if (!i) fail(404, 'not_found', 'invoice');
  return i;
}
interface LineRow { id: string; line_no: number; stock_kind: string; tag_id: string | null; tag_no: string | null; description: string; item_id: string;
  purity_id: string; counter_id: string | null; box_id: string | null; pieces: number; gross_wt: string; net_wt: string; taxable_value: string;
  cgst: string; sgst: string; igst: string; cess: string; line_total: string; returned: boolean }
const openLines = (invId: string) => many<LineRow>(`SELECT l.id, l.line_no, coalesce(l.stock_kind, CASE WHEN l.tag_id IS NULL THEN 'loose' ELSE 'tag' END) AS stock_kind,
    l.tag_id, t.tag_no, l.description, l.item_id, coalesce(l.purity_id, t.purity_id) AS purity_id, l.counter_id, l.box_id, l.pieces, l.gross_wt::text, l.net_wt::text,
    l.taxable_value::text, l.cgst::text, l.sgst::text, l.igst::text, coalesce(l.cess, 0)::text AS cess, l.line_total::text,
    EXISTS (SELECT 1 FROM sales.credit_note_line x WHERE x.tenant_id = l.tenant_id AND x.invoice_line_id = l.id) AS returned
  FROM sales.invoice_line l LEFT JOIN inventory.tag t ON t.tenant_id = l.tenant_id AND t.id = l.tag_id WHERE l.invoice_id = $1 ORDER BY l.line_no`, [invId]);

/** Money already settled on the bill and not yet credited back: invoice_total − current due − total of earlier normal credits (including their due reductions). */
async function refundable(inv: InvHead): Promise<Dec> {
  const prior = await one<{ s: string }>(`SELECT coalesce(sum(total), 0)::text AS s FROM sales.credit_note
      WHERE invoice_id = $1 AND kind <> 'receipt_reversal'`, [inv.id]);
  const due = d(inv.due_balance ?? 0);
  const r = d(inv.invoice_total).minus(due).minus(d(prior!.s));
  return r.lt(0) ? ZERO : r;
}
/** Store credit spent on this bill (at issue + receipts not reversed) — comes back as store credit, never as cash (G3: old notes stay reduced). */
async function storeCreditSpent(invId: string): Promise<Dec> {
  const r = await one<{ s: string }>(`SELECT (coalesce((SELECT sum(amount) FROM sales.invoice_payment WHERE invoice_id = $1 AND mode = 'credit_note'), 0)
      + coalesce((SELECT sum(t.amount) FROM sales.payment_receipt_tender t JOIN sales.payment_receipt r ON r.tenant_id = t.tenant_id AND r.id = t.receipt_id
                  WHERE r.invoice_id = $1 AND t.mode = 'credit_note'
                    AND NOT EXISTS (SELECT 1 FROM sales.payment_receipt rv WHERE rv.tenant_id = r.tenant_id AND rv.reverses_receipt_id = r.id)), 0)
      - coalesce((SELECT sum(store_credit_amount) FROM sales.credit_note WHERE invoice_id = $1 AND kind <> 'receipt_reversal'), 0))::text AS s`, [invId]);
  const v = d(r!.s);
  return v.lt(0) ? ZERO : v;
}

function parseRestock(v: V, x: unknown): { counter_id: string | null; tray_id: string | null } | null {
  if (x === undefined || x === null) return null;
  const o = v.obj(x, 'restock', ['counter_id', 'tray_id']);
  return { counter_id: v.uuid(o.counter_id, 'restock.counter_id', { optional: true, nullable: true }) ?? null,
    tray_id: v.uuid(o.tray_id, 'restock.tray_id', { optional: true, nullable: true }) ?? null };
}
async function checkRestock(r: { counter_id: string | null; tray_id: string | null } | null, branchId: string): Promise<void> {
  if (!r) return;
  if (r.counter_id && !(await one(`SELECT 1 FROM masters.counter WHERE id = $1 AND branch_id = $2 AND is_active`, [r.counter_id, branchId])))
    fail(422, 'unknown_reference', 'restock.counter_id', [{ path: 'restock.counter_id', code: 'unknown_reference', message: 'no active counter at this branch' }]);
  if (r.tray_id && !(await one(`SELECT 1 FROM masters.box WHERE id = $1 AND is_active`, [r.tray_id])))
    fail(422, 'unknown_reference', 'restock.tray_id', [{ path: 'restock.tray_id', code: 'unknown_reference', message: 'no active tray' }]);
}

interface Settlement { refund_mode: string; refund_amount: Dec; due_reduced: Dec; store_credit_amount: Dec }
async function writeNote(a: SalesActor, inv: InvHead, kind: 'cancellation' | 'sales_return', reason: string, lines: LineRow[], s: Settlement,
  roundOff: Dec, totals: Record<'taxable' | 'cgst' | 'sgst' | 'igst' | 'cess' | 'total', Dec>,
  restock: { counter_id: string | null; tray_id: string | null } | null): Promise<string> {
  const num = await allocateGapless(inv.branch_id, 'credit_note');
  const id = await newId();
  await asWriter(async (c) => {
    await c.query(`INSERT INTO sales.credit_note(tenant_id, id, branch_id, fy, doc_seq, doc_no, invoice_id, kind, reason, taxable_value, cgst, sgst, igst, cess, round_off,
        total, refund_mode, balance_available, created_by, customer_id, customer_snapshot, refund_amount, due_reduced, store_credit_amount)
      VALUES (platform.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20::jsonb, $21, $22, $17)`,
      [id, inv.branch_id, num.fy, num.seq, num.docNo, inv.id, kind, reason, m2(totals.taxable), m2(totals.cgst), m2(totals.sgst), m2(totals.igst), m2(totals.cess),
       m2(roundOff), m2(totals.total), s.refund_mode, m2(s.store_credit_amount), a.userId, inv.customer_id, JSON.stringify(inv.customer_snapshot),
       m2(s.refund_amount), m2(s.due_reduced)]);
    for (const l of lines)
      await c.query(`INSERT INTO sales.credit_note_line(tenant_id, credit_note_id, invoice_line_id, taxable_value, cgst, sgst, igst, cess, line_total, stock_kind,
          restock_counter_id, restock_box_id) VALUES (platform.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [id, l.id, l.taxable_value, l.cgst, l.sgst, l.igst, l.cess, l.line_total, l.stock_kind, restock?.counter_id ?? l.counter_id, restock?.tray_id ?? l.box_id]);
    if (s.due_reduced.gt(0)) {
      const r = await c.query(`UPDATE sales.invoice_due SET balance_due = balance_due - $2::numeric, due_reduced = due_reduced + $2::numeric, updated_at = now()
          WHERE tenant_id = platform.current_tenant() AND invoice_id = $1 AND balance_due >= $2::numeric`, [inv.id, m2(s.due_reduced)]);
      if (r.rowCount !== 1) fail(409, 'invoice_changed', 'the balance due changed meanwhile; retry');
    }
  });
  const rows: ReturnRow[] = lines.map((l) => ({ tag_id: l.tag_id, item_id: l.item_id, purity_id: l.purity_id, counter_id: restock?.counter_id ?? l.counter_id,
    box_id: restock?.tray_id ?? l.box_id, pieces: l.pieces, gross_wt: l.gross_wt, net_wt: l.net_wt }));
  if (rows.length) await stockPort().returnToStock(rows, { branchId: inv.branch_id, userId: a.userId, sourceType: 'credit_note', sourceId: id,
    movement: kind === 'cancellation' ? 'cancel_reversal' : 'sales_return' });
  await audit(`sales.credit_note.${kind}`, 'sales.credit_note', id, { doc_no: num.docNo, invoice_id: inv.id, invoice_no: inv.doc_no, total: m2(totals.total),
    refund_mode: s.refund_mode, refund_amount: m2(s.refund_amount), due_reduced: m2(s.due_reduced), store_credit_amount: m2(s.store_credit_amount),
    lines: lines.map((l) => l.line_no), reason });
  await outbox('sales.credit_note_issued', { credit_note_id: id, doc_no: num.docNo, kind, invoice_id: inv.id, total: m2(totals.total) });
  return id;
}
function settle(total: Dec, refundableNow: Dec, scSpent: Dec, mode: string): Settlement {
  const paidBack = total.lt(refundableNow) ? total : refundableNow;
  const due = total.minus(paidBack);
  const sc = mode === 'store_credit' ? paidBack : (scSpent.lt(paidBack) ? scSpent : paidBack);
  const refund = paidBack.minus(sc);
  return { refund_mode: refund.isZero() ? 'store_credit' : mode, refund_amount: refund, due_reduced: due, store_credit_amount: sc };
}
/** B1: normal credits consume the original rounded invoice liability; restoration notes are not tax credits. */
async function remainingLiability(inv: InvHead): Promise<Dec> {
  const prior = await one<{ total: string }>(`SELECT coalesce(sum(total), 0)::text AS total FROM sales.credit_note WHERE invoice_id = $1 AND kind <> 'receipt_reversal'`, [inv.id]);
  const left = d(inv.invoice_total).minus(d(prior!.total));
  if (left.lt(0)) fail(409, 'invoice_changed', 'prior credit notes exceed original invoice liability');
  return left;
}
function returnLiability(inv: InvHead, all: LineRow[], selected: LineRow[], policy: string, remaining: Dec): Dec {
  if (selected.length === all.filter((l) => !l.returned).length) return remaining; // final return closes every paisa
  const shares = allocate(d(inv.invoice_total), all.map((l) => d(l.line_total)));
  const target = policy === 'exact' ? sum(selected.map((l) => d(l.line_total)))
    : sum(all.map((l, i) => selected.some((x) => x.id === l.id) ? shares[i] : ZERO));
  return target.gt(remaining) ? remaining : target;
}

const sumLines = (ls: LineRow[]) => ({ taxable: sum(ls.map((l) => d(l.taxable_value))), cgst: sum(ls.map((l) => d(l.cgst))), sgst: sum(ls.map((l) => d(l.sgst))),
  igst: sum(ls.map((l) => d(l.igst))), cess: sum(ls.map((l) => d(l.cess))), lt: sum(ls.map((l) => d(l.line_total))) });

/** S15 cancel the whole bill. */
export async function cancelInvoice(a: SalesActor, invId: string, body: unknown): Promise<string> {
  need(a, 'sales.invoice.cancel');
  const v = new V(); const o = v.obj(body, '', ['reason', 'refund_mode', 'restock'], ['reason', 'refund_mode']);
  const reason = v.str(o.reason, 'reason', { min: 5, max: 500, trim: true });
  const mode = v.oneOf(o.refund_mode, 'refund_mode', ['store_credit', 'cash', 'bank_transfer', 'reversal'] as const);
  const restock = parseRestock(v, o.restock); v.done();
  const inv = await lockInvoice(invId);
  needBranch(a, inv.branch_id);
  if (inv.status === 'cancelled') fail(409, 'invoice_cancelled', `invoice ${inv.doc_no} is already cancelled`);
  await checkRestock(restock, inv.branch_id);
  const lines = (await openLines(invId)).filter((l) => !l.returned);
  const t = sumLines(lines);
  const total = await remainingLiability(inv);
  const ro = total.minus(t.lt);
  const s = settle(total, await refundable(inv), await storeCreditSpent(invId), mode!);
  const id = await writeNote(a, inv, 'cancellation', reason!, lines, s, ro, { taxable: t.taxable, cgst: t.cgst, sgst: t.sgst, igst: t.igst, cess: t.cess, total }, restock);
  await asWriter(async (c) => {
    const r = await c.query(`UPDATE sales.invoice SET status = 'cancelled', cancelled_at = now(), cancel_credit_note_id = $2 WHERE id = $1 AND status = 'issued'`, [invId, id]);
    if (r.rowCount !== 1) fail(409, 'invoice_cancelled', 'invoice already cancelled');
  });
  await audit('sales.invoice.cancel', 'sales.invoice', invId, { doc_no: inv.doc_no, credit_note_id: id, reason });
  return id;
}

/** S16 sales return of whole lines inside the window. */
export async function returnLines(a: SalesActor, invId: string, body: unknown, day: string): Promise<string> {
  need(a, 'sales.return.issue');
  const v = new V(); const o = v.obj(body, '', ['line_ids', 'reason', 'refund_mode', 'restock'], ['line_ids', 'reason']);
  const ids = v.arr(o.line_ids, 'line_ids', { min: 1, max: 200 }).map((x, i) => v.uuid(x, `line_ids[${i}]`, {})!);
  if (new Set(ids).size !== ids.length) v.err('line_ids', 'duplicate line ids', 'duplicate');
  const reason = v.str(o.reason, 'reason', { min: 5, max: 500, trim: true });
  const modeIn = v.oneOf(o.refund_mode, 'refund_mode', ['store_credit', 'cash', 'bank_transfer'] as const, { optional: true });
  const restock = parseRestock(v, o.restock); v.done();
  const inv = await lockInvoice(invId);
  needBranch(a, inv.branch_id);
  if (inv.status === 'cancelled') fail(409, 'invoice_cancelled', `invoice ${inv.doc_no} is cancelled`);
  const shop = await loadShop();
  const last = await one<{ d: string }>(`SELECT ($1::date + $2::int)::text AS d`, [inv.doc_date, shop.return_window_days]);
  if (day > last!.d) fail(422, 'return_window_expired', `returns for ${inv.doc_no} closed on ${last!.d}`);
  await checkRestock(restock, inv.branch_id);
  const all = await openLines(invId);
  const lines: LineRow[] = [];
  for (const [k, lid] of ids.entries()) {
    const l = all.find((x) => x.id === lid);
    if (!l) fail(422, 'line_not_on_invoice', 'line not on this bill', [{ path: `line_ids[${k}]`, code: 'line_not_on_invoice', message: 'not on this bill' }]);
    if (l.returned) fail(409, 'line_already_returned', `line ${l.line_no} was already returned`);
    lines.push(l);
  }
  const t = sumLines(lines);
  const total = returnLiability(inv, all, lines, shop.credit_note_rounding, await remainingLiability(inv));
  const ro = total.minus(t.lt);
  const s = settle(total, await refundable(inv), await storeCreditSpent(invId), modeIn ?? shop.return_refund_default);
  if (s.due_reduced.gt(d(inv.due_balance ?? 0))) fail(409, 'invoice_changed', 'credit exceeds what is paid and due on the bill');
  return writeNote(a, inv, 'sales_return', reason!, lines.sort((x, y) => x.line_no - y.line_no), s, ro,
    { taxable: t.taxable, cgst: t.cgst, sgst: t.sgst, igst: t.igst, cess: t.cess, total }, restock);
}

/**
 * 995: store credit consumed by a reversed receipt comes back as ONE NEW credit note (kind receipt_reversal) in the reversal's transaction.
 * The DB (RESTRICTIVE policy insert_receipt_reversal) re-checks amount / same transaction / branch / invoice / customer; UNIQUE = one per reversal.
 * The trigger raises the owner alert alert.receipt_reversal (995 c697c4a1); the app writes none.
 */
export async function issueReversalNote(a: SalesActor, r: { reversal_id: string; invoice_id: string; branch_id: string; customer_id: string; amount: Dec; reason: string }): Promise<string> {
  const inv = await one<{ customer_snapshot: Record<string, unknown> }>(`SELECT customer_snapshot FROM sales.invoice WHERE id = $1`, [r.invoice_id]);
  const num = await allocateGapless(r.branch_id, 'credit_note');
  const id = await newId();
  await asWriter((c) => c.query(`INSERT INTO sales.credit_note(tenant_id, id, branch_id, fy, doc_seq, doc_no, invoice_id, kind, reason, taxable_value, cgst, sgst, igst, cess,
      round_off, total, refund_mode, balance_available, created_by, customer_id, customer_snapshot, refund_amount, due_reduced, store_credit_amount, reversal_receipt_id)
    VALUES (platform.current_tenant(), $1, $2, $3, $4, $5, $6, 'receipt_reversal', $7, 0, 0, 0, 0, 0, 0, $8, 'store_credit', $8, $9, $10, $11::jsonb, 0, 0, $8, $12)`,
    [id, r.branch_id, num.fy, num.seq, num.docNo, r.invoice_id, r.reason, m2(r.amount), a.userId, r.customer_id, JSON.stringify(inv?.customer_snapshot ?? {}), r.reversal_id]));
  await audit('sales.credit_note.receipt_reversal', 'sales.credit_note', id, { doc_no: num.docNo, invoice_id: r.invoice_id, reversal_receipt_id: r.reversal_id, total: m2(r.amount) });
  await outbox('sales.credit_note_issued', { credit_note_id: id, doc_no: num.docNo, kind: 'receipt_reversal', invoice_id: r.invoice_id, total: m2(r.amount) });
  return id;
}

/** Contract CreditNote. */
export async function creditNoteView(id: string): Promise<Record<string, unknown>> {
  const c = await one<Record<string, unknown> & { lines?: unknown }>(`SELECT c.id, c.doc_no, c.doc_seq, c.fy, c.doc_date::text, ${iso('c.issued_at', 'issued_at')}, c.branch_id,
      c.invoice_id, i.doc_no AS invoice_no, c.kind, c.reason, c.taxable_value::text, c.cgst::text, c.sgst::text, c.igst::text, c.cess::text, c.round_off::text,
      c.total::text, c.refund_mode, c.refund_amount::text, c.due_reduced::text, c.store_credit_amount::text, c.balance_available::text,
      coalesce(c.customer_snapshot, i.customer_snapshot) AS customer, c.created_by, c.reversal_receipt_id,
      (SELECT count(*)::int FROM sales.document_print p WHERE p.tenant_id = c.tenant_id AND p.doc_type = 'credit_note' AND p.doc_id = c.id) AS print_count,
      (SELECT ${iso('max(p.printed_at)', 'x')} FROM sales.document_print p WHERE p.tenant_id = c.tenant_id AND p.doc_type = 'credit_note' AND p.doc_id = c.id) AS last_printed_at
    FROM sales.credit_note c JOIN sales.invoice i ON i.tenant_id = c.tenant_id AND i.id = c.invoice_id WHERE c.id = $1`, [id]);
  if (!c) fail(404, 'not_found', 'credit note');
  // Whole-line credit references use the immutable issue projection, not current masters, dues, tags or return state.
  const original = await invoiceView(c.invoice_id as string, true);
  if (!original.seller) fail(422, 'invoice_print_snapshot_missing', 'original invoice has no seller snapshot; live masters cannot repair a tax document');
  const refs = await many<Record<string, unknown>>(`SELECT invoice_line_id, taxable_value::text, cgst::text, sgst::text, igst::text,
      coalesce(cess, 0)::text AS cess, line_total::text FROM sales.credit_note_line WHERE credit_note_id = $1`, [id]);
  const originalLines = original.lines as Record<string, unknown>[];
  const lines = refs.map((x) => {
    const l = originalLines.find((row) => row.id === x.invoice_line_id);
    if (!l) fail(422, 'invoice_print_snapshot_missing', 'referenced original invoice line is missing');
    return { ...Object.fromEntries(['invoice_line_id', 'taxable_value', 'cgst', 'sgst', 'igst', 'cess', 'line_total'].map((k) =>
      [k, k === 'invoice_line_id' ? x[k] : m2(x[k] as string)])),
      line_no: l.line_no, kind: l.kind, tag_id: l.tag_id, tag_no: l.tag_no, description: l.description,
      hsn: l.hsn, tax_rate: l.tax_rate, tax_parts: l.tax_parts };
  }).sort((a, b) => Number(a.line_no) - Number(b.line_no));
  const referenced = originalLines.filter((l) => refs.some((x) => x.invoice_line_id === l.id));
  const taxMap = new Map<string, Record<string, string>>();
  for (const l of lines) for (const part of l.tax_parts as Record<string, string>[]) {
    const key = `${part.hsn_sac}|${part.rate}`;
    const row = taxMap.get(key) ?? { hsn_sac: part.hsn_sac, rate: part.rate, taxable_value: '0.00', cgst: '0.00', sgst: '0.00', igst: '0.00', cess: '0.00' };
    for (const k of ['taxable_value', 'cgst', 'sgst', 'igst', 'cess']) row[k] = m2(d(row[k]).plus(d(part[k])));
    taxMap.set(key, row);
  }
  const money = ['taxable_value', 'cgst', 'sgst', 'igst', 'cess', 'round_off', 'total', 'refund_amount', 'due_reduced', 'store_credit_amount', 'balance_available'];
  const out: Record<string, unknown> = { ...c, lines, seller: original.seller, place_of_supply: original.place_of_supply,
    gst_type: original.gst_type, supply_type: original.supply_type, gst_applicable: c.kind !== 'receipt_reversal', tax_summary: [...taxMap.values()],
    original_invoice: { id: original.id, doc_no: original.doc_no, doc_date: original.doc_date, issued_at: original.issued_at,
      seller: original.seller, customer: original.customer, place_of_supply: original.place_of_supply, gst_type: original.gst_type,
      supply_type: original.supply_type, making_gst_treatment: original.making_gst_treatment,
      invoice_total: (original.totals as Record<string, unknown>).invoice_total, lines: referenced } };
  for (const k of money) out[k] = m2(c[k] as string);
  return out;
}
export async function getCreditNote(a: SalesActor, id: string): Promise<Record<string, unknown>> {
  need(a, 'sales.invoice.view');
  const c = await one<{ branch_id: string }>(`SELECT branch_id FROM sales.credit_note WHERE id = $1`, [id]);
  if (!c) fail(404, 'not_found', 'credit note');
  needBranch(a, c.branch_id);
  return creditNoteView(id);
}
/** GET /v1/sales/credit-notes — all kinds (filter ?kind=); NOT a GST list (see gstCreditNotes). */
export async function listCreditNotes(a: SalesActor, q: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  needAny(a, ['sales.invoice.view']);
  const w: string[] = []; const p: unknown[] = [];
  const add = (sql: string, val: unknown) => { p.push(val); w.push(sql.replace(/\?/g, `$${p.length}`)); };
  const scope = branchScope(a);
  if (q.branch_id) { needBranch(a, q.branch_id); add('c.branch_id = ?', q.branch_id); } else if (scope) add('c.branch_id = ANY(?::uuid[])', [...scope]);
  if (q.kind) {
    if (!(CN_KINDS as readonly string[]).includes(q.kind)) fail(422, 'validation_failed', 'kind', [{ path: 'kind', code: 'invalid', message: CN_KINDS.join(' | ') }]);
    add('c.kind = ?', q.kind);
  }
  if (q.invoice_id) add('c.invoice_id = ?::uuid', q.invoice_id);
  if (q.customer_id) add('c.customer_id = ?::uuid', q.customer_id);
  if (q.has_store_credit === 'true') w.push('c.balance_available > 0');
  if (q.from) add('c.doc_date >= ?::date', q.from);
  if (q.to) add('c.doc_date <= ?::date', q.to);
  if (q.q) { p.push(q.q.trim()); const n = p.length;
    w.push(`(upper(c.doc_no) LIKE upper($${n}) || '%' OR upper(i.doc_no) LIKE upper($${n}) || '%' OR lower(i.customer_snapshot->>'name') LIKE lower($${n}) || '%' OR i.customer_snapshot->>'phone' = $${n})`); }
  const limit = Math.min(Math.max(Number(q.limit ?? 50) || 50, 1), 200);
  if (q.cursor) {
    const [ts, id] = Buffer.from(q.cursor, 'base64url').toString().split('|');
    if (!ts || !id) fail(422, 'validation_failed', 'bad cursor', [{ path: 'cursor', code: 'invalid', message: 'bad cursor' }]);
    p.push(ts, id); w.push(`(c.issued_at, c.id) < ($${p.length - 1}::timestamptz, $${p.length}::uuid)`);
  }
  p.push(limit + 1);
  const rows = await many<{ id: string; at: string }>(`SELECT c.id, c.issued_at::text AS at FROM sales.credit_note c JOIN sales.invoice i ON i.tenant_id = c.tenant_id AND i.id = c.invoice_id
    ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY c.issued_at DESC, c.id DESC LIMIT $${p.length}`, p);
  const more = rows.length > limit; const page = rows.slice(0, limit);
  const items = [];
  for (const r of page) items.push(await creditNoteView(r.id));
  const last = page[page.length - 1];
  return { items, next_cursor: more && last ? Buffer.from(`${last.at}|${last.id}`).toString('base64url') : null };
}
/** GST credit/debit-note register (CDN / GSTR-1 9B): tax documents only — kind receipt_reversal excluded (lead, 9 Nov 2026). */
export async function gstCreditNotes(from: string, to: string): Promise<Record<string, unknown>[]> {
  return many(`SELECT c.id, c.doc_no, c.doc_date::text, c.kind, c.invoice_id, i.doc_no AS invoice_no, i.customer_gstin, i.place_of_supply::text AS place_of_supply,
      c.taxable_value::text, c.cgst::text, c.sgst::text, c.igst::text, c.cess::text, c.total::text
    FROM sales.credit_note c JOIN sales.invoice i ON i.tenant_id = c.tenant_id AND i.id = c.invoice_id
    WHERE c.kind = ANY($3::text[]) AND c.doc_date BETWEEN $1::date AND $2::date ORDER BY c.doc_date, c.doc_no`, [from, to, [...GST_CN_KINDS]]);
}
export const isObjBody = isObj;
