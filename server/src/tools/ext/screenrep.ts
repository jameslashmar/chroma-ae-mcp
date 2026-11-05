/**
 * server/src/tools/ext/screenrep.ts
 *
 * Replacing a screen, sign or poster on a tracked plane:
 * - ae_screen_corners: snaps four rough corner guesses (from a snapshot) to the
 *   real corners and says how far to trust them. Each side's edge is found as a
 *   gradient ridge along the side, fitted with a robust line (outliers dropped)
 *   and every corner is the intersection of its two lines, which works on rounded
 *   bezels where the corner itself has no feature; a Shi-Tomasi corner response
 *   is the fallback and the cross-check. Per corner: the new position, the shift,
 *   the edge strength, whether two parallel edges compete, and whether a
 *   template there passes the tracker's contrast test. For the quad: convexity,
 *   area, edge lengths, an aspect-ratio estimate with a range (Zhang and He's
 *   whiteboard method, which needs the focal length it estimates), whether a
 *   corner leaves the frame anywhere along a track, and 4-8 better points on the
 *   plane (inside the screen and on the bezel) for ae_track_multi. Read-only,
 *   unless `isolate_layers` is given: then it renders a temporary copy of the
 *   comp with only the plate on (two undo groups, a guarded write).
 * - ae_screen_replace: from a planar track and the screen's four corners at the
 *   reference frame, in ONE undo step: an insert precomp '<name> INSERT' at the
 *   screen's aspect (the source at 100%, the comp doing the fill or the fit), the
 *   insert layer above the plate, a CC Power Pin (or Corner Pin) keyed with the
 *   corners moved by the track in the insert layer's own space, with an overscan
 *   under the bezel; the plate's measured screen black on the insert (Levels
 *   Output Black), the bezel's measured softness as a 0-2 px Gaussian Blur;
 *   optional reflections (a Screen-mode duplicate of the plate keeping only its
 *   highlights, matted by the insert's alpha); optional motion blur (the track as
 *   transform + residual pin so layer motion blur works, or CC Force Motion Blur).
 *   It renders the plate before the write to measure, renders again afterwards
 *   for a before / after contact sheet, and lists the follow-ups.
 *
 * Not built, because AE cannot be scripted for it: rotoscoping hands or objects
 * that cross the screen (Roto Brush and Mocha have no API, and ML segmentation is
 * out of scope). The tool reports it and asks for a roto layer of the user's.
 *
 * Unmeasured on AE 26 (the code works either way and reports what it found):
 * - CC Power Pin's point names and order, its match names, and whether its
 *   Expansion parameter exists and takes a percentage (else the corners are
 *   pushed outward by the same amount, as a Corner Pin needs);
 * - Levels' parameter names and unit (the unit is read from the effect's own
 *   default Output White, so 0..1, 0..255 and 0..32768 all work), and whether the
 *   Gaussian Blur 'Blurriness' of 2.5 per pixel of sigma holds (planar.ts constant);
 * - whether a layer's startTime changes after the keys of its effects moved with it
 *   (insert_start is set before any key is written);
 * - the colour space of saveFrameToPng (taken as sRGB display values; with a
 *   linearized working space, Levels values are converted to linear light);
 * - whether Layer.duplicate puts the copy directly above the original (the tool
 *   moves it explicitly) and keeps the plate's audio (it is switched off on the copy).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { PNG } from "pngjs";
import { z } from "zod";
import { BridgeError, SLOW_TIMEOUT_MS } from "../../host.js";
import { buildJsxCall } from "../../jsx.js";
import { QueueWaitError } from "../../queue.js";
import { buildReceipt, type ReceiptMismatch } from "../../receipts.js";
import { AGENT_SAFETY_GUIDANCE, ExpectSchema, LayerSelectorSchema, type ExpectGuard, type LayerSelector, type ToolContext, type ToolDefinition } from "../common.js";
import { autoCheckpoint, verifyTargetGuard } from "../mutate.js";
import { defaultFramesDir } from "../render.js";
import { captureCompFrame, decodePngFile } from "./frames.js";
import {
  applyH,
  decomposeLayerMatrix,
  frameAt,
  goodFeatures,
  invertH,
  layerMatrix,
  mulH,
  quadCheck,
  relativeTo,
  solveModel,
  unwrapDegrees,
  type Mat3,
  type PlanarFrame,
  type PlanarTrack,
  type Vec2,
} from "./planar-math.js";
import { blurrinessFromSigma, createRenderBudget, PlanarError, resolveEffectParams, resolveTrackSource, TrackSourceSchema, withIsolatedPlate } from "./planar.js";
import { blit, createCanvas, drawCross, drawLabel, drawLine, drawPolygon, encodePng, fitWithin, resizeArea, type RgbaImage } from "./png-utils.js";
import { polygonArea, rasterizePolygon, srgbToLinear } from "./region-math.js";
import { noteAfterWrite, noteBeforeWrite, type WriteInfo } from "./session.js";
import { boxBlurGray, extractPatch, makeTemplate, toGray, type GrayImage } from "./track.js";
import { expectThat, runGuardedWrite } from "./write-runner.js";

// ---------- small helpers ----------

const r2 = (v: number): number => Math.round(v * 100) / 100;
const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const r4 = (v: number): number => Math.round(v * 10000) / 10000;
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const yieldLoop = () => new Promise<void>((r) => setImmediate(r));
const failure = (e: unknown) => ({ ok: false as const, error: (e as PlanarError).code, message: (e as Error).message });
const snapFrame = (t: number, fps: number): number => Math.round(t * fps) / fps;
/** Keys per property one call writes (the planar limit). */
const MAX_KEYS = 3000;
const CORNER_NAMES = ["UL", "UR", "LR", "LL"] as const;

const median = (a: number[]): number => {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const mean = (a: number[]): number => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);

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

function bilinear(a: Float32Array, w: number, h: number, x: number, y: number): number {
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
const MIN_EDGE = 3;

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

/** Weakest Shi-Tomasi response (sum over 5x5) that counts as a corner. */
const MIN_CORNER_SCORE = 30;

/** The strongest Shi-Tomasi corner within `r` pixels of (cx, cy), or null when the area is flat. */
export function cornerPeak(gr: Gradients, cx: number, cy: number, r: number): { x: number; y: number; score: number } | null {
  const { width: w, height: h, gx, gy } = gr;
  const margin = 3;
  const x0 = Math.max(margin, Math.round(cx) - r);
  const x1 = Math.min(w - 1 - margin, Math.round(cx) + r);
  const y0 = Math.max(margin, Math.round(cy) - r);
  const y1 = Math.min(h - 1 - margin, Math.round(cy) + r);
  let best: { x: number; y: number; score: number } | null = null;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let a = 0;
      let b = 0;
      let c = 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const i = (y + dy) * w + (x + dx);
          a += gx[i] * gx[i];
          b += gx[i] * gy[i];
          c += gy[i] * gy[i];
        }
      }
      const s = (a + c) / 2 - Math.sqrt(((a - c) / 2) ** 2 + b * b);
      if (!best || s > best.score) best = { x, y, score: s };
    }
  }
  return best && best.score >= MIN_CORNER_SCORE ? best : null;
}

export interface SideFit {
  index: number;
  found: number;
  expected: number;
  inliers: number;
  rms_px: number | null;
  /** Mean ridge strength, gray levels per pixel. */
  strength: number | null;
  /** Share of the found scan lines on which a second strong ridge competed. */
  competing_share: number;
  line: Line | null;
  normal: Vec2;
}

export type SnapMethod = "edge_intersection" | "corner_response" | "unchanged";

export interface CornerSnap {
  index: number;
  guess: Vec2;
  snapped: Vec2;
  method: SnapMethod;
  /** Distance from the guess, image pixels. */
  shift_px: number;
  edge_strength: number | null;
  competing_share: number;
  /** The weaker of the two sides: inlier lines over scan lines asked for. */
  line_share: number;
  corner_score: number | null;
  /** The corner response peak lies within 2.5 px of the intersection. */
  corner_agrees: boolean | null;
  template_std: number | null;
  trackable: boolean;
  confidence: number;
}

/**
 * Snaps four guesses (image pixels, index coordinates, in the order UL, UR, LR,
 * LL) to the quad they outline: each side's edge is scanned and fitted, each
 * corner is the intersection of its two lines when that lies within 1.5x the
 * search radius of the guess, else the strongest corner response in the search
 * window, else the guess itself. `patchSize` is the template side (image px) for
 * the trackability test (std at least 3 gray levels, the tracker's own test).
 */
export function snapQuad(gray: GrayImage, guesses: Vec2[], o: { searchPx: number; prefer: EdgePreference; patchSize: number }): { corners: CornerSnap[]; sides: SideFit[] } {
  const gr = sobel(gray);
  const cx = mean(guesses.map((p) => p[0]));
  const cy = mean(guesses.map((p) => p[1]));
  const sides: SideFit[] = [];
  for (let i = 0; i < 4; i++) {
    const a = guesses[i];
    const b = guesses[(i + 1) % 4];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let normal: Vec2 = [0, 0];
    if (len < 4) {
      sides.push({ index: i, found: 0, expected: 0, inliers: 0, rms_px: null, strength: null, competing_share: 0, line: null, normal });
      continue;
    }
    const dx = (b[0] - a[0]) / len;
    const dy = (b[1] - a[1]) / len;
    normal = [dy, -dx];
    const mid: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if ((mid[0] - cx) * normal[0] + (mid[1] - cy) * normal[1] < 0) normal = [-normal[0], -normal[1]];
    const scan = scanSide(gr, a, b, normal, { searchPx: o.searchPx, prefer: o.prefer });
    const line = fitLine(scan.points);
    sides.push({
      index: i,
      found: scan.found,
      expected: scan.expected,
      inliers: line ? line.inliers : 0,
      rms_px: line ? line.rms : null,
      strength: line ? mean(scan.strengths) : null,
      competing_share: scan.found > 0 ? scan.competing / scan.found : 0,
      line,
      normal,
    });
  }
  const corners: CornerSnap[] = guesses.map((g, i) => {
    const prev = sides[(i + 3) % 4];
    const next = sides[i];
    let snapped: Vec2 = [g[0], g[1]];
    let method: SnapMethod = "unchanged";
    let cornerScore: number | null = null;
    let agrees: boolean | null = null;
    let lineShare = 0;
    let strength: number | null = null;
    let competing = Math.max(prev.competing_share, next.competing_share);
    const meet = prev.line && next.line ? intersectLines(prev.line, next.line) : null;
    if (meet && Math.hypot(meet[0] - g[0], meet[1] - g[1]) <= 1.5 * o.searchPx) {
      snapped = meet;
      method = "edge_intersection";
      lineShare = Math.min(prev.inliers / Math.max(1, prev.expected), next.inliers / Math.max(1, next.expected));
      strength = mean([prev.strength ?? 0, next.strength ?? 0]);
      const peak = cornerPeak(gr, meet[0], meet[1], 3);
      if (peak) {
        cornerScore = peak.score;
        agrees = Math.hypot(peak.x - meet[0], peak.y - meet[1]) <= 2.5;
      } else {
        agrees = false;
      }
    } else {
      competing = 0;
      const peak = cornerPeak(gr, g[0], g[1], Math.round(o.searchPx));
      if (peak) {
        snapped = [peak.x, peak.y];
        method = "corner_response";
        cornerScore = peak.score;
      }
    }
    let confidence = 0.1;
    if (method === "edge_intersection") {
      const shareScore = Math.min(1, lineShare / 0.8);
      const strengthScore = Math.min(1, (strength ?? 0) / 15);
      confidence = 0.45 * shareScore + 0.35 * strengthScore + 0.2 * (agrees ? 1 : 0);
      if (competing > 0.3) confidence *= 0.65;
      if (Math.hypot(snapped[0] - g[0], snapped[1] - g[1]) > o.searchPx) confidence *= 0.7;
    } else if (method === "corner_response") {
      confidence = clamp(0.15 + 0.2 * Math.min(1, (cornerScore ?? 0) / 600), 0, 0.35);
    }
    const patch = extractPatch(gray, snapped[0], snapped[1], o.patchSize);
    const std = patch ? makeTemplate(patch).std : null;
    return {
      index: i,
      guess: g,
      snapped,
      method,
      shift_px: Math.hypot(snapped[0] - g[0], snapped[1] - g[1]),
      edge_strength: strength,
      competing_share: competing,
      line_share: lineShare,
      corner_score: cornerScore,
      corner_agrees: agrees,
      template_std: std,
      trackable: std !== null && std >= 3,
      confidence: r2(clamp(confidence, 0, 1)),
    };
  });
  return { corners, sides };
}

// ---------- aspect ratio ----------

type V3 = [number, number, number];
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export interface AspectEstimate {
  /** Width over height of the real rectangle. */
  aspect: number;
  /** The aspect for focal lengths 0.7x to 1.43x the estimated one (0.5x to 3x the comp width for assumed_focal). */
  range: [number, number];
  method: "perspective" | "edge_lengths" | "assumed_focal";
  /** The focal length the estimate came out at, in comp pixels (null without perspective). */
  focal_px: number | null;
  /** The plain ratio of the mean horizontal to the mean vertical edge length. */
  edge_ratio: number;
  /** The nearest familiar ratio when within 4%. */
  common_ratio: { name: string; value: number } | null;
}

const COMMON_RATIOS: Array<[string, number]> = [
  ["1:1", 1],
  ["5:4", 5 / 4],
  ["4:3", 4 / 3],
  ["3:2", 3 / 2],
  ["16:10", 16 / 10],
  ["16:9", 16 / 9],
  ["2:1", 2],
  ["21:9", 21 / 9],
  ["2.39:1", 2.39],
  ["4:5", 4 / 5],
  ["3:4", 3 / 4],
  ["2:3", 2 / 3],
  ["10:16", 10 / 16],
  ["9:16", 9 / 16],
  ["9:21", 9 / 21],
];

export function nearestCommonRatio(aspect: number): { name: string; value: number } | null {
  let best: { name: string; value: number } | null = null;
  let bestErr = Infinity;
  for (const [name, value] of COMMON_RATIOS) {
    const err = Math.abs(aspect - value) / value;
    if (err < bestErr) {
      bestErr = err;
      best = { name, value };
    }
  }
  return best && bestErr <= 0.04 ? best : null;
}

/**
 * The true width / height of a rectangle seen in perspective, from its four
 * corners [UL, UR, LR, LL] in pixels (Zhang and He, "Whiteboard scanning and
 * image enhancement", 2007). Square pixels and a principal point at `principal`
 * (the picture centre) are assumed; the focal length falls out of the corners
 * themselves. One view cannot pin the focal length down exactly, so the result
 * carries the aspect for focal lengths 0.7x to 1.43x the estimate as a range.
 * Without perspective (a parallelogram) the focal length is unknowable and the
 * ratio of the mean edge lengths is the answer. When one vanishing point is at or
 * near infinity (within corner noise; a screen turned about the vertical axis by
 * a level camera) the focal length cannot be solved: method "assumed_focal" takes
 * the comp width as the focal length and the range spans 0.5x to 3x of it.
 */
