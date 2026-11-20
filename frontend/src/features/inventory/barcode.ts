/**
 * Code 128 (set B) encoder — pure, no dependencies. Contract 0.8.0: the CLIENT draws the label barcode from
 * `barcode_payload` (Code128 by default). Returns the module widths (bar, space, bar, …) for an SVG, or null when the
 * payload has characters outside printable ASCII (set B), which the label then shows as text only.
 */
export const CODE128_PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213', '221312', '231212', '112232',
  '122132', '122231', '113222', '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131', '311222', '321122',
  '321221', '312212', '322112', '322211', '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311',
  '211313', '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331', '231131', '213113',
  '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224', '111422',
  '121124', '121421', '141122', '141221', '112214', '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111',
  '241112', '134111', '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141', '214121',
  '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141', '114131', '311141', '411131', '211412',
  '211214', '211232', '2331112',
] as const;
const START_B = 104;
const STOP = 106;

/** Symbol values: start B, data, checksum, stop. */
export function code128Values(payload: string): number[] | null {
  if (!payload || !/^[\x20-\x7e]+$/.test(payload)) return null;
  const data = [...payload].map((ch) => ch.charCodeAt(0) - 32);
  const check = data.reduce((sum, v, i) => sum + v * (i + 1), START_B) % 103;
  return [START_B, ...data, check, STOP];
}

/** Alternating bar/space widths in modules (first is a bar). */
export function code128Widths(payload: string): number[] | null {
  const v = code128Values(payload);
  return v ? v.flatMap((x) => [...(CODE128_PATTERNS[x] ?? '')].map(Number)) : null;
}

/** Bars as {x, w} rectangles in module units; total width includes a 10-module quiet zone each side. */
export function code128Bars(payload: string): { bars: Array<{ x: number; w: number }>; width: number } | null {
  const ws = code128Widths(payload);
  if (!ws) return null;
  const bars: Array<{ x: number; w: number }> = [];
  let x = 10;
  ws.forEach((w, i) => { if (i % 2 === 0) bars.push({ x, w }); x += w; });
  return { bars, width: x + 10 };
}
