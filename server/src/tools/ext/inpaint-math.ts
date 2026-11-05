/**
 * server/src/tools/ext/inpaint-math.ts
 *
 * The pixel maths under ae_inpaint_plate, the scriptable stand-in for Content-
 * Aware Fill: it makes a clean plate from the other frames of an aligned shot
 * and from the pixels around the hole. Pure: no AE, no files, so it runs on
 * the panel's Node 17.7.2 and is tested on synthetic images.
 * - warpCrop: one frame carried into the reference frame through a homography
 *   (bilinear, cropped to the hole's box so memory stays small)
 * - matchColor: gain and offset of a warped sample to the reference in the
 *   ring around the hole (region-math fitGainOffset)
 * - medianStack: per hole pixel, the median of the samples that show background
 * - laplaceFill: harmonic (diffusion) fill, exact on ramps, for wires and blemishes
 * - patchMatchFill: a bounded PatchMatch exemplar fill on two levels, for texture
 * - prepareHole and fillFromFrames: the whole job on decoded frames
 *
 * Coordinates. Polygons are in comp pixels, pixel-EDGE coordinates (region-
 * math.ts). A homography H maps a point of the reference frame (comp pixels)
 * to where it is in the sampled frame (PlanarTrack frames), so warping a frame
 * INTO the reference is a backward lookup through H itself. `scale` is image
 * pixels per comp pixel (1 for the full-resolution renders saveFrameToPng makes).
 * Colour values are 8-bit sRGB display values, as the PNGs hold them.
 */

import type { Mat3 } from "./planar-math.js";
import type { RgbaImage } from "./png-utils.js";
import { fitGainOffset, polygonBounds, rasterizePolygon, signedDistance, type Bounds, type Pt } from "./region-math.js";

export type { Pt, Bounds } from "./region-math.js";

/** A float image, 3 interleaved channels (R, G, B), 0..255. */
export interface Plane {
  width: number;
  height: number;
  data: Float32Array;
}

export type Tick = () => Promise<void>;

/** Hole pixels may not exceed this share of the frame. */
export const MAX_HOLE_SHARE = 0.25;

/** Class codes of the per-pixel map: how each pixel of the crop was filled. */
export const CLS = { OUTSIDE: 0, TEMPORAL: 1, TEMPORAL_LOW: 2, SPATIAL: 3, UNFILLED: 4 } as const;

export class InpaintError extends Error {
  constructor(readonly code: "bad_args" | "refused", message: string) {
    super(message);
    this.name = "InpaintError";
  }
}

// ---------- small helpers ----------

export function planeFromRgba(img: RgbaImage): Plane {
  const n = img.width * img.height;
  const data = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    data[i * 3] = img.data[i * 4];
    data[i * 3 + 1] = img.data[i * 4 + 1];
    data[i * 3 + 2] = img.data[i * 4 + 2];
  }
  return { width: img.width, height: img.height, data };
}

export function planeToRgba(p: Plane): RgbaImage {
  const n = p.width * p.height;
  const data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) data[i * 4 + c] = Math.max(0, Math.min(255, Math.round(p.data[i * 3 + c])));
    data[i * 4 + 3] = 255;
  }
  return { width: p.width, height: p.height, data };
}

/** The pixels of an image inside a box, as a new image. The box must lie inside the image. */
export function cropRgba(img: RgbaImage, x0: number, y0: number, w: number, h: number): RgbaImage {
  const data = new Uint8Array(w * h * 4);
  for (let row = 0; row < h; row++) {
    const si = ((y0 + row) * img.width + x0) * 4;
    for (let k = 0; k < w * 4; k++) data[row * w * 4 + k] = img.data[si + k];
  }
  return { width: w, height: h, data };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- the hole ----------

export interface HoleSetup {
  /** The crop box in image pixels: the hole's box grown by the grow, the gap and the ring. */
  crop: { x0: number; y0: number; w: number; h: number };
  scale: number;
  /** 1 inside the grown hole, in the crop. */
  hole: Uint8Array;
  /** 1 in the ring around the hole, where colour is matched. */
  ring: Uint8Array;
  holePixels: number;
  /** Hole pixels over the frame's pixels. */
  share: number;
}

/**
 * The hole and its ring on the crop grid. `polygons` are comp pixels; the union
 * is grown by `growPx`. Throws InpaintError when nothing of the hole is inside the frame.
 */
export function prepareHole(
  imageW: number,
  imageH: number,
  comp: { width: number; height: number },
  polygons: Pt[][],
  growPx: number,
  ringGapPx: number,
  ringPx: number
): HoleSetup {
  const scale = imageW / comp.width;
  if (polygons.length === 0) throw new InpaintError("bad_args", "No hole region was given.");
  const polysImg = polygons.map((p) => p.map(([x, y]) => [x * scale, y * scale] as Pt));
  const all = polysImg.flat();
  const b = polygonBounds(all);
  const margin = Math.ceil((growPx + ringGapPx + ringPx) * scale) + 4;
  const x0 = Math.max(0, Math.floor(b[0] - margin));
  const y0 = Math.max(0, Math.floor(b[1] - margin));
  const x1 = Math.min(imageW, Math.ceil(b[2] + margin));
  const y1 = Math.min(imageH, Math.ceil(b[3] + margin));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w < 4 || h < 4) throw new InpaintError("bad_args", "The hole is outside the frame.");
  const union = new Float32Array(w * h);
  for (const poly of polysImg) {
    const cov = rasterizePolygon(w, h, poly.map(([x, y]) => [x - x0, y - y0] as Pt));
    for (let i = 0; i < union.length; i++) if (cov[i] > union[i]) union[i] = cov[i];
  }
  const sd = signedDistance(union, w, h);
  const growImg = growPx * scale;
  const hole = new Uint8Array(w * h);
  const holeF = new Float32Array(w * h);
  let holePixels = 0;
  for (let i = 0; i < hole.length; i++) {
    if (sd[i] - growImg < 0.5) {
      hole[i] = 1;
      holeF[i] = 1;
      holePixels++;
    }
  }
  if (holePixels === 0) throw new InpaintError("bad_args", "The hole is outside the frame.");
  const sd2 = signedDistance(holeF, w, h);
  const ring = new Uint8Array(w * h);
  const gap = ringGapPx * scale;
  const ringW = ringPx * scale;
  for (let i = 0; i < ring.length; i++) if (sd2[i] >= gap && sd2[i] <= gap + ringW) ring[i] = 1;
  return { crop: { x0, y0, w, h }, scale, hole, ring, holePixels, share: holePixels / (imageW * imageH) };
}

