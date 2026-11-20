// @vitest-environment node
// Node env so FormData/fetch are undici end to end (jsdom's FormData is sent as "[object FormData]").
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { handlers, mockRolePerms, resetMockServer } from './handlers';
import { routePermFor } from '@/lib/permissions';
import { ApiError, ifMatch, ok } from '@/lib/api/fetcher';
import { login, verifyOtp } from '@/lib/api/backend/auth/auth';
import { issueInvoice } from '@/lib/api/backend/sales/sales';
import { getOnboarding } from '@/lib/api/backend/onboarding/onboarding';
import {
  createBranch, createCompanyBankAccount, deleteCompanyBankAccount, getTenant, listCompanyBankAccounts, updateBranch, updateTenant,
} from '@/lib/api/backend/tenant/tenant';
import { partnerGetSession, partnerListTenants, partnerLogin } from '@/lib/api/backend/partner/partner';
import { activatePrintTemplate, createPrintTemplate } from '@/lib/api/backend/branding/branding';
import { commitImport, createImport, createImportMappingProfile, deleteImportMappingProfile } from '@/lib/api/backend/import/import';
import { createMetal, createPurity, listMetals, listPurities, updateMetal, updatePurity } from '@/lib/api/backend/masters/masters';
import { adminCreateTenant, adminLogin } from '@/lib/api/backend/admin/admin';
import { getCurrentRates, listRateHistory, publishRate } from '@/lib/api/backend/rates/rates';
import { getMeta, listLanguages } from '@/lib/api/backend/auth/auth';
import { updateMe } from '@/lib/api/backend/users/users';
import { getCurrentDevice } from '@/lib/api/backend/devices/devices';
import { closeGstConfig, closeTaxRule, createGstConfig, createTaxRule, listGstConfig, listTaxRules, replaceGstConfig, replaceTaxRule } from '@/lib/api/backend/settings/settings';
import type { GstConfigInput, TaxRuleInput } from '@/lib/api/backend/model';
import { clientTooOld } from '@/lib/version';
import type { OtpChallenge } from '@/lib/api/backend/model';
import { uuid } from '@/lib/uuid';
import { BRANCH_ID, COMPANY_ID, db } from './db';

// The fetcher uses same-origin relative URLs; give node's fetch an origin.
const IK = () => ({ 'Idempotency-Key': uuid() });
const server = setupServer(...handlers);
beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
  const mswFetch = globalThis.fetch; // installed by listen()
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => mswFetch(typeof input === 'string' && input.startsWith('/') ? `http://localhost${input}` : input, init);
});
afterAll(() => server.close());
beforeEach(() => resetMockServer());

const DEVICE = 'mock-approved-device-key-000000000001';
const fail = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as ApiError; } throw new Error('expected failure'); };
async function signInOwner() {
  const res = await login({ login: 'owner', password: 'Password@123', device_key: DEVICE });
  expect(res.status).toBe(202);
  await ok(verifyOtp({ challenge_id: (res.data as OtpChallenge).challenge_id, code: '123456', device_key: DEVICE }));
}
const tagId = () => db().tags[0]?.id ?? '';
const bill = (key: string, extra: Record<string, unknown> = {}) =>
  issueInvoice({ branch_id: BRANCH_ID, salesperson_id: BRANCH_ID, customer: { name: 'Lakshmi', phone: '9840000001' }, lines: [{ kind: 'tag', tag_id: tagId() }], payments: [{ mode: 'cash', amount: '1000.00' }], ...extra } as never, { 'Idempotency-Key': key });
const publishToday = () => { const s = db(); for (const r of s.rates) { r.effective_from = new Date().toISOString(); r.rate_date = new Date(Date.now() + 5.5 * 36e5).toISOString().slice(0, 10); } };

