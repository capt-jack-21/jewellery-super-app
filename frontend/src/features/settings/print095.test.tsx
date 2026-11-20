import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@/i18n';
import en from '@/i18n/messages/en-IN.json';
import { sessionQueryOptions } from '@/lib/session';
import { getListPrintTemplatesQueryKey } from '@/lib/api/backend/branding/branding';
import { PrintLogRows } from '@/features/sales/print';
import { templateRow } from '@/features/sales/fixtures';
import { PrintTemplatesManager } from './print-templates';
import { PrintTemplateMetadata, tenantTemplateEditable } from './print-template-metadata';
vi.mock('@/components/print-preview',()=>({PrintPreview:()=> <div data-testid="metadata-preview-stub"/>}));
const row=templateRow();
function mount(node:ReactNode,qc=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity},mutations:{retry:false}}})){
 qc.setQueryData(sessionQueryOptions.queryKey,{user:{id:'u',name:'Owner',version:1},roles:[{role:'owner'}],permissions:['platform.settings.edit']});
 return render(<QueryClientProvider client={qc}><I18nProvider initial="en-IN">{node}</I18nProvider></QueryClientProvider>);
}
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();});
it('scope labels stay read-only, and no row of any scope exposes activation (0.9.5 printfix B-2: platform defaults only)',()=>{
 const qc=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity}}});
 qc.setQueryData(getListPrintTemplatesQueryKey(),[{...row,id:'tenant',scope:'tenant',read_only:false,print_language:'en'},{...row,id:'partner',scope:'partner',read_only:true},{...row,id:'platform',scope:'platform',read_only:true},{...row,id:'malformed',scope:'partner',read_only:false}]);
 mount(<PrintTemplatesManager/>,qc);expect(screen.queryByText(en['print.activate'])).toBeNull();expect(screen.getByText(en['print.scope.platform']+' · '+en['common.readOnly'])).toBeTruthy();expect(screen.getAllByText(en['print.scope.partner']+' · '+en['common.readOnly'])).toHaveLength(2);
 expect(tenantTemplateEditable({...row,scope:'tenant',read_only:true})).toBe(false);expect(tenantTemplateEditable({...row,scope:'platform',read_only:false})).toBe(false);
});
it('exact metadata GET resolves inactive platform pin without fetching assets or ranking other scopes',async()=>{
 const request=vi.fn(async(_input:RequestInfo|URL,_init?:RequestInit)=>new Response(JSON.stringify({...row,scope:'platform',read_only:true,is_active:false}),{status:200,headers:{'content-type':'application/json'}}));vi.stubGlobal('fetch',request);
 mount(<PrintTemplateMetadata id={row.id} version={1}/>);expect(request).not.toHaveBeenCalled();fireEvent.click(screen.getByText(en['print.metadata']));await screen.findByTestId('exact-template-details');expect(String(request.mock.calls[0]?.[0])).toBe(`/api/v1/print-templates/${row.id}`);expect(screen.getByTestId('exact-template-details').textContent).toContain(row.body_key);expect(screen.getByTestId('exact-template-details').textContent).toContain(en['common.readOnly']);expect(request).toHaveBeenCalledOnce();
});
for(const failure of ['foreign404','wrong_id','wrong_version'] as const)it(`exact metadata ${failure} does not substitute a list/active version`,async()=>{
 const request=vi.fn(async()=>new Response(JSON.stringify(failure==='foreign404'?{code:'not_found'}:{...row,...(failure==='wrong_id'?{id:'other'}:{version:2})}),{status:failure==='foreign404'?404:200,headers:{'content-type':'application/json'}}));vi.stubGlobal('fetch',request);
 mount(<PrintTemplateMetadata id={row.id} version={1}/>);fireEvent.click(screen.getByText(en['print.metadata']));await waitFor(()=>expect(screen.getByRole('alert')).toBeTruthy());expect(screen.queryByTestId('exact-template-details')).toBeNull();expect(request).toHaveBeenCalledOnce();
});
it('print-log metadata uses the exact pin; legacy null pins make no request',async()=>{
 const request=vi.fn(async()=>new Response(JSON.stringify(row),{status:200,headers:{'content-type':'application/json'}}));vi.stubGlobal('fetch',request);
 mount(<PrintLogRows rows={[{print_no:1,copy:'original',doc_cancelled:false,printed_at:'2026-11-10T03:00:00Z',printed_by:'u',paper:'A4',language:'en',locale:'en-IN',numerals:'latin',template_id:row.id,template_version:1,reprint_reason:null}]}/>);fireEvent.click(screen.getByText(en['print.metadata']));await screen.findByTestId('exact-template-details');expect(request).toHaveBeenCalledOnce();cleanup();request.mockClear();mount(<PrintTemplateMetadata id={null} version={null}/>);expect(request).not.toHaveBeenCalled();expect(screen.queryByText(en['print.metadata'])).toBeNull();
});
