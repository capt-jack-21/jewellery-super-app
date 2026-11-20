/** Password rules shared by "change my password" and "reset a user's password" (contract Password: 8–128 chars). */
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;
export type PasswordError = 'password.err.short' | 'password.err.long' | 'password.err.mismatch' | 'password.err.same' | 'password.err.current';

export function newPasswordError(p: { next: string; confirm: string; current?: string; requireCurrent?: boolean }): PasswordError | null {
  if (p.requireCurrent && !p.current) return 'password.err.current';
  if (p.next.length < PASSWORD_MIN) return 'password.err.short';
  if (p.next.length > PASSWORD_MAX) return 'password.err.long';
  if (p.next !== p.confirm) return 'password.err.mismatch';
  if (p.requireCurrent && p.current === p.next) return 'password.err.same';
  return null;
}
