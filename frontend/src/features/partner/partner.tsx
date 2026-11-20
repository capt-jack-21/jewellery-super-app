import { useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable } from '@/components/ui/data-table';
import { PageHeader } from '@/components/page';
import { useT, useTk } from '@/i18n';
import { ok } from '@/lib/api/fetcher';
import {
  getPartnerListSubscriptionsQueryKey, getPartnerListTenantsQueryKey, partnerListSubscriptions, partnerListTenants,
} from '@/lib/api/backend/partner/partner';
import type { PartnerTenant, Subscription } from '@/lib/api/backend/model';
import { formatDateIN, formatDecimalIN } from '@/lib/format';

const tenantStatusVariant = { trial: 'warning', active: 'success', read_only: 'outline', suspended: 'destructive' } as const;
const subVariant = { trial: 'warning', active: 'success', past_due: 'destructive', grace: 'warning', read_only: 'outline', cancelled: 'outline' } as const;

/** P22-lite reseller console: shops under this partner (name, status, plan), branding + billing only. No sales data by design. */
export function PartnerHomePage() {
  const t = useT();
  const tk = useTk();
  const q = useQuery({ queryKey: getPartnerListTenantsQueryKey(), queryFn: () => ok(partnerListTenants()) });
  // 0.3.0: PartnerTenant directory row (tenant_id, not id; no slug/created_at).
  const columns: Array<ColumnDef<PartnerTenant>> = [
    { header: t('partner.shop'), accessorKey: 'display_name' },
    { header: t('common.status'), cell: (c) => <Badge variant={tenantStatusVariant[c.row.original.tenant_status]}>{tk(`tenant.status.${c.row.original.tenant_status}`)}</Badge> },
    { header: t('partner.plan'), cell: (c) => c.row.original.plan_name ?? <span className="font-mono text-xs">{c.row.original.plan_code ?? '—'}</span> },
    { header: t('billing.subscription'), cell: (c) => {
      const st = c.row.original.subscription_status;
      return st ? <Badge variant={subVariant[st as keyof typeof subVariant] ?? 'outline'}>{tk(`subscription.status.${st}`)}</Badge> : '—';
    } },
  ];
  const rows = q.data ?? [];
  return (
    <div className="space-y-4">
      <PageHeader title={t('partner.title')} description={t('partner.description')} />
      <div className="grid gap-4 sm:grid-cols-3">
        {(['active', 'trial', 'suspended'] as const).map((s) => (
          <Card key={s}><CardHeader><CardTitle className="text-sm">{tk(`tenant.status.${s}`)}</CardTitle></CardHeader>
            <CardContent className="text-2xl font-semibold tabular-nums">{formatDecimalIN(String(rows.filter((r) => r.tenant_status === s).length), 0)}</CardContent></Card>
        ))}
      </div>
      <DataTable columns={columns} data={rows} caption={t('partner.shops')} />
      <p className="text-xs text-muted-foreground">{t('partner.noSales')}</p>
    </div>
  );
}

/** Read-only partner subscriptions (GET /v1/partner/billing/subscriptions): per-shop plan + billing period. */
export function PartnerBillingPage() {
  const t = useT();
  const tk = useTk();
  const subs = useQuery({ queryKey: getPartnerListSubscriptionsQueryKey(), queryFn: () => ok(partnerListSubscriptions()) });
  const tenants = useQuery({ queryKey: getPartnerListTenantsQueryKey(), queryFn: () => ok(partnerListTenants()) });
  const name = (id: string) => tenants.data?.find((x) => x.tenant_id === id)?.display_name ?? id.slice(0, 8);
  const columns: Array<ColumnDef<Subscription>> = [
    { header: t('partner.shop'), cell: (c) => name(c.row.original.tenant_id) },
    { header: t('partner.plan'), cell: (c) => <span className="font-mono text-xs">{c.row.original.plan_code}</span> },
    { header: t('billing.cycle'), cell: (c) => c.row.original.billing_cycle },
    { header: t('billing.period'), cell: (c) => `${formatDateIN(c.row.original.current_period_start)} – ${formatDateIN(c.row.original.current_period_end)}` },
    { header: t('common.status'), cell: (c) => <Badge variant={subVariant[c.row.original.status]}>{tk(`subscription.status.${c.row.original.status}`)}</Badge> },
  ];
  return (
    <div className="space-y-4">
      <PageHeader title={t('billing.title')} description={t('billing.description')} />
      <DataTable columns={columns} data={subs.data ?? []} caption={t('billing.title')} />
    </div>
  );
}
