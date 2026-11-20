import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nProvider } from '@/i18n';
import en from '@/i18n/messages/en-IN.json';
import ta from '@/i18n/messages/ta-IN.json';
import { formatDateIN, formatINR, formatWeight, toNumerals } from '@/lib/format';
import { PRINT_FONT } from '@/lib/fonts';
import { PRINT_LABELS } from '@/lib/print/labels';
import { toContract, type PrintLang, type PrintNumerals } from '@/lib/print/locales';
import { sessionQueryOptions } from '@/lib/session';
import type { CreditNote, Invoice, SalesPrintDocument, SalesPaperFormat, SalesPrintLogEntry } from '@/lib/api/backend/model';
import { creditPrintSnapshot, salesPrintDataError, salesPrintWords } from './print-data';
import { salesPrintMessages } from './print-messages';
import * as templates from './templates';
import { ApiError } from '@/lib/api/fetcher';
const actualResolve = templates.resolveSalesTemplate;
import { InvoicePrintLog, PrintLogRows, PrintPanel, printer, SalesPrintView as FrozenPrintView } from './print';
import { creditNote, estimate, invoice, printDoc, templateAsset } from './fixtures';

vi.mock('@/lib/fonts', async (original) => ({ ...await original<typeof import('@/lib/fonts')>(), loadFont: vi.fn().mockResolvedValue(undefined) }));
const nn = <T,>(x: T | undefined | null) => { if (x == null) throw new Error('missing fixture'); return x; };
const text = (id: string) => screen.getByTestId(id).textContent ?? '';
const fontsDescriptor = Object.getOwnPropertyDescriptor(document, 'fonts');
const calls: { url: string; method: string; body?: string }[] = [];
let note: CreditNote; let original: Invoice; let response = printDoc();
function SalesPrintView({ doc }: { doc: SalesPrintDocument }) { return <FrozenPrintView doc={doc} template={templateAsset(doc)} />; }
/** Explicit GST-bearing whole-line return; no mutable shop data is part of this fixture. */
function gstNote(inter = false) {
  const base = invoice();
  const l = nn(base.lines[0]);
  const line = inter ? { ...l, cgst: '0.00', sgst: '0.00', igst: '2235.00', tax_parts: l.tax_parts.map((p) => ({ ...p, cgst: '0.00', sgst: '0.00', igst: '2235.00', igst_rate: '3', cgst_rate: '0', sgst_rate: '0' })) } : l;
  const inv = invoice({ seller: { ...base.seller, address: { line1: '10 Test Road', line2: 'First floor', city: 'Chennai', district: 'Chennai', pincode: '600001' } },
    gst_type: inter ? 'inter' : 'intra', place_of_supply: inter ? '29' : '33', lines: [line] });
  const cn = creditNote({ lines: [{ invoice_line_id: line.id, line_no: 1, kind: line.kind, tag_id: line.tag_id, tag_no: line.tag_no, description: line.description,
    hsn: line.hsn, tax_rate: line.tax_rate, tax_parts: line.tax_parts, taxable_value: line.taxable_value, cgst: line.cgst, sgst: line.sgst, igst: line.igst, cess: line.cess, line_total: line.line_total }],
    seller: inv.seller, place_of_supply: inv.place_of_supply, gst_type: inv.gst_type, supply_type: inv.supply_type, original_invoice: { ...inv, invoice_total: '200000.00', lines: inv.lines }, tax_summary: [{ ...nn(inv.tax_summary[0]), cgst: line.cgst, sgst: line.sgst, igst: line.igst }], taxable_value: line.taxable_value, cgst: line.cgst, sgst: line.sgst, igst: line.igst, cess: line.cess });
  return { inv, cn };
}
function ui(node: React.ReactNode, locale: 'en-IN' | 'ta-IN' = 'en-IN') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  qc.setQueryData(sessionQueryOptions.queryKey, { user: { id: 'u', name: 'Owner', version: 1 }, roles: [{ role: 'owner' }], permissions: ['sales.invoice.view', 'sales.invoice.reprint'] });
  return render(<QueryClientProvider client={qc}><I18nProvider initial={locale}>{node}</I18nProvider></QueryClientProvider>);
}
beforeEach(() => {
  ({ inv: original, cn: note } = gstNote()); response = printDoc(); calls.length = 0;
  vi.spyOn(templates, 'resolveSalesTemplate').mockImplementation((d) => actualResolve(d, [{ id: d.template_id, version: d.template_version, doc_type: d.doc_type, body_key: templateAsset(d).body_key }]));
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined });
    const body = url.endsWith('/prints') ? response : url.includes('/credit-notes/') ? note : original;
    return new Response(JSON.stringify(body), { status: url.endsWith('/prints') ? 201 : 200, headers: { 'content-type': 'application/json' } });
  }));
});
afterEach(() => {
  cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  if (fontsDescriptor) Object.defineProperty(document, 'fonts', fontsDescriptor); else Reflect.deleteProperty(document, 'fonts');
});

