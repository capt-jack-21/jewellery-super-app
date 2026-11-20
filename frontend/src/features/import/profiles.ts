import type { ImportKind } from '@/lib/api/backend/model';
import type { ImportMappingProfile } from '@/lib/api/backend/model';

/** A saved server profile (`/v1/import-mapping-profiles`) or the built-in client-side 'generic' one. */
export type MappingProfile = Pick<ImportMappingProfile, 'kind' | 'name' | 'mapping' | 'options'> & { id: string; version?: number; builtin: boolean };
export const fromServer = (p: ImportMappingProfile): MappingProfile => ({ id: p.id, version: p.version, kind: p.kind, name: p.name, mapping: p.mapping, options: p.options, builtin: false });

/**
 * Pluggable import mapping profiles (plan §9.1). A profile maps our template keys to a source file's headers.
 * There is NO vendor-specific importer: other apps' exports are handled by adding a profile (built-in from the
 * shop's saved ones), never by code, never by code. Built-in 'generic' profiles match our own template headers.
 */
export type Row = Record<string, string>;

export function genericProfile(kind: ImportKind, keys: string[]): MappingProfile {
  return { id: `generic-${kind}`, name: 'Generic', kind, builtin: true, mapping: Object.fromEntries(keys.map((k) => [k, k])) };
}

const norm = (s: string) => s.trim().toLowerCase().replace(/[\s_-]+/g, ' ');

/** Apply a profile: rename source headers → template keys (case/space-insensitive). Unmapped source columns are dropped. */
export function applyProfile(rows: Row[], profile: Pick<MappingProfile, 'mapping'>): Row[] {
  const entries = Object.entries(profile.mapping) as Array<[string, string]>;
  return rows.map((r) => {
    const byNorm = new Map(Object.entries(r).map(([k, v]) => [norm(k), v]));
    return Object.fromEntries(entries.map(([target, source]) => [target, (byNorm.get(norm(source)) ?? '').trim()]));
  });
}

/** Which required template keys the profile cannot find in the file's headers. */
export function missingColumns(headers: string[], profile: Pick<MappingProfile, 'mapping'>, required: string[]): string[] {
  const have = new Set(headers.map(norm));
  return required.filter((k) => !profile.mapping[k] || !have.has(norm(profile.mapping[k] ?? '')));
}

/** Pick the profile whose source headers best match the file. */
export function detectProfile<P extends Pick<MappingProfile, 'mapping'>>(headers: string[], profiles: P[]): P | undefined {
  const have = new Set(headers.map(norm));
  let best: { p: P; score: number } | undefined;
  for (const p of profiles) {
    const src = Object.values(p.mapping) as string[];
    const score = src.filter((s) => have.has(norm(s))).length / Math.max(src.length, 1);
    if (!best || score > best.score) best = { p, score };
  }
  return best && best.score > 0 ? best.p : undefined;
}

/** RFC 4180-ish CSV parser (quotes, escaped quotes, CRLF, BOM). Returns header-keyed rows. */
export function parseCsv(text: string): { headers: string[]; rows: Row[] } {
  const src = text.replace(/^\uFEFF/, '');
  const cells: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"' && src[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cur); cells.push(row); row = []; cur = '';
    } else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); cells.push(row); }
  const nonEmpty = cells.filter((r) => r.some((x) => x.trim() !== ''));
  const headers = (nonEmpty.shift() ?? []).map((h) => h.trim());
  return { headers, rows: nonEmpty.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? '']))) };
}

/** Excel (.xlsx) → same shape, parsed client-side; lazy-loaded so it is not in the main bundle. */
export async function parseXlsx(file: File): Promise<{ headers: string[]; rows: Row[] }> {
  const { readSheet } = await import('read-excel-file/browser');
  const [head = [], ...body] = await readSheet(file);
  const headers = head.map((h) => String(h ?? '').trim());
  return { headers, rows: body.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] == null ? '' : String(r[i] as unknown)]))) };
}

const esc = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
/** Header row only (template) or header + rows (mapped upload). */
export function toCsv(headers: string[], rows: Row[] = []): string {
  return [headers, ...rows.map((r) => headers.map((h) => r[h] ?? ''))].map((l) => l.map(esc).join(',')).join('\r\n') + '\r\n';
}
