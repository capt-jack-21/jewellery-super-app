import { currentTx } from '@jw/db';
import { fail } from './common';

export const FIXED_ROLES = [
  { code: 'owner', name: 'Owner' }, { code: 'manager', name: 'Manager' },
  { code: 'salesperson', name: 'Salesperson' }, { code: 'cashier', name: 'Cashier' },
] as const;

/** Every tenant has exactly the four fixed roles (P5/P7). Idempotent; there is no API to create other roles (P6 deferred). */
export async function ensureFixedRoles(): Promise<void> {
  const c = currentTx();
  for (const r of FIXED_ROLES) {
    await c.query(
      `INSERT INTO platform.role(tenant_id, name, system_role_code) SELECT platform.current_tenant(), $1, $2
        WHERE NOT EXISTS (SELECT 1 FROM platform.role WHERE system_role_code = $2)
       ON CONFLICT DO NOTHING`, [r.name, r.code]);
  }
}

export const USER_COLS = `u.id, u.version, u.name, u.username, u.phone, u.email, u.default_branch_id, u.language, u.is_active,
  (SELECT max(b.locked_until) FROM platform.rate_limit_bucket b WHERE b.locked_until > now() AND b.bucket_key = ANY(ARRAY[
     'login.tenant:' || u.tenant_id || ':' || encode(sha256(convert_to(lower(u.username), 'UTF8')), 'hex'),
     'login.tenant:' || u.tenant_id || ':' || encode(sha256(convert_to(lower(u.phone), 'UTF8')), 'hex')])) AS locked_until,
  u.created_at,
  coalesce((SELECT json_agg(json_build_object('role', r.system_role_code, 'branch_id', ur.branch_id) ORDER BY r.system_role_code)
              FROM platform.user_role ur JOIN platform.role r ON r.tenant_id = ur.tenant_id AND r.id = ur.role_id
             WHERE ur.user_id = u.id), '[]') AS roles`;

export async function getUser(id: string): Promise<Record<string, unknown>> {
  const r = await currentTx().query(`SELECT ${USER_COLS} FROM platform.app_user u WHERE u.id = $1`, [id]);
  return r.rows[0] ?? fail(404, 'not_found');
}

/** Replace role assignments. Only an owner may grant or remove the owner role; the last active owner can't be removed. */
export async function setRoles(userId: string, roles: { role: string; branch_id?: string | null }[], actorIsOwner: boolean): Promise<void> {
  const c = currentTx();
  await ensureFixedRoles();
  const before = await c.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM platform.user_role ur JOIN platform.role r ON r.tenant_id = ur.tenant_id AND r.id = ur.role_id
      WHERE ur.user_id = $1 AND r.system_role_code = 'owner'`, [userId]);
  const touchesOwner = before.rows[0].n > 0 || roles.some((r) => r.role === 'owner');
  if (touchesOwner && !actorIsOwner) fail(403, 'owner_role_requires_owner');
  await c.query(`DELETE FROM platform.user_role WHERE user_id = $1`, [userId]);
  const seen = new Set<string>();
  for (const r of roles) {
    const k = `${r.role}:${r.branch_id ?? ''}`;
    if (seen.has(k)) continue; seen.add(k);
    await c.query(
      `INSERT INTO platform.user_role(tenant_id, user_id, role_id, branch_id)
       SELECT platform.current_tenant(), $1, id, $3 FROM platform.role WHERE system_role_code = $2`, [userId, r.role, r.branch_id ?? null]);
  }
  await assertOwnerRemains();
}

export async function assertOwnerRemains(): Promise<void> {
  const r = await currentTx().query<{ n: number }>(
    `SELECT count(DISTINCT u.id)::int AS n FROM platform.app_user u
       JOIN platform.user_role ur ON ur.tenant_id = u.tenant_id AND ur.user_id = u.id
       JOIN platform.role r ON r.tenant_id = ur.tenant_id AND r.id = ur.role_id
      WHERE u.is_active AND r.system_role_code = 'owner' AND ur.branch_id IS NULL`);
  if (r.rows[0].n < 1) fail(409, 'last_owner', 'The shop must keep at least one active owner (all branches)');
}

/** Plan limit (billing.plan.max_users / max_branches) when the tenant has a live subscription with a limit. */
export async function assertPlanLimit(kind: 'users' | 'branches'): Promise<void> {
  const c = currentTx();
  const col = kind === 'users' ? 'max_users' : 'max_branches';
  const lim = await c.query<{ lim: number | null }>(
    `SELECT p.${col} AS lim FROM billing.subscription s JOIN billing.plan p ON p.code = s.plan_code
      WHERE s.status IN ('trial','active','past_due','grace') ORDER BY s.current_period_end DESC LIMIT 1`);
  const max = lim.rows[0]?.lim;
  if (max == null) return;
  const n = await c.query<{ n: number }>(kind === 'users'
    ? `SELECT count(*)::int AS n FROM platform.app_user WHERE is_active` : `SELECT count(*)::int AS n FROM platform.branch WHERE is_active`);
  if (n.rows[0].n >= max) fail(409, 'plan_limit_reached', `${kind} limit ${max}`);
}
