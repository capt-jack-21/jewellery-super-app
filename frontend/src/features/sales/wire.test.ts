import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EstimateRequest, IssueInvoiceRequest, PaymentReceiptRequest, PreviewBillRequest, SalesSettingsPatch } from '@/lib/api/backend/model';
import { checkedSalesWire } from './wire';
import { salesApi } from './api';
import { emptyDraft, moneyInput, toEstimateRequest, toIssueRequest, toLineInput, toOldGoldInput, toPreviewRequest, toTenderInput, weightInput } from './logic';
import { settingsDraft, settingsPatch } from './settings';
import { BR, CUST, settings, SP } from './fixtures';

const nn = <T,>(v: T | null) => { if (v === null) throw new Error('missing'); return v; };
const calls: unknown[] = [];
beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (_input, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)) as unknown);
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('0.9.3 exact decimal wire scale (UI accepts typed short values; wire never does)', () => {
  for (const [field, valid, invalid] of [
    ['amount', '1.00', [1, '1', '1.2', '1.000']],
    ['gross_wt', '1.000', [1, '1', '1.23', '1.0000']],
    ['making_service_rate', '18.00', [18, '18', '18.0', '18.000']],
  ] as const) {
    it(`${field}: exact string is accepted; JSON numbers, short scale and over-scale are rejected`, () => {
      expect(checkedSalesWire({ [field]: valid })).toEqual({ [field]: valid });
      for (const value of invalid) expect(() => checkedSalesWire({ [field]: value })).toThrow(expect.objectContaining({ status: 422, code: 'validation_failed' }));
    });
  }
  it('checks nested money, rates and weight keys; keeps counts and flexible percentage/DecimalAmount distinct', () => {
    const b = { lines: [{ pieces: 0, gross_wt: '1.000', net_wt: '1.000', stone_wt: '0.000', discount: '1.00', mc_value: '12.5', wastage_pct: '1.234' }], old_metal: [{ gross_wt: '2.000', less_wt: '0.500', touch_pct: '91.6', rate_override: '6000.00' }], payments: [{ mode: 'cash', amount: '10.00' }], bill_discount: '1.00', expected_total: '100.00' };
    expect(checkedSalesWire(b)).toBe(b); expect(checkedSalesWire({ making_service_rate: null })).toEqual({ making_service_rate: null });
    for (const key of ['discount', 'bill_discount', 'expected_total', 'rate_override', 'pan_required_above', 'cash_limit_amount', 'net_wt', 'stone_wt', 'less_wt']) {
      expect(() => checkedSalesWire({ nested: [{ [key]: '1' }] })).toThrow(expect.objectContaining({ status: 422, code: 'validation_failed' }));
    }
  });
  it('all serializers format loose/old-gold/tenders/preview/issue/estimate/settings without floats or fabricated pieces', async () => {
    const d = { ...emptyDraft(BR, SP), customer: { kind: 'existing' as const, id: CUST, name: 'Customer' }, bill_discount: '2.5',
      lines: [{ key: 'l', kind: 'loose' as const, item_id: 'i', purity_id: 'p', gross_wt: '1.2', net_wt: '1', stone_wt: '0.2', discount: '1.5', pieces: 0 }],
      old_metal: [{ key: 'o', purity_id: 'p', gross_wt: '2.5', less_wt: '0.5', touch_pct: '91.6', rate_override: '6000.5', override_reason: 'Heavy solder' }],
      tenders: [{ key: 't', mode: 'cash' as const, amount: '100.5' }] };
    const preview = nn(toPreviewRequest(d, 'estimate')), issue = nn(toIssueRequest(d, '1000.5')), estimate = nn(toEstimateRequest(d));
    expect(preview.lines[0]).toMatchObject({ gross_wt: '1.200', net_wt: '1.000', stone_wt: '0.200', discount: '1.50', pieces: 0 });
    expect(preview.old_metal?.[0]).toMatchObject({ gross_wt: '2.500', less_wt: '0.500', rate_override: '6000.50', touch_pct: '91.6' });
    expect(issue).toMatchObject({ bill_discount: '2.50', expected_total: '1000.50', payments: [{ amount: '100.50' }] });
    const patch = settingsPatch(settings(), { ...settingsDraft(settings()), making_service_rate: '18', pan_required_above: '250000', cash_limit_amount: '100000.5' });
    expect(patch).toEqual({ making_service_rate: '18.00', pan_required_above: '250000.00', cash_limit_amount: '100000.50' });
    await salesApi.preview(preview); await salesApi.issue(issue, 'issue'); await salesApi.createEstimate(estimate, 'estimate');
    await salesApi.replaceEstimate({ id: 'e', version: 1 }, estimate);
    await salesApi.receivePayment('i', { tenders: [nn(toTenderInput(d.tenders[0] ?? { key: 't', mode: 'cash', amount: '100.5' }))] }, 'receipt');
    await salesApi.patchSettings(patch, 0);
    expect(calls).toHaveLength(6); for (const body of calls) expect(checkedSalesWire(body)).toBe(body);
  });
  it('API boundaries reject noncanonical raw bodies before fetch, even if a caller bypasses UI serializers', () => {
    for (const v of [1, '1', '1.2', '1.000']) {
      const b = { branch_id: BR, lines: [], bill_discount: v };
      expect(() => salesApi.preview(b as unknown as PreviewBillRequest)).toThrow(expect.objectContaining({ status: 422, code: 'validation_failed' }));
      expect(() => salesApi.issue(b as unknown as IssueInvoiceRequest, 'i')).toThrow(expect.objectContaining({ status: 422, code: 'validation_failed' }));
      expect(() => salesApi.createEstimate(b as unknown as EstimateRequest, 'e')).toThrow(expect.objectContaining({ status: 422, code: 'validation_failed' }));
      expect(() => salesApi.replaceEstimate({ id: 'e', version: 1 }, b as unknown as EstimateRequest)).toThrow(expect.objectContaining({ status: 422, code: 'validation_failed' }));
      expect(() => salesApi.receivePayment('i', { tenders: [{ mode: 'cash', amount: v }] } as unknown as PaymentReceiptRequest, 'p')).toThrow(expect.objectContaining({ status: 422, code: 'validation_failed' }));
      expect(() => salesApi.patchSettings({ cash_limit_amount: v } as unknown as SalesSettingsPatch, 0)).toThrow(expect.objectContaining({ status: 422, code: 'validation_failed' }));
    }
    expect(calls).toHaveLength(0);
  });
  it('over-scale and number inputs are not rounded or coerced into apparently valid user inputs', () => {
    expect(moneyInput(1)).toBeNull(); expect(weightInput(1)).toBeNull(); expect(moneyInput('1.001')).toBeNull(); expect(weightInput('1.0001')).toBeNull();
    expect(toTenderInput({ key: 't', mode: 'cash', amount: '1.001' })).toBeNull();
    expect(toOldGoldInput({ key: 'o', purity_id: 'p', gross_wt: '1.0001' })).toBeNull();
    expect(() => toLineInput({ key: 'l', kind: 'loose', item_id: 'i', purity_id: 'p', gross_wt: '1.0001', net_wt: '1.000', pieces: 0 })).toThrow(expect.objectContaining({ status: 422, code: 'validation_failed' }));
  });
});
