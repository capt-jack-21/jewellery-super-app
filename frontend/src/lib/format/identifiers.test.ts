import { describe, expect, it } from 'vitest';
import { formatIdentifier, hasOnlyLatinDigits } from './identifiers';
import { NUMERAL_SYSTEMS, toNumerals } from './numerals';

describe('identifiers always print in Latin digits', () => {
  it.each(NUMERAL_SYSTEMS)('normalises native digits back to 0–9 (%s)', (n) => {
    expect(formatIdentifier('gstin', toNumerals('33aabcd1234e1z5', n))).toBe('33AABCD1234E1Z5');
    expect(formatIdentifier('doc_no', toNumerals('INV/2026-27/000123', n))).toBe('INV/2026-27/000123');
    expect(formatIdentifier('huid', toNumerals('ab12cd', n))).toBe('AB12CD');
    expect(formatIdentifier('barcode', toNumerals('8901234567890', n))).toBe('8901234567890');
    expect(formatIdentifier('phone', toNumerals('+91 98400 12345', n))).toBe('+91 98400 12345');
  });
  it('formats phone numbers', () => {
    expect(formatIdentifier('phone', '9840012345')).toBe('+91 98400 12345');
    expect(formatIdentifier('phone', '044-2345 6789')).toBe('04423456789');
  });
  it('detects native digits', () => {
    expect(hasOnlyLatinDigits('INV/2026/1')).toBe(true);
    expect(hasOnlyLatinDigits('INV/௨௦௨௬')).toBe(false);
  });
});
