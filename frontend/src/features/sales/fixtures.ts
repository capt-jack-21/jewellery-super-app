/** Test fixtures in 0.9.4 shapes (shared by the Sales unit and UI tests). */
import type { SalesTemplateAsset } from './templates';
import type { PrintTemplate, BillComputation, CreditNote, CustomerSnapshot, Estimate, Invoice, PricedLine, PricedOldGold, SalesPrintDocument, SalesSettings } from '@/lib/api/backend/model';

export const BR = '00000000-0000-4000-8000-0000000000b1';
export const SP = '00000000-0000-4000-8000-0000000000a1';
export const CUST = '00000000-0000-4000-8000-0000000000c1';

export function pricedLine(over: Partial<PricedLine> = {}): PricedLine {
  return {
    line_no: 1, kind: 'tag', tag_id: 'tag-1', tag_no: 'RSP-01', item_id: 'item-1', sub_item_id: null, purity_id: 'p22', description: 'Ring', purity_code: '22K',
    fineness: '916', hsn: '7113', huid: 'AB12CD', pieces: 1, gross_wt: '10.000', stone_wt: '0.000', net_wt: '10.000', wastage_pct: '0', wastage_wt: '0.000',
    chargeable_wt: '10.000', rate_id: 'r1', rate_per_g: '7000.00', metal_value: '70000.00', mc_type: 'per_gram', mc_value: '450', mc_amount: '4500.00',
    stone_amount: '0.00', hallmark_charge: '0.00', gross_value: '74500.00', discount: '0.00', bill_discount_share: '0.00', taxable_value: '74500.00',
    tax_rate: '3', cgst: '1117.50', sgst: '1117.50', igst: '0.00', cess: '0.00', line_total: '76735.00',
    tax_parts: [{ component: 'metal', tax_rule_id: 'tr', hsn_sac: '7113', composite_supply: true, taxable_value: '74500.00', rate: '3', cgst_rate: '1.5', sgst_rate: '1.5', igst_rate: '0', cess_rate: '0', cgst: '1117.50', sgst: '1117.50', igst: '0.00', cess: '0.00' }],
    stones: [], counter_id: null, tray_id: null, ...over,
  } as PricedLine;
}

export function oldGold(over: Partial<PricedOldGold> = {}): PricedOldGold {
  return {
    line_no: 1, purity_id: 'p22', purity_code: '22K', description: 'Old chain', gross_wt: '5.000', less_wt: '0.000', net_wt: '5.000', touch_pct: '91.6', fine_wt: '4.580',
    valuation_basis: 'net', rate_id: 'r2', server_rate: '6500.00', rate_per_g: '6400.00', overridden: true, override_reason: 'Heavy solder', amount: '32000.00', ...over,
  } as PricedOldGold;
}

export function computation(over: Partial<BillComputation> = {}): BillComputation {
  return {
    branch_id: BR, supply_type: 'b2c', gst_type: 'intra', place_of_supply: '33',
    seller: { company_id: 'co', legal_name: 'Sri Lakshmi Jewellers', gstin: '33AAAAA0000A1Z5', state_code: '33', address: { line1: '10 Test Road', city: 'Chennai', pincode: '600001' } },
    customer: { customer_id: CUST, name: 'Lakshmi', phone: '9840000001', gstin: null, state_code: '33', address: null, pan_on_file: false, pan_last4: null },
    making_gst_treatment: 'composite', zero_gst: false, rates_used: [], lines: [pricedLine()], old_metal: [],
    tax_summary: [{ hsn_sac: '7113', rate: '3', taxable_value: '74500.00', cgst: '1117.50', sgst: '1117.50', igst: '0.00', cess: '0.00' }],
    totals: {
      gross_value: '74500.00', line_discount: '0.00', bill_discount: '0.00', taxable_value: '74500.00', cgst: '1117.50', sgst: '1117.50', igst: '0.00', cess: '0.00',
      tax_total: '2235.00', round_off: '0.00', invoice_total: '76735.00', old_metal_value: '0.00', old_gold_excess: '0.00', net_payable: '76735.00',
      paid_amount: '0.00', balance_due: '76735.00', cash_amount: '0.00',
    },
    requirements: {
      pan_required: false, pan_on_file: false, cash_limit: { limit: '200000.00', mode: 'block', cash_amount: '0.00', exceeded: false },
      discount_permission: false, override_min_permission: false, zero_gst_permission: false, credit_sale_permission: false, old_gold_rate_override_permission: false,
    },
    warnings: [], computed_at: '2026-11-09T13:00:00Z', ...over,
  } as BillComputation;
}

export function invoice(over: Partial<Invoice> = {}): Invoice {
  const c = computation();
  return {
    id: 'inv-1', doc_no: 'INV-MAIN-2026-00001', doc_seq: 1, fy: '2026-27', doc_date: '2026-11-09', issued_at: '2026-11-09T13:16:00Z', status: 'issued',
    branch_id: BR, supply_type: 'b2c', gst_type: 'intra', place_of_supply: '33', seller: c.seller, customer: c.customer as CustomerSnapshot, salesperson_id: SP, cash_counter_id: null,
    making_gst_treatment: 'composite', zero_gst: false, zero_gst_reason: null, rates_used: [],
    lines: [{ ...pricedLine(), id: 'line-1', credit_note_id: null }, { ...pricedLine({ line_no: 2, tag_id: 'tag-2', tag_no: 'RSP-02', description: 'Chain' }), id: 'line-2', credit_note_id: 'cn-0' }],
    old_metal: [], old_gold_excess_payout: null, tax_summary: c.tax_summary,
    totals: { ...c.totals, paid_amount: '50000.00', balance_due: '26735.00' }, payments: [], payment_status: 'part_paid', estimate_ids: [], credit_note_ids: [],
    cancelled_at: null, cancel_credit_note_id: null, print_count: 0, last_printed_at: null, warnings: [], created_by: 'u', ...over,
  } as Invoice;
}

