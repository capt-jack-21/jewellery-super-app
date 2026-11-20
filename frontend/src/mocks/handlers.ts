/**
 * MSW handlers for the backend 0.3.0 contract (flat /v1, prefixed /api by the fetcher). Business rules mirrored:
 * OTP step-up, device approval, 5-step billing gate, server-assigned invoice numbers with Idempotency-Key replay,
 * Latin-only identifiers, If-Match optimistic concurrency (428 missing / 412 stale), partner `psid` session.
 */
import { http, HttpResponse, type JsonBodyType } from 'msw';
import type {
  BankAccountCreate, BankAccountPatch, BranchInput, BranchPatch, ImportMappingProfileInput, ImportMappingProfilePatch, PartnerLoginBody, DeviceRegistration, Invoice, IssueInvoiceRequest, Metal, MetalInput, MetalPatch, MetalRate, MetalRateInput, Purity, PurityInput, PurityPatch, Onboarding, PrintTemplate,
  PrintTemplateInput, PutOnboardingStepBody, RoleAssignment, Session, GstConfig, GstConfigInput, TaxRule, TaxRuleInput, TenantCreate, TenantPatch, ThemeInput, UserPatch,
} from '@/lib/api/backend/model';
import { financialYear } from '@/lib/format/date';
import { D } from '@/lib/format/decimal';
import { audit, BRANCH_ID, COMPANY_ID, db, PARTNER_ID, save, TENANT_ID, type MockPartnerUser, type MockState, type MockUser } from './db';

export { resetMockServer } from './db';
import { mastersHandlers, masterTemplate } from './masters';
import { salesHandlers } from './sales';
import { SEEDED_TEMPLATE_PINS } from '@/features/sales/templates';
export { resetMastersMock } from './masters';

const A = '*/api'; // any origin: same-origin in the browser, http://localhost in node tests
/** platform.language seed (contract 0.4.0). Any other code on a language field → 422 unknown_language. */
export const LANGUAGES = [
  { code: 'en', name: 'English', native_name: 'English' }, { code: 'ta', name: 'Tamil', native_name: 'தமிழ்' },
  { code: 'hi', name: 'Hindi', native_name: 'हिन्दी' }, { code: 'te', name: 'Telugu', native_name: 'తెలుగు' },
  { code: 'kn', name: 'Kannada', native_name: 'ಕನ್ನಡ' }, { code: 'ml', name: 'Malayalam', native_name: 'മലയാളം' },
];
const knownLang = (c: unknown) => c === null || c === undefined || LANGUAGES.some((l) => l.code === c);
const unknownLang = () => problem(422, 'unknown_language', 'Unknown language', [{ field: 'language', message: 'not in platform.language' }]);
const FINENESS = /^[0-9]{1,4}(\.[0-9]{1,3})?$/;
const RATE2 = /^[0-9]{1,10}\.[0-9]{2}$/;
const fineOk = (f: unknown) => typeof f === 'string' && FINENESS.test(f) && D(f).gt(0) && D(f).lte(1000);
const canManageMetals = () => permsOf(meOrThrow().roles).includes('masters.metals.manage');
const canEditSettings = () => permsOf(meOrThrow().roles).includes('platform.settings.edit');
const markMastersStep = () => { if (db().metals.length && db().purities.length) db().onboarding['metals_purities'] = { status: 'completed', completed_at: now() }; };
const uid = () => (globalThis.crypto?.randomUUID?.() ?? `01920000-0000-7000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`);
const now = () => new Date().toISOString();

/* ---------- roles & permissions ---------- */
const MASTER_AREAS = ['metals', 'items', 'designs', 'stones', 'making_rules', 'customers', 'vendors', 'staff', 'counters', 'tax', 'payments'] as const;
export const PERMISSIONS: Array<[string, boolean]> = [
  ['sales.invoice.issue', false], ['sales.estimate.create', false], ['sales.invoice.cancel', true], ['sales.discount.give', true],
  ['rates.publish', true], ['rates.edit', true], ['reports.view', true], ['print.reprint', true], ['platform.settings.edit', false], ['platform.users.manage', false],
  ['platform.devices.approve', false], ['platform.import.run', false], ['platform.audit.view', false],
  // Masters (contract 0.7.0): masters.<area>.manage / .view, plus the audited KYC reveal.
  ...MASTER_AREAS.flatMap((a): Array<[string, boolean]> => [[`masters.${a}.manage`, false], [`masters.${a}.view`, false]]),
  ['masters.kyc.reveal', true],
  // Sales 0.9.1 codes not listed above (owner only in the mock) + the inventory stock view used by the stock summary.
  ['sales.settings.edit', true], ['sales.receipt.reverse', true], ['sales.invoice.view', false], ['sales.invoice.reprint', true], ['sales.return.issue', true], ['sales.payment.receive', false], ['sales.price.override_min', true],
  ['sales.invoice.credit_sale', true], ['sales.old_gold.rate_override', true], ['inventory.stock.view', false],
];
// Mirrors data-model 982/984 seeds: every masters.*.view → owner, manager, salesperson, cashier; .manage + kyc.reveal → owner, manager.
const MASTER_VIEWS = MASTER_AREAS.map((a) => `masters.${a}.view`);
const ROLE_PERMS: Record<string, string[]> = {
  owner: PERMISSIONS.map(([c]) => c),
  manager: ['sales.invoice.issue', 'sales.estimate.create', 'sales.invoice.cancel', 'sales.discount.give', 'rates.publish', 'rates.edit', 'reports.view', 'print.reprint', 'platform.devices.approve', 'platform.import.run',
    ...MASTER_AREAS.map((a) => `masters.${a}.manage`), ...MASTER_VIEWS, 'masters.kyc.reveal'],
  salesperson: ['sales.estimate.create', ...MASTER_VIEWS],
  cashier: ['sales.invoice.issue', 'sales.estimate.create', ...MASTER_VIEWS],
};
/** Test hook: the seed-mirrored role → permission map. */
export const mockRolePerms = (role: string): readonly string[] => ROLE_PERMS[role] ?? [];
const permsOf = (roles: RoleAssignment[]) => [...new Set(roles.flatMap((r) => ROLE_PERMS[r.role] ?? []))];

/* ---------- 5-step billing gate (task 4) ---------- */
export const ONBOARDING_STEPS: Array<{ code: string; title: string; optional: boolean; gate: boolean }> = [
  { code: 'shop_profile', title: 'Shop profile', optional: false, gate: true },
  { code: 'gst', title: 'GST', optional: false, gate: true },
  { code: 'branches', title: 'Branches', optional: true, gate: false },
  { code: 'metals_purities', title: 'Metals & purities', optional: false, gate: true },
  { code: 'gst_rates', title: 'GST rates', optional: false, gate: true },
  { code: 'todays_rates', title: "Today's rates", optional: false, gate: true },
  { code: 'users_roles', title: 'Users & roles', optional: true, gate: false },
  { code: 'branding', title: 'Branding', optional: true, gate: false },
  { code: 'printers_language', title: 'Printers & language', optional: true, gate: false },
  { code: 'import', title: 'Import', optional: true, gate: false },
];
const todayIST = () => new Date(Date.now() + 5.5 * 36e5).toISOString().slice(0, 10);
/** 0.7.4 R1/R9 (migration 985) — rates.v_todays_rate_status. A branch is SET when every active metal with ≥1 active purity has a
 * SALE rate dated today (IST) on one of its active purities, shop-wide or the branch's own. No active metal → not set. old_metal is a warning only. */
function statusRow(branchId: string | null) {
  const today = todayIST();
  const metals = db().metals.filter((m) => m.is_active && db().purities.some((p) => p.metal_id === m.id && p.is_active));
  const has = (metalId: string, kind: string) => db().rates.some((r) => r.kind === kind && r.rate_date === today
    && ((r.branch_id ?? null) === null || (branchId !== null && r.branch_id === branchId))
    && db().purities.some((p) => p.id === r.purity_id && p.metal_id === metalId && p.is_active));
  const missing = metals.filter((m) => !has(m.id, 'sale')).map((m) => m.code);
  const missingOld = metals.filter((m) => !has(m.id, 'old_metal')).map((m) => m.code);
  return { branch_id: branchId, rate_date: today, todays_rate_set: metals.length > 0 && missing.length === 0, missing_metal_codes: missing,
    old_metal_rate_set: metals.length > 0 && missingOld.length === 0, missing_old_metal_codes: missingOld };
}
/** With a branch → its row (null when unknown/inactive → 404). Without → shop summary: every active branch set; missing_* = union; branches[]. */
export function todaysRateStatus(branchId: string | null) {
  if (branchId) return db().branches.some((b) => b.id === branchId && b.is_active) ? statusRow(branchId) : null;
  const rows = db().branches.filter((b) => b.is_active).map((b) => statusRow(b.id));
  const union = (k: 'missing_metal_codes' | 'missing_old_metal_codes') => [...new Set(rows.flatMap((r) => r[k]))];
  return { branch_id: null, rate_date: todayIST(), todays_rate_set: rows.length > 0 && rows.every((r) => r.todays_rate_set), missing_metal_codes: union('missing_metal_codes'),
    old_metal_rate_set: rows.length > 0 && rows.every((r) => r.old_metal_rate_set), missing_old_metal_codes: union('missing_old_metal_codes'), branches: rows };
}
/** In force now: branch_id omitted → tenant-wide rows only; given → branch row beats tenant row. */
function currentRates(branchId: string | null): MetalRate[] {
  const latest = new Map<string, MetalRate>();
  for (const r of db().rates.filter((x) => (x.branch_id ?? null) === null || (branchId !== null && x.branch_id === branchId))) { const k = `${r.purity_id}:${r.kind}`; const p = latest.get(k); const better = !p || (!!r.branch_id && !p.branch_id) || (!!r.branch_id === !!p.branch_id && p.effective_from < r.effective_from); if (better) latest.set(k, r); }
  return [...latest.values()];
}
/** v_billing_unlocked.todays_rate_set = the shop summary value. */
const ratesToday = () => (todaysRateStatus(null) as { todays_rate_set: boolean }).todays_rate_set;
export function onboarding(): Onboarding {
  const steps = ONBOARDING_STEPS.map((s, i) => {
    const st = s.code === 'todays_rates' ? (ratesToday() ? { status: 'completed' as const, completed_at: now() } : { status: 'pending' as const }) : db().onboarding[s.code] ?? { status: 'pending' as const };
    return { code: s.code, seq: i + 1, title: s.title, optional: s.optional, required_for_billing: s.gate, status: st.status, completed_at: st.completed_at ?? null };
  });
  const missing = steps.filter((s) => s.required_for_billing && s.status !== 'completed').map((s) => s.code);
  const next = steps.find((s) => s.status === 'pending' || s.status === 'in_progress');
  return { billing_unlocked: missing.length === 0, missing_billing_steps: missing, complete: !next, next_step: next?.code ?? null, steps } as unknown as Onboarding;
}

