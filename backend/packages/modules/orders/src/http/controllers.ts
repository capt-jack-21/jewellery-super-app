import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import { Ctx, type JwRequest, Problem, etag, ifMatch, needKey, requestHash, withIdempotency } from '@jw/mod-platform';
import { z } from 'zod';
import { parse } from './parse';
import * as ord from '../service';
import { OrdersError } from '../internal/errors';

/**
 * HTTP layer of Orders (/v1/orders). Thin: parse (zod), If-Match / Idempotency-Key, call the service, map OrdersError → problem+json.
 * Permission and branch-scope checks live in the service (actor = the session AuthContext).
 */
type Reply = { status(n: number): unknown; header(k: string, v: string): unknown };
const actor = (req: JwRequest): ord.OrdersActor => {
  if (!req.auth) throw new Problem(401, 'unauthenticated');
  return req.auth;
};
async function call<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) {
    if (e instanceof OrdersError) {
      const code = e.status === 403 && e.code === 'forbidden' ? 'permission_denied' : e.code;
      throw new Problem(e.status, code, e.message, e.errors);
    }
    throw e;
  }
}
const tagged = <T extends { version: number }>(reply: Reply, v: T): T => { reply.header('ETag', etag(v.version)); return v; };
function requiredKey(req: JwRequest): string {
  const key = req.headers['idempotency-key'] as string | undefined;
  needKey(key); return key!;
}
async function idem(req: JwRequest, reply: Reply, scope: string, body: Record<string, unknown>, status: number, run: () => Promise<unknown>) {
  const key = requiredKey(req);
  return withIdempotency(reply, scope, key, requestHash('', body), async () => ({ status, body: await call(run) }));
}
const uuid = z.string().uuid();
const wt = z.string().regex(/^\d{1,7}(\.\d{1,3})?$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Line = z.object({
  id: uuid.optional(), item_id: uuid, purity_id: uuid.nullable().optional(), pieces: z.number().int().optional(),
  approx_wt: wt.nullable().optional(), size: z.string().nullable().optional(), gender: z.string().nullable().optional(),
  stones: z.array(z.object({ name: z.string(), pieces: z.number().int(), weight: wt.nullable().optional() }).strict()).optional(),
  design_notes: z.string().nullable().optional(), attachment_file_ids: z.array(uuid).optional(),
}).strict();
const OrderIn = z.object({
  branch_id: uuid, order_type: z.string().optional(), customer_id: uuid.nullable().optional(), priority: z.string().optional(),
  order_date: date.optional(), due_date: date.nullable().optional(), notes: z.string().nullable().optional(), lines: z.array(Line),
}).strict();
const OrderPatchIn = z.object({
  customer_id: uuid.nullable().optional(), priority: z.string().optional(), order_date: date.optional(), due_date: date.nullable().optional(),
  notes: z.string().nullable().optional(), lines: z.array(Line).optional(),
}).strict();
const AssignIn = z.object({ vendor_id: uuid, vendor_due: date, vendor_note: z.string().nullable().optional() }).strict();
const ReceiveIn = z.object({ gross_wt: wt, stone_wt: wt.optional(), net_wt: wt.optional(), huid: z.string().nullable().optional(), size: z.string().max(30).nullable().optional(),
  counter_id: uuid.nullable().optional(), tray_id: uuid.nullable().optional(), received_on: date.optional() }).strict();
const rate = z.string().regex(/^\d{1,9}(\.\d{1,2})?$/);
const AdvanceIn = z.object({ kind: z.enum(['amount', 'metal']), amount: z.string().regex(/^\d{1,10}(\.\d{1,2})?$/).optional(), purity_id: uuid.optional(), weight: wt.optional(),
  lock_rate_per_g: rate.nullable().optional(), purpose: z.string().max(200).nullable().optional(), received_on: date.optional() }).strict();
const DeliverIn = z.object({ salesperson_id: uuid, cash_counter_id: uuid.nullable().optional(), place_of_supply: z.string().regex(/^[0-9]{2}$/).nullable().optional(),
  bill_discount: z.string().regex(/^\d{1,10}(\.\d{1,2})?$/).optional(), discount_reason: z.string().min(3).max(200).nullable().optional(), pan: z.string().nullable().optional(),
  expected_total: z.string().regex(/^\d{1,12}(\.\d{1,2})?$/).nullable().optional(), payments: z.array(z.record(z.unknown())).max(10).optional(), apply_advances: z.boolean().optional() }).strict();
const PrintIn = z.object({ paper: z.enum(['A4', 'A5', 'thermal_80mm']).optional(), reprint_reason: z.string().nullable().optional() }).strict();
const money = z.string().regex(/^\d{1,10}(\.\d{1,2})?$/);
const RepairDeliverIn = DeliverIn.omit({ bill_discount: true, discount_reason: true }).extend({ charges: z.array(z.object({ line_id: uuid, amount: money }).strict()).max(50).optional() }).strict();
const RepairLine = z.object({ id: uuid.optional(), repair_type_id: uuid, description: z.string().nullable().optional(), gross_wt: wt, net_wt: wt.nullable().optional(),
  customer_charge: money.nullable().optional(), photo_file_ids: z.array(uuid).optional() }).strict();
const RepairIn = z.object({ branch_id: uuid, customer_id: uuid, received_on: date.optional(), due_date: date.nullable().optional(), notes: z.string().nullable().optional(),
  lines: z.array(RepairLine), advance: z.object({ amount: money, purpose: z.string().nullable().optional(), received_on: date.optional() }).strict().optional() }).strict();
const RepairPatchIn = z.object({ due_date: date.nullable().optional(), notes: z.string().nullable().optional(), lines: z.array(RepairLine).optional() }).strict();
const IssueIn = z.object({ vendor_id: uuid, vendor_charge: money.nullable().optional(), vendor_note: z.string().nullable().optional() }).strict();
const ReceiveBackIn = z.object({ received_wt: wt, vendor_charge: money.nullable().optional(), loss_override_reason: z.string().nullable().optional() }).strict();
const CancelIn = z.object({ reason: z.string() }).strict();
const SettingsPatch = z.object({ order_no_format: z.string(), repair_no_format: z.string(), default_due_days: z.number().int().nullable(),
  repair_loss_tolerance_pct: z.string(), advance_required: z.boolean(), rate_rule: z.enum(['locked', 'lower_of']) }).partial().strict();
const limitQ = (v?: string) => (v === undefined ? undefined : parse(z.coerce.number().int().min(1).max(200), v));
const uuidQ = (v?: string) => (v === undefined ? undefined : parse(uuid, v));
const one = (q: Record<string, string | string[] | undefined>, k: string) => (Array.isArray(q[k]) ? (q[k] as string[])[0] : (q[k] as string | undefined));
const branchOf = (req: JwRequest, q?: string): string | null => {
  const h = req.headers['x-branch-id'];
  const v = q ?? (Array.isArray(h) ? h[0] : h) ?? null;
  return v === null ? null : parse(uuid, v);
};

@Controller('v1/orders/due-summary')
export class OrdersDueController {
  @Get()
  async get(@Ctx() req: JwRequest, @Query() q: Record<string, string | string[] | undefined>) {
    return call(() => ord.dueSummary(actor(req), branchOf(req, one(q, 'branch_id'))));
  }
}

@Controller('v1/orders/settings')
export class OrdersSettingsController {
  @Get()
  async get(@Ctx() req: JwRequest, @Res({ passthrough: true }) reply: Reply) { return tagged(reply, await call(() => ord.getSettings(actor(req)))); }
  @Patch()
  async patch(@Ctx() req: JwRequest, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    const b = parse(SettingsPatch, body) as ord.OrdersSettingsPatch;
    return tagged(reply, await call(() => ord.patchSettings(actor(req), b, ifMatch(req, false))));
  }
}

@Controller('v1/orders')
export class OrdersController {
  @Get()
  async list(@Ctx() req: JwRequest, @Query() q: Record<string, string | string[] | undefined>) {
    const ov = one(q, 'overdue');
    return call(() => ord.listOrders(actor(req), {
      branch_id: branchOf(req, one(q, 'branch_id')), q: one(q, 'q'), status: one(q, 'status'), customer_id: uuidQ(one(q, 'customer_id')),
      priority: one(q, 'priority'), overdue: ov === undefined ? undefined : parse(z.enum(['true', 'false']), ov) === 'true',
      from: one(q, 'from'), to: one(q, 'to'), due_from: one(q, 'due_from'), due_to: one(q, 'due_to'), limit: limitQ(one(q, 'limit')), cursor: one(q, 'cursor') ?? null }));
  }
  @Post()
  async create(@Ctx() req: JwRequest, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    requiredKey(req);
    const b = parse(OrderIn, body) as ord.OrderInput;
    return idem(req, reply, 'POST /v1/orders', b as unknown as Record<string, unknown>, 201, () => ord.createOrder(actor(req), b));
  }
  @Get(':id')
  async get(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) reply: Reply) {
    return tagged(reply, await call(() => ord.getOrder(actor(req), id)));
  }
  @Patch(':id')
  async patch(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    const b = parse(OrderPatchIn, body) as ord.OrderPatch;
    const v = ifMatch(req, true)!;
    return tagged(reply, await call(() => ord.updateOrder(actor(req), id, b, v)));
  }
  @Post(':id/lines/:lineId/assign') @HttpCode(200)
  async assign(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Param('lineId', ParseUUIDPipe) lineId: string, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    const b = parse(AssignIn, body) as ord.AssignInput;
    const v = ifMatch(req, true)!;
    return tagged(reply, await call(() => ord.assignLine(actor(req), id, lineId, b, v)));
  }
  @Post(':id/lines/:lineId/unassign') @HttpCode(200)
  async unassign(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Param('lineId', ParseUUIDPipe) lineId: string, @Res({ passthrough: true }) reply: Reply) {
    const v = ifMatch(req, true)!;
    return tagged(reply, await call(() => ord.unassignLine(actor(req), id, lineId, v)));
  }
  @Post(':id/lines/:lineId/receive') @HttpCode(200)
  async receive(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Param('lineId', ParseUUIDPipe) lineId: string, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    const b = parse(ReceiveIn, body) as ord.ReceiveInput;
    const v = ifMatch(req, true)!;
    return tagged(reply, await call(() => ord.receiveLine(actor(req), id, lineId, b, v)));
  }
  @Get(':id/advances')
  async advances(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string) {
    return call(async () => ({ items: await ord.listAdvances(actor(req), id) }));
  }
  @Post(':id/advances')
  async takeAdvance(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    requiredKey(req);
    const b = parse(AdvanceIn, body) as ord.AdvanceIn;
    return idem(req, reply, `POST /v1/orders/${id}/advances`, b as unknown as Record<string, unknown>, 201, () => ord.takeAdvance(actor(req), id, b));
  }
  @Post(':id/deliver') @HttpCode(200)
  async deliver(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    const b = parse(DeliverIn, body) as ord.DeliverIn;
    const v = ifMatch(req, true)!;
    const r = await call(() => ord.deliverOrder(actor(req), id, b, v));
    reply.header('ETag', etag(r.order.version));
    return r;
  }
  @Post(':id/prints') @HttpCode(200)
  async printOrder(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    const b = parse(PrintIn, body ?? {}) as ord.PrintIn;
    return idem(req, reply, `POST /v1/orders/${id}/prints`, b as unknown as Record<string, unknown>, 200, () => ord.printOrderReceipt(actor(req), id, b));
  }
  @Post(':id/lines/:lineId/prints') @HttpCode(200)
  async printOrderVendorSlip(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Param('lineId', ParseUUIDPipe) lineId: string, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    const b = parse(PrintIn, body ?? {}) as ord.PrintIn;
    return idem(req, reply, `POST /v1/orders/${id}/lines/${lineId}/prints`, b as unknown as Record<string, unknown>, 200, () => ord.printOrderVendorSlip(actor(req), id, lineId, b));
  }
  @Post(':id/advances/:advanceId/prints') @HttpCode(200)
  async printOrderAdvance(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Param('advanceId', ParseUUIDPipe) advanceId: string, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    const b = parse(PrintIn, body ?? {}) as ord.PrintIn;
    return idem(req, reply, `POST /v1/orders/${id}/advances/${advanceId}/prints`, b as unknown as Record<string, unknown>, 200, () => ord.printAdvanceReceipt(actor(req), 'order', id, advanceId, b));
  }
  @Post(':id/cancel') @HttpCode(200)
  async cancel(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    const b = parse(CancelIn, body) as ord.CancelInput;
    const v = ifMatch(req, true)!;
    return tagged(reply, await call(() => ord.cancelOrder(actor(req), id, b, v)));
  }
}

