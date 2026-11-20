import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Check, Field, Select } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { EditGate, ErrorText } from '@/components/page';
import { useT, useTk } from '@/i18n';
import { useAttemptKey } from '@/lib/api/attempt-key';
import { formatDateTimeIN } from '@/lib/format';
import { useOnline } from '@/lib/offline/connectivity';
import { useSignedIn } from '@/lib/session';
import { INV, invPerm } from '@/lib/permissions';
import { inventoryApi, inventoryKeys, type TransferDirection } from './api';
import { removedTransferLines, transferPatchLines } from './lots';
import { MIN_TEXT, optionalTextOk, textOk } from './adjustments';
import { useInvCan, useInvRefs } from './hooks';
import { TagPicker, type Picked } from './picker';
import { BranchPicker, InvPage, NotReadyOr, Wt } from './ui';
import type { StockTransfer, TransferStatus } from './types';

const STATUS_VARIANT: Record<TransferStatus, 'success' | 'warning' | 'outline' | 'default'> = {
  draft: 'outline', approved: 'default', in_transit: 'warning', received: 'success', returned: 'outline', cancelled: 'outline',
};

/**
 * 5 — Transfers between branches (0.8.2; every decision sends If-Match from the row's version): draft → approved → in transit → received (or returned / cancelled).
 * Someone holding inventory.transfer.approve may dispatch their own draft directly (they are recorded as approver).
 * 0.8.3: a draft can be edited (remarks, add / take off pieces; PATCH with If-Match). 0.8.4: pieces left out are
 * deleted from the draft (freed at once for another transfer), so the editor lists them and asks before saving.
 */
export function TransfersPage() {
  const t = useT();
  const [tab, setTab] = useState<'send' | TransferDirection>('send');
  return (
    <InvPage title="inventory.transfers.title" description="inventory.transfers.desc">
      <div role="tablist" className="flex flex-wrap gap-2">
        {(['send', 'incoming', 'outgoing'] as const).map((k) => (
          <Button key={k} role="tab" aria-selected={tab === k} variant={tab === k ? 'default' : 'outline'} onClick={() => setTab(k)}>{t(`inventory.transfers.tab.${k}`)}</Button>
        ))}
      </div>
      {tab === 'send' ? <EditGate perm={invPerm(INV.transferDispatch)}><SendTransfer /></EditGate> : <TransferList direction={tab} />}
    </InvPage>
  );
}

