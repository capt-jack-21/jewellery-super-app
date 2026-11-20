import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { ADMIN_POOL, PG_POOL, currentTx, refineScope, withTenantTx } from '@jw/db';
import { writeOutbox } from '@jw/mod-notifications';
import { seal } from '@jw/shared';
import { USER_COLS } from './users.repo';
import {
  AuthContext, JwRequest, LOGIN_MAX_FAILS, LOGIN_WINDOW_MIN, Problem, RateLimited, SESSION_ABSOLUTE_HOURS, bucketClear, bucketRetryAfter, bucketHit, bucketKey, bucketLocked, fail, hashPassword, hostOf, newToken, otpCode, otpHash, sha256, verifyPassword,
} from './common';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type AuthFail = { fail: 'session_invalid' | 'session_idle_timeout' | 'tenant_suspended' };
export interface LoginUser { id: string; phone: string | null; password_hash: string | null }
export type LoginResult =
  | { kind: 'session'; token: string; tenantId: string; sessionId: string }
  | { kind: 'otp'; challengeId: string; channel: string; masked: string; expiresAt: string }
  | { kind: 'fail'; code: string };

/** Effective setting value (tenant override → platform default) in the current tenant tx. */
export async function effectiveSetting<T = unknown>(key: string, branchId?: string | null): Promise<T> {
  const r = await currentTx().query<{ v: T }>(
    `SELECT coalesce((SELECT value FROM platform.setting WHERE key = $1 AND branch_id = $2::uuid),
                     (SELECT value FROM platform.setting WHERE key = $1 AND branch_id IS NULL),
                     (SELECT value FROM platform.setting_default WHERE key = $1)) AS v`, [key, branchId ?? null]);
  return r.rows[0]?.v as T;
}

export async function audit(action: string, table: string | null, rowId: string | null, data: unknown = null): Promise<void> {
  await currentTx().query(
    `SELECT platform.audit_append(platform.current_tenant(), $1, $2, $3::uuid, NULL, $4::jsonb)`,
    [action, table, rowId, data === null ? null : JSON.stringify(data)]);
}

export async function loadPermissions(userId: string): Promise<{ roles: { role: string; branch_id: string | null }[]; permissions: Set<string> }> {
  const c = currentTx();
  const roles = await c.query<{ role: string; branch_id: string | null }>(
    `SELECT r.system_role_code AS role, ur.branch_id FROM platform.user_role ur
       JOIN platform.role r ON r.tenant_id = ur.tenant_id AND r.id = ur.role_id
      WHERE ur.user_id = $1 ORDER BY r.system_role_code, ur.branch_id NULLS FIRST`, [userId]);
  const perms = await c.query<{ code: string }>(
    `SELECT DISTINCT srp.permission_code AS code FROM platform.user_role ur
       JOIN platform.role r ON r.tenant_id = ur.tenant_id AND r.id = ur.role_id
       JOIN platform.system_role_permission srp ON srp.role_code = r.system_role_code
      WHERE ur.user_id = $1`, [userId]);
  return { roles: roles.rows, permissions: new Set(perms.rows.map((p) => p.code)) };
}

