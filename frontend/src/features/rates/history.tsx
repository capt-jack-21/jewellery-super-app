import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Field, Select } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ErrorText } from '@/components/page';
import { useT, useTk } from '@/i18n';
import { ApiError } from '@/lib/api/fetcher';
import { formatDateIN, formatDateTimeIN, formatINR } from '@/lib/format';
import { useSignedIn } from '@/lib/session';
import { ratesApi, ratesKeys, type HistoryFilter, type MetalRate, type RateKind } from './api';
import { scopeOf, sortMetals } from './derive';
import { useRateRefs } from './hooks';

const PAGE = 50;
/** Entered = a base row (derived_from_id null); Derived = server value kept; Adjusted = an override of the derived value. */
export const originOf = (r: MetalRate): 'entered' | 'derived' | 'adjusted' =>
  !r.derived_from_id ? 'entered' : r.derived_rate_per_g != null && r.derived_rate_per_g !== r.rate_per_g ? 'adjusted' : 'derived';
const KINDS: RateKind[] = ['sale', 'old_metal', 'purchase'];

/** Rate history table: date range, metal (server filter), purity, kind, branch. Newest first, keyset paged.
 * "Until" is effective_to — an exclusive end (the moment the next rate took over). */
export function RateHistoryTable() {
  const t = useT();
  const tk = useTk();
  const signedIn = useSignedIn();
  const { metals, purities, branches } = useRateRefs();
  const [f, setF] = useState<HistoryFilter>({});
  const set = (p: Partial<HistoryFilter>) => setF((o) => Object.fromEntries(Object.entries({ ...o, ...p }).filter(([, v]) => v)) as HistoryFilter);
  const params: HistoryFilter = { ...f, limit: PAGE };
  const q = useInfiniteQuery({
    queryKey: ratesKeys.history(params),
    queryFn: ({ pageParam }) => ratesApi.history({ ...params, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: '',
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: signedIn,
  });
  const pOf = (id: string) => purities.find((p) => p.id === id);
  const mOf = (id?: string) => metals.find((m) => m.id === id);
  const rows = q.data?.pages.flatMap((p) => p.items) ?? [];
  const badCursor = q.error instanceof ApiError && q.error.code === 'invalid_cursor';
  return (
    <Card>
      <CardContent className="space-y-3 pt-4 text-sm">
        <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6" role="search">
          <Field label={t('rates.filter.from')}>{(id) => <Input id={id} type="date" value={f.from ?? ''} onChange={(e) => set({ from: e.target.value })} />}</Field>
          <Field label={t('rates.filter.to')}>{(id) => <Input id={id} type="date" value={f.to ?? ''} onChange={(e) => set({ to: e.target.value })} />}</Field>
          <Field label={t('rates.filter.metal')}>{(id) => (
            <Select id={id} value={f.metal_id ?? ''} onChange={(e) => set({ metal_id: e.target.value, purity_id: '' })}>
              <option value="">{t('rates.filter.any')}</option>
              {sortMetals(metals).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </Select>)}
          </Field>
          <Field label={t('rates.filter.purity')}>{(id) => (
            <Select id={id} value={f.purity_id ?? ''} onChange={(e) => set({ purity_id: e.target.value })}>
              <option value="">{t('rates.filter.any')}</option>
              {purities.filter((p) => !f.metal_id || p.metal_id === f.metal_id).map((p) => <option key={p.id} value={p.id}>{`${mOf(p.metal_id)?.name ?? ''} ${p.code}`}</option>)}
            </Select>)}
          </Field>
          <Field label={t('rates.filter.kind')}>{(id) => (
            <Select id={id} value={f.kind ?? ''} onChange={(e) => set({ kind: e.target.value as RateKind })}>
              <option value="">{t('rates.filter.any')}</option>
              {KINDS.map((k) => <option key={k} value={k}>{tk(`rates.kind.${k}`)}</option>)}
            </Select>)}
          </Field>
          <Field label={t('rates.filter.branch')}>{(id) => (
            <Select id={id} value={f.branch_id ?? ''} onChange={(e) => set({ branch_id: e.target.value })}>
              <option value="">{t('rates.filter.anyBranch')}</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>)}
          </Field>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full" data-testid="rate-history">
            <thead><tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="py-1">{t('rates.col.date')}</th><th>{t('rates.col.metal')}</th><th>{t('rates.col.purity')}</th><th>{t('rates.col.kind')}</th>
              <th>{t('rates.col.appliesTo')}</th><th className="text-right">{t('rates.col.rate')}</th><th>{t('rates.col.origin')}</th><th>{t('rates.col.published')}</th><th>{t('rates.col.until')}</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => {
                const p = pOf(r.purity_id);
                return (
                  <tr key={r.id} className="border-b border-border">
                    <td className="py-1 tabular-nums">{formatDateIN(r.rate_date)}</td>
                    <td>{mOf(p?.metal_id)?.name ?? '—'}</td>
                    <td lang="en">{p?.code ?? '—'}</td>
                    <td>{tk(`rates.kind.${r.kind}`)}</td>
                    <td>{scopeOf(r) === 'branch' ? branches.find((b) => b.id === r.branch_id)?.name ?? t('rates.scope.branch') : t('rates.allBranches')}</td>
                    <td className="text-right font-mono tabular-nums">{formatINR(r.rate_per_g)}</td>
                    <td className="text-xs" data-testid={`origin-${r.id}`}>{t(`rates.origin.${originOf(r)}`)}{originOf(r) === 'adjusted' && r.derived_rate_per_g ? <span className="block text-muted-foreground">{t('rates.origin.derivedWas', { rate: formatINR(r.derived_rate_per_g) })}</span> : null}</td>
                    <td className="text-xs text-muted-foreground">{formatDateTimeIN(r.effective_from)}</td>
                    <td className="text-xs text-muted-foreground">{r.effective_to ? formatDateTimeIN(r.effective_to) : t('rates.inForce')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {rows.length === 0 && !q.isLoading ? <p className="text-muted-foreground">{t('rates.historyEmpty')}</p> : null}
        <ErrorText error={q.error} />
        {badCursor ? <Button size="sm" variant="ghost" onClick={() => void q.refetch()}>{t('rates.reload')}</Button> : null}
        {q.hasNextPage ? <Button size="sm" variant="outline" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{t('rates.loadMore')}</Button> : null}
      </CardContent>
    </Card>
  );
}
