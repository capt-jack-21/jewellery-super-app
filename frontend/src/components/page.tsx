import type { ReactNode } from 'react';
import { AlertTriangle, WifiOff } from 'lucide-react';
import { useT, useTk } from '@/i18n';
import { ApiError } from '@/lib/api/fetcher';
import { useOnline } from '@/lib/offline/connectivity';
import { useCan } from '@/lib/session';

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="font-heading text-2xl font-semibold">{title}</h1>
        {description ? <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

/**
 * Online-only rule (F0 rework): shown whenever the heartbeat says offline. Billing and estimates are blocked;
 * cached screens stay readable. `scope` picks the message: 'billing' on counter screens, 'writes' elsewhere.
 */
export function OfflineBanner({ scope = 'writes' }: { scope?: 'billing' | 'writes' }) {
  const t = useT();
  const online = useOnline();
  if (online) return null;
  return (
    <div role="alert" data-testid="offline-banner" className="mb-4 flex items-start gap-3 rounded-md border border-warning bg-warning/15 p-3 text-sm">
      <WifiOff className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
      <div>
        <p className="font-semibold">{t(scope === 'billing' ? 'offline.billing.title' : 'offline.writes.title')}</p>
        <p>{t(scope === 'billing' ? 'offline.billing.body' : 'offline.writes.body')}</p>
      </div>
    </div>
  );
}

/** Translated problem+json: known codes get a message, otherwise the server title. */
export function ErrorText({ error }: { error: unknown }) {
  const tk = useTk();
  if (!error) return null;
  // Known problem code → i18n; else a status fallback (403/412/428/429 often carry no code we know); else server title.
  const BY_STATUS: Record<number, string> = { 400: 'bad_request', 403: 'forbidden', 412: 'version_mismatch', 428: 'precondition_required', 429: 'rate_limited' };
  const known = (c?: string) => (c && tk(`error.${c}`) !== c ? tk(`error.${c}`) : undefined);
  const msg = error instanceof ApiError ? (known(error.code) ?? known(BY_STATUS[error.status]) ?? error.title) : String(error);
  return (
    <p role="alert" className="flex items-center gap-2 rounded-md border border-destructive bg-destructive/10 p-2 text-sm text-destructive">
      <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />{msg}
    </p>
  );
}

export function Saved({ show }: { show: boolean }) {
  const t = useT();
  return show ? <span role="status" className="text-sm text-success">{t('common.saved')}</span> : null;
}

export function Loading() {
  const t = useT();
  return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>;
}

/**
 * Read-only view for users without `perm`: a native disabled <fieldset> disables every input/button inside
 * (so no write can be submitted) and a translated note explains why. `perm` undefined → always editable.
 */
export function EditGate({ perm, children }: { perm?: string; children: ReactNode }) {
  const t = useT();
  const can = useCan();
  const editable = !perm || can(perm);
  return (
    <fieldset disabled={!editable} data-readonly={!editable || undefined} className="m-0 min-w-0 space-y-4 border-0 p-0">
      {editable ? null : <p role="note" data-testid="read-only-note" className="rounded-md border border-border bg-muted p-2 text-sm text-muted-foreground">{t('common.readOnly')}</p>}
      {children}
    </fieldset>
  );
}
