// Introspection only (drizzle-kit pull). NEVER use generate/migrate/push.
import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  dialect: 'postgresql',
  out: './packages/db/src/schema/generated',
  dbCredentials: { url: process.env.INTROSPECT_DATABASE_URL ?? (() => { throw new Error('set INTROSPECT_DATABASE_URL'); })() },
  schemaFilter: ['platform', 'branding', 'billing', 'notifications', 'masters', 'rates', 'hr', 'accounts', 'inventory', 'approvals', 'sales', 'orders', 'purchases', 'refinery', 'reports'],
});
