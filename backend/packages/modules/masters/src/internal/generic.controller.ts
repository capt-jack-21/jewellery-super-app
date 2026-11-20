import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, OnModuleInit, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import { currentTx } from '@jw/db';
import { Ctx, type JwRequest, STORAGE, openSecret, bucketHit, bucketLocked, bucketRetryAfter, RateLimited, type StorageService, etag, fail, ifMatch, objectKey, originalName, parse, pgProblem, registerFileAccess,
  sha256, staleOr404 } from '@jw/mod-platform';
import { z } from 'zod';
import { type ListQuery, type Row, type Spec, areaOf, getOne, getRow, insert, list, need, update } from './crud';
import { SPECS, VENDOR_PAN_AAD, panCols, rejectAadhaar } from './specs';
import { needKey, requestHash, withIdempotency } from './tax-settings.controller';

type Reply = { status(n: number): unknown; header(k: string, v: string): unknown };
const spec = (name: string): Spec => SPECS.get(name) ?? fail(404, 'not_found', `unknown master ${name}`);
const view = (s: Spec, req: JwRequest, row: Row = {}) => need(req.auth, `masters.${areaOf(s, row)}.view`);

/**
 * 0.7.0: /v1/masters/{resource} for M3–M8, M10–M15 (specs.ts). Static routes (metals, purities, designs/:id/photos …) win over
 * the :resource param in the router. Writes need masters.<area>.manage (982), reads masters.<area>.view.
 */
@Controller('v1/masters')
export class GenericMastersController {
  @Get('vendors/pan-backfill-status')
  async panStatus(@Ctx() req: JwRequest) {
    need(req.auth, 'masters.vendors.manage');
    return panBackfillStatus();
  }

  /** Copies legacy vendor.pan into pan_enc / pan_key_id / pan_last4 for legacy-only rows. Dry run unless {dry_run:false}; never clears pan. */
  @Post('vendors/pan-backfill') @HttpCode(200)
  async panBackfill(@Ctx() req: JwRequest, @Body() body: unknown) {
    need(req.auth, 'masters.vendors.manage');
    const { dry_run } = parse(BackfillBody, body ?? {});
    return vendorPanBackfill(dry_run);
  }

  @Get(':resource')
  async list(@Ctx() req: JwRequest, @Param('resource') resource: string, @Query() q: ListQuery) {
    const s = spec(resource);
    view(s, req, { party_type: q.party_type });
    return list(s, q);
  }

  @Get(':resource/:id')
  async get(@Ctx() req: JwRequest, @Param('resource') resource: string, @Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) reply: Reply) {
    const s = spec(resource);
    const row = await getOne(s, id);
    view(s, req, row);
    reply.header('ETag', etag(row.version as number));
    return row;
  }

  @Post(':resource')
  async create(@Ctx() req: JwRequest, @Param('resource') resource: string, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply,
               @Headers('idempotency-key') key?: string) {
    const s = spec(resource);
    rejectAadhaar(body);
    const pre = (body && typeof body === 'object' ? body : {}) as Row;
    const auth = need(req.auth, `masters.${areaOf(s, pre)}.manage`);
    if (s.name === 'kyc-documents' && pre.doc_type === 'aadhaar') fail(422, 'aadhaar_not_allowed', 'Aadhaar is not accepted as a KYC document; use PAN or another ID');
    const b = parse(s.create, body) as Row;
    // G5: optional Idempotency-Key (973 store, scope per resource): same key + same body → the stored 201; different body → 422
    if (key !== undefined) {
      needKey(key);
      const out = await withIdempotency(reply, `POST /v1/masters/${s.name}`, key, requestHash('', b), async () => ({ status: 201, body: await insert(s, b, { auth }) }));
      reply.header('ETag', etag((out as Row).version as number));
      return out;
    }
    const row = await insert(s, b, { auth });
    reply.status(201); reply.header('ETag', etag(row.version as number));
    return row;
  }

  @Patch(':resource/:id')
  async patch(@Ctx() req: JwRequest, @Param('resource') resource: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown,
              @Res({ passthrough: true }) reply: Reply) {
    const s = spec(resource);
    rejectAadhaar(body);
    const existing = (await getRow(s, id)) ?? fail(404, 'not_found');
    const auth = need(req.auth, `masters.${areaOf(s, existing)}.manage`);
    const ver = ifMatch(req)!;
    if (s.name === 'kyc-documents' && body && typeof body === 'object' && (body as Row).doc_type === 'aadhaar') fail(422, 'aadhaar_not_allowed', 'Aadhaar is not accepted as a KYC document');
    const b = parse(s.patch, body) as Row;
    const row = await update(s, id, ver, b, auth);
    reply.header('ETag', etag(row.version as number));
    return row;
  }
}

