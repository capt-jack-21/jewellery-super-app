import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Drawer } from '@/components/ui/drawer';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ErrorText, OfflineBanner, PageHeader } from '@/components/page';
import { useT } from '@/i18n';
import { ApiError } from '@/lib/api/fetcher';
import { useChangeOwnPassword } from '@/lib/api/backend/auth/auth';
import { useResetUserPassword } from '@/lib/api/backend/users/users';
import type { User } from '@/lib/api/backend/model';
import { useOnline } from '@/lib/offline/connectivity';
import { newPasswordError, PASSWORD_MAX } from './password-rules';

/** 401 invalid_credentials = wrong current password (shown in the form). Session 401s are handled globally (query-client). */
export const isWrongCurrent = (e: unknown): boolean => e instanceof ApiError && e.status === 401 && e.code === 'invalid_credentials';

/** POST /v1/auth/password (0.7.4): change my own password. 204; other sessions are signed out, this one stays. */
export function ChangePasswordPage() {
  const t = useT();
  const online = useOnline();
  const [f, setF] = useState({ current: '', next: '', confirm: '' });
  const [touched, setTouched] = useState(false);
  const m = useChangeOwnPassword();
  const err = newPasswordError({ ...f, requireCurrent: true });
  const wrong = isWrongCurrent(m.error);
  const submit = () => {
    setTouched(true);
    if (err) return;
    m.mutate({ data: { current_password: f.current, new_password: f.next } }, { onSuccess: () => { setF({ current: '', next: '', confirm: '' }); setTouched(false); } });
  };
  return (
    <div className="max-w-lg space-y-4">
      <PageHeader title={t('password.change.title')} description={t('password.change.desc')} />
      <OfflineBanner />
      <Card><CardContent className="pt-4">
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
          <Field label={t('password.current')} error={wrong ? t('password.err.wrongCurrent') : null}>{(id, d) => (
            <Input id={id} aria-describedby={d} aria-invalid={wrong || undefined} type="password" autoComplete="current-password" maxLength={PASSWORD_MAX} value={f.current} onChange={(e) => { setF({ ...f, current: e.target.value }); m.reset(); }} />)}</Field>
          <NewPasswordFields value={f} onChange={(p) => { setF({ ...f, ...p }); m.reset(); }} />
          {touched && err ? <p role="alert" className="text-sm text-destructive">{t(err)}</p> : null}
          {m.error && !wrong ? <ErrorText error={m.error} /> : null}
          {m.isSuccess ? <p role="status" className="text-sm text-success" data-testid="password-changed">{t('password.change.done')}</p> : null}
          <Button type="submit" disabled={!online || m.isPending}><KeyRound className="h-4 w-4" aria-hidden />{t('password.change.submit')}</Button>
        </form>
      </CardContent></Card>
    </div>
  );
}

function NewPasswordFields({ value, onChange }: { value: { next: string; confirm: string }; onChange: (p: Partial<{ next: string; confirm: string }>) => void }) {
  const t = useT();
  return (
    <>
      <Field label={t('password.new')} hint={t('password.rules')}>{(id, d) => (
        <Input id={id} aria-describedby={d} type="password" autoComplete="new-password" maxLength={PASSWORD_MAX} value={value.next} onChange={(e) => onChange({ next: e.target.value })} />)}</Field>
      <Field label={t('password.confirm')}>{(id) => (
        <Input id={id} type="password" autoComplete="new-password" maxLength={PASSWORD_MAX} value={value.confirm} onChange={(e) => onChange({ confirm: e.target.value })} />)}</Field>
    </>
  );
}

/**
 * PUT /v1/users/{id}/password (0.7.4, platform.users.manage): set a temporary password for another user.
 * The server signs them out everywhere and clears any lockout. No If-Match on this endpoint (contract).
 */
export function ResetPasswordDrawer({ user, onClose }: { user: User | null; onClose: () => void }) {
  const t = useT();
  const online = useOnline();
  const [f, setF] = useState({ next: '', confirm: '' });
  const m = useResetUserPassword();
  const err = newPasswordError(f);
  const close = () => { setF({ next: '', confirm: '' }); m.reset(); onClose(); };
  return (
    <Drawer open={!!user} title={t('password.reset.title', { name: user?.name ?? '' })} closeLabel={t('common.cancel')} onClose={close}
      footer={m.isSuccess
        ? <Button onClick={close}>{t('password.reset.close')}</Button>
        : <Button disabled={!online || !user || !!err || m.isPending} onClick={() => user && m.mutate({ id: user.id, data: { password: f.next } })}>{t('password.reset.submit')}</Button>}>
      <div className="space-y-3">
        <p className="text-sm">{t('password.reset.explain')}</p>
        {m.isSuccess ? <p role="status" className="text-sm text-success" data-testid="password-reset-done">{t('password.reset.done', { name: user?.name ?? '' })}</p> : (
          <>
            <NewPasswordFields value={f} onChange={(p) => { setF({ ...f, ...p }); m.reset(); }} />
            {f.confirm && err ? <p role="alert" className="text-sm text-destructive">{t(err)}</p> : null}
            <ErrorText error={m.error} />
          </>
        )}
      </div>
    </Drawer>
  );
}
