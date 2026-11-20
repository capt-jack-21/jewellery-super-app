import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Printer, ScanLine, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Check, Field, Select } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { EditGate, ErrorText } from '@/components/page';
import { useT } from '@/i18n';
import { useAttemptKey } from '@/lib/api/attempt-key';
import { ApiError } from '@/lib/api/fetcher';
import { formatWeight } from '@/lib/format';
import { INV, invPerm } from '@/lib/permissions';
import { inventoryApi, MAX_IDS } from './api';
import { MIN_TEXT } from './adjustments';
import { code128Bars } from './barcode';
import { QR_QUIET, qrMatrix, qrPath } from './qr';
import { InvPage, NotReadyOr } from './ui';
import type { TagLabel, TagLabelBatch } from './types';

/** Print doc_type for tag labels (POST /v1/inventory/labels → TagLabelBatch.doc_type 'tag_label'). */
export const TAG_LABEL_DOC_TYPE = 'tag_label' as const;
export const LABEL_SIZES = ['small', 'medium', 'barbell'] as const;
export type LabelSize = (typeof LABEL_SIZES)[number];
/** Comma list in ?ids= → unique non-empty ids (max 200 per print run). */
export const parseIds = (raw: unknown): string[] => [...new Set(String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean))].slice(0, MAX_IDS);
/**
 * The server wants a reprint with a reason. 0.8.7 contract: 422 reprint_required. Known server gap (0.8.7): a first print of
 * an already-printed tag can come back as 409 already_printed instead — treated the same (opens the reprint reason).
 */
export const isReprintRequired = (e: unknown): boolean =>
  e instanceof ApiError && ((e.status === 422 && e.code === 'reprint_required') || (e.status === 409 && e.code === 'already_printed'));
/** 0.8.7: a reprint reason is 3–200 characters after trimming (else 422 on reprint_reason). */
export const REPRINT_REASON_MAX = 200;
export const reprintReasonOk = (r: string): boolean => { const n = r.trim().length; return n >= MIN_TEXT && n <= REPRINT_REASON_MAX; };

/**
 * 3 — Label print (0.8.0): pick pieces, then "Get labels" POSTs /v1/inventory/labels — that RECORDS the print
 * (label_print_count += copies), so it is a button, never an automatic fetch. A piece printed before needs "Reprint"
 * with a reason (422 reprint_required). The browser draws the Code128 barcode from barcode_payload.
 */
