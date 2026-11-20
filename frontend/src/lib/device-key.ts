/**
 * Opaque per-device secret (P10), generated on first launch and sent on login/OTP/device registration.
 * It identifies the browser profile, not the user; the server binds sessions to approved devices only.
 */
const KEY = 'device-key-v1';
export function deviceKey(): string {
  let k = localStorage.getItem(KEY);
  if (!k || k.length < 32) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    k = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(KEY, k);
  }
  return k;
}
