import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import { Ctx, type JwRequest, Problem, etag, ifMatch, needKey, requestHash, withIdempotency } from '@jw/mod-platform';
import { z } from 'zod';
import { parse } from './parse';
import * as inv from '../service';
import { InventoryError } from '../internal/errors';
import { REASON_CODES } from '../internal/adjustments';

/**
 * HTTP layer of Inventory (contract 0.8.3, /v1/inventory/*). Thin: parse (zod), If-Match / Idempotency-Key, call the service,
 * map InventoryError → problem+json. Permission and branch-scope checks live in the services (actor = the session AuthContext).
 * Contract tray_id ↔ data-model box_id.
 */
type Reply = { status(n: number): unknown; header(k: string, v: string): unknown };
const actor = (req: JwRequest): inv.InventoryActor => {
  if (!req.auth) throw new Problem(401, 'unauthenticated');
  return req.auth;
};
/** Service call with InventoryError → Problem (403 forbidden → permission_denied, the platform code). */
async function call<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) {
    if (e instanceof InventoryError) {
      const code = e.status === 403 && e.code === 'forbidden' ? 'permission_denied' : e.code;
      throw new Problem(e.status, code, e.message, e.errors);
    }
    throw e;
  }
}
const tagged = <T extends { version: number }>(reply: Reply, v: T): T => { reply.header('ETag', etag(v.version)); return v; };
const ver = (req: JwRequest): number => ifMatch(req, true)!;
// N17: every obligatory-key handler checks this before body/If-Match parsing, never after writes or number allocation.
function requiredKey(req: JwRequest): string {
  const key = req.headers['idempotency-key'] as string | undefined;
  needKey(key); return key!;
}
/** Idempotent POST: replays the stored response for the same key + body. */
async function idem(req: JwRequest, reply: Reply, scope: string, id: string, body: Record<string, unknown>, status: number, run: () => Promise<unknown>) {
  const key = requiredKey(req);
  return withIdempotency(reply, scope, key!, requestHash(id, body), async () => ({ status, body: await call(run) }));
}
const branchOf = (req: JwRequest, q?: string): string | null => {
  const h = req.headers['x-branch-id'];
  const v = q ?? (Array.isArray(h) ? h[0] : h) ?? null;
  return v === null ? null : parse(z.string().uuid(), v);
};
const uuid = z.string().uuid();
const nUuid = uuid.nullable().optional();
const wt = z.string().regex(/^-?\d{1,7}(\.\d{1,3})?$/);
const reason = z.string().trim().min(3).max(500);
const limitQ = (v?: string) => (v === undefined ? undefined : parse(z.coerce.number().int().min(1).max(200), v));
const asList = (v?: string | string[]) => (v === undefined ? undefined : (Array.isArray(v) ? v : v.split(',')).map((s) => s.trim()).filter(Boolean));

// ---------- settings / statuses ----------
const FormatPatch = z.object({ prefix: z.string(), separator: z.enum(['', '-', '/']), branch_segment: z.boolean(), item_segment: z.boolean(),
  segment_order: z.enum(['branch_item', 'item_branch']), start_no: z.number().int(), digits: z.number().int() }).partial().strict();
const SettingsPatch = z.object({ tag_format: FormatPatch, adjustment_approver: z.enum(['owner_or_manager', 'owner_only']), photos_enabled: z.boolean(),
  ageing_enabled: z.boolean(), ageing_bucket_days: z.array(z.number().int()).min(1).max(8),
  transfer_no_format: z.string(), adjustment_no_format: z.string() }).partial().strict();

@Controller('v1/inventory')
export class InventorySettingsController {
  @Get('settings')
  async get(@Ctx() req: JwRequest, @Res({ passthrough: true }) reply: Reply) { return tagged(reply, await call(() => inv.getSettings(actor(req)))); }
  @Patch('settings')
  async patch(@Ctx() req: JwRequest, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    const b = parse(SettingsPatch, body);
    return tagged(reply, await call(() => inv.patchSettings(actor(req), b, ifMatch(req, false))));
  }
  @Post('settings/tag-format/preview') @HttpCode(200)
  async preview(@Ctx() req: JwRequest, @Body() body: unknown) {
    const b = parse(z.object({ tag_format: FormatPatch.optional(), branch_id: uuid.optional(), item_id: uuid.optional(),
      count: z.number().int().min(1).max(5).optional() }).strict(), body ?? {});
    return call(() => inv.previewTagFormat(actor(req), b));
  }
  @Get('statuses')
  /** 0.8.8: a bare StockStatusInfo[] as the contract says (was wrapped in { items }). */
  statuses() { return inv.statusCatalog(); }
}

