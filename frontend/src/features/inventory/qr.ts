/**
 * QR for tag labels (qrcode-generator 2.0.4, approved 5 Nov 2026). Pure: returns the dark-module grid so the label can draw
 * it as one SVG path. The payload is sent as UTF-8 bytes (byte mode) with error correction M, version chosen automatically.
 * Returns null for an empty payload or one too long for any QR version; the label then shows the payload as text.
 */
import qrcode from 'qrcode-generator';

export type QrMatrix = { size: number; dark: (row: number, col: number) => boolean };

/** UTF-8 bytes as a 'binary' string: the library's default stringToBytes keeps the low byte of each char. */
export function utf8Binary(s: string): string {
  let out = '';
  for (const b of new TextEncoder().encode(s)) out += String.fromCharCode(b);
  return out;
}

export function qrMatrix(payload: string): QrMatrix | null {
  if (!payload) return null;
  try {
    const q = qrcode(0, 'M');
    q.addData(utf8Binary(payload), 'Byte');
    q.make();
    return { size: q.getModuleCount(), dark: (r, c) => q.isDark(r, c) };
  } catch {
    return null;
  }
}

/** SVG path data, one 1×1 square per dark module (quiet zone added by the caller's viewBox). */
export function qrPath(m: QrMatrix): string {
  const parts: string[] = [];
  for (let r = 0; r < m.size; r += 1) {
    for (let c = 0; c < m.size; c += 1) if (m.dark(r, c)) parts.push(`M${c} ${r}h1v1h-1z`);
  }
  return parts.join('');
}

/** Quiet zone in modules on each side (ISO/IEC 18004 asks for 4). */
export const QR_QUIET = 4;
