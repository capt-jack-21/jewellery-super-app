import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '@/i18n/messages/en-IN.json';
import ta from '@/i18n/messages/ta-IN.json';
import { ApiError } from '@/lib/api/fetcher';
import { SALES, SALES_NAV_PERMS, routePermFor } from '@/lib/permissions';
import { pcsCell, summaryCounts } from '@/features/inventory/stock';
import { isSalesOff, salesApi } from './api';
import { shortcutFor } from './hooks';
import {
  canPrint, CN_REASON_MIN, componentTotals, defaultRefundMode, draftFromEstimates, draftGaps, emptyDraft, errorLineIndex, existingCustomer, fillRemaining,
  invoiceParams, isReprint, isStaleEstimate, isTotalMismatch, issueBlockers, mergeProblem, moneyInput, panInput, phoneInput, printBody, rateOverrideState,
  returnableLines, returnLastDay, returnWindowOpen, roughTotal, SALES_ERROR_CODES, salesErrorCode, tenderCheck, todayIst, toEstimateRequest, toIssueRequest,
  toOldGoldInput, toPreviewRequest, invoiceOnlyChecks, invalidGoodsLineIndex, type BillDraft, type DraftTender,
  discountState, draftDiscounts, emptyLoose, looseIssues, looseToDraft, pricedAt, supplyIssues, draftSupplyType, gstinInput,
} from './logic';
import { BR, computation, CUST, invoice, pricedLine, SP } from './fixtures';

type Reply = { status: number; body?: unknown };
let replies: Reply[] = [];
const calls: Array<{ url: string; method: string; headers: Headers; body?: string }> = [];
beforeEach(() => {
  replies = []; calls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: init?.body as string | undefined });
    const r = replies.shift() ?? { status: 404, body: { title: 'Not Found' } };
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: { 'content-type': r.status >= 400 ? 'application/problem+json' : 'application/json' } });
  }));
});
afterEach(() => vi.unstubAllGlobals());

/** Test helper: value or throw (no non-null assertions). */
const nn = <T,>(x: T | null | undefined): T => { if (x == null) throw new Error('missing'); return x; };

const tender = (mode: DraftTender['mode'], amount: string, extra: Partial<DraftTender> = {}): DraftTender => ({ key: `${mode}-${amount}`, mode, amount, ...extra });
const ready = (over: Partial<BillDraft> = {}): BillDraft => ({
  ...emptyDraft(BR, SP), customer: { kind: 'existing', id: CUST, name: 'Lakshmi' },
  lines: [{ kind: 'tag', key: 'k1', tag_id: 'tag-1', tag_no: 'RSP-01', priced: pricedLine() }], ...over,
});
const all = () => true;
const none = () => false;

describe('Step 1 (inventory 0.9.x): summary line and Pcs column', () => {
  it("summary counts come from tag_count and tag_pieces ('{tags} tags · {pieces} pieces')", () => {
    expect(summaryCounts({ tag_count: 9, tag_pieces: 12 })).toEqual({ tags: 9, pieces: 12 });
    expect(summaryCounts(null)).toEqual({ tags: 0, pieces: 0 });
    expect(summaryCounts({ tag_count: -1, tag_pieces: Number.NaN })).toEqual({ tags: 0, pieces: 0 });
    expect(en['inventory.summary.tagged']).toContain('{tags, plural');
    expect(ta['inventory.summary.tagged']).toMatch(/\{tags\}.*\{pieces\}/);
  });
  it('Pcs shows only for multi-piece tags', () => {
    expect(pcsCell(2)).toBe('2');
    expect(pcsCell(1)).toBe('');
    expect(pcsCell(null)).toBe('');
  });
});

