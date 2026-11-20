import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Select } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ErrorText } from '@/components/page';
import { ApiError } from '@/lib/api/fetcher';
import { useAttemptKey } from '@/lib/api/attempt-key';
import { useT, useTk } from '@/i18n';
import { formatDateTimeIN, formatINR, formatPurity, parseRate2dp } from '@/lib/format';
import { useOnline } from '@/lib/offline/connectivity';
import { useCan } from '@/lib/session';
import type { Metal, MetalRate, Purity } from '@/lib/api/backend/model';
import { ratesApi, ratesKeys, type RateKind } from './api';
import { basePurity, deriveAll, istDay, scopeOf, sortMetals } from './derive';
import { useCurrentRates, useRateRefs } from './hooks';

const metalTone = (code?: string) => (code === 'GOLD' ? 'text-metal-gold' : 'text-metal-silver');
type Draft = Record<string, { sale: string; old: string; adjust?: Record<string, string> }>;
type Plan = { kind: RateKind; bases: Array<{ purity_id: string; rate_per_g: string }>; overrides: Array<{ purity_id: string; rate_per_g: string }> };

/** Friendly copy for batch failures (403 correction / 422 codes); anything else falls through to ErrorText. */
const SAVE_ERRORS: Record<string, string> = {
  forbidden: 'rates.save.forbidden', duplicate_metal: 'rates.save.duplicate_metal', invalid_override: 'rates.save.invalid_override',
  invalid_rate: 'rates.save.invalid_rate', idempotency_key_reused: 'rates.save.retry', inactive_master: 'rates.save.inactive', not_found: 'rates.save.inactive',
};
export const saveErrorKey = (e: unknown) => (e instanceof ApiError ? (e.status === 403 ? SAVE_ERRORS.forbidden : SAVE_ERRORS[e.code ?? '']) : undefined);

/**
 * Daily rate entry: one base rate per metal (e.g. 24K gold, fine silver); other purities are derived from fineness.
 * The preview is client-side; the server (POST /v1/rates/batch, all-or-nothing, one call per kind) is the source of truth.
 * Publishing again today for the same purity + kind + scope is a correction and needs rates.edit.
 */
