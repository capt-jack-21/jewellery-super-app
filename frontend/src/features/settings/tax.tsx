import { replaceGstConfigWithKey, replaceTaxRuleWithKey } from '@/lib/api/idempotent-commands';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable } from '@/components/ui/data-table';
import { Check, Field, Select } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ErrorText, OfflineBanner, PageHeader, EditGate } from '@/components/page';
import { EDIT_SETTINGS } from '@/lib/permissions';

import { useT, useTk } from '@/i18n';
import { ApiError, ok } from '@/lib/api/fetcher';
import { useAttemptKey } from '@/lib/api/attempt-key';
import { FEATURE_RATE_END_DATE } from '@/features/flags';
import {
  closeTaxRule, createGstConfig, createTaxRule, getListGstConfigQueryKey, getListTaxRulesQueryKey, listGstConfig, listTaxRules,
} from '@/lib/api/backend/settings/settings';
import type { GstConfigInput, TaxRule, TaxRuleInput, TaxRuleReplaceInput } from '@/lib/api/backend/model';
import { D, formatDateIN, formatPercent } from '@/lib/format';
import { useOnline } from '@/lib/offline/connectivity';
import { Link } from '@tanstack/react-router';
import { useSalesSettings } from '@/features/sales/ui';

/** Today in IST as YYYY-MM-DD (server validates effective dates against IST). */
export const istToday = (now = new Date()) => now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const COMPONENTS = ['metal', 'making', 'stone', 'hallmark', 'service', 'old_metal_purchase', 'other'] as const;
export const ROUND_OFF_UNITS: ReadonlyArray<GstConfigInput['round_off_unit']> = ['0.01', '0.10', '0.50', '1.00'];

type Period = { effective_from: string; effective_to?: string | null };
/** effective_to is an exclusive end. */
export function periodStatus(p: Period, today = istToday()): 'current' | 'upcoming' | 'closed' {
  if (p.effective_from > today) return 'upcoming';
  if (p.effective_to && p.effective_to <= today) return 'closed';
  return 'current';
}
/** "Close and start new": the open period is closed at the new start date, which must be after its own start and not in the past. */
export function newPeriodError(base: Period | undefined, newFrom: string, today = istToday()): 'past' | 'notAfterCurrent' | 'gap' | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(newFrom) || newFrom < today) return 'past';
  if (base && newFrom <= base.effective_from) return 'notAfterCurrent';
  if (base?.effective_to && newFrom > base.effective_to) return 'gap';
  return null;
}
/** Optional end of the new period (exclusive): must be after its start (server: 422). */
/** Drops effective_to unless the end-date feature is on. */
export const withEndDate = <T extends { effective_to?: string | null }>(b: T, enabled = FEATURE_RATE_END_DATE): T => {
  if (enabled) return b;
  const { effective_to: _t, ...rest } = b; return rest as T;
};
export const endDateError = (from: string, to?: string | null): 'endNotAfterStart' | null => (to && to <= from ? 'endNotAfterStart' : null);
const periodVariant = { current: 'success', upcoming: 'warning', closed: 'outline' } as const;

export { useAttemptKey };
/** 409 / 422 on replace mean the list is stale or the attempt can't be replayed: refetch. */
export const isReplaceConflict = (e: unknown) => e instanceof ApiError && (e.status === 409 || e.code === 'idempotency_key_reused');

function PeriodBadge({ p }: { p: Period }) {
  const tk = useTk();
  const st = periodStatus(p);
  return <Badge variant={periodVariant[st]}>{tk(`tax.period.${st}`)}</Badge>;
}
const periodText = (p: Period, open: string) => `${formatDateIN(p.effective_from)} → ${p.effective_to ? formatDateIN(p.effective_to) : open}`;

