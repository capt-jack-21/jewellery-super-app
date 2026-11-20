import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nProvider } from '@/i18n';
import en from '@/i18n/messages/en-IN.json';
import ta from '@/i18n/messages/ta-IN.json';
import { sessionQueryOptions } from '@/lib/session';
import { formatINR } from '@/lib/format';
import { ApiError } from '@/lib/api/fetcher';
import * as templates from './templates';
const actualResolve = templates.resolveSalesTemplate;
import { CustomerPicker } from './customer';
import { CancelForm, PayBalance, ReturnForm, Receipts, ReversePayment } from './invoice-page';
import { LooseEntry } from './loose';
import { EstimatesList, InvoicesList, CreditNotesList } from './lists';
import { PrintHistory, PrintPanel, printer, SalesPrintView as FrozenPrintView } from './print';
import { TenderEditor } from './tenders';
import { BillTotalsPanel, GstBreakup, OldGoldRow } from './totals';
import { SalesError, SalesOff, useSalesSettings } from './ui';
import { templateAsset, computation, CUST, creditNote, estimate, invoice, oldGold, printDoc, settings, BR } from './fixtures';
import { emptyLoose, looseToDraft, type DraftTender } from './logic';
import { BillScreen, eligibleSalesperson, LinesTable, MakingRateNote } from './bill-page';
import { rememberedSalesperson } from './hooks';
import { salesKeys } from './api';
import { SalesSettingsBody, SalesSettingsForm, settingsDraft, settingsIssues, settingsPatch, settingsRoute } from './settings';
import { creditNoteAmount, isGstCreditNote, SALES_ALERT_LABELS } from './events';
import type { PaymentReceipt } from '@/lib/api/backend/model';

type Reply = { status: number; body?: unknown };
let replies: Reply[] = [];
/** Reference reads outside /v1/sales (masters, rates) answer from here and are not recorded in `calls`. */
let refs: Record<string, unknown> = {};
const calls: Array<{ url: string; method: string; headers: Headers; body?: string }> = [];
beforeEach(() => {
  replies = []; calls.length = 0; refs = {};
  vi.spyOn(templates, 'resolveSalesTemplate').mockImplementation((d) => actualResolve(d, [{ id: d.template_id, version: d.template_version, doc_type: d.doc_type, body_key: templateAsset(d).body_key }]));
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.includes('/v1/sales')) {
      const hit = Object.entries(refs).find(([k]) => url.includes(k));
      return new Response(JSON.stringify(hit ? hit[1] : { title: 'Not Found' }), { status: hit ? 200 : 404, headers: { 'content-type': hit ? 'application/json' : 'application/problem+json' } });
    }
    calls.push({ url: String(input), method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: init?.body as string | undefined });
    const r = replies.shift() ?? { status: 404, body: { title: 'Not Found' } };
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: { 'content-type': r.status >= 400 ? 'application/problem+json' : 'application/json' } });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** Test helper: value or throw (no non-null assertions). */
const nn = <T,>(x: T | null | undefined): T => { if (x == null) throw new Error('missing'); return x; };

const ALL = ['sales.invoice.view', 'sales.invoice.issue', 'sales.invoice.cancel', 'sales.invoice.reprint', 'sales.return.issue', 'sales.payment.receive', 'sales.estimate.create'];
const client = (perms: string[]) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  qc.setQueryData(sessionQueryOptions.queryKey, { user: { id: 'u', name: 'Owner', version: 1 }, roles: [{ role: 'owner' }], permissions: perms } as never);
  return qc;
};
const ui = (node: ReactNode, perms: string[] = ALL) =>
  render(<QueryClientProvider client={client(perms)}><I18nProvider initial="en-IN">{node}</I18nProvider></QueryClientProvider>);
/** Screens with links / navigation: a memory router whose root renders the node. */
const routed = (node: ReactNode, perms: string[] = ALL) => {
  const rootRoute = createRootRoute({ component: () => <>{node}</> });
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: ['/'] }) });
  render(<QueryClientProvider client={client(perms)}><I18nProvider initial="en-IN"><RouterProvider router={router} /></I18nProvider></QueryClientProvider>);
  return router;
};
const text = (id: string) => screen.getByTestId(id).textContent ?? '';

function SalesPrintView({ doc }: { doc: ReturnType<typeof printDoc> }) { return <FrozenPrintView doc={doc} template={templateAsset(doc)} />; }

