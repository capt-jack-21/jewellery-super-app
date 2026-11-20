import { useEffect, useState } from 'react';
import { useBrand } from '@/lib/brand/context';
import { useT, useTk } from '@/i18n';
import { D, formatDateIN, formatINR, type Numerals } from '@/lib/format';
import { loadFont, numeralOptions, PRINT_FONT, printLangs, type PrintLang, type PrintLocale, type PrintNumerals } from '@/lib/print/locales';
import { RELEASE_PRINT_LOCALES, isPrintLocale } from '@/features/settings/print-language';
import type { RateCardData } from './api';

/** Print doc_type for the rate card (0.7.4: PrintDocType includes 'rate_card'). */
export const RATE_CARD_DOC_TYPE = 'rate_card' as const;
export const RATE_CARD_LOCALES: PrintLocale[] = [...RELEASE_PRINT_LOCALES];

type CardLabel = 'title' | 'purity' | 'perGram' | 'perSovereign' | 'oldMetal' | 'date' | 'branch' | 'allBranches';
const LABELS: Partial<Record<PrintLang, Record<CardLabel, string>>> = {
  en: { title: "Today's rates", purity: 'Purity', perGram: 'Per gram', perSovereign: 'Per 8 g (sovereign)', oldMetal: 'Old metal (per g)', date: 'Date', branch: 'Branch', allBranches: 'All branches' },
  ta: { title: 'இன்றைய விலை', purity: 'தூய்மை', perGram: 'ஒரு கிராம்', perSovereign: '8 கி (ஒரு பவுன்)', oldMetal: 'பழைய உலோகம் (கிராம்)', date: 'தேதி', branch: 'கிளை', allBranches: 'அனைத்துக் கிளைகளும்' },
};
const label = (l: PrintLang, k: CardLabel) => (LABELS[l] ?? LABELS.en)?.[k] ?? k;

export interface RateCardProps { card: RateCardData; locale: PrintLocale; numerals: PrintNumerals }

/**
 * Printable rate card from GET /v1/rates/rate-card (doc_type rate_card). Language and numerals follow the print-language
 * rules (per print, independent of the UI); purity and metal codes stay Latin (lang="en"). Branded via tokens.
 */
export function RateCard({ card, locale, numerals }: RateCardProps) {
  const { brand } = useBrand();
  const t = useT();
  const supported = isPrintLocale(locale);
  const langs = supported ? printLangs(locale) : [];
  const main = langs.at(-1) ?? 'en';
  const [fontReady, setFontReady] = useState(main === 'en');
  useEffect(() => { if (!supported) return; let alive = true; void loadFont(main).then(() => alive && setFontReady(true)); return () => { alive = false; }; }, [main, supported]);
  if (!supported) return <p role="alert">{t('print.language.unsupported', { value: locale })}</p>;
  const n = (numeralOptions(locale).includes(numerals) ? numerals : 'latn') as Numerals;
  const L = (k: CardLabel) => langs.map((l) => label(l, k)).join(' / ');
  const title = card.company?.trade_name || card.company?.legal_name || brand.appName;
  return (
    <article data-testid="rate-card" data-doc-type={card.doc_type ?? RATE_CARD_DOC_TYPE} data-font-ready={fontReady} lang={main} style={{ fontFamily: PRINT_FONT[main] }}
      className="rate-card mx-auto max-w-2xl rounded-md border border-border bg-card p-6 text-card-foreground print:max-w-none print:border-0">
      <header className="mb-4 flex items-start justify-between gap-2 border-b-2 border-primary pb-2">
        <div>
          {brand.logoUrl ? <img src={brand.logoUrl} alt="" className="mb-1 h-10" /> : null}
          <h1 className="text-xl font-semibold text-primary">{title}</h1>
          {card.company?.gstin ? <p lang="en" className="font-mono text-xs">{`GSTIN ${card.company.gstin}`}</p> : null}
          <p className="text-lg">{L('title')}</p>
        </div>
        <div className="text-right text-sm">
          <p className="tabular-nums" data-testid="rate-card-date">{`${L('date')}: ${formatDateIN(card.rate_date, n)}`}</p>
          <p>{`${L('branch')}: ${card.branch?.name ?? L('allBranches')}`}</p>
        </div>
      </header>
      {card.metals.map((m) => {
        const ps = m.purities.filter((p) => p.sale_rate_per_g != null);
        if (!ps.length) return null;
        return (
          <section key={m.metal_id} className="mb-4 break-inside-avoid">
            <h2 className="mb-1 font-semibold">{m.name} <span lang="en" className="text-xs text-muted-foreground">{m.code}</span></h2>
            <table className="w-full text-base">
              <thead><tr className="border-b border-border text-left text-sm"><th>{L('purity')}</th><th className="text-right">{L('perGram')}</th>
                {m.code === 'GOLD' ? <th className="text-right">{L('perSovereign')}</th> : null}<th className="text-right">{L('oldMetal')}</th></tr></thead>
              <tbody>
                {ps.map((p) => (
                  <tr key={p.purity_id} className="border-b border-border" data-testid={`card-${p.code}`}>
                    <td lang="en" className="font-mono">{p.code}</td>
                    <td className="text-right tabular-nums">{p.sale_rate_per_g ? formatINR(p.sale_rate_per_g, { numerals: n }) : '—'}</td>
                    {m.code === 'GOLD' ? <td className="text-right tabular-nums">{p.sale_rate_per_g ? formatINR(D(p.sale_rate_per_g).times(8), { numerals: n }) : '—'}</td> : null}
                    <td className="text-right tabular-nums">{p.old_metal_rate_per_g ? formatINR(p.old_metal_rate_per_g, { numerals: n }) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        );
      })}
    </article>
  );
}

/** Screen-only controls for the rate card (hidden in print). */
export function RateCardControls({ locale, numerals, onLocale, onNumerals }: { locale: PrintLocale; numerals: PrintNumerals; onLocale: (l: PrintLocale) => void; onNumerals: (n: PrintNumerals) => void }) {
  const t = useT();
  const tk = useTk();
  return (
    <div className="flex flex-wrap items-end gap-3 print:hidden">
      <label className="text-sm">{t('rates.card.language')}{' '}
        <select className="ml-1 rounded-md border border-input bg-background px-2 py-1" value={isPrintLocale(locale) ? locale : ''} onChange={(e) => { const l = e.target.value as PrintLocale; onLocale(l); if (!numeralOptions(l).includes(numerals)) onNumerals('latn'); }}>
          <option value="" disabled>{t('print.language.pick')}</option>{RATE_CARD_LOCALES.map((l) => <option key={l} value={l}>{tk(`rates.card.locale.${l}`)}</option>)}
        </select>
      </label>
      {!isPrintLocale(locale) ? <p role="alert">{t('print.language.unsupported', { value: locale })}</p> : null}
      <label className="text-sm">{t('rates.card.numerals')}{' '}
        <select className="ml-1 rounded-md border border-input bg-background px-2 py-1" value={numerals} onChange={(e) => onNumerals(e.target.value as PrintNumerals)}>
          {numeralOptions(locale).map((x) => <option key={x} value={x}>{tk(`rates.card.numeral.${x}`)}</option>)}
        </select>
      </label>
      <button type="button" className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground" disabled={!isPrintLocale(locale)} onClick={() => { if (isPrintLocale(locale)) window.print(); }}>{t('rates.card.print')}</button>
    </div>
  );
}
