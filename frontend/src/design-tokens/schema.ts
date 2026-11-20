import { z } from 'zod';

/** A colour token value. Accepted as #rrggbb (what branding.theme.colors stores) and converted to HSL channels. */
export const ColorValue = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Colour must be #rrggbb');

/** Brand-editable colour roles (matches keys in branding.theme.colors JSONB, schema v1). */
export const BRAND_COLOR_ROLES = [
  'primary', 'accent', 'background', 'surface', 'text', 'muted', 'border',
  'success', 'warning', 'danger', 'info',
  'metalGold', 'metalSilver', 'metalPlatinum',
] as const;
export type BrandColorRole = (typeof BRAND_COLOR_ROLES)[number];

const colorSet = z.object(Object.fromEntries(BRAND_COLOR_ROLES.map((r) => [r, ColorValue])) as Record<BrandColorRole, typeof ColorValue>);
export type ColorSet = z.infer<typeof colorSet>;

export const TokenSet = z.object({
  colors: z.object({ light: colorSet, dark: colorSet }),
  fonts: z.object({ heading: z.string(), body: z.string(), tamil: z.string(), mono: z.string() }),
  radiusPx: z.number().min(0).max(24),
  density: z.enum(['counter', 'office']),
});
export type TokenSet = z.infer<typeof TokenSet>;

/** A partial override as stored at one scope (platform / partner / tenant). Merged field by field. */
export const TokenOverride = z.object({
  colors: z.object({ light: colorSet.partial(), dark: colorSet.partial() }).partial().optional(),
  fonts: TokenSet.shape.fonts.partial().optional(),
  radiusPx: z.number().min(0).max(24).optional(),
  density: z.enum(['counter', 'office']).optional(),
});
export type TokenOverride = z.infer<typeof TokenOverride>;
