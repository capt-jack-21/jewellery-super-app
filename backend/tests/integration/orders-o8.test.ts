import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { withTenantTx } from '@jw/db';
import * as ord from '@jw/mod-orders';
import { pool, T1, U1, B1 } from './env';

/** O8: issue a repair line to a vendor, take it back, receive it with the weight-loss check (service layer on the test DB). */
const rw = pool('app_rw');
const mig = pool('app_migrator');
afterAll(async () => { await rw.end(); await mig.end(); });

const CUST = '00000000-0000-0000-0000-000000000d01';
const BASE = ['orders.repair.view', 'orders.repair.create', 'orders.repair.vendor'];
const mk = (perms: string[], branch: string | null = null): ord.OrdersActor => ({ userId: U1, permissions: new Set(perms), roles: [{ role: 'manager', branch_id: branch }] });
const A = mk(BASE);                                     // may issue and receive, may NOT override a loss
const BOSS = mk([...BASE, 'orders.repair.loss_override']);
const run = <T>(fn: () => Promise<T>): Promise<T> => withTenantTx(rw, { tenantId: T1, userId: U1 }, fn);
const err = (status: number, code: string) => expect.objectContaining({ status, code });
const sql = async <R = Record<string, unknown>>(q: string, p: unknown[] = []): Promise<R[]> => {
  const c = await mig.connect();
  try {
    await c.query('BEGIN'); await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [T1]);
    const r = await c.query(q, p); await c.query('COMMIT'); return r.rows as R[];
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
};
let TYPE = ''; let VENDOR = ''; let REFINER = ''; let OLD = '';
beforeAll(async () => {
  ord.registerOrdersPorts({
    stock: { receivePiece: async () => { throw new Error('not used in O8'); } },
    sales: { takeAdvance: async () => { throw new Error('not used in O8'); }, listAdvances: async () => [], listRepairAdvances: async () => [],
      issueOrderInvoice: async () => { throw new Error('not used in O8'); },
      issueRepairInvoice: async () => { throw new Error('not used in O8'); } },
  });
  const tag = `o8-${Date.now() % 1000000}`;
  TYPE = (await sql<{ id: string }>(`INSERT INTO masters.repair_type(tenant_id, name, min_customer_charge, max_customer_charge, min_vendor_charge, max_vendor_charge)
    VALUES ($1, $2, 100, 2000, 50, 500) RETURNING id`, [T1, tag]))[0].id;
  VENDOR = (await sql<{ id: string }>(`INSERT INTO masters.vendor(tenant_id, code, name, kinds) VALUES (platform.current_tenant(), $1, 'Repair V', ARRAY['repair_vendor']) RETURNING id`, [`${tag}V`]))[0].id;
  REFINER = (await sql<{ id: string }>(`INSERT INTO masters.vendor(tenant_id, code, name, kinds) VALUES (platform.current_tenant(), $1, 'Refiner', ARRAY['refiner']) RETURNING id`, [`${tag}R`]))[0].id;
  OLD = (await sql<{ id: string }>(`INSERT INTO masters.vendor(tenant_id, code, name, kinds, is_active) VALUES (platform.current_tenant(), $1, 'Closed', ARRAY['repair_vendor'], false) RETURNING id`, [`${tag}C`]))[0].id;
});
/** Position of the line with this gross weight: lines saved in the same millisecond come back in no fixed order. */
const at = (r: ord.Repair, w: string): number => r.lines.findIndex((l) => l.gross_wt === w);
const repair = (weights: string[] = ['10.000']) => run(() => ord.createRepair(A, { branch_id: B1, customer_id: CUST, received_on: '2026-11-18',
  lines: weights.map((gross_wt) => ({ repair_type_id: TYPE, gross_wt })) }));
const issue = (r: ord.Repair, k = 0, o: Partial<ord.IssueInput> = {}, v = r.version, who = A) => run(() => ord.issueRepairLine(who, r.id, r.lines[k].id, { vendor_id: VENDOR, ...o }, v));
const back = (r: ord.Repair, k: number, wt: string, o: Partial<ord.ReceiveBackInput> = {}, who = A, v?: number) =>
  run(() => ord.receiveRepairLine(who, r.id, r.lines[k].id, { received_wt: wt, ...o }, v));

describe('migration 01005', () => {
  it('a line cannot be issued without a vendor or received without a weight', async () => {
    const r = await repair();
    await expect(sql(`UPDATE orders.repair_line SET issued_at = now() WHERE id = $1`, [r.lines[0].id])).rejects.toThrow(/repair_line_issue_chk/);
    await expect(sql(`UPDATE orders.repair_line SET vendor_id = $2, issued_at = now(), received_at = now() WHERE id = $1`, [r.lines[0].id, VENDOR])).rejects.toThrow(/repair_line_receive_chk/);
  });
});

