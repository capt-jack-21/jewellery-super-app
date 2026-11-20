import { describe, expect, it } from 'vitest';
import { applyBrand, assetUrl, brandFromTheme, splitColors } from './loader';
import type { ThemeView } from '@/lib/api/backend/model';

describe('tenant theme loading (server-merged ThemeView)', () => {
  const view: ThemeView = {
    effective: { app_name: 'Tenant Shop', logo_key: '/p.svg', colors: { primary: '#0f766e', 'dark.primary': '#5eead4', accent: '#b45309' }, fonts: { radius_px: '3' } },
    own: { app_name: 'Tenant Shop' },
  };
  it('maps the effective theme to tokens', () => {
    const b = brandFromTheme(view);
    expect(b.appName).toBe('Tenant Shop');
    expect(b.logoUrl).toBe('/p.svg');
    expect(b.tokens.colors.light.primary).toBe('#0f766e');
    expect(b.tokens.colors.dark.primary).toBe('#5eead4');
    expect(b.tokens.colors.light.accent).toBe('#b45309');
    expect(b.tokens.radiusPx).toBe(3);
  });
  it('resolves asset keys', () => {
    expect(assetUrl('tenants/t1/logo.png')).toBe('/api/v1/assets/tenants/t1/logo.png');
    expect(assetUrl(null)).toBeNull();
  });
  it('splits flat colour maps into light/dark', () => {
    expect(splitColors({ primary: '#111111', 'dark.text': '#eeeeee' })).toEqual({ light: { primary: '#111111' }, dark: { text: '#eeeeee' } });
  });
  it('injects a single <style> with CSS vars and updates title + theme-color', () => {
    document.head.innerHTML = '<meta id="meta-theme-color" name="theme-color" content="">';
    const b = brandFromTheme(view);
    applyBrand(b); applyBrand(b);
    expect(document.querySelectorAll('#brand-tokens')).toHaveLength(1);
    expect(document.getElementById('brand-tokens')?.textContent).toContain('--primary:');
    expect(document.title).toBe('Tenant Shop');
    expect(document.getElementById('meta-theme-color')?.getAttribute('content')).toBe('#0f766e');
  });
});