describe('QA B4: immutable seller and original GST details on credit notes', () => {
  for (const paper of ['A4', 'A5', 'thermal_80mm'] as SalesPaperFormat[]) for (const inter of [false, true]) {
    it(`${paper}: ${inter ? 'IGST' : 'CGST/SGST'} particulars come from the original invoice and this note only`, () => {
      const { inv, cn } = gstNote(inter);
      ui(<SalesPrintView doc={printDoc({ doc_type: 'credit_note', doc_id: cn.id, doc_no: cn.doc_no, document: cn, paper })} />);
      expect(screen.getByText(inv.seller.legal_name)).toBeTruthy();
      expect(screen.getByText(/10 Test Road, First floor, Chennai, Chennai, 600001/)).toBeTruthy();
      expect(screen.getByText(`GSTIN ${inv.seller.gstin}`)).toBeTruthy();
      expect(text('doc-seller-state')).toContain('Tamil Nadu · code 33');
      expect(text('doc-original-invoice')).toContain(`${cn.invoice_no} · 09-11-2026`);
      expect(text('doc-pos')).toContain(inter ? '29' : '33');
      expect(text('doc-lines')).toContain('7113 · HUID AB12CD');
      expect(text('doc-taxable')).toContain('74,500.00');
      expect(text('doc-gst')).toContain(inter ? '2,235.00' : '1,117.50');
      expect(text('doc-gst')).toContain(inter ? 'IGST' : 'CGST');
      expect(text('doc-gst')).not.toContain(inter ? 'CGST' : 'IGST');
    });
  }
  it('fails clearly on nullable old seller GSTIN/address and missing required frozen CN fields, without joining an invoice', () => {
    expect(creditPrintSnapshot({ ...note, seller: { ...note.seller, address: null } })).toBeNull();
    expect(creditPrintSnapshot({ ...note, seller: { ...note.seller, gstin: null } })).toBeNull();
    expect(creditPrintSnapshot({ ...note, original_invoice: { ...note.original_invoice, id: 'other' } })).toBeNull();
    expect(creditPrintSnapshot({ ...note, original_invoice: { ...note.original_invoice, lines: [] } })).toBeNull();
    ui(<SalesPrintView doc={printDoc({ doc_type: 'credit_note', document: { ...note, seller: { ...note.seller, address: null } } })} />);
    expect(text('print-data-error')).toBe(en['error.invoice_print_snapshot_missing']); expect(screen.queryByTestId('sales-doc')).toBeNull();
  });
  it('prints a self-contained CN from snapshot with only POST plus bundled exact-template resolution, never an invoice/CN GET', async () => {
    response = printDoc({ doc_type: 'credit_note', doc_id: note.id, doc_no: note.doc_no, snapshot: note, document: { ...note, seller: { ...note.seller, legal_name: 'LIVE CHANGED' } } });
    const print = vi.spyOn(printer, 'print').mockImplementation(() => undefined);
    ui(<PrintPanel doc="credit_note" id={note.id} printCount={0} />); fireEvent.click(screen.getByTestId('print-button'));
    await waitFor(() => expect(print).toHaveBeenCalledOnce());
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST /api/v1/sales/credit-notes/cn-1/prints',
    ]);
    expect(text('doc-original-invoice')).toContain(note.invoice_no); expect(text('doc-original-total')).toContain('2,00,000.00');
    expect(screen.getByTestId('sales-doc').textContent).not.toContain('LIVE CHANGED');
  });
  it('an in-flight second POST never triggers an unlogged browser print of the previous snapshot', async () => {
    let postCount = 0; let completeSecond: ((r: Response) => void) | undefined;
    response = printDoc({ doc_type: 'credit_note', document: note, copy: 'duplicate', print_no: 2 });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); calls.push({ url, method: init?.method ?? 'GET' });
      if (url.endsWith('/prints') && ++postCount === 2) return new Promise<Response>((resolve) => { completeSecond = resolve; });
      const body = response;
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const print = vi.spyOn(printer, 'print').mockImplementation(() => undefined);
    ui(<PrintPanel doc="credit_note" id={note.id} printCount={1} />);
    fireEvent.change(screen.getByLabelText(en['sales.print.reprintReason']), { target: { value: 'First copy' } }); fireEvent.click(screen.getByTestId('print-button'));
    await waitFor(() => expect(print).toHaveBeenCalledOnce());
    fireEvent.change(screen.getByLabelText(en['sales.print.reprintReason']), { target: { value: 'Another copy' } }); fireEvent.click(screen.getByTestId('print-button'));
    await waitFor(() => expect(postCount).toBe(2)); expect(print).toHaveBeenCalledOnce();
    nn(completeSecond)(new Response(JSON.stringify({ ...response, print_no: 3 }), { status: 201, headers: { 'content-type': 'application/json' } }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(2));
  });
  it('receipt reversal stays Payment reversed, prints returned store credit and no GST or sales-return table', () => {
    const cn = creditNote({ kind: 'receipt_reversal', total: '0.00', store_credit_amount: '300.00', lines: [] });
    ui(<SalesPrintView doc={printDoc({ doc_type: 'credit_note', doc_no: cn.doc_no, document: cn })} />);
    expect(screen.getByText('Payment reversed')).toBeTruthy();
    expect(text('doc-total')).toContain('₹300.00'); expect(text('doc-non-gst')).toBe(en['sales.print.nonGst']);
    expect(screen.queryByTestId('doc-gst')).toBeNull(); expect(screen.queryByTestId('doc-taxable')).toBeNull();
  });
});

