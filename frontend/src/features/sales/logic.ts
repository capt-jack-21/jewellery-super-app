/**
 * Sales — pure rules (no React, unit-tested). The server is authoritative for every amount; these helpers only shape requests,
 * check what the counter typed before sending, and map server answers to plain-language messages.
 */
import { ApiError } from '@/lib/api/fetcher';
import { printBody093, validPieces093 } from './contract-093-prep';
import { D } from '@/lib/format';
import type {
  BillComputation, PreviewBillRequest, ReturnRefundMode, BillRequirements, EstimateRef, Invoice, IssueInvoiceRequest, EstimateRequest, OldGoldInput, PricedLine,
  SaleLineInput, SalesPrintRequest, SalesSettings, SalesTenderMode, TenderInput,
} from '@/lib/api/backend/model';

/* ------------------------------------------------------------------ money ------------------------------------------------------------------ */

/** Typed rupees → "1234.50" (2 dp) or null when empty / not a positive-or-zero amount. Accepts "1,23,456.5" and "₹500". */
export function moneyInput(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/[₹,\s]/g, '');
  if (!/^\d{1,10}(\.\d{0,2})?$/.test(s)) return null;
  return D(s).toFixed(2);
}
/** Typed grams → "12.345" (3 dp) or null. */
export function weightInput(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/[,\sg]/g, '');
  if (!/^\d{1,7}(\.\d{0,3})?$/.test(s)) return null;
  return D(s).toFixed(3);
}
const dec = (v: string | null | undefined) => {
  try { return D(v && v.trim() ? v : '0'); } catch { return D('0'); }
};
export const sumMoney = (xs: ReadonlyArray<string | null | undefined>): string => xs.reduce((a, x) => a.add(dec(x)), D('0')).toFixed(2);
export const subMoney = (a: string | null | undefined, b: string | null | undefined): string => dec(a).sub(dec(b)).toFixed(2);
export const isPositive = (v: string | null | undefined) => dec(v).gt(0);

/* ------------------------------------------------------------------ draft ------------------------------------------------------------------ */

export type DraftTagLine = { kind: 'tag'; key: string; tag_id: string; tag_no: string; priced?: PricedLine | null; discount?: string };
export type DraftLooseLine = {
  kind: 'loose'; key: string; item_id: string; purity_id: string; gross_wt: string; net_wt: string; stone_wt?: string; pieces?: number;
  counter_id?: string | null; tray_id?: string | null; description?: string; discount?: string;
};
export type DraftLine = DraftTagLine | DraftLooseLine;
export type DraftOldGold = { key: string; purity_id: string; gross_wt: string; less_wt?: string; touch_pct?: string; description?: string; rate_override?: string; override_reason?: string };
export type DraftTender = { key: string; mode: SalesTenderMode; amount: string; reference?: string; cheque_date?: string; bank_name?: string; credit_note_id?: string };
export type DraftCustomer =
  | { kind: 'none' }
  | { kind: 'existing'; id: string; name: string; phone?: string | null; gstin?: string | null; state_code?: string | null }
  | { kind: 'new'; name: string; phone: string; gstin?: string; state_code?: string };
export type BillDraft = {
  branch_id: string;
  customer: DraftCustomer;
  salesperson_id: string;
  cash_counter_id?: string | null;
  lines: DraftLine[];
  old_metal: DraftOldGold[];
  tenders: DraftTender[];
  bill_discount?: string;
  discount_reason?: string;
  zero_gst?: { on: boolean; reason: string };
  pan?: string;
  excess_payout?: 'cash' | 'bank_transfer';
  /** B2C only: deliver to another state (2-digit state code). B2B always uses the GSTIN state (422 place_of_supply_conflict otherwise). */
  place_of_supply?: string;
  estimates: EstimateRef[];
  notes?: string;
};
export const emptyDraft = (branchId = '', salespersonId = ''): BillDraft => ({
  branch_id: branchId, customer: { kind: 'none' }, salesperson_id: salespersonId, lines: [], old_metal: [], tenders: [], estimates: [],
});

/** PAN as typed → uppercase ABCDE1234F, or null. Write-only: never stored outside the request, never shown back. */
export const panInput = (raw: string | null | undefined): string | null => {
  const s = (raw ?? '').replace(/\s/g, '').toUpperCase();
  return /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(s) ? s : null;
};
export const PHONE_RE = /^[6-9]\d{9}$/;
export const phoneInput = (raw: string | null | undefined): string | null => {
  const s = (raw ?? '').replace(/[\s-]/g, '').replace(/^(\+?91)(?=\d{10}$)/, '');
  return PHONE_RE.test(s) ? s : null;
};