/* ---------- helpers ---------- */
const problem = (status: number, code: string, title: string, errors?: Array<{ field: string; message: string }>) =>
  HttpResponse.json({ type: 'about:blank', title, status, code, ...(errors ? { errors } : {}) }, { status, headers: { 'Content-Type': 'application/problem+json' } });
const json = (body: JsonBodyType, status = 200) => { save(); return HttpResponse.json(body, { status }); };
const me = (): MockUser | null => { const s = db().session; return s ? db().users.find((u) => u.id === s.user_id) ?? null : null; };
const publicUser = (u: MockUser) => { const { password: _p, otp: _o, ...rest } = u; return rest; };
const deviceOk = () => { const d = db().devices.find((x) => x.id === db().session?.device_id); return d?.status === 'approved'; };
function session(): Session {
  const u = me() as MockUser; const s = db().session as NonNullable<MockState['session']>;
  return {
    session_id: s.id, tenant_id: TENANT_ID, user: publicUser(u) as Session['user'], auth_method: u.otp ? 'otp' : 'password', device_id: s.device_id,
    billing_enabled: deviceOk(), billing_unlocked: onboarding().billing_unlocked, roles: u.roles, permissions: permsOf(u.roles),
    language: u.language ?? db().tenant.default_language, idle_timeout_minutes: 30, expires_at: new Date(Date.now() + 8 * 36e5).toISOString(),
  } as Session;
}
type R = Parameters<Parameters<typeof http.get>[1]>[0];
const meOrThrow = (): MockUser => { const u = me(); if (!u) throw new Error('unauthenticated'); return u; };
type Span = { effective_from: string; effective_to?: string | null };
const istToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const overlaps = (a: Span, b: Span) => (!a.effective_to || b.effective_from < a.effective_to) && (!b.effective_to || a.effective_from < b.effective_to);
/** Closing sets the exclusive end (>= today IST, > start). in_use rows: only null → date (else 422 rule_in_use). */
const closeError = (row: Span & { in_use?: boolean }, to: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(to ?? '') || to < istToday()) return problem(422, 'effective_to_in_past', 'effective_to must be today or later');
  if (to <= row.effective_from) return problem(422, 'invalid_period', 'effective_to must be after effective_from');
  if (row.in_use && row.effective_to) return problem(422, 'rule_in_use', 'An in-use rule\'s end date cannot be moved');
  row.effective_to = to; return null;
};
/** Tenant tax-rule overlap key: component + metal_code + hsn_sac (+ dates). code is not part of it. */
const sameKey = (a: TaxRule, b: { component: string; metal_code?: string | null; hsn_sac: string }) =>
  a.scope === 'tenant' && a.component === b.component && (a.metal_code ?? null) === (b.metal_code ?? null) && a.hsn_sac === b.hsn_sac;
/**
 * POST …/{id}/replace: atomic close + insert with stored idempotency (same key + same id/body → stored replay;
 * different → 422 idempotency_key_reused). A new key re-sending a completed replace → 200 same pair, else 409 already_replaced.
 */
async function replaceWith<T extends Span & { id: string }>(r: R, rows: T[], route: string,
  check: (old: T, b: Record<string, unknown>) => Response | null, make: (old: T, b: Record<string, unknown>) => T, sameAs: (x: T, b: Record<string, unknown>) => boolean) {
  if (!canEditSettings()) return problem(403, 'forbidden', 'Needs platform.settings.edit');
  const key = r.request.headers.get('Idempotency-Key') ?? '';
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) return problem(422, 'idempotency_key_required', 'Idempotency-Key required');
  const b = await body<Record<string, unknown>>(r);
  const hash = JSON.stringify([route, r.params.id, b]);
  const st = (db().replaceIdem ??= {});
  const stored = st[key];
  if (stored) return stored.hash === hash ? json(stored.body as JsonBodyType, stored.status) : problem(422, 'idempotency_key_reused', 'Idempotency-Key reused with a different request');
  const old = rows.find((x) => x.id === r.params.id); if (!old) return problem(404, 'not_found', 'Not found');
  const from = String(b.effective_from ?? '');
  const succ = rows.find((x) => x.id !== old.id && old.effective_to && x.effective_from === old.effective_to && (x as unknown as { replaces?: string }).replaces === old.id);
  if (succ) return sameAs(succ, b) ? json({ replaced: old, created: succ } as unknown as JsonBodyType, 200) : problem(409, 'already_replaced', 'Already replaced');
  const bad = check(old, b); if (bad) return bad;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || from < istToday()) return problem(422, 'effective_from_in_past', 'effective_from must be today or later');
  if (from <= old.effective_from || (old.effective_to && from > old.effective_to)) return problem(422, 'invalid_period', 'Would overlap the old start or leave a gap');
  if (b.effective_to !== undefined && (typeof b.effective_to !== 'string' || b.effective_to <= from)) return problem(422, 'invalid_period', 'effective_to must be after effective_from');
  const created = make(old, b);
  const others = rows.filter((x) => x.id !== old.id);
  if (others.some((x) => overlaps(x, created) && sameKeyProbe(old, x))) return problem(409, 'overlapping_period', 'Overlaps an existing period');
  old.effective_to = from; (created as unknown as { replaces: string }).replaces = old.id; rows.push(created);
  const res = { replaced: old, created };
  st[key] = { hash, status: 201, body: res };
  return json(res as unknown as JsonBodyType, 201);
}
/** Overlap scope for replace: gst-config rows of the same company; tax rules with the same tenant key. */
const sameKeyProbe = (a: object, b: object) => ('company_id' in a ? (a as GstConfig).company_id === (b as GstConfig).company_id : sameKey(b as TaxRule, a as TaxRule));
const authed = (fn: (r: R) => Response | Promise<Response>) => (r: R) => (me() ? fn(r) : problem(401, 'unauthenticated', 'Sign in required'));
const admin = (fn: (r: R) => Response | Promise<Response>) => (r: R) => (db().adminSignedIn ? fn(r) : problem(401, 'unauthenticated', 'Admin sign-in required'));
const partnerMe = (): MockPartnerUser | null => { const s = db().partnerSession; return s ? db().partnerUsers.find((u) => u.id === s.user_id && u.is_active) ?? null : null; };
const partner = (fn: (r: R) => Response | Promise<Response>) => (r: R) => (partnerMe() ? fn(r) : problem(401, 'unauthenticated', 'Partner sign-in required'));
const publicPartnerUser = (u: MockPartnerUser) => { const { password: _p, ...rest } = u; return rest; };
const partnerSession = () => { const u = partnerMe() as MockPartnerUser; return { session_id: db().partnerSession?.id, partner_id: u.partner_id, user: publicPartnerUser(u), expires_at: new Date(Date.now() + 8 * 36e5).toISOString() }; };
/** If-Match guard: 428 when missing, 412 when stale; returns null when OK (caller then bumps `version`). */
function ifMatch(r: R, current: number | null | undefined, optional = false): Response | null {
  const h = r.request.headers.get('If-Match');
  if (!h) return optional && current == null ? null : problem(428, 'precondition_required', 'If-Match header required');
  return h.replace(/^W\//, '').replace(/"/g, '') === String(current) ? null : problem(412, 'version_mismatch', 'Someone else saved this first; reload and retry');
}
const bump = <T extends { version: number }>(o: T, patch: object) => { Object.assign(o, patch); (o as { version: number }).version += 1; return o; };
const LANGS: Array<[string, string]> = [['en', 'English'], ['ta', 'தமிழ்'], ['hi', 'हिन्दी'], ['te', 'తెలుగు'], ['kn', 'ಕನ್ನಡ'], ['ml', 'മലയാളം']];
const themeView = (scope: 'tenant' | 'partner') => ({
  effective: { ...db().theme.platform, ...db().theme.partner, ...(scope === 'tenant' ? db().theme.tenant : {}) }, own: db().theme[scope], version: db().themeVersion[scope],
} as unknown as JsonBodyType);
/** 429 problem `rate_limited` with Retry-After seconds (contract 0.3.x). Login lockout itself stays 401 invalid_credentials. */
const rateLimited = (seconds: number) => HttpResponse.json({ type: 'about:blank', title: 'Too many requests', status: 429, code: 'rate_limited' },
  { status: 429, headers: { 'Content-Type': 'application/problem+json', 'Retry-After': String(seconds) } });
const body = async <T>(r: R) => (await r.request.json()) as T;
const incInactive = (r: R) => new URL(r.request.url).searchParams.get('include_inactive') === 'true';
/** JSON + ETag from `version` (masters 0.4.2). */
const tagged = (o: { version: number }, status = 200) => { save(); return HttpResponse.json(o as unknown as JsonBodyType, { status, headers: { ETag: `"${o.version}"` } }); };
const LATIN_ID = /^[\x20-\x7E]*$/;

function signIn(u: MockUser, deviceKey?: string) {
  const dev = db().devices.find((d) => d.device_key && d.device_key === deviceKey);
  db().session = { id: uid(), user_id: u.id, device_id: dev?.id ?? null };
  audit('auth.login', 'user_session', db().session?.id ?? null);
}

/* ---------- pricing ---------- */
/** Rough INV-1 pricer for the mock (0.9.1 shapes: tag lines `{kind:'tag', tag_id}`, totals nested). Sales is contract-only on dev. */
function price(req: IssueInvoiceRequest): { lines: Invoice['lines']; totals: Invoice['totals'] } | string {
  const lines: Invoice['lines'] = [];
  let taxable = D('0');
  for (const raw of req.lines) {
    const l = raw as { kind?: string; tag_id?: string; discount?: string };
    const tag = db().tags.find((t) => t.id === l.tag_id);
    if (!tag || tag.status !== 'in_stock') return 'tag_not_sellable';
    const rate = db().rates.filter((r) => r.purity_id === tag.purity_id && r.kind === 'sale').sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0];
    if (!rate) return 'rate_missing';
    const net = D(tag.net_wt);
    const metal = net.mul(D(String(tag.wastage_pct ?? '0')).div(100).add(1)).mul(D(rate.rate_per_g));
    const making = tag.mc_type === 'per_gram' ? net.mul(D(String(tag.mc_value ?? '0'))) : D(String(tag.mc_value ?? '0'));
    const value = metal.add(making).sub(D(String(l.discount ?? '0'))).toDecimalPlaces(2);
    taxable = taxable.add(value);
    lines.push({ kind: 'tag', line_no: lines.length + 1, tag_id: tag.id, tag_no: tag.tag_no, huid: tag.huid ?? null, net_wt: tag.net_wt, rate_per_g: rate.rate_per_g, taxable_value: value.toFixed(2) } as unknown as Invoice['lines'][number]);
  }
  const half = taxable.mul('0.015').toDecimalPlaces(2);
  const gross = taxable.add(half).add(half);
  const total = gross.toDecimalPlaces(0);
  const z = '0.00';
  return { lines, totals: {
    gross_value: taxable.toFixed(2), line_discount: z, bill_discount: z, taxable_value: taxable.toFixed(2), cgst: half.toFixed(2), sgst: half.toFixed(2), igst: z, cess: z,
    tax_total: half.add(half).toFixed(2), round_off: total.sub(gross).toFixed(2), invoice_total: total.toFixed(2), old_metal_value: z, old_gold_excess: z,
    net_payable: total.toFixed(2), paid_amount: total.toFixed(2), balance_due: z, cash_amount: z,
  } };
}