describe('calculation display (server figures, en-IN lakh grouping)', () => {
  it('intra-state: taxable, CGST + SGST, bill total and a big amount to pay', () => {
    ui(<BillTotalsPanel c={computation()} />);
    expect(text('taxable')).toContain(formatINR('74500.00'));
    expect(text('cgst')).toContain(formatINR('1117.50'));
    expect(text('sgst')).toContain(formatINR('1117.50'));
    expect(screen.queryByTestId('igst')).toBeNull();
    expect(text('payable')).toContain('76,735.00');
  });
  it('inter-state shows IGST only; old gold is taken off; zero GST shows no tax heads', () => {
    const c = computation();
    ui(<BillTotalsPanel c={computation({ gst_type: 'inter', totals: { ...c.totals, cgst: '0.00', sgst: '0.00', igst: '2235.00', old_metal_value: '32000.00', net_payable: '44735.00' } })} />);
    expect(text('igst')).toContain(formatINR('2235.00'));
    expect(screen.queryByTestId('cgst')).toBeNull();
    expect(text('old-gold-total')).toContain(formatINR('32000.00'));
    expect(text('payable')).toContain('44,735.00');
    cleanup();
    ui(<BillTotalsPanel c={computation({ zero_gst: true })} />);
    expect(screen.queryByTestId('cgst')).toBeNull();
    expect(screen.getByText(en['sales.totals.zeroGst'])).toBeTruthy();
  });
  it('GST breakup by HSN and rate; lakh grouping for big bills', () => {
    const c = computation();
    ui(<GstBreakup c={computation({ tax_summary: [{ ...nn(c.tax_summary[0]), taxable_value: '1234567.00' }] })} />);
    expect(text('gst-breakup')).toContain('7113');
    expect(text('gst-breakup')).toContain('12,34,567.00');
  });
  it('0.9.1 old gold priced at a changed rate shows "Rate changed from ₹X" with the reason', () => {
    ui(<OldGoldRow o={oldGold()} />);
    expect(text('rate-changed')).toContain(formatINR('6500.00'));
    expect(text('rate-changed')).toContain('Heavy solder');
    cleanup();
    ui(<OldGoldRow o={oldGold({ overridden: false, override_reason: null, rate_per_g: '6500.00' })} />);
    expect(screen.queryByTestId('rate-changed')).toBeNull();
  });
});

describe('tender editor', () => {
  const T = (amount: string, mode: DraftTender['mode'] = 'cash'): DraftTender => ({ key: `${mode}${amount}`, mode, amount });
  it('shows what is still due and blocks paying more than due', () => {
    const onChange = vi.fn();
    ui(<TenderEditor tenders={[T('50000'), T('10000', 'upi')]} due="76735.00" onChange={onChange} />);
    expect(text('tender-total')).toContain('60,000.00');
    expect(text('tender-remaining')).toContain('16,735.00');
    cleanup();
    ui(<TenderEditor tenders={[T('80000')]} due="76735.00" onChange={onChange} />);
    expect(text('tender-overpayment')).toBe(en['sales.pay.issue.overpayment']);
  });
  it('"Rest" fills the row with the balance', () => {
    const onChange = vi.fn();
    ui(<TenderEditor tenders={[T('50000'), T('', 'upi')]} due="76735.00" onChange={onChange} />);
    fireEvent.click(nn(screen.getAllByRole('button', { name: en['sales.pay.rest'] })[1]));
    expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ amount: '50000' }), expect.objectContaining({ mode: 'upi', amount: '26735.00' })]);
  });
});

describe('print rendering: original vs duplicate', () => {
  it('first print is the original with no stamp; GST fields and amount in words are on it', () => {
    ui(<SalesPrintView doc={printDoc()} />);
    expect(text('doc-no')).toBe('INV-MAIN-2026-00001');
    expect(text('copy')).toBe(en['sales.print.original']);
    expect(screen.queryByTestId('stamp')).toBeNull();
    expect(text('doc-lines')).toContain('AB12CD');
    expect(text('doc-gst')).toContain('7113');
    expect(text('doc-words')).toContain('Seventy Six Thousand');
    expect(screen.getByTestId('sales-doc').getAttribute('data-paper')).toBe('A4');
  });
  it('a reprint is stamped DUPLICATE; a cancelled bill prints as a duplicate stamped CANCELLED; thermal paper is set', () => {
    ui(<SalesPrintView doc={printDoc({ copy: 'duplicate', stamp: 'DUPLICATE', print_no: 2, paper: 'thermal_80mm' })} />);
    expect(text('copy')).toBe(en['sales.print.duplicate']);
    expect(text('stamp')).toBe(en['sales.print.stamp.DUPLICATE']);
    expect(screen.getByTestId('sales-doc').getAttribute('data-paper')).toBe('thermal_80mm');
    cleanup();
    ui(<SalesPrintView doc={printDoc({ copy: 'duplicate', stamp: 'CANCELLED', doc_cancelled: true, document: invoice({ status: 'cancelled' }) })} />);
    expect(text('stamp')).toBe(en['sales.print.stamp.CANCELLED']);
  });
  it('first print: no reason asked; the server logs it (Idempotency-Key) and the browser print is called', async () => {
    const spy = vi.spyOn(printer, 'print').mockImplementation(() => undefined);
    replies = [{ status: 200, body: printDoc() }];
    ui(<PrintPanel doc="invoice" id="inv-1" printCount={0} defaultPaper="A5" />);
    expect(screen.queryByLabelText(en['sales.print.reprintReason'])).toBeNull();
    fireEvent.click(screen.getByTestId('print-button'));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(calls[0]?.url).toBe('/api/v1/sales/invoices/inv-1/prints');
    expect(calls[0]?.headers.get('Idempotency-Key')).toBeTruthy();
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ paper: 'A5', language: 'en', numerals: 'latin' });
  });
  it('a reprint needs sales.invoice.reprint and a 3–200 reason, which is sent', async () => {
    const spy = vi.spyOn(printer, 'print').mockImplementation(() => undefined);
    replies = [{ status: 200, body: printDoc({ copy: 'duplicate', stamp: 'DUPLICATE', print_no: 2 }) }];
    ui(<PrintPanel doc="invoice" id="inv-1" printCount={1} />);
    const btn = screen.getByTestId('print-button') as HTMLButtonElement;
    expect(btn.textContent).toContain(en['sales.print.duplicateButton']);
    expect(btn.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(en['sales.print.reprintReason']), { target: { value: 'Customer lost the copy' } });
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ paper: 'A4', reprint_reason: 'Customer lost the copy' });
    expect(await screen.findByTestId('stamp')).toBeTruthy();
    cleanup();
    ui(<PrintPanel doc="invoice" id="inv-1" printCount={1} />, ['sales.invoice.view']);
    fireEvent.change(screen.getByLabelText(en['sales.print.reprintReason']), { target: { value: 'Customer lost the copy' } });
    expect((screen.getByTestId('print-button') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(en['sales.print.noReprintPerm'])).toBeTruthy();
  });
});

