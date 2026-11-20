import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { withTenantTx } from '@jw/db';
import * as inv from '@jw/mod-inventory';
import { pool, url } from './env';
import { ContractRecorder, AJV_VERSION, AJV_FORMATS_VERSION, oas, formatOk, isRfc3339DateTime, type Res } from './contract';

/**
 * 0.8.8 (0.8.9: + print fields on Tag, required always-sent fields): every Inventory operation in contracts/openapi.yaml, called over HTTP (app.inject) on real test-DB data, and every response body
 * (2xx and problem+json errors) validated against the documented schema for its status code (Ajv 2020-12). Also fails on any Inventory
 * operation that never returned a 2xx here, and on undocumented properties in a response.
 */
process.env.DATABASE_URL = url('app_rw');
process.env.ADMIN_DATABASE_URL = url('app_admin');
process.env.SESSION_SECRET = 'test-secret-0123456789abcdef0123456789';
process.env.COOKIE_INSECURE = '1';
process.env.FILE_STORE_DIR = `/tmp/jw-files-ic-${process.pid}`;
process.env.FILE_TOKEN_SECRET = 'test-file-token-secret-0123456789abcdef';

type App = Awaited<ReturnType<typeof import('@jw/api').createApp>>;
let app: App;
const mig = pool('app_migrator');
const rw = pool('app_rw');
const rec = new ContractRecorder();
const REPORT = process.env.CONTRACT_REPORT ?? `/tmp/jw-inventory-contract-${process.pid}.json`;

const raw = (method: string, path: string, o: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Res> =>
  app.inject({ method: method as 'GET', url: `/api${path}`, payload: o.body as object,
    headers: { ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.headers ?? {}) } }) as unknown as Promise<Res>;
const cookieOf = (r: Res, name = 'sid') => {
  const c = ([] as string[]).concat((r.headers['set-cookie'] as string | string[]) ?? []).find((x) => x.startsWith(`${name}=`));
  return c ? c.split(';')[0] : '';
};
let keyN = 0;
const key = () => ({ 'idempotency-key': `ic-${process.pid}-${++keyN}-${Date.now()}` });
const im = (v: number) => ({ 'if-match': `"${v}"` });
interface Go { cookie?: string; body?: unknown; headers?: Record<string, string>; q?: Record<string, string>; p?: Record<string, string>; status?: number | number[] }
let owner = '';
/** Calls a contract operation (templated path + params), validates the response against the contract, checks the expected status. */
async function go(method: string, template: string, o: Go = {}): Promise<Res> {
  let path = template.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(o.p?.[k] ?? `{${k}}`));
  if (o.q) path += `?${new URLSearchParams(o.q).toString()}`;
  const r = await raw(method, path, { cookie: o.cookie ?? owner, body: o.body, headers: o.headers });
  rec.check(method, template, r);
  const want = ([] as number[]).concat(o.status ?? (method === 'POST' ? [200, 201] : method === 'DELETE' ? [204] : [200]));
  expect(want, `${method} ${path} → ${r.statusCode} ${r.body.slice(0, 400)}`).toContain(r.statusCode);
  return r;
}
async function asMigrator<T>(tenantId: string, sql: string, params: unknown[] = []) {
  const c = await mig.connect();
  try {
    await c.query('BEGIN'); await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    const r = await c.query(sql, params); await c.query('COMMIT'); return r.rows as T[];
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`ic-photo-${Date.now()}`)]);
async function uploadPhoto(cookie: string): Promise<string> {
  const B = '----jwic';
  const body = Buffer.concat([Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\ntag_photo\r\n`),
    Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="file"; filename="p.png"\r\nContent-Type: application/octet-stream\r\n\r\n`), PNG, Buffer.from(`\r\n--${B}--\r\n`)]);
  const r = await app.inject({ method: 'POST', url: '/api/v1/files', payload: body, headers: { 'content-type': `multipart/form-data; boundary=${B}`, cookie } }) as unknown as Res;
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
}

/**
 * Known contract deviations, deferred by the lead (each has a next-batch item). Listed here so they stay visible; remove the entry with the fix.
 * - labels 409 already_printed: the contract says 422 reprint_required (next-batch-after-0.8.7 item 1; status codes unchanged in 0.8.8).
 */
const KNOWN = [{ op: 'POST /v1/inventory/labels', status: 409 }];

const SLUG = `invc-${Date.now() % 100000}`;
let tenantId = ''; let cashier = ''; let B1 = ''; let B2 = ''; let B3 = '';
const id: Record<string, string> = {};
/** Service-layer status change of another module's flow (sale, vendor return, melt) — no HTTP endpoint in Inventory. */
const flow = (tagId: string, to: Parameters<typeof inv.transitionTag>[1], via: Parameters<typeof inv.transitionTag>[2]) =>
  withTenantTx(rw, { tenantId }, () => inv.transitionTag(tagId, to, via));
