import { useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Plus, Tags, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Select } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { EditGate, ErrorText, Loading } from '@/components/page';
import { useT, useTk } from '@/i18n';
import { useAttemptKey } from '@/lib/api/attempt-key';
import { formatDateIN } from '@/lib/format';
import { useOnline } from '@/lib/offline/connectivity';
import { useSignedIn } from '@/lib/session';
import { INV, invPerm } from '@/lib/permissions';
import { LotStatus, type ListLotsParams, type Lot } from '@/lib/api/backend/model';
import { inventoryApi, inventoryKeys } from './api';
import { useInvCan, useInvRefs } from './hooks';
import {
  blankLotLine, canRemoveLotLine, lineRemaining, lotIsOpen, lotLineDraft, lotLineError, lotProgress, LOT_NO_MAX, removedLotLines, toLotLines, type LotLineDraft,
} from './lots';
import { BranchPicker, InvPage, NotReadyOr, Wt } from './ui';

const LOT_STATUSES = Object.values(LotStatus);
const LOT_VARIANT: Record<LotStatus, 'success' | 'outline' | 'default'> = { open: 'default', tagged: 'success', closed: 'outline' };
const todayIso = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

/**
 * 2b — Lots (0.8.3): bulk receipts (vendor / hallmark centre) that pieces are tagged from over time. List with tagging
 * progress, create, edit an open lot's lines (saved lines can't be removed yet), tag from a line, close (remainder → loose).
 */
