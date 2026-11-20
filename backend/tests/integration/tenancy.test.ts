import { describe, it, expect, afterAll } from 'vitest';
import { withTenantTx, withModuleRole, currentTx } from '@jw/db';
import { allocateDocNo } from '@jw/mod-sales';
import { salesFixture } from './sales-fixture';
import { HUID_PREFIX } from './huid';
import { issueInvoice } from '@jw/mod-sales';
import { seriesGapCount } from '@jw/mod-reports';
import { pool, T1, T2, U1, B1, TAG1 } from './env';

const rw = pool('app_rw');
const ro = pool('app_ro');
afterAll(async () => { await rw.end(); await ro.end(); });
const s1 = { tenantId: T1, userId: U1, branchId: B1 };

describe('cross-tenant isolation (app_rw, forced RLS)', () => {
  it('tenant 2 sees zero tenant-1 rows in EVERY tenant_id table it can read', async () => {
    const tables = (await withTenantTx(rw, { tenantId: T2 }, (c) => c.query<{ t: string }>(
      `SELECT format('%I.%I', table_schema, table_name) AS t FROM information_schema.columns c
        WHERE column_name = 'tenant_id' AND table_schema NOT IN ('pg_catalog','information_schema','pgboss','migrator')
          AND CASE WHEN has_schema_privilege(table_schema, 'USAGE') THEN has_table_privilege(format('%I.%I', table_schema, table_name), 'SELECT') ELSE false END
        GROUP BY 1 ORDER BY 1`))).rows.map((r) => r.t);
    expect(tables.length).toBeGreaterThan(30);
    const leaks: string[] = [];
    let t1Visible = 0;
    for (const t of tables) {
      const [n2, n1] = await Promise.all([
        withTenantTx(rw, { tenantId: T2 }, (c) => c.query(`SELECT count(*)::int n FROM ${t} WHERE tenant_id = $1`, [T1])),
        withTenantTx(rw, { tenantId: T1 }, (c) => c.query(`SELECT count(*)::int n FROM ${t} WHERE tenant_id = $1`, [T1])),
      ]);
      if (n2.rows[0].n) leaks.push(t);
      t1Visible += n1.rows[0].n;
    }
    // By design (README G7/branding): VERIFIED custom domains are readable pre-auth for host→tenant resolution.
    expect(leaks).toEqual(['branding.custom_domain']);
    const dom = await withTenantTx(rw, { tenantId: T2 }, (c) => c.query(
      `SELECT count(*)::int n FROM branding.custom_domain WHERE tenant_id = $1 AND status <> 'verified'`, [T1]));
    expect(dom.rows[0].n).toBe(0);
    expect(t1Visible).toBeGreaterThan(5); // control: tenant 1 does see its own seed rows
  });
  it('no tenant context → no rows', async () => {
    const c = await rw.connect();
    try { expect((await c.query('SELECT count(*)::int n FROM platform.branch')).rows[0].n).toBe(0); } finally { c.release(); }
  });
  it('cannot write a row for another tenant', async () => {
    await expect(withTenantTx(rw, { tenantId: T2 }, (c) =>
      c.query(`INSERT INTO masters.customer_group(tenant_id, name) VALUES ($1, 'x')`, [T1]))).rejects.toThrow(/row-level security/);
  });
  it('tenant settings are transaction-local (do not leak to the pooled connection)', async () => {
    await withTenantTx(rw, s1, async () => undefined);
    const c = await rw.connect();
    try { expect((await c.query(`SELECT coalesce(current_setting('app.tenant_id', true),'') v`)).rows[0].v).toBe(''); } finally { c.release(); }
  });
  it('data access outside a tenant tx throws', () => { expect(() => currentTx()).toThrow(/no tenant transaction/); });
});

describe('module role switching (SET LOCAL ROLE, README)', () => {
  it('plain app_rw cannot write invoices or stock', async () => {
    await expect(withTenantTx(rw, s1, (c) => c.query(`INSERT INTO sales.doc_series(tenant_id, branch_id, doc_type, fy, prefix)
      VALUES ($1,$2,'tax_invoice','2026-27','X/')`, [T1, B1]))).rejects.toThrow(/permission denied/);
    await expect(withTenantTx(rw, s1, (c) => c.query(`UPDATE inventory.tag SET status='sold' WHERE id=$1`, [TAG1]))).rejects.toThrow(/permission denied/);
  });
  it('roles restore to app_rw after the module step', async () => {
    const r = await withTenantTx(rw, s1, async (c) => {
      const inner = await withModuleRole('sales_writer', async (x) => (await x.query('SELECT current_user u')).rows[0].u);
      return { inner, after: (await c.query('SELECT current_user u')).rows[0].u };
    });
    expect(r).toEqual({ inner: 'sales_writer', after: 'app_rw' });
  });
  it('G2: allocating a number without issuing a document fails at COMMIT (no gap)', async () => {
    await expect(withTenantTx(rw, s1, () => allocateDocNo(B1, 'tax_invoice', (fy) => `CBE/INV/${fy}/`))).rejects.toThrow();
  });
  it('smoke: one invoice end-to-end in one tx (sales_writer → inventory_writer), gapless, stock moved', async () => {
    const fx = await salesFixture('tenantct', HUID_PREFIX.tenancy);
    try {
      const tag = await fx.tag({ gross_wt: '1.000', net_wt: '1.000', wastage_pct: '0' });
      const customerId = await fx.customer();
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
      const actor = { userId: fx.ownerId, permissions: new Set(['sales.invoice.issue']), roles: [{ role: 'owner', branch_id: null }], billingEnabled: true };
      const out = await withTenantTx(rw, { tenantId: fx.tenantId, userId: fx.ownerId }, async (c) => {
        const x = await issueInvoice(actor, { branch_id: fx.B1, salesperson_id: fx.staff, customer_id: customerId,
          lines: [{ kind: 'tag', tag_id: tag.id }], payments: [{ mode: 'upi', amount: '6695.00' }] }, day);
        return (await c.query(`SELECT doc_no, invoice_total::text, current_user AS u FROM sales.invoice WHERE id = $1`, [x.id])).rows[0];
      });
      expect(out.invoice_total).toBe('6695.00');
      expect(out.doc_no).toMatch(/^[A-Z0-9]+\/\d{4}\/\d{6}$/);
      expect(out.u).toBe('app_rw');
      expect((await fx.sql<{ status: string }>(`SELECT status FROM inventory.tag WHERE id = $1`, [tag.id]))[0].status).toBe('sold');
      expect(await withTenantTx(ro, { tenantId: fx.tenantId }, () => seriesGapCount())).toBe(0);
      const n = await withTenantTx(rw, { tenantId: T2 }, (c) => c.query(`SELECT count(*)::int n FROM sales.invoice WHERE doc_no = $1`, [out.doc_no]));
      expect(n.rows[0].n).toBe(0);
    } finally { await fx.close(); }
  });
  it('app_ro is read-only (permission denied is the expected result)', async () => {
    await expect(withTenantTx(ro, { tenantId: T1 }, (c) => c.query(`INSERT INTO masters.customer_group(tenant_id,name) VALUES ($1,'x')`, [T1])))
      .rejects.toThrow(/permission denied/);
  });
});
