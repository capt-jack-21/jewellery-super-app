import { ApiError } from '@/lib/api/fetcher';

const MONEY = new Set(['amount', 'discount', 'bill_discount', 'expected_total', 'rate_override', 'pan_required_above', 'cash_limit_amount']);
const WEIGHT = new Set(['gross_wt', 'net_wt', 'stone_wt', 'less_wt']);
const PERCENT = new Set(['discount_max_pct', 'large_discount_pct', 'wastage_pct', 'touch_pct']);
/** Final transport boundary: strict Money/Weight/TaxRate scale. UI inputs are normalised before this point.
 * Percent/DecimalAmount are deliberately distinct (up to 3dp); counts remain JSON integers.
 */
export function checkedSalesWire<T>(body: T): T {
  const errors: { path: string; message: string; code: string }[] = [];
  const visit = (value: unknown, path: string, key: string) => {
    const pattern = MONEY.has(key) ? /^-?\d{1,12}\.\d{2}$/ : WEIGHT.has(key) ? /^\d{1,9}\.\d{3}$/
      : key === 'making_service_rate' ? /^\d{1,3}\.\d{2}$/ : PERCENT.has(key) ? /^\d{1,3}(\.\d{1,3})?$/
        : key === 'mc_value' ? /^\d{1,10}(\.\d{1,3})?$/ : null;
    if (pattern) {
      if (!(key === 'making_service_rate' && value === null) && (typeof value !== 'string' || !pattern.test(value))) errors.push({ path, code: 'invalid', message: 'Use a decimal string with the contract scale' });
      return;
    }
    if (Array.isArray(value)) value.forEach((v, i) => visit(v, `${path}.${i}`, ''));
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) visit(v, path ? `${path}.${k}` : k, k);
  };
  visit(body, '', '');
  if (errors.length) throw new ApiError(422, 'validation_failed', 'Check the decimal values', undefined, errors);
  return body;
}
