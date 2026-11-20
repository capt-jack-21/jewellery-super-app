import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { HttpException, SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import type { ZodTypeAny, output } from 'zod';

// ---------- errors (RFC 9457 body; the api's filter sets application/problem+json) ----------
const TITLES: Record<number, string> = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 412: 'Precondition Failed', 428: 'Precondition Required',
  413: 'Payload Too Large', 422: 'Unprocessable Content', 429: 'Too Many Requests', 503: 'Service Unavailable' };
export class Problem extends HttpException {
  constructor(status: number, code: string, detail?: string, errors?: { path: string; message: string }[], extra?: Record<string, unknown>) {
    super({ type: 'about:blank', title: TITLES[status] ?? 'Error', status, code, detail, errors, ...(extra ?? {}) }, status);
  }
}
/** 429 problem (code rate_limited) carrying Retry-After seconds; the filter sets the header. */
export class RateLimited extends Problem {
  constructor(readonly retryAfter: number, detail?: string) { super(429, 'rate_limited', detail); }
}
/** v1.9: language codes must exist in platform.language (FK); pre-checked so the tx isn't aborted. */
export async function assertLanguage(c: { query(sql: string, a?: unknown[]): Promise<{ rowCount: number | null }> }, code: string | null | undefined): Promise<void> {
  if (code == null) return;
  if (!(await c.query(`SELECT 1 FROM platform.language WHERE code = $1`, [code])).rowCount) throw new Problem(422, 'unknown_language', `unknown language: ${code}`);
}
export const fail = (status: number, code: string, detail?: string): never => { throw new Problem(status, code, detail); };

/** Validate a body with zod; unknown fields are rejected by the schemas (.strict()). */
export function parse<S extends ZodTypeAny>(schema: S, body: unknown): output<S> {
  const r = schema.safeParse(body ?? {});
  if (!r.success) {
    throw new Problem(422, 'validation_failed', 'Request body is invalid',
      r.error.issues.map((i) => ({ path: i.path.join('.') || '(body)', message: i.message })));
  }
  return r.data;
}

/** Map well-known Postgres errors to problems (unique → 409, check/fk/trigger → 422). */
export function pgProblem(e: unknown): never {
  const err = e as { code?: string; message?: string; constraint?: string };
  if (err instanceof HttpException) throw err;
  if (err.code === '23514' && /invalid bill series prefix/i.test(err.message ?? '')) throw new Problem(422, 'invalid_bill_series_prefix', err.message);
  if (err.code === '23503' && /language_fk|locale_fk/.test(err.constraint ?? '')) throw new Problem(422, 'unknown_language', 'not in platform.language');
  if (err.code === '23505') throw new Problem(409, 'already_exists', err.constraint ?? 'duplicate');
  if (err.code === '23P01') throw new Problem(409, 'overlapping_period', err.constraint ?? 'overlap');
  if (err.code === '23514' || err.code === '23503' || err.code === '23502' || err.code === '22P02' || err.code === 'P0001')
    throw new Problem(422, 'constraint_violation', err.message);
  throw e;
}

// ---------- crypto ----------
export const sha256 = (s: string | Buffer): Buffer => createHash('sha256').update(s).digest();
export const newToken = (): string => randomBytes(32).toString('base64url');
export const otpCode = (): string => String(randomInt(0, 1_000_000)).padStart(6, '0');
export const hashPassword = (p: string): Promise<string> => argonHash(p, { algorithm: 2 /* argon2id */, memoryCost: 19456, timeCost: 2 });
export async function verifyPassword(hash: string | null, p: string): Promise<boolean> {
  if (!hash) { await argonHash(p).catch(() => undefined); return false; }   // equalise timing
  try { return await argonVerify(hash, p); } catch { return false; }
}
function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) {
    if (process.env.NODE_ENV === 'production') throw new Error('SESSION_SECRET (>=32 chars) is required');
    return 'dev-only-session-secret-change-me-0123456789';
  }
  return s;
}
/** otp_challenge.code_hash = HMAC-SHA256(secret, "<challengeId>:<code>") — exactly 32 bytes (v1.4 check). */
export const otpHash = (challengeId: string, code: string): Buffer => createHmac('sha256', secret()).update(`${challengeId}:${code}`).digest();
export const hmac = (data: string): string => createHmac('sha256', secret()).update(data).digest('base64url');
export function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// ---------- auth context ----------
export type AuthKind = 'session' | 'public' | 'partner' | 'admin' | 'optional';
export const AUTH_KIND = 'jw.authKind';
export const PERMISSION = 'jw.permission';
export const Auth = (k: AuthKind) => SetMetadata(AUTH_KIND, k);
/** Require a permission code from platform.permission (resolved from the user's fixed roles). */
export const RequirePermission = (code: string) => SetMetadata(PERMISSION, code);