export function toLineInput(l: DraftLine): SaleLineInput {
  const discount = moneyInput(l.discount);
  if (l.kind === 'tag') return { kind: 'tag', tag_id: l.tag_id, ...(discount && isPositive(discount) ? { discount } : {}) } as SaleLineInput;
  const gross = weightInput(l.gross_wt), net = weightInput(l.net_wt), stone = l.stone_wt ? weightInput(l.stone_wt) : undefined;
  if (!gross || !net || (l.stone_wt && !stone)) throw new ApiError(422, 'validation_failed', 'Check the line weights');
  return {
    kind: 'loose', item_id: l.item_id, purity_id: l.purity_id, gross_wt: gross, net_wt: net,
    ...(stone ? { stone_wt: stone } : {}), ...(l.pieces != null ? { pieces: l.pieces } : {}),
    counter_id: l.counter_id ?? null, tray_id: l.tray_id ?? null,
    ...(l.description?.trim() ? { description: l.description.trim() } : {}),
    ...(discount && isPositive(discount) ? { discount } : {}),
  };
}
export function toOldGoldInput(o: DraftOldGold): OldGoldInput | null {
  const gross = weightInput(o.gross_wt);
  if (!gross || !o.purity_id) return null;
  const less = weightInput(o.less_wt);
  const rate = moneyInput(o.rate_override);
  const reason = o.override_reason?.trim();
  return {
    purity_id: o.purity_id, gross_wt: gross,
    ...(less && isPositive(less) ? { less_wt: less } : {}),
    ...(o.touch_pct?.trim() ? { touch_pct: o.touch_pct.trim() } : {}),
    ...(o.description?.trim() ? { description: o.description.trim() } : {}),
    // 0.9.1: rate_override and override_reason travel as a pair (dependentRequired).
    ...(rate && isPositive(rate) && reason ? { rate_override: rate, override_reason: reason } : {}),
  };
}
/** Old-gold rate override pair is complete and valid (rate > 0, reason 5–200) — or both empty. */
export function rateOverrideState(o: Pick<DraftOldGold, 'rate_override' | 'override_reason'>): 'none' | 'ok' | 'incomplete' {
  const r = (o.rate_override ?? '').trim();
  const why = (o.override_reason ?? '').trim();
  if (!r && !why) return 'none';
  const rate = moneyInput(r);
  return rate && isPositive(rate) && textBetween(why, 5, 200) ? 'ok' : 'incomplete';
}
export function toTenderInput(t: DraftTender): TenderInput | null {
  const amount = moneyInput(t.amount);
  if (!amount || !isPositive(amount)) return null;
  return {
    mode: t.mode, amount,
    ...(t.reference?.trim() ? { reference: t.reference.trim() } : {}),
    ...(t.mode === 'cheque' && t.cheque_date ? { cheque_date: t.cheque_date } : {}),
    ...(t.bank_name?.trim() ? { bank_name: t.bank_name.trim() } : {}),
    ...(t.mode === 'credit_note' && t.credit_note_id ? { credit_note_id: t.credit_note_id } : {}),
  };
}

/** What is still missing before the server can price (preview) or issue the bill. Empty = ready. */
export type DraftGap = 'lines' | 'customer' | 'salesperson' | 'branch';
export function draftGaps(d: BillDraft, kind: 'bill' | 'estimate' = 'bill'): DraftGap[] {
  const gaps: DraftGap[] = [];
  if (!d.branch_id) gaps.push('branch');
  if (!d.lines.length) gaps.push('lines');
  if (kind === 'bill' && d.customer.kind === 'none') gaps.push('customer');
  if (kind === 'bill' && !d.salesperson_id) gaps.push('salesperson');
  return gaps;
}

