#!/usr/bin/env node
/**
 * Release check (fd3307b rollback): build the same `pnpm deploy --filter=<app> --prod <tmp>` tree the Dockerfile builds and prove
 * that every @jw/* package the app imports at runtime resolves FROM that tree with plain node (require.resolve), then delete it.
 * Needs a prior `pnpm run build` (workspace packages ship their dist/). Usage: node packages/tooling/deploy-resolution.mjs [@jw/api ...]
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { missingWorkspaceDeps } from './workspace-deps.mjs';

const ROOT = resolve(new URL('.', import.meta.url).pathname, '../..');
const { apps, imports } = missingWorkspaceDeps(ROOT);
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : apps;
let failed = 0;
for (const app of wanted) {
  const out = mkdtempSync(join(tmpdir(), 'jw-deploy-'));
  try {
    rmSync(out, { recursive: true, force: true });
    execFileSync('pnpm', ['deploy', `--filter=${app}`, '--prod', out], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
    for (const dep of imports.get(app) ?? []) {
      let res;
      try {
        const p = execFileSync(process.execPath, ['-e', `process.stdout.write(require.resolve(${JSON.stringify(dep)}))`], { cwd: out, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        res = existsSync(p) ? `OK ${p.slice(out.length + 1)}` : `MISSING_FILE ${p}`;
      } catch (e) { res = `FAIL ${String(e.stderr ?? e.message).split('\n').find((l) => /Cannot find module|Error/.test(l)) ?? 'unresolvable'}`; }
      if (!res.startsWith('OK')) failed++;
      console.log(`DEPLOY_RESOLVE ${app} ${dep} ${res}`);
    }
  } finally { rmSync(out, { recursive: true, force: true }); }
}
console.log(`DEPLOY_RESOLVE_RESULT ${failed ? 'FAIL' : 'OK'} apps=${wanted.join(',')} failures=${failed}`);
process.exit(failed ? 1 : 0);
