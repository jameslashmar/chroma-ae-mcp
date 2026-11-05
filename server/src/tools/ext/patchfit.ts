/**
 * server/src/tools/ext/patchfit.ts
 *
 * Making a frozen or cloned patch sit in the shot, measured from rendered
 * frames and written as ordinary keys and effects:
 * - ae_patch_color_match: renders the plate (patch layers off) on every frame
 *   or every Nth, fits per channel the gain and offset that map a ring around
 *   the patch at the reference frame onto the ring at each frame (pixel-aligned
 *   through the track, 10% trimmed least squares), smooths and thins the curves
 *   and keys a Levels (Individual Controls) or Exposure effect on the patch.
 *   Long shots are measured in chunks (continue_id); the keys are written by the
 *   last call, which also compares the seam colour before and after.
 * - ae_patch_grain: measures spatial and temporal grain in the plate's ring and
 *   inside the patch, optionally degrains the frozen patch, adds animated grain
 *   on an adjustment layer matted to the patch's alpha, and tunes its intensity
 *   in up to three measured rounds.
 * - ae_patch_finish: matches sharpness (a measured Gaussian blur), the edge
 *   (mask feather and expansion from a seam score), motion blur (from the
 *   track's speed and the shutter) and the layer's sampling quality.
 *
 * Everything runs inside the MCP and After Effects. The plate comes from a
 * temporary copy of the comp (planar.ts withIsolatedPlate: two undo groups, the
 * copy always removed); the measuring is region-math.ts; the track is planar's.
 *
 * Not built, because AE has no API for it: Curves as the correction (its curve
 * is a custom value script cannot set) and Color Stabilizer (its reference
 * needs the Set Frame button).
 *
 * Unmeasured on AE 26 (the code works either way and returns the tables it
 * used): the match names and display names of Levels (Individual Controls),
 * Exposure, Add Grain, Match Grain, Remove Grain and CC Force Motion Blur
 * parameters; the unit of the Levels parameters (0..1, 0..255 or 0..32768; the
 * host reads it from the effect's own defaults); the item index of "Final
 * Output" in the Viewing Mode menus (the last item: 3 for Add Grain, 5 for
 * Match Grain, 4 for Remove Grain; `viewing_mode_index` and
 * `degrain_viewing_mode_index` override them and the host checks the index
 * against the menu's range); whether setTrackMatte leaves the patch layer on
 * (the host switches it back on if not); the real sigma-per-Intensity of Add Grain
 * (the rounds correct a wrong first guess); Blurriness against Gaussian sigma
 * (planar.ts first estimate); and whether the fits hold in linear or 32 bpc
 * projects (the snapshots are 8-bit and colour-managed; the project's bit depth
 * and blending are reported with every fit).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { PNG } from "pngjs";
import { z } from "zod";
import { BridgeError, SLOW_TIMEOUT_MS } from "../../host.js";
import { buildJsxCall } from "../../jsx.js";
import { QueueWaitError } from "../../queue.js";
import { buildReceipt, type ReceiptMismatch } from "../../receipts.js";
import {
  AGENT_SAFETY_GUIDANCE,
  ExpectSchema,
  LayerSelectorSchema,
  type ExpectGuard,
  type LayerSelector,
  type ToolContext,
  type ToolDefinition,
} from "../common.js";
import { autoCheckpoint, verifyTargetGuard } from "../mutate.js";
import { defaultFramesDir } from "../render.js";
import { captureCompFrame, decodePngFile } from "./frames.js";
import { drawSeriesGraph, RegionShapeSchema } from "./patchcheck.js";
import { applyH, frameAt, identityH, invertH, mulH, type Mat3, type PlanarTrack } from "./planar-math.js";
import {
  blurrinessFromSigma,
  channelGray,
  createRenderBudget,
  PlanarError,
  resolveEffectParams,
  newTrackId,
  resolveTrackSource,
  sigmaFromBlurriness,
  saveTrack,
  loadTrack,
  TrackSourceSchema,
  withIsolatedPlate,
} from "./planar.js";
import { blit, createCanvas, encodePng, scaleNearest, type RgbaImage } from "./png-utils.js";
import {
  cropToBounds,
  fitGainOffset,
  gaussianBlurGray,
  laplacianEnergy,
  maskedStats,
  noiseSigma,
  polygonBounds,
  regionToPolygon,
  ringMask,
  seamScore,
  temporalNoise,
  warpPolygon,
  type Pt,
  type RegionSpec,
} from "./region-math.js";
import { noteAfterWrite, noteBeforeWrite, type WriteInfo } from "./session.js";
import { toGray, type GrayImage } from "./track.js";
import { expectThat, runGuardedWrite } from "./write-runner.js";

// ---------- names and limits ----------

/** The names the host gives the effects and the layer this group makes; it only ever touches those. */
export const COLOR_EFFECT_NAME = "Chroma drift match";
export const BLUR_EFFECT_NAME = "Chroma sit-in blur";
export const GRAIN_EFFECT_NAME = "Chroma grain";

const MAX_FRAMES = 3000;
const OUT_CAP = 500;
const MAX_PLATE_LAYERS = 100;
const KEEP_STATES = 50;
/** 0.5 / 255: a step the 8-bit result cannot show. */
const EIGHT_BIT_HALF = 0.5 / 255;
/** A patch whose detail is within this factor of the plate's is left alone: texture differs between two areas of the same surface. */
export const SHARPNESS_SLACK = 1.1;
/** First estimate of Add Grain's noise sigma (gray levels) per unit of Intensity; the tuning rounds correct it. */
export const GRAIN_SIGMA_PER_INTENSITY = 20;

const r2 = (v: number): number => Math.round(v * 100) / 100;
const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const r4 = (v: number): number => Math.round(v * 10000) / 10000;
const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const yieldLoop = (): Promise<void> => new Promise<void>((r) => setImmediate(r));
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const median = (a: number[]): number => {
  if (a.length === 0) return 0;
  const s = Float64Array.from(a).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

// ---------- pure: sampling ----------

export interface FramePlan {
  /** Sampled comp times, ascending, on the frame grid; the reference frame is always in. */
  times: number[];
  total_frames: number;
  step: number;
  range: [number, number];
  ref_time: number;
}

/**
 * The frames to measure: the first of the range, every `step`th, the last and
 * the reference frame. The range defaults to the work area. Throws PlanarError
 * when more than `maxFrames` would be rendered.
 */
export function planFrameTimes(o: {
  fps: number;
  duration: number;
  workStart: number;
  workDuration: number;
  start?: number;
  end?: number;
  step: number;
  refTime?: number;
  maxFrames?: number;
}): FramePlan {
  const fps = o.fps > 0 ? o.fps : 24;
  const last = Math.max(0, Math.round(o.duration * fps) - 1);
  const clampF = (f: number) => Math.max(0, Math.min(last, f));
  const wf0 = clampF(Math.round(o.workStart * fps));
  const wf1 = Math.max(wf0, clampF(Math.round((o.workStart + o.workDuration) * fps) - 1));
  const f0 = o.start !== undefined ? clampF(Math.round(o.start * fps)) : wf0;
  const f1 = Math.max(f0, o.end !== undefined ? clampF(Math.round(o.end * fps)) : wf1);
  const step = Math.max(1, Math.round(o.step));
  const refF = o.refTime !== undefined ? clampF(Math.round(o.refTime * fps)) : f0;
  const set = new Set<number>([f0, f1, refF]);
  for (let f = f0; f <= f1; f += step) set.add(f);
  const frames = [...set].sort((a, b) => a - b);
  const cap = o.maxFrames ?? MAX_FRAMES;
  if (frames.length > cap) {
    throw new PlanarError("bad_args", `${frames.length} frames would be measured; the most is ${cap}. Raise step or narrow start / end.`);
  }
  return { times: frames.map((f) => f / fps), total_frames: f1 - f0 + 1, step, range: [r4(f0 / fps), r4(f1 / fps)], ref_time: refF / fps };
}

/** `n` frames spread over [from, to] (frame numbers), each with a frame after it (or before, at the very end). */
export function spreadFrames(from: number, to: number, n: number): number[] {
  const out = new Set<number>();
  const count = Math.max(1, Math.min(n, to - from + 1));
  for (let i = 0; i < count; i++) out.add(count === 1 ? Math.round((from + to) / 2) : Math.round(from + ((to - from) * i) / (count - 1)));
  return [...out].sort((a, b) => a - b);
}

// ---------- pure: series ----------

/** Fills null entries by linear interpolation between the neighbours, holding the ends. Null when every entry is null. */
export function fillGaps(values: Array<number | null>): number[] | null {
  const known: number[] = [];
  values.forEach((v, i) => {
    if (v !== null && Number.isFinite(v)) known.push(i);
  });
  if (known.length === 0) return null;
  const out: number[] = new Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v !== null && Number.isFinite(v)) {
      out[i] = v;
      continue;
    }
    const prev = [...known].reverse().find((k) => k < i);
    const next = known.find((k) => k > i);
    if (prev === undefined) out[i] = values[next as number] as number;
    else if (next === undefined) out[i] = values[prev] as number;
    else {
      const a = values[prev] as number;
      const b = values[next] as number;
      out[i] = a + ((b - a) * (i - prev)) / (next - prev);
    }
  }
  return out;
}

/** Gaussian smoothing over samples (sigma in samples). The ends are padded with an odd reflection (v[-k] = 2 v[0] - v[k]), which keeps a linear trend unbiased there. A sigma under 0.05 returns a copy. */
export function smoothGaussian(values: number[], sigma: number): number[] {
  if (!(sigma >= 0.05) || values.length < 2) return [...values];
  const r = Math.max(1, Math.ceil(sigma * 3));
  const out: number[] = new Array(values.length);
  for (let i = 0; i < values.length; i++) {
    let s = 0;
    let w = 0;
    const last = values.length - 1;
    for (let k = -r; k <= r; k++) {
      const j = i + k;
      let v: number;
      if (j < 0) v = 2 * values[0] - values[Math.min(-j, last)];
      else if (j > last) v = 2 * values[last] - values[Math.max(last - (j - last), 0)];
      else v = values[j];
      const wk = Math.exp(-(k * k) / (2 * sigma * sigma));
      s += wk * v;
      w += wk;
    }
    out[i] = s / w;
  }
  return out;
}

/**
 * Indexes to keep so that linear interpolation between the kept samples misses
 * no series by more than its tolerance (Ramer-Douglas-Peucker on time).
 * The first and last are always kept.
 */
export function decimateKeys(times: number[], series: number[][], tols: number[]): number[] {
  const n = times.length;
  if (n <= 2) return times.map((_, i) => i);
  const keep = new Set<number>([0, n - 1]);
  const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop() as [number, number];
    let worst = -1;
    let worstErr = 1;
    for (let i = a + 1; i < b; i++) {
      const u = (times[i] - times[a]) / (times[b] - times[a]);
      for (let s = 0; s < series.length; s++) {
        const lerp = series[s][a] + (series[s][b] - series[s][a]) * u;
        const err = Math.abs(series[s][i] - lerp) / tols[s];
        if (err > worstErr) {
          worstErr = err;
          worst = i;
        }
      }
    }
    if (worst >= 0) {
      keep.add(worst);
      stack.push([a, worst], [worst, b]);
    }
  }
  return [...keep].sort((x, y) => x - y);
}

// ---------- pure: the correction as effect values ----------

export interface LevelsValues {
  inBlack: number;
  inWhite: number;
  outBlack: number;
  outWhite: number;
  clamped: boolean;
}

/**
 * Levels (gamma 1) that map x to offset + gain * x on 0..1. With gain and
 * offset keeping the line inside the unit square this is just Output Black =
 * offset and Output White = offset + gain; when it would leave the square the
 * input range is narrowed (gain above 1) or raised (offset below 0) so the
 * mapping stays exact. A gain or offset outside what Levels can show is
 * clamped (`clamped`).
 */
export function levelsFromGainOffset(gain: number, offset: number): LevelsValues {
  const g0 = clamp(gain, 0.05, 20);
  const o0 = clamp(offset, -1, 1);
  let clamped = g0 !== gain || o0 !== offset;
  const g = g0;
  const o = o0;
  if (o >= 1) return { inBlack: 0, inWhite: 1, outBlack: 1, outWhite: 1, clamped: true };
  if (o + g <= 0) return { inBlack: 0, inWhite: 1, outBlack: 0, outWhite: 0, clamped: true };
  const x0 = -o / g;
  const x1 = (1 - o) / g;
  let inBlack = 0;
  let outBlack = o;
  if (x0 > 0) {
    inBlack = x0;
    outBlack = 0;
  }
  let inWhite = 1;
  let outWhite = o + g;
  if (x1 < 1) {
    inWhite = x1;
    outWhite = 1;
  }
  if (inWhite - inBlack < 1e-4) {
    clamped = true;
    return { inBlack: 0, inWhite: 1, outBlack: clamp(o, 0, 1), outWhite: clamp(o, 0, 1), clamped };
  }
  return { inBlack, inWhite, outBlack, outWhite: Math.min(1, outWhite), clamped };
}

/** What Levels does to x (gamma 1), for checking a mapping. */
export function evalLevels(p: LevelsValues, x: number): number {
  const t = clamp((x - p.inBlack) / (p.inWhite - p.inBlack), 0, 1);
  return p.outBlack + t * (p.outWhite - p.outBlack);
}

/** Exposure with the linear conversion bypassed: out = in * 2^exposure + offset. */
export function exposureFromGainOffset(gain: number, offset: number): { exposure: number; offset: number; clamped: boolean } {
  const g = clamp(gain, 0.05, 20);
  const o = clamp(offset, -1, 1);
  return { exposure: Math.log2(g), offset: o, clamped: g !== gain || o !== offset };
}

/** The encoded-to-linear exponent used to carry a gain fitted on encoded values into linear light (sRGB is close to 2.2). */
export const ENCODED_TO_LINEAR_EXPONENT = 2.2;

/**
 * Exposure with the linear conversion ON (bypass_linear false): a gain g on
 * encoded values is about g^2.2 in linear light, i.e. 2.2 x log2(g) stops. An
 * offset on encoded values has no exact linear counterpart, so it is dropped
 * (0) and the caller says so.
 */
export function exposureLinearFromGainOffset(gain: number, offset: number): { exposure: number; offset: number; clamped: boolean } {
  const e = exposureFromGainOffset(gain, offset);
  return { exposure: ENCODED_TO_LINEAR_EXPONENT * e.exposure, offset: 0, clamped: e.clamped };
}

// ---------- pure: the ring fit ----------

/** The pixels of a mask (band around the patch) in the reference frame's PNG geometry. */
export interface RingSet {
  width: number;
  height: number;
  idx: Uint32Array;
  mask: Float32Array;
}

export function makeRingSet(width: number, height: number, polyPng: Pt[], innerPx: number, outerPx: number): RingSet {
  const mask = ringMask(width, height, polyPng, innerPx, outerPx);
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] >= 0.5) n++;
  const idx = new Uint32Array(n);
  let k = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] >= 0.5) idx[k++] = i;
  return { width, height, idx, mask };
}

const scalePoly = (poly: Pt[], s: number): Pt[] => poly.map((p) => [p[0] * s, p[1] * s] as Pt);

/** Where reference-frame pixel k lands in a frame of the same size: PNG index coordinates, or null outside it. */
function landing(H: Mat3, scale: number, width: number, height: number, srcW: number, srcH: number, k: number): [number, number] | null {
  const x = k % width;
  const y = (k - x) / width;
  const p = applyH(H, [(x + 0.5) / scale, (y + 0.5) / scale]);
  if (!p) return null;
  const u = p[0] * scale - 0.5;
  const v = p[1] * scale - 0.5;
  if (!(u >= 0 && v >= 0 && u <= srcW - 1 && v <= srcH - 1)) return null;
  return [u, v];
}

function bilinear(get: (i: number) => number, w: number, h: number, u: number, v: number): number {
  const x0 = Math.min(Math.max(0, w - 2), Math.floor(u));
  const y0 = Math.min(Math.max(0, h - 2), Math.floor(v));
  const fx = w < 2 ? 0 : u - x0;
  const fy = h < 2 ? 0 : v - y0;
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const top = get(y0 * w + x0) * (1 - fx) + get(y0 * w + x1) * fx;
  const bottom = get(y1 * w + x0) * (1 - fx) + get(y1 * w + x1) * fx;
  return top * (1 - fy) + bottom * fy;
}

/**
 * The ring pixels of the reference geometry sampled from `src` through H
 * (reference comp px -> frame comp px). `valid` marks the ones that land
 * inside the frame. Pixels outside the ring stay zero.
 */
export function warpRgbaToRef(src: RgbaImage, H: Mat3, scale: number, ring: RingSet): { img: RgbaImage; valid: Float32Array; validCount: number } {
  const { width, height } = ring;
  const data = Buffer.alloc(width * height * 4);
  const valid = new Float32Array(width * height);
  let validCount = 0;
  for (let n = 0; n < ring.idx.length; n++) {
    const k = ring.idx[n];
    const at = landing(H, scale, width, height, src.width, src.height, k);
    if (!at) continue;
    valid[k] = 1;
    validCount++;
    for (let c = 0; c < 3; c++) data[k * 4 + c] = Math.round(bilinear((i) => src.data[i * 4 + c], src.width, src.height, at[0], at[1]));
    data[k * 4 + 3] = 255;
  }
  return { img: { width, height, data }, valid, validCount };
}

