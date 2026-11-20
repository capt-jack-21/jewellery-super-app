import type PgBoss from 'pg-boss';
import type { Pool } from 'pg';
import { DEVICE_PENDING_TOPIC } from './dispatch';

/** Topics the worker consumes (registerDispatchers). Keep in sync with dispatch.ts. */
export const CONSUMED_TOPICS: ReadonlySet<string> = new Set([DEVICE_PENDING_TOPIC]);

/**
 * pg-boss options for every relayed job (lead decision 2, 5 Nov 2026): bounded retries with backoff, a bounded
 * active time, and a retention window after which a job still in created/retry state is archived by pg-boss
 * maintenance and later deleted. Topics with no consumer yet (auth.otp, platform.user_invited, inventory.*) get a
 * short retention so they cannot pile up in pgboss.job; consumed topics keep 3 days so a worker outage can catch up.
 */
export const RELAY_RETRY_LIMIT = 5;
export const RELAY_RETRY_DELAY_S = 30;
export const RELAY_EXPIRE_IN_S = 300;
export const RETENTION_CONSUMED_H = 72;
export const RETENTION_UNCONSUMED_H = 24;
export function relayJobOptions(topic: string, consumed: ReadonlySet<string> = CONSUMED_TOPICS) {
  return {
    retryLimit: RELAY_RETRY_LIMIT, retryDelay: RELAY_RETRY_DELAY_S, retryBackoff: true,
    expireInSeconds: RELAY_EXPIRE_IN_S,
    retentionHours: consumed.has(topic) ? RETENTION_CONSUMED_H : RETENTION_UNCONSUMED_H,
  };
}
/**
 * Outbox relay (runs as app_worker; app_rw never touches pgboss). In ONE tx: claim committed outbox rows with
 * FOR UPDATE SKIP LOCKED, enqueue each as a pg-boss job through the same connection (atomic with the claim),
 * mark them 'sent' (= dispatched to pg-boss; delivery state lives in the job). Rows from rolled-back producer
 * transactions never exist, so they can never be enqueued.
 */
export async function relayOnce(pool: Pool, boss: PgBoss, workerId: string, limit = 50): Promise<number> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const { rows } = await c.query(
      `UPDATE notifications.outbox SET status='claimed', claimed_at=now(), claimed_by=$1, attempts=attempts+1
        WHERE (tenant_id, id) IN (SELECT tenant_id, id FROM notifications.outbox
               WHERE status IN ('pending','failed') AND available_at <= now()
               ORDER BY priority, available_at LIMIT $2 FOR UPDATE SKIP LOCKED)
        RETURNING tenant_id, id, topic, payload`, [workerId, limit]);
    const db = { executeSql: (text: string, values?: unknown[]) => c.query(text, values as unknown[]) };
    for (const r of rows) {
      await boss.createQueue(r.topic).catch(() => undefined);
      await boss.send(r.topic, { tenantId: r.tenant_id, outboxId: r.id, payload: r.payload },
        { ...relayJobOptions(r.topic), singletonKey: `${r.tenant_id}:${r.id}`, db } as PgBoss.SendOptions);
    }
    if (rows.length)
      await c.query(`UPDATE notifications.outbox SET status='sent', sent_at=now()
                      WHERE (tenant_id, id) IN (SELECT * FROM unnest($1::uuid[], $2::uuid[]))`,
        [rows.map((r) => r.tenant_id), rows.map((r) => r.id)]);
    await c.query('COMMIT');
    return rows.length;
  } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; }
  finally { c.release(); }
}
