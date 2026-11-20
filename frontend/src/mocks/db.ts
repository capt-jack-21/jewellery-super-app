/**
 * In-memory mock "server" state (MSW). Persisted to localStorage in the browser so full page loads keep
 * data; plain memory in tests. Shapes follow contracts/backend.openapi.yaml (0.3.0). Versioned rows carry
 * `version` (If-Match); print templates `row_version`. All values fictional.
 */
import type {
  AuditEvent, BankAccount, Branch, Company, CustomDomain, Device, GstConfig, ImportJob, ImportMappingProfile, Invoice, Metal, MetalRate, Partner, PartnerUser, PrintTemplate,
  Purity, RoleAssignment, SalesPolicy, Setting, Subscription, Tag, TaxRule, Tenant, ThemeInput, User,
} from '@/lib/api/backend/model';

export const TENANT_ID = '01920000-0000-7000-8000-00000000a001';
export const PARTNER_ID = '01920000-0000-7000-8000-00000000b001';
export const COMPANY_ID = '01920000-0000-7000-8000-00000000c001';
export const BRANCH_ID = '01920000-0000-7000-8000-000000000001';
const id = (n: number) => `01920000-0000-7000-8000-${String(n).padStart(12, '0')}`;

export interface MockUser extends Omit<User, 'version'> { version: number; password: string; otp: boolean }
export interface MockPartnerUser extends PartnerUser { password: string }
export interface MockBankAccount extends BankAccount { account_no_enc: string }
export interface StepState { status: 'pending' | 'in_progress' | 'completed' | 'skipped'; completed_at?: string | null }
export interface MockState {
  session: { id: string; user_id: string; device_id: string | null } | null;
  otpChallenge: { id: string; user_id: string } | null;
  otpFailures: number;
  admin: { email: string; password: string; name: string };
  adminSignedIn: boolean;
  /** Partner session (stands in for the httpOnly `psid` cookie). */
  partnerSession: { id: string; user_id: string } | null;
  partnerUsers: MockPartnerUser[];
  bankAccounts: MockBankAccount[];
  tenant: Tenant;
  users: MockUser[];
  companies: Company[];
  branches: Branch[];
  devices: Array<Device & { device_key?: string }>;
  settings: Setting[];
  salesPolicy: SalesPolicy[];
  gstConfig: GstConfig[];
  taxRules: TaxRule[];
  /** 0.4.4 replace idempotency: key → stored request hash + response. */
  replaceIdem?: Record<string, { hash: string; status: number; body: unknown }>;
  rateBatchIdem?: Record<string, { hash: string; body: unknown }>;
  metals: Metal[];
  purities: Purity[];
  rates: MetalRate[];
  tags: Tag[];
  invoices: Invoice[];
  series: number;
  idem: Record<string, string>;
  onboarding: Record<string, StepState>;
  theme: { platform: ThemeInput; partner: ThemeInput; tenant: ThemeInput };
  themeVersion: { partner: number | null; tenant: number | null };
  domains: CustomDomain[];
  partnerDomains: CustomDomain[];
  templates: PrintTemplate[];
  audit: AuditEvent[];
  imports: ImportJob[];
  profiles: ImportMappingProfile[];
  tenants: Tenant[];
  partners: Partner[];
  subscriptions: Subscription[];
}

const daysAgo = (d: number, h = 10) => new Date(Date.now() - d * 864e5 - h * 36e5).toISOString();
const owner: RoleAssignment[] = [{ role: 'owner' }];

const istDate = (iso: string) => new Date(new Date(iso).getTime() + 5.5 * 36e5).toISOString().slice(0, 10);

