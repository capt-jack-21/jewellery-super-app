import ExcelJS from 'exceljs';
import type { AuthContext } from './common';
import { XLSX_TYPE } from './storage';

/**
 * 0.7.0: extension points so other modules (masters) can add import kinds and file-access rules without platform
 * importing them (module boundaries: platform never depends on masters).
 */
export type RowErr = { row: number; column?: string; code: string; message: string; raw?: Record<string, string> };
export interface ImportKindDef {
  template: string[];
  required: string[];
  /** extra permission on top of platform.import.run (e.g. masters.items.manage) */
  perm: string;
  validate(rows: Record<string, string>[]): Promise<{ ok: unknown[]; errors: RowErr[] }>;
  commit(ok: unknown[], ctx: { userId: string; branchId: string | null }): Promise<void>;
}
const importKinds = new Map<string, ImportKindDef>();
export function registerImportKind(kind: string, def: ImportKindDef): void { importKinds.set(kind, def); }
export const importKind = (kind: string): ImportKindDef | undefined => importKinds.get(kind);

/**
 * 0.8.2: the built-in 'stock' import kind is committed by Inventory (only Inventory mutates stock). Inventory registers this
 * hook on module init — platform never imports @jw/mod-inventory (that would make a package cycle: inventory → platform).
 * Rows are the validated stock rows; the hook writes tags + 'opening' ledger rows inside the caller's tx, all-or-nothing
 * (throws a Problem on any row failure). sourceId = the dry-run import_job id (the commit job row is created afterwards).
 */
export interface StockImportRow {
  tag_no: string; item_id: string; purity_id: string; gross_wt: string; stone_wt: string; net_wt: string; huid: string | null;
  hallmark_exempt: boolean; pieces: number; mc_type: string; mc_value: string; wastage_pct: string; huid_charge: string;
}
export type StockImporter = (rows: StockImportRow[], ctx: { auth: AuthContext; branchId: string; sourceId: string }) => Promise<void>;
let stockImporter: StockImporter | null = null;
export function registerStockImporter(fn: StockImporter): void { stockImporter = fn; }
export const stockImporterOf = (): StockImporter | null => stockImporter;

export interface FileInfo { id: string; area: string; createdBy: string | null }
/** Returns true when the caller may get a link to this attachment (area 'attachments'). */
export type FileAccessFn = (file: FileInfo, auth: AuthContext) => Promise<boolean>;
const fileAccess: FileAccessFn[] = [];
export function registerFileAccess(fn: FileAccessFn): void { if (!fileAccess.includes(fn)) fileAccess.push(fn); }
export async function canReadAttachment(file: FileInfo, auth: AuthContext): Promise<boolean> {
  for (const fn of fileAccess) if (await fn(file, auth)) return true;
  return false;
}

/** Export writer: header row + rows of strings (null → empty). csv is RFC 4180 with a UTF-8 BOM (Excel-friendly). */
export async function writeTable(format: 'csv' | 'xlsx', header: string[], rows: (string | null)[][]): Promise<{ buf: Buffer; contentType: string }> {
  if (format === 'csv') {
    const esc = (v: string | null) => { const s = v ?? ''; return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const text = [header, ...rows].map((r) => r.map(esc).join(',')).join('\r\n');
    return { buf: Buffer.from(`\uFEFF${text}\r\n`, 'utf8'), contentType: 'text/csv' };
  }
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('data');
  ws.addRow(header);
  for (const r of rows) ws.addRow(r.map((v) => v ?? ''));   // strings only: no formulas, no number coercion of codes
  return { buf: Buffer.from(await wb.xlsx.writeBuffer()), contentType: XLSX_TYPE };
}
