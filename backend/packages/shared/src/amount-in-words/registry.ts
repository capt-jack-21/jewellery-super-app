/**
 * Pluggable amount-in-words. Language is a tenant master setting; each print passes its own
 * { locale, numerals } so one tenant can print e.g. en-IN and ta-IN. Input is a decimal string (never a float).
 */
export type NumeralSystem = 'latn' | 'deva' | 'taml' | 'telu' | 'knda' | 'mlym' | 'gujr' | 'beng';
export interface WordsOptions { locale: string; numerals?: NumeralSystem; currency?: 'INR' }
export interface AmountInWordsProvider {
  readonly locale: string;
  readonly numerals: readonly NumeralSystem[];
  /** amount: decimal string with ≤2 dp, e.g. "84063.00" */
  toWords(amount: string, opts: WordsOptions): string;
}
const providers = new Map<string, AmountInWordsProvider>();
export function registerAmountInWords(p: AmountInWordsProvider): void { providers.set(p.locale, p); }
export function supportedLocales(): string[] { return [...providers.keys()].sort(); }
export function amountInWords(amount: string, opts: WordsOptions): string {
  const p = providers.get(opts.locale);
  if (!p) throw new Error(`amount-in-words: unsupported locale ${opts.locale}`);
  const n = opts.numerals ?? 'latn';
  if (!p.numerals.includes(n)) throw new Error(`amount-in-words: ${opts.locale} does not support numerals ${n}`);
  return p.toWords(amount, opts);
}
