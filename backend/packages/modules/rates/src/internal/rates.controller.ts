import { Body, Controller, Get, Headers, Post, Query, Res } from '@nestjs/common';
import { currentTx } from '@jw/db';
import { Ctx, type JwRequest, RequirePermission, fail, markOnboardingStepCompleted, needKey, parse, pgProblem, requestHash, todayIST, withIdempotency } from '@jw/mod-platform';
import { z } from 'zod';

/** Rupees per gram: decimal string, 2 dp, > 0 (numeric(12,2)); never parsed to a float. */
export const ratePerG = z.string().regex(/^[0-9]{1,10}\.[0-9]{2}$/).refine((v) => /[1-9]/.test(v), 'rate must be > 0');
export const MetalRateInput = z.object({ purity_id: z.string().uuid(), branch_id: z.string().uuid().optional(),
  kind: z.enum(['sale', 'old_metal', 'purchase']), rate_per_g: ratePerG }).strict();
const RATE = `id, purity_id, branch_id, kind, rate_per_g::text AS rate_per_g, to_char(rate_date, 'YYYY-MM-DD') AS rate_date, effective_from, source,
  derived_from_id, derived_rate_per_g::text AS derived_rate_per_g`;
/** Exclusive end: effective_from of the next row for the same (purity, kind, branch scope). */
const EFFECTIVE_TO = `(SELECT min(n.effective_from) FROM rates.metal_rate n WHERE n.purity_id = r.purity_id AND n.kind = r.kind
    AND n.branch_id IS NOT DISTINCT FROM r.branch_id AND (n.effective_from, n.id) > (r.effective_from, r.id)) AS effective_to`;
const KIND = z.enum(['sale', 'old_metal', 'purchase']);
export const MetalRateBatchInput = z.object({ branch_id: z.string().uuid().nullable().optional(), kind: KIND,
  bases: z.array(z.object({ purity_id: z.string().uuid(), rate_per_g: ratePerG }).strict()).min(1).max(20),
  overrides: z.array(z.object({ purity_id: z.string().uuid(), rate_per_g: ratePerG }).strict()).max(100).optional() }).strict();
const uuidQ = (v: string | undefined, name: string) => { if (v !== undefined && !z.string().uuid().safeParse(v).success) fail(422, 'validation_failed', name); };
type Status = { branch_id: string | null; rate_date: string; todays_rate_set: boolean; missing_metal_codes: string[]; old_metal_rate_set: boolean; missing_old_metal_codes: string[] };
const SCOPE_BATCH = 'POST /v1/rates/batch';
/** R6: a second publish for (purity, kind, scope) on the same IST day is a correction → rates.edit. */
async function needEditIfCorrection(req: JwRequest, branchId: string | null, purityIds: string[], kind: string): Promise<void> {
  if (req.auth?.permissions.has('rates.edit')) return;
  const hit = await currentTx().query(`SELECT 1 FROM rates.metal_rate WHERE purity_id = ANY($1::uuid[]) AND kind = $2
     AND branch_id IS NOT DISTINCT FROM $3::uuid AND rate_date = $4::date LIMIT 1`, [purityIds, kind, branchId, todayIST()]);
  if (hit.rowCount) fail(403, 'permission_denied', 'rates.edit');
}

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const HistoryQuery = z.object({ purity_id: z.string().uuid().optional(), kind: z.enum(['sale', 'old_metal', 'purchase']).optional(),
  metal_id: z.string().uuid().optional(), branch_id: z.string().uuid().optional(), from: date.optional(), to: date.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25), cursor: z.string().optional() });
/** Opaque keyset cursor: base64url("<effective_from ISO>|<id>"). */
const encCursor = (r: { effective_from: Date | string; id: string }) =>
  Buffer.from(`${new Date(r.effective_from).toISOString()}|${r.id}`).toString('base64url');
function decCursor(c: string): [string, string] {
  const [ts, id] = Buffer.from(c, 'base64url').toString('utf8').split('|');
  if (!ts || !id || Number.isNaN(Date.parse(ts)) || !z.string().uuid().safeParse(id).success) fail(422, 'invalid_cursor');
  return [ts!, id!];
}