describe('Sales API (contract 0.9.1)', () => {
  it('404 without a code (route missing) = billing not switched on; real 404 codes are not', () => {
    expect(isSalesOff(new ApiError(404, undefined, 'Not Found'))).toBe(true);
    expect(isSalesOff(new ApiError(501, 'not_implemented', 'x'))).toBe(true);
    expect(isSalesOff(new ApiError(404, 'invoice_not_found', 'x'))).toBe(false);
    expect(isSalesOff(new ApiError(409, 'tag_sold', 'x'))).toBe(false);
  });
  it('preview has no Idempotency-Key; issue, payments, cancel, returns, estimate create and prints do', async () => {
    replies = Array.from({ length: 7 }, () => ({ status: 200, body: {} }));
    const body = nn(toIssueRequest(ready()));
    await salesApi.preview(body);
    await salesApi.issue(body, 'k-issue');
    await salesApi.receivePayment('i1', { tenders: [{ mode: 'cash', amount: '10.00' }] }, 'k-pay');
    await salesApi.cancel('i1', { reason: 'Wrong item', refund_mode: 'store_credit' }, 'k-cancel');
    await salesApi.returnLines('i1', { line_ids: ['l1'], reason: 'Size issue' }, 'k-ret');
    await salesApi.createEstimate(nn(toEstimateRequest(ready())), 'k-est');
    await salesApi.print('credit_note', 'cn1', { paper: 'A5' }, 'k-print');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST /api/v1/sales/preview', 'POST /api/v1/sales/invoices', 'POST /api/v1/sales/invoices/i1/payments', 'POST /api/v1/sales/invoices/i1/cancellation',
      'POST /api/v1/sales/invoices/i1/returns', 'POST /api/v1/sales/estimates', 'POST /api/v1/sales/credit-notes/cn1/prints',
    ]);
    expect(calls[0]?.headers.get('Idempotency-Key')).toBeNull();
    expect(calls.slice(1).map((c) => c.headers.get('Idempotency-Key'))).toEqual(['k-issue', 'k-pay', 'k-cancel', 'k-ret', 'k-est', 'k-print']);
  });
  it('estimate PUT and cancel send If-Match with the version', async () => {
    replies = [{ status: 200, body: {} }, { status: 200, body: {} }];
    await salesApi.replaceEstimate({ id: 'e1', version: 3 }, nn(toEstimateRequest(ready())));
    await salesApi.cancelEstimate({ id: 'e1', version: 4 });
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.headers.get('If-Match')).toBe('"3"');
    expect(calls[1]?.headers.get('If-Match')).toBe('"4"');
  });
  it('sellable encodes the scanned code and passes the branch', async () => {
    replies = [{ status: 200, body: {} }];
    await salesApi.sellable(' RSP/01 ', { branch_id: BR });
    expect(calls[0]?.url).toBe(`/api/v1/sales/sellable/RSP%2F01?branch_id=${BR}`);
  });
  it('bill list sends only the filters that are set', async () => {
    replies = [{ status: 200, body: { items: [], next_cursor: null } }];
    await salesApi.invoices(invoiceParams({ q: ' lakshmi ', status: '', payment_status: 'part_paid', from: '2026-11-09', to: '2026-11-01' }));
    const u = new URL(`http://x${calls[0]?.url}`);
    expect(Object.fromEntries(u.searchParams)).toEqual({ limit: '50', q: 'lakshmi', payment_status: 'part_paid', from: '2026-11-01', to: '2026-11-09' });
  });
});