/** The gray version of warpRgbaToRef. */
export function warpGrayToRef(src: GrayImage, H: Mat3, scale: number, ring: RingSet): { gray: GrayImage; valid: Float32Array; validCount: number } {
  const { width, height } = ring;
  const data = new Float32Array(width * height);
  const valid = new Float32Array(width * height);
  let validCount = 0;
  for (let n = 0; n < ring.idx.length; n++) {
    const k = ring.idx[n];
    const at = landing(H, scale, width, height, src.width, src.height, k);
    if (!at) continue;
    valid[k] = 1;
    validCount++;
    data[k] = bilinear((i) => src.data[i], src.width, src.height, at[0], at[1]);
  }
  return { gray: { width, height, data }, valid, validCount };
}

export interface FrameFit {
  ok: boolean;
  reason?: string;
  gain: [number, number, number];
  offset: [number, number, number];
  rms: number;
  /** Ring pixels the fit used (after clipping and trimming). */
  pixels: number;
  /** Share of the ring that lies inside the frame at this time. */
  visible: number;
}

/**
 * Per channel gain and offset with plate_t(H x) = gain * plate_ref(x) + offset
 * over the ring, the ring pixels of frame t taken at their tracked places. A
 * frame with too little of the ring in view, or too few unclipped pixels,
 * is not ok and gets no key.
 */
export function fitFrame(ref: RgbaImage, frame: RgbaImage, ring: RingSet, H: Mat3 | null, scale: number, o: { minVisible: number; trimPct?: number }): FrameFit {
  const bad = (reason: string, visible = 0): FrameFit => ({ ok: false, reason, gain: [1, 1, 1], offset: [0, 0, 0], rms: 0, pixels: 0, visible });
  if (!H) return bad(LOST_REASON);
  if (ring.idx.length < 30) return bad("the ring has fewer than 30 pixels");
  if (ref.width !== ring.width || ref.height !== ring.height) return bad("the reference render has another size");
  const warped = warpRgbaToRef(frame, H, scale, ring);
  const visible = warped.validCount / ring.idx.length;
  if (visible < o.minVisible) return bad(`only ${Math.round(visible * 100)}% of the ring is in view`, visible);
  const fit = fitGainOffset(warped.img, ref, warped.valid, { trimPct: o.trimPct ?? 10, excludeClipped: true });
  if (fit.pixels < 30) return bad("too few unclipped ring pixels", visible);
  return { ok: true, gain: fit.gain, offset: fit.offset, rms: fit.rms, pixels: fit.pixels, visible };
}

const LOST_REASON = "the track lost the plate at this time";

export interface CurveSet {
  /** Per channel (r, g, b), per sample. */
  gain: number[][];
  offset: number[][];
  /** Sample indexes filled in by interpolation (not measured). */
  filled: number[];
  usable: number;
}

/** Fills the unmeasured samples and smooths each curve (smooth_frames in frames; sigma in samples is that over the step). Null with fewer than two measured samples. */
export function buildCurves(fits: Array<FrameFit | null>, o: { smoothFrames: number; step: number; refIndex?: number }): CurveSet | null {
  const usable = fits.filter((f) => f && f.ok).length;
  if (usable < 2) return null;
  const sigma = o.smoothFrames / Math.max(1, o.step);
  const filled: number[] = [];
  fits.forEach((f, i) => {
    if (!f || !f.ok) filled.push(i);
  });
  const gain: number[][] = [];
  const offset: number[][] = [];
  for (let c = 0; c < 3; c++) {
    const g = fillGaps(fits.map((f) => (f && f.ok ? f.gain[c] : null))) as number[];
    const of = fillGaps(fits.map((f) => (f && f.ok ? f.offset[c] : null))) as number[];
    const sg = smoothGaussian(g, sigma);
    const so = smoothGaussian(of, sigma);
    // The reference frame is the identity by definition: smoothing must not move it.
    if (o.refIndex !== undefined && o.refIndex >= 0 && o.refIndex < sg.length) {
      sg[o.refIndex] = 1;
      so[o.refIndex] = 0;
    }
    gain.push(sg);
    offset.push(so);
  }
  return { gain, offset, filled, usable };
}

export interface KeySet {
  times: number[];
  /** channel -> role -> values (Levels roles in 0..1; Exposure roles in stops and 0..1). */
  series: Record<"red" | "green" | "blue", Record<string, number[]>>;
  clamped: boolean;
  /** True when one value serves the whole shot (written as a plain value, not keys). */
  constant: boolean;
  /** True when every sample is within what 8 bits can show of "no correction". */
  noDrift: boolean;
  /** Exposure carried into linear light (bypass_linear false): stops are 2.2 x log2(gain). */
  linear: boolean;
  /** True when the fitted offset was not written (the linear path drops it) although it was above what 8 bits show. */
  offsetDropped: boolean;
}

const CHANNEL_KEYS = ["red", "green", "blue"] as const;

/** The curves as effect parameter values, thinned to the keys linear interpolation needs. */
export function buildKeys(times: number[], curves: CurveSet, mode: "levels" | "exposure", opts: { linear?: boolean } = {}): KeySet {
  const linear = mode === "exposure" && opts.linear === true;
  let offsetDropped = false;
  const n = times.length;
  const roleNames = mode === "levels" ? ["in_black", "in_white", "out_black", "out_white"] : ["exposure", "offset"];
  const tolFor = mode === "levels" ? roleNames.map(() => EIGHT_BIT_HALF) : [EIGHT_BIT_HALF / Math.LN2, EIGHT_BIT_HALF];
  const full: Record<string, number[][]> = {};
  let clamped = false;
  let noDrift = true;
  for (let c = 0; c < 3; c++) {
    const cols: number[][] = roleNames.map(() => new Array(n));
    for (let i = 0; i < n; i++) {
      const g = curves.gain[c][i];
      const o = curves.offset[c][i];
      if (Math.abs(g - 1) > EIGHT_BIT_HALF || Math.abs(o) > EIGHT_BIT_HALF) noDrift = false;
      if (mode === "levels") {
        const l = levelsFromGainOffset(g, o);
        if (l.clamped) clamped = true;
        cols[0][i] = l.inBlack;
        cols[1][i] = l.inWhite;
        cols[2][i] = l.outBlack;
        cols[3][i] = l.outWhite;
      } else {
        const e = linear ? exposureLinearFromGainOffset(g, o) : exposureFromGainOffset(g, o);
        if (e.clamped) clamped = true;
        if (linear && Math.abs(o) > EIGHT_BIT_HALF) offsetDropped = true;
        cols[0][i] = e.exposure;
        cols[1][i] = e.offset;
      }
    }
    full[CHANNEL_KEYS[c]] = cols;
  }
  const all = CHANNEL_KEYS.flatMap((k) => full[k]);
  const allTols = CHANNEL_KEYS.flatMap(() => tolFor);
  const kept = decimateKeys(times, all, allTols);
  const constant = all.every((s, j) => Math.max(...s) - Math.min(...s) <= allTols[j]);
  const useIdx = constant ? [0] : kept;
  const series = {} as KeySet["series"];
  for (const k of CHANNEL_KEYS) {
    const rec: Record<string, number[]> = {};
    roleNames.forEach((role, j) => {
      rec[role] = useIdx.map((i) => r4e(full[k][j][i]));
    });
    series[k] = rec;
  }
  return { times: useIdx.map((i) => times[i]), series, clamped, constant, noDrift, linear, offsetDropped };
}

/** Rounds to 6 decimals: below what any 16-bit parameter shows, small enough to send. */
const r4e = (v: number): number => Math.round(v * 1e6) / 1e6;

/** The value of a keyed series at `t` as AE interpolates it linearly, the ends held. */
export function valueAtLinear(times: number[], values: number[], t: number): number {
  if (times.length === 0) return 0;
  if (t <= times[0]) return values[0];
  if (t >= times[times.length - 1]) return values[values.length - 1];
  let i = 1;
  while (times[i] < t) i++;
  const u = (t - times[i - 1]) / (times[i] - times[i - 1]);
  return values[i - 1] + (values[i] - values[i - 1]) * u;
}

/** Up to `n` frames to verify on: the reference, the frames the correction moves most, and an even spread. */
export function pickVerifyTimes(times: number[], deviation: number[], refTime: number, n: number): number[] {
  const out = new Set<number>();
  let refI = 0;
  times.forEach((t, i) => {
    if (Math.abs(t - refTime) < Math.abs(times[refI] - refTime)) refI = i;
  });
  out.add(refI);
  const worst = deviation.map((d, i) => ({ d, i })).sort((a, b) => b.d - a.d);
  for (const w of worst) {
    if (out.size >= Math.ceil(n / 2) + 1) break;
    out.add(w.i);
  }
  for (let k = 0; out.size < Math.min(n, times.length) && k < n * 2; k++) out.add(Math.round((k * (times.length - 1)) / Math.max(1, n - 1)));
  return [...out].sort((a, b) => a - b).slice(0, n).map((i) => times[i]);
}

/** Mean colour inside the patch's edge minus the mean outside it: how far the patch sits off the plate at the seam. */
export function seamColour(img: RgbaImage, polyPng: Pt[], gapPx: number, ringPx: number): { diff: [number, number, number]; mean_abs: number; luma: number } | null {
  const inner = ringMask(img.width, img.height, polyPng, -(gapPx + ringPx / 2), -gapPx);
  const outer = ringMask(img.width, img.height, polyPng, gapPx, gapPx + ringPx);
  const a = maskedStats(img, inner);
  const b = maskedStats(img, outer);
  if (a.pixels < 20 || b.pixels < 20) return null;
  const diff: [number, number, number] = [a.mean_rgb[0] - b.mean_rgb[0], a.mean_rgb[1] - b.mean_rgb[1], a.mean_rgb[2] - b.mean_rgb[2]];
  return { diff: [r4(diff[0]), r4(diff[1]), r4(diff[2])], mean_abs: r4((Math.abs(diff[0]) + Math.abs(diff[1]) + Math.abs(diff[2])) / 3), luma: r4(a.luma_mean - b.luma_mean) };
}

// ---------- pure: grain, sharpness, motion blur, edge ----------

/** Add Grain Intensity for a target noise sigma (gray levels), through the placeholder calibration. */
export function grainIntensityFor(sigma: number): number {
  return r4(clamp(sigma / GRAIN_SIGMA_PER_INTENSITY, 0.02, 10));
}

/** The next Intensity: scaled by target over measured, the step capped at 4x either way. */
export function nextGrainIntensity(current: number, measured: number, target: number): number {
  const ratio = measured > 1e-3 ? clamp(target / measured, 0.25, 4) : 4;
  return r4(clamp(current * ratio, 0.01, 20));
}

/**
 * The Gaussian sigma (px of `gray`) at which the Laplacian energy of the
 * masked region falls to `target`. 0 when it is already at or under it; the
 * cap when even the cap leaves it over.
 */
