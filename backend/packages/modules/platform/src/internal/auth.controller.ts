import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { currentTx } from '@jw/db';
import { Auth, Ctx, JwRequest, Problem, SESSION_COOKIE, cookieOpts, fail, hashPassword, parse, rateLimit, verifyPassword } from './common';
import { ChangePasswordBody, LoginBody, OtpStartBody, OtpVerifyBody } from './schemas';
import { LoginResult, SessionService, audit } from './session.service';
import { getUser } from './users.repo';

export interface CookieReply {
  status(code: number): CookieReply; send(body?: unknown): unknown;
  setCookie(name: string, value: string, opts: Record<string, unknown>): CookieReply; clearCookie(name: string, opts: Record<string, unknown>): CookieReply;
}

@Controller('v1/auth')
export class AuthController {
  constructor(@Inject(SessionService) private readonly sessions: SessionService) {}

  @Post('login') @Auth('public')
  async login(@Ctx() req: JwRequest, @Body() body: unknown, @Res() reply: CookieReply) {
    const b = parse(LoginBody, body);
    rateLimit(`login:${req.ip}:${b.login}`, 10, 5 * 60_000);
    const tenantId = await this.sessions.resolveTenant(req, b.tenant);
    return this.finish(await this.sessions.passwordLogin(tenantId, b.login, b.password, b.device_key, req.ip), reply);
  }

  @Post('otp/request') @Auth('public')
  async otpRequest(@Ctx() req: JwRequest, @Body() body: unknown, @Res() reply: CookieReply) {
    const b = parse(OtpStartBody, body);
    rateLimit(`otp:${req.ip}:${b.login}`, 5, 15 * 60_000);
    const tenantId = await this.sessions.resolveTenant(req, b.tenant);
    return this.finish(await this.sessions.otpStart(tenantId, b.login), reply);
  }

  @Post('otp/verify') @Auth('public')
  async otpVerify(@Ctx() req: JwRequest, @Body() body: unknown, @Res() reply: CookieReply) {
    const b = parse(OtpVerifyBody, body);
    rateLimit(`otpv:${req.ip}`, 20, 15 * 60_000);
    return this.finish(await this.sessions.otpVerify(b.challenge_id, b.code, b.device_key, req.ip), reply);
  }

  private async finish(r: LoginResult, reply: CookieReply) {
    if (r.kind === 'fail') throw new Problem(r.code === 'otp_login_disabled' ? 422 : 401, r.code);
    if (r.kind === 'otp') {
      return reply.status(202).send({ challenge_id: r.challengeId, channel: r.channel, masked_destination: r.masked, expires_at: r.expiresAt });
    }
    const session = await this.sessions.describeByToken(r.token);
    reply.setCookie(SESSION_COOKIE, r.token, { ...cookieOpts('/'), maxAge: 12 * 3600 });
    return reply.status(200).send(session);
  }

  @Post('logout') @HttpCode(204)
  async logout(@Ctx() req: JwRequest, @Res({ passthrough: true }) reply: CookieReply) {
    await currentTx().query(`UPDATE platform.user_session SET revoked_at = now(), revoke_reason = 'logout' WHERE id = $1`, [req.auth!.sessionId]);
    await audit('auth.logout', 'platform.user_session', req.auth!.sessionId);
    reply.clearCookie(SESSION_COOKIE, cookieOpts('/'));
  }

  @Get('session')
  async session(@Ctx() req: JwRequest) {
    if (!req.auth) fail(401, 'unauthenticated');
    return this.sessions.describe(req.auth!);
  }

  @Get('sessions')
  async list(@Ctx() req: JwRequest, @Query('user_id') userId?: string) {
    const a = req.auth ?? fail(401, 'unauthenticated');
    const all = a.permissions.has('platform.users.manage');
    const r = await currentTx().query(
      `SELECT s.id, s.user_id, u.name AS user_name, s.device_id, d.name AS device_name, s.auth_method, host(s.ip) AS ip,
              s.created_at, s.last_seen_at, (s.id = $1) AS current
         FROM platform.user_session s JOIN platform.app_user u ON u.tenant_id = s.tenant_id AND u.id = s.user_id
         LEFT JOIN platform.device d ON d.tenant_id = s.tenant_id AND d.id = s.device_id
        WHERE s.revoked_at IS NULL AND s.expires_at > now()
          AND ($2::boolean OR s.user_id = $3) AND ($4::uuid IS NULL OR s.user_id = $4)
        ORDER BY s.last_seen_at DESC LIMIT 500`, [a.sessionId, all, a.userId, userId ?? null]);
    return r.rows;
  }

  @Delete('sessions/:id') @HttpCode(204)
  async revoke(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string) {
    const a = req.auth ?? fail(401, 'unauthenticated');
    const s = await currentTx().query<{ user_id: string }>(`SELECT user_id FROM platform.user_session WHERE id = $1 AND revoked_at IS NULL`, [id]);
    if (!s.rows[0]) fail(404, 'not_found');
    const own = s.rows[0].user_id === a.userId;
    if (!own && !a.permissions.has('platform.users.manage')) fail(403, 'permission_denied', 'platform.users.manage');
    await currentTx().query(`UPDATE platform.user_session SET revoked_at = now(), revoke_reason = $2 WHERE id = $1`, [id, own ? 'logout' : 'admin']);
    await audit('auth.session_revoked', 'platform.user_session', id, { by: a.userId });
  }

  @Post('password') @HttpCode(204)
  async changePassword(@Ctx() req: JwRequest, @Body() body: unknown) {
    const a = req.auth ?? fail(401, 'unauthenticated');
    const b = parse(ChangePasswordBody, body);
    const c = currentTx();
    const u = await c.query<{ password_hash: string | null }>(`SELECT password_hash FROM platform.app_user WHERE id = $1`, [a.userId]);
    if (!(await verifyPassword(u.rows[0]?.password_hash ?? null, b.current_password))) fail(422, 'current_password_wrong');
    await c.query(`UPDATE platform.app_user SET password_hash = $2 WHERE id = $1`, [a.userId, await hashPassword(b.new_password)]);
    await c.query(`UPDATE platform.user_session SET revoked_at = now(), revoke_reason = 'logout' WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`, [a.userId, a.sessionId]);
  }
}
export { getUser };