export function estimateAspect(corners: Vec2[], principal: Vec2): AspectEstimate {
  const [ul, ur, lr, ll] = corners;
  const m1: V3 = [ul[0], ul[1], 1];
  const m2: V3 = [ur[0], ur[1], 1];
  const m3: V3 = [ll[0], ll[1], 1];
  const m4: V3 = [lr[0], lr[1], 1];
  const horizontal = (Math.hypot(ur[0] - ul[0], ur[1] - ul[1]) + Math.hypot(lr[0] - ll[0], lr[1] - ll[1])) / 2;
  const vertical = (Math.hypot(ll[0] - ul[0], ll[1] - ul[1]) + Math.hypot(lr[0] - ur[0], lr[1] - ur[1])) / 2;
  const edgeRatio = vertical > 0 ? horizontal / vertical : 1;
  const plain = (method: AspectEstimate["method"]): AspectEstimate => ({
    aspect: edgeRatio,
    range: [edgeRatio, edgeRatio],
    method,
    focal_px: null,
    edge_ratio: edgeRatio,
    common_ratio: nearestCommonRatio(edgeRatio),
  });
  const k2 = dot3(cross3(m1, m4), m3) / dot3(cross3(m2, m4), m3);
  const k3 = dot3(cross3(m1, m4), m2) / dot3(cross3(m3, m4), m2);
  if (!Number.isFinite(k2) || !Number.isFinite(k3)) return plain("edge_lengths");
  const n2: V3 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 * m2[2] - m1[2]];
  const n3: V3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 * m3[2] - m1[2]];
  const [u0, v0] = principal;
  // q(n, f) = n' A^-T A^-1 n with A = [[f 0 u0] [0 f v0] [0 0 1]]; f = Infinity drops the first term.
  const q = (n: V3, f: number): number => ((n[0] - u0 * n[2]) ** 2 + (n[1] - v0 * n[2]) ** 2) / (f * f) + n[2] * n[2];
  const aspectAt = (f: number): number => Math.sqrt(q(n2, f) / q(n3, f));
  const denom = n2[2] * n3[2];
  const diag = Math.hypot(2 * u0, 2 * v0);
  // The focal length could not be solved (one vanishing point at or near infinity, as for a screen turned about the
  // vertical axis with a level camera, or noise pushed it out of reach). That is NOT the same as "no perspective":
  // use a prior focal length (the comp width, a full-frame-like lens) and report the aspect over a wide band.
  const assumed = (): AspectEstimate => {
    const f0 = Math.max(1, 2 * u0);
    const est0 = aspectAt(f0);
    const ends0 = [est0, aspectAt(f0 * 0.5), aspectAt(f0 * 3)].filter((v) => Number.isFinite(v) && v > 0);
    if (!Number.isFinite(est0) || !(est0 > 0)) return plain("edge_lengths");
    return {
      aspect: est0,
      range: [Math.min(...ends0), Math.max(...ends0)],
      method: "assumed_focal",
      focal_px: null,
      edge_ratio: edgeRatio,
      common_ratio: nearestCommonRatio(est0),
    };
  };
  // A true parallelogram: both vanishing points at infinity.
  if (Math.abs(n2[2]) < 1e-9 && Math.abs(n3[2]) < 1e-9) return plain("edge_lengths");
  if (Math.abs(denom) < 1e-9) return assumed();
  // Corner noise of about 2 px on the shortest edge leaves n[2] = k - 1 at roughly 2 / edge even for a vanishing point at
  // infinity, so a value below that cannot tell a distant vanishing point from none: treat the focal length as unknown.
  const minEdge = Math.min(...corners.map((p, i) => Math.hypot(corners[(i + 1) % 4][0] - p[0], corners[(i + 1) % 4][1] - p[1])));
  const nearZero = minEdge > 0 ? Math.max(0.003, 2 / minEdge) : 0.003;
  if (Math.min(Math.abs(n2[2]), Math.abs(n3[2])) < nearZero) return assumed();
  const f2 = -(n2[0] * n3[0] - (n2[0] * n3[2] + n2[2] * n3[0]) * u0 + denom * u0 * u0 + (n2[1] * n3[1] - (n2[1] * n3[2] + n2[2] * n3[1]) * v0 + denom * v0 * v0)) / denom;
  if (!(f2 > 0) || !Number.isFinite(f2)) return assumed();
  const f = Math.sqrt(f2);
  if (diag > 0 && (f < 0.3 * diag || f > 6 * diag)) return assumed();
  const est = aspectAt(f);
  if (!Number.isFinite(est) || !(est > 0)) return assumed();
  const ends = [est, aspectAt(f * 0.7), aspectAt(f * 1.43)].filter((v) => Number.isFinite(v) && v > 0);
  return {
    aspect: est,
    range: [Math.min(...ends), Math.max(...ends)],
    method: "perspective",
    focal_px: f,
    edge_ratio: edgeRatio,
    common_ratio: nearestCommonRatio(est),
  };
}

// ---------- quads ----------

export function quadMetrics(c: Vec2[]): { ok: boolean; reason?: string; area_px: number; edge_lengths_px: number[] } {
  const chk = quadCheck(c);
  return {
    ok: chk.ok,
    ...(chk.reason ? { reason: chk.reason } : {}),
    area_px: polygonArea(c),
    edge_lengths_px: c.map((p, i) => r2(Math.hypot(c[(i + 1) % 4][0] - p[0], c[(i + 1) % 4][1] - p[1]))),
  };
}

/** The quad scaled about its centroid. */
export function scaleQuad(q: Vec2[], k: number): Vec2[] {
  const cx = mean(q.map((p) => p[0]));
  const cy = mean(q.map((p) => p[1]));
  return q.map((p) => [cx + (p[0] - cx) * k, cy + (p[1] - cy) * k] as Vec2);
}

function insideConvex(q: Vec2[], p: Vec2): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const cr = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    const s = cr > 0 ? 1 : cr < 0 ? -1 : 0;
    if (s !== 0) {
      if (sign === 0) sign = s;
      else if (s !== sign) return false;
    }
  }
  return true;
}

export interface Excursions {
  frames_checked: number;
  /** Frames with no solved motion, left out of the rest. */
  frames_unsolved: number;
  frames_outside: number;
  first_outside_time: number | null;
  last_outside_time: number | null;
  /** Per corner (UL, UR, LR, LL): frames on which it lies outside the comp. */
  per_corner: number[];
  /** Frames on which the moved quad is folded or not convex. */
  frames_folded: number;
  /** The smallest distance from a corner to the comp's edge over the track (negative when outside). */
  min_margin_px: number | null;
}

/** Where the corners go along a track that has been re-based so its reference frame is the identity. */
export function cornerExcursions(track: PlanarTrack, corners: Vec2[], size: Vec2): Excursions {
  const out: Excursions = { frames_checked: 0, frames_unsolved: 0, frames_outside: 0, first_outside_time: null, last_outside_time: null, per_corner: [0, 0, 0, 0], frames_folded: 0, min_margin_px: null };
  for (const f of track.frames) {
    if (!f.ok || !f.H) {
      out.frames_unsolved++;
      continue;
    }
    const q = corners.map((c) => applyH(f.H as Mat3, c));
    if (q.some((p) => p === null)) {
      out.frames_unsolved++;
      continue;
    }
    out.frames_checked++;
    const pts = q as Vec2[];
    let outside = false;
    pts.forEach((p, k) => {
      const margin = Math.min(p[0], p[1], size[0] - p[0], size[1] - p[1]);
      out.min_margin_px = out.min_margin_px === null ? margin : Math.min(out.min_margin_px, margin);
      if (margin < 0) {
        out.per_corner[k]++;
        outside = true;
      }
    });
    if (outside) {
      out.frames_outside++;
      if (out.first_outside_time === null) out.first_outside_time = f.time;
      out.last_outside_time = f.time;
    }
    if (!quadCheck(pts).ok) out.frames_folded++;
  }
  return out;
}

// ---------- tracking points on the plane ----------

export interface SuggestedPoint {
  /** Comp pixels. */
  x: number;
  y: number;
  score: number;
  contrast: number;
  zone: "inside" | "bezel";
}

/**
 * Better points to track than the corners themselves (glare, fingers): the
 * strongest Shi-Tomasi corners of the slightly blurred frame inside the quad
 * grown by 6% (so the bezel is included), spread out, each passing the tracker's
 * contrast test. The same picker as ae_track_multi's auto_points.
 */
export function suggestPoints(gray: GrayImage, quadComp: Vec2[], o: { scale: number; count: number; patchSize: number }): SuggestedPoint[] {
  const grown = scaleQuad(quadComp, 1.06);
  const mask = rasterizePolygon(gray.width, gray.height, grown.map((p) => [p[0] * o.scale, p[1] * o.scale] as [number, number]), 0);
  const patchImg = Math.max(9, Math.round(o.patchSize * o.scale) | 1);
  const shortest = Math.min(...quadComp.map((p, i) => Math.hypot(quadComp[(i + 1) % 4][0] - p[0], quadComp[(i + 1) % 4][1] - p[1])));
  const minDist = Math.max(o.patchSize, shortest / 5) * o.scale;
  const feats = goodFeatures(boxBlurGray(gray, 1), mask, { count: o.count, minDistancePx: minDist, patchSize: patchImg });
  return feats.map((f) => {
    const p: Vec2 = [(f.x + 0.5) / o.scale, (f.y + 0.5) / o.scale];
    return { x: r2(p[0]), y: r2(p[1]), score: r2(f.score), contrast: r2(f.std), zone: insideConvex(quadComp, p) ? ("inside" as const) : ("bezel" as const) };
  });
}

// ---------- measuring the plate ----------

/** Quantiles (0..1) of Rec. 709 luma of the encoded pixels under a mask >= 0.5, and how many pixels that was. */
export function lumaQuantiles(img: RgbaImage, mask: Float32Array, qs: number[], opts: { minAlpha?: number } = {}): { values: number[]; pixels: number } {
  const hist = new Uint32Array(256);
  let total = 0;
  const minAlpha = opts.minAlpha ?? 0;
  for (let k = 0; k < img.width * img.height; k++) {
    if (mask[k] < 0.5) continue;
    const i = k * 4;
    if (img.data[i + 3] < minAlpha) continue;
    hist[Math.min(255, Math.round(0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2]))]++;
    total++;
  }
  const values = qs.map((q) => {
    if (total === 0) return 0;
    const target = q * total;
    let acc = 0;
    for (let i = 0; i < 256; i++) {
      acc += hist[i];
      if (acc >= target) return i / 255;
    }
    return 1;
  });
  return { values, pixels: total };
}

export interface EdgeSigma {
  /** Gaussian sigma of the edge in comp pixels, after taking out the snapshot's own softening. Null when it could not be measured. */
  sigma_px: number | null;
  /** The raw figure before that correction. */
  sigma_measured_px: number | null;
  /** Step height, gray levels. */
  contrast: number;
  samples: number;
  reason?: string;
}

/**
 * How soft the quad's edge is: the profile across each side (24 positions on
 * the middle 60%), each aligned on its steepest point and flipped to rise, is
 * averaged; the 10-90% rise over 2.563 is the sigma of a Gaussian-blurred step.
 * A snapshot at `scale` image px per comp px is itself area-averaged (about
 * 0.29 image px of sigma), taken out in quadrature. `quadImg` is in image index
 * coordinates; the sides are searched +-6 px around it.
 */
export function quadEdgeSigma(gray: GrayImage, quadImg: Vec2[], scale: number): EdgeSigma {
  const half = 6;
  const step = 0.5;
  const n = Math.round((2 * half) / step) + 1;
  const acc = new Float64Array(n);
  const cnt = new Float64Array(n);
  const { width: w, height: h } = gray;
  const cx = mean(quadImg.map((p) => p[0]));
  const cy = mean(quadImg.map((p) => p[1]));
  let used = 0;
  for (let i = 0; i < 4; i++) {
    const a = quadImg[i];
    const b = quadImg[(i + 1) % 4];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 8) continue;
    let nx = (b[1] - a[1]) / len;
    let ny = -(b[0] - a[0]) / len;
    if (((a[0] + b[0]) / 2 - cx) * nx + ((a[1] + b[1]) / 2 - cy) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    for (let s = 0; s < 24; s++) {
      const u = 0.2 + (0.6 * (s + 0.5)) / 24;
      const px = a[0] + (b[0] - a[0]) * u;
      const py = a[1] + (b[1] - a[1]) * u;
      if (px - half * 2 < 1 || py - half * 2 < 1 || px + half * 2 > w - 2 || py + half * 2 > h - 2) continue;
      const prof = new Float64Array(n);
      for (let j = 0; j < n; j++) {
        const d = -half + j * step;
        prof[j] = bilinear(gray.data, w, h, px + nx * d, py + ny * d);
      }
      let jm = -1;
      let best = 0;
      let signed = 0;
      for (let j = 1; j < n - 1; j++) {
        const g = prof[j + 1] - prof[j - 1];
        if (Math.abs(g) > best) {
          best = Math.abs(g);
          signed = g;
          jm = j;
        }
      }
      if (jm < 0 || best < 2) continue;
      const sgn = signed < 0 ? -1 : 1;
      const mid = Math.floor(n / 2);
      for (let k = 0; k < n; k++) {
        const j = jm + (k - mid);
        if (j < 0 || j >= n) continue;
        acc[k] += sgn * prof[j];
        cnt[k]++;
      }
      used++;
    }
  }
  if (used < 8) return { sigma_px: null, sigma_measured_px: null, contrast: 0, samples: used, reason: "too few clean edge profiles (the edge is flat, or too close to the frame's border)" };
  const avg: number[] = [];
  for (let k = 0; k < n; k++) avg.push(cnt[k] > 0 ? acc[k] / cnt[k] : NaN);
  const ok = avg.map((v, k) => (cnt[k] >= used * 0.5 ? k : -1)).filter((k) => k >= 0);
  if (ok.length < 8) return { sigma_px: null, sigma_measured_px: null, contrast: 0, samples: used, reason: "the profiles do not line up" };
  const lo = mean(ok.slice(0, 3).map((k) => avg[k]));
  const hi = mean(ok.slice(-3).map((k) => avg[k]));
  const contrast = hi - lo;
  if (contrast < 6) return { sigma_px: null, sigma_measured_px: null, contrast: r2(contrast), samples: used, reason: "the step is under 6 gray levels, too faint to read a softness from" };
  const norm = ok.map((k) => (avg[k] - lo) / contrast);
  const cross = (level: number): number | null => {
    for (let i = 1; i < ok.length; i++) {
      if (norm[i - 1] < level && norm[i] >= level) {
        const t = (level - norm[i - 1]) / (norm[i] - norm[i - 1]);
        return ok[i - 1] + t * (ok[i] - ok[i - 1]);
      }
    }
    return null;
  };
  const d10 = cross(0.1);
  const d90 = cross(0.9);
  if (d10 === null || d90 === null || d90 <= d10) return { sigma_px: null, sigma_measured_px: null, contrast: r2(contrast), samples: used, reason: "the averaged profile is not a clean step" };
  const sigmaImg = ((d90 - d10) * step) / 2.563;
  const measured = sigmaImg / scale;
  const sampling = 0.289 / scale;
  return { sigma_px: r3(Math.sqrt(Math.max(0, measured * measured - sampling * sampling))), sigma_measured_px: r3(measured), contrast: r2(contrast), samples: used };
}

