/**
 * server/src/tools/ext/planar-math.ts
 *
 * The maths under the planar tools (ae_track_multi, ae_track_read,
 * ae_track_apply) and the wave-4 tools that build on them. Pure: no AE, no
 * files, nothing imported but a type. Points are in comp pixels (x right, y
 * down, the top-left corner of the comp is [0, 0]); a Mat3 is row-major and
 * maps [x, y, 1], so the matrix a.b applies b first.
 *
 * A PlanarTrack stores, per frame, H: the homography that carries a point of
 * the reference frame (comp pixels at `ref_time`) to where that point is at
 * the frame's time.
 */

import type { GrayImage } from "./track.js";

export type Vec2 = [number, number];
/** Row-major 3x3, length 9. */
export type Mat3 = number[];
export type MotionModel = "translate" | "similarity" | "affine" | "perspective";

/** Points a model needs at least. */
export const MODEL_MIN_POINTS: Record<MotionModel, number> = { translate: 1, similarity: 2, affine: 3, perspective: 4 };

export interface PlanarFrame {
  time: number;
  ok: boolean;
  /** Ref comp px -> comp px at `time`. Null when the frame could not be solved. */
  H: Mat3 | null;
  points: Array<Vec2 | null>;
  confidence: Array<number | null>;
  rms_px: number | null;
  inliers: number;
  /** Why a frame is not ok, or a warning about it. */
  note?: string;
}

/** Progress of a track that is being followed in chunks (see ae_track_multi). Absent on tracks read from the project. */
export interface TrackingDirection {
  done: boolean;
  /** The next frame time to process, or null when the direction is finished. */
  next_time: number | null;
  stop: { time: number; reason: "end" | "lost" | "cut" | "degenerate" } | null;
  /** Last good comp-pixel position per point, to rebuild the tracker after a restart. */
  last_points: Array<Vec2 | null>;
  last_H: Mat3;
}

export interface TrackingState {
  options: Record<string, unknown>;
  range: { start: number; end: number };
  quad: Vec2[];
  forward: TrackingDirection;
  backward: TrackingDirection;
  dropped: Array<{ index: number; reason: string }>;
}

export interface PlanarTrack {
  version: 1;
  track_id: string;
  comp_id: number;
  comp_size: Vec2;
  fps: number;
  ref_time: number;
  model: MotionModel;
  ref_points: Vec2[];
  /** Ascending time, the reference frame present with identity H. */
  frames: PlanarFrame[];
  source: string;
  created: string;
  tracking?: TrackingState;
}

// ---------- matrices ----------

