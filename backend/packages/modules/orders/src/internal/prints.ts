import { withModuleRole } from '@jw/db';
import { type OrdersActor } from './actor';
import { fail, invalid } from './errors';
import { audit, many, one } from './db';
import { getOrder, type Order } from './orders';
import { getRepair, type Repair } from './repairs';
import { listAdvances } from './advances';
import { type AdvanceRow } from './ports';

/**
 * O11 prints. Every print is logged in orders.document_print (orders_writer): print 1 = ORIGINAL, later prints = DUPLICATE with a reason
 * (3-200 chars). The server returns the render data; the counter draws it (A4, A5 or 80 mm) with the shop's template. Same permission as viewing
 * the order / repair; out-of-branch callers get 404. English only for now.
 */
export type Paper = 'A4' | 'A5' | 'thermal_80mm';
export interface PrintIn { paper?: Paper; reprint_reason?: string | null }
type Kind = 'order_receipt' | 'repair_receipt' | 'order_vendor_slip' | 'repair_vendor_slip' | 'advance_receipt';
const PAPERS: readonly string[] = ['A4', 'A5', 'thermal_80mm'];

interface Logged { doc_type: Kind; doc_no: string; copy: 'original' | 'duplicate'; print_no: number; paper: Paper; printed_at: string; printed_by: string; reprint_reason: string | null }
async function logPrint(a: OrdersActor, k: { kind: Kind; docId: string; lineId?: string | null; branchId: string; docNo: string }, p: PrintIn): Promise<Logged> {
  if (p.paper !== undefined && !PAPERS.includes(p.paper)) invalid('paper', 'A4 | A5 | thermal_80mm');
  const paper: Paper = p.paper ?? 'A4';
  if (p.reprint_reason != null && typeof p.reprint_reason !== 'string') invalid('reprint_reason', 'text');
  const reason = p.reprint_reason?.trim() || null;
  // serialise prints of one document (print_no = max + 1; the UNIQUE index backs it up)
  await one(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`oprint:${k.kind}:${k.docId}:${k.lineId ?? ''}`]);
  const prev = (await one<{ n: number }>(`SELECT coalesce(max(print_no), 0)::int AS n FROM orders.document_print WHERE doc_type = $1 AND doc_id = $2
      AND line_id IS NOT DISTINCT FROM $3::uuid`, [k.kind, k.docId, k.lineId ?? null]))!.n;
  const copy = prev === 0 ? 'original' : 'duplicate';
  if (copy === 'duplicate' && (reason === null || reason.length < 3 || reason.length > 200))
    invalid('reprint_reason', 'a reprint needs a reason of 3-200 characters', 'reprint_reason_required');
  const r = await withModuleRole('orders_writer', async (c) => (await c.query<{ at: string }>(
    `INSERT INTO orders.document_print(tenant_id, branch_id, doc_type, doc_id, line_id, print_no, copy, paper, reprint_reason, printed_by)
     VALUES (platform.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING to_char(printed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`,
    [k.branchId, k.kind, k.docId, k.lineId ?? null, prev + 1, copy, paper, copy === 'duplicate' ? reason : null, a.userId])).rows[0]);
  await audit('orders.print', 'orders.document_print', k.docId, { doc_type: k.kind, doc_no: k.docNo, line_id: k.lineId ?? null, print_no: prev + 1, copy, paper });
  return { doc_type: k.kind, doc_no: k.docNo, copy, print_no: prev + 1, paper, printed_at: r.at, printed_by: a.userId, reprint_reason: copy === 'duplicate' ? reason : null };
}
async function shopOf(branchId: string): Promise<Record<string, unknown>> {
  const b = await one<{ id: string; code: string; name: string; gstin: string | null; address: unknown; legal_name: string; company_gstin: string | null }>(
    `SELECT b.id, b.code, b.name, b.gstin, b.address, c.legal_name, c.gstin AS company_gstin
       FROM platform.branch b JOIN platform.company c ON c.tenant_id = b.tenant_id AND c.id = b.company_id WHERE b.id = $1`, [branchId]);
  if (!b) fail(404, 'not_found', 'branch');
  return { branch_id: b.id, code: b.code, branch_name: b.name, legal_name: b.legal_name, gstin: b.gstin ?? b.company_gstin, address: b.address };
}
const adv = (x: AdvanceRow) => ({ receipt_no: x.receipt_no, kind: x.kind, received_on: x.received_on, amount: x.amount, purity_id: x.purity_id, weight: x.weight,
  locked_rate_per_g: x.locked_rate_per_g, balance: x.balance, status: x.status });
async function names(table: 'masters.item' | 'masters.purity', ids: string[]): Promise<Map<string, string>> {
  const rows = await many<{ id: string; n: string }>(`SELECT id, ${table === 'masters.item' ? 'name' : 'code'} AS n FROM ${table} WHERE id = ANY($1::uuid[])`, [ids]);
  return new Map(rows.map((r) => [r.id, r.n]));
}
const vendorOf = async (id: string | null) => id === null ? null
  : (await one<{ id: string; code: string; name: string; contacts: unknown }>(`SELECT id, code, name, contacts FROM masters.vendor WHERE id = $1`, [id])) ?? null;

