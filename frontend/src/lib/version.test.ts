import { describe, expect, it } from 'vitest';
import { CLIENT_VERSION, clientTooOld, compareVersions } from './version';

describe('client version check', () => {
  it('is 0.4.0 and satisfies the 0.4.0 contract minimum 0.3.0', () => {
    expect(CLIENT_VERSION).toBe('0.4.4');
    expect(clientTooOld('0.3.0')).toBe(false);
    expect(clientTooOld('0.4.0')).toBe(false);
  });
  it('blocks when the server needs a newer client', () => {
    expect(clientTooOld('0.5.0')).toBe(true);
    expect(clientTooOld('1.0.0')).toBe(true);
    expect(clientTooOld(undefined)).toBe(false);
  });
  it('compares numerically, not lexically', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBe(0);
  });
});
