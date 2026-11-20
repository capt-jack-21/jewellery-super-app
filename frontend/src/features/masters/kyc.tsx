import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { ErrorText } from '@/components/page';
import { useT, useTk } from '@/i18n';
import { useRetryCountdown } from '@/lib/api/rate-limit';
import { KYC_REVEAL } from '@/lib/permissions';
import { useCan, useSignedIn } from '@/lib/session';
import { mastersApi, mastersKeys, type KycParty } from './api';
import { maskLast4 } from './mask';
import { MasterForm } from './master-screen';
import { editPermOf, MASTERS, type KycPartyType } from './registry';
import type { MasterRow } from './types';

const PARTY_TYPE: Record<KycParty, KycPartyType> = { customers: 'customer', vendors: 'vendor', staff: 'staff' };
export const REASON_MIN = 10;
export const REASON_MAX = 500;
type Revealed = { pan: string | null; panNotMigrated: boolean; documents: Array<{ id: string; doc_type: string; number: string | null }> };

/**
 * KYC on a customer / vendor / staff drawer: the party's documents (number masked to the last 4), adding one, and the
 * audited "Show" (masters.kyc.reveal). The list is filtered server-side by party_type + party_id (0.7.1).
 */
export function KycPanel({ party, row }: { party: KycParty; row: MasterRow }) {
  const t = useT();
  const tk = useTk();
  const can = useCan();
  const signedIn = useSignedIn();
  const partyType = PARTY_TYPE[party];
  const [adding, setAdding] = useState(false);
  const [revealOpen, setRevealOpen] = useState(false);
  const params = { party_type: partyType, party_id: row.id };
  const docs = useQuery({
    queryKey: mastersKeys.list('kyc_documents', params), enabled: signedIn, retry: false,
    queryFn: () => mastersApi.list('kyc_documents', params),
    select: (p) => p.items,
  });
  const notReady = docs.error && (docs.error as { status?: number }).status === 404;
  return (
    <section className="mt-6 space-y-3 border-t border-border pt-4" aria-labelledby="kyc-h" data-testid="kyc-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="kyc-h" className="font-medium">{t('masters.kyc.title')}</h3>
        {can(KYC_REVEAL) ? <Button size="sm" variant="outline" onClick={() => setRevealOpen(true)}>{t('masters.kyc.show')}</Button> : null}
      </div>
      {notReady ? <p className="text-sm text-muted-foreground">{t('masters.notReady')}</p> : docs.error ? <ErrorText error={docs.error} /> : (
        <ul className="space-y-1 text-sm">
          {(docs.data ?? []).map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-2" data-testid="kyc-doc">
              <span>{tk(`masters.o.kyc_type.${d.doc_type as string}`)}</span>
              <span className="font-mono">{maskLast4(d.number_last4 as string | null, 8)}</span>
              <Badge variant={d.status === 'verified' ? 'success' : 'outline'}>{tk(`masters.o.kyc_status.${d.status as string}`)}</Badge>
            </li>
          ))}
          {docs.data && !docs.data.length ? <li className="text-muted-foreground">{t('masters.kyc.none')}</li> : null}
        </ul>
      )}
      {adding ? (
        <MasterForm cfg={MASTERS.kyc_documents} row={null} refs={{}} editPerm={editPermOf('kyc_documents', partyType)}
          preset={{ party_type: partyType, party_id: row.id }} onClose={() => setAdding(false)} onSaved={() => setAdding(false)} />
      ) : can(editPermOf('kyc_documents', partyType)) && !notReady ? (
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}>{t('masters.kyc_documents.add')}</Button>
      ) : null}
      {revealOpen ? <RevealDialog party={party} id={row.id} onClose={() => setRevealOpen(false)} /> : null}
    </section>
  );
}

/**
 * Audited reveal. The result lives ONLY in this component's state — never in TanStack Query — and is dropped on close
 * or unmount (navigating away unmounts it). The server sends Cache-Control: no-store; 429 shows the Retry-After countdown.
 */
export function RevealDialog({ party, id, onClose }: { party: KycParty; id: string; onClose: () => void }) {
  const t = useT();
  const tk = useTk();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [shown, setShown] = useState<Revealed | null>(null);
  const wait = useRetryCountdown(error);
  useEffect(() => () => { setShown(null); }, []);
  const close = () => { setShown(null); setReason(''); onClose(); };
  const valid = reason.trim().length >= REASON_MIN && reason.trim().length <= REASON_MAX;
  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const r = await mastersApi.revealKyc(party, id, reason.trim());
      setShown({ pan: r.pan ?? null, panNotMigrated: r.pan_not_migrated === true, documents: r.documents ?? [] });
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="reveal-h" data-testid="reveal-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4" onKeyDown={(e) => { if (e.key === 'Escape') close(); }}>
      <div className="w-full max-w-md space-y-4 rounded-lg border border-border bg-card p-4 shadow-lg">
        <h2 id="reveal-h" className="text-lg font-semibold">{t('masters.kyc.revealTitle')}</h2>
        {shown ? (
          <dl className="space-y-1 text-sm" data-testid="revealed">
            <div className="flex gap-2"><dt className="text-muted-foreground">{t('masters.f.pan')}</dt><dd className="font-mono">{shown.pan ? shown.pan : '—'}</dd>
              {shown.panNotMigrated ? <dd className="text-xs text-muted-foreground" data-testid="pan-not-migrated">{t('masters.kyc.panNotMigrated')}</dd> : null}</div>
            {shown.documents.map((d) => (
              <div key={d.id} className="flex gap-2"><dt className="text-muted-foreground">{tk(`masters.o.kyc_type.${d.doc_type}`)}</dt><dd className="font-mono">{d.number ?? '—'}</dd></div>
            ))}
          </dl>
        ) : (
          <form className="space-y-3" noValidate onSubmit={(e) => { e.preventDefault(); if (valid) void submit(); }}>
            <p className="text-sm text-muted-foreground">{t('masters.kyc.revealHint')}</p>
            <Field label={`${t('masters.kyc.reason')} *`} hint={t('masters.kyc.reasonHint', { min: REASON_MIN })}>
              {(fid, d) => <textarea id={fid} aria-describedby={d} required maxLength={REASON_MAX} value={reason} onChange={(e) => setReason(e.target.value)}
                className="min-h-20 w-full rounded-md border border-input bg-background p-2 text-sm" />}
            </Field>
            <ErrorText error={error} />
            <Button type="submit" disabled={!valid || busy || wait > 0}>{wait > 0 ? t('auth.retryIn', { seconds: wait }) : t('masters.kyc.show')}</Button>
          </form>
        )}
        <div className="flex justify-end"><Button variant="ghost" onClick={close}>{t('masters.kyc.close')}</Button></div>
      </div>
    </div>
  );
}
