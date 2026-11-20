import { describe, expect, it } from 'vitest';
import { endDateError, istToday, newPeriodError, periodStatus, ROUND_OFF_UNITS, ruleActions } from './tax';
import type { TaxRule } from '@/lib/api/backend/model';

const T = '2026-10-24';
const rule = (o: Partial<TaxRule>): TaxRule => ({
  id: 'r', scope: 'tenant', code: 'X', description: null, component: 'metal', metal_code: null, code_type: 'HSN', hsn_sac: '7113', rate: '3', cgst_rate: '1.5', sgst_rate: '1.5',
  igst_rate: '3', cess_rate: '0', composite_supply: false, principal_component: null, reverse_charge: false, effective_from: '2026-04-01', effective_to: null, in_use: false, ...o,
});

describe('tax periods (0.4.3 / 0.4.4)', () => {
  it('round-off enum is the contract set', () => expect(ROUND_OFF_UNITS).toEqual(['0.01', '0.10', '0.50', '1.00']));
  it('istToday is IST', () => expect(istToday(new Date('2026-10-23T19:00:00Z'))).toBe('2026-10-24'));
  it('status with exclusive end', () => {
    expect(periodStatus({ effective_from: '2026-04-01', effective_to: null }, T)).toBe('current');
    expect(periodStatus({ effective_from: '2026-04-01', effective_to: T }, T)).toBe('closed');
    expect(periodStatus({ effective_from: '2026-04-01', effective_to: '2026-10-25' }, T)).toBe('current');
    expect(periodStatus({ effective_from: '2026-11-01' }, T)).toBe('upcoming');
  });
  it('new period date: >= today and after the open period start', () => {
    expect(newPeriodError(undefined, '2026-10-23', T)).toBe('past');
    expect(newPeriodError({ effective_from: T, effective_to: null }, T, T)).toBe('notAfterCurrent');
    expect(newPeriodError({ effective_from: '2026-04-01', effective_to: null }, T, T)).toBeNull();
  });
  it('actions: platform read-only; in-use can be replaced but not just closed', () => {
    expect(ruleActions(rule({ scope: 'platform' }), T)).toEqual({ canClose: false, canReplace: false, canOverride: true });
    expect(ruleActions(rule({ in_use: true }), T)).toEqual({ canClose: true, canReplace: true, canOverride: false });
    expect(ruleActions(rule({ in_use: true, effective_to: '2026-12-01' }), T)).toEqual({ canClose: false, canReplace: false, canOverride: false });
    expect(ruleActions(rule({ effective_to: '2026-12-01' }), T)).toEqual({ canClose: false, canReplace: true, canOverride: false });
    expect(ruleActions(rule({}), T)).toEqual({ canClose: true, canReplace: true, canOverride: false });
    expect(ruleActions(rule({ effective_to: '2026-05-01' }), T).canReplace).toBe(false);
  });
  it('replacing a row that already has an end date may not leave a gap', () => {
    expect(newPeriodError({ effective_from: '2026-04-01', effective_to: '2026-11-01' }, '2026-11-02', T)).toBe('gap');
    expect(newPeriodError({ effective_from: '2026-04-01', effective_to: '2026-11-01' }, '2026-11-01', T)).toBeNull();
  });
  it('optional end date must be after start', () => {
    expect(endDateError('2026-11-07', undefined)).toBeNull();
    expect(endDateError('2026-11-07', '2026-11-07')).toBe('endNotAfterStart');
    expect(endDateError('2026-11-07', '2026-11-08')).toBeNull();
  });
});