// ---------- tags ----------
const dec = z.union([z.string().regex(/^\d{1,12}(\.\d{1,4})?$/), z.number().nonnegative()]);
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** Descriptive tag fields shared by TagInput, BulkTagInput.common and rows (contract 0.8.2). */
const Desc = { counter_id: nUuid, tray_id: nUuid, sub_item_id: nUuid, design_id: nUuid, hsn: z.string().regex(/^[0-9]{4,8}$/).nullable().optional(),
  value_addition_rule_id: nUuid, size: z.string().max(20).nullable().optional(), mc_type: z.enum(['per_gram', 'percent', 'flat', 'per_piece']).optional(),
  mc_value: dec.optional(), wastage_pct: dec.optional(), min_wastage_pct: dec.nullable().optional(), max_wastage_pct: dec.nullable().optional(),
  min_sale_value: dec.nullable().optional(), max_sale_value: dec.nullable().optional(), huid_charge: dec.optional(), cost_value: dec.nullable().optional(),
  hallmark_exempt: z.boolean().optional(), received_on: ymd.nullable().optional(), label_payload: z.string().min(1).max(512).nullable().optional() };
const Weights = { gross_wt: wt, stone_wt: wt.optional(), net_wt: wt, cover_wt: wt.optional(), loop_wt: wt.optional(), pieces: z.number().int().min(1).optional(),
  huid: z.string().regex(/^[A-Za-z0-9]{6}$/).nullable().optional(), stones: z.array(z.unknown()).max(0, 'stones are not stored yet').optional() };
const Source = { source: z.enum(['lot', 'loose', 'direct']).optional(), lot_line_id: uuid.optional(), from_counter_id: nUuid, from_tray_id: nUuid };
const VendorLotRef = z.string().trim().min(1).max(60).nullable().optional();
const TagIn = z.object({ ...Source, branch_id: uuid, item_id: uuid, purity_id: uuid, ...Desc, ...Weights, vendor_lot_ref: VendorLotRef }).strict();
const BulkIn = z.object({ ...Source,
  common: z.object({ branch_id: uuid, item_id: uuid, purity_id: uuid, ...Desc }).omit({ label_payload: true, cost_value: true }).strict(),
  rows: z.array(z.object({ ...Weights, hallmark_exempt: Desc.hallmark_exempt, size: Desc.size, design_id: Desc.design_id, cost_value: Desc.cost_value,
    label_payload: Desc.label_payload, mc_type: Desc.mc_type, mc_value: Desc.mc_value, wastage_pct: Desc.wastage_pct, counter_id: nUuid, tray_id: nUuid }).strict()).min(1).max(200),
  print_labels: z.boolean().optional(),
  vendor_lot_ref: VendorLotRef }).strict();
/** source loose (draw from a loose balance) is not built in this run (contract x-backing); lot needs lot_line_id. */
function sourceCheck(b: { source?: string; lot_line_id?: string; from_counter_id?: string | null; from_tray_id?: string | null }) {
  if (b.source === 'loose' || b.from_counter_id || b.from_tray_id) throw new Problem(422, 'validation_failed', 'source loose is not supported yet', [{ path: 'source', message: 'source_not_supported' }]);
  if (b.source === 'lot' && !b.lot_line_id) throw new Problem(422, 'validation_failed', 'lot_line_id is required for source lot', [{ path: 'lot_line_id', message: 'required' }]);
}
const toCreate = (r: Record<string, unknown>, lotLine?: string): inv.TagCreate => {
  const { tray_id, stones: _s, label_payload: _l, branch_id: _b, source: _src, lot_line_id, from_counter_id: _fc, from_tray_id: _ft, ...rest } = r as Record<string, unknown> & { tray_id?: string | null };
  return { ...(rest as unknown as inv.TagCreate), box_id: tray_id ?? null, lot_line_id: (lot_line_id as string | undefined) ?? lotLine ?? null };
};
/** label_payload is set after insert (app_rw UPDATE column) so create stays one INSERT per piece. */
const StatusIn = z.object({ status: z.enum(['in_stock', 'reserved', 'repair', 'melting']), reason: z.string().trim().min(3).max(300) }).strict();
const BulkUpdateIn = z.object({ items: z.array(z.object({ id: uuid, version: z.number().int().min(1) }).strict()).min(1).max(200),
  changes: z.record(z.unknown()) }).strict();
