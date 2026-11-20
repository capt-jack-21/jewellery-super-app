import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool, url } from './env';
import { ContractRecorder, AJV_VERSION, AJV_FORMATS_VERSION, oas, type Res } from './contract';

/**
 * O1: every Orders operation in contracts/openapi.yaml called over HTTP (app.inject) on real test-DB data; every response body
 * (2xx and problem+json errors) is validated against the documented schema for its status code (Ajv 2020-12). Fails on any
 * Orders operation that never returned a 2xx here, and on undocumented properties in a response.
 */
process.env.DATABASE_URL = url('app_rw');
process.env.ADMIN_DATABASE_URL = url('app_admin');
process.env.SESSION_SECRET = 'test-secret-0123456789abcdef0123456789';
process.env.COOKIE_INSECURE = '1';
process.env.FILE_STORE_DIR = `/tmp/jw-files-oc-${process.pid}`;
process.env.FILE_TOKEN_SECRET = 'test-file-token-secret-0123456789abcdef';

type App = Awaited<ReturnType<typeof import('@jw/api').createApp>>;
let app: App;
const mig = pool('app_migrator');
const rw = pool('app_rw');
const rec = new ContractRecorder();
const REPORT = process.env.CONTRACT_REPORT ?? `/tmp/jw-orders-contract-${process.pid}.json`;

const raw = (method: string, path: string, o: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Res> =>
  app.inject({ method: method as 'GET', url: `/api${path}`, payload: o.body as object,
    headers: { ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.headers ?? {}) } }) as unknown as Promise<Res>;
const cookieOf = (r: Res, name = 'sid') => {
  const c = ([] as string[]).concat((r.headers['set-cookie'] as string | string[]) ?? []).find((x) => x.startsWith(`${name}=`));
  return c ? c.split(';')[0] : '';
};
let keyN = 0;
const key = () => ({ 'idempotency-key': `oc-${process.pid}-${++keyN}-${Date.now()}` });
const im = (v: number) => ({ 'if-match': `"${v}"` });
interface Go { cookie?: string; body?: unknown; headers?: Record<string, string>; q?: Record<string, string>; p?: Record<string, string>; status?: number | number[] }
let owner = '';
/** Calls a contract operation (templated path + params), validates the response against the contract, checks the expected status. */
async function go(method: string, template: string, o: Go = {}): Promise<Res> {
  let path = template.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(o.p?.[k] ?? `{${k}}`));
  if (o.q) path += `?${new URLSearchParams(o.q).toString()}`;
  const r = await raw(method, path, { cookie: o.cookie ?? owner, body: o.body, headers: o.headers });
  rec.check(method, template, r);
  const want = ([] as number[]).concat(o.status ?? (method === 'POST' ? [200, 201] : [200]));
  expect(want, `${method} ${path} → ${r.statusCode} ${r.body.slice(0, 400)}`).toContain(r.statusCode);
  return r;
}
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`oc-photo-${Date.now()}`)]);
async function uploadDesignPhoto(cookie: string): Promise<string> {
  const B = '----jwoc';
  const body = Buffer.concat([Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\ndesign_photo\r\n`),
    Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="file"; filename="p.png"\r\nContent-Type: application/octet-stream\r\n\r\n`), PNG, Buffer.from(`\r\n--${B}--\r\n`)]);
  const r = await app.inject({ method: 'POST', url: '/api/v1/files', payload: body, headers: { 'content-type': `multipart/form-data; boundary=${B}`, cookie } }) as unknown as Res;
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
}

const SLUG = `ordc-${Date.now() % 100000}`;
let B1 = ''; let cashier = ''; let sales = '';
const id: Record<string, string> = {};

