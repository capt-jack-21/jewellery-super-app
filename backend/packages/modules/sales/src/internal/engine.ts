import { type Dec, d, ZERO, r2, r3, m2, w3, sum, roundTo, allocate, pct } from './num';

/**
 * Pricing + GST engine (S4, S5, S6, S7, S8, S9, S11, S17) — PURE: every input is resolved by the caller (rates, tag facts, tax rules,
 * settings); nothing here reads the DB or decides permissions. Unit-tested in engine.unit.test.ts.
 *
 * Line (S4):  wastage_wt = net_wt × wastage% (3 dp half-up); chargeable_wt = net_wt + wastage_wt; metal_value = chargeable_wt × rate;
 *             making by mc_type (per_gram × net_wt, percent of metal_value, flat, per_piece × pieces); + stones + hallmark charge
 *             = gross_value. Discounts (S7): the line discount, then the bill discount spread pro rata over (gross − line discount)
 *             of the lines (largest fractional remainder in paisa). PricedLine.discount (contract) = line discount + bill_discount_share;
 *             the DB row keeps the line part only (invoice_line.discount) — taxable_value = gross_value − line discount − share.
 * Tax (S5/S8): one part per non-zero component (metal always). A line's discounts are spread over its components pro rata. metal / stone /
 *             hallmark use the metal rule (stone + hallmark as composite parts of the jewellery); making is composite (metal HSN + rate,
 *             MAKING_COMPOSITE rule) or a separate service (SAC rule, the shop's making_service_rate). Each of CGST / SGST / IGST / cess
 *             of each part is rounded to 0.01 half-up on its own (D34); line and bill taxes are sums of the rounded parts (never re-rounded).
 * Bill:       invoice_total = taxable + taxes + round_off (round_off_to, half up). Old gold (S6): stated_purity net_wt × rate, fine_24k
 *             fine_wt × rate; net_payable = max(invoice_total − old_metal_value, 0), old_gold_excess = the rest.
 */
