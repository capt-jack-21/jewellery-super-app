/** Immutable renderer dispatch. Both families are bundled in JS; receipt has NO API route yet. */
import { SalesPrintTemplateV1 } from './template-v1';
import { ReceiptPrintTemplateV1 } from './receipt-template-v1';
export const BUNDLED_RENDERERS_V1 = Object.freeze({
  'sales-gst-v1': SalesPrintTemplateV1,
  'receipt-v1': ReceiptPrintTemplateV1,
});