describe('return, cancel and balance payment flows', () => {
  it('return: only lines not yet returned; reason 5–500; sends line_ids + refund mode from settings with a key', async () => {
    replies = [{ status: 201, body: {} }];
    ui(<ReturnForm inv={invoice()} settings={settings({ return_settlement_default: 'cash' })} />);
    expect(screen.queryByText(/RSP-02/)).toBeNull();
    const btn = screen.getByTestId('return-confirm') as HTMLButtonElement;
    fireEvent.click(screen.getByLabelText(/RSP-01/));
    fireEvent.change(screen.getByLabelText(en['sales.return.reason']), { target: { value: 'abc' } });
    expect(btn.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(en['sales.return.reason']), { target: { value: 'Size issue' } });
    fireEvent.click(btn);
    await waitFor(() => expect(calls.filter((c) => !c.url.includes('print-templates'))).toHaveLength(1));
    expect(calls[0]?.url).toBe('/api/v1/sales/invoices/inv-1/returns');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ line_ids: ['line-1'], reason: 'Size issue', refund_mode: 'cash' });
    expect(calls[0]?.headers.get('Idempotency-Key')).toBeTruthy();
  });
  it('return error 422 return_window_expired shows plain words', async () => {
    replies = [{ status: 422, body: { code: 'return_window_expired', title: 'x' } }];
    ui(<ReturnForm inv={invoice()} settings={settings()} />);
    fireEvent.click(screen.getByLabelText(/RSP-01/));
    fireEvent.change(screen.getByLabelText(en['sales.return.reason']), { target: { value: 'Size issue' } });
    fireEvent.click(screen.getByTestId('return-confirm'));
    expect(await screen.findByText(en['error.return_window_expired'])).toBeTruthy();
  });
  it('cancel: whole bill with reason and refund mode', async () => {
    replies = [{ status: 201, body: {} }];
    ui(<CancelForm inv={invoice()} settings={settings()} />);
    fireEvent.click(screen.getByText(en['sales.cancel.open']));
    fireEvent.change(screen.getByLabelText(en['sales.cancel.reason']), { target: { value: 'Billed by mistake' } });
    fireEvent.click(screen.getByTestId('cancel-confirm'));
    await waitFor(() => expect(calls.filter((c) => !c.url.includes('print-templates'))).toHaveLength(1));
    expect(calls[0]?.url).toBe('/api/v1/sales/invoices/inv-1/cancellation');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ reason: 'Billed by mistake', refund_mode: 'store_credit' });
  });
  it('balance payment posts tenders; 409 invoice_fully_paid is explained', async () => {
    replies = [{ status: 409, body: { code: 'invoice_fully_paid', title: 'x' } }];
    ui(<PayBalance inv={invoice()} />);
    fireEvent.click(screen.getByTestId('receive-button'));
    await waitFor(() => expect(calls.filter((c) => !c.url.includes('print-templates'))).toHaveLength(1));
    expect(calls[0]?.url).toBe('/api/v1/sales/invoices/inv-1/payments');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ tenders: [{ mode: 'cash', amount: '26735.00' }] });
    expect(await screen.findByText(en['error.invoice_fully_paid'])).toBeTruthy();
  });
});

