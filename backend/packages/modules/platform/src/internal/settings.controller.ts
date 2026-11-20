import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { currentTx } from '@jw/db';
import { supportedLocales } from '@jw/shared';
const latinOnlyFields = ['gstin', 'huid', 'invoice_no', 'phone', 'barcode', 'pan', 'hsn'];
import { Ctx, JwRequest, RequirePermission, fail, ifMatch, parse, pgProblem, todayIST } from './common';
import { SalesPolicyBody, SettingBody, uuid } from './schemas';
import { audit } from './session.service';

const MONEY = /^[0-9]{1,12}\.[0-9]{2}$/;
/** Settings read: numbers are returned as decimal strings (money), never JSON floats. */
const SETTING_SQL = `
  SELECT d.key, d.value_type, d.tenant_overridable, d.description,
         CASE WHEN d.value_type = 'number' THEN to_jsonb(to_char((coalesce(b.value, t.value, d.value) #>> '{}')::numeric, 'FM999999999990.00')) ELSE coalesce(b.value, t.value, d.value) END AS value,
         CASE WHEN d.value_type = 'number' THEN to_jsonb(to_char((d.value #>> '{}')::numeric, 'FM999999999990.00')) ELSE d.value END AS default_value,
         CASE WHEN b.value IS NOT NULL THEN 'branch' WHEN t.value IS NOT NULL THEN 'tenant' ELSE 'platform' END AS source,
         CASE WHEN $1::uuid IS NOT NULL THEN b.version ELSE t.version END AS version
    FROM platform.setting_default d
    LEFT JOIN platform.setting t ON t.key = d.key AND t.branch_id IS NULL
    LEFT JOIN platform.setting b ON b.key = d.key AND b.branch_id = $1::uuid`;
const POLICY = `id, scope, making_gst_treatment, making_tax_rule_code, old_gold_valuation_basis, old_gold_excess_handling,
  credit_note_rounding, return_settlement_default, return_window_days, to_char(effective_from, 'YYYY-MM-DD') AS effective_from,
  to_char(effective_to, 'YYYY-MM-DD') AS effective_to`;

/** Language catalogue (P14). amount_in_words_verified mirrors packages/shared (en only; others need native-speaker verification). */
const LANGS = [
  { code: 'en', name: 'English', numeral_system: 'latin' }, { code: 'ta', name: 'தமிழ் (Tamil)', numeral_system: 'tamil' },
  { code: 'hi', name: 'हिन्दी (Hindi)', numeral_system: 'devanagari' }, { code: 'te', name: 'తెలుగు (Telugu)', numeral_system: 'telugu' },
  { code: 'kn', name: 'ಕನ್ನಡ (Kannada)', numeral_system: 'kannada' }, { code: 'ml', name: 'മലയാളം (Malayalam)', numeral_system: 'malayalam' },
];

@Controller('v1/settings')
export class SettingsController {
  @Get()
  async list(@Query('branch_id') branchId?: string) {
    if (branchId && !uuid.safeParse(branchId).success) fail(422, 'validation_failed', 'branch_id');
    return (await currentTx().query(`${SETTING_SQL} ORDER BY d.key`, [branchId ?? null])).rows;
  }

