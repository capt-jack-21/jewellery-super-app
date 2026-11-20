import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { oas, deref, validateAt } from '../../tests/integration/contract';
import { RELEASE_PRINT_PINS } from '../db/src/print-pins';

// Pure Ajv contract evidence: no DB/environment/password/app import. Live HTTP coverage remains in integration.
const uuid='00000000-0000-4000-8000-000000000001';
const at='2026-11-10T08:00:00+01:00';
describe('Sales0.9.5 pure contract regressions',()=>{
  it('QA IDEM-3 — every declared key route documents400 and no422 list includes the missing-key code',()=>{
    expect(oas.info.version).toBe('0.9.6');let count=0;
    for(const [path,item] of Object.entries<any>(oas.paths)) for(const method of ['post','put','patch','delete']) {
      const op=item[method];if(!op)continue;
      const params=[...(item.parameters??[]),...(op.parameters??[])].map(deref);
      if(!params.some((p:any)=>p.in==='header'&&p.name==='Idempotency-Key'))continue;
      ++count;expect([method,path,!!op.responses['400']]).toEqual([method,path,true]);
      expect(deref(op.responses['422'])?.description??'').not.toContain('idempotency_key_required');
      const schema=deref(op.responses['400']).content['application/problem+json'].schema;
      expect(validateAt(schema.$ref,{type:'about:blank',title:'Bad Request',status:400,code:'idempotency_key_required'}).ok).toBe(true);
    }
    expect(count).toBeGreaterThan(24);
  });
  it('S19 #2 — template list and exact metadata require scope/read_only; inherited defaults are valid response rows',()=>{
    expect(oas.paths['/v1/print-templates/{id}'].get.operationId).toBe('getPrintTemplate');
    expect(deref(oas.paths['/v1/print-templates/{id}'].get.responses['200']).content['application/json'].schema.$ref).toBe('#/components/schemas/PrintTemplate');
    const schema=oas.components.schemas.PrintTemplate;
    expect(schema.required).toEqual(expect.arrayContaining(['scope','read_only']));
    for(const scope of ['tenant','partner','platform']) {
      // 0.9.6: renderable is required; response body_key stays free text (legacy/custom rows), the enum documents the release keys
      const row={id:uuid,doc_type:'receipt',body_key:'tpl/receipt.hbs',version:1,row_version:1,is_active:true,created_at:at,scope,read_only:scope!=='tenant',renderable:scope==='platform'};
      expect(validateAt('#/components/schemas/PrintTemplate',row).ok).toBe(true);
      for(const missing of ['scope','read_only','renderable']){const bad:Record<string,unknown>={...row};delete bad[missing];expect(validateAt('#/components/schemas/PrintTemplate',bad).ok).toBe(false);}
    }
  });
  it('B-2 0.9.6 — Sales create input body_key is the release enum (tag_label free, as 0.9.5); x-release-print-pins = RELEASE_PRINT_PINS; new print/problem fields validate',()=>{
    const S=oas.components.schemas;
    expect(S.ReleasePrintPin).toBeUndefined(); // folded into ReleaseRenderableBodyKey (no unused component)
    expect(S.ReleaseRenderableBodyKey.enum).toEqual(['tpl/platform/invoice.hbs','tpl/platform/estimate.hbs','tpl/platform/credit_note.hbs','tpl/platform/receipt.hbs']);
    for(const doc_type of ['invoice','estimate','receipt','credit_note','order_receipt','rate_card'])
      for(const body_key of ['tpl/receipt.hbs','templates/default/invoice.hbs','']) expect(validateAt('#/components/schemas/PrintTemplateInput',{doc_type,body_key}).ok).toBe(false);
    expect(validateAt('#/components/schemas/PrintTemplateInput',{doc_type:'receipt',body_key:'tpl/platform/receipt.hbs'}).ok).toBe(true);
    // tag_label: exactly as 0.9.5 — any non-empty body_key ≤300, config.barcode_format free
    for(const body_key of ['tpl/g/label.hbs','templates/default/tag_label.hbs','tpl/platform/invoice.hbs'])
      expect(validateAt('#/components/schemas/PrintTemplateInput',{doc_type:'tag_label',body_key,paper:'label',config:{barcode_format:'qr'}}).ok).toBe(true);
    for(const body_key of ['','x'.repeat(301)]) expect(validateAt('#/components/schemas/PrintTemplateInput',{doc_type:'tag_label',body_key}).ok).toBe(false);
    const pins=S.ReleaseRenderableBodyKey['x-release-print-pins'];
    expect(pins).toEqual(RELEASE_PRINT_PINS.map((p)=>({...p})));
    for(const pin of pins) expect(S.ReleaseRenderableBodyKey.enum).toContain(pin.body_key);
    expect(S.SalesPrintDocument.required).toEqual(expect.arrayContaining(['template_repinned','repinned_from','template_fallback_from']));
    const FB='#/components/schemas/SalesPrintDocument/properties/template_fallback_from';
    expect(validateAt(FB,null).ok).toBe(true); expect(validateAt(FB,{template_id:uuid,template_version:2}).ok).toBe(true); expect(validateAt(FB,{template_id:uuid}).ok).toBe(false);
    const recovery={type:'about:blank',title:'Unprocessable Entity',status:422,code:'pinned_print_template_unavailable',unrenderable_template:{template_id:uuid,template_version:3},
      recovery:{copy:'duplicate',reprint_reason_required:true,permission:'sales.invoice.reprint',repin_to:{template_id:uuid,template_version:1}}};
    expect(validateAt('#/components/schemas/SalesUnprocessableProblem',recovery).ok).toBe(true);
    expect(validateAt('#/components/schemas/SalesUnprocessableProblem',{...recovery,recovery:{...recovery.recovery,copy:'auto'}}).ok).toBe(false);
  });
  it('0.9.5 en/ta print settings/overrides only, while six-language UI settings stay unchanged',()=>{
    expect(oas.components.schemas.PrintTemplateInput.properties.print_language.readOnly).not.toBe(true);
    expect(oas.paths['/v1/print-templates/{id}/activate'].post.responses['422']).toBeDefined();
    expect(oas.components.schemas.SalesSettings.properties.print_language.readOnly).toBe(true);
    for(const language of ['en','ta','hi','te','kn','ml','zz']) {
      const ok=['en','ta'].includes(language);
      expect(validateAt('#/components/schemas/PrintTemplateInput',{doc_type:'receipt',body_key:'tpl/platform/receipt.hbs',print_language:language}).ok).toBe(ok);
      expect(validateAt('#/components/schemas/SalesPrintRequest',{language}).ok).toBe(ok);
    }
    expect(validateAt('#/components/schemas/TenantPatch',{default_language:'hi'}).ok).toBe(true);
  });
  it('0.9.5 receipt print snapshot has seller/customer/reference/immutable issue balance; signed reversal uses same contract',()=>{
    const snapshot={id:uuid,receipt_no:'REC-1',invoice_id:uuid,invoice_no:'SALE/2026/000001',invoice_date:'2026-11-10',branch_id:uuid,customer_id:uuid,
      customer:{customer_id:uuid,name:'Buyer',phone:null,gstin:null,state_code:'33',address:null,pan_on_file:false,pan_last4:null},
      seller:{company_id:uuid,legal_name:'Seller',gstin:'33AAAAA1111A1Z5',state_code:'33',address:{line1:'Frozen address'}},
      received_on:'2026-11-10',received_at:at,received_by:uuid,tenders:[],total:'100.00',adjusted_balance_due_at_issue:'100.00',note:null,reverses_receipt_id:null,reversal_reason:null,kind:'collection'};
    const ref='#/components/schemas/PaymentReceiptPrintSnapshot';expect(validateAt(ref,snapshot).ok).toBe(true);
    expect(validateAt(ref,{...snapshot,total:'-100.00',kind:'reversal',reverses_receipt_id:uuid,reversal_reason:'bank reversal'}).ok).toBe(true);
    for(const field of ['seller','customer','invoice_no','invoice_date','tenders','total','adjusted_balance_due_at_issue']){const bad:Record<string,unknown>={...snapshot};delete bad[field];expect(validateAt(ref,bad).ok).toBe(false);}
    const route=oas.paths['/v1/sales/invoices/{id}/payments/{receipt_id}/prints'].post;
    expect(route.operationId).toBe('printPaymentReceipt');expect(deref(route.responses['200']).content['application/json'].schema.$ref).toBe('#/components/schemas/SalesPrintDocument');
    expect(oas.components.schemas.SalesPrintDocument.properties.doc_type.enum).toContain('payment_receipt');
  });
  it('0.9.5 settings preserve ETag/If-Match; effective-date parameters are the quoted string on, never coerced true',()=>{
    const settings=oas.paths['/v1/sales/settings'];
    expect(settings.get.responses['200'].headers.ETag.$ref).toBe('#/components/headers/ETag');
    expect(settings.patch.parameters.some((p:any)=>deref(p).name==='If-Match')).toBe(true);
    expect(settings.patch.responses['428']).toBeTruthy();
    expect(oas.paths['/v1/settings/sales-policy'].get.parameters[0].name).toBe('on');
    expect(oas.paths['/v1/settings/tax-rules'].get.parameters.some((p:any)=>deref(p).name==='on')).toBe(true);
  });
});

