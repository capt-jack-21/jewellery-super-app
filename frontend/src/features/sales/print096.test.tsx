/** Contract 0.9.6 (fd3307b4 / 04f43a42…): fallback + re-pin provenance, pinned-template recovery, 422/403 messages, tag_label exemption. */
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { I18nProvider } from '@/i18n';
import en from '@/i18n/messages/en-IN.json';
import ta from '@/i18n/messages/ta-IN.json';
import { sessionQueryOptions } from '@/lib/session';
import { getListPrintTemplatesQueryKey } from '@/lib/api/backend/branding/branding';
import type { PaymentReceipt, PaymentReceiptPrintSnapshot, SalesPrintDocument } from '@/lib/api/backend/model';
import { PrintTemplatesManager } from '@/features/settings/print-templates';
import { LabelPrintPage } from '@/features/inventory/labels';
import { creditNote, estimate, invoice, printDoc, templateRow } from './fixtures';
import { PrintPanel, printer } from './print';
import { recovery096, templateNotice096 } from './repin096';
import { ApiError } from '@/lib/api/fetcher';
vi.mock('@/components/print-preview', () => ({ PrintPreview: () => <div data-testid="preview-stub" /> }));

const PIN = { invoice: '01a1c455-29fa-769b-84f9-377a9bcdab46', estimate: '01a1c455-29fa-7963-88e9-d3cf6e2a8240', credit_note: '01a1c455-29fa-7856-b4ed-a3710fd91ec1', payment_receipt: '01a1c455-29fa-7811-b4b1-95efbd5b9ea5' } as const;
const CUSTOM = { template_id: '11111111-1111-4111-8111-111111111111', template_version: 99 };
type Kind = keyof typeof PIN;
const KINDS: Kind[] = ['invoice', 'estimate', 'credit_note', 'payment_receipt'];

function receiptParts() {
  const inv = invoice();
  const snapshot: PaymentReceiptPrintSnapshot = { id: 'r1', receipt_no: 'RCT-001', invoice_id: inv.id, invoice_no: inv.doc_no, invoice_date: inv.doc_date, branch_id: inv.branch_id, customer_id: inv.customer.customer_id ?? 'customer-1', customer: inv.customer, seller: inv.seller, received_on: inv.doc_date, received_at: '2026-11-10T03:00:00Z', received_by: 'u', tenders: [{ line_no: 1, mode: 'upi', amount: '100.00', reference: 'UPI123', payment_mode_id: null, card_machine_id: null, cheque_date: null, bank_name: null, credit_note_id: null }], total: '100.00', adjusted_balance_due_at_issue: '50.00', note: null, reverses_receipt_id: null, reversal_reason: null, kind: 'collection' };
  const document: PaymentReceipt = { ...snapshot, balance_due_after: '50.00', adjusted_balance_due_after: '50.00', reversed_by_receipt_id: null };
  return { snapshot, document };
}
/** A logged print of `kind` on its platform pin. */
function doc(kind: Kind, over: Partial<SalesPrintDocument> = {}): SalesPrintDocument {
  const dup = over.copy === 'duplicate';
  const base = { template_id: PIN[kind], template_version: 1, print_no: dup ? 2 : 1, stamp: dup ? 'DUPLICATE' : kind === 'estimate' ? 'ESTIMATE' : null } as Partial<SalesPrintDocument>;
  if (kind === 'invoice') return printDoc({ ...base, ...over });
  if (kind === 'estimate') { const e = estimate({ print_count: 0 }); return printDoc({ doc_type: 'estimate', document: e, snapshot: e, ...base, ...over } as Partial<SalesPrintDocument>); }
  if (kind === 'credit_note') { const c = cn(); return printDoc({ doc_type: 'credit_note', document: c, snapshot: c, ...base, ...over } as Partial<SalesPrintDocument>); }
  const { snapshot, document } = receiptParts();
  return { ...printDoc(), doc_type: 'payment_receipt', doc_id: 'r1', doc_no: 'RCT-001', amount_in_words: 'Rupees One Hundred Only', snapshot, document, ...base, ...over } as SalesPrintDocument;
}
const cn = () => { const i = invoice(), l = i.lines[0]; if (!l) throw new Error('fixture'); return creditNote({ lines: [{ ...l, invoice_line_id: l.id }], original_invoice: { ...i, invoice_total: i.totals.invoice_total, lines: i.lines }, tax_summary: i.tax_summary, taxable_value: l.taxable_value, cgst: l.cgst, sgst: l.sgst, igst: l.igst }); };
const panel = (kind: Kind, printCount: number | undefined = 0) => kind === 'payment_receipt'
  ? <PrintPanel doc="payment_receipt" id="r1" invoiceId="inv-1" printCount={undefined} />
  : <PrintPanel doc={kind} id={`${kind}-1`} printCount={printCount} />;

