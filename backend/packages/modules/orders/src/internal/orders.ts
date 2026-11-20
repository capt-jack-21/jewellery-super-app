import { withModuleRole, withSavepoint } from '@jw/db';
import { type OrdersActor, canSeeBranch, need, needBranch } from './actor';
import { checkVersion, fail, invalid } from './errors';
import { audit, branchCode, gm, iso, many, mg, nextDocNo, one } from './db';
import { docPrefixOf, indianFY, renderDocNo, todayIST } from './numbering';
import { loadSettings } from './settings';
import { branches, page, pageArgs, type Page, type PageQ } from './lists';

/**
 * Customer orders (O1). Header orders.customer_order, lines orders.order_line (110 + 01000). Written ONLY as orders_writer.
 * orders_writer has no DELETE: a line taken off an order is set to status 'cancelled', never removed.
 * O1 scope: create, view, list, edit while the order is open. Status flow, vendor assignment, advance and receipt come in later slices.
 */
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export const ORDER_TYPES = ['customer', 'shop'] as const;
export const OPEN_STATUSES = ['open', 'in_production', 'ready'] as const;
export interface Stone { name: string; pieces: number; weight?: string | null }
export interface OrderLineInput {
  id?: string; item_id: string; purity_id?: string | null; pieces?: number; approx_wt?: string | null; size?: string | null; gender?: string | null;
  stones?: Stone[]; design_notes?: string | null; attachment_file_ids?: string[];
}
export interface OrderInput {
  branch_id: string; order_type?: (typeof ORDER_TYPES)[number]; customer_id?: string | null; priority?: (typeof PRIORITIES)[number];
  order_date?: string; due_date?: string | null; notes?: string | null; lines: OrderLineInput[];
}
export type OrderPatch = Partial<Omit<OrderInput, 'branch_id' | 'order_type'>>;
export interface OrderLine {
  id: string; line_no: number; item_id: string; purity_id: string; pieces: number; approx_wt: string | null; size: string | null; gender: string | null;
  stones: Stone[]; design_notes: string | null; attachment_file_ids: string[]; vendor_id: string | null; assigned_at: string | null;
  vendor_due: string | null; vendor_note: string | null; status: 'pending' | 'assigned' | 'received' | 'delivered' | 'cancelled'; received_tag_id: string | null; version: number;
}
export interface Order {
  id: string; order_no: string; branch_id: string; order_date: string; order_type: string; customer_id: string | null; customer_name: string | null;
  customer_phone: string | null; priority: string; due_date: string | null; status: string; overdue: boolean; rate_locked_per_g: string | null;
  notes: string | null; created_by: string | null; created_at: string; version: number; lines: OrderLine[];
  cancel_reason: string | null; cancelled_at: string | null; cancelled_by: string | null;
  totals: { pieces: number; approx_wt: string };
}
export interface OrderSummary {
  id: string; order_no: string; branch_id: string; order_date: string; order_type: string; customer_id: string | null; customer_name: string | null;
  customer_phone: string | null; priority: string; due_date: string | null; status: string; overdue: boolean; line_count: number; pieces: number;
  approx_wt: string; version: number;
}
const OVERDUE = `(o.due_date IS NOT NULL AND o.due_date < (now() AT TIME ZONE 'Asia/Kolkata')::date AND o.status IN ('open','in_production','ready'))`;
const HEAD = `o.id, o.order_no, o.branch_id, o.order_date::text, o.order_type, o.customer_id, c.name AS customer_name, c.phone AS customer_phone,
  o.priority, o.due_date::text, o.status, ${OVERDUE} AS overdue, o.rate_locked_per_g::text, o.notes, o.created_by, ${iso('o.created_at', 'created_at')}, o.version,
  o.cancel_reason, ${iso('o.cancelled_at', 'cancelled_at')}, o.cancelled_by`;
const FROM = `orders.customer_order o LEFT JOIN masters.customer c ON c.tenant_id = o.tenant_id AND c.id = o.customer_id`;
const LINE = `id, line_no, item_id, purity_id, pieces, approx_wt::text, size, gender, stones, design_notes, attachment_keys, vendor_id,
  ${iso('assigned_at')}, vendor_due::text, vendor_note, status, received_tag_id, version`;

