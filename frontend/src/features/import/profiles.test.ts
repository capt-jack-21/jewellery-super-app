import { describe, expect, it } from 'vitest';
import { applyProfile, detectProfile, genericProfile, missingColumns, parseCsv, type MappingProfile } from './profiles';

const other: MappingProfile = { id: 'p2', name: 'Other app export', kind: 'customers', builtin: false, mapping: { name: 'Customer Name', phone: 'Mobile No' } };

describe('import mapping profiles', () => {
  it('parses quoted CSV with BOM and CRLF', () => {
    const r = parseCsv('\uFEFFname,phone\r\n"Rao, K","98400 00001"\r\n"Say ""hi""",1\r\n\r\n');
    expect(r.headers).toEqual(['name', 'phone']);
    expect(r.rows).toEqual([{ name: 'Rao, K', phone: '98400 00001' }, { name: 'Say "hi"', phone: '1' }]);
  });
  it('applies a profile case/space-insensitively and detects the best profile', () => {
    const gen = genericProfile('customers', ['name', 'phone']);
    const rows = [{ 'customer  name': ' Lakshmi ', 'MOBILE_NO': '9840000001', extra: 'x' }];
    expect(detectProfile(Object.keys(rows[0] ?? {}), [gen, other])?.id).toBe('p2');
    expect(applyProfile(rows, other)).toEqual([{ name: 'Lakshmi', phone: '9840000001' }]);
  });
  it('reports missing required columns', () => {
    expect(missingColumns(['Customer Name'], other, ['name', 'phone'])).toEqual(['phone']);
  });
});