describe('request building', () => {
  it('issue body: server-priced tag lines, existing customer, typed tenders only, PAN upper-cased, expected_total', () => {
    const b = nn(toIssueRequest(ready({ tenders: [tender('cash', '1,000'), tender('upi', '')], pan: ' abcde1234f ' }), '76735.00'));
    expect(b).toMatchObject({ branch_id: BR, salesperson_id: SP, customer_id: CUST, lines: [{ kind: 'tag', tag_id: 'tag-1' }], payments: [{ mode: 'cash', amount: '1000.00' }], pan: 'ABCDE1234F', expected_total: '76735.00' });
    expect(b).not.toHaveProperty('customer');
    expect(b).not.toHaveProperty('zero_gst');
  });
  it('new customer goes inline (quick add); missing customer or salesperson blocks the bill but not an estimate', () => {
    const b = nn(toIssueRequest(ready({ customer: { kind: 'new', name: ' Meena ', phone: '9840000002', gstin: '33abcde1234f1z5' } })));
    expect(b).toMatchObject({ customer: { name: 'Meena', phone: '9840000002', gstin: '33ABCDE1234F1Z5' } });
    expect(draftGaps(ready({ customer: { kind: 'none' }, salesperson_id: '' }))).toEqual(['customer', 'salesperson']);
    expect(toIssueRequest(ready({ customer: { kind: 'none' } }))).toBeNull();
    expect(toEstimateRequest(ready({ customer: { kind: 'none' }, salesperson_id: '' }))).toMatchObject({ customer_id: null, salesperson_id: null });
  });
  it('zero GST needs a reason to be sent', () => {
    expect(toIssueRequest(ready({ zero_gst: { on: true, reason: '  ' } }))).not.toHaveProperty('zero_gst');
    expect(toIssueRequest(ready({ zero_gst: { on: true, reason: 'Export to Singapore' } }))).toMatchObject({ zero_gst: { reason: 'Export to Singapore' } });
  });
  it('0.9.1 old-gold rate override travels only as a complete pair', () => {
    const base = { key: 'o', purity_id: 'p22', gross_wt: '5' };
    expect(toOldGoldInput(base)).toEqual({ purity_id: 'p22', gross_wt: '5.000' });
    expect(toOldGoldInput({ ...base, rate_override: '6400' })).not.toHaveProperty('rate_override');
    expect(toOldGoldInput({ ...base, rate_override: '6400', override_reason: 'Heavy solder' })).toMatchObject({ rate_override: '6400.00', override_reason: 'Heavy solder' });
    expect(rateOverrideState({})).toBe('none');
    expect(rateOverrideState({ rate_override: '6400', override_reason: 'abc' })).toBe('incomplete');
    expect(rateOverrideState({ rate_override: '6400', override_reason: 'Heavy solder' })).toBe('ok');
    expect(toOldGoldInput({ key: 'o', purity_id: '', gross_wt: '5' })).toBeNull();
  });
  it('input normalisers', () => {
    expect(moneyInput('₹1,00,000.5')).toBe('100000.50');
    expect(moneyInput('abc')).toBeNull();
    expect(panInput('abcde1234f')).toBe('ABCDE1234F');
    expect(panInput('ABCDE12345')).toBeNull();
    expect(phoneInput('+91 98400-00001')).toBe('9840000001');
    expect(phoneInput('12345')).toBeNull();
  });
});

describe('tender split validation', () => {
  it('split across modes adds up; part payment is allowed; more than due is not', () => {
    expect(tenderCheck([tender('cash', '50000'), tender('upi', '26735')], '76735.00')).toMatchObject({ total: '76735.00', remaining: '0.00', status: 'paid', ok: true });
    expect(tenderCheck([tender('cash', '10000')], '76735.00')).toMatchObject({ remaining: '66735.00', status: 'part_paid', ok: true });
    const over = tenderCheck([tender('cash', '80000')], '76735.00');
    expect(over.ok).toBe(false);
    expect(over.issues).toContainEqual({ index: null, code: 'overpayment' });
    expect(tenderCheck([], '100.00')).toMatchObject({ total: '0.00', status: 'unpaid', ok: true });
  });
  it('per-mode details: cheque needs number and date, bank transfer a reference, store credit its note; bad amounts flagged', () => {
    const c = tenderCheck([tender('cheque', '100'), tender('bank_transfer', '100'), tender('credit_note', '100'), tender('upi', '-5')], '1000.00');
    expect(c.issues.map((i) => `${i.index}:${i.code}`)).toEqual(['0:reference_required', '0:cheque_date_required', '1:reference_required', '2:credit_note_required', '3:amount_invalid']);
    expect(tenderCheck([tender('cheque', '100', { reference: '000123', cheque_date: '2026-11-09' })], '1000.00').ok).toBe(true);
  });
  it('"Rest" fills what is left after the other rows, never negative', () => {
    const ts = [tender('cash', '50000'), tender('upi', '')];
    expect(fillRemaining(ts, '76735.00', 1)).toBe('26735.00');
    expect(fillRemaining([tender('cash', '90000'), tender('upi', '')], '76735.00', 1)).toBe('0.00');
  });
});

