import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Select } from '@/components/ui/field';
import { ErrorText, Loading, OfflineBanner, PageHeader } from '@/components/page';
import { fromApiLang, localeLabels, useLocale, useT } from '@/i18n';
import { isUnknownLanguage, languageLabel, useLanguages } from '@/i18n/languages';
import { ApiError, ifMatch, ok } from '@/lib/api/fetcher';
import { getGetLanguageSettingsQueryKey, getLanguageSettings } from '@/lib/api/backend/settings/settings';
import { updateMe } from '@/lib/api/backend/users/users';
import { getGetTenantQueryKey, updateTenant } from '@/lib/api/backend/tenant/tenant';
import type { LanguageCode } from '@/lib/api/backend/model';
import { amountWithWords, formatDateIN, type Numerals } from '@/lib/format';
import { RELEASE_PRINT_LOCALES, isPrintLanguage } from './print-language';
import { numeralOptions, printLangs, wordsNeedReview, type PrintLocale } from '@/lib/print/locales';
import { useOnline } from '@/lib/offline/connectivity';
import { useCan, useSession } from '@/lib/session';
import { useTenant } from './shop';

const useLanguageSettings = () => useQuery({ queryKey: getGetLanguageSettingsQueryKey(), queryFn: () => ok(getLanguageSettings()) });

/**
 * Shop default language: PATCH /v1/tenant {default_language} with If-Match = tenant version (GET /v1/tenant ETag).
 * Editable with platform.settings.edit (owners by default); others see it read-only; a 403 is still handled.
 * Users with their own language keep it. Also a print-language sample; per-print language is set on each template.
 */
export function ShopLanguageForm() {
  const t = useT();
  const qc = useQueryClient();
  const online = useOnline();
  const canEdit = useCan()('platform.settings.edit');
  const q = useLanguageSettings();
  const langs = useLanguages();
  const tenant = useTenant().data;
  const [pl, setPl] = useState<PrintLocale>('ta-IN');
  const [n, setN] = useState<Numerals>('latn');
  const save = useMutation({
    mutationFn: (code: LanguageCode) => ok(updateTenant({ default_language: code }, ifMatch(tenant?.version))),
    onSuccess: () => qc.invalidateQueries(),
    onError: (e) => {
      if (e instanceof ApiError && (e.isStale || e.isForbidden)) void qc.invalidateQueries({ queryKey: getGetTenantQueryKey() });
      if (isUnknownLanguage(e)) void langs.refetch();
    },
  });
  if (!q.data) return <Loading />;
  const last = printLangs(pl).at(-1) ?? 'en';
  const shopCode = tenant?.default_language ?? q.data.shop_default;
  const shopLang = langs.data?.find((s) => s.code === shopCode);
  const shopName = shopLang ? languageLabel(shopLang) : localeLabels[fromApiLang(shopCode) ?? 'en-IN'];
  return (
    <div className="space-y-3">
      {canEdit ? (
        <Field label={t('lang.shopDefault')} hint={t('lang.shopDefaultHint')}>{(id, d) => (
          <Select id={id} aria-describedby={d} className="max-w-sm" value={shopCode} disabled={!online || !tenant || save.isPending}
            onChange={(e) => save.mutate(e.target.value as LanguageCode)}>
            {(langs.data ?? []).map((s) => <option key={s.code} value={s.code}>{languageLabel(s)}</option>)}
          </Select>)}</Field>
      ) : (
        <p className="text-sm"><span className="text-muted-foreground">{t('lang.shopDefault')}{': '}</span><strong>{shopName}</strong>
          <span className="ml-2 text-xs text-muted-foreground">{t('lang.needsSettingsPermission')}</span></p>
      )}
      {isUnknownLanguage(save.error) ? <p role="alert" className="text-sm text-destructive">{t('lang.unknownLanguage')}</p> : <ErrorText error={save.error} />}
      <div className="grid gap-3 md:grid-cols-2">
        <Field label={t('lang.printLanguage')}>{(id) => (
          <Select id={id} value={pl} onChange={(e) => { const v = e.target.value as PrintLocale; setPl(v); if (!numeralOptions(v).includes(n as never)) setN('latn'); }}>
            {RELEASE_PRINT_LOCALES.map((l) => <option key={l} value={l}>{t(`print.locale.${l}` as never)}</option>)}
          </Select>)}</Field>
        <Field label={t('lang.printNumerals')} hint={t('lang.printNumeralsHint')}>{(id, d) => (
          <Select id={id} aria-describedby={d} value={n} onChange={(e) => setN(e.target.value as Numerals)}>
            {numeralOptions(pl).map((x) => <option key={x} value={x}>{t(`numerals.${x}` as never)}</option>)}
          </Select>)}</Field>
      </div>
      <p className="rounded-md bg-muted p-3 text-sm" data-testid="numeral-sample">
        <span className="text-muted-foreground">{t('lang.sample')}{': '}</span>
        {formatDateIN(new Date(), n)}{' · '}{amountWithWords('123456.50', last, n)}
        {wordsNeedReview(last) ? <Badge variant="warning" className="ml-2">{t('print.wordsReviewShort')}</Badge> : null}
      </p>
    </div>
  );
}

export function LanguageSettingsPage() {
  const t = useT();
  const qc = useQueryClient();
  const online = useOnline();
  const me = useSession().data?.user;
  const lang = useLanguageSettings();
  const langs = useLanguages();
  const { locale, sources } = useLocale();
  const mine = useMutation({
    mutationFn: (v: string) => ok(updateMe({ language: v === 'default' ? null : v }, ifMatch(me?.version))),
    onSuccess: () => qc.invalidateQueries(),
    onError: (e) => { if (e instanceof ApiError && e.isStale) void qc.invalidateQueries(); if (isUnknownLanguage(e)) void langs.refetch(); },
  });
  const current = me?.language ?? 'default';
  return (
    <div className="space-y-4">
      <PageHeader title={t('lang.title')} description={t('lang.description')} />
      <OfflineBanner />
      <Card>
        <CardHeader><CardTitle>{t('lang.shopCard')}</CardTitle></CardHeader>
        <CardContent><ShopLanguageForm /></CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{t('lang.myCard')}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <Field label={t('lang.myOverride')} hint={t('lang.myOverrideHint')}>{(id, d) => (
            <Select id={id} aria-describedby={d} className="max-w-sm" value={current} disabled={!online || mine.isPending} onChange={(e) => mine.mutate(e.target.value)}>
              <option value="default">{t('lang.followShop', { lang: localeLabels[sources.tenantDefault ?? 'en-IN'] })}</option>
              {(langs.data ?? []).map((l) => <option key={l.code} value={l.code}>{languageLabel(l)}</option>)}
            </Select>)}</Field>
          <p className="text-sm text-muted-foreground">{t('lang.effective', { lang: localeLabels[locale] })}</p>
          {isUnknownLanguage(mine.error) ? <p role="alert" className="text-sm text-destructive">{t('lang.unknownLanguage')}</p> : <ErrorText error={mine.error} />}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{t('lang.printCard')}</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>{t('lang.printNote')}</p>
          <ul className="flex flex-wrap gap-2">
            {lang.data?.supported.filter((s) => isPrintLanguage(s.code)).map((s) => (
              <li key={s.code}><Badge variant={s.amount_in_words_verified ? 'outline' : 'warning'}>{`${s.name}${s.amount_in_words_verified ? '' : ` · ${t('print.wordsReviewShort')}`}`}</Badge></li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">{t('print.idsLatin')}</p>
        </CardContent>
      </Card>
    </div>
  );
}
