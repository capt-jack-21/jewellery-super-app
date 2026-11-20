import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TAG_FORMAT, formatPatch, maxLength, renderTag, scopeKey, startsNewNumbering, validateTagFormat, type TagFormat,
} from './tag-format';
import { bucketRange, parseEdges, validEdges } from './ageing';
import { adjustmentError, canApprove, fullWriteOffDeltas, MIN_TEXT, optionalTextOk, signedWeight, textOk } from './adjustments';
import { DEFAULT_ADJUSTMENT_NO_FORMAT, DEFAULT_TRANSFER_NO_FORMAT, docNoFormatError, fyCode, renderDocNo } from './doc-no-format';
import { extraReasonKey, refLabel } from './scan-check';
import {
  blankLotLine, canRemoveLotLine, lineRemaining, lotIsOpen, lotLineError, lotProgress, removedLotLines, removedTransferLines, toLotLines, transferPatchLines, vendorLotRef,
} from './lots';
import { blankDraft, draftError, draftToRow, netWeight, normTag, parseWeight, rowErrors } from './piece-rules';
import { CODE128_PATTERNS, code128Bars, code128Values, code128Widths } from './barcode';
import { qrMatrix, qrPath, utf8Binary } from './qr';
import { toAdjustmentInput } from './adjustments-page';
import { newPasswordError } from '@/features/auth/password-rules';

const f = (x: Partial<TagFormat>): TagFormat => ({ ...DEFAULT_TAG_FORMAT, ...x });

describe('tag number format (0.8.0 structured, server assigns)', () => {
  it('renders the contract examples', () => {
    expect(renderTag(DEFAULT_TAG_FORMAT, { branch: 'X', item: 'Y', no: 123 })).toBe('T000123');
    const cbe = f({ prefix: '', separator: '-', branch_segment: true, item_segment: true });
    expect(renderTag(cbe, { branch: 'CBE', item: 'RNG', no: 123 })).toBe('CBE-RNG-000123');
    expect(renderTag({ ...cbe, segment_order: 'item_branch' }, { branch: 'CBE', item: 'RNG', no: 123 })).toBe('RNG-CBE-000123');
    expect(renderTag(f({ prefix: 'TG', separator: '/', item_segment: true, digits: 4 }), { branch: 'MAIN', item: 'r-1', no: 7 })).toBe('TG/R1/0007');
  });
  it('scope key is the non-number part (numbering restarts per value)', () => {
    expect(scopeKey(DEFAULT_TAG_FORMAT)).toBe('T');
    expect(scopeKey(f({ prefix: '', separator: '' }))).toBe('');
    expect(scopeKey(f({ separator: '-', branch_segment: true }), { branch: 'CBE', item: 'RNG' })).toBe('T-CBE-');
  });
  it('validates prefix, digits, start number and length', () => {
    expect(validateTagFormat(DEFAULT_TAG_FORMAT)).toEqual([]);
    expect(validateTagFormat(f({ prefix: 't-1' }))).toContain('inventory.tagFormat.err.prefix');
    expect(validateTagFormat(f({ prefix: 'ABCDEFGHI' }))).toContain('inventory.tagFormat.err.prefix');
    expect(validateTagFormat(f({ digits: 0 }))).toContain('inventory.tagFormat.err.digits');
    expect(validateTagFormat(f({ digits: 13 }))).toContain('inventory.tagFormat.err.digits');
    expect(validateTagFormat(f({ start_no: 0 }))).toContain('inventory.tagFormat.err.startNo');
    expect(validateTagFormat(f({ digits: 3, start_no: 1000 }))).toContain('inventory.tagFormat.err.startNo');
    const long = f({ prefix: 'ABCDEFGH', separator: '-', branch_segment: true, item_segment: true, digits: 12 });
    expect(maxLength(long)).toBe(8 + 10 + 10 + 3 + 12);
    expect(validateTagFormat(long)).toContain('inventory.tagFormat.err.tooLong');
    expect(validateTagFormat(long, { branch: 2, item: 2 })).toEqual([]);
  });
  it('knows when a change starts new numbering and patches only changed fields', () => {
    expect(startsNewNumbering(DEFAULT_TAG_FORMAT, f({ digits: 8 }))).toBe(false);
    expect(startsNewNumbering(DEFAULT_TAG_FORMAT, f({ prefix: 'TG' }))).toBe(true);
    expect(startsNewNumbering(DEFAULT_TAG_FORMAT, f({ segment_order: 'item_branch' }))).toBe(false);
    const both = f({ branch_segment: true, item_segment: true });
    expect(startsNewNumbering(both, { ...both, segment_order: 'item_branch' })).toBe(true);
    expect(formatPatch(DEFAULT_TAG_FORMAT, f({ digits: 8, prefix: 'X' }))).toEqual({ digits: 8, prefix: 'X' });
    expect(formatPatch(DEFAULT_TAG_FORMAT, DEFAULT_TAG_FORMAT)).toEqual({});
  });
});