export const identityH = (): Mat3 => [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** a . b: b is applied first. */
export function mulH(a: Mat3, b: Mat3): Mat3 {
  const out = new Array<number>(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return out;
}

export function invertH(h: Mat3): Mat3 | null {
  const [a, b, c, d, e, f, g, i, j] = h;
  const A = e * j - f * i;
  const B = -(d * j - f * g);
  const C = d * i - e * g;
  const det = a * A + b * B + c * C;
  // Singular is judged against the rows' own sizes (the Hadamard bound), so a small scale far from the origin
  // is not mistaken for one: the translation does not enter the test the way it did with the largest entry.
  const n1 = Math.hypot(a, b, c);
  const n2 = Math.hypot(d, e, f);
  const n3 = Math.hypot(g, i, j);
  if (!Number.isFinite(det) || Math.abs(det) <= 1e-12 * n1 * n2 * n3) return null;
  const inv = [
    A,
    -(b * j - c * i),
    b * f - c * e,
    B,
    a * j - c * g,
    -(a * f - c * d),
    C,
    -(a * i - b * g),
    a * e - b * d,
  ].map((v) => v / det);
  return inv;
}

/** Null when the point lands at or behind the plane at infinity (w <= 1e-9). */
export function applyH(h: Mat3, p: Vec2): Vec2 | null {
  const w = h[6] * p[0] + h[7] * p[1] + h[8];
  if (!(w > 1e-9)) return null;
  return [(h[0] * p[0] + h[1] * p[1] + h[2]) / w, (h[3] * p[0] + h[4] * p[1] + h[5]) / w];
}

export const translationH = (tx: number, ty: number): Mat3 => [1, 0, tx, 0, 1, ty, 0, 0, 1];

/** Layer px -> parent px, as AE composes a layer's transform: position + R . S . (p - anchor). */
export function layerMatrix(t: { anchor: Vec2; position: Vec2; scale_pct: Vec2; rotation_deg: number }): Mat3 {
  const r = (t.rotation_deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const sx = t.scale_pct[0] / 100;
  const sy = t.scale_pct[1] / 100;
  const l00 = c * sx;
  const l01 = -s * sy;
  const l10 = s * sx;
  const l11 = c * sy;
  return [l00, l01, t.position[0] - (l00 * t.anchor[0] + l01 * t.anchor[1]), l10, l11, t.position[1] - (l10 * t.anchor[0] + l11 * t.anchor[1]), 0, 0, 1];
}

/**
 * The inverse of layerMatrix for an affine layer->parent matrix: the layer's
 * position, rotation and (possibly non-uniform, possibly mirrored) scale
 * given the anchor it keeps. Rotation is the angle of the first column.
 */
export function decomposeLayerMatrix(n: Mat3, anchor: Vec2): { position: Vec2; rotation_deg: number; scale_pct: Vec2 } {
  const sx = Math.hypot(n[0], n[3]);
  const rot = sx > 1e-12 ? Math.atan2(n[3], n[0]) : 0;
  const det = n[0] * n[4] - n[1] * n[3];
  const sy = sx > 1e-12 ? det / sx : Math.hypot(n[1], n[4]);
  return {
    position: [n[0] * anchor[0] + n[1] * anchor[1] + n[2], n[3] * anchor[0] + n[4] * anchor[1] + n[5]],
    rotation_deg: (rot * 180) / Math.PI,
    scale_pct: [sx * 100, sy * 100],
  };
}

/**
 * What a homography does at one point, as a layer transform would: where the
 * pivot lands, the mean rotation and the mean scale of the map there.
 */
export function decomposeSimilarity(h: Mat3, pivot: Vec2): { position: Vec2; rotation_deg: number; scale_pct: number } {
  const w = h[6] * pivot[0] + h[7] * pivot[1] + h[8];
  if (!(w > 1e-9)) return { position: [pivot[0], pivot[1]], rotation_deg: 0, scale_pct: 100 };
  const x = (h[0] * pivot[0] + h[1] * pivot[1] + h[2]) / w;
  const y = (h[3] * pivot[0] + h[4] * pivot[1] + h[5]) / w;
  const j00 = (h[0] - x * h[6]) / w;
  const j01 = (h[1] - x * h[7]) / w;
  const j10 = (h[3] - y * h[6]) / w;
  const j11 = (h[4] - y * h[7]) / w;
  return {
    position: [x, y],
    rotation_deg: (Math.atan2(j10 - j01, j00 + j11) * 180) / Math.PI,
    scale_pct: Math.sqrt(Math.abs(j00 * j11 - j01 * j10)) * 100,
  };
}

/** The 2x2 derivative of a homography at a point, row-major, or null behind the plane. */
export function jacobianAt(h: Mat3, p: Vec2): [number, number, number, number] | null {
  const w = h[6] * p[0] + h[7] * p[1] + h[8];
  if (!(w > 1e-9)) return null;
  const x = (h[0] * p[0] + h[1] * p[1] + h[2]) / w;
  const y = (h[3] * p[0] + h[4] * p[1] + h[5]) / w;
  return [(h[0] - x * h[6]) / w, (h[1] - x * h[7]) / w, (h[3] - y * h[6]) / w, (h[4] - y * h[7]) / w];
}

/** Makes a series of angles (degrees) continuous: neighbours never differ by more than 180. */
export function unwrapDegrees(values: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < values.length; i++) {
    let v = values[i];
    if (i > 0) {
      while (v - out[i - 1] > 180) v -= 360;
      while (v - out[i - 1] < -180) v += 360;
    }
    out.push(v);
  }
  return out;
}

// ---------- solving ----------

/** Gaussian elimination with partial pivoting. Null when (nearly) singular. */
function solveLinear(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  let maxPivot = 0;
  let minPivot = Infinity;
  for (let col = 0; col < n; col++) {
    let best = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[best][col])) best = r;
    const pivot = Math.abs(m[best][col]);
    if (!(pivot > 1e-12)) return null;
    maxPivot = Math.max(maxPivot, pivot);
    minPivot = Math.min(minPivot, pivot);
    [m[col], m[best]] = [m[best], m[col]];
    for (let r = col + 1; r < n; r++) {
      const k = m[r][col] / m[col][col];
      if (k === 0) continue;
      for (let c = col; c <= n; c++) m[r][c] -= k * m[col][c];
    }
  }
  if (minPivot / maxPivot < 1e-9) return null;
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = m[r][n];
    for (let c = r + 1; c < n; c++) s -= m[r][c] * x[c];
    x[r] = s / m[r][r];
  }
  return x.every(Number.isFinite) ? x : null;
}

