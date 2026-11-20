import { commitImportWithKey } from '@/lib/api/idempotent-commands';
import { uuid } from '@/lib/uuid';
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Upload } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Select } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ErrorText, OfflineBanner, PageHeader } from '@/components/page';
import { useT, useTk } from '@/i18n';
import { ApiError, ifMatch, ok } from '@/lib/api/fetcher';
import {
  createImport, createImportMappingProfile, deleteImportMappingProfile, getGetImportTemplateQueryKey, getImportTemplate,
  getListImportMappingProfilesQueryKey, listImportErrors, listImportMappingProfiles,
} from '@/lib/api/backend/import/import';
import type { CreateImportBody, ImportJob, ImportKind, ImportRowError } from '@/lib/api/backend/model';
import { useBranches } from '@/features/devices/devices';
import { formatDecimalIN } from '@/lib/format';
import { useOnline } from '@/lib/offline/connectivity';
import { applyProfile, detectProfile, fromServer, genericProfile, missingColumns, parseCsv, parseXlsx, toCsv, type MappingProfile, type Row } from './profiles';

const ENTITIES: readonly ImportKind[] = ['customers', 'stock', 'opening_balances'];
const n = (v: number) => formatDecimalIN(String(v), 0);

/** P21 import with mandatory dry run, mapping profiles, and an explicit commit. */
export function Importer({ kinds = ENTITIES }: { kinds?: readonly ImportKind[] } = {}) {
  const t = useT();
  const tk = useTk();
  const qc = useQueryClient();
  const online = useOnline();
  const branches = useBranches();
  const [entity, setEntity] = useState<ImportKind>(kinds[0] ?? 'customers');
  const [branchId, setBranchId] = useState('');
  // Template = CSV header row from the server; saved mapping profiles come from /v1/import-mapping-profiles.
  const template = useQuery({ queryKey: getGetImportTemplateQueryKey(entity), queryFn: () => ok(getImportTemplate(entity)) });
  const profKey = getListImportMappingProfilesQueryKey({ kind: entity });
  const serverProfiles = useQuery({ queryKey: profKey, queryFn: () => ok(listImportMappingProfiles({ kind: entity })) });
  const [file, setFile] = useState<{ name: string; raw: File; headers: string[]; rows: Row[] } | null>(null);
  const [allErrors, setAllErrors] = useState<ImportRowError[] | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftMap, setDraftMap] = useState<Record<string, string>>({});
  const [profileId, setProfileId] = useState<string>('');
  const [job, setJob] = useState<ImportJob | null>(null);
  const cols = useMemo(() => parseCsv(template.data ?? '').headers.map((h) => ({ key: h.replace(/\*$/, ''), required: h.endsWith('*') })), [template.data]);
  const keys = cols.map((c) => c.key);
  const required = cols.filter((c) => c.required).map((c) => c.key);
  const profiles = useMemo<MappingProfile[]>(() => [genericProfile(entity, keys), ...(serverProfiles.data ?? []).filter((p) => p.kind === entity).map(fromServer)],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entity, serverProfiles.data, keys.join()]);
  const profile = profiles.find((p) => p.id === profileId) ?? profiles[0];
  const missing = file && profile ? missingColumns(file.headers, profile, required) : [];
  const parseErr = useMutation({ mutationFn: async (f: File) => {
    const parsed = /\.xlsx$/i.test(f.name) ? await parseXlsx(f) : parseCsv(await f.text());
    setFile({ name: f.name, raw: f, ...parsed }); setJob(null); setAllErrors(null); setDraftMap({});
    setProfileId(detectProfile(parsed.headers, profiles)?.id ?? profiles[0]?.id ?? '');
  } });
  // Saved profile → upload the original file with profile_id (the server maps it). Generic → re-encode as a CSV in
  // our template's columns. The server always dry-runs first. Stock needs the branch it lands in.
  const needsBranch = entity === 'stock';
  const branch = branchId || branches.data?.[0]?.id || '';
  const dry = useMutation({ mutationFn: () => {
    const saved = profile && !profile.builtin ? profile : undefined;
    const blob = saved ? file?.raw : new File([toCsv(keys, profile ? applyProfile(file?.rows ?? [], profile) : [])], `${entity}.csv`, { type: 'text/csv' });
    return ok(createImport({ kind: entity, file: blob as unknown as CreateImportBody['file'], profile_id: saved?.id, branch_id: needsBranch ? branch || undefined : undefined }));
  }, onSuccess: (j) => { setJob(j); setAllErrors(null); } });
  const moreErrors = useMutation({ mutationFn: () => ok(listImportErrors(job?.id ?? '', { limit: 500 })), onSuccess: setAllErrors });
  const inval = () => void qc.invalidateQueries({ queryKey: profKey });
  const saveProfile = useMutation({
    mutationFn: () => ok(createImportMappingProfile({ kind: entity, name: draftName.trim(), mapping: Object.fromEntries(Object.entries(draftMap).filter(([, v]) => v)) })),
    onSuccess: (p) => { setDraftName(''); setDraftMap({}); setProfileId(p.id); inval(); },
  });
  // A profile used by an import job can't be deleted: 409 mapping_profile_in_use → friendly message via ErrorText.
  const delProfile = useMutation({
    mutationFn: (p: MappingProfile) => ok(deleteImportMappingProfile(p.id, ifMatch(p.version))),
    onSuccess: () => { setProfileId(''); inval(); },
    onError: (e) => { if (e instanceof ApiError && e.isStale) inval(); },
  });
  const errors = allErrors ?? job?.errors ?? [];
  const commit = useMutation({ mutationFn: () => commitImportWithKey(job?.id ?? '', uuid()), onSuccess: setJob });
  const download = () => {
    const url = URL.createObjectURL(new Blob([template.data ?? toCsv(keys)], { type: 'text/csv' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `${entity}-template.csv` });
    a.click(); URL.revokeObjectURL(url);
  };
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle>{t('import.step1')}</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <Field label={t('import.entity')}>{(id) => (
            <Select id={id} value={entity} onChange={(e) => { setEntity(e.target.value as ImportKind); setFile(null); setJob(null); }}>
              {kinds.map((x) => <option key={x} value={x}>{tk(`import.entity.${x}`)}</option>)}
            </Select>)}</Field>
          {needsBranch ? (
            <Field label={t('import.branch')}>{(id) => (
              <Select id={id} value={branch} onChange={(e) => { setBranchId(e.target.value); setJob(null); }}>
                {(branches.data ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </Select>)}</Field>) : null}
          <Button variant="outline" onClick={download} disabled={!keys.length}><Download className="mr-1 h-4 w-4" aria-hidden />{t('import.template')}</Button>
          <p className="w-full text-xs text-muted-foreground">{t('import.columns')}{': '}{cols.map((c) => `${c.key}${c.required ? '*' : ''}`).join(', ')}</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{t('import.step2')}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-dashed border-border px-4 py-3 text-sm hover:bg-muted">
            <Upload className="h-4 w-4" aria-hidden />{file ? file.name : t('import.choose')}
            <input type="file" accept=".csv,.xlsx" className="sr-only" data-testid="import-file" onChange={(e) => { const f = e.target.files?.[0]; if (f) parseErr.mutate(f); }} />
          </label>
          <ErrorText error={parseErr.error} />
          {file ? (
            <div className="grid gap-3 md:grid-cols-2">
              <Field label={t('import.profile')} hint={t('import.profileHint')}>{(id, d) => (
                <Select id={id} aria-describedby={d} value={profile?.id ?? ''} onChange={(e) => { setProfileId(e.target.value); setJob(null); }}>
                  {profiles.map((p) => <option key={p.id} value={p.id}>{p.builtin ? t('import.generic') : p.name}</option>)}
                </Select>)}</Field>
              <div className="text-sm">
                <p>{t('import.rowsRead', { n: n(file.rows.length) })}</p>
                {missing.length ? <p className="text-destructive">{t('import.missing', { cols: missing.join(', ') })}</p> : null}
                {profile && !profile.builtin ? (
                  <Button size="sm" variant="ghost" className="mt-1" disabled={!online || delProfile.isPending}
                    onClick={() => { if (window.confirm(t('import.profileDeleteConfirm', { name: profile.name }))) delProfile.mutate(profile); }}>{t('import.profileDelete')}</Button>) : null}
                <ErrorText error={delProfile.error} />
              </div>
            </div>
          ) : null}
          {file && missing.length ? (
            <details className="rounded-md border border-border p-3 text-sm" data-testid="profile-editor">
              <summary className="cursor-pointer font-medium">{t('import.profileNew')}</summary>
              <div className="mt-3 grid gap-2 md:grid-cols-2">
                {cols.map((c) => (
                  <Field key={c.key} label={`${c.key}${c.required ? '*' : ''}`}>{(id) => (
                    <Select id={id} value={draftMap[c.key] ?? ''} onChange={(e) => setDraftMap({ ...draftMap, [c.key]: e.target.value })}>
                      <option value="">{'—'}</option>
                      {file.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                    </Select>)}</Field>))}
                <Field label={t('import.profileName')}>{(id) => <Input id={id} maxLength={80} value={draftName} onChange={(e) => setDraftName(e.target.value)} />}</Field>
              </div>
              <ErrorText error={saveProfile.error} />
              <Button size="sm" className="mt-2" disabled={!online || !draftName.trim() || required.some((k) => !draftMap[k]) || saveProfile.isPending}
                onClick={() => saveProfile.mutate()}>{t('import.profileSave')}</Button>
            </details>
          ) : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{t('import.step3')}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button disabled={!online || !file || missing.length > 0 || (needsBranch && !branch) || dry.isPending} onClick={() => dry.mutate()} data-testid="import-dry-run">{t('import.dryRun')}</Button>
            <Button disabled={!online || !job || !job.dry_run || job.status !== 'validated' || commit.isPending} onClick={() => commit.mutate()}>{t('import.commit', { n: n(job?.ok_rows ?? 0) })}</Button>
          </div>
          <ErrorText error={dry.error ?? commit.error} />
          {job ? (
            <div className="space-y-2 text-sm" data-testid="import-result">
              <Badge variant={job.status === 'failed' ? 'destructive' : 'success'}>{tk(`import.status.${job.status}`)}</Badge>
              <p>{t('import.summary', { total: n(job.total_rows ?? 0), valid: n(job.ok_rows ?? 0), errors: n(job.error_rows ?? job.errors?.length ?? 0) })}</p>
              {errors.length ? (
                <table className="w-full text-xs"><thead><tr className="text-left text-muted-foreground"><th>{t('import.row')}</th><th>{t('import.column')}</th><th>{t('import.code')}</th><th>{t('import.problem')}</th></tr></thead>
                  <tbody>{errors.map((e) => <tr key={`${e.row}${e.column ?? ''}${e.code}`}><td className="tabular-nums">{e.row}</td><td className="font-mono">{e.column ?? ''}</td><td className="font-mono">{e.code}</td><td>{e.message}</td></tr>)}</tbody></table>
              ) : null}
              {!allErrors && (job.error_rows ?? 0) > (job.errors?.length ?? 0) ? (
                <Button size="sm" variant="outline" disabled={!online || moreErrors.isPending} onClick={() => moreErrors.mutate()}>{t('import.allErrors')}</Button>) : null}
              <ErrorText error={moreErrors.error} />
              {job.status === 'failed' ? <p className="text-muted-foreground">{t('import.fixAndRetry')}</p> : null}
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

export function ImportPage() {
  const t = useT();
  return <div><PageHeader title={t('import.title')} description={t('import.description')} /><OfflineBanner /><Importer /></div>;
}
