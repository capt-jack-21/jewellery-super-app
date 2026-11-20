import { Decimal } from '@jw/money';

/** Exact decimal helpers (decimal.js, ROUND_HALF_UP). Money 2 dp, weight 3 dp, rate 2 dp. Never JS floats. */
export type Dec = InstanceType<typeof Decimal>;
export const d = (v: string | number | Dec | null | undefined): Dec => new Decimal(v === null || v === undefined || v === '' ? 0 : v);
export const ZERO: Dec = d(0);
export const r2 = (v: Dec): Dec => v.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
export const r3 = (v: Dec): Dec => v.toDecimalPlaces(3, Decimal.ROUND_HALF_UP);
export const m2 = (v: Dec | string | number): string => d(v as string).toFixed(2);
export const w3 = (v: Dec | string | number): string => d(v as string).toFixed(3);
export const sum = (xs: Dec[]): Dec => xs.reduce((a, b) => a.plus(b), ZERO);
/** Rounds to a multiple of step (0.01 / 0.10 / 0.50 / 1.00), half up (S8 bill round-off). */
export function roundTo(v: Dec, step: Dec): Dec {
  return v.dividedBy(step).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).times(step).toDecimalPlaces(2);
}
/** Percent string of a ratio, 3 dp max, no trailing zeros ("4.5"). */
export const pct = (v: Dec): string => v.toDecimalPlaces(3, Decimal.ROUND_HALF_UP).toString();
/**
 * Splits `total` (2 dp) over `weights` pro rata; floor shares to paisa, then award remaining paisa by fractional remainder
 * (first one on ties). Shares sum exactly to total without creating negative components.
 */
export function allocate(total: Dec, weights: Dec[]): Dec[] {
  if (!weights.length) return [];
  const w = sum(weights);
  if (w.isZero() || total.isZero()) return weights.map(() => ZERO);
  // Largest-remainder allocation in paisa: rounding each share first can make the
  // largest component negative when many 1-paisa parts split a near-full discount.
  const raw = weights.map((x) => total.times(x).dividedBy(w));
  const shares = raw.map((x) => x.times(100).floor().dividedBy(100));
  const pennies = total.minus(sum(shares)).times(100).toNumber();
  const order = raw.map((x, i) => ({ i, fraction: x.minus(shares[i]) }))
    .sort((a, b) => b.fraction.comparedTo(a.fraction) || a.i - b.i);
  for (let k = 0; k < pennies; k++) shares[order[k % order.length].i] = shares[order[k % order.length].i].plus('0.01');
  return shares;
}