// ---------- warping ----------

/**
 * `src` carried into the reference frame over the box `bbox` (image pixels of
 * the reference): output pixel (x, y) looks up the source at H(x, y), bilinear.
 * Alpha is 255 where the lookup landed on opaque pixels of the source, else 0
 * (outside the frame, behind the horizon, or where the source is transparent).
 * An integer translation reproduces the source exactly.
 */
export function warpCrop(src: RgbaImage, H: Mat3, bbox: Bounds, scale = 1): RgbaImage {
  const x0 = Math.floor(bbox[0]);
  const y0 = Math.floor(bbox[1]);
  const w = Math.max(1, Math.ceil(bbox[2]) - x0);
  const h = Math.max(1, Math.ceil(bbox[3]) - y0);
  const out = new Uint8Array(w * h * 4);
  const sw = src.width;
  const sh = src.height;
  if (sw < 2 || sh < 2) return { width: w, height: h, data: out };
  const d = src.data;
  const eps = 1e-6;
  for (let y = 0; y < h; y++) {
    const cy = (y0 + y + 0.5) / scale;
    for (let x = 0; x < w; x++) {
      const cx = (x0 + x + 0.5) / scale;
      const q = H[6] * cx + H[7] * cy + H[8];
      if (!(q > 1e-9)) continue;
      const mx = ((H[0] * cx + H[1] * cy + H[2]) / q) * scale - 0.5;
      const my = ((H[3] * cx + H[4] * cy + H[5]) / q) * scale - 0.5;
      if (!(mx >= -eps && my >= -eps && mx <= sw - 1 + eps && my <= sh - 1 + eps)) continue;
      const ix = Math.min(sw - 2, Math.max(0, Math.floor(mx)));
      const iy = Math.min(sh - 2, Math.max(0, Math.floor(my)));
      const fx = Math.min(1, Math.max(0, mx - ix));
      const fy = Math.min(1, Math.max(0, my - iy));
      const i00 = (iy * sw + ix) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + sw * 4;
      const i11 = i01 + 4;
      const a = d[i00 + 3] * (1 - fx) * (1 - fy) + d[i10 + 3] * fx * (1 - fy) + d[i01 + 3] * (1 - fx) * fy + d[i11 + 3] * fx * fy;
      if (a < 250) continue;
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const v = d[i00 + c] * (1 - fx) * (1 - fy) + d[i10 + c] * fx * (1 - fy) + d[i01 + c] * (1 - fx) * fy + d[i11 + c] * fx * fy;
        out[o + c] = Math.round(v);
      }
      out[o + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

export interface ColorMatch {
  applied: boolean;
  gain: [number, number, number];
  offset: [number, number, number];
  pixels: number;
  reason?: string;
  /** True when the fit was refused for a gain outside 0.5..2: the ring does not match this sample. */
  badGain?: boolean;
}

/**
 * Brings `sample` to the exposure of `ref` (both crops of the same size) with a
 * per channel gain and offset fitted on the ring where the sample is valid, as
 * Mocha's illumination modelling does. In place. A fit from fewer than 50 pixels
 * or with a gain outside 0.5..2 is not applied. Invalid pixels (alpha 0) stay.
 */
export function matchColor(sample: RgbaImage, ref: RgbaImage, ring: Uint8Array): ColorMatch {
  const mask = new Float32Array(ring.length);
  for (let i = 0; i < ring.length; i++) if (ring[i] && sample.data[i * 4 + 3] === 255) mask[i] = 1;
  const fit = fitGainOffset(ref, sample, mask, { trimPct: 10, excludeClipped: true });
  const base = { gain: fit.gain, offset: fit.offset, pixels: fit.pixels };
  if (fit.pixels < 50) return { applied: false, ...base, reason: "fewer than 50 usable ring pixels" };
  if (fit.gain.some((g) => !(g > 0.5 && g < 2))) return { applied: false, ...base, badGain: true, reason: "the fitted gain is outside 0.5..2 (the ring does not match: bad track or parallax)" };
  const n = sample.width * sample.height;
  for (let i = 0; i < n; i++) {
    if (sample.data[i * 4 + 3] !== 255) continue;
    for (let c = 0; c < 3; c++) {
      const v = (fit.gain[c] * (sample.data[i * 4 + c] / 255) + fit.offset[c]) * 255;
      sample.data[i * 4 + c] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }
  return { applied: true, ...base };
}

// ---------- the temporal median ----------

export interface StackOptions {
  /** Fewest background samples a pixel needs. */
  minSamples: number;
  /** Sample spread (gray levels, a sigma from the interquartile range) above which the pixel is flagged low confidence. */
  maxSpread: number;
  /** Largest channel difference (0..255) from the reference pixel at which a sample still counts as the object itself. */
  objectTol: number;
  /**
   * True: the object moves against the plane, so any sample may show what is
   * behind it, even one that looks like the object. False: the object sits on
   * the plane (or the camera moves past it), so a sample that still shows the
   * reference pixel is the object, not background, and does not vote; and a
   * pixel whose voters' median still sits near the reference (within the wider
   * of 1.5 tolerances and 2.5 robust sigmas of the voters, see below) is the
   * object seen through grain, and is left for the spatial fill.
   */
  objectMoves: boolean;
  tick?: Tick;
}

export interface StackResult {
  /** Median RGB per pixel of the crop (0 where not filled). */
  rgb: Float32Array;
  /** Background samples that voted, per pixel. */
  count: Uint16Array;
  /** Spread of the voting samples (gray levels). */
  spread: Float32Array;
  /** 1 where the pixel has at least minSamples votes. */
  filled: Uint8Array;
  /** 1 where it is filled but the samples disagree (parallax, a moving object, a bad track). */
  lowConfidence: Uint8Array;
  /**
   * Hole pixels left for the spatial fill by the object-still-there tests: too
   * few samples were left to vote after the per-sample test, or the voters'
   * median still sat near the reference pixel (the per-pixel test).
   */
  unrevealed: number;
}

/** The median of the background samples at every hole pixel. `samples` are warped crops (alpha 255 = valid), `ref` the reference crop. */
export async function medianStack(samples: RgbaImage[], hole: Uint8Array, ref: RgbaImage, opts: StackOptions): Promise<StackResult> {
  const n = hole.length;
  const rgb = new Float32Array(n * 3);
  const count = new Uint16Array(n);
  const spread = new Float32Array(n);
  const filled = new Uint8Array(n);
  const lowConfidence = new Uint8Array(n);
  let unrevealed = 0;
  const cap = Math.max(1, samples.length);
  const bufs = [new Float32Array(cap), new Float32Array(cap), new Float32Array(cap)];
  const devs = new Float32Array(cap);
  const rd = ref.data;
  const w = ref.width;
  for (let p = 0; p < n; p++) {
    if (opts.tick && p % (w * 16) === 0 && p > 0) await opts.tick();
    if (!hole[p]) continue;
    let k = 0;
    let objectLike = 0;
    const i = p * 4;
    for (let s = 0; s < samples.length; s++) {
      const d = samples[s].data;
      if (d[i + 3] !== 255) continue;
      if (!opts.objectMoves) {
        const diff = Math.max(Math.abs(d[i] - rd[i]), Math.abs(d[i + 1] - rd[i + 1]), Math.abs(d[i + 2] - rd[i + 2]));
        if (diff <= opts.objectTol) {
          objectLike++;
          continue;
        }
      }
      bufs[0][k] = d[i];
      bufs[1][k] = d[i + 1];
      bufs[2][k] = d[i + 2];
      k++;
    }
    count[p] = k;
    if (k < opts.minSamples) {
      if (objectLike > 0 && k + objectLike >= opts.minSamples) unrevealed++;
      continue;
    }
    // Median and spread of the k voting samples.
    let spreadSum = 0;
    let far = 0;
    const med3 = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const v = bufs[c].subarray(0, k);
      v.sort();
      const mid = k >> 1;
      med3[c] = k % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
      const q1 = v[Math.floor(0.25 * (k - 1))];
      const q3 = v[Math.ceil(0.75 * (k - 1))];
      spreadSum += (q3 - q1) / 1.349;
      far = Math.max(far, Math.abs(med3[c] - rd[i + c]));
    }
    const sp = spreadSum / 3;
    // Decide per pixel, not per sample: with grain, a static object passes the per-sample test often enough to leave
    // voters that are only its grain. When the voters' median still sits near the reference (within the wider of 1.5
    // tolerances and 2.5 robust sigmas of the voters, since the reference carries grain too), the pixel is the object
    // and goes to the spatial fill. The sigma here is the median absolute deviation (x 1.4826), not the interquartile
    // spread kept in `spread`: once grain pushes many object samples over the tolerance the voters are two clusters
    // (some object, some background), the IQR jumps to the distance between them, and the test would throw away
    // good background samples. The MAD follows the majority cluster. It is worked out only when the tolerance alone
    // has not decided the pixel.
    if (!opts.objectMoves) {
      let object = far <= opts.objectTol * 1.5;
      if (!object) {
        let madSum = 0;
        for (let c = 0; c < 3; c++) {
          const v = bufs[c];
          for (let j = 0; j < k; j++) devs[j] = Math.abs(v[j] - med3[c]);
          const dv = devs.subarray(0, k);
          dv.sort();
          const mid = k >> 1;
          madSum += (k % 2 ? dv[mid] : (dv[mid - 1] + dv[mid]) / 2) * 1.4826;
        }
        object = far <= (2.5 * madSum) / 3;
      }
      if (object) {
        unrevealed++;
        continue;
      }
    }
    for (let c = 0; c < 3; c++) rgb[p * 3 + c] = med3[c];
    spread[p] = sp;
    filled[p] = 1;
    if (spread[p] > opts.maxSpread) lowConfidence[p] = 1;
  }
  return { rgb, count, spread, filled, lowConfidence, unrevealed };
}

// ---------- the harmonic fill ----------

/** A first guess for the unknown pixels by push-pull: known pixels averaged up a pyramid, then pulled back down into the holes. */
function pushPull(plane: Plane, unknown: Uint8Array): void {
  type Level = { w: number; h: number; val: Float32Array; wt: Float32Array };
  const levels: Level[] = [];
  const base: Level = { w: plane.width, h: plane.height, val: new Float32Array(plane.data), wt: new Float32Array(plane.width * plane.height) };
  for (let i = 0; i < unknown.length; i++) base.wt[i] = unknown[i] ? 0 : 1;
  levels.push(base);
  while (levels[levels.length - 1].w > 1 || levels[levels.length - 1].h > 1) {
    const a = levels[levels.length - 1];
    const nw = Math.ceil(a.w / 2);
    const nh = Math.ceil(a.h / 2);
    const b: Level = { w: nw, h: nh, val: new Float32Array(nw * nh * 3), wt: new Float32Array(nw * nh) };
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        let sw = 0;
        let cells = 0;
        const s = [0, 0, 0];
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const xx = 2 * x + dx;
            const yy = 2 * y + dy;
            if (xx >= a.w || yy >= a.h) continue;
            cells++;
            const wt = a.wt[yy * a.w + xx];
            if (wt <= 0) continue;
            sw += wt;
            for (let c = 0; c < 3; c++) s[c] += wt * a.val[(yy * a.w + xx) * 3 + c];
          }
        }
        const o = y * nw + x;
        if (sw > 0) {
          for (let c = 0; c < 3; c++) b.val[o * 3 + c] = s[c] / sw;
          b.wt[o] = sw / cells;
        }
      }
    }
    levels.push(b);
  }
  for (let k = levels.length - 2; k >= 0; k--) {
    const a = levels[k];
    const b = levels[k + 1];
    for (let y = 0; y < a.h; y++) {
      for (let x = 0; x < a.w; x++) {
        const o = y * a.w + x;
        const wt = a.wt[o];
        if (wt >= 1) continue;
        const up = (y >> 1) * b.w + (x >> 1);
        for (let c = 0; c < 3; c++) a.val[o * 3 + c] = wt * a.val[o * 3 + c] + (1 - wt) * b.val[up * 3 + c];
        a.wt[o] = 1;
      }
    }
  }
  for (let i = 0; i < unknown.length; i++) {
    if (!unknown[i]) continue;
    for (let c = 0; c < 3; c++) plane.data[i * 3 + c] = base.val[i * 3 + c];
  }
}

