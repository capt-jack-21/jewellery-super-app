import { type InventoryActor, need, needBranch, canSeeBranch } from './actor';
import { checkVersion, fail, invalid } from './errors';
import { audit, branchCode, ledger, lockTags, many, nextDocNo, one, tx, writeTag, gm, mg, type LedgerRow, iso } from './db';
import { validateLocation } from './tags';
import { requireLoose } from './loose';
import { assertTransition } from './statuses';
import { docPrefixOf, indianFY, renderDocNo, todayIST } from './numbering';
import { loadSettings } from './settings';

export interface TransferLineInput {
  tag_id?: string; item_id?: string; purity_id?: string; from_counter_id?: string | null; from_tray_id?: string | null;
  pieces?: number; gross_wt?: string; net_wt?: string;
}
export interface TransferLine {
  id: string; tag_id: string | null; tag_no: string | null; item_id: string | null; purity_id: string | null; pieces: number;
  gross_wt: string; net_wt: string; from_counter_id: string | null; from_tray_id: string | null;
  received: boolean; received_at: string | null; received_by: string | null;
}
export interface Transfer {
  id: string; transfer_no: string; from_branch_id: string; to_branch_id: string;
  status: 'draft' | 'approved' | 'in_transit' | 'received' | 'returned' | 'cancelled'; remarks: string | null; requested_by: string | null;
  approved_by: string | null; dispatched_at: string | null; dispatched_by: string | null; received_at: string | null; received_by: string | null;
  cancelled_at: string | null; version: number; lines: TransferLine[];
}
export const T_COLS = `id, transfer_no, from_branch_id, to_branch_id, status, remarks, requested_by, approved_by, ${iso('dispatched_at')}, dispatched_by,
  ${iso('received_at')}, received_by, ${iso('cancelled_at')}, version`;

