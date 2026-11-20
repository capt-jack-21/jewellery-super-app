import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { withTenantTx } from '@jw/db';
import * as ord from '@jw/mod-orders';
import * as sales from '@jw/mod-sales';
import { pool, T1, U1, B1 } from './env';

/** O7: book a repair (service layer, real Sales for the optional advance). Rules the HTTP contract test cannot show. */
const rw = pool('app_rw');
const mig = pool('app_migrator');
afterAll(async () => { await rw.end(); await mig.end(); });

const CUST = '00000000-0000-0000-0000-000000000d01';
const PERMS = ['orders.repair.view', 'orders.repair.create', 'orders.advance.take'];
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
let failAdvance = false;
let TYPE = ''; let TYPE_OFF = '';
beforeAll(async () => {
  ord.registerOrdersPorts({
    stock: { receivePiece: async () => { throw new Error('not used in O7'); } },
    sales: {
      takeAdvance: async (a, i) => {
        if (failAdvance) throw new ord.OrdersError(422, 'validation_failed', 'sales refused the advance');
        try { return await sales.takeAdvance(a, i); }
        catch (e) { if (e instanceof sales.SalesError) throw new ord.OrdersError(e.status, e.code, e.message, e.errors); throw e; }
      },
      listAdvances: (orderId) => sales.listAdvances(orderId),
      listRepairAdvances: (repairId) => sales.listRepairAdvances(repairId),
      issueOrderInvoice: async () => { throw new Error('not used in O7'); },
      issueRepairInvoice: async () => { throw new Error('not used in O7'); },
    },
  });
  const tag = `o7-${Date.now()}`;
  TYPE = (await sql<{ id: string }>(`INSERT INTO masters.repair_type(tenant_id, name, sac, min_customer_charge, max_customer_charge) VALUES ($1, $2, '998713', 100, 2000) RETURNING id`, [T1, `${tag}-on`]))[0].id;
  TYPE_OFF = (await sql<{ id: string }>(`INSERT INTO masters.repair_type(tenant_id, name, is_active) VALUES ($1, $2, false) RETURNING id`, [T1, `${tag}-off`]))[0].id;
});
const input = (o: Partial<ord.RepairInput> = {}): ord.RepairInput => ({ branch_id: B1, customer_id: CUST, received_on: '2026-11-18',
  lines: [{ repair_type_id: TYPE, gross_wt: '5.250', net_wt: '5.000', customer_charge: '350.00' }], ...o });
const book = (o: Partial<ord.RepairInput> = {}) => run(() => ord.createRepair(A, input(o)));
const repairs = async () => Number((await sql<{ n: string }>(`SELECT count(*)::text n FROM orders.repair`))[0].n);