let replies: Array<{ status: number; body: unknown }> = [];
const calls: { url: string; method: string; body: Record<string, unknown> }[] = [];
function mount(node: ReactNode, locale: 'en-IN' | 'ta-IN' = 'en-IN', permissions = ['sales.invoice.view', 'sales.invoice.reprint', 'platform.settings.edit', 'inventory.tag.print_label'], qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } })) {
  qc.setQueryData(sessionQueryOptions.queryKey, { user: { id: 'u', name: 'Owner', version: 1 }, roles: [{ role: 'owner' }], permissions });
  return render(<QueryClientProvider client={qc}><I18nProvider initial={locale}>{node}</I18nProvider></QueryClientProvider>);
}
beforeEach(() => {
  replies = []; calls.length = 0;
  vi.spyOn(printer, 'prepare').mockResolvedValue(undefined); vi.spyOn(printer, 'print').mockImplementation(() => undefined);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET', body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    const consume = (init?.method ?? 'GET') !== 'GET' || String(input).includes('print-templates');
    const r = (consume ? replies.shift() : undefined) ?? { status: 404, body: { code: 'not_found' } };
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': r.status < 300 ? 'application/json' : 'application/problem+json' } });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const recoveryProblem = (kind: Kind, over: Record<string, unknown> = {}) => ({ code: 'pinned_print_template_unavailable', title: 'Unprocessable', errors: [{ path: 'copy', message: 'duplicate required' }], unrenderable_template: CUSTOM,
  recovery: { copy: 'duplicate', reprint_reason_required: true, permission: 'sales.invoice.reprint', repin_to: { template_id: PIN[kind], template_version: 1 }, ...over } });

/* ---------------- fallback (first print) ---------------- */
for (const locale of ['en-IN', 'ta-IN'] as const) for (const kind of KINDS) it(`fallback ${kind} (${locale}): first print on the platform default shows the visible platform-template note and prints`, async () => {
  const m = locale === 'en-IN' ? en : ta;
  replies = [{ status: 200, body: doc(kind, { template_fallback_from: CUSTOM }) }];
  mount(panel(kind), locale); fireEvent.click(screen.getByTestId('print-button'));
  await waitFor(() => expect(printer.print).toHaveBeenCalledOnce());
  expect(screen.getByTestId('print-fallback-note').textContent).toBe(m['sales.print.fallbackNote'].replace('{id}', CUSTOM.template_id).replace('{version}', '99'));
  expect(screen.queryByTestId('print-repinned-note')).toBeNull();
  expect(screen.getByTestId(kind === 'payment_receipt' ? 'receipt-doc' : 'sales-doc').dataset.templateId).toBe(PIN[kind]);
});
it('fallback/re-pin provenance fails closed when inconsistent; null fields mean no note', () => {
  const ok = (d: SalesPrintDocument) => { try { return templateNotice096(d); } catch (e) { return (e as ApiError).code; } };
  expect(ok(doc('invoice'))).toBeNull();
  expect(ok(doc('invoice', { template_fallback_from: CUSTOM, print_no: 2, copy: 'duplicate' }))).toBe('print_template_repin_invalid'); // reprints never fall back
  expect(ok(doc('invoice', { template_fallback_from: CUSTOM, template_id: CUSTOM.template_id }))).toBe('print_template_repin_invalid'); // must be the platform pin
  expect(ok(doc('invoice', { template_fallback_from: CUSTOM, template_id: PIN.estimate }))).toBe('print_template_repin_invalid'); // of its own doc type
  expect(ok(doc('invoice', { copy: 'duplicate', template_repinned: true, repinned_from: CUSTOM, template_fallback_from: CUSTOM }))).toBe('print_template_repin_invalid'); // never both
  expect(ok(doc('invoice', { copy: 'duplicate', template_repinned: false, repinned_from: CUSTOM }))).toBe('print_template_repin_invalid'); // flag/field disagree
  expect(ok(doc('invoice', { copy: 'duplicate', template_repinned: true, repinned_from: CUSTOM }))).toEqual({ kind: 'repinned', from: CUSTOM });
  expect(ok(doc('payment_receipt', { template_fallback_from: CUSTOM }))).toEqual({ kind: 'fallback', from: CUSTOM });
});
it('inconsistent fallback in a print response shows a clean error and never prints', async () => {
  replies = [{ status: 200, body: doc('invoice', { template_fallback_from: CUSTOM, template_id: CUSTOM.template_id }) }];
  mount(panel('invoice')); fireEvent.click(screen.getByTestId('print-button'));
  expect(await screen.findByText(en['error.print_template_repin_invalid'])).toBeTruthy(); expect(printer.print).not.toHaveBeenCalled();
});

