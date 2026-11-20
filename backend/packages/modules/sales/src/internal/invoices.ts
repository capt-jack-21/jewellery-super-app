import { one, many, asWriter, audit, outbox, iso, newId, payStatusSql } from './db';
import { fail } from './errors';
import { type SalesActor, need, needAny, needBranch, needDevice, branchScope } from './actor';
import { parseBill, type BillReq, type TenderIn } from './request';
import { prepare, judge, computation, nowIso, type Prepared } from './bill';
import { allocateGapless } from './numbering';
import { checkTenders, checkAdvances, redeemStoreCredit, redeemAdvances, tenderRows } from './tenders';
import { customerPort, stockPort } from './ports';
import { d, m2 } from './num';

/**
 * S1–S14, S17, S21–S23: issue a GST tax invoice — the only bill-writing path (INV-2). One transaction (the request's), all or nothing:
 * gates → resolve + lock tags (Inventory) → price (engine) → requirements → number (gapless, INV-1) → header / lines / tax parts / old gold /
 * tenders as sales_writer → Inventory markSold / sellLoose / oldMetalIn → due row → estimates billed → store credit drawn down → audit + outbox.
 */
export async function preview(a: SalesActor, body: unknown, day: string): Promise<Record<string, unknown>> {
  needAny(a, ['sales.invoice.issue', 'sales.estimate.create']);
  const isObj = body && typeof body === 'object' && !Array.isArray(body);
  const mode = isObj && (body as Record<string, unknown>).mode !== undefined ? (body as Record<string, unknown>).mode : 'invoice';
  if (mode !== 'invoice' && mode !== 'estimate') fail(422, 'validation_failed', 'mode: invoice or estimate', [{ path: 'mode', code: 'invalid', message: 'invoice or estimate' }]);
  const rest = isObj ? Object.fromEntries(Object.entries(body as Record<string, unknown>).filter(([k]) => k !== 'mode')) : body;
  const req = parseBill(rest, mode === 'estimate' ? 'preview_estimate' : 'issue');
  const p = await prepare(a, req, mode === 'estimate' ? 'estimate' : 'preview', day);
  if (req.payments.length) await checkTenders(req.payments, p.customer?.customer_id ?? null);
  await judge(a, p, false);
  p.computed_at = await nowIso();
  return computation(p);
}

const INV_COLS = `i.id, i.doc_no, i.doc_seq, i.fy, i.doc_date::text, ${iso('i.issued_at', 'issued_at')}, i.status, i.branch_id, i.supply_type, i.gst_type,
  i.place_of_supply::text AS place_of_supply, i.customer_id, i.customer_snapshot, i.salesperson_id, i.cash_counter_id, i.making_gst_treatment, i.zero_gst, i.zero_gst_reason,
  i.zero_gst_print_note, i.rate_snapshot, i.old_gold_excess_payout, i.estimate_ids, ${iso('i.cancelled_at', 'cancelled_at')}, i.cancel_credit_note_id, i.warnings, i.created_by,
  i.gross_value::text, i.discount::text, i.bill_discount::text, i.taxable_value::text, i.cgst::text, i.sgst::text, i.igst::text, i.cess::text, i.round_off::text,
  i.invoice_total::text, i.old_metal_value::text, i.old_gold_excess::text, i.net_payable::text, i.cash_amount::text, i.row_rev, i.making_service_rate::text`;
interface InvRow { [k: string]: unknown; id: string; doc_no: string; status: string; branch_id: string; customer_id: string | null; net_payable: string;
  invoice_total: string; customer_snapshot: Record<string, unknown>; rate_snapshot: Record<string, unknown>; doc_date: string; fy: string; payment_status: string;
  cur_balance: string; cur_paid: string; cur_cash: string; gst_type: string; zero_gst: boolean; cancel_credit_note_id: string | null }
