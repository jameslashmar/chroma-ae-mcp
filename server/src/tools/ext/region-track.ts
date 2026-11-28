/**
 * server/src/tools/ext/region-track.ts
 *
 * Following a planar surface by its pixels instead of a few points (ae_track_multi `region`), and
 * checking any solved frame against the surface (the points tracker's verdict). Pure: no AE, no files.
 *
 * Robust inverse-compositional Lucas-Kanade on an 8-parameter homography, coarse to fine over a
 * four-level image pyramid. Every frame is aligned straight to the reference frame's region, so the
 * track does not drift; the start is the last frames' motion carried on at the same speed. Each
 * iteration fits a gain and bias (exposure changes), and Tukey weights on the residual push occluders
 * out; the samples an occluder covered on the last good frame stay out of the first two thirds of the
 * iterations, because a person walking in front moves little between frames and must not pull the fit
 * before it is rejected.
 *
 * The verdict comes from the aligned pixels themselves: the normalized cross-correlation of the
 * reference and the frame over the samples the fit kept, and the share of the visible samples it kept.
 * Measured on Hollywood Camera Work plates (2026-11-27, a Python prototype of this file): frames on
 * the surface scored 0.95-0.99 over 40-95% of it; frames hundreds of px off scored 0.1-0.4. A frame
 * that fails is reported (ok false), its last good motion is held, and the next frame starts again from
 * there, so the track picks up once the occluder has gone.
 *
 * Coordinates: image px with pixel i's centre at i (as track.ts); the caller converts to comp px.
 */

import { applyH, invertH, mulH, quadCheck, quadGrid, type Mat3, type Vec2 } from "./planar-math.js";
import type { SurfacePoints, SurfacePointsCheck } from "./surface-points.js";
import type { GrayImage } from "./track.js";

/** NCC over the kept samples a frame needs to count as on the surface. */
export const VERDICT_NCC = 0.85;
/** Share of the visible samples the fit must keep. */
export const VERDICT_COVERAGE = 0.2;

export interface RegionOptions {
  /** Pyramid levels (each half the size of the last). Default 4. */
  levels?: number;
  /** Samples at the finest level, the most textured pixels of the region spread over it. Default 12000. */
  maxSamples?: number;
  /**
   * The channels that say whether a frame is on the surface (its correlation and the cells); the others
   * only help the fit. Default all. A screen's key keeps its look through a shot while its brightness
   * drifts (a glossy bezel turning to the light: measured on a laptop, the key's correlation held 0.98
   * while the brightness's fell from 0.78 to 0.66 over 60 frames of a right fit), so only the key judges.
   */
  verdictChannels?: number[];
}

interface Level {
  s: number;
  n: number;
  xs: Float32Array;
  ys: Float32Array;
  /** The first channel's reference values and rows (tvs[0], Js[0]). */
  tv: Float64Array;
  /** n x 8 steepest-descent rows, in the level's normalized coordinates. */
  J: Float64Array;
  /** Per channel: the reference values at the samples, and their n x 8 rows. */
  tvs: Float64Array[];
  Js: Float64Array[];
  /** Per channel: 1 where the sample has an edge (1 level a px or more), the samples a residual says anything at. */
  strongs: Uint8Array[];
  N: Mat3;
  Ninv: Mat3;
  r: number;
}

export interface AlignResult {
  /** Image px (level 0) of the reference -> image px of the frame. */
  H: Mat3;
  ncc: number;
  /** The correlation per channel (ncc is their mean). */
  nccs: number[];
  /** Share of the visible samples the fit kept (weight over 0.5). */
  coverage: number;
  /** Share of the samples inside the frame. */
  visible: number;
  /** Robust residual sigma, gray levels. */
  sigma: number;
  /** Per level (finest first), the final weights: the occlusion memory for the next frame. */
  weights: Float32Array[];
  /** sigma^2 (J^T W J)^-1 at the finest level (8 x 8, row-major), for the expected error. Null when singular. */
  cov: Float64Array | null;
  /** Local agreement over a grid of cells (see cellAgreement). */
  cells: CellAgreement;
}

/**
 * The region cut into a CELL_GRID x CELL_GRID grid. A cell with texture of its own (its reference samples
 * vary by CELL_MIN_STD gray levels or more) agrees when its samples, all of them, correlate with the frame
 * by CELL_NCC or more. One correlation over the whole region is fooled by a mostly flat surface (a green
 * board with a few markers kept 0.99 while 100 px off: its two tones line up in many places); its textured
 * cells, and what the agreeing ones can hold, are not (cellsAgree).
 */
export interface CellAgreement {
  textured: number;
  matched: number;
  /** How far the agreeing cells reach, as a share of how far the textured ones do, 0..1, left-right and top-bottom (reported only). */
  span: [number, number];
  /**
   * How much less the agreeing cells alone pin the motion down than the whole fit does: the expected error
   * at the region's corners from their samples only, over the same from every sample the fit kept (1 when
   * every cell agrees). Half a textured surface hidden by a person: 2-4. A band along one edge of a flat
   * board that lines up while the rest is wrong: far more, because a band cannot hold the far side.
   */
  pinned: number;
  /** The expected error at the region's corners from the agreeing cells alone, px (calibrated like expectedError). */
  pinned_px: number;
}

export const CELL_GRID = 6;
export const CELL_MIN_STD = 4;
export const CELL_NCC = 0.75;
/** Share of the textured cells that must agree. */
export const CELL_SHARE = 0.35;
/** The agreeing cells alone must hold the region's corners to this (px), or to this many times the whole fit. */
export const PIN_PX = 2;
export const PIN_RATIO = 2;

/**
 * Whether the cells say the frame is on the surface: enough of the textured cells agree, and the ones
 * that agree hold the whole surface (pinned_px within PIN_PX, or within PIN_RATIO times what the whole
 * fit gives). Measured on the four plates and a synthetic one (2026-11-27): right frames had 50-100% of
 * their textured cells agreeing and pinned_px up to 1.2 px (a person covering half a truck; half a plane
 * hidden: 0.16 px); frames 6-230 px off had under 30% agreeing, or a band along one edge of a flat board
 * that agreed while pinning the far corners only to 3.4-38 px.
 */
export function cellsAgree(c: CellAgreement): boolean {
  if (c.textured < 4) return true;
  return c.matched >= Math.max(3, CELL_SHARE * c.textured) && (c.pinned_px <= PIN_PX || c.pinned <= PIN_RATIO);
}

// ---------- images ----------

/** OpenCV's pyrDown: a 5-tap Gaussian [1 4 6 4 1] / 16 each way (borders reflected), then every other pixel. */
export function pyrDown(img: GrayImage): GrayImage {
  const { width: w, height: h, data } = img;
  const ow = Math.max(1, Math.floor((w + 1) / 2));
  const oh = Math.max(1, Math.floor((h + 1) / 2));
  const refl = (i: number, n: number) => {
    if (n === 1) return 0;
    let k = i;
    while (k < 0 || k >= n) k = k < 0 ? -k : 2 * n - 2 - k;
    return k;
  };
  // Horizontal pass on every row, keeping every other column.
  const tmp = new Float32Array(ow * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < ow; x++) {
      const c = 2 * x;
      tmp[y * ow + x] =
        (data[row + refl(c - 2, w)] + 4 * data[row + refl(c - 1, w)] + 6 * data[row + refl(c, w)] + 4 * data[row + refl(c + 1, w)] + data[row + refl(c + 2, w)]) / 16;
    }
  }
  const out = new Float32Array(ow * oh);
  for (let y = 0; y < oh; y++) {
    const c = 2 * y;
    const r0 = refl(c - 2, h) * ow;
    const r1 = refl(c - 1, h) * ow;
    const r2 = refl(c, h) * ow;
    const r3 = refl(c + 1, h) * ow;
    const r4 = refl(c + 2, h) * ow;
    for (let x = 0; x < ow; x++) out[y * ow + x] = (tmp[r0 + x] + 4 * tmp[r1 + x] + 6 * tmp[r2 + x] + 4 * tmp[r3 + x] + tmp[r4 + x]) / 16;
  }
  return { width: ow, height: oh, data: out };
}

export function pyramid(img: GrayImage, levels: number): GrayImage[] {
  const out = [img];
  for (let l = 1; l < levels; l++) out.push(pyrDown(out[l - 1]));
  return out;
}

/** Sobel gradients divided by 8 (gray levels per px), zero on the border. */
function sobel(img: GrayImage): { gx: Float32Array; gy: Float32Array } {
  const { width: w, height: h, data: d } = img;
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      gx[i] = (d[i - w + 1] + 2 * d[i + 1] + d[i + w + 1] - d[i - w - 1] - 2 * d[i - 1] - d[i + w - 1]) / 8;
      gy[i] = (d[i + w - 1] + 2 * d[i + w] + d[i + w + 1] - d[i - w - 1] - 2 * d[i - w] - d[i - w + 1]) / 8;
    }
  }
  return { gx, gy };
}

/** The k-th smallest of the first n values (quickselect; reorders `a`). */
function select(a: Float64Array, n: number, k: number): number {
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const pivot = a[(lo + hi) >> 1];
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (a[i] < pivot) i++;
      while (a[j] > pivot) j--;
      if (i <= j) {
        const t = a[i];
        a[i] = a[j];
        a[j] = t;
        i++;
        j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else return a[k];
  }
  return a[k];
}

