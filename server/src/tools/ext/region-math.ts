/**
 * server/src/tools/ext/region-math.ts
 *
 * The pure region helper of the compositing tools (ae_patch_check,
 * ae_region_stats and the wave-4 patch, plate and matte tools that measure or
 * match a region of a frame). It rasterizes shapes, builds masks and rings and
 * measures pixels under a mask. No AE, no files, no imports except two types,
 * so it runs on the panel's Node 17.7.2 and is tested on synthetic images.
 *
 * Coordinates. A polygon is in pixel-EDGE coordinates: pixel (x, y) covers
 * [x, x + 1) by [y, y + 1), which is how comp pixels are written in AE. A
 * point in PIXEL-INDEX coordinates (what track.ts uses: pixel i's centre is at
 * i) is `edge - 0.5`. A homography is a plain number[9], row-major, mapping
 * (x, y) to (h0 x + h1 y + h2, h3 x + h4 y + h5) / (h6 x + h7 y + h8).
 *
 * Gray images (track.ts GrayImage) hold 0..255 values, so noise and energy
 * come back in gray levels (squared for the energy). Colour values in
 * maskedStats and fitGainOffset are 0..1.
 */

import type { RgbaImage } from "./png-utils.js";
import type { GrayImage } from "./track.js";

export type Pt = [number, number];

export type RegionSpec =
  | { kind: "rect"; rect: [number, number, number, number] }
  | { kind: "ellipse"; center: Pt; radius: Pt }
  | { kind: "polygon"; points: Pt[] };

/** [x0, y0, x1, y1]. */
export type Bounds = [number, number, number, number];

// ---------- polygons ----------

/** A region as a polygon. An ellipse becomes `segments` points; a rect its four corners (top-left, top-right, bottom-right, bottom-left). */
export function regionToPolygon(r: RegionSpec, segments = 48): Pt[] {
  if (r.kind === "rect") {
    const [x0, y0, x1, y1] = r.rect;
    return [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ];
  }
  if (r.kind === "ellipse") {
    const n = Math.max(8, Math.round(segments));
    const out: Pt[] = [];
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n;
      out.push([r.center[0] + r.radius[0] * Math.cos(a), r.center[1] + r.radius[1] * Math.sin(a)]);
    }
    return out;
  }
  return r.points.map((p) => [p[0], p[1]] as Pt);
}