export interface LaplaceResult {
  plane: Plane;
  iterations: number;
  /** Largest change of the last sweep (gray levels). */
  residual: number;
  filled: number;
  /** False when the image holds no known pixel to fill from. */
  ok: boolean;
}

/**
 * Fills the unknown pixels with the solution of Laplace's equation given the
 * known pixels around them (diffusion; successive over-relaxation from a
 * push-pull start). Reproduces ramps exactly, and suits thin things: wires,
 * rigs, blemishes. Texture inside the hole comes out smooth. Returns a copy.
 */
export async function laplaceFill(plane: Plane, unknown: Uint8Array, opts: { maxIters?: number; tol?: number; tick?: Tick } = {}): Promise<LaplaceResult> {
  const out: Plane = { width: plane.width, height: plane.height, data: new Float32Array(plane.data) };
  const { width: w, height: h } = out;
  const idx: number[] = [];
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let i = 0; i < unknown.length; i++) {
    if (!unknown[i]) continue;
    idx.push(i);
    const x = i % w;
    const y = (i / w) | 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (idx.length === 0) return { plane: out, iterations: 0, residual: 0, filled: 0, ok: true };
  if (idx.length === unknown.length) return { plane: out, iterations: 0, residual: 0, filled: 0, ok: false };
  pushPull(out, unknown);
  const span = Math.max(maxX - minX + 1, maxY - minY + 1);
  const omega = Math.min(1.98, 2 / (1 + Math.sin(Math.PI / (span + 1))));
  const maxIters = opts.maxIters ?? 4000;
  const tol = opts.tol ?? 0.003;
  const d = out.data;
  let residual = 0;
  let it = 0;
  for (; it < maxIters; it++) {
    residual = 0;
    for (let k = 0; k < idx.length; k++) {
      const p = idx[k];
      const x = p % w;
      const y = (p / w) | 0;
      let cnt = 0;
      let s0 = 0;
      let s1 = 0;
      let s2 = 0;
      if (x > 0) {
        s0 += d[(p - 1) * 3];
        s1 += d[(p - 1) * 3 + 1];
        s2 += d[(p - 1) * 3 + 2];
        cnt++;
      }
      if (x < w - 1) {
        s0 += d[(p + 1) * 3];
        s1 += d[(p + 1) * 3 + 1];
        s2 += d[(p + 1) * 3 + 2];
        cnt++;
      }
      if (y > 0) {
        s0 += d[(p - w) * 3];
        s1 += d[(p - w) * 3 + 1];
        s2 += d[(p - w) * 3 + 2];
        cnt++;
      }
      if (y < h - 1) {
        s0 += d[(p + w) * 3];
        s1 += d[(p + w) * 3 + 1];
        s2 += d[(p + w) * 3 + 2];
        cnt++;
      }
      const t0 = d[p * 3] + omega * (s0 / cnt - d[p * 3]);
      const t1 = d[p * 3 + 1] + omega * (s1 / cnt - d[p * 3 + 1]);
      const t2 = d[p * 3 + 2] + omega * (s2 / cnt - d[p * 3 + 2]);
      residual = Math.max(residual, Math.abs(t0 - d[p * 3]), Math.abs(t1 - d[p * 3 + 1]), Math.abs(t2 - d[p * 3 + 2]));
      d[p * 3] = t0;
      d[p * 3 + 1] = t1;
      d[p * 3 + 2] = t2;
    }
    if (residual < tol) {
      it++;
      break;
    }
    if (opts.tick && it % 25 === 24) await opts.tick();
  }
  return { plane: out, iterations: it, residual, filled: idx.length, ok: true };
}

