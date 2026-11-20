import { it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseManifest } from './release-manifest.mjs';
it('QA N1 — immutable manifest binds a full commit, contract version/hash and every source byte', () => {
  const root = mkdtempSync(join(tmpdir(), 'jw-manifest-'));
  try {
    mkdirSync(join(root, 'contracts'), { recursive: true });
    mkdirSync(join(root, 'packages/modules/platform/src/internal'), { recursive: true });
    writeFileSync(join(root, 'contracts/openapi.yaml'), 'info:\n  version: 0.9.3\n');
    writeFileSync(join(root, 'packages/modules/platform/src/internal/contract-version.ts'), "export const CONTRACT_VERSION = '0.9.3';");
    writeFileSync(join(root, 'source.ts'), 'first');
    const a = releaseManifest(root, 'a'.repeat(40), ['source.ts']);
    expect(a.contract_version).toBe('0.9.3');
    expect(a).toEqual(releaseManifest(root, 'a'.repeat(40), ['source.ts']));
    writeFileSync(join(root, 'source.ts'), 'changed');
    expect(releaseManifest(root, 'a'.repeat(40), ['source.ts']).source_sha256).not.toBe(a.source_sha256);
    expect(() => releaseManifest(root, 'main', ['source.ts'])).toThrow(/full commit/);
    expect(() => releaseManifest(root, 'a'.repeat(40), ['../elsewhere'])).toThrow(/path/);
    writeFileSync(join(root, 'packages/modules/platform/src/internal/contract-version.ts'), "// stale comment mentions '0.9.3'\nexport const CONTRACT_VERSION = '0.9.2';");
    expect(() => releaseManifest(root, 'a'.repeat(40), ['source.ts'])).toThrow(/drift/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