/** The polygon through a homography, or null when a point lands on or behind the horizon (w <= 0). */
export function warpPolygon(poly: Pt[], H: number[]): Pt[] | null {
  const out: Pt[] = [];
  for (const [x, y] of poly) {
    const w = H[6] * x + H[7] * y + H[8];
    if (!(w > 1e-9)) return null;
    out.push([(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w]);
  }
  return out;
}

export function polygonBounds(poly: Pt[]): Bounds {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of poly) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

/** Signed area (shoelace); positive when the points run clockwise on screen (y down). */
export function polygonSignedArea(poly: Pt[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

export const polygonArea = (poly: Pt[]): number => Math.abs(polygonSignedArea(poly));

/**
 * Coverage 0..1 of a polygon over a width x height pixel grid, even-odd rule.
 * Each pixel is sampled 4x4, scanline by scanline, so edges are anti-aliased
 * and a pixel is 1 only when fully inside.
 */
export function rasterizePolygon(width: number, height: number, poly: Pt[], featherPx = 0): Float32Array {
  const counts = new Uint8Array(width * height);
  const n = poly.length;
  if (n >= 3 && width > 0 && height > 0) {
    const b = polygonBounds(poly);
    const rowFrom = Math.max(0, Math.floor(b[1]));
    const rowTo = Math.min(height - 1, Math.ceil(b[3]));
    const xs: number[] = [];
    for (let row = rowFrom; row <= rowTo; row++) {
      for (let sy = 0; sy < 4; sy++) {
        const y = row + (sy + 0.5) / 4;
        xs.length = 0;
        for (let i = 0; i < n; i++) {
          const a = poly[i];
          const c = poly[(i + 1) % n];
          // Half-open on y so a vertex shared by two edges counts once.
          if ((a[1] <= y && c[1] > y) || (c[1] <= y && a[1] > y)) {
            xs.push(a[0] + ((y - a[1]) / (c[1] - a[1])) * (c[0] - a[0]));
          }
        }
        xs.sort((p, q) => p - q);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          // Sub-sample columns j have their centre at (j + 0.5) / 4.
          const j0 = Math.max(0, Math.ceil(xs[k] * 4 - 0.5));
          const j1 = Math.min(width * 4, Math.ceil(xs[k + 1] * 4 - 0.5));
          for (let j = j0; j < j1; j++) counts[row * width + (j >> 2)]++;
        }
      }
    }
  }
  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = counts[i] / 16;
  if (featherPx > 0) {
    const sd = signedDistance(out, width, height);
    for (let i = 0; i < out.length; i++) out[i] = Math.max(0, Math.min(1, 0.5 - sd[i] / featherPx));
  }
  return out;
}

// ---------- distance ----------

const FAR = 1e20;

/** One pass of the exact squared-distance transform (Felzenszwalb and Huttenlocher) over a line. */
function edtLine(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -FAR;
  z[1] = FAR;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = FAR;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

/** Distance in pixels from each pixel to the nearest target pixel (0 on a target); 1e6 everywhere when there is none. */
function distanceTo(target: Uint8Array, width: number, height: number): Float32Array {
  const size = Math.max(width, height);
  const f = new Float64Array(size);
  const d = new Float64Array(size);
  const v = new Int32Array(size);
  const z = new Float64Array(size + 1);
  const grid = new Float64Array(width * height);
  let any = false;
  for (let i = 0; i < grid.length; i++) {
    if (target[i]) {
      grid[i] = 0;
      any = true;
    } else {
      grid[i] = FAR;
    }
  }
  const out = new Float32Array(width * height);
  if (!any) return out.fill(1e6);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) f[y] = grid[y * width + x];
    edtLine(f, height, d, v, z);
    for (let y = 0; y < height; y++) grid[y * width + x] = d[y];
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) f[x] = grid[y * width + x];
    edtLine(f, width, d, v, z);
    for (let x = 0; x < width; x++) out[y * width + x] = Math.sqrt(Math.min(d[x], FAR));
  }
  return out;
}

/**
 * Signed distance to the edge of a mask (pixels >= 0.5 are inside): negative
 * inside, positive outside, in pixels, measured from pixel centre to the edge
 * between pixels, so the first pixel on either side of the edge is 0.5 away.
 * Exact (Euclidean), in two separable passes.
 */
export function signedDistance(mask: Float32Array, width: number, height: number): Float32Array {
  const inside = new Uint8Array(width * height);
  const outside = new Uint8Array(width * height);
  for (let i = 0; i < inside.length; i++) {
    if (mask[i] >= 0.5) inside[i] = 1;
    else outside[i] = 1;
  }
  const toInside = distanceTo(inside, width, height);
  const toOutside = distanceTo(outside, width, height);
  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = inside[i] ? -(toOutside[i] - 0.5) : toInside[i] - 0.5;
  return out;
}

/**
 * 1 where the pixel lies between `innerPx` and `outerPx` outside the polygon's
 * edge, else 0. `innerPx` may be negative to straddle the edge (a band that
 * reaches inside the shape).
 */
export function ringMask(width: number, height: number, poly: Pt[], innerPx: number, outerPx: number): Float32Array {
  const sd = signedDistance(rasterizePolygon(width, height, poly), width, height);
  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i++) if (sd[i] >= innerPx && sd[i] <= outerPx) out[i] = 1;
  return out;
}

// ---------- pixel statistics ----------

export interface MaskedStats {
  pixels: number;
  /** Share of the masked pixels that are opaque (alpha >= 250); the share of the REGION that lies in the frame is the caller's to know. */
  visible_share: number;
  mean_rgb: [number, number, number];
  std_rgb: [number, number, number];
  p05_rgb: [number, number, number];
  p50_rgb: [number, number, number];
  p95_rgb: [number, number, number];
  luma_mean: number;
  luma_std: number;
  /** Share of pixels whose brightest channel is at most 2/255. */
  clipped_low: number;
  /** Share of pixels whose darkest channel is at least 253/255. */
  clipped_high: number;
}

