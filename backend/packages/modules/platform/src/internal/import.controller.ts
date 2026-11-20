import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import { parse as parseCsv } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { currentTx } from '@jw/db';
import { seal } from '@jw/shared';
import { Ctx, JwRequest, RequirePermission, etag, fail, ifMatch, parse, pgProblem, sha256, staleOr404 } from './common';
import { MappingProfileBody, MappingProfilePatch, uuid } from './schemas';
import { audit } from './session.service';
import { type RowErr, importKind, stockImporterOf } from './registry';
import { STORAGE, type StorageService, XLSX_TYPE, objectKey, originalName, readAll } from './storage';

/**
 * P21 import (schema v1.4): customers (PAN → pan_enc AES-GCM + pan_last4), stock (inventory.tag), opening balances
 * (accounts.account_head opening_*). Row errors → platform.import_row_error (error_report_key stays null).
 * Optional mapping profile (platform.import_mapping_profile) renames source headers to template columns.
 * UNVERIFIED: written under the no-run rule.
 */
export const MAX_BYTES = 5 * 1024 * 1024;
export const MAX_ROWS = 20_000;
const KINDS = ['customers', 'stock', 'opening_balances'] as const;
type Kind = (typeof KINDS)[number];
/** 0.7.0: built-in kinds + kinds registered by other modules (masters, 981). */
const builtin = (k: string): k is Kind => (KINDS as readonly string[]).includes(k);
export const isImportKind = (k: string): boolean => builtin(k) || !!importKind(k);
const templateOf = (k: string): string[] => (builtin(k) ? TEMPLATES[k] : importKind(k)?.template ?? []);
const requiredOf = (k: string): string[] => (builtin(k) ? REQUIRED[k] : importKind(k)?.required ?? []);
const validatorOf = (k: string) => (builtin(k) ? VALIDATORS[k] : importKind(k)!.validate);
function assertKindPerm(req: JwRequest, k: string): void {
  const def = builtin(k) ? null : importKind(k);
  if (def && !req.auth?.permissions.has(def.perm)) fail(403, 'permission_denied', def.perm);
}
/** Template columns per kind (header row of the downloadable CSV). The first column of each is required. */
export const TEMPLATES: Record<Kind, string[]> = {
  customers: ['name', 'phone', 'email', 'gstin', 'pan', 'state_code', 'dob', 'anniversary', 'address_line1', 'city', 'pincode'],
  stock: ['tag_no', 'item_code', 'purity_code', 'gross_wt', 'stone_wt', 'net_wt', 'huid', 'hallmark_exempt', 'pieces', 'mc_type', 'mc_value', 'wastage_pct', 'huid_charge'],
  opening_balances: ['account_name', 'account_group', 'kind', 'party_phone', 'opening_amount', 'dr_cr', 'pure_wt', 'metal_code'],
};
const REQUIRED: Record<Kind, string[]> = {
  customers: ['name'], stock: ['tag_no', 'item_code', 'purity_code', 'gross_wt', 'net_wt'], opening_balances: ['account_name', 'account_group', 'kind', 'opening_amount', 'dr_cr'],
};
const HEAD_KINDS = ['vendor', 'customer', 'cash', 'bank', 'sales', 'purchase', 'tax', 'expense', 'income', 'metal_stock', 'other'];
export type { RowErr };
type Cust = { name: string; phone: string | null; email: string | null; gstin: string | null; pan: string | null; state_code: string | null; dob: string | null; anniversary: string | null; address: Record<string, string> };
type Tag = { tag_no: string; item_id: string; purity_id: string; gross_wt: string; stone_wt: string; net_wt: string; huid: string | null; hallmark_exempt: boolean; pieces: number; mc_type: string; mc_value: string; wastage_pct: string; huid_charge: string };
type Head = { name: string; group_id: string; kind: string; customer_id: string | null; amount: string; pure_wt: string; metal_id: string | null };

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
const WT = /^\d{1,7}(\.\d{1,3})?$/;          // grams, decimal string
const AMT = /^\d{1,13}(\.\d{1,2})?$/;        // rupees, decimal string (never parsed to float)
const normPhone = (p?: string) => (p ?? '').replace(/[\s-]/g, '').replace(/^\+?91(?=\d{10}$)/, '') || null;
/** Compare decimal strings exactly (scaled BigInt), e.g. net_wt <= gross_wt. */
const dec = (s: string, scale = 3) => { const [i, f = ''] = s.split('.'); return BigInt(i + f.padEnd(scale, '0').slice(0, scale)); };

