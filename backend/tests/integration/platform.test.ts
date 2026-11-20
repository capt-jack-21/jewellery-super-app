import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool, url, T1, T2 } from './env';

process.env.DATABASE_URL = url('app_rw');
process.env.ADMIN_DATABASE_URL = url('app_admin');
process.env.SESSION_SECRET = 'test-secret-0123456789abcdef0123456789';
process.env.COOKIE_INSECURE = '1';
process.env.FILE_STORE_DIR = `/tmp/jw-files-${process.pid}`;
process.env.FILE_TOKEN_SECRET = 'test-file-token-secret-0123456789abcdef';

type App = Awaited<ReturnType<typeof import('@jw/api').createApp>>;
let app: App;
const mig = pool('app_migrator');
const adm = pool('app_admin');   // platform_admin_session is app_admin-only (RLS/grants)
const PARTNER_ID = '00000000-0000-0000-0000-0000000000a1';
const DEVICE_KEY = 'device-key-counter-0001-abcdefghijklmnop';

interface Res { statusCode: number; json(): any; headers: Record<string, unknown>; body: string }
const call = (method: string, path: string, o: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Res> =>
  app.inject({ method: method as 'GET', url: `/api${path}`, payload: o.body as object,
    headers: { ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.headers ?? {}) } }) as unknown as Promise<Res>;
/** If-Match header from a resource version. */
const im = (v: number | string) => ({ 'if-match': `"${v}"` });
const settingVersion = async (cookie: string, key: string, branchId?: string) =>
  (await call('GET', `/v1/settings${branchId ? `?branch_id=${branchId}` : ''}`, { cookie })).json().find((s: { key: string }) => s.key === key).version as number;
