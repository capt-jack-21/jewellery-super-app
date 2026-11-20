import { describe, it, expect } from 'vitest';
import { parseMoney, toMoney, parseWeight, toWeight, moneyFromDb } from './index';
describe('money', () => {
  it('is exact (no float drift)', () => { expect(toMoney(parseMoney('0.1').plus(parseMoney('0.2')))).toBe('0.30'); });
  it('rejects JS numbers', () => { expect(() => parseMoney(1.5 as unknown)).toThrow(TypeError); });
  it('rejects >2dp money and >3dp weight', () => {
    expect(() => parseMoney('1.005')).toThrow(); expect(() => parseWeight('1.0005')).toThrow();
  });
  it('formats', () => { expect(toWeight(parseWeight('9.5'))).toBe('9.500'); expect(moneyFromDb('1234.5')).toBe('1234.50'); });
});
