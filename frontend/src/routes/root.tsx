import { useEffect } from 'react';
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { KeyRound, LogOut, Moon, Monitor, Wifi, WifiOff } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/field';
import { Loading } from '@/components/page';
import { localeLabels, useLocale, useT, type MessageKey } from '@/i18n';
import { languageLabel, useLanguages } from '@/i18n/languages';
import { LanguageSync } from '@/i18n/language-sync';
import { useBrand } from '@/lib/brand/context';
import { loadBrand } from '@/lib/brand/loader';
import { useOnline, useUpdateRequired } from '@/lib/offline/connectivity';
import { CLIENT_VERSION } from '@/lib/version';
import { homeFor, loginPathFor, surfaceOf, usePrincipal, type Principal } from '@/lib/session';
import { useIdleLogout, logout } from '@/lib/idle';
import { updateMe } from '@/lib/api/backend/users/users';
import { ifMatch } from '@/lib/api/fetcher';
import { partnerGetTheme } from '@/lib/api/backend/partner/partner';
import type { ThemeView } from '@/lib/api/backend/model';
import { UpdatePrompt } from '@/components/update-prompt';
import { hasPerm, routePermFor, SALES_NAV_PERMS } from '@/lib/permissions';
import { FEATURE_SALES } from '@/features/flags';

type NavItem = [to: string, key: MessageKey, perm?: string];
// Nav permissions come from ROUTE_PERMS (same map the router guard enforces); other settings pages are readable, edit-gated in-page.
const TENANT_NAV: Array<[MessageKey | null, NavItem[]]> = withPerms([
  [null, [['/', 'nav.dashboard'], ['/counter', 'nav.counter'], ['/rates', 'nav.rates'], ['/setup', 'nav.setup']]],
  ...(FEATURE_SALES ? [['nav.group.sales', [['/counter/bill', 'nav.salesBill'], ['/sales/invoices', 'nav.salesBills'], ['/sales/estimates', 'nav.salesEstimates'], ['/sales/credit-notes', 'nav.salesCreditNotes'], ['/sales/settings', 'sales.settings.title']]] as [MessageKey, NavItem[]]] : []),
  ['nav.group.shop', [['/settings/shop', 'nav.shop'], ['/settings/tax', 'nav.tax'], ['/settings/rules', 'nav.rules'], ['/settings/language', 'nav.language'], ['/settings/branches', 'nav.branches']]],
  ['nav.group.inventory', [['/inventory', 'nav.inventory'], ['/inventory/tag', 'nav.inventoryTag'], ['/inventory/transfers', 'nav.inventoryTransfers'], ['/inventory/stock-check', 'nav.inventoryCheck'], ['/inventory/valuation', 'nav.inventoryValuation'], ['/settings/inventory', 'nav.inventorySettings']]],
  ['nav.group.masters', [['/masters', 'nav.mastersHome'], ['/settings/masters', 'nav.masters'], ['/masters/designs', 'nav.designs'], ['/masters/customers', 'nav.customers'], ['/masters/import', 'nav.mastersImport']]],
  ['nav.group.people', [['/settings/users', 'nav.users'], ['/settings/roles', 'nav.roles'], ['/settings/devices', 'nav.devices']]],
  ['nav.group.look', [['/settings/branding', 'nav.branding'], ['/settings/domains', 'nav.domains'], ['/settings/print', 'nav.print']]],
  ['nav.group.data', [['/settings/import', 'nav.import'], ['/audit', 'nav.audit']]],
  ['nav.group.dev', [['/dev/tokens', 'nav.tokens'], ['/dev/print', 'nav.printPreview']]],
]);
function withPerms(groups: Array<[MessageKey | null, NavItem[]]>): Array<[MessageKey | null, NavItem[]]> {
  return groups.map(([g, items]) => [g, items.map(([to, key]): NavItem => [to, key, routePermFor(to) ?? SALES_NAV_PERMS[to]])]);
}
const PARTNER_NAV: Array<[MessageKey | null, NavItem[]]> = [[null, [['/partner', 'nav.partner.shops'], ['/partner/branding', 'nav.branding'], ['/partner/domains', 'nav.domains'], ['/partner/billing', 'nav.partner.billing']]]];
const ADMIN_NAV: Array<[MessageKey | null, NavItem[]]> = [[null, [['/admin', 'nav.admin.tenants'], ['/admin/partners', 'nav.admin.partners']]]];
export { homeFor };

export function RootLayout() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  if (useUpdateRequired()) return <UpdateRequired />;
  if (path.endsWith('/login')) return <><LanguageSync tenant={false} /><Outlet /></>;
  return <AuthedShell path={path} />;
}

/** Server's min_client_version is newer than this build: block all screens until reload picks up the new app. */
function UpdateRequired() {
  const t = useT();
  return (
    <div role="alert" className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background p-8 text-center text-foreground">
      <h1 className="font-heading text-xl font-semibold">{t('app.updateRequired')}</h1>
      <p className="text-sm text-muted-foreground">{t('app.updateRequiredBody', { version: CLIENT_VERSION })}</p>
      <Button onClick={() => window.location.reload()}>{t('app.reload')}</Button>
    </div>
  );
}

