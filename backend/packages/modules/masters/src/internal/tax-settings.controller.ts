import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import { currentTx } from '@jw/db';
import { RequirePermission, fail, needKey, requestHash, withIdempotency, markOnboardingStepCompleted, parse, pgProblem, todayIST } from '@jw/mod-platform';
import { z } from 'zod';

/**
 * GST settings (contract 0.4.3): /v1/settings/gst-config and /v1/settings/tax-rules over masters.gst_config / masters.tax_rule.
 * Tenant RLS applies (tax_read shows platform defaults + own rules; tax_write only own tenant-scope rows).
 * Neither table has a version column, and the contract declares no If-Match on these routes.
 * Contract field names are mapped to the data-model column names in SQL only.
 *
 * Periods are [effective_from, effective_to) — effective_to is exclusive (DB EXCLUDE on daterange(from, to) &&), so closing a row
 * at D and starting its successor at D leaves no gap and no overlap. Date rules (IST): new effective_from >= today; a close sets
 * effective_to >= today and > effective_from. tax_rule also has these in the DB trigger (tax_rule_guard); gst_config has only the
 * CHECK (to > from) in the DB, so the API enforces the today rules for it. Checked here first so clients get named codes.
 */
type Reply = { status(n: number): unknown };
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const pct = z.string().regex(/^[0-9]{1,3}(\.[0-9]{1,3})?$/);
const unit = z.enum(['0.01', '0.10', '0.50', '1.00']);

export const GstConfigInput = z.object({
  company_id: z.string().uuid().nullable().optional(),
  registration_type: z.enum(['regular', 'composition', 'unregistered']),
  tax_inclusive: z.boolean(),
  rounding_level: z.enum(['line', 'invoice']),
  round_off_unit: unit,
  einvoice_enabled: z.boolean().optional(),
  einvoice_from: date.nullable().optional(),
  b2c_qr: z.boolean().optional(),
  effective_from: date,
  effective_to: date.nullable().optional(),
}).strict();

export const TaxRuleInput = z.object({
  code: z.string().min(1).max(60),
  description: z.string().max(500).optional(),
  component: z.enum(['metal', 'making', 'stone', 'hallmark', 'service', 'old_metal_purchase', 'other']),
  metal_code: z.string().max(10).nullable().optional(),
  code_type: z.enum(['HSN', 'SAC']),
  hsn_sac: z.string().regex(/^[0-9]{4,8}$/),
  rate: pct, cgst_rate: pct, sgst_rate: pct, igst_rate: pct, cess_rate: pct.optional(),
  composite_supply: z.boolean().optional(),
  principal_component: z.enum(['metal', 'service']).optional(),
  reverse_charge: z.boolean().optional(),
  effective_from: date,
  effective_to: date.optional(),
}).strict();

const Close = z.object({ effective_to: date }).strict();
export const GstConfigReplaceInput = GstConfigInput.omit({ company_id: true });
export const TaxRuleReplaceInput = TaxRuleInput.omit({ component: true, metal_code: true });
type Row = Record<string, unknown> & { id: string; effective_from: string; effective_to: string | null };

/** Same rule as the import commit: Idempotency-Key required on replace (contract IdempotencyKey parameter). */
function startRule(from: string): void {
  if (from < todayIST()) fail(422, 'effective_from_in_past', `effective_from ${from} is before today (IST)`);
}
function closeRule(row: { effective_from: string }, to: string): void {
  if (to < todayIST()) fail(422, 'effective_to_in_past', `effective_to ${to} is before today (IST)`);
  if (to <= row.effective_from) fail(422, 'invalid_period', 'effective_to must be after effective_from');
}
/** Replace preconditions shared by both tables (old row already locked). Returns 'replay' when old was closed exactly at the new start. */
function replaceRule(old: Row, from: string): 'fresh' | 'replay' {
  startRule(from);
  if (old.effective_to === from) return 'replay';
  if (from <= old.effective_from) fail(422, 'invalid_period', 'new effective_from must be after the replaced row\'s effective_from');
  if (old.effective_to !== null && from > old.effective_to) fail(422, 'invalid_period', 'new effective_from is after the replaced row\'s end: that would leave a gap');
  return 'fresh';
}
const SCOPE_GST = 'POST /v1/settings/gst-config/{id}/replace';
const SCOPE_TAX = 'POST /v1/settings/tax-rules/{id}/replace';
/** Idempotent replay: the successor must match the body exactly, else the row was replaced by a different request. */
function sameAs(created: Row | undefined, want: Record<string, unknown>): created is Row {
  return !!created && Object.entries(want).every(([k, v]) => created[k] === v);
}
const fail409Replaced = (): never => fail(409, 'already_replaced', 'this period was already replaced by a different successor');