  @Get('sales-policy')
  async policy(@Query('on') on?: string) {
    const d = on ?? todayIST();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) fail(422, 'validation_failed', 'on');
    const r = await currentTx().query(
      `SELECT ${POLICY} FROM masters.sales_policy WHERE effective_from <= $1::date AND (effective_to IS NULL OR effective_to > $1::date)
        ORDER BY (scope = 'tenant') DESC LIMIT 1`, [d]);
    return r.rows[0] ?? fail(404, 'not_found');
  }

  @Get('sales-policy/history')
  async history() {
    return (await currentTx().query(`SELECT ${POLICY} FROM masters.sales_policy ORDER BY effective_from DESC, scope DESC`)).rows;
  }

  /** New dated tenant row (never back-dated); the open tenant row is closed the day before. Overlaps → 409. */
  @Post('sales-policy') @RequirePermission('platform.settings.edit')
  async createPolicy(@Body() body: unknown) {
    const b = parse(SalesPolicyBody, body);
    const from = b.effective_from ?? todayIST();
    if (from < todayIST()) fail(422, 'back_dated', 'effective_from must not be before today (IST)');
    const c = currentTx();
    try {
      await c.query(`UPDATE masters.sales_policy SET effective_to = $1::date WHERE scope = 'tenant' AND effective_from < $1::date AND (effective_to IS NULL OR effective_to > $1::date)`, [from]);
      const r = await c.query<{ id: string }>(
        `INSERT INTO masters.sales_policy(scope, tenant_id, making_gst_treatment, making_tax_rule_code, old_gold_valuation_basis, old_gold_excess_handling,
                                          credit_note_rounding, return_settlement_default, return_window_days, effective_from)
         VALUES ('tenant', platform.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${POLICY}`,
        [b.making_gst_treatment, b.making_tax_rule_code ?? null, b.old_gold_valuation_basis, b.old_gold_excess_handling,
         b.credit_note_rounding, b.return_settlement_default, b.return_window_days, from]);
      await audit('settings.sales_policy', 'masters.sales_policy', r.rows[0].id, r.rows[0]);
      return r.rows[0];
    } catch (e) { return pgProblem(e); }
  }

  @Get('language')
  async language(@Ctx() req: JwRequest) {
    const c = currentTx();
    const t = await c.query<{ default_language: string }>(`SELECT default_language FROM platform.tenant WHERE id = platform.current_tenant()`);
    const u = req.auth ? await c.query<{ language: string | null }>(`SELECT language FROM platform.app_user WHERE id = $1`, [req.auth.userId]) : null;
    const shop = t.rows[0]?.default_language ?? 'en';
    const own = u?.rows[0]?.language ?? null;
    const verified = new Set(supportedLocales().map((l) => l.split('-')[0]));
    return { shop_default: shop, user_override: own, effective: own ?? shop,
      supported: LANGS.map((l) => ({ ...l, amount_in_words_verified: verified.has(l.code) })), latin_only_fields: [...latinOnlyFields] };
  }

  @Put(':key') @RequirePermission('platform.settings.edit')
  async put(@Ctx() req: JwRequest, @Param('key') key: string, @Body() body: unknown, @Query('branch_id') branchId?: string) {
    const b = parse(SettingBody, body);
    const c = currentTx();
    const d = await c.query<{ value_type: string; tenant_overridable: boolean }>(`SELECT value_type, tenant_overridable FROM platform.setting_default WHERE key = $1`, [key]);
    const def = d.rows[0] ?? fail(404, 'unknown_setting');
    if (!def.tenant_overridable) fail(422, 'setting_not_overridable');
    if (branchId && !uuid.safeParse(branchId).success) fail(422, 'validation_failed', 'branch_id');
    let json: string;
    if (def.value_type === 'number') {
      if (typeof b.value !== 'string' || !MONEY.test(b.value)) fail(422, 'setting_type', `${key} expects a decimal string like "200000.00"`);
      json = b.value as string;                               // JSON number literal built from a validated decimal string
    } else if (def.value_type === 'integer') {
      if (typeof b.value !== 'number') fail(422, 'setting_type', `${key} expects an integer`);
      json = JSON.stringify(b.value);
    } else if (def.value_type === 'boolean') {
      if (typeof b.value !== 'boolean') fail(422, 'setting_type', `${key} expects a boolean`);
      json = JSON.stringify(b.value);
    } else {
      if (typeof b.value !== 'string') fail(422, 'setting_type', `${key} expects text`);
      json = JSON.stringify(b.value);
    }
    if (key === 'auth.session_timeout_minutes' && ((b.value as number) < 1 || (b.value as number) > 720)) fail(422, 'setting_range', '1..720 minutes');
    if (key === 'auth.otp_channel' && !['sms', 'whatsapp'].includes(b.value as string)) fail(422, 'setting_range', 'sms | whatsapp');
    if (key === 'invoice.rounding' && !['none', 'nearest_rupee'].includes(b.value as string)) fail(422, 'setting_range', 'none | nearest_rupee');
    await checkSettingVersion(req, key, branchId);
    try {
      await c.query(
        `INSERT INTO platform.setting(tenant_id, branch_id, key, value) VALUES (platform.current_tenant(), $1, $2, $3::jsonb)
         ON CONFLICT (tenant_id, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid), key)
         DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [branchId ?? null, key, json]);
    } catch (e) { return pgProblem(e); }
    return (await c.query(`${SETTING_SQL} WHERE d.key = $2`, [branchId ?? null, key])).rows[0];
  }

  @Delete(':key') @HttpCode(204) @RequirePermission('platform.settings.edit')
  async reset(@Ctx() req: JwRequest, @Param('key') key: string, @Query('branch_id') branchId?: string) {
    if (branchId && !uuid.safeParse(branchId).success) fail(422, 'validation_failed', 'branch_id');
    await checkSettingVersion(req, key, branchId);
    await currentTx().query(`DELETE FROM platform.setting WHERE key = $1 AND branch_id IS NOT DISTINCT FROM $2::uuid`, [key, branchId ?? null]);
  }
}

/** If-Match is required only when an override row exists at this level (first override = create). Row is locked for the tx. */
async function checkSettingVersion(req: JwRequest, key: string, branchId?: string): Promise<void> {
  const r = await currentTx().query<{ version: number }>(
    `SELECT version FROM platform.setting WHERE key = $1 AND branch_id IS NOT DISTINCT FROM $2::uuid FOR UPDATE`, [key, branchId ?? null]);
  if (!r.rows[0]) return;
  if (ifMatch(req) !== r.rows[0].version) fail(412, 'version_mismatch');
}
