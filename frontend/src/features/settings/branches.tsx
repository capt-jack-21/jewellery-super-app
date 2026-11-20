import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable } from '@/components/ui/data-table';
import { Check, Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ErrorText, OfflineBanner, PageHeader, EditGate } from '@/components/page';
import { EDIT_SETTINGS } from '@/lib/permissions';

import { useT } from '@/i18n';
import { ApiError, ifMatch, ok } from '@/lib/api/fetcher';
import { createBranch, updateBranch, getListBranchesQueryKey } from '@/lib/api/backend/tenant/tenant';
import type { Address, Branch } from '@/lib/api/backend/model';
import { useOnline } from '@/lib/offline/connectivity';
import { useBranches } from '@/features/devices/devices';
import { GSTIN_RE, useCompanies } from './shop';

/** bill_series_prefix: the contract requires it on create, so a blank field falls back to the branch code (as the server does for
 * admin tenant create); blank on edit keeps the stored prefix. Editable; pattern (Latin A–Z/0–9, '/', '-'; max 12). */
export const SERIES_RE = /^[A-Z0-9][A-Z0-9/-]{0,11}$/;
type BranchForm = { code: string; name: string; state_code: string; gstin: string; bill_series_prefix: string; is_active: boolean; address: Address };
type BranchRow = Branch;
/** Blank prefix → branch code (contract requires a prefix on create). */
export const seriesOrCode = (f: Pick<BranchForm, 'code' | 'bill_series_prefix'>): string => f.bill_series_prefix.trim() || f.code.trim().toUpperCase();

const blank = (): BranchForm => ({ code: '', name: '', state_code: '', gstin: '', bill_series_prefix: '', is_active: true, address: {} });

/**
 * P4 branches. GSTIN rule (approved): optional, defaults to the shop GSTIN, required only when the branch is
 * in another state. Each branch has its own bill series prefix; numbers themselves are server-assigned (INV-1).
 */