/** If-Match list form (RFC 9110): "3", "7", … — one entity-tag per item, in items[] order. */
function ifMatchList(req: JwRequest, n: number): number[] {
  const raw = req.headers['if-match'];
  const v = Array.isArray(raw) ? raw.join(',') : raw;
  if (!v) throw new Problem(428, 'precondition_required', 'Send If-Match with one ETag per item, in items order');
  const parts = v.split(',').map((s) => /^(?:W\/)?"(\d+)"$/.exec(s.trim()));
  if (parts.some((m) => !m) || parts.length !== n) throw new Problem(412, 'version_mismatch', `If-Match must list ${n} quoted versions, in items order`);
  return parts.map((m) => Number(m![1]));
}

/**
 * TagLabelRequest (0.8.7). reprint_reason: string | null | missing — the "reprint needs a reason" rule lives in printLabels, so a first
 * print with reprint_reason null no longer fails here with 'Expected string, received null'.
 */
export const LabelsIn = z.object({ tag_ids: z.array(uuid).min(1).max(200),
  copies: z.number().int().min(1).max(5).optional(), reprint: z.boolean().optional(),
  reprint_reason: z.string().max(200).nullable().optional() }).strict();

@Controller('v1/inventory')
export class InventoryTagsController {
  @Get('tags')
  async list(@Ctx() req: JwRequest, @Query() q: Record<string, string | string[] | undefined>) {
    const s = (k: string) => (q[k] === undefined ? undefined : parse(uuid, String(q[k])));
    return call(() => inv.listTags(actor(req), { branch_id: branchOf(req, q.branch_id as string | undefined), counter_id: s('counter_id'), tray_id: s('tray_id'),
      item_id: s('item_id'), design_id: s('design_id'), purity_id: s('purity_id'), lot_id: s('lot_id'), status: asList(q.status),
      tagged_from: q.tagged_from as string | undefined, tagged_to: q.tagged_to as string | undefined, limit: limitQ(q.limit as string | undefined),
      cursor: (q.cursor as string | undefined) ?? null }));
  }
  @Post('tags')
  async create(@Ctx() req: JwRequest, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    requiredKey(req);
    const b = parse(TagIn, body);
    sourceCheck(b);
    return idem(req, reply, 'POST /v1/inventory/tags', '', b, 201, async () => {
      const [t] = await inv.createTags(actor(req), b.branch_id, [toCreate(b)]);
      if (b.label_payload != null) await inv.setLabelPayloads([{ id: t.id, label_payload: b.label_payload }]);
      return { ...(await inv.getTag(actor(req), t.id)), skipped_numbers: t.skipped_numbers };
    });
  }
  @Post('tags/bulk')
  async bulk(@Ctx() req: JwRequest, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    requiredKey(req);
    const b = parse(BulkIn, body);
    sourceCheck(b);
    return idem(req, reply, 'POST /v1/inventory/tags/bulk', '', b, 201, async () => {
      const { branch_id, ...common } = b.common;
      const made = await inv.createTags(actor(req), branch_id, b.rows.map((r) => ({ ...toCreate({ ...common, ...r }, b.lot_line_id), vendor_lot_ref: b.vendor_lot_ref ?? null })));
      const payloads = made.map((t, k) => ({ id: t.id, label_payload: b.rows[k].label_payload ?? null })).filter((x) => x.label_payload !== null);
      if (payloads.length) await inv.setLabelPayloads(payloads as { id: string; label_payload: string }[]);
      const labels = b.print_labels ? await inv.printLabels(actor(req), made.map((t) => t.id)) : undefined;
      // 0.8.9: read the pieces after printing, so items carry the label_print_count / label_printed_at / version the print just wrote
      const items = await Promise.all(made.map((t) => inv.getTag(actor(req), t.id)));
      return { items, first_tag_no: made[0]?.tag_no ?? null, last_tag_no: made[made.length - 1]?.tag_no ?? null,
        skipped_numbers: made.flatMap((t) => t.skipped_numbers), ...(labels ? { labels } : {}) };
    });
  }
  @Post('tags/bulk-update') @HttpCode(200)
  async bulkUpdate(@Ctx() req: JwRequest, @Body() body: unknown) {
    const b = parse(BulkUpdateIn, body);
    const vs = ifMatchList(req, b.items.length);
    if (vs.some((v, k) => v !== b.items[k].version)) throw new Problem(412, 'version_mismatch', 'If-Match and items[].version disagree');
    return { items: await call(() => inv.bulkUpdateTags(actor(req), b.items, b.changes)) };
  }
  @Get('tag-lookup/:tagNo')
  async lookup(@Ctx() req: JwRequest, @Param('tagNo') tagNo: string, @Query('branch_id') qb: string | undefined, @Res({ passthrough: true }) reply: Reply) {
    if (!tagNo || tagNo.length > 64) throw new Problem(422, 'validation_failed', 'tagNo: 1-64 characters');
    const branch = branchOf(req, qb);
    const t = await call(() => inv.lookupTag(actor(req), tagNo));
    // sellable: null when no branch was sent (query or X-Branch-Id); else in_stock at that branch
    return tagged(reply, { ...t, sellable: branch === null ? null : t.status === 'in_stock' && t.branch_id === branch });
  }
  @Get('tags/:id')
  async get(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) reply: Reply) {
    return tagged(reply, await call(() => inv.getTag(actor(req), id)));
  }
  @Patch('tags/:id')
  async patch(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    const b = parse(z.record(z.unknown()), body);
    const v = ver(req);
    return tagged(reply, await call(() => inv.patchTag(actor(req), id, b, v)));
  }
  @Post('tags/:id/status') @HttpCode(200)
  async status(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    const b = parse(StatusIn, body);
    const v = ver(req);
    return tagged(reply, await call(() => inv.changeTagStatus(actor(req), id, b.status, b.reason, v)));
  }
  @Post('tags/:id/photos')
  async addPhoto(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    const b = parse(z.object({ file_id: uuid, is_primary: z.boolean().optional(), caption: z.string().max(200).optional() }).strict(), body);
    reply.status(201);
    // 0.8.8: the contract TagPhoto (+ ETag), not just { id }
    return tagged(reply, await call(() => inv.addTagPhoto(actor(req), id, b.file_id, b)));
  }
  @Delete('tags/:id/photos/:photoId') @HttpCode(204)
  async removePhoto(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Param('photoId', ParseUUIDPipe) photoId: string) {
    await call(() => inv.removeTagPhoto(actor(req), id, photoId));
  }
  /** 0.8.2: Idempotency-Key required, so a network retry does not double label_print_count. */
  @Post('labels')
  async labels(@Ctx() req: JwRequest, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    requiredKey(req);
    const b = parse(LabelsIn, body);
    return idem(req, reply, 'POST /v1/inventory/labels', '', b, 200, () => inv.printLabels(actor(req), b.tag_ids, b));
  }
}

