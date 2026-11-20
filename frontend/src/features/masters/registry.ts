import { MASTER_AREA, PARTY_AREA, mastersManage, mastersView, type MasterArea } from '@/lib/permissions';
import { D } from '@/lib/format/decimal';
import { parseDecimalInput } from '@/lib/format/number';
import {
  ItemInputStockType, ItemInputWastageType, McType, PaymentModeInputKind, StoneStandardKind,
  ValueAdditionRuleInputScope, ValueAdditionRuleInputTier, VendorKind,
} from '@/lib/api/backend/model';
import type { FieldValue, MasterInput, MasterKind, MasterRow } from './types';

/**
 * One config per master drives the shared list-and-form screen, the mock server's validation and the tests.
 * Field keys are the contract 0.7.0 *Input property names (dotted = nested object, e.g. address.city).
 * Labels/hints are i18n keys `masters.f.<key>` / `masters.h.<key>`; select options `masters.o.<options>.<value>`.
 * Keep the basic form SHORT: what a shop rarely needs is `advanced` (tucked under "More details").
 */
export type FieldType = 'text' | 'code' | 'decimal' | 'int' | 'select' | 'multi' | 'ref' | 'phone' | 'gstin' | 'pan' | 'secret' | 'date' | 'bool' | 'hsn' | 'file';
/** ref targets: another master (optionally `stone_standards:<kind>`), or the existing metals / purities / branches / bank accounts. */
export type RefTarget = MasterKind | `stone_standards:${StoneStandardKind}` | 'metal' | 'purity' | 'branch' | 'bank_account';
export interface FieldDef {
  key: string; type: FieldType; required?: boolean; advanced?: boolean; hint?: boolean;
  /** select / multi: values, and the i18n group for their labels (masters.o.<optionsKey>.<value>). */
  options?: readonly string[]; optionsKey?: string; ref?: RefTarget; default?: FieldValue;
  /** decimal: max dp, and an inclusive max (percent ≤ 100). */
  dp?: number; max?: string; pattern?: RegExp;
  /** Used as a list filter; `param` when the list query name differs from the field key (vendors: kinds → kind). */
  filter?: boolean; param?: string;
  /** secret: the row carries only `<last4Key>` (PAN is write-only). */
  last4Key?: string;
  /** Contract `x-field-group`: rendered together under a plain section heading (masters.fg.<group>). */
  group?: FieldGroup;
  /** text: max length (staff department/designation: 100). */
  maxLen?: number;
  /** Create-only (sub-item item_id: SubItemPatch has no item_id); hidden when editing. */
  createOnly?: boolean;
  /** Not shown in the form; set from MasterForm's `preset` (KYC document party_type / party_id). */
  hidden?: boolean;
  /** file: POST /v1/files purpose; the field value is the returned file id. */
  purpose?: 'design_photo' | 'staff_photo' | 'kyc_document';
  /** Initial form value derived from the row when the input key is not a row field (customers kyc_consent ← consent_at). */
  fromRow?: (row: MasterRow) => FieldValue;
}
export const FIELD_GROUPS = ['making_charge', 'wastage'] as const;
export type FieldGroup = (typeof FIELD_GROUPS)[number];
export interface MasterConfig {
  kind: MasterKind; mid: string; fields: FieldDef[]; columns: string[];
  /** Field shown as the row's name in the drawer title and buttons. */
  title: string; photos?: boolean; percentKeys?: string[];
  /** Server-set timestamps shown read-only in the form and never sent (customers consent_at). */
  readOnlyAt?: string[];
}
/** masters.<area>.manage writes, masters.<area>.view reads (contract 0.7.0). KYC documents follow their party. */
export type KycPartyType = keyof typeof PARTY_AREA;
const areaOf = (kind: MasterKind, party: KycPartyType = 'customer'): MasterArea =>
  kind === 'kyc_documents' ? PARTY_AREA[party] : MASTER_AREA[kind];
export const editPermOf = (kind: MasterKind, party?: KycPartyType) => mastersManage(areaOf(kind, party));
export const viewPermOf = (kind: MasterKind, party?: KycPartyType) => mastersView(areaOf(kind, party));

