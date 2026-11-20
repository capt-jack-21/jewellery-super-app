import { Body, Controller, Get, HttpCode, HttpException, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res } from '@nestjs/common';
import { Ctx, type JwRequest, Problem, etag, ifMatch, needKey, requestHash, todayIST, withIdempotency } from '@jw/mod-platform';
import * as sales from '@jw/mod-sales';
import { InventoryError } from '@jw/mod-inventory';

/**
 * HTTP layer of Sales (contract 0.9.2, /v1/sales/*). Thin: If-Match / Idempotency-Key, call the framework-free service, map SalesError →
 * problem+json (extra members such as existing_customer / setting_key are spread into the body). Permission, branch scope, device and
 * validation live in the service. doc_date / numbers are server-assigned; the request transaction is the unit of work (all or nothing).
 */
type Reply = { status(n: number): unknown; header(k: string, v: string): unknown };
const TITLES: Record<number, string> = { 400: 'Bad Request', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 412: 'Precondition Failed', 422: 'Unprocessable Entity', 428: 'Precondition Required', 500: 'Internal Server Error' };
const actor = (req: JwRequest): sales.SalesActor => {
  if (!req.auth) throw new Problem(401, 'unauthenticated');
  return req.auth;
};
async function call<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) {
    // stock checks raised by Inventory inside the sale (tag_sold, insufficient_loose_stock, huid_missing, …) keep their code and status
    if (e instanceof InventoryError) throw new HttpException({ type: 'about:blank', title: TITLES[e.status] ?? 'Error', status: e.status, code: e.code, detail: e.message,
      ...(e.errors ? { errors: e.errors } : {}) }, e.status);
    if (e instanceof sales.SalesError) {
      const code = e.status === 403 && e.code === 'forbidden' ? 'permission_denied' : e.code;
      throw new HttpException({ type: 'about:blank', title: TITLES[e.status] ?? 'Error', status: e.status, code, detail: e.message,
        ...(e.errors ? { errors: e.errors } : {}), ...(e.extra ?? {}) }, e.status);
    }
    throw e;
  }
}
const day = async (): Promise<string> => todayIST();
const ver = (req: JwRequest, required: boolean): number | undefined => { const v = ifMatch(req, required); return v === null ? undefined : v; };
/** Idempotent POST: first run → `status`; same key + same body → the stored body with 200 (contract "idempotent replay"). */
async function idem(req: JwRequest, reply: Reply, scope: string, id: string, body: unknown, status: number, run: () => Promise<unknown>) {
  const key = req.headers['idempotency-key'] as string | undefined;
  needKey(key);
  // Replays must pass CURRENT permissions and branch scope, not just know a tenant's idempotency key.
  await call(() => sales.authorizeIdempotent(actor(req), scope, id, body));
  let ran = false;
  const out = await withIdempotency(reply, scope, key!, requestHash(id, (body && typeof body === 'object' ? body : {}) as Record<string, unknown>),
    async () => { ran = true; return { status, body: await call(run) }; });
  if (!ran && status === 201) reply.status(200);
  return out;
}
const q1 = (v: unknown): string | undefined => (Array.isArray(v) ? v[0] : (v as string | undefined));
const branchQ = (req: JwRequest, q?: string): string => {
  const v = q ?? q1(req.headers['x-branch-id']);
  if (!v) throw new HttpException({ type: 'about:blank', title: 'Unprocessable Entity', status: 422, code: 'validation_failed', detail: 'branch_id is required',
    errors: [{ path: 'branch_id', code: 'required', message: 'required' }] }, 422);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v))
    throw new HttpException({ type: 'about:blank', title: 'Unprocessable Entity', status: 422, code: 'validation_failed', detail: 'branch_id must be a uuid',
      errors: [{ path: 'branch_id', code: 'invalid', message: 'uuid' }] }, 422);
  return v;
};

@Controller('v1/sales')
export class SalesSetupController {
  @Get('readiness')
  async readiness(@Ctx() req: JwRequest, @Query('branch_id') b?: string) { return call(async () => sales.readiness(actor(req), branchQ(req, b), await day())); }
  @Get('settings')
  async settings(@Ctx() req: JwRequest, @Res({ passthrough: true }) reply: Reply) {
    const a = actor(req);
    if (![...a.permissions].some((p) => ['sales.invoice.view', 'sales.estimate.create', 'sales.settings.edit'].includes(p))) throw new Problem(403, 'permission_denied', 'needs sales.invoice.view');
    const s = await call(async () => sales.getSettings(await day()));
    reply.header('ETag', etag((s.version as number | null) ?? 0));
    return s;
  }
  @Patch('settings')
  async patchSettings(@Ctx() req: JwRequest, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    const a = actor(req);
    if (!a.permissions.has('sales.settings.edit')) throw new Problem(403, 'permission_denied', 'needs sales.settings.edit');
    const s = await call(async () => sales.patchSettings(a, body, ver(req, true), await day()));
    reply.header('ETag', etag((s.version as number | null) ?? 0));
    return s;
  }
  @Get('doc-series')
  docSeries(@Ctx() req: JwRequest, @Query('branch_id') branch_id?: string, @Query('fy') fy?: string) { return call(() => sales.docSeries(actor(req), { branch_id, fy })); }
  @Get('sellable/:code')
  async sellable(@Ctx() req: JwRequest, @Param('code') code: string, @Query('branch_id') b?: string) {
    return call(async () => sales.sellable(actor(req), code, branchQ(req, b), await day()));
  }
  @Post('preview') @HttpCode(200)
  async preview(@Ctx() req: JwRequest, @Body() body: unknown) { return call(async () => sales.preview(actor(req), body, await day())); }
}

