import { mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DeleteObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { LocalDiskDriver, S3Driver, objectKey } from '@jw/storage';
import { isSweepable, sweepConfigFromEnv, sweepOrphans, type SweepConfig } from './orphan-sweep';

const T = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const NOW = new Date('2026-10-27T10:00:00Z');
const H = 3_600_000;
const cfg = (o: Partial<SweepConfig> = {}): SweepConfig => ({ graceMs: 24 * H, batch: 500, maxScan: 50_000, dryRun: false, prefix: '', ...o });
const none = async () => new Set<string>();
const quiet = () => undefined;

describe('config', () => {
  it('defaults: 24 h grace, dry run ON, batch 500; grace below 24 h refused', () => {
    expect(sweepConfigFromEnv({})).toEqual({ graceMs: 24 * H, batch: 500, maxScan: 50_000, dryRun: true, prefix: '' });
    expect(sweepConfigFromEnv({ ORPHAN_SWEEP_DRY_RUN: '0', ORPHAN_SWEEP_GRACE_HOURS: '48', ORPHAN_SWEEP_BATCH: '10' }))
      .toMatchObject({ dryRun: false, graceMs: 48 * H, batch: 10 });
    expect(() => sweepConfigFromEnv({ ORPHAN_SWEEP_GRACE_HOURS: '1' })).toThrow(/ORPHAN_SWEEP_GRACE_HOURS/);
    expect(() => sweepConfigFromEnv({ ORPHAN_SWEEP_DRY_RUN: 'maybe' })).toThrow(/ORPHAN_SWEEP_DRY_RUN/);
  });
  it('only import-area keys are sweepable', () => {
    expect(isSweepable(objectKey(T, 'imports'))).toBe(true);
    expect(isSweepable(`imports/${T}/${'a'.repeat(64)}.csv`)).toBe(true);
    expect(isSweepable(objectKey(T, 'attachments'))).toBe(false);
    expect(isSweepable('branding/logo.png')).toBe(false);
  });
});

describe('LocalDiskDriver sweep', () => {
  let dir = ''; let d: LocalDiskDriver;
  const at = async (key: string, ageH: number) => {
    await d.put(key, Buffer.from('x'), 'text/csv');
    const t = new Date(NOW.getTime() - ageH * H); await utimes(join(dir, key), t, t);
    return key;
  };
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'jw-sweep-')); d = new LocalDiskDriver(dir); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('deletes only old, unreferenced import objects; keeps young, referenced, other areas', async () => {
    const old = await at(objectKey(T, 'imports'), 30);
    const young = await at(objectKey(T, 'imports'), 23);
    const ref = await at(objectKey(T, 'imports'), 30);
    const other = await at(objectKey(T, 'attachments'), 100);
    const logs: string[] = [];
    const r = await sweepOrphans(d, async (keys) => new Set(keys.filter((k) => k === ref)), cfg(), NOW, (m) => logs.push(m));
    expect(r).toMatchObject({ status: 'ok', scanned: 4, tooYoung: 1, unrecognised: 1, candidates: 2, referenced: 1, deleted: 1 });
    expect(await d.head(old)).toBeNull();
    for (const k of [young, ref, other]) expect(await d.head(k)).not.toBeNull();
    expect(logs.join('')).not.toContain(T);                               // counts only, no keys / tenant ids
  });
  it('dry run deletes nothing', async () => {
    const old = await at(objectKey(T, 'imports'), 30);
    expect(await sweepOrphans(d, none, cfg({ dryRun: true }), NOW, quiet)).toMatchObject({ status: 'dry_run', wouldDelete: 1, deleted: 0 });
    expect(await d.head(old)).not.toBeNull();
  });
  it('reference check error → deletes nothing', async () => {
    const old = await at(objectKey(T, 'imports'), 30);
    const r = await sweepOrphans(d, async () => { throw new Error('permission denied'); }, cfg(), NOW, quiet);
    expect(r).toMatchObject({ status: 'reference_check_failed', deleted: 0 });
    expect(await d.head(old)).not.toBeNull();
  });
  it('bounded batch per run', async () => {
    for (let i = 0; i < 5; i++) await at(objectKey(T, 'imports'), 30);
    const r = await sweepOrphans(d, none, cfg({ batch: 2 }), NOW, quiet);
    expect(r).toMatchObject({ deleted: 2, truncated: true });
  });
  it('missing store dir is an empty listing', async () => {
    expect(await sweepOrphans(new LocalDiskDriver(join(dir, 'nope')), none, cfg(), NOW, quiet)).toMatchObject({ scanned: 0, deleted: 0 });
  });
});

describe('S3Driver sweep (aws-sdk-client-mock)', () => {
  const s3 = mockClient(S3Client);
  const client = new S3Client({ region: 'garage', endpoint: 'http://garage.test:3900', forcePathStyle: true, credentials: { accessKeyId: 'a', secretAccessKey: 'b' } });
  const d = new S3Driver({ endpoint: 'http://garage.test:3900', region: 'garage', bucket: 'jw', accessKeyId: 'a', secretAccessKey: 'b' }, client);
  beforeEach(() => s3.reset());
  const old = new Date(NOW.getTime() - 48 * H); const young = new Date(NOW.getTime() - H);

  it('follows ListObjectsV2 pagination and deletes unreferenced old objects', async () => {
    const [a, b, c] = [objectKey(T, 'imports'), objectKey(T, 'imports'), objectKey(T, 'imports')];
    s3.on(ListObjectsV2Command, { ContinuationToken: undefined }).resolves({ IsTruncated: true, NextContinuationToken: 'p2',
      Contents: [{ Key: a, Size: 1, LastModified: old }, { Key: b, Size: 1, LastModified: young }] });
    s3.on(ListObjectsV2Command, { ContinuationToken: 'p2' }).resolves({ IsTruncated: false, Contents: [{ Key: c, Size: 1, LastModified: old }] });
    s3.on(DeleteObjectCommand).resolves({});
    const r = await sweepOrphans(d, async () => new Set([c]), cfg(), NOW, quiet);
    expect(r).toMatchObject({ status: 'ok', scanned: 3, tooYoung: 1, referenced: 1, deleted: 1 });
    expect(s3.commandCalls(ListObjectsV2Command)).toHaveLength(2);
    expect(s3.commandCalls(DeleteObjectCommand).map((x) => x.args[0].input.Key)).toEqual([a]);
  });
  it('list error → list_failed, nothing deleted; delete errors are counted', async () => {
    s3.on(ListObjectsV2Command).rejects(new Error('down'));
    expect(await sweepOrphans(d, none, cfg(), NOW, quiet)).toMatchObject({ status: 'list_failed', deleted: 0 });
    expect(s3.commandCalls(DeleteObjectCommand)).toHaveLength(0);
    s3.reset();
    s3.on(ListObjectsV2Command).resolves({ IsTruncated: false, Contents: [{ Key: objectKey(T, 'imports'), LastModified: old }] });
    s3.on(DeleteObjectCommand).rejects(new Error('503'));
    expect(await sweepOrphans(d, none, cfg(), NOW, quiet)).toMatchObject({ deleted: 0, deleteErrors: 1 });
  });
});
