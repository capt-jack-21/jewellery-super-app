import { describe, expect, it, vi } from 'vitest';
import { relayIntervalFromEnv, startRelay } from './relay-loop';
const pool = {} as never; const boss = {} as never;

describe('relayIntervalFromEnv', () => {
  it('defaults to 2000 ms and validates the range', () => {
    expect(relayIntervalFromEnv({})).toBe(2000);
    expect(relayIntervalFromEnv({ OUTBOX_RELAY_INTERVAL_MS: '500' })).toBe(500);
    expect(() => relayIntervalFromEnv({ OUTBOX_RELAY_INTERVAL_MS: '50' })).toThrow(/OUTBOX_RELAY_INTERVAL_MS/);
    expect(() => relayIntervalFromEnv({ OUTBOX_RELAY_INTERVAL_MS: 'fast' })).toThrow(/OUTBOX_RELAY_INTERVAL_MS/);
  });
});

describe('startRelay', () => {
  it('drains full batches in one tick until a short batch', async () => {
    const seq = [50, 50, 7];
    const relay = vi.fn(async () => seq.shift() ?? 0);
    const loop = startRelay(pool, boss, { workerId: 'w', intervalMs: 60_000, batch: 50, relay });
    await expect(loop.tick()).resolves.toBe(107);   // joins the in-flight startup drain
    expect(relay).toHaveBeenCalledTimes(3);
    expect(relay).toHaveBeenCalledWith(pool, boss, 'w', 50);
    await loop.stop();
    expect(loop.running).toBe(false);
  });
  it('stop() waits for the in-flight batch and starts no further batch', async () => {
    let release: (() => void) | undefined;
    const relay = vi.fn(() => new Promise<number>((r) => { release = () => r(50); }));
    const loop = startRelay(pool, boss, { workerId: 'w', intervalMs: 60_000, batch: 50, relay });
    let done = false;
    const stopping = loop.stop().then(() => { done = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);                        // still waiting for the batch to commit
    release?.();
    await stopping;
    expect(relay).toHaveBeenCalledTimes(1);          // full batch, but stopped: no second batch
  });
  it('keeps polling after an error and reports it', async () => {
    let n = 0;
    const relay = vi.fn(async () => { n++; if (n === 1) throw new Error('db down'); return 0; });
    const errors: unknown[] = [];
    const loop = startRelay(pool, boss, { workerId: 'w', intervalMs: 200, relay, onError: (e) => errors.push(e) });
    await new Promise((r) => setTimeout(r, 700));
    await loop.stop();
    expect(errors).toHaveLength(1);
    expect(n).toBeGreaterThanOrEqual(2);
    const calls = n;
    await new Promise((r) => setTimeout(r, 400));
    expect(n).toBe(calls);   // no ticks after stop()
  });
});