/** Minimal multipart reader: request.formData() is unreliable across jsdom/undici realms in tests. */
async function multipart(req: Request): Promise<{ kind: string; file: string; profile_id?: string; branch_id?: string; order: string[] }> {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(req.headers.get('content-type') ?? '');
  const raw = await req.text(); const out: Record<string, string> = {}; const order: string[] = [];
  const b = boundary?.[1] ?? boundary?.[2];
  if (!b) return { kind: '', file: '', order };
  for (const part of raw.split(`--${b}`)) {
    const name = /name="([^"]+)"/.exec(part)?.[1]; const sep = part.indexOf('\r\n\r\n');
    if (name && sep >= 0) { out[name] = part.slice(sep + 4).replace(/\r\n$/, ''); order.push(name); }
  }
  return { kind: out.kind ?? '', file: out.file ?? '', profile_id: out.profile_id, branch_id: out.branch_id, order };
}

const ok204 = () => { save(); return new HttpResponse(null, { status: 204 }); };

/** 0.9.6 PrintTemplate.renderable: exact release pin (template_id, version, doc_type) or any tag_label row (exempt). */
function mockRenderable096(t: Pick<PrintTemplate, 'id' | 'version' | 'doc_type'>) {
  return t.doc_type === 'tag_label' || SEEDED_TEMPLATE_PINS.some((p) => p.id === t.id && p.version === t.version && p.doc_type === t.doc_type);
}