/** P2 step 2 / settings → tax: GST config periods (history) + "close and start new". Making-charge GST lives in the sales policy. */
export function GstConfigCard() {
  const t = useT();
  const tk = useTk();
  const qc = useQueryClient();
  const online = useOnline();
  const rows = useQuery({ queryKey: getListGstConfigQueryKey(), queryFn: () => ok(listGstConfig()) });
  const policy = useSalesSettings();
  const list = rows.data ?? [];
  const current = list.find((r) => periodStatus(r) === 'current');
  // The row a new period replaces: the latest not-yet-ended one (open-ended, or ending in the future).
  const base = [...list].filter((r) => periodStatus(r) !== 'closed').sort((x, y) => y.effective_from.localeCompare(x.effective_from))[0];
  const [f, setF] = useState<GstConfigInput | null>(null);
  const draft: GstConfigInput = f ?? {
    registration_type: current?.registration_type ?? 'regular', tax_inclusive: current?.tax_inclusive ?? false, rounding_level: current?.rounding_level ?? 'invoice',
    round_off_unit: current?.round_off_unit ?? '1.00', b2c_qr: current?.b2c_qr ?? false, einvoice_enabled: current?.einvoice_enabled ?? false,
    ...(current?.company_id ? { company_id: current.company_id } : {}), ...(current?.einvoice_from ? { einvoice_from: current.einvoice_from } : {}), effective_from: istToday(),
  };
  const attempt = useAttemptKey();
  const set = <K extends keyof GstConfigInput>(k: K, v: GstConfigInput[K]) => { attempt.reset(); setF({ ...draft, [k]: v }); };
  const dateErr = newPeriodError(base, draft.effective_from);
  const endErr = FEATURE_RATE_END_DATE ? endDateError(draft.effective_from, draft.effective_to) : null;
  const inval = () => { void qc.invalidateQueries({ queryKey: getListGstConfigQueryKey() }); void qc.invalidateQueries({ queryKey: ['/v1/onboarding'] }); };
  const add = useMutation({
    mutationFn: async () => {
      if (!base) return ok(createGstConfig(withEndDate(draft)));
      const { company_id: _c, ...body } = withEndDate(draft); // company is inherited from the replaced row
      return replaceGstConfigWithKey(base.id, body, attempt.take());
    },
    onSuccess: () => { attempt.reset(); setF(null); inval(); },
    onError: (e) => { attempt.settle(e); if (isReplaceConflict(e)) inval(); },
  });
  return (
    <Card>
      <CardHeader><CardTitle>{t('tax.gstConfig')}</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {current ? <p className="text-sm text-muted-foreground">{t('tax.currentSince', { date: formatDateIN(current.effective_from) })}</p> : <p className="text-sm text-warning">{t('tax.noConfig')}</p>}
        {list.length ? (
          <ol aria-label={t('tax.periodHistory')} className="divide-y divide-border rounded-md border border-border text-sm" data-testid="gst-history">
            {list.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2 p-2">
                <PeriodBadge p={r} />
                <span className="tabular-nums">{periodText(r, t('tax.open'))}</span>
                <span className="text-muted-foreground">{tk(`tax.reg.${r.registration_type}`)}{' · '}{t('tax.roundOffShort', { unit: r.round_off_unit })}{r.tax_inclusive ? ` · ${t('tax.inclusive')}` : ''}{r.b2c_qr ? ` · ${t('tax.b2cQr')}` : ''}</span>
              </li>
            ))}
          </ol>
        ) : null}
        <h3 className="pt-2 font-medium">{t(base ? 'tax.closeAndStart' : 'tax.addPeriod')}</h3>
        <div className="grid gap-3 md:grid-cols-3">
          <Field label={t('tax.registration')}>{(id) => (
            <Select id={id} value={draft.registration_type} onChange={(e) => set('registration_type', e.target.value as GstConfigInput['registration_type'])}>
              {(['regular', 'composition', 'unregistered'] as const).map((v) => <option key={v} value={v}>{tk(`tax.reg.${v}`)}</option>)}
            </Select>)}</Field>
          <Field label={t('tax.rounding')}>{(id) => (
            <Select id={id} value={draft.rounding_level} onChange={(e) => set('rounding_level', e.target.value as GstConfigInput['rounding_level'])}>
              <option value="invoice">{t('tax.rounding.invoice')}</option><option value="line">{t('tax.rounding.line')}</option>
            </Select>)}</Field>
          <Field label={t('tax.roundOff')} hint={t('tax.roundOffHint')}>{(id, d) => (
            <Select id={id} aria-describedby={d} value={draft.round_off_unit} onChange={(e) => set('round_off_unit', e.target.value as GstConfigInput['round_off_unit'])}>
              {ROUND_OFF_UNITS.map((v) => <option key={v} value={v}>{`₹${v}`}</option>)}
            </Select>)}</Field>
          <Field label={t('tax.effectiveFrom')} error={dateErr ? tk(`tax.dateErr.${dateErr}`) : null}>{(id, d) => <Input id={id} aria-describedby={d} type="date" min={istToday()} value={draft.effective_from} onChange={(e) => set('effective_from', e.target.value)} />}</Field>
          {FEATURE_RATE_END_DATE ? (<Field label={t('tax.effectiveTo')} hint={t('tax.effectiveToHint')} error={endErr ? tk(`tax.dateErr.${endErr}`) : null}>{(id, d) => <Input id={id} aria-describedby={d} type="date" min={draft.effective_from} value={draft.effective_to ?? ''} onChange={(e) => set('effective_to', e.target.value || undefined)} />}</Field>) : null}
        </div>
        <div className="flex flex-wrap gap-4">
          <Check label={t('tax.inclusive')} checked={draft.tax_inclusive} onChange={(v) => set('tax_inclusive', v)} />
          <Check label={t('tax.b2cQr')} checked={!!draft.b2c_qr} onChange={(v) => set('b2c_qr', v)} />
          <Check label={t('tax.einvoice')} checked={!!draft.einvoice_enabled} onChange={(v) => set('einvoice_enabled', v)} />
        </div>
        <p className="text-xs text-muted-foreground" data-testid="making-from-policy">
          {t('tax.makingFromPolicy', { treatment: policy.data ? tk(`tax.making.${policy.data.making_gst_treatment}`) : '—' })}{' '}
          <Link to="/sales/settings" data-testid="making-gst-link" className="text-primary underline">{t('tax.makingLink')} → {t('rules.making')}</Link>
        </p>
        <p className="text-xs text-muted-foreground">{t(base ? 'tax.closeAndStartNote' : 'tax.periodNote', { date: formatDateIN(draft.effective_from) })}</p>
        <ErrorText error={add.error} />
        <Button disabled={!online || !!dateErr || !!endErr || add.isPending} onClick={() => add.mutate()}>{t(base ? 'tax.closeAndStart' : 'tax.addPeriod')}</Button>
      </CardContent>
    </Card>
  );
}

