import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Query, Res } from '@nestjs/common';
import { resolveTxt } from 'node:dns/promises';
import { currentTx, withTenantTx, isReleaseRenderablePin, isRenderableCheckExempt, RELEASE_PRINT_PINS, RENDERABLE_CHECK_EXEMPT_DOC_TYPES } from '@jw/db';
import { Auth, Ctx, JwRequest, RequirePermission, Problem, fail, ifMatch, parse, pgProblem } from './common';
import { DomainBody, TemplateBody, ThemeBody, docType, hostname } from './schemas';
import { SessionService, audit } from './session.service';

export const DNS_RESOLVER = 'JW_DNS_RESOLVER';
export type TxtResolver = (name: string) => Promise<string[][]>;
/** Real DNS. Under NODE_ENV=test only, JW_TEST_TXT_RECORDS ({"name":"value"}) stubs lookups (integration tests). */
export const defaultResolver: TxtResolver = async (n) => {
  if (process.env.NODE_ENV === 'test' && process.env.JW_TEST_TXT_RECORDS) {
    const v = (JSON.parse(process.env.JW_TEST_TXT_RECORDS) as Record<string, string>)[n];
    if (v === undefined) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    return [[v]];
  }
  return resolveTxt(n);
};

const THEME_FIELDS = ['app_name', 'logo_key', 'favicon_key', 'pwa_icon_key', 'login_bg_key', 'colors', 'fonts', 'login_text', 'support_contact'] as const;
const OBJ = new Set(['colors', 'fonts', 'login_text', 'support_contact']);
type Row = Record<string, unknown>;

/** Merge platform → partner → tenant: scalar fields NULL = inherit; JSON objects merged key-wise. */
export function mergeThemes(rows: Row[]): Row {
  const out: Row = {};
  for (const f of THEME_FIELDS) out[f] = OBJ.has(f) ? {} : null;
  for (const r of rows) for (const f of THEME_FIELDS) {
    if (OBJ.has(f)) out[f] = { ...(out[f] as Row), ...((r[f] as Row) ?? {}) };
    else if (r[f] !== null && r[f] !== undefined) out[f] = r[f];
  }
  return out;
}
const pick = (r: Row | undefined) => (r ? Object.fromEntries(THEME_FIELDS.map((f) => [f, r[f]])) : null);
const ORDER = `CASE scope WHEN 'platform' THEN 1 WHEN 'partner' THEN 2 ELSE 3 END`;

/** Theme rows visible in the current tx (RLS scope_read), optionally limited to one tenant/partner chain. */
export async function themeView(level: 'tenant' | 'partner'): Promise<{ effective: Row; own: Row | null; version: number | null }> {
  const r = await currentTx().query<Row>(
    `SELECT * FROM branding.theme
      WHERE scope = 'platform' OR (scope = 'partner' AND partner_id = branding.my_partner())
         OR (scope = 'tenant' AND tenant_id = platform.current_tenant()) ORDER BY ${ORDER}`);
  const own = r.rows.find((x) => x.scope === level);
  return { effective: mergeThemes(r.rows), own: pick(own), version: own ? Number(own.version) : null };
}

/** If-Match required when this level's theme row exists (stale → 412); first save creates it. */
export async function saveTheme(level: 'tenant' | 'partner', body: unknown, req: JwRequest): Promise<void> {
  const b = parse(ThemeBody, body);
  const c = currentTx();
  const cur = await c.query<{ version: number }>(
    `SELECT version FROM branding.theme WHERE scope = '${level}' AND ${level === 'tenant' ? 'tenant_id = platform.current_tenant()' : 'partner_id = platform.current_partner()'} FOR UPDATE`);
  if (cur.rows[0] && ifMatch(req) !== cur.rows[0].version) fail(412, 'version_mismatch');
  const vals = THEME_FIELDS.map((f) => (OBJ.has(f) ? JSON.stringify(b[f] ?? {}) : (b[f] ?? null)));
  const owner = level === 'tenant' ? 'tenant_id' : 'partner_id';
  const ownerFn = level === 'tenant' ? 'platform.current_tenant()' : 'platform.current_partner()';
  const upd = await c.query(
    `UPDATE branding.theme SET ${THEME_FIELDS.map((f, i) => `${f} = $${i + 1}`).join(', ')}, updated_at = now()
      WHERE scope = '${level}' AND ${owner} = ${ownerFn}`, vals);
  if (!upd.rowCount) {
    await c.query(`INSERT INTO branding.theme(scope, ${owner}, ${THEME_FIELDS.join(', ')})
                   VALUES ('${level}', ${ownerFn}, ${THEME_FIELDS.map((_, i) => `$${i + 1}`).join(', ')})`, vals);
  }
}

const DOMAIN = `id, hostname, status, verification_token, verified_at, last_checked_at, failure_reason, tls_status, created_at`;
export const domainView = (d: Row) => {
  const { verification_token, ...rest } = d;
  return { ...rest, dns_record: { type: 'TXT', name: `_jewel-verify.${d.hostname}`, value: verification_token } };
};
// All metadata reads (including inactive exact-version pins) share the resolver's tenant/own-partner/platform chain.
const TEMPLATE_READ_SCOPE = `((scope = 'tenant' AND tenant_id = platform.current_tenant())
  OR (scope = 'partner' AND partner_id = (SELECT partner_id FROM platform.tenant WHERE id = platform.current_tenant()))
  OR scope = 'platform')`;
