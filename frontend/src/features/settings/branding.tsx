import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ErrorText, Loading, OfflineBanner, PageHeader, Saved, EditGate } from '@/components/page';
import { EDIT_SETTINGS } from '@/lib/permissions';

import { checkContrast, resolveTokens, TokenOverride, type BrandColorRole } from '@/design-tokens';
import { useT, useTk } from '@/i18n';
import { ApiError, ifMatchOptional, ok } from '@/lib/api/fetcher';
import { getGetThemeQueryKey, getTheme, putTheme } from '@/lib/api/backend/branding/branding';
import { getPartnerGetThemeQueryKey, partnerGetTheme, partnerPutTheme } from '@/lib/api/backend/partner/partner';
import type { ThemeInput, ThemeView } from '@/lib/api/backend/model';
import { useBrand } from '@/lib/brand/context';
import { assetUrl, loadBrand, splitColors } from '@/lib/brand/loader';
import { formatDecimalIN } from '@/lib/format';
import { useOnline } from '@/lib/offline/connectivity';

const EDITABLE: Array<BrandColorRole | `dark.${BrandColorRole}`> = ['primary', 'accent', 'background', 'surface', 'text', 'border', 'dark.primary', 'dark.background', 'dark.text'];
const HEX = /^#[0-9a-fA-F]{6}$/;

/** Editable form model; maps onto the contract's ThemeInput (radius travels in fonts.radius_px). */
interface BrandForm { app_name: string; logo_key: string; favicon_key: string; radius_px: number; colors: Record<string, string>; rest: ThemeInput }
function toForm(v: ThemeView): BrandForm {
  const own = v.own ?? {};
  const r = Number(own.fonts?.['radius_px'] ?? v.effective.fonts?.['radius_px']);
  return { app_name: own.app_name ?? v.effective.app_name ?? '', logo_key: own.logo_key ?? '', favicon_key: own.favicon_key ?? '', radius_px: Number.isFinite(r) ? r : 8, colors: { ...(own.colors ?? {}) }, rest: own };
}
function toInput(f: BrandForm): ThemeInput {
  return { ...f.rest, app_name: f.app_name.trim(), logo_key: f.logo_key || null, favicon_key: f.favicon_key || null,
    colors: Object.fromEntries(Object.entries(f.colors).filter(([, v]) => HEX.test(v))), fonts: { ...(f.rest.fonts ?? {}), radius_px: String(f.radius_px) } };
}
const api = {
  // ThemeView.version is null until the first save (then If-Match is required).
  tenant: { key: getGetThemeQueryKey(), get: () => ok(getTheme()), put: (b: ThemeInput, v?: number | null) => ok(putTheme(b, ifMatchOptional(v))) },
  partner: { key: getPartnerGetThemeQueryKey(), get: () => ok(partnerGetTheme()), put: (b: ThemeInput, v?: number | null) => ok(partnerPutTheme(b, ifMatchOptional(v))) },
};