describe('blocking reasons before Issue (from preview requirements)', () => {
  const c = computation();
  it('0.9.1 credit sale: nothing paid needs sales.invoice.credit_sale; part-paid needs nothing extra', () => {
    const unpaid = computation({ requirements: { ...c.requirements, credit_sale_permission: true } });
    expect(issueBlockers(unpaid, ready(), (p) => p !== SALES.creditSale)).toContain('credit_sale');
    expect(issueBlockers(unpaid, ready(), all)).not.toContain('credit_sale');
    expect(issueBlockers(c, ready({ tenders: [tender('cash', '100')] }), none)).not.toContain('credit_sale');
  });
  it('cash limit blocks only in block mode; PAN needed unless on file or typed', () => {
    const cash = computation({ requirements: { ...c.requirements, cash_limit: { limit: '200000.00', mode: 'block', cash_amount: '200000.00', exceeded: true } } });
    expect(issueBlockers(cash, ready(), all)).toContain('cash_limit');
    const warn = computation({ requirements: { ...c.requirements, cash_limit: { limit: '200000.00', mode: 'warn', cash_amount: '250000.00', exceeded: true } } });
    expect(issueBlockers(warn, ready(), all)).not.toContain('cash_limit');
    const pan = computation({ requirements: { ...c.requirements, pan_required: true } });
    expect(issueBlockers(pan, ready(), all)).toContain('pan');
    expect(issueBlockers(pan, ready({ pan: 'ABCDE1234F' }), all)).not.toContain('pan');
  });
  it('old-gold rate override needs the permission and a full pair; zero GST needs permission + reason; excess payout must be chosen', () => {
    const d = ready({ old_metal: [{ key: 'o', purity_id: 'p', gross_wt: '5', rate_override: '6400', override_reason: 'Heavy solder' }] });
    expect(issueBlockers(c, d, (p) => p !== SALES.oldGoldRateOverride)).toContain('old_gold_rate');
    expect(issueBlockers(c, d, all)).not.toContain('old_gold_rate');
    expect(issueBlockers(c, ready({ zero_gst: { on: true, reason: 'x' } }), all)).toContain('zero_gst');
    const excess = computation({ totals: { ...c.totals, old_gold_excess: '1000.00', net_payable: '0.00' } });
    expect(issueBlockers(excess, ready(), all, { old_gold_excess_handling: 'refund_on_bill' })).toContain('old_gold_payout');
    expect(issueBlockers(excess, ready({ excess_payout: 'cash' }), all, { old_gold_excess_handling: 'refund_on_bill' })).not.toContain('old_gold_payout');
  });
});

describe('error-code mapping', () => {
  it('every Sales code has a plain en + ta message with the same placeholders', () => {
    const E = en as Record<string, string>;
    const T = ta as Record<string, string>;
    for (const code of SALES_ERROR_CODES) {
      expect(E[`error.${code}`], code).toBeTruthy();
      expect(T[`error.${code}`], code).toMatch(/[\u0B80-\u0BFF]/);
    }
  });
  it('scan 404 means "no such tag"; 409s keep their code; typed 409 carries the existing customer', () => {
    expect(salesErrorCode(new ApiError(404, 'not_found', 'x'), 'scan')).toBe('tag_not_found');
    expect(salesErrorCode(new ApiError(409, 'tag_sold', 'x'), 'scan')).toBe('tag_sold');
    expect(salesErrorCode(new Error('x'))).toBeUndefined();
    const e = new ApiError(409, 'customer_phone_exists', 'x', undefined, [], undefined, { existing_customer: { customer_id: CUST, name: 'Lakshmi' } });
    expect(existingCustomer(e)).toEqual({ customer_id: CUST, name: 'Lakshmi' });
    expect(existingCustomer(new ApiError(409, 'customer_phone_exists', 'x'))).toBeNull();
  });
  it('line index from field errors; total mismatch and stale estimate are told apart', () => {
    expect(errorLineIndex(new ApiError(409, 'tag_sold', 'x', undefined, [{ field: 'lines', path: 'lines[2].tag_id', message: 'm' } as never]))).toBe(2);
    expect(errorLineIndex(new ApiError(409, 'tag_sold', 'x'))).toBeNull();
    expect(isTotalMismatch(new ApiError(422, 'expected_total_mismatch', 'x'))).toBe(true);
    expect(isStaleEstimate(new ApiError(412, 'version_mismatch', 'x'))).toBe(true);
  });
});

