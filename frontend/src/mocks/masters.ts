/**
 * MSW mock of the Masters endpoints of contract 0.7.0 that are NOT live yet (x-backing: awaiting 976).
 * Mirrors: keyset paging {items, next_cursor}, q / include_inactive / filters, 201 + ETag, If-Match (428 missing,
 * 412 stale), 409 duplicate code, 422 field errors, PAN / KYC numbers write-only (rows carry *_last4 only), the audited
 * KYC reveal (10/hour → 429), POST /v1/files + design photo attach / reorder / remove, vendor PAN backfill status, M17 export + signed file URL. `setMastersNotLive()` makes kinds answer 404 like today's server.
 * All data fictional.
 */
import { http, HttpResponse, type JsonBodyType } from 'msw';
import { getPath, MASTERS, normaliseInput, validateInput } from '@/features/masters/registry';
import { last4 } from '@/features/masters/mask';
import { MASTER_KINDS, type MasterInput, type MasterKind, type MasterRow } from '@/features/masters/types';

const A = '*/api';
let n = 0;
const nid = () => `01930000-0000-7000-8000-${String(++n).padStart(12, '0')}`;
const now = () => new Date().toISOString();
type Stored = MasterRow & { secrets?: Record<string, string | null> };
interface StoredFile { id: string; type: string; data: string; purpose?: string }
interface StoredPhoto { id: string; design_id: string; file_id: string; caption: string | null; is_primary: boolean; sort_order: number; version: number }
interface MState { rows: Record<MasterKind, Stored[]>; files: StoredFile[]; photos: StoredPhoto[]; reveals: string[]; reveals429: number; backfillDone: boolean; exports: unknown[]; idem: Map<string, { body: string; row: Stored }>; notLive: Set<MasterKind | 'exports'> }
let S: MState;

const row = (_kind: MasterKind, v: Record<string, unknown>): Stored =>
  ({ id: nid(), version: 1, is_active: true, created_at: now(), ...v } as Stored);

export function resetMastersMock() {
  n = 0;
  const branch = '01930000-0000-7000-8000-00000000b001';
  const gold = '01930000-0000-7000-8000-0000000000m1';
  const k22 = '01930000-0000-7000-8000-0000000000p1';
  const ring = row('items', { code: 'RING', name: 'Ring', metal_id: gold, purity_id: k22, hsn: '7113', stock_type: 'tag', mc_type: 'per_gram', mc_value: '450.00', wastage_type: 'percent', wastage_value: '12.000', allow_zero_weight: false });
  const chain = row('items', { code: 'CHAIN', name: 'Chain', metal_id: gold, purity_id: k22, hsn: '7113', stock_type: 'tag', allow_zero_weight: false });
  const counter = row('counters', { branch_id: branch, floor_id: null, code: 'C1', name: 'Front counter' });
  S = {
    files: [], photos: [], reveals: [], reveals429: 0, backfillDone: false, exports: [], idem: new Map(), notLive: new Set(),
    rows: {
      items: [ring, chain],
      designs: [row('designs', { item_id: chain.id, code: 'CH-101', name: 'Lakshmi coin chain', sub_item_id: null, purity_id: null, designer_id: null, description: null, approx_gross_wt: null, approx_net_wt: null, approx_stone_wt: null, size: null, tags: [], primary_photo_file_id: null })],
      stone_standards: [row('stone_standards', { kind: 'cent_group', code: 'C10-20', name: '10–20 cents', cent_from: '0.100', cent_to: '0.200' }), row('stone_standards', { kind: 'shape', code: 'RD', name: 'Round' }), row('stone_standards', { kind: 'stone', code: 'RUBY', name: 'Ruby' })],
      stone_rates: [],
      value_addition_rules: [row('value_addition_rules', { scope: 'customer', item_id: ring.id, weight_from: '0.000', weight_to: '5.000', wastage_pct: '12.00', mc_per_gram: '450.00', purity_id: null, sub_item_id: null, effective_from: null, effective_to: null, priority: 0 })],
      customers: [row('customers', { name: 'Demo Customer', phone: '9000000002', address: { city: 'Coimbatore' }, pan_last4: '234F', consent_at: now(), group_id: null, kyc_status: 'none', secrets: { pan: 'ABCDE1234F' } })],
      vendors: [row('vendors', { code: 'KAR01', name: 'Demo Karigar Works', kinds: ['smith'], gstin: null, pan: null })],
      staff: [row('staff', { code: 'S01', name: 'Demo Salesperson', phone: null, branch_id: branch, pan_last4: null, department: null, designation: null, is_salesperson: true, photo_file_id: null })],
      floors: [row('floors', { branch_id: branch, code: 'GF', name: 'Ground floor' })],
      counters: [counter],
      trays: [row('trays', { counter_id: counter.id, code: 'T1', name: null, tare_weight: '120.000', sub_item_id: null })],
      hsn_codes: [row('hsn_codes', { code_type: 'HSN', code: '7113', description: 'Jewellery of precious metal', uqc: 'GMS' })],
      payment_modes: (['cash', 'upi', 'debit_card', 'cheque', 'old_gold'] as const).map((kind, i) =>
        row('payment_modes', { code: kind.toUpperCase(), name: kind.replace('_', ' ').replace(/^./, (c) => c.toUpperCase()), kind, requires_reference: kind !== 'cash', requires_card_machine: kind === 'debit_card', account_head_id: null, sort_order: i })),
      card_machines: [],
      sub_items: [row('sub_items', { item_id: ring.id, code: 'RING-S', name: 'Stone ring', hsn: null, measurement: 'gram', mc_type: null, mc_value: null, wastage_value: null, huid_charge: null })],
      kyc_documents: [],
    },
  };
}
resetMastersMock();
/** Make kinds answer 404 (contract: not routed until migration 976). Pass nothing to make all live again. */
export function setMastersNotLive(kinds: Array<MasterKind | 'exports'> = []) { S.notLive = new Set(kinds); }

