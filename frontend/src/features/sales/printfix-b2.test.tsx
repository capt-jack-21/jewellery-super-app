/** 0.9.5 printfix B-2 (lead decision: platform defaults only) and the 0.9.6 duplicate re-pin handler (now on the generated 0.9.6 types). */
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nProvider } from '@/i18n';
import en from '@/i18n/messages/en-IN.json';
import ta from '@/i18n/messages/ta-IN.json';
import { sessionQueryOptions } from '@/lib/session';
import { getListPrintTemplatesQueryKey } from '@/lib/api/backend/branding/branding';
import type { SalesPrintDocument } from '@/lib/api/backend/model';
import { isPlatformDefaultTemplate, PrintTemplatesManager } from '@/features/settings/print-templates';
import { estimate, printDoc, templateRow } from './fixtures';
import { PrintPanel, printer } from './print';
import { repinNotice096 } from './repin096';
import { resolveSalesTemplate, SEEDED_TEMPLATE_PINS } from './templates';
vi.mock('@/components/print-preview', () => ({ PrintPreview: () => <div data-testid="preview-stub" /> }));

const INVOICE_PIN = '01a1c455-29fa-769b-84f9-377a9bcdab46';
function mount(node: ReactNode, locale: 'en-IN' | 'ta-IN' = 'en-IN', qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } })) {
  qc.setQueryData(sessionQueryOptions.queryKey, { user: { id: 'u', name: 'Owner', version: 1 }, roles: [{ role: 'owner' }], permissions: ['platform.settings.edit', 'sales.invoice.view', 'sales.invoice.reprint'] });
  return render(<QueryClientProvider client={qc}><I18nProvider initial={locale}>{node}</I18nProvider></QueryClientProvider>);
}
let response: unknown = null; let status = 200;
const calls: { url: string; method: string }[] = [];
beforeEach(() => {
  calls.length = 0; status = 200; response = printDoc({ template_id: INVOICE_PIN });
  vi.spyOn(printer, 'prepare').mockResolvedValue(undefined); vi.spyOn(printer, 'print').mockImplementation(() => undefined);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => { calls.push({ url: String(input), method: init?.method ?? 'GET' }); return new Response(JSON.stringify(response), { status, headers: { 'content-type': status < 300 ? 'application/json' : 'application/problem+json' } }); }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

for (const locale of ['en-IN', 'ta-IN'] as const) it(`B-2 Settings (${locale}): no create, activate, body-key or default-template controls for any scope; platform defaults marked; unprintable active row flagged`, () => {
  const m = locale === 'en-IN' ? en : ta;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const platform = SEEDED_TEMPLATE_PINS.map((p) => ({ ...templateRow(), id: p.id, version: p.version, doc_type: p.doc_type as 'invoice', body_key: p.body_key, scope: 'platform' as const, read_only: true, is_active: false, renderable: true }));
  const ratchet = { ...templateRow(), id: '11111111-1111-4111-8111-111111111111', version: 99, doc_type: 'invoice' as const, body_key: 'templates/default/invoice.hbs', scope: 'tenant' as const, read_only: false, is_active: true, renderable: false };
  const tenantDraft = { ...templateRow(), id: 'tenant-draft', scope: 'tenant' as const, read_only: false, is_active: false, print_language: 'en' };
  qc.setQueryData(getListPrintTemplatesQueryKey(), [...platform, ratchet, tenantDraft]);
  mount(<PrintTemplatesManager />, locale, qc);
  expect(screen.getByTestId('print-platform-only').textContent).toBe(m['print.platformOnly']);
  for (const key of ['print.activate', 'print.newDraft'] as const) expect(screen.queryByText(m[key])).toBeNull();
  expect(screen.queryAllByRole('button').filter((b) => b.textContent === m['print.activate'])).toHaveLength(0);
  // 0.9.6: the only template write left is the exempt tag_label card; no free-text Sales template key / footer outside it
  const tagCard = screen.getByTestId('tag-label-template');
  expect(screen.queryAllByRole('textbox').every((el) => tagCard.contains(el))).toBe(true);
  expect(screen.queryAllByText(m['print.saveDraft']).every((el) => tagCard.contains(el))).toBe(true);
  expect(screen.getAllByTestId('print-platform-default')).toHaveLength(4);
  expect(screen.getAllByTestId('print-not-renderable').map((e) => e.textContent)).toEqual([m['print.notRenderable']]);
  expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
});
it('B-2: only the four seeded 998 UUIDs at v1 count as platform defaults', () => {
  for (const p of SEEDED_TEMPLATE_PINS) { expect(isPlatformDefaultTemplate(p)).toBe(true); expect(isPlatformDefaultTemplate({ id: p.id, version: 2 })).toBe(false); }
  expect(SEEDED_TEMPLATE_PINS.every((p) => p.version === 1 && p.id.startsWith('01a1c455-29fa-'))).toBe(true);
  expect(isPlatformDefaultTemplate({ id: '11111111-1111-4111-8111-111111111111', version: 99 })).toBe(false);
});
it('B-2: resolver stays keyed on uuid+version — a shipped body_key on an unknown id still fails closed', async () => {
  await expect(resolveSalesTemplate(printDoc({ template_id: '11111111-1111-4111-8111-111111111111', template_version: 1 }))).rejects.toMatchObject({ code: 'pinned_print_template_unavailable' });
  await expect(resolveSalesTemplate(printDoc({ template_id: INVOICE_PIN, template_version: 99 }))).rejects.toMatchObject({ code: 'pinned_print_template_unavailable' });
  expect(calls).toHaveLength(0);
});

const PANELS = [
  { doc: 'invoice', node: () => <PrintPanel doc="invoice" id="inv-1" printCount={0} /> },
  { doc: 'estimate', node: () => <PrintPanel doc="estimate" id="est-1" printCount={0} /> },
  { doc: 'credit_note', node: () => <PrintPanel doc="credit_note" id="cn-1" printCount={0} /> },
  { doc: 'payment_receipt', node: () => <PrintPanel doc="payment_receipt" id="r1" invoiceId="inv-1" printCount={undefined} /> },
] as const;
for (const locale of ['en-IN', 'ta-IN'] as const) for (const code of ['print_template_not_renderable', 'pinned_print_template_unavailable', 'print_template_not_configured'] as const) for (const p of PANELS) it(`B-2 ${p.doc} print 422 ${code} shows the clean ${locale} message and never prints`, async () => {
  status = 422; response = { code, title: 'Unprocessable', detail: 'raw server detail' };
  mount(p.node(), locale); fireEvent.click(screen.getByTestId('print-button'));
  expect(await screen.findByText((locale === 'en-IN' ? en : ta)[`error.${code}`])).toBeTruthy();
  expect(screen.queryByText('raw server detail')).toBeNull(); expect(printer.print).not.toHaveBeenCalled(); expect(calls).toHaveLength(1);
});

// 0.9.6 duplicate re-pin handler; tolerant of the (now required) fields being absent in an older payload.
const dup = (over: Record<string, unknown> = {}) => ({ ...printDoc({ template_id: INVOICE_PIN, copy: 'duplicate', stamp: 'DUPLICATE', print_no: 2 }), ...over }) as SalesPrintDocument;
it('0.9.6 re-pin: absent / null / false fields (every 0.9.5 response) mean not re-pinned', () => {
  expect(repinNotice096(dup())).toBeNull(); expect(repinNotice096(dup({ template_repinned: false }))).toBeNull(); expect(repinNotice096(dup({ template_repinned: null, repinned_from: null }))).toBeNull();
  expect(repinNotice096(printDoc({ template_id: INVOICE_PIN }))).toBeNull();
});
it('0.9.6 re-pin: a duplicate re-pinned to the matching platform default returns the previous pin', () => {
  expect(repinNotice096(dup({ template_repinned: true, repinned_from: { template_id: '11111111-1111-4111-8111-111111111111', template_version: 99 } }))).toEqual({ template_id: '11111111-1111-4111-8111-111111111111', template_version: 99 });
  const e = estimate({ print_count: 1 });
  expect(repinNotice096({ ...printDoc({ doc_type: 'estimate', document: e, snapshot: e, template_id: '01a1c455-29fa-7963-88e9-d3cf6e2a8240', copy: 'duplicate', print_no: 2 } as Partial<SalesPrintDocument>), template_repinned: true, repinned_from: { template_id: 'old', template_version: 3 } } as SalesPrintDocument)).toEqual({ template_id: 'old', template_version: 3 });
});
for (const [name, over] of [
  ['original copy', { copy: 'original', stamp: null, print_no: 1, template_repinned: true, repinned_from: { template_id: 'old', template_version: 1 } }],
  ['missing repinned_from', { template_repinned: true }],
  ['malformed version', { template_repinned: true, repinned_from: { template_id: 'old', template_version: '1' } }],
  ['target not a platform default', { template_id: '11111111-1111-4111-8111-111111111111', template_repinned: true, repinned_from: { template_id: 'old', template_version: 1 } }],
  ['target of another doc type', { template_id: '01a1c455-29fa-7811-b4b1-95efbd5b9ea5', template_repinned: true, repinned_from: { template_id: 'old', template_version: 1 } }],
  ['same pin as before', { template_repinned: true, repinned_from: { template_id: INVOICE_PIN, template_version: 1 } }],
  ['non-boolean flag', { template_repinned: 'yes', repinned_from: { template_id: 'old', template_version: 1 } }],
] as const) it(`0.9.6 re-pin fails closed: ${name}`, () => {
  let code: unknown = null;
  try { repinNotice096(dup(over)); } catch (e) { code = (e as { code?: unknown }).code; }
  expect(code).toBe('print_template_repin_invalid');
});

for (const locale of ['en-IN', 'ta-IN'] as const) it(`0.9.6 re-pin in the panel (${locale}): renders the re-pinned platform template and shows the platform-default note`, async () => {
  const m = locale === 'en-IN' ? en : ta;
  response = dup({ template_repinned: true, repinned_from: { template_id: 'old-tpl', template_version: 99 } });
  mount(<PrintPanel doc="invoice" id="inv-1" printCount={1} />, locale);
  fireEvent.change(screen.getByLabelText(m['sales.print.reprintReason']), { target: { value: 'Customer copy' } });
  fireEvent.click(screen.getByTestId('print-button'));
  await waitFor(() => expect(printer.print).toHaveBeenCalledOnce());
  expect(screen.getByTestId('sales-doc').dataset.templateId).toBe(INVOICE_PIN);
  expect(screen.getByTestId('print-repinned-note').textContent).toBe(m['sales.print.repinnedNote'].replace('{id}', 'old-tpl').replace('{version}', '99'));
});
it('0.9.6 re-pin in the panel: an inconsistent re-pin shows a clean error and never prints; 0.9.5 duplicates show no note', async () => {
  response = dup({ template_repinned: true, repinned_from: { template_id: 'old', template_version: 1 }, template_id: '11111111-1111-4111-8111-111111111111' });
  mount(<PrintPanel doc="invoice" id="inv-1" printCount={1} />);
  fireEvent.change(screen.getByLabelText(en['sales.print.reprintReason']), { target: { value: 'Customer copy' } });
  fireEvent.click(screen.getByTestId('print-button'));
  expect(await screen.findByText(en['error.print_template_repin_invalid'])).toBeTruthy(); expect(printer.print).not.toHaveBeenCalled(); expect(screen.queryByTestId('sales-doc')).toBeNull();
  cleanup(); response = dup();
  mount(<PrintPanel doc="invoice" id="inv-1" printCount={1} />);
  fireEvent.change(screen.getByLabelText(en['sales.print.reprintReason']), { target: { value: 'Customer copy' } });
  fireEvent.click(screen.getByTestId('print-button'));
  await waitFor(() => expect(printer.print).toHaveBeenCalledOnce()); expect(screen.queryByTestId('print-repinned-note')).toBeNull();
});
