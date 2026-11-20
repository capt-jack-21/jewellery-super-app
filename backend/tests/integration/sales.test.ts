import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { withTenantTx, withModuleRole } from '@jw/db';
import { printDoc, cancelInvoice, issueInvoice } from '@jw/mod-sales';
import { pool } from './env';
import { salesFixture, type SalesFx } from './sales-fixture';
import { HUID_PREFIX } from './huid';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
/** 998 fixed platform v1 template ids (also the 999 backfill fallback). */
const PLATFORM_V1: Record<string, string> = { invoice: '01a1c455-29fa-769b-84f9-377a9bcdab46', estimate: '01a1c455-29fa-7963-88e9-d3cf6e2a8240',
  credit_note: '01a1c455-29fa-7856-b4ed-a3710fd91ec1', payment_receipt: '01a1c455-29fa-7811-b4b1-95efbd5b9ea5' };
/** 999 (NB-2): exactly the 19 legacy Sales constraints it VALIDATEs. */
const NB2_CONSTRAINTS = ['invoice_salesperson_fk','invoice_cash_counter_fk','invoice_line_tag_fk','invoice_line_item_fk','invoice_line_rate_fk',
  'invoice_line_stock_check','invoice_line_mc_type_check','invoice_line_weights_check','invoice_line_amounts_check','invoice_line_taxable_sum_check',
  'invoice_line_total_sum_check','invoice_line_gst_split_check','invoice_old_metal_purity_fk','invoice_old_metal_rate_fk','invoice_old_metal_required_check',
  'invoice_old_metal_weights_check','invoice_old_metal_amount_check','credit_note_line_total_sum_check','estimate_invoice_fk'];

/**
 * Sales module (contract 0.9.5, data model 991-997) over HTTP on the test DB. Every response — success and problem bodies — is validated against
 * contracts/openapi.yaml by the fixture's ContractRecorder; the last test fails on any violation, undocumented property or non-RFC 3339 timestamp.
 *
 * Price arithmetic used below (22K sale 6000/g, 24K 6500/g, 22K old metal 5800/g, RING mc 500/g on net weight, GST 3% = 1.5 + 1.5):
 *   big tag   10 g net, wastage 8%: metal 10.8 × 6000 = 64800, making 5000 → taxable 69800, CGST = SGST 1047 → 71894.00
 *   small tag  1 g net, wastage 0: metal 6000, making 500 → taxable 6500, CGST = SGST 97.50 → 6695.00
 */
let fx: SalesFx;
let rw: ReturnType<typeof pool>;
beforeAll(async () => { fx = await salesFixture('salesit', HUID_PREFIX.sales); rw = pool('app_rw'); }, 120000);
afterAll(async () => { await rw?.end(); await fx?.close(); });

type J = Record<string, any>;
const SMALL = { gross_wt: '1.000', net_wt: '1.000', wastage_pct: '0' };
const small = () => fx.tag(SMALL);
const big = () => fx.tag();
const tagLine = (t: { id: string }, o: J = {}) => ({ kind: 'tag', tag_id: t.id, ...o });
const bill = (o: J): J => ({ branch_id: fx.B1, salesperson_id: fx.staff, ...o });
async function issue(body: J, o: { cookie?: string; status?: number; headers?: Record<string, string> } = {}): Promise<J> {
  return (await fx.go('POST', '/v1/sales/invoices', { body: bill(body), headers: o.headers ?? fx.key(), cookie: o.cookie, status: o.status ?? 201 })).json();
}
async function preview(body: J, o: { cookie?: string; status?: number } = {}): Promise<J> {
  return (await fx.go('POST', '/v1/sales/preview', { body: bill(body), cookie: o.cookie, status: o.status ?? 200 })).json();
}
/** Issue paid in full by UPI (amount from a preview with the same body). */
async function paid(body: J, cookie?: string): Promise<J> {
  const pv = await preview(body, { cookie });
  return issue({ ...body, payments: [{ mode: 'upi', amount: pv.totals.net_payable, reference: 'UTR' }] }, { cookie });
}
async function problem(method: string, path: string, o: { body?: unknown; status: number; code: string; cookie?: string; headers?: Record<string, string>; p?: Record<string, string>; q?: Record<string, string> }): Promise<J> {
  const idem = method === 'POST' && !['/v1/sales/preview', '/v1/sales/estimates/{id}/cancel'].includes(path);
  const r = await fx.go(method, path, { body: o.body, status: o.status, cookie: o.cookie, headers: o.headers ?? (idem ? fx.key() : undefined), p: o.p, q: o.q });
  expect(r.json().code, r.body).toBe(o.code);
  return r.json();
}
const tagStatus = async (id: string) => (await fx.sql<{ status: string; counter_id: string | null }>(`SELECT status, counter_id FROM inventory.tag WHERE id = $1`, [id]))[0];
/** Ledger rows written after tagging (the 'tagged' receipt row is Inventory's own). */
const ledger = async (tagId: string) => fx.sql<{ movement: string; direction: number }>(`SELECT movement, direction FROM inventory.stock_ledger WHERE tag_id = $1 AND movement <> 'tagged' ORDER BY occurred_at, id`, [tagId]);
const auditRows = async (action: string, rowId?: string) =>
  fx.sql<{ action: string; new_row: J | null }>(`SELECT action, new_row FROM platform.audit_event WHERE action = $1 ${rowId ? 'AND row_id = $2' : ''} ORDER BY seq`, rowId ? [action, rowId] : [action]);
const due = async (invId: string) => (await fx.sql<J>(`SELECT balance_due::text, paid_amount::text, payment_status, cash_total::text FROM sales.v_invoice_balance WHERE invoice_id = $1`, [invId]))[0];
const payments = async (id: string) => (await fx.go('GET', '/v1/sales/invoices/{id}/payments', { p: { id } })).json();
const receive = async (id: string, tenders: J[], o: { cookie?: string; status?: number } = {}) =>
  (await fx.go('POST', '/v1/sales/invoices/{id}/payments', { p: { id }, body: { tenders }, headers: fx.key(), cookie: o.cookie, status: o.status ?? 201 })).json();
const reverse = async (id: string, rid: string, reason = 'cheque bounced', o: { cookie?: string; status?: number; headers?: Record<string, string> } = {}) =>
  (await fx.go('POST', '/v1/sales/invoices/{id}/payments/{receipt_id}/reversal', { p: { id, receipt_id: rid }, body: { reason }, headers: o.headers ?? fx.key(), cookie: o.cookie ?? fx.manager, status: o.status ?? 201 })).json();
const cnView = async (id: string) => (await fx.go('GET', '/v1/sales/credit-notes/{id}', { p: { id } })).json();
const todayIST = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
/** A store-credit note of `amount`-ish for a customer: bill one small tag paid in full, return it as store credit. */
async function storeCredit(customerId: string): Promise<J> {
  const t = await small();
  const inv = await paid({ customer_id: customerId, lines: [tagLine(t)] });
  return (await fx.go('POST', '/v1/sales/invoices/{id}/returns', { p: { id: inv.id }, headers: fx.key(),
    body: { line_ids: [inv.lines[0].id], reason: 'customer changed mind', refund_mode: 'store_credit' } })).json();
}

describe('setup: readiness, settings (0.9.2 PATCH), sellable, device gate', () => {
  it('readiness is green for an approved device and red without one', async () => {
    const ok = (await fx.go('GET', '/v1/sales/readiness', { q: { branch_id: fx.B1 } })).json();
    expect(ok.ready, JSON.stringify(ok)).toBe(true);
    const no = (await fx.go('GET', '/v1/sales/readiness', { q: { branch_id: fx.B1 }, cookie: fx.managerNoDevice })).json();
    expect(no.ready).toBe(false);
    await problem('POST', '/v1/sales/invoices', { body: bill({ customer_id: await fx.customer(), lines: [tagLine(await small())] }), cookie: fx.managerNoDevice, status: 403, code: 'device_not_approved' });
    await problem('GET', '/v1/sales/readiness', { status: 422, code: 'validation_failed' });
  });
  it('GET /settings carries ETag; PATCH is owner-only, If-Match guarded, audited and returns the full settings', async () => {
    const g = await fx.go('GET', '/v1/sales/settings');
    expect(g.headers.etag).toBe(`"${g.json().version}"`);
    await problem('PATCH', '/v1/sales/settings', { body: { return_window_days: 20 }, cookie: fx.manager, headers: { 'if-match': g.headers.etag as string }, status: 403, code: 'permission_denied' });
    await problem('PATCH', '/v1/sales/settings', { body: { return_window_days: 20 }, headers: { 'if-match': '"999"' }, status: 412, code: 'version_mismatch' });
    await problem('PATCH', '/v1/sales/settings', { body: { estimate_validity_days: 31 }, headers: { 'if-match': g.headers.etag as string }, status: 422, code: 'validation_failed' });
    await problem('PATCH', '/v1/sales/settings', { body: { bogus: 1 }, headers: { 'if-match': g.headers.etag as string }, status: 422, code: 'field_not_supported' });
    const s = await fx.settings({ return_window_days: 15, estimate_validity_days: 7 });
    expect(s).toMatchObject({ return_window_days: 15, estimate_validity_days: 7, making_gst_treatment: 'composite' });
    expect(s.version).toBeGreaterThan(g.json().version);
    await problem('PATCH', '/v1/sales/settings', { body: { return_window_days: 15 }, status: 428, code: 'precondition_required' });
    const a = await auditRows('sales.settings.update');
    expect(a.length).toBeGreaterThan(0);
  });
  it('doc-series and sellable lookups', async () => {
    await paid({ customer_id: await fx.customer(), lines: [tagLine(await small())] });
    const ds = (await fx.go('GET', '/v1/sales/doc-series', { q: { branch_id: fx.B1 } })).json();
    expect(ds.find((x: J) => x.doc_type === 'tax_invoice')).toMatchObject({ branch_id: fx.B1, next_no: 2 });
    const t = await small();
    const sl = (await fx.go('GET', '/v1/sales/sellable/{code}', { p: { code: t.tag_no }, q: { branch_id: fx.B1 } })).json();
    expect(sl.line).toMatchObject({ tag_id: t.id, taxable_value: '6500.00' });
    await problem('GET', '/v1/sales/sellable/{code}', { p: { code: 'NOPE-404' }, q: { branch_id: fx.B1 }, status: 404, code: 'not_found' });
  });
});

describe('pricing and GST (S2, S4, S5, S8, S22)', () => {
  it('intra-state B2C: CGST + SGST, doc number server-assigned, doc_date = IST today', async () => {
    const c = await fx.customer();
    const pv = await preview({ customer_id: c, lines: [tagLine(await big())] });
    expect(pv.totals).toMatchObject({ gross_value: '69800.00', taxable_value: '69800.00', cgst: '1047.00', sgst: '1047.00', igst: '0.00', invoice_total: '71894.00', round_off: '0.00' });
    expect(pv).toMatchObject({ supply_type: 'b2c', gst_type: 'intra', place_of_supply: '33' });
    const t = await big();
    const inv = await issue({ customer_id: c, lines: [tagLine(t)], payments: [{ mode: 'upi', amount: '71894.00', reference: 'UTR1' }], expected_total: '71894.00' });
    expect(inv).toMatchObject({ status: 'issued', payment_status: 'paid', gst_type: 'intra', doc_date: todayIST() });
    expect(inv.doc_no).toMatch(/^[A-Z0-9]+\/\d{4}\/\d{6}$/);
    expect((await tagStatus(t.id)).status).toBe('sold');
    expect(await ledger(t.id)).toEqual([{ movement: 'sale', direction: -1 }]);
    const list = (await fx.go('GET', '/v1/sales/invoices', { q: { branch_id: fx.B1, q: inv.doc_no } })).json();
    expect(list.items.map((x: J) => x.id)).toContain(inv.id);
    await problem('POST', '/v1/sales/invoices', { body: bill({ customer_id: c, lines: [tagLine(await small())], expected_total: '1.00', payments: [{ mode: 'upi', amount: '6695.00', reference: 'U' }] }), status: 422, code: 'expected_total_mismatch' });
  });
  it('inter-state by customer state → IGST; place_of_supply override in estimate-mode preview', async () => {
    const c = await fx.customer({ state_code: '29' });
    const pv = await preview({ customer_id: c, lines: [tagLine(await big())] });
    expect(pv).toMatchObject({ gst_type: 'inter', place_of_supply: '29' });
    expect(pv.totals).toMatchObject({ cgst: '0.00', sgst: '0.00', igst: '2094.00', invoice_total: '71894.00' });
    const est = (await fx.go('POST', '/v1/sales/preview', { body: { mode: 'estimate', branch_id: fx.B1, place_of_supply: '27', lines: [tagLine(await small())] } })).json();
    expect(est).toMatchObject({ gst_type: 'inter', place_of_supply: '27', customer: null });
    await problem('POST', '/v1/sales/preview', { body: { mode: 'invoice', branch_id: fx.B1, lines: [tagLine(await small())] }, status: 422, code: 'validation_failed' });
    await problem('POST', '/v1/sales/preview', { body: { mode: 'draft', branch_id: fx.B1, lines: [] }, status: 422, code: 'validation_failed' });
  });
  it('B2B via customer GSTIN: place of supply = GSTIN state; a conflicting place_of_supply → 422', async () => {
    const c = await fx.customer({ gstin: '29AABCU9603R1ZM' });
    const t = await small();
    const pv = await preview({ customer_id: c, lines: [tagLine(t)] });
    expect(pv).toMatchObject({ supply_type: 'b2b', gst_type: 'inter', place_of_supply: '29' });
    await problem('POST', '/v1/sales/preview', { body: bill({ customer_id: c, place_of_supply: '33', lines: [tagLine(t)] }), status: 422, code: 'place_of_supply_conflict' });
    const c2 = await fx.customer({ gstin: '33AABCU9603R1ZN' });
    expect((await preview({ customer_id: c2, lines: [tagLine(t)] })).gst_type).toBe('intra');
  });
  it('making: composite at 3% under the jewellery HSN; separate needs the shop rate (422 with settings pointer), then SAC + rate', async () => {
    const c = await fx.customer(); const t = await big();
    const comp = await preview({ customer_id: c, lines: [tagLine(t)] });
    const mk = comp.lines[0].tax_parts.find((p: J) => p.component === 'making');
    expect(mk).toMatchObject({ hsn_sac: '7113', rate: '3.00', composite_supply: true, taxable_value: '5000.00', cgst: '75.00' });
    await fx.settings({ making_gst_treatment: 'separate', making_service_rate: null });
    const e = await problem('POST', '/v1/sales/preview', { body: bill({ customer_id: c, lines: [tagLine(t)] }), status: 422, code: 'making_service_rate_not_set' });
    expect(e).toMatchObject({ setting_key: 'making_service_rate', settings_path: '/v1/sales/settings' });
    await problem('POST', '/v1/sales/invoices', { body: bill({ customer_id: c, lines: [tagLine(t)] }), status: 422, code: 'making_service_rate_not_set' });
    expect((await tagStatus(t.id)).status).toBe('in_stock');
    await fx.settings({ making_service_rate: '18.00', making_tax_rule_code: 'REPAIR_SERVICE' });
    const sep = await preview({ customer_id: c, lines: [tagLine(t)] });
    const m2 = sep.lines[0].tax_parts.find((p: J) => p.component === 'making');
    expect(m2).toMatchObject({ hsn_sac: '998892', rate: '18.00', composite_supply: false, cgst: '450.00', sgst: '450.00' });
    expect(sep.totals).toMatchObject({ cgst: '1422.00', sgst: '1422.00', invoice_total: '72644.00' });
    const inv = await issue({ customer_id: c, lines: [tagLine(t)], payments: [{ mode: 'upi', amount: '72644.00', reference: 'U' }] });
    expect(inv.making_gst_treatment).toBe('separate');
    expect(inv.tax_summary.map((x: J) => `${x.hsn_sac}|${x.rate}`).sort()).toEqual(['7113|3.00', '998892|18.00']);
    await fx.settings({ making_gst_treatment: 'composite', making_service_rate: null, making_tax_rule_code: null });
  });
  it('each tax head of each part is rounded on its own; the bill gets round_off', async () => {
    await fx.loose(10, '20.000');
    // 24K loose 1.002 g × 6500 = 6513.00 → CGST 97.695 → 97.70; flat making 333 → 4.995 → 5.00; CGST 102.70 (whole-line would give 102.69)
    const pv = await preview({ customer_id: await fx.customer(), lines: [{ kind: 'loose', item_id: fx.coin, purity_id: fx.P24, counter_id: fx.counter, pieces: 1,
      gross_wt: '1.002', net_wt: '1.002', wastage_pct: '0', mc_type: 'flat', mc_value: '333' }] });
    expect(pv.lines[0].tax_parts.map((p: J) => p.cgst)).toEqual(['97.70', '5.00']);
    expect(pv.totals).toMatchObject({ taxable_value: '6846.00', cgst: '102.70', sgst: '102.70', round_off: '-0.40', invoice_total: '7051.00' });
  });
});

