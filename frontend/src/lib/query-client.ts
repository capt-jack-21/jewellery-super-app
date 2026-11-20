import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { ApiError } from '@/lib/api/fetcher';
import { getGetSessionQueryKey } from '@/lib/api/backend/auth/auth';

/** Login page for the surface a path belongs to. */
export const loginPathFor = (pathname: string): string =>
  pathname.startsWith('/partner') ? '/partner/login' : pathname.startsWith('/admin') ? '/admin/login' : '/login';

const DEAD_SESSION = new Set(['session_invalid', 'session_idle_timeout', 'partner_session_invalid', 'admin_session_invalid']);
export const isSessionInvalid = (e: unknown): boolean => e instanceof ApiError && e.status === 401 && DEAD_SESSION.has(e.code ?? '');

let redirecting = false;
/**
 * Any 401 session_invalid (session revoked, e.g. after revoking this device): clear the cached session + data and go to login.
 * No-op on a login page (no loops) and only once per page life. Returns true when it redirected.
 */
export function handleSessionInvalid(e: unknown, qc: QueryClient, loc: Pick<Location, 'pathname' | 'search' | 'assign'> = window.location): boolean {
  if (!isSessionInvalid(e) || redirecting || loc.pathname.endsWith('/login')) return false;
  redirecting = true;
  qc.setQueryData(getGetSessionQueryKey(), null);
  qc.removeQueries({ predicate: (q) => q.queryKey[0] !== getGetSessionQueryKey()[0] });
  const login = loginPathFor(loc.pathname);
  loc.assign(`${login}?redirect=${encodeURIComponent(loc.pathname + loc.search)}`);
  return true;
}
/** Tests only. */
export const resetSessionRedirect = () => { redirecting = false; };

export const queryClient: QueryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 60_000, retry: (n, e) => !isSessionInvalid(e) && n < 1 } },
  queryCache: new QueryCache({ onError: (e) => { handleSessionInvalid(e, queryClient); } }),
  mutationCache: new MutationCache({ onError: (e) => { handleSessionInvalid(e, queryClient); } }),
});