/** B-2 (0.9.6): only the exact 998 platform pins are release-renderable (the FE renders bundled pins only). */
const notRenderable = (docType: string, what: string): never => {
  const errors = [{ path: 'body_key', code: 'print_template_not_renderable', message: `renderable pins: ${RELEASE_PRINT_PINS.filter((p) => p.doc_type === docType).map((p) => `${p.template_id} v${p.version} (${p.body_key})`).join(', ') || `none for doc_type ${docType}`}` }];
  throw new Problem(422, 'print_template_not_renderable',
    `${what}: custom print templates cannot be rendered in this release; only the platform default pins are renderable. Nothing was changed.`, errors);
};
// renderable (0.9.6): exact release-pin membership, computed from the shared constant (literal uuids/ints/doc types only).
const RENDERABLE_SQL = `((id, version, doc_type) IN (${RELEASE_PRINT_PINS.map((p) => `('${p.template_id}'::uuid, ${p.version}, '${p.doc_type}')`).join(', ')})
  OR doc_type IN (${RENDERABLE_CHECK_EXEMPT_DOC_TYPES.map((d) => `'${d}'`).join(', ')}))`; // tag_label: client-drawn labels, exempt (pre-B-2 behaviour)
const TEMPLATE = `id, scope, (scope <> 'tenant') AS read_only, doc_type, version, row_version, paper, print_language, numeral_system, engine, body_key, config, is_active, created_by, created_at, ${RENDERABLE_SQL} AS renderable`;

@Controller('v1')
export class BrandingController {
  constructor(@Inject(SessionService) private readonly sessions: SessionService, @Inject(DNS_RESOLVER) private readonly resolver: TxtResolver) {}

  @Get('branding/theme') @Auth('optional')
  async theme(@Ctx() req: JwRequest) {
    if (req.auth) return themeView('tenant');
    const tenantId = await this.sessions.tenantForHost(req);          // login page branding on a shop domain
    if (!tenantId) return withTenantTx(this.sessions.tenantPool, { tenantId: '' }, async () => ({ effective: (await themeView('tenant')).effective }));
    return withTenantTx(this.sessions.tenantPool, { tenantId }, async () => ({ effective: (await themeView('tenant')).effective }));
  }

  @Put('branding/theme') @RequirePermission('platform.settings.edit')
  async putTheme(@Ctx() req: JwRequest, @Body() body: unknown) {
    try { await saveTheme('tenant', body, req); } catch (e) { if (e instanceof Error && 'getStatus' in e) throw e; return pgProblem(e); }
    return themeView('tenant');
  }

  @Get('branding/domains')
  async domains() {
    return (await currentTx().query<Row>(`SELECT ${DOMAIN} FROM branding.custom_domain WHERE tenant_id = platform.current_tenant() ORDER BY created_at`)).rows.map(domainView);
  }

  @Post('branding/domains') @RequirePermission('platform.settings.edit')
  async addDomain(@Body() body: unknown) {
    const b = parse(DomainBody, body);
    try {
      const r = await currentTx().query<Row>(`INSERT INTO branding.custom_domain(hostname, tenant_id) VALUES ($1, platform.current_tenant()) RETURNING ${DOMAIN}`, [b.hostname]);
      return domainView(r.rows[0]);
    } catch (e) { return pgProblem(e); }
  }

  @Delete('branding/domains/:id') @HttpCode(204) @RequirePermission('platform.settings.edit')
  async removeDomain(@Param('id', ParseUUIDPipe) id: string) {
    const r = await currentTx().query(`DELETE FROM branding.custom_domain WHERE id = $1 AND tenant_id = platform.current_tenant()`, [id]);
    if (!r.rowCount) fail(404, 'not_found');
  }

  @Post('branding/domains/:id/verify') @HttpCode(200) @RequirePermission('platform.settings.edit')
  async verify(@Param('id', ParseUUIDPipe) id: string) {
    const c = currentTx();
    const d = (await c.query<Row>(`SELECT ${DOMAIN} FROM branding.custom_domain WHERE id = $1 AND tenant_id = platform.current_tenant()`, [id])).rows[0] ?? fail(404, 'not_found');
    let ok = false; let reason: string | null = null;
    try {
      const recs = await this.resolver(`_jewel-verify.${d.hostname}`);
      ok = recs.some((parts) => parts.join('') === d.verification_token);
      if (!ok) reason = 'TXT record found but value does not match';
    } catch (e) { reason = `TXT lookup failed: ${(e as { code?: string }).code ?? 'error'}`; }
    const r = await c.query<Row>(
      `UPDATE branding.custom_domain SET status = $2, verified_at = CASE WHEN $2 = 'verified' THEN coalesce(verified_at, now()) END,
              failure_reason = $3, last_checked_at = now(), tls_status = CASE WHEN $2 = 'verified' THEN tls_status ELSE 'none' END
        WHERE id = $1 RETURNING ${DOMAIN}`, [id, ok ? 'verified' : 'failed', reason]);
    if (ok) await audit('domain.verified', 'branding.custom_domain', id, { hostname: d.hostname });
    return domainView(r.rows[0]);
  }