export async function readRows(buf: Buffer, filename: string): Promise<Record<string, string>[]> {
  if (/\.xlsx$/i.test(filename)) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    if (!ws) return [];
    const head: string[] = [];
    ws.getRow(1).eachCell({ includeEmpty: true }, (c, i) => { head[i] = String(c.text ?? '').trim().toLowerCase(); });
    const out: Record<string, string>[] = [];
    for (let i = 2; i <= ws.rowCount; i++) {
      const r = ws.getRow(i); const o: Record<string, string> = {}; let any = false;
      head.forEach((h, j) => { if (!h) return; const v = String(r.getCell(j).text ?? '').trim(); o[h] = v; if (v) any = true; });
      if (any) out.push(o);
    }
    return out;
  }
  if (!/\.csv$/i.test(filename)) fail(422, 'unsupported_file', 'Upload .csv or .xlsx');
  const text = buf.toString('utf8').replace(/^\uFEFF/, '');
  return parseCsv(text, { columns: (h: string[]) => h.map((x) => x.trim().toLowerCase()), skip_empty_lines: true, trim: true, relax_column_count: true }) as Record<string, string>[];
}

/** Apply a mapping profile: {template column → source header}. Unmapped template columns keep their own header name. */
export function applyMapping(rows: Record<string, string>[], mapping: Record<string, string> | null): Record<string, string>[] {
  if (!mapping) return rows;
  const m = Object.entries(mapping).map(([to, from]) => [to, from.trim().toLowerCase()] as const);
  return rows.map((r) => { const o = { ...r }; for (const [to, from] of m) if (from in r) o[to] = r[from]; return o; });
}

/** Validates customer rows. Row numbers are spreadsheet rows (header = 1). Never writes. */
export async function validateCustomers(rows: Record<string, string>[]): Promise<{ ok: Cust[]; errors: RowErr[] }> {
  const errors: RowErr[] = []; const ok: Cust[] = []; const seen = new Map<string, number>();
  const phones = rows.map((r) => normPhone(r.phone)).filter(Boolean);
  const existing = new Set((await currentTx().query<{ phone: string }>(`SELECT phone FROM masters.customer WHERE phone = ANY($1)`, [phones])).rows.map((r) => r.phone));
  rows.forEach((r, i) => {
    const row = i + 2; const before = errors.length;
    const e = (column: string, code: string, message: string) => errors.push({ row, column, code, message, raw: r });
    const name = (r.name ?? '').trim();
    if (!name) e('name', 'required', 'required'); else if (name.length > 120) e('name', 'invalid_format', 'max 120 characters');
    const phone = normPhone(r.phone);
    if (phone && !/^[6-9]\d{9}$/.test(phone)) e('phone', 'invalid_format', '10-digit Indian mobile number expected');
    if (phone && seen.has(phone)) e('phone', 'duplicate_in_file', `duplicate of row ${seen.get(phone)}`);
    if (phone && existing.has(phone)) e('phone', 'already_exists', 'customer with this phone already exists');
    if (phone) seen.set(phone, row);
    const email = r.email || null; if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) e('email', 'invalid_format', 'invalid email');
    const gstin = r.gstin ? r.gstin.toUpperCase() : null; if (gstin && !/^[0-9]{2}[A-Z0-9]{13}$/.test(gstin)) e('gstin', 'invalid_format', 'invalid GSTIN');
    const pan = r.pan ? r.pan.toUpperCase().trim() : (gstin ? gstin.slice(2, 12) : null);
    if (pan && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) e('pan', 'invalid_format', 'invalid PAN (AAAAA9999A)');
    if (pan && gstin && r.pan && gstin.slice(2, 12) !== pan) e('pan', 'invalid_format', 'does not match GSTIN');
    const st = r.state_code ? r.state_code.padStart(2, '0') : (gstin ? gstin.slice(0, 2) : null);
    if (st && !/^\d{2}$/.test(st)) e('state_code', 'invalid_format', '2-digit GST state code expected');
    if (gstin && st && gstin.slice(0, 2) !== st) e('state_code', 'invalid_format', 'does not match GSTIN');
    for (const k of ['dob', 'anniversary'] as const) if (r[k] && !isDate(r[k])) e(k, 'invalid_format', 'date YYYY-MM-DD expected');
    if (errors.length === before) {
      const address: Record<string, string> = {};
      for (const [k, to] of [['address_line1', 'line1'], ['city', 'city'], ['pincode', 'pincode']]) if (r[k]) address[to] = r[k];
      ok.push({ name, phone, email, gstin, pan, state_code: st, dob: r.dob || null, anniversary: r.anniversary || null, address });
    }
  });
  return { ok, errors };
}