/**
 * What a fit may change, as a basis of the 8 homography parameters: all of them, the affine 6 (no change of
 * perspective), or a similarity (shift, rotation, uniform scale). A part-hidden surface may not hold all 8
 * (a laptop screen with its right edge under a hand has nothing to fix its width by): the fewer parameters are
 * solved on top of the motion so far, which carries the rest.
 */
export type FitModel = "perspective" | "affine" | "similarity";

const BASES: Record<FitModel, number[][]> = {
  perspective: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => [0, 1, 2, 3, 4, 5, 6, 7].map((j) => (i === j ? 1 : 0))),
  affine: [0, 1, 2, 3, 4, 5].map((i) => [0, 1, 2, 3, 4, 5, 6, 7].map((j) => (i === j ? 1 : 0))),
  // a: uniform scale, b: rotation, then the shift.
  similarity: [
    [1, 0, 0, 0, 1, 0, 0, 0],
    [0, -1, 0, 1, 0, 0, 0, 0],
    [0, 0, 1, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 1, 0, 0],
  ],
};

/** B^T A B (A is 8 x 8, the basis has m rows of 8). */
function reduceA(A: Float64Array, basis: number[][]): Float64Array {
  const m = basis.length;
  const out = new Float64Array(m * m);
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < m; j++) {
      let v = 0;
      for (let p = 0; p < 8; p++) {
        if (basis[i][p] === 0) continue;
        for (let q = 0; q < 8; q++) if (basis[j][q] !== 0) v += basis[i][p] * A[p * 8 + q] * basis[j][q];
      }
      out[i * m + j] = v;
    }
  }
  return out;
}

/** The m x m inverse expanded back to an 8 x 8 covariance: B^T (B A B^T)^-1 B. Null when singular. */
function expandInverse(Am: Float64Array, basis: number[][]): Float64Array | null {
  const m = basis.length;
  const inv = invertN(Am, m);
  if (!inv) return null;
  const out = new Float64Array(64);
  for (let p = 0; p < 8; p++) {
    for (let q = 0; q < 8; q++) {
      let v = 0;
      for (let i = 0; i < m; i++) {
        if (basis[i][p] === 0) continue;
        for (let j = 0; j < m; j++) if (basis[j][q] !== 0) v += basis[i][p] * inv[i * m + j] * basis[j][q];
      }
      out[p * 8 + q] = v;
    }
  }
  return out;
}

function invertN(A: Float64Array, n: number): Float64Array | null {
  const out = new Float64Array(n * n);
  const e = new Float64Array(n);
  for (let c = 0; c < n; c++) {
    e.fill(0);
    e[c] = 1;
    const col = solveN(A, e, n);
    if (!col) return null;
    for (let r = 0; r < n; r++) out[r * n + c] = col[r];
  }
  return out;
}

/** Solves the n x n system A x = b by Gaussian elimination with pivoting. Null when singular. */
function solveN(A: Float64Array, b: Float64Array, n: number): Float64Array | null {
  const m = new Float64Array(n * (n + 1));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) m[i * (n + 1) + j] = A[i * n + j];
    m[i * (n + 1) + n] = b[i];
  }
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r * (n + 1) + col]) > Math.abs(m[piv * (n + 1) + col])) piv = r;
    const pv = m[piv * (n + 1) + col];
    if (!(Math.abs(pv) > 1e-300)) return null;
    if (piv !== col) {
      for (let c = 0; c <= n; c++) {
        const t = m[col * (n + 1) + c];
        m[col * (n + 1) + c] = m[piv * (n + 1) + c];
        m[piv * (n + 1) + c] = t;
      }
    }
    for (let r = col + 1; r < n; r++) {
      const f = m[r * (n + 1) + col] / m[col * (n + 1) + col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) m[r * (n + 1) + c] -= f * m[col * (n + 1) + c];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = m[r * (n + 1) + n];
    for (let c = r + 1; c < n; c++) s -= m[r * (n + 1) + c] * x[c];
    x[r] = s / m[r * (n + 1) + r];
  }
  for (let i = 0; i < n; i++) if (!Number.isFinite(x[i])) return null;
  return x;
}



const scaleH = (H: Mat3, s: number): Mat3 => mulH(mulH([1 / s, 0, 0, 0, 1 / s, 0, 0, 0, 1], H), [s, 0, 0, 0, s, 0, 0, 0, 1]);
const unscaleH = (H: Mat3, s: number): Mat3 => mulH(mulH([s, 0, 0, 0, s, 0, 0, 0, 1], H), [1 / s, 0, 0, 0, 1 / s, 0, 0, 0, 1]);

// ---------- the aligner ----------

/**
 * The reference region, ready to align frames to. `mask` is the reference image's size, > 0 where the
 * surface is (the region minus anything excluded). Throws when the region has too little texture.
 */
export class RegionAligner {
  readonly levels: Level[] = [];
  readonly width: number;
  readonly height: number;
  /** Samples at the finest level. */
  readonly samples: number;
  /** The region's box at the finest level, image px: x0, y0, x1, y1. */
  readonly box: [number, number, number, number];
  /** How many images every frame is aligned in (luma alone, or luma and a screen's key). */
  readonly channels: number;
  /** The channels the verdict is read from. */
  readonly verdictChannels: number[];

