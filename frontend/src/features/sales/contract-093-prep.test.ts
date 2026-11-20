import { describe, expect, it } from 'vitest';
import { canRequestDuplicate093, needsReason093, printBadges093, printBody093, validPieces093 } from './contract-093-prep';
import { pricedLine } from './fixtures';
import { printBody, invalidGoodsLineIndex } from './logic';

describe('active 0.9.3 print and goods rules', () => {
  it('cancelled first print and explicit duplicate need a reason; auto leaves the server to choose the copy', () => {
    expect(needsReason093(0, true)).toBe(true); expect(needsReason093(0, false, 'duplicate')).toBe(true);
    expect(() => printBody093({ count: 0, cancelled: true, reason: '' })).toThrow('reprint_reason_required');
    expect(printBody093({ count: 0, cancelled: true, copy: 'duplicate', reason: ' Cancelled copy ' })).toEqual({ copy: 'duplicate', reprint_reason: 'Cancelled copy' });
    expect(printBody093({ count: 0, cancelled: false, reason: '' })).toEqual({});
    expect(canRequestDuplicate093(0, false)).toBe(false); expect(canRequestDuplicate093(0, true)).toBe(true); expect(canRequestDuplicate093(1, false)).toBe(true);
    expect(() => printBody093({ count: 0, cancelled: false, copy: 'duplicate', reason: 'Another copy' })).toThrow('first_print_duplicate_not_supported');
    expect(printBody093({ count: 2, cancelled: false, copy: 'duplicate', reason: 'Another copy' })).toEqual({ copy: 'duplicate', reprint_reason: 'Another copy' });
    expect(printBody({ printCount: 0, reason: 'Not sent on first print' })).toEqual({});
  });
  it('uses server copy and cancelled snapshot, including a first logged duplicate; refuses an impossible cancelled original', () => {
    expect(printBadges093({ copy: 'duplicate', doc_cancelled: true })).toEqual({ copy: 'duplicate', stamp: 'CANCELLED' });
    expect(printBadges093({ copy: 'duplicate', doc_cancelled: false }).stamp).toBe('DUPLICATE');
    expect(() => printBadges093({ copy: 'original', doc_cancelled: true })).toThrow('cancelled_original_protocol_error');
  });
  it('permits weight-only loose lines in the active gate, never a zero-piece tag or zero weight', () => {
    expect(validPieces093('loose', 0, '1.000')).toBe(true);
    expect(validPieces093('loose', 0, '0.000')).toBe(false);
    expect(validPieces093('tag', 0, '1.000')).toBe(false);
    expect(invalidGoodsLineIndex([{ key: 'tag', kind: 'tag', tag_id: 'tag-1', tag_no: 'T' }], [{ ...pricedLine(), pieces: 0 }])).toBe(0); expect(validPieces093('tag', 1, '1.000')).toBe(true);
    expect(validPieces093('loose', -1, '1.000')).toBe(false);
    expect(validPieces093('loose', 0.5, '1.000')).toBe(false);
    expect(invalidGoodsLineIndex([{ key: 'x', kind: 'loose', pieces: 0, item_id: 'i', purity_id: 'p', gross_wt: '1.000', net_wt: '1.000' }])).toBe(-1);
  });
});
