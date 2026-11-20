import { test, expect } from 'vitest';
import { formatField } from './index';
test('native numerals only on amount/weight/quantity/date', () => {
  expect(formatField('amount', '1234.50', { numerals: 'deva' })).toBe('१२३४.५०');
  expect(formatField('weight', '9.500', { numerals: 'taml' })).toBe('௯.௫௦௦');
  for (const k of ['gstin', 'huid', 'invoice_no', 'phone', 'barcode'] as const)
    expect(formatField(k, '33ABCDE1234F1Z5', { numerals: 'deva' })).toBe('33ABCDE1234F1Z5');
});
