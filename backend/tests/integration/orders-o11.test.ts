import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { salesFixture, type SalesFx } from './sales-fixture';
import { HUID_PREFIX } from './huid';

/**
 * O11: prints of an order receipt, repair receipt, vendor issue slip and advance receipt. Real HTTP stack, every response validated
 * against contracts/openapi.yaml. Checks the render data, ORIGINAL then DUPLICATE (reason needed), the print log, idempotent retries.
 */
let fx: SalesFx;
let vendor = ''; let customer = ''; let rtype = '';
beforeAll(async () => {
  fx = await salesFixture('ordeleven', HUID_PREFIX.orders);
  vendor = (await fx.sql<{ id: string }>(`INSERT INTO masters.vendor(tenant_id, code, name, kinds) VALUES ($1, 'V11', 'Print Smith', ARRAY['smith','repair_vendor']) RETURNING id`, [fx.tenantId]))[0].id;
  rtype = (await fx.sql<{ id: string }>(`INSERT INTO masters.repair_type(tenant_id, name, sac, min_customer_charge, max_customer_charge) VALUES ($1, 'Clasp', NULL, 50, 2000) RETURNING id`, [fx.tenantId]))[0].id;
  customer = await fx.customer({ name: 'Print Buyer' });
}, 120000);
afterAll(async () => { if (fx) { writeFileSync('/tmp/orders-o11-contract.json', fx.rec.report()); await fx.close(); } });

const logged = async (docId: string) => Number((await fx.sql<{ n: string }>(`SELECT count(*)::text n FROM orders.document_print WHERE doc_id = $1`, [docId]))[0].n);
const post = (url: string, p: Record<string, string>, body: Record<string, unknown> = {}, o: { cookie?: string; status?: number | number[]; headers?: Record<string, string> } = {}) =>
  fx.go('POST', url, { p, body, headers: o.headers ?? fx.key(), cookie: o.cookie, status: o.status ?? 200 });

describe('order prints', () => {
  it('order receipt, vendor slip and advance receipt: original first, then duplicates with a reason; every print is logged', async () => {
    let ord = (await fx.go('POST', '/v1/orders', { body: { branch_id: fx.B1, customer_id: customer, due_date: '2099-01-31', lines: [
      { item_id: fx.ring, purity_id: fx.P22, pieces: 1, approx_wt: '10.000', design_notes: 'plain' }, { item_id: fx.ring, purity_id: fx.P22, pieces: 2, approx_wt: '4.000' }] }, headers: fx.key(), status: 201 })).json();
    const adv = (await fx.go('POST', '/v1/orders/{id}/advances', { p: { id: ord.id }, body: { kind: 'amount', amount: '5000', lock_rate_per_g: '5500' }, headers: fx.key(), status: 201 })).json();
    ord = (await fx.go('GET', '/v1/orders/{id}', { p: { id: ord.id } })).json();
    const [l1, l2] = ord.lines.map((l: { id: string }) => l.id);
    ord = (await fx.go('POST', '/v1/orders/{id}/lines/{lineId}/assign', { p: { id: ord.id, lineId: l1 }, body: { vendor_id: vendor, vendor_due: '2099-01-10' }, headers: fx.im(ord.version) })).json();

    const first = (await post('/v1/orders/{id}/prints', { id: ord.id })).json();
    expect(first).toMatchObject({ doc_type: 'order_receipt', doc_no: ord.order_no, copy: 'original', print_no: 1, paper: 'A4', reprint_reason: null });
    expect(first.shop.code).toBe(fx.branchCode);
    expect(first.customer).toMatchObject({ name: 'Print Buyer' });
    expect(first.document.lines).toHaveLength(2);
    expect(first.document.rate_locked_per_g).toBe('5500.00');
    expect(first.document.advances).toEqual([expect.objectContaining({ receipt_no: adv.receipt_no, amount: '5000.00' })]);
    // second print: a reason is needed
    const noReason = (await post('/v1/orders/{id}/prints', { id: ord.id }, {}, { status: 422 })).json();
    expect(noReason.errors[0].code).toBe('reprint_reason_required');
    await post('/v1/orders/{id}/prints', { id: ord.id }, { reprint_reason: 'ab' }, { status: 422 });
    const dup = (await post('/v1/orders/{id}/prints', { id: ord.id }, { paper: 'A5', reprint_reason: 'customer lost the slip' })).json();
    expect(dup).toMatchObject({ copy: 'duplicate', print_no: 2, paper: 'A5', reprint_reason: 'customer lost the slip' });
    await post('/v1/orders/{id}/prints', { id: ord.id }, { paper: 'thermal_80mm', reprint_reason: 'counter slip' });
    expect(await logged(ord.id)).toBe(3);
    await post('/v1/orders/{id}/prints', { id: ord.id }, { paper: 'B5' }, { status: 422 });
    await post('/v1/orders/{id}/prints', { id: ord.id }, { bogus: 1 }, { status: 422 });
    expect(await logged(ord.id)).toBe(3);

    // vendor slip: only for a line that is with a vendor
    const slip = (await post('/v1/orders/{id}/lines/{lineId}/prints', { id: ord.id, lineId: l1 })).json();
    expect(slip).toMatchObject({ doc_type: 'order_vendor_slip', copy: 'original', print_no: 1 });
    expect(slip.vendor).toMatchObject({ code: 'V11', name: 'Print Smith' });
    expect(slip.document.due_date).toBe('2099-01-10');
    expect((await post('/v1/orders/{id}/lines/{lineId}/prints', { id: ord.id, lineId: l2 }, {}, { status: 409 })).json().code).toBe('line_not_assigned');
    await post('/v1/orders/{id}/lines/{lineId}/prints', { id: ord.id, lineId: '00000000-0000-0000-0000-00000000dead' }, {}, { status: 404 });
    // the slip of line 1 has its own count, apart from the receipt
    expect((await post('/v1/orders/{id}/lines/{lineId}/prints', { id: ord.id, lineId: l1 }, { reprint_reason: 'vendor asked again' })).json().print_no).toBe(2);

    const rc = (await post('/v1/orders/{id}/advances/{advanceId}/prints', { id: ord.id, advanceId: adv.id })).json();
    expect(rc).toMatchObject({ doc_type: 'advance_receipt', doc_no: adv.receipt_no, copy: 'original' });
    expect(rc.document).toMatchObject({ for: 'order', for_no: ord.order_no, amount: '5000.00', kind: 'amount' });
    await post('/v1/orders/{id}/advances/{advanceId}/prints', { id: ord.id, advanceId: '00000000-0000-0000-0000-00000000dead' }, {}, { status: 404 });

    // idempotent retry: same key, same answer, logged once
    const h = fx.key();
    const a = (await post('/v1/orders/{id}/prints', { id: ord.id }, { reprint_reason: 'retry test' }, { headers: h })).json();
    const b = (await post('/v1/orders/{id}/prints', { id: ord.id }, { reprint_reason: 'retry test' }, { headers: h })).json();
    expect(b.print_no).toBe(a.print_no);
    expect(await logged(ord.id)).toBe(6);                                                                                   // receipt x4 + the line-1 slip x2
    await fx.go('POST', '/v1/orders/{id}/prints', { p: { id: ord.id }, body: {}, status: 400 });                         // no Idempotency-Key
    await post('/v1/orders/{id}/prints', { id: ord.id }, {}, { cookie: 'sid=nope', status: 401 });
    // a cashier can view orders, so can print; the print is logged against the caller
    expect((await post('/v1/orders/{id}/prints', { id: ord.id }, { reprint_reason: 'cashier copy' }, { cookie: fx.cashier })).json().printed_by).toBe(fx.cashierId);
  });
});

