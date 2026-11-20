/** Shared labelling for the owner alert and credit-note surfaces. Payment reversals are NOT GST credit notes. */
import type { CreditNote, CreditNoteKind } from '@/lib/api/backend/model';
import type { MessageKey } from '@/i18n';
export const SALES_ALERT_LABELS: Readonly<Record<string, MessageKey>> = {
  receipt_reversal: 'sales.creditNote.kind.receipt_reversal',
  'alert.receipt_reversal': 'sales.creditNote.kind.receipt_reversal',
};
export const CREDIT_NOTE_KINDS: readonly CreditNoteKind[] = ['cancellation', 'sales_return', 'receipt_reversal'];
export const creditNoteAmount = (c: Pick<CreditNote, 'kind' | 'total' | 'store_credit_amount'>) => c.kind === 'receipt_reversal' ? c.store_credit_amount : c.total;
/** GST / CDN report consumers must use this predicate (receipt reversals have no supply or tax). */
export const isGstCreditNote = (c: Pick<CreditNote, 'kind'>) => c.kind !== 'receipt_reversal';
