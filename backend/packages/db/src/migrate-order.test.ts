import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { orderMigrations } from './migrate';

describe('orderMigrations (numeric prefix; 5-digit numbering after 999)', () => {
  it('puts 5-digit files after 999 and in numeric order, never before 010', () => {
    const shuffled = ['01001_b.sql', '999_z.sql', '01000_a.sql', '010_platform.sql', '110_orders.sql', '10000_big.sql', '01999_c.sql'];
    expect(orderMigrations(shuffled)).toEqual(['010_platform.sql', '110_orders.sql', '999_z.sql', '01000_a.sql', '01001_b.sql', '01999_c.sql', '10000_big.sql']);
  });
  const dir = new URL('../../../../jewellery-data-model/migrations/', import.meta.url);
  it.skipIf(!existsSync(dir))('keeps the exact order a text sort gave every existing 3-digit migration', () => {
    const three = readdirSync(dir).filter((f) => /^\d{3}_.*\.sql$/.test(f) && f !== '000_bootstrap.sql');
    expect(three.length).toBeGreaterThan(40);
    expect(orderMigrations(three)).toEqual([...three].sort());
  });
  it('rejects a name with no numeric prefix', () => {
    expect(() => orderMigrations(['readme.sql'])).toThrow(/must start with digits/);
  });
});
