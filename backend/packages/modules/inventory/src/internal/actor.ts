import { fail } from './errors';

/**
 * Who is calling. Built by the HTTP layer from the session (AuthContext: permissions + roles with branch_id) or by
 * another module's service call. branch_id null on a role = all branches.
 */
export interface InventoryActor {
  userId: string;
  permissions: ReadonlySet<string>;
  roles: readonly { role: string; branch_id: string | null }[];
}

export const isOwner = (a: InventoryActor): boolean => a.roles.some((r) => r.role === 'owner');
export const isManager = (a: InventoryActor): boolean => a.roles.some((r) => r.role === 'manager');

/** null = every branch; otherwise the branch ids the caller is limited to. Owners always see every branch. */
export function branchScope(a: InventoryActor): Set<string> | null {
  if (isOwner(a) || a.roles.some((r) => r.branch_id === null)) return null;
  return new Set(a.roles.map((r) => r.branch_id!).filter(Boolean));
}
export const canSeeBranch = (a: InventoryActor, branchId: string): boolean => {
  const s = branchScope(a);
  return s === null || s.has(branchId);
};
export function need(a: InventoryActor, perm: string): void {
  if (!a.permissions.has(perm)) fail(403, 'forbidden', `missing permission ${perm}`);
}
export function needBranch(a: InventoryActor, branchId: string): void {
  if (!canSeeBranch(a, branchId)) fail(403, 'branch_scope', 'not allowed for this branch');
}
