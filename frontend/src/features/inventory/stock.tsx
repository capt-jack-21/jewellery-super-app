import { useRef, useState, type ReactNode } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { ImagePlus, Printer, Search, Star, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable } from '@/components/ui/data-table';
import { Field, Select } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { EditGate, ErrorText, Loading } from '@/components/page';
import { useT, useTk, type MessageKey } from '@/i18n';
import { formatDateIN, formatDateTimeIN, formatINR, formatPercent } from '@/lib/format';
import { INV, invPerm } from '@/lib/permissions';
import { useOnline } from '@/lib/offline/connectivity';
import { useSignedIn } from '@/lib/session';
import { useAttemptKey } from '@/lib/api/attempt-key';
import { mastersApi } from '@/features/masters/api';
import { PhotoThumb } from '@/features/masters/master-screen';
import { checkPhotos, PHOTO_TYPES } from '@/features/masters/photos';
import { hasFieldCode, inventoryApi, inventoryKeys } from './api';
import { VENDOR_LOT_REF_MAX, vendorLotRef } from './lots';
import { MIN_TEXT, textOk } from './adjustments';
import { useInvCan, useInvRefs, useInventorySettings } from './hooks';
import { InvPage, NotReadyOr, StatusBadge, Wt } from './ui';
import { MANUAL_STATUSES, PIECE_STATUSES, type ListTagsParams, type Tag, type TagHistoryEntry, type TagPhoto, type TagStatus } from './types';

/** Contract 0.8.0: ≤ 10 photos per piece (upload purpose tag_photo, JPEG/PNG/WebP ≤ 5 MB). */
export const MAX_TAG_PHOTOS = 10;

/**
 * Status filter → `status` query (0.8.5): with no status the server lists only non-terminal pieces (in stock, reserved,
 * on approval, repair, melting, in transit). "Active" sends nothing; "Any status" sends every status explicitly so sold /
 * melted / returned / written-off pieces show too; a single status is sent as-is.
 */
export type StockStatusFilter = TagStatus | '' | 'active';
export const tagStatusParam = (f: StockStatusFilter): TagStatus[] | undefined => (f === 'active' ? undefined : f === '' ? [...PIECE_STATUSES] : [f]);

