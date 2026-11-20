import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { ApiError } from '@/lib/api/fetcher';
import { getGetSessionQueryKey } from '@/lib/api/backend/auth/auth';
import { handleSessionInvalid, isSessionInvalid, loginPathFor, resetSessionRedirect } from '@/lib/query-client';
import { isCurrentDevice } from '@/features/devices/devices';
import en from '@/i18n/messages/en-IN.json';
import ta from '@/i18n/messages/ta-IN.json';

const dead = new ApiError(401, 'session_invalid', 'Unauthorized');
const loc = (pathname: string) => ({ pathname, search: '', assign: vi.fn() });

describe('401 session_invalid → clear session, go to login', () => {
  afterEach(resetSessionRedirect);
  it('detects only dead-session 401s', () => {
    expect(isSessionInvalid(dead)).toBe(true);
    expect(isSessionInvalid(new ApiError(401, 'invalid_credentials', 'x'))).toBe(false);
    expect(isSessionInvalid(new ApiError(403, 'session_invalid', 'x'))).toBe(false);
  });
  it('clears the cache and redirects once with the return path', () => {
    const qc = new QueryClient();
    qc.setQueryData(getGetSessionQueryKey(), { user: {} });
    qc.setQueryData(['/v1/devices'], [1]);
    const l = loc('/settings/devices');
    expect(handleSessionInvalid(dead, qc, l)).toBe(true);
    expect(qc.getQueryData(getGetSessionQueryKey())).toBeNull();
    expect(qc.getQueryData(['/v1/devices'])).toBeUndefined();
    expect(l.assign).toHaveBeenCalledWith('/login?redirect=%2Fsettings%2Fdevices');
    expect(handleSessionInvalid(dead, qc, l)).toBe(false);
    expect(l.assign).toHaveBeenCalledTimes(1);
  });
  it('never redirects from a login page (no loop)', () => {
    for (const p of ['/login', '/partner/login', '/admin/login']) { const l = loc(p); expect(handleSessionInvalid(dead, new QueryClient(), l)).toBe(false); expect(l.assign).not.toHaveBeenCalled(); }
  });
  it('picks the surface login page', () => {
    expect(loginPathFor('/partner/shops')).toBe('/partner/login');
    expect(loginPathFor('/counter')).toBe('/login');
  });
});

describe('revoking the current device warns first', () => {
  it('matches only the current device id', () => {
    expect(isCurrentDevice('a', 'a')).toBe(true);
    expect(isCurrentDevice('a', 'b')).toBe(false);
    expect(isCurrentDevice('a', null)).toBe(false);
  });
  it('has the warning in en + ta', () => {
    for (const m of [en, ta] as Record<string, string>[]) expect(m['device.revokeSelfConfirm']).toMatch(/\S/);
  });
});
