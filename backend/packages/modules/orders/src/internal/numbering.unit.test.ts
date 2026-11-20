import { describe, it, expect } from 'vitest';
import { docPrefixOf, indianFY, ORDER_NO_FORMAT, REPAIR_NO_FORMAT, renderDocNo } from './numbering';

describe('order and repair numbers', () => {
  it('renders ORD-{BRANCH}-{FY}-{SEQ:5} and REP-…', () => {
    const ctx = { branchCode: 'cbe', fy: '2627' };
    expect(renderDocNo(ORDER_NO_FORMAT, ctx, 7)).toBe('ORD-CBE-2627-00007');
    expect(renderDocNo(REPAIR_NO_FORMAT, ctx, 12345)).toBe('REP-CBE-2627-12345');
    expect(docPrefixOf(ORDER_NO_FORMAT, ctx)).toBe('ORD-CBE-2627-');
  });
  it('financial year runs April to March', () => {
    expect(indianFY('2026-11-05')).toBe('2627');
    expect(indianFY('2027-03-31')).toBe('2627');
    expect(indianFY('2027-04-01')).toBe('2728');
  });
});
