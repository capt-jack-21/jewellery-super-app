import { randomUUID } from 'node:crypto';
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import { z } from 'zod';
import { currentTx } from '@jw/db';
import { open, seal } from '@jw/shared';
import { Ctx, JwRequest, RequirePermission, etag, fail, ifMatch, parse, pgProblem, staleOr404 } from './common';
import { audit } from './session.service';

/**
 * Bank accounts (data model v1.8: masters.bank_account replaces company/vendor.bank_accounts jsonb).
 * The account number is accepted in plain text, stored ONLY as AES-GCM ciphertext (account_no_enc, nonce|ct|tag) +
 * account_key_id, and every response shows account_last4 only. Decryption happens at print time via
 * openBankAccountNo() (no API returns the full number). Platform scope = company accounts; vendor CRUD lives with masters.
 */
export const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
export const BANK_COLS = `id, owner_type, company_id, vendor_id, bank_name, branch_name, ifsc, holder_name, account_last4,
  is_default, print_on_invoice, is_active, version, created_at`;
const accountNo = z.string().transform((s) => s.replace(/[\s-]/g, '')).pipe(z.string().regex(/^[0-9]{6,20}$/, 'account_no: 6–20 digits'));
const fields = {
  bank_name: z.string().trim().min(2).max(100), branch_name: z.string().trim().min(1).max(100).nullable(),
  ifsc: z.string().trim().toUpperCase().pipe(z.string().regex(IFSC, 'invalid IFSC (e.g. HDFC0001234)')),
  holder_name: z.string().trim().min(2).max(140), account_no: accountNo,
  is_default: z.boolean(), print_on_invoice: z.boolean(), is_active: z.boolean(),
};
export const BankAccountBody = z.object({ bank_name: fields.bank_name, branch_name: fields.branch_name.optional(), ifsc: fields.ifsc,
  holder_name: fields.holder_name, account_no: fields.account_no, is_default: fields.is_default.default(false),
  print_on_invoice: fields.print_on_invoice.default(false) }).strict();
export const BankAccountPatch = z.object(fields).partial().strict().refine((o) => Object.keys(o).length > 0, 'empty patch');
export type OwnerType = 'company' | 'vendor';

/** print_on_invoice is a company-only flag (also a DB CHECK). */
export function assertOwnerFlags(owner: OwnerType, b: { print_on_invoice?: boolean }): void {
  if (owner === 'vendor' && b.print_on_invoice) fail(422, 'validation_failed', 'print_on_invoice is only allowed for company accounts');
}
const aad = (tenantId: string, id: string) => `masters.bank_account:${tenantId}:${id}`;
export function sealAccountNo(tenantId: string, id: string, no: string): { enc: Buffer; keyId: string; last4: string } {
  const { box, keyId } = seal(no, aad(tenantId, id));
  return { enc: box, keyId, last4: no.slice(-4) };
}
/** Print-time decrypt helper (app_rw only, inside a tenant tx). Never exposed through an endpoint. */
export async function openBankAccountNo(id: string): Promise<string> {
  const r = await currentTx().query<{ tenant_id: string; account_no_enc: Buffer; account_key_id: string }>(
    `SELECT tenant_id, account_no_enc, account_key_id FROM masters.bank_account WHERE id = $1 AND is_active`, [id]);
  const row = r.rows[0] ?? fail(404, 'not_found');
  return open(row.account_key_id, row.account_no_enc, aad(row.tenant_id, id)).toString('utf8');
}

type Hdr = { header(k: string, v: string): unknown; status?(n: number): unknown };
async function clearDefault(companyId: string, exceptId: string | null): Promise<void> {
  await currentTx().query(`UPDATE masters.bank_account SET is_default = false
                            WHERE owner_type = 'company' AND company_id = $1 AND is_default AND ($2::uuid IS NULL OR id <> $2)`, [companyId, exceptId]);
}
async function companyExists(id: string): Promise<void> {
  if (!(await currentTx().query(`SELECT 1 FROM platform.company WHERE id = $1`, [id])).rowCount) fail(404, 'not_found');
}

