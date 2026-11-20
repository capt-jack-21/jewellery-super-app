/**
 * Collision-proof HUIDs for integration tests (fixes the inventory-083 flake: two files drew the same rnd(2)+counter value).
 * Each test file owns a distinct leading DIGIT; the other 5 chars are a base36 counter starting at a random offset, so values never repeat
 * inside a file and can never clash across files (inventory-contract keeps its letter-led "IC.." space). HUID = ^[A-Z0-9]{6}$.
 */
export const HUID_PREFIX = { inventory: '1', inventory083: '2', sales: '3', salesContract: '4', tenancy: '5', sales095: '6', orders: '7' } as const;
const SPACE = 36 ** 5;
export function huidGen(prefix: string): () => string {
  if (!/^[0-9]$/.test(prefix)) throw new Error('huid prefix must be one digit');
  let n = Math.floor(Math.random() * SPACE);
  let used = 0;
  return () => {
    if (++used >= SPACE) throw new Error('huid space exhausted');
    n = (n + 1) % SPACE;
    return `${prefix}${n.toString(36).toUpperCase().padStart(5, '0')}`;
  };
}