export interface TaxRuleRef {
  id: string; code: string; hsn_sac: string; rate: string; cgst_rate: string; sgst_rate: string; igst_rate: string; cess_rate: string;
}
export type Component = 'metal' | 'making' | 'stone' | 'hallmark';
export interface StoneSnap { description: string; pieces: number; weight: string; unit: 'g' | 'ct'; amount: string }
export interface LineFacts {
  kind: 'tag' | 'loose'; tag_id: string | null; tag_no: string | null; item_id: string; sub_item_id: string | null; purity_id: string;
  purity_code: string; fineness: string; description: string; hsn: string; huid: string | null;
  pieces: number; gross_wt: string; stone_wt: string; net_wt: string;
  wastage_pct: string; wastage_range: { min: string | null; max: string | null } | null;
  mc_type: 'per_gram' | 'percent' | 'flat' | 'per_piece'; mc_value: string; list_mc_value: string; min_mc?: string;
  stones: StoneSnap[]; stone_amount: string; hallmark_charge: string; discount: string;
  rate_id: string; rate_per_g: string; metal_rule: TaxRuleRef;
  min_sale_value: string | null; max_sale_value: string | null; counter_id: string | null; tray_id: string | null;
}
export interface OldGoldFacts {
  purity_id: string; purity_code: string; description: string | null; gross_wt: string; less_wt: string; touch_pct: string;
  valuation_basis: 'stated_purity' | 'fine_24k'; rate_id: string; server_rate: string; rate_override: string | null; override_reason: string | null;
}
export interface EngineSettings {
  making_gst_treatment: 'composite' | 'separate'; making_service_rate: string | null; round_off_to: string;
  discount_warn_pct: string; discount_override_pct: string; pan_required_above: string; cash_limit_amount: string; cash_limit_mode: 'warn' | 'block';
  old_gold_excess_handling: 'refund_on_bill' | 'separate_purchase';
}
export interface BillInput {
  gst_type: 'intra' | 'inter'; zero_gst: boolean; settings: EngineSettings;
  making_rule: TaxRuleRef | null;      // separate mode: SAC rule (its rate is NOT used); composite: MAKING_COMPOSITE
  zero_rule: TaxRuleRef | null;        // ZERO_RATED (S17)
  lines: LineFacts[]; bill_discount: string; old_metal: OldGoldFacts[];
  payments: { mode: string; amount: string }[];
}
export interface TaxPart {
  component: Component; tax_rule_id: string; hsn_sac: string; composite_supply: boolean; taxable_value: string;
  rate: string; cgst_rate: string; sgst_rate: string; igst_rate: string; cess_rate: string; cgst: string; sgst: string; igst: string; cess: string;
}
export interface PricedLine {
  line_no: number; kind: 'tag' | 'loose'; tag_id: string | null; tag_no: string | null; item_id: string; sub_item_id: string | null; purity_id: string;
  description: string; purity_code: string; fineness: string; hsn: string; huid: string | null; pieces: number;
  gross_wt: string; stone_wt: string; net_wt: string; wastage_pct: string; wastage_wt: string; chargeable_wt: string;
  rate_id: string; rate_per_g: string; metal_value: string; mc_type: LineFacts['mc_type']; mc_value: string; mc_amount: string;
  stone_amount: string; hallmark_charge: string; gross_value: string; discount: string; bill_discount_share: string; taxable_value: string;
  tax_rate: string; cgst: string; sgst: string; igst: string; cess: string; line_total: string; tax_parts: TaxPart[]; stones: StoneSnap[];
  counter_id: string | null; tray_id: string | null;
  /** engine-only (not in the contract line): principal rule + composite flag for the DB row */
  _line_discount: string; _tax_rule_id: string; _hsn_sac_applied: string; _composite: boolean;
}
export interface PricedOldGold {
  line_no: number; purity_id: string; purity_code: string; description: string | null; gross_wt: string; less_wt: string; net_wt: string;
  touch_pct: string; fine_wt: string; valuation_basis: OldGoldFacts['valuation_basis']; rate_id: string; server_rate: string; rate_per_g: string;
  overridden: boolean; override_reason: string | null; amount: string;
}
export interface TaxSummaryRow { hsn_sac: string; rate: string; taxable_value: string; cgst: string; sgst: string; igst: string; cess: string }
export interface BillTotals {
  gross_value: string; line_discount: string; bill_discount: string; taxable_value: string; cgst: string; sgst: string; igst: string; cess: string;
  tax_total: string; round_off: string; invoice_total: string; old_metal_value: string; old_gold_excess: string; net_payable: string;
  paid_amount: string; balance_due: string; cash_amount: string;
}
export interface EngineFlags {
  discount_present: boolean; discount_pct: string; large_discount: boolean; above_override: boolean;
  below_minimum: string[];            // request paths priced below the tag minimum / outside the wastage range
  above_maximum: string[];
  override_min_needed: boolean; pan_required: boolean; cash_limit_exceeded: boolean; credit_sale: boolean; overpayment: boolean;
  old_gold_exceeds_bill: boolean; rate_override: boolean;
}
export interface BillResult { lines: PricedLine[]; old_metal: PricedOldGold[]; tax_summary: TaxSummaryRow[]; totals: BillTotals; flags: EngineFlags }