export async function invoiceRow(id: string, frozen = false): Promise<InvRow | undefined> {
  const balance = frozen
    ? `i.paid_amount::text AS cur_paid, i.balance_due::text AS cur_balance, CASE WHEN i.balance_due = 0 THEN 'paid' WHEN i.paid_amount = 0 THEN 'unpaid' ELSE 'part_paid' END AS payment_status, i.cash_amount::text AS cur_cash`
    : `b.paid_amount::text AS cur_paid, b.balance_due::text AS cur_balance, ${payStatusSql('b')} AS payment_status, b.cash_total::text AS cur_cash`;
  return one<InvRow>(`SELECT ${INV_COLS}, ${balance} FROM sales.invoice i ${frozen ? '' : 'JOIN sales.v_invoice_balance b ON b.tenant_id = i.tenant_id AND b.invoice_id = i.id'} WHERE i.id = $1`, [id]);
}
const pctStr = (s: string) => s;
/** Contract Invoice. */
export async function invoiceView(id: string, frozen = false): Promise<Record<string, unknown>> {
  const i = await invoiceRow(id, frozen);
  if (!i) fail(404, 'not_found', 'invoice');
  const lines = await many<Record<string, string | number | null | boolean | unknown[]>>(`SELECT l.id, l.line_no, coalesce(l.stock_kind, l.line_kind) AS kind, l.tag_id, ${frozen ? 'NULL::text AS tag_no' : 't.tag_no'}, l.item_id, l.sub_item_id, l.purity_id,
      l.description, l.purity_code, l.fineness::text, l.hsn, l.huid, l.pieces, l.gross_wt::text, l.stone_wt::text, l.net_wt::text, l.wastage_pct::text, l.wastage_wt::text,
      l.chargeable_wt::text, l.rate_id, l.rate_per_g::text, l.metal_value::text, l.mc_type, l.mc_value::text, l.mc_amount::text, l.stone_amount::text,
      l.huid_charge::text AS hallmark_charge, l.gross_value::text, l.discount::text AS line_discount, l.bill_discount_share::text, l.taxable_value::text, l.tax_rate::text,
      l.cgst::text, l.sgst::text, l.igst::text, l.cess::text, l.line_total::text, l.stones, l.counter_id, l.box_id AS tray_id, ${frozen ? 'NULL::uuid AS credit_note_id' : 'cl.credit_note_id'}
    FROM sales.invoice_line l ${frozen ? '' : 'LEFT JOIN inventory.tag t ON t.tenant_id = l.tenant_id AND t.id = l.tag_id LEFT JOIN sales.credit_note_line cl ON cl.tenant_id = l.tenant_id AND cl.invoice_line_id = l.id'}
    WHERE l.invoice_id = $1 ORDER BY l.line_no`, [id]);
  const parts = await many<Record<string, string | boolean>>(`SELECT x.invoice_line_id, x.component, x.tax_rule_id, x.hsn_sac, x.composite_supply, x.taxable_value::text,
      x.rate::text, x.cgst_rate::text, x.sgst_rate::text, x.igst_rate::text, x.cess_rate::text, x.cgst::text, x.sgst::text, x.igst::text, x.cess::text
    FROM sales.invoice_line_tax x JOIN sales.invoice_line l ON l.tenant_id = x.tenant_id AND l.id = x.invoice_line_id WHERE l.invoice_id = $1
    ORDER BY l.line_no, array_position(ARRAY['metal','making','stone','hallmark','service','other'], x.component)`, [id]);
  const old = await many<Record<string, unknown>>(`SELECT line_no, purity_id, purity_code, description, gross_wt::text, less_wt::text, net_wt::text, touch_pct::text, fine_wt::text,
      valuation_basis, rate_id, server_rate_per_g::text AS server_rate, rate_per_g::text, rate_overridden AS overridden, override_reason, amount::text
    FROM sales.invoice_old_metal WHERE invoice_id = $1 ORDER BY line_no`, [id]);
  const pays = await tenderRows('invoice_payment', 'invoice_id', id);
  const cns = frozen ? [] : await many<{ id: string }>(`SELECT id FROM sales.credit_note WHERE invoice_id = $1 ORDER BY issued_at, id`, [id]);
  const pr = frozen ? { n: 0, last: null } : await one<{ n: number; last: string | null }>(`SELECT count(*)::int AS n, ${iso('max(printed_at)', 'last')} FROM sales.document_print WHERE doc_type = 'invoice' AND doc_id = $1`, [id]);
  const snap = i.rate_snapshot ?? {};
  const tagNumbers = Array.isArray(snap.tag_numbers) ? snap.tag_numbers as { line_no: number; tag_no: string | null }[] : [];
  const pl = lines.map((l) => {
    const { line_discount, ...rest } = l as Record<string, unknown>;
    return { ...rest, ...(frozen ? { tag_no: tagNumbers.find((x) => x.line_no === l.line_no)?.tag_no ?? null } : {}), discount: m2(d(line_discount as string).plus(d(l.bill_discount_share as string))), wastage_pct: pctStr(l.wastage_pct as string),
      stones: Array.isArray(l.stones) ? l.stones : [],
      tax_parts: parts.filter((x) => x.invoice_line_id === l.id).map(({ invoice_line_id, ...x }) => { void invoice_line_id; return x; }) };
  });
  const sumMap = new Map<string, Record<string, string>>();
  for (const x of parts) {
    const k = `${x.hsn_sac}|${x.rate}`;
    const r = sumMap.get(k) ?? { hsn_sac: x.hsn_sac as string, rate: x.rate as string, taxable_value: '0.00', cgst: '0.00', sgst: '0.00', igst: '0.00', cess: '0.00' };
    for (const f of ['taxable_value', 'cgst', 'sgst', 'igst', 'cess']) r[f] = m2(d(r[f]).plus(d(x[f] as string)));
    sumMap.set(k, r);
  }
  const lineDiscount = lines.reduce((s, l) => s.plus(d(l.line_discount as string)), d(0));
  const taxTotal = d(i.cgst as string).plus(d(i.sgst as string)).plus(d(i.igst as string)).plus(d(i.cess as string));
  return {
    id: i.id, doc_no: i.doc_no, doc_seq: i.doc_seq, fy: i.fy, doc_date: i.doc_date, issued_at: i.issued_at, status: frozen ? 'issued' : i.status, branch_id: i.branch_id,
    supply_type: i.supply_type, gst_type: i.gst_type, place_of_supply: i.place_of_supply, seller: snap.seller ?? null, customer: i.customer_snapshot,
    salesperson_id: i.salesperson_id, cash_counter_id: i.cash_counter_id, making_gst_treatment: i.making_gst_treatment, zero_gst: i.zero_gst, zero_gst_reason: i.zero_gst_reason,
    rates_used: Array.isArray(snap.rates) ? snap.rates : [], lines: pl, old_metal: old, old_gold_excess_payout: i.old_gold_excess_payout,
    tax_summary: [...sumMap.values()],
    totals: { gross_value: m2(i.gross_value as string), line_discount: m2(lineDiscount), bill_discount: m2(i.bill_discount as string), taxable_value: m2(i.taxable_value as string),
      cgst: m2(i.cgst as string), sgst: m2(i.sgst as string), igst: m2(i.igst as string), cess: m2(i.cess as string), tax_total: m2(taxTotal), round_off: m2(i.round_off as string),
      invoice_total: m2(i.invoice_total), old_metal_value: m2(i.old_metal_value as string), old_gold_excess: m2(i.old_gold_excess as string), net_payable: m2(i.net_payable),
      paid_amount: m2(i.cur_paid), balance_due: m2(i.cur_balance), cash_amount: m2(i.cur_cash) },
    payments: pays.map((p) => ({ ...p, amount: m2(p.amount as string) })), payment_status: i.payment_status, estimate_ids: i.estimate_ids ?? [],
    credit_note_ids: cns.map((c) => c.id), cancelled_at: frozen ? null : i.cancelled_at, cancel_credit_note_id: frozen ? null : i.cancel_credit_note_id, print_count: pr?.n ?? 0,
    last_printed_at: pr?.last ?? null, warnings: Array.isArray(i.warnings) ? i.warnings : [], created_by: i.created_by,
  };
}
export async function getInvoice(a: SalesActor, id: string): Promise<Record<string, unknown>> {
  needAny(a, ['sales.invoice.view', 'sales.invoice.issue']);
  const i = await one<{ branch_id: string }>(`SELECT branch_id FROM sales.invoice WHERE id = $1`, [id]);
  if (!i) fail(404, 'not_found', 'invoice');
  needBranch(a, i.branch_id);
  return invoiceView(id);
}