// ---------- loose stock, moves, ledger ----------
const LooseIn = z.object({ branch_id: uuid, counter_id: nUuid, tray_id: nUuid, item_id: uuid, purity_id: uuid, gross_wt: wt, net_wt: wt,
  pieces: z.number().int().min(0).optional(), lot_line_id: uuid.optional(), note: z.string().trim().min(3).max(300).nullable().optional() }).strict();
const LooseLine = z.object({ item_id: uuid, purity_id: uuid, from_counter_id: uuid.nullable(), from_tray_id: nUuid, pieces: z.number().int().min(0).optional(),
  gross_wt: wt, net_wt: wt }).strict();
const MoveIn = z.object({ branch_id: uuid, to_counter_id: uuid.nullable(), to_tray_id: nUuid, tag_ids: z.array(uuid).max(500).optional(),
  loose: z.array(LooseLine).max(100).optional(), reason: z.string().trim().min(3).max(300).nullable().optional() }).strict();

@Controller('v1/inventory')
export class InventoryStockController {
  @Get('loose-stock')
  async loose(@Ctx() req: JwRequest, @Query() q: Record<string, string | undefined>) {
    const items = await call(() => inv.looseStock(actor(req), { branch_id: branchOf(req, q.branch_id), item_id: q.item_id, purity_id: q.purity_id,
      counter_id: q.counter_id, tray_id: q.tray_id }));
    return { items, next_cursor: null };
  }
  @Post('loose-stock/receipts')
  async receipt(@Ctx() req: JwRequest, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    requiredKey(req);
    const b = parse(LooseIn, body);
    // 0.8.8: 201 body = the resulting LooseStock balance (contract). receiveLoose returned nothing, so the idempotency store got a null body → 500.
    return idem(req, reply, 'POST /v1/inventory/loose-stock/receipts', '', b, 201, () => inv.receiveLoose(actor(req), b as Parameters<typeof inv.receiveLoose>[1]));
  }
  @Post('moves')
  async move(@Ctx() req: JwRequest, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    requiredKey(req);
    const b = parse(MoveIn, body);
    return idem(req, reply, 'POST /v1/inventory/moves', '', b, 201, async () => {
      const r = await inv.moveStock(actor(req), b);
      // 0.8.8: items = the LocationMove rows (contract), not bare ids
      return { items: await inv.locationMovesByIds(r.move_ids), moved: (b.tag_ids?.length ?? 0) + (b.loose?.length ?? 0) };
    });
  }
  @Get('ledger')
  async ledger(@Ctx() req: JwRequest, @Query() q: Record<string, string | undefined>) {
    return call(() => inv.listLedger(actor(req), { branch_id: branchOf(req, q.branch_id), tag_id: q.tag_id, item_id: q.item_id, movement: q.movement,
      source_id: q.source_id, from: q.from, to: q.to, limit: limitQ(q.limit), cursor: q.cursor ?? null }));
  }
  @Get('valuation')
  async valuation(@Ctx() req: JwRequest, @Query() q: Record<string, string | undefined>) {
    return call(() => inv.stockValuation(actor(req), { branch_id: branchOf(req, q.branch_id), group_by: q.group_by as never,
      include_loose: q.include_loose === undefined ? undefined : q.include_loose === 'true' }));
  }
  @Get('reports/ageing')
  async ageing(@Ctx() req: JwRequest, @Query() q: Record<string, string | undefined>) {
    return call(() => inv.stockAgeing(actor(req), { branch_id: branchOf(req, q.branch_id), group_by: q.group_by as never,
      include_rows: q.include_rows === 'true', limit: limitQ(q.limit) }));
  }
}

