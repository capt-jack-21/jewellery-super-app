import { type InventoryActor, need, needBranch, isOwner, isManager, canSeeBranch } from './actor';
import { checkVersion, fail, invalid } from './errors';
import { audit, branchCode, ledger, lockTag, nextDocNo, one, outbox, tx, writeTag, gm, mg, type LedgerRow, type TagRow, iso } from './db';
import { loadSettings } from './settings';
import { requireLoose } from './loose';
import { assertTransition, TERMINAL } from './statuses';
import { docPrefixOf, indianFY, renderDocNo, todayIST } from './numbering';
import { validateLocation } from './tags';

export type AdjustmentKind = 'weight_loss' | 'weight_gain' | 'piece_loss' | 'piece_gain' | 'write_off' | 'full_write_off' | 'correction';
export const REASON_CODES = ['polishing', 'repair', 'breakage', 'loss', 'count_error', 'weighing_error', 'melting_loss', 'other'] as const;
export interface AdjustmentInput {
  branch_id: string; kind: AdjustmentKind; tag_id?: string | null; item_id?: string | null; purity_id?: string | null;
  counter_id?: string | null; tray_id?: string | null; delta_pieces?: number; delta_gross_wt?: string; delta_net_wt?: string;
  reason_code: (typeof REASON_CODES)[number]; reason: string;
}
export interface Adjustment {
  id: string; adjustment_no: string | null; branch_id: string; kind: AdjustmentKind; tag_id: string | null; item_id: string | null; purity_id: string | null;
  counter_id: string | null; tray_id: string | null; delta_pieces: number; delta_gross_wt: string; delta_net_wt: string; reason_code: string; reason: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled'; requested_by: string; requested_at: string; decided_by: string | null;
  decided_as_role: 'owner' | 'manager' | null; decided_at: string | null; decision_note: string | null; approval_request_id: string | null; version: number;
}
export const ADJ_COLS = `id, adjustment_no, branch_id, kind, tag_id, item_id, purity_id, counter_id, box_id AS tray_id, delta_pieces, delta_gross_wt::text,
  delta_net_wt::text, reason_code, reason, status, requested_by, ${iso('requested_at')}, decided_by, decided_as_role, ${iso('decided_at')}, decision_note,
  approval_request_id, version`;