export function seed(): MockState {
  const users: MockUser[] = [
    { id: id(101), name: 'Meena R', username: 'owner', phone: '9840000001', is_active: true, roles: owner, language: null, default_branch_id: BRANCH_ID, created_at: daysAgo(90), version: 1, password: 'Password@123', otp: true },
    { id: id(102), name: 'Karthik S', username: 'karthik', phone: '9840000002', is_active: true, roles: [{ role: 'manager', branch_id: BRANCH_ID }], language: 'ta', default_branch_id: BRANCH_ID, created_at: daysAgo(80), version: 1, password: 'Password@123', otp: false },
    { id: id(103), name: 'Divya P', username: 'divya', is_active: true, roles: [{ role: 'cashier', branch_id: BRANCH_ID }], language: null, default_branch_id: BRANCH_ID, created_at: daysAgo(30), version: 1, password: 'Password@123', otp: false },
  ];
  const gold = id(301), silver = id(302);
  const p22 = id(311), p24 = id(312), p18 = id(313), s925 = id(314);
  const tenant: Tenant = { version: 1, id: TENANT_ID, partner_id: PARTNER_ID, slug: 'demo-jewellers', display_name: 'Demo Jewellers', status: 'active', deployment_mode: 'shared', default_language: 'en', created_at: daysAgo(90) };
  const done = (d: number): StepState => ({ status: 'completed', completed_at: daysAgo(d) });
  return {
    session: null,
    otpChallenge: null,
    otpFailures: 0,
    admin: { email: 'admin@platform.example', password: 'Password@123', name: 'Platform Admin' },
    adminSignedIn: false,
    partnerSession: null,
    partnerUsers: [
      { id: id(1201), partner_id: PARTNER_ID, name: 'Ravi Partner', email: 'admin@reseller.example', role: 'partner_admin', is_active: true, version: 1, created_at: daysAgo(100), password: 'Password@123' },
    ],
    bankAccounts: [
      { id: id(1301), version: 1, owner_type: 'company', company_id: COMPANY_ID, bank_name: 'State Bank of India', branch_name: 'T. Nagar', ifsc: 'SBIN0001234', holder_name: 'Demo Jewellers Private Limited',
        account_last4: '4321', is_default: true, print_on_invoice: true, is_active: true, created_at: daysAgo(60), account_no_enc: 'enc:…' },
    ] as MockBankAccount[],
    tenant,
    users,
    companies: [{ version: 1, id: COMPANY_ID, legal_name: 'Demo Jewellers Private Limited', trade_name: 'Demo Jewellers', gstin: '33AABCD1234E1Z5', pan: 'AABCD1234E', state_code: '33',
      address: { line1: '12 Bazaar Street', line2: 'T. Nagar', city: 'Chennai', pincode: '600017' }, created_at: daysAgo(90) }],
    branches: [{ version: 1, bill_series_prefix: 'TN', id: BRANCH_ID, company_id: COMPANY_ID, code: 'MAIN', name: 'T. Nagar', state_code: '33', gstin: null, is_active: true,
      address: { line1: '12 Bazaar Street', city: 'Chennai', pincode: '600017' }, created_at: daysAgo(90) }],
    devices: [
      { id: id(401), name: 'Counter 1', kind: 'billing_counter', branch_id: BRANCH_ID, status: 'approved', approved_at: daysAgo(20), last_seen_at: daysAgo(0, 1), live_sessions: 1, created_at: daysAgo(20), device_key: 'mock-approved-device-key-000000000001' },
      { id: id(402), name: 'Counter 2 (tablet)', kind: 'tablet', branch_id: BRANCH_ID, status: 'pending', live_sessions: 0, created_at: daysAgo(0, 3) },
    ],
    settings: [
      { key: 'auth.session_timeout_minutes', value: 30, default_value: 30, value_type: 'integer', source: 'platform', tenant_overridable: true, description: 'Idle sign-out after N minutes' },
      { key: 'sales.pan_required_above', value: '200000.00', default_value: '200000.00', value_type: 'text', source: 'platform', tenant_overridable: true, description: 'PAN required for cash bills above this amount' },
    ] as Setting[],
    salesPolicy: [{ id: id(201), scope: 'tenant', making_gst_treatment: 'composite', old_gold_valuation_basis: 'stated_purity', old_gold_excess_handling: 'separate_purchase',
      credit_note_rounding: 'follow_invoice', return_settlement_default: 'store_credit', return_window_days: 7, effective_from: '2026-04-01' }] as unknown as SalesPolicy[],
    gstConfig: [{ id: id(501), company_id: COMPANY_ID, registration_type: 'regular', tax_inclusive: false, rounding_level: 'invoice', round_off_unit: '1.00', einvoice_enabled: false, einvoice_from: null, b2c_qr: false, effective_from: '2026-04-01', effective_to: null }] as GstConfig[],
    taxRules: [
      { id: id(511), scope: 'platform', code: 'GOLD_JEWELLERY', description: 'Articles of jewellery of precious metal', component: 'metal', metal_code: 'GOLD', code_type: 'HSN', hsn_sac: '7113', rate: '3', cgst_rate: '1.5', sgst_rate: '1.5', igst_rate: '3', cess_rate: '0', composite_supply: false, principal_component: null, reverse_charge: false, effective_from: '2017-07-01', effective_to: null, in_use: true },
      { id: id(512), scope: 'platform', code: 'SILVER_JEWELLERY', description: null, component: 'metal', metal_code: 'SILVER', code_type: 'HSN', hsn_sac: '7113', rate: '3', cgst_rate: '1.5', sgst_rate: '1.5', igst_rate: '3', cess_rate: '0', composite_supply: false, principal_component: null, reverse_charge: false, effective_from: '2017-07-01', effective_to: null, in_use: false },
      { id: id(513), scope: 'platform', code: 'JOB_WORK', description: 'Job work on jewellery', component: 'making', metal_code: null, code_type: 'SAC', hsn_sac: '998892', rate: '5', cgst_rate: '2.5', sgst_rate: '2.5', igst_rate: '5', cess_rate: '0', composite_supply: false, principal_component: null, reverse_charge: false, effective_from: '2017-07-01', effective_to: null, in_use: false },
    ] as TaxRule[],
    metals: [{ id: gold, code: 'GOLD', name: 'Gold', default_hsn: '7113', version: 1, is_active: true }, { id: silver, code: 'SILVER', name: 'Silver', default_hsn: '7113', version: 1, is_active: true }],
    purities: [
      { id: p24, metal_id: gold, code: '24K', fineness: '999.900', huid_required: true, header_visible: true, version: 1, is_active: true }, { id: p22, metal_id: gold, code: '22K', fineness: '916.000', huid_required: true, header_visible: true, version: 1, is_active: true },
      { id: p18, metal_id: gold, code: '18K', fineness: '750.000', huid_required: true, header_visible: false, version: 1, is_active: true }, { id: s925, metal_id: silver, code: '925', fineness: '925.000', huid_required: false, header_visible: false, version: 1, is_active: true },
    ],
    rates: [
      { id: id(601), purity_id: p22, kind: 'sale', rate_per_g: '11450.00', rate_date: istDate(daysAgo(1, 0)), branch_id: null, effective_from: daysAgo(1, 0) },
      { id: id(602), purity_id: p24, kind: 'sale', rate_per_g: '12490.00', rate_date: istDate(daysAgo(1, 0)), branch_id: null, effective_from: daysAgo(1, 0) },
      { id: id(603), purity_id: s925, kind: 'sale', rate_per_g: '165.00', rate_date: istDate(daysAgo(1, 0)), branch_id: null, effective_from: daysAgo(1, 0) },
      { id: id(604), purity_id: p22, kind: 'old_metal', rate_per_g: '11200.00', rate_date: istDate(daysAgo(1, 0)), branch_id: null, effective_from: daysAgo(1, 0) },
    ] as MetalRate[],
    tags: [
      { id: id(701), tag_no: 'G22-000101', status: 'in_stock', sellable: true, branch_id: BRANCH_ID, purity_id: p22, huid: 'AB12CD', gross_wt: '24.350', stone_wt: '0.850', net_wt: '23.500', mc_type: 'per_gram', mc_value: '450.00', wastage_pct: '8' },
      { id: id(702), tag_no: 'S925-000040', status: 'in_stock', sellable: true, branch_id: BRANCH_ID, purity_id: s925, huid: null, gross_wt: '62.100', stone_wt: '0.000', net_wt: '62.100', mc_type: 'flat', mc_value: '800.00', wastage_pct: '0' },
    ] as Tag[],
    invoices: [],
    series: 1,
    idem: {},
    // Today's rates (step 6) is derived from published rates; the rest are stored progress.
    onboarding: { shop_profile: done(90), gst: done(90), branches: done(90), metals_purities: done(89), gst_rates: done(89), users_roles: done(80), branding: { status: 'pending' }, printers_language: { status: 'pending' }, import: { status: 'skipped', completed_at: daysAgo(80) } },
    theme: {
      platform: { app_name: 'Jewellery SaaS', colors: {}, login_text: { en: { title: 'Sign in' }, ta: { title: 'உள்நுழைக' } }, support_contact: {} },
      partner: { app_name: 'Demo Reseller Suite', colors: {} },
      tenant: { app_name: 'Demo Jewellers', colors: {} },
    },
    themeVersion: { partner: 1, tenant: null },
    domains: [{ id: id(801), hostname: 'billing.demo-jewellers.example', status: 'verified', tls_status: 'active', verified_at: daysAgo(30), created_at: daysAgo(31) }],
    partnerDomains: [],
    templates: [
      { id: id(901), doc_type: 'invoice', paper: 'A4', print_language: 'ta', numeral_system: 'latin', body_key: 'templates/invoice-a4.hbs', config: { bilingual: true, show_logo: true }, version: 3, row_version: 2, is_active: true, created_at: daysAgo(20) },
      { id: id(902), doc_type: 'estimate', paper: 'thermal_80mm', print_language: 'ta', numeral_system: 'tamil', body_key: 'templates/estimate-80.hbs', config: {}, version: 1, row_version: 1, is_active: true, created_at: daysAgo(20) },
      { id: id(903), doc_type: 'receipt', paper: 'A5', print_language: 'en', numeral_system: 'latin', body_key: 'templates/receipt-a5.hbs', config: {}, version: 1, row_version: 1, is_active: false, created_at: daysAgo(10) },
    ] as PrintTemplate[],
    audit: seedAudit(users),
    imports: [],
    profiles: [
      { id: id(1401), version: 1, kind: 'customers', name: 'Other app — customers export', mapping: { name: 'Customer Name', phone: 'Mobile No' }, created_by: id(101), created_at: daysAgo(40) },
    ],
    tenants: [
      tenant,
      { version: 1, id: id(1002), partner_id: PARTNER_ID, slug: 'kaveri-gold', display_name: 'Kaveri Gold House', status: 'active', deployment_mode: 'shared', default_language: 'ta', created_at: daysAgo(60) },
      { version: 1, id: id(1003), partner_id: PARTNER_ID, slug: 'thanga-maligai', display_name: 'Thanga Maligai', status: 'trial', deployment_mode: 'shared', default_language: 'ta', created_at: daysAgo(5) },
      { version: 1, id: id(1004), partner_id: null, slug: 'silver-line', display_name: 'Silver Line Ornaments', status: 'suspended', deployment_mode: 'shared', default_language: 'en', suspended_at: daysAgo(3), suspend_reason: 'Unpaid', created_at: daysAgo(200) },
    ],
    partners: [{ id: PARTNER_ID, slug: 'demo-reseller', legal_name: 'Demo Reseller Suite LLP', gstin: '33AAAFD9999K1Z2', status: 'active', created_at: daysAgo(120) }],
    subscriptions: [
      { id: id(1101), tenant_id: TENANT_ID, plan_code: 'standard', status: 'active', billing_cycle: 'monthly', current_period_start: '2026-10-01', current_period_end: '2026-10-31' },
      { id: id(1102), tenant_id: id(1002), plan_code: 'pro', status: 'active', billing_cycle: 'yearly', current_period_start: '2026-04-01', current_period_end: '2027-03-31' },
      { id: id(1103), tenant_id: id(1003), plan_code: 'trial', status: 'trial', billing_cycle: 'monthly', current_period_start: '2026-10-19', current_period_end: '2026-11-02' },
    ],
  };
}

