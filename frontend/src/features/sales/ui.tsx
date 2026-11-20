import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { AlertTriangle, Store } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { ErrorText, Loading, OfflineBanner, PageHeader } from '@/components/page';
import { useT, useTk, type MessageKey } from '@/i18n';
import { formatINR } from '@/lib/format';
import { useCan, useSignedIn } from '@/lib/session';
import { SALES } from '@/lib/permissions';
import { cn } from '@/lib/utils';
import type { InvoiceStatus, PaymentStatus, SalesSettings } from '@/lib/api/backend/model';
import { isSalesOff, salesApi, salesKeys } from './api';
import { salesErrorCode } from './logic';

/** Sub-navigation for every Sales screen (shop-owner words). Each link shows only with its permission. */
export const SALES_LINKS: Array<[to: string, key: MessageKey, perms: string[]]> = [
  ['/counter/bill', 'sales.nav.bill', [SALES.issue]],
  ['/counter/estimate', 'sales.nav.newEstimate', [SALES.estimateCreate]],
  ['/sales/invoices', 'sales.nav.bills', [SALES.view]],
  ['/sales/estimates', 'sales.nav.estimates', [SALES.estimateCreate, SALES.view]],
  ['/sales/settings', 'sales.settings.title', [SALES.settingsEdit]],
  ['/sales/credit-notes', 'sales.nav.creditNotes', [SALES.view]],
];

export function SalesNav() {
  const t = useT();
  const can = useCan();
  return (
    <nav aria-label={t('sales.nav')} className="flex flex-wrap gap-x-3 gap-y-1 text-sm print:hidden">
      {SALES_LINKS.filter(([, , perms]) => perms.some((p) => can(p))).map(([to, key]) => (
        <Link key={to} to={to} activeOptions={{ exact: true }} className="underline [&.active]:font-semibold [&.active]:no-underline">{t(key)}</Link>
      ))}
    </nav>
  );
}

/** Effective Sales settings (per shop; 0.9.1 approved defaults live on the server). `off` = the Sales module isn't routed yet. */
export function useSalesSettings(branchId?: string) {
  const signedIn = useSignedIn();
  const q = useQuery({ queryKey: salesKeys.settings(branchId), queryFn: () => salesApi.settings(branchId), enabled: signedIn, retry: false, staleTime: 5 * 60_000 });
  return { ...q, off: isSalesOff(q.error) };
}

/** Friendly state while /v1/sales answers 404 (contract-only on dev): nothing to click, nothing breaks. */
export function SalesOff() {
  const t = useT();
  return (
    <div role="note" data-testid="sales-off" className="flex items-start gap-3 rounded-lg border border-border bg-muted p-4">
      <Store className="mt-0.5 h-6 w-6 shrink-0 text-muted-foreground" aria-hidden />
      <div>
        <p className="font-semibold">{t('sales.off.title')}</p>
        <p className="text-sm text-muted-foreground">{t('sales.off.body')}</p>
      </div>
    </div>
  );
}

/** GET /v1/sales/settings answers 422 print_template_not_renderable while no platform print default is active (0.9.6, Ratchet). */
export const isPrintSettingsBlocked = (e: unknown) => salesErrorCode(e) === 'print_template_not_renderable';

/**
 * Standard Sales page frame: header, sub-nav, offline banner (billing scope), then either the screen or the "not switched on" note.
 * `gate` (default true) waits for GET /v1/sales/settings so a 404 never shows as an error.
 * `printBlocked` (next release, Ratchet 0.9.6 minor): when settings fail only because no platform print template is active, render this
 * instead of a page-wide error, so the screen still shows and only its print action reports the problem.
 */
export function SalesPage({ title, description, actions, children, gate = true, branchId, printBlocked }: { title: MessageKey; description?: MessageKey; actions?: ReactNode; children: ReactNode | ((s: SalesSettings) => ReactNode); gate?: boolean; branchId?: string; printBlocked?: (error: unknown) => ReactNode }) {
  const t = useT();
  const settings = useSalesSettings(branchId);
  const body = !gate ? (typeof children === 'function' ? null : children)
    : settings.off ? <SalesOff />
      : settings.error && printBlocked && isPrintSettingsBlocked(settings.error) ? printBlocked(settings.error)
      : settings.error ? <ErrorText error={settings.error} />
        : !settings.data ? <Loading />
          : typeof children === 'function' ? children(settings.data) : children;
  return (
    <div className="space-y-4" data-density="counter">
      <div className="print:hidden"><PageHeader title={t(title)} description={description ? t(description) : undefined} actions={actions} /></div>
      <SalesNav />
      <div className="print:hidden"><OfflineBanner scope="billing" /></div>
      {body}
    </div>
  );
}

/** Rupees, en-IN lakh grouping, tabular. Negative values keep their sign. */
export function Money({ v, className, big }: { v?: string | null; className?: string; big?: boolean }) {
  return <span className={cn('tabular-nums', big && 'font-heading text-3xl font-semibold md:text-4xl', className)}>{v == null || v === '' ? '—' : formatINR(v)}</span>;
}

const PAY_VARIANT: Record<PaymentStatus, 'success' | 'warning' | 'destructive'> = { paid: 'success', part_paid: 'warning', unpaid: 'destructive' };
export function PaymentBadge({ status }: { status: PaymentStatus | (string & {}) }) {
  const tk = useTk();
  return <Badge data-testid="payment-status" variant={(PAY_VARIANT as Record<string, 'success' | 'warning' | 'destructive'>)[status] ?? 'outline'}>{tk(`sales.payment.${status}`)}</Badge>;
}
export function InvoiceStatusBadge({ status }: { status: InvoiceStatus | (string & {}) }) {
  const tk = useTk();
  return <Badge variant={status === 'cancelled' ? 'destructive' : 'outline'}>{tk(`sales.status.${status}`)}</Badge>;
}

/** Key / value row used on bill, estimate and credit-note screens. */
export function Row({ label, children, strong, testId }: { label: ReactNode; children: ReactNode; strong?: boolean; testId?: string }) {
  return (
    <div className={cn('flex items-baseline justify-between gap-3 py-1', strong && 'font-semibold')} data-testid={testId}>
      <span className="text-muted-foreground">{label}</span><span className="text-right">{children}</span>
    </div>
  );
}

/** Blocking / error message box (same look as ErrorText). */
export function Alert({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <p role="alert" data-testid={testId} className="flex items-center gap-2 rounded-md border border-destructive bg-destructive/10 p-2 text-sm text-destructive">
      <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />{children}
    </p>
  );
}

/** Sales error in plain words: problem code → `error.<code>` (en / ta); on the scan box a bare 404 means "no such tag". */
export function SalesError({ error, ctx = 'other' }: { error: unknown; ctx?: 'scan' | 'other' }) {
  const t = useT();
  if (!error) return null;
  if (ctx === 'scan' && salesErrorCode(error, 'scan') === 'tag_not_found') return <Alert testId="sales-error">{t('error.tag_not_found')}</Alert>;
  return <div data-testid="sales-error"><ErrorText error={error} /></div>;
}
