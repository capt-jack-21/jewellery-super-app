import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { withTenantTx, withModuleRole, RELEASE_PRINT_PINS } from '@jw/db';
import { validateAt } from './contract';
import { pool, DB, HOST, PORT, assertTestTarget } from './env';
import { salesFixture, type SalesFx, type Go } from './sales-fixture';
import { HUID_PREFIX } from './huid';

/** Live0.9.5 regressions. Requires the ordinary TEST-role config and migration998; never provisions/rotates roles. */
type J = Record<string, any>;
let fx: SalesFx;
let rw: ReturnType<typeof pool>;
let mig: ReturnType<typeof pool>;
let customer: string;
const SMALL = { gross_wt: '1.000', net_wt: '1.000', wastage_pct: '0' };
const PLATFORM = {
  invoice: '01a1c455-29fa-769b-84f9-377a9bcdab46', estimate: '01a1c455-29fa-7963-88e9-d3cf6e2a8240',
  credit_note: '01a1c455-29fa-7856-b4ed-a3710fd91ec1', receipt: '01a1c455-29fa-7811-b4b1-95efbd5b9ea5',
};
const RECEIPT_PRINT = '/v1/sales/invoices/{id}/payments/{receipt_id}/prints';
beforeAll(async () => {
  fx = await salesFixture('sales095', HUID_PREFIX.sales095); rw = pool('app_rw'); mig = pool('app_migrator'); customer = await fx.customer();
}, 120000);
afterAll(async () => { await rw?.end(); await mig?.end(); await fx?.close(); });
async function newBill(paid = '1000.00', n = 1): Promise<J> {
  const tags = await Promise.all(Array.from({ length: n }, () => fx.tag(SMALL)));
  return (await fx.go('POST', '/v1/sales/invoices', { headers: fx.key(), body: {
    branch_id: fx.B1, customer_id: customer, salesperson_id: fx.staff, lines: tags.map(t => ({ kind: 'tag', tag_id: t.id })),
    payments: [{ mode: 'upi', amount: paid, reference: '095 issue' }],
  }, status: 201 })).json();
}
async function receive(id: string, amount = '1000.00'): Promise<J> {
  return (await fx.go('POST', '/v1/sales/invoices/{id}/payments', { p: { id }, headers: fx.key(),
    body: { tenders: [{ mode: 'upi', amount, reference: '095 receipt' }] }, status: 201 })).json();
}
async function reverse(id: string, receipt_id: string): Promise<J> {
  return (await fx.go('POST', '/v1/sales/invoices/{id}/payments/{receipt_id}/reversal', { p: { id, receipt_id }, headers: fx.key(),
    body: { reason: '095 payment reversed by bank' }, status: 201 })).json();
}
async function printReceipt(id: string, receipt_id: string, body: J = {}, options: Go = {}): Promise<J> {
  return (await fx.go('POST', RECEIPT_PRINT, { p: { id, receipt_id }, headers: fx.key(), body, status: 200, ...options })).json();
}
async function printInvoice(id: string, body: J = {}, options: Go = {}): Promise<J> {
  return (await fx.go('POST', '/v1/sales/invoices/{id}/prints', { p: { id }, headers: fx.key(), body, status: 200, ...options })).json();
}

