import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearch } from '@tanstack/react-router';
import { Plus, Printer, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Select } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { EditGate, ErrorText, Loading } from '@/components/page';
import { useT, useTk } from '@/i18n';
import { ApiError } from '@/lib/api/fetcher';
import { useAttemptKey } from '@/lib/api/attempt-key';
import { formatWeight, parseDecimalInput } from '@/lib/format';
import { INV, invPerm } from '@/lib/permissions';
import { useOnline } from '@/lib/offline/connectivity';
import { useSignedIn } from '@/lib/session';
import { McType, type Lot, type LotLine } from '@/lib/api/backend/model';
import { hasFieldCode, inventoryApi, inventoryKeys, MAX_IDS } from './api';
import { lineRemaining, VENDOR_LOT_REF_MAX, vendorLotRef } from './lots';
import { useInvRefs } from './hooks';
import { blankDraft, draftError, draftToRow, netWeight, parseWeight, rowErrors, type PieceDraft } from './piece-rules';
import { BranchPicker, InvPage, NotReadyOr, Wt } from './ui';
import type { BulkTagInputCommon, Tag } from './types';

const MC_TYPES = Object.values(McType);
interface Common { branch: string; item: string; purity: string; mcType: McType; mcValue: string; wastage: string; counter: string; tray: string; vendorRef: string }
/** Tagging from a lot line (0.8.3 source 'lot'): branch, item and purity come from the lot and can't be changed. */
interface FromLot { lot: Lot; line: LotLine }

/**
 * 2 — Tag pieces (0.8.0): the shared details (branch, item, purity, making, place) once, then one row per piece.
 * One piece → POST /tags; several → POST /tags/bulk (≤ 200, all-or-nothing). The server assigns tag numbers.
 * 0.8.3: opened as /inventory/tag?lot=…&line=… (from a lot) it sends source 'lot' + lot_line_id; the optional supplier
 * lot reference goes on every piece created (vendor_lot_ref, 1–60 characters).
 */
export function TaggingPage() {
  const t = useT();
  const signedIn = useSignedIn();
  const search: { lot?: string; line?: string } = useSearch({ strict: false });
  const [mode, setMode] = useState<'one' | 'bulk'>('one');
  const lot = useQuery({ queryKey: inventoryKeys.lot(search.lot ?? ''), queryFn: () => inventoryApi.lot(search.lot ?? ''), enabled: signedIn && !!search.lot, retry: false });
  const line = lot.data?.lines?.find((l) => l.id === search.line);
  const from: FromLot | undefined = lot.data && line ? { lot: lot.data, line } : undefined;
  const waiting = !!search.lot && !from;
  return (
    <InvPage title="inventory.tag.title" description="inventory.tag.desc">
      <div role="tablist" className="flex gap-2">
        <Button role="tab" aria-selected={mode === 'one'} variant={mode === 'one' ? 'default' : 'outline'} onClick={() => setMode('one')}>{t('inventory.tag.one')}</Button>
        <Button role="tab" aria-selected={mode === 'bulk'} variant={mode === 'bulk' ? 'default' : 'outline'} onClick={() => setMode('bulk')}>{t('inventory.tag.bulk')}</Button>
      </div>
      {from ? <LotBanner from={from} /> : null}
      {waiting ? (lot.error ? <NotReadyOr error={lot.error} /> : lot.isLoading ? <Loading /> : <p role="alert" className="text-sm text-destructive">{t('inventory.lots.lineGone')}</p>) : null}
      {waiting ? null : <EditGate perm={invPerm(INV.tagCreate)}><TagForm key={`${mode}-${from?.line.id ?? ''}`} bulk={mode === 'bulk'} from={from} /></EditGate>}
    </InvPage>
  );
}