/** The IssueInvoiceRequest for /preview and /invoices (null while draftGaps() is not empty). */
export function toIssueRequest(d: BillDraft, expectedTotal?: string | null): IssueInvoiceRequest | null {
  if (draftGaps(d, 'bill').length) return null;
  const customer = d.customer.kind === 'existing' ? { customer_id: d.customer.id }
    : d.customer.kind === 'new' ? { customer: {
      name: d.customer.name.trim(), phone: d.customer.phone,
      ...(gstinInput(d.customer.gstin) ? { gstin: gstinInput(d.customer.gstin) } : {}),
      ...(stateInput(d.customer.state_code) ?? stateFromGstin(d.customer.gstin) ? { state_code: stateInput(d.customer.state_code) ?? stateFromGstin(d.customer.gstin) } : {}),
    } }
      : {};
  const old = d.old_metal.map(toOldGoldInput).filter((x): x is OldGoldInput => !!x);
  const pays = d.tenders.map(toTenderInput).filter((x): x is TenderInput => !!x);
  const billDiscount = moneyInput(d.bill_discount);
  const pan = panInput(d.pan);
  return {
    branch_id: d.branch_id, salesperson_id: d.salesperson_id, ...customer,
    ...(d.cash_counter_id ? { cash_counter_id: d.cash_counter_id } : {}),
    ...(d.estimates.length ? { estimates: d.estimates.slice(0, MAX_ESTIMATE_MERGE) } : {}),
    ...posField(d),
    lines: d.lines.map(toLineInput),
    ...(billDiscount && isPositive(billDiscount) ? { bill_discount: billDiscount } : {}),
    ...(d.discount_reason?.trim() ? { discount_reason: d.discount_reason.trim() } : {}),
    ...(old.length ? { old_metal: old } : {}),
    ...(old.length && d.excess_payout ? { old_gold_excess_payout: d.excess_payout } : {}),
    payments: pays,
    ...(pan ? { pan } : {}),
    ...(d.zero_gst?.on && d.zero_gst.reason.trim() ? { zero_gst: { reason: d.zero_gst.reason.trim() } } : {}),
    ...(expectedTotal ? { expected_total: moneyInput(expectedTotal) ?? expectedTotal } : {}),
  } as IssueInvoiceRequest;
}
/** Estimate body: the bill shape without payments, PAN, zero_gst, estimates or expected_total; customer optional. */
export function toEstimateRequest(d: BillDraft): EstimateRequest | null {
  if (draftGaps(d, 'estimate').length) return null;
  const old = d.old_metal.map(toOldGoldInput).filter((x): x is OldGoldInput => !!x);
  const billDiscount = moneyInput(d.bill_discount);
  return {
    branch_id: d.branch_id,
    customer_id: d.customer.kind === 'existing' ? d.customer.id : null,
    salesperson_id: d.salesperson_id || null,
    ...posField(d),
    lines: d.lines.map(toLineInput),
    ...(billDiscount && isPositive(billDiscount) ? { bill_discount: billDiscount } : {}),
    ...(d.discount_reason?.trim() ? { discount_reason: d.discount_reason.trim() } : {}),
    ...(old.length ? { old_metal: old } : {}),
    ...(d.notes?.trim() ? { notes: d.notes.trim() } : {}),
  };
}

/** 0.9.2: estimates price with branch + lines alone. Invoice-only checks remain informational there. */
export function toPreviewRequest(d: BillDraft, mode: 'bill' | 'estimate'): PreviewBillRequest | null {
  if (draftGaps(d, mode).length) return null;
  const body = toIssueRequest(mode === 'estimate' ? {
    ...d, customer: d.customer.kind === 'none' ? { kind: 'existing', id: '', name: '' } : d.customer,
    salesperson_id: d.salesperson_id || 'preview-only',
  } : d);
  if (!body) return null;
  const { customer_id: _c, salesperson_id: _s, ...rest } = body;
  return { ...rest, mode: mode === 'bill' ? 'invoice' : 'estimate',
    ...(d.customer.kind === 'existing' ? { customer_id: d.customer.id } : {}),
    ...(d.salesperson_id ? { salesperson_id: d.salesperson_id } : {}),
  };
}
export const invalidGoodsLineIndex = (lines: readonly DraftLine[], priced?: readonly PricedLine[]) => lines.findIndex((l, i) => {
  if (l.kind === 'loose') return !isPositive(weightInput(l.gross_wt)) || !validPieces093('loose', l.pieces ?? 0, weightInput(l.net_wt) ?? '');
  const p = pricedAt(lines, i, priced);
  return !!p && !validPieces093('tag', p.pieces, p.net_wt);
});
export const invoiceOnlyChecks = (c: BillComputation | null): string[] => !c ? [] : [
  ...(c.requirements.pan_required ? ['pan'] : []),
  ...(c.requirements.cash_limit.exceeded ? ['cash_limit'] : []),
  ...(c.requirements.credit_sale_permission ? ['credit_sale'] : []),
];

/* ---------------------------------------------------------------- estimates ---------------------------------------------------------------- */

