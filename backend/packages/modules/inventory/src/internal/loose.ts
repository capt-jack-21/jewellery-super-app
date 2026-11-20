import { fail } from './errors';
import { one, mg } from './db';

/** Current loose balance at an exact location (v_loose_stock; counter/box NULL = branch level). */
export async function looseBalance(branchId: string, itemId: string, purityId: string, counterId: string | null, boxId: string | null) {
  const r = await one<{ pieces: string; gross_wt: string; net_wt: string }>(
    `SELECT coalesce(sum(direction * pieces), 0)::text AS pieces, coalesce(sum(direction * gross_wt), 0)::text AS gross_wt,
            coalesce(sum(direction * net_wt), 0)::text AS net_wt
       FROM inventory.stock_ledger
      WHERE tag_id IS NULL AND branch_id = $1 AND item_id = $2 AND purity_id = $3
        AND counter_id IS NOT DISTINCT FROM $4::uuid AND box_id IS NOT DISTINCT FROM $5::uuid`,
    [branchId, itemId, purityId, counterId, boxId]);
  return { pieces: BigInt(r!.pieces), gross: mg(r!.gross_wt), net: mg(r!.net_wt) };
}
/** 409 insufficient_stock unless the location holds at least this much. */
export async function requireLoose(branchId: string, itemId: string, purityId: string, counterId: string | null, boxId: string | null,
  pieces: number, gross: bigint, net: bigint): Promise<void> {
  const b = await looseBalance(branchId, itemId, purityId, counterId, boxId);
  if (b.pieces < BigInt(pieces) || b.gross < gross || b.net < net) fail(409, 'insufficient_stock', 'not enough loose stock at that location');
}
