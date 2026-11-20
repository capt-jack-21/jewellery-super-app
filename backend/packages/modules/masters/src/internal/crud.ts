import { currentTx } from '@jw/db';
import { type AuthContext, Problem, fail, pgProblem, staleOr404 } from '@jw/mod-platform';
import type { ZodTypeAny } from 'zod';

/**
 * 0.7.0 generic master CRUD over raw SQL (976–982 tables; the generated Drizzle schema lags these migrations).
 * Conventions: no DELETE (PATCH is_active=false), If-Match/version on PATCH (aa_version trigger bumps it),
 * keyset paging {items, next_cursor}, q = case-insensitive contains on the spec's search columns,
 * referenced masters must exist and be active (422 unknown_reference / inactive_master).
 */
export type Cast = 'uuid' | 'text' | 'numeric' | 'int' | 'bool' | 'date' | 'jsonb' | 'text[]' | 'bytea' | 'timestamptz';
export type Row = Record<string, unknown>;
export interface Ref { table: string; active?: boolean; where?: string }
export interface WriteCtx { auth: AuthContext; existing?: Row }
export interface Spec {
  /** URL segment under /v1/masters (and the name used in docs) */
  name: string;
  table: string;
  /** masters.<area>.manage gates writes, masters.<area>.view gates reads */
  area: string | ((row: Row) => string);
  /** SELECT list (may alias, e.g. `sale_rate_per_ct::text AS sale_rate`) */
  cols: string;
  /** writable DB columns → cast */
  fields: Record<string, Cast>;
  create: ZodTypeAny;
  patch: ZodTypeAny;
  search: string[];
  filters?: Record<string, { sql: string; cast: Cast }>;
  /** keyset sort expression (text); id breaks ties */
  sort: string;
  /** API field (after toDb) → referenced table */
  refs?: Record<string, Ref>;
  /** API body → DB column values (encrypt, rename, derive); default = identity */
  toDb?(b: Row, ctx: WriteCtx): Row;
  /** cross-field checks on the merged (existing ∪ change) DB row; throw Problem */
  validate?(merged: Row, ctx: WriteCtx): Promise<void>;
  /** after INSERT/UPDATE in the same tx (e.g. secret side tables) */
  afterWrite?(row: Row, body: Row, ctx: WriteCtx): Promise<void>;
  /** decorate a row for output (e.g. design photos) */
  expand?(row: Row): Promise<Row>;
  /** fields that may not change after create */
  immutable?: string[];
}

export const areaOf = (s: Spec, row: Row): string => (typeof s.area === 'function' ? s.area(row) : s.area);
export function need(auth: AuthContext | undefined, perm: string): AuthContext {
  if (!auth) fail(401, 'unauthenticated');
  if (!auth!.permissions.has(perm)) fail(403, 'permission_denied', perm);
  return auth!;
}

const enc = (v: unknown, c: Cast) => (v === null || v === undefined ? null : c === 'jsonb' ? JSON.stringify(v) : v);
export const like = (q?: string) => (q && q.trim() ? `%${q.trim().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%` : null);
export const cursorOf = (s: string, id: string) => Buffer.from(JSON.stringify([s, id]), 'utf8').toString('base64url');
function parseCursor(c: string): [string, string] {
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string' && /^[0-9a-f-]{36}$/i.test(v[1])) return [v[0], v[1]];
  } catch { /* fall through */ }
  return fail(422, 'invalid_cursor');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** display label per referenced table (list rows get `labels: {<ref field>: {code?, name}}`, one batched query per ref) */
