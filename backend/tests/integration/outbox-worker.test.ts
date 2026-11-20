import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import PgBoss from 'pg-boss';
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '@jw/db';
import { bossOptions, preflight, relayOnce, RELAY_RETRY_LIMIT, RETENTION_UNCONSUMED_H, ensurePgBossInstalled, startRelay, registerDispatchers, DEVICE_PENDING_TOPIC } from '@jw/worker';
import { readFileSync } from 'node:fs';
import { pool, url, T1, U1 } from './env';

const rw = pool('app_rw');
const wk = pool('app_worker');
let boss: PgBoss;
beforeAll(async () => {
  const opts = bossOptions({ WORKER_DATABASE_URL: url('app_worker') });
  expect(opts.schema).toBe('pgboss');
  // Strict state-aware expectation: a no-reset rerun must preserve the existing installation, not assume an empty TEST DB.
  const present=(await wk.query(`SELECT to_regclass('pgboss.version') IS NOT NULL AS p`)).rows[0].p;
  expect(await ensurePgBossInstalled(url('app_worker'))).toBe(present?'present':'installed');
  expect(await ensurePgBossInstalled(url('app_worker'))).toBe('present');
  boss = new PgBoss(opts); boss.on('error', () => undefined);
  await boss.start();
});
afterAll(async () => { await boss?.stop({ graceful: false, wait: true }); await rw.end(); await wk.end(); });

describe('worker as app_worker with pg-boss schema pgboss', () => {
  it('refuses any role other than app_worker', () => {
    expect(() => bossOptions({ WORKER_DATABASE_URL: url('app_rw') })).toThrow(/app_worker/);
  });
  it('preflight passes as app_worker; pg-boss tables live in pgboss, owned by app_worker', async () => {
    expect(await preflight(url('app_worker'))).toEqual({ ok: true });
    const c = await wk.connect();
    try {
      const r = await c.query(`SELECT count(*)::int n FROM pg_tables WHERE schemaname='pgboss' AND tableowner='app_worker'`);
      expect(r.rows[0].n).toBeGreaterThan(0);
    } finally { c.release(); }
  });
  it('app_rw has no access to the pgboss schema', async () => {
    const c = await rw.connect();
    try { expect((await c.query(`SELECT has_schema_privilege('pgboss','USAGE') u`)).rows[0].u).toBe(false); } finally { c.release(); }
  });
  it('apps/api does not depend on pg-boss', () => {
    const pkg = JSON.parse(readFileSync('apps/api/package.json', 'utf8'));
    expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })).not.toContain('pg-boss');
  });
});

describe('transactional outbox → relay → pg-boss', () => {
  const topic = `test.outbox.${randomUUID()}`;
  it('rerun regression — unique-topic rollback is never enqueued; one committed outbox is enqueued exactly once', async () => {
    await expect(withTenantTx(rw, { tenantId: T1, userId: U1 }, async (c) => {
      await c.query(`INSERT INTO notifications.outbox(tenant_id, topic, payload) VALUES ($1, $2, '{"k":"rolled-back"}')`, [T1, topic]);
      throw new Error('business failure');
    })).rejects.toThrow('business failure');
    await withTenantTx(rw, { tenantId: T1, userId: U1 }, (c) =>
      c.query(`INSERT INTO notifications.outbox(tenant_id, topic, payload) VALUES ($1, $2, '{"k":"committed"}')`, [T1, topic]));

    let n = 0; let k: number;
    while ((k = await relayOnce(wk, boss, 'test-worker')) > 0) n += k;
    expect(n).toBeGreaterThanOrEqual(1);
    expect(await relayOnce(wk, boss, 'test-worker')).toBe(0); // idempotent: nothing re-claimed

    const c = await wk.connect();
    try {
      const jobs = (await c.query(`SELECT data->'payload'->>'k' k FROM pgboss.job WHERE name=$1`, [topic])).rows.map((r) => r.k);
      expect(jobs).toEqual(['committed']);
      const ob = (await c.query(`SELECT status FROM notifications.outbox WHERE topic=$1`, [topic])).rows;
      expect(ob).toEqual([{ status: 'sent' }]);
    } finally { c.release(); }
  });

  it('rerun regression — a unique unconsumed topic has bounded retries/expiry (auth.otp-style)', async () => {
    const unconsumed=`test.unconsumed.${randomUUID()}`;
    await withTenantTx(rw, { tenantId: T1, userId: U1 }, (c) =>
      c.query(`INSERT INTO notifications.outbox(tenant_id, topic, payload) VALUES ($1,$2, '{"k":"x"}')`, [T1,unconsumed]));
    while ((await relayOnce(wk, boss, 'test-worker')) > 0) { /* drain */ }
    const c = await wk.connect();
    try {
      const j = (await c.query(
        `SELECT retry_limit, retry_backoff, extract(epoch FROM expire_in)::int AS exp_s,
                round(extract(epoch FROM keep_until - start_after) / 3600)::int AS keep_h
           FROM pgboss.job WHERE name=$1`,[unconsumed])).rows;
      expect(j).toHaveLength(1);
      expect(j[0]).toMatchObject({ retry_limit: RELAY_RETRY_LIMIT, retry_backoff: true, exp_s: 300, keep_h: RETENTION_UNCONSUMED_H });
    } finally { c.release(); }
  });
});

