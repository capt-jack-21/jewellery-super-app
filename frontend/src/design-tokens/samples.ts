import type { TokenOverride } from './schema';

/** Sample brands for visual-regression tests (light, dark-primary, high-contrast). Fictional. */
export const sampleBrands: Record<'light' | 'darkPrimary' | 'highContrast', TokenOverride> = {
  light: { colors: { light: { primary: '#0f766e', accent: '#b45309' } }, radiusPx: 12 },
  darkPrimary: { colors: { light: { primary: '#4c0519', accent: '#a16207', background: '#fdf8f3' } }, radiusPx: 4 },
  highContrast: {
    colors: { light: { primary: '#000000', text: '#000000', background: '#ffffff', surface: '#ffffff', border: '#000000', muted: '#333333' } },
    radiusPx: 0,
  },
};
