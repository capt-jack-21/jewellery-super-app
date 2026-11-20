import { parseMoney } from '@jw/money';
import type { AmountInWordsProvider } from './registry';
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const two = (n: number) => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ' ' + ONES[n % 10] : ''}`);
const three = (n: number) => [n >= 100 ? `${ONES[Math.floor(n / 100)]} Hundred` : '', two(n % 100)].filter(Boolean).join(' ');
/** Indian grouping on a digit string: crore (recursive), lakh, thousand, hundreds. Integer-safe via BigInt. */
function indian(digits: string): string {
  let n = BigInt(digits);
  if (n === 0n) return 'Zero';
  const parts: string[] = [];
  const crore = n / 10_000_000n; n %= 10_000_000n;
  if (crore > 0n) parts.push(`${indian(crore.toString())} Crore`);
  const lakh = Number(n / 100_000n); n %= 100_000n;
  if (lakh) parts.push(`${two(lakh)} Lakh`);
  const th = Number(n / 1000n); const rest = Number(n % 1000n);
  if (th) parts.push(`${two(th)} Thousand`);
  if (rest) parts.push(three(rest));
  return parts.join(' ');
}
export const enIN: AmountInWordsProvider = {
  locale: 'en-IN', numerals: ['latn'],
  toWords(amount) {
    const d = parseMoney(amount);
    const neg = d.isNegative();
    const [r, p] = d.abs().toFixed(2).split('.');
    const paise = Number(p);
    const words = r === '0' && paise ? `${two(paise)} Paise Only` : `Rupees ${indian(r)}${paise ? ` and ${two(paise)} Paise` : ''} Only`;
    return neg ? `Minus ${words}` : words;
  },
};
