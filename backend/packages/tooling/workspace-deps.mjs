/**
 * Release guard (fd3307b rollback): `pnpm deploy --filter=<app> --prod` copies ONLY what an app's package.json declares
 * (transitively). A workspace @jw/* package that is imported at runtime but declared only in the root package.json works
 * in the monorepo and dies in the image with "Cannot find module". This module finds such gaps statically.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC_EXT = /\.(c|m)?[jt]sx?$/;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const PKG = String.raw`@jw\/[a-z0-9][a-z0-9-]*`;
// value imports/exports (an `import type` / `export type` statement is erased by tsc and never loaded at runtime)
const STATEMENT = new RegExp(String.raw`(?:^|[;\n}])\s*(import|export)(\s+type\b)?[^;]*?\bfrom\s*['"](${PKG})(?:\/[^'"]*)?['"]`, 'g');
const BARE = [new RegExp(String.raw`\bimport\s*['"](${PKG})(?:\/[^'"]*)?['"]`, 'g'), new RegExp(String.raw`\bimport\(\s*['"](${PKG})(?:\/[^'"]*)?['"]`, 'g'),
  new RegExp(String.raw`\brequire\(\s*['"](${PKG})(?:\/[^'"]*)?['"]`, 'g')];

/** Runtime @jw/* package names imported by one source text. */
export function runtimeJwImports(text) {
  const out = new Set();
  for (const m of text.matchAll(STATEMENT)) if (!m[2]) out.add(m[3]);
  for (const rx of BARE) for (const m of text.matchAll(rx)) out.add(m[1]);
  return out;
}
function walk(dir, files = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist'].includes(e.name)) continue;
    const f = join(dir, e.name);
    if (e.isDirectory()) walk(f, files); else if (SRC_EXT.test(e.name) && !TEST_FILE.test(e.name) && !e.name.endsWith('.d.ts')) files.push(f);
  }
  return files;
}
/** name -> { dir, pkg } for every workspace package under apps/, packages/ and packages/modules/. */
export function workspacePackages(root) {
  const out = new Map();
  for (const base of ['apps', 'packages', 'packages/modules']) {
    const b = join(root, base);
    if (!existsSync(b)) continue;
    for (const d of readdirSync(b)) {
      const f = join(b, d, 'package.json');
      if (existsSync(f) && statSync(f).isFile()) { const pkg = JSON.parse(readFileSync(f, 'utf8')); out.set(pkg.name, { dir: join(b, d), pkg }); }
    }
  }
  return out;
}
/** Apps whose Dockerfile builds the runtime with `pnpm deploy --filter=<name> --prod` (api, worker). */
export function deployedApps(root) {
  const apps = [];
  for (const [name, { dir }] of workspacePackages(root)) {
    const df = join(dir, 'Dockerfile');
    if (existsSync(df) && new RegExp(String.raw`pnpm\s+deploy\s+--filter=${name.replace('/', '\\/')}\s+--prod`).test(readFileSync(df, 'utf8'))) apps.push(name);
  }
  return apps.sort();
}
/**
 * For every deployed app and every workspace package it (transitively) deploys: runtime @jw/* imports in src that are not in
 * that package's `dependencies` (devDependencies / root package.json do not ship).
 */
export function missingWorkspaceDeps(root) {
  const ws = workspacePackages(root);
  const problems = [];
  const imports = new Map();
  for (const app of deployedApps(root)) {
    const seen = new Set(); const queue = [app];
    while (queue.length) {
      const name = queue.shift();
      if (seen.has(name) || !ws.has(name)) continue;
      seen.add(name);
      const { dir, pkg } = ws.get(name);
      const deps = pkg.dependencies ?? {};
      const src = join(dir, 'src');
      const used = new Set();
      if (existsSync(src)) for (const f of walk(src)) for (const i of runtimeJwImports(readFileSync(f, 'utf8'))) {
        if (i === name) continue;
        used.add(i);
        if (!(i in deps)) problems.push({ app, package: name, missing: i, file: relative(root, f) });
      }
      imports.set(name, [...used].sort());
      for (const d of Object.keys(deps)) if (d.startsWith('@jw/')) queue.push(d);
    }
  }
  const unique = new Map(problems.map((p) => [`${p.package}>${p.missing}`, p]));
  return { apps: deployedApps(root), imports, problems: [...unique.values()] };
}
