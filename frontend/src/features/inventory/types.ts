/**
 * Inventory types — generated from contract 0.8.3 (Orval, `@/lib/api/backend/model`). Nothing is hand-written here any
 * more; this file only re-exports the models the screens use and a few UI lists derived from the contract enums.
 * Weights, money, rates and percents are decimal STRINGS.
 */
import {
  StockAdjustmentKind, StockAdjustmentReasonCode, StockAdjustmentStatus, StockCheckExtraReason, StockStatus, StockTransferStatus,
  type ChangeTagStatusBodyStatus,
} from '@/lib/api/backend/model';

export type {
  BulkTagInput, BulkTagInputCommon, BulkTagInputRowsItem, BulkTagResult, InventorySettings, InventorySettingsPatch,
  LocationMoveInput, LooseReceiptInput, LooseStock, LooseStockPage, StockAdjustment, StockAdjustmentInput, StockAdjustmentPage,
  StockAgeingBucket, StockAgeingReport, StockCheck, StockCheckInput, StockCheckReportPage, StockCheckReportRow,
  StockCheckScanResult, StockTransfer, StockTransferInput, StockTransferLine, StockTransferPage, StockValuation,
  StockValuationRow, Tag, TagFormat, TagFormatPatch, TagFormatPreview, TagHistoryEntry, TagHistoryPage, TagInput,
  TagLabel, TagLabelBatch, TagPage, TagPhoto, ListTagsParams, Lot, LotLine, LotInput, LotPatch, StockSummary, StockSummaryRow, LocationMove, StockCheckScan, RefLabels, StockAgeBasis, StockValueBasis, StockValuationIncludes,
} from '@/lib/api/backend/model';
export type {
  StockAdjustmentKind as AdjustmentKind, StockAdjustmentReasonCode as ReasonCode, StockAdjustmentStatus as AdjustmentStatus,
  StockStatus as TagStatus, StockTransferStatus as TransferStatus, StockCheckExtraReason as ExtraReason,
} from '@/lib/api/backend/model';

const values = <T extends Record<string, string>>(o: T) => Object.values(o) as Array<T[keyof T]>;
export const PIECE_STATUSES = values(StockStatus);
export const ADJUSTMENT_KINDS = values(StockAdjustmentKind);
export const REASON_CODES = values(StockAdjustmentReasonCode);
export const ADJUSTMENT_STATUSES = values(StockAdjustmentStatus);
export const TRANSFER_STATUSES = values(StockTransferStatus);
/** 0.8.2 stable codes for an extra stock-check scan (English labels are client-side). */
export const EXTRA_REASONS = values(StockCheckExtraReason);
/** Statuses a person can set by hand (POST /tags/{id}/status); the rest change through sales, memos, transfers, refinery. */
export const MANUAL_STATUSES: readonly ChangeTagStatusBodyStatus[] = ['in_stock', 'reserved', 'repair', 'melting'];
