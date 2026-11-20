/** @jw/storage: object storage drivers (local disk, S3/Garage), shared by the API and the worker. */
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { z } from 'zod';

/** Object metadata kept next to the bytes (S3 object metadata / a local sidecar file). */
export interface ObjectMeta { contentType: string; size: number }
export interface StoredObject extends ObjectMeta { body: Readable }
/** One listed object (list() yields every key under the prefix, any shape; callers validate with isObjectKey). */
export interface ListedObject { key: string; size: number; lastModified: Date }
/** Object storage. Keys are `<tenant_id>/<area>/<uuid>` (see objectKey); legacy local keys `imports/<tenant>/<sha>.<ext>` still read. */
export interface StorageService {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** null when the object does not exist. */
  get(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
  head(key: string): Promise<ObjectMeta | null>;
  /** Every object whose key starts with prefix ('' = all), paged internally. */
  list(prefix: string): AsyncIterable<ListedObject>;
}
export const STORAGE_AREAS = ['imports', 'exports', 'attachments'] as const;
export type StorageArea = (typeof STORAGE_AREAS)[number];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[0-9a-f-]{36}\/[a-z_]{1,30}\/[0-9a-f-]{36}$/i;
const LEGACY = /^imports\/[0-9a-f-]{36}\/[0-9a-f]{64}\.(csv|xlsx)$/i;

export function objectKey(tenantId: string, area: StorageArea): string {
  if (!UUID.test(tenantId)) throw new Error('objectKey: tenant id must be a uuid');
  return `${tenantId.toLowerCase()}/${area}/${randomUUID()}`;
}
/** Only well-formed keys reach a driver (no path traversal, no bucket-wide keys). */
export function assertKey(key: string): void {
  if (!isObjectKey(key)) throw new Error('storage: invalid object key');
}
export const isObjectKey = (key: string): boolean => KEY.test(key) || LEGACY.test(key);
const isNotFound = (e: unknown) => {
  const x = e as { name?: string; code?: string; $metadata?: { httpStatusCode?: number } };
  return x?.code === 'ENOENT' || x?.name === 'NoSuchKey' || x?.name === 'NotFound' || x?.$metadata?.httpStatusCode === 404;
};
const legacyType = (key: string) => (/\.xlsx$/i.test(key) ? XLSX_TYPE : 'text/csv');
export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Current behaviour: files under FILE_STORE_DIR (default ./.files); content type in `<key>.meta.json`. */
export class LocalDiskDriver implements StorageService {
  private readonly root: string;
  constructor(root: string) { this.root = resolve(root); }
  private path(key: string) {
    assertKey(key);
    const p = resolve(join(this.root, key));
    if (!p.startsWith(this.root + sep)) throw new Error('storage: invalid object key');
    return p;
  }
  async put(key: string, body: Buffer, contentType: string) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body);
    await writeFile(`${p}.meta.json`, JSON.stringify({ contentType }));
  }
  async head(key: string): Promise<ObjectMeta | null> {
    const p = this.path(key);
    try {
      const s = await stat(p);
      let contentType = legacyType(key);
      try { contentType = String(JSON.parse(await readFile(`${p}.meta.json`, 'utf8')).contentType ?? contentType); } catch { /* legacy: no sidecar */ }
      return { contentType, size: s.size };
    } catch (e) { if (isNotFound(e)) return null; throw e; }
  }
  async get(key: string): Promise<StoredObject | null> {
    const m = await this.head(key);
    return m ? { ...m, body: createReadStream(this.path(key)) } : null;
  }
  async delete(key: string) {
    const p = this.path(key);
    await rm(p, { force: true }); await rm(`${p}.meta.json`, { force: true });
  }
  async *list(prefix: string): AsyncIterable<ListedObject> {
    const walk = async function* (dir: string): AsyncGenerator<string> {
      let ents;
      try { ents = await readdir(dir, { withFileTypes: true }); } catch (e) { if (isNotFound(e)) return; throw e; }
      for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
        const p = join(dir, e.name);
        if (e.isDirectory()) yield* walk(p); else if (e.isFile() && !e.name.endsWith('.meta.json')) yield p;
      }
    };
    for await (const p of walk(this.root)) {
      const key = relative(this.root, p).split(sep).join('/');
      if (!key.startsWith(prefix)) continue;
      const s = await stat(p).catch(() => null);
      if (s) yield { key, size: s.size, lastModified: s.mtime };
    }
  }
}

