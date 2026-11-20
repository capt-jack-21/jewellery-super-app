import { one, many, asWriter, audit, iso } from './db';
import { isReleaseRenderablePin, releasePinFor } from '@jw/db';
import { fail } from './errors';
import { type SalesActor, has, needAny, needBranch } from './actor';
import { V } from './validate';
import { loadShop, printDefaults } from './settings';
import { invoiceView } from './invoices';
import { receiptView, receiptSnapshot } from './receipts';
import { creditNoteView } from './credit-notes';
import { estimateView } from './estimates';
import { wordsPort } from './ports';

/**
 * S19 prints (997). Every print is logged in sales.document_print (sales_writer): live print 1 = ORIGINAL, later = DUPLICATE;
 * cancelled invoices are always DUPLICATE, including print 1 (needs sales.invoice.reprint
 * + reason, 3-200 chars) — estimates need no reprint permission. Audited with print_no / language / numerals / template version (never PAN).
 * The counter renders; amount_in_words follows the print language; unsupported providers fail clearly, never silently English.
 */
type DocType = 'invoice' | 'credit_note' | 'estimate' | 'payment_receipt';
const NUMERALS = ['latin', 'devanagari', 'tamil', 'telugu', 'kannada', 'malayalam', 'bengali', 'gujarati'] as const;

