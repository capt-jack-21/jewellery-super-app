import { describe, expect, it } from 'vitest';
import en from './messages/en-IN.json';
import ta from './messages/ta-IN.json';
import { resolveLocale } from './index';

describe('locale resolution', () => {
  it('user override > shop default > last used', () => {
    expect(resolveLocale('ta-IN', 'en-IN', 'en-IN')).toBe('ta-IN');
    expect(resolveLocale(null, 'ta-IN', 'en-IN')).toBe('ta-IN');
    expect(resolveLocale(undefined, null, 'ta-IN')).toBe('ta-IN');
    expect(resolveLocale('xx', 'yy')).toBe('en-IN');
  });
  it('en and ta catalogues have identical keys', () => {
    expect(Object.keys(ta).sort()).toEqual(Object.keys(en).sort());
  });
});