// ---------- the exemplar fill ----------

export interface PatchMatchOptions {
  /** Patch radius in pixels (patch side is 2r + 1). Default 2. */
  patchRadius?: number;
  /** Vote rounds per level. Default 4. */
  emIterations?: number;
  /** Propagation and random-search sweeps per round. Default 3. */
  pmIterations?: number;
  /** 1 or 2 levels (the second is half size). Default 2, used when the crop is at least 24 pixels each way. */
  levels?: 1 | 2;
  seed?: number;
  tick?: Tick;
}

export interface PatchMatchResult {
  plane: Plane;
  levels: number;
  /** Source patches (fully known) the matches could come from. */
  sourcePatches: number;
  /** True when there was nothing to copy from and the harmonic fill was returned instead. */
  fallback: boolean;
}

interface Level {
  w: number;
  h: number;
  plane: Plane;
  unknown: Uint8Array;
}

function integralOf(mask: Uint8Array, w: number, h: number): Int32Array {
  const iw = w + 1;
  const out = new Int32Array(iw * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += mask[y * w + x];
      out[(y + 1) * iw + x + 1] = out[y * iw + x + 1] + row;
    }
  }
  return out;
}

const boxCount = (ii: Int32Array, w: number, x0: number, y0: number, x1: number, y1: number): number => {
  const iw = w + 1;
  return ii[(y1 + 1) * iw + x1 + 1] - ii[y0 * iw + x1 + 1] - ii[(y1 + 1) * iw + x0] + ii[y0 * iw + x0];
};