export class PricingError extends Error {
  constructor(readonly path: string, message: string) { super(message); }
}
const half = (rate: Dec): Dec => rate.dividedBy(2);
/** One component's tax part. */
export function taxPart(component: Component, taxable: Dec, rule: TaxRuleRef, gst: 'intra' | 'inter', o: { rate?: string; composite: boolean }): TaxPart {
  const rate = d(o.rate ?? rule.rate);
  const cgstR = o.rate !== undefined ? half(rate) : d(rule.cgst_rate);
  const sgstR = o.rate !== undefined ? half(rate) : d(rule.sgst_rate);
  const igstR = o.rate !== undefined ? rate : d(rule.igst_rate);
  const cessR = d(rule.cess_rate);
  const pc = (r: Dec) => r2(taxable.times(r).dividedBy(100));
  return {
    component, tax_rule_id: rule.id, hsn_sac: rule.hsn_sac, composite_supply: o.composite, taxable_value: m2(taxable),
    rate: m2(rate), cgst_rate: m2(cgstR), sgst_rate: m2(sgstR), igst_rate: m2(igstR), cess_rate: m2(cessR),
    cgst: m2(gst === 'intra' ? pc(cgstR) : ZERO), sgst: m2(gst === 'intra' ? pc(sgstR) : ZERO), igst: m2(gst === 'inter' ? pc(igstR) : ZERO), cess: m2(pc(cessR)),
  };
}
/** Making charge of a line (S4). per_gram is on net weight. */
export function makingAmount(mcType: LineFacts['mc_type'], mcValue: Dec, netWt: Dec, metalValue: Dec, pieces: number): Dec {
  switch (mcType) {
    case 'per_gram': return r2(mcValue.times(netWt));
    case 'percent': return r2(metalValue.times(mcValue).dividedBy(100));
    case 'flat': return r2(mcValue);
    case 'per_piece': return r2(mcValue.times(pieces));
  }
}
/** Bill round-off (S8): rounded total − total, per round_off_to. */
export const roundOff = (total: Dec, step: string): Dec => roundTo(total, d(step)).minus(total);

