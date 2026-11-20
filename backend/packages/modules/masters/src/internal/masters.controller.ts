import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import { currentTx } from '@jw/db';
import { Ctx, type JwRequest, RequirePermission, etag, fail, ifMatch, markOnboardingStepCompleted, parse, pgProblem, staleOr404 } from '@jw/mod-platform';
import { z } from 'zod';

/** 23505 on the (tenant, code) / (tenant, metal, code) unique keys → 409 duplicate_code; anything else → standard mapping. */
function dupOr(e: unknown): never {
  if ((e as { code?: string }).code === '23505') fail(409, 'duplicate_code', 'code already exists');
  return pgProblem(e);
}

const hsn = z.string().regex(/^[0-9]{4}([0-9]{2}){0,2}$/);
/** platform.fineness = numeric(6,3), > 0 and <= 1000; decimal string in and out (never a JS number). */
const fineness = z.string().regex(/^[0-9]{1,4}(\.[0-9]{1,3})?$/).refine((v) => Number(v) > 0 && Number(v) <= 1000, 'fineness must be > 0 and <= 1000');
export const MetalInput = z.object({ code: z.string().regex(/^[A-Z][A-Z0-9_]{0,9}$/), name: z.string().min(1).max(60), default_hsn: hsn }).strict();
export const MetalPatch = z.object({ name: z.string().min(1).max(60), default_hsn: hsn, is_active: z.boolean() }).partial().strict()
  .refine((b) => Object.keys(b).length > 0, 'empty patch');
export const PurityInput = z.object({ metal_id: z.string().uuid(), code: z.string().regex(/^[A-Z0-9]{1,10}$/), fineness,
  huid_required: z.boolean().default(true), header_visible: z.boolean().default(false) }).strict();
export const PurityPatch = z.object({ fineness, huid_required: z.boolean(), header_visible: z.boolean(), is_active: z.boolean() }).partial().strict()
  .refine((b) => Object.keys(b).length > 0, 'empty patch');