// ---------- G2: audited PAN / KYC number reveal ----------
const REVEAL: Record<string, { table: string; aad: (id: string) => string; area: string; party: string }> = {
  customers: { table: 'masters.customer', aad: () => 'masters.customer.pan', area: 'customers', party: 'customer_id' },
  vendors: { table: 'masters.vendor', aad: () => VENDOR_PAN_AAD, area: 'vendors', party: 'vendor_id' },
  staff: { table: 'hr.staff', aad: () => 'hr.staff.pan', area: 'staff', party: 'staff_id' },
};
const RevealBody = z.object({ reason: z.string().trim().min(10).max(500) }).strict();
export const REVEAL_MAX_PER_HOUR = 10;

@Controller('v1/masters')
export class KycRevealController {
  /** Full PAN + KYC document numbers for one party. Needs masters.kyc.reveal (owner/manager once Perceptor adds it; until then 403 for all).
   *  Mandatory reason, audit_append kyc.reveal per field {field, reason} (never the value), DB-backed limit per user, Cache-Control: no-store. */
  @Post(':party/:id/kyc/reveal') @HttpCode(200)
  async reveal(@Ctx() req: JwRequest, @Param('party') party: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown,
               @Res({ passthrough: true }) reply: Reply) {
    reply.header('Cache-Control', 'no-store');
    const p = REVEAL[party] ?? fail(404, 'not_found');
    const auth = need(req.auth, 'masters.kyc.reveal');
    const { reason } = parse(RevealBody, body);
    const c = currentTx();
    const legacyCol = party === 'vendors' ? 'pan AS legacy_pan' : 'NULL::text AS legacy_pan';
    const row = (await c.query<{ pan_enc: Buffer | null; pan_key_id: string | null; legacy_pan: string | null }>(
      `SELECT pan_enc, pan_key_id, ${legacyCol} FROM ${p.table} WHERE id = $1`, [id])).rows[0]
      ?? fail(404, 'not_found');
    // 986: DB-backed limit in platform.rate_limit_bucket, key kyc.reveal:<tenant>:<user>, 10 per fixed hour; the 10th hit locks, 11th → 429.
    const bkey = `kyc.reveal:${auth.tenantId}:${auth.userId}`;
    if (await bucketLocked(c, bkey)) throw new RateLimited(Math.max(1, await bucketRetryAfter(c, bkey)));
    await bucketHit(c, bkey, REVEAL_MAX_PER_HOUR, 60);
    const pan = row.pan_enc && row.pan_key_id ? openSecret(row.pan_key_id, row.pan_enc, p.aad(id)).toString('utf8') : null;
    // Vendor rows not yet backfilled: masked legacy value + flag (never the plaintext), until the pan backfill runs
    const notMigrated = pan === null && !!row.legacy_pan;
    const shownPan = notMigrated ? maskPan(row.legacy_pan!) : pan;
    const docs = (await c.query<{ id: string; doc_type: string; number_enc: Buffer | null; number_key_id: string | null }>(
      `SELECT d.id, d.doc_type, s.number_enc, s.number_key_id FROM masters.kyc_document d LEFT JOIN masters.kyc_document_secret s ON s.kyc_document_id = d.id
        WHERE d.${p.party} = $1 ORDER BY d.created_at`, [id])).rows;
    const documents = docs.map((d) => ({ id: d.id, doc_type: d.doc_type,
      number: d.number_enc && d.number_key_id ? openSecret(d.number_key_id, d.number_enc, `masters.kyc_document:${d.id}`).toString('utf8') : null }));
    // 984: one audit_append per revealed field, same tx as app_rw; payload = field + reason, never the value
    const log = (table: string, subject: string, field: string) => c.query(
      `SELECT platform.audit_append(platform.current_tenant(), 'kyc.reveal', $1, $2::uuid, NULL, jsonb_build_object('field', $3::text, 'reason', $4::text))`,
      [table, subject, field, reason]);
    if (pan !== null) await log(p.table, id, 'pan');
    for (const d of documents) if (d.number !== null) await log('masters.kyc_document', d.id, 'number');
    return { party_type: party.replace(/s$/, ''), id, pan: shownPan, pan_not_migrated: notMigrated, documents };
  }
}