type RawLine = Omit<OrderLine, 'attachment_file_ids'> & { attachment_keys: string[] };
function shapeLine(l: RawLine): OrderLine {
  const { attachment_keys, ...rest } = l;
  return { ...rest, approx_wt: l.approx_wt === null ? null : gm(mg(l.approx_wt)), attachment_file_ids: attachment_keys };
}
function withLines(h: Omit<Order, 'lines' | 'totals'>, raw: RawLine[]): Order {
  const lines = raw.map(shapeLine);
  const live = lines.filter((l) => l.status !== 'cancelled');
  return { ...h, lines, totals: { pieces: live.reduce((s, l) => s + l.pieces, 0),
    approx_wt: gm(live.reduce((s, l) => s + (l.approx_wt === null ? 0n : mg(l.approx_wt)), 0n)) } };
}
async function load(id: string, lock = false): Promise<Order> {
  const h = await one<Omit<Order, 'lines' | 'totals'>>(`SELECT ${HEAD} FROM ${FROM} WHERE o.id = $1 ${lock ? 'FOR UPDATE OF o' : ''}`, [id])
    ?? fail(404, 'not_found', 'order');
  return withLines(h, await many<RawLine>(`SELECT ${LINE} FROM orders.order_line WHERE order_id = $1 ORDER BY line_no`, [id]));
}
async function visible(a: OrdersActor, id: string, lock = false): Promise<Order> {
  const o = await load(id, lock);
  if (!canSeeBranch(a, o.branch_id)) fail(404, 'not_found', 'order');
  return o;
}
/** Flow slices (internal/flow.ts) load an order with the same visibility rule; lock = FOR UPDATE (call it inside orders_writer). */
export const loadForFlow = visible;
export async function getOrder(a: OrdersActor, id: string): Promise<Order> {
  need(a, 'orders.order.view');
  return visible(a, id);
}

