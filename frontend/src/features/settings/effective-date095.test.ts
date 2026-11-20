import { afterEach, expect, it, vi } from 'vitest';
import { getSalesPolicy, listTaxRules, getGetSalesPolicyUrl, getListTaxRulesUrl } from '@/lib/api/backend/settings/settings';
import { getSalesPolicyQueryParams, listTaxRulesQueryParams } from '@/lib/api/backend/zod/settings/settings';
import { istToday } from './tax';
afterEach(()=>vi.unstubAllGlobals());
for(const [at,on] of [['2026-11-10T18:29:59Z','2026-11-10'],['2026-11-10T18:30:00Z','2026-11-11']] as const)it(`effective-date on is an IST calendar date at ${at}, not UTC/browser date or malformed true`,async()=>{
 const date=istToday(new Date(at));expect(date).toBe(on);
 expect(getGetSalesPolicyUrl({on:date})).toBe(`/v1/settings/sales-policy?on=${on}`);
 expect(getListTaxRulesUrl({on:date,component:'metal'})).toBe(`/v1/settings/tax-rules?on=${on}&component=metal`);
 const request=vi.fn(async(_input:RequestInfo|URL,_init?:RequestInit)=>new Response('{}',{status:200,headers:{'content-type':'application/json'}}));vi.stubGlobal('fetch',request);
 await getSalesPolicy({on:date});await listTaxRules({on:date});
 for(const [input] of request.mock.calls){const url=new URL(String(input),'http://test.invalid');expect(url.searchParams.get('on')).toBe(on);expect(url.searchParams.has('true')).toBe(false);}
});
it('final regenerated query schemas name on, never the malformed true property',()=>{
 expect(Object.keys(getSalesPolicyQueryParams.shape)).toEqual(['on']);expect(Object.keys(listTaxRulesQueryParams.shape)).toContain('on');expect(Object.keys(listTaxRulesQueryParams.shape)).not.toContain('true');
});
