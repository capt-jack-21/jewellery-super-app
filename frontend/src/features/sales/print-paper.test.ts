// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import postcss from 'postcss';
import { chromium, type Browser } from 'playwright-core';

const css=readFileSync('src/features/sales/print.v1.css','utf8');
const globalCss=readFileSync('src/index.css','utf8');
const builtCss=process.env.SALES_PRINT_BUILT_CSS==='1' ? readdirSync('dist/assets').filter((f)=>f.endsWith('.css')).map((f)=>readFileSync(`dist/assets/${f}`,'utf8')).join('\n') : null;
const papers={ A4:{name:'sales-a4',mm:[210,297]}, A5:{name:'sales-a5',mm:[148,210]}, thermal_80mm:{name:'sales-thermal',mm:[80,297]} } as const;
function sizeMm(value:string) {
 const parts=value.trim().split(/\s+/);
 if(parts.length!==2 || parts.some((p)=>!/^\d+(?:\.\d+)?mm$/.test(p))) throw new Error(`Invalid explicit print size: ${value}`);
 return parts.map((p)=>Number(p.slice(0,-2)));
}
it('parses valid explicit page-size lengths; rejects length plus auto and unqualified global A4',()=>{
 const root=postcss.parse(css),sizes=new Map<string,string>();
 root.walkAtRules('page',(rule)=>{rule.walkDecls('size',(d)=>{sizes.set(rule.params,d.value);});});
 for(const p of Object.values(papers)) expect(sizeMm(sizes.get(p.name)??'')).toEqual([...p.mm]);
 for(const invalid of ['80mm auto','auto 297mm','80mm','80mm bogus']) expect(()=>sizeMm(invalid)).toThrow();
 postcss.parse(globalCss).walkAtRules('page',(rule)=>expect(rule.params.trim(),'global pages must be named').not.toBe(''));
});
it('each envelope paper selects its own named page on the actual sales root selector',()=>{
 const root=postcss.parse(css);
 for(const [paper,p] of Object.entries(papers)) {
  let pageName='';root.walkRules((rule)=>{if(rule.selector===`.sales-doc[data-paper='${paper}']`)rule.walkDecls('page',(d)=>{pageName=d.value;});});
  expect(pageName).toBe(p.name);
 }
});
let browser:Browser;
beforeAll(async()=>{browser=await chromium.launch({executablePath:chromium.executablePath(),headless:true,args:['--no-sandbox']});},30000);
afterAll(async()=>{await browser?.close();});
for(const [paper,p] of Object.entries(papers)) it(`Chromium: ${paper} envelope produces correct PDF MediaBox on every long-document page`,async()=>{
 const page=await browser.newPage();
 try {
  await page.route('**/*',(route)=>route.abort()); // dimension-only diagnostic: no network/fonts/API
  const globals=globalCss.replace(/@import[^;]+;/g,'').replace(/@tailwind[^;]+;/g,'');
  await page.setContent(`<style>${builtCss ?? `${css}\n${globals}`}</style><article class="sales-doc" data-paper="${paper}"><header>Frozen seller — GSTIN</header>${'<p>Invoice / credit-note line 1.000 g — 100.00</p>'.repeat(200)}</article>`);
  await page.emulateMedia({media:'print'});
  const style=await page.locator('.sales-doc').evaluate((el)=>({page:getComputedStyle(el).page,header:getComputedStyle(el.querySelector('header') as Element).display}));
  expect(style.page).toBe(p.name);expect(style.header).not.toBe('none');
  const parsed=await page.evaluate(()=>Array.from(document.styleSheets).flatMap((sheet)=>Array.from(sheet.cssRules)).filter((rule)=>rule instanceof CSSPageRule).map((rule)=>({selector:(rule as CSSPageRule).selectorText,size:(rule as CSSPageRule).style.getPropertyValue('size')})));
  expect(parsed.find((rule)=>rule.selector===p.name)?.size).not.toBe('');
  const pdf=await page.pdf({preferCSSPageSize:true});
  const boxes=[...pdf.toString('latin1').matchAll(/\/MediaBox\s*\[([^\]]+)\]/g)].map((m)=>(m[1]??'').trim().split(/\s+/).map(Number));
  expect(boxes.length).toBeGreaterThan(1);
  for(const box of boxes){expect(Math.abs((box[2]??0)-p.mm[0]*72/25.4)).toBeLessThan(1);expect(Math.abs((box[3]??0)-p.mm[1]*72/25.4)).toBeLessThan(1);}
 }finally{await page.close();}
},30000);
