import type { LanguageCode, NumeralSystem } from '@/lib/api/backend/model';
import { WORDS_NEED_REVIEW, type WordsLocale } from '@/lib/format';

export type PrintLang = 'en' | 'ta' | 'hi' | 'te' | 'kn' | 'ml';
/** UI print locale: single language or bilingual with English (bi-xx). */
export type PrintLocale = `${PrintLang}-IN` | `bi-${Exclude<PrintLang, 'en'>}-IN`;
/** CLDR numbering-system ids used by Intl. */
export type PrintNumerals = 'latn' | 'taml' | 'deva' | 'telu' | 'knda' | 'mlym';
export const PRINT_LOCALES: PrintLocale[] = ['en-IN', 'ta-IN', 'hi-IN', 'te-IN', 'kn-IN', 'ml-IN', 'bi-ta-IN', 'bi-hi-IN', 'bi-te-IN', 'bi-kn-IN', 'bi-ml-IN'];

/** Languages printed, English first for bilingual. */
export function printLangs(locale: PrintLocale): PrintLang[] {
  const m = /^(bi-)?([a-z]{2})-IN$/.exec(locale);
  const l = (m?.[2] ?? 'en') as PrintLang;
  return m?.[1] && l !== 'en' ? ['en', l] : [l];
}
const NATIVE: Record<PrintLang, PrintNumerals | null> = { en: null, ta: 'taml', hi: 'deva', te: 'telu', kn: 'knda', ml: 'mlym' };
/** Numeral choices for a print locale: Western always, plus the non-English language's native digits. */
export function numeralOptions(locale: PrintLocale): PrintNumerals[] {
  const native = NATIVE[printLangs(locale).at(-1) ?? 'en'];
  return native ? ['latn', native] : ['latn'];
}
export const wordsLocale = (l: PrintLang): WordsLocale => l;
export const wordsNeedReview = (l: PrintLang): boolean => WORDS_NEED_REVIEW.has(l);

export { loadFont, PRINT_FONT } from '@/lib/fonts';

const N2C: Record<PrintNumerals, NumeralSystem> = { latn: 'latin', taml: 'tamil', deva: 'devanagari', telu: 'telugu', knda: 'kannada', mlym: 'malayalam' };
const C2N = Object.fromEntries(Object.entries(N2C).map(([k, v]) => [v, k])) as Partial<Record<NumeralSystem, PrintNumerals>>;

/**
 * Contract mapping. PrintTemplateInput.print_language is a single LanguageCode, so bilingual is carried as
 * `config.bilingual = true` (raised with backend). Numerals: CLDR id ↔ contract NumeralSystem.
 */
export function toContract(locale: PrintLocale, numerals: PrintNumerals) {
  const langs = printLangs(locale);
  return { print_language: (langs.at(-1) ?? 'en') as LanguageCode, numeral_system: N2C[numerals], bilingual: langs.length > 1 };
}
export function fromContract(t: { print_language: LanguageCode; numeral_system: NumeralSystem; config?: Record<string, unknown> | null }): { locale: PrintLocale; numerals: PrintNumerals } {
  const l = (PRINT_LOCALES.some((x) => x === `${t.print_language}-IN`) ? t.print_language : 'en') as PrintLang;
  const locale = (t.config?.bilingual === true && l !== 'en' ? `bi-${l}-IN` : `${l}-IN`) as PrintLocale;
  const n = C2N[t.numeral_system] ?? 'latn';
  return { locale, numerals: numeralOptions(locale).includes(n) ? n : 'latn' };
}
