import { describe, expect, it } from 'vitest';
import { amountInWords, amountWithWords, WORDS_NEED_REVIEW } from './words';

describe('amount in words: hi/te/kn/ml (needs native review)', () => {
  it('Hindi uses standard 1–99 forms and Indian scales', () => {
    expect(amountInWords('123456.50', 'hi')).toBe('एक लाख तेईस हज़ार चार सौ छप्पन रुपये और पचास पैसे मात्र');
    expect(amountInWords('10000000', 'hi')).toBe('एक करोड़ रुपये मात्र');
  });
  it('Telugu, Kannada, Malayalam produce words with scales', () => {
    expect(amountInWords('100000', 'te')).toBe('ఒక లక్ష రూపాయలు మాత్రమే');
    expect(amountInWords('1000', 'kn')).toBe('ಸಾವಿರ ರೂಪಾಯಿ ಮಾತ್ರ');
    expect(amountInWords('200000', 'ml')).toBe('രണ്ട് ലക്ഷം രൂപ മാത്രം');
  });
  it('native numerals in the figure, words unchanged', () => {
    expect(amountWithWords('100000', 'hi', 'deva')).toBe('₹१,००,०००.०० (एक लाख रुपये मात्र)');
  });
  it('marks non-Tamil Indic languages for review', () => {
    expect([...WORDS_NEED_REVIEW].sort()).toEqual(['hi', 'kn', 'ml', 'te']);
  });
});
