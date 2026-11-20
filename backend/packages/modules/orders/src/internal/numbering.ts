/** Document numbers: {BRANCH}, {FY} and {SEQ:n} tokens; prefixOf() = everything before {SEQ…}, stored in platform.doc_counter.prefix. */
const clean = (s: string | null | undefined): string => (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const ORDER_NO_FORMAT = 'ORD-{BRANCH}-{FY}-{SEQ:5}';
export const REPAIR_NO_FORMAT = 'REP-{BRANCH}-{FY}-{SEQ:5}';
/** Indian financial year (April-March) of an IST date as 4 digits: 2026-11-05 → "2627", 2027-04-01 → "2728". */
export function indianFY(isoDate: string): string {
  const [y, m] = isoDate.split('-').map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${String(start % 100).padStart(2, '0')}${String((start + 1) % 100).padStart(2, '0')}`;
}
export const todayIST = (d = new Date()): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
export function renderDocNo(fmt: string, ctx: { branchCode: string; fy: string }, seq: number | bigint): string {
  return fmt.replace(/\{BRANCH\}/g, clean(ctx.branchCode)).replace(/\{FY\}/g, ctx.fy)
    .replace(/\{SEQ(?::(\d{1,2}))?\}/g, (_m, w: string | undefined) => String(seq).padStart(w ? Number(w) : 1, '0'));
}
export const docPrefixOf = (fmt: string, ctx: { branchCode: string; fy: string }): string => renderDocNo(fmt.split('{SEQ')[0], ctx, 0);
/** Shop-setting format check: exactly one {SEQ}/{SEQ:n} as the last token, only {BRANCH} {FY} {SEQ:n}, letters digits - / _, rendered length <= 64. */
export function validateDocNoFormat(path: string, fmt: string | undefined): { path: string; message: string }[] {
  if (fmt === undefined) return [];
  const e = (message: string) => [{ path, message }];
  if (typeof fmt !== 'string' || fmt.length < 1 || fmt.length > 64) return e('1-64 characters');
  const seq = fmt.match(/\{SEQ(?::([1-9][0-9]?))?\}/g) ?? [];
  if (seq.length !== 1) return e('must contain exactly one {SEQ} or {SEQ:n} (n 1-99)');
  if (fmt.replace(/\{SEQ(?::[1-9][0-9]?)?\}|\{BRANCH\}|\{FY\}/g, '').match(/[{}]/)) return e('only {BRANCH}, {FY} and {SEQ:n} tokens are allowed');
  if (!/\{SEQ(?::[1-9][0-9]?)?\}$/.test(fmt)) return e('{SEQ} must be the last token');
  if (!/^[A-Za-z0-9{}:\/_-]+$/.test(fmt)) return e('letters, digits, - / _ and tokens only');
  if (renderDocNo(fmt, { branchCode: 'XXXXXXXXXX', fy: '9999' }, 0).length > 64) return e('rendered number is longer than 64 characters');
  return [];
}
