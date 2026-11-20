import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { salesFixture, type SalesFx } from './sales-fixture';
import { HUID_PREFIX } from './huid';

/**
 * O9: deliver a repair and bill it through Sales as a service bill. Real HTTP stack (shared Sales fixture: billing-ready shop, approved
 * device), every response validated against contracts/openapi.yaml. Checks the service line (SAC, GST 5%), the money advance applied as
 * payment, the charges, the repair delivered and linked to its bill, and that every refusal leaves the repair, the advance and the bills alone.
 */
let fx: SalesFx;
let vendor = ''; let customer = ''; let polish = ''; let resize = '';
beforeAll(async () => {
  fx = await salesFixture('ordnine', HUID_PREFIX.orders);
  vendor = (await fx.sql<{ id: string }>(`INSERT INTO masters.vendor(tenant_id, code, name, kinds) VALUES ($1, 'V9', 'Repair Nine', ARRAY['repair_vendor']) RETURNING id`, [fx.tenantId]))[0].id;
  polish = (await fx.sql<{ id: string }>(`INSERT INTO masters.repair_type(tenant_id, name, sac, min_customer_charge, max_customer_charge) VALUES ($1, 'Polish', NULL, 100, 2000) RETURNING id`, [fx.tenantId]))[0].id;
  resize = (await fx.sql<{ id: string }>(`INSERT INTO masters.repair_type(tenant_id, name, sac, min_customer_charge, max_customer_charge) VALUES ($1, 'Resize', '998899', 100, 2000) RETURNING id`, [fx.tenantId]))[0].id;
  customer = await fx.customer({ name: 'Repair Buyer' });
}, 120000);
afterAll(async () => { if (fx) { writeFileSync('/tmp/orders-o9-contract.json', fx.rec.report()); await fx.close(); } });

interface Made { id: string; version: number; lines: string[] }
/** A repair that is READY: created (optional advance), every line issued to the vendor and received back. */
async function readyRepair(o: { lines: { type: string; charge?: string }[]; advance?: string }): Promise<Made> {
  const body: Record<string, unknown> = { branch_id: fx.B1, customer_id: customer,
    lines: o.lines.map((l, i) => ({ repair_type_id: l.type, gross_wt: `${5 + i}.000`, description: `piece ${i + 1}`, ...(l.charge ? { customer_charge: l.charge } : {}) })),
    ...(o.advance ? { advance: { amount: o.advance } } : {}) };
  let r = (await fx.go('POST', '/v1/repairs', { body, headers: fx.key(), status: 201 })).json();
  r = (await fx.go('GET', '/v1/repairs/{id}', { p: { id: r.id } })).json();
  const ids: string[] = r.lines.map((l: { id: string }) => l.id);
  for (const l of r.lines as { id: string; gross_wt: string }[]) {
    r = (await fx.go('POST', '/v1/repairs/{id}/lines/{lineId}/issue', { p: { id: r.id, lineId: l.id }, body: { vendor_id: vendor }, headers: fx.im(r.version) })).json();
    r = (await fx.go('POST', '/v1/repairs/{id}/lines/{lineId}/receive', { p: { id: r.id, lineId: l.id }, body: { received_wt: l.gross_wt }, headers: fx.im(r.version) })).json();
  }
  expect(r.status).toBe('ready');
  return { id: r.id, version: r.version, lines: ids };
}
const deliver = (m: Made, body: Record<string, unknown> = {}, o: { cookie?: string; status?: number | number[]; version?: number } = {}) =>
  fx.go('POST', '/v1/repairs/{id}/deliver', { p: { id: m.id }, body: { salesperson_id: fx.staff, ...body }, headers: fx.im(o.version ?? m.version), cookie: o.cookie, status: o.status ?? 200 });
const invoice = async (id: string) => (await fx.go('GET', '/v1/sales/invoices/{id}', { p: { id } })).json();
const advances = async (id: string) => (await fx.go('GET', '/v1/repairs/{id}', { p: { id } })).json().advances;
const bills = async (id: string) => Number((await fx.sql<{ n: string }>(`SELECT count(*)::text n FROM sales.invoice WHERE repair_id = $1`, [id]))[0].n);