const LABEL: Record<string, string> = {
  'masters.metal': 'code, name', 'masters.purity': 'code, code AS name', 'masters.item': 'code, name', 'masters.sub_item': 'code, name',
  'masters.counter': 'code, name', 'masters.floor': 'code, name', 'masters.vendor': 'code, name', 'masters.customer': 'NULL::text AS code, name',
  'hr.staff': 'code, name', 'platform.branch': 'code, name', 'masters.stone_standard': 'code, name', 'masters.customer_group': 'NULL::text AS code, name',
};
async function addLabels(s: Spec, items: Row[]): Promise<void> {
  if (!items.length) return;
  for (const it of items) it.labels = {};
  for (const [field, ref] of Object.entries(s.refs ?? {})) {
    const lc = LABEL[ref.table];
    const ids = [...new Set(items.map((r) => r[field]).filter((v): v is string => typeof v === 'string'))];
    if (!lc || !ids.length) continue;
    const rows = (await currentTx().query<{ id: string; code: string | null; name: string }>(`SELECT id, ${lc} FROM ${ref.table} WHERE id = ANY($1::uuid[])`, [ids])).rows;
    const by = new Map(rows.map((r) => [r.id, { code: r.code, name: r.name }]));
    for (const it of items) { const v = it[field]; if (typeof v === 'string' && by.has(v)) (it.labels as Row)[field] = by.get(v); }
  }
}

export interface ListQuery { ids?: string; q?: string; include_inactive?: string; limit?: string; cursor?: string; [k: string]: string | undefined }
export async function list(s: Spec, query: ListQuery): Promise<{ items: Row[]; next_cursor: string | null }> {
  const args: unknown[] = []; const where: string[] = [];
  const arg = (v: unknown, c: Cast) => { args.push(v); return `$${args.length}::${c}`; };
  if (query.include_inactive !== undefined && !['true', 'false'].includes(query.include_inactive)) fail(422, 'validation_failed', 'include_inactive');
  if (query.include_inactive !== 'true') where.push('is_active');
  if (query.q !== undefined) {
    if (query.q.length > 100) fail(422, 'validation_failed', 'q: max 100 characters');
    if (!s.search.length) fail(422, 'validation_failed', `q is not supported on ${s.name}`);
    const p = like(query.q);
    if (p) { const a = arg(p, 'text'); where.push(`(${s.search.map((c) => `${c}::text ILIKE ${a}`).join(' OR ')})`); }
  }
  for (const [k, f] of Object.entries(s.filters ?? {})) {
    const v = query[k];
    if (v === undefined || v === '') continue;
    if (f.cast === 'uuid' && !UUID.test(v)) fail(422, 'validation_failed', k);
    if (f.cast === 'bool' && !['true', 'false'].includes(v)) fail(422, 'validation_failed', k);
    if (f.cast === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) fail(422, 'validation_failed', k);
    if (v.length > 100) fail(422, 'validation_failed', k);
    const a = arg(v, f.cast);
    where.push(f.sql.replace(/\?/g, () => a));
  }
  if (query.ids !== undefined) {   // 0.7.1 batch lookup: ?ids=a,b,c (max 100), still subject to include_inactive + RLS
    const raw: unknown = query.ids;   // ?ids=a,b (style form, explode false) and ?ids=a&ids=b (repeated) both accepted
    const ids = (Array.isArray(raw) ? raw.join(',') : String(raw)).split(',').map((x) => x.trim()).filter(Boolean);
    if (!ids.length || ids.length > 100 || ids.some((x) => !UUID.test(x))) fail(422, 'validation_failed', 'ids: 1–100 comma-separated uuids');
    where.push(`id = ANY(${arg([...new Set(ids)], 'uuid[]' as Cast)})`);
  }
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) fail(422, 'validation_failed', 'limit: 1–200');
  const sortExpr = `coalesce((${s.sort})::text, '')`;
  if (query.cursor) {
    const [sv, id] = parseCursor(query.cursor);
    where.push(`(${sortExpr}, id) > (${arg(sv, 'text')}, ${arg(id, 'uuid')})`);
  }
  const sql = `SELECT ${s.cols}, ${sortExpr} AS "__sort" FROM ${s.table} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                ORDER BY ${sortExpr}, id LIMIT ${limit + 1}`;
  const rows = (await currentTx().query<Row>(sql, args)).rows;
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const items = page.map(({ __sort: _s, ...r }) => r);   // expand() is for single reads only (no N+1 on pages)
  await addLabels(s, items);
  return { items, next_cursor: more && last ? cursorOf(String(last.__sort), String(last.id)) : null };
}

export async function getRow(s: Spec, id: string): Promise<Row | undefined> {
  return (await currentTx().query<Row>(`SELECT ${s.cols} FROM ${s.table} WHERE id = $1`, [id])).rows[0];
}
export async function getOne(s: Spec, id: string): Promise<Row> {
  const r = (await getRow(s, id)) ?? fail(404, 'not_found');
  return s.expand ? s.expand(r) : r;
}

