/**
 * Document-number formats (contract 0.8.2, settings transfer_no_format / adjustment_no_format). Pure, mirrors the
 * server's 422 validation_failed so the settings form can explain the problem before saving:
 *  - characters A-Z a-z 0-9 - / _ plus the tokens {BRANCH}, {FY}, {SEQ} or {SEQ:n} (n = 1-99 zero-pad width);
 *  - exactly one {SEQ} / {SEQ:n}, and it must be the LAST token;
 *  - 1-64 characters as typed, and ≤ 64 once rendered with a 10-character branch code.
 */
export const DEFAULT_TRANSFER_NO_FORMAT = 'TRF-{BRANCH}-{FY}-{SEQ:5}';
export const DEFAULT_ADJUSTMENT_NO_FORMAT = 'ADJ-{BRANCH}-{FY}-{SEQ:5}';
export const DOC_NO_MAX = 64;

export type DocNoFormatError =
  | 'inventory.docNo.err.empty' | 'inventory.docNo.err.chars' | 'inventory.docNo.err.token' | 'inventory.docNo.err.seqMissing'
  | 'inventory.docNo.err.seqTwice' | 'inventory.docNo.err.seqNotLast' | 'inventory.docNo.err.seqWidth' | 'inventory.docNo.err.tooLong';

const CHARS_RE = /^[A-Za-z0-9{}:/_-]+$/;
const TOKEN_RE = /\{([^{}]*)\}/g;
const SEQ_RE = /^SEQ(?::(\d{1,2}))?$/;

type Part = { kind: 'text'; text: string } | { kind: 'branch' } | { kind: 'fy' } | { kind: 'seq'; width: number };

function parse(fmt: string): { parts: Part[] } | { error: DocNoFormatError } {
  const parts: Part[] = [];
  let at = 0;
  for (const m of fmt.matchAll(TOKEN_RE)) {
    const idx = m.index ?? 0;
    if (idx > at) parts.push({ kind: 'text', text: fmt.slice(at, idx) });
    const name = m[1] ?? '';
    const seq = SEQ_RE.exec(name);
    if (name === 'BRANCH') parts.push({ kind: 'branch' });
    else if (name === 'FY') parts.push({ kind: 'fy' });
    else if (seq) {
      const width = seq[1] ? Number(seq[1]) : 1;
      if (width < 1 || width > 99) return { error: 'inventory.docNo.err.seqWidth' };
      parts.push({ kind: 'seq', width });
    } else return { error: 'inventory.docNo.err.token' };
    at = idx + m[0].length;
  }
  if (at < fmt.length) parts.push({ kind: 'text', text: fmt.slice(at) });
  // A stray brace outside a {TOKEN} (e.g. "TRF-{BRANCH" or "A}B").
  if (parts.some((p) => p.kind === 'text' && /[{}]/.test(p.text))) return { error: 'inventory.docNo.err.token' };
  return { parts };
}

/** null when the server would accept the format. */
export function docNoFormatError(raw: string): DocNoFormatError | null {
  const fmt = raw.trim();
  if (!fmt) return 'inventory.docNo.err.empty';
  if (!CHARS_RE.test(fmt)) return 'inventory.docNo.err.chars';
  const r = parse(fmt);
  if ('error' in r) return r.error;
  const seqs = r.parts.filter((p) => p.kind === 'seq').length;
  if (seqs === 0) return 'inventory.docNo.err.seqMissing';
  if (seqs > 1) return 'inventory.docNo.err.seqTwice';
  if (r.parts[r.parts.length - 1]?.kind !== 'seq') return 'inventory.docNo.err.seqNotLast';
  if (fmt.length > DOC_NO_MAX || renderDocNo(fmt, { branch: 'X'.repeat(10), fy: '2627', seq: 1 }).length > DOC_NO_MAX) return 'inventory.docNo.err.tooLong';
  return null;
}

/** Sample number for the preview, e.g. ('TRF-{BRANCH}-{FY}-{SEQ:5}', {branch:'CBE', fy:'2627', seq:1}) → TRF-CBE-2627-00001. */
export function renderDocNo(fmt: string, v: { branch: string; fy: string; seq: number }): string {
  const r = parse(fmt.trim());
  if ('error' in r) return '';
  return r.parts.map((p) => (p.kind === 'text' ? p.text : p.kind === 'branch' ? v.branch : p.kind === 'fy' ? v.fy : String(v.seq).padStart(p.width, '0'))).join('');
}

/** Indian financial year code for a date: Apr 2026–Mar 2027 → "2627". */
export function fyCode(d: Date): string {
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `${String(y % 100).padStart(2, '0')}${String((y + 1) % 100).padStart(2, '0')}`;
}
