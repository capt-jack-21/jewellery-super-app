import { useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Check, Circle, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { OfflineBanner, PageHeader } from '@/components/page';
import { useT, useTk } from '@/i18n';
import { cn } from '@/lib/utils';
import { useOnboarding } from '@/routes/dashboard';
import { BrandingEditor } from '@/features/settings/branding';
import { BranchesManager } from '@/features/settings/branches';
import { Importer } from '@/features/import/import';
import { ShopLanguageForm } from '@/features/settings/language';
import { PrintTemplatesManager } from '@/features/settings/print-templates';
import { RulesForm } from '@/features/settings/rules';
import { ShopProfileForm } from '@/features/settings/shop';
import { GstConfigCard, TaxRulesCard } from '@/features/settings/tax';
import { UsersManager } from '@/features/settings/users';
import { MetalsCard } from '@/features/rates/rates';
import { TodaysRatesForm } from '@/features/rates/entry';
import { TodaysRateBanner } from '@/features/rates/banner';
import { putOnboardingStep } from '@/lib/api/backend/onboarding/onboarding';
import { getGetSessionQueryKey } from '@/lib/api/backend/auth/auth';
import { ok } from '@/lib/api/fetcher';
import { EditGate, ErrorText } from '@/components/page';
import { EDIT_SETTINGS } from '@/lib/permissions';
import { useCan } from '@/lib/session';
import { useOnline } from '@/lib/offline/connectivity';
import { billingGate, resumeStep, skippable, stepDone, WIZARD_STEPS } from './steps';

/** P2/P10 first-run setup wizard: resumable (?step= / server next_step), steps 1–2 first, Start billing gated by billing_unlocked. */
export function SetupWizard() {
  const t = useT();
  const tk = useTk();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { step?: number };
  const ob = useOnboarding();
  const qc = useQueryClient();
  const online = useOnline();
  const status = ob.data;
  const current = Math.min(Math.max(Number(search.step) || 0, 0), 10) || (status ? resumeStep(status) : 1);
  const step = WIZARD_STEPS[current - 1] ?? WIZARD_STEPS[0];
  const gate = billingGate(status);
  const firstTwoDone = stepDone(WIZARD_STEPS[0], status) && stepDone(WIZARD_STEPS[1], status);
  useEffect(() => { void ob.refetch(); }, [current]); // eslint-disable-line react-hooks/exhaustive-deps
  const canEdit = useCan()(EDIT_SETTINGS);
  const go = (n: number) => void navigate({ to: '/setup', search: { step: n } });
  const progress = useMutation({
    mutationFn: (st: 'completed' | 'skipped') => ok(putOnboardingStep(step.code, { status: st })),
    onSuccess: (o) => {
      qc.setQueryData(['/v1/onboarding'], o);
      void qc.invalidateQueries({ queryKey: getGetSessionQueryKey() }); // session.billing_unlocked
      if (current < 10) go(current + 1);
    },
  });
  const next = () => progress.mutate('completed');
  const canOpen = (n: number) => n <= 2 || firstTwoDone;
  const body = {
    profile: <div className="space-y-4"><ShopProfileForm section="profile" onSaved={next} /><ShopLanguageForm /></div>,
    gst: <div className="space-y-4"><ShopProfileForm section="gst" /><GstConfigCard /></div>,
    branches: <BranchesManager />,
    metals: <MetalsCard />,
    gstRates: <div className="space-y-4"><TaxRulesCard /><RulesForm /></div>,
    rates: <div className="space-y-3"><TodaysRateBanner linkToRates={false} /><TodaysRatesForm /></div>,
    users: <UsersManager />,
    branding: <BrandingEditor scope="tenant" />,
    print: <PrintTemplatesManager />,
    import: <Importer />,
  }[step.key];
  return (
    <div className="space-y-4">
      <PageHeader title={t('wizard.title')} description={t('wizard.description')}
        actions={<Button data-testid="start-billing" disabled={!gate.ready} onClick={() => void navigate({ to: '/counter' })}>{t('wizard.startBilling')}</Button>} />
      <OfflineBanner />
      {gate.serverMismatch.length ? <p className="text-sm text-warning" data-testid="gate-mismatch">{t('wizard.gateMismatch', { steps: gate.serverMismatch.join(', ') })}</p> : null}
      {!gate.ready && status ? (
        <p className="text-sm text-muted-foreground" data-testid="gate-reason">
          {t('wizard.gate', { steps: [...gate.missingWizard.map((n) => tk(`wizard.step.${WIZARD_STEPS[n - 1]?.key ?? ''}`))].join(', ') })}
        </p>) : null}
      <div className="grid gap-4 lg:grid-cols-[15rem_1fr]">
        <nav aria-label={t('wizard.title')}>
          <ol className="space-y-1">
            {WIZARD_STEPS.map((s) => {
              const done = stepDone(s, status);
              const open = canOpen(s.n);
              return (
                <li key={s.n}>
                  <button type="button" disabled={!open} aria-current={s.n === current ? 'step' : undefined} onClick={() => go(s.n)}
                    className={cn('flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm', s.n === current ? 'bg-primary text-primary-foreground' : 'hover:bg-muted', !open && 'opacity-50')}>
                    {done ? <Check className="h-4 w-4 text-success" aria-label={t('wizard.done')} /> : open ? <Circle className="h-4 w-4" aria-hidden /> : <Lock className="h-4 w-4" aria-label={t('wizard.locked')} />}
                    <span className="tabular-nums">{s.n}{'.'}</span><span className="flex-1">{tk(`wizard.step.${s.key}`)}</span>
                    {s.gate ? <span className="text-xs" title={t('wizard.requiredForBilling')}>{'*'}</span> : null}
                  </button>
                </li>
              );
            })}
          </ol>
          <p className="mt-2 text-xs text-muted-foreground">{`* ${t('wizard.requiredForBilling')}`}</p>
        </nav>
        <div className="space-y-4" data-testid={`wizard-step-${current}`}>
          <h2 className="font-heading text-lg font-semibold">{t('wizard.stepOf', { n: current, total: 10 })}{' · '}{tk(`wizard.step.${step.key}`)}</h2>
          {canOpen(current) ? <EditGate perm={EDIT_SETTINGS}>{body}</EditGate> : <Card><CardContent className="pt-4">{t('wizard.finishFirst')}</CardContent></Card>}
          <div className="flex flex-wrap gap-2 border-t border-border pt-3">
            {current > 1 ? <Button variant="outline" onClick={() => go(current - 1)}>{t('common.back')}</Button> : null}
            {current < 10 ? (
              <>
                <Button disabled={!online || !canEdit || progress.isPending} onClick={next} data-testid="step-complete">{t('wizard.markDone')}</Button>
                {skippable(step, status) && !stepDone(step, status) ? <Button variant="ghost" disabled={!online || !canEdit || progress.isPending} onClick={() => progress.mutate('skipped')}>{t('wizard.skip')}</Button> : null}
              </>) : <Button disabled={!online || !canEdit || progress.isPending} onClick={next}>{t('wizard.markDone')}</Button>}
            <ErrorText error={progress.error} />
          </div>
        </div>
      </div>
    </div>
  );
}