function AuthedShell({ path }: { path: string }) {
  const p = usePrincipal(path);
  const navigate = useNavigate();
  useEffect(() => {
    if (p === null) void navigate({ to: loginPathFor(surfaceOf(path)), search: { redirect: path } });
  }, [p, navigate, path]);
  if (!p) return <div className="p-8"><Loading /></div>;
  return <Shell me={p} />;
}

function Shell({ me }: { me: Principal }) {
  const t = useT();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { brand, setBrand } = useBrand();
  const { sources } = useLocale();
  const online = useOnline();
  const langs = useLanguages();
  const tenant = me.surface === 'tenant' ? me.session : null;
  useIdleLogout(tenant?.idle_timeout_minutes ?? 30, () => void logout(me.surface).then(() => navigate({ to: loginPathFor(me.surface), search: { reason: 'idle' } })));
  // Re-resolve branding for this surface (partner sees its own merged theme).
  useEffect(() => { void loadBrand(me.surface === 'partner' ? () => partnerGetTheme() as Promise<{ data: ThemeView }> : undefined).then(setBrand); }, [me.surface]); // eslint-disable-line react-hooks/exhaustive-deps
  const root = document.documentElement;
  const nav = me.surface === 'partner' ? PARTNER_NAV : me.surface === 'platform' ? ADMIN_NAV : TENANT_NAV;
  const can = (perm?: string) => hasPerm(me.permissions, perm);
  const setOverride = async (v: string) => {
    await updateMe({ language: v === 'default' ? null : v }, ifMatch(tenant?.user.version));
    await qc.invalidateQueries();
  };
  return (
    <div className="min-h-screen bg-background font-body text-foreground">
      <LanguageSync tenant={!!tenant} />
      <header className="flex flex-wrap items-center gap-3 border-b border-border bg-card px-4 py-2">
        {brand.logoUrl ? <img src={brand.logoUrl} alt="" className="h-8" /> : null}
        <span className="font-heading text-lg font-semibold">{brand.appName}</span>
        <Badge variant="outline">{t(`surface.${me.surface}` as MessageKey)}</Badge>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Badge variant={online ? 'success' : 'warning'} aria-live="polite" data-testid="conn-badge">
            {online ? <Wifi className="mr-1 h-3 w-3" /> : <WifiOff className="mr-1 h-3 w-3" />}
            {t(online ? 'app.online' : 'app.offline')}
          </Badge>
          {tenant ? (
            <Select aria-label={t('app.language')} className="h-8 min-h-0 w-auto" value={tenant.user.language ?? 'default'} disabled={!online}
              onChange={(e) => void setOverride(e.target.value)}>
              <option value="default">{t('lang.followShop', { lang: sources.tenantDefault ? localeLabels[sources.tenantDefault] : localeLabels['en-IN'] })}</option>
              {(langs.data ?? []).map((l) => <option key={l.code} value={l.code}>{languageLabel(l)}</option>)}
            </Select>
          ) : null}
          <Button size="icon" variant="ghost" aria-label={t('app.theme.toggle')}
            onClick={() => { root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark'; }}><Moon className="h-4 w-4" /></Button>
          <Button size="icon" variant="ghost" aria-label={t('app.density.toggle')}
            onClick={() => { root.dataset.density = root.dataset.density === 'counter' ? 'office' : 'counter'; }}><Monitor className="h-4 w-4" /></Button>
          <span className="text-sm">{me.name}</span>
          {tenant ? (
            <Button asChild size="icon" variant="ghost"><Link to="/account/password" aria-label={t('password.change.title')} title={t('password.change.title')}><KeyRound className="h-4 w-4" /></Link></Button>
          ) : null}
          <Button size="icon" variant="ghost" aria-label={t('auth.logout')} onClick={() => void logout(me.surface).then(() => { qc.clear(); void navigate({ to: loginPathFor(me.surface) }); })}>
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
      </header>
      <div className="flex">
        <nav aria-label={t('nav.main')} className="w-56 shrink-0 border-r border-border bg-card p-2 print:hidden">
          {nav.map(([group, items], gi) => {
            const visible = items.filter(([, , perm]) => can(perm));
            if (!visible.length) return null;
            return (
              <div key={gi} className="mb-3">
                {group ? <p className="px-3 pb-1 text-xs font-semibold uppercase text-muted-foreground">{t(group)}</p> : null}
                {visible.map(([to, key]) => (
                  <Link key={to} to={to} activeOptions={{ exact: to === '/' || to === '/partner' || to === '/admin' || to === '/masters' }}
                    className="block rounded-md px-3 py-1.5 text-sm hover:bg-muted [&.active]:bg-primary [&.active]:text-primary-foreground">{t(key)}</Link>
                ))}
              </div>
            );
          })}
        </nav>
        <main className="min-w-0 flex-1 p-4 lg:p-6"><Outlet /></main>
      </div>
      <UpdatePrompt />
    </div>
  );
}