/** Indian mobile, as the backend checks it: 10 digits starting 6–9 (spaces, dashes and a +91 / 91 prefix are stripped first). */
export const PHONE = /^[6-9]\d{9}$/;
export const normalisePhone = (s: string) => s.replace(/[\s-]/g, '').replace(/^\+?91(?=\d{10}$)/, '');
const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PAN = /^[A-Z]{5}\d{4}[A-Z]$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const HSN = /^\d{4}(\d{2}){0,2}$/;
const CODE = /^[A-Z0-9][A-Z0-9_-]{0,19}$/;
const vals = <T extends Record<string, string>>(o: T) => Object.values(o) as string[];
const name: FieldDef = { key: 'name', type: 'text', required: true };
const code: FieldDef = { key: 'code', type: 'code', required: true, hint: true };
const branch: FieldDef = { key: 'branch_id', type: 'ref', ref: 'branch', required: true, filter: true };
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const mcType = (advanced = true): FieldDef => ({ key: 'mc_type', type: 'select', options: vals(McType), optionsKey: 'mc_type', advanced, hint: true });

/** Suggest a code from the name (A–Z, 0–9, up to 20). Tamil-only names give '' and the field stays required. */
/**
 * KYC document types (Adithya: no Aadhaar at all). Contract 0.7.0 kyc_documents.doc_type uses these; labels are
 * masters.o.kyc_type.<value>, ready for the customer KYC form when it lands.
 */
export const KYC_TYPES = ['pan', 'passport', 'voter_id', 'driving_licence', 'gstin_certificate', 'other'] as const;
export type KycType = (typeof KYC_TYPES)[number];

