/** Active 0.9.3 helpers, isolated from React and request transport for the next contract re-pin. */
import type { PrintCopy, SalesPrintRequest, SalesPrintRequestCopy } from '@/lib/api/backend/model';
import { D } from '@/lib/format';

export type PlannedCopyRequest = SalesPrintRequestCopy;
export const needsReason093 = (count: number, cancelled: boolean, copy: PlannedCopyRequest = 'auto') => cancelled || copy === 'duplicate' || count > 0;
export const canRequestDuplicate093 = (count: number, cancelled: boolean) => cancelled || count > 0;
export function printBody093(o: Pick<SalesPrintRequest, 'paper' | 'language' | 'numerals' | 'copy'> & { count: number; cancelled: boolean; reason: string }): SalesPrintRequest {
  const needsReason = needsReason093(o.count, o.cancelled, o.copy);
  const reason = o.reason.trim();
  if (o.copy === 'duplicate' && !canRequestDuplicate093(o.count, o.cancelled)) throw new Error('first_print_duplicate_not_supported');
  if (needsReason && (reason.length < 3 || reason.length > 200)) throw new Error('reprint_reason_required');
  return { ...(o.paper ? { paper: o.paper } : {}), ...(o.language ? { language: o.language } : {}), ...(o.numerals ? { numerals: o.numerals } : {}),
    ...(o.copy ? { copy: o.copy } : {}), ...(needsReason ? { reprint_reason: reason } : {}) };
}
/** Responses AND log rows: never infer copy from print_no or the invoice's current status. */
export function printBadges093(row: { copy: PrintCopy; doc_cancelled: boolean }) {
  if (row.doc_cancelled && row.copy !== 'duplicate') throw new Error('cancelled_original_protocol_error');
  return { copy: row.copy, stamp: row.doc_cancelled ? 'CANCELLED' : row.copy === 'duplicate' ? 'DUPLICATE' : null };
}
export const validPieces093 = (kind: 'tag' | 'loose', pieces: number, netWeight: string) =>
  Number.isInteger(pieces) && pieces >= (kind === 'loose' ? 0 : 1) && /^\d+\.\d{3}$/.test(netWeight) && D(netWeight).gt(0);