describe('estimates: merge and convert', () => {
  const e = (id: string, over: Partial<{ branch_id: string; customer_id: string | null; status: string }> = {}) => ({ id, version: 1, branch_id: BR, customer_id: CUST, status: 'draft', ...over });
  it('up to 10 open estimates of one branch and one customer', () => {
    expect(mergeProblem([e('a'), e('b')])).toBeNull();
    expect(mergeProblem([])).toBe('none');
    expect(mergeProblem(Array.from({ length: 11 }, (_, i) => e(String(i))))).toBe('too_many');
    expect(mergeProblem([e('a'), e('b', { status: 'billed' })])).toBe('not_draft');
    expect(mergeProblem([e('a'), e('b', { branch_id: 'other' })])).toBe('branch_mismatch');
    expect(mergeProblem([e('a'), e('b', { customer_id: 'someone' })])).toBe('customer_mismatch');
    expect(mergeProblem([e('a'), e('b', { customer_id: null })])).toBeNull();
  });
  it('convert prefills lines (no duplicate tags), old gold, customer, and sends estimates[{id,version}] on the bill', () => {
    let n = 0;
    const req = (tag: string) => ({ branch_id: BR, customer_id: CUST, salesperson_id: SP, lines: [{ kind: 'tag' as const, tag_id: tag }], old_metal: [{ purity_id: 'p22', gross_wt: '2.000' }] });
    const d = draftFromEstimates(emptyDraft(BR), [
      { id: 'e1', version: 2, request: req('t1'), customer_id: CUST, salesperson_id: SP },
      { id: 'e2', version: 5, request: req('t1'), customer_id: CUST, salesperson_id: null },
    ], () => `k${n++}`);
    expect(d.lines).toHaveLength(1);
    expect(d.old_metal).toHaveLength(2);
    expect(d.customer).toMatchObject({ kind: 'existing', id: CUST });
    expect(toIssueRequest(d)).toMatchObject({ estimates: [{ id: 'e1', version: 2 }, { id: 'e2', version: 5 }], customer_id: CUST, salesperson_id: SP });
  });
});

describe('print, returns, lists, display', () => {
  it('first print is the original; later prints need a 3–200 reason and sales.invoice.reprint (estimates never)', () => {
    expect(isReprint(0)).toBe(false);
    expect(printBody({ paper: 'A5', printCount: 0, reason: 'lost' })).toEqual({ paper: 'A5' });
    expect(printBody({ paper: 'A4', printCount: 1, reason: ' Customer lost it ' })).toEqual({ paper: 'A4', reprint_reason: 'Customer lost it' });
    expect(canPrint('invoice', 0, '', none)).toBe(true);
    expect(canPrint('invoice', 1, 'ok', all)).toBe(false);
    expect(canPrint('invoice', 1, 'Customer lost it', all)).toBe(true);
    expect(canPrint('credit_note', 2, 'Customer lost it', none)).toBe(false);
    expect(canPrint('estimate', 3, '', none)).toBe(false);
    expect(canPrint('estimate', 3, 'Customer copy', none)).toBe(true);
  });
  it('returns: whole lines not yet returned; window from the shop setting; refund default from settings', () => {
    expect(returnableLines(invoice()).map((l) => l.id)).toEqual(['line-1']);
    expect(returnableLines(invoice({ status: 'cancelled' }))).toEqual([]);
    expect(returnLastDay('2026-11-09', 7)).toBe('2026-11-16');
    expect(returnWindowOpen('2026-11-09', 7, '2026-11-16')).toBe(true);
    expect(returnWindowOpen('2026-11-09', 7, '2026-11-17')).toBe(false);
    expect(defaultRefundMode({ return_settlement_default: 'cash' })).toBe('cash');
    expect(defaultRefundMode({ return_settlement_default: 'store_credit' })).toBe('store_credit');
    expect(CN_REASON_MIN).toBe(5);
    expect(todayIst(new Date('2026-11-09T19:00:00Z'))).toBe('2026-11-10');
  });
  it('component totals and the rough total add server figures exactly', () => {
    const t = componentTotals([pricedLine(), pricedLine({ metal_value: '0.10', mc_amount: '0.20' })]);
    expect(t).toMatchObject({ metal: '70000.10', making: '4500.20' });
    expect(roughTotal(ready().lines)).toBe('76735.00');
  });
  it('counter shortcuts', () => {
    expect(shortcutFor({ key: 'F1', ctrlKey: false, metaKey: false, altKey: false })).toBe('pay');
    expect(shortcutFor({ key: 's', ctrlKey: true, metaKey: false, altKey: false })).toBe('issue');
    expect(shortcutFor({ key: 'E', ctrlKey: false, metaKey: true, altKey: false })).toBe('estimate');
    expect(shortcutFor({ key: 'a', ctrlKey: false, metaKey: false, altKey: false })).toBeNull();
  });
  it('Sales nav is permission-gated', () => {
    expect(routePermFor('/sales/invoices')).toBe(SALES.view);
    expect(SALES_NAV_PERMS['/counter/bill']).toBe(SALES.issue);
  });
});

