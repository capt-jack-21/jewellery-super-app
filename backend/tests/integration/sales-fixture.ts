import 'reflect-metadata';
import { expect } from 'vitest';
import { pool, url } from './env';
import { ContractRecorder, type Res } from './contract';
import { huidGen } from './huid';

/**
 * Shared Sales fixture (sales.test.ts, sales-contract.test.ts): a fresh tenant provisioned over HTTP, billing unlocked (onboarding steps
 * completed, today's sale + old-metal rates), GOLD 22K / 24K, a tag item (RING) and a loose item (COIN), counter, salesperson staff,
 * owner / manager / cashier / salesperson sessions on an APPROVED counter device. Every call goes through go(): the response is validated
 * against contracts/openapi.yaml (Ajv 2020-12, strict RFC 3339) by the shared ContractRecorder.
 */
process.env.DATABASE_URL = url('app_rw');
process.env.ADMIN_DATABASE_URL = url('app_admin');
process.env.SESSION_SECRET = 'test-secret-0123456789abcdef0123456789';
process.env.COOKIE_INSECURE = '1';
process.env.FILE_STORE_DIR = `/tmp/jw-files-sales-${process.pid}`;
process.env.FILE_TOKEN_SECRET = 'test-file-token-secret-0123456789abcdef';

type App = Awaited<ReturnType<typeof import('@jw/api').createApp>>;
export interface Go { cookie?: string; body?: unknown; headers?: Record<string, string>; q?: Record<string, string>; p?: Record<string, string>; status?: number | number[] }
export interface SalesFx {
  app: App; rec: ContractRecorder; tenantId: string; B1: string; B2: string; branchCode: string;
  owner: string; manager: string; cashier: string; sales: string; managerNoDevice: string;
  ownerId: string; managerId: string; cashierId: string; salesId: string;
  metal: string; P22: string; P24: string; ring: string; coin: string; counter: string; counter2: string; staff: string; staffB2: string;
  rate: { sale22: string; sale24: string; old22: string; old24: string };
  go(method: string, template: string, o?: Go): Promise<Res>;
  raw(method: string, path: string, o?: { cookie?: string; body?: unknown; headers?: Record<string, string> }): Promise<Res>;
  key(): Record<string, string>;
  im(v: number | string): Record<string, string>;
  sql<T = Record<string, unknown>>(q: string, p?: unknown[]): Promise<T[]>;
  tag(o?: Record<string, unknown>): Promise<{ id: string; tag_no: string; huid: string }>;
  loose(pieces: number, gross: string, counterId?: string): Promise<void>;
  customer(o?: Record<string, unknown>): Promise<string>;
  settings(patch: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}
const cookieOf = (r: Res, name = 'sid') => {
  const c = ([] as string[]).concat((r.headers['set-cookie'] as string | string[]) ?? []).find((x) => x.startsWith(`${name}=`));
  return c ? c.split(';')[0] : '';
};
let phoneN = 0;

/** opts.remoteAddress: a distinct synthetic client address for shops provisioned in bulk in ONE worker, so the product's per-process
 * login limiter (login:<ip>:<login>, 10 / 5 min) is not tripped by many fixtures sharing the owner username 'sowner'. The limiter is unchanged. */
export async function salesFixture(slugBase: string, huidPrefix: string, opts: { remoteAddress?: string } = {}): Promise<SalesFx> {
  const mig = pool('app_migrator');
  const rec = new ContractRecorder();
  const huid = huidGen(huidPrefix);
  const { hashPassword } = await import('@jw/mod-platform');
  await mig.query(`INSERT INTO platform.platform_admin(email, name, password_hash) VALUES ('ops@jewelos.test', 'Ops', $1) ON CONFLICT (email) DO NOTHING`,
    [await hashPassword('admin-pass-123')]);
  const app = await (await import('@jw/api')).createApp();
  const raw = (method: string, path: string, o: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Res> =>
    app.inject({ method: method as 'GET', url: `/api${path}`, payload: o.body as object,
      headers: { ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.headers ?? {}) },
      ...(opts.remoteAddress ? { remoteAddress: opts.remoteAddress } : {}) }) as unknown as Promise<Res>;
  let keyN = 0;
  const key = () => ({ 'idempotency-key': `${slugBase}-${process.pid}-${++keyN}-${Date.now()}` });
  const im = (v: number | string) => ({ 'if-match': `"${v}"` });
  const slug = `${slugBase}-${Date.now() % 1000000}`;
  const code = slugBase.slice(0, 2).toUpperCase() + 'A';
  const admin = cookieOf(await raw('POST', '/v1/admin/auth/login', { body: { email: 'ops@jewelos.test', password: 'admin-pass-123' } }), 'admin_sid');
  const t = await raw('POST', '/v1/admin/tenants', { cookie: admin, body: { slug, display_name: slug,
    company: { legal_name: `${slug} Jewellers`, gstin: '33AAAAA1111A1Z5', state_code: '33' }, branch: { code, name: 'Sales A' },
    owner: { name: 'sowner', username: 'sowner', password: 'owner-pass-789' } } });
  expect(t.statusCode, t.body).toBe(201);
  const tenantId = t.json().id as string;
  const asM = async <T>(q: string, p: unknown[] = []): Promise<T[]> => {
    const c = await mig.connect();
    try {
      await c.query('BEGIN'); await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      const r = await c.query(q, p); await c.query('COMMIT'); return r.rows as T[];
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  };
  const login = async (u: string, pw: string) => cookieOf(await raw('POST', '/v1/auth/login', { body: { tenant: slug, login: u, password: pw } }));
  const owner0 = await login('sowner', 'owner-pass-789');
  const B1 = (await raw('GET', '/v1/branches', { cookie: owner0 })).json()[0].id as string;
  const [{ company_id }] = await asM<{ company_id: string }>(`SELECT company_id FROM platform.branch WHERE id = $1`, [B1]);
  const [{ id: B2 }] = await asM<{ id: string }>(`INSERT INTO platform.branch(tenant_id, company_id, code, name, bill_series_prefix, state_code)
      VALUES ($1, $2, $3, 'Sales B', $3, '33') RETURNING id`, [tenantId, company_id, slugBase.slice(0, 2).toUpperCase() + 'B']);
  // masters: metal, purities, items, counters, staff
  const [{ id: metal }] = await asM<{ id: string }>(`INSERT INTO masters.metal(tenant_id, code, name, default_hsn) VALUES ($1, 'GOLD', 'Gold', '7113') RETURNING id`, [tenantId]);
  const [{ id: P22 }] = await asM<{ id: string }>(`INSERT INTO masters.purity(tenant_id, metal_id, code, fineness, huid_required) VALUES ($1, $2, '22K', 916, true) RETURNING id`, [tenantId, metal]);
  const [{ id: P24 }] = await asM<{ id: string }>(`INSERT INTO masters.purity(tenant_id, metal_id, code, fineness, huid_required) VALUES ($1, $2, '24K', 999, false) RETURNING id`, [tenantId, metal]);
  const [{ id: ring }] = await asM<{ id: string }>(`INSERT INTO masters.item(tenant_id, metal_id, purity_id, code, name, hsn, stock_type, mc_type, mc_value, wastage_type, wastage_value)
      VALUES ($1, $2, $3, 'RING', 'Gold Ring', '7113', 'tag', 'per_gram', 500, 'percent', 8) RETURNING id`, [tenantId, metal, P22]);
  const [{ id: coin }] = await asM<{ id: string }>(`INSERT INTO masters.item(tenant_id, metal_id, purity_id, code, name, hsn, stock_type, mc_type, mc_value, wastage_type, wastage_value)
      VALUES ($1, $2, $3, 'COIN', 'Gold Coin', '7114', 'non_tag', 'flat', 0, 'none', 0) RETURNING id`, [tenantId, metal, P24]);
  const [{ id: counter }] = await asM<{ id: string }>(`INSERT INTO masters.counter(tenant_id, branch_id, code, name) VALUES ($1, $2, 'C1', 'Counter 1') RETURNING id`, [tenantId, B1]);
  const [{ id: counter2 }] = await asM<{ id: string }>(`INSERT INTO masters.counter(tenant_id, branch_id, code, name) VALUES ($1, $2, 'C2', 'Counter 2') RETURNING id`, [tenantId, B1]);
  const [{ id: staff }] = await asM<{ id: string }>(`INSERT INTO hr.staff(tenant_id, code, name, branch_id, is_salesperson) VALUES ($1, 'S1', 'Priya', $2, true) RETURNING id`, [tenantId, B1]);
  const [{ id: staffB2 }] = await asM<{ id: string }>(`INSERT INTO hr.staff(tenant_id, code, name, branch_id, is_salesperson) VALUES ($1, 'S2', 'Arun', $2, true) RETURNING id`, [tenantId, B2]);
  // today's rates (IST) + onboarding
  const rate = { sale22: '6000.00', sale24: '6500.00', old22: '5800.00', old24: '6300.00' };
  for (const [p, kind, r] of [[P22, 'sale', rate.sale22], [P24, 'sale', rate.sale24], [P22, 'old_metal', rate.old22], [P24, 'old_metal', rate.old24]])
    await asM(`INSERT INTO rates.metal_rate(tenant_id, purity_id, kind, rate_date, effective_from, rate_per_g) VALUES ($1, $2, $3, (now() AT TIME ZONE 'Asia/Kolkata')::date, now() - interval '1 minute', $4)`,
      [tenantId, p, kind, r]);
  await asM(`UPDATE platform.onboarding_progress SET status = 'completed', completed_at = now() WHERE tenant_id = $1`, [tenantId]);
  // 998 seeds all four Sales platform pins; 0.9.6 (B-2) prints only those, so fixtures configure NO custom tenant templates.
  // users (fixed roles) and an approved counter device for every session
  const mkUser = async (u: string, role: string, branch: string | null) => {
    const r = await raw('POST', '/v1/users', { cookie: owner0, body: { name: u, username: u, password: `${u}-pass-7890`, roles: [{ role, branch_id: branch }], default_branch_id: B1 } });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id as string;
  };
  const managerId = await mkUser('smanager', 'manager', B1);
  const cashierId = await mkUser('scashier', 'cashier', B1);
  const salesId = await mkUser('ssales', 'salesperson', B1);
  const [{ id: ownerId }] = await asM<{ id: string }>(`SELECT id FROM platform.app_user WHERE username = 'sowner'`);
  const [{ id: device }] = await asM<{ id: string }>(`INSERT INTO platform.device(tenant_id, branch_id, name, fingerprint_hash, status, approved_by, approved_at)
      VALUES ($1, $2, 'Counter PC', '\\x00', 'approved', $3, now()) RETURNING id`, [tenantId, B1, ownerId]);
  const owner = await login('sowner', 'owner-pass-789');
  const manager = await login('smanager', 'smanager-pass-7890');
  await mkUser('smanager2', 'manager', B1);
  const managerNoDevice = await login('smanager2', 'smanager2-pass-7890');
  const cashier = await login('scashier', 'scashier-pass-7890');
  const sales = await login('ssales', 'ssales-pass-7890');
  await asM(`UPDATE platform.user_session SET device_id = $2 WHERE user_id = ANY($1::uuid[]) AND revoked_at IS NULL`, [[ownerId, managerId, cashierId, salesId], device]);
  async function go(method: string, template: string, o: Go = {}): Promise<Res> {
    let path = template.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(o.p?.[k] ?? `{${k}}`));
    if (o.q) path += `?${new URLSearchParams(o.q).toString()}`;
    const r = await raw(method, path, { cookie: o.cookie ?? owner, body: o.body, headers: o.headers });
    rec.check(method, template, r);
    const want = ([] as number[]).concat(o.status ?? (method === 'POST' ? [200, 201] : [200]));
    expect(want, `${method} ${path} → ${r.statusCode} ${r.body.slice(0, 600)}`).toContain(r.statusCode);
    return r;
  }
  const sql = <T = Record<string, unknown>>(q: string, p: unknown[] = []) => asM<T>(q, p);
  const fx: SalesFx = {
    app, rec, tenantId, B1, B2, branchCode: code, owner, manager, cashier, sales, managerNoDevice, ownerId, managerId, cashierId, salesId,
    metal, P22, P24, ring, coin, counter, counter2, staff, staffB2, rate, go, raw, key, im, sql,
    async tag(o = {}) {
      const h = huid();
      const r = await raw('POST', '/v1/inventory/tags', { cookie: owner, headers: key(), body: { branch_id: B1, item_id: ring, purity_id: P22, gross_wt: '10.000',
        stone_wt: '0.000', net_wt: '10.000', huid: h, counter_id: counter, wastage_pct: '8', ...o } });
      expect(r.statusCode, r.body).toBe(201);
      const j = r.json();
      return { id: j.id, tag_no: j.tag_no, huid: h };
    },
    async loose(pieces, gross, counterId = counter) {
      const r = await raw('POST', '/v1/inventory/loose-stock/receipts', { cookie: owner, headers: key(), body: { branch_id: B1, counter_id: counterId, item_id: coin,
        purity_id: P24, gross_wt: gross, net_wt: gross, pieces, note: 'coins in' } });
      expect(r.statusCode, r.body).toBe(201);
    },
    async customer(o = {}) {
      const phone = `9${String(Date.now() % 100000000).padStart(8, '0')}${++phoneN % 10}`;
      const [{ id }] = await asM<{ id: string }>(`INSERT INTO masters.customer(tenant_id, name, phone, gstin, state_code, home_branch_id)
          VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`, [tenantId, (o.name as string) ?? 'Ravi', (o.phone as string) ?? phone, (o.gstin as string) ?? null,
        (o.state_code as string) ?? ((o.gstin as string | undefined)?.slice(0, 2) ?? '33'), B1]);
      return id;
    },
    async settings(patch) {
      const cur = await raw('GET', '/v1/sales/settings', { cookie: owner });
      const r = await go('PATCH', '/v1/sales/settings', { body: patch, headers: { 'if-match': cur.headers.etag as string } });
      return r.json();
    },
    async close() { await app.close(); await mig.end(); },
  };
  return fx;
}
