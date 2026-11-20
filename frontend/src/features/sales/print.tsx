import { useEffect, useRef, useState } from 'react';
import { IntlProvider } from 'react-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field, Select } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ErrorText } from '@/components/page';
import { useT, useTk } from '@/i18n';
import { formatDateTimeIN } from '@/lib/format';
import { toContract, type PrintNumerals } from '@/lib/print/locales';
import { loadFont, PRINT_FONT, type FontLang } from '@/lib/fonts';
import { PRINT_NUMERALS, printPresentation } from './print-data';
import { ReceiptPrint095V1, salesPrintDataError095 as salesPrintDataError } from './receipt095-v1';
import { PrintTemplateMetadata } from '@/features/settings/print-template-metadata';
import { salesPrintMessages } from './print-messages';
import { ApiError } from '@/lib/api/fetcher';
import { RELEASE_PRINT_LOCALES, isPrintLanguage, isPrintLocale, type ReleasePrintLocale } from '@/features/settings/print-language';
import { useAttemptKey } from '@/lib/api/attempt-key';
import { useCan } from '@/lib/session';
import { useOnline } from '@/lib/offline/connectivity';
import type { SalesPaperFormat, SalesPrintDocument, SalesPrintLogEntry, SalesPrintRequestCopy } from '@/lib/api/backend/model';
import { salesApi, salesKeys, type SalesDocType } from './api';
import { canPrint, isReprint, REPRINT_MAX } from './logic';
import { assertRecoveredPin096, recovery096, templateNotice096, type TemplateRef096 } from './repin096';
import { BUNDLED_RENDERERS_V1 } from './builtins-v1';
import { matchesTemplateAsset, resolveSalesTemplate, type SalesTemplateAsset } from './templates';
import { canRequestDuplicate093, needsReason093, printBadges093, printBody093 } from './contract-093-prep';

/** The browser print call, in one place so tests can stub it (no window.print in tests). */
export const printer = {
  async prepare(language: FontLang) {
    await loadFont(language);
    if (!document.fonts) return; // non-browser unit environment; real print engines have FontFaceSet
    const family = PRINT_FONT[language].split(',')[0];
    const sample = { en: 'Rupees 123', ta: 'தமிழ் ௧௨௩', hi: 'हिन्दी १२३', te: 'తెలుగు ౧౨౩', kn: 'ಕನ್ನಡ ೧೨೩', ml: 'മലയാളം ൧൨൩' }[language];
    for (const weight of [400, 600]) {
      const faces = await document.fonts.load(`${weight} 12px ${family}`, sample);
      if (!faces.length) throw new Error('Print font unavailable');
    }
    await document.fonts.ready;
  },
  print: () => window.print(),
};
export const PAPERS: SalesPaperFormat[] = ['A4', 'A5', 'thermal_80mm'];

/**
 * Renders the server's SalesPrintDocument (render data; the server logs the print and decides ORIGINAL / DUPLICATE / CANCELLED /
 * ESTIMATE). Paper size comes from `paper` via print CSS (@page per data-paper). Mandatory GST fields: seller GSTIN, number, date,
 * buyer / GSTIN, place of supply, HSN, taxable value, CGST / SGST or IGST, total in words, HUID.
 */
export function SalesPrintView({ doc, template }: { doc: SalesPrintDocument; template?: SalesTemplateAsset | null }) {
  const t = useT();
  const error = salesPrintDataError(doc) ?? (!matchesTemplateAsset(doc, template) ? 'print_template_asset_unavailable' : null);
  if (error) return <p role="alert" className="print:hidden" data-testid="print-data-error">{t(`error.${error}`)}</p>;
  const { lang } = printPresentation(doc);
  if (doc.doc_type === 'payment_receipt') return <ReceiptPrint095V1 doc={doc} />;
  const Template = BUNDLED_RENDERERS_V1['sales-gst-v1'];
  return <IntlProvider locale={doc.locale} messages={salesPrintMessages(lang)} defaultLocale="en-IN">
    <Template doc={doc} template={template as SalesTemplateAsset} />
  </IntlProvider>;
}
/** Every timestamp uses formatDateTimeIN (Asia/Kolkata), not the browser's timezone. */
export function PrintHistory({ count, last }: { count: number; last: string | null }) {
  const t = useT();
  return <p className="text-xs text-muted-foreground print:hidden" data-testid="print-history">{t('sales.print.history', { n: count, at: last ? formatDateTimeIN(last) : t('sales.print.never') })}</p>;
}

/**
 * Print a bill / credit note / estimate: choose paper; a document printed before needs a reason (3–200) and, for bills and credit notes,
 * sales.invoice.reprint — the server stamps it DUPLICATE. The returned render data is shown and sent to the printer.
 */
