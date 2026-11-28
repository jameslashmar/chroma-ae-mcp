/**
 * server/src/tools/ext/screen-track.ts
 *
 * A keyable screen (a green or blue phone, laptop, monitor or board): its key colour, how much of it a
 * pixel holds, and its outline snapped to the key edge at one frame, for ae_track_multi `screen` (the
 * corners it starts from; the frames are then followed by region-track.ts on the brightness and the key
 * together) and ae_screen_corners. Pure: no AE, no files.
 *
 * The key colour is read inside the screen as a chromaticity (r, g over r + g + b, so the screen's own
 * shading does not move it). The outline: each side's edge is found as the ridge of the key's strength
 * across the side (sub-pixel), a robust line is fitted per side (RANSAC, then trimmed least squares), and
 * the corners are where the lines meet. That is for one frame, where the corners are given roughly; it is
 * not how frames are followed: picking one edge per side per frame, it flicked between the two parallel
 * edges of a laptop's dark rim, frame after frame (a corner 1.5-2.5 px back and forth over 20 frames of a
 * Hollywood Camera Work plate).
 *
 * Coordinates: image px, pixel i's centre at i; the caller converts to comp px.
 */

import { fitLine, intersectLines, scanSide, sobel, type Line } from "./edges.js";
import { quadCheck, type Vec2 } from "./planar-math.js";
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

/**
 * Whether one colour (0-255 each) is still the screen's key, 0..1, for finding what is in front of it, not
 * its edge: 1 within the key's own spread (outer, at least 0.08 in chromaticity), 0 from 0.06 beyond that,
 * and 0 when dark (under 15% of the key's brightness). Looser than the edge's key: the key itself drifts over
 * a shot (a green board turned to the sun moved 0.04-0.06 in chromaticity, and the tight key took two thirds
 * of it for something in front), while skin is about 0.3 from a green and a white cloth 0.23. A fixed step,
 * not a multiple of the spread: marks on a board widen its measured spread (0.16), and three times that
 * took a hand for the key.
 */
export function keyPresenceOf(key: ScreenKey, r: number, g: number, b: number): number {
  const s = r + g + b;
  if (!(s > 0)) return 0;
  const d = Math.hypot(r / s - key.chroma[0], g / s - key.chroma[1]);
  const near = Math.max(0.08, key.outer);
  const far = near + 0.06;
  let a = d <= near ? 1 : d >= far ? 0 : (far - d) / (far - near);
  if (a > 0) {
    const l = luma(r, g, b);
    const dark0 = 0.15 * key.luma;
    const dark1 = 0.25 * key.luma;
    if (l < dark1) a *= l <= dark0 ? 0 : (l - dark0) / (dark1 - dark0);
  }
  return a;
}

/**
 * How much of the key colour a pixel holds, linearly: its colour projected on the key's own direction away
 * from grey (for green, about g - (r + b) / 2), over `box`, 0 elsewhere. A pixel that is part screen and
 * part bezel lands in proportion, so the steepest change across a side is the edge itself; the soft key
 * (keyAlphaOf) is not linear there and pulled the edge up to half a pixel inwards.
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

