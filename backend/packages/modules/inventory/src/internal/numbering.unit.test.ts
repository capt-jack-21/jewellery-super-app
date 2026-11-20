import { describe, it, expect } from 'vitest';
import { DEFAULT_TAG_FORMAT, renderTagNo, tagScopeKey, validateTagFormat, indianFY, renderDocNo, docPrefixOf, TRANSFER_NO_FORMAT, ADJUSTMENT_NO_FORMAT, validateDocNoFormat } from './numbering';
import { assertTransition, statusCatalog, TAG_STATUSES, TERMINAL } from './statuses';
import { gm, mg } from './db';

describe('tag numbering', () => {
  it('default T000123', () => expect(renderTagNo(DEFAULT_TAG_FORMAT, {}, 123)).toBe('T000123'));
  it('branch + item segments with separator, both orders', () => {
    const f = { ...DEFAULT_TAG_FORMAT, prefix: '', separator: '-' as const, branch_segment: true, item_segment: true };
    expect(renderTagNo(f, { branchCode: 'cbe', itemCode: 'R-NG' }, 123)).toBe('CBE-RNG-000123');
    expect(renderTagNo({ ...f, segment_order: 'item_branch' }, { branchCode: 'CBE', itemCode: 'RNG' }, 7)).toBe('RNG-CBE-000007');
    expect(tagScopeKey(f, { branchCode: 'CBE', itemCode: 'RNG' })).toMatch(/^[A-Z0-9/-]{0,40}$/);
  });
  it('validates the format', () => {
    expect(validateTagFormat(DEFAULT_TAG_FORMAT)).toEqual([]);
    expect(validateTagFormat({ ...DEFAULT_TAG_FORMAT, digits: 2, start_no: 100 }).map((e) => e.path)).toContain('tag_format.start_no');
    expect(validateTagFormat({ ...DEFAULT_TAG_FORMAT, prefix: 'ab' }).length).toBe(1);
  });
});
describe('TRF / ADJ numbers (Indian FY)', () => {
  it('FY boundaries', () => {
    expect(indianFY('2026-11-05')).toBe('2627');
    expect(indianFY('2027-03-31')).toBe('2627');
    expect(indianFY('2027-04-01')).toBe('2728');
    expect(indianFY('2099-12-01')).toBe('9900');
  });
  it('renders', () => {
    expect(renderDocNo(TRANSFER_NO_FORMAT, { branchCode: 'CBE', fy: '2627' }, 42)).toBe('TRF-CBE-2627-00042');
    expect(renderDocNo(ADJUSTMENT_NO_FORMAT, { branchCode: 'CBE', fy: '2627' }, 1)).toBe('ADJ-CBE-2627-00001');
    expect(docPrefixOf(TRANSFER_NO_FORMAT, { branchCode: 'CBE', fy: '2627' })).toBe('TRF-CBE-2627-');
  });
});
describe('status transitions', () => {
  it('enum and terminal set exactly', () => {
    expect([...TAG_STATUSES]).toEqual(['in_stock', 'reserved', 'sold', 'on_approval', 'repair', 'melting', 'in_transit', 'returned_to_vendor', 'melted', 'written_off']);
    expect([...TERMINAL].sort()).toEqual(['melted', 'returned_to_vendor', 'sold', 'written_off']);
  });
  it('written_off only via full_write_off and never leaves', () => {
    expect(() => assertTransition('in_stock', 'written_off', 'manual')).toThrow(/full write-off/);
    expect(() => assertTransition('in_stock', 'written_off', 'full_write_off')).not.toThrow();
    for (const to of TAG_STATUSES) expect(() => assertTransition('written_off', to, 'manual')).toThrow(/written off/);
    expect(() => assertTransition('written_off', 'in_transit', 'transfer_dispatch')).toThrow(/written off/);
  });
  it('manual: reserve / repair / melting and back only', () => {
    expect(() => assertTransition('in_stock', 'reserved', 'manual')).not.toThrow();
    expect(() => assertTransition('repair', 'in_stock', 'manual')).not.toThrow();
    expect(() => assertTransition('in_stock', 'sold', 'manual')).toThrow();
    expect(() => assertTransition('sold', 'in_stock', 'manual')).toThrow();
  });
  it('catalog marks terminal statuses with no transitions out except sales return', () => {
    const c = Object.fromEntries(statusCatalog().map((s) => [s.code, s]));
    expect(c.written_off.terminal && c.written_off.transitions.length === 0).toBe(true);
    expect(c.in_stock.sellable).toBe(true);
  });
});
describe('exact gram arithmetic', () => {
  it('round trips', () => {
    expect(gm(mg('10.5') - mg('0.125'))).toBe('10.375');
    expect(gm(-mg('2.000'))).toBe('-2.000');
    expect(mg('-0.001')).toBe(-1n);
  });
});
describe('document number formats (shop_setting.transfer_no_format / adjustment_no_format)', () => {
  it('accepts the defaults and custom formats with one trailing {SEQ}', () => {
    for (const f of [TRANSFER_NO_FORMAT, ADJUSTMENT_NO_FORMAT, 'ST/{FY}/{SEQ}', '{BRANCH}-TR-{SEQ:4}']) expect(validateDocNoFormat('f', f)).toEqual([]);
    expect(validateDocNoFormat('f', undefined)).toEqual([]);
  });
  it('refuses no/duplicate {SEQ}, unknown tokens, text after {SEQ}, bad chars and > 64 chars', () => {
    for (const f of ['', 'TRF-{BRANCH}', 'A{SEQ}{SEQ:2}', 'TRF-{DATE}-{SEQ}', 'TRF-{SEQ:5}-X', 'TR F-{SEQ}', 'TRF-{SEQ:0}', `${'A'.repeat(60)}{SEQ}`, 'X{SEQ:70}'])
      expect(validateDocNoFormat('f', f), f).toHaveLength(1);
  });
});