@Injectable()
export class SessionService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool, @Inject(ADMIN_POOL) private readonly adminPool: Pool | null) {}

  /** Tenant from a verified custom domain (Host) or from the shop slug (pre-auth). */
  async tenantForHost(req: JwRequest): Promise<string | null> {
    const host = hostOf(req);
    if (!host) return null;
    const r = await withTenantTx(this.pool, { tenantId: '' }, (c) => c.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM branding.custom_domain WHERE hostname = $1 AND status = 'verified' AND tenant_id IS NOT NULL`, [host]));
    return r.rows[0]?.tenant_id ?? null;
  }

  get tenantPool(): Pool { return this.pool; }
  get platformAdminPool(): Pool | null { return this.adminPool; }

  async resolveTenant(req: JwRequest, slug?: string): Promise<string> {
    const host = hostOf(req);
    if (host) {
      const r = await withTenantTx(this.pool, { tenantId: '' }, (c) => c.query<{ tenant_id: string }>(
        `SELECT tenant_id FROM branding.custom_domain WHERE hostname = $1 AND status = 'verified' AND tenant_id IS NOT NULL`, [host]));
      if (r.rows[0]) return r.rows[0].tenant_id;
    }
    if (!slug) throw new Problem(422, 'tenant_required', 'Pass the shop slug (tenant) or use the shop domain');
    // v1.4: platform.resolve_tenant(slug) — EXECUTE granted to app_rw, no tenant context needed (no admin pool on the login path).
    const r = await withTenantTx(this.pool, { tenantId: '' }, (c) => c.query<{ tenant_id: string; status: string }>(
      `SELECT tenant_id, status FROM platform.resolve_tenant($1)`, [slug]));
    if (!r.rows[0]?.tenant_id) throw new Problem(401, 'invalid_credentials');
    return r.rows[0].tenant_id;
  }

  /** Password login. Runs in its own tenant tx so failed-attempt counters commit even when the login fails. */
  async passwordLogin(tenantId: string, login: string, password: string, deviceKey: string | undefined, ip: string): Promise<LoginResult> {
    return withTenantTx(this.pool, { tenantId }, async (c) => {
      if (!(await this.tenantUsable())) { await verifyPassword(null, password); return { kind: 'fail', code: 'invalid_credentials' }; }
      // v1.5 lockout: platform.rate_limit_bucket keyed by sha256(login) — applies to unknown logins too (no enumeration)
      const key = bucketKey('login.tenant', tenantId, login);
      if (await bucketLocked(c, key)) { await verifyPassword(null, password); return { kind: 'fail', code: 'invalid_credentials' }; }
      const u = await this.findUser(login);
      if (!u || !(await verifyPassword(u?.password_hash ?? null, password))) {
        await bucketHit(c, key, LOGIN_MAX_FAILS, LOGIN_WINDOW_MIN);
        return { kind: 'fail', code: 'invalid_credentials' };
      }
      await bucketClear(c, [key]);
      if ((await effectiveSetting<boolean>('auth.otp_login_enabled')) === true && u.phone) { await this.otpSendLimit(tenantId, login); return this.startOtp(tenantId, u, 'p'); }
      return this.createSession(tenantId, u.id, 'password', deviceKey, ip);
    });
  }

  /** OTP-only login start. Unknown users get a decoy challenge (no enumeration). */
  async otpStart(tenantId: string, login: string): Promise<LoginResult> {
    return withTenantTx(this.pool, { tenantId }, async () => {
      if ((await effectiveSetting<boolean>('auth.otp_login_enabled')) !== true) return { kind: 'fail', code: 'otp_login_disabled' };
      // v1.5: the same OTP-send limit for known and unknown logins, keyed by sha256(login), so a 429 reveals nothing
      await this.otpSendLimit(tenantId, login);
      const u = (await this.tenantUsable()) && !(await bucketLocked(currentTx(), bucketKey('login.tenant', tenantId, login))) ? await this.findUser(login) : null;
      if (!u || !u.phone) {
        return { kind: 'otp', challengeId: `${tenantId}.${randomUUID()}.o`, channel: 'sms', masked: '******', expiresAt: new Date(Date.now() + 600_000).toISOString() };
      }
      return this.startOtp(tenantId, u, 'o');
    });
  }

  private async startOtp(tenantId: string, u: LoginUser, mode: 'p' | 'o'): Promise<LoginResult> {
    const c = currentTx();
    const channel = String((await effectiveSetting<string>('auth.otp_channel')) ?? 'sms');
    const code = otpCode();
    const id = randomUUID();
    const r = await c.query<{ expires_at: Date }>(
      `INSERT INTO platform.otp_challenge(tenant_id, id, user_id, channel, code_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + interval '10 minutes') RETURNING expires_at`,
      [tenantId, id, u.id, channel, otpHash(id, code)]);
    // v1.4: the code exists only as AES-GCM ciphertext in platform.otp_delivery (app_rw INSERT only; the worker reads+deletes).
    const box = seal(code, `${tenantId}:${id}`);
    const deliveryId = randomUUID();   // app_rw is INSERT-only on otp_delivery (no RETURNING → no SELECT needed)
    await c.query(
      `INSERT INTO platform.otp_delivery(tenant_id, id, otp_challenge_id, channel, key_id, ciphertext, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + interval '10 minutes')`, [tenantId, deliveryId, id, channel, box.keyId, box.box]);
    await writeOutbox({ topic: 'auth.otp', priority: 1, payload: { delivery_id: deliveryId, challenge_id: id, channel, to: u.phone }, ref: { type: 'otp_challenge', id } });
    return { kind: 'otp', challengeId: `${tenantId}.${id}.${mode}`, channel, masked: `******${(u.phone ?? '').slice(-4)}`, expiresAt: r.rows[0].expires_at.toISOString() };
  }

  async otpVerify(challengeId: string, code: string, deviceKey: string | undefined, ip: string): Promise<LoginResult> {
    const [tenantId, id, mode] = challengeId.split('.');
    if (!UUID.test(tenantId ?? '') || !UUID.test(id ?? '')) return { kind: 'fail', code: 'otp_invalid' };
    return withTenantTx(this.pool, { tenantId }, async (c) => {
      const r = await c.query<{ user_id: string; code_hash: Buffer; attempts: number; live: boolean }>(
        `SELECT user_id, code_hash, attempts, (consumed_at IS NULL AND expires_at > now()) AS live
           FROM platform.otp_challenge WHERE id = $1 FOR UPDATE`, [id]);
      const ch = r.rows[0];
      if (!ch || !ch.live || ch.attempts >= 5 || !(await this.tenantUsable())) return { kind: 'fail', code: 'otp_invalid' };
      if (!otpHash(id, code).equals(ch.code_hash)) {
        await c.query(`UPDATE platform.otp_challenge SET attempts = attempts + 1 WHERE id = $1`, [id]);
        return { kind: 'fail', code: 'otp_invalid' };
      }
      await c.query(`UPDATE platform.otp_challenge SET consumed_at = now() WHERE id = $1`, [id]);
      const u = await c.query<{ is_active: boolean }>(`SELECT is_active FROM platform.app_user WHERE id = $1`, [ch.user_id]);
      if (!u.rows[0]?.is_active) return { kind: 'fail', code: 'otp_invalid' };
      return this.createSession(tenantId, ch.user_id, mode === 'p' ? 'password' : 'otp', deviceKey, ip);
    });
  }

  /** At most 3 OTP sends per login identifier per 15 minutes (platform.rate_limit_bucket, otp.send). */
  private async otpSendLimit(tenantId: string, login: string): Promise<void> {
    const c = currentTx();
    const key = bucketKey('otp.send', tenantId, login);
    const wait = await bucketRetryAfter(c, key);
    if (wait > 0) throw new RateLimited(wait, 'Too many OTP requests; try again later');
    await bucketHit(c, key, 3, 15);
  }

  private async tenantUsable(): Promise<boolean> {
    const t = await currentTx().query<{ status: string }>(`SELECT status FROM platform.tenant WHERE id = platform.current_tenant()`);
    return !!t.rows[0] && t.rows[0].status !== 'suspended';
  }

  private async findUser(login: string): Promise<LoginUser | null> {
    const r = await currentTx().query<LoginUser>(
      `SELECT id, phone, password_hash FROM platform.app_user
        WHERE is_active AND (username = lower($1) OR phone = $1) LIMIT 1`, [login.trim()]);
    return r.rows[0] ?? null;
  }

  private async createSession(tenantId: string, userId: string, method: 'password' | 'otp', deviceKey: string | undefined, ip: string): Promise<LoginResult> {
    const c = currentTx();
    await refineScope({ userId });
    let deviceId: string | null = null;
    if (deviceKey) {
      // Bind any non-revoked device (pending or approved); billing stays gated by device_ok = (status = 'approved').
      const d = await c.query<{ id: string }>(`SELECT id FROM platform.device WHERE fingerprint_hash = $1 AND status <> 'revoked'`, [sha256(deviceKey)]);
      deviceId = d.rows[0]?.id ?? null;
      if (deviceId) await c.query(`UPDATE platform.device SET last_seen_at = now() WHERE id = $1`, [deviceId]);
    }
    const token = newToken();
    const s = await c.query<{ id: string }>(
      `INSERT INTO platform.user_session(tenant_id, user_id, device_id, auth_method, token_hash, ip, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6::inet, now() + make_interval(hours => $7)) RETURNING id`,
      [tenantId, userId, deviceId, method, sha256(token), ip || null, SESSION_ABSOLUTE_HOURS]);
    await audit('auth.login', 'platform.user_session', s.rows[0].id, { user_id: userId, method, device_id: deviceId });
    return { kind: 'session', token: `${tenantId}.${token}`, tenantId, sessionId: s.rows[0].id };
  }

  /** Called by the auth interceptor INSIDE the request's tenant tx. */
  async authenticate(token: string, branchHeader: string | undefined): Promise<AuthContext | AuthFail> {
    const c = currentTx();
    const r = await c.query<{ id: string; user_id: string; auth_method: 'password' | 'otp'; device_id: string | null; idle_s: number;
      expires_at: Date; dead: boolean; default_branch_id: string | null; tenant_status: string; device_ok: boolean | null }>(
      `SELECT s.id, s.user_id, s.auth_method, s.device_id, extract(epoch FROM now() - s.last_seen_at)::int AS idle_s, s.expires_at,
              (s.revoked_at IS NOT NULL OR s.expires_at <= now() OR NOT u.is_active) AS dead,
              u.default_branch_id, t.status AS tenant_status, (d.status = 'approved') AS device_ok
         FROM platform.user_session s
         JOIN platform.app_user u ON u.tenant_id = s.tenant_id AND u.id = s.user_id
         JOIN platform.tenant t ON t.id = s.tenant_id
         LEFT JOIN platform.device d ON d.tenant_id = s.tenant_id AND d.id = s.device_id
        WHERE s.token_hash = $1`, [sha256(token)]);
    const s = r.rows[0];
    if (!s || s.dead) return { fail: 'session_invalid' };
    if (s.tenant_status === 'suspended') return { fail: 'tenant_suspended' };
    const timeout = Number(await effectiveSetting<number>('auth.session_timeout_minutes', s.default_branch_id));
    if (s.idle_s > timeout * 60) {
      await c.query(`UPDATE platform.user_session SET revoked_at = now(), revoke_reason = 'idle_timeout' WHERE id = $1`, [s.id]);
      return { fail: 'session_idle_timeout' };
    }
    await c.query(`UPDATE platform.user_session SET last_seen_at = now() WHERE id = $1 AND last_seen_at < now() - interval '30 seconds'`, [s.id]);
    const { roles, permissions } = await loadPermissions(s.user_id);
    let branchId = s.default_branch_id ?? undefined;
    if (branchHeader) {
      const allowed = roles.some((x) => x.branch_id === null || x.branch_id === branchHeader);
      if (!UUID.test(branchHeader) || !allowed) fail(403, 'branch_not_allowed');
      branchId = branchHeader;
    }
    await refineScope({ userId: s.user_id, branchId });
    return { sessionId: s.id, tenantId: '', userId: s.user_id, authMethod: s.auth_method, deviceId: s.device_id,
      billingEnabled: !!s.device_ok, permissions, roles, idleTimeoutMinutes: timeout, expiresAt: s.expires_at.toISOString(), tenantStatus: s.tenant_status };
  }

  /** Session view (contract: Session) for the login response — runs its own tenant tx. */
  async describeByToken(fullToken: string): Promise<Record<string, unknown>> {
    const dot = fullToken.indexOf('.');
    const tenantId = fullToken.slice(0, dot);
    return withTenantTx(this.pool, { tenantId }, async () => {
      const a = await this.authenticate(fullToken.slice(dot + 1), undefined);
      if ('fail' in a) throw new Problem(401, a.fail);
      return this.describe({ ...a, tenantId });
    });
  }

  async describe(a: AuthContext): Promise<Record<string, unknown>> {
    const c = currentTx();
    const u = await c.query(`SELECT ${USER_COLS} FROM platform.app_user u WHERE u.id = $1`, [a.userId]);
    const t = await c.query<{ default_language: string }>(`SELECT default_language FROM platform.tenant WHERE id = platform.current_tenant()`);
    const user = u.rows[0] as { language: string | null };
    const g = await c.query<{ b: boolean }>(`SELECT billing_unlocked AS b FROM platform.v_billing_unlocked WHERE tenant_id = platform.current_tenant()`);
    return { session_id: a.sessionId, tenant_id: a.tenantId, user, auth_method: a.authMethod, device_id: a.deviceId,
      billing_enabled: a.billingEnabled, billing_unlocked: g.rows[0]?.b ?? false, roles: a.roles, permissions: [...a.permissions].sort(),
      language: user.language ?? t.rows[0]?.default_language ?? 'en', idle_timeout_minutes: a.idleTimeoutMinutes, expires_at: a.expiresAt };
  }

  async revokeByToken(token: string): Promise<void> {
    await currentTx().query(`UPDATE platform.user_session SET revoked_at = now(), revoke_reason = 'logout' WHERE token_hash = $1 AND revoked_at IS NULL`, [sha256(token)]);
  }
}
export { hashPassword };
