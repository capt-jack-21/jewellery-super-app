import { describe, expect, it } from 'vitest';
import en from './messages/en-IN.json';
import ta from './messages/ta-IN.json';

describe('message catalogues', () => {
  it('Tamil has exactly the English keys', () => expect(Object.keys(ta).sort()).toEqual(Object.keys(en).sort()));
  it('no empty messages and Tamil script present', () => {
    for (const v of [...Object.values(en), ...Object.values(ta)]) expect(v.trim()).not.toBe('');
    expect(Object.values(ta).some((v) => /[\u0B80-\u0BFF]/.test(v))).toBe(true);
  });
  it('placeholders match', () => {
    const ph = (s: string) => (s.match(/\{(\w+)/g) ?? []).sort();
    for (const k of Object.keys(en) as Array<keyof typeof en>) expect(ph(ta[k])).toEqual(ph(en[k]));
  });
});
