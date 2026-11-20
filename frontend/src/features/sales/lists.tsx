import { CREDIT_NOTE_KINDS, creditNoteAmount } from './events';
import { useDeferredValue, useState } from 'react';
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Field, Select } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Loading } from '@/components/page';
import { Badge } from '@/components/ui/badge';
import { useT, useTk } from '@/i18n';
import { formatDateIN } from '@/lib/format';
import { useOnline } from '@/lib/offline/connectivity';
import { useCan, useSignedIn } from '@/lib/session';
import { SALES } from '@/lib/permissions';
import type { Estimate, EstimatePageItemsItem, EstimateStatus, ListCreditNotesParams, ListEstimatesParams, ListInvoicesParams, SalesSettings } from '@/lib/api/backend/model';
import { salesApi, salesKeys } from './api';
import { invoiceParams, mergeProblem, MAX_ESTIMATE_MERGE, type InvoiceFilters } from './logic';
import { PrintHistory, PrintPanel } from './print';
import { BillTotalsPanel, GstBreakup, PricedLinesTable } from './totals';
import { InvoiceStatusBadge, Money, PaymentBadge, Row, SalesError, SalesPage } from './ui';

/* ------------------------------------------------------------------ bills ------------------------------------------------------------------ */

export function InvoicesListPage() {
  return <SalesPage title="sales.bills.title" description="sales.bills.description"><InvoicesList /></SalesPage>;
}

const EMPTY: InvoiceFilters = { q: '', tag_no: '', from: '', to: '', status: '', payment_status: '', supply_type: '' };

/** Bill list with the contract filters (q, doc_no, dates, customer, tag, salesperson, status, payment, B2B/B2C), newest first, cursor paging. */
export function InvoicesList() {
  const t = useT();
  const signedIn = useSignedIn();
  const [f, setF] = useState<InvoiceFilters>(EMPTY);
  const df = useDeferredValue(f);
  const params = invoiceParams(df) as ListInvoicesParams;
  const q = useInfiniteQuery({
    queryKey: salesKeys.invoices(params), enabled: signedIn, retry: false, placeholderData: keepPreviousData, initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => salesApi.invoices({ ...params, ...(pageParam ? { cursor: pageParam } : {}) }),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  const rows = q.data?.pages.flatMap((p) => p.items) ?? [];
  const set = (k: keyof InvoiceFilters) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="space-y-3">
      <form className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4" role="search" data-testid="bill-filters" onSubmit={(e) => e.preventDefault()}>
        <Field label={t('sales.filter.q')} className="lg:col-span-2">{(id) => <Input id={id} value={f.q} onChange={set('q')} />}</Field>
        <Field label={t('sales.filter.tag')}>{(id) => <Input id={id} className="font-mono uppercase" value={f.tag_no} onChange={set('tag_no')} />}</Field>
        <Field label={t('sales.filter.from')}>{(id) => <Input id={id} type="date" value={f.from} onChange={set('from')} />}</Field>
        <Field label={t('sales.filter.to')}>{(id) => <Input id={id} type="date" value={f.to} onChange={set('to')} />}</Field>
        <Field label={t('sales.filter.status')}>{(id) => (
          <Select id={id} value={f.status} onChange={set('status')}><option value="">{t('sales.filter.any')}</option><option value="issued">{t('sales.status.issued')}</option><option value="cancelled">{t('sales.status.cancelled')}</option></Select>)}</Field>
        <Field label={t('sales.filter.payment')}>{(id) => (
          <Select id={id} value={f.payment_status} onChange={set('payment_status')}><option value="">{t('sales.filter.any')}</option>
            <option value="paid">{t('sales.payment.paid')}</option><option value="part_paid">{t('sales.payment.part_paid')}</option><option value="unpaid">{t('sales.payment.unpaid')}</option></Select>)}</Field>
        <Field label={t('sales.filter.supply')}>{(id) => (
          <Select id={id} value={f.supply_type} onChange={set('supply_type')}><option value="">{t('sales.filter.any')}</option><option value="b2c">{t('sales.supply.b2c')}</option><option value="b2b">{t('sales.supply.b2b')}</option></Select>)}</Field>
        <div className="flex items-end"><Button type="button" variant="ghost" onClick={() => setF(EMPTY)}>{t('sales.filter.clear')}</Button></div>
      </form>
      <SalesError error={q.error} />
      {q.isLoading ? <Loading /> : rows.length ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm [&_td]:px-2 [&_th]:px-2" data-testid="bill-list">
            <thead className="text-xs text-muted-foreground"><tr className="text-left"><th>{t('sales.bills.no')}</th><th>{t('sales.bills.date')}</th><th>{t('sales.customer.label')}</th>
              <th className="text-right">{t('sales.totals.payable')}</th><th className="text-right">{t('sales.totals.balanceDue')}</th><th>{t('sales.filter.payment')}</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id} className="border-t border-border" data-testid="bill-row">
                <td className="py-2"><Link lang="en" className="font-mono underline" to="/sales/invoices/$id" params={{ id: r.id }}>{r.doc_no}</Link>{r.status === 'cancelled' ? <span className="ml-2"><InvoiceStatusBadge status={r.status} /></span> : null}</td>
                <td className="py-2">{formatDateIN(r.doc_date)}</td>
                <td className="py-2">{r.customer_name}{r.customer_phone ? <span lang="en" className="ml-1 font-mono text-xs text-muted-foreground">{r.customer_phone}</span> : null}</td>
                <td className="py-2 text-right"><Money v={r.net_payable} /></td><td className="py-2 text-right"><Money v={r.balance_due} /></td>
                <td className="py-2"><PaymentBadge status={r.payment_status} /></td>
              </tr>))}</tbody>
          </table>
        </div>
      ) : <p className="text-muted-foreground" data-testid="bill-list-empty">{t('sales.bills.empty')}</p>}
      {q.hasNextPage ? <Button variant="outline" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{t('sales.more')}</Button> : null}
    </div>
  );
}