export const MASTERS: Record<MasterKind, MasterConfig> = {
  items: { kind: 'items', mid: 'M3', title: 'name', columns: ['code', 'name', 'metal_id', 'purity_id', 'hsn'], fields: [
    name, code, { key: 'metal_id', type: 'ref', ref: 'metal', required: true, filter: true },
    { key: 'purity_id', type: 'ref', ref: 'purity', required: true },
    { key: 'hsn', type: 'hsn', required: true, default: '7113', advanced: true, hint: true },
    { key: 'stock_type', type: 'select', options: vals(ItemInputStockType), optionsKey: 'stock_type', required: true, default: 'tag', advanced: true, hint: true },
    mcType(), { key: 'mc_value', type: 'decimal', dp: 2, advanced: true, hint: true }, { key: 'min_mc', type: 'decimal', dp: 2, advanced: true },
    { key: 'wastage_type', type: 'select', options: vals(ItemInputWastageType), optionsKey: 'wastage_type', advanced: true },
    { key: 'wastage_value', type: 'decimal', dp: 3, advanced: true, hint: true },
    { key: 'huid_charge', type: 'decimal', dp: 2, advanced: true },
    { key: 'default_counter_id', type: 'ref', ref: 'counters', advanced: true },
    { key: 'short_code', type: 'code', pattern: /^[A-Z0-9]{1,10}$/, advanced: true, hint: true },
    { key: 'allow_zero_weight', type: 'bool', default: false, advanced: true, hint: true },
  ] },
  // 0.7.1: designs lost hsn/measurement/MC (those live on sub-items) and gained catalogue fields.
  designs: { kind: 'designs', mid: 'M4', title: 'name', photos: true, columns: ['code', 'name', 'item_id', 'sub_item_id'], fields: [
    name, { ...code, pattern: /^[A-Za-z0-9][A-Za-z0-9._/-]{0,29}$/ }, { key: 'item_id', type: 'ref', ref: 'items', required: true, filter: true },
    { key: 'sub_item_id', type: 'ref', ref: 'sub_items', filter: true },
    { key: 'purity_id', type: 'ref', ref: 'purity', advanced: true },
    { key: 'designer_id', type: 'ref', ref: 'vendors', advanced: true },
    { key: 'approx_gross_wt', type: 'decimal', dp: 3, advanced: true }, { key: 'approx_net_wt', type: 'decimal', dp: 3, advanced: true },
    { key: 'approx_stone_wt', type: 'decimal', dp: 3, advanced: true },
    { key: 'size', type: 'text', maxLen: 30, advanced: true }, { key: 'description', type: 'text', maxLen: 2000, advanced: true },
  ] },
  stone_standards: { kind: 'stone_standards', mid: 'M5', title: 'name', columns: ['kind', 'code', 'name', 'cent_from', 'cent_to'], fields: [
    { key: 'kind', type: 'select', options: vals(StoneStandardKind), optionsKey: 'stone_kind', required: true, default: 'stone', filter: true, hint: true },
    name, code,
    { key: 'cent_from', type: 'decimal', dp: 3, advanced: true, hint: true }, { key: 'cent_to', type: 'decimal', dp: 3, advanced: true },
  ] },
  // 0.7.1: a rate is for a stone or a cent group (at least one; 422 stone_or_cent_group_required), per carat or per piece.
  stone_rates: { kind: 'stone_rates', mid: 'M5', title: 'sale_rate', columns: ['stone_id', 'cent_group_id', 'rate_unit', 'sale_rate', 'effective_from'], fields: [
    { key: 'stone_id', type: 'ref', ref: 'stone_standards:stone', filter: true, hint: true },
    { key: 'cent_group_id', type: 'ref', ref: 'stone_standards:cent_group', filter: true },
    { key: 'rate_unit', type: 'select', options: ['per_ct', 'per_piece'], optionsKey: 'rate_unit', default: 'per_ct' },
    { key: 'sale_rate', type: 'decimal', dp: 2, required: true, hint: true },
    { key: 'effective_from', type: 'date', required: true, default: null },
    { key: 'effective_to', type: 'date', advanced: true },
    { key: 'shape_id', type: 'ref', ref: 'stone_standards:shape', advanced: true },
    { key: 'clarity_id', type: 'ref', ref: 'stone_standards:clarity', advanced: true },
    { key: 'colour_id', type: 'ref', ref: 'stone_standards:colour', advanced: true },
    { key: 'cut_id', type: 'ref', ref: 'stone_standards:cut', advanced: true },
    { key: 'vendor_id', type: 'ref', ref: 'vendors', advanced: true },
    { key: 'purchase_rate', type: 'decimal', dp: 2, advanced: true },
  ] },
  // M6 making charge + M7 wastage share one rule row (contract: value-addition-rules).
  value_addition_rules: { kind: 'value_addition_rules', mid: 'M6 · M7', title: 'weight_from', percentKeys: ['wastage_pct', 'touch', 'mc_percent'],
    columns: ['item_id', 'weight_from', 'weight_to', 'wastage_pct', 'mc_per_gram'], fields: [
      { key: 'item_id', type: 'ref', ref: 'items', filter: true, hint: true },
      { key: 'weight_from', type: 'decimal', dp: 3, required: true, default: '0', hint: true },
      { key: 'weight_to', type: 'decimal', dp: 3, advanced: true, hint: true },
      { key: 'mc_per_gram', type: 'decimal', dp: 2, group: 'making_charge', hint: true },
      { key: 'mc_percent', type: 'decimal', dp: 2, max: '100', group: 'making_charge' },
      { key: 'flat_mc', type: 'decimal', dp: 2, group: 'making_charge' },
      { key: 'wastage_pct', type: 'decimal', dp: 2, max: '100', group: 'wastage', hint: true },
      { key: 'touch', type: 'decimal', dp: 2, max: '100', group: 'wastage', hint: true },
      { key: 'flat_wastage', type: 'decimal', dp: 3, group: 'wastage', hint: true },
      { key: 'scope', type: 'select', options: vals(ValueAdditionRuleInputScope), optionsKey: 'scope', required: true, default: 'customer', advanced: true, hint: true },
      { key: 'tier', type: 'select', options: vals(ValueAdditionRuleInputTier), optionsKey: 'tier', advanced: true },
      { key: 'design_id', type: 'ref', ref: 'designs', filter: true, advanced: true, hint: true },
      { key: 'metal_id', type: 'ref', ref: 'metal', advanced: true },
      { key: 'vendor_id', type: 'ref', ref: 'vendors', advanced: true, hint: true },
      { key: 'fixed_rate', type: 'decimal', dp: 2, advanced: true, hint: true },
      { key: 'purity_id', type: 'ref', ref: 'purity', advanced: true },
      { key: 'sub_item_id', type: 'ref', ref: 'sub_items', advanced: true },
      { key: 'effective_from', type: 'date', advanced: true, default: null }, { key: 'effective_to', type: 'date', advanced: true },
      { key: 'priority', type: 'int', max: '1000', advanced: true },
    ] },
  customers: { kind: 'customers', mid: 'M8', title: 'name', columns: ['name', 'phone', 'address.city', 'pan'], fields: [
    name, { key: 'phone', type: 'phone', hint: true }, { key: 'address.city', type: 'text' },
    { key: 'pan', type: 'secret', pattern: PAN, last4Key: 'pan_last4', advanced: true, hint: true },
    { key: 'gstin', type: 'gstin', advanced: true, hint: true }, { key: 'state_code', type: 'text', pattern: /^[0-9]{2}$/, advanced: true, hint: true },
    { key: 'email', type: 'text', advanced: true }, { key: 'upi_id', type: 'text', advanced: true },
    { key: 'address.line1', type: 'text', advanced: true }, { key: 'address.pincode', type: 'text', pattern: /^[0-9]{6}$/, advanced: true },
    { key: 'dob', type: 'date', advanced: true }, { key: 'anniversary', type: 'date', advanced: true },
    { key: 'home_branch_id', type: 'ref', ref: 'branch', advanced: true },
    // G18 (0.7.3): true records consent (server sets consent_at), false withdraws it. group_id (M9) stays unset and hidden.
    { key: 'kyc_consent', type: 'bool', default: false, hint: true, fromRow: (r) => !!r.consent_at },
  ], readOnlyAt: ['consent_at'] },
  vendors: { kind: 'vendors', mid: 'M10', title: 'name', columns: ['code', 'name', 'kinds'], fields: [
    name, code, { key: 'kinds', type: 'multi', options: vals(VendorKind), optionsKey: 'vendor_kind', required: true, default: ['supplier'], filter: true, param: 'kind', hint: true },
    { key: 'gstin', type: 'gstin', advanced: true, hint: true }, { key: 'pan', type: 'pan', advanced: true },
    { key: 'state_code', type: 'text', pattern: /^[0-9]{2}$/, advanced: true, hint: true },
  ] },
  staff: { kind: 'staff', mid: 'M11', title: 'name', columns: ['code', 'name', 'phone', 'branch_id'], fields: [
    name, code, { key: 'phone', type: 'phone' }, { key: 'branch_id', type: 'ref', ref: 'branch', filter: true },
    { key: 'pan', type: 'secret', pattern: PAN, last4Key: 'pan_last4', advanced: true },
    { key: 'department', type: 'text', maxLen: 100, advanced: true }, { key: 'designation', type: 'text', maxLen: 100, advanced: true },
    { key: 'is_salesperson', type: 'bool', default: false, advanced: true },
    { key: 'joined_on', type: 'date', advanced: true }, { key: 'left_on', type: 'date', advanced: true, hint: true },
  ] },
  floors: { kind: 'floors', mid: 'M12', title: 'name', columns: ['code', 'name', 'branch_id'], fields: [name, { ...code, pattern: /^[A-Z0-9][A-Z0-9_-]{0,9}$/ }, branch] },
  counters: { kind: 'counters', mid: 'M12', title: 'name', columns: ['code', 'name', 'branch_id', 'floor_id'], fields: [
    name, { ...code, pattern: /^[A-Z0-9][A-Z0-9_-]{0,9}$/ }, branch, { key: 'floor_id', type: 'ref', ref: 'floors', filter: true, advanced: true },
  ] },
  trays: { kind: 'trays', mid: 'M12', title: 'code', columns: ['code', 'name', 'counter_id', 'sub_item_id'], fields: [
    { ...code, pattern: /^[A-Za-z0-9_-]{1,20}$/ }, { key: 'name', type: 'text', maxLen: 100 },
    { key: 'counter_id', type: 'ref', ref: 'counters', required: true, filter: true },
    { key: 'tare_weight', type: 'decimal', dp: 3, advanced: true, hint: true },
    { key: 'sub_item_id', type: 'ref', ref: 'sub_items', advanced: true },
  ] },
  hsn_codes: { kind: 'hsn_codes', mid: 'M13', title: 'code', columns: ['code_type', 'code', 'description', 'uqc'], fields: [
    { key: 'code_type', type: 'select', options: ['HSN', 'SAC'], optionsKey: 'code_type', required: true, default: 'HSN' },
    { key: 'code', type: 'hsn', required: true, hint: true }, { key: 'description', type: 'text', required: true, maxLen: 300 },
    { key: 'uqc', type: 'text', pattern: /^[A-Z]{3}$/, advanced: true },
  ] },
  payment_modes: { kind: 'payment_modes', mid: 'M14', title: 'name', columns: ['code', 'name', 'kind'], fields: [
    { ...name, maxLen: 60 }, { ...code, pattern: /^[A-Z0-9_]{1,20}$/ },
    { key: 'kind', type: 'select', options: vals(PaymentModeInputKind), optionsKey: 'pay_kind', required: true, default: 'cash' },
    { key: 'requires_reference', type: 'bool', default: false, advanced: true, hint: true },
    { key: 'requires_card_machine', type: 'bool', default: false, advanced: true },
    { key: 'sort_order', type: 'int', max: '9999', advanced: true, hint: true },
    // G20: no account-head master/picker yet — a plain id under More details.
    { key: 'account_head_id', type: 'text', pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, advanced: true, hint: true },
  ] },
  card_machines: { kind: 'card_machines', mid: 'M15', title: 'code', columns: ['code', 'provider', 'terminal_id', 'branch_id'], fields: [
    { ...code, pattern: /^[A-Za-z0-9_-]{1,20}$/ }, { key: 'provider', type: 'text', required: true, maxLen: 60 },
    { key: 'terminal_id', type: 'text', required: true, pattern: /^[A-Za-z0-9]{4,20}$/, hint: true }, branch,
    { key: 'supports', type: 'multi', options: ['debit_card', 'credit_card', 'upi'], optionsKey: 'pay_kind', required: true, default: ['debit_card', 'credit_card'] },
    // C2 (0.7.4): points at accounts.cash_counter (the cash till) — no API yet, so a plain id under More details.
    { key: 'cash_counter_id', type: 'text', pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, advanced: true, hint: true },
    { key: 'settlement_bank_account_id', type: 'ref', ref: 'bank_account', advanced: true },
    { key: 'merchant_id', type: 'text', pattern: /^[A-Za-z0-9]{4,30}$/, advanced: true },
    { key: 'mdr_pct', type: 'decimal', dp: 3, max: '99.999', advanced: true, hint: true },
  ] },
  // Sub-items (0.7.1 strict SubItemInput/SubItemPatch): measurement and mc_type are enums; item_id is create-only.
  sub_items: { kind: 'sub_items', mid: 'M3', title: 'name', columns: ['code', 'name', 'item_id', 'hsn'], fields: [
    { key: 'item_id', type: 'ref', ref: 'items', required: true, filter: true, createOnly: true }, name, { ...code, pattern: /^[A-Za-z0-9][A-Za-z0-9._/-]{0,29}$/ },
    { key: 'hsn', type: 'hsn', advanced: true, hint: true }, { key: 'measurement', type: 'select', options: ['gram', 'piece', 'carat'], optionsKey: 'measurement', default: 'gram', advanced: true },
    mcType(), { key: 'mc_value', type: 'decimal', dp: 2, advanced: true }, { key: 'wastage_value', type: 'decimal', dp: 3, advanced: true },
    { key: 'huid_charge', type: 'decimal', dp: 2, advanced: true },
  ] },
  // KYC documents: the full number is write-only (rows carry number_last4); party fields are preset from the drawer.
  kyc_documents: { kind: 'kyc_documents', mid: 'M8', title: 'doc_type', columns: ['doc_type', 'number', 'status', 'expires_on'], fields: [
    { key: 'party_type', type: 'select', options: ['customer', 'vendor', 'staff'], optionsKey: 'party_type', required: true, hidden: true },
    { key: 'party_id', type: 'text', required: true, hidden: true },
    { key: 'doc_type', type: 'select', options: KYC_TYPES, optionsKey: 'kyc_type', required: true, default: 'pan' },
    { key: 'number', type: 'secret', pattern: /^[A-Za-z0-9]{4,30}$/, last4Key: 'number_last4', required: true },
    { key: 'front_file_id', type: 'file', purpose: 'kyc_document', required: true },
    { key: 'back_file_id', type: 'file', purpose: 'kyc_document', advanced: true },
    { key: 'expires_on', type: 'date', advanced: true },
    { key: 'status', type: 'select', options: ['pending', 'verified', 'rejected', 'expired'], optionsKey: 'kyc_status', default: 'pending', advanced: true },
  ] },
};