export function PrintPanel({ doc, id, printCount, defaultPaper, defaultLanguage = 'en', defaultNumerals = 'latin', autoFocus, cancelled = false, invoiceId }: { invoiceId?: string; doc: SalesDocType; id: string; printCount: number | null | undefined; defaultPaper?: SalesPaperFormat; defaultLanguage?: string; defaultNumerals?: SalesPrintDocument['numerals']; autoFocus?: boolean; cancelled?: boolean }) {
  const t = useT();
  const tk = useTk();
  const panel = useRef<HTMLElement>(null);
  const [receiptPreviouslyPrinted, setReceiptPreviouslyPrinted] = useState(false);
  // 0.9.6: a plain reprint of a non-renderable ORIGINAL pin → 422 with recovery; only a reasoned duplicate re-pins to the platform default.
  const [recovery, setRecovery] = useState<TemplateRef096 | null>(null);
  const [recoveryInvalid, setRecoveryInvalid] = useState(false);
  const can = useCan();
  const online = useOnline();
  const qc = useQueryClient();
  const key = useAttemptKey();
  const [paper, setPaper] = useState<SalesPaperFormat>(defaultPaper ?? 'A4');
  // null follows the actual asynchronous shop setting; never coerce unsupported stored values to English.
  const [chosenLocale, setLocale] = useState<ReleasePrintLocale | 'saved' | '' | null>(null);
  const locale = chosenLocale ?? (!isPrintLanguage(defaultLanguage) ? '' : (isReprint(printCount) || doc === 'payment_receipt') ? 'saved' : `${defaultLanguage}-IN`);
  const [languageRejected, setLanguageRejected] = useState(false);
  const [numerals, setNumerals] = useState<PrintNumerals | 'saved'>((isReprint(printCount) || doc === 'payment_receipt') ? 'saved' : PRINT_NUMERALS[defaultNumerals] ?? 'saved');
  const [copy, setCopy] = useState<SalesPrintRequestCopy>('auto');
  const [reason, setReason] = useState('');
  const [rendered, setRendered] = useState<SalesPrintDocument | null>(null);
  const asset = useQuery({ queryKey: ['sales', 'print-template', rendered?.template_id, rendered?.template_version], queryFn: () => resolveSalesTemplate(rendered as SalesPrintDocument), enabled: !!rendered && !salesPrintDataError(rendered), staleTime: Infinity, retry: false });
  const savedLanguage = rendered?.language ?? defaultLanguage;
  const savedSupported = isPrintLanguage(savedLanguage) && !languageRejected;
  const languageReady = isPrintLocale(locale) || (locale === 'saved' && savedSupported);
  const [fontError, setFontError] = useState(false);
  const [fontBusy, setFontBusy] = useState(false);
  // A cancelled bill can only be a duplicate; even if never printed, ask for a reason.
  const count = Math.max(printCount ?? 0, rendered?.print_no ?? 0, receiptPreviouslyPrinted || recovery ? 1 : 0);
  const reprint = needsReason093(count, cancelled, copy);
  const effectiveCount = reprint ? Math.max(1, count) : count;
  const canDuplicate = canRequestDuplicate093(count, cancelled);
  const run = useMutation({
    mutationFn: async () => {
      if (!languageReady || (locale !== 'saved' && !isPrintLocale(locale))) throw new ApiError(422, 'print_language_not_supported', 'Choose English or Tamil');
      // For saved language/numerals these conversion placeholders are NOT sent; the server retains the pinned settings.
      const options = toContract(locale === 'saved' ? 'en-IN' : locale, numerals === 'saved' ? 'latn' : numerals);
      const r = await salesApi.print(doc, id, printBody093({ paper, ...(locale !== 'saved' ? { language: locale === 'ta-IN' ? 'ta' as const : 'en' as const } : {}), ...(numerals !== 'saved' ? { numerals: options.numeral_system } : {}), copy: copy === 'duplicate' ? copy : undefined, count, cancelled, reason }), key.take(), invoiceId);
      if (recovery) assertRecoveredPin096(r, recovery); // render only the announced platform pin
      templateNotice096(r); // 0.9.6: inconsistent provenance fails closed before anything is rendered or printed
      return r;
    },
    onSuccess: (r) => {
      key.reset(); setReason(''); setRendered(r); setRecovery(null); setRecoveryInvalid(false); setLanguageRejected(!isPrintLanguage(r.language));
      if (doc === 'invoice') void qc.invalidateQueries({ queryKey: salesKeys.prints(id) }); setLocale('saved'); setNumerals('saved'); setCopy('auto');
      if (doc === 'payment_receipt' && invoiceId) { void qc.invalidateQueries({ queryKey: salesKeys.payments(invoiceId) }); return; }
      void qc.invalidateQueries({ queryKey: doc === 'invoice' ? salesKeys.invoice(id) : doc === 'credit_note' ? salesKeys.creditNote(id) : salesKeys.estimate(id) });
    },
    onError: (e) => { key.settle(e);
      const rec = recovery096(e, doc);
      if (rec === 'invalid') { setRecovery(null); setRecoveryInvalid(true); } else if (rec) { setRecovery(rec); setRecoveryInvalid(false); setCopy('duplicate'); } if (doc === 'payment_receipt' && e instanceof ApiError && e.code === 'reprint_reason_required') setReceiptPreviouslyPrinted(true); if (e instanceof ApiError && e.code === 'print_language_not_supported') { setLanguageRejected(true); setLocale(''); } },
  });
  useEffect(() => {
    if (!rendered || salesPrintDataError(rendered) || !matchesTemplateAsset(rendered, asset.data)) return;
    let alive = true;
    // React has committed the print DOM before fonts are requested. A failure keeps the preview but never prints tofu.
    setFontError(false); setFontBusy(true);
    void Promise.all(printPresentation(rendered).fontLanguages.map((lang) => printer.prepare(lang))).then(() => {
      if (alive) { setFontBusy(false); document.querySelectorAll<HTMLElement>('[data-testid="print-panel"]').forEach((p) => { p.dataset.printActive = p === panel.current ? 'true' : 'false'; }); printer.print(); }
    }).catch(() => { if (alive) { setFontBusy(false); setFontError(true); } });
    return () => { alive = false; };
  }, [rendered, asset.data]);
  const notice = (() => { try { return rendered ? templateNotice096(rendered) : null; } catch { return null; } })();
  const recoveryNoPerm = !!recovery && !can('sales.invoice.reprint');
  const allowed = !recoveryNoPerm && languageReady && canPrint(doc, effectiveCount, reason, can) && (copy !== 'duplicate' || canDuplicate);
  const noReprintPerm = reprint && doc !== 'estimate' && !can('sales.invoice.reprint');
  return (
    <section ref={panel} className="space-y-2" data-testid="print-panel">
      <div className="flex flex-wrap items-end gap-2 print:hidden">
        <Field label={t('sales.print.paper')}>{(fid) => (
          <Select id={fid} value={paper} onChange={(e) => { setPaper(e.target.value as SalesPaperFormat); key.reset(); }}>
            {PAPERS.map((p) => <option key={p} value={p}>{tk(`sales.print.paper.${p}`)}</option>)}
          </Select>)}</Field>
        <Field label={t('print.language')}>{(fid) => <Select id={fid} data-testid="sales-print-language" value={locale} onChange={(e) => {
          const next = e.target.value; if (isPrintLocale(next) || (next === 'saved' && savedSupported)) setLocale(next); key.reset();
        }}><option value="" disabled>{t('print.language.pick')}</option><option value="saved" disabled={!savedSupported}>{t('sales.print.savedOptions')}</option>{RELEASE_PRINT_LOCALES.map((l) => <option key={l} value={l}>{tk(`print.locale.${l}`)}</option>)}</Select>}</Field>
        <Field label={t('print.numerals')}>{(fid) => <Select id={fid} data-testid="sales-print-numerals" value={numerals} onChange={(e) => { setNumerals(e.target.value as PrintNumerals | 'saved'); key.reset(); }}>
          <option value="saved">{t('sales.print.savedOptions')}</option>
          {Object.values(PRINT_NUMERALS).map((n) => <option key={n} value={n}>{tk(`numerals.${n}`)}</option>)}
        </Select>}</Field>
        <Field label={t('sales.print.copyMode')}>{(fid) => <Select id={fid} data-testid="sales-print-copy" value={copy} onChange={(e) => { setCopy(e.target.value as SalesPrintRequestCopy); key.reset(); }}>
          <option value="auto">{t('sales.print.copyMode.auto')}</option>{canDuplicate ? <option value="duplicate">{t('sales.print.copyMode.duplicate')}</option> : null}
        </Select>}</Field>
        {reprint ? (
          <Field label={t('sales.print.reprintReason')} hint={t('sales.print.reprintHint')} className="min-w-64 flex-1">{(fid, d) => (
            <Input id={fid} aria-describedby={d} maxLength={REPRINT_MAX} value={reason} autoFocus={autoFocus} onChange={(e) => { setReason(e.target.value); key.reset(); }} />)}</Field>
        ) : null}
        <Button data-testid="print-button" disabled={!online || !allowed || run.isPending || fontBusy || (!!rendered && asset.isFetching)} onClick={() => run.mutate()}>
          <Printer className="h-4 w-4" aria-hidden />{reprint ? t('sales.print.duplicateButton') : t('sales.print.button')}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground print:hidden">{t('sales.print.languageHint')}</p>
      {!languageReady ? <p role="alert" className="print:hidden" data-testid="unsupported-print-language">{languageRejected ? t('print.language.pick') : t('print.language.unsupported', { value: savedLanguage })}</p> : null}
      {noReprintPerm ? <p role="note" className="text-sm text-muted-foreground print:hidden">{t('sales.print.noReprintPerm')}</p> : null}
      <div className="print:hidden"><ErrorText error={run.error} /></div>
      {recovery ? <p role="alert" className="text-sm print:hidden" data-testid="print-recovery">{t('sales.print.recovery')}</p> : null}
      {recoveryNoPerm ? <p role="note" className="text-sm print:hidden" data-testid="print-recovery-no-perm">{t('sales.print.recoveryNoPerm')}</p> : null}
      {recoveryInvalid ? <p role="alert" className="text-sm print:hidden" data-testid="print-recovery-invalid">{t('error.print_template_repin_invalid')}</p> : null}
      {fontError ? <div className="space-y-2 print:hidden"><p role="alert">{t('sales.print.fontError')}</p><Button type="button" onClick={() => setRendered((r) => r ? { ...r } : null)}>{t('sales.print.retryBrowser')}</Button></div> : null}
      {rendered ? <div className="text-xs print:hidden" data-testid="print-template-metadata"><p>{t('sales.print.templateRef', { id: rendered.template_id, version: rendered.template_version })}</p><PrintTemplateMetadata id={rendered.template_id} version={rendered.template_version}/></div> : null}
      {notice ? <p role="note" className="text-sm print:hidden" data-testid={notice.kind === 'repinned' ? 'print-repinned-note' : 'print-fallback-note'}>{t(notice.kind === 'repinned' ? 'sales.print.repinnedNote' : 'sales.print.fallbackNote', { id: notice.from.template_id, version: notice.from.template_version })}</p> : null}
      {asset.error ? <div className="space-y-2 print:hidden"><ErrorText error={asset.error} /><p>{t('sales.print.assetRecovery')}</p><Button onClick={() => void asset.refetch()}>{t('sales.print.retryAsset')}</Button></div> : null}
      {rendered && (salesPrintDataError(rendered) || asset.data) ? <div className="rounded-md border border-border print:border-0"><SalesPrintView doc={rendered} template={asset.data} /></div> : null}
    </section>
  );
}