function LotBanner({ from }: { from: FromLot }) {
  const t = useT();
  const refs = useInvRefs();
  const left = lineRemaining(from.line);
  const gross = from.line.remaining_gross_wt;
  return (
    <div role="status" className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-muted p-3 text-sm" data-testid="lot-banner">
      <span>{t('inventory.lots.tagging', { lot: from.lot.lot_no, item: refs.itemName(from.line.item_id) })}</span>
      <span className="tabular-nums">{t('inventory.lots.left', { n: left })}{gross ? <> · <Wt v={gross} /></> : null}</span>
      <Button asChild size="sm" variant="ghost"><Link to="/inventory/lots" search={{ id: from.lot.id } as never}>{t('inventory.lots.back')}</Link></Button>
    </div>
  );
}

function Created({ pieces }: { pieces: Array<Pick<Tag, 'id' | 'tag_no'>> }) {
  const t = useT();
  if (!pieces.length) return null;
  const tags = pieces.length > 3 ? `${pieces[0]?.tag_no ?? ''} … ${pieces.at(-1)?.tag_no ?? ''}` : pieces.map((p) => p.tag_no).join(', ');
  return (
    <div role="status" className="space-y-2 rounded-md border border-success bg-success/10 p-3 text-sm">
      <p>{t('inventory.tag.created', { n: pieces.length })} <span lang="en" className="font-mono">{tags}</span></p>
      <Button asChild size="sm" variant="outline"><Link to="/inventory/labels" search={{ ids: pieces.map((p) => p.id).join(',') } as never}><Printer className="h-4 w-4" aria-hidden />{t('inventory.labels.printNow')}</Link></Button>
    </div>
  );
}

