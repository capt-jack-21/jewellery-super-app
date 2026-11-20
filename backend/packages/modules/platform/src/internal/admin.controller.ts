import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res } from '@nestjs/common';
import { PG_POOL, withTenantTx } from '@jw/db';
import { PartnerUserBody } from './schemas';
import { z } from 'zod';
import { ADMIN_COOKIE, Auth, LOGIN_MAX_FAILS, LOGIN_WINDOW_MIN, bucketClear, bucketHit, bucketKey, bucketLocked, Ctx, JwRequest, cookieOpts, etag, fail, hashPassword, ifMatch, newToken, parse, pgProblem, rateLimit, sha256, staleOr404, verifyPassword } from './common';
import { SessionService } from './session.service';
import { TenantCreateBody, slug, uuid } from './schemas';
import { TENANT_COLS } from './tenant.controller';
import type { CookieReply } from './auth.controller';
import type { Pool } from 'pg';

const ADMIN_HOURS = 8;
const PARTNER = `id, slug, legal_name, gstin, status, created_at`;
const SUB = `id, tenant_id, plan_code, status, billing_cycle, to_char(current_period_start, 'YYYY-MM-DD') AS current_period_start, to_char(current_period_end, 'YYYY-MM-DD') AS current_period_end`;
const adminCookie = () => cookieOpts('/api/v1/admin');

@Controller('v1/admin')
export class AdminController {
  constructor(@Inject(SessionService) private readonly sessions: SessionService, @Inject(PG_POOL) private readonly rw: Pool) {}
  private get db(): Pool { return this.sessions.platformAdminPool ?? fail(503, 'admin_unavailable', 'ADMIN_DATABASE_URL is not configured'); }

