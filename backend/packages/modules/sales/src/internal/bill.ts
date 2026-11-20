import { one, many, iso } from './db';
import { fail } from './errors';
import { type SalesActor, has, needBranch } from './actor';
import { stockPort, customerPort, type SaleTagRow, type CustomerRow } from './ports';
import { computeBill, PricingError, type BillResult, type LineFacts, type OldGoldFacts, type TaxRuleRef, type StoneSnap } from './engine';
import { loadShop, roundOffTo, engineSettings, evenSplit, type ShopSettings } from './settings';
import { branchPrefix } from './numbering';
import type { BillReq, TenderIn } from './request';
import { d, m2 } from './num';

/**
 * Resolves a bill request against the DB (branch, seller, customer, salesperson, tags, loose stock, today's rates, tax rules, settings),
 * prices it with the pure engine and works out requirements + warnings. Shared by /preview, /invoices (issue), /estimates and /sellable.
 * mode 'issue' locks the tags FOR UPDATE (through Inventory) and enforces every requirement; 'preview' / 'estimate' report them.
 */
export type Mode = 'issue' | 'preview' | 'estimate';
/** 0.9.2 (Mirage): where the owner fixes it — on the 422 problem body and on the readiness gate. */
export const MAKING_RATE_POINTER = { setting_key: 'making_service_rate', settings_path: '/v1/sales/settings' } as const;
export interface Seller { company_id: string; legal_name: string; gstin: string | null; state_code: string; address: Record<string, unknown> | null }
export interface CustomerSnap {
  customer_id: string | null; name: string; phone: string | null; gstin: string | null; state_code: string | null;
  address: Record<string, unknown> | null; pan_on_file: boolean; pan_last4: string | null;
}
export interface RateUsed { kind: 'sale' | 'old_metal'; metal_id: string; purity_id: string; purity_code: string; rate_id: string; rate_per_g: string; effective_from: string }
export interface Warning { code: string; message: string; path: string | null }
export interface Prepared {
  req: BillReq; mode: Mode; day: string; making_floors: string[]; shop: ShopSettings; roundOff: string; branch: { id: string; code: string; company_id: string };
  seller: Seller; customer: CustomerSnap | null; customerRow: CustomerRow | null; supply_type: 'b2b' | 'b2c'; gst_type: 'intra' | 'inter';
  place_of_supply: string; rates_used: RateUsed[]; result: BillResult; tags: Map<string, SaleTagRow>; making_rule: TaxRuleRef | null;
  requirements: Record<string, unknown>; warnings: Warning[]; payments: TenderIn[]; computed_at: string;
  order_rate: { order_id: string; rule: 'locked' | 'lower_of'; locked_rate_per_g: string; applied: { purity_code: string; today_rate_per_g: string; rate_per_g: string }[] } | null;
}
const ADDR_KEYS = ['line1', 'line2', 'city', 'district', 'pincode'];
export function cleanAddress(a: unknown): Record<string, unknown> | null {
  if (!a || typeof a !== 'object') return null;
  const o = Object.fromEntries(Object.entries(a as Record<string, unknown>).filter(([k, v]) => ADDR_KEYS.includes(k) && typeof v === 'string' && v !== ''));
  if (o.pincode !== undefined && !/^[0-9]{6}$/.test(String(o.pincode))) delete o.pincode;
  return Object.keys(o).length ? o : null;
}
export const snapOf = (c: CustomerRow): CustomerSnap => ({ customer_id: c.id, name: c.name, phone: c.phone && /^[6-9]\d{9}$/.test(c.phone) ? c.phone : null,
  gstin: c.gstin, state_code: c.state_code, address: cleanAddress(c.address), pan_on_file: c.pan_last4 !== null, pan_last4: c.pan_last4 });

