// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupServer } from 'msw/node';
import en from '@/i18n/messages/en-IN.json';
import { ApiError } from '@/lib/api/fetcher';
import { resetMastersMock, setMastersNotLive } from '@/mocks/masters';
import { handlers } from '@/mocks/handlers';
import { chunk, clampLimit, mastersApi } from './api';
import { MASTER_IMPORT_KINDS } from './import-export';
import { maskLast4 } from './mask';
import { fieldErrors, MASTER_422_CODES } from './errors';

import { checkPhotos, coverOf, moved, sortPhotos } from './photos';
import { CUSTOMERS_EDIT } from '@/lib/permissions';
import { codeFrom, defaultsFor, editPermOf, viewPermOf, FIELD_GROUPS, KYC_TYPES, labelKey, FROZEN_MUST_HAVE, MASTERS, normaliseInput, toBody, validateField, validateInput, type FieldDef } from './registry';
import { MASTER_KINDS, type MasterKind } from './types';
import { MASTER_GROUPS } from './pages';

const must = <T,>(v: T | null | undefined): T => { if (v == null) throw new Error('missing'); return v; };
const server = setupServer(...handlers);
beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
  const mswFetch = globalThis.fetch; // installed by listen(); give relative /api URLs an origin
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => mswFetch(typeof input === 'string' && input.startsWith('/') ? `http://localhost${input}` : input, init);
});
afterAll(() => server.close());
beforeEach(() => resetMastersMock());
const keys = new Set(Object.keys(en));
const fail = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as ApiError; } throw new Error('expected failure'); };
const fld = (kind: MasterKind, key: string) => MASTERS[kind].fields.find((x) => x.key === key) as FieldDef;

