import { useQuery } from '@tanstack/react-query';
import { getGetSessionQueryKey, getSession } from '@/lib/api/backend/auth/auth';
import { getPartnerGetSessionQueryKey, partnerGetSession } from '@/lib/api/backend/partner/partner';
import { ApiError, ok } from '@/lib/api/fetcher';
import type { PartnerSession, Session } from '@/lib/api/backend/model';
import { hasPerm } from '@/lib/permissions';

/**
 * Three surfaces, three credentials (scope is derived from the credential, never from a parameter):
 *  - tenant:   `sid` cookie → GET /v1/auth/session
 *  - platform: `admin_sid` cookie (path /api/v1/admin) → no "who am I" endpoint yet, so the login response is kept in sessionStorage
 *  - partner:  `psid` cookie (path /api/v1/partner, httpOnly) → GET /v1/partner/auth/session
 */
export type Surface = 'tenant' | 'partner' | 'platform';
export const surfaceOf = (path: string): Surface => (path.startsWith('/admin') ? 'platform' : path.startsWith('/partner') ? 'partner' : 'tenant');
export const loginPathFor = (s: Surface) => (s === 'platform' ? '/admin/login' : s === 'partner' ? '/partner/login' : '/login');
export const homeFor = (s: Surface) => (s === 'platform' ? '/admin' : s === 'partner' ? '/partner' : '/');

export interface AdminInfo { admin_id: string; email: string; name?: string; expires_at: string }
const ADMIN = 'admin-session-v1';
export const adminStore = {
  get(): AdminInfo | null {
    try {
      const a = JSON.parse(sessionStorage.getItem(ADMIN) ?? 'null') as AdminInfo | null;
      return a && new Date(a.expires_at).getTime() > Date.now() ? a : null;
    } catch { return null; }
  },
  set(a: AdminInfo | null) { if (a) sessionStorage.setItem(ADMIN, JSON.stringify(a)); else sessionStorage.removeItem(ADMIN); },
};

export type Principal =
  | { surface: 'tenant'; name: string; permissions: string[]; session: Session }
  | { surface: 'partner'; name: string; permissions: string[]; partner: PartnerSession }
  | { surface: 'platform'; name: string; permissions: string[]; admin: AdminInfo };

/** Tenant session query. 401 → null (not signed in). Shared by useSession and the router's beforeLoad guard. */
export const sessionQueryOptions = {
  queryKey: getGetSessionQueryKey(),
  queryFn: async (): Promise<Session | null> => {
    try { return await ok(getSession()); } catch (e) { if (e instanceof ApiError && e.isUnauthorized) return null; throw e; }
  },
  staleTime: 60_000,
  retry: false,
} as const;

export function useSession(enabled = true) {
  return useQuery({ ...sessionQueryOptions, enabled });
}

/** True only once a tenant session is confirmed. Gate every tenant data query on this (`enabled`). */
export function useSignedIn(): boolean {
  return !!useSession().data;
}

/** Partner staff session (psid cookie). 401 → null. */
export function usePartnerSession(enabled = true) {
  return useQuery({
    queryKey: getPartnerGetSessionQueryKey(),
    queryFn: async (): Promise<PartnerSession | null> => {
      try { return await ok(partnerGetSession()); } catch (e) { if (e instanceof ApiError && e.isUnauthorized) return null; throw e; }
    },
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

/** The signed-in principal for the surface of `path`; null = must sign in; undefined = loading. */
export function usePrincipal(path: string): Principal | null | undefined {
  const surface = surfaceOf(path);
  const s = useSession(surface === 'tenant');
  const p = usePartnerSession(surface === 'partner');
  if (surface === 'platform') { const a = adminStore.get(); return a ? { surface, name: a.name ?? a.email, permissions: ['*'], admin: a } : null; }
  if (surface === 'partner') {
    if (p.data === undefined) return undefined;
    return p.data ? { surface, name: p.data.user.name, permissions: [p.data.user.role], partner: p.data } : null;
  }
  if (s.data === undefined) return undefined;
  return s.data ? { surface, name: s.data.user.name, permissions: s.data.permissions, session: s.data } : null;
}

export function useCan() {
  const s = useSession().data;
  return (perm: string) => hasPerm(s?.permissions, perm);
}

/** Billing needs BOTH: an approved device (billing_enabled, P10) AND the onboarding gate (billing_unlocked). */
export function billingState(s: Session | null | undefined) {
  return { device: !!s?.billing_enabled, unlocked: !!s?.billing_unlocked, ready: !!s?.billing_enabled && !!s.billing_unlocked };
}
