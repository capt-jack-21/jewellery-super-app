import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable } from '@/components/ui/data-table';
import { Field, Select } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ErrorText, PageHeader } from '@/components/page';
import { useT, useTk } from '@/i18n';
import { ok } from '@/lib/api/fetcher';
import {
  adminCreatePartnerUser, adminCreateTenant, adminListPartners, adminListTenants, adminReactivateTenant, adminSuspendTenant,
  getAdminListPartnersQueryKey, getAdminListTenantsQueryKey,
} from '@/lib/api/backend/admin/admin';
import type { Partner, PartnerUserInput, Tenant, TenantCreate } from '@/lib/api/backend/model';
import { formatDateIN } from '@/lib/format';
import { useOnline } from '@/lib/offline/connectivity';

const sv = { trial: 'warning', active: 'success', read_only: 'outline', suspended: 'destructive' } as const;

type Deployment = NonNullable<TenantCreate['deployment_mode']>;
const DEPLOYMENTS: Deployment[] = ['shared', 'dedicated', 'onprem'];
/** Matches the 'min 5 chars' hint. */
export const SUSPEND_REASON_MIN = 5;

interface NewTenant { display_name: string; slug: string; legal_name: string; state_code: string; owner_name: string; owner_username: string; owner_password: string; partner_id: string; deployment_mode: Deployment; bill_series_prefix: string }
const blank: NewTenant = { display_name: '', slug: '', legal_name: '', state_code: '33', owner_name: '', owner_username: '', owner_password: '', partner_id: '', deployment_mode: 'shared', bill_series_prefix: '' };
const BRANCH_CODE = 'MAIN';
/** Contract: ≤ 12 chars, A-Z 0-9 / - (first char alphanumeric). Empty = server default (the branch code). */
export const BILL_PREFIX = /^[A-Z0-9][A-Z0-9/-]{0,11}$/;

export function toTenantCreate(f: NewTenant): TenantCreate {
  return {
    slug: f.slug, display_name: f.display_name.trim(), partner_id: f.partner_id || undefined, deployment_mode: f.deployment_mode, // status is always trial
    company: { legal_name: f.legal_name.trim() || f.display_name.trim(), state_code: f.state_code },
    branch: { code: BRANCH_CODE, name: f.display_name.trim(), ...(f.bill_series_prefix ? { bill_series_prefix: f.bill_series_prefix } : {}) }, // branch state = company state
    owner: { name: f.owner_name.trim(), username: f.owner_username, password: f.owner_password },
  };
}

function usePartners() { return useQuery({ queryKey: getAdminListPartnersQueryKey(), queryFn: () => ok(adminListPartners()) }); }