describe('ageing settings (server buckets)', () => {
  it('validates and parses edges', () => {
    expect(validEdges([30, 90])).toBe(true);
    expect(validEdges([90, 30])).toBe(false);
    expect(validEdges([])).toBe(false);
    expect(validEdges([1, 2, 3, 4, 5, 6, 7, 8, 9])).toBe(false);
    expect(validEdges([3651])).toBe(false);
    expect(parseEdges('30, 90 180')).toEqual([30, 90, 180]);
    expect(parseEdges('30, x')).toBeNull();
    expect(parseEdges('0, 5')).toBeNull();
  });
  it('labels a server bucket', () => {
    expect(bucketRange({ from_days: 30, to_days: 89 })).toEqual({ from: 30, to: 89 });
    expect(bucketRange({ from_days: 365, to_days: null })).toEqual({ from: 365, to: null });
  });
});

describe('adjustments (0.8.2)', () => {
  it('signs a typed weight per kind', () => {
    expect(signedWeight('0.25', 'neg')).toBe('-0.250');
    expect(signedWeight('1.2', 'pos')).toBe('1.200');
    expect(signedWeight('-0.5', 'signed')).toBe('-0.500');
    expect(signedWeight('-0.5', 'neg')).toBeNull();
    expect(signedWeight('0', 'signed')).toBeNull();
    expect(signedWeight('abc', 'pos')).toBeNull();
  });
  it('checks reason, weight and pieces per kind', () => {
    expect(adjustmentError('weight_loss', 'ab', '0.1', '', true)).toBe('inventory.adj.err.reason');
    expect(adjustmentError('weight_loss', 'polish', '', '', true)).toBe('inventory.adj.err.weight');
    expect(adjustmentError('weight_loss', 'polish', '0.120', '', true)).toBeNull();
    expect(adjustmentError('piece_gain', 'found', '1', '', false)).toBe('inventory.adj.err.pieces');
    expect(adjustmentError('piece_gain', 'found', '1', '2', false)).toBeNull();
    expect(adjustmentError('piece_loss', 'gone', '1', '', true)).toBeNull();
    // 0.8.2: write_off is partial (needs a weight, tag or loose); full_write_off needs a tag and no typed deltas.
    expect(adjustmentError('write_off', 'stolen', '', '', true)).toBe('inventory.adj.err.weight');
    expect(adjustmentError('write_off', 'stolen', '0.5', '', true)).toBeNull();
    expect(adjustmentError('write_off', 'stolen', '', '', false)).toBe('inventory.adj.err.weight');
    expect(adjustmentError('full_write_off', 'stolen', '', '', true)).toBeNull();
    expect(adjustmentError('full_write_off', 'stolen', '', '', false)).toBe('inventory.adj.err.fullNeedsTag');
    // Every reason / note minimum is 3 (trimmed).
    expect(adjustmentError('weight_loss', ' ab ', '0.1', '', true)).toBe('inventory.adj.err.reason');
    expect(adjustmentError('weight_loss', 'abc', '0.1', '', true)).toBeNull();
  });
  it('3-character minimum for every reason / note; optional notes are empty or ≥ 3', () => {
    expect(MIN_TEXT).toBe(3);
    expect(textOk('  ab ')).toBe(false);
    expect(textOk(' abc ')).toBe(true);
    expect(textOk(null)).toBe(false);
    expect(optionalTextOk('')).toBe(true);
    expect(optionalTextOk('   ')).toBe(true);
    expect(optionalTextOk('ok')).toBe(false);
    expect(optionalTextOk('fine')).toBe(true);
  });
  it('full_write_off deltas are minus the whole piece', () => {
    expect(fullWriteOffDeltas({ pieces: 2, gross_wt: '12.340', net_wt: '11.5' })).toEqual({ pieces_delta: -2, gross_wt_delta: '-12.340', net_wt_delta: '-11.500' });
    expect(toAdjustmentInput({ kind: 'full_write_off', reasonCode: 'loss', reason: ' lost ', wt: '9', pieces: '', tag: { id: 't1', branch_id: 'b1', pieces: 1, gross_wt: '5.000', net_wt: '4.800' } }))
      .toEqual({ branch_id: 'b1', tag_id: 't1', kind: 'full_write_off', reason_code: 'loss', reason: 'lost', delta_pieces: -1, delta_gross_wt: '-5.000', delta_net_wt: '-4.800' });
  });
  it('builds the request body', () => {
    expect(toAdjustmentInput({ kind: 'weight_loss', reasonCode: 'polishing', reason: ' polish ', wt: '0.1', pieces: '', tag: { id: 't1', branch_id: 'b1' } }))
      .toEqual({ branch_id: 'b1', tag_id: 't1', kind: 'weight_loss', reason_code: 'polishing', reason: 'polish', delta_gross_wt: '-0.100', delta_net_wt: '-0.100' });
    expect(toAdjustmentInput({ kind: 'piece_loss', reasonCode: 'polishing', reason: 'gone', wt: '2', pieces: '3', loose: { branch_id: 'b', item_id: 'i', purity_id: 'p', counter_id: '' } }))
      .toEqual({ branch_id: 'b', item_id: 'i', purity_id: 'p', counter_id: null, kind: 'piece_loss', reason_code: 'polishing', reason: 'gone', delta_gross_wt: '-2.000', delta_net_wt: '-2.000', delta_pieces: -3 });
  });
  it('owner always (self-approval recorded); manager only under owner_or_manager and never own; only pending', () => {
    const req = { requested_by: 'u1', status: 'pending' };
    const owner = { id: 'o', roles: ['owner'] };
    const mgr = { id: 'm', roles: ['manager'] };
    expect(canApprove(owner, req, 'owner_only')).toBe(true);
    expect(canApprove({ id: 'u1', roles: ['owner'] }, req, 'owner_only')).toBe(true);
    expect(canApprove(mgr, req, 'owner_only')).toBe(false);
    expect(canApprove(mgr, req, 'owner_or_manager')).toBe(true);
    expect(canApprove(mgr, { ...req, requested_by: 'm' }, 'owner_or_manager')).toBe(false);
    expect(canApprove(owner, { ...req, status: 'approved' }, 'owner_only')).toBe(false);
  });
});

