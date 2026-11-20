/** Immutable compiled layout sales-gst-v1. Publish a new renderer key/file for future layout changes. */
import { useT, useTk } from '@/i18n';
import { formatDateIN, formatDateTimeIN, formatINR, formatPercent, formatWeight } from '@/lib/format';
import { toNumerals } from '@/lib/format/numerals';
import { PRINT_FONT } from '@/lib/fonts';
import { D } from '@/lib/format/decimal';
import type { CreditNote, Estimate, Invoice, SalesPrintDocument } from '@/lib/api/backend/model';
import { creditNoteAmount } from './events';
import { creditPrintSnapshot, gstStateName, printPresentation, salesPrintWords } from './print-data';
import { printBadges093 } from './contract-093-prep';
import type { SalesTemplateAsset } from './templates';
const isInvoice = (d: SalesPrintDocument): d is SalesPrintDocument & { snapshot: Invoice } => d.doc_type === 'invoice';
const isCreditNote = (d: SalesPrintDocument): d is SalesPrintDocument & { snapshot: CreditNote } => d.doc_type === 'credit_note';

export function SalesPrintTemplateV1({ doc, template }: { doc: SalesPrintDocument; template: SalesTemplateAsset }) {
  const t = useT();
  const tk = useTk();
  const inv = isInvoice(doc) ? doc.snapshot : null;
  const cn = isCreditNote(doc) ? doc.snapshot : null;
  const est = !inv && !cn ? (doc.snapshot as Estimate) : null;
  const { lang, numerals, fontLanguages } = printPresentation(doc);
  const badges = printBadges093(doc);
  const stamp = doc.stamp;
  const credit = cn ? creditPrintSnapshot(cn) : null;
  const taxNote = cn?.gst_applicable === true;
  const comp = inv ?? est?.computation ?? null;
  const seller = comp?.seller ?? credit?.seller ?? null;
  const taxSummary = comp?.tax_summary ?? credit?.tax_summary ?? [];
  const pos = comp?.place_of_supply ?? cn?.place_of_supply;
  const fmtMoney = (v: string) => formatINR(v, { numerals });
  const fmtWeight = (v: string) => formatWeight(v, 'g', { numerals });
  const fmtPercent = (v: string) => formatPercent(v, 2, { numerals });
  const customer = inv?.customer ?? cn?.customer ?? est?.computation.customer ?? null;
  const intra = (comp?.gst_type ?? cn?.gst_type) !== 'inter';
  const date = inv?.doc_date ?? cn?.doc_date ?? est?.estimate_date ?? doc.printed_at;
  const thermal = doc.paper === 'thermal_80mm';
  const addr = seller?.address ? [seller.address.line1, seller.address.line2, seller.address.city, seller.address.district, seller.address.pincode].filter(Boolean).join(', ') : '';
  const money = (label: string, v: string | null | undefined, opts: { minus?: boolean; testId?: string } = {}) => (v && !/^-?0(\.0+)?$/.test(v)) || opts.testId ? (
    <p className="flex justify-between gap-2" data-testid={opts.testId}><span>{label}</span><span className="tabular-nums">{opts.minus ? '-' : ''}{fmtMoney(v ?? '0')}</span></p>) : null;
  const title = doc.doc_type === 'invoice' ? t('sales.print.taxInvoice') : doc.doc_type === 'credit_note' ? t(cn?.kind === 'receipt_reversal' ? 'sales.creditNote.kind.receipt_reversal' : 'sales.print.creditNote') : t('sales.print.estimate');
  if (cn && !credit) return <p role="alert" data-testid="print-snapshot-error" className="print:hidden">{t('sales.print.missingSnapshot')}</p>;
  return (
    <article className={`sales-doc mx-auto bg-background text-foreground ${template.layout === 'compact' ? 'p-2 text-xs' : 'p-4 text-sm'}`} data-paper={doc.paper} data-testid="sales-doc" data-template-id={template.template_id} data-template-version={template.template_version} data-template-renderer={template.renderer} data-locale={doc.locale} lang={lang} style={{ fontFamily: fontLanguages.length === 1 ? PRINT_FONT[lang] : `${fontLanguages.map((l) => PRINT_FONT[l].split(',')[0]).join(', ')}, sans-serif` }}>
      {template.heading_text ? <p data-testid="template-heading">{template.heading_text}</p> : null}
      <header className={thermal ? 'space-y-0.5 border-b border-border pb-2 text-center' : 'flex flex-wrap items-start justify-between gap-2 border-b border-border pb-2'}>
        <div>
          {seller ? <p className="text-base font-semibold">{seller.legal_name}</p> : null}
          {addr ? <p className="text-xs">{addr}</p> : null}
          {seller ? <p data-testid="doc-seller-state">{t('sales.print.sellerState', { state: gstStateName(seller.state_code), code: seller.state_code })}</p> : null}
          {seller?.gstin ? <p lang="en" className="font-mono text-xs">{t('sales.print.gstin')} {seller.gstin}</p> : null}
        </div>
        <div className={thermal ? '' : 'text-right'}>
          <p className="text-lg font-semibold">{title}</p>
          <p lang="en" className="font-mono" data-testid="doc-no">{doc.doc_no}</p>
          <p>{formatDateIN(date, numerals)}</p>
          <p className="text-xs text-muted-foreground" data-testid="copy">{badges.copy === 'original' ? t('sales.print.original') : t('sales.print.duplicate')}</p>
        </div>
      </header>
      {cn && credit ? <div className="mt-2 text-xs"><p data-testid="doc-original-invoice">{t('sales.print.originalInvoice', { no: credit.invoice.doc_no, date: formatDateIN(credit.invoice.doc_date, numerals) })}</p><p data-testid="doc-original-total">{t('sales.print.originalTotal', { amount: fmtMoney(credit.invoice.invoice_total) })}</p><p data-testid="doc-supply-type">{t(cn.supply_type === 'b2b' ? 'sales.supply.b2b' : 'sales.supply.b2c')}</p></div> : null}
      {cn?.kind === 'receipt_reversal' ? <p className="mt-2 text-xs" data-testid="doc-non-gst">{t('sales.print.nonGst')}</p> : null}
      {stamp ? <p className="my-2 rounded border-2 border-destructive py-1 text-center text-lg font-bold uppercase tracking-widest text-destructive" data-testid="stamp">{tk(`sales.print.stamp.${stamp}`)}</p> : null}
      {customer ? (
        <section className="mt-2 text-xs" data-testid="doc-customer">
          <p className="font-semibold">{customer.name}</p>
          {customer.gstin ? <p lang="en" className="font-mono">{t('sales.print.gstin')} {customer.gstin}</p> : null}
          {customer.pan_last4 ? <p lang="en" className="font-mono">{t('sales.print.pan', { last4: customer.pan_last4 })}</p> : null}
          {pos && (comp || taxNote) ? <p data-testid="doc-pos">{t('sales.print.placeOfSupply', { code: pos })}</p> : null}
        </section>
      ) : null}
      {comp && thermal ? (
        <table className="mt-2 w-full text-xs" data-testid="doc-lines">
          <thead><tr className="border-b border-border text-left"><th>{t('sales.print.item')}</th><th className="text-right">{t('sales.totals.taxable')}</th></tr></thead>
          <tbody>
            {comp.lines.map((l) => (
              <tr key={l.line_no} className="border-b border-border align-top">
                <td className="py-0.5">
                  <p>{l.tag_no ? <span lang="en" className="font-mono">{l.tag_no} </span> : null}{l.description} · {l.purity_code}</p><p>{t('sales.loose.pieces')}: {toNumerals(String(l.pieces), numerals)}</p>
                  <p lang="en" className="font-mono text-[0.9em] text-muted-foreground">{`${t('sales.gst.hsn')} ${l.hsn}`}{l.huid ? ` · ${t('sales.line.huid')} ${l.huid}` : ''}</p>
                  <p className="tabular-nums text-muted-foreground">{`${fmtWeight(l.net_wt)} × ${fmtMoney(l.rate_per_g)} + ${fmtMoney(l.mc_amount)}`}</p>
                </td>
                <td className="whitespace-nowrap py-0.5 text-right tabular-nums">{fmtMoney(l.taxable_value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : comp ? (
        <table className="mt-2 w-full text-xs" data-testid="doc-lines">
          <thead><tr className="border-b border-border text-left">
            <th>{t('sales.print.item')}</th><th>{t('sales.gst.hsn')}</th><th>{t('sales.line.huid')}</th><th className="text-right">{t('sales.line.netWt')}</th>
            <th className="text-right">{t('sales.line.rate')}</th><th className="text-right">{t('sales.line.making')}</th><th className="text-right">{t('sales.totals.taxable')}</th>
          </tr></thead>
          <tbody>
            {comp.lines.map((l) => (
              <tr key={l.line_no} className="border-b border-border align-top">
                <td>{l.tag_no ? <span lang="en" className="font-mono">{l.tag_no} </span> : null}{l.description} · {l.purity_code}<p>{t('sales.loose.pieces')}: {toNumerals(String(l.pieces), numerals)}</p></td>
                <td lang="en" className="font-mono">{l.hsn}</td><td lang="en" className="font-mono">{l.huid ?? '—'}</td>
                <td className="text-right tabular-nums">{fmtWeight(l.net_wt)}</td><td className="text-right tabular-nums">{fmtMoney(l.rate_per_g)}</td>
                <td className="text-right tabular-nums">{fmtMoney(l.mc_amount)}</td><td className="text-right tabular-nums">{fmtMoney(l.taxable_value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {taxNote && credit ? (
        <table className="mt-2 w-full text-xs" data-testid="doc-lines">
          <thead><tr><th className="text-left">{t('sales.print.item')}</th><th className="text-right">{t('sales.totals.taxable')}</th><th className="text-right">{t('sales.print.creditTotal')}</th></tr></thead>
          <tbody>{credit.lines.map(({ credit: l, original }) => <tr key={l.invoice_line_id} className="border-b border-border align-top">
            <td>{l.tag_no ? <span lang="en" className="font-mono">{l.tag_no} </span> : null}{l.description}
              <p lang="en" className="font-mono">{`${t('sales.gst.hsn')} ${l.hsn} · ${t('sales.line.huid')} ${original?.huid ?? '—'}`}</p>
              <p data-testid="cn-principal-rate">{t('sales.gst.rate')}: {fmtPercent(l.tax_rate)}</p>
              {l.tax_parts.map((part, i) => <div key={i} data-testid="cn-tax-part" className="mt-1 tabular-nums"><p>{tk(`sales.taxPart.${part.component}`)} · <span lang="en" className="font-mono">{part.hsn_sac}</span> · {fmtPercent(part.rate)} · {fmtMoney(part.taxable_value)}</p>{(['cgst', 'sgst', 'igst', 'cess'] as const).map((head) => <p key={head}>{tk(`sales.gst.${head}`)} {fmtPercent(part[`${head}_rate`])}: {fmtMoney(part[head])}</p>)}</div>)}
              {original ? <p className="tabular-nums">{fmtWeight(original.net_wt)} · {t('sales.loose.pieces')}: {toNumerals(String(original.pieces), numerals)}</p> : null}
            </td><td className="text-right tabular-nums">{fmtMoney(l.taxable_value)}</td><td className="text-right tabular-nums">{fmtMoney(l.line_total)}</td>
          </tr>)}</tbody>
        </table>
      ) : null}
      {taxSummary.length && thermal ? (
        <div className="mt-2 space-y-0.5 border-b border-border pb-1 text-xs" data-testid="doc-gst">
          <p className="font-semibold">{t('sales.gst.breakup')}</p>
          {taxSummary.map((r) => (
            <div key={`${r.hsn_sac}-${r.rate}`}>
              <p className="flex justify-between gap-2"><span><span lang="en" className="font-mono">{r.hsn_sac}</span>{` · ${fmtPercent(r.rate)}`}</span><span className="tabular-nums">{fmtMoney(r.taxable_value)}</span></p>
              <p className="text-right tabular-nums text-muted-foreground">{intra ? `${t('sales.gst.cgst')} ${fmtMoney(r.cgst)} · ${t('sales.gst.sgst')} ${fmtMoney(r.sgst)}` : `${t('sales.gst.igst')} ${fmtMoney(r.igst)}`} · {t('sales.gst.cess')} {fmtMoney(r.cess)}</p>
            </div>))}
        </div>
      ) : taxSummary.length ? (
        <table className="mt-2 w-full text-xs [&_td]:px-1 [&_th]:px-1" data-testid="doc-gst">
          <thead><tr className="text-left"><th>{t('sales.gst.hsn')}</th><th className="text-right">{t('sales.gst.rate')}</th><th className="text-right">{t('sales.totals.taxable')}</th>
            {intra ? <><th className="text-right">{t('sales.gst.cgst')}</th><th className="text-right">{t('sales.gst.sgst')}</th></> : <th className="text-right">{t('sales.gst.igst')}</th>}<th className="text-right">{t('sales.gst.cess')}</th></tr></thead>
          <tbody>{taxSummary.map((r) => (
            <tr key={`${r.hsn_sac}-${r.rate}`}><td lang="en" className="font-mono">{r.hsn_sac}</td><td className="text-right">{fmtPercent(r.rate)}</td><td className="text-right tabular-nums">{fmtMoney(r.taxable_value)}</td>
              {intra ? <><td className="text-right tabular-nums">{fmtMoney(r.cgst)}</td><td className="text-right tabular-nums">{fmtMoney(r.sgst)}</td></> : <td className="text-right tabular-nums">{fmtMoney(r.igst)}</td>}<td className="text-right tabular-nums">{fmtMoney(r.cess)}</td></tr>))}
          </tbody>
        </table>
      ) : null}
      <section className={`mt-2 space-y-0.5 text-xs ${thermal ? '' : 'ml-auto max-w-xs'}`}>
        {comp ? <>
          {money(t('sales.totals.discount'), D(comp.totals.line_discount).add(D(comp.totals.bill_discount)).toFixed(2), { minus: true })}
          {money(t('sales.totals.taxable'), comp.totals.taxable_value, { testId: 'doc-taxable' })}
          {intra ? <>{money(t('sales.gst.cgst'), comp.totals.cgst)}{money(t('sales.gst.sgst'), comp.totals.sgst)}</> : money(t('sales.gst.igst'), comp.totals.igst)}
          {money(t('sales.gst.cess'), comp.totals.cess)}
          {money(t('sales.totals.roundOff'), comp.totals.round_off)}
          {money(t('sales.totals.billTotal'), comp.totals.invoice_total, { testId: 'doc-bill-total' })}
        </> : null}
        {taxNote && cn ? <>
          {money(t('sales.totals.taxable'), cn.taxable_value, { testId: 'doc-taxable' })}
          {intra ? <>{money(t('sales.gst.cgst'), cn.cgst)}{money(t('sales.gst.sgst'), cn.sgst)}</> : money(t('sales.gst.igst'), cn.igst)}
          {money(t('sales.gst.cess'), cn.cess)}
          {money(t('sales.totals.roundOff'), cn.round_off)}
        </> : null}
        {comp?.old_metal.length ? <p className="flex justify-between"><span>{t('sales.totals.oldGold')}</span><span className="tabular-nums">-{fmtMoney(comp.totals.old_metal_value)}</span></p> : null}
        <p className="flex justify-between text-base font-semibold" data-testid="doc-total"><span>{doc.doc_type === 'credit_note' ? t('sales.print.creditTotal') : t('sales.totals.payable')}</span>
          <span className="tabular-nums">{fmtMoney(cn ? creditNoteAmount(cn) : comp?.totals.net_payable ?? '0')}</span></p>
        {inv ? <>{money(t('sales.totals.paid'), inv.totals.paid_amount)}{money(t('sales.totals.balanceDue'), inv.totals.balance_due)}</> : null}
      </section>
      <p className="mt-2 text-xs" data-testid="doc-words">{salesPrintWords(doc, lang)}</p>
      {template.footer_text ? <p data-testid="template-footer">{template.footer_text}</p> : null}
      {doc.notes.map((n) => <p key={n} className="mt-1 text-xs">{n}</p>)}
      <footer className="mt-3 border-t border-border pt-1 text-[0.65rem] text-muted-foreground">{t('sales.print.footer', { no: toNumerals(String(doc.print_no), numerals), at: toNumerals(formatDateTimeIN(doc.printed_at), numerals) })}</footer>
    </article>
  );
}

