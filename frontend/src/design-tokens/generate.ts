import { contrastRatio, hexToHslChannels, readableForeground } from './color';
import { platformDefaultTokens } from './defaults';
import { TokenOverride, TokenSet, type ColorSet } from './schema';

/** Resolution order tenant → partner → platform default, merged FIELD BY FIELD (spec WL-2). */
export function resolveTokens(...overridesHighToLow: Array<TokenOverride | null | undefined>): TokenSet {
  const layers = [...overridesHighToLow].reverse().filter(Boolean) as TokenOverride[];
  const out: TokenSet = structuredClone(platformDefaultTokens);
  for (const raw of layers) {
    const o = TokenOverride.parse(raw);
    Object.assign(out.colors.light, o.colors?.light ?? {});
    Object.assign(out.colors.dark, o.colors?.dark ?? {});
    Object.assign(out.fonts, o.fonts ?? {});
    if (o.radiusPx !== undefined) out.radiusPx = o.radiusPx;
    if (o.density !== undefined) out.density = o.density;
  }
  return TokenSet.parse(out);
}

function colorVars(c: ColorSet): Record<string, string> {
  const v = (hex: string) => hexToHslChannels(hex);
  return {
    '--background': v(c.background), '--foreground': v(c.text),
    '--card': v(c.surface), '--card-foreground': v(c.text),
    '--popover': v(c.surface), '--popover-foreground': v(c.text),
    '--primary': v(c.primary), '--primary-foreground': v(readableForeground(c.primary)),
    '--secondary': v(c.border), '--secondary-foreground': v(c.text),
    '--accent': v(c.accent), '--accent-foreground': v(readableForeground(c.accent)),
    '--muted': v(c.border), '--muted-foreground': v(c.muted),
    '--destructive': v(c.danger), '--destructive-foreground': v(readableForeground(c.danger)),
    '--success': v(c.success), '--success-foreground': v(readableForeground(c.success)),
    '--warning': v(c.warning), '--warning-foreground': v(readableForeground(c.warning)),
    '--info': v(c.info), '--info-foreground': v(readableForeground(c.info)),
    '--border': v(c.border), '--input': v(c.border), '--ring': v(c.primary),
    '--metal-gold': v(c.metalGold), '--metal-silver': v(c.metalSilver), '--metal-platinum': v(c.metalPlatinum),
  };
}

const block = (sel: string, vars: Record<string, string>) =>
  `${sel}{${Object.entries(vars).map(([k, val]) => `${k}:${val};`).join('')}}`;

/** Emits the CSS that /branding.css serves per host. */
export function tokensToCss(t: TokenSet): string {
  const base = {
    ...colorVars(t.colors.light),
    '--radius': `${t.radiusPx}px`,
    '--font-heading': t.fonts.heading, '--font-body': t.fonts.body,
    '--font-tamil': t.fonts.tamil, '--font-mono': t.fonts.mono,
  };
  return [
    block(':root', base),
    block('[data-theme="dark"]', colorVars(t.colors.dark)),
    block('[data-density="office"]', { '--row-height': '2.25rem', '--tap-target': '2.25rem', '--base-font-size': '14px' }),
    block('[data-density="counter"]', { '--row-height': '3rem', '--tap-target': '3rem', '--base-font-size': '17px' }),
    block(':lang(ta)', { '--font-body': t.fonts.tamil, '--font-heading': t.fonts.tamil }),
  ].join('\n');
}

export interface ContrastIssue { mode: 'light' | 'dark'; pair: string; ratio: number }
/** WCAG AA (4.5:1) checks run before a branding profile can be published. */
export function checkContrast(t: TokenSet): ContrastIssue[] {
  const issues: ContrastIssue[] = [];
  for (const mode of ['light', 'dark'] as const) {
    const c = t.colors[mode];
    const pairs: Array<[string, string, string]> = [
      ['text/background', c.text, c.background],
      ['text/surface', c.text, c.surface],
      ['muted/surface', c.muted, c.surface],
      ['primary-fg/primary', readableForeground(c.primary), c.primary],
      ['danger-fg/danger', readableForeground(c.danger), c.danger],
    ];
    for (const [pair, fg, bg] of pairs) {
      const ratio = contrastRatio(fg, bg);
      if (ratio < 4.5) issues.push({ mode, pair, ratio: Math.round(ratio * 100) / 100 });
    }
  }
  return issues;
}