/** Must-have masters as frozen (feature-freeze page, 28 Oct 2026). M9 customer groups and M16 discount schemes are later. */
export const FROZEN_MUST_HAVE = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M10', 'M11', 'M12', 'M13', 'M14', 'M15', 'M17'] as const;

/** Read a (possibly dotted) key from a row. */
export function getPath(row: Record<string, unknown> | null | undefined, key: string): unknown {
  return key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), row ?? undefined);
}
/** Fold dotted keys into nested objects for the request body. */
export function nest(input: MasterInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    const parts = k.split('.');
    let o = out;
    for (const p of parts.slice(0, -1)) o = (o[p] ??= {}) as Record<string, unknown>;
    o[parts.at(-1) as string] = v;
  }
  return out;
}

export function defaultsFor(cfg: MasterConfig): MasterInput {
  return Object.fromEntries(cfg.fields.filter((f) => f.type !== 'secret').map((f) => [f.key,
    f.key === 'effective_from' ? today() : f.default ?? (f.type === 'bool' ? false : f.type === 'multi' ? [] : null)]));
}


/** Name and code are labelled per kind ('HSN code', 'Customer name'); other fields share one label. */
const PER_KIND_LABELS = new Set(['name', 'code']);
export const labelKey = (kind: MasterKind, key: string) => (PER_KIND_LABELS.has(key) ? `masters.f.${kind}.${key}` : `masters.f.${key}`);
export const codeFrom = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20);