function SendTransfer() {
  const t = useT();
  const qc = useQueryClient();
  const online = useOnline();
  const refs = useInvRefs();
  const can = useInvCan();
  const key = useAttemptKey();
  const dispatchKey = useAttemptKey();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [note, setNote] = useState('');
  const [picked, setPicked] = useState<Picked[]>([]);
  const [sent, setSent] = useState<StockTransfer | null>(null);
  const selfApprove = can(INV.transferApprove);
  const send = useMutation({
    mutationFn: async () => {
      const draft = await inventoryApi.createTransfer({ from_branch_id: from, to_branch_id: to, remarks: note.trim() || null, lines: picked.map((p) => ({ tag_id: p.id })) }, key.take());
      key.reset();
      // With approve rights, send at once; otherwise the draft waits for an approver.
      return selfApprove ? inventoryApi.dispatchTransfer(draft, dispatchKey.take()) : draft;
    },
    onSuccess: (tr) => { dispatchKey.reset(); setSent(tr); setPicked([]); setNote(''); void qc.invalidateQueries({ queryKey: inventoryKeys.all }); },
    onError: (e) => { key.settle(e); dispatchKey.settle(e); },
  });
  const ok = !!from && !!to && from !== to && picked.length > 0 && optionalTextOk(note);
  return (
    <Card>
      <CardHeader><CardTitle>{t('inventory.transfers.tab.send')}</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 md:grid-cols-2">
          <Field label={t('inventory.transfers.from')}>{(id) => <BranchPicker id={id} value={from} onChange={(v) => { setFrom(v); setPicked([]); key.reset(); }} branches={refs.branches} allLabel={t('common.choose')} />}</Field>
          <Field label={t('inventory.transfers.to')} error={from && to && from === to ? t('inventory.transfers.sameBranch') : null}>{(id, d) => <div aria-describedby={d}><BranchPicker id={id} value={to} onChange={(v) => { setTo(v); key.reset(); }} branches={refs.branches} allLabel={t('common.choose')} /></div>}</Field>
        </div>
        {from ? <TagPicker picked={picked} branchId={from} onChange={(p) => { setPicked(p); key.reset(); }} check={(p) => (p.status !== 'in_stock' || p.branch_id !== from ? t('inventory.scan.notInStock', { tag: p.tag_no }) : null)} /> : <p className="text-sm text-muted-foreground">{t('inventory.transfers.pickFrom')}</p>}
        <Field label={t('inventory.note')} hint={t('inventory.minTextOptional', { n: MIN_TEXT })}>{(id, h) => <Input id={id} aria-describedby={h} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
        <p className="text-xs text-muted-foreground">{t(selfApprove ? 'inventory.transfers.sendsNow' : 'inventory.transfers.needsApproval')}</p>
        <ErrorText error={send.error} />
        <Button disabled={!online || !ok || send.isPending} onClick={() => send.mutate()}>{t('inventory.transfers.send', { n: picked.length })}</Button>
        {sent ? <p role="status" className="text-sm">{t(sent.status === 'draft' ? 'inventory.transfers.drafted' : 'inventory.transfers.sent', { no: sent.transfer_no })}</p> : null}
      </CardContent>
    </Card>
  );
}

function TransferList({ direction }: { direction: TransferDirection }) {
  const t = useT();
  const tk = useTk();
  const signedIn = useSignedIn();
  const refs = useInvRefs();
  const q = useQuery({ queryKey: inventoryKeys.transfers(direction), queryFn: () => inventoryApi.transfers(direction), enabled: signedIn, retry: false });
  const items = q.data?.items ?? [];
  return (
    <div className="space-y-3">
      <NotReadyOr error={q.error} />
      {q.isSuccess && !items.length ? <p className="text-sm text-muted-foreground">{t('inventory.transfers.empty')}</p> : null}
      {items.map((tr) => (
        <Card key={tr.id} data-testid="transfer">
          <CardContent className="space-y-2 pt-4 text-sm">
            <div className="flex flex-wrap items-center gap-3">
              <span lang="en" className="font-mono font-semibold">{tr.transfer_no}</span>
              <Badge variant={STATUS_VARIANT[tr.status]}>{tk(`inventory.transfers.status.${tr.status}`)}</Badge>
              <span>{t('inventory.transfers.route', { from: refs.branchName(tr.from_branch_id), to: refs.branchName(tr.to_branch_id) })}</span>
              <span className="tabular-nums">{t('inventory.scan.total', { n: tr.totals?.pieces ?? transferPieceCount(tr) })} · <Wt v={tr.totals?.net_wt} /></span>
              <span className="text-muted-foreground">{formatDateTimeIN(tr.dispatched_at ?? tr.created_at ?? '')}</span>
            </div>
            <TransferActions tr={tr} direction={direction} />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function TransferActions({ tr, direction }: { tr: StockTransfer; direction: TransferDirection }) {
  const t = useT();
  const qc = useQueryClient();
  const online = useOnline();
  const can = useInvCan();
  const key = useAttemptKey();
  const [open, setOpen] = useState<'receive' | 'return' | 'edit' | null>(null);
  const done = () => { key.reset(); setOpen(null); void qc.invalidateQueries({ queryKey: inventoryKeys.all }); };
  const act = useMutation({
    mutationFn: (a: 'approve' | 'dispatch' | 'cancel') =>
      a === 'approve' ? inventoryApi.approveTransfer(tr) : a === 'dispatch' ? inventoryApi.dispatchTransfer(tr, key.take()) : inventoryApi.cancelTransfer(tr),
    onSuccess: done, onError: (e) => key.settle(e),
  });
  const out = direction === 'outgoing';
  const canDispatch = out && can(INV.transferDispatch) && (tr.status === 'approved' || (tr.status === 'draft' && can(INV.transferApprove)));
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {out && tr.status === 'draft' && can(INV.transferDispatch) ? <Button size="sm" variant={open === 'edit' ? 'secondary' : 'outline'} onClick={() => setOpen(open === 'edit' ? null : 'edit')}>{t('common.edit')}</Button> : null}
        {out && tr.status === 'draft' && can(INV.transferApprove) ? <Button size="sm" variant="outline" disabled={!online || act.isPending} onClick={() => act.mutate('approve')}>{t('inventory.transfers.approve')}</Button> : null}
        {canDispatch ? <Button size="sm" disabled={!online || act.isPending} onClick={() => act.mutate('dispatch')}>{t('inventory.transfers.dispatch')}</Button> : null}
        {out && (tr.status === 'draft' || tr.status === 'approved') && can(INV.transferDispatch) ? <Button size="sm" variant="ghost" disabled={!online || act.isPending} onClick={() => act.mutate('cancel')}>{t('common.cancel')}</Button> : null}
        {out && tr.status === 'in_transit' && can(INV.transferDispatch) ? <Button size="sm" variant="outline" onClick={() => setOpen(open === 'return' ? null : 'return')}>{t('inventory.transfers.return')}</Button> : null}
        {!out && tr.status === 'in_transit' && can(INV.transferReceive) ? <Button size="sm" variant={open === 'receive' ? 'secondary' : 'default'} onClick={() => setOpen(open === 'receive' ? null : 'receive')}>{t('inventory.transfers.receive')}</Button> : null}
      </div>
      <ErrorText error={act.error} />
      {open === 'receive' ? <Receive tr={tr} onDone={done} /> : null}
      {open === 'return' ? <Return tr={tr} onDone={done} /> : null}
      {open === 'edit' ? <EditDraft tr={tr} onDone={done} /> : null}
    </div>
  );
}

function Receive({ tr, onDone }: { tr: StockTransfer; onDone: () => void }) {
  const t = useT();
  const online = useOnline();
  const refs = useInvRefs();
  const key = useAttemptKey();
  const pending = (tr.lines ?? []).filter((l) => !l.received);
  const [got, setGot] = useState<Set<string>>(() => new Set(pending.map((l) => l.id)));
  const [counter, setCounter] = useState('');
  const [note, setNote] = useState('');
  const missing = pending.length - got.size;
  const recv = useMutation({
    mutationFn: () => inventoryApi.receiveTransfer(tr, { line_ids: [...got], counter_id: counter || null, note: note.trim() || null }, key.take()),
    onSuccess: onDone, onError: (e) => key.settle(e),
  });
  return (
    <fieldset className="space-y-2 rounded-md border border-border p-3">
      <legend className="px-1 font-medium">{t('inventory.transfers.tickArrived')}</legend>
      {pending.map((l) => (
        <Check key={l.id} label={l.tag_no ?? `${refs.itemName(l.item_id)} · ${l.net_wt}`} checked={got.has(l.id)} onChange={(on) => { const n = new Set(got); if (on) n.add(l.id); else n.delete(l.id); setGot(n); key.reset(); }} />
      ))}
      {missing > 0 ? <p className="text-sm text-destructive">{t('inventory.transfers.missing', { n: missing })}</p> : null}
      <Field label={t('inventory.counter')} className="max-w-xs">{(id) => (
        <Select id={id} value={counter} onChange={(e) => { setCounter(e.target.value); key.reset(); }}>
          <option value="">{t('inventory.none')}</option>
          {refs.counters.filter((c) => c.branch_id === tr.to_branch_id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>)}</Field>
      <Field label={t('inventory.note')} hint={missing > 0 ? t('inventory.transfers.noteMissing', { n: MIN_TEXT }) : t('inventory.minTextOptional', { n: MIN_TEXT })}>{(id, h) => <Input id={id} aria-describedby={h} value={note} onChange={(e) => { setNote(e.target.value); key.reset(); }} />}</Field>
      <ErrorText error={recv.error} />
      <Button disabled={!online || recv.isPending || !got.size || (missing > 0 ? !textOk(note) : !optionalTextOk(note))} onClick={() => recv.mutate()}>{t('inventory.transfers.confirmReceive', { n: got.size })}</Button>
    </fieldset>
  );
}

function Return({ tr, onDone }: { tr: StockTransfer; onDone: () => void }) {
  const t = useT();
  const online = useOnline();
  const [reason, setReason] = useState('');
  const ret = useMutation({ mutationFn: () => inventoryApi.returnTransfer(tr, reason.trim()), onSuccess: onDone });
  return (
    <fieldset className="space-y-2 rounded-md border border-border p-3">
      <legend className="px-1 font-medium">{t('inventory.transfers.return')}</legend>
      <p className="text-xs text-muted-foreground">{t('inventory.transfers.returnHint', { n: MIN_TEXT })}</p>
      <Field label={t('inventory.reason')}>{(id) => <Input id={id} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
      <ErrorText error={ret.error} />
      <Button variant="outline" disabled={!online || ret.isPending || !textOk(reason)} onClick={() => ret.mutate()}>{t('inventory.transfers.return')}</Button>
    </fieldset>
  );
}

/** Pieces on a transfer row from its lines (0.8.8: list rows carry lines; null-safe for older servers). */
export function transferPieceCount(tr: { lines?: ReadonlyArray<{ pieces?: number | null }> | null }): number {
  return (tr.lines ?? []).reduce((n, l) => n + (typeof l?.pieces === 'number' && l.pieces >= 0 ? l.pieces : 1), 0);
}

/** Draft edit (PATCH /transfers/{id}, If-Match): change remarks, add or take off pieces (taking off is confirmed first; 0.8.4). */
function EditDraft({ tr, onDone }: { tr: StockTransfer; onDone: () => void }) {
  const t = useT();
  const online = useOnline();
  const [note, setNote] = useState(tr.remarks ?? '');
  const [picked, setPicked] = useState<Picked[]>(() => (tr.lines ?? []).filter((l) => l.tag_id).map((l) => ({
    id: l.tag_id ?? '', tag_no: l.tag_no ?? '', net_wt: l.net_wt, gross_wt: l.gross_wt, pieces: l.pieces, status: 'in_stock', branch_id: tr.from_branch_id,
  })));
  const [confirming, setConfirming] = useState(false);
  const save = useMutation({ mutationFn: () => inventoryApi.updateTransfer(tr, { remarks: note, lines: transferPatchLines(tr.lines ?? [], picked) }), onSuccess: onDone, onSettled: () => setConfirming(false) });
  const removed = removedTransferLines(tr.lines ?? [], picked);
  const empty = !picked.length && !(tr.lines ?? []).some((l) => !l.tag_id);
  return (
    <fieldset className="space-y-2 rounded-md border border-border p-3" data-testid="edit-draft">
      <legend className="px-1 font-medium">{t('inventory.transfers.editDraft')}</legend>
      <TagPicker picked={picked} branchId={tr.from_branch_id} onChange={(p) => { setPicked(p); setConfirming(false); }} check={(p) => (p.status !== 'in_stock' || p.branch_id !== tr.from_branch_id ? t('inventory.scan.notInStock', { tag: p.tag_no }) : null)} />
      <Field label={t('inventory.note')} hint={t('inventory.minTextOptional', { n: MIN_TEXT })}>{(id, h) => <Input id={id} aria-describedby={h} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
      <ErrorText error={save.error} />
      {confirming ? (
        <div role="alertdialog" aria-labelledby={`rm-${tr.id}`} className="space-y-2 rounded-md border border-destructive p-3 text-sm" data-testid="confirm-remove">
          <p id={`rm-${tr.id}`} className="font-medium">{t('inventory.transfers.confirmRemove', { n: removed.length })}</p>
          <p lang="en" className="font-mono">{removed.join(', ')}</p>
          <div className="flex gap-2">
            <Button variant="destructive" disabled={!online || save.isPending} onClick={() => save.mutate()}>{t('inventory.lots.removeAndSave')}</Button>
            <Button variant="ghost" onClick={() => setConfirming(false)}>{t('common.cancel')}</Button>
          </div>
        </div>
      ) : <Button disabled={!online || save.isPending || empty || !optionalTextOk(note)} onClick={() => (removed.length ? setConfirming(true) : save.mutate())}>{t('common.save')}</Button>}
    </fieldset>
  );
}
