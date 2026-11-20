import { describe, it, expect } from 'vitest';
import { computeBill, makingAmount, roundOff, taxPart, cashLimitHit, type BillInput, type LineFacts, type TaxRuleRef, type OldGoldFacts, type EngineSettings } from './engine';
import { d, allocate, roundTo, pct } from './num';

/** Pure pricing / GST engine (S4-S9, S11, S17): no DB. */
const GOLD: TaxRuleRef = { id: 'r-gold', code: 'GOLD_JEWELLERY', hsn_sac: '7113', rate: '3.00', cgst_rate: '1.50', sgst_rate: '1.50', igst_rate: '3.00', cess_rate: '0.00' };
const MAKE_C: TaxRuleRef = { ...GOLD, id: 'r-mc', code: 'MAKING_COMPOSITE' };
const SAC: TaxRuleRef = { id: 'r-sac', code: 'REPAIR_SERVICE', hsn_sac: '998892', rate: '5.00', cgst_rate: '2.50', sgst_rate: '2.50', igst_rate: '5.00', cess_rate: '0.00' };
const ZERO_R: TaxRuleRef = { id: 'r-zero', code: 'ZERO_RATED', hsn_sac: '7113', rate: '0.00', cgst_rate: '0.00', sgst_rate: '0.00', igst_rate: '0.00', cess_rate: '0.00' };
const S: EngineSettings = { making_gst_treatment: 'composite', making_service_rate: null, round_off_to: '1.00', discount_warn_pct: '5', discount_override_pct: '10',
  pan_required_above: '200000.00', cash_limit_amount: '200000.00', cash_limit_mode: 'block', old_gold_excess_handling: 'separate_purchase' };
const line = (o: Partial<LineFacts> = {}): LineFacts => ({
  kind: 'tag', tag_id: 't1', tag_no: 'T1', item_id: 'i', sub_item_id: null, purity_id: 'p22', purity_code: '22K', fineness: '916.000', description: 'Ring', hsn: '7113',
  huid: 'ABC123', pieces: 1, gross_wt: '10.000', stone_wt: '0.000', net_wt: '10.000', wastage_pct: '8', wastage_range: null, mc_type: 'per_gram', mc_value: '500',
  list_mc_value: '500', stones: [], stone_amount: '0', hallmark_charge: '0', discount: '0', rate_id: 'rate', rate_per_g: '6000.00', metal_rule: GOLD,
  min_sale_value: null, max_sale_value: null, counter_id: null, tray_id: null, ...o });
const old = (o: Partial<OldGoldFacts> = {}): OldGoldFacts => ({ purity_id: 'p22', purity_code: '22K', description: null, gross_wt: '5.000', less_wt: '0.500', touch_pct: '91.6',
  valuation_basis: 'stated_purity', rate_id: 'or', server_rate: '5800.00', rate_override: null, override_reason: null, ...o });
const bill = (o: Partial<BillInput> = {}) => computeBill({ gst_type: 'intra', zero_gst: false, settings: S, making_rule: MAKE_C, zero_rule: ZERO_R, lines: [line()],
  bill_discount: '0', old_metal: [], payments: [], ...o });

describe('line pricing (S4)', () => {
  it('wastage on net weight, metal on chargeable weight, making per gram on net', () => {
    const r = bill();
    expect(r.lines[0]).toMatchObject({ wastage_wt: '0.800', chargeable_wt: '10.800', metal_value: '64800.00', mc_amount: '5000.00', gross_value: '69800.00' });
    expect(r.totals).toMatchObject({ taxable_value: '69800.00', cgst: '1047.00', sgst: '1047.00', igst: '0.00', invoice_total: '71894.00', round_off: '0.00' });
  });
  it('making types', () => {
    expect(makingAmount('per_gram', d('500'), d('2.345'), d('0'), 1).toFixed(2)).toBe('1172.50');
    expect(makingAmount('percent', d('12'), d('10'), d('64800'), 1).toFixed(2)).toBe('7776.00');
    expect(makingAmount('flat', d('750'), d('10'), d('0'), 1).toFixed(2)).toBe('750.00');
    expect(makingAmount('per_piece', d('150'), d('10'), d('0'), 4).toFixed(2)).toBe('600.00');
  });
  it('wastage weight rounds to 3 dp half up', () => {
    expect(bill({ lines: [line({ net_wt: '1.235', gross_wt: '1.235', wastage_pct: '10' })] }).lines[0].wastage_wt).toBe('0.124');   // 0.1235 → 0.124
  });
  it('stones and hallmark are composite parts under the metal rule', () => {
    const r = bill({ lines: [line({ stone_amount: '1000', hallmark_charge: '45' })] });
    const parts = r.lines[0].tax_parts.map((p) => [p.component, p.hsn_sac, p.composite_supply]);
    expect(parts).toEqual([['metal', '7113', false], ['making', '7113', true], ['stone', '7113', true], ['hallmark', '7113', true]]);
  });
});

