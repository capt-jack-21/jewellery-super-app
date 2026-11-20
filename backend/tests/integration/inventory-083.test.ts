import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { withTenantTx } from '@jw/db';
import * as inv from '@jw/mod-inventory';
import type { InventoryActor } from '@jw/mod-inventory';
import { huidGen, HUID_PREFIX } from './huid';
import { pool, T1, T2, U1, B1 } from './env';

/** 0.8.3: the twelve operations that were 501 in 0.8.2, vendor_lot_ref (987), and the lead's 0.8.3 decisions. */

/** Inventory service layer (contract 0.8.3, data model 987-989) against the test DB as app_rw + inventory_writer. */
const rw = pool('app_rw');
const mig = pool('app_migrator');
afterAll(async () => { await rw.end(); await mig.end(); });

const ITEM_TAG = '00000000-0000-0000-0000-000000000901';   // seed RING (tag, 22K, HUID required)
const ITEM_LOOSE = '00000000-0000-0000-0000-000000000902'; // seed COIN (non_tag)
const P22 = '00000000-0000-0000-0000-000000000022';
const C001 = '00000000-0000-0000-0000-00000000c001';
const rnd = (n: number) => Array.from({ length: n }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(Math.random() * 24)]).join('');
const huid = huidGen(HUID_PREFIX.inventory083);

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
/** Raw DELETE as app_rw in a tenant tx: RLS refusals show up as rowCount 0, not as an error. */
const rawDelete = (table: string, id: string, tenantId = T1): Promise<number> =>
  withTenantTx(rw, { tenantId }, async (c) => (await c.query(`DELETE FROM inventory.${table} WHERE id = $1`, [id])).rowCount ?? 0);
const keep = (ls: inv.Lot['lines']) => ls.map(({ id, item_id, pieces, gross_wt, stone_wt, net_wt }) => ({ id, item_id, pieces, gross_wt, stone_wt, net_wt }));

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
  await run(() => inv.patchSettings(owner, { tag_format: { prefix: `J${rnd(3)}`, separator: '-', branch_segment: true, item_segment: false, digits: 5, start_no: 1 },
    adjustment_approver: 'owner_or_manager', photos_enabled: false, ageing_enabled: false }, cur.source === 'shop' ? cur.version : null));
});


const t2 = (): InventoryActor => ({ ...owner });
const lineIn = (over: Partial<inv.LotLineInput> = {}): inv.LotLineInput => ({ item_id: ITEM_TAG, pieces: 2, gross_wt: '20.000', stone_wt: '1.000', net_wt: '19.000', ...over });
async function setSettings(p: Record<string, unknown>) {
  const s = await run(() => inv.getSettings(owner));
  await run(() => inv.patchSettings(owner, p, s.version));
}

