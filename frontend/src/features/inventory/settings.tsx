import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Check, Field, Select } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { EditGate, ErrorText, Saved } from '@/components/page';
import { useT, useTk } from '@/i18n';
import { ApiError } from '@/lib/api/fetcher';
import { useOnline } from '@/lib/offline/connectivity';
import { useSignedIn } from '@/lib/session';
import { INV, invPerm } from '@/lib/permissions';
import type { InventorySettingsAdjustmentApprover, InventorySettingsPatch } from '@/lib/api/backend/model';
import { inventoryApi, inventoryKeys, isNotReady } from './api';
import { useInventorySettings, useInvRefs } from './hooks';
import { DEFAULT_AGEING_EDGES, parseEdges } from './ageing';
import {
  cleanCode, DEFAULT_TAG_FORMAT, DIGITS_MAX, DIGITS_MIN, formatPatch, maxLength, renderTag, SEPARATORS, startsNewNumbering,
  TAG_SHORT_LEN, validateTagFormat, type TagFormat,
} from './tag-format';
import { DEFAULT_ADJUSTMENT_NO_FORMAT, DEFAULT_TRANSFER_NO_FORMAT, DOC_NO_MAX, docNoFormatError, fyCode, renderDocNo } from './doc-no-format';
import { InvPage, NotReadyOr } from './ui';

const SEP_KEY = { '': 'inventory.tagFormat.sep.none', '-': 'inventory.tagFormat.sep.dash', '/': 'inventory.tagFormat.sep.slash' } as const;
const APPROVERS: InventorySettingsAdjustmentApprover[] = ['owner_or_manager', 'owner_only'];

/**
 * 12 — Inventory settings (0.8.2 §5): structured tag number format + server preview, transfer / adjustment number formats
 * ({BRANCH} {FY} … {SEQ:n} last), photos, ageing, adjustment approver.
 */
