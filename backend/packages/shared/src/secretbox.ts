import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
/**
 * AES-256-GCM "secret box" for app-side encrypted columns (otp_delivery.ciphertext, customer.pan_enc,
 * bank_account.account_no_enc).
 * Layout (data model v1.8): nonce(12) | ciphertext | tag(16)  (>= 28 bytes; satisfies the length/non-text CHECKs).
 * Key: APP_ENC_KEY (base64, 32 bytes) + APP_ENC_KEY_ID (matches ^[a-z0-9._-]{1,40}$). Dev fallback outside production.
 */
export interface EncKey { id: string; key: Buffer }
const DEV_KEY: EncKey = { id: 'dev-0', key: Buffer.alloc(32, 7) };
export function currentEncKey(): EncKey {
  const raw = process.env.APP_ENC_KEY;
  if (!raw) {
    if (process.env.NODE_ENV === 'production') throw new Error('APP_ENC_KEY (base64, 32 bytes) is required');
    return DEV_KEY;
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('APP_ENC_KEY must decode to 32 bytes');
  const id = process.env.APP_ENC_KEY_ID ?? 'k1';
  if (!/^[a-z0-9._-]{1,40}$/.test(id)) throw new Error('APP_ENC_KEY_ID is invalid');
  return { id, key };
}
export function keyById(id: string): EncKey {
  const k = currentEncKey();
  if (k.id === id) return k;
  if (id === DEV_KEY.id && process.env.NODE_ENV !== 'production') return DEV_KEY;
  throw new Error(`unknown encryption key id ${id}`);
}
export function seal(plain: string | Buffer, aad?: string, k: EncKey = currentEncKey()): { keyId: string; box: Buffer } {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k.key, iv);
  if (aad) c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(typeof plain === 'string' ? Buffer.from(plain, 'utf8') : plain), c.final()]);
  return { keyId: k.id, box: Buffer.concat([iv, ct, c.getAuthTag()]) };
}
export function open(keyId: string, box: Buffer, aad?: string): Buffer {
  if (box.length < 28) throw new Error('ciphertext too short');
  const d = createDecipheriv('aes-256-gcm', keyById(keyId).key, box.subarray(0, 12));
  if (aad) d.setAAD(Buffer.from(aad));
  d.setAuthTag(box.subarray(box.length - 16));
  return Buffer.concat([d.update(box.subarray(12, box.length - 16)), d.final()]);
}