const cookieOf = (r: Res, name = 'sid') => {
  const raw = ([] as string[]).concat((r.headers['set-cookie'] as string | string[]) ?? []).find((c) => c.startsWith(`${name}=`));
  return raw ? raw.split(';')[0] : '';
};
async function login(tenant: string, l: string, password: string, device_key?: string) {
  const r = await call('POST', '/v1/auth/login', { body: { tenant, login: l, password, ...(device_key ? { device_key } : {}) } });
  return { r, cookie: cookieOf(r) };
}
async function asMigrator<T>(tenantId: string, sql: string, params: unknown[] = []) {
  const c = await mig.connect();
  try {
    await c.query('BEGIN'); await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    const r = await c.query(sql, params); await c.query('COMMIT'); return r.rows as T[];
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}

let admin = ''; let tenantId = ''; let owner = ''; let managerId = ''; let manager = '';
const SLUG = `ganesh-${Date.now() % 100000}`;

beforeAll(async () => {
  const { hashPassword } = await import('@jw/mod-platform');
  await mig.query(`INSERT INTO platform.platform_admin(email, name, password_hash) VALUES ('ops@jewelos.test', 'Ops', $1) ON CONFLICT (email) DO NOTHING`,
    [await hashPassword('admin-pass-123')]);
  app = await (await import('@jw/api')).createApp();
});
afterAll(async () => { await app?.close(); await mig.end(); await adm.end(); });

describe('platform admin (P23) + provisioning', () => {
  it('admin login sets an httpOnly admin cookie; wrong password → 401', async () => {
    expect((await call('POST', '/v1/admin/auth/login', { body: { email: 'ops@jewelos.test', password: 'nope' } })).statusCode).toBe(401);
    const r = await call('POST', '/v1/admin/auth/login', { body: { email: 'ops@jewelos.test', password: 'admin-pass-123' } });
    expect(r.statusCode).toBe(200);
    expect(String(r.headers['set-cookie'])).toMatch(/admin_sid=.*HttpOnly/i);
    admin = cookieOf(r, 'admin_sid');
    expect((await call('GET', '/v1/admin/tenants')).statusCode).toBe(401);
    expect((await call('GET', '/v1/admin/tenants', { cookie: `admin_sid=${admin.split('=')[1].replace(/.$/, 'x')}` })).statusCode).toBe(401);
    // v1.4: the session lives in platform.platform_admin_session as sha256 only
    const tok = decodeURIComponent(admin.split('=')[1]);
    const rows = (await adm.query(`SELECT revoked_at FROM platform.platform_admin_session WHERE token_hash = sha256(convert_to($1, 'UTF8'))`, [tok])).rows;
    expect(rows).toHaveLength(1);
    expect((await adm.query(`SELECT count(*)::int n FROM platform.platform_admin_session WHERE token_hash::text LIKE '%' || $1 || '%'`, [tok])).rows[0].n).toBe(0);
  });

  it('admin logout revokes the DB session row', async () => {
    const r = await call('POST', '/v1/admin/auth/login', { body: { email: 'ops@jewelos.test', password: 'admin-pass-123' } });
    const c = cookieOf(r, 'admin_sid');
    expect((await call('POST', '/v1/admin/auth/logout', { cookie: c })).statusCode).toBe(204);
    expect((await call('GET', '/v1/admin/tenants', { cookie: c })).statusCode).toBe(401);
    const [row] = (await adm.query(`SELECT revoked_at FROM platform.platform_admin_session WHERE token_hash = sha256(convert_to($1, 'UTF8'))`,
      [decodeURIComponent(c.split('=')[1])])).rows;
    expect(row.revoked_at).not.toBeNull();
  });

  it('creates a shop with company, branch, four fixed roles and the owner', async () => {
    const r = await call('POST', '/v1/admin/tenants', { cookie: admin, body: {
      slug: SLUG, display_name: 'Ganesh Jewellers', default_language: 'ta',
      company: { legal_name: 'Ganesh Jewellers', gstin: '33AAAAA1111A1Z5', state_code: '33' },
      branch: { code: 'MDU', name: 'Madurai' }, owner: { name: 'Ganesh', username: 'ganesh', phone: '9811111111', password: 'owner-pass-123' } } });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.headers.etag).toMatch(/^"\d+"$/);
    tenantId = r.json().id;
    expect(r.json()).toMatchObject({ slug: SLUG, status: 'trial', default_language: 'ta', version: expect.any(Number) });
    // provision_tenant(16 args, 971): one tx — branch bill_series_prefix defaults to code, 10 onboarding rows, owner role
    const [br] = await asMigrator<{ bill_series_prefix: string }>(tenantId, `SELECT bill_series_prefix FROM platform.branch`);
    expect(br.bill_series_prefix).toBe('MDU');
    const [{ n }] = await asMigrator<{ n: number }>(tenantId, `SELECT count(*)::int n FROM platform.onboarding_progress`);
    expect(n).toBe(10);
    // v1.5: provision_tenant() writes its own semantic audit event (no app-side audit_append)
    const [{ a }] = await asMigrator<{ a: number }>(tenantId, `SELECT count(*)::int a FROM platform.audit_event WHERE action = 'tenant.provisioned'`);
    expect(a).toBe(1);
    expect((await call('POST', '/v1/admin/tenants', { cookie: admin, body: { slug: SLUG, display_name: 'x',
      company: { legal_name: 'x', state_code: '33' }, branch: { code: 'X', name: 'x' }, owner: { name: 'x', username: 'other', password: 'owner-pass-123' } } })).statusCode).toBe(409);
    const list = await call('GET', `/v1/admin/tenants?q=${SLUG}`, { cookie: admin });
    expect(list.json().map((t: { id: string }) => t.id)).toContain(tenantId);
    // v1.5: deployment_mode is passed to provision_tenant(p_deployment_mode)
    const ded = await call('POST', '/v1/admin/tenants', { cookie: admin, body: { slug: `${SLUG}-x`, display_name: 'x', deployment_mode: 'dedicated',
      company: { legal_name: 'x', state_code: '33' }, branch: { code: 'X', name: 'x' }, owner: { name: 'x', username: 'dedowner', password: 'owner-pass-123' } } });
    expect(ded.statusCode, ded.body).toBe(201);
    expect(ded.json().deployment_mode).toBe('dedicated');
    const [db] = await asMigrator<{ p: string }>(ded.json().id, `SELECT bill_series_prefix p FROM platform.branch`);
    expect(db.p).toBe('X');   // omitted → branch code
    const bad = { slug: `${SLUG}-y`, display_name: 'y', company: { legal_name: 'y', state_code: '33' }, owner: { name: 'y', username: 'yowner', password: 'owner-pass-123' } };
    expect(ded.json().branch).toEqual({ code: 'X', bill_series_prefix: 'X' });
    // 971: invalid prefix → DB 23514 → 422 invalid_bill_series_prefix, nothing written
    for (const p of ['y 1', 'ABCDEFGHIJKLM', '-Y']) {
      const inv = await call('POST', '/v1/admin/tenants', { cookie: admin, body: { ...bad, branch: { code: 'Y', name: 'y', bill_series_prefix: p } } });
      expect(inv.statusCode, `${p}: ${inv.body}`).toBe(422);
      expect(inv.json()).toMatchObject({ code: 'invalid_bill_series_prefix' });
    }
    expect((await call('GET', `/v1/admin/tenants?q=${SLUG}-y`, { cookie: admin })).json()).toHaveLength(0);
    // lowercase in → DB upper-cases → response echoes the STORED value
    const pre = await call('POST', '/v1/admin/tenants', { cookie: admin, body: { ...bad, branch: { code: 'Y', name: 'y', bill_series_prefix: 'y/26-a' } } });
    expect(pre.statusCode, pre.body).toBe(201);
    expect(pre.json().branch).toEqual({ code: 'Y', bill_series_prefix: 'Y/26-A' });
    const [pb] = await asMigrator<{ p: string }>(pre.json().id, `SELECT bill_series_prefix p FROM platform.branch`);
    expect(pb.p).toBe('Y/26-A');
    expect(r.json().deployment_mode).toBe('shared');
  });

  it('admin tenant PATCH needs If-Match: 428 missing, 412 stale, 200 current', async () => {
    const t = (await call('GET', `/v1/admin/tenants/${tenantId}`, { cookie: admin })).json();
    expect((await call('PATCH', `/v1/admin/tenants/${tenantId}`, { cookie: admin, body: { display_name: 'Ganesh Jewellers' } })).statusCode).toBe(428);
    expect((await call('PATCH', `/v1/admin/tenants/${tenantId}`, { cookie: admin, headers: im(t.version + 99), body: { display_name: 'Ganesh Jewellers' } })).statusCode).toBe(412);
    const ok = await call('PATCH', `/v1/admin/tenants/${tenantId}`, { cookie: admin, headers: im(t.version), body: { display_name: 'Ganesh Jewellers' } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().version).toBe(t.version + 1);
  });
});

describe('auth: password login, sessions, lockout', () => {
  it('logs in with slug + username → httpOnly sid cookie, session body', async () => {
    const { r, cookie } = await login(SLUG, 'ganesh', 'owner-pass-123');
    expect(r.statusCode, r.body).toBe(200);
    expect(String(r.headers['set-cookie'])).toMatch(/sid=.*HttpOnly/i);
    owner = cookie;
    const s = r.json();
    expect(s.roles).toEqual([{ role: 'owner', branch_id: null }]);
    expect(s.permissions).toContain('platform.users.manage');
    expect(s.language).toBe('ta');
    expect(s.idle_timeout_minutes).toBe(30);
    const me = await call('GET', '/v1/auth/session', { cookie: owner });
    expect(me.statusCode).toBe(200); expect(me.json().tenant_id).toBe(tenantId);
  });

  it('unknown shop / wrong password are indistinguishable 401s', async () => {
    expect((await login('no-such-shop', 'ganesh', 'owner-pass-123')).r.json().code).toBe('invalid_credentials');
    expect((await login(SLUG, 'ganesh', 'wrong-pass-123')).r.json().code).toBe('invalid_credentials');
  });

  it('roles are the four fixed ones; custom roles cannot be created', async () => {
    const r = await call('GET', '/v1/roles', { cookie: owner });
    expect(r.json().map((x: { code: string }) => x.code).sort()).toEqual(['cashier', 'manager', 'owner', 'salesperson']);
    expect((await call('POST', '/v1/roles', { cookie: owner, body: { name: 'custom' } })).statusCode).toBe(404);
  });

  it('owner creates a manager; manager cannot grant owner; last owner cannot be removed', async () => {
    const b = (await call('GET', '/v1/branches', { cookie: owner })).json();
    const r = await call('POST', '/v1/users', { cookie: owner, body: { name: 'Meena', username: 'meena', phone: '9822222222', password: 'manager-pass-1',
      roles: [{ role: 'manager', branch_id: null }], default_branch_id: b[0].id } });
    expect(r.statusCode, r.body).toBe(201);
    managerId = r.json().id;
    manager = (await login(SLUG, 'meena', 'manager-pass-1')).cookie;
    expect(manager).not.toBe('');
    const ownerId = (await call('GET', '/v1/auth/session', { cookie: owner })).json().user.id;
    expect((await call('PUT', `/v1/users/${managerId}/roles`, { cookie: manager, body: [{ role: 'owner', branch_id: null }] })).statusCode).toBe(403);
    const last = await call('PUT', `/v1/users/${ownerId}/roles`, { cookie: owner, body: [{ role: 'manager', branch_id: null }] });
    expect(last.statusCode).toBe(409); expect(last.json().code).toBe('last_owner');
  });

  it('5 wrong passwords lock the account for 15 minutes (even with the right password)', async () => {
    await call('POST', '/v1/users', { cookie: owner, body: { name: 'Lock', username: 'locky', password: 'lock-pass-123', roles: [{ role: 'cashier', branch_id: null }] } });
    for (let i = 0; i < 5; i++) await login(SLUG, 'locky', 'bad-password-x');
    expect((await login(SLUG, 'locky', 'lock-pass-123')).r.statusCode).toBe(401);
    // v1.5: platform.rate_limit_bucket, key = login.tenant:<tenant>:sha256(login) — never the raw username
    const [u] = await asMigrator<{ locked: boolean; raw: number }>(tenantId,
      `SELECT bool_or(locked_until > now()) AS locked, count(*) FILTER (WHERE bucket_key LIKE '%locky%')::int AS raw
         FROM platform.rate_limit_bucket WHERE bucket_key LIKE 'login.tenant:' || $1 || ':%'`, [tenantId]);
    expect(u).toEqual({ locked: true, raw: 0 });
    const list = (await call('GET', '/v1/users', { cookie: owner })).json() as { username: string; locked_until: string | null }[];
    expect(list.find((x) => x.username === 'locky')?.locked_until).toBeTruthy();
    // unknown logins are counted and locked the same way (no enumeration)
    for (let i = 0; i < 5; i++) await login(SLUG, 'nobody-here', 'bad-password-x');
    const [{ ghost }] = await asMigrator<{ ghost: boolean }>(tenantId,
      `SELECT bool_or(locked_until > now()) AS ghost FROM platform.rate_limit_bucket WHERE bucket_key = 'login.tenant:' || $1 || ':' || encode(sha256('nobody-here'), 'hex')`, [tenantId]);
    expect(ghost).toBe(true);
  });

  it('idle timeout (setting) revokes the session with reason idle_timeout', async () => {
    const { cookie } = await login(SLUG, 'meena', 'manager-pass-1');
    await asMigrator(tenantId, `UPDATE platform.user_session SET last_seen_at = now() - interval '31 minutes' WHERE token_hash = sha256(convert_to($1, 'UTF8'))`,
      [decodeURIComponent(cookie.split('=')[1]).split('.')[1]]);
    const r = await call('GET', '/v1/auth/session', { cookie });
    expect(r.statusCode).toBe(401); expect(r.json().code).toBe('session_idle_timeout');
    const [s] = await asMigrator<{ revoke_reason: string }>(tenantId,
      `SELECT revoke_reason FROM platform.user_session WHERE token_hash = sha256(convert_to($1, 'UTF8'))`, [decodeURIComponent(cookie.split('=')[1]).split('.')[1]]);
    expect(s.revoke_reason).toBe('idle_timeout');
  });

  it('logout revokes the session', async () => {
    const { cookie } = await login(SLUG, 'meena', 'manager-pass-1');
    expect((await call('POST', '/v1/auth/logout', { cookie })).statusCode).toBe(204);
    expect((await call('GET', '/v1/auth/session', { cookie })).statusCode).toBe(401);
  });

  it('a session cookie of one shop cannot be replayed against another shop', async () => {
    const forged = owner.replace(tenantId, T1);
    expect((await call('GET', '/v1/auth/session', { cookie: forged })).statusCode).toBe(401);
  });
});

describe('OTP login (setting auth.otp_login_enabled) → outbox, never pg-boss', () => {
  it('rerun regression — password then OTP: tenant-isolated no-direct-queue/no-plaintext; worker decrypts/deletes delivery; right code → session', async () => {
    expect((await call('PUT', '/v1/settings/auth.otp_login_enabled', { cookie: owner, body: { value: true } })).statusCode).toBe(200);
    try {
    const r = await call('POST', '/v1/auth/login', { body: { tenant: SLUG, login: 'meena', password: 'manager-pass-1' } });
    expect(r.statusCode, r.body).toBe(202);
    const ch = r.json().challenge_id as string;
    expect(r.headers['set-cookie']).toBeUndefined();
    const [o] = await asMigrator<{ payload: { delivery_id: string; challenge_id: string; channel: 'sms'; to: string }; topic: string }>(tenantId,
      `SELECT topic, payload FROM notifications.outbox WHERE topic = 'auth.otp' ORDER BY created_at DESC LIMIT 1`);
    expect(o.topic).toBe('auth.otp');
    expect(Object.keys(o.payload).sort()).toEqual(['challenge_id', 'channel', 'delivery_id', 'to']);   // no code in the outbox
    // the api role cannot read the ciphertext back
    const ro = pool('app_ro');
    await expect(ro.query(`SELECT 1 FROM platform.otp_delivery LIMIT 1`)).rejects.toThrow(/permission denied/);
    await ro.end();
    // worker: read → decrypt → send → delete
    const { deliverOtp } = await import('@jw/worker');
    const wk = pool('app_worker');
    const sent: { code: string; to: string }[] = [];
    expect(await deliverOtp(wk, tenantId, o.payload, async (m) => { sent.push(m); })).toBe('sent');
    expect(await deliverOtp(wk, tenantId, o.payload, async (m) => { sent.push(m); })).toBe('missing');   // deleted after send
    await wk.end();
    expect(sent).toHaveLength(1); expect(sent[0].to).toBe('9822222222');
    const code = sent[0].code;
    expect(code).toMatch(/^\d{6}$/);
    const [{ n: plain }] = await asMigrator<{ n: number }>(tenantId,
      `SELECT (SELECT count(*) FROM notifications.outbox WHERE payload::text LIKE '%' || $1 || '%')::int
            + (SELECT count(*) FROM platform.otp_challenge WHERE length(code_hash) <> 32)::int AS n`, [`"${code}"`]);
    expect(plain).toBe(0);
    const bad = await call('POST', '/v1/auth/otp/verify', { body: { challenge_id: ch, code: code === '000000' ? '111111' : '000000' } });
    expect(bad.statusCode).toBe(401);
    const ok = await call('POST', '/v1/auth/otp/verify', { body: { challenge_id: ch, code } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().auth_method).toBe('password');
    expect((await call('POST', '/v1/auth/otp/verify', { body: { challenge_id: ch, code } })).statusCode).toBe(401);  // single use
    const [{ boss }] = await asMigrator<{ boss: string | null }>(tenantId, `SELECT to_regclass('pgboss.job')::text AS boss`);
    if (boss) {
      const [{ n }] = await asMigrator<{ n: number }>(tenantId, `SELECT count(*)::int n FROM pgboss.job WHERE data::text LIKE '%' || $1 || '%' OR (name LIKE 'auth%' AND data->>'tenantId'=$2)`, [o.payload.delivery_id,tenantId]);
      expect(n).toBe(0);
    }   // the api only wrote the outbox; dispatch is the worker's job
    // DB-backed OTP request limit: 3 challenges per user per 15 minutes → 429
    for (let i = 0; i < 2; i++) await call('POST', '/v1/auth/login', { body: { tenant: SLUG, login: 'meena', password: 'manager-pass-1' } });
    const limited = await call('POST', '/v1/auth/login', { body: { tenant: SLUG, login: 'meena', password: 'manager-pass-1' } });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(limited.json().code).toBe('rate_limited');
    const ra = Number(limited.headers['retry-after']);
    expect(ra).toBeGreaterThan(0); expect(ra).toBeLessThanOrEqual(15 * 60);
    // v1.5: unknown logins hit the same OTP-send bucket → identical 429 after 3 requests
    const ghost: number[] = [];
    for (let i = 0; i < 4; i++) ghost.push((await call('POST', '/v1/auth/otp/request', { body: { tenant: SLUG, login: 'ghost-user-1' } })).statusCode);
    expect(ghost.slice(0, 3)).toEqual([202, 202, 202]);
    expect(ghost[3]).toBe(429);
    const v = await settingVersion(owner, 'auth.otp_login_enabled');
    expect((await call('DELETE', '/v1/settings/auth.otp_login_enabled', { cookie: owner })).statusCode).toBe(428);
    expect((await call('DELETE', '/v1/settings/auth.otp_login_enabled', { cookie: owner, headers: im(v) })).statusCode).toBe(204);
    } finally {
      // Do not let an unrelated assertion failure leave OTP enabled and turn subsequent password logins into202/no-cookie cascades.
      const current=(await call('GET','/v1/settings',{cookie:owner})).json().find((x:{key:string})=>x.key==='auth.otp_login_enabled');
      if(current?.value===true) expect((await call('DELETE','/v1/settings/auth.otp_login_enabled',{cookie:owner,headers:im(current.version)})).statusCode).toBe(204);
    }
  });
});

describe('counter devices (P10): register, approve, remote logout', () => {
  it('revoking a device kills its live sessions', async () => {
    const b = (await call('GET', '/v1/branches', { cookie: owner })).json();
    // register from its own session: registering binds that session, and revoking the device logs it out
    const regCookie = (await login(SLUG, 'meena', 'manager-pass-1')).cookie;
    const reg = await call('POST', '/v1/devices', { cookie: regCookie, body: { name: 'Counter 1', kind: 'billing_counter', branch_id: b[0].id, device_key: DEVICE_KEY } });
    expect(reg.statusCode, reg.body).toBe(201);
    expect(reg.json().status).toBe('pending');
    const id = reg.json().id;
    // relay fix: the outbox row names the approvers (owner + manager; the worker cannot read users) and the worker
    // turns it into one in-app alert each, idempotently
    const ownerId = (await call('GET', '/v1/auth/session', { cookie: owner })).json().user.id as string;
    const [ob] = await asMigrator<{ id: string; payload: { device_id: string; recipients: string[] } }>(tenantId,
      `SELECT id, payload FROM notifications.outbox WHERE topic = 'platform.device_pending' AND ref_id = $1`, [id]);
    expect(ob.payload.device_id).toBe(id);
    expect([...ob.payload.recipients].sort()).toEqual([ownerId, managerId].sort());
    {
      const { dispatchDevicePending } = await import('@jw/worker');
      const wk = pool('app_worker');
      try {
        const job = { tenantId, outboxId: ob.id, payload: ob.payload as never };
        expect(await dispatchDevicePending(wk, job)).toBe(2);
        expect(await dispatchDevicePending(wk, job)).toBe(0);   // retried job: no duplicate alerts
      } finally { await wk.end(); }
      const alerts = await asMigrator<{ user_id: string; title: string }>(tenantId,
        `SELECT user_id, title FROM notifications.in_app_alert WHERE outbox_id = $1 ORDER BY user_id`, [ob.id]);
      expect(alerts.map((a) => a.user_id)).toEqual([ownerId, managerId].sort());
      expect(alerts[0].title).toBe('Device waiting for approval');
    }
    const cashierRes = await call('POST', '/v1/users', { cookie: owner, body: { name: 'Cash', username: 'cash1', password: 'cash-pass-1234', roles: [{ role: 'cashier', branch_id: b[0].id }] } });
    expect(cashierRes.statusCode).toBe(201);
    const cashier = (await login(SLUG, 'cash1', 'cash-pass-1234')).cookie;
    expect((await call('POST', `/v1/devices/${id}/approve`, { cookie: cashier })).statusCode).toBe(403);
    expect((await call('POST', `/v1/devices/${id}/approve`, { cookie: manager })).json().status).toBe('approved');
    const onDevice = await login(SLUG, 'cash1', 'cash-pass-1234', DEVICE_KEY);
    expect(onDevice.r.json().device_id).toBe(id);
    const rev = await call('POST', `/v1/devices/${id}/revoke`, { cookie: manager, body: { reason: 'stolen' } });
    expect(rev.json().status).toBe('revoked');
    expect((await call('GET', '/v1/auth/session', { cookie: onDevice.cookie })).statusCode).toBe(401);
    expect((await call('GET', '/v1/auth/session', { cookie: cashier })).statusCode).toBe(200);   // other sessions untouched
  });
});

describe('device ↔ session binding (hotfix device-bind)', () => {
  const KEY_P = 'device-key-bind-pending-0002-abcdefghijk';
  const KEY_R = 'device-key-bind-revoked-0003-abcdefghijk';
  const current = async (cookie: string) => { const r = await call('GET', '/v1/devices/current', { cookie }); expect(r.statusCode, r.body).toBe(200); return JSON.parse(r.body); };
  const sess = async (cookie: string) => { const r = await call('GET', '/v1/auth/session', { cookie }); expect(r.statusCode, r.body).toBe(200); return r.json(); };

  // cashier sessions: the manager account is rate-limited / OTP-gated by earlier tests; registering needs no permission
  it('register → current returns the pending device; re-login keeps it (pending, billing off); approve → billing on', async () => {
    const b = (await call('GET', '/v1/branches', { cookie: owner })).json();
    const s1 = (await login(SLUG, 'cash1', 'cash-pass-1234')).cookie;
    expect(await current(s1)).toBeNull();
    const reg = await call('POST', '/v1/devices', { cookie: s1, body: { name: 'Counter 2', kind: 'billing_counter', branch_id: b[0].id, device_key: KEY_P } });
    expect(reg.statusCode, reg.body).toBe(201);
    const id = reg.json().id;
    expect(await current(s1)).toMatchObject({ id, status: 'pending' });
    expect(await sess(s1)).toMatchObject({ device_id: id, billing_enabled: false });

    const s2 = await login(SLUG, 'cash1', 'cash-pass-1234', KEY_P);
    expect(s2.r.json().device_id).toBe(id);
    expect(await current(s2.cookie)).toMatchObject({ id, status: 'pending' });
    expect((await sess(s2.cookie)).billing_enabled).toBe(false);

    // idempotent re-register from another browser session of the same device key → 200, and binds that session too
    const s3 = (await login(SLUG, 'cash1', 'cash-pass-1234')).cookie;
    const again = await call('POST', '/v1/devices', { cookie: s3, body: { name: 'Counter 2', kind: 'billing_counter', branch_id: b[0].id, device_key: KEY_P } });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().id).toBe(id);
    expect(await current(s3)).toMatchObject({ id, status: 'pending' });

    expect((await call('POST', `/v1/devices/${id}/approve`, { cookie: manager })).json().status).toBe('approved');
    expect(await sess(s2.cookie)).toMatchObject({ device_id: id, billing_enabled: true });
    expect(await current(s2.cookie)).toMatchObject({ id, status: 'approved' });
  });

  it('a revoked device is never bound: current is null after re-login; registering again returns it revoked (200), unbound', async () => {
    const b = (await call('GET', '/v1/branches', { cookie: owner })).json();
    const s1 = (await login(SLUG, 'cash1', 'cash-pass-1234')).cookie;
    const reg = await call('POST', '/v1/devices', { cookie: s1, body: { name: 'Counter 3', kind: 'billing_counter', branch_id: b[0].id, device_key: KEY_R } });
    expect(reg.statusCode, reg.body).toBe(201);
    const id = reg.json().id;
    expect((await call('POST', `/v1/devices/${id}/revoke`, { cookie: manager, body: { reason: 'lost' } })).json().status).toBe('revoked');
    expect((await call('GET', '/v1/auth/session', { cookie: s1 })).statusCode).toBe(401);   // bound session was logged out

    const s2 = await login(SLUG, 'cash1', 'cash-pass-1234', KEY_R);
    expect(s2.r.statusCode, s2.r.body).toBe(200);
    expect(s2.r.json().device_id).toBeNull();
    expect(await current(s2.cookie)).toBeNull();
    expect((await sess(s2.cookie)).billing_enabled).toBe(false);

    const again = await call('POST', '/v1/devices', { cookie: s2.cookie, body: { name: 'Counter 3', kind: 'billing_counter', branch_id: b[0].id, device_key: KEY_R } });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toMatchObject({ id, status: 'revoked' });
    expect(await current(s2.cookie)).toBeNull();
    expect((await call('POST', `/v1/devices/${id}/approve`, { cookie: manager })).statusCode).toBe(409);
  });
});

describe('settings, sales policy, language, onboarding', () => {
  it('tenant + branch overrides, reset, typed validation, money as strings', async () => {
    const all = (await call('GET', '/v1/settings', { cookie: owner })).json();
    const pan = all.find((s: { key: string }) => s.key === 'sales.pan_required_above');
    expect(typeof pan.value).toBe('string');
    expect((await call('PUT', '/v1/settings/sales.pan_required_above', { cookie: owner, body: { value: 200000 } })).statusCode).toBe(422);
    const put = await call('PUT', '/v1/settings/sales.pan_required_above', { cookie: owner, body: { value: '150000.00' } });
    expect(put.statusCode, put.body).toBe(200);   // first override: no If-Match needed
    expect(put.json()).toMatchObject({ value: '150000.00', source: 'tenant', version: 1 });
    expect((await call('PUT', '/v1/settings/sales.pan_required_above', { cookie: owner, body: { value: '160000.00' } })).statusCode).toBe(428);
    expect((await call('PUT', '/v1/settings/sales.pan_required_above', { cookie: owner, headers: im(7), body: { value: '160000.00' } })).statusCode).toBe(412);
    const put2 = await call('PUT', '/v1/settings/sales.pan_required_above', { cookie: owner, headers: im(1), body: { value: '160000.00' } });
    expect(put2.json()).toMatchObject({ value: '160000.00', version: 2 });
    const b = (await call('GET', '/v1/branches', { cookie: owner })).json()[0].id;
    await call('PUT', `/v1/settings/auth.session_timeout_minutes?branch_id=${b}`, { cookie: owner, body: { value: 60 } });
    const br = (await call('GET', `/v1/settings?branch_id=${b}`, { cookie: owner })).json().find((s: { key: string }) => s.key === 'auth.session_timeout_minutes');
    expect(br).toMatchObject({ value: 60, source: 'branch' });
    expect((await call('PUT', '/v1/settings/auth.session_timeout_minutes', { cookie: owner, body: { value: 0 } })).statusCode).toBe(422);
    expect((await call('DELETE', `/v1/settings/auth.session_timeout_minutes?branch_id=${b}`, { cookie: owner, headers: im(br.version) })).statusCode).toBe(204);
    expect((await call('PUT', '/v1/settings/sales.pan_required_above', { cookie: (await login(SLUG, 'cash1', 'cash-pass-1234')).cookie, body: { value: '1.00' } })).statusCode).toBe(403);
  });

  it('sales policy: platform default, then a dated tenant row; back-dating refused', async () => {
    const d = (await call('GET', '/v1/settings/sales-policy', { cookie: owner })).json();
    expect(d.scope).toBe('platform');
    const body = { making_gst_treatment: 'composite', old_gold_valuation_basis: 'fine_24k', old_gold_excess_handling: 'separate_purchase',
      credit_note_rounding: 'exact', return_settlement_default: 'refund', return_window_days: 15 };
    expect((await call('POST', '/v1/settings/sales-policy', { cookie: owner, body: { ...body, effective_from: '2020-01-01' } })).statusCode).toBe(422);
    const r = await call('POST', '/v1/settings/sales-policy', { cookie: owner, body });
    expect(r.statusCode, r.body).toBe(201);
    expect((await call('GET', '/v1/settings/sales-policy', { cookie: owner })).json()).toMatchObject({ scope: 'tenant', return_window_days: 15, old_gold_valuation_basis: 'fine_24k' });
    expect((await call('POST', '/v1/settings/sales-policy', { cookie: owner, body })).statusCode).toBe(409);   // same day overlaps
  });

  it('0.9.5 YAML1.1 respin — both effective-date query parameters are on, and actually filter historical dates',async()=>{
    expect((await call('GET','/v1/settings/sales-policy?on=not-a-date',{cookie:owner})).json()).toMatchObject({status:422,code:'validation_failed'});
    expect((await call('GET','/v1/settings/sales-policy?on=1900-01-01',{cookie:owner})).statusCode).toBe(404);
    const all=await call('GET','/v1/settings/tax-rules',{cookie:owner});expect(all.statusCode).toBe(200);expect(all.json().length).toBeGreaterThan(0);
    const historic=await call('GET','/v1/settings/tax-rules?on=1900-01-01',{cookie:owner});expect(historic.statusCode).toBe(200);expect(historic.json()).toEqual([]);
    expect((await call('GET','/v1/settings/tax-rules?on=not-a-date',{cookie:owner})).json()).toMatchObject({status:422,code:'validation_failed'});
  });


  it('language: shop default + user override', async () => {
    const l = (await call('GET', '/v1/settings/language', { cookie: manager })).json();
    expect(l).toMatchObject({ shop_default: 'ta', effective: 'ta' });
    const me = (await call('GET', '/v1/auth/session', { cookie: manager })).json().user;
    expect((await call('PATCH', '/v1/users/me', { cookie: manager, body: { language: 'en' } })).statusCode).toBe(428);
    expect((await call('PATCH', '/v1/users/me', { cookie: manager, headers: im(me.version), body: { language: 'en' } })).statusCode).toBe(200);
    expect((await call('GET', '/v1/settings/language', { cookie: manager })).json().effective).toBe('en');
  });

  it('onboarding wizard: resumable, only optional steps can be skipped', async () => {
    const o = (await call('GET', '/v1/onboarding', { cookie: owner })).json();
    expect(o.steps).toHaveLength(10);
    const first = o.steps[0]; const optional = o.steps.find((s: { optional: boolean }) => s.optional);
    expect((await call('PUT', `/v1/onboarding/steps/${first.code}`, { cookie: owner, body: { status: 'skipped' } })).statusCode).toBe(422);
    const r = await call('PUT', `/v1/onboarding/steps/${first.code}`, { cookie: owner, body: { status: 'completed', details: { a: 1 } } });
    expect(r.json().steps[0].status).toBe('completed');
    expect(r.json().next_step).toBe(o.steps[1].code);
    if (optional) expect((await call('PUT', `/v1/onboarding/steps/${optional.code}`, { cookie: owner, body: { status: 'skipped' } })).statusCode).toBe(200);
    expect((await call('PUT', '/v1/onboarding/steps/nope_step', { cookie: owner, body: { status: 'completed' } })).statusCode).toBe(404);
  });
});

describe('branches (v1.4): bill_series_prefix optional (defaults to code); If-Match on edits', () => {
  it('create: prefix explicit/omitted/blank/invalid; PATCH 428/412/200', async () => {
    const co = (await call('GET', '/v1/companies', { cookie: owner })).json()[0];
    // invalid explicit → 422 (defaults/upper-casing: see the dedicated fixture-tenant test below)
    const inv = await call('POST', '/v1/branches', { cookie: owner, body: { company_id: co.id, code: 'TPJ', name: 'Trichy', bill_series_prefix: '-x' } });
    expect(inv.statusCode).toBe(422);
    expect(inv.json()).toMatchObject({ code: 'invalid_bill_series_prefix' });
    const r = await call('POST', '/v1/branches', { cookie: owner, body: { company_id: co.id, code: 'TPJ', name: 'Trichy', bill_series_prefix: 'TPJ/26-' } });
    if (r.statusCode === 403 || r.statusCode === 409 || r.statusCode === 422) return;   // plan branch limit may apply in the fixture plan (PATCH part only)
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().id;
    expect((await call('PATCH', `/v1/branches/${id}`, { cookie: owner, body: { name: 'Tiruchi' } })).statusCode).toBe(428);
    expect((await call('PATCH', `/v1/branches/${id}`, { cookie: owner, headers: im(5), body: { name: 'Tiruchi' } })).statusCode).toBe(412);
    const ok = await call('PATCH', `/v1/branches/${id}`, { cookie: owner, headers: im(1), body: { name: 'Tiruchi' } });
    expect(ok.statusCode, ok.body).toBe(200); expect(ok.headers.etag).toBe('"2"');
  });
});


describe('branches: bill_series_prefix default (own fixture tenant, no plan-limit skip)', () => {
  const BSLUG = `bsp-${Date.now() % 100000}`;
  let bOwner = ''; let bTenant = ''; let coId = '';
  beforeAll(async () => {
    const t = await call('POST', '/v1/admin/tenants', { cookie: admin, body: { slug: BSLUG, display_name: 'Prefix Fixture',
      company: { legal_name: 'Prefix Fixture', state_code: '33' }, branch: { code: 'HQ', name: 'HQ' },
      owner: { name: 'P', username: 'bspowner', password: 'owner-pass-123' } } });
    expect(t.statusCode, t.body).toBe(201);
    bTenant = t.json().id;
    // fixture: lift this tenant's branch cap so every create below must succeed (no early exit)
    await asMigrator(bTenant, `DELETE FROM billing.subscription`);
    const { r, cookie } = await login(BSLUG, 'bspowner', 'owner-pass-123');
    expect(r.statusCode, r.body).toBe(200);
    bOwner = cookie;
    coId = (await call('GET', '/v1/companies', { cookie: bOwner })).json()[0].id;
  });
  const create = (code: string, extra: Record<string, unknown>) =>
    call('POST', '/v1/branches', { cookie: bOwner, body: { company_id: coId, code, name: code, ...extra } });
  it.each([
    ['omitted → code', 'OMT', {}, 'OMT'],
    ['null → code', 'NUL', { bill_series_prefix: null }, 'NUL'],
    ['blank → code', 'BLK', { bill_series_prefix: '   ' }, 'BLK'],
    ['empty → code', 'EMP', { bill_series_prefix: '' }, 'EMP'],
    ['explicit lower-case → upper-cased', 'LWR', { bill_series_prefix: ' lwr/26-a ' }, 'LWR/26-A'],
    ['explicit upper-case kept', 'UPR', { bill_series_prefix: 'U/26' }, 'U/26'],
  ])('%s', async (_n, code, extra, want) => {
    const r = await create(code, extra);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().bill_series_prefix).toBe(want);
    const [row] = await asMigrator<{ p: string }>(bTenant, `SELECT bill_series_prefix p FROM platform.branch WHERE code = $1`, [code]);
    expect(row.p).toBe(want);
  });
  it('invalid explicit prefixes → 422 invalid_bill_series_prefix, nothing written', async () => {
    for (const p of ['-x', '/26', 'ABCDEFGHIJKLM', 'A B']) {
      const r = await create('BAD', { bill_series_prefix: p });
      expect(r.statusCode, p).toBe(422);
      expect(r.json()).toMatchObject({ code: 'invalid_bill_series_prefix' });
    }
    expect(await asMigrator(bTenant, `SELECT 1 FROM platform.branch WHERE code = 'BAD'`)).toHaveLength(0);
  });
});

