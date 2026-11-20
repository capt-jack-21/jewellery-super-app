import { describe, it, expect, afterAll } from 'vitest';
import { withTenantTx } from '@jw/db';
import * as ord from '@jw/mod-orders';
import { pool, T1, U1, B1 } from './env';

/** O1: create / view / list / edit customer orders (service layer, as app_rw + orders_writer on the test DB). */
const rw = pool('app_rw');
const mig = pool('app_migrator');
afterAll(async () => { await rw.end(); await mig.end(); });

const ITEM = '00000000-0000-0000-0000-000000000901';   // seed RING
const ITEM2 = '00000000-0000-0000-0000-000000000902';  // seed COIN
const P22 = '00000000-0000-0000-0000-000000000022';
const CUST = '00000000-0000-0000-0000-000000000d01';   // seed customer Priya
const FRONT = ['orders.order.view', 'orders.order.create'];
const mk = (perms: string[], branch: string | null = null): ord.OrdersActor =>
  ({ userId: U1, permissions: new Set(perms), roles: [{ role: 'manager', branch_id: branch }] });
const OWNER = mk(FRONT);
const run = <T>(fn: () => Promise<T>): Promise<T> => withTenantTx(rw, { tenantId: T1, userId: U1 }, fn);
const err = (status: number, code: string) => expect.objectContaining({ status, code });
const base = (over: Partial<ord.OrderInput> = {}): ord.OrderInput =>
  ({ branch_id: B1, customer_id: CUST, lines: [{ item_id: ITEM, pieces: 2, approx_wt: '12.500' }], ...over });

describe('createOrder', () => {
  it('creates an order with the next ORD number, defaults and totals', async () => {
    const o = await run(() => ord.createOrder(OWNER, base({ due_date: '2099-01-01', notes: 'Anniversary chain' })));
    expect(o.order_no).toMatch(/^ORD-[A-Z0-9]+-\d{4}-\d{5}$/);
    expect(o).toMatchObject({ status: 'open', priority: 'normal', order_type: 'customer', customer_id: CUST, customer_name: 'Priya', overdue: false, version: 1 });
    expect(o.lines).toHaveLength(1);
    expect(o.lines[0]).toMatchObject({ item_id: ITEM, purity_id: expect.any(String), pieces: 2, approx_wt: '12.500', status: 'pending' });
    expect(o.totals).toEqual({ pieces: 2, approx_wt: '12.500' });
  });
  it('numbers run on without gaps or repeats', async () => {
    const a = await run(() => ord.createOrder(OWNER, base()));
    const b = await run(() => ord.createOrder(OWNER, base()));
    const n = (s: string) => Number(s.slice(-5));
    expect(n(b.order_no)).toBe(n(a.order_no) + 1);
  });
  it('is written by orders_writer only: the API role cannot insert directly', async () => {
    await expect(run(async () => { await (await import('@jw/db')).currentTx().query(
      `INSERT INTO orders.customer_order(tenant_id, branch_id, order_no) VALUES (platform.current_tenant(), $1, 'X-DIRECT')`, [B1]); })).rejects.toThrow(/permission denied/);
  });
  it('needs the permission and the branch', async () => {
    await expect(run(() => ord.createOrder(mk(['orders.order.view']), base()))).rejects.toEqual(err(403, 'forbidden'));
    await expect(run(() => ord.createOrder(mk(FRONT, '00000000-0000-0000-0000-00000000b0ff'), base()))).rejects.toEqual(err(403, 'branch_scope'));
  });
  it('rejects bad input with field errors', async () => {
    await expect(run(() => ord.createOrder(OWNER, base({ customer_id: null })))).rejects.toEqual(err(422, 'validation_failed'));
    await expect(run(() => ord.createOrder(OWNER, base({ order_type: 'shop' })))).rejects.toEqual(err(422, 'validation_failed'));
    await expect(run(() => ord.createOrder(OWNER, base({ priority: 'asap' as never })))).rejects.toEqual(err(422, 'validation_failed'));
    await expect(run(() => ord.createOrder(OWNER, base({ order_date: '2026-11-18', due_date: '2026-11-01' })))).rejects.toEqual(err(422, 'validation_failed'));
    await expect(run(() => ord.createOrder(OWNER, base({ lines: [] })))).rejects.toEqual(err(422, 'validation_failed'));
    await expect(run(() => ord.createOrder(OWNER, base({ lines: [{ item_id: ITEM, pieces: 0 }] })))).rejects.toEqual(err(422, 'validation_failed'));
    await expect(run(() => ord.createOrder(OWNER, base({ lines: [{ item_id: ITEM, approx_wt: '1.2345' }] })))).rejects.toEqual(err(422, 'validation_failed'));
    await expect(run(() => ord.createOrder(OWNER, base({ lines: [{ item_id: '00000000-0000-0000-0000-0000000000ff' }] })))).rejects.toEqual(err(422, 'unknown_reference'));
    await expect(run(() => ord.createOrder(OWNER, base({ customer_id: '00000000-0000-0000-0000-0000000000ff' })))).rejects.toEqual(err(422, 'unknown_reference'));
    await expect(run(() => ord.createOrder(OWNER, base({ lines: [{ item_id: ITEM, attachment_file_ids: ['00000000-0000-0000-0000-0000000000ff'] }] })))).rejects.toEqual(err(422, 'unknown_reference'));
  });
  it('a shop order has no customer; purity defaults to the item purity; stones are kept', async () => {
    const o = await run(() => ord.createOrder(OWNER, { branch_id: B1, order_type: 'shop', priority: 'high',
      lines: [{ item_id: ITEM2, purity_id: P22, stones: [{ name: 'Ruby', pieces: 3, weight: '0.450' }], size: '16', gender: 'female', design_notes: 'plain band' }] }));
    expect(o).toMatchObject({ order_type: 'shop', customer_id: null, priority: 'high' });
    expect(o.lines[0]).toMatchObject({ purity_id: P22, stones: [{ name: 'Ruby', pieces: 3, weight: '0.450' }], size: '16', gender: 'female', design_notes: 'plain band', pieces: 1, approx_wt: null });
  });
});

