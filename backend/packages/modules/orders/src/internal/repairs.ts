import { withModuleRole, withSavepoint } from '@jw/db';
import { type OrdersActor, canSeeBranch, need, needBranch } from './actor';
import { checkVersion, fail, invalid } from './errors';
import { audit, branchCode, gm, iso, many, mg, nextDocNo, one } from './db';
import { docPrefixOf, indianFY, renderDocNo, todayIST } from './numbering';
import { loadSettings } from './settings';
import { salesPort, type AdvanceRow } from './ports';

/**
 * Repairs (O7): a customer leaves a piece for repair. Header orders.repair, lines orders.repair_line (110 + 01000 + 01004).
 * Written ONLY as orders_writer (no DELETE: a line taken off is set to 'cancelled'). O7 scope: create (with an optional money advance
 * taken through Sales), view, edit while the repair is still 'received'. Vendor issue / receipt (O8), delivery and billing (O9),
 * lists (O10) and prints (O11) come later.
 */
export const OPEN_REPAIR = ['received', 'issued_to_vendor', 'received_from_vendor', 'ready'] as const;
export interface RepairLineInput {
  id?: string; repair_type_id: string; description?: string | null; gross_wt: string; net_wt?: string | null; customer_charge?: string | null; photo_file_ids?: string[];
}
export interface RepairAdvanceInput { amount: string; purpose?: string | null; received_on?: string }
export interface RepairInput {
  branch_id: string; customer_id: string; received_on?: string; due_date?: string | null; notes?: string | null; lines: RepairLineInput[]; advance?: RepairAdvanceInput;
}
export type RepairPatch = Partial<Pick<RepairInput, 'due_date' | 'notes' | 'lines'>>;
export interface RepairLine {
  id: string; line_no: number; repair_type_id: string; repair_type_name: string; description: string | null; gross_wt: string; net_wt: string | null; customer_charge: string | null;
  photo_file_ids: string[]; vendor_id: string | null; vendor_charge: string | null; vendor_note: string | null; issued_at: string | null; received_at: string | null;
  received_wt: string | null; loss_wt: string | null; loss_pct: string | null; loss_override_reason: string | null; status: 'active' | 'cancelled'; version: number;
}
export interface Repair {
  id: string; repair_no: string; branch_id: string; received_on: string; customer_id: string; customer_name: string | null; customer_phone: string | null;
  due_date: string | null; status: string; overdue: boolean; notes: string | null; delivered_invoice_id: string | null; created_by: string | null; created_at: string;
  version: number; lines: RepairLine[]; totals: { lines: number; gross_wt: string; estimate: string }; advances: AdvanceRow[];
}
const OVERDUE = `(r.due_date IS NOT NULL AND r.due_date < (now() AT TIME ZONE 'Asia/Kolkata')::date AND r.status IN ('received','issued_to_vendor','received_from_vendor','ready'))`;
const HEAD = `r.id, r.repair_no, r.branch_id, r.received_on::text, r.customer_id, c.name AS customer_name, c.phone AS customer_phone, r.due_date::text, r.status,
  ${OVERDUE} AS overdue, r.notes, r.delivered_invoice_id, r.created_by, ${iso('r.created_at', 'created_at')}, r.version`;
const FROM = `orders.repair r LEFT JOIN masters.customer c ON c.tenant_id = r.tenant_id AND c.id = r.customer_id`;
const LINE = `l.id, l.line_no, l.repair_type_id, t.name AS repair_type_name, l.description, l.gross_wt::text, l.net_wt::text, l.customer_charge::text, l.photo_keys,
  l.vendor_id, l.vendor_charge::text, l.vendor_note, l.loss_override_reason, ${iso('l.issued_at', 'issued_at')}, ${iso('l.received_at', 'received_at')}, l.received_wt::text, l.status, l.version`;
type RawLine = Omit<RepairLine, 'photo_file_ids' | 'gross_wt' | 'net_wt' | 'received_wt' | 'customer_charge' | 'vendor_charge' | 'loss_wt' | 'loss_pct'> & {
  photo_keys: string[]; gross_wt: string; net_wt: string | null; received_wt: string | null; customer_charge: string | null; vendor_charge: string | null };

