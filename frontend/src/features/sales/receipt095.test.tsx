import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { I18nProvider } from '@/i18n';
import en from '@/i18n/messages/en-IN.json';
import ta from '@/i18n/messages/ta-IN.json';
import { sessionQueryOptions } from '@/lib/session';
import type { PaymentReceipt, PaymentReceiptPrintSnapshot, SalesPrintDocument } from '@/lib/api/backend/model';
import { invoice, printDoc, settings } from './fixtures';
import { PrintPanel, SalesPrintView, printer } from './print';
import { Receipts } from './invoice-page';
import { resolveSalesTemplate } from './templates';
import { salesPrintDataError095 } from './receipt095-v1';
const pin='01a1c455-29fa-7811-b4b1-95efbd5b9ea5';
function receiptDoc(over:Partial<SalesPrintDocument>={}):SalesPrintDocument {
 const inv=invoice();const snapshot:PaymentReceiptPrintSnapshot={id:'r1',receipt_no:'RCT-001',invoice_id:inv.id,invoice_no:inv.doc_no,invoice_date:inv.doc_date,branch_id:inv.branch_id,customer_id:inv.customer.customer_id ?? 'customer-1',customer:{...inv.customer,name:'Frozen customer'},seller:{...inv.seller,legal_name:'Frozen seller'},received_on:inv.doc_date,received_at:'2026-11-10T03:00:00Z',received_by:'u',tenders:[{line_no:1,mode:'upi',amount:'100.00',reference:'UPI123',payment_mode_id:null,card_machine_id:null,cheque_date:null,bank_name:null,credit_note_id:null}],total:'100.00',adjusted_balance_due_at_issue:'50.00',note:'Frozen note',reverses_receipt_id:null,reversal_reason:null,kind:'collection'};
 const document:PaymentReceipt={...snapshot,balance_due_after:'9999.00',adjusted_balance_due_after:'9999.00',reversed_by_receipt_id:null};
 return {...printDoc(),doc_type:'payment_receipt',doc_id:snapshot.id,doc_no:snapshot.receipt_no,template_id:pin,template_version:1,copy:'original',doc_cancelled:false,stamp:null,print_no:1,amount_in_words:'Exact backend words',snapshot,document,...over};
}
const calls:{url:string;body:Record<string,unknown>;headers:Headers}[]=[];
let response=receiptDoc();
function mount(node:ReactNode,locale:'en-IN'|'ta-IN'='en-IN',permissions=['sales.invoice.view','sales.invoice.reprint']){
 const qc=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});qc.setQueryData(sessionQueryOptions.queryKey,{user:{id:'u',name:'Owner',version:1},roles:[{role:'owner'}],permissions});
 return render(<QueryClientProvider client={qc}><I18nProvider initial={locale}>{node}</I18nProvider></QueryClientProvider>);
}
beforeEach(()=>{response=receiptDoc();calls.length=0;vi.spyOn(printer,'prepare').mockResolvedValue(undefined);vi.spyOn(printer,'print').mockImplementation(()=>undefined);
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{calls.push({url:String(input),body:JSON.parse(String(init?.body??'{}')),headers:new Headers(init?.headers)});return new Response(JSON.stringify(response),{status:200,headers:{'content-type':'application/json'}});}));});
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();});
for(const paper of ['A4','A5','thermal_80mm'] as const)for(const language of ['en','ta'] as const)for(const numerals of ['latin','tamil'] as const)it(`receipt final snapshot ${paper}/${language}/${numerals} ignores current due and uses exact words`,async()=>{
 const doc=receiptDoc({paper,language,locale:`${language}-IN`,numerals});const template=await resolveSalesTemplate(doc);
 mount(<SalesPrintView doc={doc} template={template}/>,language==='en'?'ta-IN':'en-IN');
 const root=screen.getByTestId('receipt-doc');expect(root.dataset.paper).toBe(paper);expect(root.dataset.templateId).toBe(pin);expect(root.dataset.templateVersion).toBe('1');expect(root.lang).toBe(language);
 expect(root.textContent).toContain('Frozen seller');expect(root.textContent).toContain('Frozen customer');expect(root.textContent).not.toContain('9999');
 expect(screen.getByTestId('receipt-balance').textContent).toContain(numerals==='tamil'?'௫௦.௦௦':'50.00');expect(screen.getByTestId('receipt-balance').textContent).toContain((language==='en'?en:ta)['sales.print.receiptBalanceAtIssue'].split('{amount}')[0]);
 expect(screen.getByTestId('receipt-no').textContent).toBe('RCT-001');expect(screen.getByText('UPI123')).toBeTruthy();expect(screen.getByTestId('receipt-words').textContent).toBe(doc.amount_in_words);expect(calls).toHaveLength(0);
});
for(const copy of ['original','duplicate'] as const)for(const kind of ['collection','reversal'] as const)it(`${kind}/${copy}: envelope REVERSED/REVERSAL, signed total, original1 or reasoned duplicate`,async()=>{
 const d=receiptDoc({copy,print_no:copy==='original'?1:2,stamp:kind==='collection'?'REVERSED':'REVERSAL'});if(kind==='reversal'){const s=d.snapshot as PaymentReceiptPrintSnapshot;d.snapshot={...s,kind:'reversal',tenders:[],total:'-100.00',reverses_receipt_id:'prior',reversal_reason:'Entry correction'};d.notes=['No collection'];}
 mount(<SalesPrintView doc={d} template={await resolveSalesTemplate(d)}/>);expect(screen.getByTestId('receipt-copy').textContent).toBe(en[copy==='original'?'sales.print.original':'sales.print.duplicate']);expect(screen.getByTestId('receipt-stamp').textContent).toBe(en[kind==='collection'?'sales.print.stamp.REVERSED':'sales.print.stamp.REVERSAL']);
 if(kind==='reversal'){expect(screen.getByTestId('receipt-total').textContent).toMatch(/-.*100\.00/);expect(screen.getByTestId('receipt-no-collection')).toBeTruthy();expect(screen.queryByText('UPI123')).toBeNull();}expect(screen.getByTestId('receipt-words').textContent).toBe('Exact backend words');
});
it('POST receipt action uses exact bundled v1 with an Idempotency-Key and no metadata/live GET; duplicate only after first success',async()=>{
 mount(<PrintPanel doc="payment_receipt" id="r1" invoiceId="inv-1" printCount={undefined}/>);
 expect(within(screen.getByTestId('sales-print-copy')).queryByRole('option',{name:en['sales.print.copyMode.duplicate']})).toBeNull();
 fireEvent.click(screen.getByTestId('print-button'));await waitFor(()=>expect(printer.print).toHaveBeenCalledOnce());expect(calls).toHaveLength(1);expect(calls[0]?.url).toBe('/api/v1/sales/invoices/inv-1/payments/r1/prints');expect(calls[0]?.headers.get('Idempotency-Key')).toMatch(/^[A-Za-z0-9_-]{16,128}$/);expect(calls[0]?.body).not.toHaveProperty('language');expect(calls[0]?.body).not.toHaveProperty('copy');
 expect((screen.getByTestId('print-button') as HTMLButtonElement).disabled).toBe(true);fireEvent.change(screen.getByLabelText(en['sales.print.reprintReason']),{target:{value:'Customer requested copy'}});response=receiptDoc({print_no:2,copy:'duplicate',stamp:'DUPLICATE'});fireEvent.change(screen.getByTestId('sales-print-copy'),{target:{value:'duplicate'}});fireEvent.click(screen.getByTestId('print-button'));await waitFor(()=>expect(printer.print).toHaveBeenCalledTimes(2));expect(calls[1]?.body).toMatchObject({copy:'duplicate',reprint_reason:'Customer requested copy'});expect(calls[1]?.body).not.toHaveProperty('language');expect(calls[1]?.headers.get('Idempotency-Key')).not.toBe(calls[0]?.headers.get('Idempotency-Key'));
});
it('unknown existing receipt history: server refusal asks for a reason without automatic retry or original fallback',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({code:'reprint_reason_required'}),{status:422,headers:{'content-type':'application/problem+json'}})));
 mount(<PrintPanel doc="payment_receipt" id="r1" invoiceId="inv-1" printCount={undefined}/>);fireEvent.click(screen.getByTestId('print-button'));await screen.findByLabelText(en['sales.print.reprintReason']);expect(printer.print).not.toHaveBeenCalled();expect((screen.getByTestId('print-button') as HTMLButtonElement).disabled).toBe(true);
});
it('receipt duplicate needs invoice.reprint; an original only needs invoice.view',()=>{
 mount(<PrintPanel doc="payment_receipt" id="r1" invoiceId="inv-1" printCount={1}/>, 'en-IN',['sales.invoice.view']);fireEvent.change(screen.getByLabelText(en['sales.print.reprintReason']),{target:{value:'Customer copy'}});expect((screen.getByTestId('print-button') as HTMLButtonElement).disabled).toBe(true);expect(calls).toHaveLength(0);
});
for(const locale of ['en-IN','ta-IN'] as const)for(const code of ['first_print_duplicate_not_supported','print_template_not_configured','pinned_print_template_unavailable','print_snapshot_unavailable','invoice_print_snapshot_missing','receipt_print_snapshot_missing','print_language_not_supported'] as const)it(`receipt ${code} clear ${locale}, no printer/retry`,async()=>{
 const request=vi.fn(async()=>new Response(JSON.stringify({code}),{status:422,headers:{'content-type':'application/problem+json'}}));vi.stubGlobal('fetch',request);mount(<PrintPanel doc="payment_receipt" id="r1" invoiceId="inv-1" printCount={undefined}/>,locale);fireEvent.click(screen.getByTestId('print-button'));await screen.findByText((locale==='en-IN'?en:ta)[`error.${code}`]);expect(printer.print).not.toHaveBeenCalled();expect(request).toHaveBeenCalledOnce();
});
it('receipt missing snapshot/unknown pin/wrong version/mismatched copy all fail closed',async()=>{
 const d=receiptDoc();for(const bad of [{...d,snapshot:invoice()},{...d,template_id:'00000000-0000-0000-0000-000000000001'},{...d,template_version:99},{...d,copy:'duplicate' as const,stamp:'DUPLICATE' as const},{...d,doc_cancelled:true}])expect(salesPrintDataError095(bad)).toBeTruthy();
 await expect(resolveSalesTemplate({...d,template_version:99})).rejects.toMatchObject({code:'pinned_print_template_unavailable'});expect(calls).toHaveLength(0);
});
it('receipt UI print action is permission-gated and its preview is outside hidden invoice screens; only selected print panel prints',async()=>{
 const inv=invoice();vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>new Response(JSON.stringify(String(input).endsWith('/payments')?{receipts:[response.document]}:response),{status:200,headers:{'content-type':'application/json'}})));
 mount(<div className="print:hidden"><Receipts inv={inv} settings={settings()}/></div>);fireEvent.click(await screen.findByText(en['sales.print.receiptAction']));const preview=await screen.findByTestId('receipt-print-preview');expect(preview.closest('.print\\:hidden')).toBeNull();fireEvent.click(screen.getByTestId('print-button'));await waitFor(()=>expect(printer.print).toHaveBeenCalledOnce());expect(screen.getByTestId('print-panel').dataset.printActive).toBe('true');
 cleanup();mount(<Receipts inv={inv}/>, 'en-IN',[]);await waitFor(()=>expect(screen.queryByText(en['sales.print.receiptAction'])).toBeNull());
});
it('printing a receipt after an invoice isolates the newly logged root, never both documents',async()=>{
 const invoiceResponse={...printDoc(),template_id:'01a1c455-29fa-769b-84f9-377a9bcdab46'};
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>new Response(JSON.stringify(String(input).includes('/payments/')?response:invoiceResponse),{status:200,headers:{'content-type':'application/json'}})));
 mount(<><PrintPanel doc="invoice" id="inv-1" printCount={0}/><PrintPanel doc="payment_receipt" id="r1" invoiceId="inv-1" printCount={undefined}/></>);
 const panels=screen.getAllByTestId('print-panel');const first=panels[0],second=panels[1];if(!first||!second)throw new Error('fixture');fireEvent.click(within(first).getByTestId('print-button'));await waitFor(()=>expect(printer.print).toHaveBeenCalledOnce());expect(first.dataset.printActive).toBe('true');
 fireEvent.click(within(second).getByTestId('print-button'));await waitFor(()=>expect(printer.print).toHaveBeenCalledTimes(2));expect(first.dataset.printActive).toBe('false');expect(second.dataset.printActive).toBe('true');
});