@Controller('v1/rates')
export class RatesController {
  /** Rate history, newest first (effective_from DESC, id DESC), keyset-paginated. Same access as /current. */
  @Get()
  async history(@Query() query: unknown) {
    const q = parse(HistoryQuery, query);
    const [cTs, cId] = q.cursor ? decCursor(q.cursor) : [null, null];
    const rows = (await currentTx().query<{ id: string; effective_from: Date }>(
      `SELECT ${RATE}, ${EFFECTIVE_TO} FROM rates.metal_rate r
        WHERE ($1::uuid IS NULL OR purity_id = $1)
          AND ($9::uuid IS NULL OR purity_id IN (SELECT id FROM masters.purity WHERE metal_id = $9)) AND ($2::text IS NULL OR kind = $2) AND ($3::uuid IS NULL OR branch_id = $3)
          AND ($4::date IS NULL OR rate_date >= $4) AND ($5::date IS NULL OR rate_date <= $5)
          AND ($6::timestamptz IS NULL OR (effective_from, id) < ($6::timestamptz, $7::uuid))
        ORDER BY effective_from DESC, id DESC LIMIT $8`,
      [q.purity_id ?? null, q.kind ?? null, q.branch_id ?? null, q.from ?? null, q.to ?? null, cTs, cId, q.limit + 1, q.metal_id ?? null])).rows;
    const more = rows.length > q.limit;
    const items = more ? rows.slice(0, q.limit) : rows;
    return { items, next_cursor: more ? encCursor(items[items.length - 1]!) : null };
  }

  /** One row per (purity, kind): the branch row beats the tenant-wide row; latest effective_from <= now().
   *  Excludes deactivated purities and purities under a deactivated metal (read-only SQL on masters; history keeps them). */
  @Get('current')
  async current(@Query('branch_id') branchId?: string) {
    if (branchId && !z.string().uuid().safeParse(branchId).success) fail(422, 'validation_failed', 'branch_id');
    return (await currentTx().query(
      `SELECT DISTINCT ON (purity_id, kind) ${RATE} FROM rates.metal_rate r
        WHERE effective_from <= now() AND (branch_id IS NULL OR branch_id = $1::uuid)
          AND EXISTS (SELECT 1 FROM masters.purity p JOIN masters.metal m ON m.tenant_id = p.tenant_id AND m.id = p.metal_id
                      WHERE p.id = r.purity_id AND p.is_active AND m.is_active)
        ORDER BY purity_id, kind, (branch_id IS NOT NULL) DESC, effective_from DESC`, [branchId ?? null])).rows;
  }

  /** Insert-only (app_rw has INSERT, no UPDATE): a correction is a new row. rate_date = today (IST), server-assigned. */
  @Post() @RequirePermission('rates.publish')
  async publish(@Ctx() req: JwRequest, @Body() body: unknown, @Res({ passthrough: true }) reply: { status(n: number): unknown }) {
    const b = parse(MetalRateInput, body);
    const c = currentTx();
    await needEditIfCorrection(req, b.branch_id ?? null, [b.purity_id], b.kind);
    // Rates may read masters via SQL (app_rw SELECT); no import of the masters module internals.
    const p = (await c.query<{ is_active: boolean }>(`SELECT is_active FROM masters.purity WHERE id = $1`, [b.purity_id])).rows[0];
    if (p && !p.is_active) fail(422, 'inactive_master', 'purity is deactivated');
    try {
      const r = await c.query(
        `INSERT INTO rates.metal_rate(tenant_id, branch_id, purity_id, kind, rate_date, rate_per_g, published_by)
         VALUES (platform.current_tenant(), $1, $2, $3, $4::date, $5::numeric, $6) RETURNING ${RATE}`,
        [b.branch_id ?? null, b.purity_id, b.kind, todayIST(), b.rate_per_g, req.auth?.userId ?? null]);
      await markOnboardingStepCompleted('todays_rates', { rate_date: todayIST() });
      reply.status(201);
      return r.rows[0];
    } catch (e) { return pgProblem(e); }
  }

