import type { Pool } from 'pg';
import { open } from '@jw/shared';
/**
 * OTP delivery (runs as app_worker: SELECT + DELETE on platform.otp_delivery; the code never sits in the outbox).
 * Outbox payload (topic auth.otp): { delivery_id, challenge_id, channel, to }. In ONE tx: lock the row, delete it,
 * decrypt, send. If send throws the tx rolls back and the row stays for retry until it expires. Expired → deleted, not sent.
 * UNVERIFIED: written under the no-run rule.
 */
export interface OtpPayload { delivery_id: string; challenge_id: string; channel: 'sms' | 'whatsapp'; to: string }
export type OtpSender = (m: { channel: 'sms' | 'whatsapp'; to: string; code: string }) => Promise<void>;
export async function deliverOtp(pool: Pool, tenantId: string, p: OtpPayload, send: OtpSender): Promise<'sent' | 'expired' | 'missing'> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await c.query<{ key_id: string; ciphertext: Buffer; live: boolean }>(
      `DELETE FROM platform.otp_delivery WHERE tenant_id = $1 AND id = $2
       RETURNING key_id, ciphertext, (expires_at > now()) AS live`, [tenantId, p.delivery_id]);
    const row = r.rows[0];
    if (!row) { await c.query('COMMIT'); return 'missing'; }
    if (!row.live) { await c.query('COMMIT'); return 'expired'; }
    const code = open(row.key_id, row.ciphertext, `${tenantId}:${p.challenge_id}`).toString('utf8');
    await send({ channel: p.channel, to: p.to, code });
    await c.query('COMMIT');
    return 'sent';
  } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; }
  finally { c.release(); }
}
/** Housekeeping: drop expired undelivered rows. */
export async function purgeExpiredOtp(pool: Pool): Promise<number> {
  return (await pool.query(`DELETE FROM platform.otp_delivery WHERE expires_at <= now()`)).rowCount ?? 0;
}
