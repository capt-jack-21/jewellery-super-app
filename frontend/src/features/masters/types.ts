/**
 * Masters (module 2, frozen 28 Oct 2026) on contract 0.7.0. Row/input shapes are the Orval models in
 * `@/lib/api/backend/model`; this file only names the generic screen's kinds and its loose row view.
 * Money, weights, rates and percents are decimal STRINGS.
 */
import type {
  CardMachine, Counter, Customer, Design, Floor, HsnCode, Item, KycDocument, PaymentMode, Staff, StoneRate, StoneStandard, SubItem, Tray,
  ValueAdditionRule, Vendor,
} from '@/lib/api/backend/model';

/** Generic masters on /v1/masters/<path>. M1/M2 (metals, purities) and bank accounts keep their existing screens. */
export const MASTER_KINDS = [
  'items', 'designs', 'stone_standards', 'stone_rates', 'value_addition_rules', 'customers', 'vendors', 'staff',
  'floors', 'counters', 'trays', 'hsn_codes', 'payment_modes', 'card_machines', 'sub_items', 'kyc_documents',
] as const;
export type MasterKind = (typeof MASTER_KINDS)[number];
export const isMasterKind = (v: unknown): v is MasterKind => typeof v === 'string' && (MASTER_KINDS as readonly string[]).includes(v);

/** Contract model per kind (what the generated client returns). */
export interface MasterModels {
  items: Item; designs: Design; stone_standards: StoneStandard; stone_rates: StoneRate; value_addition_rules: ValueAdditionRule;
  customers: Customer; vendors: Vendor; staff: Staff; floors: Floor; counters: Counter; trays: Tray; hsn_codes: HsnCode;
  payment_modes: PaymentMode; card_machines: CardMachine; sub_items: SubItem; kyc_documents: KycDocument;
}

export type FieldValue = string | boolean | string[] | null;
/** Every master row has id, version (If-Match) and is_active; the rest is read through the registry's field keys. */
export interface MasterRowBase { id: string; version: number; is_active: boolean }
export type MasterRow = MasterRowBase & Record<string, unknown>;
export interface ListParams { q?: string; include_inactive?: boolean; cursor?: string; [filter: string]: string | boolean | undefined }
export interface MasterPage { items: MasterRow[]; next_cursor: string | null }
/** Create/patch bodies: any subset of the kind's writable fields (dotted keys are nested, e.g. address.city). */
export type MasterInput = Record<string, FieldValue>;
