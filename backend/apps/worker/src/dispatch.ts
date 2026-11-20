import type PgBoss from 'pg-boss';
import type { Pool } from 'pg';
/**
 * Topic handlers for jobs the outbox relay enqueued. Runs as app_worker, which can INSERT/SELECT
 * notifications.in_app_alert (worker_insert policy) but can NOT read platform users or roles, so the
 * producer resolves the recipients in its own tenant transaction and puts them in the payload.
 */
export const DEVICE_PENDING_TOPIC = 'platform.device_pending';
export interface DevicePendingPayload { device_id: string; name: string; branch_id: string; recipients?: string[] }
export interface RelayedJob<P> { tenantId: string; outboxId: string; payload: P }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One in-app alert per recipient (owners/managers who may approve devices for that branch). Idempotent per
 * (tenant, outbox_id, user): a retried or duplicated job inserts nothing new. Returns the number of alerts written.
 */
export async function dispatchDevicePending(pool: Pool, job: RelayedJob<DevicePendingPayload>): Promise<number> {
  const recipients = [...new Set((job.payload.recipients ?? []).filter((u) => typeof u === 'string' && UUID.test(u)))];
  if (!recipients.length) return 0;
  const name = String(job.payload.name ?? 'A device').slice(0, 100);
  const r = await pool.query(
    `INSERT INTO notifications.in_app_alert(tenant_id, user_id, outbox_id, title, body)
     SELECT $1::uuid, u, $2::uuid, $3, $4 FROM unnest($5::uuid[]) AS u
      WHERE NOT EXISTS (SELECT 1 FROM notifications.in_app_alert a
                         WHERE a.tenant_id = $1::uuid AND a.outbox_id = $2::uuid AND a.user_id = u)`,
    [job.tenantId, job.outboxId, 'Device waiting for approval', `${name} is waiting for approval. Approve or revoke it in Settings → Devices.`, recipients]);
  return r.rowCount ?? 0;
}

/** Registers a pg-boss consumer per handled topic. Returns the topics now being consumed. */
export async function registerDispatchers(boss: PgBoss, pool: Pool): Promise<string[]> {
  await boss.createQueue(DEVICE_PENDING_TOPIC).catch(() => undefined);
  await boss.work<RelayedJob<DevicePendingPayload>>(DEVICE_PENDING_TOPIC, { batchSize: 10 }, async (jobs) => {
    for (const j of jobs) await dispatchDevicePending(pool, j.data);
  });
  return [DEVICE_PENDING_TOPIC];
}