export async function printDoc(a: SalesActor, docType: DocType, id: string, body: unknown, day: string): Promise<Record<string, unknown>> {
  const v = new V(); const o = v.obj(body ?? {}, '', ['paper', 'language', 'numerals', 'reprint_reason', 'copy']);
  const copyIn = v.oneOf(o.copy, 'copy', ['auto', 'duplicate'] as const, { optional: true }) ?? 'auto';
  const paperIn = v.oneOf(o.paper, 'paper', ['A4', 'A5', 'thermal_80mm'] as const, { optional: true });
  const langIn = v.oneOf(o.language, 'language', ['en', 'ta'] as const, { optional: true });
  const numIn = v.oneOf(o.numerals, 'numerals', NUMERALS, { optional: true });
  const reasonRaw = v.str(o.reprint_reason, 'reprint_reason', { optional: true, nullable: true, max: 200 });
  const reasonIn = reasonRaw?.trim() ?? null;
  v.done();
  const tbl = docType === 'invoice' ? 'sales.invoice' : docType === 'credit_note' ? 'sales.credit_note' : docType === 'payment_receipt' ? 'sales.payment_receipt' : 'sales.estimate';
  // Lock order: invoice SHARE before print advisory lock. Cancellation takes invoice UPDATE first and never the print lock.
  // Concurrent prints may share the invoice lock; no print upgrades it, so cancellation cannot overlap or form a lock cycle.
  if (docType === 'estimate') await one(`SELECT id FROM sales.estimate WHERE id = $1 FOR SHARE`, [id]);
  if (docType === 'payment_receipt') {
    const parent = await one<{ invoice_id: string }>(`SELECT invoice_id FROM sales.payment_receipt WHERE id = $1`, [id]);
    if (!parent) fail(404, 'not_found', 'receipt');
    // Same invoice-first lock order as receive/reverse/cancel; protects the live REVERSED envelope stamp.
    await asWriter((c) => c.query(`SELECT id FROM sales.invoice WHERE id = $1 FOR SHARE`, [parent.invoice_id]));
  }
  if (docType === 'invoice') await asWriter((c) => c.query(`SELECT id FROM sales.invoice WHERE id = $1 FOR SHARE`, [id]));
  const head = await one<{ branch_id: string; no: string }>(`SELECT branch_id, ${docType === 'estimate' ? 'estimate_no' : docType === 'payment_receipt' ? 'receipt_no' : 'doc_no'} AS no FROM ${tbl} WHERE id = $1`, [id]);
  if (!head) fail(404, 'not_found', docType.replace('_', ' '));
  if (docType === 'estimate') needAny(a, ['sales.estimate.create', 'sales.invoice.view']);
  else if (docType === 'invoice') needAny(a, ['sales.invoice.issue', 'sales.invoice.view']);
  else needAny(a, ['sales.invoice.view']);
  needBranch(a, head.branch_id);
  // serialise prints of one document (print_no = max + 1; UNIQUE backs it up)
  await one(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`print:${docType}:${id}`]);
  const prev = await one<{ n: number }>(`SELECT coalesce(max(print_no), 0)::int AS n FROM sales.document_print WHERE doc_type = $1 AND doc_id = $2`, [docType, id]);
  const printNo = prev!.n + 1;
  let doc: Record<string, unknown>;
  if (docType === 'invoice') doc = await invoiceView(id);
  else if (docType === 'credit_note') doc = await creditNoteView(id);
  else if (docType === 'payment_receipt') doc = await receiptView(id);
  else doc = await estimateView(a, id, day, false);
  const cancelled = docType === 'invoice' && doc.status === 'cancelled';
  const copy = copyIn === 'duplicate' || cancelled || printNo > 1 ? 'duplicate' : 'original';
  if (copy === 'duplicate' && docType !== 'estimate') {
    if (!has(a, 'sales.invoice.reprint')) fail(403, 'reprint_not_allowed', 'a duplicate print needs sales.invoice.reprint');
  }
  // First-live explicit duplicate precedence (0.9.4 lead ruling): schema-shape, auth, tenant/document existence,
  // normal access and reprint permission are already checked. This wins over ALL subsequent business errors,
  // including missing/short reprint_reason, template configuration and words support. Cancelled invoices are exempt.
  if ((docType === 'invoice' || docType === 'payment_receipt') && !cancelled && printNo === 1 && copyIn === 'duplicate')
    fail(422, 'first_print_duplicate_not_supported', 'a live invoice or receipt must issue ORIGINAL print 1; no print was logged; use copy=auto',
      [{ path: 'copy', code: 'first_print_duplicate_not_supported', message: 'takes precedence over duplicate reason and other print business checks' }]);
  if (langIn && !(await one(`SELECT 1 FROM platform.language WHERE code = $1`, [langIn])))
    fail(422, 'unknown_language', `unknown language ${langIn}`, [{ path: 'language', code: 'unknown_language', message: 'not in platform.language' }]);
  const reprint = copy === 'duplicate';
  if (reprint && (!reasonIn || reasonIn.length < 3))
    fail(422, 'reprint_reason_required', 'a reprint needs a reason (3-200 characters)', [{ path: 'reprint_reason', code: 'reprint_reason_required', message: 'required' }]);
  // 997 permits duplicate print 1 ONLY for cancelled invoices; never fabricate an unrendered original to skip this guard.
  if (copy === 'duplicate' && printNo === 1 && !cancelled)
    fail(422, 'first_print_duplicate_not_supported', 'the current schema requires the first print of a live invoice, credit note or estimate to be ORIGINAL; use copy=auto',
      [{ path: 'copy', code: 'first_print_duplicate_not_supported', message: 'no print was logged; a subsequent auto request will be ORIGINAL print 1' }]);
  const reason = copy === 'duplicate' ? (reasonIn && reasonIn.length >= 3 ? reasonIn : 'estimate reprint') : null;
  const shop = await loadShop();
  const firstPrint = await one<{ template_id: string | null; template_version: number | null; language: string | null; numerals: string | null }>(`SELECT template_id, template_version, language, numerals FROM sales.document_print WHERE doc_type = $1 AND doc_id = $2 ORDER BY print_no LIMIT 1`, [docType, id]);
  const tplDoc = docType === 'payment_receipt' ? 'receipt' : docType;
  // B-2 (0.9.6): the release FE renders only the exact 998 platform pins. A first print pinned to anything else can never be
  // rendered again. Recovery: an EXPLICIT copy=duplicate + reprint_reason (sales.invoice.reprint) re-pins THIS reprint to the
  // doc type's platform default; the ORIGINAL row stays append-only, the frozen snapshot is unchanged, and a renderable pin is never re-pinned.
  let repinnedFrom: { template_id: string | null; template_version: number | null } | null = null;
  let pin = firstPrint;
  if (firstPrint && !isReleaseRenderablePin(tplDoc, firstPrint.template_id, firstPrint.template_version)) {
    const from = { template_id: firstPrint.template_id, template_version: firstPrint.template_version };
    const target = releasePinFor(tplDoc)!;
    const repinTo = { template_id: target.template_id, template_version: target.version };
    if (copyIn !== 'duplicate') fail(422, 'pinned_print_template_unavailable',
      'the first print is pinned to a template this release cannot render; no print was logged. Recovery: resend with copy=duplicate and a reprint_reason (needs sales.invoice.reprint) to re-pin this reprint to the platform default template',
      [{ path: 'copy', code: 'print_template_not_renderable', message: `send copy=duplicate with reprint_reason to re-pin to ${repinTo.template_id} v${repinTo.template_version}` }],
      { unrenderable_template: from, recovery: { copy: 'duplicate', reprint_reason_required: true, permission: 'sales.invoice.reprint', repin_to: repinTo } });
    if (!has(a, 'sales.invoice.reprint')) fail(403, 'reprint_not_allowed', 're-pinning a reprint to the platform default needs sales.invoice.reprint');
    repinnedFrom = from;
    pin = { ...firstPrint, template_id: repinTo.template_id, template_version: repinTo.template_version };
  }
  const defs = await printDefaults(tplDoc, pin);
  if (!defs.template_id || !defs.template_version) fail(422, 'print_template_not_configured',
    firstPrint ? 'the original print has no pinned template; cannot silently substitute a current template' : 'configure an active template for this document type before printing',
    [{ path: 'template_id', code: 'print_template_not_configured', message: 'a real template ID and version are required' }]);
  // 1(a): a first print whose active template is not a release pin was resolved to the platform default (defs.fallback_from).
  const fallbackFrom = firstPrint ? null : defs.fallback_from;
  // Backstop (unreachable after the 1(a) fallback): the EFFECTIVE first-print template must be a release pin, or nothing is logged.
  if (!firstPrint && !isReleaseRenderablePin(tplDoc, defs.template_id, defs.template_version)) {
    const fallback = releasePinFor(tplDoc);
    fail(422, 'print_template_not_renderable',
      `the active ${tplDoc} template ${defs.template_id} v${defs.template_version} cannot be rendered in this release; no print was logged. Deactivate the custom template so the platform default applies`,
      [{ path: 'template_id', code: 'print_template_not_renderable', message: fallback ? `renderable: ${fallback.template_id} v${fallback.version}` : 'no renderable template' }],
      { unrenderable_template: { template_id: defs.template_id, template_version: defs.template_version } });
  }
  // The public render projection belongs to the semantic print audit, in the SAME transaction as document_print.
  // audit_event is tenant-RLS, append-only and hash-chained. No revealed PAN: only CustomerSnapshot.pan_last4.
  const prior = await one<{ snapshot: Record<string, unknown> }>(`SELECT new_row->'snapshot' AS snapshot FROM platform.audit_event
    WHERE tenant_id = platform.current_tenant() AND row_id = $1 AND table_name = $2 AND action = $3
      AND new_row->>'snapshot_version' = '1' ORDER BY seq LIMIT 1`, [id, tbl, `sales.${docType}.print`]);
  if (firstPrint && !prior?.snapshot && docType === 'estimate') fail(422, 'print_snapshot_unavailable',
    'this legacy estimate print has no frozen projection; its original editable revision cannot be reconstructed safely');
  const snapshot = prior?.snapshot ?? (docType === 'invoice' ? await invoiceView(id, true)
    : docType === 'payment_receipt' ? await receiptSnapshot(id)
    : docType === 'credit_note' ? { ...doc, balance_available: doc.store_credit_amount, print_count: 0, last_printed_at: null }
    : { ...doc, status: 'draft', invoice_id: null, print_count: 0, last_printed_at: null });
  if (docType === 'invoice' && !snapshot.seller) fail(422, 'invoice_print_snapshot_missing', 'original invoice has no seller snapshot; never fall back to live masters');
  const paper = paperIn ?? shop.default_paper;
  const language = langIn ?? defs.language;
  const numerals = numIn ?? defs.numerals;
  // Legacy/provider backstop: even a stored en-IN must not bypass the exact en/ta API setting boundary.
  if (!['en', 'ta'].includes(language)) fail(422, 'print_language_not_supported', 'print language must be en or ta; no silent English fallback');
  const r = await asWriter((c) => c.query<{ at: string }>(`INSERT INTO sales.document_print(tenant_id, branch_id, doc_type, doc_id, print_no, copy, paper, language, numerals,
      template_id, template_version, reprint_reason, printed_by, doc_cancelled) VALUES (platform.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    RETURNING ${iso('printed_at', 'at')}`, [head.branch_id, docType, id, printNo, copy, paper, language, numerals, defs.template_id, defs.template_version, reason, a.userId, cancelled]));
  const amount = docType === 'credit_note' || docType === 'payment_receipt' ? snapshot.total as string
    : docType === 'invoice' ? (snapshot.totals as { net_payable: string }).net_payable
    : ((snapshot.computation as { totals?: { net_payable?: string } }).totals?.net_payable ?? '0.00');
  let inWords: string;
  try { inWords = wordsPort()(amount.replace(/^-/, ''), `${language.slice(0, 2)}-IN`); } catch { fail(422, 'print_language_not_supported', 'amount words are not supported for the requested print language; choose en or ta', [{ path: 'language', code: 'print_language_not_supported', message: 'no silent English fallback' }]); }
  const notes: string[] = [];
  if (docType === 'invoice' && doc.zero_gst) notes.push(`${(await one<{ note: string }>(`SELECT zero_gst_print_note AS note FROM sales.invoice WHERE id = $1`, [id]))?.note ?? shop.zero_gst_print_note}${doc.zero_gst_reason ? `: ${doc.zero_gst_reason}` : ''}`);
  if (cancelled) {
    const cn = await one<{ doc_no: string }>(`SELECT doc_no FROM sales.credit_note WHERE id = $1`, [doc.cancel_credit_note_id]);
    notes.push(`Cancelled by credit note ${cn?.doc_no ?? ''}`.trim());
  }
  const receiptReversed = docType === 'payment_receipt' && !!doc.reversed_by_receipt_id;
  const receiptReversal = docType === 'payment_receipt' && !!doc.reverses_receipt_id;
  if (receiptReversed) notes.push('REVERSED — this collection was reversed; not an active payment');
  if (receiptReversal) notes.push('REVERSAL RECEIPT — negative total restores the due, no collection/tenders; words show the absolute reversed amount');
  if (docType === 'estimate') notes.push('ESTIMATE — NOT A TAX INVOICE');
  if (docType === 'credit_note' && doc.kind === 'receipt_reversal') notes.push('Store credit from a reversed payment — not a GST credit note');
  await audit(`sales.${docType}.print`, tbl, id, { doc_no: head.no, print_no: printNo, copy, doc_cancelled: cancelled, paper, language, numerals,
    template_id: defs.template_id, template_version: defs.template_version, snapshot_version: 1, snapshot, template_repinned: !!repinnedFrom, repinned_from: repinnedFrom, template_fallback_from: fallbackFrom });
  if (fallbackFrom) await audit(`sales.${docType}.print_template_fallback`, tbl, id, { doc_no: head.no, print_no: printNo,
    from: fallbackFrom, to: { template_id: defs.template_id, template_version: defs.template_version } });
  if (repinnedFrom) await audit(`sales.${docType}.print_template_repinned`, tbl, id, { doc_no: head.no, print_no: printNo, reason,
    from: repinnedFrom, to: { template_id: defs.template_id, template_version: defs.template_version } });
  if (docType !== 'payment_receipt') { doc.print_count = printNo; doc.last_printed_at = r.rows[0].at; }
  return { doc_type: docType, doc_id: id, doc_no: head.no, copy, doc_cancelled: cancelled, stamp: cancelled ? 'CANCELLED' : receiptReversed ? 'REVERSED' : receiptReversal ? 'REVERSAL' : copy === 'duplicate' ? 'DUPLICATE' : docType === 'estimate' ? 'ESTIMATE' : null,
    print_no: printNo, printed_at: r.rows[0].at, printed_by: a.userId, paper, language, locale: `${language.slice(0, 2)}-IN`, numerals, template_id: defs.template_id, template_version: defs.template_version,
    amount_in_words: inWords, notes, snapshot, document: doc, template_repinned: !!repinnedFrom, repinned_from: repinnedFrom, template_fallback_from: fallbackFrom };
}
export async function printLog(a: SalesActor, docType: DocType, id: string): Promise<Record<string, unknown>[]> {
  needAny(a, ['sales.invoice.view']);
  const tbl = docType === 'invoice' ? 'sales.invoice' : docType === 'credit_note' ? 'sales.credit_note' : docType === 'payment_receipt' ? 'sales.payment_receipt' : 'sales.estimate';
  const h = await one<{ branch_id: string }>(`SELECT branch_id FROM ${tbl} WHERE id = $1`, [id]);
  if (!h) fail(404, 'not_found', docType);
  needBranch(a, h.branch_id);
  return many(`SELECT print_no, copy, doc_cancelled, ${iso('printed_at', 'printed_at')}, printed_by, paper, coalesce(language, 'en') AS language, left(coalesce(language, 'en'), 2) || '-IN' AS locale, coalesce(numerals, 'latin') AS numerals,
      template_id, template_version, reprint_reason FROM sales.document_print WHERE doc_type = $1 AND doc_id = $2 ORDER BY print_no`, [docType, id]);
}
