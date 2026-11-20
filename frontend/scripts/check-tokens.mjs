// CI guard (WL-7 + INV-2): no Tailwind palette/arbitrary colour classes, no brand strings, no hidden-billing identifiers.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PALETTE = 'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black';
const rules = [
  { re: new RegExp(String.raw`\b(bg|text|border|ring|fill|stroke|from|via|to|outline|shadow|decoration|divide|placeholder|accent|caret)-(${PALETTE})(-\d{2,3})?\b`), msg: 'Tailwind palette colour class' },
  { re: /-\[(#|rgb|hsl|oklch)/, msg: 'Arbitrary colour class' },
  { re: /\b(AuSales|Ausale|ATTS|Jewellery SaaS)\b/i, msg: 'Brand string in code (use useBrand()/branding data)' },
  { re: /billing_backup|huid-stock-list|truncate-model|authenticatepass|Drang/i, msg: 'Forbidden hidden-billing identifier (D2/INV-2)' },
];
// Placeholder brand may appear only in branding data/fixtures and env.
const allow = { 'Brand string in code (use useBrand()/branding data)': [/src[\\/]mocks[\\/]/, /\.test\./] };
const skip = /node_modules|generated|design-tokens/;

const files = [];
(function walk(d) {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (skip.test(p)) continue;
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(tsx?|css|html)$/.test(p)) files.push(p);
  }
})('src');
files.push('index.html');

let bad = 0;
for (const f of files) {
  readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
    for (const r of rules) {
      if (r.re.test(line) && !(allow[r.msg] ?? []).some((a) => a.test(f))) {
        console.error(`${f}:${i + 1}  ${r.msg}: ${line.trim().slice(0, 120)}`);
        bad++;
      }
    }
  });
}
if (bad) { console.error(`\ncheck-tokens: ${bad} violation(s)`); process.exit(1); }
console.log(`check-tokens: OK (${files.length} files)`);
