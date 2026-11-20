import { mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { pgReferenceCheck, sweepOrphans } from '@jw/worker';
import { LocalDiskDriver, objectKey } from '@jw/mod-platform';
import { pool, T1 } from './env';

const wk = pool('app_worker');
afterAll(async () => { await wk.end(); });

describe('storage-orphan-sweep as app_worker (fail safe until schema request 975)', () => {
  it('app_worker has no SELECT on platform.file / import_job references today', async () => {
    const r = (await wk.query(`SELECT has_column_privilege('platform.file', 'object_key', 'SELECT') f,
                                      has_column_privilege('platform.import_job', 'file_key', 'SELECT') j`)).rows[0];
    expect(r).toEqual({ f: false, j: false });
  });
  it('reference check refuses, so an old orphan is NOT deleted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jw-sweep-it-'));
    try {
      const d = new LocalDiskDriver(dir);
      const k = objectKey(T1, 'imports');
      await d.put(k, Buffer.from('x'), 'text/csv');
      const t = new Date(Date.now() - 72 * 3_600_000); await utimes(join(dir, k), t, t);
      await expect(pgReferenceCheck(wk)([k])).rejects.toThrow(/975/);
      const r = await sweepOrphans(d, pgReferenceCheck(wk), { graceMs: 24 * 3_600_000, batch: 10, maxScan: 100, dryRun: false, prefix: '' }, new Date(), () => undefined);
      expect(r).toMatchObject({ status: 'reference_check_failed', candidates: 1, deleted: 0 });
      expect(await d.head(k)).not.toBeNull();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
