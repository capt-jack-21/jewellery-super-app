import { useCallback, useDeferredValue, useMemo, useState, type ReactNode } from 'react';
import { keepPreviousData, useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Eye, Pencil, Plus, Search } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { Drawer } from '@/components/ui/drawer';
import { Check, Field, Select } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ErrorText, EditGate, Loading, OfflineBanner, PageHeader } from '@/components/page';
import { useT, useTk } from '@/i18n';
import { ApiError, ok } from '@/lib/api/fetcher';
import { useRetryCountdown } from '@/lib/api/rate-limit';
import { useAttemptKey } from '@/lib/api/attempt-key';
import { listMetals, listPurities } from '@/lib/api/backend/masters/masters';
import { listBranches, listCompanies, listCompanyBankAccounts } from '@/lib/api/backend/tenant/tenant';
import { formatDateTimeIN, formatDecimalIN, formatIdentifier, formatPercent } from '@/lib/format';
import { useOnline } from '@/lib/offline/connectivity';
import { useCan, useSignedIn } from '@/lib/session';
import { mastersApi, mastersKeys } from './api';
import { fieldErrors } from './errors';
import { maskLast4 } from './mask';
import { codeFrom, editPermOf, FIELD_GROUPS, labelKey, defaultsFor, getPath, MASTERS, normaliseInput, rowTitle, toBody, validateInput, type FieldDef, type MasterConfig, type RefTarget } from './registry';
import type { FieldValue, ListParams, MasterInput, MasterKind, MasterRow } from './types';

export interface Opt { value: string; label: string }
type Refs = Partial<Record<RefTarget, Opt[]>>;
const isNotReady = (e: unknown) => e instanceof ApiError && e.status === 404;

/** Small, fixed lists (metals, purities, branches, bank accounts) load whole; other masters use type-ahead search. */
const SMALL_REFS = new Set<RefTarget>(['metal', 'purity', 'branch']);
export const isSearchRef = (t: RefTarget) => !SMALL_REFS.has(t);
const splitRef = (t: RefTarget) => t.split(':') as [MasterKind, string | undefined];
const optFor = (kind: MasterKind, r: MasterRow): Opt =>
  ({ value: r.id, label: [getPath(r, 'code'), rowTitle(MASTERS[kind], r)].filter((x, i, a) => x && a.indexOf(x) === i).join(' · ') });
/** Type-ahead page size: enough to pick from while typing; the user narrows with `q` instead of scrolling. */
export const PICKER_LIMIT = 20;

async function smallOptions(t: RefTarget): Promise<Opt[]> {
  if (t === 'metal') return (await ok(listMetals())).map((m) => ({ value: m.id, label: m.name }));
  if (t === 'purity') return (await ok(listPurities())).map((p) => ({ value: p.id, label: p.code }));
  if (t === 'branch') return (await ok(listBranches())).map((b) => ({ value: b.id, label: b.name }));
  return bankOptions({});
}
/** G20 (0.7.3): settlement bank picker — GET /v1/companies/{id}/bank-accounts with q (search) or ids (labels). Active only for search. */
export async function bankOptions(p: { q?: string; ids?: string[] }): Promise<Opt[]> {
  const companies = await ok(listCompanies());
  const params = { ...(p.q ? { q: p.q } : {}), ...(p.ids?.length ? { ids: p.ids } : {}) };
  const lists = await Promise.all(companies.map((c) => ok(listCompanyBankAccounts(c.id, params))));
  return lists.flat().filter((b) => b.is_active || !!p.ids).map((b) => ({ value: b.id, label: `${b.bank_name} ··${b.account_last4 ?? ''}` }));
}
const notReadyEmpty = <T,>(fallback: T) => (e: unknown): T => { if (isNotReady(e)) return fallback; throw e; };

/**
 * Labels for ref fields. Small lists load whole. For searchable masters, list rows (0.7.1) carry
 * `labels: {<ref field>: {code, name}}` — used as-is; ids still unlabelled are resolved with ONE batch `?ids=` call
 * per target (chunked by 100), not one GET per id.
 */
