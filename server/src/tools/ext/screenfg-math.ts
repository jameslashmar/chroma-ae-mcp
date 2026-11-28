/**
 * server/src/tools/ext/screenfg-math.ts
 *
 * The measuring behind ae_screen_foreground, pure and unit-tested:
 * - the key colour of a green or blue screen inside the insert's area;
 * - which pixels are surely screen and surely something in front of it;
 * - Keylight's Clip Black / Clip White from its raw matte on those pixels;
 * - the edge-wrap map AE builds (1 - alpha, Fast Box Blur x3, times alpha) and the
 *   strength of the old screen's bleed into the subject's edge, fitted on it;
 * - how fast the insert's corners move.
 *
 * Measured on the Hollywood Camera Work "Laptop" plate (AE 27.0, a green laptop
 * screen with a hand in front): Keylight's raw matte left the hand 9-14% see-through
 * (alpha 0.86-0.92 inside the skin) and 7-12% of the screen behind (alpha 0.07-0.12),
 * so both clips are needed; Key Cleaner (edge radius 10) put a half-transparent ring
 * round the fingers; Advanced Spill Suppressor moved skin with no spill on it by up to
 * +13 levels of blue. The subject's edge, 0-4 px deep, was 8-13 levels greener than
 * its middle: the old screen bleeding in, which this module measures so that the tool
 * can take it out and put the new screen in by the same amount.
 */

import type { RgbaImage } from "./png-utils.js";
import type { Vec2 } from "./planar-math.js";

export type Rgb = [number, number, number];

export interface KeyColour {
  /** The screen's colour, 0..1 per channel (sRGB display values). */
  rgb: Rgb;
  /** 1: green screen, 2: blue screen. */
  dom: 1 | 2;
  /** The screen's own excess: its dominant channel over the larger of the other two, 0..1. */
  excess: number;
  /** Pixels the colour was taken from. */
  pixels: number;
  /** The share of the inside that is the key colour. */
  coverage: number;
}

/** How far the dominant channel is above the larger of the other two, 0..1. */
export function excessOf(r: number, g: number, b: number, dom: 1 | 2): number {
  return dom === 1 ? g - Math.max(r, b) : b - Math.max(r, g);
}

function quantile(sorted: Float32Array | number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = Math.min(sorted.length - 1, Math.max(0, q * (sorted.length - 1)));
  const lo = Math.floor(pos);
  const hi = Math.min(sorted.length - 1, lo + 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function sortedOf(values: number[]): Float32Array {
  const a = Float32Array.from(values);
  a.sort();
  return a;
}

/** A 0/1 mask from an image's alpha: 1 where alpha is at least `threshold` (0..255). */
export function maskFromAlpha(img: RgbaImage, threshold = 128): Uint8Array {
  const n = img.width * img.height;
  const m = new Uint8Array(n);
  for (let i = 0; i < n; i++) m[i] = img.data[i * 4 + 3] >= threshold ? 1 : 0;
  return m;
}

/** Alpha 0..1 of an image. */
export function alphaOf(img: RgbaImage): Float32Array {
  const n = img.width * img.height;
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = img.data[i * 4 + 3] / 255;
  return a;
}

/** Square erosion by `r` pixels (a pixel stays 1 only if every pixel within r, in x and y, is 1). Outside the image counts as 0. */
export function erode(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return mask.slice();
  return minMax(mask, w, h, Math.round(r), true);
}

/** Square dilation by `r` pixels. */
export function dilate(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return mask.slice();
  return minMax(mask, w, h, Math.round(r), false);
}

/** Separable running min (erode) or max (dilate) of a 0/1 mask, by counting the ones in a window. */
function minMax(mask: Uint8Array, w: number, h: number, r: number, isMin: boolean): Uint8Array {
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  const win = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let count = 0;
    const row = y * w;
    for (let x = -r; x <= r; x++) if (x >= 0 && x < w) count += mask[row + x];
    for (let x = 0; x < w; x++) {
      // Out-of-image pixels are 0: for the min they make the window fail, for the max they add nothing.
      tmp[row + x] = isMin ? (count === win ? 1 : 0) : count > 0 ? 1 : 0;
      const add = x + r + 1;
      const drop = x - r;
      if (add < w) count += mask[row + add];
      if (drop >= 0) count -= mask[row + drop];
    }
  }
  for (let x = 0; x < w; x++) {
    let count = 0;
    for (let y = -r; y <= r; y++) if (y >= 0 && y < h) count += tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = isMin ? (count === win ? 1 : 0) : count > 0 ? 1 : 0;
      const add = y + r + 1;
      const drop = y - r;
      if (add < h) count += tmp[add * w + x];
      if (drop >= 0) count -= tmp[drop * w + x];
    }
  }
  return out;
}

