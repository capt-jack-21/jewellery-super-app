import { fromNumerals } from './numerals';

/**
 * Identifiers ALWAYS print in Latin (ASCII) digits, whatever the print language or numeral setting:
 * GSTIN, HUID, invoice/document numbers, phone numbers and barcodes are machine-read, scanned, matched
 * against GST portal / BIS records, and must not be transliterated. There is deliberately no `numerals` option.
 */
export type IdentifierKind = 'gstin' | 'huid' | 'doc_no' | 'phone' | 'barcode';

export function formatIdentifier(kind: IdentifierKind, value: string): string {
  const latin = fromNumerals(value.normalize('NFKC')).trim();
  switch (kind) {
    case 'gstin':
    case 'huid':
      return latin.toUpperCase().replace(/\s+/g, '');
    case 'phone': {
      const d = latin.replace(/[^0-9+]/g, '');
      const m = /^(?:\+?91)?([6-9][0-9]{9})$/.exec(d);
      return m?.[1] ? `+91 ${m[1].slice(0, 5)} ${m[1].slice(5)}` : d;
    }
    default:
      return latin;
  }
}

/** True when the string contains only ASCII digits among its digits (no native-script digits). */
export const hasOnlyLatinDigits = (s: string): boolean => !/[\u0BE6-\u0BEF\u0966-\u096F\u0C66-\u0C6F\u0CE6-\u0CEF\u0D66-\u0D6F]/.test(s);
