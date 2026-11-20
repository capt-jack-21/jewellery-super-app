import type { PoolClient } from 'pg';
import { currentTx, withModuleRole } from '@jw/db';
import { fail } from './errors';
import type { TagStatus } from './statuses';

export const tx = (): PoolClient => currentTx();
/**
 * 0.9.0: SQL select item rendering a timestamptz column as RFC 3339 in UTC with microseconds ("2026-11-09T13:16:01.792494Z"); NULL stays NULL.
 * Every timestamp Inventory returns goes through this (it was `col::text` = "2026-11-09 18:46:01.792494+05:30": a space instead of "T",
 * not RFC 3339 / OpenAPI `format: date-time`). Same form tag history `at` already used. Dates (received_on, since) stay `::text` (YYYY-MM-DD).
 */
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
export async function outbox(topic: string, payload: Record<string, unknown>): Promise<void> {
  await tx().query(`INSERT INTO notifications.outbox(tenant_id, topic, payload) VALUES (platform.current_tenant(), $1, $2::jsonb)`,
    [topic, JSON.stringify(payload)]);
}

export interface LedgerRow {
  branch_id: string; tag_id?: string | null; item_id?: string | null; purity_id: string; movement: string; direction: 1 | -1;
  pieces: number | string; gross_wt: string; net_wt: string; source_type: string; source_id: string; user_id: string;
  counter_id?: string | null; box_id?: string | null;
}
/** stock_ledger INSERT as inventory_writer (the only role allowed to). fine_wt = net × fineness/1000. */
export async function ledger(rows: LedgerRow[]): Promise<void> {
  if (!rows.length) return;
  await withModuleRole('inventory_writer', async (c) => {
    for (const r of rows) {
      const res = await c.query(
        `INSERT INTO inventory.stock_ledger(tenant_id, branch_id, tag_id, item_id, purity_id, movement, direction, pieces, gross_wt, net_wt,
                                            fine_wt, source_module, source_type, source_id, user_id, counter_id, box_id)
         SELECT platform.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8::numeric, $9::numeric,
                round($9::numeric * CASE WHEN p.fineness > 1 THEN p.fineness / 1000.0 ELSE p.fineness END, 3),
                'inventory', $10, $11, $12, $13, $14
           FROM masters.purity p WHERE p.id = $4`,
        [r.branch_id, r.tag_id ?? null, r.item_id ?? null, r.purity_id, r.movement, r.direction, r.pieces, r.gross_wt, r.net_wt,
         r.source_type, r.source_id, r.user_id, r.counter_id ?? null, r.box_id ?? null]);
      if (res.rowCount !== 1) fail(422, 'unknown_reference', 'purity_id');   // purity not visible: never drop a ledger row silently
    }
  });
}

/** Columns only inventory_writer may update (960/987): status, branch_id, gross/net/stone weight, pieces. */
export interface TagWriterPatch { status?: TagStatus; branch_id?: string; gross_wt?: string; net_wt?: string; stone_wt?: string; pieces?: number }
export async function writeTag(tagId: string, p: TagWriterPatch): Promise<void> {
  const cols = Object.entries(p).filter(([, v]) => v !== undefined);
  if (!cols.length) return;
  const set = cols.map(([k], i) => `${k} = $${i + 2}`).join(', ');
  await withModuleRole('inventory_writer', async (c) => {
    const r = await c.query(`UPDATE inventory.tag SET ${set} WHERE id = $1`, [tagId, ...cols.map(([, v]) => v)]);
    if (r.rowCount !== 1) fail(404, 'not_found', 'tag');
  });
}

export interface TagRow {
  id: string; tag_no: string; branch_id: string; item_id: string; purity_id: string; status: TagStatus; pieces: number;
  gross_wt: string; net_wt: string; stone_wt: string; counter_id: string | null; box_id: string | null; huid: string | null; version: number;
}
const TAG_COLS = `id, tag_no, branch_id, item_id, purity_id, status, pieces, gross_wt::text, net_wt::text, stone_wt::text, counter_id, box_id, huid, version`;
/** Locks the tags (FOR UPDATE) in id order; 404 when any is missing / not visible. */
export async function lockTags(ids: string[]): Promise<Map<string, TagRow>> {
  const uniq = [...new Set(ids)].sort();
  const rows = await many<TagRow>(`SELECT ${TAG_COLS} FROM inventory.tag WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [uniq]);
  if (rows.length !== uniq.length) fail(404, 'not_found', 'tag not found');
  return new Map(rows.map((r) => [r.id, r]));
}
export const lockTag = async (id: string): Promise<TagRow> => (await lockTags([id])).get(id)!;

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
/** Decimal helpers on 3-dp gram strings, exact (integers of milligrams). */
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