// ---------- transfers ----------
const TransferLineIn = z.object({ tag_id: uuid.optional(), item_id: uuid.optional(), purity_id: uuid.optional(), from_counter_id: nUuid, from_tray_id: nUuid,
  pieces: z.number().int().min(0).optional(), gross_wt: wt.optional(), net_wt: wt.optional() }).strict();
const TransferIn = z.object({ from_branch_id: uuid, to_branch_id: uuid, lines: z.array(TransferLineIn).min(1).max(500),
  remarks: z.string().max(500).nullable().optional() }).strict();
const ReceiveIn = z.object({ line_ids: z.array(uuid).min(1).max(500), note: reason.nullable().optional(), counter_id: nUuid, tray_id: nUuid }).strict();

@Controller('v1/inventory/transfers')
export class InventoryTransfersController {
  @Get()
  async list(@Ctx() req: JwRequest, @Query() q: Record<string, string | undefined>) {
    return call(() => inv.listTransfers(actor(req), { branch_id: branchOf(req, q.branch_id), status: q.status, direction: q.direction as 'in' | 'out' | undefined,
      limit: limitQ(q.limit), cursor: q.cursor ?? null }));
  }
  @Post()
  async create(@Ctx() req: JwRequest, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    requiredKey(req);
    const b = parse(TransferIn, body);
    return idem(req, reply, 'POST /v1/inventory/transfers', '', b, 201, () => inv.createTransfer(actor(req), b));
  }
  @Get(':id')
  async get(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) reply: Reply) {
    return tagged(reply, await call(() => inv.getTransfer(actor(req), id)));
  }
  @Post(':id/approve') @HttpCode(200)
  async approve(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) reply: Reply) {
    const v = ver(req);
    return tagged(reply, await call(() => inv.approveTransfer(actor(req), id, v)));
  }
  @Post(':id/dispatch')
  async dispatch(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    requiredKey(req);
    const b = parse(z.object({ remarks: z.string().max(500).nullable().optional() }).strict(), body ?? {});
    const v = ver(req);
    return idem(req, reply, 'POST /v1/inventory/transfers/{id}/dispatch', id, { ...b, if_match: v }, 200, () => inv.dispatchTransfer(actor(req), id, b.remarks, v));
  }
  @Post(':id/receive')
  async receive(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    requiredKey(req);
    const b = parse(ReceiveIn, body);
    const v = ver(req);
    return idem(req, reply, 'POST /v1/inventory/transfers/{id}/receive', id, { ...b, if_match: v }, 200, () => inv.receiveTransfer(actor(req), id, b, v));
  }
  @Post(':id/return') @HttpCode(200)
  async ret(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    const b = parse(z.object({ reason }).strict(), body);
    const v = ver(req);
    return tagged(reply, await call(() => inv.returnTransfer(actor(req), id, b.reason, v)));
  }
  @Post(':id/cancel') @HttpCode(200)
  async cancel(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) reply: Reply) {
    const v = ver(req);
    return tagged(reply, await call(() => inv.cancelTransfer(actor(req), id, v)));
  }
}

