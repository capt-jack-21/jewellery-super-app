import { currentTx } from '@jw/db';
import { Problem, seal } from '@jw/mod-platform';
import { z, type ZodRawShape } from 'zod';
import type { Row, Spec, WriteCtx } from './crud';

// ---------- field helpers (decimal strings in and out; never JS numbers) ----------
const uuid = z.string().uuid();
const dec = (i: number, f: number) => z.string().regex(new RegExp(`^[0-9]{1,${i}}(\\.[0-9]{1,${f}})?$`), `decimal, up to ${i} digits and ${f} decimals`);
const wt = dec(7, 3);
const amt = dec(13, 2);
const pct = dec(3, 3).refine((v) => Number(v) <= 100, '0–100');
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
const date = z.string().refine(isDate, 'date YYYY-MM-DD');
const code = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,29}$/, 'code: letters/digits, then . _ / - (max 30)');
const name = (max: number) => z.string().trim().min(1).max(max);
const hsn = z.string().regex(/^[0-9]{4,8}$/, 'HSN/SAC: 4–8 digits');
const phone = z.string().transform((p) => p.replace(/[\s-]/g, '').replace(/^\+?91(?=\d{10}$)/, '')).pipe(z.string().regex(/^[6-9]\d{9}$/, '10-digit Indian mobile'));
const gstin = z.string().toUpperCase().pipe(z.string().regex(/^[0-9]{2}[A-Z0-9]{13}$/, 'invalid GSTIN'));
const pan = z.string().trim().toUpperCase().pipe(z.string().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'invalid PAN (AAAAA9999A)'));
const stateCode = z.string().regex(/^[0-9]{2}$/);
const obj = z.record(z.unknown());
const MC = z.enum(['per_gram', 'percent', 'flat', 'per_piece']);

/** create = shape (required as given) ; patch = all optional + is_active, non-empty. */
function schemas(shape: ZodRawShape, patchOmit: string[] = []) {
  const create = z.object(shape).strict();
  const p: ZodRawShape = { ...shape, is_active: z.boolean() };
  for (const k of patchOmit) delete p[k];
  const patch = z.object(p).partial().strict().refine((o) => Object.keys(o).length > 0, 'empty patch');
  return { create, patch };
}
const opt = <T extends z.ZodTypeAny>(t: T) => t.nullable().optional();
const bad = (status: number, code: string, path: string, message: string): never => { throw new Problem(status, code, message, [{ path, message }]); };
const q1 = async <T extends Row>(sql: string, args: unknown[]): Promise<T | undefined> => (await currentTx().query<T>(sql, args)).rows[0];

/** PAN → AES-GCM ciphertext + key id + last4 (all or none, DB CHECK). The AAD is per table (customers match the P21 importer). */
export function panCols(b: Row, aad: string): Row {
  if (!('pan' in b)) return {};
  const v = b.pan as string | null;
  if (v === null) return { pan_enc: null, pan_key_id: null, pan_last4: null };
  const { box, keyId } = seal(v, aad);
  return { pan_enc: box, pan_key_id: keyId, pan_last4: v.slice(-4) };
}
const without = (b: Row, ...k: string[]) => Object.fromEntries(Object.entries(b).filter(([x]) => !k.includes(x)));

/** item.hsn FK is held until HSN codes are seeded: format is checked by zod; once the shop has HSN masters, the code must be one of them. */
async function checkHsn(v: unknown, path: string): Promise<void> {
  if (v === null || v === undefined) return;
  const r = await q1<{ any: boolean; hit: boolean }>(`SELECT EXISTS (SELECT 1 FROM masters.hsn_code) AS any,
     EXISTS (SELECT 1 FROM masters.hsn_code WHERE code = $1 AND code_type = 'HSN' AND is_active) AS hit`, [v]);
  if (r?.any && !r.hit) bad(422, 'unknown_hsn', path, 'not an active HSN code of this shop');
}
async function purityOfMetal(purityId: unknown, metalId: unknown, path = 'purity_id'): Promise<void> {
  if (!purityId || !metalId) return;
  const r = await q1<{ m: string }>(`SELECT metal_id::text AS m FROM masters.purity WHERE id = $1`, [purityId]);
  if (r && r.m !== metalId) bad(422, 'purity_metal_mismatch', path, 'purity belongs to another metal');
}

// ---------- M3 items + sub-items ----------
const itemS = schemas({ code, short_code: opt(z.string().max(10)), name: name(120), metal_id: uuid, purity_id: uuid, hsn,
  stock_type: z.enum(['tag', 'non_tag', 'packet']), mc_type: MC.optional(), mc_value: amt.optional(), min_mc: amt.optional(),
  wastage_type: z.enum(['percent', 'weight', 'none']).optional(), wastage_value: dec(7, 3).optional(), huid_charge: amt.optional(),
  default_counter_id: opt(uuid), allow_zero_weight: z.boolean().optional() }, ['metal_id']);
