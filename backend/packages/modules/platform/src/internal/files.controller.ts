import { Controller, Get, Inject, Param, ParseUUIDPipe, Res, StreamableFile } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { PG_POOL, currentTx, withTenantTx } from '@jw/db';
import { Auth, Ctx, JwRequest, fail } from './common';
import { canReadAttachment } from './registry';
import { signFileToken, verifyFileToken } from './file-token';
import { FILE_TOKEN_KEY, STORAGE, type StorageService, XLSX_TYPE, contentDisposition } from './storage';

type Reply = { header(k: string, v: string): unknown };
interface Resolved { kind: 'file' | 'job'; id: string; tenant: string; key: string; name: string; type: string | null; area?: string; created_by?: string | null }

/** 0.5.1 (974): a platform.file row (deleted_at IS NULL) by id; else a legacy import job (file_id NULL) by id. RLS scopes both. */
async function resolveById(c: PoolClient, id: string): Promise<Resolved | null> {
  const f = (await c.query<{ tenant: string; key: string; name: string; type: string; area: string; created_by: string | null }>(
    `SELECT tenant_id::text AS tenant, object_key AS key, original_name AS name, content_type AS type, area, created_by::text AS created_by
       FROM platform.file WHERE id = $1 AND deleted_at IS NULL`, [id])).rows[0];
  if (f) return { kind: 'file', id, ...f };
  const j = (await c.query<{ tenant: string; key: string; file_id: string | null }>(
    `SELECT tenant_id::text AS tenant, file_key AS key, file_id FROM platform.import_job WHERE id = $1`, [id])).rows[0];
  if (!j) return null;
  if (j.file_id) return resolveFile(c, j.file_id);     // a job id still works when the job has a file row (deleted → 404)
  return { kind: 'job', id, tenant: j.tenant, key: j.key, name: `import-${id}.${/\.xlsx$/i.test(j.key) ? 'xlsx' : 'csv'}`, type: null };
}
async function resolveFile(c: PoolClient, fileId: string): Promise<Resolved | null> {
  const f = (await c.query<{ tenant: string; key: string; name: string; type: string; area: string; created_by: string | null }>(
    `SELECT tenant_id::text AS tenant, object_key AS key, original_name AS name, content_type AS type, area, created_by::text AS created_by
       FROM platform.file WHERE id = $1 AND deleted_at IS NULL`, [fileId])).rows[0];
  return f ? { kind: 'file', id: fileId, ...f } : null;
}

/** Downloads: short-lived signed links for files whose metadata lives in RLS tables. */
@Controller()
export class FilesController {
  constructor(@Inject(STORAGE) private readonly storage: StorageService, @Inject(FILE_TOKEN_KEY) private readonly key: Buffer,
              @Inject(PG_POOL) private readonly pool: Pool) {}

  /** {id} = platform.file id, or (legacy) an import job id. Another shop's id → 404 (RLS). */
  /** 0.7.0 (decision d): imports/exports need platform.import.run; attachments (design photos, staff photos, KYC scans) need the
   *  permission of whatever references them (resolvers registered by masters) or being the uploader. */
  @Get('v1/files/:id/url')
  async url(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string) {
    const auth = req.auth ?? fail(401, 'unauthenticated');
    const r = (await resolveById(currentTx(), id)) ?? fail(404, 'not_found');
    if (r.tenant !== auth.tenantId) fail(404, 'not_found');   // belt and braces over RLS
    if (r.kind === 'file' && r.area === 'attachments') {
      if (!(await canReadAttachment({ id: r.id, area: r.area, createdBy: r.created_by ?? null }, auth))) fail(403, 'permission_denied', 'attachment');
    } else if (!auth.permissions.has('platform.import.run')) fail(403, 'permission_denied', 'platform.import.run');
    const { token, expiresAt } = signFileToken(this.key, { tenantId: r.tenant, fileId: r.id, objectKey: r.key, kind: r.kind });
    return { url: `/files/${token}`, expires_at: expiresAt.toISOString() };
  }

  /** Streams the object. No session: the HMAC token is the credential; the row is re-checked under the token tenant's RLS. */
  @Get('files/:token') @Auth('public')
  async download(@Param('token') token: string, @Res({ passthrough: true }) reply: Reply) {
    const v = verifyFileToken(this.key, token);
    if (!v.ok) return v.reason === 'expired' ? fail(410, 'link_expired', 'request a new download link') : fail(404, 'not_found');
    const p = v.payload;
    const r = await withTenantTx(this.pool, { tenantId: p.t }, async (c) => {
      if ((p.s ?? 'job') === 'file') return resolveFile(c, p.f);
      const j = (await c.query<{ key: string; file_id: string | null }>(
        `SELECT file_key AS key, file_id FROM platform.import_job WHERE id = $1`, [p.f])).rows[0];
      if (!j) return null;
      if (j.file_id) return resolveFile(c, j.file_id);
      return { kind: 'job', id: p.f, tenant: p.t, key: j.key, name: `import-${p.f}.${/\.xlsx$/i.test(j.key) ? 'xlsx' : 'csv'}`, type: null } as Resolved;
    });
    if (!r || r.key !== p.k) fail(404, 'not_found');
    const obj = await this.storage.get(r!.key);
    if (!obj) fail(404, 'not_found');
    const type = r!.type ?? obj!.contentType ?? (/\.xlsx$/i.test(r!.key) ? XLSX_TYPE : 'text/csv');
    reply.header('content-type', type);
    reply.header('content-disposition', contentDisposition(r!.name));
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
    if (obj!.size) reply.header('content-length', String(obj!.size));
    return new StreamableFile(obj!.body);
  }
}
