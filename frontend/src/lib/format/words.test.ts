import { describe, expect, it } from 'vitest';
import { amountInWords, integerToWordsEn, integerToWordsTa } from './words';

describe('English amount in words (Indian system)', () => {
  it.each([
    [0n, 'Zero'], [5n, 'Five'], [19n, 'Nineteen'], [21n, 'Twenty-One'], [100n, 'One Hundred'], [999n, 'Nine Hundred Ninety-Nine'],
    [1000n, 'One Thousand'], [100000n, 'One Lakh'], [123456n, 'One Lakh Twenty-Three Thousand Four Hundred Fifty-Six'],
    [10000000n, 'One Crore'], [1000000000n, 'One Hundred Crore'], [12345678n, 'One Crore Twenty-Three Lakh Forty-Five Thousand Six Hundred Seventy-Eight'],
  ])('%s', (n, w) => expect(integerToWordsEn(n)).toBe(w));

  it('rupees and paise', () => {
    expect(amountInWords('123456.50')).toBe('Rupees One Lakh Twenty-Three Thousand Four Hundred Fifty-Six and Fifty Paise Only');
    expect(amountInWords('200000')).toBe('Rupees Two Lakh Only');
    expect(amountInWords('0.999')).toBe('Rupees One Only');
  });
  it('rejects negatives', () => expect(() => amountInWords('-1')).toThrow());
});

describe('Tamil amount in words', () => {
  it.each([
    [1n, 'ஒன்று'], [10n, 'பத்து'], [11n, 'பதினொன்று'], [20n, 'இருபது'], [21n, 'இருபத்து ஒன்று'], [100n, 'நூறு'],
    [105n, 'நூற்று ஐந்து'], [900n, 'தொள்ளாயிரம்'], [1000n, 'ஆயிரம்'], [1500n, 'ஆயிரத்து ஐநூறு'],
    [100000n, 'ஒரு லட்சம்'], [10000000n, 'ஒரு கோடி'],
  ])('%s', (n, w) => expect(integerToWordsTa(n)).toBe(w));

  it('rupees and paise', () => {
    expect(amountInWords('100000', 'ta')).toBe('ஒரு லட்சம் ரூபாய் மட்டும்');
    expect(amountInWords('1500.25', 'ta')).toBe('ஆயிரத்து ஐநூறு ரூபாய் இருபத்து ஐந்து பைசா மட்டும்');
  });
});
