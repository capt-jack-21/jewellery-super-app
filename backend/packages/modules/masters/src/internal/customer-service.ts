import { currentTx } from '@jw/db';
import { Problem } from '@jw/mod-platform';
import { panCols } from './specs';

/**
 * Customer services for other modules (Sales S1 quick-add / S10 PAN), on the caller's request transaction. Masters stays the
 * only writer of masters.customer; the PAN is sealed here (AES-GCM, same AAD as the customers API) and never returned or logged.
 */
export interface SaleCustomer {
  id: string; name: string; phone: string | null; gstin: string | null; state_code: string | null; address: Record<string, unknown> | null;
  pan_last4: string | null; is_active: boolean;
}
const COLS = `id, name, phone, gstin, state_code, address, pan_last4, is_active`;
const q = async <T>(sql: string, args: unknown[]): Promise<T | undefined> => (await currentTx().query(sql, args)).rows[0] as T | undefined;

export const customerForSale = (id: string): Promise<SaleCustomer | undefined> =>
  q<SaleCustomer>(`SELECT ${COLS} FROM masters.customer WHERE id = $1`, [id]);
export const customerByPhone = (phone: string): Promise<SaleCustomer | undefined> =>
  q<SaleCustomer>(`SELECT ${COLS} FROM masters.customer WHERE phone = $1`, [phone]);
export async function quickAddCustomer(c: { name: string; phone: string; gstin?: string | null; state_code?: string | null;
  address?: Record<string, unknown> | null; home_branch_id: string }): Promise<SaleCustomer> {
  if (c.gstin && c.state_code && c.gstin.slice(0, 2) !== c.state_code)
    throw new Problem(422, 'validation_failed', 'state_code does not match GSTIN', [{ path: 'customer.state_code', message: 'does not match GSTIN' }]);
  await currentTx().query(`SELECT pg_advisory_xact_lock(hashtextextended('customer.phone:' || platform.current_tenant()::text || ':' || $1, 0))`, [c.phone]);
  const existing = await customerByPhone(c.phone);
  if (existing) throw new Problem(409, 'customer_phone_exists', 'a customer with this mobile already exists', undefined,
    { existing_customer: { customer_id: existing.id, name: existing.name } });
  const r = await q<SaleCustomer>(`INSERT INTO masters.customer(tenant_id, name, phone, gstin, state_code, address, home_branch_id)
      VALUES (platform.current_tenant(), $1, $2, $3, $4, coalesce($5::jsonb, '{}'::jsonb), $6) ON CONFLICT (tenant_id, phone) WHERE phone IS NOT NULL DO NOTHING RETURNING ${COLS}`,
    [c.name.trim(), c.phone, c.gstin ?? null, c.gstin ? c.gstin.slice(0, 2) : (c.state_code ?? null), c.address ? JSON.stringify(c.address) : null, c.home_branch_id]);
  if (!r) {
    const ex = (await customerByPhone(c.phone))!;
    throw new Problem(409, 'customer_phone_exists', 'a customer with this mobile already exists', undefined,
      { existing_customer: { customer_id: ex.id, name: ex.name } });
  }
  return r;
}
export async function setCustomerPan(customerId: string, pan: string): Promise<void> {
  const cols = panCols({ pan }, 'masters.customer.pan');
  const r = await currentTx().query(`UPDATE masters.customer SET pan_enc = $2, pan_key_id = $3, pan_last4 = $4 WHERE id = $1`,
    [customerId, cols.pan_enc, cols.pan_key_id, cols.pan_last4]);
  if (r.rowCount !== 1) throw new Problem(404, 'not_found', 'customer');
}
