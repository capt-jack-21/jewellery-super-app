import { Pool, types } from 'pg';
import { PG_POOL, ADMIN_POOL } from '@jw/db';
// numeric (1700) stays a string: money/weights are never JS floats.
types.setTypeParser(1700, (v) => v);
export { PG_POOL, ADMIN_POOL };
export const makePool = () => new Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.PG_POOL_MAX ?? 10) });
/** app_admin (P23 console + pre-auth slug→tenant lookup). Optional: without ADMIN_DATABASE_URL admin routes return 503. */
export const makeAdminPool = () =>
  process.env.ADMIN_DATABASE_URL ? new Pool({ connectionString: process.env.ADMIN_DATABASE_URL, max: Number(process.env.ADMIN_POOL_MAX ?? 3) }) : null;
