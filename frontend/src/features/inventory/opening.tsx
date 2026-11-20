import { Importer } from '@/features/import/import';
import { useT } from '@/i18n';
import { InvPage } from './ui';

/** 10 — Opening stock import: the existing masters import flow (upload → check → fix rows → apply), stock kinds only. */
export function OpeningStockPage() {
  const t = useT();
  return (
    <InvPage title="inventory.opening.title" description="inventory.opening.desc">
      <ol className="list-decimal space-y-1 pl-5 text-sm">
        <li>{t('inventory.opening.step1')}</li>
        <li>{t('inventory.opening.step2')}</li>
        <li>{t('inventory.opening.step3')}</li>
      </ol>
      <Importer kinds={['stock', 'opening_balances']} />
    </InvPage>
  );
}
