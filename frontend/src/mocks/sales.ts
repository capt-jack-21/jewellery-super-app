/**
 * MSW mock of the Sales 0.9.1 read / pricing surface for the dev server (VITE_API_MOCKS=true): settings, readiness, sellable,
 * preview, bill / estimate / credit-note lists and details, payments, print documents and the inventory stock summary. Issue /
 * cancel / return writes are not modelled here (the INV-1 issue mock in handlers.ts stays). Money math mirrors the contract
 * (decimal strings, 3% jewellery GST split CGST/SGST intra-state, IGST otherwise; B2B place of supply = GSTIN state). All data fictional.
 */
import { http, HttpResponse, type JsonBodyType } from 'msw';
import type {
  BillComputation, CreditNote, CustomerSnapshot, Estimate, Invoice, PreviewBillRequest, PricedLine, PricedOldGold, SalesSettings, Tender,
} from '@/lib/api/backend/model';
import { D } from '@/lib/format/decimal';
import { BRANCH_ID, COMPANY_ID, db } from './db';
import { mastersRows } from './masters';

const A = '*/api';
type R = Parameters<Parameters<typeof http.get>[1]>[0];
type Dec = ReturnType<typeof D>;
const HOME_STATE = '33';
const m2 = (x: Dec) => x.toDecimalPlaces(2).toFixed(2);
const w3 = (x: Dec) => x.toDecimalPlaces(3).toFixed(3);
const sid = (n: number) => `01940000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const problem = (status: number, code: string, title: string) =>
  HttpResponse.json({ type: 'about:blank', title, status, code }, { status, headers: { 'Content-Type': 'application/problem+json' } });
const json = (b: unknown, status = 200) => HttpResponse.json(b as JsonBodyType, { status });
const authed = (fn: (r: R) => Response | Promise<Response> | undefined) => (r: R) => (db().session ? fn(r) : problem(401, 'unauthenticated', 'Sign in required'));
const istNow = () => new Date(Date.now() + 5.5 * 36e5);
const today = () => istNow().toISOString().slice(0, 10);
const at = (minsAgo: number) => new Date(Date.now() - minsAgo * 6e4).toISOString();

let savedSettings: SalesSettings | null = null;
export const mockSalesSettings = (): SalesSettings => savedSettings ?? ({
  version: 0, old_gold_enabled: true, estimate_no_format: 'EST-{BRANCH}-{FY}-{SEQ:5}', receipt_no_format: 'RCT-{BRANCH}-{FY}-{SEQ:5}',
  making_gst_treatment: 'composite', making_tax_rule_code: 'GOLD_JEWELLERY', making_service_rate: null, old_gold_valuation_basis: 'stated_purity', old_gold_excess_handling: 'refund_on_bill',
  return_window_days: 7, return_settlement_default: 'store_credit', credit_note_rounding: 'follow_invoice', round_off_to: '1.00', pan_required_above: '200000.00',
  cash_limit_amount: '200000.00', cash_limit_mode: 'block', discount_max_pct: '10', large_discount_pct: '5', default_paper: 'A4', print_language: 'en', print_numerals: 'latin',
  zero_gst_print_note: '', estimate_validity_days: 1,
} as SalesSettings);

/* ------------------------------------------------------------------ pricing ------------------------------------------------------------------ */
const purity = (id: string) => db().purities.find((p) => p.id === id);
function rate(purityId: string, kind: 'sale' | 'old_metal') {
  const rows = db().rates.filter((r) => r.purity_id === purityId && r.kind === kind).sort((a, b) => b.effective_from.localeCompare(a.effective_from));
  return rows[0] ?? null;
}
const items = () => mastersRows('items') as unknown as Array<{ id: string; name: string; hsn?: string | null; mc_type?: string | null; mc_value?: string | null }>;

function tax(taxable: Dec, inter: boolean) {
  const half = taxable.mul('0.015').toDecimalPlaces(2);
  return inter ? { cgst: D('0'), sgst: D('0'), igst: taxable.mul('0.03').toDecimalPlaces(2) } : { cgst: half, sgst: half, igst: D('0') };
}
interface Basis { line_no: number; kind: 'tag' | 'loose'; tag_id: string | null; tag_no: string | null; item_id: string; description: string; purity_id: string; huid: string | null;
  pieces: number; gross: Dec; stone: Dec; net: Dec; wastage_pct: Dec; mc_type: string; mc_value: Dec; discount: Dec; counter_id: string | null; tray_id: string | null }
function priceLine(b: Basis, share: Dec, inter: boolean): PricedLine | string {
  const p = purity(b.purity_id); const r = rate(b.purity_id, 'sale');
  if (!p) return 'invalid_purity'; if (!r) return 'rate_missing';
  const wastage = b.net.mul(b.wastage_pct).div(100); const charge = b.net.add(wastage);
  const metal = charge.mul(D(r.rate_per_g)).toDecimalPlaces(2);
  const mc = (b.mc_type === 'per_gram' ? b.net.mul(b.mc_value) : b.mc_value).toDecimalPlaces(2);
  const gross = metal.add(mc); const taxable = gross.sub(b.discount).sub(share); const t = tax(taxable, inter);
  return {
    line_no: b.line_no, kind: b.kind, tag_id: b.tag_id, tag_no: b.tag_no, item_id: b.item_id, sub_item_id: null, purity_id: b.purity_id, description: b.description, purity_code: p.code,
    fineness: p.fineness, hsn: '7113', huid: b.huid, pieces: b.pieces, gross_wt: w3(b.gross), stone_wt: w3(b.stone), net_wt: w3(b.net), wastage_pct: b.wastage_pct.toString(), wastage_wt: w3(wastage),
    chargeable_wt: w3(charge), rate_id: r.id, rate_per_g: r.rate_per_g, metal_value: m2(metal), mc_type: b.mc_type, mc_value: b.mc_value.toString(), mc_amount: m2(mc), stone_amount: '0.00',
    hallmark_charge: '0.00', gross_value: m2(gross), discount: m2(b.discount), bill_discount_share: m2(share), taxable_value: m2(taxable), tax_rate: '3',
    cgst: m2(t.cgst), sgst: m2(t.sgst), igst: m2(t.igst), cess: '0.00', line_total: m2(taxable.add(t.cgst).add(t.sgst).add(t.igst)),
    tax_parts: [{ component: 'metal', tax_rule_id: 'mock-gold', hsn_sac: '7113', composite_supply: true, taxable_value: m2(taxable), rate: '3', cgst_rate: inter ? '0' : '1.5', sgst_rate: inter ? '0' : '1.5', igst_rate: inter ? '3' : '0', cess_rate: '0',
      cgst: m2(t.cgst), sgst: m2(t.sgst), igst: m2(t.igst), cess: '0.00' }],
    stones: [], counter_id: b.counter_id, tray_id: b.tray_id,
  } as unknown as PricedLine;
}
function tagBasis(tagId: string | undefined, tagNo: string | undefined, line_no: number, discount?: string): Basis | string {
  const t = db().tags.find((x) => (tagId && x.id === tagId) || (tagNo && x.tag_no.toUpperCase() === tagNo.toUpperCase()));
  if (!t) return 'tag_not_found';
  if (t.status !== 'in_stock') return 'tag_not_sellable';
  const name = (purity(t.purity_id)?.metal_id === db().metals[1]?.id) ? 'Silver anklet' : 'Necklace';
  const x = t as unknown as { mc_type?: string; mc_value?: string; wastage_pct?: string };
  return { line_no, kind: 'tag', tag_id: t.id, tag_no: t.tag_no, item_id: 'mock-item', description: name, purity_id: t.purity_id, huid: t.huid ?? null, pieces: 1,
    gross: D(t.gross_wt), stone: D(t.stone_wt ?? '0'), net: D(t.net_wt), wastage_pct: D(x.wastage_pct ?? '0'), mc_type: x.mc_type ?? 'per_gram', mc_value: D(x.mc_value ?? '0'),
    discount: D(discount ?? '0'), counter_id: null, tray_id: null };
}
function customerOf(req: { customer_id?: string; customer?: { name: string; phone?: string; gstin?: string; state_code?: string } }): CustomerSnapshot | null {
  if (req.customer_id) {
    const c = (mastersRows('customers') as unknown as Array<{ id: string; name: string; phone?: string; gstin?: string | null; state_code?: string | null; pan_last4?: string | null }>).find((x) => x.id === req.customer_id);
    if (!c) return null;
    return { customer_id: c.id, name: c.name, phone: c.phone ?? null, gstin: c.gstin ?? null, state_code: c.state_code ?? c.gstin?.slice(0, 2) ?? HOME_STATE, address: null, pan_on_file: !!c.pan_last4, pan_last4: c.pan_last4 ?? null } as CustomerSnapshot;
  }
  if (req.customer) return { customer_id: null, name: req.customer.name, phone: req.customer.phone ?? null, gstin: req.customer.gstin ?? null, state_code: req.customer.state_code ?? req.customer.gstin?.slice(0, 2) ?? HOME_STATE, address: null, pan_on_file: false, pan_last4: null } as CustomerSnapshot;
  return null;
}

type Req = PreviewBillRequest & { place_of_supply?: string; pan?: string };
/** POST /preview (and the seeds): the full server computation, or a problem code. */
export function compute(req: Req): BillComputation | string {
  const s = mockSalesSettings();
  const customer = customerOf(req as never);
  const b2b = !!customer?.gstin;
  if (b2b && req.place_of_supply && req.place_of_supply !== customer?.gstin?.slice(0, 2)) return 'place_of_supply_conflict';
  const pos = b2b ? (customer?.gstin?.slice(0, 2) ?? HOME_STATE) : (req.place_of_supply ?? customer?.state_code ?? HOME_STATE);
  const inter = pos !== HOME_STATE;
  const bases: Basis[] = [];
  for (const [i, raw] of req.lines.entries()) {
    const l = raw as unknown as Record<string, string | number | null | undefined>;
    if (l.kind === 'loose') {
      const it = items().find((x) => x.id === l.item_id);
      bases.push({ line_no: i + 1, kind: 'loose', tag_id: null, tag_no: null, item_id: String(l.item_id), description: String(l.description ?? it?.name ?? 'Loose'), purity_id: String(l.purity_id), huid: null,
        pieces: Number(l.pieces ?? 1), gross: D(String(l.gross_wt)), stone: D(String(l.stone_wt ?? '0')), net: D(String(l.net_wt)), wastage_pct: D('8'), mc_type: 'per_gram', mc_value: D(it?.mc_value ?? '450'),
        discount: D(String(l.discount ?? '0')), counter_id: (l.counter_id as string) ?? null, tray_id: (l.tray_id as string) ?? null });
    } else {
      const b = tagBasis(l.tag_id as string | undefined, l.tag_no as string | undefined, i + 1, l.discount as string | undefined);
      if (typeof b === 'string') return b;
      bases.push(b);
    }
  }
  // bill discount shared pro rata on gross value
  const pre = bases.map((b) => priceLine(b, D('0'), inter));
  const bad = pre.find((p) => typeof p === 'string'); if (bad) return bad as string;
  const preLines = pre as PricedLine[];
  const grossAll = preLines.reduce((a, l) => a.add(D(l.gross_value)), D('0'));
  const billDisc = D(req.bill_discount ?? '0');
  // Paisa by largest fractional remainder; stable ties to the first line (0.9.2).
  const weights = preLines.map((l) => D(l.taxable_value));
  const weightSum = weights.reduce((a, v) => a.add(v), D('0'));
  const exactShares = weights.map((v) => weightSum.gt(0) ? billDisc.mul(100).mul(v).div(weightSum) : D('0'));
  const shares = exactShares.map((v) => v.floor());
  const remainder = billDisc.mul(100).sub(shares.reduce((a, v) => a.add(v), D('0'))).toNumber();
  const order = exactShares.map((v, i) => ({ i, f: v.sub(v.floor()) })).sort((a, b) => b.f.cmp(a.f) || a.i - b.i);
  for (let i = 0; i < remainder && i < order.length; i++) { const j = order[i]?.i; if (j != null) shares[j] = (shares[j] ?? D('0')).add(1); }
  const lines = bases.map((b, i) => (billDisc.gt(0) && grossAll.gt(0) ? priceLine(b, (shares[i] ?? D('0')).div(100), inter) : preLines[i])) as PricedLine[];
  const old: PricedOldGold[] = [];
  for (const [i, o] of (req.old_metal ?? []).entries()) {
    const p = purity(o.purity_id); const r = rate(o.purity_id, 'old_metal') ?? rate(o.purity_id, 'sale'); if (!p || !r) return 'rate_missing';
    const net = D(o.gross_wt).sub(D(o.less_wt ?? '0')); const applied = o.rate_override ?? r.rate_per_g;
    old.push({ line_no: i + 1, purity_id: p.id, purity_code: p.code, description: o.description ?? null, gross_wt: w3(D(o.gross_wt)), less_wt: w3(D(o.less_wt ?? '0')), net_wt: w3(net),
      touch_pct: o.touch_pct ?? D(p.fineness).div(10).toString(), fine_wt: w3(net.mul(D(p.fineness)).div(1000)), valuation_basis: 'stated_purity', rate_id: r.id, server_rate: r.rate_per_g, rate_per_g: applied,
      overridden: !!o.rate_override, override_reason: o.override_reason ?? null, amount: m2(net.mul(D(applied))) } as unknown as PricedOldGold);
  }
  const sum = (k: keyof PricedLine) => lines.reduce((a, l) => a.add(D(String(l[k]))), D('0'));
  const taxable = sum('taxable_value'); const cgst = sum('cgst'); const sgst = sum('sgst'); const igst = sum('igst');
  const exact = taxable.add(cgst).add(sgst).add(igst); const total = exact.toDecimalPlaces(0);
  const oldValue = old.reduce((a, o) => a.add(D(o.amount)), D('0'));
  const excess = oldValue.gt(total) ? oldValue.sub(total) : D('0');
  const net = total.sub(oldValue).gt(0) ? total.sub(oldValue) : D('0');
  const pays = req.payments ?? [];
  const paid = pays.reduce((a, p) => a.add(D(p.amount)), D('0'));
  const cash = pays.filter((p) => p.mode === 'cash').reduce((a, p) => a.add(D(p.amount)), D('0'));
  const lineDisc = sum('discount');
  const discPct = sum('gross_value').gt(0) ? lineDisc.add(billDisc).mul(100).div(sum('gross_value')) : D('0');
  const panRequired = net.gt(D(s.pan_required_above)) && !customer?.pan_on_file;
  const warnings = discPct.gt(D(s.large_discount_pct)) ? [{ code: 'large_discount', message: 'Large discount', path: null }] : [];
  return {
    branch_id: req.branch_id, supply_type: b2b ? 'b2b' : 'b2c', gst_type: inter ? 'inter' : 'intra', place_of_supply: pos,
    seller: { company_id: COMPANY_ID, legal_name: 'Demo Jewellers Private Limited', gstin: '33AABCD1234E1Z5', state_code: HOME_STATE, address: { line1: '12 Bazaar Street', city: 'Chennai', pincode: '600017' } },
    customer, making_gst_treatment: 'composite', zero_gst: false, rates_used: [], lines, old_metal: old,
    tax_summary: [{ hsn_sac: '7113', rate: '3', taxable_value: m2(taxable), cgst: m2(cgst), sgst: m2(sgst), igst: m2(igst), cess: '0.00' }],
    totals: {
      gross_value: m2(sum('gross_value')), line_discount: m2(lineDisc), bill_discount: m2(billDisc), taxable_value: m2(taxable), cgst: m2(cgst), sgst: m2(sgst), igst: m2(igst), cess: '0.00',
      tax_total: m2(cgst.add(sgst).add(igst)), round_off: m2(total.sub(exact)), invoice_total: m2(total), old_metal_value: m2(oldValue), old_gold_excess: m2(excess), net_payable: m2(net),
      paid_amount: m2(paid), balance_due: m2(net.sub(paid).gt(0) ? net.sub(paid) : D('0')), cash_amount: m2(cash),
    },
    requirements: {
      pan_required: panRequired && !req.pan, pan_on_file: !!customer?.pan_on_file,
      cash_limit: { limit: s.cash_limit_amount, mode: s.cash_limit_mode, cash_amount: m2(cash), exceeded: cash.gte(D(s.cash_limit_amount)) },
      discount_permission: lineDisc.add(billDisc).gt(0), override_min_permission: discPct.gt(D(s.discount_max_pct)), zero_gst_permission: false,
      credit_sale_permission: net.gt(0) && paid.eq(0), old_gold_rate_override_permission: old.some((o) => o.overridden),
    },
    warnings, computed_at: new Date().toISOString(),
  } as unknown as BillComputation;
}

/* ------------------------------------------------------------------ seeded documents ------------------------------------------------------------------ */
interface Store { invoices: Invoice[]; estimates: Estimate[]; creditNotes: CreditNote[]; prints: Record<string, Array<Record<string, unknown>>> }
let S: Store | null = null;
// Response-only frozen mock projections; seeded/demo records are unchanged.
const printSnapshots = new Map<string, unknown>();
const salesperson = () => (mastersRows('staff') as unknown as Array<{ id: string }>)[0]?.id ?? sid(900);
const firstCustomer = () => (mastersRows('customers') as unknown as Array<{ id: string }>)[0]?.id;

function tenders(ps: Array<{ mode: Tender['mode']; amount: string; reference?: string }>): Tender[] {
  return ps.map((p, i) => ({ line_no: i + 1, mode: p.mode, payment_mode_id: null, amount: p.amount, reference: p.reference ?? null, card_machine_id: null, cheque_date: null, bank_name: null, credit_note_id: null }));
}
function makeInvoice(n: number, raw: Req, extra: Partial<Invoice> & { minsAgo: number }): Invoice | null {
  // A tender amount of 'rest' takes whatever is left to pay (seeds stay balanced when rates change).
  const first = compute({ ...raw, payments: [] }); if (typeof first === 'string') return null;
  const fixed = (raw.payments ?? []).filter((p) => p.amount !== 'rest').reduce((a, p) => a.add(D(p.amount)), D('0'));
  const req = { ...raw, payments: (raw.payments ?? []).map((p) => (p.amount === 'rest' ? { ...p, amount: m2(D(first.totals.net_payable).sub(fixed)) } : p)) };
  const c = compute(req); if (typeof c === 'string') return null;
  const { minsAgo, ...over } = extra;
  const paid = D(c.totals.paid_amount); const net = D(c.totals.net_payable);
  const fy = '2026-27';
  return {
    ...c, id: sid(100 + n), doc_no: `TN/${fy}/${String(n).padStart(6, '0')}`, doc_seq: n, fy, doc_date: new Date(Date.now() - minsAgo * 6e4 + 5.5 * 36e5).toISOString().slice(0, 10), issued_at: at(minsAgo),
    status: 'issued', salesperson_id: req.salesperson_id, cash_counter_id: null, zero_gst_reason: null,
    lines: c.lines.map((l, i) => ({ ...l, id: sid(1000 + n * 10 + i), credit_note_id: null })), old_gold_excess_payout: null,
    payments: tenders((req.payments ?? []) as never), payment_status: paid.gte(net) ? 'paid' : paid.gt(0) ? 'part_paid' : 'unpaid', estimate_ids: [], credit_note_ids: [],
    cancelled_at: null, cancel_credit_note_id: null, print_count: 0, last_printed_at: null, created_by: db().users[0]?.id ?? 'u', ...over,
  } as unknown as Invoice;
}
function seedSales(): Store {
  const sp = salesperson(); const cust = firstCustomer();
  const p22 = db().purities.find((p) => p.code === '22K')?.id ?? '';
  const base = { branch_id: BRANCH_ID, salesperson_id: sp } as const;
  const inv: Invoice[] = [];
  // 1: two loose lines (one discounted), old gold, split payment (cash + UPI + card)
  const loose = items()[0]?.id;
  const one = makeInvoice(41, { ...base, customer_id: cust, lines: [{ kind: 'loose', item_id: loose, purity_id: p22, gross_wt: '8.200', stone_wt: '0.000', net_wt: '8.200', pieces: 1, description: 'Plain bangle' }, { kind: 'loose', item_id: loose, purity_id: p22, gross_wt: '4.150', net_wt: '4.100', pieces: 2, description: 'Ear studs (pair)', discount: '1500.00' }] as never,
    old_metal: [{ purity_id: p22, gross_wt: '6.500', less_wt: '0.300', description: 'Old chain' }], payments: [{ mode: 'cash', amount: '40000.00' }, { mode: 'upi', amount: '30000.00', reference: 'UPI 4417 2210' }, { mode: 'debit_card', amount: 'rest', reference: 'Card 8821' }] } as never, { minsAgo: 35 });
  if (one) inv.push(one);
  const two = makeInvoice(40, { ...base, customer: { name: 'Meena Traders', phone: '9000000014', gstin: '29ABCDE1234F1Z5' }, lines: [{ kind: 'loose', item_id: loose, purity_id: p22, gross_wt: '20.000', net_wt: '20.000', pieces: 1, description: 'Coin set' }] as never, payments: [{ mode: 'bank_transfer', amount: 'rest', reference: 'NEFT 7781' }] } as never, { minsAgo: 140 });
  if (two) inv.push(two);
  const three = makeInvoice(39, { ...base, customer: { name: 'Walk-in', phone: '9000000015' }, lines: [{ kind: 'loose', item_id: loose, purity_id: p22, gross_wt: '2.050', net_wt: '2.050', pieces: 1, description: 'Ring' }] as never, payments: [{ mode: 'cash', amount: 'rest' }] } as never, { minsAgo: 60 * 26 });
  if (three) inv.push({ ...three, status: 'cancelled', cancelled_at: at(60 * 25), cancel_credit_note_id: sid(301) } as Invoice);
  const four = makeInvoice(38, { ...base, customer_id: cust, lines: [{ kind: 'loose', item_id: loose, purity_id: p22, gross_wt: '5.000', net_wt: '5.000', pieces: 1, description: 'Pendant' }] as never, payments: [] } as never, { minsAgo: 60 * 30 });
  if (four) inv.push(four);
  const cns: CreditNote[] = [];
  if (three) {
    cns.push({ id: sid(301), doc_no: 'CN/2026-27/000007', doc_seq: 7, fy: '2026-27', doc_date: three.doc_date, issued_at: at(60 * 25), branch_id: BRANCH_ID, invoice_id: three.id, invoice_no: three.doc_no,
      kind: 'cancellation', reason: 'Billed to the wrong customer', lines: three.lines.map((l) => ({ invoice_line_id: l.id, line_no: l.line_no, kind: l.kind, tag_id: l.tag_id, tag_no: l.tag_no, description: l.description,
        taxable_value: l.taxable_value, cgst: l.cgst, sgst: l.sgst, igst: l.igst, cess: l.cess, line_total: l.line_total })),
      taxable_value: three.totals.taxable_value, cgst: three.totals.cgst, sgst: three.totals.sgst, igst: three.totals.igst, cess: '0.00', round_off: three.totals.round_off, total: three.totals.invoice_total,
      refund_mode: 'cash', refund_amount: three.totals.invoice_total, due_reduced: '0.00', store_credit_amount: '0.00', balance_available: '0.00', customer: three.customer, created_by: three.created_by, print_count: 1, last_printed_at: at(60 * 24), reversal_receipt_id: null } as unknown as CreditNote);
  }
  const est = (n: number, req: Req, status: Estimate['status'], minsAgo: number): Estimate | null => {
    const c = compute(req); if (typeof c === 'string') return null;
    return { id: sid(500 + n), estimate_no: `EST/MAIN/${today().replace(/-/g, '')}/${String(n).padStart(3, '0')}`, branch_id: BRANCH_ID, estimate_date: today(), valid_until: `${today()}T18:29:59Z`, status,
      customer_id: req.customer_id ?? null, salesperson_id: req.salesperson_id, request: req, computation: c, invoice_id: status === 'billed' ? inv[0]?.id ?? null : null, notes: null,
      print_count: 0, last_printed_at: null, created_by: db().users[0]?.id ?? 'u', created_at: at(minsAgo), version: 1 } as unknown as Estimate;
  };
  const ests = [
    est(3, { ...base, customer_id: cust, lines: [{ kind: 'loose', item_id: loose, purity_id: p22, gross_wt: '12.400', net_wt: '12.100', pieces: 1, description: 'Haram (short)' }] as never, old_metal: [{ purity_id: p22, gross_wt: '3.000' }] } as never, 'draft', 20),
    est(2, { ...base, customer: { name: 'Priya K', phone: '9000000016' }, lines: [{ kind: 'loose', item_id: loose, purity_id: p22, gross_wt: '3.300', net_wt: '3.300', pieces: 2, description: 'Ear rings' }] as never } as never, 'billed', 90),
    est(1, { ...base, lines: [{ kind: 'loose', item_id: loose, purity_id: p22, gross_wt: '1.000', net_wt: '1.000', pieces: 1, description: 'Nose pin' }] as never } as never, 'cancelled', 200),
  ].filter((x): x is Estimate => !!x);
  return { invoices: inv, estimates: ests, creditNotes: cns, prints: {} };
}
const store = () => (S ??= seedSales());
/** Test hook: drop the seeded documents (re-seeded lazily). */
export function resetSalesMock() { S = null; savedSettings = null; printSnapshots.clear(); }

const summary = (i: Invoice) => ({
  id: i.id, doc_no: i.doc_no, doc_date: i.doc_date, issued_at: i.issued_at, branch_id: i.branch_id, status: i.status, payment_status: i.payment_status, supply_type: i.supply_type,
  customer_id: i.customer?.customer_id ?? null, customer_name: i.customer?.name ?? '', customer_phone: i.customer?.phone ?? null, salesperson_id: i.salesperson_id, line_count: i.lines.length,
  taxable_value: i.totals.taxable_value, tax_total: i.totals.tax_total, invoice_total: i.totals.invoice_total, net_payable: i.totals.net_payable, paid_amount: i.totals.paid_amount, balance_due: i.totals.balance_due,
});
const q = (r: R) => new URL(r.request.url).searchParams;
const WORDS = 'Rupees (amount in words is written by the server)';

function printDoc(type: 'invoice' | 'estimate' | 'credit_note', doc: unknown, id: string, no: string, body: Record<string, string | undefined>) {
  const log = (store().prints[id] ??= []);
  const count = (doc as { print_count?: number }).print_count ?? log.length;
  const cancelled = type === 'invoice' && (doc as { status?: string }).status === 'cancelled';
  const first = log[0];
  const language = body.language ?? first?.language ?? mockSalesSettings().print_language;
  if (!count && !cancelled && body.copy === 'duplicate') return problem(422, 'first_print_duplicate_not_supported', 'First print must be original');
  if (language !== 'en' && language !== 'ta') return problem(422, 'print_language_not_supported', 'English or Tamil only');
  const duplicate = count > 0 || cancelled || body.copy === 'duplicate';
  if (duplicate && ((body.reprint_reason?.trim().length ?? 0) < 3 || (body.reprint_reason?.trim().length ?? 0) > 200)) return problem(422, 'reprint_reason_required', 'Reason required');
  const template = first ? db().templates.find((t) => t.id === first.template_id && t.version === first.template_version && t.doc_type === type) : count ? undefined : db().templates.find((t) => t.doc_type === type && t.is_active);
  if (!template) return problem(422, count ? 'pinned_print_template_unavailable' : 'print_template_not_configured', 'No trustworthy pinned template');
  const saved = printSnapshots.get(id);
  if (count && !saved) return problem(422, 'print_snapshot_unavailable', 'Legacy projection is unavailable');
  const snapshot = saved ?? structuredClone(doc);
  if (type === 'credit_note' && !(snapshot as CreditNote).original_invoice) return problem(422, 'print_snapshot_unavailable', 'Legacy credit-note snapshot is unavailable');
  printSnapshots.set(id, snapshot);
  const entry = { print_no: count + 1, copy: duplicate ? 'duplicate' : 'original', doc_cancelled: cancelled,
    printed_at: new Date().toISOString(), printed_by: db().users[0]?.id ?? 'u', paper: body.paper ?? 'A4', language, locale: `${language}-IN`, template_id: template.id,
    numerals: body.numerals ?? first?.numerals ?? mockSalesSettings().print_numerals, template_version: template.version, reprint_reason: body.reprint_reason ?? null };
  log.push(entry);
  return { doc_type: type, doc_id: id, doc_no: no, copy: entry.copy, doc_cancelled: cancelled,
    stamp: cancelled ? 'CANCELLED' : duplicate ? 'DUPLICATE' : type === 'estimate' ? 'ESTIMATE' : null,
    print_no: entry.print_no, printed_at: entry.printed_at, printed_by: entry.printed_by, paper: entry.paper,
    language: entry.language, locale: entry.locale, numerals: entry.numerals, template_id: entry.template_id, template_version: entry.template_version, template_repinned: false, repinned_from: null, template_fallback_from: null, amount_in_words: WORDS, notes: cancelled ? [`Cancelled by credit note ${store().creditNotes.find((n) => n.id === (doc as Invoice).cancel_credit_note_id)?.doc_no ?? ''}`] : [], snapshot, document: doc };
}

export const salesHandlers = [
  http.get(`${A}/v1/sales/settings`, authed(() => HttpResponse.json(mockSalesSettings() as unknown as JsonBodyType, { headers: { ETag: `"${mockSalesSettings().version}"` } }))),
  http.patch(`${A}/v1/sales/settings`, authed(async (r) => {
    const u = db().users.find((x) => x.id === db().session?.user_id);
    if (!u?.roles.some((x) => x.role === 'owner')) return problem(403, 'forbidden', 'Owner only');
    const current = mockSalesSettings(); const match = r.request.headers.get('If-Match');
    if (!match) return problem(428, 'precondition_required', 'If-Match required');
    if (match !== `"${current.version}"`) return problem(412, 'version_mismatch', 'Settings changed');
    const patch = await r.request.json() as Partial<SalesSettings>;
    savedSettings = { ...current, ...patch, version: current.version + 1 };
    return HttpResponse.json(savedSettings as unknown as JsonBodyType, { headers: { ETag: `"${savedSettings.version}"` } });
  })),
  http.get(`${A}/v1/sales/readiness`, authed((r) => json({ branch_id: q(r).get('branch_id') ?? BRANCH_ID, ready: true, checked_at: new Date().toISOString(),
    gates: ['device_approved', 'todays_rates', 'onboarding_gst', 'onboarding_gst_rates', 'invoice_series', 'making_service_rate'].map((code) => ({ code, ok: true, detail: null, setting_key: code === 'making_service_rate' ? 'making_service_rate' : null, settings_path: code === 'making_service_rate' ? '/v1/sales/settings' : null })) }))),
  http.get(`${A}/v1/sales/sellable/:code`, authed((r) => {
    const b = tagBasis(undefined, decodeURIComponent(String(r.params.code)), 1);
    if (typeof b === 'string') return problem(b === 'tag_not_found' ? 404 : 409, b, b);
    const t = db().tags.find((x) => x.id === b.tag_id);
    const line = priceLine(b, D('0'), false); if (typeof line === 'string') return problem(422, line, line);
    return json({ tag_id: b.tag_id, tag_no: b.tag_no, status: 'in_stock', branch_id: t?.branch_id ?? BRANCH_ID, line, warnings: [] });
  })),
  http.post(`${A}/v1/sales/preview`, authed(async (r) => {
    const c = compute(await r.request.json() as Req);
    return typeof c === 'string' ? problem(c === 'place_of_supply_conflict' ? 422 : 409, c, c) : json(c);
  })),
  http.get(`${A}/v1/sales/invoices`, authed((r) => {
    const p = q(r); const text = (p.get('q') ?? '').toLowerCase();
    const rows = store().invoices.filter((i) => (!p.get('status') || i.status === p.get('status')) && (!p.get('payment_status') || i.payment_status === p.get('payment_status'))
      && (!p.get('supply_type') || i.supply_type === p.get('supply_type')) && (!p.get('from') || i.doc_date >= (p.get('from') ?? '')) && (!p.get('to') || i.doc_date <= (p.get('to') ?? ''))
      && (!text || i.doc_no.toLowerCase().includes(text) || (i.customer?.name ?? '').toLowerCase().includes(text) || (i.customer?.phone ?? '').includes(text)));
    return json({ items: rows.sort((a, b) => b.issued_at.localeCompare(a.issued_at)).map(summary), next_cursor: null });
  })),
  // Unknown ids fall through to the INV-1 handler in handlers.ts (bills issued in this session).
  http.get(`${A}/v1/sales/invoices/:id`, authed((r) => { const i = store().invoices.find((x) => x.id === r.params.id); return i ? json(i) : undefined; })),
  http.get(`${A}/v1/sales/invoices/:id/payments`, authed((r) => {
    const i = store().invoices.find((x) => x.id === r.params.id); if (!i) return problem(404, 'not_found', 'Not found');
    return json({ invoice_id: i.id, net_payable: i.totals.net_payable, at_issue: i.payments, receipts: [], refunds: [], paid_amount: i.totals.paid_amount, balance_due: i.totals.balance_due, payment_status: i.payment_status });
  })),
  http.get(`${A}/v1/sales/invoices/:id/prints`, authed((r) => json(store().prints[String(r.params.id)] ?? []))),
  http.post(`${A}/v1/sales/invoices/:id/prints`, authed(async (r) => {
    const i = store().invoices.find((x) => x.id === r.params.id); if (!i) return problem(404, 'not_found', 'Not found');
    const d = printDoc('invoice', i, i.id, i.doc_no, await r.request.json() as Record<string, string>); if (d instanceof Response) return d; i.print_count = d.print_no; i.last_printed_at = d.printed_at; return json(d, 201);
  })),
  http.get(`${A}/v1/sales/estimates`, authed((r) => {
    const st = q(r).get('status');
    return json({ items: store().estimates.filter((e) => !st || e.status === st).map((e) => ({ id: e.id, estimate_no: e.estimate_no, branch_id: e.branch_id, estimate_date: e.estimate_date, valid_until: e.valid_until, status: e.status,
      customer_id: e.customer_id, customer_name: e.computation.customer?.name ?? null, net_payable: e.computation.totals.net_payable, invoice_id: e.invoice_id, version: e.version })), next_cursor: null });
  })),
  http.get(`${A}/v1/sales/estimates/:id`, authed((r) => { const e = store().estimates.find((x) => x.id === r.params.id); return e ? json(e) : problem(404, 'not_found', 'Not found'); })),
  http.post(`${A}/v1/sales/estimates/:id/prints`, authed(async (r) => {
    const e = store().estimates.find((x) => x.id === r.params.id); if (!e) return problem(404, 'not_found', 'Not found');
    const body = await r.request.json() as Record<string, string>;
    if (e.print_count && (body.reprint_reason?.trim().length ?? 0) < 3) return problem(422, 'reprint_reason_required', 'Reason required');
    const d = printDoc('estimate', e, e.id, e.estimate_no, body); if (d instanceof Response) return d; e.print_count = d.print_no; e.last_printed_at = d.printed_at;
    return json(d, 200);
  })),
  http.get(`${A}/v1/sales/credit-notes`, authed((r) => json({ items: store().creditNotes.filter((c) => !q(r).get('kind') || c.kind === q(r).get('kind')), next_cursor: null }))),
  http.get(`${A}/v1/sales/credit-notes/:id`, authed((r) => { const c = store().creditNotes.find((x) => x.id === r.params.id); return c ? json(c) : problem(404, 'not_found', 'Not found'); })),
  http.post(`${A}/v1/sales/credit-notes/:id/prints`, authed(async (r) => {
    const c = store().creditNotes.find((x) => x.id === r.params.id); if (!c) return problem(404, 'not_found', 'Not found');
    const body = await r.request.json() as Record<string, string>;
    if (c.print_count && (body.reprint_reason?.trim().length ?? 0) < 3) return problem(422, 'reprint_reason_required', 'Reason required');
    const d = printDoc('credit_note', c, c.id, c.doc_no, body); if (d instanceof Response) return d; c.print_count = d.print_no; c.last_printed_at = d.printed_at;
    return json(d, 200);
  })),
  http.get(`${A}/v1/inventory/stock-summary`, authed(() => {
    const live = db().tags.filter((t) => t.status === 'in_stock');
    const add = (k: 'gross_wt' | 'net_wt') => w3(live.reduce((a, t) => a.add(D(t[k])), D('0')));
    const row = { tag_count: live.length, tag_pieces: live.length, tag_gross_wt: add('gross_wt'), tag_net_wt: add('net_wt'), loose_pieces: 14, loose_gross_wt: '182.450', loose_net_wt: '179.900', fine_wt: '168.215' };
    return json({ group_by: 'status', as_of: new Date().toISOString(), rows: [{ ...row, status: 'in_stock' }], totals: row });
  })),
];