describe('lots: create / get / list / update / close', () => {
  it('createLot numbers LOT-{BRANCH}-{FY}-{SEQ:5}, totals as decimal strings, 403 without tag.create, 403 branch_scope', async () => {
    const l = await run(() => inv.createLot(mgr, { branch_id: B1, ref_invoice_no: 'INV-77', lines: [lineIn(), lineIn({ pieces: 1, gross_wt: '5.5', stone_wt: '0', net_wt: '5.5' })] }));
    expect(l.lot_no).toMatch(new RegExp(`^LOT-${B1code}-${inv.indianFY(inv.todayIST())}-\\d{5}$`));
    expect(l).toMatchObject({ status: 'open', entry_type: 'other', branch_id: B1, version: expect.any(Number) });
    expect(l.lines).toHaveLength(2);
    expect(l.totals).toEqual({ pieces: 3, gross_wt: '25.500', net_wt: '24.500', tagged_pieces: 0, remaining_gross_wt: '25.500' });
    expect(l.lines[1]).toMatchObject({ gross_wt: '5.500', remaining_pieces: 1, tagged_pieces: 0, purity_id: P22 });
    await expect(run(() => inv.createLot(sales, { branch_id: B1, lines: [lineIn()] }))).rejects.toEqual(err(403, 'forbidden'));
    await expect(run(() => inv.createLot(mgr, { branch_id: B2, lines: [lineIn()] }))).rejects.toEqual(err(403, 'branch_scope'));
    await expect(run(() => inv.createLot(mgr, { branch_id: B1, lines: [lineIn({ net_wt: '25.000' })] }))).rejects.toEqual(err(422, 'invalid_weights'));
    await expect(run(() => inv.createLot(mgr, { branch_id: B1, lot_no: l.lot_no, lines: [lineIn()] }))).rejects.toEqual(err(409, 'duplicate_lot_no'));
    expect((await run(() => inv.getLot(sales, l.id))).lot_no).toBe(l.lot_no);
    await expect(run(() => inv.getLot(mgrB2, l.id))).rejects.toEqual(err(404, 'not_found'));
  });
  it('listLots: prefix q on lot_no / ref_invoice_no, status filter, ids, keyset pages', async () => {
    const ref = `REF${rnd(6)}`;
    const a = await run(() => inv.createLot(mgr, { branch_id: B1, ref_invoice_no: ref, lines: [lineIn()] }));
    const b = await run(() => inv.createLot(mgr, { branch_id: B1, ref_invoice_no: ref, lines: [lineIn()] }));
    const found = await run(() => inv.listLots(sales, { q: ref.toLowerCase() }));
    expect(found.items.map((x) => x.id)).toEqual([b.id, a.id]);
    expect(found.items[0].lines).toHaveLength(1);
    const p1 = await run(() => inv.listLots(sales, { q: ref, limit: 1 }));
    expect(p1.items.map((x) => x.id)).toEqual([b.id]);
    const p2 = await run(() => inv.listLots(sales, { q: ref, limit: 1, cursor: p1.next_cursor! }));
    expect(p2.items.map((x) => x.id)).toEqual([a.id]);
    expect((await run(() => inv.listLots(sales, { ids: [a.id], status: 'closed' }))).items).toEqual([]);
    expect((await run(() => inv.listLots(mgrB2, { q: ref }))).items).toEqual([]);
  });
  it('updateLot: stale version → 412, add / change lines, below_tagged; tagging marks the lot tagged; lot_line_exhausted', async () => {
    const l = await run(() => inv.createLot(mgr, { branch_id: B1, lines: [lineIn({ pieces: 1, gross_wt: '10.000', stone_wt: '0.500', net_wt: '9.500' })] }));
    await expect(run(() => inv.updateLot(mgr, l.id, { ref_invoice_no: 'X' }, l.version - 1))).rejects.toEqual(err(412, 'version_mismatch'));
    const u = await run(() => inv.updateLot(mgr, l.id, { ref_invoice_no: 'INV-9', lines: [{ id: l.lines[0].id, ...lineIn({ pieces: 2 }) }, lineIn({ pieces: 1, gross_wt: '3.000', stone_wt: '0', net_wt: '3.000' })] }, l.version));
    expect(u.version).toBeGreaterThan(l.version);
    expect(u).toMatchObject({ ref_invoice_no: 'INV-9', totals: { pieces: 3 } });
    const [L1, L2] = u.lines;
    await tag({ lot_line_id: L1.id });
    await expect(run(() => inv.createTags(owner, B2, [{ item_id: ITEM_TAG, gross_wt: '10.000', huid: huid(), counter_id: CX, lot_line_id: L1.id }]))).rejects.toEqual(err(422, 'location_mismatch'));
    let cur = await run(() => inv.getLot(mgr, l.id));
    expect(cur.lines[0]).toMatchObject({ tagged_pieces: 1, remaining_pieces: 1 });
    await expect(run(() => inv.updateLot(mgr, l.id, { lines: [{ id: L1.id, item_id: ITEM_TAG, pieces: 0, gross_wt: '10.000', net_wt: '10.000' },
      { id: L2.id, item_id: ITEM_TAG, pieces: 1, gross_wt: '3.000', net_wt: '3.000' }] }, cur.version))).rejects.toEqual(err(422, 'below_tagged'));
    await tag({ lot_line_id: L1.id });
    await expect(tag({ lot_line_id: L1.id })).rejects.toEqual(err(422, 'lot_line_exhausted'));
    expect((await run(() => inv.getLot(mgr, l.id))).status).toBe('open');
    await tag({ lot_line_id: L2.id, gross_wt: '3.000', stone_wt: '0' });
    cur = await run(() => inv.getLot(mgr, l.id));
    expect(cur.status).toBe('tagged');
    await expect(run(() => inv.updateLot(mgr, l.id, { ref_invoice_no: 'Y' }, cur.version))).rejects.toEqual(err(409, 'lot_not_open'));
  });
  it('closeLot: If-Match (stale → 412); remainder none with stock left → 409; to_loose posts non_tag_in from the lot line; closed is idempotent; tags refuse closed lots', async () => {
    const l = await run(() => inv.createLot(mgr, { branch_id: B1, lines: [lineIn({ item_id: ITEM_LOOSE, purity_id: P22, pieces: 0, gross_wt: '50.000', stone_wt: '0', net_wt: '50.000' })] }));
    await expect(run(() => inv.closeLot(mgr, l.id, { remainder: 'to_loose', counter_id: C1 }, l.version + 1))).rejects.toEqual(err(412, 'version_mismatch'));
    await expect(run(() => inv.closeLot(mgr, l.id, { remainder: 'none' }, l.version))).rejects.toEqual(err(409, 'lot_has_remainder'));
    await expect(run(() => inv.closeLot(sales, l.id, { remainder: 'to_loose', counter_id: C1 }, l.version))).rejects.toEqual(err(403, 'forbidden'));
    const c = await run(() => inv.closeLot(mgr, l.id, { remainder: 'to_loose', counter_id: C1 }, l.version));
    expect(c.status).toBe('closed');
    expect(c.version).toBeGreaterThan(l.version);
    await expect(run(() => inv.closeLot(mgr, l.id, { remainder: 'to_loose', counter_id: C1 }, l.version))).rejects.toEqual(err(412, 'version_mismatch'));
    const led = await ledgerOf(l.lines[0].id);
    expect(led).toEqual([expect.objectContaining({ movement: 'non_tag_in', direction: 1, branch_id: B1, gross_wt: '50.000' })]);
    expect((await run(() => inv.closeLot(mgr, l.id, { remainder: 'to_loose', counter_id: C1 }, c.version))).status).toBe('closed');
    expect(await ledgerOf(l.lines[0].id)).toHaveLength(1);
    // a closed lot refuses tagging
    const l3 = await run(() => inv.createLot(mgr, { branch_id: B1, lines: [lineIn({ pieces: 0, gross_wt: '1.000', stone_wt: '0', net_wt: '1.000' })] }));
    await run(() => inv.closeLot(mgr, l3.id, { remainder: 'to_loose', counter_id: C1 }, l3.version));
    await expect(tag({ lot_line_id: l3.lines[0].id })).rejects.toEqual(err(409, 'lot_not_open'));
  });
});

