import { useState, type FormEvent } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ErrorText, OfflineBanner } from '@/components/page';
import { useLocale, useT, type MessageKey } from '@/i18n';
import { login as apiLogin, verifyOtp } from '@/lib/api/backend/auth/auth';
import { useRetryCountdown } from '@/lib/api/rate-limit';
import { adminLogin } from '@/lib/api/backend/admin/admin';
import { partnerLogin } from '@/lib/api/backend/partner/partner';
import type { OtpChallenge, Session } from '@/lib/api/backend/model';
import { ok } from '@/lib/api/fetcher';
import { useBrand } from '@/lib/brand/context';
import { deviceKey } from '@/lib/device-key';
import { useOnline } from '@/lib/offline/connectivity';
import { adminStore, homeFor, type Surface } from '@/lib/session';

const SHOP = 'login-shop-slug';
const PARTNER_SLUG = 'login-partner-slug';
const TITLE: Record<Surface, MessageKey> = { tenant: 'auth.title', partner: 'auth.partnerTitle', platform: 'auth.adminTitle' };

/**
 * P8 password login (username or mobile) + P9 OTP when the server answers 202 with a challenge.
 * Partner staff sign in with partner slug (optional on the partner's own domain) + email → httpOnly `psid` cookie;
 * platform operators sign in with email (admin_sid cookie).
 */
export function LoginPage({ surface = 'tenant' }: { surface?: Surface }) {
  const t = useT();
  const { brand } = useBrand();
  const { locale } = useLocale();
  const online = useOnline();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { redirect?: string; reason?: string };
  const [shop, setShop] = useState(() => localStorage.getItem(surface === 'partner' ? PARTNER_SLUG : SHOP) ?? '');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState<OtpChallenge | null>(null);

  const finish = async () => {
    qc.clear();
    void navigate({ to: search.redirect && !search.redirect.endsWith('/login') ? search.redirect : homeFor(surface) });
  };
  const pw = useMutation({
    mutationFn: async () => {
      if (surface === 'platform') { adminStore.set(await ok(adminLogin({ email: login.trim(), password }))); return null; }
      if (surface === 'partner') {
        if (shop.trim()) localStorage.setItem(PARTNER_SLUG, shop.trim()); else localStorage.removeItem(PARTNER_SLUG);
        await ok(partnerLogin({ email: login.trim(), password, ...(shop.trim() ? { partner: shop.trim() } : {}) }));
        return null;
      }
      if (shop.trim()) localStorage.setItem(SHOP, shop.trim()); else localStorage.removeItem(SHOP);
      const res = await apiLogin({ login: login.trim(), password, device_key: deviceKey(), ...(shop.trim() ? { tenant: shop.trim() } : {}) });
      return res.status === 202 ? (res.data as OtpChallenge) : null;
    },
    onSuccess: async (c) => { if (c) setChallenge(c); else await finish(); },
  });
  const otp = useMutation({
    mutationFn: async (): Promise<Session> => ok(verifyOtp({ challenge_id: challenge?.challenge_id ?? '', code, device_key: deviceKey() })),
    onSuccess: finish,
  });
  // 429 rate_limited: count down Retry-After and keep the retry disabled until then.
  const pwWait = useRetryCountdown(pw.error);
  const otpWait = useRetryCountdown(otp.error);
  const submit = (e: FormEvent) => { e.preventDefault(); if (challenge ? otpWait : pwWait) return; if (challenge) otp.mutate(); else pw.mutate(); };

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted p-4 font-body text-foreground">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <p className="text-sm text-muted-foreground">{brand.appName}</p>
          <CardTitle>{surface === 'tenant' ? (brand.loginText[locale.slice(0, 2)]?.title ?? t(TITLE[surface])) : t(TITLE[surface])}</CardTitle>
        </CardHeader>
        <CardContent>
          <OfflineBanner />
          {search.reason === 'idle' ? <p role="status" className="mb-3 text-sm text-muted-foreground">{t('auth.idleLoggedOut')}</p> : null}
          <form onSubmit={submit} className="space-y-3" noValidate>
            {!challenge ? (
              <>
                {surface !== 'platform' ? (
                  <Field label={t(surface === 'partner' ? 'auth.partnerSlug' : 'auth.shop')} hint={t(surface === 'partner' ? 'auth.partnerSlugHint' : 'auth.shopHint')}>
                    {(id, d) => <Input id={id} aria-describedby={d} autoComplete="organization" value={shop} onChange={(e) => setShop(e.target.value.toLowerCase())} />}
                  </Field>
                ) : null}
                <Field label={t(surface === 'tenant' ? 'auth.login' : 'auth.email')} hint={surface === 'tenant' ? t('auth.loginHint') : undefined}>
                  {(id, d) => <Input id={id} aria-describedby={d} type={surface === 'tenant' ? 'text' : 'email'} autoComplete="username" value={login} onChange={(e) => setLogin(e.target.value)} autoFocus required />}
                </Field>
                <Field label={t('auth.password')}>
                  {(id, d) => <Input id={id} aria-describedby={d} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />}
                </Field>
                <ErrorText error={pw.error} />
                <Button type="submit" className="w-full" disabled={!online || pw.isPending || pwWait > 0 || !login || password.length < 8}>{pwWait ? t('auth.retryIn', { seconds: pwWait }) : t('auth.signIn')}</Button>
              </>
            ) : (
              <>
                <p className="text-sm">{t('auth.otpSentTo', { to: challenge.masked_destination ?? '' })}</p>
                <Field label={t('auth.otp')} hint={t('auth.otpHint')}>
                  {(id, d) => <Input id={id} aria-describedby={d} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6}
                    value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus className="font-mono tracking-widest" />}
                </Field>
                <ErrorText error={otp.error} />
                <Button type="submit" className="w-full" disabled={!online || otp.isPending || otpWait > 0 || code.length !== 6}>{otpWait ? t('auth.retryIn', { seconds: otpWait }) : t('auth.verify')}</Button>
                <Button type="button" variant="ghost" className="w-full" onClick={() => { setChallenge(null); setCode(''); }}>{t('common.back')}</Button>
              </>
            )}
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