describe('GST (S2, S5, S8, S17)', () => {
  it('inter-state: IGST only', () => {
    expect(bill({ gst_type: 'inter' }).totals).toMatchObject({ cgst: '0.00', sgst: '0.00', igst: '2094.00', invoice_total: '71894.00' });
  });
  it('separate making uses the SAC rule with the shop rate (not the rule rate)', () => {
    const r = bill({ settings: { ...S, making_gst_treatment: 'separate', making_service_rate: '18.00' }, making_rule: SAC });
    const mk = r.lines[0].tax_parts.find((p) => p.component === 'making')!;
    expect(mk).toMatchObject({ hsn_sac: '998892', rate: '18.00', cgst_rate: '9.00', cgst: '450.00', composite_supply: false });
    expect(r.tax_summary.map((x) => `${x.hsn_sac}|${x.rate}`)).toEqual(['7113|3.00', '998892|18.00']);
  });
  it('QA N5 — each head of each component part rounds on its own (D34); totals are sums of rounded parts', () => {
    const r = bill({ lines: [line({ purity_id: 'p24', rate_per_g: '6500.00', net_wt: '1.002', gross_wt: '1.002', wastage_pct: '0', mc_type: 'flat', mc_value: '333', list_mc_value: '333' })] });
    expect(r.lines[0].tax_parts.map((p) => p.cgst)).toEqual(['97.70', '5.00']);
    expect(r.totals).toMatchObject({ cgst: '102.70', sgst: '102.70', taxable_value: '6846.00', round_off: '-0.40', invoice_total: '7051.00' });
  });
  it('round-off steps (half up)', () => {
    expect(roundOff(d('100.49'), '1.00').toFixed(2)).toBe('-0.49');
    expect(roundOff(d('100.50'), '1.00').toFixed(2)).toBe('0.50');
    expect(roundOff(d('100.24'), '0.50').toFixed(2)).toBe('-0.24');
    expect(roundOff(d('100.25'), '0.50').toFixed(2)).toBe('0.25');
    expect(roundOff(d('100.05'), '0.10').toFixed(2)).toBe('0.05');
    expect(roundTo(d('7051.40'), d('0.01')).toFixed(2)).toBe('7051.40');
  });
  it('0% GST: zero-rated rule, no tax', () => {
    const r = bill({ zero_gst: true });
    expect(r.totals).toMatchObject({ cgst: '0.00', sgst: '0.00', igst: '0.00', invoice_total: '69800.00' });
    expect(r.lines[0].tax_parts.every((p) => p.tax_rule_id === 'r-zero')).toBe(true);
    expect(r.lines[0].tax_rate).toBe('0.00');
  });
  it('taxPart halves an explicit rate', () => {
    expect(taxPart('making', d('1000'), SAC, 'intra', { rate: '12.00', composite: false })).toMatchObject({ cgst_rate: '6.00', sgst_rate: '6.00', igst_rate: '12.00', cgst: '60.00', igst: '0.00' });
  });
});

describe('discounts (S7)', () => {
  it('bill discount spreads pro rata, remainder to the largest line; shares sum exactly', () => {
    const r = bill({ lines: [line(), line({ tag_id: 't2', net_wt: '1.000', gross_wt: '1.000', wastage_pct: '0' }), line({ tag_id: 't3', net_wt: '1.000', gross_wt: '1.000', wastage_pct: '0' })], bill_discount: '100.00' });
    const shares = r.lines.map((l) => d(l.bill_discount_share));
    expect(shares.reduce((a, b) => a.plus(b), d(0)).toFixed(2)).toBe('100.00');
    expect(r.totals.taxable_value).toBe(d('69800').plus(6500).plus(6500).minus(100).toFixed(2));
  });
  it('allocate', () => {
    expect(allocate(d('1.00'), [d(1), d(1), d(1)]).map((x) => x.toFixed(2))).toEqual(['0.34', '0.33', '0.33']);
    expect(allocate(d('0'), [d(1)]).map((x) => x.toFixed(2))).toEqual(['0.00']);
    expect(allocate(d('5'), [])).toEqual([]);
  });
  it('warns at the warn % (>=), needs override above the override % (>)', () => {
    expect(bill({ bill_discount: '3490.00' }).flags).toMatchObject({ large_discount: true, above_override: false, override_min_needed: false });
    expect(bill({ bill_discount: '3489.99' }).flags.large_discount).toBe(false);
    expect(bill({ bill_discount: '6980.00' }).flags.above_override).toBe(false);
    expect(bill({ bill_discount: '6980.01' }).flags).toMatchObject({ above_override: true, override_min_needed: true });
  });
  it('a making charge below the tag list counts as discount; below-minimum and wastage range flags', () => {
    const r = bill({ lines: [line({ mc_value: '400' })] });
    expect(r.flags.discount_present).toBe(true);
    expect(r.flags.discount_pct).toBe(pct(d(1000).times(100).dividedBy(d('68800'))));
    expect(bill({ lines: [line({ wastage_range: { min: '10', max: null } })] }).flags.below_minimum).toEqual(['lines[0].wastage_pct']);
    expect(bill({ lines: [line({ min_sale_value: '70000.00' })] }).flags.below_minimum).toEqual(['lines[0]']);
    expect(bill({ lines: [line({ max_sale_value: '60000.00' })] }).flags.above_maximum).toEqual(['lines[0]']);
  });
});

