/** Sales service surface (framework-free; the HTTP layer lives in apps/api/src/sales). */
export { SalesError, type FieldError } from './internal/errors';
export { type SalesActor } from './internal/actor';
export { registerSalesPorts, type StockPort, type CustomerPort, type WordsPort, type SaleTagRow, type CustomerRow, type ReturnRow, type LooseQty, type StockCtx } from './internal/ports';
export { getSettings, patchSettings } from './internal/settings';
export { issueRepairInvoice, type RepairInvoiceInput } from './internal/repair-bill';
export { preview, issueInvoice, issueOrderInvoice, type OrderInvoiceInput, getInvoice, invoiceView, listInvoices, docSeries } from './internal/invoices';
export { receivePayment, reverseReceipt, reversalView, receiptView, invoicePayments } from './internal/receipts';
export { cancelInvoice, returnLines, getCreditNote, creditNoteView, listCreditNotes, gstCreditNotes, GST_CN_KINDS, CN_KINDS } from './internal/credit-notes';
export { createEstimate, replaceEstimate, cancelEstimate, getEstimate, listEstimates, estimateView } from './internal/estimates';
export { printDoc, printLog } from './internal/prints';
export { readiness, sellable } from './internal/readiness';
export { computeBill, type BillInput, type BillResult } from './internal/engine';
export { allocateGapless, allocateDocNo } from './internal/numbering';
export { authorizeIdempotent } from './internal/access';
export { takeAdvance, advanceView, listAdvances, listRepairAdvances, type AdvanceInput, type AdvanceView } from './internal/advances';
