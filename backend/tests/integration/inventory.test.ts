import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { withTenantTx } from '@jw/db';
import * as inv from '@jw/mod-inventory';
import type { InventoryActor } from '@jw/mod-inventory';
import { huidGen, HUID_PREFIX } from './huid';
import { pool, T1, T2, U1, B1 } from './env';

/** Inventory service layer (contract 0.8.2, data model 987-989) against the test DB as app_rw + inventory_writer. */
const rw = pool('app_rw');
const mig = pool('app_migrator');
afterAll(async () => { await rw.end(); await mig.end(); });

const ITEM_TAG = '00000000-0000-0000-0000-000000000901';   // seed RING (tag, 22K, HUID required)
const ITEM_LOOSE = '00000000-0000-0000-0000-000000000902'; // seed COIN (non_tag)
const P22 = '00000000-0000-0000-0000-000000000022';
const C001 = '00000000-0000-0000-0000-00000000c001';
const rnd = (n: number) => Array.from({ length: n }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(Math.random() * 24)]).join('');
const huid = huidGen(HUID_PREFIX.inventory);

const run = <T>(fn: () => Promise<T>, tenantId = T1): Promise<T> => withTenantTx(rw, { tenantId, userId: U1 }, fn);
async function sql<T = Record<string, unknown>>(q: string, p: unknown[] = [], tenantId = T1): Promise<T[]> {
  return withTenantTx(rw, { tenantId }, async (c) => (await c.query(q, p)).rows as T[]);
}
async function asMigrator<T>(q: string, p: unknown[] = []): Promise<T[]> {
  const c = await mig.connect();
  try {
    await c.query('BEGIN'); await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [T1]);
    const r = await c.query(q, p); await c.query('COMMIT'); return r.rows as T[];
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}
const err = (status: number, code: string) => expect.objectContaining({ status, code });

const ALL = ['inventory.stock.view', 'inventory.tag.create', 'inventory.tag.edit', 'inventory.tag.photos', 'inventory.tag.print_label',
  'inventory.tag.status_change', 'inventory.tag.view_cost', 'inventory.move', 'inventory.transfer.dispatch', 'inventory.transfer.approve',
  'inventory.transfer.receive', 'inventory.stock_check.run', 'inventory.stock_check.close', 'inventory.adjustment.request',
  'inventory.adjustment.approve', 'inventory.valuation.view', 'inventory.ageing.view', 'inventory.settings.edit'];
const MANAGER = ALL.filter((p) => p !== 'inventory.settings.edit');
/** Salesperson: read from the 987 seed (platform.system_role_permission) in beforeAll — includes inventory.move (lead decision 3). */
let SALES: string[] = [];

let B2 = '', B2code = '', B1code = '';
let owner: InventoryActor, mgr: InventoryActor, mgr2: InventoryActor, sales: InventoryActor, salesNoMove: InventoryActor, mgrB2: InventoryActor;
let C1 = '', C2 = '', C3 = '', CX = '', BOX1 = '';

async function user(name: string): Promise<string> {
  return (await sql<{ id: string }>(`INSERT INTO platform.app_user(tenant_id, name, username) VALUES ($1, $2, $3) RETURNING id`, [T1, name, `it.${rnd(10).toLowerCase()}`]))[0].id;
}
async function role(code: string): Promise<string> {
  // one tenant role per system role (role_tenant_id_system_role_code_key): reuse the seeded one, create it only when missing
  const got = await sql<{ id: string }>(`SELECT id FROM platform.role WHERE system_role_code = $1`, [code]);
  if (got[0]) return got[0].id;
  return (await sql<{ id: string }>(`INSERT INTO platform.role(tenant_id, name, system_role_code) VALUES ($1, $2, $3) RETURNING id`, [T1, `IT ${code}`, code]))[0].id;
}
async function actor(roleCode: string, perms: string[], branchId: string | null): Promise<InventoryActor> {
  const id = await user(`IT ${roleCode} ${rnd(4)}`);
  await sql(`INSERT INTO platform.user_role(tenant_id, user_id, role_id, branch_id) VALUES ($1, $2, $3, $4)`, [T1, id, await role(roleCode), branchId]);
  return { userId: id, permissions: new Set(perms), roles: [{ role: roleCode, branch_id: branchId }] };
}
async function counter(branchId: string, code: string): Promise<string> {
  return (await sql<{ id: string }>(`INSERT INTO masters.counter(tenant_id, branch_id, code, name) VALUES ($1, $2, $3, $4) RETURNING id`, [T1, branchId, code, code]))[0].id;
}
const tag = async (over: Partial<inv.TagCreate> = {}, branchId = B1, by = owner) =>
  (await run(() => inv.createTags(by, branchId, [{ item_id: ITEM_TAG, gross_wt: '10.000', stone_wt: '0.500', huid: huid(), counter_id: C1, ...over }])))[0];
const tagRow = async (id: string) => (await sql<{ status: string; branch_id: string; counter_id: string | null; box_id: string | null; pieces: number; gross_wt: string; net_wt: string }>(
  `SELECT status, branch_id, counter_id, box_id, pieces, gross_wt::text, net_wt::text FROM inventory.tag WHERE id = $1`, [id]))[0];
const ledgerOf = (src: string) => sql<{ movement: string; direction: number; tag_id: string | null; branch_id: string; pieces: number; gross_wt: string }>(
  `SELECT movement, direction, tag_id, branch_id, pieces, gross_wt::text FROM inventory.stock_ledger WHERE source_id = $1 ORDER BY id`, [src]);

beforeAll(async () => {
  B1code = (await sql<{ code: string }>(`SELECT code FROM platform.branch WHERE id = $1`, [B1]))[0].code;
  B2code = `I${rnd(3)}`;
  B2 = (await sql<{ id: string }>(`INSERT INTO platform.branch(tenant_id, company_id, code, name, bill_series_prefix, state_code)
      VALUES ($1, $2, $3, 'IT Branch 2', $4, '33') RETURNING id`, [T1, C001, B2code, B2code]))[0].id;
  SALES = (await sql<{ p: string }>(`SELECT permission_code AS p FROM platform.system_role_permission WHERE role_code = 'salesperson' AND permission_code LIKE 'inventory.%' ORDER BY 1`)).map((r) => r.p);
  owner = await actor('owner', ALL, null);
  mgr = await actor('manager', MANAGER, B1);
  mgr2 = await actor('manager', MANAGER, B1);
  mgrB2 = await actor('manager', MANAGER, B2);
  sales = await actor('salesperson', SALES, B1);
  salesNoMove = await actor('salesperson', SALES.filter((p) => p !== 'inventory.move'), B1);
  C1 = await counter(B1, `C${rnd(4)}`); C2 = await counter(B1, `C${rnd(4)}`); C3 = await counter(B1, `C${rnd(4)}`); CX = await counter(B2, `C${rnd(4)}`);
  BOX1 = (await sql<{ id: string }>(`INSERT INTO masters.box(tenant_id, counter_id, code) VALUES ($1, $2, $3) RETURNING id`, [T1, C1, `TR${rnd(5)}`]))[0].id;
  const cur = await run(() => inv.getSettings(owner));
  await run(() => inv.patchSettings(owner, { tag_format: { prefix: `I${rnd(3)}`, separator: '-', branch_segment: true, item_segment: false, digits: 5, start_no: 1 },
    adjustment_approver: 'owner_or_manager', photos_enabled: false, ageing_enabled: false }, cur.source === 'shop' ? cur.version : null));
});

describe('settings', () => {
  it('stale If-Match → 412, missing → 428; only settings.edit may patch', async () => {
    const s = await run(() => inv.getSettings(owner));
    expect(s.source).toBe('shop');
    expect(s.transfer_no_format).toBe('TRF-{BRANCH}-{FY}-{SEQ:5}');
    await expect(run(() => inv.patchSettings(owner, { photos_enabled: false }, s.version - 1))).rejects.toEqual(err(412, 'version_mismatch'));
    await expect(run(() => inv.patchSettings(owner, { photos_enabled: false }, null))).rejects.toEqual(err(428, 'precondition_required'));
    await expect(run(() => inv.patchSettings(mgr, { photos_enabled: false }, s.version))).rejects.toEqual(err(403, 'forbidden'));
    await expect(run(() => inv.patchSettings(owner, { tag_format: { digits: 1, start_no: 50 } }, s.version))).rejects.toEqual(err(422, 'validation_failed'));
  });
  it('preview renders without consuming numbers', async () => {
    const before = await sql(`SELECT scope_key, next_no FROM inventory.tag_counter ORDER BY 1`);
    const p = await run(() => inv.previewTagFormat(owner, { branch_id: B1, count: 2 }));
    expect(p.valid).toBe(true);
    expect(p.samples[0]).toMatch(new RegExp(`-${B1code}-00001$`));
    expect(await sql(`SELECT scope_key, next_no FROM inventory.tag_counter ORDER BY 1`)).toEqual(before);
  });
});

