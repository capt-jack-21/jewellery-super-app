import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { amountInWords } from './index';
const fx = JSON.parse(readFileSync(join(__dirname, '../fixtures/amount-in-words.json'), 'utf8'));
test('en-IN fixtures match the implementation', () => {
  for (const c of fx.locales['en-IN'].cases) expect(amountInWords(c.amount, { locale: 'en-IN' })).toBe(c.expected);
});
test('all six locales present; every non-English entry is flagged unverified', () => {
  expect(Object.keys(fx.locales).sort()).toEqual(['en-IN', 'hi-IN', 'kn-IN', 'ml-IN', 'ta-IN', 'te-IN']);
  for (const [l, v] of Object.entries<any>(fx.locales)) if (l !== 'en-IN') {
    expect(v.status).toBe('needs_native_speaker_verification');
    for (const c of v.cases) expect(c.needs_native_speaker_verification).toBe(true);
  }
});