/** Approved 0.9.1 (per-shop rules live on the server): convert up to 10 draft estimates of one branch and one customer. */
export const MAX_ESTIMATE_MERGE = 10;
export type MergeCandidate = { id: string; version: number; branch_id: string; customer_id: string | null; status: string };
export type MergeProblem = 'too_many' | 'not_draft' | 'branch_mismatch' | 'customer_mismatch' | 'none';
export function mergeProblem(list: readonly MergeCandidate[]): MergeProblem | null {
  if (!list.length) return 'none';
  if (list.length > MAX_ESTIMATE_MERGE) return 'too_many';
  if (list.some((e) => e.status !== 'draft')) return 'not_draft';
  if (new Set(list.map((e) => e.branch_id)).size > 1) return 'branch_mismatch';
  const customers = new Set(list.map((e) => e.customer_id).filter(Boolean));
  if (customers.size > 1) return 'customer_mismatch';
  return null;
}
export const estimateRefs = (list: readonly Pick<MergeCandidate, 'id' | 'version'>[]): EstimateRef[] => list.map((e) => ({ id: e.id, version: e.version }));
/** Prefill a bill from one or more estimates: their saved lines and old gold, the shared customer / salesperson. */
export function draftFromEstimates(base: BillDraft, ests: ReadonlyArray<{ id: string; version: number; request: EstimateRequest; customer_id: string | null; salesperson_id: string | null }>, keyOf: () => string): BillDraft {
  const lines: DraftLine[] = [];
  const old: DraftOldGold[] = [];
  for (const e of ests) {
    for (const l of e.request.lines) {
      if (l.kind === 'tag') {
        const tl = l as { tag_id?: string; tag_no?: string; discount?: string };
        if (tl.tag_id && lines.some((x) => x.kind === 'tag' && x.tag_id === tl.tag_id)) continue;
        lines.push({ kind: 'tag', key: keyOf(), tag_id: tl.tag_id ?? '', tag_no: tl.tag_no ?? '', discount: tl.discount });
      } else {
        const ll = l as DraftLooseLine & { kind: 'loose' };
        lines.push({ ...ll, kind: 'loose', key: keyOf(), counter_id: ll.counter_id ?? null, tray_id: ll.tray_id ?? null });
      }
    }
    for (const o of e.request.old_metal ?? []) old.push({ key: keyOf(), purity_id: o.purity_id, gross_wt: o.gross_wt, less_wt: o.less_wt, touch_pct: o.touch_pct, description: o.description, rate_override: o.rate_override, override_reason: o.override_reason });
  }
  const cust = ests.find((e) => e.customer_id)?.customer_id;
  const sp = ests.find((e) => e.salesperson_id)?.salesperson_id;
  return {
    ...base,
    branch_id: ests[0]?.request.branch_id ?? base.branch_id,
    customer: cust ? { kind: 'existing', id: cust, name: '' } : base.customer,
    salesperson_id: sp ?? base.salesperson_id,
    lines, old_metal: old, estimates: estimateRefs(ests),
  };
}

/* ----------------------------------------------------------------- tenders ----------------------------------------------------------------- */

export type TenderIssue = { index: number | null; code: 'amount_invalid' | 'reference_required' | 'cheque_date_required' | 'credit_note_required' | 'overpayment' | 'too_many' };
/** Modes that need a reference number (UTR / approval / cheque number) before sending. */
export const REFERENCE_MODES: ReadonlySet<SalesTenderMode> = new Set(['cheque', 'bank_transfer']);
export const MAX_TENDERS = 10;
/**
 * Check a split before sending: each typed amount must be a positive rupee value, cheques need number + date, store credit needs
 * its credit note; the total may be less than `due` (part-paid) but never more (422 overpayment on the server).
 * Rows with an empty amount are ignored (not sent).
 */
export function tenderCheck(tenders: readonly DraftTender[], due: string | null | undefined) {
  const issues: TenderIssue[] = [];
  const filled = tenders.map((t, i) => ({ t, i })).filter(({ t }) => t.amount.trim() !== '');
  filled.forEach(({ t, i }) => {
    const a = moneyInput(t.amount);
    if (!a || !isPositive(a)) issues.push({ index: i, code: 'amount_invalid' });
    if (REFERENCE_MODES.has(t.mode) && !t.reference?.trim()) issues.push({ index: i, code: 'reference_required' });
    if (t.mode === 'cheque' && !t.cheque_date) issues.push({ index: i, code: 'cheque_date_required' });
    if (t.mode === 'credit_note' && !t.credit_note_id) issues.push({ index: i, code: 'credit_note_required' });
  });
  if (filled.length > MAX_TENDERS) issues.push({ index: null, code: 'too_many' });
  const total = sumMoney(filled.map(({ t }) => moneyInput(t.amount) ?? '0'));
  const remaining = due == null ? null : subMoney(due, total);
  if (remaining != null && dec(remaining).lt(0)) issues.push({ index: null, code: 'overpayment' });
  const status: 'unpaid' | 'part_paid' | 'paid' = !isPositive(total) ? 'unpaid' : remaining != null && !dec(remaining).gt(0) ? 'paid' : 'part_paid';
  return { total, remaining, status, issues, ok: issues.length === 0 };
}
/** Amount to put in a new / focused tender row: what is still due after the other rows (never negative). */
export function fillRemaining(tenders: readonly DraftTender[], due: string, index: number): string {
  const others = tenders.filter((_, i) => i !== index).map((t) => moneyInput(t.amount) ?? '0');
  const left = subMoney(due, sumMoney(others));
  return dec(left).gt(0) ? left : '0.00';
}

