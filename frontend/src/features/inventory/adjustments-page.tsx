import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Select } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { EditGate, ErrorText, Saved } from '@/components/page';
import { useT, useTk } from '@/i18n';
import { useAttemptKey } from '@/lib/api/attempt-key';
import { D, formatDateTimeIN, formatWeight } from '@/lib/format';
import { useOnline } from '@/lib/offline/connectivity';
import { useSignedIn } from '@/lib/session';
import { INV, invPerm } from '@/lib/permissions';
import { inventoryApi, inventoryKeys } from './api';
import { useInvCan, useInvRefs, useInventorySettings, useMe } from './hooks';
import { adjustmentError, canApprove, fullWriteOffDeltas, KIND_SHAPE, MIN_TEXT, optionalTextOk, REASON_MIN, signedWeight, textOk } from './adjustments';
import { TagPicker, type Picked } from './picker';
import { BranchPicker, InvPage, NotReadyOr } from './ui';
import { ADJUSTMENT_KINDS, REASON_CODES, type AdjustmentKind, type AdjustmentStatus, type ReasonCode, type StockAdjustment, type StockAdjustmentInput } from './types';

/** Build the request body from the form (pure; call after adjustmentError() === null). */
export function toAdjustmentInput(f: {
  kind: AdjustmentKind; reasonCode: ReasonCode; reason: string; wt: string; pieces: string;
  tag?: Pick<Picked, 'id' | 'branch_id'> & Partial<Pick<Picked, 'pieces' | 'gross_wt' | 'net_wt'>>; loose?: { branch_id: string; item_id: string; purity_id: string; counter_id: string };
}): StockAdjustmentInput {
  if (f.kind === 'full_write_off' && f.tag) {
    // 0.8.2: the whole piece goes — deltas must be exactly minus its pieces / gross / net (422 invalid_delta).
    const d = fullWriteOffDeltas({ pieces: f.tag.pieces ?? 1, gross_wt: f.tag.gross_wt ?? '0', net_wt: f.tag.net_wt ?? '0' });
    return { branch_id: f.tag.branch_id, tag_id: f.tag.id, kind: f.kind, reason_code: f.reasonCode, reason: f.reason.trim(), delta_pieces: d.pieces_delta, delta_gross_wt: d.gross_wt_delta, delta_net_wt: d.net_wt_delta };
  }
  const s = KIND_SHAPE[f.kind];
  const wt = s.weight ? signedWeight(f.wt, s.weight) : null;
  const pcs = s.pieces && f.pieces.trim() ? Number(f.pieces) * (s.pieces === 'neg' ? -1 : 1) : undefined;
  const target = f.tag
    ? { branch_id: f.tag.branch_id, tag_id: f.tag.id }
    : { branch_id: f.loose?.branch_id ?? '', item_id: f.loose?.item_id, purity_id: f.loose?.purity_id, counter_id: f.loose?.counter_id || null };
  return {
    ...target, kind: f.kind, reason_code: f.reasonCode, reason: f.reason.trim(),
    ...(wt ? { delta_gross_wt: wt, delta_net_wt: wt } : {}), ...(pcs ? { delta_pieces: pcs } : {}),
  };
}

/** 8 — Adjustments (0.8.2): request (always pending), approver decides per the shop rule; the server enforces it. */
export function AdjustmentsPage() {
  return (
    <InvPage title="inventory.adj.title" description="inventory.adj.desc">
      <EditGate perm={invPerm(INV.adjustmentRequest)}><RequestForm /></EditGate>
      <Queue />
    </InvPage>
  );
}