describe('milestone 2 rules', () => {
  const S = { discount_max_pct: '10', large_discount_pct: '5' };
  it('loose line: checks, defaults, request shape, and priced by position', () => {
    expect(looseIssues(emptyLoose())).toEqual(['item', 'purity', 'gross', 'net']);
    expect(looseIssues({ ...emptyLoose(), item_id: 'i', purity_id: 'p', gross_wt: '2', net_wt: '3' })).toEqual(['net_over_gross']);
    expect(looseIssues({ ...emptyLoose(), item_id: 'i', purity_id: 'p', gross_wt: '2', pieces: '-1' })).toEqual(['pieces']);
    const l = nn(looseToDraft({ ...emptyLoose(), item_id: 'i', purity_id: 'p', gross_wt: '2.5', stone_wt: '0.2', net_wt: '2.3', counter_id: 'c1' }, 'k'));
    expect(l).toMatchObject({ kind: 'loose', gross_wt: '2.500', stone_wt: '0.200', net_wt: '2.300', pieces: 1, counter_id: 'c1', tray_id: null });
    const req = nn(toIssueRequest(ready({ lines: [...ready().lines, l] })));
    expect(req.lines[1]).toEqual({ kind: 'loose', item_id: 'i', purity_id: 'p', gross_wt: '2.500', net_wt: '2.300', stone_wt: '0.200', pieces: 1, counter_id: 'c1', tray_id: null });
    const loosePriced = pricedLine({ line_no: 2, kind: 'loose', tag_id: null, tag_no: null, line_total: '15000.00' });
    expect(pricedAt([...ready().lines, l], 1, [pricedLine(), loosePriced])?.line_total).toBe('15000.00');
    expect(pricedAt([...ready().lines, l], 1, [pricedLine()])).toBeNull();
    expect(errorLineIndex(new ApiError(409, 'insufficient_loose_stock', 'x', undefined, [{ path: 'lines[1].net_wt', message: 'm' }]))).toBe(1);
  });
  it('discounts against the shop limits: ok, large, above limit, more than value, not a number', () => {
    expect(discountState('', '1000', S)).toBe('none');
    expect(discountState('20', '1000', S)).toBe('ok');
    expect(discountState('50', '1000', S)).toBe('large');
    expect(discountState('100.01', '1000', S)).toBe('over_max');
    expect(discountState('1001', '1000', S)).toBe('over_value');
    expect(discountState('abc', '1000', S)).toBe('invalid');
  });
  it('line discount is sent; no permission → blocked; above the limit needs override_min + reason', () => {
    const d = ready({ lines: [{ kind: 'tag', key: 'k1', tag_id: 'tag-1', tag_no: 'RSP-01', priced: pricedLine(), discount: '10000' }] });
    expect(nn(toIssueRequest(d)).lines[0]).toMatchObject({ discount: '10000.00' });
    const c = computation();
    const st = { ...S, old_gold_excess_handling: 'refund_on_bill' as const };
    expect(draftDiscounts(d, c.lines, c.totals.gross_value, S)).toMatchObject({ lines: ['over_max'], overMax: true });
    expect(issueBlockers(c, d, (p) => p !== SALES.discountGive, st)).toContain('discount');
    expect(issueBlockers(c, d, (p) => p !== SALES.overrideMin, st)).toContain('override_min');
    expect(issueBlockers(c, { ...d, discount_reason: 'Old customer' }, all, st)).not.toContain('override_min');
    const small = { ...d, lines: d.lines.map((l) => ({ ...l, discount: '500' })) };
    expect(issueBlockers(c, small, all, st)).toEqual([]);
    expect(issueBlockers(c, { ...d, bill_discount: '99999999' }, all, st)).toContain('discount_invalid');
  });
  it('B2B: GSTIN makes it business; place of supply is sent only for B2C; conflicts are caught', () => {
    const b2c = ready({ place_of_supply: '29' });
    expect(nn(toIssueRequest(b2c)).place_of_supply).toBe('29');
    expect(nn(toEstimateRequest(b2c)).place_of_supply).toBe('29');
    const b2b = ready({ customer: { kind: 'existing', id: CUST, name: 'Meena Traders', gstin: '29ABCDE1234F1Z5', state_code: '29' } });
    expect(draftSupplyType(b2b)).toBe('b2b');
    expect(nn(toIssueRequest(b2b))).not.toHaveProperty('place_of_supply');
    expect(supplyIssues({ ...b2b, place_of_supply: '33' })).toEqual(['pos_conflict']);
    expect(supplyIssues({ ...b2b, place_of_supply: '29' })).toEqual([]);
    expect(supplyIssues({ customer: { kind: 'new', name: 'X', phone: '9840000002', gstin: '29ABC', state_code: '3' } })).toEqual(['gstin_invalid', 'state_invalid']);
    expect(supplyIssues({ customer: { kind: 'new', name: 'X', phone: '9840000002', gstin: '29ABCDE1234F1Z5', state_code: '33' } })).toEqual(['gstin_state_mismatch']);
    const nb = nn(toIssueRequest(ready({ customer: { kind: 'new', name: 'X', phone: '9840000002', gstin: '29abcde1234f1z5' } })));
    expect(nb).toMatchObject({ customer: { gstin: '29ABCDE1234F1Z5', state_code: '29' } });
    expect(gstinInput(' 33aabcd1234e1z5 ')).toBe('33AABCD1234E1Z5');
    expect(issueBlockers(computation(), { ...b2b, place_of_supply: '33' }, all)).toContain('supply');
  });
});


