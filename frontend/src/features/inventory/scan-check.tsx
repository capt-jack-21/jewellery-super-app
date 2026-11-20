import { useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Check, Field, Select } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { EditGate, ErrorText } from '@/components/page';
import { useT, useTk } from '@/i18n';
import { useAttemptKey } from '@/lib/api/attempt-key';
import { useOnline } from '@/lib/offline/connectivity';
import { useSignedIn } from '@/lib/session';
import { INV, invPerm } from '@/lib/permissions';
import { formatDateTimeIN } from '@/lib/format';
import { ApiError } from '@/lib/api/fetcher';
import { inventoryApi, inventoryKeys } from './api';
import { useInvCan, useInvRefs } from './hooks';
import { normTag } from './piece-rules';
import { BranchPicker, InvPage, NotReadyOr, Wt } from './ui';
import type { GetStockCheckReportResult, RefLabels, StockCheckReportRow } from '@/lib/api/backend/model';
import type { StockCheck, StockCheckScanResult } from './types';

/**
 * 0.8.2: extra_reason is the enum unknown_code | other_branch | other_location | wrong_status, and for wrong_status
 * extra_note carries the piece's status code (e.g. sold) → shown as that status. A legacy "status_<code>" (0.8.0 wording,
 * still in the scan operation's description) is read the same way. Other reasons map 1:1 to inventory.check.reason.*.
 */
export function extraReasonKey(reason?: string | null, note?: string | null): { kind: 'status'; status: string } | { kind: 'reason'; reason: string } | null {
  if (!reason) return null;
  if (reason === 'wrong_status') return note ? { kind: 'status', status: note } : { kind: 'reason', reason };
  return reason.startsWith('status_') ? { kind: 'status', status: reason.slice(7) } : { kind: 'reason', reason };
}

/**
 * Live fix (2:52 PM IST): the screen must not throw when a check starts on a shop or place with no pieces. The contract
 * says `counts` is required on StockCheck / scan results and `items` on every page, but a missing or null value used to
 * crash the render ("Something went wrong!"). These helpers read them defensively; the shape itself is the server's job.
 */
export type CheckCountsView = { expected: number; scanned: number; matched: number; missing: number; extra: number };
const n0 = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
export function checkCounts(c: unknown): CheckCountsView {
  const o = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
  return { expected: n0(o.expected), scanned: n0(o.scanned), matched: n0(o.matched), missing: n0(o.missing), extra: n0(o.extra) };
}
/** Rows of a page that may be absent, or carry `items: null`. */
export function pageItems<T>(pages: ReadonlyArray<{ items?: readonly T[] | null } | null | undefined> | undefined): T[] {
  return (pages ?? []).flatMap((p) => (Array.isArray(p?.items) ? [...p.items] : []));
}
/** Date + time, or a dash when the value is absent / not a date (Intl throws RangeError on an invalid Date). */
export function safeDateTime(v: string | null | undefined): string {
  if (!v || Number.isNaN(new Date(v).getTime())) return '—';
  return formatDateTimeIN(v);
}

/**
 * Start a check, then read it back. Live 0.8.5 sent the 201 without `counts` (crash); 0.8.6 always sends them (zeros on an
 * empty scope). Kept as defence: the screen GETs the new check and falls back to zero counts if that read fails. A 201
 * without an id is an error.
 */
export async function startAndLoadCheck(body: Parameters<typeof inventoryApi.startCheck>[0], idemKey: string): Promise<StockCheck> {
  const c = await inventoryApi.startCheck(body, idemKey);
  if (!c || typeof c !== 'object' || !c.id) throw new Error('stock check start: response has no id');
  const fresh = await inventoryApi.check(c.id).catch(() => null);
  const base = fresh?.id ? fresh : c;
  return { ...base, counts: checkCounts(base.counts ?? c.counts) };
}