describe('getOrder and listOrders', () => {
  it('gets one order; 404 for an unknown id; branch scope hides it', async () => {
    const o = await run(() => ord.createOrder(OWNER, base()));
    expect((await run(() => ord.getOrder(OWNER, o.id))).order_no).toBe(o.order_no);
    await expect(run(() => ord.getOrder(OWNER, '00000000-0000-0000-0000-0000000000ff'))).rejects.toEqual(err(404, 'not_found'));
    await expect(run(() => ord.getOrder(mk(FRONT, '00000000-0000-0000-0000-00000000b0ff'), o.id))).rejects.toEqual(err(404, 'not_found'));
    await expect(run(() => ord.getOrder(mk([]), o.id))).rejects.toEqual(err(403, 'forbidden'));
  });
  it('lists newest first with paging, filters and an overdue flag', async () => {
    const past = await run(() => ord.createOrder(OWNER, base({ order_date: '2026-01-01', due_date: '2026-01-02', priority: 'urgent', notes: 'LIST-OVERDUE' })));
    const l1 = await run(() => ord.listOrders(OWNER, { limit: 2 }));
    expect(l1.items).toHaveLength(2);
    expect(l1.next_cursor).not.toBeNull();
    const l2 = await run(() => ord.listOrders(OWNER, { limit: 2, cursor: l1.next_cursor }));
    expect(l2.items[0].id < l1.items[1].id).toBe(true);
    const od = await run(() => ord.listOrders(OWNER, { overdue: true }));
    expect(od.items.map((i) => i.id)).toContain(past.id);
    expect(od.items.every((i) => i.overdue)).toBe(true);
    expect((await run(() => ord.listOrders(OWNER, { priority: 'urgent' }))).items.every((i) => i.priority === 'urgent')).toBe(true);
    expect((await run(() => ord.listOrders(OWNER, { q: past.order_no }))).items.map((i) => i.id)).toEqual([past.id]);
    expect((await run(() => ord.listOrders(OWNER, { q: 'priya', customer_id: CUST, limit: 1 }))).items).toHaveLength(1);
    expect(past.order_no && (await run(() => ord.listOrders(OWNER, { status: 'delivered' }))).items.length).toBe(0);
    const row = od.items.find((i) => i.id === past.id)!;
    expect(row).toMatchObject({ line_count: 1, pieces: 2, approx_wt: '12.500', customer_name: 'Priya' });
  });
});

describe('updateOrder', () => {
  it('edits the header and bumps the version; If-Match must match', async () => {
    const o = await run(() => ord.createOrder(OWNER, base()));
    const u = await run(() => ord.updateOrder(OWNER, o.id, { priority: 'urgent', notes: 'rush', due_date: '2099-02-02' }, 1));
    expect(u).toMatchObject({ priority: 'urgent', notes: 'rush', due_date: '2099-02-02', version: 2 });
    await expect(run(() => ord.updateOrder(OWNER, o.id, { priority: 'low' }, 1))).rejects.toEqual(err(412, 'version_mismatch'));
  });
  it('lines: change in place, add, and a line left out becomes cancelled (never deleted); a lines-only edit still bumps the version', async () => {
    const o = await run(() => ord.createOrder(OWNER, base({ lines: [{ item_id: ITEM, pieces: 1 }, { item_id: ITEM2, pieces: 1 }] })));
    const [l1, l2] = o.lines;
    const u = await run(() => ord.updateOrder(OWNER, o.id, { lines: [{ id: l1.id, item_id: ITEM, pieces: 3, approx_wt: '5.000' }, { item_id: ITEM, pieces: 1 }] }, 1));
    expect(u.version).toBe(2);
    expect(u.lines.find((l) => l.id === l1.id)).toMatchObject({ pieces: 3, approx_wt: '5.000', status: 'pending' });
    expect(u.lines.find((l) => l.id === l2.id)!.status).toBe('cancelled');
    expect(u.lines.filter((l) => l.status === 'pending')).toHaveLength(2);
    expect(u.totals).toEqual({ pieces: 4, approx_wt: '5.000' });
    await expect(run(() => ord.updateOrder(OWNER, o.id, { lines: [] }, 2))).rejects.toEqual(err(422, 'validation_failed'));
    await expect(run(() => ord.updateOrder(OWNER, o.id, { lines: [{ id: '00000000-0000-0000-0000-0000000000ff', item_id: ITEM }] }, 2))).rejects.toEqual(err(422, 'unknown_reference'));
  });
  it('only an open order with no assigned or received line can be edited', async () => {
    const o = await run(() => ord.createOrder(OWNER, base()));
    await mig.query(`SELECT set_config('app.tenant_id', $1, false)`, [T1]);
    const c = await mig.connect();
    try {
      await c.query('BEGIN'); await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [T1]);
      await c.query(`UPDATE orders.customer_order SET status = 'in_production' WHERE id = $1`, [o.id]); await c.query('COMMIT');
    } finally { c.release(); }
    await expect(run(() => ord.updateOrder(OWNER, o.id, { notes: 'late' }))).rejects.toEqual(err(409, 'order_not_open'));
  });
});
