import { useEffect, useState } from 'react';
import { useBrand } from '@/lib/brand/context';
import { useT } from '@/i18n';
import { amountWithWords, D, formatDateIN, formatIdentifier, formatINR, formatWeight, type Numerals } from '@/lib/format';
import type { PrintLocale, PrintNumerals } from '@/lib/print/locales';
import { loadFont, PRINT_FONT, printLangs, wordsLocale, wordsNeedReview, type PrintLang } from '@/lib/print/locales';
import { PRINT_LABELS, SAMPLE_ITEMS, type PrintLabel } from '@/lib/print/labels';

export interface PrintOptions { locale: PrintLocale; numerals: PrintNumerals; kind?: 'estimate' | 'tax_invoice' | 'receipt' | 'credit_note'; format?: 'a4' | 'a5' | 'thermal_80'; footer?: string; showLogo?: boolean }

const SAMPLE_IDS = { gstin: '33AABCD1234E1Z5', docNo: 'INV/2026-27/000123', phone: '9840012345' };
const LANG_NAME: Record<PrintLang, string> = { en: 'English', ta: 'Tamil', hi: 'Hindi', te: 'Telugu', kn: 'Kannada', ml: 'Malayalam' };

/**
 * Print PREVIEW with a per-print language and numeral system, independent of the UI language.
 * Real prints are server-resolved versioned templates; this proves formatters, fonts and amount-in-words.
 * Bilingual = English with the chosen language underneath. Identifiers always use Latin digits.
 */
export function PrintPreview({ locale, numerals, kind = 'estimate', format = 'a4', footer, showLogo = true }: PrintOptions) {
  const { brand } = useBrand();
  const t = useT();
  const langs = printLangs(locale);
  const main = langs.at(-1) ?? 'en';
  const [fontReady, setFontReady] = useState(main === 'en');
  useEffect(() => { let alive = true; setFontReady(main === 'en'); void loadFont(main).then(() => document.fonts.ready).then(() => alive && setFontReady(true)); return () => { alive = false; }; }, [main]);
  const n = numerals as Numerals;
  const L = (k: PrintLabel) => langs.map((l) => PRINT_LABELS[l][k]).join(' / ');
  const total = SAMPLE_ITEMS.reduce((s, l) => s.plus(D(l.amt)), D('0'));
  const width = format === 'thermal_80' ? 'max-w-xs text-xs' : format === 'a5' ? 'max-w-lg text-sm' : 'max-w-2xl text-sm';
  return (
    <article data-testid="print-preview" data-font-ready={fontReady} lang={main} style={{ fontFamily: PRINT_FONT[main] }}
      className={`mx-auto rounded-md border border-border bg-card p-6 text-card-foreground print:border-0 ${width}`}>
      <header className="mb-4 flex justify-between gap-2">
        <div>
          {showLogo && brand.logoUrl ? <img src={brand.logoUrl} alt="" className="mb-1 h-8" /> : null}
          <h1 className="font-semibold text-lg">{brand.appName}</h1>
          <p>{L(kind)}</p>
          <p data-testid="print-gstin" lang="en">{`${PRINT_LABELS[main].gstin}: ${formatIdentifier('gstin', SAMPLE_IDS.gstin)}`}</p>
          <p data-testid="print-phone">{`${L('phone')}: `}<span lang="en">{formatIdentifier('phone', SAMPLE_IDS.phone)}</span></p>
        </div>
        <div className="text-right">
          <p data-testid="print-docno">{`${L('docNo')}: `}<span lang="en">{formatIdentifier('doc_no', SAMPLE_IDS.docNo)}</span></p>
          <p className="tabular-nums">{`${L('date')}: ${formatDateIN(new Date(), n)}`}</p>
        </div>
      </header>
      {kind === 'estimate' ? <p className="mb-2 text-warning">{L('notTaxInvoice')}</p> : null}
      <table className="w-full">
        <thead><tr className="border-b border-border text-left"><th>{L('item')}</th><th>{L('huid')}</th><th className="text-right">{L('weight')}</th><th className="text-right">{L('amount')}</th></tr></thead>
        <tbody>{SAMPLE_ITEMS.map((l) => (
          <tr key={l.huid}><td>{langs.map((x) => l.name[x]).join(' / ')}</td>
            <td lang="en" data-testid="print-huid">{formatIdentifier('huid', l.huid)}</td>
            <td className="text-right tabular-nums">{formatWeight(l.wt, 'g', { numerals: n })}</td>
            <td className="text-right tabular-nums">{formatINR(l.amt, { numerals: n })}</td></tr>))}</tbody>
        <tfoot><tr className="border-t border-border font-semibold"><td colSpan={3}>{L('total')}</td><td className="text-right tabular-nums" data-testid="print-total">{formatINR(total, { numerals: n })}</td></tr></tfoot>
      </table>
      {langs.map((l) => (
        <p key={l} lang={l} className="mt-3" data-testid={`words-${l}`}><strong>{`${PRINT_LABELS[l].amountInWords}: `}</strong>{amountWithWords(total, wordsLocale(l), l === 'en' ? 'latn' : n)}</p>
      ))}
      {langs.filter(wordsNeedReview).map((l) => (
        <p key={`r-${l}`} data-testid="words-review" className="mt-2 rounded-sm border border-warning bg-warning/15 px-2 py-1 text-xs print:hidden">{t('print.wordsReview', { lang: LANG_NAME[l] })}</p>
      ))}
      <p className="mt-2 text-xs text-muted-foreground print:hidden">{t('print.idsLatin')}</p>
      {footer ? <p className="mt-4 border-t border-border pt-2 text-muted-foreground">{footer}</p> : null}
    </article>
  );
}
