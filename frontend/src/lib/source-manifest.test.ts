import { describe, expect, it } from 'vitest';
import { buildSourceManifest, sha256, sourceTreeHash } from '../../scripts/source-manifest';

describe('QA N1: immutable source/contract build provenance', () => {
  it('fingerprints bytes and paths deterministically rather than claiming a frontend git revision', () => {
    const a = { path: 'a.ts', sha256: sha256('one') }, b = { path: 'b.ts', sha256: sha256('two') };
    expect(sourceTreeHash([a, b])).toBe(sourceTreeHash([b, a]));
    expect(sourceTreeHash([a, b])).not.toBe(sourceTreeHash([{ ...a, sha256: sha256('changed') }, b]));
    expect(sourceTreeHash([a, b])).not.toBe(sourceTreeHash([{ ...a, path: 'renamed.ts' }, b]));
  });
  it('records the verified 0.9.6 contract, unchanged lock, verified backend commit-object target and exact source files', () => {
    const m = buildSourceManifest(process.cwd());
    expect(m.frontend_commit).toBeNull();
    expect(m.frontend_source_kind).toBe('plain-source-tree');
    expect(m.backend_review_target_commit).toBe('fd3307b4ba06a03f89cfcca18caf9db8209ace09');
    expect(m.backend_commit_provenance).toContain('not an inferred git revision');
    expect(m.contract_version).toBe('0.9.6');
    expect(m.contract_sha256).toBe('04f43a423613a8a0dac8ffddc44bf9df771cf6dc56f69333ef7e237609363dc0');
    expect(m.package_lock_sha256).toBe('a425ffa36d736e8ec4baf1cd8a8335a6e0c3133592081bedb07795ce8278c657');
    expect(m.source_file_count).toBe(m.files.length);
    expect(m.source_tree_sha256).toBe(sourceTreeHash(m.files));
    expect(m.files.some((f) => f.path.startsWith('dist/') || f.path.startsWith('node_modules/') || f.path.startsWith('.env'))).toBe(false);
  });
});