describe('QA B5: print language/numerals are independent of UI locale', () => {
  const native: Record<PrintLang, PrintNumerals> = { en: 'latn', ta: 'taml', hi: 'deva', te: 'telu', kn: 'knda', ml: 'mlym' };
  for (const lang of ['en', 'ta'] as const) for (const useNative of [false, true]) {
    it(`${lang} / ${useNative ? 'native' : 'Latin'}: labels, amounts, weights, quantities, dates and font; identifiers stay Latin`, () => {
      const n = useNative ? native[lang] : 'latn';
      const opts = toContract(`${lang}-IN`, n);
      ui(<SalesPrintView doc={printDoc({ language: lang, numerals: opts.numeral_system })} />, lang === 'en' ? 'ta-IN' : 'en-IN');
      expect(screen.getByText(salesPrintMessages(lang)['sales.print.taxInvoice'] ?? PRINT_LABELS[lang].tax_invoice)).toBeTruthy();
      expect(screen.getByTestId('sales-doc').lang).toBe(lang);
      expect(screen.getByTestId('sales-doc').style.fontFamily).toBe(PRINT_FONT[lang]);
      expect(text('doc-total')).toContain(formatINR('76735.00', { numerals: n }));
      expect(text('doc-lines')).toContain(formatWeight('10.000', 'g', { numerals: n }));
      expect(text('doc-lines')).toContain(`${salesPrintMessages(lang)['sales.loose.pieces']}: ${toNumerals('1', n)}`);
      expect(screen.getByText(formatDateIN('2026-11-09', n))).toBeTruthy();
      expect(text('doc-no')).toBe('INV-MAIN-2026-00001'); expect(text('doc-lines')).toContain('AB12CD');
      expect(text('doc-gst')).toContain('7113');
      expect(screen.getByText('GSTIN 33AAAAA0000A1Z5')).toBeTruthy();
      expect(screen.getByTestId('sales-doc').textContent).toContain(toNumerals('18:50 IST', n));
      expect(salesPrintMessages(lang)['sales.print.sellerState']).toBeTruthy();
    });
  }
  it('thermal native percentages inherit the bundled print font, not the Latin identifier monospace font', () => {
    ui(<SalesPrintView doc={printDoc({ paper: 'thermal_80mm', language: 'ta', numerals: 'tamil' })} />);
    expect(text('doc-gst')).toContain('௩.௦௦%');
    expect(text('doc-lines')).toContain('௧௦.௦௦௦ g');
    for (const el of screen.getByTestId('sales-doc').querySelectorAll('.font-mono')) expect(el.textContent).not.toMatch(/[௦-௯]/);
  });
  it('uses backend Tamil words verbatim; missing words fail closed rather than computing a client fallback', () => {
    expect(salesPrintWords(printDoc({ language: 'ta', amount_in_words: 'சேவையகச் சொற்கள்' }), 'ta')).toBe('சேவையகச் சொற்கள்');
    expect(salesPrintWords(printDoc({ amount_in_words: '' }), 'ta')).toBe('');
    expect(salesPrintDataError(printDoc({ amount_in_words: '' }))).toBe('print_words_unavailable');
    ui(<SalesPrintView doc={printDoc({ language: 'ta', amount_in_words: '' })} />);
    expect(text('print-data-error')).toBe(en['error.print_words_unavailable']); expect(screen.queryByTestId('sales-doc')).toBeNull();
  });
  it('shop Tamil/native defaults and per-print overrides are sent explicitly, not the English UI language', async () => {
    response = printDoc({ language: 'ta', numerals: 'tamil', amount_in_words: 'சேவையகச் சொற்கள்' });
    const print = vi.spyOn(printer, 'print').mockImplementation(() => undefined);
    ui(<PrintPanel doc="invoice" id="inv-1" printCount={0} defaultLanguage="ta" defaultNumerals="tamil" />);
    expect((screen.getByTestId('sales-print-language') as HTMLSelectElement).value).toBe('ta-IN');
    expect((screen.getByTestId('sales-print-numerals') as HTMLSelectElement).value).toBe('taml');
    fireEvent.click(screen.getByTestId('print-button'));
    await waitFor(() => expect(print).toHaveBeenCalledOnce());
    expect(JSON.parse(nn(calls[0]).body ?? '{}')).toEqual({ paper: 'A4', language: 'ta', numerals: 'tamil' });
    expect(screen.getByText(ta['sales.print.taxInvoice'])).toBeTruthy();
    fireEvent.change(screen.getByLabelText(en['sales.print.reprintReason']), { target: { value: 'Customer request' } });
    fireEvent.change(screen.getByTestId('sales-print-language'), { target: { value: 'en-IN' } });
    fireEvent.change(screen.getByTestId('sales-print-numerals'), { target: { value: 'latn' } });
    fireEvent.click(screen.getByTestId('print-button'));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2));
    expect(JSON.parse(nn(calls.filter((c) => c.method === 'POST')[1]).body ?? '{}')).toEqual({ paper: 'A4', language: 'en', numerals: 'latin', reprint_reason: 'Customer request' });
  });
  it('does not print before the selected font is ready; failure is visible and retry does not POST again', async () => {
    let ready: (() => void) | undefined;
    const prepare = vi.spyOn(printer, 'prepare').mockImplementation(() => new Promise<void>((resolve) => { ready = resolve; }));
    const print = vi.spyOn(printer, 'print').mockImplementation(() => undefined);
    ui(<PrintPanel doc="invoice" id="inv-1" printCount={0} />);
    fireEvent.click(screen.getByTestId('print-button'));
    await waitFor(() => expect(prepare).toHaveBeenCalledWith('en'));
    expect(screen.getByTestId('sales-doc')).toBeTruthy(); expect(print).not.toHaveBeenCalled();
    nn(ready)(); await waitFor(() => expect(print).toHaveBeenCalledOnce());
    cleanup(); calls.length = 0;
    prepare.mockRejectedValueOnce(new Error('font failed')).mockResolvedValue(undefined); print.mockClear();
    ui(<PrintPanel doc="invoice" id="inv-1" printCount={0} />);
    fireEvent.click(screen.getByTestId('print-button'));
    expect(await screen.findByText(en['sales.print.fontError'])).toBeTruthy(); expect(print).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText(en['sales.print.retryBrowser']));
    await waitFor(() => expect(print).toHaveBeenCalledOnce()); expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });
  it('loads both bundled font weights and awaits FontFaceSet.ready before opening print', async () => {
    let finish: (() => void) | undefined;
    const load = vi.fn().mockResolvedValue([{}]);
    Object.defineProperty(document, 'fonts', { configurable: true, value: { load, ready: new Promise<void>((resolve) => { finish = resolve; }) } });
    let done = false; const pending = printer.prepare('ta').then(() => { done = true; });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(load.mock.calls[0]?.[0]).toBe('400 12px "Noto Sans Tamil"');
    expect(load.mock.calls[1]?.[0]).toBe('600 12px "Noto Sans Tamil"');
    expect(done).toBe(false); nn(finish)(); await pending; expect(done).toBe(true);
  });
});