const RULE_COLS = `id, code, hsn_sac, rate::text, cgst_rate::text, sgst_rate::text, igst_rate::text, cess_rate::text`;
/** Tax rule in force on `day`: tenant rule first, then platform. */
async function ruleBy(where: string, params: unknown[], day: string): Promise<TaxRuleRef | undefined> {
  return one<TaxRuleRef>(`SELECT ${RULE_COLS} FROM masters.tax_rule WHERE ${where}
      AND effective_from <= $${params.length + 1}::date AND (effective_to IS NULL OR effective_to > $${params.length + 1}::date)
      ORDER BY (scope = 'tenant') DESC, effective_from DESC LIMIT 1`, [...params, day]);
}
export const ruleByCode = (code: string, day: string) => ruleBy(`code = $1`, [code], day);
/** GST rule for jewellery of a metal: tax_rule.metal_code = the metal code (or its name's first word, e.g. "Gold" → GOLD), else a metal-agnostic rule. */
export async function metalRule(metal: { code: string; name: string }, day: string): Promise<TaxRuleRef | undefined> {
  const keys = [metal.code.toUpperCase(), (metal.name.split(/\s+/)[0] ?? '').toUpperCase()];
  return (await ruleBy(`component = 'metal' AND metal_code = ANY($1::text[])`, [keys], day)) ?? ruleBy(`component = 'metal' AND metal_code IS NULL`, [], day);
}
/** Making rule: composite → MAKING_COMPOSITE (rate = the metal rule's); separate → shop_setting.making_tax_rule_code, else REPAIR_SERVICE (SAC 998892) — rate from the shop. */
export async function makingRule(shop: ShopSettings, day: string): Promise<TaxRuleRef | null> {
  if (shop.making_gst_treatment === 'composite') return (await ruleByCode('MAKING_COMPOSITE', day)) ?? null;
  return (shop.making_tax_rule_code ? await ruleByCode(shop.making_tax_rule_code, day) : undefined) ?? (await ruleByCode('REPAIR_SERVICE', day)) ?? null;
}
interface PurityRow { id: string; code: string; fineness: string; metal_id: string; metal_code: string; metal_name: string; is_active: boolean }
async function purities(ids: string[]): Promise<Map<string, PurityRow>> {
  const rows = ids.length ? await many<PurityRow>(`SELECT p.id, p.code, p.fineness::text, p.metal_id, m.code AS metal_code, m.name AS metal_name, p.is_active AND m.is_active AS is_active
      FROM masters.purity p JOIN masters.metal m ON m.tenant_id = p.tenant_id AND m.id = p.metal_id WHERE p.id = ANY($1::uuid[])`, [[...new Set(ids)]]) : [];
  return new Map(rows.map((r) => [r.id, r]));
}
/** Today's (IST) rate for a purity: the branch override first, then shop-wide; latest effective_from ≤ now. */
async function todaysRate(purityId: string, kind: 'sale' | 'old_metal', branchId: string, day: string) {
  return one<{ id: string; rate_per_g: string; effective_from: string }>(`SELECT id, rate_per_g::text, ${iso('effective_from')} FROM rates.metal_rate
      WHERE purity_id = $1 AND kind = $2 AND rate_date = $4::date AND (branch_id IS NULL OR branch_id = $3) AND effective_from <= now()
      ORDER BY (branch_id IS NOT NULL) DESC, effective_from DESC LIMIT 1`, [purityId, kind, branchId, day]);
}
const pctOf = (fineness: string) => d(fineness).gt(100) ? d(fineness).dividedBy(10) : d(fineness);   // 916 → 91.6 (touch %)

/** S18 gates (issue / preview / estimates): approved device, onboarding gst + gst_rates, invoice series. Rates are checked per purity. */
export async function gates(a: SalesActor, branchId: string): Promise<void> {
  if (a.billingEnabled === false) fail(403, 'device_not_approved', 'billing needs an approved counter device (S18)');
  const b = await one<{ missing_steps: string[] }>(`SELECT missing_steps FROM platform.v_billing_unlocked WHERE tenant_id = platform.current_tenant()`);
  const missing = (b?.missing_steps ?? []).filter((s) => ['gst', 'gst_rates', 'shop_profile', 'metals_purities'].includes(s));
  if (missing.length) fail(409, 'onboarding_incomplete', `onboarding steps not done: ${missing.join(', ')}`);
  if (!(await branchPrefix(branchId)).ok) fail(409, 'onboarding_incomplete', 'branch bill series prefix must be 1-4 letters / digits (invoice_series)');
}