const W = /^\d{1,7}(\.\d{1,3})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const GENDERS = ['male', 'female', 'unisex', 'kids'];
/** Shape + masters checks of one line; returns the purity to store (line, else the item's default). */
async function checkLine(l: OrderLineInput, k: number): Promise<string> {
  const p = `lines.${k}`;
  if (l.pieces !== undefined && (!Number.isInteger(l.pieces) || l.pieces < 1 || l.pieces > 999)) invalid(`${p}.pieces`, 'integer 1-999');
  if (l.approx_wt != null && (!W.test(String(l.approx_wt)) || mg(l.approx_wt) <= 0n)) invalid(`${p}.approx_wt`, 'decimal string above 0, up to 3 dp');
  if (l.size != null && (typeof l.size !== 'string' || l.size.length > 30)) invalid(`${p}.size`, 'at most 30 characters');
  if (l.gender != null && !GENDERS.includes(l.gender)) invalid(`${p}.gender`, GENDERS.join(' | '));
  if (l.design_notes != null && (typeof l.design_notes !== 'string' || l.design_notes.length > 1000)) invalid(`${p}.design_notes`, 'at most 1000 characters');
  const stones = l.stones ?? [];
  if (!Array.isArray(stones) || stones.length > 20) invalid(`${p}.stones`, 'at most 20 stones');
  stones.forEach((s, j) => {
    if (typeof s.name !== 'string' || s.name.trim().length < 1 || s.name.length > 60) invalid(`${p}.stones.${j}.name`, '1-60 characters');
    if (!Number.isInteger(s.pieces) || s.pieces < 0 || s.pieces > 9999) invalid(`${p}.stones.${j}.pieces`, 'integer 0-9999');
    if (s.weight != null && !W.test(String(s.weight))) invalid(`${p}.stones.${j}.weight`, 'decimal string, up to 3 dp');
  });
  const files = l.attachment_file_ids ?? [];
  if (files.length > 10) invalid(`${p}.attachment_file_ids`, 'at most 10 files');
  if (new Set(files).size !== files.length) invalid(`${p}.attachment_file_ids`, 'duplicate file');
  if (files.length) {
    const ok = await many<{ id: string }>(`SELECT id::text FROM platform.file WHERE id = ANY($1::uuid[]) AND area = 'attachments' AND deleted_at IS NULL`, [files]);
    if (ok.length !== files.length) fail(422, 'unknown_reference', `${p}.attachment_file_ids`);
  }
  const it = await one<{ is_active: boolean; purity_id: string }>(`SELECT is_active, purity_id FROM masters.item WHERE id = $1`, [l.item_id])
    ?? fail(422, 'unknown_reference', `${p}.item_id`);
  if (!it.is_active) fail(422, 'inactive_master', `${p}.item_id`);
  const purity = l.purity_id ?? it.purity_id;
  const pu = await one<{ is_active: boolean }>(`SELECT is_active FROM masters.purity WHERE id = $1`, [purity]) ?? fail(422, 'unknown_reference', `${p}.purity_id`);
  if (!pu.is_active) fail(422, 'inactive_master', `${p}.purity_id`);
  return purity;
}
async function checkCustomer(id: string | null | undefined): Promise<void> {
  if (!id) return;
  await one(`SELECT 1 FROM masters.customer WHERE id = $1`, [id]) ?? fail(422, 'unknown_reference', 'customer_id');
}
function checkHeader(i: OrderPatch & { order_type?: string }, orderDate: string): void {
  if (i.priority !== undefined && !(PRIORITIES as readonly string[]).includes(i.priority)) invalid('priority', PRIORITIES.join(' | '));
  if (i.notes != null && (typeof i.notes !== 'string' || i.notes.length > 1000)) invalid('notes', 'at most 1000 characters');
  if (i.order_date !== undefined && !DATE.test(i.order_date)) invalid('order_date', 'YYYY-MM-DD');
  if (i.due_date != null) {
    if (!DATE.test(i.due_date)) invalid('due_date', 'YYYY-MM-DD');
    if (i.due_date < orderDate) invalid('due_date', 'must not be before the order date');
  }
  if (i.lines !== undefined && (!Array.isArray(i.lines) || i.lines.length < 1 || i.lines.length > 50)) invalid('lines', '1-50 lines');
}
const addDays = (isoDate: string, n: number): string => new Date(Date.parse(`${isoDate}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const stonesJson = (l: OrderLineInput) => JSON.stringify((l.stones ?? []).map((s) => ({ name: s.name.trim(), pieces: s.pieces, weight: s.weight ?? null })));

/** New customer order (orders.order.create at the branch). order_no from ORD-{BRANCH}-{FY}-{SEQ:5}. */
export async function createOrder(a: OrdersActor, i: OrderInput): Promise<Order> {
  need(a, 'orders.order.create');
  needBranch(a, i.branch_id);
  const type = i.order_type ?? 'customer';
  if (!(ORDER_TYPES as readonly string[]).includes(type)) invalid('order_type', ORDER_TYPES.join(' | '));
  const orderDate = i.order_date ?? todayIST();
  const settings = await loadSettings();
  const ORDER_NO_FORMAT = settings.order_no_format;
  // a shop-wide default due date applies only when the caller sent no due_date at all (an explicit null means no due date)
  if (i.due_date === undefined && settings.default_due_days) i = { ...i, due_date: addDays(orderDate, settings.default_due_days) };
  checkHeader(i, orderDate);
  if (type === 'customer' && !i.customer_id) invalid('customer_id', 'a customer order needs a customer');
  if (type === 'shop' && i.customer_id) invalid('customer_id', 'a shop order has no customer');
  await checkCustomer(i.customer_id);
  const purities: string[] = [];
  for (const [k, l] of i.lines.entries()) purities.push(await checkLine(l, k));
  const code = await branchCode(i.branch_id);
  const fy = indianFY(orderDate);
  const id = await withModuleRole('orders_writer', async (c) => {
    let found: string | undefined;
    for (let attempt = 0; !found && attempt < 50; attempt++) {
      const no = renderDocNo(ORDER_NO_FORMAT, { branchCode: code, fy }, await nextDocNo(i.branch_id, 'order', fy, docPrefixOf(ORDER_NO_FORMAT, { branchCode: code, fy })));
      try {
        found = await withSavepoint(async () => (await c.query<{ id: string }>(
          `INSERT INTO orders.customer_order(tenant_id, branch_id, order_no, order_date, order_type, customer_id, priority, due_date, notes, created_by)
           VALUES (platform.current_tenant(), $1, $2, $3::date, $4, $5, $6, $7::date, $8, $9) RETURNING id`,
          [i.branch_id, no, orderDate, type, i.customer_id ?? null, i.priority ?? 'normal', i.due_date ?? null, i.notes ?? null, a.userId])).rows[0].id);
      } catch (e) {
        if ((e as { code?: string }).code !== '23505') throw e;   // a number taken by an earlier row: try the next one
      }
    }
    if (!found) fail(409, 'duplicate_order_no', 'no free order number');
    for (const [k, l] of i.lines.entries()) await insertLine(found, l, purities[k]);
    return found;
  });
  await audit('orders.order.create', 'orders.customer_order', id, { branch_id: i.branch_id, lines: i.lines.length });
  return load(id);
}
async function insertLine(orderId: string, l: OrderLineInput, purity: string): Promise<void> {
  await withModuleRole('orders_writer', (c) => c.query(
    `INSERT INTO orders.order_line(tenant_id, order_id, line_no, item_id, purity_id, pieces, approx_wt, size, gender, stones, design_notes, attachment_keys)
     VALUES (platform.current_tenant(), $1, (SELECT coalesce(max(line_no), 0) + 1 FROM orders.order_line WHERE order_id = $1), $2, $3, $4, $5::numeric, $6, $7, $8::jsonb, $9, $10::text[])`,
    [orderId, l.item_id, purity, l.pieces ?? 1, l.approx_wt ?? null, l.size ?? null, l.gender ?? null, stonesJson(l), l.design_notes ?? null, l.attachment_file_ids ?? []]));
}

/**
 * Edit an OPEN order whose lines are all still pending (orders.order.create). lines is the whole list: a line with id changes in place,
 * one without is added, one left out is set to cancelled (nothing is deleted). At least one live line must remain. Bumps version.
 */
export async function updateOrder(a: OrdersActor, id: string, p: OrderPatch, ifVersion?: number): Promise<Order> {
  need(a, 'orders.order.create');
  const cur = await visible(a, id);
  needBranch(a, cur.branch_id);
  const editable = (o: Order): void => {
    checkVersion('order', o.version, ifVersion);
    if (o.status !== 'open') fail(409, 'order_not_open', `order is ${o.status}; only an open order can be edited`);
    if (o.lines.some((l) => !['pending', 'cancelled'].includes(l.status))) fail(409, 'order_in_progress', 'a line is already assigned or received');
  };
  editable(cur);
  const orderDate = p.order_date ?? cur.order_date;
  checkHeader(p, orderDate);
  if (p.customer_id !== undefined) {
    if (cur.order_type === 'shop' && p.customer_id) invalid('customer_id', 'a shop order has no customer');
    if (cur.order_type === 'customer' && !p.customer_id) invalid('customer_id', 'a customer order needs a customer');
    await checkCustomer(p.customer_id);
  }
  const purities: string[] = [];
  const lineIds = new Set(cur.lines.map((l) => l.id));
  if (p.lines) {
    for (const [k, l] of p.lines.entries()) {
      if (l.id && !lineIds.has(l.id)) fail(422, 'unknown_reference', `lines.${k}.id`);
      purities.push(await checkLine(l, k));
    }
    if (new Set(p.lines.filter((l) => l.id).map((l) => l.id)).size !== p.lines.filter((l) => l.id).length) invalid('lines', 'a line id appears twice');
  }
  await withModuleRole('orders_writer', async (c) => {
    // lock the row as orders_writer (app_rw has no UPDATE, so FOR UPDATE is not allowed earlier) and re-check against the locked state
    editable(await load(id, true));
    // the header UPDATE always runs: the version trigger bumps on every UPDATE, so a lines-only edit still bumps the version
    await c.query(
      `UPDATE orders.customer_order SET priority = coalesce($2, priority), due_date = CASE WHEN $3::boolean THEN $4::date ELSE due_date END,
         notes = CASE WHEN $5::boolean THEN $6 ELSE notes END, customer_id = CASE WHEN $7::boolean THEN $8::uuid ELSE customer_id END,
         order_date = coalesce($9::date, order_date) WHERE id = $1`,
      [id, p.priority ?? null, p.due_date !== undefined, p.due_date ?? null, p.notes !== undefined, p.notes ?? null,
        p.customer_id !== undefined, p.customer_id ?? null, p.order_date ?? null]);
    if (!p.lines) return;
    const keep = new Set(p.lines.filter((l) => l.id).map((l) => l.id!));
    for (const l of cur.lines) {
      if (l.status !== 'cancelled' && !keep.has(l.id)) await c.query(`UPDATE orders.order_line SET status = 'cancelled' WHERE id = $1`, [l.id]);
    }
    for (const [k, l] of p.lines.entries()) {
      if (!l.id) { await insertLine(id, l, purities[k]); continue; }
      await c.query(
        `UPDATE orders.order_line SET item_id = $2, purity_id = $3, pieces = $4, approx_wt = $5::numeric, size = $6, gender = $7, stones = $8::jsonb,
           design_notes = $9, attachment_keys = $10::text[] WHERE id = $1 AND status IN ('pending','cancelled')`,
        [l.id, l.item_id, purities[k], l.pieces ?? 1, l.approx_wt ?? null, l.size ?? null, l.gender ?? null, stonesJson(l), l.design_notes ?? null, l.attachment_file_ids ?? []]);
      await c.query(`UPDATE orders.order_line SET status = 'pending' WHERE id = $1 AND status = 'cancelled'`, [l.id]);
    }
  });
  await audit('orders.order.update', 'orders.customer_order', id, { lines: p.lines?.length ?? null });
  return load(id);
}

export interface OrderListQ extends PageQ {
  branch_id?: string | null; q?: string; status?: string; customer_id?: string; priority?: string; overdue?: boolean; from?: string; to?: string; due_from?: string; due_to?: string;
}
export async function listOrders(a: OrdersActor, q: OrderListQ = {}): Promise<Page<OrderSummary>> {
  need(a, 'orders.order.view');
  const { limit, cursor } = pageArgs(q);
  if (q.status !== undefined && !['open', 'in_production', 'ready', 'delivered', 'cancelled'].includes(q.status)) invalid('status', 'unknown status');
  if (q.priority !== undefined && !(PRIORITIES as readonly string[]).includes(q.priority)) invalid('priority', PRIORITIES.join(' | '));
  for (const f of ['from', 'to', 'due_from', 'due_to'] as const) if (q[f] !== undefined && !DATE.test(q[f]!)) invalid(f, 'YYYY-MM-DD');
  const like = q.q?.trim() ? `%${q.q.trim().replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
  return page<OrderSummary>(
    `SELECT o.id, o.order_no, o.branch_id, o.order_date::text, o.order_type, o.customer_id, c.name AS customer_name, c.phone AS customer_phone,
            o.priority, o.due_date::text, o.status, ${OVERDUE} AS overdue,
            (SELECT count(*)::int FROM orders.order_line l WHERE l.order_id = o.id AND l.status <> 'cancelled') AS line_count,
            (SELECT coalesce(sum(l.pieces), 0)::int FROM orders.order_line l WHERE l.order_id = o.id AND l.status <> 'cancelled') AS pieces,
            (SELECT coalesce(sum(l.approx_wt), 0)::numeric(14,3)::text FROM orders.order_line l WHERE l.order_id = o.id AND l.status <> 'cancelled') AS approx_wt,
            o.version
       FROM ${FROM}
      WHERE ($1::uuid[] IS NULL OR o.branch_id = ANY($1)) AND ($2::uuid IS NULL OR o.id < $2)
        AND ($3::text IS NULL OR o.status = $3) AND ($4::uuid IS NULL OR o.customer_id = $4) AND ($5::text IS NULL OR o.priority = $5)
        AND ($6::boolean IS NOT TRUE OR ${OVERDUE}) AND ($7::date IS NULL OR o.order_date >= $7) AND ($8::date IS NULL OR o.order_date <= $8)
        AND ($9::text IS NULL OR o.order_no ILIKE $9 OR c.name ILIKE $9 OR c.phone ILIKE $9)
        AND ($10::date IS NULL OR o.due_date >= $10) AND ($11::date IS NULL OR o.due_date <= $11)`,
    [branches(a, q.branch_id), cursor, q.status ?? null, q.customer_id ?? null, q.priority ?? null, q.overdue ?? null, q.from ?? null, q.to ?? null, like, q.due_from ?? null, q.due_to ?? null], limit);
}