describe('mock server: auth', () => {
  it('rejects a wrong password and a wrong OTP; protected routes 401 until OTP', async () => {
    expect((await fail(ok(login({ login: 'owner', password: 'nope' })))).code).toBe('invalid_credentials');
    const res = await login({ login: 'owner', password: 'Password@123' });
    expect((await fail(ok(getOnboarding()))).isUnauthorized).toBe(true);
    const challenge_id = (res.data as OtpChallenge).challenge_id;
    expect((await fail(ok(verifyOtp({ challenge_id, code: '000000' })))).code).toBe('otp_invalid');
    await ok(verifyOtp({ challenge_id, code: '123456' }));
    expect((await ok(getOnboarding())).steps.length).toBe(10);
  });
});

describe('mock server: billing gate = shop_profile, gst, metals_purities, gst_rates, todays_rates', () => {
  beforeEach(signInOwner);
  it('flags exactly the five gate steps and matches the wizard', async () => {
    const { BILLING_GATE_IDS, billingGate } = await import('@/features/setup/steps');
    const ob = await ok(getOnboarding());
    expect(new Set(ob.steps.filter((s) => s.required_for_billing).map((s) => s.code))).toEqual(new Set(['shop_profile', 'gst', 'metals_purities', 'gst_rates', 'todays_rates']));
    expect(new Set(BILLING_GATE_IDS)).toEqual(new Set(['shop_profile', 'gst', 'metals_purities', 'gst_rates', 'todays_rates']));
    expect(billingGate(ob).serverMismatch).toEqual([]);
  });
  it('only todays_rates missing → locked; optional steps never block', async () => {
    const ob = await ok(getOnboarding());
    expect(ob.missing_billing_steps).toEqual(['todays_rates']);
    expect(ob.billing_unlocked).toBe(false);
    publishToday();
    const after = await ok(getOnboarding());
    expect(after.billing_unlocked).toBe(true);
    expect(after.steps.find((s) => s.code === 'branding')?.status).toBe('pending');
  });
});

describe('mock server: invoice rules (INV-1)', () => {
  beforeEach(async () => { await signInOwner(); publishToday(); });
  it('server assigns the number; replays with the same Idempotency-Key return the same invoice', async () => {
    const a = await ok(bill('k1'));
    const again = await ok(bill('k1'));
    expect(a.doc_no).toMatch(/\/\d{6}$/);
    expect(again.doc_no).toBe(a.doc_no);
    expect((await fail(ok(bill('k2')))).code).toBe('tag_not_sellable');
  });
  it('rejects client-supplied numbers and dates', async () => {
    expect((await fail(ok(bill('k3', { doc_no: 'X/1' })))).code).toBe('client_supplied_doc_number');
    expect((await fail(ok(bill('k4', { doc_date: '2026-01-01' })))).code).toBe('client_supplied_doc_date');
  });
});

describe('mock server: platform rules', () => {
  beforeEach(signInOwner);
  it('branch GSTIN optional in-state, required out of state', async () => {
    const inState = await ok(createBranch({ company_id: COMPANY_ID, code: 'CBE', name: 'Coimbatore', state_code: '33', bill_series_prefix: 'CBE' }));
    expect(inState.gstin ?? null).toBeNull();
    expect((await fail(ok(createBranch({ company_id: COMPANY_ID, code: 'BLR', name: 'Bengaluru', state_code: '29', bill_series_prefix: 'BLR' })))).code).toBe('branch_gstin_required');
  });
  it('print settings accept en/ta only, with native Tamil and no silent unsupported-language fallback', async () => {
    // 0.9.6: language rules still apply to the exempt tag_label path; any Sales doc type create is 422 print_template_not_renderable.
    await ok(createPrintTemplate({ doc_type: 'tag_label', paper: 'label', print_language: 'ta', numeral_system: 'tamil', body_key: 'x' }));
    await ok(createPrintTemplate({ doc_type: 'tag_label', paper: 'label', print_language: 'en', numeral_system: 'latin', body_key: 'x', config: { bilingual: true } }));
    expect((await fail(ok(createPrintTemplate({ doc_type: 'tag_label', paper: 'label', print_language: 'hi' as never, numeral_system: 'tamil', body_key: 'x' })))).code).toBe('validation_failed');
    expect((await fail(ok(createPrintTemplate({ doc_type: 'estimate', paper: 'A4', print_language: 'ta', numeral_system: 'tamil', body_key: 'tpl/platform/estimate.hbs' })))).code).toBe('print_template_not_renderable');
  });
  it('import requires a clean dry run before commit', async () => {
    // CSV text as the multipart `file` part (jsdom's File does not cross into undici's FormData).
    const csv = (rows: string) => `name,phone\n${rows}\n`;
    const bad = await ok(createImport({ kind: 'customers', file: csv(',12') }));
    expect(bad.status).toBe('failed');
    expect((await fail(ok(commitImport(bad.id, { 'Idempotency-Key': 'i1' })))).code).toBe('import_not_clean');
    const good = await ok(createImport({ kind: 'customers', file: csv('Lakshmi,9840000001') }));
    expect(good.status).toBe('validated');
    expect((await ok(commitImport(good.id, { 'Idempotency-Key': 'i2' }))).status).toBe('completed');
  });
});

