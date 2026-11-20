/** Final 0.9.5 wire adapter/renderer for the prepared receipt-v1 family.
 * Frozen 0.9.4 projection/renderer remains byte-identical; this completes its previously unwired contract boundary.
 */
import { IntlProvider } from 'react-intl';
import type { PaymentReceiptPrintSnapshot, SalesPrintDocument } from '@/lib/api/backend/model';
import { useT, useTk } from '@/i18n';
import { formatDateIN, formatDateTimeIN, formatINR } from '@/lib/format';
import { toNumerals } from '@/lib/format/numerals';
import { PRINT_FONT } from '@/lib/fonts';
import { salesPrintDataError as legacyDataError, printPresentation } from './print-data';
import { salesPrintMessages } from './print-messages';
import { resolveBundledPin } from './templates';
import en from './receipt095.en-IN.v1.json';
import ta from './receipt095.ta-IN.v1.json';
export const receipt095Messages = (language: 'en'|'ta') => ({...salesPrintMessages(language),...(language==='ta'?ta:en)});
export function receiptSnapshot095(doc: SalesPrintDocument): PaymentReceiptPrintSnapshot | null {
  const s=doc.snapshot;
  return doc.doc_type==='payment_receipt' && s && 'receipt_no' in s && 'adjusted_balance_due_at_issue' in s ? s : null;
}
export function salesPrintDataError095(doc: SalesPrintDocument) {
  if(doc.doc_type!=='payment_receipt') return legacyDataError(doc);
  if(doc.language!=='en' && doc.language!=='ta') return 'print_language_not_supported';
  if(doc.locale!==`${doc.language}-IN`) return 'print_snapshot_invalid';
  if(!['latin','devanagari','tamil','telugu','kannada','malayalam'].includes(doc.numerals)) return 'print_numerals_not_supported';
  if(!doc.amount_in_words?.trim()) return 'print_words_unavailable';
  try { const r=resolveBundledPin({...doc,doc_type:'receipt'});if(r.renderer!=='receipt-v1')return 'pinned_print_template_unavailable'; }catch{return 'pinned_print_template_unavailable';}
  const s=receiptSnapshot095(doc);
  if(!s || s.id!==doc.doc_id || s.receipt_no!==doc.doc_no || !s.invoice_no || !s.invoice_date || !s.received_on || !s.received_at || !s.seller?.legal_name || !s.customer?.name || !Array.isArray(s.tenders) || !/^-?\d+\.\d{2}$/.test(s.total) || !/^\d+\.\d{2}$/.test(s.adjusted_balance_due_at_issue)) return 'receipt_print_snapshot_missing';
  if(doc.doc_cancelled!==false || !['original','duplicate'].includes(doc.copy) || !Number.isInteger(doc.print_no) || doc.print_no<1 || (doc.print_no===1 ? doc.copy!=='original' : doc.copy!=='duplicate'))return 'print_snapshot_invalid';
  if(s.kind==='reversal') {
    if(doc.stamp!=='REVERSAL' || !s.total.startsWith('-') || s.tenders.length || !s.reverses_receipt_id || !s.reversal_reason) return 'print_snapshot_invalid';
  } else if(s.kind!=='collection' || s.total.startsWith('-') || ![doc.copy==='duplicate'?'DUPLICATE':null,'REVERSED'].includes(doc.stamp)) return 'print_snapshot_invalid';
  return null;
}
export function ReceiptPrint095V1({doc}:{doc:SalesPrintDocument}) {
  const t=useT(); const error=salesPrintDataError095(doc);
  if(error)return <p role="alert" data-testid="print-data-error">{t(`error.${error}`)}</p>;
  return <IntlProvider locale={doc.locale} messages={receipt095Messages(doc.language)} defaultLocale="en-IN"><Receipt095Body doc={doc}/></IntlProvider>;
}
function Receipt095Body({doc}:{doc:SalesPrintDocument}) {
  const t=useT(),tk=useTk(),s=receiptSnapshot095(doc) as PaymentReceiptPrintSnapshot,{numerals,fontLanguages}=printPresentation(doc);
  const money=(v:string)=>formatINR(v,{numerals});
  const address=s.seller.address ? [s.seller.address.line1,s.seller.address.line2,s.seller.address.city,s.seller.address.district,s.seller.address.pincode].filter(Boolean).join(', '):'';
  return <article className="sales-doc mx-auto bg-background p-4 text-sm text-foreground" data-testid="receipt-doc" data-paper={doc.paper} data-locale={doc.locale} data-template-id={doc.template_id} data-template-version={doc.template_version} data-template-renderer="receipt-v1" lang={doc.language} style={{fontFamily:fontLanguages.map((l)=>PRINT_FONT[l].split(',')[0]).join(', ')+', sans-serif'}}>
    <header className="space-y-1 border-b border-border pb-2"><h1 className="font-semibold">{s.seller.legal_name}</h1>{address?<p>{address}</p>:null}{s.seller.gstin?<p lang="en" className="font-mono">{t('sales.print.gstin')} {s.seller.gstin}</p>:null}<h2>{t('sales.print.receipt')}</h2><p data-testid="receipt-no" lang="en" className="font-mono">{doc.doc_no}</p><p>{formatDateIN(s.received_on,numerals)}</p><p>{toNumerals(formatDateTimeIN(s.received_at),numerals)}</p><p data-testid="receipt-copy">{t(doc.copy==='original'?'sales.print.original':'sales.print.duplicate')}</p></header>
    {doc.stamp?<p data-testid="receipt-stamp" className="border-2 border-destructive p-1 font-bold text-destructive">{tk(`sales.print.stamp.${doc.stamp}`)}</p>:null}
    <p>{t('sales.print.receiptNotTaxInvoice')}</p><p data-testid="receipt-invoice">{t('sales.print.receiptReference',{no:s.invoice_no,date:formatDateIN(s.invoice_date,numerals)})}</p>
    <p>{s.customer.name}{s.customer.gstin?<span lang="en" className="font-mono"> · {s.customer.gstin}</span>:null}</p>
    {s.kind==='reversal'?<p data-testid="receipt-no-collection">{t('sales.print.receiptNoCollection')}</p>:<table className="mt-2 w-full"><tbody>{s.tenders.map((x)=><tr key={x.line_no}><td>{tk(`sales.tender.${x.mode}`)}{x.reference?<p lang="en" className="font-mono">{x.reference}</p>:null}</td><td className="text-right tabular-nums">{money(x.amount)}</td></tr>)}</tbody></table>}
    <p data-testid="receipt-total" className="flex justify-between font-semibold"><span>{t(s.kind==='reversal'?'sales.print.receiptReversedAmount':'sales.print.received')}</span><span>{money(s.total)}</span></p>
    <p data-testid="receipt-balance">{t('sales.print.receiptBalanceAtIssue',{amount:money(s.adjusted_balance_due_at_issue)})}</p><p data-testid="receipt-words">{doc.amount_in_words}</p>
    {s.reverses_receipt_id?<p lang="en" className="font-mono">{s.reverses_receipt_id}</p>:null}{s.reversal_reason?<p>{s.reversal_reason}</p>:null}{s.note?<p>{s.note}</p>:null}{doc.notes.map((n,i)=><p key={i}>{n}</p>)}
    <footer className="mt-2 border-t border-border text-xs">{t('sales.print.footer',{no:toNumerals(String(doc.print_no),numerals),at:toNumerals(formatDateTimeIN(doc.printed_at),numerals)})}</footer>
  </article>;
}