describe('worker startup wiring: relay loop + platform.device_pending consumer (Blaster: relay was never started)', () => {
  it('a committed pending-device outbox row is relayed and dispatched as an in-app alert, with no manual relayOnce', async () => {
    const deviceId = '00000000-0000-0000-0000-0000000de001';
    const outboxId = (await withTenantTx(rw, { tenantId: T1, userId: U1 }, (c) =>
      c.query<{ id: string }>(`INSERT INTO notifications.outbox(tenant_id, topic, payload, ref_type, ref_id) VALUES ($1, $2, $3, 'device', $4) RETURNING id`,
        [T1, DEVICE_PENDING_TOPIC, JSON.stringify({ device_id: deviceId, name: 'Counter 9', branch_id: '00000000-0000-0000-0000-00000000b001', recipients: [U1] }), deviceId]))).rows[0].id;

    expect(await registerDispatchers(boss, wk)).toEqual([DEVICE_PENDING_TOPIC]);
    const errors: unknown[] = [];
    const loop = startRelay(wk, boss, { workerId: 'test-loop', intervalMs: 200, onError: (e) => errors.push(e) });
    const c = await wk.connect();
    try {
      let alerts: { user_id: string }[] = [];
      for (let i = 0; i < 60 && !alerts.length; i++) {
        await new Promise((r) => setTimeout(r, 500));
        alerts = (await c.query(`SELECT user_id FROM notifications.in_app_alert WHERE tenant_id = $1 AND outbox_id = $2`, [T1, outboxId])).rows;
      }
      expect(alerts).toEqual([{ user_id: U1 }]);
      const ob = (await c.query(`SELECT status, sent_at IS NOT NULL AS sent FROM notifications.outbox WHERE tenant_id = $1 AND id = $2`, [T1, outboxId])).rows;
      expect(ob).toEqual([{ status: 'sent', sent: true }]);
      const job = (await c.query(`SELECT state FROM pgboss.job WHERE name = $1 AND data->>'outboxId' = $2`, [DEVICE_PENDING_TOPIC, outboxId])).rows;
      expect(job).toHaveLength(1);
    } finally {
      c.release();
      await loop.stop();
    }
    expect(loop.running).toBe(false);
    expect(errors).toEqual([]);
    // graceful stop: nothing is claimed after stop()
    const afterStop=(await withTenantTx(rw, { tenantId: T1, userId: U1 }, (cc) =>
      cc.query(`INSERT INTO notifications.outbox(tenant_id, topic, payload) VALUES ($1, 'test.after_stop', '{}') RETURNING id`, [T1]))).rows[0].id;
    await new Promise((r) => setTimeout(r, 600));
    const after = (await wk.query(`SELECT status FROM notifications.outbox WHERE id=$1`,[afterStop])).rows;
    expect(after).toEqual([{ status: 'pending' }]);
  }, 45000);
});