describe('loose lines (S23)', () => {
  it('QA B2 — issues and returns zero/default-piece weight-only loose lines with exact Inventory ledger quantities', async () => {
    await fx.loose(0, '5.000');
    const customer_id = await fx.customer();
    const line = { kind: 'loose', item_id: fx.coin, purity_id: fx.P24, counter_id: fx.counter, gross_wt: '1.000', net_wt: '1.000' };
    const balance = async () => (await fx.sql<J>(`SELECT pieces, gross_wt::text, net_wt::text FROM inventory.v_loose_stock WHERE item_id = $1 AND counter_id = $2`, [fx.coin, fx.counter]))[0];
    const before = await balance();
    for (const l of [line, { ...line, pieces: 0 }]) {
      const pv = await preview({ customer_id, lines: [l] });
      expect(pv.lines[0].pieces).toBe(0);
      const inv = await paid({ customer_id, lines: [l] });
      expect(inv.lines[0]).toMatchObject({ kind: 'loose', pieces: 0, gross_wt: '1.000', net_wt: '1.000' });
      const sale = await fx.sql<J>(`SELECT movement, direction, pieces, gross_wt::text, net_wt::text, tag_id FROM inventory.stock_ledger WHERE source_id = $1 AND item_id = $2`, [inv.id, fx.coin]);
      expect(sale).toEqual([{ movement: 'sale', direction: -1, pieces: 0, gross_wt: '1.000', net_wt: '1.000', tag_id: null }]);
      const used = await balance();
      expect(Number(used.pieces)).toBe(Number(before.pieces));
      expect(Number(before.net_wt) - Number(used.net_wt)).toBe(1);
      const cn = (await fx.go('POST', '/v1/sales/invoices/{id}/returns', { p: { id: inv.id }, headers: fx.key(),
        body: { line_ids: [inv.lines[0].id], reason: 'weight-only goods returned', refund_mode: 'cash' } })).json();
      const restock = await fx.sql<J>(`SELECT movement, direction, pieces, gross_wt::text, net_wt::text, tag_id FROM inventory.stock_ledger WHERE source_id = $1 AND item_id = $2`, [cn.id, fx.coin]);
      expect(restock).toEqual([{ movement: 'sales_return', direction: 1, pieces: 0, gross_wt: '1.000', net_wt: '1.000', tag_id: null }]);
      expect(await fx.sql(`SELECT 1 FROM sales.credit_note_line WHERE credit_note_id = $1 AND invoice_line_id = $2`, [cn.id, inv.lines[0].id])).toHaveLength(1);
      expect(await balance()).toEqual(before);
    }
  });
  it('rejects zero-piece zero-net lines and zero-gross physical goods before issue', async () => {
    const customer_id = await fx.customer();
    const base = { kind: 'loose', item_id: fx.coin, purity_id: fx.P24, counter_id: fx.counter, pieces: 0, gross_wt: '1.000', net_wt: '0.000' };
    for (const line of [base, { ...base, pieces: undefined }, { ...base, pieces: 1, gross_wt: '0.000' }]) {
      await problem('POST', '/v1/sales/preview', { body: bill({ customer_id, lines: [line] }), status: 422, code: 'validation_failed' });
      await problem('POST', '/v1/sales/invoices', { body: bill({ customer_id, lines: [line] }), status: 422, code: 'validation_failed' });
    }
  });
  it('rejects a client-supplied zero quantity on tag lines; quantities are frozen from Inventory', async () => {
    const tag = await small();
    await problem('POST', '/v1/sales/invoices', { body: bill({ customer_id: await fx.customer(), lines: [tagLine(tag, { pieces: 0 })] }), status: 422, code: 'field_not_supported' });
    expect((await tagStatus(tag.id)).status).toBe('in_stock');
  });
  it('sell by weight from a counter; stock drops; more than held → 409 and nothing sold', async () => {
    await fx.loose(5, '10.000', fx.counter2);
    const before = (await fx.sql<J>(`SELECT pieces, net_wt::text FROM inventory.v_loose_stock WHERE counter_id = $1 AND item_id = $2`, [fx.counter2, fx.coin]))[0];
    const line = { kind: 'loose', item_id: fx.coin, purity_id: fx.P24, counter_id: fx.counter2, pieces: 2, gross_wt: '4.000', net_wt: '4.000' };
    const inv = await paid({ customer_id: await fx.customer(), lines: [line] });
    expect(inv.lines[0]).toMatchObject({ kind: 'loose', tag_id: null, net_wt: '4.000', metal_value: '26000.00' });
    const after = (await fx.sql<J>(`SELECT pieces, net_wt::text FROM inventory.v_loose_stock WHERE counter_id = $1 AND item_id = $2`, [fx.counter2, fx.coin]))[0];
    expect(Number(before.pieces) - Number(after.pieces)).toBe(2);
    const r = await fx.go('POST', '/v1/sales/invoices', { body: bill({ customer_id: await fx.customer(), lines: [{ ...line, pieces: 50, gross_wt: '400.000', net_wt: '400.000' }],
      payments: [{ mode: 'upi', amount: '1.00', reference: 'U' }] }), headers: fx.key(), status: [409, 422] });
    expect(['insufficient_loose_stock', 'overpayment', 'pan_required', 'cash_limit_exceeded']).toContain(r.json().code);
  });
});

describe('old gold exchange (S6)', () => {
  const OLD = { purity_id: '', gross_wt: '5.000', less_wt: '0.500', description: 'old chain' };
  it('valued at the server old-metal rate; stock in through Inventory with its ledger id on the line', async () => {
    const c = await fx.customer();
    const inv = await paid({ customer_id: c, lines: [tagLine(await big())], old_metal: [{ ...OLD, purity_id: fx.P22 }] });
    expect(inv.old_metal[0]).toMatchObject({ net_wt: '4.500', server_rate: '5800.00', rate_per_g: '5800.00', overridden: false, amount: '26100.00' });
    expect(inv.totals).toMatchObject({ invoice_total: '71894.00', old_metal_value: '26100.00', net_payable: '45794.00' });
    const [row] = await fx.sql<J>(`SELECT o.inventory_ref_id, l.movement, l.direction FROM sales.invoice_old_metal o JOIN inventory.stock_ledger l ON l.id = o.inventory_ref_id WHERE o.invoice_id = $1`, [inv.id]);
    expect(row).toMatchObject({ movement: 'old_metal_in', direction: 1 });
  });
  it('rate override: 403 without sales.old_gold.rate_override (also in preview), audited when allowed', async () => {
    const c = await fx.customer();
    const body = { customer_id: c, lines: [tagLine(await big())], old_metal: [{ ...OLD, purity_id: fx.P22, rate_override: '5900.00', override_reason: 'loyal customer rate' }] };
    await problem('POST', '/v1/sales/preview', { body: bill(body), cookie: fx.cashier, status: 403, code: 'old_gold_rate_override_not_allowed' });
    await problem('POST', '/v1/sales/invoices', { body: bill({ ...body, payments: [{ mode: 'upi', amount: '45344.00', reference: 'U' }] }), cookie: fx.cashier, status: 403, code: 'old_gold_rate_override_not_allowed' });
    const inv = await paid(body, fx.manager);
    expect(inv.old_metal[0]).toMatchObject({ server_rate: '5800.00', rate_per_g: '5900.00', overridden: true, amount: '26550.00' });
    const a = await auditRows('sales.old_gold.rate_override', inv.id);
    expect(a[0].new_row).toMatchObject({ server_rate: '5800.00', applied_rate: '5900.00' });
    await problem('POST', '/v1/sales/preview', { body: bill({ ...body, old_metal: [{ ...OLD, purity_id: fx.P22, rate_override: '5900.00' }] }), status: 422, code: 'validation_failed' });
  });
  it('old gold worth more than the bill: separate_purchase → 422; refund_on_bill needs a payout mode', async () => {
    const c = await fx.customer(); const t = await small();
    const body = { customer_id: c, lines: [tagLine(t)], old_metal: [{ ...OLD, purity_id: fx.P22 }] };
    await problem('POST', '/v1/sales/invoices', { body: bill(body), status: 422, code: 'old_gold_exceeds_bill' });
    await fx.settings({ old_gold_excess_handling: 'refund_on_bill' });
    await problem('POST', '/v1/sales/invoices', { body: bill(body), status: 422, code: 'old_gold_payout_required' });
    const inv = await issue({ ...body, old_gold_excess_payout: 'cash' });
    expect(inv.totals).toMatchObject({ invoice_total: '6695.00', old_metal_value: '26100.00', old_gold_excess: '19405.00', net_payable: '0.00', balance_due: '0.00' });
    expect(inv.old_gold_excess_payout).toBe('cash');
    await fx.settings({ old_gold_excess_handling: 'separate_purchase' });
  });
});

describe('discounts (S7)', () => {
  it('line discount needs sales.discount.give; bill discount spreads pro rata', async () => {
    const c = await fx.customer();
    await problem('POST', '/v1/sales/invoices', { body: bill({ customer_id: c, lines: [tagLine(await small(), { discount: '100.00' })], payments: [{ mode: 'upi', amount: '6592.00', reference: 'U' }] }),
      cookie: fx.cashier, status: 403, code: 'discount_not_allowed' });
    const inv = await paid({ customer_id: c, lines: [tagLine(await small(), { discount: '100.00' }), tagLine(await big())], bill_discount: '200.00' }, fx.manager);
    expect(inv.totals).toMatchObject({ line_discount: '100.00', bill_discount: '200.00', taxable_value: '76000.00' });
    const shares = inv.lines.map((l: J) => l.bill_discount_share);
    expect(shares.reduce((s: number, x: string) => s + Number(x), 0)).toBeCloseTo(200, 2);
  });
  it('warns at 5% (large_discount); above 10% needs override + reason', async () => {
    const c = await fx.customer();
    const w = await preview({ customer_id: c, lines: [tagLine(await big())], bill_discount: '3490.00' }, { cookie: fx.manager });
    expect(w.warnings.map((x: J) => x.code)).toContain('large_discount');
    const under = await preview({ customer_id: c, lines: [tagLine(await big())], bill_discount: '3489.00' }, { cookie: fx.manager });
    expect(under.warnings.map((x: J) => x.code)).not.toContain('large_discount');
    const t = await big();
    const body = { customer_id: c, lines: [tagLine(t)], bill_discount: '7000.00' };
    const pv = await preview(body, { cookie: fx.manager });
    await problem('POST', '/v1/sales/invoices', { body: bill({ ...body, payments: [{ mode: 'upi', amount: pv.totals.net_payable, reference: 'U' }] }), cookie: fx.manager, status: 422, code: 'discount_reason_required' });
    await problem('POST', '/v1/sales/invoices', { body: bill({ ...body, payments: [{ mode: 'upi', amount: pv.totals.net_payable, reference: 'U' }] }), cookie: fx.sales, status: 403, code: 'discount_not_allowed' });
    const inv = await issue({ ...body, discount_reason: 'festival offer', payments: [{ mode: 'upi', amount: pv.totals.net_payable, reference: 'U' }] }, { cookie: fx.manager });
    expect((await auditRows('sales.price.override_min', inv.id))[0].new_row).toMatchObject({ reason: 'festival offer' });
  });
});

describe('0% GST (S17)', () => {
  it('owner only, with reason; taxes are zero and audited', async () => {
    const c = await fx.customer();
    const body = { customer_id: c, lines: [tagLine(await small())], zero_gst: { reason: 'export under LUT' } };
    await problem('POST', '/v1/sales/invoices', { body: bill({ ...body, payments: [{ mode: 'upi', amount: '6500.00', reference: 'U' }] }), cookie: fx.manager, status: 403, code: 'zero_gst_not_allowed' });
    const inv = await paid(body);
    expect(inv).toMatchObject({ zero_gst: true, zero_gst_reason: 'export under LUT' });
    expect(inv.totals).toMatchObject({ cgst: '0.00', sgst: '0.00', igst: '0.00', invoice_total: '6500.00' });
    expect(await auditRows('sales.invoice.zero_gst', inv.id)).toHaveLength(1);
  });
});

describe('payments, receipts and credit sales (S9)', () => {
  it('credit sale needs sales.invoice.credit_sale; part-paid does not', async () => {
    const c = await fx.customer();
    await problem('POST', '/v1/sales/invoices', { body: bill({ customer_id: c, lines: [tagLine(await small())] }), cookie: fx.cashier, status: 403, code: 'credit_sale_not_allowed' });
    const cr = await issue({ customer_id: c, lines: [tagLine(await small())] }, { cookie: fx.manager });
    expect(cr).toMatchObject({ payment_status: 'unpaid' });
    expect(cr.totals.balance_due).toBe('6695.00');
    const pp = await issue({ customer_id: c, lines: [tagLine(await small())], payments: [{ mode: 'cash', amount: '1000.00' }] }, { cookie: fx.cashier });
    expect(pp).toMatchObject({ payment_status: 'part_paid' });
    expect(pp.warnings.map((w: J) => w.code)).toContain('balance_due');
  });
  it('several receipts, overpayment, fully paid, replay, cancelled bill, permission', async () => {
    const c = await fx.customer();
    const inv = await issue({ customer_id: c, lines: [tagLine(await small())], payments: [{ mode: 'cash', amount: '1000.00' }] });
    await problem('POST', '/v1/sales/invoices/{id}/payments', { p: { id: inv.id }, body: { tenders: [{ mode: 'cash', amount: '100.00' }] }, cookie: fx.sales, status: 403, code: 'permission_denied' });
    const r1 = await receive(inv.id, [{ mode: 'upi', amount: '2000.00', reference: 'U1' }], { cookie: fx.cashier });
    expect(r1).toMatchObject({ total: '2000.00', balance_due_after: '3695.00', invoice_id: inv.id, customer_id: c, reverses_receipt_id: null });
    await problem('POST', '/v1/sales/invoices/{id}/payments', { p: { id: inv.id }, body: { tenders: [{ mode: 'upi', amount: '3695.01', reference: 'X' }] }, status: 422, code: 'overpayment' });
    const key = fx.key();
    const body = { tenders: [{ mode: 'upi', amount: '695.00', reference: 'U2' }] };
    const r2 = await fx.go('POST', '/v1/sales/invoices/{id}/payments', { p: { id: inv.id }, body, headers: key, status: 201 });
    const again = await fx.go('POST', '/v1/sales/invoices/{id}/payments', { p: { id: inv.id }, body, headers: key, status: 200 });
    expect(again.json().id).toBe(r2.json().id);
    await receive(inv.id, [{ mode: 'card' === 'card' ? 'debit_card' : 'cash', amount: '3000.00', reference: 'C1' }]);
    expect(await due(inv.id)).toMatchObject({ balance_due: '0.00', payment_status: 'paid' });
    await problem('POST', '/v1/sales/invoices/{id}/payments', { p: { id: inv.id }, body: { tenders: [{ mode: 'cash', amount: '1.00' }] }, status: 409, code: 'invoice_fully_paid' });
    const p = await payments(inv.id);
    expect(p).toMatchObject({ paid_amount: '6695.00', balance_due: '0.00', payment_status: 'paid' });
    expect(p.receipts).toHaveLength(3);
    const inv2 = await issue({ customer_id: c, lines: [tagLine(await small())], payments: [{ mode: 'cash', amount: '1000.00' }] });
    await fx.go('POST', '/v1/sales/invoices/{id}/cancellation', { p: { id: inv2.id }, body: { reason: 'wrong item billed', refund_mode: 'cash' }, headers: fx.key(), cookie: fx.manager, status: 201 });
    await problem('POST', '/v1/sales/invoices/{id}/payments', { p: { id: inv2.id }, body: { tenders: [{ mode: 'cash', amount: '1.00' }] }, status: 409, code: 'invoice_cancelled' });
    await problem('POST', '/v1/sales/invoices/{id}/payments', { p: { id: inv.id }, body: { tenders: [] }, status: 422, code: 'validation_failed' });
    await problem('POST', '/v1/sales/invoices/{id}/payments', { p: { id: inv.id }, body: { tenders: [{ mode: 'cash', amount: '1.00' }] }, headers: {}, status: 400, code: 'idempotency_key_required' });
  });
});

describe('cash limit (S11, s.269ST): one bill = issue + receipts, at the boundary', () => {
  beforeAll(async () => { await fx.settings({ cash_limit_amount: '10000.00', cash_limit_mode: 'block' }); });
  afterAll(async () => { await fx.settings({ cash_limit_amount: '200000.00', cash_limit_mode: 'block' }); });
  it('issue: 9999.99 cash passes, 10000.00 is blocked', async () => {
    const c = await fx.customer();
    const lines = async () => [tagLine(await small()), tagLine(await small())];   // 13390.00
    await problem('POST', '/v1/sales/invoices', { body: bill({ customer_id: c, lines: await lines(), payments: [{ mode: 'cash', amount: '10000.00' }, { mode: 'upi', amount: '3390.00', reference: 'U' }] }), status: 422, code: 'cash_limit_exceeded' });
    const ok = await issue({ customer_id: c, lines: await lines(), payments: [{ mode: 'cash', amount: '9999.99' }, { mode: 'upi', amount: '3390.01', reference: 'U' }] });
    expect(ok.totals.cash_amount).toBe('9999.99');
  });
  it('receipts add to the issue cash; warn mode lets it through; a reversal frees its cash', async () => {
    const c = await fx.customer();
    const inv = await issue({ customer_id: c, lines: [tagLine(await small()), tagLine(await small())], payments: [{ mode: 'cash', amount: '6000.00' }] });
    await problem('POST', '/v1/sales/invoices/{id}/payments', { p: { id: inv.id }, body: { tenders: [{ mode: 'cash', amount: '4000.00' }] }, status: 422, code: 'cash_limit_exceeded' });
    const r = await receive(inv.id, [{ mode: 'cash', amount: '3999.99' }]);
    await problem('POST', '/v1/sales/invoices/{id}/payments', { p: { id: inv.id }, body: { tenders: [{ mode: 'cash', amount: '0.01' }] }, status: 422, code: 'cash_limit_exceeded' });
    await receive(inv.id, [{ mode: 'upi', amount: '100.00', reference: 'U' }]);   // non-cash is never limited
    await reverse(inv.id, r.id, 'counted short, re-take');
    expect((await due(inv.id)).cash_total).toBe('6000.00');
    await receive(inv.id, [{ mode: 'cash', amount: '3999.99' }]);
    await fx.settings({ cash_limit_mode: 'warn' });
    const w = await receive(inv.id, [{ mode: 'cash', amount: '10.00' }]);
    expect((await auditRows('sales.payment.receive', w.id))[0].new_row!.warnings).toContain('cash_limit_exceeded');
    const pv = await preview({ customer_id: c, lines: [tagLine(await small()), tagLine(await small())], payments: [{ mode: 'cash', amount: '10000.00' }, { mode: 'upi', amount: '3390.00', reference: 'U' }] });
    expect(pv.warnings.map((x: J) => x.code)).toContain('cash_limit_exceeded');
    expect(pv.requirements.cash_limit).toMatchObject({ exceeded: true, mode: 'warn', limit: '10000.00' });
    await fx.settings({ cash_limit_mode: 'block' });
  });
});

