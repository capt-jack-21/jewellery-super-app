import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, relative, isAbsolute } from 'node:path';
export const sha256 = (body) => createHash('sha256').update(body).digest('hex');
/** Content-addressed provenance, no Git/secret/network dependency in the build or tests. */
export function releaseManifest(root, commit, files) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('full commit SHA required');
  const api = readFileSync(resolve(root, 'contracts/openapi.yaml'));
  const version = api.toString().match(/^  version: ([0-9.]+)$/m)?.[1];
  const constant = readFileSync(resolve(root, 'packages/modules/platform/src/internal/contract-version.ts'), 'utf8');
  if (!version || constant.match(/export const CONTRACT_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1] !== version) throw new Error('contract/version drift');
  const source = {};
  for (const file of [...new Set(files)].sort()) {
    const path = relative(resolve(root), resolve(root, file));
    if (path.startsWith('..') || isAbsolute(path) || /(^|\/)\.env/.test(path)) throw new Error('invalid manifest path');
    source[path] = sha256(readFileSync(resolve(root, file)));
  }
  return { schema_version: 1, commit, contract_version: version, openapi_sha256: sha256(api), source_sha256: sha256(JSON.stringify(source)), files: source };
}
