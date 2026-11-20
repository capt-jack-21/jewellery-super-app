import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Res } from '@nestjs/common';
import { currentTx } from '@jw/db';
import { Ctx, JwRequest, assertLanguage, RequirePermission, etag, fail, ifMatch, parse, pgProblem, staleOr404 } from './common';
import { resolveBillSeriesPrefix, BranchBody, BranchPatchBody, CompanyBody, CompanyPatchBody } from './schemas';
import { assertPlanLimit } from './users.repo';
import { audit } from './session.service';
import { z } from 'zod';
import { lang } from './schemas';

const TenantPatchBody = z.object({ default_language: lang }).strict();

const TENANT_COLS = `id, version, partner_id, slug, display_name, status, deployment_mode, default_language, suspended_at, suspend_reason, created_at`;
const COMPANY = `id, version, legal_name, trade_name, gstin, pan, state_code, address, created_at`;
const BRANCH = `id, version, company_id, code, name, bill_series_prefix, gstin, state_code, address, is_active, created_at`;
export { TENANT_COLS };

type Hdr = { header(k: string, v: string): unknown };
/** Optimistic update: `… WHERE id=$1 AND version=$2` (version is bumped by the aa_version trigger; never set by us). */
async function versionedPatch(table: string, cols: string, id: string, version: number, b: Record<string, unknown>, reply: Hdr) {
  const sets: string[] = []; const vals: unknown[] = [id, version];
  for (const [k, v] of Object.entries(b)) { vals.push(k === 'address' ? JSON.stringify(v) : v); sets.push(`${k} = $${vals.length}`); }
  const c = currentTx();
  let row: { version: number } | undefined;
  try { row = (await c.query(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = $1 AND version = $2 RETURNING ${cols}`, vals)).rows[0]; }
  catch (e) { return pgProblem(e); }
  if (!row) return staleOr404(async () => ((await c.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id])).rowCount ?? 0) > 0);
  reply.header('ETag', etag(row.version));
  return row;
}

@Controller('v1')
export class TenantController {
  @Get('tenant')
  async tenant(@Res({ passthrough: true }) reply: Hdr) {
    const t = (await currentTx().query<{ version: number }>(`SELECT ${TENANT_COLS} FROM platform.tenant WHERE id = platform.current_tenant()`)).rows[0] ?? fail(404, 'not_found');
    reply.header('ETag', etag(t.version));
    return t;
  }

  /** The only shop-editable tenant field (app_rw: UPDATE(default_language) + RLS tenant_update_language, no partner context). */
  @Patch('tenant') @RequirePermission('platform.settings.edit')
  async updateTenant(@Ctx() req: JwRequest, @Body() body: unknown, @Res({ passthrough: true }) reply: Hdr) {
    const b = parse(TenantPatchBody, body);
    const version = ifMatch(req)!;
    const c = currentTx();
    await assertLanguage(c, b.default_language);
    const before = (await c.query<{ default_language: string }>(`SELECT default_language FROM platform.tenant WHERE id = platform.current_tenant()`)).rows[0]
      ?? fail(404, 'not_found');
    let row: { id: string; version: number } | undefined;
    try {
      row = (await c.query(`UPDATE platform.tenant SET default_language = $2 WHERE id = platform.current_tenant() AND version = $1 RETURNING ${TENANT_COLS}`,
        [version, b.default_language])).rows[0];
    } catch (e) { return pgProblem(e); }
    if (!row) return staleOr404(async () => true);
    await audit('tenant.default_language_changed', 'platform.tenant', row.id, { from: before.default_language, to: b.default_language });
    reply.header('ETag', etag(row.version));
    return row;
  }

  @Get('companies')
  async companies() { return (await currentTx().query(`SELECT ${COMPANY} FROM platform.company ORDER BY created_at`)).rows; }

  @Post('companies') @RequirePermission('platform.settings.edit')
  async createCompany(@Body() body: unknown) {
    const b = parse(CompanyBody, body);
    try {
      return (await currentTx().query(
        `INSERT INTO platform.company(tenant_id, legal_name, trade_name, gstin, pan, state_code, address)
         VALUES (platform.current_tenant(), $1, $2, $3, $4, $5, $6) RETURNING ${COMPANY}`,
        [b.legal_name, b.trade_name ?? null, b.gstin ?? null, b.pan ?? null, b.state_code, JSON.stringify(b.address ?? {})])).rows[0];
    } catch (e) { return pgProblem(e); }
  }

  @Patch('companies/:id') @RequirePermission('platform.settings.edit')
  async updateCompany(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Res({ passthrough: true }) reply: Hdr) {
    const b = parse(CompanyPatchBody, body);
    return versionedPatch('platform.company', COMPANY, id, ifMatch(req)!, b, reply);
  }

  @Get('branches')
  async branches() { return (await currentTx().query(`SELECT ${BRANCH} FROM platform.branch ORDER BY code`)).rows; }

  @Post('branches') @RequirePermission('platform.settings.edit')
  async createBranch(@Body() body: unknown) {
    const b = parse(BranchBody, body);
    const prefix = resolveBillSeriesPrefix(b.bill_series_prefix, b.code);
    if (!prefix) fail(422, 'invalid_bill_series_prefix', 'bill_series_prefix must match ^[A-Z0-9][A-Z0-9/-]{0,11}$ after upper-casing');
    await assertPlanLimit('branches');
    const c = currentTx();
    const co = await c.query<{ state_code: string; gstin: string | null }>(`SELECT state_code, gstin FROM platform.company WHERE id = $1`, [b.company_id]);
    if (!co.rows[0]) fail(422, 'company_not_found');
    try {
      return (await c.query(
        `INSERT INTO platform.branch(tenant_id, company_id, code, name, gstin, state_code, address, bill_series_prefix)
         VALUES (platform.current_tenant(), $1, $2, $3, $4, $5, $6, $7) RETURNING ${BRANCH}`,
        [b.company_id, b.code, b.name, b.gstin ?? co.rows[0].gstin, b.state_code ?? co.rows[0].state_code, JSON.stringify(b.address ?? {}), prefix])).rows[0];
    } catch (e) { return pgProblem(e); }
  }

  @Patch('branches/:id') @RequirePermission('platform.settings.edit')
  async updateBranch(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Res({ passthrough: true }) reply: Hdr) {
    const b = parse(BranchPatchBody, body);
    return versionedPatch('platform.branch', BRANCH, id, ifMatch(req)!, b, reply);
  }
}
