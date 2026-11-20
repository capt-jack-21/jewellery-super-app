import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { Pool, types } from 'pg';
import { resolveTestTarget, assertTestTarget as assertTarget } from './target';
types.setTypeParser(1700, (v) => v);
export { SHARED_TEST_DB, TEST_DB_REQUIRED, UNSAFE_TARGET, resolveTestTarget } from './target';
// INF-3: explicit TEST_DB required (no jw_it default); fails fast before credentials, pools, SQL or child processes.
const TARGET = resolveTestTarget(process.env);
export const DB = TARGET.database;
export const HOST = TARGET.host;
export const PORT = TARGET.port;
/** No demo/shared-dev target, alternate cluster or SQL-shaped DB identifier can enter this harness. */
export function assertTestTarget(host = HOST, port = String(PORT), database = DB): void { assertTarget(host, port, database); }

/** Same source as scripts/test-db.sh: TEST_ROLE_PASSWORD, else the per-build random password file (never in the repo). */
const PW_FILE = process.env.TEST_ROLE_PASSWORD_FILE ?? `${process.env.XDG_RUNTIME_DIR ?? '/tmp'}/jw-test-role-pw-${process.env.USER ?? userInfo().username}`;
export const ROLE_PASSWORD = process.env.TEST_ROLE_PASSWORD ?? readFileSync(PW_FILE, 'utf8').trim();
export const url = (role: string) => `postgres://${role}:${encodeURIComponent(ROLE_PASSWORD)}@${HOST}:${PORT}/${DB}`;
export const T1 = '00000000-0000-0000-0000-000000000001';
export const T2 = '00000000-0000-0000-0000-000000000002';
export const U1 = '00000000-0000-0000-0000-000000000a01';
export const B1 = '00000000-0000-0000-0000-00000000b001';
export const TAG1 = '00000000-0000-0000-0000-00000000f001';
export const MIGRATIONS = process.env.MIGRATIONS_DIR ?? `${process.env.DATA_MODEL_DIR ?? '/workspace/jewellery-data-model'}/migrations`;
export const pool = (role: string) => new Pool({ connectionString: url(role), max: 4 });
