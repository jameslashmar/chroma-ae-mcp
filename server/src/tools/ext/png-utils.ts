import * as fs from "node:fs";
import { PNG } from "pngjs";

/**
 * Pure-JS image helpers for the motion tools: area-average downscaling,
 * flattening alpha over a checkerboard, tiling, and a tiny bitmap font for
 * frame labels. Everything runs on the Node side (AE's CEP Node 17.7.2 too),
 * so nothing here touches the comp or AE's undo stack.
 */

export interface RgbaImage {
  width: number;
  height: number;
  data: Buffer | Uint8Array;
}

export type Rgba = [number, number, number, number];

/** Target size whose long edge is at most `maxSize`, keeping the aspect ratio. Never upscales. */
export function fitWithin(
  width: number,
  height: number,
  maxSize: number
): { width: number; height: number } {
  const longEdge = Math.max(width, height);
  if (longEdge <= maxSize) return { width, height };
  const k = maxSize / longEdge;
  return {
    width: Math.max(1, Math.round(width * k)),
    height: Math.max(1, Math.round(height * k)),
  };
}

/**
 * Per-destination-pixel source spans for a 1-D area-average resample:
 * each destination pixel covers [d*ratio, (d+1)*ratio) of the source, and
 * partially covered source pixels get fractional weights.
 */
function areaSpans(
  srcLen: number,
  dstLen: number
): Array<{ start: number; weights: number[]; norm: number }> {
  const ratio = srcLen / dstLen;
  const spans: Array<{ start: number; weights: number[]; norm: number }> = [];
  for (let d = 0; d < dstLen; d++) {
    const s0 = d * ratio;
    const s1 = Math.min(srcLen, (d + 1) * ratio);
    const start = Math.floor(s0);
    const end = Math.min(srcLen, Math.ceil(s1));
    const weights: number[] = [];
    for (let s = start; s < end; s++) {
      weights.push(Math.min(s + 1, s1) - Math.max(s, s0));
    }
    spans.push({ start, weights, norm: s1 - s0 });
  }
  return spans;
}

/**
 * Downscales with an area average in premultiplied alpha, so transparent
 * edges don't darken. Returns a copy at the same size when no shrink is
 * needed (this never upscales).
 */
export function resizeArea(src: RgbaImage, dstWidth: number, dstHeight: number): PNG {
  const sw = src.width;
  const sh = src.height;
  const dw = Math.max(1, Math.min(sw, Math.round(dstWidth)));
  const dh = Math.max(1, Math.min(sh, Math.round(dstHeight)));
  const out = new PNG({ width: dw, height: dh });

  if (dw === sw && dh === sh) {
    Buffer.from(src.data.buffer, src.data.byteOffset, sw * sh * 4).copy(out.data);
    return out;
  }

  // Horizontal pass: sw x sh -> dw x sh, premultiplied floats.
  const xSpans = areaSpans(sw, dw);
  const tmp = new Float32Array(dw * sh * 4);
  const data = src.data;
  for (let y = 0; y < sh; y++) {
    const rowIn = y * sw * 4;
    const rowOut = y * dw * 4;
    for (let dx = 0; dx < dw; dx++) {
      const span = xSpans[dx];
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let k = 0; k < span.weights.length; k++) {
        const i = rowIn + (span.start + k) * 4;
        const w = span.weights[k];
        const alpha = data[i + 3] / 255;
        r += data[i] * alpha * w;
        g += data[i + 1] * alpha * w;
        b += data[i + 2] * alpha * w;
        a += alpha * w;
      }
      const o = rowOut + dx * 4;
      tmp[o] = r / span.norm;
      tmp[o + 1] = g / span.norm;
      tmp[o + 2] = b / span.norm;
      tmp[o + 3] = a / span.norm;
    }
  }

  // Vertical pass: dw x sh -> dw x dh, then un-premultiply.
  const ySpans = areaSpans(sh, dh);
  for (let dy = 0; dy < dh; dy++) {
    const span = ySpans[dy];
    for (let dx = 0; dx < dw; dx++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let k = 0; k < span.weights.length; k++) {
        const i = ((span.start + k) * dw + dx) * 4;
        const w = span.weights[k];
        r += tmp[i] * w;
        g += tmp[i + 1] * w;
        b += tmp[i + 2] * w;
        a += tmp[i + 3] * w;
      }
      r /= span.norm;
      g /= span.norm;
      b /= span.norm;
      a /= span.norm;
      const o = (dy * dw + dx) * 4;
      if (a > 0) {
        out.data[o] = clamp255(r / a);
        out.data[o + 1] = clamp255(g / a);
        out.data[o + 2] = clamp255(b / a);
      }
      out.data[o + 3] = clamp255(a * 255);
    }
  }
  return out;
}