describe('0.9.3 copy, immutable cancellation, pinned defaults and errors', () => {
  it('never offers duplicate on the first live print; it is available on a reprint with a mandatory reason', async () => {
    ui(<PrintPanel doc="invoice" id="inv-1" printCount={0} />);
    expect(screen.queryByRole('option', { name: en['sales.print.copyMode.duplicate'] })).toBeNull(); cleanup();
    response = printDoc({ copy: 'duplicate', print_no: 2, template_id: '00000000-0000-4000-8000-000000000777', template_version: 1, language: 'ta', numerals: 'tamil', amount_in_words: 'சேவையகச் சொற்கள்' });
    const print = vi.spyOn(printer, 'print').mockImplementation(() => undefined);
    ui(<PrintPanel doc="invoice" id="inv-1" printCount={1} defaultLanguage="en" />);
    fireEvent.change(screen.getByTestId('sales-print-copy'), { target: { value: 'duplicate' } });
    expect((screen.getByTestId('print-button') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(en['sales.print.reprintReason']), { target: { value: 'Customer copy' } });
    fireEvent.click(screen.getByTestId('print-button')); await waitFor(() => expect(print).toHaveBeenCalledOnce());
    expect(JSON.parse(nn(calls[0]).body ?? '{}')).toEqual({ paper: 'A4', copy: 'duplicate', reprint_reason: 'Customer copy' });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1); // no current-template lookup and no locale override on reprints
    expect(screen.getByTestId('sales-doc').dataset.templateId).toBe('00000000-0000-4000-8000-000000000777');
    expect(screen.getByTestId('sales-doc').dataset.templateVersion).toBe('1');
    expect(screen.getByTestId('sales-doc').lang).toBe('ta');
  });
  it('renders cancellation from the print snapshot, never the document status today or print number', () => {
    ui(<SalesPrintView doc={printDoc({ doc_cancelled: true, copy: 'duplicate', stamp: 'CANCELLED', print_no: 1, document: invoice({ status: 'issued' }) })} />);
    expect(text('copy')).toBe(en['sales.print.duplicate']); expect(text('stamp')).toBe(en['sales.print.stamp.CANCELLED']); cleanup();
    ui(<SalesPrintView doc={printDoc({ doc_cancelled: false, document: invoice({ status: 'cancelled' }) })} />);
    expect(text('copy')).toBe(en['sales.print.original']); expect(screen.queryByTestId('stamp')).toBeNull(); cleanup();
    ui(<SalesPrintView doc={printDoc({ doc_cancelled: true, copy: 'original' })} />);
    expect(text('print-data-error')).toBe(en['error.print_snapshot_invalid']); expect(screen.queryByTestId('sales-doc')).toBeNull();
  });
  for (const code of ['first_print_duplicate_not_supported', 'print_language_not_supported', 'pinned_print_template_unavailable', 'print_template_not_configured', 'print_snapshot_unavailable', 'invoice_print_snapshot_missing'] as const) for (const locale of ['en-IN', 'ta-IN'] as const) {
    it(`${code}: clear ${locale} error in print panel, never opens the printer`, async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ code, title: code }), { status: 422, headers: { 'content-type': 'application/problem+json' } })));
      const print = vi.spyOn(printer, 'print').mockImplementation(() => undefined);
      ui(<PrintPanel doc="invoice" id="inv-1" printCount={0} />, locale);
      fireEvent.click(screen.getByTestId('print-button'));
      expect(await screen.findByText((locale === 'en-IN' ? en : ta)[`error.${code}`])).toBeTruthy(); expect(print).not.toHaveBeenCalled();
    });
  }
  for (const language of ['hi', 'te', 'kn', 'ml']) it(`${language} payload fails closed until backend words are supported`, () => {
    ui(<SalesPrintView doc={printDoc({ language: language as never })} />);
    expect(text('print-data-error')).toBe(en['error.print_language_not_supported']); expect(screen.queryByTestId('sales-doc')).toBeNull();
  });
  it('log rows use stored copy/cancelled flags, version, reason and IST, including print 1 duplicate', () => {
    const base = { print_no: 1, copy: 'duplicate' as const, doc_cancelled: true, printed_at: '2026-11-09T13:00:00Z', printed_by: 'u', paper: 'A4' as const, template_id: response.template_id, locale: 'ta-IN', language: 'ta', numerals: 'tamil' as const, template_version: 3, reprint_reason: 'Cancelled copy' };
    ui(<PrintLogRows rows={[base, { ...base, print_no: 2, doc_cancelled: false, reprint_reason: 'Before cancellation' }]} />);
    const rows = screen.getAllByTestId('print-log-row');
    expect(rows[0]?.textContent).toContain(`${en['sales.print.duplicate']} · ${en['sales.print.stamp.CANCELLED']}`); expect(rows[0]?.textContent).toContain('18:30 IST');
    expect(rows[0]?.textContent).toContain('Cancelled copy'); expect(rows[0]?.textContent).toContain('3');
    expect(rows[1]?.textContent).not.toContain(en['sales.print.stamp.CANCELLED']);
  });
  it('loads the immutable invoice log on demand, not every detail-page render', async () => {
    const row: SalesPrintLogEntry = { print_no: 1, copy: 'duplicate', doc_cancelled: true, printed_at: '2026-11-09T13:00:00Z', printed_by: 'u', paper: 'A4', template_id: response.template_id, locale: 'en-IN', language: 'en', numerals: 'latin', template_version: 1, reprint_reason: 'Cancelled copy' };
    vi.stubGlobal('fetch', vi.fn(async (input) => { calls.push({ url: String(input), method: 'GET' }); return new Response(JSON.stringify([row]), { status: 200, headers: { 'content-type': 'application/json' } }); }));
    ui(<InvoicePrintLog id="inv-1" />); expect(calls).toHaveLength(0);
    const details = screen.getByText(en['sales.print.log.title']).closest('details');
    nn(details).open = true; fireEvent(nn(details), new Event('toggle'));
    expect(await screen.findByTestId('print-log-row')).toBeTruthy(); expect(calls[0]?.url).toBe('/api/v1/sales/invoices/inv-1/prints');
  });
});


