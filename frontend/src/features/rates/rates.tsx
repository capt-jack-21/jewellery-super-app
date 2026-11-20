import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Check } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ErrorText, OfflineBanner, PageHeader } from '@/components/page';
import { useT } from '@/i18n';
import { ApiError, ifMatch, ok } from '@/lib/api/fetcher';
import {
  createMetal, createPurity, getListMetalsQueryKey, getListPuritiesQueryKey, listMetals, listPurities, updateMetal, updatePurity,
} from '@/lib/api/backend/masters/masters';
import type { Metal, MetalPatch, Purity, PurityPatch } from '@/lib/api/backend/model';
import { formatPurity, parseFineness } from '@/lib/format';
import { useOnline } from '@/lib/offline/connectivity';
import { uuid } from '@/lib/uuid';
import { mastersManage } from '@/lib/permissions';
import { useCan, useSignedIn } from '@/lib/session';
import { TodaysRatesForm } from './entry';
export { branchParam as ratesParams } from './api';

const METAL_CODE = /^[A-Z][A-Z0-9_]{0,9}$/;
const PURITY_CODE = /^[A-Z0-9]{1,10}$/;
const HSN = /^[0-9]{4}([0-9]{2}){0,2}$/;
const metalTone = (code?: string) => (code === 'GOLD' ? 'text-metal-gold' : 'text-metal-silver');

/** Lists hide deactivated rows unless includeInactive (0.4.2 `include_inactive=true`). */
const listParams = (includeInactive: boolean) => (includeInactive ? { include_inactive: true } : undefined);

export function useMasters(includeInactive = false) {
  const signedIn = useSignedIn();
  const lp = listParams(includeInactive);
  const metals = useQuery({ queryKey: getListMetalsQueryKey(lp), queryFn: () => ok(listMetals(lp)), enabled: signedIn });
  const purities = useQuery({ queryKey: getListPuritiesQueryKey(lp), queryFn: () => ok(listPurities(lp)), enabled: signedIn });
  return { metals: metals.data ?? [], purities: purities.data ?? [], isLoading: metals.isLoading || purities.isLoading };
}

/** Purities of ONE metal, server-filtered by metal_id. */
export function usePurities(metalId: string, includeInactive = false) {
  const signedIn = useSignedIn();
  const params = { metal_id: metalId, ...listParams(includeInactive) };
  return useQuery({ queryKey: getListPuritiesQueryKey(params), queryFn: () => ok(listPurities(params)), enabled: signedIn && !!metalId });
}

/** masters writes: invalidate every metals/purities list (all filters) + onboarding (metals_purities step) + rates (inactive purities drop out). */
function useMastersInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith('/v1/masters/') });
    void qc.invalidateQueries({ queryKey: ['/v1/onboarding'] });
  };
}

/** 412/428 on a masters PATCH: the row changed under us — reload lists so the next try carries the new version. */
const staleOf = (e: unknown) => e instanceof ApiError && e.isStale;

/** P2/P10 metals & purities: list + add + edit + deactivate/restore (masters.metals.manage). PATCH sends If-Match (0.4.2). */
export function MetalsCard() {
  const t = useT();
  const can = useCan()(mastersManage('metals'));
  const online = useOnline();
  const [showInactive, setShowInactive] = useState(false);
  const { metals } = useMasters(showInactive);
  const inv = useMastersInvalidate();
  const [nm, setNm] = useState({ code: '', name: '', default_hsn: '7113' });
  const add = useMutation({ mutationFn: () => ok(createMetal({ code: nm.code, name: nm.name.trim(), default_hsn: nm.default_hsn }, { 'Idempotency-Key': uuid() })), onSuccess: () => { setNm({ code: '', name: '', default_hsn: '7113' }); inv(); } });
  const metalValid = METAL_CODE.test(nm.code) && nm.name.trim().length > 0 && HSN.test(nm.default_hsn);
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle>{t('wizard.step.metals')}</CardTitle>
        <Check label={t('masters.showInactive')} checked={showInactive} onChange={setShowInactive} />
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {metals.map((m) => <MetalBlock key={m.id} metal={m} canEdit={can && online} showInactive={showInactive} />)}
        {can ? (
          <form className="flex flex-wrap items-end gap-2 border-t border-border pt-3" onSubmit={(e) => { e.preventDefault(); if (metalValid) add.mutate(); }}>
            <Input aria-label={t('masters.metalCode')} placeholder="GOLD" className="h-8 w-28 font-mono" value={nm.code} onChange={(e) => setNm({ ...nm, code: e.target.value.toUpperCase().trim() })} />
            <Input aria-label={t('masters.metalName')} placeholder={t('masters.metalName')} className="h-8 w-40" value={nm.name} onChange={(e) => setNm({ ...nm, name: e.target.value })} />
            <Input aria-label={t('masters.hsn')} inputMode="numeric" className="h-8 w-24 font-mono" value={nm.default_hsn} onChange={(e) => setNm({ ...nm, default_hsn: e.target.value.trim() })} />
            <Button size="sm" type="submit" disabled={!online || !metalValid || add.isPending}>{t('masters.addMetal')}</Button>
            <ErrorText error={add.error} />
          </form>
        ) : <p className="text-xs text-muted-foreground">{t('masters.readOnly')}</p>}
      </CardContent>
    </Card>
  );
}

