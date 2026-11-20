import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams, useSearch } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Check, Field, Select } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Loading } from '@/components/page';
import { useT, useTk } from '@/i18n';
import { formatDateIN, formatDateTimeIN, formatINR } from '@/lib/format';
import { useAttemptKey } from '@/lib/api/attempt-key';
import { useOnline } from '@/lib/offline/connectivity';
import { useCan, useSignedIn } from '@/lib/session';
import { SALES } from '@/lib/permissions';
import type { CreditNote, RefundMode, PaymentReceipt, Invoice, RestockTarget, TenderInput, ReturnRefundMode, SalesSettings } from '@/lib/api/backend/model';
import { salesApi, salesKeys } from './api';
import {
  CN_REASON_MAX, CN_REASON_MIN, defaultRefundMode, isPositive, returnableLines, returnLastDay, returnWindowOpen, tenderCheck, textBetween, todayIst,
  toTenderInput, type DraftTender,
} from './logic';
import { InvoicePrintLog, PrintHistory, PrintPanel } from './print';
import { useInvRefs } from '@/features/inventory/hooks';
import { newTender, TenderEditor } from './tenders';
import { BillTotalsPanel, GstBreakup, PricedLinesTable } from './totals';
import { InvoiceStatusBadge, Money, PaymentBadge, Row, SalesError, SalesPage } from './ui';

export function InvoicePage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const s = useSearch({ strict: false }) as { print?: boolean };
  // Ratchet 0.9.6 minor: with no active platform print template, settings answer 422 print_template_not_renderable. The bill still
  // renders; only its print card says printing is unavailable (no page-wide "nothing was printed" message).
  return <SalesPage title="sales.invoice.title" printBlocked={(error) => <InvoiceDetail id={id} settings={null} printError={error} printNow={false} />}>
    {(settings) => <InvoiceDetail id={id} settings={settings} printNow={!!s.print} />}
  </SalesPage>;
}

