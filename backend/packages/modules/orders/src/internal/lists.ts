import { type OrdersActor, branchScope, need, needBranch } from './actor';
import { invalid } from './errors';
import { many } from './db';

/** Keyset pages ordered by id DESC (uuid v7 = creation order). cursor = the last id of the previous page. */
export interface Page<T> { items: T[]; next_cursor: string | null }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface PageQ { limit?: number; cursor?: string | null }
export function pageArgs(q: PageQ): { limit: number; cursor: string | null } {
  const limit = q.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) invalid('limit', '1-200');
  if (q.cursor != null && !UUID.test(q.cursor)) invalid('cursor', 'not a cursor from this list');
  return { limit, cursor: q.cursor ?? null };
}
/** null = all branches; else the allowed ids (narrowed to branchId when given, which must be in scope → 403 branch_scope). */
export function branches(a: OrdersActor, branchId?: string | null): string[] | null {
  if (branchId) { needBranch(a, branchId); return [branchId]; }
  const s = branchScope(a);
  return s === null ? null : [...s];
}
export async function page<T extends { id: string }>(sql: string, params: unknown[], limit: number): Promise<Page<T>> {
  const rows = await many<T>(`${sql} ORDER BY id DESC LIMIT ${limit + 1}`, params);
  const more = rows.length > limit;
  const items = more ? rows.slice(0, limit) : rows;
  return { items, next_cursor: more ? items[items.length - 1].id : null };
}
export { need };
