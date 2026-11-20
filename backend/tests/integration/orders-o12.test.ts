import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { withTenantTx, currentTx } from '@jw/db';
import * as ord from '@jw/mod-orders';
import { pool, T1, T2 } from './env';

/** O12 settings (service layer) and migration 01002 (shop_setting + repair_type checks). */
const rw = pool('app_rw');
const mig = pool('app_migrator');
afterAll(async () => { await rw.end(); await mig.end(); });

const U1 = '00000000-0000-0000-0000-0000000a1202';   // a user of tenant 2 (settings of tenant 1 stay untouched for the other test files)
const mk = (perms: string[]): ord.OrdersActor => ({ userId: U1, permissions: new Set(perms), roles: [{ role: 'owner', branch_id: null }] });
const MANAGE = mk(['orders.order.view', 'orders.settings.manage']);
const VIEW = mk(['orders.order.view']);
const run = <T>(fn: () => Promise<T>, tenantId = T1): Promise<T> => withTenantTx(rw, { tenantId, userId: U1 }, fn);
const err = (status: number, code: string) => expect.objectContaining({ status, code });

beforeAll(async () => {
  const c = await mig.connect();
  try {
    await c.query('BEGIN'); await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [T2]);
    await c.query(`INSERT INTO platform.app_user(tenant_id, id, name, phone) VALUES (platform.current_tenant(), $1, 'O12 test user', '9000001202') ON CONFLICT DO NOTHING`, [U1]);
    await c.query('COMMIT');
  } finally { c.release(); }
});

describe('orders settings', () => {
  it('a shop with no row gets the defaults; the first save inserts, later saves need the version', async () => {
    expect(await run(() => ord.getSettings(VIEW), T2)).toMatchObject({ source: 'default', version: 0, default_due_days: null, repair_loss_tolerance_pct: '1.00', advance_required: false, rate_rule: 'locked',
      order_no_format: 'ORD-{BRANCH}-{FY}-{SEQ:5}', repair_no_format: 'REP-{BRANCH}-{FY}-{SEQ:5}' });
    const a = await run(() => ord.patchSettings(MANAGE, { advance_required: true, default_due_days: 7 }, null), T2);
    expect(a).toMatchObject({ source: 'shop', version: 1, advance_required: true, default_due_days: 7, updated_by: U1 });
    await expect(run(() => ord.patchSettings(MANAGE, { advance_required: false }, null), T2)).rejects.toEqual(err(428, 'precondition_required'));
    await expect(run(() => ord.patchSettings(MANAGE, { advance_required: false }, 5), T2)).rejects.toEqual(err(412, 'version_mismatch'));
    const b = await run(() => ord.patchSettings(MANAGE, { default_due_days: null }, 1), T2);
    expect(b).toMatchObject({ version: 2, default_due_days: null, advance_required: true, rate_rule: 'locked' });
    expect(await run(() => ord.patchSettings(MANAGE, { rate_rule: 'lower_of' }, 2), T2)).toMatchObject({ version: 3, rate_rule: 'lower_of', advance_required: true });
  });
  it('needs the permission; rejects bad formats and values', async () => {
    await expect(run(() => ord.patchSettings(VIEW, { advance_required: true }, null), T2)).rejects.toEqual(err(403, 'forbidden'));
    await expect(run(() => ord.getSettings(mk([])), T2)).rejects.toEqual(err(403, 'forbidden'));
    for (const p of [{ order_no_format: 'X' }, { order_no_format: '{SEQ:5}-{SEQ:5}' }, { order_no_format: '{SEQ:5}-A' }, { order_no_format: 'A-{FOO}-{SEQ:5}' },
      { repair_no_format: 'A B-{SEQ:5}' }, { order_no_format: 'A'.repeat(70) + '{SEQ:5}' }]) {
      await expect(run(() => ord.patchSettings(MANAGE, p, 2), T2), JSON.stringify(p)).rejects.toEqual(err(422, 'validation_failed'));
    }
    for (const p of [{ default_due_days: 0 }, { default_due_days: 400 }, { default_due_days: 1.5 }, { repair_loss_tolerance_pct: '101' }, { repair_loss_tolerance_pct: '1.234' },
      { repair_loss_tolerance_pct: 'x' }, { rate_rule: 'highest' as 'locked' }, {}]) {
      await expect(run(() => ord.patchSettings(MANAGE, p as ord.OrdersSettingsPatch, 2), T2), JSON.stringify(p)).rejects.toEqual(err(422, 'validation_failed'));
    }
  });
  it('is isolated per shop and written by orders_writer only', async () => {
    await expect(run(async () => { await currentTx().query(`INSERT INTO orders.shop_setting(tenant_id) VALUES (platform.current_tenant())`); }, T1)).rejects.toThrow(/permission denied/);
  });
});

describe('migration 01002', () => {
  it('shop_setting is one row per shop and has tenant isolation; repair_type has version, is_active and range checks', async () => {
    const c = await mig.connect();
    try {
      await c.query('BEGIN'); await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [T1]);
      const cols = (await c.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'masters' AND table_name = 'repair_type'`)).rows.map((r) => r.column_name);
      expect(cols).toEqual(expect.arrayContaining(['version', 'is_active']));
      await c.query(`INSERT INTO masters.repair_type(tenant_id, name, min_customer_charge, max_customer_charge) VALUES (platform.current_tenant(), 'O13-ok-${Date.now()}', 10, 20)`);
      await c.query('SAVEPOINT s');
      await expect(c.query(`INSERT INTO masters.repair_type(tenant_id, name, min_customer_charge, max_customer_charge) VALUES (platform.current_tenant(), 'O13-bad-${Date.now()}', 30, 20)`))
        .rejects.toThrow(/repair_type_customer_range/);
      await c.query('ROLLBACK TO SAVEPOINT s');
      await c.query(`INSERT INTO orders.shop_setting(tenant_id) VALUES (platform.current_tenant()) ON CONFLICT DO NOTHING`);
      await c.query('SAVEPOINT s2');
      await expect(c.query(`INSERT INTO orders.shop_setting(tenant_id) VALUES (platform.current_tenant())`)).rejects.toThrow(/shop_setting_one_per_shop/);
      await c.query('ROLLBACK TO SAVEPOINT s2');
      const rls = (await c.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'orders.shop_setting'::regclass`)).rows[0];
      expect(rls).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      const perms = (await c.query(`SELECT role_code, permission_code FROM platform.system_role_permission WHERE permission_code LIKE 'masters.repair_types.%' ORDER BY 1, 2`)).rows;
      expect(perms.map((r) => `${r.role_code}:${r.permission_code}`)).toEqual([
        'cashier:masters.repair_types.view', 'manager:masters.repair_types.manage', 'manager:masters.repair_types.view',
        'owner:masters.repair_types.manage', 'owner:masters.repair_types.view', 'salesperson:masters.repair_types.view']);
    } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
  });
});
