import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AJV_VERSION, AJV_FORMATS_VERSION, oas, operations, validateAt, deref, pointer, type Res } from './contract';
import { salesFixture, type SalesFx } from './sales-fixture';
import { HUID_PREFIX } from './huid';

/**
 * 0.9.5 Sales contract test — wired like inventory-contract.test.ts (shared ContractRecorder: Ajv 2020-12 + strict RFC 3339 date-time,
 * undocumented-property and timestamp audits), now LIVE: every Sales operation is routed and called on real test-DB data, success and
 * error bodies alike, and must come back contract-clean.
 *  - static: every request / response schema compiles; responses list every property in `required`; no JSON numbers for money / weights /
 *    rates; *_at = date-time, dates = date; every writer takes Idempotency-Key (If-Match edits excepted); stock-moving operations declare
 *    their Inventory calls; issue requests reject client numbers / dates and unknown fields; 0.9.2 named enums, preview mode, settings PATCH,
 *    receipt reversal, CreditNote kind receipt_reversal, print_count / last_printed_at on Estimate and CreditNote;
 *  - routing: every Sales operation is implemented and routed (INV-2: no stray writer);
 *  - live: each operation's 2xx plus its documented 4xx problem bodies (400 / 401 / 403 / 404 / 409 / 412 / 422 / 428).
 */
const SALES_OPS = [
  'GET /v1/sales/readiness', 'GET /v1/sales/settings', 'PATCH /v1/sales/settings', 'GET /v1/sales/doc-series', 'GET /v1/sales/sellable/{code}', 'POST /v1/sales/preview',
  'POST /v1/sales/invoices', 'GET /v1/sales/invoices', 'GET /v1/sales/invoices/{id}',
  'POST /v1/sales/invoices/{id}/payments', 'POST /v1/sales/invoices/{id}/payments/{receipt_id}/prints', 'GET /v1/sales/invoices/{id}/payments', 'POST /v1/sales/invoices/{id}/payments/{receipt_id}/reversal',
  'POST /v1/sales/invoices/{id}/cancellation', 'POST /v1/sales/invoices/{id}/returns',
  'POST /v1/sales/invoices/{id}/prints', 'GET /v1/sales/invoices/{id}/prints',
  'POST /v1/sales/estimates', 'GET /v1/sales/estimates', 'GET /v1/sales/estimates/{id}', 'PUT /v1/sales/estimates/{id}',
  'POST /v1/sales/estimates/{id}/cancel', 'POST /v1/sales/estimates/{id}/prints',
  'GET /v1/sales/credit-notes', 'GET /v1/sales/credit-notes/{id}', 'POST /v1/sales/credit-notes/{id}/prints',
].sort();
const IMPLEMENTED = new Set<string>(SALES_OPS);
/** Writers that take no Idempotency-Key: preview has no side effects; estimate cancel / replace and settings PATCH are If-Match edits. */
const NO_IDEMPOTENCY = new Set(['POST /v1/sales/preview', 'POST /v1/sales/estimates/{id}/cancel', 'PATCH /v1/sales/settings']);
const IF_MATCH = new Set(['PUT /v1/sales/estimates/{id}', 'POST /v1/sales/estimates/{id}/cancel', 'PATCH /v1/sales/settings']);
const STOCK_OPS: Record<string, string[]> = {
  'POST /v1/sales/invoices': ['Stock.markSold', 'Stock.sellLoose', 'Stock.oldMetalIn'],
  'POST /v1/sales/invoices/{id}/cancellation': ['Stock.returnToStock'],
  'POST /v1/sales/invoices/{id}/returns': ['Stock.returnToStock'],
};

