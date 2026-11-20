import { one } from './db';
import { type SalesActor, need, needAny, needBranch } from './actor';
import { fail } from './errors';
import { RX, isObj } from './validate';

/** Called BEFORE the idempotency cache: a cached write is never an auth / branch-scope bypass. */
export async function authorizeIdempotent(a: SalesActor, route: string, resource: string, body: unknown): Promise<void> {
  const path = route.replace('POST /v1/sales/', '');
  let table: 'invoice' | 'estimate' | 'credit_note' = 'invoice';
  let permission: string;
  if (path === 'invoices') permission = 'sales.invoice.issue';
  else if (path === 'estimates') { permission = 'sales.estimate.create'; table = 'estimate'; }
  else if (path.endsWith('/reversal')) permission = 'sales.receipt.reverse';
  else if (path.endsWith('/payments')) permission = 'sales.payment.receive';
  else if (path.endsWith('/cancellation')) permission = 'sales.invoice.cancel';
  else if (path.endsWith('/returns')) permission = 'sales.return.issue';
  else if (path.endsWith('/prints')) {
    table = path.startsWith('estimates/') ? 'estimate' : path.startsWith('credit-notes/') ? 'credit_note' : 'invoice';
    needAny(a, table === 'estimate' ? ['sales.estimate.create', 'sales.invoice.view']
      : table === 'invoice' ? ['sales.invoice.issue', 'sales.invoice.view'] : ['sales.invoice.view']);
    permission = '';
  } else fail(500, 'not_wired', 'unknown Sales write');
  if (permission) need(a, permission);
  if (!resource) {
    // Invalid request bodies will be rejected by the regular parser, or by the cache's hash comparison.
    if (isObj(body) && typeof body.branch_id === 'string' && RX.uuid.test(body.branch_id)) needBranch(a, body.branch_id);
    return;
  }
  const row = await one<{ branch_id: string }>(`SELECT branch_id FROM sales.${table} WHERE id = $1`, [resource.split('/')[0]]);
  if (!row) fail(404, 'not_found', table);
  needBranch(a, row.branch_id);
  if (path === 'invoices/{id}/payments/{receipt_id}/prints' && !(await one(`SELECT 1 FROM sales.payment_receipt WHERE invoice_id = $1 AND id = $2`, resource.split('/'))))
    fail(404, 'not_found', 'receipt');
}