function seedAudit(users: MockUser[]): AuditEvent[] {
  const acts: Array<[string, string]> = [
    ['auth.login', 'user_session'], ['rates.publish', 'metal_rate'], ['sales.invoice.issue', 'invoice'], ['settings.sales_policy.create', 'sales_policy'],
    ['device.approve', 'device'], ['print.reprint', 'invoice'], ['user.create', 'app_user'], ['sales.invoice.cancel', 'invoice'],
  ];
  return Array.from({ length: 24 }, (_, i) => {
    const [action, table] = acts[i % acts.length] ?? ['auth.login', 'user_session'];
    return { seq: 1000 - i, occurred_at: daysAgo(Math.floor(i / 4), i % 9), user_id: users[i % 3]?.id ?? null, branch_id: BRANCH_ID, ip: `10.0.0.${10 + (i % 5)}`, action, table_name: table, row_id: id(2000 + i), hash: (1000 - i).toString(16).padStart(64, '0') };
  });
}

const KEY = 'mock-server-state-v4';
const canPersist = () => typeof window !== 'undefined' && typeof localStorage !== 'undefined' && !import.meta.env.VITEST;
let state: MockState = load();
function load(): MockState {
  if (canPersist()) {
    const raw = localStorage.getItem(KEY);
    if (raw) { try { return JSON.parse(raw) as MockState; } catch { /* reseed */ } }
  }
  return seed();
}
export const db = () => state;
export function save() { if (canPersist()) localStorage.setItem(KEY, JSON.stringify(state)); }
export function resetMockServer(next: Partial<MockState> = {}) { state = { ...seed(), ...next }; save(); }
export function audit(action: string, table_name: string, row_id: string | null = null) {
  const seq = (state.audit[0]?.seq ?? 0) + 1;
  state.audit.unshift({ seq, occurred_at: new Date().toISOString(), user_id: state.session?.user_id ?? null, branch_id: BRANCH_ID, ip: '10.0.0.10', action, table_name, row_id, hash: seq.toString(16).padStart(64, '0') });
}