/** Error code per field ('required' | 'invalid' | 'too_many_dp' | 'too_big'), or null. Shared by the form and the mock server. */
export function validateField(f: FieldDef, raw: FieldValue | undefined): string | null {
  const v = typeof raw === 'string' ? raw.trim() : raw;
  if (Array.isArray(v)) return f.required && !v.length ? 'required' : v.every((x) => f.options?.includes(x) ?? true) ? null : 'invalid';
  if (v === null || v === undefined || v === '') return f.required ? 'required' : null;
  if (f.type === 'bool') return typeof v === 'boolean' ? null : 'invalid';
  if (typeof v !== 'string') return 'invalid';
  if (f.pattern && !f.pattern.test(f.type === 'secret' ? v.toUpperCase().replace(/\s/g, '') : v)) return 'invalid';
  switch (f.type) {
    case 'decimal': {
      if (!/^\d+(\.\d+)?$/.test(v)) return 'invalid';
      if ((v.split('.')[1] ?? '').length > (f.dp ?? 2)) return 'too_many_dp';
      return f.max && D(v).gt(D(f.max)) ? 'too_big' : null;
    }
    case 'int': return !/^\d{1,6}$/.test(v) ? 'invalid' : f.max && Number(v) > Number(f.max) ? 'too_big' : null;
    case 'code': return (f.pattern ?? CODE).test(v) && v.length <= (f.maxLen ?? 30) ? null : 'invalid';
    case 'phone': return PHONE.test(normalisePhone(v)) ? null : 'phone';
    case 'gstin': return GSTIN.test(v.toUpperCase()) ? null : 'invalid';
    case 'pan': return PAN.test(v.toUpperCase()) ? null : 'invalid';
    case 'hsn': return HSN.test(v) ? null : 'invalid';
    case 'date': return DATE.test(v) ? null : 'invalid';
    case 'select': return !f.options || f.options.includes(v) ? null : 'invalid';
    default: return v.length > (f.maxLen ?? 200) ? 'too_long' : null;
  }
}

