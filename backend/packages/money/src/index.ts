import Decimal from 'decimal.js';

/**
 * Money and weight values. DB type: numeric. Wire type: decimal string.
 * Money "1234.50" (2 dp), weight "9.500" (3 dp). JS numbers are never accepted.
 * Rounding rules for GST and round-off are pending (CA sign-off) and are not implemented here.
 */
export type MoneyString = string & { readonly __brand: 'Money' };
export type WeightString = string & { readonly __brand: 'Weight' };

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
const MONEY_RE = /^-?\d{1,12}(\.\d{1,2})?$/;
const WEIGHT_RE = /^-?\d{1,9}(\.\d{1,3})?$/;

function assertString(v: unknown, what: string): asserts v is string {
  if (typeof v !== 'string') throw new TypeError(`${what} must be a decimal string, got ${typeof v}`);
}

export function parseMoney(v: unknown): Decimal {
  assertString(v, 'money');
  if (!MONEY_RE.test(v)) throw new RangeError(`invalid money "${v}"`);
  return new D(v);
}
export function parseWeight(v: unknown): Decimal {
  assertString(v, 'weight');
  if (!WEIGHT_RE.test(v)) throw new RangeError(`invalid weight "${v}"`);
  return new D(v);
}
export const toMoney = (d: Decimal): MoneyString => d.toFixed(2) as MoneyString;
export const toWeight = (d: Decimal): WeightString => d.toFixed(3) as WeightString;
/** pg returns numeric as string by default; normalise to wire format. */
export const moneyFromDb = (s: string): MoneyString => toMoney(new D(s));
export const weightFromDb = (s: string): WeightString => toWeight(new D(s));
export { D as Decimal };