/** Issue (the request transaction is the unit of work; idempotency is wrapped around this by the HTTP layer). */
export async function issueInvoice(a: SalesActor, body: unknown, day: string): Promise<{ id: string; doc_no: string }> {
  need(a, 'sales.invoice.issue');
  needDevice(a);
  return issueCore(a, parseBill(body, 'issue'), day);
}

/**
 * O6: the bill that delivers an order. Orders names the order, its received (reserved) tags, the locked rate and rule, and the money advances to
 * apply. The bill body (salesperson, payments for the rest, discounts, PAN ...) is validated by the normal bill parser; lines are the tags only.
 * Advances are applied oldest first, each up to its balance, up to what is still due after the other payments; the remainder stays on the advance.
 */
export interface OrderInvoiceInput {
  order_id: string; branch_id: string; customer_id: string; tag_ids: string[]; locked_rate_per_g: string | null; rate_rule: 'locked' | 'lower_of';
  advance_ids: string[]; bill: Record<string, unknown>;
}
export async function issueOrderInvoice(a: SalesActor, i: OrderInvoiceInput, day: string): Promise<{ id: string; doc_no: string; advances: { advance_id: string; amount: string }[] }> {
  need(a, 'sales.invoice.issue');
  needDevice(a);
  const req = parseBill({ ...i.bill, branch_id: i.branch_id, customer_id: i.customer_id, lines: i.tag_ids.map((tag_id) => ({ kind: 'tag', tag_id })) }, 'issue');
  req.order = { order_id: i.order_id, tag_ids: i.tag_ids, locked_rate_per_g: i.locked_rate_per_g, rate_rule: i.rate_rule };
  const base = req.payments;
  if (i.advance_ids.length) {
    // pass 1 prices the bill without advances to learn what is due; pass 2 (issueCore) prices it again with the advance payments
    const due = d((await prepare(a, req, 'issue', day)).result.totals.net_payable).minus(base.reduce((s, t) => s.plus(d(t.amount)), d(0)));
    let left = due;
    const adv = await many<{ id: string; balance: string; status: string; receipt_no: string }>(`SELECT id, balance::text, status, receipt_no FROM sales.advance WHERE id = ANY($1::uuid[]) ORDER BY receipt_no, id`, [i.advance_ids]);
    const take: TenderIn[] = [];
    for (const x of adv) {
      if (left.lte(0)) break;
      const amt = d(x.balance).lt(left) ? d(x.balance) : left;
      if (amt.lte(0) || !['open', 'partly_redeemed'].includes(x.status)) continue;
      take.push({ mode: 'advance', advance_id: x.id, payment_mode_id: null, amount: m2(amt), reference: x.receipt_no, card_machine_id: null, cheque_date: null, bank_name: null, credit_note_id: null });
      left = left.minus(amt);
    }
    req.payments = [...base, ...take];
  }
  return issueCore(a, req, day);
}

