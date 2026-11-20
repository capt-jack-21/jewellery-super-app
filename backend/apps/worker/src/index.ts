import PgBoss from 'pg-boss';
import { bossOptions } from './config';
import { preflight } from './preflight';
export { bossOptions, preflight };
export { relayOnce, relayJobOptions, CONSUMED_TOPICS, RELAY_RETRY_LIMIT, RETENTION_CONSUMED_H, RETENTION_UNCONSUMED_H } from './relay';
export { startRelay, relayIntervalFromEnv, type RelayLoop, type RelayLoopOptions } from './relay-loop';
export { registerDispatchers, dispatchDevicePending, DEVICE_PENDING_TOPIC, type DevicePendingPayload, type RelayedJob } from './dispatch';
import { startRelay, relayIntervalFromEnv, type RelayLoop } from './relay-loop';
import { registerDispatchers } from './dispatch';
import { hostname } from 'node:os';
export { deliverOtp, purgeExpiredOtp } from './otp';
export type { OtpPayload, OtpSender } from './otp';
export { ensurePgBossInstalled } from './install';
import { ensurePgBossInstalled } from './install';
export { sweepOrphans, pgReferenceCheck, sweepConfigFromEnv, isSweepable, type SweepResult, type SweepConfig, type ReferenceCheck } from './orphan-sweep';
import { Pool } from 'pg';
import { storageFromEnv } from '@jw/storage';
import { pgReferenceCheck, sweepConfigFromEnv, sweepOrphans } from './orphan-sweep';
export const WORKER_JOBS = ['outbox-relay', 'inv6-series-gaps', 'storage-orphan-sweep'] as const;
export const ORPHAN_SWEEP_JOB = 'storage-orphan-sweep';

/** Registers the hourly orphan sweep (env validated here, at boot). ORPHAN_SWEEP_ENABLED=0 skips it. */
export async function registerOrphanSweep(boss: PgBoss, connectionString: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (env.ORPHAN_SWEEP_ENABLED === '0') return false;
  const cfg = sweepConfigFromEnv(env);
  const storage = storageFromEnv(env);
  const pool = new Pool({ connectionString, max: 2 });
  await boss.createQueue(ORPHAN_SWEEP_JOB);
  await boss.schedule(ORPHAN_SWEEP_JOB, env.ORPHAN_SWEEP_CRON || '17 * * * *', {}, { tz: 'Asia/Kolkata' });
  await boss.work(ORPHAN_SWEEP_JOB, { batchSize: 1 }, async () => { await sweepOrphans(storage, pgReferenceCheck(pool), cfg); });
  return true;
}

async function main() {
  const opts = bossOptions();
  const pf = await preflight(opts.connectionString!);
  if (!pf.ok) { console.error(`worker preflight failed: ${pf.reason}`); process.exit(1); }
  await ensurePgBossInstalled(opts.connectionString!);
  const intervalMs = relayIntervalFromEnv();   // validate env before starting anything
  const boss = new PgBoss(opts);
  boss.on('error', (e) => console.error(e));
  await boss.start();
  const pool = new Pool({ connectionString: opts.connectionString!, max: 4 });
  const topics = await registerDispatchers(boss, pool);
  const sweep = await registerOrphanSweep(boss, opts.connectionString!);
  let relay: RelayLoop | undefined;
  if (process.env.OUTBOX_RELAY_ENABLED !== '0') relay = startRelay(pool, boss, { workerId: `${hostname()}:${process.pid}`, intervalMs });
  console.log(`worker started; relay: ${relay ? `on (${intervalMs} ms)` : 'off'}; consumers: ${topics.join(', ')}; jobs: ${sweep ? ORPHAN_SWEEP_JOB : 'none'}`);

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return; stopping = true;
    console.log(`worker: ${signal} received, shutting down`);
    const hard = setTimeout(() => { console.error('worker: graceful shutdown timed out'); process.exit(1); }, 35_000);
    hard.unref();
    try {
      await relay?.stop();                                              // no new claims; in-flight relay tx finishes
      await boss.stop({ graceful: true, wait: true, timeout: 30_000 }); // let running handlers complete
      await pool.end();
      process.exit(0);
    } catch (e) { console.error('worker: shutdown error', e); process.exit(1); }
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}
if (require.main === module) void main();
