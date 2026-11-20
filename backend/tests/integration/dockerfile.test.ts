import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
it('api image ships every migrations/*.sql (incl. 000_bootstrap.sql) at /app/migrations', () => {
  const d = readFileSync('apps/api/Dockerfile', 'utf8');
  expect(d).toMatch(/^COPY jewellery-data-model\/migrations\/ \/app\/migrations\/$/m);
  expect(d).toMatch(/ls \/app\/migrations\/000_bootstrap\.sql dist\/migrate\.js/);
  expect(d).toMatch(/MIGRATIONS_DIR=\/app\/migrations/);
});
it('each app has a Dockerfile', () => { for (const a of ['api', 'worker', 'web']) expect(readFileSync(`apps/${a}/Dockerfile`, 'utf8')).toMatch(/^FROM /m); });
