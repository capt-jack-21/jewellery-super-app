import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool, url } from './env';

process.env.DATABASE_URL = url('app_rw');
process.env.ADMIN_DATABASE_URL = url('app_admin');
process.env.SESSION_SECRET = 'test-secret-0123456789abcdef0123456789';
process.env.COOKIE_INSECURE = '1';
process.env.FILE_STORE_DIR = `/tmp/jw-files-m-${process.pid}`;
process.env.FILE_TOKEN_SECRET = 'test-file-token-secret-0123456789abcdef';

type App = Awaited<ReturnType<typeof import('@jw/api').createApp>>;
let app: App;
const mig = pool('app_migrator');
const rw = pool('app_rw');
interface Res { statusCode: number; json(): any; headers: Record<string, unknown>; body: string }
const call = (method: string, path: string, o: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Res> =>
  app.inject({ method: method as 'GET', url: `/api${path}`, payload: o.body as object,
    headers: { ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.headers ?? {}) } }) as unknown as Promise<Res>;
const im = (v: number | string) => ({ 'if-match': `"${v}"` });
const cookieOf = (r: Res, name = 'sid') => {
  const raw = ([] as string[]).concat((r.headers['set-cookie'] as string | string[]) ?? []).find((c) => c.startsWith(`${name}=`));
  return raw ? raw.split(';')[0] : '';
};
const login = async (tenant: string, l: string, password: string) => cookieOf(await call('POST', '/v1/auth/login', { body: { tenant, login: l, password } }));
async function asMigrator<T>(tenantId: string, sql: string, params: unknown[] = []) {
  const c = await mig.connect();
  try {
    await c.query('BEGIN'); await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    const r = await c.query(sql, params); await c.query('COMMIT'); return r.rows as T[];
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-png-body-for-tests')]);
const PDF = Buffer.from('%PDF-1.4\n% test\n');
const multipart = (fields: Record<string, string>, file: { name: string; buf: Buffer }) => {
  const B = '----jwmasters';
  const body = Buffer.concat([
    ...Object.entries(fields).map(([k, v]) => Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)),
    Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    file.buf, Buffer.from(`\r\n--${B}--\r\n`)]);
  return { body, type: `multipart/form-data; boundary=${B}` };
};
const post = (path: string, cookie: string, fields: Record<string, string>, file: { name: string; buf: Buffer }, headers: Record<string, string> = {}) => {
  const m = multipart(fields, file);
  return app.inject({ method: 'POST', url: `/api${path}`, payload: m.body, headers: { 'content-type': m.type, cookie, ...headers } }) as unknown as Promise<Res>;
};
const upload = (cookie: string, purpose: string, buf = PNG, headers: Record<string, string> = {}) => post('/v1/files', cookie, { purpose }, { name: `${purpose}.bin`, buf }, headers);

const SLUG = `masters-${Date.now() % 100000}`;
const SLUG_B = `${SLUG}-b`;
let tenantId = ''; let bTenant = ''; let owner = ''; let manager = ''; let cashier = ''; let bOwner = ''; let branchId = '';
const ids: Record<string, string> = {};

beforeAll(async () => {
  const { hashPassword } = await import('@jw/mod-platform');
  await mig.query(`INSERT INTO platform.platform_admin(email, name, password_hash) VALUES ('ops@jewelos.test', 'Ops', $1) ON CONFLICT (email) DO NOTHING`,
    [await hashPassword('admin-pass-123')]);
  app = await (await import('@jw/api')).createApp();
  const admin = cookieOf(await call('POST', '/v1/admin/auth/login', { body: { email: 'ops@jewelos.test', password: 'admin-pass-123' } }), 'admin_sid');
  const mk = async (slug: string, gstin: string, branch: string, user: string, pw: string) => {
    const r = await call('POST', '/v1/admin/tenants', { cookie: admin, body: { slug, display_name: slug,
      company: { legal_name: slug, gstin, state_code: '33' }, branch: { code: branch, name: branch }, owner: { name: user, username: user, password: pw } } });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id as string;
  };
  tenantId = await mk(SLUG, '33AAAAA1111A1Z5', 'MDU', 'mowner', 'owner-pass-123');
  bTenant = await mk(SLUG_B, '33BBBBB2222B1Z5', 'CBE', 'bowner', 'owner-pass-456');
  owner = await login(SLUG, 'mowner', 'owner-pass-123');
  bOwner = await login(SLUG_B, 'bowner', 'owner-pass-456');
  branchId = (await call('GET', '/v1/branches', { cookie: owner })).json()[0].id;
  for (const [name, role, pw] of [['mmgr', 'manager', 'manager-pass-1'], ['mcash', 'cashier', 'cash-pass-1234']]) {
    const r = await call('POST', '/v1/users', { cookie: owner, body: { name, username: name, password: pw, roles: [{ role, branch_id: role === 'manager' ? null : branchId }], default_branch_id: branchId } });
    expect(r.statusCode, r.body).toBe(201);
  }
  manager = await login(SLUG, 'mmgr', 'manager-pass-1');
  cashier = await login(SLUG, 'mcash', 'cash-pass-1234');
  expect(owner && manager && cashier && bOwner).toBeTruthy();
});
afterAll(async () => { await app?.close(); await mig.end(); await rw.end(); });

describe('masters 0.7: metals/purities on masters.metals.*', () => {
  it('cashier can read but not write; owner creates metal + purity', async () => {
    expect((await call('POST', '/v1/masters/metals', { cookie: cashier, body: { code: 'GLD', name: 'Gold', default_hsn: '7113' } })).statusCode).toBe(403);
    expect((await call('GET', '/v1/masters/metals', { cookie: cashier })).statusCode).toBe(200);
    const m = await call('POST', '/v1/masters/metals', { cookie: manager, body: { code: 'GLD', name: 'Gold', default_hsn: '7113' } });
    expect(m.statusCode, m.body).toBe(201); ids.metal = m.json().id;
    const p = await call('POST', '/v1/masters/purities', { cookie: owner, body: { metal_id: ids.metal, code: '22K', fineness: '916' } });
    expect(p.statusCode, p.body).toBe(201); ids.purity = p.json().id;
    expect((await call('POST', '/v1/masters/purities', { cookie: cashier, body: { metal_id: ids.metal, code: '18K', fineness: '750' } })).statusCode).toBe(403);
  });
});

describe('masters 0.7: generic CRUD, If-Match, inactive, paging, q, permissions', () => {
  // ordered: later bodies use ids of earlier rows
  const cases: { res: string; body: () => Record<string, unknown>; patch: Record<string, unknown>; q: string; key: string }[] = [
    { res: 'items', key: 'item', q: 'RING', body: () => ({ code: 'RING', name: 'Ring', metal_id: ids.metal, purity_id: ids.purity, hsn: '7113', stock_type: 'tag' }), patch: { name: 'Ring 22K' } },
    { res: 'sub-items', key: 'sub', q: 'LAD', body: () => ({ item_id: ids.item, code: 'LADIES', name: 'Ladies ring' }), patch: { name: 'Ladies' } },
    { res: 'designs', key: 'design', q: 'Leaf', body: () => ({ code: 'D001', name: 'Leaf ring', item_id: ids.item, sub_item_id: ids.sub, tags: ['leaf'] }), patch: { size: '12' } },
    { res: 'stone-standards', key: 'stone', q: 'DIA', body: () => ({ kind: 'stone', code: 'DIA', name: 'Diamond' }), patch: { name: 'Diamond (natural)' } },
    { res: 'stone-rates', key: 'rate', q: 'DIA', body: () => ({ stone_id: ids.stone, sale_rate: '50000.00', effective_from: '2026-01-01' }), patch: { sale_rate: '51000.00' } },
    { res: 'value-addition-rules', key: 'va', q: 'RING', body: () => ({ scope: 'customer', item_id: ids.item, mc_per_gram: '350.00' }), patch: { mc_per_gram: '360.00' } },
    { res: 'customers', key: 'customer', q: 'Anu', body: () => ({ name: 'Anu', phone: '9876500001', pan: 'ABCDE1234F' }), patch: { email: 'anu@example.com' } },
    { res: 'vendors', key: 'vendor', q: 'Karigar', body: () => ({ code: 'V1', name: 'Karigar One', kinds: ['smith'], pan: 'ABCDE1234G', contacts: [{ name: 'Ravi', role: 'owner' }], addresses: [{ city: 'Madurai', pincode: '625001' }] }), patch: { name: 'Karigar 1' } },
    { res: 'staff', key: 'staff', q: 'Sales', body: () => ({ code: 'S1', name: 'Priya', branch_id: branchId, department: '   ', designation: 'Sales', pan: 'ABCDE1234H' }), patch: { department: 'Front desk' } },
    { res: 'floors', key: 'floor', q: 'Ground', body: () => ({ branch_id: branchId, code: 'GF', name: 'Ground' }), patch: { name: 'Ground floor' } },
    { res: 'counters', key: 'counter', q: 'C1', body: () => ({ branch_id: branchId, floor_id: ids.floor, code: 'C1', name: 'Counter 1' }), patch: { name: 'Counter one' } },
    { res: 'trays', key: 'tray', q: 'T1', body: () => ({ counter_id: ids.counter, code: 'T1', sub_item_id: ids.sub }), patch: { name: 'Tray one' } },
    { res: 'hsn-codes', key: 'hsn', q: '711319', body: () => ({ code_type: 'HSN', code: '71131990', description: 'Other gold jewellery' }), patch: { description: 'Gold jewellery, other' } },
    { res: 'payment-modes', key: 'pm', q: 'UPIX', body: () => ({ code: 'UPIX', name: 'UPI extra', kind: 'upi' }), patch: { sort_order: 5 } },
    { res: 'card-machines', key: 'cm', q: 'CM1', body: () => ({ branch_id: branchId, code: 'CM1', provider: 'HDFC', terminal_id: 'TID1234', supports: ['upi'] }), patch: { provider: 'HDFC Bank' } },
    { res: 'repair-types', key: 'repairType', q: 'Polish', body: () => ({ name: 'Polish', sac: '998892', min_customer_charge: '100.00', max_customer_charge: '500.00', max_vendor_charge: '200.00' }), patch: { max_customer_charge: '600.00' } },
  ];
  for (const c of cases) {
    it(`${c.res}: 201+ETag, GET, 428/412/200, q, deactivate, cashier 403`, async () => {
      const r = await call('POST', `/v1/masters/${c.res}`, { cookie: owner, body: c.body() });
      expect(r.statusCode, r.body).toBe(201);
      expect(r.headers.etag).toBe('"1"');
      const row = r.json(); ids[c.key] = row.id;
      expect(row).toMatchObject({ version: 1, is_active: true });
      expect(JSON.stringify(row)).not.toMatch(/aadhaar/);
      const g = await call('GET', `/v1/masters/${c.res}/${row.id}`, { cookie: cashier });
      expect(g.statusCode, g.body).toBe(200); expect(g.headers.etag).toBe('"1"');
      expect((await call('POST', `/v1/masters/${c.res}`, { cookie: cashier, body: c.body() })).statusCode).toBe(403);
      expect((await call('PATCH', `/v1/masters/${c.res}/${row.id}`, { cookie: owner, body: c.patch })).statusCode).toBe(428);
      expect((await call('PATCH', `/v1/masters/${c.res}/${row.id}`, { cookie: owner, headers: im(7), body: c.patch })).statusCode).toBe(412);
      expect((await call('PATCH', `/v1/masters/${c.res}/${row.id}`, { cookie: cashier, headers: im(1), body: c.patch })).statusCode).toBe(403);
      const p = await call('PATCH', `/v1/masters/${c.res}/${row.id}`, { cookie: owner, headers: im(1), body: c.patch });
      expect(p.statusCode, p.body).toBe(200); expect(p.json()).toMatchObject({ version: 2 }); expect(p.headers.etag).toBe('"2"');
      expect((await call('PATCH', `/v1/masters/${c.res}/00000000-0000-7000-8000-000000000000`, { cookie: owner, headers: im(1), body: c.patch })).statusCode).toBe(404);
      const l = await call('GET', `/v1/masters/${c.res}?q=${encodeURIComponent(c.q)}&limit=5`, { cookie: owner });
      expect(l.statusCode, l.body).toBe(200);
      expect(l.json().items.map((x: { id: string }) => x.id)).toContain(row.id);
      expect(l.json()).toHaveProperty('next_cursor');
      expect((await call('GET', `/v1/masters/${c.res}?q=zz-no-such-thing-zz`, { cookie: owner })).json().items).toHaveLength(0);
    });
  }

  it('keyset paging and invalid cursor', async () => {
    for (const code of ['PA', 'PB', 'PC']) expect((await call('POST', '/v1/masters/stone-standards', { cookie: owner, body: { kind: 'shape', code, name: `Shape ${code}` } })).statusCode).toBe(201);
    const p1 = (await call('GET', '/v1/masters/stone-standards?limit=2', { cookie: owner })).json();
    expect(p1.items).toHaveLength(2); expect(p1.next_cursor).toEqual(expect.any(String));
    const p2 = (await call('GET', `/v1/masters/stone-standards?limit=2&cursor=${p1.next_cursor}`, { cookie: owner })).json();
    expect(p2.items.map((x: { id: string }) => x.id)).not.toContain(p1.items[0].id);
    expect((await call('GET', '/v1/masters/stone-standards?cursor=@@bad', { cookie: owner })).json().code).toBe('invalid_cursor');
    expect((await call('GET', '/v1/masters/stone-standards?limit=500', { cookie: owner })).statusCode).toBe(422);
  });

  it('inactive: hidden by default, include_inactive shows it, referencing it → 422 inactive_master; unknown ref → 422 unknown_reference', async () => {
    const s = await call('POST', '/v1/masters/sub-items', { cookie: owner, body: { item_id: ids.item, code: 'GENTS', name: 'Gents ring' } });
    const off = await call('PATCH', `/v1/masters/sub-items/${s.json().id}`, { cookie: owner, headers: im(1), body: { is_active: false } });
    expect(off.json()).toMatchObject({ is_active: false, version: 2 });
    expect((await call('GET', '/v1/masters/sub-items?q=GENTS', { cookie: owner })).json().items).toHaveLength(0);
    expect((await call('GET', '/v1/masters/sub-items?q=GENTS&include_inactive=true', { cookie: owner })).json().items).toHaveLength(1);
    const d = await call('POST', '/v1/masters/designs', { cookie: owner, body: { code: 'D002', name: 'Plain', item_id: ids.item, sub_item_id: s.json().id } });
    expect(d.json()).toMatchObject({ status: 422, code: 'inactive_master' });
    const u = await call('POST', '/v1/masters/designs', { cookie: owner, body: { code: 'D003', name: 'Plain', item_id: '00000000-0000-7000-8000-000000000000' } });
    expect(u.json()).toMatchObject({ status: 422, code: 'unknown_reference' });
    expect((await call('POST', '/v1/masters/items', { cookie: owner, body: { code: 'RING', name: 'Dup', metal_id: ids.metal, purity_id: ids.purity, hsn: '7113', stock_type: 'tag' } })).json())
      .toMatchObject({ status: 409, code: 'duplicate_code' });
    expect((await call('POST', '/v1/masters/items', { cookie: owner, body: { code: 'BANG', name: 'Bangle', metal_id: ids.metal, purity_id: ids.purity, hsn: '9999', stock_type: 'tag' } })).json())
      .toMatchObject({ status: 422, code: 'unknown_hsn' });
  });

  it('staff: blank department → null, free-text designation; no department_id / aadhaar in the API', async () => {
    const s = (await call('GET', `/v1/masters/staff/${ids.staff}`, { cookie: owner })).json();
    expect(s).toMatchObject({ department: 'Front desk', designation: 'Sales', pan_last4: '234H' });
    expect(s).not.toHaveProperty('department_id'); expect(s).not.toHaveProperty('aadhaar_last4'); expect(s).not.toHaveProperty('pan_enc');
    const n = await call('POST', '/v1/masters/staff', { cookie: owner, body: { code: 'S2', name: 'Blank', branch_id: branchId, department: '', designation: ' \t ' } });
    expect(n.json()).toMatchObject({ department: null, designation: null });
    expect((await call('POST', '/v1/masters/staff', { cookie: owner, body: { code: 'S3', name: 'Long', branch_id: branchId, department: 'x'.repeat(101) } })).statusCode).toBe(422);
    expect((await call('POST', '/v1/masters/staff', { cookie: owner, body: { code: 'S4', name: 'Old', branch_id: branchId, department_id: ids.floor } })).statusCode).toBe(422);
  });

  it('vendor contacts/addresses shapes (G7) are validated', async () => {
    const v = (await call('GET', `/v1/masters/vendors/${ids.vendor}`, { cookie: owner })).json();
    expect(v).toMatchObject({ contacts: [{ name: 'Ravi', role: 'owner' }], addresses: [{ city: 'Madurai', pincode: '625001' }], pan_last4: '234G' });
    expect((await call('POST', '/v1/masters/vendors', { cookie: owner, body: { code: 'V9', name: 'Bad', kinds: [], contacts: [{ phone: '9876500009' }] } })).statusCode).toBe(422);
    expect((await call('POST', '/v1/masters/vendors', { cookie: owner, body: { code: 'V9', name: 'Bad', kinds: [], addresses: [{ pincode: '12' }] } })).statusCode).toBe(422);
  });
});

describe('masters 0.7: no Aadhaar; KYC documents', () => {
  it('aadhaar_last4 on customer / vendor / staff → 422 aadhaar_not_allowed', async () => {
    for (const [res, body] of [['customers', { name: 'X', aadhaar_last4: '1234' }], ['vendors', { code: 'VA', name: 'X', kinds: [], aadhaar_last4: '1234' }],
      ['staff', { code: 'SA', name: 'X', branch_id: branchId, aadhaar_last4: '1234' }]] as const) {
      const r = await call('POST', `/v1/masters/${res}`, { cookie: owner, body });
      expect(r.json(), res).toMatchObject({ status: 422, code: 'aadhaar_not_allowed' });
    }
  });

  it('kyc doc_type enum: aadhaar → 422 aadhaar_not_allowed, unknown → 422; pan stored sealed, last4 only', async () => {
    const f = await upload(owner, 'kyc_document', PDF);
    expect(f.statusCode, f.body).toBe(201); ids.kycFile = f.json().id;
    const base = { party_type: 'customer', party_id: ids.customer, front_file_id: ids.kycFile };
    expect((await call('POST', '/v1/masters/kyc-documents', { cookie: owner, body: { ...base, doc_type: 'aadhaar', number: '123412341234' } })).json())
      .toMatchObject({ status: 422, code: 'aadhaar_not_allowed' });
    expect((await call('POST', '/v1/masters/kyc-documents', { cookie: owner, body: { ...base, doc_type: 'ration_card', number: 'RC1234' } })).statusCode).toBe(422);
    const types = ['pan', 'passport', 'voter_id', 'driving_licence', 'gstin_certificate', 'other'];
    const r = await call('POST', '/v1/masters/kyc-documents', { cookie: owner, body: { ...base, doc_type: types[0], number: 'ABCDE1234F' } });
    expect(r.statusCode, r.body).toBe(201); ids.kyc = r.json().id;
    expect(r.json()).toMatchObject({ doc_type: 'pan', number_last4: '234F', party_id: ids.customer, status: 'pending' });
    expect(r.body).not.toMatch(/ABCDE1234F/);
    const p = await call('POST', '/v1/masters/kyc-documents', { cookie: owner, body: { ...base, doc_type: 'passport', number: 'P1234567' } });
    expect(p.statusCode, p.body).toBe(201);
    const v = await call('PATCH', `/v1/masters/kyc-documents/${ids.kyc}`, { cookie: owner, headers: im(1), body: { status: 'verified' } });
    expect(v.json()).toMatchObject({ status: 'verified', verified_at: expect.any(String) });
    expect((await call('GET', `/v1/masters/kyc-documents?q=234F`, { cookie: owner })).json().items.map((x: { id: string }) => x.id)).toContain(ids.kyc);
    const [sec] = await asMigrator<{ n: number }>(tenantId, `SELECT count(*)::int n FROM masters.kyc_document_secret WHERE kyc_document_id = $1`, [ids.kyc]);
    expect(sec.n).toBe(1);
  });
});

describe('masters 0.7: KYC reveal (G2, 984 masters.kyc.reveal)', () => {
  const reveal = (cookie: string, party: string, id: string, body: unknown = { reason: 'customer asked for invoice correction' }) =>
    call('POST', `/v1/masters/${party}/${id}/kyc/reveal`, { cookie, body });
  it('cashier 403; reason mandatory (422); unknown party 404', async () => {
    expect((await reveal(cashier, 'customers', ids.customer)).statusCode).toBe(403);
    expect((await reveal(owner, 'customers', ids.customer, {})).statusCode).toBe(422);
    expect((await reveal(owner, 'customers', ids.customer, { reason: 'short' })).statusCode).toBe(422);
    expect((await reveal(owner, 'invoices', ids.customer)).statusCode).toBe(404);
    expect((await reveal(owner, 'customers', '00000000-0000-7000-8000-000000000000')).statusCode).toBe(404);
  });
  it('owner sees full PAN + KYC numbers with Cache-Control: no-store; audit rows carry field + reason, never the value', async () => {
    const r = await reveal(owner, 'customers', ids.customer);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.json().pan).toBe('ABCDE1234F');
    expect(r.json().documents.map((d: { number: string }) => d.number).sort()).toEqual(['ABCDE1234F', 'P1234567']);
    const s = await reveal(owner, 'staff', ids.staff);
    expect(s.json().pan).toBe('ABCDE1234H');
    const rows = await asMigrator<{ table_name: string; row_id: string; new_row: { field: string; reason: string } }>(tenantId,
      `SELECT table_name, row_id::text AS row_id, new_row FROM platform.audit_event WHERE action = 'kyc.reveal' ORDER BY seq`);
    expect(rows.map((x) => `${x.table_name}:${x.new_row.field}`)).toEqual(['masters.customer:pan', 'masters.kyc_document:number', 'masters.kyc_document:number', 'hr.staff:pan']);
    expect(rows[0]).toMatchObject({ row_id: ids.customer, new_row: { field: 'pan', reason: 'customer asked for invoice correction' } });
    const all = JSON.stringify(rows);
    for (const secret of ['ABCDE1234F', 'P1234567', 'ABCDE1234H']) expect(all).not.toContain(secret);
  });
  it('vendor reveal works; 11th reveal within the hour → 429 rate_limited with Retry-After (per-process until the bucket CHECK admits kyc.reveal)', async () => {
    const v = await reveal(manager, 'vendors', ids.vendor);
    expect(v.statusCode, v.body).toBe(200); expect(v.json().pan).toBe('ABCDE1234G');
    for (let i = 0; i < 9; i++) expect((await reveal(manager, 'customers', ids.customer)).statusCode).toBe(200);
    const x = await reveal(manager, 'customers', ids.customer);
    expect(x.statusCode).toBe(429); expect(x.json().code).toBe('rate_limited');
    expect(Number(x.headers['retry-after'])).toBeGreaterThan(0);
    expect(x.headers['cache-control']).toBe('no-store');
  });
});