export const items: Spec = { name: 'items', table: 'masters.item', area: 'items', ...itemS, sort: 'code',
  cols: `id, code, short_code, name, metal_id, purity_id, hsn, stock_type, mc_type, mc_value::text AS mc_value, min_mc::text AS min_mc, wastage_type,
    wastage_value::text AS wastage_value, huid_charge::text AS huid_charge, default_counter_id, allow_zero_weight, is_active, version`,
  fields: { code: 'text', short_code: 'text', name: 'text', metal_id: 'uuid', purity_id: 'uuid', hsn: 'text', stock_type: 'text', mc_type: 'text',
    mc_value: 'numeric', min_mc: 'numeric', wastage_type: 'text', wastage_value: 'numeric', huid_charge: 'numeric', default_counter_id: 'uuid',
    allow_zero_weight: 'bool', is_active: 'bool' },
  search: ['code', 'short_code', 'name'], filters: { metal_id: { sql: 'metal_id = ?', cast: 'uuid' }, stock_type: { sql: 'stock_type = ?', cast: 'text' } },
  refs: { metal_id: { table: 'masters.metal' }, purity_id: { table: 'masters.purity' }, default_counter_id: { table: 'masters.counter' } },
  async validate(m) { await purityOfMetal(m.purity_id, m.metal_id); await checkHsn(m.hsn, 'hsn'); },
};
const subS = schemas({ item_id: uuid, code, name: name(120), hsn: opt(hsn), measurement: z.enum(['gram', 'piece', 'carat']).optional(),
  mc_type: opt(MC), mc_value: opt(amt), wastage_value: opt(dec(7, 3)), huid_charge: opt(amt) }, ['item_id']);
export const subItems: Spec = { name: 'sub-items', table: 'masters.sub_item', area: 'items', ...subS, sort: 'code',
  cols: `id, item_id, code, name, hsn, measurement, mc_type, mc_value::text AS mc_value, wastage_value::text AS wastage_value, huid_charge::text AS huid_charge, is_active, version`,
  fields: { item_id: 'uuid', code: 'text', name: 'text', hsn: 'text', measurement: 'text', mc_type: 'text', mc_value: 'numeric', wastage_value: 'numeric', huid_charge: 'numeric', is_active: 'bool' },
  search: ['code', 'name'], filters: { item_id: { sql: 'item_id = ?', cast: 'uuid' } }, refs: { item_id: { table: 'masters.item' } },
  async validate(m) { await checkHsn(m.hsn, 'hsn'); },
};

// ---------- M4 designs (masters.design, 976) ----------
const designS = schemas({ code, name: name(140), item_id: uuid, sub_item_id: opt(uuid), purity_id: opt(uuid), designer_id: opt(uuid),
  description: opt(z.string().max(2000)), approx_gross_wt: opt(wt), approx_net_wt: opt(wt), approx_stone_wt: opt(wt), size: opt(z.string().max(30)),
  tags: z.array(z.string().trim().min(1).max(30)).max(20).optional() });
export const designs: Spec = { name: 'designs', table: 'masters.design', area: 'designs', ...designS, sort: 'code',
  cols: `id, code, name, item_id, sub_item_id, purity_id, designer_id, description, approx_gross_wt::text AS approx_gross_wt, approx_net_wt::text AS approx_net_wt,
    approx_stone_wt::text AS approx_stone_wt, size, tags, is_active, version, created_at,
    (SELECT p.file_id FROM masters.design_photo p WHERE p.design_id = masters.design.id AND p.is_primary) AS primary_photo_file_id`,
  fields: { code: 'text', name: 'text', item_id: 'uuid', sub_item_id: 'uuid', purity_id: 'uuid', designer_id: 'uuid', description: 'text', approx_gross_wt: 'numeric',
    approx_net_wt: 'numeric', approx_stone_wt: 'numeric', size: 'text', tags: 'text[]', is_active: 'bool' },
  search: ['code', 'name', "array_to_string(tags, ' ')"],
  filters: { item_id: { sql: 'item_id = ?', cast: 'uuid' }, sub_item_id: { sql: 'sub_item_id = ?', cast: 'uuid' }, designer_id: { sql: 'designer_id = ?', cast: 'uuid' },
    tag: { sql: '? = ANY(tags)', cast: 'text' } },
  refs: { item_id: { table: 'masters.item' }, sub_item_id: { table: 'masters.sub_item' }, purity_id: { table: 'masters.purity' }, designer_id: { table: 'masters.vendor' } },
  async validate(m) {
    if (m.sub_item_id) {
      const r = await q1<{ i: string }>(`SELECT item_id::text AS i FROM masters.sub_item WHERE id = $1`, [m.sub_item_id]);
      if (r && r.i !== m.item_id) bad(422, 'sub_item_mismatch', 'sub_item_id', 'sub-item belongs to another item');
    }
    if (m.purity_id) {
      const r = await q1<{ m: string }>(`SELECT metal_id::text AS m FROM masters.item WHERE id = $1`, [m.item_id]);
      await purityOfMetal(m.purity_id, r?.m);
    }
    if (m.approx_net_wt && m.approx_gross_wt && Number(m.approx_net_wt) > Number(m.approx_gross_wt)) bad(422, 'validation_failed', 'approx_net_wt', 'cannot exceed approx_gross_wt');
  },
  async expand(r) {
    const photos = (await currentTx().query(`SELECT id, file_id, sort_order, is_primary, caption, version, created_at FROM masters.design_photo
      WHERE design_id = $1 ORDER BY is_primary DESC, sort_order, created_at`, [r.id])).rows;
    return { ...r, photos };
  },
};

