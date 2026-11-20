import { createHash } from 'node:crypto';
import { currentTx, withSavepoint } from '@jw/db';
import { fail } from './common';

type Reply = { status(n: number): unknown };
export function needKey(key?: string): void {
  // N17 / QA IDEM-3: absence is a400, format errors remain422 and are distinct from changed-payload reuse.
  if (!key) return fail(400, 'idempotency_key_required', 'Idempotency-Key header is required');
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) fail(422, 'idempotency_key_invalid', 'Idempotency-Key must contain16-128 chars [A-Za-z0-9_-]');
}
/**
 * Idempotency-Key store (migration 973: platform.idempotency_key, PK (tenant_id, scope, key); app_rw has SELECT + INSERT only).
 * Runs on the request's tenant transaction as app_rw (no module role) under RLS tenant_isolation.
 *  1. Look up (scope, key). Live row: same request_hash → replay its stored status + body; different → 422 idempotency_key_reused.
 *  2. Otherwise run the business write and INSERT the key row (final status + body) inside ONE savepoint. If a concurrent request
 *     with the same key committed first, the INSERT raises 23505: the savepoint rolls back our write (so the tx stays usable and no
 *     double write survives) and we answer from the winner's stored row (replay or 422).
 *  Expired rows (expires_at <= now()) count as absent: delete them first in the same tx (973 grants app_rw DELETE, limited by policy
 *  rw_delete_expired_only + tenant_isolation, so a live or foreign row is deleted 0 times without error), then store normally.
 */
type Stored = { request_hash: string; response_status: number; response_body: unknown; expired: boolean };
type Outcome = { status: number; body: unknown };
const findKey = async (scope: string, key: string): Promise<Stored | undefined> => (await currentTx().query<Stored>(
  `SELECT request_hash, response_status, response_body, expires_at <= now() AS expired FROM platform.idempotency_key WHERE scope = $1 AND key = $2`,
  [scope, key])).rows[0];
function answer(stored: Stored, hash: string): Outcome {
  if (stored.request_hash !== hash) fail(422, 'idempotency_key_reused', 'this Idempotency-Key was already used with a different request');
  return { status: stored.response_status, body: stored.response_body };
}
export async function withIdempotency(reply: Reply, scope: string, key: string, hash: string, run: () => Promise<Outcome>): Promise<unknown> {
  const done = (o: Outcome) => { reply.status(o.status); return o.body; };
  const prior = await findKey(scope, key);
  if (prior && !prior.expired) return done(answer(prior, hash));
  if (prior) {
    await currentTx().query(`DELETE FROM platform.idempotency_key WHERE scope = $1 AND key = $2 AND expires_at <= now()`, [scope, key]);
  }
  try {
    return done(await withSavepoint(async (c) => {
      const o = await run();
      {
        await c.query(`INSERT INTO platform.idempotency_key(tenant_id, scope, key, request_hash, response_status, response_body)
                       VALUES (platform.current_tenant(), $1, $2, $3, $4, $5::jsonb)`, [scope, key, hash, o.status, JSON.stringify(o.body)]);
      }
      return o;
    }));
  } catch (e) {
    if ((e as { code?: string }).code !== '23505') throw e;
    const winner = await findKey(scope, key);
    if (!winner) throw e;
    return done(answer(winner, hash));
  }
}
/** sha256 hex of the path id + canonical (key-sorted) parsed body. */
export function requestHash(id: string, body: Record<string, unknown>): string {
  const canon = JSON.stringify(Object.keys(body).sort().map((k) => [k, body[k] ?? null]));
  return createHash('sha256').update(`${id}|${canon}`).digest('hex');
}