  /**
   * `ref` is the reference frame, one image or one per channel (all the same size): with more than one,
   * every frame is aligned in all of them at once (see align).
   */
  constructor(ref: GrayImage | GrayImage[], mask: Float32Array, opts: RegionOptions = {}) {
    const refs = Array.isArray(ref) ? ref : [ref];
    if (refs.length < 1) throw new Error("no image to follow");
    const C = refs.length;
    const ref0 = refs[0];
    const maxSamples = Math.max(500, opts.maxSamples ?? 12000);
    this.width = ref0.width;
    this.height = ref0.height;
    this.channels = C;
    const vc = (opts.verdictChannels ?? []).filter((c) => Number.isInteger(c) && c >= 0 && c < C);
    this.verdictChannels = vc.length ? Array.from(new Set(vc)) : Array.from({ length: C }, (_, c) => c);
    // The region's box at level 0, for the normalization.
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    let area = 0;
    for (let y = 0; y < ref0.height; y++) {
      for (let x = 0; x < ref0.width; x++) {
        if (!(mask[y * ref0.width + x] > 0)) continue;
        area++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    if (area < 400) throw new Error(`the region covers ${area} px of the frame; it needs at least 400 (20 x 20)`);
    this.box = [x0, y0, x1, y1];
    // No level where the region is under 1000 px: there its texture is aliased away and the fit can settle on a
    // wrong place the finer levels cannot leave (a 140 x 100 px region failed with 4 levels, held with 3).
    let nLevels = Math.max(1, Math.min(6, opts.levels ?? 4));
    while (nLevels > 1 && area / 4 ** (nLevels - 1) < 1000) nLevels--;
    const pyrs = refs.map((r) => pyramid(r, nLevels));
    for (let l = 0; l < nLevels; l++) {
      const s = 2 ** l;
      const { width: w, height: h } = pyrs[0][l];
      const grads = pyrs.map((p) => sobel(p[l]));
      // The level's own mask: the level-0 pixel each level pixel sits on (pyrDown keeps pixel 2i). A large
      // region (a wall on a 4K plate) is looked at on a sparser grid, so the candidates stay near 8x the budget.
      const stride = Math.max(1, Math.floor(Math.sqrt(area / 4 ** l / (8 * maxSamples))));
      const cand: number[] = [];
      for (let y = 1; y < h - 1; y += stride) {
        const y0p = Math.min(ref0.height - 1, y * s);
        for (let x = 1; x < w - 1; x += stride) {
          const x0p = Math.min(ref0.width - 1, x * s);
          if (mask[y0p * ref0.width + x0p] > 0) cand.push(y * w + x);
        }
      }
      // Texture over every channel, each brought to the first one's scale (its 90th percentile edge), so a
      // channel with small values still picks its own edges.
      const scales = grads.map((g) => {
        const m = cand.map((i) => Math.hypot(g.gx[i], g.gy[i])).sort((a, b) => a - b);
        return Math.max(1e-6, m.length ? m[Math.floor(0.9 * (m.length - 1))] : 1);
      });
      const mag = new Float64Array(cand.length);
      for (let k = 0; k < cand.length; k++) {
        let v = 0;
        for (let c = 0; c < C; c++) v = Math.max(v, (Math.hypot(grads[c].gx[cand[k]], grads[c].gy[cand[k]]) * scales[0]) / scales[c]);
        mag[k] = v;
      }
      // The most textured pixels, but spread out: half the budget is shared by 16 x 16 cells over the region, the rest goes to the strongest anywhere.
      const budget = Math.min(cand.length, maxSamples);
      const picked = pickSpread(cand, mag, w, budget, [x0 / s, y0 / s, x1 / s, y1 / s]);
      const n = picked.length;
      if (l === 0 && n < 300) throw new Error(`the region has only ${n} usable pixels at full size`);
      const cx = (x0 + x1) / 2 / s;
      const cy = (y0 + y1) / 2 / s;
      const r = Math.max(4, Math.max(x1 - x0, y1 - y0) / 2 / s);
      const xs = new Float32Array(n);
      const ys = new Float32Array(n);
      const tvs = refs.map(() => new Float64Array(n));
      const Js = refs.map(() => new Float64Array(n * 8));
      const strongs = refs.map(() => new Uint8Array(n));
      let strong = 0;
      for (let k = 0; k < n; k++) {
        const i = picked[k];
        const x = i % w;
        const y = (i - x) / w;
        xs[k] = x;
        ys[k] = y;
        const xn = (x - cx) / r;
        const yn = (y - cy) / r;
        let best = 0;
        for (let c = 0; c < C; c++) {
          const g = grads[c];
          tvs[c][k] = pyrs[c][l].data[i];
          const gxn = g.gx[i] * r;
          const gyn = g.gy[i] * r;
          const d = gxn * xn + gyn * yn;
          const J = Js[c];
          const o = k * 8;
          J[o] = gxn * xn;
          J[o + 1] = gxn * yn;
          J[o + 2] = gxn;
          J[o + 3] = gyn * xn;
          J[o + 4] = gyn * yn;
          J[o + 5] = gyn;
          J[o + 6] = -xn * d;
          J[o + 7] = -yn * d;
          best = Math.max(best, (Math.hypot(g.gx[i], g.gy[i]) * scales[0]) / scales[c]);
          if (Math.hypot(g.gx[i], g.gy[i]) >= 1) strongs[c][k] = 1;
        }
        if (best >= 2) strong++;
      }
      if (l === 0 && strong < 150) throw new Error("the region is flat (almost no edges or texture to follow)");
      const N: Mat3 = [1 / r, 0, -cx / r, 0, 1 / r, -cy / r, 0, 0, 1];
      this.levels.push({ s, n, xs, ys, tv: tvs[0], J: Js[0], tvs, Js, strongs, N, Ninv: invertH(N) as Mat3, r });
    }
    this.samples = this.levels[0].n;
  }

  /** The frame's pyramids, one per channel, as align() wants them. */
  pyramids(frame: GrayImage | GrayImage[]): GrayImage[][] {
    const chans = Array.isArray(frame) ? frame : [frame];
    if (chans.length !== this.channels) throw new Error(`the frame has ${chans.length} channels, the region ${this.channels}`);
    return chans.map((c) => pyramid(c, this.levels.length));
  }

  /**
   * Aligns a frame starting from H0 (reference image px -> frame image px). `frame` is its pyramid
   * (`pyramid(frame, levels)`) for one channel, or one pyramid per channel (`pyramids`). Every channel is
   * fitted at the same points, each scaled by its own noise; a point counts by its residual over all of
   * them, so an occluder that looks like the surface in one channel (a hand's edge where a screen's edge
   * was, in the key) is pushed out by another (its brightness). `prior` is the last good frame's weights
   * (the occlusion memory). `fromLevel` starts at a finer level than the coarsest (for a refinement of a
   * motion that is already close). `model` limits what the fit may change on top of H0. `exclude` (per
   * level, per sample) leaves samples out of every iteration: what an occluder detector found covered.
   * Null with a reason when the region leaves the frame or the fit diverges.
   */
  align(
    frame: GrayImage[] | GrayImage[][],
    H0: Mat3,
    prior: Float32Array[] | null = null,
    fromLevel?: number,
    model: FitModel = "perspective",
    exclude: Uint8Array[] | null = null
  ): AlignResult | { failed: string } {
    const pyrs: GrayImage[][] = Array.isArray(frame[0]) ? (frame as GrayImage[][]) : [frame as GrayImage[]];
    const C = this.channels;
    if (pyrs.length !== C) return { failed: `the frame has ${pyrs.length} channels, the region ${C}` };
    const basis = BASES[model];
    const mdim = basis.length;
    const top = Math.min(this.levels.length - 1, fromLevel ?? this.levels.length - 1);
    let H = H0.slice();
    const weights: Float32Array[] = new Array(this.levels.length);
    let ncc = 0;
    let nccs: number[] = [];
    let coverage = 0;
    let visible = 0;
    let sigma = 0;
    let cov: Float64Array | null = null;
    let cells: CellAgreement = { textured: 0, matched: 0, span: [0, 0], pinned: 1, pinned_px: 0 };
    for (let l = top; l >= 0; l--) {
      const L = this.levels[l];
      const imgs = pyrs.map((p) => p[l]);
      if (imgs.some((im) => !im)) return { failed: "the frame has no image at this level" };
      const { width: w, height: h } = imgs[0];
      let Hl = scaleH(H, L.s);
      const n = L.n;
      const iters = l > 0 ? 40 : 25;
      const late = Math.floor((2 * iters) / 3);
      const pm = prior && prior[l] && prior[l].length === n ? prior[l] : null;
      const ex = exclude && exclude[l] && exclude[l].length === n ? exclude[l] : null;
      const ivs = imgs.map(() => new Float64Array(n));
      const es = imgs.map(() => new Float64Array(n));
      // ok: in the frame and not excluded (the samples the fit may use).
      const ok = new Uint8Array(n);
      let wgt: Float64Array | null = null;
      const abs = new Float64Array(n);
      const rr = new Float64Array(n);
      const A = new Float64Array(64);
      const bv = new Float64Array(8);
      const sc = new Float64Array(C);
      let okCount = 0;
      let inFrame = 0;
      let lastSig2 = 0;
      for (let it = 0; it < iters; it++) {
        // Warp the samples into the frame.
        okCount = 0;
        inFrame = 0;
        const [h0, h1, h2, h3, h4, h5, h6, h7, h8] = Hl;
        for (let k = 0; k < n; k++) {
          const x = L.xs[k];
          const y = L.ys[k];
          const z = h6 * x + h7 * y + h8;
          if (!(Math.abs(z) > 1e-9) || !Number.isFinite(z)) return { failed: "the fit diverged" };
          const u = (h0 * x + h1 * y + h2) / z;
          const v = (h3 * x + h4 * y + h5) / z;
          if (!(u >= 0 && v >= 0 && u < w - 1 && v < h - 1)) {
            ok[k] = 0;
            continue;
          }
          inFrame++;
          if (ex && ex[k]) {
            ok[k] = 0;
            continue;
          }
          const ix = Math.floor(u);
          const iy = Math.floor(v);
          const fx = u - ix;
          const fy = v - iy;
          const p = iy * w + ix;
          for (let c = 0; c < C; c++) {
            const data = imgs[c].data;
            ivs[c][k] = (data[p] * (1 - fx) + data[p + 1] * fx) * (1 - fy) + (data[p + w] * (1 - fx) + data[p + w + 1] * fx) * fy;
          }
          ok[k] = 1;
          okCount++;
        }
        if (inFrame < Math.min(200, 0.3 * n)) return { failed: "the region is out of the frame" };
        if (okCount < Math.min(150, 0.1 * n)) return { failed: `the surface is covered: ${Math.round((100 * (inFrame - okCount)) / Math.max(1, inFrame))}% of what is in the frame is hidden by something in front` };
        // Per channel: gain and bias from the samples the last iteration trusted (an occluder must not set
        // the exposure), the residuals, and their robust scale over the samples still trusted.
        let sw0 = 0;
        if (wgt) for (let k = 0; k < n; k++) if (ok[k]) sw0 += wgt[k];
        const useW = wgt !== null && sw0 >= 100;
        for (let c = 0; c < C; c++) {
          const tv = L.tvs[c];
          const iv = ivs[c];
          const e = es[c];
          let sw = 0;
          let st = 0;
          let si = 0;
          for (let k = 0; k < n; k++) {
            if (!ok[k]) continue;
            const ww = useW ? (wgt as Float64Array)[k] : 1;
            sw += ww;
            st += ww * tv[k];
            si += ww * iv[k];
          }
          const mt = st / sw;
          const mi = si / sw;
          let vt = 0;
          let cti = 0;
          for (let k = 0; k < n; k++) {
            if (!ok[k]) continue;
            const ww = useW ? (wgt as Float64Array)[k] : 1;
            vt += ww * (tv[k] - mt) ** 2;
            cti += ww * (tv[k] - mt) * (iv[k] - mi);
          }
          let g = cti / Math.max(vt, 1e-6);
          if (!(g > 0.3 && g < 3)) g = 1;
          const b = mi - g * mt;
          // The noise scale from the samples on an edge only: a flat sample's residual is always small, and on a
          // flat screen (half its samples flat) they made the scale so tight that an edge a pixel off was thrown
          // out as an outlier, and with it the only thing that could bring the fit back (a synthetic screen
          // settled 1.8 px off).
          const st2 = L.strongs[c];
          let na = 0;
          for (let k = 0; k < n; k++) {
            if (!ok[k]) {
              e[k] = 0;
              continue;
            }
            e[k] = (iv[k] - b) / g - tv[k];
            if (st2[k] && (!wgt || wgt[k] > 0)) abs[na++] = Math.abs(e[k]);
          }
          if (na < 100) {
            na = 0;
            for (let k = 0; k < n; k++) if (ok[k] && st2[k]) abs[na++] = Math.abs(e[k]);
          }
          if (na < 100) {
            na = 0;
            for (let k = 0; k < n; k++) if (ok[k]) abs[na++] = Math.abs(e[k]);
          }
          const sig = 1.4826 * select(abs, na, na >> 1) + 1e-3;
          sc[c] = Math.max(sig, 1);
          if (c === 0) sigma = sig;
        }
        // One residual per point over the channels, each in its own noise; Tukey on that.
        for (let k = 0; k < n; k++) {
          if (!ok[k]) {
            rr[k] = 0;
            continue;
          }
          let q = 0;
          for (let c = 0; c < C; c++) q += (es[c][k] / sc[c]) ** 2;
          rr[k] = Math.sqrt(q / C);
        }
        const kk = 4.685;
        if (!wgt) wgt = new Float64Array(n);
        const masking = pm !== null && it < late;
        let pmCount = 0;
        if (masking) for (let k = 0; k < n; k++) if (ok[k] && pm![k] > 0.25) pmCount++;
        const usePrior = masking && pmCount > 150;
        A.fill(0);
        bv.fill(0);
        let sw2 = 0;
        let se2 = 0;
        for (let k = 0; k < n; k++) {
          let ww = 0;
          if (ok[k] && rr[k] < kk) {
            const q = rr[k] / kk;
            ww = (1 - q * q) ** 2;
          }
          // The occlusion memory zeroes the weight itself, so the next iteration's gain, bias and scale leave those samples out too.
          if (usePrior && !(pm![k] > 0.25)) ww = 0;
          wgt[k] = ww;
          if (ww === 0) continue;
          const o = k * 8;
          for (let c = 0; c < C; c++) {
            const J = L.Js[c];
            const inv2 = 1 / (sc[c] * sc[c]);
            const ek = es[c][k];
            for (let i = 0; i < 8; i++) {
              const ji = J[o + i] * ww * inv2;
              bv[i] += ji * ek;
              for (let j = i; j < 8; j++) A[i * 8 + j] += ji * J[o + j];
            }
          }
          sw2 += ww;
          se2 += ww * rr[k] * rr[k];
        }
        for (let i = 0; i < 8; i++) {
          for (let j = 0; j < i; j++) A[i * 8 + j] = A[j * 8 + i];
          A[i * 8 + i] += 1e-6;
        }
        lastSig2 = sw2 > 8 ? se2 / sw2 : 0;
        const Am = reduceA(A, basis);
        const bm = new Float64Array(mdim);
        for (let i = 0; i < mdim; i++) for (let p = 0; p < 8; p++) bm[i] += basis[i][p] * bv[p];
        const dm = solveN(Am, bm, mdim);
        if (!dm) return { failed: "the fit is singular (the region has texture in one direction only)" };
        const dp = new Float64Array(8);
        for (let i = 0; i < mdim; i++) for (let p = 0; p < 8; p++) dp[p] += basis[i][p] * dm[i];
        const Wn: Mat3 = [1 + dp[0], dp[1], dp[2], dp[3], 1 + dp[4], dp[5], dp[6], dp[7], 1];
        const Wp = mulH(L.Ninv, mulH(Wn, L.N));
        const Wi = invertH(Wp);
        if (!Wi) return { failed: "the fit is singular" };
        Hl = mulH(Hl, Wi);
        if (!(Math.abs(Hl[8]) > 1e-12)) return { failed: "the fit diverged" };
        Hl = Hl.map((v) => v / Hl[8]);
        let step = 0;
        for (let i = 0; i < 8; i++) step = Math.max(step, Math.abs(dp[i]));
        if (step < 1e-4 && !(masking && usePrior)) break;
      }
      const wf = new Float32Array(n);
      let kept = 0;
      for (let k = 0; k < n; k++) {
        wf[k] = wgt ? wgt[k] : 0;
        if (ok[k] && wf[k] > 0.5) kept++;
      }
      weights[l] = wf;
      H = unscaleH(Hl, L.s);
      visible = inFrame / n;
      // Over what is in the frame, the covered part included: a surface mostly hidden keeps little of it.
      coverage = inFrame > 0 ? kept / inFrame : 0;
      if (l === 0) {
        // The verdict: correlation of the reference with the warped frame over the samples the fit kept, the mean over the verdict channels.
        let sum = 0;
        const perC: number[] = [];
        for (let c = 0; c < C; c++) {
          let sa = 0;
          let sb = 0;
          let saa = 0;
          let sbb = 0;
          let sab = 0;
          for (let k = 0; k < n; k++) {
            if (!(ok[k] && wf[k] > 0.5)) continue;
            const a = L.tvs[c][k];
            const b2 = ivs[c][k];
            sa += a;
            sb += b2;
            saa += a * a;
            sbb += b2 * b2;
            sab += a * b2;
          }
          let r = 0;
          if (kept > 50) {
            const va = saa - (sa * sa) / kept;
            const vb = sbb - (sb * sb) / kept;
            r = va > 1e-9 && vb > 1e-9 ? (sab - (sa * sb) / kept) / Math.sqrt(va * vb) : 0;
          }
          sum += r;
          perC.push(r);
        }
        ncc = this.verdictChannels.reduce((t, c) => t + perC[c], 0) / this.verdictChannels.length;
        nccs = perC;
        const inv = expandInverse(reduceA(A, basis), basis);
        cov = inv ? inv.map((v) => v * lastSig2) : null;
        const ca = this.cellAgreement(L, ok, ivs, this.verdictChannels);
        // The agreeing cells' own grip on the motion, against the whole fit's, at the region's corners.
        const am = new Float64Array(64);
        for (let k = 0; k < n; k++) {
          if (!(ok[k] && wf[k] > 0.5 && ca.agree[this.cellOf(k)])) continue;
          const o = k * 8;
          for (let c = 0; c < C; c++) {
            const J = L.Js[c];
            const f = wf[k] / (sc[c] * sc[c]);
            for (let i = 0; i < 8; i++) for (let j = i; j < 8; j++) am[i * 8 + j] += f * J[o + i] * J[o + j];
          }
        }
        for (let i = 0; i < 8; i++) {
          for (let j = 0; j < i; j++) am[i * 8 + j] = am[j * 8 + i];
          am[i * 8 + i] += 1e-6;
        }
        const invm = expandInverse(reduceA(am, basis), basis);
        const [bx0, by0, bx1, by1] = this.box;
        const corners: Vec2[] = [[bx0, by0], [bx1, by0], [bx1, by1], [bx0, by1]];
        const whole = cov ? this.errorFromCov(cov, H, corners) : null;
        const part = invm ? this.errorFromCov(invm.map((v) => v * lastSig2), H, corners) : null;
        const pinned = whole && part !== null && whole > 0 ? part / whole : ca.matched ? 1 : Infinity;
        cells = { textured: ca.textured, matched: ca.matched, span: ca.span, pinned: Number.isFinite(pinned) ? pinned : 1e9, pinned_px: part === null ? 1e9 : REGION_ERROR_SCALE * part };
      }
    }
    // Levels above `top` keep no weights; the occlusion memory needs all of them.
    for (let l = 0; l < this.levels.length; l++) if (!weights[l]) weights[l] = new Float32Array(this.levels[l].n).fill(1);
    return { H, ncc, nccs, coverage, visible, sigma, weights, cov, cells };
  }

  private cellOf(k: number): number {
    const L = this.levels[0];
    const G = CELL_GRID;
    const [x0, y0, x1, y1] = this.box;
    const cw = Math.max(1, (x1 - x0 + 1) / G);
    const ch = Math.max(1, (y1 - y0 + 1) / G);
    const cx = Math.min(G - 1, Math.max(0, Math.floor((L.xs[k] - x0) / cw)));
    const cy = Math.min(G - 1, Math.max(0, Math.floor((L.ys[k] - y0) / ch)));
    return cy * G + cx;
  }

  /**
   * Per cell and channel: the reference samples' spread and their correlation with the frame. A cell is
   * textured when any channel varies in it; it agrees when every channel that varies there correlates.
   */
  private cellAgreement(L: Level, ok: Uint8Array, ivs: Float64Array[], chans: number[]): { textured: number; matched: number; span: [number, number]; agree: Uint8Array } {
    const G = CELL_GRID;
    const C = chans.length;
    const [x0, y0, x1, y1] = this.box;
    const cw = Math.max(1, (x1 - x0 + 1) / G);
    const ch = Math.max(1, (y1 - y0 + 1) / G);
    const acc = new Float64Array(G * G * C * 6);
    const agree = new Uint8Array(G * G);
    for (let k = 0; k < L.n; k++) {
      if (!ok[k]) continue;
      const cx = Math.min(G - 1, Math.max(0, Math.floor((L.xs[k] - x0) / cw)));
      const cy = Math.min(G - 1, Math.max(0, Math.floor((L.ys[k] - y0) / ch)));
      for (let c = 0; c < C; c++) {
        const o = ((cy * G + cx) * C + c) * 6;
        const a = L.tvs[chans[c]][k];
        const b = ivs[chans[c]][k];
        acc[o] += 1;
        acc[o + 1] += a;
        acc[o + 2] += b;
        acc[o + 3] += a * a;
        acc[o + 4] += b * b;
        acc[o + 5] += a * b;
      }
    }
    let textured = 0;
    let matched = 0;
    let tx0 = G;
    let tx1 = -1;
    let ty0 = G;
    let ty1 = -1;
    let mx0 = G;
    let mx1 = -1;
    let my0 = G;
    let my1 = -1;
    for (let cell = 0; cell < G * G; cell++) {
      let anyTex = false;
      let allAgree = true;
      for (let c = 0; c < C; c++) {
        const o = (cell * C + c) * 6;
        const n = acc[o];
        if (n < 20) continue;
        const va = acc[o + 3] - (acc[o + 1] * acc[o + 1]) / n;
        if (!(Math.sqrt(Math.max(0, va) / n) >= CELL_MIN_STD)) continue;
        anyTex = true;
        const vb = acc[o + 4] - (acc[o + 2] * acc[o + 2]) / n;
        const r = vb > 1e-9 ? (acc[o + 5] - (acc[o + 1] * acc[o + 2]) / n) / Math.sqrt(va * vb) : 0;
        if (!(r >= CELL_NCC)) allAgree = false;
      }
      if (!anyTex) continue;
      textured++;
      const cx = cell % G;
      const cy = (cell - cx) / G;
      tx0 = Math.min(tx0, cx);
      tx1 = Math.max(tx1, cx);
      ty0 = Math.min(ty0, cy);
      ty1 = Math.max(ty1, cy);
      if (allAgree) {
        matched++;
        agree[cell] = 1;
        mx0 = Math.min(mx0, cx);
        mx1 = Math.max(mx1, cx);
        my0 = Math.min(my0, cy);
        my1 = Math.max(my1, cy);
      }
    }
    if (!matched) return { textured, matched, span: [0, 0], agree };
    return { textured, matched, span: [(mx1 - mx0 + 1) / (tx1 - tx0 + 1), (my1 - my0 + 1) / (ty1 - ty0 + 1)], agree };
  }

  /**
   * How far the solved surface is likely off at `targets` (reference image px), px: the fit's parameter
   * covariance carried to each point through the motion, its mean. Neighbouring pixels' residuals are
   * not independent, so this runs below the true error; `REGION_ERROR_SCALE` (calibrated on real plates)
   * scales it.
   */
  expectedError(res: AlignResult, targets: Vec2[]): number | null {
    if (!res.cov || targets.length === 0) return null;
    const raw = this.errorFromCov(res.cov, res.H, targets);
    return raw === null ? null : REGION_ERROR_SCALE * raw;
  }

  /** The mean over `targets` of the error a parameter covariance gives, px, uncalibrated. */
  private errorFromCov(cov: Float64Array, H: Mat3, targets: Vec2[]): number | null {
    const L = this.levels[0];
    let sum = 0;
    for (const t of targets) {
      const xn = (t[0] * L.N[0] + L.N[2]);
      const yn = (t[1] * L.N[4] + L.N[5]);
      // dW/dp at p = 0 (normalized coordinates), times r for reference px.
      const dx = [xn, yn, 1, 0, 0, 0, -xn * xn, -xn * yn].map((v) => v * L.r);
      const dy = [0, 0, 0, xn, yn, 1, -xn * yn, -yn * yn].map((v) => v * L.r);
      // The motion's Jacobian at t carries a reference displacement into the frame.
      const z = H[6] * t[0] + H[7] * t[1] + H[8];
      if (!(Math.abs(z) > 1e-9)) return null;
      const u = (H[0] * t[0] + H[1] * t[1] + H[2]) / z;
      const v = (H[3] * t[0] + H[4] * t[1] + H[5]) / z;
      const j00 = (H[0] - u * H[6]) / z;
      const j01 = (H[1] - u * H[7]) / z;
      const j10 = (H[3] - v * H[6]) / z;
      const j11 = (H[4] - v * H[7]) / z;
      const m0 = new Float64Array(8);
      const m1 = new Float64Array(8);
      for (let i = 0; i < 8; i++) {
        m0[i] = j00 * dx[i] + j01 * dy[i];
        m1[i] = j10 * dx[i] + j11 * dy[i];
      }
      let var0 = 0;
      for (let i = 0; i < 8; i++) {
        for (let j = 0; j < 8; j++) var0 += (m0[i] * m0[j] + m1[i] * m1[j]) * cov[i * 8 + j];
      }
      sum += Math.sqrt(Math.max(0, var0));
    }
    return Number.isFinite(sum) ? sum / targets.length : null;
  }
}

/**
 * expectedError's covariance, times this, is the error measured on real plates (four Hollywood Camera Work
 * plates against independently solved corners, 2026-11-27): the true corner error over the raw estimate
 * had a median of 10-12 on textured surfaces (a truck, a licence plate) and 25-29 on mostly flat ones (a
 * green board, a laptop's green screen), where neighbouring residuals are least independent. Set for the
 * textured case: on a flat surface the true error runs about 2.5 times expected_px.
 */
export const REGION_ERROR_SCALE = 12;

/** Half the budget shared by a 16 x 16 grid of cells over the box, the rest by strength; flat pixels last. */
function pickSpread(cand: number[], mag: Float64Array, w: number, budget: number, box: number[]): number[] {
  if (cand.length <= budget) return cand.slice();
  const [bx0, by0, bx1, by1] = box;
  const G = 16;
  const cw = Math.max(1, (bx1 - bx0 + 1) / G);
  const ch = Math.max(1, (by1 - by0 + 1) / G);
  const order = Array.from(cand.keys()).sort((a, b) => mag[b] - mag[a]);
  const cells = new Map<number, number>();
  for (const k of order) {
    const i = cand[k];
    const x = i % w;
    const y = (i - x) / w;
    const c = Math.min(G - 1, Math.max(0, Math.floor((y - by0) / ch))) * G + Math.min(G - 1, Math.max(0, Math.floor((x - bx0) / cw)));
    cells.set(c, (cells.get(c) ?? 0) + 1);
  }
  const perCell = Math.max(1, Math.floor(budget / 2 / Math.max(1, cells.size)));
  const used = new Uint8Array(cand.length);
  const count = new Map<number, number>();
  const out: number[] = [];
  for (const k of order) {
    if (out.length >= budget) break;
    if (!(mag[k] > 0.5)) break;
    const i = cand[k];
    const x = i % w;
    const y = (i - x) / w;
    const c = Math.min(G - 1, Math.max(0, Math.floor((y - by0) / ch))) * G + Math.min(G - 1, Math.max(0, Math.floor((x - bx0) / cw)));
    const got = count.get(c) ?? 0;
    if (got >= perCell) continue;
    count.set(c, got + 1);
    used[k] = 1;
    out.push(i);
  }
  for (const k of order) {
    if (out.length >= budget) break;
    if (used[k]) continue;
    used[k] = 1;
    out.push(cand[k]);
  }
  return out;
}

// ---------- what is in front ----------

/** A frame's colours as rendered: RGBA, 8 bits a channel. */
export interface ColorImage {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

export interface OccluderMap {
  /** Per detector point, 1 where the frame does not show the surface (the margin included). */
  flags: Uint8Array;
  /** Share of the surface's points in the frame that are flagged, margin included. */
  share: number;
  /** The same before the margin: what was found. */
  found: number;
  /** Detector points in the frame. */
  inFrame: number;
}

/** Fewer points than this in one piece are noise, not something in front. */
export const OCCLUDER_MIN_POINTS = 6;
/** Points all round what was found that are left out too (its soft edge, motion blur, and the motion not being exact yet). */
export const OCCLUDER_MARGIN = 2;
/** Over this share of the surface flagged, the map is not used: the motion is too far off to look with, or the surface is gone. */
export const OCCLUDER_MAX_SHARE = 0.6;

type Integral = { x0: number; y0: number; w: number; h: number; s: Float64Array[] };

/** Summed-area tables of R, G and B over [x0, x1] x [y0, y1] (inclusive). */
function integralRgb(img: ColorImage, x0: number, y0: number, x1: number, y1: number): Integral {
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const W = w + 1;
  const s = [new Float64Array(W * (h + 1)), new Float64Array(W * (h + 1)), new Float64Array(W * (h + 1))];
  const d = img.data;
  for (let y = 0; y < h; y++) {
    let r0 = 0;
    let r1 = 0;
    let r2 = 0;
    const row = (y0 + y) * img.width;
    const o1 = (y + 1) * W;
    const o0 = y * W;
    for (let x = 0; x < w; x++) {
      const i = (row + x0 + x) * 4;
      r0 += d[i];
      r1 += d[i + 1];
      r2 += d[i + 2];
      s[0][o1 + x + 1] = s[0][o0 + x + 1] + r0;
      s[1][o1 + x + 1] = s[1][o0 + x + 1] + r1;
      s[2][o1 + x + 1] = s[2][o0 + x + 1] + r2;
    }
  }
  return { x0, y0, w, h, s };
}

/** The mean of channel c over the box [xa, xb] x [ya, yb] (image px, inclusive), clamped to the table. */
function boxMean(I: Integral, c: number, xa: number, ya: number, xb: number, yb: number): number {
  const a = Math.max(0, xa - I.x0);
  const b = Math.max(0, ya - I.y0);
  const e = Math.min(I.w - 1, xb - I.x0);
  const f = Math.min(I.h - 1, yb - I.y0);
  if (e < a || f < b) return NaN;
  const W = I.w + 1;
  const s = I.s[c];
  return (s[(f + 1) * W + e + 1] - s[b * W + e + 1] - s[(f + 1) * W + a] + s[b * W + a]) / ((e - a + 1) * (f - b + 1));
}

/**
 * What is in front of a keyable screen (a green or blue one), found by its colour before the fit uses
 * the frame. A flat screen is followed by its edges only, and the edge of a hand over it is the same step
 * from the key colour to something else: the fit takes it for the screen's own edge and bends (measured
 * on a laptop: a corner 30 px in while a hand crossed). The region is cut into a grid of about 80 points
 * across; the points that are the key colour in the reference frame are looked at (an 8-bit box mean)
 * where the motion puts them in each frame, and one with no key colour at its place or one grid step to
 * any side (so a motion a few px off does not count) has something in front. Pieces of OCCLUDER_MIN_POINTS
 * points or more, grown by OCCLUDER_MARGIN points all round, are left out of the fit (align's `exclude`),
 * their edges with them. The rest of the region (the bezel, the rim) may change its look as it likes.
 *
 * Only for a key: on a textured surface the fit's own weights already push what is in front out (a
 * person crossing a truck's side: 189 of 189 frames within 0.9 px), and a detector there was measured to
 * do harm: comparing colours with the reference frame, a motion gone wrong made a board's marks land off
 * their places, the detector took them for something in front, and the fit kept the wrong place without
 * the marks that could have corrected it; looking for colours the surface has nowhere left frames 16 px
 * off that nothing caught.
 */
export class OccluderDetector {
  /** Grid step, reference image px. */
  readonly step: number;
  readonly points: number;
  private readonly gw: number;
  private readonly gh: number;
  private readonly cellOfPoint: Int32Array;
  private readonly px: Float32Array;
  private readonly py: Float32Array;
  /** The points that are the key colour in the reference frame. */
  private readonly keyed: Uint8Array;
  /** Per aligner level, per sample: the point it falls on, or -1. */
  private readonly sampleCell: Int32Array[];

  /** `keyAlpha`: how much a colour (0-255 each) is still the key, 0..1 (screen-track.ts keyPresenceOf). */
  constructor(
    refImg: ColorImage,
    mask: Float32Array,
    aligner: RegionAligner,
    private readonly keyAlpha: (r: number, g: number, b: number) => number
  ) {
    const [bx0, by0, bx1, by1] = aligner.box;
    const side = Math.max(bx1 - bx0 + 1, by1 - by0 + 1);
    const step = Math.max(3, Math.round(side / 80));
    this.step = step;
    const gw = Math.max(1, Math.ceil((bx1 - bx0 + 1) / step));
    const gh = Math.max(1, Math.ceil((by1 - by0 + 1) / step));
    this.gw = gw;
    this.gh = gh;
    const W = refImg.width;
    const H = refImg.height;
    const inMask = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && mask[Math.round(y) * W + Math.round(x)] > 0;
    const cellPoint = new Int32Array(gw * gh).fill(-1);
    const xs: number[] = [];
    const ys: number[] = [];
    const cells: number[] = [];
    const half = Math.floor(step / 2);
    for (let j = 0; j < gh; j++) {
      for (let i = 0; i < gw; i++) {
        const x = Math.min(W - 1, bx0 + i * step + half);
        const y = Math.min(H - 1, by0 + j * step + half);
        // A cell belongs to the region when its centre or a corner of its block does.
        const xa = bx0 + i * step;
        const ya = by0 + j * step;
        const xb = Math.min(W - 1, xa + step - 1);
        const yb = Math.min(H - 1, ya + step - 1);
        if (!(inMask(x, y) || inMask(xa, ya) || inMask(xb, ya) || inMask(xa, yb) || inMask(xb, yb))) continue;
        cellPoint[j * gw + i] = xs.length;
        xs.push(x);
        ys.push(y);
        cells.push(j * gw + i);
      }
    }
    this.cellOfPoint = Int32Array.from(cells);
    this.points = xs.length;
    this.px = Float32Array.from(xs);
    this.py = Float32Array.from(ys);
    const I = integralRgb(refImg, Math.max(0, bx0 - step), Math.max(0, by0 - step), Math.min(W - 1, bx1 + step), Math.min(H - 1, by1 + step));
    this.keyed = new Uint8Array(this.points);
    for (let p = 0; p < this.points; p++) {
      const m = [0, 1, 2].map((c) => boxMean(I, c, xs[p] - half, ys[p] - half, xs[p] + half, ys[p] + half));
      if (keyAlpha(m[0], m[1], m[2]) >= 0.9) this.keyed[p] = 1;
    }
    this.sampleCell = aligner.levels.map((L) => {
      const out = new Int32Array(L.n).fill(-1);
      for (let k = 0; k < L.n; k++) {
        const i = Math.floor((L.xs[k] * L.s - bx0) / step);
        const j = Math.floor((L.ys[k] * L.s - by0) / step);
        if (i >= 0 && j >= 0 && i < gw && j < gh) out[k] = cellPoint[j * gw + i];
      }
      return out;
    });
  }

  /** Where the frame (as rendered) has something in front of the key, with H (reference image px -> frame image px) the motion to look with. */
  detect(frame: ColorImage, H: Mat3): OccluderMap {
    const n = this.points;
    const W = frame.width;
    const Hh = frame.height;
    const qx = new Int32Array(n);
    const qy = new Int32Array(n);
    const hb = new Int32Array(n);
    const sh = new Int32Array(n);
    const inside = new Uint8Array(n);
    let inFrame = 0;
    let fx0 = Infinity;
    let fy0 = Infinity;
    let fx1 = -Infinity;
    let fy1 = -Infinity;
    const [h0, h1, h2, h3, h4, h5, h6, h7, h8] = H;
    for (let p = 0; p < n; p++) {
      const x = this.px[p];
      const y = this.py[p];
      const z = h6 * x + h7 * y + h8;
      if (!(z > 1e-9)) continue;
      const u = (h0 * x + h1 * y + h2) / z;
      const v = (h3 * x + h4 * y + h5) / z;
      // The local scale: a box of one grid step in the reference is this big in the frame.
      const det = ((h0 - u * h6) * (h4 - v * h7) - (h1 - u * h7) * (h3 - v * h6)) / (z * z);
      const k = Math.sqrt(Math.abs(det));
      if (!Number.isFinite(k) || k <= 0) continue;
      const b = Math.max(1, Math.round((this.step * k) / 2));
      const t = Math.max(1, Math.round(this.step * k));
      const reach = b + t;
      const iu = Math.round(u);
      const iv = Math.round(v);
      if (iu - reach < 0 || iv - reach < 0 || iu + reach > W - 1 || iv + reach > Hh - 1) continue;
      inside[p] = 1;
      inFrame++;
      qx[p] = iu;
      qy[p] = iv;
      hb[p] = b;
      sh[p] = t;
      fx0 = Math.min(fx0, iu - reach);
      fy0 = Math.min(fy0, iv - reach);
      fx1 = Math.max(fx1, iu + reach);
      fy1 = Math.max(fy1, iv + reach);
    }
    if (inFrame < OCCLUDER_MIN_POINTS * 4) return { flags: new Uint8Array(n), share: 0, found: 0, inFrame };
    const I = integralRgb(frame, fx0, fy0, fx1, fy1);
    const cand = new Uint8Array(this.gw * this.gh);
    for (let p = 0; p < n; p++) {
      if (!inside[p] || !this.keyed[p]) continue;
      let gone = true;
      for (let dy = -1; dy <= 1 && gone; dy++) {
        for (let dx = -1; dx <= 1 && gone; dx++) {
          const cx = qx[p] + dx * sh[p];
          const cy = qy[p] + dy * sh[p];
          const m = [0, 1, 2].map((c) => boxMean(I, c, cx - hb[p], cy - hb[p], cx + hb[p], cy + hb[p]));
          if (this.keyAlpha(m[0], m[1], m[2]) >= 0.5) gone = false;
        }
      }
      if (gone) cand[this.cellOfPoint[p]] = 1;
    }
    return this.piecesOf(cand, inside, inFrame);
  }

  /** Pieces (8-connected) of OCCLUDER_MIN_POINTS or more among the candidates, grown by the margin. */
  private piecesOf(cand: Uint8Array, inside: Uint8Array, inFrame: number): OccluderMap {
    const n = this.points;
    const flags = new Uint8Array(n);
    const keep = new Uint8Array(this.gw * this.gh);
    const seen = new Uint8Array(this.gw * this.gh);
    const stack: number[] = [];
    let found = 0;
    for (let c0 = 0; c0 < cand.length; c0++) {
      if (!cand[c0] || seen[c0]) continue;
      const piece: number[] = [];
      stack.push(c0);
      seen[c0] = 1;
      while (stack.length) {
        const c = stack.pop() as number;
        piece.push(c);
        const ci = c % this.gw;
        const cj = (c - ci) / this.gw;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const i = ci + di;
            const j = cj + dj;
            if (i < 0 || j < 0 || i >= this.gw || j >= this.gh) continue;
            const d = j * this.gw + i;
            if (cand[d] && !seen[d]) {
              seen[d] = 1;
              stack.push(d);
            }
          }
        }
      }
      if (piece.length >= OCCLUDER_MIN_POINTS) {
        for (const c of piece) keep[c] = 1;
        found += piece.length;
      }
    }
    // The margin.
    let flagged = 0;
    for (let p = 0; p < n; p++) {
      const c = this.cellOfPoint[p];
      const ci = c % this.gw;
      const cj = (c - ci) / this.gw;
      let hit = 0;
      for (let dj = -OCCLUDER_MARGIN; dj <= OCCLUDER_MARGIN && !hit; dj++) {
        for (let di = -OCCLUDER_MARGIN; di <= OCCLUDER_MARGIN && !hit; di++) {
          const i = ci + di;
          const j = cj + dj;
          if (i >= 0 && j >= 0 && i < this.gw && j < this.gh && keep[j * this.gw + i]) hit = 1;
        }
      }
      flags[p] = hit;
      if (hit && inside[p]) flagged++;
    }
    return { flags, share: flagged / inFrame, found: found / inFrame, inFrame };
  }

  /** The samples a map covers, per aligner level (align's `exclude`). */
  sampleMask(map: OccluderMap): Uint8Array[] {
    return this.sampleCell.map((cells) => {
      const out = new Uint8Array(cells.length);
      for (let k = 0; k < cells.length; k++) if (cells[k] >= 0 && map.flags[cells[k]]) out[k] = 1;
      return out;
    });
  }

  /** Points flagged in one map and not the other. */
  static differ(a: OccluderMap | null, b: OccluderMap | null): number {
    if (!a || !b) return a === b ? 0 : Math.max(a?.flags.length ?? 0, b?.flags.length ?? 0);
    let d = 0;
    for (let p = 0; p < a.flags.length; p++) if (a.flags[p] !== b.flags[p]) d++;
    return d;
  }
}

/**
 * A matte drawn by hand (a layer the user rotoscoped over what is in front: its alpha, frame image px, 0-255)
 * as align's `exclude`: per level, the samples that land (through H) within `marginPx` of the matte's
 * opaque part (over half). For what no detector finds: something in front with the surface's colours, or a
 * textured surface whose occluder pulls the fit anyway.
 */
export function matteExclude(aligner: RegionAligner, matte: GrayImage, H: Mat3, marginPx: number): Uint8Array[] {
  const { width: w, height: h, data } = matte;
  // Summed-area table of the opaque part, so "anything opaque within the margin" is one look per sample.
  const W = w + 1;
  const sat = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += data[y * w + x] > 127 ? 1 : 0;
      sat[(y + 1) * W + x + 1] = sat[y * W + x + 1] + row;
    }
  }
  const r = Math.max(0, Math.round(marginPx));
  const any = (u: number, v: number) => {
    const a = Math.max(0, Math.round(u) - r);
    const b = Math.max(0, Math.round(v) - r);
    const e = Math.min(w - 1, Math.round(u) + r);
    const f = Math.min(h - 1, Math.round(v) + r);
    if (e < a || f < b) return false;
    return sat[(f + 1) * W + e + 1] - sat[b * W + e + 1] - sat[(f + 1) * W + a] + sat[b * W + a] > 0;
  };
  return aligner.levels.map((L) => {
    const out = new Uint8Array(L.n);
    for (let k = 0; k < L.n; k++) {
      const p = applyH(H, [L.xs[k] * L.s, L.ys[k] * L.s]);
      if (p && any(p[0], p[1])) out[k] = 1;
    }
    return out;
  });
}