/* ------------------------------------------------------------ requirements / gates ------------------------------------------------------------ */

export type SalesBlocker =
  | 'credit_sale' | 'cash_limit' | 'pan' | 'discount' | 'discount_invalid' | 'override_min' | 'zero_gst' | 'old_gold_rate' | 'old_gold_payout' | 'tenders' | 'supply' | 'goods_line';
/**
 * Turn the preview's `requirements` (+ the user's permissions and the typed draft) into blocking reasons the counter sees BEFORE
 * pressing Issue. The server re-checks everything (403 / 422), this only avoids a round trip.
 */
export function issueBlockers(
  c: (Pick<BillComputation, 'requirements' | 'totals' | 'old_metal'> & Partial<Pick<BillComputation, 'lines'>>) | null | undefined, d: BillDraft, can: (perm: string) => boolean,
  settings?: Partial<Pick<SalesSettings, 'old_gold_excess_handling' | 'discount_max_pct' | 'large_discount_pct'>> | null,
): SalesBlocker[] {
  if (!c) return [];
  const r: Partial<BillRequirements> = c.requirements ?? {};
  const out: SalesBlocker[] = [];
  if (invalidGoodsLineIndex(d.lines, c.lines) >= 0) out.push('goods_line');
  const paid = sumMoney(d.tenders.map((t) => moneyInput(t.amount) ?? '0'));
  // 0.9.1: a bill with something to pay and nothing paid is a credit sale (part-paid needs nothing extra).
  const creditSale = r.credit_sale_permission ?? (isPositive(c.totals?.net_payable) && !isPositive(paid));
  if (creditSale && !can('sales.invoice.credit_sale')) out.push('credit_sale');
  if (r.cash_limit?.exceeded && r.cash_limit.mode === 'block') out.push('cash_limit');
  if (r.pan_required && !r.pan_on_file && !panInput(d.pan)) out.push('pan');
  const disc = settings?.discount_max_pct != null && settings.large_discount_pct != null
    ? draftDiscounts(d, c.lines, c.totals?.gross_value, { discount_max_pct: settings.discount_max_pct, large_discount_pct: settings.large_discount_pct }) : null;
  if ((r.discount_permission || disc?.any) && !can('sales.discount.give')) out.push('discount');
  if (disc?.bad) out.push('discount_invalid');
  if ((r.override_min_permission || disc?.overMax) && (!can('sales.price.override_min') || !textBetween(d.discount_reason, 3, 200))) out.push('override_min');
  if (supplyIssues(d).length) out.push('supply');
  if (d.zero_gst?.on && (!can('sales.invoice.zero_gst') || !textBetween(d.zero_gst.reason, 5, 200))) out.push('zero_gst');
  if ((r.old_gold_rate_override_permission || d.old_metal.some((o) => rateOverrideState(o) !== 'none')) &&
    (!can('sales.old_gold.rate_override') || d.old_metal.some((o) => rateOverrideState(o) === 'incomplete'))) out.push('old_gold_rate');
  if (isPositive(c.totals?.old_gold_excess) && settings?.old_gold_excess_handling !== 'separate_purchase' && !d.excess_payout) out.push('old_gold_payout');
  if (!tenderCheck(d.tenders, c.totals?.net_payable).ok) out.push('tenders');
  return out;
}

export const textBetween = (s: string | null | undefined, min: number, max: number) => { const n = (s ?? '').trim().length; return n >= min && n <= max; };

/* ----------------------------------------------------------------- errors ----------------------------------------------------------------- */