// ---------- the look ----------

export interface LevelsPlan {
  skip: boolean;
  reason?: string;
  in_black: number;
  in_white: number;
  out_black: number;
  out_white: number;
  notes: string[];
}

/**
 * Levels that put the insert's blacks on the screen's. All figures are fractions
 * of full white (0..1) in the PROJECT's working space: measured values are
 * sRGB-encoded, so with linear blending they are converted to linear light.
 * Output Black is the plate's black; Input Black is the insert's own black (0
 * unless measured or given); Output White stays at 1 unless `whiteMode` is
 * 'match', because a dark old picture says nothing about how bright the screen can go.
 */
export function planLevels(m: { plateBlack: number; plateWhite: number; insertBlack: number; insertWhite: number; whiteMode: "keep" | "match"; linear: boolean }): LevelsPlan {
  const notes: string[] = [];
  let outBlack = clamp(m.plateBlack, 0, 1);
  if (outBlack > 0.5) {
    outBlack = 0.5;
    notes.push(`The plate's measured screen black (${r3(m.plateBlack)}) is over 0.5, which is a picture, not a black level: Output Black was capped at 0.5.`);
  }
  let inBlack = clamp(m.insertBlack, 0, 0.5);
  let inWhite = clamp(m.insertWhite, 0, 1);
  if (inWhite < inBlack + 0.25) inWhite = 1;
  let outWhite = 1;
  if (m.whiteMode === "match") outWhite = clamp(m.plateWhite, outBlack + 0.25, 1);
  const conv = (v: number): number => (m.linear ? srgbToLinear(v) : v);
  const plan = { in_black: conv(inBlack), in_white: conv(inWhite), out_black: conv(outBlack), out_white: conv(outWhite) };
  if (m.linear) notes.push("The working space is linearized: the sRGB-encoded measurements were converted to linear light for Levels.");
  const skip = plan.out_black < 0.004 && plan.in_black < 0.004 && plan.in_white > 0.996 && plan.out_white > 0.996;
  return { skip, ...(skip ? { reason: "the screen's black is already at the insert's black (both under 0.4%), so Levels would change nothing" } : {}), ...plan, notes };
}

/**
 * The size of the insert comp. The source sits in it at 100% and centred, so the
 * comp does the fitting: 'fill' is the largest rectangle of the screen's aspect
 * inside the source (the overflow is cropped), 'fit' the smallest one around it
 * (the rest is empty). Whole pixels between 4 and 30000.
 */
export function insertCompSize(src: { width: number; height: number }, aspect: number, fit: "fill" | "fit"): [number, number] {
  const sa = src.width / src.height;
  let w: number;
  let h: number;
  if (fit === "fill") {
    if (sa > aspect) {
      h = src.height;
      w = h * aspect;
    } else {
      w = src.width;
      h = w / aspect;
    }
  } else if (sa > aspect) {
    w = src.width;
    h = w / aspect;
  } else {
    h = src.height;
    w = h * aspect;
  }
  return [clamp(Math.round(w), 4, 30000), clamp(Math.round(h), 4, 30000)];
}

// ---------- the pin keys ----------

export interface InsertKeys {
  times: number[];
  /** The corners where the track puts them, in the insert layer's own space. */
  exact: { ul: Vec2[]; ur: Vec2[]; ll: Vec2[]; lr: Vec2[] };
  /** The same corners pushed outward from the quad's centre by the expansion. */
  expanded: { ul: Vec2[]; ur: Vec2[]; ll: Vec2[]; lr: Vec2[] };
  /** Layer transform keys (transform_pin only). */
  transform?: { position: Vec2[]; rotation: number[]; scale: Vec2[] };
  skipped: number[];
  /** Largest distance between the track's motion and the similarity written to the transform (transform_pin). */
  max_fit_px: number;
}

const round2 = (v: Vec2): Vec2 => [r4(v[0]), r4(v[1])];

/**
 * The keys that make a new insert layer follow the track. The layer is the
 * insert comp at its default place (anchor at its centre, position at the comp's
 * centre, 100%, no rotation), so its layer -> comp matrix is known without the
 * layer existing. `refCorners` are the screen's corners [UL, UR, LR, LL] at the
 * track's reference frame and `frames` the track re-based on that frame, so the
 * corners at time t are H(t) . corner. A pin effect takes its points in the
 * layer's own space: P(t) = M(t)^-1 . H(t) . corner, where M is the layer's matrix.
 * With `transform` M(t) follows the best similarity of the track (position,
 * rotation, scale around the anchor, which layer motion blur can blur) and the
 * pin keeps the rest of the perspective. `expansionPct` pushes the corners out
 * from the quad's centre in comp space before they are brought into layer space.
 */
export function buildInsertKeys(a: { frames: PlanarFrame[]; refCorners: Vec2[]; compSize: Vec2; insertSize: Vec2; expansionPct: number; transform: boolean }): InsertKeys {
  const anchor: Vec2 = [a.insertSize[0] / 2, a.insertSize[1] / 2];
  const M0 = layerMatrix({ anchor, position: [a.compSize[0] / 2, a.compSize[1] / 2], scale_pct: [100, 100], rotation_deg: 0 });
  const mk = () => ({ ul: [] as Vec2[], ur: [] as Vec2[], ll: [] as Vec2[], lr: [] as Vec2[] });
  const exact = mk();
  const expanded = mk();
  const tr = { position: [] as Vec2[], rotation: [] as number[], scale: [] as Vec2[] };
  const times: number[] = [];
  const skipped: number[] = [];
  let maxFit = 0;
  const grow = 1 + a.expansionPct / 100;
  for (const f of a.frames) {
    if (!f.ok || !f.H) {
      skipped.push(f.time);
      continue;
    }
    const q = a.refCorners.map((c) => applyH(f.H as Mat3, c));
    if (q.some((p) => p === null)) {
      skipped.push(f.time);
      continue;
    }
    const moved = q as Vec2[];
    let M: Mat3 = M0;
    let dec: ReturnType<typeof decomposeLayerMatrix> | null = null;
    if (a.transform) {
      const fit = solveModel("similarity", a.refCorners, moved);
      if (!fit) {
        skipped.push(f.time);
        continue;
      }
      maxFit = Math.max(maxFit, fit.max_px);
      dec = decomposeLayerMatrix(mulH(fit.H, M0), anchor);
      M = layerMatrix({ anchor, position: dec.position, scale_pct: dec.scale_pct, rotation_deg: dec.rotation_deg });
    }
    const inv = invertH(M);
    if (!inv) {
      skipped.push(f.time);
      continue;
    }
    const inLayer = (pts: Vec2[]): Vec2[] | null => {
      const mapped = pts.map((p) => applyH(inv, p));
      return mapped.some((p) => p === null) ? null : (mapped as Vec2[]);
    };
    const ex = inLayer(moved);
    const gx = inLayer(scaleQuad(moved, grow));
    if (!ex || !gx) {
      skipped.push(f.time);
      continue;
    }
    times.push(f.time);
    // The quad runs UL, UR, LR, LL; the pin's roles are UL, UR, LL, LR.
    exact.ul.push(round2(ex[0]));
    exact.ur.push(round2(ex[1]));
    exact.lr.push(round2(ex[2]));
    exact.ll.push(round2(ex[3]));
    expanded.ul.push(round2(gx[0]));
    expanded.ur.push(round2(gx[1]));
    expanded.lr.push(round2(gx[2]));
    expanded.ll.push(round2(gx[3]));
    if (dec) {
      tr.position.push(round2(dec.position));
      tr.rotation.push(dec.rotation_deg);
      tr.scale.push(round2(dec.scale_pct));
    }
  }
  return {
    times,
    exact,
    expanded,
    ...(a.transform ? { transform: { position: tr.position, rotation: unwrapDegrees(tr.rotation).map(r4), scale: tr.scale } } : {}),
    skipped,
    max_fit_px: r2(maxFit),
  };
}

// ---------- which frames to render ----------

export interface SheetPick {
  label: "first" | "reference" | "last" | "fastest";
  time: number;
}

function nearestOk(ok: PlanarFrame[], t: number): PlanarFrame {
  let best = ok[0];
  for (const f of ok) if (Math.abs(f.time - t) < Math.abs(best.time - t)) best = f;
  return best;
}

/**
 * The frames of the contact sheet: the first and last solved frame, the
 * reference, and the one where the screen moves fastest (the largest step of the
 * quad's centre per second between two neighbouring solved frames).
 */
