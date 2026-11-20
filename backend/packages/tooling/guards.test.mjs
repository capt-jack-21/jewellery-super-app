import { test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
const run = (dir) => spawnSync('node', [new URL('./guards.mjs', import.meta.url).pathname, new URL(dir, import.meta.url).pathname], { encoding: 'utf8' });
test('guards flag every violation class in the bad fixture', () => {
  const r = run('./fixtures/bad/');
  expect(r.status).toBe(1);
  for (const rule of ['forbidden-route', 'api-no-pgboss', 'no-float-money', 'sales-role-owner', 'sales-tables-owner', 'stock-owner', 'reports-read-only'])
    expect(r.stderr).toContain(`[${rule}]`);
  expect(r.stderr).toMatch(/admin\/backup/); expect(r.stderr).toMatch(/truncate-invoices/);
});
test('Sales writing its own tables is allowed', () => { expect(run('./fixtures/good/').status).toBe(0); });
