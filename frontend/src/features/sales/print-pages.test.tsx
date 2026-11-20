/**
 * B-1 (0.9.5 printfix) regression: start from the real Sales detail pages (invoice / estimate / credit note) mounted into #root
 * inside an app-like shell, click the real print buttons (receipt preview is the real body portal), then print that exact DOM
 * in Chromium with the shipped print CSS and count PDF pages. A receipt must be exactly one 80 mm / A4 page, never a US Letter
 * page first. `SALES_PRINT_BUILT_CSS=1` uses the compiled dist CSS (real Tailwind `print:hidden`), as print-paper.test.ts does.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { I18nProvider } from '@/i18n';
import en from '@/i18n/messages/en-IN.json';
import { sessionQueryOptions } from '@/lib/session';
import type { CreditNote, PaymentReceipt, PaymentReceiptPrintSnapshot, SalesPaperFormat, SalesPrintDocument } from '@/lib/api/backend/model';
import { creditNote, estimate, invoice, printDoc, settings } from './fixtures';
import { InvoicePage } from './invoice-page';
import { CreditNotePage, EstimatePage } from './lists';
import { printer } from './print';

const built = process.env.SALES_PRINT_BUILT_CSS === '1';
const SHIM = '@media print { .print\\:hidden { display: none !important; } .print\\:border-0 { border-width: 0 !important; } }';
const css = built
  ? readdirSync('dist/assets').filter((f) => f.endsWith('.css')).map((f) => readFileSync(`dist/assets/${f}`, 'utf8')).join('\n')
  : [readFileSync('src/features/sales/print095.css', 'utf8'), readFileSync('src/features/sales/print.v1.css', 'utf8'),
    readFileSync('src/index.css', 'utf8').replace(/@import[^;]+;/g, '').replace(/@tailwind[^;]+;/g, ''), SHIM].join('\n');
const PIN = { invoice: '01a1c455-29fa-769b-84f9-377a9bcdab46', estimate: '01a1c455-29fa-7963-88e9-d3cf6e2a8240', credit_note: '01a1c455-29fa-7856-b4ed-a3710fd91ec1', receipt: '01a1c455-29fa-7811-b4b1-95efbd5b9ea5' } as const;
const PT = 72 / 25.4;
const SIZE: Record<'A4' | 'thermal_80mm', [number, number]> = { A4: [210 * PT, 297 * PT], thermal_80mm: [80 * PT, 297 * PT] };
const PAGE_NAME = { A4: 'sales-a4', thermal_80mm: 'sales-thermal' } as const;
const LETTER: [number, number] = [612, 792];

/** Chromium in its own Node process (same cached playwright-core Chromium as print-paper.test.ts; no network, no fonts). */
const RUNNER = `const {chromium}=require('playwright-core');let input='';process.stdin.on('data',(d)=>{input+=d;}).on('end',async()=>{
const {html,css}=JSON.parse(input);const b=await chromium.launch({executablePath:chromium.executablePath(),headless:true,args:['--no-sandbox']});
try{const p=await b.newPage({viewport:{width:1280,height:800}});await p.route('**/*',(r)=>r.abort());
await p.setContent('<!doctype html><html><head><style>'+css+'</style></head><body>'+html+'</body></html>');await p.emulateMedia({media:'print'});
const info=await p.evaluate(()=>{const docs=[...document.querySelectorAll('.sales-doc')].filter((e)=>e.getClientRects().length>0);const d=docs[0];
return {visibleDocs:docs.length,page:d?getComputedStyle(d).page:null,paper:d?d.getAttribute('data-paper'):null,testid:d?d.getAttribute('data-testid'):null,root:getComputedStyle(document.getElementById('root')).display};});
const pdf=(await p.pdf({preferCSSPageSize:true})).toString('latin1');
const pages=(pdf.match(/\\/Type\\s*\\/Page(?![a-zA-Z])/g)||[]).length;
const boxes=[...pdf.matchAll(/\\/MediaBox\\s*\\[([^\\]]+)\\]/g)].map((m)=>m[1].trim().split(/\\s+/).map(Number));
process.stdout.write(JSON.stringify({...info,pages,boxes}));}catch(e){process.stderr.write(String(e&&e.stack||e));process.exitCode=1;}finally{await b.close();}});`;
interface PdfResult { visibleDocs: number; page: string | null; paper: string | null; testid: string | null; root: string; pages: number; boxes: number[][] }
function printPdf(html: string): Promise<PdfResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', RUNNER], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); }); child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => { if (code === 0) resolve(JSON.parse(out) as PdfResult); else reject(new Error(`Chromium runner failed (${String(code)}): ${err}`)); });
    child.stdin.end(JSON.stringify({ html, css }));
  });
}
const near = (a: number | undefined, b: number) => Math.abs((a ?? 0) - b) < 1.5;
function expectSinglePage(r: PdfResult, paper: 'A4' | 'thermal_80mm') {
  expect(r.visibleDocs).toBe(1);
  expect(r.paper).toBe(paper);
  expect(r.page).toBe(PAGE_NAME[paper]);
  expect(r.pages).toBe(1);
  expect(r.boxes.length).toBeGreaterThan(0);
  for (const box of r.boxes) {
    expect(near(box[2], SIZE[paper][0]) && near(box[3], SIZE[paper][1]), `MediaBox ${box.join(' ')} is not ${paper}`).toBe(true);
    expect(near(box[2], LETTER[0]) && near(box[3], LETTER[1]), 'no US Letter page').toBe(false);
  }
}

