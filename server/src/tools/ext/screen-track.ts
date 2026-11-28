/**
 * server/src/tools/ext/screen-track.ts
 *
 * Following a keyable screen (a green or blue phone, laptop, monitor or board) by its outline, for
 * ae_track_multi `screen`, and the key edge ae_screen_corners snaps to. Pure: no AE, no files.
 *
 * A screen that shows one flat colour has nothing inside for a region or point tracker to hold (a laptop's
 * green screen lost its points within 16 frames), but its outline is the sharpest thing in the frame. The
 * key colour is read inside the screen at the reference frame as a chromaticity (r, g over r + g + b, so the
 * screen's own shading does not move it); every frame becomes a soft key (255 on the screen, 0 off it), each
 * side's edge is found as the ridge of that key across the side (sub-pixel), a robust line is fitted per side
 * (RANSAC, then trimmed least squares: a hand crossing a side takes out its own stretch only), and the
 * corners are where the lines meet. Measured on a laptop green screen with a hand crossing it (2026-11-27,
 * the same method in OpenCV): all 219 frames.
 *
 * Coordinates: image px, pixel i's centre at i; the caller converts to comp px.
 */

import { fitLine, intersectLines, scanSide, sobel, type Line } from "./edges.js";
import { applyH, invertH, mulH, quadCheck, solveModel, type Mat3, type Vec2 } from "./planar-math.js";
import type { RgbaImage } from "./png-utils.js";
import type { GrayImage } from "./track.js";

export interface ScreenKey {
  /** The screen's chromaticity [r, g] / (r + g + b). */
  chroma: [number, number];
  /** Its median luma, 0-255. */
  luma: number;
  /** Chromaticity distance under which a pixel is the screen, and over which it is not. */
  inner: number;
  outer: number;
  /** The key's median colour, 0-255. */
  rgb: [number, number, number];
}

const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function insideQuad(q: Vec2[], x: number, y: number): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const c = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
    const s = c > 0 ? 1 : c < 0 ? -1 : 0;
    if (s === 0) continue;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

const centroid = (q: Vec2[]): Vec2 => [q.reduce((s, p) => s + p[0], 0) / q.length, q.reduce((s, p) => s + p[1], 0) / q.length];

/**
 * The key colour inside a quad (image px), from its middle 70%. Null when the inside is not one saturated
 * colour (a grey, white or black screen, or a picture): then there is no key to follow.
 */
export function sampleKey(img: RgbaImage, quad: Vec2[]): ScreenKey | null {
  const c = centroid(quad);
  const inner = quad.map((p) => [c[0] + (p[0] - c[0]) * 0.7, c[1] + (p[1] - c[1]) * 0.7] as Vec2);
  const xs = inner.map((p) => p[0]);
  const ys = inner.map((p) => p[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)));
  const x1 = Math.min(img.width - 1, Math.ceil(Math.max(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const y1 = Math.min(img.height - 1, Math.ceil(Math.max(...ys)));
  const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0 + 1) * (y1 - y0 + 1)) / 20000)));
  const rs: number[] = [];
  const gs: number[] = [];
  const ls: number[] = [];
  const raw: [number[], number[], number[]] = [[], [], []];
  for (let y = y0; y <= y1; y += step) {
    for (let x = x0; x <= x1; x += step) {
      if (!insideQuad(inner, x, y)) continue;
      const i = (y * img.width + x) * 4;
      const r = img.data[i];
      const g = img.data[i + 1];
      const b = img.data[i + 2];
      const s = r + g + b;
      if (s < 30) continue;
      rs.push(r / s);
      gs.push(g / s);
      ls.push(luma(r, g, b));
      raw[0].push(r);
      raw[1].push(g);
      raw[2].push(b);
    }
  }
  if (rs.length < 50) return null;
  const med = (a: number[]) => {
    const v = a.slice().sort((p, q) => p - q);
    return v[v.length >> 1];
  };
  const chroma: [number, number] = [med(rs), med(gs)];
  // A key must be a colour: far enough from grey (1/3, 1/3).
  if (Math.hypot(chroma[0] - 1 / 3, chroma[1] - 1 / 3) < 0.08) return null;
  const d = rs.map((r, k) => Math.hypot(r - chroma[0], gs[k] - chroma[1]));
  const mad = 1.4826 * med(d);
  // Most of the inside must be the key (a picture on the screen is not).
  const keyed = d.filter((v) => v <= Math.max(0.03, 4 * mad)).length / d.length;
  if (keyed < 0.6) return null;
  // Tight enough that a dark bezel lit green by the screen stays out (a looser key moved a laptop's top edge 4 px onto it).
  const innerT = Math.max(0.025, 3 * mad);
  return { chroma, luma: med(ls), inner: innerT, outer: innerT + Math.max(0.03, 0.5 * innerT), rgb: [med(raw[0]), med(raw[1]), med(raw[2])] };
}