const BackfillBody = z.object({ dry_run: z.boolean().default(true) }).strict();
export const maskPan = (v: string) => `${'X'.repeat(Math.max(0, v.length - 4))}${v.slice(-4).toUpperCase()}`;

/** Vendor PAN backfill (legacy pan → pan_enc/pan_key_id/pan_last4) for legacy-only rows of the current tenant. Dry run by default. */
export async function vendorPanBackfill(dryRun = true) {
  const c = currentTx();
  const rows = (await c.query<{ id: string; pan: string }>(
    `SELECT id, pan FROM masters.vendor WHERE pan IS NOT NULL AND pan_enc IS NULL ORDER BY id`)).rows;
  let invalid = 0; let written = 0;
  for (const r of rows) {
    const v = r.pan.trim().toUpperCase();
    if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(v)) { invalid++; continue; }
    if (dryRun) continue;
    const cols = panCols({ pan: v }, VENDOR_PAN_AAD);
    await c.query(`UPDATE masters.vendor SET pan_enc = $2, pan_key_id = $3, pan_last4 = $4 WHERE id = $1 AND pan_enc IS NULL`,
      [r.id, cols.pan_enc, cols.pan_key_id, cols.pan_last4]);
    written++;
  }
  return { dry_run: dryRun, candidates: rows.length, invalid, written };
}

/** 983 gate: the legacy vendor.pan column may only be dropped when every plaintext PAN has a matching ciphertext (decrypt-compared). */
export async function panBackfillStatus() {
  const rows = (await currentTx().query<{ id: string; pan: string | null; pan_enc: Buffer | null; pan_key_id: string | null; pan_last4: string | null }>(
    `SELECT id, pan, pan_enc, pan_key_id, pan_last4 FROM masters.vendor WHERE pan IS NOT NULL OR pan_enc IS NOT NULL`)).rows;
  let legacyOnly = 0; let encOnly = 0; let matched = 0; let mismatched = 0;
  for (const r of rows) {
    if (r.pan && !r.pan_enc) { legacyOnly++; continue; }
    if (!r.pan && r.pan_enc) { encOnly++; continue; }
    let plain = '';
    try { plain = openSecret(r.pan_key_id!, r.pan_enc!, VENDOR_PAN_AAD).toString('utf8'); } catch { plain = ''; }
    if (plain === r.pan!.toUpperCase() && r.pan_last4 === plain.slice(-4)) matched++; else mismatched++;
  }
  return { total: rows.length, legacy_only: legacyOnly, encrypted_only: encOnly, matched, mismatched, ready_to_drop_legacy: legacyOnly === 0 && mismatched === 0 };
}

// ---------- M4 design photos (files via POST /v1/files, then attach) ----------
const PhotoBody = z.object({ file_id: z.string().uuid(), caption: z.string().max(200).nullable().optional(), is_primary: z.boolean().optional(),
  sort_order: z.number().int().min(0).max(999).optional() }).strict();
const PhotoPatch = z.object({ caption: z.string().max(200).nullable(), is_primary: z.boolean(), sort_order: z.number().int().min(0).max(999) })
  .partial().strict().refine((o) => Object.keys(o).length > 0, 'empty patch');
const ReorderBody = z.object({ order: z.array(z.string().uuid()).max(100), cover_file_id: z.string().uuid().nullable().optional() }).strict()
  .refine((o) => new Set(o.order).size === o.order.length, 'duplicate file_id in order');
const PHOTO = `id, design_id, file_id, sort_order, is_primary, caption, version, created_at`;

