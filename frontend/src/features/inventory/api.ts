/**
 * Inventory API — contract 0.8.4, generated Orval client (`@/lib/api/backend/inventory/inventory`). Screens import ONLY
 * from here: each entry unwraps one generated call (`ok(...)`) and adds the house headers, so the screens stay small and
 * every inventory query lives under the ['inventory', …] key (one invalidate refreshes the module).
 *
 *  - Idempotency-Key (one per attempt, `useAttemptKey`) on every create, dispatch, receive and label print; stock-check scans are
 *    idempotent per code instead (contract notes §1).
 *  - If-Match on every edit and decision (0.8.2): tag status, photos, settings, lots, draft transfers, transfer approve / dispatch / receive /
 *    return / cancel, stock-check close / cancel, lot close (0.8.4), adjustment decisions. Dispatch and receive send BOTH headers.
 *  - Every reason / note is trimmed and must be ≥ 3 characters (`MIN_TEXT`, checked in the forms too).
 *  - 0.8.3: every operation is built (test DB, not deployed). `isNotReady` stays as the generic 404 / 501 guard for a
 *    server that is behind this build.
 *  - 0.8.4: PATCH of a lot / draft transfer DELETES lines left out of `lines` (the editors confirm first); a lot line with
 *    tagged pieces can't go (409 `line_tagged`, shown via `error.line_tagged`). Scan outcomes come from the server
 *    (scan list + report rows); the report is a page {items, next_cursor, counts}.
 *  - Photos carry no url (0.8.3): open them through GET /v1/files/{file_id}/url (`fileUrl`).
 */
import { ApiError, ifMatch, ifMatchOptional, ok } from '@/lib/api/fetcher';
import * as G from '@/lib/api/backend/inventory/inventory';
import { getFileDownloadUrl } from '@/lib/api/backend/import/import';
import type {
  BulkTagInput, InventorySettings, InventorySettingsPatch, ListTagsParams, LocationMoveInput, LooseReceiptInput, StockAdjustment,
  StockAdjustmentInput, StockCheck, StockCheckInput, StockTransfer, StockTransferInput, StockTransferReceiveInput, Tag, TagFormatPatch,
  TagPhoto, TagPhotoInput, StockAdjustmentStatus, StockTransferStatus, ChangeTagStatusBodyStatus, GetStockCheckReportResult,
  CloseLotBody, GetStockSummaryGroupBy, ListLocationMovesParams, ListLotsParams, Lot, LotInput, LotPatch, StockTransferPatch, TagPatch, TagPhotoPatch,
} from '@/lib/api/backend/model';

/** 404 / 501 from a route the server hasn't built yet (not a real "not found" for a known record). */
export const isNotReady = (e: unknown): boolean => e instanceof ApiError && (e.status === 501 || (e.status === 404 && (!e.code || e.code === 'not_found' || e.code === 'route_not_found')));
/** 409 feature_disabled: photos / ageing switched off in inventory settings. */
export const isFeatureOff = (e: unknown): boolean => e instanceof ApiError && e.status === 409 && e.code === 'feature_disabled';

/** 422 field codes (0.8.3 Problem.errors[].code), e.g. field_not_supported, line_tagged, primary_required. */
export const fieldCodes = (e: unknown): Array<{ path: string; code?: string }> =>
  e instanceof ApiError && e.status === 422 ? e.errors.map((x) => ({ path: x.path, code: x.code })) : [];