const problem = (status: number, code: string, title: string, errors: Array<{ path: string; message: string }> = []) =>
  HttpResponse.json({ type: 'about:blank', status, code, title, errors } as JsonBodyType, { status, headers: { 'Content-Type': 'application/problem+json' } });
const json = (b: unknown, status = 200, etag?: number) => HttpResponse.json(b as JsonBodyType, { status, headers: etag ? { ETag: `"${etag}"` } : {} });
/** PAN never leaves the server: rows carry pan_last4 only. */
const pub = (r: Stored): MasterRow => { const { secrets: _s, ...rest } = r; return rest as MasterRow; };
const version = (req: Request) => { const m = /^"?(\d+)"?$/.exec(req.headers.get('If-Match') ?? ''); return m ? Number(m[1]) : null; };
const b64 = (bytes: Uint8Array) => { let bin = ''; bytes.forEach((b) => { bin += String.fromCharCode(b); }); return btoa(bin); };
const slug = (k: string) => k.replace(/_/g, '-');
const flatten = (o: Record<string, unknown>, pre = ''): MasterInput => Object.fromEntries(Object.entries(o).flatMap(([k, v]) =>
  v && typeof v === 'object' && !Array.isArray(v) ? Object.entries(flatten(v as Record<string, unknown>, `${pre}${k}.`)) : [[`${pre}${k}`, v as MasterInput[string]]]));
const toStr = (v: unknown) => (typeof v === 'number' ? String(v) : v) as MasterInput[string];

function write(kind: MasterKind, r: Stored, body: Record<string, unknown>) {
  const cfg = MASTERS[kind];
  for (const [k, v] of Object.entries(body)) {
    if (k === 'is_active') { r.is_active = v === true; continue; }
    // G18 (0.7.3): kyc_consent is write-only; the server sets/clears consent_at.
    if (kind === 'customers' && k === 'kyc_consent') { if (v === true && !r.consent_at) r.consent_at = new Date().toISOString(); if (v === false) r.consent_at = null; continue; }
    const f = cfg.fields.find((x) => x.key === k || x.key.startsWith(`${k}.`));
    if (!f) continue;
    if (f.type === 'secret') { r.secrets = { ...r.secrets, [k]: typeof v === 'string' ? v : null }; r[f.last4Key ?? `${k}_last4`] = typeof v === 'string' ? last4(v) : null; continue; }
    r[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...(r[k] as object | undefined), ...v } : v;
  }
  r.version += 1;
}