@Controller('v1/masters/designs/:designId/photos')
export class DesignPhotosController {
  @Get()
  async list(@Ctx() req: JwRequest, @Param('designId', ParseUUIDPipe) designId: string) {
    need(req.auth, 'masters.designs.view');
    if (!(await currentTx().query(`SELECT 1 FROM masters.design WHERE id = $1`, [designId])).rowCount) fail(404, 'not_found');
    return (await currentTx().query(`SELECT ${PHOTO} FROM masters.design_photo WHERE design_id = $1 ORDER BY is_primary DESC, sort_order, created_at`, [designId])).rows;
  }

  @Post()
  async add(@Ctx() req: JwRequest, @Param('designId', ParseUUIDPipe) designId: string, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply,
            @Headers('idempotency-key') key?: string) {
    need(req.auth, 'masters.designs.manage');
    const b = parse(PhotoBody, body);
    if (key === undefined) return this.attach(designId, b, reply);
    needKey(key);
    const out = await withIdempotency(reply, 'POST /v1/masters/designs/{id}/photos', key, requestHash(designId, b as Record<string, unknown>), async () => {
      const r: { status(n: number): unknown; header(k: string, v: string): unknown } = { status: () => r, header: () => r };
      return { status: 201, body: await this.attach(designId, b, r) };
    });
    reply.header('ETag', etag((out as { version: number }).version));
    return out;
  }

