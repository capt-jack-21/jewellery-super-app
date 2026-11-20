import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { withTenantTx } from '@jw/db';
import * as ord from '@jw/mod-orders';
import * as inv from '@jw/mod-inventory';
import { pool, T1, U1, B1 } from './env';

/** O5: the vendor brings the finished piece back; Inventory lots, tags and reserves it; the order becomes ready (service layer, real Inventory). */
const rw = pool('app_rw');
const mig = pool('app_migrator');
afterAll(async () => { await rw.end(); await mig.end(); });

const ITEM = '00000000-0000-0000-0000-000000000901';   // seed RING (tagged item)
const P22 = '00000000-0000-0000-0000-000000000022';
const CUST = '00000000-0000-0000-0000-000000000d01';
const PERMS = ['orders.order.view', 'orders.order.create', 'orders.order.assign', 'orders.order.cancel', 'orders.order.receive'];
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
let VENDOR = ''; let seq = Date.now() % 1_000_000;
const huid = () => `OF${String(++seq % 10_000).padStart(4, '0')}`;   // 6 chars A-Z 0-9, unique per call
beforeAll(async () => {
  ord.registerOrdersPorts({ stock: { receivePiece: async (a, i) => {
    try { const r = await inv.receiveOrderPiece(a, i); return { lot_id: r.lot_id, lot_no: r.lot_no, tag_id: r.tag_id, tag_no: r.tag_no }; }
    catch (e) { if (e instanceof inv.InventoryError) throw new ord.OrdersError(e.status, e.code, e.message, e.errors); throw e; }   // same translation as apps/api OrdersPortsModule
  } }, sales: { takeAdvance: async () => { throw new Error('not used in O5'); }, listAdvances: async () => [], listRepairAdvances: async () => [] } });
  VENDOR = (await sql<{ id: string }>(`INSERT INTO masters.vendor(tenant_id, code, name, kinds) VALUES (platform.current_tenant(), $1, 'Smith O5', ARRAY['smith']) RETURNING id`, [`O5${Date.now() % 100000}`]))[0].id;
});
const due = '2026-12-01';
const inProduction = async (lines = 1) => {
  const o = await run(() => ord.createOrder(A, { branch_id: B1, customer_id: CUST, order_date: '2026-11-18',
    lines: Array.from({ length: lines }, () => ({ item_id: ITEM, purity_id: P22, pieces: 2, approx_wt: '10.000', size: '14' })) }));
  let cur = o;
  for (const l of o.lines) cur = await run(() => ord.assignLine(A, o.id, l.id, { vendor_id: VENDOR, vendor_due: due }));
  return cur;
};