/** `settings` null = Sales settings unavailable because printing is blocked (`printError`); every non-print part still renders. */
function InvoiceDetail({ id, settings, printNow, printError }: { id: string; settings: SalesSettings | null; printNow: boolean; printError?: unknown }) {
  const t = useT();
  const can = useCan();
  const signedIn = useSignedIn();
  const q = useQuery({ queryKey: salesKeys.invoice(id), queryFn: () => salesApi.invoice(id), enabled: signedIn, retry: false });
  if (q.error) return <SalesError error={q.error} />;
  if (!q.data) return <Loading />;
  const inv = q.data;
  const cancelled = inv.status === 'cancelled';
  return (
    <div className="space-y-4" data-testid="invoice-detail">
      <div className="flex flex-wrap items-center gap-3 print:hidden">
        <h2 lang="en" className="font-mono text-2xl font-semibold" data-testid="invoice-no">{inv.doc_no}</h2>
        <InvoiceStatusBadge status={inv.status} /><PaymentBadge status={inv.payment_status} />
        <span className="text-sm text-muted-foreground">{formatDateTimeIN(inv.issued_at)}</span>
      </div>
      <PrintHistory count={inv.print_count} last={inv.last_printed_at} />
      <InvoicePrintLog id={inv.id} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_24rem] print:hidden">
        <div className="space-y-4">
          <Card><CardContent className="space-y-1 pt-4 text-sm">
            <Row label={t('sales.customer.label')}><span>{inv.customer.name}{inv.customer.phone ? <span lang="en" className="ml-2 font-mono text-muted-foreground">{inv.customer.phone}</span> : null}</span></Row>
            {inv.customer.pan_last4 ? <Row label={t('sales.pan.short')}><span lang="en" className="font-mono">{`••••${inv.customer.pan_last4}`}</span></Row> : null}
            {inv.zero_gst ? <Row label={t('sales.zeroGst.label')}>{inv.zero_gst_reason ?? ''}</Row> : null}
          </CardContent></Card>
          <Card><CardContent className="pt-4">
            <PricedLinesTable lines={inv.lines} oldMetal={inv.old_metal} testId="invoice-lines" />
          </CardContent></Card>
          <Card><CardContent className="pt-4"><GstBreakup c={inv} /></CardContent></Card>
          <Receipts inv={inv} settings={settings ?? undefined} printBlocked={!settings} />
        </div>
        <aside className="space-y-4">
          <Card><CardContent className="space-y-2 pt-4">
            <BillTotalsPanel c={inv} />
            <Row label={t('sales.totals.paid')} testId="paid"><Money v={inv.totals.paid_amount} /></Row>
            <Row label={t('sales.totals.balanceDue')} strong testId="balance"><Money v={inv.totals.balance_due} /></Row>
          </CardContent></Card>
          {!cancelled && isPositive(inv.totals.balance_due) && can(SALES.paymentReceive) ? <PayBalance inv={inv} /> : null}
        </aside>
      </div>
      <Card>
        <CardHeader className="print:hidden"><CardTitle>{t('sales.print.title')}</CardTitle></CardHeader>
        <CardContent>
          {cancelled ? <p className="mb-2 text-sm text-muted-foreground print:hidden">{t('sales.print.cancelledNote')}</p> : null}
          {settings ? <PrintPanel doc="invoice" id={inv.id} printCount={inv.print_count} cancelled={cancelled} defaultPaper={settings.default_paper} defaultLanguage={settings.print_language} defaultNumerals={settings.print_numerals} autoFocus={printNow} />
            : <PrintUnavailable error={printError} />}
        </CardContent>
      </Card>
      {!cancelled && !settings ? <p role="note" className="text-sm text-muted-foreground print:hidden" data-testid="invoice-settings-unavailable">{t('sales.invoice.settingsUnavailable')}</p> : null}
      {!cancelled && settings ? (
        <div className="grid gap-4 md:grid-cols-2 print:hidden">
          {can(SALES.returnIssue) ? <ReturnForm inv={inv} settings={settings} /> : null}
          {can(SALES.cancel) ? <CancelForm inv={inv} settings={settings} /> : null}
        </div>
      ) : null}
      {inv.credit_note_ids.length ? (
        <p className="text-sm print:hidden">{t('sales.invoice.creditNotes')}{' '}
          {inv.credit_note_ids.map((c) => <Link key={c} className="mr-2 underline" to="/sales/credit-notes/$id" params={{ id: c }}>{t('sales.invoice.openCreditNote')}</Link>)}</p>
      ) : null}
    </div>
  );
}