export async function prepare(a: SalesActor, req: BillReq, mode: Mode, day: string): Promise<Prepared> {
  // --- branch, seller
  const br = await one<{ id: string; code: string; company_id: string; gstin: string | null; state_code: string | null; is_active: boolean; address: Record<string, unknown> | null }>(
    `SELECT id, code, company_id, gstin, state_code, is_active, address FROM platform.branch WHERE id = $1`, [req.branch_id]);
  if (!br) fail(422, 'unknown_reference', 'branch_id', [{ path: 'branch_id', code: 'unknown_reference', message: 'no such branch' }]);
  if (!br.is_active) fail(422, 'inactive_master', 'branch is inactive', [{ path: 'branch_id', code: 'inactive_master', message: 'inactive' }]);
  needBranch(a, br.id);
  await gates(a, br.id);
  const co = (await one<{ id: string; legal_name: string; gstin: string | null; state_code: string; address: unknown }>(
    `SELECT id, legal_name, gstin, state_code, address FROM platform.company WHERE id = $1`, [br.company_id]))!;
  const sellerGstin = br.gstin ?? co.gstin;
  const sellerState = sellerGstin ? sellerGstin.slice(0, 2) : (br.state_code ?? co.state_code);
  const seller: Seller = { company_id: co.id, legal_name: co.legal_name, gstin: sellerGstin, state_code: sellerState, address: cleanAddress(br.address) ?? cleanAddress(co.address) };
  const shop = await loadShop();
  const roundOff = await roundOffTo(day);
  if (shop.making_gst_treatment === 'separate' && (shop.making_service_rate === null || !evenSplit(shop.making_service_rate)))
    fail(422, 'making_service_rate_not_set', 'making is billed as a separate service but making_service_rate is not set (owner: PATCH /v1/sales/settings)',
      [{ path: 'making_service_rate', code: 'making_service_rate_not_set', message: 'not set' }], MAKING_RATE_POINTER);
  // --- customer (S1 / S22)
  let customerRow: CustomerRow | null = null; let customer: CustomerSnap | null = null;
  if (req.customer_id) {
    customerRow = (await customerPort().get(req.customer_id)) ?? fail(422, 'unknown_reference', 'customer_id', [{ path: 'customer_id', code: 'unknown_reference', message: 'no such customer' }]);
    if (!customerRow.is_active) fail(422, 'inactive_master', 'customer is inactive', [{ path: 'customer_id', code: 'inactive_master', message: 'inactive' }]);
    customer = snapOf(customerRow);
  } else if (req.customer) {
    const ex = await customerPort().byPhone(req.customer.phone);
    if (ex) fail(409, 'customer_phone_exists', 'a customer with this mobile already exists', undefined, { existing_customer: { customer_id: ex.id, name: ex.name } });
    customer = { customer_id: null, name: req.customer.name, phone: req.customer.phone, gstin: req.customer.gstin,
      state_code: req.customer.gstin ? req.customer.gstin.slice(0, 2) : req.customer.state_code, address: cleanAddress(req.customer.address), pan_on_file: false, pan_last4: null };
  }
  const supply_type = customer?.gstin ? 'b2b' : 'b2c';
  let pos: string;
  if (supply_type === 'b2b') {
    pos = customer!.gstin!.slice(0, 2);
    if (req.place_of_supply && req.place_of_supply !== pos)
      fail(422, 'place_of_supply_conflict', 'B2B place of supply is the GSTIN state', [{ path: 'place_of_supply', code: 'place_of_supply_conflict', message: `must be ${pos}` }]);
  } else pos = req.place_of_supply ?? customer?.state_code ?? sellerState;
  const gst_type = pos === sellerState ? 'intra' : 'inter';
  // --- salesperson (S21), cash counter
  if (req.salesperson_id) {
    const sp = await one<{ branch_id: string | null; is_active: boolean; is_salesperson: boolean }>(`SELECT branch_id, is_active, is_salesperson FROM hr.staff WHERE id = $1`, [req.salesperson_id]);
    if (!sp) fail(422, 'unknown_reference', 'salesperson_id', [{ path: 'salesperson_id', code: 'unknown_reference', message: 'no such staff' }]);
    if (!sp.is_active || !sp.is_salesperson || (sp.branch_id && sp.branch_id !== br.id))
      fail(422, 'inactive_master', 'salesperson is not eligible, inactive or of another branch', [{ path: 'salesperson_id', code: 'inactive_master', message: 'inactive or other branch' }]);
  }
  if (req.cash_counter_id) {
    const cc = await one<{ branch_id: string; is_active: boolean }>(`SELECT branch_id, is_active FROM accounts.cash_counter WHERE id = $1`, [req.cash_counter_id]);
    if (!cc || cc.branch_id !== br.id || !cc.is_active) fail(422, 'unknown_reference', 'cash_counter_id', [{ path: 'cash_counter_id', code: 'unknown_reference', message: 'no active cash counter of this branch' }]);
  }
  // --- tags (Inventory port): resolve numbers, lock on issue, sellable check
  const tagIds: string[] = [];
  for (const [i, l] of req.lines.entries()) if (l.kind === 'tag') {
    const id = l.tag_id ?? (await stockPort().findTag(l.tag_no!));
    if (!id) fail(404, 'not_found', `tag ${l.tag_no} not found`, [{ path: `lines[${i}].tag_no`, code: 'not_found', message: 'unknown tag' }]);
    if (tagIds.includes(id)) fail(422, 'duplicate_tag_in_bill', 'the same tag twice on one bill', [{ path: `lines[${i}]`, code: 'duplicate_tag_in_bill', message: 'duplicate' }]);
    tagIds.push(id);
  }
  const tags = await stockPort().tags(tagIds, mode === 'issue');
  for (const id of tagIds) {
    const t = tags.get(id);
    if (!t) fail(404, 'not_found', 'tag not found');
    stockPort().assertSellable(t, br.id, req.order?.tag_ids.includes(id) ?? false);
  }
  // --- purities, items, stones
  let ti = 0;
  const tagOf = req.lines.map((l) => (l.kind === 'tag' ? tags.get(tagIds[ti++])! : null));
  const purityIds = [...req.lines.map((l, i) => (l.kind === 'tag' ? tagOf[i]!.purity_id : l.purity_id)), ...req.old_metal.map((o) => o.purity_id)];
  const pur = await purities(purityIds);
  const itemIds = req.lines.map((l, i) => (l.kind === 'tag' ? tagOf[i]!.item_id : l.item_id));
  const items = new Map((await many<{ id: string; name: string; hsn: string; stock_type: string; mc_type: string; mc_value: string; wastage_type: string;
    wastage_value: string; min_mc: string; huid_charge: string; is_active: boolean; purity_id: string }>(
    `SELECT id, name, hsn, stock_type, mc_type, mc_value::text, wastage_type, wastage_value::text, min_mc::text, huid_charge::text, is_active, purity_id FROM masters.item WHERE id = ANY($1::uuid[])`,
    [[...new Set(itemIds)]])).map((r) => [r.id, r]));
  const stones = new Map<string, StoneSnap[]>();
  if (tagIds.length) for (const s of await many<{ tag_id: string; pieces: number; weight: string; weight_unit: string; amount: string; is_diamond: boolean; name: string | null }>(
    `SELECT ts.tag_id, ts.pieces, ts.weight::text, ts.weight_unit, ts.amount::text, ts.is_diamond, st.name FROM inventory.tag_stone ts
       LEFT JOIN masters.stone_standard st ON st.tenant_id = ts.tenant_id AND st.id = ts.stone_id WHERE ts.tag_id = ANY($1::uuid[]) ORDER BY ts.id`, [tagIds])) {
    const arr = stones.get(s.tag_id) ?? [];
    arr.push({ description: s.name ?? (s.is_diamond ? 'Diamond' : 'Stone'), pieces: s.pieces, weight: (s.weight_unit === 'cent' ? d(s.weight).dividedBy(100) : d(s.weight)).toFixed(3), unit: s.weight_unit === 'g' ? 'g' : 'ct', amount: m2(s.amount) });
    stones.set(s.tag_id, arr);
  }
  // --- rates (S4) + tax rules (S5 / S17)
  const rates_used: RateUsed[] = [];
  const missing: string[] = [];
  const saleRate = new Map<string, { id: string; rate_per_g: string }>();
  const orderApplied: { purity_code: string; today_rate_per_g: string; rate_per_g: string }[] = [];
  if (req.order?.locked_rate_per_g && new Set(req.lines.map((l, i) => (l.kind === 'tag' ? tagOf[i]!.purity_id : l.purity_id))).size > 1)
    fail(409, 'locked_rate_mixed_purity', 'the order has a locked rate but its pieces are of different purities; one locked rate cannot fit both');
  for (const pid of new Set(req.lines.map((l, i) => (l.kind === 'tag' ? tagOf[i]!.purity_id : l.purity_id)))) {
    const p = pur.get(pid);
    if (!p) fail(422, 'unknown_reference', 'purity_id', [{ path: 'lines', code: 'unknown_reference', message: `purity ${pid}` }]);
    const today = await todaysRate(pid, 'sale', br.id, day);
    if (!today) { missing.push(p.code); continue; }
    let r = today;
    const lk = req.order?.locked_rate_per_g;
    if (lk) {
      // O6: the order's locked rate (one rate per order). 'lower_of' never charges more than today's rate.
      const eff = req.order!.rate_rule === 'lower_of' && d(today.rate_per_g).lt(d(lk)) ? d(today.rate_per_g) : d(lk);
      r = { id: today.id, rate_per_g: eff.toFixed(2), effective_from: today.effective_from };
      orderApplied.push({ purity_code: p.code, today_rate_per_g: m2(today.rate_per_g), rate_per_g: m2(eff) });
    }
    saleRate.set(pid, r);
    rates_used.push({ kind: 'sale', metal_id: p.metal_id, purity_id: pid, purity_code: p.code, rate_id: r.id, rate_per_g: m2(r.rate_per_g), effective_from: r.effective_from });
  }
  if (missing.length) fail(409, 'todays_rates_missing', `today's sale rate is not published for ${missing.join(', ')}`);
  const zero = req.zero_gst !== null;
  const zeroRule = zero ? ((await ruleByCode('ZERO_RATED', day)) ?? fail(409, 'onboarding_incomplete', 'ZERO_RATED tax rule missing')) : null;
  const making_rule = await makingRule(shop, day);
  if (shop.making_gst_treatment === 'separate' && !making_rule) fail(409, 'onboarding_incomplete', 'no SAC rule for separately billed making');
  const metalRules = new Map<string, TaxRuleRef>();
  for (const p of pur.values()) if (!metalRules.has(p.metal_id) && req.lines.length) {
    const r = await metalRule({ code: p.metal_code, name: p.metal_name }, day);
    if (r) metalRules.set(p.metal_id, r);
  }
  const lines: LineFacts[] = req.lines.map((l, i) => {
    const pid = l.kind === 'tag' ? tagOf[i]!.purity_id : l.purity_id;
    const p = pur.get(pid)!; const it = items.get(itemIds[i]);
    if (!it) fail(422, 'unknown_reference', 'item_id', [{ path: `lines[${i}].item_id`, code: 'unknown_reference', message: 'no such item' }]);
    const rule = metalRules.get(p.metal_id) ?? fail(409, 'onboarding_incomplete', `no GST rule for metal ${p.metal_code} (onboarding gst_rates)`);
    const rate = saleRate.get(pid)!;
    if (l.kind === 'tag') {
      const t = tagOf[i]!;
      if (t.pieces < 1 || !d(t.gross_wt).gt(0)) fail(422, 'validation_failed', 'tag lines need positive pieces and gross weight',
        [{ path: `lines[${i}]`, code: 'invalid_weights', message: 'tag pieces >= 1 and gross_wt > 0' }]);
      const st = stones.get(t.id) ?? [];
      return { kind: 'tag', tag_id: t.id, tag_no: t.tag_no, item_id: t.item_id, sub_item_id: t.sub_item_id, purity_id: pid, purity_code: p.code, fineness: d(p.fineness).toFixed(3),
        description: it.name, hsn: t.hsn ?? it.hsn ?? rule.hsn_sac, huid: t.huid ? t.huid.toUpperCase() : null, pieces: t.pieces, gross_wt: t.gross_wt, stone_wt: t.stone_wt, net_wt: t.net_wt,
        wastage_pct: l.wastage_pct ?? t.wastage_pct ?? '0', wastage_range: t.min_wastage_pct !== null || t.max_wastage_pct !== null ? { min: t.min_wastage_pct, max: t.max_wastage_pct } : null,
        min_mc: it.min_mc, mc_type: (t.mc_type ?? 'per_gram') as LineFacts['mc_type'], mc_value: l.mc_value ?? t.mc_value ?? '0', list_mc_value: t.mc_value ?? '0',
        stones: st, stone_amount: m2(st.reduce((s, x) => s.plus(d(x.amount)), d(0))), hallmark_charge: t.huid_charge ?? '0', discount: l.discount ?? '0',
        rate_id: rate.id, rate_per_g: rate.rate_per_g, metal_rule: rule, min_sale_value: t.min_sale_value, max_sale_value: t.max_sale_value, counter_id: t.counter_id, tray_id: t.box_id };
    }
    if (!it.is_active) fail(422, 'inactive_master', 'item is inactive', [{ path: `lines[${i}].item_id`, code: 'inactive_master', message: 'inactive' }]);
    if (l.pieces === 0 && !d(l.net_wt).gt(0)) fail(422, 'validation_failed', 'zero-piece loose lines require positive net weight',
      [{ path: `lines[${i}].net_wt`, code: 'invalid_weights', message: 'must be positive when pieces is zero' }]);
    if (d(l.net_wt).gt(d(l.gross_wt))) fail(422, 'validation_failed', 'net_wt > gross_wt', [{ path: `lines[${i}].net_wt`, code: 'invalid', message: 'net_wt must be ≤ gross_wt' }]);
    const mcType = (l.mc_type ?? it.mc_type ?? 'per_gram') as LineFacts['mc_type'];
    const mcValue = l.mc_value ?? (l.mc_type && l.mc_type !== it.mc_type ? '0' : it.mc_value ?? '0');
    return { kind: 'loose', tag_id: null, tag_no: null, item_id: l.item_id, sub_item_id: l.sub_item_id, purity_id: pid, purity_code: p.code, fineness: d(p.fineness).toFixed(3),
      description: l.description ?? it.name, hsn: it.hsn ?? rule.hsn_sac, huid: l.huid, pieces: l.pieces, gross_wt: l.gross_wt, stone_wt: l.stone_wt, net_wt: l.net_wt,
      wastage_pct: l.wastage_pct ?? (it.wastage_type === 'percent' ? it.wastage_value : '0'), wastage_range: null, min_mc: it.min_mc, mc_type: mcType, mc_value: mcValue, list_mc_value: mcValue,
      stones: [], stone_amount: l.stone_amount ?? '0', hallmark_charge: l.hallmark_charge ?? '0', discount: l.discount ?? '0', rate_id: rate.id, rate_per_g: rate.rate_per_g,
      metal_rule: rule, min_sale_value: null, max_sale_value: null, counter_id: l.counter_id, tray_id: l.tray_id };
  });
  // --- old gold (S6)
  if (req.old_metal.length && !shop.old_gold_enabled) fail(422, 'validation_failed', 'old gold exchange is turned off in sales settings', [{ path: 'old_metal', code: 'old_gold_disabled', message: 'disabled' }]);
  const old: OldGoldFacts[] = [];
  for (const [i, o] of req.old_metal.entries()) {
    const p = pur.get(o.purity_id) ?? fail(422, 'unknown_reference', 'purity_id', [{ path: `old_metal[${i}].purity_id`, code: 'unknown_reference', message: 'no such purity' }]);
    if (d(o.less_wt).gt(d(o.gross_wt))) fail(422, 'validation_failed', 'less_wt > gross_wt', [{ path: `old_metal[${i}].less_wt`, code: 'invalid', message: 'must be ≤ gross_wt' }]);
    let ratePurity = p;
    if (shop.old_gold_valuation_basis === 'fine_24k') {
      const top = await one<{ id: string }>(`SELECT id FROM masters.purity WHERE metal_id = $1 AND is_active ORDER BY fineness DESC LIMIT 1`, [p.metal_id]);
      ratePurity = (top && (await purities([top.id])).get(top.id)) || p;
    }
    const r = await todaysRate(ratePurity.id, 'old_metal', br.id, day);
    if (!r) fail(409, 'todays_rates_missing', `today's old-metal rate is not published for ${ratePurity.code}`);
    if (!rates_used.some((x) => x.rate_id === r.id))
      rates_used.push({ kind: 'old_metal', metal_id: ratePurity.metal_id, purity_id: ratePurity.id, purity_code: ratePurity.code, rate_id: r.id, rate_per_g: m2(r.rate_per_g), effective_from: r.effective_from });
    old.push({ purity_id: p.id, purity_code: p.code, description: o.description, gross_wt: o.gross_wt, less_wt: o.less_wt,
      touch_pct: o.touch_pct ?? pctOf(p.fineness).toDecimalPlaces(3).toString(), valuation_basis: shop.old_gold_valuation_basis, rate_id: r.id,
      server_rate: r.rate_per_g, rate_override: o.rate_override, override_reason: o.override_reason });
  }
  let result: BillResult;
  try {
    result = computeBill({ gst_type, zero_gst: zero, settings: engineSettings(shop, roundOff), making_rule, zero_rule: zeroRule,
      lines, bill_discount: req.bill_discount, old_metal: old, payments: req.payments });
  } catch (e) {
    if (e instanceof PricingError) fail(422, 'validation_failed', e.message, [{ path: e.path, code: 'invalid', message: e.message }]);
    throw e;
  }
  return { req, mode, day, making_floors: lines.map((l) => m2(l.min_mc ?? 0)), shop, roundOff, branch: { id: br.id, code: br.code, company_id: br.company_id }, seller, customer, customerRow, supply_type, gst_type,
    place_of_supply: pos, rates_used, result, tags, making_rule, requirements: {}, warnings: [], payments: req.payments, computed_at: '',
    order_rate: req.order?.locked_rate_per_g ? { order_id: req.order.order_id, rule: req.order.rate_rule, locked_rate_per_g: m2(req.order.locked_rate_per_g), applied: orderApplied } : null };
}

