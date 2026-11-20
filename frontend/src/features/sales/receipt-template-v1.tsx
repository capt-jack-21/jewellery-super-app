/** Bundled immutable receipt-v1. Isolated adapter: NOT wired to any API until the final 0.9.5 schema is verified. */
import { IntlProvider } from 'react-intl';
import { useT, useTk } from '@/i18n';
import type { CustomerSnapshot, PaymentReceipt, SalesPaperFormat, SellerSnapshot } from '@/lib/api/backend/model';
import { formatDateIN, formatDateTimeIN, formatINR } from '@/lib/format';
import { toNumerals } from '@/lib/format/numerals';
import { PRINT_FONT } from '@/lib/fonts';
import { resolveBundledPin, validTemplatePin } from './templates';
import { printPresentation } from './print-data';
import { salesPrintMessages } from './print-messages';

/** Local render projection only. Map from the FINAL receipt payload once 0.9.5 lands; never join live masters. */
export interface ReceiptPrintProjectionV1 {
  doc_type: 'receipt'; doc_id: string; doc_no: string; template_id: string; template_version: number;
  paper: SalesPaperFormat; language: 'en' | 'ta'; locale: 'en-IN' | 'ta-IN'; numerals: 'latin' | 'tamil';
  printed_at: string; print_no: number; copy: 'original' | 'duplicate'; stamp: 'DUPLICATE' | null;
  amount_in_words: string; notes: string[];
  snapshot: { seller: SellerSnapshot; customer: CustomerSnapshot | null; invoice: { doc_no: string; doc_date: string }; receipt: PaymentReceipt };
}
export function ReceiptPrintTemplateV1({ doc }: { doc: ReceiptPrintProjectionV1 }) {
  const t = useT();
  try { resolveBundledPin(doc); }
  catch { return <p role="alert">{t('error.pinned_print_template_unavailable')}</p>; }
  const s = doc.snapshot, r = s?.receipt;
  if (!validTemplatePin(doc) || !['original','duplicate'].includes(doc.copy) || !['en','ta'].includes(doc.language) || doc.locale !== `${doc.language}-IN` || !['latin','tamil'].includes(doc.numerals) ||
      !s?.seller?.legal_name || !r || r.id !== doc.doc_id || r.receipt_no !== doc.doc_no || r.invoice_no !== s.invoice?.doc_no ||
      !s.invoice.doc_date || !r.received_on || !Array.isArray(r.tenders) || !r.total || !r.adjusted_balance_due_after ||
      !doc.amount_in_words?.trim() || doc.stamp !== (doc.copy === 'duplicate' ? 'DUPLICATE' : null)) return <p role="alert">{t('error.print_snapshot_invalid')}</p>;
  return <IntlProvider locale={doc.locale} messages={salesPrintMessages(doc.language)} defaultLocale="en-IN"><ReceiptBody doc={doc} /></IntlProvider>;
}
function ReceiptBody({ doc }: { doc: ReceiptPrintProjectionV1 }) {
  const t=useT(),tk=useTk(),{numerals,fontLanguages}=printPresentation(doc),s=doc.snapshot,r=s.receipt;
  const money=(v:string)=>formatINR(v,{numerals});
  const address=s.seller.address ? [s.seller.address.line1,s.seller.address.line2,s.seller.address.city,s.seller.address.district,s.seller.address.pincode].filter(Boolean).join(', ') : '';
  return <article className="sales-doc mx-auto bg-background p-4 text-sm text-foreground" data-testid="receipt-doc" data-paper={doc.paper} data-template-id={doc.template_id} data-template-version={doc.template_version} data-template-renderer="receipt-v1" lang={doc.language} style={{fontFamily:fontLanguages.map((l)=>PRINT_FONT[l].split(',')[0]).join(', ')+', sans-serif'}}>
    <header className="space-y-1 border-b border-border pb-2"><h1 className="font-semibold">{s.seller.legal_name}</h1>{address ? <p>{address}</p>:null}{s.seller.gstin ? <p lang="en" className="font-mono">{t('sales.print.gstin')} {s.seller.gstin}</p>:null}<h2>{t('sales.print.receipt')}</h2><p data-testid="receipt-no" lang="en" className="font-mono">{doc.doc_no}</p><p>{formatDateIN(r.received_on,numerals)}</p><p>{t(doc.copy==='original'?'sales.print.original':'sales.print.duplicate')}</p></header>
    {doc.stamp ? <p data-testid="receipt-stamp" className="border-2 border-destructive p-1 font-bold text-destructive">{t('sales.print.stamp.DUPLICATE')}</p>:null}
    <p>{t('sales.print.receiptNotTaxInvoice')}</p><p data-testid="receipt-invoice">{t('sales.print.receiptReference',{no:s.invoice.doc_no,date:formatDateIN(s.invoice.doc_date,numerals)})}</p>
    {s.customer ? <p>{s.customer.name}{s.customer.gstin ? <span lang="en" className="font-mono"> · {s.customer.gstin}</span>:null}</p>:null}
    <table className="mt-2 w-full"><tbody>{r.tenders.map((tender)=><tr key={tender.line_no}><td>{tk(`sales.tender.${tender.mode}`)}{tender.reference ? <p lang="en" className="font-mono">{tender.reference}</p>:null}</td><td className="text-right tabular-nums">{money(tender.amount)}</td></tr>)}</tbody></table>
    <p data-testid="receipt-total" className="flex justify-between font-semibold"><span>{t('sales.print.received')}</span><span>{money(r.total)}</span></p>
    <p data-testid="receipt-balance">{t('sales.receipts.adjustedBalance',{amount:money(r.adjusted_balance_due_after)})}</p><p data-testid="receipt-words">{doc.amount_in_words}</p>
    {r.note ? <p>{r.note}</p>:null}{doc.notes.map((note,i)=><p key={i}>{note}</p>)}
    <footer className="mt-2 border-t border-border text-xs">{t('sales.print.footer',{no:toNumerals(String(doc.print_no),numerals),at:toNumerals(formatDateTimeIN(doc.printed_at),numerals)})}</footer>
  </article>;
}
