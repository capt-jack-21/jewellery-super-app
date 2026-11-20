import { type OrdersActor, need } from './actor';
import { invalid } from './errors';
import { many, one } from './db';
import { branches, page, pageArgs, type Page, type PageQ } from './lists';

/** O10: repair list (newest first) and the due-today / overdue summary of orders and repairs. */
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = ['received', 'issued_to_vendor', 'received_from_vendor', 'ready', 'delivered', 'cancelled'];
const TODAY = `(now() AT TIME ZONE 'Asia/Kolkata')::date`;
const R_OPEN = `r.status IN ('received','issued_to_vendor','received_from_vendor','ready')`;
export interface RepairSummary {
  id: string; repair_no: string; branch_id: string; received_on: string; customer_id: string; customer_name: string | null; customer_phone: string | null;
  due_date: string | null; status: string; overdue: boolean; line_count: number; gross_wt: string; estimate: string; version: number;
}
export interface RepairListQ extends PageQ {
  branch_id?: string | null; q?: string; status?: string; customer_id?: string; overdue?: boolean; from?: string; to?: string; due_from?: string; due_to?: string;
}
export async function listRepairs(a: OrdersActor, q: RepairListQ = {}): Promise<Page<RepairSummary>> {
  need(a, 'orders.repair.view');
  const { limit, cursor } = pageArgs(q);
  if (q.status !== undefined && !STATUSES.includes(q.status)) invalid('status', 'unknown status');
  for (const f of ['from', 'to', 'due_from', 'due_to'] as const) if (q[f] !== undefined && !DATE.test(q[f]!)) invalid(f, 'YYYY-MM-DD');
  const like = q.q?.trim() ? `%${q.q.trim().replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
  return page<RepairSummary>(
    `SELECT r.id, r.repair_no, r.branch_id, r.received_on::text, r.customer_id, c.name AS customer_name, c.phone AS customer_phone, r.due_date::text, r.status,
            (r.due_date IS NOT NULL AND r.due_date < ${TODAY} AND ${R_OPEN}) AS overdue,
            (SELECT count(*)::int FROM orders.repair_line l WHERE l.repair_id = r.id AND l.status = 'active') AS line_count,
            (SELECT coalesce(sum(l.gross_wt), 0)::numeric(14,3)::text FROM orders.repair_line l WHERE l.repair_id = r.id AND l.status = 'active') AS gross_wt,
            (SELECT coalesce(sum(l.customer_charge), 0)::numeric(14,2)::text FROM orders.repair_line l WHERE l.repair_id = r.id AND l.status = 'active') AS estimate,
            r.version
       FROM orders.repair r LEFT JOIN masters.customer c ON c.tenant_id = r.tenant_id AND c.id = r.customer_id
      WHERE ($1::uuid[] IS NULL OR r.branch_id = ANY($1)) AND ($2::uuid IS NULL OR r.id < $2)
        AND ($3::text IS NULL OR r.status = $3) AND ($4::uuid IS NULL OR r.customer_id = $4)
        AND ($5::boolean IS NOT TRUE OR (r.due_date IS NOT NULL AND r.due_date < ${TODAY} AND ${R_OPEN}))
        AND ($6::date IS NULL OR r.received_on >= $6) AND ($7::date IS NULL OR r.received_on <= $7)
        AND ($8::date IS NULL OR r.due_date >= $8) AND ($9::date IS NULL OR r.due_date <= $9)
        AND ($10::text IS NULL OR r.repair_no ILIKE $10 OR c.name ILIKE $10 OR c.phone ILIKE $10)`,
    [branches(a, q.branch_id), cursor, q.status ?? null, q.customer_id ?? null, q.overdue ?? null, q.from ?? null, q.to ?? null, q.due_from ?? null, q.due_to ?? null, like], limit);
}

export interface DueCounts { due_today: number; overdue: number }
export interface DueSummary { as_of: string; orders: DueCounts | null; repairs: DueCounts | null }
/** Open orders / repairs due today or past due, in the caller's branches. A section is null when the caller cannot view that kind. */
export async function dueSummary(a: OrdersActor, branchId?: string | null): Promise<DueSummary> {
  if (!a.permissions.has('orders.order.view') && !a.permissions.has('orders.repair.view')) need(a, 'orders.order.view');
  const b = branches(a, branchId);
  const day = (await one<{ d: string }>(`SELECT ${TODAY}::text AS d`))!.d;
  const counts = async (table: string, open: string): Promise<DueCounts> => {
    const r = (await many<{ due_today: number; overdue: number }>(
      `SELECT (count(*) FILTER (WHERE due_date = ${TODAY}))::int AS due_today, (count(*) FILTER (WHERE due_date < ${TODAY}))::int AS overdue
         FROM ${table} WHERE ($1::uuid[] IS NULL OR branch_id = ANY($1)) AND due_date IS NOT NULL AND status IN (${open})`, [b]))[0];
    return { due_today: r.due_today, overdue: r.overdue };
  };
  return {
    as_of: day,
    orders: a.permissions.has('orders.order.view') ? await counts('orders.customer_order', `'open','in_production','ready'`) : null,
    repairs: a.permissions.has('orders.repair.view') ? await counts('orders.repair', `'received','issued_to_vendor','received_from_vendor','ready'`) : null,
  };
}
