import type { CreditNote, Invoice, SalesPrintDocument } from '@/lib/api/backend/model';
import { type PrintLang, type PrintNumerals } from '@/lib/print/locales';
import { validTemplatePin } from './templates';

/** 0.9.4: self-contained frozen CN projection. No invoice GET, live masters or GST recalculation. */
export function creditPrintSnapshot(note: CreditNote) {
  const original = note.original_invoice;
  if (!original || original.id !== note.invoice_id || original.doc_no !== note.invoice_no || !original.doc_date || !original.invoice_total ||
      !note.seller?.legal_name || !note.seller.state_code || !note.place_of_supply || !note.gst_type || !note.supply_type ||
      !Array.isArray(note.lines) || !Array.isArray(note.tax_summary) || !Array.isArray(original.lines)) return null;
  if (note.kind === 'receipt_reversal') {
    if (note.gst_applicable !== false || note.lines.length || original.lines.length || note.tax_summary.length ||
        ['taxable_value', 'cgst', 'sgst', 'igst', 'cess', 'round_off'].some((f) => !/^0\.00$/.test(String(note[f as keyof CreditNote])))) return null;
  } else {
    if (note.gst_applicable !== true || !taxSellerReady(note.seller) || !note.lines.length) return null;
    if (note.lines.some((l) => !l.hsn || !l.tax_rate || !Array.isArray(l.tax_parts) || !l.tax_parts.length || l.tax_parts.some((p) => ['hsn_sac', 'component', 'rate', 'taxable_value', 'cgst_rate', 'sgst_rate', 'igst_rate', 'cess_rate', 'cgst', 'sgst', 'igst', 'cess'].some((k) => typeof p[k as keyof typeof p] !== 'string')) || !original.lines.some((x) => x.id === l.invoice_line_id))) return null;
  }
  return { invoice: original, seller: note.seller, lines: note.lines.map((credit) => ({ credit, original: original.lines.find((x) => x.id === credit.invoice_line_id) })), tax_summary: note.tax_summary };
}
export const taxSellerReady = (seller?: Invoice['seller'] | null) => !!(seller?.legal_name?.trim() && seller.gstin?.trim() && seller.state_code && seller.address?.line1?.trim());
/** No local amount-in-words fallback: the backend owns language and every word. */
export function salesPrintWords(doc: SalesPrintDocument, _lang?: PrintLang): string { return doc.amount_in_words; }
export function salesPrintDataError(doc: SalesPrintDocument) {
  if (doc.language !== 'en' && doc.language !== 'ta') return 'print_language_not_supported';
  if (doc.locale !== `${doc.language}-IN` || !['latin', 'devanagari', 'tamil', 'telugu', 'kannada', 'malayalam', 'bengali', 'gujarati'].includes(doc.numerals)) return 'print_snapshot_invalid';
  if (typeof doc.amount_in_words !== 'string' || !doc.amount_in_words.trim()) return 'print_words_unavailable';
  if (doc.numerals === 'bengali' || doc.numerals === 'gujarati') return 'print_numerals_not_supported';
  if (!validTemplatePin(doc)) return 'pinned_print_template_unavailable';
  if (typeof doc.doc_cancelled !== 'boolean' || (doc.copy !== 'original' && doc.copy !== 'duplicate') ||
      (doc.doc_cancelled && (doc.copy !== 'duplicate' || doc.doc_type !== 'invoice' || doc.stamp !== 'CANCELLED'))) return 'print_snapshot_invalid';
  const expectedStamp = doc.doc_cancelled ? 'CANCELLED' : doc.copy === 'duplicate' ? 'DUPLICATE' : doc.doc_type === 'estimate' ? 'ESTIMATE' : null;
  if (doc.stamp !== expectedStamp) return 'print_snapshot_invalid';
  const s = doc.snapshot;
  if (!s || s.id !== doc.doc_id || ('doc_no' in s ? s.doc_no : s.estimate_no) !== doc.doc_no) return 'print_snapshot_unavailable';
  if (doc.doc_type === 'invoice' && (!('seller' in s) || !taxSellerReady(s.seller))) return 'invoice_print_snapshot_missing';
  if (doc.doc_type === 'credit_note' && 'gst_applicable' in s && s.gst_applicable && !taxSellerReady(s.seller)) return 'invoice_print_snapshot_missing';
  if (doc.doc_type === 'credit_note' && (!('gst_applicable' in s) || !creditPrintSnapshot(s))) return 'print_snapshot_unavailable';
  if (doc.doc_type === 'estimate' && (!('computation' in s) || !s.computation?.seller)) return 'print_snapshot_unavailable';
  return null;
}
export const PRINT_NUMERALS: Record<string, PrintNumerals> = { latin: 'latn', tamil: 'taml', devanagari: 'deva', telugu: 'telu', kannada: 'knda', malayalam: 'mlym' };
const NUMERAL_FONT: Record<string, PrintLang> = { tamil: 'ta', devanagari: 'hi', telugu: 'te', kannada: 'kn', malayalam: 'ml' };
export const printPresentation = (doc: Pick<SalesPrintDocument, 'locale' | 'language' | 'numerals'>) => {
  const lang = doc.locale.slice(0, 2) as PrintLang;
  const nativeFont = NUMERAL_FONT[doc.numerals], numerals = PRINT_NUMERALS[doc.numerals];
  if (!numerals) throw new Error('print_numerals_not_supported');
  return { lang, locale: doc.locale, numerals, fontLanguages: nativeFont && nativeFont !== lang ? [lang, nativeFont] : [lang] };
};

/** GST state names are identity text, not numeral-transliterated amounts. Unknown codes remain explicit. */
const STATES: Record<string, string> = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi',
  '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram',
  '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh',
  '24': 'Gujarat', '25': 'Daman and Diu', '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra', '28': 'Andhra Pradesh (old)',
  '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other territory', '99': 'Centre jurisdiction',
};
export const gstStateName = (code: string) => STATES[code] ?? code;
