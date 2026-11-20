import { Module, type OnModuleInit } from '@nestjs/common';
import { PlatformModule, Problem, registerFileAccess, registerStockImporter, type FileAccessFn, type StockImportRow } from '@jw/mod-platform';
import { importOpeningStock, type OpeningTagRow } from '../internal/opening';
import { InventoryError } from '../internal/errors';
import { tagPhotoFileAccess } from '../internal/tags';
import { InventoryAdjustmentsController, InventoryLotsController, InventorySettingsController, InventoryStockChecksController, InventoryStockController,
  InventoryTagsController, InventoryTransfersController, InventoryViewsController } from './controllers';

const MC = new Set(['per_gram', 'percent', 'flat', 'per_piece']);
/** Platform 'stock' import commit → Inventory (only Inventory mutates stock). All-or-nothing: any row error rolls back the request tx. */
export async function stockImportViaInventory(rows: StockImportRow[], ctx: Parameters<Parameters<typeof registerStockImporter>[0]>[1]): Promise<void> {
  const tags: OpeningTagRow[] = rows.map((r) => ({ tag_no: r.tag_no, item_id: r.item_id, purity_id: r.purity_id, gross_wt: r.gross_wt, stone_wt: r.stone_wt,
    net_wt: r.net_wt, pieces: r.pieces, huid: r.huid, hallmark_exempt: r.hallmark_exempt, huid_charge: r.huid_charge,
    mc_type: (MC.has(r.mc_type) ? r.mc_type : 'per_gram') as OpeningTagRow['mc_type'], mc_value: r.mc_value, wastage_pct: r.wastage_pct }));
  let res: Awaited<ReturnType<typeof importOpeningStock>>;
  try { res = await importOpeningStock(ctx.auth, ctx.branchId, ctx.sourceId, { tags }); } catch (e) {
    if (e instanceof InventoryError) throw new Problem(e.status, e.status === 403 && e.code === 'forbidden' ? 'permission_denied' : e.code, e.message, e.errors);
    throw e;
  }
  if (res.errors.length) {
    throw new Problem(409, 'import_rows_rejected', `${res.errors.length} row(s) rejected by inventory; nothing was imported`,
      res.errors.map((x) => ({ path: `rows.${x.row}`, message: x.code })));
  }
}

/** GET /v1/files/{id}/url for piece photos: anyone with inventory.stock.view who can see the piece's branch. */
const inventoryFileAccess: FileAccessFn = (file, auth) => tagPhotoFileAccess(file, auth);

@Module({
  imports: [PlatformModule],
  controllers: [InventorySettingsController, InventoryTagsController, InventoryStockController, InventoryTransfersController, InventoryStockChecksController,
    InventoryAdjustmentsController, InventoryLotsController, InventoryViewsController],
})
export class InventoryModule implements OnModuleInit {
  onModuleInit(): void {
    registerStockImporter(stockImportViaInventory);
    registerFileAccess(inventoryFileAccess);
  }
}
