import { describe, expect, it } from 'vitest';
import { BILL_PREFIX, toTenantCreate } from './admin';

const f = { display_name: 'Kovai Gold', slug: 'kovai-gold', legal_name: '', state_code: '33', owner_name: 'Meena', owner_username: 'meena', owner_password: 'Password@123', partner_id: '', deployment_mode: 'shared' as const };

describe('admin tenant create: branch.bill_series_prefix', () => {
  it('omits the prefix when blank (server defaults to branch code)', () => {
    expect(toTenantCreate({ ...f, bill_series_prefix: '' }).branch).toEqual({ code: 'MAIN', name: 'Kovai Gold' });
  });
  it('sends it when set', () => {
    expect(toTenantCreate({ ...f, bill_series_prefix: 'KG/25-' }).branch.bill_series_prefix).toBe('KG/25-');
  });
  it('validates <= 12, A-Z 0-9 / -', () => {
    for (const ok of ['MAIN', 'KG/25-26', 'A12345678901']) expect(BILL_PREFIX.test(ok)).toBe(true);
    for (const bad of ['', '/KG', 'kg', 'A123456789012', 'K G']) expect(BILL_PREFIX.test(bad)).toBe(false);
  });
});