/** Referenced rows must exist in this shop (RLS) and be active. */
export async function checkRefs(s: Spec, db: Row, changed: string[]): Promise<void> {
  for (const [field, ref] of Object.entries(s.refs ?? {})) {
    if (!changed.includes(field) || db[field] === null || db[field] === undefined) continue;
    const r = (await currentTx().query<{ a: boolean }>(
      `SELECT ${ref.active === false ? 'true' : 'is_active'} AS a FROM ${ref.table} WHERE id = $1 ${ref.where ? `AND ${ref.where}` : ''}`, [db[field]])).rows[0];
    if (!r) throw new Problem(422, 'unknown_reference', `${field}: not found`, [{ path: field, message: 'not found' }]);
    if (!r.a) throw new Problem(422, 'inactive_master', `${field}: the referenced master is inactive`, [{ path: field, message: 'inactive' }]);
  }
}

function dbErr(e: unknown): never {
  if ((e as { code?: string }).code === '23505') fail(409, 'duplicate_code', (e as { constraint?: string }).constraint ?? 'already exists');
  return pgProblem(e);
}

export async function insert(s: Spec, body: Row, ctx: WriteCtx): Promise<Row> {
  const db = s.toDb ? s.toDb(body, ctx) : body;
  const cols = Object.keys(db).filter((k) => k in s.fields && db[k] !== undefined);
  await checkRefs(s, db, cols);
  if (s.validate) await s.validate(db, ctx);
  const c = currentTx();
  try {
    await c.query('SAVEPOINT crud');
    const r = (await c.query<Row>(
      `INSERT INTO ${s.table}(tenant_id${cols.map((k) => `, ${k}`).join('')})
       VALUES (platform.current_tenant()${cols.map((k, i) => `, $${i + 1}::${s.fields[k]}`).join('')}) RETURNING ${s.cols}`,
      cols.map((k) => enc(db[k], s.fields[k])))).rows[0];
    if (s.afterWrite) await s.afterWrite(r, body, ctx);
    await c.query('RELEASE SAVEPOINT crud');
    return s.expand ? s.expand(r) : r;
  } catch (e) { await c.query('ROLLBACK TO SAVEPOINT crud').catch(() => undefined); return dbErr(e); }
}

export async function update(s: Spec, id: string, version: number, body: Row, auth: AuthContext): Promise<Row> {
  const existing = (await getRow(s, id)) ?? fail(404, 'not_found');
  const ctx: WriteCtx = { auth, existing };
  for (const k of s.immutable ?? []) if (k in body) fail(422, 'validation_failed', `${k} cannot be changed`);
  const db = s.toDb ? s.toDb(body, ctx) : body;
  const cols = Object.keys(db).filter((k) => k in s.fields && db[k] !== undefined);
  await checkRefs(s, db, cols);
  if (s.validate) await s.validate({ ...existing, ...db }, ctx);
  const c = currentTx();
  let r: Row | undefined;
  try {
    await c.query('SAVEPOINT crud');
    r = cols.length || 'is_active' in db
      ? (await c.query<Row>(`UPDATE ${s.table} SET ${cols.map((k, i) => `${k} = $${i + 3}::${s.fields[k]}`).join(', ') || 'is_active = is_active'}
           WHERE id = $1 AND version = $2 RETURNING ${s.cols}`, [id, version, ...cols.map((k) => enc(db[k], s.fields[k]))])).rows[0]
      : (await c.query<Row>(`UPDATE ${s.table} SET version = version WHERE id = $1 AND version = $2 RETURNING ${s.cols}`, [id, version])).rows[0];
    if (r && s.afterWrite) await s.afterWrite(r, body, ctx);
    await c.query('RELEASE SAVEPOINT crud');
  } catch (e) { await c.query('ROLLBACK TO SAVEPOINT crud').catch(() => undefined); return dbErr(e); }
  if (!r) return staleOr404(async () => ((await c.query(`SELECT 1 FROM ${s.table} WHERE id = $1`, [id])).rowCount ?? 0) > 0);
  return s.expand ? s.expand(r) : r;
}