const centroid = (pts: Vec2[]): Vec2 => {
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p[0];
    y += p[1];
  }
  return [x / pts.length, y / pts.length];
};

function solveTranslate(from: Vec2[], to: Vec2[]): Mat3 {
  const cf = centroid(from);
  const ct = centroid(to);
  return translationH(ct[0] - cf[0], ct[1] - cf[1]);
}

/** Position, rotation and uniform scale by complex least squares (Umeyama in 2D). */
function solveSimilarity(from: Vec2[], to: Vec2[]): Mat3 | null {
  const cf = centroid(from);
  const ct = centroid(to);
  let den = 0;
  let re = 0;
  let im = 0;
  for (let i = 0; i < from.length; i++) {
    const x = from[i][0] - cf[0];
    const y = from[i][1] - cf[1];
    const u = to[i][0] - ct[0];
    const v = to[i][1] - ct[1];
    den += x * x + y * y;
    re += x * u + y * v;
    im += x * v - y * u;
  }
  if (!(den > 1e-9)) return null;
  const a = re / den;
  const b = im / den;
  if (!(Math.hypot(a, b) > 1e-9)) return null;
  return [a, -b, ct[0] - (a * cf[0] - b * cf[1]), b, a, ct[1] - (b * cf[0] + a * cf[1]), 0, 0, 1];
}

function solveAffine(from: Vec2[], to: Vec2[]): Mat3 | null {
  const cf = centroid(from);
  const ct = centroid(to);
  let mean = 0;
  for (const p of from) mean += Math.hypot(p[0] - cf[0], p[1] - cf[1]);
  mean /= from.length;
  if (!(mean > 1e-6)) return null;
  // Centred and scaled: the offsets drop out and a 2x2 system is left.
  let m00 = 0;
  let m01 = 0;
  let m11 = 0;
  let bx0 = 0;
  let bx1 = 0;
  let by0 = 0;
  let by1 = 0;
  for (let i = 0; i < from.length; i++) {
    const u = (from[i][0] - cf[0]) / mean;
    const v = (from[i][1] - cf[1]) / mean;
    const px = to[i][0] - ct[0];
    const py = to[i][1] - ct[1];
    m00 += u * u;
    m01 += u * v;
    m11 += v * v;
    bx0 += u * px;
    bx1 += v * px;
    by0 += u * py;
    by1 += v * py;
  }
  const det = m00 * m11 - m01 * m01;
  // Collinear points leave one direction undetermined.
  if (!(det > 1e-9 * (m00 + m11) * (m00 + m11))) return null;
  const a = (m11 * bx0 - m01 * bx1) / det;
  const b = (-m01 * bx0 + m00 * bx1) / det;
  const c = (m11 * by0 - m01 * by1) / det;
  const d = (-m01 * by0 + m00 * by1) / det;
  const A = a / mean;
  const B = b / mean;
  const C = c / mean;
  const D = d / mean;
  return [A, B, ct[0] - A * cf[0] - B * cf[1], C, D, ct[1] - C * cf[0] - D * cf[1], 0, 0, 1];
}