export function Receipts({ inv, settings, printBlocked = false }: { inv: Invoice; settings?: SalesSettings; printBlocked?: boolean }) {
  const t = useT();
  const tk = useTk();
  const signedIn = useSignedIn();
  const can = useCan();
  const [returnedCredit, setReturnedCredit] = useState<CreditNote | null>(null);
  const q = useQuery({ queryKey: salesKeys.payments(inv.id), queryFn: () => salesApi.payments(inv.id), enabled: signedIn, retry: false });
  return (
    <Card>
      <CardHeader><CardTitle>{t('sales.receipts.title')}</CardTitle></CardHeader>
      <CardContent className="text-sm">
        {inv.payments.length ? (
          <ul className="mb-2" data-testid="bill-tenders">{inv.payments.map((p) => <li key={p.line_no} className="flex justify-between"><span>{tk(`sales.tender.${p.mode}`)}{p.reference ? <span lang="en" className="ml-1 font-mono text-muted-foreground">{p.reference}</span> : null}</span><Money v={p.amount} /></li>)}</ul>
        ) : <p className="text-muted-foreground">{t('sales.receipts.noneAtBill')}</p>}
        <SalesError error={q.error} />
        {(q.data?.receipts ?? []).map((r) => (
          <div key={r.id} className="border-t border-border py-1" data-testid="receipt">
            <p className="flex justify-between"><span lang="en" className="font-mono">{r.receipt_no}</span><span>{formatDateIN(r.received_on)}</span><Money v={r.total} /></p>
            <p className="text-xs text-muted-foreground">{r.tenders.map((x) => `${tk(`sales.tender.${x.mode}`)} ${formatINR(x.amount)}`).join(' · ')}</p>
            <p className="text-xs text-muted-foreground" data-testid="receipt-adjusted-balance">{t('sales.receipts.adjustedBalance', { amount: formatINR(r.adjusted_balance_due_after) })}</p>
            {r.reverses_receipt_id ? <p className="text-sm">{t('sales.creditNote.kind.receipt_reversal')} · <span lang="en" className="font-mono">{r.reverses_receipt_id}</span> · {r.reversal_reason}</p> : null}
            {can('sales.invoice.view') && !printBlocked ? <ReceiptPrintAction invoiceId={inv.id} receipt={r} settings={settings}/> : null}
            {r.reversed_by_receipt_id ? <p role="note">{t('sales.reversal.already')}</p> : null}
            {can(SALES.receiptReverse) && inv.status !== 'cancelled' && !r.reverses_receipt_id && !r.reversed_by_receipt_id ? <ReversePayment invoiceId={inv.id} receipt={r} onReversed={setReturnedCredit} /> : null}
          </div>
        ))}
        {returnedCredit ? <p data-testid="returned-store-credit"><Link className="underline" to="/sales/credit-notes/$id" params={{ id: returnedCredit.id }}>{t('sales.reversal.credit', { no: returnedCredit.doc_no, amount: formatINR(returnedCredit.store_credit_amount) })}</Link></p> : null}
      </CardContent>
    </Card>
  );
}

/**
 * 0.9.5 has POST receipt prints but no receipt print-count/history GET; never invent a history.
 * Next release (Adithya, live): the preview opens as a modal Dialog (in view, focus inside, Esc / close returns focus to this button).
 * It is still the <body> child `receipt-print-preview` that print095.css isolates (B-1: one page per receipt, no Letter page).
 */
export function ReceiptPrintAction({invoiceId,receipt,settings}:{invoiceId:string;receipt:PaymentReceipt;settings?:SalesSettings}) {
  const t=useT(); const [open,setOpen]=useState(false); const trigger=useRef<HTMLButtonElement>(null);
  return <div className="mt-2" data-testid="receipt-print-action">
    <Button ref={trigger} type="button" className="print:hidden" size="sm" variant="outline" aria-haspopup="dialog" aria-expanded={open} onClick={()=>setOpen(true)}>{t('sales.print.receiptAction')}</Button>
    <Dialog open={open} onClose={()=>setOpen(false)} returnFocus={trigger} overlayTestId="receipt-print-preview" panelTestId="receipt-print-dialog"
      title={<>{t('sales.print.receiptDialogTitle')} <span lang="en" className="font-mono">{receipt.receipt_no}</span></>} closeLabel={t('common.close')}>
      <PrintPanel doc="payment_receipt" id={receipt.id} invoiceId={invoiceId} printCount={undefined} defaultPaper={settings?.default_paper} defaultLanguage={settings?.print_language} defaultNumerals={settings?.print_numerals}/>
    </Dialog>
  </div>;
}

/** Print card body while no platform print template is active: the bill is fine, only printing is unavailable. */
function PrintUnavailable({ error }: { error: unknown }) {
  const t = useT();
  return <div className="space-y-1 print:hidden" data-testid="print-unavailable">
    <p role="alert" className="rounded-md border border-destructive bg-destructive/10 p-2 text-sm text-destructive">{t('sales.print.unavailable')}</p>
    {error ? <p className="text-xs text-muted-foreground">{t('sales.print.unavailableHint')}</p> : null}
  </div>;
}

