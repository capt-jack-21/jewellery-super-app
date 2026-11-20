import { D, parseDecimalInput } from '@/lib/format';
import type { BulkTagInputRowsItem } from './types';

/** Scanned / typed codes compare trimmed and upper-cased. */
export const normTag = (s: string) => s.trim().toUpperCase();

/** gross − stone, 3 dp; null when stone > gross or a value is bad. The server checks the same (422). */
export function netWeight(gross: string, stone: string): string | null {
  try {
    const g = D(gross || '0'); const s = D(stone || '0');
    if (g.isNegative() || s.isNegative() || s.gt(g)) return null;
    return g.minus(s).toFixed(3);
  } catch { return null; }
}

/** HUID: 6 letters/digits (BIS hallmark unique ID). */
export const HUID_RE = /^[A-Z0-9]{6}$/;
const WT_RE = /^\d{1,6}(\.\d{1,3})?$/;

export interface PieceDraft { item_id: string; purity_id: string; pcs: string; gross_wt: string; stone_wt: string; huid: string }
export const blankDraft = (item_id = '', purity_id = ''): PieceDraft => ({ item_id, purity_id, pcs: '1', gross_wt: '', stone_wt: '', huid: '' });

export type PieceDraftError = 'inventory.err.item' | 'inventory.err.purity' | 'inventory.err.pcs' | 'inventory.err.gross' | 'inventory.err.stone' | 'inventory.err.huidRequired' | 'inventory.err.huid';

/** Weight as typed ("12.5", "1,234.5") → '12.500', or null. 3 dp, > 0 unless allowZero. */
export function parseWeight(raw: string, allowZero = false): string | null {
  const v = parseDecimalInput(raw || '');
  if (v === null || !WT_RE.test(v)) return null;
  const n = netWeight(v, '0');
  if (n === null) return null;
  return !allowZero && /^0(\.0+)?$/.test(n) ? null : n;
}

export function draftError(d: PieceDraft, huidRequired: boolean): PieceDraftError | null {
  if (!d.item_id) return 'inventory.err.item';
  if (!d.purity_id) return 'inventory.err.purity';
  if (!/^\d{1,4}$/.test(d.pcs) || Number(d.pcs) < 1) return 'inventory.err.pcs';
  const g = parseWeight(d.gross_wt);
  if (!g) return 'inventory.err.gross';
  const s = d.stone_wt.trim() ? parseWeight(d.stone_wt, true) : '0.000';
  if (s === null || netWeight(g, s) === null) return 'inventory.err.stone';
  const h = d.huid.trim().toUpperCase();
  if (huidRequired && !h) return 'inventory.err.huidRequired';
  if (h && !HUID_RE.test(h)) return 'inventory.err.huid';
  return null;
}

/** Valid draft → one bulk row / the weight part of a TagInput (only call after draftError() === null). net = gross − stone. */
export function draftToRow(d: PieceDraft): BulkTagInputRowsItem {
  const g = parseWeight(d.gross_wt) ?? '0.000';
  const s = d.stone_wt.trim() ? parseWeight(d.stone_wt, true) ?? '0.000' : '0.000';
  return { gross_wt: g, stone_wt: s, net_wt: netWeight(g, s) ?? g, pieces: Number(d.pcs), huid: d.huid.trim().toUpperCase() || null };
}

/** Bulk 422 errors[].path "rows.3.gross_wt" → { 3: 'gross_wt' } so the grid can mark the row. */
export function rowErrors(errors: ReadonlyArray<{ path: string; message: string }>): Record<number, string> {
  const out: Record<number, string> = {};
  for (const e of errors) {
    const m = /^\/?rows[./](\d+)[./]?(.*)$/.exec(e.path);
    if (m) out[Number(m[1])] = e.message || m[2] || '';
  }
  return out;
}
