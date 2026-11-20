import { ApiError } from '@/lib/api/fetcher';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { keepPreviousData, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { ScanLine, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Check, Field, Select } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Loading } from '@/components/page';
import { useT, useTk } from '@/i18n';
import { formatINR, formatPercent, formatWeight } from '@/lib/format';
import { useAttemptKey } from '@/lib/api/attempt-key';
import { useOnline } from '@/lib/offline/connectivity';
import { billingState, useCan, useSession, useSignedIn } from '@/lib/session';
import { SALES } from '@/lib/permissions';
import { uuid } from '@/lib/uuid';
import { useCurrentDevice } from '@/features/devices/devices';
import { useInvRefs } from '@/features/inventory/hooks';
import { mastersApi } from '@/features/masters/api';
import type { BillComputation, Estimate, PricedLine, SalesSettings, Staff } from '@/lib/api/backend/model';
import { salesApi, salesKeys } from './api';
import { CustomerPicker } from './customer';
import { rememberedSalesperson, shortcutFor, useDebounced } from './hooks';
import {
  draftDiscounts, draftFromEstimates, draftGaps, draftGstin, draftSupplyType, emptyDraft, errorLineIndex, existingCustomer, isPositive, isStaleEstimate,
  isTotalMismatch, issueBlockers, pricedAt, roughTotal, salesErrorCode, stateFromGstin, sumMoney, supplyIssues, toEstimateRequest, toIssueRequest, toPreviewRequest, invalidGoodsLineIndex, invoiceOnlyChecks,
  type BillDraft, type DiscountState, type DraftLine,
} from './logic';
import { SalesSettingsLink } from './settings';
import { LooseEntry } from './loose';
import { OldGoldEditor } from './old-gold';
import { TenderEditor } from './tenders';
import { BillTotalsPanel, GstBreakup } from './totals';
import { Alert, Money, Row, SalesError, SalesPage } from './ui';

type Mode = 'bill' | 'estimate';

/** Key-cap hint (key names are not translated). */
const Kbd = ({ k }: { k: string }) => <kbd className="ml-2 text-xs opacity-80">{k}</kbd>;