// ---------- M5 stones ----------
const STONE_KINDS = ['stone', 'shape', 'cut', 'clarity', 'colour', 'cent_group'] as const;
const stdS = schemas({ kind: z.enum(STONE_KINDS), code: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._+/-]{0,19}$/), name: name(80),
  cent_from: opt(dec(4, 3)), cent_to: opt(dec(4, 3)) }, ['kind']);
export const stoneStandards: Spec = { name: 'stone-standards', table: 'masters.stone_standard', area: 'stones', ...stdS, sort: "kind || ':' || code",
  cols: `id, kind, code, name, cent_from::text AS cent_from, cent_to::text AS cent_to, is_active, version`,
  fields: { kind: 'text', code: 'text', name: 'text', cent_from: 'numeric', cent_to: 'numeric', is_active: 'bool' },
  search: ['code', 'name'], filters: { kind: { sql: 'kind = ?', cast: 'text' } },
  async validate(m) {
    if (m.cent_from != null && m.cent_to != null && Number(m.cent_to) <= Number(m.cent_from)) bad(422, 'validation_failed', 'cent_to', 'must be greater than cent_from');
  },
};
const std = (kind: string) => ({ table: 'masters.stone_standard', where: `kind = '${kind}'` });
const rateS = schemas({ stone_id: opt(uuid), cent_group_id: opt(uuid), shape_id: opt(uuid), clarity_id: opt(uuid), colour_id: opt(uuid), cut_id: opt(uuid),
  vendor_id: opt(uuid), rate_unit: z.enum(['per_ct', 'per_piece']).optional(), purchase_rate: opt(amt), sale_rate: amt, effective_from: date, effective_to: opt(date) });
export const stoneRates: Spec = { name: 'stone-rates', table: 'masters.diamond_rate', area: 'stones', ...rateS, sort: 'effective_from',
  cols: `id, stone_id, cent_group_id, shape_id, clarity_id, colour_id, cut_id, vendor_id, rate_unit, purchase_rate_per_ct::text AS purchase_rate,
    sale_rate_per_ct::text AS sale_rate, effective_from::text AS effective_from, effective_to::text AS effective_to, is_active, version, created_at`,
  fields: { stone_id: 'uuid', cent_group_id: 'uuid', shape_id: 'uuid', clarity_id: 'uuid', colour_id: 'uuid', cut_id: 'uuid', vendor_id: 'uuid', rate_unit: 'text',
    purchase_rate_per_ct: 'numeric', sale_rate_per_ct: 'numeric', effective_from: 'date', effective_to: 'date', is_active: 'bool' },
  search: ["(SELECT string_agg(x.code || ' ' || x.name, ' ') FROM masters.stone_standard x WHERE x.id IN (stone_id, cent_group_id, shape_id, clarity_id, colour_id, cut_id))",
    "(SELECT v.code || ' ' || v.name FROM masters.vendor v WHERE v.id = vendor_id)"], filters: { stone_id: { sql: 'stone_id = ?', cast: 'uuid' }, cent_group_id: { sql: 'cent_group_id = ?', cast: 'uuid' }, vendor_id: { sql: 'vendor_id = ?', cast: 'uuid' },
    on: { sql: 'effective_from <= ? AND (effective_to IS NULL OR effective_to > ?)', cast: 'date' } },
  refs: { stone_id: std('stone'), cent_group_id: std('cent_group'), shape_id: std('shape'), clarity_id: std('clarity'), colour_id: std('colour'), cut_id: std('cut'),
    vendor_id: { table: 'masters.vendor' } },
  toDb(b) {
    const o = without(b, 'sale_rate', 'purchase_rate');
    if ('sale_rate' in b) o.sale_rate_per_ct = b.sale_rate;
    if ('purchase_rate' in b) o.purchase_rate_per_ct = b.purchase_rate;
    return o;
  },
  async validate(m) {
    if (!m.stone_id && !m.cent_group_id) bad(422, 'stone_or_cent_group_required', 'stone_id', 'give stone_id or cent_group_id');
    if (m.effective_to && String(m.effective_to) <= String(m.effective_from)) bad(422, 'validation_failed', 'effective_to', 'must be after effective_from');
  },
};