export function LabelPrintPage() {
  const t = useT();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const search = useSearch({ strict: false }) as { ids?: string };
  const ids = parseIds(search.ids);
  const [size, setSize] = useState<LabelSize>('small');
  const [copies, setCopies] = useState(1);
  const key = useAttemptKey();
  const [reprint, setReprint] = useState(false);
  const [reason, setReason] = useState('');
  const [tag, setTag] = useState('');
  const [batch, setBatch] = useState<TagLabelBatch | null>(null);
  const setIds = (next: string[]) => { setBatch(null); key.reset(); void navigate({ to: '/inventory/labels', search: { ids: next.join(',') || undefined } as never, replace: true }); };
  const get = useMutation({
    // 0.8.2: POST /labels records the print, so one Idempotency-Key per attempt (a retry never double-counts copies).
    mutationFn: () => inventoryApi.labels(ids, key.take(), { copies, reprint, reprintReason: reason.trim() }),
    // The print bumps label_print_count / label_printed_at and the piece version: refresh cached pieces and lists so the
    // piece screen shows the new count and a later edit sends the fresh If-Match.
    onSuccess: (b) => { key.reset(); setBatch(b); void qc.invalidateQueries({ queryKey: ['inventory', 'tag'] }); void qc.invalidateQueries({ queryKey: ['inventory', 'tags'] }); },
    onError: (e) => { key.settle(e); if (isReprintRequired(e)) { key.reset(); setReprint(true); } },
  });
  const add = useMutation({ mutationFn: () => inventoryApi.lookup(tag), onSuccess: (p) => { setTag(''); if (!ids.includes(p.id)) setIds([...ids, p.id]); } });
  const total = labelRun(batch?.labels, copies).length;
  return (
    <InvPage title="inventory.labels.title" description="inventory.labels.desc">
      <EditGate perm={invPerm(INV.tagPrintLabel)}>
        <Card className="print:hidden"><CardContent className="flex flex-wrap items-end gap-3 pt-4">
          <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (tag.trim()) add.mutate(); }}>
            <Field label={t('inventory.labels.addByTag')} hint={t('inventory.scanHint')}>{(id, h) => <Input id={id} aria-describedby={h} lang="en" className="font-mono uppercase" value={tag} onChange={(e) => setTag(e.target.value)} />}</Field>
            <Button type="submit" variant="outline" disabled={!tag.trim() || add.isPending}><ScanLine className="h-4 w-4" aria-hidden />{t('inventory.add')}</Button>
          </form>
          <Field label={t('inventory.labels.size')}>{(id) => (
            <Select id={id} value={size} onChange={(e) => setSize(e.target.value as LabelSize)}>
              {LABEL_SIZES.map((s) => <option key={s} value={s}>{t(`inventory.labels.size.${s}`)}</option>)}
            </Select>)}</Field>
          <Field label={t('inventory.labels.copies')}>{(id) => (
            <Select id={id} value={String(copies)} onChange={(e) => { setCopies(Number(e.target.value)); setBatch(null); key.reset(); }}>
              {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
            </Select>)}</Field>
          <Button variant="outline" disabled={!ids.length || get.isPending || (reprint && !reprintReasonOk(reason))} onClick={() => get.mutate()}>{t('inventory.labels.get', { n: ids.length })}</Button>
          <Button disabled={!batch?.labels.length} onClick={() => window.print()}><Printer className="h-4 w-4" aria-hidden />{t('inventory.labels.print', { n: total })}</Button>
          {ids.length ? <Button variant="ghost" onClick={() => setIds([])}>{t('inventory.labels.clear')}</Button> : null}
        </CardContent></Card>
        {reprint ? (
          <Card className="print:hidden"><CardContent className="space-y-2 pt-4">
            <p role="note" className="text-sm">{t('inventory.labels.reprintNote')}</p>
            <Check label={t('inventory.labels.reprint')} checked={reprint} onChange={(on) => { setReprint(on); key.reset(); }} />
            <Field label={t('inventory.labels.reprintReason')} hint={t('inventory.labels.reprintReasonHint', { min: MIN_TEXT, max: REPRINT_REASON_MAX })} className="max-w-md">{(id, h) => <Input id={id} aria-describedby={h} maxLength={REPRINT_REASON_MAX} aria-invalid={reason.trim() !== '' && !reprintReasonOk(reason)} value={reason} onChange={(e) => { setReason(e.target.value); key.reset(); }} />}</Field>
          </CardContent></Card>
        ) : null}
        <ErrorText error={add.error} />
        {get.error && !isReprintRequired(get.error) ? <NotReadyOr error={get.error} /> : null}
      </EditGate>
      <p className="text-xs text-muted-foreground print:hidden">{t('inventory.labels.templateNote')} <Link to="/settings/print" className="underline">{t('nav.print')}</Link></p>
      {!ids.length ? <p className="text-sm text-muted-foreground">{t('inventory.labels.none')}</p> : null}
      {batch?.labels.length ? <LabelSheet labels={batch.labels} fallbackCopies={copies} size={size} qr={batch.barcode_format === 'qr'} onRemove={(id) => setIds(ids.filter((x) => x !== id))} /> : null}
    </InvPage>
  );
}

const SIZE_CLASS: Record<LabelSize, string> = { small: 'w-48 text-xs', medium: 'w-64 text-sm', barbell: 'w-72 text-xs' };

