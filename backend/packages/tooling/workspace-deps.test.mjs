import { it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runtimeJwImports, deployedApps, missingWorkspaceDeps } from './workspace-deps.mjs';

const ROOT = resolve(import.meta.dirname ?? new URL('.', import.meta.url).pathname, '../..');

it('release guard (fd3307b rollback) — every runtime @jw/* import of a deployed app (and of each workspace package it deploys) is in that package.json dependencies', () => {
  const r = missingWorkspaceDeps(ROOT);
  expect(r.apps).toEqual(['@jw/api', '@jw/worker']); // both Dockerfiles use `pnpm deploy --filter=<app> --prod`
  expect(r.problems).toEqual([]);
  expect(r.imports.get('@jw/api')).toContain('@jw/mod-sales');
  expect(JSON.parse(readFileSync(join(ROOT, 'apps/api/package.json'), 'utf8')).dependencies['@jw/mod-sales']).toBe('workspace:^');
});

it('release guard detects the fd3307b shape (declared only at the root) and ignores type-only imports', () => {
  expect([...runtimeJwImports(`import { a } from '@jw/x';\nimport type { T } from '@jw/t';\nexport type { U } from '@jw/u';\nimport {\n  b,\n  c,\n} from '@jw/multi/sub';\nexport * from '@jw/re';\nconst m = await import('@jw/dyn');\nrequire('@jw/req');\nimport '@jw/side';`)].sort())
    .toEqual(['@jw/dyn', '@jw/multi', '@jw/re', '@jw/req', '@jw/side', '@jw/x']);
  const root = mkdtempSync(join(tmpdir(), 'jw-wsdeps-'));
  try {
    const pkg = (dir, name, deps, src, dockerfile) => {
      mkdirSync(join(root, dir, 'src'), { recursive: true });
      writeFileSync(join(root, dir, 'package.json'), JSON.stringify({ name, dependencies: deps }));
      writeFileSync(join(root, dir, 'src/index.ts'), src);
      if (dockerfile) writeFileSync(join(root, dir, 'Dockerfile'), dockerfile);
    };
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { '@jw/mod-sales': 'workspace:^' } })); // root-only: does not ship
    pkg('apps/api', '@jw/api', { '@jw/db': 'workspace:^' }, `import { SalesModule } from '@jw/mod-sales';\nimport type { X } from '@jw/types-only';\nimport { db } from '@jw/db';`,
      'RUN pnpm deploy --filter=@jw/api --prod /out');
    pkg('packages/db', '@jw/db', {}, `import { money } from '@jw/money';`);
    pkg('packages/modules/sales', '@jw/mod-sales', {}, '');
    pkg('apps/web', '@jw/web', {}, `import { x } from '@jw/never-deployed';`);
    const r = missingWorkspaceDeps(root);
    expect(deployedApps(root)).toEqual(['@jw/api']);
    expect(r.problems.map((p) => [p.package, p.missing])).toEqual([['@jw/api', '@jw/mod-sales'], ['@jw/db', '@jw/money']]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
