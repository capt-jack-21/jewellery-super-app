import { salesKeys } from '@/features/sales/api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nProvider } from '@/i18n';
import en from '@/i18n/messages/en-IN.json';
import { getListGstConfigQueryKey, getListTaxRulesQueryKey } from '@/lib/api/backend/settings/settings';
import type { GstConfig, TaxRule } from '@/lib/api/backend/model';
import { FEATURE_RATE_END_DATE } from '@/features/flags';
import { GstConfigCard, TaxRulesCard, withEndDate } from './tax';

vi.mock('@tanstack/react-router', () => ({ Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a> }));

const gst: GstConfig = { id: 'g1', company_id: null, registration_type: 'regular', tax_inclusive: false, rounding_level: 'invoice', round_off_unit: '1.00',
  einvoice_enabled: false, einvoice_from: null, b2c_qr: false, effective_from: '2017-07-01', effective_to: null };
const rule: TaxRule = { id: 'r1', scope: 'tenant', code: 'MINE', description: null, component: 'other', metal_code: null, code_type: 'HSN', hsn_sac: '7117', rate: '3',
  cgst_rate: '1.5', sgst_rate: '1.5', igst_rate: '3', cess_rate: '0', composite_supply: false, principal_component: null, reverse_charge: false,
  effective_from: '2017-07-01', effective_to: null, in_use: false };

function ui(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, queryFn: () => new Promise(() => {}) } } });
  qc.setQueryData(getListGstConfigQueryKey(), [gst]);
  qc.setQueryData(getListTaxRulesQueryKey(), [rule]);
  qc.setQueryData(salesKeys.settings(), { making_gst_treatment: 'composite' });
  return render(<QueryClientProvider client={qc}><I18nProvider initial="en-IN">{node}</I18nProvider></QueryClientProvider>);
}
afterEach(cleanup);

describe('FEATURE_RATE_END_DATE (deferred)', () => {
  it('is off', () => expect(FEATURE_RATE_END_DATE).toBe(false));
  it('GST "close and start new" shows no end-date field', () => {
    ui(<GstConfigCard />);
    expect(screen.getAllByText(en['tax.closeAndStart']).length).toBeGreaterThan(0);
    expect(screen.queryByLabelText(en['tax.effectiveTo'])).toBeNull();
  });
  it('tax rule "change rate" shows no end-date field', () => {
    ui(<TaxRulesCard />);
    fireEvent.click(screen.getByRole('button', { name: en['tax.changeRate'] }));
    expect(screen.getByText(en['tax.changeRateFor'].replace('{code}', 'MINE'))).toBeTruthy();
    expect(screen.queryByLabelText(en['tax.effectiveTo'])).toBeNull();
  });
  it('effective_to is stripped from request bodies while off', () => {
    expect(withEndDate({ effective_from: '2026-11-07', effective_to: '2026-12-01' })).toEqual({ effective_from: '2026-11-07' });
    expect(withEndDate({ effective_from: '2026-11-07', effective_to: '2026-12-01' }, true)).toEqual({ effective_from: '2026-11-07', effective_to: '2026-12-01' });
  });
});
