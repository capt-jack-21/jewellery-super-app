/** Pure rendering of tag numbers (987 shop_setting.tag_*) and TRF / ADJ document numbers (lead decision 4). */
export interface TagFormat {
  prefix: string; separator: '' | '-' | '/'; branch_segment: boolean; item_segment: boolean;
  segment_order: 'branch_item' | 'item_branch'; start_no: number; digits: number;
}
export const DEFAULT_TAG_FORMAT: TagFormat = {
  prefix: 'T', separator: '', branch_segment: false, item_segment: false, segment_order: 'branch_item', start_no: 1, digits: 6,
};
export const TAG_NO_MAX = 30;
const clean = (s: string | null | undefined): string => (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** The non-number part of a tag number; also the tag_counter.scope_key (numbering runs per rendered scope). */
export function tagScopeKey(f: TagFormat, ctx: { branchCode?: string | null; itemCode?: string | null }): string {
  const b = f.branch_segment ? clean(ctx.branchCode) : '';
  const i = f.item_segment ? clean(ctx.itemCode) : '';
  const segs = f.segment_order === 'branch_item' ? [b, i] : [i, b];
  const parts = [clean(f.prefix), ...segs].filter(Boolean);
  return parts.length ? parts.join(f.separator) + f.separator : '';
}
export function renderTagNo(f: TagFormat, ctx: { branchCode?: string | null; itemCode?: string | null }, n: number | bigint): string {
  return tagScopeKey(f, ctx) + String(n).padStart(f.digits, '0');
}
/** Format errors (empty = valid). */
export function validateTagFormat(f: TagFormat): { path: string; message: string }[] {
  const e: { path: string; message: string }[] = [];
  if (!/^[A-Z0-9]{0,8}$/.test(f.prefix)) e.push({ path: 'tag_format.prefix', message: 'A-Z 0-9, at most 8' });
  if (!['', '-', '/'].includes(f.separator)) e.push({ path: 'tag_format.separator', message: "'', '-' or '/'" });
  if (!Number.isInteger(f.digits) || f.digits < 1 || f.digits > 12) e.push({ path: 'tag_format.digits', message: '1-12' });
  if (!Number.isInteger(f.start_no) || f.start_no < 1 || f.start_no >= 10 ** f.digits)
    e.push({ path: 'tag_format.start_no', message: 'must be ≥ 1 and < 10^digits' });
  return e;
}

/** Indian financial year (April-March) of an IST date, as 4 digits: 2026-11-05 → "2627", 2027-03-31 → "2627", 2027-04-01 → "2728". */
export function indianFY(isoDate: string): string {
  const [y, m] = isoDate.split('-').map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${String(start % 100).padStart(2, '0')}${String((start + 1) % 100).padStart(2, '0')}`;
}
export const todayIST = (d = new Date()): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);

export const TRANSFER_NO_FORMAT = 'TRF-{BRANCH}-{FY}-{SEQ:5}';
export const ADJUSTMENT_NO_FORMAT = 'ADJ-{BRANCH}-{FY}-{SEQ:5}';
/**
 * shop_setting.transfer_no_format / adjustment_no_format (987 CHECK: 1-64 chars and a {SEQ} or {SEQ:n} token, n 1-99).
 * The API also refuses unknown tokens, a second {SEQ}, text after {SEQ} (the counter prefix is everything before it) and a
 * rendered number over 64 chars. undefined = not being changed.
 */
export function validateDocNoFormat(path: string, fmt: string | undefined): { path: string; message: string }[] {
  if (fmt === undefined) return [];
  const e = (message: string) => [{ path, message }];
  if (typeof fmt !== 'string' || fmt.length < 1 || fmt.length > 64) return e('1-64 characters');
  const seq = fmt.match(/\{SEQ(?::([1-9][0-9]?))?\}/g) ?? [];
  if (seq.length !== 1) return e('must contain exactly one {SEQ} or {SEQ:n} (n 1-99)');
  const unknown = fmt.replace(/\{SEQ(?::[1-9][0-9]?)?\}|\{BRANCH\}|\{FY\}/g, '').match(/[{}]/);
  if (unknown) return e('only {BRANCH}, {FY} and {SEQ:n} tokens are allowed');
  if (!/\{SEQ(?::[1-9][0-9]?)?\}$/.test(fmt)) return e('{SEQ} must be the last token');
  if (!/^[A-Za-z0-9{}:\/_-]+$/.test(fmt)) return e('letters, digits, - / _ and tokens only');
  if (renderDocNo(fmt, { branchCode: 'XXXXXXXXXX', fy: '9999' }, 0).length > 64) return e('rendered number is longer than 64 characters');
  return [];
}
/** Renders {BRANCH}, {FY} and {SEQ:n}. prefixOf() = everything before {SEQ…}, stored in platform.doc_counter.prefix. */
export function renderDocNo(fmt: string, ctx: { branchCode: string; fy: string }, seq: number | bigint): string {
  return fmt.replace(/\{BRANCH\}/g, clean(ctx.branchCode)).replace(/\{FY\}/g, ctx.fy)
    .replace(/\{SEQ(?::(\d{1,2}))?\}/g, (_m, w: string | undefined) => String(seq).padStart(w ? Number(w) : 1, '0'));
}
export const docPrefixOf = (fmt: string, ctx: { branchCode: string; fy: string }): string =>
  renderDocNo(fmt.split('{SEQ')[0], ctx, 0);