let huidN = 0;
const huid = () => `IC${String(Date.now() % 100).padStart(2, '0')}${String(++huidN).padStart(2, '0')}`;
const tagBody = (o: Record<string, unknown> = {}) => ({ branch_id: B1, item_id: id.item, purity_id: id.purity, gross_wt: '10.000', stone_wt: '0.500',
  net_wt: '9.500', huid: huid(), counter_id: id.counter, ...o });
const newTag = async (o: Record<string, unknown> = {}) => (await go('POST', '/v1/inventory/tags', { body: tagBody(o), headers: key(), status: 201 })).json();
/** RFC 3339 timestamp (0.9.0: every Inventory timestamp, e.g. "2026-11-09T13:16:01.792494Z") → epoch ms; NaN for anything else. */
const ms = (s: string) => (isRfc3339DateTime(s) ? Date.parse(s) : NaN);
/** 0.8.9: the piece's print fields from GET /tags/{id}, GET /tag-lookup/{tagNo} and GET /tags (all three must agree). */
async function printFields(tagId: string): Promise<{ label_print_count: unknown; label_printed_at: unknown }> {
  const g = (await go('GET', '/v1/inventory/tags/{id}', { p: { id: tagId } })).json();
  const l = (await go('GET', '/v1/inventory/tag-lookup/{tagNo}', { p: { tagNo: g.tag_no } })).json();
  const li = (await go('GET', '/v1/inventory/tags', { q: { branch_id: B1, limit: '200' } })).json().items.find((x: { id: string }) => x.id === tagId);
  for (const v of [g, l, li]) {
    expect(v).toHaveProperty('label_print_count');
    expect(v).toHaveProperty('label_printed_at');
    expect({ c: v.label_print_count, at: v.label_printed_at }).toEqual({ c: g.label_print_count, at: g.label_printed_at });
  }
  return { label_print_count: g.label_print_count, label_printed_at: g.label_printed_at };
}

beforeAll(async () => {
  const { hashPassword } = await import('@jw/mod-platform');
  await mig.query(`INSERT INTO platform.platform_admin(email, name, password_hash) VALUES ('ops@jewelos.test', 'Ops', $1) ON CONFLICT (email) DO NOTHING`,
    [await hashPassword('admin-pass-123')]);
  app = await (await import('@jw/api')).createApp();
  const admin = cookieOf(await raw('POST', '/v1/admin/auth/login', { body: { email: 'ops@jewelos.test', password: 'admin-pass-123' } }), 'admin_sid');
  const t = await raw('POST', '/v1/admin/tenants', { cookie: admin, body: { slug: SLUG, display_name: SLUG,
    company: { legal_name: SLUG, gstin: '33CCCCC3333C1Z5', state_code: '33' }, branch: { code: 'ICA', name: 'Contract A' }, owner: { name: 'icowner', username: 'icowner', password: 'owner-pass-789' } } });
  expect(t.statusCode, t.body).toBe(201);
  tenantId = t.json().id;
  owner = cookieOf(await raw('POST', '/v1/auth/login', { body: { tenant: SLUG, login: 'icowner', password: 'owner-pass-789' } }));
  expect(owner).toBeTruthy();
  B1 = (await raw('GET', '/v1/branches', { cookie: owner })).json()[0].id;
  // second / third branch straight in the test DB (the fixture plan may cap branches over HTTP)
  const [{ company_id }] = await asMigrator<{ company_id: string }>(tenantId, `SELECT company_id FROM platform.branch WHERE id = $1`, [B1]);
  [B2, B3] = await Promise.all(['ICB', 'ICE'].map(async (code) => (await asMigrator<{ id: string }>(tenantId,
    `INSERT INTO platform.branch(tenant_id, company_id, code, name, bill_series_prefix, state_code) VALUES ($1, $2, $3, $4, $5, '33') RETURNING id`,
    [tenantId, company_id, code, `Contract ${code}`, code]))[0].id));
  const u = await raw('POST', '/v1/users', { cookie: owner, body: { name: 'iccash', username: 'iccash', password: 'cash-pass-7890', roles: [{ role: 'cashier', branch_id: B1 }], default_branch_id: B1 } });
  expect(u.statusCode, u.body).toBe(201);
  cashier = cookieOf(await raw('POST', '/v1/auth/login', { body: { tenant: SLUG, login: 'iccash', password: 'cash-pass-7890' } }));
});
afterAll(async () => {
  writeFileSync(REPORT, rec.report());
  await app?.close(); await mig.end(); await rw.end();
});

