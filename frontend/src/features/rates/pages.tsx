import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ErrorText, OfflineBanner, PageHeader } from '@/components/page';
import { useT } from '@/i18n';
import type { PrintLocale, PrintNumerals } from '@/lib/print/locales';
import { TodaysRateBanner } from './banner';
import { EffectiveRates, TodaysRatesForm } from './entry';
import { RateHistoryTable } from './history';
import { RateCard, RateCardControls } from './rate-card';
import { useDeviceBranch, useRateCard, useRateRefs } from './hooks';

function RatesNav() {
  const t = useT();
  return (
    <nav aria-label={t('rates.nav')} className="flex flex-wrap gap-3 text-sm print:hidden">
      <Link to="/rates" className="underline">{t('rates.nav.today')}</Link>
      <Link to="/rates/history" className="underline">{t('rates.nav.history')}</Link>
      <Link to="/rates/card" className="underline">{t('rates.nav.card')}</Link>
    </nav>
  );
}

/** /rates — banner for this branch, the short entry form, and what is in effect here. */
export function RatesPage() {
  const t = useT();
  const branchId = useDeviceBranch();
  const { branches } = useRateRefs();
  return (
    <div className="space-y-4">
      <PageHeader title={t('rates.title')} description={t('rates.description')} />
      <RatesNav />
      <OfflineBanner />
      <TodaysRateBanner branchId={branchId || null} linkToRates={false} />
      <div className="grid gap-4 lg:grid-cols-2">
        <TodaysRatesForm defaultBranchId={branchId} />
        <EffectiveRates branchId={branchId || null} branchName={branches.find((b) => b.id === branchId)?.name} />
      </div>
    </div>
  );
}

export function RateHistoryPage() {
  const t = useT();
  return (
    <div className="space-y-4">
      <PageHeader title={t('rates.historyPage')} />
      <RatesNav />
      <RateHistoryTable />
    </div>
  );
}

export function RateCardPage() {
  const t = useT();
  const branchId = useDeviceBranch();
  const card = useRateCard(branchId || null);
  const [locale, setLocale] = useState<PrintLocale>('ta-IN');
  const [numerals, setNumerals] = useState<PrintNumerals>('latn');
  return (
    <div className="space-y-4">
      <div className="print:hidden"><PageHeader title={t('rates.card.title')} /></div>
      <RatesNav />
      <RateCardControls locale={locale} numerals={numerals} onLocale={setLocale} onNumerals={setNumerals} />
      {card.data && !card.data.todays_rate_set ? <div className="print:hidden"><TodaysRateBanner branchId={branchId || null} linkToRates={false} /></div> : null}
      <ErrorText error={card.error} />
      {card.data ? <RateCard card={card.data} locale={locale} numerals={numerals} /> : null}
    </div>
  );
}
