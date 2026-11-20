import { describe, it, expect } from 'vitest';
import { needKey } from './idempotency';
import { mergeThemes } from './branding.controller';
import { applyMapping, readRows, TEMPLATES } from './import.controller';
import { LoginBody, SettingBody, TemplateBody, BranchBody, resolveBillSeriesPrefix } from './schemas';
import { ifMatch, otpHash, bucketKey, rateLimit, RateLimited } from './common';
import { BankAccountBody, BankAccountPatch, assertOwnerFlags, sealAccountNo } from './bank-accounts.controller';
import { open, seal } from '@jw/shared';

describe('platform unit', () => {
  it('QA IDEM-3 — missing/empty key400, malformed present key422, valid key accepted', () => {
    for (const key of [undefined, '']) {
      try { needKey(key); throw new Error('expected missing-key problem'); }
      catch (e) { expect((e as { getStatus(): number }).getStatus()).toBe(400); expect((e as { getResponse(): unknown }).getResponse()).toMatchObject({code:'idempotency_key_required'}); }
    }
    for (const key of ['short', 'x'.repeat(129), 'contains invalid spaces']) {
      try { needKey(key); throw new Error('expected invalid-key problem'); }
      catch (e) { expect((e as { getStatus(): number }).getStatus()).toBe(422); expect((e as { getResponse(): unknown }).getResponse()).toMatchObject({code:'idempotency_key_invalid'}); }
    }
    expect(()=>needKey('valid-key-00000001')).not.toThrow();
  });
  it('0.9.5 print settings are en/ta only without restricting UI/user language schemas', () => {
    for (const language of ['en','ta','hi','te','kn','ml','zz']) {
      const result=TemplateBody.safeParse({doc_type:'receipt',body_key:'tpl/receipt.hbs',print_language:language});
      expect(result.success).toBe(['en','ta'].includes(language));
      if(!result.success) expect(result.error.issues.some(x=>x.path.join('.')==='print_language')).toBe(true);
    }
  });

  it('branch bill_series_prefix: optional, blank/omitted → code, upper-cased, invalid → null', () => {
    expect(BranchBody.safeParse({ company_id: '00000000-0000-4000-8000-000000000000', code: 'MDU', name: 'm' }).success).toBe(true);
    expect(resolveBillSeriesPrefix(undefined, 'MDU')).toBe('MDU');
    expect(resolveBillSeriesPrefix(null, 'MDU')).toBe('MDU');
    expect(resolveBillSeriesPrefix('  ', 'MDU')).toBe('MDU');
    expect(resolveBillSeriesPrefix(' y/26-a ', 'MDU')).toBe('Y/26-A');
    for (const bad of ['-x', '/1', 'ABCDEFGHIJKLM', 'A B']) expect(resolveBillSeriesPrefix(bad, 'MDU')).toBeNull();
    // derived-from-code path still validated (unreachable via BranchBody's code regex, guarded anyway)
    expect(resolveBillSeriesPrefix('', 'ABCDEFGHIJKLM')).toBeNull();
  });

  it('api_version is generated from contracts/openapi.yaml info.version; min_client_version 0.3.0', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const yaml = readFileSync(join(__dirname, '../../../../../contracts/openapi.yaml'), 'utf8');
    const v = /^info:[\s\S]*?^ {2}version:\s*([^\s]+)/m.exec(yaml)?.[1];
    const { CONTRACT_VERSION } = await import('./contract-version');
    const { MetaController, MIN_CLIENT_VERSION } = await import('./meta.controller');
    expect(v).toBeTruthy();
    expect(CONTRACT_VERSION).toBe(v);
    expect(MIN_CLIENT_VERSION).toBe('0.3.0');
    expect(new MetaController({} as never).meta()).toMatchObject({ api_version: v });
  });
  it('rateLimit throws RateLimited (429 rate_limited) with Retry-After seconds', () => {
    const k = `t:${Math.random()}`;
    rateLimit(k, 1, 60_000);
    let e: unknown; try { rateLimit(k, 1, 60_000); } catch (x) { e = x; }
    expect(e).toBeInstanceOf(RateLimited);
    expect((e as RateLimited).getStatus()).toBe(429);
    expect((e as RateLimited).getResponse()).toMatchObject({ code: 'rate_limited', status: 429 });
    expect((e as RateLimited).retryAfter).toBeGreaterThan(0); expect((e as RateLimited).retryAfter).toBeLessThanOrEqual(60);
  });
  it('theme merge: scalars inherit on null, colours merge key-wise', () => {
    const m = mergeThemes([{ app_name: 'P', colors: { a: '#000000', b: '#111111' } }, { app_name: null, colors: { b: '#222222' } }, { logo_key: 'x' }]);
    expect(m).toMatchObject({ app_name: 'P', logo_key: 'x', colors: { a: '#000000', b: '#222222' } });
  });
  it('csv reader: BOM, header case, blank lines', async () => {
    const rows = await readRows(Buffer.from('\uFEFFName,Phone\n\nAnu, 98 \n'), 'a.csv');
    expect(rows).toEqual([{ name: 'Anu', phone: '98' }]);
    await expect(readRows(Buffer.from('x'), 'a.txt')).rejects.toThrow();
    expect(TEMPLATES.customers[0]).toBe('name');
    expect(TEMPLATES.customers).toContain('pan');
    expect(applyMapping([{ 'mobile no': '98', name: 'A' }], { phone: 'Mobile No' })).toEqual([{ 'mobile no': '98', name: 'A', phone: '98' }]);
  });
  it('schemas are strict and reject data URIs', () => {
    expect(LoginBody.safeParse({ login: 'a', password: 'b', extra: 1 }).success).toBe(false);
    expect(TemplateBody.safeParse({ doc_type: 'invoice', body_key: 'data:x' }).success).toBe(false);
    expect(SettingBody.safeParse({ value: '1.00' }).success).toBe(true);
  });
  it('If-Match parsing: 428 missing, 412 malformed, weak tags accepted', () => {
    const st = (f: () => unknown) => { try { f(); } catch (e) { return (e as { getStatus(): number }).getStatus(); } return 0; };
    const req = (h?: string) => ({ headers: h === undefined ? {} : { 'if-match': h } }) as never;
    expect(st(() => ifMatch(req()))).toBe(428);
    expect(ifMatch(req(), false)).toBeNull();
    expect(ifMatch(req('"3"'))).toBe(3);
    expect(ifMatch(req('W/"12"'))).toBe(12);
    expect(st(() => ifMatch(req('3')))).toBe(412);
  });
  it('otp hash is 32 bytes; secretbox round-trips and binds AAD', () => {
    expect(otpHash('c1', '123456').length).toBe(32);
    const { keyId, box } = seal('123456', 't:c1');
    expect(box.length).toBeGreaterThanOrEqual(28);
    expect(open(keyId, box, 't:c1').toString()).toBe('123456');
    expect(() => open(keyId, box, 't:c2')).toThrow();
  });
  it('bank account: IFSC validated, account_no normalised, print_on_invoice company-only, ciphertext = nonce|ct|tag', () => {
    const ok = BankAccountBody.parse({ bank_name: 'HDFC Bank', ifsc: 'hdfc0001234', holder_name: 'Sri Lakshmi Jewellers', account_no: '5010 0123 4567' });
    expect(ok).toMatchObject({ ifsc: 'HDFC0001234', account_no: '501001234567', is_default: false, print_on_invoice: false });
    expect(BankAccountBody.safeParse({ ...ok, ifsc: 'HDFC1001234' }).success).toBe(false);
    expect(BankAccountBody.safeParse({ ...ok, account_no: '12AB' }).success).toBe(false);
    expect(BankAccountBody.safeParse({ ...ok, account_last4: '4567' }).success).toBe(false);
    expect(BankAccountPatch.safeParse({}).success).toBe(false);
    expect(() => assertOwnerFlags('vendor', { print_on_invoice: true })).toThrow();
    expect(() => assertOwnerFlags('company', { print_on_invoice: true })).not.toThrow();
    const t = '00000000-0000-0000-0000-000000000001'; const id = '00000000-0000-0000-0000-0000000000b1';
    const s = sealAccountNo(t, id, '501001234567');
    expect(s.last4).toBe('4567');
    expect(s.enc.length).toBe(12 + 12 + 16);
    expect(open(s.keyId, s.enc, `masters.bank_account:${t}:${id}`).toString()).toBe('501001234567');
    expect(() => open(s.keyId, s.enc, `masters.bank_account:${t}:other`)).toThrow();
    void seal;
  });
  it('rate-limit bucket keys never contain the raw identifier', () => {
    const k = bucketKey('login.tenant', '00000000-0000-0000-0000-000000000001', ' Meena ');
    expect(k).toMatch(/^login\.tenant:[0-9a-f-]+:[0-9a-f]{64}$/);
    expect(k).not.toContain('meena');
    expect(k).toBe(bucketKey('login.tenant', '00000000-0000-0000-0000-000000000001', 'meena'));
    expect(bucketKey('login.admin', null, 'a@b.in')).toMatch(/^login\.admin:-:[0-9a-f]{64}$/);
  });
});