/** Either exclusion (per level, per sample); null when neither has one. */
function unionExclude(a: Uint8Array[] | null, b: Uint8Array[] | null): Uint8Array[] | null {
  if (!a) return b;
  if (!b) return a;
  return a.map((x, l) => x.map((v, k) => (v || b[l][k] ? 1 : 0)));
}

// ---------- the tracker ----------

export interface RegionStep {
  ok: boolean;
  /** Reference image px -> frame image px; the held motion when the frame failed. */
  H: Mat3;
  ncc: number | null;
  coverage: number | null;
  /** Expected error over the quad, image px. */
  expected_px: number | null;
  cells: CellAgreement | null;
  /** What the frame was solved with: all 8 parameters, or fewer on top of the motion so far. */
  model: FitModel | null;
  /** Share of the surface in the frame that the occluder detector left out (null without one). */
  occluded: number | null;
  note?: string;
  /** Frames in a row without a verdict, this one included. */
  misses: number;
  /** The surface's own points against the solved motion (surface-points.ts), when they were checked. */
  points?: SurfacePointsCheck;
}

/**
 * One direction of a region track: frames in order, away from the reference frame. Starts from the
 * last two good frames' motion (carried on at the same speed); a frame that fails is retried from the last
 * good motion. When the visible part cannot hold all 8 parameters (part of the surface hidden), the frame
 * is solved as an affine, then a similarity, on top of the predicted motion, which carries the rest; only
 * a frame none of these line up is reported and held.
 *
 * With an occluder detector (and the frame's colours), what is in front of a key is found where the
 * predicted motion puts the surface and left out of the fit from the first iteration on; once the frame
 * is solved it is looked for again where the surface really is, and the frame is aligned again if that
 * changed. A hand-drawn matte of what is in front (a frame's alpha) is left out the same way.
 */
