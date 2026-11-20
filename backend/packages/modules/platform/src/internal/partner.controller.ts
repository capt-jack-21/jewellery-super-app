import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Put, Res } from '@nestjs/common';
import { currentTx, withTenantTx } from '@jw/db';
import { Auth, Ctx, JwRequest, LOGIN_MAX_FAILS, LOGIN_WINDOW_MIN, PARTNER_COOKIE, bucketClear, bucketHit, bucketKey, bucketLocked, PARTNER_HOURS, cookieOpts, etag, fail, hashPassword, hostOf, ifMatch, newToken, parse, pgProblem, rateLimit, sha256, staleOr404, verifyPassword } from './common';
import type { CookieReply } from './auth.controller';
import { DomainBody, PartnerLoginBody, PartnerUserBody, PartnerUserPatch } from './schemas';
import { SessionService } from './session.service';
import { domainView, saveTheme, themeView } from './branding.controller';

const PUSER = `id, partner_id, name, email, role, is_active, version, created_at`;
async function describePartnerSession(sessionId: string) {
  const r = await currentTx().query<{ session_id: string; partner_id: string; expires_at: Date; user: unknown }>(
    `SELECT s.id AS session_id, s.partner_id, s.expires_at,
            json_build_object('id', u.id, 'partner_id', u.partner_id, 'name', u.name, 'email', u.email, 'role', u.role,
                              'is_active', u.is_active, 'version', u.version, 'created_at', u.created_at) AS user
       FROM platform.partner_session s JOIN platform.partner_user u ON u.partner_id = s.partner_id AND u.id = s.partner_user_id
      WHERE s.id = $1`, [sessionId]);
  return r.rows[0] ?? fail(401, 'partner_session_invalid');
}

/** P3 partner console: branding + SaaS billing of its shops only. Shop data is hidden by RLS (no_partner_access). */
@Controller('v1/partner') @Auth('partner')
export class PartnerController {
  constructor(@Inject(SessionService) private readonly sessions: SessionService) {}

  // ---------- auth (v1.4: platform.partner_user + platform.partner_session; replaces X-Partner-Key) ----------
  /** Partner from a verified partner custom domain (Host) or the body's partner_id. Schema request: resolve_partner(slug). */
  @Post('auth/login') @Auth('public') @HttpCode(200)
  async login(@Ctx() req: JwRequest, @Body() body: unknown, @Res({ passthrough: true }) reply: CookieReply) {
    const b = parse(PartnerLoginBody, body);
    rateLimit(`plogin:${req.ip}`, 30, 15 * 60_000);   // per-process IP throttle; the authoritative lockout is the DB bucket below
    const pool = this.sessions.tenantPool;
    let partnerId = b.partner_id ?? null;
    if (!partnerId && b.partner) {   // v1.5: platform.resolve_partner(slug), EXECUTE for app_rw, pre-login, no PII
      const r = await withTenantTx(pool, { tenantId: '' }, (c) => c.query<{ partner_id: string; status: string }>(
        `SELECT partner_id, status FROM platform.resolve_partner($1)`, [b.partner]));
      partnerId = r.rows[0]?.partner_id ?? null;
    }
    if (!partnerId) {
      const host = hostOf(req);
      const d = host ? await withTenantTx(pool, { tenantId: '' }, (c) => c.query<{ partner_id: string }>(
        `SELECT partner_id FROM branding.custom_domain WHERE hostname = $1 AND status = 'verified' AND partner_id IS NOT NULL`, [host])) : null;
      partnerId = d?.rows[0]?.partner_id ?? null;
    }
    if (!partnerId) { await verifyPassword(null, b.password); fail(401, 'invalid_credentials'); }
    const token = newToken();
    const key = bucketKey('login.partner', partnerId!, b.email);
    const out = await withTenantTx(pool, { tenantId: '', partnerId: partnerId! }, async (c) => {
      if (await bucketLocked(c, key)) { await verifyPassword(null, b.password); return null; }
      const p = await c.query<{ status: string }>(`SELECT status FROM platform.partner WHERE id = $1`, [partnerId]);
      const u = await c.query<{ id: string; password_hash: string }>(
        `SELECT id, password_hash FROM platform.partner_user WHERE email = lower($1) AND is_active`, [b.email]);
      const ok = await verifyPassword(u.rows[0]?.password_hash ?? null, b.password);
      if (!ok || !u.rows[0] || p.rows[0]?.status !== 'active') { await bucketHit(c, key, LOGIN_MAX_FAILS, LOGIN_WINDOW_MIN); return null; }
      await bucketClear(c, [key]);
      const s = await c.query<{ id: string; expires_at: Date }>(
        `INSERT INTO platform.partner_session(partner_id, partner_user_id, token_hash, ip, expires_at)
         VALUES ($1, $2, $3, $4::inet, now() + make_interval(hours => $5)) RETURNING id, expires_at`,
        [partnerId, u.rows[0].id, sha256(token), req.ip || null, PARTNER_HOURS]);
      return { sessionId: s.rows[0].id, userId: u.rows[0].id };
    });
    if (!out) fail(401, 'invalid_credentials');
    reply.setCookie(PARTNER_COOKIE, `${partnerId}.${token}`, { ...cookieOpts('/api/v1/partner'), sameSite: 'strict', maxAge: PARTNER_HOURS * 3600 });
    return withTenantTx(pool, { tenantId: '', partnerId: partnerId! }, () => describePartnerSession(out!.sessionId));
  }

