import type { ReactElement } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { I18nProvider } from '@/i18n';
import { sessionQueryOptions } from '@/lib/session';
import { handlers } from '@/mocks/handlers';
import { mastersMockState, resetMastersMock, setMastersNotLive } from '@/mocks/masters';
import { mastersApi } from './api';
import { KycPanel, RevealDialog } from './kyc';
import { MasterScreen } from './master-screen';
import { PanBackfillNotice } from './pages';
import { PhotosPanel } from './photos';
import { routePermFor } from '@/lib/permissions';

const must = <T,>(v: T | null | undefined): T => { if (v == null) throw new Error('missing'); return v; };
const server = setupServer(...handlers);
beforeAll(() => {
  server.listen({ onUnhandledRequest: 'bypass' });
  const mswFetch = globalThis.fetch; // installed by listen(); give relative /api URLs an origin
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => mswFetch(typeof input === 'string' && input.startsWith('/') ? `http://localhost${input}` : input, init);
});
afterAll(() => server.close());
beforeEach(() => resetMastersMock());
afterEach(() => cleanup());
const ALL_MANAGE = ['customers', 'tax', 'making_rules', 'counters', 'designs'].map((a) => `masters.${a}.manage`);
const EDIT = ALL_MANAGE;

function mount(kind: Parameters<typeof MasterScreen>[0]['kind'], permissions: string[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(sessionQueryOptions.queryKey, { user: { id: 'u', name: 'T', version: 1 }, permissions } as never);
  return render(<I18nProvider initial="en-IN"><QueryClientProvider client={qc}><MasterScreen kind={kind} /></QueryClientProvider></I18nProvider>);
}

describe('MasterScreen', () => {
  it('lists rows; staff get a view-only note and no Add', async () => {
    mount('payment_modes', ['sales.estimate.create']);
    expect((await screen.findAllByText('Old gold', { selector: 'td span' })).length).toBeGreaterThan(0);
    expect(screen.getByTestId('view-only-note')).toBeTruthy();
    expect((screen.getByRole('button', { name: /Add payment mode/ }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('customer PAN is masked to the last 4 in the list and the drawer', async () => {
    mount('customers', EDIT);
    expect(await screen.findByText('••••••234F')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Edit Demo Customer/ }));
    expect((await screen.findByTestId('masked-pan')).textContent).toBe('••••••234F');
    expect(document.body.textContent).not.toContain('ABCDE');
  });
  it('add drawer: short form, client validation, then saves', async () => {
    mount('hsn_codes', EDIT);
    fireEvent.click(await screen.findByRole('button', { name: /Add HSN code/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findAllByText('Please fill this in.')).toHaveLength(2);
    fireEvent.change(screen.getByLabelText(/^HSN code/), { target: { value: '7117' } });
    fireEvent.change(screen.getByLabelText(/^Description/), { target: { value: 'Imitation jewellery' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(dialog.getAttribute('aria-label')).toBe('7117'));
    expect(await screen.findByText('7117', { selector: 'td span' })).toBeTruthy();
  });
  it('VA rule form shows Making charge and Wastage sections', async () => {
    mount('value_addition_rules', EDIT);
    fireEvent.click(await screen.findByRole('button', { name: /Add rule/ }));
    const mc = await screen.findByTestId('group-making_charge');
    expect(mc.querySelector('legend')?.textContent).toBe('Making charge');
    expect(mc.textContent).toContain('Making charge per gram');
    expect(screen.getByTestId('group-wastage').querySelector('legend')?.textContent).toBe('Wastage');
  });
  it('customers are read-only without the customer edit permission', async () => {
    mount('customers', ['sales.invoice.issue']);
    expect(await screen.findByTestId('view-only-note')).toBeTruthy();
    expect((screen.getByRole('button', { name: /Add customer/ }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('a master whose endpoint is not live yet shows a friendly note, not an error', async () => {
    setMastersNotLive(['trays']);
    mount('trays', EDIT);
    expect(await screen.findByTestId('not-ready')).toBeTruthy();
    expect((screen.getByRole('button', { name: /Add tray/ }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('import route is permission-guarded', () => expect(routePermFor('/masters/import')).toBe('platform.import.run'));
});

function wrap(ui: ReactElement, permissions: string[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(sessionQueryOptions.queryKey, { user: { id: 'u', name: 'T', version: 1 }, permissions } as never);
  return { qc, ...render(<I18nProvider initial="en-IN"><QueryClientProvider client={qc}>{ui}</QueryClientProvider></I18nProvider>) };
}

describe('0.7.0 KYC, photos, backfill', () => {
  it('reveal: reason required, PAN shown transiently, never in the query cache, gone after close', async () => {
    const [c] = (await mastersApi.list('customers')).items;
    let open = true;
    const { qc, rerender } = wrap(<RevealDialog party="customers" id={must(c).id} onClose={() => { open = false; }} />, ['masters.kyc.reveal']);
    const btn = screen.getByRole('button', { name: 'Show' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'GST invoice above two lakh' } });
    fireEvent.click(btn);
    expect((await screen.findByTestId('revealed')).textContent).toContain('ABCDE1234F');
    expect(JSON.stringify(qc.getQueryCache().getAll().map((q) => q.state.data))).not.toContain('ABCDE1234F');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(open).toBe(false);
    rerender(<I18nProvider initial="en-IN"><QueryClientProvider client={qc}><span /></QueryClientProvider></I18nProvider>);
    expect(screen.queryByText(/ABCDE1234F/)).toBeNull();
  });
  it('KYC panel lists masked numbers; Show only with masters.kyc.reveal', async () => {
    const [c] = (await mastersApi.list('customers')).items;
    const f = await mastersApi.uploadFile(new File(['x'], 'p.pdf', { type: 'application/pdf' }), 'kyc_document');
    await mastersApi.create('kyc_documents', { party_type: 'customer', party_id: must(c).id, doc_type: 'passport', number: 'P1234567', front_file_id: f.id });
    wrap(<KycPanel party="customers" row={must(c)} />, ['masters.customers.view']);
    expect((await screen.findByTestId('kyc-doc')).textContent).toContain('4567');
    expect(screen.queryByText('P1234567')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add document' })).toBeNull();
  });
  it('photos: move and make-cover controls reorder with the design version', async () => {
    const [d] = (await mastersApi.list('designs')).items;
    for (const [i, n] of ['a.png', 'b.png'].entries()) {
      const up = await mastersApi.uploadFile(new File([new Uint8Array([1])], n, { type: 'image/png' }), 'design_photo');
      await mastersApi.attachPhoto(must(d).id, { file_id: up.id, caption: null, is_primary: i === 0, sort_order: i });
    }
    wrap(<PhotosPanel design={await mastersApi.get('designs', must(d).id)} onChanged={() => undefined} />, ['masters.designs.manage']);
    await waitFor(() => expect(screen.getAllByTestId('photo')).toHaveLength(2));
    expect((screen.getByRole('button', { name: 'Move up Photo 1' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Make cover Photo 2' }));
    await waitFor(async () => expect((await mastersApi.listPhotos(must(d).id)).find((p) => p.is_primary)?.sort_order).toBe(1));
  });
  it('vendors: PAN backfill notice only while unfinished and only for vendor managers', async () => {
    wrap(<PanBackfillNotice />, ['masters.vendors.manage']);
    expect(await screen.findByTestId('pan-backfill')).toBeTruthy();
    cleanup();
    mastersMockState.setBackfillDone(true);
    wrap(<PanBackfillNotice />, ['masters.vendors.manage']);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('pan-backfill')).toBeNull();
  });
  it('route guards use masters.<area>.view', () => {
    expect(routePermFor('/masters/stone_rates')).toBe('masters.stones.view');
    expect(routePermFor('/masters/sub_items')).toBe('masters.items.view');
  });
});