export interface S3Config { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string }
/** S3-compatible storage (Garage). Path-style addressing: bucket in the path, not in the host name. */
export class S3Driver implements StorageService {
  readonly client: S3Client;
  constructor(private readonly cfg: S3Config, client?: S3Client) {
    this.client = client ?? new S3Client({ endpoint: cfg.endpoint, region: cfg.region, forcePathStyle: true,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey } });
  }
  async put(key: string, body: Buffer, contentType: string) {
    assertKey(key);
    await this.client.send(new PutObjectCommand({ Bucket: this.cfg.bucket, Key: key, Body: body, ContentType: contentType, ContentLength: body.length }));
  }
  async head(key: string): Promise<ObjectMeta | null> {
    assertKey(key);
    try {
      const r = await this.client.send(new HeadObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
      return { contentType: r.ContentType ?? 'application/octet-stream', size: Number(r.ContentLength ?? 0) };
    } catch (e) { if (isNotFound(e)) return null; throw e; }
  }
  async get(key: string): Promise<StoredObject | null> {
    assertKey(key);
    try {
      const r = await this.client.send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
      if (!r.Body) return null;
      const b = r.Body as unknown;
      const body = b instanceof Readable ? b : Readable.from(Buffer.from(await (b as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray()));
      return { body, contentType: r.ContentType ?? 'application/octet-stream', size: Number(r.ContentLength ?? 0) };
    } catch (e) { if (isNotFound(e)) return null; throw e; }
  }
  async delete(key: string) {
    assertKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
  }
  /** ListObjectsV2, following ContinuationToken until IsTruncated is false. */
  async *list(prefix: string): AsyncIterable<ListedObject> {
    let token: string | undefined;
    do {
      const r = await this.client.send(new ListObjectsV2Command({ Bucket: this.cfg.bucket, Prefix: prefix || undefined, ContinuationToken: token, MaxKeys: 1000 }));
      for (const o of r.Contents ?? []) if (o.Key) yield { key: o.Key, size: Number(o.Size ?? 0), lastModified: o.LastModified ?? new Date(0) };
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
  }
}

export async function readAll(s: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of s) parts.push(Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array));
  return Buffer.concat(parts);
}

const nonEmpty = z.string().trim().min(1);
const StorageEnv = z.discriminatedUnion('STORAGE_DRIVER', [
  z.object({ STORAGE_DRIVER: z.literal('local'), FILE_STORE_DIR: nonEmpty.optional() }),
  z.object({ STORAGE_DRIVER: z.literal('s3'), S3_ENDPOINT: z.string().url(), S3_REGION: nonEmpty, S3_BUCKET: nonEmpty,
             S3_ACCESS_KEY: nonEmpty, S3_SECRET_KEY: nonEmpty }),
]);

/** Boot-time validation (throws listing the bad variable NAMES only, never values). STORAGE_DRIVER defaults to local. */
export function storageFromEnv(env: NodeJS.ProcessEnv = process.env): StorageService {
  const r = StorageEnv.safeParse({ ...env, STORAGE_DRIVER: env.STORAGE_DRIVER || 'local' });
  if (!r.success) throw new Error(`invalid storage env: ${[...new Set(r.error.issues.map((i) => i.path.join('.')))].join(', ')}`);
  const e = r.data;
  if (e.STORAGE_DRIVER === 'local') return new LocalDiskDriver(e.FILE_STORE_DIR ?? join(process.cwd(), '.files'));
  return new S3Driver({ endpoint: e.S3_ENDPOINT, region: e.S3_REGION, bucket: e.S3_BUCKET, accessKeyId: e.S3_ACCESS_KEY, secretAccessKey: e.S3_SECRET_KEY });
}