/** P16 branding for a tenant or (reseller console) partner. Publishing re-checks WCAG AA on the server too. */
export function BrandingEditor({ scope }: { scope: 'tenant' | 'partner' }) {
  const t = useT();
  const tk = useTk();
  const qc = useQueryClient();
  const online = useOnline();
  const { brand, setBrand } = useBrand();
  const a = api[scope];
  const q = useQuery({ queryKey: a.key, queryFn: a.get });
  const [f, setF] = useState<BrandForm | null>(null);
  useEffect(() => { if (q.data) setF(toForm(q.data)); }, [q.data]);
  const tokens = useMemo(() => {
    const colors = Object.fromEntries(Object.entries(f?.colors ?? {}).filter(([, v]) => HEX.test(v))) as Record<string, string>;
    return resolveTokens(TokenOverride.parse({ colors: splitColors(colors), radiusPx: f?.radius_px ?? 8 }));
  }, [f]);
  const issues = checkContrast(tokens);
  const save = useMutation({
    mutationFn: (b: BrandForm) => a.put(toInput(b), q.data?.version),
    onError: (e: unknown) => { if (e instanceof ApiError && e.isStale) void qc.invalidateQueries({ queryKey: a.key }); },
    onSuccess: async (d) => { qc.setQueryData(a.key, d); setBrand(await loadBrand()); },
  });
  if (!f) return <Loading />;
  const setColor = (k: string, v: string) => setF({ ...f, colors: { ...f.colors, [k]: v } });
  const clearColor = (k: string) => { const { [k]: _drop, ...rest } = f.colors; setF({ ...f, colors: rest }); };
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
      <div className="space-y-4">
        <Card>
          <CardHeader><CardTitle>{t('brand.identity')}</CardTitle></CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2">
            <Field label={t('brand.appName')}>{(id) => <Input id={id} value={f.app_name} onChange={(e) => setF({ ...f, app_name: e.target.value })} />}</Field>
            <Field label={t('brand.radius')}>{(id) => <Input id={id} type="number" min={0} max={24} value={f.radius_px} onChange={(e) => setF({ ...f, radius_px: Number(e.target.value) })} />}</Field>
            <Field label={t('brand.logo')} hint={t('brand.logoHint')}>{(id, d) => <Input id={id} aria-describedby={d} value={f.logo_key} onChange={(e) => setF({ ...f, logo_key: e.target.value })} />}</Field>
            <Field label={t('brand.icon')} hint={t('brand.iconHint')}>{(id, d) => <Input id={id} aria-describedby={d} value={f.favicon_key} onChange={(e) => setF({ ...f, favicon_key: e.target.value })} />}</Field>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>{t('brand.colours')}</CardTitle></CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-3">
            {EDITABLE.map((k) => {
              const role = k.replace('dark.', '') as BrandColorRole;
              const mode = k.startsWith('dark.') ? 'dark' : 'light';
              const v = f.colors[k] ?? tokens.colors[mode][role];
              return (
                <Field key={k} label={`${tk(`brand.role.${role}`)}${mode === 'dark' ? ` · ${t('brand.dark')}` : ''}`} error={f.colors[k] && !HEX.test(f.colors[k] ?? '') ? t('validation.hex') : null}>
                  {(id, d) => (
                    <div className="flex items-center gap-2">
                      <input aria-label={t('brand.pick')} type="color" className="h-10 w-12 rounded-md border border-input bg-background" value={HEX.test(v) ? v : tokens.colors[mode][role]} onChange={(e) => setColor(k, e.target.value)} />
                      <Input id={id} aria-describedby={d} className="font-mono" value={v} onChange={(e) => setColor(k, e.target.value)} />
                      {f.colors[k] ? <Button size="sm" variant="ghost" onClick={() => clearColor(k)}>{t('brand.inherit')}</Button> : null}
                    </div>)}
                </Field>
              );
            })}
          </CardContent>
        </Card>
      </div>
      <div className="space-y-4">
        <Card>
          <CardHeader><CardTitle>{t('brand.check')}</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {issues.length === 0 ? <Badge variant="success">{t('tokens.contrastOk')}</Badge> : (
              <>
                <Badge variant="destructive">{t('tokens.contrastIssues', { count: issues.length })}</Badge>
                <ul className="list-disc pl-5 text-xs">{issues.map((i) => <li key={`${i.mode}${i.pair}`}>{`${i.mode} · ${i.pair} · ${formatDecimalIN(String(i.ratio), 2)}:1`}</li>)}</ul>
              </>
            )}
            <p className="text-xs text-muted-foreground">{t('brand.inheritNote', { scope: tk(`surface.${scope === 'tenant' ? 'partner' : 'platform'}`) })}</p>
          </CardContent>
        </Card>
        <ErrorText error={save.error} />
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => setBrand({ ...brand, appName: f.app_name, logoUrl: assetUrl(f.logo_key), tokens })}>{t('brand.preview')}</Button>
          <Button disabled={!online || issues.length > 0 || !f.app_name.trim() || save.isPending} onClick={() => save.mutate(f)}>{t('brand.publish')}</Button>
          <Saved show={save.isSuccess} />
        </div>
      </div>
    </div>
  );
}

export function BrandingPage({ scope = 'tenant' }: { scope?: 'tenant' | 'partner' }) {
  const t = useT();
  return <div><PageHeader title={t('brand.title')} description={t(scope === 'partner' ? 'brand.descriptionPartner' : 'brand.description')} /><OfflineBanner /><EditGate perm={scope === 'tenant' ? EDIT_SETTINGS : undefined}><BrandingEditor scope={scope} /></EditGate></div>;
}
