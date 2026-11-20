import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { requireTenantSession } from '@/router';
import { sessionQueryOptions } from '@/lib/session';
import { hasPerm, routePermFor } from '@/lib/permissions';
import { EditGate } from '@/components/page';
import en from '@/i18n/messages/en-IN.json';
import { I18nProvider } from '@/i18n';

const calls: string[] = [];
beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => { calls.push(String(input instanceof Request ? input.url : input)); return new Response('[]', { status: 200 }); }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const qcWith = (permissions: string[]) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(sessionQueryOptions.queryKey, { user: { id: 'u', name: 'Staff', version: 1 }, permissions } as never);
  return qc;
};
const STAFF = ['sales.invoice.issue', 'rates.publish'];

describe('route-level permissions', () => {
  it('maps gated routes (trailing slash tolerated) and honours *', () => {
    expect(routePermFor('/settings/users')).toBe('platform.users.manage');
    expect(routePermFor('/audit/')).toBe('reports.view');
    expect(routePermFor('/settings/shop')).toBeUndefined();
    expect(hasPerm(['*'], 'reports.view')).toBe(true);
    expect(hasPerm([], undefined)).toBe(true);
    expect(hasPerm(null, 'x')).toBe(false);
  });
  it('direct visit without permission → /no-access before the page mounts, with no data request', async () => {
    for (const p of ['/settings/users', '/audit', '/settings/import']) {
      await expect(requireTenantSession(p, qcWith(STAFF))).rejects.toMatchObject({ options: { to: '/no-access', search: { from: p } } });
    }
    expect(calls).toEqual([]); // session came from cache; nothing else fetched
  });
  it('allows the route with the permission (or *) and leaves readable settings pages open', async () => {
    await expect(requireTenantSession('/settings/users', qcWith(['platform.users.manage']))).resolves.toBeUndefined();
    await expect(requireTenantSession('/audit', qcWith(['*']))).resolves.toBeUndefined();
    await expect(requireTenantSession('/settings/shop', qcWith(STAFF))).resolves.toBeUndefined();
    await expect(requireTenantSession('/no-access', qcWith(STAFF))).resolves.toBeUndefined();
  });
});

describe('EditGate (read-only settings)', () => {
  const ui = (qc: QueryClient, node: ReactNode) => render(<QueryClientProvider client={qc}><I18nProvider initial="en-IN">{node}</I18nProvider></QueryClientProvider>);
  it('disables every control and shows the view-only note without the permission', () => {
    ui(qcWith(STAFF), <EditGate perm="platform.settings.edit"><input aria-label="name" /><button type="button">Save</button></EditGate>);
    expect(screen.getByTestId('read-only-note').textContent).toBe(en['common.readOnly']);
    expect((screen.getByLabelText('name') as HTMLInputElement).matches(':disabled')).toBe(true);
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).matches(':disabled')).toBe(true);
  });
  it('is fully editable with the permission', () => {
    ui(qcWith(['platform.settings.edit']), <EditGate perm="platform.settings.edit"><button type="button">Save</button></EditGate>);
    expect(screen.queryByTestId('read-only-note')).toBeNull();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).matches(':disabled')).toBe(false);
  });
});
