import { forwardRef, useDeferredValue, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { UserPlus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n';
import { mastersApi } from '@/features/masters/api';
import { useSignedIn } from '@/lib/session';
import type { Customer } from '@/lib/api/backend/model';
import { gstinInput, phoneInput, stateFromGstin, type DraftCustomer } from './logic';

/**
 * Customer on the bill: type a mobile number or name to find them; or add a new one inline (name + mobile, GSTIN optional) —
 * the server creates them with the bill. 0.9.1: a mobile already on file answers 409 customer_phone_exists with the existing
 * customer, which the bill screen offers as "Use this customer". PAN is never asked here (write-only, on the bill when needed).
 */
export const CustomerPicker = forwardRef<HTMLInputElement, { value: DraftCustomer; onChange: (c: DraftCustomer) => void; disabled?: boolean; optional?: boolean }>(
  function CustomerPicker({ value, onChange, disabled, optional }, ref) {
    const t = useT();
    const signedIn = useSignedIn();
    const [q, setQ] = useState('');
    const [adding, setAdding] = useState(false);
    const [nw, setNw] = useState({ name: '', phone: '', gstin: '', state: '' });
    const dq = useDeferredValue(q.trim());
    const res = useQuery({
      queryKey: ['sales', 'customer-search', dq] as const, enabled: signedIn && dq.length >= 2, retry: false, staleTime: 30_000, placeholderData: keepPreviousData,
      queryFn: async () => (await mastersApi.list('customers', { q: dq, limit: '8' })).items as unknown as Customer[],
    });
    if (value.kind !== 'none') {
      return (
        <div className="flex items-center justify-between gap-2 rounded-md border border-border p-2" data-testid="bill-customer">
          <div>
            <p className="font-semibold">{value.name || t('sales.customer.onFile')}</p>
            {value.phone ? <p lang="en" className="font-mono text-sm text-muted-foreground">{value.phone}</p> : null}
            {value.kind === 'new' ? <p className="text-xs text-muted-foreground">{t('sales.customer.willBeAdded')}</p> : null}
          </div>
          <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => { onChange({ kind: 'none' }); setQ(''); }}><X className="h-4 w-4" aria-hidden />{t('sales.customer.change')}</Button>
        </div>
      );
    }
    const phone = phoneInput(nw.phone);
    return (
      <div className="space-y-2" data-testid="customer-picker">
        <Field label={optional ? t('sales.customer.labelOptional') : t('sales.customer.label')} hint={t('sales.customer.hint')}>{(id, d) => (
          <Input ref={ref} id={id} aria-describedby={d} value={q} disabled={disabled} autoComplete="off" onChange={(e) => setQ(e.target.value)} />)}</Field>
        {dq.length >= 2 && res.data ? (
          <ul className="divide-y divide-border rounded-md border border-border text-sm" aria-label={t('sales.customer.results')}>
            {res.data.length ? res.data.map((c) => (
              <li key={c.id}><button type="button" className="flex w-full min-h-tap items-center justify-between gap-2 px-2 text-left hover:bg-muted"
                onClick={() => onChange({ kind: 'existing', id: c.id, name: c.name, phone: c.phone, gstin: c.gstin, state_code: c.state_code })}>
                <span>{c.name}</span><span lang="en" className="font-mono text-muted-foreground">{c.phone}</span></button></li>
            )) : <li className="p-2 text-muted-foreground">{t('sales.customer.none')}</li>}
          </ul>
        ) : null}
        {!adding ? (
          <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => { setAdding(true); setNw((n) => ({ ...n, phone: /^\d/.test(q) ? q : n.phone, name: /^\d/.test(q) ? n.name : q })); }}>
            <UserPlus className="h-4 w-4" aria-hidden />{t('sales.customer.addNew')}
          </Button>
        ) : (
          <div className="grid gap-2 rounded-md border border-border p-2 sm:grid-cols-2 lg:grid-cols-4" data-testid="customer-new">
            <Field label={t('sales.customer.name')}>{(id) => <Input id={id} maxLength={200} value={nw.name} onChange={(e) => setNw({ ...nw, name: e.target.value })} />}</Field>
            <Field label={t('sales.customer.mobile')} error={nw.phone && !phone ? t('sales.customer.mobileBad') : null}>{(id, d) => (
              <Input id={id} aria-describedby={d} inputMode="tel" className="font-mono" value={nw.phone} onChange={(e) => setNw({ ...nw, phone: e.target.value })} />)}</Field>
            <Field label={t('sales.customer.gstinOptional')} error={nw.gstin.trim() && !gstinInput(nw.gstin) ? t('sales.b2b.issue.gstin_invalid') : null}>{(id, d) => (
              <Input id={id} aria-describedby={d} className="font-mono uppercase" maxLength={15} value={nw.gstin} onChange={(e) => setNw({ ...nw, gstin: e.target.value, state: stateFromGstin(e.target.value) ?? nw.state })} />)}</Field>
            <Field label={t('sales.customer.state')} hint={t('sales.customer.stateHint')}>{(id, d) => (
              <Input id={id} aria-describedby={d} inputMode="numeric" maxLength={2} className="w-24 font-mono" value={nw.state} onChange={(e) => setNw({ ...nw, state: e.target.value })} />)}</Field>
            <div className="flex gap-2 sm:col-span-2 lg:col-span-4">
              <Button type="button" size="sm" disabled={!nw.name.trim() || !phone || (!!nw.gstin.trim() && !gstinInput(nw.gstin))}
                onClick={() => { onChange({ kind: 'new', name: nw.name.trim(), phone: phone ?? '', ...(nw.gstin.trim() ? { gstin: nw.gstin.trim() } : {}), ...(nw.state.trim() ? { state_code: nw.state.trim() } : {}) }); setAdding(false); }}>{t('sales.customer.useNew')}</Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(false)}>{t('common.cancel')}</Button>
            </div>
          </div>
        )}
      </div>
    );
  },
);