describe('0.9.4 frozen content and mandatory print readiness', () => {
  it('invoice reprint uses issue-time content, while copy/CANCELLED/CN note/time/paper/words come from envelope', () => {
    const frozen = invoice(), live = invoice({ seller: { ...frozen.seller, legal_name: 'LIVE COMPANY' }, totals: { ...frozen.totals, net_payable: '1.00', balance_due: '0.00' }, lines: [], status: 'cancelled' });
    const d = printDoc({ snapshot: frozen, document: live, copy: 'duplicate', doc_cancelled: true, stamp: 'CANCELLED', notes: ['Cancelled by credit note CN-123'], paper: 'thermal_80mm', printed_at: '2026-11-09T14:00:00Z', amount_in_words: 'Exactly the backend words' });
    ui(<SalesPrintView doc={d} />);
    expect(screen.getByTestId('sales-doc').textContent).not.toContain('LIVE COMPANY'); expect(text('doc-total')).toContain('76,735.00');
    expect(text('stamp')).toBe(en['sales.print.stamp.CANCELLED']); expect(screen.getByText('Cancelled by credit note CN-123')).toBeTruthy();
    expect(text('doc-words')).toBe('Exactly the backend words'); expect(screen.getByTestId('sales-doc').dataset.paper).toBe('thermal_80mm');
    expect(screen.getByTestId('sales-doc').textContent).toContain('19:30 IST');
  });
  it('edited estimate and redeemed credit-note live documents cannot change frozen print content', () => {
    const e = estimate(), live = estimate({ computation: { ...e.computation, totals: { ...e.computation.totals, net_payable: '1.00' } } });
    ui(<SalesPrintView doc={printDoc({ doc_type: 'estimate', doc_no: e.estimate_no, doc_id: e.id, snapshot: e, document: live })} />);
    expect(text('doc-total')).toContain('76,735.00'); cleanup();
    const cn = creditNote({ kind: 'receipt_reversal', total: '300.00', store_credit_amount: '300.00', balance_available: '300.00' });
    ui(<SalesPrintView doc={printDoc({ doc_type: 'credit_note', doc_no: cn.doc_no, doc_id: cn.id, snapshot: cn, document: { ...cn, balance_available: '0.00', store_credit_amount: '1.00' } })} />);
    expect(text('doc-total')).toContain('300.00'); expect(screen.queryByTestId('doc-lines')).toBeNull(); expect(screen.queryByTestId('doc-gst')).toBeNull();
  });
  it('GST CN shows authoritative principal/component rates, HSN/SAC, taxes and full original total without recomputing', () => {
    const { cn } = gstNote(); const part = nn(cn.lines[0]?.tax_parts[0]);
    const noteWithParts = { ...cn, round_off: '-0.40', tax_summary: [{ ...nn(cn.tax_summary[0]), cgst: '102.70', sgst: '102.70', cess: '0.50' }],
      lines: cn.lines.map((l) => ({ ...l, tax_parts: [{ ...part, component: 'making' as const, hsn_sac: '9987', rate: '18.00', cgst_rate: '9.00', sgst_rate: '9.00', igst_rate: '0.00', cess_rate: '1.00', cgst: '5.23', sgst: '5.23', igst: '0.00', cess: '0.58' }] })) };
    ui(<SalesPrintView doc={printDoc({ doc_type: 'credit_note', document: noteWithParts })} />);
    expect(text('doc-original-total')).toContain('2,00,000.00'); expect(text('cn-principal-rate')).toContain('3.00%');
    expect(text('cn-tax-part')).toContain('9987'); expect(text('cn-tax-part')).toContain('9.00%: ₹5.23'); expect(text('cn-tax-part')).toContain('1.00%: ₹0.58');
    expect(text('doc-gst')).toContain('₹102.70'); expect(text('doc-gst')).toContain('₹0.50'); expect(screen.getByTestId('sales-doc').textContent).toContain('-₹0.40');
  });
  for (const field of ['template_id', 'template_version', 'locale', 'language', 'numerals', 'snapshot'] as const) it(`missing ${field} never produces a printable article`, () => {
    const d = printDoc(); Reflect.deleteProperty(d, field);
    ui(<SalesPrintView doc={d} />); expect(screen.getByTestId('print-data-error')).toBeTruthy(); expect(screen.queryByTestId('sales-doc')).toBeNull();
  });
  it('locale mismatch and null seller GSTIN/address fail clearly; no current/live seller fallback', () => {
    expect(salesPrintDataError(printDoc({ language: 'ta', locale: 'en-IN' }))).toBe('print_snapshot_invalid');
    for (const patch of [{ address: null }, { gstin: null }]) {
      const snapshot = invoice({ seller: { ...invoice().seller, ...patch } });
      expect(salesPrintDataError(printDoc({ snapshot, document: invoice() }))).toBe('invoice_print_snapshot_missing');
    }
  });
  it('non-GST reversal rejects tax/line contamination, but allows nullable old seller GST particulars for context', () => {
    const cn = creditNote({ kind: 'receipt_reversal', seller: { ...invoice().seller, gstin: null, address: null }, total: '300.00', store_credit_amount: '300.00' });
    expect(creditPrintSnapshot(cn)).not.toBeNull(); expect(creditPrintSnapshot({ ...cn, cgst: '0.01' })).toBeNull();
    expect(creditPrintSnapshot({ ...cn, tax_summary: invoice().tax_summary })).toBeNull();
    expect(creditPrintSnapshot({ ...cn, original_invoice: { ...cn.original_invoice, lines: invoice().lines } })).toBeNull();
  });
  it('only bundled constants control the template, never injected layout/footer or unknown keys', () => {
    const d = printDoc({ notes: ['<img src=x onerror=alert(1)>'] });
    ui(<FrozenPrintView doc={d} template={templateAsset(d)} />);
    expect(screen.getByTestId('sales-doc').querySelector('img')).toBeNull(); cleanup();
    for (const patch of [{ template_version: 4 }, { body_key: 'unknown' }, { footer_text: 'INJECTED TEMPLATE' }, { layout: 'compact' as const }]) {
      ui(<FrozenPrintView doc={d} template={templateAsset(d, patch)} />);
      expect(screen.queryByTestId('sales-doc')).toBeNull(); expect(text('print-data-error')).toBe(en['error.print_template_asset_unavailable']); cleanup();
    }
  });
  it('missing bundled ID mapping fails closed; retry uses the same payload without another POST or any GET', async () => {
    let attempts = 0;
    vi.mocked(templates.resolveSalesTemplate).mockImplementation(async (d) => {
      if (++attempts === 1) throw new ApiError(422, 'pinned_print_template_unavailable', 'Missing binding');
      return actualResolve(d, [{ id: d.template_id, version: d.template_version, doc_type: d.doc_type, body_key: templateAsset(d).body_key }]);
    });
    const print = vi.spyOn(printer, 'print').mockImplementation(() => undefined);
    ui(<PrintPanel doc="invoice" id="inv-1" printCount={0} />); fireEvent.click(screen.getByTestId('print-button'));
    expect(await screen.findByText(en['error.pinned_print_template_unavailable'])).toBeTruthy(); expect(print).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText(en['sales.print.retryAsset'])); await waitFor(() => expect(print).toHaveBeenCalledOnce());
    expect(calls).toHaveLength(1); expect(calls[0]?.method).toBe('POST');
  });
  it('legacy print-log null pins are labelled honestly and required locale/id are displayed for new rows', () => {
    const row: SalesPrintLogEntry = { print_no: 1, copy: 'original', doc_cancelled: false, printed_at: '2026-11-09T13:00:00Z', printed_by: 'u', paper: 'A4', template_id: null, template_version: null, locale: 'ta-IN', language: 'ta', numerals: 'tamil', reprint_reason: null };
    ui(<PrintLogRows rows={[row, { ...row, print_no: 2, copy: 'duplicate', template_id: response.template_id, template_version: 3, reprint_reason: 'Customer copy' }]} />);
    expect(text('print-log-rows')).toContain(en['sales.print.legacyPin']); expect(text('print-log-rows')).toContain(response.template_id); expect(text('print-log-rows')).toContain('ta-IN');
  });
});


