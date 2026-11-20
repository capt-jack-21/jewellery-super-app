import type { TokenSet } from './schema';

/**
 * Platform default token set: deliberately NEUTRAL (greys + a muted slate primary) so that it reads as
 * "unbranded". This file and the sample brands are the ONLY places colour literals may appear
 * (enforced by eslint + scripts/check-tokens.mjs).
 */
export const platformDefaultTokens: TokenSet = {
  colors: {
    light: {
      primary: '#3f4a5a', accent: '#6b7280', background: '#fafafa', surface: '#ffffff', text: '#18181b',
      muted: '#71717a', border: '#e4e4e7', success: '#15803d', warning: '#a16207', danger: '#b91c1c', info: '#1d4ed8',
      metalGold: '#a16207', metalSilver: '#71717a', metalPlatinum: '#52525b',
    },
    dark: {
      primary: '#c7cfdb', accent: '#a1a1aa', background: '#0f0f11', surface: '#18181b', text: '#f4f4f5',
      muted: '#a1a1aa', border: '#2e2e33', success: '#4ade80', warning: '#facc15', danger: '#f87171', info: '#93c5fd',
      metalGold: '#facc15', metalSilver: '#d4d4d8', metalPlatinum: '#a1a1aa',
    },
  },
  fonts: {
    heading: '"Noto Sans", system-ui, sans-serif',
    body: '"Noto Sans", system-ui, sans-serif',
    tamil: '"Noto Sans Tamil", "Noto Sans", sans-serif',
    mono: 'ui-monospace, "Noto Sans Mono", monospace',
  },
  radiusPx: 8,
  density: 'office',
};
