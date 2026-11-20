import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ScanLine, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ErrorText } from '@/components/page';
import { useT } from '@/i18n';
import { D } from '@/lib/format';
import type { Tag } from '@/lib/api/backend/model';
import { inventoryApi } from './api';
import { normTag } from './piece-rules';
import { Wt } from './ui';

export type Picked = Pick<Tag, 'id' | 'tag_no' | 'net_wt' | 'gross_wt' | 'pieces' | 'status' | 'branch_id'>;

/** Scan or type tag numbers to build a list of pieces (0.8.0 GET /v1/inventory/tag-lookup/{tagNo}: tag_no, label payload, RFID EPC or HUID). Barcode scanners type + Enter. */
export function TagPicker({ picked, onChange, branchId, check }: {
  picked: Picked[]; onChange: (next: Picked[]) => void; branchId?: string;
  /** Extra rule (e.g. "must be in stock"); return an error message key-text or null. */
  check?: (p: Picked) => string | null;
}) {
  const t = useT();
  const [raw, setRaw] = useState('');
  const [warn, setWarn] = useState<string | null>(null);
  const look = useMutation({
    mutationFn: (tagNo: string) => inventoryApi.lookup(tagNo, branchId),
    onSuccess: (p) => {
      setRaw('');
      if (picked.some((x) => x.id === p.id)) { setWarn(t('inventory.scan.already', { tag: p.tag_no })); return; }
      const bad = check?.(p) ?? null;
      if (bad) { setWarn(bad); return; }
      setWarn(null);
      onChange([...picked, p]);
    },
  });
  const net = picked.reduce((n, p) => n.plus(D(p.net_wt)), D('0')).toFixed(3);
  return (
    <div className="space-y-2">
      <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); const v = normTag(raw); if (v) look.mutate(v); }}>
        <Field label={t('inventory.scan.label')} hint={t('inventory.scanHint')} className="flex-1">{(id, h) => <Input id={id} aria-describedby={h} lang="en" autoComplete="off" className="font-mono uppercase" value={raw} onChange={(e) => setRaw(e.target.value)} />}</Field>
        <Button type="submit" variant="outline" disabled={!raw.trim() || look.isPending}><ScanLine className="h-4 w-4" aria-hidden />{t('inventory.add')}</Button>
      </form>
      {warn ? <p role="alert" className="rounded-md border border-warning bg-warning/15 p-2 text-sm">{warn}</p> : null}
      <ErrorText error={look.error} />
      {picked.length ? (
        <ul className="divide-y divide-border rounded-md border border-border text-sm" aria-label={t('inventory.scan.picked')}>
          {picked.map((p) => (
            <li key={p.id} className="flex items-center justify-between px-3 py-1">
              <span lang="en" className="font-mono">{p.tag_no}</span><Wt v={p.net_wt} />
              <Button type="button" size="icon" variant="ghost" aria-label={`${t('common.remove')} ${p.tag_no}`} onClick={() => onChange(picked.filter((x) => x.id !== p.id))}><X className="h-4 w-4" /></Button>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="text-sm tabular-nums">{t('inventory.scan.total', { n: picked.length })} · <Wt v={net} /></p>
    </div>
  );
}