/* ---------------- recovery: 422 pinned_print_template_unavailable → reasoned duplicate re-pinned ---------------- */
for (const locale of ['en-IN', 'ta-IN'] as const) for (const kind of KINDS) it(`recovery ${kind} (${locale}): offers Print duplicate with a required reason, sends copy=duplicate + reason, renders repin_to and shows the re-pinned note`, async () => {
  const m = locale === 'en-IN' ? en : ta;
  replies = [{ status: 422, body: recoveryProblem(kind) }, { status: 200, body: doc(kind, { copy: 'duplicate', template_repinned: true, repinned_from: CUSTOM }) }];
  mount(panel(kind, 1), locale);
  if (kind !== 'payment_receipt') fireEvent.change(screen.getByLabelText(m['sales.print.reprintReason']), { target: { value: 'Shop copy' } });
  fireEvent.click(screen.getByTestId('print-button'));
  expect((await screen.findByTestId('print-recovery')).textContent).toBe(m['sales.print.recovery']);
  expect(screen.getByText(m['error.pinned_print_template_unavailable'])).toBeTruthy(); expect(printer.print).not.toHaveBeenCalled();
  expect((screen.getByTestId('sales-print-copy') as HTMLSelectElement).value).toBe('duplicate');
  expect(screen.getByTestId('print-button').textContent).toContain(m['sales.print.duplicateButton']);
  fireEvent.change(screen.getByLabelText(m['sales.print.reprintReason']), { target: { value: '' } });
  expect((screen.getByTestId('print-button') as HTMLButtonElement).disabled).toBe(true); // reason required
  fireEvent.change(screen.getByLabelText(m['sales.print.reprintReason']), { target: { value: 'Original template retired' } });
  fireEvent.click(screen.getByTestId('print-button'));
  await waitFor(() => expect(printer.print).toHaveBeenCalledOnce());
  expect(calls[1]?.body).toMatchObject({ copy: 'duplicate', reprint_reason: 'Original template retired' });
  expect(screen.getByTestId(kind === 'payment_receipt' ? 'receipt-doc' : 'sales-doc').dataset.templateId).toBe(PIN[kind]);
  expect(screen.getByTestId('print-repinned-note').textContent).toBe(m['sales.print.repinnedNote'].replace('{id}', CUSTOM.template_id).replace('{version}', '99'));
  expect(screen.queryByTestId('print-recovery')).toBeNull();
});
for (const locale of ['en-IN', 'ta-IN'] as const) it(`recovery without sales.invoice.reprint (${locale}) explains instead of offering the duplicate (estimate too)`, async () => {
  const m = locale === 'en-IN' ? en : ta;
  replies = [{ status: 422, body: recoveryProblem('estimate') }];
  mount(panel('estimate', 1), locale, ['sales.invoice.view']);
  fireEvent.change(screen.getByLabelText(m['sales.print.reprintReason']), { target: { value: 'Shop copy' } });
  fireEvent.click(screen.getByTestId('print-button'));
  expect((await screen.findByTestId('print-recovery-no-perm')).textContent).toBe(m['sales.print.recoveryNoPerm']);
  fireEvent.change(screen.getByLabelText(m['sales.print.reprintReason']), { target: { value: 'Original template retired' } });
  expect((screen.getByTestId('print-button') as HTMLButtonElement).disabled).toBe(true); expect(calls).toHaveLength(1);
});
for (const [name, over] of [['repin_to of another doc type', { repin_to: { template_id: PIN.estimate, template_version: 1 } }], ['repin_to not v1', { repin_to: { template_id: PIN.invoice, template_version: 2 } }],
  ['repin_to unknown uuid', { repin_to: CUSTOM }], ['reason not required', { reprint_reason_required: false }], ['wrong permission', { permission: 'sales.invoice.view' }], ['copy auto', { copy: 'auto' }]] as const)
  it(`recovery fails closed: ${name}`, async () => {
    expect(recovery096(new ApiError(422, 'pinned_print_template_unavailable', 'x', undefined, [], undefined, recoveryProblem('invoice', over)), 'invoice')).toBe('invalid');
    replies = [{ status: 422, body: recoveryProblem('invoice', over) }];
    mount(panel('invoice', 1)); fireEvent.change(screen.getByLabelText(en['sales.print.reprintReason']), { target: { value: 'Shop copy' } }); fireEvent.click(screen.getByTestId('print-button'));
    expect(await screen.findByTestId('print-recovery-invalid')).toBeTruthy(); expect(screen.queryByTestId('print-recovery')).toBeNull(); expect(printer.print).not.toHaveBeenCalled();
  });
