import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { LocalDiskDriver, S3Driver, XLSX_TYPE, assertKey, contentDisposition, originalName, fileTokenKeyFromEnv, objectKey, readAll, storageFromEnv } from './storage';
import { signFileToken, verifyFileToken } from './file-token';

const T = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const notFound = () => Object.assign(new Error('nf'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });

describe('object keys', () => {
  it('are <tenant_id>/<area>/<uuid>', () => {
    expect(objectKey(T, 'imports')).toMatch(new RegExp(`^${T}/imports/[0-9a-f-]{36}$`));
    expect(() => objectKey('../x', 'imports')).toThrow();
  });
  it('reject traversal and junk; accept legacy import keys', () => {
    for (const k of ['../etc/passwd', `${T}/imports/../../x`, '', `${T}/imports`]) expect(() => assertKey(k)).toThrow();
    expect(() => assertKey(`imports/${T}/${'a'.repeat(64)}.xlsx`)).not.toThrow();
  });
});

describe('LocalDiskDriver', () => {
  let dir = ''; let d: LocalDiskDriver;
  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'jw-store-')); d = new LocalDiskDriver(dir); });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });
  it('put / head / get stream / delete', async () => {
    const k = objectKey(T, 'imports');
    expect(await d.head(k)).toBeNull(); expect(await d.get(k)).toBeNull();
    await d.put(k, Buffer.from('name\nAnu\n'), 'text/csv');
    expect(await d.head(k)).toEqual({ contentType: 'text/csv', size: 9 });
    const o = await d.get(k);
    expect(o!.body).toBeInstanceOf(Readable);
    expect((await readAll(o!.body)).toString()).toBe('name\nAnu\n');
    await d.delete(k); expect(await d.head(k)).toBeNull();
    await d.delete(k);                                  // idempotent
  });
  it('reads legacy files (no sidecar): type from the extension', async () => {
    const k = `imports/${T}/${'b'.repeat(64)}.xlsx`;
    await mkdir(join(dir, 'imports', T), { recursive: true }); await writeFile(join(dir, k), 'x');
    expect(await d.head(k)).toEqual({ contentType: XLSX_TYPE, size: 1 });
  });
});

describe('S3Driver (aws-sdk-client-mock)', () => {
  const s3 = mockClient(S3Client);
  const client = new S3Client({ region: 'garage', endpoint: 'http://garage.test:3900', forcePathStyle: true, credentials: { accessKeyId: 'a', secretAccessKey: 'b' } });
  const d = new S3Driver({ endpoint: 'http://garage.test:3900', region: 'garage', bucket: 'jw', accessKeyId: 'a', secretAccessKey: 'b' }, client);
  beforeEach(() => s3.reset());
  it('put sends bucket, key, type and length', async () => {
    s3.on(PutObjectCommand).resolves({});
    const k = objectKey(T, 'imports');
    await d.put(k, Buffer.from('abc'), 'text/csv');
    const [call] = s3.commandCalls(PutObjectCommand);
    expect(call.args[0].input).toMatchObject({ Bucket: 'jw', Key: k, ContentType: 'text/csv', ContentLength: 3 });
  });
  it('get returns a stream; missing → null', async () => {
    const k = objectKey(T, 'imports');
    s3.on(GetObjectCommand, { Key: k }).resolves({ Body: Readable.from([Buffer.from('hi')]) as never, ContentType: 'text/csv', ContentLength: 2 });
    const o = await d.get(k);
    expect(o).toMatchObject({ contentType: 'text/csv', size: 2 });
    expect((await readAll(o!.body)).toString()).toBe('hi');
    s3.on(GetObjectCommand).rejects(Object.assign(new Error('nk'), { name: 'NoSuchKey' }));
    expect(await d.get(objectKey(T, 'imports'))).toBeNull();
  });
  it('head maps metadata; 404 → null; other errors propagate', async () => {
    const k = objectKey(T, 'imports');
    s3.on(HeadObjectCommand).resolvesOnce({ ContentType: XLSX_TYPE, ContentLength: 10 }).rejectsOnce(notFound()).rejectsOnce(new Error('boom'));
    expect(await d.head(k)).toEqual({ contentType: XLSX_TYPE, size: 10 });
    expect(await d.head(k)).toBeNull();
    await expect(d.head(k)).rejects.toThrow('boom');
  });
  it('delete; invalid keys never reach S3', async () => {
    s3.on(DeleteObjectCommand).resolves({});
    const k = objectKey(T, 'imports');
    await d.delete(k);
    expect(s3.commandCalls(DeleteObjectCommand)[0].args[0].input).toEqual({ Bucket: 'jw', Key: k });
    await expect(d.put('../x', Buffer.alloc(0), 'text/csv')).rejects.toThrow();
    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
  });
  it('client uses path-style addressing', async () => {
    const real = new S3Driver({ endpoint: 'http://garage.test:3900', region: 'garage', bucket: 'jw', accessKeyId: 'a', secretAccessKey: 'b' });
    expect(await real.client.config.forcePathStyle).toBe(true);
  });
});