/**
 * The key colour inside `inside` over one or more frames: the dominant channel the most
 * saturated inside pixels share (green or blue only), and the per-channel median of the pixels
 * that are clearly that colour (excess at least 0.6 of the 90th percentile, so shading and
 * half-covered edges do not pull it). Null when the inside is not mostly a key colour: under
 * 25% of it, or an excess under 0.1, which is a screen showing a picture, not a key.
 */
export function screenColourInside(frames: Array<{ img: RgbaImage; inside: Uint8Array }>, step = 2): KeyColour | null {
  const votes = [0, 0, 0];
  let insideCount = 0;
  for (const { img, inside } of frames) {
    const d = img.data;
    for (let y = 0; y < img.height; y += step) {
      for (let x = 0; x < img.width; x += step) {
        const i = y * img.width + x;
        if (!inside[i]) continue;
        insideCount++;
        const r = d[i * 4] / 255;
        const g = d[i * 4 + 1] / 255;
        const b = d[i * 4 + 2] / 255;
        const mx = Math.max(r, g, b);
        if (mx - Math.min(r, g, b) < 0.15) continue;
        votes[mx === g ? 1 : mx === b ? 2 : 0]++;
      }
    }
  }
  if (insideCount === 0) return null;
  const dom: 1 | 2 = votes[1] >= votes[2] ? 1 : 2;
  if (votes[0] > votes[dom]) return null;
  const ex: number[] = [];
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  for (const { img, inside } of frames) {
    const d = img.data;
    for (let y = 0; y < img.height; y += step) {
      for (let x = 0; x < img.width; x += step) {
        const i = y * img.width + x;
        if (!inside[i]) continue;
        const r = d[i * 4] / 255;
        const g = d[i * 4 + 1] / 255;
        const b = d[i * 4 + 2] / 255;
        const e = excessOf(r, g, b, dom);
        if (e <= 0.08) continue;
        ex.push(e);
        rs.push(r);
        gs.push(g);
        bs.push(b);
      }
    }
  }
  const coverage = ex.length / insideCount;
  if (ex.length === 0 || coverage < 0.25) return null;
  const p90 = quantile(sortedOf(ex), 0.9);
  const keepR: number[] = [];
  const keepG: number[] = [];
  const keepB: number[] = [];
  for (let k = 0; k < ex.length; k++) {
    if (ex[k] >= 0.6 * p90) {
      keepR.push(rs[k]);
      keepG.push(gs[k]);
      keepB.push(bs[k]);
    }
  }
  const rgb: Rgb = [quantile(sortedOf(keepR), 0.5), quantile(sortedOf(keepG), 0.5), quantile(sortedOf(keepB), 0.5)];
  const excess = excessOf(rgb[0], rgb[1], rgb[2], dom);
  if (!(excess >= 0.1)) return null;
  return { rgb, dom, excess, pixels: keepR.length, coverage };
}

/**
 * Sure screen and sure foreground inside the area, from the plate alone (so the clips are
 * judged against something Keylight did not make): screen where the excess is at least 0.6
 * of the screen's own, foreground where it is at most 0.15 of it (skin, sleeves, a pen; a
 * shadow on the screen sits between and is neither). Both eroded, so no edge pixel counts.
 */
export function classify(img: RgbaImage, inside: Uint8Array, key: KeyColour, erodePx = 3): { screen: Uint8Array; fg: Uint8Array } {
  const n = img.width * img.height;
  const s = new Uint8Array(n);
  const f = new Uint8Array(n);
  const d = img.data;
  for (let i = 0; i < n; i++) {
    if (!inside[i]) continue;
    const e = excessOf(d[i * 4] / 255, d[i * 4 + 1] / 255, d[i * 4 + 2] / 255, key.dom);
    if (e >= 0.6 * key.excess) s[i] = 1;
    else if (e <= 0.15 * key.excess) f[i] = 1;
  }
  return { screen: erode(s, img.width, img.height, Math.max(1, erodePx - 1)), fg: erode(f, img.width, img.height, erodePx) };
}