describe('tag numbering', () => {
  it('renders from the shop format, stores tag_no, posts a tagged ledger row', async () => {
    const s = await run(() => inv.getSettings(owner));
    const [a, b] = await run(() => inv.createTags(owner, B1, [
      { item_id: ITEM_TAG, gross_wt: '5.000', huid: huid() }, { item_id: ITEM_TAG, gross_wt: '6.000', huid: huid() }]));
    const pre = `${s.tag_format.prefix}-${B1code}-`;
    expect(a.tag_no.startsWith(pre) && b.tag_no.startsWith(pre)).toBe(true);
    expect(Number(b.tag_no.slice(pre.length))).toBe(Number(a.tag_no.slice(pre.length)) + 1);
    expect((await ledgerOf(a.id)).map((l) => l.movement)).toEqual(['tagged']);
  });
  it('skips numbers already taken (imported tag) and reports them', async () => {
    const s = await run(() => inv.getSettings(owner));
    const pre = `${s.tag_format.prefix}-${B1code}-`;
    const [{ next_no }] = await sql<{ next_no: string }>(`SELECT next_no::text FROM inventory.tag_counter WHERE scope_key = $1`, [pre]);
    const taken = [0, 1].map((k) => pre + String(Number(next_no) + k).padStart(5, '0'));
    const imp = await run(() => inv.importOpeningStock(owner, B1, C001, { tags: taken.map((t) => ({ tag_no: t, item_id: ITEM_TAG, purity_id: P22,
      gross_wt: '3.000', net_wt: '3.000', huid: huid(), mc_type: 'per_gram' as const, received_on: '2026-01-10' })) }));
    expect(imp).toEqual({ created: 2, errors: [] });
    const t = await tag();
    expect(t.skipped_numbers).toEqual(taken);
    expect(t.tag_no).toBe(pre + String(Number(next_no) + 2).padStart(5, '0'));
  });
  it('concurrent creates get distinct numbers (counter row lock)', async () => {
    const r = await Promise.all([1, 2, 3, 4].map(() => tag()));
    expect(new Set(r.map((x) => x.tag_no)).size).toBe(4);
  });
  it('import duplicates are row errors, not aborts; HUID clash on create → 409 huid_exists', async () => {
    const t = await tag();
    const imp = await run(() => inv.importOpeningStock(owner, B1, C001, { tags: [{ tag_no: t.tag_no, item_id: ITEM_TAG, purity_id: P22,
      gross_wt: '1.000', net_wt: '1.000', huid: huid(), mc_type: 'per_gram' }] }));
    expect(imp.errors).toEqual([{ row: 0, code: 'tag_no_exists' }]);
    const h = huid();
    await tag({ huid: h });
    await expect(tag({ huid: h })).rejects.toEqual(err(409, 'huid_exists'));
  });
  it('validation: HUID required for 22K, non-tag item refused, salesperson cannot tag', async () => {
    await expect(tag({ huid: null })).rejects.toEqual(err(422, 'validation_failed'));
    await expect(tag({ item_id: ITEM_LOOSE })).rejects.toEqual(err(422, 'validation_failed'));
    await expect(tag({}, B1, sales)).rejects.toEqual(err(403, 'forbidden'));
  });
});

describe('status transitions', () => {
  it('manual reserve and back; never sold / written_off manually', async () => {
    const t = await tag();
    expect((await run(() => inv.changeTagStatus(mgr, t.id, 'reserved', 'customer hold'))).status).toBe('reserved');
    expect((await run(() => inv.changeTagStatus(mgr, t.id, 'in_stock', 'released'))).status).toBe('in_stock');
    await expect(run(() => inv.changeTagStatus(mgr, t.id, 'sold', 'nope'))).rejects.toEqual(err(409, 'invalid_status_transition'));
    await expect(run(() => inv.changeTagStatus(owner, t.id, 'written_off', 'lost it'))).rejects.toEqual(err(409, 'invalid_status_transition'));
    expect((await tagRow(t.id)).status).toBe('in_stock');
  });
});

describe('counter / tray moves', () => {
  it('987 seeds inventory.move for salesperson (global per system role; no per-shop override — deferred to P6)', async () => {
    expect(SALES).toEqual(expect.arrayContaining(['inventory.move', 'inventory.stock.view']));
    expect(SALES).not.toContain('inventory.transfer.dispatch');
  });
  it('salesperson moves in own branch: location_move + move_out/move_in ledger, tag location updated', async () => {
    const t = await tag();
    const { move_ids } = await run(() => inv.moveStock(sales, { branch_id: B1, to_counter_id: C2, tag_ids: [t.id], reason: 'display' }));
    expect(await tagRow(t.id)).toMatchObject({ counter_id: C2, box_id: null, status: 'in_stock' });
    expect((await ledgerOf(move_ids[0])).map((l) => `${l.movement}:${l.direction}`).sort()).toEqual(['move_in:1', 'move_out:-1']);
    await run(() => inv.moveStock(sales, { branch_id: B1, to_counter_id: C1, to_tray_id: BOX1, tag_ids: [t.id] }));
    expect(await tagRow(t.id)).toMatchObject({ counter_id: C1, box_id: BOX1 });
    await expect(run(() => inv.moveStock(sales, { branch_id: B1, to_counter_id: C1, to_tray_id: BOX1, tag_ids: [t.id] }))).rejects.toEqual(err(422, 'same_location'));
  });
  it('salesperson: other branch → 403 branch_scope; no inventory.move → 403; tray must be on the counter', async () => {
    const t2 = await tag({ counter_id: CX }, B2);
    await expect(run(() => inv.moveStock(sales, { branch_id: B2, to_counter_id: null, tag_ids: [t2.id] }))).rejects.toEqual(err(403, 'branch_scope'));
    await expect(run(() => inv.moveStock(sales, { branch_id: B1, to_counter_id: C2, tag_ids: [t2.id] }))).rejects.toEqual(err(409, 'wrong_branch'));
    const t = await tag();
    await expect(run(() => inv.moveStock(salesNoMove, { branch_id: B1, to_counter_id: C2, tag_ids: [t.id] }))).rejects.toEqual(err(403, 'forbidden'));
    await expect(run(() => inv.moveStock(sales, { branch_id: B1, to_counter_id: C2, to_tray_id: BOX1, tag_ids: [t.id] }))).rejects.toEqual(err(422, 'location_mismatch'));
    await expect(run(() => inv.moveStock(sales, { branch_id: B1, to_counter_id: C2 }))).rejects.toEqual(err(422, 'empty_move'));
  });
  it('loose stock: receipt, move within balance, refuse beyond balance', async () => {
    await run(() => inv.receiveLoose(owner, { branch_id: B1, counter_id: C3, item_id: ITEM_LOOSE, purity_id: P22, gross_wt: '20.000', net_wt: '20.000', pieces: 4 }));
    await run(() => inv.moveStock(sales, { branch_id: B1, to_counter_id: C2, loose: [{ item_id: ITEM_LOOSE, purity_id: P22, from_counter_id: C3, gross_wt: '5.000', net_wt: '5.000', pieces: 1 }] }));
    const bal = await run(() => inv.looseStock(owner, { branch_id: B1, item_id: ITEM_LOOSE }));
    const at = (c: string) => bal.find((r) => r.counter_id === c);
    expect(at(C3)).toMatchObject({ pieces: 3, gross_wt: '15.000' });
    expect(at(C2)).toMatchObject({ pieces: 1, gross_wt: '5.000' });
    await expect(run(() => inv.moveStock(sales, { branch_id: B1, to_counter_id: C1, loose: [{ item_id: ITEM_LOOSE, purity_id: P22, from_counter_id: C2, gross_wt: '6.000', net_wt: '6.000' }] })))
      .rejects.toEqual(err(409, 'insufficient_stock'));
  });
});