/** The soft key over `box` (x0, y0, x1, y1, image px) as a GrayImage of the whole frame: 255 on the screen, 0 off it and outside the box. */
export function keyAlpha(img: RgbaImage, key: ScreenKey, box: [number, number, number, number]): GrayImage {
  const { width: w, height: h } = img;
  const out = new Float32Array(w * h);
  const x0 = Math.max(0, Math.floor(box[0]));
  const y0 = Math.max(0, Math.floor(box[1]));
  const x1 = Math.min(w - 1, Math.ceil(box[2]));
  const y1 = Math.min(h - 1, Math.ceil(box[3]));
  const span = key.outer - key.inner;
  const dark0 = 0.15 * key.luma;
  const dark1 = 0.3 * key.luma;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * w + x;
      const r = img.data[i * 4];
      const g = img.data[i * 4 + 1];
      const b = img.data[i * 4 + 2];
      const s = r + g + b;
      if (s <= 0) continue;
      const d = Math.hypot(r / s - key.chroma[0], g / s - key.chroma[1]);
      let a = d <= key.inner ? 1 : d >= key.outer ? 0 : (key.outer - d) / span;
      if (a > 0) {
        // Dark pixels have no reliable colour: a black bezel is not the screen.
        const l = luma(r, g, b);
        if (l < dark1) a *= l <= dark0 ? 0 : (l - dark0) / (dark1 - dark0);
      }
      out[i] = 255 * a;
    }
  }
  return { width: w, height: h, data: out };
}

/**
 * How much of the key colour a pixel holds, linearly: its colour projected on the key's own direction away
 * from grey (for green, about g - (r + b) / 2), over `box`, 0 elsewhere. A pixel that is part screen and
 * part bezel lands in proportion, so the steepest change across a side is the edge itself; the soft key
 * (keyAlpha) is not linear there and pulled the edge up to half a pixel inwards.
 */
export function keyStrength(img: RgbaImage, key: ScreenKey, box: [number, number, number, number]): GrayImage {
  const { width: w, height: h } = img;
  const out = new Float32Array(w * h);
  const m = (key.rgb[0] + key.rgb[1] + key.rgb[2]) / 3;
  let u = [key.rgb[0] - m, key.rgb[1] - m, key.rgb[2] - m];
  const n = Math.hypot(u[0], u[1], u[2]) || 1;
  u = u.map((v) => v / n);
  const x0 = Math.max(0, Math.floor(box[0]));
  const y0 = Math.max(0, Math.floor(box[1]));
  const x1 = Math.min(w - 1, Math.ceil(box[2]));
  const y1 = Math.min(h - 1, Math.ceil(box[3]));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * w + x;
      out[i] = u[0] * img.data[i * 4] + u[1] * img.data[i * 4 + 1] + u[2] * img.data[i * 4 + 2];
    }
  }
  return { width: w, height: h, data: out };
}

