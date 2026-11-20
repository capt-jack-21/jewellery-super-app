import { describe, it, expect, afterAll } from 'vitest';
import type { PoolClient } from 'pg';
import { pool, T1, B1 } from './env';

/** O0 (migration 01000): orders prerequisites. Regression tests for each change in that file. */
const mig = pool('app_migrator');
afterAll(async () => { await mig.end(); });

/** app_rw cannot write the orders schema (that is orders_writer's job); the owner role in a tenant tx can, and is what these schema tests need. */
async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await mig.connect();
  try {
    await c.query('BEGIN'); await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [T1]);
    const r = await fn(c); await c.query('COMMIT'); return r;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}
const q = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T[]> => (await mig.query(sql, p)).rows as T[];

describe('01000_orders_prerequisites', () => {
  it('version column, bump trigger and audit exist on all four orders tables', async () => {
    for (const t of ['customer_order', 'order_line', 'repair', 'repair_line']) {
      const col = await q(`SELECT 1 FROM information_schema.columns WHERE table_schema='orders' AND table_name=$1 AND column_name='version'`, [t]);
      expect(col.length, `${t}.version`).toBe(1);
      const trg = await q(`SELECT tgname FROM pg_trigger WHERE tgrelid = ('orders.' || $1)::regclass AND NOT tgisinternal`, [t]);
      expect(trg.map((r) => (r as { tgname: string }).tgname), t).toContain('aa_version');
    }
  });

  it('version is bumped by the database and cannot be set by the client', async () => {
    const id = await tx(async (c) => {
      const r = await c.query(`INSERT INTO orders.customer_order(tenant_id, branch_id, order_no) VALUES ($1,$2,$3) RETURNING id`, [T1, B1, `O0-${Date.now()}`]);
      return r.rows[0].id as string;
    });
    const v = (sql: string) => tx(async (c) => (await c.query(sql, [id])).rows[0]?.version as number);
    expect(await v(`SELECT version FROM orders.customer_order WHERE id = $1`)).toBe(1);
    await tx(async (c) => { await c.query(`UPDATE orders.customer_order SET notes='x' WHERE id = $1`, [id]); });
    expect(await v(`SELECT version FROM orders.customer_order WHERE id = $1`)).toBe(2);
    await expect(tx(async (c) => { await c.query(`UPDATE orders.customer_order SET version = 99 WHERE id = $1`, [id]); }))
      .rejects.toThrow(/version is maintained by the database/);
  });

  it('missing foreign keys exist: repair branch, order line item and purity, repair line vendor and tag', async () => {
    const want = ['repair_branch_fk', 'order_line_item_fk', 'order_line_purity_fk', 'repair_line_vendor_fk', 'repair_line_tag_fk'];
    const got = (await q<{ conname: string }>(`SELECT conname FROM pg_constraint WHERE contype='f' AND connamespace = 'orders'::regnamespace`)).map((r) => r.conname);
    for (const w of want) expect(got, w).toContain(w);
  });

  it('a repair in a branch that does not exist is rejected', async () => {
    await expect(tx(async (c) => {
      await c.query(`INSERT INTO orders.repair(tenant_id, branch_id, repair_no, customer_id) VALUES ($1, gen_random_uuid(), 'R-NOBRANCH', gen_random_uuid())`, [T1]);
    })).rejects.toThrow(/foreign key|violates/);
  });

  it('sales.advance has a fine-gram balance guarded like the money balance', async () => {
    const col = await q<{ data_type: string; is_nullable: string; column_default: string }>(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema='sales' AND table_name='advance' AND column_name='balance_fine_g'`);
    expect(col[0]).toMatchObject({ data_type: 'numeric', is_nullable: 'NO' });
    const trg = await q<{ tgname: string }>(`SELECT tgname FROM pg_trigger WHERE tgrelid='sales.advance'::regclass AND NOT tgisinternal`);
    expect(trg.map((t) => t.tgname)).toEqual(expect.arrayContaining(['advance_guard', 'advance_fine_guard']));
    const fn = await q<{ src: string }>(`SELECT prosrc AS src FROM pg_proc WHERE proname='advance_fine_guard' AND pronamespace='sales'::regnamespace`);
    expect(fn[0].src).toContain("current_user <> 'sales_writer'");
  });

  it('orders.* permissions exist; owner and manager hold all, salesperson and cashier hold the front-desk set only', async () => {
    const perms = (await q<{ code: string }>(`SELECT code FROM platform.permission WHERE module='orders' ORDER BY code`)).map((r) => r.code);
    expect(perms).toHaveLength(14);
    expect(perms).toContain('orders.repair.loss_override');
    const of = async (role: string) => (await q<{ permission_code: string }>(`SELECT permission_code FROM platform.system_role_permission WHERE role_code=$1 AND permission_code LIKE 'orders.%' ORDER BY 1`, [role])).map((r) => r.permission_code);
    expect(await of('owner')).toEqual(perms);
    expect(await of('manager')).toEqual(perms);
    const front = ['orders.advance.take', 'orders.order.create', 'orders.order.view', 'orders.repair.create', 'orders.repair.view'];
    expect(await of('salesperson')).toEqual(front);
    expect(await of('cashier')).toEqual(front);
  });
});
