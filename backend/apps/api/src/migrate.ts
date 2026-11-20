/** `node dist/migrate.js` — applies the data-model SQL as app_migrator (000_bootstrap is a separate superuser step). */
import { resolve } from 'node:path';
import { migrate } from '@jw/db';
const url = process.env.MIGRATOR_DATABASE_URL;
const dir = resolve(process.env.MIGRATIONS_DIR ?? '/app/migrations');
if (!url) { console.error('MIGRATOR_DATABASE_URL is required'); process.exit(2); }
migrate(url, dir).then(
  (r) => console.log(`migrations: applied ${r.applied.length}, already applied ${r.skipped.length}`),
  (e) => { console.error(`migration failed: ${e.message}`); process.exit(1); },
);