// ---------- stock checks ----------
@Controller('v1/inventory/stock-checks')
export class InventoryStockChecksController {
  @Get()
  async list(@Ctx() req: JwRequest, @Query() q: Record<string, string | undefined>) {
    return call(() => inv.listStockChecks(actor(req), { branch_id: branchOf(req, q.branch_id), status: q.status, limit: limitQ(q.limit), cursor: q.cursor ?? null }));
  }
  /** 0.8.2: starting needs only inventory.stock_check.run (closing / cancelling need stock_check.close). */
  @Post()
  async start(@Ctx() req: JwRequest, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    requiredKey(req);
    const b = parse(z.object({ branch_id: uuid, counter_id: nUuid, tray_id: nUuid, notes: z.string().max(500).nullable().optional() }).strict(), body);
    return idem(req, reply, 'POST /v1/inventory/stock-checks', '', b, 201, () => inv.startStockCheck(actor(req), b));
  }
  @Get(':id')
  async get(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) reply: Reply) {
    return tagged(reply, await call(() => inv.getStockCheck(actor(req), id)));
  }
  @Post(':id/scans')
  async scan(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    const b = parse(z.object({ code: z.string().min(1).max(64) }).strict(), body);
    const r = await call(() => inv.recordScan(actor(req), id, b.code));
    reply.status(r.duplicate ? 200 : 201);
    return r;
  }
  @Delete(':id/scans/:scanId') @HttpCode(204)
  async undo(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Param('scanId', ParseUUIDPipe) scanId: string) {
    await call(() => inv.undoScan(actor(req), id, scanId));
  }
  @Get(':id/report')
  async report(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Query('result') result?: string) {
    const r = result === undefined ? undefined : parse(z.enum(['matched', 'missing', 'extra']), result);
    const items = await call(() => inv.stockCheckReport(actor(req), id, r));
    return { items, next_cursor: null, counts: await call(() => inv.stockCheckCounts(id)) };   // StockCheckReportPage (one page)
  }
  @Post(':id/close') @HttpCode(200)
  async close(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    const b = parse(z.object({ create_adjustments: z.boolean().optional(), notes: z.string().max(500).nullable().optional() }).strict(), body ?? {});
    const v = ver(req);
    return tagged(reply, await call(() => inv.closeStockCheck(actor(req), id, b, v)));
  }
  @Post(':id/cancel') @HttpCode(200)
  async cancel(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) reply: Reply) {
    const v = ver(req);
    return tagged(reply, await call(() => inv.cancelStockCheck(actor(req), id, v)));
  }
}