const LUMA = [0.2126, 0.7152, 0.0722];

export function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(v: number): number {
  const c = Math.max(0, v);
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

const LIN_LUT = (() => {
  const t = new Float64Array(256);
  for (let i = 0; i < 256; i++) t[i] = srgbToLinear(i / 255);
  return t;
})();

function percentile(hist: Uint32Array, total: number, p: number): number {
  if (total === 0) return 0;
  const target = p * total;
  let acc = 0;
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i];
    if (acc >= target) return i / 255;
  }
  return 1;
}

const EMPTY_STATS: MaskedStats = {
  pixels: 0,
  visible_share: 0,
  mean_rgb: [0, 0, 0],
  std_rgb: [0, 0, 0],
  p05_rgb: [0, 0, 0],
  p50_rgb: [0, 0, 0],
  p95_rgb: [0, 0, 0],
  luma_mean: 0,
  luma_std: 0,
  clipped_low: 0,
  clipped_high: 0,
};

/**
 * Mean, spread and percentiles of the pixels under a mask (mask >= threshold),
 * per channel and for Rec. 709 luma, plus the clipped shares. Colour values are
 * 0..1 on the encoded pixel values; with `linear` the luma figures are taken in
 * linear light (each channel through the sRGB decode first).
 */
export function maskedStats(img: RgbaImage, mask: Float32Array, threshold = 0.5, opts: { linear?: boolean } = {}): MaskedStats {
  const n = img.width * img.height;
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  const sum = [0, 0, 0];
  const sq = [0, 0, 0];
  let lumaSum = 0;
  let lumaSq = 0;
  let pixels = 0;
  let opaque = 0;
  let low = 0;
  let high = 0;
  const d = img.data;
  for (let k = 0; k < n; k++) {
    if (mask[k] < threshold) continue;
    const i = k * 4;
    pixels++;
    if (d[i + 3] >= 250) opaque++;
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    sum[0] += r;
    sum[1] += g;
    sum[2] += b;
    sq[0] += r * r;
    sq[1] += g * g;
    sq[2] += b * b;
    hist[0][r]++;
    hist[1][g]++;
    hist[2][b]++;
    const y = opts.linear
      ? LUMA[0] * LIN_LUT[r] + LUMA[1] * LIN_LUT[g] + LUMA[2] * LIN_LUT[b]
      : (LUMA[0] * r + LUMA[1] * g + LUMA[2] * b) / 255;
    lumaSum += y;
    lumaSq += y * y;
    hist[3][Math.min(255, Math.round(((LUMA[0] * r + LUMA[1] * g + LUMA[2] * b))))]++;
    if (Math.max(r, g, b) <= 2) low++;
    if (Math.min(r, g, b) >= 253) high++;
  }
  if (pixels === 0) return { ...EMPTY_STATS };
  const mean = (c: number) => sum[c] / pixels / 255;
  const std = (c: number) => Math.sqrt(Math.max(0, sq[c] / pixels - (sum[c] / pixels) ** 2)) / 255;
  const pick = (p: number): [number, number, number] => [percentile(hist[0], pixels, p), percentile(hist[1], pixels, p), percentile(hist[2], pixels, p)];
  const lumaMean = lumaSum / pixels;
  return {
    pixels,
    visible_share: opaque / pixels,
    mean_rgb: [mean(0), mean(1), mean(2)],
    std_rgb: [std(0), std(1), std(2)],
    p05_rgb: pick(0.05),
    p50_rgb: pick(0.5),
    p95_rgb: pick(0.95),
    luma_mean: lumaMean,
    luma_std: Math.sqrt(Math.max(0, lumaSq / pixels - lumaMean * lumaMean)),
    clipped_low: low / pixels,
    clipped_high: high / pixels,
  };
}

/**
 * The 5th, 50th and 95th percentile of luma (0..1) under a mask, for callers that want them next to maskedStats.
 * Encoded by default; with `linear` the luma is taken in linear light (each channel through the sRGB decode first),
 * the same space maskedStats uses, so the mean and the percentiles of one object agree.
 */