describe('line removal (0.8.4, 987 rw_delete_open_lot_only / 988 rw_delete_draft_only)', () => {
  it('updateLot: an omitted untagged line is deleted on an open lot; a tagged one → 409 line_tagged; last untagged gone → lot tagged; tenant 2 → 404', async () => {
    const l = await run(() => inv.createLot(mgr, { branch_id: B1, lines: [lineIn({ pieces: 1, gross_wt: '10.000', stone_wt: '0', net_wt: '10.000' }),
      lineIn({ pieces: 1, gross_wt: '3.000', stone_wt: '0', net_wt: '3.000' }), lineIn({ pieces: 1, gross_wt: '4.000', stone_wt: '0', net_wt: '4.000' })] }));
    // UUIDv7 IDs created in one millisecond need not preserve input order. Pick fixtures by their identity.
    const A = l.lines.find((x) => x.gross_wt === '10.000')!;
    const B = l.lines.find((x) => x.gross_wt === '3.000')!;
    const C = l.lines.find((x) => x.gross_wt === '4.000')!;
    const u = await run(() => inv.updateLot(mgr, l.id, { lines: keep([A, C]) }, l.version));
    expect(u.lines.map((x) => x.id).sort()).toEqual([A.id, C.id].sort());
    expect(u.version).toBeGreaterThan(l.version);
    expect(await sql(`SELECT 1 FROM inventory.lot_line WHERE id = $1`, [B.id])).toEqual([]);
    await expect(run(() => inv.updateLot(t2(), l.id, { lines: keep([A]) }, u.version), T2)).rejects.toEqual(err(404, 'not_found'));
    await tag({ lot_line_id: A.id });
    let cur = await run(() => inv.getLot(mgr, l.id));
    await expect(run(() => inv.updateLot(mgr, l.id, { lines: keep([C]) }, cur.version))).rejects.toEqual(err(409, 'line_tagged'));
    expect((await run(() => inv.getLot(mgr, l.id))).lines).toHaveLength(2);   // refused as a whole: nothing deleted
    expect(await rawDelete('lot_line', A.id)).toBe(0);                          // RLS: a tagged line is not deletable even directly
    cur = await run(() => inv.updateLot(mgr, l.id, { lines: keep([cur.lines.find((x) => x.id === A.id)!]) }, cur.version));
    expect(cur.lines.map((x) => x.id)).toEqual([A.id]);
    expect(cur.status).toBe('tagged');
  });
  it('updateLot on a closed lot → 409 lot_not_open; raw DELETE as app_rw affects 0 rows on a closed lot and across tenants', async () => {
    const l = await run(() => inv.createLot(mgr, { branch_id: B1, lines: [1, 2].map(() => lineIn({ item_id: ITEM_LOOSE, purity_id: P22, pieces: 0, gross_wt: '5.000', stone_wt: '0', net_wt: '5.000' })) }));
    expect(await rawDelete('lot_line', l.lines[1].id, T2)).toBe(0);
    const c = await run(() => inv.closeLot(mgr, l.id, { remainder: 'to_loose', counter_id: C1 }, l.version));
    await expect(run(() => inv.updateLot(mgr, l.id, { lines: keep([c.lines[0]]) }, c.version))).rejects.toEqual(err(409, 'lot_not_open'));
    expect(await rawDelete('lot_line', l.lines[1].id)).toBe(0);
    expect((await run(() => inv.getLot(mgr, l.id))).lines).toHaveLength(2);
  });
  it('updateTransfer: a shorter list deletes the rows left over on a draft (freed pieces re-usable); non-draft → 409 transfer_not_draft; tenant 2 → 404', async () => {
    const [a, b, c] = [await tag(), await tag(), await tag()];
    const tr = await run(() => inv.createTransfer(mgr, { from_branch_id: B1, to_branch_id: B2, lines: [{ tag_id: a.id }, { tag_id: b.id }, { tag_id: c.id }] }));
    const bRow = tr.lines.find((x) => x.tag_id === b.id)!.id;
    await expect(run(() => inv.updateTransfer(t2(), tr.id, { lines: [{ tag_id: b.id }] }, tr.version), T2)).rejects.toEqual(err(404, 'not_found'));
    expect(await rawDelete('stock_transfer_line', bRow, T2)).toBe(0);
    const u = await run(() => inv.updateTransfer(mgr, tr.id, { lines: [{ tag_id: b.id }] }, tr.version));
    expect(u.lines.map((x) => [x.id, x.tag_id])).toEqual([[bRow, b.id]]);
    expect(await sql(`SELECT 1 FROM inventory.stock_transfer_line WHERE transfer_id = $1`, [tr.id])).toHaveLength(1);
    await run(() => inv.createTransfer(mgr, { from_branch_id: B1, to_branch_id: B2, lines: [{ tag_id: a.id }, { tag_id: c.id }] }));   // a, c free again
    const ap = await run(() => inv.approveTransfer(mgr2, tr.id));
    await expect(run(() => inv.updateTransfer(mgr, tr.id, { lines: [{ tag_id: b.id }] }, ap.version))).rejects.toEqual(err(409, 'transfer_not_draft'));
    expect(await rawDelete('stock_transfer_line', bRow)).toBe(0);                // RLS: only draft lines are deletable
    expect((await run(() => inv.getTransfer(mgr, tr.id))).lines).toHaveLength(1);
  });
});