// ---------- M6/M7 value-addition rules (one resource, field groups making_charge | wastage) ----------
const vaS = schemas({ scope: z.enum(['customer', 'designer']), tier: z.enum(['purchase', 'retail', 'vip_retail']).optional(),
  metal_id: opt(uuid), purity_id: opt(uuid), item_id: opt(uuid), sub_item_id: opt(uuid), design_id: opt(uuid), vendor_id: opt(uuid),
  weight_from: wt.optional(), weight_to: opt(wt), touch: opt(pct),
  mc_per_gram: opt(amt), mc_percent: opt(pct), flat_mc: opt(amt), fixed_rate: opt(amt), wastage_pct: opt(pct), flat_wastage: opt(wt),
  effective_from: opt(date), effective_to: opt(date), priority: z.number().int().min(0).max(1000).optional() });
export const vaRules: Spec = { name: 'value-addition-rules', table: 'masters.value_addition_rule', area: 'making_rules', ...vaS,
  sort: "lpad((1000 - priority)::text, 4, '0') || coalesce(created_at::text, '')",
  cols: `id, scope, tier, metal_id, purity_id, item_id, sub_item_id, design_id, vendor_id, weight_from::text AS weight_from, weight_to::text AS weight_to,
    touch::text AS touch, mc_per_gram::text AS mc_per_gram, mc_percent::text AS mc_percent, flat_mc::text AS flat_mc, fixed_rate::text AS fixed_rate,
    wastage_pct::text AS wastage_pct, flat_wastage::text AS flat_wastage, effective_from::text AS effective_from, effective_to::text AS effective_to,
    priority, is_active, version, created_at`,
  fields: { scope: 'text', tier: 'text', metal_id: 'uuid', purity_id: 'uuid', item_id: 'uuid', sub_item_id: 'uuid', design_id: 'uuid', vendor_id: 'uuid',
    weight_from: 'numeric', weight_to: 'numeric', touch: 'numeric', mc_per_gram: 'numeric', mc_percent: 'numeric', flat_mc: 'numeric', fixed_rate: 'numeric',
    wastage_pct: 'numeric', flat_wastage: 'numeric', effective_from: 'date', effective_to: 'date', priority: 'int', is_active: 'bool' },
  search: ['scope', 'tier', "(SELECT i.code || ' ' || i.name FROM masters.item i WHERE i.id = item_id)", "(SELECT d.code || ' ' || d.name FROM masters.design d WHERE d.id = design_id)",
    "(SELECT v.code || ' ' || v.name FROM masters.vendor v WHERE v.id = vendor_id)", "(SELECT m.code || ' ' || m.name FROM masters.metal m WHERE m.id = metal_id)"], filters: { scope: { sql: 'scope = ?', cast: 'text' }, tier: { sql: 'tier = ?', cast: 'text' }, metal_id: { sql: 'metal_id = ?', cast: 'uuid' },
    item_id: { sql: 'item_id = ?', cast: 'uuid' }, design_id: { sql: 'design_id = ?', cast: 'uuid' }, vendor_id: { sql: 'vendor_id = ?', cast: 'uuid' } },
  refs: { metal_id: { table: 'masters.metal' }, purity_id: { table: 'masters.purity' }, item_id: { table: 'masters.item' }, sub_item_id: { table: 'masters.sub_item' },
    design_id: { table: 'masters.design' }, vendor_id: { table: 'masters.vendor' } },
  async validate(m) {
    const n = (...k: string[]) => k.filter((x) => m[x] !== null && m[x] !== undefined).length;
    if (n('mc_per_gram', 'mc_percent', 'flat_mc') > 1) bad(422, 'multiple_mc_basis', 'mc_per_gram', 'give only one of mc_per_gram, mc_percent, flat_mc');
    if (n('wastage_pct', 'flat_wastage') > 1) bad(422, 'multiple_wastage_basis', 'wastage_pct', 'give only one of wastage_pct, flat_wastage');
    if (m.weight_to != null && Number(m.weight_to) <= Number(m.weight_from ?? 0)) bad(422, 'validation_failed', 'weight_to', 'must be greater than weight_from');
    if (m.effective_to && m.effective_from && String(m.effective_to) <= String(m.effective_from)) bad(422, 'validation_failed', 'effective_to', 'must be after effective_from');
    await purityOfMetal(m.purity_id, m.metal_id);
  },
};

// ---------- M8 customers (KYC status; Aadhaar not collected) ----------
const custS = schemas({ name: name(120), phone: opt(phone), email: opt(z.string().email().max(200)), dob: opt(date), anniversary: opt(date), gstin: opt(gstin),
  state_code: opt(stateCode), pan: opt(pan), upi_id: opt(z.string().max(100)), address: obj.optional(), group_id: opt(uuid), home_branch_id: opt(uuid),
  kyc_status: z.enum(['none', 'pending', 'verified', 'rejected', 'expired']).optional(), kyc_consent: z.boolean().optional() });