export interface AuthContext {
  sessionId: string; tenantId: string; userId: string; authMethod: 'password' | 'otp';
  deviceId: string | null; billingEnabled: boolean; permissions: Set<string>; roles: { role: string; branch_id: string | null }[];
  idleTimeoutMinutes: number; expiresAt: string; tenantStatus: string;
}
export interface PartnerContext { partnerId: string; userId?: string; sessionId?: string; role?: 'partner_admin' | 'partner_staff' }
export interface AdminContext { adminId: string; email: string; sessionId?: string }
export interface JwRequest {
  headers: Record<string, string | string[] | undefined>; ip: string; method: string; url: string; hostname?: string;
  cookies?: Record<string, string | undefined>; body?: unknown;
  auth?: AuthContext; partner?: PartnerContext; admin?: AdminContext;
}
export const Ctx = createParamDecorator((_d: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<JwRequest>());

// ---------- optimistic concurrency (v1.4 version columns) ----------
/** Parse If-Match ("3", W/"3"). required=true → 428 when missing. Returns null when absent and not required. */
export function ifMatch(req: JwRequest, required = true): number | null {
  const raw = req.headers['if-match'];
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v) { if (required) throw new Problem(428, 'precondition_required', 'Send If-Match with the resource version'); return null; }
  const m = /^(?:W\/)?"(\d+)"$/.exec(v.trim());
  if (!m) throw new Problem(412, 'version_mismatch', 'If-Match must be a quoted version, e.g. "3"');
  return Number(m[1]);
}
export const etag = (version: number | string): string => `"${version}"`;
/** After `UPDATE … WHERE id=$1 AND version=$v RETURNING …` returned no row: 404 if the row is gone, else 412. */
export async function staleOr404(exists: () => Promise<boolean>): Promise<never> {
  if (await exists()) throw new Problem(412, 'version_mismatch', 'The resource was changed by someone else; reload and retry');
  throw new Problem(404, 'not_found');
}

export const SESSION_COOKIE = 'sid';
export const PARTNER_COOKIE = 'psid';
export const PARTNER_HOURS = 12;
export const PARTNER_IDLE_MINUTES = 30;
export const ADMIN_COOKIE = 'admin_sid';
export const SESSION_ABSOLUTE_HOURS = 12;
export const cookieOpts = (path = '/') => ({ httpOnly: true, secure: process.env.COOKIE_INSECURE !== '1', sameSite: 'lax' as const, path });

export function hostOf(req: JwRequest): string {
  const h = req.headers['x-forwarded-host'] && process.env.TRUST_PROXY === '1' ? req.headers['x-forwarded-host'] : req.headers.host;
  return String(Array.isArray(h) ? h[0] : h ?? '').split(':')[0].toLowerCase();
}

/** Small in-memory per-IP limiter (per process) — defense-in-depth only; the authoritative limits are DB-backed (v1.4). */
const hits = new Map<string, number[]>();
export function rateLimit(key: string, max: number, windowMs: number): void {
  const now = Date.now();
  const arr = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= max) throw new RateLimited(Math.max(1, Math.ceil((arr[0] + windowMs - now) / 1000)));
  arr.push(now); hits.set(key, arr);
  if (hits.size > 50_000) hits.clear();
}
export const todayIST = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

// ---------- DB-backed login lockout / rate limits (v1.5: platform.rate_limit_bucket) ----------
/** Bucket keys are '<surface>:<scope uuid | ->:<sha256 hex | uuid>' — never a raw phone, username or email. */
export type BucketSurface = 'login.tenant' | 'login.partner' | 'login.admin' | 'otp.send' | 'otp.verify';
export const bucketKey = (surface: BucketSurface, scope: string | null, identifier: string): string =>
  `${surface}:${scope ?? '-'}:${sha256(identifier.trim().toLowerCase()).toString('hex')}`;
interface Q { query<R extends Record<string, any> = any>(sql: string, args?: unknown[]): Promise<{ rows: R[] }> }
/** True while any window of the key carries an active lock. */
export async function bucketLocked(c: Q, key: string): Promise<boolean> {
  const r = await c.query<{ l: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM platform.rate_limit_bucket WHERE bucket_key = $1 AND locked_until > now()) AS l`, [key]);
  return !!r.rows[0]?.l;
}
/** Count one event in the current fixed window; locks the key for lockMinutes once `max` is reached. Returns the new count. */
export async function bucketHit(c: Q, key: string, max: number, windowMinutes: number, lockMinutes = windowMinutes): Promise<number> {
  const r = await c.query<{ count: number }>(
    `INSERT INTO platform.rate_limit_bucket AS b (bucket_key, window_start, count, locked_until)
     VALUES ($1, date_bin(make_interval(mins => $2), now(), timestamptz 'epoch'), 1,
             CASE WHEN 1 >= $3 THEN now() + make_interval(mins => $4) END)
     ON CONFLICT (bucket_key, window_start) DO UPDATE SET count = b.count + 1, updated_at = now(),
       locked_until = CASE WHEN b.count + 1 >= $3 THEN now() + make_interval(mins => $4) ELSE b.locked_until END
     RETURNING count`, [key, windowMinutes, max, lockMinutes]);
  return r.rows[0].count;
}
/** Seconds until the key's lock ends (>= 1); 0 when not locked. */
export async function bucketRetryAfter(c: Q, key: string): Promise<number> {
  const r = await c.query<{ s: number | null }>(
    `SELECT ceil(extract(epoch FROM max(locked_until) - now()))::int AS s FROM platform.rate_limit_bucket WHERE bucket_key = $1 AND locked_until > now()`, [key]);
  const s = r.rows[0]?.s ?? 0;
  return s > 0 ? s : 0;
}
export async function bucketClear(c: Q, keys: string[]): Promise<void> {
  if (keys.length) await c.query(`DELETE FROM platform.rate_limit_bucket WHERE bucket_key = ANY($1::text[])`, [keys]);
}
/** Lockout policy shared by tenant, partner and admin password logins. */
export const LOGIN_MAX_FAILS = 5;
export const LOGIN_WINDOW_MIN = 15;
