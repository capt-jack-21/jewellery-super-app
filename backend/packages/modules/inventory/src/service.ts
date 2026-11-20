/** Service facade of Inventory (no HTTP). ONLY Inventory mutates stock (tag.status/branch_id/weights, stock_ledger) as inventory_writer. */
export const MODULE = 'inventory' as const;
export interface StockFacade {
  validateSellable(tagIds: string[], branchId: string): Promise<void>;
  markSold(tagIds: string[], invoiceId: string): Promise<void>;
}
export { setTagStatus } from './internal/stock';
export { InventoryError, type FieldError, checkVersion } from './internal/errors';
export { type InventoryActor, branchScope, canSeeBranch } from './internal/actor';
export { TAG_STATUSES, TERMINAL, MOVABLE, type TagStatus, type Via, assertTransition, statusCatalog, isInStock } from './internal/statuses';
export { type TagFormat, DEFAULT_TAG_FORMAT, renderTagNo, tagScopeKey, validateTagFormat, indianFY, todayIST, renderDocNo, docPrefixOf,
  TRANSFER_NO_FORMAT, ADJUSTMENT_NO_FORMAT, validateDocNoFormat } from './internal/numbering';
export { type InventorySettings, type SettingsPatch, getSettings, loadSettings, patchSettings, previewTagFormat } from './internal/settings';
export { type TagCreate, type CreatedTag, type TagView, createTags, getTag, lookupTag, changeTagStatus, transitionTag, printLabels, addTagPhoto,
  removeTagPhoto, listTagPhotos, updateTagPhoto, tagPhotoFileAccess, type TagPhoto, patchTag, bulkUpdateTags, TAG_EDITABLE, type TagChanges, setLabelPayloads } from './internal/tags';
export { type MoveInput, type LooseMoveLine, moveStock, receiveLoose } from './internal/moves';
export { type Transfer, type TransferLine, type TransferLineInput, createTransfer, getTransfer, approveTransfer, dispatchTransfer, receiveTransfer,
  returnTransfer, cancelTransfer, updateTransfer } from './internal/transfers';
export { type StockCheck, type StockCheckCounts, ZERO_COUNTS, EXTRA_REASONS, type ExtraReason, extraReason, startStockCheck, getStockCheck, recordScan, undoScan, stockCheckReport, counts as stockCheckCounts, closeStockCheck, cancelStockCheck } from './internal/stockchecks';
export { type Adjustment, type AdjustmentInput, type AdjustmentKind, requestAdjustment, getAdjustment, approveAdjustment, rejectAdjustment,
  cancelAdjustment } from './internal/adjustments';
export { stockValuation, stockAgeing, looseStock, ageBucket, stockSummary, type SummaryGroup, type StockValuationIncludes } from './internal/reports';
export { type OpeningTagRow, type OpeningLooseRow, importOpeningStock } from './internal/opening';
export { type Page, type PageQ, listTags, listTransfers, listStockChecks, listAdjustments, listLedger, listLocationMoves, locationMovesByIds, listStockCheckScans } from './internal/lists';
export { type Lot, type LotLine, type LotInput, type LotPatch, type LotLineInput, LOT_NO_FORMAT, createLot, getLot, updateLot, closeLot, listLots } from './internal/lots';
export { type TagHistoryEntry, getTagHistory } from './internal/history';
export { type SaleTag, type SaleStockCtx, type LooseSaleRow, type RestockRow, findTagForSale, tagsForSale, assertSellable, markSold, sellLoose, oldMetalIn, returnToStock } from './internal/sales-stock';
export { type OrderReceiptInput, type OrderReceiptResult, receiveOrderPiece, releaseOrderPiece } from './internal/order-receipt';