describe('document number formats (0.8.2 settings)', () => {
  it('accepts the defaults and renders them', () => {
    expect(docNoFormatError(DEFAULT_TRANSFER_NO_FORMAT)).toBeNull();
    expect(docNoFormatError(DEFAULT_ADJUSTMENT_NO_FORMAT)).toBeNull();
    expect(docNoFormatError('{SEQ:5}')).toBeNull();
    expect(docNoFormatError('T/{FY}/{SEQ}')).toBeNull();
    expect(renderDocNo(DEFAULT_TRANSFER_NO_FORMAT, { branch: 'CBE', fy: '2627', seq: 1 })).toBe('TRF-CBE-2627-00001');
    expect(renderDocNo('{SEQ:5}', { branch: 'CBE', fy: '2627', seq: 12 })).toBe('00012');
  });
  it('needs exactly one {SEQ} / {SEQ:n}, last, known tokens, allowed characters, ≤ 64', () => {
    expect(docNoFormatError('')).toBe('inventory.docNo.err.empty');
    expect(docNoFormatError('TRF {SEQ}')).toBe('inventory.docNo.err.chars');
    expect(docNoFormatError('TRF-{BRANCH}')).toBe('inventory.docNo.err.seqMissing');
    expect(docNoFormatError('{SEQ}-{SEQ:3}')).toBe('inventory.docNo.err.seqTwice');
    expect(docNoFormatError('{SEQ:5}-{FY}')).toBe('inventory.docNo.err.seqNotLast');
    expect(docNoFormatError('{SEQ:5}-X')).toBe('inventory.docNo.err.seqNotLast');
    expect(docNoFormatError('{YEAR}-{SEQ}')).toBe('inventory.docNo.err.token');
    expect(docNoFormatError('TRF-{BRANCH-{SEQ}')).toBe('inventory.docNo.err.token');
    expect(docNoFormatError('{SEQ:0}')).toBe('inventory.docNo.err.seqWidth');
    expect(docNoFormatError(`${'A'.repeat(55)}-{BRANCH}-{SEQ}`)).toBe('inventory.docNo.err.tooLong');
  });
  it('Indian financial year code', () => {
    expect(fyCode(new Date(2026, 10, 5))).toBe('2627');
    expect(fyCode(new Date(2027, 2, 31))).toBe('2627');
    expect(fyCode(new Date(2027, 3, 1))).toBe('2728');
  });
});

