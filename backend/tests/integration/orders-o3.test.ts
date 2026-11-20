import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { withTenantTx } from '@jw/db';
import * as ord from '@jw/mod-orders';
import { pool, T1, U1, B1 } from './env';

/** O3 / O4: give lines to a vendor, take them back, cancel with a reason; the order status follows (service layer on the test DB). */
const rw = pool('app_rw');
const mig = pool('app_migrator');
afterAll(async () => { await rw.end(); await mig.end(); });

const ITEM = '00000000-0000-0000-0000-000000000901';
const CUST = '00000000-0000-0000-0000-000000000d01';
const PERMS = ['orders.order.view', 'orders.order.create', 'orders.order.assign', 'orders.order.cancel'];
const mk = (perms: string[], branch: string | null = null): ord.OrdersActor =>
  ({ userId: U1, permissions: new Set(perms), roles: [{ role: 'manager', branch_id: branch }] });
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
const newOrder = (lines = 2) => run(() => ord.createOrder(A, { branch_id: B1, customer_id: CUST, order_date: '2026-11-18',
  lines: Array.from({ length: lines }, () => ({ item_id: ITEM, pieces: 1, approx_wt: '5.000' })) }));
let VENDOR = ''; let REFINER = ''; let n = 0;
beforeAll(async () => {
  const code = `O3${Date.now() % 100000}`;
  VENDOR = (await sql<{ id: string }>(`INSERT INTO masters.vendor(tenant_id, code, name, kinds) VALUES (platform.current_tenant(), $1, 'Smith A', ARRAY['smith']) RETURNING id`, [code]))[0].id;
  REFINER = (await sql<{ id: string }>(`INSERT INTO masters.vendor(tenant_id, code, name, kinds) VALUES (platform.current_tenant(), $1, 'Refiner R', ARRAY['refiner']) RETURNING id`, [`${code}R`]))[0].id;
});
const due = '2026-12-01';

describe('migration 01001', () => {
  it('has the new columns and the checks that stop a half-cancelled order or an assigned line without a vendor', async () => {
    const o = await newOrder(1);
    await expect(sql(`UPDATE orders.customer_order SET status = 'cancelled' WHERE id = $1`, [o.id])).rejects.toThrow(/customer_order_cancel_chk/);
    await expect(sql(`UPDATE orders.order_line SET status = 'assigned' WHERE id = $1`, [o.lines[0].id])).rejects.toThrow(/order_line_assigned_chk/);
  });
});