describe('0.9.2 contract changes', () => {
  it('estimate preview needs only branch and lines; invoice preview still requires customer and salesperson', () => {
    const d = ready({ customer: { kind: 'none' }, salesperson_id: '' });
    expect(toPreviewRequest(d, 'bill')).toBeNull();
    const e = nn(toPreviewRequest(d, 'estimate'));
    expect(e).toMatchObject({ mode: 'estimate', branch_id: BR, lines: [{ kind: 'tag', tag_id: 'tag-1' }] });
    expect(e).not.toHaveProperty('customer_id'); expect(e).not.toHaveProperty('salesperson_id');
    expect(nn(toPreviewRequest(ready(), 'bill')).mode).toBe('invoice');
    const c = computation();
    expect(invoiceOnlyChecks(computation({ requirements: { ...c.requirements, pan_required: true, credit_sale_permission: true, cash_limit: { ...c.requirements.cash_limit, exceeded: true } } }))).toEqual(['pan', 'cash_limit', 'credit_sale']);
  });
  it('zero-piece loose lines can be previewed and saved as estimates, not issued; 0 is never coerced to 1', () => {
    const f = { ...emptyLoose(), item_id: 'i', purity_id: 'p', gross_wt: '1', pieces: '0' };
    expect(looseIssues(f)).toEqual([]);
    const line = nn(looseToDraft(f, 'loose-0'));
    const d = ready({ lines: [line] });
    expect(nn(toPreviewRequest(d, 'estimate')).lines[0]).toMatchObject({ kind: 'loose', pieces: 0 });
    expect(nn(toEstimateRequest(d)).lines[0]).toMatchObject({ pieces: 0 });
    expect(invalidGoodsLineIndex(d.lines)).toBe(-1);
    expect(issueBlockers(computation(), d, all)).not.toContain('goods_line');
    d.lines = [{ kind: 'loose', key: 'bad', item_id: 'i', purity_id: 'p', gross_wt: '0', net_wt: '0', pieces: 0 }];
    expect(invalidGoodsLineIndex(d.lines)).toBe(0); expect(issueBlockers(computation(), d, all)).toContain('goods_line');
  });
  it('all duplicate documents require reasons, including estimates; bank-transfer return default is kept', () => {
    for (const doc of ['invoice', 'credit_note', 'estimate'] as const) {
      expect(canPrint(doc, 1, '', all)).toBe(false);
      expect(canPrint(doc, 1, 'Customer copy', all)).toBe(true);
      expect(printBody({ printCount: 1, reason: '  Customer copy ' })).toMatchObject({ reprint_reason: 'Customer copy' });
    }
    expect(defaultRefundMode({ return_settlement_default: 'bank_transfer' })).toBe('bank_transfer');
  });
});