/** Read-only log: each row's stored flags describe that print, not the invoice's status today. */
export function PrintLogRows({ rows }: { rows: SalesPrintLogEntry[] }) {
  const t = useT(); const tk = useTk();
  if (!rows.length) return <p>{t('sales.print.log.empty')}</p>;
  return <ol className="space-y-2" data-testid="print-log-rows">{rows.map((row) => {
    if (typeof row.doc_cancelled !== 'boolean' || (row.copy !== 'original' && row.copy !== 'duplicate') || (row.doc_cancelled && row.copy !== 'duplicate')) return <li key={row.print_no} role="alert">{t('error.print_snapshot_invalid')}</li>;
    const flags = printBadges093(row);
    return <li key={row.print_no} className="border-t border-border pt-1" data-testid="print-log-row">
      <p>{t('sales.print.footer', { no: row.print_no, at: formatDateTimeIN(row.printed_at) })} · {t(flags.copy === 'original' ? 'sales.print.original' : 'sales.print.duplicate')}{flags.stamp ? ` · ${tk(`sales.print.stamp.${flags.stamp}`)}` : ''}</p>
      <PrintTemplateMetadata id={row.template_id} version={row.template_version}/><p>{row.reprint_reason ?? ''}</p><p>{t('sales.print.log.version', { version: row.template_version ?? '—' })} · {row.template_id ?? t('sales.print.legacyPin')} · {row.locale} · {row.language} · {row.numerals}</p>
    </li>;
  })}</ol>;
}
export function InvoicePrintLog({ id }: { id: string }) {
  const t = useT(); const can = useCan(); const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: salesKeys.prints(id), queryFn: () => salesApi.prints(id), enabled: open && can('sales.invoice.view'), retry: false });
  if (!can('sales.invoice.view')) return null;
  return <details className="space-y-2 text-sm print:hidden" onToggle={(e) => setOpen(e.currentTarget.open)}>
    <summary className="cursor-pointer">{t('sales.print.log.title')}</summary><ErrorText error={q.error} />{q.data ? <PrintLogRows rows={q.data} /> : null}
  </details>;
}
