import { describe, expect, it } from 'vitest';
import { formatCompactINR, formatDecimalIN, formatINR, formatPercent, formatPurity, formatWeight, parseFineness, parseRate2dp, groupIndian, parseDecimalInput } from './number';

describe('groupIndian', () => {
  it.each([['0', '0'], ['999', '999'], ['1000', '1,000'], ['100000', '1,00,000'], ['12345678', '1,23,45,678'], ['1234567890123', '12,34,56,78,90,123']])('%s → %s', (a, b) => {
    expect(groupIndian(a)).toBe(b);
  });
});

describe('formatINR', () => {
  it('lakh/crore grouping with ₹ and 2 dp', () => {
    expect(formatINR('12345678.5')).toBe('₹1,23,45,678.50');
    expect(formatINR('100000')).toBe('₹1,00,000.00');
    expect(formatINR('0')).toBe('₹0.00');
  });
  it('matches Intl en-IN for typical values', () => {
    const intl = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });
    for (const v of ['1', '999.99', '123456.78', '98765432.10']) expect(formatINR(v)).toBe(intl.format(Number(v)));
  });
  it('is exact beyond float precision', () => {
    expect(formatINR('12345678901234567.89')).toBe('₹12,34,56,78,90,12,34,567.89');
  });
  it('rounds half-up (not banker’s) and handles negatives', () => {
    expect(formatINR('0.005')).toBe('₹0.01');
    expect(formatINR('2.675')).toBe('₹2.68'); // float would give 2.67
    expect(formatINR('-1500.5')).toBe('-₹1,500.50');
  });
  it('dp 0 and no symbol', () => {
    expect(formatINR('150000.4', { dp: 0, symbol: false })).toBe('1,50,000');
  });
  it('rejects non-decimal strings', () => {
    expect(() => formatINR('12abc')).toThrow(RangeError);
  });
});

describe('other formatters', () => {
  it('compact', () => {
    expect(formatCompactINR('12345678.5')).toBe('₹1.23 Cr');
    expect(formatCompactINR('1234567')).toBe('₹12.35 L');
    expect(formatCompactINR('45000')).toBe('₹45,000');
  });
  it('weight is always 3 dp', () => {
    expect(formatWeight('23.5')).toBe('23.500 g');
    expect(formatWeight('1234.0005')).toBe('1,234.001 g');
  });
  it('purity & percent', () => {
    expect(formatPurity(22, '916')).toBe('22K 916');
    expect(formatPurity(null, '925.0')).toBe('925');
    expect(formatPurity('22K', '916.000')).toBe('22K 916');
    expect(formatPurity('925', '925.000')).toBe('925');
    expect(formatPurity('24K', '999.900')).toBe('24K 999.9');
  });
  it('fineness & rate parsing (decimal strings, no floats)', () => {
    expect(parseFineness('916')).toBe('916.000');
    expect(parseFineness('999.9')).toBe('999.900');
    expect(parseFineness('1000.001')).toBeNull();
    expect(parseFineness('0')).toBeNull();
    expect(parseFineness('91.6543')).toBeNull();
    expect(parseRate2dp('7,250')).toBe('7250.00');
    expect(parseRate2dp('7250.5')).toBe('7250.50');
    expect(parseRate2dp('7250.555')).toBeNull();
    expect(parseRate2dp('0')).toBeNull();
    expect(formatPercent('8')).toBe('8.00%');
  });
  it('formatDecimalIN keeps -0 as 0', () => {
    expect(formatDecimalIN('-0.0001', 2)).toBe('0.00');
  });
  it('parses user input', () => {
    expect(parseDecimalInput(' ₹ 1,23,456.50 ')).toBe('123456.5');
    expect(parseDecimalInput('1.2.3')).toBeNull();
  });
});
