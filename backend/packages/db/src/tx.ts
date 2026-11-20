import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool, PoolClient } from 'pg';

export interface RequestScope {
  /** '' = no tenant (partner console / pre-auth host lookup): platform.current_tenant() is NULL, RLS hides tenant rows. */
  tenantId: string;
  userId?: string;
  branchId?: string;
  partnerId?: string;
}
interface TxState { client: PoolClient; scope: RequestScope; role: string | null }

/** Nest DI tokens for the two pools (app_rw for the API; app_admin for the P23 console + pre-auth slug lookup). */
export const PG_POOL = 'PG_POOL';
export const ADMIN_POOL = 'ADMIN_POOL';

const als = new AsyncLocalStorage<TxState>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** NOLOGIN module roles app_rw may SET (900_security: WITH INHERIT FALSE, SET TRUE). */
export type ModuleRole = 'sales_writer' | 'inventory_writer' | 'accounts_writer' | 'orders_writer';
const MODULE_ROLES: ReadonlySet<string> = new Set(['sales_writer', 'inventory_writer', 'accounts_writer', 'orders_writer']);

/**
 * Run fn in ONE transaction with transaction-local tenant settings (set_config(..., true) == SET LOCAL),
 * safe under PgBouncer transaction pooling. Nested calls reuse the outer transaction.
 */
export async function withTenantTx<T>(pool: Pool, scope: RequestScope, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const outer = als.getStore();
  if (outer) {
    if (outer.scope.tenantId !== scope.tenantId) throw new Error('nested tx with a different tenant');
    return fn(outer.client);
  }
  for (const [k, v] of Object.entries(scope)) if (v !== undefined && v !== '' && !UUID.test(v)) throw new Error(`invalid ${k}`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.tenant_id',$1,true), set_config('app.user_id',$2,true),
              set_config('app.branch_id',$3,true), set_config('app.partner_id',$4,true)`,
      [scope.tenantId, scope.userId ?? '', scope.branchId ?? '', scope.partnerId ?? ''],
    );
    const result = await als.run({ client, scope, role: null }, () => fn(client));
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/** After authenticating inside the tx: set app.user_id / app.branch_id (still transaction-local). */
export async function refineScope(patch: { userId?: string; branchId?: string }): Promise<void> {
  const s = als.getStore();
  if (!s) throw new Error('refineScope requires a tenant transaction');
  for (const v of Object.values(patch)) if (v !== undefined && !UUID.test(v)) throw new Error('invalid scope id');
  if (patch.userId) await s.client.query(`SELECT set_config('app.user_id',$1,true)`, [patch.userId]);
  if (patch.branchId) await s.client.query(`SELECT set_config('app.branch_id',$1,true)`, [patch.branchId]);
  s.scope = { ...s.scope, ...patch };
}

/** Run fn inside a SAVEPOINT; rolled back if fn throws or if rollback=true (dry runs). */
export async function withSavepoint<T>(fn: (c: PoolClient) => Promise<T>, rollback = false): Promise<T> {
  const c = currentTx();
  const name = `sp_${Math.random().toString(36).slice(2, 10)}`;
  await c.query(`SAVEPOINT ${name}`);
  try {
    const r = await fn(c);
    await c.query(rollback ? `ROLLBACK TO SAVEPOINT ${name}` : `RELEASE SAVEPOINT ${name}`);
    return r;
  } catch (e) {
    await c.query(`ROLLBACK TO SAVEPOINT ${name}`).catch(() => undefined);
    throw e;
  }
}

/** Runtime guard: data access outside a tenant transaction throws. */
export function currentTx(): PoolClient {
  const s = als.getStore();
  if (!s) throw new Error('no tenant transaction in context (use withTenantTx)');
  return s.client;
}
export function currentScope(): RequestScope {
  const s = als.getStore();
  if (!s) throw new Error('no tenant transaction in context');
  return s.scope;
}

/**
 * SET LOCAL ROLE <module role> for fn, then restore the previous role (RESET → app_rw), all in the same tx.
 * Restricted by packages/tooling/guards.mjs: only the owning module may name its role.
 */
export async function withModuleRole<T>(role: ModuleRole, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const s = als.getStore();
  if (!s) throw new Error('withModuleRole requires a tenant transaction');
  if (!MODULE_ROLES.has(role)) throw new Error(`unknown module role ${role}`);
  const prev = s.role;
  await s.client.query(`SET LOCAL ROLE ${role}`);
  s.role = role;
  try { return await fn(s.client); }
  finally {
    s.role = prev;
    await s.client.query(prev ? `SET LOCAL ROLE ${prev}` : 'RESET ROLE').catch(() => undefined);
  }
}