describe('lists: filters and estimate convert', () => {
  it('bill filters go to the server; empty ones are left out', async () => {
    replies = [{ status: 200, body: { items: [], next_cursor: null } }, { status: 200, body: { items: [], next_cursor: null } }];
    ui(<InvoicesList />);
    await screen.findByTestId('bill-list-empty');
    fireEvent.change(screen.getByLabelText(en['sales.filter.payment']), { target: { value: 'part_paid' } });
    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(2));
    const last = new URL(`http://x${calls[calls.length - 1]?.url}`);
    expect(Object.fromEntries(last.searchParams)).toEqual({ limit: '50', payment_status: 'part_paid' });
  });
  it('picking estimates of two customers is refused; same customer converts to one bill', async () => {
    const row = (id: string, customer_id: string) => ({ id, estimate_no: `EST-MAIN-2026-0000${id}`, branch_id: BR, estimate_date: '2026-11-09', valid_until: '2026-11-09', status: 'draft', customer_id, customer_name: 'Lakshmi', net_payable: '1000.00', invoice_id: null, version: 1 });
    replies = [{ status: 200, body: { items: [row('1', CUST), row('2', CUST), row('3', 'other')], next_cursor: null } }];
    const router = routed(<EstimatesList />);
    const boxes = await screen.findAllByRole('checkbox');
    fireEvent.click(nn(boxes[0]));
    fireEvent.click(nn(boxes[2]));
    expect(text('merge-problem')).toBe(en['sales.estimates.merge.customer_mismatch']);
    expect((screen.getByTestId('convert-button') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(nn(boxes[2]));
    fireEvent.click(nn(boxes[1]));
    expect(screen.queryByTestId('merge-problem')).toBeNull();
    fireEvent.click(screen.getByTestId('convert-button'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/counter/bill'));
    expect(router.state.location.search).toEqual({ estimates: '1,2' });
  });
});

describe('billing not switched on', () => {
  it('settings 404 → friendly note, not an error', async () => {
    replies = [{ status: 404, body: { title: 'Not Found' } }];
    function Probe() { const s = useSalesSettings(); return s.off ? <SalesOff /> : <p>{s.isLoading ? 'loading' : 'other'}</p>; }
    ui(<Probe />);
    expect((await screen.findByTestId('sales-off')).textContent).toContain(en['sales.off.title']);
  });
});

describe('milestone 2: loose lines, restock, B2B customer', () => {
  const R = {
    items: [{ id: 'item-ring', name: 'Ring', code: 'RNG' }], purities: [{ id: 'p22', code: '22K' }],
    counters: [{ id: 'c1', name: 'Gold counter', branch_id: BR }, { id: 'c9', name: 'Other branch', branch_id: 'other' }],
    trays: [{ id: 't1', counter_id: 'c1', code: 'T1', name: 'Rings tray' }],
  };
  it('loose entry: checks before adding, then adds the line (net defaults to gross; counter limited to the branch)', () => {
    const onAdd = vi.fn();
    ui(<LooseEntry refs={R} branchId={BR} onAdd={onAdd} onClose={() => undefined} />);
    fireEvent.click(screen.getByTestId('loose-add'));
    expect(text('loose-issues')).toContain(en['sales.loose.issue.item']);
    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.queryByRole('option', { name: 'Other branch' })).toBeNull();
    fireEvent.change(screen.getByLabelText(en['sales.loose.item']), { target: { value: 'item-ring' } });
    fireEvent.change(screen.getByLabelText(en['sales.oldGold.purity']), { target: { value: 'p22' } });
    fireEvent.change(screen.getByLabelText(en['sales.loose.gross']), { target: { value: '4.5' } });
    fireEvent.change(screen.getByLabelText(en['sales.loose.counter']), { target: { value: 'c1' } });
    fireEvent.change(screen.getByLabelText(en['sales.loose.tray']), { target: { value: 't1' } });
    fireEvent.click(screen.getByTestId('loose-add'));
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ kind: 'loose', item_id: 'item-ring', purity_id: 'p22', gross_wt: '4.500', net_wt: '4.500', pieces: 1, counter_id: 'c1', tray_id: 't1' }));
  });
  it('409 insufficient_loose_stock is shown in plain words', () => {
    ui(<SalesError error={new ApiError(409, 'insufficient_loose_stock', 'x')} />);
    expect(text('sales-error')).toBe(en['error.insufficient_loose_stock']);
  });
  it('return sends the restock counter and tray when picked', async () => {
    refs = { '/v1/masters/counters': { items: R.counters.map((c) => ({ ...c, is_active: true })), next_cursor: null }, '/v1/masters/trays': { items: R.trays.map((x) => ({ ...x, is_active: true })), next_cursor: null } };
    replies = [{ status: 201, body: {} }];
    ui(<ReturnForm inv={invoice()} settings={settings()} />);
    fireEvent.click(screen.getByLabelText(/RSP-01/));
    fireEvent.change(screen.getByLabelText(en['sales.return.reason']), { target: { value: 'Size issue' } });
    await screen.findByRole('option', { name: 'Gold counter' });
    fireEvent.change(screen.getByLabelText(en['sales.restock.counter']), { target: { value: 'c1' } });
    await screen.findByRole('option', { name: 'Rings tray' });
    fireEvent.change(screen.getByLabelText(en['sales.restock.tray']), { target: { value: 't1' } });
    fireEvent.click(screen.getByTestId('return-confirm'));
    await waitFor(() => expect(calls.filter((c) => !c.url.includes('print-templates'))).toHaveLength(1));
    expect(JSON.parse(calls[0]?.body ?? '{}')).toMatchObject({ line_ids: ['line-1'], restock: { counter_id: 'c1', tray_id: 't1' } });
  });
  it('cancel leaves restock out when nothing is picked (server default: where it was sold from)', async () => {
    replies = [{ status: 201, body: {} }];
    ui(<CancelForm inv={invoice()} settings={settings()} />);
    fireEvent.click(screen.getByText(en['sales.cancel.open']));
    expect(screen.getByLabelText(en['sales.restock.counter'])).toBeTruthy();
    fireEvent.change(screen.getByLabelText(en['sales.cancel.reason']), { target: { value: 'Billed by mistake' } });
    fireEvent.click(screen.getByTestId('cancel-confirm'));
    await waitFor(() => expect(calls.filter((c) => !c.url.includes('print-templates'))).toHaveLength(1));
    expect(JSON.parse(calls[0]?.body ?? '{}')).not.toHaveProperty('restock');
  });
  it('new business customer: GSTIN fills the state; a bad GSTIN cannot be used', () => {
    const onChange = vi.fn();
    ui(<CustomerPicker value={{ kind: 'none' }} onChange={onChange} />);
    fireEvent.click(screen.getByText(en['sales.customer.addNew']));
    fireEvent.change(screen.getByLabelText(en['sales.customer.name']), { target: { value: 'Meena Traders' } });
    fireEvent.change(screen.getByLabelText(en['sales.customer.mobile']), { target: { value: '9840000002' } });
    fireEvent.change(screen.getByLabelText(en['sales.customer.gstinOptional']), { target: { value: '29ABCDE1234' } });
    const use = screen.getByText(en['sales.customer.useNew']).closest('button') as HTMLButtonElement;
    expect(use.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(en['sales.customer.gstinOptional']), { target: { value: '29abcde1234f1z5' } });
    expect((screen.getByLabelText(en['sales.customer.state']) as HTMLInputElement).value).toBe('29');
    fireEvent.click(use);
    expect(onChange).toHaveBeenCalledWith({ kind: 'new', name: 'Meena Traders', phone: '9840000002', gstin: '29abcde1234f1z5', state_code: '29' });
  });
});