  @Post('auth/logout') @HttpCode(204)
  async logout(@Ctx() req: JwRequest, @Res({ passthrough: true }) reply: CookieReply) {
    await currentTx().query(`UPDATE platform.partner_session SET revoked_at = now(), revoke_reason = 'logout' WHERE id = $1 AND revoked_at IS NULL`, [req.partner!.sessionId]);
    reply.clearCookie(PARTNER_COOKIE, cookieOpts('/api/v1/partner'));
  }

  @Get('auth/session')
  session(@Ctx() req: JwRequest) { return describePartnerSession(req.partner!.sessionId!); }

  // ---------- partner users (partner_admin only) ----------
  @Get('users')
  async users() { return (await currentTx().query(`SELECT ${PUSER} FROM platform.partner_user ORDER BY name`)).rows; }

  @Post('users')
  async createUser(@Ctx() req: JwRequest, @Body() body: unknown, @Res({ passthrough: true }) reply: { status(n: number): unknown }) {
    if (req.partner!.role !== 'partner_admin') fail(403, 'permission_denied', 'partner_admin');
    const b = parse(PartnerUserBody, body);
    try {
      const r = await currentTx().query(
        `INSERT INTO platform.partner_user(partner_id, name, email, password_hash, role) VALUES (platform.current_partner(), $1, $2, $3, $4) RETURNING ${PUSER}`,
        [b.name, b.email, await hashPassword(b.password), b.role]);
      reply.status(201);
      return r.rows[0];
    } catch (e) { return pgProblem(e); }
  }

  @Patch('users/:id')
  async updateUser(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Res({ passthrough: true }) reply: { header(k: string, v: string): unknown }) {
    if (req.partner!.role !== 'partner_admin') fail(403, 'permission_denied', 'partner_admin');
    const ver = ifMatch(req)!;
    const b = parse(PartnerUserPatch, body);
    const c = currentTx();
    const sets: string[] = []; const vals: unknown[] = [id, ver];
    for (const [k, v] of Object.entries(b)) { vals.push(v); sets.push(`${k} = $${vals.length}`); }
    const r = await c.query<{ version: number }>(`UPDATE platform.partner_user SET ${sets.join(', ')} WHERE id = $1 AND version = $2 RETURNING ${PUSER}`, vals);
    if (!r.rows[0]) return staleOr404(async () => ((await c.query(`SELECT 1 FROM platform.partner_user WHERE id = $1`, [id])).rowCount ?? 0) > 0);
    if (b.is_active === false)
      await c.query(`UPDATE platform.partner_session SET revoked_at = now(), revoke_reason = 'deactivated' WHERE partner_user_id = $1 AND revoked_at IS NULL`, [id]);
    reply.header('ETag', etag(r.rows[0].version));
    return r.rows[0];
  }

  /** v1.4: platform.v_partner_tenant_directory (filtered by current_partner(); no shop data) in the partner tx. */
  @Get('tenants')
  async tenants() {
    return (await currentTx().query(
      `SELECT tenant_id, display_name, tenant_status, plan_code, plan_name, subscription_status
         FROM platform.v_partner_tenant_directory ORDER BY display_name`)).rows;
  }

  @Get('billing/subscriptions')
  async subscriptions() {
    return (await currentTx().query(
      `SELECT id, tenant_id, plan_code, status, billing_cycle, to_char(current_period_start, 'YYYY-MM-DD') AS current_period_start,
              to_char(current_period_end, 'YYYY-MM-DD') AS current_period_end FROM billing.subscription ORDER BY tenant_id, current_period_start DESC`)).rows;
  }

  @Get('branding/theme')
  theme() { return themeView('partner'); }

  @Put('branding/theme')
  async putTheme(@Ctx() req: JwRequest, @Body() body: unknown) {
    try { await saveTheme('partner', body, req); } catch (e) { if (e instanceof Error && 'getStatus' in e) throw e; return pgProblem(e); }
    return themeView('partner');
  }

  @Get('branding/domains')
  async domains() {
    return (await currentTx().query<Record<string, unknown>>(
      `SELECT id, hostname, status, verification_token, verified_at, last_checked_at, failure_reason, tls_status, created_at
         FROM branding.custom_domain WHERE partner_id = platform.current_partner() ORDER BY created_at`)).rows.map(domainView);
  }

  @Post('branding/domains')
  async addDomain(@Body() body: unknown) {
    const b = parse(DomainBody, body);
    try {
      const r = await currentTx().query<Record<string, unknown>>(
        `INSERT INTO branding.custom_domain(hostname, partner_id) VALUES ($1, platform.current_partner())
         RETURNING id, hostname, status, verification_token, verified_at, last_checked_at, failure_reason, tls_status, created_at`, [b.hostname]);
      return domainView(r.rows[0]);
    } catch (e) { return pgProblem(e); }
  }
}