describe(`inventory responses match contracts/openapi.yaml ${oas.info.version} (ajv ${AJV_VERSION}, ajv-formats ${AJV_FORMATS_VERSION})`, () => {
  it('0.9.0 date-time is strict RFC 3339 in this validator (ajv-formats 2.1.1 alone accepts the Postgres text form)', () => {
    for (const bad of ['2026-11-09 18:46:01.792494+05:30', '2026-11-09 12:25:00.123456+00', '2026-11-09T18:46:01+0530', '2026-11-09T18:46:01',
      '2026-02-30T10:00:00Z', '2026-11-09T24:00:00Z', '2026-11-09']) expect([bad, formatOk('date-time', bad)]).toEqual([bad, false]);
    for (const good of ['2026-11-09T13:16:01.792494Z', '2026-11-09T18:46:01+05:30', '2026-11-09T13:16:01Z', '2026-11-09T13:16:01.792Z'])
      expect([good, formatOk('date-time', good)]).toEqual([good, true]);
    expect(formatOk('date', '2026-11-09')).toBe(true);
  });

  it('empty shop: lists, reports and a stock check on a branch with no stock', async () => {
    await go('GET', '/v1/inventory/statuses');
    await go('GET', '/v1/inventory/settings');
    for (const p of ['/v1/inventory/tags', '/v1/inventory/lots', '/v1/inventory/loose-stock', '/v1/inventory/ledger', '/v1/inventory/moves',
      '/v1/inventory/transfers', '/v1/inventory/stock-checks', '/v1/inventory/adjustments']) {
      const r = await go('GET', p, { q: { branch_id: B1 } });
      expect(r.json().items).toEqual([]);
    }
    await go('GET', '/v1/inventory/stock-summary', { q: { branch_id: B1 } });
    await go('GET', '/v1/inventory/valuation', { q: { branch_id: B1 } });
    await go('GET', '/v1/inventory/reports/ageing', { q: { branch_id: B1, include_rows: 'true' }, status: 409 });   // ageing_enabled is off by default
    const sc = (await go('POST', '/v1/inventory/stock-checks', { body: { branch_id: B3 }, headers: key(), status: 201 })).json();
    await go('GET', '/v1/inventory/stock-checks/{id}', { p: { id: sc.id } });
    await go('GET', '/v1/inventory/stock-checks/{id}/scans', { p: { id: sc.id } });
    await go('GET', '/v1/inventory/stock-checks/{id}/report', { p: { id: sc.id }, q: { result: 'missing', limit: '200' } });
    await go('POST', '/v1/inventory/stock-checks/{id}/cancel', { p: { id: sc.id }, headers: im(sc.version), status: 200 });
  });

  it('masters + settings', async () => {
    const mk = async (path: string, body: Record<string, unknown>) => {
      const r = await raw('POST', path, { cookie: owner, body });
      expect(r.statusCode, `${path} ${r.body}`).toBe(201);
      return r.json().id as string;
    };
    id.metal = await mk('/v1/masters/metals', { code: 'GLD', name: 'Gold', default_hsn: '7113' });
    id.purity = await mk('/v1/masters/purities', { metal_id: id.metal, code: '22K', fineness: '916' });
    id.item = await mk('/v1/masters/items', { code: 'RING', name: 'Ring', metal_id: id.metal, purity_id: id.purity, hsn: '7113', stock_type: 'tag' });
    id.coin = await mk('/v1/masters/items', { code: 'COIN', name: 'Coin', metal_id: id.metal, purity_id: id.purity, hsn: '7113', stock_type: 'non_tag' });
    id.floor = await mk('/v1/masters/floors', { branch_id: B1, code: 'GF', name: 'Ground' });
    id.floor2 = await mk('/v1/masters/floors', { branch_id: B2, code: 'GF2', name: 'Ground 2' });
    id.counter = await mk('/v1/masters/counters', { branch_id: B1, floor_id: id.floor, code: 'C1', name: 'Counter 1' });
    id.counterB = await mk('/v1/masters/counters', { branch_id: B1, floor_id: id.floor, code: 'C2', name: 'Counter 2' });
    id.counter2 = await mk('/v1/masters/counters', { branch_id: B2, floor_id: id.floor2, code: 'C9', name: 'Counter 9' });
    id.tray = await mk('/v1/masters/trays', { counter_id: id.counter, code: 'T1' });
    const s = await go('PATCH', '/v1/inventory/settings', { body: { photos_enabled: true, ageing_enabled: true } });
    const s2 = await go('PATCH', '/v1/inventory/settings', { body: { adjustment_approver: 'owner_or_manager' }, headers: im(s.json().version) });
    expect(s2.headers.etag).toBe(`"${s2.json().version}"`);
    await go('POST', '/v1/inventory/settings/tag-format/preview', { body: { branch_id: B1, item_id: id.item, count: 2 }, status: 200 });
  });

  it('tags: create (making charge + tray), bulk, get, lookup, list, patch, status, bulk-update, history', async () => {
    const t = await newTag({ tray_id: id.tray, mc_type: 'per_gram', mc_value: '350.00', wastage_pct: '8.5', size: '12', hsn: '711319',
      min_sale_value: '1000.00', cost_value: '50000.00', received_on: '2026-04-02', vendor_lot_ref: 'VL-77', label_payload: 'PAYLOAD-IC-1' });
    id.tag = t.id; id.tagNo = t.tag_no;
    expect(t).toMatchObject({ mc_type: 'per_gram', tray_id: id.tray, barcode_payload: 'PAYLOAD-IC-1' });
    const plain = await newTag(); id.plain = plain.id;
    const bulk = (await go('POST', '/v1/inventory/tags/bulk', { body: { common: { branch_id: B1, item_id: id.item, purity_id: id.purity, counter_id: id.counterB },
      rows: [{ gross_wt: '4.000', net_wt: '4.000', huid: huid() }, { gross_wt: '5.000', net_wt: '4.800', stone_wt: '0.200', huid: huid() }], print_labels: true },
    headers: key(), status: 201 })).json();
    id.bulk1 = bulk.items[0].id; id.bulk2 = bulk.items[1].id;
    // 0.8.9: print_labels → items are read after the print
    for (const it of bulk.items) expect(it).toMatchObject({ label_print_count: 1, label_printed_at: expect.any(String) });
    await go('GET', '/v1/inventory/tags/{id}', { p: { id: id.tag } });
    await go('GET', '/v1/inventory/tag-lookup/{tagNo}', { p: { tagNo: id.tagNo } });
    await go('GET', '/v1/inventory/tag-lookup/{tagNo}', { p: { tagNo: id.tagNo }, q: { branch_id: B1 } });
    await go('GET', '/v1/inventory/tags', { q: { branch_id: B1 } });
    await go('GET', '/v1/inventory/tags', { q: { branch_id: B1, tray_id: id.tray, limit: '1' } });
    const cur = (await go('GET', '/v1/inventory/tags/{id}', { p: { id: id.plain } })).json();
    const p = await go('PATCH', '/v1/inventory/tags/{id}', { p: { id: id.plain }, body: { size: '14', mc_value: '400' }, headers: im(cur.version) });
    const st = await go('POST', '/v1/inventory/tags/{id}/status', { p: { id: id.plain }, body: { status: 'repair', reason: 'loose stone' }, headers: im(p.json().version) });
    await go('POST', '/v1/inventory/tags/{id}/status', { p: { id: id.plain }, body: { status: 'in_stock', reason: 'back from repair' }, headers: im(st.json().version) });
    const [a, b] = await Promise.all([id.bulk1, id.bulk2].map(async (x) => (await go('GET', '/v1/inventory/tags/{id}', { p: { id: x } })).json()));
    await go('POST', '/v1/inventory/tags/bulk-update', { body: { items: [{ id: a.id, version: a.version }, { id: b.id, version: b.version }], changes: { hsn: '7113' } },
      headers: { 'if-match': `"${a.version}", "${b.version}"` }, status: 200 });
    await go('GET', '/v1/inventory/tags/{id}/history', { p: { id: id.plain } });
  });

  it('photos: add, list, patch, delete', async () => {
    const f1 = await uploadPhoto(owner);
    const ph = (await go('POST', '/v1/inventory/tags/{id}/photos', { p: { id: id.tag }, body: { file_id: f1, caption: 'front' }, headers: key(), status: 201 })).json();
    const list = (await go('GET', '/v1/inventory/tags/{id}/photos', { p: { id: id.tag } })).json();
    const row = (list.items ?? list)[0] ?? ph;
    await go('PATCH', '/v1/inventory/tags/{id}/photos/{photoId}', { p: { id: id.tag, photoId: ph.id }, body: { caption: 'front view' }, headers: im(row.version ?? 1) });
    await go('DELETE', '/v1/inventory/tags/{id}/photos/{photoId}', { p: { id: id.tag, photoId: ph.id }, status: 204 });
  });

  it('0.8.9 Tag schema: label_print_count / label_printed_at and the always-sent report-row fields are required in the contract', () => {
    const req = (n: string) => (oas.components.schemas[n].required ?? []) as string[];
    expect(req('Tag')).toEqual(expect.arrayContaining(['label_print_count', 'label_printed_at']));
    expect(oas.components.schemas.Tag.properties.label_printed_at.type).toEqual(['string', 'null']);
    expect(req('StockCheckReportRow')).toEqual(expect.arrayContaining(['status', 'scanned_at']));
    expect(oas.components.schemas.StockCheckReportRow.properties.scanned_at.type).toEqual(['string', 'null']);
  });

  it('0.8.9 labels: Tag GET / lookup / list carry label_print_count + label_printed_at before a print, after it and after a reprint', async () => {
    const t = await newTag();
    expect(t).toMatchObject({ label_print_count: 0, label_printed_at: null });
    expect(await printFields(t.id)).toEqual({ label_print_count: 0, label_printed_at: null });
    await go('POST', '/v1/inventory/labels', { body: { tag_ids: [t.id] }, headers: key(), status: 200 });
    const one = await printFields(t.id);
    expect(one.label_print_count).toBe(1);
    expect(typeof one.label_printed_at).toBe('string');
    expect(one.label_printed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);   // 0.9.0 RFC 3339 (was "… 18:46:01.792494+05:30")
    expect(Number.isNaN(ms(one.label_printed_at as string))).toBe(false);
    await go('POST', '/v1/inventory/labels', { body: { tag_ids: [t.id], reprint: true, reprint_reason: 'torn label' }, headers: key(), status: 200 });
    const two = await printFields(t.id);
    expect(two.label_print_count).toBe(2);
    expect(ms(two.label_printed_at as string)).toBeGreaterThanOrEqual(ms(one.label_printed_at as string));
  });

  it('labels: first print, reprint (TagLabelBatch: doc_type tag_label, duplicate boolean)', async () => {
    const first = (await go('POST', '/v1/inventory/labels', { body: { tag_ids: [id.tag], reprint: false, reprint_reason: null }, headers: key(), status: 200 })).json();
    expect(first.doc_type).toBe('tag_label');
    expect(first.labels[0].duplicate).toBe(false);
    const again = (await go('POST', '/v1/inventory/labels', { body: { tag_ids: [id.tag], reprint: true, reprint_reason: 'smudged', copies: 2 }, headers: key(), status: 200 })).json();
    expect(again.labels[0]).toMatchObject({ duplicate: true, copies: 2 });
    await go('POST', '/v1/inventory/labels', { body: { tag_ids: [id.plain] }, headers: key(), status: 200 });
  });

  it('0.9.6 tag_label no-regression — label template create/activate behave exactly as at b13a296 (201 versioned inactive, 428/412/200, one active); labels follow the active tenant template (none → code128, qr, code128, qr)', async () => {
    const label = async () => { const t = await newTag();
      const b = (await go('POST', '/v1/inventory/labels', { body: { tag_ids: [t.id] }, headers: key(), status: 200 })).json();
      return { template_id: b.template_id, template_version: b.template_version, barcode_format: b.barcode_format }; };
    // no platform tag_label template exists (998 seeds only the four Sales pins): the default is no template + code128
    expect(await label()).toEqual({ template_id: null, template_version: null, barcode_format: 'code128' });
    const create = async (body_key: string, config: Record<string, unknown>) =>
      (await go('POST', '/v1/print-templates', { body: { doc_type: 'tag_label', body_key, paper: 'label', config }, status: 201 })).json();
    const qr = await create('tpl/g/label-qr.hbs', { barcode_format: 'qr' });
    const bar = await create('tpl/g/label-128.hbs', {});
    for (const [t, v, cfg] of [[qr, 1, { barcode_format: 'qr' }], [bar, 2, {}]] as const)
      expect(t).toMatchObject({ scope: 'tenant', read_only: false, doc_type: 'tag_label', version: v, paper: 'label', body_key: expect.any(String), config: cfg, is_active: false, renderable: true });
    const activate = async (t: { id: string }, headers: Record<string, string> = {}, status = 200) =>
      (await go('POST', '/v1/print-templates/{id}/activate', { p: { id: t.id }, headers, status })).json();
    const rv = async (t: { id: string }) => (await go('GET', '/v1/print-templates/{id}', { p: { id: t.id } })).json().row_version as number;
    await activate(qr, {}, 428);
    await activate(qr, { 'if-match': '"99"' }, 412);
    expect(await activate(qr, im(await rv(qr)))).toMatchObject({ id: qr.id, is_active: true, renderable: true });
    expect(await label()).toEqual({ template_id: qr.id, template_version: 1, barcode_format: 'qr' });
    expect(await activate(bar, im(await rv(bar)))).toMatchObject({ id: bar.id, is_active: true });
    const active = (await go('GET', '/v1/print-templates', { q: { doc_type: 'tag_label' } })).json() as { scope: string; is_active: boolean; version: number }[];
    expect(active.filter((t) => t.scope === 'tenant' && t.is_active).map((t) => t.version)).toEqual([2]); // one active per doc type
    expect(await label()).toEqual({ template_id: bar.id, template_version: 2, barcode_format: 'code128' });
    await activate(qr, im(await rv(qr)));
    expect(await label()).toEqual({ template_id: qr.id, template_version: 1, barcode_format: 'qr' });
    // Sales doc types stay refused on create (B-2), unaffected by the tag_label exemption
    expect((await go('POST', '/v1/print-templates', { body: { doc_type: 'invoice', body_key: 'tpl/platform/invoice.hbs' }, status: 422 })).json().code).toBe('print_template_not_renderable');
  });

  it('lots, loose stock, moves, ledger', async () => {
    const lot = (await go('POST', '/v1/inventory/lots', { body: { branch_id: B1, ref_invoice_no: 'INV-1', received_on: '2026-03-01',
      lines: [{ item_id: id.item, purity_id: id.purity, pieces: 2, gross_wt: '20.000', stone_wt: '0', net_wt: '20.000' }] }, headers: key(), status: 201 })).json();
    await go('GET', '/v1/inventory/lots', { q: { branch_id: B1 } });
    const lg = (await go('GET', '/v1/inventory/lots/{id}', { p: { id: lot.id } })).json();
    const lp = (await go('PATCH', '/v1/inventory/lots/{id}', { p: { id: lot.id }, body: { hallmark_centre: 'BIS Madurai' }, headers: im(lg.version) })).json();
    await go('POST', '/v1/inventory/tags', { body: tagBody({ source: 'lot', lot_line_id: lp.lines[0].id, gross_wt: '9.000', stone_wt: '0', net_wt: '9.000' }), headers: key(), status: 201 });
    const lg2 = (await go('GET', '/v1/inventory/lots/{id}', { p: { id: lot.id } })).json();
    await go('POST', '/v1/inventory/lots/{id}/close', { p: { id: lot.id }, body: { remainder: 'to_loose', counter_id: id.counter }, headers: im(lg2.version), status: 200 });
    await go('POST', '/v1/inventory/loose-stock/receipts', { body: { branch_id: B1, counter_id: id.counter, item_id: id.coin, purity_id: id.purity,
      gross_wt: '50.000', net_wt: '50.000', pieces: 5, note: 'opening coins' }, headers: key(), status: 201 });
    await go('GET', '/v1/inventory/loose-stock', { q: { branch_id: B1 } });
    await go('POST', '/v1/inventory/moves', { body: { branch_id: B1, to_counter_id: id.counterB, to_tray_id: null, tag_ids: [id.plain],
      loose: [{ item_id: id.coin, purity_id: id.purity, from_counter_id: id.counter, pieces: 1, gross_wt: '10.000', net_wt: '10.000' }], reason: 'display change' }, headers: key(), status: 201 });
    await go('GET', '/v1/inventory/moves', { q: { branch_id: B1 } });
    await go('GET', '/v1/inventory/ledger', { q: { branch_id: B1 } });
    await go('GET', '/v1/inventory/ledger', { q: { branch_id: B1, tag_id: id.tag } });
  });

  it('transfers: create, list, get, patch, approve, dispatch, receive; return; cancel', async () => {
    const tt = await newTag(); const tr2 = await newTag(); const tc = await newTag();
    const mkT = async (tagId: string) => (await go('POST', '/v1/inventory/transfers', { body: { from_branch_id: B1, to_branch_id: B2, lines: [{ tag_id: tagId }], remarks: 'to B2' },
      headers: key(), status: 201 })).json();
    const t = await mkT(tt.id);
    await go('GET', '/v1/inventory/transfers', { q: { branch_id: B1 } });
    await go('GET', '/v1/inventory/transfers', { q: { branch_id: B2, direction: 'in' } });
    const g = (await go('GET', '/v1/inventory/transfers/{id}', { p: { id: t.id } })).json();
    const pt = (await go('PATCH', '/v1/inventory/transfers/{id}', { p: { id: t.id }, body: { remarks: 'to B2 (edited)' }, headers: im(g.version) })).json();
    const ap = (await go('POST', '/v1/inventory/transfers/{id}/approve', { p: { id: t.id }, headers: im(pt.version), status: 200 })).json();
    const dp = (await go('POST', '/v1/inventory/transfers/{id}/dispatch', { p: { id: t.id }, body: {}, headers: { ...im(ap.version), ...key() }, status: 200 })).json();
    await go('GET', '/v1/inventory/tags/{id}', { p: { id: tt.id } });   // in_transit
    await go('POST', '/v1/inventory/transfers/{id}/receive', { p: { id: t.id }, body: { line_ids: dp.lines.map((l: { id: string }) => l.id), counter_id: id.counter2 },
      headers: { ...im(dp.version), ...key() }, status: 200 });
    const r = await mkT(tr2.id);
    const rap = (await go('POST', '/v1/inventory/transfers/{id}/approve', { p: { id: r.id }, headers: im(r.version), status: 200 })).json();
    const rdp = (await go('POST', '/v1/inventory/transfers/{id}/dispatch', { p: { id: r.id }, body: { remarks: 'sent' }, headers: { ...im(rap.version), ...key() }, status: 200 })).json();
    await go('POST', '/v1/inventory/transfers/{id}/return', { p: { id: r.id }, body: { reason: 'wrong branch' }, headers: im(rdp.version), status: 200 });
    const c = await mkT(tc.id);
    await go('POST', '/v1/inventory/transfers/{id}/cancel', { p: { id: c.id }, headers: im(c.version), status: 200 });
  });

  it('stock checks: start, list, get, scan (new / duplicate / extra), scans, undo, report, close; cancel', async () => {
    const sc = (await go('POST', '/v1/inventory/stock-checks', { body: { branch_id: B1, counter_id: id.counter, tray_id: null, notes: 'weekly' }, headers: key(), status: 201 })).json();
    await go('GET', '/v1/inventory/stock-checks', { q: { branch_id: B1 } });
    await go('GET', '/v1/inventory/stock-checks/{id}', { p: { id: sc.id } });
    const s1 = (await go('POST', '/v1/inventory/stock-checks/{id}/scans', { p: { id: sc.id }, body: { code: id.tagNo }, status: 201 })).json();
    await go('POST', '/v1/inventory/stock-checks/{id}/scans', { p: { id: sc.id }, body: { code: id.tagNo }, status: 200 });
    const x = (await go('POST', '/v1/inventory/stock-checks/{id}/scans', { p: { id: sc.id }, body: { code: 'NO-SUCH-CODE' }, status: 201 })).json();
    await go('POST', '/v1/inventory/stock-checks/{id}/scans', { p: { id: sc.id }, body: { code: (await raw('GET', `/v1/inventory/tags/${id.bulk1}`, { cookie: owner })).json().tag_no }, status: 201 });
    await go('GET', '/v1/inventory/stock-checks/{id}/scans', { p: { id: sc.id } });
    await go('DELETE', '/v1/inventory/stock-checks/{id}/scans/{scanId}', { p: { id: sc.id, scanId: x.scan_id }, status: 204 });
    for (const result of [undefined, 'matched', 'missing', 'extra']) await go('GET', '/v1/inventory/stock-checks/{id}/report', { p: { id: sc.id }, q: result ? { result } : undefined });
    // 0.8.9: status and scanned_at are on every report row (scanned_at null on a missing row, status null for an unknown code)
    const rep = (await go('GET', '/v1/inventory/stock-checks/{id}/report', { p: { id: sc.id } })).json().items as Record<string, unknown>[];
    expect(rep.some((r) => r.result === 'missing')).toBe(true);
    for (const r of rep) { expect(r).toHaveProperty('status'); expect(r).toHaveProperty('scanned_at'); }
    for (const r of rep.filter((x) => x.result === 'missing')) expect(r).toMatchObject({ scanned_at: null, status: expect.any(String) });
    for (const r of rep.filter((x) => x.result !== 'missing')) expect(typeof r.scanned_at).toBe('string');
    expect(s1).toBeTruthy();
    const cur = (await go('GET', '/v1/inventory/stock-checks/{id}', { p: { id: sc.id } })).json();
    const closed = (await go('POST', '/v1/inventory/stock-checks/{id}/close', { p: { id: sc.id }, body: { create_adjustments: true, notes: 'done' }, headers: im(cur.version), status: 200 })).json();
    expect(closed.created_adjustment_ids.length).toBeGreaterThan(0);
    await go('GET', '/v1/inventory/stock-checks/{id}', { p: { id: sc.id } });
  });

  it('adjustments: request, list, get, approve; reject; cancel; full_write_off → written_off', async () => {
    const adj = (body: Record<string, unknown>) => go('POST', '/v1/inventory/adjustments', { body: { branch_id: B1, reason_code: 'polishing', reason: 'polished at counter', ...body }, headers: key(), status: 201 });
    const a = (await adj({ kind: 'weight_loss', tag_id: id.tag, delta_gross_wt: '-0.050', delta_net_wt: '-0.050' })).json();
    await go('GET', '/v1/inventory/adjustments', { q: { branch_id: B1 } });
    await go('GET', '/v1/inventory/adjustments/{id}', { p: { id: a.id } });
    await go('POST', '/v1/inventory/adjustments/{id}/approve', { p: { id: a.id }, body: { note: 'checked' }, headers: im(a.version), status: 200 });
    const r = (await adj({ kind: 'weight_gain', tag_id: id.tag, delta_gross_wt: '0.010', delta_net_wt: '0.010', reason_code: 'weighing_error' })).json();
    await go('POST', '/v1/inventory/adjustments/{id}/reject', { p: { id: r.id }, body: { note: 'scale was fine' }, headers: im(r.version), status: 200 });
    const c = (await adj({ kind: 'weight_loss', tag_id: id.tag, delta_gross_wt: '-0.010', delta_net_wt: '-0.010' })).json();
    await go('POST', '/v1/inventory/adjustments/{id}/cancel', { p: { id: c.id }, headers: im(c.version), status: 200 });
    const wo = await newTag({ gross_wt: '3.000', stone_wt: '0', net_wt: '3.000' }); id.writtenOff = wo.id;
    const w = (await adj({ kind: 'full_write_off', tag_id: wo.id, delta_pieces: -1, delta_gross_wt: '-3.000', delta_net_wt: '-3.000', reason_code: 'loss', reason: 'lost at exhibition' })).json();
    await go('POST', '/v1/inventory/adjustments/{id}/approve', { p: { id: w.id }, body: {}, headers: im(w.version), status: 200 });
    await go('POST', '/v1/inventory/adjustments', { body: { branch_id: B1, kind: 'piece_gain', item_id: id.coin, purity_id: id.purity, counter_id: id.counter,
      delta_pieces: 1, delta_gross_wt: '10.000', delta_net_wt: '10.000', reason_code: 'count_error', reason: 'recount' }, headers: key(), status: 201 });
  });

  it('every terminal status reads back (sold, melted, returned_to_vendor, written_off)', async () => {
    const [s, m, v] = [await newTag(), await newTag(), await newTag()];
    await flow(s.id, 'sold', 'sale');
    await flow(m.id, 'melting', 'melt_send'); await flow(m.id, 'melted', 'melt');
    await flow(v.id, 'returned_to_vendor', 'vendor_return');
    for (const [tid, st] of [[s.id, 'sold'], [m.id, 'melted'], [v.id, 'returned_to_vendor'], [id.writtenOff, 'written_off']] as const) {
      const g = (await go('GET', '/v1/inventory/tags/{id}', { p: { id: tid } })).json();
      expect(g.status).toBe(st);
      await go('GET', '/v1/inventory/tag-lookup/{tagNo}', { p: { tagNo: g.tag_no }, q: { branch_id: B1 } });
      await go('GET', '/v1/inventory/tags/{id}/history', { p: { id: tid } });
    }
    const all = await go('GET', '/v1/inventory/tags', { q: { branch_id: B1, status: 'sold,melted,returned_to_vendor,written_off' } });
    expect(new Set(all.json().items.map((t: { status: string }) => t.status))).toEqual(new Set(['sold', 'melted', 'returned_to_vendor', 'written_off']));
  });

  it('reports with stock: summary, valuation, ageing (each group_by)', async () => {
    for (const group_by of ['location', 'item', 'purity', 'status']) {
      const s = (await go('GET', '/v1/inventory/stock-summary', { q: { branch_id: B1, group_by, include_loose: 'true' } })).json();
      // 0.9.0: tag_count (number of tags) on every row and the totals, for every group_by
      for (const r of [...s.rows, s.totals]) expect([group_by, Number.isInteger(r.tag_count) && r.tag_count >= 0 && r.tag_count <= r.tag_pieces]).toEqual([group_by, true]);
      expect(s.totals.tag_count).toBe(s.rows.reduce((n: number, r: { tag_count: number }) => n + r.tag_count, 0));
      expect(s.totals.tag_count).toBeGreaterThan(0);
    }
    await go('GET', '/v1/inventory/stock-summary', {});
    const vg = (oas.paths['/v1/inventory/valuation'].get.parameters ?? []).find((x: { name?: string }) => x.name === 'group_by')?.schema?.enum ?? [undefined];
    for (const group_by of vg) await go('GET', '/v1/inventory/valuation', { q: { branch_id: B1, ...(group_by ? { group_by } : {}), include_loose: 'true' } });
    const ag = (oas.paths['/v1/inventory/reports/ageing'].get.parameters ?? []).find((x: { name?: string }) => x.name === 'group_by')?.schema?.enum ?? [undefined];
    for (const group_by of ag) await go('GET', '/v1/inventory/reports/ageing', { q: { branch_id: B1, ...(group_by ? { group_by } : {}), include_rows: 'true' } });
    // empty branch once ageing / valuation / summary have something elsewhere
    await go('GET', '/v1/inventory/reports/ageing', { q: { branch_id: B3, include_rows: 'true' } });
    await go('GET', '/v1/inventory/valuation', { q: { branch_id: B3 } });
    await go('GET', '/v1/inventory/stock-summary', { q: { branch_id: B3 } });
  });

  it('error bodies are problem+json per the contract (401, 403, 404, 409, 412, 422, 428)', async () => {
    await go('GET', '/v1/inventory/tags', { cookie: 'sid=nope', status: 401 });
    await go('GET', '/v1/inventory/valuation', { cookie: cashier, q: { branch_id: B1 }, status: 403 });
    await go('GET', '/v1/inventory/tags/{id}', { p: { id: '00000000-0000-0000-0000-00000000dead' }, status: 404 });
    await go('POST', '/v1/inventory/labels', { body: { tag_ids: [id.tag] }, headers: key(), status: [409, 422] });
    const t = (await go('GET', '/v1/inventory/tags/{id}', { p: { id: id.plain } })).json();
    await go('PATCH', '/v1/inventory/tags/{id}', { p: { id: id.plain }, body: { size: '9' }, headers: im(t.version + 7), status: 412 });
    await go('PATCH', '/v1/inventory/tags/{id}', { p: { id: id.plain }, body: { size: '9' }, status: 428 });
    await go('POST', '/v1/inventory/labels', { body: { tag_ids: [id.tag], bogus: 1 }, headers: key(), status: 422 });
    await go('POST', '/v1/inventory/tags/{id}/status', { p: { id: id.writtenOff }, body: { status: 'in_stock', reason: 'try again' },
      headers: im((await raw('GET', `/v1/inventory/tags/${id.writtenOff}`, { cookie: owner })).json().version), status: 409 });
  });

  it('contract: no violations, every Inventory operation returned a 2xx, no undocumented properties', () => {
    const r = JSON.parse(rec.report()) as { violations: { op: string; status: number }[]; undocumented: string[]; timestamps: string[] };
    expect(r.timestamps).toEqual([]);   // 0.9.0: every *_at / at field in every Inventory response is RFC 3339
    expect(rec.uncovered('/v1/inventory')).toEqual([]);
    expect(r.violations.filter((v) => !KNOWN.some((k) => k.op === v.op && k.status === v.status))).toEqual([]);
    expect(r.undocumented).toEqual([]);
  });
});
