import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { IntlProvider, useIntl } from 'react-intl';
import en from './messages/en-IN.json';
import ta from './messages/ta-IN.json';
import { loadFont } from '@/lib/fonts';

export const LOCALES = ['en-IN', 'ta-IN'] as const;
export type Locale = (typeof LOCALES)[number];
export type MessageKey = keyof typeof en;
export const catalogues: Record<Locale, Record<MessageKey, string>> = { 'en-IN': en, 'ta-IN': ta };
export const localeLabels: Record<Locale, string> = { 'en-IN': 'English', 'ta-IN': 'தமிழ்' };
/** API language codes are bare ('en', 'ta'); the UI uses en-IN/ta-IN for Intl. */
export const fromApiLang = (code: string | null | undefined): Locale | null => (code ? (LOCALES.find((l) => l === code || l.startsWith(`${code}-`)) ?? null) : null);
export const toApiLang = (l: Locale): string => l.slice(0, 2);
export const isLocale = (v: unknown): v is Locale => typeof v === 'string' && (LOCALES as readonly string[]).includes(v);

/**
 * Effective UI language = user override ?? shop (tenant) default ?? last-used (pre-login screens only).
 * The shop default comes from business-rules.language.default_locale; the override from /platform/me.
 * Both are server settings; localStorage only remembers the last effective value for the login screen.
 */
export function resolveLocale(userOverride: string | null | undefined, tenantDefault: string | null | undefined, fallback: Locale = 'en-IN'): Locale {
  if (isLocale(userOverride)) return userOverride;
  if (isLocale(tenantDefault)) return tenantDefault;
  return fallback;
}

const LAST = 'ui-locale-last';
interface Sources { tenantDefault: Locale | null; userOverride: Locale | null }
const LocaleCtx = createContext<{ locale: Locale; sources: Sources; setSources: (s: Partial<Sources>) => void }>({
  locale: 'en-IN', sources: { tenantDefault: null, userOverride: null }, setSources: () => {},
});

export function I18nProvider({ children, initial }: { children: ReactNode; initial?: Locale }) {
  const [sources, set] = useState<Sources>({ tenantDefault: null, userOverride: null });
  const fallback = useMemo<Locale>(() => initial ?? (isLocale(localStorage.getItem(LAST)) ? (localStorage.getItem(LAST) as Locale) : 'en-IN'), [initial]);
  const locale = resolveLocale(sources.userOverride, sources.tenantDefault, fallback);
  useEffect(() => {
    localStorage.setItem(LAST, locale);
    document.documentElement.lang = locale.slice(0, 2);
    if (locale === 'ta-IN') void loadFont('ta'); // Tamil UI font is fetched only when Tamil is used
  }, [locale]);
  const setSources = useCallback((s: Partial<Sources>) => set((p) => {
    const n = { ...p, ...s };
    return n.tenantDefault === p.tenantDefault && n.userOverride === p.userOverride ? p : n;
  }), []);
  const value = useMemo(() => ({ locale, sources, setSources }), [locale, sources, setSources]);
  return (
    <LocaleCtx.Provider value={value}>
      <IntlProvider locale={locale} messages={catalogues[locale]} defaultLocale="en-IN">{children}</IntlProvider>
    </LocaleCtx.Provider>
  );
}
export const useLocale = () => useContext(LocaleCtx);

/** Typed translate helper: t('rates.title'). */
export function useT() {
  const intl = useIntl();
  return (id: MessageKey, values?: Record<string, string | number>) => intl.formatMessage({ id }, values);
}
/** For server enums: t(`role.${code}`) with a safe fallback to the raw code. */
export function useTk() {
  const intl = useIntl();
  return (id: string) => (id in en ? intl.formatMessage({ id }) : id.split('.').pop() ?? id);
}