export function CounterBillPage() {
  const s = useSearch({ strict: false }) as { estimates?: string };
  const ids = (s.estimates ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  return <SalesPage title="sales.bill.title" description="sales.bill.description">{(settings) => <BillScreen mode="bill" settings={settings} estimateIds={ids} />}</SalesPage>;
}
export function CounterEstimatePage() {
  const s = useSearch({ strict: false }) as { id?: string };
  return <SalesPage title={s.id ? 'sales.estimate.editTitle' : 'sales.estimate.newTitle'}>{(settings) => <BillScreen mode="estimate" settings={settings} estimateIds={s.id ? [s.id] : []} />}</SalesPage>;
}

/** Device / setup / readiness gates (server GET /billing-readiness). making_service_rate (0.9.1) points the owner to shop settings. */
function Gates({ branchId }: { branchId: string }) {
  const t = useT();
  const tk = useTk();
  const can = useCan();
  const session = useSession().data;
  const gate = billingState(session);
  const ready = useQuery({ queryKey: salesKeys.readiness(branchId), queryFn: () => salesApi.readiness(branchId), enabled: !!branchId && gate.ready, retry: false, staleTime: 60_000 });
  if (session && !gate.device) return <p className="rounded-md border border-warning p-3 text-sm" data-testid="device-gate">{t('counter.deviceGate')}{' '}<Link className="underline" to="/device">{t('device.title')}</Link></p>;
  if (session && !gate.unlocked) return <p className="rounded-md border border-warning p-3 text-sm" data-testid="setup-gate">{t('counter.setupGate')}{' '}<Link className="underline" to="/setup">{t('dashboard.openSetup')}</Link></p>;
  const failing = (ready.data?.gates ?? []).filter((g) => !g.ok);
  if (!failing.length) return null;
  return (
    <div role="alert" className="space-y-1 rounded-md border border-warning p-3 text-sm" data-testid="readiness-gate">
      <p className="font-semibold">{t('sales.gate.title')}</p>
      <ul className="list-disc pl-5">{failing.map((g) => <li key={g.code}>{tk(`sales.gate.${g.code}`)}</li>)}</ul>
      {failing.some((g) => g.code === 'making_service_rate') ? <MakingRateNote inline canFix={can(SALES.settingsEdit)} path={failing.find((g) => g.code === 'making_service_rate')?.settings_path} /> : null}
    </div>
  );
}

/** 0.9.1 gate: making GST billed separately but no service rate set → nothing can be billed until the owner sets it. */
export function MakingRateNote({ canFix, inline, path }: { canFix: boolean; inline?: boolean; path?: unknown }) {
  const t = useT();
  const body = <>{t('error.making_service_rate_not_set')}{' '}{canFix ? <SalesSettingsLink path={path} /> : t('sales.gate.askOwner')}</>;
  return inline ? <p data-testid="making-rate-gate">{body}</p> : <Alert testId="making-rate-gate">{body}</Alert>;
}

export const eligibleSalesperson = (s: Pick<Staff, 'is_salesperson' | 'is_active' | 'branch_id'>, branchId: string) =>
  s.is_salesperson && s.is_active && (!s.branch_id || s.branch_id === branchId);

function useSalespeople(branchId: string) {
  const signedIn = useSignedIn();
  return useQuery({
    queryKey: ['sales', 'salespeople', branchId] as const, enabled: signedIn && !!branchId, retry: false, staleTime: 5 * 60_000,
    queryFn: async () => ((await mastersApi.list('staff', { limit: '200' })).items as unknown as Staff[]).filter((s) => eligibleSalesperson(s, branchId)),
  });
}

/**
 * Counter bill (and estimate) screen: scan → server-priced lines → customer + salesperson → old gold / discount → payments → Issue.
 * Figures are ALWAYS the server's (POST /preview, debounced); until a customer and salesperson are chosen the rough total adds the
 * scan answers. Issue sends expected_total = the previewed amount to pay; a 422 expected_total_mismatch shows the new total to confirm.
 */
export function BillScreen({ mode, settings, estimateIds }: { mode: Mode; settings: SalesSettings; estimateIds: string[] }) {
  const t = useT();
  const tk = useTk();
  const can = useCan();
  const online = useOnline();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const session = useSession().data;
  const gate = billingState(session);
  const device = useCurrentDevice().data;
  const branchId = device?.branch_id ?? '';
  const refs = useInvRefs();
  const salespeople = useSalespeople(branchId);
  const [draft, setDraft] = useState<BillDraft>(() => emptyDraft('', rememberedSalesperson.get()));
  const [editing, setEditing] = useState<Pick<Estimate, 'id' | 'version'> | null>(null);
  const [code, setCode] = useState('');
  const [scanErr, setScanErr] = useState<unknown>(null);
  const [dupTag, setDupTag] = useState<string | null>(null);
  const [show, setShow] = useState({ oldGold: false, discount: false, loose: false });
  const [confirmTotal, setConfirmTotal] = useState<string | null>(null);
  const scanRef = useRef<HTMLInputElement>(null);
  const payRef = useRef<HTMLInputElement>(null);
  const custRef = useRef<HTMLInputElement>(null);
  const oldRef = useRef<HTMLSelectElement>(null);
  const discRef = useRef<HTMLInputElement>(null);
  const issueKey = useAttemptKey();
  const estKey = useAttemptKey();
  const blocked = !online || !gate.ready || !branchId;

  useEffect(() => { if (branchId && draft.branch_id !== branchId && !draft.lines.length) setDraft((d) => ({ ...d, branch_id: branchId })); }, [branchId, draft.branch_id, draft.lines.length]);

  useEffect(() => {
    if (salespeople.data && draft.salesperson_id && !salespeople.data.some((s) => s.id === draft.salesperson_id)) setDraft((d) => ({ ...d, salesperson_id: '' }));
  }, [salespeople.data, draft.salesperson_id]);

  // Prefill from estimates (bill: convert / merge; estimate: edit one draft).
  const ests = useQueries({ queries: estimateIds.map((id) => ({ queryKey: salesKeys.estimate(id), queryFn: () => salesApi.estimate(id), retry: false })) });
  const estData = ests.map((q) => q.data).filter((x): x is Estimate => !!x);
  const prefilled = useRef(false);
  const [pricedSeed, setPricedSeed] = useState<Map<string, PricedLine>>(new Map());
  useEffect(() => {
    if (prefilled.current || !estimateIds.length || estData.length !== estimateIds.length) return;
    prefilled.current = true;
    const seed = new Map<string, PricedLine>();
    for (const e of estData) for (const l of e.computation.lines) if (l.tag_id) seed.set(l.tag_id, l);
    setPricedSeed(seed);
    const name = estData.find((e) => e.computation.customer)?.computation.customer;
    setDraft((d) => {
      const next = draftFromEstimates(d, estData, uuid);
      if (mode === 'estimate') next.estimates = [];
      if (next.customer.kind === 'existing' && name) next.customer = { ...next.customer, name: name.name, phone: name.phone, gstin: name.gstin, state_code: name.state_code };
      return next;
    });
    if (mode === 'estimate' && estData[0]) setEditing({ id: estData[0].id, version: estData[0].version });
  }, [estimateIds.length, estData, mode]);

  // Server-authoritative preview also works on estimates without a customer or salesperson.
  const previewBody = useMemo(() => toPreviewRequest(draft, mode), [draft, mode]);
  const bodyJson = previewBody ? JSON.stringify(previewBody) : '';
  const settled = useDebounced(bodyJson, 350);
  const preview = useQuery({
    queryKey: salesKeys.preview(settled), queryFn: () => salesApi.preview(JSON.parse(settled)),
    enabled: !!settled && online && gate.ready, retry: false, staleTime: 15_000, placeholderData: keepPreviousData,
  });
  const comp: BillComputation | null = bodyJson && preview.data ? preview.data : null;
  const stale = bodyJson !== settled || preview.isFetching;
  const due = comp?.totals.net_payable ?? null;
  const pricedFor = (i: number): PricedLine | null => {
    const l = draft.lines[i];
    return pricedAt(draft.lines, i, comp?.lines) ?? (l?.kind === 'tag' ? pricedSeed.get(l.tag_id) ?? null : null);
  };
  const canDiscount = can(SALES.discountGive);
  const disc = draftDiscounts(draft, draft.lines.map((_, i) => pricedFor(i)).filter((x): x is PricedLine => !!x), comp?.totals.gross_value, settings);
  const supply = supplyIssues(draft);
  const gstin = draftGstin(draft);

  const update = (patch: Partial<BillDraft>) => { setDraft((d) => ({ ...d, ...patch })); setConfirmTotal(null); issueKey.reset(); };

  // Scan box (tag number / HUID / barcode). 0.9.1 GET /sellable/{code}: 409 tag_sold … / 404 → plain words.
  const scan = useMutation({
    mutationFn: (c: string) => salesApi.sellable(c, { branch_id: draft.branch_id || branchId }),
    onSuccess: (s) => {
      setScanErr(null);
      if (draft.lines.some((l) => l.kind === 'tag' && l.tag_id === s.tag_id)) { setDupTag(s.tag_no); setCode(''); return; }
      update({ lines: [...draft.lines, { kind: 'tag', key: uuid(), tag_id: s.tag_id, tag_no: s.tag_no, priced: s.line }] });
      setCode('');
      scanRef.current?.focus();
    },
    onError: (e) => { setScanErr(e); scanRef.current?.select(); },
  });
  const onScan = (e: FormEvent) => {
    e.preventDefault();
    const c = code.trim();
    if (!c || scan.isPending) return;
    setDupTag(null);
    const dup = draft.lines.find((l) => l.kind === 'tag' && l.tag_no.toUpperCase() === c.toUpperCase());
    if (dup) { setDupTag(c.toUpperCase()); setCode(''); return; }
    scan.mutate(c);
  };

  const issue = useMutation({
    mutationFn: (expected: string) => {
      const body = toIssueRequest(draft, expected);
      if (!body) throw new Error('incomplete');
      return salesApi.issue(body, issueKey.take());
    },
    onSuccess: (inv) => {
      issueKey.reset();
      void qc.invalidateQueries({ queryKey: ['sales', 'invoices'] });
      setDraft(emptyDraft(branchId, draft.salesperson_id));
      void navigate({ to: '/sales/invoices/$id', params: { id: inv.id }, search: { print: true } });
    },
    onError: async (e) => {
      issueKey.settle(e);
      if (isTotalMismatch(e)) { const r = await preview.refetch(); setConfirmTotal(r.data?.totals.net_payable ?? null); }
    },
  });
  const saveEstimate = useMutation({
    mutationFn: () => {
      const body = toEstimateRequest(draft);
      if (!body) throw new Error('incomplete');
      return editing ? salesApi.replaceEstimate(editing, body) : salesApi.createEstimate(body, estKey.take());
    },
    onSuccess: (est) => { estKey.reset(); void qc.invalidateQueries({ queryKey: ['sales', 'estimates'] }); void navigate({ to: '/sales/estimates/$id', params: { id: est.id } }); },
    onError: estKey.settle,
  });

  const blockers = mode === 'bill' ? issueBlockers(comp, draft, can, settings) : [];
  const gaps = draftGaps(draft, mode);
  const err = issue.error ?? saveEstimate.error ?? preview.error;
  const badLine = errorLineIndex(err) ?? (mode === 'bill' && invalidGoodsLineIndex(draft.lines, comp?.lines) >= 0 ? invalidGoodsLineIndex(draft.lines, comp?.lines) : null);
  const conflict = existingCustomer(issue.error ?? preview.error);
  const makingRateMissing = salesErrorCode(err) === 'making_service_rate_not_set';
  const canIssue = mode === 'bill' && can(SALES.issue) && !blocked && !!comp && !stale && !gaps.length && !blockers.length && !issue.isPending && !makingRateMissing;
  const canEstimate = can(SALES.estimateCreate) && !blocked && !draftGaps(draft, 'estimate').length && !saveEstimate.isPending && !makingRateMissing;
  const doIssue = () => { if (canIssue && due) issue.mutate(confirmTotal ?? due); };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = shortcutFor(e);
      if (!k) return;
      e.preventDefault();
      if (k === 'scan') scanRef.current?.focus();
      if (k === 'pay') payRef.current?.focus();
      if (k === 'customer') custRef.current?.focus();
      if (k === 'oldGold' && settings.old_gold_enabled) { setShow((s) => ({ ...s, oldGold: true })); setTimeout(() => oldRef.current?.focus(), 0); }
      if (k === 'discount') { setShow((s) => ({ ...s, discount: true })); setTimeout(() => discRef.current?.focus(), 0); }
      if (k === 'issue') doIssue();
      if (k === 'estimate' && canEstimate) saveEstimate.mutate();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (estimateIds.length && ests.some((q) => q.isLoading)) return <Loading />;
  const estErr = ests.find((q) => q.error)?.error;
  const rough = roughTotal(draft.lines);
  const r = comp?.requirements;
  const oldOpen = settings.old_gold_enabled && (show.oldGold || draft.old_metal.length > 0);
  const discOpen = show.discount || !!draft.bill_discount;

  return (
    <div className="space-y-3" data-sales-screen>
      <Gates branchId={branchId} />
      {makingRateMissing ? <MakingRateNote canFix={can(SALES.settingsEdit)} path={err instanceof ApiError ? err.problem?.settings_path : undefined} /> : null}
      <SalesError error={estErr} />
      {draft.estimates.length ? <p role="status" className="rounded-md bg-muted p-2 text-sm" data-testid="from-estimates">{t('sales.bill.fromEstimates', { n: draft.estimates.length })}</p> : null}
      {mode === 'estimate' && invoiceOnlyChecks(comp).length ? <p role="note" data-testid="estimate-info" className="rounded border border-border p-3 text-sm text-muted-foreground">{t('sales.estimate.invoiceChecks')}</p> : null}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="space-y-4">
          <Card>
            <CardContent className="space-y-3 pt-4">
              <form onSubmit={onScan} className="flex items-end gap-2" data-testid="scan-form">
                <Field label={t('sales.scan.label')} hint={t('sales.scan.hint')} className="flex-1">{(id, d) => (
                  <Input ref={scanRef} id={id} aria-describedby={d} autoFocus autoComplete="off" spellCheck={false} className="h-14 font-mono text-xl uppercase"
                    value={code} disabled={blocked} onChange={(e) => { setCode(e.target.value); setScanErr(null); setDupTag(null); }} />)}</Field>
                <Button type="submit" className="h-14" disabled={blocked || !code.trim() || scan.isPending}><ScanLine className="h-5 w-5" aria-hidden />{t('sales.scan.add')}</Button>
              </form>
              {dupTag ? <Alert testId="scan-error">{t('error.duplicate_tag_in_bill')}</Alert> : <SalesError error={scanErr} ctx="scan" />}
              <LinesTable onPieces={(key, pieces) => update({ lines: draft.lines.map((l) => l.key === key && l.kind === 'loose' ? { ...l, pieces } : l) })} lines={draft.lines} pricedFor={pricedFor} badLine={badLine} itemName={refs.itemName} purityCode={refs.purityCode}
                discount={canDiscount ? { states: disc.lines, onChange: (key, v) => update({ lines: draft.lines.map((l) => (l.key === key ? { ...l, discount: v } : l)) }) } : null}
                onRemove={(key) => update({ lines: draft.lines.filter((l) => l.key !== key) })} />
              {show.loose ? (
                <LooseEntry refs={refs} branchId={draft.branch_id || branchId} onClose={() => setShow((x) => ({ ...x, loose: false }))}
                  onAdd={(l) => update({ lines: [...draft.lines, l] })} />
              ) : (
                <Button type="button" variant="outline" disabled={blocked} data-testid="loose-open" onClick={() => setShow((x) => ({ ...x, loose: true }))}>{t('sales.loose.open')}</Button>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardContent className="grid gap-3 pt-4 md:grid-cols-2">
              <CustomerPicker ref={custRef} value={draft.customer} optional={mode === 'estimate'} disabled={blocked} onChange={(c) => update({ customer: c })} />
              <div className="space-y-2">
                <Field label={mode === 'estimate' ? t('sales.salesperson.labelOptional') : t('sales.salesperson.label')}>{(id) => (
                  <Select id={id} value={draft.salesperson_id} onChange={(e) => { rememberedSalesperson.set(e.target.value); update({ salesperson_id: e.target.value }); }}>
                    <option value="">{t('sales.salesperson.pick')}</option>
                    {(salespeople.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </Select>)}</Field>
                {conflict ? (
                  <div role="alert" className="space-y-2 rounded-md border border-warning p-2 text-sm" data-testid="customer-conflict">
                    <p>{t('sales.customer.exists', { name: conflict.name })}</p>
                    <Button size="sm" onClick={() => { update({ customer: { kind: 'existing', id: conflict.customer_id, name: conflict.name } }); issue.reset(); }}>{t('sales.customer.useThis')}</Button>
                  </div>
                ) : null}
              </div>
            </CardContent>
          </Card>
          {draft.customer.kind !== 'none' ? (
            <Card data-testid="supply-card"><CardContent className="grid gap-3 pt-4 sm:grid-cols-2">
              <div className="space-y-1 text-sm">
                <p className="font-semibold" data-testid="supply-type">{tk(`sales.supply.${comp?.supply_type ?? draftSupplyType(draft)}`)}</p>
                {gstin ? <p lang="en" className="font-mono text-muted-foreground">{t('sales.print.gstin')} {gstin}</p> : <p className="text-muted-foreground">{t('sales.b2b.howTo')}</p>}
              </div>
              {gstin ? (
                <p className="text-sm" data-testid="pos-locked">{t('sales.b2b.posFromGstin', { code: stateFromGstin(gstin) ?? '' })}</p>
              ) : (
                <Field label={t('sales.b2b.pos')} hint={t('sales.b2b.posHint', { code: comp?.place_of_supply ?? '' })}>{(id, d) => (
                  <Input id={id} aria-describedby={d} inputMode="numeric" maxLength={2} className="w-24 font-mono" value={draft.place_of_supply ?? ''} onChange={(e) => update({ place_of_supply: e.target.value })} />)}</Field>
              )}
              {supply.length ? <ul role="alert" className="space-y-0.5 text-sm text-destructive sm:col-span-2" data-testid="supply-issues">{supply.map((x) => <li key={x}>{tk(`sales.b2b.issue.${x}`)}</li>)}</ul> : null}
            </CardContent></Card>
          ) : null}
          <div className="flex flex-wrap gap-2 print:hidden">
            {settings.old_gold_enabled && !oldOpen ? <Button variant="outline" onClick={() => setShow((s) => ({ ...s, oldGold: true }))}>{t('sales.oldGold.open')} <Kbd k="F2" /></Button> : null}
            {!discOpen && can(SALES.discountGive) ? <Button variant="outline" onClick={() => setShow((s) => ({ ...s, discount: true }))}>{t('sales.discount.open')} <Kbd k="F4" /></Button> : null}
          </div>
          {oldOpen ? (
            <Card><CardContent className="space-y-3 pt-4">
              <OldGoldEditor rows={draft.old_metal} onChange={(rows) => update({ old_metal: rows })} purities={refs.purities} priced={comp?.old_metal ?? []}
                canOverride={can(SALES.oldGoldRateOverride)} firstRef={oldRef} />
              {comp && isPositive(comp.totals.old_gold_excess) && settings.old_gold_excess_handling !== 'separate_purchase' ? (
                <Field label={t('sales.oldGold.payout', { amount: formatINR(comp.totals.old_gold_excess) })}>{(id) => (
                  <Select id={id} value={draft.excess_payout ?? ''} onChange={(e) => update({ excess_payout: (e.target.value || undefined) as BillDraft['excess_payout'] })}>
                    <option value="">{t('sales.oldGold.payoutPick')}</option>
                    <option value="cash">{t('sales.tender.cash')}</option>
                    <option value="bank_transfer">{t('sales.tender.bank_transfer')}</option>
                  </Select>)}</Field>
              ) : null}
            </CardContent></Card>
          ) : null}
          {discOpen && can(SALES.discountGive) ? (
            <Card><CardContent className="grid gap-3 pt-4 sm:grid-cols-2">
              <Field label={t('sales.discount.amount')} hint={t('sales.discount.hint', { max: formatPercent(settings.discount_max_pct) })}>{(id, d) => (
                <Input ref={discRef} id={id} aria-describedby={d} inputMode="decimal" className="font-mono" value={draft.bill_discount ?? ''} onChange={(e) => update({ bill_discount: e.target.value })} />)}</Field>
              <Field label={disc.overMax ? t('sales.discount.reasonNeeded') : t('sales.discount.reason')}>{(id) => <Input id={id} maxLength={200} value={draft.discount_reason ?? ''} onChange={(e) => update({ discount_reason: e.target.value })} />}</Field>
              {disc.bill !== 'none' && disc.bill !== 'ok' ? <p className="text-sm sm:col-span-2" data-testid="bill-discount-state">{tk(`sales.discount.state.${disc.bill}`)}</p> : null}
            </CardContent></Card>
          ) : null}
          {mode === 'bill' && can(SALES.zeroGst) ? (
            <Card><CardContent className="space-y-2 pt-4">
              <Check label={t('sales.zeroGst.label')} checked={!!draft.zero_gst?.on} onChange={(on) => update({ zero_gst: { on, reason: draft.zero_gst?.reason ?? '' } })} />
              {draft.zero_gst?.on ? <Field label={t('sales.zeroGst.reason')} hint={t('sales.zeroGst.hint')}>{(id, d) => (
                <Input id={id} aria-describedby={d} maxLength={200} value={draft.zero_gst?.reason ?? ''} onChange={(e) => update({ zero_gst: { on: true, reason: e.target.value } })} />)}</Field> : null}
            </CardContent></Card>
          ) : null}
          {mode === 'estimate' ? (
            <Card><CardContent className="pt-4">
              <Field label={t('sales.estimate.notes')} hint={t('sales.estimate.validity', { days: settings.estimate_validity_days })}>{(id, d) => (
                <Input id={id} aria-describedby={d} maxLength={500} value={draft.notes ?? ''} onChange={(e) => update({ notes: e.target.value })} />)}</Field>
            </CardContent></Card>
          ) : null}
        </div>

        <aside className="space-y-3 xl:sticky xl:top-2 xl:self-start" aria-label={t('sales.totals.title')}>
          <Card>
            <CardHeader><CardTitle>{t('sales.totals.title')}</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {comp ? <BillTotalsPanel c={comp} stale={stale} /> : (
                <div data-testid="rough-total">
                  <Row label={t('sales.totals.rough')}><Money v={rough} big /></Row>
                  {gaps.length ? <p className="text-xs text-muted-foreground" data-testid="gaps">{gaps.map((g) => tk(`sales.gap.${g}`)).join(' · ')}</p> : null}
                </div>
              )}
              {comp ? <GstBreakup c={comp} /> : null}
              {comp?.warnings.map((w) => <p key={`${w.code}-${w.path ?? ''}`} role="note" className="rounded bg-warning/15 p-1 text-xs">{tk(`sales.warning.${w.code}`) !== `sales.warning.${w.code}` ? tk(`sales.warning.${w.code}`) : w.message}</p>)}
            </CardContent>
          </Card>
          {mode === 'bill' ? (
            <Card>
              <CardContent className="space-y-3 pt-4">
                {r?.pan_required && !r.pan_on_file ? (
                  <Field label={t('sales.pan.label')} hint={t('sales.pan.hint', { amount: formatINR(settings.pan_required_above) })}>{(id, d) => (
                    <Input id={id} aria-describedby={d} autoComplete="off" spellCheck={false} maxLength={10} className="font-mono uppercase" value={draft.pan ?? ''} onChange={(e) => update({ pan: e.target.value })} />)}</Field>
                ) : null}
                {r?.pan_on_file && comp?.customer?.pan_last4 ? <p className="text-sm text-muted-foreground" data-testid="pan-on-file">{t('sales.pan.onFile', { last4: comp.customer.pan_last4 })}</p> : null}
                <TenderEditor ref={payRef} tenders={draft.tenders} due={due} customerId={draft.customer.kind === 'existing' ? draft.customer.id : null} onChange={(x) => update({ tenders: x })} disabled={blocked} />
                {!can(SALES.creditSale) ? <p role="note" className="text-xs text-muted-foreground" data-testid="credit-sale-note">{t('sales.pay.needPayment')}</p> : null}
                {r?.cash_limit && r.cash_limit.exceeded ? (
                  r.cash_limit.mode === 'block' ? null : <p role="note" className="rounded bg-warning/15 p-1 text-xs" data-testid="cash-warn">{t('sales.cash.warn', { limit: formatINR(r.cash_limit.limit) })}</p>
                ) : null}
              </CardContent>
            </Card>
          ) : null}
          {blockers.length ? (
            <ul className="space-y-1" data-testid="blockers">
              {blockers.map((b) => <li key={b}><Alert>{b === 'cash_limit' ? t('sales.block.cash_limit', { limit: formatINR(r?.cash_limit.limit ?? settings.cash_limit_amount) }) : tk(`sales.block.${b}`)}</Alert></li>)}
            </ul>
          ) : null}
          {!makingRateMissing ? <SalesError error={err} /> : null}
          {confirmTotal ? (
            <div role="alert" className="space-y-2 rounded-md border border-warning p-3" data-testid="total-changed">
              <p className="font-semibold">{t('sales.issue.totalChanged', { total: formatINR(confirmTotal) })}</p>
              <Button disabled={!canIssue} onClick={() => issue.mutate(confirmTotal)}>{t('sales.issue.confirmNew')}</Button>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {mode === 'bill' ? (
              <Button className="h-14 min-w-48 flex-1 whitespace-nowrap text-lg" data-testid="issue-button" disabled={!canIssue || !!confirmTotal} onClick={doIssue}>
                {issue.isPending ? t('sales.issue.working') : t('sales.issue.button')} <Kbd k="Ctrl+S" />
              </Button>
            ) : null}
            {can(SALES.estimateCreate) ? (
              <Button variant={mode === 'bill' ? 'outline' : 'default'} className="h-14 min-w-48 flex-1 whitespace-nowrap" data-testid="estimate-button" disabled={!canEstimate} onClick={() => saveEstimate.mutate()}>
                {editing ? t('sales.estimate.saveChanges') : t('sales.estimate.save')} <Kbd k="Ctrl+E" />
              </Button>
            ) : null}
          </div>
          {isStaleEstimate(saveEstimate.error) ? <p className="text-sm">{t('sales.estimate.stale')}</p> : null}
          <p className="text-xs text-muted-foreground print:hidden">{t('sales.keys')}</p>
        </aside>
      </div>
    </div>
  );
}

/** Lines on the bill: tag (or "Loose"), what it is, weight, rate, making, GST parts, discount (with permission) and the line amount (server figures). */
export function LinesTable({ lines, pricedFor, badLine, onRemove, discount, itemName, purityCode, onPieces }: {
  onPieces?: (key: string, pieces: number) => void;
  lines: DraftLine[]; pricedFor: (i: number) => PricedLine | null; badLine: number | null; onRemove: (key: string) => void;
  discount: { states: DiscountState[]; onChange: (key: string, v: string) => void } | null; itemName: (id?: string | null) => string; purityCode: (id?: string | null) => string;
}) {
  const t = useT();
  const tk = useTk();
  if (!lines.length) return <p className="py-6 text-center text-muted-foreground" data-testid="no-lines">{t('sales.lines.empty')}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" data-testid="bill-lines">
        <thead className="text-xs text-muted-foreground">
          <tr className="text-left"><th>{t('sales.line.tag')}</th><th>{t('sales.line.item')}</th><th className="text-right">{t('sales.line.netWt')}</th>
            <th className="text-right">{t('sales.line.rate')}</th><th className="text-right">{t('sales.line.making')}</th>
            {discount ? <th className="text-right">{t('sales.line.discount')}</th> : null}
            <th className="text-right">{t('sales.line.amount')}</th><th><span className="sr-only">{t('common.remove')}</span></th></tr>
        </thead>
        <tbody>
          {lines.map((l, i) => {
            const p = pricedFor(i);
            const ds = discount?.states[i] ?? 'none';
            const label = l.kind === 'tag' ? l.tag_no : t('sales.loose.badge');
            return (
              <tr key={l.key} className={`border-t border-border align-top ${badLine === i ? 'bg-destructive/10' : ''}`} data-testid="bill-line">
                <td lang={l.kind === 'tag' ? 'en' : undefined} className="whitespace-nowrap py-2 font-mono">{l.kind === 'tag' ? l.tag_no : <span className="rounded bg-muted px-1 font-sans text-xs">{label}</span>}</td>
                <td className="py-2">{p ? `${p.description} · ${p.purity_code}` : l.kind === 'loose' ? `${l.description || itemName(l.item_id)} · ${purityCode(l.purity_id)}` : '—'}
                  {l.kind === 'loose' && onPieces ? <Field label={t('sales.loose.pieces')}>{(fid) => <Input id={fid} type="number" min={0} step={1} className="h-9 min-h-0 w-24 font-mono" aria-invalid={l.pieces === 0 || undefined} value={l.pieces ?? 1} onChange={(e) => { if (/^\d{0,4}$/.test(e.target.value)) onPieces(l.key, Number(e.target.value)); }} />}</Field> : null}
                  {p?.huid ? <span lang="en" className="block font-mono text-xs text-muted-foreground">{t('sales.line.huid')} {p.huid}</span> : null}
                  {p?.tax_parts.length ? <span className="block text-xs text-muted-foreground" data-testid="tax-parts">
                    {p.tax_parts.map((x) => `${tk(`sales.taxPart.${x.component}`)} ${formatPercent(x.rate)} ${formatINR(sumMoney([x.cgst, x.sgst, x.igst]))}`).join(' · ')}</span> : null}
                </td>
                <td className="whitespace-nowrap py-2 text-right tabular-nums">{p ? formatWeight(p.net_wt) : l.kind === 'loose' ? formatWeight(l.net_wt) : '—'}</td>
                <td className="whitespace-nowrap py-2 text-right tabular-nums">{p ? formatINR(p.rate_per_g) : '—'}</td>
                <td className="whitespace-nowrap py-2 text-right tabular-nums">{p ? formatINR(p.mc_amount) : '—'}</td>
                {discount ? (
                  <td className="py-1 text-right">
                    <Input aria-label={t('sales.line.discountFor', { line: label })} inputMode="decimal" className="ml-auto h-9 min-h-0 w-24 text-right font-mono" placeholder="0.00"
                      aria-invalid={ds === 'invalid' || ds === 'over_value' || undefined} value={l.discount ?? ''} onChange={(e) => discount.onChange(l.key, e.target.value)} />
                    {ds !== 'none' && ds !== 'ok' ? <span className="block text-xs" data-testid="line-discount-state">{tk(`sales.discount.state.${ds}`)}</span> : null}
                  </td>
                ) : null}
                <td className="whitespace-nowrap py-2 text-right font-semibold tabular-nums">{p ? formatINR(p.line_total) : '—'}</td>
                <td className="py-1 text-right"><Button variant="ghost" size="icon" aria-label={t('sales.lines.remove', { tag: label })} onClick={() => onRemove(l.key)}><Trash2 className="h-4 w-4" /></Button></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
