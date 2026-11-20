/**
 * Print formatter with typed field kinds. Native numerals (per-print option, tenant default) apply ONLY to
 * amount / weight / quantity / date. Identifier kinds (GSTIN, HUID, invoice no, phone, barcode, PAN, HSN) are
 * always Latin — enforced by the type and at runtime.
 */
import type { NumeralSystem } from '../amount-in-words/registry';
export type LocalisableKind = 'amount' | 'weight' | 'quantity' | 'date';
export type LatinOnlyKind = 'gstin' | 'huid' | 'invoice_no' | 'phone' | 'barcode' | 'pan' | 'hsn';
export type FieldKind = LocalisableKind | LatinOnlyKind;
const LATIN_ONLY: ReadonlySet<FieldKind> = new Set<FieldKind>(['gstin', 'huid', 'invoice_no', 'phone', 'barcode', 'pan', 'hsn']);
const ZERO: Record<NumeralSystem, number> = { latn: 0x30, deva: 0x966, beng: 0x9e6, gujr: 0xae6, taml: 0xbe6, telu: 0xc66, knda: 0xce6, mlym: 0xd66 };
export interface PrintOptions { numerals: NumeralSystem }

export function formatField(kind: FieldKind, value: string, opts: PrintOptions): string {
  if (typeof value !== 'string') throw new TypeError('formatField takes pre-formatted strings (decimal strings for amounts/weights)');
  if (LATIN_ONLY.has(kind) || opts.numerals === 'latn') return value;
  const z = ZERO[opts.numerals];
  return value.replace(/[0-9]/g, (d) => String.fromCodePoint(z + Number(d)));
}
export const isLatinOnly = (k: FieldKind) => LATIN_ONLY.has(k);
