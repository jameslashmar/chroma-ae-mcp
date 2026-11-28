/**
 * server/src/tools/ext/surface-points.ts
 *
 * A region track checked against the surface's own distinct points (its marks), independently of how the
 * region was aligned. At the reference frame the points are picked: corners and marks inside the region
 * (minus what is excluded), spread out, each holding against sliding (track.ts patternIsotropy). For a
 * solved frame each point's reference patch is looked for in the frame warped back by the track's motion:
 * at half size within 40 px, then at full size within 3 px. Where the points sit then, against where they
 * were, is how far the track is off at them, in reference image px.
 *
 * Why: the region aligner weighs every textured pixel by its edge, so on a sparsely marked green wall a
 * few strong edges that are not on the wall's plane (the curve of a cyc, a second wall, a stand in front)
 * can outweigh the faint marks. Measured on Hollywood Camera Work's matchmove plates (2026-11-28): the
 * region track drifted 2-29 px (Matchmove Test Wide), up to 22 px (Close) and 2-5 px (the window) while
 * every check of its own passed; the marks said so on 93, 56 and about 50 frames, and on a right track
 * (the U-Haul truck, a person walking in front) they sat 0.1-0.4 px off.
 *
 * Points that are not on the surface's plane, or matched on something passing in front, are left out: with
 * 8 points or more, the ones that one homography explains (RANSAC, 1.5 px) and at least half of them; with 4
 * to 7, all of them, and only when every match is strong. Fewer than 4: no verdict. Pure: no AE, no files.
 */

import { goodFeatures, mulH, ransacModel, translationH, applyH, type Mat3, type Vec2 } from "./planar-math.js";
import { patternIsotropy, MIN_PATTERN_ISOTROPY, type GrayImage } from "./track.js";

export interface SurfacePointsCheck {
  /** Points matched in the frame. */
  matched: number;
  /** Points the verdict was read from (the plane's own). */
  used: number;
  /** Their median distance from where the track puts them, reference image px. */
  px: number;
}

/** Fewer distinct points than this on the surface: no check. */
export const MIN_SURFACE_POINTS = 4;
/** Up to this many points. */
const MAX_POINTS = 40;
/** The coarse search (half size): this many half-size px each way, so twice that at full size. */
const COARSE_REACH = 20;
const FINE_REACH = 3;
const COARSE_MIN_SCORE = 0.6;
const FINE_MIN_SCORE = 0.7;
/** With 4 to 7 points, every match must be at least this good. */
const FEW_MIN_SCORE = 0.8;
const RANSAC_PX = 1.5;

function bilinear(img: GrayImage, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  if (x0 < 0 || y0 < 0 || x0 + 1 >= img.width || y0 + 1 >= img.height) return NaN;
  const fx = x - x0;
  const fy = y - y0;
  const w = img.width;
  const d = img.data;
  return (d[y0 * w + x0] * (1 - fx) + d[y0 * w + x0 + 1] * fx) * (1 - fy) + (d[(y0 + 1) * w + x0] * (1 - fx) + d[(y0 + 1) * w + x0 + 1] * fx) * fy;
}

/** An n x n patch of `img` around (x, y), every `step` px. */
function patchAt(img: GrayImage, x: number, y: number, n: number, step: number): Float64Array {
  const t = new Float64Array(n * n);
  const h = (n - 1) / 2;
  for (let v = 0; v < n; v++) for (let u = 0; u < n; u++) t[v * n + u] = bilinear(img, x + (u - h) * step, y + (v - h) * step);
  return t;
}

/** The (n + 2r) square of the frame around reference point (x, y), warped back by H, every `step` px. */
function windowAt(img: GrayImage, H: Mat3, x: number, y: number, n: number, r: number, step: number): Float64Array {
  const m = n + 2 * r;
  const out = new Float64Array(m * m);
  const h = (m - 1) / 2;
  for (let v = 0; v < m; v++) {
    for (let u = 0; u < m; u++) {
      const p = applyH(H, [x + (u - h) * step, y + (v - h) * step]);
      out[v * m + u] = p ? bilinear(img, p[0], p[1]) : NaN;
    }
  }
  return out;
}

/** The best normalized correlation of template t (n x n) in window w ((n + 2r) square): the offset, sub-pixel, and its score. */
function search(t: Float64Array, n: number, w: Float64Array, r: number): { dx: number; dy: number; score: number } | null {
  const m = n + 2 * r;
  const k = 2 * r + 1;
  let tm = 0;
  for (let i = 0; i < t.length; i++) tm += t[i];
  tm /= t.length;
  let tv = 0;
  for (let i = 0; i < t.length; i++) tv += (t[i] - tm) ** 2;
  if (!(tv > 0) || Number.isNaN(tv)) return null;
  const sc = new Float64Array(k * k).fill(-2);
  let best = -2;
  let bi = -1;
  for (let dy = 0; dy < k; dy++) {
    for (let dx = 0; dx < k; dx++) {
      let wm = 0;
      let bad = false;
      for (let v = 0; v < n && !bad; v++) {
        for (let u = 0; u < n; u++) {
          const q = w[(v + dy) * m + u + dx];
          if (Number.isNaN(q)) {
            bad = true;
            break;
          }
          wm += q;
        }
      }
      if (bad) continue;
      wm /= n * n;
      let cr = 0;
      let wv = 0;
      for (let v = 0; v < n; v++) {
        for (let u = 0; u < n; u++) {
          const a = t[v * n + u] - tm;
          const b = w[(v + dy) * m + u + dx] - wm;
          cr += a * b;
          wv += b * b;
        }
      }
      const s = wv > 0 ? cr / Math.sqrt(tv * wv) : -2;
      sc[dy * k + dx] = s;
      if (s > best) {
        best = s;
        bi = dy * k + dx;
      }
    }
  }
  if (bi < 0) return null;
  const bx = bi % k;
  const by = (bi - bx) / k;
  const sub = (a: number, b: number, c: number) => {
    const d = a - 2 * b + c;
    return d < 0 && a > -2 && c > -2 ? (0.5 * (a - c)) / d : 0;
  };
  const ox = bx > 0 && bx < k - 1 ? sub(sc[by * k + bx - 1], best, sc[by * k + bx + 1]) : 0;
  const oy = by > 0 && by < k - 1 ? sub(sc[(by - 1) * k + bx], best, sc[(by + 1) * k + bx]) : 0;
  return { dx: bx - r + ox, dy: by - r + oy, score: best };
}

