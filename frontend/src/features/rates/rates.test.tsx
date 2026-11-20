import type { ReactElement } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { I18nProvider } from '@/i18n';
import { sessionQueryOptions } from '@/lib/session';
import { ok } from '@/lib/api/fetcher';
import { login, verifyOtp } from '@/lib/api/backend/auth/auth';
import { getOnboarding } from '@/lib/api/backend/onboarding/onboarding';
import { BrandProvider } from '@/lib/brand/context';
import type { Brand } from '@/lib/brand/loader';
import type { OtpChallenge } from '@/lib/api/backend/model';
import { handlers, resetMockServer } from '@/mocks/handlers';
import { BRANCH_ID, db } from '@/mocks/db';
import { ratesApi } from './api';
import { deriveAll, deriveRate } from './derive';
import { TodaysRateBanner } from './banner';
import { TodaysRatesForm } from './entry';
import { RateCard } from './rate-card';

const server = setupServer(...handlers);
beforeAll(() => {
  server.listen({ onUnhandledRequest: 'bypass' });
  const mswFetch = globalThis.fetch;
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => mswFetch(typeof input === 'string' && input.startsWith('/') ? `http://localhost${input}` : input, init);
});
afterAll(() => server.close());
afterEach(() => cleanup());
const DEVICE = 'mock-approved-device-key-000000000001';
beforeEach(async () => {
  resetMockServer();
  const res = await login({ login: 'owner', password: 'Password@123', device_key: DEVICE });
  await ok(verifyOtp({ challenge_id: (res.data as OtpChallenge).challenge_id, code: '123456', device_key: DEVICE }));
});
const BRAND = { appName: 'Test Jewellers', logoUrl: '', version: 't', tokens: {}, loginText: '', supportContact: '' } as unknown as Brand;
function mount(ui: ReactElement, permissions = ['*']) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(sessionQueryOptions.queryKey, { user: { id: 'u', name: 'T', version: 1 }, permissions } as never);
  return render(<I18nProvider initial="en-IN"><BrandProvider initial={BRAND}><QueryClientProvider client={qc}>{ui}</QueryClientProvider></BrandProvider></I18nProvider>);
}
const purity = (code: string) => db().purities.find((p) => p.code === code);

describe('rates: derivation (decimal.js, no floats)', () => {
  it('22K from 24K 12490.00 = 12490 × 916 / 999.9, half-up at 2dp', () => {
    expect(deriveRate('12490.00', '999.900', '916.000')).toBe('11441.98');
    expect(deriveRate('0.10', '999.900', '999.900')).toBe('0.10');
  });
  it('derives every active purity of the metal, finest first, base marked', () => {
    const gold = db().metals.find((m) => m.code === 'GOLD')?.id ?? '';
    const rows = deriveAll(db().purities as never, gold, '12490.00');
    expect(rows.map((r) => [r.purity.code, r.rate, r.isBase])).toEqual([['24K', '12490.00', true], ['22K', '11441.98', false], ['18K', '9368.44', false]]);
  });
});

describe('rates: mock todays-status + onboarding', () => {
  it('no rate today → GOLD and SILVER missing, todays_rates in missing_billing_steps', async () => {
    const s = await ratesApi.todaysStatus(BRANCH_ID);
    expect(s).toMatchObject({ branch_id: BRANCH_ID, missing_metal_codes: ['GOLD', 'SILVER'], missing_old_metal_codes: ['GOLD', 'SILVER'], todays_rate_set: false });
    expect((await ok(getOnboarding())).missing_billing_steps).toContain('todays_rates');
  });
  it('a branch-only gold rate clears GOLD for that branch, not shop-wide', async () => {
    await ratesApi.publish({ purity_id: purity('24K')?.id ?? '', kind: 'sale', rate_per_g: '12490.00', branch_id: BRANCH_ID });
    expect((await ratesApi.todaysStatus(BRANCH_ID)).missing_metal_codes).toEqual(['SILVER']);
    const shop = await ratesApi.todaysStatus(null);
    expect(shop.todays_rate_set).toBe(false); expect(shop.missing_metal_codes).toContain('SILVER');
    expect(shop.branches?.find((b) => b.branch_id === BRANCH_ID)?.missing_metal_codes).toEqual(['SILVER']);
    await expect(ratesApi.todaysStatus('01920000-0000-7000-8000-00000000dead')).rejects.toMatchObject({ status: 404 });
    await ratesApi.publish({ purity_id: purity('925')?.id ?? '', kind: 'sale', rate_per_g: '165.00' });
    expect((await ratesApi.todaysStatus(BRANCH_ID)).todays_rate_set).toBe(true);
    expect((await ok(getOnboarding())).missing_billing_steps).not.toContain('todays_rates');
  });
});