describe('branch transfers', () => {
  it('number TRF-{BRANCH}-{FY}-{SEQ:5}; approve → dispatch → partial receipt (note) → idempotent re-receive → return the rest', async () => {
    const [a, b, c] = [await tag(), await tag(), await tag()];
    const tr = await run(() => inv.createTransfer(mgr, { from_branch_id: B1, to_branch_id: B2, lines: [{ tag_id: a.id }, { tag_id: b.id }, { tag_id: c.id }] }));
    expect(tr.transfer_no).toMatch(new RegExp(`^TRF-${B1code}-${inv.indianFY(inv.todayIST())}-\\d{5}$`));
    expect(tr.status).toBe('draft');
    await expect(run(() => inv.createTransfer(mgr, { from_branch_id: B1, to_branch_id: B2, lines: [{ tag_id: a.id }] }))).rejects.toEqual(err(409, 'tag_on_transfer'));
    await expect(run(() => inv.dispatchTransfer(mgr, tr.id))).rejects.toEqual(err(409, 'invalid_state'));
    await run(() => inv.approveTransfer(mgr2, tr.id));
    const d = await run(() => inv.dispatchTransfer(mgr, tr.id));
    expect(d.status).toBe('in_transit');
    expect((await tagRow(a.id))).toMatchObject({ status: 'in_transit', branch_id: B1, counter_id: null });
    await expect(run(() => inv.moveStock(mgr, { branch_id: B1, to_counter_id: C2, tag_ids: [a.id] }))).rejects.toEqual(err(409, 'tag_not_available'));
    const la = d.lines.find((l) => l.tag_id === a.id)!.id;
    await expect(run(() => inv.receiveTransfer(mgr, tr.id, { line_ids: [la], note: 'two pieces short' }))).rejects.toEqual(err(403, 'branch_scope'));
    await expect(run(() => inv.receiveTransfer(mgrB2, tr.id, { line_ids: [la] }))).rejects.toEqual(err(422, 'validation_failed'));
    const r1 = await run(() => inv.receiveTransfer(mgrB2, tr.id, { line_ids: [la], note: 'two pieces still in the bag', counter_id: CX }));
    expect(r1.status).toBe('in_transit');
    expect(await tagRow(a.id)).toMatchObject({ status: 'in_stock', branch_id: B2, counter_id: CX });
    const n1 = (await ledgerOf(tr.id)).length;
    await run(() => inv.receiveTransfer(mgrB2, tr.id, { line_ids: [la], note: 'retry of the same receipt', counter_id: CX }));
    expect((await ledgerOf(tr.id)).length).toBe(n1);
    await expect(run(() => inv.returnTransfer(mgrB2, tr.id, 'sending back'))).rejects.toEqual(err(403, 'branch_scope'));
    const ret = await run(() => inv.returnTransfer(mgr, tr.id, 'customer wants them here'));
    expect(ret.status).toBe('returned');
    expect(await tagRow(b.id)).toMatchObject({ status: 'in_stock', branch_id: B1 });
    expect(await tagRow(a.id)).toMatchObject({ status: 'in_stock', branch_id: B2 });
    const l = await ledgerOf(tr.id);
    expect(l.filter((x) => x.movement === 'transfer_out').length).toBe(3);
    expect(l.filter((x) => x.movement === 'transfer_in' && x.branch_id === B2).length).toBe(1);
    expect(l.filter((x) => x.movement === 'transfer_in' && x.branch_id === B1).length).toBe(2);
  });
  it('full receipt closes it; cancel only before dispatch; numbers increase', async () => {
    const t = await tag();
    const tr = await run(() => inv.createTransfer(owner, { from_branch_id: B1, to_branch_id: B2, lines: [{ tag_id: t.id }] }));
    await run(() => inv.approveTransfer(owner, tr.id));
    await run(() => inv.dispatchTransfer(owner, tr.id));
    await expect(run(() => inv.cancelTransfer(owner, tr.id))).rejects.toEqual(err(409, 'invalid_state'));
    expect((await run(() => inv.receiveTransfer(owner, tr.id, { line_ids: tr.lines.map((x) => x.id) }))).status).toBe('received');
    const t2 = await tag();
    const tr2 = await run(() => inv.createTransfer(owner, { from_branch_id: B1, to_branch_id: B2, lines: [{ tag_id: t2.id }] }));
    expect(Number(tr2.transfer_no.slice(-5))).toBe(Number(tr.transfer_no.slice(-5)) + 1);
    expect((await run(() => inv.cancelTransfer(owner, tr2.id))).status).toBe('cancelled');
    expect((await tagRow(t2.id)).status).toBe('in_stock');
    await expect(run(() => inv.createTransfer(owner, { from_branch_id: B1, to_branch_id: B1, lines: [{ tag_id: t2.id }] }))).rejects.toEqual(err(422, 'validation_failed'));
  });
  it('loose stock leaves from a counter / tray (988 from_counter_id/from_box_id): balance checked there, returned there', async () => {
    const C4 = await counter(B1, `C${rnd(4)}`);
    const BOX4 = (await sql<{ id: string }>(`INSERT INTO masters.box(tenant_id, counter_id, code) VALUES ($1, $2, $3) RETURNING id`, [T1, C4, `TR${rnd(5)}`]))[0].id;
    await run(() => inv.receiveLoose(owner, { branch_id: B1, counter_id: C4, tray_id: BOX4, item_id: ITEM_LOOSE, purity_id: P22, gross_wt: '10.000', net_wt: '10.000', pieces: 2 }));
    const line = (g: string, over: Partial<inv.TransferLineInput> = {}) =>
      ({ item_id: ITEM_LOOSE, purity_id: P22, from_counter_id: C4, from_tray_id: BOX4, gross_wt: g, net_wt: g, pieces: 1, ...over });
    await expect(run(() => inv.createTransfer(mgr, { from_branch_id: B1, to_branch_id: B2, lines: [line('4.000', { from_counter_id: null })] })))
      .rejects.toEqual(err(422, 'validation_failed'));
    await expect(run(() => inv.createTransfer(mgr, { from_branch_id: B1, to_branch_id: B2, lines: [line('4.000', { from_counter_id: C2 })] })))
      .rejects.toEqual(err(422, 'location_mismatch'));
    await expect(run(() => inv.createTransfer(mgr, { from_branch_id: B1, to_branch_id: B2, lines: [line('11.000')] }))).rejects.toEqual(err(409, 'insufficient_stock'));
    const bal = async (branch: string, c: string, box: string | null) => (await run(() => inv.looseStock(owner, { branch_id: branch, item_id: ITEM_LOOSE })))
      .find((r) => r.counter_id === c && r.tray_id === box);
    const tr = await run(() => inv.createTransfer(mgr, { from_branch_id: B1, to_branch_id: B2, lines: [line('4.000')] }));
    expect(tr.lines[0]).toMatchObject({ from_counter_id: C4, from_tray_id: BOX4, tag_id: null });
    await run(() => inv.approveTransfer(mgr2, tr.id));
    await run(() => inv.dispatchTransfer(mgr, tr.id));
    expect(await bal(B1, C4, BOX4)).toMatchObject({ pieces: 1, gross_wt: '6.000' });
    await run(() => inv.receiveTransfer(mgrB2, tr.id, { line_ids: [tr.lines[0].id], counter_id: CX }));
    expect(await bal(B2, CX, null)).toMatchObject({ gross_wt: '4.000' });
    const tr2 = await run(() => inv.createTransfer(owner, { from_branch_id: B1, to_branch_id: B2, lines: [line('2.000')] }));
    await run(() => inv.approveTransfer(owner, tr2.id));
    await run(() => inv.dispatchTransfer(owner, tr2.id));
    expect(await bal(B1, C4, BOX4)).toMatchObject({ pieces: 0, gross_wt: '4.000' });
    await run(() => inv.returnTransfer(owner, tr2.id, 'not needed there'));
    expect(await bal(B1, C4, BOX4)).toMatchObject({ pieces: 1, gross_wt: '6.000' });
  });
  it('transfer / adjustment numbers follow shop_setting formats; bad formats → 422', async () => {
    const s = await run(() => inv.getSettings(owner));
    expect(s).toMatchObject({ transfer_no_format: 'TRF-{BRANCH}-{FY}-{SEQ:5}', adjustment_no_format: 'ADJ-{BRANCH}-{FY}-{SEQ:5}' });
    for (const bad of ['TRF-{BRANCH}', 'TRF-{DATE}-{SEQ}', `${'X'.repeat(70)}{SEQ}`])
      await expect(run(() => inv.patchSettings(owner, { transfer_no_format: bad }, s.version))).rejects.toEqual(err(422, 'validation_failed'));
    await expect(run(() => inv.patchSettings(owner, { adjustment_no_format: 'ADJ{SEQ:3}X' }, s.version))).rejects.toEqual(err(422, 'validation_failed'));
    const s2 = await run(() => inv.patchSettings(owner, { transfer_no_format: 'ST/{BRANCH}/{FY}/{SEQ:3}', adjustment_no_format: 'SA-{FY}-{SEQ:4}' }, s.version));
    try {
      const t = await tag();
      const tr = await run(() => inv.createTransfer(owner, { from_branch_id: B1, to_branch_id: B2, lines: [{ tag_id: t.id }] }));
      expect(tr.transfer_no).toMatch(new RegExp(`^ST/${B1code}/${inv.indianFY(inv.todayIST())}/\\d{3,}$`));
      const adj = await run(() => inv.requestAdjustment(mgr, { branch_id: B1, kind: 'weight_loss', tag_id: t.id, delta_gross_wt: '-0.010', delta_net_wt: '-0.010',
        reason_code: 'polishing', reason: 'polish' }));
      expect(adj.adjustment_no).toMatch(new RegExp(`^SA-${inv.indianFY(inv.todayIST())}-\\d{4,}$`));
      await run(() => inv.cancelAdjustment(mgr, adj.id));
      await run(() => inv.cancelTransfer(owner, tr.id));
    } finally {
      await run(() => inv.patchSettings(owner, { transfer_no_format: 'TRF-{BRANCH}-{FY}-{SEQ:5}', adjustment_no_format: 'ADJ-{BRANCH}-{FY}-{SEQ:5}' }, s2.version));
    }
  });
});

