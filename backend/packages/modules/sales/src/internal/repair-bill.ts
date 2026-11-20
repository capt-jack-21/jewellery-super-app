import { one, many, asWriter, audit, outbox, newId } from './db';
import { fail } from './errors';
import { type SalesActor, has, need, needBranch, needDevice } from './actor';
import { parseBill, type TenderIn } from './request';
import { ruleByCode, snapOf, cleanAddress, type Seller } from './bill';
import { allocateGapless } from './numbering';
import { checkTenders, checkAdvances, redeemAdvances } from './tenders';
import { customerPort } from './ports';
import { loadShop, roundOffTo, evenSplit } from './settings';
import { taxPart, roundOff, type Component } from './engine';
import { d, m2 } from './num';

/**
 * O9: the bill that delivers a repair. A repair charge is a SERVICE (SAC 998892 / the repair type's SAC, GST by the REPAIR_SERVICE rule):
 * one service line per repair line, no stock, no metal. Orders names the repair, its lines and charges and the money advances to apply; the
 * payer details (salesperson, payments, PAN ...) go through the normal bill parser. Same rules as issueCore: PAN above the limit, cash limit,
 * credit sale needs its permission, overpayment refused, expected_total checked, gapless number, advances drawn down in the same transaction.
 */
export interface RepairInvoiceInput {
  repair_id: string; branch_id: string; customer_id: string; advance_ids: string[]; bill: Record<string, unknown>;
  lines: { description: string; sac: string | null; amount: string }[];
}
const SERVICE = 'service' as unknown as Component;
export async function issueRepairInvoice(a: SalesActor, i: RepairInvoiceInput, day: string): Promise<{ id: string; doc_no: string; advances: { advance_id: string; amount: string }[] }> {
  need(a, 'sales.invoice.issue');
  needDevice(a);
  if (!i.lines.length) fail(422, 'validation_failed', 'nothing to bill', [{ path: 'lines', code: 'required', message: 'at least one charge' }]);
  // the bill body is validated by the normal parser; its (placeholder) goods line is ignored
  const req = parseBill({ ...i.bill, branch_id: i.branch_id, customer_id: i.customer_id, lines: [{ kind: 'tag', tag_no: 'repair' }] }, 'issue');
  const br = await one<{ id: string; company_id: string; gstin: string | null; state_code: string | null; is_active: boolean; address: Record<string, unknown> | null }>(
    `SELECT id, company_id, gstin, state_code, is_active, address FROM platform.branch WHERE id = $1`, [i.branch_id]);
  if (!br) fail(422, 'unknown_reference', 'branch_id', [{ path: 'branch_id', code: 'unknown_reference', message: 'no such branch' }]);
  if (!br.is_active) fail(422, 'inactive_master', 'branch is inactive', [{ path: 'branch_id', code: 'inactive_master', message: 'inactive' }]);
  needBranch(a, br.id);
  const co = (await one<{ id: string; legal_name: string; gstin: string | null; state_code: string; address: unknown }>(
    `SELECT id, legal_name, gstin, state_code, address FROM platform.company WHERE id = $1`, [br.company_id]))!;
  const sellerGstin = br.gstin ?? co.gstin;
  const sellerState = sellerGstin ? sellerGstin.slice(0, 2) : (br.state_code ?? co.state_code);
  const seller: Seller = { company_id: co.id, legal_name: co.legal_name, gstin: sellerGstin, state_code: sellerState, address: cleanAddress(br.address) ?? cleanAddress(co.address) };
  const shop = await loadShop();
  const step = await roundOffTo(day);
  if (shop.making_gst_treatment === 'separate' && (shop.making_service_rate === null || !evenSplit(shop.making_service_rate)))
    fail(422, 'making_service_rate_not_set', 'making is billed as a separate service but making_service_rate is not set (owner: PATCH /v1/sales/settings)');
  const row = (await customerPort().get(i.customer_id)) ?? fail(422, 'unknown_reference', 'customer_id', [{ path: 'customer_id', code: 'unknown_reference', message: 'no such customer' }]);
  if (!row.is_active) fail(422, 'inactive_master', 'customer is inactive', [{ path: 'customer_id', code: 'inactive_master', message: 'inactive' }]);
  let customer = snapOf(row);
  const supply = customer.gstin ? 'b2b' : 'b2c';
  let pos: string;
  if (supply === 'b2b') {
    pos = customer.gstin!.slice(0, 2);
    if (req.place_of_supply && req.place_of_supply !== pos) fail(422, 'place_of_supply_conflict', 'B2B place of supply is the GSTIN state', [{ path: 'place_of_supply', code: 'place_of_supply_conflict', message: `must be ${pos}` }]);
  } else pos = req.place_of_supply ?? customer.state_code ?? sellerState;
  const gst: 'intra' | 'inter' = pos === sellerState ? 'intra' : 'inter';
  const sp = await one<{ branch_id: string | null; is_active: boolean; is_salesperson: boolean }>(`SELECT branch_id, is_active, is_salesperson FROM hr.staff WHERE id = $1`, [req.salesperson_id]);
  if (!sp) fail(422, 'unknown_reference', 'salesperson_id', [{ path: 'salesperson_id', code: 'unknown_reference', message: 'no such staff' }]);
  if (!sp.is_active || !sp.is_salesperson || (sp.branch_id && sp.branch_id !== br.id))
    fail(422, 'inactive_master', 'salesperson is not eligible, inactive or of another branch', [{ path: 'salesperson_id', code: 'inactive_master', message: 'inactive or other branch' }]);
  if (req.cash_counter_id) {
    const cc = await one<{ branch_id: string; is_active: boolean }>(`SELECT branch_id, is_active FROM accounts.cash_counter WHERE id = $1`, [req.cash_counter_id]);
    if (!cc || cc.branch_id !== br.id || !cc.is_active) fail(422, 'unknown_reference', 'cash_counter_id', [{ path: 'cash_counter_id', code: 'unknown_reference', message: 'no active cash counter of this branch' }]);
  }
  const rule = (await ruleByCode('REPAIR_SERVICE', day)) ?? fail(422, 'tax_rule_missing', 'no REPAIR_SERVICE tax rule in force');
  // price: one service line per charge, tax on each (rounded per line, like the goods engine)
  const lines = i.lines.map((l, k) => {
    const taxable = d(l.amount);
    const part = taxPart(SERVICE, taxable, { ...rule, hsn_sac: l.sac ?? rule.hsn_sac }, gst, { composite: false });
    const tax = d(part.cgst).plus(d(part.sgst)).plus(d(part.igst)).plus(d(part.cess));
    return { line_no: k + 1, ...l, hsn: l.sac ?? rule.hsn_sac, taxable: m2(taxable), part, total: m2(taxable.plus(tax)) };
  });
  const sumOf = (f: (x: (typeof lines)[number]) => string) => lines.reduce((s, x) => s.plus(d(f(x))), d(0));
  const taxable = sumOf((x) => x.taxable);
  const cg = sumOf((x) => x.part.cgst), sg = sumOf((x) => x.part.sgst), ig = sumOf((x) => x.part.igst), ce = sumOf((x) => x.part.cess);
  const ro = roundOff(taxable.plus(cg).plus(sg).plus(ig).plus(ce), step);
  const total = taxable.plus(cg).plus(sg).plus(ig).plus(ce).plus(ro);
  // advances of THIS repair, oldest first, up to what is still due after the other payments
  const base = req.payments;
  const take: TenderIn[] = [];
  if (i.advance_ids.length) {
    let left = total.minus(base.reduce((s, t) => s.plus(d(t.amount)), d(0)));
    const adv = await many<{ id: string; balance: string; status: string; receipt_no: string }>(`SELECT id, balance::text, status, receipt_no FROM sales.advance WHERE id = ANY($1::uuid[]) ORDER BY receipt_no, id`, [i.advance_ids]);
    for (const x of adv) {
      if (left.lte(0)) break;
      const amt = d(x.balance).lt(left) ? d(x.balance) : left;
      if (amt.lte(0) || !['open', 'partly_redeemed'].includes(x.status)) continue;
      take.push({ mode: 'advance', advance_id: x.id, payment_mode_id: null, amount: m2(amt), reference: x.receipt_no, card_machine_id: null, cheque_date: null, bank_name: null, credit_note_id: null });
      left = left.minus(amt);
    }
  }
  const payments = [...base, ...take];
  const paid = payments.reduce((s, t) => s.plus(d(t.amount)), d(0));
  const cash = payments.filter((t) => t.mode === 'cash').reduce((s, t) => s.plus(d(t.amount)), d(0));
  const balance = total.minus(paid);
  // requirements (same as a goods bill)
  if (paid.gt(total)) fail(422, 'overpayment', `payments exceed the net payable ₹${m2(total)}`);
  const creditSale = total.gt(0) && paid.isZero();
  if (creditSale && !has(a, 'sales.invoice.credit_sale')) fail(403, 'credit_sale_not_allowed', 'an unpaid (credit) bill needs sales.invoice.credit_sale');
  const panRequired = total.gt(d(shop.pan_required_above));
  if (panRequired && !customer.pan_on_file && !req.pan) fail(422, 'pan_required', `PAN is required for bills above ₹${m2(shop.pan_required_above)}`, [{ path: 'pan', code: 'required', message: 'required' }]);
  const cashHit = cash.gte(d(shop.cash_limit_amount));
  if (cashHit && shop.cash_limit_mode === 'block') fail(422, 'cash_limit_exceeded', `cash on one bill must stay below ₹${m2(shop.cash_limit_amount)} (s.269ST)`, [{ path: 'payments', code: 'cash_limit_exceeded', message: 'over the cash limit' }]);
  if (req.expected_total !== null && m2(req.expected_total) !== m2(total)) fail(422, 'expected_total_mismatch', `server net payable is ${m2(total)}`, [{ path: 'expected_total', code: 'expected_total_mismatch', message: `server: ${m2(total)}` }]);
  const warnings: { code: string; message: string; path: string | null }[] = [];
  if (balance.gt(0)) warnings.push({ code: 'balance_due', message: `₹${m2(balance)} will remain due`, path: 'payments' });
  if (cashHit) warnings.push({ code: 'cash_limit_exceeded', message: `cash ₹${m2(cash)} on one bill is at or above ₹${m2(shop.cash_limit_amount)} (s.269ST)`, path: 'payments' });
  await checkTenders(payments, i.customer_id);
  await checkAdvances(payments, i.customer_id, null, i.repair_id);
  if (req.pan && !customer.pan_on_file) {
    await customerPort().setPan(i.customer_id, req.pan);
    customer = { ...customer, pan_on_file: true, pan_last4: req.pan.slice(-4) };
  }
  const num = await allocateGapless(i.branch_id, 'tax_invoice');
  const invId = await newId();
  const sep = shop.making_gst_treatment === 'separate' ? shop.making_service_rate : null;
  await asWriter(async (c) => {
    await c.query(`INSERT INTO sales.invoice(tenant_id, id, branch_id, company_id, fy, doc_seq, doc_no, customer_id, customer_snapshot, seller_gstin, place_of_supply,
        gst_type, salesperson_id, cash_counter_id, rate_snapshot, gross_value, discount, taxable_value, cgst, sgst, igst, round_off, invoice_total, old_metal_value,
        net_payable, paid_amount, balance_due, estimate_ids, created_by, supply_type, customer_gstin, making_gst_treatment, round_off_to, cess, zero_gst, bill_discount,
        old_gold_excess, pan_required, pan_on_file, cash_amount, warnings, credit_sale, making_service_rate, repair_id)
      VALUES (platform.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14::jsonb, $15, 0, $15, $16, $17, $18, $19, $20, 0,
        $20, $21, $22, '{}'::uuid[], $23, $24, $25, $26, $27, $28, false, 0, 0, $29, $30, $31, $32::jsonb, $33, $34, $35)`,
      [invId, i.branch_id, co.id, num.fy, num.seq, num.docNo, i.customer_id, JSON.stringify(customer), sellerGstin, pos, gst, req.salesperson_id, req.cash_counter_id,
       JSON.stringify({ rates: [], seller, tag_numbers: [], repair: { repair_id: i.repair_id } }), m2(taxable), m2(cg), m2(sg), m2(ig), m2(ro), m2(total),
       m2(paid), m2(balance), a.userId, supply, supply === 'b2b' ? customer.gstin : null, shop.making_gst_treatment, step, m2(ce),
       panRequired, customer.pan_on_file, m2(cash), JSON.stringify(warnings), creditSale, sep, i.repair_id]);
  });
  await asWriter(async (c) => {
    for (const l of lines) {
      const r = await c.query<{ id: string }>(`INSERT INTO sales.invoice_line(tenant_id, invoice_id, line_no, line_kind, description, hsn, pieces, gross_wt, net_wt, rate_per_g,
          metal_value, mc_amount, discount, taxable_value, tax_rule_id, tax_rate, hsn_sac_applied, composite_supply, cgst, sgst, igst, line_total, cess)
        VALUES (platform.current_tenant(), $1, $2, 'service', $3, $4, 1, 0, 0, 0, 0, 0, 0, $5, $6, $7, $4, false, $8, $9, $10, $11, $12) RETURNING id`,
        [invId, l.line_no, l.description, l.hsn, l.taxable, rule.id, l.part.rate, l.part.cgst, l.part.sgst, l.part.igst, l.total, l.part.cess]);
      await c.query(`INSERT INTO sales.invoice_line_tax(tenant_id, invoice_line_id, component, tax_rule_id, hsn_sac, composite_supply, taxable_value, rate, cgst_rate, sgst_rate,
          igst_rate, cess_rate, cgst, sgst, igst, cess) VALUES (platform.current_tenant(), $1, 'service', $2, $3, false, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [r.rows[0].id, rule.id, l.part.hsn_sac, l.part.taxable_value, l.part.rate, l.part.cgst_rate, l.part.sgst_rate, l.part.igst_rate, l.part.cess_rate,
         l.part.cgst, l.part.sgst, l.part.igst, l.part.cess]);
    }
    for (const [k, x] of payments.entries())
      await c.query(`INSERT INTO sales.invoice_payment(tenant_id, invoice_id, line_no, mode, reference, amount, credit_note_id, payment_mode_id, card_machine_id, cheque_date, bank_name, advance_id)
        VALUES (platform.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [invId, k + 1, x.mode, x.reference, m2(x.amount), x.credit_note_id, x.payment_mode_id, x.card_machine_id, x.cheque_date, x.bank_name, x.advance_id ?? null]);
    if (balance.gt(0))
      await c.query(`INSERT INTO sales.invoice_due(tenant_id, branch_id, invoice_id, customer_id, original_due, balance_due) VALUES (platform.current_tenant(), $1, $2, $3, $4, $4)`,
        [i.branch_id, invId, i.customer_id, m2(balance)]);
  });
  const advances = await redeemAdvances(payments, null, i.repair_id);
  await audit('sales.invoice.issue', 'sales.invoice', invId, { doc_no: num.docNo, branch_id: i.branch_id, net_payable: m2(total), paid: m2(paid), balance_due: m2(balance),
    credit_sale: creditSale, warnings: warnings.map((w) => w.code), advances, repair_id: i.repair_id, pan_captured: req.pan !== null && !row.pan_last4 });
  await outbox('sales.invoice_issued', { invoice_id: invId, doc_no: num.docNo, branch_id: i.branch_id, customer_id: i.customer_id, net_payable: m2(total), balance_due: m2(balance),
    large_discount: false, discount_pct: '0.00' });
  return { id: invId, doc_no: num.docNo, advances };
}