/** Code128 as SVG (no package). Falls back to the payload text when it can't be encoded. */
export function Barcode({ payload, label }: { payload: string; label: string }) {
  const b = code128Bars(payload);
  if (!b) return <p lang="en" aria-label={label} className="my-1 text-center font-mono">{payload}</p>;
  return (
    <svg role="img" aria-label={label} data-testid="barcode" viewBox={`0 0 ${b.width} 30`} preserveAspectRatio="none" className="my-1 h-8 w-full fill-current text-foreground">
      {b.bars.map((r) => <rect key={r.x} x={r.x} y={0} width={r.w} height={30} />)}
    </svg>
  );
}

/** QR as SVG (qrcode-generator). Falls back to the payload text when it can't be encoded. */
export function QrCode({ payload, label }: { payload: string; label: string }) {
  const m = useMemo(() => qrMatrix(payload), [payload]);
  if (!m) return <p lang="en" aria-label={label} className="my-1 text-center font-mono">{payload}</p>;
  const box = m.size + 2 * QR_QUIET;
  return (
    <svg role="img" aria-label={label} data-testid="qr" data-modules={m.size} viewBox={`${-QR_QUIET} ${-QR_QUIET} ${box} ${box}`} shapeRendering="crispEdges" className="mx-auto my-1 h-20 w-20 fill-current text-foreground">
      <path d={qrPath(m)} />
    </svg>
  );
}

/**
 * 0.8.8: each label row carries its own `copies` (the batch-level copies is gone). Repeat each row that many times; when a
 * row has none (older server), use the copies that were asked for. Never fewer than 1.
 */
export function labelRun<T extends { copies?: number | null }>(labels: readonly T[] | null | undefined, fallbackCopies = 1): Array<{ l: T; k: number }> {
  const fb = Number.isInteger(fallbackCopies) && fallbackCopies > 0 ? fallbackCopies : 1;
  return (labels ?? []).flatMap((l) => {
    const n = typeof l?.copies === 'number' && Number.isInteger(l.copies) && l.copies > 0 ? l.copies : fb;
    return Array.from({ length: n }, (_, k) => ({ l, k }));
  });
}

/** Screen + print sheet: each label repeated `copies` times. QR templates draw a QR, others Code128. */
export function LabelSheet({ labels, size, qr = false, onRemove, fallbackCopies = 1 }: { labels: TagLabel[]; size: LabelSize; qr?: boolean; onRemove?: (tagId: string) => void; fallbackCopies?: number }) {
  const t = useT();
  const run = labelRun(labels, fallbackCopies);
  return (
    <section data-testid="label-sheet" data-doc-type={TAG_LABEL_DOC_TYPE} aria-label={t('inventory.labels.preview')} className="flex flex-wrap gap-3">
      {run.map(({ l, k }) => (
        <article key={`${l.tag_id}-${k}`} data-testid="tag-label" className={`relative break-inside-avoid rounded border border-border bg-card p-2 text-card-foreground ${SIZE_CLASS[size]}`}>
          {onRemove && k === 0 ? <Button type="button" size="icon" variant="ghost" className="absolute right-0 top-0 h-6 w-6 print:hidden" aria-label={`${t('common.remove')} ${l.tag_no}`} onClick={() => onRemove(l.tag_id)}><X className="h-3 w-3" /></Button> : null}
          <p lang="en" className="font-mono font-semibold">{l.tag_no}</p>
          {qr ? <QrCode payload={l.barcode_payload} label={t('inventory.labels.barcode')} />
            : <Barcode payload={l.barcode_payload} label={t('inventory.labels.barcode')} />}
          <p>{l.item_name} <span lang="en" className="font-mono">{l.purity_code}</span></p>
          <p className="tabular-nums">{`${t('inventory.labels.gw')} ${formatWeight(l.gross_wt)} · ${t('inventory.labels.nw')} ${formatWeight(l.net_wt)}`}</p>
          {l.huid ? <p lang="en" className="font-mono">{`HUID ${l.huid}`}</p> : null}
          {l.duplicate === true ? <p data-testid="label-duplicate" className="w-fit rounded border border-current px-1 text-[10px] uppercase">{t('inventory.labels.duplicate')}</p> : null}
        </article>
      ))}
    </section>
  );
}