describe('0.9.2 settings', () => {
  it('only writable changed fields go to PATCH; money is 2 dp, null clears making rate and version 0 is retained', () => {
    const d = settingsDraft(settings());
    expect(settingsIssues(d)).toEqual([]);
    expect(settingsPatch(settings(), { ...d, making_service_rate: '18', cash_limit_amount: '250000' })).toEqual({ making_service_rate: '18.00', cash_limit_amount: '250000.00' });
    expect(settingsPatch(settings({ making_service_rate: '18.00' }), d)).toEqual({ making_service_rate: null });
    expect(settingsIssues({ ...d, large_discount_pct: '20' })).toContain('large_discount_pct');
    expect(settingsIssues({ ...d, making_service_rate: '1.01' })).toContain('making_service_rate');
    expect(settingsIssues({ ...d, return_window_days: '-1' })).toContain('return_window_days');
    expect(settingsIssues({ ...d, estimate_no_format: 'EST-{NOPE}' })).toContain('estimate_no_format');
    expect(settingsRoute('/v1/sales/settings')).toBe('/sales/settings');
    expect(settingsRoute('https://bad.example')).toBe('/sales/settings');
  });
  it('first save sends If-Match 0 and replaces settings caches from the complete PATCH response', async () => {
    const qc = client(['sales.settings.edit']);
    const initial = settings(); const updated = settings({ version: 1, making_service_rate: '18.00', cash_limit_amount: '99999.00' });
    qc.setQueryData(salesKeys.settings(), initial); qc.setQueryData(salesKeys.settings(BR), initial);
    replies = [{ status: 200, body: updated }];
    render(<QueryClientProvider client={qc}><I18nProvider initial="en-IN"><SalesSettingsForm value={initial} /></I18nProvider></QueryClientProvider>);
    fireEvent.change(screen.getByLabelText(en['sales.settings.making_service_rate']), { target: { value: '18' } });
    fireEvent.click(screen.getByTestId('settings-save'));
    await waitFor(() => expect(qc.getQueryData(salesKeys.settings())).toEqual(updated));
    expect(qc.getQueryData(salesKeys.settings(BR))).toEqual(updated);
    expect(calls[0]).toMatchObject({ method: 'PATCH', url: '/api/v1/sales/settings' });
    expect(calls[0]?.headers.get('If-Match')).toBe('"0"');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ making_service_rate: '18.00' });
  });
  it('412 preserves unsaved input and disables overwrite until the owner reloads the newer version', async () => {
    const qc = client(['sales.settings.edit']); qc.setQueryData(salesKeys.settings(), settings());
    replies = [{ status: 412, body: { code: 'version_mismatch', title: 'Changed' } }, { status: 200, body: settings({ version: 3, making_service_rate: '5.00' }) }];
    render(<QueryClientProvider client={qc}><I18nProvider initial="en-IN"><SalesSettingsBody /></I18nProvider></QueryClientProvider>);
    fireEvent.change(screen.getByLabelText(en['sales.settings.making_service_rate']), { target: { value: '18' } });
    fireEvent.click(screen.getByTestId('settings-save'));
    await screen.findByTestId('settings-conflict');
    expect((screen.getByTestId('settings-save') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText(en['sales.settings.making_service_rate']) as HTMLInputElement).value).toBe('18');
    fireEvent.click(screen.getByRole('button', { name: en['sales.settings.reload'] }));
    await waitFor(() => expect((screen.getByLabelText(en['sales.settings.making_service_rate']) as HTMLInputElement).value).toBe('5.00'));
    expect(screen.queryByTestId('settings-conflict')).toBeNull();
  });
  it('non-owner cannot edit settings; settings endpoint 404 still shows not switched on', async () => {
    const qc = client(['sales.settings.edit']); qc.setQueryData(sessionQueryOptions.queryKey, { user: { id: 'u' }, roles: [{ role: 'manager' }], permissions: ['sales.settings.edit'] });
    qc.setQueryData(salesKeys.settings(), settings());
    render(<QueryClientProvider client={qc}><I18nProvider initial="en-IN"><SalesSettingsBody /></I18nProvider></QueryClientProvider>);
    expect(screen.queryByTestId('settings-save')).toBeNull(); expect(screen.getByText(en['sales.settings.ownerOnly'])).toBeTruthy();
    cleanup(); replies = [{ status: 404, body: { title: 'Not found' } }];
    ui(<SalesSettingsBody />, ['sales.settings.edit']);
    await screen.findByTestId('sales-off');
  });
  it('readiness and making-rate refusal links map settings_path to our new screen', async () => {
    routed(<MakingRateNote canFix path="/v1/sales/settings" />);
    expect((await screen.findByRole('link', { name: en['sales.gate.openRules'] })).getAttribute('href')).toBe('/sales/settings');
  });
});