describe('tenant default language (PATCH /v1/tenant)', () => {
  it('If-Match on tenant version, validated, audited; manager without settings.edit → 403', async () => {
    const t = await call('GET', '/v1/tenant', { cookie: owner });
    const v = t.json().version;
    expect(t.headers.etag).toBe(`"${v}"`);
    expect((await call('PATCH', '/v1/tenant', { cookie: owner, body: { default_language: 'hi' } })).statusCode).toBe(428);
    expect((await call('PATCH', '/v1/tenant', { cookie: owner, headers: im(v), body: { default_language: 'Hindi' } })).statusCode).toBe(422);
    expect((await call('PATCH', '/v1/tenant', { cookie: owner, headers: im(v), body: { default_language: 'hi', status: 'active' } })).statusCode).toBe(422);
    expect((await call('PATCH', '/v1/tenant', { cookie: owner, headers: im(v + 50), body: { default_language: 'hi' } })).statusCode).toBe(412);
    // v1.9: FK to platform.language — well-formed but unknown code → 422 unknown_language (version unchanged)
    const xx = await call('PATCH', '/v1/tenant', { cookie: owner, headers: im(v), body: { default_language: 'xx' } });
    expect(xx.statusCode, xx.body).toBe(422); expect(xx.json().code).toBe('unknown_language');
    const meId = (await call('GET', '/v1/auth/session', { cookie: owner })).json().user.id;
    const meV = (await call('GET', `/v1/users/${meId}`, { cookie: owner })).json().version;
    const ux = await call('PATCH', '/v1/users/me', { cookie: owner, headers: im(meV), body: { language: 'xx' } });
    expect(ux.statusCode, ux.body).toBe(422); expect(ux.json().code).toBe('unknown_language');
    const langs = await call('GET', '/v1/meta/languages');
    expect(langs.statusCode).toBe(200);
    expect(langs.json().map((l: { code: string }) => l.code).sort()).toEqual(['en', 'hi', 'kn', 'ml', 'ta', 'te']);
    const p = await call('PATCH', '/v1/tenant', { cookie: owner, headers: im(v), body: { default_language: 'hi' } });
    expect(p.statusCode, p.body).toBe(200);
    expect(p.json()).toMatchObject({ id: tenantId, default_language: 'hi' });
    expect(p.json().version).toBeGreaterThan(v);
    expect(p.headers.etag).toBe(`"${p.json().version}"`);
    const [{ n }] = await asMigrator<{ n: number }>(tenantId, `SELECT count(*)::int n FROM platform.audit_event WHERE action = 'tenant.default_language_changed'`);
    expect(n).toBe(1);
    const m = await call('PATCH', '/v1/tenant', { cookie: manager, headers: im(p.json().version), body: { default_language: 'en' } });
    expect([403]).toContain(m.statusCode);
    const back = await call('PATCH', '/v1/tenant', { cookie: owner, headers: im(p.json().version), body: { default_language: 'ta' } });
    expect(back.statusCode).toBe(200);
  });
});

describe('company bank accounts (v1.8 masters.bank_account)', () => {
  it('CRUD with If-Match; number encrypted (nonce|ct|tag), only last4 returned; one default per company', async () => {
    const co = (await call('GET', '/v1/companies', { cookie: owner })).json()[0];
    const base = `/v1/companies/${co.id}/bank-accounts`;
    expect((await call('POST', base, { cookie: owner, body: { bank_name: 'HDFC Bank', ifsc: 'HDFC1001234', holder_name: 'Sri Lakshmi', account_no: '501001234567' } })).statusCode).toBe(422);
    const a = await call('POST', base, { cookie: owner, body: { bank_name: 'HDFC Bank', ifsc: 'hdfc0001234', holder_name: 'Sri Lakshmi', account_no: '5010 0123 4567', is_default: true, print_on_invoice: true } });
    expect(a.statusCode, a.body).toBe(201);
    expect(a.json()).toMatchObject({ owner_type: 'company', company_id: co.id, ifsc: 'HDFC0001234', account_last4: '4567', is_default: true, version: 1 });
    expect(a.body).not.toContain('501001234567');
    expect(Object.keys(a.json())).not.toEqual(expect.arrayContaining(['account_no', 'account_no_enc', 'account_key_id']));
    const [row] = await asMigrator<{ enc: Buffer; kid: string }>(tenantId, `SELECT account_no_enc AS enc, account_key_id AS kid FROM masters.bank_account WHERE id = $1`, [a.json().id]);
    expect(row.enc.length).toBe(12 + 12 + 16);
    expect(row.enc.toString('latin1')).not.toContain('501001234567');
    const b = await call('POST', base, { cookie: owner, body: { bank_name: 'State Bank', ifsc: 'SBIN0000123', holder_name: 'Sri Lakshmi', account_no: '000011112222', is_default: true } });
    expect(b.statusCode, b.body).toBe(201);
    const list = (await call('GET', base, { cookie: owner })).json() as { id: string; is_default: boolean }[];
    expect(list.filter((x) => x.is_default).map((x) => x.id)).toEqual([b.json().id]);
    expect(JSON.stringify(list)).not.toMatch(/501001234567|000011112222/);
    const cur = await call('GET', `${base}/${a.json().id}`, { cookie: owner });
    expect(cur.headers.etag).toBeTruthy();
    expect((await call('PATCH', `${base}/${a.json().id}`, { cookie: owner, body: { branch_name: 'T Nagar' } })).statusCode).toBe(428);
    expect((await call('PATCH', `${base}/${a.json().id}`, { cookie: owner, headers: im(99), body: { branch_name: 'T Nagar' } })).statusCode).toBe(412);
    const p = await call('PATCH', `${base}/${a.json().id}`, { cookie: owner, headers: im(cur.json().version), body: { branch_name: 'T Nagar', account_no: '501009999888' } });
    expect(p.statusCode, p.body).toBe(200);
    expect(p.json()).toMatchObject({ branch_name: 'T Nagar', account_last4: '9888' });
    expect(p.json().version).toBeGreaterThan(cur.json().version);
    expect((await call('DELETE', `${base}/${b.json().id}`, { cookie: owner })).statusCode).toBe(428);
    expect((await call('DELETE', `${base}/${b.json().id}`, { cookie: owner, headers: im(b.json().version) })).statusCode).toBe(204);
    expect((await call('GET', `/v1/companies/00000000-0000-0000-0000-0000000000ff/bank-accounts`, { cookie: owner })).statusCode).toBe(404);
  });
});

describe('merged platform-ext endpoints', () => {
  it('GET /v1/meta is public; GET /v1/devices/current needs a session', async () => {
    const m = await call('GET', '/v1/meta');
    expect(m.statusCode).toBe(200);
    const { readFileSync } = await import('node:fs');
    const v = /^info:[\s\S]*?^ {2}version:\s*([^\s]+)/m.exec(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8'))?.[1];
    expect(m.json()).toMatchObject({ api_version: v, min_client_version: '0.3.0', deployment_mode: 'shared' });
    expect((await call('GET', '/v1/devices/current')).statusCode).toBe(401);
    // 0.4.3: never 404 — 200 Device, or 200 JSON null for an unregistered browser
    const d = await call('GET', '/v1/devices/current', { cookie: owner });
    expect(d.statusCode, d.body).toBe(200);
    expect(d.headers['content-type']).toMatch(/application\/json/);
    const dj = JSON.parse(d.body);
    if (dj !== null) expect(dj.id).toMatch(/^[0-9a-f-]{36}$/);
    const fresh = (await login(SLUG, 'cash1', 'cash-pass-1234')).cookie;   // plain browser login, no device key
    const n = await call('GET', '/v1/devices/current', { cookie: fresh });
    expect(n.statusCode, n.body).toBe(200);
    expect(n.body).toBe('null');
    expect(n.json()).toBeNull();
  });
});

describe('onboarding billing gate (platform.v_billing_unlocked)', () => {
  const GATE = ['shop_profile', 'gst', 'metals_purities', 'gst_rates', 'todays_rates'];
  it('exactly the 5 gate steps unlock billing; branches / print templates never block', async () => {
    const o = (await call('GET', '/v1/onboarding', { cookie: owner })).json();
    expect(o.steps.filter((s: { required_for_billing: boolean }) => s.required_for_billing).map((s: { code: string }) => s.code)).toEqual(GATE);
    // leave branches + printers/language pending throughout
    for (const step of GATE.slice(0, 4)) await call('PUT', `/v1/onboarding/steps/${step}`, { cookie: owner, body: { status: 'completed' } });
    let g = (await call('GET', '/v1/onboarding', { cookie: owner })).json();
    expect(g).toMatchObject({ billing_unlocked: false, missing_billing_steps: ['todays_rates'] });
    // 985: billing also needs today's shop-wide sale rate for every metal the shop sells (active metal with an active purity)
    //      A shop with no active metal is not "set" (985), so make sure there is one, created through the masters API.
    let metals = (await call('GET', '/v1/masters/metals', { cookie: owner })).json() as { id: string }[];
    const puritiesOf = async (metalId: string) =>
      (await call('GET', `/v1/masters/purities?metal_id=${metalId}`, { cookie: owner })).json() as { id: string; is_active?: boolean }[];
    let sold = 0;
    for (const m of metals) if ((await puritiesOf(m.id)).some((x) => x.is_active !== false)) sold++;
    if (sold === 0) {
      const m = await call('POST', '/v1/masters/metals', { cookie: owner, body: { code: 'GATEAU', name: 'Gate Gold', default_hsn: '7113' } });
      expect(m.statusCode, m.body).toBe(201);
      const p = await call('POST', '/v1/masters/purities', { cookie: owner, body: { metal_id: m.json().id, code: '22K', fineness: '916' } });
      expect(p.statusCode, p.body).toBe(201);
      metals = (await call('GET', '/v1/masters/metals', { cookie: owner })).json() as { id: string }[];
    }
    for (const m of metals) {
      const pu = (await puritiesOf(m.id)).find((x) => x.is_active !== false);
      if (!pu) continue;
      // shop-wide (no branch_id) covers every branch; sale only — old_metal is a warning, not a gate (lead rule)
      const r = await call('POST', '/v1/rates', { cookie: owner, body: { purity_id: pu.id, kind: 'sale', rate_per_g: '6500.00' } });
      expect(r.statusCode, r.body).toBe(201);
    }
    g = (await call('PUT', '/v1/onboarding/steps/todays_rates', { cookie: owner, body: { status: 'completed' } })).json();
    expect(g).toMatchObject({ billing_unlocked: true, missing_billing_steps: [] });
    expect(g.steps.find((s: { code: string }) => s.code === 'branches').status).not.toBe('completed');
    expect(g.steps.find((s: { code: string }) => s.code === 'printers_language').status).not.toBe('completed');
    expect((await call('GET', '/v1/auth/session', { cookie: owner })).json().billing_unlocked).toBe(true);
  });
});

describe('branding, domains, TLS ask, print templates', () => {
  it('theme merges platform → partner → shop; login page on a shop domain is branded', async () => {
    const t1 = (await call('GET', '/v1/branding/theme', { headers: { host: 'billing.srilakshmi.in' } })).json();
    expect(t1.effective).toMatchObject({ app_name: 'GoldDesk', logo_key: 'tenant/t1/logo.svg' });
    expect(t1.effective.colors).toEqual({ primary: '#880000', accent: '#d4af37', bg: '#ffffff' });
    expect(t1.own).toBeUndefined();
    const anon = (await call('GET', '/v1/branding/theme')).json();
    expect(anon.effective.app_name).toBe('JewelOS');
    expect((await call('PUT', '/v1/branding/theme', { cookie: owner, body: { logo_key: 'data:image/png;base64,xx' } })).statusCode).toBe(422);
    const put = await call('PUT', '/v1/branding/theme', { cookie: owner, body: { app_name: 'Ganesh', colors: { primary: '#123456' } } });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json().effective).toMatchObject({ app_name: 'Ganesh', colors: { primary: '#123456', accent: '#111111' } });
    const v = put.json().version as number;
    expect((await call('PUT', '/v1/branding/theme', { cookie: owner, body: { app_name: 'Ganesh 2' } })).statusCode).toBe(428);
    expect((await call('PUT', '/v1/branding/theme', { cookie: owner, headers: im(v + 1), body: { app_name: 'Ganesh 2' } })).statusCode).toBe(412);
    expect((await call('PUT', '/v1/branding/theme', { cookie: owner, headers: im(v), body: { app_name: 'Ganesh', colors: { primary: '#123456' } } })).statusCode).toBe(200);
  });

  it('custom domain: add → TXT verify (injected resolver) → TLS ask 200', async () => {
    const add = await call('POST', '/v1/branding/domains', { cookie: owner, body: { hostname: `${SLUG}.example.in` } });
    expect(add.statusCode, add.body).toBe(201);
    const d = add.json();
    expect(d.dns_record.name).toBe(`_jewel-verify.${SLUG}.example.in`);
    expect((await call('GET', `/v1/internal/tls/ask?domain=${SLUG}.example.in`)).statusCode).toBe(404);
    process.env.JW_TEST_TXT_RECORDS = JSON.stringify({ [d.dns_record.name]: 'wrong-value' });
    expect((await call('POST', `/v1/branding/domains/${d.id}/verify`, { cookie: owner })).json()).toMatchObject({ status: 'failed' });
    process.env.JW_TEST_TXT_RECORDS = JSON.stringify({ [d.dns_record.name]: d.dns_record.value });
    const v = await call('POST', `/v1/branding/domains/${d.id}/verify`, { cookie: owner });
    expect(v.json().status).toBe('verified');
    expect((await call('GET', `/v1/internal/tls/ask?domain=${SLUG}.example.in`)).statusCode).toBe(200);
    expect((await call('POST', '/v1/branding/domains', { cookie: owner, body: { hostname: 'billing.srilakshmi.in' } })).statusCode).toBe(409);
  });

  it('print templates: B-2 0.9.6 — custom Sales create/activate are 422 print_template_not_renderable before any write (even an allowed body_key); If-Match precedence kept', async () => {
    const count = async () => (await asMigrator<{ n: number }>(tenantId, `SELECT count(*)::int AS n FROM branding.print_template WHERE tenant_id = $1`, [tenantId]))[0].n;
    const before = await count();
    // Sales doc types only: tag_label create/activate is exempt and behaves as at b13a296 (inventory-contract.test.ts, 0.9.6 tag_label no-regression)
    for (const body of [{ doc_type: 'invoice', body_key: 'tpl/g/inv-1.hbs', print_language: 'ta', numeral_system: 'tamil' }, { doc_type: 'invoice', body_key: 'tpl/platform/invoice.hbs' },
      { doc_type: 'receipt', body_key: 'tpl/g/rcpt.hbs' }, { doc_type: 'order_receipt', body_key: 'tpl/g/order.hbs' }, { doc_type: 'rate_card', body_key: 'tpl/g/rates.hbs' }]) {
      const r = await call('POST', '/v1/print-templates', { cookie: owner, body });
      expect(r.statusCode).toBe(422); expect(r.json().code).toBe('print_template_not_renderable');
    }
    expect((await call('POST', '/v1/print-templates', { cookie: owner, body: { doc_type: 'invoice', body_key: '' } })).json().code).toBe('validation_failed'); // body validation first
    expect(await count()).toBe(before);
    // fixture SQL rows (allowed body_key under new uuids): activation keeps 428 / 412 precedence, then refuses; nothing becomes active
    const rows = await asMigrator<{ id: string; row_version: number }>(tenantId, `INSERT INTO branding.print_template(scope, tenant_id, doc_type, version, paper, body_key, is_active)
      VALUES ('tenant', $1, 'invoice', 1, 'A4', 'tpl/platform/invoice.hbs', false), ('tenant', $1, 'invoice', 2, 'A4', 'tpl/g/inv-2.hbs', false) RETURNING id, row_version`, [tenantId]);
    const a = rows[0];
    expect((await call('POST', `/v1/print-templates/${a.id}/activate`, { cookie: owner })).statusCode).toBe(428);
    expect((await call('POST', `/v1/print-templates/${a.id}/activate`, { cookie: owner, headers: { 'if-match': '"99"' } })).statusCode).toBe(412);
    for (const t of rows) {
      const r = await call('POST', `/v1/print-templates/${t.id}/activate`, { cookie: owner, headers: { 'if-match': `"${t.row_version}"` } });
      expect(r.statusCode).toBe(422); expect(r.json().code).toBe('print_template_not_renderable');
    }
    const list = (await call('GET', '/v1/print-templates?doc_type=invoice', { cookie: owner })).json() as { id: string; scope: string; is_active: boolean; renderable: boolean }[];
    expect(list.filter((t) => t.scope === 'tenant' && t.is_active)).toEqual([]);
    expect(list.filter((t) => t.renderable).map((t) => [t.id, t.scope])).toEqual([['01a1c455-29fa-769b-84f9-377a9bcdab46', 'platform']]);
    expect(list.filter((t) => rows.some((r) => r.id === t.id)).every((t) => t.renderable === false)).toBe(true);
  });
});