// ---------- adjustments ----------
const AdjIn = z.object({ branch_id: uuid, kind: z.enum(['weight_loss', 'weight_gain', 'piece_loss', 'piece_gain', 'write_off', 'full_write_off', 'correction']),
  tag_id: nUuid, item_id: nUuid, purity_id: nUuid, counter_id: nUuid, tray_id: nUuid, delta_pieces: z.number().int().optional(),
  delta_gross_wt: wt.optional(), delta_net_wt: wt.optional(), reason_code: z.enum(REASON_CODES), reason }).strict();

@Controller('v1/inventory/adjustments')
export class InventoryAdjustmentsController {
  @Get()
  async list(@Ctx() req: JwRequest, @Query() q: Record<string, string | undefined>) {
    return call(() => inv.listAdjustments(actor(req), { branch_id: branchOf(req, q.branch_id), status: q.status, tag_id: q.tag_id, limit: limitQ(q.limit),
      cursor: q.cursor ?? null }));
  }
  @Post()
  async request(@Ctx() req: JwRequest, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    requiredKey(req);
    const b = parse(AdjIn, body);
    return idem(req, reply, 'POST /v1/inventory/adjustments', '', b, 201, () => inv.requestAdjustment(actor(req), b as inv.AdjustmentInput));
  }
  @Get(':id')
  async get(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) reply: Reply) {
    return tagged(reply, await call(() => inv.getAdjustment(actor(req), id)));
  }
  @Post(':id/approve') @HttpCode(200)
  async approve(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    const b = parse(z.object({ note: z.string().trim().min(3).max(500).nullable().optional() }).strict(), body ?? {});
    const v = ver(req);
    return tagged(reply, await call(() => inv.approveAdjustment(actor(req), id, b.note, v)));
  }
  @Post(':id/reject') @HttpCode(200)
  async reject(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    const b = parse(z.object({ note: reason }).strict(), body);
    const v = ver(req);
    return tagged(reply, await call(() => inv.rejectAdjustment(actor(req), id, b.note, v)));
  }
  @Post(':id/cancel') @HttpCode(200)
  async cancel(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) reply: Reply) {
    const v = ver(req);
    return tagged(reply, await call(() => inv.cancelAdjustment(actor(req), id, v)));
  }
}

// ---------- 0.8.3: lots, tag history, photo list / edit, stock summary, moves list, draft transfer edit, scan list ----------
const ymdQ = (v?: string) => (v === undefined ? undefined : parse(z.string().regex(/^\d{4}-\d{2}-\d{2}$/), v));
const uuidQ = (v?: string) => (v === undefined ? undefined : parse(uuid, v));
const LotLineIn = z.object({ id: uuid.optional(), item_id: uuid, sub_item_id: nUuid, purity_id: nUuid, pieces: z.number().int().min(0),
  gross_wt: wt, stone_wt: wt.optional(), net_wt: wt, other_wt: wt.optional() }).strict();
const LotHead = { vendor_id: nUuid, ref_invoice_no: z.string().max(40).nullable().optional(), hallmark_centre: z.string().max(100).nullable().optional(),
  hallmark_ref: z.string().max(60).nullable().optional(), received_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() };
const LotIn = z.object({ branch_id: uuid, ...LotHead, lot_no: z.string().trim().min(1).max(30).optional(),
  entry_type: z.enum(['other', 'purchase', 'order_receipt', 'refinery']).optional(),
  lines: z.array(LotLineIn.omit({ id: true }).strict()).min(1).max(200) }).strict();
const LotPatchIn = z.object({ ...LotHead, lines: z.array(LotLineIn).min(1).max(200).optional() }).strict()
  .refine((o) => Object.keys(o).length > 0, { message: 'empty patch' });
const LotCloseIn = z.object({ remainder: z.enum(['none', 'to_loose']).optional(), counter_id: uuid.optional(), tray_id: uuid.optional() }).strict();
const PhotoPatchIn = z.object({ caption: z.string().max(200).nullable().optional(), is_primary: z.boolean().optional(), sort_order: z.number().int().min(0).optional() })
  .strict().refine((o) => Object.keys(o).length > 0, { message: 'empty patch' });
const TransferPatchIn = z.object({ remarks: z.string().max(500).nullable().optional(), lines: z.array(TransferLineIn).min(1).max(500).optional() }).strict()
  .refine((o) => Object.keys(o).length > 0, { message: 'empty patch' });