export async function printOrderReceipt(a: OrdersActor, orderId: string, p: PrintIn): Promise<Record<string, unknown>> {
  const o: Order = await getOrder(a, orderId);
  const log = await logPrint(a, { kind: 'order_receipt', docId: orderId, branchId: o.branch_id, docNo: o.order_no }, p);
  const items = await names('masters.item', o.lines.map((l) => l.item_id)); const pur = await names('masters.purity', o.lines.map((l) => l.purity_id));
  const advances = o.customer_id ? await listAdvances(a, orderId) : [];
  return { ...log, shop: await shopOf(o.branch_id), customer: { id: o.customer_id, name: o.customer_name, phone: o.customer_phone },
    document: { order_no: o.order_no, order_date: o.order_date, due_date: o.due_date, priority: o.priority, order_type: o.order_type, status: o.status, notes: o.notes,
      rate_locked_per_g: o.rate_locked_per_g,
      lines: o.lines.filter((l) => l.status !== 'cancelled').map((l) => ({ line_no: l.line_no, item: items.get(l.item_id) ?? null, purity: pur.get(l.purity_id) ?? null, pieces: l.pieces,
        approx_wt: l.approx_wt, size: l.size, gender: l.gender, stones: l.stones, design_notes: l.design_notes })),
      totals: o.totals, advances: advances.map(adv) } };
}
export async function printRepairReceipt(a: OrdersActor, repairId: string, p: PrintIn): Promise<Record<string, unknown>> {
  const r: Repair = await getRepair(a, repairId);
  const log = await logPrint(a, { kind: 'repair_receipt', docId: repairId, branchId: r.branch_id, docNo: r.repair_no }, p);
  return { ...log, shop: await shopOf(r.branch_id), customer: { id: r.customer_id, name: r.customer_name, phone: r.customer_phone },
    document: { repair_no: r.repair_no, received_on: r.received_on, due_date: r.due_date, status: r.status, notes: r.notes,
      lines: r.lines.filter((l) => l.status === 'active').map((l) => ({ line_no: l.line_no, repair_type: l.repair_type_name, description: l.description, gross_wt: l.gross_wt,
        net_wt: l.net_wt, estimate: l.customer_charge })),
      totals: r.totals, advances: r.advances.map(adv) } };
}
export async function printOrderVendorSlip(a: OrdersActor, orderId: string, lineId: string, p: PrintIn): Promise<Record<string, unknown>> {
  const o = await getOrder(a, orderId);
  const l = o.lines.find((x) => x.id === lineId) ?? fail(404, 'not_found', 'order line');
  if (l.status === 'cancelled' || l.vendor_id === null) fail(409, 'line_not_assigned', 'the line is not with a vendor');
  const log = await logPrint(a, { kind: 'order_vendor_slip', docId: orderId, lineId, branchId: o.branch_id, docNo: o.order_no }, p);
  const items = await names('masters.item', [l.item_id]); const pur = await names('masters.purity', [l.purity_id]);
  return { ...log, shop: await shopOf(o.branch_id), vendor: await vendorOf(l.vendor_id),
    document: { order_no: o.order_no, due_date: l.vendor_due, assigned_at: l.assigned_at, vendor_note: l.vendor_note,
      line: { item: items.get(l.item_id) ?? null, purity: pur.get(l.purity_id) ?? null, pieces: l.pieces, approx_wt: l.approx_wt, size: l.size, gender: l.gender, stones: l.stones, design_notes: l.design_notes } } };
}
export async function printRepairVendorSlip(a: OrdersActor, repairId: string, lineId: string, p: PrintIn): Promise<Record<string, unknown>> {
  const r = await getRepair(a, repairId);
  const l = r.lines.find((x) => x.id === lineId) ?? fail(404, 'not_found', 'repair line');
  if (l.status !== 'active' || l.vendor_id === null || l.issued_at === null) fail(409, 'line_not_issued', 'the line was not issued to a vendor');
  const log = await logPrint(a, { kind: 'repair_vendor_slip', docId: repairId, lineId, branchId: r.branch_id, docNo: r.repair_no }, p);
  return { ...log, shop: await shopOf(r.branch_id), vendor: await vendorOf(l.vendor_id),
    document: { repair_no: r.repair_no, due_date: r.due_date, issued_at: l.issued_at, vendor_note: l.vendor_note,
      line: { repair_type: l.repair_type_name, description: l.description, gross_wt: l.gross_wt, net_wt: l.net_wt, vendor_charge: l.vendor_charge } } };
}
export async function printAdvanceReceipt(a: OrdersActor, parent: 'order' | 'repair', parentId: string, advanceId: string, p: PrintIn): Promise<Record<string, unknown>> {
  const doc = parent === 'order' ? await getOrder(a, parentId) : await getRepair(a, parentId);
  const list = parent === 'order' ? await listAdvances(a, parentId) : (doc as Repair).advances;
  const x = list.find((y) => y.id === advanceId) ?? fail(404, 'not_found', 'advance');
  const no = parent === 'order' ? (doc as Order).order_no : (doc as Repair).repair_no;
  const log = await logPrint(a, { kind: 'advance_receipt', docId: advanceId, branchId: doc.branch_id, docNo: x.receipt_no }, p);
  return { ...log, shop: await shopOf(doc.branch_id), customer: { id: x.customer_id, name: doc.customer_name, phone: doc.customer_phone },
    document: { for: parent, for_no: no, ...adv(x), purity: x.purity_id ? (await names('masters.purity', [x.purity_id])).get(x.purity_id) ?? null : null, purpose: x.purpose } };
}
