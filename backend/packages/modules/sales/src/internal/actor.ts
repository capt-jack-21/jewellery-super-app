import { fail } from './errors';

/**
 * Who is calling: built by the HTTP layer from the session (AuthContext). branch_id null on a role = all branches.
 * billingEnabled = the session runs on an approved counter device (S18 gate).
 */
export interface SalesActor {
  userId: string;
  permissions: ReadonlySet<string>;
  roles: readonly { role: string; branch_id: string | null }[];
  billingEnabled?: boolean;
  deviceId?: string | null;
}
export const has = (a: SalesActor, perm: string): boolean => a.permissions.has(perm);
export const isOwner = (a: SalesActor): boolean => a.roles.some((r) => r.role === 'owner');
/** null = every branch; otherwise the branch ids the caller is limited to. */
export function branchScope(a: SalesActor): Set<string> | null {
  if (isOwner(a) || a.roles.some((r) => r.branch_id === null)) return null;
  return new Set(a.roles.map((r) => r.branch_id!).filter(Boolean));
}
export const canSeeBranch = (a: SalesActor, branchId: string): boolean => { const s = branchScope(a); return s === null || s.has(branchId); };
export function need(a: SalesActor, perm: string, code = 'permission_denied'): void {
  if (!a.permissions.has(perm)) fail(403, code, `missing permission ${perm}`);
}
export function needAny(a: SalesActor, perms: string[]): void {
  if (!perms.some((p) => a.permissions.has(p))) fail(403, 'permission_denied', `needs one of ${perms.join(', ')}`);
}
export function needBranch(a: SalesActor, branchId: string): void {
  if (!canSeeBranch(a, branchId)) fail(403, 'branch_scope', 'not allowed for this branch');
}
export function needDevice(a: SalesActor): void {
  if (a.billingEnabled === false) fail(403, 'device_not_approved', 'billing needs an approved counter device (S18)');
}
