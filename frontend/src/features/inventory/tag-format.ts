/**
 * Tag number format (pure logic, no React) — contract 0.8.0 §5: a STRUCTURED object stored in GET/PATCH
 * /v1/inventory/settings (`tag_format`). The server assigns every tag_no; the client only edits, checks and previews the
 * format. The authoritative preview is POST /settings/tag-format/preview; `renderTag` is the instant local preview.
 *
 * Rendering (contract): prefix, then [separator + segment] per enabled segment, then separator, then the zero-padded
 * number. The contract's own examples ("T000123", "CBE-RNG-000123") show no leading separator when the prefix is empty,
 * so we join the non-empty parts with the separator (open point G3 in INVENTORY_API_ASSUMPTIONS.md).
 */
import type { TagFormat } from '@/lib/api/backend/model';

export type { TagFormat };
export const PREFIX_RE = /^[A-Z0-9]{0,8}$/;
export const DIGITS_MIN = 1;
export const DIGITS_MAX = 12;
/** tag_no is varchar(30) (server 422 invalid_tag_format / preview too_long). */
export const TAG_MAX_LEN = 30;
/** Longer numbers still work but make small labels hard to scan. */
export const TAG_SHORT_LEN = 16;
export const SEPARATORS = ['', '-', '/'] as const;

/** Contract defaults (shop never saved settings). */
export const DEFAULT_TAG_FORMAT: TagFormat = {
  prefix: 'T', separator: '', branch_segment: false, item_segment: false, segment_order: 'branch_item', start_no: 1, digits: 6,
};

export type TagFormatError =
  | 'inventory.tagFormat.err.prefix' | 'inventory.tagFormat.err.digits' | 'inventory.tagFormat.err.startNo'
  | 'inventory.tagFormat.err.tooLong';

export interface TagSample { branch: string; item: string; no: number }
export const SAMPLE: TagSample = { branch: 'MAIN', item: 'RNG', no: 42 };

/** Branch / item codes as the server uses them: upper-case A–Z 0–9 only. */
export const cleanCode = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** The enabled segments, in the chosen order. */
export function segments(f: TagFormat, x: Pick<TagSample, 'branch' | 'item'>): string[] {
  const b = f.branch_segment ? [cleanCode(x.branch)] : [];
  const i = f.item_segment ? [cleanCode(x.item)] : [];
  return f.segment_order === 'item_branch' ? [...i, ...b] : [...b, ...i];
}

/** The non-number part (= the server's counter scope_key): numbering restarts at start_no for each distinct value. */
export function scopeKey(f: TagFormat, x: Pick<TagSample, 'branch' | 'item'> = SAMPLE): string {
  const parts = [f.prefix, ...segments(f, x)].filter(Boolean);
  return parts.length ? parts.join(f.separator) + f.separator : '';
}

export const renderTag = (f: TagFormat, x: TagSample = SAMPLE): string => scopeKey(f, x) + String(x.no).padStart(f.digits, '0');

/** Longest tag the format can produce, given the longest branch / item codes in use. */
export function maxLength(f: TagFormat, longest: { branch: number; item: number } = { branch: 10, item: 10 }): number {
  const parts = [f.prefix.length, f.branch_segment ? longest.branch : 0, f.item_segment ? longest.item : 0].filter((n) => n > 0);
  const numLen = Math.max(f.digits, String(f.start_no).length);
  return parts.reduce((a, n) => a + n, 0) + parts.length * f.separator.length + numLen;
}

/** All problems, most important first. Empty list = valid. Mirrors the server's preview error codes. */
export function validateTagFormat(f: TagFormat, longest?: { branch: number; item: number }): TagFormatError[] {
  const errs: TagFormatError[] = [];
  if (!PREFIX_RE.test(f.prefix)) errs.push('inventory.tagFormat.err.prefix');
  const digitsOk = Number.isInteger(f.digits) && f.digits >= DIGITS_MIN && f.digits <= DIGITS_MAX;
  if (!digitsOk) errs.push('inventory.tagFormat.err.digits');
  if (!Number.isInteger(f.start_no) || f.start_no < 1 || (digitsOk && f.start_no >= 10 ** f.digits)) errs.push('inventory.tagFormat.err.startNo');
  if (maxLength(f, longest) > TAG_MAX_LEN) errs.push('inventory.tagFormat.err.tooLong');
  return errs;
}

/** Does saving `next` start new counters (a new scope_key) compared with `prev`? Old tags are never renumbered. */
export const startsNewNumbering = (prev: TagFormat, next: TagFormat): boolean =>
  prev.prefix !== next.prefix || prev.separator !== next.separator || prev.branch_segment !== next.branch_segment
  || prev.item_segment !== next.item_segment || (prev.branch_segment && prev.item_segment && prev.segment_order !== next.segment_order);

/** Fields that differ (the PATCH body sends only these). */
export function formatPatch(prev: TagFormat, next: TagFormat): Partial<TagFormat> {
  const out: Partial<TagFormat> = {};
  for (const k of Object.keys(next) as Array<keyof TagFormat>) if (prev[k] !== next[k]) (out as Record<string, unknown>)[k] = next[k];
  return out;
}
