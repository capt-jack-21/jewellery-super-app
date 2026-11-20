import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Card, CardContent } from '@/components/ui/card';
import { DataTable } from '@/components/ui/data-table';
import { Field, Select } from '@/components/ui/field';
import { useT, useTk } from '@/i18n';
import { formatDateTimeIN, formatINR } from '@/lib/format';
import { useSignedIn } from '@/lib/session';
import { inventoryApi, inventoryKeys } from './api';
import { useInvRefs } from './hooks';
import { BranchPicker, InvPage, NotReadyOr, Wt } from './ui';
import type { StockValuationIncludes, StockValuationRow } from './types';

export const VALUATION_GROUPS = ['purity', 'metal', 'branch', 'counter', 'item'] as const;
export type ValuationGroup = (typeof VALUATION_GROUPS)[number];

/** Row label for the chosen grouping: server `labels` first, then our reference lists. */
export function valuationRowLabel(r: StockValuationRow, g: ValuationGroup, refs: { purityCode: (id?: string | null) => string; itemName: (id?: string | null) => string; branchName: (id?: string | null) => string; counterName: (id?: string | null) => string }): string {
  const id = { purity: r.purity_id, metal: r.metal_id, branch: r.branch_id, counter: r.counter_id, item: r.item_id }[g];
  const fromServer = id ? r.labels?.[id] : undefined;
  if (fromServer) return g === 'purity' || g === 'metal' ? fromServer.code ?? fromServer.name : fromServer.name;
  if (g === 'purity') return refs.purityCode(id);
  if (g === 'item') return refs.itemName(id);
  if (g === 'branch') return refs.branchName(id);
  if (g === 'counter') return refs.counterName(id);
  return '—';
}

/** 0.8.2 typed `includes` → which value parts are in / out of the totals. We read the flags rather than assume them. */
export const VALUE_PARTS = ['metal', 'loose', 'stone_value', 'making', 'gst'] as const;
export type ValuePart = (typeof VALUE_PARTS)[number];
export function valueParts(inc: StockValuationIncludes | undefined): { included: ValuePart[]; excluded: ValuePart[] } {
  if (!inc) return { included: [], excluded: [] };
  return { included: VALUE_PARTS.filter((p) => inc[p]), excluded: VALUE_PARTS.filter((p) => !inc[p]) };
}

/**
 * 9 — Valuation (0.8.2): computed by the SERVER (GET /v1/inventory/valuation) at today's rates. The footer is built
 * from `value_basis` (opaque label, 'metal' in this build) and the typed `includes` flags; pieces whose purity has no
 * rate are listed as unvalued.
 */
export function ValuationPage() {
  const t = useT();
  const tk = useTk();
  const signedIn = useSignedIn();
  const refs = useInvRefs();
  const [branch, setBranch] = useState('');
  const [group, setGroup] = useState<ValuationGroup>('purity');
  const q = useQuery({ queryKey: inventoryKeys.valuation(branch || undefined, group), queryFn: () => inventoryApi.valuation(branch || undefined, group), enabled: signedIn, retry: false });
  const v = q.data;
  const money = (x?: string | null) => (x == null ? '—' : formatINR(x));
  const missing = v?.missing_rate_purity_ids ?? [];
  const cols: ColumnDef<StockValuationRow>[] = [
    { header: tk(`inventory.val.group.${group}`), cell: ({ row }) => <span lang="en" className={group === 'purity' ? 'font-mono' : undefined}>{valuationRowLabel(row.original, group, refs)}</span> },
    { header: t('inventory.pcs'), cell: ({ row }) => <span className="tabular-nums">{row.original.pieces}</span> },
    { header: t('inventory.grossWt'), cell: ({ row }) => <Wt v={row.original.gross_wt} /> },
    { header: t('inventory.netWt'), cell: ({ row }) => <Wt v={row.original.net_wt} /> },
    { header: t('inventory.val.rate'), cell: ({ row }) => <span className="tabular-nums">{row.original.rate_per_g ? formatINR(row.original.rate_per_g) : t('inventory.val.noRate')}</span> },
    { header: t('inventory.val.metal'), cell: ({ row }) => <span className="tabular-nums">{money(row.original.metal_value)}</span> },
    { header: t('inventory.val.total'), cell: ({ row }) => <span className="tabular-nums font-medium">{money(row.original.total_value)}</span> },
  ];
  return (
    <InvPage title="inventory.val.title" description="inventory.val.desc">
      <div className="grid max-w-xl gap-3 md:grid-cols-2">
        <Field label={t('inventory.branch')}>{(id) => <BranchPicker id={id} value={branch} onChange={setBranch} branches={refs.branches} allLabel={t('inventory.allBranches')} />}</Field>
        <Field label={t('inventory.val.groupBy')}>{(id) => (
          <Select id={id} value={group} onChange={(e) => setGroup(e.target.value as ValuationGroup)}>
            {VALUATION_GROUPS.map((g) => <option key={g} value={g}>{tk(`inventory.val.group.${g}`)}</option>)}
          </Select>)}</Field>
      </div>
      <NotReadyOr error={q.error} />
      {missing.length > 0 ? (
        <p role="alert" className="rounded-md border border-warning bg-warning/15 p-3 text-sm">
          {t('inventory.val.missingRates', { n: missing.length })} <span lang="en" className="font-mono">{missing.map((id) => refs.purityCode(id)).join(', ')}</span>
        </p>
      ) : null}
      <div className="grid gap-3 md:grid-cols-4">
        <Stat label={t('inventory.pcs')} value={String(v?.totals.pieces ?? 0)} />
        <Stat label={t('inventory.netWt')} value={<Wt v={v?.totals.net_wt} />} />
        <Stat label={t('inventory.val.metal')} value={money(v?.totals.metal_value)} />
        <Stat label={t('inventory.val.total')} value={money(v?.totals.total_value)} testId="valuation-total" />
      </div>
      {v?.totals.unvalued_net_wt && v.totals.unvalued_net_wt !== '0.000' ? <p className="text-sm">{t('inventory.val.unvalued')} <Wt v={v.totals.unvalued_net_wt} /></p> : null}
      <DataTable columns={cols} data={v?.rows ?? []} empty={t('inventory.val.empty')} caption={t('inventory.val.title')} />
      {v ? <p className="text-xs text-muted-foreground">{t('inventory.val.asOf', { at: formatDateTimeIN(v.as_of) })}</p> : null}
      <p className="text-xs text-muted-foreground">{t('inventory.val.basis')}</p>
      {v ? (() => {
        const parts = valueParts(v.includes);
        return (
          <p className="text-xs text-muted-foreground" data-testid="valuation-includes">
            {t('inventory.val.valueBasis', { basis: tk(`inventory.val.valueBasis.${v.value_basis}`) })}
            {parts.included.length ? ` · ${t('inventory.val.included', { parts: parts.included.map((x) => tk(`inventory.val.part.${x}`)).join(', ') })}` : ''}
            {parts.excluded.length ? ` · ${t('inventory.val.excluded', { parts: parts.excluded.map((x) => tk(`inventory.val.part.${x}`)).join(', ') })}` : ''}
          </p>
        );
      })() : null}
    </InvPage>
  );
}

function Stat({ label, value, testId }: { label: string; value: ReactNode; testId?: string }) {
  return <Card><CardContent className="pt-4"><p className="text-sm text-muted-foreground">{label}</p><p className="text-xl font-semibold tabular-nums" data-testid={testId}>{value}</p></CardContent></Card>;
}