describe('masters 0.7: vendor PAN backfill verification (vendor.pan drop held)', () => {
  it('pan written to legacy column and sealed column; status counts; mismatch makes it not ready', async () => {
    expect((await call('GET', '/v1/masters/vendors/pan-backfill-status', { cookie: cashier })).statusCode).toBe(403);
    const s1 = await call('GET', '/v1/masters/vendors/pan-backfill-status', { cookie: owner });
    expect(s1.statusCode, s1.body).toBe(200);
    expect(s1.json()).toMatchObject({ matched: 1, mismatched: 0, legacy_only: 0, ready_to_drop_legacy: true });
    const [row] = await asMigrator<{ pan: string; enc: boolean }>(tenantId, `SELECT pan, pan_enc IS NOT NULL AS enc FROM masters.vendor WHERE id = $1`, [ids.vendor]);
    expect(row).toEqual({ pan: 'ABCDE1234G', enc: true });
    await asMigrator(tenantId, `UPDATE masters.vendor SET pan = 'ZZZZZ9999Z' WHERE id = $1`, [ids.vendor]);   // test-DB fixture only
    expect((await call('GET', '/v1/masters/vendors/pan-backfill-status', { cookie: owner })).json()).toMatchObject({ mismatched: 1, ready_to_drop_legacy: false });
    await asMigrator(tenantId, `UPDATE masters.vendor SET pan = 'ABCDE1234G' WHERE id = $1`, [ids.vendor]);
  });
});

