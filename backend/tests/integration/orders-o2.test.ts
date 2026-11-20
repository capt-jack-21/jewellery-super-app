import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { withTenantTx } from '@jw/db';
import * as ord from '@jw/mod-orders';
import * as sales from '@jw/mod-sales';
import { pool, T1, U1, B1 } from './env';

/** O2: an advance against an order, in money or in metal (fine-gram balance), with an optional locked rate (service layer, real Sales). */
const rw = pool('app_rw');
const mig = pool('app_migrator');
afterAll(async () => { await rw.end(); await mig.end(); });

const ITEM = '00000000-0000-0000-0000-000000000901';
const P22 = '00000000-0000-0000-0000-000000000022';     // fineness 916
const CUST = '00000000-0000-0000-0000-000000000d01';
const PERMS = ['orders.order.view', 'orders.order.create', 'orders.order.assign', 'orders.order.cancel', 'orders.advance.take'];
const mk = (perms: string[], branch: string | null = null): ord.OrdersActor => ({ userId: U1, permissions: new Set(perms), roles: [{ role: 'manager', branch_id: branch }] });
const A = mk(PERMS);
const run = <T>(fn: () => Promise<T>): Promise<T> => withTenantTx(rw, { tenantId: T1, userId: U1 }, fn);
const err = (status: number, code: string) => expect.objectContaining({ status, code });
const sql = async <R = Record<string, unknown>>(q: string, p: unknown[] = []): Promise<R[]> => {
  const c = await mig.connect();
  try {
    await c.query('BEGIN'); await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [T1]);
    const r = await c.query(q, p); await c.query('COMMIT'); return r.rows as R[];
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
};
beforeAll(() => {
  ord.registerOrdersPorts({
    stock: { receivePiece: async () => { throw new Error('not used in O2'); } },
    sales: {
      takeAdvance: async (a, i) => {
        try { return await sales.takeAdvance(a, i); }
        catch (e) { if (e instanceof sales.SalesError) throw new ord.OrdersError(e.status, e.code, e.message, e.errors); throw e; }   // same translation as apps/api OrdersPortsModule
      },
      listAdvances: (orderId) => sales.listAdvances(orderId),
      listRepairAdvances: (repairId) => sales.listRepairAdvances(repairId),
    },
  });
});
const newOrder = () => run(() => ord.createOrder(A, { branch_id: B1, customer_id: CUST, order_date: '2026-11-18',
  lines: [{ item_id: ITEM, purity_id: P22, pieces: 1, approx_wt: '10.000' }] }));
const count = async (orderId: string) => Number((await sql<{ n: string }>(`SELECT count(*)::text n FROM sales.advance WHERE order_id = $1`, [orderId]))[0].n);

