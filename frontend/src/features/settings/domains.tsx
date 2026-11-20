import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ErrorText, OfflineBanner, PageHeader, EditGate } from '@/components/page';
import { EDIT_SETTINGS } from '@/lib/permissions';

import { useT, useTk } from '@/i18n';
import { ok } from '@/lib/api/fetcher';
import { addDomain, getListDomainsQueryKey, listDomains, verifyDomain } from '@/lib/api/backend/branding/branding';
import { getPartnerListDomainsQueryKey, partnerAddDomain, partnerListDomains } from '@/lib/api/backend/partner/partner';
import { useOnline } from '@/lib/offline/connectivity';

const variant = { pending: 'warning', verified: 'success', failed: 'destructive' } as const;
const api = {
  tenant: { key: getListDomainsQueryKey(), list: () => ok(listDomains()), add: (hostname: string) => ok(addDomain({ hostname })) },
  partner: { key: getPartnerListDomainsQueryKey(), list: () => ok(partnerListDomains()), add: (hostname: string) => ok(partnerAddDomain({ hostname })) },
};

/** P17 custom domain with automatic HTTPS: add hostname → show DNS records → verify → cert issued by the platform. */
export function DomainsPage({ scope = 'tenant' }: { scope?: 'tenant' | 'partner' }) {
  const t = useT();
  const tk = useTk();
  const qc = useQueryClient();
  const online = useOnline();
  const a = api[scope];
  const list = useQuery({ queryKey: a.key, queryFn: a.list });
  const [host, setHost] = useState('');
  const inval = () => qc.invalidateQueries({ queryKey: a.key });
  const add = useMutation({ mutationFn: () => a.add(host.trim().toLowerCase()), onSuccess: () => { setHost(''); void inval(); } });
  const verify = useMutation({ mutationFn: (id: string) => ok(verifyDomain(id)), onSuccess: () => void inval() });
  return (
    <div className="space-y-4">
      <PageHeader title={t('domain.title')} description={t('domain.description')} />
      <OfflineBanner />
      <EditGate perm={scope === 'tenant' ? EDIT_SETTINGS : undefined}>
      {list.data?.map((d) => (
        <Card key={d.id}>
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
            <CardTitle className="font-mono">{d.hostname}</CardTitle>
            <div className="flex gap-2">
              <Badge variant={variant[d.status]}>{tk(`domain.status.${d.status}`)}</Badge>
              {d.tls_status !== 'none' ? <Badge variant="outline">{tk(`domain.cert.${d.tls_status}`)}</Badge> : null}
            </div>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {d.status !== 'verified' ? (
              <>
                <p>{t('domain.dnsIntro')}</p>
                <table className="w-full font-mono text-xs">
                  <thead><tr className="text-left font-body text-muted-foreground"><th>{t('domain.type')}</th><th>{t('domain.name')}</th><th>{t('domain.value')}</th></tr></thead>
                  <tbody>
                    <tr><td>{'A'}</td><td>{d.hostname}</td><td>{window.location.hostname}</td></tr>
                    {d.dns_record ? <tr><td>{d.dns_record.type ?? 'TXT'}</td><td>{d.dns_record.name}</td><td>{d.dns_record.value}</td></tr> : null}
                  </tbody>
                </table>
                {d.failure_reason ? <p className="text-destructive">{d.failure_reason}</p> : null}
                <Button size="sm" disabled={!online || verify.isPending} onClick={() => verify.mutate(d.id)}>{t('domain.verify')}</Button>
              </>
            ) : <p className="text-muted-foreground">{t('domain.liveNote')}</p>}
          </CardContent>
        </Card>
      ))}
      <ErrorText error={verify.error} />
      <Card>
        <CardHeader><CardTitle>{t('domain.add')}</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap items-end gap-2">
          <Field label={t('domain.hostname')} hint={t('domain.hostnameHint')} className="min-w-72 flex-1">
            {(id, d) => <Input id={id} aria-describedby={d} className="font-mono" value={host} onChange={(e) => setHost(e.target.value)} />}</Field>
          <Button disabled={!online || !host.includes('.') || add.isPending} onClick={() => add.mutate()}>{t('domain.add')}</Button>
          <div className="w-full"><ErrorText error={add.error} /></div>
        </CardContent>
      </Card>
      </EditGate>
      {scope === 'tenant' ? <p className="text-xs text-muted-foreground">{t('domain.senderLater')}</p> : null}
    </div>
  );
}