const GST = `id, company_id, registration_type, tax_inclusive_pricing AS tax_inclusive, rounding_level,
  round_off_to::text AS round_off_unit, einvoice_enabled, einvoice_from::text AS einvoice_from, b2c_qr_required AS b2c_qr,
  effective_from::text AS effective_from, effective_to::text AS effective_to`;
const RULE = `id, scope, code, description, component, metal_code, code_type, hsn_sac, rate::text AS rate, cgst_rate::text AS cgst_rate,
  sgst_rate::text AS sgst_rate, igst_rate::text AS igst_rate, cess_rate::text AS cess_rate, composite_supply, principal_component,
  reverse_charge, effective_from::text AS effective_from, effective_to::text AS effective_to, (first_used_at IS NOT NULL) AS in_use`;

/** 23P01 (EXCLUDE: overlapping effective period) → 409 overlapping_period; 23503 bad company → 422; rest → standard mapping (23514/P0001 → 422). */
function overlapOr(e: unknown): never {
  const code = (e as { code?: string }).code;
  if (code === '23P01') fail(409, 'overlapping_period', 'another period overlaps these dates');
  if (code === '23503') fail(422, 'unknown_company', 'company_id is not a company of this shop');
  return pgProblem(e);
}

/** 404 if invisible, 403 platform_rule for platform defaults, else the tenant rule locked FOR UPDATE (RLS: own tenant rows only). */
async function lockTenantRule(id: string): Promise<Row & { scope: string; in_use: boolean; component: string; metal_code: string | null }> {
  const c = currentTx();
  const s = (await c.query<{ scope: string }>(`SELECT scope FROM masters.tax_rule WHERE id = $1`, [id])).rows[0] ?? fail(404, 'not_found');
  if (s.scope === 'platform') fail(403, 'platform_rule', 'platform default rules cannot be changed by a shop; add a tenant rule instead');
  return (await c.query(`SELECT ${RULE} FROM masters.tax_rule WHERE id = $1 AND scope = 'tenant' FOR UPDATE`, [id])).rows[0] ?? fail(404, 'not_found');
}

@Controller('v1/settings')
export class TaxSettingsController {
  @Get('gst-config')
  async gstConfig(@Query('company_id') companyId?: string) {
    const cid = companyId === undefined ? null : parse(z.string().uuid(), companyId);
    return (await currentTx().query(
      `SELECT ${GST} FROM masters.gst_config WHERE ($1::uuid IS NULL OR company_id = $1 OR company_id IS NULL)
       ORDER BY effective_from DESC, id DESC`, [cid])).rows;
  }

  @Post('gst-config') @RequirePermission('platform.settings.edit')
  async createGstConfig(@Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    const b = parse(GstConfigInput, body);
    startRule(b.effective_from);
    try {
      const r = await currentTx().query(
        `INSERT INTO masters.gst_config(tenant_id, company_id, registration_type, tax_inclusive_pricing, rounding_level, round_off_to,
           einvoice_enabled, einvoice_from, b2c_qr_required, effective_from, effective_to)
         VALUES (platform.current_tenant(), $1, $2, $3, $4, $5::numeric, $6, $7, $8, $9, $10) RETURNING ${GST}`,
        [b.company_id ?? null, b.registration_type, b.tax_inclusive, b.rounding_level, b.round_off_unit, b.einvoice_enabled ?? false,
          b.einvoice_from ?? null, b.b2c_qr ?? false, b.effective_from, b.effective_to ?? null]);
      await markOnboardingStepCompleted('gst');
      reply.status(201);
      return r.rows[0];
    } catch (e) { return overlapOr(e); }
  }

  @Patch('gst-config/:id') @RequirePermission('platform.settings.edit')
  async closeGstConfig(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parse(Close, body);
    const c = currentTx();
    const row = (await c.query<Row>(`SELECT ${GST} FROM masters.gst_config WHERE id = $1 FOR UPDATE`, [id])).rows[0] ?? fail(404, 'not_found');
    closeRule(row, b.effective_to);
    try {
      return (await c.query(`UPDATE masters.gst_config SET effective_to = $2 WHERE id = $1 RETURNING ${GST}`, [id, b.effective_to])).rows[0];
    } catch (e) { return overlapOr(e); }
  }

