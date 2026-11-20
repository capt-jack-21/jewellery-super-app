import { one, many } from './db';
import { fail, SalesError } from './errors';
import { type SalesActor, needAny, needBranch } from './actor';
import { branchPrefix } from './numbering';
import { loadShop, evenSplit } from './settings';
import { stockPort } from './ports';
import { prepare, judge, publicLine, MAKING_RATE_POINTER } from './bill';
import { parseBill } from './request';
import { nowIso } from './bill';

/** S18 readiness: the same gates issue / preview / estimates enforce, reported without failing. */
export async function readiness(a: SalesActor, branchId: string, day: string): Promise<Record<string, unknown>> {
  needAny(a, ['sales.invoice.view', 'sales.estimate.create']);
  if (!(await one(`SELECT 1 FROM platform.branch WHERE id = $1`, [branchId]))) fail(422, 'unknown_reference', 'branch_id', [{ path: 'branch_id', code: 'unknown_reference', message: 'no such branch' }]);
  needBranch(a, branchId);
  const b = await one<{ missing_steps: string[] }>(`SELECT missing_steps FROM platform.v_billing_unlocked WHERE tenant_id = platform.current_tenant()`);
  const miss = b?.missing_steps ?? [];
  const noRate = await many<{ code: string }>(`SELECT p.code FROM masters.purity p JOIN masters.metal m ON m.tenant_id = p.tenant_id AND m.id = p.metal_id
      WHERE p.is_active AND m.is_active AND NOT EXISTS (SELECT 1 FROM rates.metal_rate r WHERE r.tenant_id = p.tenant_id AND r.purity_id = p.id AND r.kind = 'sale'
        AND r.rate_date = $2::date AND (r.branch_id IS NULL OR r.branch_id = $1) AND r.effective_from <= now()) ORDER BY p.code`, [branchId, day]);
  const series = await branchPrefix(branchId);
  const shop = await loadShop();
  const making = shop.making_gst_treatment === 'composite' || (shop.making_service_rate !== null && evenSplit(shop.making_service_rate));
  const gates = [
    { code: 'device_approved', ok: a.billingEnabled !== false, detail: a.billingEnabled === false ? 'this device is not approved for billing' : null },
    { code: 'todays_rates', ok: noRate.length === 0, detail: noRate.length ? `no sale rate today for ${noRate.map((r) => r.code).join(', ')}` : null },
    { code: 'onboarding_gst', ok: !miss.includes('gst'), detail: miss.includes('gst') ? 'GST registration step not completed' : null },
    { code: 'onboarding_gst_rates', ok: !miss.includes('gst_rates'), detail: miss.includes('gst_rates') ? 'GST rates step not completed' : null },
    { code: 'invoice_series', ok: series.ok, detail: series.ok ? null : 'branch bill series prefix must be 1-4 letters / digits' },
    { code: 'making_service_rate', ok: making, detail: making ? null : 'making is a separate service but making_service_rate is not set (PATCH /v1/sales/settings)' },
  ];
  return { branch_id: branchId, ready: gates.every((g) => g.ok),
    gates: gates.map((g) => ({ ...g, ...(g.code === 'making_service_rate' ? MAKING_RATE_POINTER : { setting_key: null, settings_path: null }) })),
    checked_at: await nowIso() };
}

/** S1 scan: sellable check + the line priced at today's rate (read-only). */
export async function sellable(a: SalesActor, code: string, branchId: string, day: string): Promise<Record<string, unknown>> {
  needAny(a, ['sales.invoice.issue', 'sales.estimate.create']);
  const id = await stockPort().findTag(code);
  if (!id) fail(404, 'not_found', `no tag, HUID or barcode ${code}`);
  const t = (await stockPort().tags([id], false)).get(id)!;
  stockPort().assertSellable(t, branchId);
  const p = await prepare(a, parseBill({ branch_id: branchId, lines: [{ kind: 'tag', tag_id: id }] }, 'estimate'), 'estimate', day);
  try { await judge(a, p, false); } catch (e) { if (!(e instanceof SalesError)) throw e; }
  return { tag_id: id, tag_no: t.tag_no, status: 'in_stock', branch_id: branchId, line: publicLine(p.result.lines[0]), warnings: p.warnings };
}
