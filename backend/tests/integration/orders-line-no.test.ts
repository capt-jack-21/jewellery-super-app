import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { salesFixture, type SalesFx } from './sales-fixture';
import { HUID_PREFIX } from './huid';

/**
 * Lines of an order or repair carry a fixed line_no: listed in the order entered (even when saved in the same instant), a cancelled line
 * keeps its number, a new line takes the next number, and numbers are never reused. Real HTTP stack, responses checked against the contract.
 */
let fx: SalesFx;
let customer = ''; let rtype = '';
beforeAll(async () => {
  fx = await salesFixture('ordlineno', HUID_PREFIX.orders);
  rtype = (await fx.sql<{ id: string }>(`INSERT INTO masters.repair_type(tenant_id, name, sac, min_customer_charge, max_customer_charge) VALUES ($1, 'Polish', NULL, 50, 2000) RETURNING id`, [fx.tenantId]))[0].id;
  customer = await fx.customer({ name: 'Line Buyer' });
}, 120000);
afterAll(async () => { if (fx) await fx.close(); });

type L = { id: string; line_no: number; status: string; pieces?: number; gross_wt?: string };
const nos = (lines: L[]) => lines.map((l) => l.line_no);

describe('line numbers', () => {
  it('order: numbered 1..n in the order entered; a cancelled line keeps its number; a new line takes the next; never reused', async () => {
    const o = (await fx.go('POST', '/v1/orders', { body: { branch_id: fx.B1, customer_id: customer, due_date: '2099-01-31',
      lines: [1, 2, 3, 4].map((n) => ({ item_id: fx.ring, purity_id: fx.P22, pieces: n })) }, headers: fx.key(), status: 201 })).json();
    const got = (await fx.go('GET', '/v1/orders/{id}', { p: { id: o.id } })).json();
    expect(nos(got.lines)).toEqual([1, 2, 3, 4]);
    expect(got.lines.map((l: L) => l.pieces)).toEqual([1, 2, 3, 4]);
    // leave out line 2: it is cancelled and keeps number 2; add a new line: number 5
    const keep = got.lines.filter((l: L) => l.line_no !== 2).map((l: L) => ({ id: l.id, item_id: fx.ring, purity_id: fx.P22, pieces: l.pieces }));
    const u = (await fx.go('PATCH', '/v1/orders/{id}', { p: { id: o.id }, headers: fx.im(got.version), body: { lines: [...keep, { item_id: fx.ring, purity_id: fx.P22, pieces: 9 }] } })).json();
    expect(nos(u.lines)).toEqual([1, 2, 3, 4, 5]);
    expect(u.lines.map((l: L) => l.status)).toEqual(['pending', 'cancelled', 'pending', 'pending', 'pending']);
    expect(u.lines[4].pieces).toBe(9);
    // the cancelled line comes back when it is listed again: same number, not renumbered
    const back = (await fx.go('PATCH', '/v1/orders/{id}', { p: { id: o.id }, headers: fx.im(u.version),
      body: { lines: u.lines.map((l: L) => ({ id: l.id, item_id: fx.ring, purity_id: fx.P22, pieces: l.pieces })) } })).json();
    expect(nos(back.lines)).toEqual([1, 2, 3, 4, 5]);
    expect(back.lines.every((l: L) => l.status === 'pending')).toBe(true);
  });

  it('repair: numbered 1..n in the order entered; a cancelled line keeps its number; a new line takes the next', async () => {
    const r = (await fx.go('POST', '/v1/repairs', { body: { branch_id: fx.B1, customer_id: customer,
      lines: [1, 2, 3].map((n) => ({ repair_type_id: rtype, gross_wt: `${n}.000`, customer_charge: '100.00' })) }, headers: fx.key(), status: 201 })).json();
    const got = (await fx.go('GET', '/v1/repairs/{id}', { p: { id: r.id } })).json();
    expect(nos(got.lines)).toEqual([1, 2, 3]);
    expect(got.lines.map((l: L) => l.gross_wt)).toEqual(['1.000', '2.000', '3.000']);
    const keep = got.lines.filter((l: L) => l.line_no !== 1).map((l: L) => ({ id: l.id, repair_type_id: rtype, gross_wt: l.gross_wt, customer_charge: '100.00' }));
    const u = (await fx.go('PATCH', '/v1/repairs/{id}', { p: { id: r.id }, headers: fx.im(got.version), body: { lines: [...keep, { repair_type_id: rtype, gross_wt: '7.000', customer_charge: '100.00' }] } })).json();
    expect(nos(u.lines)).toEqual([1, 2, 3, 4]);
    expect(u.lines.map((l: L) => l.status)).toEqual(['cancelled', 'active', 'active', 'active']);
    expect(u.lines[3].gross_wt).toBe('7.000');
  });

  it('the database refuses a duplicate or zero line number', async () => {
    const [{ id: order_id }] = await fx.sql<{ id: string }>(`SELECT order_id AS id FROM orders.order_line WHERE tenant_id = $1 AND line_no = 2 LIMIT 1`, [fx.tenantId]);
    await expect(fx.sql(`UPDATE orders.order_line SET line_no = 1 WHERE tenant_id = $1 AND order_id = $2 AND line_no = 2`, [fx.tenantId, order_id])).rejects.toThrow();
    await expect(fx.sql(`UPDATE orders.order_line SET line_no = 0 WHERE tenant_id = $1 AND order_id = $2 AND line_no = 2`, [fx.tenantId, order_id])).rejects.toThrow();
  });
});