/** Aadhaar is not collected at all (lead + Perceptor 2026-10-28; 979/984): explicit code instead of a generic unknown-field 422. */
export function rejectAadhaar(body: unknown): void {
  if (body && typeof body === 'object' && 'aadhaar_last4' in body) bad(422, 'aadhaar_not_allowed', 'aadhaar_last4', 'Aadhaar is not collected; use PAN or another ID');
}
export const customers: Spec = { name: 'customers', table: 'masters.customer', area: 'customers', ...custS, sort: 'name',
  cols: `id, name, phone, email, dob::text AS dob, anniversary::text AS anniversary, gstin, state_code, pan_last4, upi_id, address, group_id, home_branch_id,
    consent_at, kyc_status, kyc_verified_at, kyc_verified_by, is_active, version, created_at`,
  fields: { name: 'text', phone: 'text', email: 'text', dob: 'date', anniversary: 'date', gstin: 'text', state_code: 'text', pan_enc: 'bytea', pan_key_id: 'text',
    pan_last4: 'text', upi_id: 'text', address: 'jsonb', group_id: 'uuid', home_branch_id: 'uuid', kyc_status: 'text', kyc_verified_at: 'timestamptz',
    kyc_verified_by: 'uuid', consent_at: 'timestamptz', is_active: 'bool' },
  search: ['name', 'phone', 'gstin', 'pan_last4'], filters: { kyc_status: { sql: 'kyc_status = ?', cast: 'text' }, home_branch_id: { sql: 'home_branch_id = ?', cast: 'uuid' } },
  refs: { home_branch_id: { table: 'platform.branch' }, group_id: { table: 'masters.customer_group', active: false } },
  toDb(b, ctx) {
    const o: Row = { ...without(b, 'pan', 'kyc_consent'), ...panCols(b, 'masters.customer.pan') };
    // G18: consent_at is set server-side; true records consent now, false withdraws it
    if ('kyc_consent' in b) o.consent_at = b.kyc_consent ? new Date().toISOString() : null;
    if ('kyc_status' in b) {
      const v = b.kyc_status === 'verified';
      o.kyc_verified_at = v ? new Date().toISOString() : null; o.kyc_verified_by = v ? ctx.auth.userId : null;
    }
    return o;
  },
  async validate(m) {
    if (m.gstin && m.state_code && String(m.gstin).slice(0, 2) !== m.state_code) bad(422, 'validation_failed', 'state_code', 'does not match GSTIN');
  },
};

// ---------- M10 vendors / karigars ----------
const VENDOR_KINDS = ['designer', 'supplier', 'repair_vendor', 'smith', 'refiner', 'diamond_seller', 'buyer'] as const;
/** G7 shapes (979 stores jsonb arrays without a shape; contract Address / VendorContact) */
const str = (max: number) => z.string().trim().min(1).max(max);
const VendorAddress = z.object({ line1: str(200), line2: str(200), city: str(80), district: str(80), pincode: z.string().regex(/^[0-9]{6}$/) }).partial().strict();
const VendorContact = z.object({ name: str(120), phone: phone.optional(), email: z.string().email().max(200).optional(), role: str(60).optional() }).strict();
const vendS = schemas({ code, name: name(140), kinds: z.array(z.enum(VENDOR_KINDS)).max(7), gstin: opt(gstin), state_code: opt(stateCode), pan: opt(pan),
  addresses: z.array(VendorAddress).max(5).optional(), contacts: z.array(VendorContact).max(10).optional() });
export const VENDOR_PAN_AAD = 'masters.vendor.pan';
export const vendors: Spec = { name: 'vendors', table: 'masters.vendor', area: 'vendors', ...vendS, sort: 'code',
  cols: `id, code, name, kinds, gstin, state_code, pan_last4, addresses, contacts, is_active, version`,
  fields: { code: 'text', name: 'text', kinds: 'text[]', gstin: 'text', state_code: 'text', pan: 'text', pan_enc: 'bytea', pan_key_id: 'text', pan_last4: 'text',
    addresses: 'jsonb', contacts: 'jsonb', is_active: 'bool' },
  search: ['code', 'name', 'gstin'], filters: { kind: { sql: '? = ANY(kinds)', cast: 'text' } },
  // 983 (vendor.pan drop) is held until the backfill is verified: keep writing the legacy plaintext column alongside the ciphertext
  // so old readers keep working; responses never return it (pan_last4 only).
  toDb(b) { return { ...b, ...panCols(b, VENDOR_PAN_AAD) }; },
  async validate(m) {
    if (m.gstin && m.state_code && String(m.gstin).slice(0, 2) !== m.state_code) bad(422, 'validation_failed', 'state_code', 'does not match GSTIN');
  },
};

