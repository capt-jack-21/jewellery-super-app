import { withModuleRole } from '@jw/db';
import { type OrdersActor, need } from './actor';
import { fail, invalid } from './errors';
import { audit, iso, one } from './db';
import { ORDER_NO_FORMAT, REPAIR_NO_FORMAT, validateDocNoFormat } from './numbering';

/** Orders / repairs settings (O12): one row per shop, no row = the defaults. Written only as orders_writer. */
export interface OrdersSettings {
  order_no_format: string; repair_no_format: string; default_due_days: number | null; repair_loss_tolerance_pct: string; advance_required: boolean; rate_rule: 'locked' | 'lower_of';
  source: 'default' | 'shop'; version: number; updated_at: string | null; updated_by: string | null;
}
export interface OrdersSettingsPatch {
  order_no_format?: string; repair_no_format?: string; default_due_days?: number | null; repair_loss_tolerance_pct?: string; advance_required?: boolean; rate_rule?: 'locked' | 'lower_of';
}
const COLS = `order_no_format, repair_no_format, default_due_days, repair_loss_tolerance_pct::text, advance_required, rate_rule, version, ${iso('updated_at')}, updated_by`;
type Row = Omit<OrdersSettings, 'source'>;
const view = (r: Row | undefined): OrdersSettings => r ? { ...r, source: 'shop' } : {
  order_no_format: ORDER_NO_FORMAT, repair_no_format: REPAIR_NO_FORMAT, default_due_days: null, repair_loss_tolerance_pct: '1.00', advance_required: false, rate_rule: 'locked',
  source: 'default', version: 0, updated_at: null, updated_by: null,
};
/** No permission check: used by the other Orders services. lock = FOR UPDATE (call it inside orders_writer). */
export async function loadSettings(lock = false): Promise<OrdersSettings> {
  return view(await one<Row>(`SELECT ${COLS} FROM orders.shop_setting ${lock ? 'FOR UPDATE' : ''}`));
}
export async function getSettings(a: OrdersActor): Promise<OrdersSettings> {
  need(a, 'orders.order.view');
  return loadSettings();
}
const PCT = /^\d{1,3}(\.\d{1,2})?$/;
/** PATCH (orders.settings.manage). If-Match is required once the shop has a row (428 / 412); the first save needs none. */
export async function patchSettings(a: OrdersActor, p: OrdersSettingsPatch, ifVersion: number | null): Promise<OrdersSettings> {
  need(a, 'orders.settings.manage');
  if (!Object.keys(p).length) invalid('', 'empty patch');
  const errs = [...validateDocNoFormat('order_no_format', p.order_no_format), ...validateDocNoFormat('repair_no_format', p.repair_no_format)];
  if (errs.length) fail(422, 'validation_failed', 'number format', errs.map((e) => ({ ...e, code: 'invalid_format' })));
  if (p.default_due_days != null && (!Number.isInteger(p.default_due_days) || p.default_due_days < 1 || p.default_due_days > 365)) invalid('default_due_days', 'a whole number of days, 1-365, or null for none');
  if (p.repair_loss_tolerance_pct !== undefined && (!PCT.test(p.repair_loss_tolerance_pct) || Number(p.repair_loss_tolerance_pct) > 100)) invalid('repair_loss_tolerance_pct', '0-100 with up to 2 decimals');
  if (p.advance_required !== undefined && typeof p.advance_required !== 'boolean') invalid('advance_required', 'true or false');
  if (p.rate_rule !== undefined && p.rate_rule !== 'locked' && p.rate_rule !== 'lower_of') invalid('rate_rule', "'locked' or 'lower_of'");
  const result = await withModuleRole('orders_writer', async () => {
    const cur = await loadSettings(true);
    if (cur.source === 'shop') {
      if (ifVersion === null) fail(428, 'precondition_required', 'Send If-Match with the settings version');
      if (ifVersion !== cur.version) fail(412, 'version_mismatch', 'settings were changed by someone else');
    }
    const v = [p.order_no_format ?? cur.order_no_format, p.repair_no_format ?? cur.repair_no_format,
      p.default_due_days === undefined ? cur.default_due_days : p.default_due_days, p.repair_loss_tolerance_pct ?? cur.repair_loss_tolerance_pct,
      p.advance_required ?? cur.advance_required, p.rate_rule ?? cur.rate_rule, a.userId];
    return cur.source === 'default'
      ? one<Row>(`INSERT INTO orders.shop_setting(tenant_id, order_no_format, repair_no_format, default_due_days, repair_loss_tolerance_pct, advance_required, rate_rule, updated_by)
          VALUES (platform.current_tenant(), $1, $2, $3, $4::numeric, $5, $6, $7) RETURNING ${COLS}`, v)
      : one<Row>(`UPDATE orders.shop_setting SET order_no_format=$1, repair_no_format=$2, default_due_days=$3, repair_loss_tolerance_pct=$4::numeric, advance_required=$5, rate_rule=$6,
          updated_by=$7, updated_at=now() WHERE tenant_id = platform.current_tenant() RETURNING ${COLS}`, v);
  });
  await audit('orders.settings.updated', 'orders.shop_setting', null, { fields: Object.keys(p) });
  return view(result);
}