/** Normalized DLT with h33 = 1; exact for four points, least squares for more. */
function solvePerspective(from: Vec2[], to: Vec2[]): Mat3 | null {
  const cf = centroid(from);
  const ct = centroid(to);
  let mf = 0;
  let mt = 0;
  for (let i = 0; i < from.length; i++) {
    mf += Math.hypot(from[i][0] - cf[0], from[i][1] - cf[1]);
    mt += Math.hypot(to[i][0] - ct[0], to[i][1] - ct[1]);
  }
  mf /= from.length;
  mt /= from.length;
  if (!(mf > 1e-6) || !(mt > 1e-6)) return null;
  const sf = Math.SQRT2 / mf;
  const st = Math.SQRT2 / mt;
  const rows: number[][] = [];
  const rhs: number[] = [];
  for (let i = 0; i < from.length; i++) {
    const u = (from[i][0] - cf[0]) * sf;
    const v = (from[i][1] - cf[1]) * sf;
    const x = (to[i][0] - ct[0]) * st;
    const y = (to[i][1] - ct[1]) * st;
    rows.push([u, v, 1, 0, 0, 0, -x * u, -x * v]);
    rhs.push(x);
    rows.push([0, 0, 0, u, v, 1, -y * u, -y * v]);
    rhs.push(y);
  }
  let h: number[] | null;
  if (from.length === 4) {
    h = solveLinear(rows, rhs);
  } else {
    const ata: number[][] = Array.from({ length: 8 }, () => new Array<number>(8).fill(0));
    const atb = new Array<number>(8).fill(0);
    for (let r = 0; r < rows.length; r++) {
      for (let i = 0; i < 8; i++) {
        atb[i] += rows[r][i] * rhs[r];
        for (let j = 0; j < 8; j++) ata[i][j] += rows[r][i] * rows[r][j];
      }
    }
    h = solveLinear(ata, atb);
  }
  if (!h) return null;
  const hn: Mat3 = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  const tFrom: Mat3 = [sf, 0, -sf * cf[0], 0, sf, -sf * cf[1], 0, 0, 1];
  const tToInv: Mat3 = [1 / st, 0, ct[0], 0, 1 / st, ct[1], 0, 0, 1];
  const full = mulH(tToInv, mulH(hn, tFrom));
  const k = full[8];
  if (!(Math.abs(k) > 1e-12)) return null;
  return full.map((v) => v / k);
}

export interface ModelSolution {
  H: Mat3;
  rms_px: number;
  max_px: number;
}

/** Fits a motion model to matched points. Null when there are too few points or they are degenerate (coincident, collinear). */
export function solveModel(model: MotionModel, from: Vec2[], to: Vec2[]): ModelSolution | null {
  const n = from.length;
  if (n !== to.length || n < MODEL_MIN_POINTS[model]) return null;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(from[i][0] + from[i][1] + to[i][0] + to[i][1])) return null;
  }
  let H: Mat3 | null;
  if (model === "translate") H = solveTranslate(from, to);
  else if (model === "similarity") H = solveSimilarity(from, to);
  else if (model === "affine") H = solveAffine(from, to);
  else H = solvePerspective(from, to);
  if (!H || !H.every(Number.isFinite)) return null;
  const err = reprojectionErrors(H, from, to);
  if (!err) return null;
  let sq = 0;
  let max = 0;
  for (const e of err) {
    sq += e * e;
    if (e > max) max = e;
  }
  return { H, rms_px: Math.sqrt(sq / n), max_px: max };
}

/** Distance between H(from[i]) and to[i]; null if a point lands behind the plane. */
export function reprojectionErrors(H: Mat3, from: Vec2[], to: Vec2[]): number[] | null {
  const out: number[] = [];
  for (let i = 0; i < from.length; i++) {
    const p = applyH(H, from[i]);
    if (!p) return null;
    out.push(Math.hypot(p[0] - to[i][0], p[1] - to[i][1]));
  }
  return out;
}

/** A small seeded generator, so a track solved twice gives the same answer. */
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

/**
 * Robust fit: random minimal subsets, the model with the most inliers wins
 * and is refitted on them. With only as many points as the model needs there
 * is nothing to vote on, and it is a plain fit.
 */
