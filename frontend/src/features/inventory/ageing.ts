/**
 * Ageing (contract 0.8.2): the SERVER computes the buckets (GET /v1/inventory/reports/ageing) from
 * settings.ageing_bucket_days. The client only edits that list and labels the buckets the server returns.
 * [30, 90, 180, 365] → 0–29, 30–89, 90–179, 180–364, 365+ days.
 */
export const DEFAULT_AGEING_EDGES = [30, 90, 180, 365] as const;
export const AGEING_MAX_DAYS = 3650;
export const AGEING_MAX_EDGES = 8;

/** 1–8 ascending whole days, each 1–3650 (the server also sorts and de-duplicates, but we ask for a clean list). */
export function validEdges(edges: readonly number[]): boolean {
  return edges.length > 0 && edges.length <= AGEING_MAX_EDGES
    && edges.every((e, i) => Number.isInteger(e) && e >= 1 && e <= AGEING_MAX_DAYS && (i === 0 || e > (edges[i - 1] ?? 0)));
}

/** Parse "30, 90, 180" typed by a user; null when invalid. */
export function parseEdges(raw: string): number[] | null {
  const parts = raw.split(/[,\s]+/).filter(Boolean);
  if (!parts.every((p) => /^\d+$/.test(p))) return null;
  const e = parts.map(Number);
  return validEdges(e) ? e : null;
}

/** A server bucket → { from, to } for the "{from}–{to} days" / "{from}+ days" label. */
export const bucketRange = (b: { from_days: number; to_days?: number | null }) => ({ from: b.from_days, to: b.to_days ?? null });