  private async attach(designId: string, b: z.infer<typeof PhotoBody>, reply: Reply) {
    const c = currentTx();
    const d = (await c.query<{ a: boolean }>(`SELECT is_active AS a FROM masters.design WHERE id = $1 FOR UPDATE`, [designId])).rows[0] ?? fail(404, 'not_found');
    if (!d.a) fail(422, 'inactive_master', 'design is inactive');
    const f = (await c.query<{ t: string }>(`SELECT content_type AS t FROM platform.file WHERE id = $1 AND area = 'attachments' AND deleted_at IS NULL`, [b.file_id])).rows[0];
    if (!f) fail(422, 'unknown_reference', 'file_id: not an uploaded attachment');
    if (!/^image\//.test(f!.t)) fail(422, 'unsupported_file', 'design photos must be images');
    const first = !(await c.query(`SELECT 1 FROM masters.design_photo WHERE design_id = $1`, [designId])).rowCount;
    const primary = b.is_primary ?? first;
    try {
      if (primary) await c.query(`UPDATE masters.design_photo SET is_primary = false WHERE design_id = $1 AND is_primary`, [designId]);
      const p = (await c.query<{ version: number }>(`INSERT INTO masters.design_photo(tenant_id, design_id, file_id, sort_order, is_primary, caption)
        VALUES (platform.current_tenant(), $1, $2, $3, $4, $5) RETURNING ${PHOTO}`, [designId, b.file_id, b.sort_order ?? 0, primary, b.caption ?? null])).rows[0];
      reply.status(201); reply.header('ETag', etag(p.version));
      return p;
    } catch (e) {
      if ((e as { code?: string }).code === '23505') fail(409, 'already_attached', 'this file is already a photo of the design');
      return pgProblem(e);
    }
  }

  /** G3: reorder + set cover in one call. order = every photo's file_id, first = sort_order 0; cover_file_id (default: first) becomes is_primary.
   *  If-Match = the DESIGN version; the design version is bumped so concurrent reorders conflict (412). */
  @Patch()
  async reorder(@Ctx() req: JwRequest, @Param('designId', ParseUUIDPipe) designId: string, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    need(req.auth, 'masters.designs.manage');
    const ver = ifMatch(req)!;
    const b = parse(ReorderBody, body);
    const c = currentTx();
    const d = (await c.query<{ version: number }>(`UPDATE masters.design SET version = version WHERE id = $1 AND version = $2 RETURNING version`, [designId, ver])).rows[0];
    if (!d) return staleOr404(async () => ((await c.query(`SELECT 1 FROM masters.design WHERE id = $1`, [designId])).rowCount ?? 0) > 0);
    const have = (await c.query<{ f: string }>(`SELECT file_id::text AS f FROM masters.design_photo WHERE design_id = $1`, [designId])).rows.map((r) => r.f).sort();
    if (JSON.stringify([...b.order].sort()) !== JSON.stringify(have)) fail(422, 'photo_set_mismatch', 'order must list every photo file_id of the design exactly once');
    const cover = b.cover_file_id ?? b.order[0];
    if (cover && !b.order.includes(cover)) fail(422, 'validation_failed', 'cover_file_id must be one of order');
    await c.query(`UPDATE masters.design_photo SET is_primary = false WHERE design_id = $1 AND is_primary`, [designId]);
    await c.query(`UPDATE masters.design_photo p SET sort_order = o.n - 1, is_primary = coalesce(p.file_id = $3::uuid, false)
                     FROM unnest($2::uuid[]) WITH ORDINALITY AS o(f, n) WHERE p.design_id = $1 AND p.file_id = o.f`, [designId, b.order, cover ?? null]);
    reply.header('ETag', etag(d.version));
    return { design_id: designId, design_version: d.version,
      photos: (await c.query(`SELECT ${PHOTO} FROM masters.design_photo WHERE design_id = $1 ORDER BY sort_order, created_at`, [designId])).rows };
  }

  @Patch(':photoId')
  async patch(@Ctx() req: JwRequest, @Param('designId', ParseUUIDPipe) designId: string, @Param('photoId', ParseUUIDPipe) photoId: string,
              @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    need(req.auth, 'masters.designs.manage');
    const ver = ifMatch(req)!;
    const b = parse(PhotoPatch, body);
    const c = currentTx();
    if (b.is_primary) await c.query(`UPDATE masters.design_photo SET is_primary = false WHERE design_id = $1 AND is_primary AND id <> $2`, [designId, photoId]);
    const p = (await c.query<{ version: number }>(`UPDATE masters.design_photo SET caption = CASE WHEN $4 THEN $5 ELSE caption END,
        is_primary = coalesce($6, is_primary), sort_order = coalesce($7, sort_order)
      WHERE id = $1 AND design_id = $2 AND version = $3 RETURNING ${PHOTO}`,
      [photoId, designId, ver, 'caption' in b, b.caption ?? null, b.is_primary ?? null, b.sort_order ?? null])).rows[0];
    if (!p) return staleOr404(async () => ((await c.query(`SELECT 1 FROM masters.design_photo WHERE id = $1 AND design_id = $2`, [photoId, designId])).rowCount ?? 0) > 0);
    reply.header('ETag', etag(p.version));
    return p;
  }

  /** Detaches the photo and soft-deletes its platform.file (deleted_at only) unless another master still references it. */
  @Delete(':photoId') @HttpCode(204)
  async remove(@Ctx() req: JwRequest, @Param('designId', ParseUUIDPipe) designId: string, @Param('photoId', ParseUUIDPipe) photoId: string) {
    need(req.auth, 'masters.designs.manage');
    const ver = ifMatch(req)!;
    const c = currentTx();
    const r = await c.query<{ file_id: string }>(
      `DELETE FROM masters.design_photo WHERE id = $1 AND design_id = $2 AND version = $3 RETURNING file_id`, [photoId, designId, ver]);
    if (!r.rowCount) return staleOr404(async () => ((await c.query(`SELECT 1 FROM masters.design_photo WHERE id = $1 AND design_id = $2`, [photoId, designId])).rowCount ?? 0) > 0);
    // 974/986: app_rw may UPDATE only platform.file.deleted_at (tenant context is set by the request tx). Soft-delete when nothing else uses the file.
    await c.query(
      `UPDATE platform.file SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM masters.design_photo WHERE file_id = $1)
         AND NOT EXISTS (SELECT 1 FROM hr.staff WHERE photo_file_id = $1)
         AND NOT EXISTS (SELECT 1 FROM masters.kyc_document WHERE front_file_id = $1 OR back_file_id = $1)`, [r.rows[0].file_id]);
  }
}

// ---------- attachment upload (POST /v1/files) ----------
const PURPOSE_PERM: Record<string, string[]> = {
  design_photo: ['masters.designs.manage'], staff_photo: ['masters.staff.manage'],
  kyc_document: ['masters.customers.manage', 'masters.vendors.manage', 'masters.staff.manage'],
  tag_photo: ['inventory.tag.photos'],   // 0.8.4: piece photos (attached with POST /v1/inventory/tags/{id}/photos)
};
const MAX_ATTACHMENT = 5 * 1024 * 1024;
/** Sniffed type (never trust the client's content-type). */
function sniff(b: Buffer): string | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (b.length > 5 && b.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}
interface MultipartFile { filename: string; fields: Record<string, { value?: unknown } | undefined>; toBuffer(): Promise<Buffer> }
interface MultipartReq extends JwRequest { isMultipart?: () => boolean; file?: (o?: unknown) => Promise<MultipartFile | undefined> }

@Controller('v1/files')
export class AttachmentsController implements OnModuleInit {
  constructor(@Inject(STORAGE) private readonly storage: StorageService) {}
  onModuleInit(): void { registerFileAccess(attachmentAccess); }

