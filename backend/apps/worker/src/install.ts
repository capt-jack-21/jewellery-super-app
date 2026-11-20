import PgBoss from 'pg-boss';
import { Client } from 'pg';
import { PGBOSS_SCHEMA } from './config';
/**
 * pg-boss's own installer runs `CREATE SCHEMA IF NOT EXISTS`, which needs CREATE on the database (app_worker lacks it).
 * The data model (035_pgboss.sql) already creates schema pgboss AUTHORIZATION app_worker, so we run pg-boss's
 * construction plan ourselves with that one statement removed, then start pg-boss with migrate: false.
 * Version upgrades of pg-boss: same approach with PgBoss.getMigrationPlans (M1 runbook).
 */
export async function ensurePgBossInstalled(url: string): Promise<'installed' | 'present'> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    const present = (await c.query(`SELECT to_regclass($1) IS NOT NULL AS p`, [`${PGBOSS_SCHEMA}.version`])).rows[0].p;
    if (present) return 'present';
    const sql = PgBoss.getConstructionPlans(PGBOSS_SCHEMA).replace(/CREATE SCHEMA IF NOT EXISTS \S+\s*;/, '');
    if (/CREATE SCHEMA/i.test(sql)) throw new Error('unexpected CREATE SCHEMA in pg-boss plan');
    await c.query(sql);
    return 'installed';
  } finally { await c.end(); }
}
