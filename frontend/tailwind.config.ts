import type { Config } from 'tailwindcss';
import { tailwindColorMap } from './src/design-tokens/tailwind';

// theme.colors is REPLACED (not extended): Tailwind's default palette (bg-blue-600 …) does not exist.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    colors: tailwindColorMap,
    fontFamily: { body: 'var(--font-body)', heading: 'var(--font-heading)', mono: 'var(--font-mono)' },
    borderRadius: { none: '0', sm: 'calc(var(--radius) - 4px)', md: 'calc(var(--radius) - 2px)', lg: 'var(--radius)', full: '9999px' },
    extend: { spacing: { row: 'var(--row-height)', tap: 'var(--tap-target)' } },
  },
} satisfies Config;
