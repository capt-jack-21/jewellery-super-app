/** PAN / KYC are masked by default: only the last 4 characters are ever shown ("••••••234F"). */
export function maskLast4(last4: string | null | undefined, totalLen = 10): string {
  if (!last4) return '';
  const tail = last4.slice(-4);
  return `${'•'.repeat(Math.max(totalLen - tail.length, 4))}${tail}`;
}
/** Full value → last 4 (used by the mock server; the real server does this). */
export const last4 = (v: string | null | undefined): string | null => (v ? v.replace(/\s/g, '').slice(-4).toUpperCase() : null);