/** 1 — Stock list: search by tag / HUID / design code (prefix), filter by status, item, counter. Keyset "load more". */
export function StockListPage() {
  const t = useT();
  const tk = useTk();
  const signedIn = useSignedIn();
  const refs = useInvRefs();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StockStatusFilter>('in_stock');
  const [f, setF] = useState<Pick<ListTagsParams, 'item_id' | 'counter_id'>>({});
  const [picked, setPicked] = useState<string[]>([]);
  const params: ListTagsParams = { ...f, status: tagStatusParam(status), q: q.trim() || undefined };
  const list = useInfiniteQuery({
    queryKey: inventoryKeys.tags(params),
    queryFn: ({ pageParam }) => inventoryApi.tags({ ...params, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (p) => p.next_cursor ?? undefined,
    enabled: signedIn, retry: false,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const multiPiece = rows.some((r) => pcsCell(r.pieces) !== '');
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const columns: Array<ColumnDef<Tag>> = [
    { id: 'pick', header: '', cell: (c) => <input type="checkbox" className="h-4 w-4 accent-primary" aria-label={t('inventory.pick', { tag: c.row.original.tag_no })} checked={picked.includes(c.row.original.id)} onChange={() => toggle(c.row.original.id)} /> },
    { header: t('inventory.tagNo'), cell: (c) => <Link to="/inventory/pieces/$id" params={{ id: c.row.original.id }} className="font-mono underline">{c.row.original.tag_no}</Link> },
    { header: t('inventory.item'), cell: (c) => <div><p>{refs.itemName(c.row.original.item_id)}</p><p lang="en" className="font-mono text-xs text-muted-foreground">{refs.purityCode(c.row.original.purity_id)}</p></div> },
    { header: t('inventory.grossWt'), cell: (c) => <Wt v={c.row.original.gross_wt} /> },
    { header: t('inventory.netWt'), cell: (c) => <Wt v={c.row.original.net_wt} /> },
    ...(multiPiece ? ([{ id: 'pcs', header: t('inventory.pcsShort'), cell: (c) => <span className="tabular-nums" data-testid="pcs">{pcsCell(c.row.original.pieces)}</span> }] as Array<ColumnDef<Tag>>) : []),
    { header: t('inventory.huid'), cell: (c) => <span lang="en" className="font-mono text-xs">{c.row.original.huid ?? '—'}</span> },
    { header: t('inventory.place'), cell: (c) => placeText(c.row.original, refs) },
    { header: t('common.status'), cell: (c) => <StatusBadge status={c.row.original.status} /> },
  ];
  return (
    <InvPage title="inventory.stock.title" description="inventory.stock.desc"
      actions={<>
        <Button asChild variant="outline"><Link to="/inventory/tag">{t('inventory.nav.tag')}</Link></Button>
        {picked.length
          ? <Button asChild><Link to="/inventory/labels" search={{ ids: picked.join(',') } as never}><Printer className="h-4 w-4" aria-hidden />{t('inventory.labels.printPicked', { n: picked.length })}</Link></Button>
          : <Button disabled><Printer className="h-4 w-4" aria-hidden />{t('inventory.labels.printPicked', { n: 0 })}</Button>}
      </>}>
      <StockSummaryStrip />
      <Card><CardContent className="grid gap-3 pt-4 md:grid-cols-5">
        <Field label={t('inventory.search')} hint={t('inventory.searchHint')} className="md:col-span-2">{(id, d) => (
          <div className="relative"><Search className="absolute left-2 top-3 h-4 w-4 text-muted-foreground" aria-hidden />
            <Input id={id} aria-describedby={d} className="pl-8" value={q} onChange={(e) => setQ(e.target.value)} /></div>)}</Field>
        <Field label={t('common.status')}>{(id) => (
          <Select id={id} value={status} onChange={(e) => setStatus(e.target.value as StockStatusFilter)}>
            <option value="active">{t('inventory.stock.active')}</option>
            <option value="">{t('inventory.stock.anyStatus')}</option>
            {PIECE_STATUSES.map((s) => <option key={s} value={s}>{tk(`inventory.status.${s}`)}</option>)}
          </Select>)}</Field>
        <Field label={t('inventory.item')}>{(id) => (
          <Select id={id} value={f.item_id ?? ''} onChange={(e) => setF({ ...f, item_id: e.target.value || undefined })}>
            <option value="">{t('inventory.any')}</option>
            {refs.items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </Select>)}</Field>
        <Field label={t('inventory.counter')}>{(id) => (
          <Select id={id} value={f.counter_id ?? ''} onChange={(e) => setF({ ...f, counter_id: e.target.value || undefined })}>
            <option value="">{t('inventory.any')}</option>
            {refs.counters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>)}</Field>
      </CardContent></Card>
      <NotReadyOr error={list.error} />
      {list.isLoading ? <Loading /> : <DataTable columns={columns} data={rows} caption={t('inventory.stock.title')} empty={t('inventory.stock.empty')} />}
      {list.hasNextPage ? <Button variant="outline" onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>{t('inventory.loadMore')}</Button> : null}
    </InvPage>
  );
}

/** 0.9.0: tags = rows on the stock list (tag_count), pieces = the sum of each tag's pieces (a pair of studs is 1 tag, 2 pieces). */
export function summaryCounts(t: { tag_count?: number | null; tag_pieces?: number | null } | null | undefined): { tags: number; pieces: number } {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  return { tags: n(t?.tag_count), pieces: n(t?.tag_pieces) };
}
/** Pieces cell on the stock list: shown only for multi-piece tags (pairs, sets). */
export const pcsCell = (pieces: number | null | undefined): string => (typeof pieces === 'number' && pieces > 1 ? String(pieces) : '');

/** Stock summary (0.8.3 GET /stock-summary, group_by status): in-stock totals across the branches the user can see. */
export function StockSummaryStrip({ branchId }: { branchId?: string }) {
  const t = useT();
  const tk = useTk();
  const signedIn = useSignedIn();
  const q = useQuery({ queryKey: inventoryKeys.summary(branchId, 'status'), queryFn: () => inventoryApi.summary(branchId, 'status'), enabled: signedIn, retry: false, staleTime: 60_000 });
  if (q.error) return <NotReadyOr error={q.error} />;
  const s = q.data;
  if (!s) return null;
  return (
    <Card data-testid="stock-summary"><CardContent className="flex flex-wrap items-center gap-x-6 gap-y-2 pt-4 text-sm">
      <p className="font-medium tabular-nums" data-testid="summary-tagged">{t('inventory.summary.tagged', summaryCounts(s.totals))} · <Wt v={s.totals.tag_net_wt} /></p>
      <p className="tabular-nums">{t('inventory.summary.loose')} <Wt v={s.totals.loose_net_wt} /></p>
      {s.totals.fine_wt ? <p className="tabular-nums">{t('inventory.summary.fine')} <Wt v={s.totals.fine_wt} /></p> : null}
      <ul className="flex flex-wrap gap-2" aria-label={t('inventory.summary.byStatus')}>
        {s.rows.filter((r) => r.status && r.tag_pieces > 0).map((r) => (
          <li key={r.status ?? ''}><Badge variant="outline">{`${tk(`inventory.status.${r.status ?? ''}`)} ${r.tag_pieces}`}</Badge></li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">{t('inventory.summary.asOf', { at: formatDateTimeIN(s.as_of) })}</p>
    </CardContent></Card>
  );
}

/** One history line: what happened, the document number, from → to place or status, who/when, the note. */
function HistoryItem({ h }: { h: TagHistoryEntry }) {
  const t = useT();
  const tk = useTk();
  const refs = useInvRefs();
  const place = (l?: TagHistoryEntry['from']) => (l ? [refs.branchName(l.branch_id), l.counter_id ? refs.counterName(l.counter_id) : null, l.tray_id ? refs.trayName(l.tray_id) : null].filter(Boolean).join(' · ') : null);
  const from = place(h.from); const to = place(h.to);
  return (
    <li className="border-l-2 border-border pl-3" data-testid="history-item">
      <p className="font-medium">{tk(`inventory.event.${h.kind}`)}{h.source_no ? <span lang="en" className="font-mono"> {h.source_no}</span> : null}</p>
      {from || to ? <p className="text-xs">{t('inventory.history.fromTo', { from: from ?? '—', to: to ?? '—' })}</p> : null}
      {h.status_before || h.status_after ? <p className="text-xs">{t('inventory.history.fromTo', { from: h.status_before ? tk(`inventory.status.${h.status_before}`) : '—', to: h.status_after ? tk(`inventory.status.${h.status_after}`) : '—' })}</p> : null}
      <p className="text-xs text-muted-foreground">{formatDateTimeIN(h.at)}</p>
      {h.note ? <p className="text-xs">{h.note}</p> : null}
    </li>
  );
}

/** Counter, plus the tray when the piece has one (0.8.7 returns tray_id); "—" when neither is set. */
export function placeText(p: { counter_id?: string | null; tray_id?: string | null }, refs: { counterName: (id?: string | null) => string; trayName: (id?: string | null) => string }): string {
  const parts = [p.counter_id ? refs.counterName(p.counter_id) : null, p.tray_id ? refs.trayName(p.tray_id) : null].filter(Boolean);
  return parts.length ? parts.join(' · ') : '—';
}

/** 0.8.9: label_printed_at is always sent (null = never printed): en-IN date-time IST, else "Not printed yet". */
export function labelPrintedText(at: string | null | undefined, t: (k: MessageKey) => string): string {
  if (!at || Number.isNaN(new Date(at).getTime())) return t('inventory.notPrintedYet');
  return formatDateTimeIN(at);
}

const MC_TYPES = ['per_gram', 'per_piece', 'flat', 'percent'] as const;
/** A decimal string to format, or null when the value is absent / not a number. */
const asDecimal = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : null);
/**
 * Making charge in plain words (live fix 9 Nov 2026): "₹350.00 a gram", "₹500.00 a piece", "₹1,200.00 fixed",
 * "12.00% of metal value"; the type alone when there's no amount; "—" when the piece has neither (the live API leaves
 * both out for pieces without a making charge). Never prints "undefined".
 */
export function makingChargeText(type: unknown, value: unknown, t: (k: MessageKey, p?: Record<string, string | number>) => string): string {
  const kind = MC_TYPES.find((k) => k === type);
  const v = asDecimal(value);
  if (!kind) return v ? formatINR(v) : '—';
  if (!v) return t(`inventory.mc.${kind}` as MessageKey);
  return t(`inventory.mc.show.${kind}` as MessageKey, { amount: kind === 'percent' ? formatPercent(v) : formatINR(v) });
}

/** 1b — Piece detail: weights, making, place, status change, photos (when switched on), history (GET /tags/{id}/history). */
export function PieceDetailPage() {
  const t = useT();
  const { id } = useParams({ strict: false }) as { id: string };
  const signedIn = useSignedIn();
  const refs = useInvRefs();
  const settings = useInventorySettings();
  const piece = useQuery({ queryKey: inventoryKeys.tag(id), queryFn: () => inventoryApi.tag(id), enabled: signedIn && !!id, retry: false });
  const history = useInfiniteQuery({
    queryKey: inventoryKeys.history(id),
    queryFn: ({ pageParam }) => inventoryApi.history(id, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (pg) => pg.next_cursor ?? undefined,
    enabled: signedIn && !!id, retry: false,
  });
  const events = history.data?.pages.flatMap((pg) => pg.items) ?? [];
  const p = piece.data;
  const row = (k: Parameters<typeof t>[0], v: ReactNode) => <div className="flex justify-between gap-3 border-b border-border py-1.5 text-sm"><dt className="text-muted-foreground">{t(k)}</dt><dd className="text-right">{v}</dd></div>;
  return (
    <InvPage title="inventory.piece.title" actions={p ? <Button asChild variant="outline"><Link to="/inventory/labels" search={{ ids: p.id } as never}><Printer className="h-4 w-4" aria-hidden />{t('inventory.labels.printOne')}</Link></Button> : undefined}>
      <NotReadyOr error={piece.error} />
      {piece.isLoading ? <Loading /> : null}
      {p ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader><CardTitle><span lang="en" className="font-mono">{p.tag_no}</span> <StatusBadge status={p.status} /></CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <dl>
                {row('inventory.item', `${refs.itemName(p.item_id)} · ${refs.purityCode(p.purity_id)}`)}
                {row('inventory.pcs', p.pieces)}
                {row('inventory.grossWt', <Wt v={p.gross_wt} />)}
                {row('inventory.stoneWt', <Wt v={p.stone_wt} />)}
                {row('inventory.netWt', <Wt v={p.net_wt} />)}
                {row('inventory.huid', <span lang="en" className="font-mono">{p.huid ?? '—'}</span>)}
                {row('inventory.making', makingChargeText(p.mc_type, p.mc_value, t))}
                {row('inventory.wastage', asDecimal(p.wastage_pct) ? formatPercent(asDecimal(p.wastage_pct) ?? '0') : '—')}
                {row('inventory.branch', refs.branchName(p.branch_id))}
                {row('inventory.place', placeText(p, refs))}
                {row('inventory.taggedOn', p.tagged_at ? formatDateIN(p.tagged_at) : '—')}
                {row('inventory.labelsPrinted', p.label_print_count ?? 0)}
                {row('inventory.labelPrintedAt', <span data-testid="label-printed-at">{labelPrintedText(p.label_printed_at, t)}</span>)}
                {row('inventory.vendorLotRef', <span lang="en" className="font-mono">{p.vendor_lot_ref ?? '—'}</span>)}
              </dl>
              <VendorLotRefEdit tag={p} />
              <StatusChange tag={p} />
            </CardContent>
          </Card>
          <div className="space-y-4">
            {settings.data?.photos_enabled === false ? null : <PiecePhotos tagId={p.id} />}
            <Card>
              <CardHeader><CardTitle>{t('inventory.piece.history')}</CardTitle></CardHeader>
              <CardContent>
                <NotReadyOr error={history.error} />
                {history.isSuccess && !events.length ? <p className="text-sm text-muted-foreground">{t('inventory.history.empty')}</p> : null}
                <ol className="space-y-2 text-sm">
                  {events.map((h, i) => <HistoryItem key={`${h.at}-${i}`} h={h} />)}
                </ol>
                {history.hasNextPage ? <Button size="sm" variant="outline" className="mt-2" onClick={() => void history.fetchNextPage()} disabled={history.isFetchingNextPage}>{t('inventory.loadMore')}</Button> : null}
              </CardContent>
            </Card>
          </div>
        </div>
      ) : null}
    </InvPage>
  );
}

/** Supplier lot / packet reference (0.8.3 tag.vendor_lot_ref, 1–60 characters; empty clears it). PATCH with If-Match. */
function VendorLotRefEdit({ tag }: { tag: Tag }) {
  const t = useT();
  const qc = useQueryClient();
  const online = useOnline();
  const can = useInvCan();
  const [v, setV] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => inventoryApi.updateTag(tag, { vendor_lot_ref: vendorLotRef(v ?? '') ?? null }),
    onSuccess: (d) => { qc.setQueryData(inventoryKeys.tag(tag.id), d); setV(null); void qc.invalidateQueries({ queryKey: inventoryKeys.history(tag.id) }); },
  });
  if (!can(INV.tagEdit)) return null;
  if (v === null) return <Button size="sm" variant="ghost" onClick={() => setV(tag.vendor_lot_ref ?? '')}>{t('inventory.vendorLotRefEdit')}</Button>;
  const bad = vendorLotRef(v) === null;
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-end gap-2">
        <Field label={t('inventory.vendorLotRef')} hint={t('inventory.vendorLotRefHint', { n: VENDOR_LOT_REF_MAX })} error={bad ? t('inventory.vendorLotRefLong', { n: VENDOR_LOT_REF_MAX }) : null}>{(id, h) => <Input id={id} aria-describedby={h} lang="en" value={v} onChange={(e) => setV(e.target.value)} />}</Field>
        <Button variant="outline" disabled={!online || bad || save.isPending} onClick={() => save.mutate()}>{t('common.save')}</Button>
        <Button variant="ghost" onClick={() => setV(null)}>{t('common.cancel')}</Button>
      </div>
      {hasFieldCode(save.error, 'vendor_lot_ref', 'field_not_supported') ? <p role="alert" className="text-sm text-destructive">{t('inventory.vendorLotRefOff')}</p> : <ErrorText error={save.error} />}
    </div>
  );
}

/**
 * Manual status change (in_stock ↔ reserved / repair / melting); other statuses come from sales, transfers, refinery.
 * 0.8.2: reason required (trimmed ≥ 3) and If-Match from the piece's version; written_off is final (approved full_write_off).
 */
function StatusChange({ tag }: { tag: Tag }) {
  const t = useT();
  const tk = useTk();
  const qc = useQueryClient();
  const online = useOnline();
  const options = MANUAL_STATUSES.filter((s) => s !== tag.status && (tag.status === 'in_stock' || s === 'in_stock'));
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');
  const change = useMutation({
    mutationFn: () => inventoryApi.changeStatus(tag, to as (typeof MANUAL_STATUSES)[number], reason),
    onSuccess: (d) => { qc.setQueryData(inventoryKeys.tag(tag.id), d); setTo(''); setReason(''); void qc.invalidateQueries({ queryKey: inventoryKeys.history(tag.id) }); },
  });
  if (!(MANUAL_STATUSES as readonly string[]).includes(tag.status) || !options.length) return null;
  return (
    <EditGate perm={invPerm(INV.tagStatusChange)}>
      <div className="flex flex-wrap items-end gap-2">
        <Field label={t('inventory.piece.changeStatus')}>{(id) => (
          <Select id={id} value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">{t('common.choose')}</option>
            {options.map((s) => <option key={s} value={s}>{tk(`inventory.status.${s}`)}</option>)}
          </Select>)}</Field>
        <Field label={t('inventory.reason')} hint={t('inventory.minText', { n: MIN_TEXT })}>{(id, h) => <Input id={id} aria-describedby={h} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
        <Button variant="outline" disabled={!online || !to || !textOk(reason) || change.isPending} onClick={() => change.mutate()}>{t('common.save')}</Button>
      </div>
      <ErrorText error={change.error} />
    </EditGate>
  );
}

/**
 * Optional photos: upload purpose tag_photo (JPEG/PNG/WebP, ≤ 5 MB, ≤ 10 per piece). 409 feature_disabled when switched off.
 * 0.8.3: the list comes from GET /tags/{id}/photos (primary first, then sort_order) with no url — each thumbnail asks
 * GET /v1/files/{file_id}/url (short-lived). "Make main photo" PATCHes is_primary with If-Match.
 */
function PiecePhotos({ tagId }: { tagId: string }) {
  const t = useT();
  const qc = useQueryClient();
  const online = useOnline();
  const signedIn = useSignedIn();
  const input = useRef<HTMLInputElement>(null);
  const key = useAttemptKey();
  const [err, setErr] = useState<string | null>(null);
  const list = useQuery({ queryKey: inventoryKeys.photos(tagId), queryFn: () => inventoryApi.photos(tagId), enabled: signedIn, retry: false });
  const photos = list.data ?? [];
  const refresh = () => { void qc.invalidateQueries({ queryKey: inventoryKeys.photos(tagId) }); void qc.invalidateQueries({ queryKey: inventoryKeys.tag(tagId), exact: true }); };
  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      let n = photos.length;
      for (const f of files) {
        const file = await mastersApi.uploadFile(f, 'tag_photo');
        await inventoryApi.addPhoto(tagId, { file_id: file.id, is_primary: n === 0, sort_order: n }, `${key.take()}-${n}`);
        n += 1;
      }
    },
    onSuccess: () => key.reset(), onError: (e) => key.settle(e), onSettled: refresh,
  });
  const remove = useMutation({ mutationFn: (ph: TagPhoto) => inventoryApi.removePhoto(tagId, ph), onSettled: refresh });
  const primary = useMutation({ mutationFn: (ph: TagPhoto) => inventoryApi.updatePhoto(tagId, ph, { is_primary: true }), onSettled: refresh });
  const pick = (fl: FileList | null) => {
    const files = Array.from(fl ?? []);
    const e = checkPhotos(photos.length, files, MAX_TAG_PHOTOS);
    setErr(e ? t(e, { max: MAX_TAG_PHOTOS }) : null);
    if (!e && files.length) upload.mutate(files);
    if (input.current) input.current.value = '';
  };
  return (
    <Card>
      <CardHeader><CardTitle>{t('inventory.piece.photos')}</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">{t('inventory.piece.photosHint', { max: MAX_TAG_PHOTOS })}</p>
        <NotReadyOr error={list.error} />
        <ul className="grid grid-cols-3 gap-2" data-testid="piece-photos">
          {photos.map((ph, i) => (
            <li key={ph.id} className="space-y-1 rounded-md border border-border p-1">
              <PhotoThumb fileId={ph.file_id} alt={ph.caption || t('masters.photoN', { n: i + 1 })} className="aspect-square w-full rounded object-cover" />
              <div className="flex items-center gap-1">
                {ph.is_primary ? <Badge variant="success">{t('inventory.photo.primary')}</Badge> : null}
                <EditGate perm={invPerm(INV.tagPhotos)}>
                  {ph.is_primary ? null : <Button type="button" size="icon" variant="ghost" aria-label={`${t('inventory.photo.makePrimary')} ${t('masters.photoN', { n: i + 1 })}`} disabled={!online || primary.isPending} onClick={() => primary.mutate(ph)}><Star className="h-4 w-4" /></Button>}
                  <Button type="button" size="icon" variant="ghost" aria-label={`${t('common.remove')} ${t('masters.photoN', { n: i + 1 })}`} disabled={!online || remove.isPending} onClick={() => remove.mutate(ph)}><Trash2 className="h-4 w-4" /></Button>
                </EditGate>
              </div>
            </li>
          ))}
        </ul>
        <EditGate perm={invPerm(INV.tagPhotos)}>
          <input ref={input} type="file" accept={PHOTO_TYPES.join(',')} multiple className="sr-only" aria-label={t('masters.addPhotos')} onChange={(e) => pick(e.target.files)} />
          <Button type="button" variant="outline" disabled={!online || upload.isPending || photos.length >= MAX_TAG_PHOTOS} onClick={() => input.current?.click()}><ImagePlus className="h-4 w-4" aria-hidden />{t(upload.isPending ? 'masters.uploading' : 'masters.addPhotos')}</Button>
          {err ? <p role="alert" className="text-sm text-destructive">{err}</p> : null}
          {/* 0.8.4: a second attach of the same photo is 409 already_attached → error.already_attached via ErrorText. */}
          <ErrorText error={upload.error ?? remove.error ?? primary.error} />
        </EditGate>
      </CardContent>
    </Card>
  );
}
