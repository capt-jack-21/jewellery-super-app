import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { salesFixture, type SalesFx } from './sales-fixture';
import { huidGen, HUID_PREFIX } from './huid';

/**
 * O6: deliver an order and bill it through Sales. Real HTTP stack (the shared Sales fixture: billing-ready shop, rates 22K sale 6000.00, an
 * approved counter device), every response validated against contracts/openapi.yaml. Checks the locked rate and the rate rule, the money
 * advance applied as payment, reserved tags sold, the order delivered, and that every refusal leaves the order, the stock and the advance alone.
 */
let fx: SalesFx;
const huid = huidGen(HUID_PREFIX.orders);
let vendor = ''; let customer = '';
beforeAll(async () => {
  fx = await salesFixture('ordsix', HUID_PREFIX.orders);
  vendor = (await fx.sql<{ id: string }>(`INSERT INTO masters.vendor(tenant_id, code, name, kinds) VALUES ($1, 'V6', 'Smith Six', ARRAY['smith']) RETURNING id`, [fx.tenantId]))[0].id;
  customer = await fx.customer({ name: 'Order Buyer' });
}, 120000);
afterAll(async () => { if (fx) { writeFileSync('/tmp/orders-o6-contract.json', fx.rec.report()); await fx.close(); } });

interface Made { id: string; version: number; tag_id: string; line_id: string }
/** An order that is READY: created, optionally an advance (and rate lock), assigned, received (piece tagged and reserved). */
async function readyOrder(o: { purity?: string; advance?: Record<string, unknown>; advance2?: Record<string, unknown> } = {}): Promise<Made> {
  const body = { branch_id: fx.B1, customer_id: customer, lines: [{ item_id: fx.ring, purity_id: o.purity ?? fx.P22, pieces: 1, approx_wt: '10.000' }] };
  let ord = (await fx.go('POST', '/v1/orders', { body, headers: fx.key(), status: 201 })).json();
  for (const adv of [o.advance, o.advance2]) if (adv) await fx.go('POST', '/v1/orders/{id}/advances', { p: { id: ord.id }, body: adv, headers: fx.key(), status: 201 });
  ord = (await fx.go('GET', '/v1/orders/{id}', { p: { id: ord.id } })).json();
  const l = ord.lines[0].id;
  ord = (await fx.go('POST', '/v1/orders/{id}/lines/{lineId}/assign', { p: { id: ord.id, lineId: l }, body: { vendor_id: vendor, vendor_due: '2099-01-01' }, headers: fx.im(ord.version) })).json();
  ord = (await fx.go('POST', '/v1/orders/{id}/lines/{lineId}/receive', { p: { id: ord.id, lineId: l }, body: { gross_wt: '10.000', huid: huid() }, headers: fx.im(ord.version) })).json();
  expect(ord.status).toBe('ready');
  return { id: ord.id, version: ord.version, tag_id: ord.lines[0].received_tag_id, line_id: l };
}
const deliver = (m: Made, body: Record<string, unknown> = {}, o: { cookie?: string; status?: number | number[]; version?: number } = {}) =>
  fx.go('POST', '/v1/orders/{id}/deliver', { p: { id: m.id }, body: { salesperson_id: fx.staff, ...body }, headers: fx.im(o.version ?? m.version), cookie: o.cookie, status: o.status ?? 200 });
const invoice = async (id: string) => (await fx.go('GET', '/v1/sales/invoices/{id}', { p: { id } })).json();
const tagStatus = async (id: string) => (await fx.sql<{ status: string }>(`SELECT status FROM inventory.tag WHERE id = $1`, [id]))[0].status;
const advances = async (orderId: string) => (await fx.go('GET', '/v1/orders/{id}/advances', { p: { id: orderId } })).json().items;