/** Stock → inventory.tag. Item and purity are resolved by code; the purity must belong to the item's metal. */
export async function validateStock(rows: Record<string, string>[]): Promise<{ ok: Tag[]; errors: RowErr[] }> {
  const c = currentTx();
  const items = new Map((await c.query<{ code: string; id: string; metal_id: string; huid_charge: string }>(
    `SELECT upper(code) AS code, id, metal_id, huid_charge::text FROM masters.item WHERE is_active`)).rows.map((x) => [x.code, x]));
  const purities = new Map((await c.query<{ k: string; id: string; huid_required: boolean }>(
    `SELECT metal_id || ':' || upper(code) AS k, id, huid_required FROM masters.purity`)).rows.map((x) => [x.k, x]));
  const tagNos = rows.map((r) => (r.tag_no ?? '').trim().toUpperCase()).filter(Boolean);
  const huids = rows.map((r) => (r.huid ?? '').trim().toUpperCase()).filter(Boolean);
  const existTag = new Set((await c.query<{ t: string }>(`SELECT upper(tag_no) AS t FROM inventory.tag WHERE upper(tag_no) = ANY($1)`, [tagNos])).rows.map((x) => x.t));
  const existHuid = new Set((await c.query<{ h: string }>(`SELECT huid AS h FROM inventory.tag WHERE huid = ANY($1)`, [huids])).rows.map((x) => x.h));
  const errors: RowErr[] = []; const ok: Tag[] = []; const seenTag = new Map<string, number>(); const seenHuid = new Map<string, number>();
  rows.forEach((r, i) => {
    const row = i + 2; const before = errors.length;
    const e = (column: string, code: string, message: string) => errors.push({ row, column, code, message, raw: r });
    const tag = (r.tag_no ?? '').trim().toUpperCase();
    if (!tag) e('tag_no', 'required', 'required'); else if (tag.length > 30) e('tag_no', 'invalid_format', 'max 30 characters');
    if (tag && seenTag.has(tag)) e('tag_no', 'duplicate_in_file', `duplicate of row ${seenTag.get(tag)}`);
    if (tag && existTag.has(tag)) e('tag_no', 'already_exists', 'tag already exists');
    if (tag) seenTag.set(tag, row);
    const item = items.get((r.item_code ?? '').trim().toUpperCase());
    if (!item) e('item_code', r.item_code ? 'not_found' : 'required', r.item_code ? 'unknown item code' : 'required');
    const pur = item ? purities.get(`${item.metal_id}:${(r.purity_code ?? '').trim().toUpperCase()}`) : undefined;
    if (item && !pur) e('purity_code', r.purity_code ? 'not_found' : 'required', 'purity not found for the item\'s metal');
    const w = (k: string, req: boolean) => { const v = (r[k] ?? '').trim(); if (!v) { if (req) e(k, 'required', 'required'); return '0'; } if (!WT.test(v)) e(k, 'invalid_format', 'grams, up to 3 decimals'); return v; };
    const gross = w('gross_wt', true); const stone = w('stone_wt', false); const net = w('net_wt', true);
    if (WT.test(gross) && WT.test(net) && dec(net) > dec(gross)) e('net_wt', 'invalid_format', 'net_wt cannot exceed gross_wt');
    const huid = (r.huid ?? '').trim().toUpperCase() || null;
    const exempt = /^(1|y|yes|true)$/i.test((r.hallmark_exempt ?? '').trim());
    if (huid && !/^[A-Z0-9]{6}$/.test(huid)) e('huid', 'invalid_format', '6 alphanumeric characters');
    if (huid && (seenHuid.has(huid) || existHuid.has(huid))) e('huid', seenHuid.has(huid) ? 'duplicate_in_file' : 'already_exists', 'HUID already used');
    if (huid) seenHuid.set(huid, row);
    if (!huid && !exempt && pur?.huid_required) e('huid', 'required', 'HUID required (or set hallmark_exempt)');
    const mcType = (r.mc_type ?? 'per_gram').trim() || 'per_gram';
    if (!['per_gram', 'percent', 'flat', 'per_piece'].includes(mcType)) e('mc_type', 'invalid_format', 'per_gram | percent | flat | per_piece');
    const mcValue = (r.mc_value ?? '').trim() || '0'; if (!AMT.test(mcValue)) e('mc_value', 'invalid_format', 'decimal, up to 2 places');
    const wastage = (r.wastage_pct ?? '').trim() || '0'; if (!/^\d{1,3}(\.\d{1,3})?$/.test(wastage)) e('wastage_pct', 'invalid_format', 'percent, up to 3 decimals');
    const pieces = (r.pieces ?? '').trim() || '1'; if (!/^[1-9]\d{0,4}$/.test(pieces)) e('pieces', 'invalid_format', 'whole number ≥ 1');
    const huidCharge = (r.huid_charge ?? '').trim() || item?.huid_charge || '0'; if (!AMT.test(huidCharge)) e('huid_charge', 'invalid_format', 'decimal, up to 2 places');
    if (errors.length === before && item && pur)
      ok.push({ tag_no: tag, item_id: item.id, purity_id: pur.id, gross_wt: gross, stone_wt: stone, net_wt: net, huid, hallmark_exempt: exempt,
        pieces: Number(pieces), mc_type: mcType, mc_value: mcValue, wastage_pct: wastage, huid_charge: huidCharge });
  });
  return { ok, errors };
}