@Controller('v1/inventory/lots')
export class InventoryLotsController {
  @Get()
  async list(@Ctx() req: JwRequest, @Query() q: Record<string, string | string[] | undefined>) {
    const one = (k: string) => (Array.isArray(q[k]) ? (q[k] as string[])[0] : (q[k] as string | undefined));
    const ids = asList(q.ids);
    return call(() => inv.listLots(actor(req), { branch_id: branchOf(req, one('branch_id')), q: one('q'),
      ids: ids === undefined ? undefined : parse(z.array(uuid).min(1).max(100), ids),
      status: one('status') === undefined ? undefined : parse(z.enum(['open', 'tagged', 'closed']), one('status')),
      vendor_id: uuidQ(one('vendor_id')),
      entry_type: one('entry_type') === undefined ? undefined : parse(z.enum(['purchase', 'order_receipt', 'opening', 'refinery', 'transfer_in', 'other']), one('entry_type')),
      limit: limitQ(one('limit')), cursor: one('cursor') ?? null }));
  }
  @Post()
  async create(@Ctx() req: JwRequest, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    requiredKey(req);
    const b = parse(LotIn, body);
    return idem(req, reply, 'POST /v1/inventory/lots', '', b, 201, () => inv.createLot(actor(req), b));
  }
  @Get(':id')
  async get(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) reply: Reply) {
    return tagged(reply, await call(() => inv.getLot(actor(req), id)));
  }
  @Patch(':id')
  async patch(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    const b = parse(LotPatchIn, body);
    const v = ver(req);
    return tagged(reply, await call(() => inv.updateLot(actor(req), id, b, v)));
  }
  @Post(':id/close') @HttpCode(200)
  async close(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    const b = parse(LotCloseIn, body ?? {});
    const v = ver(req);
    return tagged(reply, await call(() => inv.closeLot(actor(req), id, b, v)));
  }
}

@Controller('v1/inventory')
export class InventoryViewsController {
  @Get('tags/:id/history')
  async history(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Query() q: Record<string, string | undefined>) {
    const limit = q.limit === undefined ? undefined : parse(z.coerce.number().int().min(1).max(100), q.limit);
    return call(() => inv.getTagHistory(actor(req), id, { limit, cursor: q.cursor ?? null }));
  }
  @Get('tags/:id/photos')
  async photos(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string) {
    return call(() => inv.listTagPhotos(actor(req), id));
  }
  @Patch('tags/:id/photos/:photoId')
  async patchPhoto(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Param('photoId', ParseUUIDPipe) photoId: string, @Body() body: unknown,
    @Res({ passthrough: true }) reply: Reply) {
    const b = parse(PhotoPatchIn, body);
    const v = ver(req);
    return tagged(reply, await call(() => inv.updateTagPhoto(actor(req), id, photoId, b, v)));
  }
  @Get('stock-summary')
  async summary(@Ctx() req: JwRequest, @Query() q: Record<string, string | undefined>) {
    const g = q.group_by === undefined ? undefined : parse(z.enum(['location', 'item', 'purity', 'status']), q.group_by);
    const loose = q.include_loose === undefined ? undefined : parse(z.enum(['true', 'false']), q.include_loose) === 'true';
    return call(() => inv.stockSummary(actor(req), { branch_id: branchOf(req, q.branch_id), group_by: g, include_loose: loose }));
  }
  @Get('moves')
  async moves(@Ctx() req: JwRequest, @Query() q: Record<string, string | undefined>) {
    return call(() => inv.listLocationMoves(actor(req), { branch_id: branchOf(req, q.branch_id), tag_id: uuidQ(q.tag_id), counter_id: uuidQ(q.counter_id),
      from: ymdQ(q.from), to: ymdQ(q.to), limit: limitQ(q.limit), cursor: q.cursor ?? null }));
  }
  @Patch('transfers/:id')
  async patchTransfer(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    const b = parse(TransferPatchIn, body);
    const v = ver(req);
    return tagged(reply, await call(() => inv.updateTransfer(actor(req), id, b, v)));
  }
  @Get('stock-checks/:id/scans')
  async scans(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Query() q: Record<string, string | undefined>) {
    return call(() => inv.listStockCheckScans(actor(req), id, { limit: limitQ(q.limit), cursor: q.cursor ?? null }));
  }
}
