import { D } from '@/lib/format';
import type { Metal, Purity } from '@/lib/api/backend/model';

/**
 * Derived purity rates (decimal.js only, no floats): rate(p) = base × fineness(p) / fineness(base), 2 dp half-up.
 * Base purity = the metal's finest active purity (24K gold 999.9, fine silver 999).
 */
export function basePurity(purities: readonly Purity[], metalId: string): Purity | undefined {
  return purities.filter((p) => p.metal_id === metalId && p.is_active)
    .reduce<Purity | undefined>((b, p) => (!b || D(p.fineness).gt(D(b.fineness)) ? p : b), undefined);
}

export function deriveRate(baseRate: string, baseFineness: string, fineness: string): string {
  return D(baseRate).times(D(fineness)).dividedBy(D(baseFineness)).toDecimalPlaces(2, 4 /* ROUND_HALF_UP */).toFixed(2);
}

export interface DerivedRow { purity: Purity; rate: string; isBase: boolean }
export function deriveAll(purities: readonly Purity[], metalId: string, baseRate: string): DerivedRow[] {
  const base = basePurity(purities, metalId);
  if (!base) return [];
  return purities.filter((p) => p.metal_id === metalId && p.is_active)
    .sort((a, b) => D(b.fineness).comparedTo(D(a.fineness)))
    .map((p) => ({ purity: p, isBase: p.id === base.id, rate: p.id === base.id ? D(baseRate).toFixed(2) : deriveRate(baseRate, base.fineness, p.fineness) }));
}

/** Metals in a stable order: active only, gold first, then by code. */
export const sortMetals = (ms: readonly Metal[]) => ms.filter((m) => m.is_active).sort((a, b) => (a.code === 'GOLD' ? -1 : b.code === 'GOLD' ? 1 : a.code.localeCompare(b.code)));

/** Which row is in effect for a purity: branch override or shop-wide. */
export type RateScope = 'branch' | 'shop';
export const scopeOf = (r: { branch_id?: string | null }): RateScope => (r.branch_id ? 'branch' : 'shop');
export const istDay = (d: string | Date) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
