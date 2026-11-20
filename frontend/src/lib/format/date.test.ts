import { describe, expect, it } from 'vitest';
import { financialYear, formatDateIN, formatDateTimeIN, parseInstant } from './date';

describe('dates in IST', () => {
  it('dd-MM-yyyy in Asia/Kolkata even near UTC midnight', () => {
    expect(formatDateIN('2026-10-20T20:00:00Z')).toBe('21-10-2026');
    expect(formatDateTimeIN('2026-10-20T15:17:00Z')).toBe('20-10-2026 20:47 IST');
  });
  it('financial year Apr–Mar', () => {
    expect(financialYear('2026-03-31T12:00:00+05:30')).toBe('2025-26');
    expect(financialYear('2026-04-01T00:10:00+05:30')).toBe('2026-27');
    expect(financialYear('2026-03-31T19:00:00Z')).toBe('2026-27'); // already 1 Apr in IST
  });
  it('0.9.0 RFC 3339 UTC with microseconds converts to IST', () => {
    expect(formatDateTimeIN('2026-11-09T13:16:01.792494Z')).toBe('09-11-2026 18:46 IST');
    expect(formatDateIN('2026-11-09T19:00:00.000001Z')).toBe('10-11-2026');
  });
  it('legacy Postgres text (space separator, +05:30, 6-digit fraction) gives the same instant', () => {
    const legacy = parseInstant('2026-11-09 18:46:01.792494+05:30');
    expect(legacy?.toISOString()).toBe('2026-11-09T13:16:01.792Z');
    expect(parseInstant('2026-11-09T18:46:01+0530')?.toISOString()).toBe('2026-11-09T13:16:01.000Z');
    expect(parseInstant('2026-11-09 18:46')?.toISOString()).toBe('2026-11-09T13:16:00.000Z'); // zone-less = IST
    expect(formatDateTimeIN('2026-11-09 18:46:01.792494+05:30')).toBe('09-11-2026 18:46 IST');
  });
  it('missing or bad values never throw', () => {
    for (const v of [null, undefined, '', 'nope', new Date('x')]) {
      expect(parseInstant(v)).toBeNull();
      expect(formatDateTimeIN(v)).toBe('—');
      expect(formatDateIN(v)).toBe('—');
    }
    expect(financialYear('nope')).toBe('');
    expect(formatDateIN('2026-11-09')).toBe('09-11-2026');
  });
});