export interface ClipPlan {
  /** Keylight Clip Black, 0..100. */
  black: number;
  /** Keylight Clip White, 0..100, or null when too little foreground was seen to judge it. */
  white: number | null;
  screen_px: number;
  fg_px: number;
  /** 99.5th percentile of the raw matte on sure screen (what the old screen still shows). */
  screen_alpha_p995: number | null;
  /** 0.5th percentile of the raw matte on sure foreground (how see-through the subject is). */
  fg_alpha_p005: number | null;
}

/** The fewest sure-foreground pixels Clip White is judged on. */
export const MIN_FG_PX = 300;

/**
 * Clip Black just above what is left of the screen (99.5th percentile of the raw matte there,
 * plus 2), at most 50; Clip White just under the most see-through sure foreground (0.5th
 * percentile, less 2), at least Clip Black + 20. Alpha is 0..1.
 */
export function clipsFrom(samples: Array<{ alpha: Float32Array; screen: Uint8Array; fg: Uint8Array }>): ClipPlan {
  const sv: number[] = [];
  const fv: number[] = [];
  for (const s of samples) {
    for (let i = 0; i < s.alpha.length; i++) {
      if (s.screen[i]) sv.push(s.alpha[i]);
      else if (s.fg[i]) fv.push(s.alpha[i]);
    }
  }
  const sp = sv.length ? quantile(sortedOf(sv), 0.995) : null;
  const fp = fv.length ? quantile(sortedOf(fv), 0.005) : null;
  const black = sp === null ? 0 : clamp(round1(sp * 100 + 2), 0, 50);
  const white = fp === null || fv.length < MIN_FG_PX ? null : clamp(round1(fp * 100 - 2), Math.min(100, black + 20), 100);
  return { black, white, screen_px: sv.length, fg_px: fv.length, screen_alpha_p995: sp === null ? null : round4(sp), fg_alpha_p005: fp === null ? null : round4(fp) };
}

/** Keylight's clipped matte from its raw one: (a - black) / (white - black), in 0..1; black and white 0..100. */
export function clipAlpha(raw: Float32Array, black: number, white: number): Float32Array {
  const lo = black / 100;
  const span = Math.max(1e-3, white / 100 - lo);
  const out = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = clamp((raw[i] - lo) / span, 0, 1);
  return out;
}