/** Opening balances → accounts.account_head (insert, or set opening_* on an existing head of the same name). Dr = positive. */
export async function validateOpeningBalances(rows: Record<string, string>[]): Promise<{ ok: Head[]; errors: RowErr[] }> {
  const c = currentTx();
  const groups = new Map((await c.query<{ n: string; id: string }>(`SELECT lower(name) AS n, id FROM accounts.account_group`)).rows.map((x) => [x.n, x.id]));
  const metals = new Map((await c.query<{ code: string; id: string }>(`SELECT upper(code) AS code, id FROM masters.metal`)).rows.map((x) => [x.code, x.id]));
  const phones = rows.map((r) => normPhone(r.party_phone)).filter(Boolean);
  const customers = new Map((await c.query<{ phone: string; id: string }>(`SELECT phone, id FROM masters.customer WHERE phone = ANY($1)`, [phones])).rows.map((x) => [x.phone, x.id]));
  const errors: RowErr[] = []; const ok: Head[] = []; const seen = new Map<string, number>();
  rows.forEach((r, i) => {
    const row = i + 2; const before = errors.length;
    const e = (column: string, code: string, message: string) => errors.push({ row, column, code, message, raw: r });
    const name = (r.account_name ?? '').trim();
    if (!name) e('account_name', 'required', 'required');
    if (name && seen.has(name.toLowerCase())) e('account_name', 'duplicate_in_file', `duplicate of row ${seen.get(name.toLowerCase())}`);
    if (name) seen.set(name.toLowerCase(), row);
    const groupId = groups.get((r.account_group ?? '').trim().toLowerCase());
    if (!groupId) e('account_group', r.account_group ? 'not_found' : 'required', 'unknown account group');
    const kind = (r.kind ?? '').trim().toLowerCase();
    if (!HEAD_KINDS.includes(kind)) e('kind', kind ? 'invalid_format' : 'required', HEAD_KINDS.join(' | '));
    const phone = normPhone(r.party_phone);
    const customerId = phone ? customers.get(phone) ?? null : null;
    if (kind === 'customer' && !customerId) e('party_phone', phone ? 'not_found' : 'required', 'customer heads need the phone of an existing customer');
    const amt = (r.opening_amount ?? '').trim();
    if (!AMT.test(amt)) e('opening_amount', amt ? 'invalid_format' : 'required', 'rupees, up to 2 decimals (no sign; use dr_cr)');
    const drcr = (r.dr_cr ?? '').trim().toLowerCase();
    if (!['dr', 'cr'].includes(drcr)) e('dr_cr', drcr ? 'invalid_format' : 'required', 'dr | cr');
    const pure = (r.pure_wt ?? '').trim() || '0'; if (!WT.test(pure)) e('pure_wt', 'invalid_format', 'grams, up to 3 decimals');
    const metalCode = (r.metal_code ?? '').trim().toUpperCase();
    const metalId = metalCode ? metals.get(metalCode) ?? null : null;
    if (metalCode && !metalId) e('metal_code', 'not_found', 'unknown metal code');
    if (pure !== '0' && !metalId) e('metal_code', 'required', 'required when pure_wt is given');
    if (errors.length === before)
      ok.push({ name, group_id: groupId!, kind, customer_id: customerId, amount: drcr === 'cr' && amt !== '0' ? `-${amt}` : amt, pure_wt: pure, metal_id: metalId });
  });
  return { ok, errors };
}

