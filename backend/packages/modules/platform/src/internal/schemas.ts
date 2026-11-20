import { z } from 'zod';
export const uuid = z.string().uuid();
export const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/);
export const gstin = z.string().regex(/^[0-9]{2}[A-Z0-9]{13}$/);
export const stateCode = z.string().regex(/^[0-9]{2}$/);
export const pan = z.string().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/);
export const phone = z.string().regex(/^[0-9]{10,15}$/);
export const username = z.string().regex(/^[a-z0-9._-]{3,40}$/);
export const password = z.string().min(8).max(128);
export const lang = z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/);
export const deviceKey = z.string().min(32).max(128);
export const hostname = z.string().max(253).regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/);
export const address = z.object({ line1: z.string().max(200), line2: z.string().max(200), city: z.string().max(80),
  district: z.string().max(80), pincode: z.string().regex(/^[0-9]{6}$/) }).partial().strict();
export const systemRole = z.enum(['owner', 'manager', 'salesperson', 'cashier']);
export const roleAssignment = z.object({ role: systemRole, branch_id: uuid.nullable().optional() }).strict();
export const numeral = z.enum(['latin', 'devanagari', 'tamil', 'telugu', 'kannada', 'malayalam', 'bengali', 'gujarati']);
export const assetKey = z.string().max(300).regex(/^(?!data:)[A-Za-z0-9/_.:-]+$/).nullable().optional();

export const LoginBody = z.object({ tenant: slug.optional(), login: z.string().min(3).max(80), password: z.string().min(1).max(128), device_key: deviceKey.optional() }).strict();
export const OtpStartBody = z.object({ tenant: slug.optional(), login: z.string().min(3).max(80), device_key: deviceKey.optional() }).strict();
export const OtpVerifyBody = z.object({ challenge_id: z.string().max(120), code: z.string().regex(/^[0-9]{6}$/), device_key: deviceKey.optional() }).strict();
export const ChangePasswordBody = z.object({ current_password: z.string().min(1).max(128), new_password: password }).strict();
export const DeviceBody = z.object({ name: z.string().min(1).max(60), kind: z.enum(['billing_counter', 'tablet', 'mobile', 'back_office']).default('billing_counter'),
  branch_id: uuid, device_key: deviceKey }).strict();
export const CompanyBody = z.object({ legal_name: z.string().min(1).max(200), trade_name: z.string().max(200).optional(), gstin: gstin.optional(),
  pan: pan.optional(), state_code: stateCode, address: address.optional() }).strict();
export const CompanyPatchBody = z.object({ legal_name: z.string().min(1).max(200), trade_name: z.string().max(200).nullable(), gstin, pan,
  state_code: stateCode, address }).partial().strict().refine((o) => Object.keys(o).length > 0, 'empty patch');
export const billSeriesPrefix = z.string().regex(/^[A-Z0-9][A-Z0-9/-]{0,11}$/);
/** Same rule as admin tenant create (971 provision_tenant): trim + upper-case, blank/omitted → branch code,
 *  then ^[A-Z0-9][A-Z0-9/-]{0,11}$ or null (caller → 422 invalid_bill_series_prefix). */
export function resolveBillSeriesPrefix(raw: string | null | undefined, code: string): string | null {
  const v = (raw ?? '').trim().toUpperCase() || code.toUpperCase();
  return billSeriesPrefix.safeParse(v).success ? v : null;
}
export const BranchBody = z.object({ company_id: uuid, code: z.string().regex(/^[A-Z0-9]{1,10}$/), name: z.string().min(1).max(120), bill_series_prefix: z.string().max(64).nullable().optional(),
  gstin: gstin.optional(), state_code: stateCode.optional(), address: address.optional() }).strict();
export const BranchPatchBody = z.object({ name: z.string().min(1).max(120), bill_series_prefix: billSeriesPrefix, gstin, address, is_active: z.boolean() })
  .partial().strict().refine((o) => Object.keys(o).length > 0, 'empty patch');
export const UserBody = z.object({ name: z.string().min(1).max(120), username: username.optional(), phone: phone.optional(), email: z.string().email().optional(),
  password, default_branch_id: uuid.optional(), language: lang.optional(), roles: z.array(roleAssignment).min(1).max(20) })
  .strict().refine((u) => u.username || u.phone, 'username or phone is required');
export const UserPatchBody = z.object({ name: z.string().min(1).max(120), username, phone, email: z.string().email().nullable(),
  default_branch_id: uuid.nullable(), language: lang.nullable(), is_active: z.boolean() })
  .partial().strict().refine((o) => Object.keys(o).length > 0, 'empty patch');
