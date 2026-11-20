import { one, many, audit, iso, newId, tx } from './db';
import { fail, checkVersion } from './errors';
import { type SalesActor, need, needAny, needBranch, branchScope } from './actor';
import { parseBill, type BillReq } from './request';
import { prepare, judge, computation, nowIso } from './bill';
import { loadShop } from './settings';
import { nextCounterNo } from './numbering';
import { SalesError } from './errors';

/**
 * S13 estimates — not tax documents. Own non-gapless counter (platform.doc_counter 'estimate'), written as app_rw (992 grants);
 * frozen once billed / cancelled / expired (policy edit_until_closed). valid_until is stored as the exclusive end of the IST day.
 */
const COLS = `e.id, e.estimate_no, e.branch_id, e.estimate_date::text, ((e.valid_until AT TIME ZONE 'Asia/Kolkata') - interval '1 microsecond')::date::text AS valid_until,
  CASE WHEN e.status = 'draft' AND e.valid_until IS NOT NULL AND e.valid_until <= now() THEN 'expired' ELSE e.status END AS status,
  e.customer_id, e.salesperson_id, e.payload AS request, e.computation, e.invoice_id, e.notes, e.created_by, ${iso('e.created_at', 'created_at')}, e.version,
  (SELECT count(*)::int FROM sales.document_print p WHERE p.tenant_id = e.tenant_id AND p.doc_type = 'estimate' AND p.doc_id = e.id) AS print_count,
  (SELECT ${iso('max(p.printed_at)', 'x')} FROM sales.document_print p WHERE p.tenant_id = e.tenant_id AND p.doc_type = 'estimate' AND p.doc_id = e.id) AS last_printed_at`;
type Row = Record<string, unknown> & { id: string; status: string; branch_id: string; version: number; request: Record<string, unknown> };