describe('receiveLine', () => {
  it('lots, tags and reserves the piece; the line is received; the order is ready when its only line is in', async () => {
    const o = await inProduction();
    const r = await run(() => ord.receiveLine(A, o.id, o.lines[0].id, { gross_wt: '10.250', stone_wt: '0.250', huid: huid() }, o.version));
    expect(r.status).toBe('ready');
    expect(r.version).toBe(o.version + 1);
    const l = r.lines[0];
    expect(l).toMatchObject({ status: 'received', received_tag_id: expect.any(String) });
    const tag = (await sql<Record<string, string>>(`SELECT t.status, t.pieces::text, t.gross_wt::text, t.stone_wt::text, t.net_wt::text, t.item_id::text, t.purity_id::text, t.tag_no, t.branch_id::text,
        t.size, lt.entry_type, lt.ref_id::text, lt.ref_invoice_no, lt.vendor_id::text FROM inventory.tag t
        JOIN inventory.lot_line ll ON ll.id = t.lot_line_id JOIN inventory.lot lt ON lt.id = ll.lot_id WHERE t.id = $1`, [l.received_tag_id]))[0];
    expect(tag).toMatchObject({ status: 'reserved', pieces: '2', gross_wt: '10.250', stone_wt: '0.250', net_wt: '10.000', item_id: ITEM, purity_id: P22, branch_id: B1, size: '14',
      entry_type: 'order_receipt', ref_id: o.id, ref_invoice_no: o.order_no, vendor_id: VENDOR });
    const led = await sql<{ movement: string }>(`SELECT movement FROM inventory.stock_ledger WHERE tag_id = $1`, [l.received_tag_id]);
    expect(led.map((x) => x.movement)).toEqual(['tagged']);
  });
  it('with several lines the order stays in production until the last one is in; net weight defaults to gross - stone', async () => {
    const o = await inProduction(2);
    const [l1, l2] = o.lines.map((l) => l.id);
    const a = await run(() => ord.receiveLine(A, o.id, l1, { gross_wt: '5.000', huid: huid() }));
    expect(a.status).toBe('in_production');
    expect(a.lines.find((l) => l.id === l1)!.status).toBe('received');
    expect(a.lines.find((l) => l.id === l2)!.status).toBe('assigned');
    const b = await run(() => ord.receiveLine(A, o.id, l2, { gross_wt: '6.000', stone_wt: '1.000', huid: huid() }, a.version));
    expect(b.status).toBe('ready');
    const n = (await sql<{ net_wt: string }>(`SELECT net_wt::text FROM inventory.tag WHERE id = $1`, [b.lines.find((l) => l.id === l2)!.received_tag_id]))[0];
    expect(n.net_wt).toBe('5.000');
  });
  it('a cancelled line does not hold the order back', async () => {
    const o = await run(() => ord.createOrder(A, { branch_id: B1, customer_id: CUST, lines: [{ item_id: ITEM, purity_id: P22 }, { item_id: ITEM, purity_id: P22 }] }));
    const u = await run(() => ord.assignLine(A, o.id, o.lines[0].id, { vendor_id: VENDOR, vendor_due: '2099-01-01' }));
    await sql(`UPDATE orders.order_line SET status = 'cancelled' WHERE id = $1`, [o.lines[1].id]);
    expect((await run(() => ord.receiveLine(A, o.id, o.lines[0].id, { gross_wt: '3.000', huid: huid() }, u.version))).status).toBe('ready');
  });
  it('if Inventory refuses (HUID missing), nothing changes: no lot, no tag, the line stays assigned', async () => {
    const o = await inProduction();
    const before = (await sql<{ n: string }>(`SELECT count(*)::text n FROM inventory.lot WHERE ref_id = $1`, [o.id]))[0].n;
    await expect(run(() => ord.receiveLine(A, o.id, o.lines[0].id, { gross_wt: '4.000' }))).rejects.toEqual(expect.objectContaining({ status: 422, code: 'validation_failed', errors: [expect.objectContaining({ code: 'huid_required' })] }));
    expect((await sql<{ n: string }>(`SELECT count(*)::text n FROM inventory.lot WHERE ref_id = $1`, [o.id]))[0].n).toBe(before);
    const again = await run(() => ord.getOrder(A, o.id));
    expect(again).toMatchObject({ status: 'in_production', version: o.version });
    expect(again.lines[0]).toMatchObject({ status: 'assigned', received_tag_id: null });
  });
  it('checks input, state, version, permission and branch', async () => {
    const o = await inProduction();
    const l = o.lines[0].id;
    const go = (p: Partial<ord.ReceiveInput> = {}, a = A, v: number | undefined = o.version) => run(() => ord.receiveLine(a, o.id, l, { gross_wt: '2.000', huid: huid(), ...p }, v));
    await expect(go({}, A, o.version + 3)).rejects.toEqual(err(412, 'version_mismatch'));
    await expect(go({}, mk(['orders.order.view']))).rejects.toEqual(err(403, 'forbidden'));
    await expect(go({}, mk(PERMS, '00000000-0000-0000-0000-00000000b0ff'))).rejects.toEqual(err(404, 'not_found'));
    await expect(go({ gross_wt: '1.2345' })).rejects.toEqual(err(422, 'validation_failed'));
    await expect(go({ gross_wt: undefined as never })).rejects.toEqual(err(422, 'validation_failed'));
    await expect(go({ received_on: 'today' })).rejects.toEqual(err(422, 'validation_failed'));
    await expect(go({ stone_wt: '5.000' })).rejects.toEqual(err(422, 'validation_failed'));   // stone above gross: Inventory's weight rule
    await expect(run(() => ord.receiveLine(A, o.id, '00000000-0000-0000-0000-0000000000ff', { gross_wt: '2.000', huid: huid() }))).rejects.toEqual(err(404, 'not_found'));
    // an order that is still open (nothing assigned) or a line that is pending
    const open = await run(() => ord.createOrder(A, { branch_id: B1, customer_id: CUST, lines: [{ item_id: ITEM, purity_id: P22 }] }));
    await expect(run(() => ord.receiveLine(A, open.id, open.lines[0].id, { gross_wt: '2.000', huid: huid() }))).rejects.toEqual(err(409, 'order_not_in_production'));
    const two = await inProduction(1);
    const extra = await sql<{ id: string }>(`INSERT INTO orders.order_line(tenant_id, order_id, line_no, item_id, purity_id) VALUES (platform.current_tenant(), $1, 99, $2, $3) RETURNING id`, [two.id, ITEM, P22]);
    await expect(run(() => ord.receiveLine(A, two.id, extra[0].id, { gross_wt: '2.000', huid: huid() }))).rejects.toEqual(err(409, 'line_not_assigned'));
  });
  it('after receiving: the line cannot be received again, unassigned, or the order cancelled', async () => {
    const o = await inProduction(2);
    await run(() => ord.receiveLine(A, o.id, o.lines[0].id, { gross_wt: '2.000', huid: huid() }));
    await expect(run(() => ord.receiveLine(A, o.id, o.lines[0].id, { gross_wt: '2.000', huid: huid() }))).rejects.toEqual(err(409, 'line_not_assigned'));
    await expect(run(() => ord.unassignLine(A, o.id, o.lines[0].id))).rejects.toEqual(err(409, 'line_not_assigned'));
    await expect(run(() => ord.cancelOrder(A, o.id, { reason: 'too late' }))).rejects.toEqual(err(409, 'order_has_received_piece'));
  });
});