describe('masters 0.7.2: legacy-only vendor PAN (reveal not_migrated, backfill job)', () => {
  it('reveal returns masked legacy pan + pan_not_migrated; backfill is dry-run by default, then seals; reveal then returns full PAN', async () => {
    const c = await call('POST', '/v1/masters/vendors', { cookie: owner, body: { code: 'VL', name: 'Legacy Smith', kinds: ['smith'] } });
    expect(c.statusCode, c.body).toBe(201);
    const vid = c.json().id as string;
    await asMigrator(tenantId, `UPDATE masters.vendor SET pan = 'LEGCY1234K' WHERE id = $1`, [vid]);   // test-DB fixture: pre-984 legacy row
    const rev = (cookie: string) => call('POST', `/v1/masters/vendors/${vid}/kyc/reveal`, { cookie, body: { reason: 'legacy vendor pan check' } });
    const r1 = await rev(owner);
    expect(r1.statusCode, r1.body).toBe(200);
    expect(r1.json()).toMatchObject({ pan: 'XXXXXX234K', pan_not_migrated: true });
    expect(r1.body).not.toContain('LEGCY1234K');
    expect((await call('POST', '/v1/masters/vendors/pan-backfill', { cookie: cashier, body: {} })).statusCode).toBe(403);
    expect((await call('POST', '/v1/masters/vendors/pan-backfill', { cookie: owner, body: { dry_run: 'no' } })).statusCode).toBe(422);
    const d = await call('POST', '/v1/masters/vendors/pan-backfill', { cookie: owner, body: {} });
    expect(d.statusCode, d.body).toBe(200);
    expect(d.json()).toEqual({ dry_run: true, candidates: 1, invalid: 0, written: 0 });
    expect((await call('GET', '/v1/masters/vendors/pan-backfill-status', { cookie: owner })).json()).toMatchObject({ legacy_only: 1, ready_to_drop_legacy: false });
    const w = await call('POST', '/v1/masters/vendors/pan-backfill', { cookie: owner, body: { dry_run: false } });
    expect(w.json()).toEqual({ dry_run: false, candidates: 1, invalid: 0, written: 1 });
    expect((await call('GET', '/v1/masters/vendors/pan-backfill-status', { cookie: owner })).json()).toMatchObject({ legacy_only: 0, mismatched: 0, ready_to_drop_legacy: true });
    const r2 = await rev(owner);
    expect(r2.json()).toMatchObject({ pan: 'LEGCY1234K', pan_not_migrated: false });
    expect((await call('POST', '/v1/masters/vendors/pan-backfill', { cookie: owner, body: { dry_run: false } })).json()).toMatchObject({ candidates: 0, written: 0 });
  });
});

