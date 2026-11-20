import { Link } from '@tanstack/react-router';
import { useT } from '@/i18n';
import { useRateRefs, useTodaysStatus } from './hooks';

/**
 * Today's-rate banner per branch (rates.v_todays_rate_status). Missing sale rates block billing;
 * missing old-metal rates are a warning only. Metal codes stay Latin. Without a branch the shop summary
 * is used and each unset branch is listed.
 */
export function TodaysRateBanner({ branchId, linkToRates = true }: { branchId?: string | null; linkToRates?: boolean }) {
  const t = useT();
  const s = useTodaysStatus(branchId).data;
  const names = Object.fromEntries(useRateRefs().branches.map((x) => [x.id, x.name]));
  if (!s) return null;
  const blocker = !s.todays_rate_set;
  const soft = !s.old_metal_rate_set && s.missing_old_metal_codes.length > 0;
  if (!blocker && !soft) return null;
  return (
    <div className="space-y-2" data-testid="todays-rate-banner">
      {blocker ? (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive bg-destructive/10 px-3 py-2 text-sm">
          <p><strong>{t('rates.banner.missing')}</strong> <span lang="en" className="font-mono">{s.missing_metal_codes.length ? s.missing_metal_codes.join(', ') : t('rates.banner.noMetals')}</span>
            <span className="block text-xs text-muted-foreground">{t('rates.banner.missingHelp')}</span>
            {!branchId && s.branches?.some((r) => !r.todays_rate_set) ? (
              <span className="block text-xs" data-testid="banner-branches">{t('rates.banner.branchesUnset', { branches: s.branches.filter((r) => !r.todays_rate_set).map((r) => names[r.branch_id ?? ''] ?? r.branch_id).join(', ') })}</span>
            ) : null}</p>
          {linkToRates ? <Link to="/rates" className="text-sm font-medium underline">{t('rates.banner.setNow')}</Link> : null}
        </div>
      ) : null}
      {soft ? (
        <div role="status" className="rounded-md border border-warning bg-warning/15 px-3 py-2 text-sm">
          {t('rates.banner.oldMissing')} <span lang="en" className="font-mono">{s.missing_old_metal_codes.join(', ')}</span>
        </div>
      ) : null}
    </div>
  );
}