describe('deliverRepair', () => {
  it('bills the charge as a service line with 5% GST, applies the money advance as payment, delivers the repair', async () => {
    const m = await readyRepair({ lines: [{ type: polish, charge: '800.00' }], advance: '1000' });
    const r = (await deliver(m)).json();
    expect(r.repair).toMatchObject({ status: 'delivered', delivered_invoice_id: r.invoice_id });
    const inv = await invoice(r.invoice_id);
    expect(inv.doc_no).toBe(r.invoice_no);
    expect(inv.lines).toHaveLength(1);
    expect(inv.lines[0]).toMatchObject({ taxable_value: '800.00', hsn: '998892' });
    expect(inv.totals).toMatchObject({ taxable_value: '800.00', cgst: '20.00', sgst: '20.00', igst: '0.00', invoice_total: '840.00', net_payable: '840.00', paid_amount: '840.00', balance_due: '0.00' });
    expect(inv.tax_summary).toEqual([expect.objectContaining({ hsn_sac: '998892', rate: '5.00', taxable_value: '800.00' })]);
    const adv = (await advances(m.id))[0];
    expect(inv.payments).toEqual([expect.objectContaining({ mode: 'advance', reference: adv.receipt_no, amount: '840.00' })]);
    expect(inv.payment_status).toBe('paid');
    expect(r.advances_applied).toEqual([{ advance_id: adv.id, amount: '840.00' }]);
    expect(adv).toMatchObject({ balance: '160.00', status: 'partly_redeemed' });
  });

  it('the repair bill prints through the Sales invoice print: ORIGINAL, frozen snapshot with the service line, SAC, GST 5% and the amount in words', async () => {
    const m = await readyRepair({ lines: [{ type: polish, charge: '800.00' }], advance: '1000' });
    const r = (await deliver(m)).json();
    const p = (await fx.go('POST', '/v1/sales/invoices/{id}/prints', { p: { id: r.invoice_id }, headers: fx.key(), body: {}, status: 200 })).json();
    expect(p).toMatchObject({ doc_type: 'invoice', doc_id: r.invoice_id, doc_no: r.invoice_no, copy: 'original', print_no: 1, doc_cancelled: false });
    expect(p.amount_in_words).toBeTruthy();
    expect(p.snapshot.lines).toHaveLength(1);
    expect(p.snapshot.lines[0]).toMatchObject({ kind: 'service', hsn: '998892', taxable_value: '800.00', tax_rate: expect.stringMatching(/^5(\.0+)?$/) });
    expect(p.snapshot.lines[0].tag_id).toBeNull();
    expect(p.snapshot.totals).toMatchObject({ taxable_value: '800.00', invoice_total: '840.00', net_payable: '840.00' });
    expect(p.snapshot.tax_summary).toEqual([expect.objectContaining({ hsn_sac: '998892', rate: '5.00', taxable_value: '800.00' })]);
    expect(p.snapshot.seller).toBeTruthy();
    // a second print is a DUPLICATE and needs a reason; the log keeps both
    const d = (await fx.go('POST', '/v1/sales/invoices/{id}/prints', { p: { id: r.invoice_id }, headers: fx.key(), body: { copy: 'duplicate', reprint_reason: 'customer lost the bill' }, status: 200 })).json();
    expect(d).toMatchObject({ copy: 'duplicate', print_no: 2, stamp: 'DUPLICATE' });
    expect(d.snapshot.lines[0]).toMatchObject({ kind: 'service', hsn: '998892' });
  });

  it('two lines: the repair type SAC is on its line; a charge sent here is saved; the rest is paid by payments; apply_advances false leaves the advance whole', async () => {
    const m = await readyRepair({ lines: [{ type: polish, charge: '300.00' }, { type: resize }], advance: '500' });
    const before = (await advances(m.id))[0];
    // the second line has no charge yet
    const miss = (await deliver(m, {}, { status: 422 })).json();
    expect(miss.errors[0].code).toBe('charge_required');
    const lineB = (await fx.go('GET', '/v1/repairs/{id}', { p: { id: m.id } })).json().lines.find((l: { repair_type_id: string }) => l.repair_type_id === resize);
    const r = (await deliver(m, { charges: [{ line_id: lineB.id, amount: '700.00' }], apply_advances: false, payments: [{ mode: 'upi', amount: '1050.00', reference: 'UPI9' }] })).json();
    expect(r.advances_applied).toEqual([]);
    expect(r.repair.lines.find((l: { id: string }) => l.id === lineB.id).customer_charge).toBe('700.00');
    const inv = await invoice(r.invoice_id);
    expect(inv.lines.map((l: { hsn: string }) => l.hsn).sort()).toEqual(['998892', '998899']);
    expect(inv.totals).toMatchObject({ taxable_value: '1000.00', cgst: '25.00', sgst: '25.00', invoice_total: '1050.00', paid_amount: '1050.00', balance_due: '0.00' });
    expect(inv.tax_summary).toHaveLength(2);
    expect((await advances(m.id))[0]).toMatchObject({ balance: before.balance, status: 'open' });
  });

  it('refusals change nothing: not ready, no charge, charge out of range, no device, unknown salesperson, version, permission, a second bill', async () => {
    // not ready (still at the shop)
    const fresh = (await fx.go('POST', '/v1/repairs', { body: { branch_id: fx.B1, customer_id: customer, lines: [{ repair_type_id: polish, gross_wt: '3.000', customer_charge: '200' }] }, headers: fx.key(), status: 201 })).json();
    expect((await deliver({ id: fresh.id, version: fresh.version, lines: [] }, {}, { status: 409 })).json().code).toBe('repair_not_ready');

    const m = await readyRepair({ lines: [{ type: polish, charge: '400.00' }], advance: '1000' });
    const before = (await advances(m.id))[0];
    const untouched = async () => {
      expect((await fx.go('GET', '/v1/repairs/{id}', { p: { id: m.id } })).json()).toMatchObject({ status: 'ready', version: m.version, delivered_invoice_id: null });
      expect((await advances(m.id))[0]).toMatchObject({ balance: before.balance, status: 'open' });
      expect(await bills(m.id)).toBe(0);
    };
    const v = m.version;
    await deliver(m, { charges: [{ line_id: m.lines[0], amount: '5000.00' }] }, { status: 422 });                                  // above the repair type maximum
    await deliver(m, { charges: [{ line_id: m.lines[0], amount: '10.00' }] }, { status: 422 });                                    // below the minimum
    await deliver(m, { charges: [{ line_id: '00000000-0000-0000-0000-00000000dead', amount: '400.00' }] }, { status: 422 });
    await deliver(m, {}, { cookie: fx.managerNoDevice, status: 403 });                                                              // device_not_approved
    await deliver(m, { salesperson_id: '00000000-0000-0000-0000-00000000dead' }, { status: 422 });
    await deliver(m, {}, { version: v + 3, status: 412 });
    await deliver(m, {}, { cookie: fx.cashier, status: 403 });                                                                      // cashier cannot deliver
    await fx.go('POST', '/v1/repairs/{id}/deliver', { p: { id: m.id }, body: { salesperson_id: fx.staff }, status: 428 });
    await fx.go('POST', '/v1/repairs/{id}/deliver', { p: { id: m.id }, body: { bogus: 1, salesperson_id: fx.staff }, headers: fx.im(v), status: 422 });
    await fx.go('POST', '/v1/repairs/{id}/deliver', { p: { id: m.id }, body: { salesperson_id: fx.staff, bill_discount: '10' }, headers: fx.im(v), status: 422 }); // no discounts on repairs
    await untouched();

    // delivered once; a second delivery is refused and no second bill appears
    const ok = (await deliver(m)).json();
    expect(await bills(m.id)).toBe(1);
    expect((await deliver(m, {}, { version: ok.repair.version, status: 409 })).json().code).toBe('repair_not_ready');
    expect(await bills(m.id)).toBe(1);
  });

  it('the Orders contract: deliverRepair returned a 2xx and nothing undocumented or invalid was seen', () => {
    const r = JSON.parse(fx.rec.report()) as { violations: unknown[]; undocumented: string[]; timestamps: string[] };
    expect(fx.rec.uncovered('/v1/repairs')).toEqual(expect.not.arrayContaining(['POST /v1/repairs/{id}/deliver']));
    expect(r.violations).toEqual([]);
    expect(r.undocumented).toEqual([]);
  });
});