describe('masters registry (frozen 28 Oct, contract 0.6.1)', () => {
  it('covers every must-have master and none of the later ones', () => {
    const mids = new Set(MASTER_GROUPS.flatMap((g) => g.items.flatMap((i) => i.mid.split(' · '))));
    for (const m of FROZEN_MUST_HAVE) expect(mids).toContain(m);
    expect(mids.has('M9')).toBe(false);
    expect(mids.has('M16')).toBe(false);
    expect(Object.keys(MASTERS).sort()).toEqual([...MASTER_KINDS].sort());
  });
  it('every label, hint, option, title and import kind has an i18n key', () => {
    for (const cfg of Object.values(MASTERS)) {
      for (const k of ['title', 'desc', 'add']) expect(keys, `${cfg.kind}.${k}`).toContain(`masters.${cfg.kind}.${k}`);
      for (const f of cfg.fields) {
        expect(keys, f.key).toContain(labelKey(cfg.kind, f.key));
        if (f.hint) expect(keys, `hint ${f.key}`).toContain(`masters.h.${f.key}`);
        for (const o of f.options ?? []) expect(keys, `${f.key}.${o}`).toContain(`masters.o.${f.optionsKey ?? f.key}.${o}`);
      }
    }
    for (const g of FIELD_GROUPS) expect(keys, g).toContain(`masters.fg.${g}`);
    for (const k of MASTER_IMPORT_KINDS) expect(keys, k).toContain(`import.entity.${k}`);
    for (const g of MASTER_GROUPS) for (const i of g.items) expect(keys, i.key).toContain(`masters.${i.key}.title`);
  });
  it('basic forms stay short; only fields with a default hide under "More details" when required; defaults are valid', () => {
    for (const cfg of Object.values(MASTERS)) {
      expect(cfg.fields.filter((f) => !f.advanced && !f.group).length, cfg.kind).toBeLessThanOrEqual(5);
      for (const f of cfg.fields) if (f.required && f.advanced) expect(f.default, `${cfg.kind}.${f.key}`).not.toBeUndefined();
      const d = defaultsFor(cfg);
      for (const f of cfg.fields) if (f.default != null) expect(validateField(f, d[f.key]), f.key).toBeNull();
    }
  });
  it('VA rules group fields per contract x-field-group; customer writes use one permission constant', () => {
    const g = (grp: string) => MASTERS.value_addition_rules.fields.filter((f) => f.group === grp).map((f) => f.key);
    expect(g('making_charge')).toEqual(['mc_per_gram', 'mc_percent', 'flat_mc']);
    expect(g('wastage')).toEqual(['wastage_pct', 'touch', 'flat_wastage']);
    expect(editPermOf('customers')).toBe(CUSTOMERS_EDIT);
    expect(CUSTOMERS_EDIT).toBe('masters.customers.manage');
    expect(editPermOf('stone_rates')).toBe('masters.stones.manage');
    expect(viewPermOf('trays')).toBe('masters.counters.view');
    expect(editPermOf('kyc_documents', 'vendor')).toBe('masters.vendors.manage');
    expect(labelKey('hsn_codes', 'code')).toBe('masters.f.hsn_codes.code');
  });
  it('validates decimals as strings (no floats), phones, codes, GSTIN, PAN, HSN', () => {
    const w = fld('value_addition_rules', 'wastage_pct');
    expect(validateField(w, '12.5')).toBeNull();
    expect(validateField(w, '100.01')).toBe('too_big');
    expect(validateField(w, '1.234')).toBe('too_many_dp');
    expect(validateField(w, '1e3')).toBe('invalid');
    expect(normaliseInput(MASTERS.stone_rates, { sale_rate: ' 1,23,456.50 ' }).sale_rate).toBe('123456.5');
    expect(normaliseInput(MASTERS.customers, { phone: '+91 98765 43210', pan: 'abcde 1234f' })).toEqual({ phone: '9876543210', pan: 'ABCDE1234F' });
    expect(validateInput(MASTERS.customers, { name: 'A', phone: '12345' })).toEqual({ phone: 'phone' });
    expect(validateField(fld('customers', 'pan'), 'ABCDE1234F')).toBeNull();
    expect(validateField(fld('customers', 'pan'), 'ABC1234')).toBe('invalid');
    expect(validateField(fld('customers', 'gstin'), '33ABCDE1234F1Z5')).toBeNull();
    expect(validateField(fld('hsn_codes', 'code'), '711319')).toBeNull();
    expect(validateField(fld('hsn_codes', 'code'), '71131')).toBe('invalid');
    expect(validateField(fld('items', 'code'), 'ring')).toBe('invalid');
    expect(validateField(fld('vendors', 'kinds'), [])).toBe('required');
    expect(codeFrom('Gold ring (22k)')).toBe('GOLD-RING-22K');
  });
  it('builds contract bodies: nested address, ints as numbers, blanks dropped on create', () => {
    expect(toBody(MASTERS.customers, { name: 'A', 'address.city': 'Madurai', email: null }, true)).toEqual({ name: 'A', address: { city: 'Madurai' } });
    expect(toBody(MASTERS.payment_modes, { sort_order: '3' }, false)).toEqual({ sort_order: 3 });
  });
  it('masks to the last 4 only; photo checks follow the contract', () => {
    expect(maskLast4('234F')).toBe('••••••234F');
    expect(maskLast4(null)).toBe('');
    expect(checkPhotos(0, [{ type: 'image/gif', size: 10 }])).toBe('masters.photoInvalid');
    expect(checkPhotos(7, [{ type: 'image/png', size: 10 }, { type: 'image/png', size: 10 }])).toBe('masters.photoTooMany');
    expect(checkPhotos(0, [{ type: 'image/webp', size: 5 * 1024 * 1024 }])).toBeNull();
  });
});