describe('stock-check extra scans (0.8.2 extra_reason enum)', () => {
  it('wrong_status shows the status from extra_note; other codes map to reasons', () => {
    expect(extraReasonKey('wrong_status', 'sold')).toEqual({ kind: 'status', status: 'sold' });
    expect(extraReasonKey('wrong_status', null)).toEqual({ kind: 'reason', reason: 'wrong_status' });
    expect(extraReasonKey('other_branch', null)).toEqual({ kind: 'reason', reason: 'other_branch' });
    expect(extraReasonKey('status_sold')).toEqual({ kind: 'status', status: 'sold' });
    expect(extraReasonKey(null)).toBeNull();
  });
});

describe('piece rules (tagging)', () => {
  const ok = { ...blankDraft('i', 'p'), gross_wt: '12.5', stone_wt: '0.5' };
  it('parses weights to 3 dp; net = gross − stone, never negative', () => {
    expect(parseWeight('12.5')).toBe('12.500');
    expect(parseWeight('0')).toBeNull();
    expect(parseWeight('0', true)).toBe('0.000');
    expect(parseWeight('1.2345')).toBeNull();
    expect(parseWeight('-1')).toBeNull();
    expect(netWeight('12.5', '0.25')).toBe('12.250');
    expect(netWeight('1', '1.001')).toBeNull();
    expect(netWeight('abc', '0')).toBeNull();
    expect(normTag(' ab ')).toBe('AB');
  });
  it('validates a draft row and maps it to a bulk row', () => {
    expect(draftError(ok, false)).toBeNull();
    expect(draftError({ ...ok, item_id: '' }, false)).toBe('inventory.err.item');
    expect(draftError({ ...ok, pcs: '0' }, false)).toBe('inventory.err.pcs');
    expect(draftError({ ...ok, stone_wt: '13' }, false)).toBe('inventory.err.stone');
    expect(draftError(ok, true)).toBe('inventory.err.huidRequired');
    expect(draftError({ ...ok, huid: 'ab12' }, false)).toBe('inventory.err.huid');
    expect(draftError({ ...ok, huid: 'ab12cd' }, true)).toBeNull();
    expect(draftToRow({ ...ok, huid: 'ab12cd' })).toEqual({ gross_wt: '12.500', stone_wt: '0.500', net_wt: '12.000', pieces: 1, huid: 'AB12CD' });
    expect(draftToRow(ok).huid).toBeNull();
  });
  it('maps bulk 422 paths to rows', () => {
    expect(rowErrors([{ path: 'rows.3.gross_wt', message: 'bad' }, { path: '/rows/0/huid', message: '' }, { path: 'lot_no', message: 'x' }])).toEqual({ 3: 'bad', 0: 'huid' });
  });
});