async function load(id: string, lock = false): Promise<Adjustment> {
  return (await one<Adjustment>(`SELECT ${ADJ_COLS} FROM inventory.stock_adjustment WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [id])) ?? fail(404, 'not_found', 'adjustment');
}
export async function getAdjustment(a: InventoryActor, id: string) {
  need(a, 'inventory.stock.view');
  const r = await load(id);
  if (!canSeeBranch(a, r.branch_id)) fail(404, 'not_found', 'adjustment');
  return r;
}

const deltaErr = (m: string): never => fail(422, 'invalid_delta', m);
function checkSigns(kind: AdjustmentKind, p: number, g: bigint, n: bigint): void {
  if (p === 0 && g === 0n && n === 0n) deltaErr('at least one delta must be non-zero');
  const ok: Record<AdjustmentKind, boolean> = {
    weight_loss: g < 0n && n <= 0n, weight_gain: g > 0n && n >= 0n, piece_loss: p < 0, piece_gain: p > 0,
    write_off: p <= 0 && g <= 0n && n <= 0n, full_write_off: p < 0 && g < 0n && n <= 0n, correction: true,
  };
  if (!ok[kind]) deltaErr(`deltas do not fit kind ${kind}`);
}
/** Checks a tag adjustment against the piece as it is now; returns the new figures. 409 adjustment_stale when it no longer fits. */
function applyToTag(t: TagRow, kind: AdjustmentKind, p: number, g: bigint, n: bigint, stale: boolean) {
  const err = (code: string, m: string): never => (stale ? fail(409, 'adjustment_stale', m) : fail(422, code, m));
  if (kind === 'full_write_off') {
    if (p !== -t.pieces || g !== -mg(t.gross_wt) || n !== -mg(t.net_wt))
      err('invalid_delta', 'a full write-off takes exactly minus the piece\'s pieces, gross and net weight');
    return null;
  }
  const pieces = t.pieces + p, gross = mg(t.gross_wt) + g, net = mg(t.net_wt) + n;
  if (pieces < 1 || gross <= 0n || net <= 0n) err('use_full_write_off', 'this would leave nothing of the piece; use kind full_write_off');
  if (net > gross || mg(t.stone_wt) > gross) err('invalid_delta', 'net must stay ≤ gross and stone ≤ gross');
  return { pieces, gross_wt: gm(gross), net_wt: gm(net) };
}
function checkTagUsable(t: TagRow): void {
  if (t.status === 'written_off') fail(409, 'tag_written_off', `${t.tag_no} is written off`);
  if (TERMINAL.has(t.status) || t.status === 'in_transit') fail(409, 'tag_not_available', `${t.tag_no} is ${t.status}`);
}

/** Request (inventory.adjustment.request). Pending until approved; nothing changes in stock yet. */
export async function requestAdjustment(a: InventoryActor, i: AdjustmentInput): Promise<Adjustment> {
  need(a, 'inventory.adjustment.request');
  needBranch(a, i.branch_id);
  if (!REASON_CODES.includes(i.reason_code)) invalid('reason_code', 'unknown reason code');
  if (!i.reason || i.reason.trim().length < 3 || i.reason.trim().length > 500) invalid('reason', '3-500 characters');
  const p = i.delta_pieces ?? 0, g = mg(i.delta_gross_wt ?? '0'), n = mg(i.delta_net_wt ?? '0');
  if (!Number.isInteger(p)) invalid('delta_pieces', 'whole number');
  checkSigns(i.kind, p, g, n);
  let counterId = i.counter_id ?? null, boxId = i.tray_id ?? null, itemId = i.item_id ?? null, purityId = i.purity_id ?? null;
  if (i.tag_id) {
    const t = await lockTag(i.tag_id);
    if (t.branch_id !== i.branch_id) fail(409, 'wrong_branch', `${t.tag_no} is not in this branch`);
    checkTagUsable(t);
    applyToTag(t, i.kind, p, g, n, false);
    if (i.kind === 'full_write_off') {
      const dup = await one(`SELECT 1 FROM inventory.stock_adjustment WHERE tag_id = $1 AND kind = 'full_write_off' AND status = 'pending'`, [i.tag_id]);
      if (dup) fail(409, 'adjustment_pending', 'a full write-off of this piece is already waiting for approval');
    }
    counterId = t.counter_id; boxId = t.box_id; itemId = null; purityId = null;
  } else {
    if (i.kind === 'full_write_off') invalid('tag_id', 'a full write-off is for one tagged piece', 'tag_required');
    if (!itemId || !purityId) invalid('item_id', 'tag_id, or item_id + purity_id');
    await validateLocation(i.branch_id, counterId, boxId);
    if (p < 0 || g < 0n || n < 0n) await requireLoose(i.branch_id, itemId!, purityId!, counterId, boxId, Math.max(-p, 0), g < 0n ? -g : 0n, n < 0n ? -n : 0n);
  }
  const code = await branchCode(i.branch_id);
  const fy = indianFY(todayIST());
  const fmt = (await loadSettings()).adjustment_no_format;   // shop_setting.adjustment_no_format (987), default ADJ-{BRANCH}-{FY}-{SEQ:5}
  const no = renderDocNo(fmt, { branchCode: code, fy },
    await nextDocNo(i.branch_id, 'stock_adjustment', fy, docPrefixOf(fmt, { branchCode: code, fy })));
  const r = (await one<{ id: string }>(`INSERT INTO inventory.stock_adjustment(tenant_id, branch_id, adjustment_no, kind, tag_id, item_id, purity_id, counter_id,
      box_id, delta_pieces, delta_gross_wt, delta_net_wt, reason_code, reason, requested_by)
     VALUES (platform.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
    [i.branch_id, no, i.kind, i.tag_id ?? null, itemId, purityId, counterId, boxId, p, gm(g), gm(n), i.reason_code, i.reason.trim(), a.userId]))!;
  const s = await loadSettings();
  await outbox('inventory.adjustment_pending', { adjustment_id: r.id, adjustment_no: no, branch_id: i.branch_id, kind: i.kind,
    approver_rule: s.adjustment_approver });
  return load(r.id);
}

/** The approver's role of record, or 403. owner_only → owners; owner_or_manager → owners, or managers of that branch. */
function approverRole(a: InventoryActor, branchId: string, rule: 'owner_or_manager' | 'owner_only'): 'owner' | 'manager' {
  need(a, 'inventory.adjustment.approve');
  if (isOwner(a)) return 'owner';
  if (rule === 'owner_only') fail(403, 'approver_rule', 'only the owner approves adjustments in this shop');
  if (!isManager(a)) fail(403, 'approver_rule', 'only an owner or manager approves adjustments');
  needBranch(a, branchId);
  return 'manager';
}

/**
 * Approve and apply (as inventory_writer). Self-approval only for the owner (audited inventory.adjustment.self_approved).
 * full_write_off: the piece becomes written_off (the only way there) + an adjustment ledger row for the whole piece.
 */
export async function approveAdjustment(a: InventoryActor, id: string, note?: string | null, ifVersion?: number): Promise<Adjustment> {
  const adj = await load(id, true);
  checkVersion('adjustment', adj.version, ifVersion);
  const role = approverRole(a, adj.branch_id, (await loadSettings()).adjustment_approver);
  if (adj.status !== 'pending') fail(409, 'invalid_state', `adjustment is ${adj.status}`);
  const self = adj.requested_by === a.userId;
  if (self && role !== 'owner') fail(403, 'self_approval', 'someone else must approve your own request');
  const p = adj.delta_pieces, g = mg(adj.delta_gross_wt), n = mg(adj.delta_net_wt);
  const rows: LedgerRow[] = [];
  const base = { branch_id: adj.branch_id, movement: 'adjustment', source_type: 'stock_adjustment', source_id: id, user_id: a.userId };
  const split = (common: Omit<LedgerRow, 'direction' | 'pieces' | 'gross_wt' | 'net_wt'>) => {
    const neg = { pieces: Math.max(-p, 0), g: g < 0n ? -g : 0n, n: n < 0n ? -n : 0n };
    const pos = { pieces: Math.max(p, 0), g: g > 0n ? g : 0n, n: n > 0n ? n : 0n };
    for (const [d, v] of [[-1, neg], [1, pos]] as const)
      if (v.pieces || v.g || v.n) rows.push({ ...common, direction: d, pieces: v.pieces, gross_wt: gm(v.g), net_wt: gm(v.n) });
  };
  if (adj.tag_id) {
    const t = await lockTag(adj.tag_id);
    if (t.status === 'written_off') fail(409, 'tag_written_off', `${t.tag_no} is already written off`);
    if (TERMINAL.has(t.status) || t.status === 'in_transit' || t.branch_id !== adj.branch_id) fail(409, 'adjustment_stale', `${t.tag_no} is ${t.status} now`);
    const next = applyToTag(t, adj.kind, p, g, n, true);
    const common = { ...base, tag_id: t.id, item_id: t.item_id, purity_id: t.purity_id, counter_id: t.counter_id, box_id: t.box_id };
    if (adj.kind === 'full_write_off') {
      assertTransition(t.status, 'written_off', 'full_write_off');
      await writeTag(t.id, { status: 'written_off' });
      rows.push({ ...common, direction: -1, pieces: t.pieces, gross_wt: t.gross_wt, net_wt: t.net_wt });
    } else {
      await writeTag(t.id, { pieces: next!.pieces, gross_wt: next!.gross_wt, net_wt: next!.net_wt });
      split(common);
    }
  } else {
    if (p < 0 || g < 0n || n < 0n)
      await requireLoose(adj.branch_id, adj.item_id!, adj.purity_id!, adj.counter_id, adj.tray_id, Math.max(-p, 0), g < 0n ? -g : 0n, n < 0n ? -n : 0n)
        .catch(() => fail(409, 'adjustment_stale', 'the loose balance is lower than this adjustment now'));
    split({ ...base, item_id: adj.item_id, purity_id: adj.purity_id!, counter_id: adj.counter_id, box_id: adj.tray_id });
  }
  await ledger(rows);
  await tx().query(`UPDATE inventory.stock_adjustment SET status = 'approved', decided_by = $2, decided_as_role = $3, decided_at = now(), decision_note = $4
     WHERE id = $1`, [id, a.userId, role, note ?? null]);
  if (self) await audit('inventory.adjustment.self_approved', 'inventory.stock_adjustment', id,
    { adjustment_no: adj.adjustment_no, kind: adj.kind, decided_as_role: role });
  return load(id);
}
export async function rejectAdjustment(a: InventoryActor, id: string, note: string, ifVersion?: number): Promise<Adjustment> {
  const adj = await load(id, true);
  checkVersion('adjustment', adj.version, ifVersion);
  const role = approverRole(a, adj.branch_id, (await loadSettings()).adjustment_approver);
  if (!note || note.trim().length < 3) invalid('note', 'at least 3 characters');
  if (adj.status !== 'pending') fail(409, 'invalid_state', `adjustment is ${adj.status}`);
  await tx().query(`UPDATE inventory.stock_adjustment SET status = 'rejected', decided_by = $2, decided_as_role = $3, decided_at = now(), decision_note = $4
     WHERE id = $1`, [id, a.userId, role, note.trim()]);
  return load(id);
}
/** The requester withdraws a pending request. */
export async function cancelAdjustment(a: InventoryActor, id: string, ifVersion?: number): Promise<Adjustment> {
  need(a, 'inventory.adjustment.request');
  const adj = await load(id, true);
  checkVersion('adjustment', adj.version, ifVersion);
  if (adj.requested_by !== a.userId) fail(403, 'forbidden', 'only the requester can cancel');
  if (adj.status !== 'pending') fail(409, 'invalid_state', `adjustment is ${adj.status}`);
  await tx().query(`UPDATE inventory.stock_adjustment SET status = 'cancelled' WHERE id = $1`, [id]);
  return load(id);
}