/** Every Sales problem code with a plain-language message (en + ta) under `error.<code>`. Unknown codes fall back to the server title. */
export const SALES_ERROR_CODES = [
  // sellable / lines
  'tag_sold', 'tag_reserved', 'tag_on_approval', 'tag_in_transit', 'tag_in_repair', 'tag_not_sellable', 'tag_other_branch', 'huid_missing',
  'duplicate_tag_in_bill', 'insufficient_loose_stock', 'tag_not_found',
  // gates
  'device_not_approved', 'todays_rates_missing', 'onboarding_incomplete', 'making_service_rate_not_set',
  // bill
  'expected_total_mismatch', 'pan_required', 'cash_limit_exceeded', 'discount_reason_required', 'place_of_supply_conflict', 'overpayment',
  'old_gold_exceeds_bill', 'old_gold_payout_required', 'zero_gst_not_allowed', 'credit_sale_not_allowed', 'old_gold_rate_override_not_allowed',
  'customer_phone_exists', 'store_credit_insufficient', 'client_supplied_doc_number', 'client_supplied_doc_date', 'idempotency_key_reused',
  // after issue
  'invoice_cancelled', 'invoice_fully_paid', 'line_already_returned', 'line_not_on_invoice', 'return_window_expired', 'estimate_not_open',
  'reprint_reason_required', 'first_print_duplicate_not_supported', 'print_language_not_supported', 'pinned_print_template_unavailable', 'print_template_not_configured', 'print_snapshot_unavailable', 'invoice_print_snapshot_missing', 'print_template_asset_unavailable', 'receipt_already_reversed', 'receipt_is_reversal',
] as const;
export type SalesErrorCode = (typeof SALES_ERROR_CODES)[number];
/** Problem code of a Sales error; the scan box maps a bare 404 to tag_not_found. */
export function salesErrorCode(e: unknown, ctx: 'scan' | 'other' = 'other'): string | undefined {
  if (!(e instanceof ApiError)) return undefined;
  if (ctx === 'scan' && e.status === 404) return 'tag_not_found';
  return e.code;
}
/** 0.9.1 typed 409: the customer already on file for that mobile, to offer "Use this customer". */
export function existingCustomer(e: unknown): { customer_id: string; name: string } | null {
  if (!(e instanceof ApiError) || e.status !== 409 || e.code !== 'customer_phone_exists') return null;
  const x = e.problem?.existing_customer as { customer_id?: unknown; name?: unknown } | undefined;
  return x && typeof x.customer_id === 'string' ? { customer_id: x.customer_id, name: typeof x.name === 'string' ? x.name : '' } : null;
}
/** Line number (0-based) named by a 409/422 (errors[].path "lines[2]…", "lines.2…", "/lines/2"), else null. */
export function errorLineIndex(e: unknown): number | null {
  if (!(e instanceof ApiError)) return null;
  for (const x of e.errors ?? []) {
    const m = /^\/?lines[[./](\d+)/.exec(x.path ?? '');
    if (m) return Number(m[1]);
  }
  return null;
}
export const isTotalMismatch = (e: unknown) => e instanceof ApiError && e.status === 422 && e.code === 'expected_total_mismatch';
export const isStaleEstimate = (e: unknown) => e instanceof ApiError && e.status === 412;

/* ------------------------------------------------------------------ print ------------------------------------------------------------------ */

export const REPRINT_MIN = 3;
export const REPRINT_MAX = 200;
/** First print = original; every later print is a DUPLICATE that needs a 3–200 char reason (and sales.invoice.reprint on bills / credit notes). */
export const isReprint = (printCount: number | null | undefined) => (printCount ?? 0) > 0;
export function printBody(o: Pick<SalesPrintRequest, 'paper' | 'language' | 'numerals' | 'copy'> & { printCount?: number | null; cancelled?: boolean; reason?: string | null }) {
  return printBody093({ ...o, count: o.printCount ?? 0, cancelled: !!o.cancelled, reason: o.reason ?? '' });
}
export function canPrint(doc: 'invoice' | 'credit_note' | 'estimate' | 'payment_receipt', printCount: number | null | undefined, reason: string, can: (p: string) => boolean) {
  if (!isReprint(printCount)) return true;
  return (doc === 'estimate' || can('sales.invoice.reprint')) && textBetween(reason, REPRINT_MIN, REPRINT_MAX);
}

/* ------------------------------------------------------------------ lists ------------------------------------------------------------------ */

export type InvoiceFilters = {
  q?: string; doc_no?: string; from?: string; to?: string; customer_id?: string; tag_no?: string; salesperson_id?: string;
  status?: '' | 'issued' | 'cancelled'; payment_status?: '' | 'paid' | 'part_paid' | 'unpaid'; supply_type?: '' | 'b2b' | 'b2c'; branch_id?: string;
};
/** Drop empty filters (the server 422s an empty q) and trim; dates stay ISO yyyy-mm-dd; from > to is swapped. */
export function invoiceParams(f: InvoiceFilters) {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(f)) { const s = typeof v === 'string' ? v.trim() : ''; if (s) out[k] = s; }
  if (out.from && out.to && out.from > out.to) [out.from, out.to] = [out.to, out.from];
  return out;
}

/* ----------------------------------------------------------------- returns ----------------------------------------------------------------- */