describe('old gold (S6) and payments (S9-S11)', () => {
  it('stated purity: net × rate; fine_24k: fine × rate; override applied, server rate kept', () => {
    expect(bill({ old_metal: [old()] }).old_metal[0]).toMatchObject({ net_wt: '4.500', fine_wt: '4.122', amount: '26100.00', overridden: false });
    expect(bill({ old_metal: [old({ valuation_basis: 'fine_24k', server_rate: '6300.00' })] }).old_metal[0].amount).toBe('25968.60');
    const o = bill({ old_metal: [old({ rate_override: '5900.00', override_reason: 'loyal' })] });
    expect(o.old_metal[0]).toMatchObject({ server_rate: '5800.00', rate_per_g: '5900.00', overridden: true, amount: '26550.00' });
    expect(o.flags.rate_override).toBe(true);
    expect(o.totals.net_payable).toBe('45344.00');
  });
  it('old gold worth more than the bill: net payable 0, excess reported', () => {
    const r = bill({ lines: [line({ net_wt: '1.000', gross_wt: '1.000', wastage_pct: '0' })], old_metal: [old()] });
    expect(r.totals).toMatchObject({ net_payable: '0.00', old_gold_excess: '19405.00' });
    expect(r.flags.old_gold_exceeds_bill).toBe(true);
  });
  it('credit sale only when nothing is paid; overpayment; cash', () => {
    expect(bill().flags.credit_sale).toBe(true);
    expect(bill({ payments: [{ mode: 'cash', amount: '1.00' }] }).flags.credit_sale).toBe(false);
    expect(bill({ payments: [{ mode: 'upi', amount: '71894.01' }] }).flags.overpayment).toBe(true);
    const r = bill({ payments: [{ mode: 'cash', amount: '1000.00' }, { mode: 'upi', amount: '500.00' }] });
    expect(r.totals).toMatchObject({ paid_amount: '1500.00', cash_amount: '1000.00', balance_due: '70394.00' });
  });
  it('PAN above the threshold (strictly greater); cash limit at the boundary (>=)', () => {
    expect(bill({ settings: { ...S, pan_required_above: '71894.00' } }).flags.pan_required).toBe(false);
    expect(bill({ settings: { ...S, pan_required_above: '71893.99' } }).flags.pan_required).toBe(true);
    expect(bill({ settings: { ...S, cash_limit_amount: '1000.00' }, payments: [{ mode: 'cash', amount: '999.99' }] }).flags.cash_limit_exceeded).toBe(false);
    expect(bill({ settings: { ...S, cash_limit_amount: '1000.00' }, payments: [{ mode: 'cash', amount: '1000.00' }] }).flags.cash_limit_exceeded).toBe(true);
    expect(cashLimitHit('6000.00', '3999.99', '10000.00')).toBe(false);
    expect(cashLimitHit('6000.00', '4000.00', '10000.00')).toBe(true);
  });
});