const median = (v: number[]): number => {
  const s = v.slice().sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};

export class SurfacePoints {
  readonly points: Vec2[];
  private readonly coarse: Float64Array[];
  private readonly fine: Float64Array[];
  private readonly n: number;
  private readonly nc: number;

  /**
   * `ref` is the reference frame (the same image the region is aligned in), `mask` > 0 on the surface. The
   * patch is 41 px at 1080 lines, scaled with the image's height.
   */
  constructor(ref: GrayImage, mask: Float32Array) {
    const f = Math.max(0.5, ref.height / 1080);
    this.n = Math.max(21, Math.round(41 * f)) | 1;
    this.nc = Math.max(11, Math.round(this.n / 2)) | 1;
    // The patch and its whole search must lie on the surface.
    const reach = (this.n - 1) / 2 + FINE_REACH + 2 * COARSE_REACH;
    const on = (x: number, y: number) => {
      const X = Math.round(x);
      const Y = Math.round(y);
      return X >= 0 && Y >= 0 && X < ref.width && Y < ref.height && mask[Y * ref.width + X] > 0;
    };
    const inside = (x: number, y: number) => {
      const h = (this.n - 1) / 2 + 4;
      return on(x, y) && on(x - h, y - h) && on(x + h, y - h) && on(x - h, y + h) && on(x + h, y + h) && x - reach >= 0 && y - reach >= 0 && x + reach < ref.width && y + reach < ref.height;
    };
    const found = goodFeatures(ref, mask, { count: MAX_POINTS * 2, minDistancePx: Math.round(40 * f), patchSize: this.n, spread: true });
    this.points = found
      .filter((p) => p.std >= 4 && inside(p.x, p.y) && (patternIsotropy(ref, p.x, p.y, this.n) ?? 0) >= MIN_PATTERN_ISOTROPY)
      .slice(0, MAX_POINTS)
      .map((p) => [p.x, p.y] as Vec2);
    this.coarse = this.points.map(([x, y]) => patchAt(ref, x, y, this.nc, 2));
    this.fine = this.points.map(([x, y]) => patchAt(ref, x, y, this.n, 1));
  }

  get count(): number {
    return this.points.length;
  }

  /** Half the patch, image px: how far round a point its match looks. */
  get reach(): number {
    return (this.n - 1) / 2;
  }

  /**
   * How far the track `H` (reference image px -> frame image px) is off at the surface's points in `frame`.
   * Null when fewer than MIN_SURFACE_POINTS were matched, or when 4 to 7 were and one match was weak.
   */
  check(frame: GrayImage, H: Mat3, seed = 1, skip?: (x: number, y: number) => boolean): SurfacePointsCheck | null {
    if (this.points.length < MIN_SURFACE_POINTS) return null;
    const shifts: Array<{ k: number; dx: number; dy: number; score: number }> = [];
    this.points.forEach(([x, y], k) => {
      // A point under a hand-drawn matte of what is in front is not looked for (`skip` gets its place in the frame).
      if (skip) {
        const at = applyH(H, [x, y]);
        if (!at || skip(at[0], at[1])) return;
      }
      const c = search(this.coarse[k], this.nc, windowAt(frame, H, x, y, this.nc, COARSE_REACH, 2), COARSE_REACH);
      if (!c || c.score < COARSE_MIN_SCORE) return;
      const cx = 2 * c.dx;
      const cy = 2 * c.dy;
      const Hs = mulH(H, translationH(cx, cy));
      const fn = search(this.fine[k], this.n, windowAt(frame, Hs, x, y, this.n, FINE_REACH, 1), FINE_REACH);
      if (!fn || fn.score < FINE_MIN_SCORE) return;
      shifts.push({ k, dx: cx + fn.dx, dy: cy + fn.dy, score: fn.score });
    });
    if (shifts.length < MIN_SURFACE_POINTS) return null;
    let use = shifts;
    if (shifts.length >= 8) {
      const from = shifts.map((s) => this.points[s.k]);
      const to = shifts.map((s) => [this.points[s.k][0] + s.dx, this.points[s.k][1] + s.dy] as Vec2);
      const fit = ransacModel("perspective", from, to, { thresholdPx: RANSAC_PX, iterations: 300, seed });
      if (fit) {
        const inl = shifts.filter((_, i) => fit.inliers[i]);
        if (inl.length >= Math.max(MIN_SURFACE_POINTS, 0.5 * shifts.length)) use = inl;
      }
    } else if (!shifts.every((s) => s.score >= FEW_MIN_SCORE)) {
      return null;
    }
    return { matched: shifts.length, used: use.length, px: median(use.map((s) => Math.hypot(s.dx, s.dy))) };
  }
}