function clamp255(v: number): number {
  return v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v);
}

/**
 * Composites an image over a checkerboard, giving an opaque copy in which
 * transparent areas stay visible. The default greys are AE's light grid;
 * pass darker ones when white elements must stand out.
 */
export function flattenOnChecker(
  src: RgbaImage,
  cell: number = 8,
  light: number = 204,
  dark: number = 153
): PNG {
  const { width, height, data } = src;
  const out = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const bg = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0 ? light : dark;
      const a = data[i + 3] / 255;
      out.data[i] = Math.round(data[i] * a + bg * (1 - a));
      out.data[i + 1] = Math.round(data[i + 1] * a + bg * (1 - a));
      out.data[i + 2] = Math.round(data[i + 2] * a + bg * (1 - a));
      out.data[i + 3] = 255;
    }
  }
  return out;
}

export function createCanvas(width: number, height: number, fill: Rgba): PNG {
  const out = new PNG({ width, height });
  for (let i = 0; i < width * height * 4; i += 4) {
    out.data[i] = fill[0];
    out.data[i + 1] = fill[1];
    out.data[i + 2] = fill[2];
    out.data[i + 3] = fill[3];
  }
  return out;
}

/** Copies `src` into `dst` at (x, y), clipped to `dst`. No blending. */
export function blit(dst: PNG, src: RgbaImage, x: number, y: number): void {
  for (let sy = 0; sy < src.height; sy++) {
    const dy = y + sy;
    if (dy < 0 || dy >= dst.height) continue;
    for (let sx = 0; sx < src.width; sx++) {
      const dx = x + sx;
      if (dx < 0 || dx >= dst.width) continue;
      const si = (sy * src.width + sx) * 4;
      const di = (dy * dst.width + dx) * 4;
      dst.data[di] = src.data[si];
      dst.data[di + 1] = src.data[si + 1];
      dst.data[di + 2] = src.data[si + 2];
      dst.data[di + 3] = src.data[si + 3];
    }
  }
}

/** Fills a rectangle, alpha-blending `rgba` over what is already there. */
export function fillRect(
  dst: PNG,
  x: number,
  y: number,
  w: number,
  h: number,
  rgba: Rgba
): void {
  const a = rgba[3] / 255;
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(dst.width, x + w);
  const y1 = Math.min(dst.height, y + h);
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      const i = (py * dst.width + px) * 4;
      dst.data[i] = Math.round(rgba[0] * a + dst.data[i] * (1 - a));
      dst.data[i + 1] = Math.round(rgba[1] * a + dst.data[i + 1] * (1 - a));
      dst.data[i + 2] = Math.round(rgba[2] * a + dst.data[i + 2] * (1 - a));
      dst.data[i + 3] = Math.max(dst.data[i + 3], rgba[3]);
    }
  }
}

export function strokeRect(
  dst: PNG,
  x: number,
  y: number,
  w: number,
  h: number,
  thickness: number,
  rgba: Rgba
): void {
  fillRect(dst, x, y, w, thickness, rgba);
  fillRect(dst, x, y + h - thickness, w, thickness, rgba);
  fillRect(dst, x, y, thickness, h, rgba);
  fillRect(dst, x + w - thickness, y, thickness, h, rgba);
}

/**
 * Draws a line as a run of `thickness`-sized squares. Use an opaque colour:
 * the squares overlap, so a translucent one would blend more than once.
 */
export function drawLine(
  dst: PNG,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  thickness: number,
  rgba: Rgba
): void {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  const off = Math.floor(thickness / 2);
  for (let i = 0; i <= steps; i++) {
    const x = Math.round(x0 + ((x1 - x0) * i) / steps);
    const y = Math.round(y0 + ((y1 - y0) * i) / steps);
    fillRect(dst, x - off, y - off, thickness, thickness, rgba);
  }
}

