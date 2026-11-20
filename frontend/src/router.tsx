import type { RouteComponent } from '@tanstack/react-router';
import { createRootRoute, createRoute, createRouter, lazyRouteComponent, redirect } from '@tanstack/react-router';
import { RootLayout } from './routes/root';
import { NotFound } from './routes/not-found';
import { queryClient } from '@/lib/query-client';
import { sessionQueryOptions, surfaceOf } from '@/lib/session';
import { NO_ACCESS_PATH, hasPerm, routePermFor } from '@/lib/permissions';
import { NoAccess } from './routes/no-access';

/**
 * Tenant routes: confirm the session before any child mounts, so no data query fires signed-out,
 * then enforce the route's permission (ROUTE_PERMS) — a direct visit without it lands on /no-access and the page never mounts.
 */
export async function requireTenantSession(pathname: string, qc = queryClient): Promise<void> {
  if (pathname.endsWith('/login') || pathname === NO_ACCESS_PATH || surfaceOf(pathname) !== 'tenant') return;
  const s = await qc.ensureQueryData(sessionQueryOptions).catch(() => undefined);
  if (s === null) throw redirect({ to: '/login', search: { redirect: pathname } as never });
  const need = routePermFor(pathname);
  if (s && need && !hasPerm(s.permissions, need)) throw redirect({ to: NO_ACCESS_PATH, search: { from: pathname } as never, replace: true });
}

