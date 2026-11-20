import { V, RX, isObj, type Obj } from './validate';
import { fail } from './errors';

/** Parsed bill request (IssueInvoiceRequest for issue / preview, EstimateRequest for estimates). Amounts stay decimal strings. */
export interface TagLineIn { kind: 'tag'; tag_id?: string; tag_no?: string; wastage_pct?: string; mc_value?: string; discount?: string }
export interface LooseLineIn {
  kind: 'loose'; item_id: string; sub_item_id: string | null; purity_id: string; counter_id: string | null; tray_id: string | null; pieces: number;
  gross_wt: string; stone_wt: string; net_wt: string; huid: string | null; description?: string; wastage_pct?: string; mc_type?: 'per_gram' | 'percent' | 'flat' | 'per_piece';
  mc_value?: string; stone_amount?: string; hallmark_charge?: string; discount?: string;
}
export type LineIn = TagLineIn | LooseLineIn;
export interface OldIn { purity_id: string; description: string | null; gross_wt: string; less_wt: string; touch_pct?: string; rate_override: string | null; override_reason: string | null }
export const TENDER_MODES = ['cash', 'upi', 'debit_card', 'credit_card', 'bank_transfer', 'cheque', 'credit_note'] as const;
/** 'advance' is internal: only the order-delivery path (issueOrderInvoice) builds it; parseTender never accepts it from a client. */
export interface TenderIn {
  mode: (typeof TENDER_MODES)[number] | 'advance'; advance_id?: string | null; payment_mode_id: string | null; amount: string; reference: string | null; card_machine_id: string | null;
  cheque_date: string | null; bank_name: string | null; credit_note_id: string | null;
}
export interface QuickAdd { name: string; phone: string; gstin: string | null; state_code: string | null; address: Obj | null }
/** Set only by issueOrderInvoice (never parsed from a client body): the order this bill delivers and its rate rule. */
export interface OrderBill { order_id: string; tag_ids: string[]; locked_rate_per_g: string | null; rate_rule: 'locked' | 'lower_of' }
export interface BillReq {
  order?: OrderBill | null;
  branch_id: string; customer_id: string | null; customer: QuickAdd | null; place_of_supply: string | null; salesperson_id: string | null;
  cash_counter_id: string | null; estimates: { id: string; version: number }[]; lines: LineIn[]; bill_discount: string; discount_reason: string | null;
  old_metal: OldIn[]; old_gold_excess_payout: 'cash' | 'bank_transfer' | null; payments: TenderIn[]; pan: string | null;
  zero_gst: { reason: string } | null; expected_total: string | null; valid_until: string | null; notes: string | null;
}
const ISSUE_KEYS = ['branch_id', 'customer_id', 'customer', 'place_of_supply', 'salesperson_id', 'cash_counter_id', 'estimates', 'lines', 'bill_discount',
  'discount_reason', 'old_metal', 'old_gold_excess_payout', 'payments', 'pan', 'zero_gst', 'expected_total'];
const ESTIMATE_KEYS = ['branch_id', 'customer_id', 'place_of_supply', 'salesperson_id', 'lines', 'bill_discount', 'discount_reason', 'old_metal', 'valid_until', 'notes'];
const TAG_KEYS = ['kind', 'tag_id', 'tag_no', 'wastage_pct', 'mc_value', 'discount'];
const LOOSE_KEYS = ['kind', 'item_id', 'sub_item_id', 'purity_id', 'counter_id', 'tray_id', 'pieces', 'gross_wt', 'stone_wt', 'net_wt', 'huid', 'description',
  'wastage_pct', 'mc_type', 'mc_value', 'stone_amount', 'hallmark_charge', 'discount'];
const OLD_KEYS = ['purity_id', 'description', 'gross_wt', 'less_wt', 'touch_pct', 'rate_override', 'override_reason'];
export const TENDER_KEYS = ['mode', 'payment_mode_id', 'amount', 'reference', 'card_machine_id', 'cheque_date', 'bank_name', 'credit_note_id'];
const u = <T>(x: T | null | undefined): T | undefined => (x === null ? undefined : x);
/** Money "12" / "12.5" → "12.00" style is NOT applied here: the engine formats. */

