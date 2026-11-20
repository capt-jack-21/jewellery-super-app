import { forwardRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field, Select } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useT, useTk } from '@/i18n';
import { formatINR } from '@/lib/format';
import { useSignedIn } from '@/lib/session';
import { uuid } from '@/lib/uuid';
import type { SalesTenderMode } from '@/lib/api/backend/model';
import { salesApi, salesKeys } from './api';
import { fillRemaining, MAX_TENDERS, REFERENCE_MODES, tenderCheck, type DraftTender } from './logic';
import { Money, Row } from './ui';

/** Tender modes in counter order (contract SalesTenderMode). Store credit (credit_note) only when a customer is on the bill. */
export const TENDER_MODES: SalesTenderMode[] = ['cash', 'upi', 'debit_card', 'credit_card', 'bank_transfer', 'cheque', 'credit_note'];
export const newTender = (mode: SalesTenderMode = 'cash', amount = ''): DraftTender => ({ key: uuid(), mode, amount });

/**
 * Split / part payments. Each row: mode, amount (₹), and what that mode needs (reference, cheque date, store-credit note).
 * "Rest" fills the row with what is still due. Paying less than due is fine (part-paid); more is blocked (overpayment).
 */
export const TenderEditor = forwardRef<HTMLInputElement, {
  tenders: DraftTender[]; onChange: (t: DraftTender[]) => void; due: string | null; customerId?: string | null; disabled?: boolean; label?: string;
}>(function TenderEditor({ tenders, onChange, due, customerId, disabled, label }, firstRef) {
  const t = useT();
  const tk = useTk();
  const signedIn = useSignedIn();
  const credit = useQuery({
    queryKey: salesKeys.creditNotes({ customer_id: customerId ?? '', has_store_credit: true }),
    queryFn: () => salesApi.creditNotes({ customer_id: customerId ?? '', has_store_credit: true }),
    enabled: signedIn && !!customerId && tenders.some((x) => x.mode === 'credit_note'), retry: false,
  });
  const check = tenderCheck(tenders, due);
  const set = (i: number, patch: Partial<DraftTender>) => onChange(tenders.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  const issueAt = (i: number) => check.issues.filter((x) => x.index === i);
  const modes = TENDER_MODES.filter((m) => m !== 'credit_note' || !!customerId);
  return (
    <fieldset className="space-y-2" disabled={disabled} data-testid="tenders">
      <legend className="mb-1 font-semibold">{label ?? t('sales.pay.title')}</legend>
      {tenders.map((x, i) => (
        <div key={x.key} className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-2 rounded-md border border-border p-2" data-testid="tender-row">
          <Select aria-label={t('sales.pay.mode')} className="col-start-1 row-start-1" value={x.mode} onChange={(e) => set(i, { mode: e.target.value as SalesTenderMode })}>
            {modes.map((m) => <option key={m} value={m}>{tk(`sales.tender.${m}`)}</option>)}
          </Select>
          <Input ref={i === 0 ? firstRef : undefined} aria-label={t('sales.pay.amount')} inputMode="decimal" className="col-span-3 row-start-2 font-mono text-lg tabular-nums" placeholder="0.00"
            value={x.amount} aria-invalid={issueAt(i).some((z) => z.code === 'amount_invalid') || undefined} onChange={(e) => set(i, { amount: e.target.value })} />
          <Button type="button" variant="outline" size="sm" className="col-start-2 row-start-1 self-center" disabled={due == null} onClick={() => set(i, { amount: fillRemaining(tenders, due ?? '0', i) })}>{t('sales.pay.rest')}</Button>
          <Button type="button" variant="ghost" size="icon" className="col-start-3 row-start-1" aria-label={t('common.remove')} onClick={() => onChange(tenders.filter((_, k) => k !== i))}><Trash2 className="h-4 w-4" /></Button>
          {REFERENCE_MODES.has(x.mode) || x.mode === 'upi' || x.mode.endsWith('_card') ? (
            <Input aria-label={t(x.mode === 'cheque' ? 'sales.pay.chequeNo' : 'sales.pay.reference')} placeholder={t(x.mode === 'cheque' ? 'sales.pay.chequeNo' : 'sales.pay.reference')} className="col-span-3 font-mono" maxLength={60}
              value={x.reference ?? ''} onChange={(e) => set(i, { reference: e.target.value })} />
          ) : null}
          {x.mode === 'cheque' ? <Input type="date" aria-label={t('sales.pay.chequeDate')} className="col-span-3" value={x.cheque_date ?? ''} onChange={(e) => set(i, { cheque_date: e.target.value })} /> : null}
          {x.mode === 'credit_note' ? (
            <Field label={t('sales.pay.storeCredit')} className="col-span-3">{(id) => (
              <Select id={id} value={x.credit_note_id ?? ''} onChange={(e) => set(i, { credit_note_id: e.target.value || undefined })}>
                <option value="">{t('sales.pay.pickCreditNote')}</option>
                {(credit.data?.items ?? []).map((cn) => <option key={cn.id} value={cn.id}>{`${cn.doc_no} · ${formatINR(cn.balance_available)}`}</option>)}
              </Select>)}</Field>
          ) : null}
          {issueAt(i).map((z) => <p key={z.code} role="alert" className="col-span-2 text-sm text-destructive">{tk(`sales.pay.issue.${z.code}`)}</p>)}
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" disabled={tenders.length >= MAX_TENDERS}
        onClick={() => onChange([...tenders, newTender(tenders.some((x) => x.mode === 'cash') ? 'upi' : 'cash', due == null ? '' : fillRemaining(tenders, due, tenders.length))])}>
        <Plus className="h-4 w-4" aria-hidden />{t('sales.pay.add')}
      </Button>
      <div className="text-sm">
        <Row label={t('sales.pay.total')} testId="tender-total"><Money v={check.total} /></Row>
        {check.remaining != null ? <Row label={t('sales.totals.balanceDue')} strong testId="tender-remaining"><Money v={check.issues.some((z) => z.code === 'overpayment') ? '0.00' : check.remaining} /></Row> : null}
      </div>
      {check.issues.filter((z) => z.index === null).map((z) => <p key={z.code} role="alert" className="text-sm text-destructive" data-testid={`tender-${z.code}`}>{tk(`sales.pay.issue.${z.code}`)}</p>)}
    </fieldset>
  );
});
