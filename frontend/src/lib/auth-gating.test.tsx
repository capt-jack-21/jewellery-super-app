import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { useBranches, useCurrentDevice } from '@/features/devices/devices';
import { useOnboarding } from '@/routes/dashboard';
import { ratesParams, useMasters } from '@/features/rates/rates';
import { requireTenantSession } from '@/router';

const calls: string[] = [];
let signedIn = false;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url.includes('/v1/auth/session')) return signedIn ? json({ user: { id: 'u', name: 'U', version: 1 }, permissions: [] }) : json({ code: 'unauthorized' }, 401);
    return json([]);
  }));
});
afterEach(() => vi.unstubAllGlobals());

const wrap = (qc: QueryClient) => ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const DATA = ['/devices/current', '/branches', '/onboarding', '/masters/'];
const dataCalls = () => calls.filter((u) => DATA.some((d) => u.includes(d)));

describe('signed-out gating', () => {
  it('fires only the session check, no tenant data queries', async () => {
    signedIn = false;
    const qc = client();
    renderHook(() => { useCurrentDevice(); useBranches(); useOnboarding(); useMasters(); }, { wrapper: wrap(qc) });
    await waitFor(() => expect(calls.some((u) => u.includes('/auth/session'))).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(dataCalls()).toEqual([]);
  });

  it('runs the data queries once the session is confirmed', async () => {
    signedIn = true;
    const qc = client();
    renderHook(() => { useCurrentDevice(); useBranches(); useOnboarding(); useMasters(); }, { wrapper: wrap(qc) });
    await waitFor(() => expect(dataCalls().length).toBeGreaterThanOrEqual(4));
  });

  it('never sends an empty branch_id for rates (0.4.0: omitted → tenant-wide)', () => {
    expect(ratesParams('')).toBeUndefined();
    expect(ratesParams(null)).toBeUndefined();
    expect(ratesParams('b1')).toEqual({ branch_id: 'b1' });
  });

  it('router guard redirects signed-out tenant routes to /login, leaves login/partner/admin alone', async () => {
    signedIn = false;
    await expect(requireTenantSession('/settings/shop', client())).rejects.toMatchObject({ options: { to: '/login' } });
    await expect(requireTenantSession('/login', client())).resolves.toBeUndefined();
    await expect(requireTenantSession('/admin', client())).resolves.toBeUndefined();
    signedIn = true;
    await expect(requireTenantSession('/counter', client())).resolves.toBeUndefined();
  });
});