const METAL = `id, code, name, default_hsn, version, is_active`;
const PURITY = `id, metal_id, code, fineness::text AS fineness, huid_required, header_visible, version, is_active`;
type Reply = { status(n: number): unknown; header(k: string, v: string): unknown };
const incl = z.enum(['true', 'false']).optional();
const qParam = z.string().max(100).optional();
/** q → ILIKE pattern on code/name (LIKE metacharacters escaped); null = no filter. */
const like = (q?: string) => (q && q.trim() ? `%${q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null);
async function one(sql: string, id: string, reply: Reply) {
  const row = (await currentTx().query(sql, [id])).rows[0];
  if (!row) fail(404, 'not_found');
  reply.header('ETag', etag(row.version));
  return row;
}
/** 0 rows from `WHERE id = $1 AND version = $2` → 412 if the row exists, else 404. version itself is never written (aa_version trigger bumps it). */
const missOr412 = (table: string, id: string) =>
  staleOr404(async () => ((await currentTx().query(`SELECT 1 FROM ${table} WHERE id = $1`, [id])).rowCount ?? 0) > 0);

/** metals_purities is done once the shop has at least one metal with at least one purity. */
async function syncMetalsStep(): Promise<void> {
  const r = await currentTx().query<{ ok: boolean }>(`SELECT EXISTS (SELECT 1 FROM masters.purity) AS ok`);
  if (r.rows[0]?.ok) await markOnboardingStepCompleted('metals_purities');
}

/** 0.7.1 ?ids= batch lookup (1–100 comma-separated uuids) */
function idsParam(ids?: string | string[]): string[] | null {
  if (ids === undefined) return null;
  const v = (Array.isArray(ids) ? ids.join(',') : String(ids)).split(',').map((x) => x.trim()).filter(Boolean);
  if (!v.length || v.length > 100 || v.some((x) => !z.string().uuid().safeParse(x).success)) fail(422, 'validation_failed', 'ids: 1–100 comma-separated uuids');
  return v;
}

@Controller('v1/masters')
export class MastersController {
  @Get('metals') @RequirePermission('masters.metals.view')
  async metals(@Query('include_inactive') inc?: string, @Query('q') q?: string, @Query('ids') ids?: string) {
    if (!incl.safeParse(inc).success) fail(422, 'validation_failed', 'include_inactive');
    if (!qParam.safeParse(q).success) fail(422, 'validation_failed', 'q');
    return (await currentTx().query(`SELECT ${METAL} FROM masters.metal WHERE ($1 OR is_active)
        AND ($2::text IS NULL OR code ILIKE $2 OR name ILIKE $2) AND ($3::uuid[] IS NULL OR id = ANY($3)) ORDER BY code`, [inc === 'true', like(q), idsParam(ids)])).rows;
  }

  @Get('metals/:id') @RequirePermission('masters.metals.view')
  async metal(@Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) reply: Reply) {
    return one(`SELECT ${METAL} FROM masters.metal WHERE id = $1`, id, reply);
  }

  @Post('metals') @RequirePermission('masters.metals.manage')
  async createMetal(@Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    const b = parse(MetalInput, body);
    try {
      const r = await currentTx().query(`INSERT INTO masters.metal(tenant_id, code, name, default_hsn) VALUES (platform.current_tenant(), $1, $2, $3) RETURNING ${METAL}`,
        [b.code, b.name, b.default_hsn]);
      await syncMetalsStep();
      reply.status(201);
      reply.header('ETag', etag(r.rows[0].version));
      return r.rows[0];
    } catch (e) { return dupOr(e); }
  }

  @Patch('metals/:id') @RequirePermission('masters.metals.manage')
  async updateMetal(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    const version = ifMatch(req)!;
    const b = parse(MetalPatch, body);
    const r = await currentTx().query(`UPDATE masters.metal SET name = coalesce($3, name), default_hsn = coalesce($4, default_hsn), is_active = coalesce($5, is_active)
        WHERE id = $1 AND version = $2 RETURNING ${METAL}`, [id, version, b.name ?? null, b.default_hsn ?? null, b.is_active ?? null]).catch(pgProblem);
    if (!r.rows[0]) return missOr412('masters.metal', id);
    reply.header('ETag', etag(r.rows[0].version));
    return r.rows[0];
  }

  @Get('purities') @RequirePermission('masters.metals.view')
  async purities(@Query('metal_id') metalId?: string, @Query('include_inactive') inc?: string, @Query('q') q?: string, @Query('ids') ids?: string) {
    if (metalId && !z.string().uuid().safeParse(metalId).success) fail(422, 'validation_failed', 'metal_id');
    if (!incl.safeParse(inc).success) fail(422, 'validation_failed', 'include_inactive');
    if (!qParam.safeParse(q).success) fail(422, 'validation_failed', 'q');
    return (await currentTx().query(`SELECT ${PURITY} FROM masters.purity WHERE ($1::uuid IS NULL OR metal_id = $1) AND ($2 OR is_active)
        AND ($3::text IS NULL OR code ILIKE $3) AND ($4::uuid[] IS NULL OR id = ANY($4)) ORDER BY metal_id, fineness DESC, code`, [metalId ?? null, inc === 'true', like(q), idsParam(ids)])).rows;
  }

  @Get('purities/:id') @RequirePermission('masters.metals.view')
  async purity(@Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) reply: Reply) {
    return one(`SELECT ${PURITY} FROM masters.purity WHERE id = $1`, id, reply);
  }

  @Post('purities') @RequirePermission('masters.metals.manage')
  async createPurity(@Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    const b = parse(PurityInput, body);
    const c = currentTx();
    const m = (await c.query<{ is_active: boolean }>(`SELECT is_active FROM masters.metal WHERE id = $1`, [b.metal_id])).rows[0];
    if (!m) fail(422, 'metal_not_found');
    if (!m!.is_active) fail(422, 'inactive_master', 'metal is deactivated');
    try {
      const r = await c.query(`INSERT INTO masters.purity(tenant_id, metal_id, code, fineness, huid_required, header_visible)
        VALUES (platform.current_tenant(), $1, $2, $3::numeric, $4, $5) RETURNING ${PURITY}`, [b.metal_id, b.code, b.fineness, b.huid_required, b.header_visible]);
      await syncMetalsStep();
      reply.status(201);
      reply.header('ETag', etag(r.rows[0].version));
      return r.rows[0];
    } catch (e) { return dupOr(e); }
  }

  @Patch('purities/:id') @RequirePermission('masters.metals.manage')
  async updatePurity(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    const version = ifMatch(req)!;
    const b = parse(PurityPatch, body);
    const r = await currentTx().query(`UPDATE masters.purity SET fineness = coalesce($3::numeric, fineness), huid_required = coalesce($4, huid_required),
        header_visible = coalesce($5, header_visible), is_active = coalesce($6, is_active) WHERE id = $1 AND version = $2 RETURNING ${PURITY}`,
      [id, version, b.fineness ?? null, b.huid_required ?? null, b.header_visible ?? null, b.is_active ?? null]).catch(pgProblem);
    if (!r.rows[0]) return missOr412('masters.purity', id);
    reply.header('ETag', etag(r.rows[0].version));
    return r.rows[0];
  }
}