/** A deterministic generator, so a track solved twice gives the same answer. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** RANSAC over pairs (points within `tol` px), then fitLine on the largest consensus. Null for fewer than 6 points. */
export function ransacLine(pts: Vec2[], tol = 1, iterations = 120, seed = 7): Line | null {
  if (pts.length < 6) return null;
  const rand = rng(seed);
  let best: Vec2[] = [];
  for (let it = 0; it < iterations; it++) {
    const a = pts[Math.floor(rand() * pts.length)];
    const b = pts[Math.floor(rand() * pts.length)];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const n = Math.hypot(dx, dy);
    if (n < 8) continue;
    const nx = -dy / n;
    const ny = dx / n;
    const inl = pts.filter((p) => Math.abs((p[0] - a[0]) * nx + (p[1] - a[1]) * ny) <= tol);
    if (inl.length > best.length) best = inl;
  }
  if (best.length < 6) return fitLine(pts, tol);
  const line = fitLine(best, tol);
  return line ? { ...line, total: pts.length } : null;
}

export interface ScreenSide {
  /** Share of the side's scan lines whose edge is on the fitted line. */
  support: number;
  rms_px: number | null;
  line: Line | null;
}

export interface ScreenFit {
  ok: boolean;
  corners: Vec2[];
  sides: ScreenSide[];
  /** Expected corner error, px (the line fits' standard errors at the corners). */
  expected_px: number | null;
  why?: string;
}

/** A side's edge must be found on this share of its length (a hand may cover the rest). */
export const MIN_SIDE_SUPPORT = 0.25;

/**
 * The screen's outline near a predicted quad [UL, UR, LR, LL] (image px): each side's key edge within
 * `band` px of the prediction (in `strength`, from keyStrength), a robust line per side, corners where
 * neighbouring lines meet.
 */
export function fitScreenQuad(strength: GrayImage, pred: Vec2[], band: number): ScreenFit {
  const gr = sobel(strength);
  const c = centroid(pred);
  const sides: ScreenSide[] = [];
  for (let i = 0; i < 4; i++) {
    const a = pred[i];
    const b = pred[(i + 1) % 4];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 8) return { ok: false, corners: pred, sides, expected_px: null, why: "the screen is too small" };
    let normal: Vec2 = [(b[1] - a[1]) / len, -(b[0] - a[0]) / len];
    const mid: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if ((mid[0] - c[0]) * normal[0] + (mid[1] - c[1]) * normal[1] < 0) normal = [-normal[0], -normal[1]];
    const scan = scanSide(gr, a, b, normal, { searchPx: band, prefer: "nearest" });
    const line = ransacLine(scan.points);
    sides.push({ support: line ? line.inliers / Math.max(1, scan.expected) : 0, rms_px: line ? line.rms : null, line });
  }
  const weak = sides.map((s, i) => (s.support < MIN_SIDE_SUPPORT ? i : -1)).filter((i) => i >= 0);
  if (weak.length) {
    const names = ["top", "right", "bottom", "left"];
    return { ok: false, corners: pred, sides, expected_px: null, why: `the screen's ${weak.map((i) => names[i]).join(" and ")} edge was not found (covered, out of frame, or not the key colour)` };
  }
  const corners: Vec2[] = [];
  let ex = 0;
  for (let i = 0; i < 4; i++) {
    const p = sides[(i + 3) % 4];
    const n = sides[i];
    const meet = intersectLines(p.line!, n.line!);
    if (!meet) return { ok: false, corners: pred, sides, expected_px: null, why: "two neighbouring edges are almost parallel" };
    corners.push(meet);
    // Each line's position error at its end is about 2 rms / sqrt(n); carried into the corner by the angle between the lines.
    const e = (s: ScreenSide) => (2 * Math.max(0.1, s.rms_px ?? 1)) / Math.sqrt(Math.max(1, s.line!.inliers));
    const sin = Math.abs(p.line!.dir[0] * n.line!.dir[1] - p.line!.dir[1] * n.line!.dir[0]);
    ex += Math.hypot(e(p), e(n)) / Math.max(0.25, sin);
  }
  const chk = quadCheck(corners);
  if (!chk.ok) return { ok: false, corners, sides, expected_px: null, why: `the outline is not a quad: ${chk.reason}` };
  return { ok: true, corners, sides, expected_px: ex / 4 };
}