describe('audit log', () => {
  it('lists events (login, provisioning…) and verifies the hash chain', async () => {
    const r = await call('GET', '/v1/audit-events?limit=5', { cookie: owner });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().items.length).toBe(5);
    expect(r.json().next_before_seq).toBeGreaterThan(0);
    const logins = (await call('GET', '/v1/audit-events?action=auth.login&limit=200', { cookie: owner })).json().items;
    expect(logins.length).toBeGreaterThan(3);
    expect((await call('GET', '/v1/audit-events/verify', { cookie: owner })).json()).toMatchObject({ intact: true, first_broken_seq: null });
    const cashier = (await login(SLUG, 'cash1', 'cash-pass-1234')).cookie;
    expect((await call('GET', '/v1/audit-events', { cookie: cashier })).statusCode).toBe(403);
  });
});

describe('CSV / Excel import (P21): dry run then commit', () => {
  const multipart = (kind: string, filename: string, content: Buffer | string, fields: Record<string, string> = {}) => {
    const B = '----jwtest';
    const body = Buffer.concat([
      Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="kind"\r\n\r\n${kind}\r\n`),
      ...Object.entries(fields).map(([k, v]) => Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)),
      Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      Buffer.isBuffer(content) ? content : Buffer.from(content), Buffer.from(`\r\n--${B}--\r\n`)]);
    return { body, headers: { 'content-type': `multipart/form-data; boundary=${B}`, cookie: owner } };
  };
  const upload = (kind: string, filename: string, content: Buffer | string, fields: Record<string, string> = {}) => {
    const m = multipart(kind, filename, content, fields);
    return app.inject({ method: 'POST', url: '/api/v1/imports', payload: m.body, headers: m.headers }) as unknown as Promise<Res>;
  };

  it('template download', async () => {
    const r = await call('GET', '/v1/import-templates/customers', { cookie: owner });
    expect(r.headers['content-type']).toMatch(/text\/csv/); expect(r.body.split('\n')[0]).toMatch(/^name,phone/);
  });

  it('dry run reports row errors and writes no customers', async () => {
    const r = await upload('customers', 'c.csv', 'name,phone,gstin\nAnu,9833333333,\n,9844444444,\nBala,12345,\nAnu2,9833333333,\n');
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ dry_run: true, status: 'failed', total_rows: 4, ok_rows: 1, error_rows: 3 });
    expect(r.json().errors.map((e: { row: number; column: string }) => `${e.row}:${e.column}`)).toEqual(['3:name', '4:phone', '5:phone']);
    // v1.4: row errors live in platform.import_row_error (no JSON report file)
    const errs = await call('GET', `/v1/imports/${r.json().id}/errors`, { cookie: owner });
    expect(errs.json().map((e: { code: string }) => e.code)).toEqual(['required', 'invalid_format', 'duplicate_in_file']);
    const [{ k }] = await asMigrator<{ k: string | null }>(tenantId, `SELECT error_report_key AS k FROM platform.import_job WHERE id = $1`, [r.json().id]);
    expect(k).toBeNull();
    const [{ n }] = await asMigrator<{ n: number }>(tenantId, `SELECT count(*)::int n FROM masters.customer`);
    expect(n).toBe(0);
    expect((await call('POST', `/v1/imports/${r.json().id}/commit`, { cookie: owner, headers: { 'idempotency-key': 'k-000000001' } })).statusCode).toBe(409);
  });

  it('QA IDEM-3 — clean xlsx missing key400 changes no job/customers; commit and replay return the same job', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('c');
    ws.addRow(['Name', 'Phone', 'State_Code']); ws.addRow(['Kavya', '+91 98555 55555', '33']); ws.addRow(['Ravi', '9866666666', '']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const dry = await upload('customers', 'c.xlsx', buf);
    expect(dry.json(), dry.body).toMatchObject({ status: 'validated', ok_rows: 2, error_rows: 0 });
    const state=()=>asMigrator(tenantId,`SELECT
      (SELECT count(*) FROM platform.import_job) AS jobs,
      (SELECT count(*) FROM masters.customer) AS customers,
      (SELECT status FROM platform.import_job WHERE id=$1) AS dry_status`,[dry.json().id]);
    const before=await state();
    const missing=await call('POST', `/v1/imports/${dry.json().id}/commit`, { cookie: owner });
    expect(missing.statusCode).toBe(400);expect(missing.json()).toMatchObject({status:400,code:'idempotency_key_required'});
    expect(await state()).toEqual(before);
    const c1 = await call('POST', `/v1/imports/${dry.json().id}/commit`, { cookie: owner, headers: { 'idempotency-key': 'k-000000002' } });
    expect(c1.statusCode, c1.body).toBe(201);
    expect(c1.json()).toMatchObject({ dry_run: false, dry_run_of: dry.json().id, status: 'completed', ok_rows: 2 });
    const c2 = await call('POST', `/v1/imports/${dry.json().id}/commit`, { cookie: owner, headers: { 'idempotency-key': 'k-000000002' } });
    expect(c2.statusCode).toBe(200); expect(c2.json().id).toBe(c1.json().id);
    const rows = await asMigrator<{ phone: string }>(tenantId, `SELECT phone FROM masters.customer ORDER BY phone`);
    expect(rows.map((r) => r.phone)).toEqual(['9855555555', '9866666666']);
  });

  it('signed download link (0.5.0): 5-min token streams the stored file with no-store headers; tamper 404, expiry 410', async () => {
    const csv = 'name,phone\nDl,9811111111\n';
    const dry = await upload('customers', 'd.csv', csv);
    expect(dry.statusCode, dry.body).toBe(201);
    const [{ k }] = await asMigrator<{ k: string }>(tenantId, `SELECT file_key AS k FROM platform.import_job WHERE id = $1`, [dry.json().id]);
    expect(k).toMatch(new RegExp(`^${tenantId}/imports/[0-9a-f-]{36}$`));
    expect((await app.inject({ method: 'GET', url: `/api/v1/files/${dry.json().id}/url` })).statusCode).toBe(401);
    const u = await call('GET', `/v1/files/${dry.json().id}/url`, { cookie: owner });
    expect(u.statusCode, u.body).toBe(200);
    expect(u.json().url).toMatch(/^\/files\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const ttl = Date.parse(u.json().expires_at) - Date.now();
    expect(ttl).toBeGreaterThan(240_000); expect(ttl).toBeLessThanOrEqual(300_000);
    const d = await app.inject({ method: 'GET', url: u.json().url }) as unknown as Res;   // no cookie
    expect(d.statusCode, d.body).toBe(200);
    expect(d.body).toBe(csv);
    expect(d.headers['content-type']).toMatch(/^text\/csv/);
    expect(d.headers['content-disposition']).toBe(`attachment; filename="d.csv"; filename*=UTF-8''d.csv`);   // 0.5.1: job → its file row
    expect(d.headers['cache-control']).toBe('no-store');
    expect((await app.inject({ method: 'GET', url: `/api${u.json().url}` })).statusCode).toBe(404);   // not under /api
    const [b, s] = u.json().url.slice('/files/'.length).split('.');
    const bad = await app.inject({ method: 'GET', url: `/files/${b}.${s.slice(0, -2)}${s.endsWith('AA') ? 'BB' : 'AA'}` }) as unknown as Res;
    expect(bad.statusCode).toBe(404); expect(bad.headers['content-type']).toMatch(/problem\+json/);
    const { signFileToken } = await import('@jw/mod-platform');
    const old = signFileToken(Buffer.from(process.env.FILE_TOKEN_SECRET!, 'utf8'), { tenantId, fileId: dry.json().id, objectKey: k },
      Math.floor(Date.now() / 1000) - 600).token;
    expect((await app.inject({ method: 'GET', url: `/files/${old}` })).statusCode).toBe(410);
    expect((await call('GET', `/v1/files/00000000-0000-7000-8000-000000000000/url`, { cookie: owner })).statusCode).toBe(404);
  });

  it('0.5.1 (974): upload writes platform.file (sha256 raw 32 bytes) + import_job.file_id; URL by file id; unicode name', async () => {
    const { createHash } = await import('node:crypto');
    const csv = 'name,phone\nUni,9822222222\n';
    const name = 'ग्राहक list€.csv';
    const dry = await upload('customers', name, csv);
    expect(dry.statusCode, dry.body).toBe(201);
    const fileId = dry.json().file_id;
    expect(fileId).toMatch(/^[0-9a-f-]{36}$/);
    const [f] = await asMigrator<{ area: string; object_key: string; original_name: string; content_type: string; size_bytes: string; sha256: Buffer; created_by: string; deleted_at: null; jk: string }>(tenantId,
      `SELECT f.area, f.object_key, f.original_name, f.content_type, f.size_bytes::text, f.sha256, f.created_by, f.deleted_at, j.file_key AS jk
         FROM platform.file f JOIN platform.import_job j ON j.file_id = f.id AND j.tenant_id = f.tenant_id WHERE j.id = $1`, [dry.json().id]);
    expect(f).toMatchObject({ area: 'imports', content_type: 'text/csv', size_bytes: String(Buffer.byteLength(csv)), deleted_at: null });
    expect(f.jk).toBe(f.object_key); expect(f.object_key.startsWith(`${tenantId}/imports/`)).toBe(true);
    expect(f.original_name).toBe(name);
    expect(f.sha256).toHaveLength(32);
    expect(f.sha256.equals(createHash('sha256').update(csv).digest())).toBe(true);
    expect(f.created_by).toBeTruthy();
    const u = await call('GET', `/v1/files/${fileId}/url`, { cookie: owner });
    expect(u.statusCode, u.body).toBe(200);
    const d = await app.inject({ method: 'GET', url: u.json().url }) as unknown as Res;
    expect(d.statusCode).toBe(200); expect(d.body).toBe(csv);
    const cd = String(d.headers['content-disposition']);
    expect(cd).toMatch(/^attachment; filename="[\x20-\x7e]+"; filename\*=UTF-8''[A-Za-z0-9%._~!-]+$/);
    expect(cd).not.toMatch(/[\r\n]/);
    expect(cd).toContain('filename="______ list_.csv"');
    expect(decodeURIComponent(cd.split("UTF-8''")[1])).toBe(name);
  });

  it('0.5.1: legacy job without file_id resolves by job id; soft-deleted file → 404 (url and existing link)', async () => {
    const a = await upload('customers', 'legacy.csv', 'name,phone\nLeg,9833333331\n');
    await asMigrator(tenantId, `UPDATE platform.import_job SET file_id = NULL WHERE id = $1`, [a.json().id]);
    const lu = await call('GET', `/v1/files/${a.json().id}/url`, { cookie: owner });
    expect(lu.statusCode, lu.body).toBe(200);
    const ld = await app.inject({ method: 'GET', url: lu.json().url }) as unknown as Res;
    expect(ld.statusCode).toBe(200);
    expect(ld.headers['content-disposition']).toContain(`filename="import-${a.json().id}.csv"`);

    const b = await upload('customers', 'gone.csv', 'name,phone\nGone,9833333332\n');
    const fid = b.json().file_id;
    const link = (await call('GET', `/v1/files/${fid}/url`, { cookie: owner })).json().url;
    await asMigrator(tenantId, `UPDATE platform.file SET deleted_at = now() WHERE id = $1`, [fid]);
    expect((await call('GET', `/v1/files/${fid}/url`, { cookie: owner })).statusCode).toBe(404);
    expect((await call('GET', `/v1/files/${b.json().id}/url`, { cookie: owner })).statusCode).toBe(404);   // its job id too
    expect((await app.inject({ method: 'GET', url: link })).statusCode).toBe(404);                        // already-issued link
  });

  it('customers with PAN: stored encrypted (pan_enc) + last 4 only', async () => {
    const dry = await upload('customers', 'p.csv', 'name,phone,pan\nPriya,9877777777,ABCDE1234F\nBad,9877777778,ABC\n');
    expect(dry.json().errors.map((e: { column: string }) => e.column)).toEqual(['pan']);
    const ok = await upload('customers', 'p2.csv', 'name,phone,pan\nPriya,9877777777,abcde1234f\n');
    expect(ok.json().status).toBe('validated');
    expect((await call('POST', `/v1/imports/${ok.json().id}/commit`, { cookie: owner, headers: { 'idempotency-key': 'k-000000003' } })).statusCode).toBe(201);
    const [c] = await asMigrator<{ last4: string; enc: Buffer; kid: string }>(tenantId, `SELECT pan_last4 AS last4, pan_enc AS enc, pan_key_id AS kid FROM masters.customer WHERE phone = '9877777777'`);
    expect(c.last4).toBe('234F');
    expect(c.kid).toMatch(/^[a-z0-9._-]{1,40}$/);   // v1.5: pan_enc + pan_key_id + pan_last4 always together
    expect(c.enc.length).toBeGreaterThanOrEqual(28);
    expect(c.enc.toString('latin1')).not.toContain('ABCDE1234F');
  });

  it('mapping profiles: CRUD with If-Match, applied on upload', async () => {
    expect((await call('POST', '/v1/import-mapping-profiles', { cookie: owner, body: { kind: 'customers', name: 'Tally', mapping: { nope: 'X' } } })).statusCode).toBe(422);
    const p = await call('POST', '/v1/import-mapping-profiles', { cookie: owner, body: { kind: 'customers', name: 'Tally', mapping: { name: 'Party Name', phone: 'Mobile No' } } });
    expect(p.statusCode, p.body).toBe(201);
    const id = p.json().id;
    expect((await call('POST', '/v1/import-mapping-profiles', { cookie: owner, body: { kind: 'customers', name: 'Tally', mapping: {} } })).statusCode).toBe(409);
    // without the profile the raw Tally headers don't match the template
    const raw = 'PARTY NAME , Mobile No\nSundar,9888888881\n';
    const noProf = await upload('customers', 'm.csv', raw);
    expect(noProf.statusCode).toBe(422); expect(noProf.json().code).toBe('template_mismatch');
    // with profile_id + file: the profile maps the file's raw source headers (trimmed, case-insensitive) onto template columns
    const dry = await upload('customers', 'm.csv', raw, { profile_id: id });
    expect(dry.json(), dry.body).toMatchObject({ status: 'validated', ok_rows: 1, mapping_profile_id: id });
    const cm = await call('POST', `/v1/imports/${dry.json().id}/commit`, { cookie: owner, headers: { 'idempotency-key': 'map-commit-0001' } });
    expect(cm.statusCode, cm.body).toBe(201);
    expect(cm.json().mapping_profile_id).toBe(id);
    const mapped = await asMigrator<{ name: string }>(tenantId, `SELECT name FROM masters.customer WHERE phone = '9888888881'`);
    expect(mapped).toEqual([{ name: 'Sundar' }]);
    expect((await call('PATCH', `/v1/import-mapping-profiles/${id}`, { cookie: owner, body: { name: 'Tally 2' } })).statusCode).toBe(428);
    expect((await call('PATCH', `/v1/import-mapping-profiles/${id}`, { cookie: owner, headers: im(9), body: { name: 'Tally 2' } })).statusCode).toBe(412);
    const u = await call('PATCH', `/v1/import-mapping-profiles/${id}`, { cookie: owner, headers: im(1), body: { name: 'Tally 2' } });
    expect(u.json()).toMatchObject({ name: 'Tally 2', version: 2 });
    expect((await call('GET', '/v1/import-mapping-profiles?kind=customers', { cookie: owner })).json().map((x: { id: string }) => x.id)).toContain(id);
    expect((await call('DELETE', `/v1/import-mapping-profiles/${id}`, { cookie: owner, headers: im(1) })).statusCode).toBe(412);
    // v1.5: import_job.mapping_profile_id references the profile → a used profile cannot be deleted
    const del = await call('DELETE', `/v1/import-mapping-profiles/${id}`, { cookie: owner, headers: im(2) });
    expect(del.statusCode).toBe(409); expect(del.json().code).toBe('mapping_profile_in_use');
  });

  it('970: commit uses ONLY the dry run mapping_snapshot; editing the profile afterwards changes nothing', async () => {
    const p = await call('POST', '/v1/import-mapping-profiles', { cookie: owner, body: { kind: 'customers', name: 'Busy', mapping: { name: 'Party', phone: 'Mobile' } } });
    expect(p.statusCode, p.body).toBe(201);
    const dry = await upload('customers', 'b.csv', 'Party,Mobile,Alias\nRavi Kumar,9888888882,RK\n', { profile_id: p.json().id });
    expect(dry.json(), dry.body).toMatchObject({ status: 'validated', ok_rows: 1, mapping_snapshot: { name: 'Party', phone: 'Mobile' } });
    // edit the profile after the dry run: name now comes from Alias
    const e = await call('PATCH', `/v1/import-mapping-profiles/${p.json().id}`, { cookie: owner, headers: im(p.json().version), body: { mapping: { name: 'Alias', phone: 'Mobile' } } });
    expect(e.statusCode, e.body).toBe(200);
    const cm = await call('POST', `/v1/imports/${dry.json().id}/commit`, { cookie: owner, headers: { 'idempotency-key': 'snap-commit-0001' } });
    expect(cm.statusCode, cm.body).toBe(201);
    expect(cm.json().mapping_snapshot).toEqual({ name: 'Party', phone: 'Mobile' });
    expect(await asMigrator<{ name: string }>(tenantId, `SELECT name FROM masters.customer WHERE phone = '9888888882'`)).toEqual([{ name: 'Ravi Kumar' }]);
    // the snapshot is immutable in the DB (970 trigger)
    await expect(asMigrator(tenantId, `UPDATE platform.import_job SET mapping_snapshot = '{}' WHERE id = $1`, [dry.json().id])).rejects.toThrow(/immutable/);
  });

  it('stock needs branch_id and resolves item/purity codes; errors per row', async () => {
    expect((await upload('stock', 's.csv', 'tag_no,item_code,purity_code,gross_wt,net_wt\nT1,X,22K,10.000,9.000\n')).statusCode).toBe(422);
    const b = (await call('GET', '/v1/branches', { cookie: owner })).json()[0].id;
    const r = await upload('stock', 's.csv', 'tag_no,item_code,purity_code,gross_wt,net_wt,huid\nT1,NOPE,22K,10.000,9.000,AB12CD\nT2,NOPE,22K,1.000,2.000,\n', { branch_id: b });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().status).toBe('failed');
    const cols = r.json().errors.map((e: { row: number; column: string }) => `${e.row}:${e.column}`);
    expect(cols).toContain('2:item_code'); expect(cols).toContain('3:net_wt');
    // UNVERIFIED: a clean stock commit needs masters.item/purity rows for this tenant (not in the fixture); add on the VPS.
  });

  it('opening balances: validates group, kind, amount (decimal string), dr/cr', async () => {
    const r = await upload('opening_balances', 'o.csv',
      'account_name,account_group,kind,opening_amount,dr_cr\nCash in hand,Nope Group,cash,1000.50,dr\nX,Nope Group,weird,1.234,up\n');
    expect(r.statusCode, r.body).toBe(201);
    const cols = r.json().errors.map((e: { row: number; column: string }) => `${e.row}:${e.column}`);
    expect(cols).toEqual(expect.arrayContaining(['2:account_group', '3:kind', '3:opening_amount', '3:dr_cr']));
  });
});

describe('partner console (P2/P3): branding + billing only, never shop data', () => {
  let pc = '';
  it('admin creates the first partner_admin; partner logs in with a DB-backed session (no X-Partner-Key)', async () => {
    const email = `owner-${Date.now() % 100000}@kovai.test`;
    const u = await call('POST', `/v1/admin/partners/${PARTNER_ID}/users`, { cookie: admin, body: { name: 'Kovai Admin', email, role: 'partner_admin', password: 'partner-pass-1' } });
    expect(u.statusCode, u.body).toBe(201);
    expect((await call('GET', '/v1/partner/tenants', { headers: { 'x-partner-key': 'pk_test_kovai_0123456789' } })).statusCode).toBe(401);
    expect((await call('POST', '/v1/partner/auth/login', { body: { partner_id: PARTNER_ID, email, password: 'wrong-pass-1' } })).statusCode).toBe(401);
    expect((await call('POST', '/v1/partner/auth/login', { body: { partner: 'no-such-partner', email, password: 'partner-pass-1' } })).statusCode).toBe(401);
    // v1.5: partner resolved from its slug via platform.resolve_partner()
    const r = await call('POST', '/v1/partner/auth/login', { body: { partner: 'kovai-resell', email, password: 'partner-pass-1' } });
    expect(r.statusCode, r.body).toBe(200);
    expect(String(r.headers['set-cookie'])).toMatch(/psid=.*HttpOnly/i);
    pc = cookieOf(r, 'psid');
    expect(r.json()).toMatchObject({ partner_id: PARTNER_ID, user: { email, role: 'partner_admin' } });
    expect((await call('GET', '/v1/partner/auth/session', { cookie: pc })).statusCode).toBe(200);
    const staff = await call('POST', '/v1/partner/users', { cookie: pc, body: { name: 'Staff', email: `s-${email}`, password: 'partner-pass-2' } });
    expect(staff.statusCode, staff.body).toBe(201);
    expect((await call('PATCH', `/v1/partner/users/${staff.json().id}`, { cookie: pc, body: { is_active: false } })).statusCode).toBe(428);
    expect((await call('PATCH', `/v1/partner/users/${staff.json().id}`, { cookie: pc, headers: im(staff.json().version), body: { is_active: false } })).statusCode).toBe(200);
  });

  it('sees its shops (v_partner_tenant_directory) and their subscriptions, not other shops', async () => {
    expect((await call('GET', '/v1/partner/tenants')).statusCode).toBe(401);
    const t = (await call('GET', '/v1/partner/tenants', { cookie: pc })).json();
    expect(t.map((x: { tenant_id: string }) => x.tenant_id)).toEqual([T1]);
    expect(Object.keys(t[0]).sort()).toEqual(['display_name', 'plan_code', 'plan_name', 'subscription_status', 'tenant_id', 'tenant_status']);
    const s = (await call('GET', '/v1/partner/billing/subscriptions', { cookie: pc })).json();
    expect(s.map((x: { tenant_id: string }) => x.tenant_id)).toEqual([T1]);
    const th = (await call('GET', '/v1/partner/branding/theme', { cookie: pc })).json();
    expect(th.own.app_name).toBe('GoldDesk');
  });

  it('a partner context never sees tenant print templates (partner_no_tenant_templates)', async () => {
    const rw = pool('app_rw');
    const c = await rw.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      const own = (await c.query(`SELECT count(*)::int n FROM branding.print_template WHERE tenant_id = $1`, [tenantId])).rows[0].n;
      expect(own).toBeGreaterThan(0);   // created in the print-template test above
      await c.query(`SELECT set_config('app.partner_id', $1, true)`, [PARTNER_ID]);   // even with a tenant id set
      expect((await c.query(`SELECT count(*)::int n FROM branding.print_template WHERE tenant_id IS NOT NULL`)).rows[0].n).toBe(0);
      await c.query(`SELECT set_config('app.tenant_id', '', true)`);
      expect((await c.query(`SELECT count(*)::int n FROM branding.print_template WHERE tenant_id IS NOT NULL`)).rows[0].n).toBe(0);
    } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); await rw.end(); }
  });

  it('partner logout revokes the session', async () => {
    expect((await call('POST', '/v1/partner/auth/logout', { cookie: pc })).statusCode).toBe(204);
    expect((await call('GET', '/v1/partner/tenants', { cookie: pc })).statusCode).toBe(401);
  });

  it('a partner tx sees zero rows of shop tables (sales, masters, platform users …)', async () => {
    const rw = pool('app_rw');
    const c = await rw.connect();
    const seen: Record<string, number | string> = {};
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.partner_id', '00000000-0000-0000-0000-0000000000a1', true), set_config('app.tenant_id', $1, true)`, [T1]);
      for (const t of ['masters.customer', 'inventory.tag', 'platform.app_user', 'platform.user_session', 'platform.audit_event', 'notifications.outbox']) {
        await c.query('SAVEPOINT s');
        try { seen[t] = (await c.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n; await c.query('RELEASE SAVEPOINT s'); }
        catch (e) { seen[t] = `denied:${(e as Error).message.slice(0, 40)}`; await c.query('ROLLBACK TO SAVEPOINT s'); }
      }
      await c.query(`SELECT set_config('app.tenant_id', '', true)`);   // the api's partner tx: partner only
      seen['tenant print_template'] = (await c.query(`SELECT count(*)::int n FROM branding.print_template WHERE tenant_id IS NOT NULL`)).rows[0].n;
    } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); await rw.end(); }
    for (const [t, n] of Object.entries(seen)) expect(n === 0 || String(n).startsWith('denied'), `${t}=${n}`).toBe(true);
  });
});