beforeAll(async () => {
  const { hashPassword } = await import('@jw/mod-platform');
  await mig.query(`INSERT INTO platform.platform_admin(email, name, password_hash) VALUES ('ops@jewelos.test', 'Ops', $1) ON CONFLICT (email) DO NOTHING`,
    [await hashPassword('admin-pass-123')]);
  app = await (await import('@jw/api')).createApp();
  const admin = cookieOf(await raw('POST', '/v1/admin/auth/login', { body: { email: 'ops@jewelos.test', password: 'admin-pass-123' } }), 'admin_sid');
  const t = await raw('POST', '/v1/admin/tenants', { cookie: admin, body: { slug: SLUG, display_name: SLUG,
    company: { legal_name: SLUG, gstin: '33DDDDD4444D1Z5', state_code: '33' }, branch: { code: 'OCA', name: 'Orders Contract A' }, owner: { name: 'ocowner', username: 'ocowner', password: 'owner-pass-789' } } });
  expect(t.statusCode, t.body).toBe(201);
  owner = cookieOf(await raw('POST', '/v1/auth/login', { body: { tenant: SLUG, login: 'ocowner', password: 'owner-pass-789' } }));
  expect(owner).toBeTruthy();
  B1 = (await raw('GET', '/v1/branches', { cookie: owner })).json()[0].id;
  const mk = async (path: string, body: Record<string, unknown>) => {
    const r = await raw('POST', path, { cookie: owner, body });
    expect(r.statusCode, `${path} ${r.body}`).toBe(201);
    return r.json().id as string;
  };
  id.metal = await mk('/v1/masters/metals', { code: 'GLD', name: 'Gold', default_hsn: '7113' });
  id.purity = await mk('/v1/masters/purities', { metal_id: id.metal, code: '22K', fineness: '916' });
  id.item = await mk('/v1/masters/items', { code: 'RING', name: 'Ring', metal_id: id.metal, purity_id: id.purity, hsn: '7113', stock_type: 'tag' });
  id.customer = await mk('/v1/masters/customers', { name: 'Order Customer' });
  id.rtype = await mk('/v1/masters/repair-types', { name: 'Ring resize', sac: '998713', min_customer_charge: '100.00', max_customer_charge: '2000.00', min_vendor_charge: '50.00', max_vendor_charge: '500.00' });
  id.vendor = await mk('/v1/masters/vendors', { code: 'SMITH1', name: 'Smith One', kinds: ['smith'] });
  const mkUser = async (username: string, role: string) => {
    const u = await raw('POST', '/v1/users', { cookie: owner, body: { name: username, username, password: 'user-pass-7890', roles: [{ role, branch_id: B1 }], default_branch_id: B1 } });
    expect(u.statusCode, u.body).toBe(201);
    return cookieOf(await raw('POST', '/v1/auth/login', { body: { tenant: SLUG, login: username, password: 'user-pass-7890' } }));
  };
  cashier = await mkUser('occash', 'cashier');
  sales = await mkUser('ocsales', 'salesperson');
});
afterAll(async () => {
  writeFileSync(REPORT, rec.report());
  await app?.close(); await mig.end(); await rw.end();
});

const orderBody = (o: Record<string, unknown> = {}) => ({ branch_id: B1, customer_id: id.customer, priority: 'high', due_date: '2099-01-31', notes: 'contract test',
  lines: [{ item_id: id.item, pieces: 2, approx_wt: '12.500', size: '14', gender: 'female', design_notes: 'plain band',
    stones: [{ name: 'ruby', pieces: 1, weight: '0.250' }] }], ...o });

