import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader } from '@/components/page';
import { PrintPreview } from '@/components/print-preview';
import { PrintOptionsFields } from '@/features/settings/print-templates';
import { useLocale, useT } from '@/i18n';
import type { PrintLocale, PrintNumerals } from '@/lib/print/locales';

/** Dev page: per-print language + numerals preview (defaults to the UI language, Western digits). */
export function PrintPage() {
  const t = useT();
  const { locale } = useLocale();
  const [opt, setOpt] = useState<{ locale: PrintLocale; numerals: PrintNumerals }>({ locale: locale === 'ta-IN' ? 'ta-IN' : 'en-IN', numerals: 'latn' });
  return (
    <div className="space-y-4">
      <PageHeader title={t('nav.printPreview')} description={t('print.previewNote')} />
      <Card><CardContent className="grid gap-3 pt-4 sm:grid-cols-2"><PrintOptionsFields value={opt} onChange={setOpt} /></CardContent></Card>
      <PrintPreview locale={opt.locale} numerals={opt.numerals} />
    </div>
  );
}