export class RegionTracker {
  Hprev: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  Hprev2: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  prior: Float32Array[] | null = null;
  misses = 0;
  private readonly grid: Vec2[];

  private pointSeed = 0;

  constructor(
    readonly aligner: RegionAligner,
    private readonly quadImg: Vec2[],
    private readonly detector: OccluderDetector | null = null,
    /** How far round a hand-drawn matte samples are left out too, image px. */
    private readonly matteMarginPx = 6,
    /** The surface's own points, checked on every frame the region lined up (null: not checked). */
    private readonly surfacePoints: SurfacePoints | null = null,
    /** Over this (image px) at the points, a frame is not ok. */
    private readonly pointLimitPx = 1.5
  ) {
    this.grid = quadGrid(quadImg);
  }

  restore(last: Mat3, prev: Mat3 | null): void {
    this.Hprev = last.slice();
    this.Hprev2 = (prev ?? last).slice();
    this.prior = null;
    this.misses = 0;
  }

  /**
   * `frame`: the image (or one per channel, as the aligner was made); `rgba`: the frame as rendered, for the
   * occluder detector; `matte`: a hand-drawn matte of what is in front in this frame (alpha, frame image px).
   */
  step(frame: GrayImage | GrayImage[], rgba?: ColorImage, matte?: GrayImage): RegionStep {
    const pyr = this.aligner.pyramids(frame);
    let pred: Mat3 = this.Hprev;
    const inv2 = invertH(this.Hprev2);
    if (inv2) pred = mulH(this.Hprev, mulH(inv2, this.Hprev));
    const det = this.detector && rgba ? this.detector : null;
    let map = det ? det.detect(rgba as ColorImage, pred) : null;
    if (map && map.share > OCCLUDER_MAX_SHARE) map = null;
    const matteAt = (H: Mat3) => (matte ? matteExclude(this.aligner, matte, H, this.matteMarginPx) : null);
    const exclude = unionExclude(map && det ? det.sampleMask(map) : null, matteAt(pred));
    const tries: Mat3[] = [pred];
    // Retry from where the surface last was, without its speed (a sudden stop, or a jump in the prediction).
    if (inv2 && pred.some((v, i) => Math.abs(v - this.Hprev[i]) > 1e-9)) tries.push(this.Hprev);
    let best: AlignResult | null = null;
    let why = "";
    let model: FitModel = "perspective";
    // The occlusion memory helps a fit past someone walking in front, and can also hold it in a wrong place: once
    // without it (measured: each of the two alone lost a frame the other held, a truck behind a person, a laptop's
    // screen behind a hand).
    // With a detector (a key) there is no occlusion memory at all: the detector finds what is in front, and the
    // memory, leaving out a flat screen's edge samples that weighed little on the last frame (an anti-aliased
    // edge always has some), held a synthetic screen 0.5 px off where it came to 0.1 px without it.
    const prior = this.detector ? null : this.prior;
    const attempts: Array<{ start: Mat3; model: FitModel; prior: boolean }> = [
      ...tries.map((start) => ({ start, model: "perspective" as FitModel, prior: prior !== null })),
      ...(prior ? [{ start: pred, model: "perspective" as FitModel, prior: false }] : []),
      { start: pred, model: "affine", prior: prior !== null },
      { start: pred, model: "similarity", prior: prior !== null },
    ];
    const accept = (r: AlignResult) => !this.shapeOk(r.H) && verdict(r) && !this.jumped(r.H, pred);
    for (const at of attempts) {
      // A fit with fewer parameters is only for a surface the full fit lined up but could not hold (part of it out of
      // the frame or hidden: two edges of a flat screen hold a shift, turn and scale, not its perspective). When the
      // full fit did not line up at all, a fit with fewer parameters only finds a part that happens to (measured: a
      // board's markers matched onto other markers, 200 px off, passed every check as a similarity).
      if (at.model !== "perspective" && !(best && best.ncc >= VERDICT_NCC && best.coverage >= VERDICT_COVERAGE)) break;
      const r = this.aligner.align(pyr, at.start, at.prior ? prior : null, undefined, at.model, exclude);
      if ("failed" in r) {
        why = r.failed;
        continue;
      }
      const shape = this.shapeOk(r.H);
      if (shape) {
        why = shape;
        if (!best) best = r;
        continue;
      }
      const jump = verdict(r) ? this.jumped(r.H, pred) : null;
      if (verdict(r) && !jump) {
        best = r;
        model = at.model;
        why = "";
        break;
      }
      if (jump) {
        if (!best) best = r;
        why = jump;
        continue;
      }
      if (!best || r.ncc > best.ncc) best = r;
      why = verdictWhy(r);
    }
    let occluded = map ? map.share : det ? 0 : null;
    if (best && !why && (det || matte)) {
      // Looked for again where the surface is now known to be: what was found from the prediction can be off by its error.
      const again = det ? det.detect(rgba as ColorImage, best.H) : null;
      const useAgain = again && again.share <= OCCLUDER_MAX_SHARE ? again : null;
      const changed = det ? OccluderDetector.differ(useAgain, map) > 0 : false;
      // A matte moves with what it covers, not with the surface: looked at where the surface now is, it may cover other samples.
      if (changed || matte) {
        const from = Math.min(1, this.aligner.levels.length - 1);
        const ex2 = unionExclude(useAgain && det ? det.sampleMask(useAgain) : null, matteAt(best.H));
        const r2 = this.aligner.align(pyr, best.H, prior, from, model, ex2);
        if (!("failed" in r2) && accept(r2)) {
          // The levels it did not run keep the first fit's weights: the next frame's occlusion memory needs them
          // (left at "all visible", a person in front pulled the next frame's coarse levels 100 px off).
          const first = best;
          r2.weights = r2.weights.map((w, l) => (l > from ? first.weights[l] : w));
          best = r2;
          if (useAgain) occluded = useAgain.share;
        }
      }
    }
    if (best && !why) {
      this.prior = best.weights;
      this.Hprev2 = this.Hprev;
      this.Hprev = best.H;
      this.misses = 0;
      // The surface's own points: where the region lined up but its marks are not where the motion puts them,
      // the region followed something off the surface's plane. The motion is followed on (the next frame starts
      // from it, and the track can come back), but the frame is not ok.
      const sp = this.surfacePoints;
      // With a hand-drawn matte, a point whose patch touches it is not looked for.
      const skip = sp && matte ? (x: number, y: number) => underMatte(matte, x, y, sp.reach + this.matteMarginPx) : undefined;
      const pts = sp ? sp.check(Array.isArray(frame) ? frame[0] : frame, best.H, 1 + this.pointSeed++, skip) : null;
      if (pts && pts.px > this.pointLimitPx) {
        return {
          ok: false,
          H: best.H,
          ncc: best.ncc,
          coverage: best.coverage,
          expected_px: null,
          cells: best.cells,
          model,
          occluded,
          misses: 0,
          points: pts,
          note:
            `the region lined up, but the surface's own marks (${pts.used} of ${pts.matched} found) sit ${Math.round(pts.px * 10) / 10} image px from where it puts them: ` +
            "it is following something that is not on the surface's plane (a second wall or the curve of a cyc, a stand or a frame in front, lens distortion at the edge of a wide shot). Draw the region on the one plane, or exclude the rest",
        };
      }
      return {
        ...(pts ? { points: pts } : {}),
        ok: true,
        H: best.H,
        ncc: best.ncc,
        coverage: best.coverage,
        expected_px: this.aligner.expectedError(best, this.grid),
        cells: best.cells,
        model,
        occluded,
        misses: 0,
        ...(model !== "perspective" ? { note: `solved as ${model === "affine" ? "an affine" : "a similarity"} on top of the motion so far: too little of the surface was visible to fix its perspective` } : {}),
      };
    }
    // Hold still from the last good frame: the next one starts from there.
    this.Hprev2 = this.Hprev;
    this.misses++;
    return { ok: false, H: this.Hprev, ncc: best ? best.ncc : null, coverage: best ? best.coverage : null, expected_px: null, cells: best ? best.cells : null, model: null, occluded, note: why || "the region could not be aligned", misses: this.misses };
  }