export function sigmaForEnergy(gray: GrayImage, mask: Float32Array, target: number, maxSigma: number): number {
  const e0 = laplacianEnergy(gray, mask);
  if (!(e0 > target)) return 0;
  if (laplacianEnergy(gaussianBlurGray(gray, maxSigma), mask) > target) return maxSigma;
  let lo = 0;
  let hi = maxSigma;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    if (laplacianEnergy(gaussianBlurGray(gray, mid), mask) > target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Plate motion blur length in px per frame: the speed of a point (px per frame) times the shutter share of the frame. */
export function blurLengthPx(speedPxPerFrame: number, shutterAngle: number): number {
  return speedPxPerFrame * (shutterAngle / 360);
}

/** Feather for a seam score over the limit: more feather the worse the seam, within `maxFeather`; expansion at least half of it. */
export function featherFor(score: number, seamMax: number, currentFeather: number, currentExpansion: number, maxFeather: number): { feather: number; expansion: number } {
  const feather = clamp(Math.ceil(Math.max(currentFeather, 0) + (score - seamMax) * 4 + 1), 1, maxFeather);
  return { feather, expansion: Math.max(currentExpansion, feather / 2) };
}

// ---------- track ----------

function hAt(track: PlanarTrack | null, t: number): Mat3 | null {
  if (!track) return identityH();
  const f = frameAt(track, t);
  if (!f || !f.ok || !f.H || f.H.length !== 9 || !f.H.every(Number.isFinite)) return null;
  return f.H;
}

/** The region as it sits at time t (comp px), or null where the track lost it or it goes behind the horizon. */
function polygonAtT(poly: Pt[], track: PlanarTrack | null, t: number): { H: Mat3; poly: Pt[] } | null {
  const H = hAt(track, t);
  if (!H) return null;
  const moved = warpPolygon(poly, H);
  return moved ? { H, poly: moved } : null;
}

// ---------- the host's answer ----------

export interface HostInfo {
  comp: {
    id: number;
    name: string;
    width: number;
    height: number;
    pixel_aspect: number;
    fps: number;
    frame_duration: number;
    duration: number;
    time: number;
    work_area_start: number;
    work_area_duration: number;
    shutter_angle: number | null;
    shutter_phase: number | null;
    motion_blur: boolean;
    bits_per_channel: number | null;
    linear_blending: boolean | null;
    working_space: string | null;
    linearize_working_space: boolean | null;
  };
  layer: {
    index: number;
    id: number;
    name: string;
    locked: boolean;
    enabled: boolean;
    has_video: boolean;
    three_d: boolean;
    in_point: number;
    out_point: number;
    motion_blur: boolean;
    sampling_bicubic: boolean | null;
    frame_blend_none: boolean | null;
    quality_best: boolean | null;
    effects: Array<{ index: number; name: string; matchName: string }>;
    /** The true number of effects; `effects` is cut at 500. */
    effects_total?: number;
    effects_truncated?: boolean;
    /** Where this group's own effects sit, found over every effect (index or null). */
    own_effects?: { color: number | null; blur: number | null; force_motion_blur: number | null; grain: number | null; degrain: number | null };
    masks: Array<{ index: number; name: string; mode: number | null; feather: number[] | number | null; expansion: number | null; feather_keyed: boolean; expansion_keyed: boolean }>;
    pinned: boolean;
    /** Scale of the layer's own pixels in the comp through its transform Scale and its parents' (1 = unscaled), at the comp's current time. A pin effect's own scale is not in it. */
    comp_scale?: { x: number; y: number; keyed: boolean; pinned: boolean };
  };
  hidden: Array<{ index: number; id: number; name: string }>;
  show: Array<{ index: number; id: number }>;
  show_truncated?: boolean;
  total_layers: number;
}

/**
 * Comp pixels per layer pixel for the patch layer (geometric mean of the two axes), so a size measured in comp
 * pixels can be turned into the layer pixels that Gaussian Blur and Mask Feather work in. 1 when the host did not say.
 */
export function layerCompScale(layer: HostInfo["layer"]): { scale: number; pinned: boolean; keyed: boolean } {
  const cs = layer.comp_scale;
  const pinned = Boolean(cs?.pinned ?? layer.pinned);
  if (!cs || !(cs.x > 1e-3) || !(cs.y > 1e-3) || !Number.isFinite(cs.x) || !Number.isFinite(cs.y)) return { scale: 1, pinned, keyed: Boolean(cs?.keyed) };
  return { scale: Math.sqrt(cs.x * cs.y), pinned, keyed: cs.keyed };
}

/** The index of one of this group's own effects on the patch layer, or null. Uses the host's full scan when it has one. */
export function ownEffectIndex(layer: HostInfo["layer"], key: "color" | "blur" | "force_motion_blur" | "grain" | "degrain", name: string): number | null {
  if (layer.own_effects) return layer.own_effects[key] ?? null;
  return layer.effects.find((e) => e.name === name)?.index ?? null;
}

interface EffectParamRow {
  index: number;
  name: string;
  matchName: string;
  type: string;
  num_keys: number;
  expression: boolean;
  value: number | null;
  samples: Array<{ time: number; value: number }>;
}

interface EffectState {
  layer: { index: number; id: number; name: string };
  effects: Array<{ index: number; name: string; matchName: string }>;
  effects_total?: number;
  effect: { index: number; name: string; matchName: string; params: EffectParamRow[] } | null;
}

async function hostRead<T>(ctx: ToolContext, opId: string, tag: string, host: string, args: unknown, toolName: string, slow = false): Promise<T> {
  const res = await ctx.bridge.evalRaw<T>({
    id: `${opId}_${tag}`,
    script: buildJsxCall(host, args),
    label: `${toolName} ${tag}`,
    mutates: false,
    toolName,
    ...(slow ? { timeoutMs: SLOW_TIMEOUT_MS } : {}),
  });
  return res.result;
}

async function queued<T>(ctx: ToolContext, label: string, opId: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await ctx.queue.run(label, fn);
  } catch (err) {
    if (err instanceof QueueWaitError) throw new BridgeError({ kind: "queued", op_id: opId, message: err.message });
    throw err;
  }
}

const fail = (e: unknown) => ({ ok: false as const, error: e instanceof PlanarError ? e.code : "failed", message: errMessage(e) });

/**
 * The answer when a write after the plate copy fails before it is applied (a
 * guard mismatch, a quarantine, a host refusal, a queue error). The copy and its
 * checkpoint already happened, so it comes back with what was measured and the
 * temp_comp / checkpoint fields instead of a bare error.
 */
function writeFailure(err: unknown, base: Record<string, unknown>, what: string): Record<string, unknown> {
  const kind = err instanceof BridgeError ? err.kind : err instanceof PlanarError ? err.code : "failed";
  const unsure = err instanceof BridgeError && err.kind === "timeout";
  return {
    ...base,
    ok: false,
    applied: false,
    error: kind,
    message: `${what} was not written: ${errMessage(err)}${unsure ? " AE did not answer in time, so the write may still have run: read the layer before trying again." : ""}`,
    ...(unsure ? { write_state: "unknown" } : {}),
  };
}

function isAeBlocked(err: unknown): boolean {
  return err instanceof BridgeError && (err.kind === "timeout" || err.kind === "queued");
}

const BLOCKED_NOTE = "AE stopped responding during a render (often a modal dialog); the remaining frames were not rendered. Check ae_dialogs, then continue.";

function projectNotes(info: HostInfo): string[] {
  const c = info.comp;
  const notes: string[] = [];
  if (c.bits_per_channel !== null && c.bits_per_channel !== 8) {
    notes.push(`The project is ${c.bits_per_channel} bpc: the snapshots the fits come from are 8-bit and colour-managed, so the correction is approximate. Levels values are exact in 8 bpc only.`);
  }
  if (c.linear_blending === true) {
    notes.push("The project blends colours in linear light: a gain fitted on the encoded snapshot is approximate for light-based changes. Prefer effect 'exposure' there.");
  }
  return notes;
}

// ---------- the plate session ----------

interface PlateEnv {
  ctx: ToolContext;
  opId: string;
  toolName: string;
  framesDir: string;
  info: HostInfo;
  /** The temporary comp with the patch (and `hide_layers`) off. */
  plateId: number;
  budget: ReturnType<typeof createRenderBudget>;
  /** Renders and decodes a frame of the plate copy or of the real comp, deleting the file. Counts against the budget. */
  snap(which: "plate" | "comp", time: number): Promise<RgbaImage>;
}

function makeSnap(ctx: ToolContext, opId: string, toolName: string, framesDir: string, budget: ReturnType<typeof createRenderBudget>, pick: (which: "plate" | "comp") => number) {
  let counter = 0;
  return async (which: "plate" | "comp", time: number): Promise<RgbaImage> => {
    const s = await captureCompFrame({ ctx, opId, compId: pick(which), time, frameIndex: counter++, framesDir, toolName });
    budget.spend();
    try {
      return decodePngFile(s.path);
    } finally {
      fs.rmSync(s.path, { force: true });
    }
  };
}

interface TempComp {
  copy_id: number;
  removed: boolean;
  error?: string;
}

interface PlateRunSpec<P, T> {
  toolName: string;
  label: string;
  compId: number;
  expect: ExpectGuard;
  layer: LayerSelector;
  hide?: LayerSelector[];
  maxRenders: number;
  maxSeconds: number;
  /** Read-only work before anything is written. `refuse` stops with that answer and no checkpoint, copy or undo step. */
  prepare: (opId: string, info: HostInfo) => Promise<{ refuse: Record<string, unknown> } | { prep: P }>;
  /** The renders and measuring with the plate copy in place. A throw is caught: the copy is removed either way. */
  body: (env: PlateEnv, prep: P) => Promise<T>;
}

type PlateRun<P, T> =
  | { refused: Record<string, unknown> }
  | { refused?: undefined; opId: string; info: HostInfo; prep: P; value: T | null; bodyError: string | null; temp: TempComp | null; checkpoint: unknown; receipt: unknown; sessionFields: Record<string, unknown> };

type PlateDone<P, T> = Exclude<PlateRun<P, T>, { refused: Record<string, unknown> }>;

/**
 * The guarded flow around a plate copy, in one queue lease: read, prepare,
 * guard, automatic checkpoint, the copy with the patch off (one undo group),
 * the body's renders, removal of the copy (another undo group), receipt.
 * Once the copy exists nothing throws: failures go into the receipt and bodyError.
 */
async function plateRun<P, T>(ctx: ToolContext, spec: PlateRunSpec<P, T>): Promise<PlateRun<P, T>> {
  ctx.quarantine.assertClear();
  const opId = ctx.bridge.newOpId();
  const framesDir = defaultFramesDir();
  const expect: ExpectGuard = { project_path: spec.expect.project_path, comp_id: spec.expect.comp_id ?? spec.compId };
  return queued(ctx, spec.label, opId, async () => {
    ctx.quarantine.assertClear();
    const info = await hostRead<HostInfo>(ctx, opId, "info", "patchfitInfo", { comp_id: spec.compId, layer: spec.layer, ...(spec.hide ? { hide_layers: spec.hide } : {}) }, spec.toolName);
    const comp = { id: info.comp.id, name: info.comp.name, width: info.comp.width, height: info.comp.height };
    if (Number(info.comp.pixel_aspect) > 0 && Math.abs(Number(info.comp.pixel_aspect) - 1) > 1e-6) {
      return { refused: { ok: false, error: "refused", message: `The comp's pixel aspect is ${info.comp.pixel_aspect}, not 1. The patch tools work on square pixels only.`, comp } };
    }
    if (!info.layer.has_video) return { refused: { ok: false, error: "bad_args", message: `Layer "${info.layer.name}" has no video, so it is not a patch.`, comp } };
    if (info.show.length === 0) {
      return { refused: { ok: false, error: "not_found", message: "No other layer is on, so there is no plate under the patch to measure.", comp } };
    }
    if (info.show.length > MAX_PLATE_LAYERS || info.show_truncated) {
      return { refused: { ok: false, error: "refused", message: `${info.show.length} layers would make the plate; the temporary copy takes at most ${MAX_PLATE_LAYERS}. Precompose the plate layers first.`, comp } };
    }
    const prepared = await spec.prepare(opId, info);
    if ("refuse" in prepared) return { refused: prepared.refuse };

    const guard = await verifyTargetGuard(ctx, expect, opId);
    const checkpoint = await autoCheckpoint(ctx, guard, spec.toolName);
    const note: WriteInfo = { opId, toolName: spec.toolName, label: spec.label, expect, checkpoint: checkpoint?.path ?? null };
    const sessionFields = (await noteBeforeWrite(ctx, note)) as Record<string, unknown>;
    fs.mkdirSync(framesDir, { recursive: true });
    const budget = createRenderBudget({ maxRenders: spec.maxRenders, maxSeconds: spec.maxSeconds });

    let bodyError: string | null = null;
    let value: T | null = null;
    let temp: TempComp | null = null;
    try {
      const wrapped = await withIsolatedPlate(
        ctx,
        opId,
        { compId: spec.compId, showLayers: info.show, expect, toolName: spec.toolName, note },
        async (plateId) => {
          const env: PlateEnv = {
            ctx,
            opId,
            toolName: spec.toolName,
            framesDir,
            info,
            plateId,
            budget,
            snap: makeSnap(ctx, opId, spec.toolName, framesDir, budget, (which) => (which === "plate" ? plateId : spec.compId)),
          };
          try {
            return { ok: true as const, v: await spec.body(env, (prepared as { prep: P }).prep) };
          } catch (err) {
            return { ok: false as const, error: errMessage(err), blocked: isAeBlocked(err) };
          }
        }
      );
      temp = wrapped.temp;
      if (wrapped.value.ok) value = wrapped.value.v;
      else bodyError = wrapped.value.blocked ? `${wrapped.value.error}. ${BLOCKED_NOTE}` : wrapped.value.error;
    } catch (err) {
      // The copy was made and the plate session failed around it: report, do not throw.
      const made = (err as { plateTemp?: TempComp } | null)?.plateTemp;
      if (!made) throw err;
      temp = made;
      bodyError = errMessage(err);
    }
    try {
      await noteAfterWrite(ctx, note, { addStep: true });
    } catch {
      // reporting only
    }
    const mism: ReceiptMismatch[] = [];
    if (temp && !temp.removed) {
      mism.push({
        path: "temp_comp",
        expected: "the temporary comp removed",
        actual: temp.error ?? "not removed",
        message: `The temporary comp (id ${temp.copy_id}) was not removed${temp.error ? `: ${temp.error}` : ""}. Delete it in the Project panel; its name starts with "_chroma_plate_".`,
      });
    }
    const receipt = buildReceipt({ before: null, after: { temp_comp: temp }, customMismatches: mism });
    return { opId, info, prep: (prepared as { prep: P }).prep, value, bodyError, temp, checkpoint, receipt, sessionFields };
  });
}

/** What every plate-run result carries about the temporary comp and the write behind it. */
function plateTail<P, T>(run: PlateDone<P, T>): Record<string, unknown> {
  return {
    temp_comp: run.temp ? { copy_removed: run.temp.removed, ...(run.temp.error ? { error: run.temp.error } : {}) } : null,
    checkpoint: run.checkpoint,
    receipt: run.receipt,
    ...run.sessionFields,
  };
}

/** Renders composites of the real comp in a read-only lease. Nothing in the project changes. */
async function compLease<T>(ctx: ToolContext, toolName: string, label: string, compId: number, budgetOpts: { maxRenders: number; maxSeconds: number }, fn: (snap: (time: number) => Promise<RgbaImage>, opId: string) => Promise<T>): Promise<T> {
  const opId = ctx.bridge.newOpId();
  const framesDir = defaultFramesDir();
  return queued(ctx, label, opId, async () => {
    fs.mkdirSync(framesDir, { recursive: true });
    const budget = createRenderBudget(budgetOpts);
    const snap = makeSnap(ctx, opId, toolName, framesDir, budget, () => compId);
    return fn((time) => snap("comp", time), opId);
  });
}

/** The region's track, resolved inside the lease and saved so a continued call uses the same one. */
async function resolveTrack(ctx: ToolContext, opId: string, info: HostInfo, track: unknown, refTime: number): Promise<PlanarTrack | null> {
  if (track === undefined || track === null) return null;
  // A stored track is read, never written back here: the re-based copy below is a copy.
  const src = { ...(track as Record<string, unknown>), ref_time: refTime } as Parameters<typeof resolveTrackSource>[3];
  const t = await resolveTrackSource(ctx, opId, info.comp.id, src);
  if (Math.abs(t.comp_size[0] - info.comp.width) > 0.5 || Math.abs(t.comp_size[1] - info.comp.height) > 0.5) {
    throw new PlanarError("refused", `The track was made in a ${t.comp_size[0]}x${t.comp_size[1]} comp and this one is ${info.comp.width}x${info.comp.height}: the points are in comp pixels, so the sizes must match.`);
  }
  const rf = frameAt(t, refTime);
  if (!rf || !rf.ok || !rf.H) {
    throw new PlanarError("bad_args", `The track has no solved motion at ref_time ${r4(refTime)} s, the frame the patch holds, so the shot cannot be re-based on it. Pass a ref_time inside the tracked range (omit it to use the track's own reference frame).`);
  }
  return t;
}

/** ref_time as given, else the stored track's own reference frame (the frame its motion is the identity at), else undefined (the first frame of the range). */
function refTimeFor(track: unknown, refTime: number | undefined): number | undefined {
  if (refTime !== undefined) return refTime;
  const nested = track && typeof track === "object" ? (track as { ref_time?: unknown }).ref_time : undefined;
  if (typeof nested === "number" && Number.isFinite(nested)) return nested;
  const id = track && typeof track === "object" ? (track as { track_id?: unknown }).track_id : undefined;
  if (typeof id === "string" && id) {
    const t = loadTrack(id);
    if (t && Number.isFinite(t.ref_time)) return t.ref_time;
  }
  return undefined;
}

function regionPolygon(region: unknown): Pt[] {
  return regionToPolygon(region as RegionSpec);
}

function writePng(framesDir: string, tag: string, compId: number, png: PNG): string {
  fs.mkdirSync(framesDir, { recursive: true });
  const file = path.join(framesDir, `${tag}_c${compId}_${crypto.randomBytes(4).toString("hex")}.png`);
  fs.writeFileSync(file, encodePng(png));
  return file;
}

// ---------- chunk state ----------

const STATE_ID = /^[A-Za-z0-9_-]{1,80}$/;

export function stateDir(): string {
  return path.join(path.dirname(defaultFramesDir()), "patchfit");
}

export function saveState(id: string, state: unknown): string {
  if (!STATE_ID.test(id)) throw new Error(`Bad continue id "${id}"`);
  const dir = stateDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, file);
  try {
    const entries = fs
      .readdirSync(dir)
      .filter((n) => n.endsWith(".json"))
      .map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const old of entries.slice(KEEP_STATES)) fs.rmSync(path.join(dir, old.n), { force: true });
  } catch {
    // Pruning is housekeeping; it must not lose the state just saved.
  }
  return file;
}

export function loadState<T>(id: string): T | null {
  if (!STATE_ID.test(id)) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(stateDir(), `${id}.json`), "utf8")) as T;
  } catch {
    return null;
  }
}

// ---------- schemas ----------

const LayerSel = LayerSelectorSchema;
const PATCH_LAYER_TEXT = "The patch layer: the frozen or cloned plate, the removal comp or the insert. It gets the effects; it is switched off, with `hide_layers`, in the temporary plate copy.";
const HIDE_TEXT = "More layers to switch off in the plate copy (other layers of the patch: a clean-plate precomp under a cover, a shadow layer). The patch layer itself is always off.";
const REGION_TEXT = "Where the patch is, in comp pixels, AS IT LOOKS AT `ref_time` (the frame the patch holds). A rect, ellipse or polygon.";
const TRACK_TEXT =
  "How the shot moves: a track source (track_id from ae_track_multi / ae_track_read, nulls, corner_pin, tracker or transform). Its motion is reference frame -> frame and is re-based so `ref_time` is the identity. Without it the shot is taken as locked off.";
const REF_TEXT = "The frame the patch holds (seconds): the region is read as drawn there, the track is re-based so it is the identity, and the colour fit is anchored there. Default: the track's own reference frame when `track` is a track_id, else the first frame of the range. Refused where the track has no solved motion at that frame.";

const renderFields = (renders: number, extra = "") => ({
  max_renders: z.number().int().min(4).max(600).default(renders).describe(`The most renders one call makes for measuring (each frame is one), default ${renders}.${extra}`),
  max_seconds: z.number().min(10).max(540).default(90).describe("The most seconds one call renders for (it holds the AE queue). Default 90."),
});

export const AePatchColorMatchSchema = z
  .object({
    comp_id: z.number().int().describe("The composition that holds the patch."),
    layer: LayerSel.optional().describe(`${PATCH_LAYER_TEXT} Required unless continue_id is given.`),
    hide_layers: z.array(LayerSel).max(50).optional().describe(HIDE_TEXT),
    region: RegionShapeSchema.optional().describe(`${REGION_TEXT} Required unless continue_id is given.`),
    track: TrackSourceSchema.optional().describe(TRACK_TEXT),
    ref_time: z.number().min(0).optional().describe(REF_TEXT),
    start: z.number().min(0).optional().describe("First time of the range, seconds. Default the work area's start."),
    end: z.number().min(0).optional().describe("Last time of the range, seconds. Default the work area's end."),
    step: z.number().int().min(1).max(1000).default(1).describe("Measure every Nth frame (1 = every frame). The keys between are interpolated. At most 3000 frames in total."),
    ring_px: z.number().min(3).max(200).default(12).describe("Width in comp pixels of the ring around the patch that is fitted. Default 12."),
    ring_gap_px: z.number().min(0).max(50).default(2).describe("Gap in comp pixels between the patch edge and the ring. Default 2."),
    smooth_frames: z.number().min(0).max(60).default(3).describe("Gaussian smoothing of the curves, in frames. Default 3; 0 keeps every wobble."),
    min_ring_visible: z.number().min(0.1).max(1).default(0.4).describe("A frame where less of the ring than this is in view gets no key (interpolated) and is listed. Default 0.4."),
    effect: z
      .enum(["levels", "exposure"])
      .default("levels")
      .describe("levels: Levels (Individual Controls), per channel Input/Output Black/White. exposure: Exposure with Individual Channels, gain in stops; prefer it in linear projects."),
    bypass_linear: z.boolean().default(true).describe("Exposure only: switch on 'Bypass Linear Light Conversion' so a gain fitted on the encoded snapshot maps directly. Default true."),
    replace_existing: z.boolean().default(false).describe(`Replace an earlier "${COLOR_EFFECT_NAME}" effect on the patch. Without it that effect refuses the write. Effects the tool did not make are never touched.`),
    verify: z.boolean().default(true).describe("After the write, render the composite on up to 8 frames (the worst drift frames among them) and report the seam colour difference before and after. Default true."),
    dry_run: z.boolean().default(false).describe("Measure and return the curves, the flicker of the shot and a graph, and write nothing to the patch. The temporary plate comp is still made and removed (needs `expect`)."),
    continue_id: z.string().min(1).max(80).optional().describe("Carry on a measurement that returned continue_id (the same comp; the other arguments come from the stored state). The keys are written by the call that finishes it."),
    ...renderFields(150, " The reference render counts, and at least one pending frame is always measured so a continue_id makes progress. The call that finishes also renders up to 8 composite frames before the write and 8 after it for the verify, on top of this budget."),
    expect: ExpectSchema,
  })
  .refine((v) => v.continue_id !== undefined || (v.layer !== undefined && v.region !== undefined), { message: "Give `layer` and `region`, or continue_id." });