describe('vendor_lot_ref (987) and Tag.pieces', () => {
  it('create (single + bulk) trims and stores it; patch sets / clears it; 1-60 chars', async () => {
    const t = await tag({ vendor_lot_ref: '  VB-2026/11  ' });
    const v = await run(() => inv.getTag(sales, t.id));
    expect(v).toMatchObject({ vendor_lot_ref: 'VB-2026/11', pieces: 1 });
    const bulk = await run(() => inv.createTags(owner, B1, [1, 2].map(() => ({ item_id: ITEM_TAG, gross_wt: '4.000', huid: huid(), counter_id: C1, vendor_lot_ref: 'BULK-1' }))));
    for (const b of bulk) expect((await run(() => inv.getTag(owner, b.id))).vendor_lot_ref).toBe('BULK-1');
    await expect(tag({ vendor_lot_ref: 'x'.repeat(61) })).rejects.toEqual(err(422, 'validation_failed'));
    await expect(tag({ vendor_lot_ref: '   ' })).rejects.toEqual(err(422, 'validation_failed'));
    const p = await run(() => inv.patchTag(owner, t.id, { vendor_lot_ref: 'NEW-REF' }, v.version));
    expect(p.vendor_lot_ref).toBe('NEW-REF');
    await expect(run(() => inv.patchTag(owner, t.id, { vendor_lot_ref: 'y'.repeat(61) }, p.version))).rejects.toEqual(err(422, 'validation_failed'));
    expect((await run(() => inv.patchTag(owner, t.id, { vendor_lot_ref: null }, p.version))).vendor_lot_ref).toBeNull();
    const plain = await tag();
    expect((await run(() => inv.getTag(owner, plain.id)))).toMatchObject({ vendor_lot_ref: null, pieces: 1 });
  });
});

