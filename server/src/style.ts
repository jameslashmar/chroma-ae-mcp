/**
 * server/src/style.ts
 *
 * The pure parts of the house style check:
 * - colour distance as CIE76 delta E in Lab (sRGB, D65), so "close to a
 *   brand colour" means close to the eye, not in raw RGB
 * - matching a used font (PostScript name or family) against brief fonts
 *   written the way people write them ("Gotham", "Gotham Bold")
 */

export type Rgb = [number, number, number];

export function hexToRgb(hex: string): Rgb {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`Not a #rrggbb colour: ${hex}`);
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rgbToHex(c: Rgb): string {
  return `#${c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("")}`;
}

function toLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

export function rgbToLab(c: Rgb): [number, number, number] {
  const [r, g, b] = c.map(toLinear);
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function deltaE(a: Rgb, b: Rgb): number {
  const p = rgbToLab(a);
  const q = rgbToLab(b);
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

/** Black, white or a grey: no hue to be on or off brand. */
export function isNeutral(c: Rgb): boolean {
  const lab = rgbToLab(c);
  return Math.hypot(lab[1], lab[2]) < 3;
}

export function nearestBrand(c: Rgb, palette: string[]): { hex: string; delta_e: number } | null {
  let best: { hex: string; delta_e: number } | null = null;
  for (const hex of palette) {
    const d = deltaE(c, hexToRgb(hex));
    if (!best || d < best.delta_e) best = { hex: hex.toLowerCase(), delta_e: Math.round(d * 10) / 10 };
  }
  return best;
}

const squash = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "");

/** True when the used font is one of the brief's, by family or PostScript name, spaces and hyphens aside. */
export function fontMatches(used: { font?: string | null; family?: string | null }, briefFonts: string[]): boolean {
  const names = [used.font, used.family].filter((x): x is string => Boolean(x)).map(squash);
  return briefFonts.some((b) => {
    const want = squash(b);
    return names.some((n) => n === want || n.startsWith(want) || want.startsWith(n));
  });
}
