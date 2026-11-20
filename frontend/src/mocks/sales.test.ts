/** The dev-only Sales mock engine (mocks/sales.ts) follows the 0.9.1 rules the screens rely on. */
import { describe, expect, it } from 'vitest';
import type { BillComputation, IssueInvoiceRequest } from '@/lib/api/backend/model';
import { BRANCH_ID, db } from './db';
import { compute } from './sales';

const tag = () => db().tags[0]?.id ?? '';
const p22 = () => db().purities.find((p) => p.code === '22K')?.id ?? '';
const req = (over: Record<string, unknown> = {}) => ({ branch_id: BRANCH_ID, salesperson_id: 's', lines: [{ kind: 'tag', tag_id: tag() }], payments: [], ...over }) as unknown as IssueInvoiceRequest;
const ok = (x: BillComputation | string): BillComputation => { if (typeof x === 'string') throw new Error(x); return x; };

describe('mock sales engine', () => {
  it('B2C in the home state is intra-state; another place of supply is IGST', () => {
    const home = ok(compute(req({ customer: { name: 'A', phone: '9000000001' } })));
    expect(home).toMatchObject({ supply_type: 'b2c', gst_type: 'intra', place_of_supply: '33' });
    const away = ok(compute(req({ customer: { name: 'A', phone: '9000000001' }, place_of_supply: '29' })));
    expect(away.gst_type).toBe('inter');
    expect(away.totals.igst).not.toBe('0.00');
  });
  it('B2B takes the GSTIN state; a different place of supply is a conflict', () => {
    const b2b = ok(compute(req({ customer: { name: 'B', phone: '9000000002', gstin: '29ABCDE1234F1Z5' } })));
    expect(b2b).toMatchObject({ supply_type: 'b2b', place_of_supply: '29', gst_type: 'inter' });
    expect(compute(req({ customer: { name: 'B', phone: '9000000002', gstin: '29ABCDE1234F1Z5' }, place_of_supply: '33' }))).toBe('place_of_supply_conflict');
  });
  it('loose lines, line discounts, old gold and the cash limit', () => {
    const c = ok(compute(req({
      lines: [{ kind: 'loose', item_id: 'x', purity_id: p22(), gross_wt: '2.000', net_wt: '2.000', discount: '500.00' }],
      old_metal: [{ purity_id: p22(), gross_wt: '1.000' }], payments: [{ mode: 'cash', amount: '250000.00' }],
    })));
    expect(c.lines[0]).toMatchObject({ kind: 'loose', discount: '500.00', net_wt: '2.000' });
    expect(c.old_metal[0]?.amount).not.toBe('0.00');
    expect(c.requirements.discount_permission).toBe(true);
    expect(c.requirements.cash_limit.exceeded).toBe(true);
  });
});
