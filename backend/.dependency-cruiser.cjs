/** Module import boundaries. Cross-module access only via a module's public entry (src/index.ts → package main). */
module.exports = {
  forbidden: [
    { name: 'no-cross-module-internal', severity: 'error',
      comment: 'modules may import another module only via its public entry, never its internal/ folder',
      from: { path: '^packages/modules/([^/]+)/' },
      to: { path: '^packages/modules/([^/]+)/src/internal/', pathNot: '^packages/modules/$1/' } },
    { name: 'no-deep-dist-import', severity: 'error', from: {}, to: { path: '(^|/)(@jw/mod-[^/]+|packages/modules/[^/]+)/dist/(?!index)' } },
    { name: 'reports-imports-no-writers', severity: 'error', comment: 'Reports is read-only: no dependency on modules that write',
      from: { path: '^packages/modules/reports/' }, to: { path: '^packages/modules/(sales|inventory|accounts)/' } },
    { name: 'api-no-pgboss', severity: 'error', comment: 'apps/api writes notifications.outbox; only apps/worker talks to pg-boss',
      from: { path: '^(apps/api|packages)/' }, to: { path: 'node_modules/(\\.pnpm/)?pg-boss' } },
    { name: 'modules-not-from-apps', severity: 'error', comment: 'packages never import apps',
      from: { path: '^packages/' }, to: { path: '^apps/' } },
    { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|node_modules|\\.turbo)/' },
    tsConfig: { fileName: 'tsconfig.base.json' },
    tsPreCompilationDeps: true,
    combinedDependencies: true,
  },
};