describe('tenant isolation + suspension through the API', () => {
  it('a shop session never sees another shop', async () => {
    const r = (await call('GET', '/v1/branches', { cookie: owner })).json();
    expect(r.every((b: { id: string }) => !b.id.endsWith('b001') && !b.id.endsWith('b002'))).toBe(true);
    const sessions = (await call('GET', '/v1/auth/sessions', { cookie: owner })).json();
    expect(sessions.length).toBeGreaterThan(0);
    void T2;
  });

  it('admin suspends → live sessions rejected and logins refused; reactivate restores', async () => {
    const s = await call('POST', `/v1/admin/tenants/${tenantId}/suspend`, { cookie: admin, body: { reason: 'non-payment' } });
    expect(s.json()).toMatchObject({ status: 'suspended', suspend_reason: 'non-payment' });
    const r = await call('GET', '/v1/auth/session', { cookie: owner });
    expect(r.statusCode).toBe(403); expect(r.json().code).toBe('tenant_suspended');
    expect((await login(SLUG, 'ganesh', 'owner-pass-123')).r.statusCode).toBe(401);
    await call('POST', `/v1/admin/tenants/${tenantId}/reactivate`, { cookie: admin });
    expect((await call('GET', '/v1/auth/session', { cookie: owner })).statusCode).toBe(200);
  });

  it('errors are application/problem+json', async () => {
    const r = await call('GET', '/v1/auth/session');
    expect(r.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(r.json()).toMatchObject({ status: 401, code: 'unauthenticated' });
  });
});

describe('masters + rates (onboarding steps marked by writes)', () => {
  const step = async (k: string) => (await asMigrator<{ status: string }>(tenantId, `SELECT status FROM platform.onboarding_progress WHERE step = $1`, [k]))[0]?.status;
  it('metals/purities CRUD marks metals_purities; rates publish marks todays_rates; /rates/current resolves', async () => {
    await asMigrator(tenantId, `UPDATE platform.onboarding_progress SET status = 'pending', completed_at = NULL WHERE step IN ('metals_purities','todays_rates')`);
    expect((await call('GET', '/v1/masters/metals')).statusCode).toBe(401);
    // fresh cashier: cash1 has used its 10 logins / 5 min (per-login throttle) by now
    const br = (await call('GET', '/v1/branches', { cookie: owner })).json()[0].id;
    expect((await call('POST', '/v1/users', { cookie: owner, body: { name: 'Cash M', username: 'cashm', password: 'cash-pass-5678', roles: [{ role: 'cashier', branch_id: br }] } })).statusCode).toBe(201);
    const cashLogin = await login(SLUG, 'cashm', 'cash-pass-5678');
    expect(cashLogin.r.statusCode, cashLogin.r.body).toBe(200);
    const cashCookie = cashLogin.cookie;
    expect((await call('POST', '/v1/masters/metals', { cookie: cashCookie, body: { code: 'PLATX', name: 'Platinum', default_hsn: '7113' } })).statusCode).toBe(403);
    expect((await call('POST', '/v1/masters/metals', { cookie: owner, body: { code: 'plat', name: 'P', default_hsn: '7113' } })).statusCode).toBe(422);
    const m = await call('POST', '/v1/masters/metals', { cookie: owner, body: { code: 'PLATX', name: 'Platinum', default_hsn: '7113' } });
    expect(m.statusCode).toBe(201);
    const metal = m.json();
    expect(metal).toMatchObject({ code: 'PLATX', name: 'Platinum', default_hsn: '7113' });
    expect((await call('POST', '/v1/masters/metals', { cookie: owner, body: { code: 'PLATX', name: 'Dup', default_hsn: '7113' } })).json()).toMatchObject({ status: 409, code: 'duplicate_code' });
    expect(metal).toMatchObject({ version: 1, is_active: true });
    expect(m.headers.etag).toBe('"1"');
    // 972: If-Match required on PATCH — 428 missing, 412 stale, 404 unknown id
    expect((await call('PATCH', `/v1/masters/metals/${metal.id}`, { cookie: owner, body: { name: 'Platinum 950' } })).statusCode).toBe(428);
    expect((await call('PATCH', `/v1/masters/metals/${metal.id}`, { cookie: owner, headers: im(9), body: { name: 'Platinum 950' } })).statusCode).toBe(412);
    const mp = await call('PATCH', `/v1/masters/metals/${metal.id}`, { cookie: owner, headers: im(1), body: { name: 'Platinum 950' } });
    expect(mp.json()).toMatchObject({ name: 'Platinum 950', default_hsn: '7113', version: 2, is_active: true });
    expect(mp.headers.etag).toBe('"2"');
    expect((await call('PATCH', `/v1/masters/metals/${metal.id}`, { cookie: owner, headers: im(1), body: { name: 'x' } })).statusCode).toBe(412);
    expect((await call('PATCH', `/v1/masters/metals/${metal.id}`, { cookie: owner, headers: im(2), body: { version: 7 } })).statusCode).toBe(422);
    expect((await call('PATCH', '/v1/masters/metals/00000000-0000-0000-0000-000000000000', { cookie: owner, headers: im(1), body: { name: 'x' } })).statusCode).toBe(404);
    expect((await call('GET', '/v1/masters/metals', { cookie: owner })).json().map((x: { code: string }) => x.code)).toContain('PLATX');
    // 0.6.0: GET by id (ETag, inactive rows readable), q search (code/name, case-insensitive)
    const mg = await call('GET', `/v1/masters/metals/${metal.id}`, { cookie: manager });
    expect(mg.statusCode).toBe(200);
    expect(mg.headers.etag).toBe('"2"');
    expect(mg.json()).toMatchObject({ id: metal.id, code: 'PLATX', version: 2, is_active: true });
    expect((await call('GET', '/v1/masters/metals/00000000-0000-0000-0000-000000000000', { cookie: owner })).statusCode).toBe(404);
    expect((await call('GET', '/v1/masters/metals/not-a-uuid', { cookie: owner })).statusCode).toBe(400);
    const qm = (await call('GET', '/v1/masters/metals?q=platinum%20950', { cookie: owner })).json();
    expect(qm.map((x: { code: string }) => x.code)).toEqual(['PLATX']);
    expect((await call('GET', '/v1/masters/metals?q=PLAT', { cookie: owner })).json().map((x: { code: string }) => x.code)).toContain('PLATX');
    expect((await call('GET', `/v1/masters/metals?q=${'x'.repeat(101)}`, { cookie: owner })).statusCode).toBe(422);

    expect((await call('POST', '/v1/masters/purities', { cookie: owner, body: { metal_id: metal.id, code: 'P950', fineness: '1000.5' } })).statusCode).toBe(422);
    expect((await call('POST', '/v1/masters/purities', { cookie: owner, body: { metal_id: metal.id, code: 'P950', fineness: 950 } })).statusCode).toBe(422);
    const p = await call('POST', '/v1/masters/purities', { cookie: owner, body: { metal_id: metal.id, code: 'P950', fineness: '950.000' } });
    expect(p.statusCode).toBe(201);
    const purity = p.json();
    expect(purity).toMatchObject({ code: 'P950', fineness: '950.000', huid_required: true, header_visible: false });
    expect((await call('POST', '/v1/masters/purities', { cookie: owner, body: { metal_id: metal.id, code: 'P950', fineness: '950.000' } })).json())
      .toMatchObject({ status: 409, code: 'duplicate_code' });
    expect(await step('metals_purities')).toBe('completed');
    expect((await call('PATCH', `/v1/masters/purities/${purity.id}`, { cookie: owner, body: { header_visible: true } })).statusCode).toBe(428);
    expect((await call('PATCH', `/v1/masters/purities/${purity.id}`, { cookie: owner, headers: im(5), body: { header_visible: true } })).statusCode).toBe(412);
    const pp = await call('PATCH', `/v1/masters/purities/${purity.id}`, { cookie: owner, headers: im(1), body: { fineness: '950.500', header_visible: true } });
    expect(pp.json()).toMatchObject({ fineness: '950.500', header_visible: true, version: 2, is_active: true });
    expect(pp.headers.etag).toBe('"2"');
    const pg = await call('GET', `/v1/masters/purities/${purity.id}`, { cookie: manager });
    expect(pg.statusCode).toBe(200);
    expect(pg.headers.etag).toBe('"2"');
    expect(pg.json()).toMatchObject({ id: purity.id, metal_id: metal.id, fineness: '950.500', version: 2 });
    expect((await call('GET', '/v1/masters/purities/00000000-0000-0000-0000-000000000000', { cookie: owner })).statusCode).toBe(404);
    expect((await call('GET', `/v1/masters/purities?q=p95`, { cookie: owner })).json().map((x: { id: string }) => x.id)).toEqual([purity.id]);
    expect((await call('GET', `/v1/masters/purities?metal_id=${metal.id}`, { cookie: owner })).json()).toHaveLength(1);

    expect(await step('todays_rates')).not.toBe('completed');
    expect((await call('POST', '/v1/rates', { cookie: owner, body: { purity_id: purity.id, kind: 'sale', rate_per_g: 3100 } })).statusCode).toBe(422);
    expect((await call('POST', '/v1/rates', { cookie: owner, body: { purity_id: purity.id, kind: 'sale', rate_per_g: '0.00' } })).statusCode).toBe(422);
    const r1 = await call('POST', '/v1/rates', { cookie: manager, body: { purity_id: purity.id, kind: 'sale', rate_per_g: '3100.00' } });
    expect(r1.statusCode).toBe(201);
    expect(r1.json()).toMatchObject({ rate_per_g: '3100.00', kind: 'sale', branch_id: null, rate_date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()) });
    expect(await step('todays_rates')).toBe('completed');
    await new Promise((res) => setTimeout(res, 5));
    expect((await call('POST', '/v1/rates', { cookie: owner, body: { purity_id: purity.id, kind: 'sale', rate_per_g: '3125.50' } })).statusCode).toBe(201);
    const cur = (await call('GET', '/v1/rates/current', { cookie: owner })).json().filter((x: { purity_id: string }) => x.purity_id === purity.id);
    expect(cur).toEqual([expect.objectContaining({ kind: 'sale', rate_per_g: '3125.50' })]);
    const [{ n }] = await asMigrator<{ n: number }>(tenantId, `SELECT count(*)::int n FROM rates.metal_rate WHERE purity_id = $1`, [purity.id]);
    expect(n).toBe(2);

    // GET /v1/rates: history newest first, filters, keyset pagination
    await call('POST', '/v1/rates', { cookie: owner, body: { purity_id: purity.id, kind: 'old_metal', rate_per_g: '2900.00' } });
    expect((await call('GET', '/v1/rates')).statusCode).toBe(401);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    const all = (await call('GET', `/v1/rates?purity_id=${purity.id}`, { cookie: manager })).json();
    expect(all.items.map((x: { rate_per_g: string }) => x.rate_per_g)).toEqual(['2900.00', '3125.50', '3100.00']);
    expect(all.next_cursor).toBeNull();
    const sale = (await call('GET', `/v1/rates?purity_id=${purity.id}&kind=sale&from=${today}&to=${today}`, { cookie: owner })).json();
    expect(sale.items.map((x: { rate_per_g: string }) => x.rate_per_g)).toEqual(['3125.50', '3100.00']);
    expect((await call('GET', `/v1/rates?purity_id=${purity.id}&to=2000-01-01`, { cookie: owner })).json().items).toHaveLength(0);
    expect((await call('GET', `/v1/rates?purity_id=${purity.id}&branch_id=00000000-0000-0000-0000-000000000000`, { cookie: owner })).json().items).toHaveLength(0);
    const p1 = (await call('GET', `/v1/rates?purity_id=${purity.id}&limit=2`, { cookie: owner })).json();
    expect(p1.items).toHaveLength(2);
    expect(p1.next_cursor).toEqual(expect.any(String));
    const p2 = (await call('GET', `/v1/rates?purity_id=${purity.id}&limit=2&cursor=${p1.next_cursor}`, { cookie: owner })).json();
    expect(p2).toEqual({ items: [expect.objectContaining({ rate_per_g: '3100.00' })], next_cursor: null });
    expect((await call('GET', '/v1/rates?cursor=garbage', { cookie: owner })).statusCode).toBe(422);
    expect((await call('GET', '/v1/rates?kind=gold', { cookie: owner })).statusCode).toBe(422);

    // 972: deactivate via PATCH {is_active:false}; lists hide inactive unless include_inactive=true; inactive_master on use
    const pd = await call('PATCH', `/v1/masters/purities/${purity.id}`, { cookie: owner, headers: im(2), body: { is_active: false } });
    expect(pd.json()).toMatchObject({ is_active: false, version: 3 });
    expect((await call('GET', `/v1/masters/purities?metal_id=${metal.id}`, { cookie: owner })).json()).toHaveLength(0);
    expect((await call('GET', `/v1/masters/purities?metal_id=${metal.id}&include_inactive=true`, { cookie: owner })).json())
      .toEqual([expect.objectContaining({ id: purity.id, is_active: false })]);
    const ir = await call('POST', '/v1/rates', { cookie: owner, body: { purity_id: purity.id, kind: 'sale', rate_per_g: '3200.00' } });
    expect(ir.statusCode).toBe(422);
    expect(ir.json()).toMatchObject({ code: 'inactive_master' });
    const curIds = async () => (await call('GET', '/v1/rates/current', { cookie: owner })).json().map((x: { purity_id: string }) => x.purity_id);
    expect(await curIds()).not.toContain(purity.id);   // deactivated purity: hidden from current …
    expect((await call('GET', `/v1/rates?purity_id=${purity.id}`, { cookie: owner })).json().items).toHaveLength(3);   // … kept in history
    const md = await call('PATCH', `/v1/masters/metals/${metal.id}`, { cookie: owner, headers: im(2), body: { is_active: false } });
    expect(md.json()).toMatchObject({ is_active: false, version: 3 });
    // active purity under an inactive metal: still hidden from current, kept in history
    expect((await call('PATCH', `/v1/masters/purities/${purity.id}`, { cookie: owner, headers: im(3), body: { is_active: true } })).json()).toMatchObject({ is_active: true, version: 4 });
    expect(await curIds()).not.toContain(purity.id);
    expect((await call('GET', `/v1/rates?purity_id=${purity.id}`, { cookie: owner })).json().items).toHaveLength(3);
    expect((await call('GET', '/v1/masters/metals', { cookie: owner })).json().map((x: { id: string }) => x.id)).not.toContain(metal.id);
    expect((await call('GET', '/v1/masters/metals?include_inactive=true', { cookie: owner })).json().map((x: { id: string }) => x.id)).toContain(metal.id);
    expect((await call('GET', '/v1/masters/metals?include_inactive=yes', { cookie: owner })).statusCode).toBe(422);
    const ip = await call('POST', '/v1/masters/purities', { cookie: owner, body: { metal_id: metal.id, code: 'P900', fineness: '900.000' } });
    expect(ip.statusCode).toBe(422);
    expect(ip.json()).toMatchObject({ code: 'inactive_master' });
    // reactivate
    expect((await call('PATCH', `/v1/masters/metals/${metal.id}`, { cookie: owner, headers: im(3), body: { is_active: true } })).json()).toMatchObject({ is_active: true, version: 4 });
    expect(await curIds()).toContain(purity.id);
  });

  it('0.7.4 rates: batch derive + idempotency, metal_id filter, effective_to, todays-status, rate-card, rate_card doc_type', async () => {
    const m = await call('POST', '/v1/masters/metals', { cookie: owner, body: { code: 'RTX', name: 'Rate Test', default_hsn: '7113' } });
    expect(m.statusCode).toBe(201);
    const metal = m.json();
    const pur = async (code: string, fineness: string) => (await call('POST', '/v1/masters/purities', { cookie: owner, body: { metal_id: metal.id, code, fineness } })).json();
    const p999 = await pur('R999', '999.9'); const p916 = await pur('R916', '916'); const p750 = await pur('R750', '750');
    const key = (s: string) => ({ 'idempotency-key': `rates-batch-key-${s}-${Date.now()}` });
    const body = { kind: 'sale', bases: [{ purity_id: p999.id, rate_per_g: '7000.00' }], overrides: [{ purity_id: p750.id, rate_per_g: '5200.00' }] };
    expect((await call('POST', '/v1/rates/batch', { cookie: owner, body })).json()).toMatchObject({ status: 400, code: 'idempotency_key_required' });
    const hist = async () => (await call('GET', `/v1/rates?metal_id=${metal.id}&limit=100`, { cookie: owner })).json().items as Record<string, string | null>[];
    // all-or-nothing: bad override → 422, nothing written
    const bad = await call('POST', '/v1/rates/batch', { cookie: owner, headers: key('bad'), body: { ...body, overrides: [{ purity_id: p999.id, rate_per_g: '1.00' }] } });
    expect(bad.json()).toMatchObject({ status: 422, code: 'invalid_override' });
    expect(await hist()).toHaveLength(0);
    expect((await call('POST', '/v1/rates/batch', { cookie: owner, headers: key('dup'), body: { kind: 'sale', bases: [{ purity_id: p999.id, rate_per_g: '7000.00' }, { purity_id: p916.id, rate_per_g: '6000.00' }] } })).json())
      .toMatchObject({ code: 'duplicate_metal' });
    expect((await call('POST', '/v1/rates/batch', { cookie: owner, headers: key('f'), body: { ...body, bases: [{ purity_id: p999.id, rate_per_g: 7000 }] } })).statusCode).toBe(422);
    const k = key('ok');
    const r = await call('POST', '/v1/rates/batch', { cookie: owner, headers: k, body });
    expect(r.statusCode, r.body).toBe(201);
    const items = r.json().items as Record<string, string | null>[];
    const by = (id: string) => items.find((x) => x.purity_id === id)!;
    expect(by(p999.id)).toMatchObject({ rate_per_g: '7000.00', derived_from_id: null, derived_rate_per_g: null, kind: 'sale', branch_id: null });
    expect(by(p916.id)).toMatchObject({ rate_per_g: '6412.64', derived_rate_per_g: '6412.64', derived_from_id: by(p999.id).id });
    expect(by(p750.id)).toMatchObject({ rate_per_g: '5200.00', derived_rate_per_g: '5250.53', derived_from_id: by(p999.id).id });   // 5250.525… half-up
    const replay = await call('POST', '/v1/rates/batch', { cookie: owner, headers: k, body });
    expect(replay.statusCode).toBe(201);
    expect(replay.json().items.map((x: { id: string }) => x.id)).toEqual(items.map((x) => x.id));
    expect((await call('POST', '/v1/rates/batch', { cookie: owner, headers: k, body: { ...body, overrides: [] } })).json()).toMatchObject({ code: 'idempotency_key_reused' });
    expect(await hist()).toHaveLength(3);
    // correction batch → earlier rows get effective_to (exclusive end) = new effective_from
    const r2 = await call('POST', '/v1/rates/batch', { cookie: manager, headers: key('two'), body: { kind: 'sale', bases: [{ purity_id: p999.id, rate_per_g: '7100.00' }] } });
    expect(r2.statusCode, r2.body).toBe(201);
    const h = await hist();
    expect(h).toHaveLength(6);
    const newFrom = r2.json().items[0].effective_from;
    for (const x of h) {
      if (items.some((i) => i.id === x.id)) expect(new Date(x.effective_to!).toISOString()).toBe(new Date(newFrom).toISOString());
      else expect(x.effective_to).toBeNull();
    }
    expect((await call('GET', `/v1/rates?metal_id=not-a-uuid`, { cookie: owner })).statusCode).toBe(422);
    // todays-status (985 view)
    const br = (await call('GET', '/v1/branches', { cookie: owner })).json()[0].id;
    const st = await call('GET', `/v1/rates/todays-status?branch_id=${br}`, { cookie: owner });
    expect(st.statusCode, st.body).toBe(200);
    expect(st.json()).toMatchObject({ branch_id: br, todays_rate_set: expect.any(Boolean), old_metal_rate_set: expect.any(Boolean) });
    expect(st.json().missing_metal_codes).not.toContain('RTX');
    expect(st.json().missing_old_metal_codes).toContain('RTX');   // warning only
    const all = (await call('GET', '/v1/rates/todays-status', { cookie: owner })).json();
    expect(all).toMatchObject({ branch_id: null, rate_date: st.json().rate_date });
    expect(all.branches.map((x: { branch_id: string }) => x.branch_id)).toContain(br);
    expect((await call('GET', '/v1/rates/todays-status?branch_id=00000000-0000-0000-0000-000000000000', { cookie: owner })).statusCode).toBe(404);
    expect((await call('GET', '/v1/rates/todays-status')).statusCode).toBe(401);
    // rate card
    const card = await call('GET', `/v1/rates/rate-card?branch_id=${br}`, { cookie: manager });
    expect(card.statusCode, card.body).toBe(200);
    expect(card.json()).toMatchObject({ doc_type: 'rate_card', branch: { id: br } });
    const rtx = card.json().metals.find((x: { code: string }) => x.code === 'RTX');
    expect(rtx.purities.map((x: { code: string; sale_rate_per_g: string }) => [x.code, x.sale_rate_per_g])).toEqual([['R999', '7100.00'], ['R916', '6504.25'], ['R750', '5325.53']]);
    expect((await call('GET', '/v1/print-templates?doc_type=rate_card', { cookie: owner })).statusCode).toBe(200);
  });
});