const emptyRule = (): TaxRuleInput => ({ code: '', component: 'metal', code_type: 'HSN', hsn_sac: '', rate: '3', cgst_rate: '1.5', sgst_rate: '1.5', igst_rate: '3', effective_from: istToday() });
const ruleToInput = (r: TaxRule): TaxRuleInput => ({
  code: r.code, ...(r.description ? { description: r.description } : {}), component: r.component, ...(r.metal_code ? { metal_code: r.metal_code as TaxRuleInput['metal_code'] } : {}), code_type: r.code_type, hsn_sac: r.hsn_sac,
  rate: r.rate, cgst_rate: r.cgst_rate, sgst_rate: r.sgst_rate, igst_rate: r.igst_rate, cess_rate: r.cess_rate, composite_supply: r.composite_supply,
  ...(r.principal_component ? { principal_component: r.principal_component } : {}), reverse_charge: r.reverse_charge, effective_from: istToday(),
});
/**
 * Platform rules are read-only (403 platform_rule) but may be copied: reusing a platform code is not an overlap.
 * Tenant open-ended rules (in use or not) can be closed or replaced. A set end date is never moved here; a not-in-use rule
 * whose end is still in the future can be replaced (successor starts on or before that end); an in-use one can't (422 rule_in_use).
 */
export const ruleActions = (r: TaxRule, today = istToday()) => {
  const tenant = r.scope === 'tenant';
  const ended = periodStatus(r, today) === 'closed';
  return { canClose: tenant && !r.effective_to, canReplace: tenant && !ended && (!r.effective_to || !r.in_use), canOverride: !tenant };
};
const toReplaceInput = ({ component: _c, metal_code: _m, ...rest }: TaxRuleInput): TaxRuleReplaceInput => rest;