const MONEY = /^\d{1,10}(\.\d{1,2})?$/;
const W = /^\d{1,7}(\.\d{1,3})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const cents = (s: string | number): bigint => {
  const [i, f = ''] = String(s).trim().split('.');
  return BigInt(i || '0') * 100n + BigInt((f + '00').slice(0, 2));
};
const money = (v: bigint): string => `${v / 100n}.${String(v % 100n).padStart(2, '0')}`;
const addDays = (isoDate: string, n: number): string => new Date(Date.parse(`${isoDate}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Loss = weight issued (gross_wt) minus weight received back, in grams and as a percentage of the weight issued (2 dp). A gain is negative. */
export function lossOf(gross: string, received: string | null): { wt: string; pct: string } | null {
  if (received === null) return null;
  const g = mg(gross); const loss = g - mg(received);
  const bp = (loss * 10000n) / g;                       // basis points, truncated toward zero
  const neg = bp < 0n; const a = neg ? -bp : bp;
  return { wt: gm(loss), pct: `${neg ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}` };
}
const shapeLine = (l: RawLine): RepairLine => {
  const { photo_keys, ...rest } = l;
  const loss = lossOf(l.gross_wt, l.received_wt);
  return { ...rest, gross_wt: gm(mg(l.gross_wt)), net_wt: l.net_wt === null ? null : gm(mg(l.net_wt)), received_wt: l.received_wt === null ? null : gm(mg(l.received_wt)),
    loss_wt: loss?.wt ?? null, loss_pct: loss?.pct ?? null,
    customer_charge: l.customer_charge === null ? null : money(cents(l.customer_charge)), vendor_charge: l.vendor_charge === null ? null : money(cents(l.vendor_charge)),
    photo_file_ids: photo_keys };
};
async function load(id: string, lock = false, advances = true): Promise<Repair> {
  const h = await one<Omit<Repair, 'lines' | 'totals' | 'advances'>>(`SELECT ${HEAD} FROM ${FROM} WHERE r.id = $1 ${lock ? 'FOR UPDATE OF r' : ''}`, [id])
    ?? fail(404, 'not_found', 'repair');
  const lines = (await many<RawLine>(`SELECT ${LINE} FROM orders.repair_line l JOIN masters.repair_type t ON t.tenant_id = l.tenant_id AND t.id = l.repair_type_id
    WHERE l.repair_id = $1 ORDER BY l.line_no`, [id])).map(shapeLine);
  const live = lines.filter((l) => l.status === 'active');
  return { ...h, lines, advances: advances ? await salesPort().listRepairAdvances(id) : [], totals: { lines: live.length,
    gross_wt: gm(live.reduce((s, l) => s + mg(l.gross_wt), 0n)), estimate: money(live.reduce((s, l) => s + (l.customer_charge === null ? 0n : cents(l.customer_charge)), 0n)) } };
}
async function visible(a: OrdersActor, id: string, lock = false, advances = true): Promise<Repair> {
  const r = await load(id, lock, advances);
  if (!canSeeBranch(a, r.branch_id)) fail(404, 'not_found', 'repair');
  return r;
}
/** Flow slices (O8/O9) load a repair with the same visibility rule; lock = FOR UPDATE (call it inside orders_writer). */
export const loadRepairForFlow = visible;
/** Same, locked and without the Sales advances: safe to call INSIDE an orders_writer block (the repair-flow recheck). */
export const loadRepairLocked = (a: OrdersActor, id: string): Promise<Repair> => visible(a, id, true, false);
export async function getRepair(a: OrdersActor, id: string): Promise<Repair> {
  need(a, 'orders.repair.view');
  return visible(a, id);
}

/** Shape + masters checks of one line; the estimate must lie inside the repair type's customer charge limits. */
async function checkLine(l: RepairLineInput, k: number): Promise<void> {
  const p = `lines.${k}`;
  if (typeof l.gross_wt !== 'string' || !W.test(l.gross_wt) || mg(l.gross_wt) <= 0n) invalid(`${p}.gross_wt`, 'decimal string above 0, up to 3 dp');
  if (l.net_wt != null && (!W.test(String(l.net_wt)) || mg(l.net_wt) <= 0n)) invalid(`${p}.net_wt`, 'decimal string above 0, up to 3 dp');
  if (l.net_wt != null && mg(l.net_wt) > mg(l.gross_wt)) invalid(`${p}.net_wt`, 'net weight cannot be more than gross weight');
  if (l.description != null && (typeof l.description !== 'string' || l.description.length > 500)) invalid(`${p}.description`, 'at most 500 characters');
  if (l.customer_charge != null && (!MONEY.test(String(l.customer_charge)))) invalid(`${p}.customer_charge`, 'amount, up to 2 decimals');
  const files = l.photo_file_ids ?? [];
  if (files.length > 10) invalid(`${p}.photo_file_ids`, 'at most 10 files');
  if (new Set(files).size !== files.length) invalid(`${p}.photo_file_ids`, 'duplicate file');
  if (files.length) {
    const ok = await many<{ id: string }>(`SELECT id::text FROM platform.file WHERE id = ANY($1::uuid[]) AND area = 'attachments' AND deleted_at IS NULL`, [files]);
    if (ok.length !== files.length) fail(422, 'unknown_reference', `${p}.photo_file_ids`);
  }
  const t = await one<{ is_active: boolean; min: string | null; max: string | null }>(
    `SELECT is_active, min_customer_charge::text AS min, max_customer_charge::text AS max FROM masters.repair_type WHERE id = $1`, [l.repair_type_id])
    ?? fail(422, 'unknown_reference', `${p}.repair_type_id`);
  if (!t.is_active) fail(422, 'inactive_master', `${p}.repair_type_id`);
  if (l.customer_charge != null) {
    const c = cents(l.customer_charge);
    if ((t.min !== null && c < cents(t.min)) || (t.max !== null && c > cents(t.max)))
      fail(422, 'validation_failed', `estimate is outside the repair type limits (${t.min ?? 'no minimum'} to ${t.max ?? 'no maximum'})`,
        [{ path: `${p}.customer_charge`, code: 'charge_out_of_range', message: `must be between ${t.min ?? '0'} and ${t.max ?? 'any amount'}` }]);
  }
}
const checkLines = async (lines: RepairLineInput[]): Promise<void> => {
  if (!Array.isArray(lines) || lines.length < 1 || lines.length > 20) invalid('lines', '1-20 lines');
  for (const [k, l] of lines.entries()) await checkLine(l, k);
};
function checkHeader(i: { due_date?: string | null; notes?: string | null; received_on?: string }, receivedOn: string): void {
  if (i.notes != null && (typeof i.notes !== 'string' || i.notes.length > 1000)) invalid('notes', 'at most 1000 characters');
  if (i.received_on !== undefined && !DATE.test(i.received_on)) invalid('received_on', 'YYYY-MM-DD');
  if (i.due_date != null) {
    if (!DATE.test(i.due_date)) invalid('due_date', 'YYYY-MM-DD');
    if (i.due_date < receivedOn) invalid('due_date', 'must not be before the date the piece was received');
  }
}
async function insertLine(c: { query: (q: string, p: unknown[]) => Promise<unknown> }, repairId: string, l: RepairLineInput): Promise<void> {
  await c.query(
    `INSERT INTO orders.repair_line(tenant_id, repair_id, line_no, repair_type_id, description, gross_wt, net_wt, customer_charge, photo_keys)
     VALUES (platform.current_tenant(), $1, (SELECT coalesce(max(line_no), 0) + 1 FROM orders.repair_line WHERE repair_id = $1), $2, $3, $4::numeric, $5::numeric, $6::numeric, $7::text[])`,
    [repairId, l.repair_type_id, l.description ?? null, l.gross_wt, l.net_wt ?? null, l.customer_charge ?? null, l.photo_file_ids ?? []]);
}

/** New repair (orders.repair.create at the branch). repair_no from REP-{BRANCH}-{FY}-{SEQ:5}. An optional money advance goes through Sales in the same transaction. */
export async function createRepair(a: OrdersActor, i: RepairInput): Promise<Repair> {
  need(a, 'orders.repair.create');
  needBranch(a, i.branch_id);
  if (i.advance) need(a, 'orders.advance.take');
  const receivedOn = i.received_on ?? todayIST();
  const settings = await loadSettings();
  if (i.due_date === undefined && settings.default_due_days) i = { ...i, due_date: addDays(receivedOn, settings.default_due_days) };
  if (settings.advance_required && !i.advance)
    fail(422, 'validation_failed', 'this shop needs an advance when a repair is booked', [{ path: 'advance', code: 'advance_required', message: 'an advance is required' }]);
  checkHeader(i, receivedOn);
  if (!i.customer_id) invalid('customer_id', 'a repair needs a customer');
  await one(`SELECT 1 FROM masters.customer WHERE id = $1`, [i.customer_id]) ?? fail(422, 'unknown_reference', 'customer_id');
  await checkLines(i.lines);
  if (i.advance) {
    if (typeof i.advance.amount !== 'string' || !MONEY.test(i.advance.amount) || cents(i.advance.amount) <= 0n) invalid('advance.amount', 'positive amount, up to 2 decimals');
    if (i.advance.purpose != null && (typeof i.advance.purpose !== 'string' || i.advance.purpose.length > 200)) invalid('advance.purpose', 'at most 200 characters');
    if (i.advance.received_on !== undefined && !DATE.test(i.advance.received_on)) invalid('advance.received_on', 'YYYY-MM-DD');
  }
  const code = await branchCode(i.branch_id);
  const fy = indianFY(receivedOn);
  const fmt = settings.repair_no_format;
  const id = await withModuleRole('orders_writer', async (c) => {
    let found: string | undefined;
    for (let attempt = 0; !found && attempt < 50; attempt++) {
      const no = renderDocNo(fmt, { branchCode: code, fy }, await nextDocNo(i.branch_id, 'repair', fy, docPrefixOf(fmt, { branchCode: code, fy })));
      try {
        found = await withSavepoint(async () => (await c.query<{ id: string }>(
          `INSERT INTO orders.repair(tenant_id, branch_id, repair_no, received_on, customer_id, due_date, notes, created_by)
           VALUES (platform.current_tenant(), $1, $2, $3::date, $4, $5::date, $6, $7) RETURNING id`,
          [i.branch_id, no, receivedOn, i.customer_id, i.due_date ?? null, i.notes ?? null, a.userId])).rows[0].id);
      } catch (e) {
        if ((e as { code?: string }).code !== '23505') throw e;   // a number taken by an earlier row: try the next one
      }
    }
    if (!found) fail(409, 'duplicate_repair_no', 'no free repair number');
    for (const l of i.lines) await insertLine(c, found, l);
    return found;
  });
  if (i.advance) {
    // Sales, as the session role (never inside the orders role); a refusal rolls the whole repair back
    await salesPort().takeAdvance(a, { branch_id: i.branch_id, customer_id: i.customer_id, repair_id: id, kind: 'amount', amount: i.advance.amount,
      purpose: i.advance.purpose ?? null, received_on: i.advance.received_on });
  }
  await audit('orders.repair.create', 'orders.repair', id, { branch_id: i.branch_id, lines: i.lines.length, advance: !!i.advance });
  return load(id);
}

/**
 * Edit a repair that is still 'received' (nothing sent to a vendor) (orders.repair.create). lines is the whole list: a line with id changes in
 * place, one without is added, one left out is set to cancelled (nothing is deleted); at least one live line must remain. The customer cannot
 * be changed. Bumps version.
 */
export async function updateRepair(a: OrdersActor, id: string, p: RepairPatch, ifVersion?: number): Promise<Repair> {
  need(a, 'orders.repair.create');
  const cur = await visible(a, id);
  needBranch(a, cur.branch_id);
  const editable = (r: Repair): void => {
    checkVersion('repair', r.version, ifVersion);
    if (r.status !== 'received') fail(409, 'repair_not_editable', `repair is ${r.status}; only a repair still at the shop can be edited`);
    if (r.lines.some((l) => l.status === 'active' && l.issued_at !== null)) fail(409, 'repair_in_progress', 'a line is already with a vendor');
  };
  editable(cur);
  checkHeader(p, cur.received_on);
  if (p.lines) {
    await checkLines(p.lines);
    const ids = new Set(cur.lines.map((l) => l.id));
    p.lines.forEach((l, k) => { if (l.id && !ids.has(l.id)) fail(422, 'unknown_reference', `lines.${k}.id`); });
    const given = p.lines.filter((l) => l.id).map((l) => l.id);
    if (new Set(given).size !== given.length) invalid('lines', 'a line id appears twice');
  }
  await withModuleRole('orders_writer', async (c) => {
    editable(await load(id, true));
    // the header UPDATE always runs: the version trigger bumps on every UPDATE, so a lines-only edit still bumps the version
    await c.query(
      `UPDATE orders.repair SET due_date = CASE WHEN $2::boolean THEN $3::date ELSE due_date END, notes = CASE WHEN $4::boolean THEN $5 ELSE notes END WHERE id = $1`,
      [id, p.due_date !== undefined, p.due_date ?? null, p.notes !== undefined, p.notes ?? null]);
    if (!p.lines) return;
    const keep = new Set(p.lines.filter((l) => l.id).map((l) => l.id!));
    for (const l of cur.lines) if (l.status === 'active' && !keep.has(l.id)) await c.query(`UPDATE orders.repair_line SET status = 'cancelled' WHERE id = $1`, [l.id]);
    for (const l of p.lines) {
      if (!l.id) { await insertLine(c, id, l); continue; }
      await c.query(
        `UPDATE orders.repair_line SET repair_type_id = $2, description = $3, gross_wt = $4::numeric, net_wt = $5::numeric, customer_charge = $6::numeric,
           photo_keys = $7::text[], status = 'active' WHERE id = $1`,
        [l.id, l.repair_type_id, l.description ?? null, l.gross_wt, l.net_wt ?? null, l.customer_charge ?? null, l.photo_file_ids ?? []]);
    }
  });
  await audit('orders.repair.update', 'orders.repair', id, { lines: p.lines?.length ?? null });
  return load(id);
}