  /**
   * A fit that lands far from where the motion was going is a wrong solution that happened to match a
   * few cells (seen: a laptop screen half out of frame "found" 800 px away; a hand leaving a screen's
   * corner bent that corner 20 px in while the rest held). Allowed: on average 30% of the surface's size
   * per frame since the last good one (up to its full size) plus 20 px; any one corner 4% of the size per
   * frame plus 3 px beyond the others' shift; an area change under 2.5 times.
   */
  private jumped(H: Mat3, pred: Mat3): string | null {
    const a = this.quadImg.map((p) => applyH(H, p));
    const b = this.quadImg.map((p) => applyH(pred, p));
    if (a.some((p) => p === null) || b.some((p) => p === null)) return null;
    const qa = a as Vec2[];
    const qb = b as Vec2[];
    let d = 0;
    for (let i = 0; i < 4; i++) d += Math.hypot(qa[i][0] - qb[i][0], qa[i][1] - qb[i][1]) / 4;
    const size = Math.max(Math.hypot(qb[0][0] - qb[2][0], qb[0][1] - qb[2][1]), Math.hypot(qb[1][0] - qb[3][0], qb[1][1] - qb[3][1]));
    const allowed = Math.min(1, 0.3 * (1 + this.misses)) * size + 20;
    if (d > allowed) return `the fit jumped ${Math.round(d)} px from where the motion was going (more than ${Math.round(allowed)} px): a wrong match`;
    // One corner moving against the others: the shift every corner shares is taken out first.
    const sx = qa.reduce((t, p, i) => t + p[0] - qb[i][0], 0) / 4;
    const sy = qa.reduce((t, p, i) => t + p[1] - qb[i][1], 0) / 4;
    const own = Math.max(...qa.map((p, i) => Math.hypot(p[0] - qb[i][0] - sx, p[1] - qb[i][1] - sy)));
    const ownAllowed = Math.min(1, 0.04 * (1 + this.misses)) * size + 3;
    if (own > ownAllowed) return `one corner moved ${Math.round(own)} px against the others in one frame (more than ${Math.round(ownAllowed)} px): a wrong match`;
    const area = (q: Vec2[]) => Math.abs(q.reduce((s, p, i) => s + p[0] * q[(i + 1) % 4][1] - q[(i + 1) % 4][0] * p[1], 0)) / 2;
    const ratio = area(qa) / Math.max(1e-9, area(qb));
    if (!(ratio < 2.5 && ratio > 0.4)) return `the surface's area changed ${Math.round(ratio * 100) / 100} times in one frame: a wrong match`;
    return null;
  }