describe('masters API layer (generated client) against the mock', () => {
  it('lists {items, next_cursor}: active by default, q, filters, keyset paging', async () => {
    const page = await mastersApi.list('payment_modes');
    expect(page.items).toHaveLength(5);
    expect(page.next_cursor).toBeNull();
    expect((await mastersApi.list('payment_modes', { q: 'up' })).items.map((r) => r.kind)).toEqual(['upi']);
    expect((await mastersApi.list('vendors', { kind: 'smith' })).items).toHaveLength(1);
    const first = await mastersApi.list('payment_modes', { limit: '2' });
    expect(first.items).toHaveLength(2);
    const next = await mastersApi.list('payment_modes', { limit: '2', cursor: first.next_cursor ?? '' });
    expect(next.items[0]?.id).not.toBe(first.items[0]?.id);
  });
  it('creates (201), updates with If-Match, deactivates instead of deleting', async () => {
    const hsn = await mastersApi.create('hsn_codes', { code_type: 'HSN', code: '7117', description: 'Imitation jewellery' });
    expect(hsn.version).toBe(1);
    const upd = await mastersApi.update('hsn_codes', hsn, { description: 'Imitation' });
    expect(upd.version).toBe(2);
    const off = await mastersApi.setActive('hsn_codes', upd, false);
    expect(off.is_active).toBe(false);
    expect((await mastersApi.list('hsn_codes')).items.map((r) => r.code)).not.toContain('7117');
    expect((await mastersApi.list('hsn_codes', { include_inactive: true })).items.map((r) => r.code)).toContain('7117');
  });
  it('stale If-Match → 412; duplicate code → 409; bad fields → 422 with paths', async () => {
    const [mode] = (await mastersApi.list('payment_modes')).items;
    await mastersApi.update('payment_modes', mode as never, { name: 'Cash desk' });
    expect((await fail(mastersApi.update('payment_modes', mode as never, { name: 'x' }))).status).toBe(412);
    expect((await fail(mastersApi.create('items', { code: 'RING', name: 'R', metal_id: 'm', purity_id: 'p', hsn: '7113', stock_type: 'tag' }))).status).toBe(409);
    const e = await fail(mastersApi.create('customers', { name: 'A', phone: '123' }));
    expect(e.status).toBe(422);
    expect(e.errors.map((x) => x.path)).toEqual(['/phone']);
  });
  it('customers: PAN is write-only, rows carry pan_last4, no preferred_locale', async () => {
    const c = await mastersApi.create('customers', { name: 'Meena', phone: '9840000001', pan: 'ABCDE1234F' });
    expect(c.pan_last4).toBe('234F');
    expect(JSON.stringify(c)).not.toContain('ABCDE1234F');
    expect('preferred_locale' in c).toBe(false);
  });
  it('design photos (0.7.0): upload → attach, reorder/cover with the design version, remove with the photo version', async () => {
    const [d] = (await mastersApi.list('designs')).items;
    const blob = (n: string) => new File([new Uint8Array([137, 80, 78, 71])], n, { type: 'image/png' });
    for (const [i, n] of ['a.png', 'b.png'].entries()) {
      const f = await mastersApi.uploadFile(blob(n), 'design_photo');
      await mastersApi.attachPhoto(must(d).id, { file_id: f.id, caption: null, is_primary: i === 0, sort_order: i });
    }
    const ps = sortPhotos(await mastersApi.listPhotos(must(d).id));
    expect(ps).toHaveLength(2);
    expect(coverOf(ps)?.file_id).toBe(ps[0]?.file_id);
    expect(await mastersApi.fileUrl(must(ps[0]).file_id)).toMatch(/^data:/);
    const fresh = await mastersApi.get('designs', must(d).id);
    // Every photo must be listed once.
    expect((await fail(mastersApi.reorderPhotos(fresh as never, [must(ps[0]).file_id]))).code).toBe('photo_set_mismatch');
    const r = await mastersApi.reorderPhotos(fresh as never, moved(ps, 0, 1).map((p) => p.file_id), must(ps[1]).file_id);
    expect(r.design_version).toBe(fresh.version + 1);
    expect(r.photos.map((p) => p.file_id)).toEqual([must(ps[1]).file_id, must(ps[0]).file_id]);
    expect(coverOf(r.photos)?.file_id).toBe(must(ps[1]).file_id);
    expect((await fail(mastersApi.reorderPhotos(fresh as never, r.photos.map((p) => p.file_id)))).status).toBe(412);
    const stale = must(ps[0]);
    expect((await fail(mastersApi.removePhoto(must(d).id, stale))).status).toBe(412);
    await mastersApi.removePhoto(must(d).id, must(r.photos[1]));
    expect(await mastersApi.listPhotos(must(d).id)).toHaveLength(1);
  });
  it('KYC reveal needs a 10–500 char reason, is rate limited (429 + Retry-After) and returns no-store data', async () => {
    const [c] = (await mastersApi.list('customers')).items;
    await mastersApi.create('kyc_documents', { party_type: 'customer', party_id: must(c).id, doc_type: 'passport', number: 'P1234567', front_file_id: (await mastersApi.uploadFile(new File(['x'], 'p.pdf', { type: 'application/pdf' }), 'kyc_document')).id });
    const docs = (await mastersApi.list('kyc_documents')).items;
    expect(docs[0]?.number_last4).toBe('4567');
    expect(JSON.stringify(docs)).not.toContain('P1234567');
    expect((await fail(mastersApi.revealKyc('customers', must(c).id, 'short'))).status).toBe(422);
    const r = await mastersApi.revealKyc('customers', must(c).id, 'GST invoice above two lakh');
    expect(r.pan).toBe('ABCDE1234F');
    expect(r.documents[0]?.number).toBe('P1234567');
    for (let i = 0; i < 9; i += 1) await mastersApi.revealKyc('customers', must(c).id, 'GST invoice above two lakh');
    const e = await fail(mastersApi.revealKyc('customers', must(c).id, 'GST invoice above two lakh'));
    expect(e.status).toBe(429);
    expect(e.retryAfter).toBe(60);
  });
  it('staff department / designation are free text up to 100 characters; no aadhaar_last4 anywhere', () => {
    const f = must(MASTERS.staff.fields.find((x) => x.key === 'department'));
    expect(f.type).toBe('text');
    expect(validateField(f, 'Sales')).toBeNull();
    expect(validateField(f, 'x'.repeat(101))).toBe('too_long');
    expect(Object.values(MASTERS).flatMap((c) => c.fields.map((x) => x.last4Key ?? ''))).not.toContain('aadhaar_last4');
  });
  it('not-live kinds answer 404 (the screen shows "not ready yet")', async () => {
    setMastersNotLive(['trays']);
    expect((await fail(mastersApi.list('trays'))).status).toBe(404);
  });
  it('export writes a file without full PAN', async () => {
    await mastersApi.create('customers', { name: 'Meena', pan: 'ABCDE1234F' });
    const job = await mastersApi.exportList('customers', 'csv', false);
    expect(job.status).toBe('done');
    const url = await mastersApi.fileUrl(job.file_id as string);
    const csv = new TextDecoder().decode(Uint8Array.from(atob(url.split(',')[1] ?? ''), (ch) => ch.charCodeAt(0)));
    expect(csv).toContain('234F');
    expect(csv).not.toContain('ABCDE1234F');
  });
});