const VALIDATORS: Record<Kind, (rows: Record<string, string>[]) => Promise<{ ok: unknown[]; errors: RowErr[] }>> = {
  customers: validateCustomers, stock: validateStock, opening_balances: validateOpeningBalances,
};

const JOB = `id, kind, branch_id, mapping_profile_id, mapping_snapshot, dry_run, dry_run_of, status, total_rows, ok_rows, error_rows, file_key, file_id, created_by, created_at, finished_at`;
const ROWERR = `row_no AS row, column_name AS column, code, message`;
async function view(job: Record<string, unknown>) {
  const errors = (await currentTx().query(`SELECT ${ROWERR} FROM platform.import_row_error WHERE import_job_id = $1 ORDER BY row_no, id LIMIT 500`, [job.id])).rows;
  const { file_key: _f, ...rest } = job;
  return { ...rest, errors };
}
async function saveRowErrors(jobId: string, errors: RowErr[]): Promise<void> {
  const c = currentTx();
  for (let i = 0; i < errors.length; i += 500) {
    const chunk = errors.slice(i, i + 500);
    await c.query(
      `INSERT INTO platform.import_row_error(tenant_id, import_job_id, row_no, column_name, code, message, raw)
       SELECT platform.current_tenant(), $1, x.row_no, x.column_name, x.code, x.message, x.raw
         FROM jsonb_to_recordset($2::jsonb) AS x(row_no int, column_name text, code text, message text, raw jsonb)`,
      [jobId, JSON.stringify(chunk.map((e) => ({ row_no: e.row, column_name: e.column ?? null, code: e.code, message: e.message, raw: e.raw ?? null })))]);
  }
}
async function loadProfile(id: string | null, kind: string): Promise<{ id: string; mapping: Record<string, string> } | null> {
  if (!id) return null;
  const p = (await currentTx().query<{ id: string; kind: string; mapping: Record<string, string> }>(
    `SELECT id, kind, mapping FROM platform.import_mapping_profile WHERE id = $1`, [id])).rows[0];
  if (!p) fail(422, 'mapping_profile_not_found');
  if (p!.kind !== kind) fail(422, 'mapping_profile_kind_mismatch');
  return p!;
}
function checkMapping(kind: string, mapping: Record<string, string>) {
  if (!isImportKind(kind)) fail(422, 'validation_failed', `kind ${kind} has no importer`);
  const bad = Object.keys(mapping).filter((k) => !templateOf(kind).includes(k));
  if (bad.length) fail(422, 'validation_failed', `unknown template columns for ${kind}: ${bad.join(', ')}`);
}
const PROFILE = `id, kind, name, mapping, options, version, created_by, created_at`;

interface MultipartFile { filename: string; fields: Record<string, { value?: unknown } | undefined>; toBuffer(): Promise<Buffer> }
interface MultipartReq extends JwRequest { isMultipart?: () => boolean; file?: (o?: unknown) => Promise<MultipartFile | undefined> }