describe('assignLine', () => {
  it('assigns a pending line: vendor, due date, note; the order becomes in_production and its version moves', async () => {
    const o = await newOrder();
    const u = await run(() => ord.assignLine(A, o.id, o.lines[0].id, { vendor_id: VENDOR, vendor_due: due, vendor_note: 'issued 10.000 g 22K' }, o.version));
    expect(u.status).toBe('in_production');
    expect(u.version).toBe(o.version + 1);
    expect(u.lines.find((l) => l.id === o.lines[0].id)).toMatchObject({ status: 'assigned', vendor_id: VENDOR, vendor_due: due, vendor_note: 'issued 10.000 g 22K', assigned_at: expect.any(String) });
    expect(u.lines.find((l) => l.id === o.lines[1].id)!.status).toBe('pending');
  });
  it('the order can no longer be edited once a line is assigned', async () => {
    const o = await newOrder(1);
    await run(() => ord.assignLine(A, o.id, o.lines[0].id, { vendor_id: VENDOR, vendor_due: due }));
    await expect(run(() => ord.updateOrder(A, o.id, { notes: 'late' }))).rejects.toEqual(err(409, 'order_not_open'));
  });
  it('checks version, permission, branch, vendor, date and line state', async () => {
    const o = await newOrder(1);
    const l = o.lines[0].id;
    const go = (p: Partial<ord.AssignInput> = {}, a = A, v: number | undefined = o.version) =>
      run(() => ord.assignLine(a, o.id, l, { vendor_id: VENDOR, vendor_due: due, ...p }, v));
    await expect(go({}, A, o.version + 5)).rejects.toEqual(err(412, 'version_mismatch'));
    await expect(go({}, mk(['orders.order.view']))).rejects.toEqual(err(403, 'forbidden'));
    await expect(go({}, mk(PERMS, '00000000-0000-0000-0000-00000000b0ff'))).rejects.toEqual(err(404, 'not_found'));
    await expect(go({ vendor_id: '00000000-0000-0000-0000-0000000000ff' })).rejects.toEqual(err(422, 'unknown_reference'));
    await expect(go({ vendor_id: REFINER })).rejects.toEqual(err(422, 'unknown_reference'));
    await expect(go({ vendor_due: '2026-11-01' })).rejects.toEqual(err(422, 'validation_failed'));
    await expect(go({ vendor_due: 'soon' })).rejects.toEqual(err(422, 'validation_failed'));
    await expect(go({ vendor_note: 'x'.repeat(501) })).rejects.toEqual(err(422, 'validation_failed'));
    await expect(run(() => ord.assignLine(A, o.id, '00000000-0000-0000-0000-0000000000ff', { vendor_id: VENDOR, vendor_due: due }))).rejects.toEqual(err(404, 'not_found'));
    await go();
    await expect(run(() => ord.assignLine(A, o.id, l, { vendor_id: VENDOR, vendor_due: due }))).rejects.toEqual(err(409, 'line_not_pending'));
  });
  it('an inactive vendor cannot be used', async () => {
    const o = await newOrder(1);
    const v = (await sql<{ id: string }>(`INSERT INTO masters.vendor(tenant_id, code, name, kinds, is_active) VALUES (platform.current_tenant(), $1, 'Gone', ARRAY['smith'], false) RETURNING id`, [`O3X${++n}${Date.now() % 10000}`]))[0].id;
    await expect(run(() => ord.assignLine(A, o.id, o.lines[0].id, { vendor_id: v, vendor_due: due }))).rejects.toEqual(err(422, 'unknown_reference'));
  });
  it('a cancelled or ready order cannot be assigned', async () => {
    const o = await newOrder(1);
    await run(() => ord.cancelOrder(A, o.id, { reason: 'customer changed mind' }));
    await expect(run(() => ord.assignLine(A, o.id, o.lines[0].id, { vendor_id: VENDOR, vendor_due: due }))).rejects.toEqual(err(409, 'order_not_open'));
  });
});

describe('unassignLine', () => {
  it('takes the line back; the order goes back to open only when no other line is out', async () => {
    const o = await newOrder();
    const [l1, l2] = o.lines.map((l) => l.id);
    await run(() => ord.assignLine(A, o.id, l1, { vendor_id: VENDOR, vendor_due: due, vendor_note: 'n' }));
    await run(() => ord.assignLine(A, o.id, l2, { vendor_id: VENDOR, vendor_due: due }));
    const a = await run(() => ord.unassignLine(A, o.id, l1));
    expect(a.status).toBe('in_production');
    expect(a.lines.find((l) => l.id === l1)).toMatchObject({ status: 'pending', vendor_id: null, vendor_due: null, vendor_note: null, assigned_at: null });
    const b = await run(() => ord.unassignLine(A, o.id, l2, a.version));
    expect(b.status).toBe('open');
  });
  it('only an assigned line, with the right version and permission', async () => {
    const o = await newOrder(1);
    const l = o.lines[0].id;
    await expect(run(() => ord.unassignLine(A, o.id, l))).rejects.toEqual(err(409, 'line_not_assigned'));
    const u = await run(() => ord.assignLine(A, o.id, l, { vendor_id: VENDOR, vendor_due: due }));
    await expect(run(() => ord.unassignLine(A, o.id, l, u.version + 3))).rejects.toEqual(err(412, 'version_mismatch'));
    await expect(run(() => ord.unassignLine(mk(['orders.order.view']), o.id, l))).rejects.toEqual(err(403, 'forbidden'));
    await sql(`UPDATE orders.order_line SET status = 'received' WHERE id = $1`, [l]);   // O5 will do this through Inventory
    await expect(run(() => ord.unassignLine(A, o.id, l))).rejects.toEqual(err(409, 'line_not_assigned'));
  });
});