export const handlers = [
  http.get(`${A}/health`, () => HttpResponse.json({ status: 'ok' })),
  http.get(`${A}/v1/meta`, () => HttpResponse.json({ api_version: '0.4.4', min_client_version: '0.3.0', deployment_mode: 'shared' })),
  http.get(`${A}/v1/meta/languages`, () => HttpResponse.json(LANGUAGES)),

  /* ---- auth ---- */
  http.post(`${A}/v1/auth/login`, async (r) => {
    const b = await body<{ login: string; password: string; device_key?: string }>(r);
    const u = db().users.find((x) => (x.username === b.login || x.phone === b.login) && x.is_active);
    if (!u || u.password !== b.password) return problem(401, 'invalid_credentials', 'Wrong login or password');
    if (u.otp) {
      const challenge = { id: uid(), user_id: u.id }; db().otpChallenge = challenge;
      return json({ challenge_id: challenge.id, channel: 'sms', masked_destination: `******${(u.phone ?? '').slice(-4)}`, expires_at: new Date(Date.now() + 3e5).toISOString() }, 202);
    }
    signIn(u, b.device_key);
    return json(session() as unknown as JsonBodyType);
  }),
  http.post(`${A}/v1/auth/otp/verify`, async (r) => {
    const b = await body<{ challenge_id: string; code: string; device_key?: string }>(r);
    const c = db().otpChallenge;
    if (!c || c.id !== b.challenge_id) return problem(400, 'otp_challenge_invalid', 'OTP expired; sign in again');
    if (b.code !== '123456') {
      db().otpFailures += 1;
      if (db().otpFailures > 5) return rateLimited(60);
      return problem(401, 'otp_invalid', 'Wrong OTP');
    }
    db().otpFailures = 0;
    db().otpChallenge = null;
    signIn(db().users.find((u) => u.id === c.user_id) as MockUser, b.device_key);
    return json(session() as unknown as JsonBodyType);
  }),
  http.get(`${A}/v1/auth/session`, authed(() => json(session() as unknown as JsonBodyType))),
  http.post(`${A}/v1/auth/logout`, () => { db().session = null; return ok204(); }),

  /* ---- onboarding / tenant ---- */
  http.get(`${A}/v1/onboarding`, authed(() => json(onboarding() as unknown as JsonBodyType))),
  http.put(`${A}/v1/onboarding/steps/:step`, authed(async (r) => {
    const code = String(r.params.step); const step = ONBOARDING_STEPS.find((s) => s.code === code);
    if (!step) return problem(404, 'not_found', 'Unknown step');
    const b = await body<PutOnboardingStepBody>(r);
    if (b.status === 'skipped' && !step.optional) return problem(422, 'step_not_skippable', 'This step is required');
    db().onboarding[code] = { status: b.status, completed_at: b.status === 'completed' || b.status === 'skipped' ? now() : null };
    return json(onboarding() as unknown as JsonBodyType);
  })),
  http.get(`${A}/v1/tenant`, authed(() => { save(); return HttpResponse.json(db().tenant as unknown as JsonBodyType, { headers: { ETag: `"${db().tenant.version}"` } }); })),
  http.patch(`${A}/v1/tenant`, authed(async (r) => {
    if (!permsOf(meOrThrow().roles).includes('platform.settings.edit')) return problem(403, 'forbidden', 'Needs platform.settings.edit');
    const g = ifMatch(r, db().tenant.version); if (g) return g;
    const { default_language } = await body<TenantPatch>(r);
    if (!knownLang(default_language)) return unknownLang();
    bump(db().tenant as { version: number }, { default_language }); audit('tenant.update', 'tenant', TENANT_ID); return json(db().tenant as unknown as JsonBodyType);
  })),
  /* ---- company bank accounts (full number stored "encrypted", only last4 ever returned) ---- */
  http.get(`${A}/v1/companies/:companyId/bank-accounts`, authed((r) => { const sp = new URL(r.request.url).searchParams; const q = (sp.get('q') ?? '').trim().toLowerCase(); const ids = sp.has('ids') ? sp.getAll('ids').flatMap((v) => v.split(',')).filter(Boolean) : null;
    return json(db().bankAccounts.filter((b) => b.company_id === r.params.companyId && (!ids || ids.includes(b.id))
      && (!q || [b.bank_name, (b as { branch?: string }).branch, (b as { holder_name?: string }).holder_name, (b as { ifsc?: string }).ifsc, (b as { account_last4?: string }).account_last4].some((x) => String(x ?? '').toLowerCase().includes(q)))).map(({ account_no_enc: _e, ...b }) => b) as unknown as JsonBodyType); })),
  http.post(`${A}/v1/companies/:companyId/bank-accounts`, authed(async (r) => {
    const b = await body<BankAccountCreate>(r);
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(b.ifsc)) return problem(422, 'validation_failed', 'Invalid IFSC', [{ field: 'ifsc', message: 'invalid' }]);
    if (b.is_default) for (const o of db().bankAccounts) o.is_default = false;
    const a = { id: uid(), version: 1, owner_type: 'company', company_id: String(r.params.companyId), bank_name: b.bank_name, branch_name: b.branch_name ?? null, ifsc: b.ifsc, holder_name: b.holder_name,
      account_last4: b.account_no.slice(-4), is_default: !!b.is_default, print_on_invoice: b.print_on_invoice ?? true, is_active: true, created_at: now(), account_no_enc: 'enc:…' };
    db().bankAccounts.push(a as never); audit('bank_account.create', 'bank_account', a.id);
    const { account_no_enc: _e, ...out } = a; return json(out as unknown as JsonBodyType, 201);
  })),
  http.patch(`${A}/v1/companies/:companyId/bank-accounts/:id`, authed(async (r) => {
    const a = db().bankAccounts.find((x) => x.id === r.params.id && x.company_id === r.params.companyId); if (!a) return problem(404, 'not_found', 'Not found');
    const g = ifMatch(r, a.version); if (g) return g;
    const { account_no, ...p } = await body<BankAccountPatch>(r);
    if (p.is_default) for (const o of db().bankAccounts) o.is_default = false;
    bump(a, { ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)), ...(account_no ? { account_last4: account_no.slice(-4) } : {}) });
    const { account_no_enc: _e, ...out } = a; return json(out as unknown as JsonBodyType);
  })),
  http.delete(`${A}/v1/companies/:companyId/bank-accounts/:id`, authed((r) => {
    const i = db().bankAccounts.findIndex((x) => x.id === r.params.id); const a = db().bankAccounts[i]; if (!a) return problem(404, 'not_found', 'Not found');
    const g = ifMatch(r, a.version); if (g) return g;
    db().bankAccounts.splice(i, 1); return ok204();
  })),
  http.get(`${A}/v1/companies`, authed(() => json(db().companies as unknown as JsonBodyType))),
  http.post(`${A}/v1/companies`, authed(async (r) => { const c = { id: uid(), version: 1, created_at: now(), ...(await body<object>(r)) }; db().companies.push(c as never); return json(c as JsonBodyType, 201); })),
  http.patch(`${A}/v1/companies/:id`, authed(async (r) => {
    const c = db().companies.find((x) => x.id === r.params.id); if (!c) return problem(404, 'not_found', 'Not found');
    const g = ifMatch(r, c.version); if (g) return g;
    bump(c as { version: number }, await body<object>(r)); audit('company.update', 'company', c.id); return json(c as unknown as JsonBodyType);
  })),

  /* ---- branches (GSTIN optional in the company's state, required elsewhere) ---- */
  http.get(`${A}/v1/branches`, authed(() => json(db().branches as unknown as JsonBodyType))),
  http.post(`${A}/v1/branches`, authed(async (r) => {
    const b = await body<BranchInput>(r);
    const co = db().companies.find((c) => c.id === (b.company_id || COMPANY_ID));
    if (db().branches.some((x) => x.code === b.code)) return problem(409, 'branch_code_taken', 'Branch code already used');
    if (b.state_code && co && b.state_code !== co.state_code && !b.gstin) return problem(422, 'branch_gstin_required', 'GSTIN required for a branch in another state', [{ field: 'gstin', message: 'required' }]);
    const br = { id: uid(), version: 1, is_active: true, created_at: now(), gstin: null, ...b, company_id: b.company_id || COMPANY_ID };
    db().branches.push(br as never); audit('branch.create', 'branch', br.id); return json(br as unknown as JsonBodyType, 201);
  })),
  http.patch(`${A}/v1/branches/:id`, authed(async (r) => {
    const br = db().branches.find((x) => x.id === r.params.id); if (!br) return problem(404, 'not_found', 'Not found');
    const g = ifMatch(r, br.version); if (g) return g;
    bump(br as { version: number }, await body<BranchPatch>(r)); return json(br as unknown as JsonBodyType);
  })),

  /* ---- devices ---- */
  http.get(`${A}/v1/devices`, authed(() => json(db().devices.map(({ device_key: _k, ...d }) => d) as unknown as JsonBodyType))),
  http.get(`${A}/v1/devices/current`, authed(() => {
    const d = db().devices.find((x) => x.id === db().session?.device_id);
    if (!d) return json(null); // 0.4.3: unregistered = 200 null
    const { device_key: _k, ...rest } = d; return json(rest as unknown as JsonBodyType);
  })),
  http.post(`${A}/v1/devices`, authed(async (r) => {
    const b = await body<DeviceRegistration>(r);
    const d = { id: uid(), name: b.name, kind: b.kind ?? 'billing_counter', branch_id: b.branch_id || BRANCH_ID, status: 'pending' as const, live_sessions: 0, created_at: now(), device_key: b.device_key };
    db().devices.push(d as never); const sess = db().session; if (sess) sess.device_id = d.id; audit('device.register', 'device', d.id);
    const { device_key: _k, ...rest } = d; return json(rest as unknown as JsonBodyType, 201);
  })),
  http.post(`${A}/v1/devices/:id/approve`, authed((r) => {
    const d = db().devices.find((x) => x.id === r.params.id); if (!d) return problem(404, 'not_found', 'Not found');
    Object.assign(d, { status: 'approved', approved_at: now() }); audit('device.approve', 'device', d.id); return json(d as unknown as JsonBodyType);
  })),
  http.post(`${A}/v1/devices/:id/revoke`, authed((r) => {
    const d = db().devices.find((x) => x.id === r.params.id); if (!d) return problem(404, 'not_found', 'Not found');
    Object.assign(d, { status: 'revoked', revoked_at: now() }); audit('device.revoke', 'device', d.id); return json(d as unknown as JsonBodyType);
  })),

  /* ---- users / roles ---- */
  http.get(`${A}/v1/roles`, authed(() => json(Object.entries(ROLE_PERMS).map(([code, permissions], i) => ({ id: `role-${i}`, code, name: code.charAt(0).toUpperCase() + code.slice(1), is_system: true, permissions }))))),
  http.get(`${A}/v1/permissions`, authed(() => json(PERMISSIONS.map(([code, sensitive]) => ({ code, description: code, sensitive }))))),
  http.get(`${A}/v1/users`, authed(() => json(db().users.map(publicUser) as unknown as JsonBodyType))),
  http.post(`${A}/v1/users`, authed(async (r) => {
    const b = await body<{ name: string; username: string; phone?: string; password: string; roles?: RoleAssignment[]; language?: string }>(r);
    if (db().users.some((u) => u.username === b.username)) return problem(409, 'username_taken', 'Username already used');
    const u: MockUser = { id: uid(), name: b.name, username: b.username, phone: b.phone, is_active: true, roles: b.roles ?? [], language: (b.language ?? null) as never, created_at: now(), version: 1, password: b.password, otp: false } as MockUser;
    db().users.push(u); audit('user.create', 'app_user', u.id); return json(publicUser(u) as unknown as JsonBodyType, 201);
  })),
  http.patch(`${A}/v1/users/me`, authed(async (r) => { const u = meOrThrow(); const g = ifMatch(r, u.version); if (g) return g; const b = await body<UserPatch>(r); if (!knownLang(b.language)) return unknownLang(); bump(u, b); return json(publicUser(u) as unknown as JsonBodyType); })),
  http.patch(`${A}/v1/users/:id`, authed(async (r) => {
    const u = db().users.find((x) => x.id === r.params.id); if (!u) return problem(404, 'not_found', 'Not found');
    const g = ifMatch(r, u.version); if (g) return g;
    bump(u, await body<UserPatch>(r)); return json(publicUser(u) as unknown as JsonBodyType);
  })),
  http.put(`${A}/v1/users/:id/roles`, authed(async (r) => {
    const u = db().users.find((x) => x.id === r.params.id); if (!u) return problem(404, 'not_found', 'Not found');
    const b = await body<{ roles: RoleAssignment[] }>(r); u.roles = b.roles; audit('user.roles', 'app_user', u.id); return json(publicUser(u) as unknown as JsonBodyType);
  })),

  /* ---- settings ---- */
  http.get(`${A}/v1/settings`, authed(() => json(db().settings as unknown as JsonBodyType))),
  http.put(`${A}/v1/settings/:key`, authed(async (r) => {
    const s = db().settings.find((x) => x.key === r.params.key); if (!s) return problem(404, 'not_found', 'Unknown setting');
    const v = (s as { version?: number | null }).version ?? null; const g = ifMatch(r, v, true); if (g) return g;
    Object.assign(s, { value: (await body<{ value: unknown }>(r)).value, source: 'tenant', version: (v ?? 0) + 1 }); return json(s as unknown as JsonBodyType);
  })),
  http.delete(`${A}/v1/settings/:key`, authed((r) => {
    const s = db().settings.find((x) => x.key === r.params.key); if (!s) return problem(404, 'not_found', 'Unknown setting');
    const v = (s as { version?: number | null }).version ?? null; const g = ifMatch(r, v, true); if (g) return g;
    Object.assign(s, { value: s.default_value, source: 'platform', version: null }); return json(s as unknown as JsonBodyType);
  })),
  http.get(`${A}/v1/settings/sales-policy`, authed(() => json(db().salesPolicy[0] as unknown as JsonBodyType))),
  http.get(`${A}/v1/settings/sales-policy/history`, authed(() => json(db().salesPolicy as unknown as JsonBodyType))),
  http.post(`${A}/v1/settings/sales-policy`, authed(async (r) => {
    const p = { id: uid(), scope: 'tenant', effective_from: todayIST(), ...(await body<object>(r)) }; db().salesPolicy.unshift(p as never);
    audit('settings.sales_policy.create', 'sales_policy', p.id); return json(p as JsonBodyType, 201);
  })),
  http.get(`${A}/v1/settings/language`, authed(() => {
    const u = meOrThrow();
    return json({
      shop_default: db().tenant.default_language, user_override: u.language ?? null, effective: u.language ?? db().tenant.default_language,
      supported: LANGS.map(([code, name]) => ({ code, name, numeral_system: 'latin', amount_in_words_verified: code === 'en' || code === 'ta' })),
      latin_only_fields: ['gstin', 'huid', 'doc_no', 'phone', 'barcode'],
    });
  })),
  // 0.4.3: effective-dated, no If-Match. effective_to is exclusive; close = PATCH effective_to (>= today, > effective_from).
  http.get(`${A}/v1/settings/gst-config`, authed(() => json(db().gstConfig as unknown as JsonBodyType))),
  http.post(`${A}/v1/settings/gst-config`, authed(async (r) => {
    if (!canEditSettings()) return problem(403, 'forbidden', 'Needs platform.settings.edit');
    const b = await body<GstConfigInput & { making_treatment?: unknown }>(r);
    if ('making_treatment' in b) return problem(422, 'validation_failed', 'making_treatment moved to sales policy', [{ field: 'making_treatment', message: 'unknown field' }]);
    if (!['0.01', '0.10', '0.50', '1.00'].includes(b.round_off_unit)) return problem(422, 'validation_failed', 'Invalid round-off unit', [{ field: 'round_off_unit', message: 'enum' }]);
    if (b.company_id && !db().companies.some((c) => c.id === b.company_id)) return problem(422, 'unknown_company', 'Unknown company');
    if (b.effective_from < istToday()) return problem(422, 'effective_from_in_past', 'effective_from must be today or later');
    const company = b.company_id ?? COMPANY_ID;
    if (db().gstConfig.some((g) => g.company_id === company && overlaps(g, b))) return problem(409, 'overlapping_period', 'Overlaps an existing period');
    const g = { id: uid(), company_id: company, einvoice_enabled: false, einvoice_from: null, effective_to: null, ...b } as GstConfig;
    db().gstConfig.unshift(g); return json(g as unknown as JsonBodyType, 201);
  })),
  http.patch(`${A}/v1/settings/gst-config/:id`, authed(async (r) => {
    if (!canEditSettings()) return problem(403, 'forbidden', 'Needs platform.settings.edit');
    const g = db().gstConfig.find((x) => x.id === r.params.id); if (!g) return problem(404, 'not_found', 'Not found');
    const bad = closeError(g, (await body<{ effective_to: string }>(r)).effective_to); if (bad) return bad;
    return json(g as unknown as JsonBodyType);
  })),
  http.post(`${A}/v1/settings/gst-config/:id/replace`, authed((r) => replaceWith(r, db().gstConfig, 'gst-config',
    (_o, b) => ('company_id' in b || 'making_treatment' in b ? problem(422, 'validation_failed', 'Unknown field') : !['0.01', '0.10', '0.50', '1.00'].includes(String(b.round_off_unit)) ? problem(422, 'validation_failed', 'Invalid round-off unit') : null),
    (o, b) => ({ einvoice_enabled: false, einvoice_from: null, b2c_qr: false, effective_to: null, ...b, id: uid(), company_id: o.company_id }) as unknown as GstConfig,
    (x, b) => Object.entries(b).every(([k, v]) => (x as unknown as Record<string, unknown>)[k] === v)))),
  http.get(`${A}/v1/settings/tax-rules`, authed(() => json(db().taxRules as unknown as JsonBodyType))),
  http.post(`${A}/v1/settings/tax-rules`, authed(async (r) => {
    if (!canEditSettings()) return problem(403, 'forbidden', 'Needs platform.settings.edit');
    const b = await body<TaxRuleInput>(r);
    if (b.composite_supply && !b.principal_component) return problem(422, 'validation_failed', 'principal_component required', [{ field: 'principal_component', message: 'required' }]);
    if (b.effective_from < istToday()) return problem(422, 'effective_from_in_past', 'effective_from must be today or later');
    if (db().taxRules.some((t) => sameKey(t, b) && overlaps(t, b))) return problem(409, 'overlapping_period', 'Overlaps an existing period');
    const t = { id: uid(), scope: 'tenant', description: null, metal_code: null, cess_rate: '0', composite_supply: false, principal_component: null, reverse_charge: false, effective_to: null, in_use: false, ...b } as TaxRule;
    db().taxRules.push(t); return json(t as unknown as JsonBodyType, 201);
  })),
  http.patch(`${A}/v1/settings/tax-rules/:id`, authed(async (r) => {
    if (!canEditSettings()) return problem(403, 'forbidden', 'Needs platform.settings.edit');
    const t = db().taxRules.find((x) => x.id === r.params.id); if (!t) return problem(404, 'not_found', 'Not found');
    if (t.scope === 'platform') return problem(403, 'platform_rule', 'Platform rules are read-only');
    const bad = closeError(t, (await body<{ effective_to: string }>(r)).effective_to); if (bad) return bad;
    return json(t as unknown as JsonBodyType);
  })),

  http.post(`${A}/v1/settings/tax-rules/:id/replace`, authed((r) => replaceWith(r, db().taxRules, 'tax-rules',
    (o, b) => {
      if (o.scope === 'platform') return problem(403, 'platform_rule', 'Platform rules are read-only');
      if ('component' in b || 'metal_code' in b) return problem(422, 'validation_failed', 'component/metal_code are inherited');
      if (o.in_use && o.effective_to) return problem(422, 'rule_in_use', 'An in-use rule can be replaced only while open-ended');
      if (b.composite_supply && !b.principal_component) return problem(422, 'validation_failed', 'principal_component required');
      return null;
    },
    (o, b) => ({ description: null, cess_rate: '0', composite_supply: false, principal_component: null, reverse_charge: false, ...b, id: uid(), scope: 'tenant', effective_to: null, ...b, component: o.component, metal_code: o.metal_code, in_use: false }) as unknown as TaxRule,
    (x, b) => Object.entries(b).every(([k, v]) => (x as unknown as Record<string, unknown>)[k] === v)))),

  /* ---- masters / rates / inventory ---- */
  // 0.4.2: masters carry version + is_active; PATCH needs If-Match; lists hide inactive unless include_inactive=true.
  http.get(`${A}/v1/masters/metals`, authed((r) => json(db().metals.filter((m) => m.is_active || incInactive(r)) as unknown as JsonBodyType))),
  http.post(`${A}/v1/masters/metals`, authed(async (r) => {
    if (!canManageMetals()) return problem(403, 'forbidden', 'Needs masters.metals.manage');
    const b = await body<MetalInput>(r);
    if (!/^[A-Z][A-Z0-9_]{0,9}$/.test(b.code ?? '') || !b.name?.trim() || !/^[0-9]{4}([0-9]{2}){0,2}$/.test(b.default_hsn ?? '')) return problem(422, 'validation_failed', 'Invalid metal');
    if (db().metals.some((m) => m.code === b.code)) return problem(409, 'duplicate_code', 'Metal code exists');
    const m = { id: uid(), code: b.code, name: b.name.trim(), default_hsn: b.default_hsn, version: 1, is_active: true } as Metal; db().metals.push(m); markMastersStep(); audit('masters.metal.create', 'metal', m.id);
    return tagged(m, 201);
  })),
  http.patch(`${A}/v1/masters/metals/:id`, authed(async (r) => {
    if (!canManageMetals()) return problem(403, 'forbidden', 'Needs masters.metals.manage');
    const m = db().metals.find((x) => x.id === r.params.id); if (!m) return problem(404, 'not_found', 'Not found');
    const g = ifMatch(r, m.version); if (g) return g;
    const b = await body<MetalPatch>(r);
    if (!Object.keys(b).length || (b.name !== undefined && !b.name.trim()) || (b.default_hsn !== undefined && !/^[0-9]{4}([0-9]{2}){0,2}$/.test(b.default_hsn))) return problem(422, 'validation_failed', 'Invalid metal patch');
    bump(m, b); audit('masters.metal.update', 'metal', m.id); return tagged(m);
  })),
  http.get(`${A}/v1/masters/purities`, authed((r) => {
    const metalId = new URL(r.request.url).searchParams.get('metal_id');
    return json(db().purities.filter((p) => (!metalId || p.metal_id === metalId) && (p.is_active || incInactive(r))) as unknown as JsonBodyType);
  })),
  http.post(`${A}/v1/masters/purities`, authed(async (r) => {
    if (!canManageMetals()) return problem(403, 'forbidden', 'Needs masters.metals.manage');
    const b = await body<PurityInput>(r);
    const metal = db().metals.find((m) => m.id === b.metal_id);
    if (!metal || !/^[A-Z0-9]{1,10}$/.test(b.code ?? '') || !fineOk(b.fineness)) return problem(422, 'validation_failed', 'Invalid purity', [{ field: 'fineness', message: 'decimal string, 0 < f <= 1000' }]);
    if (!metal.is_active) return problem(422, 'inactive_master', 'Metal is deactivated');
    if (db().purities.some((p) => p.metal_id === b.metal_id && p.code === b.code)) return problem(409, 'duplicate_code', 'Purity code exists for this metal');
    const p = { id: uid(), metal_id: b.metal_id, code: b.code, fineness: D(b.fineness).toFixed(3), huid_required: b.huid_required ?? true, header_visible: b.header_visible ?? false, version: 1, is_active: true } as Purity;
    db().purities.push(p); markMastersStep(); audit('masters.purity.create', 'purity', p.id); return tagged(p, 201);
  })),
  http.patch(`${A}/v1/masters/purities/:id`, authed(async (r) => {
    if (!canEditSettings()) return problem(403, 'forbidden', 'Needs platform.settings.edit');
    const p = db().purities.find((x) => x.id === r.params.id); if (!p) return problem(404, 'not_found', 'Not found');
    const g = ifMatch(r, p.version); if (g) return g;
    const b = await body<PurityPatch>(r);
    if (!Object.keys(b).length || (b.fineness !== undefined && !fineOk(b.fineness))) return problem(422, 'validation_failed', 'Invalid purity patch');
    if (b.is_active === true && !db().metals.find((m) => m.id === p.metal_id)?.is_active) return problem(422, 'inactive_master', 'Metal is deactivated');
    bump(p, { ...b, ...(b.fineness !== undefined ? { fineness: D(b.fineness).toFixed(3) } : {}) }); audit('masters.purity.update', 'purity', p.id); return tagged(p);
  })),
  http.get(`${A}/v1/rates/todays-status`, authed((req) => {
    const st = todaysRateStatus(new URL(req.request.url).searchParams.get('branch_id'));
    return st ? json(st as unknown as JsonBodyType) : problem(404, 'not_found', 'Unknown or inactive branch');
  })),
  http.get(`${A}/v1/rates/rate-card`, authed((req) => {
    const branchId = new URL(req.request.url).searchParams.get('branch_id');
    const br = branchId ? db().branches.find((b) => b.id === branchId && b.is_active) : null;
    if (branchId && !br) return problem(404, 'not_found', 'Unknown or inactive branch');
    const inForce = currentRates(branchId);
    const st = statusRow(branchId);
    const metals = db().metals.filter((m) => m.is_active).map((m) => ({ metal_id: m.id, code: m.code, name: m.name,
      purities: db().purities.filter((p) => p.metal_id === m.id && p.is_active).sort((a, b) => D(b.fineness).comparedTo(D(a.fineness))).map((p) => {
        const sale = inForce.find((r) => r.purity_id === p.id && r.kind === 'sale'); const old = inForce.find((r) => r.purity_id === p.id && r.kind === 'old_metal');
        return { purity_id: p.id, code: p.code, fineness: p.fineness, sale_rate_per_g: sale?.rate_per_g ?? null, sale_rate_date: sale?.rate_date ?? null, old_metal_rate_per_g: old?.rate_per_g ?? null };
      }) })).filter((m) => m.purities.length);
    return json({ doc_type: 'rate_card', rate_date: todayIST(), generated_at: now(), company: { legal_name: 'Demo Jewellers Pvt Ltd', trade_name: 'Demo Jewellers', gstin: null },
      branch: br ? { id: br.id, code: br.code, name: br.name } : null, todays_rate_set: st.todays_rate_set, missing_metal_codes: st.missing_metal_codes, metals } as unknown as JsonBodyType);
  })),
  http.post(`${A}/v1/rates/batch`, authed(async (r) => {
    const perms = permsOf(meOrThrow().roles);
    if (!perms.includes('rates.publish')) return problem(403, 'forbidden', 'Needs rates.publish');
    const key = r.request.headers.get('Idempotency-Key') ?? '';
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) return problem(422, 'idempotency_key_required', 'Idempotency-Key required');
    const b = await body<{ branch_id?: string | null; kind: MetalRate['kind']; bases: Array<{ purity_id: string; rate_per_g: string }>; overrides?: Array<{ purity_id: string; rate_per_g: string }> }>(r);
    const hash = JSON.stringify(b); const st = (db().rateBatchIdem ??= {});
    const stored = st[key];
    if (stored) return stored.hash === hash ? json(stored.body as JsonBodyType, 201) : problem(422, 'idempotency_key_reused', 'Idempotency-Key reused with a different request');
    if (!['sale', 'old_metal', 'purchase'].includes(b.kind) || !Array.isArray(b.bases) || b.bases.length < 1 || b.bases.length > 20) return problem(422, 'validation_failed', 'kind and 1–20 bases required');
    const branchId = b.branch_id ?? null;
    if (branchId && !db().branches.some((x) => x.id === branchId && x.is_active)) return problem(404, 'not_found', 'Unknown branch');
    const all = [...b.bases, ...(b.overrides ?? [])];
    if (all.some((x) => !RATE2.test(x.rate_per_g ?? '') || !D(x.rate_per_g).gt(0))) return problem(422, 'validation_failed', 'rate_per_g: > 0, 2 dp', [{ field: 'rate_per_g', message: '^[0-9]{1,10}\\.[0-9]{2}$' }]);
    const today = todayIST(); const at = now(); const out: MetalRate[] = []; const seen = new Set<string>(); const derivable = new Set<string>();
    const plan: Array<{ base: { purity_id: string; rate_per_g: string }; metal: string; baseFin: string }> = [];
    for (const x of b.bases) {
      const p = db().purities.find((q) => q.id === x.purity_id);
      if (!p) return problem(404, 'not_found', 'Unknown purity');
      if (!p.is_active) return problem(422, 'inactive_master', 'Purity is deactivated');
      if (seen.has(p.metal_id)) return problem(422, 'duplicate_metal', 'Two bases for one metal');
      seen.add(p.metal_id); plan.push({ base: x, metal: p.metal_id, baseFin: p.fineness });
      for (const q of db().purities) if (q.metal_id === p.metal_id && q.is_active && q.id !== p.id) derivable.add(q.id);
    }
    if ((b.overrides ?? []).some((o) => !derivable.has(o.purity_id))) return problem(422, 'invalid_override', 'Override must be a non-base active purity of a base metal');
    const rows: MetalRate[] = [];
    for (const { base, metal, baseFin } of plan) {
      const head = { id: uid(), purity_id: base.purity_id, branch_id: branchId, kind: b.kind, rate_per_g: base.rate_per_g, rate_date: today, effective_from: at, source: 'manual', derived_from_id: null, derived_rate_per_g: null } as MetalRate;
      rows.push(head);
      for (const q of db().purities.filter((x) => x.metal_id === metal && x.is_active && x.id !== base.purity_id).sort((a, c) => D(c.fineness).comparedTo(D(a.fineness)))) {
        const derived = D(base.rate_per_g).times(q.fineness).div(baseFin).toDecimalPlaces(2, 4).toFixed(2);
        if (!D(derived).gt(0)) return problem(422, 'invalid_rate', 'A derived rate rounds to 0.00');
        const ov = b.overrides?.find((o) => o.purity_id === q.id);
        rows.push({ id: uid(), purity_id: q.id, branch_id: branchId, kind: b.kind, rate_per_g: ov?.rate_per_g ?? derived, rate_date: today, effective_from: at, source: 'batch', derived_from_id: head.id, derived_rate_per_g: derived } as MetalRate);
      }
    }
    // R6: publishing again today for the same (purity, kind, scope) is a correction → rates.edit.
    const corrects = rows.some((n) => db().rates.some((o) => o.purity_id === n.purity_id && o.kind === n.kind && (o.branch_id ?? null) === branchId && o.rate_date === today));
    if (corrects && !perms.includes('rates.edit')) return problem(403, 'forbidden', 'Correcting a rate published today needs rates.edit');
    out.push(...rows); db().rates.push(...rows); audit('rates.publish', 'metal_rate', rows[0]?.id ?? null);
    const res = { rate_date: today, items: out }; st[key] = { hash, body: res };
    return json(res as unknown as JsonBodyType, 201);
  })),
  http.get(`${A}/v1/rates/current`, authed((req) => json(currentRates(new URL(req.request.url).searchParams.get('branch_id')) as unknown as JsonBodyType))),
  http.post(`${A}/v1/rates`, authed(async (r) => {
    const b = await body<MetalRateInput>(r);
    if (!RATE2.test(b.rate_per_g ?? '') || !D(b.rate_per_g).gt(0)) return problem(422, 'validation_failed', 'Rate must be > 0 with exactly 2 decimals', [{ field: 'rate_per_g', message: '^[0-9]{1,10}\\.[0-9]{2}$, > 0' }]);
    const pur = db().purities.find((p) => p.id === b.purity_id);
    if (!pur) return problem(422, 'validation_failed', 'Unknown purity');
    if (!pur.is_active) return problem(422, 'inactive_master', 'Purity is deactivated');
    if (db().rates.some((o) => o.purity_id === b.purity_id && o.kind === b.kind && (o.branch_id ?? null) === (b.branch_id ?? null) && o.rate_date === todayIST())
      && !permsOf(meOrThrow().roles).includes('rates.edit')) return problem(403, 'forbidden', 'Correcting a rate published today needs rates.edit');
    // Insert-only; rate_date = IST today (server-assigned). A correction is another row with a later effective_from.
    const rate = { id: uid(), branch_id: b.branch_id ?? null, ...b, rate_date: todayIST(), effective_from: now(), source: 'manual' } as MetalRate; db().rates.push(rate); audit('rates.publish', 'metal_rate', rate.id);
    return json(rate as unknown as JsonBodyType, 201);
  })),
  http.get(`${A}/v1/inventory/tags/:tagNo`, authed((r) => {
    const t = db().tags.find((x) => x.tag_no === r.params.tagNo); return t ? json(t as unknown as JsonBodyType) : problem(404, 'tag_not_found', 'No such tag');
  })),

  /* ---- sales (INV-1) ---- */
  http.post(`${A}/v1/sales/invoices`, authed(async (r) => {
    const key = r.request.headers.get('Idempotency-Key');
    if (!key) return problem(400, 'idempotency_key_required', 'Idempotency-Key header required');
    const prev = db().idem[key]; if (prev) { const inv = db().invoices.find((i) => i.id === prev); if (inv) return json(inv as unknown as JsonBodyType, 201); }
    const raw = await body<IssueInvoiceRequest & { doc_no?: string; doc_date?: string }>(r);
    if (raw.doc_no) return problem(422, 'client_supplied_doc_number', 'Invoice numbers are assigned by the server');
    if (raw.doc_date) return problem(422, 'client_supplied_doc_date', 'Invoice dates are assigned by the server');
    if (!deviceOk()) return problem(403, 'device_not_approved', 'This device is not approved for billing');
    if (!onboarding().billing_unlocked) return problem(403, 'billing_locked', 'Finish the billing setup steps first');
    const p = price(raw); if (typeof p === 'string') return problem(422, p, p === 'tag_not_sellable' ? 'Tag is not sellable' : 'No rate for this purity');
    const fy = financialYear(new Date()); const seq = db().series++;
    const inv = { id: uid(), doc_no: `MAIN/${fy}/${String(seq).padStart(6, '0')}`, doc_seq: seq, doc_date: todayIST(), fy, status: 'issued', payment_status: 'paid', branch_id: raw.branch_id, gst_type: 'intra', print_count: 0, ...p } as unknown as Invoice;
    for (const l of raw.lines) { const t = db().tags.find((x) => x.id === (l as { tag_id?: string }).tag_id); if (t) t.status = 'sold'; }
    db().invoices.push(inv); db().idem[key] = inv.id; audit('sales.invoice.issue', 'invoice', inv.id);
    return json(inv as unknown as JsonBodyType, 201);
  })),
  http.get(`${A}/v1/sales/invoices/:id`, authed((r) => { const i = db().invoices.find((x) => x.id === r.params.id); return i ? json(i as unknown as JsonBodyType) : problem(404, 'not_found', 'Not found'); })),

  /* ---- branding ---- */
  http.get(`${A}/v1/branding/theme`, authed(() => json(themeView('tenant')))),
  http.put(`${A}/v1/branding/theme`, authed(async (r) => {
    const g = ifMatch(r, db().themeVersion.tenant, true); if (g) return g;
    db().theme.tenant = await body<ThemeInput>(r); db().themeVersion.tenant = (db().themeVersion.tenant ?? 0) + 1; return json(themeView('tenant'));
  })),
  http.get(`${A}/v1/branding/domains`, authed(() => json(db().domains as unknown as JsonBodyType))),
  http.post(`${A}/v1/branding/domains`, authed(async (r) => {
    const { hostname } = await body<{ hostname: string }>(r);
    const d = { id: uid(), hostname, status: 'pending', tls_status: 'none', dns_record: { type: 'CNAME', name: hostname, value: 'tenants.platform.example' }, created_at: now() };
    db().domains.push(d as never); return json(d as JsonBodyType, 201);
  })),
  http.post(`${A}/v1/branding/domains/:id/verify`, authed((r) => {
    const d = db().domains.find((x) => x.id === r.params.id); if (!d) return problem(404, 'not_found', 'Not found');
    Object.assign(d, { status: 'verified', tls_status: 'issuing', verified_at: now() }); return json(d as unknown as JsonBodyType);
  })),

  /* ---- print templates (0.9.6: renderable = exact 998 release pin, or any tag_label row; native numerals only for the print language; IDs stay Latin in the renderer) ---- */
  http.get(`${A}/v1/print-templates`, authed(() => json(db().templates.map((t)=>({...t,scope:t.scope ?? 'tenant',read_only:t.read_only ?? false,renderable:mockRenderable096(t)})) as unknown as JsonBodyType))),
  http.get(`${A}/v1/print-templates/:id`, authed((r) => { const t=db().templates.find((x)=>x.id===r.params.id);return t?json({...t,scope:t.scope ?? 'tenant',read_only:t.read_only ?? false,renderable:mockRenderable096(t)} as unknown as JsonBodyType):problem(404,'not_found','Not found'); })),
  http.post(`${A}/v1/print-templates`, authed(async (r) => {
    const b = await body<PrintTemplateInput>(r);
    if(b.print_language && b.print_language!=='en' && b.print_language!=='ta') return problem(422,'validation_failed','Choose English or Tamil');
    const NATIVE: Record<string, string> = { ta: 'tamil', hi: 'devanagari', te: 'telugu', kn: 'kannada', ml: 'malayalam' };
    if (b.numeral_system && b.numeral_system !== 'latin' && NATIVE[b.print_language ?? 'en'] !== b.numeral_system)
      return problem(422, 'numerals_mismatch', 'Native numerals must match the print language', [{ field: 'numeral_system', message: 'mismatch' }]);
    if (b.doc_type !== 'tag_label') return problem(422, 'print_template_not_renderable', 'Custom Sales templates are not renderable this release'); // 0.9.6 B-2; tag_label exempt
    const version = 1 + Math.max(0, ...db().templates.filter((t) => t.doc_type === b.doc_type).map((t) => t.version));
    const t = { id: uid(), version, row_version: 1, is_active: false, created_at: now(), ...b,scope:'tenant',read_only:false } as PrintTemplate; db().templates.push(t);
    return json(t as unknown as JsonBodyType, 201);
  })),
  http.post(`${A}/v1/print-templates/:id/activate`, authed((r) => {
    const t = db().templates.find((x) => x.id === r.params.id); if (!t) return problem(404, 'not_found', 'Not found');
    if((t.scope && t.scope!=='tenant') || t.read_only) return problem(404,'not_found','Not found');
    if(t.print_language!=='en' && t.print_language!=='ta') return problem(422,'validation_failed','Choose English or Tamil');
    const g = ifMatch(r, t.row_version); if (g) return g; // contract 0.3.0: If-Match = row_version
    if (!mockRenderable096(t)) return problem(422, 'print_template_not_renderable', 'Not a release pin'); // 0.9.6 B-2; tag_label exempt
    for (const o of db().templates) if (o.doc_type === t.doc_type && o.paper === t.paper && o.is_active) { o.is_active = false; o.row_version += 1; }
    t.is_active = true; t.row_version += 1; audit('print.template.activate', 'print_template', t.id); return json(t as unknown as JsonBodyType);
  })),

  /* ---- audit ---- */
  http.get(`${A}/v1/audit-events`, authed((r) => {
    const q = new URL(r.request.url).searchParams; const before = Number(q.get('before_seq') ?? Infinity); const limit = Number(q.get('limit') ?? 20);
    const action = q.get('action');
    const rows = db().audit.filter((e) => e.seq < before && (!action || e.action.startsWith(action)));
    const items = rows.slice(0, limit);
    return json({ items, next_before_seq: rows.length > limit ? items[items.length - 1]?.seq ?? null : null } as unknown as JsonBodyType);
  })),
  http.get(`${A}/v1/audit-events/verify`, authed(() => json({ intact: true, checked: db().audit.length, first_bad_seq: null }))),

  /* ---- import ---- */
  http.get(`${A}/v1/import-templates/:kind`, authed((r) => {
    const H: Record<string, string> = { customers: 'name*,phone*,email,gstin,pan,address,city,pincode', stock: 'tag_no*,purity*,gross_wt*,stone_wt,net_wt*,huid,mc_type,mc_value', opening_balances: 'party_name*,phone,balance*,as_of*' };
    const h = H[String(r.params.kind)] ?? masterTemplate(String(r.params.kind)); if (!h) return problem(404, 'not_found', 'Unknown import kind');
    return new HttpResponse(`${h}\n`, { headers: { 'Content-Type': 'text/csv' } });
  })),
  http.get(`${A}/v1/imports`, authed(() => json(db().imports as unknown as JsonBodyType))),
  http.post(`${A}/v1/imports`, authed(async (r) => {
    const { kind, file, profile_id, branch_id, order } = await multipart(r.request);
    // Contract: kind, branch_id, profile_id come BEFORE the file part (the server streams the file).
    if (order.at(-1) !== 'file') return problem(400, 'multipart_order', 'Send kind/branch_id/profile_id before the file part');
    if (kind === 'stock' && !branch_id) return problem(422, 'validation_failed', 'branch_id is required for stock', [{ field: 'branch_id', message: 'required' }]);
    const prof = profile_id ? db().profiles.find((p) => p.id === profile_id) : undefined;
    if (profile_id && !prof) return problem(404, 'not_found', 'Unknown mapping profile');
    const lines = file.trim().split(/\r?\n/); const rawHeader = (lines.shift() ?? '').split(',').map((s) => s.replace(/"/g, '').trim());
    // A saved profile renames source headers → template columns server-side.
    const header = prof ? rawHeader.map((h) => Object.entries(prof.mapping).find(([, src]) => src.toLowerCase() === h.toLowerCase())?.[0] ?? h) : rawHeader;
    const errors: Array<{ row: number; column?: string; code: string; message: string }> = [];
    lines.forEach((ln, i) => {
      const cells = ln.split(',').map((s) => s.replace(/"/g, '').trim()); const get = (k: string) => cells[header.indexOf(k)] ?? '';
      if (kind === 'customers') {
        if (!get('name')) errors.push({ row: i + 2, column: 'name', code: 'required', message: 'Name is required' });
        if (!/^[6-9]\d{9}$/.test(get('phone'))) errors.push({ row: i + 2, column: 'phone', code: 'invalid_phone', message: 'Phone must be 10 Latin digits' });
      }
    });
    const bad = new Set(errors.map((e) => e.row)).size;
    const job = { id: uid(), kind, mapping_profile_id: prof?.id ?? null, dry_run: true, status: errors.length ? 'failed' : 'validated', total_rows: lines.length, ok_rows: lines.length - bad, error_rows: bad, errors, created_at: now(), finished_at: now() };
    db().imports.unshift(job as never); return json(job as unknown as JsonBodyType, 201);
  })),
  http.post(`${A}/v1/imports/:id/commit`, authed((r) => {
    const j = db().imports.find((x) => x.id === r.params.id); if (!j) return problem(404, 'not_found', 'Not found');
    if (j.status !== 'validated') return problem(409, 'import_not_clean', 'Fix the dry-run errors first');
    const c = { ...j, id: uid(), dry_run: false, dry_run_of: j.id, status: 'completed', created_at: now(), finished_at: now() };
    db().imports.unshift(c as never); audit('import.commit', 'import_job', c.id); return json(c as unknown as JsonBodyType, 201);
  })),
  http.get(`${A}/v1/imports/:id/errors`, authed((r) => {
    const j = db().imports.find((x) => x.id === r.params.id); if (!j) return problem(404, 'not_found', 'Not found');
    const q = new URL(r.request.url).searchParams; const after = Number(q.get('after_row') ?? 0); const limit = Number(q.get('limit') ?? 50);
    return json((j.errors ?? []).filter((e) => e.row > after).slice(0, limit) as unknown as JsonBodyType);
  })),
  /* ---- import mapping profiles (409 mapping_profile_in_use once a job references it) ---- */
  http.get(`${A}/v1/import-mapping-profiles`, authed((r) => {
    const kind = new URL(r.request.url).searchParams.get('kind');
    return json(db().profiles.filter((p) => !kind || p.kind === kind) as unknown as JsonBodyType);
  })),
  http.post(`${A}/v1/import-mapping-profiles`, authed(async (r) => {
    const b = await body<ImportMappingProfileInput>(r);
    if (db().profiles.some((p) => p.kind === b.kind && p.name === b.name)) return problem(409, 'mapping_profile_name_taken', 'A profile with this name exists');
    const p = { id: uid(), version: 1, created_by: me()?.id ?? null, created_at: now(), ...b }; db().profiles.push(p as never); return json(p as unknown as JsonBodyType, 201);
  })),
  http.get(`${A}/v1/import-mapping-profiles/:id`, authed((r) => { const p = db().profiles.find((x) => x.id === r.params.id); return p ? json(p as unknown as JsonBodyType) : problem(404, 'not_found', 'Not found'); })),
  http.patch(`${A}/v1/import-mapping-profiles/:id`, authed(async (r) => {
    const p = db().profiles.find((x) => x.id === r.params.id); if (!p) return problem(404, 'not_found', 'Not found');
    const g = ifMatch(r, p.version); if (g) return g;
    bump(p as { version: number }, await body<ImportMappingProfilePatch>(r)); return json(p as unknown as JsonBodyType);
  })),
  http.delete(`${A}/v1/import-mapping-profiles/:id`, authed((r) => {
    const i = db().profiles.findIndex((x) => x.id === r.params.id); const p = db().profiles[i]; if (!p) return problem(404, 'not_found', 'Not found');
    const g = ifMatch(r, p.version); if (g) return g;
    if (db().imports.some((j) => j.mapping_profile_id === p.id)) return problem(409, 'mapping_profile_in_use', 'Profile is referenced by an import job');
    db().profiles.splice(i, 1); return ok204();
  })),

  /* ---- partner console (cookie `psid`; partner resolved from Host or the `partner` slug) ---- */
  http.post(`${A}/v1/partner/auth/login`, async (r) => {
    const b = await body<PartnerLoginBody>(r);
    const p = db().partners.find((x) => (b.partner ? x.slug === b.partner : b.partner_id ? x.id === b.partner_id : x.id === PARTNER_ID));
    const u = p && db().partnerUsers.find((x) => x.partner_id === p.id && x.email === b.email && x.is_active);
    if (!u || u.password !== b.password) return problem(401, 'invalid_credentials', 'Wrong partner, email or password');
    db().partnerSession = { id: uid(), user_id: u.id }; return json(partnerSession() as unknown as JsonBodyType);
  }),
  http.post(`${A}/v1/partner/auth/logout`, () => { db().partnerSession = null; return ok204(); }),
  http.get(`${A}/v1/partner/auth/session`, partner(() => json(partnerSession() as unknown as JsonBodyType))),
  http.get(`${A}/v1/partner/users`, partner(() => json(db().partnerUsers.filter((u) => u.partner_id === partnerMe()?.partner_id).map(publicPartnerUser) as unknown as JsonBodyType))),
  http.post(`${A}/v1/partner/users`, partner(async (r) => {
    if (partnerMe()?.role !== 'partner_admin') return problem(403, 'forbidden', 'Partner admin only');
    const b = await body<{ name: string; email: string; password: string; role: 'partner_admin' | 'partner_staff' }>(r);
    if (db().partnerUsers.some((u) => u.email === b.email)) return problem(409, 'email_taken', 'Email already used');
    const u: MockPartnerUser = { id: uid(), partner_id: partnerMe()?.partner_id ?? PARTNER_ID, name: b.name, email: b.email, role: b.role, is_active: true, version: 1, created_at: now(), password: b.password };
    db().partnerUsers.push(u); return json(publicPartnerUser(u) as unknown as JsonBodyType, 201);
  })),
  http.patch(`${A}/v1/partner/users/:id`, partner(async (r) => {
    const u = db().partnerUsers.find((x) => x.id === r.params.id && x.partner_id === partnerMe()?.partner_id); if (!u) return problem(404, 'not_found', 'Not found');
    const g = ifMatch(r, u.version); if (g) return g;
    bump(u, await body<object>(r)); return json(publicPartnerUser(u) as unknown as JsonBodyType);
  })),
  http.get(`${A}/v1/partner/tenants`, partner(() => json(db().tenants.filter((t) => t.partner_id === partnerMe()?.partner_id).map((t) => {
    const sub = db().subscriptions.find((x) => x.tenant_id === t.id);
    return { tenant_id: t.id, display_name: t.display_name, tenant_status: t.status, plan_code: sub?.plan_code ?? null, plan_name: sub ? sub.plan_code.charAt(0).toUpperCase() + sub.plan_code.slice(1) : null, subscription_status: sub?.status ?? null };
  }) as unknown as JsonBodyType))),
  http.get(`${A}/v1/partner/billing/subscriptions`, partner(() => {
    const mine = new Set(db().tenants.filter((t) => t.partner_id === partnerMe()?.partner_id).map((t) => t.id));
    return json(db().subscriptions.filter((x) => mine.has(x.tenant_id)) as unknown as JsonBodyType);
  })),
  http.get(`${A}/v1/partner/branding/theme`, partner(() => json(themeView('partner')))),
  http.put(`${A}/v1/partner/branding/theme`, partner(async (r) => {
    const g = ifMatch(r, db().themeVersion.partner, true); if (g) return g;
    db().theme.partner = await body<ThemeInput>(r); db().themeVersion.partner = (db().themeVersion.partner ?? 0) + 1; return json(themeView('partner'));
  })),
  http.get(`${A}/v1/partner/branding/domains`, partner(() => json(db().partnerDomains as unknown as JsonBodyType))),
  http.post(`${A}/v1/partner/branding/domains`, partner(async (r) => {
    const { hostname } = await body<{ hostname: string }>(r);
    const d = { id: uid(), hostname, status: 'pending', tls_status: 'none', dns_record: { type: 'CNAME', name: hostname, value: 'partners.platform.example' }, created_at: now() };
    db().partnerDomains.push(d as never); return json(d as JsonBodyType, 201);
  })),

  // 0.4.2 history: newest first (effective_from DESC, id DESC); opaque keyset cursor; bad cursor → 422 invalid_cursor.
  http.get(`${A}/v1/rates`, authed((r) => {
    const q = new URL(r.request.url).searchParams;
    const limit = Math.min(Math.max(Number(q.get('limit') ?? 50) || 50, 1), 200);
    let after: { e: string; i: string } | null = null;
    const cur = q.get('cursor');
    if (cur) { try { after = JSON.parse(atob(cur)) as { e: string; i: string }; if (typeof after.e !== 'string' || typeof after.i !== 'string') throw new Error('bad'); } catch { return problem(422, 'invalid_cursor', 'Invalid cursor'); } }
    const key = (x: MetalRate) => `${x.effective_from}|${x.id}`;
    const metalId = q.get('metal_id');
    // effective_to = effective_from of the next row for the same (purity, kind, branch scope); exclusive; null = in force.
    const withTo = (x: MetalRate): MetalRate => ({ ...x, effective_to: db().rates.filter((y) => y.purity_id === x.purity_id && y.kind === x.kind && (y.branch_id ?? null) === (x.branch_id ?? null) && key(y) > key(x)).map((y) => y.effective_from).sort()[0] ?? null,
      derived_from_id: x.derived_from_id ?? null, derived_rate_per_g: x.derived_rate_per_g ?? null } as MetalRate);
    const rows = db().rates.filter((x) => (!metalId || db().purities.some((p) => p.id === x.purity_id && p.metal_id === metalId)) && (!q.get('purity_id') || x.purity_id === q.get('purity_id')) && (!q.get('kind') || x.kind === q.get('kind'))
      && (!q.get('branch_id') || x.branch_id === q.get('branch_id')) && (!q.get('from') || x.rate_date >= (q.get('from') ?? '')) && (!q.get('to') || x.rate_date <= (q.get('to') ?? '')))
      .sort((a, b) => key(b).localeCompare(key(a))).filter((x) => !after || key(x) < `${after.e}|${after.i}`);
    const items = rows.slice(0, limit).map(withTo); const last = items[items.length - 1];
    return json({ items, next_cursor: rows.length > limit && last ? btoa(JSON.stringify({ e: last.effective_from, i: last.id })) : null } as unknown as JsonBodyType);
  })),
  /* ---- platform admin ---- */
  http.post(`${A}/v1/admin/auth/login`, async (r) => {
    const b = await body<{ email: string; password: string }>(r); const a = db().admin;
    if (b.email !== a.email || b.password !== a.password) return problem(401, 'invalid_credentials', 'Wrong email or password');
    db().adminSignedIn = true; return json({ admin_id: 'admin-1', email: a.email, name: a.name, expires_at: new Date(Date.now() + 8 * 36e5).toISOString() });
  }),
  http.post(`${A}/v1/admin/auth/logout`, () => { db().adminSignedIn = false; return ok204(); }),
  http.get(`${A}/v1/admin/tenants`, admin(() => json(db().tenants as unknown as JsonBodyType))),
  http.post(`${A}/v1/admin/tenants`, admin(async (r) => {
    const b = await body<TenantCreate>(r);
    if (!LATIN_ID.test(b.slug) || db().tenants.some((t) => t.slug === b.slug)) return problem(409, 'slug_taken', 'Slug already used');
    // 0.4.1: server upper-cases, blank → branch code; invalid → 422 invalid_bill_series_prefix. 201 echoes the stored value.
    const pre = (b.branch?.bill_series_prefix ?? '').trim().toUpperCase() || b.branch.code;
    if (!/^[A-Z0-9][A-Z0-9/-]{0,11}$/.test(pre)) return problem(422, 'invalid_bill_series_prefix', 'Invalid bill series prefix');
    const t = { version: 1, id: uid(), partner_id: b.partner_id ?? null, slug: b.slug, display_name: b.display_name, status: 'trial', deployment_mode: 'shared', default_language: 'en', created_at: now() };
    db().tenants.push(t as never); return json({ ...t, branch: { code: b.branch.code, bill_series_prefix: pre } } as unknown as JsonBodyType, 201);
  })),
  http.post(`${A}/v1/admin/tenants/:id/suspend`, admin(async (r) => {
    const t = db().tenants.find((x) => x.id === r.params.id); if (!t) return problem(404, 'not_found', 'Not found');
    const { reason } = await body<{ reason: string }>(r); Object.assign(t, { status: 'suspended', suspended_at: now(), suspend_reason: reason }); return json(t as unknown as JsonBodyType);
  })),
  http.post(`${A}/v1/admin/tenants/:id/reactivate`, admin((r) => {
    const t = db().tenants.find((x) => x.id === r.params.id); if (!t) return problem(404, 'not_found', 'Not found');
    Object.assign(t, { status: 'active', suspended_at: null, suspend_reason: null }); return json(t as unknown as JsonBodyType);
  })),
  http.get(`${A}/v1/admin/partners`, admin(() => json(db().partners as unknown as JsonBodyType))),
  http.post(`${A}/v1/admin/partners/:id/users`, admin(async (r) => {
    const b = await body<{ name: string; email: string; password: string; role: 'partner_admin' | 'partner_staff' }>(r);
    if (!db().partners.some((p) => p.id === r.params.id)) return problem(404, 'not_found', 'Not found');
    if (db().partnerUsers.some((u) => u.email === b.email)) return problem(409, 'email_taken', 'Email already used');
    const u: MockPartnerUser = { id: uid(), partner_id: String(r.params.id), name: b.name, email: b.email, role: b.role, is_active: true, version: 1, created_at: now(), password: b.password };
    db().partnerUsers.push(u); return json(publicPartnerUser(u) as unknown as JsonBodyType, 201);
  })),
];
// Masters (contract 0.6.0): mocks for the endpoints not live yet (x-backing: awaiting 976).
handlers.push(...mastersHandlers);
// Sales 0.9.1 read / pricing mocks go first so their routes win; unknown invoice ids fall through to the INV-1 handler above.
handlers.unshift(...salesHandlers);
