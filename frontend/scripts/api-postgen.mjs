// Orval 7 drops query params when a path param is also named `key` (e.g. PUT /v1/settings/{key}?branch_id=):
// it emits an empty forEach. Patch those loops so params are actually sent. Runs after `orval`.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
const files = ['src/lib/api/backend'].flatMap((d) =>
  readdirSync(d, { recursive: true }).map(String).filter((f) => f.endsWith('.ts')).map((f) => `${d}/${f}`));
const empty = /Object\.entries\(params \|\| \{\}\)\.forEach\(\(\[key, value\]\) => \{\s*\}\);/g;
const fixed = "Object.entries(params || {}).forEach(([k, value]) => { if (value !== undefined) normalizedParams.append(k, value === null ? 'null' : String(value)); });";
let n = 0;
for (const f of files) {
  const s = readFileSync(f, 'utf8');
  if (empty.test(s)) { writeFileSync(f, s.replace(empty, fixed)); n++; }
  empty.lastIndex = 0;
}
// Orval 7 zod output emits `export const xMaxOne = 60;,` for nested maxLength under arrays: drop the stray comma.
const strayComma = /^(export const \w+ = [^\n]*);,$/gm;
for (const f of files.filter((x) => x.includes('/zod/'))) {
  const s = readFileSync(f, 'utf8');
  if (strayComma.test(s)) { writeFileSync(f, s.replace(strayComma, '$1;')); n++; }
  strayComma.lastIndex = 0;
}
console.log(`api-postgen: patched ${n} file(s)`);