/** One level of EM: PatchMatch finds, for every patch that touches the hole, its best fully-known source patch; the unknown pixels become the mean of what the covering patches say. */
async function refineLevel(lv: Level, nnf: Int32Array | null, o: Required<Pick<PatchMatchOptions, "patchRadius" | "emIterations" | "pmIterations">> & { rand: () => number; tick?: Tick }): Promise<{ nnf: Int32Array; sources: number }> {
  const { w, h, plane, unknown } = lv;
  const r = o.patchRadius;
  const d = plane.data;
  const ii = integralOf(unknown, w, h);
  const srcOk = new Uint8Array(w * h);
  const srcList: number[] = [];
  const targets: number[] = [];
  for (let y = r; y < h - r; y++) {
    for (let x = r; x < w - r; x++) {
      const touching = boxCount(ii, w, x - r, y - r, x + r, y + r);
      if (touching === 0) {
        srcOk[y * w + x] = 1;
        srcList.push(y * w + x);
      } else {
        targets.push(y * w + x);
      }
    }
  }
  const out = nnf ?? new Int32Array(w * h).fill(-1);
  if (srcList.length === 0 || targets.length === 0) return { nnf: out, sources: srcList.length };

  const cost = (p: number, q: number, best: number): number => {
    const px = p % w;
    const py = (p / w) | 0;
    const qx = q % w;
    const qy = (q / w) | 0;
    let s = 0;
    for (let dy = -r; dy <= r; dy++) {
      let a = ((py + dy) * w + px - r) * 3;
      let b = ((qy + dy) * w + qx - r) * 3;
      for (let k = 0; k < (2 * r + 1) * 3; k++) {
        const e = d[a++] - d[b++];
        s += e * e;
      }
      if (s >= best) return s;
    }
    return s;
  };

  for (const p of targets) {
    const q = out[p];
    if (q < 0 || !srcOk[q]) out[p] = srcList[Math.floor(o.rand() * srcList.length)];
  }
  const acc = new Float32Array(w * h * 3);
  const cnt = new Uint16Array(w * h);
  const searchMax = Math.max(w, h);
  for (let em = 0; em < o.emIterations; em++) {
    for (let pm = 0; pm < o.pmIterations; pm++) {
      const forward = (em + pm) % 2 === 0;
      const dir = forward ? 1 : -1;
      const order = forward ? targets : targets.slice().reverse();
      for (const p of order) {
        let bestQ = out[p];
        let bestC = cost(p, bestQ, Infinity);
        const px = p % w;
        const py = (p / w) | 0;
        const tryQ = (qx: number, qy: number) => {
          if (qx < r || qy < r || qx >= w - r || qy >= h - r) return;
          const q = qy * w + qx;
          if (!srcOk[q] || q === bestQ) return;
          const c = cost(p, q, bestC);
          if (c < bestC) {
            bestC = c;
            bestQ = q;
          }
        };
        // Propagation: the neighbour behind us in the scan, shifted by one pixel.
        const nx = p - dir;
        if (px - dir >= 0 && px - dir < w && out[nx] >= 0) tryQ((out[nx] % w) + dir, (out[nx] / w) | 0);
        const ny = p - dir * w;
        if (ny >= 0 && ny < w * h && out[ny] >= 0) tryQ(out[ny] % w, ((out[ny] / w) | 0) + dir);
        // Random search around the best match, the radius halving.
        const bx = bestQ % w;
        const by = (bestQ / w) | 0;
        for (let rad = searchMax; rad >= 1; rad = Math.floor(rad / 2)) {
          tryQ(Math.round(bx + (o.rand() * 2 - 1) * rad), Math.round(by + (o.rand() * 2 - 1) * rad));
        }
        out[p] = bestQ;
      }
      if (o.tick) await o.tick();
    }
    // Vote: every unknown pixel takes the mean of the matched source pixels that cover it.
    acc.fill(0);
    cnt.fill(0);
    for (const p of targets) {
      const px = p % w;
      const py = (p / w) | 0;
      const q = out[p];
      const qx = q % w;
      const qy = (q / w) | 0;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const u = (py + dy) * w + px + dx;
          if (!unknown[u]) continue;
          const s = ((qy + dy) * w + qx + dx) * 3;
          acc[u * 3] += d[s];
          acc[u * 3 + 1] += d[s + 1];
          acc[u * 3 + 2] += d[s + 2];
          cnt[u]++;
        }
      }
    }
    for (let u = 0; u < w * h; u++) {
      if (!unknown[u] || cnt[u] === 0) continue;
      d[u * 3] = acc[u * 3] / cnt[u];
      d[u * 3 + 1] = acc[u * 3 + 1] / cnt[u];
      d[u * 3 + 2] = acc[u * 3 + 2] / cnt[u];
    }
    if (o.tick) await o.tick();
  }
  return { nnf: out, sources: srcList.length };
}