/** One box pass of width 2r+1 along rows then columns, edge pixels repeated (Fast Box Blur's Repeat Edge Pixels). */
function boxPass(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const win = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[row + clamp(k, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / win;
      sum += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += tmp[clamp(k, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / win;
      sum += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

/** Fast Box Blur with Iterations 3, as AE's (radius r, box width 2r+1 per pass). */
export function boxBlur3(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const rr = Math.max(0, Math.round(r));
  if (rr === 0) return src.slice();
  return boxPass(boxPass(boxPass(src, w, h, rr), w, h, rr), w, h, rr);
}

/** The wrap map the tool builds in AE: blur(1 - alpha) times alpha, so it lives just inside the subject's edge. */
export function wrapMapOf(alpha: Float32Array, w: number, h: number, r: number): Float32Array {
  const inv = new Float32Array(alpha.length);
  for (let i = 0; i < alpha.length; i++) inv[i] = 1 - alpha[i];
  const b = boxBlur3(inv, w, h, r);
  for (let i = 0; i < b.length; i++) b[i] *= alpha[i];
  return b;
}

/** Sum of `v` where `m` is set, and the count, over a square window of radius r, by integral images. */
function windowMean(v: Float32Array, m: Uint8Array, w: number, h: number, r: number): { mean: Float32Array; count: Float32Array } {
  const W = w + 1;
  const sv = new Float64Array(W * (h + 1));
  const sc = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let rv = 0;
    let rc = 0;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (m[i]) {
        rv += v[i];
        rc += 1;
      }
      sv[(y + 1) * W + x + 1] = sv[y * W + x + 1] + rv;
      sc[(y + 1) * W + x + 1] = sc[y * W + x + 1] + rc;
    }
  }
  const mean = new Float32Array(w * h);
  const count = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const c = sc[y1 * W + x1] - sc[y0 * W + x1] - sc[y1 * W + x0] + sc[y0 * W + x0];
      const s = sv[y1 * W + x1] - sv[y0 * W + x1] - sv[y1 * W + x0] + sv[y0 * W + x0];
      count[y * w + x] = c;
      mean[y * w + x] = c > 0 ? s / c : 0;
    }
  }
  return { mean, count };
}

export interface WrapFit {
  /** Opacity of the two wrap layers, 0..1: how much of the old screen is in the subject's edge, per unit of map. */
  strength: number;
  /** The wrap map's Fast Box Blur radius (px of the rendered frames). */
  radius: number;
  /** Share of the edge's screen content the fit explains, 0..1. */
  r2: number;
  /** Edge pixels the fit used. */
  rim_px: number;
  /** The least-squares strength before it was held to what a layer's opacity can do (at most 1). */
  unclamped: number;
  /** Mean share of the old screen in the edge pixels, as the plate shows it, %. */
  rim_screen_pct: number;
  per_radius: Array<{ radius: number; strength: number; r2: number; rim_px: number }>;
}

/** Strengths the fit may pick a radius at: a layer's opacity stops at 100%, and a little over is still nearly met. */
export const MAX_WRAP_FIT = 1.1;

/**
 * The share of the screen colour in each pixel over the subject's own colour nearby, independent
 * of brightness (a finger's edge is darker than its middle, which alone moves the key channel's
 * excess): with e the excess and L the mean of R, G and B, the subject's chromaticity n = e / L is
 * taken from core pixels (alpha 1, no map, inside) in a window, and the pixel is read as the
 * subject plus k x the screen: (e - kE) / (L - kL_S) = n, so k = (e - nL) / (E - nL_S).
 */
function screenShare(img: RgbaImage, alpha: Float32Array, inside: Uint8Array, W: Float32Array, key: KeyColour, r: number): { k: Float32Array; ok: Uint8Array } {
  const { width: w, height: h, data: d } = img;
  const n = w * h;
  const e = new Float32Array(n);
  const L = new Float32Array(n);
  const chroma = new Float32Array(n);
  const core = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const R = d[i * 4] / 255;
    const G = d[i * 4 + 1] / 255;
    const B = d[i * 4 + 2] / 255;
    e[i] = excessOf(R, G, B, key.dom);
    L[i] = (R + G + B) / 3;
    chroma[i] = L[i] > 1e-3 ? e[i] / L[i] : 0;
    core[i] = alpha[i] >= 0.999 && W[i] < 0.005 && inside[i] && L[i] > 0.05 ? 1 : 0;
  }
  const base = windowMean(chroma, core, w, h, 3 * r + 15);
  const LS = (key.rgb[0] + key.rgb[1] + key.rgb[2]) / 3;
  const k = new Float32Array(n);
  const ok = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!inside[i] || alpha[i] <= 0.5 || W[i] <= 0.01 || base.count[i] < 10) continue;
    const den = key.excess - base.mean[i] * LS;
    if (!(den > 0.02)) continue;
    k[i] = (e[i] - base.mean[i] * L[i]) / den;
    ok[i] = 1;
  }
  return { k, ok };
}

/**
 * How much of the old screen is in the subject's edge on the plate, against the wrap map the
 * tool builds: per edge pixel (clipped alpha over 0.5, map over 0.01, inside) the screen share
 * k (see screenShare), fitted as strength x map. Subtracting strength x map x the screen colour
 * takes that out; the same strength of the blurred new screen goes in. The radius with the best
 * fit among those whose strength a layer's opacity can reach (MAX_WRAP_FIT) wins; strength is
 * held to 0..1. Null when no edge was seen.
 */