export function computeBill(inp: BillInput): BillResult {
  const s = inp.settings;
  // 1. line values before discount
  const pre = inp.lines.map((l) => {
    const net = d(l.net_wt);
    const wastageWt = r3(net.times(d(l.wastage_pct)).dividedBy(100));
    const chargeable = net.plus(wastageWt);
    const metal = r2(chargeable.times(d(l.rate_per_g)));
    const floor = r2(d(l.min_mc ?? 0));
    const floored = (value: Dec) => value.lt(floor) ? floor : value;
    const mc = floored(makingAmount(l.mc_type, r2(d(l.mc_value)), net, metal, l.pieces));
    const listMc = floored(makingAmount(l.mc_type, r2(d(l.list_mc_value)), net, metal, l.pieces));
    const stone = r2(d(l.stone_amount)); const hall = r2(d(l.hallmark_charge));
    const gross = metal.plus(mc).plus(stone).plus(hall);
    return { l, wastageWt, chargeable, metal, mc, mcReduction: listMc.gt(mc) ? listMc.minus(mc) : ZERO, stone, hall, gross, lineDisc: r2(d(l.discount)) };
  });
  const billDisc = r2(d(inp.bill_discount));
  for (const [i, p] of pre.entries()) if (p.lineDisc.gt(p.gross)) throw new PricingError(`lines[${i}].discount`, 'discount exceeds the line value');
  if (billDisc.gt(sum(pre.map((p) => p.gross.minus(p.lineDisc))))) throw new PricingError('bill_discount', 'bill discount exceeds value');
  const shares = allocate(billDisc, pre.map((p) => p.gross.minus(p.lineDisc)));
  const lines: PricedLine[] = pre.map((p, i) => {
    const l = p.l; const share = shares[i];
    const taxable = p.gross.minus(p.lineDisc).minus(share);
    const comps: [Component, Dec][] = ([['metal', p.metal], ['making', p.mc], ['stone', p.stone], ['hallmark', p.hall]] as [Component, Dec][])
      .filter(([c, v]) => c === 'metal' || !v.isZero());
    const discShares = allocate(p.lineDisc.plus(share), comps.map(([, v]) => v));
    const parts = comps.map(([c, v], k) => {
      const t = v.minus(discShares[k]);
      if (inp.zero_gst) return taxPart(c, t, inp.zero_rule!, inp.gst_type, { composite: false });
      if (c === 'making') {
        if (s.making_gst_treatment === 'separate') return taxPart(c, t, inp.making_rule!, inp.gst_type, { rate: s.making_service_rate!, composite: false });
        const rule = inp.making_rule ?? l.metal_rule;
        return taxPart(c, t, { ...l.metal_rule, id: rule.id }, inp.gst_type, { composite: true });
      }
      return taxPart(c, t, l.metal_rule, inp.gst_type, { composite: c !== 'metal' });
    });
    const tsum = (k: 'cgst' | 'sgst' | 'igst' | 'cess') => sum(parts.map((x) => d(x[k])));
    const cg = tsum('cgst'), sg = tsum('sgst'), ig = tsum('igst'), ce = tsum('cess');
    const principal = inp.zero_gst ? inp.zero_rule! : l.metal_rule;
    return {
      line_no: i + 1, kind: l.kind, tag_id: l.tag_id, tag_no: l.tag_no, item_id: l.item_id, sub_item_id: l.sub_item_id, purity_id: l.purity_id,
      description: l.description, purity_code: l.purity_code, fineness: l.fineness, hsn: l.hsn, huid: l.huid, pieces: l.pieces,
      gross_wt: w3(l.gross_wt), stone_wt: w3(l.stone_wt), net_wt: w3(l.net_wt), wastage_pct: pct(d(l.wastage_pct)), wastage_wt: w3(p.wastageWt),
      chargeable_wt: w3(p.chargeable), rate_id: l.rate_id, rate_per_g: m2(l.rate_per_g), metal_value: m2(p.metal), mc_type: l.mc_type,
      mc_value: m2(l.mc_value), mc_amount: m2(p.mc), stone_amount: m2(p.stone), hallmark_charge: m2(p.hall), gross_value: m2(p.gross),
      discount: m2(p.lineDisc.plus(share)), bill_discount_share: m2(share), taxable_value: m2(taxable), tax_rate: m2(inp.zero_gst ? ZERO : d(l.metal_rule.rate)),
      cgst: m2(cg), sgst: m2(sg), igst: m2(ig), cess: m2(ce), line_total: m2(taxable.plus(cg).plus(sg).plus(ig).plus(ce)), tax_parts: parts,
      stones: l.stones, counter_id: l.counter_id, tray_id: l.tray_id,
      _line_discount: m2(p.lineDisc), _tax_rule_id: principal.id, _hsn_sac_applied: principal.hsn_sac, _composite: !inp.zero_gst && s.making_gst_treatment === 'composite',
    };
  });
  // 2. tax summary by hsn_sac + rate (sums of the rounded parts)
  const sumMap = new Map<string, TaxSummaryRow>();
  for (const p of lines.flatMap((l) => l.tax_parts)) {
    const k = `${p.hsn_sac}|${p.rate}`;
    const r = sumMap.get(k) ?? { hsn_sac: p.hsn_sac, rate: p.rate, taxable_value: '0.00', cgst: '0.00', sgst: '0.00', igst: '0.00', cess: '0.00' };
    for (const f of ['taxable_value', 'cgst', 'sgst', 'igst', 'cess'] as const) r[f] = m2(d(r[f]).plus(d(p[f])));
    sumMap.set(k, r);
  }
  // 3. old gold
  const old_metal: PricedOldGold[] = inp.old_metal.map((o, i) => {
    const net = d(o.gross_wt).minus(d(o.less_wt));
    const fine = r3(net.times(d(o.touch_pct)).dividedBy(100));
    const rate = d(o.rate_override ?? o.server_rate);
    const amount = r2((o.valuation_basis === 'fine_24k' ? fine : net).times(rate));
    return { line_no: i + 1, purity_id: o.purity_id, purity_code: o.purity_code, description: o.description, gross_wt: w3(o.gross_wt), less_wt: w3(o.less_wt),
      net_wt: w3(net), touch_pct: pct(d(o.touch_pct)), fine_wt: w3(fine), valuation_basis: o.valuation_basis, rate_id: o.rate_id, server_rate: m2(o.server_rate),
      rate_per_g: m2(rate), overridden: o.rate_override !== null, override_reason: o.rate_override !== null ? o.override_reason : null, amount: m2(amount) };
  });
  // 4. totals
  const T = (f: keyof PricedLine) => sum(lines.map((l) => d(l[f] as string)));
  const gross = T('gross_value'), lineDisc = T('_line_discount'), taxable = T('taxable_value');
  const cg = T('cgst'), sg = T('sgst'), ig = T('igst'), ce = T('cess');
  const taxTotal = cg.plus(sg).plus(ig).plus(ce);
  const ro = roundOff(taxable.plus(taxTotal), s.round_off_to);
  const invoiceTotal = taxable.plus(taxTotal).plus(ro);
  const oldValue = sum(old_metal.map((o) => d(o.amount)));
  const excess = oldValue.gt(invoiceTotal) ? oldValue.minus(invoiceTotal) : ZERO;
  const net = oldValue.gt(invoiceTotal) ? ZERO : invoiceTotal.minus(oldValue);
  const paid = sum(inp.payments.map((p) => d(p.amount)));
  const cash = sum(inp.payments.filter((p) => p.mode === 'cash').map((p) => d(p.amount)));
  const balance = net.minus(paid);
  // 5. flags (the caller turns them into 403 / 422 / warnings / requirements)
  const discountTotal = lineDisc.plus(billDisc).plus(sum(pre.map((p) => p.mcReduction)));
  const discountPct = gross.isZero() ? ZERO : discountTotal.times(100).dividedBy(gross);
  const below: string[] = []; const above: string[] = [];
  inp.lines.forEach((l, i) => {
    const w = l.wastage_range; const wp = d(l.wastage_pct);
    if (w && ((w.min !== null && wp.lt(d(w.min))) || (w.max !== null && wp.gt(d(w.max))))) below.push(`lines[${i}].wastage_pct`);
    if (l.min_sale_value !== null && d(lines[i].taxable_value).lt(d(l.min_sale_value))) below.push(`lines[${i}]`);
    if (l.max_sale_value !== null && d(lines[i].taxable_value).gt(d(l.max_sale_value))) above.push(`lines[${i}]`);
  });
  const aboveOverride = discountPct.gt(d(s.discount_override_pct));
  return {
    lines, old_metal, tax_summary: [...sumMap.values()],
    totals: { gross_value: m2(gross), line_discount: m2(lineDisc), bill_discount: m2(billDisc), taxable_value: m2(taxable), cgst: m2(cg), sgst: m2(sg),
      igst: m2(ig), cess: m2(ce), tax_total: m2(taxTotal), round_off: m2(ro), invoice_total: m2(invoiceTotal), old_metal_value: m2(oldValue),
      old_gold_excess: m2(excess), net_payable: m2(net), paid_amount: m2(paid), balance_due: m2(balance.isNegative() ? ZERO : balance), cash_amount: m2(cash) },
    flags: {
      discount_present: !discountTotal.isZero(), discount_pct: pct(discountPct), large_discount: !discountTotal.isZero() && discountPct.gte(d(s.discount_warn_pct)),
      above_override: aboveOverride, below_minimum: below, above_maximum: above, override_min_needed: aboveOverride || below.length > 0,
      pan_required: invoiceTotal.gt(d(s.pan_required_above)), cash_limit_exceeded: cash.gte(d(s.cash_limit_amount)),
      credit_sale: net.gt(ZERO) && paid.isZero(), overpayment: paid.gt(net), old_gold_exceeds_bill: excess.gt(ZERO),
      rate_override: inp.old_metal.some((o) => o.rate_override !== null),
    },
  };
}
/** S11 cash on ONE bill: earlier cash (issue + receipts) + this cash ≥ limit. */
export const cashLimitHit = (priorCash: string, thisCash: string, limit: string): boolean => d(priorCash).plus(d(thisCash)).gte(d(limit));
export { d as dec, m2, w3 };