export function useRefOptions(cfg: MasterConfig, rows: readonly MasterRow[] = []): Refs {
  const signedIn = useSignedIn();
  const targets = useMemo(() => [...new Set(cfg.fields.flatMap((f) => (f.type === 'ref' && f.ref ? [f.ref] : [])))], [cfg]);
  const small = targets.filter((t) => !isSearchRef(t));
  const { labelled, missing } = useMemo(() => {
    const refFields = cfg.fields.filter((f) => f.type === 'ref' && f.ref && isSearchRef(f.ref));
    const lab = new Map<RefTarget, Map<string, Opt>>();
    const need = new Map<RefTarget, Set<string>>();
    for (const r of rows) for (const f of refFields) {
      const v = getPath(r, f.key); const t = f.ref as RefTarget;
      if (typeof v !== 'string' || !v) continue;
      const l = (r.labels as Record<string, { code: string | null; name: string } | undefined> | undefined)?.[f.key];
      if (l) { const m = lab.get(t) ?? new Map<string, Opt>(); m.set(v, { value: v, label: labelText(l.code, l.name) }); lab.set(t, m); }
      else (need.get(t) ?? need.set(t, new Set()).get(t) as Set<string>).add(v);
    }
    for (const [t, ids] of need) for (const id of [...ids]) if (lab.get(t)?.has(id)) ids.delete(id);
    return { labelled: lab, missing: [...need].filter(([, ids]) => ids.size).map(([t, ids]) => [t, [...ids].sort()] as const) };
  }, [cfg, rows]);
  const smallQ = useQueries({ queries: small.map((t) => ({
    queryKey: ['masters', 'ref', t] as const, enabled: signedIn, staleTime: 60_000, retry: false,
    queryFn: () => smallOptions(t).catch(notReadyEmpty<Opt[]>([])),
  })) });
  const idsQ = useQueries({ queries: missing.map(([t, ids]) => ({
    queryKey: ['masters', 'ref', 'ids', t, ids] as const, enabled: signedIn, staleTime: 60_000, retry: false,
    queryFn: () => {
      if (t === 'bank_account') return bankOptions({ ids: [...ids] });
      const [kind, sub] = splitRef(t);
      return mastersApi.byIds(kind, ids, sub ? { kind: sub } : {}).then((rs) => rs.map((r) => optFor(kind, r))).catch(notReadyEmpty<Opt[]>([]));
    },
  })) });
  const out: Refs = Object.fromEntries(small.map((t, i) => [t, smallQ[i]?.data ?? []]));
  for (const [t, m] of labelled) out[t] = [...(out[t] ?? []), ...m.values()];
  missing.forEach(([t], i) => { out[t] = [...(out[t] ?? []), ...(idsQ[i]?.data ?? [])]; });
  return out;
}
const labelText = (code: string | null | undefined, name: string) => [code, name].filter((x, i, a) => x && a.indexOf(x) === i).join(' · ');