describe('GST settings (0.4.3): /v1/settings/gst-config + /v1/settings/tax-rules', () => {
  const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);   // IST
  const plus = (d: number) => new Date(Date.parse(today) + d * 86_400_000).toISOString().slice(0, 10);
  const step = async (k: string) => (await asMigrator<{ status: string }>(tenantId, `SELECT status FROM platform.onboarding_progress WHERE step = $1`, [k]))[0]?.status;

  it('gst-config: list/create/close, contract field names, overlap 409, 422s, 403 without settings.edit', async () => {
    await asMigrator(tenantId, `UPDATE platform.onboarding_progress SET status = 'pending', completed_at = NULL WHERE step = 'gst'`);
    expect((await call('GET', '/v1/settings/gst-config')).statusCode).toBe(401);
    const l0 = await call('GET', '/v1/settings/gst-config', { cookie: owner });
    expect(l0.statusCode, l0.body).toBe(200);
    expect(Array.isArray(l0.json())).toBe(true);
    const body = { registration_type: 'regular', tax_inclusive: false, rounding_level: 'invoice', round_off_unit: '1.00', b2c_qr: true, effective_from: plus(1000) };
    expect((await call('POST', '/v1/settings/gst-config', { cookie: manager, body })).statusCode).toBe(403);
    expect((await call('POST', '/v1/settings/gst-config', { cookie: owner, body: { ...body, round_off_unit: '0.25' } })).statusCode).toBe(422);
    expect((await call('POST', '/v1/settings/gst-config', { cookie: owner, body: { ...body, making_treatment: 'composite' } })).statusCode).toBe(422);
    expect((await call('POST', '/v1/settings/gst-config', { cookie: owner, body: { ...body, effective_to: plus(1000) } })).statusCode).toBe(422);   // CHECK to > from
    const c = await call('POST', '/v1/settings/gst-config', { cookie: owner, body });
    expect(c.statusCode, c.body).toBe(201);
    expect(c.json()).toMatchObject({ company_id: null, registration_type: 'regular', tax_inclusive: false, rounding_level: 'invoice',
      round_off_unit: '1.00', einvoice_enabled: false, einvoice_from: null, b2c_qr: true, effective_from: plus(1000), effective_to: null });
    expect(await step('gst')).toBe('completed');
    const dup = await call('POST', '/v1/settings/gst-config', { cookie: owner, body: { ...body, effective_from: plus(1001) } });
    expect(dup.statusCode).toBe(409); expect(dup.json().code).toBe('overlapping_period');
    const unknownCo = await call('POST', '/v1/settings/gst-config', { cookie: owner, body: { ...body, company_id: '00000000-0000-0000-0000-0000000000ff', effective_from: plus(1500) } });
    expect(unknownCo.statusCode).toBe(422);
    expect((await call('PATCH', `/v1/settings/gst-config/${c.json().id}`, { cookie: manager, body: { effective_to: plus(1010) } })).statusCode).toBe(403);
    expect((await call('PATCH', `/v1/settings/gst-config/${c.json().id}`, { cookie: owner, body: { effective_to: plus(1010), b2c_qr: false } })).statusCode).toBe(422);
    const cl = await call('PATCH', `/v1/settings/gst-config/${c.json().id}`, { cookie: owner, body: { effective_to: plus(1010) } });
    expect(cl.statusCode, cl.body).toBe(200); expect(cl.json().effective_to).toBe(plus(1010));
    expect((await call('POST', '/v1/settings/gst-config', { cookie: owner, body: { ...body, effective_from: plus(1010), round_off_unit: '0.10' } })).statusCode).toBe(201);
    expect((await call('PATCH', '/v1/settings/gst-config/00000000-0000-0000-0000-0000000000ff', { cookie: owner, body: { effective_to: plus(1) } })).statusCode).toBe(404);
    const l = (await call('GET', '/v1/settings/gst-config', { cookie: owner })).json();
    expect(l.slice(0, 2).map((r: { round_off_unit: string }) => r.round_off_unit)).toEqual(['0.10', '1.00']);
  });

  it('tax-rules: platform defaults + tenant rules, filters, create tenant rule, close, platform rule 403', async () => {
    await asMigrator(tenantId, `UPDATE platform.onboarding_progress SET status = 'pending', completed_at = NULL WHERE step = 'gst_rates'`);
    const all = await call('GET', '/v1/settings/tax-rules', { cookie: owner });
    expect(all.statusCode, all.body).toBe(200);
    const plat = all.json().find((r: { scope: string }) => r.scope === 'platform');
    expect(plat).toBeTruthy();
    expect(plat.rate).toMatch(/^[0-9]{1,3}(\.[0-9]{1,3})?$/);
    expect((await call('GET', '/v1/settings/tax-rules?component=bogus', { cookie: owner })).statusCode).toBe(422);
    expect((await call('GET', '/v1/settings/tax-rules?on=2026-13-01x', { cookie: owner })).statusCode).toBe(422);
    const ms = (await call('GET', '/v1/settings/tax-rules?component=making', { cookie: owner })).json();
    expect(ms.every((r: { component: string }) => r.component === 'making')).toBe(true);
    expect((await call('GET', '/v1/settings/tax-rules?on=1990-01-01', { cookie: owner })).json()).toEqual([]);
    const body = { code: 'GOLD_T_TEST', component: 'metal', metal_code: 'GOLD', code_type: 'HSN', hsn_sac: '711319',
      rate: '3', cgst_rate: '1.5', sgst_rate: '1.5', igst_rate: '3', effective_from: plus(2000) };
    expect((await call('POST', '/v1/settings/tax-rules', { cookie: manager, body })).statusCode).toBe(403);
    expect((await call('POST', '/v1/settings/tax-rules', { cookie: owner, body: { ...body, cgst_rate: '1' } })).statusCode).toBe(422);   // CHECK split
    expect((await call('POST', '/v1/settings/tax-rules', { cookie: owner, body: { ...body, effective_from: plus(-1) } })).statusCode).toBe(422);   // no back-dating
    expect((await call('POST', '/v1/settings/tax-rules', { cookie: owner, body: { ...body, composite_supply: true } })).statusCode).toBe(422);   // principal required
    expect((await call('POST', '/v1/settings/tax-rules', { cookie: owner, body: { ...body, scope: 'platform' } })).statusCode).toBe(422);
    const c = await call('POST', '/v1/settings/tax-rules', { cookie: owner, body });
    expect(c.statusCode, c.body).toBe(201);
    expect(c.json()).toMatchObject({ scope: 'tenant', code: 'GOLD_T_TEST', rate: '3.00', cgst_rate: '1.50', cess_rate: '0.00', in_use: false, effective_to: null });
    expect(await step('gst_rates')).toBe('completed');
    const ov = await call('POST', '/v1/settings/tax-rules', { cookie: owner, body: { ...body, effective_from: plus(2005) } });
    expect(ov.statusCode).toBe(409); expect(ov.json().code).toBe('overlapping_period');
    const on = (await call('GET', `/v1/settings/tax-rules?on=${plus(2001)}&component=metal`, { cookie: owner })).json();
    expect(on.map((r: { id: string }) => r.id)).toContain(c.json().id);
    expect((await call('PATCH', `/v1/settings/tax-rules/${c.json().id}`, { cookie: owner, body: { effective_to: plus(-1) } })).statusCode).toBe(422);
    const cl = await call('PATCH', `/v1/settings/tax-rules/${c.json().id}`, { cookie: owner, body: { effective_to: plus(2010) } });
    expect(cl.statusCode, cl.body).toBe(200); expect(cl.json().effective_to).toBe(plus(2010));
    const pr = await call('PATCH', `/v1/settings/tax-rules/${plat.id}`, { cookie: owner, body: { effective_to: plus(3000) } });
    expect(pr.statusCode).toBe(403); expect(pr.json().code).toBe('platform_rule');
    expect((await call('PATCH', '/v1/settings/tax-rules/00000000-0000-0000-0000-0000000000ff', { cookie: owner, body: { effective_to: plus(1) } })).statusCode).toBe(404);
  });
});