  /** P17 on-demand TLS gate (Caddy `ask`): 200 only for verified hostnames. */
  @Get('internal/tls/ask') @Auth('optional')
  async tlsAsk(@Query('domain') domain: string, @Res({ passthrough: true }) reply: { status(n: number): unknown }) {
    if (!hostname.safeParse(domain).success) fail(404, 'not_found');
    const r = await withTenantTx(this.sessions.tenantPool, { tenantId: '' }, (c) =>
      c.query(`SELECT 1 FROM branding.custom_domain WHERE hostname = $1 AND status = 'verified'`, [domain]));
    if (!r.rows[0]) fail(404, 'not_found');
    reply.status(200);
    return { ok: true };
  }

  @Get('print-templates')
  async templates(@Query('doc_type') dt?: string) {
    if (dt !== undefined && !docType.safeParse(dt).success) fail(422, 'validation_failed', 'doc_type');
    return (await currentTx().query(
      `SELECT ${TEMPLATE} FROM branding.print_template WHERE ($1::text IS NULL OR doc_type = $1)
        AND ${TEMPLATE_READ_SCOPE}
        ORDER BY doc_type, CASE scope WHEN 'tenant' THEN 0 WHEN 'partner' THEN 1 ELSE 2 END, version DESC`, [dt ?? null])).rows;
  }

  @Get('print-templates/:id')
  async template(@Param('id', ParseUUIDPipe) id: string) {
    // S19 #2: a valid inherited pin must resolve even after its version becomes inactive; foreign owners stay404.
    return (await currentTx().query(`SELECT ${TEMPLATE} FROM branding.print_template WHERE id = $1 AND ${TEMPLATE_READ_SCOPE}`, [id])).rows[0]
      ?? fail(404, 'not_found');
  }

  @Post('print-templates') @RequirePermission('platform.settings.edit')
  async createTemplate(@Ctx() req: JwRequest, @Body() body: unknown) {
    const b = parse(TemplateBody, body);
    // A new row always gets a new uuid, which is never a release pin: refuse before any write (B-2).
    if (!isRenderableCheckExempt(b.doc_type) && !isReleaseRenderablePin(b.doc_type, null, null)) notRenderable(b.doc_type, 'create');
    const c = currentTx();
    try {
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('print_template:' || platform.current_tenant() || ':' || $1))`, [b.doc_type]);
      const r = await c.query(
        `INSERT INTO branding.print_template(scope, tenant_id, doc_type, version, paper, print_language, numeral_system, body_key, config, created_by)
         VALUES ('tenant', platform.current_tenant(), $1,
                 (SELECT coalesce(max(version), 0) + 1 FROM branding.print_template WHERE tenant_id = platform.current_tenant() AND doc_type = $1),
                 $2, $3, $4, $5, $6, $7) RETURNING ${TEMPLATE}`,
        [b.doc_type, b.paper, b.print_language, b.numeral_system, b.body_key, JSON.stringify(b.config), req.auth?.userId ?? null]);
      return r.rows[0];
    } catch (e) { return pgProblem(e); }
  }

  @Post('print-templates/:id/activate') @HttpCode(200) @RequirePermission('platform.settings.edit')
  async activate(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string) {
    const c = currentTx();
    // v1.5: print_template's `version` is the document version; optimistic locking uses row_version (If-Match)
    const expected = ifMatch(req)!;
    const t = (await c.query<{ doc_type: string; row_version: number; print_language: string; version: number }>(`SELECT doc_type, row_version, print_language, version FROM branding.print_template WHERE id = $1 AND tenant_id = platform.current_tenant()`, [id])).rows[0] ?? fail(404, 'not_found');
    if (!['en', 'ta'].includes(t.print_language)) throw new Problem(422, 'validation_failed', 'print_language supports en/ta only in0.9.5', [{ path: 'print_language', message: 'choose en or ta' }]);
    if (t.row_version !== expected) fail(412, 'version_mismatch', 'The template was changed by someone else; reload and retry');
    // B-2: existing precedence (404, legacy language 422, 412) first; then refuse before deactivating the current active row.
    if (!isRenderableCheckExempt(t.doc_type) && !isReleaseRenderablePin(t.doc_type, id, t.version)) notRenderable(t.doc_type, 'activate');
    await c.query(`UPDATE branding.print_template SET is_active = false WHERE tenant_id = platform.current_tenant() AND doc_type = $1 AND is_active AND id <> $2`, [t.doc_type, id]);
    return (await c.query(`UPDATE branding.print_template SET is_active = true WHERE id = $1 AND row_version = $2 RETURNING ${TEMPLATE}`, [id, expected])).rows[0]
      ?? fail(412, 'version_mismatch');
  }
}
