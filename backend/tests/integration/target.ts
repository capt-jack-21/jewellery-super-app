/**
 * INF-3: integration target resolution (no side effects, no credentials, no SQL; unit-testable).
 * TEST_DB is REQUIRED: there is no default database. Allowed targets stay locked to the test cluster
 * (127.0.0.1:55432) and to the dedicated shared test DB `jw_it` or a `qa_[a-z0-9_]+` database.
 */
export const SHARED_TEST_DB = 'jw_it';
export const TEST_DB_REQUIRED =
  'TEST_DB is required: set TEST_DB explicitly to jw_it or a qa_[a-z0-9_]+ database on 127.0.0.1:55432 (there is no default target)';
export const UNSAFE_TARGET = 'unsafe TEST database target';
type Env = Record<string, string | undefined>;
export interface TestTarget { host: string; port: string; database: string }
export function assertTestTarget(host: string, port: string, database: string): void {
  if (host !== '127.0.0.1' || port !== '55432' || !(database === SHARED_TEST_DB || /^qa_[a-z0-9_]+$/.test(database)))
    throw new Error(UNSAFE_TARGET);
}
export function resolveTestTarget(env: Env): TestTarget {
  const database = env.TEST_DB;
  if (database === undefined || database.trim() === '') throw new Error(TEST_DB_REQUIRED);
  const host = env.PGHOST ?? env.TEST_DB_HOST ?? '127.0.0.1';
  const port = String(env.PGPORT ?? env.TEST_DB_PORT ?? '55432');
  assertTestTarget(host, port, database);
  return { host, port, database };
}