export function ransacModel(
  model: MotionModel,
  from: Vec2[],
  to: Vec2[],
  opts: { thresholdPx: number; iterations: number; seed: number }
): { H: Mat3; inliers: boolean[]; rms_px: number } | null {
  const n = from.length;
  const m = MODEL_MIN_POINTS[model];
  if (n < m || n !== to.length) return null;
  if (n === m) {
    const s = solveModel(model, from, to);
    return s ? { H: s.H, inliers: new Array<boolean>(n).fill(true), rms_px: s.rms_px } : null;
  }
  const rand = mulberry32(opts.seed);
  let best: { inliers: boolean[]; count: number; sum: number } | null = null;
  for (let it = 0; it < opts.iterations; it++) {
    const pick: number[] = [];
    while (pick.length < m) {
      const k = Math.floor(rand() * n);
      if (!pick.includes(k)) pick.push(k);
    }
    const s = solveModel(model, pick.map((k) => from[k]), pick.map((k) => to[k]));
    if (!s) continue;
    const err = reprojectionErrors(s.H, from, to);
    if (!err) continue;
    const inliers = err.map((e) => e <= opts.thresholdPx);
    const count = inliers.filter(Boolean).length;
    const sum = err.reduce((acc, e, i) => acc + (inliers[i] ? e : 0), 0);
    if (!best || count > best.count || (count === best.count && sum < best.sum)) best = { inliers, count, sum };
    if (count === n) break;
  }
  if (!best || best.count < m) return null;
  const idx = best.inliers.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
  const fit = solveModel(model, idx.map((i) => from[i]), idx.map((i) => to[i]));
  if (!fit) return null;
  const err = reprojectionErrors(fit.H, from, to);
  if (!err) return null;
  const inliers = err.map((e) => e <= opts.thresholdPx);
  // The refit can move the line: count again, and keep the consensus set if it fell below the minimum.
  const final = inliers.filter(Boolean).length >= m ? inliers : best.inliers;
  let sq = 0;
  let cnt = 0;
  err.forEach((e, i) => {
    if (final[i]) {
      sq += e * e;
      cnt++;
    }
  });
  return { H: fit.H, inliers: final, rms_px: cnt ? Math.sqrt(sq / cnt) : 0 };
}

// ---------- quads ----------

/** [UL, UR, LR, LL] of the rectangle w x h at the origin. */
export const rectQuad = (w: number, h: number, x = 0, y = 0): Vec2[] => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
];

/** The bounding rectangle of the points as a quad, grown to at least `minSize` on each side. */
export function boundingQuad(points: Vec2[], minSize = 8): Vec2[] {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  let x0 = Math.min(...xs);
  let x1 = Math.max(...xs);
  let y0 = Math.min(...ys);
  let y1 = Math.max(...ys);
  if (x1 - x0 < minSize) {
    const c = (x0 + x1) / 2;
    x0 = c - minSize / 2;
    x1 = c + minSize / 2;
  }
  if (y1 - y0 < minSize) {
    const c = (y0 + y1) / 2;
    y0 = c - minSize / 2;
    y1 = c + minSize / 2;
  }
  return rectQuad(x1 - x0, y1 - y0, x0, y0);
}

/** A quad (four corners in order) must be convex, not folded, and cover more than 16 px^2. */
export function quadCheck(corners: Vec2[]): { ok: boolean; reason?: string } {
  if (corners.length !== 4 || corners.some((p) => !p || !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) {
    return { ok: false, reason: "a corner is missing or not finite" };
  }
  let area = 0;
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    const c = corners[(i + 2) % 4];
    area += a[0] * b[1] - b[0] * a[1];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) < 1e-9) return { ok: false, reason: "three corners are in a line" };
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return { ok: false, reason: "the quad is folded or not convex" };
  }
  if (Math.abs(area) / 2 <= 16) return { ok: false, reason: "the quad covers less than 16 px^2" };
  return { ok: true };
}

// ---------- tracks ----------

/** The frame at `time`, within half a frame, or null. Frames are ascending. */
export function frameAt(track: PlanarTrack, time: number): PlanarFrame | null {
  const half = 0.5 / (track.fps > 0 ? track.fps : 25);
  const f = track.frames;
  let lo = 0;
  let hi = f.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (f[mid].time < time - half) lo = mid + 1;
    else if (f[mid].time > time + half) hi = mid - 1;
    else return f[mid];
  }
  return null;
}

/** Re-bases every H so `refTime` is the identity frame. Frames stay null (and not ok) where the reference frame has no H. */
export function relativeTo(track: PlanarTrack, refTime: number): PlanarTrack {
  const ref = frameAt(track, refTime);
  const inv = ref && ref.ok && ref.H ? invertH(ref.H) : null;
  const frames: PlanarFrame[] = track.frames.map((fr) => {
    if (!inv || !fr.ok || !fr.H) return { ...fr, ok: false, H: null, note: fr.note ?? (inv ? undefined : "the new reference frame has no solved H") };
    return { ...fr, H: mulH(fr.H, inv) };
  });
  const refPoints: Vec2[] = track.ref_points.map((p) => {
    const q = ref && ref.H ? applyH(ref.H, p) : null;
    return q ?? p;
  });
  return { ...track, ref_time: ref ? ref.time : refTime, ref_points: refPoints, frames };
}