// ---------- M11 staff (hr.staff; HR module is a stub, the master lives here) ----------
/** 984 free text (1-100 chars); blank / whitespace-only → NULL */
const freeText = z.preprocess((x) => (typeof x === 'string' && x.trim() === '' ? null : typeof x === 'string' ? x.trim() : x), z.string().max(100).nullable()).optional();
const staffS = schemas({ code, name: name(120), phone: opt(phone), branch_id: uuid, pan: opt(pan),
  department: freeText, designation: freeText,
  address: obj.optional(), joined_on: opt(date), left_on: opt(date), is_salesperson: z.boolean().optional(), photo_file_id: opt(uuid) });
const ATTACHMENT = { table: 'platform.file', active: false, where: "area = 'attachments' AND deleted_at IS NULL" };
export const staff: Spec = { name: 'staff', table: 'hr.staff', area: 'staff', ...staffS, sort: 'code',
  cols: `id, code, name, phone, branch_id, department, designation, pan_last4, address, joined_on::text AS joined_on, left_on::text AS left_on,
    is_salesperson, photo_file_id, is_active, version`,
  fields: { code: 'text', name: 'text', phone: 'text', branch_id: 'uuid', department: 'text', designation: 'text', pan_enc: 'bytea', pan_key_id: 'text',
    pan_last4: 'text', address: 'jsonb', joined_on: 'date', left_on: 'date', is_salesperson: 'bool', photo_file_id: 'uuid', is_active: 'bool' },
  search: ['code', 'name', 'phone', 'department', 'designation'], filters: { branch_id: { sql: 'branch_id = ?', cast: 'uuid' }, is_salesperson: { sql: 'is_salesperson = ?', cast: 'bool' } },
  refs: { branch_id: { table: 'platform.branch' },
    photo_file_id: ATTACHMENT },
  toDb(b) { return { ...without(b, 'pan'), ...panCols(b, 'hr.staff.pan') }; },
  async validate(m) { if (m.left_on && m.joined_on && String(m.left_on) < String(m.joined_on)) bad(422, 'validation_failed', 'left_on', 'before joined_on'); },
};

// ---------- M12 floors / counters / trays ----------
const floorS = schemas({ branch_id: uuid, code: opt(z.string().regex(/^[A-Za-z0-9_-]{1,10}$/)), name: name(60) }, ['branch_id']);
export const floors: Spec = { name: 'floors', table: 'masters.floor', area: 'counters', ...floorS, sort: "coalesce(code, name)",
  cols: `id, branch_id, code, name, is_active, version`, fields: { branch_id: 'uuid', code: 'text', name: 'text', is_active: 'bool' },
  search: ['code', 'name'], filters: { branch_id: { sql: 'branch_id = ?', cast: 'uuid' } }, refs: { branch_id: { table: 'platform.branch' } } };
const counterS = schemas({ branch_id: uuid, floor_id: opt(uuid), code: z.string().regex(/^[A-Za-z0-9_-]{1,20}$/), name: name(60) }, ['branch_id']);
export const counters: Spec = { name: 'counters', table: 'masters.counter', area: 'counters', ...counterS, sort: 'code',
  cols: `id, branch_id, floor_id, code, name, is_active, version`, fields: { branch_id: 'uuid', floor_id: 'uuid', code: 'text', name: 'text', is_active: 'bool' },
  search: ['code', 'name'], filters: { branch_id: { sql: 'branch_id = ?', cast: 'uuid' }, floor_id: { sql: 'floor_id = ?', cast: 'uuid' } },
  refs: { branch_id: { table: 'platform.branch' }, floor_id: { table: 'masters.floor' } },
  async validate(m) {
    if (!m.floor_id) return;
    const f = await q1<{ b: string }>(`SELECT branch_id::text AS b FROM masters.floor WHERE id = $1`, [m.floor_id]);
    if (f && f.b !== m.branch_id) bad(422, 'floor_branch_mismatch', 'floor_id', 'floor is in another branch');
  },
};
const trayS = schemas({ counter_id: uuid, sub_item_id: opt(uuid), code: z.string().regex(/^[A-Za-z0-9_-]{1,20}$/), name: opt(name(100)), tare_weight: opt(wt) });
export const trays: Spec = { name: 'trays', table: 'masters.box', area: 'counters', ...trayS, sort: 'code',
  cols: `id, counter_id, sub_item_id, code, name, tare_weight::text AS tare_weight, is_active, version`,
  fields: { counter_id: 'uuid', sub_item_id: 'uuid', code: 'text', name: 'text', tare_weight: 'numeric', is_active: 'bool' },
  search: ['code', 'name'], filters: { counter_id: { sql: 'counter_id = ?', cast: 'uuid' } },
  refs: { counter_id: { table: 'masters.counter' }, sub_item_id: { table: 'masters.sub_item' } } };

// ---------- M13 HSN / SAC (GST rate comes from tax_rule on hsn_sac) ----------
const hsnS = schemas({ code_type: z.enum(['HSN', 'SAC']), code: hsn, description: name(300), uqc: opt(z.string().regex(/^[A-Z]{3}$/)) }, ['code_type', 'code']);
export const hsnCodes: Spec = { name: 'hsn-codes', table: 'masters.hsn_code', area: 'tax', ...hsnS, sort: "code_type || code",
  cols: `id, code_type, code, description, uqc, is_active, version, created_at`, fields: { code_type: 'text', code: 'text', description: 'text', uqc: 'text', is_active: 'bool' },
  search: ['code', 'description'], filters: { code_type: { sql: 'code_type = ?', cast: 'text' } } };