/** Type-ahead picker for another master: a search box (contract `q`) and the matching rows. */
export function RefPicker({ target, value, known, onChange, label, id, describedBy, allLabel, required }: {
  target: RefTarget; value: string; known: Opt[]; onChange: (v: string | null) => void; label: string;
  id?: string; describedBy?: string; allLabel?: string; required?: boolean;
}) {
  const t = useT();
  const signedIn = useSignedIn();
  const [q, setQ] = useState('');
  const dq = useDeferredValue(q.trim());
  const [kind, sub] = splitRef(target);
  const res = useQuery({
    queryKey: ['masters', 'ref', 'search', target, dq] as const, enabled: signedIn, staleTime: 30_000, retry: false, placeholderData: keepPreviousData,
    // Pickers offer active rows only (card machine cash counter: 422 inactive_master otherwise).
    queryFn: () => (target === 'bank_account' ? bankOptions({ q: dq || undefined }) : mastersApi.list(kind, { q: dq || undefined, limit: String(PICKER_LIMIT), ...(sub ? { kind: sub } : {}) })
      .then((p) => p.items.filter((r) => r.is_active !== false).map((r) => optFor(kind, r)))).catch(notReadyEmpty<Opt[]>([])),
  });
  const found = res.data ?? [];
  const current = value && !found.some((o) => o.value === value) ? known.find((o) => o.value === value) ?? { value, label: '…' } : null;
  return (
    <div className="flex flex-wrap gap-2" data-testid={`picker-${target}`}>
      <Input type="search" className="min-w-32 flex-1" value={q} onChange={(e) => setQ(e.target.value)}
        aria-label={t('masters.pickerSearch', { field: label })} placeholder={t('masters.pickerSearch', { field: label })} />
      <Select id={id} aria-describedby={describedBy} aria-label={id ? undefined : label} className="min-w-40 flex-1" value={value} onChange={(e) => onChange(e.target.value || null)}>
        {required && value ? null : <option value="">{allLabel ?? t('common.choose')}</option>}
        {current ? <option value={current.value}>{current.label}</option> : null}
        {found.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </Select>
      {found.length >= PICKER_LIMIT ? <p className="w-full text-xs text-muted-foreground">{t('masters.pickerMore')}</p> : null}
    </div>
  );
}

export function optionsFor(f: FieldDef, refs: Refs, tk: (k: string) => string): Opt[] {
  if (f.type === 'ref') return refs[f.ref as RefTarget] ?? [];
  return (f.options ?? []).map((o) => ({ value: o, label: tk(`masters.o.${f.optionsKey ?? f.key}.${o}`) }));
}

export function useDisplay(cfg: MasterConfig, refs: Refs) {
  const t = useT();
  const tk = useTk();
  return useCallback((f: FieldDef, row: MasterRow): string => {
    if (f.type === 'secret') return maskLast4(f.last4Key ? (row[f.last4Key] as string | null) : null);
    const v = getPath(row, f.key);
    if (v === null || v === undefined || v === '') return '';
    if (f.type === 'bool') return t(v ? 'masters.yes' : 'masters.no');
    if (Array.isArray(v)) return v.map((x) => tk(`masters.o.${f.optionsKey ?? f.key}.${String(x)}`)).join(', ');
    if (typeof v === 'number') return formatDecimalIN(String(v), 0);
    if (typeof v !== 'string') return '';
    if (f.type === 'ref') return refs[f.ref as RefTarget]?.find((o) => o.value === v)?.label ?? '';
    if (f.type === 'select') return tk(`masters.o.${f.optionsKey ?? f.key}.${v}`);
    if (f.type === 'decimal') return cfg.percentKeys?.includes(f.key) || f.max === '100' ? formatPercent(v, f.dp ?? 2) : formatDecimalIN(v, f.dp ?? 2);
    if (f.type === 'phone') return formatIdentifier('phone', v);
    return v;
  }, [cfg, refs, t, tk]);
}

/** Cover thumbnail: photos are platform.file ids; the URL is short-lived, so it is fetched on demand. */
export function PhotoThumb({ fileId, alt, className }: { fileId: string; alt: string; className?: string }) {
  const url = useQuery({ queryKey: ['files', fileId, 'url'], queryFn: () => mastersApi.fileUrl(fileId), staleTime: 4 * 60_000, retry: false });
  return url.data ? <img src={url.data} alt={alt} className={className} /> : <span className={`block bg-muted ${className ?? ''}`} role="img" aria-label={alt} />;
}

/**
 * The ONE list-and-form screen, configured per master (registry.ts): search, filters, active/all, TanStack Table with
 * "load more" (keyset cursor), add/edit drawer. `extra` renders master-specific panels in the drawer (design photos).
 */
export function MasterScreen({ kind, extra }: { kind: MasterKind; extra?: (row: MasterRow, update: (r: MasterRow) => void) => ReactNode }) {
  const t = useT();
  const tk = useTk();
  const cfg = MASTERS[kind];
  const signedIn = useSignedIn();
  const can = useCan();
  const [q, setQ] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<MasterRow | 'new' | null>(null);
  const params: ListParams = { q: q.trim() || undefined, include_inactive: includeInactive || undefined, ...filters };
  const list = useInfiniteQuery({
    queryKey: mastersKeys.list(kind, params), enabled: signedIn, placeholderData: keepPreviousData, retry: (n, e) => !isNotReady(e) && n < 2,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => mastersApi.list(kind, { ...params, cursor: pageParam }),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const refs = useRefOptions(cfg, rows);
  const show = useDisplay(cfg, refs);
  const canEdit = can(editPermOf(kind));
  const columns = useMemo<Array<ColumnDef<MasterRow>>>(() => [
    ...(cfg.photos ? [{ id: 'photo', header: () => <span className="sr-only">{t('masters.photos')}</span>, cell: ({ row }) => {
      const cover = row.original.primary_photo_file_id as string | null | undefined;
      return cover ? <PhotoThumb fileId={cover} alt="" className="h-10 w-10 rounded object-cover" /> : <span className="block h-10 w-10 rounded bg-muted" aria-hidden />;
    } } satisfies ColumnDef<MasterRow>] : []),
    ...cfg.columns.map((key): ColumnDef<MasterRow> => {
      const f = cfg.fields.find((x) => x.key === key) as FieldDef;
      return { id: key, header: tk(labelKey(cfg.kind, key)), cell: ({ row }) => <span className={f.type === 'secret' || f.type === 'code' ? 'font-mono' : undefined}>{show(f, row.original)}</span> };
    }),
    { id: 'status', header: t('common.status'), cell: ({ row }) => <Badge variant={row.original.is_active ? 'success' : 'outline'}>{t(row.original.is_active ? 'common.active' : 'common.inactive')}</Badge> },
    { id: 'actions', header: () => <span className="sr-only">{t('common.edit')}</span>, cell: ({ row }) => (
      <Button size="sm" variant="outline" onClick={() => setEditing(row.original)} aria-label={`${t(canEdit ? 'common.edit' : 'masters.view')} ${rowTitle(cfg, row.original)}`}>
        {canEdit ? <Pencil className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </Button>
    ) },
  ], [cfg, show, t, tk, canEdit]);
  const filterFields = cfg.fields.filter((f) => f.filter);
  return (
    <div className="space-y-4" data-testid={`master-${kind}`}>
      <PageHeader title={tk(`masters.${kind}.title`)} description={tk(`masters.${kind}.desc`)}
        actions={<Button onClick={() => setEditing('new')} disabled={!canEdit || isNotReady(list.error)}><Plus className="mr-1 h-4 w-4" />{tk(`masters.${kind}.add`)}</Button>} />
      <OfflineBanner />
      {canEdit ? null : <p role="note" data-testid="view-only-note" className="rounded-md border border-border bg-muted p-2 text-sm text-muted-foreground">{t('masters.viewOnly')}</p>}
      <div className="flex flex-wrap items-end gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input type="search" className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('masters.search')} aria-label={t('masters.search')} />
        </div>
        {filterFields.map((f) => f.type === 'ref' && f.ref && isSearchRef(f.ref) ? (
          <div key={f.key} className="w-72"><RefPicker target={f.ref} value={filters[f.param ?? f.key] ?? ''} known={refs[f.ref] ?? []} label={tk(labelKey(cfg.kind, f.key))}
            allLabel={t('masters.allOf', { field: tk(labelKey(cfg.kind, f.key)) })} onChange={(v) => setFilters((p) => ({ ...p, [f.param ?? f.key]: v ?? '' }))} /></div>
        ) : (
          <Select key={f.key} className="w-auto" aria-label={tk(labelKey(cfg.kind, f.key))} value={filters[f.param ?? f.key] ?? ''}
            onChange={(e) => setFilters((p) => ({ ...p, [f.param ?? f.key]: e.target.value }))}>
            <option value="">{t('masters.allOf', { field: tk(labelKey(cfg.kind, f.key)) })}</option>
            {optionsFor(f, refs, tk).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
        ))}
        <Select className="w-auto" aria-label={t('common.status')} value={includeInactive ? 'all' : 'active'} onChange={(e) => setIncludeInactive(e.target.value === 'all')}>
          <option value="active">{t('masters.status.active')}</option>
          <option value="all">{t('masters.status.all')}</option>
        </Select>
      </div>
      {isNotReady(list.error) ? <p role="note" data-testid="not-ready" className="rounded-md border border-border bg-muted p-3 text-sm">{t('masters.notReady')}</p>
        : list.error ? <ErrorText error={list.error} />
        : list.isLoading ? <Loading />
        : <DataTable columns={columns} data={rows} caption={tk(`masters.${kind}.title`)} empty={t(q || Object.values(filters).some(Boolean) ? 'masters.noMatch' : 'masters.emptyAdd')} />}
      {list.hasNextPage ? (
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>{t('masters.loadMore')}</Button>
        </div>
      ) : null}
      <MasterDrawer cfg={cfg} editing={editing} refs={refs} onClose={() => setEditing(null)} onSaved={(r) => setEditing(r)} extra={extra} />
    </div>
  );
}

const toForm = (cfg: MasterConfig, row: MasterRow | null): MasterInput => {
  if (!row) return defaultsFor(cfg);
  return Object.fromEntries(cfg.fields.filter((f) => f.type !== 'secret').map((f) => {
    const v = f.fromRow ? f.fromRow(row) : getPath(row, f.key);
    const val: FieldValue = typeof v === 'number' ? String(v) : (v as FieldValue | undefined) ?? (f.type === 'bool' ? false : f.type === 'multi' ? [] : null);
    return [f.key, val];
  }));
};
const same = (a: FieldValue | undefined, b: FieldValue | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function MasterDrawer({ cfg, editing, refs, onClose, onSaved, extra }: {
  cfg: MasterConfig; editing: MasterRow | 'new' | null; refs: Refs;
  onClose: () => void; onSaved: (r: MasterRow) => void; extra?: (row: MasterRow, update: (r: MasterRow) => void) => ReactNode;
}) {
  const t = useT();
  const tk = useTk();
  const row = editing === 'new' ? null : editing;
  const title = row ? rowTitle(cfg, row) || t('masters.edit') : tk(`masters.${cfg.kind}.add`);
  // Form is keyed by row id: a newer version (save, photo change) updates If-Match without wiping what was typed.
  return (
    <Drawer open={editing !== null} title={title} closeLabel={t('common.cancel')} onClose={onClose}>
      {editing !== null ? <MasterForm key={row ? row.id : 'new'} cfg={cfg} row={row} refs={refs} onClose={onClose} onSaved={onSaved} /> : null}
      {row && extra ? extra(row, onSaved) : null}
    </Drawer>
  );
}

export function MasterForm({ cfg, row, refs, onClose, onSaved, preset, editPerm }: {
  cfg: MasterConfig; row: MasterRow | null; refs: Refs; onClose: () => void; onSaved: (r: MasterRow) => void;
  /** Values for `hidden` fields (KYC document party) — always sent on create, never shown. */
  preset?: MasterInput; editPerm?: string;
}) {
  const t = useT();
  const tk = useTk();
  const qc = useQueryClient();
  const online = useOnline();
  const initial = useMemo(() => ({ ...toForm(cfg, row), ...(row ? {} : preset) }), [cfg, row, preset]);
  const [values, setValues] = useState<MasterInput>(initial);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [clientErrs, setClientErrs] = useState<Record<string, string>>({});
  const attempt = useAttemptKey();
  // A changed body must not reuse a key (backend: 422 idempotency_key_reused).
  const set = (k: string, v: FieldValue) => { attempt.reset(); setValues((p) => ({ ...p, [k]: v })); };
  const hasCode = cfg.fields.some((f) => f.key === 'code' && f.type === 'code');
  const save = useMutation({
    mutationFn: () => {
      const typed: MasterInput = { ...values, ...Object.fromEntries(Object.entries(secrets).filter(([, v]) => v.trim())) };
      // New rows: suggest the code from the name when the user left it blank.
      if (!row && hasCode && !String(typed.code ?? '').trim() && typeof typed.name === 'string') typed.code = codeFrom(typed.name) || null;
      const body = normaliseInput(cfg, typed);
      const errs = validateInput(cfg, body, !!row);
      setClientErrs(errs);
      if (Object.keys(errs).length) return Promise.reject(new ApiError(422, 'validation_failed', t('masters.fixFields')));
      if (!row) return mastersApi.create(cfg.kind, toBody(cfg, body, true) as MasterInput, attempt.take());
      const changed = Object.keys(body).filter((k) => !same(body[k], initial[k]) || k in secrets);
      // A nested object (address) is sent whole, so changing one line never blanks the others.
      const groups = new Set(changed.filter((k) => k.includes('.')).map((k) => k.split('.')[0]));
      const keys = Object.keys(body).filter((k) => changed.includes(k) || groups.has(k.split('.')[0] as string));
      return mastersApi.update(cfg.kind, row, toBody(cfg, Object.fromEntries(keys.map((k) => [k, body[k] ?? null])), false) as MasterInput);
    },
    onSuccess: (r) => { attempt.reset(); void qc.invalidateQueries({ queryKey: mastersKeys.kind(cfg.kind) }); void qc.invalidateQueries({ queryKey: ['masters', 'ref'] }); onSaved(r); },
    onError: (e) => { attempt.settle(e); if (e instanceof ApiError && e.isStale) void qc.invalidateQueries({ queryKey: mastersKeys.kind(cfg.kind) }); },
  });
  const toggle = useMutation({
    mutationFn: () => mastersApi.setActive(cfg.kind, row as MasterRow, !(row as MasterRow).is_active),
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: mastersKeys.kind(cfg.kind) }); void qc.invalidateQueries({ queryKey: ['masters', 'ref'] }); onSaved(r); },
  });
  const wait = useRetryCountdown(save.error);
  const serverErrs = fieldErrors(cfg, save.error, tk);
  const errFor = (k: string) => { const c = clientErrs[k] ?? serverErrs[k]; return c ? (clientErrs[k] ? tk(`masters.err.${c}`) : c) : null; };
  const shown = (f: FieldDef) => !f.hidden && !(row && f.createOnly);
  const basic = cfg.fields.filter((f) => !f.advanced && !f.group && shown(f));
  const advanced = cfg.fields.filter((f) => f.advanced && !f.group && shown(f));
  const grouped = FIELD_GROUPS.map((g) => [g, cfg.fields.filter((f) => f.group === g)] as const).filter(([, fs]) => fs.length);
  const fieldEl = (f: FieldDef) => <FieldInput key={f.key} kind={cfg.kind} f={f} row={row} value={values[f.key] ?? null} secret={secrets[f.key]} refs={refs} error={errFor(f.key)}
    onChange={(v) => set(f.key, v)} onSecret={(v) => setSecrets((p) => ({ ...p, [f.key]: v }))} />;
  return (
    <EditGate perm={editPerm ?? editPermOf(cfg.kind)}>
      <form className="space-y-4" noValidate onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        {basic.map(fieldEl)}
        {row && cfg.readOnlyAt?.length ? (
          <dl className="space-y-1 text-sm" data-testid="readonly-at">
            {cfg.readOnlyAt.map((k) => (
              <div key={k} className="flex gap-2"><dt className="text-muted-foreground">{tk(`masters.f.${k}`)}</dt>
                <dd className="tabular-nums">{typeof row[k] === 'string' && row[k] ? formatDateTimeIN(row[k] as string) : t('masters.notRecorded')}</dd></div>
            ))}
          </dl>
        ) : null}
        {grouped.map(([g, fs]) => (
          <fieldset key={g} data-testid={`group-${g}`} className="space-y-4 rounded-md border border-border p-3">
            <legend className="px-1 text-sm font-medium">{tk(`masters.fg.${g}`)}</legend>
            {fs.map(fieldEl)}
          </fieldset>
        ))}
        {advanced.length ? (
          <details className="rounded-md border border-border p-3" open={advanced.some((f) => !!errFor(f.key))}>
            <summary className="cursor-pointer text-sm font-medium">{t('masters.moreDetails')}</summary>
            <p className="mb-3 mt-1 text-xs text-muted-foreground">{t('masters.moreDetailsHint')}</p>
            <div className="space-y-4">{advanced.map(fieldEl)}</div>
          </details>
        ) : null}
        <ErrorText error={save.error ?? toggle.error} />
        <div className="flex flex-wrap justify-between gap-2">
          {row ? (
            <Button type="button" variant="outline" disabled={!online || toggle.isPending} onClick={() => toggle.mutate()}>
              {t(row.is_active ? 'masters.stopUsing' : 'masters.activate')}
            </Button>
          ) : <span />}
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" disabled={!online || save.isPending || wait > 0}>{wait > 0 ? t('auth.retryIn', { seconds: wait }) : t('common.save')}</Button>
          </div>
        </div>
        {row ? <p className="text-xs text-muted-foreground">{t('masters.deactivateHint')}</p> : null}
      </form>
    </EditGate>
  );
}

function FieldInput({ kind, f, row, value, secret, refs, error, onChange, onSecret }: {
  kind: MasterKind; f: FieldDef; row: MasterRow | null; value: FieldValue; secret?: string; refs: Refs; error: string | null;
  onChange: (v: FieldValue) => void; onSecret: (v: string) => void;
}) {
  const t = useT();
  const tk = useTk();
  const label = `${tk(labelKey(kind, f.key))}${f.required ? ' *' : ''}`;
  const hint = f.hint ? tk(`masters.h.${f.key}`) : undefined;
  if (f.type === 'bool') return <div><Check label={label} checked={value === true} onChange={onChange} />{hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}</div>;
  if (f.type === 'file') return <FileField f={f} label={label} hint={hint} value={typeof value === 'string' ? value : ''} error={error} onChange={onChange} />;
  if (f.type === 'secret') return <SecretField f={f} row={row} label={label} hint={hint} value={secret ?? ''} error={error} onChange={onSecret} />;
  if (f.type === 'multi') {
    const cur = Array.isArray(value) ? value : [];
    return (
      <fieldset className="space-y-1">
        <legend className="text-sm font-medium">{label}</legend>
        <div className="flex flex-wrap gap-x-4">
          {optionsFor(f, refs, tk).map((o) => <Check key={o.value} label={o.label} checked={cur.includes(o.value)}
            onChange={(on) => onChange(on ? [...cur, o.value] : cur.filter((x) => x !== o.value))} />)}
        </div>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      </fieldset>
    );
  }
  const str = typeof value === 'string' ? value : '';
  return (
    <Field label={label} hint={hint} error={error}>
      {(id, d) => f.type === 'ref' && f.ref && isSearchRef(f.ref) ? (
        <RefPicker target={f.ref} value={str} known={refs[f.ref] ?? []} onChange={onChange} label={label} id={id} describedBy={d} required={f.required} />
      ) : f.type === 'select' || f.type === 'ref' ? (
        <Select id={id} aria-describedby={d} value={str} onChange={(e) => onChange(e.target.value || null)}>
          {f.required && str ? null : <option value="">{t('common.choose')}</option>}
          {optionsFor(f, refs, tk).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </Select>
      ) : (
        <Input id={id} aria-describedby={d} aria-invalid={!!error || undefined} value={str} onChange={(e) => onChange(e.target.value)}
          type={f.type === 'date' ? 'date' : f.type === 'phone' ? 'tel' : 'text'}
          inputMode={f.type === 'decimal' ? 'decimal' : f.type === 'phone' || f.type === 'hsn' || f.type === 'int' ? 'numeric' : undefined}
          className={f.type === 'code' || f.type === 'pan' || f.type === 'gstin' ? 'font-mono uppercase' : undefined}
          autoCapitalize={f.type === 'gstin' || f.type === 'code' || f.type === 'pan' ? 'characters' : undefined} />
      )}
    </Field>
  );
}

/**
 * PAN: write-only. The contract returns only `pan_last4`, so the screen always shows it masked (••••••234F);
 * typing a new PAN replaces it. The audited reveal (0.7.0) lives in the drawer's KYC panel (kyc.tsx), never in the form.
 */
function SecretField({ f, row, label, hint, value, error, onChange }: {
  f: FieldDef; row: MasterRow | null; label: string; hint?: string; value: string; error: string | null; onChange: (v: string) => void;
}) {
  const t = useT();
  const masked = maskLast4(row && f.last4Key ? (row[f.last4Key] as string | null) : null);
  return (
    <Field label={label} hint={hint} error={error}>
      {(id, d) => (
        <div className="space-y-2">
          {masked ? (
            <span className="block font-mono text-sm" data-testid={`masked-${f.key}`}>{masked}</span>
          ) : null}
          <Input id={id} aria-describedby={d} value={value} autoComplete="off" spellCheck={false} onChange={(e) => onChange(e.target.value)}
            placeholder={masked ? t('masters.replaceSecret') : undefined} autoCapitalize="characters" className="font-mono uppercase" />
        </div>
      )}
    </Field>
  );
}

/** file: upload to POST /v1/files with the field's purpose; the form keeps only the returned file id. */
function FileField({ f, label, hint, value, error, onChange }: {
  f: FieldDef; label: string; hint?: string; value: string; error: string | null; onChange: (v: FieldValue) => void;
}) {
  const t = useT();
  const up = useMutation({ mutationFn: (file: File) => mastersApi.uploadFile(file, f.purpose ?? 'kyc_document'), onSuccess: (a) => onChange(a.id) });
  return (
    <Field label={label} hint={hint} error={error ?? (up.error instanceof Error ? up.error.message : null)}>
      {(id, d) => (
        <div className="space-y-1">
          <Input id={id} aria-describedby={d} type="file" accept={f.purpose === 'kyc_document' ? 'image/jpeg,image/png,image/webp,application/pdf' : 'image/jpeg,image/png,image/webp'}
            disabled={up.isPending} onChange={(e) => { const file = e.target.files?.[0]; if (file) up.mutate(file); e.target.value = ''; }} />
          {value ? <p className="text-xs text-muted-foreground" data-testid={`file-${f.key}`}>{t('masters.fileAttached')}</p> : null}
        </div>
      )}
    </Field>
  );
}
