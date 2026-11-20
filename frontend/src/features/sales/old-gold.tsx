import type { Ref } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field, Select } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n';
import { uuid } from '@/lib/uuid';
import type { PricedOldGold } from '@/lib/api/backend/model';
import { rateOverrideState, toOldGoldInput, type DraftOldGold } from './logic';
import { OldGoldRow } from './totals';

export const newOldGold = (purityId = ''): DraftOldGold => ({ key: uuid(), purity_id: purityId, gross_wt: '' });

/**
 * Old gold taken in exchange (OldGoldInput): purity, gross and less weight (g), touch % (optional), what it is.
 * The server prices it at today's buy rate (settings: valuation basis); 0.9.1 lets a user with sales.old_gold.rate_override type a
 * different ₹/g WITH a reason (5–200) — both or neither. Priced rows from the preview show under each input row.
 */
export function OldGoldEditor({ rows, onChange, purities, priced, canOverride, firstRef }: {
  rows: DraftOldGold[]; onChange: (r: DraftOldGold[]) => void; purities: ReadonlyArray<{ id: string; code: string }>; priced: readonly PricedOldGold[];
  canOverride: boolean; firstRef?: Ref<HTMLSelectElement>;
}) {
  const t = useT();
  const set = (i: number, p: Partial<DraftOldGold>) => onChange(rows.map((x, k) => (k === i ? { ...x, ...p } : x)));
  return (
    <fieldset className="space-y-2" data-testid="old-gold">
      <legend className="mb-1 font-semibold">{t('sales.oldGold.title')}</legend>
      {rows.map((o, i) => {
        const ov = rateOverrideState(o);
        // Only complete rows are sent, so priced rows line up with the complete inputs in order.
        const p = toOldGoldInput(o) ? priced[rows.slice(0, i).filter((x) => toOldGoldInput(x)).length] : undefined;
        return (
          <div key={o.key} className="grid grid-cols-2 gap-2 rounded-md border border-border p-2 md:grid-cols-5" data-testid="old-gold-input">
            <Field label={t('sales.oldGold.purity')}>{(id) => (
              <Select ref={i === 0 ? firstRef : undefined} id={id} value={o.purity_id} onChange={(e) => set(i, { purity_id: e.target.value })}>
                <option value="">{t('sales.oldGold.pickPurity')}</option>
                {purities.map((x) => <option key={x.id} value={x.id}>{x.code}</option>)}
              </Select>)}</Field>
            <Field label={t('sales.oldGold.gross')}>{(id) => <Input id={id} inputMode="decimal" className="font-mono" value={o.gross_wt} onChange={(e) => set(i, { gross_wt: e.target.value })} />}</Field>
            <Field label={t('sales.oldGold.less')}>{(id) => <Input id={id} inputMode="decimal" className="font-mono" value={o.less_wt ?? ''} onChange={(e) => set(i, { less_wt: e.target.value })} />}</Field>
            <Field label={t('sales.oldGold.touch')}>{(id) => <Input id={id} inputMode="decimal" className="font-mono" value={o.touch_pct ?? ''} onChange={(e) => set(i, { touch_pct: e.target.value })} />}</Field>
            <Field label={t('sales.oldGold.what')}>{(id) => <Input id={id} maxLength={200} value={o.description ?? ''} onChange={(e) => set(i, { description: e.target.value })} />}</Field>
            {canOverride ? (
              <>
                <Field label={t('sales.oldGold.rateOverride')} hint={t('sales.oldGold.rateOverrideHint')}>{(id, d) => (
                  <Input id={id} aria-describedby={d} inputMode="decimal" className="font-mono" value={o.rate_override ?? ''} onChange={(e) => set(i, { rate_override: e.target.value })} />)}</Field>
                <Field label={t('sales.oldGold.overrideReason')} className="col-span-2 md:col-span-3" error={ov === 'incomplete' ? t('sales.oldGold.overridePair') : null}>{(id, d) => (
                  <Input id={id} aria-describedby={d} maxLength={200} value={o.override_reason ?? ''} onChange={(e) => set(i, { override_reason: e.target.value })} />)}</Field>
              </>
            ) : null}
            <div className="flex items-end justify-end"><Button type="button" variant="ghost" size="icon" aria-label={t('common.remove')} onClick={() => onChange(rows.filter((_, k) => k !== i))}><Trash2 className="h-4 w-4" /></Button></div>
            {p ? <div className="col-span-2 md:col-span-5"><OldGoldRow o={p} /></div> : null}
          </div>
        );
      })}
      {!canOverride && rows.length ? <p className="text-xs text-muted-foreground">{t('sales.oldGold.noOverride')}</p> : null}
      <Button type="button" variant="outline" size="sm" onClick={() => onChange([...rows, newOldGold(rows[rows.length - 1]?.purity_id ?? '')])}><Plus className="h-4 w-4" aria-hidden />{t('sales.oldGold.add')}</Button>
    </fieldset>
  );
}
