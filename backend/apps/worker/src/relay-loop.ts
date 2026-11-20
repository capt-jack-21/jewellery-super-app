import type PgBoss from 'pg-boss';
import type { Pool } from 'pg';
import { relayOnce } from './relay';

export interface RelayLoopOptions { workerId: string; intervalMs?: number; batch?: number; maxBatchesPerTick?: number; onError?: (e: unknown) => void; /** Injected in unit tests; defaults to relayOnce. */ relay?: typeof relayOnce }
export interface RelayLoop { /** Run one drain now (also used by tests). */ tick(): Promise<number>; /** Stop polling and wait for an in-flight drain. */ stop(): Promise<void>; readonly running: boolean }

/** OUTBOX_RELAY_INTERVAL_MS (default 2000, 200–60000). */
export function relayIntervalFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OUTBOX_RELAY_INTERVAL_MS;
  if (raw === undefined || raw === '') return 2000;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 200 || n > 60000) throw new Error('OUTBOX_RELAY_INTERVAL_MS must be an integer 200–60000');
  return n;
}

/**
 * Polls notifications.outbox and relays committed rows to pg-boss (relayOnce: claim + enqueue + mark sent in ONE tx).
 * Each tick drains up to maxBatchesPerTick batches, then sleeps intervalMs. Ticks never overlap. stop() is graceful:
 * no new tick starts, and it resolves after the current one commits or rolls back.
 */
export function startRelay(pool: Pool, boss: PgBoss, o: RelayLoopOptions): RelayLoop {
  const intervalMs = o.intervalMs ?? 2000; const batch = o.batch ?? 50; const maxBatches = o.maxBatchesPerTick ?? 20;
  const relay = o.relay ?? relayOnce;
  const onError = o.onError ?? ((e) => console.error('outbox relay tick failed', e));
  let stopped = false; let timer: NodeJS.Timeout | undefined; let inFlight: Promise<number> | undefined;
  const drain = async () => {
    let total = 0;
    for (let i = 0; i < maxBatches && !stopped; i++) {
      const n = await relay(pool, boss, o.workerId, batch);
      total += n;
      if (n < batch) break;
    }
    return total;
  };
  const tick = (): Promise<number> => {
    if (inFlight) return inFlight;
    inFlight = drain().finally(() => { inFlight = undefined; });
    return inFlight;
  };
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => { void tick().catch(onError).finally(schedule); }, intervalMs);
  };
  void tick().catch(onError).finally(schedule);
  return {
    tick,
    get running() { return !stopped; },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight?.catch(() => undefined);
    },
  };
}
