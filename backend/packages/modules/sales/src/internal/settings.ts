import { isReleaseRenderablePin, releasePinFor } from '@jw/db';
import { one, asWriter, audit } from './db';
import { fail, checkVersion } from './errors';
import { type SalesActor, need } from './actor';
import { V, RX, type Obj } from './validate';
import { d, m2 } from './num';
import type { EngineSettings } from './engine';

/**
 * S5/S6/S7/S8/S10/S11/S13/S16/S17/S19 settings: sales.shop_setting (991, one row per shop, no row = column defaults) is the single source.
 * masters.sales_policy and platform.setting sales.pan_required_above / invoice.rounding are deprecated and NOT read.
 * round_off_to comes from masters.gst_config (effective today); print language/numerals come from the first-print pinned (initially active) branding template.
 * Shop fields use PATCH /v1/sales/settings (sales.settings.edit, owner; If-Match); effective print metadata is read-only there.
 */
export interface ShopSettings {
  making_gst_treatment: 'composite' | 'separate'; making_tax_rule_code: string | null; making_service_rate: string | null;
  credit_note_rounding: 'follow_invoice' | 'exact'; pan_required_above: string; cash_limit_amount: string; cash_limit_mode: 'warn' | 'block';
  discount_warn_pct: string; discount_override_pct: string; zero_gst_print_note: string; estimate_validity_days: number;
  default_paper: 'A4' | 'A5' | 'thermal_80mm'; return_window_days: number; return_refund_default: 'store_credit' | 'cash' | 'bank_transfer';
  old_gold_enabled: boolean; old_gold_valuation_basis: 'stated_purity' | 'fine_24k'; old_gold_excess_handling: 'refund_on_bill' | 'separate_purchase';
  estimate_no_format: string; receipt_no_format: string; version: number | null;
}
export const DEFAULTS: ShopSettings = {
  making_gst_treatment: 'composite', making_tax_rule_code: null, making_service_rate: null, credit_note_rounding: 'follow_invoice',
  pan_required_above: '200000.00', cash_limit_amount: '200000.00', cash_limit_mode: 'block', discount_warn_pct: '5.00', discount_override_pct: '10.00',
  zero_gst_print_note: 'GST charged at 0%', estimate_validity_days: 0, default_paper: 'A4', return_window_days: 15, return_refund_default: 'store_credit',
  old_gold_enabled: true, old_gold_valuation_basis: 'stated_purity', old_gold_excess_handling: 'separate_purchase',
  estimate_no_format: 'EST-{BRANCH}-{FY}-{SEQ:5}', receipt_no_format: 'RCT-{BRANCH}-{FY}-{SEQ:5}', version: null,
};
const COLS = `making_gst_treatment, making_tax_rule_code, making_service_rate::text, credit_note_rounding, pan_required_above::text,
  cash_limit_amount::text, cash_limit_mode, discount_warn_pct::text, discount_override_pct::text, zero_gst_print_note, estimate_validity_days,
  default_paper, return_window_days, return_refund_default, old_gold_enabled, old_gold_valuation_basis, old_gold_excess_handling,
  estimate_no_format, receipt_no_format, version`;

export async function loadShop(): Promise<ShopSettings> {
  return (await one<ShopSettings>(`SELECT ${COLS} FROM sales.shop_setting`)) ?? { ...DEFAULTS };
}
/** masters.gst_config.round_off_to in force on `day` (IST date), default 1.00. */
export async function roundOffTo(day: string): Promise<string> {
  const r = await one<{ v: string }>(`SELECT round_off_to::text AS v FROM masters.gst_config
      WHERE effective_from <= $1::date AND (effective_to IS NULL OR effective_to > $1::date) ORDER BY effective_from DESC LIMIT 1`, [day]);
  return r ? m2(r.v) : '1.00';
}
// Resolve one whole active row: tenant → that tenant's partner → platform, irrespective of versions across scopes.
// Ordinary tenant RLS permits this exact chain; never impersonate a partner or combine fields from different rows.
type TemplatePin = { template_id: string | null; template_version: number | null };
/**
 * Effective print template. pinned = an existing ORIGINAL pin (never substituted). Otherwise the active template by precedence
 * tenant > own partner > platform. 0.9.6 1(a): an active tenant/partner (or any) template that is not an exact release pin is
 * SKIPPED and the doc type's 998 platform default (v1) is used instead (fallback_from says what was skipped); only when that
 * platform default itself is missing or inactive is the print refused with 422 print_template_not_renderable.
 */
