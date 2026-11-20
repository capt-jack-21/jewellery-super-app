export type FontLang = 'en' | 'ta' | 'hi' | 'te' | 'kn' | 'ml';

/** Font family per print language (all bundled locally via @fontsource, loaded on demand). */
export const PRINT_FONT: Record<FontLang, string> = {
  en: '"Noto Sans", sans-serif',
  ta: '"Noto Sans Tamil", "Noto Sans", sans-serif',
  hi: '"Noto Sans Devanagari", "Noto Sans", sans-serif',
  te: '"Noto Sans Telugu", "Noto Sans", sans-serif',
  kn: '"Noto Sans Kannada", "Noto Sans", sans-serif',
  ml: '"Noto Sans Malayalam", "Noto Sans", sans-serif',
};

const loaders: Record<Exclude<FontLang, 'en'>, () => Promise<unknown>> = {
  ta: () => Promise.all([import('@fontsource/noto-sans-tamil/400.css'), import('@fontsource/noto-sans-tamil/600.css')]),
  hi: () => Promise.all([import('@fontsource/noto-sans-devanagari/400.css'), import('@fontsource/noto-sans-devanagari/600.css')]),
  te: () => Promise.all([import('@fontsource/noto-sans-telugu/400.css'), import('@fontsource/noto-sans-telugu/600.css')]),
  kn: () => Promise.all([import('@fontsource/noto-sans-kannada/400.css'), import('@fontsource/noto-sans-kannada/600.css')]),
  ml: () => Promise.all([import('@fontsource/noto-sans-malayalam/400.css'), import('@fontsource/noto-sans-malayalam/600.css')]),
};
const loaded = new Map<FontLang, Promise<unknown>>();
/** Load a script's font CSS (and thus its woff2) only when that language is first shown. */
export function loadFont(l: FontLang): Promise<unknown> {
  if (l === 'en') return Promise.resolve();
  let p = loaded.get(l);
  if (!p) { p = loaders[l](); loaded.set(l, p); }
  return p;
}
