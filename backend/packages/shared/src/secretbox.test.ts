import { createDecipheriv } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { currentEncKey, open, seal } from './secretbox';

describe('secretbox (AES-256-GCM, nonce|ct|tag)', () => {
  it('round-trips with AAD and uses the nonce(12) | ciphertext | tag(16) layout', () => {
    const { keyId, box } = seal('123456789012', 'aad-1');
    expect(box.length).toBe(12 + 12 + 16);
    expect(open(keyId, box, 'aad-1').toString()).toBe('123456789012');
    const d = createDecipheriv('aes-256-gcm', currentEncKey().key, box.subarray(0, 12));
    d.setAAD(Buffer.from('aad-1')); d.setAuthTag(box.subarray(box.length - 16));
    expect(Buffer.concat([d.update(box.subarray(12, box.length - 16)), d.final()]).toString()).toBe('123456789012');
  });
  it('rejects a wrong AAD or tampered ciphertext', () => {
    const { keyId, box } = seal('x', 'a');
    expect(() => open(keyId, box, 'b')).toThrow();
    box[13] ^= 1;
    expect(() => open(keyId, box, 'a')).toThrow();
  });
});