describe('storage env (boot validation)', () => {
  it('defaults to local; s3 needs every S3_* var; errors name variables, never values', () => {
    expect(storageFromEnv({})).toBeInstanceOf(LocalDiskDriver);
    expect(() => storageFromEnv({ STORAGE_DRIVER: 'ftp' })).toThrow(/STORAGE_DRIVER/);
    let msg = '';
    try { storageFromEnv({ STORAGE_DRIVER: 's3', S3_ENDPOINT: 'http://g:3900', S3_SECRET_KEY: 'sekrit-value' }); } catch (e) { msg = String(e); }
    expect(msg).toMatch(/S3_REGION/); expect(msg).toMatch(/S3_BUCKET/); expect(msg).toMatch(/S3_ACCESS_KEY/); expect(msg).not.toMatch(/sekrit/);
    expect(storageFromEnv({ STORAGE_DRIVER: 's3', S3_ENDPOINT: 'http://g:3900', S3_REGION: 'garage', S3_BUCKET: 'jw', S3_ACCESS_KEY: 'a', S3_SECRET_KEY: 'b' }))
      .toBeInstanceOf(S3Driver);
  });
  it('FILE_TOKEN_SECRET: required in production / with s3, min 32 chars', () => {
    expect(fileTokenKeyFromEnv({})).toHaveLength(32);
    expect(() => fileTokenKeyFromEnv({ NODE_ENV: 'production' })).toThrow(/FILE_TOKEN_SECRET/);
    expect(() => fileTokenKeyFromEnv({ STORAGE_DRIVER: 's3' })).toThrow(/FILE_TOKEN_SECRET/);
    expect(() => fileTokenKeyFromEnv({ FILE_TOKEN_SECRET: 'short' })).toThrow(/FILE_TOKEN_SECRET/);
    expect(fileTokenKeyFromEnv({ FILE_TOKEN_SECRET: 'x'.repeat(40), NODE_ENV: 'production' }).toString()).toBe('x'.repeat(40));
  });
});

describe('file download tokens', () => {
  const key = Buffer.alloc(32, 7);
  const v = { tenantId: T, fileId: '0190a1b2-0000-7000-8000-000000000001', objectKey: `${T}/imports/0190a1b2-0000-7000-8000-000000000002` };
  it('round-trip; expires after 5 minutes', () => {
    const { token, expiresAt } = signFileToken(key, v, 1000);
    expect(expiresAt.getTime()).toBe(1300_000);
    expect(verifyFileToken(key, token, 1299)).toMatchObject({ ok: true, payload: { t: T, f: v.fileId, k: v.objectKey, p: 'file_download' } });
    expect(verifyFileToken(key, token, 1300)).toEqual({ ok: false, reason: 'expired' });
  });
  it('tampered payload, signature, other key, junk → invalid', () => {
    const { token } = signFileToken(key, v, 1000);
    const [b, s] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(b, 'base64url').toString()), t: '0190a1b2-ffff-7fff-8fff-ffffffffffff' })).toString('base64url');
    expect(verifyFileToken(key, `${forged}.${s}`, 1001).ok).toBe(false);
    expect(verifyFileToken(key, `${b}.${s.slice(0, -2)}AA`, 1001).ok).toBe(false);
    expect(verifyFileToken(Buffer.alloc(32, 8), token, 1001).ok).toBe(false);
    for (const j of ['', 'a', 'a.b.c', `${b}.`, `${b}.${s}!`]) expect(verifyFileToken(key, j, 1001)).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('file names (0.5.1)', () => {
  it('originalName: base name, no control chars, max 255 code points, fallback', () => {
    expect(originalName('C:\\x\\..\\a/b/ग्राहक.csv', 'text/csv')).toBe('ग्राहक.csv');
    expect(originalName('a\r\nb\u0000.csv', 'text/csv')).toBe('ab.csv');
    expect(originalName('  ', XLSX_TYPE)).toBe('upload.xlsx');
    expect(Array.from(originalName('€'.repeat(300), 'text/csv'))).toHaveLength(255);
  });
  it('contentDisposition: RFC 5987 filename*, ASCII fallback, no header injection', () => {
    expect(contentDisposition('d.csv')).toBe(`attachment; filename="d.csv"; filename*=UTF-8''d.csv`);
    const cd = contentDisposition('ग "x"\r\nSet-Cookie: a=b\\%\'(*).csv');
    expect(cd).not.toMatch(/[\r\n]/);
    expect(cd).toMatch(/^attachment; filename="[^"\\]*"; filename\*=UTF-8''[A-Za-z0-9%._~!-]+$/);
    expect(decodeURIComponent(cd.split("UTF-8''")[1])).toBe('ग "x"Set-Cookie: a=b\\%\'(*).csv');
  });
});
