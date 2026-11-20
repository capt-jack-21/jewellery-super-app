import type { PoolClient } from 'pg';
import { currentTx, withModuleRole } from '@jw/db';

export const tx = (): PoolClient => currentTx();
/** RFC 3339 UTC with microseconds ("2026-11-09T13:16:01.792494Z"); NULL stays NULL (same as Inventory 0.9.0). */
export function iso(col: string, as: string = col.replace(/^\w+\./, '')): string {
  return `to_char((${col}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${as}`;
}
export const isoExpr = (col: string): string => `to_char((${col}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
export async function one<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  return (await tx().query(sql, params)).rows[0] as T | undefined;
}
export async function many<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await tx().query(sql, params)).rows as T[];
}
/** Writes to tax documents, their children, the due row, receipts and the print log: only as sales_writer (INV-2). */
export const asWriter = <T>(fn: (c: PoolClient) => Promise<T>): Promise<T> => withModuleRole('sales_writer', fn);
/** platform.audit_append. Never put PAN (even masked beyond last4) or Aadhaar in data. */
export async function audit(action: string, table: string, rowId: string | null, data: Record<string, unknown>): Promise<void> {
  await tx().query(`SELECT platform.audit_append(platform.current_tenant(), $1, $2, $3::uuid, NULL, $4::jsonb)`,
    [action, table, rowId, JSON.stringify(data)]);
}
export async function outbox(topic: string, payload: Record<string, unknown>): Promise<void> {
  await tx().query(`INSERT INTO notifications.outbox(tenant_id, topic, payload) VALUES (platform.current_tenant(), $1, $2::jsonb)`,
    [topic, JSON.stringify(payload)]);
}
export const newId = async (): Promise<string> => (await one<{ id: string }>(`SELECT platform.uuid_v7() AS id`))!.id;
/** IST calendar date of the DB clock (doc_date rule D29). */
export const todayIST = async (): Promise<string> => (await one<{ d: string }>(`SELECT ((now() AT TIME ZONE 'Asia/Kolkata')::date)::text AS d`))!.d;
/**
 * Contract PaymentStatus (paid | part_paid | unpaid): "a cancelled bill keeps the status it had". v_invoice_balance reports 'cancelled'
 * (and balance 0) for a cancelled bill, so the status it had is derived: due before the cancellation = net payable − paid (issue + receipts,
 * reversals net out) − dues already credited by sales returns.
 */
export const payStatusSql = (v: string): string => `(CASE WHEN ${v}.payment_status <> 'cancelled' THEN ${v}.payment_status
  WHEN ${v}.net_payable - ${v}.paid_amount - coalesce((SELECT sum(c.due_reduced) FROM sales.credit_note c WHERE c.tenant_id = ${v}.tenant_id
       AND c.invoice_id = ${v}.invoice_id AND c.kind = 'sales_return'), 0) <= 0 THEN 'paid'
  WHEN ${v}.paid_amount = 0 THEN 'unpaid' ELSE 'part_paid' END)`;