describe('Code128-B barcode (client draws it, contract §labels)', () => {
  it('has the 107 standard patterns (11 modules, 13 for stop)', () => {
    expect(CODE128_PATTERNS).toHaveLength(107);
    CODE128_PATTERNS.forEach((p, i) => expect([...p].reduce((a, c) => a + Number(c), 0)).toBe(i === 106 ? 13 : 11));
  });
  it('start B, data, mod-103 checksum, stop', () => {
    expect(code128Values('PJJ123C')).toEqual([104, 48, 42, 42, 17, 18, 19, 35, 55, 106]);
    expect(code128Values('')).toBeNull();
    expect(code128Values('é')).toBeNull();
    const w = code128Widths('T000123');
    expect(w?.reduce((a, b) => a + b, 0)).toBe(11 * (7 + 2) + 13);
    const bars = code128Bars('T000123');
    expect(bars?.bars[0]?.x).toBe(10);
    expect(bars?.width).toBe(10 + 11 * 9 + 13 + 10);
  });
});

describe('password rules', () => {
  it('checks length, match and current', () => {
    expect(newPasswordError({ next: 'short', confirm: 'short' })).toBe('password.err.short');
    expect(newPasswordError({ next: 'x'.repeat(129), confirm: 'x'.repeat(129) })).toBe('password.err.long');
    expect(newPasswordError({ next: 'longenough', confirm: 'longenougH' })).toBe('password.err.mismatch');
    expect(newPasswordError({ next: 'longenough', confirm: 'longenough' })).toBeNull();
    expect(newPasswordError({ next: 'longenough', confirm: 'longenough', requireCurrent: true })).toBe('password.err.current');
    expect(newPasswordError({ next: 'longenough', confirm: 'longenough', current: 'longenough', requireCurrent: true })).toBe('password.err.same');
  });
});

describe('label QR (qrcode-generator 2.0.4)', () => {
  it('encodes a tag payload as a version-1 symbol with the finder patterns', () => {
    const m = qrMatrix('T000042');
    expect(m?.size).toBe(21);
    if (!m) return;
    expect([0, 1, 2, 3, 4, 5, 6].every((c) => m.dark(0, c))).toBe(true);
    expect(m.dark(1, 1)).toBe(false);
    expect(m.dark(2, 2)).toBe(true);
    expect(m.dark(0, 7)).toBe(false);
    expect(qrPath(m).startsWith('M0 0h1v1h-1z')).toBe(true);
  });
  it('is stable for the same payload and grows with longer ones', () => {
    const a = qrMatrix('T000042');
    const b = qrMatrix('T000042');
    expect(a && b && qrPath(a) === qrPath(b)).toBe(true);
    expect(qrMatrix('CBE-RNG-000123|22K|4.200|AB12CD|https://shop.example/t/000123')?.size).toBeGreaterThan(21);
  });
  it('sends non-ASCII as UTF-8 bytes; empty or oversized payloads fall back to text', () => {
    expect(utf8Binary('\u20b9')).toHaveLength(3);
    expect(qrMatrix('\u0bae\u0bcb\u0ba4\u0bbf\u0bb0\u0bae\u0bcd')).not.toBeNull();
    expect(qrMatrix('')).toBeNull();
    expect(qrMatrix('x'.repeat(3000))).toBeNull();
  });
});