describe('stock checks', () => {
  it('0.8.6: start / list / cancel always return counts (zeros when scope has no tagged stock)', async () => {
    const Cempty = await counter(B1, `E${rnd(4)}`);
    const sc = await run(() => inv.startStockCheck(sales, { branch_id: B1, counter_id: Cempty, tray_id: null }));
    expect(sc.counts).toEqual({ expected: 0, scanned: 0, matched: 0, missing: 0, extra: 0 });
    expect(sc.status).toBe('open');
    const got = await run(() => inv.getStockCheck(sales, sc.id));
    expect(got.counts).toEqual({ expected: 0, scanned: 0, matched: 0, missing: 0, extra: 0 });
    const listed = await run(() => inv.listStockChecks(owner, { branch_id: B1, status: 'open', limit: 100 }));
    const hit = listed.items.find((x: { id: string }) => x.id === sc.id) as { counts?: unknown } | undefined;
    expect(hit?.counts).toEqual({ expected: 0, scanned: 0, matched: 0, missing: 0, extra: 0 });
    const report = await run(() => inv.stockCheckReport(sales, sc.id));
    expect(report).toEqual([]);
    const cancelled = await run(() => inv.cancelStockCheck(mgr, sc.id, sc.version));
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.counts).toEqual({ expected: 0, scanned: 0, matched: 0, missing: 0, extra: 0 });
  });
  it('live, idempotent scans by tag_no / HUID; unknown codes are extra; one open check per scope; close raises full write-offs', async () => {
    const [a, b] = [await tag({ counter_id: C3 }), await tag({ counter_id: C3 })];
    const ha = (await sql<{ huid: string }>(`SELECT huid FROM inventory.tag WHERE id = $1`, [a.id]))[0].huid;
    const sc = await run(() => inv.startStockCheck(sales, { branch_id: B1, counter_id: C3 }));
    await expect(run(() => inv.startStockCheck(sales, { branch_id: B1, counter_id: C3 }))).rejects.toEqual(err(409, 'check_already_open'));
    const s1 = await run(() => inv.recordScan(sales, sc.id, a.tag_no.toLowerCase()));
    expect(s1).toMatchObject({ result: 'matched', duplicate: false, tag_id: a.id });
    const s2 = await run(() => inv.recordScan(sales, sc.id, a.tag_no));
    expect(s2).toMatchObject({ duplicate: true, scan_id: s1.scan_id });
    const s3 = await run(() => inv.recordScan(sales, sc.id, ha));
    expect(s3).toMatchObject({ duplicate: true, scan_id: s1.scan_id });
    const x = await run(() => inv.recordScan(sales, sc.id, 'NO-SUCH-CODE'));
    expect(x).toMatchObject({ result: 'extra', extra_reason: 'unknown_code' });
    expect(x.counts).toEqual({ expected: 2, scanned: 2, matched: 1, missing: 1, extra: 1 });
    // live: moving b out of scope drops it from expected
    await run(() => inv.moveStock(sales, { branch_id: B1, to_counter_id: C2, tag_ids: [b.id] }));
    expect((await run(() => inv.getStockCheck(sales, sc.id))).counts).toMatchObject({ expected: 1, missing: 0 });
    await run(() => inv.moveStock(sales, { branch_id: B1, to_counter_id: C3, tag_ids: [b.id] }));
    await expect(run(() => inv.closeStockCheck(sales, sc.id))).rejects.toEqual(err(403, 'forbidden'));
    const closed = await run(() => inv.closeStockCheck(mgr, sc.id, { create_adjustments: true }));
    expect(closed.status).toBe('closed');
    expect(closed.created_adjustment_ids.length).toBe(1);
    const adj = await run(() => inv.getAdjustment(mgr, closed.created_adjustment_ids[0]));
    expect(adj).toMatchObject({ kind: 'full_write_off', tag_id: b.id, status: 'pending', delta_pieces: -1, delta_gross_wt: '-10.000' });
    await expect(run(() => inv.recordScan(sales, sc.id, b.tag_no))).rejects.toEqual(err(409, 'check_closed'));
    await run(() => inv.cancelAdjustment(mgr, adj.id));
  });
});