/* ---------------------------------------------------------------- estimates ---------------------------------------------------------------- */

export function EstimatesListPage() {
  return <SalesPage title="sales.estimates.title" description="sales.estimates.description"><EstimatesList /></SalesPage>;
}

/** Estimates: pick up to 10 open (draft) ones of one customer to turn into a single bill (merge), or open one. */
export function EstimatesList() {
  const t = useT();
  const tk = useTk();
  const can = useCan();
  const navigate = useNavigate();
  const signedIn = useSignedIn();
  const [status, setStatus] = useState<EstimateStatus | ''>('draft');
  const [q, setQ] = useState('');
  const dq = useDeferredValue(q.trim());
  const params: ListEstimatesParams = { ...(status ? { status } : {}), ...(dq ? { q: dq } : {}) };
  const list = useQuery({ queryKey: salesKeys.estimates(params), queryFn: () => salesApi.estimates(params), enabled: signedIn, retry: false, placeholderData: keepPreviousData });
  const [picked, setPicked] = useState<EstimatePageItemsItem[]>([]);
  const problem = mergeProblem(picked);
  const toggle = (e: EstimatePageItemsItem) => setPicked((p) => (p.some((x) => x.id === e.id) ? p.filter((x) => x.id !== e.id) : [...p, e]));
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <Field label={t('sales.filter.q')} className="min-w-64 flex-1">{(id) => <Input id={id} value={q} onChange={(e) => setQ(e.target.value)} />}</Field>
        <Field label={t('sales.filter.status')}>{(id) => (
          <Select id={id} value={status} onChange={(e) => setStatus(e.target.value as EstimateStatus | '')}>
            <option value="">{t('sales.filter.any')}</option>
            {(['draft', 'billed', 'cancelled', 'expired'] as const).map((s) => <option key={s} value={s}>{tk(`sales.estimate.status.${s}`)}</option>)}
          </Select>)}</Field>
        {can(SALES.estimateCreate) ? <Button asChild variant="outline"><Link to="/counter/estimate">{t('sales.nav.newEstimate')}</Link></Button> : null}
      </div>
      <SalesError error={list.error} />
      {list.data?.items.length ? (
        <table className="w-full text-sm [&_td]:px-2 [&_th]:px-2" data-testid="estimate-list">
          <thead className="text-xs text-muted-foreground"><tr className="text-left"><th><span className="sr-only">{t('sales.estimates.pick')}</span></th><th>{t('sales.estimates.no')}</th><th>{t('sales.customer.label')}</th><th>{t('sales.estimates.validUntil')}</th><th className="text-right">{t('sales.totals.payable')}</th><th>{t('sales.filter.status')}</th></tr></thead>
          <tbody>{list.data.items.map((e) => (
            <tr key={e.id} className="border-t border-border" data-testid="estimate-row">
              <td className="py-2">{e.status === 'draft' && can(SALES.issue) ? <input type="checkbox" className="h-5 w-5 accent-primary" aria-label={t('sales.estimates.pickOne', { no: e.estimate_no })} checked={picked.some((x) => x.id === e.id)} onChange={() => toggle(e)} /> : null}</td>
              <td className="py-2"><Link lang="en" className="font-mono underline" to="/sales/estimates/$id" params={{ id: e.id }}>{e.estimate_no}</Link></td>
              <td className="py-2">{e.customer_name ?? '—'}</td><td className="py-2">{formatDateIN(e.valid_until)}</td>
              <td className="py-2 text-right"><Money v={e.net_payable} /></td><td className="py-2"><Badge variant="outline">{tk(`sales.estimate.status.${e.status}`)}</Badge></td>
            </tr>))}</tbody>
        </table>
      ) : list.isLoading ? <Loading /> : <p className="text-muted-foreground">{t('sales.estimates.empty')}</p>}
      {picked.length ? (
        <div className="sticky bottom-2 flex flex-wrap items-center gap-2 rounded-md border border-border bg-background p-2 shadow" data-testid="merge-bar">
          <span className="text-sm">{t('sales.estimates.picked', { n: picked.length, max: MAX_ESTIMATE_MERGE })}</span>
          {problem && problem !== 'none' ? <span role="alert" className="text-sm text-destructive" data-testid="merge-problem">{tk(`sales.estimates.merge.${problem}`)}</span> : null}
          <Button data-testid="convert-button" disabled={!!problem} onClick={() => void navigate({ to: '/counter/bill', search: { estimates: picked.map((x) => x.id).join(',') } })}>{t('sales.estimates.convert', { n: picked.length })}</Button>
          <Button variant="ghost" onClick={() => setPicked([])}>{t('sales.filter.clear')}</Button>
        </div>
      ) : null}
    </div>
  );
}

