import { Client } from 'pg';
import { PGBOSS_SCHEMA } from './config';
/** Fail fast with a clear reason instead of letting pg-boss try to CREATE SCHEMA. */
export async function preflight(url: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    const r = await c.query(`SELECT current_user AS u, to_regnamespace($1) IS NOT NULL AS exists,
      CASE WHEN to_regnamespace($1) IS NULL THEN false ELSE has_schema_privilege($1,'USAGE') END AS usage`, [PGBOSS_SCHEMA]);
    const { u, exists, usage } = r.rows[0];
    if (u !== 'app_worker') return { ok: false, reason: `connected as ${u}, expected app_worker` };
    if (!exists) return { ok: false, reason: `schema ${PGBOSS_SCHEMA} missing (must be created by the data model)` };
    if (!usage) return { ok: false, reason: `app_worker lacks USAGE on ${PGBOSS_SCHEMA}` };
    return { ok: true };
  } finally { await c.end(); }
}