export const MeBody = z.object({ language: lang.nullable(), name: z.string().min(1).max(120) }).partial().strict();
export const SetPasswordBody = z.object({ password }).strict();
export const RolesBody = z.array(roleAssignment).min(1).max(20);
export const SettingBody = z.object({ value: z.union([z.boolean(), z.number().int(), z.string().max(500)]) }).strict();
export const SalesPolicyBody = z.object({
  making_gst_treatment: z.enum(['composite', 'separate']), making_tax_rule_code: z.string().max(40).optional(),
  old_gold_valuation_basis: z.enum(['stated_purity', 'fine_24k']), old_gold_excess_handling: z.enum(['refund_on_bill', 'separate_purchase']),
  credit_note_rounding: z.enum(['follow_invoice', 'exact']), return_settlement_default: z.enum(['store_credit', 'refund']),
  return_window_days: z.number().int().min(0).max(365), effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).strict().refine((p) => p.making_gst_treatment === 'composite' || !!p.making_tax_rule_code, 'making_tax_rule_code is required when separate');
export const onboardingStep = z.string().regex(/^[a-z_]{2,40}$/);   // codes come from platform.onboarding_step (data model owns them)
export const OnboardingBody = z.object({ status: z.enum(['pending', 'in_progress', 'completed', 'skipped']), details: z.record(z.unknown()).optional() }).strict();
export const ThemeBody = z.object({ app_name: z.string().max(60).nullable(), logo_key: assetKey, favicon_key: assetKey, pwa_icon_key: assetKey, login_bg_key: assetKey,
  colors: z.record(z.string().regex(/^#[0-9a-fA-F]{6}$/)), fonts: z.record(z.string().max(60)), login_text: z.record(z.unknown()), support_contact: z.record(z.unknown()) })
  .partial().strict();
export const DomainBody = z.object({ hostname }).strict();
export const docType = z.enum(['invoice', 'estimate', 'tag_label', 'receipt', 'credit_note', 'order_receipt', 'rate_card']);
export const TemplateBody = z.object({ doc_type: docType, paper: z.enum(['A4', 'A5', 'thermal_80mm', 'label']).default('A4'), print_language: z.enum(['en', 'ta']).default('en'),
  numeral_system: numeral.default('latin'), body_key: z.string().min(1).max(300).regex(/^(?!data:)/), config: z.record(z.unknown()).default({}) }).strict();
/** v1.5: mirrors platform.provision_tenant() parameters incl. deployment_mode (no status/trade_name/address/owner email/branch state). */
export const TenantCreateBody = z.object({
  slug, display_name: z.string().min(1).max(120), partner_id: uuid.optional(), default_language: lang.optional(),
  deployment_mode: z.enum(['shared', 'dedicated', 'onprem']).optional(),
  company: z.object({ legal_name: z.string().min(1).max(200), gstin: gstin.optional(), pan: z.string().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/).optional(), state_code: stateCode }).strict(),
  branch: z.object({ code: z.string().regex(/^[A-Z0-9]{1,10}$/), name: z.string().min(1).max(120), bill_series_prefix: z.string().max(64).optional() }).strict(),   // 971: the DB upper-cases + validates (23514 → 422 invalid_bill_series_prefix)
  owner: z.object({ name: z.string().min(1).max(120), username: username.optional(), phone: phone.optional(), password })
    .strict().refine((o) => o.username || o.phone, 'owner needs username or phone'),
}).strict();
export const PartnerUserBody = z.object({ name: z.string().min(1).max(120), email: z.string().email().max(200).transform((e) => e.toLowerCase()),
  role: z.enum(['partner_admin', 'partner_staff']).default('partner_staff'), password }).strict();
export const PartnerUserPatch = z.object({ name: z.string().min(1).max(120), role: z.enum(['partner_admin', 'partner_staff']), is_active: z.boolean() })
  .partial().strict().refine((o) => Object.keys(o).length > 0, 'empty patch');
export const PartnerLoginBody = z.object({ partner: slug.optional(), partner_id: uuid.optional(), email: z.string().email().max(200), password: z.string().min(1).max(200) }).strict();
/** 981 (+986 floors): platform.import_job / import_mapping_profile / export_job kind CHECK list. */
export const DATA_KINDS = ['customers', 'stock', 'opening_balances', 'metals', 'purities', 'items', 'sub_items', 'designs', 'stones', 'stone_rates',
  'making_wastage_rules', 'vendors', 'staff', 'counters', 'floors', 'trays', 'hsn_codes', 'payment_modes', 'bank_accounts', 'card_machines'] as const;
export const MappingProfileBody = z.object({ kind: z.enum(DATA_KINDS), name: z.string().min(1).max(80),
  mapping: z.record(z.string().max(80)), options: z.object({ date_format: z.enum(['YYYY-MM-DD', 'DD-MM-YYYY', 'DD/MM/YYYY']) }).partial().strict().optional() }).strict();
export const MappingProfilePatch = z.object({ name: z.string().min(1).max(80), mapping: z.record(z.string().max(80)),
  options: z.object({ date_format: z.enum(['YYYY-MM-DD', 'DD-MM-YYYY', 'DD/MM/YYYY']) }).partial().strict() })
  .partial().strict().refine((o) => Object.keys(o).length > 0, 'empty patch');