function StaleNote({ error }: { error: unknown }) {
  const t = useT();
  return staleOf(error) ? <p role="status" className="text-xs text-muted-foreground">{t('masters.staleReloaded')}</p> : <ErrorText error={error} />;
}

function MetalBlock({ metal, canEdit, showInactive }: { metal: Metal; canEdit: boolean; showInactive: boolean }) {
  const t = useT();
  const inv = useMastersInvalidate();
  const purities = usePurities(metal.id, showInactive).data ?? [];
  const [edit, setEdit] = useState<{ name: string; default_hsn: string } | null>(null);
  const [np, setNp] = useState({ code: '', fineness: '', huid_required: true });
  const save = useMutation({
    mutationFn: (b: MetalPatch) => ok(updateMetal(metal.id, b, ifMatch(metal.version))),
    onSuccess: () => { setEdit(null); inv(); },
    onError: (e) => { if (staleOf(e)) inv(); },
  });
  const fin = parseFineness(np.fineness);
  const addP = useMutation({
    mutationFn: () => ok(createPurity({ metal_id: metal.id, code: np.code, fineness: fin ?? '', huid_required: np.huid_required }, { 'Idempotency-Key': uuid() })),
    onSuccess: () => { setNp({ code: '', fineness: '', huid_required: true }); inv(); },
  });
  const active = metal.is_active;
  return (
    <div className={`space-y-2 ${active ? '' : 'opacity-70'}`} data-testid={`metal-${metal.code}`}>
      <div className="flex flex-wrap items-center gap-2">
        {edit ? (
          <>
            <Input aria-label={t('masters.metalName')} className="h-8 w-40" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            <Input aria-label={t('masters.hsn')} className="h-8 w-24 font-mono" value={edit.default_hsn} onChange={(e) => setEdit({ ...edit, default_hsn: e.target.value.trim() })} />
            <Button size="sm" disabled={!edit.name.trim() || !HSN.test(edit.default_hsn) || save.isPending} onClick={() => save.mutate({ name: edit.name.trim(), default_hsn: edit.default_hsn })}>{t('common.save')}</Button>
            <Button size="sm" variant="ghost" onClick={() => setEdit(null)}>{t('common.cancel')}</Button>
          </>
        ) : (
          <>
            <span className={`font-medium ${metalTone(metal.code)}`}>{metal.name}</span>
            <span className="text-xs text-muted-foreground">{`HSN ${metal.default_hsn ?? '—'}`}</span>
            {active ? null : <Badge variant="warning">{t('common.inactive')}</Badge>}
            {canEdit && active ? <Button size="sm" variant="ghost" onClick={() => setEdit({ name: metal.name, default_hsn: metal.default_hsn ?? '' })}>{t('common.edit')}</Button> : null}
            {canEdit ? (
              <Button size="sm" variant="ghost" disabled={save.isPending} aria-label={`${t(active ? 'masters.deactivate' : 'masters.restore')} ${metal.name}`}
                onClick={() => save.mutate({ is_active: !active })}>{t(active ? 'masters.deactivate' : 'masters.restore')}</Button>
            ) : null}
          </>
        )}
      </div>
      <StaleNote error={save.error} />
      <ul className="flex flex-wrap gap-2">
        {purities.map((p) => <PurityChip key={p.id} purity={p} canEdit={canEdit} metalActive={active} />)}
      </ul>
      {canEdit && active ? (
        <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (fin && PURITY_CODE.test(np.code)) addP.mutate(); }}>
          <Input aria-label={t('masters.purityCode', { metal: metal.name })} placeholder="22K" className="h-8 w-20 font-mono" value={np.code} onChange={(e) => setNp({ ...np, code: e.target.value.toUpperCase().trim() })} />
          <Input aria-label={t('masters.fineness', { metal: metal.name })} placeholder="916" inputMode="decimal" className="h-8 w-24 font-mono" value={np.fineness} onChange={(e) => setNp({ ...np, fineness: e.target.value })} />
          <Check label={t('masters.huidRequired')} checked={np.huid_required} onChange={(v) => setNp({ ...np, huid_required: v })} />
          <Button size="sm" variant="outline" type="submit" disabled={!fin || !PURITY_CODE.test(np.code) || addP.isPending}>{t('masters.addPurity')}</Button>
          {np.fineness && !fin ? <span className="text-xs text-destructive">{t('masters.finenessHint')}</span> : null}
          <ErrorText error={addP.error} />
        </form>
      ) : null}
    </div>
  );
}

