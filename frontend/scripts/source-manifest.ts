import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';

export interface SourceEntry { path: string; sha256: string }
const EXCLUDED = new Set(['.git', 'node_modules', 'dist', 'build', '.turbo', 'coverage', '.vite', 'screenshots', '.sync-logs', 'test-results', 'playwright-report']);
export const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const ordered = (entries: readonly SourceEntry[]) => [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
/** Same fingerprint as sorted `sha256sum` lines for ./relative paths; no timestamps, IDs or credentials. */
export const sourceTreeHash = (entries: readonly SourceEntry[]) => sha256(ordered(entries).map((e) => `${e.sha256}  ./${e.path}\n`).join(''));
export function sourceEntries(root: string, relative = ''): SourceEntry[] {
  const out: SourceEntry[] = [];
  for (const f of readdirSync(join(root, relative), { withFileTypes: true })) {
    if (EXCLUDED.has(f.name) || f.name === '.env' || f.name.startsWith('.env.') || f.name.endsWith('.tsbuildinfo') || f.name.endsWith('.log')) continue;
    const path = relative ? `${relative}/${f.name}` : f.name;
    if (f.isDirectory()) out.push(...sourceEntries(root, path));
    else if (f.isFile()) out.push({ path, sha256: sha256(readFileSync(join(root, path))) });
  }
  return ordered(out);
}
export function buildSourceManifest(root: string) {
  const pin = JSON.parse(readFileSync(join(root, 'contracts/sales-pin.json'), 'utf8')) as {
    contract_version: string; contract_sha256: string; backend_review_target_commit: string; backend_commit_provenance: string;
    frontend_commit: null; frontend_source_kind: string;
  };
  const contractHash = sha256(readFileSync(join(root, 'contracts/backend.openapi.yaml')));
  if (contractHash !== pin.contract_sha256) throw new Error('Pinned Sales contract checksum mismatch; explicit re-pin required');
  const files = sourceEntries(root);
  return { schema_version: 1, ...pin, source_tree_sha256: sourceTreeHash(files), source_file_count: files.length,
    package_lock_sha256: sha256(readFileSync(join(root, 'package-lock.json'))), files };
}
/** Immutable, content-addressed build evidence, plus a discoverable copy. No deployment or QA source freeze is implied. */
export function sourceManifestPlugin(root = process.cwd()): Plugin {
  return { name: 'source-manifest', apply: 'build',
    transformIndexHtml: { order: 'post', handler() {
      const manifest = buildSourceManifest(root);
      return [{ tag: 'meta', attrs: { name: 'source-manifest', content: `/source-manifest.${manifest.source_tree_sha256}.json` }, injectTo: 'head' }];
    } },
    generateBundle() {
    const manifest = buildSourceManifest(root);
    const source = `${JSON.stringify(manifest, null, 2)}\n`;
    const fileName = `source-manifest.${manifest.source_tree_sha256}.json`;
    this.emitFile({ type: 'asset', fileName, source });
    this.emitFile({ type: 'asset', fileName: 'source-manifest.json', source });
  } };
}