describe('issue / unissue', () => {
  it('issues a line: vendor, charge, note, issued_at; the repair becomes issued_to_vendor and the version moves; audited', async () => {
    const r = await repair(['10.000', '5.000']);
    const k = at(r, '10.000');
    const u = await issue(r, k, { vendor_charge: '150.00', vendor_note: 'handed 10.000 g' });
    expect(u).toMatchObject({ status: 'issued_to_vendor', version: r.version + 1 });
    expect(u.lines[k]).toMatchObject({ vendor_id: VENDOR, vendor_charge: '150.00', vendor_note: 'handed 10.000 g', issued_at: expect.any(String), received_at: null, loss_wt: null });
    expect(u.lines[1 - k].issued_at).toBeNull();
    const au = await sql<{ n: string }>(`SELECT count(*)::text n FROM platform.audit_event WHERE action = 'orders.repair.issue' AND row_id = $1`, [r.id]);
    expect(Number(au[0].n)).toBe(1);
  });
  it('unissue takes the line back: the repair returns to received and can be edited again', async () => {
    const r = await repair();
    const out = await issue(r);
    await expect(run(() => ord.updateRepair(A, r.id, { notes: 'x' }, out.version))).rejects.toEqual(err(409, 'repair_not_editable'));
    const u = await run(() => ord.unissueRepairLine(A, r.id, r.lines[0].id, out.version));
    expect(u.status).toBe('received');
    expect(u.lines[0]).toMatchObject({ vendor_id: null, vendor_charge: null, vendor_note: null, issued_at: null });
    await expect(run(() => ord.updateRepair(A, r.id, { notes: 'edit again' }, u.version))).resolves.toMatchObject({ notes: 'edit again' });
    await expect(run(() => ord.unissueRepairLine(A, r.id, r.lines[0].id))).rejects.toEqual(err(409, 'line_not_issued'));
  });
  it('refuses: bad vendor kind or inactive vendor, charge outside the limits, already issued, cancelled line, version, permission, branch', async () => {
    const r = await repair(['10.000', '5.000']);
    const k = at(r, '10.000');
    await expect(issue(r, k, { vendor_id: REFINER })).rejects.toEqual(err(422, 'unknown_reference'));
    await expect(issue(r, k, { vendor_id: OLD })).rejects.toEqual(err(422, 'unknown_reference'));
    await expect(issue(r, k, { vendor_id: '00000000-0000-0000-0000-00000000dead' })).rejects.toEqual(err(422, 'unknown_reference'));
    const lim = await issue(r, k, { vendor_charge: '49.99' }).catch((e: ord.OrdersError) => e);
    expect(lim).toMatchObject({ status: 422, code: 'validation_failed', errors: [expect.objectContaining({ path: 'vendor_charge', code: 'charge_out_of_range' })] });
    await expect(issue(r, k, { vendor_charge: '500.01' })).rejects.toEqual(err(422, 'validation_failed'));
    await expect(issue(r, k, { vendor_note: 'x'.repeat(501) })).rejects.toEqual(err(422, 'validation_failed'));
    await expect(issue(r, k, {}, r.version + 3)).rejects.toEqual(err(412, 'version_mismatch'));
    await expect(issue(r, k, {}, r.version, mk(['orders.repair.view', 'orders.repair.create']))).rejects.toEqual(err(403, 'forbidden'));
    await expect(issue(r, k, {}, r.version, mk(BASE, '00000000-0000-0000-0000-00000000b0ff'))).rejects.toEqual(err(404, 'not_found'));
    await expect(run(() => ord.issueRepairLine(A, r.id, '00000000-0000-0000-0000-00000000dead', { vendor_id: VENDOR }))).rejects.toEqual(err(404, 'not_found'));
    const first = await issue(r, k);
    await expect(issue(first, k)).rejects.toEqual(err(409, 'line_already_issued'));
  });
  it('a line taken off the repair cannot be issued', async () => {
    const r = await repair(['10.000', '5.000']);
    const u = await run(() => ord.updateRepair(A, r.id, { lines: [{ id: r.lines[at(r, '10.000')].id, repair_type_id: TYPE, gross_wt: '10.000' }] }, r.version));
    const gone = u.lines.find((l) => l.status === 'cancelled')!;
    await expect(run(() => ord.issueRepairLine(A, r.id, gone.id, { vendor_id: VENDOR }, u.version))).rejects.toEqual(err(409, 'line_cancelled'));
  });
});