export function InventorySettingsPage() {
  const t = useT();
  const tk = useTk();
  const qc = useQueryClient();
  const online = useOnline();
  const signedIn = useSignedIn();
  const refs = useInvRefs();
  const s = useInventorySettings();
  const [fmt, setFmt] = useState<TagFormat>(DEFAULT_TAG_FORMAT);
  const [startRaw, setStartRaw] = useState('1');
  const [photos, setPhotos] = useState(true);
  const [ageing, setAgeing] = useState(true);
  const [edgesRaw, setEdgesRaw] = useState(DEFAULT_AGEING_EDGES.join(', '));
  const [approver, setApprover] = useState<InventorySettingsAdjustmentApprover>('owner_or_manager');
  const [trfFmt, setTrfFmt] = useState(DEFAULT_TRANSFER_NO_FORMAT);
  const [adjFmt, setAdjFmt] = useState(DEFAULT_ADJUSTMENT_NO_FORMAT);
  useEffect(() => {
    const d = s.data;
    if (!d) return;
    setFmt(d.tag_format); setStartRaw(String(d.tag_format.start_no));
    setPhotos(d.photos_enabled); setAgeing(d.ageing_enabled); setEdgesRaw(d.ageing_bucket_days.join(', ')); setApprover(d.adjustment_approver);
    setTrfFmt(d.transfer_no_format ?? DEFAULT_TRANSFER_NO_FORMAT); setAdjFmt(d.adjustment_no_format ?? DEFAULT_ADJUSTMENT_NO_FORMAT);
  }, [s.data]);
  const longest = {
    branch: Math.max(1, ...refs.branches.map((b) => cleanCode(b.code).length)),
    item: Math.max(1, ...refs.items.map((i) => cleanCode(i.code).length)),
  };
  const errs = validateTagFormat(fmt, longest);
  const edges = parseEdges(edgesRaw);
  const trfErr = docNoFormatError(trfFmt);
  const adjErr = docNoFormatError(adjFmt);
  const docSample = { branch: cleanCode(refs.branches[0]?.code ?? 'CBE') || 'CBE', fy: fyCode(new Date()), seq: 1 };
  const saved = s.data?.tag_format ?? DEFAULT_TAG_FORMAT;
  // Authoritative preview from the server (next number, real codes); only for a locally valid format.
  const preview = useQuery({
    queryKey: inventoryKeys.preview(fmt),
    queryFn: () => inventoryApi.previewTagFormat(fmt),
    enabled: signedIn && !!s.data && errs.length === 0, retry: false, staleTime: 30_000,
  });
  const save = useMutation({
    mutationFn: () => {
      if (!s.data) throw new Error('not loaded');
      const patch: InventorySettingsPatch = {
        photos_enabled: photos, ageing_enabled: ageing, adjustment_approver: approver,
        ageing_bucket_days: edges ?? [...DEFAULT_AGEING_EDGES],
      };
      const tf = formatPatch(saved, fmt);
      if (Object.keys(tf).length) patch.tag_format = tf;
      if (trfFmt.trim() !== (s.data.transfer_no_format ?? DEFAULT_TRANSFER_NO_FORMAT)) patch.transfer_no_format = trfFmt.trim();
      if (adjFmt.trim() !== (s.data.adjustment_no_format ?? DEFAULT_ADJUSTMENT_NO_FORMAT)) patch.adjustment_no_format = adjFmt.trim();
      return inventoryApi.saveSettings(s.data, patch);
    },
    onSuccess: (d) => { qc.setQueryData(inventoryKeys.settings, d); },
    onError: (e) => { if (e instanceof ApiError && e.status === 412) void qc.invalidateQueries({ queryKey: inventoryKeys.settings }); },
  });
  const stale = save.error instanceof ApiError && save.error.status === 412;
  const set = (p: Partial<TagFormat>) => setFmt({ ...fmt, ...p });
  const sample = renderTag(fmt, { branch: refs.branches[0]?.code ?? 'MAIN', item: refs.items[0]?.code ?? 'RNG', no: fmt.start_no });
  const len = maxLength(fmt, longest);
  return (
    <InvPage title="inventory.settings.title" description="inventory.settings.desc">
      <NotReadyOr error={s.error} />
      <EditGate perm={invPerm(INV.settingsEdit)}>
        <Card>
          <CardHeader><CardTitle>{t('inventory.tagFormat.title')}</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">{t('inventory.tagFormat.help')}</p>
            <div className="grid gap-3 md:grid-cols-3">
              <Field label={t('inventory.tagFormat.prefix')} hint={t('inventory.tagFormat.prefixHint')}>{(id, h) => (
                <Input id={id} aria-describedby={h} lang="en" className="font-mono uppercase" maxLength={8} value={fmt.prefix} onChange={(e) => set({ prefix: e.target.value.toUpperCase() })} />)}</Field>
              <Field label={t('inventory.tagFormat.separator')}>{(id) => (
                <Select id={id} value={fmt.separator} onChange={(e) => set({ separator: e.target.value as TagFormat['separator'] })}>
                  {SEPARATORS.map((x) => <option key={x} value={x}>{t(SEP_KEY[x])}</option>)}
                </Select>)}</Field>
              <Field label={t('inventory.tagFormat.order')}>{(id) => (
                <Select id={id} value={fmt.segment_order} disabled={!(fmt.branch_segment && fmt.item_segment)} onChange={(e) => set({ segment_order: e.target.value as TagFormat['segment_order'] })}>
                  <option value="branch_item">{t('inventory.tagFormat.order.branch_item')}</option>
                  <option value="item_branch">{t('inventory.tagFormat.order.item_branch')}</option>
                </Select>)}</Field>
              <Check label={t('inventory.tagFormat.branchSegment')} checked={fmt.branch_segment} onChange={(v) => set({ branch_segment: v })} />
              <Check label={t('inventory.tagFormat.itemSegment')} checked={fmt.item_segment} onChange={(v) => set({ item_segment: v })} />
              <span />
              <Field label={t('inventory.tagFormat.digits')}>{(id) => (
                <Select id={id} value={String(fmt.digits)} onChange={(e) => set({ digits: Number(e.target.value) })}>
                  {Array.from({ length: DIGITS_MAX - DIGITS_MIN + 1 }, (_, i) => DIGITS_MIN + i).map((n) => <option key={n} value={n}>{t('inventory.tagFormat.seqDigits', { n })}</option>)}
                </Select>)}</Field>
              <Field label={t('inventory.tagFormat.startNo')} hint={t('inventory.tagFormat.startNoHint')}>{(id, h) => (
                <Input id={id} aria-describedby={h} inputMode="numeric" value={startRaw} onChange={(e) => { setStartRaw(e.target.value); set({ start_no: /^\d{1,12}$/.test(e.target.value) ? Number(e.target.value) : 0 }); }} />)}</Field>
            </div>
            <div className="rounded-md bg-muted p-3">
              <p className="text-sm">{t('inventory.tagFormat.preview')}</p>
              <p lang="en" className="font-mono text-lg" data-testid="tag-preview">{sample || '—'}</p>
              <p className="text-xs text-muted-foreground">{t('inventory.tagFormat.maxLen', { n: len })}</p>
              {len > TAG_SHORT_LEN ? <p className="text-xs">{t('inventory.tagFormat.longWarn')}</p> : null}
              {preview.data ? (
                <div data-testid="tag-server-preview" className="mt-2 text-sm">
                  <p>{t('inventory.tagFormat.serverPreview')} <span lang="en" className="font-mono">{preview.data.samples.join(', ')}</span></p>
                  {preview.data.errors.map((e) => <p key={e.code} role="alert" className="text-destructive">{tk(`inventory.tagFormat.server.${e.code}`)}</p>)}
                </div>
              ) : preview.error && !isNotReady(preview.error) ? <ErrorText error={preview.error} /> : null}
            </div>
            {errs.length ? <ul className="list-disc pl-5 text-sm text-destructive" data-testid="tag-format-errors">{errs.map((e) => <li key={e}>{t(e)}</li>)}</ul> : null}
            {s.data && startsNewNumbering(saved, fmt) ? <p role="note" className="text-sm">{t('inventory.tagFormat.newNumbering')}</p> : null}
            <p className="text-xs text-muted-foreground">{t('inventory.tagFormat.existing')}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>{t('inventory.docNo.title')}</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">{t('inventory.docNo.help', { branch: '{BRANCH}', fy: '{FY}', seq: '{SEQ:5}' })}</p>
            <div className="grid gap-3 md:grid-cols-2">
              {([
                ['inventory.docNo.transfer', trfFmt, setTrfFmt, trfErr, 'transfer'],
                ['inventory.docNo.adjustment', adjFmt, setAdjFmt, adjErr, 'adjustment'],
              ] as const).map(([label, value, setValue, err, kind]) => (
                <Field key={kind} label={t(label)} hint={err ? undefined : t('inventory.docNo.sample', { no: renderDocNo(value, docSample) })} error={err ? t(err, { n: DOC_NO_MAX }) : null}>{(id, h) => (
                  <Input id={id} aria-describedby={h} lang="en" className="font-mono" maxLength={DOC_NO_MAX} value={value} data-testid={`docno-${kind}`} onChange={(e) => setValue(e.target.value)} />)}</Field>
              ))}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>{t('inventory.settings.other')}</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <Check label={t('inventory.settings.photos')} checked={photos} onChange={setPhotos} />
            <Check label={t('inventory.settings.ageing')} checked={ageing} onChange={setAgeing} />
            {ageing ? (
              <Field label={t('inventory.settings.edges')} hint={t('inventory.settings.edgesHint')} error={edges ? null : t('inventory.settings.edgesErr')} className="max-w-sm">
                {(id, d) => <Input id={id} aria-describedby={d} inputMode="numeric" value={edgesRaw} onChange={(e) => setEdgesRaw(e.target.value)} />}
              </Field>
            ) : null}
            <Field label={t('inventory.settings.approver')} hint={t('inventory.settings.approverHint')} className="max-w-sm">{(id, h) => (
              <Select id={id} aria-describedby={h} value={approver} onChange={(e) => setApprover(e.target.value as InventorySettingsAdjustmentApprover)}>
                {APPROVERS.map((a) => <option key={a} value={a}>{t(`inventory.settings.approver.${a}`)}</option>)}
              </Select>)}</Field>
          </CardContent>
        </Card>
        {stale ? <p role="alert" className="text-sm text-destructive">{t('inventory.settings.stale')}</p> : <ErrorText error={save.error} />}
        <div className="flex items-center gap-3">
          <Button disabled={!online || !s.data || errs.length > 0 || !!trfErr || !!adjErr || (ageing && !edges) || save.isPending} onClick={() => save.mutate()}>{t('common.save')}</Button>
          <Saved show={save.isSuccess} />
        </div>
      </EditGate>
    </InvPage>
  );
}