/** A receipt is reversed at most once; the server restores balance and returns any store credit as a NEW note. */
export function ReversePayment({ invoiceId, receipt, onReversed }: { invoiceId: string; receipt: PaymentReceipt; onReversed?: (note: CreditNote) => void }) {
  const t = useT(); const qc = useQueryClient(); const online = useOnline(); const key = useAttemptKey();
  const [open, setOpen] = useState(false); const [reason, setReason] = useState('');
  const run = useMutation({
    mutationFn: () => salesApi.reversePayment(invoiceId, receipt.id, { reason: reason.trim() }, key.take()),
    onSuccess: (d) => {
      key.reset(); setOpen(false); setReason('');
      if (d.store_credit_note) { qc.setQueryData(salesKeys.creditNote(d.store_credit_note.id), d.store_credit_note); onReversed?.(d.store_credit_note); }
      void qc.invalidateQueries({ queryKey: salesKeys.invoice(invoiceId) });
      void qc.invalidateQueries({ queryKey: ['sales', 'invoices'] });
      void qc.invalidateQueries({ queryKey: ['sales', 'credit-notes'] });
    }, onError: key.settle,
  });
  return <div className="mt-2 space-y-2 print:hidden" data-testid="reverse-payment">
    {!run.isSuccess ? <Button type="button" variant="outline" size="sm" disabled={!online || run.isPending} onClick={() => setOpen(!open)}>{t('sales.reversal.open')}</Button> : <p role="status">{t('sales.reversal.done')}</p>}
    {open ? <div className="space-y-2 rounded border border-border p-3">
      <Field label={t('sales.reversal.reason')} hint={t('sales.reversal.reasonHint')}>{(id, d) => <Input id={id} aria-describedby={d} maxLength={200} value={reason} onChange={(e) => { setReason(e.target.value); key.reset(); }} />}</Field>
      <Button type="button" data-testid="reverse-confirm" disabled={!online || !textBetween(reason, 5, 200) || run.isPending} onClick={() => {
        if (window.confirm(t('sales.reversal.confirm', { no: receipt.receipt_no, amount: formatINR(receipt.total) }))) run.mutate();
      }}>{t('sales.reversal.open')}</Button>
    </div> : null}
    <SalesError error={run.error} />
    {!onReversed && run.data?.store_credit_note ? <p data-testid="reversal-credit"><Link className="underline" to="/sales/credit-notes/$id" params={{ id: run.data.store_credit_note.id }}>{t('sales.reversal.credit', { no: run.data.store_credit_note.doc_no, amount: formatINR(run.data.store_credit_note.store_credit_amount) })}</Link></p> : null}
  </div>;
}

/** Later payment(s) against the balance: POST /invoices/{id}/payments (Idempotency-Key). 422 overpayment, 409 invoice_cancelled / invoice_fully_paid. */
export function PayBalance({ inv }: { inv: Invoice }) {
  const t = useT();
  const qc = useQueryClient();
  const online = useOnline();
  const key = useAttemptKey();
  const [tenders, setTenders] = useState<DraftTender[]>(() => [newTender('cash', inv.totals.balance_due)]);
  const check = tenderCheck(tenders, inv.totals.balance_due);
  const pay = useMutation({
    mutationFn: () => salesApi.receivePayment(inv.id, { tenders: tenders.map(toTenderInput).filter((x): x is TenderInput => !!x) }, key.take()),
    onSuccess: () => { key.reset(); void qc.invalidateQueries({ queryKey: salesKeys.invoice(inv.id) }); void qc.invalidateQueries({ queryKey: ['sales', 'invoices'] }); setTenders([newTender('cash')]); },
    onError: key.settle,
  });
  return (
    <Card data-testid="pay-balance">
      <CardContent className="space-y-2 pt-4">
        <TenderEditor tenders={tenders} due={inv.totals.balance_due} customerId={inv.customer.customer_id} onChange={(x) => { setTenders(x); key.reset(); }} label={t('sales.pay.balanceTitle')} />
        <SalesError error={pay.error} />
        <Button className="w-full" data-testid="receive-button" disabled={!online || !check.ok || !isPositive(check.total) || pay.isPending} onClick={() => pay.mutate()}>{t('sales.pay.receive', { amount: formatINR(check.total) })}</Button>
      </CardContent>
    </Card>
  );
}