function check(kind: MasterKind, body: Record<string, unknown>, partial: boolean, self?: Stored) {
  const cfg = MASTERS[kind];
  const flat = Object.fromEntries(Object.entries(flatten(body)).map(([k, v]) => [k, toStr(v)]));
  // consent_at / group_id are not client-writable (consent_at is readOnly; group_id is deprecated, M9 deferred).
  for (const k of ['consent_at', 'group_id']) if (kind === 'customers' && k in body) return problem(422, 'validation_failed', `${k} is not writable`, [{ path: `/${k}`, message: 'not allowed' }]);
  const errs = validateInput(cfg, normaliseInput(cfg, flat), partial);
  if (Object.keys(errs).length) return problem(422, 'validation_failed', 'Check the highlighted fields', Object.entries(errs).map(([k, c]) => ({ path: `/${k.replace(/\./g, '/')}`, message: c })));
  const code = body.code;
  if (typeof code === 'string' && S.rows[kind].some((x) => x !== self && x.code === code)) return problem(409, 'duplicate_code', 'That code is already used');
  return null;
}

/** 0.7.1 list rows carry labels {<ref field>: {code, name}} for refs to other masters (not on single reads). */
function withLabels(kind: MasterKind, r: MasterRow): MasterRow {
  const labels: Record<string, { code: string | null; name: string }> = {};
  for (const f of MASTERS[kind].fields) {
    if (f.type !== 'ref' || !f.ref) continue;
    const target = f.ref.split(':')[0] as MasterKind;
    if (!(target in S.rows)) continue;
    const ref = S.rows[target].find((x) => x.id === getPath(r, f.key));
    if (ref) labels[f.key] = { code: (ref.code as string | undefined) ?? null, name: String(ref.name ?? ref.code ?? '') };
  }
  return { ...r, labels };
}
/** Referenced masters must exist (422 unknown_reference) and be active (422 inactive_master), with the field path. */
function refCheck(kind: MasterKind, body: Record<string, unknown>, create = false) {
  if (create && kind === 'stone_rates' && !body.stone_id && !body.cent_group_id) return problem(422, 'stone_or_cent_group_required', 'stone_id or cent_group_id', [{ path: 'stone_id', message: 'required' }]);
  for (const f of MASTERS[kind].fields) {
    if (f.type !== 'ref' || !f.ref || typeof body[f.key] !== 'string') continue;
    const target = f.ref.split(':')[0] as MasterKind;
    if (!(target in S.rows)) continue;
    const ref = S.rows[target].find((x) => x.id === body[f.key]);
    if (!ref) return problem(422, 'unknown_reference', `${f.key}: not found`, [{ path: f.key, message: 'not found' }]);
    if (!ref.is_active) return kind === 'card_machines' && f.key === 'cash_counter_id'
      ? problem(422, 'inactive_master', 'Cash counter is deactivated')
      : problem(422, 'inactive_master', `${f.key}: inactive`, [{ path: f.key, message: 'inactive' }]);
  }
  return null;
}

function list(kind: MasterKind, url: URL) {
  const sp = url.searchParams;
  const q = (sp.get('q') ?? '').trim().toLowerCase();
  const limit = Number(sp.get('limit') ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) return problem(422, 'validation_failed', 'limit must be 1–200', [{ path: 'limit', message: '1–200' }]);
  // ids (0.7.3): ids=a,b,c or repeated ids=a&ids=b — both accepted (the generated client repeats).
  const ids = sp.has('ids') ? sp.getAll('ids').flatMap((v) => v.split(',')).filter(Boolean) : undefined;
  if (ids && (ids.length < 1 || ids.length > 100)) return problem(422, 'validation_failed', 'ids: 1–100', [{ path: 'ids', message: '1–100' }]);
  const start = Number(sp.get('cursor') ?? 0);
  const filters = [...sp.entries()].filter(([k]) => !['q', 'limit', 'cursor', 'include_inactive', 'ids'].includes(k));
  const all = S.rows[kind].filter((r) => (!ids || ids.includes(r.id)) && (sp.get('include_inactive') === 'true' || r.is_active)
    && (!q || ['name', 'code', 'phone', 'description'].some((k) => String(r[k] ?? '').toLowerCase().startsWith(q)))
    && filters.every(([k, v]) => { const cur = r[k === 'kind' && kind === 'vendors' ? 'kinds' : k]; return Array.isArray(cur) ? cur.includes(v) : cur === v; }));
  const page = all.slice(start, start + limit);
  return { items: page.map((r) => withLabels(kind, pub(r))), next_cursor: start + limit < all.length ? String(start + limit) : null };
}

