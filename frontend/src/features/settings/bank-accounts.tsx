import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable } from '@/components/ui/data-table';
import { Check, Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ErrorText } from '@/components/page';
import { useT } from '@/i18n';
import { ApiError, ifMatch, ok } from '@/lib/api/fetcher';
import {
  createCompanyBankAccount, deleteCompanyBankAccount, getListCompanyBankAccountsQueryKey, listCompanyBankAccounts, updateCompanyBankAccount,
} from '@/lib/api/backend/tenant/tenant';
import type { BankAccount, BankAccountCreate } from '@/lib/api/backend/model';
import { useCan } from '@/lib/session';
import { useOnline } from '@/lib/offline/connectivity';
import { useCompanies } from './shop';

export const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const ACCOUNT_RE = /^[0-9]{6,18}$/;
/** Only the last four digits are ever shown (the API never returns the full number). */
export const maskedAccount = (last4: string) => `•••• ${last4}`;

type Form = BankAccountCreate & { confirm: string };
const blank: Form = { bank_name: '', branch_name: '', ifsc: '', holder_name: '', account_no: '', confirm: '', is_default: false, print_on_invoice: true };

/**
 * Company bank accounts (shop settings): shown on invoices for transfers. The full account number is
 * typed once (with confirmation), sent over TLS and stored encrypted; the UI keeps only `account_last4`.
 */
export function BankAccountsCard() {
  const t = useT();
  const qc = useQueryClient();
  const online = useOnline();
  const can = useCan();
  const editable = can('platform.settings.edit');
  const company = useCompanies().data?.[0];
  const key = getListCompanyBankAccountsQueryKey(company?.id);
  const list = useQuery({ queryKey: key, queryFn: () => ok(listCompanyBankAccounts(company?.id ?? '')), enabled: !!company });
  const [f, setF] = useState<Form>(blank);
  const inval = () => void qc.invalidateQueries({ queryKey: key });
  const add = useMutation({
    mutationFn: () => {
      const { confirm: _c, ...body } = f;
      return ok(createCompanyBankAccount(company?.id ?? '', { ...body, ifsc: body.ifsc.toUpperCase(), branch_name: body.branch_name || undefined }));
    },
    onSuccess: () => { setF(blank); inval(); },
  });
  const patch = useMutation({
    mutationFn: ({ a, p }: { a: BankAccount; p: Partial<BankAccount> }) =>
      ok(updateCompanyBankAccount(company?.id ?? '', a.id, { is_default: p.is_default, print_on_invoice: p.print_on_invoice, is_active: p.is_active }, ifMatch(a.version))),
    onSuccess: inval,
    onError: (e) => { if (e instanceof ApiError && e.isStale) inval(); },
  });
  const remove = useMutation({
    mutationFn: (a: BankAccount) => deleteCompanyBankAccount(company?.id ?? '', a.id, ifMatch(a.version)),
    onSuccess: inval,
    onError: (e) => { if (e instanceof ApiError && e.isStale) inval(); },
  });
  const ifscErr = f.ifsc && !IFSC_RE.test(f.ifsc) ? t('bank.ifscInvalid') : null;
  const accErr = f.account_no && !ACCOUNT_RE.test(f.account_no) ? t('bank.accountInvalid') : f.confirm && f.confirm !== f.account_no ? t('bank.accountMismatch') : null;
  const valid = !!company && f.bank_name.trim() && f.holder_name.trim() && IFSC_RE.test(f.ifsc) && ACCOUNT_RE.test(f.account_no) && f.confirm === f.account_no;
  const columns: Array<ColumnDef<BankAccount>> = [
    { header: t('bank.bank'), cell: (c) => <div><p>{c.row.original.bank_name}</p><p className="text-xs text-muted-foreground">{c.row.original.branch_name}</p></div> },
    { header: t('bank.holder'), accessorKey: 'holder_name' },
    { header: t('bank.account'), cell: (c) => <span className="font-mono" data-testid="account-last4">{maskedAccount(c.row.original.account_last4)}</span> },
    { header: 'IFSC', cell: (c) => <span className="font-mono">{c.row.original.ifsc}</span> },
    { header: t('common.status'), cell: (c) => (
      <div className="flex flex-wrap gap-1">
        {c.row.original.is_default ? <Badge variant="success">{t('bank.default')}</Badge> : null}
        {c.row.original.print_on_invoice ? <Badge variant="outline">{t('bank.onInvoice')}</Badge> : null}
        {!c.row.original.is_active ? <Badge variant="outline">{t('common.inactive')}</Badge> : null}
      </div>) },
    { id: 'a', header: '', cell: (c) => {
      const a = c.row.original;
      return editable ? (
        <div className="flex gap-1">
          {!a.is_default ? <Button size="sm" variant="outline" disabled={!online || patch.isPending} onClick={() => patch.mutate({ a, p: { is_default: true } })}>{t('bank.makeDefault')}</Button> : null}
          <Button size="sm" variant="ghost" disabled={!online || remove.isPending} onClick={() => { if (window.confirm(t('bank.confirmDelete', { last4: a.account_last4 }))) remove.mutate(a); }}>{t('common.delete')}</Button>
        </div>) : null;
    } },
  ];
  return (
    <Card>
      <CardHeader><CardTitle>{t('bank.title')}</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <DataTable columns={columns} data={list.data ?? []} caption={t('bank.title')} />
        <ErrorText error={patch.error ?? remove.error} />
        {editable ? (
          <div className="space-y-3 border-t pt-3">
            <p className="text-sm font-medium">{t('bank.add')}</p>
            <div className="grid gap-3 md:grid-cols-3">
              <Field label={t('bank.bank')}>{(id) => <Input id={id} value={f.bank_name} onChange={(e) => setF({ ...f, bank_name: e.target.value })} />}</Field>
              <Field label={t('bank.branch')}>{(id) => <Input id={id} value={f.branch_name ?? ''} onChange={(e) => setF({ ...f, branch_name: e.target.value })} />}</Field>
              <Field label="IFSC" error={ifscErr}>{(id, d) => <Input id={id} aria-describedby={d} className="font-mono uppercase" maxLength={11} value={f.ifsc} onChange={(e) => setF({ ...f, ifsc: e.target.value.toUpperCase() })} />}</Field>
              <Field label={t('bank.holder')}>{(id) => <Input id={id} value={f.holder_name} onChange={(e) => setF({ ...f, holder_name: e.target.value })} />}</Field>
              <Field label={t('bank.account')} hint={t('bank.accountHint')} error={accErr}>
                {(id, d) => <Input id={id} aria-describedby={d} type="password" autoComplete="off" inputMode="numeric" className="font-mono" maxLength={18} value={f.account_no} onChange={(e) => setF({ ...f, account_no: e.target.value.replace(/\D/g, '') })} />}</Field>
              <Field label={t('bank.accountConfirm')}>
                {(id) => <Input id={id} type="password" autoComplete="off" inputMode="numeric" className="font-mono" maxLength={18} value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value.replace(/\D/g, '') })} />}</Field>
              <Check label={t('bank.default')} checked={!!f.is_default} onChange={(v) => setF({ ...f, is_default: v })} />
              <Check label={t('bank.onInvoice')} checked={!!f.print_on_invoice} onChange={(v) => setF({ ...f, print_on_invoice: v })} />
            </div>
            <ErrorText error={add.error} />
            <Button disabled={!online || !valid || add.isPending} onClick={() => add.mutate()}>{t('bank.add')}</Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