// ---------- M14 payment modes / M15 card machines ----------
const PAY_KINDS = ['cash', 'upi', 'debit_card', 'credit_card', 'bank_transfer', 'cheque', 'gift_voucher', 'advance', 'chit', 'credit_note', 'old_gold'] as const;
const payS = schemas({ code: z.string().regex(/^[A-Z0-9_]{1,20}$/), name: name(60), kind: z.enum(PAY_KINDS), account_head_id: opt(uuid),
  requires_reference: z.boolean().optional(), requires_card_machine: z.boolean().optional(), sort_order: z.number().int().min(0).max(9999).optional() });
export const paymentModes: Spec = { name: 'payment-modes', table: 'masters.payment_mode', area: 'payments', ...payS, sort: "lpad(sort_order::text, 5, '0') || code",
  cols: `id, code, name, kind, account_head_id, requires_reference, requires_card_machine, sort_order, is_active, version, created_at`,
  fields: { code: 'text', name: 'text', kind: 'text', account_head_id: 'uuid', requires_reference: 'bool', requires_card_machine: 'bool', sort_order: 'int', is_active: 'bool' },
  search: ['code', 'name'], filters: { kind: { sql: 'kind = ?', cast: 'text' } }, refs: { account_head_id: { table: 'accounts.account_head', active: false } },
  async validate(m) {
    if (m.requires_card_machine && !['debit_card', 'credit_card', 'upi'].includes(String(m.kind)))
      bad(422, 'card_machine_kind', 'requires_card_machine', 'only debit_card, credit_card and upi modes can require a card machine');
  },
};
const cmS = schemas({ branch_id: uuid, cash_counter_id: opt(uuid), code: z.string().regex(/^[A-Za-z0-9_-]{1,20}$/), provider: z.string().trim().min(2).max(60),
  terminal_id: z.string().regex(/^[A-Za-z0-9]{4,20}$/), merchant_id: opt(z.string().regex(/^[A-Za-z0-9]{4,30}$/)), settlement_bank_account_id: opt(uuid),
  supports: z.array(z.enum(['debit_card', 'credit_card', 'upi'])).min(1).max(3).optional(), mdr_pct: opt(dec(2, 3).refine((v) => Number(v) <= 10, '0–10')) });
export const cardMachines: Spec = { name: 'card-machines', table: 'masters.card_machine', area: 'payments', ...cmS, sort: 'code',
  cols: `id, branch_id, cash_counter_id, code, provider, terminal_id, merchant_id, settlement_bank_account_id, supports, mdr_pct::text AS mdr_pct, is_active, version, created_at`,
  fields: { branch_id: 'uuid', cash_counter_id: 'uuid', code: 'text', provider: 'text', terminal_id: 'text', merchant_id: 'text', settlement_bank_account_id: 'uuid',
    supports: 'text[]', mdr_pct: 'numeric', is_active: 'bool' },
  search: ['code', 'provider', 'terminal_id'], filters: { branch_id: { sql: 'branch_id = ?', cast: 'uuid' } },
  refs: { branch_id: { table: 'platform.branch' }, cash_counter_id: { table: 'accounts.cash_counter' },
    settlement_bank_account_id: { table: 'masters.bank_account', where: "owner_type = 'company'" } },
  async validate(m) {
    if (!m.cash_counter_id) return;
    const c = await q1<{ b: string }>(`SELECT branch_id::text AS b FROM accounts.cash_counter WHERE id = $1`, [m.cash_counter_id]);
    if (c && c.b !== m.branch_id) bad(422, 'cash_counter_branch_mismatch', 'cash_counter_id', 'cash counter is in another branch');
  },
};

// ---------- M8/M10/M11 KYC documents (number → kyc_document_secret, last4 shown) ----------
const DOC_TYPES = ['pan', 'passport', 'voter_id', 'driving_licence', 'gstin_certificate', 'other'] as const;
const kycS = schemas({ party_type: z.enum(['customer', 'vendor', 'staff']), party_id: uuid, doc_type: z.enum(DOC_TYPES),
  number: opt(z.string().trim().toUpperCase().pipe(z.string().regex(/^[A-Z0-9]{4,30}$/, '4–30 letters/digits'))),
  front_file_id: uuid, back_file_id: opt(uuid), status: z.enum(['pending', 'verified', 'rejected', 'expired']).optional(), expires_on: opt(date) },
  ['party_type', 'party_id']);