export function EstimatePage() {
  const { id } = useParams({ strict: false }) as { id: string };
  return <SalesPage title="sales.estimate.title">{(s) => <EstimateDetail id={id} settings={s} />}</SalesPage>;
}

function EstimateDetail({ id, settings }: { id: string; settings: SalesSettings }) {
  const t = useT();
  const tk = useTk();
  const can = useCan();
  const online = useOnline();
  const qc = useQueryClient();
  const signedIn = useSignedIn();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: salesKeys.estimate(id), queryFn: () => salesApi.estimate(id), enabled: signedIn, retry: false });
  const cancel = useMutation({
    mutationFn: (e: Pick<Estimate, 'id' | 'version'>) => salesApi.cancelEstimate(e),
    onSuccess: () => void qc.invalidateQueries({ queryKey: salesKeys.all }),
  });
  if (q.error) return <SalesError error={q.error} />;
  if (!q.data) return <Loading />;
  const e = q.data;
  const open = e.status === 'draft';
  return (
    <div className="space-y-4" data-testid="estimate-detail">
      <div className="flex flex-wrap items-center gap-3 print:hidden">
        <h2 lang="en" className="font-mono text-2xl font-semibold">{e.estimate_no}</h2>
        <Badge variant="outline">{tk(`sales.estimate.status.${e.status}`)}</Badge>
        <span className="text-sm text-muted-foreground">{t('sales.estimates.validUntilOn', { date: formatDateIN(e.valid_until) })}</span>
      </div>
      <PrintHistory count={e.print_count} last={e.last_printed_at} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_24rem] print:hidden">
        <Card><CardContent className="space-y-2 pt-4">
          {e.computation.customer ? <Row label={t('sales.customer.label')}>{e.computation.customer.name}</Row> : null}
          <PricedLinesTable lines={e.computation.lines} oldMetal={e.computation.old_metal} testId="estimate-lines" />
          <div className="border-t border-border pt-2"><GstBreakup c={e.computation} /></div>
          {e.invoice_id ? <p className="text-sm"><Link className="underline" to="/sales/invoices/$id" params={{ id: e.invoice_id }}>{t('sales.estimate.openBill')}</Link></p> : null}
        </CardContent></Card>
        <Card><CardContent className="pt-4"><BillTotalsPanel c={e.computation} /></CardContent></Card>
      </div>
      {open ? (
        <div className="flex flex-wrap gap-2 print:hidden">
          {can(SALES.issue) ? <Button data-testid="estimate-convert" onClick={() => void navigate({ to: '/counter/bill', search: { estimates: e.id } })}>{t('sales.estimates.convert', { n: 1 })}</Button> : null}
          {can(SALES.estimateCreate) ? <Button variant="outline" onClick={() => void navigate({ to: '/counter/estimate', search: { id: e.id } })}>{t('sales.estimate.edit')}</Button> : null}
          {can(SALES.estimateCreate) ? <Button variant="ghost" data-testid="estimate-cancel" disabled={!online || cancel.isPending} onClick={() => cancel.mutate(e)}>{t('sales.estimate.cancel')}</Button> : null}
        </div>
      ) : null}
      <SalesError error={cancel.error} />
      <PrintPanel doc="estimate" id={e.id} printCount={e.print_count} defaultPaper={settings.default_paper} defaultLanguage={settings.print_language} defaultNumerals={settings.print_numerals} />
    </div>
  );
}

