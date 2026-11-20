import { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useCan } from '@/lib/session';
import type { ColumnDef } from '@tanstack/react-table';
import { ShieldCheck, ShieldX } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { DataTable } from '@/components/ui/data-table';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/page';
import { useT, useTk } from '@/i18n';
import { ok } from '@/lib/api/fetcher';
import { getListAuditEventsQueryKey, getVerifyAuditChainQueryKey, listAuditEvents, verifyAuditChain } from '@/lib/api/backend/audit/audit';
import type { AuditEvent } from '@/lib/api/backend/model';
import { formatDateTimeIN } from '@/lib/format';

/** P20 audit log viewer (read-only, append-only hash-chained server log). */
export function AuditPage() {
  const t = useT();
  const tk = useTk();
  const [f, setF] = useState({ q: '', from: '', to: '' });
  // Contract filters: action/table/user/row + date range; the free-text box filters by action prefix.
  const params = { action: f.q || undefined, from: f.from || undefined, to: f.to || undefined };
  const q = useInfiniteQuery({
    queryKey: getListAuditEventsQueryKey(params),
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) => ok(listAuditEvents({ ...params, before_seq: pageParam })),
    getNextPageParam: (p) => p.next_before_seq ?? undefined,
  });
  const canVerify = useCan()('platform.audit_verify'); // verify has its own permission; don't fire a forbidden query
  const chain = useQuery({ queryKey: getVerifyAuditChainQueryKey(), queryFn: () => ok(verifyAuditChain()), enabled: canVerify });
  const rows = q.data?.pages.flatMap((p) => p.items) ?? [];
  const verified = chain.data?.intact;
  const columns: Array<ColumnDef<AuditEvent>> = [
    { header: '#', cell: (c) => <span className="tabular-nums text-muted-foreground">{c.row.original.seq}</span> },
    { header: t('audit.at'), cell: (c) => <span className="whitespace-nowrap">{formatDateTimeIN(c.row.original.occurred_at)}</span> },
    { header: t('audit.actor'), cell: (c) => <span className="font-mono text-xs">{c.row.original.user_id?.slice(0, 8) ?? '—'}</span> },
    { header: t('audit.action'), cell: (c) => <span>{tk(`audit.action.${c.row.original.action}`)}<span className="block font-mono text-xs text-muted-foreground">{c.row.original.action}</span></span> },
    { header: t('audit.entity'), cell: (c) => <span className="font-mono text-xs">{[c.row.original.table_name, c.row.original.row_id].filter(Boolean).join(' · ')}</span> },
        { header: t('audit.branch'), cell: (c) => <span className="font-mono text-xs">{c.row.original.branch_id?.slice(0, 8) ?? '—'}</span> },
  ];
  return (
    <div className="space-y-4">
      <PageHeader title={t('audit.title')} description={t('audit.description')}
        actions={verified === undefined ? null : verified
          ? <Badge variant="success" data-testid="chain-badge"><ShieldCheck className="mr-1 h-3 w-3" aria-hidden />{t('audit.chainOk')}</Badge>
          : <Badge variant="destructive" data-testid="chain-badge"><ShieldX className="mr-1 h-3 w-3" aria-hidden />{t('audit.chainBroken')}</Badge>} />
      <Card>
        <CardContent className="grid gap-3 pt-4 md:grid-cols-3">
          <Field label={t('audit.search')}>{(id) => <Input id={id} type="search" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />}</Field>
          <Field label={t('audit.from')}>{(id) => <Input id={id} type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />}</Field>
          <Field label={t('audit.to')}>{(id) => <Input id={id} type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />}</Field>
        </CardContent>
      </Card>
      <DataTable columns={columns} data={rows} caption={t('audit.title')} />
      {q.hasNextPage ? <Button variant="outline" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{t('audit.more')}</Button> : null}
    </div>
  );
}