describe('0.8.2: If-Match, 3-char minimums, extra reasons, tag edits, lists', () => {
  it('transfers: stale version → 412 on approve / dispatch / receive / cancel; partial note min 3', async () => {
    const [a, b] = [await tag(), await tag()];
    const tr = await run(() => inv.createTransfer(mgr, { from_branch_id: B1, to_branch_id: B2, lines: [{ tag_id: a.id }, { tag_id: b.id }] }));
    await expect(run(() => inv.approveTransfer(mgr2, tr.id, tr.version + 1))).rejects.toEqual(err(412, 'version_mismatch'));
    const ap = await run(() => inv.approveTransfer(mgr2, tr.id, tr.version));
    expect(ap.version).toBeGreaterThan(tr.version);
    await expect(run(() => inv.dispatchTransfer(mgr, tr.id, null, tr.version))).rejects.toEqual(err(412, 'version_mismatch'));
    const d = await run(() => inv.dispatchTransfer(mgr, tr.id, null, ap.version));
    const la = d.lines.find((l) => l.tag_id === a.id)!.id;
    await expect(run(() => inv.receiveTransfer(mgrB2, tr.id, { line_ids: [la], note: 'ab' }, d.version))).rejects.toEqual(err(422, 'validation_failed'));
    await expect(run(() => inv.receiveTransfer(mgrB2, tr.id, { line_ids: [la], note: 'one short' }, ap.version))).rejects.toEqual(err(412, 'version_mismatch'));
    const r1 = await run(() => inv.receiveTransfer(mgrB2, tr.id, { line_ids: [la], note: 'abc' }, d.version));
    expect(r1.status).toBe('in_transit');
    expect(r1.version).toBeGreaterThan(d.version);   // partial receipt bumps the header version
    await expect(run(() => inv.returnTransfer(mgr, tr.id, 'no', r1.version))).rejects.toEqual(err(422, 'validation_failed'));
    await expect(run(() => inv.returnTransfer(mgr, tr.id, 'back', d.version))).rejects.toEqual(err(412, 'version_mismatch'));
    expect((await run(() => inv.returnTransfer(mgr, tr.id, 'back', r1.version))).status).toBe('returned');
    const t3 = await tag();
    const tr3 = await run(() => inv.createTransfer(owner, { from_branch_id: B1, to_branch_id: B2, lines: [{ tag_id: t3.id }] }));
    await expect(run(() => inv.cancelTransfer(owner, tr3.id, tr3.version + 5))).rejects.toEqual(err(412, 'version_mismatch'));
    expect((await run(() => inv.cancelTransfer(owner, tr3.id, tr3.version))).status).toBe('cancelled');
  });
  it('tag status: If-Match checked, reason min 3; stock check close / cancel: If-Match; start needs run only', async () => {
    const t = await tag({ counter_id: C3 });
    const v = (await run(() => inv.getTag(owner, t.id))).version;
    await expect(run(() => inv.changeTagStatus(mgr, t.id, 'reserved', 'customer hold', v + 1))).rejects.toEqual(err(412, 'version_mismatch'));
    await expect(run(() => inv.changeTagStatus(mgr, t.id, 'reserved', 'ok', v))).rejects.toEqual(err(422, 'validation_failed'));
    const r = await run(() => inv.changeTagStatus(mgr, t.id, 'reserved', 'yes', v));
    expect(r.version).toBe(v + 1);
    await run(() => inv.changeTagStatus(mgr, t.id, 'in_stock', 'released', r.version));
    // salesperson holds stock_check.run but not close (987 seed)
    expect(SALES).toContain('inventory.stock_check.run');
    expect(SALES).not.toContain('inventory.stock_check.close');
    const C5 = await counter(B1, `K${rnd(4)}`);
    const sc = await run(() => inv.startStockCheck(sales, { branch_id: B1, counter_id: C5 }));
    await expect(run(() => inv.cancelStockCheck(sales, sc.id, sc.version))).rejects.toEqual(err(403, 'forbidden'));
    await expect(run(() => inv.closeStockCheck(mgr, sc.id, {}, sc.version + 1))).rejects.toEqual(err(412, 'version_mismatch'));
    await expect(run(() => inv.cancelStockCheck(mgr, sc.id, sc.version + 1))).rejects.toEqual(err(412, 'version_mismatch'));
    expect((await run(() => inv.closeStockCheck(mgr, sc.id, {}, sc.version))).status).toBe('closed');
  });
  it('stock check extras: wrong_status + note, other_branch, other_location (stable codes)', async () => {
    const C6 = await counter(B1, `W${rnd(4)}`);
    const held = await tag({ counter_id: C6 });
    const v = (await run(() => inv.getTag(owner, held.id))).version;
    await run(() => inv.changeTagStatus(mgr, held.id, 'repair', 'clasp broken', v));
    const away = await tag({ counter_id: C2 });
    const other = await tag({ counter_id: CX }, B2);
    const sc = await run(() => inv.startStockCheck(sales, { branch_id: B1, counter_id: C6 }));
    expect(await run(() => inv.recordScan(sales, sc.id, held.tag_no))).toMatchObject({ result: 'extra', extra_reason: 'wrong_status', extra_note: 'repair' });
    expect(await run(() => inv.recordScan(sales, sc.id, away.tag_no))).toMatchObject({ result: 'extra', extra_reason: 'other_location', extra_note: null });
    expect(await run(() => inv.recordScan(sales, sc.id, other.tag_no))).toMatchObject({ result: 'extra', extra_reason: 'other_branch' });
    const rep = await run(() => inv.stockCheckReport(sales, sc.id, 'extra'));
    expect(rep.every((x) => (inv.EXTRA_REASONS as readonly string[]).includes(x.extra_reason as string))).toBe(true);
    expect(rep.find((x) => x.tag_id === held.id)).toMatchObject({ extra_reason: 'wrong_status', extra_note: 'repair' });
    await run(() => inv.cancelStockCheck(mgr, sc.id));
  });
  it('tag PATCH / bulk update: granted columns only, If-Match per item, all-or-nothing', async () => {
    const [a, b] = [await tag(), await tag()];
    const va = (await run(() => inv.getTag(owner, a.id))).version, vb = (await run(() => inv.getTag(owner, b.id))).version;
    await expect(run(() => inv.patchTag(mgr, a.id, { gross_wt: '1.000' }, va))).rejects.toEqual(err(422, 'validation_failed'));
    await expect(run(() => inv.patchTag(mgr, a.id, { hsn: '7113' }, va + 1))).rejects.toEqual(err(412, 'version_mismatch'));
    await expect(run(() => inv.patchTag(sales, a.id, { hsn: '7113' }, va))).rejects.toEqual(err(403, 'forbidden'));
    await expect(run(() => inv.patchTag(mgr, a.id, { mc_type: 'bogus' }, va))).rejects.toEqual(err(422, 'validation_failed'));
    const pa = await run(() => inv.patchTag(mgr, a.id, { hsn: '7113', size: '12', mc_type: 'percent', mc_value: '12.5', received_on: '2026-04-01' }, va));
    expect(pa.version).toBe(va + 1);
    const row = (await sql<{ hsn: string; size: string; mc_type: string; mc_value: string }>(`SELECT hsn, size, mc_type, mc_value::text FROM inventory.tag WHERE id = $1`, [a.id]))[0];
    expect(row).toMatchObject({ hsn: '7113', size: '12', mc_type: 'percent' });
    expect(Number(row.mc_value)).toBe(12.5);
    // bulk: one stale → 412 naming it, nothing written
    await expect(run(() => inv.bulkUpdateTags(mgr, [{ id: a.id, version: va }, { id: b.id, version: vb }], { size: '14' })))
      .rejects.toEqual(expect.objectContaining({ status: 412, code: 'version_mismatch', errors: [expect.objectContaining({ path: 'items.0.version' })] }));
    expect((await sql<{ size: string | null }>(`SELECT size FROM inventory.tag WHERE id = $1`, [b.id]))[0].size).not.toBe('14');
    await expect(run(() => inv.bulkUpdateTags(mgr, [{ id: a.id, version: va + 1 }], { stones: [] })))
      .rejects.toEqual(expect.objectContaining({ status: 422, errors: [expect.objectContaining({ code: 'field_not_editable' })] }));
    await expect(run(() => inv.bulkUpdateTags(mgr, [{ id: a.id, version: va + 1 }, { id: a.id, version: va + 1 }], { size: '14' }))).rejects.toEqual(err(422, 'validation_failed'));
    const up = await run(() => inv.bulkUpdateTags(mgr, [{ id: a.id, version: va + 1 }, { id: b.id, version: vb }], { size: '14' }));
    expect(up.map((x) => x.version).sort()).toEqual([va + 2, vb + 1].sort());
  });
  it('tag create takes descriptive TagInput fields; adjustment reject note min 3; If-Match on adjustments', async () => {
    const t = await tag({ hsn: '711319', huid_charge: '45', min_sale_value: '1000', cost_value: '500', cover_wt: '0.100' });
    const r = (await sql<{ hsn: string; huid_charge: string; cover_wt: string }>(`SELECT hsn, huid_charge::text, cover_wt::text FROM inventory.tag WHERE id = $1`, [t.id]))[0];
    expect(r.hsn).toBe('711319');
    expect(Number(r.huid_charge)).toBe(45);
    expect(Number(r.cover_wt)).toBe(0.1);
    const adj = await run(() => inv.requestAdjustment(mgr, { branch_id: B1, kind: 'weight_loss', tag_id: t.id, delta_gross_wt: '-0.010', delta_net_wt: '-0.010',
      reason_code: 'polishing', reason: 'pol' }));
    await expect(run(() => inv.rejectAdjustment(mgr2, adj.id, 'no'))).rejects.toEqual(err(422, 'validation_failed'));
    await expect(run(() => inv.rejectAdjustment(mgr2, adj.id, 'nah', adj.version + 1))).rejects.toEqual(err(412, 'version_mismatch'));
    expect((await run(() => inv.rejectAdjustment(mgr2, adj.id, 'nah', adj.version))).status).toBe('rejected');
  });
  it('lists: keyset pages, filters and branch scope; ledger direction in / out', async () => {
    for (let k = 0; k < 3; k++) await tag({ counter_id: C3 });
    const p1 = await run(() => inv.listTags(owner, { branch_id: B1, counter_id: C3, limit: 2 }));
    expect(p1.items.length).toBe(2);
    expect(p1.next_cursor).toBe(p1.items[1].id);
    const p2 = await run(() => inv.listTags(owner, { branch_id: B1, counter_id: C3, limit: 2, cursor: p1.next_cursor }));
    expect(p2.items.some((x) => p1.items.some((y) => y.id === x.id))).toBe(false);
    expect([...p1.items, ...p2.items].every((x) => x.branch_id === B1)).toBe(true);
    await expect(run(() => inv.listTags(owner, { limit: 0 }))).rejects.toEqual(err(422, 'validation_failed'));
    await expect(run(() => inv.listTags(owner, { cursor: 'nope' }))).rejects.toEqual(err(422, 'validation_failed'));
    await expect(run(() => inv.listTags(mgrB2, { branch_id: B1 }))).rejects.toEqual(err(403, 'branch_scope'));
    const scoped = await run(() => inv.listTags(mgrB2, { limit: 200 }));
    expect(scoped.items.every((x) => x.branch_id === B2)).toBe(true);
    const st = await run(() => inv.listTags(owner, { branch_id: B1, status: ['in_stock'], limit: 5 }));
    expect(st.items.every((x) => x.status === 'in_stock')).toBe(true);
    const led = await run(() => inv.listLedger(owner, { branch_id: B1, limit: 20 }));
    expect(led.items.length).toBeGreaterThan(0);
    expect(led.items.every((x) => x.direction === 'in' || x.direction === 'out')).toBe(true);
    const trs = await run(() => inv.listTransfers(owner, { branch_id: B1, direction: 'out', limit: 5 }));
    expect(trs.items.every((x) => x.from_branch_id === B1)).toBe(true);
    const adjs = await run(() => inv.listAdjustments(owner, { status: 'rejected', limit: 5 }));
    expect(adjs.items.every((x) => x.status === 'rejected')).toBe(true);
    expect((await run(() => inv.listStockChecks(owner, { branch_id: B1, limit: 5 }))).items.length).toBeGreaterThan(0);
  });
  it('platform stock import routes through Inventory (registered importer; all-or-nothing)', async () => {
    const tagNo = `IMP${rnd(6)}`;
    const row = { tag_no: tagNo, item_id: ITEM_TAG, purity_id: P22, gross_wt: '5.000', stone_wt: '0.000', net_wt: '5.000', huid: huid(),
      hallmark_exempt: false, pieces: 1, mc_type: 'per_gram', mc_value: '300', wastage_pct: '0', huid_charge: '45' };
    const src = (await sql<{ id: string }>(`SELECT gen_random_uuid() AS id`))[0].id;
    await run(() => inv.stockImportViaInventory([row], { auth: owner as never, branchId: B1, sourceId: src }));
    const got = await sql<{ id: string; status: string }>(`SELECT id, status FROM inventory.tag WHERE tag_no = $1`, [tagNo]);
    expect(got).toHaveLength(1);
    expect((await sql<{ movement: string }>(`SELECT movement FROM inventory.stock_ledger WHERE tag_id = $1`, [got[0].id])).map((x) => x.movement)).toEqual(['opening']);
    // a duplicate row → 409 import_rows_rejected and the request tx rolls back
    await expect(run(() => inv.stockImportViaInventory([{ ...row, huid: huid() }], { auth: owner as never, branchId: B1, sourceId: src })))
      .rejects.toMatchObject({ status: 409 });
  });
});

