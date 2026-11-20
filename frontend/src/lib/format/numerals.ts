/**
 * Native numeral systems for prints (P14). Money/weight values are always computed on Western-digit
 * decimal strings; transliteration happens only at the last step of formatting.
 * Tamil digits U+0BE6–U+0BEF (௦௧௨௩௪௫௬௭௮௯). Others are ready for later languages.
 */
export const NUMERAL_SYSTEMS = ['latn', 'taml', 'deva', 'telu', 'knda', 'mlym'] as const;
export type Numerals = (typeof NUMERAL_SYSTEMS)[number];

const ZERO: Record<Numerals, number> = { latn: 0x30, taml: 0x0be6, deva: 0x0966, telu: 0x0c66, knda: 0x0ce6, mlym: 0x0d66 };

/** Replace ASCII digits 0–9 with the given system's digits. Separators (, .) are kept as-is. */
export function toNumerals(s: string, numerals: Numerals = 'latn'): string {
  if (numerals === 'latn') return s;
  const base = ZERO[numerals];
  return s.replace(/[0-9]/g, (d) => String.fromCharCode(base + d.charCodeAt(0) - 0x30));
}

/** Inverse, for parsing pasted native digits back to ASCII. */
export function fromNumerals(s: string): string {
  return s.replace(/[\u0BE6-\u0BEF\u0966-\u096F\u0C66-\u0C6F\u0CE6-\u0CEF\u0D66-\u0D6F]/g, (c) => {
    const code = c.charCodeAt(0);
    const base = Object.values(ZERO).find((z) => z !== 0x30 && code >= z && code <= z + 9) ?? 0x30;
    return String(code - base);
  });
}

export function isNumerals(v: unknown): v is Numerals {
  return typeof v === 'string' && (NUMERAL_SYSTEMS as readonly string[]).includes(v);
}
