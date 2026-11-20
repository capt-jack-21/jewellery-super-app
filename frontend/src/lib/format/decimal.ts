import Decimal from 'decimal.js';

/** Money and weights travel as decimal STRINGS (contract convention) and are handled with decimal.js. Never JS floats. */
export type DecimalInput = string | Decimal;
export const D = (v: DecimalInput): Decimal => {
  if (typeof v === 'string' && !/^-?\d+(\.\d+)?$/.test(v.trim())) throw new RangeError(`Not a decimal string: "${v}"`);
  return v instanceof Decimal ? v : new Decimal(v.trim());
};
export { Decimal };