function TagForm({ bulk, from }: { bulk: boolean; from?: FromLot }) {
  const t = useT();
  const tk = useTk();
  const qc = useQueryClient();
  const online = useOnline();
  const refs = useInvRefs();
  const key = useAttemptKey();
  const blankRows = () => (bulk ? [blankDraft(), blankDraft(), blankDraft()] : [blankDraft()]);
  const [c, setC] = useState<Common>(() => {
    const it = from ? refs.item(from.line.item_id) : undefined;
    return {
      branch: from?.lot.branch_id ?? '', item: from?.line.item_id ?? '', purity: from?.line.purity_id ?? it?.purity_id ?? '',
      mcType: it?.mc_type ?? 'per_gram', mcValue: it?.mc_value ?? '', wastage: it?.wastage_type === 'percent' ? it.wastage_value : '', counter: '', tray: '', vendorRef: '',
    };
  });
  const locked = !!from;
  const ref = vendorLotRef(c.vendorRef);
  const [rows, setRows] = useState<PieceDraft[]>(blankRows);
  const [done, setDone] = useState<Array<Pick<Tag, 'id' | 'tag_no'>>>([]);
  const branch = c.branch || refs.branches[0]?.id || '';
  const purity = refs.purities.find((p) => p.id === c.purity);
  const upd = (p: Partial<Common>) => { setC({ ...c, ...p }); key.reset(); };
  const pickItem = (id: string) => {
    const it = refs.item(id);
    upd({ item: id, purity: it?.purity_id ?? c.purity, ...(it ? { mcType: it.mc_type, mcValue: it.mc_value, wastage: it.wastage_type === 'percent' ? it.wastage_value : c.wastage } : {}) });
  };
  const withCommon = (r: PieceDraft): PieceDraft => ({ ...r, item_id: c.item, purity_id: c.purity });
  const filled = rows.filter((r) => r.gross_wt.trim() || r.huid.trim());
  const errs = rows.map((r) => (r.gross_wt.trim() || r.huid.trim() || !bulk ? draftError(withCommon(r), !!purity?.huid_required) : null));
  const common = (): BulkTagInputCommon => ({
    branch_id: branch, item_id: c.item, purity_id: c.purity, mc_type: c.mcType,
    mc_value: parseDecimalInput(c.mcValue) ?? undefined, wastage_pct: parseDecimalInput(c.wastage) ?? undefined,
    counter_id: c.counter || null, tray_id: c.tray || null,
  });
  const origin = () => ({
    ...(from ? { source: 'lot' as const, lot_line_id: from.line.id } : { source: 'direct' as const }),
    ...(ref ? { vendor_lot_ref: ref } : {}),
  });
  const save = useMutation({
    mutationFn: async (): Promise<Array<Pick<Tag, 'id' | 'tag_no'>>> => {
      const body = filled.map((r) => draftToRow(withCommon(r)));
      if (body.length === 1 && body[0]) return [await inventoryApi.createTag({ ...common(), ...body[0], ...origin() }, key.take())];
      return (await inventoryApi.bulkCreate({ ...origin(), common: common(), rows: body }, key.take())).items;
    },
    onSuccess: (r) => { key.reset(); setDone(r); setRows(blankRows()); void qc.invalidateQueries({ queryKey: inventoryKeys.all }); if (from) void qc.invalidateQueries({ queryKey: inventoryKeys.lot(from.lot.id) }); },
    onError: (e) => key.settle(e),
  });
  const server = save.error instanceof ApiError ? rowErrors(save.error.errors) : {};
  const setRow = (i: number, p: Partial<PieceDraft>) => { key.reset(); setRows(rows.map((r, k) => (k === i ? { ...r, ...p } : r))); };
  const commonOk = !!branch && !!c.item && !!c.purity && ref !== null;
  return (
    <Card>
      <CardHeader><CardTitle>{t(bulk ? 'inventory.tag.bulk' : 'inventory.tag.one')}</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        {bulk ? <p className="text-sm text-muted-foreground">{t('inventory.tag.bulkHint')}</p> : null}
        <div className="grid gap-3 md:grid-cols-4">
          <Field label={t('inventory.branch')}>{(id) => <BranchPicker id={id} disabled={locked} value={branch} onChange={(v) => upd({ branch: v, counter: '', tray: '' })} branches={refs.branches} />}</Field>
          <Field label={t('inventory.item')}>{(id) => (
            <Select id={id} value={c.item} disabled={locked} onChange={(e) => pickItem(e.target.value)}>
              <option value="" disabled>{t('common.choose')}</option>
              {refs.items.filter((i) => i.stock_type === 'tag').map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
            </Select>)}</Field>
          <Field label={t('inventory.purity')}>{(id) => (
            <Select id={id} value={c.purity} disabled={locked && !!from?.line.purity_id} onChange={(e) => upd({ purity: e.target.value })}>
              <option value="" disabled>{t('common.choose')}</option>
              {refs.purities.filter((p) => p.is_active).map((p) => <option key={p.id} value={p.id}>{p.code}</option>)}
            </Select>)}</Field>
          <Field label={t('inventory.making')}>{(id) => (
            <Select id={id} value={c.mcType} onChange={(e) => upd({ mcType: e.target.value as McType })}>
              {MC_TYPES.map((m) => <option key={m} value={m}>{tk(`inventory.mc.${m}`)}</option>)}
            </Select>)}</Field>
          <Field label={t('inventory.makingValue')}>{(id) => <Input id={id} inputMode="decimal" value={c.mcValue} onChange={(e) => upd({ mcValue: e.target.value })} />}</Field>
          <Field label={t('inventory.wastage')} hint={t('inventory.wastageHint')}>{(id, h) => <Input id={id} aria-describedby={h} inputMode="decimal" value={c.wastage} onChange={(e) => upd({ wastage: e.target.value })} />}</Field>
          <Field label={t('inventory.counter')}>{(id) => (
            <Select id={id} value={c.counter} onChange={(e) => upd({ counter: e.target.value, tray: '' })}>
              <option value="">{t('inventory.none')}</option>
              {refs.counters.filter((x) => !x.branch_id || x.branch_id === branch).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </Select>)}</Field>
          <Field label={t('inventory.tray')}>{(id) => (
            <Select id={id} value={c.tray} disabled={!c.counter} onChange={(e) => upd({ tray: e.target.value })}>
              <option value="">{t('inventory.none')}</option>
              {refs.trays.filter((x) => x.counter_id === c.counter).map((x) => <option key={x.id} value={x.id}>{x.name ?? x.code}</option>)}
            </Select>)}</Field>
          <Field label={t('inventory.vendorLotRef')} hint={t('inventory.vendorLotRefHint', { n: VENDOR_LOT_REF_MAX })} error={ref === null ? t('inventory.vendorLotRefLong', { n: VENDOR_LOT_REF_MAX }) : null}>{(id, h) => <Input id={id} aria-describedby={h} lang="en" value={c.vendorRef} onChange={(e) => upd({ vendorRef: e.target.value })} />}</Field>
        </div>
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted"><tr>
              {(['inventory.rowNo', 'inventory.pcs', 'inventory.grossWt', 'inventory.stoneWt', 'inventory.netWt', 'inventory.huid'] as const).map((k) => <th key={k} className="px-2 py-2 text-left font-medium">{t(k)}</th>)}
              <th className="px-2 py-2"><span className="sr-only">{t('common.remove')}</span></th>
            </tr></thead>
            <tbody className="divide-y divide-border">
              {rows.map((r, i) => {
                const e = commonOk ? errs[i] : null; const se = server[filled.indexOf(r)];
                const g = parseWeight(r.gross_wt); const s = r.stone_wt.trim() ? parseWeight(r.stone_wt, true) : '0.000';
                const net = g && s !== null ? netWeight(g, s) : null;
                return (
                  <tr key={i} data-testid="bulk-row" className={(r.gross_wt && e) || se ? 'bg-destructive/5' : undefined}>
                    <td className="px-2 py-1 tabular-nums">{i + 1}</td>
                    <td className="px-2 py-1"><Input aria-label={`${t('inventory.pcs')} ${i + 1}`} className="w-16" inputMode="numeric" value={r.pcs} onChange={(ev) => setRow(i, { pcs: ev.target.value })} /></td>
                    <td className="px-2 py-1"><Input aria-label={`${t('inventory.grossWt')} ${i + 1}`} className="w-28 tabular-nums" inputMode="decimal" value={r.gross_wt} onChange={(ev) => setRow(i, { gross_wt: ev.target.value })} /></td>
                    <td className="px-2 py-1"><Input aria-label={`${t('inventory.stoneWt')} ${i + 1}`} className="w-24 tabular-nums" inputMode="decimal" value={r.stone_wt} onChange={(ev) => setRow(i, { stone_wt: ev.target.value })} /></td>
                    <td className="px-2 py-1 tabular-nums" data-testid="net-wt">{net ? formatWeight(net) : '—'}</td>
                    <td className="px-2 py-1"><Input aria-label={`${t('inventory.huid')} ${i + 1}`} lang="en" className="w-24 font-mono uppercase" maxLength={6} value={r.huid} onChange={(ev) => setRow(i, { huid: ev.target.value.toUpperCase() })} />
                      {r.gross_wt && e ? <p className="text-xs text-destructive">{t(e)}</p> : se ? <p className="text-xs text-destructive">{se}</p> : null}</td>
                    <td className="px-2 py-1">{bulk ? <Button type="button" size="icon" variant="ghost" aria-label={`${t('common.remove')} ${i + 1}`} disabled={rows.length <= 1} onClick={() => { key.reset(); setRows(rows.filter((_, k) => k !== i)); }}><Trash2 className="h-4 w-4" /></Button> : null}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {purity?.huid_required ? <p className="text-xs text-muted-foreground">{t('inventory.huidRequiredHint')}</p> : null}
        <div className="flex flex-wrap gap-2">
          {bulk ? <Button type="button" variant="outline" disabled={rows.length >= MAX_IDS} onClick={() => { key.reset(); setRows([...rows, blankDraft()]); }}><Plus className="h-4 w-4" aria-hidden />{t('inventory.tag.addRow')}</Button> : null}
          <Button disabled={!online || !commonOk || !filled.length || errs.some(Boolean) || save.isPending} onClick={() => save.mutate()}>
            {bulk ? t('inventory.tag.saveAll', { n: filled.length }) : t('inventory.tag.save')}
          </Button>
        </div>
        {!commonOk ? <p className="text-xs text-muted-foreground">{t('inventory.tag.pickCommon')}</p> : null}
        {hasFieldCode(save.error, 'vendor_lot_ref', 'field_not_supported') ? <p role="alert" className="text-sm text-destructive">{t('inventory.vendorLotRefOff')}</p> : <ErrorText error={save.error} />}
        <Created pieces={done} />
      </CardContent>
    </Card>
  );
}
