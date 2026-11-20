import { Link } from '@tanstack/react-router';
import { FileText, ListChecks, Receipt, ScanLine } from 'lucide-react';
import { PageHeader } from '@/components/page';
import { Card, CardContent } from '@/components/ui/card';
import { useT, type MessageKey } from '@/i18n';
import { SALES } from '@/lib/permissions';
import { billingState, useCan, useSession } from '@/lib/session';
import { FEATURE_SALES } from '@/features/flags';

const TILES: Array<[to: string, label: MessageKey, hint: MessageKey, perm: string, Icon: typeof ScanLine]> = [
  ['/counter/bill', 'sales.nav.bill', 'sales.hub.billHint', SALES.issue, ScanLine],
  ['/counter/estimate', 'sales.nav.newEstimate', 'sales.hub.estimateHint', SALES.estimateCreate, FileText],
  ['/sales/invoices', 'sales.nav.bills', 'sales.hub.billsHint', SALES.view, Receipt],
  ['/sales/estimates', 'sales.nav.estimates', 'sales.hub.estimatesHint', SALES.estimateCreate, ListChecks],
];

/** Counter home: big tiles to the billing screens (0.9.1). Device / setup gates show here too; the screens re-check. */
export function CounterPage() {
  const t = useT();
  const can = useCan();
  const session = useSession().data;
  const gate = billingState(session);
  return (
    <div className="space-y-4">
      <PageHeader title={t('nav.counter')} />
      {session && gate.device && !gate.unlocked ? <p className="rounded-md border border-warning p-3 text-sm" data-testid="setup-gate">{t('counter.setupGate')}{' '}<Link className="underline" to="/setup">{t('dashboard.openSetup')}</Link></p> : null}
      {session && !gate.device ? <p className="rounded-md border border-warning p-3 text-sm" data-testid="device-gate">{t('counter.deviceGate')}{' '}<Link className="underline" to="/device">{t('device.title')}</Link></p> : null}
      {FEATURE_SALES ? (
        <div className="grid gap-3 sm:grid-cols-2" data-testid="counter-hub">
          {TILES.filter(([, , , perm]) => can(perm)).map(([to, label, hint, , Icon]) => (
            <Link key={to} to={to} className="block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <Card className="h-full transition-colors hover:bg-muted"><CardContent className="flex items-center gap-4 pt-4">
                <Icon className="h-10 w-10 shrink-0 text-primary" aria-hidden />
                <div><p className="font-heading text-xl font-semibold">{t(label)}</p><p className="text-sm text-muted-foreground">{t(hint)}</p></div>
              </CardContent></Card>
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}
