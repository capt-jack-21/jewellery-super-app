/** Tailwind colour map: every colour is a CSS variable. No literal colours. */
const v = (name: string) => `hsl(var(--${name}) / <alpha-value>)`;
const pair = (name: string) => ({ DEFAULT: v(name), foreground: v(`${name}-foreground`) });

export const tailwindColorMap = {
  transparent: 'transparent',
  current: 'currentColor',
  background: v('background'),
  foreground: v('foreground'),
  border: v('border'),
  input: v('input'),
  ring: v('ring'),
  card: pair('card'), popover: pair('popover'), primary: pair('primary'), secondary: pair('secondary'),
  accent: pair('accent'), muted: pair('muted'), destructive: pair('destructive'),
  success: pair('success'), warning: pair('warning'), info: pair('info'),
  metal: { gold: v('metal-gold'), silver: v('metal-silver'), platinum: v('metal-platinum') },
};