// These tests run serially (integration config fileParallelism=false). Any changed platform active flag is restored in finally.
describe('Sales0.9.5: idempotency, inherited immutable metadata, receipts and print-only languages', () => {
  it('migration998 — a fresh tenant without overrides resolves all four fixed platform UUIDs', async () => {
    await fx.sql(`DELETE FROM branding.print_template WHERE tenant_id = $1`, [fx.tenantId]);
    const inv = await newBill('6695.00');
    const printed = await printInvoice(inv.id);
    expect(printed).toMatchObject({ template_id: PLATFORM.invoice, template_version: 1, language: 'en', locale: 'en-IN', numerals: 'latin' });
    const est = (await fx.go('POST', '/v1/sales/estimates', { headers: fx.key(), body: { branch_id: fx.B1, customer_id: customer,
      salesperson_id: fx.staff, lines: [{ kind: 'tag', tag_id: (await fx.tag(SMALL)).id }] } })).json();
    const ep = (await fx.go('POST', '/v1/sales/estimates/{id}/prints', { p: { id: est.id }, headers: fx.key(), body: {} })).json();
    expect(ep).toMatchObject({ template_id: PLATFORM.estimate, template_version: 1 });
    const cn = (await fx.go('POST', '/v1/sales/invoices/{id}/returns', { p: { id: inv.id }, headers: fx.key(), body: {
      line_ids: [inv.lines[0].id], reason: '095 platform credit print', refund_mode: 'store_credit',
    } })).json();
    const cp = (await fx.go('POST', '/v1/sales/credit-notes/{id}/prints', { p: { id: cn.id }, headers: fx.key(), body: {} })).json();
    expect(cp).toMatchObject({ template_id: PLATFORM.credit_note, template_version: 1 });
    const partial = await newBill(), receipt = await receive(partial.id);
    expect(await printReceipt(partial.id, receipt.id)).toMatchObject({ template_id: PLATFORM.receipt, template_version: 1 });
    const rows = (await fx.go('GET', '/v1/print-templates')).json() as J[];
    for (const [doc_type, id] of Object.entries(PLATFORM)) expect(rows).toContainEqual(expect.objectContaining({ id, doc_type, version: 1, scope: 'platform', read_only: true, renderable: true }));
    // B-2 0.9.6: the shared RELEASE_PRINT_PINS constant is exactly the 998 platform rows
    const db = await fx.sql<J>(`SELECT doc_type, id AS template_id, version, engine, body_key FROM branding.print_template WHERE id = ANY($1::uuid[]) ORDER BY body_key`, [Object.values(PLATFORM)]);
    expect(db).toEqual([...RELEASE_PRINT_PINS].map((p) => ({ ...p })).sort((a, b) => a.body_key.localeCompare(b.body_key)));
    expect(Object.fromEntries(RELEASE_PRINT_PINS.map((p) => [p.doc_type, p.template_id]))).toEqual(PLATFORM);
  });

  it('QA IDEM-3 — all required Sales keys return400 with zero document/number/key/stock writes; changed-payload reuse stays422', async () => {
    const inv = await newBill(), receipt = await receive(inv.id), tag = await fx.tag(SMALL);
    const body = { branch_id: fx.B1, salesperson_id: fx.staff, customer_id: customer, lines: [{ kind: 'tag', tag_id: tag.id }] };
    const state = () => fx.sql(`SELECT
      (SELECT count(*) FROM sales.invoice) AS invoices, (SELECT count(*) FROM sales.payment_receipt) AS receipts,
      (SELECT count(*) FROM sales.credit_note) AS notes, (SELECT count(*) FROM sales.estimate) AS estimates,
      (SELECT count(*) FROM sales.document_print) AS prints, (SELECT count(*) FROM inventory.stock_ledger) AS ledger,
      (SELECT count(*) FROM platform.idempotency_key) AS keys,
      (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.branch_id,s.doc_type,s.fy) FROM sales.doc_series s) AS series,
      (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.branch_id,c.doc_type,c.fy) FROM platform.doc_counter c) AS counters,
      (SELECT jsonb_agg(to_jsonb(d) ORDER BY d.invoice_id) FROM sales.invoice_due d) AS dues,
      (SELECT jsonb_agg(jsonb_build_array(t.id,t.status) ORDER BY t.id) FROM inventory.tag t) AS tags`);
    const before = await state();
    for (const path of ['/v1/sales/invoices', '/v1/sales/invoices/{id}/payments',
      '/v1/sales/invoices/{id}/payments/{receipt_id}/reversal', RECEIPT_PRINT,
      '/v1/sales/invoices/{id}/cancellation', '/v1/sales/invoices/{id}/returns', '/v1/sales/invoices/{id}/prints',
      '/v1/sales/estimates', '/v1/sales/estimates/{id}/prints', '/v1/sales/credit-notes/{id}/prints']) {
      for (const headers of [{}, { 'idempotency-key': '' }]) {
        const r = await fx.go('POST', path, { p: { id: inv.id, receipt_id: receipt.id }, headers, body, status: 400 });
        expect(r.json().code).toBe('idempotency_key_required');
      }
    }
    expect((await fx.go('POST', '/v1/sales/invoices', { body, headers: { 'idempotency-key': 'bad' }, status: 422 })).json().code).toBe('idempotency_key_invalid');
    expect(await state()).toEqual(before);
    const headers = fx.key();
    const created = (await fx.go('POST', '/v1/sales/invoices', { body, headers, status: 201 })).json();
    expect((await fx.go('POST', '/v1/sales/invoices', { body, headers, status: 200 })).json().id).toBe(created.id);
    const after = await state();
    expect((await fx.go('POST', '/v1/sales/invoices', { body: { ...body, bill_discount: '1.00' }, headers, status: 422 })).json().code).toBe('idempotency_key_reused');
    expect(await state()).toEqual(after);
  });

  it('QA IDEM-3 — required non-Sales route keys also return400 before body/precondition parsing',async()=>{
    const id=(await newBill()).id;
    for(const path of ['/v1/inventory/lots','/v1/inventory/tags','/v1/inventory/tags/bulk','/v1/inventory/labels',
      '/v1/inventory/loose-stock/receipts','/v1/inventory/moves','/v1/inventory/transfers','/v1/inventory/transfers/{id}/dispatch',
      '/v1/inventory/transfers/{id}/receive','/v1/inventory/stock-checks','/v1/inventory/adjustments','/v1/rates/batch',
      '/v1/settings/gst-config/{id}/replace','/v1/settings/tax-rules/{id}/replace','/v1/imports/{id}/commit']) {
      expect((await fx.go('POST',path,{p:{id},body:{},headers:{},status:400})).json()).toMatchObject({status:400,code:'idempotency_key_required'});
    }
  });

  it('S19 #2 / B-2 0.9.6 — tenant > own-partner > platform precedence still resolves, but only release pins print; custom create/activate 422; foreign owners never resolve', async () => {
    const [{ id: own }] = await fx.sql<J>(`INSERT INTO platform.partner(slug,legal_name) VALUES ($1,'095 own partner') RETURNING id`, [`p095-${fx.tenantId}`]);
    const [{ id: other }] = await fx.sql<J>(`INSERT INTO platform.partner(slug,legal_name) VALUES ($1,'095 foreign partner') RETURNING id`, [`p095-other-${fx.tenantId}`]);
    // Set partner context in its OWN statement before RLS plans/scans the UPDATE. A set_config CTE is not an ordering guarantee.
    const partnerInsert = async (partnerId: string, version: number, active: boolean) => (await withTenantTx(mig,
      {tenantId:fx.tenantId,partnerId},c=>c.query<J>(
      `INSERT INTO branding.print_template(scope,partner_id,doc_type,version,body_key,is_active,print_language,numeral_system)
       VALUES ('partner',$1,'invoice',$2,'tpl/platform/invoice.hbs',$3,'ta','tamil') RETURNING id,row_version`,[partnerId,version,active]))).rows;
    const partnerActive = async (partnerId: string, id: string, active: boolean) => {
      const updated=await withTenantTx(mig,{tenantId:fx.tenantId,partnerId},c=>c.query(
        `UPDATE branding.print_template SET is_active=$2 WHERE id=$1 RETURNING id`,[id,active]));
      expect(updated.rowCount,'fixture must actually activate/deactivate one partner template').toBe(1);
    };
    await fx.sql(`UPDATE platform.tenant SET partner_id=$2 WHERE id=$1`, [fx.tenantId,own]);
    const [partner] = await partnerInsert(own,1,true), [foreign] = await partnerInsert(other,1,true);
    const tenantCount = async () => (await fx.sql<J>(`SELECT count(*)::int AS n FROM branding.print_template WHERE tenant_id=$1`,[fx.tenantId]))[0].n;
    const n0 = await tenantCount();
    // API create is refused before any write — even with an allowed body_key (a new row is a new uuid, never a release pin)
    expect((await fx.go('POST', '/v1/print-templates', { body: { doc_type: 'invoice', body_key: 'tpl/platform/invoice.hbs', print_language: 'en', numeral_system: 'latin' }, status: 422 })).json())
      .toMatchObject({ code: 'print_template_not_renderable' });
    expect(await tenantCount()).toBe(n0);
    // fixture SQL: an allowed body_key under the tenant's own uuid; API activation is still 422 and leaves it inactive
    const [tenant] = await fx.sql<J>(`INSERT INTO branding.print_template(scope,tenant_id,doc_type,version,paper,body_key,engine,print_language,numeral_system,is_active)
      SELECT 'tenant',$1,'invoice',coalesce(max(version),0)+1,'A4','tpl/platform/invoice.hbs','handlebars','en','latin',false FROM branding.print_template WHERE tenant_id=$1 AND doc_type='invoice'
      RETURNING id,version,row_version`,[fx.tenantId]);
    expect((await fx.go('POST','/v1/print-templates/{id}/activate',{p:{id:tenant.id},headers:fx.im(tenant.row_version),status:422})).json()).toMatchObject({code:'print_template_not_renderable'});
    expect((await fx.go('GET','/v1/print-templates/{id}',{p:{id:tenant.id}})).json()).toMatchObject({scope:'tenant',is_active:false,renderable:false,body_key:'tpl/platform/invoice.hbs'});
    const globalRows = await fx.sql<J>(`SELECT id,is_active FROM branding.print_template WHERE scope='platform' AND doc_type='invoice'`);
    const globalV1 = (await fx.go('GET','/v1/print-templates/{id}',{p:{id:PLATFORM.invoice}})).json();
    expect(globalV1).toMatchObject({version:1,scope:'platform',read_only:true,is_active:true,renderable:true});
    expect((await fx.go('GET','/v1/print-templates/{id}',{p:{id:PLATFORM.invoice},cookie:fx.sales})).json()).toMatchObject({scope:'platform',read_only:true});
    await fx.go('GET','/v1/print-templates/{id}',{p:{id:'not-a-uuid'},status:400});
    await fx.go('GET','/v1/print-templates/{id}',{p:{id:PLATFORM.invoice},cookie:'',status:401});
    await fx.go('GET','/v1/print-templates',{q:{doc_type:'not-a-doc-type'},status:422});
    // 0.9.6 1(a): the precedence winner is named by template_fallback_from — it is skipped (not a release pin) and the print
    // succeeds on the platform default v1: exactly one document_print row + the print audit + one fallback audit.
    const refused = async (template_id: string, template_version: number) => {
      const inv = await newBill('6695.00');
      const pr = await printInvoice(inv.id);
      expect(pr).toMatchObject({ print_no: 1, copy: 'original', template_id: PLATFORM.invoice, template_version: 1, template_fallback_from: { template_id, template_version },
        template_repinned: false, repinned_from: null });
      expect(validateAt('#/components/schemas/SalesPrintDocument', pr).ok).toBe(true);
      expect(await fx.sql(`SELECT print_no,template_id,template_version FROM sales.document_print WHERE doc_id=$1`,[inv.id])).toEqual([{print_no:1,template_id:PLATFORM.invoice,template_version:1}]);
      const audits = await fx.sql<J>(`SELECT action,new_row FROM platform.audit_event WHERE row_id=$1 AND action LIKE 'sales.invoice.print%' ORDER BY seq`,[inv.id]);
      expect(audits.map(a=>a.action)).toEqual(['sales.invoice.print','sales.invoice.print_template_fallback']);
      expect(audits[0].new_row).toMatchObject({ print_no: 1, template_id: PLATFORM.invoice, template_version: 1, template_fallback_from: { template_id, template_version } });
      expect(audits[1].new_row).toMatchObject({ doc_no: pr.doc_no, print_no: 1, from: { template_id, template_version }, to: { template_id: PLATFORM.invoice, template_version: 1 } });
      return inv;
    };
    try {
      await fx.sql(`UPDATE branding.print_template SET is_active=true WHERE id=$1`,[tenant.id]);
      const first = await refused(tenant.id, tenant.version);                      // tenant wins
      expect((await fx.go('GET','/v1/sales/settings')).json()).toMatchObject({print_language:'en',print_numerals:'latin'});
      await fx.sql(`UPDATE branding.print_template SET is_active=false WHERE id=$1`,[tenant.id]);
      await refused(partner.id, 1);                                                 // then own partner (never the foreign one)
      // settings follow the EFFECTIVE template: the partner ta/tamil row is skipped too, so the platform default's en/latin apply
      expect((await fx.go('GET','/v1/sales/settings')).json()).toMatchObject({print_language:'en',print_numerals:'latin'});
      await partnerActive(own,partner.id,false);
      // platform default in effect: no fallback; a reprint of a fallback print keeps its ORIGINAL (platform) pin and is not a fallback
      const plain = await newBill('6695.00');
      expect(await printInvoice(plain.id)).toMatchObject({template_id:PLATFORM.invoice,template_version:1,print_no:1,copy:'original',template_fallback_from:null,template_repinned:false,repinned_from:null});
      expect(await printInvoice(first.id,{reprint_reason:'fallback pin kept'})).toMatchObject({template_id:PLATFORM.invoice,template_version:1,print_no:2,copy:'duplicate',template_fallback_from:null,template_repinned:false,repinned_from:null});
      // A higher PARTNER version cannot outrank tenant v1. Each field must come from the same winning row.
      const [partner9] = await partnerInsert(own,9,true);
      await fx.sql(`UPDATE branding.print_template SET is_active=true WHERE id=$1`,[tenant.id]);
      await refused(tenant.id, tenant.version);
      await fx.sql(`UPDATE branding.print_template SET is_active=false WHERE id=$1`,[tenant.id]);
      await refused(partner9.id, 9);
      const rows = (await fx.go('GET','/v1/print-templates',{q:{doc_type:'invoice'}})).json() as J[];
      expect(rows.every(r=>r.doc_type==='invoice')).toBe(true);
      expect(rows.map(r=>r.id)).toEqual(expect.arrayContaining([tenant.id,partner.id,partner9.id,PLATFORM.invoice]));
      expect(rows.filter(r=>r.renderable).map(r=>r.id)).toEqual([PLATFORM.invoice]);
      expect(rows.some(r=>r.id===foreign.id)).toBe(false);
      for(const id of [partner.id,partner9.id,PLATFORM.invoice]) {
        const meta=(await fx.go('GET','/v1/print-templates/{id}',{p:{id}})).json();
        expect(meta.read_only).toBe(true);
        expect((await fx.go('POST','/v1/print-templates/{id}/activate',{p:{id},headers:fx.im(meta.row_version),status:404})).json().code).toBe('not_found');
      }
      expect((await fx.go('GET','/v1/print-templates/{id}',{p:{id:partner.id}})).json()).toMatchObject({version:1,is_active:false});
      const foreignTenant=(await fx.sql<J>(`SELECT id FROM branding.print_template WHERE tenant_id='00000000-0000-0000-0000-000000000001' AND doc_type='invoice' LIMIT 1`))[0];
      // Migrator's tenant RLS intentionally hides the other tenant too; use the seeded known row via a separate tenant context, never change app identity.
      expect(foreignTenant).toBeUndefined();
      const otherRows=await withTenantTx(rw,{tenantId:'00000000-0000-0000-0000-000000000001'},c=>c.query(`SELECT id FROM branding.print_template WHERE scope='tenant' AND doc_type='invoice' LIMIT 1`));
      expect(otherRows.rows).toHaveLength(1);
      for(const id of [foreign.id,otherRows.rows[0].id]) {
        expect((await fx.go('GET','/v1/print-templates/{id}',{p:{id},status:404})).json().code).toBe('not_found');
        expect((await fx.go('POST','/v1/print-templates/{id}/activate',{p:{id},headers:fx.im(1),status:404})).json().code).toBe('not_found');
        expect(rows.some(r=>r.id===id)).toBe(false);
      }
      const seen=await withTenantTx(rw,{tenantId:fx.tenantId,userId:fx.ownerId},async c=>({
        tenant:(await c.query(`SELECT partner_id FROM platform.tenant WHERE id=platform.current_tenant()`)).rows[0],
        templates:(await c.query(`SELECT id FROM branding.print_template WHERE doc_type='invoice'`)).rows.map(r=>r.id),
      }));
      expect(seen.tenant.partner_id).toBe(own);
      expect(seen.templates).toEqual(expect.arrayContaining([tenant.id,partner.id,PLATFORM.invoice]));
      expect(seen.templates).not.toEqual(expect.arrayContaining([foreign.id]));
      expect(seen.templates).not.toEqual(expect.arrayContaining([otherRows.rows[0].id]));
      await partnerActive(own,partner9.id,false);
      await fx.sql(`UPDATE branding.print_template SET is_active=false WHERE scope='platform' AND doc_type='invoice'`);
      const noTemplate=await newBill('6695.00');
      expect(await printInvoice(noTemplate.id,{}, {status:422})).toMatchObject({code:'print_template_not_configured'});
      expect(await fx.sql(`SELECT print_no FROM sales.document_print WHERE doc_id=$1`,[noTemplate.id])).toEqual([]);
    } finally {
      await fx.sql(`UPDATE branding.print_template SET is_active=false WHERE scope='platform' AND doc_type='invoice'`);
      await fx.sql(`UPDATE branding.print_template SET is_active=true WHERE id=ANY($1::uuid[])`,[globalRows.filter(r=>r.is_active).map(r=>r.id)]);
      await fx.sql(`UPDATE platform.tenant SET partner_id=NULL WHERE id=$1`,[fx.tenantId]);
      // Keep rows (FK-pinned history may reference them), but leave them inactive; no global rows are created/deleted.
      await fx.sql(`UPDATE branding.print_template SET is_active=false WHERE tenant_id=$1 AND doc_type='invoice'`,[fx.tenantId]);
      await withTenantTx(mig,{tenantId:fx.tenantId,partnerId:own},c=>c.query(`UPDATE branding.print_template SET is_active=false WHERE partner_id=$1 AND doc_type='invoice'`,[own]));
    }
  },120000);

  it('receipt prints — ORIGINAL then reasoned DUPLICATE; first-copy precedence, permissions and frozen template/snapshot survive later edits', async () => {
    const inv=await newBill('1000.00',2), receipt=await receive(inv.id);
    expect(await printReceipt(inv.id,receipt.id,{copy:'duplicate'},{status:422})).toMatchObject({code:'first_print_duplicate_not_supported'});
    expect(await printReceipt(inv.id,receipt.id,{copy:'duplicate',reprint_reason:'requested duplicate'},{cookie:fx.sales,status:403})).toMatchObject({code:'reprint_not_allowed'});
    const first=await printReceipt(inv.id,receipt.id);
    expect(first).toMatchObject({doc_type:'payment_receipt',copy:'original',print_no:1,doc_cancelled:false,stamp:null,template_id:PLATFORM.receipt,template_version:1});
    expect(first.snapshot).toMatchObject({receipt_no:receipt.receipt_no,received_on:receipt.received_on,invoice_id:inv.id,invoice_no:inv.doc_no,
      invoice_date:inv.doc_date,customer:inv.customer,seller:inv.seller,total:'1000.00',adjusted_balance_due_at_issue:'11390.00',kind:'collection'});
    expect(first.snapshot.tenders).toHaveLength(1);
    expect(first.snapshot).not.toHaveProperty('adjusted_balance_due_after');
    expect(first.amount_in_words).toContain('Thousand');
    expect(await printReceipt(inv.id,receipt.id,{}, {status:422})).toMatchObject({code:'reprint_reason_required'});
    // 0.9.6: custom templates cannot be created/activated via the API; a fixture-SQL active tenant receipt template must not move the pin
    expect((await fx.go('POST','/v1/print-templates',{body:{doc_type:'receipt',body_key:'tpl/platform/receipt.hbs',print_language:'ta',numeral_system:'tamil'},status:422})).json().code).toBe('print_template_not_renderable');
    const [next]=await fx.sql<J>(`INSERT INTO branding.print_template(scope,tenant_id,doc_type,version,paper,body_key,print_language,numeral_system,is_active)
      SELECT 'tenant',$1,'receipt',coalesce(max(version),0)+1,'A4','tpl/095/new-receipt.hbs','ta','tamil',true FROM branding.print_template WHERE tenant_id=$1 AND doc_type='receipt' RETURNING id`,[fx.tenantId]);
    try {
    await receive(inv.id,'500.00');
    await fx.go('POST','/v1/sales/invoices/{id}/returns',{p:{id:inv.id},headers:fx.key(),body:{line_ids:[inv.lines[0].id],reason:'095 later return',refund_mode:'store_credit'}});
    await fx.sql(`UPDATE masters.customer SET name='Changed after receipt' WHERE id=$1`,[customer]);
    await fx.sql(`UPDATE platform.company SET legal_name='Changed after receipt' WHERE tenant_id=$1`,[fx.tenantId]);
    const duplicate=await printReceipt(inv.id,receipt.id,{copy:'duplicate',reprint_reason:'095 duplicate after return'});
    expect(duplicate).toMatchObject({copy:'duplicate',print_no:2,template_id:first.template_id,template_version:first.template_version,locale:first.locale,numerals:first.numerals,template_repinned:false,repinned_from:null});
    expect(next.id).not.toBe(duplicate.template_id);
    expect(duplicate.snapshot).toEqual(first.snapshot); expect(duplicate.amount_in_words).toBe(first.amount_in_words);
    expect(duplicate.document.adjusted_balance_due_after).not.toBe(first.snapshot.adjusted_balance_due_at_issue);
    await reverse(inv.id,receipt.id);
    const reversed=await printReceipt(inv.id,receipt.id,{reprint_reason:'095 reversed collection history'});
    expect(reversed).toMatchObject({copy:'duplicate',print_no:3,stamp:'REVERSED',doc_cancelled:false,snapshot:first.snapshot});
    expect(await fx.sql(`SELECT print_no,copy,doc_cancelled FROM sales.document_print WHERE doc_type='payment_receipt' AND doc_id=$1 ORDER BY print_no`,[receipt.id])).toEqual([
      {print_no:1,copy:'original',doc_cancelled:false},{print_no:2,copy:'duplicate',doc_cancelled:false},{print_no:3,copy:'duplicate',doc_cancelled:false},
    ]);
    } finally { await fx.sql(`UPDATE branding.print_template SET is_active=false WHERE id=$1`,[next.id]); }
  });

  it('receipt first printed late — issue-time balance and parties come from immutable audits/snapshots, not current adjusted dues or masters',async()=>{
    const inv=await newBill('1000.00',2), receipt=await receive(inv.id);
    const returned=(await fx.go('POST','/v1/sales/invoices/{id}/returns',{p:{id:inv.id},headers:fx.key(),body:{line_ids:[inv.lines[0].id],reason:'return before first receipt print',refund_mode:'store_credit'}})).json();
    expect(returned).toMatchObject({total:'6695.00',due_reduced:'4695.00',store_credit_amount:'2000.00'});
    await fx.sql(`UPDATE masters.customer SET name='Another later buyer name' WHERE id=$1`,[customer]);
    await fx.sql(`UPDATE platform.company SET legal_name='Another later seller name' WHERE tenant_id=$1`,[fx.tenantId]);
    const first=await printReceipt(inv.id,receipt.id);
    expect(first.snapshot).toMatchObject({adjusted_balance_due_at_issue:'11390.00',customer:inv.customer,seller:inv.seller});
    expect(first.document.adjusted_balance_due_after).toBe('6695.00'); // paid2000 becomes store credit; only4695 of the return reduces the due
    expect(first.snapshot.customer.name).not.toBe('Another later buyer name');
    expect(first.snapshot.seller.legal_name).not.toBe('Another later seller name');
  });

  it('receipt reversal printing — reversed-before-first still ORIGINAL+REVERSED; negative reversal prints itself ORIGINAL+REVERSAL with absolute words', async () => {
    const inv=await newBill(), receipt=await receive(inv.id), reversal=await reverse(inv.id,receipt.id);
    expect(await printReceipt(inv.id,receipt.id)).toMatchObject({copy:'original',print_no:1,stamp:'REVERSED',doc_cancelled:false});
    expect(await printReceipt(inv.id,reversal.reversal.id,{copy:'duplicate'},{status:422})).toMatchObject({code:'first_print_duplicate_not_supported'});
    const negative=await printReceipt(inv.id,reversal.reversal.id,{language:'en'});
    expect(negative).toMatchObject({copy:'original',stamp:'REVERSAL',doc_cancelled:false,snapshot:{kind:'reversal',total:'-1000.00',tenders:[],reverses_receipt_id:receipt.id,adjusted_balance_due_at_issue:'5695.00'}});
    expect(negative.amount_in_words).toContain('Thousand'); expect(negative.amount_in_words).not.toMatch(/minus|negative/i);
    expect(negative.notes.join(' ')).toContain('no collection');
    expect(await printReceipt(inv.id,reversal.reversal.id,{reprint_reason:'095 reversal duplicate'})).toMatchObject({copy:'duplicate',print_no:2,stamp:'REVERSAL',snapshot:negative.snapshot});
    expect(await printReceipt(inv.id,reversal.reversal.id,{}, {cookie:fx.cashier,status:422})).toMatchObject({code:'reprint_reason_required'});
    const wrongParent=await newBill();
    expect(await printReceipt(wrongParent.id,receipt.id,{}, {status:404})).toMatchObject({code:'not_found'});
  });

  it.each(['en','ta','hi','te','kn','ml','zz'])('print setting/override boundary — %s, UI language unaffected',async language=>{
    const valid=['en','ta'].includes(language);
    // 0.9.6: body validation keeps precedence (validation_failed); a valid custom template is then print_template_not_renderable
    const response=await fx.go('POST','/v1/print-templates',{body:{doc_type:'receipt',body_key:'tpl/095/language.hbs',print_language:language},status:422});
    expect(response.json().code).toBe(valid?'print_template_not_renderable':'validation_failed');
    const inv=await newBill('6695.00');
    const print=await printInvoice(inv.id,{language},{status:valid?200:422});
    if(valid) expect(print).toMatchObject({language,locale:`${language}-IN`});
    else {
      expect(print.code).toBe('validation_failed');
      const settings=await fx.go('GET','/v1/sales/settings');
      expect((await fx.go('PATCH','/v1/sales/settings',{headers:{'if-match':settings.headers.etag as string},body:{print_language:language},status:422})).json().code).toBe('validation_failed');
      expect(await fx.sql(`SELECT print_no FROM sales.document_print WHERE doc_id=$1`,[inv.id])).toEqual([]);
    }
  });

  it.each(['hi','te','kn','ml','en-IN'])('legacy print-language backstop — %s cannot enter/activate or print; an active legacy row is skipped (1(a) platform fallback)',async language=>{
    if(language==='en-IN') {
      // 950's FK prevents this locale from ever becoming legacy print metadata; do not change the global language catalogue to fake it.
      await expect(fx.sql(`INSERT INTO branding.print_template(scope,tenant_id,doc_type,version,body_key,print_language)
        VALUES ('tenant',$1,'receipt',999,'tpl/095/invalid-locale.hbs',$2)`,[fx.tenantId,language])).rejects.toMatchObject({code:'23503'});
      expect((await fx.go('POST','/v1/print-templates',{body:{doc_type:'receipt',body_key:'tpl/095/invalid-locale.hbs',print_language:language},status:422})).json().code).toBe('validation_failed');
      const inv=await newBill('6695.00');
      expect(await printInvoice(inv.id,{language},{status:422})).toMatchObject({code:'validation_failed'});
      expect(await fx.sql(`SELECT print_no FROM sales.document_print WHERE doc_id=$1`,[inv.id])).toEqual([]);
      return;
    }
    const [legacy]=await fx.sql<J>(`INSERT INTO branding.print_template(scope,tenant_id,doc_type,version,body_key,print_language,is_active)
      SELECT 'tenant',$1,'invoice',coalesce(max(version),0)+1,'tpl/095/legacy.hbs',$2,true FROM branding.print_template WHERE tenant_id=$1 AND doc_type='invoice'
      RETURNING id,row_version`,[fx.tenantId,language]);
    try {
      expect((await fx.go('POST','/v1/print-templates/{id}/activate',{p:{id:legacy.id},headers:fx.im(legacy.row_version),status:422})).json().code).toBe('validation_failed');
      // 0.9.6 1(a): the active legacy row is not a release pin, so the resolver SKIPS it (named in template_fallback_from + audit) and the
      // platform default (en/latin) applies to settings and prints. The legacy language itself is never used and never enters via API.
      expect((await fx.go('GET','/v1/sales/settings')).json()).toMatchObject({print_language:'en',print_numerals:'latin'});
      const inv=await newBill('6695.00');
      expect(await printInvoice(inv.id)).toMatchObject({language:'en',template_id:PLATFORM.invoice,template_version:1,template_fallback_from:{template_id:legacy.id}});
      expect(await fx.sql(`SELECT print_no,language FROM sales.document_print WHERE doc_id=$1`,[inv.id])).toEqual([{print_no:1,language:'en'}]);
      expect(await printInvoice((await newBill('6695.00')).id,{language},{status:422})).toMatchObject({code:'validation_failed'}); // explicit legacy override still refused
    } finally { await fx.sql(`UPDATE branding.print_template SET is_active=false WHERE id=$1`,[legacy.id]); }
  });

  // ---------------- B-2 (0.9.6): only the exact 998 platform pins are release-renderable ----------------
  type B2Doc = { path: string; p: Record<string, string>; id: string };
  const B2_TPL: Record<string, string> = { invoice: 'invoice', credit_note: 'credit_note', payment_receipt: 'receipt', estimate: 'estimate' };
  async function b2Doc(docType: string): Promise<B2Doc> {
    if (docType === 'invoice') { const inv = await newBill(); return { path: '/v1/sales/invoices/{id}/prints', p: { id: inv.id }, id: inv.id }; }
    if (docType === 'credit_note') {
      const inv = await newBill();
      const cn = (await fx.go('POST', '/v1/sales/invoices/{id}/returns', { p: { id: inv.id }, headers: fx.key(), body: { line_ids: [inv.lines[0].id], reason: 'B-2 credit note', refund_mode: 'store_credit' } })).json();
      return { path: '/v1/sales/credit-notes/{id}/prints', p: { id: cn.id }, id: cn.id };
    }
    if (docType === 'payment_receipt') { const inv = await newBill(), rc = await receive(inv.id); return { path: RECEIPT_PRINT, p: { id: inv.id, receipt_id: rc.id }, id: rc.id }; }
    const est = (await fx.go('POST', '/v1/sales/estimates', { headers: fx.key(), body: { branch_id: fx.B1, customer_id: customer, salesperson_id: fx.staff,
      lines: [{ kind: 'tag', tag_id: (await fx.tag(SMALL)).id }] } })).json();
    return { path: '/v1/sales/estimates/{id}/prints', p: { id: est.id }, id: est.id };
  }
  /** Fixture SQL only (the API refuses): a tenant template with the ALLOWED body_key but its own uuid — still not a release pin. */
  const b2Template = async (tplDoc: string, active: boolean) => (await fx.sql<J>(`INSERT INTO branding.print_template(scope,tenant_id,doc_type,version,paper,body_key,engine,is_active)
    SELECT 'tenant',$1,$2,coalesce(max(version),0)+1,'A4','tpl/platform/'||$2||'.hbs','handlebars',$3 FROM branding.print_template WHERE tenant_id=$1 AND doc_type=$2
    RETURNING id,version`, [fx.tenantId, tplDoc, active]))[0];
  const b2Rows = (id: string) => fx.sql<J>(`SELECT print_no, copy, template_id, template_version FROM sales.document_print WHERE doc_id=$1 ORDER BY print_no`, [id]);
  const b2Audit = (id: string, like: string) => fx.sql<J>(`SELECT action, new_row FROM platform.audit_event WHERE row_id=$1 AND action LIKE $2 ORDER BY seq`, [id, like]);

  it.each(['invoice', 'credit_note', 'payment_receipt', 'estimate'])('1(a) 0.9.6 — %s first print with an ACTIVE non-renderable tenant template (allowed body_key, own uuid) falls back to the platform default v1: exactly one row, fallback audit; a reprint keeps that pin', async (docType) => {
    const tplDoc = B2_TPL[docType], doc = await b2Doc(docType), platform = PLATFORM[tplDoc as keyof typeof PLATFORM];
    const bad = await b2Template(tplDoc, true);
    const from = { template_id: bad.id, template_version: bad.version };
    try {
      const r = (await fx.go('POST', doc.path, { p: doc.p, headers: fx.key(), body: {}, status: 200 })).json();
      expect(r).toMatchObject({ print_no: 1, copy: 'original', template_id: platform, template_version: 1, template_fallback_from: from, template_repinned: false, repinned_from: null });
      expect(validateAt('#/components/schemas/SalesPrintDocument', r).ok).toBe(true);
      expect(await b2Rows(doc.id)).toEqual([{ print_no: 1, copy: 'original', template_id: platform, template_version: 1 }]);
      const fb = await b2Audit(doc.id, `sales.${docType}.print_template_fallback`);
      expect(fb.map((x) => x.new_row)).toEqual([expect.objectContaining({ doc_no: r.doc_no, print_no: 1, from, to: { template_id: platform, template_version: 1 } })]);
      expect((await b2Audit(doc.id, `sales.${docType}.print`)).map((x) => x.new_row.template_fallback_from)).toEqual([from]);
      // the custom row is still active: a reprint keeps the ORIGINAL (platform) pin and is not another fallback
      const dup = (await fx.go('POST', doc.path, { p: doc.p, headers: fx.key(), body: { copy: 'duplicate', reprint_reason: '1(a) reprint keeps pin' }, status: 200 })).json();
      expect(dup).toMatchObject({ print_no: 2, copy: 'duplicate', template_id: platform, template_version: 1, template_fallback_from: null, template_repinned: false, repinned_from: null });
      expect(dup.snapshot).toEqual(r.snapshot);
      expect(validateAt('#/components/schemas/SalesPrintDocument', dup).ok).toBe(true);
      expect((await b2Rows(doc.id)).map((x) => [x.print_no, x.template_id, x.template_version])).toEqual([[1, platform, 1], [2, platform, 1]]);
      expect(await b2Audit(doc.id, `sales.${docType}.print_template_fallback`)).toHaveLength(1);
      expect(await b2Audit(doc.id, `sales.${docType}.print_template_repinned`)).toEqual([]);
    } finally { await fx.sql(`UPDATE branding.print_template SET is_active=false WHERE id=$1`, [bad.id]); }
  });

  it('1(a) 0.9.6 — no renderable fallback (platform default inactive): 422 print_template_not_renderable, 0 rows / 0 audit; restored platform default then prints ORIGINAL 1', async () => {
    const doc = await b2Doc('invoice'), bad = await b2Template('invoice', true);
    const mig = pool('app_migrator');
    const platformActive = async (on: boolean) => expect((await mig.query(`UPDATE branding.print_template SET is_active=$2 WHERE id=$1 AND scope='platform'`, [PLATFORM.invoice, on])).rowCount).toBe(1);
    try {
      await platformActive(false);
      const r = (await fx.go('POST', '/v1/sales/invoices/{id}/prints', { p: { id: doc.id }, headers: fx.key(), body: {}, status: 422 })).json();
      expect(r).toMatchObject({ code: 'print_template_not_renderable', unrenderable_template: { template_id: bad.id, template_version: bad.version } });
      expect(validateAt('#/components/schemas/SalesUnprocessableProblem', r).ok).toBe(true);
      expect(await b2Rows(doc.id)).toEqual([]);
      expect(await b2Audit(doc.id, 'sales.invoice.print%')).toEqual([]);
    } finally { await platformActive(true); await fx.sql(`UPDATE branding.print_template SET is_active=false WHERE id=$1`, [bad.id]); await mig.end(); }
    expect(await printInvoice(doc.id)).toMatchObject({ print_no: 1, copy: 'original', template_id: PLATFORM.invoice, template_version: 1, template_fallback_from: null });
  });

  it.each(['invoice', 'credit_note', 'payment_receipt'])('B-2 0.9.6 recovery — %s whose ORIGINAL is pinned to a non-renderable template: plain reprint 422 + recovery hint; explicit duplicate re-pins to the platform default with audit; snapshot frozen', async (docType) => {
    const tplDoc = B2_TPL[docType], doc = await b2Doc(docType), platform = PLATFORM[tplDoc as keyof typeof PLATFORM];
    const bad = await b2Template(tplDoc, false);
    // a pre-0.9.6 ORIGINAL pinned to that template (append-only history, as QA B-2 observed live)
    await withTenantTx(rw, { tenantId: fx.tenantId, userId: fx.ownerId }, () => withModuleRole('sales_writer', (c) => c.query(
      `INSERT INTO sales.document_print(tenant_id, branch_id, doc_type, doc_id, print_no, copy, paper, reprint_reason, printed_by, doc_cancelled, template_id, template_version)
       VALUES (platform.current_tenant(), $1, $2, $3, 1, 'original', 'A4', NULL, $4, false, $5, $6)`, [fx.B1, docType, doc.id, fx.ownerId, bad.id, bad.version])));
    const go = (body: J, o: Go = {}) => fx.go('POST', doc.path, { p: doc.p, headers: fx.key(), body, ...o });
    const plain = (await go({ reprint_reason: 'B-2 plain reprint' }, { status: 422 })).json();
    expect(plain).toMatchObject({ code: 'pinned_print_template_unavailable', unrenderable_template: { template_id: bad.id, template_version: bad.version },
      recovery: { copy: 'duplicate', reprint_reason_required: true, permission: 'sales.invoice.reprint', repin_to: { template_id: platform, template_version: 1 } } });
    expect(plain.errors[0]).toMatchObject({ path: 'copy', code: 'print_template_not_renderable' });
    expect(validateAt('#/components/schemas/SalesUnprocessableProblem', plain).ok).toBe(true);
    expect((await go({ copy: 'duplicate' }, { status: 422 })).json().code).toBe('reprint_reason_required');                   // existing precedence
    expect((await go({ copy: 'duplicate', reprint_reason: 'B-2 recovery' }, { cookie: fx.sales, status: 403 })).json().code).toBe('reprint_not_allowed');
    expect(await b2Rows(doc.id)).toHaveLength(1);
    const rec = (await go({ copy: 'duplicate', reprint_reason: 'B-2 recovery copy' }, { status: 200 })).json();
    expect(rec).toMatchObject({ copy: 'duplicate', stamp: 'DUPLICATE', print_no: 2, template_id: platform, template_version: 1,
      template_repinned: true, repinned_from: { template_id: bad.id, template_version: bad.version } });
    expect(validateAt('#/components/schemas/SalesPrintDocument', rec).ok).toBe(true);
    const again = (await go({ copy: 'duplicate', reprint_reason: 'B-2 second recovery copy' }, { status: 200 })).json();
    expect(again).toMatchObject({ print_no: 3, template_id: platform, template_repinned: true, repinned_from: { template_id: bad.id } });
    expect(again.snapshot).toEqual(rec.snapshot); expect(again.amount_in_words).toBe(rec.amount_in_words);
    expect(await b2Rows(doc.id)).toEqual([
      { print_no: 1, copy: 'original', template_id: bad.id, template_version: bad.version },
      { print_no: 2, copy: 'duplicate', template_id: platform, template_version: 1 },
      { print_no: 3, copy: 'duplicate', template_id: platform, template_version: 1 }]);
    const repins = await b2Audit(doc.id, `sales.${docType}.print_template_repinned`);
    expect(repins.map((r) => r.new_row)).toEqual([
      expect.objectContaining({ print_no: 2, reason: 'B-2 recovery copy', from: { template_id: bad.id, template_version: bad.version }, to: { template_id: platform, template_version: 1 } }),
      expect.objectContaining({ print_no: 3, reason: 'B-2 second recovery copy' })]);
    const prints = await b2Audit(doc.id, `sales.${docType}.print`);
    expect(prints.map((r) => [r.new_row.print_no, r.new_row.template_repinned, r.new_row.template_id])).toEqual([[2, true, platform], [3, true, platform]]);
  });

  it('B-2 0.9.6 — a renderable pin is never re-pinned, even by an explicit duplicate while a non-renderable template is active', async () => {
    const doc = await b2Doc('invoice');
    const first = await printInvoice(doc.id);
    expect(first).toMatchObject({ template_id: PLATFORM.invoice, template_version: 1, template_repinned: false, repinned_from: null });
    const bad = await b2Template('invoice', true);
    try {
      for (const body of [{ reprint_reason: 'B-2 good pin copy' }, { copy: 'duplicate', reprint_reason: 'B-2 good pin explicit copy' }]) {
        const r = await printInvoice(doc.id, body);
        expect(r).toMatchObject({ copy: 'duplicate', template_id: PLATFORM.invoice, template_version: 1, template_repinned: false, repinned_from: null, snapshot: first.snapshot });
      }
    } finally { await fx.sql(`UPDATE branding.print_template SET is_active=false WHERE id=$1`, [bad.id]); }
    expect(await b2Audit(doc.id, 'sales.invoice.print_template_repinned')).toEqual([]);
    expect((await b2Rows(doc.id)).map((r) => r.template_id)).toEqual([PLATFORM.invoice, PLATFORM.invoice, PLATFORM.invoice]);
  });

  it('INF-3 — the harness refuses to start without an explicit TEST_DB (no jw_it default); unsafe explicit targets are refused before credentials', async()=>{
    expect(process.env.TEST_DB).toBe(DB); // this run was started with an explicit TEST_DB
    const { TEST_DB_REQUIRED, UNSAFE_TARGET, resolveTestTarget } = await import('./env');
    const base = { PGHOST: '127.0.0.1', PGPORT: '55432' };
    for (const env of [{ ...base }, { ...base, TEST_DB: '' }, { ...base, TEST_DB: '  ' }]) expect(() => resolveTestTarget(env)).toThrow(TEST_DB_REQUIRED);
    for (const TEST_DB of ['jewellery', 'jewellery_test', 'postgres', 'qa_bad;DROP DATABASE x', 'QA_upper', 'jw_it2'])
      expect(() => resolveTestTarget({ ...base, TEST_DB })).toThrow(UNSAFE_TARGET);
    expect(() => resolveTestTarget({ TEST_DB: 'jw_it', PGHOST: 'other-host', PGPORT: '55432' })).toThrow(UNSAFE_TARGET);
    expect(() => resolveTestTarget({ TEST_DB: 'jw_it', PGHOST: '127.0.0.1', PGPORT: '5432' })).toThrow(UNSAFE_TARGET);
    expect(resolveTestTarget({ ...base, TEST_DB: 'jw_it' })).toEqual({ host: '127.0.0.1', port: '55432', database: 'jw_it' });
    expect(resolveTestTarget({ ...base, TEST_DB: 'qa_sales_ironhide_20261116_h1' }).database).toBe('qa_sales_ironhide_20261116_h1');
    // re-importing the harness itself with TEST_DB unset / empty fails fast, before the password file is read (it points nowhere)
    const saved = { ...process.env };
    for (const value of [undefined, '']) {
      vi.resetModules();
      process.env.TEST_ROLE_PASSWORD_FILE = '/nonexistent/inf3-must-not-be-read'; delete process.env.TEST_ROLE_PASSWORD;
      if (value === undefined) delete process.env.TEST_DB; else process.env.TEST_DB = value;
      try { await expect(import('./env')).rejects.toThrow(TEST_DB_REQUIRED); }
      finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
    }
    vi.resetModules();
    expect(process.env.TEST_DB).toBe(DB);
  },90000);

  it('QA-GATE-1 / migration998 — configured TEST_DB uses five fresh synthetic shops, no shared demo seed; unsafe targets fail before SQL', async()=>{
    expect(DB).toBe(process.env.TEST_DB);
    expect(()=>assertTestTarget(HOST,String(PORT),DB)).not.toThrow();
    for(const target of [['127.0.0.1','55432','jewellery'],['127.0.0.1','55433',DB],['other-host','55432',DB],['127.0.0.1','55432','qa_bad;DROP DATABASE x']])
      expect(()=>assertTestTarget(...target as [string,string,string])).toThrow('unsafe TEST database target');
    // No psql/demo SQL/password hashing/shared login-file operations. Ordinary fixture provisioning targets env.ts's configured database.
    for(let n=0;n<5;n++) {
      const shop=await salesFixture(`s095iso${n}`,HUID_PREFIX.sales095,{remoteAddress:`198.18.95.${n+1}`}); // RFC2544 benchmark range, synthetic
      try {
        await shop.sql(`DELETE FROM branding.print_template WHERE tenant_id=$1`,[shop.tenantId]);
        const visible=await withTenantTx(rw,{tenantId:shop.tenantId,userId:shop.ownerId},async c=>({
          database:(await c.query(`SELECT current_database() AS name`)).rows[0].name,
          own:(await c.query(`SELECT count(*)::int AS n FROM branding.print_template WHERE scope='tenant'`)).rows[0].n,
          active:(await c.query(`SELECT id,doc_type,version,scope FROM branding.print_template WHERE is_active ORDER BY doc_type`)).rows,
        }));
        expect(visible.database).toBe(DB);expect(visible.own).toBe(0);
        const rows=(await shop.go('GET','/v1/print-templates')).json() as J[];
        for(const [doc_type,id]of Object.entries(PLATFORM)) {
          expect(visible.active).toContainEqual({id,doc_type,version:1,scope:'platform'});
          expect(rows).toContainEqual(expect.objectContaining({id,doc_type,version:1,scope:'platform',read_only:true,is_active:true}));
          expect((await shop.go('GET','/v1/print-templates/{id}',{p:{id}})).json()).toMatchObject({id,doc_type,version:1,scope:'platform',read_only:true});
        }
        const customer_id=await shop.customer(),tag=await shop.tag(SMALL);
        const inv=(await shop.go('POST','/v1/sales/invoices',{headers:shop.key(),body:{branch_id:shop.B1,customer_id,salesperson_id:shop.staff,
          lines:[{kind:'tag',tag_id:tag.id}],payments:[{mode:'upi',amount:'1000.00',reference:'isolated fixture'}]}})).json();
        expect((await shop.go('POST','/v1/sales/invoices/{id}/prints',{p:{id:inv.id},headers:shop.key(),body:{}})).json()).toMatchObject({template_id:PLATFORM.invoice,template_version:1});
        expect(JSON.parse(shop.rec.report())).toMatchObject({violations:[],undocumented:[],timestamps:[]});
      } finally {await shop.close();}
    }
  },120000);

  it('all0.9.5 responses, including S19 #2 inherited metadata and receipt prints/errors, pass Ajv and strict RFC3339',()=>{
    const report=JSON.parse(fx.rec.report());
    expect(report.violations,fx.rec.report()).toEqual([]); expect(report.undocumented,fx.rec.report()).toEqual([]); expect(report.timestamps,fx.rec.report()).toEqual([]);
  });
});