/** Requirements + warnings (BillRequirements / SalesWarning). enforce = issue: unmet requirements throw. */
export async function judge(a: SalesActor, p: Prepared, enforce: boolean): Promise<void> {
  const f = p.result.flags; const t = p.result.totals; const s = p.shop; const req = p.req;
  const W = (code: string, message: string, path: string | null = null) => p.warnings.push({ code, message, path });
  const panOnFile = p.customer?.pan_on_file ?? false;
  const cashExceeded = d(t.cash_amount).gte(d(s.cash_limit_amount));
  p.requirements = {
    pan_required: f.pan_required, pan_on_file: panOnFile,
    cash_limit: { limit: m2(s.cash_limit_amount), mode: s.cash_limit_mode, cash_amount: t.cash_amount, exceeded: cashExceeded },
    discount_permission: f.discount_present, override_min_permission: f.override_min_needed, zero_gst_permission: req.zero_gst !== null,
    credit_sale_permission: p.mode !== 'estimate' && f.credit_sale, old_gold_rate_override_permission: f.rate_override,
  };
  if (f.large_discount) W('large_discount', `discount is ${f.discount_pct}% of the bill value (warning at ${s.discount_warn_pct}%)`, 'bill_discount');
  for (const path of f.below_minimum) W('below_minimum_price', 'priced below the tag minimum / outside the wastage range', path);
  for (const path of f.above_maximum) W('tag_above_max_price', 'priced above the tag maximum', path);
  if (req.zero_gst) W('zero_gst', `${s.zero_gst_print_note}: ${req.zero_gst.reason}`, 'zero_gst');
  if (p.mode !== 'estimate' && d(t.balance_due).gt(0)) W('balance_due', `₹${t.balance_due} will remain due`, 'payments');
  if (f.old_gold_exceeds_bill) W('old_gold_excess', `old gold exceeds the bill by ₹${t.old_gold_excess}`, 'old_metal');
  if (cashExceeded && (s.cash_limit_mode === 'warn' || !enforce))
    W('cash_limit_exceeded', `cash ₹${t.cash_amount} on one bill is at or above ₹${m2(s.cash_limit_amount)} (s.269ST)`, 'payments');
  if (!enforce && f.pan_required && !panOnFile && !req.pan) W('pan_required', `PAN is required above ₹${m2(s.pan_required_above)}`, 'pan');
  // issue, preview and estimates: a rate override needs the permission (contract 0.9.1: wherever OldGoldInput is accepted)
  if (f.rate_override && !has(a, 'sales.old_gold.rate_override'))
    fail(403, 'old_gold_rate_override_not_allowed', 'old-gold rate override needs sales.old_gold.rate_override');
  if (!enforce) return;
  if (f.discount_present && !has(a, 'sales.discount.give')) fail(403, 'discount_not_allowed', 'discounts need sales.discount.give');
  if (f.override_min_needed) {
    if (!has(a, 'sales.price.override_min')) fail(403, 'below_minimum_needs_override', 'below the tag minimum / wastage range or above the discount limit: needs sales.price.override_min');
    if (!req.discount_reason) fail(422, 'discount_reason_required', 'a discount reason is required', [{ path: 'discount_reason', code: 'required', message: 'required' }]);
  }
  if (req.zero_gst && !has(a, 'sales.invoice.zero_gst')) fail(403, 'zero_gst_not_allowed', '0% GST needs sales.invoice.zero_gst');
  if (f.old_gold_exceeds_bill) {
    if (s.old_gold_excess_handling === 'separate_purchase') fail(422, 'old_gold_exceeds_bill', 'old gold is worth more than the bill: buy it as a separate purchase (S33)');
    if (!req.old_gold_excess_payout) fail(422, 'old_gold_payout_required', 'old_gold_excess_payout (cash / bank_transfer) is required', [{ path: 'old_gold_excess_payout', code: 'required', message: 'required' }]);
  }
  if (f.overpayment) fail(422, 'overpayment', `payments exceed the net payable ₹${t.net_payable}`);
  if (f.credit_sale && !has(a, 'sales.invoice.credit_sale')) fail(403, 'credit_sale_not_allowed', 'an unpaid (credit) bill needs sales.invoice.credit_sale');
  if (f.pan_required && !panOnFile && !req.pan) fail(422, 'pan_required', `PAN is required for bills above ₹${m2(s.pan_required_above)}`, [{ path: 'pan', code: 'required', message: 'required' }]);
  if (cashExceeded && s.cash_limit_mode === 'block')
    fail(422, 'cash_limit_exceeded', `cash on one bill must stay below ₹${m2(s.cash_limit_amount)} (s.269ST)`, [{ path: 'payments', code: 'cash_limit_exceeded', message: 'over the cash limit' }]);
  if (req.expected_total !== null && m2(req.expected_total) !== t.net_payable)
    fail(422, 'expected_total_mismatch', `server net payable is ${t.net_payable}`, [{ path: 'expected_total', code: 'expected_total_mismatch', message: `server: ${t.net_payable}` }]);
}
/** Contract PricedLine (engine-only fields dropped). */
export const publicLine = (l: BillResult['lines'][number]) => {
  const { _line_discount, _tax_rule_id, _hsn_sac_applied, _composite, ...rest } = l;
  void _line_discount; void _tax_rule_id; void _hsn_sac_applied; void _composite;
  return rest;
};
/** Contract BillComputation. */
export function computation(p: Prepared): Record<string, unknown> {
  return { branch_id: p.branch.id, supply_type: p.supply_type, gst_type: p.gst_type, place_of_supply: p.place_of_supply, seller: p.seller, customer: p.customer,
    making_gst_treatment: p.shop.making_gst_treatment, zero_gst: p.req.zero_gst !== null, rates_used: p.rates_used, lines: p.result.lines.map(publicLine),
    old_metal: p.result.old_metal, tax_summary: p.result.tax_summary, totals: p.result.totals, requirements: p.requirements, warnings: p.warnings,
    computed_at: p.computed_at };
}
export const nowIso = async (): Promise<string> => (await one<{ t: string }>(`SELECT ${iso('now()', 't')}`))!.t;