describe('owner decisions (28 Oct)', () => {
  it('no Aadhaar anywhere: no field, no label, no import/export column; KYC types are labelled', () => {
    for (const cfg of Object.values(MASTERS)) for (const f of cfg.fields) expect(f.key, cfg.kind).not.toMatch(/aadhaar/i);
    // The only Aadhaar text is the friendly refusal for the server's 422 aadhaar_not_allowed (0.7.1).
    expect([...keys].filter((k) => /aadhaar/i.test(k))).toEqual(['error.aadhaar_not_allowed']);
    expect(Object.entries(en).filter(([k, v]) => k !== 'error.aadhaar_not_allowed' && /aadhaar/i.test(String(v)))).toEqual([]);
    expect([...KYC_TYPES]).toEqual(['pan', 'passport', 'voter_id', 'driving_licence', 'gstin_certificate', 'other']);
    for (const k of KYC_TYPES) expect(keys, k).toContain(`masters.o.kyc_type.${k}`);
  });
  it('creates send an Idempotency-Key: the same key replays the same row, a new key makes a new one', async () => {
    const body = { code_type: 'HSN', code: '7117', description: 'Imitation jewellery' };
    const a = await mastersApi.create('hsn_codes', body, 'k-0000000000000001');
    const b = await mastersApi.create('hsn_codes', body, 'k-0000000000000001');
    expect(b.id).toBe(a.id);
    expect((await fail(mastersApi.create('hsn_codes', { ...body, description: 'Other' }, 'k-0000000000000001'))).code).toBe('idempotency_key_reused');
    const page = await mastersApi.list('hsn_codes', { q: '7117' });
    expect(page.items.filter((r) => r.code === '7117')).toHaveLength(1);
  });
  it('type-ahead pickers search with q instead of loading 100 rows', async () => {
    const page = await mastersApi.list('items', { q: 'ri', limit: '20' });
    expect(page.items.map((r) => r.code)).toEqual(['RING']);
  });

describe('contract 0.7.1', () => {
  it('batch ids lookup: chunks of 100, one comma-joined value, unknown ids absent; limit clamped to 1–200', async () => {
    expect(chunk(Array.from({ length: 250 }, (_, i) => i)).map((c) => c.length)).toEqual([100, 100, 50]);
    expect([clampLimit(-5), clampLimit(500), clampLimit(20)]).toEqual([1, 200, 20]);
    const [d] = (await mastersApi.list('designs')).items;
    const fake = Array.from({ length: 140 }, (_, i) => `01930000-0000-7000-8000-${String(900000 + i).padStart(12, '0')}`);
    const got = await mastersApi.byIds('designs', [...fake, must(d).id]);
    expect(got.map((r) => r.id)).toEqual([must(d).id]);
    expect((await mastersApi.list('designs', { limit: '200' })).items.length).toBeGreaterThan(0);
  });
  it('list rows carry labels for refs; single reads do not', async () => {
    const [d] = (await mastersApi.list('designs')).items;
    expect((must(d).labels as Record<string, { name: string }>).item_id?.name).toBe('Chain');
    expect('labels' in (await mastersApi.get('designs', must(d).id))).toBe(false);
  });
  it('kyc-documents are filtered by party_type + party_id on the server', async () => {
    const [c] = (await mastersApi.list('customers')).items;
    const [st] = (await mastersApi.list('staff')).items;
    const f = await mastersApi.uploadFile(new File(['x'], 'p.pdf', { type: 'application/pdf' }), 'kyc_document');
    await mastersApi.create('kyc_documents', { party_type: 'customer', party_id: must(c).id, doc_type: 'passport', number: 'P1234567', front_file_id: f.id });
    await mastersApi.create('kyc_documents', { party_type: 'staff', party_id: must(st).id, doc_type: 'pan', number: 'ABCDE1111F', front_file_id: f.id });
    const mine = (await mastersApi.list('kyc_documents', { party_type: 'staff', party_id: must(st).id })).items;
    expect(mine.map((x) => x.party_id)).toEqual([must(st).id]);
  });
  it('sub-items: strict create (item_id, code, name), patch never sends item_id', async () => {
    const [it0] = (await mastersApi.list('items')).items;
    expect(validateInput(MASTERS.sub_items, normaliseInput(MASTERS.sub_items, { name: 'X' }))).toMatchObject({ item_id: 'required', code: 'required' });
    const s1 = await mastersApi.create('sub_items', { item_id: must(it0).id, code: 'RING-P', name: 'Plain ring' });
    const s2 = await mastersApi.update('sub_items', s1, { item_id: 'ignored', name: 'Plain band' });
    expect(s2.name).toBe('Plain band');
    expect(s2.item_id).toBe(must(it0).id);
    expect(MASTERS.sub_items.fields.find((x) => x.key === 'item_id')?.createOnly).toBe(true);
  });
  it('phone: Indian mobile like the backend (6–9 start, optional +91, spaces/dashes ignored)', () => {
    const f = must(MASTERS.customers.fields.find((x) => x.key === 'phone'));
    for (const ok1 of ['9840000001', '+91 98400 00001', '91-6000000000']) expect(validateField(f, ok1), ok1).toBeNull();
    for (const bad of ['5840000001', '984000000', '+1 9840000001']) expect(validateField(f, bad), bad).toBe('phone');
    expect(normaliseInput(MASTERS.customers, { phone: '+91 98400-00001' }).phone).toBe('9840000001');
  });
  it('422 codes: every documented code has a message; field-level where the code names a field', async () => {
    for (const c of MASTER_422_CODES) expect(keys.has(`error.${c}`), c).toBe(true);
    const tk = (k: string) => k;
    const e1 = new ApiError(422, 'purity_metal_mismatch', 'x', undefined, [{ path: 'purity_id', message: 'purity belongs to another metal' }]);
    expect(fieldErrors(MASTERS.items, e1, tk)).toEqual({ purity_id: 'error.purity_metal_mismatch' });
    const e2 = new ApiError(422, 'unknown_hsn', 'x', undefined, []);
    expect(fieldErrors(MASTERS.items, e2, tk)).toEqual({ hsn: 'error.unknown_hsn' });
    const e3 = new ApiError(422, 'validation_failed', 'x', undefined, [{ path: '/address/city', message: 'too long' }]);
    expect(fieldErrors(MASTERS.customers, e3, tk)).toEqual({ 'address.city': 'too long' });
    const [it0] = (await mastersApi.list('items')).items;
    const bad = await fail(mastersApi.create('sub_items', { item_id: '01930000-0000-7000-8000-999999999999', code: 'Z', name: 'Z' }));
    expect(bad.code).toBe('unknown_reference');
    expect(Object.keys(fieldErrors(MASTERS.sub_items, bad, tk))).toEqual(['item_id']);
    expect(it0).toBeTruthy();
  });
});

});