export function pickSheetFrames(track: PlanarTrack, corners: Vec2[], refTime: number): SheetPick[] {
  const ok = track.frames.filter((f) => f.ok && f.H);
  if (ok.length === 0) return [];
  const centre = (f: PlanarFrame): Vec2 | null => {
    const q = corners.map((c) => applyH(f.H as Mat3, c));
    if (q.some((p) => p === null)) return null;
    return [mean((q as Vec2[]).map((p) => p[0])), mean((q as Vec2[]).map((p) => p[1]))];
  };
  let fastest: PlanarFrame | null = null;
  let best = 0;
  for (let i = 1; i < ok.length; i++) {
    const a = centre(ok[i - 1]);
    const b = centre(ok[i]);
    const dt = ok[i].time - ok[i - 1].time;
    if (!a || !b || !(dt > 0)) continue;
    const speed = Math.hypot(b[0] - a[0], b[1] - a[1]) / dt;
    if (speed > best) {
      best = speed;
      fastest = ok[i];
    }
  }
  const ref = frameAt(track, refTime);
  const picks: SheetPick[] = [
    { label: "first", time: ok[0].time },
    { label: "reference", time: ref ? ref.time : nearestOk(ok, refTime).time },
    { label: "last", time: ok[ok.length - 1].time },
  ];
  if (fastest) picks.push({ label: "fastest", time: fastest.time });
  const seen = new Set<number>();
  return picks.filter((p) => {
    const key = Math.round(p.time * 1e6);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The frame times to render for measuring: up to `maxSamples` evenly spread over
 * the solved frames, plus the contact-sheet frames, never more than `maxRenders`
 * (the sheet frames and the reference are kept first).
 */
export function planSampleTimes(o: { times: number[]; refTime: number; sheet: number[]; maxSamples: number; maxRenders: number }): { times: number[]; trimmed: boolean } {
  const all = o.times;
  if (all.length === 0) return { times: [], trimmed: false };
  const nearest = (t: number): number => all.reduce((b, v) => (Math.abs(v - t) < Math.abs(b - t) ? v : b), all[0]);
  const must = new Set<number>([nearest(o.refTime), ...o.sheet.map(nearest)]);
  const spread = new Set<number>();
  const n = Math.min(o.maxSamples, all.length);
  for (let k = 0; k < n; k++) spread.add(all[n === 1 ? 0 : Math.round((k * (all.length - 1)) / (n - 1))]);
  const picked = new Set<number>(must);
  let trimmed = false;
  for (const t of spread) {
    if (picked.size >= o.maxRenders) {
      if (!picked.has(t)) trimmed = true;
      continue;
    }
    picked.add(t);
  }
  const times = [...picked].sort((a, b) => a - b);
  if (times.length > o.maxRenders) {
    trimmed = true;
    return { times: times.slice(0, o.maxRenders), trimmed };
  }
  return { times, trimmed };
}

// ---------- pictures ----------

const RED: [number, number, number, number] = [255, 60, 60, 255];
const GREEN: [number, number, number, number] = [80, 255, 120, 255];
const YELLOW: [number, number, number, number] = [255, 214, 0, 255];
const CYAN: [number, number, number, number] = [0, 220, 255, 255];

/** The reference frame with the guesses (red), the snapped quad (green), the fitted edges (yellow) and the suggested points (cyan). */
export function drawCornersPreview(frame: RgbaImage, compSize: Vec2, o: { guesses: Vec2[]; snapped: Vec2[]; edges: Array<[Vec2, Vec2] | null>; points: SuggestedPoint[]; maxSize: number }): PNG {
  const fit = fitWithin(frame.width, frame.height, o.maxSize);
  const img = resizeArea(frame, fit.width, fit.height);
  const k = fit.width / compSize[0];
  const sc = (p: Vec2): [number, number] => [p[0] * k, p[1] * k];
  drawPolygon(img, o.guesses.map(sc), 1, RED);
  for (const e of o.edges) if (e) drawLine(img, Math.round(e[0][0] * k), Math.round(e[0][1] * k), Math.round(e[1][0] * k), Math.round(e[1][1] * k), 1, YELLOW);
  drawPolygon(img, o.snapped.map(sc), 1, GREEN);
  o.snapped.forEach((p, i) => {
    drawCross(img, p[0] * k, p[1] * k, 5, 1, GREEN);
    drawLabel(img, CORNER_NAMES[i], Math.round(p[0] * k) + 6, Math.round(p[1] * k) + 4, 1, [16, 16, 16, 255], GREEN, 1);
  });
  for (const p of o.points) drawCross(img, p.x * k, p.y * k, 4, 1, CYAN);
  return img;
}

export interface SheetShot {
  label: string;
  time: number;
  image: RgbaImage;
}

/** Before above, after below, one column per picked frame. */
export function drawBeforeAfterSheet(before: SheetShot[], after: SheetShot[], maxTile: number): PNG | null {
  const cols = Math.min(before.length, after.length);
  if (cols === 0) return null;
  const tiles = (shots: SheetShot[], tag: string): PNG[] =>
    shots.slice(0, cols).map((s) => {
      const fit = fitWithin(s.image.width, s.image.height, maxTile);
      const img = resizeArea(s.image, fit.width, fit.height);
      drawLabel(img, `${tag} ${s.label} t=${r2(s.time)}`, 3, 3, 1, [16, 16, 16, 255], YELLOW, 2);
      return img;
    });
  const top = tiles(before, "before");
  const bottom = tiles(after, "after");
  const gap = 4;
  const w = top.reduce((s, t) => s + t.width, 0) + gap * (cols - 1);
  const rowH = Math.max(...top.map((t) => t.height));
  const rowH2 = Math.max(...bottom.map((t) => t.height));
  const sheet = createCanvas(w, rowH + rowH2 + gap, [24, 24, 24, 255]);
  let x = 0;
  for (let c = 0; c < cols; c++) {
    blit(sheet, top[c], x, 0);
    blit(sheet, bottom[c], x, rowH + gap);
    x += Math.max(top[c].width, bottom[c].width) + gap;
  }
  return sheet;
}

function writePng(framesDir: string, tag: string, png: PNG): string {
  fs.mkdirSync(framesDir, { recursive: true });
  const file = path.join(framesDir, `${tag}.png`);
  fs.writeFileSync(file, encodePng(png));
  return file;
}

// ---------- queue and host plumbing ----------

async function queued<T>(ctx: ToolContext, label: string, opId: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await ctx.queue.run(label, fn);
  } catch (err) {
    if (err instanceof QueueWaitError) throw new BridgeError({ kind: "queued", op_id: opId, message: err.message });
    throw err;
  }
}

/** A read-only host call inside a queue lease the caller already holds. */
async function readHost<T>(ctx: ToolContext, opId: string, tag: string, host: string, args: unknown, toolName: string): Promise<T> {
  const res = await ctx.bridge.evalRaw<T>({
    id: `${opId}_${tag}`,
    script: buildJsxCall(host, args),
    label: `${toolName} ${tag}`,
    mutates: false,
    toolName,
  });
  return res.result;
}

/** AE stopped answering: more renders would only queue behind the same block. */
function isAeBlocked(err: unknown): boolean {
  return err instanceof BridgeError && (err.kind === "timeout" || err.kind === "queued");
}

interface CompInfo {
  id: number;
  name: string;
  width: number;
  height: number;
  pixel_aspect: number;
  fps: number;
  duration: number;
  time: number;
  work_area_start: number;
  work_area_duration: number;
  layers: Array<{ index: number; id: number; name: string; locked: boolean; enabled: boolean; three_d: boolean }>;
}

async function readComp(ctx: ToolContext, opId: string, compId: number, layers: LayerSelector[] | undefined, toolName: string): Promise<CompInfo> {
  const info = await readHost<CompInfo>(ctx, opId, "comp", "planarComp", { comp_id: compId, ...(layers ? { layers } : {}) }, toolName);
  if (Number(info.pixel_aspect) > 0 && Math.abs(Number(info.pixel_aspect) - 1) > 1e-6) {
    throw new PlanarError("refused", `The comp's pixel aspect is ${info.pixel_aspect}, not 1. Screen replacement works on square pixels only.`);
  }
  return info;
}

/** Renders one frame of a comp, decodes it and deletes the file. */
async function renderFrame(ctx: ToolContext, opId: string, compId: number, time: number, index: number, framesDir: string, toolName: string): Promise<{ image: PNG; time: number }> {
  const s = await captureCompFrame({ ctx, opId, compId, time, frameIndex: index, framesDir, toolName });
  try {
    return { image: decodePngFile(s.path), time: s.time };
  } finally {
    fs.rmSync(s.path, { force: true });
  }
}

// ---------- schemas ----------

const Point = z.array(z.number().finite()).length(2);

const CornersField = z
  .array(Point)
  .length(4)
  .describe("The screen's four corners [UL, UR, LR, LL] in comp pixels (x right, y down, the comp's top-left is [0, 0]) at ref_time, in that order: upper left, upper right, lower right, lower left.");

export const AeScreenCornersSchema = z
  .object({
    comp_id: z.number().int(),
    corners: CornersField.describe(
      "Rough guesses of the screen's four corners [UL, UR, LR, LL] in comp pixels at ref_time, for example read off a snapshot. They may be a few pixels off; search_px says how far the tool looks."
    ),
    ref_time: z.number().min(0).optional().describe("The frame the corners are guessed on, in seconds. Default: the comp's current time if it is inside the comp, else the middle of the work area."),
    search_px: z.number().min(2).max(100).default(24).describe("How far (comp pixels) from each guess to look for the edge and the corner. Default 24."),
    edge: z
      .enum(["outer", "inner", "nearest"])
      .default("outer")
      .describe(
        "Which edge to take when a side shows two strong ones (a bezel and the picture inside it): the outermost (default: reflections and screen content inside cannot fake it), the innermost, or the one nearest the guess."
      ),
    insert_aspect: z.number().positive().optional().describe("The insert's width / height, when known (16/9 = 1.778). It is reported next to the estimate and is what a later ae_screen_replace should be given."),
    track: TrackSourceSchema.optional().describe("A planar track (a stored track_id, or any source ae_track_read takes) of this screen. With it the tool also reports whether a corner leaves the frame anywhere in the shot, and where the quad folds."),
    point_count: z.number().int().min(4).max(8).default(6).describe("How many tracking points to suggest on the plane (4-8). Default 6."),
    pattern_size: z.number().int().min(9).max(201).default(31).describe("Side of a tracking pattern in comp pixels, for the contrast test and the spacing of the suggested points. Default 31, as in ae_track_multi."),
    isolate_layers: z
      .array(LayerSelectorSchema)
      .min(1)
      .max(100)
      .optional()
      .describe("Look at only these layers (the plate): a temporary copy of the comp with every other layer off is rendered, so an overlay above the screen cannot fool the edge search. The copy is removed in the same call (two undo entries). Needs `expect`."),
    preview: z.boolean().default(true).describe("Write a PNG of the frame with the guesses (red), the snapped quad (green), the fitted edges (yellow) and the suggested points (cyan). Default true."),
    max_size: z.number().int().min(320).max(3000).default(1280).describe("Long edge of the preview in pixels. Default 1280."),
    expect: ExpectSchema.optional().describe("Needed with isolate_layers."),
  })
  .refine((v) => v.isolate_layers === undefined || v.expect !== undefined, { message: "isolate_layers writes a temporary comp: give `expect` (project_path and optionally comp_id)." });

export type AeScreenCornersArgs = z.infer<typeof AeScreenCornersSchema>;

const InsertSchema = z
  .object({
    item_id: z.number().int().optional().describe("A project item (footage or comp) to put in the screen."),
    layer: LayerSelectorSchema.optional().describe("A layer of this comp whose source is the insert. Its own effects, masks, trim and transform are NOT carried; by default the layer is switched off."),
  })
  .refine((v) => [v.item_id, v.layer].filter((x) => x !== undefined).length === 1, { message: "Give exactly one of item_id or layer." });

export const AeScreenReplaceSchema = z
  .object({
    comp_id: z.number().int(),
    track: TrackSourceSchema.describe("The planar track of the screen: a stored track_id from ae_track_multi / ae_track_read, or any source ae_track_read takes. A perspective track (4+ points) follows the screen's changing angle; a similarity track only moves it flat."),
    corners: CornersField.describe("The screen's four corners [UL, UR, LR, LL] in comp pixels at ref_time: take them from ae_screen_corners. The track moves these."),
    ref_time: z.number().min(0).optional().describe("The frame the corners are given on, in seconds. Default: the track's own reference frame. The track is re-based so this frame is the identity."),
    insert: InsertSchema.describe("What goes in the screen: a project item (item_id) or a layer's source."),
    name: z.string().min(1).max(190).optional().describe("Base name. The comp and layer are called '<name> INSERT' (the reflections '<name> reflections'). Default: the insert's name."),
    fit: z.enum(["fill", "fit"]).default("fill").describe("fill: the insert covers the whole screen and the overflow is cropped. fit: the whole insert is shown with empty bars. Either way it keeps its proportions."),
    insert_aspect: z.number().min(0.1).max(10).optional().describe("The screen's real width / height (16/9 = 1.778). Default: estimated from the corners in perspective (see ae_screen_corners), which is an estimate; give it when you know the panel's ratio."),
    insert_start: z.number().min(-10800).max(10800).optional().describe("Comp time (seconds) at which the insert's first frame plays. Default 0. The insert layer starts there, so the old screen shows before a positive insert_start (the keys before it are not visible); a negative one starts the insert partway in (the insert comp is lengthened to still cover the shot)."),
    plate: LayerSelectorSchema.optional().describe("The plate layer. The insert goes directly above it; reflections need it. Default: the top of the stack."),
    pin: z.enum(["power_pin", "corner_pin"]).default("power_pin").describe("CC Power Pin (default; it has an Expansion parameter and keys directly) or Corner Pin."),
    expansion_pct: z.number().min(0).max(10).default(2).describe("Overscan under the bezel, percent of the screen. CC Power Pin: its Expansion parameter when it exists; otherwise (and for Corner Pin) the corners are pushed outward from the screen's centre by this much. 0 for none. Default 2."),
    motion_blur: z
      .enum(["none", "transform_pin", "force"])
      .default("none")
      .describe(
        "none: the pin alone (pin effects get no layer motion blur). transform_pin: the similarity part of the track on the layer's Position, Rotation and Scale plus the residual perspective in the pin, with the layer's motion blur switch on (and the comp's, if it was off). force: CC Force Motion Blur on the layer."
      ),
    match_look: z.boolean().default(true).describe("Measure the plate and match it: Levels so the insert's blacks sit at the screen's black, and a 0-2 px Gaussian Blur from the bezel's softness. Needs renders. Default true."),
    white_mode: z.enum(["keep", "match"]).default("keep").describe("Levels Output White: keep it at white (default; the old picture's brightest pixels say nothing about the screen's limit) or match the plate's measured white."),
    insert_black: z.number().min(0).max(1).optional().describe("The insert's own black level (0..1, encoded), used as Levels Input Black. Measured when the insert is a comp; footage is taken as 0 unless you give it."),
    insert_white: z.number().min(0).max(1).optional().describe("The insert's own white level (0..1, encoded), used as Levels Input White. Measured when the insert is a comp; footage is taken as 1."),
    blur_px: z.number().min(0).max(4).optional().describe("Gaussian sigma as it should look on screen, in comp pixels, instead of the measured one (0 for none). The measured value is capped at 2. It is converted to the insert's own pixels (the blur runs before the pin) before it is written."),
    reflections: z.boolean().default(false).describe("Put a duplicate of the plate above the insert in Screen mode with Levels that keep only its highlights, track-matted by the insert's alpha, so glare and reflections stay on top (the insert layer stays switched on although AE hides a layer used as a matte). Needs `plate` and AE 23+. The duplicate also carries the old screen's brightest content, so check it and lower reflection_opacity if needed."),
    reflection_threshold: z.number().min(0).max(1).optional().describe("Levels Input Black of the reflection layer (0..1, encoded): only plate pixels brighter than this stay. Default: the old screen's measured 95th percentile luma plus 0.03."),
    reflection_opacity: z.number().min(0).max(100).default(100).describe("Opacity of the reflection layer. Default 100."),
    switch_off_source_layer: z.boolean().default(true).describe("With insert.layer: switch that layer off so it does not show beside the replacement. Default true."),
    range: z.object({ start: z.number().min(0), end: z.number().min(0) }).optional().describe("Write only the track frames in this time range (seconds). More than 3000 frames must be written in ranges. Every call builds a NEW insert comp and layer (existing ones are not extended): with a range, the new insert layer's in and out points are cut to its keys, so ranges written one after another sit side by side (the old screen shows in any gap, and between ranges the shot is not one continuous layer). Do not give one range twice."),
    max_samples: z.number().int().min(1).max(24).default(8).describe("How many frames to measure the plate on. Default 8."),
    max_renders: z.number().int().min(1).max(60).default(20).describe("Most renders before the write (measurement and the sheet's before frames). Default 20."),
    max_seconds: z.number().min(5).max(300).default(90).describe("Most seconds spent rendering before the write. Default 90."),
    contact_sheet: z.boolean().default(true).describe("After the write, render the first, reference, last and fastest frame again and write a before / after PNG. Default true."),
    max_size: z.number().int().min(160).max(1200).default(480).describe("Long edge of one contact-sheet tile in pixels. Default 480."),
    expect: ExpectSchema,
  })
  .refine((v) => !v.reflections || v.plate !== undefined, { message: "reflections need `plate`, the layer to duplicate." })
  .refine((v) => v.range === undefined || v.range.end >= v.range.start, { message: "range.end is before range.start." });

export type AeScreenReplaceArgs = z.infer<typeof AeScreenReplaceSchema>;

// ---------- ae_screen_corners ----------

const COLOUR_NOTE = "Measured on 8-bit sRGB snapshots rendered at the comp's own resolution factor; sub-pixel positions come from line fits, not from the render's sharpness.";

async function screenCorners(ctx: ToolContext, args: AeScreenCornersArgs): Promise<Record<string, unknown>> {
  const toolName = "ae_screen_corners";
  const opId = ctx.bridge.newOpId();
  const framesDir = defaultFramesDir();
  fs.mkdirSync(framesDir, { recursive: true });
  const label = `ae_screen_corners(${args.comp_id})`;
  const isolate = args.isolate_layers;
  const expect: ExpectGuard | null = args.expect ? { project_path: args.expect.project_path, comp_id: args.expect.comp_id ?? args.comp_id } : null;
  if (isolate && !expect) throw new PlanarError("bad_args", "isolate_layers writes to the project (a temporary comp), so `expect` is required.");
  // isolate_layers writes a temporary comp, so it obeys the quarantine like every guarded write.
  if (isolate && expect) ctx.quarantine.assertClear();

  const ran = await queued(ctx, label, opId, async () => {
    const comp = await readComp(ctx, opId, args.comp_id, isolate, toolName);
    const fps = comp.fps > 0 ? comp.fps : 25;
    const guessTime = args.ref_time ?? (comp.time >= 0 && comp.time <= comp.duration ? comp.time : comp.work_area_start + comp.work_area_duration / 2);
    const refTime = clamp(snapFrame(guessTime, fps), 0, Math.max(0, comp.duration - 1 / fps));
    const guesses = args.corners as Vec2[];
    const quadBefore = quadCheck(guesses);
    if (!quadBefore.ok) throw new PlanarError("bad_args", `The corner guesses do not make a quad: ${quadBefore.reason}. Give them in the order UL, UR, LR, LL.`);

    // The track is read and checked before anything is written, so a wrong or missing track fails clean.
    let trackData: Awaited<ReturnType<typeof resolveTrackSource>> | null = null;
    if (args.track) {
      trackData = await resolveTrackSource(ctx, opId, args.comp_id, args.track);
      if (trackData.comp_size[0] !== comp.width || trackData.comp_size[1] !== comp.height) {
        throw new PlanarError("refused", `The track was made in a ${trackData.comp_size[0]}x${trackData.comp_size[1]} comp and comp ${args.comp_id} is ${comp.width}x${comp.height}: the points are in comp pixels, so the sizes must match.`);
      }
    }

    // The guard, checkpoint and session record come before the temporary comp exists.
    let note: WriteInfo | undefined;
    let checkpoint: Awaited<ReturnType<typeof autoCheckpoint>> | null = null;
    let sessionFields: { user_changed?: string } = {};
    let showLayers: Array<{ index: number; id: number }> | null = null;
    if (isolate && expect) {
      showLayers = comp.layers.map((l) => ({ index: l.index, id: l.id }));
      if (showLayers.length === 0) throw new PlanarError("not_found", "isolate_layers matched no layer.");
      ctx.quarantine.assertClear();
      const guard = await verifyTargetGuard(ctx, expect, opId);
      checkpoint = await autoCheckpoint(ctx, guard, toolName);
      note = { opId, toolName, label, expect, checkpoint: checkpoint?.path ?? null };
      sessionFields = await noteBeforeWrite(ctx, note);
    }

    const grab = async (renderCompId: number) => renderFrame(ctx, opId, renderCompId, refTime, 0, framesDir, toolName);
    let frame: { image: PNG; time: number };
    let temp: { copy_id: number; removed: boolean; error?: string } | null = null;
    if (showLayers && expect) {
      try {
        const wrapped = await withIsolatedPlate(ctx, opId, { compId: args.comp_id, showLayers, expect, toolName, note }, grab);
        frame = wrapped.value;
        temp = wrapped.temp;
      } catch (err) {
        const made = (err as { plateTemp?: { copy_id: number; removed: boolean; error?: string } } | null)?.plateTemp;
        // No copy was made: nothing was written, so the error goes up as it is.
        if (!made) throw err;
        try {
          await noteAfterWrite(ctx, note!, { addStep: true });
        } catch {
          // reporting only
        }
        return { failure: { error: err instanceof PlanarError ? err.code : "failed", message: errMessage(err), temp: made, checkpoint, sessionFields } };
      }
      await noteAfterWrite(ctx, note!, { addStep: true });
    } else {
      frame = await grab(args.comp_id);
    }

    // The analysis is pure. If it fails after the temporary comp was made, the failure carries the write's facts.
    const analyse = async () => {
      const scale = frame.image.width / comp.width;
      const toImg = (p: Vec2): Vec2 => [p[0] * scale - 0.5, p[1] * scale - 0.5];
      const toComp = (p: Vec2): Vec2 => [(p[0] + 0.5) / scale, (p[1] + 0.5) / scale];
      const gray = toGray(frame.image);
      await yieldLoop();
      const patchImg = Math.max(9, Math.round(args.pattern_size * scale) | 1);
      const snap = snapQuad(gray, guesses.map(toImg), { searchPx: args.search_px * scale, prefer: args.edge, patchSize: patchImg });
      await yieldLoop();
      const snapped = snap.corners.map((c) => toComp(c.snapped));
      const points = quadCheck(snapped).ok ? suggestPoints(gray, snapped, { scale, count: args.point_count, patchSize: args.pattern_size }) : [];
      let excursions: Excursions | null = null;
      let trackNote: string | null = null;
      if (trackData) {
        const based = relativeTo(trackData, refTime);
        const refFrame = frameAt(based, refTime);
        if (!refFrame || !refFrame.ok || !refFrame.H) {
          trackNote = `The track has no solved motion at ${r2(refTime)} s, so the corners could not be followed; pass a ref_time inside the track.`;
        } else {
          excursions = cornerExcursions(based, quadCheck(snapped).ok ? snapped : guesses, [comp.width, comp.height]);
        }
      }
      return { scale, snap, snapped, points, excursions, trackNote };
    };
    let analysed: Awaited<ReturnType<typeof analyse>>;
    try {
      analysed = await analyse();
    } catch (err) {
      if (!temp) throw err;
      return { failure: { error: err instanceof PlanarError ? err.code : "failed", message: errMessage(err), temp, checkpoint, sessionFields } };
    }
    const { scale, snap, snapped, points, excursions, trackNote } = analysed;
    return { comp, refTime: frame.time, scale, frame: frame.image, snap, snapped, points, excursions, trackNote, temp, checkpoint, sessionFields };
  });

  if ("failure" in ran && ran.failure) {
    const f = ran.failure;
    const mism: ReceiptMismatch[] = [];
    if (!f.temp.removed) {
      mism.push({
        path: "temp_comp",
        expected: "the temporary comp removed",
        actual: f.temp.error ?? "not removed",
        message: `The temporary comp (id ${f.temp.copy_id}) was not removed${f.temp.error ? `: ${f.temp.error}` : ""}. Delete it in the Project panel; its name starts with "_chroma_plate_".`,
      });
    }
    return {
      ok: false,
      error: f.error,
      message: `${f.message} (isolate_layers had already made a temporary copy of the comp${f.temp.removed ? " and removed it again: two undo entries" : ""}.)`,
      temp_comp: { copy_removed: f.temp.removed, ...(f.temp.error ? { error: f.temp.error } : {}) },
      checkpoint: f.checkpoint,
      receipt: buildReceipt({ before: null, after: { temp_comp: f.temp }, customMismatches: mism }),
      ...f.sessionFields,
    };
  }

  const { comp, scale, snap, snapped, points, excursions } = ran;
  const quad = quadMetrics(snapped);
  const principal: Vec2 = [comp.width / 2, comp.height / 2];
  const est = quad.ok ? estimateAspect(snapped, principal) : null;
  const sidesToDraw: Array<[Vec2, Vec2] | null> = snap.sides.map((s, i) => {
    if (!s.line) return null;
    const proj = (p: Vec2): Vec2 => {
      const t = (p[0] - s.line!.c[0]) * s.line!.dir[0] + (p[1] - s.line!.c[1]) * s.line!.dir[1];
      return [(s.line!.c[0] + s.line!.dir[0] * t + 0.5) / scale, (s.line!.c[1] + s.line!.dir[1] * t + 0.5) / scale];
    };
    return [proj(snap.corners[i].snapped), proj(snap.corners[(i + 1) % 4].snapped)];
  });
  let previewPath: string | undefined;
  let previewError: string | undefined;
  if (args.preview) {
    try {
      previewPath = writePng(framesDir, `screencorners_${opId}`, drawCornersPreview(ran.frame, [comp.width, comp.height], { guesses: args.corners as Vec2[], snapped, edges: sidesToDraw, points, maxSize: args.max_size }));
    } catch (err) {
      previewError = errMessage(err);
    }
  }

  const cornerRows = snap.corners.map((c, i) => {
    const notes: string[] = [];
    if (c.method === "corner_response") notes.push("Only a corner response was found here (the side's edge was too weak or too short to fit), so the position is less exact.");
    if (c.method === "unchanged") notes.push("Neither an edge nor a corner was found within the search radius: the guess is unchanged.");
    if (c.competing_share > 0.3) notes.push(`Two strong parallel edges compete on this corner's sides (${Math.round(c.competing_share * 100)}% of the scan lines); "${args.edge}" picked one. Check the preview.`);
    if (!c.trackable) notes.push(c.template_std === null ? "Too close to the frame's border to hold a tracking pattern." : `Template contrast ${r2(c.template_std)} gray levels is under 3: this corner will not track well; use the suggested points.`);
    if (c.shift_px / scale > args.search_px) notes.push("The snapped corner is further than search_px from the guess.");
    return {
      index: i + 1,
      name: CORNER_NAMES[i],
      guess: [r2((args.corners as Vec2[])[i][0]), r2((args.corners as Vec2[])[i][1])],
      snapped: [r2(snapped[i][0]), r2(snapped[i][1])],
      shift_px: r2(c.shift_px / scale),
      method: c.method,
      edge_strength: c.edge_strength === null ? null : r2(c.edge_strength),
      competing_edges: c.competing_share > 0.3,
      trackable: c.trackable,
      template_contrast: c.template_std === null ? null : r2(c.template_std),
      corner_agrees: c.corner_agrees,
      confidence: c.confidence,
      ...(notes.length ? { notes } : {}),
    };
  });
  const lowest = Math.min(...snap.corners.map((c) => c.confidence));
  const notes: string[] = [COLOUR_NOTE];
  if (lowest < 0.5) notes.push(`The least certain corner has confidence ${lowest}: look at preview_path before using these corners, or give better guesses.`);
  if (est && est.method === "perspective") {
    notes.push(
      `The aspect ratio is an estimate from one perspective view with the picture centre as the principal point; it is exact only for a known focal length (range ${r3(est.range[0])}-${r3(est.range[1])} for focal lengths 0.7x-1.43x). ` +
        (est.common_ratio ? `It is close to ${est.common_ratio.name}: give insert_aspect if you know it.` : "Give insert_aspect if you know the panel's ratio.")
    );
  } else if (est && est.method === "assumed_focal") {
    notes.push(
      `The focal length could not be recovered from this quad (one vanishing point is at or near infinity, as for a screen turned about the vertical axis with a level camera), so the aspect assumes a focal length equal to the comp width; the range ${r3(est.range[0])}-${r3(est.range[1])} covers 0.5x-3x of it. Give insert_aspect if you know the panel's ratio.`
    );
  } else if (est) {
    notes.push("The quad is a parallelogram (no perspective), so the focal length cannot be recovered and the aspect is the plain ratio of its edge lengths.");
  }
  if (args.insert_aspect !== undefined && est) {
    const off = Math.abs(est.aspect - args.insert_aspect) / args.insert_aspect;
    if (off > 0.08) notes.push(`The estimate (${r3(est.aspect)}) is ${Math.round(off * 100)}% away from the given insert_aspect (${r3(args.insert_aspect)}); the given one wins in ae_screen_replace, but check the corners.`);
  }
  if (points.length < 4) notes.push(`Only ${points.length} trackable point${points.length === 1 ? "" : "s"} found on the plane: the surface is flat or low in contrast. Track the corners, or add marks.`);
  if (ran.trackNote) notes.push(ran.trackNote);
  if (excursions && excursions.frames_outside > 0) notes.push(`A corner leaves the frame on ${excursions.frames_outside} of ${excursions.frames_checked} frames (first at ${r2(excursions.first_outside_time ?? 0)} s): the track must extrapolate there; ae_track_multi keeps following the points that stay in.`);
  if (excursions && excursions.frames_folded > 0) notes.push(`The quad folds or goes non-convex on ${excursions.frames_folded} frames: the track is unreliable there.`);
  if (ran.temp) notes.push("isolate_layers made a temporary copy of the comp and removed it again: two undo entries, one for each.");
  if (previewError) notes.push(`The preview could not be written: ${previewError}`);
  const baseMismatches: ReceiptMismatch[] = [];
  if (ran.temp && !ran.temp.removed) {
    baseMismatches.push({
      path: "temp_comp",
      expected: "the temporary comp removed",
      actual: ran.temp.error ?? "not removed",
      message: `The temporary comp (id ${ran.temp.copy_id}) was not removed${ran.temp.error ? `: ${ran.temp.error}` : ""}. Delete it in the Project panel; its name starts with "_chroma_plate_".`,
    });
  }
  return {
    ok: true,
    ...(ran.temp ? {} : { read_only: true }),
    comp: { id: comp.id, name: comp.name, width: comp.width, height: comp.height },
    ref_time: r4(ran.refTime),
    image_scale: r3(scale),
    corners: cornerRows,
    corners_snapped: snapped.map((p) => [r2(p[0]), r2(p[1])]),
    quad: { ...quad, convex: quad.ok },
    aspect: est
      ? {
          estimate: r3(est.aspect),
          range: [r3(est.range[0]), r3(est.range[1])],
          method: est.method,
          focal_px: est.focal_px === null ? null : Math.round(est.focal_px),
          edge_length_ratio: r3(est.edge_ratio),
          ...(est.common_ratio ? { nearest_common_ratio: est.common_ratio.name } : {}),
          ...(args.insert_aspect !== undefined ? { given: args.insert_aspect, use: args.insert_aspect } : { use: r3(est.aspect) }),
        }
      : { error: "The snapped corners do not make a quad, so no aspect was estimated." },
    ...(excursions ? { track: excursions } : {}),
    suggested_points: points,
    suggested_points_for_track_multi: points.map((p) => [p.x, p.y]),
    ...(previewPath ? { preview_path: previewPath } : {}),
    ...(ran.temp ? { temp_comp: { copy_removed: ran.temp.removed, ...(ran.temp.error ? { error: ran.temp.error } : {}) }, checkpoint: ran.checkpoint, receipt: buildReceipt({ before: null, after: { temp_comp: ran.temp }, customMismatches: baseMismatches }), ...ran.sessionFields } : {}),
    notes,
  };
}

// ---------- ae_screen_replace ----------

interface LayerBrief {
  index: number;
  id: number;
  name: string;
  locked: boolean;
  enabled: boolean;
  three_d: boolean;
}

interface ItemInfo {
  kind: "comp" | "footage" | "other";
  item_id: number;
  name: string;
  width: number;
  height: number;
  duration: number;
  has_video: boolean;
  missing: boolean;
  pixel_aspect: number;
  from_layer?: LayerBrief;
}

interface ReplaceInfo {
  comp: { id: number; name: string; width: number; height: number; pixel_aspect: number; fps: number; duration: number; time: number; work_area_start: number; work_area_duration: number; num_layers: number; motion_blur: boolean };
  ae_version: string;
  linear_blending: boolean;
  /** app.project.linearizeWorkingSpace: effects such as Levels only see linear values when this is on. */
  linearize_working_space?: boolean;
  can_set_track_matte: boolean;
  plate: LayerBrief | null;
  insert: ItemInfo | null;
}

interface PlateMeasure {
  frames_measured: number;
  frames_planned: number;
  black: number | null;
  white: number | null;
  p95: number | null;
  edge: EdgeSigma | null;
  insert: { black: number | null; white: number | null; frames: number; source: "measured" | "given" | "assumed" };
  per_frame: Array<{ time: number; p02: number; p50: number; p98: number; visible_share: number }>;
  skipped: string[];
  budget: { renders: number; seconds: number; max_renders: number; max_seconds: number };
  blocked: boolean;
  trimmed: boolean;
}

/** What the guarded write sends and what the check expects, built before the write. */
export interface ReplacePlan {
  name: string;
  pin: "power_pin" | "corner_pin";
  insertSize: [number, number];
  times: number[];
  keys: InsertKeys;
  expansionPct: number;
  motionBlur: "none" | "transform_pin" | "force";
  levels: LevelsPlan | null;
  blurriness: number | null;
  reflections: { threshold: number; opacity: number } | null;
  insertStart: number;
  plateId: number | null;
  sourceLayerId: number | null;
  switchOffSource: boolean;
  fps: number;
}

const ROLES = ["ul", "ur", "ll", "lr"] as const;

const sampleIdx = (n: number): number[] => Array.from(new Set([0, Math.floor((n - 1) / 2), n - 1])).filter((i) => i >= 0 && i < n);

interface KeysRead {
  items: Array<{ layer_id: number; found: boolean; effect_found?: boolean; props: Array<{ role: string; numKeys: number; samples: Array<{ time: number; value: unknown }> }> }>;
}

interface EffectRead {
  index: number;
  name: string;
  matchName: string;
  params: Array<{ index: number; name: string; matchName: string; type: string; value: number | number[] | null }>;
}

interface LayerDetail {
  index: number;
  id: number;
  name: string;
  enabled: boolean;
  start_time: number;
  motion_blur: boolean | null;
  blending_mode: number | null;
  track_matte_type: number | null;
  matte_layer_id: number | null;
  opacity?: number | null;
  effects: EffectRead[];
}

interface ReplaceRead {
  comp_id: number;
  num_layers: number;
  comp_motion_blur: boolean | null;
  layers: Array<{ index: number; id: number; name: string; enabled: boolean }>;
  truncated?: boolean;
  details: LayerDetail[];
  insert_comp: { id: number; width: number; height: number; num_layers: number } | null;
  keys: KeysRead | null;
}

interface LookWrote {
  role: string;
  name: string;
  value: number;
}

interface HostWritten extends Record<string, unknown> {
  insert_comp?: { id: number; name: string; width: number; height: number };
  insert_layer?: { index: number; id: number; name: string };
  pin?: { kind: "power_pin" | "corner_pin"; effect_index: number; values_used: "exact" | "expanded"; expansion: Record<string, unknown> };
  pin_fallback?: string | null;
  written?: Array<{ target: string; props: Array<{ role: string; numKeys: number }> }>;
  look?: {
    levels?: { effect_index: number; unit: number; wrote: LookWrote[] };
    blur?: { effect_index: number; wrote: LookWrote[] };
    reflections?: { layer_id: number; blending_mode: number; track_matte_type: number; matte_layer_id: number; opacity?: number; levels: { effect_index: number; unit: number; wrote: LookWrote[] } };
  };
  look_skipped?: Array<{ step: string; reason: string }>;
  source_layer?: { id: number; was_enabled: boolean } | null;
}

const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol;

/** Compares the read-back with what the plan said the write would leave. Never throws on a missing piece: it reports it. */
export function replaceMismatches(plan: ReplacePlan, beforeRaw: unknown, afterRaw: unknown, written: HostWritten): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const before = beforeRaw && typeof beforeRaw === "object" ? (beforeRaw as ReplaceRead) : null;
  const after = afterRaw && typeof afterRaw === "object" ? (afterRaw as ReplaceRead) : null;
  if (!after) return m;
  const insertId = written.insert_layer?.id;
  const reflection = written.look?.reflections;
  if (before) {
    const want = before.num_layers + 1 + (reflection ? 1 : 0);
    expectThat(m, after.num_layers === want, "num_layers", want, after.num_layers, "The layer count is not what the write should leave (the insert layer, and the reflection layer when it was made)");
  }
  const insert = after.details.find((d) => d.id === insertId);
  if (!insert) {
    m.push({ path: "insert_layer", expected: insertId, actual: undefined, message: "The insert layer is not in the read-back" });
    return m;
  }
  expectThat(m, insert.name === written.insert_layer?.name, "insert_layer.name", written.insert_layer?.name, insert.name, "The insert layer's name differs");
  expectThat(m, insert.enabled, "insert_layer.enabled", true, insert.enabled, "The insert layer is switched off");
  expectThat(m, near(insert.start_time, plan.insertStart, 1 / plan.fps + 1e-6), "insert_layer.start_time", plan.insertStart, insert.start_time, "The insert starts at another time");
  const listCapped = after.truncated === true || after.num_layers > after.layers.length;
  if (plan.plateId !== null && !listCapped) {
    const plateNow = after.layers.find((l) => l.id === plan.plateId);
    if (plateNow) expectThat(m, insert.index === plateNow.index - 1, "insert_layer.index", plateNow.index - 1, insert.index, "The insert layer is not directly above the plate");
    else m.push({ path: "plate", expected: plan.plateId, actual: undefined, message: "The plate layer is no longer in the comp" });
  }
  const ic = after.insert_comp;
  if (!ic) m.push({ path: "insert_comp", expected: written.insert_comp?.id, actual: undefined, message: "The insert comp could not be read back" });
  else {
    expectThat(m, ic.width === plan.insertSize[0] && ic.height === plan.insertSize[1], "insert_comp.size", plan.insertSize, [ic.width, ic.height], "The insert comp has another size than planned");
    expectThat(m, ic.num_layers === 1, "insert_comp.num_layers", 1, ic.num_layers, "The insert comp should hold exactly the source layer");
  }

  // Keys: counts and a few values.
  // The pin and the transform are separate items of the same layer.
  const keyItems = (after.keys?.items ?? []).filter((it) => it.layer_id === insertId);
  const keyItem = keyItems.length ? { effect_found: keyItems.every((it) => it.effect_found !== false), props: keyItems.flatMap((it) => it.props) } : null;
  if (!keyItem) m.push({ path: "keys", expected: "the insert layer's keys", actual: undefined, message: "The keys could not be read back" });
  else {
    const set = plan.keys;
    const used = written.pin?.values_used === "exact" ? set.exact : set.expanded;
    const n = plan.times.length;
    const idx = sampleIdx(n);
    const roleProp = (role: string) => keyItem.props.find((p) => p.role === role);
    const compareVec = (role: string, values: Vec2[], tol: number) => {
      const p = roleProp(role);
      if (!p) {
        m.push({ path: `keys.${role}`, expected: "read back", actual: undefined, message: `The ${role} property was not found in the read-back` });
        return;
      }
      expectThat(m, p.numKeys === n, `keys.${role}.numKeys`, n, p.numKeys, "Key count in the read-back differs from the frames written");
      for (const i of idx) {
        const got = p.samples.find((s) => near(s.time, plan.times[i], 1e-6))?.value;
        const same = Array.isArray(got) && values[i].every((v, k) => typeof got[k] === "number" && near(got[k] as number, v, tol));
        expectThat(m, same, `keys.${role}@${plan.times[i]}`, values[i], got, "A key's value differs from what was written");
      }
    };
    if (keyItem.effect_found === false) m.push({ path: "pin", expected: plan.pin, actual: undefined, message: "The pin effect was not found in the read-back" });
    for (const role of ROLES) compareVec(role, used[role], 0.05);
    if (plan.keys.transform) {
      compareVec("position", plan.keys.transform.position, 0.05);
      compareVec("scale", plan.keys.transform.scale, 0.05);
      const rot = roleProp("rotation");
      if (!rot) m.push({ path: "keys.rotation", expected: "read back", actual: undefined, message: "The rotation property was not found in the read-back" });
      else {
        expectThat(m, rot.numKeys === n, "keys.rotation.numKeys", n, rot.numKeys, "Key count in the read-back differs from the frames written");
        for (const i of idx) {
          const got = rot.samples.find((s) => near(s.time, plan.times[i], 1e-6))?.value;
          expectThat(m, typeof got === "number" && near(got, plan.keys.transform.rotation[i], 0.02), `keys.rotation@${plan.times[i]}`, plan.keys.transform.rotation[i], got, "A rotation key differs from what was written");
        }
      }
    }
  }

  // The look: each parameter the host wrote is found again by name and holds its value.
  const wantedByRole = (wrote: LookWrote[]): Record<string, { names: string[] }> => Object.fromEntries(wrote.map((w) => [w.role, { names: [w.name] }]));
  const checkEffect = (layer: LayerDetail | undefined, tag: string, effectIndex: number, unit: number, wrote: LookWrote[]) => {
    const fx = layer?.effects.find((e) => e.index === effectIndex);
    if (!fx) {
      m.push({ path: tag, expected: `effect ${effectIndex}`, actual: undefined, message: "The effect was not found in the read-back" });
      return;
    }
    const where = resolveEffectParams(fx.params, wantedByRole(wrote));
    for (const w of wrote) {
      const pi = where[w.role];
      const p = pi === null || pi === undefined ? undefined : fx.params.find((x) => x.index === pi);
      const got = typeof p?.value === "number" ? p.value : undefined;
      expectThat(m, got !== undefined && near(got, w.value, Math.max(1e-6, Math.abs(unit) * 1e-3)), `${tag}.${w.role}`, w.value, got, "A parameter's value in the read-back differs from what was written");
    }
  };
  const lv = written.look?.levels;
  if (lv) checkEffect(insert, "levels", lv.effect_index, lv.unit, lv.wrote);
  const bl = written.look?.blur;
  if (bl) checkEffect(insert, "blur", bl.effect_index, 1, bl.wrote);
  // CC Power Pin's Expansion, when it was set as a parameter.
  const exp = written.pin?.expansion as { mode?: string; matchName?: string; name?: string; value?: number } | undefined;
  if (exp && exp.mode === "param" && typeof exp.value === "number") {
    const pinFx = insert.effects.find((e) => e.index === written.pin?.effect_index);
    const ep = pinFx?.params.find((x) => (exp.matchName ? x.matchName === exp.matchName : x.name === exp.name));
    expectThat(m, typeof ep?.value === "number" && near(ep.value as number, exp.value, 1e-3 + Math.abs(exp.value) * 1e-3), "pin.expansion", exp.value, ep?.value, "CC Power Pin's Expansion in the read-back differs from what was written");
  }
  const forceIdx = (written.motion_blur as { force_effect_index?: number } | undefined)?.force_effect_index;
  if (plan.motionBlur === "force" && typeof forceIdx === "number") {
    const fb = insert.effects.find((e) => e.index === forceIdx);
    expectThat(m, fb !== undefined && /Force Motion Blur/i.test(fb.matchName + " " + fb.name), "motion_blur.force_effect", "CC Force Motion Blur", fb?.matchName, "CC Force Motion Blur is not on the insert layer in the read-back");
  }
  if (plan.motionBlur === "transform_pin") {
    expectThat(m, insert.motion_blur === true, "insert_layer.motion_blur", true, insert.motion_blur, "The layer's motion blur switch is off");
    expectThat(m, after.comp_motion_blur === true, "comp.motion_blur", true, after.comp_motion_blur, "The comp's motion blur switch is off, so the layer's blur will not render");
  }
  if (reflection) {
    const rl = after.details.find((d) => d.id === reflection.layer_id);
    if (!rl) m.push({ path: "reflection_layer", expected: reflection.layer_id, actual: undefined, message: "The reflection layer is not in the read-back" });
    else {
      expectThat(m, rl.blending_mode === reflection.blending_mode, "reflection.blending_mode", reflection.blending_mode, rl.blending_mode, "The reflection layer is not in Screen mode");
      expectThat(m, rl.matte_layer_id === insertId && rl.track_matte_type === reflection.track_matte_type, "reflection.track_matte", { layer: insertId, type: reflection.track_matte_type }, { layer: rl.matte_layer_id, type: rl.track_matte_type }, "The reflection layer is not matted by the insert's alpha");
      if (!listCapped) expectThat(m, rl.index === insert.index - 1, "reflection.index", insert.index - 1, rl.index, "The reflection layer is not directly above the insert");
      if (typeof reflection.opacity === "number" && typeof rl.opacity === "number") expectThat(m, near(rl.opacity, reflection.opacity, 0.5), "reflection.opacity", reflection.opacity, rl.opacity, "The reflection layer's opacity differs from what was written");
      checkEffect(rl, "reflection.levels", reflection.levels.effect_index, reflection.levels.unit, reflection.levels.wrote);
    }
  }
  if (plan.switchOffSource && plan.sourceLayerId !== null) {
    const src = after.layers.find((l) => l.id === plan.sourceLayerId);
    if (src) expectThat(m, src.enabled === false, "source_layer.enabled", false, src.enabled, "The original layer is still switched on");
    else if (!listCapped) m.push({ path: "source_layer", expected: plan.sourceLayerId, actual: undefined, message: "The original layer is no longer in the comp" });
  }
  return m;
}

/** Measures the plate (black, white, 95th percentile inside the moved quad; the bezel's softness) and the insert, on rendered frames. */
async function measureLook(
  ctx: ToolContext,
  p: {
    opId: string;
    compId: number;
    comp: { width: number; height: number };
    based: PlanarTrack;
    corners: Vec2[];
    times: number[];
    refTime: number;
    keep: Map<number, RgbaImage | null>;
    insertItem: ItemInfo | null;
    insertGiven: { black?: number; white?: number };
    insertStart: number;
    needMeasure: boolean;
    framesDir: string;
    toolName: string;
    maxRenders: number;
    maxSeconds: number;
    trimmed: boolean;
  }
): Promise<PlateMeasure> {
  const budget = createRenderBudget({ maxRenders: p.maxRenders, maxSeconds: p.maxSeconds });
  const out: PlateMeasure = {
    frames_measured: 0,
    frames_planned: p.times.length,
    black: null,
    white: null,
    p95: null,
    edge: null,
    insert: { black: p.insertGiven.black ?? null, white: p.insertGiven.white ?? null, frames: 0, source: p.insertGiven.black !== undefined || p.insertGiven.white !== undefined ? "given" : "assumed" },
    per_frame: [],
    skipped: [],
    budget: { renders: 0, seconds: 0, max_renders: p.maxRenders, max_seconds: p.maxSeconds },
    blocked: false,
    trimmed: p.trimmed,
  };
  const p02s: number[] = [];
  const p98s: number[] = [];
  const p95s: number[] = [];
  let edgeDone = false;
  const refNearest = p.times.reduce((b, t) => (Math.abs(t - p.refTime) < Math.abs(b - p.refTime) ? t : b), p.times[0]);
  for (let i = 0; i < p.times.length; i++) {
    const t = p.times[i];
    if (out.blocked) {
      out.skipped.push(`${r2(t)} s: not rendered, AE stopped responding`);
      continue;
    }
    if (budget.exhausted()) {
      out.skipped.push(`${r2(t)} s: render budget reached`);
      continue;
    }
    try {
      const snap = await renderFrame(ctx, p.opId, p.compId, t, i, p.framesDir, p.toolName);
      budget.spend();
      await yieldLoop();
      if (p.keep.has(t)) p.keep.set(t, snap.image);
      if (!p.needMeasure) continue;
      const fr = frameAt(p.based, t);
      if (!fr || !fr.H) {
        out.skipped.push(`${r2(t)} s: the track has no motion here`);
        continue;
      }
      const quad = p.corners.map((c) => applyH(fr.H as Mat3, c));
      if (quad.some((q) => q === null)) {
        out.skipped.push(`${r2(t)} s: a corner is behind the plane`);
        continue;
      }
      const scale = snap.image.width / p.comp.width;
      const poly = (quad as Vec2[]).map((q) => [q[0] * scale, q[1] * scale] as [number, number]);
      const mask = rasterizePolygon(snap.image.width, snap.image.height, poly, 0);
      const stats = lumaQuantiles(snap.image, mask, [0.02, 0.5, 0.95, 0.98]);
      const share = stats.pixels / Math.max(1, polygonArea(poly));
      if (share < 0.5) {
        out.skipped.push(`${r2(t)} s: under half of the screen is inside the frame`);
        continue;
      }
      p02s.push(stats.values[0]);
      p95s.push(stats.values[2]);
      p98s.push(stats.values[3]);
      out.per_frame.push({ time: r4(t), p02: r4(stats.values[0]), p50: r4(stats.values[1]), p98: r4(stats.values[3]), visible_share: r3(Math.min(1, share)) });
      if (!edgeDone && t === refNearest) {
        edgeDone = true;
        out.edge = quadEdgeSigma(toGray(snap.image), (quad as Vec2[]).map((q) => [q[0] * scale - 0.5, q[1] * scale - 0.5] as Vec2), scale);
      }
    } catch (err) {
      if (isAeBlocked(err)) out.blocked = true;
      out.skipped.push(`${r2(t)} s: ${errMessage(err)}`);
    }
  }
  out.frames_measured = p02s.length;
  if (p02s.length > 0) {
    out.black = median(p02s);
    out.white = median(p98s);
    out.p95 = median(p95s);
  }

  // The insert, when it is a comp: up to three frames of the span it plays.
  if (p.needMeasure && p.insertItem && p.insertItem.kind === "comp" && p.insertGiven.black === undefined && p.insertGiven.white === undefined && !out.blocked) {
    const dur = p.insertItem.duration;
    const first = p.times[0];
    const last = p.times[p.times.length - 1];
    const at = [first, (first + last) / 2, last].map((t) => clamp(t - p.insertStart, 0, Math.max(0, dur - 0.001)));
    const blacks: number[] = [];
    const whites: number[] = [];
    for (let i = 0; i < at.length && !budget.exhausted(); i++) {
      try {
        const snap = await renderFrame(ctx, p.opId, p.insertItem.item_id, at[i], 1000 + i, p.framesDir, p.toolName);
        budget.spend();
        const mask = new Float32Array(snap.image.width * snap.image.height).fill(1);
        const st = lumaQuantiles(snap.image, mask, [0.02, 0.98], { minAlpha: 250 });
        if (st.pixels > 0) {
          blacks.push(st.values[0]);
          whites.push(st.values[1]);
        }
      } catch (err) {
        if (isAeBlocked(err)) break;
        out.skipped.push(`insert at ${r2(at[i])} s: ${errMessage(err)}`);
      }
    }
    if (blacks.length > 0) out.insert = { black: median(blacks), white: median(whites), frames: blacks.length, source: "measured" };
  }
  out.budget = { ...budget.used, max_renders: p.maxRenders, max_seconds: p.maxSeconds };
  return out;
}

const FOLLOW_UPS = [
  "Hands, fingers or objects that cross the screen are not rotoscoped by this tool (Roto Brush and Mocha have no scripting): make a roto layer of your own and use it as a holdout (a garbage-matte tool with matte_layer, or a track matte on the insert).",
  "Match the plate's grain with ae_patch_grain, then check the result with ae_patch_check (seam, flicker, slip) before delivering.",
];

async function screenReplace(ctx: ToolContext, args: AeScreenReplaceArgs): Promise<Record<string, unknown>> {
  const toolName = "ae_screen_replace";
  const opId = ctx.bridge.newOpId();
  const framesDir = defaultFramesDir();
  const label = `ae_screen_replace(${args.comp_id})`;
  const notes: string[] = [];
  const corners = args.corners as Vec2[];

  // ----- before the write: read, validate, measure (read-only renders) -----
  const prep = await queued(ctx, label, opId, async () => {
    // Guard first: a wrong project or a quarantine must refuse before up to max_seconds of plate renders, not after.
    // runGuardedWrite checks again right before the write.
    ctx.quarantine.assertClear();
    await verifyTargetGuard(ctx, { project_path: args.expect.project_path, comp_id: args.expect.comp_id ?? args.comp_id }, `${opId}_pre`);
    const info = await readHost<ReplaceInfo>(ctx, opId, "info", "screenrepInfo", {
      comp_id: args.comp_id,
      ...(args.plate ? { plate: args.plate } : {}),
      insert: args.insert.item_id !== undefined ? { item_id: args.insert.item_id } : { layer: args.insert.layer },
    }, toolName);
    const comp = info.comp;
    if (Number(comp.pixel_aspect) > 0 && Math.abs(Number(comp.pixel_aspect) - 1) > 1e-6) {
      throw new PlanarError("refused", `The comp's pixel aspect is ${comp.pixel_aspect}, not 1. Screen replacement works on square pixels only.`);
    }
    const item = info.insert;
    if (!item) throw new PlanarError("not_found", "The insert could not be resolved.");
    if (item.kind === "comp" && item.item_id === comp.id) {
      throw new PlanarError("bad_args", "The insert is the target comp itself: a comp cannot contain itself.");
    }
    if (args.insert.layer && info.plate && item.from_layer && item.from_layer.id === info.plate.id) {
      throw new PlanarError("bad_args", "The insert layer is the plate layer: the insert has to be a different layer from the one being replaced.");
    }
    if (args.reflections) {
      if (!info.plate) throw new PlanarError("bad_args", "Reflections need the plate layer.");
      if (!info.can_set_track_matte) throw new PlanarError("refused", `Reflections need layer-based track mattes (After Effects 23 or later); this is AE ${info.ae_version}.`);
      if (info.plate.locked) throw new PlanarError("refused", `The plate "${info.plate.name}" is locked; unlock it or turn the reflections off.`);
    }
    if (args.insert.layer && args.switch_off_source_layer && item.from_layer?.locked) {
      throw new PlanarError("refused", `The insert layer "${item.from_layer.name}" is locked, so it cannot be switched off; unlock it or pass switch_off_source_layer false.`);
    }

    const track = await resolveTrackSource(ctx, opId, args.comp_id, args.track);
    if (track.comp_size[0] !== comp.width || track.comp_size[1] !== comp.height) {
      throw new PlanarError("refused", `The track was made in a ${track.comp_size[0]}x${track.comp_size[1]} comp and comp ${args.comp_id} is ${comp.width}x${comp.height}: the points are in comp pixels, so the sizes must match.`);
    }
    if (track.model === "perspective" && track.ref_points.length < 4) {
      throw new PlanarError("refused", `The track is a perspective track with ${track.ref_points.length} points; a perspective needs 4 or more. Track more points (ae_screen_corners suggests them) or use a similarity track.`);
    }
    const refTime = args.ref_time ?? track.ref_time;
    const based = relativeTo(track, refTime);
    const refFrame = frameAt(based, refTime);
    if (!refFrame || !refFrame.ok || !refFrame.H) {
      throw new PlanarError("bad_args", `The track has no solved motion at ${r2(refTime)} s, so that cannot be the frame the corners were taken on. Pass a ref_time where the track is ok.`);
    }
    const qc = quadCheck(corners);
    if (!qc.ok) throw new PlanarError("bad_args", `The corners do not make a quad at ${r2(refTime)} s: ${qc.reason}. Give them in the order UL, UR, LR, LL (ae_screen_corners returns them so).`);
    const half = 0.5 / (based.fps || 25);
    const inRange = based.frames.filter((f) => !args.range || (f.time >= args.range.start - half && f.time <= args.range.end + half));
    const okFrames = inRange.filter((f) => f.ok && f.H !== null);
    if (okFrames.length === 0) throw new PlanarError("bad_args", "No frame of the track is ok inside that range, so there is nothing to write.");
    if (okFrames.length > MAX_KEYS) {
      throw new PlanarError("bad_args", `The track has ${okFrames.length} frames to write, over the ${MAX_KEYS} keys per property one call writes. Write it in ranges (range: {start, end}).`);
    }
    if (track.model !== "perspective" && track.model !== "affine") {
      notes.push(`The track is a ${track.model} track: the screen moves without changing its shape. If the camera or the screen turns, track four points with the perspective model.`);
    }

    // The aspect and the insert comp.
    const est = estimateAspect(corners, [comp.width / 2, comp.height / 2]);
    const aspect = args.insert_aspect ?? est.aspect;
    if (!(aspect >= 0.1 && aspect <= 10)) throw new PlanarError("bad_args", `The screen's aspect came out at ${r3(aspect)}; give insert_aspect.`);
    if (args.insert_aspect === undefined) {
      const about = est.common_ratio ? `, about ${est.common_ratio.name}` : "";
      if (est.method === "assumed_focal") {
        notes.push(
          `The screen's aspect (${r3(aspect)}${about}) is a guess: the corners do not fix the focal length, so it was assumed to be the comp width; range ${r3(est.range[0])}-${r3(est.range[1])}. Pass insert_aspect if you know the panel's ratio.`
        );
      } else if (est.method === "edge_lengths") {
        notes.push(`The screen's aspect (${r3(aspect)}${about}) is the ratio of the mean edge lengths (no perspective in the corners); pass insert_aspect if you know the panel's ratio.`);
      } else {
        notes.push(
          `The screen's aspect (${r3(aspect)}${about}) was estimated from the corners in perspective, range ${r3(est.range[0])}-${r3(est.range[1])}; pass insert_aspect if you know the panel's ratio.`
        );
      }
    }
    const srcW = item.width * (item.pixel_aspect > 0 ? item.pixel_aspect : 1);
    if (Math.abs(item.pixel_aspect - 1) > 1e-6) notes.push(`"${item.name}" has non-square pixels (${r3(item.pixel_aspect)}); its width was scaled by that for the fit.`);
    const insertSize = insertCompSize({ width: srcW, height: item.height }, aspect, args.fit);

    // Measuring: renders of the plate before the write.
    const sheet = args.contact_sheet ? pickSheetFrames({ ...based, frames: okFrames }, corners, refTime) : [];
    const needMeasure = args.match_look || args.reflections;
    const planned = needMeasure
      ? planSampleTimes({ times: okFrames.map((f) => f.time), refTime, sheet: sheet.map((s) => s.time), maxSamples: args.max_samples, maxRenders: args.max_renders })
      : { times: sheet.map((s) => s.time).slice(0, args.max_renders), trimmed: sheet.length > args.max_renders };
    const keep = new Map<number, RgbaImage | null>();
    for (const s of sheet) keep.set(s.time, null);
    fs.mkdirSync(framesDir, { recursive: true });
    let measure: PlateMeasure | null = null;
    if (planned.times.length > 0) {
      measure = await measureLook(ctx, {
        opId,
        compId: args.comp_id,
        comp,
        based,
        corners,
        times: planned.times,
        refTime,
        keep,
        insertItem: item,
        insertGiven: { black: args.insert_black, white: args.insert_white },
        insertStart: args.insert_start ?? 0,
        needMeasure,
        framesDir,
        toolName,
        maxRenders: args.max_renders,
        maxSeconds: args.max_seconds,
        trimmed: planned.trimmed,
      });
    }
    return { info, item, track: based, refTime, okFrames, aspect, est, insertSize, measure, sheet, keep };
  });

  const { info, item, track: based, refTime, okFrames, insertSize, measure, sheet } = prep;
  const comp = info.comp;
  const name = args.name ?? item.name;
  // Blend Colors Using 1.0 Gamma only makes the blending linear; Levels sees linear values only when the working space is linearized.
  const linear = info.linear_blending === true && info.linearize_working_space === true;
  if (info.linear_blending === true && info.linearize_working_space !== true) {
    notes.push("Blend Colors Using 1.0 Gamma is on but the working space is not linearized: Levels sees gamma-encoded values, so the measurements were not converted to linear light.");
  }
  if (linear) notes.push("The working space is linearized: how saveFrameToPng encodes its frames then is unmeasured, so the measured black and white may be off by the transfer curve; check the look.");

  // ----- the look, from what was measured -----
  let levels: LevelsPlan | null = null;
  let blurriness: number | null = null;
  let blurSigma: number | null = null;
  let blurSigmaLayer: number | null = null;
  let reflections: { threshold: number; opacity: number } | null = null;
  if (args.match_look) {
    if (measure && measure.black !== null && measure.white !== null) {
      levels = planLevels({
        plateBlack: measure.black,
        plateWhite: measure.white,
        insertBlack: measure.insert.black ?? 0,
        insertWhite: measure.insert.white ?? 1,
        whiteMode: args.white_mode,
        linear,
      });
      if (levels.skip) {
        notes.push(`Levels not added: ${levels.reason}.`);
        levels = null;
      } else {
        notes.push(...levels.notes);
      }
      if (measure.insert.source === "assumed") notes.push("The insert's own black and white were taken as 0 and 1 (it is footage, which cannot be rendered without a comp); pass insert_black / insert_white if it is not full range.");
    } else {
      notes.push("Levels not added: the plate's screen could not be measured on any frame (see measured.skipped).");
    }
    if (args.blur_px !== undefined) {
      blurSigma = args.blur_px;
    } else if (measure?.edge?.sigma_px !== null && measure?.edge?.sigma_px !== undefined) {
      blurSigma = Math.min(2, measure.edge.sigma_px);
      if (measure.edge.sigma_px > 2) notes.push(`The bezel's edge is softer than 2 px (sigma ${measure.edge.sigma_px}): the blur was capped at 2. Pass blur_px for more.`);
    } else if (measure?.edge?.reason) {
      notes.push(`Blur not added: ${measure.edge.reason}.`);
    }
    if (blurSigma !== null && blurSigma >= 0.4) {
      // The Gaussian Blur runs BEFORE the pin, in the insert layer's own pixels, and the pin then rescales it onto the
      // screen: the comp-space sigma is converted by the insert-to-screen linear scale.
      const quadArea = polygonArea(corners);
      const pinScale = quadArea > 0 ? Math.sqrt((insertSize[0] * insertSize[1]) / quadArea) : 1;
      blurSigmaLayer = blurSigma * pinScale;
      blurriness = r3(blurrinessFromSigma(blurSigmaLayer));
      if (Math.abs(pinScale - 1) > 0.05) notes.push(`The blur sigma of ${r3(blurSigma)} px on screen is ${r3(blurSigmaLayer)} px in the insert's own pixels (the insert is pinned onto the screen at about 1/${r3(pinScale)} scale), because the blur runs before the pin.`);
    } else if (blurSigma !== null) notes.push(`The edge is sharp (sigma ${r3(blurSigma)} px under 0.4): no blur was added.`);
  }
  if (args.reflections) {
    let threshold = args.reflection_threshold;
    if (threshold === undefined) {
      if (measure?.p95 !== null && measure?.p95 !== undefined) threshold = clamp(measure.p95 + 0.03, 0, 0.98);
      else {
        threshold = 0.85;
        notes.push("The old screen could not be measured, so the reflection threshold is a default 0.85; set reflection_threshold.");
      }
    }
    // Levels works in the project's space: with a linearized working space the encoded threshold is converted.
    reflections = { threshold: linear ? srgbToLinear(threshold) : threshold, opacity: args.reflection_opacity };
    if (linear) notes.push("The working space is linearized: the reflection threshold was converted to linear light.");
    notes.push("The reflection layer is a duplicate of the plate: it also holds the old screen's own brightest content, which the Levels threshold only mostly removes. Look at it and lower reflection_opacity or raise reflection_threshold if the old picture ghosts through.");
  }

  const keys = buildInsertKeys({
    frames: okFrames,
    refCorners: corners,
    compSize: [comp.width, comp.height],
    insertSize,
    expansionPct: args.expansion_pct,
    transform: args.motion_blur === "transform_pin",
  });
  if (keys.times.length === 0) throw new PlanarError("bad_args", "No frame of the track could be turned into keys (every frame was degenerate).");
  if (keys.skipped.length > 0) notes.push(`${keys.skipped.length} frame(s) were not written (degenerate for this screen); the keys interpolate across them.`);
  const notOk = based.frames.filter((f) => !f.ok || !f.H).length;
  if (notOk > 0) notes.push(`${notOk} frame(s) of the track are not solved and were skipped; the keys interpolate across them.`);
  if (args.motion_blur === "transform_pin" && based.model !== "translate" && based.model !== "similarity") {
    notes.push(`The ${based.model} track was split into a similarity on the layer transform (largest corner deviation ${keys.max_fit_px} px) and the rest in the pin.`);
  }
  if (args.motion_blur === "none") notes.push("Corner Pin and CC Power Pin animation gets no layer motion blur: pass motion_blur transform_pin or force if the shot has motion blur.");
  if (item.kind === "footage" && item.duration > 0) {
    const lastKey = keys.times[keys.times.length - 1];
    if ((args.insert_start ?? 0) + item.duration < lastKey) notes.push(`The insert is ${r2(item.duration)} s long and ends before the last key (${r2(lastKey)} s): the screen goes empty after it. Loop or extend it.`);
  }

  if ((args.insert_start ?? 0) > keys.times[0] + 1e-6) notes.push(`insert_start (${r2(args.insert_start ?? 0)} s) is after the first key (${r2(keys.times[0])} s): the old screen shows until then, because the insert layer starts at insert_start.`);
  if (args.range) notes.push(`This call made its own insert comp and layer, cut to its range (${r2(keys.times[0])}-${r2(keys.times[keys.times.length - 1])} s). Existing insert layers are not extended, so a further range makes another layer and the old screen shows in any gap.`);

  const plan: ReplacePlan = {
    name,
    pin: args.pin,
    insertSize,
    times: keys.times,
    keys,
    expansionPct: args.expansion_pct,
    motionBlur: args.motion_blur,
    levels,
    blurriness,
    reflections,
    insertStart: args.insert_start ?? 0,
    plateId: info.plate ? info.plate.id : null,
    sourceLayerId: item.from_layer ? item.from_layer.id : null,
    switchOffSource: args.insert.layer !== undefined && args.switch_off_source_layer,
    fps: comp.fps,
  };

  // ----- the guarded write -----
  const sampleTimes = sampleIdx(keys.times.length).map((i) => keys.times[i]);
  const expect: ExpectGuard = { project_path: args.expect.project_path, comp_id: args.expect.comp_id ?? args.comp_id };
  const result = await runGuardedWrite<HostWritten>(ctx, {
    toolName,
    label,
    expect,
    compId: args.comp_id,
    read: (phase, written) => {
      if (phase === "before") return { host: "screenrepRead", args: { comp_id: args.comp_id } };
      const insertId = written?.insert_layer?.id;
      const reflectionId = written?.look?.reflections?.layer_id;
      const ids = [insertId, reflectionId].filter((v): v is number => typeof v === "number");
      const kind = written?.pin?.kind ?? args.pin;
      const keyItems: Array<Record<string, unknown>> = [];
      if (typeof insertId === "number") {
        keyItems.push({ layer_id: insertId, kind, ...(written?.pin?.effect_index !== undefined ? { effect_index: written.pin.effect_index } : {}), times: sampleTimes });
        if (keys.transform) keyItems.push({ layer_id: insertId, kind: "transform", times: sampleTimes });
      }
      return {
        host: "screenrepRead",
        args: { comp_id: args.comp_id, layer_ids: ids, insert_comp_id: written?.insert_comp?.id, keys: keyItems },
        timeoutMs: SLOW_TIMEOUT_MS,
      };
    },
    write: {
      host: "screenrepApply",
      args: {
        comp_id: args.comp_id,
        name,
        insert: args.insert.item_id !== undefined ? { item_id: args.insert.item_id } : { layer: { index: item.from_layer!.index, id: item.from_layer!.id } },
        insert_size: insertSize,
        insert_start: plan.insertStart,
        ...(args.range ? { trim_to_keys: true } : {}),
        ...(info.plate ? { plate: { index: info.plate.index, id: info.plate.id } } : {}),
        pin: args.pin,
        expansion_pct: args.expansion_pct,
        times: keys.times,
        exact: keys.exact,
        expanded: keys.expanded,
        ...(keys.transform ? { transform: keys.transform } : {}),
        motion_blur: args.motion_blur,
        look: {
          ...(levels ? { levels: { in_black: levels.in_black, in_white: levels.in_white, out_black: levels.out_black, out_white: levels.out_white } } : {}),
          ...(blurriness !== null ? { blurriness } : {}),
        },
        ...(reflections ? { reflections } : {}),
        switch_off_source: plan.switchOffSource,
      },
      timeoutMs: SLOW_TIMEOUT_MS,
    },
    check: (before, after, written) => replaceMismatches(plan, before, after, written),
  });

  // ----- after the write: nothing below may throw -----
  const w = result as unknown as HostWritten & { op_id: string; checkpoint: unknown; receipt: unknown; user_changed?: string };
  const skippedLook = Array.isArray(w.look_skipped) ? w.look_skipped : [];
  for (const s of skippedLook) notes.push(`Not done: ${s.step}: ${s.reason}.`);
  if (w.pin_fallback) notes.push(w.pin_fallback);
  const exp = w.pin?.expansion as { mode?: string } | undefined;
  if (exp?.mode === "param") notes.push("CC Power Pin's Expansion parameter was set to the percentage given; its unit is unverified, so look at the bezel edge.");
  if (exp?.mode === "values") notes.push("The corners were pushed outward by the expansion in the keys themselves.");
  if (w.pin && w.pin.kind === "power_pin") notes.push("CC Power Pin's point names were matched by name and by position; the parameter table is in pin.param_table: check it once on this AE.");

  let sheetPath: string | undefined;
  let sheetError: string | undefined;
  if (args.contact_sheet && sheet.length > 0 && result.receipt) {
    try {
      const shots = await queued(ctx, `${label} sheet`, opId, async () => {
        const after: SheetShot[] = [];
        const beforeShots: SheetShot[] = [];
        let i = 0;
        for (const s of sheet) {
          const img = prep.keep.get(s.time);
          if (!img) continue;
          try {
            const snap = await renderFrame(ctx, `${opId}_after`, args.comp_id, s.time, 2000 + i++, framesDir, toolName);
            beforeShots.push({ label: s.label, time: s.time, image: img });
            after.push({ label: s.label, time: s.time, image: snap.image });
          } catch (err) {
            if (isAeBlocked(err)) break;
          }
          await yieldLoop();
        }
        return { before: beforeShots, after };
      });
      const png = drawBeforeAfterSheet(shots.before, shots.after, args.max_size);
      if (png) sheetPath = writePng(framesDir, `screenreplace_${opId}`, png);
      else sheetError = "no frame could be rendered for the sheet";
    } catch (err) {
      sheetError = errMessage(err);
    }
  }
  if (sheetError) notes.push(`The before / after sheet could not be made: ${sheetError}`);
  if (measure?.blocked) notes.push("AE stopped responding during a measuring render (often a modal dialog); the rest was not rendered.");
  if (measure && measure.frames_measured < measure.frames_planned && args.match_look) notes.push(`Measured on ${measure.frames_measured} of ${measure.frames_planned} planned frames.`);

  return {
    ok: true,
    op_id: w.op_id,
    applied: true,
    comp_id: args.comp_id,
    ref_time: r4(refTime),
    insert: { comp: w.insert_comp, layer: w.insert_layer, source: w.source_item ?? { id: item.item_id, name: item.name, kind: item.kind }, size: insertSize, fit: args.fit },
    aspect: { used: r3(prep.aspect), estimated: r3(prep.est.aspect), range: [r3(prep.est.range[0]), r3(prep.est.range[1])], given: args.insert_aspect ?? null, method: prep.est.method },
    pin: w.pin,
    written: w.written,
    look: {
      ...(w.look ?? {}),
      ...(levels ? { levels_plan: { in_black: r4(levels.in_black), in_white: r4(levels.in_white), out_black: r4(levels.out_black), out_white: r4(levels.out_white) } } : {}),
      ...(blurSigma !== null ? { blur_sigma_px: r3(blurSigma), ...(blurSigmaLayer !== null ? { blur_sigma_layer_px: r3(blurSigmaLayer) } : {}), blurriness } : {}),
    },
    motion_blur: w.motion_blur ?? { mode: args.motion_blur },
    ...(w.source_layer ? { source_layer: w.source_layer } : {}),
    track: { track_id: based.track_id, model: based.model, frames_written: keys.times.length, ...(keys.skipped.length ? { frames_skipped: keys.skipped.slice(0, 100).map(r4), frames_skipped_total: keys.skipped.length } : {}) },
    ...(measure
      ? {
          measured: {
            frames_measured: measure.frames_measured,
            plate_black: measure.black === null ? null : r4(measure.black),
            plate_white: measure.white === null ? null : r4(measure.white),
            plate_p95: measure.p95 === null ? null : r4(measure.p95),
            edge: measure.edge,
            insert: measure.insert,
            per_frame: measure.per_frame.slice(0, 100),
            skipped: measure.skipped.slice(0, 50),
            budget: measure.budget,
            ...(measure.trimmed ? { trimmed: true } : {}),
            note: "Black and white are the 2nd and 98th percentile of luma inside the moved screen, medianed over the frames, on 8-bit sRGB snapshots.",
          },
        }
      : {}),
    ...(sheetPath ? { sheet_path: sheetPath } : {}),
    follow_ups: FOLLOW_UPS,
    notes,
    checkpoint: w.checkpoint,
    receipt: w.receipt,
    ...(w.user_changed ? { user_changed: w.user_changed } : {}),
  };
}

// ---------- tools ----------

export const screenrepTools: ToolDefinition<any>[] = [
  {
    name: "ae_screen_corners",
    description:
      "Snap four rough corner guesses of a screen, sign or poster to its real corners, and say how far to trust them, from one rendered frame. The guesses (comp pixels at ref_time, [UL, UR, LR, LL], for example read off a snapshot) may be a few pixels off. " +
      "How: each side's edge is found as a gradient ridge along the side (the outer bezel edge by default, `edge` chooses), fitted with a robust line (outliers dropped), and every corner is the intersection of its two lines, which works on rounded bezels where the corner itself has no feature; a Shi-Tomasi corner response cross-checks it and is the fallback. " +
      "Per corner: the snapped position, the shift, the edge strength, whether two parallel edges compete, whether a pattern there passes the tracker's contrast test (std of 3 gray levels), and a 0..1 confidence. For the quad: convexity, area, edge lengths, an aspect-ratio ESTIMATE with a range (one perspective view cannot give the focal length exactly: pass insert_aspect when you know the panel's ratio), and, with `track`, whether a corner leaves the frame anywhere in the shot or the quad folds. " +
      "It also suggests 4-8 better tracking points on the plane, inside the screen and on the bezel (the picker of ae_track_multi's auto_points), for when the corners themselves track badly (glare, fingers): pass them as `points`. `preview_path` is the frame with the guesses (red), the snapped quad (green), the fitted edges (yellow) and the points (cyan): look at it. " +
      "READ-ONLY: one render, nothing in the project is touched (not time, resolution, selection or solo). With `isolate_layers` it renders a temporary copy of the comp with only those layers on instead, so an overlay above the screen cannot fool the search: that writes to the project (two undo groups, an automatic checkpoint, a receipt) and needs `expect`. " +
      "Measured on 8-bit sRGB snapshots. Reflections and screen content near the bezel produce false edges: with two strong edges competing the confidence drops and the notes say so.",
    schema: AeScreenCornersSchema,
    handler: async (args: AeScreenCornersArgs, ctx: ToolContext) => {
      try {
        return await screenCorners(ctx, args);
      } catch (err) {
        if (err instanceof PlanarError) return failure(err);
        throw err;
      }
    },
  },
  {
    name: "ae_screen_replace",
    description:
      "Replace a screen, sign or poster on a tracked plane in ONE undo step, from a planar track (ae_track_multi / ae_track_read) and the screen's four corners [UL, UR, LR, LL] at the reference frame (ae_screen_corners). " +
      "It makes: (1) an insert precomp '<name> INSERT' at the screen's aspect (estimated from the corners in perspective, or `insert_aspect`) holding the footage or comp at 100%, filled or fitted (`fit`) so it keeps its proportions; (2) the insert layer directly above `plate`, with CC Power Pin (default) or Corner Pin keyed to the corners moved by the track, in the layer's own space, with `expansion_pct` (default 2%) of overscan under the bezel; " +
      "(3) the look, measured from the plate on rendered frames before the write: Levels so the insert's blacks sit at the screen's black (2nd percentile luma inside the moved screen, over `max_samples` frames) and a 0-2 px Gaussian Blur from the softness of the bezel's edge; (4) optionally `reflections`: a duplicate of the plate above the insert in Screen mode with Levels that keep only its highlights, track-matted by the insert's alpha, so glare follows without mask keys; " +
      "(5) optionally `motion_blur`: transform_pin keys the similarity part of the track on the layer's Position / Rotation / Scale (so layer motion blur works) and the residual perspective in the pin, or force adds CC Force Motion Blur. Effects follow the shared order (colour, blur, pin, motion blur). " +
      "After the write it renders the first, reference, last and fastest frame again and writes a before / after sheet (`sheet_path`). The result lists the follow-ups: occluding hands need a roto layer of yours (not scriptable), grain (ae_patch_grain) and a check (ae_patch_check). " +
      "Refuses before touching the project when the corners do not make a quad, when the track has no solved motion at ref_time or is a perspective track with fewer than 4 points, on locked or missing layers, a comp with non-square pixels, and reflections without AE 23+ track mattes. " +
      "The core (comp, layer, pin, keys) is all or nothing; the look steps are best effort and report what they could not do (look_skipped) with the effect's parameter table, because CC Power Pin's and Levels' parameters are unmeasured on this AE. The receipt checks the layer order, the insert comp's size, the key counts and sample values, every Levels, blur and reflection-Levels parameter written, CC Power Pin's Expansion, the Screen mode, opacity and matte of the reflection, and the motion blur switches. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeScreenReplaceSchema,
    handler: async (args: AeScreenReplaceArgs, ctx: ToolContext) => {
      try {
        return await screenReplace(ctx, args);
      } catch (err) {
        if (err instanceof PlanarError) return failure(err);
        throw err;
      }
    },
  },
];