describe('createRepair', () => {
  it('numbers REP-{BRANCH}-{FY}-{SEQ:5}, starts received, totals add up, audited, version 1', async () => {
    const r = await book();
    expect(r.repair_no).toMatch(/^REP-[A-Z0-9]+-2627-\d{5}$/);
    expect(r).toMatchObject({ status: 'received', version: 1, overdue: false, customer_id: CUST, branch_id: B1, created_by: U1, delivered_invoice_id: null,
      totals: { lines: 1, gross_wt: '5.250', estimate: '350.00' }, advances: [] });
    const r2 = await book();
    expect(Number(r2.repair_no.slice(-5))).toBe(Number(r.repair_no.slice(-5)) + 1);
    const au = await sql<{ n: string }>(`SELECT count(*)::text n FROM platform.audit_event WHERE action = 'orders.repair.create' AND row_id = $1`, [r.id]);
    expect(Number(au[0].n)).toBe(1);
  });

  it('an advance is taken through Sales with the repair (receipt number, balance, repair_id); a Sales refusal creates nothing', async () => {
    const r = await book({ advance: { amount: '200', purpose: 'advance' } });
    expect(r.advances).toHaveLength(1);
    expect(r.advances[0]).toMatchObject({ kind: 'amount', amount: '200.00', balance: '200.00', repair_id: r.id, order_id: null, customer_id: CUST, branch_id: B1 });
    expect(r.advances[0].receipt_no).toMatch(/^ADV-[A-Z0-9]+-\d{4}-\d{5}$/);
    const before = await repairs();
    failAdvance = true;
    try { await expect(book({ advance: { amount: '200' } })).rejects.toEqual(err(422, 'validation_failed')); } finally { failAdvance = false; }
    expect(await repairs()).toBe(before);
  });

  it('refuses bad input with field errors and creates nothing', async () => {
    const before = await repairs();
    const line = (l: Partial<ord.RepairLineInput>): Partial<ord.RepairInput> => ({ lines: [{ repair_type_id: TYPE, gross_wt: '3.000', ...l }] });
    const lim = await book(line({ customer_charge: '99.99' })).catch((e: ord.OrdersError) => e);
    expect(lim).toMatchObject({ status: 422, code: 'validation_failed', errors: [expect.objectContaining({ path: 'lines.0.customer_charge', code: 'charge_out_of_range' })] });
    await expect(book(line({ customer_charge: '2000.01' }))).rejects.toEqual(err(422, 'validation_failed'));
    await expect(book(line({ customer_charge: '100.00' }))).resolves.toBeTruthy();          // the limits are inclusive
    await expect(book(line({ customer_charge: '2000.00' }))).resolves.toBeTruthy();
    const bad = (o: Partial<ord.RepairInput>) => expect(book(o)).rejects.toEqual(err(422, 'validation_failed'));
    await bad(line({ gross_wt: '0.000' }));
    await bad(line({ gross_wt: '1.0001' }));
    await bad(line({ net_wt: '3.001' }));
    await bad(line({ description: 'x'.repeat(501) }));
    await bad({ lines: [] });
    await bad({ due_date: '2026-11-17' });
    await bad({ notes: 'x'.repeat(1001) });
    await bad({ advance: { amount: '0' } });
    await bad({ advance: { amount: '10.005' } });
    await expect(book(line({ repair_type_id: TYPE_OFF }))).rejects.toEqual(err(422, 'inactive_master'));
    await expect(book(line({ repair_type_id: '00000000-0000-0000-0000-00000000dead' }))).rejects.toEqual(err(422, 'unknown_reference'));
    await expect(book({ customer_id: '00000000-0000-0000-0000-00000000dead' })).rejects.toEqual(err(422, 'unknown_reference'));
    await expect(book(line({ photo_file_ids: ['00000000-0000-0000-0000-00000000dead'] }))).rejects.toEqual(err(422, 'unknown_reference'));
    expect(await repairs()).toBe(before + 2);   // only the two inclusive-limit repairs
  });

  it('permissions and branch scope: no permission 403, advance needs orders.advance.take, another branch 403, hidden from other branches', async () => {
    const before = await repairs();
    await expect(run(() => ord.createRepair(mk(['orders.repair.view']), input()))).rejects.toEqual(err(403, 'forbidden'));
    await expect(run(() => ord.createRepair(mk(['orders.repair.create']), input({ advance: { amount: '50' } })))).rejects.toEqual(err(403, 'forbidden'));
    const elsewhere = mk(PERMS, '00000000-0000-0000-0000-00000000b0ff');
    await expect(run(() => ord.createRepair(elsewhere, input()))).rejects.toEqual(err(403, 'branch_scope'));
    expect(await repairs()).toBe(before);
    const r = await book();
    await expect(run(() => ord.getRepair(mk(['orders.repair.create']), r.id))).rejects.toEqual(err(403, 'forbidden'));
    await expect(run(() => ord.getRepair(elsewhere, r.id))).rejects.toEqual(err(404, 'not_found'));
    await expect(run(() => ord.getRepair(A, '00000000-0000-0000-0000-00000000dead'))).rejects.toEqual(err(404, 'not_found'));
    expect((await run(() => ord.getRepair(mk(PERMS, B1), r.id))).id).toBe(r.id);
  });

  it('overdue: past the due date while still open', async () => {
    const r = await book({ received_on: '2026-01-01', due_date: '2026-01-05' });
    expect(r.overdue).toBe(true);
  });
});