describe('mock server: 0.3.0 concurrency and new endpoints', () => {
  it('If-Match: 428 when missing, 412 when stale, then the version bumps', async () => {
    await signInOwner();
    const br = db().branches[0];
    if (!br) throw new Error('seed');
    expect((await fail(ok(updateBranch(br.id, { name: 'X' }, {} as never)))).code).toBe('precondition_required');
    expect((await fail(ok(updateBranch(br.id, { name: 'X' }, ifMatch(br.version + 5))))).isStale).toBe(true);
    const next = await ok(updateBranch(br.id, { name: 'X' }, ifMatch(1)));
    expect(next.version).toBe(2);
    const sales = db().templates.find((t) => !t.is_active && t.doc_type !== 'tag_label' && (t.print_language === 'en' || t.print_language === 'ta'));
    if (!sales) throw new Error('seed');
    expect((await fail(ok(activatePrintTemplate(sales.id, ifMatch(sales.row_version))))).code).toBe('print_template_not_renderable'); // 0.9.6 B-2
    const tpl = await ok(createPrintTemplate({ doc_type: 'tag_label', paper: 'label', print_language: 'en', numeral_system: 'latin', body_key: 'labels/qr', config: { barcode_format: 'qr' } }));
    expect((await fail(ok(activatePrintTemplate(tpl.id, ifMatch(tpl.version + 9))))).status).toBe(412);
    expect((await ok(activatePrintTemplate(tpl.id, ifMatch(tpl.row_version)))).is_active).toBe(true);
  });
  it('tenant default language: owner can patch with the ETag version; others get 403', async () => {
    await signInOwner();
    const t = await ok(getTenant());
    expect((await ok(updateTenant({ default_language: 'ta' }, ifMatch(t.version)))).default_language).toBe('ta');
    await ok(login({ login: 'karthik', password: 'Password@123' }));
    expect((await fail(ok(updateTenant({ default_language: 'en' }, ifMatch(t.version + 1))))).isForbidden).toBe(true);
  });
  it('bank accounts return only the last 4 digits', async () => {
    await signInOwner();
    const a = await ok(createCompanyBankAccount(COMPANY_ID, { bank_name: 'HDFC Bank', ifsc: 'HDFC0000123', holder_name: 'Demo', account_no: '50100123456789' }));
    expect(a.account_last4).toBe('6789');
    const list = await ok(listCompanyBankAccounts(COMPANY_ID));
    expect(JSON.stringify(list)).not.toContain('50100123456789');
    const res = await deleteCompanyBankAccount(COMPANY_ID, a.id, ifMatch(a.version));
    expect(res.status).toBe(204);
  });
  it('a mapping profile used by an import cannot be deleted (409 mapping_profile_in_use)', async () => {
    await signInOwner();
    const p = await ok(createImportMappingProfile({ kind: 'customers', name: 'Old app', mapping: { name: 'Customer', phone: 'Mobile' } }));
    const job = await ok(createImport({ kind: 'customers', profile_id: p.id, file: 'Customer,Mobile\nLakshmi,9840000001\n' }));
    expect(job.status).toBe('validated');
    expect((await fail(ok(deleteImportMappingProfile(p.id, ifMatch(p.version))))).code).toBe('mapping_profile_in_use');
  });
  it('partner signs in by slug and gets a psid-style session', async () => {
    expect((await fail(ok(partnerListTenants()))).isUnauthorized).toBe(true);
    expect((await fail(ok(partnerLogin({ partner: 'nope', email: 'admin@reseller.example', password: 'Password@123' })))).code).toBe('invalid_credentials');
    await ok(partnerLogin({ partner: 'demo-reseller', email: 'admin@reseller.example', password: 'Password@123' }));
    expect((await ok(partnerGetSession())).user.role).toBe('partner_admin');
    expect((await ok(partnerListTenants())).map((t) => t.display_name)).toContain('Kaveri Gold House');
  });
});