describe('rates: mock batch (0.7.4 R4)', () => {
  const KEY = 'test-key-0000000000000001';
  it('derives the other purities, applies an override, replays by key, 422s on reuse and bad override', async () => {
    const res = await ratesApi.publishBatch({ kind: 'sale', bases: [{ purity_id: purity('24K')?.id ?? '', rate_per_g: '12490.00' }], overrides: [{ purity_id: purity('18K')?.id ?? '', rate_per_g: '9400.00' }] }, KEY);
    const by = (c: string) => res.items.find((r) => r.purity_id === purity(c)?.id);
    expect(by('24K')?.derived_from_id).toBeNull();
    expect(by('22K')).toMatchObject({ rate_per_g: '11441.98', derived_rate_per_g: '11441.98', derived_from_id: by('24K')?.id });
    expect(by('18K')).toMatchObject({ rate_per_g: '9400.00', derived_rate_per_g: '9368.44' });
    const again = await ratesApi.publishBatch({ kind: 'sale', bases: [{ purity_id: purity('24K')?.id ?? '', rate_per_g: '12490.00' }], overrides: [{ purity_id: purity('18K')?.id ?? '', rate_per_g: '9400.00' }] }, KEY);
    expect(again.items[0]?.id).toBe(res.items[0]?.id);
    await expect(ratesApi.publishBatch({ kind: 'sale', bases: [{ purity_id: purity('24K')?.id ?? '', rate_per_g: '1.00' }] }, KEY)).rejects.toMatchObject({ code: 'idempotency_key_reused' });
    await expect(ratesApi.publishBatch({ kind: 'sale', bases: [{ purity_id: purity('22K')?.id ?? '', rate_per_g: '1.00' }], overrides: [{ purity_id: purity('925')?.id ?? '', rate_per_g: '1.00' }] }, 'test-key-0000000000000002')).rejects.toMatchObject({ code: 'invalid_override' });
    const hist = await ratesApi.history({ metal_id: db().metals.find((m) => m.code === 'SILVER')?.id });
    expect(hist.items.every((r) => db().purities.find((p) => p.id === r.purity_id)?.code !== '22K')).toBe(true);
  });
  it('rate card endpoint: doc_type rate_card with sale + old-metal per purity', async () => {
    await ratesApi.publishBatch({ kind: 'sale', bases: [{ purity_id: purity('24K')?.id ?? '', rate_per_g: '12490.00' }] }, 'test-key-0000000000000003');
    const card = await ratesApi.rateCard(BRANCH_ID);
    expect(card.doc_type).toBe('rate_card');
    expect(card.branch?.id).toBe(BRANCH_ID);
    expect(card.metals.find((m) => m.code === 'GOLD')?.purities.find((p) => p.code === '22K')?.sale_rate_per_g).toBe('11441.98');
  });
});