export function printDoc(over: Partial<SalesPrintDocument> = {}): SalesPrintDocument {
  return {
    doc_type: 'invoice', doc_id: over.snapshot?.id ?? over.document?.id ?? 'inv-1', doc_no: over.document ? ('doc_no' in over.document ? over.document.doc_no : 'receipt_no' in over.document ? over.document.receipt_no : over.document.estimate_no) : 'INV-MAIN-2026-00001', copy: 'original', doc_cancelled: false, stamp: over.doc_cancelled ? 'CANCELLED' : over.copy === 'duplicate' ? 'DUPLICATE' : over.doc_type === 'estimate' ? 'ESTIMATE' : null, print_no: 1, printed_at: '2026-11-09T13:20:00Z', printed_by: 'u',
    paper: 'A4', language: 'en', locale: over.language === 'ta' ? 'ta-IN' : 'en-IN', numerals: 'latin', template_id: '00000000-0000-4000-8000-000000000901', template_version: 1, template_repinned: false, repinned_from: null, template_fallback_from: null, amount_in_words: 'Rupees Seventy Six Thousand Seven Hundred Thirty Five Only',
    notes: [], snapshot: over.document ?? invoice(), document: invoice(), ...over,
  } as SalesPrintDocument;
}

export function creditNote(over: Partial<CreditNote> = {}): CreditNote {
  const inv = invoice();
  return {
    id: 'cn-1', doc_no: 'CN-MAIN-2026-00001', doc_seq: 1, fy: '2026-27', doc_date: '2026-11-09', issued_at: '2026-11-09T14:00:00Z', branch_id: BR, invoice_id: 'inv-1',
    invoice_no: 'INV-MAIN-2026-00001', seller: inv.seller, place_of_supply: inv.place_of_supply, gst_type: inv.gst_type, supply_type: inv.supply_type, gst_applicable: over.kind !== 'receipt_reversal', original_invoice: { ...inv, invoice_total: inv.totals.invoice_total, lines: [] }, tax_summary: [], kind: 'sales_return', reason: 'Size issue', lines: [], taxable_value: '0.00', cgst: '0.00', sgst: '0.00', igst: '0.00', cess: '0.00',
    round_off: '0.00', total: '76735.00', refund_mode: 'store_credit', refund_amount: '0.00', due_reduced: '0.00', store_credit_amount: '76735.00', balance_available: '76735.00',
    customer: computation().customer as CustomerSnapshot, created_by: 'u', print_count: 0, last_printed_at: null, reversal_receipt_id: null, ...over,
  } as CreditNote;
}

export const settings = (over: Partial<SalesSettings> = {}): SalesSettings => ({
  version: 0, old_gold_enabled: true, estimate_no_format: 'EST-{BRANCH}-{FY}-{SEQ:5}', receipt_no_format: 'RCT-{BRANCH}-{FY}-{SEQ:5}',
  making_gst_treatment: 'composite', making_tax_rule_code: 'GST_JEWELLERY', making_service_rate: null, old_gold_valuation_basis: 'stated_purity', old_gold_excess_handling: 'refund_on_bill',
  return_window_days: 7, return_settlement_default: 'store_credit', credit_note_rounding: 'follow_invoice', round_off_to: '1.00', pan_required_above: '200000.00',
  cash_limit_amount: '200000.00', cash_limit_mode: 'block', discount_max_pct: '10', large_discount_pct: '5', default_paper: 'A4', print_language: 'en', print_numerals: 'latin',
  zero_gst_print_note: '', estimate_validity_days: 1, ...over,
} as SalesSettings);

export function estimate(over: Partial<Estimate> = {}): Estimate {
  return { id: 'est-1', estimate_no: 'EST-MAIN-2026-00001', branch_id: BR, estimate_date: '2026-11-09', valid_until: '2026-11-09T18:29:59Z', status: 'draft',
    customer_id: null, salesperson_id: null, request: { branch_id: BR, lines: [{ kind: 'tag', tag_id: 'tag-1' }], customer_id: null, salesperson_id: null }, computation: computation(),
    invoice_id: null, notes: null, created_by: 'u', created_at: '2026-11-09T13:00:00Z', version: 1, print_count: 2, last_printed_at: '2026-11-09T13:00:00Z', ...over };
}

/** Unit-only published compiled assets, never seeded into a shop or the production archive. */
export const templateAsset = (d = printDoc(), over: Partial<SalesTemplateAsset> = {}): SalesTemplateAsset => ({
  template_id: d.template_id, template_version: d.template_version, doc_type: d.doc_type, body_key: d.doc_type === 'credit_note' ? 'tpl/platform/credit_note.hbs' : `tpl/platform/${d.doc_type}.hbs`,
  renderer: 'sales-gst-v1', layout: 'standard', heading_text: '', footer_text: '', ...over,
});
export const templateRow = (d = printDoc(), active = false): PrintTemplate => ({
  id: d.template_id, version: d.template_version, doc_type: d.doc_type === 'payment_receipt' ? 'receipt' : d.doc_type, paper: d.paper,
  body_key: templateAsset(d).body_key, scope: 'tenant', read_only: false, row_version: 9, is_active: active, renderable: false, created_at: '2026-11-09T13:00:00Z',
});
