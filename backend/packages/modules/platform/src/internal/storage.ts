import { randomBytes } from 'node:crypto';
import { XLSX_TYPE } from '@jw/storage';
export * from '@jw/storage';
export const STORAGE = 'JW_STORAGE';

export const FILE_TOKEN_KEY = 'JW_FILE_TOKEN_KEY';
/**
 * FILE_TOKEN_SECRET (>= 32 chars) signs download tokens. Required when NODE_ENV=production or STORAGE_DRIVER=s3;
 * otherwise (dev/test) a random per-process key is used.
 */
export function fileTokenKeyFromEnv(env: NodeJS.ProcessEnv = process.env): Buffer {
  const s = env.FILE_TOKEN_SECRET;
  if (s !== undefined && s.length < 32) throw new Error('invalid storage env: FILE_TOKEN_SECRET (min 32 chars)');
  if (s) return Buffer.from(s, 'utf8');
  if (env.NODE_ENV === 'production' || env.STORAGE_DRIVER === 's3') throw new Error('invalid storage env: FILE_TOKEN_SECRET');
  return randomBytes(32);
}

/** platform.file.original_name: base name only, no control chars, 1..255 code points (974 CHECK). */
export function originalName(raw: string | undefined, contentType: string): string {
  const base = String(raw ?? '').split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const clean = Array.from(base.normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '').trim()).slice(0, 255).join('');
  return clean || (contentType === XLSX_TYPE ? 'upload.xlsx' : 'upload.csv');
}

/** RFC 6266 / RFC 5987 Content-Disposition: ASCII fallback filename="..." plus filename*=UTF-8''<pct-encoded>. Header-injection safe. */
export function contentDisposition(name: string): string {
  // eslint-disable-next-line no-control-regex
  const n = name.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '');
  const ascii = n.replace(/[^\x20-\x7e]/g, '_').replace(/["\\%]/g, '_').trim() || 'download';
  const ext = encodeURIComponent(n).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${ext}`;
}