describe('cancelOrder', () => {
  it('cancels an open order: reason, time and user recorded, every line cancelled, version bumped', async () => {
    const o = await newOrder();
    const c = await run(() => ord.cancelOrder(A, o.id, { reason: '  customer changed mind ' }, o.version));
    expect(c).toMatchObject({ status: 'cancelled', cancel_reason: 'customer changed mind', cancelled_by: U1, cancelled_at: expect.any(String), version: o.version + 1 });
    expect(c.lines.every((l) => l.status === 'cancelled')).toBe(true);
    expect(c.totals).toEqual({ pieces: 0, approx_wt: '0.000' });
    expect(c.overdue).toBe(false);
  });
  it('cancels an order in production and frees the vendor lines', async () => {
    const o = await newOrder(1);
    await run(() => ord.assignLine(A, o.id, o.lines[0].id, { vendor_id: VENDOR, vendor_due: due }));
    const c = await run(() => ord.cancelOrder(A, o.id, { reason: 'vendor could not make it' }));
    expect(c.status).toBe('cancelled');
    expect(c.lines[0].status).toBe('cancelled');
  });
  it('needs a reason, permission, branch and version; cancelling twice is refused', async () => {
    const o = await newOrder(1);
    await expect(run(() => ord.cancelOrder(A, o.id, { reason: '' }))).rejects.toEqual(err(422, 'validation_failed'));
    await expect(run(() => ord.cancelOrder(A, o.id, { reason: 'ab' }))).rejects.toEqual(err(422, 'validation_failed'));
    await expect(run(() => ord.cancelOrder(A, o.id, { reason: 'x'.repeat(501) }))).rejects.toEqual(err(422, 'validation_failed'));
    await expect(run(() => ord.cancelOrder(mk(['orders.order.view']), o.id, { reason: 'because' }))).rejects.toEqual(err(403, 'forbidden'));
    await expect(run(() => ord.cancelOrder(mk(PERMS, '00000000-0000-0000-0000-00000000b0ff'), o.id, { reason: 'because' }))).rejects.toEqual(err(404, 'not_found'));
    await expect(run(() => ord.cancelOrder(A, o.id, { reason: 'because' }, o.version + 4))).rejects.toEqual(err(412, 'version_mismatch'));
    await run(() => ord.cancelOrder(A, o.id, { reason: 'because' }));
    await expect(run(() => ord.cancelOrder(A, o.id, { reason: 'because' }))).rejects.toEqual(err(409, 'order_not_cancellable'));
  });
  it('is refused once a piece is received, or while an advance is still open', async () => {
    const o = await newOrder(1);
    await run(() => ord.assignLine(A, o.id, o.lines[0].id, { vendor_id: VENDOR, vendor_due: due }));
    await sql(`UPDATE orders.order_line SET status = 'received' WHERE id = $1`, [o.lines[0].id]);
    await expect(run(() => ord.cancelOrder(A, o.id, { reason: 'too late' }))).rejects.toEqual(err(409, 'order_has_received_piece'));
    const p = await newOrder(1);
    const adv = (await sql<{ id: string }>(`INSERT INTO sales.advance(tenant_id, branch_id, receipt_no, customer_id, kind, amount, balance, order_id)
      VALUES (platform.current_tenant(), $1, $2, $3, 'amount', 1000, 1000, $4) RETURNING id`, [B1, `ADV-O3-${Date.now()}`, CUST, p.id]))[0].id;
    await expect(run(() => ord.cancelOrder(A, p.id, { reason: 'changed mind' }))).rejects.toEqual(err(409, 'advance_outstanding'));
    await sql(`UPDATE sales.advance SET status = 'refunded' WHERE id = $1`, [adv]);
    expect((await run(() => ord.cancelOrder(A, p.id, { reason: 'changed mind' }))).status).toBe('cancelled');
  });
});
