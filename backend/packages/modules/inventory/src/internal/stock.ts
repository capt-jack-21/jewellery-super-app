import { withModuleRole } from '@jw/db';
export type { TagStatus } from './statuses';
import type { TagStatus } from './statuses';
/** Mechanical status change as inventory_writer (no transition check). Kept for the role-switching tests; flows use transitionTag. */
export async function setTagStatus(tagId: string, status: TagStatus): Promise<number> {
  return withModuleRole('inventory_writer', async (c) =>
    (await c.query('UPDATE inventory.tag SET status = $2 WHERE id = $1', [tagId, status])).rowCount ?? 0);
}