export function lumaPercentiles(img: RgbaImage, mask: Float32Array, threshold = 0.5, opts: { linear?: boolean } = {}): { p05: number; p50: number; p95: number } {
  if (opts.linear) {
    // Linear luma needs finer bins than 256 steps of encoded value: 4096 bins over 0..1.
    const N = 4096;
    const lh = new Uint32Array(N);
    let lt = 0;
    for (let k = 0; k < img.width * img.height; k++) {
      if (mask[k] < threshold) continue;
      const i = k * 4;
      const y = LUMA[0] * LIN_LUT[img.data[i]] + LUMA[1] * LIN_LUT[img.data[i + 1]] + LUMA[2] * LIN_LUT[img.data[i + 2]];
      lh[Math.min(N - 1, Math.max(0, Math.round(y * (N - 1))))]++;
      lt++;
    }
    const at = (p: number): number => {
      if (lt === 0) return 0;
      let acc = 0;
      for (let b = 0; b < N; b++) {
        acc += lh[b];
        if (acc >= p * lt) return b / (N - 1);
      }
      return 1;
    };
    return { p05: at(0.05), p50: at(0.5), p95: at(0.95) };
  }
  const hist = new Uint32Array(256);
  let total = 0;
  for (let k = 0; k < img.width * img.height; k++) {
    if (mask[k] < threshold) continue;
    const i = k * 4;
    hist[Math.min(255, Math.round(LUMA[0] * img.data[i] + LUMA[1] * img.data[i + 1] + LUMA[2] * img.data[i + 2]))]++;
    total++;
  }
  return { p05: percentile(hist, total, 0.05), p50: percentile(hist, total, 0.5), p95: percentile(hist, total, 0.95) };
}

// ---------- noise, sharpness, blur ----------

const median = (a: number[]): number => {
  if (a.length === 0) return 0;
  const s = Float64Array.from(a).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Median absolute deviation about the median, scaled to a Gaussian sigma. */
function madSigma(a: number[]): number {
  if (a.length === 0) return 0;
  const m = median(a);
  return 1.4826 * median(a.map((v) => Math.abs(v - m)));
}

/**
 * Noise sigma (gray levels) under a mask. The residual is Immerkaer's 3x3
 * Laplacian (it cancels flat areas and ramps; white noise of sigma s gives a
 * residual of 6 s), the estimate its MAD, and only the calmer 60% of pixels by
 * gradient are used so edges and texture don't count as noise. Needs a mask
 * that holds at least ~50 interior pixels, else it returns 0.
 */
export function noiseSigma(gray: GrayImage, mask: Float32Array): number {
  const { width: w, height: h, data } = gray;
  const res: number[] = [];
  const grad: number[] = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const k = y * w + x;
      if (mask[k] < 0.5) continue;
      const lap =
        data[k - w - 1] - 2 * data[k - w] + data[k - w + 1] - 2 * data[k - 1] + 4 * data[k] - 2 * data[k + 1] + data[k + w - 1] - 2 * data[k + w] + data[k + w + 1];
      res.push(lap);
      grad.push(Math.abs(data[k + 1] - data[k - 1]) + Math.abs(data[k + w] - data[k - w]));
    }
  }
  if (res.length < 50) return 0;
  const limit = [...grad].sort((a, b) => a - b)[Math.floor(grad.length * 0.6)];
  const calm: number[] = [];
  for (let i = 0; i < res.length; i++) if (grad[i] <= limit) calm.push(res[i]);
  return madSigma(calm) / 6;
}

/** Mean squared 4-neighbour Laplacian under a mask (gray levels squared): how much fine detail the region holds. Noise adds to it. */
export function laplacianEnergy(gray: GrayImage, mask: Float32Array): number {
  const { width: w, height: h, data } = gray;
  let sum = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const k = y * w + x;
      if (mask[k] < 0.5) continue;
      const lap = data[k - 1] + data[k + 1] + data[k - w] + data[k + w] - 4 * data[k];
      sum += lap * lap;
      n++;
    }
  }
  return n > 0 ? sum / n : 0;
}

/**
 * Temporal noise sigma (gray levels): the MAD-based sigma of the difference of
 * two aligned frames under a mask, over sqrt 2. The MAD shrugs off the few
 * pixels that moved; a shot with real motion over the whole mask is not
 * measurable this way (the caller checks it against the spatial noise).
 */