/** Independent integer-paisa oracle: covers rounding ties and totals over a grid rather than comparing the engine to itself. */
describe('GST / allocation arithmetic grid', () => {
  const cents = (n: bigint): string => `${n / 100n}.${String(n % 100n).padStart(2, '0')}`;
  const tax = (paise: bigint, basisPoints: bigint): bigint => (paise * basisPoints + 5000n) / 10000n;
  for (const gst of ['intra', 'inter'] as const) for (const rate of ['0.00', '3.00', '5.00', '12.00', '18.00', '28.00']) {
    it(`${gst} rate ${rate}: 200 cent boundaries, component rounding and cess`, () => {
      const bp = BigInt(rate.replace('.', ''));
      const rule = { ...GOLD, rate, cgst_rate: d(rate).dividedBy(2).toFixed(2), sgst_rate: d(rate).dividedBy(2).toFixed(2), igst_rate: rate, cess_rate: '1.00' };
      for (let n = 1n; n <= 200n; n++) {
        const p = taxPart('metal', d(cents(n)), rule, gst, { composite: false });
        expect(p.cgst).toBe(cents(gst === 'intra' ? tax(n, bp / 2n) : 0n));
        expect(p.sgst).toBe(p.cgst);
        expect(p.igst).toBe(cents(gst === 'inter' ? tax(n, bp) : 0n));
        expect(p.cess).toBe(cents(tax(n, 100n)));
      }
    });
  }
  for (const treatment of ['composite', 'separate'] as const) for (const gst of ['intra', 'inter'] as const) {
    it(`${treatment}/${gst}: discounted four-component multi-line totals conserve every paisa`, () => {
      for (const discount of ['0.00', '0.01', '1.00', '6.01', '15.00']) {
        const r = bill({ gst_type: gst, settings: { ...S, making_gst_treatment: treatment, making_service_rate: treatment === 'separate' ? '18.00' : null, round_off_to: '0.01' }, making_rule: SAC,
          lines: [line({ rate_per_g: '0.01', gross_wt: '1.000', net_wt: '1.000', wastage_pct: '0', mc_type: 'flat', mc_value: '5.00', list_mc_value: '5.00', stone_amount: '3.33', hallmark_charge: '1.67' }),
            line({ tag_id: 't2', rate_per_g: '1.00', gross_wt: '2.000', net_wt: '2.000', wastage_pct: '0', mc_type: 'flat', mc_value: '5.00', list_mc_value: '5.00' })], bill_discount: discount });
        const sum = (xs: string[]) => xs.reduce((a, x) => a.plus(x), d(0));
        expect(sum(r.lines.map((l) => l.bill_discount_share)).toFixed(2)).toBe(discount);
        for (const l of r.lines) {
          expect(sum(l.tax_parts.map((x) => x.taxable_value)).toFixed(2)).toBe(l.taxable_value);
          expect(l.tax_parts.every((x) => d(x.taxable_value).gte(0))).toBe(true);
          for (const k of ['cgst', 'sgst', 'igst', 'cess'] as const) expect(sum(l.tax_parts.map((x) => x[k])).toFixed(2)).toBe(l[k]);
        }
        for (const k of ['cgst', 'sgst', 'igst', 'cess', 'taxable_value'] as const) expect(sum(r.lines.map((x) => x[k])).toFixed(2)).toBe(r.totals[k]);
        expect(d(r.totals.taxable_value).plus(r.totals.tax_total).plus(r.totals.round_off).toFixed(2)).toBe(r.totals.invoice_total);
      }
    });
  }
  it('near-full discounts across 200 tiny lines never make a component negative', () => {
    for (let pennies = 0; pennies <= 200; pennies++) {
      const shares = allocate(d(pennies).dividedBy(100), Array.from({ length: 200 }, () => d('0.01')));
      expect(shares.every((x) => x.gte(0) && x.lte('0.01'))).toBe(true);
      expect(shares.reduce((a, x) => a.plus(x), d(0)).toFixed(2)).toBe(d(pennies).dividedBy(100).toFixed(2));
    }
  });
  it('discount larger than the line / whole bill is rejected before pricing', () => {
    expect(() => bill({ lines: [line({ discount: '69800.01' })] })).toThrow('discount exceeds');
    expect(() => bill({ bill_discount: '69800.01' })).toThrow('bill discount exceeds');
  });
});

it('QA B3 — min_mc floors below/equal/above making for every making type before discount and GST', () => {
  for (const mc_type of ['flat', 'per_gram', 'percent', 'per_piece'] as const) for (const value of ['50', '100', '150']) {
    const r = bill({ lines: [line({ net_wt: '1.000', gross_wt: '1.000', wastage_pct: '0', rate_per_g: '100.00', mc_type,
      mc_value: value, list_mc_value: value, min_mc: '100.00', discount: '10.00' })] });
    expect(r.lines[0].mc_amount).toBe(value === '150' ? '150.00' : '100.00');
    expect(r.lines[0].taxable_value).toBe(value === '150' ? '240.00' : '190.00');
  }
});
