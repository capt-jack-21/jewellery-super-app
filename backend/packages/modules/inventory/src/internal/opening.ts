import { withSavepoint } from '@jw/db';
import { type InventoryActor, need, needBranch } from './actor';
import { fail } from './errors';
import { ledger, one, gm, mg } from './db';

export interface OpeningTagRow {
  tag_no: string; item_id: string; purity_id: string; gross_wt: string; stone_wt?: string; net_wt: string; pieces?: number; huid?: string | null;
  mc_type: 'per_gram' | 'percent' | 'flat' | 'per_piece'; mc_value?: string | number; wastage_pct?: string | number; received_on?: string | null;
  counter_id?: string | null; box_id?: string | null;
  /** default: exempt when there is no HUID (imported legacy stock) */ hallmark_exempt?: boolean; huid_charge?: string | number;
}
export interface OpeningLooseRow { item_id: string; purity_id: string; gross_wt: string; net_wt: string; pieces?: number; counter_id?: string | null; box_id?: string | null }
/**
 * Commit of the platform 'stock' import kind (opening stock) through Inventory: tags keep their imported tag_no (later numbering
 * skips them) and get an 'opening' ledger row; loose rows post 'opening' loose balances. Rows already validated by the import.
 * Returns per-row results so the import job can report failures without aborting the whole file.
 */
export async function importOpeningStock(a: InventoryActor, branchId: string, importJobId: string,
  rows: { tags?: OpeningTagRow[]; loose?: OpeningLooseRow[] }): Promise<{ created: number; errors: { row: number; code: string }[] }> {
  need(a, 'inventory.tag.create');
  needBranch(a, branchId);
  const errors: { row: number; code: string }[] = [];
  let created = 0;
  for (const [k, r] of (rows.tags ?? []).entries()) {
    try {
      const id = await withSavepoint(async (c) => (await c.query<{ id: string }>(
        `INSERT INTO inventory.tag(tenant_id, branch_id, tag_no, item_id, purity_id, huid, hallmark_exempt, pieces, gross_wt, stone_wt, net_wt,
           mc_type, mc_value, wastage_pct, received_on, counter_id, box_id, tagged_by, huid_charge)
         VALUES (platform.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) RETURNING id`,
        [branchId, r.tag_no.toUpperCase(), r.item_id, r.purity_id, r.huid ?? null, r.hallmark_exempt ?? !r.huid, r.pieces ?? 1, r.gross_wt, r.stone_wt ?? '0', r.net_wt,
         r.mc_type, r.mc_value ?? 0, r.wastage_pct ?? 0, r.received_on ?? null, r.counter_id ?? null, r.box_id ?? null, a.userId, r.huid_charge ?? 0])).rows[0].id);
      await ledger([{ branch_id: branchId, tag_id: id, item_id: r.item_id, purity_id: r.purity_id, movement: 'opening', direction: 1, pieces: r.pieces ?? 1,
        gross_wt: gm(mg(r.gross_wt)), net_wt: gm(mg(r.net_wt)), source_type: 'import_job', source_id: importJobId, user_id: a.userId,
        counter_id: r.counter_id ?? null, box_id: r.box_id ?? null }]);
      created++;
    } catch (e) {
      const pe = e as { code?: string; constraint?: string };
      if (pe.code === '23505') errors.push({ row: k, code: pe.constraint === 'tag_huid_uq' ? 'huid_exists' : 'tag_no_exists' });
      else if (pe.code === '23503' || pe.code === '23514' || pe.code === '22P02') errors.push({ row: k, code: 'invalid_row' });
      else throw e;
    }
  }
  for (const r of rows.loose ?? []) {
    const it = await one<{ stock_type: string }>(`SELECT stock_type FROM masters.item WHERE id = $1`, [r.item_id]);
    if (!it) fail(422, 'unknown_reference', 'item_id');
    await ledger([{ branch_id: branchId, item_id: r.item_id, purity_id: r.purity_id, movement: 'opening', direction: 1, pieces: r.pieces ?? 0,
      gross_wt: gm(mg(r.gross_wt)), net_wt: gm(mg(r.net_wt)), source_type: 'import_job', source_id: importJobId, user_id: a.userId,
      counter_id: r.counter_id ?? null, box_id: r.box_id ?? null }]);
    created++;
  }
  return { created, errors };
}