export function temporalNoise(a: GrayImage, b: GrayImage, mask: Float32Array): number {
  const n = Math.min(a.data.length, b.data.length, mask.length);
  const diff: number[] = [];
  for (let k = 0; k < n; k++) if (mask[k] >= 0.5) diff.push(a.data[k] - b.data[k]);
  if (diff.length < 50) return 0;
  return madSigma(diff) / Math.SQRT2;
}

/** A separable Gaussian blur with clamped edges. A sigma under 0.05 returns a copy. */
export function gaussianBlurGray(gray: GrayImage, sigma: number): GrayImage {
  const { width: w, height: h } = gray;
  if (!(sigma >= 0.05)) return { width: w, height: h, data: Float32Array.from(gray.data) };
  const r = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(2 * r + 1);
  let total = 0;
  for (let i = -r; i <= r; i++) {
    kernel[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
    total += kernel[i + r];
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= total;
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += kernel[i + r] * gray.data[y * w + Math.min(w - 1, Math.max(0, x + i))];
      tmp[y * w + x] = s;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += kernel[i + r] * tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x];
      out[y * w + x] = s;
    }
  }
  return { width: w, height: h, data: out };
}

// ---------- crops ----------

/** The pixels of `img` inside `bounds` grown by `margin`, clipped to the image, with the crop's offset. Null when nothing is left. */
export function cropToBounds(img: RgbaImage, bounds: Bounds, margin: number): { img: RgbaImage; x0: number; y0: number } | null {
  const x0 = Math.max(0, Math.floor(bounds[0] - margin));
  const y0 = Math.max(0, Math.floor(bounds[1] - margin));
  const x1 = Math.min(img.width, Math.ceil(bounds[2] + margin));
  const y1 = Math.min(img.height, Math.ceil(bounds[3] + margin));
  if (x1 <= x0 || y1 <= y0) return null;
  const w = x1 - x0;
  const h = y1 - y0;
  const data = Buffer.alloc(w * h * 4);
  for (let row = 0; row < h; row++) {
    const si = ((y0 + row) * img.width + x0) * 4;
    for (let k = 0; k < w * 4; k++) data[row * w * 4 + k] = img.data[si + k];
  }
  return { img: { width: w, height: h, data }, x0, y0 };
}

// ---------- colour fit ----------

/**
 * Per channel least squares for `gain * img + offset ~ ref` under the mask
 * (values 0..1). The worst `trimPct` percent of pixels by residual are dropped
 * and the fit is repeated once. With `excludeClipped`, pixels where either image
 * has a channel at or below 0.01 or at or above 0.99 are left out first. A flat
 * `img` has no gain to find: gain 1 and the mean difference as offset.
 */
export function fitGainOffset(
  ref: RgbaImage,
  img: RgbaImage,
  mask: Float32Array,
  opts: { trimPct: number; excludeClipped: boolean }
): { gain: [number, number, number]; offset: [number, number, number]; rms: number; pixels: number } {
  const n = Math.min(ref.width * ref.height, img.width * img.height, mask.length);
  const idx: number[] = [];
  for (let k = 0; k < n; k++) {
    if (mask[k] < 0.5) continue;
    if (opts.excludeClipped) {
      let clipped = false;
      for (let c = 0; c < 3 && !clipped; c++) {
        const a = ref.data[k * 4 + c] / 255;
        const b = img.data[k * 4 + c] / 255;
        if (a <= 0.01 || a >= 0.99 || b <= 0.01 || b >= 0.99) clipped = true;
      }
      if (clipped) continue;
    }
    idx.push(k);
  }
  const gain: [number, number, number] = [1, 1, 1];
  const offset: [number, number, number] = [0, 0, 0];
  if (idx.length === 0) return { gain, offset, rms: 0, pixels: 0 };
  let sqErr = 0;
  let used = 0;
  for (let c = 0; c < 3; c++) {
    const fit = (list: number[]) => {
      let sx = 0;
      let sy = 0;
      let sxx = 0;
      let sxy = 0;
      for (const k of list) {
        const x = img.data[k * 4 + c] / 255;
        const y = ref.data[k * 4 + c] / 255;
        sx += x;
        sy += y;
        sxx += x * x;
        sxy += x * y;
      }
      const m = list.length;
      const varX = sxx - (sx * sx) / m;
      if (varX < 1e-9 * m) return { g: 1, o: (sy - sx) / m };
      const g = (sxy - (sx * sy) / m) / varX;
      return { g, o: (sy - g * sx) / m };
    };
    const resid = (k: number, f: { g: number; o: number }) => f.g * (img.data[k * 4 + c] / 255) + f.o - ref.data[k * 4 + c] / 255;
    let f = fit(idx);
    let keep = idx;
    if (opts.trimPct > 0 && idx.length > 10) {
      const order = idx.map((k) => ({ k, e: Math.abs(resid(k, f)) })).sort((a, b) => a.e - b.e);
      keep = order.slice(0, Math.max(3, Math.ceil(order.length * (1 - opts.trimPct / 100)))).map((o) => o.k);
      f = fit(keep);
    }
    gain[c] = f.g;
    offset[c] = f.o;
    for (const k of keep) {
      const e = resid(k, f);
      sqErr += e * e;
      used++;
    }
    if (c === 2) used = Math.max(1, used);
  }
  return { gain, offset, rms: Math.sqrt(sqErr / Math.max(1, used)), pixels: idx.length };
}

