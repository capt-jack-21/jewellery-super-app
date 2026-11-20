import type { SalesPrintDocument, SalesUnprocessableProblemAllOfRecovery } from '@/lib/api/backend/model';
import { ApiError } from '@/lib/api/fetcher';
import { SEEDED_TEMPLATE_PINS, type SeededTemplatePin } from './templates';

/**
 * Contract 0.9.6 (final, fd3307b4 / 04f43a42…): template provenance on SalesPrintDocument and the pinned-template recovery.
 * - template_repinned (boolean) + repinned_from ({template_id, template_version} | null): a recovery reprint (copy=duplicate + reprint_reason)
 *   of a document whose ORIGINAL pin is not renderable; the response pin is then the doc type's 998 platform default v1.
 * - template_fallback_from ({template_id, template_version} | null): FIRST print only; the shop's active non-renderable template was
 *   skipped and the doc type's platform default v1 used. Null on every reprint.
 * Rendering still resolves the response's own template_id + template_version through the uuid+version resolver (unknown ids fail closed).
 * Fields are required in 0.9.6; an older payload without them is treated as "no re-pin / no fallback".
 */
export interface TemplateRef096 { template_id: string; template_version: number }
export type TemplateNotice096 = { kind: 'repinned' | 'fallback'; from: TemplateRef096 } | null;

const invalid = () => new ApiError(422, 'print_template_repin_invalid', 'Inconsistent template provenance');
const bundledKind = (t: SalesPrintDocument['doc_type']) => (t === 'payment_receipt' ? 'receipt' : t);

/** Renderable = exactly one of the four 998 platform pins (uuid, v1, doc_type). */
export function platformPin096(docType: SalesPrintDocument['doc_type']): SeededTemplatePin | undefined {
  return SEEDED_TEMPLATE_PINS.find((p) => p.doc_type === bundledKind(docType) && p.version === 1);
}
const isPlatformPinFor = (docType: SalesPrintDocument['doc_type'], ref: TemplateRef096) => {
  const pin = platformPin096(docType); return !!pin && pin.id === ref.template_id && pin.version === ref.template_version;
};
function ref(value: unknown): TemplateRef096 | null | 'bad' {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return 'bad';
  const { template_id, template_version } = value as Record<string, unknown>;
  if (typeof template_id !== 'string' || !template_id || typeof template_version !== 'number' || !Number.isInteger(template_version) || template_version < 1) return 'bad';
  return { template_id, template_version };
}

/** Validates the 0.9.6 provenance fields; returns the note to show (re-pinned or fallback) or null. Throws (fail closed) when inconsistent. */
export function templateNotice096(doc: SalesPrintDocument): TemplateNotice096 {
  const raw = doc as Partial<Pick<SalesPrintDocument, 'template_repinned' | 'repinned_from' | 'template_fallback_from'>> & SalesPrintDocument;
  const repinned = raw.template_repinned ?? false;
  if (typeof repinned !== 'boolean') throw invalid();
  const from = ref(raw.repinned_from), fallback = ref(raw.template_fallback_from);
  if (from === 'bad' || fallback === 'bad') throw invalid();
  if (repinned !== (from !== null)) throw invalid();
  const current = { template_id: doc.template_id, template_version: doc.template_version };
  if (from) {
    if (fallback || doc.copy !== 'duplicate' || !isPlatformPinFor(doc.doc_type, current)) throw invalid();
    if (from.template_id === current.template_id && from.template_version === current.template_version) throw invalid();
    return { kind: 'repinned', from };
  }
  if (fallback) {
    if (doc.print_no !== 1 || !isPlatformPinFor(doc.doc_type, current)) throw invalid();
    if (fallback.template_id === current.template_id && fallback.template_version === current.template_version) throw invalid();
    return { kind: 'fallback', from: fallback };
  }
  return null;
}

/** Back-compat helper: the re-pinned-from template, or null. */
export function repinNotice096(doc: SalesPrintDocument): TemplateRef096 | null {
  const n = templateNotice096(doc); return n?.kind === 'repinned' ? n.from : null;
}

/**
 * 422 pinned_print_template_unavailable (plain reprint of a non-renderable ORIGINAL pin) carries
 * recovery {copy:'duplicate', reprint_reason_required:true, permission:'sales.invoice.reprint', repin_to}. Returns repin_to when it is the
 * matching platform pin, 'invalid' when a recovery is present but inconsistent (fail closed), or null when there is no recovery.
 * NOTE: Orval types reprint_reason_required as the string 'true' (const true in the OpenAPI); the wire value is the boolean true.
 */
export function recovery096(error: unknown, docType: SalesPrintDocument['doc_type']): TemplateRef096 | 'invalid' | null {
  if (!(error instanceof ApiError) || error.status !== 422 || error.code !== 'pinned_print_template_unavailable') return null;
  const rec = error.problem?.recovery as SalesUnprocessableProblemAllOfRecovery | undefined | null;
  if (rec === undefined || rec === null) return null;
  if (typeof rec !== 'object' || rec.copy !== 'duplicate' || (rec.reprint_reason_required as unknown) !== true || rec.permission !== 'sales.invoice.reprint') return 'invalid';
  const to = ref(rec.repin_to);
  if (!to || to === 'bad' || !isPlatformPinFor(docType, to)) return 'invalid';
  return to;
}

/** The recovery reprint must come back re-pinned to exactly the announced repin_to. */
export function assertRecoveredPin096(doc: SalesPrintDocument, repinTo: TemplateRef096) {
  const n = templateNotice096(doc);
  if (n?.kind !== 'repinned' || doc.template_id !== repinTo.template_id || doc.template_version !== repinTo.template_version) throw invalid();
}
