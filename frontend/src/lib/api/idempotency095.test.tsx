import { afterEach, expect, it, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { I18nProvider } from '@/i18n';
import en from '@/i18n/messages/en-IN.json';
import ta from '@/i18n/messages/ta-IN.json';
import { ErrorText } from '@/components/page';
import { ApiError } from './fetcher';
import { salesApi } from '@/features/sales/api';
import { inventoryApi } from '@/features/inventory/api';
import { ratesApi } from '@/features/rates/api';
import { commitImportWithKey, replaceGstConfigWithKey, replaceTaxRuleWithKey } from './idempotent-commands';
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const key='095-safety-key-123456';
// Body validation belongs to existing screen/wire tests. These boundary fixtures isolate header transmission.
const body={} as never;
const routes:[string,()=>Promise<unknown>][]=[
 ['/sales/invoices',()=>salesApi.issue(body,key)],
 ['/sales/invoices/i/payments',()=>salesApi.receivePayment('i',body,key)],
 ['/sales/invoices/i/payments/r/reversal',()=>salesApi.reversePayment('i','r',body,key)],
 ['/sales/invoices/i/payments/r/prints',()=>salesApi.printReceipt('i','r',{},key)],
 ['/sales/invoices/i/cancellation',()=>salesApi.cancel('i',body,key)],
 ['/sales/invoices/i/returns',()=>salesApi.returnLines('i',body,key)],
 ['/sales/invoices/i/prints',()=>salesApi.printInvoice('i',{},key)],
 ['/sales/estimates',()=>salesApi.createEstimate(body,key)],
 ['/sales/estimates/e/prints',()=>salesApi.printEstimate('e',{},key)],
 ['/sales/credit-notes/c/prints',()=>salesApi.printCreditNote('c',{},key)],
 ['/inventory/lots',()=>inventoryApi.createLot(body,key)],
 ['/inventory/tags',()=>inventoryApi.createTag(body,key)],
 ['/inventory/tags/bulk',()=>inventoryApi.bulkCreate(body,key)],
 ['/inventory/labels',()=>inventoryApi.labels(['t'],key)],
 ['/inventory/loose-stock/receipts',()=>inventoryApi.receiveLoose(body,key)],
 ['/inventory/moves',()=>inventoryApi.move(body,key)],
 ['/inventory/transfers',()=>inventoryApi.createTransfer(body,key)],
 ['/inventory/transfers/t/dispatch',()=>inventoryApi.dispatchTransfer({id:'t',version:1},key)],
 ['/inventory/transfers/t/receive',()=>inventoryApi.receiveTransfer({id:'t',version:1},body,key)],
 ['/inventory/stock-checks',()=>inventoryApi.startCheck(body,key)],
 ['/inventory/adjustments',()=>inventoryApi.requestAdjustment(body,key)],
 ['/rates/batch',()=>ratesApi.publishBatch(body,key)],
 ['/settings/gst-config/g/replace',()=>replaceGstConfigWithKey('g',body,key)],
 ['/settings/tax-rules/t/replace',()=>replaceTaxRuleWithKey('t',body,key)],
 ['/imports/job/commit',()=>commitImportWithKey('job',key)],
];
for(const [path,call] of routes)it(`0.9.5 required safety key sent by actual UI command: ${path}`,async()=>{
 const request=vi.fn(async(_input:RequestInfo|URL,_init?:RequestInit)=>new Response('{}',{status:200,headers:{'content-type':'application/json'}}));vi.stubGlobal('fetch',request);await call();expect(request).toHaveBeenCalledOnce();expect(String(request.mock.calls[0]?.[0])).toBe(`/api/v1${path}`);expect(new Headers(request.mock.calls[0]?.[1]?.headers).get('Idempotency-Key')).toBe(key);
});
for(const locale of ['en-IN','ta-IN'] as const)for(const code of ['idempotency_key_required','idempotency_key_invalid',undefined] as const)it(`${locale} gives a sensible ${code??'uncoded400'} message`,()=>{
 render(<I18nProvider initial={locale}><ErrorText error={new ApiError(code==='idempotency_key_invalid'?422:400,code,'Bad Request')}/></I18nProvider>);expect(screen.getByRole('alert').textContent).toContain((locale==='en-IN'?en:ta)[`error.${code??'bad_request'}`]);
});
