import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { url, T1, T2, U1 } from './env';

process.env.DATABASE_URL = url('app_rw');
process.env.ALLOW_DEV_TENANT_HEADER = '1';
let app: Awaited<ReturnType<typeof import('@jw/api').createApp>>;
beforeAll(async () => { app = await (await import('@jw/api')).createApp(); });
afterAll(async () => { await app?.close(); });

describe('API smoke (NestJS on Fastify)', () => {
  it('GET /api/health → 200', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/health' });
    expect(r.statusCode).toBe(200); expect(r.json()).toEqual({ status: 'ok' });
  });
  it('tenant routes need a scope', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/whoami' })).statusCode).toBe(401);
  });
  it('request tx carries SET LOCAL app.tenant_id, runs as app_rw, RLS applies', async () => {
    const a = (await app.inject({ method: 'GET', url: '/api/v1/whoami', headers: { 'x-dev-tenant-id': T1, 'x-dev-user-id': U1 } })).json();
    const b = (await app.inject({ method: 'GET', url: '/api/v1/whoami', headers: { 'x-dev-tenant-id': T2 } })).json();
    // T1 may hold extra branches created by other suites (inventory adds a second branch); T2 must still see only its own one
    expect(a).toMatchObject({ tenant: T1, role: 'app_rw' });
    expect(a.branches).toBeGreaterThanOrEqual(1);
    expect(b).toEqual({ tenant: T2, role: 'app_rw', branches: 1 });
  });
  it('bad tenant id is rejected, not interpolated', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/v1/whoami', headers: { 'x-dev-tenant-id': "x' OR 1=1" } });
    expect(r.statusCode).toBe(401);   // AuthInterceptor validates the uuid before any SQL
  });
});