/** Stored request (EstimateRequest shape: only the keys the client sent). */
function requestOf(body: Record<string, unknown>): Record<string, unknown> {
  const keep = ['branch_id', 'customer_id', 'place_of_supply', 'salesperson_id', 'lines', 'bill_discount', 'discount_reason', 'old_metal', 'valid_until', 'notes'];
  return Object.fromEntries(Object.entries(body).filter(([k, v]) => keep.includes(k) && v !== undefined));
}
async function compute(a: SalesActor, req: BillReq, day: string): Promise<Record<string, unknown>> {
  const p = await prepare(a, req, 'estimate', day);
  await judge(a, p, false);
  p.computed_at = await nowIso();
  return computation(p);
}
async function validUntil(req: BillReq, day: string): Promise<string> {
  const shop = await loadShop();
  const until = req.valid_until ?? (await one<{ d: string }>(`SELECT ($1::date + $2::int)::text AS d`, [day, shop.estimate_validity_days]))!.d;
  if (until < day) fail(422, 'validation_failed', 'valid_until is in the past', [{ path: 'valid_until', code: 'invalid', message: 'before today' }]);
  return until;
}
export async function estimateView(a: SalesActor, id: string, day: string, reprice = true): Promise<Row> {
  const e = await one<Row>(`SELECT ${COLS} FROM sales.estimate e WHERE e.id = $1`, [id]);
  if (!e) fail(404, 'not_found', 'estimate');
  needBranch(a, e.branch_id);
  if (reprice && e.status === 'draft') {
    try { e.computation = await compute(a, parseBill(e.request, 'estimate'), day); } catch (err) { if (!(err instanceof SalesError)) throw err; }
  }
  return e;
}
export async function createEstimate(a: SalesActor, body: unknown, day: string): Promise<string> {
  need(a, 'sales.estimate.create');
  const req = parseBill(body, 'estimate');
  const comp = await compute(a, req, day);
  const until = await validUntil(req, day);
  const shop = await loadShop();
  const { no } = await nextCounterNo(req.branch_id, 'estimate', shop.estimate_no_format);
  const id = await newId();
  await tx().query(`INSERT INTO sales.estimate(tenant_id, id, branch_id, estimate_no, estimate_date, customer_id, salesperson_id, status, valid_until, payload, est_total,
      created_by, computation, notes, updated_by)
    VALUES (platform.current_tenant(), $1, $2, $3, $4::date, $5, $6, 'draft', (($7::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata'), $8::jsonb, $9, $10, $11::jsonb, $12, $10)`,
    [id, req.branch_id, no, day, req.customer_id, req.salesperson_id, until, JSON.stringify(requestOf(body as Record<string, unknown>)),
     (comp.totals as { net_payable: string }).net_payable, a.userId, JSON.stringify(comp), req.notes]);
  await audit('sales.estimate.create', 'sales.estimate', id, { estimate_no: no, branch_id: req.branch_id });
  return id;
}
async function openForEdit(a: SalesActor, id: string, ifVersion: number | undefined): Promise<Row> {
  // plain read first: FOR UPDATE applies the UPDATE policy (edit_until_closed), which hides closed estimates — they are 409, not 404
  const seen = await one<Row>(`SELECT ${COLS} FROM sales.estimate e WHERE e.id = $1`, [id]);
  if (!seen) fail(404, 'not_found', 'estimate');
  needBranch(a, seen.branch_id);
  checkVersion('estimate', seen.version, ifVersion);
  if (seen.status !== 'draft') fail(409, 'estimate_not_open', `estimate is ${seen.status}`);
  const e = await one<Row>(`SELECT ${COLS} FROM sales.estimate e WHERE e.id = $1 FOR UPDATE OF e`, [id]);
  if (!e) fail(409, 'estimate_not_open', 'estimate was closed meanwhile');
  checkVersion('estimate', e.version, ifVersion);
  return e;
}
export async function replaceEstimate(a: SalesActor, id: string, body: unknown, ifVersion: number | undefined, day: string): Promise<void> {
  need(a, 'sales.estimate.create');
  const e = await openForEdit(a, id, ifVersion);
  const req = parseBill(body, 'estimate');
  if (req.branch_id !== e.branch_id) fail(422, 'validation_failed', 'branch cannot change', [{ path: 'branch_id', code: 'invalid', message: 'branch of an estimate is fixed' }]);
  const comp = await compute(a, req, day);
  const until = await validUntil(req, day);
  const r = await tx().query(`UPDATE sales.estimate SET customer_id = $2, salesperson_id = $3, valid_until = (($4::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata'),
      payload = $5::jsonb, est_total = $6, computation = $7::jsonb, notes = $8, updated_by = $9, updated_at = now() WHERE id = $1 AND version = $10`,
    [id, req.customer_id, req.salesperson_id, until, JSON.stringify(requestOf(body as Record<string, unknown>)), (comp.totals as { net_payable: string }).net_payable,
     JSON.stringify(comp), req.notes, a.userId, e.version]);
  if (r.rowCount !== 1) fail(412, 'version_mismatch', 'estimate changed meanwhile');
  await audit('sales.estimate.update', 'sales.estimate', id, { estimate_no: e.estimate_no, version: e.version + 1 });
}
export async function cancelEstimate(a: SalesActor, id: string, ifVersion: number | undefined): Promise<void> {
  need(a, 'sales.estimate.create');
  const e = await openForEdit(a, id, ifVersion);
  const r = await tx().query(`UPDATE sales.estimate SET status = 'cancelled', updated_by = $2, updated_at = now() WHERE id = $1 AND version = $3`, [id, a.userId, e.version]);
  if (r.rowCount !== 1) fail(412, 'version_mismatch', 'estimate changed meanwhile');
  await audit('sales.estimate.cancel', 'sales.estimate', id, { estimate_no: e.estimate_no });
}
export async function getEstimate(a: SalesActor, id: string, day: string): Promise<Row> {
  needAny(a, ['sales.estimate.create', 'sales.invoice.view']);
  return estimateView(a, id, day);
}
export async function listEstimates(a: SalesActor, q: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  needAny(a, ['sales.estimate.create', 'sales.invoice.view']);
  const w: string[] = []; const p: unknown[] = [];
  const add = (sql: string, v: unknown) => { p.push(v); w.push(sql.replace(/\?/g, `$${p.length}`)); };
  const scope = branchScope(a);
  if (q.branch_id) { needBranch(a, q.branch_id); add('e.branch_id = ?', q.branch_id); } else if (scope) add('e.branch_id = ANY(?::uuid[])', [...scope]);
  if (q.status === 'expired') w.push(`e.status = 'draft' AND e.valid_until <= now()`);
  else if (q.status === 'draft') w.push(`e.status = 'draft' AND (e.valid_until IS NULL OR e.valid_until > now())`);
  else if (q.status) add('e.status = ?', q.status);
  if (q.customer_id) add('e.customer_id = ?::uuid', q.customer_id);
  if (q.from) add('e.estimate_date >= ?::date', q.from);
  if (q.to) add('e.estimate_date <= ?::date', q.to);
  if (q.q) { p.push(q.q.trim()); const n = p.length;
    w.push(`(upper(e.estimate_no) LIKE upper($${n}) || '%' OR lower(c.name) LIKE lower($${n}) || '%' OR c.phone = $${n})`); }
  const limit = Math.min(Math.max(Number(q.limit ?? 50) || 50, 1), 200);
  if (q.cursor) {
    const [ts, id] = Buffer.from(q.cursor, 'base64url').toString().split('|');
    if (!ts || !id) fail(422, 'validation_failed', 'bad cursor', [{ path: 'cursor', code: 'invalid', message: 'bad cursor' }]);
    p.push(ts, id); w.push(`(e.created_at, e.id) < ($${p.length - 1}::timestamptz, $${p.length}::uuid)`);
  }
  p.push(limit + 1);
  const rows = await many<Record<string, unknown> & { id: string; at: string }>(`SELECT e.id, e.estimate_no, e.branch_id, e.estimate_date::text,
      ((e.valid_until AT TIME ZONE 'Asia/Kolkata') - interval '1 microsecond')::date::text AS valid_until,
      CASE WHEN e.status = 'draft' AND e.valid_until <= now() THEN 'expired' ELSE e.status END AS status, e.customer_id, c.name AS customer_name,
      to_char(coalesce(e.est_total, 0), 'FM999999999990.00') AS net_payable, e.invoice_id, e.version, e.created_at::text AS at
    FROM sales.estimate e LEFT JOIN masters.customer c ON c.tenant_id = e.tenant_id AND c.id = e.customer_id
    ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY e.created_at DESC, e.id DESC LIMIT $${p.length}`, p);
  const more = rows.length > limit; const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items: items.map(({ at, ...r }) => { void at; return r; }), next_cursor: more && last ? Buffer.from(`${last.at}|${last.id}`).toString('base64url') : null };
}