  private shapeOk(H: Mat3): string | null {
    const q = this.quadImg.map((p) => applyH(H, p));
    if (q.some((p) => p === null)) return "the surface quad lands behind the plane at infinity";
    const c = quadCheck(q as Vec2[]);
    return c.ok ? null : `the surface quad is degenerate: ${c.reason}`;
  }
}

/** Whether a matte (alpha 0-255) covers (x, y) or any point at `r` px round it, frame image px. */
export function underMatte(matte: GrayImage, x: number, y: number, r: number): boolean {
  for (const [dx, dy] of [[0, 0], [-r, -r], [0, -r], [r, -r], [-r, 0], [r, 0], [-r, r], [0, r], [r, r]]) {
    const X = Math.round(x + dx);
    const Y = Math.round(y + dy);
    if (X < 0 || Y < 0 || X >= matte.width || Y >= matte.height) continue;
    if (matte.data[Y * matte.width + X] > 127) return true;
  }
  return false;
}

export const verdict = (r: AlignResult): boolean => r.ncc >= VERDICT_NCC && r.coverage >= VERDICT_COVERAGE && cellsAgree(r.cells);

/** Why a frame failed the verdict, in words. */
export function verdictWhy(r: AlignResult): string {
  if (!(r.ncc >= VERDICT_NCC && r.coverage >= VERDICT_COVERAGE)) {
    return `the frame does not match the surface (correlation ${round2(r.ncc)} over ${Math.round(100 * r.coverage)}% of it; needs ${VERDICT_NCC} over ${Math.round(100 * VERDICT_COVERAGE)}%)`;
  }
  const c = r.cells;
  if (!(c.matched >= Math.max(3, CELL_SHARE * c.textured))) return `only part of the surface lines up (${c.matched} of ${c.textured} textured cells agree; needs ${Math.round(100 * CELL_SHARE)}%)`;
  return `the part that lines up (${c.matched} of ${c.textured} textured cells) does not hold the rest: the surface's corners could be ${Math.round(c.pinned_px * 10) / 10} px off`;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Image px <-> comp px: comp = (img + 0.5) / scale. */
export function imgToCompH(H: Mat3, scale: number): Mat3 {
  const T: Mat3 = [1 / scale, 0, 0.5 / scale, 0, 1 / scale, 0.5 / scale, 0, 0, 1];
  const Ti: Mat3 = [scale, 0, -0.5, 0, scale, -0.5, 0, 0, 1];
  const out = mulH(T, mulH(H, Ti));
  return out.map((v) => v / out[8]);
}

export function compToImgH(H: Mat3, scale: number): Mat3 {
  const T: Mat3 = [1 / scale, 0, 0.5 / scale, 0, 1 / scale, 0.5 / scale, 0, 0, 1];
  const Ti: Mat3 = [scale, 0, -0.5, 0, scale, -0.5, 0, 0, 1];
  const out = mulH(Ti, mulH(H, T));
  return out.map((v) => v / out[8]);
}