/** 0.8.8: close sends created_adjustment_ids (older servers: adjustment_ids). */
export function createdAdjustmentIds(c: unknown): string[] {
  const o = (c && typeof c === 'object' ? c : {}) as { created_adjustment_ids?: unknown; adjustment_ids?: unknown };
  const v = Array.isArray(o.created_adjustment_ids) ? o.created_adjustment_ids : Array.isArray(o.adjustment_ids) ? o.adjustment_ids : [];
  return v.filter((x): x is string => typeof x === 'string');
}
/** 0.8.8: report rows carry `status` only (tag_status gone; read it if an older server sends it). 0.8.9: status is required
 * but null for an unknown code → the row shows "—". */
export function reportRowStatus(r: unknown): string | null {
  const o = (r && typeof r === 'object' ? r : {}) as { status?: unknown; tag_status?: unknown };
  return typeof o.status === 'string' && o.status ? o.status : typeof o.tag_status === 'string' && o.tag_status ? o.tag_status : null;
}

/** Label for a referenced id: the row's server `labels` (keyed by id) first, then our reference lists. */
export function refLabel(labels: RefLabels | undefined, id: string | null | undefined, fallback: (id?: string | null) => string, code = false): string {
  const l = id ? labels?.[id] : undefined;
  return l ? (code ? l.code ?? l.name : l.name) : fallback(id);
}

/**
 * 7 — Scan stock check (0.8.2; start needs inventory.stock_check.run, close / cancel need .close and send If-Match): start a check on a branch / counter / tray (the server snapshots what should be there),
 * POST each code as it is read (idempotent per code — a repeat comes back duplicate:true), undo a wrong scan, see the
 * missing list from the server report, then close (optionally asking for write-off adjustments) or cancel.
 * 0.8.3: scans and undo don't change the check's version; asking for adjustments at close creates PENDING full
 * write-offs for each missing piece (they still need approval). 0.8.4: the scanned list and the report rows carry the
 * outcome (result, extra_reason, extra_note, duplicate) worked out by the server from the piece's CURRENT state, so the
 * screen shows them as-is; the report is a page {items, next_cursor, counts} with per-row status and labels.
 */
