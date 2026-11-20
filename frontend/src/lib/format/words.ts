import { D, type DecimalInput } from './decimal';
import { formatINR } from './number';
import type { Numerals } from './numerals';
import { amountInWordsIndic } from './words-indic';

/* ---------- English, Indian system ---------- */
const EN_ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const EN_TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function en99(n: number): string {
  if (n < 20) return EN_ONES[n] ?? '';
  const t = EN_TENS[Math.floor(n / 10)] ?? '', o = n % 10;
  return o ? `${t}-${EN_ONES[o]}` : t;
}
function en999(n: number): string {
  const h = Math.floor(n / 100), r = n % 100;
  return [h ? `${EN_ONES[h]} Hundred` : '', r ? en99(r) : ''].filter(Boolean).join(' ');
}
/** Integer words in the Indian system (crore repeats above 99 crore: "One Hundred Crore"). */
export function integerToWordsEn(n: bigint): string {
  if (n === 0n) return 'Zero';
  const crore = n / 10000000n, rest = Number(n % 10000000n);
  const lakh = Math.floor(rest / 100000), thousand = Math.floor((rest % 100000) / 1000), below = rest % 1000;
  return [
    crore ? `${integerToWordsEn(crore)} Crore` : '',
    lakh ? `${en99(lakh)} Lakh` : '',
    thousand ? `${en99(thousand)} Thousand` : '',
    below ? en999(below) : '',
  ].filter(Boolean).join(' ');
}

/* ---------- Tamil ---------- */
// Standalone and combining (followed by another number) forms. NEEDS NATIVE/CA REVIEW before use on invoices.
const TA_ONES = ['', 'ஒன்று', 'இரண்டு', 'மூன்று', 'நான்கு', 'ஐந்து', 'ஆறு', 'ஏழு', 'எட்டு', 'ஒன்பது'];
const TA_TEENS = ['பத்து', 'பதினொன்று', 'பன்னிரண்டு', 'பதிமூன்று', 'பதினான்கு', 'பதினைந்து', 'பதினாறு', 'பதினேழு', 'பதினெட்டு', 'பத்தொன்பது'];
const TA_TENS = ['', '', 'இருபது', 'முப்பது', 'நாற்பது', 'ஐம்பது', 'அறுபது', 'எழுபது', 'எண்பது', 'தொண்ணூறு'];
const TA_TENS_C = ['', '', 'இருபத்து', 'முப்பத்து', 'நாற்பத்து', 'ஐம்பத்து', 'அறுபத்து', 'எழுபத்து', 'எண்பத்து', 'தொண்ணூற்று'];
const TA_HUND = ['', 'நூறு', 'இருநூறு', 'முந்நூறு', 'நானூறு', 'ஐநூறு', 'அறுநூறு', 'எழுநூறு', 'எண்ணூறு', 'தொள்ளாயிரம்'];
const TA_HUND_C = ['', 'நூற்று', 'இருநூற்று', 'முந்நூற்று', 'நானூற்று', 'ஐநூற்று', 'அறுநூற்று', 'எழுநூற்று', 'எண்ணூற்று', 'தொள்ளாயிரத்து'];

function ta99(n: number): string {
  if (n < 10) return TA_ONES[n] ?? '';
  if (n < 20) return TA_TEENS[n - 10] ?? '';
  const t = Math.floor(n / 10), o = n % 10;
  return o ? `${TA_TENS_C[t]} ${TA_ONES[o]}` : TA_TENS[t] ?? '';
}
function ta999(n: number): string {
  const h = Math.floor(n / 100), r = n % 100;
  if (!h) return ta99(r);
  return r ? `${TA_HUND_C[h]} ${ta99(r)}` : TA_HUND[h] ?? '';
}
/** Scale word with standalone/combining form; "one" multiplier is omitted for thousand (ஆயிரம்) and uses ஒரு for lakh/crore. */
function taScale(mult: string, one: boolean, stand: string, comb: string, more: boolean, oneWord: string) {
  return `${one ? oneWord : `${mult} `}${more ? comb : stand}`;
}
export function integerToWordsTa(n: bigint): string {
  if (n === 0n) return 'பூஜ்ஜியம்';
  const crore = n / 10000000n, rest = Number(n % 10000000n);
  const lakh = Math.floor(rest / 100000), thousand = Math.floor((rest % 100000) / 1000), below = rest % 1000;
  const out: string[] = [];
  if (crore) out.push(taScale(integerToWordsTa(crore), crore === 1n, 'கோடி', 'கோடியே', rest > 0, 'ஒரு '));
  if (lakh) out.push(taScale(ta99(lakh), lakh === 1, 'லட்சம்', 'லட்சத்து', thousand + below > 0, 'ஒரு '));
  if (thousand) out.push(taScale(ta99(thousand), thousand === 1, 'ஆயிரம்', 'ஆயிரத்து', below > 0, ''));
  if (below) out.push(ta999(below));
  return out.join(' ');
}

export type WordsLocale = 'en' | 'ta' | 'hi' | 'te' | 'kn' | 'ml';
/** Languages whose amount-in-words has NOT yet had native review (Tamil has; English is the reference). */
export const WORDS_NEED_REVIEW: ReadonlySet<WordsLocale> = new Set(['hi', 'te', 'kn', 'ml']);
/**
 * Amount in words for invoices: "Rupees One Lakh Twenty-Three Thousand Four Hundred Fifty-Six and Fifty Paise Only".
 * Paise are rounded half-up to 2 dp first.
 */
export function amountInWords(amount: DecimalInput, locale: WordsLocale = 'en'): string {
  const d = D(amount).toDecimalPlaces(2, 4);
  if (d.isNegative()) throw new RangeError('amountInWords expects a non-negative amount');
  const rupees = BigInt(d.floor().toFixed(0));
  const paise = Number(d.minus(d.floor()).times(100).toFixed(0));
  if (locale !== 'en' && locale !== 'ta') return amountInWordsIndic(rupees, paise, locale);
  if (locale === 'ta') {
    const r = `${integerToWordsTa(rupees)} ரூபாய்`;
    return paise ? `${r} ${integerToWordsTa(BigInt(paise))} பைசா மட்டும்` : `${r} மட்டும்`;
  }
  const r = `Rupees ${integerToWordsEn(rupees)}`;
  return paise ? `${r} and ${integerToWordsEn(BigInt(paise))} Paise Only` : `${r} Only`;
}

/**
 * Print line "₹1,23,456.50 (Rupees … Only)" for a per-print language + numeral system,
 * e.g. ('123456.50', 'ta', 'taml') → "₹௧,௨௩,௪௫௬.௫௦ (ஒரு லட்சத்து … மட்டும்)".
 */
export function amountWithWords(amount: DecimalInput, locale: WordsLocale = 'en', numerals: Numerals = 'latn'): string {
  return `${formatINR(amount, { numerals })} (${amountInWords(amount, locale)})`;
}