  /** R9 / 985: per-branch status from rates.v_todays_rate_status (security_invoker → RLS). Old metal = warning only. */
  @Get('todays-status')
  async todaysStatus(@Query('branch_id') branchId?: string) {
    uuidQ(branchId, 'branch_id');
    const today = todayIST();
    const rows = (await currentTx().query<Status>(
      `SELECT branch_id, $2::text AS rate_date, todays_rate_set, coalesce(missing_metal_codes, '{}') AS missing_metal_codes,
              old_metal_rate_set, coalesce(missing_old_metal_codes, '{}') AS missing_old_metal_codes
         FROM rates.v_todays_rate_status WHERE $1::uuid IS NULL OR branch_id = $1 ORDER BY branch_id`, [branchId ?? null, today])).rows;
    if (branchId) return rows[0] ?? fail(404, 'not_found', 'branch');
    const union = (k: 'missing_metal_codes' | 'missing_old_metal_codes') => [...new Set(rows.flatMap((r) => r[k]))].sort();
    return { branch_id: null, rate_date: today, todays_rate_set: rows.length > 0 && rows.every((r) => r.todays_rate_set),
      missing_metal_codes: union('missing_metal_codes'), old_metal_rate_set: rows.length > 0 && rows.every((r) => r.old_metal_rate_set),
      missing_old_metal_codes: union('missing_old_metal_codes'), branches: rows };
  }

  /** R11: rate-card print data (doc_type rate_card). */
  @Get('rate-card')
  async rateCard(@Query('branch_id') branchId?: string) {
    uuidQ(branchId, 'branch_id');
    const c = currentTx();
    const branch = branchId ? (await c.query<{ id: string; code: string; name: string; company_id: string }>(
      `SELECT id, code, name, company_id FROM platform.branch WHERE id = $1`, [branchId])).rows[0] ?? fail(404, 'not_found', 'branch') : null;
    const company = (await c.query(`SELECT legal_name, trade_name, gstin FROM platform.company WHERE $1::uuid IS NULL OR id = $1 ORDER BY created_at LIMIT 1`,
      [branch?.company_id ?? null])).rows[0] ?? null;
    const rows = (await c.query<{ metal_id: string; metal_code: string; metal_name: string; purity_id: string; code: string; fineness: string;
      sale_rate_per_g: string | null; sale_rate_date: string | null; old_metal_rate_per_g: string | null }>(
      `WITH cur AS (SELECT DISTINCT ON (purity_id, kind) purity_id, kind, rate_per_g::text AS rate, to_char(rate_date, 'YYYY-MM-DD') AS d
                      FROM rates.metal_rate WHERE effective_from <= now() AND kind IN ('sale', 'old_metal') AND (branch_id IS NULL OR branch_id = $1::uuid)
                     ORDER BY purity_id, kind, (branch_id IS NOT NULL) DESC, effective_from DESC)
       SELECT m.id AS metal_id, m.code AS metal_code, m.name AS metal_name, p.id AS purity_id, p.code, p.fineness,
              s.rate AS sale_rate_per_g, s.d AS sale_rate_date, o.rate AS old_metal_rate_per_g
         FROM masters.purity p JOIN masters.metal m ON m.tenant_id = p.tenant_id AND m.id = p.metal_id
         LEFT JOIN cur s ON s.purity_id = p.id AND s.kind = 'sale' LEFT JOIN cur o ON o.purity_id = p.id AND o.kind = 'old_metal'
        WHERE p.is_active AND m.is_active ORDER BY m.code, p.fineness::numeric DESC, p.code`, [branchId ?? null])).rows;
    const metals: { metal_id: string; code: string; name: string; purities: unknown[] }[] = [];
    for (const r of rows) {
      let m = metals.find((x) => x.metal_id === r.metal_id);
      if (!m) metals.push(m = { metal_id: r.metal_id, code: r.metal_code, name: r.metal_name, purities: [] });
      m.purities.push({ purity_id: r.purity_id, code: r.code, fineness: r.fineness, sale_rate_per_g: r.sale_rate_per_g,
        sale_rate_date: r.sale_rate_date, old_metal_rate_per_g: r.old_metal_rate_per_g });
    }
    const st = branchId ? await this.todaysStatus(branchId) as Status : await this.todaysStatus() as Status;
    return { doc_type: 'rate_card', rate_date: todayIST(), generated_at: new Date().toISOString(), company,
      branch: branch ? { id: branch.id, code: branch.code, name: branch.name } : null,
      todays_rate_set: st.todays_rate_set, missing_metal_codes: st.missing_metal_codes, metals };
  }