@Controller('v1/companies/:companyId/bank-accounts')
export class BankAccountsController {
  @Get()
  async list(@Param('companyId', ParseUUIDPipe) companyId: string, @Query() query: Record<string, unknown>) {
    await companyExists(companyId);
    // G20 picker support: q (bank / branch / holder / ifsc / last4) and ids (comma-joined or repeated, 1-100)
    const args: unknown[] = [companyId]; const where = [`owner_type = 'company'`, `company_id = $1`];
    if (typeof query.q === 'string' && query.q.trim()) {
      if (query.q.length > 100) fail(422, 'validation_failed', 'q');
      args.push(`%${query.q.trim().replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
      where.push(`concat_ws(' ', bank_name, branch_name, holder_name, ifsc, account_last4) ILIKE $${args.length}`);
    }
    if (query.ids !== undefined) {
      const ids = (Array.isArray(query.ids) ? query.ids.join(',') : String(query.ids)).split(',').map((x) => x.trim()).filter(Boolean);
      if (!ids.length || ids.length > 100 || ids.some((x) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x))) fail(422, 'validation_failed', 'ids');
      args.push([...new Set(ids)]); where.push(`id = ANY($${args.length}::uuid[])`);
    }
    return (await currentTx().query(`SELECT ${BANK_COLS} FROM masters.bank_account WHERE ${where.join(' AND ')}
                                      ORDER BY is_default DESC, created_at`, args)).rows;
  }

  @Get(':id')
  async get(@Param('companyId', ParseUUIDPipe) companyId: string, @Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) reply: Hdr) {
    const row = (await currentTx().query<{ version: number }>(`SELECT ${BANK_COLS} FROM masters.bank_account WHERE id = $1 AND company_id = $2`, [id, companyId])).rows[0]
      ?? fail(404, 'not_found');
    reply.header('ETag', etag(row.version));
    return row;
  }

  @Post() @RequirePermission('platform.settings.edit')
  async create(@Param('companyId', ParseUUIDPipe) companyId: string, @Body() body: unknown, @Res({ passthrough: true }) reply: Hdr) {
    const b = parse(BankAccountBody, body);
    assertOwnerFlags('company', b);
    await companyExists(companyId);
    const c = currentTx();
    const tenantId = (await c.query<{ t: string }>(`SELECT platform.current_tenant() AS t`)).rows[0].t;
    const id = randomUUID();
    const s = sealAccountNo(tenantId, id, b.account_no);
    try {
      if (b.is_default) await clearDefault(companyId, null);
      const row = (await c.query<{ version: number }>(
        `INSERT INTO masters.bank_account(tenant_id, id, owner_type, company_id, bank_name, branch_name, ifsc, holder_name,
                                          account_no_enc, account_key_id, account_last4, is_default, print_on_invoice)
         VALUES ($1, $2, 'company', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING ${BANK_COLS}`,
        [tenantId, id, companyId, b.bank_name, b.branch_name ?? null, b.ifsc, b.holder_name, s.enc, s.keyId, s.last4, b.is_default, b.print_on_invoice])).rows[0];
      await audit('bank_account.created', 'masters.bank_account', id, { company_id: companyId, ifsc: b.ifsc, last4: s.last4 });
      reply.header('ETag', etag(row.version));
      return row;
    } catch (e) { return pgProblem(e); }
  }

  @Patch(':id') @RequirePermission('platform.settings.edit')
  async update(@Ctx() req: JwRequest, @Param('companyId', ParseUUIDPipe) companyId: string, @Param('id', ParseUUIDPipe) id: string,
               @Body() body: unknown, @Res({ passthrough: true }) reply: Hdr) {
    const b = parse(BankAccountPatch, body);
    assertOwnerFlags('company', b);
    const version = ifMatch(req)!;
    const c = currentTx();
    const sets: string[] = []; const vals: unknown[] = [id, version, companyId];
    const set = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    for (const k of ['bank_name', 'branch_name', 'ifsc', 'holder_name', 'is_default', 'print_on_invoice', 'is_active'] as const) if (b[k] !== undefined) set(k, b[k]);
    if (b.account_no !== undefined) {
      const tenantId = (await c.query<{ t: string }>(`SELECT platform.current_tenant() AS t`)).rows[0].t;
      const s = sealAccountNo(tenantId, id, b.account_no);
      set('account_no_enc', s.enc); set('account_key_id', s.keyId); set('account_last4', s.last4);
    }
    try {
      if (b.is_default) {
        const cur = await c.query<{ version: number }>(`SELECT version FROM masters.bank_account WHERE id = $1 AND company_id = $2 FOR UPDATE`, [id, companyId]);
        if (cur.rows[0] && cur.rows[0].version === version) await clearDefault(companyId, id);
      }
      const row = (await c.query<{ version: number }>(
        `UPDATE masters.bank_account SET ${sets.join(', ')} WHERE id = $1 AND version = $2 AND company_id = $3 RETURNING ${BANK_COLS}`, vals)).rows[0];
      if (!row) return staleOr404(async () => ((await c.query(`SELECT 1 FROM masters.bank_account WHERE id = $1 AND company_id = $2`, [id, companyId])).rowCount ?? 0) > 0);
      if (b.account_no !== undefined) await audit('bank_account.number_changed', 'masters.bank_account', id, { last4: String((row as { account_last4?: string }).account_last4) });
      reply.header('ETag', etag(row.version));
      return row;
    } catch (e) { return pgProblem(e); }
  }

  @Delete(':id') @HttpCode(204) @RequirePermission('platform.settings.edit')
  async remove(@Ctx() req: JwRequest, @Param('companyId', ParseUUIDPipe) companyId: string, @Param('id', ParseUUIDPipe) id: string) {
    const version = ifMatch(req)!;
    const c = currentTx();
    let n = 0;
    try { n = (await c.query(`DELETE FROM masters.bank_account WHERE id = $1 AND version = $2 AND company_id = $3`, [id, version, companyId])).rowCount ?? 0; }
    catch (e) { return pgProblem(e); }
    if (!n) await staleOr404(async () => ((await c.query(`SELECT 1 FROM masters.bank_account WHERE id = $1 AND company_id = $2`, [id, companyId])).rowCount ?? 0) > 0);
  }
}