describe('adjustments: approval rules and write-offs', () => {
  const wl = (t: string): inv.AdjustmentInput => ({ branch_id: B1, kind: 'weight_loss', tag_id: t, delta_gross_wt: '-0.200', delta_net_wt: '-0.200',
    reason_code: 'polishing', reason: 'polishing loss' });
  it('ADJ number; manager request → another manager approves → applied as inventory_writer with ledger', async () => {
    const t = await tag();
    const r = await run(() => inv.requestAdjustment(mgr, wl(t.id)));
    expect(r.adjustment_no).toMatch(new RegExp(`^ADJ-${B1code}-${inv.indianFY(inv.todayIST())}-\\d{5}$`));
    expect(r.approval_request_id).toBeNull();
    expect((await tagRow(t.id)).gross_wt).toBe('10.000');
    const ob = await sql(`SELECT 1 FROM notifications.outbox WHERE topic = 'inventory.adjustment_pending' AND payload->>'adjustment_id' = $1`, [r.id]);
    expect(ob.length).toBe(1);
    const ok = await run(() => inv.approveAdjustment(mgr2, r.id, 'checked'));
    expect(ok).toMatchObject({ status: 'approved', decided_by: mgr2.userId, decided_as_role: 'manager' });
    expect(await tagRow(t.id)).toMatchObject({ gross_wt: '9.800', net_wt: '9.300', status: 'in_stock' });
    expect((await ledgerOf(r.id)).map((l) => `${l.movement}:${l.direction}:${l.gross_wt}`)).toEqual(['adjustment:-1:0.200']);
    await expect(run(() => inv.approveAdjustment(mgr2, r.id))).rejects.toEqual(err(409, 'invalid_state'));
  });
  it('self-approval: manager refused; owner allowed and audited as self_approved', async () => {
    const t = await tag();
    const m = await run(() => inv.requestAdjustment(mgr, wl(t.id)));
    await expect(run(() => inv.approveAdjustment(mgr, m.id))).rejects.toEqual(err(403, 'self_approval'));
    await expect(run(() => inv.approveAdjustment(sales, m.id))).rejects.toEqual(err(403, 'forbidden'));
    await expect(run(() => inv.approveAdjustment(mgrB2, m.id))).rejects.toEqual(err(403, 'branch_scope'));
    await run(() => inv.rejectAdjustment(owner, m.id, 'not needed after all'));
    const o = await run(() => inv.requestAdjustment(owner, wl(t.id)));
    expect((await run(() => inv.approveAdjustment(owner, o.id))).decided_as_role).toBe('owner');
    const a = await asMigrator<{ new_row: Record<string, unknown> }>(`SELECT new_row FROM platform.audit_event WHERE action = 'inventory.adjustment.self_approved' AND row_id = $1`, [o.id]);
    expect(a.length).toBe(1);
    expect(a[0].new_row).toMatchObject({ kind: 'weight_loss', decided_as_role: 'owner' });
  });
  it('owner_only: managers refused (403 approver_rule), owner approves', async () => {
    const t = await tag();
    const r = await run(() => inv.requestAdjustment(mgr, wl(t.id)));
    let s = await run(() => inv.getSettings(owner));
    await run(() => inv.patchSettings(owner, { adjustment_approver: 'owner_only' }, s.version));
    try {
      await expect(run(() => inv.approveAdjustment(mgr2, r.id))).rejects.toEqual(err(403, 'approver_rule'));
      expect((await run(() => inv.approveAdjustment(owner, r.id))).status).toBe('approved');
    } finally {
      s = await run(() => inv.getSettings(owner));
      await run(() => inv.patchSettings(owner, { adjustment_approver: 'owner_or_manager' }, s.version));
    }
  });
  it('sign rules: partial write_off may not zero a piece (use_full_write_off); full_write_off needs the exact full deltas and a tag', async () => {
    const t = await tag();
    const base = { branch_id: B1, tag_id: t.id, reason_code: 'breakage' as const, reason: 'broken clasp' };
    await expect(run(() => inv.requestAdjustment(mgr, { ...base, kind: 'write_off', delta_pieces: -1 }))).rejects.toEqual(err(422, 'use_full_write_off'));
    await expect(run(() => inv.requestAdjustment(mgr, { ...base, kind: 'full_write_off', delta_pieces: -1, delta_gross_wt: '-5.000', delta_net_wt: '-5.000' })))
      .rejects.toEqual(err(422, 'invalid_delta'));
    await expect(run(() => inv.requestAdjustment(mgr, { ...base, kind: 'weight_gain', delta_gross_wt: '-1.000' }))).rejects.toEqual(err(422, 'invalid_delta'));
    await expect(run(() => inv.requestAdjustment(mgr, { ...base, tag_id: null, item_id: ITEM_LOOSE, purity_id: P22, kind: 'full_write_off', delta_pieces: -1, delta_gross_wt: '-1.000' })))
      .rejects.toEqual(err(422, 'validation_failed'));
  });
  it('approved full_write_off → written_off (inventory_writer) + ledger; the piece never moves, transfers or changes again', async () => {
    const t = await tag();
    const fw = { branch_id: B1, kind: 'full_write_off' as const, tag_id: t.id, delta_pieces: -1, delta_gross_wt: '-10.000', delta_net_wt: '-9.500',
      reason_code: 'loss' as const, reason: 'lost during exhibition' };
    const r = await run(() => inv.requestAdjustment(mgr, fw));
    await expect(run(() => inv.requestAdjustment(mgr2, fw))).rejects.toEqual(err(409, 'adjustment_pending'));
    expect((await tagRow(t.id)).status).toBe('in_stock');
    await run(() => inv.approveAdjustment(mgr2, r.id));
    expect(await tagRow(t.id)).toMatchObject({ status: 'written_off', pieces: 1, gross_wt: '10.000' });
    expect((await ledgerOf(r.id)).map((l) => `${l.movement}:${l.direction}:${l.pieces}:${l.gross_wt}`)).toEqual(['adjustment:-1:1:10.000']);
    await expect(run(() => inv.moveStock(owner, { branch_id: B1, to_counter_id: C2, tag_ids: [t.id] }))).rejects.toEqual(err(409, 'tag_written_off'));
    await expect(run(() => inv.createTransfer(owner, { from_branch_id: B1, to_branch_id: B2, lines: [{ tag_id: t.id }] }))).rejects.toEqual(err(409, 'tag_written_off'));
    for (const s of ['in_stock', 'reserved', 'repair'] as const)
      await expect(run(() => inv.changeTagStatus(owner, t.id, s, 'found it'))).rejects.toEqual(err(409, 'tag_written_off'));
    await expect(run(() => inv.transitionTag(t.id, 'sold', 'sale'))).rejects.toEqual(err(409, 'tag_written_off'));
    await expect(run(() => inv.requestAdjustment(owner, { ...fw, kind: 'weight_gain', delta_pieces: 0, delta_gross_wt: '1.000', delta_net_wt: '1.000' })))
      .rejects.toEqual(err(409, 'tag_written_off'));
    const dflt = await run(() => inv.listTags(owner, { branch_id: B1, limit: 200 }));
    expect(dflt.items.some((x) => x.id === t.id)).toBe(false);
    expect(dflt.items.every((x) => !['sold', 'melted', 'returned_to_vendor', 'written_off'].includes(x.status))).toBe(true);
    const wo = await run(() => inv.listTags(owner, { branch_id: B1, status: ['written_off'], limit: 200 }));
    expect(wo.items.map((x) => x.id)).toContain(t.id);
    expect(wo.items.every((x) => x.status === 'written_off')).toBe(true);
    const mix = await run(() => inv.listTags(owner, { branch_id: B1, status: ['in_stock', 'written_off'], limit: 200 }));
    expect(mix.items.map((x) => x.id)).toContain(t.id);
    const val = await run(() => inv.stockValuation(owner, { branch_id: B1, group_by: 'purity', include_loose: false }));
    const ids = await sql<{ n: number }>(`SELECT count(*)::int n FROM inventory.v_stock_valuation WHERE tag_id = $1`, [t.id]);
    expect(ids[0].n).toBe(0);
    expect(val.value_basis).toBe('metal');
    expect(val.includes).toEqual({ metal: true, loose: false, stone_value: false, making: false, gst: false });
  });
  it('a stale full write-off (piece changed since the request) is refused with 409 adjustment_stale', async () => {
    const t = await tag();
    const r = await run(() => inv.requestAdjustment(mgr, { branch_id: B1, kind: 'full_write_off', tag_id: t.id, delta_pieces: -1, delta_gross_wt: '-10.000',
      delta_net_wt: '-9.500', reason_code: 'loss', reason: 'missing piece' }));
    const w = await run(() => inv.requestAdjustment(mgr, wl(t.id)));
    await run(() => inv.approveAdjustment(owner, w.id));
    await expect(run(() => inv.approveAdjustment(mgr2, r.id))).rejects.toEqual(err(409, 'adjustment_stale'));
  });
  it('rerun regression — isolated loose adjustment checks the balance and posts exact signed ledger rows', async () => {
    const isolatedCounter=await counter(B1,`AJ${rnd(5)}`);
    await run(() => inv.receiveLoose(owner, { branch_id: B1, counter_id:isolatedCounter, item_id: ITEM_LOOSE, purity_id: P22, gross_wt: '2.000', net_wt: '2.000' }));
    await expect(run(() => inv.requestAdjustment(mgr, { branch_id: B1, counter_id:isolatedCounter, kind: 'weight_loss', item_id: ITEM_LOOSE, purity_id: P22, delta_gross_wt: '-50.000',
      reason_code: 'melting_loss', reason: 'too much' }))).rejects.toEqual(err(409, 'insufficient_stock'));
    const r = await run(() => inv.requestAdjustment(mgr, { branch_id: B1, counter_id:isolatedCounter, kind: 'weight_loss', item_id: ITEM_LOOSE, purity_id: P22, delta_gross_wt: '-0.500',
      delta_net_wt: '-0.500', reason_code: 'melting_loss', reason: 'dust' }));
    await run(() => inv.approveAdjustment(mgr2, r.id));
    const bal = (await run(() => inv.looseStock(owner, { branch_id: B1, counter_id:isolatedCounter, item_id: ITEM_LOOSE }))).find((x) => x.counter_id === isolatedCounter);
    expect(bal).toMatchObject({ gross_wt:'1.500',net_wt:'1.500' });
    expect(await sql(`SELECT direction,gross_wt::text,net_wt::text FROM inventory.stock_ledger WHERE source_id=$1`,[r.id]))
      .toEqual([{direction:-1,gross_wt:'0.500',net_wt:'0.500'}]);
  });
});