@Controller('v1')
export class ImportController {
  constructor(@Inject(STORAGE) private readonly storage: StorageService) {}
  @Get('import-templates/:kind')
  template(@Param('kind') kind: string, @Res({ passthrough: true }) reply: { header(k: string, v: string): unknown }) {
    if (!isImportKind(kind)) fail(404, 'unknown_import_kind');
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="${kind}-template-v2.csv"`);
    return `${templateOf(kind).join(',')}\n`;
  }

  @Get('imports')
  async list() {
    return Promise.all((await currentTx().query(`SELECT ${JOB} FROM platform.import_job ORDER BY created_at DESC LIMIT 200`)).rows.map(view));
  }

  @Get('imports/:id')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    return view((await currentTx().query(`SELECT ${JOB} FROM platform.import_job WHERE id = $1`, [id])).rows[0] ?? fail(404, 'not_found'));
  }

  @Get('imports/:id/errors')
  async errors(@Param('id', ParseUUIDPipe) id: string, @Query('after_row') after?: string, @Query('limit') limit?: string) {
    const c = currentTx();
    if (!(await c.query(`SELECT 1 FROM platform.import_job WHERE id = $1`, [id])).rowCount) fail(404, 'not_found');
    const a = Math.max(0, Number(after ?? 0) | 0); const l = Math.min(500, Math.max(1, Number(limit ?? 100) | 0));
    return (await c.query(`SELECT ${ROWERR} FROM platform.import_row_error WHERE import_job_id = $1 AND row_no > $2 ORDER BY row_no, id LIMIT $3`, [id, a, l])).rows;
  }

  /** Upload + dry run (P21). Always a dry run; writes only the job row, its row errors and the stored file. */
  @Post('imports') @RequirePermission('platform.import.run')
  async create(@Ctx() req: MultipartReq) {
    if (!req.isMultipart?.() || !req.file) fail(415, 'multipart_required');
    let file: MultipartFile | undefined;
    try { file = await req.file!({ limits: { fileSize: MAX_BYTES, files: 1 } }); } catch { fail(413, 'file_too_large'); }
    if (!file) fail(422, 'file_required');
    let buf: Buffer;
    try { buf = await file!.toBuffer(); } catch { return fail(413, 'file_too_large', 'max 5 MB'); }
    const kind = String(file!.fields.kind?.value ?? '');
    const branchId = file!.fields.branch_id?.value ? String(file!.fields.branch_id.value) : null;
    const profileId = file!.fields.profile_id?.value ? String(file!.fields.profile_id.value) : null;
    if (!isImportKind(kind)) fail(422, 'validation_failed', 'kind');
    assertKindPerm(req, kind);
    if (branchId && !uuid.safeParse(branchId).success) fail(422, 'validation_failed', 'branch_id');
    if (profileId && !uuid.safeParse(profileId).success) fail(422, 'validation_failed', 'profile_id');
    if (kind === 'stock' && !branchId) fail(422, 'validation_failed', 'branch_id is required for stock');
    const profile = await loadProfile(profileId, kind);
    const rows = applyMapping(await readRows(buf!, file!.filename), profile?.mapping ?? null);
    if (rows.length > MAX_ROWS) fail(413, 'too_many_rows', `max ${MAX_ROWS} rows`);
    const missing = requiredOf(kind).filter((h) => !rows.length || !(h in rows[0]));
    if (missing.length) fail(422, 'template_mismatch', `header row must include: ${missing.join(', ')} (see /v1/import-templates/${kind})`);
    const c = currentTx();
    const tenant = req.auth?.tenantId ?? (await c.query<{ t: string }>(`SELECT platform.current_tenant()::text AS t`)).rows[0].t;
    const userId = req.auth?.userId ?? fail(401, 'unauthenticated');
    // 0.5.0: StorageService (local disk or S3/Garage); key `<tenant_id>/imports/<uuid>`, type kept as object metadata
    // 0.5.1 (974): platform.file row + import_job.file_id in this request tx; if anything after the object write fails, the object is removed
    const fileKey = objectKey(tenant, 'imports');
    const contentType = /\.xlsx$/i.test(file!.filename) ? XLSX_TYPE : 'text/csv';
    await this.storage.put(fileKey, buf!, contentType);
    try {
    const fileId = (await c.query<{ id: string }>(
      `INSERT INTO platform.file(tenant_id, area, object_key, original_name, content_type, size_bytes, sha256, created_by)
       VALUES (platform.current_tenant(), 'imports', $1, $2, $3, $4, $5, $6) RETURNING id`,
      [fileKey, originalName(file!.filename, contentType), contentType, buf!.length, sha256(buf!), userId])).rows[0].id;
    const { ok, errors } = await validatorOf(kind)(rows);
    // v1.5: the profile used is stored on the job (mapping_profile_id; FK enforces same tenant + same kind); commit re-applies it
    const r = await c.query<Record<string, unknown> & { id: string }>(
      `INSERT INTO platform.import_job(tenant_id, branch_id, kind, file_key, file_id, dry_run, status, total_rows, ok_rows, error_rows, created_by, mapping_profile_id, mapping_snapshot, started_at, finished_at)
       VALUES (platform.current_tenant(), $1, $2, $3, $11, true, $4, $5, $6, $7, $8, $9, $10::jsonb, now(), now()) RETURNING ${JOB}`,
      [branchId, kind, fileKey, errors.length ? 'failed' : 'validated', rows.length, ok.length, errors.length, userId, profile?.id ?? null,
       JSON.stringify(profile?.mapping ?? {}), fileId]);   // 970: the applied mapping, frozen
    await saveRowErrors(r.rows[0].id, errors);
    return await view(r.rows[0]);
    } catch (e) {
      await this.storage.delete(fileKey).catch(() => undefined);   // no orphaned object when the rows can't be written
      throw e;
    }
  }

  /** Commit a validated dry run: re-validates the same stored file and writes every row in this transaction (all or nothing). */
  @Post('imports/:id/commit') @RequirePermission('platform.import.run')
  async commit(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Headers('idempotency-key') key?: string,
               @Res({ passthrough: true }) reply?: { status(n: number): unknown }) {
    if (!key) return fail(400, 'idempotency_key_required');
    // Preserve this legacy endpoint's8-100 character range, separate from shared16-128.
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(key)) fail(422, 'idempotency_key_invalid');
    const c = currentTx();
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('import_commit:' || $1))`, [id]);
    const dry = (await c.query(`SELECT ${JOB} FROM platform.import_job WHERE id = $1`, [id])).rows[0] as Record<string, unknown> ?? fail(404, 'not_found');
    if (!dry.dry_run) fail(422, 'not_a_dry_run');
    const prior = (await c.query(`SELECT ${JOB} FROM platform.import_job WHERE dry_run_of = $1 AND status = 'completed'`, [id])).rows[0];
    if (prior) { reply?.status(200); return view(prior); }                     // replay → same result
    if (dry.status !== 'validated') fail(409, 'dry_run_not_clean', 'Fix the errors and upload again');
    const kind = String(dry.kind);
    assertKindPerm(req, kind);
    const fileKey = String(dry.file_key);
    // 970: ONLY the mapping frozen by the dry run; the profile is never re-read (later edits can't change this commit)
    const snapshot = (dry.mapping_snapshot as Record<string, string> | null) ?? fail(409, 'dry_run_outdated', 'dry run has no mapping snapshot; upload again');
    const obj = await this.storage.get(fileKey);
    if (!obj) fail(409, 'import_file_missing', 'the stored file of this dry run is gone; upload it again');
    const name = obj!.contentType === XLSX_TYPE || /\.xlsx$/i.test(fileKey) ? 'file.xlsx' : 'file.csv';
    const rows = applyMapping(await readRows(await readAll(obj!.body), name), Object.keys(snapshot).length ? snapshot : null);
    const { ok, errors } = await validatorOf(kind)(rows);
    if (errors.length) fail(409, 'data_changed', 'Rows no longer valid (e.g. a record was added since the dry run); run a new dry run');
    try {
      if (kind === 'customers') for (const r of ok as Cust[]) {
        const pan = r.pan ? seal(r.pan, 'masters.customer.pan') : null;
        await c.query(
          `INSERT INTO masters.customer(tenant_id, name, phone, email, gstin, state_code, dob, anniversary, address, home_branch_id, pan_enc, pan_key_id, pan_last4)
           VALUES (platform.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [r.name, r.phone, r.email, r.gstin, r.state_code, r.dob, r.anniversary, JSON.stringify(r.address), dry.branch_id,
           pan ? pan.box : null, pan ? pan.keyId : null, pan ? r.pan!.slice(-4) : null]);   // pan_enc/pan_key_id/pan_last4: all or none (CHECK)
      }
      if (kind === 'stock') {
        // 0.8.2: committed through Inventory (tags + 'opening' ledger rows); platform no longer writes inventory.tag itself
        const importer = stockImporterOf() ?? fail(503, 'inventory_unavailable', 'the inventory module is not loaded');
        await importer(ok as Tag[], { auth: req.auth!, branchId: dry.branch_id as string, sourceId: id });
      }
      if (!builtin(kind)) await importKind(kind)!.commit(ok, { userId: req.auth!.userId, branchId: (dry.branch_id as string | null) ?? null });
      if (kind === 'opening_balances') for (const h of ok as Head[]) {
        await c.query(
          `INSERT INTO accounts.account_head(tenant_id, group_id, name, kind, customer_id, opening_amount, opening_pure_wt, opening_metal_id)
           VALUES (platform.current_tenant(), $1, $2, $3, $4, $5::numeric, $6::numeric, $7)
           ON CONFLICT (tenant_id, name) DO UPDATE SET opening_amount = EXCLUDED.opening_amount,
             opening_pure_wt = EXCLUDED.opening_pure_wt, opening_metal_id = EXCLUDED.opening_metal_id`,
          [h.group_id, h.name, h.kind, h.customer_id, h.amount, h.pure_wt, h.metal_id]);
      }
    } catch (e) { return pgProblem(e); }
    const job = (await c.query(
      `INSERT INTO platform.import_job(tenant_id, branch_id, kind, file_key, file_id, dry_run, dry_run_of, status, total_rows, ok_rows, error_rows, created_by, mapping_profile_id, mapping_snapshot, started_at, finished_at)
       VALUES (platform.current_tenant(), $1, $2, $3, $9, false, $4, 'completed', $5, $5, 0, $6, $7, $8::jsonb, now(), now()) RETURNING ${JOB}`,
      [dry.branch_id, dry.kind, dry.file_key, id, ok.length, req.auth!.userId, dry.mapping_profile_id ?? null, JSON.stringify(snapshot), dry.file_id ?? null])).rows[0] as { id: string };
    await audit('import.completed', 'platform.import_job', job.id, { kind: dry.kind, rows: ok.length, idempotency_key: key });
    reply?.status(201);
    return view(job);
  }

  // ---------- mapping profiles (platform.import_mapping_profile; hidden in partner context by RLS) ----------
  @Get('import-mapping-profiles')
  async profiles(@Query('kind') kind?: string) {
    if (kind && !isImportKind(kind)) fail(422, 'validation_failed', 'kind');
    return (await currentTx().query(`SELECT ${PROFILE} FROM platform.import_mapping_profile WHERE ($1::text IS NULL OR kind = $1) ORDER BY kind, name`, [kind ?? null])).rows;
  }

  @Get('import-mapping-profiles/:id')
  async profile(@Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) reply: { header(k: string, v: string): unknown }) {
    const p = (await currentTx().query<{ version: number }>(`SELECT ${PROFILE} FROM platform.import_mapping_profile WHERE id = $1`, [id])).rows[0] ?? fail(404, 'not_found');
    reply.header('ETag', etag(p.version));
    return p;
  }

  @Post('import-mapping-profiles') @RequirePermission('platform.import.run')
  async createProfile(@Ctx() req: JwRequest, @Body() body: unknown, @Res({ passthrough: true }) reply: { status(n: number): unknown; header(k: string, v: string): unknown }) {
    const b = parse(MappingProfileBody, body);
    checkMapping(b.kind, b.mapping);
    try {
      const p = (await currentTx().query<{ version: number }>(
        `INSERT INTO platform.import_mapping_profile(tenant_id, kind, name, mapping, options, created_by)
         VALUES (platform.current_tenant(), $1, $2, $3::jsonb, $4::jsonb, $5) RETURNING ${PROFILE}`,
        [b.kind, b.name, JSON.stringify(b.mapping), JSON.stringify(b.options ?? {}), req.auth!.userId])).rows[0];
      reply.status(201); reply.header('ETag', etag(p.version));
      return p;
    } catch (e) { return pgProblem(e); }
  }

  @Patch('import-mapping-profiles/:id') @RequirePermission('platform.import.run')
  async updateProfile(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Res({ passthrough: true }) reply: { header(k: string, v: string): unknown }) {
    const ver = ifMatch(req)!;
    const b = parse(MappingProfilePatch, body);
    const c = currentTx();
    if (b.mapping) {
      const k = (await c.query<{ kind: string }>(`SELECT kind FROM platform.import_mapping_profile WHERE id = $1`, [id])).rows[0] ?? fail(404, 'not_found');
      checkMapping(k.kind, b.mapping);
    }
    let p: { version: number } | undefined;
    try {
      p = (await c.query<{ version: number }>(
        `UPDATE platform.import_mapping_profile SET name = coalesce($3, name), mapping = coalesce($4::jsonb, mapping), options = coalesce($5::jsonb, options)
          WHERE id = $1 AND version = $2 RETURNING ${PROFILE}`,
        [id, ver, b.name ?? null, b.mapping ? JSON.stringify(b.mapping) : null, b.options ? JSON.stringify(b.options) : null])).rows[0];
    } catch (e) { return pgProblem(e); }
    if (!p) return staleOr404(async () => ((await c.query(`SELECT 1 FROM platform.import_mapping_profile WHERE id = $1`, [id])).rowCount ?? 0) > 0);
    reply.header('ETag', etag(p.version));
    return p;
  }

  @Delete('import-mapping-profiles/:id') @HttpCode(204) @RequirePermission('platform.import.run')
  async deleteProfile(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string) {
    const ver = ifMatch(req)!;
    const c = currentTx();
    let r: { rowCount: number | null };
    try { r = await c.query(`DELETE FROM platform.import_mapping_profile WHERE id = $1 AND version = $2`, [id, ver]); }
    catch (e) {
      if ((e as { code?: string }).code === '23503') fail(409, 'mapping_profile_in_use', 'Used by an import job; it cannot be deleted');
      throw e;
    }
    if (!r.rowCount) await staleOr404(async () => ((await c.query(`SELECT 1 FROM platform.import_mapping_profile WHERE id = $1`, [id])).rowCount ?? 0) > 0);
  }
}