it('recovery: no recovery body → plain message only; non-422 / other codes ignored', () => {
  expect(recovery096(new ApiError(422, 'pinned_print_template_unavailable', 'x'), 'invoice')).toBeNull();
  expect(recovery096(new ApiError(403, 'reprint_not_allowed', 'x', undefined, [], undefined, recoveryProblem('invoice')), 'invoice')).toBeNull();
  expect(recovery096(new ApiError(422, 'pinned_print_template_unavailable', 'x', undefined, [], undefined, recoveryProblem('payment_receipt')), 'payment_receipt')).toEqual({ template_id: PIN.payment_receipt, template_version: 1 });
});
it('recovery: a duplicate that does not come back re-pinned to repin_to fails closed', async () => {
  replies = [{ status: 422, body: recoveryProblem('invoice') }, { status: 200, body: doc('invoice', { copy: 'duplicate' }) }];
  mount(panel('invoice', 1)); fireEvent.change(screen.getByLabelText(en['sales.print.reprintReason']), { target: { value: 'Shop copy' } }); fireEvent.click(screen.getByTestId('print-button'));
  await screen.findByTestId('print-recovery'); fireEvent.click(screen.getByTestId('print-button'));
  expect(await screen.findByText(en['error.print_template_repin_invalid'])).toBeTruthy(); expect(printer.print).not.toHaveBeenCalled();
});

/* ---------------- 403 / 422 messages ---------------- */
for (const locale of ['en-IN', 'ta-IN'] as const) for (const kind of KINDS) it(`${kind} 403 reprint_not_allowed and 422 print_template_not_renderable show clean ${locale} messages`, async () => {
  const m = locale === 'en-IN' ? en : ta;
  replies = [{ status: 403, body: { code: 'reprint_not_allowed', title: 'Forbidden', detail: 'raw' } }];
  mount(panel(kind, 1), locale);
  if (kind !== 'payment_receipt') fireEvent.change(screen.getByLabelText(m['sales.print.reprintReason']), { target: { value: 'Shop copy' } });
  fireEvent.click(screen.getByTestId('print-button'));
  expect(await screen.findByText(m['error.reprint_not_allowed'])).toBeTruthy(); expect(screen.queryByText('raw')).toBeNull();
  cleanup(); replies = [{ status: 422, body: { code: 'print_template_not_renderable', title: 'Unprocessable', unrenderable_template: CUSTOM } }];
  mount(panel(kind), locale); fireEvent.click(screen.getByTestId('print-button'));
  expect(await screen.findByText(m['error.print_template_not_renderable'])).toBeTruthy(); expect(printer.print).not.toHaveBeenCalled();
});