// 5x7 glyphs for frame labels ("f30 1.20s", "#3"). Unknown characters render as a space.
const GLYPHS: Record<string, string[]> = {
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11111", "00010", "00100", "00010", "00001", "10001", "01110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  ":": ["00000", "01100", "01100", "00000", "01100", "01100", "00000"],
  "?": ["01110", "10001", "00001", "00010", "00100", "00000", "00100"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  "#": ["01010", "01010", "11111", "01010", "11111", "01010", "01010"],
  s: ["00000", "00000", "01110", "10000", "01110", "00001", "11110"],
  f: ["00110", "01001", "01000", "11100", "01000", "01000", "01000"],
  // Capitals and a few marks, for layer name tags (ae_annotate_frame). Other lowercase letters are not drawn.
  "A": ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  "B": ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  "C": ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  "D": ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  "E": ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  "F": ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  "G": ["01110", "10001", "10000", "10111", "10001", "10001", "01111"],
  "H": ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  "I": ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  "J": ["00111", "00010", "00010", "00010", "00010", "10010", "01100"],
  "K": ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  "L": ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  "M": ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  "N": ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  "O": ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  "P": ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  "Q": ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  "R": ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  "S": ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  "T": ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  "U": ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  "V": ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  "W": ["10001", "10001", "10001", "10101", "10101", "11011", "10001"],
  "X": ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  "Y": ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  "Z": ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
  "_": ["00000", "00000", "00000", "00000", "00000", "00000", "11111"],
  "/": ["00001", "00001", "00010", "00100", "01000", "10000", "10000"],
};

export const GLYPH_WIDTH = 5;
export const GLYPH_HEIGHT = 7;
const GLYPH_ADVANCE = GLYPH_WIDTH + 1;

export function textWidth(text: string, scale: number): number {
  return text.length === 0 ? 0 : (text.length * GLYPH_ADVANCE - 1) * scale;
}

export function drawText(
  dst: PNG,
  text: string,
  x: number,
  y: number,
  scale: number,
  rgba: Rgba
): void {
  for (let ci = 0; ci < text.length; ci++) {
    const glyph = GLYPHS[text[ci]];
    if (!glyph) continue;
    for (let row = 0; row < GLYPH_HEIGHT; row++) {
      for (let col = 0; col < GLYPH_WIDTH; col++) {
        if (glyph[row][col] === "1") {
          fillRect(dst, x + (ci * GLYPH_ADVANCE + col) * scale, y + row * scale, scale, scale, rgba);
        }
      }
    }
  }
}

export function encodePng(img: PNG): Buffer {
  return PNG.sync.write(img);
}

/**
 * Writes a downscaled copy of the PNG at `srcPath` to `dstPath`.
 * `maxSize` (long edge in pixels) wins over `scale`. Returns the source
 * unchanged (no file written) when no shrink is needed.
 */
export function writeScaledCopy(
  srcPath: string,
  dstPath: string,
  opts: { scale?: number; maxSize?: number }
): { path: string; width: number; height: number; scaled: boolean } {
  const src = PNG.sync.read(fs.readFileSync(srcPath));
  let target = { width: src.width, height: src.height };
  if (opts.maxSize !== undefined) {
    target = fitWithin(src.width, src.height, opts.maxSize);
  } else if (opts.scale !== undefined && opts.scale < 1) {
    target = {
      width: Math.max(1, Math.round(src.width * opts.scale)),
      height: Math.max(1, Math.round(src.height * opts.scale)),
    };
  }
  if (target.width >= src.width && target.height >= src.height) {
    return { path: srcPath, width: src.width, height: src.height, scaled: false };
  }
  const out = resizeArea(src, target.width, target.height);
  fs.writeFileSync(dstPath, encodePng(out));
  return { path: dstPath, width: out.width, height: out.height, scaled: true };
}

// ---------- helpers for ae_annotate_frame ----------

/** A copy of the rectangle (x, y, w, h) of `src`, clipped to it. At least 1x1. */
export function cropImage(src: RgbaImage, x: number, y: number, w: number, h: number): PNG {
  const x0 = Math.min(src.width - 1, Math.max(0, Math.round(x)));
  const y0 = Math.min(src.height - 1, Math.max(0, Math.round(y)));
  const cw = Math.max(1, Math.min(src.width - x0, Math.round(w)));
  const ch = Math.max(1, Math.min(src.height - y0, Math.round(h)));
  const out = new PNG({ width: cw, height: ch });
  for (let row = 0; row < ch; row++) {
    const si = ((y0 + row) * src.width + x0) * 4;
    Buffer.from(src.data.buffer, src.data.byteOffset + si, cw * 4).copy(out.data, row * cw * 4);
  }
  return out;
}

/** Nearest-neighbour resize to an exact size: pixels stay crisp when zooming in. */
export function scaleNearest(src: RgbaImage, dstWidth: number, dstHeight: number): PNG {
  const dw = Math.max(1, Math.round(dstWidth));
  const dh = Math.max(1, Math.round(dstHeight));
  const out = new PNG({ width: dw, height: dh });
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(src.height - 1, Math.floor(((y + 0.5) * src.height) / dh));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(src.width - 1, Math.floor(((x + 0.5) * src.width) / dw));
      const si = (sy * src.width + sx) * 4;
      const di = (y * dw + x) * 4;
      out.data[di] = src.data[si];
      out.data[di + 1] = src.data[si + 1];
      out.data[di + 2] = src.data[si + 2];
      out.data[di + 3] = src.data[si + 3];
    }
  }
  return out;
}