function PurityChip({ purity, canEdit, metalActive }: { purity: Purity; canEdit: boolean; metalActive: boolean }) {
  const t = useT();
  const inv = useMastersInvalidate();
  const [f, setF] = useState<string | null>(null);
  const fin = f === null ? null : parseFineness(f);
  const save = useMutation({
    mutationFn: (b: PurityPatch) => ok(updatePurity(purity.id, b, ifMatch(purity.version))),
    onSuccess: () => { setF(null); inv(); },
    onError: (e) => { if (staleOf(e)) inv(); },
  });
  const active = purity.is_active;
  if (f !== null) {
    return (
      <li className="flex items-center gap-1">
        <Input aria-label={t('masters.fineness', { metal: purity.code })} className="h-7 w-24 font-mono" value={f} onChange={(e) => setF(e.target.value)} />
        <Button size="sm" disabled={!fin || save.isPending} onClick={() => fin && save.mutate({ fineness: fin })}>{t('common.save')}</Button>
        <Button size="sm" variant="ghost" onClick={() => setF(null)}>{t('common.cancel')}</Button>
        <StaleNote error={save.error} />
      </li>
    );
  }
  return (
    <li className="flex flex-wrap items-center gap-1">
      <Badge variant={active ? 'outline' : 'warning'}>{formatPurity(purity.code, purity.fineness)}{purity.huid_required ? ' · HUID' : ''}{active ? '' : ` · ${t('common.inactive')}`}</Badge>
      {canEdit && active ? (
        <>
          <Button size="sm" variant="ghost" aria-label={t('masters.editPurity', { purity: purity.code })} onClick={() => setF(purity.fineness)}>{t('common.edit')}</Button>
          <Check label={t('masters.huidRequired')} checked={purity.huid_required} disabled={save.isPending} onChange={(v) => save.mutate({ huid_required: v })} />
        </>
      ) : null}
      {canEdit && (active || metalActive) ? (
        <Button size="sm" variant="ghost" disabled={save.isPending} aria-label={`${t(active ? 'masters.deactivate' : 'masters.restore')} ${purity.code}`}
          onClick={() => save.mutate({ is_active: !active })}>{t(active ? 'masters.deactivate' : 'masters.restore')}</Button>
      ) : null}
      <StaleNote error={save.error} />
    </li>
  );
}

/** Settings → Metals & purities (editable masters) + today's rate entry (features/rates/entry). */
export function MastersSettingsPage() {
  const t = useT();
  return (
    <div className="space-y-4">
      <PageHeader title={t('masters.title')} description={t('masters.description')} />
      <OfflineBanner />
      <MetalsCard />
      <TodaysRatesForm />
    </div>
  );
}