/** Raw scalar guard (no new YAML dependency): normal Redocly parsing alone uses1.2 and cannot expose1.1 on/off coercion.
 * Tokenise source, preserving quote/tag style and excluding comments/block-scalar prose. Guard names, every mapping key and enum members.
 * Genuine boolean/null enum values must be explicit !!bool/!!null tags; quoting would incorrectly turn them into strings.
 */
const YAML11_WORD=/^(?:on|off|yes|no|y|n|true|false|null|~)$/i;
type Token={value:string;quoted:boolean;line:number;col:number};
function scalarTokens(source:string):Token[] {
  const out:Token[]=[];let i=0,line=1,col=0;
  const step=()=>{if(source[i++]==='\n'){line++;col=0;}else col++;};
  while(i<source.length) {
    const c=source[i];
    if(/\s/.test(c)){step();continue;}
    if(c==='#'){while(i<source.length&&source[i]!=='\n')step();continue;}
    const start={line,col};
    if(c==='"'||c==="'") {
      const quote=c;let value='';step();
      while(i<source.length){
        if(source[i]===quote){step();if(quote==="'"&&source[i]===quote){value+=quote;step();continue;}break;}
        if(quote==='"'&&source[i]==='\\'){step();if(i<source.length){value+=source[i];step();}continue;}
        value+=source[i];step();
      }
      out.push({...start,value,quoted:true});continue;
    }
    if((c==='|'||c==='>')&&out.at(-1)?.value===':'&&/^[|>][+-]?[1-9]?\s*(?:#.*)?$/.test(source.slice(i).split('\n')[0])) {
      const begin=source.lastIndexOf('\n',i-1)+1;
      const indent=source.slice(begin,i).match(/^ */)![0].length;
      while(i<source.length&&source[i]!=='\n')step();if(i<source.length)step();
      while(i<source.length){const text=source.slice(i).split('\n')[0];if(text.trim()&&text.match(/^ */)![0].length<=indent)break;while(i<source.length&&source[i]!=='\n')step();if(i<source.length)step();}
      continue;
    }
    if('[]{}:,'.includes(c)){out.push({...start,value:c,quoted:false});step();continue;}
    let value='';while(i<source.length&&!/[\s\[\]{}:,#'"]/.test(source[i])){value+=source[i];step();}
    if(value)out.push({...start,value,quoted:false});else step();
  }
  return out;
}
/** Resolve aliases with the nearest PRECEDING anchor definition, retaining original quote/tag styles.
 * Flow collections, indented block nodes, nested aliases and alias keys are handled; recursive/unknown aliases fail closed.
 * This is deliberately bounded to prevent alias bombs; no new parser dependency or frontend module is needed.
 */
function resolveAliases(tokens:Token[]):Token[] {
  type T=Token&{index:number};const t:T[]=tokens.map((x,index)=>({...x,index}));
  const anchors=new Map<string,{index:number;node:T[]}[]>();
  for(let i=0;i<t.length;i++)if(!t[i].quoted&&/^&[^\s]+$/.test(t[i].value)) {
    const start=i+1;if(!t[start])throw Error('anchor has no value');let end=start+1;
    if(['[','{'].includes(t[start].value)) {
      const stack:string[]=[];end=start;
      do {const v=t[end++];if(!v)throw Error('unclosed anchored collection');if(!v.quoted){if(v.value==='[')stack.push(']');else if(v.value==='{')stack.push('}');else if(v.value===']'||v.value==='}') {if(stack.pop()!==v.value)throw Error('invalid anchored collection');}}}while(stack.length);
    } else if(t[start].line>t[i].line) {
      let parent=i;while(parent>0&&t[parent-1].line===t[i].line)parent--;
      end=start;while(end<t.length&&(t[end].col>t[parent].col||t[end].line===t[end-1]?.line||t[end].value==='-'))end++;
    } else if(t[start].value.startsWith('!!'))end++;
    const name=t[i].value.slice(1);anchors.set(name,[...(anchors.get(name)??[]),{index:i,node:t.slice(start,end)}]);
  }
  let budget=200000;
  const expand=(node:T[],seen:Set<number>):T[]=>node.flatMap(v=>{
    if(--budget<0)throw Error('alias expansion limit exceeded');
    if(v.quoted)return[v];if(v.value.startsWith('&'))return[];
    if(!v.value.startsWith('*'))return[v];
    const anchor=anchors.get(v.value.slice(1))?.filter(d=>d.index<v.index).at(-1);
    if(!anchor)throw Error('unknown alias '+v.value);if(seen.has(anchor.index))throw Error('recursive alias '+v.value);
    return expand(anchor.node,new Set([...seen,anchor.index]));
  });
  return expand(t,new Set());
}
function unsafeYaml11(source:string):string[] {
  let t:Token[];try{t=resolveAliases(scalarTokens(source));}catch(e){return['YAML alias resolution: '+(e as Error).message];}
  const bad:string[]=[];
  const check=(i:number,kind:string)=>{const v=t[i];if(!v||v.quoted||!YAML11_WORD.test(v.value))return;
    if(kind==='enum'&&((t[i-1]?.value==='!!null'&&/^(null|~)$/i.test(v.value))||(t[i-1]?.value==='!!bool'&&/^(true|false)$/i.test(v.value))))return;
    bad.push(`${v.line}:${v.col+1} ${kind} ${v.value}`);
  };
  for(let i=0;i<t.length;i++) {
    if(t[i+1]?.value===':')check(i,'key');
    if(t[i].value==='name'&&t[i+1]?.value===':')check(i+2,'name');
    if(t[i].value!=='enum'||t[i+1]?.value!==':')continue;
    if(t[i+2]?.value==='['){let depth=0;for(let k=i+2;k<t.length;k++){if(t[k].value==='[')depth++;if(t[k].value===']'&&--depth===0)break;check(k,'enum');}}
    else for(let k=i+2;k<t.length;k++){if(t[k].line>t[i].line&&t[k].col<=t[i].col&&t[k].value!=='-')break;check(k,'enum');}
  }
  return bad;
}
function parameterNameProblems(doc:any):string[] {
  const bad:string[]=[];
  const walk=(v:any,path:string)=>{if(!v||typeof v!=='object')return;
    if(!Array.isArray(v)&&!('$ref'in v)&&(/\/parameters\/[^/]+$/.test(path)||['query','path','header','cookie'].includes(v.in))) {
      if(typeof v.name!=='string'||!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(v.name)||/^(true|false|null)$/i.test(v.name))bad.push(path+': invalid parameter name '+String(v.name));
    }
    for(const [k,x]of Object.entries(v))walk(x,path+'/'+k);
  };walk(doc,'#');return bad;
}
describe('0.9.5 respin — YAML1.1 raw scalars plus normal bundled parser',()=>{
  it('every parameter anywhere is a real string identifier; whole spec has no ambiguous names/keys/enums',()=>{
    const raw=readFileSync(resolve(__dirname,'../../contracts/openapi.yaml'),'utf8');
    expect(unsafeYaml11(raw)).toEqual([]);expect(parameterNameProblems(oas)).toEqual([]);
    expect(raw).toContain("name: 'on', in: query");
    for(const path of ['/v1/settings/sales-policy','/v1/settings/tax-rules'])expect(oas.paths[path].get.parameters.map(deref).filter((p:any)=>p.name==='on')).toHaveLength(1);
    // Explicit genuine nulls remain null, not string "null", after the normal parser.
    expect(oas.components.schemas.SalesPrintDocument.properties.stamp.enum).toContain(null);
  });
  it('mutation regression — catches the original unquoted on AND the mistaken quoted true fix',()=>{
    expect(unsafeYaml11("parameters: [{name: on, in: query}]")).not.toEqual([]);
    expect(unsafeYaml11("parameters: [{name: 'on', in: query}]")).toEqual([]);
    expect(parameterNameProblems({parameters:[{name:'true',in:'query'}]})).not.toEqual([]);
    expect(parameterNameProblems({parameters:[{name:'on',in:'query'}]})).toEqual([]);
    for(const name of [true,false,null,1,'','bad name','bad.name','_leading'])expect(parameterNameProblems({components:{parameters:{Any:{name,in:'query'}}}})).not.toEqual([]);
  });
  it('all YAML1.1 boolean/null spellings are unsafe in plain names, enum values and mapping keys',()=>{
    for(const word of ['on','off','yes','no','y','n','true','false','null','~','ON','Off','YES','NO','Y','N','True','FALSE','Null','NULL']) {
      for(const raw of [`name: ${word}`,`enum: [${word}]`,`${word}: string`,`enum:\n  - ${word}`])expect(unsafeYaml11(raw),raw).not.toEqual([]);
      for(const raw of [`name: '${word}'`,`enum: ['${word}']`,`'${word}': string`])expect(unsafeYaml11(raw),raw).toEqual([]);
    }
  });
  it('NB-3 — aliases resolve before whole-spec name/key/enum checks; quoted definitions pass and explicit primitive types survive',()=>{
    const unsafe=["choices: &opts [off]\nschema: {type: string, enum: *opts}",
      "parameterName: &param on\nparameters: [{name: *param, in: query}]",
      "word: &word off\nchoices: &opts [*word]\nschema: {enum: *opts}",
      "word: &word on\n*word: string", "choices: &opts\n  - off\nschema: {enum: *opts}",
      "choices: &opts [off]\nschema: {enum: *opts}\nnewChoices: &opts ['off']",
      "choices: &loop [*loop]\nschema: {enum: *loop}","parameters: [{name: *missing, in: query}]"];
    for(const raw of unsafe)expect(unsafeYaml11(raw),raw).not.toEqual([]);
    const safe=["choices: &opts ['off']\nschema: {type: string, enum: *opts}",
      "parameterName: &param 'on'\nparameters: [{name: *param, in: query}]",
      "literal: &nil !!null null\ntruth: &truth !!bool true\nfalsehood: &falsehood !!bool false\nschema: {enum: [*nil, *truth, *falsehood]}"];
    for(const raw of safe)expect(unsafeYaml11(raw),raw).toEqual([]);
    const primitives=resolveAliases(scalarTokens(safe[2]));
    expect(primitives.filter(t=>t.value==='!!null')).toHaveLength(2);expect(primitives.filter(t=>t.value==='!!bool')).toHaveLength(4);
    expect(parameterNameProblems({parameters:[{name:1}]})).not.toEqual([]);
  });
  it('ignores quoted/comment/block prose but preserves explicitly typed genuine enum booleans/null',()=>{
    expect(unsafeYaml11("# on: no\ndescription: |\n  on: yes\n  enum: [off]\nexample: 'on: no'\nvalue: \"enum: [yes]\"\nenum: [!!null null, !!bool true, !!bool false, 'off']")).toEqual([]);
  });
});
