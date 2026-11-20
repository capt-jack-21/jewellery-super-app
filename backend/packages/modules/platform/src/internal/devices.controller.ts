import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { currentTx } from '@jw/db';
import { writeOutbox } from '@jw/mod-notifications';
import { Ctx, JwRequest, RequirePermission, fail, parse, pgProblem, sha256 } from './common';
import { DeviceBody } from './schemas';
import { audit } from './session.service';
import { z } from 'zod';

const COLS = `d.id, d.name, d.kind, d.branch_id, d.status, d.requested_by, d.approved_by, d.approved_at, d.revoked_at, d.revoke_reason,
  d.last_seen_at, d.created_at,
  (SELECT count(*)::int FROM platform.user_session s WHERE s.tenant_id = d.tenant_id AND s.device_id = d.id AND s.revoked_at IS NULL AND s.expires_at > now()) AS live_sessions`;
/** Bind a non-revoked device to the caller's session (same tx, under RLS; app_rw has UPDATE(device_id) on user_session). */
const bindToSession = async (req: JwRequest, deviceId: string) => {
  if (!req.auth?.sessionId) return;
  await currentTx().query(
    `UPDATE platform.user_session SET device_id = $1
      WHERE id = $2 AND revoked_at IS NULL
        AND EXISTS (SELECT 1 FROM platform.device d WHERE d.id = $1 AND d.status <> 'revoked')`, [deviceId, req.auth.sessionId]);
};
/** Active users allowed to approve devices for this branch (role with platform.devices.approve, shop-wide or on that branch).
 * Resolved here (app_rw, tenant RLS) because the worker (app_worker) cannot read users or roles. */
const deviceApprovers = async (branchId: string): Promise<string[]> => (await currentTx().query<{ id: string }>(
  `SELECT DISTINCT u.id FROM platform.app_user u
     JOIN platform.user_role ur ON ur.tenant_id = u.tenant_id AND ur.user_id = u.id
     JOIN platform.role r ON r.tenant_id = ur.tenant_id AND r.id = ur.role_id
     JOIN platform.system_role_permission srp ON srp.role_code = r.system_role_code AND srp.permission_code = 'platform.devices.approve'
    WHERE u.is_active AND (ur.branch_id IS NULL OR ur.branch_id = $1)
    ORDER BY u.id`, [branchId])).rows.map((x) => x.id);
const one = async (id: string) => (await currentTx().query(`SELECT ${COLS} FROM platform.device d WHERE d.id = $1`, [id])).rows[0] ?? fail(404, 'not_found');

@Controller('v1/devices')
export class DevicesController {
  @Get()
  async list(@Query('status') status?: string) {
    return (await currentTx().query(`SELECT ${COLS} FROM platform.device d WHERE ($1::text IS NULL OR d.status = $1) ORDER BY d.created_at`, [status ?? null])).rows;
  }

  /** The device bound to the caller's session (contract 0.4.3): 200 Device, or 200 JSON `null` for an unregistered browser. */
  @Get('current')
  async current(@Ctx() req: JwRequest, @Res({ passthrough: true }) reply: { type(t: string): unknown }) {
    const id = req.auth?.deviceId;
    const row = id ? (await currentTx().query(`SELECT ${COLS} FROM platform.device d WHERE d.id = $1`, [id])).rows[0] : undefined;
    if (row) return row;
    reply.type('application/json; charset=utf-8');
    return 'null'; // literal JSON null body (Nest would otherwise send an empty body for a null return)
  }

  /** P10: register this device (pending). Idempotent per device key; managers are notified via the outbox. */
  @Post()
  async register(@Ctx() req: JwRequest, @Body() body: unknown, @Res({ passthrough: true }) reply: { status(n: number): unknown }) {
    const b = parse(DeviceBody, body);
    const c = currentTx();
    const fp = sha256(b.device_key);
    const existing = await c.query<{ id: string }>(`SELECT id FROM platform.device WHERE fingerprint_hash = $1`, [fp]);
    if (existing.rows[0]) {
      // Already registered for this browser: bind it unless revoked (a revoked device is returned as-is, never bound).
      await bindToSession(req, existing.rows[0].id);
      reply.status(200); return one(existing.rows[0].id);
    }
    try {
      const r = await c.query<{ id: string }>(
        `INSERT INTO platform.device(tenant_id, branch_id, name, kind, fingerprint_hash, requested_by)
         VALUES (platform.current_tenant(), $1, $2, $3, $4, $5) RETURNING id`, [b.branch_id, b.name, b.kind, fp, req.auth?.userId ?? null]);
      await writeOutbox({ topic: 'platform.device_pending', payload: { device_id: r.rows[0].id, name: b.name, branch_id: b.branch_id, recipients: await deviceApprovers(b.branch_id) }, ref: { type: 'device', id: r.rows[0].id } });
      await bindToSession(req, r.rows[0].id);
      return one(r.rows[0].id);
    } catch (e) { return pgProblem(e); }
  }

  @Post(':id/approve') @HttpCode(200) @RequirePermission('platform.devices.approve')
  async approve(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string) {
    const d = await one(id) as { status: string };
    if (d.status === 'revoked') fail(409, 'device_revoked', 'Register the device again');
    if (d.status === 'pending') {
      await currentTx().query(`UPDATE platform.device SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`, [id, req.auth!.userId]);
    }
    return one(id);
  }

  /** Remote logout: revoking a device revokes its live sessions (DB trigger device_revoked). */
  @Post(':id/revoke') @HttpCode(200) @RequirePermission('platform.devices.approve')
  async revoke(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parse(z.object({ reason: z.string().max(200).optional() }).strict(), body);
    const d = await one(id) as { status: string };
    if (d.status !== 'revoked') {
      await currentTx().query(`UPDATE platform.device SET status = 'revoked', revoked_by = $2, revoked_at = now(), revoke_reason = $3 WHERE id = $1`,
        [id, req.auth!.userId, b.reason ?? null]);
      await audit('device.revoked', 'platform.device', id, { reason: b.reason ?? null });
    }
    return one(id);
  }
}