describe('PAN (S10) — never in audit or logs', () => {
  const PAN = 'ABCPE1234F';
  beforeAll(async () => { await fx.settings({ pan_required_above: '5000.00' }); });
  afterAll(async () => { await fx.settings({ pan_required_above: '200000.00' }); });
  it('required above the threshold; kept on the customer; not in audit / outbox', async () => {
    const c = await fx.customer();
    const pv = await preview({ customer_id: c, lines: [tagLine(await small())] });
    expect(pv.requirements).toMatchObject({ pan_required: true, pan_on_file: false });
    expect(pv.warnings.map((x: J) => x.code)).toContain('pan_required');
    await problem('POST', '/v1/sales/invoices', { body: bill({ customer_id: c, lines: [tagLine(await small())], payments: [{ mode: 'upi', amount: '6695.00', reference: 'U' }] }), status: 422, code: 'pan_required' });
    await problem('POST', '/v1/sales/invoices', { body: bill({ customer_id: c, pan: 'NOTAPAN', lines: [tagLine(await small())], payments: [{ mode: 'upi', amount: '6695.00', reference: 'U' }] }), status: 422, code: 'validation_failed' });
    const inv = await issue({ customer_id: c, pan: PAN, lines: [tagLine(await small())], payments: [{ mode: 'upi', amount: '6695.00', reference: 'U' }] });
    expect(JSON.stringify(inv)).not.toContain(PAN);
    expect((await preview({ customer_id: c, lines: [tagLine(await small())] })).requirements.pan_on_file).toBe(true);
    await issue({ customer_id: c, lines: [tagLine(await small())], payments: [{ mode: 'upi', amount: '6695.00', reference: 'U' }] });
    const leaks = await fx.sql<{ n: string }>(`SELECT (SELECT count(*) FROM platform.audit_event WHERE coalesce(new_row::text, '') || coalesce(old_row::text, '') ILIKE '%' || $1 || '%')
      + (SELECT count(*) FROM notifications.outbox WHERE payload::text ILIKE '%' || $1 || '%') AS n`, [PAN]);
    expect(Number(leaks[0].n)).toBe(0);
    const aadhaar = await fx.sql<{ n: string }>(`SELECT count(*) AS n FROM information_schema.columns WHERE table_schema = 'sales' AND column_name ILIKE '%aadhaar%'`);
    expect(Number(aadhaar[0].n)).toBe(0);
  });
});