async function issueCore(a: SalesActor, req: BillReq, day: string): Promise<{ id: string; doc_no: string; advances: { advance_id: string; amount: string }[] }> {
  const p: Prepared = await prepare(a, req, 'issue', day);
  await judge(a, p, true);
  await checkTenders(req.payments, req.customer_id);
  await checkAdvances(req.payments, req.customer_id, req.order?.order_id ?? null);
  // S13 estimates → billed (validated before anything is written)
  if (req.estimates.length) {
    const es = await many<{ id: string; version: number; status: string; branch_id: string; customer_id: string | null; expired: boolean }>(
      `SELECT id, version, status, branch_id, customer_id, (valid_until IS NOT NULL AND valid_until < now()) AS expired FROM sales.estimate
        WHERE id = ANY($1::uuid[]) ORDER BY id`, [req.estimates.map((e) => e.id)]);
    // lock after the plain read: FOR UPDATE applies the edit_until_closed UPDATE policy and so skips closed estimates (409, not 404)
    const locked = await many<{ id: string; version: number }>(`SELECT id, version FROM sales.estimate WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
      [req.estimates.map((e) => e.id)]);
    for (const e of es) if (e.status === 'draft' && !locked.some((l) => l.id === e.id && l.version === e.version)) e.status = 'closed meanwhile';
    if (new Set(es.map((e) => e.customer_id)).size > 1)
      fail(422, 'validation_failed', 'merged estimates must have the same customer', [{ path: 'estimates', code: 'invalid', message: 'different customers' }]);
    for (const [k, ref] of req.estimates.entries()) {
      const e = es.find((x) => x.id === ref.id);
      if (!e) fail(404, 'not_found', `estimate ${ref.id}`);
      if (e.status !== 'draft' || e.expired) fail(409, 'estimate_not_open', `estimate ${ref.id} is ${e.expired && e.status === 'draft' ? 'expired' : e.status}`);
      if (e.version !== ref.version) fail(412, 'version_mismatch', `estimate ${ref.id} is now version ${e.version}`);
      if (e.branch_id !== req.branch_id) fail(422, 'validation_failed', 'estimate of another branch', [{ path: `estimates[${k}].id`, code: 'invalid', message: 'other branch' }]);
      if (e.customer_id && e.customer_id !== req.customer_id)
        fail(422, 'validation_failed', 'estimate of another customer', [{ path: `estimates[${k}].id`, code: 'invalid', message: 'other customer' }]);
    }
  }
  // S1 quick-add through Masters; S10 PAN sealed on the customer by Masters (never logged / audited)
  let customer = p.customer!; let customerId = req.customer_id;
  if (!customerId && req.customer) {
    const c = await customerPort().quickAdd({ ...req.customer, address: req.customer.address, home_branch_id: req.branch_id });
    customerId = c.id; customer = { ...customer, customer_id: c.id };
  }
  if (req.pan && !customer.pan_on_file) {
    await customerPort().setPan(customerId!, req.pan);
    customer = { ...customer, pan_on_file: true, pan_last4: req.pan.slice(-4) };
  }
  const t = p.result.totals; const f = p.result.flags;
  const num = await allocateGapless(req.branch_id, 'tax_invoice');
  const invId = await newId();
  const excess = d(t.old_gold_excess).gt(0);
  const paid = d(t.paid_amount); const balance = d(t.net_payable).minus(paid);
  await asWriter(async (c) => {
    await c.query(`INSERT INTO sales.invoice(tenant_id, id, branch_id, company_id, fy, doc_seq, doc_no, customer_id, customer_snapshot, seller_gstin, place_of_supply,
        gst_type, salesperson_id, cash_counter_id, rate_snapshot, gross_value, discount, taxable_value, cgst, sgst, igst, round_off, invoice_total, old_metal_value,
        net_payable, paid_amount, balance_due, estimate_ids, created_by, supply_type, customer_gstin, making_gst_treatment, round_off_to, cess, zero_gst, zero_gst_reason,
        zero_gst_print_note, bill_discount, discount_reason, old_gold_excess, old_gold_excess_payout, pan_required, pan_on_file, cash_amount, warnings, credit_sale,
        making_service_rate, order_id)
      VALUES (platform.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14::jsonb, $15, $16, $17, $18, $19, $20, $21, $22, $23,
        $24, $25, $26, $27::uuid[], $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38, $39, $40, $41, $42, $43, $44::jsonb, $45, $46, $47)`,
      [invId, req.branch_id, p.branch.company_id, num.fy, num.seq, num.docNo, customerId, JSON.stringify(customer), p.seller.gstin, p.place_of_supply,
       p.gst_type, req.salesperson_id, req.cash_counter_id, JSON.stringify({ rates: p.rates_used, seller: p.seller, tag_numbers: p.result.lines.map((l) => ({ line_no: l.line_no, tag_no: l.tag_no })), making_floors: p.result.lines.map((l) => ({ line_no: l.line_no, item_id: l.item_id, min_mc: p.making_floors[l.line_no - 1] })), ...(p.order_rate ? { order: p.order_rate } : {}) }), t.gross_value,
       m2(d(t.line_discount).plus(d(t.bill_discount))), t.taxable_value, t.cgst, t.sgst, t.igst, t.round_off, t.invoice_total, t.old_metal_value,
       t.net_payable, m2(paid), m2(balance), req.estimates.map((e) => e.id), a.userId, p.supply_type, p.supply_type === 'b2b' ? customer.gstin : null,
       p.shop.making_gst_treatment, p.roundOff, t.cess, req.zero_gst !== null, req.zero_gst?.reason ?? null, req.zero_gst ? p.shop.zero_gst_print_note : null,
       t.bill_discount, req.discount_reason, t.old_gold_excess, excess ? req.old_gold_excess_payout : null, f.pan_required, customer.pan_on_file,
       t.cash_amount, JSON.stringify(p.warnings), f.credit_sale, p.shop.making_gst_treatment === 'separate' ? p.shop.making_service_rate : null, req.order?.order_id ?? null]);
  });
  // stock through Inventory (S14 / S23 / S6), same transaction
  const ctx = { branchId: req.branch_id, userId: a.userId, sourceType: 'invoice', sourceId: invId, reservedTagIds: req.order?.tag_ids };
  const tagIds = p.result.lines.filter((l) => l.tag_id).map((l) => l.tag_id!);
  if (tagIds.length) await stockPort().markSold(tagIds, ctx);
  const loose = p.result.lines.filter((l) => l.kind === 'loose');
  if (loose.length) await stockPort().sellLoose(loose.map((l) => ({ item_id: l.item_id, purity_id: l.purity_id, counter_id: l.counter_id, box_id: l.tray_id,
    pieces: l.pieces, gross_wt: l.gross_wt, net_wt: l.net_wt })), ctx);
  const refs = p.result.old_metal.length ? await stockPort().oldMetalIn(p.result.old_metal.map((o) => ({ purity_id: o.purity_id, gross_wt: o.gross_wt, net_wt: o.net_wt })), ctx) : [];
  await asWriter(async (c) => {
    for (const l of p.result.lines) {
      const r = await c.query<{ id: string }>(`INSERT INTO sales.invoice_line(tenant_id, invoice_id, line_no, line_kind, tag_id, item_id, sub_item_id, description, purity_code, fineness,
          hsn, huid, pieces, gross_wt, stone_wt, net_wt, rate_id, rate_per_g, wastage_pct, wastage_wt, metal_value, mc_type, mc_value, mc_amount, stone_amount, huid_charge,
          discount, taxable_value, tax_rule_id, tax_rate, hsn_sac_applied, composite_supply, cgst, sgst, igst, line_total, stones, stock_kind, purity_id, counter_id, box_id,
          chargeable_wt, gross_value, bill_discount_share, cess)
        VALUES (platform.current_tenant(), $1, $2, 'goods', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26,
          $27, $28, $29, $30, $31, $32, $33, $34, $35::jsonb, $36, $37, $38, $39, $40, $41, $42, $43) RETURNING id`,
        [invId, l.line_no, l.tag_id, l.item_id, l.sub_item_id, l.description, l.purity_code, l.fineness, l.hsn, l.huid, l.pieces, l.gross_wt, l.stone_wt, l.net_wt,
         l.rate_id, l.rate_per_g, l.wastage_pct, l.wastage_wt, l.metal_value, l.mc_type, l.mc_value, l.mc_amount, l.stone_amount, l.hallmark_charge, l._line_discount,
         l.taxable_value, l._tax_rule_id, l.tax_rate, l._hsn_sac_applied, l._composite, l.cgst, l.sgst, l.igst, l.line_total, JSON.stringify(l.stones), l.kind,
         l.purity_id, l.counter_id, l.tray_id, l.chargeable_wt, l.gross_value, l.bill_discount_share, l.cess]);
      for (const x of l.tax_parts)
        await c.query(`INSERT INTO sales.invoice_line_tax(tenant_id, invoice_line_id, component, tax_rule_id, hsn_sac, composite_supply, taxable_value, rate, cgst_rate, sgst_rate,
            igst_rate, cess_rate, cgst, sgst, igst, cess) VALUES (platform.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          [r.rows[0].id, x.component, x.tax_rule_id, x.hsn_sac, x.composite_supply, x.taxable_value, x.rate, x.cgst_rate, x.sgst_rate, x.igst_rate, x.cess_rate,
           x.cgst, x.sgst, x.igst, x.cess]);
    }
    for (const [k, o] of p.result.old_metal.entries())
      await c.query(`INSERT INTO sales.invoice_old_metal(tenant_id, invoice_id, line_no, purity_id, purity_code, description, gross_wt, less_wt, net_wt, touch_pct, fine_wt,
          rate_id, rate_per_g, amount, valuation_basis, server_rate_per_g, override_rate_per_g, override_reason, overridden_by, inventory_ref_id)
        VALUES (platform.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
        [invId, o.line_no, o.purity_id, o.purity_code, o.description, o.gross_wt, o.less_wt, o.net_wt, o.touch_pct, o.fine_wt, o.rate_id, o.rate_per_g, o.amount,
         o.valuation_basis, o.server_rate, o.overridden ? o.rate_per_g : null, o.overridden ? o.override_reason : null, o.overridden ? a.userId : null, refs[k]]);
    for (const [k, x] of req.payments.entries())
      await c.query(`INSERT INTO sales.invoice_payment(tenant_id, invoice_id, line_no, mode, reference, amount, credit_note_id, payment_mode_id, card_machine_id, cheque_date, bank_name, advance_id)
        VALUES (platform.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [invId, k + 1, x.mode, x.reference, m2(x.amount), x.credit_note_id, x.payment_mode_id, x.card_machine_id, x.cheque_date, x.bank_name, x.advance_id ?? null]);
    if (balance.gt(0))
      await c.query(`INSERT INTO sales.invoice_due(tenant_id, branch_id, invoice_id, customer_id, original_due, balance_due) VALUES (platform.current_tenant(), $1, $2, $3, $4, $4)`,
        [req.branch_id, invId, customerId, m2(balance)]);
    for (const e of req.estimates) {
      const r = await c.query(`UPDATE sales.estimate SET status = 'billed', invoice_id = $2, updated_by = $3, updated_at = now() WHERE id = $1 AND status = 'draft'`, [e.id, invId, a.userId]);
      if (r.rowCount !== 1) fail(409, 'estimate_not_open', `estimate ${e.id} is not open`);
    }
  });
  const redeemed = await redeemStoreCredit(req.payments);
  const advances = await redeemAdvances(req.payments, req.order?.order_id ?? null);
  // audit (no PAN, no Aadhaar) + outbox
  await audit('sales.invoice.issue', 'sales.invoice', invId, { doc_no: num.docNo, branch_id: req.branch_id, net_payable: t.net_payable, paid: m2(paid),
    balance_due: m2(balance), credit_sale: f.credit_sale, warnings: p.warnings.map((w) => w.code), store_credit: redeemed, advances, order_id: req.order?.order_id ?? null, pan_captured: req.pan !== null && !p.customer!.pan_on_file });
  if (req.zero_gst) await audit('sales.invoice.zero_gst', 'sales.invoice', invId, { doc_no: num.docNo, reason: req.zero_gst.reason });
  for (const o of p.result.old_metal.filter((x) => x.overridden))
    await audit('sales.old_gold.rate_override', 'sales.invoice', invId, { doc_no: num.docNo, line_no: o.line_no, server_rate: o.server_rate, applied_rate: o.rate_per_g, reason: o.override_reason });
  if (f.override_min_needed) await audit('sales.price.override_min', 'sales.invoice', invId, { doc_no: num.docNo, discount_pct: f.discount_pct, reason: req.discount_reason, paths: f.below_minimum });
  await outbox('sales.invoice_issued', { invoice_id: invId, doc_no: num.docNo, branch_id: req.branch_id, customer_id: customerId, net_payable: t.net_payable,
    balance_due: m2(balance), large_discount: f.large_discount, discount_pct: f.discount_pct });
  return { id: invId, doc_no: num.docNo, advances };
}