describe('labels, photos, valuation, ageing', () => {
  it('labels: printed once, then reprint must be explicit', async () => {
    const t = await tag();
    const p = await run(() => inv.printLabels(sales, [t.id]));
    expect(p.labels[0]).toMatchObject({ tag_no: t.tag_no, label_print_count: 1, barcode_payload: t.tag_no });
    await expect(run(() => inv.printLabels(sales, [t.id]))).rejects.toEqual(err(409, 'already_printed'));
    expect((await run(() => inv.printLabels(sales, [t.id], { reprint: true, copies: 2, reprint_reason: 'label smudged' }))).labels[0].label_print_count).toBe(3);
  });
  /** The labels POST body goes through the controller's zod schema (inv.LabelsIn), then the service — as the HTTP route does. */
  const labelsPost = async (by: InventoryActor, body: Record<string, unknown>) => {
    const b = inv.LabelsIn.safeParse(body);
    if (!b.success) throw { status: 422, code: 'validation_failed', issues: b.error.issues };
    return run(() => inv.printLabels(by, b.data.tag_ids, b.data));
  };
  it('0.8.7 labels: a normal print accepts reprint_reason null or missing', async () => {
    const [a, b] = [await tag(), await tag()];
    expect((await labelsPost(sales, { tag_ids: [a.id], copies: 1, reprint: false, reprint_reason: null })).labels[0]).toMatchObject({ tag_id: a.id, label_print_count: 1 });
    expect((await labelsPost(sales, { tag_ids: [b.id], reprint: false })).labels[0]).toMatchObject({ tag_id: b.id, label_print_count: 1 });
  });
  it('0.8.7 labels: reprint:true without a reason (null / missing / blank) → 422 reprint_reason; with a reason it prints and audits it', async () => {
    const t = await tag();
    await labelsPost(sales, { tag_ids: [t.id], reprint_reason: null });
    for (const body of [{ reprint_reason: null }, {}, { reprint_reason: '   ' }]) {
      const e = await labelsPost(sales, { tag_ids: [t.id], reprint: true, ...body }).then(() => null, (x) => x);
      expect(e).toMatchObject({ status: 422, code: 'validation_failed', errors: [expect.objectContaining({ path: 'reprint_reason' })] });
    }
    expect((await sql<{ n: number }>(`SELECT label_print_count AS n FROM inventory.tag WHERE id = $1`, [t.id]))[0].n).toBe(1);
    const r = await labelsPost(sales, { tag_ids: [t.id], reprint: true, reprint_reason: '  torn label  ' });
    expect(r.labels[0]).toMatchObject({ label_print_count: 2 });
    const au = await asMigrator<{ new_row: { reason: string } }>(`SELECT new_row FROM platform.audit_event WHERE action = 'inventory.label.reprint' AND new_row->'tag_ids' ? $1`, [t.id]);
    expect(au.map((x) => x.new_row.reason)).toEqual(['torn label']);
  });
  it('0.8.7 tag GET / lookup / list return barcode_payload, mc_type, mc_value, wastage_pct, tray_id for a tag with a making charge', async () => {
    const t = await tag({ mc_type: 'flat', mc_value: '350.00', wastage_pct: '8.5', box_id: BOX1 });
    const want = { id: t.id, tag_no: t.tag_no, barcode_payload: t.tag_no, mc_type: 'flat', mc_value: '350.00', wastage_pct: '8.500', tray_id: BOX1 };
    const REQUIRED = ['id', 'tag_no', 'barcode_payload', 'status', 'branch_id', 'item_id', 'purity_id', 'pieces', 'gross_wt', 'net_wt', 'version'];
    const g = await run(() => inv.getTag(owner, t.id));
    const l = await run(() => inv.lookupTag(owner, t.tag_no));
    const li = (await run(() => inv.listTags(owner, { branch_id: B1, tray_id: BOX1, limit: 200 }))).items.find((x) => x.id === t.id);
    for (const v of [g, l, li]) {
      expect(v).toMatchObject(want);
      for (const k of REQUIRED) expect(v![k as keyof typeof v], k).not.toBeUndefined();
      expect(v).not.toHaveProperty('box_id');
    }
  });
  it('0.8.9 tag GET / lookup / list always return label_print_count and label_printed_at (0 / null → 1 / set → 2 / later or equal)', async () => {
    const t = await tag({ box_id: BOX1 });
    const read = async () => {
      const g = await run(() => inv.getTag(owner, t.id));
      const l = await run(() => inv.lookupTag(owner, t.tag_no));
      const li = (await run(() => inv.listTags(owner, { branch_id: B1, tray_id: BOX1, limit: 200 }))).items.find((x) => x.id === t.id)!;
      for (const v of [g, l, li]) {
        expect(v).toHaveProperty('label_print_count');
        expect(v).toHaveProperty('label_printed_at');
        expect(typeof v.label_print_count).toBe('number');
        expect([v.label_print_count, v.label_printed_at]).toEqual([g.label_print_count, g.label_printed_at]);
      }
      return g;
    };
    expect(await read()).toMatchObject({ label_print_count: 0, label_printed_at: null });
    await run(() => inv.printLabels(sales, [t.id]));
    const one = await read();
    expect(one.label_print_count).toBe(1);
    expect(one.label_printed_at).toEqual(expect.any(String));
    // 0.9.0: RFC 3339 in UTC with microseconds (was timestamptz::text "2026-11-09 18:46:01.792494+05:30"); same instant as the column
    expect(one.label_printed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    const [db] = await sql<{ same: boolean }>(`SELECT label_printed_at = $2::timestamptz AS same FROM inventory.tag WHERE id = $1`, [t.id, one.label_printed_at]);
    expect(db.same).toBe(true);
    await run(() => inv.printLabels(sales, [t.id], { reprint: true, reprint_reason: 'label smudged' }));
    const two = await read();
    expect(two.label_print_count).toBe(2);
    const [cmp] = await sql<{ ok: boolean }>(`SELECT $2::timestamptz >= $1::timestamptz AS ok`, [one.label_printed_at, two.label_printed_at]);
    expect(cmp.ok).toBe(true);
  });
  it('photos are off by default → 409 feature_disabled', async () => {
    const t = await tag();
    await expect(run(() => inv.addTagPhoto(owner, t.id, C001))).rejects.toEqual(err(409, 'feature_disabled'));
  });
  it('valuation: total_value with value_basis metal, today rate', async () => {
    // The seed's 7000 sale rate is dated the day the TEST DB was built; on a non-reset TEST DB (QA-GATE-1) make sure T1 has it for TODAY (IST).
    await withTenantTx(mig, { tenantId: T1 }, (c) => c.query(`INSERT INTO rates.metal_rate(tenant_id, purity_id, kind, rate_date, effective_from, rate_per_g)
      SELECT $1, $2, 'sale', (now() AT TIME ZONE 'Asia/Kolkata')::date, now() - interval '1 minute', 7000
      WHERE NOT EXISTS (SELECT 1 FROM rates.metal_rate WHERE tenant_id = $1 AND purity_id = $2 AND kind = 'sale' AND rate_date = (now() AT TIME ZONE 'Asia/Kolkata')::date)`, [T1, P22]));
    const v = await run(() => inv.stockValuation(owner, { branch_id: B1, group_by: 'purity' }));
    const row = v.rows.find((r) => r.purity_id === P22)!;
    expect(row).toMatchObject({ value_basis: 'metal' });
    expect(Number(row.rate_per_g)).toBe(7000);
    expect(row.total_value).toBe(row.metal_value);
    expect(v.totals).toMatchObject({ value_basis: 'metal' });
    await expect(run(() => inv.stockValuation(sales))).rejects.toEqual(err(403, 'forbidden'));
  });
  it('ageing: off → 409; on → age_basis received (received_on) vs tagged (IST tagged date)', async () => {
    await expect(run(() => inv.stockAgeing(owner))).rejects.toEqual(err(409, 'feature_disabled'));
    let s = await run(() => inv.getSettings(owner));
    await run(() => inv.patchSettings(owner, { ageing_enabled: true, ageing_bucket_days: [90, 30, 30] }, s.version));
    try {
      const old = await tag({ received_on: '2026-01-10' });
      const fresh = await tag();
      const rep = await run(() => inv.stockAgeing(owner, { branch_id: B1, include_rows: true, limit: 500 }));
      expect(rep).toMatchObject({ basis: 'received_or_tagged', bucket_days: [30, 90], as_of: inv.todayIST() });
      const ro = rep.rows!.find((r) => r.tag_id === old.id)!, rf = rep.rows!.find((r) => r.tag_id === fresh.id)!;
      expect(ro).toMatchObject({ age_basis: 'received', since: '2026-01-10' });
      expect(rf).toMatchObject({ age_basis: 'tagged', since: inv.todayIST(), age_days: 0 });
      expect(rep.totals.map((b) => [b.from_days, b.to_days])).toEqual([[0, 29], [30, 89], [90, null]]);
      expect(rep.totals.map((b) => b.label)).toEqual(['0–29 days', '30–89 days', '90+ days']);
      expect(rep.totals[0].code).toBe('0_29');
    } finally {
      s = await run(() => inv.getSettings(owner));
      await run(() => inv.patchSettings(owner, { ageing_enabled: false }, s.version));
    }
  });
});

describe('tenant isolation (forced RLS) and branch scope', () => {
  it('tenant 2 cannot see or use tenant 1 inventory', async () => {
    const t = await tag();
    const t2owner: InventoryActor = { ...owner };
    await expect(run(() => inv.getTag(t2owner, t.id), T2)).rejects.toEqual(err(404, 'not_found'));
    await expect(run(() => inv.lookupTag(t2owner, t.tag_no), T2)).rejects.toEqual(err(404, 'not_found'));
    await expect(run(() => inv.moveStock(t2owner, { branch_id: B1, to_counter_id: null, tag_ids: [t.id] }), T2)).rejects.toEqual(err(404, 'not_found'));
    await expect(run(() => inv.createTags(t2owner, '00000000-0000-0000-0000-00000000b002', [{ item_id: ITEM_TAG, gross_wt: '1.000', huid: huid() }]), T2))
      .rejects.toEqual(err(422, 'unknown_reference'));
    for (const tbl of ['inventory.stock_adjustment', 'inventory.stock_transfer', 'inventory.location_move', 'inventory.stock_take', 'inventory.tag_counter', 'inventory.shop_setting'])
      expect((await sql<{ n: number }>(`SELECT count(*)::int n FROM ${tbl}`, [], T2))[0].n, tbl).toBe(0);
    expect((await run(() => inv.getSettings(t2owner), T2)).source).toBe('default');
  });
  it('branch-scoped manager cannot read another branch\'s pieces', async () => {
    const t = await tag({ counter_id: CX }, B2);
    await expect(run(() => inv.getTag(mgr, t.id))).rejects.toEqual(err(404, 'not_found'));
    expect((await run(() => inv.getTag(mgrB2, t.id))).branch_id).toBe(B2);
  });
});