/** P23 platform admin: tenants (create, suspend/reactivate with a reason) and partners. */
export function AdminTenantsPage() {
  const t = useT();
  const tk = useTk();
  const qc = useQueryClient();
  const online = useOnline();
  const tenants = useQuery({ queryKey: getAdminListTenantsQueryKey(), queryFn: () => ok(adminListTenants()) });
  const partners = usePartners();
  const pname = (id?: string | null) => (id ? partners.data?.find((p) => p.id === id)?.legal_name ?? id.slice(0, 8) : t('admin.direct'));
  const [f, setF] = useState<NewTenant>(blank);
  const [reason, setReason] = useState<Record<string, string>>({});
  const inval = () => void qc.invalidateQueries({ queryKey: getAdminListTenantsQueryKey() });
  const [created, setCreated] = useState<{ name: string; prefix: string } | null>(null);
  // 0.4.1: 201 is TenantCreated; branch.bill_series_prefix is the stored (upper-cased) value — show that, not what we typed.
  const create = useMutation({
    mutationFn: () => ok(adminCreateTenant(toTenantCreate(f))),
    onMutate: () => setCreated(null),
    onSuccess: (r) => { setCreated({ name: r.display_name, prefix: r.branch.bill_series_prefix }); setF(blank); inval(); },
  });
  const status = useMutation({
    mutationFn: ({ id, suspend }: { id: string; suspend: boolean }) =>
      suspend ? ok(adminSuspendTenant(id, { reason: reason[id] ?? '' })) : ok(adminReactivateTenant(id)),
    onSuccess: inval,
  });
  const columns: Array<ColumnDef<Tenant>> = [
    { header: t('admin.tenant'), cell: (c) => <div><p className="font-medium">{c.row.original.display_name}</p><p className="text-xs text-muted-foreground">{t('admin.created', { at: formatDateIN(c.row.original.created_at) })}</p></div> },
    { header: t('partner.slug'), cell: (c) => <span className="font-mono text-xs">{c.row.original.slug}</span> },
    { header: t('admin.partner'), cell: (c) => pname(c.row.original.partner_id) },
    { header: t('common.status'), cell: (c) => <Badge variant={sv[c.row.original.status]}>{tk(`tenant.status.${c.row.original.status}`)}</Badge> },
    { id: 'a', header: t('admin.action'), cell: (c) => {
      const r = c.row.original;
      const suspend = r.status !== 'suspended';
      return (
        <div className="flex items-center gap-1">
          {suspend ? <Input aria-label={t('admin.reason')} placeholder={t('admin.reason')} className="h-8 w-36" value={reason[r.id] ?? ''} onChange={(e) => setReason({ ...reason, [r.id]: e.target.value })} /> : null}
          <Button size="sm" variant={suspend ? 'destructive' : 'default'} disabled={!online || (suspend && (reason[r.id] ?? '').trim().length < SUSPEND_REASON_MIN) || status.isPending} onClick={() => status.mutate({ id: r.id, suspend })}>
            {t(suspend ? 'admin.suspend' : 'admin.resume')}
          </Button>
        </div>);
    } },
  ];
  const valid = f.display_name.trim().length >= 2 && /^[a-z0-9-]{3,40}$/.test(f.slug) && /^[0-9]{2}$/.test(f.state_code)
    && f.owner_name.trim().length > 0 && /^[a-z0-9._-]{3,40}$/.test(f.owner_username) && f.owner_password.length >= 8
    && (!f.bill_series_prefix || BILL_PREFIX.test(f.bill_series_prefix));
  return (
    <div className="space-y-4">
      <PageHeader title={t('admin.title')} description={t('admin.description')} />
      <DataTable columns={columns} data={tenants.data ?? []} caption={t('admin.tenants')} />
      <ErrorText error={status.error} />
      <Card>
        <CardHeader><CardTitle>{t('admin.create')}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 md:grid-cols-4">
            <Field label={t('admin.tenantName')}>{(id) => <Input id={id} value={f.display_name} onChange={(e) => setF({ ...f, display_name: e.target.value })} />}</Field>
            <Field label={t('partner.slug')}>{(id) => <Input id={id} className="font-mono" value={f.slug} onChange={(e) => setF({ ...f, slug: e.target.value.trim().toLowerCase() })} />}</Field>
            <Field label={t('shop.legalName')}>{(id) => <Input id={id} value={f.legal_name} onChange={(e) => setF({ ...f, legal_name: e.target.value })} />}</Field>
            <Field label={t('admin.billPrefix')} hint={t('admin.billPrefixHint', { code: BRANCH_CODE })}
              error={f.bill_series_prefix && !BILL_PREFIX.test(f.bill_series_prefix) ? t('admin.billPrefixInvalid') : null}>{(id, d) => (
              <Input id={id} aria-describedby={d} className="font-mono" maxLength={12} placeholder={BRANCH_CODE} value={f.bill_series_prefix}
                onChange={(e) => setF({ ...f, bill_series_prefix: e.target.value.toUpperCase().trim() })} />)}</Field>
            <Field label={t('shop.stateCode')} hint={t('shop.stateCodeHint')}>{(id, d) => <Input id={id} aria-describedby={d} inputMode="numeric" className="font-mono" value={f.state_code} onChange={(e) => setF({ ...f, state_code: e.target.value.trim() })} />}</Field>
            <Field label={t('user.name')}>{(id) => <Input id={id} value={f.owner_name} onChange={(e) => setF({ ...f, owner_name: e.target.value })} />}</Field>
            <Field label={t('admin.ownerLogin')} hint={t('user.loginHint')}>{(id, d) => <Input id={id} aria-describedby={d} className="font-mono" value={f.owner_username} onChange={(e) => setF({ ...f, owner_username: e.target.value.trim().toLowerCase() })} />}</Field>
            <Field label={t('admin.ownerPassword')}>{(id) => <Input id={id} type="password" autoComplete="new-password" value={f.owner_password} onChange={(e) => setF({ ...f, owner_password: e.target.value })} />}</Field>
            <Field label={t('admin.partner')}>{(id) => (
              <Select id={id} value={f.partner_id} onChange={(e) => setF({ ...f, partner_id: e.target.value })}>
                <option value="">{t('admin.direct')}</option>
                {partners.data?.map((p) => <option key={p.id} value={p.id}>{p.legal_name}</option>)}
              </Select>)}</Field>
            <Field label={t('admin.deployment')}>{(id) => (
              <Select id={id} value={f.deployment_mode} onChange={(e) => setF({ ...f, deployment_mode: e.target.value as Deployment })}>
                {DEPLOYMENTS.map((d) => <option key={d} value={d}>{tk(`admin.deployment.${d}`)}</option>)}
              </Select>)}</Field>
          </div>
          <ErrorText error={create.error} />
          {created ? <p role="status" className="text-sm text-success">{t('admin.createdPrefix', created)}</p> : null}
          <Button disabled={!online || !valid || create.isPending} onClick={() => create.mutate()}>{t('admin.create')}</Button>
        </CardContent>
      </Card>
    </div>
  );
}