describe('rates: UI', () => {
  it('banner: blocker lists codes; old-metal is a softer status', async () => {
    mount(<TodaysRateBanner branchId={BRANCH_ID} linkToRates={false} />); // Link needs a router
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain("Today's rate not set: GOLD, SILVER");
    expect(screen.getByRole('status').textContent).toContain('Old-metal rate not set today: GOLD, SILVER');
  });
  it('entry: one base rate → derived rows; saves shop-wide or for one branch only', async () => {
    mount(<TodaysRatesForm />);
    const gold = await screen.findByTestId('entry-GOLD');
    fireEvent.change(within(gold).getByLabelText(/^Gold 24K rate per gram/), { target: { value: '12490.00' } });
    expect(within(gold).getByTestId('derived-22K').textContent).toContain('₹11,441.98');
    fireEvent.click(screen.getByRole('button', { name: 'Save for all branches' }));
    await screen.findByText('Rates saved.');
    const shop = db().rates.filter((r) => r.rate_per_g === '11441.98');
    expect(shop).toHaveLength(1); expect(shop[0]?.branch_id).toBeNull();
    fireEvent.change(screen.getByLabelText(/^Applies to/), { target: { value: BRANCH_ID } });
    fireEvent.change(within(gold).getByLabelText(/^Gold 24K rate per gram/), { target: { value: '1250000.00' } });
    expect(within(gold).getByTestId('derived-24K').textContent).toContain('₹12,50,000.00');
    fireEvent.click(screen.getByRole('button', { name: 'Save for T. Nagar only' }));
    await waitFor(() => expect(db().rates.filter((r) => r.branch_id === BRANCH_ID && r.kind === 'sale')).toHaveLength(3));
  });
  it('entry: an override goes under "Adjust a purity rate"; re-saving today needs rates.edit', async () => {
    mount(<TodaysRatesForm />, ['rates.publish']);
    const gold = await screen.findByTestId('entry-GOLD');
    fireEvent.change(within(gold).getByLabelText(/^Gold 24K rate per gram/), { target: { value: '12490.00' } });
    fireEvent.change(within(within(gold).getByTestId('adjust-GOLD')).getByLabelText(/^22K rate per gram/), { target: { value: '11450.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save for all branches' }));
    await screen.findByText('Rates saved.');
    expect(db().rates.find((r) => r.purity_id === purity('22K')?.id && r.branch_id == null && r.kind === 'sale')?.rate_per_g).toBe('11450.00');
    fireEvent.change(within(gold).getByLabelText(/^Gold 24K rate per gram/), { target: { value: '12500.00' } });
    expect((await screen.findByTestId('correction-note')).textContent).toContain('rates.edit');
    expect((screen.getByRole('button', { name: 'Save for all branches' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('entry: a bad rate blocks saving; read-only without rates.publish', async () => {
    mount(<TodaysRatesForm />);
    const gold = await screen.findByTestId('entry-GOLD');
    fireEvent.change(within(gold).getByLabelText(/^Gold 24K rate per gram/), { target: { value: '1.234' } });
    expect((screen.getByRole('button', { name: 'Save for all branches' }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    mount(<TodaysRatesForm />, ['sales.estimate.create']);
    expect(await screen.findByText('You can view rates but not change them.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Save/ })).toBeNull();
  });
  it('rate card: doc_type rate_card, Tamil numerals for rates and date, Latin purity codes', () => {
    const data = { doc_type: 'rate_card', rate_date: '2026-10-28', generated_at: '2026-10-28T06:00:00Z', company: null, branch: null, todays_rate_set: true, missing_metal_codes: [],
      metals: [{ metal_id: 'g', code: 'GOLD', name: 'Gold', purities: [{ purity_id: 'p', code: '22K', fineness: '916.000', sale_rate_per_g: '11450.00', sale_rate_date: '2026-10-28', old_metal_rate_per_g: null }] }] };
    mount(<RateCard card={data as never} locale="ta-IN" numerals="taml" />);
    const card = screen.getByTestId('rate-card');
    expect(card.dataset.docType).toBe('rate_card');
    const row = screen.getByTestId('card-22K');
    expect(row.textContent).toContain('22K');
    expect(row.textContent).toContain('₹௧௧,௪௫௦.௦௦');
    expect(row.textContent).toContain('₹௯௧,௬௦௦.௦௦');
    expect(screen.getByTestId('rate-card-date').textContent).toContain('௨௮-௧௦-௨௦௨௬');
    expect(card.textContent).toContain('இன்றைய விலை');
  });
});
