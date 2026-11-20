import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader } from '@/components/page';
import { useT, useTk } from '@/i18n';
import { useCan, useSignedIn } from '@/lib/session';
import { routePermFor } from '@/lib/permissions';
import { MasterScreen } from './master-screen';
import { mastersApi } from './api';
import { KycPanel } from './kyc';
import { PhotosPanel } from './photos';
import { editPermOf } from './registry';
import { isMasterKind, type MasterKind } from './types';

/** Overview grouped the way shop staff think about it. Existing screens (metals & purities, bank accounts) are linked, not rebuilt. */
export const MASTER_GROUPS: Array<{ group: string; items: Array<{ mid: string; to: string; key: string }> }> = [
  { group: 'items', items: [
    { mid: 'M1 · M2', to: '/settings/masters', key: 'metals' },
    { mid: 'M3', to: '/masters/items', key: 'items' },
    { mid: 'M3', to: '/masters/sub_items', key: 'sub_items' },
    { mid: 'M4', to: '/masters/designs', key: 'designs' },
    { mid: 'M5', to: '/masters/stone_standards', key: 'stone_standards' },
    { mid: 'M5', to: '/masters/stone_rates', key: 'stone_rates' },
    { mid: 'M13', to: '/masters/hsn_codes', key: 'hsn_codes' },
  ] },
  { group: 'pricing', items: [
    { mid: 'M6 · M7', to: '/masters/value_addition_rules', key: 'value_addition_rules' },
  ] },
  { group: 'people', items: [
    { mid: 'M8', to: '/masters/customers', key: 'customers' },
    { mid: 'M10', to: '/masters/vendors', key: 'vendors' },
    { mid: 'M11', to: '/masters/staff', key: 'staff' },
  ] },
  { group: 'shop', items: [
    { mid: 'M12', to: '/masters/floors', key: 'floors' },
    { mid: 'M12', to: '/masters/counters', key: 'counters' },
    { mid: 'M12', to: '/masters/trays', key: 'trays' },
    { mid: 'M14', to: '/masters/payment_modes', key: 'payment_modes' },
    { mid: 'M15', to: '/settings/shop', key: 'bank_accounts' },
    { mid: 'M15', to: '/masters/card_machines', key: 'card_machines' },
    { mid: 'M17', to: '/masters/import', key: 'import' },
  ] },
];

export function MastersHome() {
  const t = useT();
  const tk = useTk();
  const can = useCan();
  return (
    <div>
      <PageHeader title={t('masters.home.title')} description={t('masters.home.desc')} />
      <div className="space-y-6">
        {MASTER_GROUPS.map((g) => {
          const items = g.items.filter((i) => (!routePermFor(i.to) || can(routePermFor(i.to) as string)));
          return (
            <section key={g.group} aria-labelledby={`mg-${g.group}`}>
              <h2 id={`mg-${g.group}`} className="mb-2 text-sm font-semibold uppercase text-muted-foreground">{tk(`masters.group.${g.group}`)}</h2>
              <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {items.map((i) => (
                  <li key={i.to + i.key}>
                    <Link to={i.to} className="block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      <Card className="h-full hover:bg-muted/50">
                        <CardContent className="flex items-start justify-between gap-2 p-4">
                          <div>
                            <p className="font-medium">{tk(`masters.${i.key}.title`)}</p>
                            <p className="text-sm text-muted-foreground">{tk(`masters.${i.key}.desc`)}</p>
                          </div>
                          <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                        </CardContent>
                      </Card>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}

/** /masters/$kind — any generic master. Unknown kinds show not-found text. */
export function MasterKindPage() {
  const t = useT();
  const { kind } = useParams({ strict: false }) as { kind?: string };
  if (!isMasterKind(kind)) return <p className="text-sm text-muted-foreground">{t('error.not_found')}</p>;
  return <MasterRoute kind={kind} />;
}

export function MasterRoute({ kind }: { kind: MasterKind }) {
  if (kind === 'designs') return <DesignsPage />;
  if (kind === 'customers') return <CustomersPage />;
  if (kind === 'vendors') return <VendorsPage />;
  if (kind === 'staff') return <MasterScreen key={kind} kind="staff" extra={(row) => <KycPanel key={row.id} party="staff" row={row} />} />;
  return <MasterScreen key={kind} kind={kind} />;
}

/** M4 — same pattern plus photos in the drawer (only once the design is saved, so photos attach to a real row). */
export function DesignsPage() {
  return <MasterScreen kind="designs" extra={(row, update) => <PhotosPanel key={row.id} design={row} onChanged={update} />} />;
}

/** M8 — PAN masked to the last 4 everywhere (pan_last4 only); full PAN only through the audited reveal in the KYC panel. */
export function CustomersPage() {
  return <MasterScreen kind="customers" extra={(row) => <KycPanel key={row.id} party="customers" row={row} />} />;
}

/** M10 — plus a one-line notice while the vendor PAN backfill (legacy → encrypted) is unfinished. */
export function VendorsPage() {
  return (
    <div className="space-y-3">
      <PanBackfillNotice />
      <MasterScreen kind="vendors" extra={(row) => <KycPanel key={row.id} party="vendors" row={row} />} />
    </div>
  );
}

export function PanBackfillNotice() {
  const t = useT();
  const can = useCan()(editPermOf('vendors'));
  const signedIn = useSignedIn();
  const st = useQuery({ queryKey: ['masters', 'vendors', 'pan-backfill'], queryFn: mastersApi.panBackfillStatus, enabled: signedIn && can, retry: false, staleTime: 5 * 60_000 });
  if (!st.data || st.data.ready_to_drop_legacy) return null;
  return (
    <p role="status" data-testid="pan-backfill" className="rounded-md border border-border bg-muted p-2 text-sm text-muted-foreground">
      {t('masters.panBackfill', { done: st.data.matched, total: st.data.total, mismatched: st.data.mismatched })}
    </p>
  );
}