/** S20 list. */
export async function listInvoices(a: SalesActor, q: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  needAny(a, ['sales.invoice.view']);
  const w: string[] = []; const p: unknown[] = [];
  const add = (sql: string, v: unknown) => { p.push(v); w.push(sql.replace(/\?/g, `$${p.length}`)); };
  const scope = branchScope(a);
  if (q.branch_id) { needBranch(a, q.branch_id); add('v.branch_id = ?', q.branch_id); } else if (scope) add('v.branch_id = ANY(?::uuid[])', [...scope]);
  if (q.doc_no) add('v.doc_no = ?', q.doc_no);
  if (q.q) {
    const s = q.q.trim();
    p.push(s); const n = p.length;
    w.push(`(upper(v.doc_no) LIKE upper($${n}) || '%' OR lower(v.customer_name) LIKE lower($${n}) || '%' OR v.customer_phone = $${n}
      OR EXISTS (SELECT 1 FROM sales.invoice_line l LEFT JOIN inventory.tag t ON t.tenant_id = l.tenant_id AND t.id = l.tag_id
                 WHERE l.tenant_id = v.tenant_id AND l.invoice_id = v.invoice_id AND (t.tag_no = $${n} OR upper(l.huid) = upper($${n}))))`);
  }
  if (q.from) add('v.doc_date >= ?::date', q.from);
  if (q.to) add('v.doc_date <= ?::date', q.to);
  if (q.customer_id) add('v.customer_id = ?', q.customer_id);
  if (q.salesperson_id) add('v.salesperson_id = ?', q.salesperson_id);
  if (q.status) add('v.status = ?', q.status);
  if (q.payment_status) add(`${payStatusSql('v')} = ?`, q.payment_status);
  if (q.supply_type) add('v.supply_type = ?', q.supply_type);
  if (q.tag_id) add('EXISTS (SELECT 1 FROM sales.invoice_line l WHERE l.tenant_id = v.tenant_id AND l.invoice_id = v.invoice_id AND l.tag_id = ?::uuid)', q.tag_id);
  if (q.tag_no) add(`EXISTS (SELECT 1 FROM sales.invoice_line l JOIN inventory.tag t ON t.tenant_id = l.tenant_id AND t.id = l.tag_id
                      WHERE l.tenant_id = v.tenant_id AND l.invoice_id = v.invoice_id AND t.tag_no = ?)`, q.tag_no);
  const limit = Math.min(Math.max(Number(q.limit ?? 50) || 50, 1), 200);
  if (q.cursor) {
    const [ts, id] = Buffer.from(q.cursor, 'base64url').toString().split('|');
    if (!ts || !id) fail(422, 'validation_failed', 'bad cursor', [{ path: 'cursor', code: 'invalid', message: 'bad cursor' }]);
    p.push(ts, id); w.push(`(v.issued_at, v.invoice_id) < ($${p.length - 1}::timestamptz, $${p.length}::uuid)`);
  }
  p.push(limit + 1);
  const rows = await many<Record<string, unknown> & { invoice_id: string; issued_at_raw: string }>(`SELECT v.invoice_id AS id, v.doc_no, v.doc_date::text, ${iso('v.issued_at', 'issued_at')},
      v.issued_at::text AS issued_at_raw, v.branch_id, v.status, ${payStatusSql('v')} AS payment_status, v.supply_type, v.customer_id, coalesce(v.customer_name, '') AS customer_name, v.customer_phone,
      v.salesperson_id, v.line_count, i.taxable_value::text, (i.cgst + i.sgst + i.igst + i.cess)::text AS tax_total, v.invoice_total::text, v.net_payable::text,
      v.paid_amount::text, v.balance_due::text
    FROM sales.v_invoice_list v JOIN sales.invoice i ON i.tenant_id = v.tenant_id AND i.id = v.invoice_id
    ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY v.issued_at DESC, v.invoice_id DESC LIMIT $${p.length}`, p);
  const more = rows.length > limit; const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items: items.map(({ issued_at_raw, ...r }) => { void issued_at_raw;
      return { ...r, customer_phone: r.customer_phone && /^[6-9]\d{9}$/.test(r.customer_phone as string) ? r.customer_phone : null,
        tax_total: m2(r.tax_total as string), taxable_value: m2(r.taxable_value as string), invoice_total: m2(r.invoice_total as string), net_payable: m2(r.net_payable as string),
        paid_amount: m2(r.paid_amount as string), balance_due: m2(r.balance_due as string) }; }),
    next_cursor: more && last ? Buffer.from(`${last.issued_at_raw}|${String(last.id)}`).toString('base64url') : null };
}