  @Get('tax-rules')
  async taxRules(@Query('component') component?: string, @Query('on') on?: string) {
    const comp = component === undefined ? null : parse(TaxRuleInput.shape.component, component);
    const d = on === undefined ? null : parse(date, on);
    return (await currentTx().query(
      `SELECT ${RULE} FROM masters.tax_rule
        WHERE ($1::text IS NULL OR component = $1)
          AND ($2::date IS NULL OR (effective_from <= $2 AND (effective_to IS NULL OR effective_to > $2)))
        ORDER BY component, coalesce(metal_code, ''), scope DESC, effective_from DESC, id`, [comp, d])).rows;
  }

  @Post('tax-rules') @RequirePermission('platform.settings.edit')
  async createTaxRule(@Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    const b = parse(TaxRuleInput, body);
    startRule(b.effective_from);
    try {
      const r = await currentTx().query(
        `INSERT INTO masters.tax_rule(scope, tenant_id, code, description, component, metal_code, code_type, hsn_sac, rate, cgst_rate,
           sgst_rate, igst_rate, cess_rate, composite_supply, principal_component, reverse_charge, effective_from, effective_to)
         VALUES ('tenant', platform.current_tenant(), $1, $2, $3, $4, $5, $6, $7::numeric, $8::numeric, $9::numeric, $10::numeric,
           $11::numeric, $12, $13, $14, $15, $16) RETURNING ${RULE}`,
        [b.code, b.description ?? null, b.component, b.metal_code ?? null, b.code_type, b.hsn_sac, b.rate, b.cgst_rate, b.sgst_rate,
          b.igst_rate, b.cess_rate ?? '0', b.composite_supply ?? false, b.principal_component ?? null, b.reverse_charge ?? false,
          b.effective_from, b.effective_to ?? null]);
      await markOnboardingStepCompleted('gst_rates');
      reply.status(201);
      return r.rows[0];
    } catch (e) { return overlapOr(e); }
  }

  @Patch('tax-rules/:id') @RequirePermission('platform.settings.edit')
  async closeTaxRule(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parse(Close, body);
    const c = currentTx();
    const row = await lockTenantRule(id);
    closeRule(row, b.effective_to);
    if (row.in_use && row.effective_to !== null && row.effective_to !== b.effective_to)
      fail(422, 'rule_in_use', 'this rule is on issued invoices and already has an end date; it can no longer be changed');
    try {
      const r = await c.query(`UPDATE masters.tax_rule SET effective_to = $2 WHERE id = $1 AND scope = 'tenant' RETURNING ${RULE}`, [id, b.effective_to]);
      return r.rows[0] ?? fail(404, 'not_found');
    } catch (e) { return overlapOr(e); }
  }