describe('masters 0.7: design photos (M4, G3, G4)', () => {
  let f1 = ''; let f2 = ''; let f3 = ''; let photo1 = '';
  it('upload: permission per purpose, sniffed type, pdf not allowed for photos', async () => {
    expect((await upload(cashier, 'design_photo')).statusCode).toBe(403);
    expect((await upload(owner, 'design_photo', PDF)).json().code).toBe('unsupported_file');
    expect((await upload(owner, 'selfie')).statusCode).toBe(422);
    f1 = (await upload(owner, 'design_photo')).json().id;
    f2 = (await upload(owner, 'design_photo', Buffer.concat([PNG, Buffer.from('2')]))).json().id;
    f3 = (await upload(owner, 'design_photo', Buffer.concat([PNG, Buffer.from('3')]))).json().id;
    expect([f1, f2, f3].every(Boolean)).toBe(true);
  });
  it('attach: first is cover; 409 already_attached; files/url readable with masters.designs.view (cashier)', async () => {
    const a = await call('POST', `/v1/masters/designs/${ids.design}/photos`, { cookie: owner, body: { file_id: f1 } });
    expect(a.statusCode, a.body).toBe(201); expect(a.json()).toMatchObject({ is_primary: true }); photo1 = a.json().id;
    expect((await call('POST', `/v1/masters/designs/${ids.design}/photos`, { cookie: owner, body: { file_id: f2, sort_order: 1 } })).statusCode).toBe(201);
    expect((await call('POST', `/v1/masters/designs/${ids.design}/photos`, { cookie: owner, body: { file_id: f3, sort_order: 2 } })).statusCode).toBe(201);
    expect((await call('POST', `/v1/masters/designs/${ids.design}/photos`, { cookie: owner, body: { file_id: f1 } })).json().code).toBe('already_attached');
    expect((await call('POST', `/v1/masters/designs/${ids.design}/photos`, { cookie: owner, body: { file_id: ids.kycFile } })).json().code).toBe('unsupported_file');
    const u = await call('GET', `/v1/files/${f1}/url`, { cookie: cashier });
    expect(u.statusCode, u.body).toBe(200);
    const d = await app.inject({ method: 'GET', url: u.json().url }) as unknown as Res;
    expect(d.statusCode).toBe(200);
    expect((await call('GET', `/v1/files/${ids.kycFile}/url`, { cookie: cashier })).statusCode).toBe(403);   // kyc files need <party>.manage
    const g = (await call('GET', `/v1/masters/designs/${ids.design}`, { cookie: owner })).json();
    expect(g.primary_photo_file_id).toBe(f1);
  });
  it('reorder + cover (If-Match on design version); photo_set_mismatch; stale 412', async () => {
    const v = Number(String((await call('GET', `/v1/masters/designs/${ids.design}`, { cookie: owner })).headers.etag).replace(/"/g, ''));
    const path = `/v1/masters/designs/${ids.design}/photos`;
    expect((await call('PATCH', path, { cookie: owner, body: { order: [f3, f2, f1] } })).statusCode).toBe(428);
    expect((await call('PATCH', path, { cookie: owner, headers: im(v), body: { order: [f3, f2] } })).json().code).toBe('photo_set_mismatch');
    expect((await call('PATCH', path, { cookie: owner, headers: im(v), body: { order: [f3, f2, f2] } })).statusCode).toBe(422);
    const r = await call('PATCH', path, { cookie: owner, headers: im(v), body: { order: [f3, f2, f1], cover_file_id: f2 } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().design_version).toBe(v + 1); expect(r.headers.etag).toBe(`"${v + 1}"`);
    expect(r.json().photos.map((p: { file_id: string; sort_order: number; is_primary: boolean }) => [p.file_id, p.sort_order, p.is_primary]))
      .toEqual([[f3, 0, false], [f2, 1, true], [f1, 2, false]]);
    expect((await call('PATCH', path, { cookie: owner, headers: im(v), body: { order: [f1, f2, f3] } })).statusCode).toBe(412);
  });
  it('delete one photo needs If-Match on the photo version → 204', async () => {
    const path = `/v1/masters/designs/${ids.design}/photos/${photo1}`;
    expect((await call('DELETE', path, { cookie: owner })).statusCode).toBe(428);
    const list = (await call('GET', `/v1/masters/designs/${ids.design}/photos`, { cookie: owner })).json();
    const gone = list.find((p: { id: string }) => p.id === photo1);
    const ver = gone.version;
    expect((await call('DELETE', path, { cookie: owner, headers: im(ver + 5) })).statusCode).toBe(412);
    expect((await call('DELETE', path, { cookie: owner, headers: im(ver) })).statusCode).toBe(204);
    expect((await call('GET', `/v1/masters/designs/${ids.design}/photos`, { cookie: owner })).json()).toHaveLength(2);
    // app_rw soft-deletes the now-unused platform.file (deleted_at only)
    const [f] = await asMigrator<{ d: boolean }>(tenantId, `SELECT deleted_at IS NOT NULL AS d FROM platform.file WHERE id = $1`, [gone.file_id]);
    expect(f.d).toBe(true);
  });
});

describe('masters 0.7: Idempotency-Key on creates (G5, 973)', () => {
  it('generic create: replay returns the same row; different body → 422; bad key → 422', async () => {
    const key = 'masters-floor-key-0001';
    const body = { branch_id: branchId, code: 'FF', name: 'First' };
    const a = await call('POST', '/v1/masters/floors', { cookie: owner, body, headers: { 'idempotency-key': key } });
    expect(a.statusCode, a.body).toBe(201);
    const b = await call('POST', '/v1/masters/floors', { cookie: owner, body, headers: { 'idempotency-key': key } });
    expect(b.statusCode).toBe(201); expect(b.json().id).toBe(a.json().id); expect(b.headers.etag).toBe('"1"');
    expect((await call('POST', '/v1/masters/floors', { cookie: owner, body: { ...body, name: 'Other' }, headers: { 'idempotency-key': key } })).json().code).toBe('idempotency_key_reused');
    expect((await call('POST', '/v1/masters/floors', { cookie: owner, body, headers: { 'idempotency-key': 'short' } })).statusCode).toBe(422);
    const [{ n }] = await asMigrator<{ n: number }>(tenantId, `SELECT count(*)::int n FROM masters.floor WHERE code = 'FF'`);
    expect(n).toBe(1);
  });
  it('photo attach and file upload honour the key', async () => {
    const f = (await upload(owner, 'design_photo', Buffer.concat([PNG, Buffer.from('idem')]), { 'idempotency-key': 'upload-key-000000001' })).json();
    const f2 = await upload(owner, 'design_photo', Buffer.concat([PNG, Buffer.from('idem')]), { 'idempotency-key': 'upload-key-000000001' });
    expect(f2.statusCode).toBe(201); expect(f2.json().id).toBe(f.id);
    expect((await upload(owner, 'design_photo', Buffer.concat([PNG, Buffer.from('other')]), { 'idempotency-key': 'upload-key-000000001' })).json().code).toBe('idempotency_key_reused');
    const k = { 'idempotency-key': 'photo-key-0000000001' };
    const a = await call('POST', `/v1/masters/designs/${ids.design}/photos`, { cookie: owner, body: { file_id: f.id }, headers: k });
    expect(a.statusCode, a.body).toBe(201);
    const b = await call('POST', `/v1/masters/designs/${ids.design}/photos`, { cookie: owner, body: { file_id: f.id }, headers: k });
    expect(b.statusCode).toBe(201); expect(b.json().id).toBe(a.json().id);
  });
});

describe('masters 0.7: export ⇄ import round trip (M17)', () => {
  const importCsv = (cookie: string, kind: string, csv: string) => post('/v1/imports', cookie, { kind }, { name: `${kind}.csv`, buf: Buffer.from(csv) });
  it('export metals as csv, edit, re-import as dry run + commit', async () => {
    expect((await call('POST', '/v1/exports', { cookie: cashier, body: { kind: 'metals', format: 'csv' } })).statusCode).toBe(403);
    expect((await call('POST', '/v1/exports', { cookie: owner, body: { kind: 'bank_accounts' } })).statusCode).toBe(422);
    const e = await call('POST', '/v1/exports', { cookie: owner, body: { kind: 'metals', format: 'csv' } });
    expect(e.statusCode, e.body).toBe(201);
    expect(e.json()).toMatchObject({ kind: 'metals', format: 'csv', status: 'completed', row_count: 1, file_id: expect.any(String) });
    const u = await call('GET', `/v1/files/${e.json().file_id}/url`, { cookie: owner });
    expect(u.statusCode, u.body).toBe(200);
    const d = await app.inject({ method: 'GET', url: u.json().url }) as unknown as Res;
    const csv = d.body.replace(/^\uFEFF/, '');
    expect(csv.split(/\r?\n/)[0]).toBe('code,name,default_hsn');
    expect(csv).toContain('GLD,Gold,7113');
    const edited = `${csv.trim()}\r\nSLV,Silver,7113\r\n`;
    const dry = await importCsv(owner, 'metals', edited);
    expect(dry.statusCode, dry.body).toBe(201);
    expect(dry.json()).toMatchObject({ dry_run: true, ok_rows: 1, error_rows: 1 });   // GLD already_exists
    const errs = (await call('GET', `/v1/imports/${dry.json().id}/errors`, { cookie: owner })).json();
    expect(errs.map((x: { code: string }) => x.code)).toEqual(['already_exists']);
    const clean = await importCsv(owner, 'metals', 'code,name,default_hsn\r\nSLV,Silver,7113\r\n');
    expect(clean.json()).toMatchObject({ status: 'validated', ok_rows: 1 });
    const c = await call('POST', `/v1/imports/${clean.json().id}/commit`, { cookie: owner, headers: { 'idempotency-key': 'import-metals-0000001' } });
    expect(c.statusCode, c.body).toBe(201);
    expect((await call('GET', '/v1/masters/metals', { cookie: owner })).json().map((m: { code: string }) => m.code)).toContain('SLV');
    const l = await call('GET', '/v1/exports?limit=1', { cookie: owner });
    expect(l.json().items[0].id).toBe(e.json().id);
  });
  it('items import resolves codes; unknown / inactive codes are row errors; cashier cannot import masters', async () => {
    expect((await importCsv(cashier, 'items', 'code,name\n')).statusCode).toBe(403);
    const r = await importCsv(owner, 'items', 'code,name,metal_code,purity_code,hsn,stock_type\nCHN,Chain,GLD,22K,7113,tag\nX1,Bad,NOPE,22K,7113,tag\nX2,Bad,GLD,22K,9999,tag\n');
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().ok_rows, r.body).toBe(1);   // note: platform error_rows counts errors (3), not failing rows (2)
    expect(new Set(r.json().errors.map((x: { row: number }) => x.row))).toEqual(new Set([3, 4]));
    const errs = (await call('GET', `/v1/imports/${r.json().id}/errors`, { cookie: owner })).json();
    expect(errs.filter((x: { row: number }) => x.row === 3).map((x: { code: string }) => x.code)).toContain('not_found');
    expect(errs.filter((x: { row: number }) => x.row === 4).map((x: { code: string }) => x.code)).toEqual(['unknown_hsn']);
    const x = await call('POST', '/v1/exports', { cookie: owner, body: { kind: 'items', format: 'xlsx' } });
    expect(x.json()).toMatchObject({ status: 'completed', format: 'xlsx', row_count: 1 });
  });
});

describe('masters 0.7.3: customer kyc_consent (G18) and bank account picker (G20)', () => {
  it('kyc_consent true sets consent_at server-side; false clears it; client cannot send consent_at', async () => {
    const c = await call('POST', '/v1/masters/customers', { cookie: owner, body: { name: 'Consent Test', phone: '+91 91234-00077', kyc_consent: true } });
    expect(c.statusCode, c.body).toBe(201);
    expect(c.json().phone).toBe('9123400077');
    expect(c.json().consent_at).toEqual(expect.any(String));
    expect(c.json()).not.toHaveProperty('kyc_consent');
    expect((await call('POST', '/v1/masters/customers', { cookie: owner, body: { name: 'X', consent_at: '2020-01-01T00:00:00Z' } })).statusCode).toBe(422);
    const p = await call('PATCH', `/v1/masters/customers/${c.json().id}`, { cookie: owner, headers: { 'if-match': `"${c.json().version}"` }, body: { kyc_consent: false } });
    expect(p.statusCode, p.body).toBe(200);
    expect(p.json().consent_at).toBeNull();
    const n = await call('POST', '/v1/masters/customers', { cookie: owner, body: { name: 'No Consent' } });
    expect(n.json().consent_at).toBeNull();
  });
  it('company bank accounts list accepts q and ids (comma or repeated); bad ids → 422', async () => {
    const companies = (await call('GET', '/v1/companies', { cookie: owner })).json();
    const cid = (companies.items ?? companies)[0]?.id as string;
    expect(cid).toEqual(expect.any(String));
    const all = await call('GET', `/v1/companies/${cid}/bank-accounts`, { cookie: owner });
    expect(all.statusCode, all.body).toBe(200);
    expect((await call('GET', `/v1/companies/${cid}/bank-accounts?q=zzzz-no-such-bank`, { cookie: owner })).json()).toEqual([]);
    expect((await call('GET', `/v1/companies/${cid}/bank-accounts?ids=bad`, { cookie: owner })).statusCode).toBe(422);
    const z = '00000000-0000-7000-8000-000000000000';
    expect((await call('GET', `/v1/companies/${cid}/bank-accounts?ids=${z}&ids=${z}`, { cookie: owner })).json()).toEqual([]);
    for (const b of all.json() as { id: string; bank_name: string }[]) {
      expect((await call('GET', `/v1/companies/${cid}/bank-accounts?ids=${b.id}`, { cookie: owner })).json().map((x: { id: string }) => x.id)).toEqual([b.id]);
      expect((await call('GET', `/v1/companies/${cid}/bank-accounts?q=${encodeURIComponent(b.bank_name)}`, { cookie: owner })).json().map((x: { id: string }) => x.id)).toContain(b.id);
    }
  });
});

describe('O13 repair types: charge limits', () => {
  it('a minimum above its maximum is refused (create and patch); null limits are fine; the name is unique', async () => {
    const bad = await call('POST', '/v1/masters/repair-types', { cookie: owner, body: { name: 'Bad range', min_customer_charge: '900.00', max_customer_charge: '100.00' } });
    expect(bad.statusCode, bad.body).toBe(422);
    expect(bad.json().errors?.[0]?.path).toBe('min_customer_charge');
    const ok = await call('POST', '/v1/masters/repair-types', { cookie: owner, body: { name: 'Resize', min_vendor_charge: '50.00' } });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json()).toMatchObject({ max_vendor_charge: null, min_customer_charge: null, sac: null });
    const row = ok.json();
    const p = await call('PATCH', `/v1/masters/repair-types/${row.id}`, { cookie: owner, headers: im(1), body: { max_vendor_charge: '10.00' } });
    expect(p.statusCode, p.body).toBe(422);
    expect((await call('POST', '/v1/masters/repair-types', { cookie: owner, body: { name: 'Resize' } })).statusCode).toBe(409);
    expect((await call('POST', '/v1/masters/repair-types', { cookie: owner, body: { name: 'Odd', sac: 'abc' } })).statusCode).toBe(422);
  });
});

describe('masters 0.7.3: floors import / export kind (986)', () => {
  const importCsv = (cookie: string, csv: string) => post('/v1/imports', cookie, { kind: 'floors' }, { name: 'floors.csv', buf: Buffer.from(csv) });
  it('export floors csv (branch_code,code,name); import a new floor (dry run → commit)', async () => {
    const e = await call('POST', '/v1/exports', { cookie: owner, body: { kind: 'floors', format: 'csv' } });
    expect(e.statusCode, e.body).toBe(201);
    expect(e.json()).toMatchObject({ kind: 'floors', status: 'completed' });
    expect(e.json().row_count).toBeGreaterThan(0);
    const u = (await call('GET', `/v1/files/${e.json().file_id}/url`, { cookie: owner })).json();
    const csv = ((await app.inject({ method: 'GET', url: u.url })) as unknown as Res).body.replace(/^\uFEFF/, '');
    expect(csv.split(/\r?\n/)[0]).toBe('branch_code,code,name');
    const bcode = (await call('GET', '/v1/branches', { cookie: owner })).json()[0].code as string;
    const dry = await importCsv(owner, `branch_code,code,name\r\n${bcode},IMPF,Imported Floor\r\n`);
    expect(dry.statusCode, dry.body).toBe(201);
    expect(dry.json()).toMatchObject({ dry_run: true, ok_rows: 1 });
    const ok = await importCsv(owner, `branch_code,code,name\r\n${bcode},IMPF,Imported Floor\r\n`);
    const c = await call('POST', `/v1/imports/${ok.json().id}/commit`, { cookie: owner, headers: { 'idempotency-key': 'import-floors-0000001' } });
    expect(c.statusCode, c.body).toBe(201);
    const fl = (await call('GET', `/v1/masters/floors?branch_id=${branchId}`, { cookie: owner })).json();
    expect((fl.items ?? fl).map((f: { code: string }) => f.code)).toContain('IMPF');
  });
});

describe('masters 0.7: cross-tenant isolation (API + app_rw RLS)', () => {
  it('shop B never reads, lists, patches or references shop A masters', async () => {
    for (const [res, key] of [['items', 'item'], ['customers', 'customer'], ['vendors', 'vendor'], ['staff', 'staff'], ['designs', 'design'], ['kyc-documents', 'kyc'], ['card-machines', 'cm']]) {
      expect((await call('GET', `/v1/masters/${res}/${ids[key]}`, { cookie: bOwner })).statusCode, res).toBe(404);
      expect((await call('PATCH', `/v1/masters/${res}/${ids[key]}`, { cookie: bOwner, headers: im(1), body: { is_active: false } })).statusCode, res).toBe(404);
      expect((await call('GET', `/v1/masters/${res}?include_inactive=true&limit=200`, { cookie: bOwner })).json().items.map((x: { id: string }) => x.id)).not.toContain(ids[key]);
    }
    expect((await call('POST', `/v1/masters/customers/${ids.customer}/kyc/reveal`, { cookie: bOwner, body: { reason: 'cross tenant probe here' } })).statusCode).toBe(404);
    expect((await call('GET', `/v1/masters/designs/${ids.design}/photos`, { cookie: bOwner })).statusCode).toBe(404);
    expect((await call('GET', `/v1/files/${ids.kycFile}/url`, { cookie: bOwner })).statusCode).toBe(404);
    const bBranch = (await call('GET', '/v1/branches', { cookie: bOwner })).json()[0].id;
    expect((await call('POST', '/v1/masters/counters', { cookie: bOwner, body: { branch_id: bBranch, floor_id: ids.floor, code: 'X', name: 'X' } })).json().code).toBe('unknown_reference');
    const c = await rw.connect();
    try {
      await c.query('BEGIN'); await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [bTenant]);
      for (const [t, id] of [['masters.item', ids.item], ['masters.customer', ids.customer], ['masters.vendor', ids.vendor], ['hr.staff', ids.staff],
        ['masters.kyc_document', ids.kyc], ['masters.design_photo', null], ['masters.kyc_document_secret', null]] as const) {
        const r = id ? await c.query(`SELECT count(*)::int n FROM ${t} WHERE id = $1`, [id]) : await c.query(`SELECT count(*)::int n FROM ${t}`);
        expect(r.rows[0].n, t).toBe(0);
      }
      const u = await c.query(`UPDATE masters.item SET name = 'pwned' WHERE id = $1`, [ids.item]);
      expect(u.rowCount).toBe(0);
      await c.query('ROLLBACK');
    } finally { c.release(); }
  });
});