const kindHandlers = MASTER_KINDS.flatMap((kind) => {
  const base = `${A}/v1/masters/${slug(kind)}`;
  const gone = () => (S.notLive.has(kind) ? problem(404, 'not_found', 'Not routed yet') : null);
  const find = (id: unknown) => S.rows[kind].find((r) => r.id === id);
  return [
    http.get(base, ({ request }) => { const g = gone(); if (g) return g; const l = list(kind, new URL(request.url)); return l instanceof Response ? l : json(l); }),
    http.post(base, async ({ request }) => {
      const g = gone(); if (g) return g;
      const body = await request.json() as Record<string, unknown>;
      const key = request.headers.get('Idempotency-Key');
      const prior = key ? S.idem.get(`${kind}|${key}`) : undefined;
      if (prior) return prior.body === JSON.stringify(body) ? json(pub(prior.row), 201, prior.row.version) : problem(422, 'idempotency_key_reused', 'Key reused with a different body');
      if (!key) return problem(422, 'idempotency_key_required', 'Idempotency-Key header required');
      const bad = check(kind, body, false) ?? refCheck(kind, body, true); if (bad) return bad;
      const r = row(kind, {}); r.version = 0; write(kind, r, body);
      if (kind === 'designs') r.primary_photo_file_id = null;
      if (kind === 'kyc_documents') Object.assign(r, { status: r.status ?? 'pending', verified_at: null, verified_by: null });
      S.rows[kind].push(r);
      if (key) S.idem.set(`${kind}|${key}`, { body: JSON.stringify(body), row: r });
      return json(pub(r), 201, r.version);
    }),
    http.get(`${base}/:id`, ({ params }) => { const g = gone(); if (g) return g; const r = find(params.id); return r ? json(pub(r), 200, r.version) : problem(404, 'not_found', 'Not found'); }),
    http.patch(`${base}/:id`, async ({ request, params }) => {
      const g = gone(); if (g) return g;
      const r = find(params.id); if (!r) return problem(404, 'not_found', 'Not found');
      const v = version(request);
      if (v === null) return problem(428, 'precondition_required', 'If-Match required');
      if (v !== r.version) return problem(412, 'version_mismatch', 'Someone else saved this first');
      const body = await request.json() as Record<string, unknown>;
      // SubItemPatch is strict: a sub-item never moves to another item.
      if (kind === 'sub_items' && 'item_id' in body) return problem(422, 'validation_failed', 'item_id cannot change', [{ path: 'item_id', message: 'not allowed' }]);
      const bad = check(kind, body, true, r) ?? refCheck(kind, body); if (bad) return bad;
      write(kind, r, body);
      return json(pub(r), 200, r.version);
    }),
  ];
});

const guardDesign = (request: Request, id: unknown) => {
  if (S.notLive.has('designs')) return { err: problem(404, 'not_found', 'Not routed yet') };
  const d = S.rows.designs.find((r) => r.id === id); if (!d) return { err: problem(404, 'not_found', 'Not found') };
  const v = version(request);
  if (v === null) return { err: problem(428, 'precondition_required', 'If-Match required') };
  if (v !== d.version) return { err: problem(412, 'version_mismatch', 'Someone else saved this first') };
  return { d };
};

const photosOf = (designId: string) => S.photos.filter((p) => p.design_id === designId).sort((a, b) => a.sort_order - b.sort_order);
/** 0.7.1 design rows carry primary_photo_file_id (the cover; list thumbnails use it). */
const syncDesign = (d: Stored) => { const ps = photosOf(d.id); d.primary_photo_file_id = (ps.find((p) => p.is_primary) ?? ps[0])?.file_id ?? null; };
/** Test hooks: reveals logged (reasons only) and the vendor backfill flag. */
/** Read-only rows for other mocks (Sales snapshots of customers / staff / items). */
export const mastersRows = (k: MasterKind): readonly MasterRow[] => S.rows[k];
export const mastersMockState = { reveals: () => [...S.reveals], setBackfillDone: (v: boolean) => { S.backfillDone = v; } };

