import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveTestTarget, assertTestTarget, TEST_DB_REQUIRED, UNSAFE_TARGET, SHARED_TEST_DB } from '../../tests/integration/target';

// INF-3 (pure: no DB, no credentials). The integration harness has no default database.
const base = { PGHOST: '127.0.0.1', PGPORT: '55432' };
describe('INF-3 integration target', () => {
  it('missing or blank TEST_DB fails fast with the explicit message — never falls back to jw_it', () => {
    for (const env of [{}, { ...base }, { ...base, TEST_DB: '' }, { ...base, TEST_DB: ' ' }, { TEST_DB_HOST: '127.0.0.1', TEST_DB_PORT: '55432' }])
      expect(() => resolveTestTarget(env)).toThrow(TEST_DB_REQUIRED);
    expect(TEST_DB_REQUIRED).toMatch(/^TEST_DB is required/);
  });
  it('explicit safe targets resolve (jw_it, qa_*); host/port fall back to the locked test cluster', () => {
    expect(resolveTestTarget({ TEST_DB: SHARED_TEST_DB })).toEqual({ host: '127.0.0.1', port: '55432', database: 'jw_it' });
    expect(resolveTestTarget({ ...base, TEST_DB: 'qa_sales_ironhide_20261116_h2' })).toEqual({ host: '127.0.0.1', port: '55432', database: 'qa_sales_ironhide_20261116_h2' });
    expect(resolveTestTarget({ TEST_DB: 'qa_sales_20261116104002', TEST_DB_HOST: '127.0.0.1', TEST_DB_PORT: '55432' }).database).toBe('qa_sales_20261116104002');
  });
  it('unsafe explicit targets are still refused', () => {
    for (const TEST_DB of ['jewellery', 'jewellery_test', 'postgres', 'jw_it2', 'qa_', 'QA_x', 'qa_bad;DROP DATABASE x', 'qa-x'])
      expect(() => resolveTestTarget({ ...base, TEST_DB })).toThrow(UNSAFE_TARGET);
    for (const [PGHOST, PGPORT] of [['localhost', '55432'], ['10.0.0.5', '55432'], ['127.0.0.1', '5432'], ['127.0.0.1', '55433']])
      expect(() => resolveTestTarget({ TEST_DB: 'jw_it', PGHOST, PGPORT })).toThrow(UNSAFE_TARGET);
    expect(() => assertTestTarget('127.0.0.1', '55432', 'jewellery')).toThrow(UNSAFE_TARGET);
  });
  it('env.ts resolves before reading credentials and has no default; scripts require TEST_DB', () => {
    const root = resolve(__dirname, '../..');
    const env = readFileSync(resolve(root, 'tests/integration/env.ts'), 'utf8');
    expect(env.indexOf('resolveTestTarget(process.env)')).toBeGreaterThan(-1);
    expect(env.indexOf('resolveTestTarget(process.env)')).toBeLessThan(env.indexOf('ROLE_PASSWORD ='));
    expect(env).not.toMatch(/TEST_DB \?\?|DEFAULT_TEST_DB/);
    for (const f of ['scripts/test-db.sh', 'scripts/db-pull.sh']) {
      const sh = readFileSync(resolve(root, f), 'utf8');
      expect(sh).not.toMatch(/TEST_DB:-/);
      expect(sh).toMatch(/TEST_DB:\?/);
    }
  });
});