export function StockCheckPage() {
  const t = useT();
  const signedIn = useSignedIn();
  const online = useOnline();
  const refs = useInvRefs();
  const can = useInvCan();
  const key = useAttemptKey();
  const [where, setWhere] = useState({ branch: '', counter: '', tray: '' });
  const [check, setCheck] = useState<StockCheck | null>(null);
  const [closed, setClosed] = useState<StockCheck | null>(null);
  const branch = where.branch || refs.branches[0]?.id || '';
  const open = useQuery({ queryKey: inventoryKeys.checks(branch), queryFn: () => inventoryApi.checks(branch), enabled: signedIn && !!branch && !check, retry: false });
  const start = useMutation({
    mutationFn: () => startAndLoadCheck({ branch_id: branch, counter_id: where.counter || null, tray_id: where.tray || null }, key.take()),
    onSuccess: (c) => { key.reset(); setCheck({ ...c, branch_id: c.branch_id ?? branch }); setClosed(null); },
    onError: (e) => key.settle(e),
  });
  const openChecks = pageItems([open.data]).filter((c) => c?.id && c.status === 'open');
  const closedCounts = checkCounts(closed?.counts);
  return (
    <InvPage title="inventory.check.title" description="inventory.check.desc">
      <EditGate perm={invPerm(INV.stockCheckRun)}>
        {!check ? (
          <Card><CardContent className="space-y-3 pt-4">
            <div className="grid gap-3 md:grid-cols-3">
              <Field label={t('inventory.branch')}>{(id) => <BranchPicker id={id} value={branch} onChange={(v) => { setWhere({ branch: v, counter: '', tray: '' }); key.reset(); }} branches={refs.branches} />}</Field>
              <Field label={t('inventory.counter')} hint={t('inventory.check.wholeBranch')}>{(id, h) => (
                <Select id={id} aria-describedby={h} value={where.counter} onChange={(e) => { setWhere({ ...where, counter: e.target.value, tray: '' }); key.reset(); }}>
                  <option value="">{t('inventory.check.all')}</option>
                  {refs.counters.filter((c) => c.branch_id === branch).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>)}</Field>
              <Field label={t('inventory.tray')}>{(id) => (
                <Select id={id} value={where.tray} disabled={!where.counter} onChange={(e) => { setWhere({ ...where, tray: e.target.value }); key.reset(); }}>
                  <option value="">{t('inventory.check.all')}</option>
                  {refs.trays.filter((x) => x.counter_id === where.counter).map((x) => <option key={x.id} value={x.id}>{x.name ?? x.code}</option>)}
                </Select>)}</Field>
            </div>
            <NotReadyOr error={start.error ?? open.error} />
            {start.error && !(start.error instanceof ApiError) ? <p role="alert" className="text-sm text-destructive">{t('inventory.check.startFailed')}</p> : null}
            {can(INV.stockCheckRun) ? <Button disabled={!online || !branch || start.isPending} onClick={() => start.mutate()}>{t('inventory.check.start')}</Button> : null}
            {openChecks.length ? (
              <section className="space-y-1">
                <h3 className="text-sm font-medium">{t('inventory.check.open')}</h3>
                <ul className="space-y-1 text-sm">
                  {openChecks.map((c) => (
                    <li key={c.id} className="flex flex-wrap items-center gap-2">
                      <span>{`${refs.counterName(c.counter_id)} · ${refs.trayName(c.tray_id)}`}</span>
                      <span className="text-muted-foreground">{safeDateTime(c.started_at)}</span>
                      <span className="tabular-nums">{t('inventory.check.progress', { found: checkCounts(c.counts).matched, total: checkCounts(c.counts).expected, extra: checkCounts(c.counts).extra })}</span>
                      <Button size="sm" variant="outline" onClick={() => setCheck(c)}>{t('inventory.check.continue')}</Button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </CardContent></Card>
        ) : <Running check={check} onUpdate={setCheck} onEnd={(c) => { setCheck(null); setClosed(c); }} />}
      </EditGate>
      {closed ? (
        <Card role="status"><CardHeader><CardTitle>{t('inventory.check.result')}</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p className="tabular-nums">{t('inventory.check.summary', { found: closedCounts.matched, missing: closedCounts.missing, extra: closedCounts.extra })}</p>
            {createdAdjustmentIds(closed).length ? <p>{t('inventory.check.adjustmentsCreated', { n: createdAdjustmentIds(closed).length })}</p>
              : closedCounts.missing ? <p>{t('inventory.check.nextStep')}</p> : null}
          </CardContent></Card>
      ) : null}
      {closed?.id ? <CheckReport check={closed} initial="missing" /> : null}
    </InvPage>
  );
}

export function Running({ check, onUpdate, onEnd }: { check: StockCheck; onUpdate: (c: StockCheck) => void; onEnd: (c: StockCheck) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const online = useOnline();
  const can = useInvCan();
  const [raw, setRaw] = useState('');
  const [last, setLast] = useState<StockCheckScanResult | null>(null);
  const [writeOff, setWriteOff] = useState(false);
  const scans = useInfiniteQuery({
    queryKey: inventoryKeys.scans(check.id),
    queryFn: ({ pageParam }) => inventoryApi.scans(check, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (p) => p.next_cursor ?? undefined,
    retry: false,
  });
  const rows = pageItems(scans.data?.pages).filter((s) => s?.id);
  const refreshMissing = () => { void qc.invalidateQueries({ queryKey: inventoryKeys.reportAll(check.id) }); void qc.invalidateQueries({ queryKey: inventoryKeys.scans(check.id) }); };
  const scan = useMutation({
    mutationFn: (code: string) => inventoryApi.scan(check, code),
    onSuccess: (r) => { setLast(r); onUpdate({ ...check, counts: r?.counts ?? check.counts }); refreshMissing(); },
  });
  const undo = useMutation({
    mutationFn: (scanId: string) => inventoryApi.undoScan(check, scanId),
    onSuccess: async (_, id) => { setLast((x) => (x?.scan_id === id ? null : x)); onUpdate(await inventoryApi.check(check.id)); refreshMissing(); },
  });
  // 412 version_mismatch (someone else changed the check): reload it so the next press uses the fresh version.
  const reload = (e: unknown) => { if (e instanceof ApiError && e.status === 412) void inventoryApi.check(check.id).then(onUpdate, () => undefined); };
  const close = useMutation({ mutationFn: () => inventoryApi.closeCheck(check, writeOff), onSuccess: (c) => { void qc.invalidateQueries({ queryKey: inventoryKeys.all }); onEnd(c); }, onError: reload });
  const cancel = useMutation({ mutationFn: () => inventoryApi.cancelCheck(check), onSuccess: () => { void qc.invalidateQueries({ queryKey: inventoryKeys.all }); onEnd({ ...check, status: 'cancelled' }); }, onError: reload });
  const outcome = useOutcome();
  const c = checkCounts(check.counts);
  return (
    <Card><CardContent className="space-y-3 pt-4">
      <form onSubmit={(e) => { e.preventDefault(); const v = normTag(raw); setRaw(''); if (v) scan.mutate(v); }} className="flex items-end gap-2">
        <Field label={t('inventory.scan.label')} hint={t('inventory.scanHint')} className="flex-1">{(id, h) => <Input id={id} aria-describedby={h} lang="en" autoFocus autoComplete="off" className="font-mono uppercase" value={raw} onChange={(e) => setRaw(e.target.value)} />}</Field>
        <Button type="submit" variant="outline" disabled={!online}>{t('inventory.add')}</Button>
      </form>
      {last ? <p role="status" className="text-sm" data-testid="last-scan"><span lang="en" className="font-mono">{last.tag_no ?? last.code}</span>{` · ${outcome(last)}`}</p> : null}
      <ErrorText error={scan.error ?? undo.error} />
      <NotReadyOr error={scans.error} />
      <p className="text-sm tabular-nums" data-testid="check-progress">{t('inventory.check.progress', { found: c.matched, total: c.expected, extra: c.extra })}</p>
      {c.expected === 0 && c.scanned === 0 ? <p className="rounded-md border border-border p-2 text-sm text-muted-foreground" data-testid="check-empty">{t('inventory.check.emptyPlace')}</p> : null}
      <div className="grid gap-3 md:grid-cols-2">
        <section className="rounded-md border border-border p-2">
          <h3 className="text-sm font-medium">{`${t('inventory.check.scanned')} (${c.scanned})`}</h3>
          <ul className="mt-1 max-h-60 space-y-1 overflow-auto text-xs" data-testid="recent-scans">
            {rows.map((s) => (
              <li key={s.id} className="flex items-center gap-2">
                <span lang="en" className="font-mono">{s.tag_no ?? s.code}</span>
                <span className={s.result === 'extra' ? 'text-destructive' : undefined}>{outcome(s)}</span>
                <Button type="button" size="icon" variant="ghost" className="ml-auto h-6 w-6" aria-label={`${t('inventory.check.undo')} ${s.code}`} disabled={!online || undo.isPending} onClick={() => undo.mutate(s.id)}><Undo2 className="h-3 w-3" /></Button>
              </li>
            ))}
          </ul>
          {scans.hasNextPage ? <Button size="sm" variant="ghost" onClick={() => void scans.fetchNextPage()} disabled={scans.isFetchingNextPage}>{t('inventory.loadMore')}</Button> : null}
        </section>
        <CheckReport check={check} initial="missing" compact />
      </div>
      {can(INV.stockCheckClose) ? (
        <>
          <Check label={t('inventory.check.writeOff')} checked={writeOff} onChange={setWriteOff} />
          <ErrorText error={close.error ?? cancel.error} />
          <div className="flex gap-2">
            <Button disabled={!online || close.isPending} onClick={() => close.mutate()}>{t('inventory.check.finish')}</Button>
            <Button variant="ghost" disabled={!online || cancel.isPending} onClick={() => cancel.mutate()}>{t('inventory.check.cancel')}</Button>
          </div>
        </>
      ) : <p className="text-xs text-muted-foreground">{t('inventory.check.askToClose')}</p>}
    </CardContent></Card>
  );
}

type Outcome = { result: string; extra_reason?: string | null; extra_note?: string | null; duplicate?: boolean };
/** "Found" / "Not expected here · <why>" (+ "· repeat") from the server's outcome fields. */
function useOutcome() {
  const t = useT();
  const tk = useTk();
  return (s: Outcome) => {
    const r = extraReasonKey(s.extra_reason, s.extra_note);
    const why = r ? (r.kind === 'status' ? tk(`inventory.status.${r.status}`) : tk(`inventory.check.reason.${r.reason}`)) : '';
    return `${t(s.result === 'matched' ? 'inventory.check.matched' : s.result === 'missing' ? 'inventory.check.notYet' : 'inventory.check.extraOne')}${s.duplicate ? ` · ${t('inventory.check.repeatShort')}` : ''}${why ? ` · ${why}` : ''}`;
  };
}

const REPORT_TABS = ['missing', 'extra', 'matched'] as const satisfies readonly GetStockCheckReportResult[];

/**
 * Stock-check report (GET …/report, 0.8.4 page {items, next_cursor, counts}): live while open and after close. Tabs per
 * result with the server counts; each row shows the piece, item / purity / place from the row labels, its current status
 * and, for extras, why. "Load more" follows next_cursor.
 */
export function CheckReport({ check, initial, compact }: { check: Pick<StockCheck, 'id'>; initial: (typeof REPORT_TABS)[number]; compact?: boolean }) {
  const t = useT();
  const tk = useTk();
  const refs = useInvRefs();
  const outcome = useOutcome();
  const [tab, setTab] = useState<(typeof REPORT_TABS)[number]>(initial);
  const q = useInfiniteQuery({
    queryKey: inventoryKeys.report(check.id, tab),
    queryFn: ({ pageParam }) => inventoryApi.report(check, tab, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (p) => p.next_cursor ?? undefined,
    retry: false,
  });
  const rows = pageItems(q.data?.pages).filter(Boolean);
  const first = q.data?.pages[0]?.counts;
  const counts = first ? checkCounts(first) : undefined;
  const place = (r: StockCheckReportRow) => [r.counter_id ? refLabel(r.labels, r.counter_id, refs.counterName) : null, r.tray_id ? refLabel(r.labels, r.tray_id, refs.trayName) : null].filter(Boolean).join(' · ');
  const body = (
    <div className="space-y-2" data-testid="check-report">
      <div role="tablist" className="flex flex-wrap gap-1">
        {REPORT_TABS.map((k) => (
          <Button key={k} role="tab" size="sm" aria-selected={tab === k} variant={tab === k ? 'secondary' : 'ghost'} onClick={() => setTab(k)}>
            {`${t(`inventory.check.tab.${k}`)}${counts ? ` (${counts[k]})` : ''}`}
          </Button>
        ))}
      </div>
      <NotReadyOr error={q.error} />
      {q.isSuccess && !rows.length ? <p className="text-xs text-muted-foreground">{t('inventory.check.none')}</p> : null}
      <ul className="max-h-72 space-y-1 overflow-auto text-xs">
        {rows.map((r, i) => (
          <li key={`${r.tag_id ?? r.scanned_code ?? ''}-${i}`} className="flex flex-wrap items-center gap-x-2">
            <span lang="en" className="font-mono">{r.tag_no ?? r.scanned_code}</span>
            {r.item_id ? <span>{refLabel(r.labels, r.item_id, refs.itemName)}</span> : null}
            {r.purity_id ? <span>{refLabel(r.labels, r.purity_id, refs.purityCode, true)}</span> : null}
            {place(r) ? <span className="text-muted-foreground">{place(r)}</span> : null}
            <span>{reportRowStatus(r) ? tk(`inventory.status.${reportRowStatus(r)}`) : '—'}</span>
            {r.net_wt ? <Wt v={r.net_wt} /> : null}
            {tab === 'extra' ? <span className="text-destructive">{outcome(r)}</span> : null}
          </li>
        ))}
      </ul>
      {q.hasNextPage ? <Button size="sm" variant="ghost" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>{t('inventory.loadMore')}</Button> : null}
    </div>
  );
  return compact ? <section className="rounded-md border border-border p-2">{body}</section> : (
    <Card><CardHeader><CardTitle>{t('inventory.check.report')}</CardTitle></CardHeader><CardContent>{body}</CardContent></Card>
  );
}