/**
 * Smooths the track: a Gaussian over the trajectories of the four corners of
 * the reference comp rectangle, then H is solved again from the smoothed
 * corners with the track's own model. Frames that are not ok stay that way and
 * do not count in the average. The reference frame is made the identity again.
 */
export function smoothFrames(track: PlanarTrack, sigmaFrames: number): PlanarTrack {
  if (!(sigmaFrames > 0)) return track;
  const corners = rectQuad(track.comp_size[0], track.comp_size[1]);
  const moved: Array<Vec2[] | null> = track.frames.map((fr) => {
    if (!fr.ok || !fr.H) return null;
    const out: Vec2[] = [];
    for (const c of corners) {
      const p = applyH(fr.H, c);
      if (!p) return null;
      out.push(p);
    }
    return out;
  });
  const radius = Math.ceil(sigmaFrames * 3);
  const frames: PlanarFrame[] = track.frames.map((fr, i) => {
    const mine = moved[i];
    if (!mine) return fr;
    const acc: Vec2[] = corners.map(() => [0, 0]);
    let wsum = 0;
    for (let k = Math.max(0, i - radius); k <= Math.min(track.frames.length - 1, i + radius); k++) {
      const m = moved[k];
      if (!m) continue;
      const w = Math.exp(-((k - i) * (k - i)) / (2 * sigmaFrames * sigmaFrames));
      wsum += w;
      for (let c = 0; c < 4; c++) {
        acc[c][0] += m[c][0] * w;
        acc[c][1] += m[c][1] * w;
      }
    }
    const smooth: Vec2[] = acc.map((p) => [p[0] / wsum, p[1] / wsum]);
    const sol = solveModel(track.model, corners, smooth);
    if (!sol) return fr;
    return { ...fr, H: sol.H };
  });
  return relativeTo({ ...track, frames }, track.ref_time);
}

// ---------- bezier shapes ----------

export interface ShapeData {
  vertices: Vec2[];
  inTangents: Vec2[];
  outTangents: Vec2[];
  closed?: boolean;
}

const cubic = (p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, t: number): Vec2 => {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return [a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]];
};

/**
 * Maps a bezier shape through a homography: every vertex and both tangent end
 * points, with the tangents rebuilt as differences. A homography does not map
 * a cubic bezier to a cubic bezier, so `maxErrorPx` is how far the rebuilt curve
 * strays from the true image, from 8 samples per segment (0 for an affine map).
 */
export function transformShape(shape: ShapeData, P: Mat3): ShapeData & { maxErrorPx: number } {
  const n = shape.vertices.length;
  const map = (p: Vec2): Vec2 => {
    const q = applyH(P, p);
    if (!q) throw new Error("A point of the shape lands behind the plane at infinity, so the shape cannot be transformed.");
    return q;
  };
  const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
  const vertices = shape.vertices.map(map);
  const outTangents: Vec2[] = [];
  const inTangents: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const o = map(add(shape.vertices[i], shape.outTangents[i]));
    const t = map(add(shape.vertices[i], shape.inTangents[i]));
    outTangents.push([o[0] - vertices[i][0], o[1] - vertices[i][1]]);
    inTangents.push([t[0] - vertices[i][0], t[1] - vertices[i][1]]);
  }
  let maxErrorPx = 0;
  const affine = Math.abs(P[6]) < 1e-12 && Math.abs(P[7]) < 1e-12;
  if (!affine) {
    const closed = shape.closed !== false;
    const segs = closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % n;
      const o0 = shape.vertices[i];
      const o1 = add(shape.vertices[i], shape.outTangents[i]);
      const o2 = add(shape.vertices[j], shape.inTangents[j]);
      const o3 = shape.vertices[j];
      const q0 = vertices[i];
      const q1 = add(vertices[i], outTangents[i]);
      const q2 = add(vertices[j], inTangents[j]);
      const q3 = vertices[j];
      for (let s = 1; s <= 8; s++) {
        const t = s / 9;
        const truth = map(cubic(o0, o1, o2, o3, t));
        const got = cubic(q0, q1, q2, q3, t);
        maxErrorPx = Math.max(maxErrorPx, Math.hypot(truth[0] - got[0], truth[1] - got[1]));
      }
    }
  }
  return { vertices, inTangents, outTangents, closed: shape.closed, maxErrorPx };
}