export function parseTender(v: V, t: unknown, path: string): TenderIn {
  const o = v.obj(t, path, TENDER_KEYS, ['mode', 'amount']);
  const mode = v.oneOf(o.mode, `${path}.mode`, TENDER_MODES) ?? 'cash';
  const r: TenderIn = { mode, payment_mode_id: v.uuid(o.payment_mode_id, `${path}.payment_mode_id`, { optional: true }) ?? null,
    amount: v.dec(o.amount, `${path}.amount`, RX.money, { positive: true }) ?? '0', reference: v.str(o.reference, `${path}.reference`, { optional: true, max: 60, trim: true }) ?? null,
    card_machine_id: v.uuid(o.card_machine_id, `${path}.card_machine_id`, { optional: true }) ?? null, cheque_date: v.date(o.cheque_date, `${path}.cheque_date`, { optional: true }) ?? null,
    bank_name: v.str(o.bank_name, `${path}.bank_name`, { optional: true, max: 80, trim: true }) ?? null,
    credit_note_id: v.uuid(o.credit_note_id, `${path}.credit_note_id`, { optional: true }) ?? null };
  if (mode === 'credit_note' && !r.credit_note_id) v.err(`${path}.credit_note_id`, 'required for mode credit_note', 'required');
  if (mode !== 'credit_note' && r.credit_note_id) v.err(`${path}.credit_note_id`, 'only for mode credit_note');
  if (mode !== 'cheque' && r.cheque_date) v.err(`${path}.cheque_date`, 'only for mode cheque');
  return r;
}
export function parseBill(body: unknown, kindIn: 'issue' | 'estimate' | 'preview_estimate'): BillReq {
  const pe = kindIn === 'preview_estimate';
  const kind: 'issue' | 'estimate' = pe ? 'issue' : kindIn;
  if (kind === 'issue' && isObj(body)) {
    // INV-1 / D29: numbers and dates are server-assigned (checked before anything else)
    for (const k of ['doc_no', 'doc_seq', 'number', 'fy', 'invoice_no']) if (k in body) fail(422, 'client_supplied_doc_number', `${k} is assigned by the server`, [{ path: k, code: 'client_supplied_doc_number', message: 'server-assigned' }]);
    for (const k of ['doc_date', 'issued_at', 'date']) if (k in body) fail(422, 'client_supplied_doc_date', `${k} is assigned by the server`, [{ path: k, code: 'client_supplied_doc_date', message: 'server-assigned' }]);
  }
  const v = new V();
  // 0.9.2 preview mode estimate: the issue body, customer and salesperson optional
  const b = v.obj(body, '', kind === 'estimate' ? ESTIMATE_KEYS : ISSUE_KEYS, kind === 'issue' && !pe ? ['branch_id', 'salesperson_id', 'lines'] : ['branch_id', 'lines']);
  const lines: LineIn[] = v.arr(b.lines, 'lines', { min: 1, max: 200 }).map((x, i) => {
    const p = `lines[${i}]`;
    const k = isObj(x) ? x.kind : undefined;
    if (k === 'tag') {
      const o = v.obj(x, p, TAG_KEYS, ['kind']);
      const tagId = v.uuid(o.tag_id, `${p}.tag_id`, { optional: true }); const tagNo = v.str(o.tag_no, `${p}.tag_no`, { optional: true, min: 1, max: 64, trim: true });
      if ((tagId === undefined) === (tagNo === undefined)) v.err(p, 'exactly one of tag_id / tag_no', 'one_of');
      return { kind: 'tag', tag_id: u(tagId), tag_no: u(tagNo), wastage_pct: u(v.dec(o.wastage_pct, `${p}.wastage_pct`, RX.pct, { optional: true, max: '100' })),
        mc_value: u(v.dec(o.mc_value, `${p}.mc_value`, RX.dec, { optional: true })), discount: u(v.dec(o.discount, `${p}.discount`, RX.money, { optional: true })) };
    }
    if (k === 'loose') {
      const o = v.obj(x, p, LOOSE_KEYS, ['kind', 'item_id', 'purity_id', 'gross_wt', 'net_wt']);
      const huid = v.str(o.huid, `${p}.huid`, { optional: true, nullable: true, rx: RX.huid });
      return { kind: 'loose', item_id: v.uuid(o.item_id, `${p}.item_id`) ?? '', sub_item_id: v.uuid(o.sub_item_id, `${p}.sub_item_id`, { optional: true, nullable: true }) ?? null,
        purity_id: v.uuid(o.purity_id, `${p}.purity_id`) ?? '', counter_id: v.uuid(o.counter_id, `${p}.counter_id`, { optional: true, nullable: true }) ?? null,
        tray_id: v.uuid(o.tray_id, `${p}.tray_id`, { optional: true, nullable: true }) ?? null, pieces: v.int(o.pieces, `${p}.pieces`, { optional: true, min: 0, max: 100000 }) ?? 0,
        gross_wt: v.dec(o.gross_wt, `${p}.gross_wt`, RX.weight, { positive: true }) ?? '0', stone_wt: v.dec(o.stone_wt, `${p}.stone_wt`, RX.weight, { optional: true }) ?? '0',
        net_wt: v.dec(o.net_wt, `${p}.net_wt`, RX.weight) ?? '0', huid: huid ? huid.toUpperCase() : null,
        description: u(v.str(o.description, `${p}.description`, { optional: true, max: 200, trim: true })),
        wastage_pct: u(v.dec(o.wastage_pct, `${p}.wastage_pct`, RX.pct, { optional: true, max: '100' })),
        mc_type: u(v.oneOf(o.mc_type, `${p}.mc_type`, ['per_gram', 'percent', 'flat', 'per_piece'] as const, { optional: true })),
        mc_value: u(v.dec(o.mc_value, `${p}.mc_value`, RX.dec, { optional: true })), stone_amount: u(v.dec(o.stone_amount, `${p}.stone_amount`, RX.money, { optional: true })),
        hallmark_charge: u(v.dec(o.hallmark_charge, `${p}.hallmark_charge`, RX.money, { optional: true })), discount: u(v.dec(o.discount, `${p}.discount`, RX.money, { optional: true })) };
    }
    v.err(`${p}.kind`, "kind must be 'tag' or 'loose'");
    return { kind: 'tag' } as TagLineIn;
  });
  const old: OldIn[] = v.arr(b.old_metal, 'old_metal', { optional: true, max: 20 }).map((x, i) => {
    const p = `old_metal[${i}]`;
    const o = v.obj(x, p, OLD_KEYS, ['purity_id', 'gross_wt']);
    const ro = v.dec(o.rate_override, `${p}.rate_override`, RX.rate, { optional: true, positive: true }) ?? null;
    const rr = v.str(o.override_reason, `${p}.override_reason`, { optional: true, trim: true, min: 5, max: 200 }) ?? null;
    if ((ro === null) !== (rr === null)) v.err(ro === null ? `${p}.rate_override` : `${p}.override_reason`, 'rate_override and override_reason go together', 'dependent_required');
    return { purity_id: v.uuid(o.purity_id, `${p}.purity_id`) ?? '', description: v.str(o.description, `${p}.description`, { optional: true, max: 200, trim: true }) ?? null,
      gross_wt: v.dec(o.gross_wt, `${p}.gross_wt`, RX.weight, { positive: true }) ?? '0', less_wt: v.dec(o.less_wt, `${p}.less_wt`, RX.weight, { optional: true }) ?? '0',
      touch_pct: u(v.dec(o.touch_pct, `${p}.touch_pct`, RX.pct, { optional: true, max: '100', positive: true })), rate_override: ro, override_reason: rr };
  });
  let customer: QuickAdd | null = null;
  if (kind === 'issue' && b.customer !== undefined) {
    const o = v.obj(b.customer, 'customer', ['name', 'phone', 'gstin', 'state_code', 'address'], ['name', 'phone']);
    const ph = v.str(o.phone, 'customer.phone', { min: 10, max: 20 });
    const phone = typeof ph === 'string' ? ph.replace(/[\s-]/g, '').replace(/^\+?91(?=\d{10}$)/, '') : '';
    if (ph !== undefined && !/^[6-9]\d{9}$/.test(phone)) v.err('customer.phone', '10-digit Indian mobile');
    const g = v.str(o.gstin, 'customer.gstin', { optional: true, nullable: true });
    const gstin = g ? g.toUpperCase() : null;
    if (gstin && !RX.gstin.test(gstin)) v.err('customer.gstin', 'invalid GSTIN');
    let addr: Obj | null = null;
    if (o.address !== undefined && o.address !== null) addr = v.obj(o.address, 'customer.address', ['line1', 'line2', 'city', 'district', 'pincode']);
    customer = { name: v.str(o.name, 'customer.name', { trim: true, min: 1, max: 200 }) ?? '', phone, gstin,
      state_code: v.str(o.state_code, 'customer.state_code', { optional: true, nullable: true, rx: RX.state }) ?? null, address: addr };
  }
  const customerId = v.uuid(b.customer_id, 'customer_id', { optional: true, nullable: kind === 'estimate' || pe }) ?? null;
  if (kind === 'issue' && (pe ? customerId !== null && customer !== null : (customerId === null) === (customer === null))) v.err('customer_id', 'exactly one of customer_id / customer', 'one_of');
  const estimates = kind === 'issue' ? v.arr(b.estimates, 'estimates', { optional: true, min: 1, max: 10 }).map((x, i) => {
    const o = v.obj(x, `estimates[${i}]`, ['id', 'version'], ['id', 'version']);
    return { id: v.uuid(o.id, `estimates[${i}].id`) ?? '', version: v.int(o.version, `estimates[${i}].version`, { min: 1 }) ?? 0 };
  }) : [];
  if (new Set(estimates.map((e) => e.id)).size !== estimates.length) v.err('estimates', 'the same estimate twice');
  const payments = kind === 'issue' ? v.arr(b.payments, 'payments', { optional: true, max: 10 }).map((x, i) => parseTender(v, x, `payments[${i}]`)) : [];
  let zero: { reason: string } | null = null;
  if (kind === 'issue' && b.zero_gst !== undefined) {
    const o = v.obj(b.zero_gst, 'zero_gst', ['reason'], ['reason']);
    zero = { reason: v.str(o.reason, 'zero_gst.reason', { trim: true, min: 5, max: 200 }) ?? '' };
  }
  const pan = kind === 'issue' ? v.str(b.pan, 'pan', { optional: true, trim: true }) : undefined;
  const panU = pan ? pan.toUpperCase() : null;
  if (panU && !RX.pan.test(panU)) v.err('pan', 'invalid PAN (AAAAA9999A)');
  const req: BillReq = {
    branch_id: v.uuid(b.branch_id, 'branch_id') ?? '', customer_id: customerId, customer, place_of_supply: v.str(b.place_of_supply, 'place_of_supply', { optional: true, rx: RX.state }) ?? null,
    salesperson_id: v.uuid(b.salesperson_id, 'salesperson_id', { optional: kind === 'estimate' || pe, nullable: kind === 'estimate' || pe }) ?? null,
    cash_counter_id: kind === 'issue' ? v.uuid(b.cash_counter_id, 'cash_counter_id', { optional: true, nullable: true }) ?? null : null,
    estimates, lines, bill_discount: v.dec(b.bill_discount, 'bill_discount', RX.money, { optional: true }) ?? '0',
    discount_reason: v.str(b.discount_reason, 'discount_reason', { optional: true, trim: true, min: 3, max: 200 }) ?? null, old_metal: old,
    old_gold_excess_payout: kind === 'issue' ? v.oneOf(b.old_gold_excess_payout, 'old_gold_excess_payout', ['cash', 'bank_transfer'] as const, { optional: true }) ?? null : null,
    payments, pan: panU, zero_gst: zero, expected_total: kind === 'issue' ? v.dec(b.expected_total, 'expected_total', RX.money, { optional: true }) ?? null : null,
    valid_until: kind === 'estimate' ? v.date(b.valid_until, 'valid_until', { optional: true }) ?? null : null,
    notes: kind === 'estimate' ? v.str(b.notes, 'notes', { optional: true, max: 500 }) ?? null : null,
  };
  v.done();
  return req;
}
