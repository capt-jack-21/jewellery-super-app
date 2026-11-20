import { D, type DecimalInput } from './decimal';
import { fromNumerals, toNumerals, type Numerals } from './numerals';

export interface NumeralOpt { numerals?: Numerals }

/** Indian digit grouping on an integer digit string: 12345678 → 1,23,45,678 (Western digits always). */
export function groupIndian(intDigits: string): string {
  if (intDigits.length <= 3) return intDigits;
  const last3 = intDigits.slice(-3);
  const rest = intDigits.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
}

/** Exact formatting of a decimal with fixed dp and lakh/crore grouping (no float round-trip, any magnitude). */
export function formatDecimalIN(value: DecimalInput, dp: number, opts: NumeralOpt = {}): string {
  const d = D(value).toDecimalPlaces(dp, 4 /* ROUND_HALF_UP */);
  const neg = d.isNegative() && !d.isZero();
  const [int = '0', frac] = d.abs().toFixed(dp).split('.');
  return toNumerals(`${neg ? '-' : ''}${groupIndian(int)}${frac ? `.${frac}` : ''}`, opts.numerals);
}

/** ₹1,23,45,678.50 */
export function formatINR(value: DecimalInput, opts: { dp?: 0 | 2; symbol?: boolean } & NumeralOpt = {}): string {
  const { dp = 2, symbol = true } = opts;
  const s = formatDecimalIN(value, dp, opts);
  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : s;
  return `${neg ? '-' : ''}${symbol ? '₹' : ''}${body}`;
}

/** Compact Indian units for dashboards: ₹12.35 L, ₹1.23 Cr, ₹45,000. Labels come from i18n when localised. */
export function formatCompactINR(value: DecimalInput, labels = { lakh: 'L', crore: 'Cr' }): string {
  const d = D(value);
  const abs = d.abs();
  const sign = d.isNegative() ? '-' : '';
  if (abs.gte(1e7)) return `${sign}₹${abs.div(1e7).toDecimalPlaces(2, 4).toFixed(2)} ${labels.crore}`;
  if (abs.gte(1e5)) return `${sign}₹${abs.div(1e5).toDecimalPlaces(2, 4).toFixed(2)} ${labels.lakh}`;
  return `${sign}${formatINR(abs, { dp: 0 })}`;
}

/** Grams to exactly 3 dp: 12.345 g */
export function formatWeight(grams: DecimalInput, unit = 'g', opts: NumeralOpt = {}): string {
  return `${formatDecimalIN(grams, 3, opts)} ${unit}`;
}

/** Fineness (parts per 1000) arrives as a decimal STRING ('916.000'); trailing zeros dropped: '916', '999.9'. Never parseFloat. */
export function formatFineness(fineness: DecimalInput): string {
  return D(fineness).toDecimalPlaces(3).toString();
}

/** 22K 916 · `label` is a karat number or a purity code ('22K', '925'). Codes that already equal the fineness collapse to one. */
export function formatPurity(label: number | string | null, fineness: DecimalInput): string {
  const f = formatFineness(fineness);
  if (label === null || label === '') return f;
  const l = typeof label === 'number' ? `${label}K` : label;
  return l === f ? f : `${l} ${f}`;
}

/** Normalise user input to a contract Fineness string (0 < f ≤ 1000, ≤ 3 dp) as '916.000', or null. */
export function parseFineness(raw: string): string | null {
  const v = parseDecimalInput(raw);
  if (!v || !/^\d{1,4}(\.\d{1,3})?$/.test(v)) return null;
  const d = D(v);
  return d.gt(0) && d.lte(1000) ? d.toFixed(3) : null;
}

/** Normalise user input to a contract rate string (> 0, at most 2 dp, ≤ 10 integer digits) as '7250.00', or null. */
export function parseRate2dp(raw: string): string | null {
  const v = parseDecimalInput(raw);
  if (!v || !/^\d{1,10}(\.\d{1,2})?$/.test(v)) return null;
  return D(v).gt(0) ? D(v).toFixed(2) : null;
}

export function formatPercent(value: DecimalInput, dp = 2, opts: NumeralOpt = {}): string {
  return `${formatDecimalIN(value, dp, opts)}%`;
}

/** Parse what a user types ("1,23,456.5", " ₹ 1,000 ") into a canonical decimal string, or null. */
export function parseDecimalInput(raw: string): string | null {
  const cleaned = fromNumerals(raw).replace(/[₹,\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  return D(cleaned).toString();
}
