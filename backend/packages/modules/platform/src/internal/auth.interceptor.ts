import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { from, lastValueFrom, Observable } from 'rxjs';
import type { Pool } from 'pg';
import { ADMIN_POOL, PG_POOL, withTenantTx } from '@jw/db';
import { ADMIN_COOKIE, AUTH_KIND, AuthKind, JwRequest, PARTNER_COOKIE, PARTNER_IDLE_MINUTES, PERMISSION, Problem, SESSION_COOKIE, sha256 } from './common';
import { SessionService } from './session.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FAILED = Symbol('auth-failed');

/**
 * Global auth + per-request tenant transaction.
 * session (default): cookie sid "<tenant>.<token>" → ONE tx with app.tenant_id, then app.user_id/branch_id after the session
 * check (idle timeout P11, suspended tenant, revoked device) → permission check → handler (same tx; errors roll back).
 */
@Injectable()
export class AuthInterceptor implements NestInterceptor {
  constructor(@Inject(PG_POOL) private readonly pool: Pool, @Inject(ADMIN_POOL) private readonly adminPool: Pool | null,
              @Inject(Reflector) private readonly reflector: Reflector, @Inject(SessionService) private readonly sessions: SessionService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    const kind = this.reflector.getAllAndOverride<AuthKind>(AUTH_KIND, targets)
      ?? (this.reflector.getAllAndOverride<boolean>('publicRoute', targets) ? 'public' : 'session');
    const perm = this.reflector.getAllAndOverride<string>(PERMISSION, targets);
    const req = ctx.switchToHttp().getRequest<JwRequest>();
    return from(this.run(kind, perm, req, () => lastValueFrom(next.handle(), { defaultValue: undefined })));
  }

  private async run(kind: AuthKind, perm: string | undefined, req: JwRequest, handler: () => Promise<unknown>): Promise<unknown> {
    if (kind === 'public') return handler();
    if (kind === 'admin') {
      // v1.4: opaque token, sha256 stored in platform.platform_admin_session (app_admin: SELECT/INSERT/UPDATE(last_seen_at, revoked_at)).
      if (!this.adminPool) throw new Problem(503, 'admin_unavailable');
      const tok = req.cookies?.[ADMIN_COOKIE];
      const a = tok ? await this.adminPool.query<{ id: string; admin_id: string; email: string }>(
        `SELECT s.id, s.admin_id, a.email FROM platform.platform_admin_session s JOIN platform.platform_admin a ON a.id = s.admin_id
          WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND a.is_active`, [sha256(tok)]) : null;
      const row = a?.rows[0];
      if (!row) throw new Problem(401, 'admin_session_invalid');
      await this.adminPool.query(`UPDATE platform.platform_admin_session SET last_seen_at = now() WHERE id = $1 AND last_seen_at < now() - interval '30 seconds'`, [row.id]);
      req.admin = { adminId: row.admin_id, email: row.email, sessionId: row.id };
      return handler();
    }
    if (kind === 'partner') {
      // v1.4: cookie psid "<partner_id>.<token>" → platform.partner_session (RLS by current_partner()) in ONE partner tx.
      const raw = req.cookies?.[PARTNER_COOKIE] ?? '';
      const dot = raw.indexOf('.');
      const pid = dot > 0 ? raw.slice(0, dot) : '';
      if (!UUID.test(pid)) throw new Problem(401, 'partner_session_invalid');
      let failure: string | null = null;
      const out = await withTenantTx(this.pool, { tenantId: '', partnerId: pid }, async (c) => {
        const r = await c.query<{ id: string; partner_user_id: string; role: 'partner_admin' | 'partner_staff'; idle: boolean }>(
          `SELECT s.id, s.partner_user_id, u.role, (s.last_seen_at < now() - make_interval(mins => $2)) AS idle
             FROM platform.partner_session s JOIN platform.partner_user u ON u.partner_id = s.partner_id AND u.id = s.partner_user_id
            WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.is_active`,
          [sha256(raw.slice(dot + 1)), PARTNER_IDLE_MINUTES]);
        const s = r.rows[0];
        if (!s) { failure = 'partner_session_invalid'; return FAILED; }
        if (s.idle) {
          await c.query(`UPDATE platform.partner_session SET revoked_at = now(), revoke_reason = 'idle_timeout' WHERE id = $1`, [s.id]);
          failure = 'session_idle_timeout'; return FAILED;
        }
        await c.query(`UPDATE platform.partner_session SET last_seen_at = now() WHERE id = $1 AND last_seen_at < now() - interval '30 seconds'`, [s.id]);
        req.partner = { partnerId: pid, userId: s.partner_user_id, sessionId: s.id, role: s.role };
        return handler();
      });
      if (out === FAILED) throw new Problem(401, failure ?? 'partner_session_invalid');
      return out;
    }
    const raw = req.cookies?.[SESSION_COOKIE];
    const dot = raw ? raw.indexOf('.') : -1;
    const tenantId = dot > 0 ? raw!.slice(0, dot) : '';
    if (!UUID.test(tenantId)) {
      if (kind === 'optional') return handler();            // no tx: the handler opens its own
      const dev = this.devScope(req);
      if (!dev) throw new Problem(401, 'unauthenticated');
      if (perm) throw new Problem(403, 'permission_denied', perm);
      return withTenantTx(this.pool, dev, () => handler());
    }
    const token = raw!.slice(dot + 1);
    let failure: string | null = null;
    const out = await withTenantTx(this.pool, { tenantId }, async () => {
      const r = await this.sessions.authenticate(token, typeof req.headers['x-branch-id'] === 'string' ? req.headers['x-branch-id'] : undefined);
      if ('fail' in r) { failure = r.fail; return FAILED; }     // commit (e.g. idle_timeout revocation) then 401
      req.auth = { ...r, tenantId };
      if (r.tenantStatus === 'read_only' && req.method !== 'GET' && !req.url.includes('/v1/auth/')) throw new Problem(403, 'tenant_read_only');
      if (perm && !r.permissions.has(perm)) throw new Problem(403, 'permission_denied', perm);
      return handler();
    });
    if (out === FAILED) {
      if (kind === 'optional') return handler();
      throw new Problem(failure === 'tenant_suspended' ? 403 : 401, failure ?? 'unauthenticated');
    }
    return out;
  }

  /** M0 test hook only (ALLOW_DEV_TENANT_HEADER=1, never in production): x-dev-tenant-id / x-dev-user-id. */
  private devScope(req: JwRequest) {
    if (process.env.ALLOW_DEV_TENANT_HEADER !== '1' || process.env.NODE_ENV === 'production') return null;
    const t = req.headers['x-dev-tenant-id']; const u = req.headers['x-dev-user-id'];
    if (typeof t !== 'string' || !UUID.test(t)) return null;
    return { tenantId: t, userId: typeof u === 'string' && UUID.test(u) ? u : undefined };
  }
}
