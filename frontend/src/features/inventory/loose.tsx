import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable } from '@/components/ui/data-table';
import { Field, Select } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { EditGate, ErrorText, Saved } from '@/components/page';
import { useT } from '@/i18n';
import { useAttemptKey } from '@/lib/api/attempt-key';
import { useOnline } from '@/lib/offline/connectivity';
import { useSignedIn } from '@/lib/session';
import { INV, invPerm } from '@/lib/permissions';
import { inventoryApi, inventoryKeys } from './api';
import { useInvRefs } from './hooks';
import { netWeight, parseWeight } from './piece-rules';
import { BranchPicker, InvPage, NotReadyOr, Wt } from './ui';
import type { LooseStock } from './types';

/** Loose-stock receipt validation (pure). Returns an i18n key or null. */
export function looseError(m: { branch_id: string; item_id: string; purity_id: string; pcs: string; gross: string; stone: string }): 'inventory.err.branch' | 'inventory.err.item' | 'inventory.err.purity' | 'inventory.err.pcs' | 'inventory.err.gross' | 'inventory.err.stone' | null {
  if (!m.branch_id) return 'inventory.err.branch';
  if (!m.item_id) return 'inventory.err.item';
  if (!m.purity_id) return 'inventory.err.purity';
  if (!/^\d{1,6}$/.test(m.pcs)) return 'inventory.err.pcs';
  const g = parseWeight(m.gross);
  if (!g) return 'inventory.err.gross';
  const s = m.stone.trim() ? parseWeight(m.stone, true) : '0.000';
  if (s === null || netWeight(g, s) === null) return 'inventory.err.stone';
  return null;
}

/**
 * 4 — Loose stock (0.8.0): balances per branch / counter / tray / item / purity, and RECEIPTS only. Stock leaves loose
 * through tagging (source loose), sales, transfers, moves or an approved adjustment — there is no free "out" entry.
 */
