/**
 * server/src/tools/ext/edges.ts
 *
 * Straight edges in an image: Sobel gradients, a ridge scan along the side of a quad, robust line fits
 * and intersections. Shared by ae_screen_corners (screenrep.ts) and the screen tracker (screen-track.ts).
 * Pure. Image pixels, index coordinates (pixel i's centre at i).
 */

import type { Vec2 } from "./planar-math.js";
import type { GrayImage } from "./track.js";

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

const median = (a: number[]): number => {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// ---------- gradients ----------

export interface Gradients {
  width: number;
  height: number;
  gx: Float32Array;
  gy: Float32Array;
  mag: Float32Array;
}

/** Sobel gradients in gray levels per pixel (the kernel is divided by 8). The one-pixel border is zero. */
export function sobel(g: GrayImage): Gradients {
  const { width: w, height: h, data: d } = g;
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  const mag = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const a = d[i - w - 1];
      const b = d[i - w];
      const c = d[i - w + 1];
      const l = d[i - 1];
      const r = d[i + 1];
      const e = d[i + w - 1];
      const f = d[i + w];
      const k = d[i + w + 1];
      const sx = (c + 2 * r + k - (a + 2 * l + e)) / 8;
      const sy = (e + 2 * f + k - (a + 2 * b + c)) / 8;
      gx[i] = sx;
      gy[i] = sy;
      mag[i] = Math.hypot(sx, sy);
    }
  }
  return { width: w, height: h, gx, gy, mag };
}

export function bilinear(a: Float32Array, w: number, h: number, x: number, y: number): number {
  const xc = clamp(x, 0, w - 1.001);
  const yc = clamp(y, 0, h - 1.001);
  const x0 = Math.floor(xc);
  const y0 = Math.floor(yc);
  const fx = xc - x0;
  const fy = yc - y0;
  const i = y0 * w + x0;
  return (a[i] * (1 - fx) + a[i + 1] * fx) * (1 - fy) + (a[i + w] * (1 - fx) + a[i + w + 1] * fx) * fy;
}

// ---------- edges: ridge scan along a side, robust line, intersection ----------

export type EdgePreference = "outer" | "inner" | "nearest";

/** Weakest ridge (gray levels per pixel along the normal) that counts as an edge. */
export const MIN_EDGE = 3;

export interface SideScan {
  points: Vec2[];
  strengths: number[];
  /** Scan lines on which a second strong ridge sat more than 3 px from the chosen one. */
  competing: number;
  found: number;
  expected: number;
}

/**
 * Looks for the edge along the side a -> b (image pixels, index coordinates).
 * At each of the sample positions along the side (the middle 80%, so rounded
 * ends and the corners themselves stay out) the gradient component along the
 * outward normal is sampled over +-searchPx; the ridges at least 0.6 of the
 * strongest one are the candidates and `prefer` picks one: the outermost (the
 * outer bezel edge, which screen content and reflections inside cannot fake),
 * the innermost, or the one nearest the guess. A second candidate more than
 * 3 px away is counted as competing. Sub-pixel by a parabola through the peak.
 */