/* ---------------- Settings: renderable display; tag_label exempt ---------------- */
function settingsWith(rows: unknown[]) { const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } }); qc.setQueryData(getListPrintTemplatesQueryKey(), rows); return qc; }
const tagRow = (over: Record<string, unknown> = {}) => ({ ...templateRow(), id: 'tag-1', doc_type: 'tag_label', paper: 'label', body_key: 'labels/qr.hbs', print_language: 'en', scope: 'tenant', read_only: false, is_active: false, renderable: true, config: { barcode_format: 'qr' }, ...over });
it('Settings shows server renderable read-only; Sales rows have no activate; tag_label rows keep activate with row_version If-Match', async () => {
  const qc = settingsWith([{ ...templateRow(), id: 'sales-custom', doc_type: 'invoice', is_active: false, renderable: false, print_language: 'en' }, tagRow()]);
  replies = [{ status: 200, body: tagRow({ is_active: true }) }, { status: 200, body: [] }];
  mount(<PrintTemplatesManager />, 'en-IN', undefined, qc);
  expect(screen.getAllByTestId('print-renderable').map((e) => e.textContent)).toEqual([en['print.renderable.no'], en['print.renderable.yes']]);
  expect(screen.getAllByTestId('tag-label-activate')).toHaveLength(1);
  fireEvent.click(screen.getByTestId('tag-label-activate'));
  await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
  const post = calls.find((c) => c.method === 'POST'); expect(post?.url).toBe('/api/v1/print-templates/tag-1/activate');
});
it('Settings tag_label create is unchanged: POST doc_type tag_label with the typed key; no Sales doc type can be created', async () => {
  replies = [{ status: 201, body: tagRow() }, { status: 200, body: [] }];
  mount(<PrintTemplatesManager />, 'en-IN', undefined, settingsWith([]));
  const card = screen.getByTestId('tag-label-template');
  expect(within(card).queryAllByRole('option').some((o) => o.textContent === en['print.doc.invoice'])).toBe(false);
  fireEvent.change(within(card).getByLabelText(en['print.bodyKey']), { target: { value: 'labels/qr.hbs' } });
  fireEvent.change(within(card).getByTestId('print-language'), { target: { value: 'en-IN' } });
  fireEvent.click(within(card).getByTestId('tag-label-save'));
  await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
  const post = calls.find((c) => c.method === 'POST');
  expect(post?.url).toBe('/api/v1/print-templates'); expect(post?.body).toMatchObject({ doc_type: 'tag_label', paper: 'label', body_key: 'labels/qr.hbs', print_language: 'en' });
});

/* ---------------- Inventory labels: unchanged path (POST /inventory/labels → barcode_format) ---------------- */
const label = { tag_id: 't1', tag_no: 'T000042', barcode_payload: 'T000042', item_code: 'RG', item_name: 'Ring', sub_item_name: null, design_code: null, purity_code: '22K', hsn: null, gross_wt: '4.200', stone_wt: '0.000', net_wt: '4.200', pieces: 1, huid: null, size: null, mc_type: 'per_gram', mc_value: '100.00', wastage_pct: '0', counter_code: null, tray_code: null, copies: 1, duplicate: false, label_print_count: 1 };
for (const format of ['qr', 'code128'] as const) it(`Inventory label page draws ${format} from the active tag_label template's barcode_format, without any Sales print-template call`, async () => {
  replies = [{ status: 200, body: { doc_type: 'tag_label', generated_at: '2026-11-16T06:00:00Z', template_id: 'tag-1', template_version: 3, barcode_format: format, labels: [label] } }];
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const router = createRouter({ routeTree: rootRoute.addChildren([createRoute({ getParentRoute: () => rootRoute, path: '/inventory/labels', component: LabelPrintPage })]), history: createMemoryHistory({ initialEntries: ['/inventory/labels?ids=t1'] }) });
  mount(<RouterProvider router={router} />);
  fireEvent.click(await screen.findByText(en['inventory.labels.get'].replace('{n}', '1')));
  await waitFor(() => expect(screen.queryByTestId(format === 'qr' ? 'qr' : 'barcode')).toBeTruthy());
  expect(screen.queryByTestId(format === 'qr' ? 'barcode' : 'qr')).toBeNull();
  const posts = calls.filter((c) => c.method === 'POST'); expect(posts).toHaveLength(1); expect(posts[0]?.url).toBe('/api/v1/inventory/labels');
  expect(calls.some((c) => c.url.includes('print-templates') || c.url.includes('/sales/'))).toBe(false);
});