describe(`orders responses match contracts/openapi.yaml ${oas.info.version} (ajv ${AJV_VERSION}, ajv-formats ${AJV_FORMATS_VERSION})`, () => {
  it('empty shop: the list is empty and a page is valid', async () => {
    const r = await go('GET', '/v1/orders', { q: { branch_id: B1 } });
    expect(r.json().items).toEqual([]);
  });

  it('create (customer order, with an attachment), idempotent replay, shop order, get with ETag', async () => {
    const photo = await uploadDesignPhoto(owner);
    const h = key();
    const body = orderBody({ lines: [{ item_id: id.item, pieces: 2, approx_wt: '12.500', size: '14', gender: 'female', design_notes: 'plain band',
      stones: [{ name: 'ruby', pieces: 1, weight: '0.250' }], attachment_file_ids: [photo] }] });
    const c = await go('POST', '/v1/orders', { body, headers: h, status: 201 });
    const o = c.json();
    id.order = o.id; id.version = String(o.version);
    expect(o.order_no).toMatch(/^ORD-OCA-\d{4}-\d{5}$/);
    expect(o.lines).toHaveLength(1);
    const again = await go('POST', '/v1/orders', { body, headers: h, status: [200, 201] });
    expect(again.json().id).toBe(o.id);
    const shop = (await go('POST', '/v1/orders', { body: { branch_id: B1, order_type: 'shop', lines: [{ item_id: id.item }] }, headers: key(), status: 201 })).json();
    expect(shop.customer_id ?? null).toBeNull();
    const g = await go('GET', '/v1/orders/{id}', { p: { id: o.id } });
    expect(g.headers.etag).toBe(`"${g.json().version}"`);
    // a salesperson can create (orders.order.create) and sees the order in their branch
    await go('POST', '/v1/orders', { cookie: sales, body: orderBody(), headers: key(), status: 201 });
  });

  it('list: paging, filters (status, priority, customer, q, overdue, dates)', async () => {
    const all = (await go('GET', '/v1/orders', { q: { branch_id: B1, limit: '2' } })).json();
    expect(all.items).toHaveLength(2);
    expect(all.next_cursor).toBeTruthy();
    const next = (await go('GET', '/v1/orders', { q: { branch_id: B1, limit: '2', cursor: all.next_cursor } })).json();
    expect(next.items.length).toBeGreaterThan(0);
    for (const q of [{ status: 'open' }, { priority: 'high' }, { customer_id: id.customer }, { q: 'Order Customer' }, { overdue: 'false' },
      { from: '2020-01-01', to: '2099-12-31' }]) {
      const r = (await go('GET', '/v1/orders', { q: { branch_id: B1, ...q } })).json();
      expect(r.items.length, JSON.stringify(q)).toBeGreaterThan(0);
    }
    expect((await go('GET', '/v1/orders', { q: { branch_id: B1, overdue: 'true' } })).json().items).toEqual([]);
  });

  it('patch: header edit, whole-list line edit (a line left out is cancelled), If-Match enforced', async () => {
    const cur = (await go('GET', '/v1/orders/{id}', { p: { id: id.order } })).json();
    const l1 = cur.lines[0];
    const u = (await go('PATCH', '/v1/orders/{id}', { p: { id: id.order }, headers: im(cur.version),
      body: { priority: 'urgent', notes: 'rush', lines: [{ id: l1.id, item_id: id.item, pieces: 3, approx_wt: '15.000' }, { item_id: id.item, pieces: 1 }] } })).json();
    expect(u.version).toBe(cur.version + 1);
    expect(u.priority).toBe('urgent');
    expect(u.lines.filter((l: { status: string }) => l.status === 'pending')).toHaveLength(2);
    const u2 = (await go('PATCH', '/v1/orders/{id}', { p: { id: id.order }, headers: im(u.version), body: { lines: [{ id: l1.id, item_id: id.item }] } })).json();
    expect(u2.lines.filter((l: { status: string }) => l.status === 'cancelled')).toHaveLength(1);
  });

  it('assign / unassign / cancel: status follows, errors are problem+json (409, 412, 422, 428, 403)', async () => {
    const o = (await go('POST', '/v1/orders', { body: orderBody({ lines: [{ item_id: id.item, pieces: 1 }, { item_id: id.item, pieces: 1 }] }), headers: key(), status: 201 })).json();
    const [l1, l2] = o.lines.map((l: { id: string }) => l.id);
    const assign = { vendor_id: id.vendor, vendor_due: '2099-02-01', vendor_note: 'issued 5.000 g' };
    await go('POST', '/v1/orders/{id}/lines/{lineId}/assign', { p: { id: o.id, lineId: l1 }, body: assign, status: 412, headers: im(o.version + 9) });
    await go('POST', '/v1/orders/{id}/lines/{lineId}/assign', { p: { id: o.id, lineId: l1 }, body: assign, status: 428 });
    await go('POST', '/v1/orders/{id}/lines/{lineId}/assign', { p: { id: o.id, lineId: l1 }, body: { ...assign, vendor_id: '00000000-0000-0000-0000-00000000dead' }, headers: im(o.version), status: 422 });
    await go('POST', '/v1/orders/{id}/lines/{lineId}/assign', { p: { id: o.id, lineId: l1 }, body: { ...assign, extra: 1 }, headers: im(o.version), status: 422 });
    await go('POST', '/v1/orders/{id}/lines/{lineId}/assign', { cookie: 'sid=nope', p: { id: o.id, lineId: l1 }, body: assign, headers: im(o.version), status: 401 });
    const a1 = (await go('POST', '/v1/orders/{id}/lines/{lineId}/assign', { p: { id: o.id, lineId: l1 }, body: assign, headers: im(o.version), status: 200 }));
    expect(a1.headers.etag).toBe(`"${a1.json().version}"`);
    expect(a1.json().status).toBe('in_production');
    await go('POST', '/v1/orders/{id}/lines/{lineId}/assign', { p: { id: o.id, lineId: l1 }, body: assign, headers: im(a1.json().version), status: 409 });   // not pending
    await go('POST', '/v1/orders/{id}/lines/{lineId}/unassign', { p: { id: o.id, lineId: l2 }, headers: im(a1.json().version), status: 409 });             // not assigned
    const u = (await go('POST', '/v1/orders/{id}/lines/{lineId}/unassign', { p: { id: o.id, lineId: l1 }, headers: im(a1.json().version), status: 200 })).json();
    expect(u.status).toBe('open');
    await go('POST', '/v1/orders/{id}/cancel', { p: { id: o.id }, body: { reason: 'x' }, headers: im(u.version), status: 422 });
    await go('POST', '/v1/orders/{id}/cancel', { p: { id: o.id }, body: { reason: 'customer changed mind' }, status: 428 });
    const c = (await go('POST', '/v1/orders/{id}/cancel', { p: { id: o.id }, body: { reason: 'customer changed mind' }, headers: im(u.version), status: 200 })).json();
    expect(c).toMatchObject({ status: 'cancelled', cancel_reason: 'customer changed mind' });
    await go('POST', '/v1/orders/{id}/cancel', { p: { id: o.id }, body: { reason: 'again please' }, headers: im(c.version), status: 409 });
    await go('GET', '/v1/orders', { q: { branch_id: B1, status: 'cancelled' } });
  });

  it('receive: the piece is tagged and reserved; Inventory refusals reach the client as problem+json; the order becomes ready', async () => {
    const o = (await go('POST', '/v1/orders', { body: orderBody({ lines: [{ item_id: id.item, pieces: 1, approx_wt: '8.000' }] }), headers: key(), status: 201 })).json();
    const l = o.lines[0].id;
    const a = (await go('POST', '/v1/orders/{id}/lines/{lineId}/assign', { p: { id: o.id, lineId: l }, body: { vendor_id: id.vendor, vendor_due: '2099-03-01' }, headers: im(o.version) })).json();
    const rp = { p: { id: o.id, lineId: l } };
    await go('POST', '/v1/orders/{id}/lines/{lineId}/receive', { ...rp, body: { gross_wt: '8.100' }, headers: im(a.version), status: 422 });                 // HUID required (Inventory)
    await go('POST', '/v1/orders/{id}/lines/{lineId}/receive', { ...rp, body: { gross_wt: '8.100', bogus: 1 }, headers: im(a.version), status: 422 });
    await go('POST', '/v1/orders/{id}/lines/{lineId}/receive', { ...rp, body: { gross_wt: '8.100', huid: 'OC1234' }, status: 428 });
    await go('POST', '/v1/orders/{id}/lines/{lineId}/receive', { ...rp, body: { gross_wt: '8.100', huid: 'OC1234' }, headers: im(a.version + 5), status: 412 });
    await go('POST', '/v1/orders/{id}/lines/{lineId}/receive', { cookie: cashier, ...rp, body: { gross_wt: '8.100', huid: 'OC1234' }, headers: im(a.version), status: 403 });
    const r = (await go('POST', '/v1/orders/{id}/lines/{lineId}/receive', { ...rp, body: { gross_wt: '8.100', stone_wt: '0.100', huid: 'OC1234', size: '16' }, headers: im(a.version) })).json();
    expect(r.status).toBe('ready');
    expect(r.lines[0]).toMatchObject({ status: 'received', received_tag_id: expect.any(String) });
    const tag = (await go('GET', '/v1/inventory/tags/{id}', { p: { id: r.lines[0].received_tag_id } })).json();
    expect(tag).toMatchObject({ status: 'reserved', gross_wt: '8.100', net_wt: '8.000', huid: 'OC1234' });
    await go('POST', '/v1/orders/{id}/lines/{lineId}/receive', { ...rp, body: { gross_wt: '1.000', huid: 'OC1235' }, headers: im(r.version), status: 409 });
  });

  it('advances: money and metal, rate lock, receipt numbers; Sales refusals reach the client as problem+json', async () => {
    const o = (await go('POST', '/v1/orders', { body: orderBody({ lines: [{ item_id: id.item, pieces: 1, approx_wt: '8.000' }] }), headers: key(), status: 201 })).json();
    const p = { p: { id: o.id } };
    const m = (await go('POST', '/v1/orders/{id}/advances', { ...p, body: { kind: 'amount', amount: '2500', lock_rate_per_g: '6500' }, headers: key(), status: 201 })).json();
    expect(m).toMatchObject({ kind: 'amount', amount: '2500.00', balance: '2500.00', locked_rate_per_g: '6500.00', balance_fine_g: '0.000', order_id: o.id });
    expect(m.receipt_no).toMatch(/^ADV-[A-Z0-9]+-\d{4}-\d{5}$/);
    const g = (await go('POST', '/v1/orders/{id}/advances', { ...p, body: { kind: 'metal', purity_id: id.purity, weight: '10.000' }, headers: key(), status: 201 })).json();
    expect(g).toMatchObject({ kind: 'metal', weight: '10.000', balance: '0.00', balance_fine_g: '9.160' });
    const k = key();                                   // replay: same key and body gives the same advance, no second receipt
    const r1 = (await go('POST', '/v1/orders/{id}/advances', { ...p, body: { kind: 'amount', amount: '100' }, headers: k, status: 201 })).json();
    const r2 = (await go('POST', '/v1/orders/{id}/advances', { ...p, body: { kind: 'amount', amount: '100' }, headers: k, status: [200, 201] })).json();
    expect(r2.id).toBe(r1.id);
    const list = (await go('GET', '/v1/orders/{id}/advances', p)).json();
    expect(list.items.map((x: { id: string }) => x.id)).toEqual([m.id, g.id, r1.id]);
    expect((await go('GET', '/v1/orders/{id}', p)).json().rate_locked_per_g).toBe('6500.00');
    await go('POST', '/v1/orders/{id}/advances', { ...p, body: { kind: 'amount', amount: '100', lock_rate_per_g: '7000' }, headers: key(), status: 409 });   // rate_already_locked
    await go('POST', '/v1/orders/{id}/advances', { ...p, body: { kind: 'amount' }, headers: key(), status: 422 });
    await go('POST', '/v1/orders/{id}/advances', { ...p, body: { kind: 'amount', amount: '10', bogus: 1 }, headers: key(), status: 422 });
    await go('POST', '/v1/orders/{id}/advances', { ...p, body: { kind: 'amount', amount: '10' }, status: 400 });                                   // no Idempotency-Key
    // no 403 case over HTTP: every system role (owner, manager, salesperson, cashier) holds orders.advance.take; the permission check is in orders-o2.test.ts
    await go('GET', '/v1/orders/{id}/advances', { ...p, cookie: 'sid=nope', status: 401 });
    await go('GET', '/v1/orders/{id}/advances', { p: { id: '00000000-0000-0000-0000-00000000dead' }, status: 404 });
  });

  it('repairs: book (photo, estimate, advance), replay, view with ETag, edit, limits and rules as problem+json', async () => {
    const photo = await uploadDesignPhoto(owner);
    const body = { branch_id: B1, customer_id: id.customer, due_date: '2099-02-15', notes: 'customer waits',
      lines: [{ repair_type_id: id.rtype, description: 'resize to 14', gross_wt: '5.250', net_wt: '5.000', customer_charge: '350.00', photo_file_ids: [photo] }],
      advance: { amount: '200', purpose: 'repair advance' } };
    const h = key();
    const c = await go('POST', '/v1/repairs', { body, headers: h, status: 201 });
    const r = c.json();
    expect(r).toMatchObject({ status: 'received', overdue: false, customer_name: 'Order Customer', totals: { lines: 1, gross_wt: '5.250', estimate: '350.00' } });
    expect(r.repair_no).toMatch(/^REP-OCA-\d{4}-\d{5}$/);
    expect(r.lines[0]).toMatchObject({ repair_type_name: 'Ring resize', customer_charge: '350.00', photo_file_ids: [photo], status: 'active', issued_at: null });
    expect(r.advances).toHaveLength(1);
    expect(r.advances[0]).toMatchObject({ kind: 'amount', amount: '200.00', repair_id: r.id, order_id: null });
    expect((await go('POST', '/v1/repairs', { body, headers: h, status: [200, 201] })).json().id).toBe(r.id);   // replay: same repair, one advance
    const g = await go('GET', '/v1/repairs/{id}', { p: { id: r.id } });
    expect(g.headers.etag).toBe(`"${r.version}"`);
    expect(g.json().advances).toHaveLength(1);
    // a salesperson and a cashier can book (orders.repair.create)
    await go('POST', '/v1/repairs', { cookie: sales, body: { branch_id: B1, customer_id: id.customer, lines: [{ repair_type_id: id.rtype, gross_wt: '2.000' }] }, headers: key(), status: 201 });
    await go('POST', '/v1/repairs', { cookie: cashier, body: { branch_id: B1, customer_id: id.customer, lines: [{ repair_type_id: id.rtype, gross_wt: '2.000' }] }, headers: key(), status: 201 });
    // edit: due date and note, whole-list lines (a line left out is cancelled), If-Match enforced
    const l1 = r.lines[0];
    await go('PATCH', '/v1/repairs/{id}', { p: { id: r.id }, body: { notes: 'x' }, status: 428 });
    await go('PATCH', '/v1/repairs/{id}', { p: { id: r.id }, body: { notes: 'x' }, headers: im(r.version + 7), status: 412 });
    const u = (await go('PATCH', '/v1/repairs/{id}', { p: { id: r.id }, headers: im(r.version),
      body: { due_date: '2099-02-20', notes: 'rush', lines: [{ id: l1.id, repair_type_id: id.rtype, gross_wt: '5.250', customer_charge: '400.00' }, { repair_type_id: id.rtype, gross_wt: '1.100', customer_charge: '150.00' }] } })).json();
    expect(u).toMatchObject({ version: r.version + 1, due_date: '2099-02-20', notes: 'rush', totals: { lines: 2, gross_wt: '6.350', estimate: '550.00' } });
    const u2 = (await go('PATCH', '/v1/repairs/{id}', { p: { id: r.id }, headers: im(u.version), body: { lines: [{ id: l1.id, repair_type_id: id.rtype, gross_wt: '5.250' }] } })).json();
    expect(u2.lines.filter((l: { status: string }) => l.status === 'cancelled')).toHaveLength(1);
    // rules: estimate outside the repair type limits, net above gross, bad references, server-assigned number, no key, no auth, unknown / hidden repair
    const bad = (line: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      go('POST', '/v1/repairs', { body: { branch_id: B1, customer_id: id.customer, lines: [{ repair_type_id: id.rtype, gross_wt: '3.000', ...line }], ...extra }, headers: key(), status: 422 });
    const lim = (await bad({ customer_charge: '50.00' })).json();
    expect(lim.errors[0]).toMatchObject({ path: 'lines.0.customer_charge', code: 'charge_out_of_range' });
    await bad({ customer_charge: '5000.00' });
    await bad({ net_wt: '4.000' });
    await bad({ gross_wt: '0.000' });
    await bad({ repair_type_id: '00000000-0000-0000-0000-00000000dead' });
    await bad({}, { repair_no: 'X-1' });
    await bad({}, { advance: { amount: '0' } });
    await go('POST', '/v1/repairs', { body, status: 400 });
    await go('POST', '/v1/repairs', { cookie: 'sid=nope', body, headers: key(), status: 401 });
    await go('GET', '/v1/repairs/{id}', { p: { id: '00000000-0000-0000-0000-00000000dead' }, status: 404 });
  });

  it('repair vendor flow: issue, unissue, receive back with the loss check and override, status follows, problem+json errors', async () => {
    const r = (await go('POST', '/v1/repairs', { body: { branch_id: B1, customer_id: id.customer,
      lines: [{ repair_type_id: id.rtype, gross_wt: '10.000', customer_charge: '300.00' }, { repair_type_id: id.rtype, gross_wt: '5.000' }] }, headers: key(), status: 201 })).json();
    // lines saved in the same millisecond come back in no fixed order: find them by weight
    const l1 = r.lines.find((l: { gross_wt: string }) => l.gross_wt === '10.000').id as string;
    const l2 = r.lines.find((l: { gross_wt: string }) => l.gross_wt === '5.000').id as string;
    const at = (lineId: string, op: string) => `/v1/repairs/{id}/lines/{lineId}/${op}`;
    const P = (lineId: string) => ({ id: r.id, lineId });
    const issue = { vendor_id: id.vendor, vendor_charge: '150.00', vendor_note: 'handed 10.000 g' };
    await go('POST', at(l1, 'issue'), { p: P(l1), body: issue, status: 428 });
    await go('POST', at(l1, 'issue'), { p: P(l1), body: issue, headers: im(r.version + 9), status: 412 });
    await go('POST', at(l1, 'issue'), { p: P(l1), body: { ...issue, vendor_id: '00000000-0000-0000-0000-00000000dead' }, headers: im(r.version), status: 422 });
    await go('POST', at(l1, 'issue'), { p: P(l1), body: { ...issue, vendor_charge: '1000.00' }, headers: im(r.version), status: 422 });
    await go('POST', at(l1, 'issue'), { p: P(l1), body: { ...issue, bogus: 1 }, headers: im(r.version), status: 422 });
    await go('POST', at(l1, 'issue'), { cookie: cashier, p: P(l1), body: issue, headers: im(r.version), status: 403 });
    await go('POST', at(l1, 'issue'), { cookie: 'sid=nope', p: P(l1), body: issue, headers: im(r.version), status: 401 });
    const a1 = await go('POST', at(l1, 'issue'), { p: P(l1), body: issue, headers: im(r.version) });
    expect(a1.headers.etag).toBe(`"${a1.json().version}"`);
    expect(a1.json()).toMatchObject({ status: 'issued_to_vendor' });
    const lineOf = (rep: { lines: { id: string }[] }, lineId: string) => rep.lines.find((l) => l.id === lineId);
    expect(lineOf(a1.json(), l1)).toMatchObject({ vendor_id: id.vendor, vendor_charge: '150.00', vendor_note: 'handed 10.000 g', issued_at: expect.any(String) });
    await go('POST', at(l1, 'issue'), { p: P(l1), body: issue, headers: im(a1.json().version), status: 409 });       // already issued
    await go('POST', at(l2, 'unissue'), { p: P(l2), headers: im(a1.json().version), status: 409 });                  // not issued
    const a2 = (await go('POST', at(l2, 'issue'), { p: P(l2), body: { vendor_id: id.vendor }, headers: im(a1.json().version) })).json();
    const un = (await go('POST', at(l2, 'unissue'), { p: P(l2), headers: im(a2.version) })).json();
    expect(lineOf(un, l2)).toMatchObject({ vendor_id: null, issued_at: null });
    expect(un.status).toBe('issued_to_vendor');                                                                     // line 1 is still out
    // loss check: 2.00 % is above the default 1.00 % tolerance and is blocked; the owner can accept it with a reason
    const rb = (w: string, extra: Record<string, unknown> = {}) => ({ received_wt: w, ...extra });
    const blocked = (await go('POST', at(l1, 'receive'), { p: P(l1), body: rb('9.800'), headers: im(un.version), status: 422 })).json();
    expect(blocked.errors[0]).toMatchObject({ path: 'received_wt', code: 'loss_exceeds_tolerance' });
    await go('POST', at(l1, 'receive'), { p: P(l1), body: rb('9.800', { loss_override_reason: 'ab' }), headers: im(un.version), status: 422 });
    await go('POST', at(l1, 'receive'), { cookie: cashier, p: P(l1), body: rb('9.950'), headers: im(un.version), status: 403 });
    await go('POST', at(l1, 'receive'), { p: P(l1), body: rb('9.950'), status: 428 });
    const o1 = (await go('POST', at(l1, 'receive'), { p: P(l1), body: rb('9.800', { loss_override_reason: 'melted in polishing' }), headers: im(un.version) })).json();
    expect(o1.status).toBe('received_from_vendor');
    expect(lineOf(o1, l1)).toMatchObject({ received_wt: '9.800', loss_wt: '0.200', loss_pct: '2.00', loss_override_reason: 'melted in polishing', received_at: expect.any(String) });
    await go('POST', at(l1, 'receive'), { p: P(l1), body: rb('9.800'), headers: im(o1.version), status: 409 });       // already received
    await go('POST', at(l1, 'unissue'), { p: P(l1), headers: im(o1.version), status: 409 });
    const a3 = (await go('POST', at(l2, 'issue'), { p: P(l2), body: { vendor_id: id.vendor }, headers: im(o1.version) })).json();
    const done = (await go('POST', at(l2, 'receive'), { p: P(l2), body: rb('4.950', { vendor_charge: '120.00' }), headers: im(a3.version) })).json();   // exactly 1.00 %: accepted
    expect(done.status).toBe('ready');
    expect(lineOf(done, l2)).toMatchObject({ loss_wt: '0.050', loss_pct: '1.00', loss_override_reason: null, vendor_charge: '120.00' });
    await go('PATCH', '/v1/repairs/{id}', { p: { id: r.id }, body: { notes: 'late' }, headers: im(done.version), status: 409 });   // ready: no more edits
    await go('POST', at(l1, 'issue'), { p: P(l1), body: issue, headers: im(done.version), status: 409 });
  });

  it('settings: defaults, first save without If-Match, then If-Match; bad values are 422', async () => {
    const d = (await go('GET', '/v1/orders/settings')).json();
    expect(d).toMatchObject({ source: 'default', version: 0, order_no_format: 'ORD-{BRANCH}-{FY}-{SEQ:5}', default_due_days: null, advance_required: false });
    await go('PATCH', '/v1/orders/settings', { cookie: cashier, body: { advance_required: true }, status: 403 });
    await go('PATCH', '/v1/orders/settings', { body: { order_no_format: 'NO-SEQ' }, status: 422 });
    await go('PATCH', '/v1/orders/settings', { body: { default_due_days: 0 }, status: 422 });
    await go('PATCH', '/v1/orders/settings', { body: { unknown_field: 1 }, status: 422 });
    const a = await go('PATCH', '/v1/orders/settings', { body: { default_due_days: 10, repair_loss_tolerance_pct: '0.50' } });
    expect(a.json()).toMatchObject({ source: 'shop', version: 1, default_due_days: 10, repair_loss_tolerance_pct: '0.50' });
    expect(a.headers.etag).toBe('"1"');
    await go('PATCH', '/v1/orders/settings', { body: { advance_required: true }, status: 428 });
    await go('PATCH', '/v1/orders/settings', { body: { advance_required: true }, headers: im(9), status: 412 });
    await go('PATCH', '/v1/orders/settings', { body: { advance_required: true }, headers: im(1) });
    // a salesperson reads the settings (orders.order.view) but cannot change them
    expect((await go('GET', '/v1/orders/settings', { cookie: sales })).json().default_due_days).toBe(10);
    // the new default due date applies to an order that sends no due_date, and an explicit null still means none
    const o = (await go('POST', '/v1/orders', { body: { branch_id: B1, customer_id: id.customer, order_date: '2026-11-20', lines: [{ item_id: id.item }] }, headers: key(), status: 201 })).json();
    expect(o.due_date).toBe('2026-11-30');
    // advance_required is now ON for this shop: a repair needs its advance at booking, a customer order needs one before it goes to a vendor
    const rbody = { branch_id: B1, customer_id: id.customer, received_on: '2026-11-20', lines: [{ repair_type_id: id.rtype, gross_wt: '1.000' }] };
    const noAdv = (await go('POST', '/v1/repairs', { body: rbody, headers: key(), status: 422 })).json();
    expect(noAdv.errors[0]).toMatchObject({ path: 'advance', code: 'advance_required' });
    const rp = (await go('POST', '/v1/repairs', { body: { ...rbody, advance: { amount: '50' } }, headers: key(), status: 201 })).json();
    expect(rp.due_date).toBe('2026-11-30');   // the shop default applies to repairs too
    const ro = (await go('POST', '/v1/orders', { body: orderBody(), headers: key(), status: 201 })).json();
    const asg = { p: { id: ro.id, lineId: ro.lines[0].id }, body: { vendor_id: id.vendor, vendor_due: '2099-03-01' } };
    const blocked = (await go('POST', '/v1/orders/{id}/lines/{lineId}/assign', { ...asg, headers: im(ro.version), status: 409 })).json();
    expect(blocked.code).toBe('advance_required');
    expect((await go('GET', '/v1/orders/{id}', { p: { id: ro.id } })).json()).toMatchObject({ status: 'open', version: ro.version });
    await go('POST', '/v1/orders/{id}/advances', { p: { id: ro.id }, body: { kind: 'amount', amount: '100' }, headers: key(), status: 201 });
    expect((await go('POST', '/v1/orders/{id}/lines/{lineId}/assign', { ...asg, headers: im(ro.version), status: 200 })).json().status).toBe('in_production');
    const so = (await go('POST', '/v1/orders', { body: { branch_id: B1, order_type: 'shop', lines: [{ item_id: id.item }] }, headers: key(), status: 201 })).json();
    await go('POST', '/v1/orders/{id}/lines/{lineId}/assign', { p: { id: so.id, lineId: so.lines[0].id }, body: { vendor_id: id.vendor, vendor_due: '2099-03-01' }, headers: im(so.version), status: 200 });   // a shop order has no customer: exempt
    const n = (await go('POST', '/v1/orders', { body: { branch_id: B1, customer_id: id.customer, due_date: null, lines: [{ item_id: id.item }] }, headers: key(), status: 201 })).json();
    expect(n.due_date).toBeNull();
    await go('PATCH', '/v1/orders/settings', { body: { default_due_days: null, order_no_format: 'JW-{FY}-{SEQ:4}' }, headers: im(2) });
    const f = (await go('POST', '/v1/orders', { body: orderBody(), headers: key(), status: 201 })).json();
    expect(f.order_no).toMatch(/^JW-\d{4}-\d{4}$/);
  });

  it('error bodies are problem+json per the contract (401, 403, 404, 412, 422, 428, 400)', async () => {
    await go('GET', '/v1/orders', { cookie: 'sid=nope', status: 401 });
    await go('GET', '/v1/orders/{id}', { p: { id: '00000000-0000-0000-0000-00000000dead' }, status: 404 });
    await go('POST', '/v1/orders', { cookie: cashier, body: orderBody(), headers: key(), status: 201 });   // cashier may create orders
    await go('POST', '/v1/orders', { body: orderBody(), status: 400 });                                    // no Idempotency-Key
    await go('POST', '/v1/orders', { body: orderBody({ order_no: 'X-1' }), headers: key(), status: 422 });  // server-assigned number
    await go('POST', '/v1/orders', { body: orderBody({ customer_id: null }), headers: key(), status: 422 });
    await go('POST', '/v1/orders', { body: orderBody({ lines: [] }), headers: key(), status: 422 });
    const cur = (await go('GET', '/v1/orders/{id}', { p: { id: id.order } })).json();
    await go('PATCH', '/v1/orders/{id}', { p: { id: id.order }, body: { notes: 'x' }, headers: im(cur.version + 7), status: 412 });
    await go('PATCH', '/v1/orders/{id}', { p: { id: id.order }, body: { notes: 'x' }, status: 428 });
    await go('PATCH', '/v1/orders/{id}', { p: { id: id.order }, body: { bogus: 1 }, headers: im(cur.version), status: 422 });
  });

  it('O10: repair list (paging, filters, search) and the due-today / overdue summary', async () => {
    const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
    const line = [{ repair_type_id: id.rtype, gross_wt: '1.500' }];
    const late = (await go('POST', '/v1/repairs', { body: { branch_id: B1, customer_id: id.customer, received_on: '2020-01-01', due_date: '2020-02-01', lines: line, advance: { amount: '100' } }, headers: key(), status: 201 })).json();
    const now = (await go('POST', '/v1/repairs', { body: { branch_id: B1, customer_id: id.customer, due_date: today, lines: line, advance: { amount: '100' } }, headers: key(), status: 201 })).json();
    await go('POST', '/v1/orders', { body: orderBody({ due_date: today }), headers: key(), status: 201 });
    const ids = (q: Record<string, string>) => go('GET', '/v1/repairs', { q: { branch_id: B1, ...q } }).then((r) => r.json().items.map((x: { id: string }) => x.id));
    expect(await ids({ overdue: 'true' })).toContain(late.id);
    expect(await ids({ overdue: 'true' })).not.toContain(now.id);
    expect(await ids({ due_from: today, due_to: today })).toContain(now.id);
    expect(await ids({ due_from: today, due_to: today })).not.toContain(late.id);
    expect(await ids({ q: late.repair_no })).toEqual([late.id]);
    expect(await ids({ q: 'Order Customer', status: 'received' })).toContain(now.id);
    expect(await ids({ status: 'delivered' })).toEqual([]);
    expect(await ids({ customer_id: id.customer, from: '2020-01-01', to: '2020-01-01' })).toEqual([late.id]);
    const one = (await go('GET', '/v1/repairs', { q: { branch_id: B1, limit: '1' } })).json();
    expect(one.items).toHaveLength(1);
    expect(one.next_cursor).toBeTruthy();
    expect((await go('GET', '/v1/repairs', { q: { branch_id: B1, limit: '1', cursor: one.next_cursor } })).json().items[0].id).not.toBe(one.items[0].id);
    expect(one.items[0]).toMatchObject({ line_count: 1, gross_wt: '1.500' });
    await go('GET', '/v1/repairs', { q: { status: 'bogus' }, status: 422 });
    await go('GET', '/v1/repairs', { q: { due_from: 'x' }, status: 422 });
    await go('GET', '/v1/repairs', { cookie: cashier, q: { branch_id: B1 } });
    await go('GET', '/v1/repairs', { cookie: 'sid=nope', status: 401 });
    // orders list: due range
    expect((await go('GET', '/v1/orders', { q: { branch_id: B1, due_from: today, due_to: today } })).json().items.length).toBeGreaterThan(0);
    await go('GET', '/v1/orders', { q: { due_to: 'x' }, status: 422 });
    // the card
    const d = (await go('GET', '/v1/orders/due-summary', { q: { branch_id: B1 } })).json();
    expect(d.as_of).toBe(today);
    expect(d.repairs.overdue).toBeGreaterThanOrEqual(1);
    expect(d.repairs.due_today).toBeGreaterThanOrEqual(1);
    expect(d.orders.due_today).toBeGreaterThanOrEqual(1);
    await go('GET', '/v1/orders/due-summary', { cookie: cashier });
    await go('GET', '/v1/orders/due-summary', { cookie: 'sid=nope', status: 401 });
  });

  it('contract: no violations, every Orders operation returned a 2xx, no undocumented properties', () => {
    const r = JSON.parse(rec.report()) as { violations: { op: string; status: number }[]; undocumented: string[]; timestamps: string[] };
    expect(r.timestamps).toEqual([]);
    // deliverOrder needs a billing-ready shop (rates, onboarding, approved device): covered over HTTP in orders-o6.test.ts
    // prints are covered in orders-o11.test.ts
    expect(rec.uncovered('/v1/orders').filter((op) => op !== 'POST /v1/orders/{id}/deliver' && !op.includes('/prints'))).toEqual([]);
    // deliverRepair needs a billing-ready shop: covered over HTTP in orders-o9.test.ts
    expect(rec.uncovered('/v1/repairs').filter((op) => op !== 'POST /v1/repairs/{id}/deliver' && !op.includes('/prints'))).toEqual([]);
    expect(r.violations).toEqual([]);
    expect(r.undocumented).toEqual([]);
  });
});
