import { describe, expect, it } from 'vitest';
import { fromNumerals, toNumerals } from './numerals';
import { formatDecimalIN, formatINR, formatPercent, formatWeight, parseDecimalInput } from './number';
import { formatDateIN } from './date';
import { amountWithWords } from './words';

describe('native numerals', () => {
  it('maps every Western digit to Tamil digits', () => {
    expect(toNumerals('0123456789', 'taml')).toBe('௦௧௨௩௪௫௬௭௮௯');
  });
  it('latn is identity and other systems work', () => {
    expect(toNumerals('2026', 'latn')).toBe('2026');
    expect(toNumerals('2026', 'deva')).toBe('२०२६');
  });
  it('round-trips back to ASCII', () => {
    expect(fromNumerals('௧,௨௩,௪௫௬.௫௦')).toBe('1,23,456.50');
    expect(fromNumerals('२०२६')).toBe('2026');
  });
  it('keeps lakh grouping and decimals with Tamil numerals', () => {
    expect(formatDecimalIN('12345678.5', 2, { numerals: 'taml' })).toBe('௧,௨௩,௪௫,௬௭௮.௫௦');
    expect(formatINR('123456.5', { numerals: 'taml' })).toBe('₹௧,௨௩,௪௫௬.௫௦');
    expect(formatWeight('23.5', 'g', { numerals: 'taml' })).toBe('௨௩.௫௦௦ g');
    expect(formatPercent('3', 2, { numerals: 'taml' })).toBe('௩.௦௦%');
  });
  it('defaults to Western digits', () => {
    expect(formatINR('1000')).toBe('₹1,000.00');
  });
  it('formats dates with native digits', () => {
    expect(formatDateIN('2026-10-20T06:00:00Z', 'taml')).toBe('௨௦-௧௦-௨௦௨௬');
  });
  it('parses native-digit input', () => {
    expect(parseDecimalInput('₹ ௧,௦௦௦.௫')).toBe('1000.5');
  });
  it('amount with words follows per-print language and numerals', () => {
    expect(amountWithWords('100000', 'ta', 'taml')).toBe('₹௧,௦௦,௦௦௦.௦௦ (ஒரு லட்சம் ரூபாய் மட்டும்)');
    expect(amountWithWords('1500.50', 'en', 'latn')).toBe('₹1,500.50 (Rupees One Thousand Five Hundred and Fifty Paise Only)');
  });
});
