/**
 * The ONLY place that performs HTTP (Orval mutator). Cookie sessions (tenant sid, partner psid, admin), CSRF,
 * locale, branch, If-Match and idempotency headers; problem+json → ApiError. Contract paths are /v1/...; the server URL is /api.
 */
export interface ProblemFieldError { path: string; message: string; code?: string }
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string | undefined,
    public title: string,
    public detail?: string,
    public errors: ProblemFieldError[] = [],
    /** 429: seconds from the Retry-After header. */
    public retryAfter?: number,
    /** The whole problem body, for typed extensions (e.g. Sales 0.9.1 409 customer_phone_exists → existing_customer). */
    public problem?: Record<string, unknown>,
  ) {
    super(title);
  }
  get isConflict() { return this.status === 409; }
  get isNetwork() { return this.status === 0; }
  get isUnauthorized() { return this.status === 401; }
  get isForbidden() { return this.status === 403; }
  /** 429 problem `rate_limited` (with Retry-After seconds). Login lockout is a plain 401 invalid_credentials. */
  get isRateLimited() { return this.status === 429; }
  /** 412 version_mismatch (someone else saved first) or 428 precondition_required (no If-Match sent). */
  get isStale() { return this.status === 412 || this.status === 428; }
}

/**
 * Optimistic concurrency: Orval now types If-Match as a header argument (IfMatch / IfMatchOptional params).
 * `ifMatch` builds the required header from the row's `version` (print templates: `row_version`);
 * `ifMatchOptional` sends it only when a version exists (first theme / first setting override has none).
 */
export type IfMatchHeader = { 'If-Match': string };
export function ifMatch(version: number | null | undefined): IfMatchHeader {
  if (version == null) throw new ApiError(428, 'precondition_required', 'Missing version; reload and retry');
  return { 'If-Match': `"${version}"` };
}
export const ifMatchOptional = (version: number | null | undefined): IfMatchHeader | undefined =>
  version == null ? undefined : { 'If-Match': `"${version}"` };

export const API_BASE = '/api';
const ctx = { locale: 'en-IN', branchId: '' as string, csrf: '' as string };
export function setApiContext(p: Partial<typeof ctx>) { Object.assign(ctx, p); }

export async function apiFetch<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  headers.set('Accept-Language', ctx.locale);
  if (ctx.branchId) headers.set('X-Branch-Id', ctx.branchId);
  if (ctx.csrf && init.method && init.method !== 'GET') headers.set('X-CSRF-Token', ctx.csrf);
  const full = url.startsWith('/v1/') || url === '/health' ? `${API_BASE}${url}` : url;
  let res: Response;
  try {
    res = await fetch(full, { ...init, headers, credentials: 'include' });
  } catch (e) {
    throw new ApiError(0, 'network', 'Network unavailable', String(e));
  }
  const text = res.status === 204 ? '' : await res.text();
  let body: unknown;
  const ct = res.headers.get('content-type') ?? '';
  // JSON (incl. problem+json) is parsed; text/csv and other text bodies (e.g. import templates) are returned as-is.
  if (!text) body = undefined;
  else if (ct.includes('json') || !ct) { try { body = JSON.parse(text); } catch { body = text; } }
  else body = text;
  if (!res.ok) {
    const p = (body ?? {}) as { code?: string; title?: string; detail?: string; errors?: ProblemFieldError[] };
    const ra = Number(res.headers.get('Retry-After'));
    throw new ApiError(res.status, p.code ?? (res.status === 429 ? 'rate_limited' : undefined), p.title ?? res.statusText, p.detail, p.errors ?? [], Number.isFinite(ra) && ra > 0 ? ra : res.status === 429 ? RETRY_AFTER_FALLBACK_S : undefined,
      body && typeof body === 'object' ? (body as Record<string, unknown>) : undefined);
  }
  // Orval's fetch client expects { data, status, headers }.
  return { data: body, status: res.status, headers: res.headers } as T;
}
export default apiFetch;

/** Success payload of a generated call (errors are thrown by apiFetch, so only 2xx reaches here). */
export type Ok<R> = R extends { status: 200 | 201 | 204; data: infer D } ? D : never;
/** Contract 0.4.0: if a proxy strips Retry-After on a 429, clients fall back to 30 s. */
export const RETRY_AFTER_FALLBACK_S = 30;

export async function ok<R extends { status: number; data: unknown }>(p: Promise<R>): Promise<Ok<R>> {
  return (await p).data as Ok<R>;
}