function receiptDocument(kind: 'collection' | 'reversal'): { snapshot: PaymentReceiptPrintSnapshot; document: PaymentReceipt } {
  const inv = invoice();
  const base: PaymentReceiptPrintSnapshot = { id: 'r1', receipt_no: 'RCT-001', invoice_id: inv.id, invoice_no: inv.doc_no, invoice_date: inv.doc_date, branch_id: inv.branch_id, customer_id: inv.customer.customer_id ?? 'customer-1', customer: inv.customer, seller: inv.seller, received_on: inv.doc_date, received_at: '2026-11-10T03:00:00Z', received_by: 'u', tenders: [{ line_no: 1, mode: 'upi', amount: '100.00', reference: 'UPI123', payment_mode_id: null, card_machine_id: null, cheque_date: null, bank_name: null, credit_note_id: null }], total: '100.00', adjusted_balance_due_at_issue: '50.00', note: null, reverses_receipt_id: null, reversal_reason: null, kind: 'collection' };
  const snapshot = kind === 'collection' ? base : { ...base, kind: 'reversal' as const, tenders: [], total: '-100.00', reverses_receipt_id: 'prior', reversal_reason: 'Entry correction' };
  return { snapshot, document: { ...snapshot, balance_due_after: '50.00', adjusted_balance_due_after: '50.00', reversed_by_receipt_id: null } };
}
function receiptPrint(v: { language: 'en' | 'ta'; paper: SalesPaperFormat; copy: 'original' | 'duplicate'; kind: 'collection' | 'reversal' }): SalesPrintDocument {
  const { snapshot, document } = receiptDocument(v.kind);
  return { ...printDoc(), doc_type: 'payment_receipt', doc_id: 'r1', doc_no: 'RCT-001', template_id: PIN.receipt, template_version: 1, paper: v.paper, language: v.language, locale: `${v.language}-IN`, numerals: v.language === 'ta' ? 'tamil' : 'latin',
    copy: v.copy, print_no: v.copy === 'original' ? 1 : 2, doc_cancelled: false, stamp: v.kind === 'reversal' ? 'REVERSAL' : v.copy === 'duplicate' ? 'DUPLICATE' : null,
    notes: v.kind === 'reversal' ? ['No collection'] : [], amount_in_words: 'Rupees One Hundred Only', snapshot, document } as SalesPrintDocument;
}
const cn = (): CreditNote => { const i = invoice(), l = i.lines[0]; if (!l) throw new Error('fixture'); return creditNote({ lines: [{ ...l, invoice_line_id: l.id }], original_invoice: { ...i, invoice_total: i.totals.invoice_total, lines: i.lines }, tax_summary: i.tax_summary, taxable_value: l.taxable_value, cgst: l.cgst, sgst: l.sgst, igst: l.igst }); };

