import { ApiError } from '@/lib/api/fetcher';
import type { MasterConfig } from './registry';

/** Documented master 422 codes (contract 0.7.1). Each has a friendly `error.<code>` message in en + ta. */
export const MASTER_422_CODES = [
  'validation_failed', 'unknown_reference', 'inactive_master', 'idempotency_key_required', 'idempotency_key_reused', 'unknown_hsn',
  'purity_metal_mismatch', 'sub_item_mismatch', 'stone_or_cent_group_required', 'multiple_mc_basis', 'multiple_wastage_basis',
  'aadhaar_not_allowed', 'floor_branch_mismatch', 'card_machine_kind', 'cash_counter_branch_mismatch',
] as const;
export type Master422Code = (typeof MASTER_422_CODES)[number];

/** The field a code points at when the server sends no `errors[]` (paths as the backend uses them). */
export const CODE_FIELD: Partial<Record<Master422Code, string>> = {
  unknown_hsn: 'hsn', purity_metal_mismatch: 'purity_id', sub_item_mismatch: 'sub_item_id', stone_or_cent_group_required: 'stone_id',
  multiple_mc_basis: 'mc_per_gram', multiple_wastage_basis: 'wastage_pct', aadhaar_not_allowed: 'doc_type', floor_branch_mismatch: 'floor_id',
  card_machine_kind: 'requires_card_machine', cash_counter_branch_mismatch: 'cash_counter_id',
};

/** Per-form overrides: on a card machine, a pathless inactive_master means the cash counter was deactivated (0.7.3, 986). */
export const KIND_CODE_FIELD: Partial<Record<MasterConfig['kind'], Partial<Record<Master422Code, string>>>> = {
  card_machines: { inactive_master: 'cash_counter_id' },
};

const isKnown = (c: string | undefined): c is Master422Code => !!c && (MASTER_422_CODES as readonly string[]).includes(c);
const fieldOf = (path: string) => path.replace(/^\//, '').replace(/\//g, '.');

/**
 * Field-level messages for a failed master save. Paths from `errors[]` win; a specific code shows its friendly
 * message on that field (validation_failed keeps the server's per-field text). A code without paths falls back to
 * CODE_FIELD when that field is on this form. Anything else is shown form-level by ErrorText (error.<code>).
 */
export function fieldErrors(cfg: MasterConfig, error: unknown, tk: (k: string) => string): Record<string, string> {
  if (!(error instanceof ApiError) || error.status !== 422) return {};
  const friendly = isKnown(error.code) && error.code !== 'validation_failed' ? tk(`error.${error.code}`) : null;
  const out: Record<string, string> = Object.fromEntries(error.errors.map((e) => [fieldOf(e.path), friendly ?? e.message]));
  if (!error.errors.length && isKnown(error.code)) {
    const own = KIND_CODE_FIELD[cfg.kind]?.[error.code];
    const f = own ?? CODE_FIELD[error.code];
    const msg = own ? tk(`error.${error.code}.${cfg.kind}`) : friendly;
    if (f && cfg.fields.some((x) => x.key === f) && msg) out[f] = msg;
  }
  return out;
}