const CANCEL_MODES: RefundMode[] = ['store_credit', 'cash', 'bank_transfer', 'reversal'];
const RETURN_MODES: ReturnRefundMode[] = ['store_credit', 'cash', 'bank_transfer'];

/** Cancel the whole bill: a cancellation credit note (reason 5–500, how the money goes back). */
export function CancelForm({ inv, settings }: { inv: Invoice; settings: Pick<SalesSettings, 'return_settlement_default'> }) {
  const t = useT();
  const tk = useTk();
  const qc = useQueryClient();
  const online = useOnline();
  const key = useAttemptKey();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [mode, setMode] = useState<RefundMode>(isPositive(inv.totals.paid_amount) ? defaultRefundMode(settings) : 'reversal');
  const [restock, setRestock] = useState<RestockTarget>({});
  const run = useMutation({
    mutationFn: () => salesApi.cancel(inv.id, { reason: reason.trim(), refund_mode: mode, ...restockField(restock) }, key.take()),
    onSuccess: () => { key.reset(); setOpen(false); void qc.invalidateQueries({ queryKey: salesKeys.all }); },
    onError: key.settle,
  });
  return (
    <Card data-testid="cancel-form">
      <CardHeader><CardTitle>{t('sales.cancel.title')}</CardTitle></CardHeader>
      <CardContent className="space-y-2">
        {!open ? <Button variant="outline" onClick={() => setOpen(true)}>{t('sales.cancel.open')}</Button> : (
          <>
            <p className="text-sm text-muted-foreground">{t('sales.cancel.explain')}</p>
            <Field label={t('sales.cancel.reason')} hint={t('sales.reasonHint', { min: CN_REASON_MIN, max: CN_REASON_MAX })}>{(id, d) => (
              <Input id={id} aria-describedby={d} maxLength={CN_REASON_MAX} value={reason} onChange={(e) => { setReason(e.target.value); key.reset(); }} />)}</Field>
            <Field label={t('sales.refund.mode')}>{(id) => (
              <Select id={id} value={mode} onChange={(e) => setMode(e.target.value as RefundMode)}>
                {CANCEL_MODES.map((m) => <option key={m} value={m}>{tk(`sales.refund.${m}`)}</option>)}
              </Select>)}</Field>
            <RestockPicker branchId={inv.branch_id} value={restock} onChange={(r) => { setRestock(r); key.reset(); }} />
            <SalesError error={run.error} />
            <div className="flex gap-2">
              <Button variant="destructive" data-testid="cancel-confirm" disabled={!online || !textBetween(reason, CN_REASON_MIN, CN_REASON_MAX) || run.isPending} onClick={() => run.mutate()}>{t('sales.cancel.confirm', { no: inv.doc_no })}</Button>
              <Button variant="ghost" onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** Return whole lines (POST /returns line_ids): pick lines, reason 5–500, refund mode; the window is a hint (server: 422 return_window_expired). */
export function ReturnForm({ inv, settings }: { inv: Invoice; settings: Pick<SalesSettings, 'return_settlement_default' | 'return_window_days'> }) {
  const t = useT();
  const tk = useTk();
  const qc = useQueryClient();
  const online = useOnline();
  const key = useAttemptKey();
  const lines = returnableLines(inv);
  const [pick, setPick] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [mode, setMode] = useState<ReturnRefundMode>(defaultRefundMode(settings));
  const [restock, setRestock] = useState<RestockTarget>({});
  const lastDay = returnLastDay(inv.doc_date, settings.return_window_days);
  const open = returnWindowOpen(inv.doc_date, settings.return_window_days, todayIst());
  const run = useMutation({
    mutationFn: () => salesApi.returnLines(inv.id, { line_ids: pick, reason: reason.trim(), refund_mode: mode, ...restockField(restock) }, key.take()),
    onSuccess: () => { key.reset(); setPick([]); setReason(''); void qc.invalidateQueries({ queryKey: salesKeys.all }); },
    onError: key.settle,
  });
  if (!lines.length) return null;
  return (
    <Card data-testid="return-form">
      <CardHeader><CardTitle>{t('sales.return.title')}</CardTitle></CardHeader>
      <CardContent className="space-y-2">
        <p className="text-sm text-muted-foreground" data-testid="return-window">{open ? t('sales.return.until', { date: formatDateIN(lastDay) }) : t('sales.return.closed', { date: formatDateIN(lastDay) })}</p>
        {lines.map((l) => (
          <Check key={l.id} label={`${l.tag_no ?? ''} ${l.description} · ${formatINR(l.line_total)}`.trim()} checked={pick.includes(l.id)}
            onChange={(on) => { setPick(on ? [...pick, l.id] : pick.filter((x) => x !== l.id)); key.reset(); }} />
        ))}
        <Field label={t('sales.return.reason')} hint={t('sales.reasonHint', { min: CN_REASON_MIN, max: CN_REASON_MAX })}>{(id, d) => (
          <Input id={id} aria-describedby={d} maxLength={CN_REASON_MAX} value={reason} onChange={(e) => { setReason(e.target.value); key.reset(); }} />)}</Field>
        <Field label={t('sales.refund.mode')}>{(id) => (
          <Select id={id} value={mode} onChange={(e) => setMode(e.target.value as ReturnRefundMode)}>
            {RETURN_MODES.map((m) => <option key={m} value={m}>{tk(`sales.refund.${m}`)}</option>)}
          </Select>)}</Field>
        <RestockPicker branchId={inv.branch_id} value={restock} onChange={(r) => { setRestock(r); key.reset(); }} />
        <SalesError error={run.error} />
        <Button data-testid="return-confirm" disabled={!online || !pick.length || !textBetween(reason, CN_REASON_MIN, CN_REASON_MAX) || run.isPending} onClick={() => run.mutate()}>{t('sales.return.confirm', { n: pick.length })}</Button>
      </CardContent>
    </Card>
  );
}

/** Restock target (0.9.1 RestockTarget): empty = back to the counter / tray each piece was sold from (server default). */
export function RestockPicker({ branchId, value, onChange }: { branchId: string; value: RestockTarget; onChange: (r: RestockTarget) => void }) {
  const t = useT();
  const refs = useInvRefs();
  const counters = refs.counters.filter((c) => c.branch_id === branchId && c.is_active !== false);
  const trays = refs.trays.filter((x) => x.counter_id === value.counter_id && x.is_active !== false);
  return (
    <div className="grid gap-2 sm:grid-cols-2" data-testid="restock">
      <Field label={t('sales.restock.counter')} hint={t('sales.restock.hint')}>{(id, d) => (
        <Select id={id} aria-describedby={d} value={value.counter_id ?? ''} onChange={(e) => onChange(e.target.value ? { counter_id: e.target.value } : {})}>
          <option value="">{t('sales.restock.original')}</option>
          {counters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>)}</Field>
      <Field label={t('sales.restock.tray')}>{(id) => (
        <Select id={id} value={value.tray_id ?? ''} disabled={!value.counter_id} onChange={(e) => onChange({ counter_id: value.counter_id, ...(e.target.value ? { tray_id: e.target.value } : {}) })}>
          <option value="">{t('sales.restock.anyTray')}</option>
          {trays.map((x) => <option key={x.id} value={x.id}>{x.name || x.code}</option>)}
        </Select>)}</Field>
    </div>
  );
}
/** Request field: restock only when a counter was picked. */
export const restockField = (r: RestockTarget): { restock?: RestockTarget } => (r.counter_id ? { restock: { counter_id: r.counter_id, ...(r.tray_id ? { tray_id: r.tray_id } : {}) } } : {});
