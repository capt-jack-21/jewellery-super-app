import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUNDLED_TEMPLATES, bundledTemplate, resolveSalesTemplate, resolveBundledPin, SEEDED_TEMPLATE_PINS } from './templates';
import { printDoc } from './fixtures';

afterEach(() => vi.unstubAllGlobals());
describe('bundled seeded body_key + version families, never active/engine/source fetch', () => {
  for (const row of BUNDLED_TEMPLATES) for (const paper of ['A4', 'A5', 'thermal_80mm']) for (const locale of ['en-IN', 'ta-IN']) {
    it(`${row.body_key}@${row.template_version} ${paper} ${locale}`, () => expect(bundledTemplate(row.body_key, row.template_version, row.doc_type, paper, locale)).toBe(row));
  }
  it('rejects unknown key, version, document kind, paper or locale without fallback', () => {
    for (const args of [['unknown',1,'invoice','A4','en-IN'],['tpl/platform/invoice.hbs',99,'invoice','A4','en-IN'],['tpl/platform/invoice.hbs',1,'credit_note','A4','en-IN'],['tpl/platform/invoice.hbs',1,'invoice','label','en-IN'],['tpl/platform/invoice.hbs',1,'invoice','A4','bn-IN']] as const) expect(() => bundledTemplate(args[0],args[1],args[2],args[3],args[4])).toThrow();
  });
  it('maps exact verified ID+version to a bundled family, with ZERO fetches and no newest/active selection', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); const d=printDoc();
    const pin={id:d.template_id,version:1,body_key:'tpl/platform/invoice.hbs',doc_type:'invoice' as const};
    expect(await resolveSalesTemplate(d,[pin,{...pin,version:2,body_key:'tpl/t1/invoice-v2.hbs'}])).toMatchObject({body_key:pin.body_key,template_id:d.template_id,template_version:1});
    await expect(resolveSalesTemplate({...d,template_version:3},[pin])).rejects.toMatchObject({code:'pinned_print_template_unavailable'});
    await expect(resolveSalesTemplate(d,[])).rejects.toMatchObject({code:'pinned_print_template_unavailable'}); expect(fetch).not.toHaveBeenCalled();
  });
  it('every verified seeded ID binding has an exact bundled key/version/kind', () => {
    expect(SEEDED_TEMPLATE_PINS).toHaveLength(4);
    expect(SEEDED_TEMPLATE_PINS.map((p)=>p.doc_type).sort()).toEqual(['credit_note','estimate','invoice','receipt']);
    for(const pin of SEEDED_TEMPLATE_PINS) expect(bundledTemplate(pin.body_key,pin.version,pin.doc_type,'A4','en-IN')).toBeTruthy();
  });
  it('the four actual 998 UUIDs resolve without any metadata/source fetch', () => {
    const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
    for(const p of SEEDED_TEMPLATE_PINS) expect(resolveBundledPin({template_id:p.id,template_version:p.version,doc_type:p.doc_type,paper:'thermal_80mm',locale:'ta-IN'})).toMatchObject({body_key:p.body_key});
    expect(fetch).not.toHaveBeenCalled();
  });
});
