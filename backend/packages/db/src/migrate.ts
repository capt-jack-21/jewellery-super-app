import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

export const BOOTSTRAP_FILE = '000_bootstrap.sql';
export interface MigrateResult { applied: string[]; skipped: string[] }

export const checksum = (sql: string) => createHash('sha256').update(sql).digest('hex');

/** Leading digits of a migration filename as a number ('010_platform.sql' -> 10, '01000_x.sql' -> 1000). */
const prefixNumber = (f: string): number => {
  const m = /^(\d+)_/.exec(f);
  if (!m) throw new Error(`migration filename must start with digits and an underscore: ${f}`);
  return Number(m[1]);
};

/**
 * Migration order = numeric value of the leading digits, then the full name. 3-digit names (010..999) keep exactly
 * the order a plain text sort gave them; 5-digit names (01000, 01001, ...) follow after 999. A plain text sort must
 * never be used for this: '01000_x' would sort before '010_platform'.
 */
export const orderMigrations = (files: readonly string[]): string[] =>
  files
    .map((f) => ({ f, n: prefixNumber(f) })) // validates every name, even in a one-item list
    .sort((a, b) => a.n - b.n || (a.f < b.f ? -1 : a.f > b.f ? 1 : 0))
    .map((x) => x.f);

/**
 * Apply <dir>/*.sql in numeric-prefix order (see orderMigrations) as app_migrator, recording each in migrator.schema_migrations.
 * 000_bootstrap.sql is superuser-only and is run separately (it is never applied here).
 * Fails if an already-applied file's checksum changed. Each file runs in its own transaction.
 */
export async function migrate(connectionString: string, dir: string, log: (m: string) => void = console.log): Promise<MigrateResult> {
  const files = orderMigrations(readdirSync(dir).filter((f) => f.endsWith('.sql') && f !== BOOTSTRAP_FILE));
  const c = new Client({ connectionString });
  await c.connect();
  const res: MigrateResult = { applied: [], skipped: [] };
  try {
    await c.query(`CREATE SCHEMA IF NOT EXISTS migrator;
      CREATE TABLE IF NOT EXISTS migrator.schema_migrations(
        filename text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    await c.query('SELECT pg_advisory_lock(727274)');
    const { rows } = await c.query<{ filename: string; checksum: string }>('SELECT filename, checksum FROM migrator.schema_migrations');
    const done = new Map(rows.map((r) => [r.filename, r.checksum]));
    const drift = files.filter((f) => done.has(f) && done.get(f) !== checksum(readFileSync(join(dir, f), 'utf8')));
    if (drift.length) throw new Error(`checksum mismatch for already-applied migration(s): ${drift.join(', ')}`);
    for (const f of files) {
      if (done.has(f)) { res.skipped.push(f); continue; }
      const sql = readFileSync(join(dir, f), 'utf8');
      log(`applying ${f}`);
      await c.query('BEGIN');
      try {
        await c.query(psqlCompat(sql));
        await c.query('INSERT INTO migrator.schema_migrations(filename, checksum) VALUES ($1,$2)', [f, checksum(sql)]);
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK');
        throw new Error(`${f}: ${(e as Error).message}`);
      }
      res.applied.push(f);
    }
  } finally {
    await c.query('SELECT pg_advisory_unlock(727274)').catch(() => undefined);
    await c.end();
  }
  return res;
}

/**
 * The data-model files are written for psql. Strip psql meta-commands (lines starting with a backslash) and turn a
 * trailing `\g …` into a statement terminator, so the same file runs through the driver. The checksum is always
 * taken over the original bytes. Only whole-line meta-commands / trailing \g are touched (never string contents).
 */
export function psqlCompat(sql: string): string {
  return sql
    .split('\n')
    .map((line) => {
      if (/^\s*\\[a-zA-Z]/.test(line)) return '';
      const m = /^(.*?)\s\\g(\s.*)?$/.exec(line);
      return m && !m[1].includes("'") ? `${m[1]};` : line;
    })
    .join('\n');
}