describe('mock server: 0.3.x transport rules', () => {
  it('import multipart sends kind, branch_id, profile_id before the file part', async () => {
    await signInOwner();
    let names: string[] = [];
    server.use(http.post('*/api/v1/imports', async ({ request }) => {
      names = [...(await request.text()).matchAll(/name="([^"]+)"/g)].map((m) => m[1] ?? '');
      return HttpResponse.json({ id: 'x', kind: 'stock', dry_run: true, status: 'validated' }, { status: 201 });
    }, { once: true }));
    await ok(createImport({ kind: 'stock', branch_id: BRANCH_ID, profile_id: '01920000-0000-7000-8000-000000001401', file: 'tag_no\nA1\n' }));
    expect(names).toEqual(['kind', 'branch_id', 'profile_id', 'file']);
  });
  it('429 rate_limited carries Retry-After seconds (OTP)', async () => {
    const res = await login({ login: 'owner', password: 'Password@123' });
    const challenge_id = (res.data as OtpChallenge).challenge_id;
    for (let i = 0; i < 5; i++) expect((await fail(ok(verifyOtp({ challenge_id, code: '000000' })))).code).toBe('otp_invalid');
    const e = await fail(ok(verifyOtp({ challenge_id, code: '000000' })));
    expect([e.status, e.code, e.isRateLimited, e.retryAfter]).toEqual([429, 'rate_limited', true, 60]);
  });
});