describe('GST settings cross-tenant isolation (gst_config, tax_rule): shop A never reads or writes shop B rows', () => {
  const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);   // IST
  const plus = (d: number) => new Date(Date.parse(today) + d * 86_400_000).toISOString().slice(0, 10);
  const SLUG_B = `${SLUG}-b`;
  let bTenant = ''; let bOwner = ''; let bCompany = ''; let bGst = ''; let bRule = ''; let aGst = ''; let aRule = '';
  const rule = (code: string, from: string) => ({ code, component: 'stone', code_type: 'HSN', hsn_sac: '7103', rate: '3',
    cgst_rate: '1.5', sgst_rate: '1.5', igst_rate: '3', effective_from: from });
  const gst = (from: string) => ({ registration_type: 'regular', tax_inclusive: false, rounding_level: 'invoice', round_off_unit: '1.00', effective_from: from });

  beforeAll(async () => {
    const r = await call('POST', '/v1/admin/tenants', { cookie: admin, body: { slug: SLUG_B, display_name: 'Lakshmi Jewellers',
      company: { legal_name: 'Lakshmi Jewellers', gstin: '33BBBBB2222B1Z5', state_code: '33' }, branch: { code: 'CBE', name: 'Coimbatore' },
      owner: { name: 'Lakshmi', username: 'lakshmi', password: 'owner-pass-456' } } });
    expect(r.statusCode, r.body).toBe(201);
    bTenant = r.json().id;
    bOwner = (await login(SLUG_B, 'lakshmi', 'owner-pass-456')).cookie;
    expect(bOwner).not.toBe('');
    bCompany = (await asMigrator<{ id: string }>(bTenant, `SELECT id FROM platform.company`))[0].id;
    const bg = await call('POST', '/v1/settings/gst-config', { cookie: bOwner, body: gst(plus(5000)) });
    expect(bg.statusCode, bg.body).toBe(201); bGst = bg.json().id;
    const br = await call('POST', '/v1/settings/tax-rules', { cookie: bOwner, body: rule('B_ONLY_STONE', plus(5000)) });
    expect(br.statusCode, br.body).toBe(201); bRule = br.json().id;
    // A already has an open-ended tenant-wide period from the GST settings test; A's row here is company-specific (separate EXCLUDE key)
    const aCompany = (await asMigrator<{ id: string }>(tenantId, `SELECT id FROM platform.company ORDER BY id LIMIT 1`))[0].id;
    const ag = await call('POST', '/v1/settings/gst-config', { cookie: owner, body: { ...gst(plus(5000)), company_id: aCompany } });   // same dates as B: no cross-tenant overlap
    expect(ag.statusCode, ag.body).toBe(201); aGst = ag.json().id;
    const ar = await call('POST', '/v1/settings/tax-rules', { cookie: owner, body: rule('A_ONLY_STONE', plus(5000)) });
    expect(ar.statusCode, ar.body).toBe(201); aRule = ar.json().id;
  });

  it('API as shop A: lists exclude B rows, PATCH of B ids → 404 (B unchanged), POST cannot target B', async () => {
    const ids = async (path: string, cookie: string) => (await call('GET', path, { cookie })).json().map((x: { id: string }) => x.id);
    const aG = await ids('/v1/settings/gst-config', owner); const aR = await ids('/v1/settings/tax-rules', owner);
    expect(aG).toContain(aGst); expect(aG).not.toContain(bGst);
    expect(aR).toContain(aRule); expect(aR).not.toContain(bRule);
    expect(await ids(`/v1/settings/gst-config?company_id=${bCompany}`, owner)).not.toContain(bGst);
    expect(await ids(`/v1/settings/tax-rules?on=${plus(5001)}&component=stone`, owner)).not.toContain(bRule);
    // and the mirror image from B's session
    expect(await ids('/v1/settings/gst-config', bOwner)).toEqual([bGst]);
    const bR = await ids('/v1/settings/tax-rules', bOwner);
    expect(bR).toContain(bRule); expect(bR).not.toContain(aRule);

    expect((await call('PATCH', `/v1/settings/gst-config/${bGst}`, { cookie: owner, body: { effective_to: plus(5010) } })).statusCode).toBe(404);
    expect((await call('PATCH', `/v1/settings/tax-rules/${bRule}`, { cookie: owner, body: { effective_to: plus(5010) } })).statusCode).toBe(404);
    const [g] = await asMigrator<{ effective_to: string | null }>(bTenant, `SELECT effective_to::text FROM masters.gst_config WHERE id = $1`, [bGst]);
    const [t] = await asMigrator<{ effective_to: string | null }>(bTenant, `SELECT effective_to::text FROM masters.tax_rule WHERE id = $1`, [bRule]);
    expect(g.effective_to).toBeNull(); expect(t.effective_to).toBeNull();

    // POST from A cannot land in B: B's company is not A's (composite FK) → 422; tenant_id / scope are not accepted fields → 422
    const co = await call('POST', '/v1/settings/gst-config', { cookie: owner, body: { ...gst(plus(6000)), company_id: bCompany } });
    expect(co.statusCode, co.body).toBe(422); expect(co.json().code).toBe('unknown_company');
    expect((await call('POST', '/v1/settings/gst-config', { cookie: owner, body: { ...gst(plus(6000)), tenant_id: bTenant } })).statusCode).toBe(422);
    expect((await call('POST', '/v1/settings/tax-rules', { cookie: owner, body: { ...rule('X', plus(6000)), tenant_id: bTenant } })).statusCode).toBe(422);
    const [{ n }] = await asMigrator<{ n: number }>(bTenant,
      `SELECT (SELECT count(*) FROM masters.gst_config WHERE tenant_id = $1) + (SELECT count(*) FROM masters.tax_rule WHERE tenant_id = $1) AS n`, [bTenant]);
    expect(Number(n)).toBe(2);   // still only B's own two rows
  });

  it('DB as the API role (app_rw, rolbypassrls=false) with A tenant context: 0 B rows visible, UPDATE/INSERT on B affect nothing', async () => {
    const rw = pool('app_rw');
    const c = await rw.connect();
    try {
      const [role] = (await c.query(`SELECT r.rolname, r.rolbypassrls, r.rolsuper FROM pg_roles r WHERE r.rolname = current_user`)).rows;
      expect(role).toEqual({ rolname: 'app_rw', rolbypassrls: false, rolsuper: false });   // the test cannot pass silently through a bypass role
      const forced = (await c.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'masters' AND c.relname IN ('gst_config','tax_rule') ORDER BY 1`)).rows;
      expect(forced.map((r: { relrowsecurity: boolean }) => r.relrowsecurity)).toEqual([true, true]);

      const ctx = async (t: string) => c.query(`SELECT set_config('app.tenant_id', $1, true)`, [t]);
      const cnt = async (sql: string, p: unknown[]) => (await c.query(sql, p)).rows[0].n as number;
      await c.query('BEGIN');
      // sanity: the same role + B's context does see B's rows (so "0" below is RLS, not a wrong id)
      await ctx(bTenant);
      expect(await cnt(`SELECT count(*)::int n FROM masters.gst_config WHERE id = $1`, [bGst])).toBe(1);
      expect(await cnt(`SELECT count(*)::int n FROM masters.tax_rule WHERE id = $1`, [bRule])).toBe(1);

      await ctx(tenantId);
      expect(await cnt(`SELECT count(*)::int n FROM masters.gst_config WHERE tenant_id = $1 OR id = $2`, [bTenant, bGst])).toBe(0);
      expect(await cnt(`SELECT count(*)::int n FROM masters.tax_rule WHERE tenant_id = $1 OR id = $2`, [bTenant, bRule])).toBe(0);
      expect(await cnt(`SELECT count(*)::int n FROM masters.gst_config WHERE tenant_id <> $1`, [tenantId])).toBe(0);
      expect(await cnt(`SELECT count(*)::int n FROM masters.tax_rule WHERE scope = 'tenant' AND tenant_id <> $1`, [tenantId])).toBe(0);
      expect(await cnt(`SELECT count(*)::int n FROM masters.gst_config WHERE id = $1`, [aGst])).toBe(1);

      expect((await c.query(`UPDATE masters.gst_config SET effective_to = $2 WHERE id = $1`, [bGst, plus(5020)])).rowCount).toBe(0);
      expect((await c.query(`UPDATE masters.gst_config SET effective_to = $2 WHERE tenant_id = $1`, [bTenant, plus(5020)])).rowCount).toBe(0);
      expect((await c.query(`UPDATE masters.tax_rule SET effective_to = $2 WHERE id = $1`, [bRule, plus(5020)])).rowCount).toBe(0);
      expect((await c.query(`UPDATE masters.tax_rule SET effective_to = $2 WHERE tenant_id = $1`, [bTenant, plus(5020)])).rowCount).toBe(0);
      expect((await c.query(`DELETE FROM masters.tax_rule WHERE id = $1`, [bRule])).rowCount).toBe(0);
      // writing a row stamped with B's tenant from A's context is rejected by the policy WITH CHECK
      await c.query('SAVEPOINT s1');
      await expect(c.query(`INSERT INTO masters.tax_rule(scope, tenant_id, code, component, code_type, hsn_sac, rate, cgst_rate, sgst_rate, igst_rate, effective_from)
        VALUES ('tenant', $1, 'SNEAK', 'other', 'HSN', '7117', 3, 1.5, 1.5, 3, $2)`, [bTenant, plus(7000)])).rejects.toMatchObject({ code: '42501' });
      await c.query('ROLLBACK TO SAVEPOINT s1');
      await expect(c.query(`INSERT INTO masters.gst_config(tenant_id, effective_from) VALUES ($1, $2)`, [bTenant, plus(7000)]))
        .rejects.toMatchObject({ code: '42501' });
      await c.query('ROLLBACK');
    } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); await rw.end(); }
    // B's rows untouched (checked outside the rolled-back tx)
    const [g] = await asMigrator<{ e: string | null }>(bTenant, `SELECT effective_to::text e FROM masters.gst_config WHERE id = $1`, [bGst]);
    const [t] = await asMigrator<{ e: string | null }>(bTenant, `SELECT effective_to::text e FROM masters.tax_rule WHERE id = $1`, [bRule]);
    expect(g.e).toBeNull(); expect(t.e).toBeNull();
  });

  it('file download links: a foreign shop import id is 404 (RLS), and its token is useless with a forged tenant', async () => {
    const [{ id }] = await asMigrator<{ id: string }>(tenantId, `SELECT id FROM platform.import_job ORDER BY created_at LIMIT 1`);
    expect((await call('GET', `/v1/files/${id}/url`, { cookie: bOwner })).statusCode).toBe(404);
    const [{ fid }] = await asMigrator<{ fid: string }>(tenantId, `SELECT id AS fid FROM platform.file WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1`);
    expect((await call('GET', `/v1/files/${fid}/url`, { cookie: bOwner })).statusCode).toBe(404);   // 0.5.1: file id too
    const [{ fk }] = await asMigrator<{ fk: string }>(tenantId, `SELECT object_key AS fk FROM platform.file WHERE id = $1`, [fid]);
    const forgedFile = (await import('@jw/mod-platform')).signFileToken(Buffer.from(process.env.FILE_TOKEN_SECRET!, 'utf8'),
      { tenantId: bTenant, fileId: fid, objectKey: fk, kind: 'file' }).token;
    expect((await app.inject({ method: 'GET', url: `/files/${forgedFile}` })).statusCode).toBe(404);
    const mine = await call('GET', `/v1/files/${id}/url`, { cookie: owner });
    expect(mine.statusCode, mine.body).toBe(200);
    const { signFileToken } = await import('@jw/mod-platform');
    const [{ k }] = await asMigrator<{ k: string }>(tenantId, `SELECT file_key AS k FROM platform.import_job WHERE id = $1`, [id]);
    const key = Buffer.from(process.env.FILE_TOKEN_SECRET!, 'utf8');
    // validly signed but naming shop B: B's RLS hides A's job row → 404
    const forged = signFileToken(key, { tenantId: bTenant, fileId: id, objectKey: k, kind: 'job' }).token;
    expect((await app.inject({ method: 'GET', url: `/files/${forged}` })).statusCode).toBe(404);
  });
});

describe('0.4.4 GST settings: atomic replace, date rules, in_use, platform code reuse', () => {
  const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);   // IST
  const plus = (d: number) => new Date(Date.parse(today) + d * 86_400_000).toISOString().slice(0, 10);
  const key = () => `it-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  const idk = (k: string) => ({ 'idempotency-key': k });
  const gstBody = (from: string, unit = '0.50') => ({ registration_type: 'regular', tax_inclusive: true, rounding_level: 'line', round_off_unit: unit, b2c_qr: true, effective_from: from });
  type G = { id: string; company_id: string | null; effective_from: string; effective_to: string | null; round_off_unit: string; b2c_qr: boolean };
  const gstRows = async (): Promise<G[]> => (await call('GET', '/v1/settings/gst-config', { cookie: owner })).json();
  const tenantWide = async () => (await gstRows()).filter((r) => r.company_id === null);
  const on = (rows: G[], d: string) => rows.filter((r) => r.effective_from <= d && (r.effective_to === null || r.effective_to > d));

  it('gst-config date rules, named codes and 409 overlapping_period on POST/PATCH', async () => {
    const past = await call('POST', '/v1/settings/gst-config', { cookie: owner, body: gstBody(plus(-1)) });
    expect(past.statusCode).toBe(422); expect(past.json().code).toBe('effective_from_in_past');
    const closed = (await tenantWide()).find((r) => r.effective_to !== null)!;          // [plus(1000), plus(1010)) from the 0.4.3 test
    expect(closed).toMatchObject({ effective_from: plus(1000), effective_to: plus(1010) });
    const p1 = await call('PATCH', `/v1/settings/gst-config/${closed.id}`, { cookie: owner, body: { effective_to: plus(-1) } });
    expect(p1.statusCode).toBe(422); expect(p1.json().code).toBe('effective_to_in_past');
    const p2 = await call('PATCH', `/v1/settings/gst-config/${closed.id}`, { cookie: owner, body: { effective_to: plus(1000) } });
    expect(p2.statusCode).toBe(422); expect(p2.json().code).toBe('invalid_period');
    const p3 = await call('PATCH', `/v1/settings/gst-config/${closed.id}`, { cookie: owner, body: { effective_to: plus(1050) } });   // runs into the next period
    expect(p3.statusCode).toBe(409); expect(p3.json().code).toBe('overlapping_period');
    expect(p3.headers['content-type']).toMatch(/application\/problem\+json/);
    const dup = await call('POST', '/v1/settings/gst-config', { cookie: owner, body: gstBody(plus(1005)) });
    expect(dup.statusCode).toBe(409); expect(dup.json().code).toBe('overlapping_period');
  });

  it('gst-config replace: one tx, old.effective_to = new.effective_from (no gap/overlap), idempotent replay, errors', async () => {
    const open = (await tenantWide()).find((r) => r.effective_to === null)!;            // [plus(1010), ∞)
    const url = `/v1/settings/gst-config/${open.id}/replace`;
    const nk = await call('POST', url, { cookie: owner, body: gstBody(plus(1100)) });
    expect(nk.statusCode).toBe(400); expect(nk.json().code).toBe('idempotency_key_required');
    expect((await call('POST', url, { cookie: manager, headers: idk(key()), body: gstBody(plus(1100)) })).statusCode).toBe(403);
    expect((await call('POST', '/v1/settings/gst-config/00000000-0000-0000-0000-0000000000ff/replace', { cookie: owner, headers: idk(key()), body: gstBody(plus(1100)) })).statusCode).toBe(404);
    expect((await call('POST', url, { cookie: owner, headers: idk(key()), body: { ...gstBody(plus(1100)), company_id: null } })).statusCode).toBe(422);
    const pastR = await call('POST', url, { cookie: owner, headers: idk(key()), body: gstBody(plus(-1)) });
    expect(pastR.statusCode).toBe(422); expect(pastR.json().code).toBe('effective_from_in_past');
    const early = await call('POST', url, { cookie: owner, headers: idk(key()), body: gstBody(plus(1010)) });
    expect(early.statusCode).toBe(422); expect(early.json().code).toBe('invalid_period');

    const k = key();
    const r = await call('POST', url, { cookie: owner, headers: idk(k), body: gstBody(plus(1100)) });
    expect(r.statusCode, r.body).toBe(201);
    const { replaced, created } = r.json();
    expect(replaced).toMatchObject({ id: open.id, effective_from: plus(1010), effective_to: plus(1100) });
    expect(created).toMatchObject({ company_id: null, effective_from: plus(1100), effective_to: null, round_off_unit: '0.50', b2c_qr: true, tax_inclusive: true });
    // billing never sees a gap or a double: exactly one tenant-wide row on every boundary day
    const rows = await tenantWide();
    for (const d of [plus(1099), plus(1100), plus(1101)]) expect(on(rows, d)).toHaveLength(1);
    expect(on(rows, plus(1099))[0].id).toBe(open.id); expect(on(rows, plus(1100))[0].id).toBe(created.id);
    // replay
    // replay (973 store): same key + same body → the stored status and body
    const again = await call('POST', url, { cookie: owner, headers: idk(k), body: gstBody(plus(1100)) });
    expect(again.statusCode, again.body).toBe(201); expect(again.json()).toEqual(r.json());
    // same key, different body → 422 idempotency_key_reused (nothing written)
    const reused = await call('POST', url, { cookie: owner, headers: idk(k), body: gstBody(plus(1100), '1.00') });
    expect(reused.statusCode).toBe(422); expect(reused.json().code).toBe('idempotency_key_reused');
    const [row] = await asMigrator<{ response_status: number; scope: string }>(tenantId,
      `SELECT response_status, scope FROM platform.idempotency_key WHERE key = $1`, [k]);
    expect(row).toEqual({ response_status: 201, scope: 'POST /v1/settings/gst-config/{id}/replace' });
    const other = await call('POST', url, { cookie: owner, headers: idk(key()), body: gstBody(plus(1100), '1.00') });
    expect(other.statusCode).toBe(409); expect(other.json().code).toBe('already_replaced');
    expect((await tenantWide()).length).toBe(rows.length);

    // replace that would overlap a later period → 409 and the whole tx rolls back (old row keeps its end)
    const closed = rows.find((x) => x.effective_from === plus(1000))!;
    const ov = await call('POST', `/v1/settings/gst-config/${closed.id}/replace`, { cookie: owner, headers: idk(key()), body: gstBody(plus(1005)) });
    expect(ov.statusCode).toBe(409); expect(ov.json().code).toBe('overlapping_period');
    expect((await tenantWide()).find((x) => x.id === closed.id)!.effective_to).toBe(plus(1010));
    // starting after the old row's end would leave a gap → 422
    const gap = await call('POST', `/v1/settings/gst-config/${closed.id}/replace`, { cookie: owner, headers: idk(key()), body: gstBody(plus(1020)) });
    expect(gap.statusCode).toBe(422); expect(gap.json().code).toBe('invalid_period');
  });

  it('tax-rules replace + close rules + in_use semantics', async () => {
    const rule = (o: Record<string, unknown> = {}) => ({ code: 'HM_T', component: 'hallmark', code_type: 'SAC', hsn_sac: '998346', rate: '18',
      cgst_rate: '9', sgst_rate: '9', igst_rate: '18', effective_from: plus(3000), ...o });
    const { component: _c, ...repl } = rule({ rate: '5', cgst_rate: '2.5', sgst_rate: '2.5', igst_rate: '5', effective_from: plus(3100) });
    void _c;
    const past = await call('POST', '/v1/settings/tax-rules', { cookie: owner, body: rule({ effective_from: plus(-1) }) });
    expect(past.statusCode).toBe(422); expect(past.json().code).toBe('effective_from_in_past');
    const a = await call('POST', '/v1/settings/tax-rules', { cookie: owner, body: rule() });
    expect(a.statusCode, a.body).toBe(201);
    const id = a.json().id;
    const url = `/v1/settings/tax-rules/${id}/replace`;
    expect((await call('POST', url, { cookie: owner, body: repl })).json()).toMatchObject({status:400,code:'idempotency_key_required'});
    expect((await call('POST', url, { cookie: owner, headers: idk(key()), body: { ...repl, component: 'other' } })).statusCode).toBe(422);
    expect((await call('POST', url, { cookie: owner, headers: idk(key()), body: { ...repl, cgst_rate: '1' } })).statusCode).toBe(422);   // DB CHECK
    const plat = (await call('GET', '/v1/settings/tax-rules', { cookie: owner })).json().find((r: { scope: string }) => r.scope === 'platform');
    const pr = await call('POST', `/v1/settings/tax-rules/${plat.id}/replace`, { cookie: owner, headers: idk(key()), body: repl });
    expect(pr.statusCode).toBe(403); expect(pr.json().code).toBe('platform_rule');

    const k = key();
    const r = await call('POST', url, { cookie: owner, headers: idk(k), body: repl });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().replaced).toMatchObject({ id, effective_to: plus(3100), rate: '18.00' });
    expect(r.json().created).toMatchObject({ scope: 'tenant', component: 'hallmark', metal_code: null, rate: '5.00', effective_from: plus(3100), effective_to: null });
    for (const d of [plus(3099), plus(3100)]) {
      const live = (await call('GET', `/v1/settings/tax-rules?component=hallmark&on=${d}`, { cookie: owner })).json()
        .filter((x: { scope: string; hsn_sac: string }) => x.scope === 'tenant' && x.hsn_sac === '998346');
      expect(live).toHaveLength(1);
    }
    const rep = await call('POST', url, { cookie: owner, headers: idk(k), body: repl });
    expect(rep.statusCode).toBe(201); expect(rep.json()).toEqual(r.json());
    const reusedT = await call('POST', url, { cookie: owner, headers: idk(k), body: { ...repl, code: 'HM_OTHER' } });
    expect(reusedT.statusCode).toBe(422); expect(reusedT.json().code).toBe('idempotency_key_reused');
    // the key is scoped by route template, and the path id is in the hash: same key on another rule → 422, not a write
    const otherId = await call('POST', `/v1/settings/tax-rules/${r.json().created.id}/replace`, { cookie: owner, headers: idk(k), body: repl });
    expect(otherId.statusCode).toBe(422); expect(otherId.json().code).toBe('idempotency_key_reused');
    const diff = await call('POST', url, { cookie: owner, headers: idk(key()), body: { ...repl, code: 'HM_OTHER' } });
    expect(diff.statusCode).toBe(409); expect(diff.json().code).toBe('already_replaced');

    // in_use: mark the successor as used (the DB lock-marker update), then only "open → closed" is allowed
    const used = r.json().created.id;
    await asMigrator(tenantId, `UPDATE masters.tax_rule SET first_used_at = now() WHERE id = $1`, [used]);
    const c1 = await call('PATCH', `/v1/settings/tax-rules/${used}`, { cookie: owner, body: { effective_to: plus(3200) } });
    expect(c1.statusCode, c1.body).toBe(200); expect(c1.json()).toMatchObject({ in_use: true, effective_to: plus(3200) });
    const c2 = await call('PATCH', `/v1/settings/tax-rules/${used}`, { cookie: owner, body: { effective_to: plus(3300) } });
    expect(c2.statusCode).toBe(422); expect(c2.json().code).toBe('rule_in_use');
    const r2 = await call('POST', `/v1/settings/tax-rules/${used}/replace`, { cookie: owner, headers: idk(key()), body: { ...repl, effective_from: plus(3150) } });
    expect(r2.statusCode).toBe(422); expect(r2.json().code).toBe('rule_in_use');
    // an in-use rule that is still open CAN be replaced
    const o = await call('POST', '/v1/settings/tax-rules', { cookie: owner, body: rule({ code: 'OTH_T', component: 'other', hsn_sac: '998347' }) });
    expect(o.statusCode, o.body).toBe(201);
    await asMigrator(tenantId, `UPDATE masters.tax_rule SET first_used_at = now() WHERE id = $1`, [o.json().id]);
    const r3 = await call('POST', `/v1/settings/tax-rules/${o.json().id}/replace`, { cookie: owner, headers: idk(key()), body: { ...repl, code: 'OTH_T', hsn_sac: '998347' } });
    expect(r3.statusCode, r3.body).toBe(201); expect(r3.json().replaced).toMatchObject({ in_use: true, effective_to: plus(3100) });
    // close rules on tax rules too
    const t1 = await call('PATCH', `/v1/settings/tax-rules/${r3.json().created.id}`, { cookie: owner, body: { effective_to: plus(-1) } });
    expect(t1.json().code).toBe('effective_to_in_past');
    const t2 = await call('PATCH', `/v1/settings/tax-rules/${r3.json().created.id}`, { cookie: owner, body: { effective_to: plus(3100) } });
    expect(t2.json().code).toBe('invalid_period');
  });

  it('a tenant rule may reuse a platform rule code + key on overlapping dates (different owner); same-shop overlap is 409', async () => {
    const plat = (await call('GET', `/v1/settings/tax-rules?on=${plus(10)}`, { cookie: owner })).json().find((r: { scope: string }) => r.scope === 'platform');
    expect(plat).toBeTruthy();
    const body = { code: plat.code, component: plat.component, metal_code: plat.metal_code, code_type: plat.code_type, hsn_sac: plat.hsn_sac,
      rate: plat.rate, cgst_rate: plat.cgst_rate, sgst_rate: plat.sgst_rate, igst_rate: plat.igst_rate, cess_rate: plat.cess_rate,
      composite_supply: plat.composite_supply, ...(plat.principal_component ? { principal_component: plat.principal_component } : {}),
      effective_from: plus(10), effective_to: plus(11) };
    const t = await call('POST', '/v1/settings/tax-rules', { cookie: owner, body });
    expect(t.statusCode, t.body).toBe(201);
    expect(t.json()).toMatchObject({ scope: 'tenant', code: plat.code });
    const both = (await call('GET', `/v1/settings/tax-rules?on=${plus(10)}&component=${plat.component}`, { cookie: owner })).json()
      .filter((r: { code: string; hsn_sac: string }) => r.code === plat.code && r.hsn_sac === plat.hsn_sac);
    expect(both.map((r: { scope: string }) => r.scope).sort()).toEqual(['platform', 'tenant']);
    const again = await call('POST', '/v1/settings/tax-rules', { cookie: owner, body: { ...body, code: 'ANOTHER_CODE', effective_to: plus(12) } });
    expect(again.statusCode).toBe(409); expect(again.json().code).toBe('overlapping_period');   // code is not in the key; owner+component+metal+hsn+dates are
  });
});

describe('0.4.4 replace idempotency (973 platform.idempotency_key): concurrent same key', () => {
  const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  const plus = (d: number) => new Date(Date.parse(today) + d * 86_400_000).toISOString().slice(0, 10);
  it('two parallel replaces with one key: one 201, the other the same stored 201 (never 500, one successor)', async () => {
    const base = { code: 'CONC_T', component: 'other', code_type: 'SAC', hsn_sac: '998399', rate: '12', cgst_rate: '6', sgst_rate: '6', igst_rate: '12' };
    const a = await call('POST', '/v1/settings/tax-rules', { cookie: owner, body: { ...base, effective_from: plus(4000) } });
    expect(a.statusCode, a.body).toBe(201);
    const k = `conc-${Date.now()}-abcdefghij`;
    const body = { ...base, rate: '18', cgst_rate: '9', sgst_rate: '9', igst_rate: '18', effective_from: plus(4100) };
    delete (body as { component?: string }).component;
    const url = `/v1/settings/tax-rules/${a.json().id}/replace`;
    const rs = await Promise.all([1, 2, 3].map(() => call('POST', url, { cookie: owner, headers: { 'idempotency-key': k }, body })));
    for (const x of rs) expect(x.statusCode, x.body).toBe(201);
    const ids = new Set(rs.map((x) => x.json().created.id));
    expect(ids.size).toBe(1);
    const [{ n }] = await asMigrator<{ n: number }>(tenantId,
      `SELECT count(*)::int n FROM masters.tax_rule WHERE scope = 'tenant' AND component = 'other' AND hsn_sac = '998399'`);
    expect(n).toBe(2);   // old + exactly one successor
    const [{ m }] = await asMigrator<{ m: number }>(tenantId, `SELECT count(*)::int m FROM platform.idempotency_key WHERE key = $1`, [k]);
    expect(m).toBe(1);
  });

  it('API role facts the store relies on: app_rw SELECT/INSERT/DELETE (expired only), no UPDATE', async () => {
    const [g] = (await mig.query(`SELECT has_table_privilege('app_rw','platform.idempotency_key','SELECT') s, has_table_privilege('app_rw','platform.idempotency_key','INSERT') i,
      has_table_privilege('app_rw','platform.idempotency_key','DELETE') d, has_table_privilege('app_rw','platform.idempotency_key','UPDATE') u`)).rows;
    expect(g).toEqual({ s: true, i: true, d: true, u: false });
    const pol = (await mig.query(`SELECT policyname FROM pg_policies WHERE schemaname = 'platform' AND tablename = 'idempotency_key'`)).rows.map((x: { policyname: string }) => x.policyname);
    expect(pol).toContain('rw_delete_expired_only');
  });

  it('an expired key is reclaimed (deleted + re-stored in the same tx); a live key is never deleted by app_rw', async () => {
    const base = { code: 'EXP_T', component: 'other', code_type: 'SAC', hsn_sac: '998398', rate: '12', cgst_rate: '6', sgst_rate: '6', igst_rate: '12' };
    const mk = async (from: number) => (await call('POST', '/v1/settings/tax-rules', { cookie: owner, body: { ...base, hsn_sac: `99839${from % 10}`, effective_from: plus(from) } })).json().id as string;
    const first = await mk(4501); const second = await mk(4502);
    const k = `exp-${Date.now()}-abcdefghij`;
    const repl = (h: string) => ({ code: 'EXP_T', code_type: 'SAC', hsn_sac: h, rate: '18', cgst_rate: '9', sgst_rate: '9', igst_rate: '18', effective_from: plus(4600) });
    const r1 = await call('POST', `/v1/settings/tax-rules/${first}/replace`, { cookie: owner, headers: { 'idempotency-key': k }, body: repl('998391') });
    expect(r1.statusCode, r1.body).toBe(201);
    // live: the same key on another rule is refused, and a direct app_rw DELETE of the live row removes nothing
    expect((await call('POST', `/v1/settings/tax-rules/${second}/replace`, { cookie: owner, headers: { 'idempotency-key': k }, body: repl('998392') })).statusCode).toBe(422);
    const rw = pool('app_rw'); const c = await rw.connect();
    try {
      await c.query('BEGIN'); await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      expect((await c.query(`DELETE FROM platform.idempotency_key WHERE key = $1`, [k])).rowCount).toBe(0);
      await c.query('ROLLBACK');
    } finally { c.release(); await rw.end(); }
    // expire it (test setup as the migration owner), then the key can be reused for a different request
    await asMigrator(tenantId, `UPDATE platform.idempotency_key SET created_at = now() - interval '2 days', expires_at = now() - interval '1 day' WHERE key = $1`, [k]);
    const r2 = await call('POST', `/v1/settings/tax-rules/${second}/replace`, { cookie: owner, headers: { 'idempotency-key': k }, body: repl('998392') });
    expect(r2.statusCode, r2.body).toBe(201);
    expect(r2.json().replaced.id).toBe(second);
    const rows = await asMigrator<{ h: string; live: boolean }>(tenantId, `SELECT request_hash h, expires_at > now() AS live FROM platform.idempotency_key WHERE key = $1`, [k]);
    expect(rows).toHaveLength(1); expect(rows[0].live).toBe(true);
    // and the reclaimed key now replays the NEW request
    const r3 = await call('POST', `/v1/settings/tax-rules/${second}/replace`, { cookie: owner, headers: { 'idempotency-key': k }, body: repl('998392') });
    expect(r3.statusCode).toBe(201); expect(r3.json()).toEqual(r2.json());
  });
});