export function BranchesManager() {
  const t = useT();
  const qc = useQueryClient();
  const online = useOnline();
  const shop = useCompanies().data?.[0];
  const branches = useBranches();
  const [editing, setEditing] = useState<{ id: string; version: number } | null>(null);
  const [f, setF] = useState<BranchForm>(blank);
  const outOfState = !!f.state_code && !!shop && f.state_code !== shop.state_code;
  const gstinErr = f.gstin ? (!GSTIN_RE.test(f.gstin) ? t('validation.gstin') : f.gstin.slice(0, 2) !== f.state_code ? t('validation.gstinState') : null)
    : outOfState ? t('branch.gstinRequired') : null;
  const seriesErr = f.bill_series_prefix && !SERIES_RE.test(f.bill_series_prefix) ? t('branch.seriesInvalid') : null;
  const valid = f.code.trim() && f.name.trim() && /^[0-9]{2}$/.test(f.state_code) && (!f.bill_series_prefix || SERIES_RE.test(f.bill_series_prefix)) && !gstinErr && !!shop;
  const save = useMutation({
    mutationFn: () => {
      const gstin = f.gstin || undefined;
      return editing
        ? ok(updateBranch(editing.id, { name: f.name, gstin, address: f.address, is_active: f.is_active, ...(f.bill_series_prefix ? { bill_series_prefix: f.bill_series_prefix } : {}) }, ifMatch(editing.version)))
        : ok(createBranch({ company_id: shop?.id ?? '', code: f.code, name: f.name, state_code: f.state_code, gstin, address: f.address, bill_series_prefix: seriesOrCode(f) }));
    },
    // 412/428: someone else saved first → refetch so the next edit carries the fresh version.
    onError: (e) => { if (e instanceof ApiError && e.isStale) void qc.invalidateQueries({ queryKey: getListBranchesQueryKey() }); },
    onSuccess: () => { setF(blank()); setEditing(null); void qc.invalidateQueries({ queryKey: getListBranchesQueryKey() }); void qc.invalidateQueries({ queryKey: ['/v1/onboarding'] }); },
  });
  const edit = (b: BranchRow) => { setEditing({ id: b.id, version: b.version }); setF({ code: b.code, name: b.name, state_code: b.state_code, gstin: b.gstin ?? '', bill_series_prefix: b.bill_series_prefix ?? '', is_active: b.is_active, address: (b.address ?? {}) as Address }); };
  const addrOf = (b: Branch) => (b.address ?? {}) as Address;
  const columns: Array<ColumnDef<BranchRow>> = [
    { header: t('branch.code'), cell: (c) => <span className="font-mono">{c.row.original.code}</span> },
    { header: t('branch.name'), cell: (c) => <div><p>{c.row.original.name}</p><p className="text-xs text-muted-foreground">{[addrOf(c.row.original).line1, addrOf(c.row.original).city].filter(Boolean).join(', ')}</p></div> },
    { header: t('branch.state'), accessorKey: 'state_code' },
    { header: t('branch.gstin'), cell: (c) => <div className="font-mono">{c.row.original.gstin ?? shop?.gstin}{c.row.original.gstin ? null : <p className="font-body text-xs text-muted-foreground">{t('branch.inheritsShop')}</p>}</div> },
    { header: t('branch.series'), cell: (c) => <span className="font-mono">{c.row.original.bill_series_prefix}{'/…'}</span> },
    { header: t('common.status'), cell: (c) => <Badge variant={c.row.original.is_active ? 'success' : 'outline'}>{t(c.row.original.is_active ? 'common.active' : 'common.inactive')}</Badge> },
    { id: 'a', header: '', cell: (c) => <Button size="sm" variant="outline" onClick={() => edit(c.row.original)}>{t('common.edit')}</Button> },
  ];
  return (
    <div className="space-y-4">
      <DataTable columns={columns} data={branches.data ?? []} caption={t('branch.title')} />
      <Card>
        <CardHeader><CardTitle>{t(editing ? 'branch.edit' : 'branch.add')}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 md:grid-cols-3">
            <Field label={t('branch.code')}>{(id) => <Input id={id} className="font-mono uppercase" maxLength={10} disabled={!!editing} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} />}</Field>
            <Field label={t('branch.name')}>{(id) => <Input id={id} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
            <Field label={t('branch.series')} hint={t('branch.seriesHint', { code: f.code || '—' })} error={seriesErr}>{(id, d) => <Input id={id} aria-describedby={d} className="font-mono uppercase" maxLength={12} placeholder={f.code || undefined} value={f.bill_series_prefix} onChange={(e) => setF({ ...f, bill_series_prefix: e.target.value.toUpperCase().replace(/[^A-Z0-9/-]/g, '') })} />}</Field>
            <Field label={t('shop.address1')}>{(id) => <Input id={id} value={f.address?.line1 ?? ''} onChange={(e) => setF({ ...f, address: { ...f.address, line1: e.target.value } })} />}</Field>
            <Field label={t('shop.city')}>{(id) => <Input id={id} value={f.address?.city ?? ''} onChange={(e) => setF({ ...f, address: { ...f.address, city: e.target.value } })} />}</Field>
            <Field label={t('shop.stateCode')}>{(id) => <Input id={id} inputMode="numeric" maxLength={2} disabled={!!editing} value={f.state_code} onChange={(e) => setF({ ...f, state_code: e.target.value })} />}</Field>
            <Field label={t('branch.gstin')} error={gstinErr} hint={outOfState ? undefined : t('branch.gstinHint', { gstin: shop?.gstin ?? '' })} className="md:col-span-2">
              {(id, d) => <Input id={id} aria-describedby={d} className="font-mono uppercase" maxLength={15} value={f.gstin} onChange={(e) => setF({ ...f, gstin: e.target.value.toUpperCase() })} />}</Field>
            <Check label={t('common.active')} checked={f.is_active} onChange={(v) => setF({ ...f, is_active: v })} />
          </div>
          <ErrorText error={save.error} />
          <div className="flex gap-2">
            <Button disabled={!online || !valid || save.isPending} onClick={() => save.mutate()}>{t('common.save')}</Button>
            {editing ? <Button variant="ghost" onClick={() => { setEditing(null); setF(blank()); }}>{t('common.cancel')}</Button> : null}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export function BranchesPage() {
  const t = useT();
  return <div><PageHeader title={t('branch.title')} description={t('branch.description')} /><OfflineBanner /><EditGate perm={EDIT_SETTINGS}><BranchesManager /></EditGate></div>;
}
