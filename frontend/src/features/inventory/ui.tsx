import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/field';
import { ErrorText, OfflineBanner, PageHeader } from '@/components/page';
import { useT, useTk, type MessageKey } from '@/i18n';
import { formatWeight } from '@/lib/format';
import { useCan } from '@/lib/session';
import { routePermFor } from '@/lib/permissions';
import type { TagStatus } from './types';
import { isNotReady } from './api';
import { useInventorySettings } from './hooks';

/** Sub-navigation shared by every inventory screen (labels in shop-owner words). Ageing only when switched on. */
export const INVENTORY_LINKS: Array<[to: string, key: MessageKey]> = [
  ['/inventory', 'inventory.nav.stock'], ['/inventory/tag', 'inventory.nav.tag'], ['/inventory/lots', 'inventory.nav.lots'], ['/inventory/labels', 'inventory.nav.labels'],
  ['/inventory/loose', 'inventory.nav.loose'], ['/inventory/transfers', 'inventory.nav.transfers'], ['/inventory/moves', 'inventory.nav.moves'],
  ['/inventory/stock-check', 'inventory.nav.check'], ['/inventory/adjustments', 'inventory.nav.adjustments'], ['/inventory/valuation', 'inventory.nav.valuation'],
  ['/inventory/opening', 'inventory.nav.opening'], ['/inventory/ageing', 'inventory.nav.ageing'], ['/settings/inventory', 'inventory.nav.settings'],
];

export function InventoryNav() {
  const t = useT();
  const can = useCan();
  const settings = useInventorySettings();
  const links = INVENTORY_LINKS.filter(([to]) => (to !== '/inventory/ageing' || settings.data?.ageing_enabled !== false) && (!routePermFor(to) || can(routePermFor(to) as string)));
  return (
    <nav aria-label={t('inventory.nav')} className="flex flex-wrap gap-x-3 gap-y-1 text-sm print:hidden">
      {links.map(([to, key]) => <Link key={to} to={to} activeOptions={{ exact: true }} className="underline [&.active]:font-semibold [&.active]:no-underline">{t(key)}</Link>)}
    </nav>
  );
}

/** Standard inventory page frame: header, sub-nav, offline banner. */
export function InvPage({ title, description, actions, children }: { title: MessageKey; description?: MessageKey; actions?: ReactNode; children: ReactNode }) {
  const t = useT();
  return (
    <div className="space-y-4">
      <div className="print:hidden"><PageHeader title={t(title)} description={description ? t(description) : undefined} actions={actions} /></div>
      <InventoryNav />
      <OfflineBanner />
      {children}
    </div>
  );
}

/** Generic guard: a server behind this build answers 404 (no code) / 501 → friendly note; else the usual error. 0.8.3 builds every operation. */
export function NotReadyOr({ error }: { error: unknown }) {
  const t = useT();
  if (!error) return null;
  if (isNotReady(error)) return <p role="note" data-testid="inventory-not-ready" className="rounded-md border border-border bg-muted p-3 text-sm">{t('inventory.notReady')}</p>;
  return <ErrorText error={error} />;
}

type BadgeVariant = 'success' | 'warning' | 'outline' | 'destructive' | 'default';
const STATUS_VARIANT: Record<TagStatus, BadgeVariant> = {
  in_stock: 'success', reserved: 'default', on_approval: 'warning', repair: 'warning', melting: 'warning', in_transit: 'warning',
  sold: 'outline', returned_to_vendor: 'outline', melted: 'destructive', written_off: 'destructive',
};
/** Tolerates statuses newer than this build: neutral badge, label falls back to the code. */
export function StatusBadge({ status }: { status: TagStatus | (string & {}) }) {
  const tk = useTk();
  const variant = (STATUS_VARIANT as Partial<Record<string, BadgeVariant>>)[status] ?? 'outline';
  return <Badge variant={variant}>{tk(`inventory.status.${status}`)}</Badge>;
}

export const Wt = ({ v }: { v?: string | null }) => <span className="tabular-nums">{v ? formatWeight(v) : '—'}</span>;

export function BranchPicker({ value, onChange, branches, allLabel, id, disabled }: { value: string; onChange: (v: string) => void; branches: Array<{ id: string; name: string }>; allLabel?: string; id?: string; disabled?: boolean }) {
  const t = useT();
  return (
    <Select id={id} aria-label={id ? undefined : t('inventory.branch')} disabled={disabled} value={value} onChange={(e) => onChange(e.target.value)}>
      {allLabel ? <option value="">{allLabel}</option> : null}
      {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
    </Select>
  );
}
