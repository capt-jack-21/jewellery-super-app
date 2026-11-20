import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Check, Field, Select } from '@/components/ui/field';
import { ErrorText, OfflineBanner, PageHeader } from '@/components/page';
import { useT, useTk } from '@/i18n';
import { ApiError } from '@/lib/api/fetcher';
import type { ExportKind, ExportRequestFormat, ImportKind } from '@/lib/api/backend/model';
import { formatDecimalIN } from '@/lib/format';
import { useOnline } from '@/lib/offline/connectivity';
import { Importer } from '@/features/import/import';
import { mastersApi } from './api';

/** M17 kinds offered here (contract 0.7.3 ImportKind / ExportKind, the 981 names + floors (986)). Stock and opening balances stay on the P21 import page. */
export const MASTER_IMPORT_KINDS: readonly (ImportKind & ExportKind)[] = [
  'customers', 'metals', 'purities', 'items', 'sub_items', 'designs', 'stones', 'stone_rates', 'making_wastage_rules',
  'vendors', 'staff', 'floors', 'counters', 'trays', 'hsn_codes', 'payment_modes', 'card_machines',
];

/**
 * M17 — generic CSV/Excel import for every master, reusing the P21 importer (template → file → mapping profile →
 * server dry run → commit). No app-specific importer: another app's export is handled by a saved mapping profile.
 * Export writes the same columns as the template, so a list can be exported, edited and re-imported.
 */
export function MastersImportPage() {
  const t = useT();
  return (
    <div className="space-y-6">
      <PageHeader title={t('masters.import.title')} description={t('masters.import.desc')} />
      <OfflineBanner />
      <Importer kinds={MASTER_IMPORT_KINDS} />
      <ExportCard />
    </div>
  );
}

export function ExportCard() {
  const t = useT();
  const tk = useTk();
  const online = useOnline();
  const [kind, setKind] = useState<ExportKind>('customers');
  const [format, setFormat] = useState<ExportRequestFormat>('xlsx');
  const [inactive, setInactive] = useState(false);
  const run = useMutation({
    mutationFn: async () => {
      const job = await mastersApi.exportList(kind, format, inactive);
      if (!job.file_id) throw new ApiError(500, 'export_failed', t('masters.export.failed'));
      const url = await mastersApi.fileUrl(job.file_id);
      Object.assign(document.createElement('a'), { href: url, download: `${kind}.${format}`, rel: 'noopener' }).click();
      return job;
    },
  });
  const notReady = run.error instanceof ApiError && run.error.status === 404;
  return (
    <Card>
      <CardHeader><CardTitle>{t('masters.export.title')}</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">{t('masters.export.desc')}</p>
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t('masters.export.kind')}>{(id) => (
            <Select id={id} value={kind} onChange={(e) => { setKind(e.target.value as ExportKind); run.reset(); }}>
              {MASTER_IMPORT_KINDS.map((k) => <option key={k} value={k}>{tk(`import.entity.${k}`)}</option>)}
            </Select>)}</Field>
          <Field label={t('masters.export.format')}>{(id) => (
            <Select id={id} value={format} onChange={(e) => setFormat(e.target.value as ExportRequestFormat)}>
              <option value="xlsx">{t('masters.export.xlsx')}</option>
              <option value="csv">{t('masters.export.csv')}</option>
            </Select>)}</Field>
          <Check label={t('masters.export.inactive')} checked={inactive} onChange={setInactive} />
          <Button onClick={() => run.mutate()} disabled={!online || run.isPending}><Download className="mr-1 h-4 w-4" aria-hidden />{t('masters.export.run')}</Button>
        </div>
        <p className="text-xs text-muted-foreground">{t('masters.export.piiNote')}</p>
        {run.data ? <p role="status" className="text-sm">{t('masters.export.done', { count: formatDecimalIN(String(run.data.row_count), 0) })}</p> : null}
        {notReady ? <p role="note" className="rounded-md border border-border bg-muted p-3 text-sm">{t('masters.notReady')}</p> : <ErrorText error={run.error} />}
      </CardContent>
    </Card>
  );
}