// Route-level code splitting: each screen is its own chunk, fetched on navigation (preloaded on intent).
const DashboardPage = lazyRouteComponent(() => import('./routes/dashboard'), 'DashboardPage');
const CounterPage = lazyRouteComponent(() => import('./routes/counter'), 'CounterPage');
const TokensPage = lazyRouteComponent(() => import('./routes/tokens'), 'TokensPage');
const PrintPage = lazyRouteComponent(() => import('./routes/print'), 'PrintPage');
const LoginPage = lazyRouteComponent(() => import('./features/auth/login'), 'LoginPage');
const DevicePage = lazyRouteComponent(() => import('./features/devices/devices'), 'DevicePage');
const DevicesPage = lazyRouteComponent(() => import('./features/devices/devices'), 'DevicesPage');
const SetupWizard = lazyRouteComponent(() => import('./features/setup/wizard'), 'SetupWizard');
const ShopSettingsPage = lazyRouteComponent(() => import('./features/settings/shop'), 'ShopSettingsPage');
const TaxSettingsPage = lazyRouteComponent(() => import('./features/settings/tax'), 'TaxSettingsPage');
const RulesSettingsPage = lazyRouteComponent(() => import('./features/settings/rules'), 'RulesSettingsPage');
const LanguageSettingsPage = lazyRouteComponent(() => import('./features/settings/language'), 'LanguageSettingsPage');
const BranchesPage = lazyRouteComponent(() => import('./features/settings/branches'), 'BranchesPage');
const RolesPage = lazyRouteComponent(() => import('./features/settings/users'), 'RolesPage');
const UsersPage = lazyRouteComponent(() => import('./features/settings/users'), 'UsersPage');
const BrandingPage = lazyRouteComponent(() => import('./features/settings/branding'), 'BrandingPage');
const DomainsPage = lazyRouteComponent(() => import('./features/settings/domains'), 'DomainsPage');
const PrintTemplatesPage = lazyRouteComponent(() => import('./features/settings/print-templates'), 'PrintTemplatesPage');
const ImportPage = lazyRouteComponent(() => import('./features/import/import'), 'ImportPage');
const MastersSettingsPage = lazyRouteComponent(() => import('./features/rates/rates'), 'MastersSettingsPage');
const RatesPage = lazyRouteComponent(() => import('./features/rates/pages'), 'RatesPage');
const RateHistoryPage = lazyRouteComponent(() => import('./features/rates/pages'), 'RateHistoryPage');
const RateCardPage = lazyRouteComponent(() => import('./features/rates/pages'), 'RateCardPage');
const MastersHome = lazyRouteComponent(() => import('./features/masters/pages'), 'MastersHome');
const MasterKindPage = lazyRouteComponent(() => import('./features/masters/pages'), 'MasterKindPage');
const DesignsPage = lazyRouteComponent(() => import('./features/masters/pages'), 'DesignsPage');
const CustomersPage = lazyRouteComponent(() => import('./features/masters/pages'), 'CustomersPage');
const MastersImportPage = lazyRouteComponent(() => import('./features/masters/import-export'), 'MastersImportPage');
const AuditPage = lazyRouteComponent(() => import('./features/audit/audit'), 'AuditPage');
const PartnerBillingPage = lazyRouteComponent(() => import('./features/partner/partner'), 'PartnerBillingPage');
const PartnerHomePage = lazyRouteComponent(() => import('./features/partner/partner'), 'PartnerHomePage');
const AdminPartnersPage = lazyRouteComponent(() => import('./features/admin/admin'), 'AdminPartnersPage');
const StockListPage = lazyRouteComponent(() => import('./features/inventory/stock'), 'StockListPage');
const PieceDetailPage = lazyRouteComponent(() => import('./features/inventory/stock'), 'PieceDetailPage');
const TaggingPage = lazyRouteComponent(() => import('./features/inventory/tagging'), 'TaggingPage');
const LotsPage = lazyRouteComponent(() => import('./features/inventory/lots-page'), 'LotsPage');
const LabelPrintPage = lazyRouteComponent(() => import('./features/inventory/labels'), 'LabelPrintPage');
const LoosePage = lazyRouteComponent(() => import('./features/inventory/loose'), 'LoosePage');
const TransfersPage = lazyRouteComponent(() => import('./features/inventory/transfers'), 'TransfersPage');
const MovesPage = lazyRouteComponent(() => import('./features/inventory/moves'), 'MovesPage');
const StockCheckPage = lazyRouteComponent(() => import('./features/inventory/scan-check'), 'StockCheckPage');
const AdjustmentsPage = lazyRouteComponent(() => import('./features/inventory/adjustments-page'), 'AdjustmentsPage');
const ValuationPage = lazyRouteComponent(() => import('./features/inventory/valuation-page'), 'ValuationPage');
const OpeningStockPage = lazyRouteComponent(() => import('./features/inventory/opening'), 'OpeningStockPage');
const AgeingPage = lazyRouteComponent(() => import('./features/inventory/ageing-page'), 'AgeingPage');
const InventorySettingsPage = lazyRouteComponent(() => import('./features/inventory/settings'), 'InventorySettingsPage');
const ChangePasswordPage = lazyRouteComponent(() => import('./features/auth/password'), 'ChangePasswordPage');
const SalesSettingsPage = lazyRouteComponent(() => import('./features/sales/settings'), 'SalesSettingsPage');
const CounterBillPage = lazyRouteComponent(() => import('./features/sales/bill-page'), 'CounterBillPage');
const CounterEstimatePage = lazyRouteComponent(() => import('./features/sales/bill-page'), 'CounterEstimatePage');
const InvoicesListPage = lazyRouteComponent(() => import('./features/sales/lists'), 'InvoicesListPage');
const InvoicePage = lazyRouteComponent(() => import('./features/sales/invoice-page'), 'InvoicePage');
const EstimatesListPage = lazyRouteComponent(() => import('./features/sales/lists'), 'EstimatesListPage');
const EstimatePage = lazyRouteComponent(() => import('./features/sales/lists'), 'EstimatePage');
const CreditNotesListPage = lazyRouteComponent(() => import('./features/sales/lists'), 'CreditNotesListPage');
const CreditNotePage = lazyRouteComponent(() => import('./features/sales/lists'), 'CreditNotePage');
const AdminTenantsPage = lazyRouteComponent(() => import('./features/admin/admin'), 'AdminTenantsPage');

const rootRoute = createRootRoute({ component: RootLayout, notFoundComponent: NotFound, beforeLoad: ({ location }) => requireTenantSession(location.pathname) });
const r = (path: string, component: RouteComponent) => createRoute({ getParentRoute: () => rootRoute, path, component });