/** S12 read-only series view. */
export async function docSeries(a: SalesActor, q: { branch_id?: string; fy?: string }): Promise<Record<string, unknown>[]> {
  needAny(a, ['sales.invoice.view']);
  if (q.branch_id) needBranch(a, q.branch_id);
  const scope = branchScope(a);
  const rows = await many<{ branch_id: string; doc_type: string; fy: string; prefix: string; next_no: number }>(`SELECT branch_id, doc_type, fy, prefix, next_no FROM sales.doc_series
      WHERE ($1::uuid IS NULL OR branch_id = $1) AND ($2::text IS NULL OR fy = $2) AND ($3::uuid[] IS NULL OR branch_id = ANY($3)) ORDER BY branch_id, doc_type, fy`,
    [q.branch_id ?? null, q.fy ?? null, scope ? [...scope] : null]);
  const out: Record<string, unknown>[] = [];
  for (const r of rows) {
    const tbl = r.doc_type === 'tax_invoice' ? 'sales.invoice' : 'sales.credit_note';
    const last = await one<{ doc_no: string; at: string }>(`SELECT doc_no, ${iso('issued_at', 'at')} FROM ${tbl} WHERE branch_id = $1 AND fy = $2 AND doc_seq = $3`, [r.branch_id, r.fy, r.next_no - 1]);
    out.push({ ...r, last_issued_no: last?.doc_no ?? null, last_issued_at: last?.at ?? null });
  }
  return out;
}