/** True when the 422 names `field` with `code` (paths may be `vendor_lot_ref` or `/vendor_lot_ref` or `tags.0.vendor_lot_ref`). */
export const hasFieldCode = (e: unknown, field: string, code: string): boolean =>
  fieldCodes(e).some((x) => x.code === code && x.path.replace(/^\//, '').split(/[./]/).includes(field));

/** 0.8.2: every reason / note is trimmed, ≥ 3 chars — rules live in ./adjustments (pure, unit-tested). */
export { MIN_TEXT, textOk, optionalTextOk } from './adjustments';

/** Contract lists: limit 1–200, default 50. */
export const PAGE_SIZE = 50;
export const MAX_IDS = 200;

const idem = (key: string) => ({ 'Idempotency-Key': key });
export type TransferDirection = 'outgoing' | 'incoming';

/**
 * POST /labels body. Live fix (9 Nov 2026): the server rejects `reprint_reason: null` (422 "Expected string") though the
 * contract allows null, so a normal print leaves the field out; a reprint sends the trimmed reason.
 */
export function labelsBody(tagIds: readonly string[], opts: { copies?: number; reprint?: boolean; reprintReason?: string | null } = {}) {
  const reason = opts.reprintReason?.trim();
  const reprint = opts.reprint ?? false;
  return { tag_ids: [...tagIds], copies: opts.copies ?? 1, reprint, ...(reprint && reason ? { reprint_reason: reason } : {}) };
}

export const inventoryKeys = {
  all: ['inventory'] as const,
  tags: (p: ListTagsParams) => ['inventory', 'tags', p] as const,
  tag: (id: string) => ['inventory', 'tag', id] as const,
  history: (id: string) => ['inventory', 'tag', id, 'history'] as const,
  photos: (id: string) => ['inventory', 'tag', id, 'photos'] as const,
  lots: (p: ListLotsParams) => ['inventory', 'lots', p] as const,
  lot: (id: string) => ['inventory', 'lot', id] as const,
  summary: (branchId?: string, groupBy?: GetStockSummaryGroupBy) => ['inventory', 'summary', branchId ?? null, groupBy ?? null] as const,
  moves: (p: ListLocationMovesParams) => ['inventory', 'moves', p] as const,
  scans: (checkId: string) => ['inventory', 'check', checkId, 'scans'] as const,
  fileUrl: (fileId: string) => ['files', fileId, 'url'] as const,
  loose: (branchId?: string) => ['inventory', 'loose', branchId ?? null] as const,
  transfers: (dir: TransferDirection, status?: StockTransferStatus) => ['inventory', 'transfers', dir, status ?? null] as const,
  adjustments: (status: StockAdjustmentStatus | 'all') => ['inventory', 'adjustments', status] as const,
  checks: (branchId?: string) => ['inventory', 'checks', branchId ?? null] as const,
  check: (id: string) => ['inventory', 'check', id] as const,
  report: (id: string, result?: GetStockCheckReportResult) => ['inventory', 'check', id, 'report', result ?? null] as const,
  /** Prefix of every report tab of one check — use this to invalidate (report(id) ends in null and matches no tab). */
  reportAll: (id: string) => ['inventory', 'check', id, 'report'] as const,
  valuation: (branchId?: string, groupBy?: string) => ['inventory', 'valuation', branchId ?? null, groupBy ?? null] as const,
  ageing: (branchId?: string, groupBy?: string) => ['inventory', 'ageing', branchId ?? null, groupBy ?? null] as const,
  settings: ['inventory', 'settings'] as const,
  preview: (f: TagFormatPatch, branchId?: string) => ['inventory', 'settings', 'preview', f, branchId ?? null] as const,
};

export const inventoryApi = {
  /* Settings (§5) */
  settings: () => ok(G.getInventorySettings()),
  /** First save (source default, version 0) needs no If-Match; later saves do. */
  saveSettings: (s: Pick<InventorySettings, 'version' | 'source'>, patch: InventorySettingsPatch) =>
    ok(G.updateInventorySettings(patch, s.source === 'shop' ? ifMatchOptional(s.version) : undefined)),
  previewTagFormat: (tagFormat: TagFormatPatch, branchId?: string) => ok(G.previewTagFormat({ tag_format: tagFormat, branch_id: branchId, count: 3 })),

  /* Tags */
  tags: (p: ListTagsParams) => ok(G.listTags({ limit: PAGE_SIZE, ...p })),
  tag: (id: string) => ok(G.getTag(id)),
  history: (id: string, cursor?: string) => ok(G.getTagHistory(id, { limit: PAGE_SIZE, cursor })),
  /** Counter scan: tag_no, label payload, RFID EPC or HUID; branch optional (else X-Branch-Id). Other-branch tags come back with sellable:false. */
  lookup: (code: string, branchId?: string) => ok(G.getTagByNumber(encodeURIComponent(code.trim()), branchId ? { branch_id: branchId } : undefined)),
  createTag: (body: Parameters<typeof G.createTag>[0], key: string) => ok(G.createTag(body, idem(key))),
  bulkCreate: (body: BulkTagInput, key: string) => ok(G.bulkCreateTags(body, idem(key))),
  /** Editable columns only (TagPatch); vendor_lot_ref is editable from 0.8.3 (null clears it). */
  updateTag: (t: Pick<Tag, 'id' | 'version'>, patch: TagPatch) => ok(G.updateTag(t.id, patch, ifMatch(t.version))),
  changeStatus: (t: Pick<Tag, 'id' | 'version'>, status: ChangeTagStatusBodyStatus, reason: string) => ok(G.changeTagStatus(t.id, { status, reason: reason.trim() }, ifMatch(t.version))),

  /* Photos (tag_photo, ≤10, ≤5 MB) */
  addPhoto: (tagId: string, input: TagPhotoInput, key: string) => ok(G.addTagPhoto(tagId, input, idem(key))),
  photos: (tagId: string) => ok(G.listTagPhotos(tagId)),
  updatePhoto: (tagId: string, photo: Pick<TagPhoto, 'id' | 'version'>, patch: TagPhotoPatch) => ok(G.updateTagPhoto(tagId, photo.id, patch, ifMatch(photo.version))),
  /** Short-lived (5 min) site-relative link; ask again for each view. */
  fileUrl: async (fileId: string) => (await ok(getFileDownloadUrl(fileId))).url,
  removePhoto: (tagId: string, photo: Pick<TagPhoto, 'id' | 'version'>) => G.removeTagPhoto(tagId, photo.id, ifMatch(photo.version)).then(() => undefined),

  /* Labels: POST records the print (reprint needs reprint:true) */
  labels: (tagIds: readonly string[], key: string, opts: { copies?: number; reprint?: boolean; reprintReason?: string } = {}) =>
    ok(G.printTagLabels(labelsBody(tagIds, opts), idem(key))),

  /* Lots (bulk receipts tagged over time): open → tagged → closed */
  lots: (p: ListLotsParams) => ok(G.listLots({ limit: PAGE_SIZE, ...p })),
  lot: (id: string) => ok(G.getLot(id)),
  createLot: (body: LotInput, key: string) => ok(G.createLot(body, idem(key))),
  /** lines is the whole list (id = change in place, no id = add); lines left out are deleted (0.8.4); a tagged one → 409 line_tagged. */
  updateLot: (l: Pick<Lot, 'id' | 'version'>, patch: LotPatch) => ok(G.updateLot(l.id, patch, ifMatch(l.version))),
  closeLot: (l: Pick<Lot, 'id' | 'version'>, body: CloseLotBody) => ok(G.closeLot(l.id, body, ifMatch(l.version))),

  /* Stock summary (in stock = all but sold / melted / returned_to_vendor / written_off) */
  summary: (branchId?: string, groupBy: GetStockSummaryGroupBy = 'status') => ok(G.getStockSummary({ branch_id: branchId || undefined, group_by: groupBy, include_loose: true })),

  /* Loose stock */
  loose: (branchId?: string) => ok(G.listLooseStock({ limit: 200, branch_id: branchId || undefined })),
  receiveLoose: (body: LooseReceiptInput, key: string) => ok(G.receiveLooseStock(body, idem(key))),

  /* Moves */
  move: (body: LocationMoveInput, key: string) => ok(G.moveStock(body, idem(key))),
  moves: (p: ListLocationMovesParams) => ok(G.listLocationMoves({ limit: PAGE_SIZE, ...p })),

  /* Transfers: draft → approved → in_transit → received (or returned / cancelled) */
  transfers: (direction: TransferDirection, status?: StockTransferStatus) => ok(G.listStockTransfers({ direction, status, limit: PAGE_SIZE })),
  createTransfer: (body: StockTransferInput, key: string) => ok(G.createStockTransfer(body, idem(key))),
  /** Draft only (409 transfer_not_draft); lines replace the list, pieces left out are deleted (0.8.4); 1–500 lines. */
  updateTransfer: (t: Pick<StockTransfer, 'id' | 'version'>, patch: StockTransferPatch) =>
    ok(G.updateStockTransfer(t.id, { ...patch, ...(patch.remarks !== undefined ? { remarks: patch.remarks?.trim() || null } : {}) }, ifMatch(t.version))),
  approveTransfer: (t: Pick<StockTransfer, 'id' | 'version'>) => ok(G.approveStockTransfer(t.id, ifMatch(t.version))),
  dispatchTransfer: (t: Pick<StockTransfer, 'id' | 'version'>, key: string, remarks?: string) =>
    ok(G.dispatchStockTransfer(t.id, { remarks: remarks?.trim() || null }, { ...ifMatch(t.version), ...idem(key) })),
  receiveTransfer: (t: Pick<StockTransfer, 'id' | 'version'>, body: StockTransferReceiveInput, key: string) =>
    ok(G.receiveStockTransfer(t.id, body, { ...ifMatch(t.version), ...idem(key) })),
  returnTransfer: (t: Pick<StockTransfer, 'id' | 'version'>, reason: string) => ok(G.returnStockTransfer(t.id, { reason: reason.trim() }, ifMatch(t.version))),
  cancelTransfer: (t: Pick<StockTransfer, 'id' | 'version'>) => ok(G.cancelStockTransfer(t.id, ifMatch(t.version))),

  /* Stock check: live stock, one POST per scan */
  checks: (branchId?: string) => ok(G.listStockChecks({ branch_id: branchId || undefined, limit: PAGE_SIZE })),
  check: (id: string) => ok(G.getStockCheck(id)),
  startCheck: (body: StockCheckInput, key: string) => ok(G.startStockCheck(body, idem(key))),
  scan: (c: Pick<StockCheck, 'id'>, code: string) => ok(G.recordStockCheckScan(c.id, { code: code.trim() })),
  undoScan: (c: Pick<StockCheck, 'id'>, scanId: string) => G.undoStockCheckScan(c.id, scanId).then(() => undefined),
  scans: (c: Pick<StockCheck, 'id'>, cursor?: string) => ok(G.listStockCheckScans(c.id, { limit: PAGE_SIZE, cursor })),
  /** 0.8.4 page {items, next_cursor, counts}; the server sends it as one page today (next_cursor null), so ask for the max and still follow a cursor. */
  report: (c: Pick<StockCheck, 'id'>, result?: GetStockCheckReportResult, cursor?: string) => ok(G.getStockCheckReport(c.id, { result, limit: 200, cursor })),
  closeCheck: (c: Pick<StockCheck, 'id' | 'version'>, createAdjustments: boolean, notes?: string) =>
    ok(G.closeStockCheck(c.id, { create_adjustments: createAdjustments, notes: notes?.trim() || null }, ifMatch(c.version))),
  cancelCheck: (c: Pick<StockCheck, 'id' | 'version'>) => ok(G.cancelStockCheck(c.id, ifMatch(c.version))),

  /* Adjustments: every request starts pending; approval applies at once */
  adjustments: (status: StockAdjustmentStatus | 'all') => ok(G.listStockAdjustments({ status: status === 'all' ? undefined : status, limit: PAGE_SIZE })),
  requestAdjustment: (body: StockAdjustmentInput, key: string) => ok(G.requestStockAdjustment(body, idem(key))),
  approve: (a: Pick<StockAdjustment, 'id' | 'version'>, note: string) => ok(G.approveStockAdjustment(a.id, { note: note.trim() || null }, ifMatch(a.version))),
  reject: (a: Pick<StockAdjustment, 'id' | 'version'>, note: string) => ok(G.rejectStockAdjustment(a.id, { note: note.trim() }, ifMatch(a.version))),
  cancelAdjustment: (a: Pick<StockAdjustment, 'id' | 'version'>) => ok(G.cancelStockAdjustment(a.id, ifMatch(a.version))),

  /* Reports (computed by the server) */
  valuation: (branchId?: string, groupBy: 'purity' | 'metal' | 'branch' | 'counter' | 'item' = 'purity') => ok(G.getStockValuation({ branch_id: branchId || undefined, group_by: groupBy, include_loose: true })),
  ageing: (branchId?: string, groupBy?: 'item' | 'design' | 'purity' | 'counter') => ok(G.getStockAgeingReport({ branch_id: branchId || undefined, group_by: groupBy })),
};
export type { Tag };
