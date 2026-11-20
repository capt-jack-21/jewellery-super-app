import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Check, Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ErrorText, Loading, OfflineBanner, PageHeader, Saved, EditGate } from '@/components/page';
import { EDIT_SETTINGS } from '@/lib/permissions';

import { useT, useTk } from '@/i18n';
import { ApiError, ifMatch, ok, ifMatchOptional } from '@/lib/api/fetcher';
import { createCompany, getGetTenantQueryKey, getListCompaniesQueryKey, getTenant, listCompanies, updateCompany } from '@/lib/api/backend/tenant/tenant';
import { getListSettingsQueryKey, listSettings, putSetting, resetSetting } from '@/lib/api/backend/settings/settings';
import type { Address, CompanyInput, Setting } from '@/lib/api/backend/model';
import { useOnline } from '@/lib/offline/connectivity';
import { BankAccountsCard } from './bank-accounts';

export const GSTIN_RE = /^[0-9]{2}[A-Z0-9]{13}$/;
export const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

export const useTenant = () => useQuery({ queryKey: getGetTenantQueryKey(), queryFn: () => ok(getTenant()) });
export const useCompanies = () => useQuery({ queryKey: getListCompaniesQueryKey(), queryFn: () => ok(listCompanies()) });

const blank: CompanyInput = { legal_name: '', state_code: '', address: {} };

/** Shop profile = the tenant's (first) GST company: legal/trade name, address, GSTIN, PAN, state. Wizard steps 1–2. */
export function ShopProfileForm({ section = 'all', onSaved }: { section?: 'profile' | 'gst' | 'all'; onSaved?: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const online = useOnline();
  const tenant = useTenant().data;
  const companies = useCompanies();
  const existing = companies.data?.[0];
  const [f, setF] = useState<CompanyInput | null>(null);
  useEffect(() => {
    if (!companies.data) return;
    const c = companies.data[0];
    setF(c ? { legal_name: c.legal_name, trade_name: c.trade_name ?? '', gstin: c.gstin ?? undefined, pan: c.pan ?? undefined, state_code: c.state_code, address: (c.address ?? {}) as Address }
      : { ...blank, legal_name: tenant?.display_name ?? '' });
  }, [companies.data, tenant?.display_name]);
  const save = useMutation({
    mutationFn: (p: CompanyInput) => {
      const body: CompanyInput = { ...p, gstin: p.gstin || undefined, pan: p.pan || undefined, trade_name: p.trade_name || undefined };
      return existing ? ok(updateCompany(existing.id, body, ifMatch(existing.version))) : ok(createCompany(body));
    },
    onError: (e) => { if (e instanceof ApiError && e.isStale) void qc.invalidateQueries({ queryKey: getListCompaniesQueryKey() }); },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: getListCompaniesQueryKey() }); void qc.invalidateQueries({ queryKey: ['/v1/onboarding'] }); onSaved?.(); },
  });
  if (!f) return <Loading />;
  const set = <K extends keyof CompanyInput>(k: K, v: CompanyInput[K]) => setF({ ...f, [k]: v });
  const addr = (k: keyof Address, v: string) => setF({ ...f, address: { ...f.address, [k]: v } });
  const pin = f.address?.pincode ?? '';
  const gstinErr = f.gstin && !GSTIN_RE.test(f.gstin) ? t('validation.gstin') : f.gstin && f.gstin.slice(0, 2) !== f.state_code ? t('validation.gstinState') : null;
  const panErr = f.pan && !PAN_RE.test(f.pan) ? t('validation.pan') : null;
  const invalid = !f.legal_name.trim() || !/^[0-9]{2}$/.test(f.state_code) || !!gstinErr || !!panErr || (pin ? !/^[0-9]{6}$/.test(pin) : false);
  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(f); }}>
      {section !== 'gst' ? (
        <Card>
          <CardHeader><CardTitle>{t('shop.profile')}</CardTitle></CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2">
            <Field label={t('shop.legalName')}>{(id) => <Input id={id} value={f.legal_name} onChange={(e) => set('legal_name', e.target.value)} required />}</Field>
            <Field label={t('shop.tradeName')}>{(id) => <Input id={id} value={f.trade_name ?? ''} onChange={(e) => set('trade_name', e.target.value)} />}</Field>
            <Field label={t('shop.address1')}>{(id) => <Input id={id} value={f.address?.line1 ?? ''} onChange={(e) => addr('line1', e.target.value)} />}</Field>
            <Field label={t('shop.address2')}>{(id) => <Input id={id} value={f.address?.line2 ?? ''} onChange={(e) => addr('line2', e.target.value)} />}</Field>
            <Field label={t('shop.city')}>{(id) => <Input id={id} value={f.address?.city ?? ''} onChange={(e) => addr('city', e.target.value)} />}</Field>
            <Field label={t('shop.pin')} error={pin && !/^[0-9]{6}$/.test(pin) ? t('validation.pin') : null}>
              {(id, d) => <Input id={id} aria-describedby={d} inputMode="numeric" maxLength={6} value={pin} onChange={(e) => addr('pincode', e.target.value)} />}</Field>
          </CardContent>
        </Card>
      ) : null}
      {section !== 'profile' ? (
        <Card>
          <CardHeader><CardTitle>{t('shop.gst')}</CardTitle></CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2">
            <Field label={t('shop.stateCode')} hint={t('shop.stateCodeHint')}>{(id, d) => <Input id={id} aria-describedby={d} inputMode="numeric" maxLength={2} value={f.state_code} onChange={(e) => set('state_code', e.target.value)} />}</Field>
            <Field label={t('shop.gstin')} error={gstinErr}>{(id, d) => <Input id={id} aria-describedby={d} className="font-mono uppercase" maxLength={15} value={f.gstin ?? ''} onChange={(e) => set('gstin', e.target.value.toUpperCase())} />}</Field>
            <Field label={t('shop.pan')} error={panErr}>{(id, d) => <Input id={id} aria-describedby={d} className="font-mono uppercase" maxLength={10} value={f.pan ?? ''} onChange={(e) => set('pan', e.target.value.toUpperCase())} />}</Field>
          </CardContent>
        </Card>
      ) : null}
      <ErrorText error={save.error} />
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={!online || invalid || save.isPending}>{t('common.save')}</Button>
        <Saved show={save.isSuccess} />
      </div>
    </form>
  );
}