describe('lots (0.8.3)', () => {
  const line = (x: Record<string, unknown>) => ({ id: 'l1', item_id: 'i', sub_item_id: null, purity_id: 'p', pieces: 5, gross_wt: '50.000', stone_wt: '0.000', net_wt: '48.000', other_wt: '0.000', tagged_pieces: 2, tagged_gross_wt: '20.000', ...x }) as never;
  it('checks a lot line like the server', () => {
    const d = { ...blankLotLine(), item_id: 'i', gross_wt: '10', net_wt: '9.5' };
    expect(lotLineError(d)).toBeNull();
    expect(lotLineError({ ...d, item_id: '' })).toBe('inventory.err.item');
    expect(lotLineError({ ...d, pieces: '0' })).toBe('inventory.err.pcs');
    expect(lotLineError({ ...d, gross_wt: '0' })).toBe('inventory.err.gross');
    expect(lotLineError({ ...d, net_wt: '11' })).toBe('inventory.lots.err.net');
    expect(lotLineError({ ...d, id: 'l1', pieces: '1', tagged_pieces: 2 })).toBe('inventory.lots.err.belowTagged');
  });
  it('builds PATCH lines with ids and spots removed saved lines', () => {
    const d = { ...blankLotLine(), id: 'l1', item_id: 'i', purity_id: 'p', pieces: '5', gross_wt: '50', net_wt: '48', tagged_pieces: 2 };
    const out = toLotLines([d]);
    expect(out[0]).toMatchObject({ id: 'l1', item_id: 'i', purity_id: 'p', pieces: 5, gross_wt: '50.000', net_wt: '48.000' });
    const lot = { lines: [line({}), line({ id: 'l2' })] } as never;
    expect(removedLotLines(lot, [d]).map((l) => l.id)).toEqual(['l2']);
    expect(removedLotLines(lot, [d, { ...d, id: 'l2' }])).toEqual([]);
  });
  it('0.8.4: only lines with no tagged pieces can be taken off; a tagged lot still counts as open', () => {
    expect(canRemoveLotLine({ tagged_pieces: 0 })).toBe(true);
    expect(canRemoveLotLine({ tagged_pieces: 1 })).toBe(false);
    expect(lotIsOpen({ status: 'open' })).toBe(true);
    expect(lotIsOpen({ status: 'tagged' })).toBe(true);
    expect(lotIsOpen({ status: 'closed' })).toBe(false);
  });
  it('works out progress and what is left', () => {
    expect(lineRemaining(line({}))).toBe(3);
    expect(lineRemaining(line({ remaining_pieces: 1 }))).toBe(1);
    const p = lotProgress({ lines: [line({})], totals: { pieces: 5, gross_wt: '50.000', net_wt: '48.000', tagged_pieces: 2, remaining_gross_wt: '30.000' } } as never);
    expect(p.tagged).toBe(2);
    expect(p.total).toBe(5);
  });
  it('vendor lot reference: empty → left out, trimmed, too long → null', () => {
    expect(vendorLotRef('  ')).toBeUndefined();
    expect(vendorLotRef(' PKT-7 ')).toBe('PKT-7');
    expect(vendorLotRef('x'.repeat(60))).toHaveLength(60);
    expect(vendorLotRef('x'.repeat(61))).toBeNull();
  });
  it('draft transfer lines keep loose lines, add picked pieces, and report removed ones', () => {
    const existing = [
      { id: 'a', tag_id: 't1', tag_no: 'GR-1', pieces: 1, gross_wt: '5.000', net_wt: '5.000', received: false },
      { id: 'b', item_id: 'i', purity_id: 'p', pieces: 0, gross_wt: '3.000', net_wt: '3.000', received: false, from_counter_id: 'c', from_tray_id: null },
    ] as never[];
    expect(transferPatchLines(existing, [{ id: 't1' }, { id: 't2' }])).toEqual([
      { item_id: 'i', purity_id: 'p', pieces: 0, gross_wt: '3.000', net_wt: '3.000', from_counter_id: 'c', from_tray_id: null },
      { tag_id: 't1' }, { tag_id: 't2' },
    ]);
    expect(removedTransferLines(existing, [{ id: 't2' }])).toEqual(['GR-1']);
    expect(removedTransferLines(existing, [{ id: 't1' }])).toEqual([]);
  });
});

describe('stock-check report labels (0.8.4)', () => {
  it('uses the row labels by id first, then our reference lists', () => {
    const fb = (id?: string | null) => `ref:${id ?? ''}`;
    const labels = { i1: { code: 'RING', name: 'Ring' }, p1: { code: '22K', name: '22 carat' } } as never;
    expect(refLabel(labels, 'i1', fb)).toBe('Ring');
    expect(refLabel(labels, 'p1', fb, true)).toBe('22K');
    expect(refLabel(labels, 'i2', fb)).toBe('ref:i2');
    expect(refLabel(undefined, 'i1', fb)).toBe('ref:i1');
  });
});