describe('masters 0.7.1: kyc-documents filters, ?ids= batch lookup, list labels, read gating', () => {
  it('kyc-documents party_type / party_id filters', async () => {
    const v = await call('POST', '/v1/masters/kyc-documents', { cookie: owner, body: { party_type: 'vendor', party_id: ids.vendor, doc_type: 'other', number: 'OTH12345', front_file_id: ids.kycFile } });
    expect(v.statusCode, v.body).toBe(201);
    const byParty = (await call('GET', `/v1/masters/kyc-documents?party_id=${ids.customer}`, { cookie: owner })).json().items;
    expect(byParty).toHaveLength(2);
    expect(byParty.every((d: { party_id: string }) => d.party_id === ids.customer)).toBe(true);
    const vend = (await call('GET', '/v1/masters/kyc-documents?party_type=vendor', { cookie: owner })).json().items;
    expect(vend.map((d: { id: string }) => d.id)).toEqual([v.json().id]);
    expect((await call('GET', `/v1/masters/kyc-documents?party_type=vendor&party_id=${ids.customer}`, { cookie: owner })).json().items).toHaveLength(0);
    expect((await call('GET', '/v1/masters/kyc-documents?party_id=nope', { cookie: owner })).statusCode).toBe(422);
  });
  it('?ids= returns exactly the requested rows (max 100, uuids only), respects include_inactive', async () => {
    const r = await call('GET', `/v1/masters/floors?ids=${ids.floor},00000000-0000-7000-8000-000000000000`, { cookie: cashier });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().items.map((x: { id: string }) => x.id)).toEqual([ids.floor]);
    expect((await call('GET', '/v1/masters/floors?ids=bad', { cookie: owner })).statusCode).toBe(422);
    const many = Array.from({ length: 101 }, (_, i) => `00000000-0000-7000-8000-${String(i).padStart(12, '0')}`).join(',');
    expect((await call('GET', `/v1/masters/floors?ids=${many}`, { cookie: owner })).statusCode).toBe(422);
    const m = await call('GET', `/v1/masters/metals?ids=${ids.metal}`, { cookie: owner });
    expect(m.json().map((x: { id: string }) => x.id)).toEqual([ids.metal]);
    expect((await call('GET', `/v1/masters/purities?ids=${ids.purity}`, { cookie: owner })).json()).toHaveLength(1);
    // G17: repeated ids= (explode) is accepted as well as comma-joined
    const rep = await call('GET', `/v1/masters/floors?ids=${ids.floor}&ids=00000000-0000-7000-8000-000000000000`, { cookie: owner });
    expect(rep.statusCode, rep.body).toBe(200);
    expect(rep.json().items.map((x: { id: string }) => x.id)).toEqual([ids.floor]);
    expect((await call('GET', `/v1/masters/metals?ids=${ids.metal}&ids=${ids.metal}`, { cookie: owner })).json().map((x: { id: string }) => x.id)).toEqual([ids.metal]);
    expect((await call('GET', `/v1/masters/floors?ids=${ids.floor}&ids=bad`, { cookie: owner })).statusCode).toBe(422);
    const s = (await call('GET', '/v1/masters/sub-items?q=GENTS', { cookie: owner })).json().items;
    expect(s).toHaveLength(0);
    const off = (await call('GET', '/v1/masters/sub-items?q=GENTS&include_inactive=true', { cookie: owner })).json().items[0].id;
    expect((await call('GET', `/v1/masters/sub-items?ids=${off}`, { cookie: owner })).json().items).toHaveLength(0);
    expect((await call('GET', `/v1/masters/sub-items?ids=${off}&include_inactive=true`, { cookie: owner })).json().items).toHaveLength(1);
  });
  it('list rows carry labels for referenced ids (not single reads)', async () => {
    const items = (await call('GET', `/v1/masters/items?ids=${ids.item}`, { cookie: owner })).json().items;
    expect(items[0].labels).toMatchObject({ metal_id: { code: 'GLD', name: 'Gold' }, purity_id: { code: '22K' } });
    const trays = (await call('GET', `/v1/masters/trays?ids=${ids.tray}`, { cookie: owner })).json().items;
    expect(trays[0].labels).toMatchObject({ counter_id: { code: 'C1' }, sub_item_id: { code: 'LADIES' } });
    expect((await call('GET', `/v1/masters/items/${ids.item}`, { cookie: owner })).json()).not.toHaveProperty('labels');
  });
  it('customer reads are gated on masters.customers.view (cashier and salesperson have it per 982 seeds)', async () => {
    expect((await call('GET', '/v1/masters/customers')).statusCode).toBe(401);
    expect((await call('GET', `/v1/masters/customers/${ids.customer}`, { cookie: cashier })).statusCode).toBe(200);
    const [{ roles }] = await asMigrator<{ roles: string[] }>(tenantId,
      `SELECT array_agg(role_code ORDER BY role_code) AS roles FROM platform.system_role_permission WHERE permission_code = 'masters.customers.view'`);
    expect(roles).toEqual(['cashier', 'manager', 'owner', 'salesperson']);
  });
});

