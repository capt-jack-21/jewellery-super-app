import { describe, expect, it } from 'vitest';
import { checkContrast, contrastRatio, hexToHslChannels, platformDefaultTokens, readableForeground, resolveTokens, sampleBrands, tokensToCss } from '.';
import { tailwindColorMap } from './tailwind';

describe('design tokens', () => {
  it('converts hex to HSL channels', () => {
    expect(hexToHslChannels('#ffffff')).toBe('0 0% 100%');
    expect(hexToHslChannels('#ff0000')).toBe('0 100% 50%');
  });
  it('merges tenant → partner → platform field by field', () => {
    const tenant = { colors: { light: { primary: '#111111' } } };
    const partner = { colors: { light: { primary: '#222222', accent: '#333333' } }, radiusPx: 2 };
    const t = resolveTokens(tenant, partner);
    expect(t.colors.light.primary).toBe('#111111');
    expect(t.colors.light.accent).toBe('#333333');
    expect(t.radiusPx).toBe(2);
    expect(t.colors.light.background).toBe(platformDefaultTokens.colors.light.background);
  });
  it('rejects invalid colour values', () => {
    expect(() => resolveTokens({ colors: { light: { primary: 'red' } } })).toThrow();
  });
  it('emits CSS variables for light, dark, densities and Tamil font', () => {
    const css = tokensToCss(resolveTokens());
    for (const s of [':root{', '[data-theme="dark"]{', '[data-density="counter"]', ':lang(ta)', '--primary:', '--primary-foreground:', '--metal-gold:']) expect(css).toContain(s);
  });
  it('platform defaults and all sample brands pass WCAG AA', () => {
    expect(checkContrast(resolveTokens())).toEqual([]);
    for (const b of Object.values(sampleBrands)) expect(checkContrast(resolveTokens(b))).toEqual([]);
  });
  it('flags poor contrast', () => {
    expect(checkContrast(resolveTokens({ colors: { light: { text: '#eeeeee' } } })).length).toBeGreaterThan(0);
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21);
    expect(readableForeground('#000000')).toBe('#ffffff');
  });
  it('Tailwind map contains only CSS-variable colours', () => {
    const flat = JSON.stringify(tailwindColorMap);
    expect(flat).not.toMatch(/#[0-9a-f]{3,6}/i);
  });
});