function RequestForm() {
  const t = useT();
  const tk = useTk();
  const qc = useQueryClient();
  const online = useOnline();
  const key = useAttemptKey();
  const refs = useInvRefs();
  const settings = useInventorySettings();
  const [target, setTarget] = useState<'tag' | 'loose'>('tag');
  const [kind, setKind] = useState<AdjustmentKind>('weight_loss');
  const [reasonCode, setReasonCode] = useState<ReasonCode>('polishing');
  const [picked, setPicked] = useState<Picked[]>([]);
  const [loose, setLoose] = useState({ branch_id: '', item_id: '', purity_id: '', counter_id: '' });
  const [wt, setWt] = useState('');
  const [pieces, setPieces] = useState('');
  const [reason, setReason] = useState('');
  const tag = target === 'tag' ? picked[0] : undefined;
  const looseTarget = { ...loose, branch_id: loose.branch_id || refs.branches[0]?.id || '' };
  const err = adjustmentError(kind, reason, wt, pieces, target === 'tag');
  const ready = target === 'tag' ? !!tag : !!looseTarget.branch_id && !!loose.item_id && !!loose.purity_id;
  const shape = KIND_SHAPE[kind];
  const showWt = !!shape.weight;
  const save = useMutation({
    mutationFn: () => inventoryApi.requestAdjustment(toAdjustmentInput({ kind, reasonCode, reason, wt, pieces, tag, loose: target === 'loose' ? looseTarget : undefined }), key.take()),
    onSuccess: () => { key.reset(); setPicked([]); setWt(''); setPieces(''); setReason(''); void qc.invalidateQueries({ queryKey: ['inventory', 'adjustments'] }); },
    onError: (e) => key.settle(e),
  });
  const r = () => key.reset();
  return (
    <Card>
      <CardHeader><CardTitle>{t('inventory.adj.new')}</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 md:grid-cols-3">
          <Field label={t('inventory.adj.target')}>{(id) => (
            <Select id={id} value={target} onChange={(e) => { setTarget(e.target.value as 'tag' | 'loose'); r(); }}>
              <option value="tag">{t('inventory.adj.target.tag')}</option><option value="loose">{t('inventory.adj.target.loose')}</option>
            </Select>)}</Field>
          <Field label={t('inventory.adj.kind')}>{(id) => (
            <Select id={id} value={kind} onChange={(e) => { setKind(e.target.value as AdjustmentKind); r(); }}>
              {ADJUSTMENT_KINDS.map((k) => <option key={k} value={k}>{tk(`inventory.adj.kind.${k}`)}</option>)}
            </Select>)}</Field>
          <Field label={t('inventory.adj.reasonCode')}>{(id) => (
            <Select id={id} value={reasonCode} onChange={(e) => { setReasonCode(e.target.value as ReasonCode); r(); }}>
              {REASON_CODES.map((k) => <option key={k} value={k}>{tk(`inventory.adj.reasonCode.${k}`)}</option>)}
            </Select>)}</Field>
        </div>
        {target === 'tag' ? <TagPicker picked={picked} onChange={(p) => { setPicked(p.slice(-1)); r(); }} /> : (
          <div className="grid gap-3 md:grid-cols-4">
            <Field label={t('inventory.branch')}>{(id) => <BranchPicker id={id} value={looseTarget.branch_id} onChange={(v) => { setLoose({ ...loose, branch_id: v, counter_id: '' }); r(); }} branches={refs.branches} />}</Field>
            <Field label={t('inventory.item')}>{(id) => (
              <Select id={id} value={loose.item_id} onChange={(e) => { setLoose({ ...loose, item_id: e.target.value, purity_id: refs.item(e.target.value)?.purity_id ?? loose.purity_id }); r(); }}>
                <option value="" disabled>{t('common.choose')}</option>
                {refs.items.filter((i) => i.stock_type !== 'tag').map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
              </Select>)}</Field>
            <Field label={t('inventory.purity')}>{(id) => (
              <Select id={id} value={loose.purity_id} onChange={(e) => { setLoose({ ...loose, purity_id: e.target.value }); r(); }}>
                <option value="" disabled>{t('common.choose')}</option>
                {refs.purities.filter((p) => p.is_active).map((p) => <option key={p.id} value={p.id}>{p.code}</option>)}
              </Select>)}</Field>
            <Field label={t('inventory.counter')}>{(id) => (
              <Select id={id} value={loose.counter_id} onChange={(e) => { setLoose({ ...loose, counter_id: e.target.value }); r(); }}>
                <option value="">{t('inventory.none')}</option>
                {refs.counters.filter((c) => c.branch_id === looseTarget.branch_id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>)}</Field>
          </div>
        )}
        <div className="grid gap-3 md:grid-cols-3">
          {showWt ? <Field label={t('inventory.adj.delta')} hint={t(shape.weight === 'signed' ? 'inventory.adj.deltaHint' : 'inventory.adj.sizeHint')}>{(id, h) => <Input id={id} aria-describedby={h} inputMode="decimal" className="tabular-nums" value={wt} onChange={(e) => { setWt(e.target.value); r(); }} />}</Field> : null}
          {shape.pieces ? <Field label={t('inventory.adj.pieces')}>{(id) => <Input id={id} inputMode="numeric" value={pieces} onChange={(e) => { setPieces(e.target.value); r(); }} />}</Field> : null}
        </div>
        <Field label={t('inventory.adj.reason')} hint={t('inventory.adj.reasonHint', { n: REASON_MIN })}>{(id, h) => <Input id={id} aria-describedby={h} value={reason} onChange={(e) => { setReason(e.target.value); r(); }} />}</Field>
        {kind === 'full_write_off' ? <p className="text-sm text-muted-foreground">{t('inventory.adj.fullWriteOffHint')}</p> : null}
        {(reason || kind === 'full_write_off') && err ? <p className="text-sm text-destructive">{t(err)}</p> : null}
        <p className="text-sm text-muted-foreground">{t('inventory.adj.willWait', { who: t(`inventory.settings.approver.${settings.data?.adjustment_approver ?? 'owner_or_manager'}`) })}</p>
        <ErrorText error={save.error} />
        <div className="flex items-center gap-3">
          <Button disabled={!online || !ready || !!err || save.isPending} onClick={() => save.mutate()}>{t('inventory.adj.submit')}</Button>
          <Saved show={save.isSuccess} />
        </div>
      </CardContent>
    </Card>
  );
}

function Queue() {
  const t = useT();
  const tk = useTk();
  const signedIn = useSignedIn();
  const [status, setStatus] = useState<AdjustmentStatus | 'all'>('pending');
  const q = useQuery({ queryKey: inventoryKeys.adjustments(status), queryFn: () => inventoryApi.adjustments(status), enabled: signedIn, retry: false });
  const items = q.data?.items ?? [];
  return (
    <Card>
      <CardHeader><CardTitle>{t('inventory.adj.queue')}</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <Field label={t('common.status')} className="max-w-xs">{(id) => (
          <Select id={id} value={status} onChange={(e) => setStatus(e.target.value as AdjustmentStatus | 'all')}>
            {(['pending', 'approved', 'rejected', 'cancelled', 'all'] as const).map((s) => <option key={s} value={s}>{tk(`inventory.adj.status.${s}`)}</option>)}
          </Select>)}</Field>
        <NotReadyOr error={q.error} />
        {q.isSuccess && !items.length ? <p className="text-sm text-muted-foreground">{t('inventory.adj.empty')}</p> : null}
        <ul className="divide-y divide-border">{items.map((a) => <AdjRow key={a.id} a={a} />)}</ul>
      </CardContent>
    </Card>
  );
}

function AdjRow({ a }: { a: StockAdjustment }) {
  const t = useT();
  const tk = useTk();
  const qc = useQueryClient();
  const online = useOnline();
  const me = useMe();
  const can = useInvCan();
  const refs = useInvRefs();
  const settings = useInventorySettings();
  const [note, setNote] = useState('');
  const allowed = can(INV.adjustmentApprove) && canApprove(me, a, settings.data?.adjustment_approver ?? 'owner_or_manager');
  const own = a.requested_by === me.id;
  const done = () => void qc.invalidateQueries({ queryKey: ['inventory'] });
  const approve = useMutation({ mutationFn: () => inventoryApi.approve(a, note.trim()), onSuccess: done });
  const reject = useMutation({ mutationFn: () => inventoryApi.reject(a, note.trim()), onSuccess: done });
  const cancel = useMutation({ mutationFn: () => inventoryApi.cancelAdjustment(a), onSuccess: done });
  const net = D(a.delta_net_wt || '0');
  return (
    <li className="space-y-2 py-2 text-sm" data-testid="adjustment">
      <div className="flex flex-wrap items-center gap-3">
        <Badge variant={a.status === 'pending' ? 'warning' : a.status === 'approved' ? 'success' : 'outline'}>{tk(`inventory.adj.status.${a.status}`)}</Badge>
        {a.adjustment_no ? <span lang="en" className="font-mono">{a.adjustment_no}</span> : null}
        <span>{`${tk(`inventory.adj.kind.${a.kind}`)} · ${tk(`inventory.adj.reasonCode.${a.reason_code}`)}`}</span>
        <span lang="en" className="font-mono">{a.tag_no ?? `${refs.itemName(a.item_id)} · ${refs.purityCode(a.purity_id)}`}</span>
        {net.isZero() ? null : <span className="tabular-nums">{`${net.isNegative() ? '−' : '+'}${formatWeight(net.abs().toFixed(3))}`}</span>}
        {a.delta_pieces ? <span className="tabular-nums">{t('inventory.adj.piecesDelta', { n: a.delta_pieces })}</span> : null}
        <span className="text-muted-foreground">{a.requested_at ? formatDateTimeIN(a.requested_at) : ''}</span>
        {a.self_approved ? <Badge variant="outline">{t('inventory.adj.selfApproved')}</Badge> : null}
      </div>
      <p>{a.reason}</p>
      {a.decision_note ? <p className="text-muted-foreground">{t('inventory.adj.decisionNote', { note: a.decision_note })}</p> : null}
      {a.status === 'pending' && allowed ? (
        <div className="flex flex-wrap items-end gap-2">
          <Field label={t('inventory.adj.decisionLabel')} hint={t('inventory.minText', { n: MIN_TEXT })} className="flex-1">{(id, h) => <Input id={id} aria-describedby={h} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
          <Button size="sm" disabled={!online || !optionalTextOk(note) || approve.isPending} onClick={() => approve.mutate()}>{t('inventory.adj.approve')}</Button>
          <Button size="sm" variant="destructive" disabled={!online || !textOk(note) || reject.isPending} onClick={() => reject.mutate()}>{t('inventory.adj.reject')}</Button>
        </div>
      ) : a.status === 'pending' ? <p className="text-xs text-muted-foreground">{t(own ? 'inventory.adj.notOwn' : 'inventory.adj.waiting')}</p> : null}
      {a.status === 'pending' && own && can(INV.adjustmentRequest) ? <Button size="sm" variant="ghost" disabled={!online || cancel.isPending} onClick={() => cancel.mutate()}>{t('inventory.adj.withdraw')}</Button> : null}
      <ErrorText error={approve.error ?? reject.error ?? cancel.error} />
    </li>
  );
}
