import { uuid } from '@/lib/uuid';
/**
 * Masters API: a dispatch table over the Orval-generated client (contract 0.7.0). The ONLY module the screens call.
 * Every call goes through lib/api/fetcher (cookies, CSRF, locale, branch, problem+json → ApiError, 429 Retry-After).
 * Operations marked x-backing in the contract answer 404 until migration 976 lands; screens show "not ready yet".
 */
import { ifMatch, ok } from '@/lib/api/fetcher';
import * as M from '@/lib/api/backend/masters/masters';
import { createExport, getFileDownloadUrl } from '@/lib/api/backend/import/import';
import { uploadAttachment } from '@/lib/api/backend/files/files';
import type { Design, DesignPhoto, DesignPhotoInput, ExportKind, ExportRequestFormat, UploadAttachmentBody, UploadAttachmentBodyPurpose } from '@/lib/api/backend/model';

export type KycParty = 'customers' | 'vendors' | 'staff';
import type { ListParams, MasterInput, MasterKind, MasterPage, MasterRow } from './types';

type R = { status: number; data: unknown };
type Fn = (...a: never[]) => Promise<R>;
interface Ops { list: Fn; create: Fn; get: Fn; update: Fn }
const OPS: Record<MasterKind, Ops> = {
  items: { list: M.listItems, create: M.createItem, get: M.getItem, update: M.updateItem },
  designs: { list: M.listDesigns, create: M.createDesign, get: M.getDesign, update: M.updateDesign },
  stone_standards: { list: M.listStoneStandards, create: M.createStoneStandard, get: M.getStoneStandard, update: M.updateStoneStandard },
  stone_rates: { list: M.listStoneRates, create: M.createStoneRate, get: M.getStoneRate, update: M.updateStoneRate },
  value_addition_rules: { list: M.listValueAdditionRules, create: M.createValueAdditionRule, get: M.getValueAdditionRule, update: M.updateValueAdditionRule },
  customers: { list: M.searchCustomers, create: M.createCustomer, get: M.getCustomer, update: M.updateCustomer },
  vendors: { list: M.listVendors, create: M.createVendor, get: M.getVendor, update: M.updateVendor },
  staff: { list: M.listStaff, create: M.createStaff, get: M.getStaff, update: M.updateStaff },
  floors: { list: M.listFloors, create: M.createFloor, get: M.getFloor, update: M.updateFloor },
  counters: { list: M.listCounters, create: M.createCounter, get: M.getCounter, update: M.updateCounter },
  trays: { list: M.listTrays, create: M.createTray, get: M.getTray, update: M.updateTray },
  hsn_codes: { list: M.listHsnCodes, create: M.createHsnCode, get: M.getHsnCode, update: M.updateHsnCode },
  payment_modes: { list: M.listPaymentModes, create: M.createPaymentMode, get: M.getPaymentMode, update: M.updatePaymentMode },
  card_machines: { list: M.listCardMachines, create: M.createCardMachine, get: M.getCardMachine, update: M.updateCardMachine },
  sub_items: { list: M.listSubItems, create: M.createSubItem, get: M.getSubItem, update: M.updateSubItem },
  kyc_documents: { list: M.listKycDocuments, create: M.createKycDocument, get: M.getKycDocument, update: M.updateKycDocument },
};
// The table erases per-kind argument types once; the registry's field keys mirror each kind's *Input schema.
type AnyFn = (...a: unknown[]) => Promise<R>;
const op = (kind: MasterKind, name: keyof Ops) => OPS[kind][name] as unknown as AnyFn;
const data = async <T>(p: Promise<R>) => (await ok(p)) as unknown as T;
const clean = (p: ListParams) => Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined && v !== '' && v !== false));

/** Contract 0.7.1 MasterLimit: 1–200 (default 50). */
export const PAGE_SIZE = 50;
export const MAX_LIMIT = 200;
/** Batch lookup `?ids=` takes 1–100 ids per call. */
export const IDS_CHUNK = 100;
export const clampLimit = (n: number) => Math.min(MAX_LIMIT, Math.max(1, Math.trunc(n) || PAGE_SIZE));
export const chunk = <T,>(xs: readonly T[], n = IDS_CHUNK): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

export const mastersKeys = {
  all: ['masters'] as const,
  list: (kind: MasterKind, p: ListParams = {}) => ['masters', kind, 'list', p] as const,
  kind: (kind: MasterKind) => ['masters', kind] as const,
};