export function fitWrap(frames: Array<{ plate: RgbaImage; alpha: Float32Array; inside: Uint8Array }>, key: KeyColour, radii: number[]): WrapFit | null {
  const per: Array<{ radius: number; strength: number; r2: number; rim_px: number; sy: number }> = [];
  for (const r of radii) {
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    let sy = 0;
    let n = 0;
    for (const f of frames) {
      const { width: w, height: h } = f.plate;
      const W = wrapMapOf(f.alpha, w, h, r);
      const share = screenShare(f.plate, f.alpha, f.inside, W, key, r);
      for (let i = 0; i < w * h; i++) {
        if (!share.ok[i]) continue;
        const x = W[i];
        const y = share.k[i];
        sxy += x * y;
        sxx += x * x;
        syy += y * y;
        sy += y;
        n++;
      }
    }
    if (n === 0 || sxx <= 0) continue;
    const k = sxy / sxx;
    const res = syy - 2 * k * sxy + k * k * sxx;
    per.push({ radius: r, strength: k, r2: syy > 0 ? 1 - res / syy : 0, rim_px: n, sy: sy / n });
  }
  if (per.length === 0) return null;
  const reachable = per.filter((p) => p.strength <= MAX_WRAP_FIT);
  const pool = reachable.length ? reachable : [per.reduce((a, b) => (b.radius > a.radius ? b : a))];
  const best = pool.reduce((a, b) => (b.r2 > a.r2 ? b : a));
  return {
    strength: round4(clamp(best.strength, 0, 1)),
    radius: best.radius,
    r2: round4(best.r2),
    rim_px: best.rim_px,
    unclamped: round4(best.strength),
    rim_screen_pct: round2(best.sy * 100),
    per_radius: per.map((p) => ({ radius: p.radius, strength: round4(p.strength), r2: round4(p.r2), rim_px: p.rim_px })),
  };
}

/**
 * The mean screen share of the subject's edge (see screenShare), %: on the plate it is the old
 * screen in the edge; on the finished comp, where the new screen is in the edge instead, it falls
 * by as much as the new screen's colour differs from the old one.
 */
export function rimExcess(img: RgbaImage, alpha: Float32Array, inside: Uint8Array, key: KeyColour, r: number): { pct: number; px: number } {
  const W = wrapMapOf(alpha, img.width, img.height, r);
  const share = screenShare(img, alpha, inside, W, key, r);
  let s = 0;
  let n = 0;
  for (let i = 0; i < share.ok.length; i++) {
    if (!share.ok[i]) continue;
    s += share.k[i];
    n++;
  }
  return { pct: n ? round2((s / n) * 100) : 0, px: n };
}

/**
 * How completely the old screen in the subject's edge was swapped for the new one, on the finished
 * comp: on edge pixels the comp less the plate should be k x (I - S), with k the old screen's
 * share there (screenShare on the plate), S the old screen and I the insert next to the edge (the
 * comp's own pixels outside the subject, alpha under 0.02, in a window). Returns the swapped share
 * fitted over all edge pixels against the plate's, as a %: 100 is a full swap, 0 none, over 100 too much.
 */
export function swapCheck(plate: RgbaImage, comp: RgbaImage, alpha: Float32Array, inside: Uint8Array, key: KeyColour, r: number): { plate_share_pct: number; swapped_pct: number; px: number } | null {
  const { width: w, height: h } = plate;
  const n = w * h;
  const W = wrapMapOf(alpha, w, h, r);
  const share = screenShare(plate, alpha, inside, W, key, r);
  const outside = new Uint8Array(n);
  for (let i = 0; i < n; i++) outside[i] = inside[i] && alpha[i] < 0.02 ? 1 : 0;
  const ch = [0, 1, 2].map((c) => {
    const v = new Float32Array(n);
    for (let i = 0; i < n; i++) v[i] = comp.data[i * 4 + c] / 255;
    return windowMean(v, outside, w, h, 3 * r + 15);
  });
  let num = 0;
  let den = 0;
  let ks = 0;
  let m = 0;
  for (let i = 0; i < n; i++) {
    if (!share.ok[i] || ch[0].count[i] < 10) continue;
    const k = share.k[i];
    let dv = 0;
    let vv = 0;
    for (let c = 0; c < 3; c++) {
      const v = k * (ch[c].mean[i] - key.rgb[c]);
      const d = (comp.data[i * 4 + c] - plate.data[i * 4 + c]) / 255;
      dv += d * v;
      vv += v * v;
    }
    num += dv;
    den += vv;
    ks += k;
    m++;
  }
  if (m === 0 || den <= 0) return null;
  return { plate_share_pct: round2((ks / m) * 100), swapped_pct: round2((num / den) * 100), px: m };
}

export interface KeyQuality {
  /** Sure-foreground pixels whose matte is under 0.98: the subject showing the insert through it, %. */
  fg_see_through_pct: number | null;
  /** 99.9th percentile of the matte on sure screen: the old screen left over the insert. */
  screen_left_p999: number | null;
  /** Mean |change| per channel (0..255) of the keyed subject against the plate on sure foreground with matte 1. */
  fg_colour_shift_levels: number | null;
  fg_px: number;
  screen_px: number;
}

