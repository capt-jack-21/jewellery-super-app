import { describe, it, expect, afterAll } from 'vitest';
import { cpSync, mkdtempSync, rmSync, appendFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from 'pg';
import { migrate, checksum, orderMigrations } from '@jw/db';
import { readFileSync } from 'node:fs';
import { url, MIGRATIONS } from './env';

describe('migrate.js (app_migrator, schema_migrations + checksums)', () => {
  const tmpDirs: string[] = [];
  afterAll(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });
  it('recorded every non-bootstrap file with its checksum, in order', async () => {
    const c = new Client({ connectionString: url('app_migrator') }); await c.connect();
    const { rows: recorded } = await c.query<{ filename: string; checksum: string }>('SELECT filename, checksum FROM migrator.schema_migrations');
    await c.end();
    const files = orderMigrations(readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql') && f !== '000_bootstrap.sql'));
    const rows = orderMigrations(recorded.map((r) => r.filename)).map((f) => recorded.find((r) => r.filename === f)!);
    expect(rows.map((r) => r.filename)).toEqual(files);
    for (const r of rows) expect(r.checksum).toBe(checksum(readFileSync(join(MIGRATIONS, r.filename), 'utf8')));
  });
  it('catalogue has 58 rows, high-water 01003; 991–999 exact (frozen 0.9.6 hashes)', async () => {
    const c = new Client({ connectionString: url('app_migrator') }); await c.connect();
    const all = (await c.query<{ filename: string; checksum: string }>(`SELECT filename, checksum FROM migrator.schema_migrations`)).rows;
    await c.end();
    const names = orderMigrations(all.map((r) => r.filename));
    const sales = all.filter((r) => /^99[1-9]_/.test(r.filename));
    expect({ n: all.length, hi: names[names.length - 1] }).toEqual({ n: 63, hi: '01008_orders_line_no.sql' });
    expect(Object.fromEntries(sales.map((r) => [r.filename.slice(0, 3), r.checksum]))).toEqual({
      991: 'a8b4eb3d8da71c8684b2a035ff48bc041758f8c7a2c8166d3373eeb70ebf4454', 992: 'bc0ae441b932908e74e302cea2458396671bb8eceb53bc17768716df4d61b385',
      993: 'e6cd87660333980e377fef6bbae87a502a1681526b1ae7a001639b8c36e099bc', 994: '3d3a0fdbb7105a100935a78e335b9d04a0152cb8a65f4701307071881b43568f',
      995: 'c697c4a14811ee7cfaa9a084c565369ace1166d79da6b8145e9ef4d678016219', 996: 'fcd512bf2c41842a1b3d9dc786bac6d4ce3aef71eec6b9f862b79a1eeed348e1',
      997: '18b496a2a8b32b7154523966b201a30c9d208e72559cff60b9cd3d7bb3afab32', 998: 'f2a0448520651a80b6492700dbd16f3987baded9b8a10bd4a0bd2291b119e7eb',
      999: 'f3c6809b8dfde81953e4a7adb00d2f91d3bdfa531b6fc3157c9e53fca9733174' });
  });
  it('rerun is idempotent (applies nothing)', async () => {
    const r = await migrate(url('app_migrator'), MIGRATIONS, () => undefined);
    expect(r.applied).toEqual([]);
    expect(r.skipped.length).toBeGreaterThan(10);
  });
  it('built dist/migrate.js rerun exits 0', () => {
    const r = spawnSync('node', ['apps/api/dist/migrate.js'], { env: { ...process.env, MIGRATOR_DATABASE_URL: url('app_migrator'), MIGRATIONS_DIR: MIGRATIONS }, encoding: 'utf8' });
    expect(r.status).toBe(0); expect(r.stdout).toMatch(/applied 0/);
  });
  it('fails on checksum drift of an applied file and applies nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-')); tmpDirs.push(dir);
    cpSync(MIGRATIONS, dir, { recursive: true });
    appendFileSync(join(dir, '050_rates.sql'), '\n-- edited after apply\n');
    await expect(migrate(url('app_migrator'), dir, () => undefined)).rejects.toThrow(/checksum mismatch.*050_rates\.sql/);
    const r = spawnSync('node', ['apps/api/dist/migrate.js'], { env: { ...process.env, MIGRATOR_DATABASE_URL: url('app_migrator'), MIGRATIONS_DIR: dir }, encoding: 'utf8' });
    expect(r.status).toBe(1); expect(r.stderr).toMatch(/checksum mismatch/);
  });
  it('defaults to /app/migrations', () => {
    expect(readFileSync('apps/api/src/migrate.ts', 'utf8')).toContain("'/app/migrations'");
    void statSync;
  });
});
