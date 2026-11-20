import { describe, expect, it } from 'vitest';
import en from '@/i18n/messages/en-IN.json';
import ta from '@/i18n/messages/ta-IN.json';
import { SUSPEND_REASON_MIN } from '@/features/admin/admin';
import { seriesOrCode } from '@/features/settings/branches';
import { USERS_PERM } from '@/features/settings/users';
import { hasPerm } from '@/lib/permissions';

describe('docs review fixes', () => {
  it('suspend reason minimum matches the "min 5" hint', () => expect(SUSPEND_REASON_MIN).toBe(5));
  it('branch bill prefix falls back to the branch code when blank', () => {
    expect(seriesOrCode({ code: 'cbe', bill_series_prefix: '' })).toBe('CBE');
    expect(seriesOrCode({ code: 'CBE', bill_series_prefix: 'KG/26-' })).toBe('KG/26-');
  });
  it('users step is gated on platform.users.manage', () => {
    expect(USERS_PERM).toBe('platform.users.manage');
    expect(hasPerm(['settings.view'], USERS_PERM)).toBe(false);
  });
  it('GST page link label equals the rules page title', () => {
    for (const m of [en, ta] as Record<string, string>[]) expect(m['tax.makingLink']).toBe(m['rules.title']);
  });
  it('unused per-user OTP / invite labels are gone', () => {
    for (const m of [en, ta] as Record<string, string>[]) for (const k of ['user.inviteNote', 'user.requireOtp', 'user.otp', 'user.otpOn']) expect(m[k]).toBeUndefined();
  });
});