describe('tag history and photos', () => {
  it('getTagHistory: created, move, label print, status, newest first, cursor pages; 404 across branches / tenants', async () => {
    const t = await tag();
    await run(() => inv.moveStock(sales, { branch_id: B1, to_counter_id: C2, tag_ids: [t.id] }));
    await run(() => inv.printLabels(sales, [t.id]));
    const h = await run(() => inv.getTagHistory(sales, t.id));
    const kinds = h.items.map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(['ledger', 'move', 'label_print']));
    expect(h.items.find((e) => e.kind === 'move')).toMatchObject({ from: { branch_id: B1, counter_id: C1 }, to: { branch_id: B1, counter_id: C2 } });
    const ats = h.items.map((e) => Date.parse(e.at));
    expect([...ats].sort((x, y) => y - x)).toEqual(ats);
    const p1 = await run(() => inv.getTagHistory(sales, t.id, { limit: 1 }));
    expect(p1.items).toHaveLength(1);
    const p2 = await run(() => inv.getTagHistory(sales, t.id, { limit: 100, cursor: p1.next_cursor }));
    expect(p2.items.length).toBe(h.items.length - 1);
    await expect(run(() => inv.getTagHistory(sales, t.id, { cursor: 'nope' }))).rejects.toEqual(err(422, 'validation_failed'));
    await expect(run(() => inv.getTagHistory(mgrB2, t.id))).rejects.toEqual(err(404, 'not_found'));
    await expect(run(() => inv.getTagHistory(t2(), t.id), T2)).rejects.toEqual(err(404, 'not_found'));
  });
  it('listTagPhotos / updateTagPhoto: primary first, stale version → 412, one primary, primary_required, feature_disabled; file access resolver', async () => {
    const t = await tag();
    const file = async () => (await sql<{ id: string }>(`INSERT INTO platform.file(tenant_id, area, object_key, original_name, content_type, size_bytes, sha256)
      VALUES ($1, 'attachments', $2, 'p.jpg', 'image/jpeg', 10, decode(repeat('ab', 32), 'hex')) RETURNING id`, [T1, `it/${rnd(12)}`]))[0].id;
    const [f1, f2] = [await file(), await file()];
    await setSettings({ photos_enabled: true });
    try {
      const p1 = await run(() => inv.addTagPhoto(owner, t.id, f1));
      const p2 = await run(() => inv.addTagPhoto(owner, t.id, f2, { caption: 'side' }));
      let list = await run(() => inv.listTagPhotos(sales, t.id));
      expect(list.map((p) => [p.id, p.is_primary])).toEqual([[p1.id, true], [p2.id, false]]);
      const ph2 = list[1];
      await expect(run(() => inv.updateTagPhoto(owner, t.id, p2.id, { is_primary: true }, ph2.version + 1))).rejects.toEqual(err(412, 'version_mismatch'));
      const up = await run(() => inv.updateTagPhoto(owner, t.id, p2.id, { is_primary: true, caption: 'front' }, ph2.version));
      expect(up).toMatchObject({ is_primary: true, caption: 'front' });
      expect(up.version).toBeGreaterThan(ph2.version);
      list = await run(() => inv.listTagPhotos(sales, t.id));
      expect(list.map((p) => [p.id, p.is_primary])).toEqual([[p2.id, true], [p1.id, false]]);
      await expect(run(() => inv.updateTagPhoto(owner, t.id, p2.id, { is_primary: false }, up.version))).rejects.toEqual(
        expect.objectContaining({ status: 422, code: 'validation_failed', errors: [expect.objectContaining({ path: 'is_primary', code: 'primary_required' })] }));
      await expect(run(() => inv.updateTagPhoto(sales, t.id, p2.id, { caption: 'x' }, up.version))).rejects.toEqual(err(403, 'forbidden'));
      expect(await run(() => inv.tagPhotoFileAccess({ id: f1 }, sales))).toBe(true);
      expect(await run(() => inv.tagPhotoFileAccess({ id: f1 }, mgrB2))).toBe(false);
      expect(await run(() => inv.tagPhotoFileAccess({ id: f1 }, t2()), T2)).toBe(false);
      await expect(run(() => inv.listTagPhotos(t2(), t.id), T2)).rejects.toEqual(err(404, 'not_found'));
    } finally { await setSettings({ photos_enabled: false }); }
    const cur = (await run(() => inv.listTagPhotos(owner, t.id)))[0];
    await expect(run(() => inv.updateTagPhoto(owner, t.id, cur.id, { caption: 'z' }, cur.version))).rejects.toEqual(err(409, 'feature_disabled'));
  });
});