describe('mock server: contract 0.4.0', () => {
  it('meta: api 0.4.0, min client 0.3.0 (this client passes); languages list is served', async () => {
    const m = (await getMeta()).data as { api_version: string; min_client_version: string };
    expect(m.api_version).toBe('0.4.4');
    expect(clientTooOld(m.min_client_version)).toBe(false);
    expect((await ok(listLanguages())).map((l) => l.code)).toEqual(['en', 'ta', 'hi', 'te', 'kn', 'ml']);
  });
  it('unknown language → 422 unknown_language (tenant and me)', async () => {
    await signInOwner();
    const t = await ok(getTenant());
    expect((await fail(ok(updateTenant({ default_language: 'xx' }, ifMatch(t.version))))).code).toBe('unknown_language');
    const me = db().users.find((u) => u.username === 'owner');
    expect((await fail(ok(updateMe({ language: 'xx' }, ifMatch(me?.version))))).code).toBe('unknown_language');
  });
  it('masters CRUD: fineness is a decimal string, purities filter by metal_id', async () => {
    await signInOwner();
    const pt = await ok(createMetal({ code: 'PLATINUM', name: 'Platinum', default_hsn: '7113' }, IK()));
    expect((await fail(ok(createMetal({ code: 'PLATINUM', name: 'x', default_hsn: '7113' }, IK())))).code).toBe('duplicate_code');
    const p950 = await ok(createPurity({ metal_id: pt.id, code: 'PT950', fineness: '950' }, IK()));
    expect(p950.fineness).toBe('950.000');
    expect(p950.huid_required).toBe(true);
    expect((await fail(ok(createPurity({ metal_id: pt.id, code: 'BAD', fineness: '1000.5' }, IK())))).status).toBe(422);
    expect((await ok(listPurities({ metal_id: pt.id }))).map((p) => p.code)).toEqual(['PT950']);
    expect((await ok(updatePurity(p950.id, { fineness: '950.5' }, ifMatch(p950.version)))).fineness).toBe('950.500');
    expect((await ok(updateMetal(pt.id, { name: 'Platinum 950' }, ifMatch(pt.version)))).name).toBe('Platinum 950');
    expect(db().onboarding['metals_purities']?.status).toBe('completed');
  });
  it('metal writes need masters.metals.manage (cashier: read yes, write 403, as backend 397dd2e)', async () => {
    await ok(login({ login: 'divya', password: 'Password@123' }));
    expect((await ok(listMetals())).length).toBeGreaterThan(0);
    expect((await fail(ok(createMetal({ code: 'X', name: 'X', default_hsn: '7113' }, IK())))).isForbidden).toBe(true);
  });
  it('roles mirror seeds 982/984: every view for all four roles; manage + kyc.reveal for owner and manager only', () => {
    const areas = ['metals', 'items', 'designs', 'stones', 'making_rules', 'customers', 'vendors', 'staff', 'counters', 'tax', 'payments'];
    for (const role of ['owner', 'manager', 'salesperson', 'cashier']) for (const a of areas) expect(mockRolePerms(role), `${role} ${a}`).toContain(`masters.${a}.view`);
    for (const role of ['owner', 'manager']) {
      for (const a of areas) expect(mockRolePerms(role), `${role} ${a}`).toContain(`masters.${a}.manage`);
      expect(mockRolePerms(role)).toContain('masters.kyc.reveal');
    }
    for (const role of ['salesperson', 'cashier']) {
      expect(mockRolePerms(role).filter((p) => p.endsWith('.manage'))).toEqual([]);
      expect(mockRolePerms(role)).not.toContain('masters.kyc.reveal');
    }
    expect(routePermFor('/masters/customers')).toBe('masters.customers.view');
  });
  it('rates: 2-dp strings, insert-only corrections, branch_id optional', async () => {
    await signInOwner();
    const pid = db().purities[1]?.id ?? '';
    expect((await fail(ok(publishRate({ purity_id: pid, kind: 'sale', rate_per_g: '7250' })))).status).toBe(422);
    const a = await ok(publishRate({ purity_id: pid, kind: 'sale', rate_per_g: '7250.00' }));
    await new Promise((r) => setTimeout(r, 5));
    const b = await ok(publishRate({ purity_id: pid, kind: 'sale', rate_per_g: '7260.00' }));
    expect(a.id).not.toBe(b.id);
    expect(b.rate_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const cur = await ok(getCurrentRates());
    expect(cur.find((r) => r.purity_id === pid && r.kind === 'sale')?.rate_per_g).toBe('7260.00');
    await ok(publishRate({ purity_id: pid, kind: 'sale', rate_per_g: '7300.00', branch_id: BRANCH_ID }));
    expect((await ok(getCurrentRates())).find((r) => r.purity_id === pid && r.kind === 'sale')?.rate_per_g).toBe('7260.00');
    expect((await ok(getCurrentRates({ branch_id: BRANCH_ID }))).find((r) => r.purity_id === pid && r.kind === 'sale')?.rate_per_g).toBe('7300.00');
  });
});

describe('mock server: contract 0.4.1 / 0.4.2', () => {
  it('masters: version + ETag; PATCH needs If-Match (428 missing, 412 stale); version bumps', async () => {
    await signInOwner();
    const gold = (await ok(listMetals()))[0];
    if (!gold) throw new Error('seed');
    expect(gold.version).toBe(1);
    const res = await updateMetal(gold.id, { name: 'Gold' }, ifMatch(gold.version));
    expect(res.status).toBe(200);
    expect((res.headers as Headers).get('ETag')).toBe('"2"');
    expect((await fail(ok(updateMetal(gold.id, { name: 'X' }, {} as never)))).status).toBe(428);
    expect((await fail(ok(updateMetal(gold.id, { name: 'X' }, ifMatch(1))))).status).toBe(412);
  });
  it('deactivate/restore via PATCH {is_active}; lists hide inactive unless include_inactive; inactive_master', async () => {
    await signInOwner();
    const pt = await ok(createMetal({ code: 'PLAT', name: 'Platinum', default_hsn: '7113' }, IK()));
    const p = await ok(createPurity({ metal_id: pt.id, code: 'PT950', fineness: '950' }, IK()));
    const off = await ok(updatePurity(p.id, { is_active: false }, ifMatch(p.version)));
    expect(off.is_active).toBe(false);
    expect((await ok(listPurities({ metal_id: pt.id }))).length).toBe(0);
    expect((await ok(listPurities({ metal_id: pt.id, include_inactive: true }))).map((x) => x.code)).toEqual(['PT950']);
    expect((await fail(ok(publishRate({ purity_id: p.id, kind: 'sale', rate_per_g: '3000.00' })))).code).toBe('inactive_master');
    await ok(updateMetal(pt.id, { is_active: false }, ifMatch(pt.version)));
    expect((await ok(listMetals())).some((m) => m.id === pt.id)).toBe(false);
    expect((await ok(listMetals({ include_inactive: true }))).find((m) => m.id === pt.id)?.is_active).toBe(false);
    expect((await fail(ok(createPurity({ metal_id: pt.id, code: 'PT900', fineness: '900' }, IK())))).code).toBe('inactive_master');
    expect((await fail(ok(createPurity({ metal_id: pt.id, code: 'PT950', fineness: '950' }, IK())))).code).toBe('inactive_master');
    const back = await ok(updateMetal(pt.id, { is_active: true }, ifMatch(pt.version + 1)));
    expect(back.is_active).toBe(true);
    expect((await fail(ok(createPurity({ metal_id: pt.id, code: 'PT950', fineness: '950' }, IK())))).code).toBe('duplicate_code');
  });
  it('rate history: newest first, filters, cursor paging, 422 invalid_cursor', async () => {
    await signInOwner();
    const pid = db().purities[1]?.id ?? '';
    for (const r of ['7000.00', '7100.00', '7200.00']) { await ok(publishRate({ purity_id: pid, kind: 'sale', rate_per_g: r })); await new Promise((x) => setTimeout(x, 3)); }
    const p1 = await ok(listRateHistory({ purity_id: pid, kind: 'sale', limit: 2 }));
    expect(p1.items.map((r) => r.rate_per_g)).toEqual(['7200.00', '7100.00']);
    expect(p1.next_cursor).toBeTruthy();
    const p2 = await ok(listRateHistory({ purity_id: pid, kind: 'sale', limit: 2, cursor: p1.next_cursor ?? '' }));
    expect(p2.items[0]?.rate_per_g).toBe('7000.00');
    expect((await ok(listRateHistory({ purity_id: pid, kind: 'old_metal' }))).items.every((r) => r.kind === 'old_metal')).toBe(true);
    expect((await ok(listRateHistory({ from: '2999-01-01' }))).items).toEqual([]);
    expect((await fail(ok(listRateHistory({ cursor: 'garbage!' })))).code).toBe('invalid_cursor');
  });
  it('admin tenant create: 201 TenantCreated echoes upper-cased prefix; blank → branch code; bad → 422 invalid_bill_series_prefix', async () => {
    await ok(adminLogin({ email: 'admin@platform.example', password: 'Password@123' }));
    const base = (slug: string, pre?: string) => ({ slug, display_name: 'Kovai Gold', company: { legal_name: 'Kovai Gold', state_code: '33' },
      branch: { code: 'MAIN', name: 'Kovai Gold', ...(pre === undefined ? {} : { bill_series_prefix: pre }) }, owner: { name: 'O', username: 'owner1', password: 'Password@123' } });
    expect((await ok(adminCreateTenant(base('kovai-a', 'kg/26-')))).branch.bill_series_prefix).toBe('KG/26-');
    expect((await ok(adminCreateTenant(base('kovai-b')))).branch.bill_series_prefix).toBe('MAIN');
    expect((await fail(ok(adminCreateTenant(base('kovai-c', '/bad'))))).code).toBe('invalid_bill_series_prefix');
  });
});

describe('mock server: contract 0.4.3', () => {
  const day = (n: number) => new Date(Date.now() + n * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const gst = (from: string, extra: Partial<GstConfigInput> = {}): GstConfigInput => ({ registration_type: 'regular', tax_inclusive: false, rounding_level: 'invoice', round_off_unit: '0.10', effective_from: from, ...extra });
  const rule = (from: string, extra: Partial<TaxRuleInput> = {}): TaxRuleInput => ({ code: 'GOLD_T', component: 'metal', code_type: 'HSN', hsn_sac: '7113', rate: '3', cgst_rate: '1.5', sgst_rate: '1.5', igst_rate: '3', effective_from: from, ...extra });
  it('devices/current: unregistered is 200 null', async () => {
    await signInOwner();
    const s = db().session; if (s) s.device_id = null;
    const res = await getCurrentDevice();
    expect(res.status).toBe(200);
    expect(res.data).toBeNull();
  });
  it('gst-config: close + new period; overlap 409; making_treatment 422; unknown_company 422; bad round-off 422', async () => {
    await signInOwner();
    const [cur] = await ok(listGstConfig());
    if (!cur) throw new Error('seed');
    expect('making_treatment' in cur).toBe(false);
    expect((await fail(ok(createGstConfig(gst(day(1)))))).code).toBe('overlapping_period');
    await ok(closeGstConfig(cur.id, { effective_to: day(1) }));
    const next = await ok(createGstConfig(gst(day(1))));
    expect(next.round_off_unit).toBe('0.10');
    expect((await ok(listGstConfig())).find((g) => g.id === cur.id)?.effective_to).toBe(day(1));
    expect((await fail(ok(createGstConfig({ ...gst(day(5)), making_treatment: 'composite' } as never)))).status).toBe(422);
    expect((await fail(ok(createGstConfig(gst(day(5), { company_id: '00000000-0000-4000-8000-00000000dead' }))))).code).toBe('unknown_company');
    expect((await fail(ok(createGstConfig(gst(day(5), { round_off_unit: '10.00' as never }))))).status).toBe(422);
    expect((await fail(ok(closeGstConfig(next.id, { effective_to: day(-1) })))).status).toBe(422);
  });
  it('tax-rules: platform rules are read-only (403 platform_rule); in_use exposed; tenant close + new; composite needs principal', async () => {
    await signInOwner();
    const plat = (await ok(listTaxRules())).find((r) => r.scope === 'platform' && r.in_use);
    if (!plat) throw new Error('seed');
    expect((await fail(ok(closeTaxRule(plat.id, { effective_to: day(1) })))).code).toBe('platform_rule');
    expect((await fail(ok(createTaxRule(rule(day(0), { composite_supply: true }))))).status).toBe(422);
    const a = await ok(createTaxRule(rule(day(0), { composite_supply: true, principal_component: 'metal' })));
    expect(a).toMatchObject({ scope: 'tenant', in_use: false, principal_component: 'metal' });
    expect((await fail(ok(createTaxRule(rule(day(2)))))).code).toBe('overlapping_period');
    await ok(closeTaxRule(a.id, { effective_to: day(2) }));
    expect((await ok(createTaxRule(rule(day(2), { rate: '5', cgst_rate: '2.5', sgst_rate: '2.5', igst_rate: '5' })))).rate).toBe('5');
  });
});

describe('mock server: contract 0.4.4 (atomic replace)', () => {
  const day = (n: number) => new Date(Date.now() + n * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const K = (n: number) => `test-key-000000000000-${n}`;
  const rr = (from: string, rate = '5') => ({ code: 'MINE', code_type: 'HSN' as const, hsn_sac: '7113', rate, cgst_rate: String(Number(rate) / 2), sgst_rate: String(Number(rate) / 2), igst_rate: rate, effective_from: from });
  it('gst-config replace: 201 pair, carries b2c_qr, stored replay, key reuse 422, natural replay 200, already_replaced 409', async () => {
    await signInOwner();
    const [cur] = await ok(listGstConfig());
    if (!cur) throw new Error('seed');
    const body = { registration_type: 'regular' as const, tax_inclusive: false, rounding_level: 'invoice' as const, round_off_unit: '0.50' as const, b2c_qr: true, effective_from: day(1) };
    const first = await replaceGstConfig(cur.id, body, { 'Idempotency-Key': K(1) });
    expect(first.status).toBe(201);
    const pair = first.data as { replaced: { effective_to: string }; created: { id: string; b2c_qr: boolean; company_id: string | null } };
    expect(pair.replaced.effective_to).toBe(day(1));
    expect(pair.created).toMatchObject({ b2c_qr: true, company_id: cur.company_id });
    const again = await replaceGstConfig(cur.id, body, { 'Idempotency-Key': K(1) });
    expect(again.status).toBe(201);
    expect((again.data as typeof pair).created.id).toBe(pair.created.id);
    expect((await fail(ok(replaceGstConfig(cur.id, { ...body, b2c_qr: false }, { 'Idempotency-Key': K(1) })))).code).toBe('idempotency_key_reused');
    expect((await replaceGstConfig(cur.id, body, { 'Idempotency-Key': K(2) })).status).toBe(200);
    expect((await fail(ok(replaceGstConfig(cur.id, { ...body, round_off_unit: '0.01' }, { 'Idempotency-Key': K(3) })))).code).toBe('already_replaced');
    expect((await fail(ok(replaceGstConfig(pair.created.id, { ...body, effective_from: day(-1) }, { 'Idempotency-Key': K(4) })))).code).toBe('effective_from_in_past');
  });
  it('tax-rules replace: platform 403; platform code reuse is no overlap; in_use open-ended can be closed/replaced, set end can\'t move', async () => {
    await signInOwner();
    const plat = (await ok(listTaxRules())).find((r) => r.scope === 'platform');
    if (!plat) throw new Error('seed');
    expect((await fail(ok(replaceTaxRule(plat.id, rr(day(1)), { 'Idempotency-Key': K(10) })))).code).toBe('platform_rule');
    const copy = await ok(createTaxRule({ ...rr(day(0), '3'), code: plat.code, component: plat.component, ...(plat.metal_code ? { metal_code: plat.metal_code } : {}), hsn_sac: plat.hsn_sac }));
    expect(copy.scope).toBe('tenant');
    const row = db().taxRules.find((t) => t.id === copy.id);
    if (!row) throw new Error('row');
    row.in_use = true;
    const res = await ok(replaceTaxRule(copy.id, { ...rr(day(1)), code: plat.code, hsn_sac: plat.hsn_sac }, { 'Idempotency-Key': K(11) }));
    expect(res.replaced.effective_to).toBe(day(1));
    expect(res.created).toMatchObject({ component: plat.component, rate: '5', in_use: false });
    expect((await fail(ok(closeTaxRule(copy.id, { effective_to: day(3) })))).code).toBe('rule_in_use');
    const open = await ok(createTaxRule({ ...rr(day(0)), hsn_sac: '7114', component: 'metal' }));
    const o = db().taxRules.find((t) => t.id === open.id);
    if (o) o.in_use = true;
    expect((await ok(closeTaxRule(open.id, { effective_to: day(2) }))).effective_to).toBe(day(2));
  });
});

describe('mock server: 0.4.4 replace with optional effective_to', () => {
  const day = (n: number) => new Date(Date.now() + n * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  it('bounded successor; end <= start is 422 invalid_period', async () => {
    await signInOwner();
    const [cur] = await ok(listGstConfig());
    if (!cur) throw new Error('seed');
    const body = { registration_type: 'regular' as const, tax_inclusive: false, rounding_level: 'invoice' as const, round_off_unit: '1.00' as const, effective_from: day(7) };
    expect((await fail(ok(replaceGstConfig(cur.id, { ...body, effective_to: day(7) }, { 'Idempotency-Key': 'test-key-end-000000001' })))).code).toBe('invalid_period');
    const res = await ok(replaceGstConfig(cur.id, { ...body, effective_to: day(30) }, { 'Idempotency-Key': 'test-key-end-000000002' }));
    expect(res.created.effective_to).toBe(day(30));
    expect(res.replaced.effective_to).toBe(day(7));
  });
});