describe('contract 0.7.3', () => {
  it('G16: master phones are 10-digit Indian mobiles, normalised to bare digits', () => {
    const body = normaliseInput(MASTERS.customers, { name: 'A', phone: '+91 98765-43210' });
    expect(body.phone).toBe('9876543210');
    expect(validateInput(MASTERS.customers, normaliseInput(MASTERS.customers, { name: 'A', phone: '5876543210' }), false).phone).toBe('phone');
  });
  it('G17: the generated client sends ids as an array (server accepts repeated or joined)', async () => {
    const { getListCountersUrl } = await import('@/lib/api/backend/masters/masters');
    expect(getListCountersUrl({ ids: ['a', 'b'] })).toContain('ids=a&ids=b');
    const [d] = (await mastersApi.list('designs')).items;
    expect((await mastersApi.byIds('designs', [must(d).id])).map((r) => r.id)).toEqual([must(d).id]);
  });
  it('G18: kyc_consent sets/clears consent_at on the server; consent_at and group_id are never sent', async () => {
    expect(fld('customers', 'kyc_consent').type).toBe('bool');
    expect(MASTERS.customers.fields.some((f) => f.key === 'consent_at' || f.key === 'group_id')).toBe(false);
    const [c] = (await mastersApi.list('customers')).items;
    expect(must(fld('customers', 'kyc_consent').fromRow)(must(c))).toBe(true);
    const off = await mastersApi.update('customers', must(c), { kyc_consent: false } as never);
    expect(off.consent_at).toBeNull();
    const on = await mastersApi.update('customers', off, { kyc_consent: true } as never);
    expect(typeof on.consent_at).toBe('string');
    expect((await fail(mastersApi.update('customers', on, { consent_at: null } as never))).status).toBe(422);
  });
  it('G20 / 986: card machine settlement bank via q/ids; account_head_id is a plain id; floors import/export', () => {
    expect(fld('card_machines', 'settlement_bank_account_id').ref).toBe('bank_account');
    expect(fld('payment_modes', 'account_head_id')).toMatchObject({ type: 'text', advanced: true });
    expect(MASTER_IMPORT_KINDS).toContain('floors');
  });
  it('a pathless 422 inactive_master on a card machine lands on cash_counter_id with a friendly message', () => {
    const e = new ApiError(422, 'inactive_master', 'Cash counter is deactivated');
    expect(fieldErrors(MASTERS.card_machines, e, (k) => k)).toEqual({ cash_counter_id: 'error.inactive_master.card_machines' });
    expect(keys.has('error.inactive_master.card_machines')).toBe(true);
  });
  it('vendor reveal: pan_not_migrated → masked legacy PAN', async () => {
    const v = await mastersApi.create('vendors', { name: 'Old Supplier', code: 'OLDS', kinds: ['supplier'], pan: 'ABCDE1234F' } as never, 'k-vendor-legacy-0001');
    const r = await mastersApi.revealKyc('vendors', v.id, 'Checking the old supplier PAN');
    expect(r).toMatchObject({ pan: 'XXXXXX234F', pan_not_migrated: true });
  });
});