describe('0.8.4 inventory over HTTP: piece-photo download links, closeLot If-Match', () => {
  const inv: Record<string, string> = {};
  let noPerm = '';
  beforeAll(async () => {
    const mk = async (path: string, body: Record<string, unknown>) => {
      const r = await call('POST', path, { cookie: owner, body });
      expect(r.statusCode, `${path} ${r.body}`).toBe(201);
      return r.json().id as string;
    };
    inv.metal = await mk('/v1/masters/metals', { code: 'PT84', name: 'Platinum 84', default_hsn: '7113' });
    inv.purity = await mk('/v1/masters/purities', { metal_id: inv.metal, code: '950', fineness: '950' });
    inv.item = await mk('/v1/masters/items', { code: 'SRING', name: 'Silver ring', metal_id: inv.metal, purity_id: inv.purity, hsn: '7113', stock_type: 'tag' });
    inv.floor = await mk('/v1/masters/floors', { branch_id: branchId, code: 'F84', name: 'Floor 84' });
    inv.counter = await mk('/v1/masters/counters', { branch_id: branchId, floor_id: inv.floor, code: 'C84', name: 'Counter 84' });
    // a user with no role at all: no inventory.stock.view
    const u = await call('POST', '/v1/users', { cookie: owner, body: { name: 'mnone', username: 'mnone', password: 'none-pass-1234', roles: [{ role: 'cashier', branch_id: branchId }], default_branch_id: branchId } });
    expect(u.statusCode, u.body).toBe(201);
    await asMigrator(tenantId, `DELETE FROM platform.user_role WHERE user_id = $1`, [u.json().id]);
    noPerm = await login(SLUG, 'mnone', 'none-pass-1234');
    expect(noPerm).toBeTruthy();
  });
  it('GET /v1/files/{id}/url for a tag_photo: 200 with inventory.stock.view (manager, cashier), 403 without, 404 for tenant 2', async () => {
    const s = await call('PATCH', '/v1/inventory/settings', { cookie: owner, body: { photos_enabled: true } });
    expect(s.statusCode, s.body).toBe(200);
    const t = await call('POST', '/v1/inventory/tags', { cookie: owner, body: { branch_id: branchId, item_id: inv.item, purity_id: inv.purity, gross_wt: '5.000',
      net_wt: '5.000', mc_type: 'per_gram', huid: 'HP8401', counter_id: inv.counter }, headers: { 'idempotency-key': 'inv084-tag-create-0001' } });
    expect(t.statusCode, t.body).toBe(201);
    const fid = (await upload(owner, 'tag_photo', Buffer.concat([PNG, Buffer.from('tp84')]))).json().id as string;
    const p = await call('POST', `/v1/inventory/tags/${t.json().id}/photos`, { cookie: owner, body: { file_id: fid }, headers: { 'idempotency-key': 'inv084-tag-photo-0001' } });
    expect(p.statusCode, p.body).toBe(201);
    for (const who of [manager, cashier]) {
      const r = await call('GET', `/v1/files/${fid}/url`, { cookie: who });
      expect(r.statusCode, r.body).toBe(200);
      expect((await app.inject({ method: 'GET', url: r.json().url }) as unknown as Res).statusCode).toBe(200);
    }
    const no = await call('GET', `/v1/files/${fid}/url`, { cookie: noPerm });
    expect(no.statusCode, no.body).toBe(403);
    expect((await call('GET', `/v1/files/${fid}/url`, { cookie: bOwner })).statusCode).toBe(404);
  });
  it('POST /v1/inventory/lots/{id}/close: 428 without If-Match, 412 stale, 200 + ETag with the current version', async () => {
    const l = await call('POST', '/v1/inventory/lots', { cookie: owner, body: { branch_id: branchId,
      lines: [{ item_id: inv.item, purity_id: inv.purity, pieces: 0, gross_wt: '2.000', stone_wt: '0', net_wt: '2.000' }] }, headers: { 'idempotency-key': 'inv084-lot-create-0001' } });
    expect(l.statusCode, l.body).toBe(201);
    const path = `/v1/inventory/lots/${l.json().id}/close`;
    const body = { remainder: 'to_loose', counter_id: inv.counter };
    expect((await call('POST', path, { cookie: owner, body })).statusCode).toBe(428);
    expect((await call('POST', path, { cookie: owner, body, headers: im(l.json().version + 5) })).statusCode).toBe(412);
    const c = await call('POST', path, { cookie: owner, body, headers: im(l.json().version) });
    expect(c.statusCode, c.body).toBe(200);
    expect(c.json().status).toBe('closed');
    expect(c.headers.etag).toBe(`"${c.json().version}"`);
  });
});