describe('repair prints', () => {
  it('repair receipt, vendor slip (only once issued) and advance receipt', async () => {
    let r = (await fx.go('POST', '/v1/repairs', { body: { branch_id: fx.B1, customer_id: customer, due_date: '2099-02-01', advance: { amount: '300' },
      lines: [{ repair_type_id: rtype, gross_wt: '4.000', description: 'broken clasp', customer_charge: '250' }] }, headers: fx.key(), status: 201 })).json();
    r = (await fx.go('GET', '/v1/repairs/{id}', { p: { id: r.id } })).json();
    const line = r.lines[0].id; const adv = r.advances[0];
    const rc = (await post('/v1/repairs/{id}/prints', { id: r.id })).json();
    expect(rc).toMatchObject({ doc_type: 'repair_receipt', doc_no: r.repair_no, copy: 'original', print_no: 1 });
    expect(rc.document.lines).toEqual([expect.objectContaining({ repair_type: 'Clasp', gross_wt: '4.000', estimate: '250.00', description: 'broken clasp' })]);
    expect(rc.document.advances).toEqual([expect.objectContaining({ receipt_no: adv.receipt_no, amount: '300.00' })]);
    expect((await post('/v1/repairs/{id}/prints', { id: r.id }, {}, { status: 422 })).json().errors[0].code).toBe('reprint_reason_required');
    expect((await post('/v1/repairs/{id}/prints', { id: r.id }, { reprint_reason: 'second copy for the shelf' })).json()).toMatchObject({ copy: 'duplicate', print_no: 2 });

    expect((await post('/v1/repairs/{id}/lines/{lineId}/prints', { id: r.id, lineId: line }, {}, { status: 409 })).json().code).toBe('line_not_issued');
    r = (await fx.go('POST', '/v1/repairs/{id}/lines/{lineId}/issue', { p: { id: r.id, lineId: line }, body: { vendor_id: vendor, vendor_note: 'weld it' }, headers: fx.im(r.version) })).json();
    const slip = (await post('/v1/repairs/{id}/lines/{lineId}/prints', { id: r.id, lineId: line }, { paper: 'thermal_80mm' })).json();
    expect(slip).toMatchObject({ doc_type: 'repair_vendor_slip', copy: 'original', paper: 'thermal_80mm' });
    expect(slip.vendor.code).toBe('V11');
    expect(slip.document).toMatchObject({ repair_no: r.repair_no, vendor_note: 'weld it', line: expect.objectContaining({ gross_wt: '4.000' }) });

    const ar = (await post('/v1/repairs/{id}/advances/{advanceId}/prints', { id: r.id, advanceId: adv.id })).json();
    expect(ar).toMatchObject({ doc_type: 'advance_receipt', doc_no: adv.receipt_no });
    expect(ar.document).toMatchObject({ for: 'repair', for_no: r.repair_no, amount: '300.00' });
    await post('/v1/repairs/{id}/advances/{advanceId}/prints', { id: r.id, advanceId: '00000000-0000-0000-0000-00000000dead' }, {}, { status: 404 });
    expect(await logged(r.id)).toBe(3);                                                                                          // receipt twice + the slip
  });

  it('the Orders contract: every print returned a 2xx and nothing undocumented or invalid was seen', () => {
    const r = JSON.parse(fx.rec.report()) as { violations: unknown[]; undocumented: string[] };
    expect(fx.rec.uncovered('/v1/orders').filter((op) => op.includes('/prints'))).toEqual([]);
    expect(fx.rec.uncovered('/v1/repairs').filter((op) => op.includes('/prints'))).toEqual([]);
    expect(r.violations).toEqual([]);
    expect(r.undocumented).toEqual([]);
  });
});
