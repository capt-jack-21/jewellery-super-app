import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { parse } from './parse';

const S = z.object({ a: z.string().min(1), n: z.object({ b: z.number() }).strict().optional() }).strict();
type Body = { status: number; code: string; errors: unknown[] };
const caught = (fn: () => unknown): Body => {
  try { fn(); } catch (e) { return (e as { getResponse(): Body }).getResponse(); }
  throw new Error('no throw');
};

describe('parse (0.8.3 field-level codes)', () => {
  it('passes valid bodies through', () => expect(parse(S, { a: 'x' })).toEqual({ a: 'x' }));
  it('unknown fields → 422 validation_failed, one field_not_supported per field (nested paths too)', () => {
    const e = caught(() => parse(S, { a: 'x', zz: 1, yy: 2, n: { b: 1, cc: 3 } }));
    expect(e).toMatchObject({ status: 422, code: 'validation_failed' });
    expect(e.errors).toEqual(expect.arrayContaining([
      { path: 'zz', code: 'field_not_supported', message: 'field_not_supported' },
      { path: 'yy', code: 'field_not_supported', message: 'field_not_supported' },
      { path: 'n.cc', code: 'field_not_supported', message: 'field_not_supported' }]));
    expect(e.errors).toHaveLength(3);
  });
  it('other issues → code invalid', () => {
    const e = caught(() => parse(S, { a: '' }));
    expect(e.errors).toEqual([expect.objectContaining({ path: 'a', code: 'invalid' })]);
  });
});