describe('updateRepair', () => {
  it('edits header and lines (whole list), cancelled lines stay, version bumps, stale If-Match is 412', async () => {
    const r = await book();
    const l1 = r.lines[0];
    const u = await run(() => ord.updateRepair(A, r.id, { notes: 'rush', due_date: '2026-12-01',
      lines: [{ id: l1.id, repair_type_id: TYPE, gross_wt: '5.250', customer_charge: '400.00' }, { repair_type_id: TYPE, gross_wt: '1.000', customer_charge: '100.00' }] }, r.version));
    expect(u).toMatchObject({ version: 2, notes: 'rush', due_date: '2026-12-01', totals: { lines: 2, gross_wt: '6.250', estimate: '500.00' } });
    await expect(run(() => ord.updateRepair(A, r.id, { notes: 'late' }, r.version))).rejects.toEqual(err(412, 'version_mismatch'));
    const u2 = await run(() => ord.updateRepair(A, r.id, { lines: [{ id: l1.id, repair_type_id: TYPE, gross_wt: '5.250' }] }, u.version));
    expect(u2.lines).toHaveLength(2);
    expect(u2.lines.filter((l) => l.status === 'cancelled')).toHaveLength(1);
    expect(u2.totals).toMatchObject({ lines: 1, gross_wt: '5.250', estimate: '0.00' });
    await expect(run(() => ord.updateRepair(A, r.id, { lines: [{ id: '00000000-0000-0000-0000-00000000dead', repair_type_id: TYPE, gross_wt: '1.000' }] }, u2.version)))
      .rejects.toEqual(err(422, 'unknown_reference'));
    await expect(run(() => ord.updateRepair(A, r.id, { lines: [] }, u2.version))).rejects.toEqual(err(422, 'validation_failed'));
  });

  it('the estimate limits apply on edit too; nothing changes on a refusal', async () => {
    const r = await book();
    await expect(run(() => ord.updateRepair(A, r.id, { notes: 'x', lines: [{ id: r.lines[0].id, repair_type_id: TYPE, gross_wt: '5.250', customer_charge: '9999.00' }] }, r.version)))
      .rejects.toEqual(err(422, 'validation_failed'));
    const after = await run(() => ord.getRepair(A, r.id));
    expect(after).toMatchObject({ version: r.version, notes: null });
  });

  it('only a repair still at the shop: other status 409 repair_not_editable, a line with a vendor 409 repair_in_progress', async () => {
    const issued = await book();
    await sql(`UPDATE orders.repair SET status = 'issued_to_vendor' WHERE id = $1`, [issued.id]);
    await expect(run(() => ord.updateRepair(A, issued.id, { notes: 'x' }, issued.version + 1))).rejects.toEqual(err(409, 'repair_not_editable'));
    const withVendor = await book();
    const v = (await sql<{ id: string }>(`INSERT INTO masters.vendor(tenant_id, code, name, kinds) VALUES (platform.current_tenant(), $1, 'Repair V', ARRAY['repair_vendor']) RETURNING id`, [`O7V${Date.now() % 100000}`]))[0].id;
    await sql(`UPDATE orders.repair_line SET issued_at = now(), vendor_id = $2 WHERE repair_id = $1`, [withVendor.id, v]);
    await expect(run(() => ord.updateRepair(A, withVendor.id, { notes: 'x' }, withVendor.version))).rejects.toEqual(err(409, 'repair_in_progress'));
  });

  it('permission and branch scope: view-only 403, other branch 404', async () => {
    const r = await book();
    await expect(run(() => ord.updateRepair(mk(['orders.repair.view']), r.id, { notes: 'x' }, r.version))).rejects.toEqual(err(403, 'forbidden'));
    await expect(run(() => ord.updateRepair(mk(PERMS, '00000000-0000-0000-0000-00000000b0ff'), r.id, { notes: 'x' }, r.version))).rejects.toEqual(err(404, 'not_found'));
  });
});

describe('database rules', () => {
  it('only the Orders role writes repairs (app_rw has no INSERT)', async () => {
    const c = await rw.connect();
    try {
      await c.query('BEGIN'); await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [T1]);
      await expect(c.query(`INSERT INTO orders.repair(tenant_id, branch_id, repair_no, customer_id) VALUES ($1, $2, 'R-RW', $3)`, [T1, B1, CUST])).rejects.toThrow(/permission denied/);
    } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
  });
  it('an advance belongs to an order or a repair, never both', async () => {
    const r = await book();
    const o = await run(() => ord.createOrder(mk(['orders.order.view', 'orders.order.create']), { branch_id: B1, customer_id: CUST, lines: [{ item_id: '00000000-0000-0000-0000-000000000901', purity_id: '00000000-0000-0000-0000-000000000022' }] }));
    await expect(sql(`INSERT INTO sales.advance(tenant_id, branch_id, receipt_no, customer_id, kind, amount, balance, order_id, repair_id)
      VALUES ($1, $2, $3, $4, 'amount', 10, 10, $5, $6)`, [T1, B1, `X-${Date.now()}`, CUST, o.id, r.id])).rejects.toThrow(/advance_order_or_repair_chk/);
  });
  it('a line weight of zero or a net above gross is refused by the table', async () => {
    const r = await book();
    await expect(sql(`UPDATE orders.repair_line SET net_wt = gross_wt + 1 WHERE repair_id = $1`, [r.id])).rejects.toThrow(/repair_line_wt_chk/);
  });
});