it('returned numerals are honoured independently of language/locale, and their bundled font also loads', async () => {
  response = printDoc({ language: 'en', locale: 'en-IN', numerals: 'tamil' });
  const prepare = vi.spyOn(printer, 'prepare').mockResolvedValue(undefined), print = vi.spyOn(printer, 'print').mockImplementation(() => undefined);
  ui(<PrintPanel doc="invoice" id="inv-1" printCount={0} defaultLanguage="en" defaultNumerals="tamil" />);
  expect((screen.getByTestId('sales-print-numerals') as HTMLSelectElement).value).toBe('taml');
  fireEvent.click(screen.getByTestId('print-button'));
  await waitFor(() => expect(print).toHaveBeenCalledOnce());
  expect(JSON.parse(nn(calls.find((c) => c.method === 'POST')).body ?? '{}')).toMatchObject({ language: 'en', numerals: 'tamil' });
  expect(prepare).toHaveBeenCalledWith('en'); expect(prepare).toHaveBeenCalledWith('ta');
  expect(text('doc-total')).toContain('௭௬,௭௩௫.௦௦'); expect(screen.getByTestId('sales-doc').style.fontFamily).toContain('Noto Sans Tamil');
  expect(text('doc-no')).toBe('INV-MAIN-2026-00001'); expect(text('doc-words')).toBe(response.amount_in_words);
});
for (const numerals of ['bengali', 'gujarati'] as const) it(`does not silently substitute Latin for unavailable ${numerals} print fonts`, () => {
  ui(<SalesPrintView doc={printDoc({ numerals })} />); expect(text('print-data-error')).toBe(en['error.print_numerals_not_supported']); expect(screen.queryByTestId('sales-doc')).toBeNull();
});