describe('takeAdvance', () => {
  it('money: receipt number, balance = amount, order version unchanged, listed and audited', async () => {
    const o = await newOrder();
    const adv = await run(() => ord.takeAdvance(A, o.id, { kind: 'amount', amount: '5000' }));
    expect(adv).toMatchObject({ kind: 'amount', amount: '5000.00', balance: '5000.00', balance_fine_g: '0.000', weight: null, purity_id: null,
      locked_rate_per_g: null, status: 'open', order_id: o.id, customer_id: CUST, branch_id: B1 });
    expect(adv.receipt_no).toMatch(/^ADV-[A-Z0-9]+-\d{4}-\d{5}$/);
    expect((await run(() => ord.getOrder(A, o.id))).version).toBe(o.version);
    const second = await run(() => ord.takeAdvance(A, o.id, { kind: 'amount', amount: '1250.50' }));
    expect(second.receipt_no).not.toBe(adv.receipt_no);
    expect((await run(() => ord.listAdvances(A, o.id))).map((x) => x.receipt_no)).toEqual([adv.receipt_no, second.receipt_no]);
    const au = await sql<{ n: string }>(`SELECT count(*)::text n FROM platform.audit_event WHERE action IN ('sales.advance.take','orders.order.advance') AND row_id IN ($1, $2)`, [adv.id, o.id]);
    expect(Number(au[0].n)).toBeGreaterThanOrEqual(2);
  });

  it('metal: fine-gram balance = weight x fineness / 1000; the money balance stays 0', async () => {
    const o = await newOrder();
    const adv = await run(() => ord.takeAdvance(A, o.id, { kind: 'metal', purity_id: P22, weight: '10.000' }));
    expect(adv).toMatchObject({ kind: 'metal', amount: '0.00', balance: '0.00', weight: '10.000', purity_id: P22, balance_fine_g: '9.160', status: 'open' });
    const odd = await run(() => ord.takeAdvance(A, o.id, { kind: 'metal', purity_id: P22, weight: '3.333' }));
    expect(odd.balance_fine_g).toBe('3.053');   // 3.333 x 0.916 = 3.052..., rounded to the milligram
  });

  it('locks ONE rate on the order: first advance sets it, the same rate is fine, another rate is refused and nothing is created', async () => {
    const o = await newOrder();
    const a1 = await run(() => ord.takeAdvance(A, o.id, { kind: 'amount', amount: '1000', lock_rate_per_g: '6500' }));
    expect(a1.locked_rate_per_g).toBe('6500.00');
    const after = await run(() => ord.getOrder(A, o.id));
    expect(after).toMatchObject({ rate_locked_per_g: '6500.00', version: o.version + 1 });
    await run(() => ord.takeAdvance(A, o.id, { kind: 'amount', amount: '500', lock_rate_per_g: '6500.00' }));
    await run(() => ord.takeAdvance(A, o.id, { kind: 'amount', amount: '500' }));
    const n = await count(o.id);
    await expect(run(() => ord.takeAdvance(A, o.id, { kind: 'amount', amount: '500', lock_rate_per_g: '6600' }))).rejects.toEqual(err(409, 'rate_already_locked'));
    expect(await count(o.id)).toBe(n);
    expect((await run(() => ord.getOrder(A, o.id))).rate_locked_per_g).toBe('6500.00');
  });

  it('refuses bad input with field errors and creates nothing', async () => {
    const o = await newOrder();
    const bad = (p: Partial<ord.AdvanceIn> & { kind: ord.AdvanceIn['kind'] }) => expect(run(() => ord.takeAdvance(A, o.id, p))).rejects.toEqual(err(422, 'validation_failed'));
    await bad({ kind: 'amount' });
    await bad({ kind: 'amount', amount: '0' });
    await bad({ kind: 'amount', amount: '10.005' });
    await bad({ kind: 'amount', amount: '10', weight: '1.000' });
    await bad({ kind: 'metal', weight: '1.000' });
    await bad({ kind: 'metal', purity_id: P22 });
    await bad({ kind: 'metal', purity_id: P22, weight: '0.000' });
    await bad({ kind: 'metal', purity_id: P22, weight: '1.000', amount: '10' });
    await bad({ kind: 'metal', purity_id: '00000000-0000-0000-0000-00000000dead', weight: '1.000' });
    await bad({ kind: 'amount', amount: '10', lock_rate_per_g: '0' });
    await bad({ kind: 'amount', amount: '10', lock_rate_per_g: '12.345' });
    await bad({ kind: 'bogus' as 'amount', amount: '10' });
    await bad({ kind: 'amount', amount: '10', received_on: '18-11-2026' });
    expect(await count(o.id)).toBe(0);
  });

  it('needs a live order with a customer, the permission and the branch', async () => {
    const o = await newOrder();
    await expect(run(() => ord.takeAdvance(mk([]), o.id, { kind: 'amount', amount: '10' }))).rejects.toEqual(err(403, 'forbidden'));
    await expect(run(() => ord.takeAdvance(mk(PERMS, '00000000-0000-0000-0000-00000000b999'), o.id, { kind: 'amount', amount: '10' }))).rejects.toEqual(err(404, 'not_found'));
    await expect(run(() => ord.takeAdvance(A, '00000000-0000-0000-0000-00000000dead', { kind: 'amount', amount: '10' }))).rejects.toEqual(err(404, 'not_found'));
    await expect(run(() => ord.listAdvances(mk([]), o.id))).rejects.toEqual(err(403, 'forbidden'));
    const shop = await run(() => ord.createOrder(A, { branch_id: B1, order_type: 'shop', order_date: '2026-11-18', lines: [{ item_id: ITEM, purity_id: P22, pieces: 1 }] }));
    await expect(run(() => ord.takeAdvance(A, shop.id, { kind: 'amount', amount: '10' }))).rejects.toEqual(err(409, 'order_needs_customer'));
    await run(() => ord.cancelOrder(A, o.id, { reason: 'changed mind' }));
    await expect(run(() => ord.takeAdvance(A, o.id, { kind: 'amount', amount: '10' }))).rejects.toEqual(err(409, 'order_not_open'));
    expect(await count(o.id)).toBe(0);
  });

  it('an open advance now blocks cancelling the order (O4 rule) and the balances cannot be edited outside Sales', async () => {
    const o = await newOrder();
    const adv = await run(() => ord.takeAdvance(A, o.id, { kind: 'metal', purity_id: P22, weight: '2.000' }));
    await expect(run(() => ord.cancelOrder(A, o.id, { reason: 'changed mind' }))).rejects.toEqual(err(409, 'advance_outstanding'));
    await expect(sql(`UPDATE sales.advance SET balance_fine_g = 0 WHERE id = $1`, [adv.id])).rejects.toThrow(/sales module role/);
  });
});
