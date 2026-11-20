import { D } from '@/lib/format';
import type { InventorySettingsAdjustmentApprover, StockAdjustmentKind } from '@/lib/api/backend/model';

/**
 * Adjustment rules (pure) — contract 0.8.2 §4. Every request starts pending; the server enforces who may decide
 * (403 approver_rule / self_approval). These helpers only shape the form and hide buttons the server would refuse.
 */
/** 0.8.2: every reason / note is trimmed and ≥ 3 characters (reasons, reject / approve notes, return, partial receipt). */
export const MIN_TEXT = 3;
export const REASON_MIN = MIN_TEXT;
/** Required text: trimmed ≥ 3. */
export const textOk = (s: string | null | undefined): boolean => (s ?? '').trim().length >= MIN_TEXT;
/** Optional text: empty, or trimmed ≥ 3 ("when given, ≥ 3"). */
export const optionalTextOk = (s: string | null | undefined): boolean => { const n = (s ?? '').trim().length; return n === 0 || n >= MIN_TEXT; };
export const REASON_MAX = 500;

/**
 * Which deltas a kind needs and their sign (the user types a size; we sign it). 0.8.2: write_off is PARTIAL (some weight
 * must go; may not take a piece to zero pieces → 422 use_full_write_off); full_write_off needs a tag and its deltas are
 * minus the piece's own pieces / gross / net (filled from the piece, see `fullWriteOffDeltas`).
 */
export const KIND_SHAPE: Record<StockAdjustmentKind, { weight: 'neg' | 'pos' | 'signed' | null; pieces: 'neg' | 'pos' | null }> = {
  weight_loss: { weight: 'neg', pieces: null },
  weight_gain: { weight: 'pos', pieces: null },
  piece_loss: { weight: 'neg', pieces: 'neg' },
  piece_gain: { weight: 'pos', pieces: 'pos' },
  write_off: { weight: 'neg', pieces: null },
  full_write_off: { weight: null, pieces: null },
  correction: { weight: 'signed', pieces: null },
};

const WT_RE = /^-?\d{1,6}(\.\d{1,3})?$/;
/** A typed weight → a signed 3-dp string per the kind, or null (empty / zero / bad). */
export function signedWeight(raw: string, sign: 'neg' | 'pos' | 'signed'): string | null {
  const v = raw.trim().replace(/,/g, '');
  if (!WT_RE.test(v) || (sign !== 'signed' && v.startsWith('-'))) return null;
  const d = D(v);
  if (d.isZero()) return null;
  const signed = sign === 'neg' ? d.abs().negated() : sign === 'pos' ? d.abs() : d;
  return signed.toDecimalPlaces(3).toFixed(3);
}

export type AdjustmentFormError = 'inventory.adj.err.reason' | 'inventory.adj.err.weight' | 'inventory.adj.err.pieces' | 'inventory.adj.err.fullNeedsTag';
export function adjustmentError(kind: StockAdjustmentKind, reason: string, wt: string, pieces: string, isTag: boolean): AdjustmentFormError | null {
  const r = reason.trim().length;
  if (r < REASON_MIN || r > REASON_MAX) return 'inventory.adj.err.reason';
  const s = KIND_SHAPE[kind];
  if (s.pieces && !(isTag && kind === 'piece_loss') && !/^[1-9]\d{0,3}$/.test(pieces.trim())) return 'inventory.adj.err.pieces';
  if (kind === 'full_write_off') return isTag ? null : 'inventory.adj.err.fullNeedsTag';
  if (s.weight && !signedWeight(wt, s.weight)) return 'inventory.adj.err.weight';
  return null;
}

/** full_write_off deltas = minus the piece's current pieces / gross / net (422 invalid_delta otherwise). */
export function fullWriteOffDeltas(piece: { pieces: number; gross_wt: string; net_wt: string }): { pieces_delta: number; gross_wt_delta: string; net_wt_delta: string } {
  const neg = (w: string) => { const d = D(w).abs().negated(); return d.isZero() ? '0.000' : d.toDecimalPlaces(3).toFixed(3); };
  return { pieces_delta: -Math.abs(piece.pieces), gross_wt_delta: neg(piece.gross_wt), net_wt_delta: neg(piece.net_wt) };
}

/**
 * Should we show Approve/Reject to this user? Mirrors the server: pending only; the approver rule (owner_only /
 * owner_or_manager); a non-owner never decides their own request (an owner may — recorded as self_approved).
 */
export function canApprove(
  me: { id: string; roles: readonly string[] },
  req: { requested_by: string; status: string },
  approver: InventorySettingsAdjustmentApprover,
): boolean {
  if (req.status !== 'pending') return false;
  const owner = me.roles.includes('owner');
  if (owner) return true;
  if (approver !== 'owner_or_manager' || !me.roles.includes('manager')) return false;
  return req.requested_by !== me.id;
}