/** Normalise typed values before sending: decimals → canonical strings (never floats), IDs upper-cased, blanks → null. */
export function normaliseInput(cfg: MasterConfig, input: MasterInput): MasterInput {
  const out: MasterInput = {};
  for (const f of cfg.fields) {
    if (!(f.key in input)) continue;
    const v = input[f.key];
    if (typeof v !== 'string') { out[f.key] = v ?? null; continue; }
    const s = v.trim();
    if (!s) { out[f.key] = null; continue; }
    if (f.type === 'decimal') out[f.key] = parseDecimalInput(s) ?? s;
    else if (f.type === 'gstin' || f.type === 'secret' || f.type === 'pan' || f.type === 'code') out[f.key] = s.toUpperCase().replace(/\s/g, '');
    else if (f.type === 'phone') out[f.key] = normalisePhone(s);
    else out[f.key] = s;
  }
  return out;
}

export function validateInput(cfg: MasterConfig, input: MasterInput, partial = false): Record<string, string> {
  const errs: Record<string, string> = {};
  for (const f of cfg.fields) {
    if (partial && !(f.key in input)) continue;
    const e = validateField(f, input[f.key]);
    if (e) errs[f.key] = e;
  }
  return errs;
}

/** JSON body for the generated client: drop blanks on create, nest dotted keys, ints as numbers. */
export function toBody(cfg: MasterConfig, input: MasterInput, create: boolean): Record<string, unknown> {
  const flat: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (create && (v === null || (Array.isArray(v) && !v.length))) continue;
    const f = cfg.fields.find((x) => x.key === k);
    flat[k] = f?.type === 'int' && typeof v === 'string' ? Number.parseInt(v, 10) : v;
  }
  return nest(flat as MasterInput);
}

/** Row title for the drawer and aria labels. */
export const rowTitle = (cfg: MasterConfig, row: MasterRow) => String(getPath(row, cfg.title) ?? '');
