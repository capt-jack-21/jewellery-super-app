import { one, tx, asWriter } from './db';
import { fail } from './errors';

/**
 * S12 numbering. Tax invoices and credit notes: the ONLY gapless series (sales.doc_series, INV-1, guards G1/G2), allocated as sales_writer
 * inside the issuing transaction (the UPDATE row lock serialises concurrent issuers; rollback releases the number).
 *   invoice     {prefix}/{FY yyyy}/{seq:6}   e.g. CBE/2627/000041   (≤ 16 chars, GST rule 46)
 *   credit note {prefix}/C{FY yyyy}/{seq:5}  e.g. CBE/C2627/00003
 * prefix = branch.bill_series_prefix (else branch code), letters / digits only, at most 4 characters (readiness gate invoice_series).
 * Estimates and receipts: platform.doc_counter (gaps allowed), formats from shop_setting ({BRANCH}, {FY}, {SEQ:n}).
 */
export const fy4 = (fy: string): string => `${fy.slice(2, 4)}${fy.slice(5, 7)}`;          // "2026-27" → "2627"
export const cleanPrefix = (p: string | null | undefined): string => (p ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export async function branchPrefix(branchId: string): Promise<{ prefix: string; code: string; ok: boolean }> {
  const b = await one<{ p: string | null; code: string }>(`SELECT bill_series_prefix AS p, code FROM platform.branch WHERE id = $1`, [branchId]);
  if (!b) fail(422, 'unknown_reference', 'branch_id');
  const prefix = cleanPrefix(b.p) || cleanPrefix(b.code);
  return { prefix, code: b.code, ok: prefix.length >= 1 && prefix.length <= 4 };
}
export const currentFy = async (): Promise<string> =>
  (await one<{ fy: string }>(`SELECT platform.fy_of((now() AT TIME ZONE 'Asia/Kolkata')::date) AS fy`))!.fy;
export function renderGapless(docType: 'tax_invoice' | 'credit_note', prefix: string, fy: string, seq: number): string {
  return docType === 'tax_invoice' ? `${prefix}/${fy4(fy)}/${String(seq).padStart(6, '0')}` : `${prefix}/C${fy4(fy)}/${String(seq).padStart(5, '0')}`;
}
/** Next gapless number (INV-1). Must be used by an invoice / credit note before COMMIT (G2). */
export async function allocateGapless(branchId: string, docType: 'tax_invoice' | 'credit_note'): Promise<{ fy: string; seq: number; docNo: string }> {
  const bp = await branchPrefix(branchId);
  if (!bp.ok) fail(409, 'onboarding_incomplete', 'branch bill series prefix must be 1-4 letters / digits (readiness gate invoice_series)');
  const fy = await currentFy();
  return asWriter(async (c) => {
    await c.query(`INSERT INTO sales.doc_series(tenant_id, branch_id, doc_type, fy, prefix) VALUES (platform.current_tenant(), $1, $2, $3, $4)
                   ON CONFLICT DO NOTHING`, [branchId, docType, fy, bp.prefix]);
    const r = await c.query<{ seq: number; prefix: string }>(`UPDATE sales.doc_series SET next_no = next_no + 1
        WHERE tenant_id = platform.current_tenant() AND branch_id = $1 AND doc_type = $2 AND fy = $3 RETURNING next_no - 1 AS seq, prefix`,
      [branchId, docType, fy]);
    const seq = Number(r.rows[0].seq);
    return { fy, seq, docNo: renderGapless(docType, r.rows[0].prefix, fy, seq) };
  });
}
/** Legacy helper kept for tests/integration/tenancy (prefix callback; seq padded to 6). */
export async function allocateDocNo(branchId: string, docType: 'tax_invoice' | 'credit_note', prefix: (fy: string) => string) {
  const fy = await currentFy();
  return asWriter(async (c) => {
    await c.query(`INSERT INTO sales.doc_series(tenant_id, branch_id, doc_type, fy, prefix) VALUES (platform.current_tenant(), $1, $2, $3, $4)
                   ON CONFLICT DO NOTHING`, [branchId, docType, fy, prefix(fy)]);
    const r = await c.query<{ seq: number; prefix: string }>(`UPDATE sales.doc_series SET next_no = next_no + 1
        WHERE tenant_id = platform.current_tenant() AND branch_id = $1 AND doc_type = $2 AND fy = $3 RETURNING next_no - 1 AS seq, prefix`,
      [branchId, docType, fy]);
    const { seq, prefix: px } = r.rows[0];
    return { fy, seq: Number(seq), docNo: px + String(seq).padStart(6, '0') };
  });
}
/** Renders {BRANCH}, {FY} (yyyy) and {SEQ:n}. */
export function renderCounterNo(fmt: string, branchCode: string, fy: string, seq: number): string {
  return fmt.replace(/\{BRANCH\}/g, cleanPrefix(branchCode)).replace(/\{FY\}/g, fy4(fy))
    .replace(/\{SEQ(?::(\d{1,2}))?\}/g, (_m, w: string | undefined) => String(seq).padStart(w ? Number(w) : 1, '0'));
}
/** platform.doc_counter (non-gapless; estimates 'estimate', receipts 'sales_receipt'). */
export async function nextCounterNo(branchId: string, docType: 'estimate' | 'sales_receipt' | 'advance_receipt', fmt: string): Promise<{ fy: string; no: string }> {
  const fy = await currentFy();
  const { code } = await branchPrefix(branchId);
  const prefix = renderCounterNo(fmt.split('{SEQ')[0], code, fy, 0);
  await tx().query(`INSERT INTO platform.doc_counter(tenant_id, branch_id, doc_type, fy, prefix, next_no)
                    VALUES (platform.current_tenant(), $1, $2, $3, $4, 1) ON CONFLICT DO NOTHING`, [branchId, docType, fy, prefix]);
  const r = await one<{ n: string }>(`UPDATE platform.doc_counter SET next_no = next_no + 1
      WHERE tenant_id = platform.current_tenant() AND branch_id = $1 AND doc_type = $2 AND fy = $3 RETURNING (next_no - 1)::text AS n`, [branchId, docType, fy]);
  return { fy, no: renderCounterNo(fmt, code, fy, Number(r!.n)) };
}