/** Generic settings (GET /v1/settings): platform default → tenant override, typed by value_type. Covers idle timeout (P11), PAN limit (P12) etc. */
export function SettingsCard({ prefix }: { prefix?: string }) {
  const t = useT();
  const tk = useTk();
  const qc = useQueryClient();
  const online = useOnline();
  const list = useQuery({ queryKey: getListSettingsQueryKey(), queryFn: () => ok(listSettings()) });
  const [draft, setDraft] = useState<Record<string, string | boolean>>({});
  const inval = () => { setDraft({}); void qc.invalidateQueries({ queryKey: getListSettingsQueryKey() }); void qc.invalidateQueries({ queryKey: ['/v1/auth/session'] }); };
  // If-Match only once a tenant override row exists (Setting.version non-null); first save creates it.
  const put = useMutation({ mutationFn: ({ s, value }: { s: Setting; value: string | number | boolean }) => ok(putSetting(s.key, { value }, undefined, ifMatchOptional(s.version))), onSuccess: inval, onError: inval });
  const reset = useMutation({ mutationFn: (s: Setting) => ok(resetSetting(s.key, undefined, ifMatchOptional(s.version))), onSuccess: inval });
  const rows = (list.data ?? []).filter((s) => s.tenant_overridable && (!prefix || s.key.startsWith(prefix)));
  const coerce = (s: Setting, v: string | boolean) => (s.value_type === 'boolean' ? !!v : s.value_type === 'integer' ? Number(v) : String(v));
  return (
    <Card>
      <CardHeader><CardTitle>{t('shop.security')}</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {list.isLoading ? <Loading /> : null}
        {rows.map((s) => {
          const v = draft[s.key] ?? (s.value_type === 'boolean' ? !!s.value : String(s.value));
          return (
            <div key={s.key} className="grid items-end gap-2 md:grid-cols-[1fr_12rem_auto]" data-testid={`setting-${s.key}`}>
              {s.value_type === 'boolean'
                ? <Check label={s.description} checked={!!v} onChange={(c) => setDraft({ ...draft, [s.key]: c })} />
                : <Field label={s.description} hint={s.key}>{(id, d) => <Input id={id} aria-describedby={d} inputMode={s.value_type === 'text' ? 'text' : 'decimal'} className="font-mono" value={String(v)} onChange={(e) => setDraft({ ...draft, [s.key]: e.target.value })} />}</Field>}
              <Badge variant={s.source === 'platform' ? 'outline' : 'success'}>{tk(`settings.source.${s.source}`)}</Badge>
              <div className="flex gap-2">
                <Button size="sm" disabled={!online || put.isPending || draft[s.key] === undefined} onClick={() => put.mutate({ s, value: coerce(s, v) })}>{t('common.save')}</Button>
                {s.source !== 'platform' ? <Button size="sm" variant="ghost" disabled={!online || reset.isPending} onClick={() => reset.mutate(s)}>{t('settings.reset')}</Button> : null}
              </div>
            </div>
          );
        })}
        <ErrorText error={put.error ?? reset.error} />
      </CardContent>
    </Card>
  );
}

export function ShopSettingsPage() {
  const t = useT();
  return (
    <div className="space-y-4">
      <PageHeader title={t('shop.title')} description={t('shop.description')} />
      <OfflineBanner />
      <EditGate perm={EDIT_SETTINGS}>
        <ShopProfileForm />
        <BankAccountsCard />
        <SettingsCard />
      </EditGate>
    </div>
  );
}