export async function printDefaults(docType = 'invoice', pinned?: TemplatePin & { language?: string | null; numerals?: string | null } | null): Promise<{ language: string; numerals: string; template_id: string | null; template_version: number | null; fallback_from: TemplatePin | null }> {
  type Tpl = { id: string; version: number; numeral_system: string; print_language: string };
  const t = await one<{ l: string; partner_id: string | null }>(`SELECT default_language AS l, partner_id FROM platform.tenant WHERE id = platform.current_tenant()`);
  let tpl = pinned?.template_id ? await one<Tpl>(
    `SELECT id, version, numeral_system, print_language FROM branding.print_template WHERE id = $1 AND version = $2 AND doc_type = $3`, [pinned.template_id, pinned.template_version, docType]) : pinned ? undefined : await one<Tpl>(
    `SELECT id, version, numeral_system, print_language FROM branding.print_template WHERE doc_type = $1 AND is_active
      AND ((scope = 'tenant' AND tenant_id = platform.current_tenant())
        OR (scope = 'partner' AND partner_id = $2::uuid)
        OR scope = 'platform')
      ORDER BY CASE scope WHEN 'tenant' THEN 0 WHEN 'partner' THEN 1 ELSE 2 END LIMIT 1`, [docType, t?.partner_id ?? null]);
  if (pinned?.template_id && !tpl) fail(422, 'pinned_print_template_unavailable', 'the first print template is unavailable; refusing a different active template');
  let fallbackFrom: TemplatePin | null = null;
  if (!pinned && tpl && !isReleaseRenderablePin(docType, tpl.id, tpl.version)) {
    const skipped = { template_id: tpl.id, template_version: tpl.version };
    const target = releasePinFor(docType);
    const platform = target ? await one<Tpl>(`SELECT id, version, numeral_system, print_language FROM branding.print_template
      WHERE id = $1 AND version = $2 AND doc_type = $3 AND scope = 'platform' AND is_active`, [target.template_id, target.version, docType]) : undefined;
    if (!platform) fail(422, 'print_template_not_renderable',
      `the active ${docType} template ${tpl.id} v${tpl.version} cannot be rendered in this release and no active platform default exists to fall back to; no print was logged`,
      [{ path: 'template_id', code: 'print_template_not_renderable', message: target ? `platform default ${target.template_id} v${target.version} is missing or inactive` : `no release pin for doc_type ${docType}` }],
      { unrenderable_template: skipped });
    fallbackFrom = skipped; tpl = platform;
  }
  return { language: pinned?.language ?? tpl?.print_language ?? (t?.l === 'ta' ? 'ta' : 'en'), numerals: pinned?.numerals ?? tpl?.numeral_system ?? 'latin', template_id: tpl?.id ?? null, template_version: tpl?.version ?? null, fallback_from: fallbackFrom };
}
export function engineSettings(s: ShopSettings, roundOff: string): EngineSettings {
  return { making_gst_treatment: s.making_gst_treatment, making_service_rate: s.making_service_rate, round_off_to: roundOff,
    discount_warn_pct: s.discount_warn_pct, discount_override_pct: s.discount_override_pct, pan_required_above: s.pan_required_above,
    cash_limit_amount: s.cash_limit_amount, cash_limit_mode: s.cash_limit_mode, old_gold_excess_handling: s.old_gold_excess_handling };
}
const pctOut = (s: string): string => d(s).toString();
/** Contract SalesSettings (0.9.2). */
export async function getSettings(day: string): Promise<Obj> {
  const s = await loadShop();
  const p = await printDefaults();
  if (!['en', 'ta'].includes(p.language)) fail(422, 'validation_failed', 'print_language supports en/ta only in0.9.5', [{ path: 'print_language', code: 'invalid', message: 'edit the active branding template; choose en or ta' }]);
  return {
    making_gst_treatment: s.making_gst_treatment, making_tax_rule_code: s.making_tax_rule_code,
    making_service_rate: s.making_service_rate === null ? null : m2(s.making_service_rate),
    old_gold_enabled: s.old_gold_enabled, old_gold_valuation_basis: s.old_gold_valuation_basis, old_gold_excess_handling: s.old_gold_excess_handling,
    return_window_days: s.return_window_days, return_settlement_default: s.return_refund_default, credit_note_rounding: s.credit_note_rounding,
    round_off_to: await roundOffTo(day), pan_required_above: m2(s.pan_required_above), cash_limit_amount: m2(s.cash_limit_amount),
    cash_limit_mode: s.cash_limit_mode, discount_max_pct: pctOut(s.discount_override_pct), large_discount_pct: pctOut(s.discount_warn_pct),
    default_paper: s.default_paper, print_language: p.language, print_numerals: p.numerals, zero_gst_print_note: s.zero_gst_print_note,
    estimate_validity_days: s.estimate_validity_days, estimate_no_format: s.estimate_no_format, receipt_no_format: s.receipt_no_format,
    version: s.version ?? 0,
  };
}
/** The shop rate must split into equal CGST / SGST halves of 2 dp (invoice_line_tax: cgst_rate + sgst_rate = rate, numeric(5,2)). */
export const evenSplit = (rate: string): boolean => d(rate).times(100).mod(2).isZero();
const FORMAT_RX = /^[A-Za-z0-9{}:\/_-]{1,64}$/;
function docFormatOk(v: string): boolean {
  const seq = v.match(/\{SEQ(?::([1-9][0-9]?))?\}/g) ?? [];
  return FORMAT_RX.test(v) && seq.length === 1 && /\{SEQ(?::[1-9][0-9]?)?\}$/.test(v)
    && !/[{}]/.test(v.replace(/\{SEQ(?::[1-9][0-9]?)?\}|\{BRANCH\}|\{FY\}/g, ''));
}
const EDITABLE = ['making_gst_treatment', 'making_tax_rule_code', 'making_service_rate', 'old_gold_enabled', 'old_gold_valuation_basis',
  'old_gold_excess_handling', 'return_window_days', 'return_settlement_default', 'credit_note_rounding', 'pan_required_above', 'cash_limit_amount',
  'cash_limit_mode', 'discount_max_pct', 'large_discount_pct', 'default_paper', 'zero_gst_print_note', 'estimate_validity_days',
  'estimate_no_format', 'receipt_no_format'];
