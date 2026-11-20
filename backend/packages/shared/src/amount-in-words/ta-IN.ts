import { parseMoney } from '@jw/money';
import type { AmountInWordsProvider } from './registry';

/** In-house Tamil Indian-grouping provider; integer-safe, no external library. */
const TA_ONES = ['', 'ஒன்று', 'இரண்டு', 'மூன்று', 'நான்கு', 'ஐந்து', 'ஆறு', 'ஏழு', 'எட்டு', 'ஒன்பது'];
const TA_TEENS = ['பத்து', 'பதினொன்று', 'பன்னிரண்டு', 'பதின்மூன்று', 'பதினான்கு', 'பதினைந்து', 'பதினாறு', 'பதினேழு', 'பதினெட்டு', 'பத்தொன்பது'];
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

export const taIN: AmountInWordsProvider = {
  locale: 'ta-IN', numerals: ['latn', 'taml'],
  toWords(amount) {
    const value = parseMoney(amount);
    const [rupees, paise] = value.abs().toFixed(2).split('.');
    const words = `${integerToWordsTa(BigInt(rupees))} ரூபாய்${Number(paise) ? ` ${integerToWordsTa(BigInt(paise))} பைசா` : ''} மட்டும்`;
    return value.isNegative() ? `எதிர்மறை ${words}` : words;
  },
};