/** Lines that can still go back: not already on a credit note, and the bill not cancelled. Whole lines only (approved 0.9.1). */
export const returnableLines = (inv: Pick<Invoice, 'status' | 'lines'>) => (inv.status === 'cancelled' ? [] : inv.lines.filter((l) => !l.credit_note_id));
/** Last IST date a return is accepted (doc_date + window days) — a hint only; the server enforces (422 return_window_expired). */
export function returnLastDay(docDate: string, windowDays: number): string {
  const d = new Date(`${docDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Math.max(0, windowDays));
  return d.toISOString().slice(0, 10);
}
export const returnWindowOpen = (docDate: string, windowDays: number, todayIst: string) => todayIst <= returnLastDay(docDate, windowDays);
/** Cancel / return reason: trimmed 5–500. */
export const CN_REASON_MIN = 5;
export const CN_REASON_MAX = 500;

/* -------------------------------------------------------------- display helpers -------------------------------------------------------------- */

/** Sum of each component across the priced lines (for the totals panel). */
export function componentTotals(lines: readonly PricedLine[]) {
  return {
    metal: sumMoney(lines.map((l) => l.metal_value)),
    making: sumMoney(lines.map((l) => l.mc_amount)),
    stones: sumMoney(lines.map((l) => l.stone_amount)),
    hallmark: sumMoney(lines.map((l) => l.hallmark_charge)),
    discount: sumMoney(lines.map((l) => l.discount)),
  };
}
/** Approximate running total from the sellable answers while the full preview can't run yet (no customer / salesperson). */
export const roughTotal = (lines: readonly DraftLine[]) => sumMoney(lines.map((l) => (l.kind === 'tag' ? l.priced?.line_total ?? '0' : '0')));

/** Today's date in IST as yyyy-mm-dd (return-window hint). */
export const todayIst = (now: Date = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
/** Default refund mode from the shop's return_settlement_default (approved per-shop setting): refund → cash, else store credit. */
export const defaultRefundMode = (s: Pick<SalesSettings, 'return_settlement_default'> | null | undefined): ReturnRefundMode =>
  s?.return_settlement_default ?? 'store_credit';

/* ----------------------------------------------------------- loose (untagged) lines ----------------------------------------------------------- */

export type LooseForm = { item_id: string; purity_id: string; gross_wt: string; stone_wt: string; net_wt: string; pieces: string; counter_id: string; tray_id: string; description: string };
export const emptyLoose = (): LooseForm => ({ item_id: '', purity_id: '', gross_wt: '', stone_wt: '', net_wt: '', pieces: '1', counter_id: '', tray_id: '', description: '' });
export type LooseIssue = 'item' | 'purity' | 'gross' | 'net' | 'stone' | 'net_over_gross' | 'pieces';
/** Check a loose (untagged) line before adding it: item, purity, weights (net ≤ gross; stone ≤ gross − net is not enforced), pieces ≥ 1. */
export function looseIssues(f: LooseForm): LooseIssue[] {
  const out: LooseIssue[] = [];
  if (!f.item_id) out.push('item');
  if (!f.purity_id) out.push('purity');
  const g = weightInput(f.gross_wt);
  const n = f.net_wt.trim() ? weightInput(f.net_wt) : g;
  if (!g || !isPositive(g)) out.push('gross');
  if (!n || !isPositive(n)) out.push('net');
  if (f.stone_wt.trim() && !weightInput(f.stone_wt)) out.push('stone');
  if (g && n && dec(n).gt(dec(g))) out.push('net_over_gross');
  if (!/^\d{1,4}$/.test(f.pieces.trim() || '1') || Number(f.pieces || '1') < 0) out.push('pieces');
  return out;
}
/** Loose form → draft line (net defaults to gross; stone weight only when typed). Null while looseIssues() is not empty. */
export function looseToDraft(f: LooseForm, key: string): DraftLooseLine | null {
  if (looseIssues(f).length) return null;
  const gross = weightInput(f.gross_wt) ?? '0.000';
  const stone = f.stone_wt.trim() ? weightInput(f.stone_wt) ?? undefined : undefined;
  return {
    kind: 'loose', key, item_id: f.item_id, purity_id: f.purity_id, gross_wt: gross, net_wt: f.net_wt.trim() ? weightInput(f.net_wt) ?? gross : gross,
    ...(stone && isPositive(stone) ? { stone_wt: stone } : {}), pieces: Number(f.pieces || '1'),
    counter_id: f.counter_id || null, tray_id: f.tray_id || null, ...(f.description.trim() ? { description: f.description.trim() } : {}),
  };
}
/** Priced line for draft line i: the preview prices lines in the order sent, so loose lines match by position. */
export function pricedAt(lines: readonly DraftLine[], i: number, priced: readonly PricedLine[] | null | undefined): PricedLine | null {
  const l = lines[i];
  if (!l) return null;
  if (l.kind === 'tag') return priced?.find((p) => p.tag_id === l.tag_id) ?? l.priced ?? null;
  return priced?.find((p) => p.line_no === i + 1 && p.kind === 'loose') ?? null;
}

/* ---------------------------------------------------------------- discounts ---------------------------------------------------------------- */

export type DiscountState = 'none' | 'ok' | 'large' | 'over_max' | 'over_value' | 'invalid';
/**
 * A typed discount against the value it comes off (shop settings, S7): above `discount_max_pct` needs sales.price.override_min + a reason;
 * at or above `large_discount_pct` is allowed but flagged (owner daily summary). More than the value itself is never allowed.
 */
export function discountState(raw: string | null | undefined, value: string | null | undefined, s: Pick<SalesSettings, 'discount_max_pct' | 'large_discount_pct'>): DiscountState {
  if (!(raw ?? '').trim()) return 'none';
  const d = moneyInput(raw);
  if (!d) return 'invalid';
  if (!isPositive(d)) return 'none';
  if (!isPositive(value)) return 'ok';
  const v = dec(value);
  if (dec(d).gt(v)) return 'over_value';
  const pct = dec(d).mul(100).div(v);
  if (pct.gt(dec(s.discount_max_pct))) return 'over_max';
  if (pct.gte(dec(s.large_discount_pct))) return 'large';
  return 'ok';
}
/** All discount states on the draft: each line against its value before tax, and the bill discount against the bill value. */
export function draftDiscounts(d: BillDraft, priced: readonly PricedLine[] | null | undefined, grossTotal: string | null | undefined, s: Pick<SalesSettings, 'discount_max_pct' | 'large_discount_pct'>) {
  const lines = d.lines.map((l, i) => discountState(l.discount, pricedAt(d.lines, i, priced)?.gross_value, s));
  const bill = discountState(d.bill_discount, grossTotal, s);
  const any = [...lines, bill].some((x) => x !== 'none');
  return { lines, bill, any, overMax: [...lines, bill].includes('over_max'), bad: [...lines, bill].some((x) => x === 'invalid' || x === 'over_value') };
}

/* ------------------------------------------------------------ B2B / place of supply ------------------------------------------------------------ */

export const GSTIN_FORMAT = /^[0-9]{2}[A-Z0-9]{13}$/;
export const gstinInput = (raw: string | null | undefined): string | null => { const s = (raw ?? '').replace(/\s/g, '').toUpperCase(); return GSTIN_FORMAT.test(s) ? s : null; };
export const stateInput = (raw: string | null | undefined): string | null => { const s = (raw ?? '').trim(); return /^[0-9]{2}$/.test(s) && s !== '00' ? s : null; };
export const stateFromGstin = (raw: string | null | undefined): string | null => gstinInput(raw)?.slice(0, 2) ?? null;
/** The customer's GSTIN on this bill (existing record or the new customer form). A GSTIN makes it a B2B bill. */
export const draftGstin = (d: Pick<BillDraft, 'customer'>): string | null => (d.customer.kind === 'none' ? null : gstinInput(d.customer.gstin));
export const draftSupplyType = (d: Pick<BillDraft, 'customer'>): 'b2b' | 'b2c' => (draftGstin(d) ? 'b2b' : 'b2c');
export type SupplyIssue = 'gstin_invalid' | 'state_invalid' | 'gstin_state_mismatch' | 'pos_invalid' | 'pos_conflict';
/** Supply checks the server would 422: bad GSTIN / state, GSTIN state ≠ customer state, B2B place of supply ≠ GSTIN state. */
export function supplyIssues(d: Pick<BillDraft, 'customer' | 'place_of_supply'>): SupplyIssue[] {
  const out: SupplyIssue[] = [];
  const c = d.customer;
  if (c.kind === 'new') {
    if ((c.gstin ?? '').trim() && !gstinInput(c.gstin)) out.push('gstin_invalid');
    if ((c.state_code ?? '').trim() && !stateInput(c.state_code)) out.push('state_invalid');
    if (gstinInput(c.gstin) && stateInput(c.state_code) && stateFromGstin(c.gstin) !== stateInput(c.state_code)) out.push('gstin_state_mismatch');
  }
  const pos = (d.place_of_supply ?? '').trim();
  if (pos && !stateInput(pos)) out.push('pos_invalid');
  const gst = draftGstin(d);
  if (gst && stateInput(pos) && stateInput(pos) !== gst.slice(0, 2)) out.push('pos_conflict');
  return out;
}
/** place_of_supply goes on the request only for B2C (B2B = GSTIN state, decided by the server). */
function posField(d: BillDraft): { place_of_supply?: string } {
  const pos = stateInput(d.place_of_supply);
  return pos && draftSupplyType(d) === 'b2c' ? { place_of_supply: pos } : {};
}