describe('stock summary, moves, scans, transfer edits', () => {
  it('getStockSummary: per-location rows with labels, loose included, totals add up; tenant 2 sees nothing', async () => {
    const c = await counter(B1, `S${rnd(4)}`);
    await tag({ counter_id: c }); await tag({ counter_id: c, gross_wt: '5.000', stone_wt: '0' });
    const s = await run(() => inv.stockSummary(mgr, { group_by: 'location' }));
    const row = s.rows.find((r) => r.counter_id === c)!;
    expect(row).toMatchObject({ branch_id: B1, tag_pieces: 2, tag_gross_wt: '15.000', tag_net_wt: '14.500', loose_pieces: 0 });
    expect(row.fine_wt).toMatch(/^\d+\.\d{3}$/);
    expect((row.labels as Record<string, string>).counter_id).toBeTruthy();
    expect(s.totals.tag_pieces).toBe(s.rows.reduce((n, r) => n + Number(r.tag_pieces), 0));
    expect(s.rows.every((r) => r.branch_id === B1)).toBe(true);
    // 0.9.0: tag_count (number of tags) next to tag_pieces, on every row and totals, for every group_by
    expect(row.tag_count).toBe(2);
    expect(s.totals.tag_count).toBe(s.rows.reduce((n, r) => n + Number(r.tag_count), 0));
    const c3 = await counter(B1, `S${rnd(4)}`);
    await tag({ counter_id: c3, pieces: 3 }); await tag({ counter_id: c3 });
    for (const group_by of ['location', 'item', 'purity', 'status'] as const) {
      const g = await run(() => inv.stockSummary(mgr, { group_by }));
      for (const r of [...g.rows, g.totals]) { expect(Number.isInteger(r.tag_count)).toBe(true); expect(r.tag_count).toBeGreaterThanOrEqual(0); expect(r.tag_count).toBeLessThanOrEqual(Number(r.tag_pieces)); }
      expect(g.totals.tag_count).toBe(g.rows.reduce((n, r) => n + Number(r.tag_count), 0));
      if (group_by === 'location') expect(g.rows.find((r) => r.counter_id === c3)).toMatchObject({ tag_count: 2, tag_pieces: 4 });
    }
    const byStatus = await run(() => inv.stockSummary(owner, { group_by: 'status', include_loose: false }));
    expect(byStatus.rows.map((r) => r.status)).toContain('in_stock');
    expect(byStatus.rows.some((r) => r.status === 'sold' || r.status === 'written_off')).toBe(false);
    expect((await run(() => inv.stockSummary(t2(), {}), T2)).rows).toEqual([]);
  });
  it('listLocationMoves: filters by tag / counter / IST dates, labels; branch + tenant scoped', async () => {
    const t = await tag();
    await run(() => inv.moveStock(sales, { branch_id: B1, to_counter_id: C3, tag_ids: [t.id] }));
    const m = await run(() => inv.listLocationMoves(sales, { tag_id: t.id }));
    expect(m.items).toEqual([expect.objectContaining({ tag_id: t.id, tag_no: t.tag_no, from_counter_id: C1, to_counter_id: C3, branch_id: B1 })]);
    expect(m.items[0].labels).toBeTruthy();
    expect((await run(() => inv.listLocationMoves(sales, { tag_id: t.id, counter_id: C3, from: inv.todayIST(), to: inv.todayIST() }))).items).toHaveLength(1);
    expect((await run(() => inv.listLocationMoves(sales, { tag_id: t.id, to: '2020-01-01' }))).items).toHaveLength(0);
    expect((await run(() => inv.listLocationMoves(mgrB2, { tag_id: t.id }))).items).toHaveLength(0);
    expect((await run(() => inv.listLocationMoves(t2(), { tag_id: t.id }), T2)).items).toHaveLength(0);
  });
  it('0.8.4: every scan shows result / extra_reason / extra_note / duplicate in the POST response, the scan list and the report', async () => {
    const c = await counter(B1, `K${rnd(4)}`);
    const [a, held] = [await tag({ counter_id: c }), await tag({ counter_id: c })];
    await run(async () => inv.changeTagStatus(mgr, held.id, 'repair', 'scan test', (await inv.getTag(owner, held.id)).version));
    const sc = await run(() => inv.startStockCheck(sales, { branch_id: B1, counter_id: c }));
    const m = await run(() => inv.recordScan(sales, sc.id, a.tag_no));
    expect(m).toMatchObject({ result: 'matched', extra_reason: null, extra_note: null, duplicate: false });
    const again = await run(() => inv.recordScan(mgr, sc.id, a.tag_no));            // another phone, same piece
    expect(again).toMatchObject({ scan_id: m.scan_id, result: 'matched', duplicate: true });
    const w = await run(() => inv.recordScan(sales, sc.id, held.tag_no));
    expect(w).toMatchObject({ result: 'extra', extra_reason: 'wrong_status', extra_note: 'repair', duplicate: false });
    const u = await run(() => inv.recordScan(sales, sc.id, `ZZ${rnd(6)}`));
    expect(u).toMatchObject({ result: 'extra', extra_reason: 'unknown_code', extra_note: null, duplicate: false });
    const list = (await run(() => inv.listStockCheckScans(mgr, sc.id))).items;     // reload
    const by = new Map(list.map((x) => [x.id, x]));
    expect(by.get(m.scan_id)).toMatchObject({ result: 'matched', extra_reason: null, extra_note: null, duplicate: false });
    expect(by.get(w.scan_id)).toMatchObject({ result: 'extra', extra_reason: 'wrong_status', extra_note: 'repair', duplicate: false });
    expect(by.get(u.scan_id)).toMatchObject({ result: 'extra', extra_reason: 'unknown_code', duplicate: false });
    const rep = await run(() => inv.stockCheckReport(mgr, sc.id));
    expect(rep.find((x) => x.tag_id === a.id)).toMatchObject({ result: 'matched', extra_reason: null, duplicate: false, branch_id: B1, status: 'in_stock' });
    expect(rep.find((x) => x.tag_id === held.id)).toMatchObject({ result: 'extra', extra_reason: 'wrong_status', extra_note: 'repair', duplicate: false });
    expect(rep.every((x) => typeof x.duplicate === 'boolean' && 'labels' in x)).toBe(true);
    expect(await run(() => inv.stockCheckCounts(sc.id))).toMatchObject({ scanned: 3, matched: 1, extra: 2 });
    const scv = (await run(() => inv.getStockCheck(mgr, sc.id))).version;
    await run(() => inv.cancelStockCheck(mgr, sc.id, scv));
  });
  it('listStockCheckScans + scans / undo leave the check version alone; close / cancel bump it; close creates pending full_write_off', async () => {
    const c = await counter(B1, `K${rnd(4)}`);
    const [a, b] = [await tag({ counter_id: c }), await tag({ counter_id: c })];
    const sc = await run(() => inv.startStockCheck(sales, { branch_id: B1, counter_id: c }));
    const s1 = await run(() => inv.recordScan(sales, sc.id, a.tag_no));
    const sx = await run(() => inv.recordScan(sales, sc.id, 'NOT-A-TAG'));
    await run(() => inv.undoScan(sales, sc.id, sx.scan_id));
    expect((await run(() => inv.getStockCheck(sales, sc.id))).version).toBe(sc.version);
    const scans = await run(() => inv.listStockCheckScans(sales, sc.id));
    expect(scans.items).toEqual([expect.objectContaining({ id: s1.scan_id, tag_id: a.id, tag_no: a.tag_no, code: a.tag_no })]);
    await expect(run(() => inv.listStockCheckScans(mgrB2, sc.id))).rejects.toEqual(err(404, 'not_found'));
    await expect(run(() => inv.listStockCheckScans(t2(), sc.id), T2)).rejects.toEqual(err(404, 'not_found'));
    await expect(run(() => inv.closeStockCheck(mgr, sc.id, {}, sc.version - 1))).rejects.toEqual(err(412, 'version_mismatch'));
    const closed = await run(() => inv.closeStockCheck(mgr, sc.id, { create_adjustments: true }, sc.version));
    expect(closed.version).toBeGreaterThan(sc.version);
    expect(closed.created_adjustment_ids).toHaveLength(1);
    const adj = await run(() => inv.getAdjustment(mgr, closed.created_adjustment_ids[0]));
    expect(adj).toMatchObject({ kind: 'full_write_off', status: 'pending', tag_id: b.id, delta_pieces: -1 });
    expect((await tagRow(b.id)).status).toBe('in_stock');   // pending: nothing written off until approved
    await run(() => inv.cancelAdjustment(mgr, adj.id));
    const c2 = await counter(B1, `K${rnd(4)}`);
    const sc2 = await run(() => inv.startStockCheck(sales, { branch_id: B1, counter_id: c2 }));
    expect((await run(() => inv.cancelStockCheck(mgr, sc2.id, sc2.version))).version).toBeGreaterThan(sc2.version);
  });
  it('updateTransfer: draft only, stale version → 412, rows reused, shorter list deletes, transfer_not_draft; 404 for tenant 2', async () => {
    const [a, b, c] = [await tag(), await tag(), await tag()];
    const tr = await run(() => inv.createTransfer(mgr, { from_branch_id: B1, to_branch_id: B2, lines: [{ tag_id: a.id }] }));
    await expect(run(() => inv.updateTransfer(mgr, tr.id, { remarks: 'x' }, tr.version + 1))).rejects.toEqual(err(412, 'version_mismatch'));
    const u = await run(() => inv.updateTransfer(mgr, tr.id, { remarks: 'two more', lines: [{ tag_id: b.id }, { tag_id: a.id }] }, tr.version));
    expect(u.version).toBeGreaterThan(tr.version);
    expect(u.remarks).toBe('two more');
    expect(u.lines.map((l) => l.tag_id).sort()).toEqual([a.id, b.id].sort());
    expect(u.lines.find((l) => l.tag_id === a.id)!.id).toBe(tr.lines[0].id);
    const u2 = await run(() => inv.updateTransfer(mgr, tr.id, { lines: [{ tag_id: c.id }, { tag_id: b.id }] }, u.version));
    expect(u2.lines.map((l) => l.tag_id).sort()).toEqual([b.id, c.id].sort());
    await run(() => inv.createTransfer(mgr, { from_branch_id: B1, to_branch_id: B2, lines: [{ tag_id: a.id }] }));   // a is free again
    const u3 = await run(() => inv.updateTransfer(mgr, tr.id, { lines: [{ tag_id: b.id }] }, u2.version));
    expect(u3.lines.map((l) => l.tag_id)).toEqual([b.id]);
    await expect(run(() => inv.updateTransfer(mgrB2, tr.id, { remarks: 'y' }, u3.version))).rejects.toEqual(err(403, 'branch_scope'));
    await expect(run(() => inv.updateTransfer(t2(), tr.id, { remarks: 'y' }, u3.version), T2)).rejects.toEqual(err(404, 'not_found'));
    const ap = await run(() => inv.approveTransfer(mgr2, tr.id));
    await expect(run(() => inv.updateTransfer(mgr, tr.id, { remarks: 'late' }, ap.version))).rejects.toEqual(err(409, 'transfer_not_draft'));
  });
});

describe('ageing groups use the totals bucket codes', () => {
  it('every group has the same bucket codes, in the same order, as totals', async () => {
    await setSettings({ ageing_enabled: true, ageing_bucket_days: [30, 90] });
    try {
      await tag({ received_on: '2026-01-10' }); await tag();
      const rep = await run(() => inv.stockAgeing(owner, { branch_id: B1, group_by: 'item' }));
      expect(rep.groups.length).toBeGreaterThan(0);
      for (const g of rep.groups) expect(g.buckets.map((b) => b.code)).toEqual(rep.totals.map((b) => b.code));
      expect(rep.totals.map((b) => b.code)).toEqual(['0_29', '30_89', '90_plus']);
    } finally { await setSettings({ ageing_enabled: false }); }
  });
});
