import { resolveTokens, tokensToCss, TokenOverride, type TokenSet } from '@/design-tokens';
import type { ThemeInput, ThemeView } from '@/lib/api/backend/model';
import { getTheme } from '@/lib/api/backend/branding/branding';

export interface Brand {
  appName: string;
  logoUrl: string | null;
  version: string;
  tokens: TokenSet;
  loginText: Record<string, Record<string, string>>;
  supportContact: Record<string, string>;
}

/** Branding colour maps are flat: "primary" = light theme, "dark.primary" = dark theme. */
export function splitColors(map: Record<string, string> | undefined): { light: Record<string, string>; dark: Record<string, string> } {
  const light: Record<string, string> = {}, dark: Record<string, string> = {};
  for (const [k, v] of Object.entries(map ?? {})) {
    if (k.startsWith('dark.')) dark[k.slice(5)] = v; else light[k] = v;
  }
  return { light, dark };
}

const CACHE_KEY = 'brand-cache-v3';
const STYLE_ID = 'brand-tokens';

/**
 * Asset keys are object-storage keys. The contract has no public asset URL endpoint yet (raised with backend);
 * absolute paths/URLs are used as-is, other keys are served from /api/v1/assets/{key} (assumed).
 */
export function assetUrl(key: string | null | undefined): string | null {
  if (!key) return null;
  return /^(\/|https?:)/.test(key) ? key : `/api/v1/assets/${key}`;
}

/**
 * Used when the server theme has no app_name, so document.title is never blank.
 * vite.config.ts always defines VITE_BRAND_APP_NAME (env/.env, else DEFAULT_BRAND_APP_NAME), so no brand literal lives in src/.
 */
export const DEFAULT_APP_NAME: string = (import.meta.env.VITE_BRAND_APP_NAME as string | undefined) ?? '';

/** ThemeView.effective is already merged platform → partner → tenant by the server. */
export function brandFromTheme(view: ThemeView, version = 'server'): Brand {
  const e: ThemeInput = view.effective;
  const radius = Number(e.fonts?.['radius_px']);
  return {
    appName: e.app_name || DEFAULT_APP_NAME,
    logoUrl: assetUrl(e.logo_key),
    version,
    tokens: resolveTokens(TokenOverride.parse({ colors: splitColors(e.colors), ...(Number.isFinite(radius) ? { radiusPx: radius } : {}) })),
    loginText: (e.login_text ?? {}) as Record<string, Record<string, string>>,
    supportContact: (e.support_contact ?? {}) as Record<string, string>,
  };
}

/** Applies a brand to the document: CSS variables, title, theme-color meta. */
export function applyBrand(brand: Brand, doc: Document = document): void {
  let style = doc.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = doc.createElement('style');
    style.id = STYLE_ID;
    doc.head.appendChild(style);
  }
  style.textContent = tokensToCss(brand.tokens);
  if (brand.appName) doc.title = brand.appName;
  doc.getElementById('meta-theme-color')?.setAttribute('content', brand.tokens.colors.light.primary);
  doc.documentElement.dataset.density ??= brand.tokens.density;
}

/** Host-based resolution (server reads the Host header). Order: network → last cached theme (offline) → platform defaults. */
export async function loadBrand(fetchTheme: () => Promise<{ data: ThemeView }> = () => getTheme() as Promise<{ data: ThemeView }>): Promise<Brand> {
  try {
    const res = await fetchTheme();
    localStorage.setItem(CACHE_KEY, JSON.stringify(res.data));
    return brandFromTheme(res.data);
  } catch {
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached) return brandFromTheme(JSON.parse(cached) as ThemeView, 'cached');
    return brandFromTheme({ effective: {} }, 'fallback');
  }
}
