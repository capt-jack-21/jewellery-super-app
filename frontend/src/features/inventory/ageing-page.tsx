import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Field, Select } from '@/components/ui/field';
import { useT, useTk } from '@/i18n';
import { useSignedIn } from '@/lib/session';
import { inventoryApi, inventoryKeys, isFeatureOff } from './api';
import { useInvRefs, useInventorySettings } from './hooks';
import { bucketRange } from './ageing';
import { BranchPicker, InvPage, NotReadyOr, Wt } from './ui';
import type { StockAgeingBucket } from './types';

const GROUPS = ['item', 'design', 'purity', 'counter'] as const;
type Group = (typeof GROUPS)[number];

/**
 * 11 — Ageing (optional; 0.8.2 server report): how long in-stock pieces have sat, in the shop's day bands (first band
 * 0–(N−1), last N+). Age counts from received_on when the piece has one (opening stock), else the IST tagging date.
 * Bucket labels are ours (the server's English `label` is ignored; `code` keys the columns).
 */
export function AgeingPage() {
  const t = useT();
  const tk = useTk();
  const signedIn = useSignedIn();
  const refs = useInvRefs();
  const settings = useInventorySettings();
  const [branch, setBranch] = useState('');
  const [group, setGroup] = useState<Group>('item');
  const enabled = settings.data?.ageing_enabled !== false;
  const q = useQuery({ queryKey: inventoryKeys.ageing(branch || undefined, group), queryFn: () => inventoryApi.ageing(branch || undefined, group), enabled: signedIn && enabled, retry: false });
  const label = (b: StockAgeingBucket) => { const r = bucketRange(b); return r.to === null ? t('inventory.ageing.over', { from: r.from }) : t('inventory.ageing.range', { from: r.from, to: r.to }); };
  if (!enabled || isFeatureOff(q.error)) {
    return (
      <InvPage title="inventory.ageing.title">
        <p role="note" data-testid="ageing-off" className="text-sm">{t('inventory.ageing.off')} <Link to="/settings/inventory" className="underline">{t('inventory.nav.settings')}</Link></p>
      </InvPage>
    );
  }
  const totals = q.data?.totals ?? [];
  const max = Math.max(1, ...totals.map((b) => b.pieces));
  return (
    <InvPage title="inventory.ageing.title" description="inventory.ageing.desc">
      <div className="grid max-w-xl gap-3 md:grid-cols-2">
        <Field label={t('inventory.branch')}>{(id) => <BranchPicker id={id} value={branch} onChange={setBranch} branches={refs.branches} allLabel={t('inventory.allBranches')} />}</Field>
        <Field label={t('inventory.val.groupBy')}>{(id) => (
          <Select id={id} value={group} onChange={(e) => setGroup(e.target.value as Group)}>
            {GROUPS.map((g) => <option key={g} value={g}>{tk(`inventory.ageing.group.${g}`)}</option>)}
          </Select>)}</Field>
      </div>
      <NotReadyOr error={q.error} />
      <table className="w-full max-w-2xl text-sm" data-testid="ageing-table">
        <caption className="sr-only">{t('inventory.ageing.title')}</caption>
        <thead><tr className="text-left">
          <th className="py-1 font-medium">{t('inventory.ageing.band')}</th><th className="py-1 font-medium">{t('inventory.pcs')}</th>
          <th className="py-1 font-medium">{t('inventory.netWt')}</th><th className="py-1"><span className="sr-only">{t('inventory.ageing.bar')}</span></th>
        </tr></thead>
        <tbody className="divide-y divide-border">
          {totals.map((b) => (
            <tr key={b.from_days}>
              <td className="py-1">{label(b)}</td>
              <td className="py-1 tabular-nums">{b.pieces}</td>
              <td className="py-1"><Wt v={b.net_wt} /></td>
              <td className="w-1/3 py-1"><div aria-hidden className="h-2 rounded bg-primary" style={{ width: `${Math.round((b.pieces / max) * 100)}%` }} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      {q.data?.groups.length ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="ageing-groups">
            <caption className="sr-only">{tk(`inventory.ageing.group.${group}`)}</caption>
            <thead><tr className="text-left">
              <th className="py-1 font-medium">{tk(`inventory.ageing.group.${group}`)}</th>
              {totals.map((b) => <th key={b.code} className="py-1 font-medium">{label(b)}</th>)}
              <th className="py-1 font-medium">{t('inventory.ageing.oldest')}</th>
            </tr></thead>
            <tbody className="divide-y divide-border">
              {q.data.groups.map((g) => (
                <tr key={g.key_id ?? g.label}>
                  <td className="py-1">{g.label}</td>
                  {totals.map((tb) => <td key={tb.code} className="py-1 tabular-nums">{g.buckets.find((b) => b.code === tb.code)?.pieces ?? 0}</td>)}
                  <td className="py-1 tabular-nums">{g.oldest_days ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </InvPage>
  );
}