const blankUser: PartnerUserInput & { partner_id: string } = { partner_id: '', name: '', email: '', password: '', role: 'partner_admin' };

export function AdminPartnersPage() {
  const t = useT();
  const tk = useTk();
  const online = useOnline();
  const q = usePartners();
  const [u, setU] = useState(blankUser);
  // 0.3.0: a partner's first admin is created by the platform (POST /v1/admin/partners/{id}/users); they add the rest.
  const addUser = useMutation({
    mutationFn: () => { const { partner_id, ...body } = u; return ok(adminCreatePartnerUser(partner_id, { ...body, email: body.email.trim(), name: body.name.trim() })); },
    onSuccess: () => setU(blankUser),
  });
  const validUser = !!u.partner_id && u.name.trim().length > 0 && /^\S+@\S+\.\S+$/.test(u.email.trim()) && u.password.length >= 8;
  const columns: Array<ColumnDef<Partner>> = [
    { header: t('admin.partner'), accessorKey: 'legal_name' },
    { header: t('partner.slug'), cell: (c) => <span className="font-mono text-xs">{c.row.original.slug}</span> },
    { header: 'GSTIN', cell: (c) => <span className="font-mono text-xs">{c.row.original.gstin ?? '—'}</span> },
    { header: t('common.status'), cell: (c) => <Badge variant={c.row.original.status === 'active' ? 'success' : 'destructive'}>{tk(`tenant.status.${c.row.original.status}`)}</Badge> },
  ];
  return (
    <div className="space-y-4">
      <PageHeader title={t('admin.partners')} description={t('admin.partnersDescription')} />
      <DataTable columns={columns} data={q.data ?? []} caption={t('admin.partners')} />
      <Card>
        <CardHeader><CardTitle>{t('admin.partnerAdmin')}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 md:grid-cols-4">
            <Field label={t('admin.partner')}>{(id) => (
              <Select id={id} value={u.partner_id} onChange={(e) => setU({ ...u, partner_id: e.target.value })}>
                <option value="">—</option>
                {q.data?.map((p) => <option key={p.id} value={p.id}>{p.legal_name}</option>)}
              </Select>)}</Field>
            <Field label={t('user.name')}>{(id) => <Input id={id} value={u.name} onChange={(e) => setU({ ...u, name: e.target.value })} />}</Field>
            <Field label={t('auth.email')}>{(id) => <Input id={id} type="email" value={u.email} onChange={(e) => setU({ ...u, email: e.target.value })} />}</Field>
            <Field label={t('auth.password')}>{(id) => <Input id={id} type="password" autoComplete="new-password" value={u.password} onChange={(e) => setU({ ...u, password: e.target.value })} />}</Field>
          </div>
          <ErrorText error={addUser.error} />
          <Button disabled={!online || !validUser || addUser.isPending} onClick={() => addUser.mutate()}>{t('admin.partnerAdminCreate')}</Button>
          {addUser.isSuccess ? <p role="status" className="text-sm text-success">{t('common.saved')}</p> : null}
        </CardContent>
      </Card>
    </div>
  );
}