  @Post()
  async upload(@Ctx() req: MultipartReq, @Res({ passthrough: true }) reply: Reply, @Headers('idempotency-key') idemKey?: string) {
    if (idemKey !== undefined) needKey(idemKey);
    const auth = req.auth ?? fail(401, 'unauthenticated');
    if (!req.isMultipart?.() || !req.file) fail(415, 'multipart_required');
    let file: MultipartFile | undefined;
    try { file = await req.file!({ limits: { fileSize: MAX_ATTACHMENT, files: 1 } }); } catch { fail(413, 'file_too_large'); }
    if (!file) fail(422, 'file_required');
    const purpose = String(file!.fields.purpose?.value ?? '');
    const perms = PURPOSE_PERM[purpose] ?? fail(422, 'validation_failed', 'purpose: design_photo | staff_photo | kyc_document | tag_photo');
    if (!perms!.some((p) => auth.permissions.has(p))) fail(403, 'permission_denied', perms!.join(' | '));
    let buf: Buffer;
    try { buf = await file!.toBuffer(); } catch { return fail(413, 'file_too_large', 'max 5 MB'); }
    const type = sniff(buf!);
    if (!type || (purpose !== 'kyc_document' && type === 'application/pdf')) fail(422, 'unsupported_file', purpose === 'kyc_document' ? 'jpeg, png, webp or pdf' : 'jpeg, png or webp');
    const store = async () => {
    const key = objectKey(auth.tenantId, 'attachments');
    await this.storage.put(key, buf!, type!);
    try {
      const f = (await currentTx().query(`INSERT INTO platform.file(tenant_id, area, object_key, original_name, content_type, size_bytes, sha256, created_by)
        VALUES (platform.current_tenant(), 'attachments', $1, $2, $3, $4, $5, $6) RETURNING id, area, original_name, content_type, size_bytes, created_at`,
        [key, originalName(file!.filename, type!), type, buf!.length, sha256(buf!), auth.userId])).rows[0];
      return { ...f, purpose };
    } catch (e) {
      await this.storage.delete(key).catch(() => undefined);
      return pgProblem(e);
    }
    };
    if (idemKey === undefined) { reply.status(201); return store(); }
    // same key + same bytes + purpose → the stored 201 (no second object); different bytes → 422 idempotency_key_reused
    return withIdempotency(reply, 'POST /v1/files', idemKey, requestHash(sha256(buf!).toString('hex'), { purpose, filename: file!.filename }),
      async () => ({ status: 201, body: await store() }));
  }
}

/** Who may get a download link for an attachment: the uploader, or anyone allowed to see what references it. */
async function attachmentAccess(f: { id: string; createdBy: string | null }, auth: { userId: string; permissions: Set<string> }): Promise<boolean> {
  if (f.createdBy && f.createdBy === auth.userId) return true;
  const r = (await currentTx().query<{ design: boolean; staff: boolean; kyc: string | null }>(`SELECT
      EXISTS (SELECT 1 FROM masters.design_photo WHERE file_id = $1) AS design,
      EXISTS (SELECT 1 FROM hr.staff WHERE photo_file_id = $1) AS staff,
      (SELECT party_type FROM masters.kyc_document WHERE front_file_id = $1 OR back_file_id = $1 LIMIT 1) AS kyc`, [f.id])).rows[0];
  if (r.design && auth.permissions.has('masters.designs.view')) return true;
  if (r.staff && auth.permissions.has('masters.staff.view')) return true;
  // KYC scans are sensitive: manage, not view
  if (r.kyc && auth.permissions.has(`masters.${({ customer: 'customers', vendor: 'vendors', staff: 'staff' } as Record<string, string>)[r.kyc]}.manage`)) return true;
  return false;
}