// ---------- features ----------

/**
 * Shi-Tomasi corners: the smaller eigenvalue of the structure tensor summed
 * over a 5x5 window, local maxima only, strongest first, no two closer than
 * `minDistancePx`, and each must pass the tracker's contrast test (the
 * pattern's standard deviation is at least 3 gray levels). `mask` (same size
 * as the image, > 0 = allowed) restricts where points may be. Pixel-index
 * coordinates, like the tracker's.
 */
export function goodFeatures(
  gray: GrayImage,
  mask: Float32Array | null,
  opts: { count: number; minDistancePx: number; patchSize: number }
): Array<{ x: number; y: number; score: number; std: number }> {
  const { width: w, height: h, data } = gray;
  const half = Math.floor(opts.patchSize / 2);
  if (w < opts.patchSize + 4 || h < opts.patchSize + 4) return [];
  const ixx = new Float32Array(w * h);
  const ixy = new Float32Array(w * h);
  const iyy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = (data[i + 1] - data[i - 1]) / 2;
      const gy = (data[i + w] - data[i - w]) / 2;
      ixx[i] = gx * gx;
      ixy[i] = gx * gy;
      iyy[i] = gy * gy;
    }
  }
  const sxx = boxSum(ixx, w, h, 2);
  const sxy = boxSum(ixy, w, h, 2);
  const syy = boxSum(iyy, w, h, 2);
  const score = new Float32Array(w * h);
  let top = 0;
  const margin = Math.max(half + 1, 3);
  for (let y = margin; y < h - margin; y++) {
    for (let x = margin; x < w - margin; x++) {
      const i = y * w + x;
      if (mask && !(mask[i] > 0)) continue;
      const a = sxx[i];
      const b = sxy[i];
      const c = syy[i];
      const s = (a + c) / 2 - Math.sqrt(((a - c) / 2) * ((a - c) / 2) + b * b);
      score[i] = s;
      if (s > top) top = s;
    }
  }
  if (!(top > 0)) return [];
  const floor = top * 0.01;
  const cands: Array<{ x: number; y: number; score: number }> = [];
  for (let y = margin; y < h - margin; y++) {
    for (let x = margin; x < w - margin; x++) {
      const i = y * w + x;
      const s = score[i];
      if (s < floor) continue;
      let isMax = true;
      for (let dy = -1; dy <= 1 && isMax; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if ((dx || dy) && score[i + dy * w + dx] > s) {
            isMax = false;
            break;
          }
        }
      }
      if (isMax) cands.push({ x, y, score: s });
    }
  }
  cands.sort((p, q) => q.score - p.score);
  const out: Array<{ x: number; y: number; score: number; std: number }> = [];
  for (const c of cands) {
    if (out.length >= opts.count) break;
    if (out.some((o) => Math.hypot(o.x - c.x, o.y - c.y) < opts.minDistancePx)) continue;
    const std = patchStd(gray, c.x, c.y, half);
    if (std < 3) continue;
    out.push({ x: c.x, y: c.y, score: c.score, std });
  }
  return out;
}

function patchStd(img: GrayImage, cx: number, cy: number, half: number): number {
  let sum = 0;
  let sq = 0;
  let n = 0;
  for (let y = cy - half; y <= cy + half; y++) {
    for (let x = cx - half; x <= cx + half; x++) {
      const v = img.data[y * img.width + x];
      sum += v;
      sq += v * v;
      n++;
    }
  }
  const mean = sum / n;
  return Math.sqrt(Math.max(0, sq / n - mean * mean));
}

/** Sum over a (2r+1)^2 window, clamped at the edges. */
function boxSum(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += src[y * w + Math.min(w - 1, Math.max(0, x + k))];
      tmp[y * w + x] = s;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x];
      out[y * w + x] = s;
    }
  }
  return out;
}
