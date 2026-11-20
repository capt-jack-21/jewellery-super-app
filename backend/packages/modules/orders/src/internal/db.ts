import type { PoolClient } from 'pg';
import { currentTx } from '@jw/db';
import { fail } from './errors';

export const tx = (): PoolClient => currentTx();
/** SQL select item: timestamptz column as RFC 3339 UTC with microseconds ("2026-11-18T03:41:56.268430Z"); NULL stays NULL. */
export function iso(col: string, as: string = col.replace(/^\w+\./, '')): string {
  return `to_char((${col}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${as}`;
}
export async function one<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  return (await tx().query(sql, params)).rows[0] as T | undefined;
}
export async function many<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await tx().query(sql, params)).rows as T[];
}
/** platform.audit_append(tenant, action, table, row, old, new). Never put PAN / Aadhaar in data. */
export async function audit(action: string, table: string, rowId: string | null, data: Record<string, unknown>): Promise<void> {
  await tx().query(`SELECT platform.audit_append(platform.current_tenant(), $1, $2, $3::uuid, NULL, $4::jsonb)`,
    [action, table, rowId, JSON.stringify(data)]);
}
/** platform.doc_counter next number (non-gapless): per shop, branch, doc_type and FY. */
export async function nextDocNo(branchId: string, docType: string, fy: string, prefix: string): Promise<number> {
  const c = tx();
  await c.query(`INSERT INTO platform.doc_counter(tenant_id, branch_id, doc_type, fy, prefix, next_no)
                 VALUES (platform.current_tenant(), $1, $2, $3, $4, 1) ON CONFLICT DO NOTHING`, [branchId, docType, fy, prefix]);
  const r = await c.query<{ n: string }>(
    `UPDATE platform.doc_counter SET next_no = next_no + 1
      WHERE tenant_id = platform.current_tenant() AND branch_id = $1 AND doc_type = $2 AND fy = $3 RETURNING (next_no - 1)::text AS n`,
    [branchId, docType, fy]);
  return Number(r.rows[0].n);
}
export async function branchCode(branchId: string): Promise<string> {
  const b = await one<{ code: string }>(`SELECT code FROM platform.branch WHERE id = $1`, [branchId]);
  return b?.code ?? fail(422, 'unknown_reference', 'branch_id');
}
/** Exact decimal helpers on 3-dp gram strings (integers of milligrams). */
export const mg = (s: string | number): bigint => {
  const [i, f = ''] = String(s).trim().replace(/^\+/, '').split('.');
  const neg = i.startsWith('-');
  const v = BigInt(i.replace('-', '') || '0') * 1000n + BigInt((f + '000').slice(0, 3));
  return neg ? -v : v;
};
export const gm = (v: bigint): string => {
  const neg = v < 0n; const a = neg ? -v : v;
  return `${neg ? '-' : ''}${a / 1000n}.${String(a % 1000n).padStart(3, '0')}`;
};
