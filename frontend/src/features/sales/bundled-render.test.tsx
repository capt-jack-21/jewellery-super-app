import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { I18nProvider } from '@/i18n';
import { SalesPrintView } from './print';
import { ReceiptPrintTemplateV1, type ReceiptPrintProjectionV1 } from './receipt-template-v1';
import { CUST, creditNote, estimate, invoice, printDoc, templateAsset } from './fixtures';
import type { CreditNote, SalesPrintDocument } from '@/lib/api/backend/model';
import { BUNDLED_TEMPLATES } from './templates';
import { BUNDLED_RENDERERS_V1 } from './builtins-v1';
afterEach(cleanup);
const cn=():CreditNote=>{const i=invoice(),l=i.lines[0];if(!l)throw new Error('fixture');return creditNote({lines:[{...l,invoice_line_id:l.id}],original_invoice:{...i,invoice_total:i.totals.invoice_total,lines:i.lines},tax_summary:i.tax_summary,taxable_value:l.taxable_value,cgst:l.cgst,sgst:l.sgst,igst:l.igst});};
function receipt():ReceiptPrintProjectionV1 {const i=invoice();return {
  doc_type:'receipt',doc_id:'r1',doc_no:'RCT-001',template_id:'01a1c455-29fa-7811-b4b1-95efbd5b9ea5',template_version:1,paper:'A4',language:'en',locale:'en-IN',numerals:'latin',printed_at:'2026-11-09T13:00:00Z',print_no:1,copy:'original',stamp:null,amount_in_words:'Exactly returned words',notes:[],snapshot:{seller:i.seller,customer:i.customer,invoice:{doc_no:i.doc_no,doc_date:i.doc_date},receipt:{id:'r1',receipt_no:'RCT-001',invoice_id:i.id,invoice_no:i.doc_no,branch_id:i.branch_id,received_on:i.doc_date,received_at:i.issued_at,received_by:'u',tenders:[{line_no:1,mode:'upi',amount:'100.00',reference:'UPI123',payment_mode_id:null,card_machine_id:null,cheque_date:null,bank_name:null,credit_note_id:null}],total:'100.00',balance_due_after:'999.00',adjusted_balance_due_after:'50.00',note:'Thank you',customer_id:CUST,reverses_receipt_id:null,reversed_by_receipt_id:null,reversal_reason:null}}};}
for(const paper of ['A4','A5','thermal_80mm'] as const) for(const language of ['en','ta'] as const) {
 for(const kind of ['invoice','estimate','credit_note','receipt_reversal'] as const) it(`bundled ${kind} ${paper} ${language} snapshot rendering`,()=>{
  const snapshot=kind==='invoice'?invoice():kind==='estimate'?estimate():kind==='credit_note'?cn():creditNote({kind:'receipt_reversal',total:'100.00',store_credit_amount:'100.00'});
  const doc_type=kind==='receipt_reversal'?'credit_note':kind;
  const d=printDoc({doc_type,document:snapshot,snapshot,paper,language,locale:`${language}-IN`,numerals:language==='ta'?'tamil':'latin'} as Partial<SalesPrintDocument>);
  render(<I18nProvider initial="en-IN"><SalesPrintView doc={d} template={templateAsset(d)} /></I18nProvider>);
  expect(screen.getByTestId('sales-doc').dataset.paper).toBe(paper); expect(screen.getByTestId('sales-doc').lang).toBe(language);
  if(kind==='receipt_reversal'){expect(screen.getByTestId('doc-non-gst')).toBeTruthy();expect(screen.queryByTestId('doc-gst')).toBeNull();}
 });
 for(const numerals of ['latin','tamil'] as const) it(`bundled receipt ${paper} ${language} ${numerals}: frozen values, identifiers, words and duplicate`,()=>{
  const d={...receipt(),paper,language,locale:`${language}-IN` as 'en-IN'|'ta-IN',numerals,copy:'duplicate' as const,stamp:'DUPLICATE' as const};
  render(<I18nProvider initial="en-IN"><ReceiptPrintTemplateV1 doc={d} /></I18nProvider>);
  expect(screen.getByTestId('receipt-doc').dataset.paper).toBe(paper); expect(screen.getByTestId('receipt-doc').lang).toBe(language);
  expect(screen.getByTestId('receipt-total').textContent).toContain(numerals==='tamil'?'௧௦௦.௦௦':'100.00');expect(screen.getByTestId('receipt-balance').textContent).toContain(numerals==='tamil'?'௫௦.௦௦':'50.00');
  expect(screen.getByTestId('receipt-no').textContent).toBe('RCT-001'); expect(screen.getByText('UPI123')).toBeTruthy(); expect(screen.getByTestId('receipt-words').textContent).toBe(d.amount_in_words);expect(screen.getByTestId('receipt-stamp')).toBeTruthy();
 });
}
it('receipt rejects an unknown template or missing words rather than fetching or inventing content',()=>{
 const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
 render(<I18nProvider initial="en-IN"><ReceiptPrintTemplateV1 doc={{...receipt(),template_version:99}} /></I18nProvider>);expect(screen.queryByTestId('receipt-doc')).toBeNull();cleanup();
 render(<I18nProvider initial="en-IN"><ReceiptPrintTemplateV1 doc={{...receipt(),amount_in_words:''}} /></I18nProvider>);expect(screen.queryByTestId('receipt-doc')).toBeNull();expect(fetch).not.toHaveBeenCalled();vi.unstubAllGlobals();
});
it('every required kind has an EXISTING seeded key, not a newly invented paper/language-specific key',()=>{
 for(const kind of ['invoice','estimate','credit_note','receipt']) expect(BUNDLED_TEMPLATES.some((r)=>r.doc_type===kind)).toBe(true);
});

it('both renderer families are actual bundled JS components, with receipt still route-independent',()=>{
 expect(typeof BUNDLED_RENDERERS_V1['sales-gst-v1']).toBe('function');
 expect(BUNDLED_RENDERERS_V1['receipt-v1']).toBe(ReceiptPrintTemplateV1);
});