/** GST rates (P12, wizard step 5): platform defaults + tenant rules, effective-dated, never edited — a change is close + new. */
export function TaxRulesCard() {
  const t = useT();
  const tk = useTk();
  const qc = useQueryClient();
  const online = useOnline();
  const rules = useQuery({ queryKey: getListTaxRulesQueryKey(), queryFn: () => ok(listTaxRules()) });
  const [f, setFRaw] = useState<TaxRuleInput>(emptyRule);
  const [replaces, setReplaces] = useState<TaxRule | null>(null);
  const inval = () => { void qc.invalidateQueries({ queryKey: getListTaxRulesQueryKey() }); void qc.invalidateQueries({ queryKey: ['/v1/onboarding'] }); };
  const attempt = useAttemptKey();
  const setF = (v: TaxRuleInput) => { attempt.reset(); setFRaw(v); };
  const add = useMutation({
    mutationFn: async () => (replaces
      ? replaceTaxRuleWithKey(replaces.id, toReplaceInput(withEndDate(f)), attempt.take())
      : ok(createTaxRule(withEndDate(f)))),
    onSuccess: () => { attempt.reset(); setF(emptyRule()); setReplaces(null); inval(); },
    onError: (e) => { attempt.settle(e); if (isReplaceConflict(e)) inval(); },
  });
  const close = useMutation({ mutationFn: (id: string) => ok(closeTaxRule(id, { effective_to: istToday() })), onSettled: inval });
  const setRate = (rate: string) => {
    const r = /^[0-9]+(\.[0-9]{1,3})?$/.test(rate) ? D(rate) : null;
    setF({ ...f, rate, igst_rate: rate, cgst_rate: r ? r.div(2).toString() : '', sgst_rate: r ? r.div(2).toString() : '' });
  };
  const splitOk = /^[0-9]/.test(f.rate) && D(f.cgst_rate || '0').plus(D(f.sgst_rate || '0')).eq(D(f.rate || '0'));
  const principalOk = !f.composite_supply || !!f.principal_component;
  const dateErr = newPeriodError(replaces ?? undefined, f.effective_from);
  const endErr = FEATURE_RATE_END_DATE ? endDateError(f.effective_from, f.effective_to) : null;
  const valid = f.code.trim() && /^[0-9]{4,8}$/.test(f.hsn_sac) && splitOk && principalOk && !dateErr && !endErr;
  const startFrom = (r: TaxRule, replace: boolean) => { setF(ruleToInput(r)); setReplaces(replace ? r : null); };
  const sorted = [...(rules.data ?? [])].sort((a, b) => a.code.localeCompare(b.code) || b.effective_from.localeCompare(a.effective_from));
  const columns: Array<ColumnDef<TaxRule>> = [
    { header: t('tax.code'), cell: (c) => <div><p className="font-mono">{c.row.original.code}</p><p className="text-xs text-muted-foreground">{c.row.original.description}</p></div> },
    { header: t('tax.component'), cell: (c) => tk(`tax.component.${c.row.original.component}`) },
    { header: t('tax.hsn'), cell: (c) => <span className="font-mono">{c.row.original.code_type}{' '}{c.row.original.hsn_sac}</span> },
    { header: t('tax.rate'), cell: (c) => <span className="tabular-nums">{formatPercent(c.row.original.rate, 1)}{' ('}{formatPercent(c.row.original.cgst_rate, 1)}{' + '}{formatPercent(c.row.original.sgst_rate, 1)}{')'}</span> },
    { header: t('tax.effective'), cell: (c) => <span className="flex flex-wrap items-center gap-1"><PeriodBadge p={c.row.original} /><span className="tabular-nums">{periodText(c.row.original, t('tax.open'))}</span></span> },
    { header: t('tax.scope'), cell: (c) => (
      <span className="flex flex-wrap gap-1">
        <Badge variant={c.row.original.scope === 'platform' ? 'outline' : 'default'}>{tk(`tax.scope.${c.row.original.scope}`)}</Badge>
        {c.row.original.in_use ? <Badge variant="warning" data-testid="in-use">{t('tax.inUse')}</Badge> : null}
      </span>) },
    { id: 'a', header: '', cell: (c) => {
      const r = c.row.original; const a = ruleActions(r);
      return (
        <span className="flex flex-wrap gap-1">
          {a.canReplace ? <Button size="sm" variant="outline" disabled={!online} onClick={() => startFrom(r, true)}>{t('tax.changeRate')}</Button> : null}
          {r.scope === 'tenant' && !r.effective_to ? (
            <Button size="sm" variant="ghost" disabled={!online || !a.canClose || close.isPending} onClick={() => close.mutate(r.id)}>{t('tax.close')}</Button>
          ) : null}
          {a.canOverride ? <Button size="sm" variant="ghost" disabled={!online} onClick={() => startFrom(r, false)}>{t('tax.override')}</Button> : null}
        </span>);
    } },
  ];
  return (
    <Card>
      <CardHeader><CardTitle>{t('tax.rules')}</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <DataTable columns={columns} data={sorted} caption={t('tax.rules')} />
        <p className="text-xs text-muted-foreground">{t('tax.platformReadOnly')}</p>
        <ErrorText error={close.error} />
        <h3 className="pt-2 font-medium">{replaces ? t('tax.changeRateFor', { code: replaces.code }) : t('tax.addRule')}</h3>
        {replaces ? <p className="text-xs text-muted-foreground">{t('tax.closeAndStartNote', { date: formatDateIN(f.effective_from) })}</p> : null}
        <div className="grid gap-3 md:grid-cols-4">
          <Field label={t('tax.code')}>{(id) => <Input id={id} className="font-mono uppercase" readOnly={!!replaces} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} />}</Field>
          <Field label={t('tax.component')}>{(id) => (
            <Select id={id} disabled={!!replaces} value={f.component} onChange={(e) => setF({ ...f, component: e.target.value as TaxRuleInput['component'] })}>
              {COMPONENTS.map((c) => <option key={c} value={c}>{tk(`tax.component.${c}`)}</option>)}
            </Select>)}</Field>
          <Field label={t('tax.hsn')} error={f.hsn_sac && !/^[0-9]{4,8}$/.test(f.hsn_sac) ? t('validation.hsn') : null}>{(id, d) => (
            <div className="flex gap-2">
              <Select aria-label={t('tax.codeType')} className="w-24" value={f.code_type} onChange={(e) => setF({ ...f, code_type: e.target.value as 'HSN' | 'SAC' })}><option>{'HSN'}</option><option>{'SAC'}</option></Select>
              <Input id={id} aria-describedby={d} inputMode="numeric" className="font-mono" value={f.hsn_sac} onChange={(e) => setF({ ...f, hsn_sac: e.target.value })} />
            </div>)}</Field>
          <Field label={t('tax.effectiveFrom')} error={dateErr ? tk(`tax.dateErr.${dateErr}`) : null}>{(id, d) => <Input id={id} aria-describedby={d} type="date" min={istToday()} value={f.effective_from} onChange={(e) => setF({ ...f, effective_from: e.target.value })} />}</Field>
          {FEATURE_RATE_END_DATE ? (<Field label={t('tax.effectiveTo')} hint={t('tax.effectiveToHint')} error={endErr ? tk(`tax.dateErr.${endErr}`) : null}>{(id, d) => <Input id={id} aria-describedby={d} type="date" min={f.effective_from} value={f.effective_to ?? ''} onChange={(e) => { const { effective_to: _t, ...rest } = f; setF(e.target.value ? { ...rest, effective_to: e.target.value } : rest); }} />}</Field>) : null}
          <Field label={t('tax.rate')} hint={t('tax.rateHint')}>{(id, d) => <Input id={id} aria-describedby={d} inputMode="decimal" value={f.rate} onChange={(e) => setRate(e.target.value)} />}</Field>
          <Field label={t('tax.cgst')} error={splitOk ? null : t('validation.taxSplit')}>{(id, d) => <Input id={id} aria-describedby={d} inputMode="decimal" value={f.cgst_rate} onChange={(e) => setF({ ...f, cgst_rate: e.target.value })} />}</Field>
          <Field label={t('tax.sgst')}>{(id) => <Input id={id} inputMode="decimal" value={f.sgst_rate} onChange={(e) => setF({ ...f, sgst_rate: e.target.value })} />}</Field>
          <Field label={t('tax.igst')}>{(id) => <Input id={id} inputMode="decimal" value={f.igst_rate} readOnly />}</Field>
          <div className="flex items-end"><Check label={t('tax.composite')} checked={!!f.composite_supply} onChange={(v) => setF({ ...f, composite_supply: v, ...(v ? {} : { principal_component: undefined }) })} /></div>
          {f.composite_supply ? (
            <Field label={t('tax.principal')} error={principalOk ? null : t('tax.principalRequired')}>{(id, d) => (
              <Select id={id} aria-describedby={d} value={f.principal_component ?? ''} onChange={(e) => setF({ ...f, principal_component: (e.target.value || undefined) as TaxRuleInput['principal_component'] })}>
                <option value="">{t('common.choose')}</option>
                {(['metal', 'service'] as const).map((v) => <option key={v} value={v}>{tk(`tax.component.${v}`)}</option>)}
              </Select>)}</Field>
          ) : null}
        </div>
        <ErrorText error={add.error} />
        <div className="flex flex-wrap gap-2">
          <Button disabled={!online || !valid || add.isPending} onClick={() => add.mutate()}>{replaces ? t('tax.closeAndStart') : t('tax.addRule')}</Button>
          {replaces || f.code ? <Button variant="ghost" onClick={() => { setF(emptyRule()); setReplaces(null); }}>{t('common.cancel')}</Button> : null}
        </div>
      </CardContent>
    </Card>
  );
}

export function TaxSettingsPage() {
  const t = useT();
  return (
    <div className="space-y-4">
      <PageHeader title={t('tax.title')} description={t('tax.description')} />
      <OfflineBanner />
      <EditGate perm={EDIT_SETTINGS}>
        <GstConfigCard />
        <TaxRulesCard />
      </EditGate>
    </div>
  );
}