  /** R2/R4 batch: base rate per metal; server derives other active purities: round(base × fineness / base_fineness, 2) (numeric, half-up).
   *  One request transaction + savepoint: any failure rolls back every row. Idempotent via platform.idempotency_key. */
  @Post('batch') @RequirePermission('rates.publish')
  async batch(@Ctx() req: JwRequest, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) reply: { status(n: number): unknown }) {
    needKey(key);
    const b = parse(MetalRateBatchInput, body);
    return withIdempotency(reply, SCOPE_BATCH, key!, requestHash('batch', b as Record<string, unknown>), async () => {
      const c = currentTx();
      const today = todayIST();
      const branchId = b.branch_id ?? null;
      const bases = (await c.query<{ id: string; metal_id: string; fineness: string; ok: boolean }>(
        `SELECT p.id, p.metal_id, p.fineness, (p.is_active AND m.is_active) AS ok FROM masters.purity p
           JOIN masters.metal m ON m.tenant_id = p.tenant_id AND m.id = p.metal_id WHERE p.id = ANY($1::uuid[])`, [b.bases.map((x) => x.purity_id)])).rows;
      for (const x of b.bases) {
        const p = bases.find((r) => r.id === x.purity_id);
        if (!p) fail(404, 'not_found', `purity ${x.purity_id}`);
        if (!p!.ok) fail(422, 'inactive_master', `purity ${x.purity_id} is deactivated`);
      }
      const metalIds = bases.map((r) => r.metal_id);
      if (new Set(metalIds).size !== b.bases.length) fail(422, 'duplicate_metal', 'one base per metal');
      const derived = (await c.query<{ purity_id: string; base_purity_id: string; derived: string }>(
        `SELECT p.id AS purity_id, bp.id AS base_purity_id,
                round(x.rate::numeric * p.fineness::numeric / bp.fineness::numeric, 2)::text AS derived
           FROM unnest($1::uuid[], $2::text[]) AS x(purity_id, rate)
           JOIN masters.purity bp ON bp.id = x.purity_id
           JOIN masters.purity p ON p.metal_id = bp.metal_id AND p.tenant_id = bp.tenant_id AND p.id <> bp.id AND p.is_active
          ORDER BY bp.id, p.fineness::numeric DESC, p.code`,
        [b.bases.map((x) => x.purity_id), b.bases.map((x) => x.rate_per_g)])).rows;
      const ov = new Map((b.overrides ?? []).map((o) => [o.purity_id, o.rate_per_g]));
      if (ov.size !== (b.overrides ?? []).length) fail(422, 'invalid_override', 'duplicate override purity');
      for (const id of ov.keys()) if (!derived.some((d) => d.purity_id === id)) fail(422, 'invalid_override', `purity ${id} is not a derived purity of a base metal`);
      for (const d of derived) if (!/[1-9]/.test(d.derived) && !ov.has(d.purity_id)) fail(422, 'invalid_rate', `derived rate for purity ${d.purity_id} rounds to 0.00`);
      await needEditIfCorrection(req, branchId, [...b.bases.map((x) => x.purity_id), ...derived.map((d) => d.purity_id)], b.kind);
      try {
        const items: unknown[] = [];
        const ins = async (purity: string, rate: string, from: string | null, drv: string | null) => {
          const r = (await c.query<{ id: string }>(
            `INSERT INTO rates.metal_rate(tenant_id, branch_id, purity_id, kind, rate_date, rate_per_g, published_by, derived_from_id, derived_rate_per_g)
             VALUES (platform.current_tenant(), $1, $2, $3, $4::date, $5::numeric, $6, $7, $8::numeric) RETURNING ${RATE}`,
            [branchId, purity, b.kind, today, rate, req.auth?.userId ?? null, from, drv])).rows[0]!;
          items.push(r);
          return r.id;
        };
        for (const x of b.bases) {
          const baseId = await ins(x.purity_id, x.rate_per_g, null, null);
          for (const d of derived.filter((y) => y.base_purity_id === x.purity_id)) await ins(d.purity_id, ov.get(d.purity_id) ?? d.derived, baseId, d.derived);
        }
        await markOnboardingStepCompleted('todays_rates', { rate_date: today });
        return { status: 201, body: JSON.parse(JSON.stringify({ rate_date: today, items })) };
      } catch (e) { return pgProblem(e); }
    });
  }
}
