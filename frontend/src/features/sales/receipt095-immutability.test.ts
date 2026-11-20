import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import hashes from './receipt095-v1.hashes.json';
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
// Final receipt wire adapter is first published with 0.9.5; frozen 0.9.4 preparation remains intact.
// Add new immutable versions for future content changes; do not bless edits by changing this anchor.
it('final receipt-v1 adapter and its new labels are immutable, old v1 seal unchanged',()=>{
  expect(sha(readFileSync('src/features/sales/receipt095-v1.hashes.json'))).toBe('0e757ab7e10a5e65e3acaf7b713ad241b4b1e1ae0a080272f9f41cfd97964201');
  for(const [path,hash] of Object.entries(hashes))expect(sha(readFileSync(path)),path).toBe(hash);
  expect(sha(readFileSync('src/features/sales/shipped-v1.hashes.json'))).toBe('5f72d943d3971a04be59198d6cd97dfbae0bce8a34075e51e19577a6e29e4a19');
});