/** The finished key judged on the same sure-screen and sure-foreground pixels (from the plate). */
export function keyQuality(samples: Array<{ plate: RgbaImage; keyed: RgbaImage; screen: Uint8Array; fg: Uint8Array }>): KeyQuality {
  let fgN = 0;
  let fgThin = 0;
  let shift = 0;
  let shiftN = 0;
  const sv: number[] = [];
  for (const s of samples) {
    const pd = s.plate.data;
    const kd = s.keyed.data;
    const n = s.plate.width * s.plate.height;
    for (let i = 0; i < n; i++) {
      const a = kd[i * 4 + 3] / 255;
      if (s.screen[i]) sv.push(a);
      else if (s.fg[i]) {
        fgN++;
        if (a < 0.98) fgThin++;
        else {
          shift += (Math.abs(kd[i * 4] - pd[i * 4]) + Math.abs(kd[i * 4 + 1] - pd[i * 4 + 1]) + Math.abs(kd[i * 4 + 2] - pd[i * 4 + 2])) / 3;
          shiftN++;
        }
      }
    }
  }
  return {
    fg_see_through_pct: fgN ? round2((fgThin / fgN) * 100) : null,
    screen_left_p999: sv.length ? round4(quantile(sortedOf(sv), 0.999)) : null,
    fg_colour_shift_levels: shiftN ? round2(shift / shiftN) : null,
    fg_px: fgN,
    screen_px: sv.length,
  };
}

/** Per-frame corner speed (comp px per frame, x scaled by the pixel aspect so it is as the picture shows). */
export function cornerSpeed(frames: Array<{ time: number; corners: Vec2[] }>, par: number): { median: number; p90: number; max: number; at: number | null; frames: number } {
  const v: number[] = [];
  const at: number[] = [];
  for (let k = 1; k < frames.length; k++) {
    const a = frames[k - 1].corners;
    const b = frames[k].corners;
    if (a.length !== b.length || a.length === 0) continue;
    let m = 0;
    for (let c = 0; c < a.length; c++) m = Math.max(m, Math.hypot((b[c][0] - a[c][0]) * par, b[c][1] - a[c][1]));
    v.push(m);
    at.push(frames[k].time);
  }
  if (v.length === 0) return { median: 0, p90: 0, max: 0, at: null, frames: 0 };
  const s = sortedOf(v);
  let iMax = 0;
  for (let k = 1; k < v.length; k++) if (v[k] > v[iMax]) iMax = k;
  return { median: round2(quantile(s, 0.5)), p90: round2(quantile(s, 0.9)), max: round2(v[iMax]), at: round4(at[iMax]), frames: v.length };
}

/** The box round the subject's edge pixels inside the area, grown to a square of at least `minSide`, inside the image; null without edge pixels. */
export function edgeBox(alpha: Float32Array, inside: Uint8Array, w: number, h: number, minSide: number): { x: number; y: number; size: number } | null {
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!inside[i] || alpha[i] < 0.5) continue;
      if (alpha[i - 1] < 0.5 || alpha[i + 1] < 0.5 || alpha[i - w] < 0.5 || alpha[i + w] < 0.5) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  const size = Math.min(Math.max(minSide, x1 - x0 + 1, y1 - y0 + 1), w, h);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  return { x: clamp(Math.round(cx - size / 2), 0, w - size), y: clamp(Math.round(cy - size / 2), 0, h - size), size };
}

/** A copy of a rectangle of an image. */
export function cropImage(img: RgbaImage, x: number, y: number, cw: number, ch: number): RgbaImage {
  const data = new Uint8Array(cw * ch * 4);
  for (let yy = 0; yy < ch; yy++) {
    const src = ((y + yy) * img.width + x) * 4;
    data.set(img.data.subarray(src, src + cw * 4), yy * cw * 4);
  }
  return { width: cw, height: ch, data };
}

/** Scales a mask to another size by nearest neighbour (a render at another resolution). */
export function resizeMask(mask: Uint8Array, w: number, h: number, tw: number, th: number): Uint8Array {
  if (w === tw && h === th) return mask;
  const out = new Uint8Array(tw * th);
  for (let y = 0; y < th; y++) {
    const sy = Math.min(h - 1, Math.floor(((y + 0.5) * h) / th));
    for (let x = 0; x < tw; x++) out[y * tw + x] = mask[sy * w + Math.min(w - 1, Math.floor(((x + 0.5) * w) / tw))];
  }
  return out;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}