const PARTY_COL: Record<string, string> = { customer: 'customer_id', vendor: 'vendor_id', staff: 'staff_id' };
const PARTY_AREA: Record<string, string> = { customer: 'customers', vendor: 'vendors', staff: 'staff' };
export const kycDocuments: Spec = { name: 'kyc-documents', table: 'masters.kyc_document', area: (r) => PARTY_AREA[String(r.party_type)] ?? 'customers', ...kycS,
  sort: 'created_at',
  cols: `id, party_type, coalesce(customer_id, vendor_id, staff_id) AS party_id, doc_type, number_last4, front_file_id, back_file_id, status, verified_at, verified_by,
    expires_on::text AS expires_on, is_active, version, created_at`,
  fields: { party_type: 'text', customer_id: 'uuid', vendor_id: 'uuid', staff_id: 'uuid', doc_type: 'text', number_last4: 'text', front_file_id: 'uuid', back_file_id: 'uuid',
    status: 'text', verified_at: 'timestamptz', verified_by: 'uuid', expires_on: 'date', is_active: 'bool' },
  search: ['number_last4', 'doc_type', 'status'], filters: { party_type: { sql: 'party_type = ?', cast: 'text' }, party_id: { sql: 'coalesce(customer_id, vendor_id, staff_id) = ?', cast: 'uuid' },
    doc_type: { sql: 'doc_type = ?', cast: 'text' }, status: { sql: 'status = ?', cast: 'text' } },
  refs: { customer_id: { table: 'masters.customer' }, vendor_id: { table: 'masters.vendor' }, staff_id: { table: 'hr.staff' }, front_file_id: ATTACHMENT, back_file_id: ATTACHMENT },
  toDb(b: Row, ctx: WriteCtx) {
    const o: Row = without(b, 'party_id', 'number');
    if (b.party_type) o[PARTY_COL[String(b.party_type)]] = b.party_id;
    if ('number' in b) o.number_last4 = b.number ? String(b.number).slice(-4) : null;
    if ('status' in b) {
      const v = b.status === 'verified';
      o.verified_at = v ? new Date().toISOString() : null; o.verified_by = v ? ctx.auth.userId : null;
    }
    return o;
  },
  async validate(m) {
    // lead decision 2026-10-28: no Aadhaar for customer KYC
    if (m.doc_type === 'pan' && m.number_last4 && !/^[0-9]{3}[A-Z]$/.test(String(m.number_last4))) bad(422, 'validation_failed', 'number', 'invalid PAN');
  },
  async afterWrite(row, body) {
    if (!('number' in body)) return;
    const c = currentTx();
    await c.query(`DELETE FROM masters.kyc_document_secret WHERE kyc_document_id = $1`, [row.id]);
    if (body.number) {
      const { box, keyId } = seal(String(body.number), `masters.kyc_document:${String(row.id)}`);
      await c.query(`INSERT INTO masters.kyc_document_secret(tenant_id, kyc_document_id, number_enc, number_key_id) VALUES (platform.current_tenant(), $1, $2, $3)`,
        [row.id, box, keyId]);
    }
  },
};

// ---------- O13 repair types (Orders reads them; min/max charge limits are enforced by Orders on repair lines) ----------
/** Compares two non-negative decimal strings with up to 2 decimals exactly (no floats): -1, 0 or 1. */
const cents = (v: string): bigint => { const [i, f = ''] = v.split('.'); return BigInt(i) * 100n + BigInt(f.padEnd(2, '0')); };
const repairTypeS = schemas({ name: name(80), sac: opt(hsn), min_customer_charge: opt(amt), max_customer_charge: opt(amt), min_vendor_charge: opt(amt), max_vendor_charge: opt(amt) });
export const repairTypes: Spec = { name: 'repair-types', table: 'masters.repair_type', area: 'repair_types', ...repairTypeS, sort: 'name',
  cols: `id, name, sac, min_customer_charge::text AS min_customer_charge, max_customer_charge::text AS max_customer_charge,
    min_vendor_charge::text AS min_vendor_charge, max_vendor_charge::text AS max_vendor_charge, is_active, version`,
  fields: { name: 'text', sac: 'text', min_customer_charge: 'numeric', max_customer_charge: 'numeric', min_vendor_charge: 'numeric', max_vendor_charge: 'numeric', is_active: 'bool' },
  search: ['name', 'sac'], filters: {},
  async validate(m) {
    for (const [lo, hi] of [['min_customer_charge', 'max_customer_charge'], ['min_vendor_charge', 'max_vendor_charge']] as const) {
      if (m[lo] != null && m[hi] != null && cents(String(m[lo])) > cents(String(m[hi]))) bad(422, 'validation_failed', lo, `must not be more than ${hi}`);
    }
  },
};

/** Routed generic masters (metals/purities keep their 0.6.x controller; their specs below are for import/export only). */
export const ROUTED: Spec[] = [items, subItems, designs, stoneStandards, stoneRates, vaRules, customers, vendors, staff, floors, counters, trays, hsnCodes,
  paymentModes, cardMachines, kycDocuments, repairTypes];
export const SPECS = new Map(ROUTED.map((s) => [s.name, s]));