  /** 0.4.4: atomic switch-over. Lock old → old.effective_to = new.effective_from (exclusive end: no gap, no overlap) → insert new. */
  @Post('gst-config/:id/replace') @RequirePermission('platform.settings.edit')
  async replaceGstConfig(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) reply: Reply) {
    needKey(key);
    const b = parse(GstConfigReplaceInput, body);
    return withIdempotency(reply, SCOPE_GST, key!, requestHash(id, b), async () => {
    const c = currentTx();
    const old = (await c.query<Row & { company_id: string | null }>(`SELECT ${GST} FROM masters.gst_config WHERE id = $1 FOR UPDATE`, [id])).rows[0]
      ?? fail(404, 'not_found');
    const want = { registration_type: b.registration_type, tax_inclusive: b.tax_inclusive, rounding_level: b.rounding_level,
      round_off_unit: b.round_off_unit, einvoice_enabled: b.einvoice_enabled ?? false, einvoice_from: b.einvoice_from ?? null,
      b2c_qr: b.b2c_qr ?? false, effective_from: b.effective_from, effective_to: b.effective_to ?? null };
    if (replaceRule(old, b.effective_from) === 'replay') {
      const next = (await c.query<Row>(`SELECT ${GST} FROM masters.gst_config WHERE company_id IS NOT DISTINCT FROM $1 AND effective_from = $2`,
        [old.company_id, b.effective_from])).rows[0];
      if (sameAs(next, want)) return { status: 200, body: { replaced: old, created: next } };
      if (next) fail409Replaced();
    }
    try {
      const replaced = old.effective_to === b.effective_from ? old   // already closed at the switch-over date (successor missing): only insert
        : (await c.query(`UPDATE masters.gst_config SET effective_to = $2 WHERE id = $1 RETURNING ${GST}`, [id, b.effective_from])).rows[0];
      const created = (await c.query(
        `INSERT INTO masters.gst_config(tenant_id, company_id, registration_type, tax_inclusive_pricing, rounding_level, round_off_to,
           einvoice_enabled, einvoice_from, b2c_qr_required, effective_from, effective_to)
         VALUES (platform.current_tenant(), $1, $2, $3, $4, $5::numeric, $6, $7, $8, $9, $10) RETURNING ${GST}`,
        [old.company_id, want.registration_type, want.tax_inclusive, want.rounding_level, want.round_off_unit, want.einvoice_enabled,
          want.einvoice_from, want.b2c_qr, want.effective_from, want.effective_to])).rows[0];
      return { status: 201, body: { replaced, created } };
    } catch (e) { return overlapOr(e); }
    });
  }

  @Post('tax-rules/:id/replace') @RequirePermission('platform.settings.edit')
  async replaceTaxRule(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) reply: Reply) {
    needKey(key);
    const b = parse(TaxRuleReplaceInput, body);
    return withIdempotency(reply, SCOPE_TAX, key!, requestHash(id, b), async () => {
    const c = currentTx();
    const old = await lockTenantRule(id);
    const want = { code: b.code, description: b.description ?? null, component: old.component, metal_code: old.metal_code, code_type: b.code_type,
      hsn_sac: b.hsn_sac, composite_supply: b.composite_supply ?? false, principal_component: b.principal_component ?? null,
      reverse_charge: b.reverse_charge ?? false, effective_from: b.effective_from, effective_to: b.effective_to ?? null };
    const rates = { rate: b.rate, cgst_rate: b.cgst_rate, sgst_rate: b.sgst_rate, igst_rate: b.igst_rate, cess_rate: b.cess_rate ?? '0' };
    if (replaceRule(old, b.effective_from) === 'replay') {
      const next = (await c.query<Row>(
        `SELECT ${RULE}, rate = $4::numeric AND cgst_rate = $5::numeric AND sgst_rate = $6::numeric AND igst_rate = $7::numeric AND cess_rate = $8::numeric AS same_rates
           FROM masters.tax_rule WHERE scope = 'tenant' AND component = $1 AND metal_code IS NOT DISTINCT FROM $2 AND effective_from = $3 AND id <> $9
          ORDER BY id LIMIT 1`,
        [old.component, old.metal_code, b.effective_from, rates.rate, rates.cgst_rate, rates.sgst_rate, rates.igst_rate, rates.cess_rate, id])).rows[0];
      if (next && next.same_rates === true && sameAs(next, want)) {
        delete next.same_rates; return { status: 200, body: { replaced: old, created: next } };
      }
      if (next) fail409Replaced();
    } else if (old.in_use && old.effective_to !== null) {
      fail(422, 'rule_in_use', 'this rule is on issued invoices and already has an end date; it can no longer be changed');
    }
    try {
      const replaced = old.effective_to === b.effective_from ? old   // already closed at the switch-over date (successor missing): only insert
        : (await c.query(`UPDATE masters.tax_rule SET effective_to = $2 WHERE id = $1 RETURNING ${RULE}`, [id, b.effective_from])).rows[0];
      const created = (await c.query(
        `INSERT INTO masters.tax_rule(scope, tenant_id, code, description, component, metal_code, code_type, hsn_sac, rate, cgst_rate,
           sgst_rate, igst_rate, cess_rate, composite_supply, principal_component, reverse_charge, effective_from, effective_to)
         VALUES ('tenant', platform.current_tenant(), $1, $2, $3, $4, $5, $6, $7::numeric, $8::numeric, $9::numeric, $10::numeric,
           $11::numeric, $12, $13, $14, $15, $16) RETURNING ${RULE}`,
        [want.code, want.description, want.component, want.metal_code, want.code_type, want.hsn_sac, rates.rate, rates.cgst_rate,
          rates.sgst_rate, rates.igst_rate, rates.cess_rate, want.composite_supply, want.principal_component, want.reverse_charge,
          want.effective_from, want.effective_to])).rows[0];
      return { status: 201, body: { replaced, created } };
    } catch (e) { return overlapOr(e); }
    });
  }
}

export { needKey, requestHash, withIdempotency };
