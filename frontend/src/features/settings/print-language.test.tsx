import { useState, type ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@/i18n';
import en from '@/i18n/messages/en-IN.json';
import ta from '@/i18n/messages/ta-IN.json';
import { getGetTenantQueryKey } from '@/lib/api/backend/tenant/tenant';
import { getGetLanguageSettingsQueryKey } from '@/lib/api/backend/settings/settings';
import { getListLanguagesQueryKey } from '@/lib/api/backend/auth/auth';
import { getListPrintTemplatesQueryKey } from '@/lib/api/backend/branding/branding';
import { sessionQueryOptions } from '@/lib/session';
import { RateCardControls } from '@/features/rates/rate-card';
import { SalesSettingsForm, SALES_SETTING_FIELDS, settingsDraft, settingsPatch } from '@/features/sales/settings';
import { settings, templateRow } from '@/features/sales/fixtures';
import { PrintOptionsFields, PrintTemplatesManager } from './print-templates';
import { LanguageSettingsPage } from './language';
import type { PrintLocale } from '@/lib/print/locales';
vi.mock('@/components/print-preview',()=>({PrintPreview:()=> <div data-testid="safe-preview"/>}));
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();});
const values=(select:HTMLSelectElement)=>Array.from(select.options).map((o)=>o.value).filter(Boolean);
function mount(node:ReactNode,locale:'en-IN'|'ta-IN'='en-IN',qc=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity},mutations:{retry:false}}})){
 qc.setQueryData(sessionQueryOptions.queryKey,{user:{id:'u',name:'Owner',version:1,language:'hi'},roles:[{role:'owner'}],permissions:['platform.settings.edit']});
 return {qc,...render(<QueryClientProvider client={qc}><I18nProvider initial={locale}>{node}</I18nProvider></QueryClientProvider>)};
}
it('shared print options offer only English/Tamil, with no bilingual or other-language option',()=>{
 mount(<PrintOptionsFields value={{locale:'en-IN',numerals:'latn'}} onChange={vi.fn()}/>);
 expect(values(screen.getByTestId('print-language') as HTMLSelectElement)).toEqual(['en-IN','ta-IN']);
});
for(const locale of ['hi-IN','te-IN','kn-IN','ml-IN','bn-IN','gu-IN','bi-ta-IN'] as const) it(`stored print locale ${locale} remains unsupported until explicit choice`,()=>{
 const changed=vi.fn();mount(<PrintOptionsFields value={{locale:locale as PrintLocale,numerals:'latn'}} onChange={changed}/>);
 expect((screen.getByTestId('print-language') as HTMLSelectElement).value).toBe('');expect(screen.getByTestId('print-options-unsupported').textContent).toContain(locale);expect(changed).not.toHaveBeenCalled();
 fireEvent.change(screen.getByTestId('print-language'),{target:{value:'ta-IN'}});expect(changed).toHaveBeenCalledWith({locale:'ta-IN',numerals:'latn'});
});
for(const locale of ['en-IN','ta-IN'] as const) it(`Sales language is contract read-only; unsupported stored value is explained in ${locale}`,()=>{
 const value=settings({print_language:'hi' as never});mount(<SalesSettingsForm value={value}/>,locale);
 expect(SALES_SETTING_FIELDS.some((f)=>String(f.key)==='print_language')).toBe(false);
 expect(screen.getByTestId('sales-settings-print-language').textContent).toContain('hi');
 expect(screen.getByTestId('sales-settings-print-language').textContent).toContain((locale==='en-IN'?en:ta)['print.language.readOnly']);
 expect(screen.queryByTestId('print-language')).toBeNull();expect(settingsPatch(value,{...settingsDraft(value),zero_gst_print_note:'Changed note'})).not.toHaveProperty('print_language');
});
it('template manager shows unsupported raw stored languages instead of English; no Sales activation or Sales draft write (B-2), pickers en/ta only',()=>{
 const qc=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity},mutations:{retry:false}}});
 qc.setQueryData(getListPrintTemplatesQueryKey(),[{...templateRow(),print_language:'zz',is_active:false},{...templateRow(),id:'other',print_language:'hi',is_active:false}]);
 const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
 mount(<PrintTemplatesManager/>, 'en-IN',qc);
 for(const select of screen.getAllByTestId('print-language'))expect(values(select as HTMLSelectElement)).toEqual(['en-IN','ta-IN']);
 expect(screen.getAllByText(/Stored print language/).map((el)=>el.textContent).join(' ')).toContain('zz');
 expect(screen.queryByText(en['print.activate'])).toBeNull();
 expect(screen.getAllByText(en['print.saveDraft'])).toHaveLength(1);expect(screen.getByTestId('tag-label-template').textContent).toContain(en['print.saveDraft']);
 fireEvent.change(screen.getAllByTestId('print-language')[0] as HTMLElement,{target:{value:'en-IN'}});expect(fetch).not.toHaveBeenCalled();
});
it('print-language sample is en/ta only while shop/personal UI-language choices still include the full server list',()=>{
 const qc=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity},mutations:{retry:false}}});
 const languages=['en','ta','hi','te','kn','ml'].map((code)=>({code,name:code,native_name:code,amount_in_words_verified:code==='en'||code==='ta'}));
 qc.setQueryData(getListLanguagesQueryKey(),languages);qc.setQueryData(getGetTenantQueryKey(),{id:'tenant',default_language:'hi',version:1});
 qc.setQueryData(getGetLanguageSettingsQueryKey(),{shop_default:'hi',supported:languages});mount(<LanguageSettingsPage/>, 'en-IN',qc);
 expect(values(screen.getByLabelText(en['lang.printLanguage']) as HTMLSelectElement)).toEqual(['en-IN','ta-IN']);
 expect(values(screen.getByLabelText(en['lang.shopDefault']) as HTMLSelectElement)).toContain('hi');
 expect(values(screen.getByLabelText(en['lang.myOverride']) as HTMLSelectElement)).toContain('ml');
});
it('rate-card print overrides are English/Tamil only and an unsupported value cannot print',()=>{
 const print=vi.spyOn(window,'print').mockImplementation(()=>undefined);
 function Harness(){const [locale,setLocale]=useState<PrintLocale>('hi-IN');return <RateCardControls locale={locale} numerals="latn" onLocale={setLocale} onNumerals={vi.fn()}/>;}
 mount(<Harness/>);const select=screen.getByLabelText(en['rates.card.language']) as HTMLSelectElement;
 expect(values(select)).toEqual(['en-IN','ta-IN']);expect(select.value).toBe('');
 const button=screen.getByText(en['rates.card.print']) as HTMLButtonElement;expect(button.disabled).toBe(true);fireEvent.click(button);expect(print).not.toHaveBeenCalled();
 fireEvent.change(select,{target:{value:'ta-IN'}});expect(button.disabled).toBe(false);
});
