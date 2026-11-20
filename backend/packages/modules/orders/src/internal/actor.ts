import { fail } from './errors';

/** Who is calling: the session AuthContext (permissions + roles with branch_id; branch_id null = all branches). */
export interface OrdersActor {
  userId: string;
  permissions: ReadonlySet<string>;
  roles: readonly { role: string; branch_id: string | null }[];
}
export const isOwner = (a: OrdersActor): boolean => a.roles.some((r) => r.role === 'owner');
/** null = every branch; otherwise the branch ids the caller is limited to. Owners always see every branch. */
export function branchScope(a: OrdersActor): Set<string> | null {
  if (isOwner(a) || a.roles.some((r) => r.branch_id === null)) return null;
  return new Set(a.roles.map((r) => r.branch_id!).filter(Boolean));
}
export const canSeeBranch = (a: OrdersActor, branchId: string): boolean => {
  const s = branchScope(a);
  return s === null || s.has(branchId);
};
export function need(a: OrdersActor, perm: string): void {
  if (!a.permissions.has(perm)) fail(403, 'forbidden', `missing permission ${perm}`);
}
export function needBranch(a: OrdersActor, branchId: string): void {
  if (!canSeeBranch(a, branchId)) fail(403, 'branch_scope', 'not allowed for this branch');
}