export const mastersApi = {
  list: (kind: MasterKind, p: ListParams = {}) => {
    const q = { limit: PAGE_SIZE, ...clean(p) } as Record<string, unknown>;
    q.limit = clampLimit(Number(q.limit));
    return data<MasterPage>(op(kind, 'list')(q));
  },
  /**
   * Batch label lookup (0.7.1): `?ids=a,b` (≤ 100 per call, chunked) with include_inactive so deactivated refs still
   * show. Sent as ONE comma-joined value: the contract is style=form, explode=false (Orval would repeat `ids=`).
   * Unknown / other-shop ids are simply absent.
   */
  byIds: async (kind: MasterKind, ids: readonly string[], extra: ListParams = {}) => {
    const uniq = [...new Set(ids.filter(Boolean))];
    const pages = await Promise.all(chunk(uniq).map((c) =>
      data<MasterPage>(op(kind, 'list')({ ...clean(extra), ids: c, include_inactive: true, limit: IDS_CHUNK }))));
    return pages.flatMap((pg) => pg.items);
  },
  get: (kind: MasterKind, id: string) => data<MasterRow>(op(kind, 'get')(id)),
  /** 201 + ETag; duplicate code → 409. Idempotency-Key per attempt (useAttemptKey) so a double tap or retry never duplicates. */
  create: (kind: MasterKind, body: MasterInput, idempotencyKey: string = uuid()) =>
    data<MasterRow>(op(kind, 'create')(body, { 'Idempotency-Key': idempotencyKey })),
  /** PATCH: only changed fields. Sub-items use SubItemPatch, which has no item_id (a sub-item never moves). */
  update: (kind: MasterKind, row: Pick<MasterRow, 'id' | 'version'>, patch: MasterInput) => {
    const body = kind === 'sub_items' ? Object.fromEntries(Object.entries(patch).filter(([k]) => k !== 'item_id')) : patch;
    return data<MasterRow>(op(kind, 'update')(row.id, body, ifMatch(row.version)));
  },
  /** Masters are never deleted (bills reference them): PATCH {is_active} deactivates / reactivates. */
  setActive: (kind: MasterKind, row: Pick<MasterRow, 'id' | 'version'>, active: boolean) =>
    data<MasterRow>(op(kind, 'update')(row.id, { is_active: active }, ifMatch(row.version))),

  /**
   * M4 photos (0.7.0): upload the bytes to POST /v1/files (purpose design_photo), then attach the file id.
   * Reorder / cover is one PATCH with If-Match on the DESIGN version (bumps it); one photo's PATCH/DELETE use the
   * PHOTO version. DELETE answers 204.
   */
  listPhotos: (designId: string) => ok(M.listDesignPhotos(designId)),
  uploadFile: (file: File, purpose: UploadAttachmentBodyPurpose) =>
    ok(uploadAttachment({ purpose, file: file as unknown as UploadAttachmentBody['file'] }, { 'Idempotency-Key': uuid() })),
  attachPhoto: (designId: string, input: DesignPhotoInput) => ok(M.addDesignPhoto(designId, input, { 'Idempotency-Key': uuid() })),
  reorderPhotos: (design: Pick<Design, 'id' | 'version'>, order: string[], coverFileId?: string) =>
    ok(M.reorderDesignPhotos(design.id, { order, cover_file_id: coverFileId ?? null }, ifMatch(design.version) as never)),
  removePhoto: (designId: string, photo: Pick<DesignPhoto, 'id' | 'version'>) => M.removeDesignPhoto(designId, photo.id, ifMatch(photo.version) as never).then(() => undefined),

  /**
   * G2 audited reveal: full PAN + KYC document numbers. The caller keeps the result in component state only
   * (never a query cache); the server answers Cache-Control: no-store and 429 + Retry-After after 10 an hour.
   */
  revealKyc: (party: KycParty, id: string, reason: string) => ok(M.revealKyc(party, id, { reason })),
  /** Vendor PAN backfill verification (counts only, masters.vendors.manage). */
  panBackfillStatus: () => ok(M.vendorPanBackfillStatus()),

  /** Short-lived signed URL for a stored file (photo or export). */
  fileUrl: async (fileId: string) => (await ok(getFileDownloadUrl(fileId))).url,

  /** M17 export: synchronous up to 20 000 rows; same columns as the import template. */
  exportList: (kind: ExportKind, format: ExportRequestFormat, includeInactive: boolean) => ok(createExport({ kind, format, filters: { include_inactive: includeInactive } })),
};