const routeTree = rootRoute.addChildren([
  r('/login', LoginPage),
  r('/partner/login', () => <LoginPage surface="partner" />),
  r('/admin/login', () => <LoginPage surface="platform" />),
  r(NO_ACCESS_PATH, NoAccess),
  r('/', DashboardPage),
  r('/counter', CounterPage),
  // Sales 0.9.1 (contract-only on dev: every screen shows "Billing isn't switched on yet" while /v1/sales answers 404).
  createRoute({ getParentRoute: () => rootRoute, path: '/counter/bill', component: CounterBillPage,
    validateSearch: (s: Record<string, unknown>): { estimates?: string } => (typeof s.estimates === 'string' && s.estimates ? { estimates: s.estimates } : {}) }),
  createRoute({ getParentRoute: () => rootRoute, path: '/counter/estimate', component: CounterEstimatePage,
    validateSearch: (s: Record<string, unknown>): { id?: string } => (typeof s.id === 'string' && s.id ? { id: s.id } : {}) }),
  r('/sales/settings', SalesSettingsPage),
  r('/sales/invoices', InvoicesListPage),
  createRoute({ getParentRoute: () => rootRoute, path: '/sales/invoices/$id', component: InvoicePage,
    validateSearch: (s: Record<string, unknown>): { print?: boolean } => (s.print === true || s.print === 'true' || s.print === '1' ? { print: true } : {}) }),
  r('/sales/estimates', EstimatesListPage),
  r('/sales/estimates/$id', EstimatePage),
  r('/sales/credit-notes', CreditNotesListPage),
  r('/sales/credit-notes/$id', CreditNotePage),
  r('/device', DevicePage),
  createRoute({ getParentRoute: () => rootRoute, path: '/setup', component: SetupWizard,
    validateSearch: (s: Record<string, unknown>): { step?: number } => (Number(s.step) >= 1 && Number(s.step) <= 10 ? { step: Number(s.step) } : {}) }),
  r('/settings/shop', ShopSettingsPage),
  r('/settings/tax', TaxSettingsPage),
  createRoute({ getParentRoute: () => rootRoute, path: '/settings/gst-rates', beforeLoad: () => { throw redirect({ to: '/settings/tax' }); } }),
  r('/settings/rules', RulesSettingsPage),
  r('/settings/masters', MastersSettingsPage),
  r('/settings/language', LanguageSettingsPage),
  r('/settings/branches', BranchesPage),
  r('/settings/users', UsersPage),
  r('/settings/roles', RolesPage),
  r('/settings/devices', DevicesPage),
  r('/settings/branding', () => <BrandingPage scope="tenant" />),
  r('/settings/domains', () => <DomainsPage scope="tenant" />),
  r('/settings/print', PrintTemplatesPage),
  r('/settings/import', ImportPage),
  r('/rates', RatesPage),
  r('/rates/history', RateHistoryPage),
  r('/rates/card', RateCardPage),
  r('/masters', MastersHome),
  r('/masters/import', MastersImportPage),
  r('/masters/designs', DesignsPage),
  r('/masters/customers', CustomersPage),
  r('/masters/$kind', MasterKindPage),
  r('/audit', AuditPage),
  r('/inventory', StockListPage),
  r('/inventory/pieces/$id', PieceDetailPage),
  createRoute({ getParentRoute: () => rootRoute, path: '/inventory/tag', component: TaggingPage,
    validateSearch: (s: Record<string, unknown>): { lot?: string; line?: string } => (typeof s.lot === 'string' && typeof s.line === 'string' && s.lot && s.line ? { lot: s.lot, line: s.line } : {}) }),
  createRoute({ getParentRoute: () => rootRoute, path: '/inventory/lots', component: LotsPage,
    validateSearch: (s: Record<string, unknown>): { id?: string } => (typeof s.id === 'string' && s.id ? { id: s.id } : {}) }),
  createRoute({ getParentRoute: () => rootRoute, path: '/inventory/labels', component: LabelPrintPage,
    validateSearch: (s: Record<string, unknown>): { ids?: string } => (typeof s.ids === 'string' && s.ids ? { ids: s.ids } : {}) }),
  r('/inventory/loose', LoosePage),
  r('/inventory/transfers', TransfersPage),
  r('/inventory/moves', MovesPage),
  r('/inventory/stock-check', StockCheckPage),
  r('/inventory/adjustments', AdjustmentsPage),
  r('/inventory/valuation', ValuationPage),
  r('/inventory/opening', OpeningStockPage),
  r('/inventory/ageing', AgeingPage),
  r('/settings/inventory', InventorySettingsPage),
  r('/account/password', ChangePasswordPage),
  r('/partner', PartnerHomePage),
  r('/partner/branding', () => <BrandingPage scope="partner" />),
  r('/partner/domains', () => <DomainsPage scope="partner" />),
  r('/partner/billing', PartnerBillingPage),
  r('/admin', AdminTenantsPage),
  r('/admin/partners', AdminPartnersPage),
  r('/dev/tokens', TokensPage),
  r('/dev/print', PrintPage),
]);
export const router = createRouter({ routeTree, defaultPreload: 'intent' });
declare module '@tanstack/react-router' { interface Register { router: typeof router } }