export function TodaysRatesForm({ defaultBranchId = '' }: { defaultBranchId?: string }) {
  const t = useT();
  const tk = useTk();
  const qc = useQueryClient();
  const online = useOnline();
  const can = useCan();
  const canPublish = can('rates.publish');
  const canEdit = can('rates.edit');
  const { metals, purities, branches } = useRateRefs();
  const [scope, setScope] = useState<string>(''); // '' = all branches
  const [draft, setDraft] = useState<Draft>({});
  const [done, setDone] = useState(false);
  const saleKey = useAttemptKey();
  const oldKey = useAttemptKey();
  const current = useCurrentRates(scope || defaultBranchId || null).data ?? [];
  const today = istDay(new Date());
  const list = sortMetals(metals);
  const plans: Plan[] = (['sale', 'old_metal'] as const).map((kind) => {
    const bases: Plan['bases'] = []; const overrides: Plan['overrides'] = [];
    for (const m of list) {
      const d = draft[m.id]; const base = basePurity(purities, m.id);
      const v = d ? parseRate2dp(kind === 'sale' ? d.sale : d.old) : null;
      if (!base || !v) continue;
      bases.push({ purity_id: base.id, rate_per_g: v });
      if (kind === 'sale') for (const [pid, raw] of Object.entries(d?.adjust ?? {})) { const r = raw ? parseRate2dp(raw) : null; if (r) overrides.push({ purity_id: pid, rate_per_g: r }); }
    }
    return { kind, bases, overrides };
  }).filter((p) => p.bases.length > 0);
  const bad = Object.values(draft).some((d) => (d.sale && !parseRate2dp(d.sale)) || (d.old && !parseRate2dp(d.old)) || Object.values(d.adjust ?? {}).some((x) => x && !parseRate2dp(x)));
  // A correction = a row already dated today for the same purity + kind in this exact scope (the batch writes every active purity of the metal).
  const scopeId = scope || null;
  const touches = (p: Plan) => p.bases.flatMap((b) => { const mid = purities.find((x) => x.id === b.purity_id)?.metal_id; return purities.filter((x) => x.metal_id === mid && x.is_active).map((x) => x.id); });
  const correction = plans.some((p) => current.some((r) => r.kind === p.kind && r.rate_date === today && (r.branch_id ?? null) === scopeId && touches(p).includes(r.purity_id)));
  const blocked = correction && !canEdit;
  const pub = useMutation({
    mutationFn: async () => {
      for (const p of plans) {
        const k = p.kind === 'sale' ? saleKey : oldKey;
        try {
          await ratesApi.publishBatch({ ...(scope ? { branch_id: scope } : {}), kind: p.kind, bases: p.bases, ...(p.overrides.length ? { overrides: p.overrides } : {}) }, k.take());
          k.reset();
        } catch (e) { k.settle(e); throw e; }
      }
    },
    onSuccess: () => { setDraft({}); setDone(true); void qc.invalidateQueries({ queryKey: ratesKeys.all }); void qc.invalidateQueries({ queryKey: ['/v1/onboarding'] }); },
    onSettled: () => { void qc.invalidateQueries({ queryKey: ratesKeys.all }); },
  });
  const friendly = saveErrorKey(pub.error);
  const branchName = branches.find((b) => b.id === scope)?.name ?? '';
  const edit = (id: string, v: Draft[string]) => { setDone(false); saleKey.reset(); oldKey.reset(); setDraft({ ...draft, [id]: v }); };
  return (
    <Card>
      <CardHeader><CardTitle>{t('rates.entry.title')}</CardTitle></CardHeader>
      <CardContent className="space-y-4 text-sm">
        {!canPublish ? <p className="text-muted-foreground">{t('rates.entry.readOnly')}</p> : null}
        <Field label={t('rates.entry.appliesTo')} hint={scope ? t('rates.entry.branchOnlyHint', { branch: branchName }) : t('rates.entry.allHint')}>
          {(id, d) => (
            <Select id={id} aria-describedby={d} value={scope} disabled={!canPublish} onChange={(e) => { saleKey.reset(); oldKey.reset(); setScope(e.target.value); }}>
              <option value="">{t('rates.entry.allBranches')}</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{t('rates.entry.branchOnly', { branch: b.name })}</option>)}
            </Select>
          )}
        </Field>
        {list.map((m) => (
          <MetalEntry key={m.id} metal={m} purities={purities} current={current} disabled={!canPublish}
            value={draft[m.id] ?? { sale: '', old: '' }} onChange={(v) => edit(m.id, v)} />
        ))}
        {bad ? <p className="text-xs text-destructive">{t('rates.twoDp')}</p> : null}
        <p className="text-xs text-muted-foreground">{t('rates.correctionNote')}</p>
        {correction ? <p role="note" className="rounded-md border border-warning bg-warning/15 px-2 py-1 text-xs" data-testid="correction-note">{t(canEdit ? 'rates.save.correction' : 'rates.save.correctionNeedsEdit')}</p> : null}
        {friendly ? <p role="alert" className="text-xs text-destructive">{tk(friendly)}</p> : <ErrorText error={pub.error} />}
        {done ? <p role="status" className="text-xs text-success">{t('rates.entry.saved')}</p> : null}
        {canPublish ? (
          <Button disabled={!online || bad || blocked || plans.length === 0 || pub.isPending} onClick={() => pub.mutate()}>
            {scope ? t('rates.entry.publishBranch', { branch: branchName }) : t('rates.entry.publishAll')}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

function MetalEntry({ metal, purities, current, value, onChange, disabled }: {
  metal: Metal; purities: Purity[]; current: MetalRate[]; value: Draft[string]; onChange: (v: Draft[string]) => void; disabled: boolean;
}) {
  const t = useT();
  const base = basePurity(purities, metal.id);
  if (!base) return null;
  const sale = value.sale ? parseRate2dp(value.sale) : null;
  const old = value.old ? parseRate2dp(value.old) : null;
  const curBase = current.find((r) => r.purity_id === base.id && r.kind === 'sale');
  const rows = deriveAll(purities, metal.id, sale ?? curBase?.rate_per_g ?? '0');
  const oldRows = old ? deriveAll(purities, metal.id, old) : [];
  const baseLabel = `${metal.name} ${base.code}`;
  return (
    <fieldset className="space-y-2 rounded-md border border-border p-3" data-testid={`entry-${metal.code}`}>
      <legend className={`px-1 font-medium ${metalTone(metal.code)}`}>{metal.name}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label={t('rates.entry.baseRate', { purity: baseLabel })} hint={curBase ? t('rates.entry.nowAt', { rate: formatINR(curBase.rate_per_g) }) : undefined}>
          {(id, d) => <Input id={id} aria-describedby={d} inputMode="decimal" className="font-mono" disabled={disabled} aria-invalid={!!value.sale && !sale}
            placeholder={curBase?.rate_per_g ?? ''} value={value.sale} onChange={(e) => onChange({ ...value, sale: e.target.value })} />}
        </Field>
        <Field label={t('rates.entry.oldRate', { purity: baseLabel })} hint={t('rates.entry.optional')}>
          {(id, d) => <Input id={id} aria-describedby={d} inputMode="decimal" className="font-mono" disabled={disabled} aria-invalid={!!value.old && !old}
            value={value.old} onChange={(e) => onChange({ ...value, old: e.target.value })} />}
        </Field>
      </div>
      {sale || curBase ? (
        <table className="w-full text-sm" aria-label={t('rates.entry.derivedFor', { metal: metal.name })}>
          <thead><tr className="text-left text-xs text-muted-foreground"><th>{t('rates.col.purity')}</th><th className="text-right">{t('rates.col.sale')}</th>{old ? <th className="text-right">{t('rates.col.old')}</th> : null}</tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.purity.id} data-testid={`derived-${r.purity.code}`}>
                <td lang="en">{formatPurity(r.purity.code, r.purity.fineness)}{r.isBase ? '' : ` · ${t('rates.entry.derived')}`}</td>
                <td className={`text-right font-mono tabular-nums ${sale ? '' : 'text-muted-foreground'}`}>{formatINR((sale && value.adjust?.[r.purity.id] && parseRate2dp(value.adjust[r.purity.id] ?? '')) || r.rate)}</td>
                {old ? <td className="text-right font-mono tabular-nums">{formatINR(oldRows[i]?.rate ?? '0')}</td> : null}
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {sale && rows.some((r) => !r.isBase) ? (
        <details className="text-sm" data-testid={`adjust-${metal.code}`}>
          <summary className="cursor-pointer text-xs font-medium">{t('rates.adjust.title')}</summary>
          <p className="my-1 text-xs text-muted-foreground">{t('rates.adjust.help')}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {rows.filter((r) => !r.isBase).map((r) => {
              const raw = value.adjust?.[r.purity.id] ?? '';
              return (
                <Field key={r.purity.id} label={t('rates.adjust.label', { purity: r.purity.code })} hint={t('rates.adjust.derivedIs', { rate: formatINR(r.rate) })}>
                  {(id, d) => <Input id={id} aria-describedby={d} inputMode="decimal" className="font-mono" disabled={disabled} aria-invalid={!!raw && !parseRate2dp(raw)}
                    placeholder={r.rate} value={raw} onChange={(e) => onChange({ ...value, adjust: { ...value.adjust, [r.purity.id]: e.target.value } })} />}
                </Field>
              );
            })}
          </div>
        </details>
      ) : null}
    </fieldset>
  );
}

/** Rates in effect for a branch, each marked "this branch" or "shop-wide". */
export function EffectiveRates({ branchId, branchName }: { branchId?: string | null; branchName?: string }) {
  const t = useT();
  const tk = useTk();
  const { metals, purities } = useRateRefs();
  const rows = useCurrentRates(branchId).data ?? [];
  const today = istDay(new Date());
  return (
    <Card>
      <CardHeader><CardTitle>{branchName ? t('rates.effective.titleBranch', { branch: branchName }) : t('rates.effective.title')}</CardTitle></CardHeader>
      <CardContent>
        {rows.length === 0 ? <p className="text-sm text-muted-foreground">{t('rates.historyEmpty')}</p> : null}
        <ul className="divide-y divide-border text-sm" data-testid="effective-rates">
          {sortMetals(metals).flatMap((m) => purities.filter((p) => p.metal_id === m.id).map((p) => ({ m, p })))
            .flatMap(({ m, p }) => rows.filter((r) => r.purity_id === p.id).map((r) => ({ m, p, r })))
            .map(({ m, p, r }) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2" data-testid={`effective-${p.code}-${r.kind}`}>
                <span className={metalTone(m.code)}>{m.name} <span lang="en">{p.code}</span> · {tk(`rates.kind.${r.kind}`)}</span>
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-mono tabular-nums">{t('rates.perGram', { rate: formatINR(r.rate_per_g) })}</span>
                  <Badge variant={scopeOf(r) === 'branch' ? 'default' : 'outline'}>{t(scopeOf(r) === 'branch' ? 'rates.scope.branch' : 'rates.scope.shop')}</Badge>
                  <Badge variant={r.rate_date === today ? 'success' : 'warning'}>{t(r.rate_date === today ? 'rates.today' : 'rates.stale')}</Badge>
                  <span className="text-xs text-muted-foreground">{t('rates.publishedAt', { at: formatDateTimeIN(r.effective_from) })}</span>
                </span>
              </li>
            ))}
        </ul>
        <p className="mt-2 text-xs text-muted-foreground">{t('rates.scope.rule')}</p>
      </CardContent>
    </Card>
  );
}
