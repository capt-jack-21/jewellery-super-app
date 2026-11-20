import { toNumerals, type Numerals } from './numerals';
export const IST = 'Asia/Kolkata';

function parts(d: Date) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: IST, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return { dd: get('day'), mm: get('month'), yyyy: get('year'), hh: get('hour'), min: get('minute') };
}
/**
 * Parse an API instant. 0.9.0 sends RFC 3339 UTC ("2026-11-09T13:16:01.792494Z"); older Inventory rows were Postgres text
 * ("2026-11-09 18:46:01.792494+05:30"). Both are accepted: a space separator becomes "T", the fraction is cut to
 * milliseconds (some engines reject 6 digits), "+0530" / "+05" offsets are normalised. A zone-less date-time is shop time (IST).
 * Date-only strings ("2026-11-09") pass through. Null, empty or unparseable → null (callers show "—").
 */
export function parseInstant(v: Date | string | null | undefined): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const s = v.trim();
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)(\.\d+)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i.exec(s);
  let iso = s;
  if (m) {
    const [, day = '', time = '', fracRaw, zoneRaw] = m;
    const frac = fracRaw ? fracRaw.slice(0, 4).padEnd(4, '0') : '';
    const z = zoneRaw ? zoneRaw.toUpperCase() : '+05:30';
    const tz = z === 'Z' ? 'Z' : z.length === 3 ? `${z}:00` : z.includes(':') ? z : `${z.slice(0, 3)}:${z.slice(3)}`;
    iso = `${day}T${time.length === 5 ? `${time}:00` : time}${frac}${tz}`;
  }
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}
/** dd-MM-yyyy in IST regardless of the device time zone; "—" when missing or unparseable. */
export function formatDateIN(d: Date | string | null | undefined, numerals: Numerals = 'latn'): string {
  const x = parseInstant(d);
  if (!x) return '—';
  const { dd, mm, yyyy } = parts(x);
  return toNumerals(`${dd}-${mm}-${yyyy}`, numerals);
}
/** dd-MM-yyyy HH:mm IST (24 h) regardless of the device time zone; "—" when missing or unparseable. */
export function formatDateTimeIN(d: Date | string | null | undefined): string {
  const x = parseInstant(d);
  if (!x) return '—';
  const { dd, mm, yyyy, hh, min } = parts(x);
  return `${dd}-${mm}-${yyyy} ${hh}:${min} IST`;
}
/** Indian financial year (Apr–Mar) label for a date, e.g. "2026-27". Drives INV-1 series display. */
export function financialYear(d: Date | string): string {
  const x = parseInstant(d);
  if (!x) return '';
  const { mm, yyyy } = parts(x);
  const y = Number(yyyy);
  const start = Number(mm) >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}
