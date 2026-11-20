/**
 * Sales API — pinned contract 0.9.6 (verified backend commit object fd3307b4; VPS source correspondence is checksum-based), generated Orval client (`@/lib/api/backend/sales/sales`). Screens import ONLY from
 * here. Every /v1/sales route is contract-only on dev (404) until the backend module ships: `isSalesOff` turns that into the
 * friendly "Billing isn't switched on yet" state instead of an error.
 *
 *  - Idempotency-Key (one per attempt, `useAttemptKey`) on issue, payment receipts, cancellation, returns, estimate create and
 *    every print. If-Match on estimate PUT and cancel. Preview has no key (no side effects).
 *  - The server owns every amount: the bill screen shows POST /preview (debounced) and sends expected_total = the preview's
 *    totals.net_payable; 422 expected_total_mismatch → re-preview and ask the user to confirm the new total.
 */
import { ApiError, ifMatch, ok } from '@/lib/api/fetcher';
import { checkedSalesWire } from './wire';
import * as G from '@/lib/api/backend/sales/sales';
import type {
  PreviewBillRequest, ReceiptReversalRequest, SalesSettingsPatch, CancelInvoiceRequest, CheckSellableParams, Estimate, EstimateRequest, IssueInvoiceRequest, ListCreditNotesParams, ListEstimatesParams,
  ListInvoicesParams, PaymentReceiptRequest, SalesPrintRequest, SalesReturnRequest,
} from '@/lib/api/backend/model';

/**
 * 404 (no code / route_not_found / not_found) or 501 on a Sales *module* read (settings, lists): the module isn't routed on this
 * server yet (0.9.1 is contract-only). Never used on the scan box, where 404 not_found means "no such tag".
 */
export const isSalesOff = (e: unknown): boolean =>
  e instanceof ApiError && (e.status === 501 || (e.status === 404 && (!e.code || e.code === 'route_not_found' || e.code === 'not_found')));

/** Contract lists: limit 1–200, default 50. */
export const SALES_PAGE = 50;
const idem = (key: string) => ({ 'Idempotency-Key': key });
export type SalesDocType = 'invoice' | 'credit_note' | 'estimate' | 'payment_receipt';

export const salesKeys = {
  all: ['sales'] as const,
  settings: (branchId?: string) => ['sales', 'settings', branchId ?? null] as const,
  readiness: (branchId: string) => ['sales', 'readiness', branchId] as const,
  preview: (body: string) => ['sales', 'preview', body] as const,
  invoices: (p: ListInvoicesParams) => ['sales', 'invoices', p] as const,
  invoice: (id: string) => ['sales', 'invoice', id] as const,
  payments: (id: string) => ['sales', 'invoice', id, 'payments'] as const,
  prints: (id: string) => ['sales', 'invoice', id, 'prints'] as const,
  estimates: (p: ListEstimatesParams) => ['sales', 'estimates', p] as const,
  estimate: (id: string) => ['sales', 'estimate', id] as const,
  creditNotes: (p: ListCreditNotesParams) => ['sales', 'credit-notes', p] as const,
  creditNote: (id: string) => ['sales', 'credit-note', id] as const,
};

export const salesApi = {
  readiness: (branchId: string) => ok(G.getBillingReadiness({ branch_id: branchId })),
  settings: (branchId?: string) => ok(G.getSalesSettings(branchId ? { branch_id: branchId } : undefined)),
  patchSettings: (body: SalesSettingsPatch, version: number) => ok(G.patchSalesSettings(checkedSalesWire(body), ifMatch(version))),
  reversePayment: (id: string, receiptId: string, body: ReceiptReversalRequest, key: string) => ok(G.reverseInvoicePayment(id, receiptId, body, idem(key))),
  sellable: (code: string, p: CheckSellableParams) => ok(G.checkSellable(encodeURIComponent(code.trim()), p)),
  preview: (body: PreviewBillRequest) => ok(G.previewBill(checkedSalesWire(body))),
  issue: (body: IssueInvoiceRequest, key: string) => ok(G.issueInvoice(checkedSalesWire(body), idem(key))),
  invoices: (p: ListInvoicesParams) => ok(G.listInvoices({ limit: SALES_PAGE, ...p })),
  invoice: (id: string) => ok(G.getInvoice(id)),
  payments: (id: string) => ok(G.listInvoicePayments(id)),
  receivePayment: (id: string, body: PaymentReceiptRequest, key: string) => ok(G.receiveInvoicePayment(id, checkedSalesWire(body), idem(key))),
  cancel: (id: string, body: CancelInvoiceRequest, key: string) => ok(G.cancelInvoice(id, body, idem(key))),
  returnLines: (id: string, body: SalesReturnRequest, key: string) => ok(G.returnInvoiceLines(id, body, idem(key))),
  printReceipt: (invoiceId: string, receiptId: string, body: SalesPrintRequest, key: string) => ok(G.printPaymentReceipt(invoiceId, receiptId, idem(key), body)),
  printInvoice: (id: string, body: SalesPrintRequest, key: string) => ok(G.printInvoice(id, body, idem(key))),
  prints: (id: string) => ok(G.listInvoicePrints(id)),
  estimates: (p: ListEstimatesParams) => ok(G.listEstimates({ limit: SALES_PAGE, ...p })),
  estimate: (id: string) => ok(G.getEstimate(id)),
  createEstimate: (body: EstimateRequest, key: string) => ok(G.createEstimate(checkedSalesWire(body), idem(key))),
  replaceEstimate: (e: Pick<Estimate, 'id' | 'version'>, body: EstimateRequest) => ok(G.replaceEstimate(e.id, checkedSalesWire(body), ifMatch(e.version))),
  cancelEstimate: (e: Pick<Estimate, 'id' | 'version'>) => ok(G.cancelEstimate(e.id, ifMatch(e.version))),
  printEstimate: (id: string, body: SalesPrintRequest, key: string) => ok(G.printEstimate(id, body, idem(key))),
  creditNotes: (p: ListCreditNotesParams) => ok(G.listCreditNotes({ limit: SALES_PAGE, ...p })),
  creditNote: (id: string) => ok(G.getCreditNote(id)),
  printCreditNote: (id: string, body: SalesPrintRequest, key: string) => ok(G.printCreditNote(id, body, idem(key))),
  print: (doc: SalesDocType, id: string, body: SalesPrintRequest, key: string, invoiceId?: string) =>
    doc === 'payment_receipt' ? (invoiceId ? salesApi.printReceipt(invoiceId, id, body, key) : Promise.reject(new ApiError(400, 'bad_request', 'Missing receipt invoice'))) : doc === 'invoice' ? salesApi.printInvoice(id, body, key) : doc === 'credit_note' ? salesApi.printCreditNote(id, body, key) : salesApi.printEstimate(id, body, key),
};