export function scanSide(gr: Gradients, a: Vec2, b: Vec2, outward: Vec2, o: { searchPx: number; prefer: EdgePreference }): SideScan {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const steps = Math.max(8, Math.min(200, Math.floor(len / 2)));
  const step = 0.5;
  const S = Math.max(2, o.searchPx);
  const n = Math.floor((2 * S) / step) + 1;
  const prof = new Float64Array(n);
  const points: Vec2[] = [];
  const strengths: number[] = [];
  let competing = 0;
  const { width: w, height: h } = gr;
  for (let k = 0; k < steps; k++) {
    const u = 0.1 + (0.8 * (k + 0.5)) / steps;
    const px = a[0] + (b[0] - a[0]) * u;
    const py = a[1] + (b[1] - a[1]) * u;
    let top = 0;
    for (let j = 0; j < n; j++) {
      const d = -S + j * step;
      const x = px + outward[0] * d;
      const y = py + outward[1] * d;
      if (x < 1 || y < 1 || x > w - 2 || y > h - 2) {
        prof[j] = 0;
        continue;
      }
      const sx = bilinear(gr.gx, w, h, x, y);
      const sy = bilinear(gr.gy, w, h, x, y);
      prof[j] = Math.abs(sx * outward[0] + sy * outward[1]);
      if (prof[j] > top) top = prof[j];
    }
    if (top < MIN_EDGE) continue;
    const peaks: number[] = [];
    for (let j = 1; j < n - 1; j++) {
      if (prof[j] > prof[j - 1] && prof[j] >= prof[j + 1] && prof[j] >= 0.6 * top && prof[j] >= MIN_EDGE) peaks.push(j);
    }
    if (peaks.length === 0) continue;
    let pick = peaks[0];
    if (o.prefer === "outer") pick = peaks[peaks.length - 1];
    else if (o.prefer === "nearest") pick = peaks.reduce((best, j) => (Math.abs(-S + j * step) < Math.abs(-S + best * step) ? j : best), peaks[0]);
    if (peaks.some((j) => Math.abs(j - pick) * step > 3)) competing++;
    const l = prof[pick - 1];
    const c = prof[pick];
    const r = prof[pick + 1];
    const den = l - 2 * c + r;
    const off = den < 0 ? clamp((0.5 * (l - r)) / den, -0.5, 0.5) : 0;
    const d = -S + (pick + off) * step;
    points.push([px + outward[0] * d, py + outward[1] * d]);
    strengths.push(c);
  }
  return { points, strengths, competing, found: points.length, expected: steps };
}

export interface Line {
  /** A point on the line (the centroid of the inliers). */
  c: Vec2;
  /** Unit direction. */
  dir: Vec2;
  inliers: number;
  total: number;
  rms: number;
}

function totalLeastSquares(pts: Vec2[]): { c: Vec2; dir: Vec2 } {
  const n = pts.length;
  const cx = pts.reduce((s, p) => s + p[0], 0) / n;
  const cy = pts.reduce((s, p) => s + p[1], 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of pts) {
    const dx = p[0] - cx;
    const dy = p[1] - cy;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { c: [cx, cy], dir: [Math.cos(ang), Math.sin(ang)] };
}

const distToLine = (p: Vec2, c: Vec2, dir: Vec2): number => Math.abs((p[0] - c[0]) * dir[1] - (p[1] - c[1]) * dir[0]);

/**
 * A line through the points by total least squares, refitted on the points
 * within max(tol, 2.5 robust sigmas) of it until that set stops changing, so a
 * few points on a competing ridge or on a rounded end do not bend it. Null for
 * fewer than 6 points.
 */
export function fitLine(pts: Vec2[], tol = 1): Line | null {
  if (pts.length < 6) return null;
  let use = pts;
  let line = totalLeastSquares(use);
  for (let it = 0; it < 4; it++) {
    const res = pts.map((p) => distToLine(p, line.c, line.dir));
    const thr = Math.max(tol, 2.5 * 1.4826 * median(res));
    const next = pts.filter((_, i) => res[i] <= thr);
    if (next.length < 6 || next.length === use.length) break;
    use = next;
    line = totalLeastSquares(use);
  }
  const rms = Math.sqrt(use.reduce((s, p) => s + distToLine(p, line.c, line.dir) ** 2, 0) / use.length);
  return { c: line.c, dir: line.dir, inliers: use.length, total: pts.length, rms };
}

/** Where two lines meet. Null when they are within about 14 degrees of parallel. */
export function intersectLines(a: Line, b: Line): Vec2 | null {
  const cr = a.dir[0] * b.dir[1] - a.dir[1] * b.dir[0];
  if (Math.abs(cr) < 0.25) return null;
  const t = ((b.c[0] - a.c[0]) * b.dir[1] - (b.c[1] - a.c[1]) * b.dir[0]) / cr;
  return [a.c[0] + a.dir[0] * t, a.c[1] + a.dir[1] * t];
}