describe('release print language policy: English/Tamil only, no stored-language coercion',()=>{
 for(const code of ['hi','te','kn','ml','bn','gu','zz']) it(`stored ${code} is explicit unsupported, not silently English`,()=>{
  ui(<PrintPanel doc="invoice" id="inv-1" printCount={0} defaultLanguage={code} />);
  const select=screen.getByTestId('sales-print-language') as HTMLSelectElement;
  expect(Array.from(select.options).map((o)=>o.value).filter((v)=>v && v!=='saved')).toEqual(['en-IN','ta-IN']);
  expect(select.value).toBe('');expect(text('unsupported-print-language')).toContain(code);
  expect((screen.getByTestId('print-button') as HTMLButtonElement).disabled).toBe(true);expect(calls).toHaveLength(0);
 });
 it('explicit Tamil choice overrides an unsupported stored value, with no remap or implicit request',async()=>{
  response=printDoc({language:'ta',numerals:'tamil'});vi.spyOn(printer,'prepare').mockResolvedValue(undefined);const print=vi.spyOn(printer,'print').mockImplementation(()=>undefined);
  ui(<PrintPanel doc="invoice" id="inv-1" printCount={0} defaultLanguage="hi" />);
  fireEvent.change(screen.getByTestId('sales-print-language'),{target:{value:'ta-IN'}});fireEvent.click(screen.getByTestId('print-button'));
  await waitFor(()=>expect(print).toHaveBeenCalledOnce());expect(JSON.parse(calls[0]?.body??'{}').language).toBe('ta');expect(calls).toHaveLength(1);
 });
 it('an asynchronous unsupported shop setting does not remain silently selected as English',async()=>{
  function Harness(){const [code,setCode]=useState('en');return <><button onClick={()=>setCode('kn')}>Load saved setting</button><PrintPanel doc="invoice" id="inv-1" printCount={0} defaultLanguage={code} /></>;}
  ui(<Harness />);expect((screen.getByTestId('sales-print-language') as HTMLSelectElement).value).toBe('en-IN');
  fireEvent.click(screen.getByText('Load saved setting'));expect((screen.getByTestId('sales-print-language') as HTMLSelectElement).value).toBe('');expect(text('unsupported-print-language')).toContain('kn');expect(calls).toHaveLength(0);
 });
 it('a rejected inherited reprint language requires an explicit en/ta override, never retries as English',async()=>{
  const request=vi.fn().mockResolvedValue(new Response(JSON.stringify({code:'print_language_not_supported'}),{status:422,headers:{'content-type':'application/problem+json'}}));vi.stubGlobal('fetch',request);
  ui(<PrintPanel doc="invoice" id="inv-1" printCount={1} defaultLanguage="en" />);
  fireEvent.change(screen.getByLabelText(en['sales.print.reprintReason']),{target:{value:'Customer copy'}});fireEvent.click(screen.getByTestId('print-button'));
  expect(await screen.findByText(en['error.print_language_not_supported'])).toBeTruthy();expect((screen.getByTestId('sales-print-language') as HTMLSelectElement).value).toBe('');expect((screen.getByTestId('print-button') as HTMLButtonElement).disabled).toBe(true);
  expect(request).toHaveBeenCalledOnce();fireEvent.change(screen.getByTestId('sales-print-language'),{target:{value:'en-IN'}});expect((screen.getByTestId('print-button') as HTMLButtonElement).disabled).toBe(false);expect(request).toHaveBeenCalledOnce();
 });
});