let routes: Record<string, unknown> = {};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': status < 300 ? 'application/json' : 'application/problem+json' } });
beforeEach(() => {
  vi.spyOn(printer, 'prepare').mockResolvedValue(undefined); vi.spyOn(printer, 'print').mockImplementation(() => undefined);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://shop.test').pathname; const key = `${init?.method ?? 'GET'} ${path}`;
    return key in routes ? json(routes[key]) : json({ code: 'not_found' }, 404);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** App-like shell: sidebar, header and padded main live in #root, like the real layout. */
function mountAt(path: string, paper: SalesPaperFormat, language: 'en' | 'ta') {
  routes['GET /api/v1/sales/settings'] = settings({ default_paper: paper, print_language: language });
  const rootRoute = createRootRoute({ component: () => <div className="flex min-h-screen"><aside className="w-60 border-r p-4">Sidebar</aside><div className="flex-1"><header className="h-14 border-b">Shop</header><main className="p-6"><Outlet /></main></div></div> });
  const page = (p: string, component: typeof InvoicePage) => createRoute({ getParentRoute: () => rootRoute, path: p, component });
  const router = createRouter({ routeTree: rootRoute.addChildren([page('/sales/invoices/$id', InvoicePage), page('/sales/estimates/$id', EstimatePage), page('/sales/credit-notes/$id', CreditNotePage)]), history: createMemoryHistory({ initialEntries: [path] }) });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  qc.setQueryData(sessionQueryOptions.queryKey, { user: { id: 'u', name: 'Owner', version: 1 }, roles: [{ role: 'owner' }], permissions: ['sales.invoice.view', 'sales.invoice.reprint'] });
  const root = document.createElement('div'); root.id = 'root'; document.body.appendChild(root);
  render(<QueryClientProvider client={qc}><I18nProvider initial="en-IN"><RouterProvider router={router} /></I18nProvider></QueryClientProvider>, { container: root });
}

async function printReceiptFromInvoicePage(doc: SalesPrintDocument) {
  routes = { 'GET /api/v1/sales/invoices/inv-1': invoice(), 'GET /api/v1/sales/invoices/inv-1/payments': { receipts: [doc.document] }, 'POST /api/v1/sales/invoices/inv-1/payments/r1/prints': doc };
  mountAt('/sales/invoices/inv-1', doc.paper, doc.language as 'en' | 'ta');
  await screen.findByTestId('invoice-detail');
  fireEvent.click(await screen.findByText(en['sales.print.receiptAction']));
  const preview = await screen.findByTestId('receipt-print-preview');
  expect(preview.parentElement).toBe(document.body); // the real portal, after #root
  return preview;
}

const RECEIPTS = [
  { language: 'ta', paper: 'thermal_80mm', copy: 'original', kind: 'collection' },
  { language: 'ta', paper: 'thermal_80mm', copy: 'duplicate', kind: 'collection' },
  { language: 'en', paper: 'A4', copy: 'original', kind: 'collection' },
  { language: 'en', paper: 'A4', copy: 'duplicate', kind: 'collection' },
  { language: 'ta', paper: 'thermal_80mm', copy: 'original', kind: 'reversal' },
  { language: 'en', paper: 'A4', copy: 'duplicate', kind: 'reversal' },
] as const;
for (const v of RECEIPTS) it(`B-1 Chromium: receipt ${v.kind} ${v.language}/${v.paper} ${v.copy.toUpperCase()} from the invoice page prints exactly one ${v.paper} page, no Letter page`, async () => {
  const doc = receiptPrint(v);
  // Duplicate receipts: the server answers the first POST with the logged DUPLICATE (as after an earlier ORIGINAL).
  await printReceiptFromInvoicePage(doc);
  const preview = screen.getByTestId('receipt-print-preview');
  fireEvent.click(within(preview).getByTestId('print-button'));
  await waitFor(() => expect(printer.print).toHaveBeenCalledOnce());
  expect(within(preview).getByTestId('receipt-doc').dataset.paper).toBe(v.paper);
  const result = await printPdf(document.body.innerHTML);
  expect(result.root).toBe('none');
  expect(result.testid).toBe('receipt-doc');
  expectSinglePage(result, v.paper);
}, 60000);

it.runIf(built)('B-1 control (compiled CSS): without the preview isolation the same DOM reproduces Ratchet\'s leading Letter page', async () => {
  const doc = receiptPrint(RECEIPTS[0]);
  await printReceiptFromInvoicePage(doc);
  fireEvent.click(within(screen.getByTestId('receipt-print-preview')).getByTestId('print-button'));
  await waitFor(() => expect(printer.print).toHaveBeenCalledOnce());
  const legacy = document.body.innerHTML.replace('data-testid="receipt-print-preview"', 'data-testid="receipt-print-preview-legacy"');
  const result = await printPdf(legacy);
  expect(result.pages).toBeGreaterThan(1);
  expect(near(result.boxes[0]?.[2], LETTER[0]) && near(result.boxes[0]?.[3], LETTER[1])).toBe(true);
}, 60000);

it('B-1 Chromium: invoice printed while a receipt preview is open hides the preview and prints exactly one A4 page', async () => {
  const receipt = receiptPrint(RECEIPTS[2]);
  await printReceiptFromInvoicePage(receipt);
  routes['POST /api/v1/sales/invoices/inv-1/prints'] = printDoc({ template_id: PIN.invoice });
  const panels = screen.getAllByTestId('print-panel'); const invoicePanel = panels.find((p) => !p.closest('[data-testid="receipt-print-preview"]'));
  if (!invoicePanel) throw new Error('invoice panel');
  fireEvent.click(within(invoicePanel).getByTestId('print-button'));
  await waitFor(() => expect(printer.print).toHaveBeenCalledOnce());
  const result = await printPdf(document.body.innerHTML);
  expect(result.root).not.toBe('none');
  expect(result.testid).toBe('sales-doc');
  expectSinglePage(result, 'A4');
}, 60000);

const OTHERS = [
  { kind: 'invoice', path: '/sales/invoices/inv-1', get: ['GET /api/v1/sales/invoices/inv-1', invoice()], post: 'POST /api/v1/sales/invoices/inv-1/prints', doc: () => printDoc({ template_id: PIN.invoice }) },
  { kind: 'estimate', path: '/sales/estimates/est-1', get: ['GET /api/v1/sales/estimates/est-1', estimate({ print_count: 0 })], post: 'POST /api/v1/sales/estimates/est-1/prints', doc: () => { const e = estimate({ print_count: 0 }); return printDoc({ doc_type: 'estimate', document: e, snapshot: e, template_id: PIN.estimate } as Partial<SalesPrintDocument>); } },
  { kind: 'credit_note', path: '/sales/credit-notes/cn-1', get: ['GET /api/v1/sales/credit-notes/cn-1', cn()], post: 'POST /api/v1/sales/credit-notes/cn-1/prints', doc: () => { const c = cn(); return printDoc({ doc_type: 'credit_note', document: c, snapshot: c, template_id: PIN.credit_note } as Partial<SalesPrintDocument>); } },
] as const;
for (const o of OTHERS) it(`B-1 Chromium: ${o.kind} printed from its page is exactly one A4 page with no leading Letter page`, async () => {
  routes = { [o.get[0]]: o.get[1], 'GET /api/v1/sales/invoices/inv-1/payments': { receipts: [] }, [o.post]: o.doc() };
  mountAt(o.path, 'A4', 'en');
  fireEvent.click(await screen.findByTestId('print-button'));
  await waitFor(() => expect(printer.print).toHaveBeenCalledOnce());
  const result = await printPdf(document.body.innerHTML);
  expect(result.testid).toBe('sales-doc');
  expectSinglePage(result, 'A4');
}, 60000);