// ---------- seams ----------

function sampleBilinear(g: GrayImage, x: number, y: number): number {
  // Pixel-index coordinates; NaN when the point leaves the image.
  if (x < 0 || y < 0 || x > g.width - 1 || y > g.height - 1) return NaN;
  const x0 = Math.min(g.width - 2, Math.floor(x));
  const y0 = Math.min(g.height - 2, Math.floor(y));
  if (g.width < 2 || g.height < 2) return g.data[Math.round(y) * g.width + Math.round(x)];
  const fx = x - x0;
  const fy = y - y0;
  const i = y0 * g.width + x0;
  const top = g.data[i] * (1 - fx) + g.data[i + 1] * fx;
  const bottom = g.data[i + g.width] * (1 - fx) + g.data[i + g.width + 1] * fx;
  return top * (1 - fy) + bottom * fy;
}

export interface SeamResult {
  /** The largest chunk score: 1 is texture, above 1.5 an edge you can see. 0 when nothing was measurable. */
  score: number;
  /** The stretch of the outline with the highest score, in the polygon's coordinates. */
  worst_segment: { from: Pt; to: Pt; score: number } | null;
  /** How many stretches of the outline were measured. */
  chunks: number;
}

/**
 * How visible the outline of a patch is in a gray image. Along the polygon,
 * the biggest one-pixel step across the edge (within a pixel and a half of it)
 * is compared with the same statistic at control spots further out on both
 * sides, in the ring. Averaged over stretches of the outline; the worst
 * stretch is the score. A clean noisy plate scores about 1 whatever its
 * grain; a visible edge scores 1.5 or more. `poly` is in pixel-edge
 * coordinates of `gray`.
 */
