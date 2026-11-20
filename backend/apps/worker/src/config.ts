import type { ConstructorOptions } from 'pg-boss';
export const PGBOSS_SCHEMA = 'pgboss';
/**
 * Worker connects as app_worker (never app_rw). pg-boss uses schema 'pgboss' and does NOT create the schema
 * itself: 035_pgboss.sql creates schema pgboss AUTHORIZATION app_worker, so ensurePgBossInstalled() creates its tables there without CREATE SCHEMA.
 * preflight() refuses to start if the schema is missing, so pg-boss never needs CREATE on the database.
 */
export function bossOptions(env: NodeJS.ProcessEnv = process.env): ConstructorOptions {
  const url = env.WORKER_DATABASE_URL;
  if (!url) throw new Error('WORKER_DATABASE_URL is required');
  const user = decodeURIComponent(new URL(url).username);
  if (user !== 'app_worker') throw new Error(`worker must connect as app_worker, got "${user}"`);
  return { connectionString: url, schema: PGBOSS_SCHEMA, migrate: false };
}
