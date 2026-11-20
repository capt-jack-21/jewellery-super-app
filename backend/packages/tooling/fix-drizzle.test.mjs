import { test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const script = new URL('../../scripts/fix-drizzle.py', import.meta.url).pathname;
const fx = (f) => new URL(`./fixtures/drizzle/${f}`, import.meta.url).pathname;
function fix(name) {
  const out = join(mkdtempSync(join(tmpdir(), 'fixdrz-')), 'schema.ts');
  copyFileSync(fx(name), out);
  const r = spawnSync('python3', [script, out, '--fks', fx('fks.tsv')], { encoding: 'utf8' });
  expect(r.stderr).toBe('');
  expect(r.status).toBe(0);
  return readFileSync(out, 'utf8');
}
test('fix-drizzle: two differently shuffled pulls give byte-identical output', () => {
  expect(fix('a.ts.txt')).toBe(fix('b.ts.txt'));
});
test('fix-drizzle: composite FK pairs come from pg_constraint, keyed by schema + table + name', () => {
  const s = fix('b.ts.txt');
  expect(s).toContain('columns: [table.tenantId, table.mappingProfileId, table.kind],\n\t\t\tforeignColumns: [profileInPlatform.tenantId, profileInPlatform.id, profileInPlatform.kind]');
  // same constraint name in platform.job and sales.idempotency_key: each gets its own pairs
  expect(s).toContain('columns: [table.jobId, table.tenantId],\n\t\t\tforeignColumns: [jobInPlatform.id, jobInPlatform.tenantId]');
  expect(s).toContain('columns: [table.tenantId],\n\t\t\tforeignColumns: [profileInPlatform.tenantId]');
});
test('fix-drizzle: policies keep name/as/for/to without clauses; extras sorted by kind then name', () => {
  const s = fix('a.ts.txt');
  expect(s).not.toMatch(/using:|withCheck:/);
  const job = s.slice(s.indexOf('export const jobInPlatform'), s.indexOf('export const idempotencyKeyInSales'));
  const order = [...job.matchAll(/^\t(\w+)\(\{?(?:"([^"]+)")?/gm)].map((m) => m[1]);
  expect(order).toEqual(['foreignKey', 'foreignKey', 'check', 'pgPolicy', 'pgPolicy']);
  expect(job.indexOf('name: "idempotency_key_tenant_id_fkey"')).toBeLessThan(job.indexOf('name: "job_mapping_profile_fk"'));
});
test('fix-drizzle: an FK missing from pg_constraint fails loudly', () => {
  const out = join(mkdtempSync(join(tmpdir(), 'fixdrz-')), 'schema.ts');
  copyFileSync(fx('a.ts.txt'), out);
  const r = spawnSync('python3', [script, out, '--fks', '/dev/null'], { encoding: 'utf8' });
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain('not in pg_constraint');
});
test('fix-drizzle: index opclass guesses (.op) are dropped, so rebuilds with other guesses give the same file', () => {
  const s = fix('a.ts.txt');
  expect(s).not.toContain('.op(');
  expect(s).toContain('index("idempotency_key_job_idx").using("btree", table.tenantId.asc().nullsLast(), table.jobId.asc().nullsLast())');
});