/** PATCH /v1/sales/settings (0.9.2): sales.settings.edit (owner only, 991). If-Match = current version (required once a row exists). */
export async function patchSettings(a: SalesActor, body: unknown, ifVersion: number | undefined, day: string): Promise<Obj> {
  need(a, 'sales.settings.edit');
  if (ifVersion === undefined) fail(428, 'precondition_required', 'If-Match is required (0 for defaults)');
  // No row exists at version 0; a tenant-scoped advisory lock also serialises concurrent first inserts.
  await one(`SELECT pg_advisory_xact_lock(hashtextextended('sales.settings:' || platform.current_tenant()::text, 0))`);
  const v = new V();
  if (body && typeof body === 'object' && 'print_language' in body && !['en', 'ta'].includes(String((body as Obj).print_language)))
    fail(422, 'validation_failed', 'print_language supports en/ta only; edit the branding template', [{ path: 'print_language', code: 'invalid', message: 'choose en or ta' }]);
  const b = v.obj(body, '', EDITABLE);
  if (Object.keys(b).length === 0) v.err('$', 'empty patch');
  const set: Record<string, unknown> = {};
  const put = (col: string, val: unknown) => { if (val !== undefined) set[col] = val; };
  put('making_gst_treatment', v.oneOf(b.making_gst_treatment, 'making_gst_treatment', ['composite', 'separate'] as const, { optional: true }));
  put('making_tax_rule_code', v.str(b.making_tax_rule_code, 'making_tax_rule_code', { optional: true, nullable: true, min: 1, max: 40 }));
  const msr = v.dec(b.making_service_rate, 'making_service_rate', RX.taxRate, { optional: true, nullable: true, max: '100', positive: true });
  if (typeof msr === 'string' && !evenSplit(msr)) v.err('making_service_rate', 'must split into equal CGST / SGST halves (e.g. 18.00, 5.00, 12.50)');
  put('making_service_rate', msr);
  put('old_gold_enabled', v.bool(b.old_gold_enabled, 'old_gold_enabled', { optional: true }));
  put('old_gold_valuation_basis', v.oneOf(b.old_gold_valuation_basis, 'old_gold_valuation_basis', ['stated_purity', 'fine_24k'] as const, { optional: true }));
  put('old_gold_excess_handling', v.oneOf(b.old_gold_excess_handling, 'old_gold_excess_handling', ['refund_on_bill', 'separate_purchase'] as const, { optional: true }));
  put('return_window_days', v.int(b.return_window_days, 'return_window_days', { min: 0, max: 365, optional: true }));
  put('return_refund_default', v.oneOf(b.return_settlement_default, 'return_settlement_default', ['store_credit', 'cash', 'bank_transfer'] as const, { optional: true }));
  put('credit_note_rounding', v.oneOf(b.credit_note_rounding, 'credit_note_rounding', ['follow_invoice', 'exact'] as const, { optional: true }));
  put('pan_required_above', v.dec(b.pan_required_above, 'pan_required_above', RX.money, { optional: true, positive: true }));
  put('cash_limit_amount', v.dec(b.cash_limit_amount, 'cash_limit_amount', RX.money, { optional: true, positive: true }));
  put('cash_limit_mode', v.oneOf(b.cash_limit_mode, 'cash_limit_mode', ['warn', 'block'] as const, { optional: true }));
  put('discount_override_pct', v.dec(b.discount_max_pct, 'discount_max_pct', RX.pct, { optional: true, max: '100' }));
  put('discount_warn_pct', v.dec(b.large_discount_pct, 'large_discount_pct', RX.pct, { optional: true, max: '100' }));
  put('default_paper', v.oneOf(b.default_paper, 'default_paper', ['A4', 'A5', 'thermal_80mm'] as const, { optional: true }));
  put('zero_gst_print_note', v.str(b.zero_gst_print_note, 'zero_gst_print_note', { optional: true, trim: true, min: 1, max: 200 }));
  put('estimate_validity_days', v.int(b.estimate_validity_days, 'estimate_validity_days', { min: 0, max: 30, optional: true }));
  for (const k of ['estimate_no_format', 'receipt_no_format'] as const) {
    const f = v.str(b[k], k, { optional: true, min: 1, max: 64 });
    if (typeof f === 'string' && !docFormatOk(f)) v.err(k, 'one {SEQ} or {SEQ:n} at the end; only {BRANCH} and {FY} tokens; letters, digits, - / _');
    put(k, f);
  }
  v.done();
  const cur = await loadShop();
  const next = { ...cur, ...set } as ShopSettings;
  if (d(next.discount_warn_pct).gt(d(next.discount_override_pct)))
    fail(422, 'validation_failed', 'large_discount_pct must be ≤ discount_max_pct', [{ path: 'large_discount_pct', code: 'invalid', message: 'must be ≤ discount_max_pct' }]);
  if (next.making_tax_rule_code) {
    const r = await one(`SELECT 1 FROM masters.tax_rule WHERE code = $1 AND (tenant_id IS NULL OR tenant_id = platform.current_tenant())`, [next.making_tax_rule_code]);
    if (!r) fail(422, 'unknown_reference', 'making_tax_rule_code is not a tax rule', [{ path: 'making_tax_rule_code', code: 'unknown_reference', message: 'no such tax rule' }]);
  }
  if (cur.version === null) {
    if (ifVersion !== undefined) checkVersion('sales settings', 0, ifVersion);
    const cols = Object.keys(set);
    await one(`INSERT INTO sales.shop_setting(tenant_id, updated_by${cols.map((c) => `, ${c}`).join('')})
        VALUES (platform.current_tenant(), $1${cols.map((_, i) => `, $${i + 2}`).join('')})`, [a.userId, ...cols.map((c) => set[c])]);
  } else {
    if (ifVersion === undefined) fail(428, 'precondition_required', 'If-Match is required');
    checkVersion('sales settings', cur.version, ifVersion);
    const cols = Object.keys(set);
    await one(`UPDATE sales.shop_setting SET updated_by = $1, updated_at = now()${cols.map((c, i) => `, ${c} = $${i + 2}`).join('')}`,
      [a.userId, ...cols.map((c) => set[c])]);
  }
  await audit('sales.settings.update', 'sales.shop_setting', null, { changed: Object.keys(set) });
  return getSettings(day);
}
export { asWriter };
