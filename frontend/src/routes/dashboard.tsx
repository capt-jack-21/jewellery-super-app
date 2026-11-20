import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/page';
import { useT, useTk } from '@/i18n';
import { ok } from '@/lib/api/fetcher';
import { getGetOnboardingQueryKey, getOnboarding } from '@/lib/api/backend/onboarding/onboarding';
import { TodaysRateBanner } from '@/features/rates/banner';
import { EffectiveRates } from '@/features/rates/entry';
import { useDeviceBranch } from '@/features/rates/hooks';
import { WIZARD_STEPS } from '@/features/setup/steps';
import { ThisDeviceCard } from '@/features/devices/devices';
import { useSession, useSignedIn } from '@/lib/session';

export function useOnboarding() {
  const signedIn = useSignedIn();
  return useQuery({ queryKey: getGetOnboardingQueryKey(), queryFn: () => ok(getOnboarding()), enabled: signedIn });
}

export function DashboardPage() {
  const t = useT();
  const tk = useTk();
  const me = useSession().data?.user;
  const ob = useOnboarding().data;
  const branchId = useDeviceBranch();
  return (
    <div className="space-y-4">
      <PageHeader title={t('dashboard.welcome', { name: me?.name ?? '' })} />
      {ob && !ob.billing_unlocked ? (
        <Card className="border-warning">
          <CardHeader><CardTitle>{t('dashboard.setupPending')}</CardTitle></CardHeader>
          <CardContent className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <div>
              <p>{t('dashboard.setupBody', { n: ob.missing_billing_steps.length })}</p>
              <ul className="mt-1 list-disc pl-5 text-xs" data-testid="missing-steps">
                {ob.missing_billing_steps.map((c) => { const st = WIZARD_STEPS.find((w) => w.code === c); return <li key={c}>{st ? tk(`wizard.step.${st.key}`) : c}</li>; })}
              </ul>
            </div>
            <Button asChild><Link to="/setup">{t('dashboard.openSetup')}</Link></Button>
          </CardContent>
        </Card>
      ) : null}
      <TodaysRateBanner branchId={branchId || null} />
      <div className="grid gap-4 lg:grid-cols-2"><EffectiveRates branchId={branchId || null} /><ThisDeviceCard /></div>
    </div>
  );
}
