/**
 * Lots (0.8.3, removal 0.8.4) — pure rules for the lot and draft-transfer editors, unit-tested in inventory.test.ts.
 * A lot is a bulk receipt (open → tagged → closed) that pieces are tagged from over time. PATCH sends the WHOLE line list:
 * a line with id changes in place, one without is added, and (0.8.4) a saved line left out is DELETED. Only untagged
 * lines can go: a left-out line with tagged pieces → 409 line_tagged for the whole request, so the editor locks those.
 * 'tagged' lots still count as open (editable); only 'closed' is final.
 */
import { D } from '@/lib/format';
import { netWeight, parseWeight } from './piece-rules';
import type { Picked } from './picker';
import type { Lot, LotLine, LotLineInput, StockTransferLine, StockTransferLineInput } from '@/lib/api/backend/model';

/** Lot numbers the server makes: LOT-{BRANCH}-{FY}-{SEQ:5}; a typed one may be up to 30 characters. */
export const LOT_NO_MAX = 30;
/** Supplier's lot / packet reference on a piece (tag.vendor_lot_ref, 0.8.3): trimmed, 1–60 characters. */
export const VENDOR_LOT_REF_MAX = 60;

/** '' → undefined (leave out), else the trimmed value; null when too long. */
export function vendorLotRef(raw: string): string | undefined | null {
  const v = raw.trim();
  if (!v) return undefined;
  return v.length > VENDOR_LOT_REF_MAX ? null : v;
}

export interface LotLineDraft { id?: string; item_id: string; purity_id: string; pieces: string; gross_wt: string; net_wt: string; tagged_pieces: number }
export const blankLotLine = (): LotLineDraft => ({ item_id: '', purity_id: '', pieces: '1', gross_wt: '', net_wt: '', tagged_pieces: 0 });
export const lotLineDraft = (l: LotLine): LotLineDraft => ({
  id: l.id, item_id: l.item_id, purity_id: l.purity_id ?? '', pieces: String(l.pieces), gross_wt: l.gross_wt, net_wt: l.net_wt, tagged_pieces: l.tagged_pieces,
});

export type LotLineError = 'inventory.err.item' | 'inventory.err.pcs' | 'inventory.err.gross' | 'inventory.lots.err.net' | 'inventory.lots.err.belowTagged';

/** Mirrors the server: item required, whole pieces ≥ 0 (≥ 1 for a new line), gross > 0, 0 ≤ net ≤ gross, never below what is tagged. */
export function lotLineError(d: LotLineDraft): LotLineError | null {
  if (!d.item_id) return 'inventory.err.item';
  if (!/^\d{1,5}$/.test(d.pieces.trim()) || (!d.id && Number(d.pieces) < 1)) return 'inventory.err.pcs';
  if (Number(d.pieces) < d.tagged_pieces) return 'inventory.lots.err.belowTagged';
  const g = parseWeight(d.gross_wt);
  if (!g) return 'inventory.err.gross';
  const n = parseWeight(d.net_wt || d.gross_wt, true);
  if (n === null || netWeight(g, n) === null) return 'inventory.lots.err.net';
  return null;
}

/** Valid drafts → LotLineInput[] (net defaults to gross). Only call when every lotLineError() is null. */
export function toLotLines(ds: readonly LotLineDraft[]): LotLineInput[] {
  return ds.map((d) => {
    const g = parseWeight(d.gross_wt) ?? '0.000';
    return {
      ...(d.id ? { id: d.id } : {}), item_id: d.item_id, purity_id: d.purity_id || null, pieces: Number(d.pieces),
      gross_wt: g, net_wt: parseWeight(d.net_wt || d.gross_wt, true) ?? g,
    };
  });
}

/** Saved lines missing from the edited list: the PATCH deletes them (0.8.4), so the editor asks first. */
export const removedLotLines = (lot: Pick<Lot, 'lines'>, ds: readonly LotLineDraft[]): LotLine[] =>
  (lot.lines ?? []).filter((l) => !ds.some((d) => d.id === l.id));
/** A saved line may be removed only while nothing has been tagged from it (else 409 line_tagged). */
export const canRemoveLotLine = (d: Pick<LotLineDraft, 'tagged_pieces'>): boolean => d.tagged_pieces === 0;
/** 'open' and 'tagged' lots can be edited, tagged from (if pieces are left) and closed; 'closed' is final. */
export const lotIsOpen = (lot: Pick<Lot, 'status'>): boolean => lot.status === 'open' || lot.status === 'tagged';

/** Tagging progress for the list: tagged / total pieces and the untagged gross weight. */
export function lotProgress(lot: Pick<Lot, 'lines' | 'totals'>): { tagged: number; total: number; remainingGross: string } {
  const lines = lot.lines ?? [];
  const total = lot.totals?.pieces ?? lines.reduce((n, l) => n + l.pieces, 0);
  const tagged = lot.totals?.tagged_pieces ?? lines.reduce((n, l) => n + l.tagged_pieces, 0);
  const remainingGross = lot.totals?.remaining_gross_wt
    ?? lines.reduce((s, l) => s.plus(D(l.remaining_gross_wt ?? D(l.gross_wt).minus(D(l.tagged_gross_wt)).toFixed(3))), D('0')).toFixed(3);
  return { tagged, total, remainingGross };
}

/** A line still has pieces to tag. */
export const lineRemaining = (l: Pick<LotLine, 'pieces' | 'tagged_pieces' | 'remaining_pieces'>): number => l.remaining_pieces ?? Math.max(0, l.pieces - l.tagged_pieces);

/**
 * Draft transfer PATCH lines: loose lines are kept exactly as saved, then one { tag_id } per picked piece (pieces already
 * on the draft keep their line on the server). Pieces dropped from `picked` are deleted from the draft (0.8.4);
 * removedTransferLines lists them so the editor can ask first.
 */
export function transferPatchLines(existing: readonly StockTransferLine[], picked: readonly Pick<Picked, 'id'>[]): StockTransferLineInput[] {
  const loose: StockTransferLineInput[] = existing.filter((l) => !l.tag_id).map((l) => ({
    item_id: l.item_id ?? undefined, purity_id: l.purity_id ?? undefined, pieces: l.pieces, gross_wt: l.gross_wt, net_wt: l.net_wt,
    from_counter_id: l.from_counter_id ?? null, from_tray_id: l.from_tray_id ?? null,
  }));
  return [...loose, ...picked.map((p) => ({ tag_id: p.id }))];
}
export const removedTransferLines = (existing: readonly StockTransferLine[], picked: readonly Pick<Picked, 'id'>[]): string[] =>
  existing.filter((l) => l.tag_id && !picked.some((p) => p.id === l.tag_id)).map((l) => l.tag_no ?? l.tag_id ?? l.id);