@Controller('v1/sales/invoices')
export class SalesInvoicesController {
  @Post()
  async issue(@Ctx() req: JwRequest, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    return idem(req, reply, 'POST /v1/sales/invoices', '', body, 201, async () => sales.invoiceView((await sales.issueInvoice(actor(req), body, await day())).id));
  }
  @Get()
  list(@Ctx() req: JwRequest, @Query() q: Record<string, string>) { return call(() => sales.listInvoices(actor(req), q)); }
  @Get(':id')
  get(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string) { return call(() => sales.getInvoice(actor(req), id)); }
  @Post(':id/payments')
  async pay(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    return idem(req, reply, 'POST /v1/sales/invoices/{id}/payments', id, body, 201, async () => sales.receiptView(await sales.receivePayment(actor(req), id, body)));
  }
  @Post(':id/payments/:receipt_id/prints') @HttpCode(200)
  async printReceipt(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Param('receipt_id', ParseUUIDPipe) rid: string,
    @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    return idem(req, reply, 'POST /v1/sales/invoices/{id}/payments/{receipt_id}/prints', `${id}/${rid}`, body ?? {}, 200,
      async () => sales.printDoc(actor(req), 'payment_receipt', rid, body ?? {}, await day()));
  }
  @Get(':id/payments')
  payments(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string) { return call(() => sales.invoicePayments(actor(req), id)); }
  @Post(':id/payments/:receipt_id/reversal')
  async reverse(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Param('receipt_id', ParseUUIDPipe) rid: string, @Body() body: unknown,
    @Res({ passthrough: true }) reply: Reply) {
    return idem(req, reply, 'POST /v1/sales/invoices/{id}/payments/{receipt_id}/reversal', `${id}/${rid}`, body, 201, async () => sales.reversalView(await sales.reverseReceipt(actor(req), id, rid, body)));
  }
  @Post(':id/cancellation')
  async cancel(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    return idem(req, reply, 'POST /v1/sales/invoices/{id}/cancellation', id, body, 201, async () => sales.creditNoteView(await sales.cancelInvoice(actor(req), id, body)));
  }
  @Post(':id/returns')
  async ret(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    return idem(req, reply, 'POST /v1/sales/invoices/{id}/returns', id, body, 201, async () => sales.creditNoteView(await sales.returnLines(actor(req), id, body, await day())));
  }
  @Post(':id/prints')
  async print(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    return idem(req, reply, 'POST /v1/sales/invoices/{id}/prints', id, body ?? {}, 200, async () => sales.printDoc(actor(req), 'invoice', id, body ?? {}, await day()));
  }
  @Get(':id/prints')
  prints(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string) { return call(() => sales.printLog(actor(req), 'invoice', id)); }
}

@Controller('v1/sales/estimates')
export class SalesEstimatesController {
  @Post()
  async create(@Ctx() req: JwRequest, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    const out = await idem(req, reply, 'POST /v1/sales/estimates', '', body, 201, async () => {
      const id = await sales.createEstimate(actor(req), body, await day());
      return sales.estimateView(actor(req), id, await day(), false);
    }) as { version: number };
    reply.header('ETag', etag(out.version));
    return out;
  }
  @Get()
  list(@Ctx() req: JwRequest, @Query() q: Record<string, string>) { return call(() => sales.listEstimates(actor(req), q)); }
  @Get(':id')
  async get(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) reply: Reply) {
    const e = await call(async () => sales.getEstimate(actor(req), id, await day()));
    reply.header('ETag', etag(e.version));
    return e;
  }
  @Put(':id')
  async put(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    const v = ver(req, true);
    const e = await call(async () => { await sales.replaceEstimate(actor(req), id, body, v, await day()); return sales.estimateView(actor(req), id, await day(), false); });
    reply.header('ETag', etag(e.version));
    return e;
  }
  @Post(':id/cancel') @HttpCode(200)
  async cancel(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) reply: Reply) {
    const v = ver(req, true);
    const e = await call(async () => { await sales.cancelEstimate(actor(req), id, v); return sales.estimateView(actor(req), id, await day(), false); });
    reply.header('ETag', etag(e.version));
    return e;
  }
  @Post(':id/prints')
  async print(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    return idem(req, reply, 'POST /v1/sales/estimates/{id}/prints', id, body ?? {}, 200, async () => sales.printDoc(actor(req), 'estimate', id, body ?? {}, await day()));
  }
}

@Controller('v1/sales/credit-notes')
export class SalesCreditNotesController {
  @Get()
  list(@Ctx() req: JwRequest, @Query() q: Record<string, string>) { return call(() => sales.listCreditNotes(actor(req), q)); }
  @Get(':id')
  get(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string) { return call(() => sales.getCreditNote(actor(req), id)); }
  @Post(':id/prints')
  async print(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    return idem(req, reply, 'POST /v1/sales/credit-notes/{id}/prints', id, body ?? {}, 200, async () => sales.printDoc(actor(req), 'credit_note', id, body ?? {}, await day()));
  }
}
