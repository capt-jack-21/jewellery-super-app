import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field, Select } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useT, useTk } from '@/i18n';
import { uuid } from '@/lib/uuid';
import { emptyLoose, looseIssues, looseToDraft, type DraftLooseLine, type LooseForm } from './logic';

type Opt = { id: string; name: string; code?: string | null };
type Refs = {
  items: ReadonlyArray<Opt>; purities: ReadonlyArray<{ id: string; code: string }>;
  counters: ReadonlyArray<Opt & { branch_id: string }>; trays: ReadonlyArray<{ id: string; counter_id: string; code: string; name?: string | null }>;
};

/**
 * Untagged (loose) piece on a bill or estimate (SaleLooseLineInput): item, purity, weights in grams, pieces, and the counter / tray it
 * comes from. The server prices it like a tag line and takes it out of loose stock — 409 insufficient_loose_stock when there isn't enough.
 */
export function LooseEntry({ refs, branchId, onAdd, onClose }: { refs: Refs; branchId: string; onAdd: (l: DraftLooseLine) => void; onClose: () => void }) {
  const t = useT();
  const tk = useTk();
  const [f, setF] = useState<LooseForm>(emptyLoose);
  const [tried, setTried] = useState(false);
  const issues = looseIssues(f);
  const set = (k: keyof LooseForm) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value, ...(k === 'counter_id' ? { tray_id: '' } : {}) }));
  const counters = refs.counters.filter((c) => !branchId || c.branch_id === branchId);
  const trays = refs.trays.filter((x) => x.counter_id === f.counter_id);
  const add = () => {
    setTried(true);
    const l = looseToDraft(f, uuid());
    if (!l) return;
    onAdd(l);
    setF(emptyLoose());
    setTried(false);
  };
  return (
    <fieldset className="space-y-2 rounded-md border border-border p-3" data-testid="loose-entry">
      <legend className="px-1 font-semibold">{t('sales.loose.title')}</legend>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Field label={t('sales.loose.item')} className="col-span-2">{(id) => (
          <Select id={id} value={f.item_id} onChange={set('item_id')}><option value="">{t('sales.loose.pickItem')}</option>{refs.items.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>)}</Field>
        <Field label={t('sales.oldGold.purity')}>{(id) => (
          <Select id={id} value={f.purity_id} onChange={set('purity_id')}><option value="">{t('sales.oldGold.pickPurity')}</option>{refs.purities.map((x) => <option key={x.id} value={x.id}>{x.code}</option>)}</Select>)}</Field>
        <Field label={t('sales.loose.pieces')}>{(id) => <Input id={id} inputMode="numeric" className="font-mono" value={f.pieces} onChange={set('pieces')} />}</Field>
        <Field label={t('sales.loose.gross')}>{(id) => <Input id={id} inputMode="decimal" className="font-mono" value={f.gross_wt} onChange={set('gross_wt')} />}</Field>
        <Field label={t('sales.loose.stone')}>{(id) => <Input id={id} inputMode="decimal" className="font-mono" value={f.stone_wt} onChange={set('stone_wt')} />}</Field>
        <Field label={t('sales.loose.net')} hint={t('sales.loose.netHint')} className="col-span-2 md:col-span-1">{(id, d) => <Input id={id} aria-describedby={d} inputMode="decimal" className="font-mono" value={f.net_wt} onChange={set('net_wt')} />}</Field>
        <Field label={t('sales.loose.what')} className="col-span-2 md:col-span-1">{(id) => <Input id={id} maxLength={200} value={f.description} onChange={set('description')} />}</Field>
        <Field label={t('sales.loose.counter')}>{(id) => (
          <Select id={id} value={f.counter_id} onChange={set('counter_id')}><option value="">{t('sales.loose.anyCounter')}</option>{counters.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>)}</Field>
        <Field label={t('sales.loose.tray')}>{(id) => (
          <Select id={id} value={f.tray_id} disabled={!f.counter_id} onChange={set('tray_id')}><option value="">{t('sales.loose.anyTray')}</option>{trays.map((x) => <option key={x.id} value={x.id}>{x.name || x.code}</option>)}</Select>)}</Field>
      </div>
      {tried && issues.length ? <ul className="space-y-0.5 text-sm text-destructive" role="alert" data-testid="loose-issues">{issues.map((i) => <li key={i}>{tk(`sales.loose.issue.${i}`)}</li>)}</ul> : null}
      <div className="flex gap-2">
        <Button type="button" data-testid="loose-add" onClick={add}><Plus className="h-4 w-4" aria-hidden />{t('sales.loose.add')}</Button>
        <Button type="button" variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
      </div>
    </fieldset>
  );
}