export const AePatchGrainSchema = z
  .object({
    comp_id: z.number().int().describe("The composition that holds the patch."),
    layer: LayerSel.describe(PATCH_LAYER_TEXT),
    hide_layers: z.array(LayerSel).max(50).optional().describe(HIDE_TEXT),
    region: RegionShapeSchema.describe(REGION_TEXT),
    track: TrackSourceSchema.optional().describe(TRACK_TEXT),
    ref_time: z.number().min(0).optional().describe(REF_TEXT),
    start: z.number().min(0).optional().describe("First time of the range the sample frames come from, seconds. Default the work area's start."),
    end: z.number().min(0).optional().describe("Last time of that range. Default the work area's end."),
    samples: z.number().int().min(1).max(6).default(3).describe("Frames measured (each also renders the next frame for the temporal grain). Default 3."),
    ring_px: z.number().min(6).max(200).default(24).describe("Width in comp pixels of the plate ring the grain is measured in. Default 24."),
    ring_gap_px: z.number().min(0).max(50).default(2).describe("Gap in comp pixels between the patch edge and the ring. Default 2."),
    method: z.enum(["add", "match"]).default("add").describe("add: Add Grain ('VISINF Grain Implant') set from the measured sigma. match: Match Grain ('VISINF Grain Duplication') sampling `plate_layer`, which may pick a poor sample area."),
    plate_layer: LayerSel.optional().describe("Match Grain only: the layer whose grain is copied (the plate)."),
    degrain: z.enum(["none", "median", "remove_grain"]).default("none").describe("Remove the patch's own frozen grain first: Median radius 1, or Remove Grain with Final Output. Use it when the patch's grain is stronger than the plate's."),
    grain_size: z.number().min(0.1).max(10).default(1).describe("Add Grain's Size. Its unit is unmeasured in this build, so it is the one setting not derived from the plate; the default is the effect's own."),
    intensity: z.number().min(0).max(20).optional().describe("Start the tuning from this Intensity instead of the default start (the calibration curve from the measured sigma for method 'add'; 1 for method 'match'). The tuning rounds still adjust it."),
    viewing_mode_index: z.number().int().min(1).max(10).optional().describe("The menu item of 'Final Output' in the grain effect's Viewing Mode (built-in guess: Add Grain 3, Match Grain 5), when it is wrong for this AE. Checked against the menu's range before it is set."),
    degrain_viewing_mode_index: z.number().int().min(1).max(10).optional().describe("The menu item of 'Final Output' in Remove Grain's Viewing Mode (built-in guess 4), when degrain is 'remove_grain' and the guess is wrong for this AE."),
    rounds: z.number().int().min(0).max(3).default(2).describe("Tuning rounds after the first write (each: render, measure, scale Intensity by the ratio, its own undo step). Default 2, at most 3."),
    tolerance: z.number().min(0.02).max(0.5).default(0.1).describe("Stop tuning when the patch's grain (its spatial sigma, or its temporal sigma when degrain is 'none' and the plate has temporal grain) is within this share of the plate's. Default 0.1."),
    min_sigma: z.number().min(0.1).max(10).default(0.6).describe("A plate whose grain sigma is under this (gray levels of 255) counts as clean and gets no grain. Default 0.6."),
    replace_existing: z.boolean().default(false).describe(`Replace an earlier "<patch> GRAIN" layer and "Chroma degrain" effect made by this tool.`),
    dry_run: z.boolean().default(false).describe("Measure and report; add nothing. The temporary plate comp is still made and removed (needs `expect`)."),
    ...renderFields(60, " The tuning rounds render on top of this: each of the rounds + 1 measurements renders up to 2 * the sampled frames + 2 composite frames, with its own 60 s budget."),
    expect: ExpectSchema,
  })
  .refine((v) => v.method !== "match" || v.plate_layer !== undefined, { message: "method 'match' needs plate_layer." });

export const AePatchFinishSchema = z.object({
  comp_id: z.number().int().describe("The composition that holds the patch."),
  layer: LayerSel.describe(PATCH_LAYER_TEXT),
  hide_layers: z.array(LayerSel).max(50).optional().describe(HIDE_TEXT),
  region: RegionShapeSchema.describe(REGION_TEXT),
  track: TrackSourceSchema.optional().describe(TRACK_TEXT),
  ref_time: z.number().min(0).optional().describe(REF_TEXT),
  start: z.number().min(0).optional().describe("First time of the range the sample frames come from, seconds. Default the work area's start."),
  end: z.number().min(0).optional().describe("Last time of that range. Default the work area's end."),
  samples: z.number().int().min(1).max(8).default(5).describe("Frames measured (two renders each: the composite and the plate). Default 5."),
  ring_px: z.number().min(6).max(200).default(24).describe("Width in comp pixels of the plate ring the sharpness is measured in. Default 24."),
  ring_gap_px: z.number().min(0).max(50).default(2).describe("Gap in comp pixels between the patch edge and the ring. Default 2."),
  sharpness: z.boolean().default(true).describe("Match the patch's sharpness to the plate's with a keyed or static Gaussian Blur."),
  edge: z.boolean().default(true).describe("Raise the patch layer's mask feather (and keep expansion at half of it) when the seam is visible. Needs masks on the patch layer."),
  motion_blur: z.boolean().default(true).describe("Match motion blur from the track's speed and the shutter: layer motion blur for a patch moved by its transform, CC Force Motion Blur for one moved by a pin."),
  quality: z.boolean().default(true).describe("Set the patch layer's sampling quality to bicubic, frame blending off and quality best."),
  seam_max: z.number().min(1).max(20).default(1.5).describe("Seam score above which the edge is feathered (1 is plain texture). Default 1.5."),
  max_feather: z.number().min(1).max(500).default(40).describe("The most mask feather, in comp pixels (written in the layer's own pixels: divided by the layer's scale). Default 40."),
  max_blur_sigma: z.number().min(0.5).max(20).default(4).describe("The most Gaussian sigma the sharpness match may use, in comp pixels (written in the layer's own pixels: divided by the layer's scale). Default 4."),
  shutter_angle: z.number().min(0).max(720).optional().describe("Shutter angle of the plate's blur, degrees. Default the comp's. A comp stores whole degrees, so the value written to the comp is rounded. The shutter phase is not changed."),
  allow_comp_change: z.boolean().default(false).describe("Let the tool switch the comp's motion blur on and change its shutter angle. Both affect every layer, so by default they are only reported."),
  replace_existing: z.boolean().default(false).describe(`Replace an earlier "${BLUR_EFFECT_NAME}" or "Chroma force motion blur" effect; the new blur combines the earlier one's amount at the reference frame with the extra it measures (square root of the sum of squares of the two sigmas) and replaces it.`),
  dry_run: z.boolean().default(false).describe("Measure and report the plan; write nothing. The temporary plate comp is still made and removed (needs `expect`)."),
  ...renderFields(30),
  expect: ExpectSchema,
});

export type AePatchColorMatchArgs = z.infer<typeof AePatchColorMatchSchema>;
export type AePatchGrainArgs = z.infer<typeof AePatchGrainSchema>;
export type AePatchFinishArgs = z.infer<typeof AePatchFinishSchema>;

// ---------- ae_patch_color_match ----------

interface ColorStored {
  version: 1;
  comp_id: number;
  layer: LayerSelector;
  hide_layers?: LayerSelector[];
  region: unknown;
  track_id: string | null;
  ref_time: number;
  times: number[];
  step: number;
  range: [number, number];
  ring_px: number;
  ring_gap_px: number;
  smooth_frames: number;
  min_ring_visible: number;
  effect: "levels" | "exposure";
  bypass_linear: boolean;
  replace_existing: boolean;
  verify: boolean;
  fits: Array<FrameFit | null>;
  /** Failed (non-blocking) renders per time index; a frame is given up on after MAX_RENDER_RETRIES. */
  retries?: number[];
  /** The stored track this measurement was re-based from, when track_id is a re-based copy of it (so every call can report the copy). */
  rebased_from?: string | null;
}

const MAX_RENDER_RETRIES = 3;

interface ColorPrep {
  stored: ColorStored;
  continueId: string;
  track: PlanarTrack | null;
  poly: Pt[];
  resumed: boolean;
}

interface ColorBody {
  complete: boolean;
  measured: number;
  skippedByBudget: number;
  lost: number;
  renderFailed: number;
  blockedNote: string | null;
  ringMeanRgb: [number, number, number];
  scale: number;
  before: VerifyRow[];
  verifyTimes: number[];
  curves: CurveSet | null;
}

interface VerifyRow {
  time: number;
  diff?: [number, number, number];
  mean_abs?: number;
  luma?: number;
  skipped?: string;
}

async function verifyRows(
  snap: (time: number) => Promise<RgbaImage>,
  times: number[],
  poly: Pt[],
  track: PlanarTrack | null,
  o: { gapPx: number; ringPx: number; compWidth: number }
): Promise<VerifyRow[]> {
  const rows: VerifyRow[] = [];
  for (const t of times) {
    const at = polygonAtT(poly, track, t);
    if (!at) {
      rows.push({ time: r4(t), skipped: "the track lost the plate at this time" });
      continue;
    }
    try {
      const img = await snap(t);
      await yieldLoop();
      const s = img.width / o.compWidth;
      const seam = seamColour(img, scalePoly(at.poly, s), o.gapPx * s, o.ringPx * s);
      rows.push(seam ? { time: r4(t), ...seam } : { time: r4(t), skipped: "the seam bands hold too few pixels" });
    } catch (err) {
      rows.push({ time: r4(t), skipped: errMessage(err) });
      if (isAeBlocked(err)) break;
    }
  }
  return rows;
}

const meanAbsOf = (rows: VerifyRow[]): number | null => {
  const v = rows.filter((r) => r.mean_abs !== undefined).map((r) => r.mean_abs as number);
  return v.length ? r4(mean(v)) : null;
};

/** The device-independent pieces of the graph: gain per channel over the measured times. */
function gainGraph(framesDir: string, compId: number, times: number[], curves: CurveSet): string | null {
  try {
    const png = drawSeriesGraph(
      [
        { name: "red gain", times, values: curves.gain[0] },
        { name: "green gain", times, values: curves.gain[1] },
        { name: "blue gain", times, values: curves.gain[2] },
      ],
      { width: 720, height: 320 }
    );
    return writePng(framesDir, "patchfit_gain", compId, png);
  } catch {
    return null;
  }
}

function evenly<T>(items: T[], cap: number): { items: T[]; truncated: boolean } {
  if (items.length <= cap) return { items, truncated: false };
  const out: T[] = [];
  for (let i = 0; i < cap; i++) out.push(items[Math.round((i * (items.length - 1)) / (cap - 1))]);
  return { items: out, truncated: true };
}

export function colorMismatches(
  mode: "levels" | "exposure",
  keys: KeySet,
  before: unknown,
  after: unknown,
  written: Record<string, unknown>
): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const b = before as EffectState | null;
  const a = after as EffectState | null;
  if (!a) return m;
  if (b) {
    // The true counts: the lists are cut at 500, so a layer with that many effects does not look wrong.
    const wasOurs = b.effect !== null;
    const bCount = b.effects_total ?? b.effects.length;
    const aCount = a.effects_total ?? a.effects.length;
    expectThat(m, aCount === bCount + (wasOurs ? 0 : 1), "effects", bCount + (wasOurs ? 0 : 1), aCount, "The effect count is not what the write should leave");
  }
  const fx = a.effect;
  if (!fx) {
    m.push({ path: "effect", expected: COLOR_EFFECT_NAME, actual: undefined, message: `The "${COLOR_EFFECT_NAME}" effect is not on the layer` });
    return m;
  }
  const slot = written.slot as { wanted?: number } | undefined;
  if (slot && typeof slot.wanted === "number") expectThat(m, fx.index === slot.wanted, "effect.index", slot.wanted, fx.index, "The effect is not at its place in the patch effect order");
  const scale = typeof written.scale === "number" && written.scale > 0 ? written.scale : 1;
  const roles = mode === "levels" ? ["in_black", "in_white", "out_black", "out_white"] : ["exposure", "offset"];
  const labels = { red: "Red", green: "Green", blue: "Blue" } as const;
  const suffix: Record<string, string> = { in_black: "Input Black", in_white: "Input White", out_black: "Output Black", out_white: "Output White", exposure: "Exposure", offset: "Offset" };
  const wanted: Record<string, { names: string[] }> = {};
  for (const ch of CHANNEL_KEYS) for (const r of roles) wanted[`${ch}.${r}`] = { names: [`${labels[ch]} ${suffix[r]}`] };
  const where = resolveEffectParams(fx.params, wanted);
  const wantKeys = keys.times.length > 1 ? keys.times.length : 0;
  if (mode === "exposure") {
    // Individual Channels and the linear-light switch: without them the per-channel keys do nothing, or do the wrong thing.
    const sw = resolveEffectParams(fx.params, { channels: { names: ["Channels"] }, bypass: { names: ["Bypass Linear Light Conversion"] } });
    const checkSwitch = (key: "channels" | "bypass", wrote: unknown, label: string) => {
      if (typeof wrote !== "number") return;
      const idx = sw[key];
      const p = idx === null ? undefined : fx.params.find((q) => q.index === idx);
      if (!p) {
        m.push({ path: `effect.${key}`, expected: label, actual: undefined, message: `The "${label}" parameter is not on the effect` });
        return;
      }
      expectThat(m, p.value !== null && Math.abs(p.value - wrote) < 1e-6, `effect.${key}`, wrote, p.value, `"${label}" does not hold the value that was written`);
    };
    checkSwitch("channels", written.channels_written, "Channels");
    checkSwitch("bypass", written.bypass_written, "Bypass Linear Light Conversion");
  }
  for (const ch of CHANNEL_KEYS) {
    for (const r of roles) {
      const idx = where[`${ch}.${r}`];
      const p = idx === null ? undefined : fx.params.find((q) => q.index === idx);
      if (!p) {
        m.push({ path: `effect.${ch}.${r}`, expected: wanted[`${ch}.${r}`].names[0], actual: undefined, message: "The parameter is not on the effect" });
        continue;
      }
      expectThat(m, p.num_keys === wantKeys, `effect.${ch}.${r}.num_keys`, wantKeys, p.num_keys, "Key count differs");
      const series = keys.series[ch][r];
      const tol = 2e-3;
      for (const s of p.samples) {
        const want = valueAtLinear(keys.times, series, s.time);
        const got = mode === "levels" ? s.value / scale : s.value;
        if (Math.abs(got - want) > tol) {
          m.push({ path: `effect.${ch}.${r}@${r4(s.time)}`, expected: r4(want), actual: r4(got), message: "Value at this time differs from the fit" });
          break;
        }
      }
    }
  }
  return m;
}