export const mastersHandlers = [
  // Before the kind routes, or GET /vendors/:id would swallow it.
  http.get(`${A}/v1/masters/vendors/pan-backfill-status`, () => {
    const total = S.rows.vendors.length;
    const withPan = S.rows.vendors.filter((v) => v.pan).length;
    return json({ total, legacy_only: 0, encrypted_only: 0, matched: withPan, mismatched: 0, ready_to_drop_legacy: S.backfillDone });
  }),
  ...kindHandlers,
  http.post(`${A}/v1/files`, async ({ request }) => {
    let type = 'image/png'; let data = ''; let purpose = 'design_photo';
    try {
      const fd = await request.formData();
      purpose = String(fd.get('purpose') ?? purpose);
      const f = fd.get('file');
      if (f && typeof f === 'object') {
        type = f.type;
        const okTypes = ['image/jpeg', 'image/png', 'image/webp', ...(purpose === 'kyc_document' ? ['application/pdf'] : [])];
        if (!okTypes.includes(type)) return problem(415, 'unsupported_media_type', 'Use a JPEG, PNG or WebP file');
        if (f.size > 5 * 1024 * 1024) return problem(413, 'too_large', 'File is over 5 MB');
        data = b64(new Uint8Array(await f.arrayBuffer()));
      }
    } catch { /* test realms without multipart parsing: keep an empty placeholder */ }
    const file = { id: nid(), type, data, purpose }; S.files.push(file);
    return json({ id: file.id, purpose, content_type: type, size_bytes: data.length, created_at: now() }, 201);
  }),
  http.get(`${A}/v1/masters/designs/:id/photos`, ({ params }) => {
    if (S.notLive.has('designs')) return problem(404, 'not_found', 'Not routed yet');
    return json(photosOf(String(params.id)));
  }),
  http.post(`${A}/v1/masters/designs/:id/photos`, async ({ request, params }) => {
    if (S.notLive.has('designs')) return problem(404, 'not_found', 'Not routed yet');
    const d = S.rows.designs.find((r) => r.id === params.id); if (!d) return problem(404, 'not_found', 'Not found');
    const b = await request.json() as { file_id: string; caption?: string | null; is_primary?: boolean; sort_order?: number };
    const mine = photosOf(d.id);
    if (mine.length >= 8) return problem(422, 'too_many_photos', 'A design can have up to 8 photos');
    if (!S.files.some((f) => f.id === b.file_id)) return problem(422, 'validation_failed', 'Unknown file', [{ path: '/file_id', message: 'unknown file' }]);
    if (b.is_primary) mine.forEach((p) => { p.is_primary = false; });
    const p: StoredPhoto = { id: nid(), design_id: d.id, file_id: b.file_id, caption: b.caption ?? null, is_primary: b.is_primary ?? !mine.length, sort_order: b.sort_order ?? mine.length, version: 1 };
    S.photos.push(p); syncDesign(d);
    return json(p, 201, p.version);
  }),
  http.patch(`${A}/v1/masters/designs/:id/photos`, async ({ request, params }) => {
    const { d, err } = guardDesign(request, params.id); if (err) return err;
    const b = await request.json() as { order: string[]; cover_file_id?: string | null };
    const mine = photosOf(d.id);
    const ids = mine.map((p) => p.file_id);
    if (b.order.length !== ids.length || new Set(b.order).size !== ids.length || !b.order.every((x) => ids.includes(x))) {
      return problem(422, 'photo_set_mismatch', 'List every photo exactly once');
    }
    b.order.forEach((fid, i) => { const p = mine.find((x) => x.file_id === fid) as StoredPhoto; p.sort_order = i; p.version += 1; });
    if (b.cover_file_id) mine.forEach((p) => { p.is_primary = p.file_id === b.cover_file_id; });
    syncDesign(d); d.version += 1;
    return json({ design_id: d.id, design_version: d.version, photos: photosOf(d.id) }, 200, d.version);
  }),
  http.delete(`${A}/v1/masters/designs/:id/photos/:photoId`, ({ request, params }) => {
    const p = S.photos.find((x) => x.design_id === params.id && x.id === params.photoId); if (!p) return problem(404, 'not_found', 'Not found');
    const v = version(request);
    if (v === null) return problem(428, 'precondition_required', 'If-Match required');
    if (v !== p.version) return problem(412, 'version_mismatch', 'Someone else saved this first');
    S.photos = S.photos.filter((x) => x !== p);
    const rest = photosOf(p.design_id);
    if (p.is_primary && rest[0]) rest[0].is_primary = true;
    const d = S.rows.designs.find((r) => r.id === p.design_id); if (d) syncDesign(d);
    return new HttpResponse(null, { status: 204 });
  }),
  ...(['customers', 'vendors', 'staff'] as const).map((party) => http.post(`${A}/v1/masters/${party}/:id/kyc/reveal`, async ({ request, params }) => {
    const r = S.rows[party].find((x) => x.id === params.id); if (!r) return problem(404, 'not_found', 'Not found');
    const b = await request.json() as { reason?: string };
    const reason = (b.reason ?? '').trim();
    if (reason.length < 10 || reason.length > 500) return problem(422, 'validation_failed', 'Give a reason', [{ path: '/reason', message: 'Between 10 and 500 characters' }]);
    if (S.reveals.length >= 10) {
      S.reveals429 += 1;
      return HttpResponse.json({ type: 'about:blank', status: 429, code: 'rate_limited', title: 'Too many reveals' } as JsonBodyType, { status: 429, headers: { 'Content-Type': 'application/problem+json', 'Retry-After': '60' } });
    }
    S.reveals.push(reason);
    const partyType = party === 'customers' ? 'customer' : party === 'vendors' ? 'vendor' : 'staff';
    const documents = S.rows.kyc_documents.filter((k) => k.party_type === partyType && k.party_id === r.id)
      .map((k) => ({ id: k.id, doc_type: k.doc_type, number: k.secrets?.number ?? null }));
    // 0.7.3: a vendor with a legacy pan but no sealed pan_enc (backfill pending) returns the masked legacy value.
    const legacy = party === 'vendors' ? (r.pan as string | null) ?? null : null;
    const panNotMigrated = party === 'vendors' && !!legacy && !S.backfillDone;
    const pan = party === 'vendors' ? (panNotMigrated ? `XXXXXX${(legacy ?? '').slice(-4)}` : legacy) : r.secrets?.pan ?? null;
    return HttpResponse.json({ party_type: partyType, id: r.id, pan, pan_not_migrated: panNotMigrated, documents } as JsonBodyType, { headers: { 'Cache-Control': 'no-store' } });
  })),
  http.post(`${A}/v1/exports`, async ({ request }) => {
    if (S.notLive.has('exports')) return problem(404, 'not_found', 'Not routed yet');
    const b = await request.json() as { kind: string; format?: 'csv' | 'xlsx'; include_inactive?: boolean };
    const kind = MASTER_KINDS.find((k) => k === b.kind);
    const cols = kind ? MASTERS[kind].fields.map((f) => f.key) : ['code', 'name'];
    const rows = kind ? S.rows[kind].filter((r) => b.include_inactive || r.is_active) : [];
    // PAN is never exported in full (last 4 only).
    const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => (c === 'pan' && kind !== 'vendors' ? String(r.pan_last4 ?? '') : String(getPath(pub(r), c) ?? ''))).join(','))].join('\n');
    const file = { id: nid(), type: 'text/csv', data: b64(new TextEncoder().encode(csv)) }; S.files.push(file);
    const job = { id: nid(), kind: b.kind, format: b.format ?? 'csv', status: 'done', row_count: rows.length, file_id: file.id, created_at: now() };
    S.exports.unshift(job);
    return json(job, 201);
  }),
  http.get(`${A}/v1/exports/:id`, ({ params }) => { const j = S.exports.find((x) => (x as { id: string }).id === params.id); return j ? json(j) : problem(404, 'not_found', 'Not found'); }),
  http.get(`${A}/v1/files/:id/url`, ({ params }) => {
    const f = S.files.find((x) => x.id === params.id); if (!f) return problem(404, 'not_found', 'Not found');
    return json({ url: `data:${f.type};base64,${f.data}`, expires_at: new Date(Date.now() + 5 * 60_000).toISOString() });
  }),
];

/** Import template header (required columns end with *), for the generic M17 importer mock. */
export function masterTemplate(kind: string): string | undefined {
  const k = MASTER_KINDS.find((x) => x === kind);
  if (k) return MASTERS[k].fields.map((f) => `${f.key}${f.required ? '*' : ''}`).join(',');
  if (kind === 'metals') return 'code*,name*';
  if (kind === 'purities') return 'metal_code*,code*,name*,fineness*';
  return undefined;
}
