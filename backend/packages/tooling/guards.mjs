#!/usr/bin/env node
// CI guards (INV-2 + module ownership). Scans non-test source under apps/ and packages/. Exit 1 on any violation.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.argv[2] ?? new URL('../..', import.meta.url).pathname;
const SKIP = new Set(['node_modules', 'dist', '.turbo', ...(process.argv[2] ? [] : ['tooling'])]);
const files = [];
function walk(d) {
  for (const f of readdirSync(d)) {
    if (SKIP.has(f)) continue;
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|js|mjs|cjs)$/.test(f) && !/\.(test|spec)\./.test(f)) files.push(p);
  }
}
walk(join(ROOT, 'apps')); walk(join(ROOT, 'packages'));

const moduleOf = (rel) => (rel.match(/^packages\/modules\/([^/]+)\//) ?? [])[1];
const rules = [
  // INV-2: no backdoor / bulk-destructive routes or helpers anywhere.
  { name: 'forbidden-route', re: /\b(backup|truncate|wipe|purge|shadow|alt_series|altSeries|setNow|authenticatepass|bypass_?rls|raw_?sql)\b/i,
    where: () => true, msg: 'backup/truncate/shadow-style routes or helpers are banned (INV-2)' },
  { name: 'forbidden-sql', re: /\b(TRUNCATE|DROP\s+(TABLE|SCHEMA)|DELETE\s+FROM\s+sales\.|ALTER\s+TABLE)\b/i,
    where: () => true, msg: 'destructive SQL in app code' },
  { name: 'sales-role-owner', re: /sales_writer/, where: (r) => moduleOf(r) !== 'sales' && !r.startsWith('packages/db/'),
    msg: 'only the Sales module may assume sales_writer' },
  { name: 'inventory-role-owner', re: /inventory_writer/, where: (r) => moduleOf(r) !== 'inventory' && !r.startsWith('packages/db/'),
    msg: 'only the Inventory module may assume inventory_writer' },
  { name: 'accounts-role-owner', re: /accounts_writer/, where: (r) => moduleOf(r) !== 'accounts' && !r.startsWith('packages/db/'),
    msg: 'only the Accounts module may assume accounts_writer' },
  { name: 'orders-role-owner', re: /orders_writer/, where: (r) => moduleOf(r) !== 'orders' && !r.startsWith('packages/db/'),
    msg: 'only the Orders module may assume orders_writer' },
  { name: 'orders-tables-owner', re: /\b(INSERT\s+INTO|UPDATE)\s+orders\.(customer_order|order_line|repair|repair_line|shop_setting)\b/i,
    where: (r) => moduleOf(r) !== 'orders', msg: 'only Orders writes orders / repairs' },
  { name: 'sales-tables-owner', re: /\b(INSERT\s+INTO|UPDATE)\s+sales\.(invoice|invoice_line|invoice_line_tax|invoice_old_metal|invoice_payment|credit_note|credit_note_line|doc_series)\b/i,
    where: (r) => moduleOf(r) !== 'sales', msg: 'only Sales writes invoices / credit notes / doc_series' },
  { name: 'stock-owner', re: /\bINSERT\s+INTO\s+inventory\.stock_ledger\b|\bUPDATE\s+inventory\.tag\s+SET\s+[^;]*\b(status|branch_id)\b/i,
    where: (r) => moduleOf(r) !== 'inventory', msg: 'only Inventory mutates stock' },
  { name: 'reports-read-only', re: /\b(INSERT\s+INTO|UPDATE\s+\w+\.\w+\s+SET|DELETE\s+FROM|withModuleRole|SET\s+(LOCAL\s+)?ROLE)\b/i,
    where: (r) => moduleOf(r) === 'reports', msg: 'Reports is read-only' },
  { name: 'api-no-pgboss', re: /(from\s+|require\()\s*['"]pg-boss['"]|\bpgboss\./,
    where: (r) => r.startsWith('apps/api/') || r.startsWith('packages/'), msg: 'apps/api (and shared packages) must not use pg-boss; write notifications.outbox instead' },
  { name: 'no-float-money', re: /\b(parseFloat|toFixed\s*\(\s*2\s*\)\s*;?\s*\/\/\s*money)\b/,
    where: (r) => !r.startsWith('packages/money/'), msg: 'money/weights must use @jw/money (decimal.js), never floats' },
];
const violations = [];
for (const p of files) {
  const rel = relative(ROOT, p).split(sep).join('/');
  const lines = readFileSync(p, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (/guard-ignore/.test(line)) return;
    for (const r of rules) if (r.where(rel) && r.re.test(line)) violations.push(`${rel}:${i + 1} [${r.name}] ${r.msg}\n    ${line.trim()}`);
  });
}
if (violations.length) { console.error(violations.join('\n')); console.error(`\n${violations.length} guard violation(s)`); process.exit(1); }
console.log(`guards: ${files.length} files clean`);