/** The share of the quad's inside that is keyed (a 20 x 20 grid of samples). */
export function keyedShare(alpha: GrayImage, q: Vec2[]): number {
  let n = 0;
  let on = 0;
  for (let i = 0; i < 20; i++) {
    for (let j = 0; j < 20; j++) {
      const s = (i + 0.5) / 20;
      const t = (j + 0.5) / 20;
      const top: Vec2 = [q[0][0] + (q[1][0] - q[0][0]) * s, q[0][1] + (q[1][1] - q[0][1]) * s];
      const bot: Vec2 = [q[3][0] + (q[2][0] - q[3][0]) * s, q[3][1] + (q[2][1] - q[3][1]) * s];
      const x = Math.round(top[0] + (bot[0] - top[0]) * t);
      const y = Math.round(top[1] + (bot[1] - top[1]) * t);
      if (x < 0 || y < 0 || x >= alpha.width || y >= alpha.height) continue;
      n++;
      if (alpha.data[y * alpha.width + x] >= 128) on++;
    }
  }
  return n ? on / n : 0;
}

/**
 * The keyed area's own outline near a quad, for when the prediction is lost: the keyed pixels in the quad
 * grown by half, and per corner the one that reaches furthest out in that corner's direction from the
 * centre. Null when too little is keyed there.
 */
