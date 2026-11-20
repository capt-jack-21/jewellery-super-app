/** Shop Sales settings, 0.9.2. The only writer is PATCH /v1/sales/settings (owner, optimistic concurrency, version 0 for defaults). */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Field, Select, Check } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Loading, OfflineBanner, PageHeader, Saved } from '@/components/page';
import { useT, useTk } from '@/i18n';
import { useOnline } from '@/lib/offline/connectivity';
import { useCan, useSession } from '@/lib/session';
import { SALES } from '@/lib/permissions';
import { isPrintLanguage } from '@/features/settings/print-language';
import { ApiError } from '@/lib/api/fetcher';
import { D } from '@/lib/format/decimal';
import type { SalesSettings, SalesSettingsPatch } from '@/lib/api/backend/model';
import { useSalesSettings } from './ui';
import { salesApi, salesKeys } from './api';
import { SalesError, SalesOff } from './ui';

export const SALES_SETTINGS_ROUTE = '/sales/settings' as const;
/** Only map recognised API paths to internal routes; never follow a server-supplied external URL. */
export function settingsRoute(path?: unknown) {
  const routes: Record<string, typeof SALES_SETTINGS_ROUTE> = { '/v1/sales/settings': SALES_SETTINGS_ROUTE, [SALES_SETTINGS_ROUTE]: SALES_SETTINGS_ROUTE };
  return typeof path === 'string' ? routes[path] ?? SALES_SETTINGS_ROUTE : SALES_SETTINGS_ROUTE;
}
type K = keyof SalesSettingsPatch;
type Config = { key: K; kind?: 'money' | 'pct' | 'int' | 'text'; max?: number; options?: readonly string[]; prefix?: string };
export const SALES_SETTING_FIELDS: readonly Config[] = [
  { key: 'making_gst_treatment', options: ['composite', 'separate'], prefix: 'rules.making' },
  { key: 'making_tax_rule_code', kind: 'text', max: 40 }, { key: 'making_service_rate', kind: 'pct' },
  { key: 'old_gold_valuation_basis', options: ['stated_purity', 'fine_24k'], prefix: 'rules.basis' },
  { key: 'old_gold_excess_handling', options: ['refund_on_bill', 'separate_purchase'], prefix: 'rules.surplus' },
  { key: 'return_window_days', kind: 'int', max: 365 },
  { key: 'return_settlement_default', options: ['store_credit', 'cash', 'bank_transfer'], prefix: 'sales.refund' },
  { key: 'credit_note_rounding', options: ['follow_invoice', 'exact'], prefix: 'rules.cnRounding' },
  { key: 'pan_required_above', kind: 'money' }, { key: 'cash_limit_amount', kind: 'money' },
  { key: 'cash_limit_mode', options: ['warn', 'block'], prefix: 'sales.settings.cashMode' },
  { key: 'discount_max_pct', kind: 'pct' }, { key: 'large_discount_pct', kind: 'pct' },
  { key: 'default_paper', options: ['A4', 'A5', 'thermal_80mm'], prefix: 'sales.print.paper' },
  { key: 'zero_gst_print_note', kind: 'text', max: 200 }, { key: 'estimate_validity_days', kind: 'int', max: 30 },
  { key: 'estimate_no_format', kind: 'text', max: 64 }, { key: 'receipt_no_format', kind: 'text', max: 64 },
];
export type SettingsDraft = Record<K, string | boolean>;
export const settingsDraft = (s: SalesSettings): SettingsDraft => Object.fromEntries([
  ...SALES_SETTING_FIELDS.map(({ key }) => [key, String(s[key] ?? '')]), ['old_gold_enabled', s.old_gold_enabled],
]) as SettingsDraft;
/** Only changed, writable fields go into PATCH; null explicitly clears the two nullable making settings. */
export function settingsPatch(s: SalesSettings, d: SettingsDraft): SalesSettingsPatch {
  const patch: Record<string, unknown> = {};
  const prev = settingsDraft(s);
  for (const k of Object.keys(d) as K[]) {
    if (d[k] === prev[k]) continue;
    const conf = SALES_SETTING_FIELDS.find((f) => f.key === k);
    const v = String(d[k]).trim();
    patch[k] = k === 'old_gold_enabled' ? d[k] : conf?.kind === 'int' ? Number(v)
      : (k === 'making_service_rate' || k === 'making_tax_rule_code') && !v ? null
      : conf?.kind === 'money' || k === 'making_service_rate' ? D(v).toFixed(2) : v;
  }
  return patch as SalesSettingsPatch;
}
export function settingsIssues(d: SettingsDraft): string[] {
  const out: string[] = [];
  for (const c of SALES_SETTING_FIELDS) {
    const v = String(d[c.key]).trim();
    if (c.key === 'making_service_rate' && !v) continue; // unset is allowed; the billing gate explains it
    if (c.kind === 'money' || c.kind === 'pct') {
      if (!(c.kind === 'money' ? /^\d{1,12}(\.\d{1,2})?$/.test(v) : /^\d{1,3}(\.\d{1,3})?$/.test(v)) || (c.kind === 'pct' && D(v).gt(100))) out.push(c.key);
      else if (c.key === 'making_service_rate' && (!/^\d{1,3}(\.\d{1,2})?$/.test(v) || D(v).lte(0) || !D(v).mul(100).mod(2).eq(0))) out.push(c.key);
    }
    if (c.kind === 'int' && (!/^\d+$/.test(v) || Number(v) > (c.max ?? 0))) out.push(c.key);
    if (c.max && c.kind === 'text' && v.length > c.max) out.push(c.key);
    if ((c.key === 'estimate_no_format' || c.key === 'receipt_no_format') && (!/\{SEQ(?::\d+)?\}$/.test(v) || (v.match(/\{SEQ(?::\d+)?\}/g)?.length ?? 0) !== 1 || /\{(?!BRANCH\}|FY\}|SEQ(?::\d+)?\})/.test(v))) out.push(c.key);
  }
  if (/^\d+(\.\d{1,2})?$/.test(String(d.large_discount_pct)) && /^\d+(\.\d{1,2})?$/.test(String(d.discount_max_pct)) && D(String(d.large_discount_pct)).gt(D(String(d.discount_max_pct)))) out.push('large_discount_pct');
  if (d.making_gst_treatment === 'separate' && !String(d.making_tax_rule_code).trim()) out.push('making_tax_rule_code');
  return [...new Set(out)];
}