export function LoosePage() {
  const t = useT();
  const signedIn = useSignedIn();
  const qc = useQueryClient();
  const online = useOnline();
  const refs = useInvRefs();
  const key = useAttemptKey();
  const [branch, setBranch] = useState('');
  const [m, setM] = useState({ branch_id: '', counter_id: '', item_id: '', purity_id: '', pcs: '0', gross: '', stone: '', note: '' });
  const list = useQuery({ queryKey: inventoryKeys.loose(branch || undefined), queryFn: () => inventoryApi.loose(branch || undefined), enabled: signedIn, retry: false });
  const target = m.branch_id || refs.branches[0]?.id || '';
  const err = looseError({ ...m, branch_id: target });
  const upd = (p: Partial<typeof m>) => { key.reset(); setM({ ...m, ...p }); };
  const save = useMutation({
    mutationFn: () => {
      const g = parseWeight(m.gross) ?? '0.000';
      const s = m.stone.trim() ? parseWeight(m.stone, true) ?? '0.000' : '0.000';
      return inventoryApi.receiveLoose({
        branch_id: target, counter_id: m.counter_id || null, item_id: m.item_id, purity_id: m.purity_id,
        pieces: Number(m.pcs), gross_wt: g, net_wt: netWeight(g, s) ?? g, note: m.note.trim() || null,
      }, key.take());
    },
    onSuccess: () => { key.reset(); setM({ ...m, pcs: '0', gross: '', stone: '', note: '' }); void qc.invalidateQueries({ queryKey: ['inventory', 'loose'] }); },
    onError: (e) => key.settle(e),
  });
  const cols: ColumnDef<LooseStock>[] = [
    { header: t('inventory.item'), cell: ({ row }) => refs.itemName(row.original.item_id) },
    { header: t('inventory.purity'), cell: ({ row }) => <span lang="en" className="font-mono">{refs.purityCode(row.original.purity_id)}</span> },
    { header: t('inventory.branch'), cell: ({ row }) => refs.branchName(row.original.branch_id) },
    { header: t('inventory.place'), cell: ({ row }) => `${refs.counterName(row.original.counter_id)} · ${refs.trayName(row.original.tray_id)}` },
    { header: t('inventory.pcs'), cell: ({ row }) => <span className="tabular-nums">{row.original.pieces}</span> },
    { header: t('inventory.grossWt'), cell: ({ row }) => <Wt v={row.original.gross_wt} /> },
    { header: t('inventory.netWt'), cell: ({ row }) => <Wt v={row.original.net_wt} /> },
  ];
  return (
    <InvPage title="inventory.loose.title" description="inventory.loose.desc">
      <div className="max-w-xs"><BranchPicker value={branch} onChange={setBranch} branches={refs.branches} allLabel={t('inventory.allBranches')} /></div>
      <NotReadyOr error={list.error} />
      <DataTable columns={cols} data={list.data?.items ?? []} empty={t('inventory.loose.empty')} caption={t('inventory.loose.title')} />
      <EditGate perm={invPerm(INV.tagCreate)}>
        <Card>
          <CardHeader><CardTitle>{t('inventory.loose.record')}</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">{t('inventory.loose.receiptOnly')}</p>
            <div className="grid gap-3 md:grid-cols-4">
              <Field label={t('inventory.branch')}>{(id) => <BranchPicker id={id} value={target} onChange={(v) => upd({ branch_id: v, counter_id: '' })} branches={refs.branches} />}</Field>
              <Field label={t('inventory.counter')}>{(id) => (
                <Select id={id} value={m.counter_id} onChange={(e) => upd({ counter_id: e.target.value })}>
                  <option value="">{t('inventory.none')}</option>
                  {refs.counters.filter((c) => c.branch_id === target).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>)}</Field>
              <Field label={t('inventory.item')}>{(id) => (
                <Select id={id} value={m.item_id} onChange={(e) => upd({ item_id: e.target.value, purity_id: refs.item(e.target.value)?.purity_id ?? m.purity_id })}>
                  <option value="" disabled>{t('common.choose')}</option>
                  {refs.items.filter((i) => i.stock_type !== 'tag').map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                </Select>)}</Field>
              <Field label={t('inventory.purity')}>{(id) => (
                <Select id={id} value={m.purity_id} onChange={(e) => upd({ purity_id: e.target.value })}>
                  <option value="" disabled>{t('common.choose')}</option>
                  {refs.purities.filter((p) => p.is_active).map((p) => <option key={p.id} value={p.id}>{p.code}</option>)}
                </Select>)}</Field>
              <Field label={t('inventory.pcs')} hint={t('inventory.loose.pcsHint')}>{(id, h) => <Input id={id} aria-describedby={h} inputMode="numeric" value={m.pcs} onChange={(e) => upd({ pcs: e.target.value })} />}</Field>
              <Field label={t('inventory.grossWt')}>{(id) => <Input id={id} inputMode="decimal" className="tabular-nums" value={m.gross} onChange={(e) => upd({ gross: e.target.value })} />}</Field>
              <Field label={t('inventory.stoneWt')}>{(id) => <Input id={id} inputMode="decimal" className="tabular-nums" value={m.stone} onChange={(e) => upd({ stone: e.target.value })} />}</Field>
              <Field label={t('inventory.note')}>{(id) => <Input id={id} value={m.note} onChange={(e) => upd({ note: e.target.value })} />}</Field>
            </div>
            {m.gross && err ? <p className="text-sm text-destructive">{t(err)}</p> : null}
            <ErrorText error={save.error} />
            <div className="flex items-center gap-3">
              <Button disabled={!online || !!err || save.isPending} onClick={() => save.mutate()}>{t('inventory.loose.save')}</Button>
              <Saved show={save.isSuccess} />
            </div>
          </CardContent>
        </Card>
      </EditGate>
    </InvPage>
  );
}