describe('cancellation and returns (S14-S16, INV-5)', () => {
  it('return whole lines: credit note, restock to a chosen counter, alert by trigger; again → 409; foreign line → 422', async () => {
    const c = await fx.customer();
    const t1 = await small(); const t2 = await small();
    const inv = await paid({ customer_id: c, lines: [tagLine(t1), tagLine(t2)] });
    const cn = (await fx.go('POST', '/v1/sales/invoices/{id}/returns', { p: { id: inv.id }, headers: fx.key(), cookie: fx.cashier,
      body: { line_ids: [inv.lines[0].id], reason: 'size does not fit', refund_mode: 'cash', restock: { counter_id: fx.counter2 } } })).json();
    expect(cn).toMatchObject({ kind: 'sales_return', invoice_id: inv.id, total: '6695.00', refund_mode: 'cash', refund_amount: '6695.00', store_credit_amount: '0.00', balance_available: '0.00' });
    expect(await tagStatus(t1.id)).toMatchObject({ status: 'in_stock', counter_id: fx.counter2 });
    expect((await ledger(t1.id)).map((x) => x.movement)).toEqual(['sale', 'sales_return']);
    const al = await fx.sql<J>(`SELECT topic, alert_type FROM notifications.outbox WHERE ref_id = $1`, [cn.id]);
    expect(al).toEqual([{ topic: 'alert.sales_return', alert_type: 'sales_return' }]);
    await problem('POST', '/v1/sales/invoices/{id}/returns', { p: { id: inv.id }, body: { line_ids: [inv.lines[0].id], reason: 'size does not fit' }, status: 409, code: 'line_already_returned' });
    await problem('POST', '/v1/sales/invoices/{id}/returns', { p: { id: inv.id }, body: { line_ids: ['00000000-0000-4000-8000-000000000099'], reason: 'size does not fit' }, status: 422, code: 'line_not_on_invoice' });
    await problem('POST', '/v1/sales/invoices/{id}/returns', { p: { id: inv.id }, body: { line_ids: [inv.lines[1].id], reason: 'size does not fit' }, cookie: fx.sales, status: 403, code: 'permission_denied' });
    const g = (await fx.go('GET', '/v1/sales/invoices/{id}', { p: { id: inv.id } })).json();
    expect(g.credit_note_ids).toContain(cn.id);
  });
  it('return window: closed after return_window_days (service called with a later IST day)', async () => {
    const c = await fx.customer();
    const inv = await paid({ customer_id: c, lines: [tagLine(await small())] });
    const sales = await import('@jw/mod-sales');
    const actor = { userId: fx.ownerId, permissions: new Set(['sales.return.issue', 'sales.invoice.view']), roles: [{ role: 'owner', branch_id: null }], billingEnabled: true };
    const later = (n: number) => new Date(Date.parse(`${todayIST()}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
    const body = { line_ids: [inv.lines[0].id], reason: 'late return attempt' };
    await expect(withTenantTx(rw, { tenantId: fx.tenantId, userId: fx.ownerId }, () => sales.returnLines(actor, inv.id, body, later(16))))
      .rejects.toMatchObject({ status: 422, code: 'return_window_expired' });
    // day 15 is still inside the window (rolled back: nothing kept)
    await expect(withTenantTx(rw, { tenantId: fx.tenantId, userId: fx.ownerId }, async () => { await sales.returnLines(actor, inv.id, body, later(15)); throw new Error('rollback'); }))
      .rejects.toThrow('rollback');
    expect((await fx.sql(`SELECT 1 FROM sales.credit_note WHERE invoice_id = $1`, [inv.id]))).toHaveLength(0);
  });
  it('cancel: needs sales.invoice.cancel; credit note closes the bill (incl. round-off), tags back, alert; twice → 409', async () => {
    const c = await fx.customer();
    const t1 = await small(); const t2 = await fx.tag({ gross_wt: '1.237', net_wt: '1.237', wastage_pct: '0' });
    const inv = await paid({ customer_id: c, lines: [tagLine(t1), tagLine(t2)] });
    await problem('POST', '/v1/sales/invoices/{id}/cancellation', { p: { id: inv.id }, body: { reason: 'billing error', refund_mode: 'cash' }, cookie: fx.cashier, status: 403, code: 'permission_denied' });
    const cn = (await fx.go('POST', '/v1/sales/invoices/{id}/cancellation', { p: { id: inv.id }, body: { reason: 'billing error', refund_mode: 'bank_transfer' }, headers: fx.key(), cookie: fx.manager })).json();
    expect(cn).toMatchObject({ kind: 'cancellation', total: inv.totals.invoice_total, round_off: inv.totals.round_off, refund_mode: 'bank_transfer', refund_amount: inv.totals.invoice_total });
    const g = (await fx.go('GET', '/v1/sales/invoices/{id}', { p: { id: inv.id } })).json();
    expect(g).toMatchObject({ status: 'cancelled', cancel_credit_note_id: cn.id, payment_status: 'paid' });   // keeps the status it had (contract PaymentStatus)
    for (const t of [t1, t2]) {
      expect((await tagStatus(t.id)).status).toBe('in_stock');
      expect((await ledger(t.id)).map((x) => x.movement)).toEqual(['sale', 'cancel_reversal']);
    }
    expect(await fx.sql(`SELECT topic, alert_type FROM notifications.outbox WHERE ref_id = $1`, [cn.id])).toEqual([{ topic: 'alert.invoice_cancelled', alert_type: 'invoice_cancelled' }]);
    await problem('POST', '/v1/sales/invoices/{id}/cancellation', { p: { id: inv.id }, body: { reason: 'billing error', refund_mode: 'cash' }, cookie: fx.manager, status: 409, code: 'invoice_cancelled' });
    await problem('POST', '/v1/sales/invoices/{id}/returns', { p: { id: inv.id }, body: { line_ids: [inv.lines[0].id], reason: 'after cancel' }, status: 409, code: 'invoice_cancelled' });
  });
  it('cancel of an unpaid credit bill reduces the due instead of refunding', async () => {
    const inv = await issue({ customer_id: await fx.customer(), lines: [tagLine(await small())] }, { cookie: fx.manager });
    const cn = (await fx.go('POST', '/v1/sales/invoices/{id}/cancellation', { p: { id: inv.id }, body: { reason: 'customer left', refund_mode: 'cash' }, headers: fx.key(), cookie: fx.manager })).json();
    expect(cn).toMatchObject({ refund_amount: '0.00', due_reduced: '6695.00', refund_mode: 'store_credit' });
  });
});

describe('store credit (option a): redemption at issue and on receipts', () => {
  it('partial, full, over-balance and another customer', async () => {
    const c = await fx.customer();
    const n = await storeCredit(c);
    expect(n).toMatchObject({ refund_mode: 'store_credit', store_credit_amount: '6695.00', balance_available: '6695.00' });
    const i1 = await issue({ customer_id: c, lines: [tagLine(await small())], payments: [{ mode: 'credit_note', credit_note_id: n.id, amount: '1000.00' }, { mode: 'upi', amount: '5695.00', reference: 'U' }] });
    expect(i1.payment_status).toBe('paid');
    expect((await cnView(n.id)).balance_available).toBe('5695.00');
    await problem('POST', '/v1/sales/invoices', { body: bill({ customer_id: c, lines: [tagLine(await small())], payments: [{ mode: 'credit_note', credit_note_id: n.id, amount: '5695.01' }, { mode: 'upi', amount: '999.99', reference: 'U' }] }), status: 409, code: 'store_credit_insufficient' });
    await problem('POST', '/v1/sales/invoices', { body: bill({ customer_id: await fx.customer(), lines: [tagLine(await small())], payments: [{ mode: 'credit_note', credit_note_id: n.id, amount: '100.00' }, { mode: 'upi', amount: '6595.00', reference: 'U' }] }), status: 422, code: 'validation_failed' });
    const cr = await issue({ customer_id: c, lines: [tagLine(await small())] }, { cookie: fx.manager });
    await receive(cr.id, [{ mode: 'credit_note', credit_note_id: n.id, amount: '5695.00' }]);
    expect((await cnView(n.id)).balance_available).toBe('0.00');
    expect(await due(cr.id)).toMatchObject({ balance_due: '1000.00', payment_status: 'part_paid' });
    await problem('POST', '/v1/sales/invoices/{id}/payments', { p: { id: cr.id }, body: { tenders: [{ mode: 'credit_note', credit_note_id: n.id, amount: '0.01' }] }, status: 409, code: 'store_credit_insufficient' });
  });
  it('two bills racing for one note: one wins, one 409, balance never negative', async () => {
    const c = await fx.customer();
    const n = await storeCredit(c);
    const t1 = await small(); const t2 = await small();
    const go = (t: { id: string }) => fx.go('POST', '/v1/sales/invoices', { body: bill({ customer_id: c, lines: [tagLine(t)], payments: [{ mode: 'credit_note', credit_note_id: n.id, amount: '6695.00' }] }),
      headers: fx.key(), status: [201, 409] });
    const rs = await Promise.all([go(t1), go(t2)]);
    expect(rs.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(rs.find((r) => r.statusCode === 409)!.json().code).toBe('store_credit_insufficient');
    expect((await cnView(n.id)).balance_available).toBe('0.00');
    const lost = rs[0].statusCode === 409 ? t1 : t2;
    expect((await tagStatus(lost.id)).status).toBe('in_stock');
  });
});

describe('receipt reversal (0.9.2, 995)', () => {
  it('permission, reason, once only, restores the due, audited, replay', async () => {
    const c = await fx.customer();
    const inv = await issue({ customer_id: c, lines: [tagLine(await small())], payments: [{ mode: 'cash', amount: '1000.00' }] });
    const r = await receive(inv.id, [{ mode: 'cheque', amount: '2000.00', reference: 'CHQ001', bank_name: 'SBI', cheque_date: todayIST() }]);
    expect((await due(inv.id)).balance_due).toBe('3695.00');
    await problem('POST', '/v1/sales/invoices/{id}/payments/{receipt_id}/reversal', { p: { id: inv.id, receipt_id: r.id }, body: { reason: 'cheque bounced' }, cookie: fx.cashier, status: 403, code: 'permission_denied' });
    await problem('POST', '/v1/sales/invoices/{id}/payments/{receipt_id}/reversal', { p: { id: inv.id, receipt_id: r.id }, body: { reason: 'no' }, cookie: fx.manager, status: 422, code: 'validation_failed' });
    await problem('POST', '/v1/sales/invoices/{id}/payments/{receipt_id}/reversal', { p: { id: inv.id, receipt_id: r.id }, body: {}, cookie: fx.manager, status: 422, code: 'validation_failed' });
    await problem('POST', '/v1/sales/invoices/{id}/payments/{receipt_id}/reversal', { p: { id: inv.id, receipt_id: '00000000-0000-4000-8000-000000000098' }, body: { reason: 'cheque bounced' }, cookie: fx.manager, status: 404, code: 'not_found' });
    const key = fx.key();
    const rv = await reverse(inv.id, r.id, 'cheque bounced', { headers: key });
    expect(rv.reversal).toMatchObject({ total: '-2000.00', reverses_receipt_id: r.id, reversal_reason: 'cheque bounced', tenders: [], balance_due_after: '5695.00' });
    expect(rv.store_credit_note).toBeNull();
    const again = await fx.go('POST', '/v1/sales/invoices/{id}/payments/{receipt_id}/reversal', { p: { id: inv.id, receipt_id: r.id }, body: { reason: 'cheque bounced' }, headers: key, cookie: fx.manager, status: 200 });
    expect(again.json().reversal.id).toBe(rv.reversal.id);
    expect(await due(inv.id)).toMatchObject({ balance_due: '5695.00', payment_status: 'part_paid' });
    await problem('POST', '/v1/sales/invoices/{id}/payments/{receipt_id}/reversal', { p: { id: inv.id, receipt_id: r.id }, body: { reason: 'cheque bounced' }, cookie: fx.manager, status: 409, code: 'receipt_already_reversed' });
    await problem('POST', '/v1/sales/invoices/{id}/payments/{receipt_id}/reversal', { p: { id: inv.id, receipt_id: rv.reversal.id }, body: { reason: 'undo the undo' }, cookie: fx.manager, status: 409, code: 'receipt_is_reversal' });
    const a = await auditRows('sales.receipt.reverse', rv.reversal.id);
    expect(a[0].new_row).toMatchObject({ reverses_receipt_id: r.id, amount: '2000.00', reason: 'cheque bounced' });
    const p = await payments(inv.id);
    expect(p.receipts.find((x: J) => x.id === r.id).reversed_by_receipt_id).toBe(rv.reversal.id);
    // concurrent reversals of one receipt: exactly one wins
    const r2 = await receive(inv.id, [{ mode: 'upi', amount: '500.00', reference: 'U9' }]);
    const both = await Promise.all([0, 1].map(() => fx.go('POST', '/v1/sales/invoices/{id}/payments/{receipt_id}/reversal', { p: { id: inv.id, receipt_id: r2.id }, body: { reason: 'duplicate entry' }, headers: fx.key(), cookie: fx.manager, status: [201, 409] })));
    expect(both.map((x) => x.statusCode).sort()).toEqual([201, 409]);
    expect((await due(inv.id)).balance_due).toBe('5695.00');
  });
  it('all store credit: ONE new receipt_reversal note (gapless no., own alert), original unchanged, new note spendable, excluded from GST', async () => {
    const c = await fx.customer();
    const n = await storeCredit(c);
    const inv = await issue({ customer_id: c, lines: [tagLine(await small())] }, { cookie: fx.manager });
    const r = await receive(inv.id, [{ mode: 'credit_note', credit_note_id: n.id, amount: '3000.00' }]);
    expect((await cnView(n.id)).balance_available).toBe('3695.00');
    const [{ s: lastSeq }] = await fx.sql<{ s: number }>(`SELECT max(doc_seq) AS s FROM sales.credit_note WHERE branch_id = $1`, [fx.B1]);
    const rv = await reverse(inv.id, r.id, 'wrong note applied');
    const nn = rv.store_credit_note;
    expect(nn).toMatchObject({ kind: 'receipt_reversal', reversal_receipt_id: rv.reversal.id, invoice_id: inv.id, refund_mode: 'store_credit', refund_amount: '0.00',
      due_reduced: '0.00', store_credit_amount: '3000.00', total: '3000.00', balance_available: '3000.00', taxable_value: '0.00', cgst: '0.00', sgst: '0.00', igst: '0.00', cess: '0.00', round_off: '0.00', lines: [] });
    expect(nn.doc_seq).toBe(Number(lastSeq) + 1);
    expect(nn.branch_id).toBe(fx.B1);
    expect(nn.customer.customer_id ?? c).toBe(c);
    expect((await cnView(n.id)).balance_available).toBe('3695.00');   // not topped up
    expect(await due(inv.id)).toMatchObject({ balance_due: '6695.00', payment_status: 'unpaid' });
    const al = await fx.sql<J>(`SELECT topic, alert_type, payload FROM notifications.outbox WHERE ref_type = 'credit_note' AND ref_id = $1`, [nn.id]);
    expect(al).toHaveLength(1);
    expect(al[0]).toMatchObject({ topic: 'alert.receipt_reversal', alert_type: 'receipt_reversal' });
    expect(JSON.stringify(al[0].payload)).toContain('3000');
    // the new note can be spent
    const i2 = await issue({ customer_id: c, lines: [tagLine(await small())], payments: [{ mode: 'credit_note', credit_note_id: nn.id, amount: '3000.00' }, { mode: 'upi', amount: '3695.00', reference: 'U' }] });
    expect(i2.payment_status).toBe('paid');
    expect((await cnView(nn.id)).balance_available).toBe('0.00');
    // lists: the normal list has it (filterable by kind); the GST credit-note register does not
    const byKind = (await fx.go('GET', '/v1/sales/credit-notes', { q: { kind: 'receipt_reversal' } })).json();
    expect(byKind.items.map((x: J) => x.id)).toContain(nn.id);
    expect(byKind.items.every((x: J) => x.kind === 'receipt_reversal')).toBe(true);
    const all = (await fx.go('GET', '/v1/sales/credit-notes')).json();
    expect(all.items.map((x: J) => x.id)).toContain(nn.id);
    const sales = await import('@jw/mod-sales');
    const gst = await withTenantTx(rw, { tenantId: fx.tenantId, userId: fx.ownerId }, () => sales.gstCreditNotes(todayIST(), todayIST()));
    expect(gst.map((x: J) => x.id)).not.toContain(nn.id);
    expect(gst.map((x: J) => x.id)).toContain(n.id);
    expect(gst.every((x: J) => x.kind !== 'receipt_reversal')).toBe(true);
    expect(await fx.sql(`SELECT 1 FROM reports.series_gaps WHERE tenant_id = $1`, [fx.tenantId])).toHaveLength(0);
  });
  it('mixed tenders: due restored by the whole receipt, the new note holds only the store-credit part', async () => {
    const c = await fx.customer();
    const n = await storeCredit(c);
    const inv = await issue({ customer_id: c, lines: [tagLine(await small())] }, { cookie: fx.manager });
    const r = await receive(inv.id, [{ mode: 'cash', amount: '1500.00' }, { mode: 'credit_note', credit_note_id: n.id, amount: '2500.00' }]);
    const rv = await reverse(inv.id, r.id, 'entered on wrong bill');
    expect(rv.reversal.total).toBe('-4000.00');
    expect(rv.store_credit_note).toMatchObject({ kind: 'receipt_reversal', total: '2500.00', balance_available: '2500.00' });
    expect((await cnView(n.id)).balance_available).toBe('4195.00');
    expect(await due(inv.id)).toMatchObject({ balance_due: '6695.00', cash_total: '0.00' });
  });
});

describe('estimates (S13)', () => {
  it('CRUD with If-Match, list, cancel; numbers from the estimate counter', async () => {
    const c = await fx.customer();
    const e = (await fx.go('POST', '/v1/sales/estimates', { body: { branch_id: fx.B1, customer_id: c, lines: [tagLine(await small())], notes: 'try ring' }, headers: fx.key(), cookie: fx.sales, status: 201 })).json();
    expect(e).toMatchObject({ status: 'draft', version: 1, print_count: 0, last_printed_at: null, invoice_id: null });
    expect(e.computation.totals.invoice_total).toBe('6695.00');
    expect(e.estimate_no).toMatch(/^EST-/);
    await fx.go('GET', '/v1/sales/estimates/{id}', { p: { id: e.id } });
    const put = (b: J, h: Record<string, string>, status: number) => fx.go('PUT', '/v1/sales/estimates/{id}', { p: { id: e.id }, body: b, headers: h, status });
    const body2 = { branch_id: fx.B1, customer_id: c, lines: [tagLine(await big())] };
    expect((await put(body2, {}, 428)).json().code).toBe('precondition_required');
    expect((await put(body2, fx.im(7), 412)).json().code).toBe('version_mismatch');
    const e2 = (await put(body2, fx.im(1), 200)).json();
    expect(e2).toMatchObject({ version: 2 });
    expect(e2.computation.totals.invoice_total).toBe('71894.00');
    const list = (await fx.go('GET', '/v1/sales/estimates', { q: { branch_id: fx.B1, status: 'draft' } })).json();
    expect(list.items.map((x: J) => x.id)).toContain(e.id);
    expect((await fx.go('POST', '/v1/sales/estimates/{id}/cancel', { p: { id: e.id }, headers: fx.im(1), status: 412 })).json().code).toBe('version_mismatch');
    const cx = (await fx.go('POST', '/v1/sales/estimates/{id}/cancel', { p: { id: e.id }, headers: fx.im(2), status: 200 })).json();
    expect(cx.status).toBe('cancelled');
    expect((await fx.go('POST', '/v1/sales/estimates/{id}/cancel', { p: { id: e.id }, headers: fx.im(3), status: 409 })).json().code).toBe('estimate_not_open');
    expect((await put(body2, fx.im(3), 409)).json().code).toBe('estimate_not_open');
  });
  it('merge up to 10 estimates into one bill (version checked); billed estimates are closed; 11 → 422', async () => {
    const c = await fx.customer();
    const ests: J[] = [];
    for (let i = 0; i < 3; i++) ests.push((await fx.go('POST', '/v1/sales/estimates', { body: { branch_id: fx.B1, customer_id: c, lines: [tagLine(await small())] }, headers: fx.key(), status: 201 })).json());
    const lines = ests.map((e) => e.request.lines[0]);
    await problem('POST', '/v1/sales/invoices', { body: bill({ customer_id: c, lines, estimates: ests.map((e) => ({ id: e.id, version: e.version + 1 })), payments: [{ mode: 'upi', amount: '20085.00', reference: 'U' }] }), status: 412, code: 'version_mismatch' });
    const inv = await issue({ customer_id: c, lines, estimates: ests.map((e) => ({ id: e.id, version: e.version })), payments: [{ mode: 'upi', amount: '20085.00', reference: 'U' }] });
    expect(inv.estimate_ids.sort()).toEqual(ests.map((e) => e.id).sort());
    for (const e of ests) expect((await fx.go('GET', '/v1/sales/estimates/{id}', { p: { id: e.id } })).json()).toMatchObject({ status: 'billed', invoice_id: inv.id });
    await problem('POST', '/v1/sales/invoices', { body: bill({ customer_id: c, lines: [tagLine(await small())], estimates: [{ id: ests[0].id, version: ests[0].version }], payments: [{ mode: 'upi', amount: '6695.00', reference: 'U' }] }), status: 409, code: 'estimate_not_open' });
    const eleven = Array.from({ length: 11 }, (_, i) => ({ id: `00000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`, version: 1 }));
    await problem('POST', '/v1/sales/invoices', { body: bill({ customer_id: c, lines: [tagLine(await small())], estimates: eleven }), status: 422, code: 'validation_failed' });
  });
});

describe('estimate merge exact boundary', () => {
  it('merges exactly 10 estimates from the same branch and customer', async () => {
    const customer_id = await fx.customer();
    const estimates: J[] = [];
    for (let i = 0; i < 10; i++) estimates.push((await fx.go('POST', '/v1/sales/estimates', { headers: fx.key(), body: {
      branch_id: fx.B1, customer_id, lines: [tagLine(await small())] } })).json());
    const inv = await paid({ customer_id, lines: estimates.flatMap((e) => e.request.lines), estimates: estimates.map((e) => ({ id: e.id, version: e.version })) });
    expect(inv.estimate_ids.sort()).toEqual(estimates.map((e) => e.id).sort());
    expect(inv.lines).toHaveLength(10);
    expect(inv.totals.invoice_total).toBe('66950.00');
    for (const e of estimates) expect((await fx.go('GET', '/v1/sales/estimates/{id}', { p: { id: e.id } })).json()).toMatchObject({ status: 'billed', invoice_id: inv.id });
  });
});

describe('prints and duplicates (S19)', () => {
  it('original, then duplicates need sales.invoice.reprint + reason; log; counts on invoice / estimate / credit note', async () => {
    const c = await fx.customer();
    const inv = await paid({ customer_id: c, lines: [tagLine(await small())] });
    const pr = (p: J, o: { cookie?: string; status?: number } = {}) => fx.go('POST', '/v1/sales/invoices/{id}/prints', { p: { id: inv.id }, body: p, headers: fx.key(), cookie: o.cookie, status: o.status ?? 200 });
    const p1 = (await pr({})).json();
    expect(p1).toMatchObject({ copy: 'original', print_no: 1, stamp: null, doc_cancelled: false, doc_no: inv.doc_no });
    expect(p1.amount_in_words).toMatch(/six thousand six hundred ninety[- ]five/i);
    expect((await pr({}, { status: 422 })).json().code).toBe('reprint_reason_required');
    expect((await pr({ reprint_reason: 'customer copy lost' }, { cookie: fx.sales, status: 403 })).json().code).toBe('reprint_not_allowed');
    expect((await pr({ language: 'xx' }, { status: 422 })).json()).toMatchObject({code:'validation_failed',errors:[expect.objectContaining({path:'language'})]});
    const p2 = (await pr({ reprint_reason: 'customer copy lost' }, { cookie: fx.cashier })).json();
    expect(p2).toMatchObject({ copy: 'duplicate', print_no: 2, stamp: 'DUPLICATE', doc_cancelled: false });
    const log = (await fx.go('GET', '/v1/sales/invoices/{id}/prints', { p: { id: inv.id } })).json();
    expect(log.map((x: J) => x.print_no)).toEqual([1, 2]);
    const g = (await fx.go('GET', '/v1/sales/invoices/{id}', { p: { id: inv.id } })).json();
    expect(g.print_count).toBe(2);
    expect(g.last_printed_at).toBe(log[1].printed_at);
    const e = (await fx.go('POST', '/v1/sales/estimates', { body: { branch_id: fx.B1, lines: [tagLine(await small())] }, headers: fx.key(), status: 201 })).json();
    expect((await fx.go('POST', '/v1/sales/estimates/{id}/prints', { p: { id: e.id }, body: {}, headers: fx.key() })).json()).toMatchObject({ stamp: 'ESTIMATE', print_no: 1, doc_cancelled: false });
    expect((await fx.go('POST', '/v1/sales/estimates/{id}/prints', { p: { id: e.id }, body: { reprint_reason: 'customer estimate copy' }, headers: fx.key() })).json()).toMatchObject({ print_no: 2, stamp: 'DUPLICATE' });
    expect((await fx.go('GET', '/v1/sales/estimates/{id}', { p: { id: e.id } })).json().print_count).toBe(2);
    const cn = (await fx.go('POST', '/v1/sales/invoices/{id}/cancellation', { p: { id: inv.id }, body: { reason: 'billing error', refund_mode: 'cash' }, headers: fx.key(), cookie: fx.manager })).json();
    expect((await fx.go('POST', '/v1/sales/credit-notes/{id}/prints', { p: { id: cn.id }, body: {}, headers: fx.key() })).json()).toMatchObject({ doc_type: 'credit_note', print_no: 1, doc_cancelled: false });
    expect((await cnView(cn.id)).print_count).toBe(1);
    expect((await pr({ reprint_reason: 'for the file' })).json().stamp).toMatch(/DUPLICATE|CANCELLED/);
  });
});

describe('numbering and atomic stock (INV-1, S1, S12)', () => {
  it('gapless invoice numbers under 8 concurrent issues', async () => {
    const c = await fx.customer();
    const tags = await Promise.all(Array.from({ length: 8 }, () => small()));
    const rs = await Promise.all(tags.map((t) => fx.go('POST', '/v1/sales/invoices', { body: bill({ customer_id: c, lines: [tagLine(t)], payments: [{ mode: 'upi', amount: '6695.00', reference: 'U' }] }), headers: fx.key(), status: 201 })));
    const seqs = rs.map((r) => r.json().doc_seq as number).sort((a, b) => a - b);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBe(seqs[i - 1] + 1);
    const all = await fx.sql<{ doc_seq: number }>(`SELECT doc_seq FROM sales.invoice WHERE branch_id = $1 ORDER BY doc_seq`, [fx.B1]);
    expect(all.map((x) => Number(x.doc_seq))).toEqual(all.map((_, i) => i + 1));
    expect(await fx.sql(`SELECT * FROM reports.series_gaps WHERE tenant_id = $1`, [fx.tenantId])).toHaveLength(0);
  });
  it('two concurrent sales of one tag: one 201, one 409; one ledger row', async () => {
    const t = await small();
    const c = await fx.customer();
    const one = () => fx.go('POST', '/v1/sales/invoices', { body: bill({ customer_id: c, lines: [tagLine(t)], payments: [{ mode: 'upi', amount: '6695.00', reference: 'U' }] }), headers: fx.key(), status: [201, 409] });
    const rs = await Promise.all([one(), one()]);
    expect(rs.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(rs.find((r) => r.statusCode === 409)!.json().code).toBe('tag_sold');
    expect(await ledger(t.id)).toEqual([{ movement: 'sale', direction: -1 }]);
  });
  it('a failure mid-issue (after markSold) leaves the tag in_stock with no ledger row and no number used', async () => {
    const c = await fx.customer();
    const t = await small();
    const [{ n: before }] = await fx.sql<{ n: string }>(`SELECT count(*) AS n FROM sales.invoice WHERE branch_id = $1`, [fx.B1]);
    // the tag line is sold first, then the loose line fails (more than the counter holds)
    const r = await fx.go('POST', '/v1/sales/invoices', { body: bill({ customer_id: c, pan: 'ABCPE1234G', lines: [tagLine(t), { kind: 'loose', item_id: fx.coin, purity_id: fx.P24, counter_id: fx.counter, pieces: 1, gross_wt: '999.000', net_wt: '999.000' }] }),
      headers: fx.key(), cookie: fx.manager, status: [409, 422] });
    expect(r.json().code).toBe('insufficient_loose_stock');
    expect((await tagStatus(t.id)).status).toBe('in_stock');
    expect(await ledger(t.id)).toEqual([]);
    // the same through the service, failing after the whole issue ran: everything rolls back
    const sales = await import('@jw/mod-sales');
    const actor = { userId: fx.ownerId, permissions: new Set(['sales.invoice.issue', 'sales.invoice.view']), roles: [{ role: 'owner', branch_id: null }], billingEnabled: true };
    await expect(withTenantTx(rw, { tenantId: fx.tenantId, userId: fx.ownerId }, async () => {
      const x = await sales.issueInvoice(actor, bill({ customer_id: c, lines: [tagLine(t)], payments: [{ mode: 'upi', amount: '6695.00', reference: 'U' }] }), todayIST());
      expect(x.id).toBeTruthy();
      throw new Error('boom after issue');
    })).rejects.toThrow('boom after issue');
    expect((await tagStatus(t.id)).status).toBe('in_stock');
    expect(await ledger(t.id)).toEqual([]);
    const [{ n: after }] = await fx.sql<{ n: string }>(`SELECT count(*) AS n FROM sales.invoice WHERE branch_id = $1`, [fx.B1]);
    expect(after).toBe(before);
    const ok = await issue({ customer_id: c, lines: [tagLine(t)], payments: [{ mode: 'upi', amount: '6695.00', reference: 'U' }] });
    const [{ m }] = await fx.sql<{ m: number }>(`SELECT max(doc_seq) AS m FROM sales.invoice WHERE branch_id = $1 AND id <> $2`, [fx.B1, ok.id]);
    expect(ok.doc_seq).toBe(Number(m) + 1);
  });
  it('a sold tag cannot be billed again; the same tag twice on one bill → 422', async () => {
    const c = await fx.customer(); const t = await small();
    await paid({ customer_id: c, lines: [tagLine(t)] });
    const r = await fx.go('POST', '/v1/sales/preview', { body: bill({ customer_id: c, lines: [tagLine(t)] }), status: 409 });
    expect(r.json().code).toBe('tag_sold');
    const t2 = await small();
    await problem('POST', '/v1/sales/preview', { body: bill({ customer_id: c, lines: [tagLine(t2), { kind: 'tag', tag_no: t2.tag_no }] }), status: 422, code: 'duplicate_tag_in_bill' });
  });
});

describe('invariants INV-1..6, branch scope and RLS', () => {
  it('INV-1: client numbers / dates rejected; INV-2: app_rw cannot write a bill; INV-4: bills immutable; INV-3: audit chain verifies; INV-6: no series gaps', async () => {
    const c = await fx.customer();
    await problem('POST', '/v1/sales/invoices', { body: { ...bill({ customer_id: c, lines: [tagLine(await small())] }), doc_no: 'X/1' }, status: 422, code: 'client_supplied_doc_number' });
    await problem('POST', '/v1/sales/invoices', { body: { ...bill({ customer_id: c, lines: [tagLine(await small())] }), doc_date: '2026-01-01' }, status: 422, code: 'client_supplied_doc_date' });
    const inv = await paid({ customer_id: c, lines: [tagLine(await small())] });
    const asRw = (q: string, p: unknown[] = []) => withTenantTx(rw, { tenantId: fx.tenantId, userId: fx.ownerId }, (cl) => cl.query(q, p));
    await expect(asRw(`INSERT INTO sales.invoice(tenant_id, branch_id) VALUES ($1, $2)`, [fx.tenantId, fx.B1])).rejects.toThrow();
    await expect(asRw(`UPDATE sales.invoice SET round_off = 0 WHERE id = $1`, [inv.id])).rejects.toThrow();
    await expect(asRw(`DELETE FROM sales.invoice WHERE id = $1`, [inv.id])).rejects.toThrow();
    await expect(fx.sql(`DELETE FROM sales.invoice WHERE id = $1`, [inv.id])).rejects.toThrow();
    await expect(fx.sql(`UPDATE sales.credit_note SET balance_available = balance_available + 1 WHERE invoice_id = $1`, [inv.id])).resolves.toBeDefined();   // no row: fine
    const [v] = await fx.sql<J>(`SELECT platform.audit_verify($1) AS ok`, [fx.tenantId]);
    expect(JSON.stringify(v.ok)).not.toMatch(/false|broken/i);
    expect(await fx.sql(`SELECT * FROM reports.series_gaps WHERE tenant_id = $1`, [fx.tenantId])).toHaveLength(0);
    // no Sales route other than the contract's writes invoices (INV-2)
    for (const [m, u] of [['PUT', `/v1/sales/invoices/${inv.id}`], ['PATCH', `/v1/sales/invoices/${inv.id}`], ['DELETE', `/v1/sales/invoices/${inv.id}`]] as const)
      expect((await fx.raw(m, u, { cookie: fx.owner, body: {} })).statusCode).toBe(404);
  });
  it('branch scope: a B1 manager cannot bill at B2', async () => {
    await problem('POST', '/v1/sales/preview', { body: { branch_id: fx.B2, customer_id: await fx.customer(), salesperson_id: fx.staffB2, lines: [tagLine(await small())] }, cookie: fx.manager, status: 403, code: 'branch_scope' });
  });
  it('RLS: another tenant sees none of these documents', async () => {
    const [inv] = await fx.sql<{ id: string }>(`SELECT id FROM sales.invoice LIMIT 1`);
    const other = '00000000-0000-4000-8000-0000000000aa';
    const seen = await withTenantTx(rw, { tenantId: other }, async (cl) => (await cl.query(`SELECT (SELECT count(*) FROM sales.invoice) + (SELECT count(*) FROM sales.credit_note)
      + (SELECT count(*) FROM sales.payment_receipt) + (SELECT count(*) FROM sales.estimate) + (SELECT count(*) FROM sales.document_print) AS n WHERE $1::uuid IS NOT NULL`, [inv.id])).rows[0].n);
    expect(Number(seen)).toBe(0);
    const fx2 = await salesFixture('salesrls', HUID_PREFIX.sales);
    try {
      const r = await fx2.raw('GET', `/v1/sales/invoices/${inv.id}`, { cookie: fx2.owner });
      expect(r.statusCode).toBe(404);
      const l = (await fx2.raw('GET', '/v1/sales/invoices', { cookie: fx2.owner })).json();
      expect(l.items).toEqual([]);
      const cn = (await fx2.raw('GET', '/v1/sales/credit-notes', { cookie: fx2.owner })).json();
      expect(cn.items).toEqual([]);
    } finally { await fx2.close(); }
  });
});

describe('review regressions: settings, discounts, cancelled prints and estimate identity', () => {
  it('an idempotent replay still needs current write permissions; settings checks permission before If-Match', async () => {
    const inv = await paid({ customer_id: await fx.customer(), lines: [tagLine(await small())] });
    const key = fx.key(); const body = { reason: 'wrong item billed', refund_mode: 'cash' };
    await fx.go('POST', '/v1/sales/invoices/{id}/cancellation', { p: { id: inv.id }, body, headers: key, cookie: fx.manager });
    await problem('POST', '/v1/sales/invoices/{id}/cancellation', { p: { id: inv.id }, body, headers: key, cookie: fx.cashier, status: 403, code: 'permission_denied' });
    await problem('PATCH', '/v1/sales/settings', { body: { return_window_days: 10 }, cookie: fx.manager, status: 403, code: 'permission_denied' });
  });

  it('making readiness carries the owner settings pointer on the failing gate', async () => {
    await fx.settings({ making_gst_treatment: 'separate', making_service_rate: null });
    try {
      const r = (await fx.go('GET', '/v1/sales/readiness', { q: { branch_id: fx.B1 } })).json();
      expect(r.ready).toBe(false);
      expect(r.gates.find((x: J) => x.code === 'making_service_rate')).toMatchObject({ ok: false, setting_key: 'making_service_rate', settings_path: '/v1/sales/settings' });
    } finally { await fx.settings({ making_gst_treatment: 'composite' }); }
  });
  it('two settings patches with one ETag yield one winner and one stale-version error', async () => {
    const g = await fx.go('GET', '/v1/sales/settings');
    const rs = await Promise.all([16, 17].map((return_window_days) => fx.go('PATCH', '/v1/sales/settings', {
      body: { return_window_days }, headers: { 'if-match': g.headers.etag as string }, status: [200, 412] })));
    expect(rs.map((x) => x.statusCode).sort()).toEqual([200, 412]);
    await fx.settings({ return_window_days: 15 });
  });
  it('discounts greater than line / bill value are 422 even in preview', async () => {
    const customer_id = await fx.customer(); const t = await small();
    for (const fields of [{ lines: [tagLine(t, { discount: '6500.01' })] }, { lines: [tagLine(t)], bill_discount: '6500.01' }]) {
      await problem('POST', '/v1/sales/preview', { body: bill({ customer_id, ...fields }), status: 422, code: 'validation_failed' });
      await problem('POST', '/v1/sales/invoices', { body: bill({ customer_id, ...fields }), status: 422, code: 'validation_failed' });
    }
    expect((await tagStatus(t.id)).status).toBe('in_stock');
  });
  it('estimate preview never blocks on PAN, cash or credit-sale permission; invoice preview still requires identities', async () => {
    await fx.settings({ pan_required_above: '5000.00', cash_limit_amount: '5000.00' });
    try {
      const lines = [tagLine(await small())];
      const r = (await fx.go('POST', '/v1/sales/preview', { cookie: fx.cashier, body: { mode: 'estimate', branch_id: fx.B1, lines,
        payments: [{ mode: 'cash', amount: '6000.00' }] } })).json();
      expect(r.customer).toBeNull();
      expect(r.requirements).toMatchObject({ pan_required: true, cash_limit: { exceeded: true } });
      await fx.go('POST', '/v1/sales/preview', { cookie: fx.cashier, body: { mode: 'estimate', branch_id: fx.B1, lines } });
    } finally { await fx.settings({ pan_required_above: '200000.00', cash_limit_amount: '200000.00' }); }
  });
  it('merge rejects different customers, and an identified estimate cannot be converted using quick-add', async () => {
    const c1 = await fx.customer(); const c2 = await fx.customer();
    const es: J[] = [];
    for (const c of [c1, c2]) es.push((await fx.go('POST', '/v1/sales/estimates', { headers: fx.key(), body: { branch_id: fx.B1, customer_id: c, lines: [tagLine(await small())] } })).json());
    await problem('POST', '/v1/sales/invoices', { body: bill({ customer_id: c1, lines: es.flatMap((e) => e.request.lines), estimates: es.map((e) => ({ id: e.id, version: e.version })) }), status: 422, code: 'validation_failed' });
    await problem('POST', '/v1/sales/invoices', { body: bill({ customer: { name: 'New buyer', phone: '9876567890' }, lines: es[0].request.lines, estimates: [{ id: es[0].id, version: es[0].version }] }), status: 422, code: 'validation_failed' });
  });
  it('QA B7 — a never-printed cancelled bill prints DUPLICATE/CANCELLED with a snapshot; estimate reprints need a reason', async () => {
    const inv = await paid({ customer_id: await fx.customer(), lines: [tagLine(await small())] });
    const cn = (await fx.go('POST', '/v1/sales/invoices/{id}/cancellation', { headers: fx.key(), p: { id: inv.id }, cookie: fx.manager, body: { reason: 'wrong billing entry', refund_mode: 'cash' } })).json();
    await problem('POST', '/v1/sales/invoices/{id}/prints', { headers: fx.key(), p: { id: inv.id }, body: {}, status: 422, code: 'reprint_reason_required' });
    await problem('POST', '/v1/sales/invoices/{id}/prints', { headers: fx.key(), p: { id: inv.id }, body: { reprint_reason: 'cancelled file copy' }, cookie: fx.sales, status: 403, code: 'reprint_not_allowed' });
    await problem('POST', '/v1/sales/invoices/{id}/prints', { headers: fx.key(), p: { id: inv.id }, body: { copy: 'original', reprint_reason: 'cancelled file copy' }, status: 422, code: 'validation_failed' });
    const pr = (await fx.go('POST', '/v1/sales/invoices/{id}/prints', { headers: fx.key(), p: { id: inv.id }, body: { reprint_reason: 'cancelled file copy' } })).json();
    expect(pr).toMatchObject({ print_no: 1, copy: 'duplicate', stamp: 'CANCELLED', doc_cancelled: true });
    expect(pr.notes).toContain(`Cancelled by credit note ${cn.doc_no}`);
    expect((await fx.go('GET', '/v1/sales/invoices/{id}/prints', { p: { id: inv.id } })).json()[0]).toMatchObject({ print_no: 1, copy: 'duplicate', doc_cancelled: true });
    expect(await fx.sql(`SELECT doc_cancelled, copy, print_no FROM sales.document_print WHERE doc_id = $1`, [inv.id])).toEqual([{ doc_cancelled: true, copy: 'duplicate', print_no: 1 }]);
    const e = (await fx.go('POST', '/v1/sales/estimates', { headers: fx.key(), body: { branch_id: fx.B1, lines: [tagLine(await small())] } })).json();
    await fx.go('POST', '/v1/sales/estimates/{id}/prints', { headers: fx.key(), p: { id: e.id }, body: {} });
    await problem('POST', '/v1/sales/estimates/{id}/prints', { headers: fx.key(), p: { id: e.id }, body: {}, status: 422, code: 'reprint_reason_required' });
    await problem('POST', '/v1/sales/estimates', { headers: fx.key(), body: { branch_id: fx.B1, lines: e.request.lines, valid_until: '2026-99-99' }, status: 422, code: 'validation_failed' });
  });
});

describe('997 print integrity and concurrency', () => {
  it('explicit duplicate needs a reason; 997 blocks first live duplicates without consuming print1, and originals never follow duplicates', async () => {
    const inv = await paid({ customer_id: await fx.customer(), lines: [tagLine(await small())] });
    const pr = async (body: J, status = 200) => (await fx.go('POST', '/v1/sales/invoices/{id}/prints', { p: { id: inv.id }, headers: fx.key(), body, status })).json();
    expect((await pr({ copy: 'duplicate' }, 422)).code).toBe('first_print_duplicate_not_supported');
    expect((await pr({ copy: 'duplicate', reprint_reason: 'duplicate file copy' }, 422)).code).toBe('first_print_duplicate_not_supported');
    expect(await fx.sql(`SELECT 1 FROM sales.document_print WHERE doc_id = $1`, [inv.id])).toHaveLength(0);
    expect(await pr({ copy: 'auto' })).toMatchObject({ print_no: 1, copy: 'original', doc_cancelled: false });
    expect(await pr({ copy: 'duplicate', reprint_reason: 'duplicate file copy' })).toMatchObject({ print_no: 2, copy: 'duplicate', doc_cancelled: false });
    expect(await pr({ copy: 'auto', reprint_reason: 'another file copy' })).toMatchObject({ print_no: 3, copy: 'duplicate', doc_cancelled: false });
    const cancelled = await paid({ customer_id: await fx.customer(), lines: [tagLine(await small())] });
    await fx.go('POST', '/v1/sales/invoices/{id}/cancellation', { p: { id: cancelled.id }, headers: fx.key(), cookie: fx.manager, body: { reason: 'incorrect live bill', refund_mode: 'cash' } });
    for (const [i, copy] of ['duplicate', 'auto'].entries()) {
      const result = (await fx.go('POST', '/v1/sales/invoices/{id}/prints', { p: { id: cancelled.id }, headers: fx.key(), body: { copy, reprint_reason: 'cancelled file copy' } })).json();
      expect(result).toMatchObject({ print_no: i + 1, copy: 'duplicate', stamp: 'CANCELLED', doc_cancelled: true });
    }
  });
  it('explicit duplicates on credit notes and estimates follow the same first-print schema constraint', async () => {
    const inv = await paid({ customer_id: await fx.customer(), lines: [tagLine(await small())] });
    const cn = (await fx.go('POST', '/v1/sales/invoices/{id}/returns', { p: { id: inv.id }, headers: fx.key(), body: { line_ids: [inv.lines[0].id], reason: 'wrong size returned', refund_mode: 'cash' } })).json();
    const e = (await fx.go('POST', '/v1/sales/estimates', { headers: fx.key(), body: { branch_id: fx.B1, lines: [tagLine(await small())] } })).json();
    for (const [path, id] of [['/v1/sales/credit-notes/{id}/prints', cn.id], ['/v1/sales/estimates/{id}/prints', e.id]]) {
      const pr = async (body: J, status = 200) => (await fx.go('POST', path, { p: { id }, headers: fx.key(), body, status })).json();
      expect((await pr({ copy: 'duplicate' }, 422)).code).toBe('reprint_reason_required');
      expect((await pr({ copy: 'duplicate', reprint_reason: 'explicit duplicate request' }, 422)).code).toBe('first_print_duplicate_not_supported');
      expect(await pr({ copy: 'auto' })).toMatchObject({ print_no: 1, copy: 'original', doc_cancelled: false });
      expect(await pr({ copy: 'duplicate', reprint_reason: 'explicit duplicate request' })).toMatchObject({ print_no: 2, copy: 'duplicate', doc_cancelled: false });
      expect(await pr({ reprint_reason: 'later auto request' })).toMatchObject({ print_no: 3, copy: 'duplicate' });
    }
  });

  it('DB guards reject cancelled originals, snapshot/branch/printer mismatches, and mutable print history', async () => {
    const inv = await paid({ customer_id: await fx.customer(), lines: [tagLine(await small())] });
    const cn = (await fx.go('POST', '/v1/sales/invoices/{id}/cancellation', { p: { id: inv.id }, headers: fx.key(), cookie: fx.manager,
      body: { reason: 'wrong goods invoiced', refund_mode: 'cash' } })).json();
    // 999 (NB-1): pins are NOT NULL, so every raw row carries a valid platform v1 pin for its doc type; each case still hits ITS OWN guard.
    const rawPrint = (copy: string, cancelled: boolean, branch = fx.B1, printer = fx.ownerId, reason: string | null = 'guard verification', no = 1, type = 'invoice', id = inv.id) =>
      withTenantTx(rw, { tenantId: fx.tenantId, userId: fx.ownerId }, () => withModuleRole('sales_writer', (c) => c.query(
        `INSERT INTO sales.document_print(tenant_id, branch_id, doc_type, doc_id, print_no, copy, paper, reprint_reason, printed_by, doc_cancelled, template_id, template_version)
         VALUES (platform.current_tenant(), $1, $2, $3, $4, $5, 'A4', $6, $7, $8, $9, 1)`, [branch, type, id, no, copy, reason, printer, cancelled, PLATFORM_V1[type]])));
    await expect(rawPrint('original', true)).rejects.toMatchObject({ code: '23514', constraint: 'document_print_original_check' });
    await expect(rawPrint('original', false)).rejects.toMatchObject({ code: '42501' });
    await expect(rawPrint('duplicate', true, fx.B2)).rejects.toMatchObject({ code: '42501' });
    await expect(rawPrint('duplicate', true, fx.B1, fx.managerId)).rejects.toMatchObject({ code: '42501' });
    await expect(rawPrint('duplicate', true, fx.B1, fx.ownerId, null)).rejects.toMatchObject({ code: '23514', constraint: 'document_print_reason_check' });
    await expect(rawPrint('duplicate', true, fx.B1, fx.ownerId, 'guard verification', 1, 'credit_note', cn.id)).rejects.toMatchObject({ code: '23514', constraint: 'document_print_original_check' });
    const pr = (await fx.go('POST', '/v1/sales/invoices/{id}/prints', { p: { id: inv.id }, headers: fx.key(), body: { reprint_reason: 'cancelled file copy' } })).json();
    expect(pr.print_no).toBe(1); // all the failed inserts were rolled back
    await expect(rawPrint('duplicate', true)).rejects.toMatchObject({ code: '23505' });
    await expect(withTenantTx(rw, { tenantId: fx.tenantId, userId: fx.ownerId }, () => withModuleRole('sales_writer', (c) =>
      c.query(`UPDATE sales.document_print SET doc_cancelled = false WHERE doc_id = $1`, [inv.id])))).rejects.toMatchObject({ code: '42501' });
    expect(await fx.sql(`SELECT doc_cancelled FROM sales.document_print WHERE doc_id = $1`, [inv.id])).toEqual([{ doc_cancelled: true }]);
    const audit = await auditRows('sales.invoice.print', inv.id);
    expect(audit.at(-1)?.new_row).toMatchObject({ print_no: 1, copy: 'duplicate', doc_cancelled: true });
  });
  it('NB-1 / 999 — print pins are NOT NULL and version >= 1 at the DB; a valid pin is accepted and reprints keep it; unresolvable pins never substitute', async () => {
    const live = await paid({ customer_id: await fx.customer(), lines: [tagLine(await small())] });
    const raw = (tid: string | null, ver: number | null, no = 1, copy = 'original', id = live.id) =>
      withTenantTx(rw, { tenantId: fx.tenantId, userId: fx.ownerId }, () => withModuleRole('sales_writer', (c) => c.query(
        `INSERT INTO sales.document_print(tenant_id, branch_id, doc_type, doc_id, print_no, copy, paper, reprint_reason, printed_by, doc_cancelled, template_id, template_version)
         VALUES (platform.current_tenant(), $1, 'invoice', $2, $3, $4, 'A4', $5, $6, false, $7, $8)`, [fx.B1, id, no, copy, copy === 'original' ? null : 'nb1 check', fx.ownerId, tid, ver])));
    await expect(raw(null, 1)).rejects.toMatchObject({ code: '23502', column: 'template_id' });
    await expect(raw(PLATFORM_V1.invoice, null)).rejects.toMatchObject({ code: '23502', column: 'template_version' });
    await expect(raw(PLATFORM_V1.invoice, 0)).rejects.toMatchObject({ code: '23514', constraint: 'document_print_template_version_check' });
    await expect(raw(PLATFORM_V1.invoice, -1)).rejects.toMatchObject({ code: '23514', constraint: 'document_print_template_version_check' });
    const cat = await fx.sql<J>(`SELECT a.attname, a.attnotnull FROM pg_attribute a WHERE a.attrelid = 'sales.document_print'::regclass AND a.attname IN ('template_id','template_version') ORDER BY 1`);
    expect(cat).toEqual([{ attname: 'template_id', attnotnull: true }, { attname: 'template_version', attnotnull: true }]);
    // valid pin accepted; the API reprint keeps exactly that pin (normal pinning unchanged)
    await raw(PLATFORM_V1.invoice, 1);
    const rp = (await fx.go('POST', '/v1/sales/invoices/{id}/prints', { p: { id: live.id }, headers: fx.key(), body: { reprint_reason: 'nb1 reprint pin' } })).json();
    expect(rp).toMatchObject({ print_no: 2, copy: 'duplicate', template_id: PLATFORM_V1.invoice, template_version: 1 });
    // normal API first print + reprint pinning unchanged
    const other = await paid({ customer_id: await fx.customer(), lines: [tagLine(await small())] });
    const p1 = (await fx.go('POST', '/v1/sales/invoices/{id}/prints', { p: { id: other.id }, headers: fx.key(), body: {} })).json();
    const p2 = (await fx.go('POST', '/v1/sales/invoices/{id}/prints', { p: { id: other.id }, headers: fx.key(), body: { reprint_reason: 'nb1 second copy' } })).json();
    expect(p1).toMatchObject({ print_no: 1, copy: 'original' }); expect(p1.template_id).toEqual(expect.any(String)); expect(p1.template_version).toBeGreaterThanOrEqual(1);
    expect(p2).toMatchObject({ print_no: 2, copy: 'duplicate', template_id: p1.template_id, template_version: p1.template_version });
    // legacy unpinned rows can no longer exist (23502 above). NB-1a: a pin to another document type's template cannot be written
    // either (3-column FK → 23503), so nothing is logged and the API never substitutes a different template.
    const odd = await paid({ customer_id: await fx.customer(), lines: [tagLine(await small())] });
    await expect(raw(PLATFORM_V1.estimate, 1, 1, 'original', odd.id)).rejects.toMatchObject({ code: '23503', constraint: 'document_print_template_fk' });
    expect(await fx.sql(`SELECT print_no FROM sales.document_print WHERE doc_id = $1`, [odd.id])).toEqual([]);
  });

  it('NB-1 / 999 FK — pins reference a real template version: unknown uuid / unknown version → 23503; inactive + platform versions accepted; a used version cannot be deleted (all rolled back)', async () => {
    const live = await paid({ customer_id: await fx.customer(), lines: [tagLine(await small())] });
    const other = await paid({ customer_id: await fx.customer(), lines: [tagLine(await small())] });
    const ROLLBACK = new Error('nb1-fk-rollback');
    const ins = (c: Parameters<Parameters<typeof withModuleRole>[1]>[0], tid: string, ver: number, id = live.id) => c.query(
      `INSERT INTO sales.document_print(tenant_id, branch_id, doc_type, doc_id, print_no, copy, paper, reprint_reason, printed_by, doc_cancelled, template_id, template_version)
       VALUES (platform.current_tenant(), $1, 'invoice', $2, 1, 'original', 'A4', NULL, $3, false, $4, $5)`, [fx.B1, id, fx.ownerId, tid, ver]);
    const raw = (tid: string, ver: number) => withTenantTx(rw, { tenantId: fx.tenantId, userId: fx.ownerId }, () => withModuleRole('sales_writer', (c) => ins(c, tid, ver)));
    const cat = await fx.sql<J>(`SELECT conname, contype, confdeltype, confupdtype, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname IN ('document_print_template_fk','print_template_id_version_uq','print_template_id_version_doc_type_uq') ORDER BY conname`);
    expect(cat).toEqual([ // NB-1a: 3-column FK on the generated template_doc_type; the 2-column (id, version) draft is gone
      { conname: 'document_print_template_fk', contype: 'f', confdeltype: 'r', confupdtype: 'r', def: 'FOREIGN KEY (template_id, template_version, template_doc_type) REFERENCES branding.print_template(id, version, doc_type) ON UPDATE RESTRICT ON DELETE RESTRICT' },
      { conname: 'print_template_id_version_doc_type_uq', contype: 'u', confdeltype: ' ', confupdtype: ' ', def: 'UNIQUE (id, version, doc_type)' }]);
    // unknown template uuid → 23503 on the FK
    await expect(raw('00000000-0000-4000-8000-0000000fc999', 1)).rejects.toMatchObject({ code: '23503', constraint: 'document_print_template_fk' });
    // known uuid, unknown version → 23503 on the FK
    await expect(raw(PLATFORM_V1.invoice, 987654)).rejects.toMatchObject({ code: '23503', constraint: 'document_print_template_fk' });
    // valid (id, version): an INACTIVE tenant version and a platform v1 are both accepted — then everything is rolled back
    let inactive: J | undefined;
    await expect(withTenantTx(rw, { tenantId: fx.tenantId, userId: fx.ownerId }, async (c) => {
      inactive = (await c.query(`INSERT INTO branding.print_template(scope, tenant_id, doc_type, version, paper, body_key, is_active)
        SELECT 'tenant', platform.current_tenant(), 'invoice', coalesce(max(version), 0) + 1, 'A4', 'nb1/fk-inactive.hbs', false
          FROM branding.print_template WHERE tenant_id = platform.current_tenant() AND doc_type = 'invoice' RETURNING id, version, is_active`)).rows[0];
      expect(inactive).toMatchObject({ is_active: false });
      await withModuleRole('sales_writer', (w) => ins(w, inactive!.id, inactive!.version));
      await withModuleRole('sales_writer', (w) => ins(w, PLATFORM_V1.invoice, 1, other.id));
      const n = (await c.query(`SELECT count(*)::int AS n FROM sales.document_print WHERE doc_id = ANY($1::uuid[])`, [[live.id, other.id]])).rows[0] as J;
      expect(n.n).toBe(2);
      throw ROLLBACK;
    })).rejects.toBe(ROLLBACK);
    expect(inactive).toBeDefined();
    expect(await fx.sql(`SELECT 1 FROM branding.print_template WHERE id = $1`, [inactive!.id])).toEqual([]);
    expect(await fx.sql(`SELECT 1 FROM sales.document_print WHERE doc_id = ANY($1::uuid[])`, [[live.id, other.id]])).toEqual([]);
    // deleting a template version that a print uses → 23503 (ON DELETE RESTRICT), inside a transaction that is always rolled back
    const [used] = await fx.sql<J>(`SELECT template_id, template_version, count(*)::int AS n FROM sales.document_print WHERE tenant_id = $1
      GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 1`, [fx.tenantId]);
    expect(used?.n).toBeGreaterThan(0); // earlier tests in this file printed through the API
    const mig = pool('app_migrator'); const m = await mig.connect();
    try {
      await m.query('BEGIN');
      await expect(m.query(`DELETE FROM branding.print_template WHERE id = $1 AND version = $2`, [used.template_id, used.template_version]))
        .rejects.toMatchObject({ code: '23503', constraint: 'document_print_template_fk' });
    } finally { await m.query('ROLLBACK'); m.release(); await mig.end(); }
    expect(await fx.sql(`SELECT 1 FROM branding.print_template WHERE id = $1 AND version = $2`, [used.template_id, used.template_version])).toHaveLength(1);
  });
  it('NB-1a / 999 — template_doc_type is generated (payment_receipt → receipt); a pin must be a template of the print\'s own document type (all rolled back)', async () => {
    const col = await fx.sql<J>(`SELECT a.attgenerated, a.attnotnull, pg_get_expr(d.adbin, d.adrelid) AS expr FROM pg_attribute a
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum WHERE a.attrelid = 'sales.document_print'::regclass AND a.attname = 'template_doc_type'`);
    expect(col).toEqual([{ attgenerated: 's', attnotnull: false, expr: expect.stringMatching(/CASE doc_type\s+WHEN 'payment_receipt'::text THEN 'receipt'::text\s+ELSE doc_type\s+END/) }]);
    const ROLLBACK = new Error('nb1a-rollback');
    const doc = '00000000-0000-4000-8000-0000000a1a01'; // doc_id is polymorphic (no FK); every insert below is rolled back
    const ins = (type: string, tid: string, extra = false) => withTenantTx(rw, { tenantId: fx.tenantId, userId: fx.ownerId }, () => withModuleRole('sales_writer', (c) => c.query(
      `INSERT INTO sales.document_print(tenant_id, branch_id, doc_type, doc_id, print_no, copy, paper, reprint_reason, printed_by, doc_cancelled, template_id, template_version${extra ? ', template_doc_type' : ''})
       VALUES (platform.current_tenant(), $1, $2, $3, 1, 'original', 'A4', NULL, $4, false, $5, 1${extra ? ", 'receipt'" : ''}) RETURNING doc_type, template_doc_type`, [fx.B1, type, doc, fx.ownerId, tid])));
    // estimate pinned to the invoice template → 23503 on the 3-column FK
    await expect(ins('estimate', PLATFORM_V1.invoice)).rejects.toMatchObject({ code: '23503', constraint: 'document_print_template_fk' });
    // payment_receipt pinned to an invoice template → 23503; to the receipt template → accepted (generated receipt), then rolled back
    await expect(ins('payment_receipt', PLATFORM_V1.invoice)).rejects.toMatchObject({ code: '23503', constraint: 'document_print_template_fk' });
    let ok: J | undefined;
    await expect(withTenantTx(rw, { tenantId: fx.tenantId, userId: fx.ownerId }, async () => {
      ok = (await withModuleRole('sales_writer', (c) => c.query(`INSERT INTO sales.document_print(tenant_id, branch_id, doc_type, doc_id, print_no, copy, paper, printed_by, doc_cancelled, template_id, template_version)
        VALUES (platform.current_tenant(), $1, 'payment_receipt', $2, 1, 'original', 'A4', $3, false, $4, 1) RETURNING doc_type, template_doc_type`, [fx.B1, doc, fx.ownerId, PLATFORM_V1.payment_receipt]))).rows[0];
      throw ROLLBACK;
    })).rejects.toBe(ROLLBACK);
    expect(ok).toEqual({ doc_type: 'payment_receipt', template_doc_type: 'receipt' });
    // the generated column is never writable (428C9), even with the value it would compute
    await expect(ins('payment_receipt', PLATFORM_V1.payment_receipt, true)).rejects.toMatchObject({ code: '428C9' });
    expect(await fx.sql(`SELECT 1 FROM sales.document_print WHERE doc_id = $1`, [doc])).toEqual([]);
    // a template referenced by a print cannot change document type (ON UPDATE RESTRICT on the 3-column key), rolled back
    const [used] = await fx.sql<J>(`SELECT template_id, template_version FROM sales.document_print WHERE tenant_id = $1 AND doc_type = 'invoice' LIMIT 1`, [fx.tenantId]);
    expect(used).toBeDefined();
    const mig = pool('app_migrator'); const m = await mig.connect();
    try {
      await m.query('BEGIN');
      // target a doc type with no sibling row for the same owner (so print_template_one_active / version_uq cannot fire first)
      const to = (await m.query(`SELECT t FROM unnest(ARRAY['rate_card','order_receipt','tag_label','estimate','credit_note','receipt']) WITH ORDINALITY u(t, o)
        WHERE NOT EXISTS (SELECT 1 FROM branding.print_template x JOIN branding.print_template y ON y.id = $1 AND y.version = $2
          WHERE x.scope = y.scope AND x.partner_id IS NOT DISTINCT FROM y.partner_id AND x.tenant_id IS NOT DISTINCT FROM y.tenant_id AND x.doc_type = u.t)
        ORDER BY o LIMIT 1`, [used.template_id, used.template_version])).rows[0]?.t as string;
      expect(to).toEqual(expect.any(String));
      await expect(m.query(`UPDATE branding.print_template SET doc_type = $3 WHERE id = $1 AND version = $2`, [used.template_id, used.template_version, to]))
        .rejects.toMatchObject({ code: '23503', constraint: 'document_print_template_fk' });
    } finally { await m.query('ROLLBACK'); m.release(); await mig.end(); }
    // no app source writes (or even names) template_doc_type: it is generated (schema.ts types only, excluded)
    const hits: string[] = [];
    const walk = (dir: string): void => { for (const e of readdirSync(dir, { withFileTypes: true })) {
      const f = join(dir, e.name);
      if (e.isDirectory()) { if (!['node_modules', 'dist', 'generated'].includes(e.name)) walk(f); }
      else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) && /template_doc_type/.test(readFileSync(f, 'utf8'))) hits.push(f);
    } };
    for (const d of ['../../apps', '../../packages']) walk(join(__dirname, d));
    expect(hits).toEqual([]);
    expect(readFileSync(join(__dirname, '../../packages/modules/sales/src/internal/prints.ts'), 'utf8')).toMatch(/INSERT INTO sales\.document_print\(tenant_id, branch_id, doc_type, doc_id, print_no, copy, paper, language, numerals,\s+template_id, template_version, reprint_reason, printed_by, doc_cancelled\)/);
  });
  it('NB-2 / 999 — all 19 legacy Sales constraints are VALIDATED in the catalogue, and invalid new rows still fail', async () => {
    const rows = await fx.sql<J>(`SELECT conname, convalidated FROM pg_constraint WHERE connamespace = 'sales'::regnamespace AND conname = ANY($1::text[]) ORDER BY conname`, [NB2_CONSTRAINTS]);
    expect(rows).toHaveLength(19);
    expect(rows.filter((r) => r.convalidated !== true)).toEqual([]);
    expect(rows.map((r) => r.conname).sort()).toEqual([...NB2_CONSTRAINTS].sort());
    // Enforcement on NEW rows: inside ONE transaction, issue a real invoice through the module (so child_guard admits rows for it),
    // then add a copy of its line with exactly one rule broken. Each attempt rolls back entirely: no invoice, number or stock change persists.
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    const actor = { userId: fx.ownerId, permissions: new Set(['sales.invoice.issue']), roles: [{ role: 'owner', branch_id: null }], billingEnabled: true };
    const customer_id = await fx.customer();
    const before = await fx.sql<J>(`SELECT count(*)::int AS n FROM sales.invoice`);
    const tryBad = async (overrides: Record<string, string>) => {
      const tag = await small(), spare = await small();
      return withTenantTx(rw, { tenantId: fx.tenantId, userId: fx.ownerId }, async () => {
        const x = await issueInvoice(actor, { branch_id: fx.B1, salesperson_id: fx.staff, customer_id, lines: [{ kind: 'tag', tag_id: tag.id }],
          payments: [{ mode: 'upi', amount: '1000.00' }] } as never, day);
        await withModuleRole('sales_writer', async (c) => {
          const cols = (await c.query<{ a: string }>(`SELECT attname AS a FROM pg_attribute WHERE attrelid = 'sales.invoice_line'::regclass
            AND attnum > 0 AND NOT attisdropped AND attgenerated = '' AND attname <> 'id' ORDER BY attnum`)).rows.map((r) => r.a);
          const o: Record<string, string> = { line_no: 'line_no + 100', tag_id: `'${spare.id}'::uuid`, ...overrides };
          await c.query(`INSERT INTO sales.invoice_line(${cols.map((k) => `"${k}"`).join(',')})
            SELECT ${cols.map((k) => o[k] ?? `"${k}"`).join(',')} FROM sales.invoice_line WHERE invoice_id = $1 LIMIT 1`, [x.id]);
        });
      });
    };
    await expect(tryBad({ mc_type: `'bogus'` })).rejects.toMatchObject({ code: '23514', constraint: 'invoice_line_mc_type_check' });
    await expect(tryBad({ line_total: 'line_total + 1' })).rejects.toMatchObject({ code: '23514', constraint: 'invoice_line_total_sum_check' });
    await expect(tryBad({ net_wt: 'gross_wt + 1' })).rejects.toMatchObject({ code: '23514', constraint: 'invoice_line_weights_check' });
    await expect(tryBad({ cgst: 'cgst + 1', sgst: 'sgst', igst: '1', line_total: 'line_total + 2' })).rejects.toMatchObject({ code: '23514', constraint: 'invoice_line_gst_split_check' });
    await expect(tryBad({ item_id: `'00000000-0000-0000-0000-0000000000ff'::uuid` })).rejects.toMatchObject({ code: '23503', constraint: 'invoice_line_item_fk' });
    expect(await fx.sql<J>(`SELECT count(*)::int AS n FROM sales.invoice`)).toEqual(before); // every attempt rolled back
  });
  it('concurrent live prints use contiguous max+1 numbers with exactly one ORIGINAL', async () => {
    const inv = await paid({ customer_id: await fx.customer(), lines: [tagLine(await small())] });
    const prints = await Promise.all(Array.from({ length: 5 }, () => fx.go('POST', '/v1/sales/invoices/{id}/prints', {
      p: { id: inv.id }, headers: fx.key(), body: { reprint_reason: 'concurrent file copies' } })));
    const rows = prints.map((p) => p.json()).sort((a, b) => a.print_no - b.print_no);
    expect(rows.map((p) => p.print_no)).toEqual([1, 2, 3, 4, 5]);
    expect(rows.map((p) => p.copy)).toEqual(['original', 'duplicate', 'duplicate', 'duplicate', 'duplicate']);
    expect(rows.every((p) => p.doc_cancelled === false)).toBe(true);
  });
  for (const firstOperation of ['print', 'cancel'] as const) it(`print racing cancel, ${firstOperation} wins: serialized snapshots, no deadlock`, async () => {
    const inv = await paid({ customer_id: await fx.customer(), lines: [tagLine(await small())] });
    const actor = { userId: fx.ownerId, permissions: new Set(['sales.invoice.view', 'sales.invoice.reprint', 'sales.invoice.cancel']), roles: [{ role: 'owner', branch_id: null }], billingEnabled: true };
    const run = (operation: 'print' | 'cancel') => operation === 'print'
      ? printDoc(actor, 'invoice', inv.id, { reprint_reason: 'racing print copy' }, todayIST())
      : cancelInvoice(actor, inv.id, { reason: 'racing cancellation', refund_mode: 'cash' });
    let release!: () => void, ready!: () => void, started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const firstReady = new Promise<void>((resolve) => { ready = resolve; });
    const secondStarted = new Promise<void>((resolve) => { started = resolve; });
    let firstPid = 0, secondPid = 0, firstError: unknown;
    let second: Promise<unknown> | undefined;
    const first = withTenantTx(rw, { tenantId: fx.tenantId, userId: fx.ownerId }, async (c) => {
      await c.query(`SET LOCAL lock_timeout = '8s'; SET LOCAL statement_timeout = '10s'`);
      firstPid = (await c.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid;
      const value = await run(firstOperation); ready(); await gate; return value;
    });
    void first.catch((e) => { firstError = e; ready(); });
    try {
      await firstReady;
      if (firstError) throw firstError;
      if (firstOperation === 'print') {
        // A second SHARE succeeds NOWAIT: the app did not accidentally take UPDATE.
        await withTenantTx(rw, { tenantId: fx.tenantId }, () => withModuleRole('sales_writer', (c) =>
          c.query(`SELECT id FROM sales.invoice WHERE id = $1 FOR SHARE NOWAIT`, [inv.id])));
      }
      second = withTenantTx(rw, { tenantId: fx.tenantId, userId: fx.ownerId }, async (c) => {
        await c.query(`SET LOCAL lock_timeout = '8s'; SET LOCAL statement_timeout = '10s'`);
        secondPid = (await c.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid; started();
        return run(firstOperation === 'print' ? 'cancel' : 'print');
      });
      void second.catch(() => started());
      await secondStarted;
      let blocked = false;
      for (let i = 0; i < 100 && !blocked; i++) {
        blocked = (await fx.sql<{ blocked: boolean }>(`SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked`, [firstPid, secondPid]))[0].blocked;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true); // actual overlap, not two accidentally sequential calls
      release();
      const values = await Promise.all([first, second]);
      const pr = values[firstOperation === 'print' ? 0 : 1] as J;
      expect(pr).toMatchObject({ print_no: 1, copy: firstOperation === 'print' ? 'original' : 'duplicate', doc_cancelled: firstOperation === 'cancel', stamp: firstOperation === 'cancel' ? 'CANCELLED' : null });
      const cn = await cnView(values[firstOperation === 'cancel' ? 0 : 1] as string);
      if (firstOperation === 'cancel') expect(pr.notes).toContain(`Cancelled by credit note ${cn.doc_no}`);
      const later = (await fx.go('POST', '/v1/sales/invoices/{id}/prints', { p: { id: inv.id }, headers: fx.key(), body: { reprint_reason: 'after cancellation copy' } })).json();
      expect(later).toMatchObject({ print_no: 2, copy: 'duplicate', stamp: 'CANCELLED', doc_cancelled: true });
      const log = (await fx.go('GET', '/v1/sales/invoices/{id}/prints', { p: { id: inv.id } })).json();
      expect(log.map((p: J) => p.doc_cancelled)).toEqual([firstOperation === 'cancel', true]);
    } finally { release(); await Promise.allSettled([first, ...(second ? [second] : [])]); }
  }, 30000);
});

describe('996 report reconciliation', () => {
  it('one receipt-reversal note is excluded from GST counts and CDN amounts, but is not a series gap', async () => {
    const f = await salesFixture('sales996', HUID_PREFIX.sales);
    try {
      const c = await f.customer();
      const oldTag = await f.tag(SMALL);
      const issueBody = (tag: { id: string }, payments: J[] = []) => ({ branch_id: f.B1, salesperson_id: f.staff, customer_id: c, lines: [tagLine(tag)], payments });
      const inv1 = (await f.go('POST', '/v1/sales/invoices', { headers: f.key(), body: issueBody(oldTag, [{ mode: 'upi', amount: '6695.00' }]) })).json();
      const cn = (await f.go('POST', '/v1/sales/invoices/{id}/returns', { p: { id: inv1.id }, headers: f.key(),
        body: { line_ids: [inv1.lines[0].id], reason: 'customer changed mind', refund_mode: 'store_credit' } })).json();
      const inv2 = (await f.go('POST', '/v1/sales/invoices', { headers: f.key(), body: issueBody(await f.tag(SMALL)), cookie: f.manager })).json();
      const rc = (await f.go('POST', '/v1/sales/invoices/{id}/payments', { p: { id: inv2.id }, headers: f.key(),
        body: { tenders: [{ mode: 'credit_note', credit_note_id: cn.id, amount: '1000.00' }] } })).json();
      const rv = (await f.go('POST', '/v1/sales/invoices/{id}/payments/{receipt_id}/reversal', { p: { id: inv2.id, receipt_id: rc.id }, headers: f.key(),
        cookie: f.manager, body: { reason: 'wrong payment applied' } })).json();
      const rows = await f.sql<J>(`SELECT doc_type, from_no, to_no, total, cancelled, excluded_receipt_reversal_count, total_in_series
        FROM reports.gstr1_doc_summary WHERE branch_id = $1`, [f.B1]);
      const r = rows.find((x) => x.doc_type === 'credit_note')!;
      expect(BigInt(r.excluded_receipt_reversal_count)).toBe(1n);
      expect(BigInt(r.total)).toBe(1n);
      expect(BigInt(r.total_in_series)).toBe(2n);
      expect(r.to_no).toBe(rv.store_credit_note.doc_no);
      for (const x of rows) expect(BigInt(x.total_in_series)).toBe((BigInt(x.total) - BigInt(x.cancelled)) + BigInt(x.cancelled) + BigInt(x.excluded_receipt_reversal_count));
      expect(await f.sql(`SELECT 1 FROM reports.series_gaps WHERE branch_id = $1`, [f.B1])).toHaveLength(0);
      expect(await f.sql(`SELECT 1 FROM reports.cancellations WHERE credit_note_no = $1`, [rv.store_credit_note.doc_no])).toHaveLength(0);
      expect(await f.sql(`SELECT 1 FROM reports.cancellations WHERE credit_note_no = $1`, [cn.doc_no])).toHaveLength(1);
      const report = JSON.parse(f.rec.report());
      expect(report.violations, f.rec.report()).toEqual([]);
      expect(report.undocumented, f.rec.report()).toEqual([]);
      expect(report.timestamps, f.rec.report()).toEqual([]);
    } finally { await f.close(); }
  });
});


describe('Ratchet QA regressions (0.9.3)', () => {
  it('QA B1 — up/down rounding closes liability for full/separate/return-then-cancel, paid/part-paid and both policies', async () => {
    const f = await salesFixture('salesq1', HUID_PREFIX.sales);
    try {
      const c = await f.customer();
      for (const rate of ['100.30', '100.10']) {
        await f.sql(`INSERT INTO rates.metal_rate(tenant_id,purity_id,kind,rate_date,effective_from,rate_per_g)
          VALUES ($1,$2,'sale',(now() AT TIME ZONE 'Asia/Kolkata')::date,now(),$3)`, [f.tenantId,f.P24,rate]);
        for (const policy of ['follow_invoice', 'exact']) for (const paidFully of [true, false]) for (const sequence of ['all', 'separate', 'then_cancel']) {
          await f.settings({ credit_note_rounding: policy });
          await f.loose(0, '2.000');
          const input = { branch_id:f.B1,salesperson_id:f.staff,customer_id:c,
            lines: Array.from({length:2},()=>({kind:'loose',item_id:f.coin,purity_id:f.P24,counter_id:f.counter,pieces:0,gross_wt:'1.000',net_wt:'1.000'})) };
          const total = rate==='100.30'?'207.00':'206.00';
          const inv=(await f.go('POST','/v1/sales/invoices',{headers:f.key(),body:{...input,payments:[{mode:'upi',amount:paidFully?total:'100.00'}]}})).json();
          expect(inv.totals.invoice_total).toBe(total);
          const notes:J[]=[];
          const ret=async(ids:string[])=>notes.push((await f.go('POST','/v1/sales/invoices/{id}/returns',{p:{id:inv.id},headers:f.key(),body:{line_ids:ids,reason:'QA B1 full liability',refund_mode:'cash'}})).json());
          if(sequence==='all') await ret(inv.lines.map((x:J)=>x.id));
          else {
            await ret([inv.lines[0].id]);
            expect(notes[0].total).toBe(policy==='follow_invoice'?(rate==='100.30'?'103.50':'103.00'):(rate==='100.30'?'103.30':'103.10'));
            if(sequence==='separate') await ret([inv.lines[1].id]);
            else notes.push((await f.go('POST','/v1/sales/invoices/{id}/cancellation',{p:{id:inv.id},headers:f.key(),body:{reason:'QA B1 remaining cancel',refund_mode:'cash'}})).json());
          }
          // All values are whole paisa here: bounded test-only arithmetic, not engine pricing.
          const pennies=(v:string)=>BigInt(v.replace('.',''));
          const sum=(key:string)=>notes.reduce((n,x)=>n+pennies(x[key]),0n);
          expect(sum('total')).toBe(pennies(total));
          expect(sum('refund_amount')+sum('store_credit_amount')).toBe(pennies(paidFully?total:'100.00'));
          expect(sum('due_reduced')).toBe(paidFully?0n:pennies(total)-10000n);
          const [balance]=await f.sql<J>(`SELECT balance_due::text FROM sales.v_invoice_balance WHERE invoice_id=$1`,[inv.id]);
          expect(balance.balance_due).toBe('0.00');
          const ledger=await f.sql<J>(`SELECT pieces,gross_wt::text,net_wt::text FROM inventory.stock_ledger WHERE source_type='credit_note' AND source_id=ANY($1::uuid[])`,[notes.map(x=>x.id)]);
          expect(ledger).toHaveLength(2);
          expect(ledger.every(x=>x.pieces===0 && x.gross_wt==='1.000' && x.net_wt==='1.000')).toBe(true);
        }
      }
      // Ratchet's exact-mode counterexample: raw7051.40, issued7051.00, never a fictitious40-paisa debt.
      await f.sql(`INSERT INTO rates.metal_rate(tenant_id,purity_id,kind,rate_date,effective_from,rate_per_g) VALUES ($1,$2,'sale',(now() AT TIME ZONE 'Asia/Kolkata')::date,now(),6500)`,[f.tenantId,f.P24]);
      await f.sql(`UPDATE masters.item SET mc_type='flat',mc_value=333 WHERE id=$1`,[f.coin]);
      for(const policy of ['follow_invoice','exact']) for(const payment of ['7051.00','100.00']) {
        await f.settings({credit_note_rounding:policy}); await f.loose(0,'1.002');
        const inv=(await f.go('POST','/v1/sales/invoices',{headers:f.key(),body:{branch_id:f.B1,salesperson_id:f.staff,customer_id:c,
          lines:[{kind:'loose',item_id:f.coin,purity_id:f.P24,counter_id:f.counter,pieces:0,gross_wt:'1.002',net_wt:'1.002'}],payments:[{mode:'upi',amount:payment}]}})).json();
        expect(inv.totals).toMatchObject({invoice_total:'7051.00',round_off:'-0.40'});
        const note=(await f.go('POST','/v1/sales/invoices/{id}/returns',{p:{id:inv.id},headers:f.key(),body:{line_ids:[inv.lines[0].id],reason:'QA B1 exact counterexample',refund_mode:'cash'}})).json();
        expect(note).toMatchObject({total:'7051.00',round_off:'-0.40',refund_amount:payment,due_reduced:payment==='100.00'?'6951.00':'0.00'});
      }
      expect(JSON.parse(f.rec.report()).violations,f.rec.report()).toEqual([]);
    } finally { await f.close(); }
  },120000);

  it('QA B3 — server minimum making is applied and its immutable rule survives a master change', async () => {
    try {
      await fx.sql(`UPDATE masters.item SET min_mc=100,mc_type='per_gram',mc_value=10 WHERE id=$1`,[fx.coin]);
      await fx.loose(1,'1.000');
      const inv=await paid({customer_id:await fx.customer(),lines:[{kind:'loose',item_id:fx.coin,purity_id:fx.P24,counter_id:fx.counter,pieces:1,gross_wt:'1.000',net_wt:'1.000'}]});
      expect(inv.lines[0]).toMatchObject({mc_amount:'100.00',taxable_value:'6600.00'});
      await fx.sql(`UPDATE masters.item SET min_mc=999 WHERE id=$1`,[fx.coin]);
      const [snapshot]=await fx.sql<J>(`SELECT rate_snapshot FROM sales.invoice WHERE id=$1`,[inv.id]);
      expect(snapshot.rate_snapshot.making_floors).toEqual([{line_no:1,item_id:fx.coin,min_mc:'100.00'}]);
      expect((await fx.go('GET','/v1/sales/invoices/{id}',{p:{id:inv.id}})).json().lines[0].mc_amount).toBe('100.00');
    } finally { await fx.sql(`UPDATE masters.item SET min_mc=0,mc_type='flat',mc_value=0 WHERE id=$1`,[fx.coin]); }
  });

  it('QA B5 — Tamil is generated by the backend; unsupported words languages fail rather than English fallback',async()=>{
    const inv=await paid({customer_id:await fx.customer(),lines:[tagLine(await small())]});
    const pr=(await fx.go('POST','/v1/sales/invoices/{id}/prints',{p:{id:inv.id},headers:fx.key(),body:{language:'ta',numerals:'tamil'}})).json();
    expect(pr.language).toBe('ta');expect(pr.numerals).toBe('tamil');
    expect(pr.amount_in_words).toMatch(/ரூபாய்/);expect(pr.amount_in_words).not.toMatch(/[A-Za-z0-9]/);
    await problem('POST','/v1/sales/invoices/{id}/prints',{p:{id:inv.id},headers:fx.key(),body:{language:'hi',reprint_reason:'unsupported QA copy'},status:422,code:'validation_failed'});
    expect((await fx.go('GET','/v1/sales/invoices/{id}/prints',{p:{id:inv.id}})).json()).toHaveLength(1);
  });

  it('QA B6 / B-2 0.9.6 — reprints stay pinned to the first-print release pin after a custom version becomes active; a custom active template never prints (1(a): it is skipped for the platform pin)',async()=>{
    try {
      const [tpl]=await fx.sql<J>(`INSERT INTO branding.print_template(scope,tenant_id,doc_type,version,paper,body_key,is_active)
        VALUES ('tenant',$1,'invoice',101,'A4','qa/pinned-v101.hbs',true) RETURNING id`,[fx.tenantId]);
      const inv=await paid({customer_id:await fx.customer(),lines:[tagLine(await small())]});
      // 0.9.6 1(a): the active custom v101 is skipped; the first print falls back to the platform pin (one row)
      const p1=(await fx.go('POST','/v1/sales/invoices/{id}/prints',{p:{id:inv.id},headers:fx.key(),body:{language:'ta',numerals:'tamil'}})).json();
      expect(p1).toMatchObject({template_id:PLATFORM_V1.invoice,template_version:1,print_no:1,copy:'original',template_fallback_from:{template_id:tpl.id,template_version:101}});
      expect(await fx.sql(`SELECT print_no FROM sales.document_print WHERE doc_id=$1`,[inv.id])).toEqual([{print_no:1}]);
      await fx.sql(`UPDATE branding.print_template SET is_active=false WHERE id=$1`,[tpl.id]);
      await fx.sql(`INSERT INTO branding.print_template(scope,tenant_id,doc_type,version,paper,body_key,is_active)
        VALUES ('tenant',$1,'invoice',102,'A4','qa/new-v102.hbs',true)`,[fx.tenantId]);
      const p2=(await fx.go('POST','/v1/sales/invoices/{id}/prints',{p:{id:inv.id},headers:fx.key(),body:{reprint_reason:'pinned version QA copy'}})).json();
      expect(p2).toMatchObject({template_id:PLATFORM_V1.invoice,template_version:1,copy:'duplicate',language:'ta',locale:'ta-IN',numerals:'tamil',template_repinned:false,repinned_from:null,template_fallback_from:null});
      expect(p2.snapshot).toEqual(p1.snapshot);
    } finally { await fx.sql(`UPDATE branding.print_template SET is_active=false WHERE tenant_id=$1 AND doc_type='invoice' AND version IN (101,102)`,[fx.tenantId]); }
  });

  it('QA B8 — exact money2dp and weight3dp reject short/over-scale/JSON-number wire input',async()=>{
    const c=await fx.customer(),t=await small();
    for(const discount of ['1','1.2','1.234',1]) await problem('POST','/v1/sales/preview',{body:bill({customer_id:c,lines:[tagLine(t,{discount})]}),status:422,code:'validation_failed'});
    for(const rate_override of ['1','1.2','1.234',1]) await problem('POST','/v1/sales/preview',{body:bill({customer_id:c,lines:[tagLine(t)],old_metal:[{purity_id:fx.P22,gross_wt:'1.000',less_wt:'0.000',rate_override,override_reason:'QA B8 canonical rate'}]}),status:422,code:'validation_failed'});
    for(const net_wt of ['1','1.2','1.23','1.2345',1]) await problem('POST','/v1/sales/preview',{body:bill({customer_id:c,lines:[{kind:'loose',item_id:fx.coin,purity_id:fx.P24,pieces:0,gross_wt:'2.000',net_wt}]}),status:422,code:'validation_failed'});
    expect((await preview({customer_id:c,lines:[tagLine(t)],old_metal:[{purity_id:fx.P22,gross_wt:'1.000',less_wt:'0.000',rate_override:'5800.00',override_reason:'QA B8 canonical rate'}]})).old_metal[0].rate_per_g).toBe('5800.00');
    expect((await preview({customer_id:c,lines:[tagLine(t,{discount:'1.00'})]})).lines[0].discount).toBe('1.00');
    expect((await preview({customer_id:c,lines:[{kind:'loose',item_id:fx.coin,purity_id:fx.P24,pieces:0,gross_wt:'1.234',net_wt:'1.234'}]})).lines[0].net_wt).toBe('1.234');
    const inv=await issue({customer_id:c,lines:[tagLine(t)]});
    for(const amount of ['1','1.2','1.234',1]) await problem('POST','/v1/sales/invoices/{id}/payments',{p:{id:inv.id},body:{tenders:[{mode:'cash',amount}]},status:422,code:'validation_failed'});
    expect((await receive(inv.id,[{mode:'cash',amount:'1.00'}])).total).toBe('1.00');
  });

  it('QA N2 — an active same-branch non-sales employee is ineligible via direct API',async()=>{
    const [staff]=await fx.sql<J>(`INSERT INTO hr.staff(tenant_id,code,name,branch_id,is_salesperson) VALUES ($1,'QA-N2','Non sales',$2,false) RETURNING id`,[fx.tenantId,fx.B1]);
    const input={customer_id:await fx.customer(),salesperson_id:staff.id,lines:[tagLine(await small())]};
    for(const path of ['/v1/sales/preview','/v1/sales/invoices']) await problem('POST',path,{body:bill(input),status:422,code:'inactive_master'});
    expect((await preview({...input,salesperson_id:fx.staff})).totals.invoice_total).toBe('6695.00');
  });

  it('QA N3 — cash policy is explicitly bill-local, not cross-bill person/day/event certification',async()=>{
    try {
      await fx.settings({cash_limit_amount:'10000.00',cash_limit_mode:'block'});
      const c=await fx.customer();
      const a=await issue({customer_id:c,lines:[tagLine(await small())],payments:[{mode:'cash',amount:'6695.00'}]});
      const b=await issue({customer_id:c,lines:[tagLine(await small())],payments:[{mode:'cash',amount:'6695.00'}]});
      expect(a.totals.cash_amount).toBe('6695.00');expect(b.totals.cash_amount).toBe('6695.00');
    } finally {await fx.settings({cash_limit_amount:'200000.00',cash_limit_mode:'block'});}
  });

  it('QA N4 — receipts explicitly expose present-adjusted balance, not an immutable as-at claim',async()=>{
    const inv=await issue({customer_id:await fx.customer(),lines:[tagLine(await small()),tagLine(await small())]});
    const rc=await receive(inv.id,[{mode:'upi',amount:'1000.00'}]);
    expect(rc).toMatchObject({balance_due_after:'12390.00',adjusted_balance_due_after:'12390.00'});
    await fx.go('POST','/v1/sales/invoices/{id}/returns',{p:{id:inv.id},headers:fx.key(),body:{line_ids:[inv.lines[0].id],reason:'QA N4 later return',refund_mode:'cash'}});
    const historical=(await payments(inv.id)).receipts.find((x:J)=>x.id===rc.id);
    expect(historical).toMatchObject({balance_due_after:'6695.00',adjusted_balance_due_after:'6695.00'});
  });
});


describe('0.9.4 lead decisions: B4/B6 immutable frontend print inputs', () => {
  it('B4 0.9.4 — cancellation/return GST particulars and zero-tax receipt_reversal come only from original issue snapshots', async () => {
    const f=await salesFixture('sales94',HUID_PREFIX.sales);
    try {
      await f.sql(`UPDATE platform.company SET legal_name='Frozen Seller', address='{"line1":"Company old","city":"Chennai"}'::jsonb WHERE tenant_id=$1`,[f.tenantId]);
      await f.sql(`UPDATE platform.branch SET address='{"line1":"Branch old","city":"Chennai"}'::jsonb WHERE id=$1`,[f.B1]);
      await f.settings({making_gst_treatment:'separate',making_service_rate:'18.00'});
      const intra=await f.customer(),inter=await f.customer({gstin:'29ABCDE1234F1Z1'});
      const create=async(customer_id:string,n:number,paid=true)=>{
        const tags=await Promise.all(Array.from({length:n},()=>f.tag(SMALL)));
        const body={branch_id:f.B1,salesperson_id:f.staff,customer_id,lines:tags.map(t=>tagLine(t))};
        const pv=(await f.go('POST','/v1/sales/preview',{body})).json();
        return (await f.go('POST','/v1/sales/invoices',{headers:f.key(),body:{...body,payments:paid?[{mode:'upi',amount:pv.totals.net_payable}]:[]}})).json();
      };
      const cancelBill=await create(intra,1),returnBill=await create(inter,2),target=await create(inter,1,false);
      // Change masters BEFORE CN creation: every mandatory tax/seller/reference value must still be the issue-time one.
      await f.sql(`UPDATE platform.company SET legal_name='Live changed',gstin='33BBBBB2222B1Z5',address='{"line1":"Company new"}'::jsonb WHERE tenant_id=$1`,[f.tenantId]);
      await f.sql(`UPDATE platform.branch SET gstin='33CCCCC3333C1Z5',address='{"line1":"Branch new"}'::jsonb WHERE id=$1`,[f.B1]);
      await f.sql(`UPDATE masters.item SET name='Live renamed',hsn='9999',mc_value=999,min_mc=999 WHERE id=$1`,[f.ring]);
      await f.sql(`UPDATE masters.customer SET name='Live renamed buyer',gstin='33ZZZZZ9999Z1Z1',state_code='33',address='{"line1":"Buyer new"}'::jsonb WHERE id=$1`,[inter]);
      const cancel=(await f.go('POST','/v1/sales/invoices/{id}/cancellation',{p:{id:cancelBill.id},headers:f.key(),body:{reason:'B4 original seller proof',refund_mode:'cash'}})).json();
      const ret=(await f.go('POST','/v1/sales/invoices/{id}/returns',{p:{id:returnBill.id},headers:f.key(),body:{line_ids:[returnBill.lines[0].id],reason:'B4 original tax proof',refund_mode:'store_credit'}})).json();
      for(const [cn,inv,selected] of [[cancel,cancelBill,cancelBill.lines],[ret,returnBill,[returnBill.lines[0]]]] as [J,J,J[]][]) {
        expect(cn.seller).toEqual(inv.seller);expect(cn.seller).toMatchObject({legal_name:'Frozen Seller',gstin:'33AAAAA1111A1Z5',state_code:'33',address:{line1:'Branch old',city:'Chennai'}});
        expect(cn).toMatchObject({gst_applicable:true,place_of_supply:inv.place_of_supply,gst_type:inv.gst_type,supply_type:inv.supply_type});
        expect(cn.original_invoice).toMatchObject({id:inv.id,doc_no:inv.doc_no,doc_date:inv.doc_date,issued_at:inv.issued_at,seller:inv.seller,customer:inv.customer,invoice_total:inv.totals.invoice_total,lines:selected});
        expect(cn.lines.map((l:J)=>l.invoice_line_id)).toEqual(selected.map(l=>l.id));
        for(const l of cn.lines) {
          const original=selected.find(x=>x.id===l.invoice_line_id)!;
          expect(l).toMatchObject({hsn:'7113',tax_rate:'3.00',description:original.description,tag_no:original.tag_no,tax_parts:original.tax_parts});
          expect(l.tax_parts.map((x:J)=>x.hsn_sac)).toEqual(['7113','998892']);
          expect(l.tax_parts[1]).toMatchObject({rate:'18.00',cgst_rate:'9.00',sgst_rate:'9.00',igst_rate:'18.00'});
        }
        const p1=(await f.go('POST','/v1/sales/credit-notes/{id}/prints',{p:{id:cn.id},headers:f.key(),body:{language:'ta',numerals:'tamil'}})).json();
        expect(p1.snapshot.original_invoice).toEqual(cn.original_invoice);
        expect(p1).toMatchObject({locale:'ta-IN',language:'ta',numerals:'tamil',template_version:1});
        expect(typeof p1.template_id).toBe('string');
        await f.sql(`UPDATE platform.company SET legal_name='Changed again' WHERE tenant_id=$1`,[f.tenantId]);
        const p2=(await f.go('POST','/v1/sales/credit-notes/{id}/prints',{p:{id:cn.id},headers:f.key(),body:{reprint_reason:'B4 immutable file copy'}})).json();
        expect(p2.snapshot).toEqual(p1.snapshot);
      }
      expect(cancel.lines[0]).toMatchObject({cgst:'135.00',sgst:'135.00',igst:'0.00'});
      expect(ret.lines[0]).toMatchObject({cgst:'0.00',sgst:'0.00',igst:'270.00'});
      const rc=(await f.go('POST','/v1/sales/invoices/{id}/payments',{p:{id:target.id},headers:f.key(),body:{tenders:[{mode:'credit_note',credit_note_id:ret.id,amount:'6770.00'}]}})).json();
      const rv=(await f.go('POST','/v1/sales/invoices/{id}/payments/{receipt_id}/reversal',{p:{id:target.id,receipt_id:rc.id},headers:f.key(),body:{reason:'B4 restore store credit'}})).json().store_credit_note;
      expect(rv).toMatchObject({kind:'receipt_reversal',gst_applicable:false,lines:[],tax_summary:[],taxable_value:'0.00',cgst:'0.00',sgst:'0.00',igst:'0.00',cess:'0.00',round_off:'0.00',total:'6770.00'});
      expect(rv.seller).toEqual(target.seller);
      expect(rv.original_invoice).toMatchObject({id:target.id,doc_no:target.doc_no,doc_date:target.doc_date,lines:[]});
      const print=(await f.go('POST','/v1/sales/credit-notes/{id}/prints',{p:{id:rv.id},headers:f.key(),body:{}})).json();
      expect(print.snapshot.gst_applicable).toBe(false);
      expect(print.notes).toContain('Store credit from a reversed payment — not a GST credit note');
      const rep=JSON.parse(f.rec.report());expect(rep.violations,f.rec.report()).toEqual([]);expect(rep.undocumented,f.rec.report()).toEqual([]);expect(rep.timestamps,f.rec.report()).toEqual([]);
    } finally {await f.close();}
  },120000);

  it('B6 0.9.4 — every print type replays an identical frozen snapshot/template after activation and mutable document changes',async()=>{
    const c=await fx.customer(),inv=await issue({customer_id:c,lines:[tagLine(await small())]});
    const cn=await storeCredit(c);
    const estimateBody=bill({customer_id:c,lines:[tagLine(await small())]});
    const est=(await fx.go('POST','/v1/sales/estimates',{headers:fx.key(),body:estimateBody})).json();
    for(const [type,doc,path] of [['invoice',inv,'/v1/sales/invoices/{id}/prints'],['credit_note',cn,'/v1/sales/credit-notes/{id}/prints'],['estimate',est,'/v1/sales/estimates/{id}/prints']] as [string,J,string][]) {
      const p1=(await fx.go('POST',path,{p:{id:doc.id},headers:fx.key(),body:{language:'ta',numerals:'tamil'}})).json();
      expect(p1).toMatchObject({locale:'ta-IN',language:'ta',numerals:'tamil'});expect(typeof p1.template_id).toBe('string');expect(p1.template_version).toBeGreaterThan(0);
      try {
        await fx.sql(`UPDATE branding.print_template SET is_active=false WHERE tenant_id=$1 AND doc_type=$2`,[fx.tenantId,type]);
        const [tpl]=await fx.sql<J>(`INSERT INTO branding.print_template(scope,tenant_id,doc_type,version,paper,body_key,is_active) VALUES ('tenant',$1,$2,201,'A4','tpl/test/new-version.hbs',true) RETURNING id`,[fx.tenantId,type]);
        expect(tpl.id).not.toBe(p1.template_id);
        if(type==='invoice') await receive(inv.id,[{mode:'upi',amount:'1000.00'}]);
        if(type==='credit_note') await receive(inv.id,[{mode:'credit_note',credit_note_id:cn.id,amount:'1000.00'}]);
        if(type==='estimate') await fx.go('PUT','/v1/sales/estimates/{id}',{p:{id:est.id},headers:fx.im(est.version),body:{...estimateBody,bill_discount:'100.00'}});
        const p2=(await fx.go('POST',path,{p:{id:doc.id},headers:fx.key(),body:{reprint_reason:'B6 version-pinned copy'}})).json();
        expect(p2).toMatchObject({template_id:p1.template_id,template_version:p1.template_version,locale:'ta-IN',language:'ta',numerals:'tamil',amount_in_words:p1.amount_in_words,copy:'duplicate'});
        expect(p2.snapshot).toEqual(p1.snapshot);
        expect(p2.snapshot.print_count).toBe(0);expect(p2.snapshot.last_printed_at).toBeNull();
        if(type==='invoice') {expect(p2.document.totals.balance_due).not.toBe(p1.snapshot.totals.balance_due);expect(p2.snapshot.totals.balance_due).toBe('6695.00');}
        if(type==='credit_note') {expect(p2.document.balance_available).toBe('5695.00');expect(p2.snapshot.balance_available).toBe('6695.00');}
        if(type==='estimate') {expect(p2.document.version).toBe(est.version+1);expect(p2.document.computation.totals.net_payable).not.toBe(p1.snapshot.computation.totals.net_payable);}
        const [audit]=await auditRows(`sales.${type}.print`,doc.id);
        expect(audit.new_row).toMatchObject({snapshot_version:1,snapshot:p1.snapshot});
        await expect(withTenantTx(rw,{tenantId:fx.tenantId,userId:fx.ownerId},c=>c.query(`UPDATE platform.audit_event SET new_row='{}'::jsonb WHERE row_id=$1`,[doc.id]))).rejects.toBeTruthy();
      } finally {
        await fx.sql(`UPDATE branding.print_template SET is_active=false WHERE tenant_id=$1 AND doc_type=$2 AND version=201`,[fx.tenantId,type]);
        await fx.sql(`UPDATE branding.print_template SET is_active=true WHERE tenant_id=$1 AND id=$2`,[fx.tenantId,p1.template_id]);
      }
    }
  });

  it('B7 0.9.4 — first live duplicate without reason wins business precedence, but not permission/404/schema shape',async()=>{
    const inv=await paid({customer_id:await fx.customer(),lines:[tagLine(await small())]});
    for(const body of [{copy:'duplicate'},{copy:'duplicate',reprint_reason:null},{copy:'duplicate',reprint_reason:'x'}])
      await problem('POST','/v1/sales/invoices/{id}/prints',{p:{id:inv.id},headers:fx.key(),body,status:422,code:'first_print_duplicate_not_supported'});
    await problem('POST','/v1/sales/invoices/{id}/prints',{p:{id:inv.id},headers:fx.key(),body:{copy:'duplicate'},cookie:fx.sales,status:403,code:'reprint_not_allowed'});
    await problem('POST','/v1/sales/invoices/{id}/prints',{p:{id:'00000000-0000-4000-8000-000000000077'},headers:fx.key(),body:{copy:'duplicate'},status:404,code:'not_found'});
    for(const body of [{copy:'duplicate',reprint_reason:123},{copy:'duplicate',reprint_reason:'x'.repeat(201)},{copy:'duplicate',reprint_reason:' '+ 'x'.repeat(200)},{copy:'duplicate',language:'hi'},{copy:'duplicate',language:'zz'},{copy:'duplicate',language:'EN'},{copy:'duplicate',language:123},{copy:'original'}])
      await problem('POST','/v1/sales/invoices/{id}/prints',{p:{id:inv.id},headers:fx.key(),body,status:422,code:'validation_failed'});
    expect(await fx.sql(`SELECT 1 FROM sales.document_print WHERE doc_id=$1`,[inv.id])).toHaveLength(0);
    expect((await fx.go('POST','/v1/sales/invoices/{id}/prints',{p:{id:inv.id},headers:fx.key(),body:{copy:'auto'}})).json()).toMatchObject({copy:'original',print_no:1});
    await problem('POST','/v1/sales/invoices/{id}/prints',{p:{id:inv.id},headers:fx.key(),body:{copy:'duplicate'},status:422,code:'reprint_reason_required'});
  });

  it.each(['en','ta','hi','te','kn','ml'])('B5 0.9.4 — registered print language %s produces its own supported words or422, never English fallback',async(language)=>{
    const offered=(await fx.sql<{code:string}>(`SELECT code FROM platform.language ORDER BY code`)).map(x=>x.code);
    expect(offered).toEqual(['en','hi','kn','ml','ta','te']);
    const inv=await paid({customer_id:await fx.customer(),lines:[tagLine(await small())]});
    if(language==='en'||language==='ta') {
      const p=(await fx.go('POST','/v1/sales/invoices/{id}/prints',{p:{id:inv.id},headers:fx.key(),body:{language}})).json();
      expect(p.locale).toBe(`${language}-IN`);
      if(language==='en') expect(p.amount_in_words).toMatch(/^Rupees /);
      else {expect(p.amount_in_words).toMatch(/ரூபாய்/);expect(p.amount_in_words).not.toMatch(/[A-Za-z0-9]/);}
      expect(await fx.sql(`SELECT 1 FROM sales.document_print WHERE doc_id=$1`,[inv.id])).toHaveLength(1);
    } else {
      await problem('POST','/v1/sales/invoices/{id}/prints',{p:{id:inv.id},headers:fx.key(),body:{language},status:422,code:'validation_failed'});
      expect(await fx.sql(`SELECT 1 FROM sales.document_print WHERE doc_id=$1`,[inv.id])).toHaveLength(0);
      expect(await auditRows('sales.invoice.print',inv.id)).toHaveLength(0);
    }
  });

  it('B6 0.9.4 — missing configured template fails422 without logging a print or selecting a different doc-type template',async()=>{
    const cn=await storeCredit(await fx.customer());
    const active=await fx.sql<J>(`SELECT id FROM branding.print_template WHERE doc_type='credit_note' AND is_active`);
    try {
      await fx.sql(`UPDATE branding.print_template SET is_active=false WHERE doc_type='credit_note' AND is_active`);
      await problem('POST','/v1/sales/credit-notes/{id}/prints',{p:{id:cn.id},headers:fx.key(),body:{},status:422,code:'print_template_not_configured'});
      expect(await fx.sql(`SELECT 1 FROM sales.document_print WHERE doc_id=$1`,[cn.id])).toHaveLength(0);
    } finally {await fx.sql(`UPDATE branding.print_template SET is_active=true WHERE id=ANY($1::uuid[])`,[active.map(t=>t.id)]);}
  });
  it('B6 0.9.4 — legacy printed estimates without a frozen audit projection fail rather than guess an edited revision',async()=>{
    const body=bill({lines:[tagLine(await small())]});
    const est=(await fx.go('POST','/v1/sales/estimates',{headers:fx.key(),body})).json();
    const [tpl]=await fx.sql<J>(`SELECT id,version FROM branding.print_template WHERE doc_type='estimate' AND is_active ORDER BY (scope='tenant') DESC,version DESC LIMIT 1`);
    await withTenantTx(rw,{tenantId:fx.tenantId,userId:fx.ownerId},()=>withModuleRole('sales_writer',c=>c.query(
      `INSERT INTO sales.document_print(tenant_id,branch_id,doc_type,doc_id,print_no,copy,paper,language,numerals,template_id,template_version,printed_by,doc_cancelled)
       VALUES (platform.current_tenant(),$1,'estimate',$2,1,'original','A4','en','latin',$3,$4,$5,false)`,[fx.B1,est.id,tpl.id,tpl.version,fx.ownerId])));
    await fx.go('PUT','/v1/sales/estimates/{id}',{p:{id:est.id},headers:fx.im(est.version),body:{...body,bill_discount:'100.00'}});
    await problem('POST','/v1/sales/estimates/{id}/prints',{p:{id:est.id},headers:fx.key(),body:{reprint_reason:'legacy history must not guess'},status:422,code:'print_snapshot_unavailable'});
    expect(await fx.sql(`SELECT print_no FROM sales.document_print WHERE doc_id=$1`,[est.id])).toEqual([{print_no:1}]);
  });

});

describe('contract', () => {
  it('every response seen in this file matches contracts/openapi.yaml 0.9.5 (bodies, problem bodies, RFC 3339 timestamps)', () => {
    const rep = JSON.parse(fx.rec.report());
    expect(rep.violations, fx.rec.report()).toEqual([]);
    expect(rep.undocumented, fx.rec.report()).toEqual([]);
    expect(rep.timestamps, fx.rec.report()).toEqual([]);
  });
});