export function SalesSettingsForm({ value, onSaved }: { value: SalesSettings; onSaved?: () => void }) {
  const t = useT(); const tk = useTk(); const online = useOnline(); const qc = useQueryClient();
  const [draft, setDraft] = useState(() => settingsDraft(value));
  const [conflict, setConflict] = useState(false);
  const issues = settingsIssues(draft); const patch = issues.length ? {} : settingsPatch(value, draft);
  const save = useMutation({
    mutationFn: () => salesApi.patchSettings(patch, value.version),
    onSuccess: (s) => {
      // PATCH returns the complete effective values; refresh all branch views from it (not a merge of our draft).
      qc.setQueriesData({ queryKey: ['sales', 'settings'] }, s); qc.setQueryData(salesKeys.settings(), s);
      void qc.invalidateQueries({ queryKey: ['sales', 'readiness'] }); void qc.invalidateQueries({ queryKey: ['sales', 'preview'] });
      onSaved?.();
    },
    onError: (e) => { if (e instanceof ApiError && e.status === 412) setConflict(true); },
  });
  const set = (key: K, v: string | boolean) => { setDraft((d) => ({ ...d, [key]: v })); save.reset(); };
  return <form className="space-y-4" data-testid="sales-settings-form" onSubmit={(e) => { e.preventDefault(); if (!issues.length && !conflict && Object.keys(patch).length) save.mutate(); }}>
    <p className="text-sm text-muted-foreground">{t('sales.settings.source', { n: value.version })}</p>
    <Card><CardContent className="grid gap-4 pt-4 md:grid-cols-2 lg:grid-cols-3">
      <Check label={t('sales.settings.old_gold_enabled')} checked={!!draft.old_gold_enabled} onChange={(on) => set('old_gold_enabled', on)} />
      {SALES_SETTING_FIELDS.map((f) => <Field key={f.key} label={tk(`sales.settings.${f.key}`)} hint={f.key === 'making_service_rate' ? t('sales.settings.rateHint') : f.key.endsWith('_no_format') ? t('sales.settings.formatHint') : undefined}>{(id, d) => f.options ?
        <Select id={id} value={String(draft[f.key])} onChange={(e) => set(f.key, e.target.value)}>{f.options.map((o) => <option key={o} value={o}>{tk(`${f.prefix}.${o}`)}</option>)}</Select>
        : <Input id={id} aria-describedby={d} aria-invalid={issues.includes(f.key) || undefined} inputMode={f.kind === 'money' || f.kind === 'pct' ? 'decimal' : f.kind === 'int' ? 'numeric' : undefined} maxLength={f.kind === 'text' ? f.max : undefined}
          value={String(draft[f.key])} onChange={(e) => set(f.key, e.target.value)} />}</Field>)}
    </CardContent></Card>
    <p className="text-sm text-muted-foreground" data-testid="sales-cash-scope">{t('sales.cash.scope')}</p>
    <p className="text-sm text-muted-foreground">{t('sales.settings.readOnly', { round: value.round_off_to, language: value.print_language, numerals: value.print_numerals })}</p>
    {!isPrintLanguage(value.print_language) ? <p role="alert" data-testid="sales-settings-print-language">{t('print.language.unsupported', { value: value.print_language })}{' '}{t('print.language.readOnly')}</p> : null}
    {issues.length ? <p role="alert" className="text-sm text-destructive" data-testid="settings-issues">{t('sales.settings.invalid')}</p> : null}
    {conflict ? <div role="alert" data-testid="settings-conflict"><p>{t('sales.settings.conflict')}</p><Button type="button" variant="outline" onClick={() => void qc.invalidateQueries({ queryKey: ['sales', 'settings'] })}>{t('sales.settings.reload')}</Button></div> : <SalesError error={save.error} />}
    <div className="flex items-center gap-3"><Button type="submit" data-testid="settings-save" disabled={!online || !!issues.length || conflict || !Object.keys(patch).length || save.isPending}>{t('common.save')}</Button><Saved show={save.isSuccess} /></div>
  </form>;
}
export function SalesSettingsBody({ onSaved }: { onSaved?: () => void }) {
  const t = useT(); const can = useCan(); const session = useSession().data;
  const allowed = can(SALES.settingsEdit) && !!session?.roles.some((r) => r.role === 'owner');
  const q = useSalesSettings();
  if (!allowed) return <p role="note">{t('sales.settings.ownerOnly')}</p>;
  if (q.off) return <SalesOff />;
  if (q.error) return <SalesError error={q.error} />;
  if (!q.data) return <Loading />;
  return <SalesSettingsForm key={q.data.version} value={q.data} onSaved={onSaved} />;
}
export function SalesSettingsPage() {
  const t = useT();
  return <div className="space-y-4"><PageHeader title={t('sales.settings.title')} description={t('sales.settings.description')} /><OfflineBanner /><SalesSettingsBody /></div>;
}
export function SalesSettingsLink({ path }: { path?: unknown }) {
  const t = useT(); return <Link className="underline" to={settingsRoute(path)}>{t('sales.gate.openRules')}</Link>;
}
