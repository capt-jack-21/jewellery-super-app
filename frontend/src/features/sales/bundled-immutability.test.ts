import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import hashes from './shipped-v1.hashes.json';
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
// Pre-deployment v1 CSS-only correction explicitly approved by lead; no deployed v1 existed.
// SHIPPED v1 seal: do not update this digest to bless edits. ADD v2 files/registry, retaining v1.
it('shipped v1 registry and all renderer/content dependencies are never edited or removed',()=>{
  expect(sha(readFileSync('src/features/sales/shipped-v1.hashes.json'))).toBe('5f72d943d3971a04be59198d6cd97dfbae0bce8a34075e51e19577a6e29e4a19');
  for(const [path,hash] of Object.entries(hashes)) expect(sha(readFileSync(path)),path).toBe(hash);
});
it('print CSS keeps mandatory seller headers visible instead of the global header hide',()=>{
 const css=readFileSync('src/features/sales/print.v1.css','utf8');
 expect(css).toContain('.sales-doc header { display: flex !important; }');
 for(const paper of ['A4','A5','thermal_80mm']) expect(css).toContain(`[data-paper='${paper}']`);
 expect(readFileSync('src/index.css','utf8')).toContain("@import './features/sales/print.v1.css'");
});
