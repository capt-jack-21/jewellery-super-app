/** This client's version (matches the backend contract it was generated from). Checked against /v1/meta min_client_version. */
export const CLIENT_VERSION = '0.4.4';

/** Numeric semver compare of MAJOR.MINOR.PATCH (pre-release suffixes ignored). */
export function compareVersions(a: string, b: string): number {
  const p = (v: string) => (v.split('-')[0] ?? '').split('.').map((x) => Number.parseInt(x, 10) || 0);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d) return Math.sign(d); }
  return 0;
}

/** True when the server requires a newer client than this one. Unknown/missing min version → never blocks. */
export const clientTooOld = (minClient: string | null | undefined, client = CLIENT_VERSION): boolean =>
  !!minClient && compareVersions(client, minClient) < 0;
