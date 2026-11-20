/**
 * Public facade of the notifications module. Other modules import only this file.
 * The API never talks to pg-boss: it writes an outbox row in the CURRENT request transaction (rolled back with it);
 * apps/worker relays committed rows to pg-boss.
 */
import { currentScope, currentTx } from '@jw/db';
export const MODULE = 'notifications' as const;

export interface OutboxMessage {
  topic: string;                       // e.g. 'auth.otp', 'platform.device_pending', 'platform.user_invited'
  payload: Record<string, unknown>;
  priority?: number;                   // 1 = highest; default 5
  ref?: { type: string; id: string };
}

/** Insert into notifications.outbox inside the caller's tenant transaction. Returns the outbox id. */
export async function writeOutbox(msg: OutboxMessage): Promise<string> {
  if (msg.topic.startsWith('alert.')) throw new Error('alert.* topics are written only by the credit-note trigger');
  const { tenantId } = currentScope();
  const r = await currentTx().query<{ id: string }>(
    `INSERT INTO notifications.outbox(tenant_id, topic, payload, priority, ref_type, ref_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [tenantId, msg.topic, JSON.stringify(msg.payload), msg.priority ?? 5, msg.ref?.type ?? null, msg.ref?.id ?? null],
  );
  return r.rows[0].id;
}