const receipt092 = (over: Partial<PaymentReceipt> = {}): PaymentReceipt => ({
  id: 'r-1', receipt_no: 'RCT-00001', invoice_id: 'inv-1', invoice_no: 'INV-01', branch_id: BR, customer_id: CUST,
  received_on: '2026-11-09', received_at: '2026-11-09T13:00:00Z', received_by: 'u', tenders: [], total: '1000.00', adjusted_balance_due_after: '5000.00', balance_due_after: '5000.00', note: null,
  reverses_receipt_id: null, reversed_by_receipt_id: null, reversal_reason: null, ...over,
});
describe('0.9.2 payment reversal', () => {
  it('reason 5–200, explicit confirmation, Idempotency-Key and resulting store credit link', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const note = creditNote({ kind: 'receipt_reversal', total: '0.00', store_credit_amount: '500.00' });
    replies = [{ status: 201, body: { reversal: receipt092({ id: 'r-rev', total: '-1000.00', reverses_receipt_id: 'r-1' }), store_credit_note: note } }];
    routed(<ReversePayment invoiceId="inv-1" receipt={receipt092()} />);
    fireEvent.click(await screen.findByRole('button', { name: en['sales.reversal.open'] }));
    expect((screen.getByTestId('reverse-confirm') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(en['sales.reversal.reason']), { target: { value: ' Wrong payment ' } });
    fireEvent.click(screen.getByTestId('reverse-confirm')); expect(confirm).toHaveBeenCalled(); expect(calls).toHaveLength(0);
    confirm.mockReturnValue(true); fireEvent.click(screen.getByTestId('reverse-confirm'));
    await screen.findByTestId('reversal-credit');
    expect(calls[0]).toMatchObject({ method: 'POST', url: '/api/v1/sales/invoices/inv-1/payments/r-1/reversal' });
    expect(calls[0]?.headers.get('Idempotency-Key')).toBeTruthy();
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ reason: 'Wrong payment' });
    expect(text('reversal-credit')).toContain('500.00');
  });
  it('receipt action requires sales.receipt.reverse and is absent on a reversal or already-reversed receipt', async () => {
    const body = { ...invoice(), receipts: [receipt092()] };
    replies = [{ status: 200, body }]; routed(<Receipts inv={invoice()} />, ALL);
    await screen.findByTestId('receipt'); expect(screen.queryByTestId('reverse-payment')).toBeNull(); cleanup();
    replies = [{ status: 200, body: { ...body, receipts: [receipt092({ reversed_by_receipt_id: 'r2' }), receipt092({ id: 'r2', reverses_receipt_id: 'r-1' })] } }];
    routed(<Receipts inv={invoice()} />, [...ALL, 'sales.receipt.reverse']);
    await waitFor(() => expect(screen.getAllByTestId('receipt')).toHaveLength(2));
    expect(screen.queryByTestId('reverse-payment')).toBeNull();
    expect(screen.getByText(en['sales.creditNote.kind.receipt_reversal'], { exact: false })).toBeTruthy();
  });
  it('Payment reversed is a kind filter, amount is store credit given back, and GST/CDN exclusion is explicit', async () => {
    const n = creditNote({ kind: 'receipt_reversal', total: '0.00', store_credit_amount: '500.00' });
    expect(creditNoteAmount(n)).toBe('500.00'); expect(isGstCreditNote(n)).toBe(false); expect(isGstCreditNote(creditNote())).toBe(true);
    expect(SALES_ALERT_LABELS['alert.receipt_reversal']).toBe('sales.creditNote.kind.receipt_reversal');
    replies = [{ status: 200, body: { items: [n], next_cursor: null } }, { status: 200, body: { items: [n], next_cursor: null } }];
    routed(<CreditNotesList />); await screen.findByTestId('credit-note-list');
    expect(text('credit-note-list')).toContain('Payment reversed'); expect(text('credit-note-list')).toContain('500.00');
    fireEvent.change(screen.getByLabelText(en['sales.creditNotes.kind']), { target: { value: 'receipt_reversal' } });
    await waitFor(() => expect(calls.some((c) => c.url.includes('kind=receipt_reversal'))).toBe(true));
  });
});
describe('0.9.2 printing and refusals', () => {
  it('estimate duplicate needs a reason but not the invoice reprint permission', async () => {
    replies = [{ status: 200, body: printDoc({ doc_type: 'estimate', copy: 'duplicate', document: estimate() }) }];
    vi.spyOn(printer, 'print').mockImplementation(() => undefined);
    ui(<PrintPanel doc="estimate" id="est-1" printCount={2} />, ['sales.estimate.create']);
    expect((screen.getByTestId('print-button') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(en['sales.print.reprintReason']), { target: { value: 'Customer copy' } });
    fireEvent.click(screen.getByTestId('print-button'));
    await waitFor(() => expect(calls.filter((c) => !c.url.includes('print-templates'))).toHaveLength(1));
    expect(JSON.parse(calls[0]?.body ?? '{}')).toMatchObject({ reprint_reason: 'Customer copy' });
  });
  it('history converts RFC3339 to IST; a cancelled never-printed bill prints copy 1 as DUPLICATE / CANCELLED', async () => {
    ui(<PrintHistory count={2} last="2026-11-09T13:00:00Z" />);
    expect(text('print-history')).toContain('2'); expect(text('print-history')).toContain('18:30 IST'); cleanup();
    replies = [{ status: 201, body: printDoc({ copy: 'duplicate', doc_cancelled: true, stamp: 'CANCELLED', print_no: 1, document: invoice({ status: 'cancelled' }) }) }];
    const print = vi.spyOn(printer, 'print').mockImplementation(() => undefined);
    ui(<PrintPanel doc="invoice" id="inv-1" printCount={0} cancelled />);
    expect((screen.getByTestId('print-button') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(en['sales.print.reprintReason']), { target: { value: 'Cancelled copy' } });
    fireEvent.click(screen.getByTestId('print-button'));
    await waitFor(() => expect(print).toHaveBeenCalledOnce());
    expect(text('copy')).toBe(en['sales.print.duplicate']); expect(text('stamp')).toBe(en['sales.print.stamp.CANCELLED']);
    expect(JSON.parse(calls[0]?.body ?? '{}')).toMatchObject({ reprint_reason: 'Cancelled copy' });
  });
  it('loose zero pieces stay genuine and a bad line can still have its piece count corrected', () => {
    const line = nn(looseToDraft({ ...emptyLoose(), item_id: 'i', purity_id: 'p', gross_wt: '1', pieces: '0' }, 'k'));
    expect(line.pieces).toBe(0);
    const onPieces = vi.fn();
    ui(<LinesTable lines={[line]} pricedFor={() => null} badLine={0} onRemove={() => undefined} discount={null} itemName={() => 'Ring'} purityCode={() => '22K'} onPieces={onPieces} />);
    fireEvent.change(screen.getByLabelText(en['sales.loose.pieces']), { target: { value: '2' } }); expect(onPieces).toHaveBeenCalledWith('k', 2);
    expect(screen.getByTestId('bill-line').className).toContain('bg-destructive/10');
  });
  it('the making floor is the server preview amount, never net weight times the configured rate', () => {
    const line = { key: 'k', kind: 'tag' as const, tag_id: 't', tag_no: 'T' };
    const p = { ...nn(invoice().lines[0]), mc_type: 'per_gram' as const, mc_value: '10.00', net_wt: '1.000', mc_amount: '100.00' };
    ui(<LinesTable lines={[line]} pricedFor={() => p} badLine={null} onRemove={() => undefined} discount={null} itemName={() => 'Ring'} purityCode={() => '22K'} />);
    expect(text('bill-line')).toContain('₹100.00');
    expect(text('bill-line')).not.toContain('₹10.00');
  });
});

describe('QA non-blocking FE corrections', () => {
  it('N2: salesperson choices require the flag, active status and the current branch (or a shared staff record)', () => {
    const staff = { is_salesperson: true, is_active: true, branch_id: BR };
    expect(eligibleSalesperson(staff, BR)).toBe(true);
    expect(eligibleSalesperson({ ...staff, branch_id: null }, BR)).toBe(true);
    expect(eligibleSalesperson({ ...staff, branch_id: 'other' }, BR)).toBe(false);
    expect(eligibleSalesperson({ ...staff, is_salesperson: false }, BR)).toBe(false);
    expect(eligibleSalesperson({ ...staff, is_active: false }, BR)).toBe(false);
  });
  it('N3: cash messages describe the shop limit, not complete statutory compliance; owner sees the bill-only scope in en/ta', () => {
    ui(<SalesSettingsForm value={settings()} />, ['sales.settings.edit']);
    expect(text('sales-cash-scope')).toBe(en['sales.cash.scope']);
    expect(text('sales-cash-scope')).toContain('one bill only');
    expect(en['error.cash_limit_exceeded']).toContain('shop');
    expect(en['sales.block.cash_limit']).not.toMatch(/the law|legal/);
    cleanup();
    render(<QueryClientProvider client={client(['sales.settings.edit'])}><I18nProvider initial="ta-IN"><SalesSettingsForm value={settings()} /></I18nProvider></QueryClientProvider>);
    expect(text('sales-cash-scope')).toBe(ta['sales.cash.scope']);
    expect(ta['sales.block.cash_limit']).toContain('கடையின் வரம்பு');
  });
  it('N4: receipt balance is explicitly adjusted for later returns, never labelled as an immutable as-at receipt balance', async () => {
    const qc = client(ALL);
    replies = [
      { status: 200, body: { ...invoice(), receipts: [receipt092()] } },
      { status: 200, body: { ...invoice(), receipts: [receipt092({ adjusted_balance_due_after: '4000.00', balance_due_after: '9999.00' })] } },
    ];
    render(<QueryClientProvider client={qc}><I18nProvider initial="en-IN"><Receipts inv={invoice()} /></I18nProvider></QueryClientProvider>);
    expect((await screen.findByTestId('receipt-adjusted-balance')).textContent).toContain('later returns: ₹5,000.00');
    await qc.invalidateQueries({ queryKey: salesKeys.payments('inv-1') });
    await waitFor(() => expect(text('receipt-adjusted-balance')).toContain('later returns: ₹4,000.00'));
    expect(text('receipt')).toContain('RCT-00001');
  });
  it('N5: shows the server’s component-rounded 102.70, not a client-recomputed combined-line 102.69; explains the rounding unit', () => {
    const c = computation(); const summary = nn(c.tax_summary[0]);
    ui(<GstBreakup c={computation({ tax_summary: [{ ...summary, taxable_value: '6846.00', cgst: '102.70', sgst: '102.70' }] })} />);
    expect(text('gst-breakup')).toContain('₹102.70'); expect(text('gst-breakup')).not.toContain('102.69');
    expect(text('gst-rounding-note')).toBe(en['sales.gst.roundingNote']);
  });
});


it('N2 rendered effect clears a remembered salesperson removed from eligibility and does not restore it when options return',async()=>{
 const qc=client(ALL),key=['sales','salespeople',''];const rows=[{id:'stale-staff',name:'Previously eligible'}];
 qc.setQueryData(key,rows);rememberedSalesperson.set('stale-staff');
 try{
  const root=createRootRoute({component:()=><BillScreen mode="bill" settings={settings()} estimateIds={[]} />});const router=createRouter({routeTree:root,history:createMemoryHistory({initialEntries:['/']})});
  render(<QueryClientProvider client={qc}><I18nProvider initial="en-IN"><RouterProvider router={router}/></I18nProvider></QueryClientProvider>);
  const select=await screen.findByLabelText(en['sales.salesperson.label']) as HTMLSelectElement;await waitFor(()=>expect(select.value).toBe('stale-staff'));
  await act(async()=>{qc.setQueryData(key,[]);});await waitFor(()=>expect(screen.queryByRole('option',{name:'Previously eligible'})).toBeNull());
  await act(async()=>{qc.setQueryData(key,rows);});await screen.findByRole('option',{name:'Previously eligible'});expect(select.value).toBe('');
 }finally{rememberedSalesperson.set('');}
});
