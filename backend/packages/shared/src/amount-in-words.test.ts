import { test, expect } from 'vitest';
import { amountInWords, supportedLocales } from './index';
test('en-IN lakh/crore', () => {
  expect(amountInWords('84063.00', { locale: 'en-IN' })).toBe('Rupees Eighty Four Thousand Sixty Three Only');
  expect(amountInWords('12345678.50', { locale: 'en-IN' })).toBe('Rupees One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight and Fifty Paise Only');
  expect(amountInWords('0.05', { locale: 'en-IN' })).toBe('Five Paise Only');
});
test('registry rejects unknown locale / numerals / floats', () => {
  expect(supportedLocales()).toEqual(['en-IN', 'ta-IN']);
  expect(() => amountInWords('1.00', { locale: 'xx-IN' })).toThrow(/unsupported locale/);
  expect(() => amountInWords('1.00', { locale: 'en-IN', numerals: 'deva' })).toThrow(/numerals/);
  expect(() => amountInWords(1 as unknown as string, { locale: 'en-IN' })).toThrow(TypeError);
});

test('QA B5 — Tamil amount words use native script, Indian scales and paisa without an English fallback', () => {
  for (const [amount, words] of [
    ['0.00', 'பூஜ்ஜியம் ரூபாய் மட்டும்'], ['1.00', 'ஒன்று ரூபாய் மட்டும்'],
    ['13.00', 'பதின்மூன்று ரூபாய் மட்டும்'], ['1000.00', 'ஆயிரம் ரூபாய் மட்டும்'],
    ['1001.00', 'ஆயிரத்து ஒன்று ரூபாய் மட்டும்'], ['100000.00', 'ஒரு லட்சம் ரூபாய் மட்டும்'],
    ['12345678.50', 'ஒரு கோடியே இருபத்து மூன்று லட்சத்து நாற்பத்து ஐந்து ஆயிரத்து அறுநூற்று எழுபத்து எட்டு ரூபாய் ஐம்பது பைசா மட்டும்'],
  ]) expect(amountInWords(amount, { locale: 'ta-IN' })).toBe(words);
  expect(amountInWords('6695.00', { locale: 'ta-IN', numerals: 'taml' })).not.toMatch(/[A-Za-z0-9]/);
});