/** True when any pixel is not fully opaque. */
export function hasTransparency(src: RgbaImage): boolean {
  for (let i = 3; i < src.width * src.height * 4; i += 4) {
    if (src.data[i] < 255) return true;
  }
  return false;
}

export interface RegionStats {
  /** Mean colour weighted by alpha, so transparent pixels don't pull it to black. */
  mean_rgb: [number, number, number];
  hex: string;
  /** Rec. 709 weights on the encoded (not linear) mean colour, 0..1. */
  luma: number;
  /** Mean alpha, 0..1: how much of the region is covered. */
  alpha_mean: number;
  pixels: number;
}

/** Mean colour and luma of the pixel rectangle [x0, x1) x [y0, y1) of `src`. */
export function regionStats(src: RgbaImage, x0: number, y0: number, x1: number, y1: number): RegionStats {
  const ax = Math.max(0, Math.min(src.width, Math.floor(x0)));
  const ay = Math.max(0, Math.min(src.height, Math.floor(y0)));
  const bx = Math.max(ax, Math.min(src.width, Math.ceil(x1)));
  const by = Math.max(ay, Math.min(src.height, Math.ceil(y1)));
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  for (let y = ay; y < by; y++) {
    for (let x = ax; x < bx; x++) {
      const i = (y * src.width + x) * 4;
      const alpha = src.data[i + 3] / 255;
      r += src.data[i] * alpha;
      g += src.data[i + 1] * alpha;
      b += src.data[i + 2] * alpha;
      a += alpha;
    }
  }
  const pixels = (bx - ax) * (by - ay);
  const mean: [number, number, number] = a > 0 ? [clamp255(r / a), clamp255(g / a), clamp255(b / a)] : [0, 0, 0];
  const hex = "#" + mean.map((v) => v.toString(16).padStart(2, "0")).join("");
  const luma = (0.2126 * mean[0] + 0.7152 * mean[1] + 0.0722 * mean[2]) / 255;
  return {
    mean_rgb: mean,
    hex,
    luma: Math.round(luma * 1000) / 1000,
    alpha_mean: pixels > 0 ? Math.round((a / pixels) * 1000) / 1000 : 0,
    pixels,
  };
}

/** A closed outline through `points`. Use an opaque colour (see drawLine). */
export function drawPolygon(dst: PNG, points: Array<[number, number]>, thickness: number, rgba: Rgba): void {
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    drawLine(dst, Math.round(a[0]), Math.round(a[1]), Math.round(b[0]), Math.round(b[1]), thickness, rgba);
  }
}

/** A plus-shaped cross centred on (x, y) with arms of `arm` pixels. */
export function drawCross(dst: PNG, x: number, y: number, arm: number, thickness: number, rgba: Rgba): void {
  const cx = Math.round(x);
  const cy = Math.round(y);
  drawLine(dst, cx - arm, cy, cx + arm, cy, thickness, rgba);
  drawLine(dst, cx, cy - arm, cx, cy + arm, thickness, rgba);
}

/** Text on a filled box. Returns the box, so callers can keep later labels from overlapping it. */
export function drawLabel(
  dst: PNG,
  text: string,
  x: number,
  y: number,
  scale: number,
  fg: Rgba,
  bg: Rgba,
  pad: number = 2
): { x: number; y: number; w: number; h: number } {
  const w = textWidth(text, scale) + pad * 2;
  const h = GLYPH_HEIGHT * scale + pad * 2;
  fillRect(dst, x, y, w, h, bg);
  drawText(dst, text, x + pad, y + pad, scale, fg);
  return { x, y, w, h };
}