function halve(lv: Level): Level {
  const w = Math.ceil(lv.w / 2);
  const h = Math.ceil(lv.h / 2);
  const data = new Float32Array(w * h * 3);
  const unknown = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let n = 0;
      const s = [0, 0, 0];
      let anyUnknown = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const xx = Math.min(lv.w - 1, 2 * x + dx);
          const yy = Math.min(lv.h - 1, 2 * y + dy);
          const i = yy * lv.w + xx;
          if (lv.unknown[i]) anyUnknown = 1;
          for (let c = 0; c < 3; c++) s[c] += lv.plane.data[i * 3 + c];
          n++;
        }
      }
      for (let c = 0; c < 3; c++) data[(y * w + x) * 3 + c] = s[c] / n;
      unknown[y * w + x] = anyUnknown;
    }
  }
  return { w, h, plane: { width: w, height: h, data }, unknown };
}

/**
 * An exemplar fill: Wexler-style EM with PatchMatch, coarse to fine on two
 * levels, copying from fully-known patches of the same crop (the ring and the
 * rest of the window). Good for logos and larger objects on texture; it can
 * repeat a pattern and cannot invent what the crop does not show. Returns a copy.
 */
export async function patchMatchFill(plane: Plane, unknown: Uint8Array, opts: PatchMatchOptions = {}): Promise<PatchMatchResult> {
  const r = opts.patchRadius ?? 2;
  const rand = mulberry32(opts.seed ?? 1);
  const shared = { patchRadius: r, emIterations: opts.emIterations ?? 4, pmIterations: opts.pmIterations ?? 3, rand, tick: opts.tick };
  const lap = await laplaceFill(plane, unknown, { tick: opts.tick });
  const full: Level = { w: plane.width, h: plane.height, plane: lap.plane, unknown };
  if (!lap.ok || lap.filled === 0) return { plane: lap.plane, levels: 0, sourcePatches: 0, fallback: !lap.ok };
  const wantTwo = (opts.levels ?? 2) === 2 && Math.min(full.w, full.h) >= 24;
  if (!wantTwo) {
    const res = await refineLevel(full, null, shared);
    return { plane: full.plane, levels: 1, sourcePatches: res.sources, fallback: res.sources === 0 };
  }
  const half = halve(full);
  const halfLap = await laplaceFill(half.plane, half.unknown, { tick: opts.tick });
  half.plane = halfLap.plane;
  const coarse = await refineLevel(half, null, shared);
  // Up to the full level: unknown pixels start from the coarse result, bilinear.
  const cd = half.plane.data;
  for (let y = 0; y < full.h; y++) {
    for (let x = 0; x < full.w; x++) {
      const i = y * full.w + x;
      if (!unknown[i]) continue;
      const fx = Math.min(half.w - 1, Math.max(0, (x + 0.5) / 2 - 0.5));
      const fy = Math.min(half.h - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const x1 = Math.min(half.w - 1, x0 + 1);
      const y1 = Math.min(half.h - 1, y0 + 1);
      const ax = fx - x0;
      const ay = fy - y0;
      for (let c = 0; c < 3; c++) {
        const top = cd[(y0 * half.w + x0) * 3 + c] * (1 - ax) + cd[(y0 * half.w + x1) * 3 + c] * ax;
        const bottom = cd[(y1 * half.w + x0) * 3 + c] * (1 - ax) + cd[(y1 * half.w + x1) * 3 + c] * ax;
        full.plane.data[i * 3 + c] = top * (1 - ay) + bottom * ay;
      }
    }
  }
  // The coarse matches, doubled, start the fine search.
  const seed = new Int32Array(full.w * full.h).fill(-1);
  for (let y = 0; y < full.h; y++) {
    for (let x = 0; x < full.w; x++) {
      const q1 = coarse.nnf[Math.min(half.h - 1, y >> 1) * half.w + Math.min(half.w - 1, x >> 1)];
      if (q1 < 0) continue;
      const qx = (q1 % half.w) * 2 + (x & 1);
      const qy = ((q1 / half.w) | 0) * 2 + (y & 1);
      if (qx < full.w && qy < full.h) seed[y * full.w + x] = qy * full.w + qx;
    }
  }
  const fine = await refineLevel(full, seed, { ...shared, emIterations: Math.max(2, shared.emIterations - 1) });
  return { plane: full.plane, levels: 2, sourcePatches: fine.sources, fallback: fine.sources === 0 };
}

// ---------- the whole job on decoded frames ----------

export interface FillInput {
  /** The reference frame as rendered (the object is in it). */
  ref: RgbaImage;
  comp: { width: number; height: number };
  /** The hole as polygons in comp pixels, not grown. */
  polygons: Pt[][];
  growPx: number;
  method: "temporal" | "spatial" | "auto";
  spatial: "diffuse" | "patch";
  objectMoves: boolean;
  /** Frames to sample and the homography that carries the reference into each. Ignored for method spatial. */
  samples: Array<{ time: number; H: Mat3 }>;
  /** Renders one sample; null when it failed. Not called for method spatial. */
  getFrame: (time: number) => Promise<RgbaImage | null>;
  /** True when the render budget is used up; the fill then uses the samples it has. */
  shouldStop?: () => boolean | "budget" | "render_failures";
  minSamples: number;
  maxSpread: number;
  objectTol: number;
  ringPx: number;
  ringGapPx: number;
  matchColor: boolean;
  tick?: Tick;
}

export interface FillResult {
  /** The whole reference frame with the hole filled. */
  image: RgbaImage;
  crop: { x0: number; y0: number; w: number; h: number };
  /** The reference and the fill over the crop, for previews. */
  refCrop: RgbaImage;
  fillCrop: RgbaImage;
  /** CLS code per crop pixel. */
  classes: Uint8Array;
  stats: {
    hole_pixels: number;
    hole_share: number;
    temporal_share: number;
    temporal_low_confidence_share: number;
    spatial_share: number;
    unfilled_share: number;
    samples_used: number;
    samples_skipped: number;
    samples_color_matched: number;
    samples_color_skipped: number;
    /** Samples left out of the median because their ring fit was refused for a gain out of range. */
    samples_color_rejected: number;
    stopped_by_budget: boolean;
    /** Why sampling ended early: the render budget, or two failed renders in a row. */
    stopped_by: "budget" | "render_failures" | null;
    /** Planned samples that were never rendered because sampling stopped early. */
    samples_not_rendered: number;
    unrevealed_share: number;
    sample_count: { min: number; mean: number; max: number } | null;
    spread_mean: number | null;
    spatial_method: string | null;
    spatial_iterations: number | null;
  };
  notes: string[];
}

const r4 = (v: number): number => Math.round(v * 10000) / 10000;

/** What the render step leaves behind: bounded crops of the reference and the warped samples, no more AE needed. */
export interface Gathered {
  hs: HoleSetup;
  refCrop: RgbaImage;
  samples: RgbaImage[];
  skipped: number;
  matched: number;
  matchSkipped: number;
  matchRejected: number;
  stopped: "budget" | "render_failures" | null;
  notRendered: number;
}

/**
 * The part of the job that needs AE: render, warp and colour-match the samples
 * into crops. Cheap in CPU; run it inside the queue lease. fillFromGathered does
 * the rest in Node alone.
 */
export async function gatherSamples(inp: FillInput): Promise<Gathered> {
  const { ref } = inp;
  const hs = prepareHole(ref.width, ref.height, inp.comp, inp.polygons, inp.growPx, inp.ringGapPx, inp.ringPx);
  if (hs.share > MAX_HOLE_SHARE) {
    throw new InpaintError("refused", `The hole covers ${(hs.share * 100).toFixed(1)}% of the frame; the limit is ${MAX_HOLE_SHARE * 100}%. Fill it in parts.`);
  }
  const { x0, y0, w, h } = hs.crop;
  const refCrop = cropRgba(ref, x0, y0, w, h);
  const total = w * h;
  const samples: RgbaImage[] = [];
  const bbox: Bounds = [x0, y0, x0 + w, y0 + h];
  let skipped = 0;
  let matched = 0;
  let matchSkipped = 0;
  let matchRejected = 0;
  let stopped: "budget" | "render_failures" | null = null;
  let notRendered = 0;

  if (inp.method !== "spatial" && inp.samples.length > 0) {
    for (let si = 0; si < inp.samples.length; si++) {
      const s = inp.samples[si];
      const stop = inp.shouldStop?.();
      if (stop) {
        stopped = stop === "render_failures" ? "render_failures" : "budget";
        notRendered = inp.samples.length - si;
        break;
      }
      const frame = await inp.getFrame(s.time);
      if (!frame || frame.width !== ref.width || frame.height !== ref.height) {
        skipped++;
        continue;
      }
      const warped = warpCrop(frame, s.H, bbox, hs.scale);
      let overlap = 0;
      for (let i = 0; i < total; i++) if (hs.hole[i] && warped.data[i * 4 + 3] === 255) overlap++;
      if (overlap < hs.holePixels * 0.02) {
        skipped++;
        continue;
      }
      if (inp.matchColor) {
        const m = matchColor(warped, refCrop, hs.ring);
        if (m.applied) matched++;
        else if (m.badGain) {
          // A ring that does not match (bad track or parallax) would vote with a wrong exposure: leave the sample out.
          matchRejected++;
          continue;
        } else matchSkipped++;
      }
      samples.push(warped);
      if (inp.tick) await inp.tick();
    }
  }
  return { hs, refCrop, samples, skipped, matched, matchSkipped, matchRejected, stopped, notRendered };
}

/** The Node-only part: the median, the spatial fill and the composite. Needs no AE, so it runs outside the queue. */
export async function fillFromGathered(inp: FillInput, g: Gathered): Promise<FillResult> {
  const { ref } = inp;
  const { hs, refCrop, samples, skipped, matched, matchSkipped, matchRejected, stopped } = g;
  const { x0, y0, w, h } = hs.crop;
  const total = w * h;
  const notes: string[] = [];
  const classes = new Uint8Array(total);
  const plane = planeFromRgba(refCrop);
  let stack: StackResult | null = null;
  if (inp.method !== "spatial" && inp.samples.length > 0) {
    if (samples.length > 0) {
      stack = await medianStack(samples, hs.hole, refCrop, { minSamples: inp.minSamples, maxSpread: inp.maxSpread, objectTol: inp.objectTol, objectMoves: inp.objectMoves, tick: inp.tick });
    }
  }
  if (inp.method === "temporal" && !stack) notes.push("No usable sample frame, so nothing was filled temporally.");

  // The temporal result first: those pixels become known for the spatial pass.
  const unknown = new Uint8Array(total);
  let tempOk = 0;
  let tempLow = 0;
  let countMin = Infinity;
  let countMax = 0;
  let countSum = 0;
  let countN = 0;
  let spreadSum = 0;
  for (let i = 0; i < total; i++) {
    if (!hs.hole[i]) continue;
    if (stack && stack.filled[i]) {
      for (let c = 0; c < 3; c++) plane.data[i * 3 + c] = stack.rgb[i * 3 + c];
      if (stack.lowConfidence[i]) {
        classes[i] = CLS.TEMPORAL_LOW;
        tempLow++;
      } else {
        classes[i] = CLS.TEMPORAL;
        tempOk++;
      }
      const cnt = stack.count[i];
      if (cnt < countMin) countMin = cnt;
      if (cnt > countMax) countMax = cnt;
      countSum += cnt;
      countN++;
      spreadSum += stack.spread[i];
    } else {
      unknown[i] = 1;
    }
  }
  let spatialN = 0;
  let spatialIterations: number | null = null;
  let spatialMethod: string | null = null;
  const remaining = unknown.reduce((a, b) => a + b, 0);
  if (inp.method !== "temporal" && remaining > 0) {
    spatialMethod = inp.spatial;
    let filledPlane: Plane;
    if (inp.spatial === "patch") {
      const res = await patchMatchFill(plane, unknown, { tick: inp.tick });
      filledPlane = res.plane;
      if (res.fallback) notes.push("The crop holds no fully known patch to copy from, so the diffusion fill was used.");
    } else {
      const res = await laplaceFill(plane, unknown, { tick: inp.tick });
      filledPlane = res.plane;
      spatialIterations = res.iterations;
      if (!res.ok) notes.push("The crop holds no known pixel to fill from.");
      else if (res.residual > 0.05) notes.push(`The diffusion fill stopped before it settled (residual ${res.residual.toFixed(3)}).`);
    }
    for (let i = 0; i < total; i++) {
      if (!unknown[i]) continue;
      for (let c = 0; c < 3; c++) plane.data[i * 3 + c] = filledPlane.data[i * 3 + c];
      classes[i] = CLS.SPATIAL;
      spatialN++;
    }
  } else if (remaining > 0) {
    for (let i = 0; i < total; i++) if (unknown[i]) classes[i] = CLS.UNFILLED;
    notes.push(`${remaining} hole pixels were never revealed in the sampled frames and were left as they are (method temporal).`);
  }

  // Composite: the fill replaces the hole; everything else is the reference frame, untouched.
  const fillCrop = planeToRgba(plane);
  for (let i = 0; i < total; i++) {
    if (!hs.hole[i] || classes[i] === CLS.UNFILLED) {
      for (let c = 0; c < 4; c++) fillCrop.data[i * 4 + c] = refCrop.data[i * 4 + c];
    }
  }
  const image: RgbaImage = { width: ref.width, height: ref.height, data: new Uint8Array(ref.data) };
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const i = row * w + col;
      if (!hs.hole[i]) continue;
      const o = ((y0 + row) * ref.width + x0 + col) * 4;
      for (let c = 0; c < 4; c++) image.data[o + c] = fillCrop.data[i * 4 + c];
    }
  }
  if (matchRejected > 0) notes.push(`${matchRejected} sample(s) were left out because the ring around the hole did not match (fitted gain outside 0.5..2: bad track or parallax).`);
  const hp = hs.holePixels;
  const unfilled = hp - tempOk - tempLow - spatialN;
  return {
    image,
    crop: hs.crop,
    refCrop,
    fillCrop,
    classes,
    stats: {
      hole_pixels: hp,
      hole_share: r4(hs.share),
      temporal_share: r4((tempOk + tempLow) / hp),
      temporal_low_confidence_share: r4(tempLow / hp),
      spatial_share: r4(spatialN / hp),
      unfilled_share: r4(unfilled / hp),
      samples_used: samples.length,
      samples_skipped: skipped,
      samples_color_matched: matched,
      samples_color_skipped: matchSkipped,
      samples_color_rejected: matchRejected,
      stopped_by_budget: stopped === "budget",
      stopped_by: stopped,
      samples_not_rendered: g.notRendered,
      unrevealed_share: r4((stack?.unrevealed ?? 0) / hp),
      sample_count: countN ? { min: countMin, mean: r4(countSum / countN), max: countMax } : null,
      spread_mean: countN ? r4(spreadSum / countN) : null,
      spatial_method: spatialMethod,
      spatial_iterations: spatialIterations,
    },
    notes,
  };
}

// ---------- picking frames ----------

/** Up to `max` items spread evenly over the list, first and last included. */
export function spreadPick<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items.slice();
  if (max <= 1) return [items[Math.floor(items.length / 2)]];
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(items[Math.round((i * (items.length - 1)) / (max - 1))]);
  return out;
}

/** Render and fill in one go (no AE between the two steps). */
export async function fillFromFrames(inp: FillInput): Promise<FillResult> {
  return fillFromGathered(inp, await gatherSamples(inp));
}
