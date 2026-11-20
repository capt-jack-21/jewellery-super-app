import type { Pool } from 'pg';
import { type StorageService, isObjectKey } from '@jw/storage';

/** Only areas whose every reference is covered by the check below. Other tables (branding *_key, purchases test_photo_key)
 *  may hold keys in future, so their areas are NEVER swept until the check includes them. */
const SWEEP_AREA = /^[0-9a-f-]{36}\/imports\/[0-9a-f-]{36}$|^imports\/[0-9a-f-]{36}\/[0-9a-f]{64}\.(csv|xlsx)$/i;
export const isSweepable = (key: string) => isObjectKey(key) && SWEEP_AREA.test(key);

/**
 * Orphan sweep (pg-boss job `storage-orphan-sweep`, hourly, runs as app_worker).
 * Deletes storage objects that are older than the grace period AND referenced by no platform.file row (any, soft-deleted
 * included) and no platform.import_job.file_key / error_report_key. Fail safe: if references can't be verified (missing
 * grant/policy, query error) nothing is deleted. Logs counts only, never keys (keys carry tenant ids).
 */
export interface SweepConfig { graceMs: number; batch: number; maxScan: number; dryRun: boolean; prefix: string }
/** Returns the subset of keys that ARE referenced. Must throw if it cannot answer for every key. */
export type ReferenceCheck = (keys: string[]) => Promise<Set<string>>;
export interface SweepResult {
  status: 'ok' | 'dry_run' | 'reference_check_failed' | 'list_failed';
  scanned: number; tooYoung: number; unrecognised: number; candidates: number; referenced: number;
  deleted: number; wouldDelete: number; deleteErrors: number; truncated: boolean;
}

export function sweepConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SweepConfig {
  const int = (name: string, def: number, min: number, max: number) => {
    const raw = env[name];
    if (raw === undefined || raw === '') return def;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`invalid env: ${name} (integer ${min}..${max})`);
    return n;
  };
  const dry = env.ORPHAN_SWEEP_DRY_RUN ?? '1';
  if (!['0', '1', 'true', 'false'].includes(dry)) throw new Error('invalid env: ORPHAN_SWEEP_DRY_RUN (0|1)');
  return {
    graceMs: int('ORPHAN_SWEEP_GRACE_HOURS', 24, 24, 24 * 90) * 3_600_000,   // never below 24 h (in-flight uploads)
    batch: int('ORPHAN_SWEEP_BATCH', 500, 1, 5000),
    maxScan: int('ORPHAN_SWEEP_MAX_SCAN', 50_000, 1, 1_000_000),
    dryRun: dry === '1' || dry === 'true',
    prefix: '',
  };
}

export async function sweepOrphans(storage: StorageService, refs: ReferenceCheck, cfg: SweepConfig, now = new Date(),
                                   log: (m: string) => void = console.log): Promise<SweepResult> {
  const r: SweepResult = { status: cfg.dryRun ? 'dry_run' : 'ok', scanned: 0, tooYoung: 0, unrecognised: 0, candidates: 0, referenced: 0,
    deleted: 0, wouldDelete: 0, deleteErrors: 0, truncated: false };
  const cutoff = now.getTime() - cfg.graceMs;
  const candidates: string[] = [];
  try {
    for await (const o of storage.list(cfg.prefix)) {
      if (r.scanned >= cfg.maxScan || candidates.length >= cfg.batch) { r.truncated = true; break; }
      r.scanned++;
      if (!isSweepable(o.key)) { r.unrecognised++; continue; }           // other areas / foreign objects are never touched
      if (!(o.lastModified instanceof Date) || Number.isNaN(o.lastModified.getTime()) || o.lastModified.getTime() > cutoff) { r.tooYoung++; continue; }
      candidates.push(o.key);
    }
  } catch {
    r.status = 'list_failed'; report(r, log); return r;
  }
  r.candidates = candidates.length;
  if (!candidates.length) { report(r, log); return r; }
  let referenced: Set<string>;
  try { referenced = await refs(candidates); } catch {
    r.status = 'reference_check_failed'; report(r, log); return r;       // NEVER delete when references are unknown
  }
  for (const k of candidates) {
    if (referenced.has(k)) { r.referenced++; continue; }
    if (cfg.dryRun) { r.wouldDelete++; continue; }
    try { await storage.delete(k); r.deleted++; } catch { r.deleteErrors++; }
  }
  report(r, log);
  return r;
}
function report(r: SweepResult, log: (m: string) => void) {
  log(`storage-orphan-sweep ${JSON.stringify(r)}`);
}

/**
 * Reference check as app_worker. Needs schema request 975 (worker SELECT policy + column grants on platform.file.object_key
 * and platform.import_job.file_key/error_report_key). Before querying it verifies the role can really see every tenant's rows:
 * RLS without a worker policy returns ZERO rows instead of an error, which would make every object look orphaned.
 */
export function pgReferenceCheck(pool: Pool): ReferenceCheck {
  return async (keys) => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN READ ONLY');
      const pre = (await c.query<{ ok: boolean }>(`
        SELECT has_column_privilege('platform.file', 'object_key', 'SELECT')
           AND has_column_privilege('platform.import_job', 'file_key', 'SELECT')
           AND has_column_privilege('platform.import_job', 'error_report_key', 'SELECT')
           AND EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'platform' AND tablename = 'file'
                        AND cmd IN ('SELECT', 'ALL') AND permissive = 'PERMISSIVE' AND current_user = ANY (roles) AND qual = 'true')
           AND EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'platform' AND tablename = 'import_job'
                        AND cmd IN ('SELECT', 'ALL') AND permissive = 'PERMISSIVE' AND current_user = ANY (roles) AND qual = 'true') AS ok`)).rows[0];
      if (!pre?.ok) throw new Error('reference check unavailable: app_worker cannot read platform.file / platform.import_job references (schema request 975)');
      const r = await c.query<{ k: string }>(`
        SELECT object_key AS k FROM platform.file WHERE object_key = ANY ($1::text[])
        UNION SELECT file_key FROM platform.import_job WHERE file_key = ANY ($1::text[])
        UNION SELECT error_report_key FROM platform.import_job WHERE error_report_key = ANY ($1::text[])`, [keys]);
      await c.query('COMMIT');
      return new Set(r.rows.map((x) => x.k));
    } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; }
    finally { c.release(); }
  };
}
