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
}

interface Level {
  s: number;
  n: number;
  xs: Float32Array;
  ys: Float32Array;
  tv: Float64Array;
  /** n x 8 steepest-descent rows, in the level's normalized coordinates. */
  J: Float64Array;
  N: Mat3;
  Ninv: Mat3;
  r: number;
}

export interface AlignResult {
  /** Image px (level 0) of the reference -> image px of the frame. */
  H: Mat3;
  ncc: number;
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

/** Solves the symmetric 8 x 8 system A x = b in place by Gaussian elimination with pivoting. Null when singular. */
function solve8(A: Float64Array, b: Float64Array): Float64Array | null {
  const n = 8;
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

function inverse8(A: Float64Array): Float64Array | null {
  const out = new Float64Array(64);
  const e = new Float64Array(8);
  for (let c = 0; c < 8; c++) {
    e.fill(0);
    e[c] = 1;
    const col = solve8(A, e);
    if (!col) return null;
    for (let r = 0; r < 8; r++) out[r * 8 + c] = col[r];
  }
  return out;
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

  constructor(ref: GrayImage, mask: Float32Array, opts: RegionOptions = {}) {
    const maxSamples = Math.max(500, opts.maxSamples ?? 12000);
    this.width = ref.width;
    this.height = ref.height;
    // The region's box at level 0, for the normalization.
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    let area = 0;
    for (let y = 0; y < ref.height; y++) {
      for (let x = 0; x < ref.width; x++) {
        if (!(mask[y * ref.width + x] > 0)) continue;
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
    const pyr = pyramid(ref, nLevels);
    for (let l = 0; l < nLevels; l++) {
      const s = 2 ** l;
      const img = pyr[l];
      const { width: w, height: h } = img;
      const { gx, gy } = sobel(img);
      // The level's own mask: the level-0 pixel each level pixel sits on (pyrDown keeps pixel 2i). A large
      // region (a wall on a 4K plate) is looked at on a sparser grid, so the candidates stay near 8x the budget.
      const stride = Math.max(1, Math.floor(Math.sqrt(area / 4 ** l / (8 * maxSamples))));
      const cand: number[] = [];
      for (let y = 1; y < h - 1; y += stride) {
        const y0p = Math.min(ref.height - 1, y * s);
        for (let x = 1; x < w - 1; x += stride) {
          const x0p = Math.min(ref.width - 1, x * s);
          if (mask[y0p * ref.width + x0p] > 0) cand.push(y * w + x);
        }
      }
      const mag = new Float64Array(cand.length);
      for (let k = 0; k < cand.length; k++) mag[k] = Math.hypot(gx[cand[k]], gy[cand[k]]);
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
      const tv = new Float64Array(n);
      const J = new Float64Array(n * 8);
      let strong = 0;
      for (let k = 0; k < n; k++) {
        const i = picked[k];
        const x = i % w;
        const y = (i - x) / w;
        xs[k] = x;
        ys[k] = y;
        tv[k] = img.data[i];
        const xn = (x - cx) / r;
        const yn = (y - cy) / r;
        const gxn = gx[i] * r;
        const gyn = gy[i] * r;
        const d = gxn * xn + gyn * yn;
        const o = k * 8;
        J[o] = gxn * xn;
        J[o + 1] = gxn * yn;
        J[o + 2] = gxn;
        J[o + 3] = gyn * xn;
        J[o + 4] = gyn * yn;
        J[o + 5] = gyn;
        J[o + 6] = -xn * d;
        J[o + 7] = -yn * d;
        if (Math.hypot(gx[i], gy[i]) >= 2) strong++;
      }
      if (l === 0 && strong < 150) throw new Error("the region is flat (almost no edges or texture to follow)");
      const N: Mat3 = [1 / r, 0, -cx / r, 0, 1 / r, -cy / r, 0, 0, 1];
      this.levels.push({ s, n, xs, ys, tv, J, N, Ninv: invertH(N) as Mat3, r });
    }
    this.samples = this.levels[0].n;
  }

  /**
   * Aligns a frame (its pyramid, from `pyramid(frame, levels)`) starting from H0 (reference image px ->
   * frame image px). `prior` is the last good frame's weights (the occlusion memory). `fromLevel` starts
   * at a finer level than the coarsest (for a refinement of a motion that is already close). Null with a
   * reason when the region leaves the frame or the fit diverges.
   */
  align(frame: GrayImage[], H0: Mat3, prior: Float32Array[] | null = null, fromLevel?: number): AlignResult | { failed: string } {
    const top = Math.min(this.levels.length - 1, fromLevel ?? this.levels.length - 1);
    let H = H0.slice();
    const weights: Float32Array[] = new Array(this.levels.length);
    let ncc = 0;
    let coverage = 0;
    let visible = 0;
    let sigma = 0;
    let cov: Float64Array | null = null;
    let cells: CellAgreement = { textured: 0, matched: 0, span: [0, 0], pinned: 1, pinned_px: 0 };
    for (let l = top; l >= 0; l--) {
      const L = this.levels[l];
      const img = frame[l];
      if (!img) return { failed: "the frame has no image at this level" };
      const { width: w, height: h, data } = img;
      let Hl = scaleH(H, L.s);
      const n = L.n;
      const iters = l > 0 ? 40 : 25;
      const late = Math.floor((2 * iters) / 3);
      const pm = prior && prior[l] && prior[l].length === n ? prior[l] : null;
      const iv = new Float64Array(n);
      const e = new Float64Array(n);
      const ok = new Uint8Array(n);
      let wgt: Float64Array | null = null;
      const abs = new Float64Array(n);
      const A = new Float64Array(64);
      const bv = new Float64Array(8);
      let okCount = 0;
      let lastSig2 = 0;
      for (let it = 0; it < iters; it++) {
        // Warp the samples into the frame.
        okCount = 0;
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
          const ix = Math.floor(u);
          const iy = Math.floor(v);
          const fx = u - ix;
          const fy = v - iy;
          const p = iy * w + ix;
          iv[k] = (data[p] * (1 - fx) + data[p + 1] * fx) * (1 - fy) + (data[p + w] * (1 - fx) + data[p + w + 1] * fx) * fy;
          ok[k] = 1;
          okCount++;
        }
        if (okCount < Math.min(200, 0.3 * n)) return { failed: "the region is out of the frame" };
        // Gain and bias from the samples the last iteration trusted (an occluder must not set the exposure).
        let sw = 0;
        let st = 0;
        let si = 0;
        for (let k = 0; k < n; k++) {
          if (!ok[k]) continue;
          const ww = wgt ? wgt[k] : 1;
          sw += ww;
          st += ww * L.tv[k];
          si += ww * iv[k];
        }
        let useW = wgt !== null && sw >= 100;
        if (!useW) {
          sw = okCount;
          st = 0;
          si = 0;
          for (let k = 0; k < n; k++) {
            if (!ok[k]) continue;
            st += L.tv[k];
            si += iv[k];
          }
        }
        const mt = st / sw;
        const mi = si / sw;
        let vt = 0;
        let cti = 0;
        for (let k = 0; k < n; k++) {
          if (!ok[k]) continue;
          const ww = useW ? (wgt as Float64Array)[k] : 1;
          vt += ww * (L.tv[k] - mt) ** 2;
          cti += ww * (L.tv[k] - mt) * (iv[k] - mi);
        }
        let g = cti / Math.max(vt, 1e-6);
        if (!(g > 0.3 && g < 3)) g = 1;
        const b = mi - g * mt;
        // Residuals and the robust scale over the samples still trusted.
        let na = 0;
        for (let k = 0; k < n; k++) {
          if (!ok[k]) {
            e[k] = 0;
            continue;
          }
          e[k] = (iv[k] - b) / g - L.tv[k];
          if (!wgt || wgt[k] > 0) abs[na++] = Math.abs(e[k]);
        }
        if (na < 100) {
          na = 0;
          for (let k = 0; k < n; k++) if (ok[k]) abs[na++] = Math.abs(e[k]);
        }
        const sig = 1.4826 * select(abs, na, na >> 1) + 1e-3;
        const kk = 4.685 * Math.max(sig, 1);
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
          if (ok[k] && Math.abs(e[k]) < kk) {
            const q = e[k] / kk;
            ww = (1 - q * q) ** 2;
          }
          // The occlusion memory zeroes the weight itself, so the next iteration's gain, bias and scale leave those samples out too.
          if (usePrior && !(pm![k] > 0.25)) ww = 0;
          wgt[k] = ww;
          if (ww === 0) continue;
          const o = k * 8;
          const ek = e[k];
          for (let i = 0; i < 8; i++) {
            const ji = L.J[o + i] * ww;
            bv[i] += ji * ek;
            for (let j = i; j < 8; j++) A[i * 8 + j] += ji * L.J[o + j];
          }
          sw2 += ww;
          se2 += ww * ek * ek;
        }
        for (let i = 0; i < 8; i++) {
          for (let j = 0; j < i; j++) A[i * 8 + j] = A[j * 8 + i];
          A[i * 8 + i] += 1e-6;
        }
        lastSig2 = sw2 > 8 ? se2 / sw2 : 0;
        sigma = sig;
        const dp = solve8(A, bv);
        if (!dp) return { failed: "the fit is singular (the region has texture in one direction only)" };
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
      visible = okCount / n;
      coverage = okCount > 0 ? kept / okCount : 0;
      if (l === 0) {
        // The verdict: correlation of the reference with the warped frame over the samples the fit kept.
        let sa = 0;
        let sb = 0;
        let saa = 0;
        let sbb = 0;
        let sab = 0;
        for (let k = 0; k < n; k++) {
          if (!(ok[k] && wf[k] > 0.5)) continue;
          const a = L.tv[k];
          const c = iv[k];
          sa += a;
          sb += c;
          saa += a * a;
          sbb += c * c;
          sab += a * c;
        }
        if (kept > 50) {
          const va = saa - (sa * sa) / kept;
          const vb = sbb - (sb * sb) / kept;
          ncc = va > 1e-9 && vb > 1e-9 ? (sab - (sa * sb) / kept) / Math.sqrt(va * vb) : 0;
        } else {
          ncc = 0;
        }
        const inv = inverse8(A);
        cov = inv ? inv.map((v) => v * lastSig2) : null;
        const ca = this.cellAgreement(L, ok, iv);
        // The agreeing cells' own grip on the motion, against the whole fit's, at the region's corners.
        const am = new Float64Array(64);
        for (let k = 0; k < n; k++) {
          if (!(ok[k] && wf[k] > 0.5 && ca.agree[this.cellOf(k)])) continue;
          const o = k * 8;
          for (let i = 0; i < 8; i++) for (let j = i; j < 8; j++) am[i * 8 + j] += wf[k] * L.J[o + i] * L.J[o + j];
        }
        for (let i = 0; i < 8; i++) {
          for (let j = 0; j < i; j++) am[i * 8 + j] = am[j * 8 + i];
          am[i * 8 + i] += 1e-6;
        }
        const invm = inverse8(am);
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
    return { H, ncc, coverage, visible, sigma, weights, cov, cells };
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

  private cellAgreement(L: Level, ok: Uint8Array, iv: Float64Array): { textured: number; matched: number; span: [number, number]; agree: Uint8Array } {
    const G = CELL_GRID;
    const [x0, y0, x1, y1] = this.box;
    const cw = Math.max(1, (x1 - x0 + 1) / G);
    const ch = Math.max(1, (y1 - y0 + 1) / G);
    const acc = new Float64Array(G * G * 6);
    const agree = new Uint8Array(G * G);
    for (let k = 0; k < L.n; k++) {
      if (!ok[k]) continue;
      const cx = Math.min(G - 1, Math.max(0, Math.floor((L.xs[k] - x0) / cw)));
      const cy = Math.min(G - 1, Math.max(0, Math.floor((L.ys[k] - y0) / ch)));
      const o = (cy * G + cx) * 6;
      const a = L.tv[k];
      const b = iv[k];
      acc[o] += 1;
      acc[o + 1] += a;
      acc[o + 2] += b;
      acc[o + 3] += a * a;
      acc[o + 4] += b * b;
      acc[o + 5] += a * b;
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
    for (let c = 0; c < G * G; c++) {
      const o = c * 6;
      const n = acc[o];
      if (n < 20) continue;
      const va = acc[o + 3] - (acc[o + 1] * acc[o + 1]) / n;
      if (!(Math.sqrt(Math.max(0, va) / n) >= CELL_MIN_STD)) continue;
      textured++;
      const cx = c % G;
      const cy = (c - cx) / G;
      tx0 = Math.min(tx0, cx);
      tx1 = Math.max(tx1, cx);
      ty0 = Math.min(ty0, cy);
      ty1 = Math.max(ty1, cy);
      const vb = acc[o + 4] - (acc[o + 2] * acc[o + 2]) / n;
      const r = vb > 1e-9 ? (acc[o + 5] - (acc[o + 1] * acc[o + 2]) / n) / Math.sqrt(va * vb) : 0;
      if (r >= CELL_NCC) {
        matched++;
        agree[c] = 1;
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
  note?: string;
  /** Frames in a row without a verdict, this one included. */
  misses: number;
}

/**
 * One direction of a region track: frames in order, away from the reference frame. Starts from the
 * last two good frames' motion; a frame that fails is retried from the last good motion, then held.
 */
export class RegionTracker {
  Hprev: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  Hprev2: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  prior: Float32Array[] | null = null;
  misses = 0;
  private readonly grid: Vec2[];

  constructor(readonly aligner: RegionAligner, private readonly quadImg: Vec2[]) {
    this.grid = quadGrid(quadImg);
  }

  restore(last: Mat3, prev: Mat3 | null): void {
    this.Hprev = last.slice();
    this.Hprev2 = (prev ?? last).slice();
    this.prior = null;
    this.misses = 0;
  }

  step(gray: GrayImage): RegionStep {
    const pyr = pyramid(gray, this.aligner.levels.length);
    let pred: Mat3 = this.Hprev;
    const inv2 = invertH(this.Hprev2);
    if (inv2) pred = mulH(this.Hprev, mulH(inv2, this.Hprev));
    const tries: Mat3[] = [pred];
    // Retry from where the surface last was, without its speed (a sudden stop, or a jump in the prediction).
    if (inv2 && pred.some((v, i) => Math.abs(v - this.Hprev[i]) > 1e-9)) tries.push(this.Hprev);
    let best: AlignResult | null = null;
    let why = "";
    for (const start of tries) {
      const r = this.aligner.align(pyr, start, this.prior);
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
    if (best && !why) {
      this.prior = best.weights;
      this.Hprev2 = this.Hprev;
      this.Hprev = best.H;
      this.misses = 0;
      return { ok: true, H: best.H, ncc: best.ncc, coverage: best.coverage, expected_px: this.aligner.expectedError(best, this.grid), cells: best.cells, misses: 0 };
    }
    // Hold still from the last good frame: the next one starts from there.
    this.Hprev2 = this.Hprev;
    this.misses++;
    return { ok: false, H: this.Hprev, ncc: best ? best.ncc : null, coverage: best ? best.coverage : null, expected_px: null, cells: best ? best.cells : null, note: why || "the region could not be aligned", misses: this.misses };
  }

  /**
   * A fit that lands far from where the motion was going is a wrong solution that happened to match a
   * few cells (seen: a laptop screen half out of frame "found" 800 px away). Allowed: 30% of the
   * surface's size per frame since the last good one (up to its full size), plus 20 px, and an area
   * change under 2.5 times.
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
