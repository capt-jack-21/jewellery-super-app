import { createHmac, timingSafeEqual } from 'node:crypto';

/** Download token: base64url(JSON payload) "." base64url(HMAC-SHA256(key, "jw.file.v1." + payload)). Single purpose. */
export const FILE_TOKEN_PURPOSE = 'file_download';
export const FILE_TOKEN_TTL_SECONDS = 300;
/** t = tenant, f = file id (s 'file') or legacy import job id (s 'job'), k = object key (bound), e = expiry (unix s). */
export interface FileTokenPayload { p: typeof FILE_TOKEN_PURPOSE; t: string; f: string; s?: 'file' | 'job'; k: string; e: number }

const mac = (key: Buffer, body: string) => createHmac('sha256', key).update(`jw.file.v1.${body}`).digest();

export function signFileToken(key: Buffer, v: { tenantId: string; fileId: string; objectKey: string; kind?: 'file' | 'job' }, nowSec = Math.floor(Date.now() / 1000),
                              ttl = FILE_TOKEN_TTL_SECONDS): { token: string; expiresAt: Date } {
  const e = nowSec + ttl;
  const body = Buffer.from(JSON.stringify({ p: FILE_TOKEN_PURPOSE, t: v.tenantId, f: v.fileId, s: v.kind ?? 'file', k: v.objectKey, e })).toString('base64url');
  return { token: `${body}.${mac(key, body).toString('base64url')}`, expiresAt: new Date(e * 1000) };
}

/** null for any malformed, tampered, wrong-purpose or expired token (callers answer 404 / 410 without saying which). */
export function verifyFileToken(key: Buffer, token: string, nowSec = Math.floor(Date.now() / 1000)):
    { ok: true; payload: FileTokenPayload } | { ok: false; reason: 'invalid' | 'expired' } {
  if (typeof token !== 'string' || token.length > 2048) return { ok: false, reason: 'invalid' };
  const parts = token.split('.');
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return { ok: false, reason: 'invalid' };
  const want = mac(key, parts[0]);
  const got = Buffer.from(parts[1], 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, reason: 'invalid' };
  let p: FileTokenPayload;
  try { p = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch { return { ok: false, reason: 'invalid' }; }
  if (p?.p !== FILE_TOKEN_PURPOSE || typeof p.t !== 'string' || typeof p.f !== 'string' || typeof p.k !== 'string' || !Number.isInteger(p.e)
      || (p.s !== undefined && p.s !== 'file' && p.s !== 'job'))
    return { ok: false, reason: 'invalid' };
  if (p.e <= nowSec) return { ok: false, reason: 'expired' };
  return { ok: true, payload: p };
}