export function redetectQuad(alpha: GrayImage, around: Vec2[]): Vec2[] | null {
  const c = centroid(around);
  const grown = around.map((p) => [c[0] + (p[0] - c[0]) * 1.5, c[1] + (p[1] - c[1]) * 1.5] as Vec2);
  const xs = grown.map((p) => p[0]);
  const ys = grown.map((p) => p[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)));
  const x1 = Math.min(alpha.width - 1, Math.ceil(Math.max(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const y1 = Math.min(alpha.height - 1, Math.ceil(Math.max(...ys)));
  const dirs = around.map((p) => {
    const d = Math.hypot(p[0] - c[0], p[1] - c[1]) || 1;
    return [(p[0] - c[0]) / d, (p[1] - c[1]) / d] as Vec2;
  });
  const best: Array<{ v: number; p: Vec2 } | null> = [null, null, null, null];
  let count = 0;
  for (let y = y0; y <= y1; y += 2) {
    for (let x = x0; x <= x1; x += 2) {
      if (alpha.data[y * alpha.width + x] < 128) continue;
      count++;
      for (let k = 0; k < 4; k++) {
        const v = (x - c[0]) * dirs[k][0] + (y - c[1]) * dirs[k][1];
        if (!best[k] || v > best[k]!.v) best[k] = { v, p: [x, y] };
      }
    }
  }
  if (count < 200 || best.some((b) => b === null)) return null;
  const q = best.map((b) => b!.p);
  return quadCheck(q).ok ? q : null;
}

export interface ScreenStep {
  ok: boolean;
  /** Reference image px -> frame image px; the held motion when the frame failed. */
  H: Mat3;
  corners: Vec2[] | null;
  expected_px: number | null;
  /** The weakest side's support. */
  support: number | null;
  /** The share of the quad's inside that is keyed. */
  coverage: number | null;
  note?: string;
  misses: number;
}

/**
 * One direction of a screen track. Each frame: the key around the predicted quad (the last two good frames'
 * motion carried on), the outline fitted within `band` px; failing that, from the last good quad within twice
 * the band; failing that, from the keyed area's own extremes. A fit that jumps further than the screen's size
 * from the prediction, or changes its area more than 2.5 times, is refused.
 */
export class ScreenTracker {
  Hprev: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  Hprev2: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  misses = 0;

  constructor(
    readonly key: ScreenKey,
    readonly refQuad: Vec2[],
    readonly band = 12
  ) {}

  restore(last: Mat3, prev: Mat3 | null): void {
    this.Hprev = last.slice();
    this.Hprev2 = (prev ?? last).slice();
    this.misses = 0;
  }

  private quadOf(H: Mat3): Vec2[] | null {
    const q = this.refQuad.map((p) => applyH(H, p));
    return q.some((p) => p === null) ? null : (q as Vec2[]);
  }

  step(img: RgbaImage): ScreenStep {
    let pred = this.Hprev;
    const inv2 = invertH(this.Hprev2);
    if (inv2) pred = mulH(this.Hprev, mulH(inv2, this.Hprev));
    const predQ = this.quadOf(pred) ?? this.quadOf(this.Hprev);
    const lastQ = this.quadOf(this.Hprev);
    if (!predQ || !lastQ) return this.miss("the screen's quad lands behind the plane at infinity");
    // The key only where the screen can be: the last and predicted quads grown by half, plus the band.
    const all = [...predQ, ...lastQ];
    const c = centroid(lastQ);
    const xs = all.map((p) => c[0] + (p[0] - c[0]) * 1.5);
    const ys = all.map((p) => c[1] + (p[1] - c[1]) * 1.5);
    const pad = 2 * this.band + 4;
    const box: [number, number, number, number] = [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad];
    const alpha = keyAlpha(img, this.key, box);
    const strength = keyStrength(img, this.key, box);
    const tries: Array<{ q: Vec2[]; band: number }> = [{ q: predQ, band: this.band }, { q: lastQ, band: 2 * this.band }];
    let why = "";
    let fit: ScreenFit | null = null;
    for (let k = 0; k < 3 && !(fit && fit.ok); k++) {
      let t = tries[k];
      if (k === 2) {
        const re = redetectQuad(alpha, lastQ);
        if (!re) break;
        t = { q: re, band: 2 * this.band };
      }
      const f = fitScreenQuad(strength, t.q, t.band);
      if (!f.ok) {
        why = f.why ?? "the outline was not found";
        continue;
      }
      const jump = this.jumped(f.corners, predQ);
      if (jump) {
        why = jump;
        continue;
      }
      fit = f;
    }
    if (!fit || !fit.ok) return this.miss(why || "the outline was not found");
    const sol = solveModel("perspective", this.refQuad, fit.corners);
    if (!sol) return this.miss("the outline's corners are degenerate");
    this.Hprev2 = this.Hprev;
    this.Hprev = sol.H;
    this.misses = 0;
    return {
      ok: true,
      H: sol.H,
      corners: fit.corners,
      expected_px: fit.expected_px,
      support: Math.min(...fit.sides.map((s) => s.support)),
      coverage: keyedShare(alpha, fit.corners),
      misses: 0,
    };
  }

  private miss(note: string): ScreenStep {
    this.Hprev2 = this.Hprev;
    this.misses++;
    return { ok: false, H: this.Hprev, corners: null, expected_px: null, support: null, coverage: null, note, misses: this.misses };
  }

  private jumped(q: Vec2[], pred: Vec2[]): string | null {
    let d = 0;
    for (let i = 0; i < 4; i++) d += Math.hypot(q[i][0] - pred[i][0], q[i][1] - pred[i][1]) / 4;
    const size = Math.max(Math.hypot(pred[0][0] - pred[2][0], pred[0][1] - pred[2][1]), Math.hypot(pred[1][0] - pred[3][0], pred[1][1] - pred[3][1]));
    const allowed = Math.min(1, 0.3 * (1 + this.misses)) * size + 20;
    if (d > allowed) return `the outline jumped ${Math.round(d)} px from where the screen was going: a wrong match`;
    const area = (p: Vec2[]) => Math.abs(p.reduce((s, v, i) => s + v[0] * p[(i + 1) % 4][1] - p[(i + 1) % 4][0] * v[1], 0)) / 2;
    const ratio = area(q) / Math.max(1e-9, area(pred));
    if (!(ratio < 2.5 && ratio > 0.4)) return `the screen's area changed ${Math.round(ratio * 100) / 100} times in one frame: a wrong match`;
    return null;
  }
}