@Controller('v1/repairs')
export class RepairsController {
  @Get()
  async list(@Ctx() req: JwRequest, @Query() q: Record<string, string | string[] | undefined>) {
    const ov = one(q, 'overdue');
    return call(() => ord.listRepairs(actor(req), {
      branch_id: branchOf(req, one(q, 'branch_id')), q: one(q, 'q'), status: one(q, 'status'), customer_id: uuidQ(one(q, 'customer_id')),
      overdue: ov === undefined ? undefined : parse(z.enum(['true', 'false']), ov) === 'true', from: one(q, 'from'), to: one(q, 'to'),
      due_from: one(q, 'due_from'), due_to: one(q, 'due_to'), limit: limitQ(one(q, 'limit')), cursor: one(q, 'cursor') ?? null }));
  }
  @Post()
  async create(@Ctx() req: JwRequest, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    requiredKey(req);
    const b = parse(RepairIn, body) as ord.RepairInput;
    return idem(req, reply, 'POST /v1/repairs', b as unknown as Record<string, unknown>, 201, () => ord.createRepair(actor(req), b));
  }
  @Get(':id')
  async get(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) reply: Reply) {
    return tagged(reply, await call(() => ord.getRepair(actor(req), id)));
  }
  @Post(':id/lines/:lineId/issue') @HttpCode(200)
  async issue(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Param('lineId', ParseUUIDPipe) lineId: string, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    const b = parse(IssueIn, body) as ord.IssueInput;
    const v = ifMatch(req, true)!;
    return tagged(reply, await call(() => ord.issueRepairLine(actor(req), id, lineId, b, v)));
  }
  @Post(':id/lines/:lineId/unissue') @HttpCode(200)
  async unissue(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Param('lineId', ParseUUIDPipe) lineId: string, @Res({ passthrough: true }) reply: Reply) {
    const v = ifMatch(req, true)!;
    return tagged(reply, await call(() => ord.unissueRepairLine(actor(req), id, lineId, v)));
  }
  @Post(':id/lines/:lineId/receive') @HttpCode(200)
  async receiveBack(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Param('lineId', ParseUUIDPipe) lineId: string, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    const b = parse(ReceiveBackIn, body) as ord.ReceiveBackInput;
    const v = ifMatch(req, true)!;
    return tagged(reply, await call(() => ord.receiveRepairLine(actor(req), id, lineId, b, v)));
  }
  @Post(':id/prints') @HttpCode(200)
  async printRepair(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    const b = parse(PrintIn, body ?? {}) as ord.PrintIn;
    return idem(req, reply, `POST /v1/repairs/${id}/prints`, b as unknown as Record<string, unknown>, 200, () => ord.printRepairReceipt(actor(req), id, b));
  }
  @Post(':id/lines/:lineId/prints') @HttpCode(200)
  async printRepairVendorSlip(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Param('lineId', ParseUUIDPipe) lineId: string, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    const b = parse(PrintIn, body ?? {}) as ord.PrintIn;
    return idem(req, reply, `POST /v1/repairs/${id}/lines/${lineId}/prints`, b as unknown as Record<string, unknown>, 200, () => ord.printRepairVendorSlip(actor(req), id, lineId, b));
  }
  @Post(':id/advances/:advanceId/prints') @HttpCode(200)
  async printRepairAdvance(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Param('advanceId', ParseUUIDPipe) advanceId: string, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    const b = parse(PrintIn, body ?? {}) as ord.PrintIn;
    return idem(req, reply, `POST /v1/repairs/${id}/advances/${advanceId}/prints`, b as unknown as Record<string, unknown>, 200, () => ord.printAdvanceReceipt(actor(req), 'repair', id, advanceId, b));
  }
  @Post(':id/deliver') @HttpCode(200)
  async deliver(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    const b = parse(RepairDeliverIn, body) as ord.RepairDeliverIn;
    const v = ifMatch(req, true)!;
    const r = await call(() => ord.deliverRepair(actor(req), id, b, v));
    reply.header('ETag', etag(r.repair.version));
    return r;
  }
  @Patch(':id')
  async patch(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    const b = parse(RepairPatchIn, body) as ord.RepairPatch;
    const v = ifMatch(req, true)!;
    return tagged(reply, await call(() => ord.updateRepair(actor(req), id, b, v)));
  }
}
