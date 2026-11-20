/** Type-only compatibility for the frozen 0.9.4 renderer's structural oneOf guard.
 * A receipt can never carry an estimate number. Adding the absent key as optional never
 * preserves that truth and allows old frozen source to compile as the wire union grows.
 * No runtime data, wire fields or shipped renderer bytes are changed.
 */
import '@/lib/api/backend/model/paymentReceiptPrintSnapshot';
declare module '@/lib/api/backend/model/paymentReceiptPrintSnapshot' {
  interface PaymentReceiptPrintSnapshot { estimate_no?: never }
}