async function colorMatchHandler(args: AePatchColorMatchArgs, ctx: ToolContext): Promise<Record<string, unknown>> {
  const toolName = "ae_patch_color_match";
  const label = `ae_patch_color_match(${args.comp_id})`;
  const framesDir = defaultFramesDir();

  let resumed: ColorStored | null = null;
  if (args.continue_id) {
    resumed = loadState<ColorStored>(args.continue_id);
    if (!resumed || resumed.version !== 1) return { ok: false, error: "not_found", message: `No stored colour match "${args.continue_id}" to continue (the store keeps the newest ${KEEP_STATES}).` };
    if (resumed.comp_id !== args.comp_id) return { ok: false, error: "bad_args", message: `Colour match ${args.continue_id} was made in comp ${resumed.comp_id}, not ${args.comp_id}.` };
  }
  const layerSel = (resumed?.layer ?? args.layer) as LayerSelector;
  const hide = resumed?.hide_layers ?? args.hide_layers;
  const effectMode = resumed?.effect ?? args.effect;

  const run = await plateRun<ColorPrep, ColorBody>(ctx, {
    toolName,
    label,
    compId: args.comp_id,
    expect: args.expect,
    layer: layerSel,
    hide,
    maxRenders: args.max_renders,
    maxSeconds: args.max_seconds,
    prepare: async (opId, info) => {
      const comp = { id: info.comp.id, name: info.comp.name, width: info.comp.width, height: info.comp.height };
      if (!args.dry_run) {
        if (info.layer.locked) return { refuse: { ok: false, error: "bad_args", message: `Layer "${info.layer.name}" is locked; unlock it first.`, comp } };
        const own = ownEffectIndex(info.layer, "color", COLOR_EFFECT_NAME);
        const replace = resumed?.replace_existing ?? args.replace_existing;
        if (own !== null && !replace) {
          return { refuse: { ok: false, error: "bad_args", message: `Layer "${info.layer.name}" already has "${COLOR_EFFECT_NAME}" (effect ${own}). Pass replace_existing to replace it, or dry_run to measure only.`, comp } };
        }
      }
      try {
        if (resumed) {
          const track = resumed.track_id ? loadTrack(resumed.track_id) : null;
          if (resumed.track_id && !track) throw new PlanarError("not_found", `The track saved for this measurement (${resumed.track_id}) is gone from the store.`);
          return { prep: { stored: resumed, continueId: args.continue_id as string, track, poly: regionPolygon(resumed.region), resumed: true } };
        }
        const plan = planFrameTimes({
          fps: info.comp.fps,
          duration: info.comp.duration,
          workStart: info.comp.work_area_start,
          workDuration: info.comp.work_area_duration,
          start: args.start,
          end: args.end,
          step: args.step,
          refTime: refTimeFor(args.track, args.ref_time),
        });
        const track = await resolveTrack(ctx, opId, info, args.track, plan.ref_time);
        let trackId: string | null = null;
        let rebasedFrom: string | null = null;
        if (track) {
          const srcId = args.track && typeof args.track === "object" ? (args.track as { track_id?: string }).track_id : undefined;
          if (srcId) {
            // A stored track is the user's: never save the re-based copy over it. The same reference frame needs no copy; another gets its own id (without the tracker's resume state).
            const orig = loadTrack(srcId);
            if (orig && Math.abs(orig.ref_time - track.ref_time) < 1e-6) {
              trackId = srcId;
            } else {
              const copy: PlanarTrack = { ...track, track_id: newTrackId(), tracking: undefined };
              saveTrack(copy);
              trackId = copy.track_id;
              rebasedFrom = srcId;
            }
          } else {
            trackId = track.track_id;
            saveTrack(track);
          }
        }
        const stored: ColorStored = {
          version: 1,
          comp_id: args.comp_id,
          layer: { id: info.layer.id },
          hide_layers: info.hidden.map((h) => ({ id: h.id })),
          region: args.region,
          track_id: trackId,
          rebased_from: rebasedFrom,
          ref_time: plan.ref_time,
          times: plan.times,
          step: plan.step,
          range: plan.range,
          ring_px: args.ring_px,
          ring_gap_px: args.ring_gap_px,
          smooth_frames: args.smooth_frames,
          min_ring_visible: args.min_ring_visible,
          effect: args.effect,
          bypass_linear: args.bypass_linear,
          replace_existing: args.replace_existing,
          verify: args.verify,
          fits: plan.times.map(() => null),
        };
        const id = `pfc_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
        return { prep: { stored, continueId: id, track, poly: regionPolygon(args.region), resumed: false } };
      } catch (err) {
        if (err instanceof PlanarError) return { refuse: { ok: false, error: err.code, message: err.message, comp } };
        throw err;
      }
    },
    body: async (env, prep) => {
      const st = prep.stored;
      const comp = env.info.comp;
      const refPlate = await env.snap("plate", st.ref_time);
      await yieldLoop();
      const scale = refPlate.width / comp.width;
      const polyPng = scalePoly(prep.poly, scale);
      const ring = makeRingSet(refPlate.width, refPlate.height, polyPng, st.ring_gap_px * scale, (st.ring_gap_px + st.ring_px) * scale);
      await yieldLoop();
      const ringStats = maskedStats(refPlate, ring.mask);
      let skippedByBudget = 0;
      let lost = 0;
      let renderFailed = 0;
      let attempted = 0;
      let measuredNow = 0;
      let blockedNote: string | null = null;
      for (let i = 0; i < st.times.length; i++) {
        if (st.fits[i]) continue;
        const t = st.times[i];
        const H = hAt(prep.track, t);
        if (Math.abs(t - st.ref_time) < 1e-6) {
          st.fits[i] = { ok: true, gain: [1, 1, 1], offset: [0, 0, 0], rms: 0, pixels: ring.idx.length, visible: 1 };
          continue;
        }
        if (!H) {
          st.fits[i] = fitFrame(refPlate, refPlate, ring, null, scale, { minVisible: st.min_ring_visible });
          lost++;
          continue;
        }
        // The reference render already counts against the budget: always try one pending frame per call so a continue_id makes progress.
        if (env.budget.exhausted() && attempted > 0) {
          skippedByBudget++;
          continue;
        }
        attempted++;
        try {
          const plateT = await env.snap("plate", t);
          await yieldLoop();
          st.fits[i] = fitFrame(refPlate, plateT, ring, H, scale, { minVisible: st.min_ring_visible });
          measuredNow++;
          await yieldLoop();
        } catch (err) {
          if (isAeBlocked(err)) {
            blockedNote = BLOCKED_NOTE;
            skippedByBudget += st.times.length - i;
            break;
          }
          // Not a verdict about the ring: leave the frame pending so a later chunk renders it again, up to MAX_RENDER_RETRIES.
          const retries = (st.retries ??= st.times.map(() => 0));
          retries[i] = (retries[i] ?? 0) + 1;
          renderFailed++;
          if (retries[i] >= MAX_RENDER_RETRIES) {
            st.fits[i] = { ok: false, reason: `render failed ${retries[i]} times: ${errMessage(err)}`, gain: [1, 1, 1], offset: [0, 0, 0], rms: 0, pixels: 0, visible: 0 };
          } else {
            skippedByBudget++;
          }
        }
      }
      const complete = st.fits.every((f) => f !== null);
      saveState(prep.continueId, st);
      const curves = complete ? buildCurves(st.fits, { smoothFrames: st.smooth_frames, step: st.step, refIndex: st.times.findIndex((t) => Math.abs(t - st.ref_time) < 1e-6) }) : null;
      let before: VerifyRow[] = [];
      let verifyTimes: number[] = [];
      if (complete && curves && !args.dry_run && st.verify) {
        const dev = st.times.map((_, i) => Math.max(...[0, 1, 2].map((c) => Math.abs(curves.gain[c][i] - 1) + Math.abs(curves.offset[c][i]))));
        verifyTimes = pickVerifyTimes(st.times, dev, st.ref_time, 8);
        const vb = createRenderBudget({ maxRenders: 8, maxSeconds: 60 });
        const snapV = makeSnap(ctx, env.opId, toolName, env.framesDir, vb, () => args.comp_id);
        before = await verifyRows((time) => snapV("comp", time), verifyTimes, prep.poly, prep.track, { gapPx: st.ring_gap_px, ringPx: st.ring_px, compWidth: comp.width });
      }
      return {
        complete,
        measured: measuredNow,
        skippedByBudget,
        lost,
        renderFailed,
        blockedNote,
        ringMeanRgb: ringStats.mean_rgb,
        scale,
        before,
        verifyTimes,
        curves,
      };
    },
  });

  if (run.refused) return run.refused;
  const tail = plateTail(run);
  const body = run.value;
  if (!body) return { op_id: run.opId, applied: true as const, ok: false, error: "measure_failed", message: run.bodyError ?? "the measurement did not run", ...rebasedTrackField(run.prep.stored), ...tail };
  return finishColor(ctx, args, run, body, tail, { toolName, label, framesDir, effectMode });
}

/** The re-based copy of a stored track this measurement runs on, for every return (the copy is saved before the measurement starts). */
function rebasedTrackField(st: ColorStored): Record<string, unknown> {
  if (!st.rebased_from || !st.track_id) return {};
  return { rebased_track: { track_id: st.track_id, from: st.rebased_from } };
}

/** Frames the track lost, over every chunk (counted from the stored fits, not the current call). */
function lostTrackFrames(st: ColorStored): number {
  return st.fits.filter((f) => f !== null && !f.ok && f.reason === LOST_REASON).length;
}

async function finishColor(
  ctx: ToolContext,
  args: AePatchColorMatchArgs,
  run: PlateDone<ColorPrep, ColorBody>,
  body: ColorBody,
  tail: Record<string, unknown>,
  o: { toolName: string; label: string; framesDir: string; effectMode: "levels" | "exposure" }
): Promise<Record<string, unknown>> {
  const info = run.info;
  const st = run.prep.stored;
  const notes = projectNotes(info);
  if (body.blockedNote) notes.push(body.blockedNote);
  const done = st.fits.filter((f) => f !== null).length;
  const project = { bits_per_channel: info.comp.bits_per_channel, linear_blending: info.comp.linear_blending, working_space: info.comp.working_space, linearize_working_space: info.comp.linearize_working_space };
  const header = {
    ok: true as const,
    op_id: run.opId,
    tool: o.toolName,
    dry_run: args.dry_run,
    layer: { index: info.layer.index, id: info.layer.id, name: info.layer.name },
    project,
    range: st.range,
    ref_time: r4(st.ref_time),
    step: st.step,
    ...rebasedTrackField(st),
    ...tail,
  };
  if (st.rebased_from && st.track_id) {
    notes.push(`track_id ${st.rebased_from} has another reference frame than ref_time, so a re-based copy was saved as ${st.track_id} (the original is untouched; the copy takes a slot among the newest 200 stored tracks, and older tracks are pruned past that). This measurement uses the copy.`);
  }
  if (!body.complete) {
    const id = run.prep.continueId;
    notes.push(`Measured ${done} of ${st.times.length} frames. Call again with continue_id to carry on; the keys are written by the call that finishes.`);
    return {
      ...header,
      complete: false,
      continue_id: id,
      progress: { measured: done, of: st.times.length, this_call: body.measured, lost_track_frames: lostTrackFrames(st), render_failures_this_call: body.renderFailed },
      budget: { max_renders: args.max_renders, max_seconds: args.max_seconds },
      notes,
    };
  }
  const curves = body.curves;
  const unmeasured = st.times.map((t, i) => ({ t, f: st.fits[i] })).filter((x) => !x.f || !x.f.ok);
  if (!curves) {
    return {
      ...header,
      complete: true,
      ok: false,
      error: "not_measurable",
      message: "Fewer than two frames could be fitted (the ring was out of view, clipped or the track lost the plate). Widen ring_px, check the track and the region, or lower min_ring_visible.",
      unmeasured: evenly(unmeasured.map((x) => ({ time: r4(x.t), reason: x.f?.reason ?? "not measured" })), 50).items,
    };
  }
  const mode = o.effectMode;
  const linearPath = mode === "exposure" && st.bypass_linear === false;
  const keys = buildKeys(st.times, curves, mode, { linear: linearPath });
  const dev = [0, 1, 2].map((c) => Math.max(...curves.gain[c].map((g) => Math.abs(g - 1))));
  const offDev = [0, 1, 2].map((c) => Math.max(...curves.offset[c].map((v) => Math.abs(v))));
  const lumaW = [0.2126, 0.7152, 0.0722];
  const lumaSeries = st.times.map((_, i) => lumaW.reduce((s, w, c) => s + w * (curves.gain[c][i] * body.ringMeanRgb[c] + curves.offset[c][i]), 0));
  const curveRows = st.times.map((t, i) => ({
    time: r4(t),
    gain: [r4(curves.gain[0][i]), r4(curves.gain[1][i]), r4(curves.gain[2][i])],
    offset: [r4(curves.offset[0][i]), r4(curves.offset[1][i]), r4(curves.offset[2][i])],
    measured: st.fits[i] !== null && (st.fits[i] as FrameFit).ok,
  }));
  const shown = evenly(curveRows, OUT_CAP);
  const graph = gainGraph(o.framesDir, args.comp_id, st.times, curves);
  const result: Record<string, unknown> = {
    ...header,
    complete: true,
    effect_mode: mode,
    measured: {
      frames: st.times.length,
      usable: curves.usable,
      unmeasured: evenly(unmeasured.map((x) => ({ time: r4(x.t), reason: x.f?.reason ?? "not measured" })), 50).items,
      unmeasured_count: unmeasured.length,
      lost_track_frames: lostTrackFrames(st),
    },
    drift: {
      max_gain_change: dev.map(r4),
      max_offset: offDev.map(r4),
      flicker_luma_swing: r4(Math.max(...lumaSeries) - Math.min(...lumaSeries)),
      no_drift: keys.noDrift,
    },
    curves: { samples: shown.items, truncated: shown.truncated },
    keys: { count: keys.constant ? 1 : keys.times.length, constant: keys.constant, clamped: keys.clamped },
    ...(graph ? { graph_path: graph } : {}),
    notes,
  };
  if (mode === "levels") notes.push("Levels maps encoded values: Output Black/White come from the fitted offset and gain (the input range is narrowed when the gain would push the line out of the 0..1 square).");
  if (mode === "exposure") {
    if (linearPath) {
      notes.push(
        "Exposure runs with its linear-light conversion on (bypass_linear false): the gain fitted on encoded values was converted to stops of linear light as 2.2 x log2(gain)." +
          (keys.offsetDropped ? " The fitted offset has no exact linear counterpart and was not written (Offset stays 0)." : "")
      );
    } else {
      notes.push("Exposure runs with 'Bypass Linear Light Conversion' on: the stops are applied to the encoded values directly, which is what the gain was fitted on.");
    }
  }
  if (keys.clamped) notes.push("Some gains or offsets were outside what the effect can show (gain 0.05-20, offset -1..1) and were clamped.");
  if (args.dry_run) {
    notes.push("dry_run: nothing was written to the patch layer.");
    return result;
  }
  if (keys.noDrift) {
    notes.push("The ring does not drift (every frame is within 0.5/255 of the reference), so no effect was added.");
    return { ...result, applied: false };
  }

  // The write: the effect, its keys, one undo step, then the read-back in a separate evalScript.
  const stateRead = (): { host: string; args: Record<string, unknown> } => ({
    host: "patchfitEffectState",
    args: { comp_id: args.comp_id, layer: { id: info.layer.id }, name: COLOR_EFFECT_NAME, times: evenly(keys.times, 12).items },
  });
  let wrote: Awaited<ReturnType<typeof runGuardedWrite>>;
  try {
    wrote = await runGuardedWrite(ctx, {
    toolName: o.toolName,
    label: `${o.label} write`,
    expect: args.expect,
    compId: args.comp_id,
    read: () => stateRead(),
    write: {
      host: "patchfitColorApply",
      args: {
        comp_id: args.comp_id,
        layer: { id: info.layer.id },
        mode,
        times: keys.times,
        series: keys.series,
        bypass_linear: st.bypass_linear,
        replace_existing: st.replace_existing,
        label: "Chroma AE MCP: patch colour match",
      },
      timeoutMs: SLOW_TIMEOUT_MS,
    },
    check: (before, after, w) => colorMismatches(mode, keys, before, after, w),
    present: (_b, _a, w) => ({ effect: w.effect, parameter_table: w.table, unit_scale: w.scale, slot: w.slot, clamped_by_limits: w.clamped, host_notes: w.notes, channels_written: w.channels_written, bypass_written: w.bypass_written }),
    });
  } catch (err) {
    return writeFailure(err, result, "The colour correction");
  }
  result.write = wrote;

  // The seam before and after, on the frames the correction moves most.
  if (st.verify && body.verifyTimes.length) {
    try {
      const after = await compLease(ctx, o.toolName, `${o.label} verify`, args.comp_id, { maxRenders: 8, maxSeconds: 60 }, async (snap) => {
        return verifyRows(snap, body.verifyTimes, regionPolygon(st.region), st.track_id ? loadTrack(st.track_id) : null, { gapPx: st.ring_gap_px, ringPx: st.ring_px, compWidth: info.comp.width });
      });
      const b = meanAbsOf(body.before);
      const a = meanAbsOf(after);
      result.verify = { frames: body.verifyTimes.map(r4), before: body.before, after, mean_seam_difference_before: b, mean_seam_difference_after: a, improved: b !== null && a !== null ? a < b : null };
    } catch (err) {
      result.verify = { error: errMessage(err), before: body.before };
    }
  }
  return result;
}

// ---------- ae_patch_grain ----------

interface GrainSample {
  time: number;
  neighbour: number;
  poly: Pt[];
  H: Mat3;
  Hn: Mat3;
}

interface GrainPrep {
  poly: Pt[];
  track: PlanarTrack | null;
  samples: GrainSample[];
  refTime: number;
}

interface SigmaSet {
  /** Spatial noise sigma per channel (gray levels of 255), median over the sampled frames. */
  spatial: [number, number, number];
  /** Temporal noise sigma of the luma, median over the sampled frames; 0 when not measurable. */
  temporal: number;
  frames: number;
}

interface GrainBody {
  ring: SigmaSet;
  patch: SigmaSet;
  plateCrop: RgbaImage | null;
  compCrop: RgbaImage | null;
  skipped: string[];
}

const ERODE_PX = 2;

/** Sigma of the plate ring and of the patch interior (composite) on one sampled frame, in the images' own pixels. */
function grainFrame(inp: { plate: RgbaImage | null; plateN: RgbaImage | null; comp: RgbaImage | null; compN: RgbaImage | null; sample: GrainSample; compW: number; ringPx: number; gapPx: number }): { ring: { spatial: number[]; temporal: number } | null; patch: { spatial: number[]; temporal: number } | null } {
  const s = (inp.plate ?? inp.comp)!.width / inp.compW;
  const w = (inp.plate ?? inp.comp)!.width;
  const h = (inp.plate ?? inp.comp)!.height;
  const polyPng = scalePoly(inp.sample.poly, s);
  const Hr = mulH(inp.sample.Hn, invertH(inp.sample.H) ?? identityH());
  const measure = (img: RgbaImage, imgN: RgbaImage | null, set: RingSet) => {
    if (set.idx.length < 60) return null;
    const spatial = (["red", "green", "blue"] as const).map((c) => noiseSigma(channelGray(img, c), set.mask));
    let temporal = 0;
    if (imgN) {
      const warped = warpGrayToRef(toGray(imgN), Hr, s, set);
      if (warped.validCount >= 60) temporal = temporalNoise(toGray(img), warped.gray, warped.valid);
    }
    return { spatial, temporal };
  };
  let ring = null;
  if (inp.plate) ring = measure(inp.plate, inp.plateN, makeRingSet(w, h, polyPng, inp.gapPx * s, (inp.gapPx + inp.ringPx) * s));
  let patch = null;
  if (inp.comp) patch = measure(inp.comp, inp.compN, makeRingSet(w, h, polyPng, -1e5, -ERODE_PX * s));
  return { ring, patch };
}

function medianSigma(rows: Array<{ spatial: number[]; temporal: number }>): SigmaSet {
  const spatial: [number, number, number] = [0, 1, 2].map((c) => r3(median(rows.map((r) => r.spatial[c])))) as [number, number, number];
  const temps = rows.map((r) => r.temporal).filter((t) => t > 0);
  return { spatial, temporal: temps.length ? r3(median(temps)) : 0, frames: rows.length };
}

const sigmaMean = (s: SigmaSet): number => mean(s.spatial);

export function grainMismatches(
  args: { method: "add" | "match"; degrain: "none" | "median" | "remove_grain"; intensity: number },
  patchId: number,
  before: unknown,
  after: unknown,
  written: Record<string, unknown>
): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  type State = {
    patch?: { enabled?: boolean; in_point?: number; out_point?: number };
    patch_effects: Array<{ name: string }>;
    degrain?: { params: EffectParamRow[] } | null;
    adjustment: { id: number; adjustment_layer: boolean; above_patch: boolean; in_point?: number; out_point?: number } | null;
    matte: { alpha: boolean; layer_id: number | null } | null;
    effect: { params: EffectParamRow[] } | null;
  };
  const a = after as State | null;
  const b = before as State | null;
  if (!a) return m;
  if (!a.adjustment) {
    m.push({ path: "adjustment", expected: "a grain adjustment layer", actual: undefined, message: "The grain layer is not in the comp" });
    return m;
  }
  expectThat(m, a.adjustment.adjustment_layer === true, "adjustment.adjustment_layer", true, a.adjustment.adjustment_layer, "The grain layer is not an adjustment layer");
  expectThat(m, a.adjustment.above_patch === true, "adjustment.above_patch", true, a.adjustment.above_patch, "The grain layer is not directly above the patch");
  // setTrackMatte may switch the matte layer (the patch) off; a patch that was on must still be.
  if (a.patch && a.patch.enabled !== undefined && b?.patch?.enabled !== false) {
    expectThat(m, a.patch.enabled === true, "patch.enabled", true, a.patch.enabled, "The patch layer is switched off, so it is missing from the composite");
  }
  // The grain layer spans the patch (0.01 s is under a frame at any rate this tool works at).
  const gIn = a.adjustment.in_point;
  const gOut = a.adjustment.out_point;
  if (a.patch && typeof a.patch.in_point === "number" && typeof a.patch.out_point === "number" && typeof gIn === "number" && typeof gOut === "number") {
    expectThat(
      m,
      Math.abs(gIn - a.patch.in_point) <= 0.01 && Math.abs(gOut - a.patch.out_point) <= 0.01,
      "adjustment.span",
      [r4(a.patch.in_point), r4(a.patch.out_point)],
      [r4(gIn), r4(gOut)],
      "The grain layer does not span the patch's in and out points"
    );
  }
  expectThat(m, a.matte?.alpha === true && a.matte?.layer_id === patchId, "matte", { type: "alpha", layer_id: patchId }, a.matte, "The grain layer is not matted to the patch's alpha");
  if (!a.effect) {
    m.push({ path: "effect", expected: GRAIN_EFFECT_NAME, actual: undefined, message: "The grain effect is not on the grain layer" });
  } else {
    const where = resolveEffectParams(a.effect.params, { intensity: { names: ["Intensity"] }, viewing: { names: ["Viewing Mode"] } });
    const intensity = a.effect.params.find((p) => p.index === where.intensity);
    const viewing = a.effect.params.find((p) => p.index === where.viewing);
    if (intensity) expectThat(m, intensity.value !== null && Math.abs(intensity.value - args.intensity) <= Math.max(1e-3, args.intensity * 0.01), "effect.intensity", args.intensity, intensity.value, "Intensity differs");
    const grain = written.grain as { viewing_mode_index?: number } | undefined;
    if (viewing && grain && typeof grain.viewing_mode_index === "number") {
      expectThat(m, viewing.value === grain.viewing_mode_index, "effect.viewing_mode", grain.viewing_mode_index, viewing.value, "Viewing Mode is not Final Output");
    }
  }
  if (args.degrain !== "none") {
    expectThat(m, a.patch_effects.some((e) => e.name === "Chroma degrain"), "patch_effects", "Chroma degrain", a.patch_effects.map((e) => e.name), "The degrain effect is not on the patch layer");
    const dg = written.degrain as { viewing_mode_index?: number | null } | null | undefined;
    if (args.degrain === "remove_grain" && a.degrain && dg && typeof dg.viewing_mode_index === "number") {
      const where = resolveEffectParams(a.degrain.params, { viewing: { names: ["Viewing Mode"] } });
      const vm = a.degrain.params.find((p) => p.index === where.viewing);
      expectThat(m, !!vm && vm.value === dg.viewing_mode_index, "degrain.viewing_mode", dg.viewing_mode_index, vm?.value, "Remove Grain's Viewing Mode is not Final Output");
    }
  }
  if (b) expectThat(m, a.patch_effects.length >= b.patch_effects.length, "patch_effects", b.patch_effects.length, a.patch_effects.length, "The patch lost effects");
  return m;
}

async function grainHandler(args: AePatchGrainArgs, ctx: ToolContext): Promise<Record<string, unknown>> {
  const toolName = "ae_patch_grain";
  const label = `ae_patch_grain(${args.comp_id})`;
  const framesDir = defaultFramesDir();

  const run = await plateRun<GrainPrep, GrainBody>(ctx, {
    toolName,
    label,
    compId: args.comp_id,
    expect: args.expect,
    layer: args.layer,
    hide: args.hide_layers,
    maxRenders: args.max_renders,
    maxSeconds: args.max_seconds,
    prepare: async (opId, info) => {
      const comp = { id: info.comp.id, name: info.comp.name, width: info.comp.width, height: info.comp.height };
      if (!args.dry_run && info.layer.locked) return { refuse: { ok: false, error: "bad_args", message: `Layer "${info.layer.name}" is locked; unlock it first.`, comp } };
      try {
        const fps = info.comp.fps > 0 ? info.comp.fps : 24;
        const plan = planFrameTimes({ fps, duration: info.comp.duration, workStart: info.comp.work_area_start, workDuration: info.comp.work_area_duration, start: args.start, end: args.end, step: 1, refTime: refTimeFor(args.track, args.ref_time), maxFrames: 100000 });
        const track = await resolveTrack(ctx, opId, info, args.track, plan.ref_time);
        const poly = regionPolygon(args.region);
        const last = Math.max(0, Math.round(info.comp.duration * fps) - 1);
        const f0 = Math.round(plan.range[0] * fps);
        const f1 = Math.round(plan.range[1] * fps);
        // Frames where the region can be placed, and one next to it for the temporal grain.
        const candidates: number[] = [];
        for (let f = f0; f <= f1; f++) {
          const nf = f + 1 <= last ? f + 1 : f - 1;
          if (nf < 0 || nf === f) continue;
          if (polygonAtT(poly, track, f / fps) && hAt(track, nf / fps)) candidates.push(f);
        }
        if (candidates.length === 0) return { refuse: { ok: false, error: "not_found", message: "The region could not be placed on any frame of the range (the track lost the plate, or the range is one frame).", comp } };
        const picks = spreadFrames(0, candidates.length - 1, args.samples).map((i) => candidates[i]);
        const samples: GrainSample[] = picks.map((f) => {
          const nf = f + 1 <= last ? f + 1 : f - 1;
          const at = polygonAtT(poly, track, f / fps) as { H: Mat3; poly: Pt[] };
          return { time: f / fps, neighbour: nf / fps, poly: at.poly, H: at.H, Hn: hAt(track, nf / fps) as Mat3 };
        });
        return { prep: { poly, track, samples, refTime: plan.ref_time } };
      } catch (err) {
        if (err instanceof PlanarError) return { refuse: { ok: false, error: err.code, message: err.message, comp } };
        throw err;
      }
    },
    body: async (env, prep) => {
      const ringRows: Array<{ spatial: number[]; temporal: number }> = [];
      const patchRows: Array<{ spatial: number[]; temporal: number }> = [];
      const skipped: string[] = [];
      let plateCrop: RgbaImage | null = null;
      let compCrop: RgbaImage | null = null;
      for (const sample of prep.samples) {
        if (env.budget.exhausted()) {
          skipped.push(`${r4(sample.time)}s: render budget reached`);
          continue;
        }
        const plate = await env.snap("plate", sample.time);
        await yieldLoop();
        const plateN = await env.snap("plate", sample.neighbour);
        await yieldLoop();
        const comp = await env.snap("comp", sample.time);
        await yieldLoop();
        const compN = await env.snap("comp", sample.neighbour);
        await yieldLoop();
        const got = grainFrame({ plate, plateN, comp, compN, sample, compW: env.info.comp.width, ringPx: args.ring_px, gapPx: args.ring_gap_px });
        await yieldLoop();
        if (got.ring) ringRows.push(got.ring);
        else skipped.push(`${r4(sample.time)}s: the ring holds too few pixels`);
        if (got.patch) patchRows.push(got.patch);
        if (!plateCrop) {
          const s = plate.width / env.info.comp.width;
          const b = polygonBounds(scalePoly(sample.poly, s));
          const pc = cropToBounds(plate, b, (args.ring_px + 4) * s);
          const cc = cropToBounds(comp, b, (args.ring_px + 4) * s);
          if (pc && cc) {
            plateCrop = pc.img;
            compCrop = cc.img;
          }
        }
      }
      if (ringRows.length === 0) throw new Error("no frame could be measured in the plate ring");
      return {
        ring: medianSigma(ringRows),
        patch: patchRows.length ? medianSigma(patchRows) : { spatial: [0, 0, 0], temporal: 0, frames: 0 },
        plateCrop,
        compCrop,
        skipped,
      };
    },
  });

  if (run.refused) return run.refused;
  const tail = plateTail(run);
  const body = run.value;
  if (!body) return { op_id: run.opId, applied: true as const, ok: false, error: "measure_failed", message: run.bodyError ?? "the measurement did not run", ...tail };
  const info = run.info;
  const notes = projectNotes(info);
  if (info.comp.bits_per_channel === 32) notes.push("Add Grain has no 32-bpc support and misbehaves in ACES / linear projects: check the result at 8 or 16 bpc.");
  if (body.skipped.length) notes.push(`Skipped: ${body.skipped.join("; ")}`);
  const ringSigma = sigmaMean(body.ring);
  const patchSigma = sigmaMean(body.patch);
  const temporalRatio = body.ring.temporal > 0 ? r3(body.patch.temporal / body.ring.temporal) : null;
  const frozen = temporalRatio !== null && temporalRatio < 0.5;
  const header = {
    ok: true as const,
    op_id: run.opId,
    tool: toolName,
    dry_run: args.dry_run,
    layer: { index: info.layer.index, id: info.layer.id, name: info.layer.name },
    sigma_before: { plate_ring: body.ring, patch: body.patch, temporal_ratio: temporalRatio, frozen_grain: frozen },
    ...tail,
  };
  if (ringSigma < args.min_sigma) {
    notes.push(`The plate is clean: its grain sigma is ${r2(ringSigma)} of 255, under min_sigma ${args.min_sigma}, so no grain was added.`);
    return { ...header, grain_added: false, notes };
  }
  if (patchSigma > ringSigma * 1.3 && args.degrain === "none") {
    notes.push("The patch's own grain is stronger than the plate's: add degrain ('median' or 'remove_grain') so the new grain is not on top of it.");
  }
  // Match Grain samples the plate's own noise, so Intensity 1 already reproduces it; only Add Grain goes through the calibration curve.
  const startIntensity = args.intensity ?? (args.method === "match" ? 1 : grainIntensityFor(ringSigma));
  // A frozen patch with no degrain already holds the plate's spatial grain: the added grain would sum with it. Then the tuning aims at the moving (temporal) grain.
  const tuneTemporal = args.degrain === "none" && body.ring.temporal >= args.min_sigma;
  const tuneTarget = tuneTemporal ? body.ring.temporal : ringSigma;
  const preview = (compImg: RgbaImage | null): string | null => {
    if (!body.plateCrop || !compImg) return null;
    try {
      const a = scaleNearest(body.plateCrop, body.plateCrop.width * 2, body.plateCrop.height * 2);
      const b = scaleNearest(compImg, compImg.width * 2, compImg.height * 2);
      const canvas = createCanvas(a.width + b.width + 12, Math.max(a.height, b.height), [18, 18, 22, 255]);
      blit(canvas, a, 0, 0);
      blit(canvas, b, a.width + 12, 0);
      return writePng(framesDir, "patchfit_grain", args.comp_id, canvas);
    } catch {
      return null;
    }
  };
  if (args.dry_run) {
    notes.push("dry_run: nothing was added. The plan below is what a real run would write.");
    return { ...header, grain_added: false, plan: { method: args.method, degrain: args.degrain, start_intensity: startIntensity, size: args.grain_size, rounds: args.rounds }, notes };
  }

  // First write: degrain, the matted adjustment layer and the grain.
  const patchId = info.layer.id;
  const stateRead = () => ({ host: "patchfitGrainState", args: { comp_id: args.comp_id, patch: { id: patchId } } });
  let first: Awaited<ReturnType<typeof runGuardedWrite>>;
  try {
    first = await runGuardedWrite(ctx, {
    toolName,
    label: `${label} write`,
    expect: args.expect,
    compId: args.comp_id,
    read: () => stateRead(),
    write: {
      host: "patchfitGrainApply",
      args: {
        comp_id: args.comp_id,
        layer: { id: patchId },
        method: args.method,
        degrain: args.degrain,
        intensity: startIntensity,
        size: args.grain_size,
        viewing_mode_index: args.viewing_mode_index,
        degrain_viewing_mode_index: args.degrain_viewing_mode_index,
        plate_layer: args.plate_layer,
        replace_existing: args.replace_existing,
        label: "Chroma AE MCP: patch grain",
      },
    },
    check: (before, after, w) => grainMismatches({ method: args.method, degrain: args.degrain, intensity: startIntensity }, patchId, before, after, w),
    present: (_b, after, w) => {
      const st = after as { adjustment?: { id: number; index: number; name: string } | null } | null;
      return { degrain: w.degrain, adjustment: st?.adjustment ?? w.adjustment, grain: w.grain, patch_enabled: w.patch_enabled, host_notes: w.notes };
    },
    });
  } catch (err) {
    return writeFailure(err, { ...header, grain_added: false, notes }, "The grain");
  }
  const adjustment = ((first as Record<string, unknown>).adjustment ?? null) as { id?: number } | null;
  const rounds: Array<Record<string, unknown>> = [];
  let intensity = startIntensity;
  let patchNow = body.patch;
  let compAfter: RgbaImage | null = null;
  let converged = false;
  let tuneFailure: string | null = null;
  if (adjustment && typeof adjustment.id === "number") {
    // Re-measure the patch from the composite: a read-only lease per round.
    const samples = run.prep.samples;
    for (let round = 0; round <= args.rounds; round++) {
      let measured: { set: SigmaSet; last: RgbaImage | null } | null = null;
      try {
        measured = await compLease(ctx, toolName, `${label} round ${round}`, args.comp_id, { maxRenders: samples.length * 2 + 2, maxSeconds: 60 }, async (snap) => {
          const rows: Array<{ spatial: number[]; temporal: number }> = [];
          let lastImg: RgbaImage | null = null;
          for (const sample of samples) {
            const comp = await snap(sample.time);
            await yieldLoop();
            const compN = await snap(sample.neighbour);
            await yieldLoop();
            const got = grainFrame({ plate: null, plateN: null, comp, compN, sample, compW: info.comp.width, ringPx: args.ring_px, gapPx: args.ring_gap_px });
            if (got.patch) rows.push(got.patch);
            lastImg = comp;
            await yieldLoop();
          }
          return { set: rows.length ? medianSigma(rows) : { spatial: [0, 0, 0] as [number, number, number], temporal: 0, frames: 0 }, last: lastImg };
        });
      } catch (err) {
        tuneFailure = `Round ${round} could not render: ${errMessage(err)}`;
        break;
      }
      patchNow = measured.set;
      if (measured.last && samples[0]) {
        const s = measured.last.width / info.comp.width;
        const cc = cropToBounds(measured.last, polygonBounds(scalePoly(samples[0].poly, s)), (args.ring_px + 4) * s);
        if (cc) compAfter = cc.img;
      }
      const now = tuneTemporal ? patchNow.temporal : sigmaMean(patchNow);
      const err = tuneTarget > 0 ? Math.abs(now - tuneTarget) / tuneTarget : 0;
      rounds.push({ round, intensity, metric: tuneTemporal ? "temporal" : "spatial", patch_sigma: r3(now), plate_sigma: r3(tuneTarget), error: r3(err) });
      if (err <= args.tolerance) {
        converged = true;
        break;
      }
      if (round === args.rounds) break;
      if (now < 0.1 * tuneTarget) notes.push("The patch shows almost no new grain: check that the Viewing Mode is Final Output (viewing_mode_index) and that the grain layer is above the patch.");
      const next = nextGrainIntensity(intensity, now, tuneTarget);
      if (Math.abs(next - intensity) < 1e-4) break;
      const tuneRead = () => ({ host: "patchfitGrainState", args: { comp_id: args.comp_id, patch: { id: patchId }, layer: { id: adjustment.id } } });
      let tuned: Awaited<ReturnType<typeof runGuardedWrite>>;
      try {
        tuned = await runGuardedWrite(ctx, {
        toolName,
        label: `${label} tune ${round + 1}`,
        expect: args.expect,
        compId: args.comp_id,
        read: () => tuneRead(),
        write: { host: "patchfitGrainTune", args: { comp_id: args.comp_id, layer: { id: adjustment.id }, intensity: next, label: "Chroma AE MCP: patch grain tune" } },
        check: (_b, after) => {
          const mm: ReceiptMismatch[] = [];
          const st = after as { effect?: { params: EffectParamRow[] } | null } | null;
          const where = st?.effect ? resolveEffectParams(st.effect.params, { intensity: { names: ["Intensity"] } }) : null;
          const p = where && st?.effect ? st.effect.params.find((q) => q.index === where.intensity) : undefined;
          if (!p || p.value === null || Math.abs(p.value - next) > Math.max(1e-3, next * 0.01)) {
            mm.push({ path: "effect.intensity", expected: next, actual: p?.value, message: "Intensity differs after the tune" });
          }
          return mm;
        },
        present: (_b, _a, w) => ({ intensity_before: w.intensity_before, intensity: w.intensity }),
        });
      } catch (err) {
        // The grain is already on the patch: report the failed round and return what stands.
        tuneFailure = `Tuning round ${round + 1} was not written: ${errMessage(err)}${err instanceof BridgeError && err.kind === "timeout" ? " AE did not answer in time, so it may still have run: read the grain layer's Intensity." : ""} The grain stays at Intensity ${intensity}.`;
        rounds[rounds.length - 1].tune_failure = errMessage(err);
        break;
      }
      intensity = next;
      rounds[rounds.length - 1].tune_receipt = tuned.receipt;
    }
  } else {
    tuneFailure = "The grain layer's id was not returned, so it could not be tuned.";
  }
  if (tuneFailure) notes.push(tuneFailure);
  if (!converged && rounds.length > 0) notes.push(`The patch's ${tuneTemporal ? "temporal (moving) grain" : "sigma"} did not reach the plate's within ${args.tolerance * 100}% in ${args.rounds} tuning round(s); run again with a start intensity, or raise rounds.`);
  if (tuneTemporal && sigmaMean(patchNow) > ringSigma * 1.3) {
    notes.push(`The patch's total spatial grain (sigma ${r2(sigmaMean(patchNow))}) is above the plate's (${r2(ringSigma)}) because its own frozen grain stays under the new moving grain. Run again with degrain 'median' or 'remove_grain' to remove the excess.`);
  }
  const previewPath = preview(compAfter);
  return {
    ...header,
    grain_added: true,
    write: first,
    method: args.method,
    degrain: args.degrain,
    start_intensity: startIntensity,
    final_intensity: intensity,
    converged,
    rounds,
    sigma_after: { plate_ring: body.ring, patch: patchNow, temporal_ratio: body.ring.temporal > 0 && patchNow.temporal > 0 ? r3(patchNow.temporal / body.ring.temporal) : null },
    ...(previewPath ? { preview_path: previewPath, preview_note: "Left: the plate ring and region at 2x; right: the composite with the new grain." } : {}),
    notes,
  };
}

// ---------- ae_patch_finish ----------

interface FinishSample {
  time: number;
  poly: Pt[];
  H: Mat3;
}

interface FinishPrep {
  poly: Pt[];
  track: PlanarTrack | null;
  refTime: number;
  /** Blurriness of the earlier sit-in blur at the reference frame, or null when there is none or it could not be read. */
  oldBlurriness: number | null;
  samples: FinishSample[];
  /** Per-frame speed of the region's centre in comp px per frame, over the range. */
  speeds: number[];
}

interface FinishBody {
  blurSigmaComp: Array<{ time: number; sigma: number }>;
  patchEnergy: number;
  ringEnergy: Array<{ time: number; energy: number }>;
  seam: Array<{ time: number; score: number }>;
  worstSeam: number;
  before: RgbaImage | null;
  skipped: string[];
}

function centroid(poly: Pt[]): Pt {
  return [mean(poly.map((p) => p[0])), mean(poly.map((p) => p[1]))];
}

/** The speed of the region's centre between consecutive frames of the range (comp px per frame). */
export function regionSpeeds(poly: Pt[], track: PlanarTrack | null, fps: number, f0: number, f1: number): number[] {
  if (!track) return [];
  const c = centroid(poly);
  const out: number[] = [];
  let prev: Pt | null = null;
  for (let f = f0; f <= f1; f++) {
    const H = hAt(track, f / fps);
    const p = H ? applyH(H, c) : null;
    if (p && prev) out.push(Math.hypot(p[0] - prev[0], p[1] - prev[1]));
    prev = p;
  }
  return out;
}

const percentile = (a: number[], p: number): number => {
  if (a.length === 0) return 0;
  const s = Float64Array.from(a).sort();
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

export function finishMismatches(plan: FinishPlan, before: unknown, after: unknown, written: Record<string, unknown>): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  type State = {
    comp: { motion_blur: boolean; shutter_angle: number | null };
    layer: HostInfo["layer"];
    blur: { index: number; params: EffectParamRow[] } | null;
    force_motion_blur: { index: number } | null;
  };
  const a = after as State | null;
  if (!a) return m;
  if (plan.blur) {
    if (!a.blur) m.push({ path: "blur", expected: BLUR_EFFECT_NAME, actual: undefined, message: "The blur effect is not on the layer" });
    else {
      const where = resolveEffectParams(a.blur.params, { amount: { names: ["Blurriness"], index: 1 } });
      const p = a.blur.params.find((q) => q.index === where.amount);
      const wantKeys = plan.blur.times.length > 1 ? plan.blur.times.length : 0;
      if (p) {
        expectThat(m, p.num_keys === wantKeys, "blur.num_keys", wantKeys, p.num_keys, "Blurriness key count differs");
        for (const s of p.samples) {
          const want = valueAtLinear(plan.blur.times, plan.blur.values, s.time);
          if (Math.abs(s.value - want) > 0.02) {
            m.push({ path: `blur@${r4(s.time)}`, expected: r4(want), actual: r4(s.value), message: "Blurriness at this time differs" });
            break;
          }
        }
      } else m.push({ path: "blur.amount", expected: "Blurriness", actual: undefined, message: "The blur has no Blurriness parameter" });
    }
  }
  if (plan.edge) {
    // The host skips masks whose mode is None or whose feather is keyframed; check the ones it says it set.
    const done = (written.edge as { masks?: Array<{ index: number; feather: number; expansion: number }> } | null | undefined)?.masks ?? [];
    if (done.length === 0) m.push({ path: "masks", expected: "at least one mask feathered", actual: written.edge, message: "No mask could be feathered" });
    for (const d of done) {
      const mk = a.layer.masks.find((x) => x.index === d.index);
      const f = mk && Array.isArray(mk.feather) ? mk.feather[0] : mk && typeof mk.feather === "number" ? mk.feather : undefined;
      expectThat(m, f !== undefined && Math.abs(f - d.feather) <= 0.01, `masks[${d.index}].feather`, d.feather, f, "A mask's feather differs from what was set");
      if (mk && typeof mk.expansion === "number") expectThat(m, Math.abs(mk.expansion - d.expansion) <= 0.01, `masks[${d.index}].expansion`, d.expansion, mk.expansion, "A mask's expansion differs from what was set");
    }
  }
  if (plan.layer_switches?.motion_blur) expectThat(m, a.layer.motion_blur === true, "layer.motion_blur", true, a.layer.motion_blur, "Layer motion blur is off");
  if (plan.layer_switches?.sampling_bicubic && a.layer.sampling_bicubic !== null) expectThat(m, a.layer.sampling_bicubic === true, "layer.sampling_bicubic", true, a.layer.sampling_bicubic, "Sampling quality is not bicubic");
  if (plan.layer_switches?.frame_blend_none && a.layer.frame_blend_none !== null) expectThat(m, a.layer.frame_blend_none === true, "layer.frame_blend_none", true, a.layer.frame_blend_none, "Frame blending is not off");
  if (plan.layer_switches?.quality_best && a.layer.quality_best !== null) expectThat(m, a.layer.quality_best === true, "layer.quality_best", true, a.layer.quality_best, "Layer quality is not Best");
  if (plan.comp?.motion_blur) expectThat(m, a.comp.motion_blur === true, "comp.motion_blur", true, a.comp.motion_blur, "Comp motion blur is off");
  // A comp stores whole degrees: compare within half a degree.
  if (plan.comp?.shutter_angle !== undefined) expectThat(m, a.comp.shutter_angle !== null && Math.abs(a.comp.shutter_angle - plan.comp.shutter_angle) <= 0.5, "comp.shutter_angle", plan.comp.shutter_angle, a.comp.shutter_angle, "Comp shutter angle differs");
  if (plan.force_motion_blur) expectThat(m, a.force_motion_blur !== null, "force_motion_blur", "CC Force Motion Blur", a.force_motion_blur, "CC Force Motion Blur is not on the layer");
  void before;
  return m;
}

export interface FinishPlan {
  blur?: { times: number[]; values: number[]; replace_existing: boolean };
  edge?: { masks: Array<{ index: number; feather: number; expansion: number }> };
  layer_switches?: { motion_blur?: boolean; sampling_bicubic?: boolean; frame_blend_none?: boolean; quality_best?: boolean };
  comp?: { motion_blur?: boolean; shutter_angle?: number };
  force_motion_blur?: { shutter_angle: number; replace_existing: boolean };
}

async function finishHandler(args: AePatchFinishArgs, ctx: ToolContext): Promise<Record<string, unknown>> {
  const toolName = "ae_patch_finish";
  const label = `ae_patch_finish(${args.comp_id})`;
  const framesDir = defaultFramesDir();

  const run = await plateRun<FinishPrep, FinishBody>(ctx, {
    toolName,
    label,
    compId: args.comp_id,
    expect: args.expect,
    layer: args.layer,
    hide: args.hide_layers,
    maxRenders: args.max_renders,
    maxSeconds: args.max_seconds,
    prepare: async (opId, info) => {
      const comp = { id: info.comp.id, name: info.comp.name, width: info.comp.width, height: info.comp.height };
      if (!args.dry_run && info.layer.locked) return { refuse: { ok: false, error: "bad_args", message: `Layer "${info.layer.name}" is locked; unlock it first.`, comp } };
      const ownBlur = ownEffectIndex(info.layer, "blur", BLUR_EFFECT_NAME);
      if (!args.dry_run && args.sharpness && ownBlur !== null && !args.replace_existing) {
        return { refuse: { ok: false, error: "bad_args", message: `Layer "${info.layer.name}" already has "${BLUR_EFFECT_NAME}". Pass replace_existing to replace it, or sharpness: false.`, comp } };
      }
      try {
        const fps = info.comp.fps > 0 ? info.comp.fps : 24;
        const plan = planFrameTimes({ fps, duration: info.comp.duration, workStart: info.comp.work_area_start, workDuration: info.comp.work_area_duration, start: args.start, end: args.end, step: 1, refTime: refTimeFor(args.track, args.ref_time), maxFrames: 100000 });
        const track = await resolveTrack(ctx, opId, info, args.track, plan.ref_time);
        const poly = regionPolygon(args.region);
        const f0 = Math.round(plan.range[0] * fps);
        const f1 = Math.round(plan.range[1] * fps);
        const placed: number[] = [];
        for (let f = f0; f <= f1; f++) if (polygonAtT(poly, track, f / fps)) placed.push(f);
        if (placed.length === 0) return { refuse: { ok: false, error: "not_found", message: "The region could not be placed on any frame of the range.", comp } };
        const frames = new Set<number>(spreadFrames(0, placed.length - 1, args.samples).map((i) => placed[i]));
        const samples: FinishSample[] = [...frames]
          .sort((a, b) => a - b)
          .map((f) => {
            const at = polygonAtT(poly, track, f / fps) as { H: Mat3; poly: Pt[] };
            return { time: f / fps, poly: at.poly, H: at.H };
          });
        // The measurement sees the earlier blur (it is in the composite), so its amount is read to combine with the extra.
        let oldBlurriness: number | null = null;
        if (args.sharpness && ownBlur !== null) {
          try {
            const st = await hostRead<{ blur: { params: EffectParamRow[] } | null }>(ctx, opId, "blur", "patchfitFinishState", { comp_id: args.comp_id, layer: { id: info.layer.id }, times: [plan.ref_time] }, toolName);
            if (st.blur) {
              const where = resolveEffectParams(st.blur.params, { amount: { names: ["Blurriness"], index: 1 } });
              const row = st.blur.params.find((q) => q.index === where.amount);
              const v = row ? (row.samples[0]?.value ?? row.value) : null;
              if (typeof v === "number" && Number.isFinite(v) && v >= 0) oldBlurriness = v;
            }
          } catch {
            oldBlurriness = null;
          }
        }
        return { prep: { poly, track, refTime: plan.ref_time, oldBlurriness, samples, speeds: regionSpeeds(poly, track, fps, f0, f1) } };
      } catch (err) {
        if (err instanceof PlanarError) return { refuse: { ok: false, error: err.code, message: err.message, comp } };
        throw err;
      }
    },
    body: async (env, prep) => {
      const comp = env.info.comp;
      const skipped: string[] = [];
      const ringEnergy: FinishBody["ringEnergy"] = [];
      const seam: FinishBody["seam"] = [];
      const blurSigmaComp: FinishBody["blurSigmaComp"] = [];
      // The patch as it looks at the reference frame (composite), cropped around the region.
      const refComp = await env.snap("comp", prep.refTime);
      await yieldLoop();
      const s = refComp.width / comp.width;
      const refPoly = scalePoly(prep.poly, s);
      const crop = cropToBounds(refComp, polygonBounds(refPoly), 8 * s + 6);
      if (!crop) throw new Error("the region lies outside the frame at the reference time");
      const cropPoly = refPoly.map((p) => [p[0] - crop.x0, p[1] - crop.y0] as Pt);
      const interior = ringMask(crop.img.width, crop.img.height, cropPoly, -1e5, -ERODE_PX * s);
      const patchGray = toGray(crop.img);
      const patchEnergy = laplacianEnergy(patchGray, interior);
      let renderedSamples = 0;
      for (const sample of prep.samples) {
        if (env.budget.exhausted()) {
          skipped.push(`${r4(sample.time)}s: render budget reached`);
          continue;
        }
        const plate = await env.snap("plate", sample.time);
        await yieldLoop();
        const comp2 = Math.abs(sample.time - prep.refTime) < 1e-6 ? refComp : await env.snap("comp", sample.time);
        await yieldLoop();
        renderedSamples++;
        const ps = scalePoly(sample.poly, plate.width / comp.width);
        const ringSet = makeRingSet(plate.width, plate.height, ps, args.ring_gap_px * s, (args.ring_gap_px + args.ring_px) * s);
        if (ringSet.idx.length >= 60) {
          const e = laplacianEnergy(toGray(plate), ringSet.mask);
          ringEnergy.push({ time: sample.time, energy: e });
          const sigmaPng = sigmaForEnergy(patchGray, interior, e * SHARPNESS_SLACK, args.max_blur_sigma * s);
          blurSigmaComp.push({ time: sample.time, sigma: sigmaPng / s });
        } else skipped.push(`${r4(sample.time)}s: the ring holds too few pixels`);
        const sm = seamScore(toGray(comp2), ps, args.ring_px * s);
        if (sm.chunks > 0) seam.push({ time: sample.time, score: sm.score });
        await yieldLoop();
      }
      if (renderedSamples === 0) throw new Error("no frame could be rendered within the budget");
      return { blurSigmaComp, patchEnergy, ringEnergy, seam, worstSeam: seam.length ? Math.max(...seam.map((x) => x.score)) : 0, before: crop.img, skipped };
    },
  });

  if (run.refused) return run.refused;
  const tail = plateTail(run);
  const body = run.value;
  if (!body) return { op_id: run.opId, applied: true as const, ok: false, error: "measure_failed", message: run.bodyError ?? "the measurement did not run", ...tail };
  const info = run.info;
  const notes = projectNotes(info);
  if (body.skipped.length) notes.push(`Skipped: ${body.skipped.join("; ")}`);
  const prepSpeeds = run.prep.speeds;
  const shutter = args.shutter_angle ?? info.comp.shutter_angle ?? 180;
  const plan: FinishPlan = {};
  const report: Record<string, unknown> = {};

  // Gaussian Blur and Mask Feather work in the patch layer's own pixels, before its transform and any pin: comp-pixel amounts are divided by the layer's scale.
  const ls = layerCompScale(info.layer);
  if (args.sharpness || args.edge) {
    if (Math.abs(ls.scale - 1) > 0.02) notes.push(`The patch layer is scaled to ${r3(ls.scale)}x in the comp (transform and parents), so the comp-pixel sigma and mask feather are divided by it before they are written (a part that is not planned, or a dry_run, writes nothing).`);
    if (ls.pinned) notes.push("The patch layer has a pin effect: Gaussian Blur and Mask Feather work in the layer's own pixels before the pin, and the pin's own scale (source quad to destination quad) is not measured, so the blur may be too strong or too weak by that scale. Check it by eye or use a transform-based placement.");
    if (ls.keyed) notes.push("The patch layer's Scale (or a parent's) is animated or expression-driven: the scale at the comp's current time was used for the whole shot.");
  }

  // Sharpness: the Gaussian sigma that brings the patch to the ring's detail, per sampled frame.
  if (args.sharpness) {
    const own = ownEffectIndex(info.layer, "blur", BLUR_EFFECT_NAME) !== null;
    const sig = body.blurSigmaComp;
    // sig is the extra blur the patch needs on top of the earlier sit-in blur that was in the composite; the
    // amount to write replaces that blur, so the two combine as independent Gaussians (root of the sum of squares).
    const oldBlurriness = run.prep.oldBlurriness;
    const oldSigma = oldBlurriness !== null ? sigmaFromBlurriness(oldBlurriness) : 0;
    // Gaussian Blur works in the patch layer's own pixels, before its transform and any pin: the comp-pixel sigma is divided by the layer's scale.
    const sigLayer = sig.map((x) => x.sigma / ls.scale);
    const blurrinessAt = sigLayer.map((x) => blurrinessFromSigma(Math.hypot(oldSigma, x)));
    const spread = blurrinessAt.length ? Math.max(...blurrinessAt) - Math.min(...blurrinessAt) : 0;
    report.sharpness = {
      patch_detail: r2(body.patchEnergy),
      ring_detail: body.ringEnergy.map((x) => ({ time: r4(x.time), energy: r2(x.energy) })),
      sigma_px: sig.map((x) => ({ time: r4(x.time), sigma: r3(x.sigma) })),
      sigma_layer_px: sigLayer.map((x, i) => ({ time: r4(sig[i].time), sigma: r3(x) })),
      layer_scale: r3(ls.scale),
      ...(own ? { existing_blurriness_at_ref: oldBlurriness === null ? null : r3(oldBlurriness), existing_sigma_px: r3(oldSigma) } : {}),
      blurriness: blurrinessAt.map(r2),
      note: "Blurriness is estimated as 2.5 x sigma until calibrated live; the read-back shows what was set.",
    };
    if (sig.length > 0 && Math.max(...sigLayer) > 0.15 / ls.scale) {
      const keyed = sig.length > 1 && spread >= 1;
      const times = keyed ? sig.map((x) => x.time) : [sig[0].time];
      const values = keyed ? blurrinessAt.map(r3) : [r3(median(blurrinessAt))];
      plan.blur = { times, values, replace_existing: args.replace_existing };
      if (own && oldBlurriness !== null) {
        notes.push(`The earlier sit-in blur (Blurriness ${r3(oldBlurriness)}, sigma ${r3(oldSigma)} px at the reference frame) was in the composite when the patch was measured, so the amount written is the square root of its square plus the extra sigma measured at each time, and it replaces the earlier blur.`);
      } else if (own) {
        notes.push("The earlier sit-in blur was in the composite when the patch was measured and its amount could not be read, so only the extra blur was written: the patch ends up sharper than needed. Run again to add more.");
      }
    } else {
      report.sharpness = { ...(report.sharpness as object), result: "The patch is not sharper than the plate's ring: no blur needed." };
    }
  }

  // Edge: the seam score on the composite.
  if (args.edge) {
    report.edge = { layer_scale: r3(ls.scale), seam: body.seam.map((x) => ({ time: r4(x.time), score: r2(x.score) })), worst: r2(body.worstSeam), limit: args.seam_max };
    if (body.worstSeam > args.seam_max) {
      const masks = info.layer.masks;
      if (masks.length === 0) {
        notes.push(`The seam scores ${r2(body.worstSeam)} (limit ${args.seam_max}) but the patch layer has no masks to feather: mask the patch, or blend it with a feathered matte.`);
      } else {
        // Per mask: each grows only by its own half-feather, so a mask that needs nothing does not change shape.
        const open = masks.filter((mk) => !mk.feather_keyed && !mk.expansion_keyed);
        const keyed = masks.filter((mk) => mk.feather_keyed || mk.expansion_keyed);
        if (keyed.length) notes.push(`Masks with keyframed or expression-driven feather or expansion (${keyed.map((mk) => mk.index).join(", ")}) are left alone.`);
        if (open.length === 0) {
          notes.push("Every mask has keyframed or expression-driven feather or expansion, so none was feathered.");
        } else {
          plan.edge = {
            masks: open.map((mk) => {
              const curF = Array.isArray(mk.feather) ? Math.max(mk.feather[0] ?? 0, mk.feather[1] ?? 0) : typeof mk.feather === "number" ? mk.feather : 0;
              // The seam heuristic and max_feather are in comp pixels; Mask Feather and Expansion are in the layer's pixels.
              const ms = ls.scale;
              const fe = featherFor(body.worstSeam, args.seam_max, curF * ms, (mk.expansion ?? 0) * ms, args.max_feather);
              return { index: mk.index, feather: r2(fe.feather / ms), expansion: r2(fe.expansion / ms) };
            }),
          };
        }
      }
    }
  }

  // Motion blur from the track's speed and the shutter.
  if (args.motion_blur) {
    if (!args.track) {
      report.motion_blur = { result: "No track given: the motion of the shot is unknown, so motion blur is not matched." };
    } else {
      const lens = prepSpeeds.map((v) => blurLengthPx(v, shutter));
      const stats = { shutter_angle: shutter, max_px: r2(lens.length ? Math.max(...lens) : 0), p95_px: r2(percentile(lens, 0.95)), median_px: r2(median(lens)), frames: lens.length };
      report.motion_blur = {
        ...stats,
        mover: info.layer.pinned ? "pin effect" : "layer transform",
        shutter_phase: info.comp.shutter_phase,
        shutter_phase_note: "The comp's shutter phase is not changed and the plate's own phase cannot be measured; check it if the blur looks offset.",
      };
      if (stats.p95_px >= 0.5) {
        if (info.layer.pinned) {
          plan.force_motion_blur = { shutter_angle: shutter, replace_existing: args.replace_existing };
          notes.push("The patch is moved by a pin effect, which layer motion blur does not blur: CC Force Motion Blur is added after the pin (or re-apply the track with ae_track_apply mode transform_pin).");
        } else {
          plan.layer_switches = { ...plan.layer_switches, motion_blur: true };
          const wantComp: { motion_blur?: boolean; shutter_angle?: number } = {};
          if (!info.comp.motion_blur) wantComp.motion_blur = true;
          // The comp stores whole degrees (0-720), so the angle is rounded before it is compared and written.
          if (args.shutter_angle !== undefined && info.comp.shutter_angle !== Math.round(args.shutter_angle)) wantComp.shutter_angle = Math.round(args.shutter_angle);
          if (Object.keys(wantComp).length > 0) {
            if (args.allow_comp_change) plan.comp = wantComp;
            else notes.push(`Comp motion blur / shutter angle must change to match the plate (${JSON.stringify(wantComp)}), and that affects every layer in the comp: pass allow_comp_change to let the tool do it.`);
          }
        }
      } else {
        (report.motion_blur as Record<string, unknown>).result = "The plate's blur from the track is under half a pixel: no motion blur needed.";
      }
    }
  }

  if (args.quality) {
    const want: Record<string, boolean> = {};
    if (info.layer.sampling_bicubic !== true) want.sampling_bicubic = true;
    if (info.layer.frame_blend_none !== true) want.frame_blend_none = true;
    if (info.layer.quality_best !== true) want.quality_best = true;
    if (Object.keys(want).length > 0) plan.layer_switches = { ...plan.layer_switches, ...want };
    report.quality = { before: { sampling_bicubic: info.layer.sampling_bicubic, frame_blend_none: info.layer.frame_blend_none, quality_best: info.layer.quality_best }, will_set: Object.keys(want) };
  }
  if (plan.layer_switches && info.layer.motion_blur && plan.layer_switches.motion_blur) delete plan.layer_switches.motion_blur;
  if (plan.layer_switches && Object.keys(plan.layer_switches).length === 0) delete plan.layer_switches;
  const header = {
    ok: true as const,
    op_id: run.opId,
    tool: toolName,
    dry_run: args.dry_run,
    layer: { index: info.layer.index, id: info.layer.id, name: info.layer.name },
    measured: report,
    plan,
    ...tail,
  };
  const empty = Object.keys(plan).length === 0 || Object.values(plan).every((v) => v === undefined || (typeof v === "object" && Object.keys(v as object).length === 0));
  if (args.dry_run) {
    notes.push("dry_run: nothing was written. `plan` is what a real run would set.");
    return { ...header, applied: false, notes };
  }
  if (empty) {
    notes.push("Nothing needs changing: the patch already sits in the shot by these measures.");
    return { ...header, applied: false, notes };
  }
  const times = plan.blur?.times ?? [];
  let wrote: Awaited<ReturnType<typeof runGuardedWrite>>;
  try {
    wrote = await runGuardedWrite(ctx, {
    toolName,
    label: `${label} write`,
    expect: args.expect,
    compId: args.comp_id,
    read: () => ({ host: "patchfitFinishState", args: { comp_id: args.comp_id, layer: { id: info.layer.id }, times: evenly(times, 12).items } }),
    write: { host: "patchfitFinishApply", args: { comp_id: args.comp_id, layer: { id: info.layer.id }, ...plan, label: "Chroma AE MCP: patch finish" } },
    check: (before, after, w) => finishMismatches(plan, before, after, w),
    present: (_b, _a, w) => ({ blur: w.blur, edge: w.edge, layer_switches: w.layer_switches, comp: w.comp, force_motion_blur: w.force_motion_blur, host_notes: w.notes }),
    });
  } catch (err) {
    return writeFailure(err, { ...header, notes }, "The finish");
  }
  const result: Record<string, unknown> = { ...header, applied: true, write: wrote, notes };

  // Before and after crops of the patch at the reference frame.
  try {
    const afterImg = await compLease(ctx, toolName, `${label} crops`, args.comp_id, { maxRenders: 2, maxSeconds: 30 }, async (snap) => snap(run.prep.refTime));
    const s = afterImg.width / info.comp.width;
    const polyRef = scalePoly(run.prep.poly, s);
    const cc = cropToBounds(afterImg, polygonBounds(polyRef), 8 * s + 6);
    if (cc && body.before) {
      const a = scaleNearest(body.before, body.before.width * 2, body.before.height * 2);
      const b = scaleNearest(cc.img, cc.img.width * 2, cc.img.height * 2);
      const canvas = createCanvas(a.width + b.width + 12, Math.max(a.height, b.height), [18, 18, 22, 255]);
      blit(canvas, a, 0, 0);
      blit(canvas, b, a.width + 12, 0);
      result.crops_path = writePng(framesDir, "patchfit_finish", args.comp_id, canvas);
      result.crops_note = "Left: the patch before, right: after, 2x.";
    }
  } catch (err) {
    result.crops_error = errMessage(err);
  }
  return result;
}

// ---------- tools ----------

export const patchfitTools: ToolDefinition<any>[] = [
  {
    name: "ae_patch_color_match",
    description:
      "Removes the light drift that gives a frozen or cloned patch away. Renders the plate (the patch layer and `hide_layers` switched off in a temporary copy of the comp, removed again) on every frame or every `step`th (at most 3000), takes a ring just outside the patch region (moved per frame by the optional `track`) and fits per channel the gain and offset that map the ring at `ref_time` onto the ring at each frame, pixel-aligned through the track (least squares, 10% trimmed so a person walking through the ring does not skew it, clipped pixels left out). " +
      "The curves are smoothed (`smooth_frames`), thinned to the keys linear interpolation needs (within 0.5/255) and keyed on a Levels (Individual Controls) effect (`effect: 'levels'`) or Exposure (`'exposure'`, gain in stops) named 'Chroma drift match' on the patch layer, placed before any pin. A frame with less than `min_ring_visible` of the ring in view, or the track lost, gets no key and is listed. " +
      "Long shots are measured in chunks: when the render budget runs out the result has `continue_id` and the measured ring statistics are saved; call again with it, and the call that finishes writes the keys (one undo step) and, with `verify`, renders the composite on up to 8 frames and reports the seam colour difference before and after. " +
      "`dry_run` returns the curves, the flicker of the shot (luma swing of the ring) and a gain graph PNG and writes nothing to the patch. The fits are on 8-bit colour-managed snapshots: in linear or 32 bpc projects the Levels mapping is approximate (the result says so and reports the project's bit depth and blending); prefer 'exposure' there. Curves and Color Stabilizer are not used (their data cannot be set by script). Parameter names are mapped at runtime and the table used is returned. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AePatchColorMatchSchema,
    handler: async (args: AePatchColorMatchArgs, ctx) => {
      try {
        return await colorMatchHandler(args, ctx);
      } catch (err) {
        if (err instanceof PlanarError) return fail(err);
        throw err;
      }
    },
  },
  {
    name: "ae_patch_grain",
    description:
      "Measures and matches grain so a frozen patch does not look dead. Measures per channel spatial noise sigma in the plate's ring (plate render) and inside the patch (composite), and temporal sigma on the next frame aligned through the track: temporal sigma near 0 in the patch while the plate's is not is the frozen-grain tell. " +
      "Then, in one undo step: optionally degrains the patch (`degrain`: Median radius 1, or Remove Grain with Final Output), adds an adjustment layer '<patch> GRAIN' directly above the patch, track-matted to its alpha (AE 23+; the grain does not move with a pin), and puts Add Grain ('VISINF Grain Implant', Final Output, Intensity from the measured sigma through a calibration curve for Add Grain, 1 for Match Grain (it samples the plate's own noise), Animation Speed 1, a random seed) or Match Grain on it. " +
      "Then up to `rounds` (default 2, max 3) tuning rounds, each its own undo step: render, measure the patch against the plate, scale Intensity by the ratio. With degrain 'none' the patch still holds its own frozen spatial grain, so the rounds compare the moving (temporal) grain, which is what the frozen grain lacks; with a degrain they compare the spatial sigma. Returns sigma before and after per channel, the temporal ratio, the rounds and a 2x preview PNG (plate ring left, composite right). " +
      "A plate whose sigma is under `min_sigma` is clean and gets no grain. Viewing Mode must be Final Output, the last menu item (Preview renders a small box, Blending Matte a matte image): the tool sets it (Add Grain 3, Match Grain 5, Remove Grain 4; unmeasured on AE 26), checks the index against the menu's range first and reads it back; `viewing_mode_index` and `degrain_viewing_mode_index` override the item numbers. If setTrackMatte switches the patch layer off the tool switches it back on and says so. Add Grain has no 32-bpc support; the result warns. Size is `grain_size` (its unit is unmeasured). With degrain 'none' the patch's frozen grain stays under the new grain, so the total spatial grain can end above the plate's (up to about 1.4x for a patch as grainy as the plate); the result then says so, and degrain removes the excess. `dry_run` measures only. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AePatchGrainSchema,
    handler: async (args: AePatchGrainArgs, ctx) => {
      try {
        return await grainHandler(args, ctx);
      } catch (err) {
        if (err instanceof PlanarError) return fail(err);
        throw err;
      }
    },
  },
  {
    name: "ae_patch_finish",
    description:
      "Sets the remaining 'sit-in' properties of a patch from the shot, in one undo step after a measurement. Sharpness: compares the Laplacian energy of the patch interior with the plate's in the ring on sampled frames and finds the Gaussian sigma that brings the patch to the plate's detail; keys (or sets) Gaussian Blur 'Chroma sit-in blur' Blurriness, placed before any pin (Blurriness is estimated as 2.5 x sigma until calibrated live). " +
      "Edge: scores the seam on the composite and, if it is over `seam_max` and the patch layer has masks, raises their Mask Feather and keeps Mask Expansion at least half of it. " +
      "Motion blur: from the track's speed and the shutter (the comp's, or `shutter_angle`) it turns on layer motion blur for a patch moved by its transform, or adds CC Force Motion Blur after the pin for a pinned one; switching the comp's motion blur or shutter angle affects every layer, so it is only reported unless `allow_comp_change`. It cannot see object motion inside the patch. " +
      "Blur sigma and mask feather are measured in comp pixels and converted to the layer's own pixels through the layer's Scale and its parents' (the scale at the comp's current time); a pin effect's own scale and 3D or camera scale are not measured, and the result warns for a pinned layer. Also sets sampling quality bicubic, frame blending off and quality best (`quality`). Returns what was measured, what was set, and before/after crops. `dry_run` returns the plan only. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AePatchFinishSchema,
    handler: async (args: AePatchFinishArgs, ctx) => {
      try {
        return await finishHandler(args, ctx);
      } catch (err) {
        if (err instanceof PlanarError) return fail(err);
        throw err;
      }
    },
  },
];