export function seamScore(gray: GrayImage, poly: Pt[], ringPx: number): SeamResult {
  const n = poly.length;
  const none: SeamResult = { score: 0, worst_segment: null, chunks: 0 };
  if (n < 3) return none;
  // The outward normal is a quarter turn from the direction of travel: which turn depends on the winding.
  const turn = polygonSignedArea(poly) >= 0 ? -1 : 1;
  const reach = Math.max(7, Math.round(ringPx));
  const CHUNK = 32;
  const FLOOR = 0.5;
  let edgeSum = 0;
  let ctrlSum = 0;
  let count = 0;
  let from: Pt | null = null;
  let last: Pt | null = null;
  let best = -1;
  let bestSeg: SeamResult["worst_segment"] = null;
  let chunks = 0;
  const flush = () => {
    if (count >= CHUNK / 2 && from && last) {
      const score = edgeSum / count / (ctrlSum / count + FLOOR);
      chunks++;
      if (score > best) {
        best = score;
        bestSeg = { from, to: last, score };
      }
    }
    edgeSum = 0;
    ctrlSum = 0;
    count = 0;
    from = null;
  };
  // The statistic: the largest of three consecutive one-pixel steps along the normal, starting at offset j0.
  const stat = (px: number, py: number, nx: number, ny: number, j0: number): number => {
    let m = 0;
    for (let s = 0; s < 3; s++) {
      const a = sampleBilinear(gray, px + nx * (j0 + s) - 0.5, py + ny * (j0 + s) - 0.5);
      const b = sampleBilinear(gray, px + nx * (j0 + s + 1) - 0.5, py + ny * (j0 + s + 1) - 0.5);
      if (Number.isNaN(a) || Number.isNaN(b)) return NaN;
      m = Math.max(m, Math.abs(b - a));
    }
    return m;
  };
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-6) continue;
    const dx = (b[0] - a[0]) / len;
    const dy = (b[1] - a[1]) / len;
    const nx = -dy * turn;
    const ny = dx * turn;
    for (let s = 0; s < len; s++) {
      const px = a[0] + dx * (s + 0.5);
      const py = a[1] + dy * (s + 0.5);
      const edge = stat(px, py, nx, ny, -1.5);
      // Control spots at several distances on both sides: the same statistic where only texture is.
      let ctrlTotal = 0;
      let ctrlN = 0;
      for (let j0 = 4.5; j0 + 3 <= reach || j0 === 4.5; j0 += 3) {
        const outer = stat(px, py, nx, ny, j0);
        const inner = stat(px, py, nx, ny, -j0 - 3);
        if (!Number.isNaN(outer)) {
          ctrlTotal += outer;
          ctrlN++;
        }
        if (!Number.isNaN(inner)) {
          ctrlTotal += inner;
          ctrlN++;
        }
      }
      if (Number.isNaN(edge) || ctrlN === 0) continue;
      const ctrl = ctrlTotal / ctrlN;
      if (!from) from = [px, py];
      last = [px, py];
      edgeSum += edge;
      ctrlSum += ctrl;
      count++;
      if (count >= CHUNK) flush();
    }
  }
  flush();
  if (chunks === 0 || !bestSeg) return none;
  return { score: best, worst_segment: bestSeg, chunks };
}

/**
 * The polygon moved outward by `d` pixels (inward when d is negative): each vertex along the bisector of its two
 * edges, the miter capped at three times d so a sharp corner does not shoot off. Straight-edged shapes (rectangles,
 * quads) come out exact; a curve sampled finely comes out right to a fraction of a pixel. A polygon of fewer than
 * 3 points, or d of 0, comes back unchanged.
 */
export function offsetPolygon(poly: Pt[], d: number): Pt[] {
  if (poly.length < 3 || d === 0 || !Number.isFinite(d)) return poly;
  // A positive shoelace area runs clockwise on screen; the outward normal of an edge (ex, ey) is then (ey, -ex).
  const sign = polygonSignedArea(poly) > 0 ? 1 : -1;
  const n = poly.length;
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = poly[(i + n - 1) % n];
    const b = poly[i];
    const c = poly[(i + 1) % n];
    const e1: Pt = [b[0] - a[0], b[1] - a[1]];
    const e2: Pt = [c[0] - b[0], c[1] - b[1]];
    const l1 = Math.hypot(e1[0], e1[1]);
    const l2 = Math.hypot(e2[0], e2[1]);
    if (l1 < 1e-9 || l2 < 1e-9) {
      out.push([b[0], b[1]]);
      continue;
    }
    // Outward normals of the two edges.
    const n1: Pt = [(sign * e1[1]) / l1, (-sign * e1[0]) / l1];
    const n2: Pt = [(sign * e2[1]) / l2, (-sign * e2[0]) / l2];
    let mx = n1[0] + n2[0];
    let my = n1[1] + n2[1];
    const ml = Math.hypot(mx, my);
    if (ml < 1e-9) {
      out.push([b[0] + n1[0] * d, b[1] + n1[1] * d]);
      continue;
    }
    mx /= ml;
    my /= ml;
    const cos = Math.max(1 / 3, mx * n1[0] + my * n1[1]);
    out.push([b[0] + (mx * d) / cos, b[1] + (my * d) / cos]);
  }
  return out;
}
