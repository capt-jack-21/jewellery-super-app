import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { currentTx } from '@jw/db';
import { Ctx, JwRequest, RequirePermission, assertLanguage, fail, hashPassword, ifMatch, parse, pgProblem } from './common';
import { MeBody, RolesBody, SetPasswordBody, UserBody, UserPatchBody } from './schemas';
import { USER_COLS, assertOwnerRemains, assertPlanLimit, ensureFixedRoles, getUser, setRoles } from './users.repo';

const isOwner = (req: JwRequest) => !!req.auth?.roles.some((r) => r.role === 'owner' && r.branch_id === null);

@Controller('v1')
export class UsersController {
  @Get('roles')
  async roles() {
    await ensureFixedRoles();
    return (await currentTx().query(
      `SELECT r.id, r.system_role_code AS code, r.name,
              coalesce((SELECT array_agg(permission_code ORDER BY permission_code) FROM platform.system_role_permission WHERE role_code = r.system_role_code), '{}') AS permissions
         FROM platform.role r JOIN platform.system_role sr ON sr.code = r.system_role_code ORDER BY sr.rank`)).rows;
  }

  @Get('permissions')
  async permissions() {
    return (await currentTx().query(`SELECT code, module, description FROM platform.permission ORDER BY module, code`)).rows;
  }

  @Get('users') @RequirePermission('platform.users.manage')
  async list(@Query('q') q?: string, @Query('active') active?: string) {
    return (await currentTx().query(
      `SELECT ${USER_COLS} FROM platform.app_user u
        WHERE ($1::text IS NULL OR u.name ILIKE '%' || $1 || '%' OR u.phone LIKE $1 || '%' OR u.username LIKE lower($1) || '%')
          AND ($2::boolean IS NULL OR u.is_active = $2) ORDER BY u.name LIMIT 500`,
      [q || null, active === undefined ? null : active === 'true'])).rows;
  }

  @Post('users') @RequirePermission('platform.users.manage')
  async create(@Ctx() req: JwRequest, @Body() body: unknown) {
    const b = parse(UserBody, body);
    await assertPlanLimit('users');
    const c = currentTx();
    try {
      const r = await c.query<{ id: string }>(
        `INSERT INTO platform.app_user(tenant_id, name, username, phone, email, password_hash, default_branch_id, language)
         VALUES (platform.current_tenant(), $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [b.name, b.username ?? null, b.phone ?? null, b.email ?? null, await hashPassword(b.password), b.default_branch_id ?? null, b.language ?? null]);
      await setRoles(r.rows[0].id, b.roles, isOwner(req));
      return getUser(r.rows[0].id);
    } catch (e) { return pgProblem(e); }
  }

  @Patch('users/me')
  async me(@Ctx() req: JwRequest, @Body() body: unknown) {
    const a = req.auth ?? fail(401, 'unauthenticated');
    const ver = ifMatch(req)!;
    const b = parse(MeBody, body);
    await assertLanguage(currentTx(), b.language);
    const r = await currentTx().query(
      `UPDATE platform.app_user SET language = CASE WHEN $3 THEN $4 ELSE language END, name = coalesce($5, name)
        WHERE id = $1 AND version = $2`, [a.userId, ver, 'language' in b, b.language ?? null, b.name ?? null]);
    if (!r.rowCount) fail(412, 'version_mismatch');
    return getUser(a.userId);
  }

  @Get('users/:id')
  async get(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string) {
    if (id !== req.auth?.userId && !req.auth?.permissions.has('platform.users.manage')) fail(403, 'permission_denied', 'platform.users.manage');
    return getUser(id);
  }

  @Patch('users/:id') @RequirePermission('platform.users.manage')
  async update(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parse(UserPatchBody, body);
    const target = await getUser(id) as { roles: { role: string }[] };
    if (target.roles.some((r) => r.role === 'owner') && !isOwner(req)) fail(403, 'owner_role_requires_owner');
    const ver = ifMatch(req)!;
    const c = currentTx();
    const sets: string[] = []; const vals: unknown[] = [id, ver];
    for (const [k, v] of Object.entries(b)) { vals.push(v); sets.push(`${k} = $${vals.length}`); }
    try {
      const u = await c.query(`UPDATE platform.app_user SET ${sets.join(', ')} WHERE id = $1 AND version = $2`, vals);   // keys come from the strict zod schema
      if (!u.rowCount) fail(412, 'version_mismatch');   // the row exists (getUser above 404s otherwise)
    } catch (e) { return pgProblem(e); }
    if (b.is_active === false) {
      await c.query(`UPDATE platform.user_session SET revoked_at = now(), revoke_reason = 'admin' WHERE user_id = $1 AND revoked_at IS NULL`, [id]);
      await assertOwnerRemains();
    }
    return getUser(id);
  }

  @Put('users/:id/roles') @RequirePermission('platform.users.manage')
  async putRoles(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parse(RolesBody, body);
    await getUser(id);
    try { await setRoles(id, b, isOwner(req)); } catch (e) { return pgProblem(e); }
    return getUser(id);
  }

  @Put('users/:id/password') @HttpCode(204) @RequirePermission('platform.users.manage')
  async setPassword(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parse(SetPasswordBody, body);
    const target = await getUser(id) as { roles: { role: string }[] };
    if (target.roles.some((r) => r.role === 'owner') && !isOwner(req)) fail(403, 'owner_role_requires_owner');
    const c = currentTx();
    await c.query(`UPDATE platform.app_user SET password_hash = $2 WHERE id = $1`, [id, await hashPassword(b.password)]);
    // clear the login lockout for every identifier of this user (v1.5 rate_limit_bucket)
    await c.query(`DELETE FROM platform.rate_limit_bucket b USING platform.app_user u
                    WHERE u.id = $1 AND b.bucket_key = ANY(ARRAY[
                      'login.tenant:' || u.tenant_id || ':' || encode(sha256(convert_to(lower(u.username), 'UTF8')), 'hex'),
                      'login.tenant:' || u.tenant_id || ':' || encode(sha256(convert_to(lower(u.phone), 'UTF8')), 'hex')])`, [id]);
    await c.query(`UPDATE platform.user_session SET revoked_at = now(), revoke_reason = 'admin' WHERE user_id = $1 AND revoked_at IS NULL`, [id]);
  }
}