let fx: SalesFx;
const REPORT = process.env.CONTRACT_REPORT_SALES ?? `/tmp/jw-sales-contract-${process.pid}.json`;
const opOf = (op: string) => { const [m, p] = op.split(' '); return { m: m.toLowerCase(), p, o: oas.paths[p][m.toLowerCase()] }; };
const esc = (s: string) => s.replace(/~/g, '~0').replace(/\//g, '~1');

/**
 * Response shapes not owned by Sales or echoing a request as sent (optional fields stay optional there): not held to "all required".
 * Address is the shared Masters shape (all optional); *Request / *Input / CustomerQuickAdd are request schemas echoed in Estimate.request.
 */
const NOT_RESPONSE_SHAPE = /^#\/components\/schemas\/(Address|\w+Request|\w+Input|CustomerQuickAdd|EstimateRef)$/;
/** Every schema object reachable from `s` (through $ref / allOf / oneOf / anyOf / items / properties), each once. */
function walk(s: any, visit: (x: any, path: string) => void, path = '', seen = new Set<any>()): void {
  if (!s || typeof s !== 'object') return;
  const name = typeof s.$ref === 'string' ? s.$ref : null;
  if (name && NOT_RESPONSE_SHAPE.test(name)) return;
  const x = deref(s);
  if (!x || typeof x !== 'object' || seen.has(x)) return;
  seen.add(x);
  const here = name ? name.replace('#/components/schemas/', '') : path;
  visit(x, here);
  for (const k of ['allOf', 'oneOf', 'anyOf'] as const) (x[k] ?? []).forEach((y: any, i: number) => walk(y, visit, `${here}.${k}[${i}]`, seen));
  if (x.items) walk(x.items, visit, `${here}[]`, seen);
  for (const [k, v] of Object.entries<any>(x.properties ?? {})) walk(v, visit, `${here}.${k}`, seen);
  if (x.additionalProperties && typeof x.additionalProperties === 'object') walk(x.additionalProperties, visit, `${here}.*`, seen);
}
const responseSchemas = (op: string) => {
  const { o } = opOf(op);
  return Object.entries<any>(o.responses).flatMap(([code, r]) => Object.entries<any>(deref(r).content ?? {}).map(([media, c]) => ({ code, media, schema: c.schema })));
};
const MIN_ISSUE = { branch_id: '00000000-0000-4000-8000-000000000001', customer_id: '00000000-0000-4000-8000-000000000002',
  salesperson_id: '00000000-0000-4000-8000-000000000003', lines: [{ kind: 'tag', tag_no: 'CBE-RNG-00001' }] };

beforeAll(async () => { fx = await salesFixture('salesct', HUID_PREFIX.salesContract); }, 120000);
afterAll(async () => { if (fx) { writeFileSync(REPORT, fx.rec.report()); await fx.close(); } });

describe(`sales contract ${oas.info.version} (ajv ${AJV_VERSION}, ajv-formats ${AJV_FORMATS_VERSION})`, () => {
  it('Sales is contract 0.9.6 with exactly the planned operations, each with a unique operationId', () => {
    expect(oas.info.version).toBe('0.9.6');
    expect(operations('/v1/sales')).toEqual(SALES_OPS);
    const ids = SALES_OPS.map((op) => opOf(op).o.operationId as string);
    expect(new Set(ids).size).toBe(ids.length);
    for (const op of SALES_OPS) expect([op, opOf(op).o.tags]).toEqual([op, ['sales']]);
  });

  it('QA B8 / N4 — canonical decimal patterns and explicitly adjusted receipt balance are frozen', () => {
    for (const [name, good, bad] of [['Money', '1.00', ['1', '1.2', '1.234', 1]], ['Rate', '1.00', ['1', '1.2', '1.234', 1]], ['Weight', '1.000', ['1', '1.2', '1.23', '1.2345', 1]]] as const) {
      expect(validateAt(`#/components/schemas/${name}`, good).ok).toBe(true);
      for (const value of bad) expect(validateAt(`#/components/schemas/${name}`, value).ok).toBe(false);
    }
    const receipt = deref({ $ref: '#/components/schemas/PaymentReceipt' });
    expect(receipt.required).toContain('adjusted_balance_due_after');
    expect(receipt.properties.balance_due_after.deprecated).toBe(true);
    expect(receipt.properties.adjusted_balance_due_after.description).toContain('Not an as-at historical balance');
  });

  it('B4/B6 0.9.4 — mandatory seller/GST/original-reference/frozen-print metadata compile and reject missing fields', () => {
    const cn=deref({$ref:'#/components/schemas/CreditNote'}),line=deref({$ref:'#/components/schemas/CreditNoteLine'});
    for(const key of ['seller','place_of_supply','gst_type','supply_type','gst_applicable','original_invoice','tax_summary']) expect(cn.required).toContain(key);
    for(const key of ['hsn','tax_rate','tax_parts']) expect(line.required).toContain(key);
    const ref=deref({$ref:'#/components/schemas/OriginalInvoiceSnapshot'});
    for(const key of ['doc_no','doc_date','seller','lines','invoice_total']) expect(ref.required).toContain(key);
    const print=deref({$ref:'#/components/schemas/SalesPrintDocument'});
    for(const key of ['template_id','template_version','language','locale','numerals','snapshot']) expect(print.required).toContain(key);
    expect(print.properties.template_id.$ref).toBe('#/components/schemas/Uuid');
    expect(print.properties.template_version.type).toBe('integer');
    expect(validateAt('#/components/schemas/SalesPrintLocale','ta-IN').ok).toBe(true);
    expect(validateAt('#/components/schemas/SalesPrintLocale','ta').ok).toBe(false);
    const copyDescription=deref({$ref:'#/components/schemas/SalesPrintRequest'}).properties.copy.description;
    expect(copyDescription).toContain('data-model constraint');
    expect(copyDescription).toContain('first_print_duplicate_not_supported wins');
    expect(copyDescription).toContain('schema-shape validation remain ahead');
  });

  it('every Sales request and response schema compiles under Ajv 2020-12', () => {
    const bad: string[] = [];
    for (const op of SALES_OPS) {
      const { m, p, o } = opOf(op);
      for (const { code, media } of responseSchemas(op)) {
        const r = o.responses[code];
        const ptr = r.$ref ? `${r.$ref}/content/${esc(media)}/schema` : `#/paths/${esc(p)}/${m}/responses/${code}/content/${esc(media)}/schema`;
        try { if (!validateAt(ptr, null).errors.every((e) => !e.includes('did not compile'))) bad.push(`${op} ${code}`); } catch (e) { bad.push(`${op} ${code}: ${String(e)}`); }
      }
      if (o.requestBody) {
        try { validateAt(`#/paths/${esc(p)}/${m}/requestBody/content/application~1json/schema`, {}); } catch (e) { bad.push(`${op} body: ${String(e)}`); }
      }
    }
    expect(bad).toEqual([]);
  });

  it('responses: every object lists all its properties in required; no JSON numbers for money; *_at date-time, dates format date', () => {
    const notRequired: string[] = []; const numbers: string[] = []; const ts: string[] = [];
    const seen = new Set<any>();
    for (const op of SALES_OPS) for (const { schema, media } of responseSchemas(op)) {
      if (media === 'application/problem+json') continue;
      walk(schema, (x, path) => {
        const props = Object.keys(x.properties ?? {});
        const req = new Set<string>(x.required ?? []);
        for (const k of props) if (!req.has(k)) notRequired.push(`${path}.${k}`);
        for (const [k, v] of Object.entries<any>(x.properties ?? {})) {
          const d = deref(v) ?? {};
          const types = ([] as string[]).concat(d.type ?? []);
          if (k.endsWith('_at') && d.format !== 'date-time') ts.push(`${path}.${k} (format ${d.format})`);
          if (/(_date|_on|^valid_until)$/.test(k) && d.format !== 'date') ts.push(`${path}.${k} (format ${d.format})`);
          if (types.includes('number')) numbers.push(`${path}.${k}`);
        }
      }, op, seen);
    }
    expect(notRequired).toEqual([]);
    expect(numbers).toEqual([]);
    expect(ts).toEqual([]);
  });

  it('writers: Idempotency-Key on every POST writer, If-Match on estimate edits, Inventory calls declared where stock moves', () => {
    const paramNames = (op: string) => ((opOf(op).o.parameters ?? []) as any[]).map((x) => deref(x)).map((x) => `${x.in}:${x.name}`);
    for (const op of SALES_OPS.filter((x) => /^(POST|PUT|PATCH)/.test(x))) {
      if (!NO_IDEMPOTENCY.has(op) && !IF_MATCH.has(op)) expect([op, paramNames(op)]).toEqual([op, expect.arrayContaining(['header:Idempotency-Key'])]);
      if (IF_MATCH.has(op)) expect([op, paramNames(op)]).toEqual([op, expect.arrayContaining(['header:If-Match'])]);
    }
    for (const [op, calls] of Object.entries(STOCK_OPS)) expect([op, opOf(op).o['x-inventory-calls']]).toEqual([op, expect.arrayContaining(calls)]);
    // INV-2: one bill writer — issueInvoice is the only operation whose 201 is an Invoice
    const writers = SALES_OPS.filter((op) => responseSchemas(op).some((r) => r.code === '201' && r.schema.$ref === '#/components/schemas/Invoice'));
    expect(writers).toEqual(['POST /v1/sales/invoices']);
  });

  it('IssueInvoiceRequest: minimal body valid; client numbers / dates, unknown fields, JSON-number money and Aadhaar are rejected', () => {
    const v = (b: unknown) => validateAt('#/components/schemas/IssueInvoiceRequest', b);
    expect(v(MIN_ISSUE)).toMatchObject({ ok: true });
    expect(v({ ...MIN_ISSUE, lines: [{ kind: 'loose', item_id: MIN_ISSUE.branch_id, purity_id: MIN_ISSUE.branch_id, gross_wt: '2.500', net_wt: '2.500' }],
      old_metal: [{ purity_id: MIN_ISSUE.branch_id, gross_wt: '5.000' }], payments: [{ mode: 'cash', amount: '1000.00' }, { mode: 'upi', amount: '500.00', reference: 'UTR1' }],
      bill_discount: '100.00', discount_reason: 'festival', zero_gst: { reason: 'export order' }, expected_total: '12345.00', pan: 'ABCDE1234F' }).ok).toBe(true);
    for (const extra of [{ doc_no: 'X/1' }, { doc_date: '2026-11-09' }, { doc_seq: 1 }, { fy: '2026-27' }, { number: '1' }, { aadhaar: '123412341234' }])
      expect([extra, v({ ...MIN_ISSUE, ...extra }).ok]).toEqual([extra, false]);
    expect(v({ ...MIN_ISSUE, bill_discount: 100 }).ok).toBe(false);
    expect(v({ ...MIN_ISSUE, payments: [{ mode: 'cash', amount: 1000 }] }).ok).toBe(false);
    expect(v({ ...MIN_ISSUE, payments: [{ mode: 'advance', amount: '10.00' }] }).ok).toBe(false);   // S31: advances are Accounts
    const { customer_id: _c, ...noCustomer } = MIN_ISSUE;
    expect(v(noCustomer).ok).toBe(false);
    expect(v({ ...noCustomer, customer: { name: 'Ravi', phone: '+91 98765 43210' } }).ok).toBe(true);
    expect(v({ ...MIN_ISSUE, customer: { name: 'Ravi', phone: '9876543210' } }).ok).toBe(false);   // exactly one of customer_id / customer
    expect(v({ ...MIN_ISSUE, lines: [{ kind: 'tag' }] }).ok).toBe(false);
    expect(v({ ...MIN_ISSUE, lines: [{ kind: 'tag', tag_no: 'A', tag_id: MIN_ISSUE.branch_id }] }).ok).toBe(false);
  });

  it('0.9.1 lead ruling: old-gold rate override pairs with a reason; priced old gold shows server / applied rate; requirements report credit sale + override', () => {
    const og = (x: object) => validateAt('#/components/schemas/OldGoldInput', { purity_id: MIN_ISSUE.branch_id, gross_wt: '5.000', ...x }).ok;
    expect(og({})).toBe(true);
    expect(og({ rate_override: '6500.00', override_reason: 'tested lower purity' })).toBe(true);
    expect(og({ rate_override: '6500.00' })).toBe(false);                                // reason mandatory
    expect(og({ rate_override: '6500.00', override_reason: 'low' })).toBe(false);        // 5-200 chars
    expect(og({ rate_override: '6500.00', override_reason: 'x'.repeat(201) })).toBe(false);
    expect(og({ override_reason: 'no override given' })).toBe(false);                   // reason only with an override
    expect(og({ rate_override: 6500, override_reason: 'tested lower purity' })).toBe(false); // decimal string, never a JSON number
    expect(validateAt('#/components/schemas/IssueInvoiceRequest', { ...MIN_ISSUE, old_metal: [{ purity_id: MIN_ISSUE.branch_id, gross_wt: '5.000', rate_override: '6500.00', override_reason: 'tested lower purity' }] }).ok).toBe(true);
    const pog = pointer('#/components/schemas/PricedOldGold');
    expect(pog.required).toEqual(expect.arrayContaining(['server_rate', 'rate_per_g', 'overridden', 'override_reason']));
    const breq = pointer('#/components/schemas/BillRequirements');
    expect(breq.required).toEqual(expect.arrayContaining(['credit_sale_permission', 'old_gold_rate_override_permission', 'cash_limit']));
    expect(breq.properties.cash_limit.properties.exceeded.description).toContain('>=');
    // settings: cash limit is '>=' on cash on one bill; separate making rate has no default (nullable) and a readiness gate
    const st = pointer('#/components/schemas/SalesSettings');
    expect(st.properties.cash_limit_amount.description).toMatch(/cash on one bill.*>=/);
    expect(st.required).toContain('making_service_rate');
    for (const [v, ok] of [[null, true], ['5.00', true], [5, false]] as const)
      expect([v, validateAt('#/components/schemas/SalesSettings/properties/making_service_rate', v).ok]).toEqual([v, ok]);
    const gate = pointer('#/components/schemas/BillingReadiness').properties.gates.items.properties.code;
    expect(gate.enum).toContain('making_service_rate');
    const codes = `${deref({ $ref: '#/components/responses/SalesUnprocessable' }).description} ${deref({ $ref: '#/components/responses/SalesConflict' }).description}`;
    for (const c of ['making_service_rate_not_set', 'credit_sale_not_allowed', 'old_gold_rate_override_not_allowed', 'cash_limit_exceeded', 'customer_phone_exists'])
      expect([c, codes.includes(c)]).toEqual([c, true]);
    expect(oas.info.description).toEqual(expect.stringContaining('sales.invoice.credit_sale'));
    expect(oas.info.description).toEqual(expect.stringContaining('sales.old_gold.rate_override'));
  });

  it('0.9.1: 409 customer_phone_exists carries a typed existing_customer {customer_id, name}', () => {
    const ptr = '#/components/responses/SalesConflict/content/application~1problem+json/schema';
    const base = { type: 'about:blank', title: 'Conflict', status: 409 };
    expect(validateAt(ptr, { ...base, code: 'customer_phone_exists', existing_customer: { customer_id: MIN_ISSUE.customer_id, name: 'Ravi' } }).ok).toBe(true);
    expect(validateAt(ptr, { ...base, code: 'customer_phone_exists' }).ok).toBe(false);
    expect(validateAt(ptr, { ...base, code: 'customer_phone_exists', existing_customer: { customer_id: MIN_ISSUE.customer_id } }).ok).toBe(false);
    expect(validateAt(ptr, { ...base, code: 'tag_sold' }).ok).toBe(true);
    for (const op of ['POST /v1/sales/invoices', 'POST /v1/sales/preview'])
      expect([op, opOf(op).o.responses['409'].$ref]).toEqual([op, '#/components/responses/SalesConflict']);
  });

  it('response examples: an Invoice with a timestamp in Postgres text form fails; RFC 3339 passes', () => {
    const inv = pointer('#/components/schemas/Invoice');
    expect(inv.required).toEqual(expect.arrayContaining(['doc_no', 'doc_date', 'issued_at', 'totals', 'payment_status', 'lines']));
    expect(validateAt('#/components/schemas/PaymentReceipt', { id: MIN_ISSUE.branch_id, receipt_no: 'RCP-1', invoice_id: MIN_ISSUE.branch_id, invoice_no: 'CBE/2627/000001',
      branch_id: MIN_ISSUE.branch_id, received_on: '2026-11-09', received_at: '2026-11-09 18:46:01.792494+05:30', received_by: MIN_ISSUE.branch_id, tenders: [],
      total: '0.00', balance_due_after: '0.00', adjusted_balance_due_after: '0.00', note: null, customer_id: MIN_ISSUE.customer_id, reverses_receipt_id: null, reversed_by_receipt_id: null, reversal_reason: null }).ok).toBe(false);
    expect(validateAt('#/components/schemas/PaymentReceipt', { id: MIN_ISSUE.branch_id, receipt_no: 'RCP-1', invoice_id: MIN_ISSUE.branch_id, invoice_no: 'CBE/2627/000001',
      branch_id: MIN_ISSUE.branch_id, received_on: '2026-11-09', received_at: '2026-11-09T13:16:01.792494Z', received_by: MIN_ISSUE.branch_id, tenders: [],
      total: '0.00', balance_due_after: '0.00', adjusted_balance_due_after: '0.00', note: null, customer_id: MIN_ISSUE.customer_id, reverses_receipt_id: null, reversed_by_receipt_id: null, reversal_reason: null }).ok).toBe(true);
  });

  it('routing: implemented Sales operations are routed, every other Sales operation is not (contract only, 404)', async () => {
    const app = fx.app;
    const fastify = app.getHttpAdapter().getInstance() as unknown as { hasRoute?: (o: { method: string; url: string }) => boolean };
    for (const op of SALES_OPS) {
      const { m, p } = opOf(op);
      const routeUrl = `/api${p.replace(/\{(\w+)\}/g, ':$1')}`;
      let routed: boolean;
      if (typeof fastify.hasRoute === 'function') routed = fastify.hasRoute({ method: m.toUpperCase(), url: routeUrl });
      else {
        const r = await app.inject({ method: m.toUpperCase() as 'GET', url: `/api${p.replace(/\{\w+\}/g, '00000000-0000-4000-8000-000000000009')}` }) as unknown as Res;
        routed = r.statusCode !== 404;
      }
      expect([op, routed]).toEqual([op, IMPLEMENTED.has(op)]);
    }
  });

  it('0.9.2: named enums, preview mode, settings PATCH (If-Match, owner), receipt reversal, CreditNote kind receipt_reversal, print fields', () => {
    const S = (n: string) => pointer(`#/components/schemas/${n}`);
    expect(S('RefundMode').enum).toEqual(['store_credit', 'cash', 'bank_transfer', 'reversal']);
    expect(S('ReturnRefundMode').enum).toEqual(['store_credit', 'cash', 'bank_transfer']);
    expect(S('CreditNoteKind').enum).toEqual(expect.arrayContaining(['cancellation', 'sales_return', 'receipt_reversal']));
    for (const n of ['SalesLineKind', 'PrintCopy', 'MakingGstTreatment']) expect([n, Array.isArray(S(n).enum)]).toEqual([n, true]);
    expect(validateAt('#/components/schemas/PreviewBillRequest', { mode: 'estimate', branch_id: MIN_ISSUE.branch_id, lines: MIN_ISSUE.lines }).ok).toBe(true);
    expect(validateAt('#/components/schemas/PreviewBillRequest', { mode: 'invoice', ...MIN_ISSUE }).ok).toBe(true);
    expect(validateAt('#/components/schemas/PreviewBillRequest', { mode: 'draft', ...MIN_ISSUE }).ok).toBe(false);
    for (const n of ['Estimate', 'CreditNote']) expect([n, S(n).required]).toEqual([n, expect.arrayContaining(['print_count', 'last_printed_at'])]);
    expect(S('CreditNote').required).toContain('reversal_receipt_id');
    const patch = opOf('PATCH /v1/sales/settings').o;
    expect(patch.operationId).toBe('patchSalesSettings');
    expect(patch['x-permission'] ?? patch.description).toMatch(/sales\.settings\.edit/);
    expect(deref(patch.responses['200']).content['application/json'].schema.$ref).toBe('#/components/schemas/SalesSettings');
    const rev = opOf('POST /v1/sales/invoices/{id}/payments/{receipt_id}/reversal').o;
    expect(rev.description).toMatch(/sales\.receipt\.reverse/);
    expect(validateAt('#/components/schemas/ReceiptReversalRequest', { reason: 'cheque bounced' }).ok).toBe(true);
    expect(validateAt('#/components/schemas/ReceiptReversalRequest', { reason: 'no' }).ok).toBe(false);
    expect(validateAt('#/components/schemas/ReceiptReversalRequest', {}).ok).toBe(false);
    const ptr = '#/components/responses/SalesUnprocessable/content/application~1problem+json/schema';
    const base = { type: 'about:blank', title: 'Unprocessable Entity', status: 422 };
    expect(validateAt(ptr, { ...base, code: 'making_service_rate_not_set', setting_key: 'making_service_rate', settings_path: '/v1/sales/settings' }).ok).toBe(true);
    expect(validateAt(ptr, { ...base, code: 'making_service_rate_not_set' }).ok).toBe(false);
    const conflicts = deref({ $ref: '#/components/responses/SalesConflict' }).description as string;
    for (const c of ['receipt_already_reversed', 'receipt_is_reversal', 'receipt_not_reversible', 'invoice_changed']) expect([c, conflicts.includes(c)]).toEqual([c, true]);
  });

  it('0.9.3: immutable cancellation print snapshots and positive-weight zero-piece loose inputs', () => {
    for (const n of ['SalesPrintDocument', 'SalesPrintLogEntry']) {
      const schema = pointer(`#/components/schemas/${n}`);
      expect(schema.required).toContain('doc_cancelled');
      expect(schema.properties.doc_cancelled.type).toBe('boolean');
    }
    for (const body of [{}, { copy: 'auto' }, { copy: 'duplicate' }, { copy: 'duplicate', reprint_reason: null }, { copy: 'duplicate', reprint_reason: 'file copy' }]) expect(validateAt('#/components/schemas/SalesPrintRequest', body).ok).toBe(true);
    for (const body of [{ copy: 'original' }, { copy: 'duplicate', reprint_reason: 123 }, { copy: 'duplicate', reprint_reason: 'x'.repeat(201) }]) expect(validateAt('#/components/schemas/SalesPrintRequest', body).ok).toBe(false);
    const base = { kind: 'loose', item_id: MIN_ISSUE.branch_id, purity_id: MIN_ISSUE.branch_id, gross_wt: '1.000', net_wt: '1.000' };
    for (const l of [base, { ...base, pieces: 0 }, { ...base, pieces: 1, net_wt: '0.000' }]) expect(validateAt('#/components/schemas/SaleLooseLineInput', l).ok).toBe(true);
    for (const l of [{ ...base, net_wt: '0.000' }, { ...base, pieces: 0, net_wt: '00.000' }, { ...base, pieces: 1, gross_wt: '0.000' }]) expect(validateAt('#/components/schemas/SaleLooseLineInput', l).ok).toBe(false);
    expect(validateAt('#/components/schemas/SaleTagLineInput', { kind: 'tag', tag_id: MIN_ISSUE.branch_id, pieces: 0 }).ok).toBe(false);
    expect(deref({ $ref: '#/components/responses/SalesConflict' }).description).not.toContain('cancelled_invoice_original_unavailable');
    expect(deref({ $ref: '#/components/responses/SalesUnprocessable' }).description).not.toContain('weight_only_loose_sale_not_supported');
  });

  describe('live: every Sales operation on the test DB (2xx and problem bodies)', () => {
    const k = () => fx.key();
    const st = async (method: string, t: string, status: number, o: Parameters<SalesFx['go']>[2] = {}) => (await fx.go(method, t, { ...o, status })).json();
    let inv: any; let inv2: any; let cust: string; let est: any; let cn: any; let rc: any;
    it('setup ops: readiness, settings GET / PATCH, doc-series, sellable, preview', async () => {
      await st('GET', '/v1/sales/readiness', 200, { q: { branch_id: fx.B1 } });
      await st('GET', '/v1/sales/readiness', 401, { cookie: '', q: { branch_id: fx.B1 } });
      await st('GET', '/v1/sales/readiness', 422, {});
      const g = await fx.go('GET', '/v1/sales/settings', { status: 200 });
      await st('GET', '/v1/sales/settings', 401, { cookie: '' });
      await st('PATCH', '/v1/sales/settings', 403, { cookie: fx.sales, body: { return_window_days: 10 }, headers: { 'if-match': g.headers.etag as string } });
      await st('PATCH', '/v1/sales/settings', 412, { body: { return_window_days: 10 }, headers: { 'if-match': '"77"' } });
      await st('PATCH', '/v1/sales/settings', 422, { body: { cash_limit_mode: 'maybe' }, headers: { 'if-match': g.headers.etag as string } });
      const s = await st('PATCH', '/v1/sales/settings', 200, { body: { return_window_days: 10 }, headers: { 'if-match': g.headers.etag as string } });
      expect(s.return_window_days).toBe(10);
      await st('PATCH', '/v1/sales/settings', 428, { body: { return_window_days: 10 } });
      await st('GET', '/v1/sales/doc-series', 200, { q: { branch_id: fx.B1 } });
      const t = await fx.tag({ gross_wt: '1.000', net_wt: '1.000', wastage_pct: '0' });
      await st('GET', '/v1/sales/sellable/{code}', 200, { p: { code: t.tag_no }, q: { branch_id: fx.B1 } });
      await st('GET', '/v1/sales/sellable/{code}', 404, { p: { code: 'ZZ-NONE' }, q: { branch_id: fx.B1 } });
      await st('GET', '/v1/sales/sellable/{code}', 422, { p: { code: t.tag_no } });
      cust = await fx.customer();
      await st('POST', '/v1/sales/preview', 200, { body: { branch_id: fx.B1, customer_id: cust, salesperson_id: fx.staff, lines: [{ kind: 'tag', tag_id: t.id }] } });
      await st('POST', '/v1/sales/preview', 200, { body: { mode: 'estimate', branch_id: fx.B1, lines: [{ kind: 'tag', tag_id: t.id }] } });
      await st('POST', '/v1/sales/preview', 422, { body: { branch_id: fx.B1, lines: [{ kind: 'tag', tag_id: t.id }], doc_no: 'X' } });
      await st('POST', '/v1/sales/preview', 403, { cookie: fx.managerNoDevice, body: { branch_id: fx.B1, customer_id: cust, salesperson_id: fx.staff, lines: [{ kind: 'tag', tag_id: t.id }] } });
      await fx.settings({ making_gst_treatment: 'separate', making_service_rate: null });
      const e = await st('POST', '/v1/sales/preview', 422, { body: { branch_id: fx.B1, customer_id: cust, salesperson_id: fx.staff, lines: [{ kind: 'tag', tag_id: t.id }] } });
      expect(e).toMatchObject({ code: 'making_service_rate_not_set', setting_key: 'making_service_rate', settings_path: '/v1/sales/settings' });
      await fx.settings({ making_gst_treatment: 'composite' });
      await st('POST', '/v1/sales/preview', 409, { body: { branch_id: fx.B1, customer: { name: 'Dup', phone: (await fx.sql<{ phone: string }>(`SELECT phone FROM masters.customer WHERE id = $1`, [cust]))[0].phone }, salesperson_id: fx.staff, lines: [{ kind: 'tag', tag_id: t.id }] } })
        .then((b) => expect(b.existing_customer.customer_id).toBe(cust));
    });
    it('QA IDEM-3 invoices: issue (201, replay200, missing-key400, 403, 409, 412, 422), list, get, payments, reversal, returns, cancellation, prints', async () => {
      const t1 = await fx.tag({ gross_wt: '1.000', net_wt: '1.000', wastage_pct: '0' });
      const t2 = await fx.tag({ gross_wt: '1.000', net_wt: '1.000', wastage_pct: '0' });
      const body = { branch_id: fx.B1, customer_id: cust, salesperson_id: fx.staff, lines: [{ kind: 'tag', tag_id: t1.id }, { kind: 'tag', tag_id: t2.id }], payments: [{ mode: 'cash', amount: '2000.00' }] };
      const key = k();
      inv = await st('POST', '/v1/sales/invoices', 201, { body, headers: key });
      expect((await st('POST', '/v1/sales/invoices', 200, { body, headers: key })).id).toBe(inv.id);
      await st('POST', '/v1/sales/invoices', 422, { body: { ...body, lines: [{ kind: 'tag', tag_id: t1.id }] }, headers: key });   // same key, other body
      await st('POST', '/v1/sales/invoices', 409, { body, headers: k() });                                                          // tag sold
      const fresh = async () => ({ ...body, lines: [{ kind: 'tag', tag_id: (await fx.tag({ gross_wt: '1.000', net_wt: '1.000', wastage_pct: '0' })).id }] });
      await st('POST', '/v1/sales/invoices', 403, { body: { ...(await fresh()), payments: [] }, headers: k(), cookie: fx.cashier });
      await st('POST', '/v1/sales/invoices', 422, { body: { ...body, doc_date: '2026-01-01' }, headers: k() });
      expect(await st('POST', '/v1/sales/invoices', 400, { body, headers: {} })).toMatchObject({status:400,code:'idempotency_key_required'});
      await st('POST', '/v1/sales/invoices', 401, { body, headers: k(), cookie: '' });
      const e0 = await st('POST', '/v1/sales/estimates', 201, { body: { branch_id: fx.B1, customer_id: cust, lines: [{ kind: 'tag', tag_id: (await fx.tag({ gross_wt: '1.000', net_wt: '1.000', wastage_pct: '0' })).id }] }, headers: k() });
      await st('POST', '/v1/sales/invoices', 412, { body: { ...body, lines: e0.request.lines, estimates: [{ id: e0.id, version: 9 }] }, headers: k() });
      await st('GET', '/v1/sales/invoices', 200, { q: { branch_id: fx.B1 } });
      await st('GET', '/v1/sales/invoices', 422, { q: { cursor: 'not-a-cursor' } });
      await st('GET', '/v1/sales/invoices/{id}', 200, { p: { id: inv.id } });
      await st('GET', '/v1/sales/invoices/{id}', 404, { p: { id: '00000000-0000-4000-8000-000000000077' } });
      rc = await st('POST', '/v1/sales/invoices/{id}/payments', 201, { p: { id: inv.id }, body: { tenders: [{ mode: 'upi', amount: '1000.00', reference: 'UTR9' }] }, headers: k() });
      await st('POST', '/v1/sales/invoices/{id}/payments', 422, { p: { id: inv.id }, body: { tenders: [{ mode: 'upi', amount: '99999.00', reference: 'X' }] }, headers: k() });
      await st('POST', '/v1/sales/invoices/{id}/payments', 404, { p: { id: '00000000-0000-4000-8000-000000000077' }, body: { tenders: [{ mode: 'upi', amount: '1.00', reference: 'X' }] }, headers: k() });
      await st('POST', '/v1/sales/invoices/{id}/payments', 403, { p: { id: inv.id }, body: { tenders: [{ mode: 'upi', amount: '1.00', reference: 'X' }] }, headers: k(), cookie: fx.sales });
      await st('GET', '/v1/sales/invoices/{id}/payments', 200, { p: { id: inv.id } });
      await st('GET', '/v1/sales/invoices/{id}/payments', 404, { p: { id: '00000000-0000-4000-8000-000000000077' } });
      const R = '/v1/sales/invoices/{id}/payments/{receipt_id}/reversal';
      await st('POST', R, 403, { p: { id: inv.id, receipt_id: rc.id }, body: { reason: 'wrong bill' }, headers: k(), cookie: fx.cashier });
      await st('POST', R, 422, { p: { id: inv.id, receipt_id: rc.id }, body: { reason: 'x' }, headers: k(), cookie: fx.manager });
      await st('POST', R, 404, { p: { id: inv.id, receipt_id: '00000000-0000-4000-8000-000000000077' }, body: { reason: 'wrong bill' }, headers: k(), cookie: fx.manager });
      const rv = await st('POST', R, 201, { p: { id: inv.id, receipt_id: rc.id }, body: { reason: 'wrong bill' }, headers: k(), cookie: fx.manager });
      await st('POST', R, 409, { p: { id: inv.id, receipt_id: rc.id }, body: { reason: 'wrong bill' }, headers: k(), cookie: fx.manager });
      expect(rv.store_credit_note).toBeNull();
      cn = await st('POST', '/v1/sales/invoices/{id}/returns', 201, { p: { id: inv.id }, body: { line_ids: [inv.lines[0].id], reason: 'does not fit', refund_mode: 'store_credit' }, headers: k() });
      await st('POST', '/v1/sales/invoices/{id}/returns', 409, { p: { id: inv.id }, body: { line_ids: [inv.lines[0].id], reason: 'does not fit' }, headers: k() });
      await st('POST', '/v1/sales/invoices/{id}/returns', 422, { p: { id: inv.id }, body: { line_ids: [], reason: 'does not fit' }, headers: k() });
      await st('POST', '/v1/sales/invoices/{id}/returns', 404, { p: { id: '00000000-0000-4000-8000-000000000077' }, body: { line_ids: [inv.lines[0].id], reason: 'does not fit' }, headers: k() });
      await st('POST', '/v1/sales/invoices/{id}/returns', 403, { p: { id: inv.id }, body: { line_ids: [inv.lines[1].id], reason: 'does not fit' }, headers: k(), cookie: fx.sales });
      // store credit drawn by a receipt, then reversed → receipt_reversal note in the reversal body
      inv2 = await st('POST', '/v1/sales/invoices', 201, { body: { branch_id: fx.B1, customer_id: cust, salesperson_id: fx.staff, lines: [{ kind: 'tag', tag_id: (await fx.tag({ gross_wt: '1.000', net_wt: '1.000', wastage_pct: '0' })).id }] }, headers: k(), cookie: fx.manager });
      const r2 = await st('POST', '/v1/sales/invoices/{id}/payments', 201, { p: { id: inv2.id }, body: { tenders: [{ mode: 'credit_note', credit_note_id: cn.id, amount: '500.00' }] }, headers: k() });
      await st('POST', '/v1/sales/invoices/{id}/payments', 409, { p: { id: inv2.id }, body: { tenders: [{ mode: 'credit_note', credit_note_id: cn.id, amount: '1600.00' }] }, headers: k() });
      const rv2 = await st('POST', R, 201, { p: { id: inv2.id, receipt_id: r2.id }, body: { reason: 'applied to wrong bill' }, headers: k(), cookie: fx.manager });
      expect(rv2.store_credit_note).toMatchObject({ kind: 'receipt_reversal', total: '500.00' });
      expect(await st('POST', '/v1/sales/invoices/{id}/prints', 200, { p: { id: inv.id }, body: {}, headers: k() })).toMatchObject({ copy: 'original', doc_cancelled: false });
      await st('POST', '/v1/sales/invoices/{id}/prints', 422, { p: { id: inv.id }, body: {}, headers: k() });
      await st('POST', '/v1/sales/invoices/{id}/prints', 403, { p: { id: inv.id }, body: { reprint_reason: 'lost copy' }, headers: k(), cookie: fx.sales });
      await st('POST', '/v1/sales/invoices/{id}/prints', 404, { p: { id: '00000000-0000-4000-8000-000000000077' }, body: {}, headers: k() });
      await st('POST', '/v1/sales/invoices/{id}/prints', 200, { p: { id: inv.id }, body: { reprint_reason: 'lost copy', paper: 'A5' }, headers: k() });
      await st('GET', '/v1/sales/invoices/{id}/prints', 200, { p: { id: inv.id } });
      await st('GET', '/v1/sales/invoices/{id}/prints', 404, { p: { id: '00000000-0000-4000-8000-000000000077' } });
      await st('POST', '/v1/sales/invoices/{id}/cancellation', 403, { p: { id: inv.id }, body: { reason: 'billing error', refund_mode: 'cash' }, headers: k(), cookie: fx.cashier });
      await st('POST', '/v1/sales/invoices/{id}/cancellation', 422, { p: { id: inv.id }, body: { reason: 'x', refund_mode: 'cash' }, headers: k(), cookie: fx.manager });
      await st('POST', '/v1/sales/invoices/{id}/cancellation', 404, { p: { id: '00000000-0000-4000-8000-000000000077' }, body: { reason: 'billing error', refund_mode: 'cash' }, headers: k(), cookie: fx.manager });
      const cx = await st('POST', '/v1/sales/invoices/{id}/cancellation', 201, { p: { id: inv.id }, body: { reason: 'billing error', refund_mode: 'cash' }, headers: k(), cookie: fx.manager });
      expect(cx.kind).toBe('cancellation');
      await st('POST', '/v1/sales/invoices/{id}/cancellation', 409, { p: { id: inv.id }, body: { reason: 'billing error', refund_mode: 'cash' }, headers: k(), cookie: fx.manager });
      await st('GET', '/v1/sales/invoices/{id}', 200, { p: { id: inv.id } });
    });
    it('0.9.3: cancelled-before-first-print responses and logs carry doc_cancelled', async () => {
      const tag = await fx.tag({ gross_wt: '1.000', net_wt: '1.000', wastage_pct: '0' });
      const target = await st('POST', '/v1/sales/invoices', 201, { headers: k(), body: { branch_id: fx.B1, customer_id: cust, salesperson_id: fx.staff,
        lines: [{ kind: 'tag', tag_id: tag.id }], payments: [{ mode: 'upi', amount: '6695.00' }] } });
      const cancelled = await st('POST', '/v1/sales/invoices/{id}/cancellation', 201, { p: { id: target.id }, headers: k(), cookie: fx.manager, body: { reason: 'incorrect invoice', refund_mode: 'cash' } });
      await st('POST', '/v1/sales/invoices/{id}/prints', 422, { p: { id: target.id }, headers: k(), body: {} });
      const pr = await st('POST', '/v1/sales/invoices/{id}/prints', 200, { p: { id: target.id }, headers: k(), body: { reprint_reason: 'cancelled file copy' } });
      expect(pr).toMatchObject({ print_no: 1, copy: 'duplicate', doc_cancelled: true, stamp: 'CANCELLED' });
      expect(pr.notes).toContain(`Cancelled by credit note ${cancelled.doc_no}`);
      const logs = await st('GET', '/v1/sales/invoices/{id}/prints', 200, { p: { id: target.id } });
      expect(logs[0]).toMatchObject({ print_no: 1, copy: 'duplicate', doc_cancelled: true });
    });
    it('0.9.3: optional copy selector enforces reason/schema limits without creating a hidden original', async () => {
      const tag = await fx.tag({ gross_wt: '1.000', net_wt: '1.000', wastage_pct: '0' });
      const target = await st('POST', '/v1/sales/invoices', 201, { headers: k(), body: { branch_id: fx.B1, customer_id: cust, salesperson_id: fx.staff,
        lines: [{ kind: 'tag', tag_id: tag.id }], payments: [{ mode: 'upi', amount: '6695.00' }] } });
      const p = { id: target.id };
      expect((await st('POST', '/v1/sales/invoices/{id}/prints', 422, { p, headers: k(), body: { copy: 'duplicate' } })).code).toBe('first_print_duplicate_not_supported');
      expect((await st('POST', '/v1/sales/invoices/{id}/prints', 422, { p, headers: k(), body: { copy: 'duplicate', reprint_reason: 'file copy' } })).code).toBe('first_print_duplicate_not_supported');
      expect(await st('POST', '/v1/sales/invoices/{id}/prints', 200, { p, headers: k(), body: { copy: 'auto' } })).toMatchObject({ print_no: 1, copy: 'original', doc_cancelled: false });
      expect(await st('POST', '/v1/sales/invoices/{id}/prints', 200, { p, headers: k(), body: { copy: 'duplicate', reprint_reason: 'file copy' } })).toMatchObject({ print_no: 2, copy: 'duplicate' });
      expect(await st('POST', '/v1/sales/invoices/{id}/prints', 200, { p, headers: k(), body: { copy: 'auto', reprint_reason: 'second file copy' } })).toMatchObject({ print_no: 3, copy: 'duplicate' });
      await st('POST', '/v1/sales/invoices/{id}/prints', 422, { p, headers: k(), body: { copy: 'original' } });
    });
    it('0.9.3: zero-piece loose invoice and whole-line return responses are contract-clean', async () => {
      await fx.loose(0, '2.000', fx.counter2);
      const line = { kind: 'loose', item_id: fx.coin, purity_id: fx.P24, counter_id: fx.counter2, pieces: 0, gross_wt: '1.000', net_wt: '1.000' };
      const body = { branch_id: fx.B1, customer_id: cust, salesperson_id: fx.staff, lines: [line], payments: [{ mode: 'upi', amount: '6695.00' }] };
      const pv = await st('POST', '/v1/sales/preview', 200, { body });
      expect(pv.lines[0].pieces).toBe(0);
      const target = await st('POST', '/v1/sales/invoices', 201, { body, headers: k() });
      expect(target.lines[0].pieces).toBe(0);
      const note = await st('POST', '/v1/sales/invoices/{id}/returns', 201, { p: { id: target.id }, headers: k(), body: { line_ids: [target.lines[0].id], reason: 'weight-only return', refund_mode: 'cash' } });
      expect(note.lines[0].invoice_line_id).toBe(target.lines[0].id);
      await st('POST', '/v1/sales/invoices', 422, { headers: k(), body: { ...body, lines: [{ ...line, net_wt: '0.000' }] } });
    });
    it('0.9.5 receipt print: original, duplicate, missing-key400 and malformed-shape422 all validate with Ajv',async()=>{
      const path='/v1/sales/invoices/{id}/payments/{receipt_id}/prints';
      const params={id:inv.id,receipt_id:rc.id};
      expect(await st('POST',path,400,{p:params,headers:{},body:{}})).toMatchObject({code:'idempotency_key_required'});
      expect(await st('POST',path,422,{p:params,headers:k(),body:{copy:'duplicate'}})).toMatchObject({code:'first_print_duplicate_not_supported'});
      const p=await st('POST',path,200,{p:params,headers:k(),body:{language:'ta'}});
      expect(p).toMatchObject({doc_type:'payment_receipt',copy:'original',doc_cancelled:false,locale:'ta-IN',snapshot:{receipt_no:rc.receipt_no}});
      expect(validateAt('#/components/schemas/PaymentReceiptPrintSnapshot',p.snapshot).ok).toBe(true);
      expect(await st('POST',path,200,{p:params,headers:k(),body:{reprint_reason:'contract receipt copy'}})).toMatchObject({copy:'duplicate',snapshot:p.snapshot,template_id:p.template_id});
      await st('POST',path,422,{p:params,headers:k(),body:{language:'hi',reprint_reason:'invalid language copy'}});
    });
    it('estimates: create, list, get, replace (If-Match), cancel, prints', async () => {
      const t = await fx.tag({ gross_wt: '1.000', net_wt: '1.000', wastage_pct: '0' });
      const b = { branch_id: fx.B1, customer_id: cust, lines: [{ kind: 'tag', tag_id: t.id }] };
      est = await st('POST', '/v1/sales/estimates', 201, { body: b, headers: k(), cookie: fx.sales });
      await st('POST', '/v1/sales/estimates', 422, { body: { ...b, lines: [] }, headers: k() });
      await st('POST', '/v1/sales/estimates', 403, { body: { ...b, old_metal: [{ purity_id: fx.P22, gross_wt: '1.000', rate_override: '1.00', override_reason: 'no permission here' }] }, headers: k(), cookie: fx.cashier });
      await st('POST', '/v1/sales/estimates', 409, { body: { ...b, lines: [{ kind: 'tag', tag_id: inv2.lines[0].tag_id }] }, headers: k() });
      await st('GET', '/v1/sales/estimates', 200, { q: { branch_id: fx.B1 } });
      await st('GET', '/v1/sales/estimates', 422, { q: { cursor: 'bad' } });
      await st('GET', '/v1/sales/estimates/{id}', 200, { p: { id: est.id } });
      await st('GET', '/v1/sales/estimates/{id}', 404, { p: { id: '00000000-0000-4000-8000-000000000077' } });
      await st('PUT', '/v1/sales/estimates/{id}', 428, { p: { id: est.id }, body: b });
      await st('PUT', '/v1/sales/estimates/{id}', 412, { p: { id: est.id }, body: b, headers: fx.im(5) });
      await st('PUT', '/v1/sales/estimates/{id}', 422, { p: { id: est.id }, body: { ...b, lines: 'x' }, headers: fx.im(1) });
      await st('PUT', '/v1/sales/estimates/{id}', 404, { p: { id: '00000000-0000-4000-8000-000000000077' }, body: b, headers: fx.im(1) });
      const e2 = await st('PUT', '/v1/sales/estimates/{id}', 200, { p: { id: est.id }, body: { ...b, notes: 'v2' }, headers: fx.im(1) });
      expect(await st('POST', '/v1/sales/estimates/{id}/prints', 200, { p: { id: est.id }, body: {}, headers: k() })).toMatchObject({ doc_cancelled: false });
      await st('POST', '/v1/sales/estimates/{id}/prints', 422, { p: { id: est.id }, body: { language: 'zz' }, headers: k() });
      await st('POST', '/v1/sales/estimates/{id}/prints', 404, { p: { id: '00000000-0000-4000-8000-000000000077' }, body: {}, headers: k() });
      await st('POST', '/v1/sales/estimates/{id}/cancel', 428, { p: { id: est.id } });
      await st('POST', '/v1/sales/estimates/{id}/cancel', 412, { p: { id: est.id }, headers: fx.im(1) });
      await st('POST', '/v1/sales/estimates/{id}/cancel', 404, { p: { id: '00000000-0000-4000-8000-000000000077' }, headers: fx.im(1) });
      await st('POST', '/v1/sales/estimates/{id}/cancel', 200, { p: { id: est.id }, headers: fx.im(e2.version) });
      await st('POST', '/v1/sales/estimates/{id}/cancel', 409, { p: { id: est.id }, headers: fx.im(e2.version + 1) });
      await st('PUT', '/v1/sales/estimates/{id}', 409, { p: { id: est.id }, body: b, headers: fx.im(e2.version + 1) });
    });
    it('B4/B6 0.9.4 — Ajv validates live frozen payloads and rejects every missing mandatory print/CN field',async()=>{
      const p=await st('POST','/v1/sales/credit-notes/{id}/prints',200,{p:{id:cn.id},headers:k(),body:{reprint_reason:'contract frozen projection'}});
      expect(validateAt('#/components/schemas/SalesPrintDocument',p).ok).toBe(true);
      for(const field of ['template_id','template_version','language','locale','numerals','snapshot']) {
        const bad={...p};delete bad[field];expect(validateAt('#/components/schemas/SalesPrintDocument',bad).ok).toBe(false);
      }
      for(const field of ['seller','place_of_supply','gst_type','supply_type','gst_applicable','original_invoice','tax_summary']) {
        const bad={...p.snapshot};delete bad[field];expect(validateAt('#/components/schemas/CreditNote',bad).ok).toBe(false);
      }
      for(const field of ['legal_name','gstin','address','state_code']) {
        const bad={...p.snapshot,seller:{...p.snapshot.seller}};delete bad.seller[field];expect(validateAt('#/components/schemas/CreditNote',bad).ok).toBe(false);
      }
      for(const field of ['hsn','tax_rate','tax_parts']) {
        const line={...p.snapshot.lines[0]};delete line[field];expect(validateAt('#/components/schemas/CreditNoteLine',line).ok).toBe(false);
      }
      for(const field of ['doc_no','doc_date','lines']) {
        const ref={...p.snapshot.original_invoice};delete ref[field];expect(validateAt('#/components/schemas/OriginalInvoiceSnapshot',ref).ok).toBe(false);
      }
      const bad={...p,template_id:null};expect(validateAt('#/components/schemas/SalesPrintDocument',bad).ok).toBe(false);
    });
    it('credit notes: list (kind filter), get, prints', async () => {
      await st('GET', '/v1/sales/credit-notes', 200, {});
      const rr = await st('GET', '/v1/sales/credit-notes', 200, { q: { kind: 'receipt_reversal' } });
      expect(rr.items.length).toBeGreaterThan(0);
      await st('GET', '/v1/sales/credit-notes', 422, { q: { kind: 'nonsense' } });
      await st('GET', '/v1/sales/credit-notes/{id}', 200, { p: { id: cn.id } });
      await st('GET', '/v1/sales/credit-notes/{id}', 404, { p: { id: '00000000-0000-4000-8000-000000000077' } });
      expect(await st('POST', '/v1/sales/credit-notes/{id}/prints', 200, { p: { id: cn.id }, body: { reprint_reason: 'subsequent contract copy' }, headers: k() })).toMatchObject({ doc_cancelled: false });
      await st('POST', '/v1/sales/credit-notes/{id}/prints', 403, { p: { id: cn.id }, body: { reprint_reason: 'lost copy' }, headers: k(), cookie: fx.sales });
      await st('POST', '/v1/sales/credit-notes/{id}/prints', 404, { p: { id: '00000000-0000-4000-8000-000000000077' }, body: {}, headers: k() });
    });
  });

  it('contract: no violations, every implemented Sales operation returned a 2xx, no undocumented properties, RFC 3339 timestamps', () => {
    const r = JSON.parse(fx.rec.report()) as { violations: unknown[]; undocumented: string[]; timestamps: string[] };
    expect(fx.rec.uncovered('/v1/sales')).toEqual([]);
    expect(r.violations, fx.rec.report()).toEqual([]);
    expect(r.undocumented, fx.rec.report()).toEqual([]);
    expect(r.timestamps, fx.rec.report()).toEqual([]);
    // every documented 4xx family was exercised somewhere (problem bodies validated too)
    const seen = new Set([...fx.rec.hit.values()].flatMap((x) => [...x]));
    for (const c of [400, 401, 403, 404, 409, 412, 422, 428]) expect([c, seen.has(c)]).toEqual([c, true]);
  });
});
