/**
 * Route-level permissions (tenant surface). Single source for the router guard and the nav.
 * Pages not listed are readable by any signed-in user; their edit controls are gated in-page (EditGate / useCan).
 */
import { FEATURE_INVENTORY_PERMS, FEATURE_SALES } from '@/features/flags';

export const EDIT_SETTINGS = 'platform.settings.edit';
/**
 * Masters (contract 0.7.0, 982/984): writes need masters.<area>.manage, reads masters.<area>.view;
 * the full PAN / KYC numbers need masters.kyc.reveal (owner, manager). One area per screen group.
 */
export const MASTER_AREA = {
  items: 'items', sub_items: 'items', designs: 'designs', stone_standards: 'stones', stone_rates: 'stones',
  value_addition_rules: 'making_rules', customers: 'customers', vendors: 'vendors', staff: 'staff',
  floors: 'counters', counters: 'counters', trays: 'counters', hsn_codes: 'tax', payment_modes: 'payments', card_machines: 'payments',
} as const;
export type MasterArea = (typeof MASTER_AREA)[keyof typeof MASTER_AREA] | 'metals';
export const mastersManage = (area: MasterArea) => `masters.${area}.manage`;
export const mastersView = (area: MasterArea) => `masters.${area}.view`;
/** Customer create/edit/deactivate. One constant so it is easy to move again. */
export const CUSTOMERS_EDIT = mastersManage('customers');
export const KYC_REVEAL = 'masters.kyc.reveal';
/** KYC documents belong to a party; their writes follow that party's area. */
export const PARTY_AREA = { customer: 'customers', vendor: 'vendors', staff: 'staff' } as const;

const masterRoutePerms = Object.fromEntries(Object.entries(MASTER_AREA)
  // 0.7.1: customers too (masters.customers.view; every role has it).
  .map(([kind, area]) => [`/masters/${kind}`, mastersView(area)]));

/**
 * Inventory permissions — contract 0.8.0 (INVENTORY-CONTRACT-NOTES §3): the 16 codes seeded by data-model 987, plus the
 * existing inventory.transfer.approve and inventory.tag.view_cost. Enforced when FEATURE_INVENTORY_PERMS is on.
 */
export const INV = {
  stockView: 'inventory.stock.view',
  tagCreate: 'inventory.tag.create',
  tagEdit: 'inventory.tag.edit',
  tagPrintLabel: 'inventory.tag.print_label',
  tagPhotos: 'inventory.tag.photos',
  tagStatusChange: 'inventory.tag.status_change',
  tagViewCost: 'inventory.tag.view_cost',
  move: 'inventory.move',
  transferDispatch: 'inventory.transfer.dispatch',
  transferReceive: 'inventory.transfer.receive',
  transferApprove: 'inventory.transfer.approve',
  stockCheckRun: 'inventory.stock_check.run',
  stockCheckClose: 'inventory.stock_check.close',
  adjustmentRequest: 'inventory.adjustment.request',
  adjustmentApprove: 'inventory.adjustment.approve',
  valuationView: 'inventory.valuation.view',
  ageingView: 'inventory.ageing.view',
  settingsEdit: 'inventory.settings.edit',
} as const;
export type InvPerm = (typeof INV)[keyof typeof INV];
export const INVENTORY_ROUTE_PERMS: Readonly<Record<string, string>> = {
  '/inventory': INV.stockView,
  '/inventory/tag': INV.tagCreate,
  '/inventory/lots': INV.stockView,
  '/inventory/labels': INV.tagPrintLabel,
  '/inventory/loose': INV.stockView,
  '/inventory/transfers': INV.stockView,
  '/inventory/moves': INV.move,
  '/inventory/stock-check': INV.stockCheckRun,
  '/inventory/adjustments': INV.stockView,
  '/inventory/valuation': INV.valuationView,
  '/inventory/opening': 'platform.import.run',
  '/inventory/ageing': INV.ageingView,
  '/settings/inventory': INV.stockView,
};
/** The inventory permission, or undefined (= no gate) while FEATURE_INVENTORY_PERMS is off. */
export const invPerm = (perm: string): string | undefined => (FEATURE_INVENTORY_PERMS ? perm : undefined);

/**
 * Sales permissions — contract 0.9.1 (12 codes: 0.9.0's ten + credit_sale and old_gold.rate_override). Convert-an-estimate needs `issue` (no separate code).
 * Lists: invoices / credit notes need `view`; estimates need `estimateCreate` OR `view` (checked in-page).
 */
export const SALES = {
  settingsEdit: 'sales.settings.edit',
  receiptReverse: 'sales.receipt.reverse',
  view: 'sales.invoice.view',
  issue: 'sales.invoice.issue',
  cancel: 'sales.invoice.cancel',
  reprint: 'sales.invoice.reprint',
  zeroGst: 'sales.invoice.zero_gst',
  returnIssue: 'sales.return.issue',
  paymentReceive: 'sales.payment.receive',
  estimateCreate: 'sales.estimate.create',
  discountGive: 'sales.discount.give',
  overrideMin: 'sales.price.override_min',
  creditSale: 'sales.invoice.credit_sale',
  oldGoldRateOverride: 'sales.old_gold.rate_override',
} as const;
export type SalesPerm = (typeof SALES)[keyof typeof SALES];
export const SALES_ROUTE_PERMS: Readonly<Record<string, string>> = FEATURE_SALES ? {
  '/sales/settings': SALES.settingsEdit,
  '/settings/rules': SALES.settingsEdit,
  '/sales/invoices': SALES.view,
  '/sales/credit-notes': SALES.view,
} : {};
/** Nav entries whose permission is not a route guard (pages usable with either of two codes gate themselves). */
export const SALES_NAV_PERMS: Readonly<Record<string, string>> = {
  '/counter/bill': SALES.issue,
  '/sales/estimates': SALES.estimateCreate,
};

export const ROUTE_PERMS: Readonly<Record<string, string>> = {
  ...SALES_ROUTE_PERMS,
  '/settings/users': 'platform.users.manage',
  ...(FEATURE_INVENTORY_PERMS ? INVENTORY_ROUTE_PERMS : { '/inventory/opening': 'platform.import.run' }),
  '/settings/import': 'platform.import.run',
  '/masters/import': 'platform.import.run',
  ...masterRoutePerms,
  '/audit': 'reports.view',
};

export const hasPerm = (perms: readonly string[] | null | undefined, perm?: string | null): boolean =>
  !perm || !!perms && (perms.includes('*') || perms.includes(perm));

const norm = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);
export const routePermFor = (pathname: string): string | undefined => ROUTE_PERMS[norm(pathname)];
export const NO_ACCESS_PATH = '/no-access';