describe('receive back and the loss check (shop tolerance default 1.00 %)', () => {
  it('status follows the lines: partly back = received_from_vendor, a line still out = issued_to_vendor, every live line back = ready', async () => {
    const r = await repair(['10.000', '5.000', '2.000']);
    const [x, y, z] = [at(r, '10.000'), at(r, '5.000'), at(r, '2.000')];
    let u = await issue(r, x); u = await issue(u, y);
    expect(u.status).toBe('issued_to_vendor');
    u = await back(u, x, '9.950');
    expect(u.status).toBe('issued_to_vendor');                       // line 2 is still out
    u = await back(u, y, '5.000');
    expect(u.status).toBe('received_from_vendor');                  // line 3 never issued
    u = await issue(u, z);
    u = await back(u, z, '2.000');
    expect(u.status).toBe('ready');
    expect(u.lines[x]).toMatchObject({ received_wt: '9.950', loss_wt: '0.050', loss_pct: '0.50', loss_override_reason: null });
    expect(u.lines[z]).toMatchObject({ loss_wt: '0.000', loss_pct: '0.00' });
    await expect(run(() => ord.updateRepair(A, r.id, { notes: 'x' }))).rejects.toEqual(err(409, 'repair_not_editable'));
    await expect(issue(u, x)).rejects.toEqual(err(409, 'repair_not_open'));
  });
  it('a loss exactly at the tolerance is accepted, one milligram-step above is blocked; nothing changes on a block', async () => {
    const r = await repair(['10.000', '10.000']);
    let u = await issue(r, 0); u = await issue(u, 1);
    const blocked = await back(u, 0, '9.899').catch((e: ord.OrdersError) => e);       // loss 0.101 g = 1.01 %
    expect(blocked).toMatchObject({ status: 422, code: 'validation_failed', errors: [expect.objectContaining({ path: 'received_wt', code: 'loss_exceeds_tolerance' })] });
    const same = await run(() => ord.getRepair(A, r.id));
    expect(same.lines[0]).toMatchObject({ received_at: null, received_wt: null });
    expect(same.version).toBe(u.version);
    const ok = await back(u, 1, '9.900');                                             // exactly 1.00 %
    expect(ok.lines[1]).toMatchObject({ loss_wt: '0.100', loss_pct: '1.00', loss_override_reason: null });
  });
  it('a gain needs no override and shows as a negative loss', async () => {
    const r = await repair(['10.000']);
    const u = await back(await issue(r), 0, '10.500');
    expect(u.lines[0]).toMatchObject({ loss_wt: '-0.500', loss_pct: '-5.00', loss_override_reason: null });
    expect(u.status).toBe('ready');
  });
  it('override: needs orders.repair.loss_override AND a reason; the reason and the person are kept and audited', async () => {
    const r = await repair(['10.000', '10.000', '10.000']);
    let u = await issue(r, 0); u = await issue(u, 1); u = await issue(u, 2);
    await expect(back(u, 0, '9.000', { loss_override_reason: 'melted in polishing' })).rejects.toEqual(err(403, 'forbidden'));   // reason but no permission
    await expect(back(u, 0, '9.000', {}, BOSS)).rejects.toEqual(err(422, 'validation_failed'));                                   // permission but no reason
    await expect(back(u, 0, '9.000', { loss_override_reason: 'ab' }, BOSS)).rejects.toEqual(err(422, 'validation_failed'));       // reason too short
    const o = await back(u, 0, '9.000', { loss_override_reason: '  stone setting loss  ' }, BOSS);
    expect(o.lines[0]).toMatchObject({ loss_wt: '1.000', loss_pct: '10.00', loss_override_reason: 'stone setting loss' });
    const row = (await sql<{ by: string }>(`SELECT loss_override_by::text AS by FROM orders.repair_line WHERE id = $1`, [r.lines[0].id]))[0];
    expect(row.by).toBe(U1);
    const au = await sql<{ n: string }>(`SELECT count(*)::text n FROM platform.audit_event WHERE action = 'orders.repair.receive_loss_override' AND row_id = $1`, [r.id]);
    expect(Number(au[0].n)).toBe(1);
    // a reason sent for a loss inside the tolerance is not stored: no override happened
    const w = await back(o, 1, '9.990', { loss_override_reason: 'not needed' });
    expect(w.lines[1].loss_override_reason).toBeNull();
  });
  it('refuses: not issued, already received, bad weight, vendor charge outside the limits, stale version, permission, branch', async () => {
    const r = await repair(['10.000', '5.000']);
    const k = at(r, '10.000');
    await expect(back(r, k, '10.000')).rejects.toEqual(err(409, 'line_not_issued'));
    const u = await issue(r, k);
    for (const wt of ['0', '0.000', '-1.000', '1.0001', 'abc']) await expect(back(u, k, wt)).rejects.toEqual(err(422, 'validation_failed'));
    await expect(back(u, k, '10.000', { vendor_charge: '9999.00' })).rejects.toEqual(err(422, 'validation_failed'));
    await expect(back(u, k, '10.000', {}, A, u.version + 4)).rejects.toEqual(err(412, 'version_mismatch'));
    await expect(back(u, k, '10.000', {}, mk(['orders.repair.view']))).rejects.toEqual(err(403, 'forbidden'));
    await expect(back(u, k, '10.000', {}, mk(BASE, '00000000-0000-0000-0000-00000000b0ff'))).rejects.toEqual(err(404, 'not_found'));
    const done = await back(u, k, '10.000', { vendor_charge: '200.00' });
    expect(done.lines[k].vendor_charge).toBe('200.00');
    await expect(back(done, k, '10.000')).rejects.toEqual(err(409, 'line_already_received'));
    await expect(run(() => ord.unissueRepairLine(A, r.id, r.lines[k].id))).rejects.toEqual(err(409, 'line_already_received'));
  });
});