/* -------------------------------------------------------------- credit notes -------------------------------------------------------------- */

export function CreditNotesListPage() {
  return <SalesPage title="sales.creditNotes.title" description="sales.creditNotes.description"><CreditNotesList /></SalesPage>;
}

export function CreditNotesList() {
  const t = useT();
  const tk = useTk();
  const signedIn = useSignedIn();
  const [q, setQ] = useState('');
  const dq = useDeferredValue(q.trim());
  const [kind, setKind] = useState('');
  const params: ListCreditNotesParams = { ...(dq ? { q: dq } : {}), ...(kind ? { kind: kind as ListCreditNotesParams['kind'] } : {}) };
  const list = useQuery({ queryKey: salesKeys.creditNotes(params), queryFn: () => salesApi.creditNotes(params), enabled: signedIn, retry: false, placeholderData: keepPreviousData });
  return (
    <div className="space-y-3">
      <Field label={t('sales.filter.q')}>{(id) => <Input id={id} value={q} onChange={(e) => setQ(e.target.value)} />}</Field>
      <SalesError error={list.error} />
      <Field label={t('sales.creditNotes.kind')}>{(id) => <Select id={id} value={kind} onChange={(e) => setKind(e.target.value)}><option value="">{t('sales.filter.any')}</option>{CREDIT_NOTE_KINDS.map((k) => <option key={k} value={k}>{tk(`sales.creditNote.kind.${k}`)}</option>)}</Select>}</Field>
      {list.data?.items.length ? (
        <table className="w-full text-sm [&_td]:px-2 [&_th]:px-2" data-testid="credit-note-list">
          <thead className="text-xs text-muted-foreground"><tr className="text-left"><th>{t('sales.creditNotes.no')}</th><th>{t('sales.bills.date')}</th><th>{t('sales.creditNotes.bill')}</th><th>{t('sales.creditNotes.kind')}</th><th className="text-right">{t('sales.creditNotes.total')}</th><th className="text-right">{t('sales.creditNotes.balance')}</th></tr></thead>
          <tbody>{list.data.items.map((c) => (
            <tr key={c.id} className="border-t border-border">
              <td className="py-2"><Link lang="en" className="font-mono underline" to="/sales/credit-notes/$id" params={{ id: c.id }}>{c.doc_no}</Link></td>
              <td className="py-2">{formatDateIN(c.doc_date)}</td><td lang="en" className="py-2 font-mono">{c.invoice_no}</td><td className="py-2">{tk(`sales.creditNote.kind.${c.kind}`)}</td>
              <td className="py-2 text-right"><Money v={creditNoteAmount(c)} /></td><td className="py-2 text-right"><Money v={c.balance_available} /></td>
            </tr>))}</tbody>
        </table>
      ) : list.isLoading ? <Loading /> : <p className="text-muted-foreground">{t('sales.creditNotes.empty')}</p>}
    </div>
  );
}