  @Post('auth/login') @Auth('public') @HttpCode(200)
  async login(@Ctx() req: JwRequest, @Body() body: unknown, @Res({ passthrough: true }) reply: CookieReply) {
    const b = parse(z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) }).strict(), body);
    rateLimit(`admin:${req.ip}`, 20, 15 * 60_000);   // per-process IP throttle; authoritative lockout = DB bucket
    const key = bucketKey('login.admin', null, b.email);
    if (await bucketLocked(this.db, key)) { await verifyPassword(null, b.password); fail(401, 'invalid_credentials'); }
    const r = await this.db.query<{ id: string; email: string; name: string; password_hash: string }>(
      `SELECT id, email, name, password_hash FROM platform.platform_admin WHERE email = lower($1) AND is_active`, [b.email]);
    const a = r.rows[0];
    if (!(await verifyPassword(a?.password_hash ?? null, b.password)) || !a) {
      await bucketHit(this.db, key, LOGIN_MAX_FAILS, LOGIN_WINDOW_MIN);
      fail(401, 'invalid_credentials');
    }
    await bucketClear(this.db, [key]);
    const token = newToken();
    const s = await this.db.query<{ expires_at: Date }>(
      `INSERT INTO platform.platform_admin_session(admin_id, token_hash, ip, expires_at)
       VALUES ($1, $2, $3::inet, now() + make_interval(hours => $4)) RETURNING expires_at`, [a.id, sha256(token), req.ip || null, ADMIN_HOURS]);
    reply.setCookie(ADMIN_COOKIE, token, { ...adminCookie(), sameSite: 'strict', maxAge: ADMIN_HOURS * 3600 });
    return { admin_id: a.id, email: a.email, name: a.name, expires_at: s.rows[0].expires_at.toISOString() };
  }

  @Post('auth/logout') @Auth('admin') @HttpCode(204)
  async logout(@Ctx() req: JwRequest, @Res({ passthrough: true }) reply: CookieReply) {
    await this.db.query(`UPDATE platform.platform_admin_session SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [req.admin!.sessionId]);
    reply.clearCookie(ADMIN_COOKIE, adminCookie());
  }

  @Get('tenants') @Auth('admin')
  async tenants(@Query('q') q?: string, @Query('status') status?: string, @Query('partner_id') partnerId?: string) {
    if (partnerId && !uuid.safeParse(partnerId).success) fail(422, 'validation_failed', 'partner_id');
    return (await this.db.query(
      `SELECT ${TENANT_COLS} FROM platform.tenant WHERE ($1::text IS NULL OR display_name ILIKE '%' || $1 || '%' OR slug LIKE lower($1) || '%')
          AND ($2::text IS NULL OR status = $2) AND ($3::uuid IS NULL OR partner_id = $3) ORDER BY created_at DESC LIMIT 500`,
      [q || null, status || null, partnerId || null])).rows;
  }

  /** Provision a shop atomically: ONE call to platform.provision_tenant() (EXECUTE granted to app_admin only) creates tenant
   *  (trial), company, first branch (bill_series_prefix = p_bill_series_prefix, upper-cased; default code), four preset roles, owner + owner role, onboarding rows. */
  @Post('tenants') @Auth('admin')
  async createTenant(@Ctx() req: JwRequest, @Body() body: unknown, @Res({ passthrough: true }) reply: { status(n: number): unknown; header(k: string, v: string): unknown }) {
    const b = parse(TenantCreateBody, body);
    const pw = await hashPassword(b.owner.password);
    let tenant: Record<string, unknown> & { id: string; version: number };
    const c = await this.db.connect();
    try {
      await c.query('BEGIN');
      const id = (await c.query<{ id: string }>(
        `SELECT platform.provision_tenant($1, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, coalesce($14, 'en'), coalesce($15, 'shared'),
           p_bill_series_prefix => $16) AS id`,
        [b.slug, b.display_name, b.partner_id ?? null, b.company.legal_name, b.company.gstin ?? null, b.company.pan ?? null, b.company.state_code,
         b.branch.code, b.branch.name, b.owner.name, b.owner.phone ?? null, b.owner.username ?? null, pw, b.default_language ?? null, b.deployment_mode ?? null, b.branch.bill_series_prefix ?? null])).rows[0].id;
      tenant = (await c.query(`SELECT ${TENANT_COLS} FROM platform.tenant WHERE id = $1`, [id])).rows[0];
      // provision_tenant() writes its own 'tenant.provisioned' audit event (v1.5); the console never calls audit_append
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => undefined); return pgProblem(e); }
    finally { c.release(); }
    // 971: the prefix is set atomically inside provision_tenant (upper-cased by the DB); echo the STORED value, not the input.
    const branch = await withTenantTx(this.rw, { tenantId: tenant.id }, async (t) => (await t.query<{ code: string; bill_series_prefix: string }>(
      `SELECT code, bill_series_prefix FROM platform.branch LIMIT 1`)).rows[0]);
    reply.header('ETag', etag(tenant.version));
    reply.status(201);
    return { ...tenant, branch };
  }

  @Get('tenants/:id') @Auth('admin')
  async tenant(@Param('id', ParseUUIDPipe) id: string) {
    const t = (await this.db.query(`SELECT ${TENANT_COLS} FROM platform.tenant WHERE id = $1`, [id])).rows[0] ?? fail(404, 'not_found');
    const s = await this.db.query(`SELECT ${SUB} FROM billing.subscription WHERE tenant_id = $1 ORDER BY current_period_start DESC`, [id]);
    return { ...t, subscriptions: s.rows };
  }

  @Patch('tenants/:id') @Auth('admin')
  async updateTenant(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const ver = ifMatch(req);
    const b = parse(z.object({ display_name: z.string().min(1).max(120), partner_id: uuid.nullable() }).partial().strict()
      .refine((o) => Object.keys(o).length > 0, 'empty patch'), body);
    const sets: string[] = []; const vals: unknown[] = [id, ver];
    for (const [k, v] of Object.entries(b)) { vals.push(v); sets.push(`${k} = $${vals.length}`); }
    try {
      return (await this.db.query(`UPDATE platform.tenant SET ${sets.join(', ')} WHERE id = $1 AND version = $2 RETURNING ${TENANT_COLS}`, vals)).rows[0]
        ?? await staleOr404(async () => (await this.db.query(`SELECT 1 FROM platform.tenant WHERE id = $1`, [id])).rowCount! > 0);
    } catch (e) { return pgProblem(e); }
  }

  @Post('tenants/:id/suspend') @Auth('admin') @HttpCode(200)
  async suspend(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parse(z.object({ reason: z.string().min(3).max(500) }).strict(), body);
    return (await this.db.query(
      `UPDATE platform.tenant SET status = 'suspended', suspended_at = coalesce(suspended_at, now()), suspend_reason = $2 WHERE id = $1 RETURNING ${TENANT_COLS}`,
      [id, b.reason])).rows[0] ?? fail(404, 'not_found');
  }

  @Post('tenants/:id/reactivate') @Auth('admin') @HttpCode(200)
  async reactivate(@Param('id', ParseUUIDPipe) id: string) {
    return (await this.db.query(
      `UPDATE platform.tenant SET status = 'active', suspended_at = NULL, suspend_reason = NULL WHERE id = $1 RETURNING ${TENANT_COLS}`, [id])).rows[0] ?? fail(404, 'not_found');
  }

  @Get('partners') @Auth('admin')
  async partners() { return (await this.db.query(`SELECT ${PARTNER} FROM platform.partner ORDER BY slug`)).rows; }

  @Post('partners') @Auth('admin')
  async createPartner(@Body() body: unknown) {
    const b = parse(z.object({ slug, legal_name: z.string().min(1).max(200), gstin: z.string().regex(/^[0-9]{2}[A-Z0-9]{13}$/).optional() }).strict(), body);
    try {
      return (await this.db.query(`INSERT INTO platform.partner(slug, legal_name, gstin) VALUES ($1, $2, $3) RETURNING ${PARTNER}`, [b.slug, b.legal_name, b.gstin ?? null])).rows[0];
    } catch (e) { return pgProblem(e); }
  }

  @Put('partners/:id/status') @Auth('admin')
  async partnerStatus(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parse(z.object({ status: z.enum(['active', 'suspended']) }).strict(), body);
    return (await this.db.query(`UPDATE platform.partner SET status = $2 WHERE id = $1 RETURNING ${PARTNER}`, [id, b.status])).rows[0] ?? fail(404, 'not_found');
  }

  /** Create a partner user (first partner_admin). partner_user is RLS'd to current_partner(), so write it with app_rw in a partner tx. */
  @Post('partners/:id/users') @Auth('admin')
  async createPartnerUser(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Res({ passthrough: true }) reply: { status(n: number): unknown }) {
    const b = parse(PartnerUserBody, body);
    if (!(await this.db.query(`SELECT 1 FROM platform.partner WHERE id = $1`, [id])).rowCount) fail(404, 'not_found');
    const pw = await hashPassword(b.password);
    try {
      const u = await withTenantTx(this.sessions.tenantPool, { tenantId: '', partnerId: id }, (c) => c.query(
        `INSERT INTO platform.partner_user(partner_id, name, email, password_hash, role) VALUES ($1, $2, $3, $4, $5)
         RETURNING id, partner_id, name, email, role, is_active, version, created_at`, [id, b.name, b.email, pw, b.role]));
      reply.status(201);
      return u.rows[0];
    } catch (e) { return pgProblem(e); }
  }

  @Get('billing/subscriptions') @Auth('admin')
  async subscriptions(@Query('tenant_id') tenantId?: string) {
    if (tenantId && !uuid.safeParse(tenantId).success) fail(422, 'validation_failed', 'tenant_id');
    return (await this.db.query(`SELECT ${SUB} FROM billing.subscription WHERE ($1::uuid IS NULL OR tenant_id = $1) ORDER BY tenant_id, current_period_start DESC`, [tenantId ?? null])).rows;
  }
}