export function LotsPage() {
  const t = useT();
  const tk = useTk();
  const signedIn = useSignedIn();
  const refs = useInvRefs();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { id?: string };
  const [branch, setBranch] = useState('');
  const [status, setStatus] = useState<LotStatus | ''>('open');
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const params: ListLotsParams = { branch_id: branch || undefined, status: status || undefined, q: q.trim() || undefined };
  const list = useInfiniteQuery({
    queryKey: inventoryKeys.lots(params),
    queryFn: ({ pageParam }) => inventoryApi.lots({ ...params, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (p) => p.next_cursor ?? undefined,
    enabled: signedIn, retry: false,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const select = (id?: string) => void navigate({ to: '/inventory/lots', search: (id ? { id } : {}) as never });
  return (
    <InvPage title="inventory.lots.title" description="inventory.lots.desc"
      actions={<EditGate perm={invPerm(INV.tagCreate)}><Button onClick={() => { setCreating(true); select(); }}><Plus className="h-4 w-4" aria-hidden />{t('inventory.lots.new')}</Button></EditGate>}>
      <Card><CardContent className="grid gap-3 pt-4 md:grid-cols-3">
        <Field label={t('inventory.branch')}>{(id) => <BranchPicker id={id} value={branch} onChange={setBranch} branches={refs.branches} allLabel={t('inventory.any')} />}</Field>
        <Field label={t('common.status')}>{(id) => (
          <Select id={id} value={status} onChange={(e) => setStatus(e.target.value as LotStatus | '')}>
            <option value="">{t('inventory.any')}</option>
            {LOT_STATUSES.map((s) => <option key={s} value={s}>{tk(`inventory.lots.status.${s}`)}</option>)}
          </Select>)}</Field>
        <Field label={t('inventory.search')}>{(id) => <Input id={id} value={q} onChange={(e) => setQ(e.target.value)} />}</Field>
      </CardContent></Card>
      {creating ? <LotForm onDone={(l) => { setCreating(false); if (l) select(l.id); }} /> : null}
      {search.id ? <LotDetail id={search.id} onClose={() => select()} /> : null}
      <NotReadyOr error={list.error} />
      {list.isLoading ? <Loading /> : null}
      {list.isSuccess && !rows.length ? <p className="text-sm text-muted-foreground">{t('inventory.lots.empty')}</p> : null}
      <ul className="space-y-2" aria-label={t('inventory.lots.title')}>
        {rows.map((l) => {
          const p = lotProgress(l);
          return (
            <li key={l.id} data-testid="lot" className="flex flex-wrap items-center gap-3 rounded-md border border-border p-3 text-sm">
              <button type="button" className="font-mono font-semibold underline" lang="en" onClick={() => select(l.id)}>{l.lot_no}</button>
              <Badge variant={LOT_VARIANT[l.status]}>{tk(`inventory.lots.status.${l.status}`)}</Badge>
              <span>{refs.branchName(l.branch_id)}</span>
              <span className="text-muted-foreground">{formatDateIN(l.received_on)}</span>
              <span className="tabular-nums" data-testid="lot-progress">{t('inventory.lots.progress', { tagged: p.tagged, total: p.total })}</span>
              <span className="tabular-nums">{t('inventory.lots.remaining')} <Wt v={p.remainingGross} /></span>
            </li>
          );
        })}
      </ul>
      {list.hasNextPage ? <Button variant="outline" onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>{t('inventory.loadMore')}</Button> : null}
    </InvPage>
  );
}

/** Line grid shared by create and edit. Saved lines (with id) have no remove button: removal isn't possible yet. */
function LineEditor({ lines, onChange }: { lines: LotLineDraft[]; onChange: (next: LotLineDraft[]) => void }) {
  const t = useT();
  const refs = useInvRefs();
  const set = (i: number, p: Partial<LotLineDraft>) => onChange(lines.map((l, k) => (k === i ? { ...l, ...p } : l)));
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted"><tr>
            {(['inventory.item', 'inventory.purity', 'inventory.pcs', 'inventory.grossWt', 'inventory.netWt'] as const).map((k) => <th key={k} className="px-2 py-2 text-left font-medium">{t(k)}</th>)}
            <th className="px-2 py-2"><span className="sr-only">{t('common.remove')}</span></th>
          </tr></thead>
          <tbody className="divide-y divide-border">
            {lines.map((l, i) => {
              const e = l.gross_wt || l.id ? lotLineError(l) : null;
              return (
                <tr key={l.id ?? `new-${i}`} data-testid="lot-line">
                  <td className="px-2 py-1">
                    <Select aria-label={`${t('inventory.item')} ${i + 1}`} value={l.item_id} disabled={l.tagged_pieces > 0} onChange={(ev) => set(i, { item_id: ev.target.value, purity_id: refs.item(ev.target.value)?.purity_id ?? l.purity_id })}>
                      <option value="" disabled>{t('common.choose')}</option>
                      {refs.items.filter((x) => x.stock_type === 'tag').map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                    </Select>
                  </td>
                  <td className="px-2 py-1">
                    <Select aria-label={`${t('inventory.purity')} ${i + 1}`} value={l.purity_id} onChange={(ev) => set(i, { purity_id: ev.target.value })}>
                      <option value="">{t('inventory.none')}</option>
                      {refs.purities.filter((p) => p.is_active).map((p) => <option key={p.id} value={p.id}>{p.code}</option>)}
                    </Select>
                  </td>
                  <td className="px-2 py-1"><Input aria-label={`${t('inventory.pcs')} ${i + 1}`} className="w-20" inputMode="numeric" value={l.pieces} onChange={(ev) => set(i, { pieces: ev.target.value })} /></td>
                  <td className="px-2 py-1"><Input aria-label={`${t('inventory.grossWt')} ${i + 1}`} className="w-28 tabular-nums" inputMode="decimal" value={l.gross_wt} onChange={(ev) => set(i, { gross_wt: ev.target.value })} /></td>
                  <td className="px-2 py-1"><Input aria-label={`${t('inventory.netWt')} ${i + 1}`} className="w-28 tabular-nums" inputMode="decimal" placeholder={l.gross_wt} value={l.net_wt} onChange={(ev) => set(i, { net_wt: ev.target.value })} />
                    {e ? <p className="text-xs text-destructive">{t(e)}</p> : null}</td>
                  <td className="px-2 py-1">{canRemoveLotLine(l) ? <Button type="button" size="icon" variant="ghost" aria-label={`${t('common.remove')} ${i + 1}`} disabled={lines.length <= 1} onClick={() => onChange(lines.filter((_, k) => k !== i))}><Trash2 className="h-4 w-4" /></Button> : <span className="text-xs text-muted-foreground">{t('inventory.lots.lineLocked')}</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Button type="button" variant="outline" size="sm" onClick={() => onChange([...lines, blankLotLine()])}><Plus className="h-4 w-4" aria-hidden />{t('inventory.lots.addLine')}</Button>
      {lines.some((l) => !canRemoveLotLine(l)) ? <p className="text-xs text-muted-foreground">{t('inventory.lots.taggedLocked')}</p> : null}
    </div>
  );
}

function LotForm({ onDone }: { onDone: (l: Lot | null) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const online = useOnline();
  const refs = useInvRefs();
  const key = useAttemptKey();
  const [branch, setBranch] = useState('');
  const [receivedOn, setReceivedOn] = useState(todayIso);
  const [lotNo, setLotNo] = useState('');
  const [invoice, setInvoice] = useState('');
  const [lines, setLines] = useState<LotLineDraft[]>([blankLotLine()]);
  const b = branch || refs.branches[0]?.id || '';
  const save = useMutation({
    mutationFn: () => inventoryApi.createLot({
      branch_id: b, received_on: receivedOn, lot_no: lotNo.trim() || undefined, ref_invoice_no: invoice.trim() || null, entry_type: 'other', lines: toLotLines(lines),
    }, key.take()),
    onSuccess: (l) => { key.reset(); void qc.invalidateQueries({ queryKey: ['inventory', 'lots'] }); onDone(l); },
    onError: (e) => key.settle(e),
  });
  const ok = !!b && !!receivedOn && lotNo.trim().length <= LOT_NO_MAX && lines.length > 0 && lines.every((l) => !lotLineError(l));
  return (
    <Card>
      <CardHeader><CardTitle>{t('inventory.lots.new')}</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 md:grid-cols-4">
          <Field label={t('inventory.branch')}>{(id) => <BranchPicker id={id} value={b} onChange={(v) => { setBranch(v); key.reset(); }} branches={refs.branches} />}</Field>
          <Field label={t('inventory.lots.receivedOn')}>{(id) => <Input id={id} type="date" value={receivedOn} onChange={(e) => { setReceivedOn(e.target.value); key.reset(); }} />}</Field>
          <Field label={t('inventory.lots.lotNo')} hint={t('inventory.lots.lotNoHint')}>{(id, h) => <Input id={id} aria-describedby={h} lang="en" maxLength={LOT_NO_MAX} value={lotNo} onChange={(e) => { setLotNo(e.target.value); key.reset(); }} />}</Field>
          <Field label={t('inventory.lots.invoice')}>{(id) => <Input id={id} value={invoice} onChange={(e) => { setInvoice(e.target.value); key.reset(); }} />}</Field>
        </div>
        <LineEditor lines={lines} onChange={(l) => { setLines(l); key.reset(); }} />
        <ErrorText error={save.error} />
        <div className="flex gap-2">
          <Button disabled={!online || !ok || save.isPending} onClick={() => save.mutate()}>{t('inventory.lots.create')}</Button>
          <Button variant="ghost" onClick={() => onDone(null)}>{t('common.cancel')}</Button>
        </div>
      </CardContent>
    </Card>
  );
}

function LotDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useT();
  const tk = useTk();
  const signedIn = useSignedIn();
  const refs = useInvRefs();
  const can = useInvCan();
  const q = useQuery({ queryKey: inventoryKeys.lot(id), queryFn: () => inventoryApi.lot(id), enabled: signedIn, retry: false });
  const [editing, setEditing] = useState(false);
  const lot = q.data;
  return (
    <Card data-testid="lot-detail">
      <CardHeader><CardTitle className="flex flex-wrap items-center gap-2">
        <span lang="en" className="font-mono">{lot?.lot_no ?? ''}</span>
        {lot ? <Badge variant={LOT_VARIANT[lot.status]}>{tk(`inventory.lots.status.${lot.status}`)}</Badge> : null}
        <Button size="sm" variant="ghost" className="ml-auto" onClick={onClose}>{t('inventory.lots.hide')}</Button>
      </CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <NotReadyOr error={q.error} />
        {q.isLoading ? <Loading /> : null}
        {lot && !editing ? (
          <>
            <p className="text-muted-foreground">{`${refs.branchName(lot.branch_id)} · ${formatDateIN(lot.received_on)}${lot.ref_invoice_no ? ` · ${lot.ref_invoice_no}` : ''}`}</p>
            <ul className="divide-y divide-border rounded-md border border-border">
              {(lot.lines ?? []).map((l) => (
                <li key={l.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                  <span>{`${refs.itemName(l.item_id)} · ${refs.purityCode(l.purity_id)}`}</span>
                  <span className="tabular-nums">{t('inventory.lots.progress', { tagged: l.tagged_pieces, total: l.pieces })}</span>
                  <Wt v={l.gross_wt} />
                  {lotIsOpen(lot) && lineRemaining(l) > 0 && can(INV.tagCreate)
                    ? <Button asChild size="sm" variant="outline" className="ml-auto"><Link to="/inventory/tag" search={{ lot: lot.id, line: l.id } as never}><Tags className="h-4 w-4" aria-hidden />{t('inventory.lots.tagFrom', { n: lineRemaining(l) })}</Link></Button>
                    : null}
                </li>
              ))}
            </ul>
            {lotIsOpen(lot) && can(INV.tagCreate) ? (
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => setEditing(true)}>{t('common.edit')}</Button>
              </div>
            ) : null}
            {lot.status !== 'closed' && can(INV.tagCreate) ? <CloseLot lot={lot} /> : null}
          </>
        ) : null}
        {lot && editing ? <EditLot lot={lot} onDone={() => setEditing(false)} /> : null}
      </CardContent>
    </Card>
  );
}

function EditLot({ lot, onDone }: { lot: Lot; onDone: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const online = useOnline();
  const refs = useInvRefs();
  const [lines, setLines] = useState<LotLineDraft[]>(() => (lot.lines ?? []).map(lotLineDraft));
  const [confirming, setConfirming] = useState(false);
  const save = useMutation({
    mutationFn: () => inventoryApi.updateLot(lot, { lines: toLotLines(lines) }),
    onSuccess: (l) => { qc.setQueryData(inventoryKeys.lot(lot.id), l); void qc.invalidateQueries({ queryKey: ['inventory', 'lots'] }); onDone(); },
    onSettled: () => setConfirming(false),
  });
  const removed = removedLotLines(lot, lines);
  const locked = removed.filter((l) => !canRemoveLotLine(l));
  const ok = lines.length > 0 && !locked.length && lines.every((l) => !lotLineError(l));
  const change = (next: LotLineDraft[]) => { setLines(next); setConfirming(false); };
  return (
    <div className="space-y-3">
      <LineEditor lines={lines} onChange={change} />
      <ErrorText error={save.error} />
      {confirming ? (
        <div role="alertdialog" aria-labelledby={`rm-${lot.id}`} className="space-y-2 rounded-md border border-destructive p-3 text-sm" data-testid="confirm-remove">
          <p id={`rm-${lot.id}`} className="font-medium">{t('inventory.lots.confirmRemove', { n: removed.length })}</p>
          <ul className="list-disc pl-5">{removed.map((l) => <li key={l.id}>{`${refs.itemName(l.item_id)} · ${l.pieces}`}</li>)}</ul>
          <div className="flex gap-2">
            <Button variant="destructive" disabled={!online || save.isPending} onClick={() => save.mutate()}>{t('inventory.lots.removeAndSave')}</Button>
            <Button variant="ghost" onClick={() => setConfirming(false)}>{t('common.cancel')}</Button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <Button disabled={!online || !ok || save.isPending} onClick={() => (removed.length ? setConfirming(true) : save.mutate())}>{t('common.save')}</Button>
          <Button variant="ghost" onClick={onDone}>{t('common.cancel')}</Button>
        </div>
      )}
    </div>
  );
}

/** Close: remainder none (only when everything is tagged; else 409 lot_has_remainder) or to_loose (untagged weight → loose stock). If-Match (0.8.4). */
function CloseLot({ lot }: { lot: Lot }) {
  const t = useT();
  const qc = useQueryClient();
  const online = useOnline();
  const refs = useInvRefs();
  const p = lotProgress(lot);
  const hasRemainder = p.tagged < p.total;
  const [toLoose, setToLoose] = useState(hasRemainder);
  const [counter, setCounter] = useState('');
  const close = useMutation({
    mutationFn: () => inventoryApi.closeLot(lot, { remainder: toLoose ? 'to_loose' : 'none', ...(toLoose && counter ? { counter_id: counter } : {}) }),
    onSuccess: (l) => { qc.setQueryData(inventoryKeys.lot(lot.id), l); void qc.invalidateQueries({ queryKey: inventoryKeys.all }); },
  });
  return (
    <fieldset className="space-y-2 rounded-md border border-border p-3">
      <legend className="px-1 font-medium">{t('inventory.lots.close')}</legend>
      <label className="flex items-center gap-2"><input type="radio" name={`rem-${lot.id}`} checked={!toLoose} onChange={() => setToLoose(false)} />{t('inventory.lots.remainderNone')}</label>
      <label className="flex items-center gap-2"><input type="radio" name={`rem-${lot.id}`} checked={toLoose} onChange={() => setToLoose(true)} />{t('inventory.lots.remainderLoose')}</label>
      {toLoose ? (
        <Field label={t('inventory.counter')} className="max-w-xs">{(id) => (
          <Select id={id} value={counter} onChange={(e) => setCounter(e.target.value)}>
            <option value="">{t('inventory.none')}</option>
            {refs.counters.filter((c) => c.branch_id === lot.branch_id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>)}</Field>
      ) : null}
      {!toLoose && hasRemainder ? <p className="text-xs text-muted-foreground">{t('inventory.lots.remainderHint')}</p> : null}
      <ErrorText error={close.error} />
      <Button variant="outline" disabled={!online || close.isPending} onClick={() => close.mutate()}>{t('inventory.lots.close')}</Button>
    </fieldset>
  );
}