async function load(id: string, lock = false): Promise<Transfer> {
  const t = await one<Omit<Transfer, 'lines'>>(`SELECT ${T_COLS} FROM inventory.stock_transfer WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
  if (!t) fail(404, 'not_found', 'transfer');
  return { ...t, lines: (await linesOf([id])).get(id) ?? [] };
}
/** Lines of one or more transfers (GET /transfers/{id} and, 0.8.8, every row of GET /transfers: the contract Transfer requires lines). */
export async function linesOf(ids: string[]): Promise<Map<string, TransferLine[]>> {
  const out = new Map<string, TransferLine[]>(ids.map((i) => [i, []]));
  if (!ids.length) return out;
  const rows = await many<TransferLine & { transfer_id: string }>(`SELECT l.transfer_id, l.id, l.tag_id, t.tag_no, coalesce(l.item_id, t.item_id) AS item_id,
      coalesce(l.purity_id, t.purity_id) AS purity_id, l.pieces, l.gross_wt::text, l.net_wt::text, l.from_counter_id, l.from_box_id AS from_tray_id,
      l.received, ${iso('l.received_at')}, l.received_by
    FROM inventory.stock_transfer_line l LEFT JOIN inventory.tag t ON t.id = l.tag_id WHERE l.transfer_id = ANY($1::uuid[]) ORDER BY l.transfer_id, l.id`, [ids]);
  for (const { transfer_id, ...l } of rows) out.get(transfer_id)!.push(l);
  return out;
}
const visible = (a: InventoryActor, t: Transfer) => canSeeBranch(a, t.from_branch_id) || canSeeBranch(a, t.to_branch_id);
export async function getTransfer(a: InventoryActor, id: string): Promise<Transfer> {
  need(a, 'inventory.stock.view');
  const t = await load(id);
  if (!visible(a, t)) fail(404, 'not_found', 'transfer');
  return t;
}

/** Writes line k into slots[k] (an existing stock_transfer_line of this draft, UPDATE) or a new row (INSERT). */
async function writeLine(slot: string | undefined, transferId: string, v: { tag_id: string | null; item_id: string | null; purity_id: string | null; pieces: number;
  gross_wt: string; net_wt: string; from_counter_id: string | null; from_box_id: string | null }): Promise<void> {
  const args = [v.tag_id, v.item_id, v.purity_id, v.pieces, v.gross_wt, v.net_wt, v.from_counter_id, v.from_box_id];
  if (slot) {
    await tx().query(`UPDATE inventory.stock_transfer_line SET tag_id = $2, item_id = $3, purity_id = $4, pieces = $5, gross_wt = $6, net_wt = $7,
        from_counter_id = $8, from_box_id = $9 WHERE id = $1`, [slot, ...args]);
  } else {
    await tx().query(`INSERT INTO inventory.stock_transfer_line(tenant_id, transfer_id, tag_id, item_id, purity_id, pieces, gross_wt, net_wt, from_counter_id, from_box_id)
       VALUES (platform.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9)`, [transferId, ...args]);
  }
}
async function addLines(transferId: string, fromBranch: string, lines: TransferLineInput[], slots: (string | undefined)[] = []): Promise<void> {
  if (!lines.length || lines.length > 500) invalid('lines', '1-500');
  const tagIds = lines.filter((l) => l.tag_id).map((l) => l.tag_id!);
  if (new Set(tagIds).size !== tagIds.length) invalid('lines', 'a piece is listed twice', 'duplicate_tag');
  const tags = tagIds.length ? await lockTags(tagIds) : new Map();
  for (const [k, l] of lines.entries()) {
    if (l.tag_id) {
      const t = tags.get(l.tag_id)!;
      if (t.status === 'written_off') fail(409, 'tag_written_off', `${t.tag_no} is written off`);
      if (t.branch_id !== fromBranch) fail(409, 'wrong_branch', `${t.tag_no} is not in the sending branch`);
      if (t.status !== 'in_stock') fail(409, 'tag_not_available', `${t.tag_no} is ${t.status}`);
      const busy = await one<{ transfer_no: string }>(`SELECT s.transfer_no FROM inventory.stock_transfer_line l JOIN inventory.stock_transfer s ON s.id = l.transfer_id
         WHERE l.tag_id = $1 AND s.status IN ('draft','approved','in_transit') AND s.id <> $2 AND NOT l.received LIMIT 1`, [l.tag_id, transferId]);
      if (busy) fail(409, 'tag_on_transfer', `${t.tag_no} is already on ${busy.transfer_no}`);
      await writeLine(slots[k], transferId, { tag_id: l.tag_id, item_id: null, purity_id: null, pieces: t.pieces, gross_wt: t.gross_wt, net_wt: t.net_wt,
        from_counter_id: null, from_box_id: null });
    } else {
      if (!l.item_id || !l.purity_id || l.gross_wt === undefined || l.net_wt === undefined) invalid(`lines[${k}]`, 'tag_id, or item_id + purity_id + gross_wt + net_wt');
      // 988: loose lines may leave from a counter / tray of the sending branch (from_counter_id, from_box_id; a tray needs its counter)
      const fc = l.from_counter_id ?? null, fb = l.from_tray_id ?? null;
      if (fb && !fc) invalid(`lines[${k}].from_counter_id`, 'a tray needs its counter', 'tray_needs_counter');
      await validateLocation(fromBranch, fc, fb);
      const g = mg(l.gross_wt!), n = mg(l.net_wt!);
      if (g <= 0n || n < 0n || n > g) invalid(`lines[${k}].gross_wt`, '0 < gross, 0 ≤ net ≤ gross');
      await requireLoose(fromBranch, l.item_id!, l.purity_id!, fc, fb, l.pieces ?? 0, g, n);
      await writeLine(slots[k], transferId, { tag_id: null, item_id: l.item_id!, purity_id: l.purity_id!, pieces: l.pieces ?? 0, gross_wt: gm(g), net_wt: gm(n),
        from_counter_id: fc, from_box_id: fb });
    }
  }
}

/** Create a draft (inventory.transfer.dispatch at the sending branch). transfer_no TRF-{BRANCH}-{FY}-{SEQ:5}, server-assigned. */
export async function createTransfer(a: InventoryActor, i: { from_branch_id: string; to_branch_id: string; lines: TransferLineInput[]; remarks?: string | null }) {
  need(a, 'inventory.transfer.dispatch');
  needBranch(a, i.from_branch_id);
  if (i.from_branch_id === i.to_branch_id) invalid('to_branch_id', 'must differ from from_branch_id', 'same_branch');
  await branchCode(i.to_branch_id);
  const code = await branchCode(i.from_branch_id);
  const fy = indianFY(todayIST());
  const fmt = (await loadSettings()).transfer_no_format;   // shop_setting.transfer_no_format (987), default TRF-{BRANCH}-{FY}-{SEQ:5}
  const seq = await nextDocNo(i.from_branch_id, 'stock_transfer', fy, docPrefixOf(fmt, { branchCode: code, fy }));
  const no = renderDocNo(fmt, { branchCode: code, fy }, seq);
  const t = (await one<{ id: string }>(`INSERT INTO inventory.stock_transfer(tenant_id, transfer_no, from_branch_id, to_branch_id, status, requested_by, remarks)
     VALUES (platform.current_tenant(), $1, $2, $3, 'draft', $4, $5) RETURNING id`, [no, i.from_branch_id, i.to_branch_id, a.userId, i.remarks ?? null]))!;
  await addLines(t.id, i.from_branch_id, i.lines);
  return load(t.id);
}
/**
 * Edit a DRAFT (inventory.transfer.dispatch at the sending branch; If-Match). lines replace the list as a whole: rows are reused in
 * place (a piece already on the draft keeps its row), extra lines are added, rows left over are deleted (0.8.4), all in the request
 * transaction. The DB backs the draft rule (988 rw_delete_draft_only); a delete it blocks touches 0 rows → removeTransferLine.
 */
export async function updateTransfer(a: InventoryActor, id: string, p: { remarks?: string | null; lines?: TransferLineInput[] }, ifVersion?: number) {
  need(a, 'inventory.transfer.dispatch');
  if (!p || !Object.keys(p).length) invalid('(body)', 'empty patch');
  if (p.remarks != null && (typeof p.remarks !== 'string' || p.remarks.length > 500)) invalid('remarks', 'at most 500 characters');
  const t = await load(id, true);
  if (!visible(a, t)) fail(404, 'not_found', 'transfer');
  needBranch(a, t.from_branch_id);
  checkVersion('transfer', t.version, ifVersion);
  if (t.status !== 'draft') fail(409, 'transfer_not_draft', `transfer is ${t.status}`);
  if (p.lines) {
    if (!p.lines.length || p.lines.length > 500) invalid('lines', '1-500');   // before any delete
    const byTag = new Map(t.lines.filter((l) => l.tag_id).map((l) => [l.tag_id!, l.id]));
    const slots: (string | undefined)[] = p.lines.map((l) => (l.tag_id ? byTag.get(l.tag_id) : undefined));
    const used = new Set(slots.filter(Boolean));
    const free = t.lines.map((l) => l.id).filter((x) => !used.has(x));
    for (let k = 0; k < slots.length; k++) if (!slots[k]) slots[k] = free.shift();
    for (const lineId of free) await removeTransferLine(id, lineId);   // before the writes, so a freed piece can be re-added
    await addLines(id, t.from_branch_id, p.lines, slots);
  }
  const hasRemarks = Object.prototype.hasOwnProperty.call(p, 'remarks');
  // always touch the header so the version moves with any line change
  await tx().query(`UPDATE inventory.stock_transfer SET remarks = CASE WHEN $2 THEN $3 ELSE remarks END WHERE id = $1`, [id, hasRemarks, p.remarks ?? null]);
  return load(id);
}
/** DELETE one draft line as app_rw; RLS turns a refused delete into 0 rows, so say why (409 transfer_not_draft / 404). */
async function removeTransferLine(transferId: string, lineId: string): Promise<void> {
  const r = await tx().query(`DELETE FROM inventory.stock_transfer_line WHERE id = $1 AND transfer_id = $2`, [lineId, transferId]);
  if (r.rowCount) return;
  const s = await one<{ status: string }>(`SELECT s.status FROM inventory.stock_transfer_line l JOIN inventory.stock_transfer s ON s.id = l.transfer_id
      WHERE l.id = $1 AND l.transfer_id = $2`, [lineId, transferId]);
  if (!s) fail(404, 'not_found', 'transfer line');
  fail(409, 'transfer_not_draft', `transfer is ${s!.status}`);
}
export async function approveTransfer(a: InventoryActor, id: string, ifVersion?: number) {
  need(a, 'inventory.transfer.approve');
  const t = await load(id, true);
  needBranch(a, t.from_branch_id);
  checkVersion('transfer', t.version, ifVersion);
  if (t.status !== 'draft') fail(409, 'invalid_state', `transfer is ${t.status}`);
  await tx().query(`UPDATE inventory.stock_transfer SET status = 'approved', approved_by = $2 WHERE id = $1`, [id, a.userId]);
  return load(id);
}
/** Dispatch: tags → in_transit (inventory_writer), counter/tray cleared, transfer_out ledger at the sending branch. */
export async function dispatchTransfer(a: InventoryActor, id: string, remarks?: string | null, ifVersion?: number) {
  need(a, 'inventory.transfer.dispatch');
  const t = await load(id, true);
  needBranch(a, t.from_branch_id);
  checkVersion('transfer', t.version, ifVersion);
  if (t.status !== 'approved') fail(409, 'invalid_state', t.status === 'draft' ? 'approve the transfer first' : `transfer is ${t.status}`);
  const tagLines = t.lines.filter((l) => l.tag_id);
  const tags = tagLines.length ? await lockTags(tagLines.map((l) => l.tag_id!)) : new Map();
  const rows: LedgerRow[] = [];
  for (const l of t.lines) {
    if (l.tag_id) {
      const tg = tags.get(l.tag_id)!;
      if (tg.branch_id !== t.from_branch_id) fail(409, 'wrong_branch', `${tg.tag_no} left the sending branch`);
      assertTransition(tg.status, 'in_transit', 'transfer_dispatch');
      await writeTag(l.tag_id, { status: 'in_transit' });
      await tx().query(`UPDATE inventory.tag SET counter_id = NULL, box_id = NULL WHERE id = $1`, [l.tag_id]);
      rows.push({ branch_id: t.from_branch_id, tag_id: l.tag_id, item_id: tg.item_id, purity_id: tg.purity_id, movement: 'transfer_out', direction: -1,
        pieces: tg.pieces, gross_wt: tg.gross_wt, net_wt: tg.net_wt, source_type: 'stock_transfer', source_id: id, user_id: a.userId,
        counter_id: tg.counter_id, box_id: tg.box_id });
    } else {
      await requireLoose(t.from_branch_id, l.item_id!, l.purity_id!, l.from_counter_id, l.from_tray_id, l.pieces, mg(l.gross_wt), mg(l.net_wt));
      rows.push({ branch_id: t.from_branch_id, item_id: l.item_id, purity_id: l.purity_id!, movement: 'transfer_out', direction: -1, pieces: l.pieces,
        gross_wt: l.gross_wt, net_wt: l.net_wt, source_type: 'stock_transfer', source_id: id, user_id: a.userId,
        counter_id: l.from_counter_id, box_id: l.from_tray_id });
    }
  }
  await ledger(rows);
  await tx().query(`UPDATE inventory.stock_transfer SET status = 'in_transit', dispatched_at = now(), dispatched_by = $2,
      remarks = coalesce($3, remarks) WHERE id = $1`, [id, a.userId, remarks ?? null]);
  return load(id);
}
/**
 * Receive some or all lines at the receiving branch (inventory.transfer.receive there). Partial: note ≥ 3 chars; the transfer
 * stays in_transit until every line is in. Re-sending already received lines is a no-op (idempotent).
 */
export async function receiveTransfer(a: InventoryActor, id: string, i: { line_ids: string[]; note?: string | null; counter_id?: string | null; tray_id?: string | null },
  ifVersion?: number) {
  need(a, 'inventory.transfer.receive');
  const t = await load(id, true);
  needBranch(a, t.to_branch_id);
  if (!i.line_ids.length) invalid('line_ids', 'at least one line');
  const byId = new Map(t.lines.map((l) => [l.id, l]));
  for (const lid of i.line_ids) if (!byId.has(lid)) invalid('line_ids', `line ${lid} is not on this transfer`, 'unknown_line');
  if (t.status === 'received' && i.line_ids.every((lid) => byId.get(lid)!.received)) return t;   // retry after completion
  if (t.status !== 'in_transit') fail(409, 'invalid_state', `transfer is ${t.status}`);
  checkVersion('transfer', t.version, ifVersion);
  const counterId = i.counter_id ?? null, boxId = i.tray_id ?? null;
  await validateLocation(t.to_branch_id, counterId, boxId);
  const now = i.line_ids.map((lid) => byId.get(lid)!).filter((l) => !l.received);
  const remaining = t.lines.filter((l) => !l.received && !i.line_ids.includes(l.id));
  if (remaining.length && (!i.note || i.note.trim().length < 3)) invalid('note', 'say why some lines are not received (≥ 3 chars)', 'note_required');
  const tags = now.some((l) => l.tag_id) ? await lockTags(now.filter((l) => l.tag_id).map((l) => l.tag_id!)) : new Map();
  const rows: LedgerRow[] = [];
  for (const l of now) {
    if (l.tag_id) {
      const tg = tags.get(l.tag_id)!;
      assertTransition(tg.status, 'in_stock', 'transfer_receive');
      await writeTag(l.tag_id, { status: 'in_stock', branch_id: t.to_branch_id });
      await tx().query(`UPDATE inventory.tag SET counter_id = $2, box_id = $3 WHERE id = $1`, [l.tag_id, counterId, boxId]);
      rows.push({ branch_id: t.to_branch_id, tag_id: l.tag_id, item_id: tg.item_id, purity_id: tg.purity_id, movement: 'transfer_in', direction: 1,
        pieces: tg.pieces, gross_wt: tg.gross_wt, net_wt: tg.net_wt, source_type: 'stock_transfer', source_id: id, user_id: a.userId, counter_id: counterId, box_id: boxId });
    } else {
      rows.push({ branch_id: t.to_branch_id, item_id: l.item_id, purity_id: l.purity_id!, movement: 'transfer_in', direction: 1, pieces: l.pieces,
        gross_wt: l.gross_wt, net_wt: l.net_wt, source_type: 'stock_transfer', source_id: id, user_id: a.userId, counter_id: counterId, box_id: boxId });
    }
    await tx().query(`UPDATE inventory.stock_transfer_line SET received = true, received_at = now(), received_by = $2 WHERE id = $1`, [l.id, a.userId]);
  }
  await ledger(rows);
  if (!remaining.length)
    await tx().query(`UPDATE inventory.stock_transfer SET status = 'received', received_at = now(), received_by = $2 WHERE id = $1`, [id, a.userId]);
  else   // partial: bump the header version (aa_version) so If-Match on the transfer sees line receipts
    await tx().query(`UPDATE inventory.stock_transfer SET remarks = remarks WHERE id = $1`, [id]);
  if (remaining.length && i.note) await audit('inventory.transfer.partially_received', 'inventory.stock_transfer', id,
    { received_line_ids: now.map((l) => l.id), pending_line_ids: remaining.map((l) => l.id), note: i.note.trim() });
  return load(id);
}
/** Sender takes back every line not yet received (in_transit only): tags → in_stock at the sending branch, transfer_in there. */
export async function returnTransfer(a: InventoryActor, id: string, reason: string, ifVersion?: number) {
  need(a, 'inventory.transfer.dispatch');
  if (!reason || reason.trim().length < 3) invalid('reason', 'at least 3 characters');
  const t = await load(id, true);
  needBranch(a, t.from_branch_id);
  checkVersion('transfer', t.version, ifVersion);
  if (t.status !== 'in_transit') fail(409, 'invalid_state', `transfer is ${t.status}`);
  const back = t.lines.filter((l) => !l.received);
  const tags = back.some((l) => l.tag_id) ? await lockTags(back.filter((l) => l.tag_id).map((l) => l.tag_id!)) : new Map();
  const rows: LedgerRow[] = [];
  for (const l of back) {
    const tg = l.tag_id ? tags.get(l.tag_id)! : undefined;
    if (tg) { assertTransition(tg.status, 'in_stock', 'transfer_return'); await writeTag(tg.id, { status: 'in_stock', branch_id: t.from_branch_id }); }
    rows.push({ branch_id: t.from_branch_id, tag_id: tg?.id ?? null, item_id: tg?.item_id ?? l.item_id, purity_id: tg?.purity_id ?? l.purity_id!,
      movement: 'transfer_in', direction: 1, pieces: l.pieces, gross_wt: l.gross_wt, net_wt: l.net_wt, source_type: 'stock_transfer', source_id: id, user_id: a.userId,
      // loose lines go back to the counter / tray they left from; tags come back at branch level (counter cleared at dispatch)
      counter_id: tg ? null : l.from_counter_id, box_id: tg ? null : l.from_tray_id });
  }
  await ledger(rows);
  await tx().query(`UPDATE inventory.stock_transfer SET status = 'returned' WHERE id = $1`, [id]);
  await audit('inventory.transfer.returned', 'inventory.stock_transfer', id, { line_ids: back.map((l) => l.id), reason: reason.trim() });
  return load(id);
}
/** Cancel a draft or approved transfer (nothing has moved yet). */
export async function cancelTransfer(a: InventoryActor, id: string, ifVersion?: number) {
  need(a, 'inventory.transfer.dispatch');
  const t = await load(id, true);
  needBranch(a, t.from_branch_id);
  checkVersion('transfer', t.version, ifVersion);
  if (!['draft', 'approved'].includes(t.status)) fail(409, 'invalid_state', `transfer is ${t.status}; use return once dispatched`);
  await tx().query(`UPDATE inventory.stock_transfer SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2 WHERE id = $1`, [id, a.userId]);
  return load(id);
}
