import { useState } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Select } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { EditGate, ErrorText, Loading } from '@/components/page';
import { useT } from '@/i18n';
import { useAttemptKey } from '@/lib/api/attempt-key';
import { useOnline } from '@/lib/offline/connectivity';
import { useSignedIn } from '@/lib/session';
import { formatDateTimeIN } from '@/lib/format';
import type { ListLocationMovesParams, LocationMove } from '@/lib/api/backend/model';
import { INV, invPerm } from '@/lib/permissions';
import { inventoryApi, inventoryKeys } from './api';
import { useInvCan, useInvRefs } from './hooks';
import { TagPicker, type Picked } from './picker';
import { BranchPicker, InvPage, NotReadyOr, Wt } from './ui';

/** 6 — Counter / tray moves inside one branch (POST /v1/inventory/moves): scan pieces, choose where they go now. Below: recent moves (0.8.3 GET). */
export function MovesPage() {
  const t = useT();
  const qc = useQueryClient();
  const online = useOnline();
  const refs = useInvRefs();
  const key = useAttemptKey();
  const [branch, setBranch] = useState('');
  const [counter, setCounter] = useState('');
  const [tray, setTray] = useState('');
  const [note, setNote] = useState('');
  const [picked, setPicked] = useState<Picked[]>([]);
  const [moved, setMoved] = useState<number | null>(null);
  const counters = refs.counters.filter((c) => !branch || c.branch_id === branch);
  const move = useMutation({
    mutationFn: () => inventoryApi.move({ branch_id: branch, tag_ids: picked.map((p) => p.id), to_counter_id: counter, to_tray_id: tray || null, reason: note.trim() || null }, key.take()),
    onSuccess: (r) => { key.reset(); setMoved(r.moved ?? r.items.length); setPicked([]); setNote(''); void qc.invalidateQueries({ queryKey: inventoryKeys.all }); },
    onError: (e) => key.settle(e),
  });
  return (
    <InvPage title="inventory.moves.title" description="inventory.moves.desc">
      <EditGate perm={invPerm(INV.move)}>
        <Card><CardContent className="space-y-3 pt-4">
          <div className="grid gap-3 md:grid-cols-3">
            <Field label={t('inventory.branch')}>{(id) => <BranchPicker id={id} value={branch} onChange={(v) => { setBranch(v); setCounter(''); setTray(''); setPicked([]); key.reset(); }} branches={refs.branches} allLabel={t('common.choose')} />}</Field>
            <Field label={t('inventory.moves.toCounter')}>{(id) => (
              <Select id={id} value={counter} disabled={!branch} onChange={(e) => { setCounter(e.target.value); setTray(''); key.reset(); }}>
                <option value="" disabled>{t('common.choose')}</option>
                {counters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>)}</Field>
            <Field label={t('inventory.moves.toTray')}>{(id) => (
              <Select id={id} value={tray} disabled={!counter} onChange={(e) => { setTray(e.target.value); key.reset(); }}>
                <option value="">{t('inventory.none')}</option>
                {refs.trays.filter((x) => x.counter_id === counter).map((x) => <option key={x.id} value={x.id}>{x.name ?? x.code}</option>)}
              </Select>)}</Field>
          </div>
          {branch ? <TagPicker picked={picked} branchId={branch} onChange={(p) => { setPicked(p); setMoved(null); key.reset(); }} check={(p) => (p.status !== 'in_stock' || p.branch_id !== branch ? t('inventory.scan.notInStock', { tag: p.tag_no }) : null)} /> : null}
          <Field label={t('inventory.reason')}>{(id) => <Input id={id} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
          <ErrorText error={move.error} />
          <Button disabled={!online || !counter || !picked.length || move.isPending} onClick={() => move.mutate()}>{t('inventory.moves.save', { n: picked.length })}</Button>
          {moved !== null ? <p role="status" className="text-sm">{t('inventory.moves.done', { n: moved })}</p> : null}
        </CardContent></Card>
      </EditGate>
      <MoveHistory branchId={branch} />
    </InvPage>
  );
}

/** Recent moves (GET /v1/inventory/moves, newest first, keyset "load more"); filter by branch (from the form) and counter. */
export function MoveHistory({ branchId }: { branchId?: string }) {
  const t = useT();
  const signedIn = useSignedIn();
  const can = useInvCan();
  const refs = useInvRefs();
  const [counter, setCounter] = useState('');
  const params: ListLocationMovesParams = { branch_id: branchId || undefined, counter_id: counter || undefined };
  const list = useInfiniteQuery({
    queryKey: inventoryKeys.moves(params),
    queryFn: ({ pageParam }) => inventoryApi.moves({ ...params, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (p) => p.next_cursor ?? undefined,
    enabled: signedIn && can(INV.stockView), retry: false,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const place = (c?: string | null, tr?: string | null) => (c ? `${refs.counterName(c)}${tr ? ` · ${refs.trayName(tr)}` : ''}` : t('inventory.moves.unplaced'));
  const what = (m: LocationMove) => m.tag_no ?? `${refs.itemName(m.item_id)} · ${refs.purityCode(m.purity_id)}`;
  if (!can(INV.stockView)) return null;
  return (
    <Card>
      <CardHeader><CardTitle>{t('inventory.moves.history')}</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <Field label={t('inventory.counter')} className="max-w-xs">{(id) => (
          <Select id={id} value={counter} onChange={(e) => setCounter(e.target.value)}>
            <option value="">{t('inventory.any')}</option>
            {refs.counters.filter((c) => !branchId || c.branch_id === branchId).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>)}</Field>
        <NotReadyOr error={list.error} />
        {list.isLoading ? <Loading /> : null}
        {list.isSuccess && !rows.length ? <p className="text-sm text-muted-foreground">{t('inventory.moves.none')}</p> : null}
        <ul className="divide-y divide-border text-sm" data-testid="move-history">
          {rows.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-3 py-1.5">
              <span lang="en" className="font-mono">{what(m)}</span>
              <span>{t('inventory.history.fromTo', { from: place(m.from_counter_id, m.from_tray_id), to: place(m.to_counter_id, m.to_tray_id) })}</span>
              <Wt v={m.net_wt} />
              <span className="text-muted-foreground">{formatDateTimeIN(m.moved_at)}</span>
              {m.reason ? <span className="text-xs">{m.reason}</span> : null}
            </li>
          ))}
        </ul>
        {list.hasNextPage ? <Button variant="outline" onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>{t('inventory.loadMore')}</Button> : null}
      </CardContent>
    </Card>
  );
}