describe('deliverOrder', () => {
  it('bills at the locked rate, applies the money advance as payment, sells the reserved piece, delivers the order', async () => {
    const m = await readyOrder({ advance: { kind: 'amount', amount: '100000', lock_rate_per_g: '5500' } });
    expect(await tagStatus(m.tag_id)).toBe('reserved');
    const r = (await deliver(m)).json();
    expect(r.order).toMatchObject({ status: 'delivered', rate_locked_per_g: '5500.00' });
    expect(r.order.lines[0].status).toBe('delivered');
    const inv = await invoice(r.invoice_id);
    expect(inv.doc_no).toBe(r.invoice_no);
    expect(inv.lines).toHaveLength(1);
    expect(inv.lines[0]).toMatchObject({ rate_per_g: '5500.00', tag_id: m.tag_id });
    const adv = (await advances(m.id))[0];
    expect(inv.payments).toEqual([expect.objectContaining({ mode: 'advance', reference: adv.receipt_no, amount: inv.totals.net_payable })]);
    expect(inv.totals).toMatchObject({ paid_amount: inv.totals.net_payable, balance_due: '0.00' });
    expect(inv.payment_status).toBe('paid');
    expect(r.advances_applied).toEqual([{ advance_id: adv.id, amount: inv.totals.net_payable }]);
    // the advance keeps what the bill did not need
    expect(Number(adv.balance)).toBeCloseTo(100000 - Number(inv.totals.net_payable), 2);
    expect(adv.status).toBe('partly_redeemed');
    expect(await tagStatus(m.tag_id)).toBe('sold');
    const [row] = await fx.sql<{ order_id: string }>(`SELECT order_id FROM sales.invoice WHERE id = $1`, [r.invoice_id]);
    expect(row.order_id).toBe(m.id);
    const [snap] = await fx.sql<{ o: Record<string, unknown> }>(`SELECT rate_snapshot->'order' AS o FROM sales.invoice WHERE id = $1`, [r.invoice_id]);
    expect(snap.o).toMatchObject({ order_id: m.id, rule: 'locked', locked_rate_per_g: '5500.00' });
    // delivered once only
    await deliver(m, {}, { version: r.order.version, status: 409 });
  });

  it('a small advance is used up and the rest stays due on the bill; apply_advances false leaves the advance alone', async () => {
    const m = await readyOrder({ advance: { kind: 'amount', amount: '1000' } });
    const r = (await deliver(m)).json();
    const inv = await invoice(r.invoice_id);
    expect(inv.payments).toEqual([expect.objectContaining({ mode: 'advance', amount: '1000.00' })]);
    expect(inv.totals.balance_due).toBe((Number(inv.totals.net_payable) - 1000).toFixed(2));
    expect(inv.payment_status).toBe('part_paid');
    expect((await advances(m.id))[0]).toMatchObject({ balance: '0.00', status: 'redeemed' });

    const m2 = await readyOrder({ advance: { kind: 'amount', amount: '1000' } });
    const r2 = (await deliver(m2, { apply_advances: false })).json();
    expect(r2.advances_applied).toEqual([]);
    expect((await invoice(r2.invoice_id)).payments).toEqual([]);
    expect((await advances(m2.id))[0]).toMatchObject({ balance: '1000.00', status: 'open' });
  });

  it('rate rule: locked always uses the locked rate; lower_of never charges more than today', async () => {
    const hi = await readyOrder({ advance: { kind: 'amount', amount: '1000', lock_rate_per_g: '7000' } });
    const lo = await readyOrder({ advance: { kind: 'amount', amount: '1000', lock_rate_per_g: '5000' } });
    const none = await readyOrder();
    expect((await invoice((await deliver(hi)).json().invoice_id)).lines[0].rate_per_g).toBe('7000.00');      // rule locked (default)
    expect((await fx.go('GET', '/v1/orders/settings', { cookie: fx.owner })).json().rate_rule).toBe('locked');
    const cur = await fx.go('GET', '/v1/orders/settings');
    await fx.go('PATCH', '/v1/orders/settings', { body: { rate_rule: 'lower_of' }, headers: cur.json().version === 0 ? {} : fx.im(cur.json().version) });
    const hi2 = await readyOrder({ advance: { kind: 'amount', amount: '1000', lock_rate_per_g: '7000' } });
    const r1 = (await deliver(hi2)).json();
    expect((await invoice(r1.invoice_id)).lines[0].rate_per_g).toBe('6000.00');                                // today's 6000 is lower than the locked 7000
    const r2 = (await deliver(lo)).json();
    expect((await invoice(r2.invoice_id)).lines[0].rate_per_g).toBe('5000.00');                                // locked 5000 is lower than today's 6000
    const [s1] = await fx.sql<{ o: Record<string, unknown> }>(`SELECT rate_snapshot->'order' AS o FROM sales.invoice WHERE id = $1`, [r1.invoice_id]);
    expect(s1.o).toMatchObject({ rule: 'lower_of', locked_rate_per_g: '7000.00', applied: [{ purity_code: '22K', today_rate_per_g: '6000.00', rate_per_g: '6000.00' }] });
    expect((await invoice((await deliver(none)).json().invoice_id)).lines[0].rate_per_g).toBe('6000.00');      // no lock: today's rate
    const cur2 = await fx.go('GET', '/v1/orders/settings');
    await fx.go('PATCH', '/v1/orders/settings', { body: { rate_rule: 'locked' }, headers: fx.im(cur2.json().version) });
  });

  it('refusals change nothing: not ready, mixed purities with a locked rate, no device, unknown salesperson, version, permission', async () => {
    // not ready (still in production)
    const o = (await fx.go('POST', '/v1/orders', { body: { branch_id: fx.B1, customer_id: customer, lines: [{ item_id: fx.ring, pieces: 1 }] }, headers: fx.key(), status: 201 })).json();
    expect((await deliver({ id: o.id, version: o.version, tag_id: '', line_id: '' }, {}, { status: 409 })).json().code).toBe('order_not_ready');

    const m = await readyOrder({ advance: { kind: 'amount', amount: '5000', lock_rate_per_g: '5500' } });
    const before = (await advances(m.id))[0];
    const untouched = async () => {
      expect(await tagStatus(m.tag_id)).toBe('reserved');
      expect((await fx.go('GET', '/v1/orders/{id}', { p: { id: m.id } })).json()).toMatchObject({ status: 'ready', version: m.version });
      expect((await advances(m.id))[0]).toMatchObject({ balance: before.balance, status: 'open' });
      expect(Number((await fx.sql<{ n: string }>(`SELECT count(*)::text n FROM sales.invoice WHERE order_id = $1`, [m.id]))[0].n)).toBe(0);
    };
    const v = m.version;
    await deliver(m, {}, { version: v, cookie: fx.managerNoDevice, status: 403 });                                              // device_not_approved
    await deliver(m, { salesperson_id: '00000000-0000-0000-0000-00000000dead' }, { version: v, status: 422 });
    await deliver(m, {}, { version: v + 3, status: 412 });
    await deliver(m, {}, { version: v, cookie: fx.cashier, status: 403 });                                                       // cashier cannot deliver
    await fx.go('POST', '/v1/orders/{id}/deliver', { p: { id: m.id }, body: { salesperson_id: fx.staff }, status: 428 });
    await fx.go('POST', '/v1/orders/{id}/deliver', { p: { id: m.id }, body: { bogus: 1, salesperson_id: fx.staff }, headers: fx.im(v), status: 422 });
    await untouched();

    // a normal bill cannot sell a piece reserved for an order
    const sellReserved = await fx.go('POST', '/v1/sales/invoices', { body: { branch_id: fx.B1, salesperson_id: fx.staff, customer_id: customer, lines: [{ kind: 'tag', tag_id: m.tag_id }],
      payments: [{ mode: 'upi', amount: '1.00', reference: 'U' }] }, headers: fx.key(), status: [409, 422] });
    expect(sellReserved.json().code).toBe('tag_reserved');
    await untouched();
  });

  it('a locked rate cannot fit pieces of different purities: refused; without a lock the mixed bill is not the order path', async () => {
    const m = await readyOrder({ purity: fx.P24, advance: { kind: 'amount', amount: '1000', lock_rate_per_g: '5500' } });
    // one purity (24K) is fine
    const ok = (await deliver(m)).json();
    expect((await invoice(ok.invoice_id)).lines[0].rate_per_g).toBe('5500.00');
    // two lines of different purities on one order, locked: refused
    const two = (await fx.go('POST', '/v1/orders', { body: { branch_id: fx.B1, customer_id: customer, lines: [{ item_id: fx.ring, purity_id: fx.P22, pieces: 1 }, { item_id: fx.ring, purity_id: fx.P24, pieces: 1 }] }, headers: fx.key(), status: 201 })).json();
    await fx.go('POST', '/v1/orders/{id}/advances', { p: { id: two.id }, body: { kind: 'amount', amount: '1000', lock_rate_per_g: '5500' }, headers: fx.key(), status: 201 });
    let cur = (await fx.go('GET', '/v1/orders/{id}', { p: { id: two.id } })).json();
    for (const l of cur.lines) cur = (await fx.go('POST', '/v1/orders/{id}/lines/{lineId}/assign', { p: { id: cur.id, lineId: l.id }, body: { vendor_id: vendor, vendor_due: '2099-01-01' }, headers: fx.im(cur.version) })).json();
    for (const l of cur.lines) cur = (await fx.go('POST', '/v1/orders/{id}/lines/{lineId}/receive', { p: { id: cur.id, lineId: l.id }, body: { gross_wt: '5.000', huid: huid() }, headers: fx.im(cur.version) })).json();
    expect(cur.status).toBe('ready');
    const r = await deliver({ id: cur.id, version: cur.version, tag_id: '', line_id: '' }, {}, { status: 409 });
    expect(r.json().code).toBe('locked_rate_mixed_purity');
    for (const l of cur.lines) expect(await tagStatus(l.received_tag_id)).toBe('reserved');
  });

  it('metal advances are not applied in this release; the bill is a credit sale and the metal advance stays whole', async () => {
    const m = await readyOrder({ advance: { kind: 'metal', purity_id: fx.P22, weight: '5.000' } });
    const r = (await deliver(m)).json();
    expect(r.advances_applied).toEqual([]);
    const inv = await invoice(r.invoice_id);
    expect(inv.payments).toEqual([]);
    expect(inv.payment_status).toBe('unpaid');
    expect((await advances(m.id))[0]).toMatchObject({ kind: 'metal', balance_fine_g: '4.580', status: 'open' });
  });

  it('the Orders contract: deliverOrder returned a 2xx and nothing undocumented or invalid was seen', () => {
    const r = JSON.parse(fx.rec.report()) as { violations: unknown[]; undocumented: string[]; timestamps: string[] };
    expect(fx.rec.uncovered('/v1/orders')).toEqual(expect.not.arrayContaining(['POST /v1/orders/{id}/deliver']));
    expect(r.violations).toEqual([]);
    expect(r.undocumented).toEqual([]);
  });
});