export function CreditNotePage() {
  const { id } = useParams({ strict: false }) as { id: string };
  return <SalesPage title="sales.creditNote.title">{(s) => <CreditNoteDetail id={id} settings={s} />}</SalesPage>;
}

function CreditNoteDetail({ id, settings }: { id: string; settings: SalesSettings }) {
  const t = useT();
  const tk = useTk();
  const signedIn = useSignedIn();
  const q = useQuery({ queryKey: salesKeys.creditNote(id), queryFn: () => salesApi.creditNote(id), enabled: signedIn, retry: false });
  if (q.error) return <SalesError error={q.error} />;
  if (!q.data) return <Loading />;
  const c = q.data;
  return (
    <div className="space-y-4" data-testid="credit-note-detail">
      <Card className="print:hidden"><CardContent className="space-y-1 pt-4 text-sm">
        <Row label={t('sales.creditNotes.no')}><span lang="en" className="font-mono">{c.doc_no}</span></Row>
        <Row label={t('sales.creditNotes.bill')}><Link lang="en" className="font-mono underline" to="/sales/invoices/$id" params={{ id: c.invoice_id }}>{c.invoice_no}</Link></Row>
        <Row label={t('sales.creditNotes.kind')}>{tk(`sales.creditNote.kind.${c.kind}`)}</Row>
        <Row label={t('sales.cancel.reason')}>{c.reason}</Row>
        {c.kind === 'receipt_reversal' ? <p role="note" data-testid="reversal-note">{t('sales.reversal.notGst')}</p> : null}
        <Row label={t('sales.refund.mode')}>{tk(`sales.refund.${c.refund_mode}`)}</Row>
        <Row label={t(c.kind === 'receipt_reversal' ? 'sales.reversal.creditAmount' : 'sales.creditNotes.total')} strong><Money v={creditNoteAmount(c)} /></Row>
        <Row label={t('sales.creditNotes.balance')}><Money v={c.balance_available} /></Row>
      </CardContent></Card>
      {c.lines.length ? (
        <Card className="print:hidden"><CardContent className="space-y-1 pt-4 text-sm">
          {c.customer ? <Row label={t('sales.customer.label')}>{c.customer.name}</Row> : null}
          <table className="w-full [&_td]:px-1 [&_th]:px-1" data-testid="credit-note-lines">
            <thead className="text-xs text-muted-foreground"><tr className="text-left"><th>{t('sales.line.tag')}</th><th>{t('sales.line.item')}</th><th className="text-right">{t('sales.line.amount')}</th></tr></thead>
            <tbody>{c.lines.map((l) => (
              <tr key={l.invoice_line_id} className="border-t border-border"><td lang={l.tag_no ? 'en' : undefined} className="whitespace-nowrap py-1 font-mono">{l.tag_no ?? (l.kind === 'loose' ? <span className="rounded bg-muted px-1 font-sans text-xs">{t('sales.loose.badge')}</span> : '—')}</td>
                <td className="py-1">{l.description}</td><td className="whitespace-nowrap py-1 text-right tabular-nums"><Money v={l.line_total} /></td></tr>))}</tbody>
          </table>
        </CardContent></Card>
      ) : null}
      <PrintHistory count={c.print_count} last={c.last_printed_at} />
      <PrintPanel doc="credit_note" id={c.id} printCount={c.print_count} defaultPaper={settings.default_paper} defaultLanguage={settings.print_language} defaultNumerals={settings.print_numerals} />
    </div>
  );
}
