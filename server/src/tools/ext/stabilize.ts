/**
 * server/src/tools/ext/stabilize.ts
 *
 * Stabilizing a plate from a track the planar tools made, inside the MCP and
 * After Effects (no outside tools):
 * - ae_stabilize: lock (the reference frame's framing is held), smooth (only
 *   the jitter goes: the plate gets S(t) . H(t)^-1) or position_only, written
 *   as layer-transform keys (Anchor Point = the tracked pivot in layer space,
 *   Position, Rotation, Scale: how AE's own Stabilize writes), as a Transform
 *   effect (the layer's own transform stays free) or as Corner Pin keys
 *   (perspective tracks). Edges: none, scale_to_fill (the smallest zoom about
 *   the comp centre that keeps the comp covered, folded into the keys) or
 *   motion_tile (a Motion Tile with Mirror Edges in front). A render budget
 *   pays for before/after contact sheets and for the residual-motion check:
 *   the points are found again on the stabilized render by normalized
 *   cross-correlation and compared with where the stabilizing says they sit.
 * - ae_stabilize_roundtrip: a padded work comp holding a steady copy of the
 *   plate (a guide layer), placed above the plate with the exact inverse
 *   motion, so patches painted on a steady image ride the shot and the
 *   original plate is never resampled. `remove` takes a rig out again.
 *
 * Not built: Warp Stabilizer VFX (its analysis cannot be started, waited for
 * or read by script). Smoothing pads the trajectory by odd reflection at both
 * ends, so the first and last frames do not drift.
 *
 * Unmeasured on AE 26: the Transform effect's and Motion Tile's parameter
 * names (mapped by display name with an index fallback; the table used is
 * returned), whether a Motion Tile that grows its output keeps the layer's
 * pixel coordinates, whether moveTo takes the index as written, Anchor Point
 * on non-square footage (refused), and whether a guide layer in a nested comp
 * is left out of the parent's render and of saveFrameToPng.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { PNG } from "pngjs";
import { z } from "zod";
import { BridgeError, SLOW_TIMEOUT_MS } from "../../host.js";
import { buildJsxCall } from "../../jsx.js";
import { QueueWaitError } from "../../queue.js";
import type { ReceiptMismatch } from "../../receipts.js";
import { AGENT_SAFETY_GUIDANCE, ExpectSchema, LayerSelectorSchema, type ExpectGuard, type LayerSelector, type ToolContext, type ToolDefinition } from "../common.js";
import { defaultFramesDir } from "../render.js";
import { captureCompFrame, decodePngFile } from "./frames.js";
import {
  buildLayerKeys,
  createRenderBudget,
  keyMismatches,
  PlanarError,
  resolveEffectParams,
  resolveTrackSourceWithInfo,
  saveTrack,
  TrackSourceSchema,
  type LayerKeys,
  type LayerSample,
} from "./planar.js";
import {
  applyH,
  decomposeLayerMatrix,
  frameAt,
  invertH,
  layerMatrix,
  mulH,
  rectQuad,
  relativeTo,
  smoothFrames,
  solveModel,
  translationH,
  unwrapDegrees,
  type Mat3,
  type PlanarFrame,
  type PlanarTrack,
  type Vec2,
} from "./planar-math.js";
import { blit, createCanvas, drawCross, drawLabel, drawPolygon, encodePng, fitWithin, resizeArea, type RgbaImage } from "./png-utils.js";
import { extractPatch, makeTemplate, matchTemplate, toGray, type GrayImage } from "./track.js";
import { expectThat, runGuardedWrite } from "./write-runner.js";

// ---------- small helpers ----------

const r2 = (v: number): number => Math.round(v * 100) / 100;
const r4 = (v: number): number => Math.round(v * 10000) / 10000;
const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const yieldLoop = () => new Promise<void>((r) => setImmediate(r));
const fail = (e: unknown) => ({ ok: false as const, error: (e as PlanarError).code, message: (e as Error).message });

/** Keys per property one call writes (the host's limit too). */
export const MAX_KEYS = 3000;
/** The residual the lock mode aims for, in comp pixels (rms). */
export const RESIDUAL_TARGET_PX = 0.5;
const RIG_SCOPE = "ae_stabilize_roundtrip";

async function queued<T>(ctx: ToolContext, label: string, opId: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await ctx.queue.run(label, fn);
  } catch (err) {
    if (err instanceof QueueWaitError) throw new BridgeError({ kind: "queued", op_id: opId, message: err.message });
    throw err;
  }
}

/** A read-only host call inside a queue lease the caller already holds. */
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

// ---------- effect parameters ----------

type Wanted = Record<string, { names: string[]; index?: number }>;

/** The Transform effect ('ADBE Geometry2'): resolved by English display name at run time, index as the fallback. */
export const TRANSFORM_FX_PARAMS: Wanted = {
  anchor: { names: ["Anchor Point"], index: 1 },
  position: { names: ["Position"], index: 2 },
  uniform: { names: ["Uniform Scale"], index: 3 },
  scaleH: { names: ["Scale Height", "Scale"], index: 4 },
  scaleW: { names: ["Scale Width"], index: 5 },
  rotation: { names: ["Rotation"], index: 8 },
  /** The effect's own resampling popup (1 Bilinear, 2 Bicubic; the layer's sampling quality does not reach it). */
  sampling: { names: ["Sampling"], index: 12 },
  shutterUse: { names: ["Use Composition's Shutter Angle", "Use Comp's Shutter Angle"], index: 10 },
  shutter: { names: ["Shutter Angle"], index: 11 },
};

/** Motion Tile ('ADBE Tile'). */
export const TILE_FX_PARAMS: Wanted = {
  outW: { names: ["Output Width"], index: 4 },
  outH: { names: ["Output Height"], index: 5 },
  mirror: { names: ["Mirror Edges"], index: 6 },
};

interface ParamRow {
  index: number;
  name: string;
  matchName: string;
  type: string;
  role?: string;
}

/** The host's mapping against resolveEffectParams on the table it returned: they must agree, or the table is not what the host used. */
export function paramTableAgrees(table: ParamRow[] | undefined, wanted: Wanted): boolean {
  if (!table) return true;
  const resolved = resolveEffectParams(table, wanted);
  for (const [key, idx] of Object.entries(resolved)) {
    const roles = table.filter((r) => (r.role ?? "").split("+").includes(key)).map((r) => r.index);
    if (idx === null ? roles.length > 0 : !roles.includes(idx)) return false;
  }
  return true;
}

// ---------- the pure maths ----------

export type StabMode = "lock" | "smooth" | "position_only";
export type StabTarget = "layer_transform" | "transform_effect" | "corner_pin";
export type StabEdges = "none" | "scale_to_fill" | "motion_tile";

/** The centroid of the track's reference points, or the comp centre without points: where the stabilizing is pinned. */
export function pivotOf(track: PlanarTrack): Vec2 {
  const pts = track.ref_points;
  if (!pts.length) return [track.comp_size[0] / 2, track.comp_size[1] / 2];
  return [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
}

/**
 * Smooths the track like smoothFrames, after padding both ends by odd
 * reflection of the four corners' trajectories (the corner at k frames past the
 * end is mirrored through the end point), so the Gaussian window is full at the
 * ends and the first and last frames do not drift toward the middle.
 */
export function smoothWithMirror(track: PlanarTrack, sigmaFrames: number): PlanarTrack {
  const n = track.frames.length;
  if (!(sigmaFrames > 0) || n < 3) return smoothFrames(track, sigmaFrames);
  const pad = Math.min(n - 1, Math.ceil(sigmaFrames * 3));
  const corners = rectQuad(track.comp_size[0], track.comp_size[1]);
  const dt = 1 / (track.fps > 0 ? track.fps : 25);
  const moved = (f: PlanarFrame): Vec2[] | null => {
    if (!f.ok || !f.H) return null;
    const out: Vec2[] = [];
    for (const c of corners) {
      const p = applyH(f.H, c);
      if (!p) return null;
      out.push(p);
    }
    return out;
  };
  const unsolved = (time: number): PlanarFrame => ({ time, ok: false, H: null, points: [], confidence: [], rms_px: null, inliers: 0, note: "mirror padding of an unsolved frame" });
  const mirror = (src: PlanarFrame, anchor: Vec2[] | null, time: number): PlanarFrame => {
    const m = moved(src);
    if (!m || !anchor) return unsolved(time);
    const reflected = m.map((p, i) => [2 * anchor[i][0] - p[0], 2 * anchor[i][1] - p[1]] as Vec2);
    const sol = solveModel(track.model, corners, reflected);
    if (!sol) return unsolved(time);
    return { time, ok: true, H: sol.H, points: [], confidence: [], rms_px: 0, inliers: 0 };
  };
  const first = track.frames[0];
  const last = track.frames[n - 1];
  const aFirst = moved(first);
  const aLast = moved(last);
  const head: PlanarFrame[] = [];
  for (let k = pad; k >= 1; k--) head.push(mirror(track.frames[k], aFirst, first.time - k * dt));
  const tail: PlanarFrame[] = [];
  for (let k = 1; k <= pad; k++) tail.push(mirror(track.frames[n - 1 - k], aLast, last.time + k * dt));
  const smoothed = smoothFrames({ ...track, frames: [...head, ...track.frames, ...tail] }, sigmaFrames);
  return { ...smoothed, frames: smoothed.frames.slice(pad, pad + n) };
}

export interface CorrFrame {
  time: number;
  /** The track's motion at this frame: reference comp px -> comp px. */
  H: Mat3;
  /** The correction applied to the plate, in comp space (comp px -> comp px). */
  D: Mat3;
}

export interface Correction {
  frames: CorrFrame[];
  /** Frame times the track could not solve. */
  not_ok: number[];
  /** Frame times whose correction could not be built (a singular H, a point behind the plane). */
  degenerate: number[];
}

/**
 * The correction per frame. `track` has the reference frame as the identity.
 * lock: D = H^-1. smooth: D = S . H^-1 with S the smoothed track (so the plate
 * keeps the smoothed motion and loses the jitter). position_only: the plate
 * moves back by the pivot's displacement only.
 */
export function correctionFrames(a: { track: PlanarTrack; mode: StabMode; smoothFrames: number; pivot: Vec2; range?: { start: number; end: number } }): Correction {
  const { track } = a;
  const half = 0.5 / (track.fps > 0 ? track.fps : 25);
  const smooth = a.mode === "smooth" ? smoothWithMirror(track, a.smoothFrames) : null;
  const out: Correction = { frames: [], not_ok: [], degenerate: [] };
  track.frames.forEach((f, i) => {
    if (a.range && (f.time < a.range.start - half || f.time > a.range.end + half)) return;
    if (!f.ok || !f.H) {
      out.not_ok.push(f.time);
      return;
    }
    let D: Mat3 | null = null;
    if (a.mode === "lock") {
      D = invertH(f.H);
    } else if (a.mode === "position_only") {
      const q = applyH(f.H, a.pivot);
      D = q ? translationH(a.pivot[0] - q[0], a.pivot[1] - q[1]) : null;
    } else {
      const s = smooth?.frames[i];
      const inv = invertH(f.H);
      D = s && s.ok && s.H && inv ? mulH(s.H, inv) : null;
    }
    if (!D || !D.every(Number.isFinite)) {
      out.degenerate.push(f.time);
      return;
    }
    out.frames.push({ time: f.time, H: f.H, D });
  });
  return out;
}

/** Uniform zoom by z about a point. */
export const zoomAbout = (z: number, c: Vec2): Mat3 => [z, 0, c[0] * (1 - z), 0, z, c[1] * (1 - z), 0, 0, 1];

/** True when, at zoom z about the comp centre, the comp rectangle lies inside the plate on every frame. `base` is the plate's layer -> comp matrix at the reference. */
export function coversComp(frames: Array<{ D: Mat3 }>, base: Mat3, layer: Vec2, comp: Vec2, z: number): boolean {
  const Z = zoomAbout(z, [comp[0] / 2, comp[1] / 2]);
  const corners = rectQuad(comp[0], comp[1]);
  const eps = 0.01;
  for (const f of frames) {
    const inv = invertH(mulH(Z, mulH(f.D, base)));
    if (!inv) return false;
    for (const c of corners) {
      const p = applyH(inv, c);
      if (!p) return false;
      if (p[0] < -eps || p[0] > layer[0] + eps || p[1] < -eps || p[1] > layer[1] + eps) return false;
    }
  }
  return true;
}

const MAX_SEARCH_ZOOM = 64;

/**
 * The smallest uniform zoom about the comp centre that keeps the comp covered
 * on every frame: the comp corners are mapped through the inverse of the
 * stabilized plate and tested against the plate's bounds (for a Corner Pin D
 * that is the warped quad). Coverage only gets easier with more zoom, so it is
 * found by bisection. Not coverable when even 64x leaves a gap (the comp centre
 * is off the plate on some frame).
 */
export function fillZoom(frames: Array<{ D: Mat3 }>, base: Mat3, layer: Vec2, comp: Vec2): { zoom: number; coverable: boolean } {
  if (coversComp(frames, base, layer, comp, 1)) return { zoom: 1, coverable: true };
  if (!coversComp(frames, base, layer, comp, MAX_SEARCH_ZOOM)) return { zoom: MAX_SEARCH_ZOOM, coverable: false };
  let lo = 1;
  let hi = MAX_SEARCH_ZOOM;
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    if (coversComp(frames, base, layer, comp, mid)) hi = mid;
    else lo = mid;
  }
  return { zoom: Math.ceil(hi * 1000) / 1000, coverable: true };
}

export interface TileExtents {
  /** How far the comp reaches past each plate edge, in layer pixels, at the worst frame. */
  left: number;
  right: number;
  top: number;
  bottom: number;
  needed: boolean;
}

/** How far beyond the plate the stabilized comp rectangle reaches, over all frames (layer pixels). Null when no frame could be mapped. */
export function tileExtents(frames: Array<{ D: Mat3 }>, base: Mat3, layer: Vec2, comp: Vec2): TileExtents | null {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const corners = rectQuad(comp[0], comp[1]);
  for (const f of frames) {
    const inv = invertH(mulH(f.D, base));
    if (!inv) continue;
    for (const c of corners) {
      const p = applyH(inv, c);
      if (!p) continue;
      minX = Math.min(minX, p[0]);
      maxX = Math.max(maxX, p[0]);
      minY = Math.min(minY, p[1]);
      maxY = Math.max(maxY, p[1]);
    }
  }
  if (!Number.isFinite(minX)) return null;
  const left = Math.max(0, -minX);
  const right = Math.max(0, maxX - layer[0]);
  const top = Math.max(0, -minY);
  const bottom = Math.max(0, maxY - layer[1]);
  return { left, right, top, bottom, needed: Math.max(left, right, top, bottom) > 0.01 };
}

/** Motion Tile's Output Width/Height in percent of the layer, symmetric about the tile centre (the layer centre), with a 2 px margin. */
export function tileOutputPct(layer: Vec2, ext: TileExtents): { w: number; h: number } {
  const ex = Math.max(ext.left, ext.right) + 2;
  const ey = Math.max(ext.top, ext.bottom) + 2;
  // Rounded up to 0.01 %, with a hair of slack so that 112.0000000001 stays 112.
  const up = (v: number) => Math.ceil(v * 100 - 1e-6) / 100;
  return { w: up(((layer[0] + 2 * ex) / layer[0]) * 100), h: up(((layer[1] + 2 * ey) / layer[1]) * 100) };
}

export interface TransformKeys {
  times: number[];
  anchor: Vec2[];
  position: Vec2[];
  rotation: number[];
  scale: Vec2[];
  /** Frame times that could not be turned into keys. */
  skipped: number[];
  /** Largest distance (px) between the exact matrix and what the keys reproduce: a similarity fit of an affine/perspective track, or shear. */
  max_fit_px: number;
}

/**
 * Layer-transform (or Transform-effect) keys that give each frame the matrix
 * F . base. `base` maps the layer's (or effect's) pixels to the container
 * space before the correction F. In `pivot` mode the Anchor Point follows the
 * tracked pivot (base^-1 of its raw position in container space), as AE's own
 * Stabilize writes it, and Position = F . base . anchor; in `fixed` mode the
 * anchor stays. With `fitCorners` F is first replaced by its best similarity
 * over those points.
 */
export function buildTransformKeys(a: {
  base: Mat3;
  frames: Array<{ time: number; F: Mat3; pivot: Vec2 }>;
  anchorMode: "pivot" | "fixed";
  fixedAnchor?: Vec2;
  size: Vec2;
  fitCorners?: Vec2[];
}): TransformKeys {
  const bInv = a.anchorMode === "pivot" ? invertH(a.base) : null;
  const layerCorners = rectQuad(a.size[0], a.size[1]);
  const out: TransformKeys = { times: [], anchor: [], position: [], rotation: [], scale: [], skipped: [], max_fit_px: 0 };
  let maxFit = 0;
  for (const f of a.frames) {
    let F = f.F;
    if (a.fitCorners) {
      const moved = a.fitCorners.map((c) => applyH(F, c));
      const fit = moved.every((m) => m !== null) ? solveModel("similarity", a.fitCorners, moved as Vec2[]) : null;
      if (!fit) {
        out.skipped.push(f.time);
        continue;
      }
      maxFit = Math.max(maxFit, fit.max_px);
      F = fit.H;
    }
    let anchor: Vec2 | null;
    if (a.anchorMode === "pivot") anchor = bInv ? applyH(bInv, f.pivot) : null;
    else anchor = a.fixedAnchor ?? [0, 0];
    if (!anchor) {
      out.skipped.push(f.time);
      continue;
    }
    const N = mulH(F, a.base);
    const dec = decomposeLayerMatrix(N, anchor);
    const M2 = layerMatrix({ anchor, position: dec.position, scale_pct: dec.scale_pct, rotation_deg: dec.rotation_deg });
    for (const c of layerCorners) {
      const p1 = applyH(N, c);
      const p2 = applyH(M2, c);
      if (p1 && p2) maxFit = Math.max(maxFit, Math.hypot(p1[0] - p2[0], p1[1] - p2[1]));
    }
    out.times.push(f.time);
    out.anchor.push([r4(anchor[0]), r4(anchor[1])]);
    out.position.push([r4(dec.position[0]), r4(dec.position[1])]);
    out.rotation.push(dec.rotation_deg);
    out.scale.push([r4(dec.scale_pct[0]), r4(dec.scale_pct[1])]);
  }
  out.rotation = unwrapDegrees(out.rotation).map(r4);
  out.max_fit_px = r2(maxFit);
  return out;
}

/** The layer -> parent matrix the keys give at index i. */
export function transformKeysMatrix(k: TransformKeys, i: number): Mat3 {
  return layerMatrix({ anchor: k.anchor[i], position: k.position[i], scale_pct: k.scale[i], rotation_deg: k.rotation[i] });
}

/**
 * How far (px) outer . inner is from the plate's own placement `plate`, over the
 * plate's corners, at every key both share. Zero means the work comp brings
 * every point back to where the plate has it.
 */
export function roundtripError(inner: TransformKeys, outer: TransformKeys, plate: Mat3, size: Vec2): number {
  const corners = rectQuad(size[0], size[1]);
  let worst = 0;
  for (let i = 0; i < inner.times.length; i++) {
    const j = outer.times.findIndex((t) => Math.abs(t - inner.times[i]) < 1e-9);
    if (j < 0) continue;
    const composed = mulH(transformKeysMatrix(outer, j), transformKeysMatrix(inner, i));
    for (const c of corners) {
      const p = applyH(composed, c);
      const q = applyH(plate, c);
      if (p && q) worst = Math.max(worst, Math.hypot(p[0] - q[0], p[1] - q[1]));
    }
  }
  return worst;
}

/** The frames a sheet shows: the first, the reference, the last and the one where the pivot is moved furthest. */
export function pickSheetTimes(frames: Array<{ time: number; H: Mat3 }>, pivot: Vec2, refTime: number): { first: number; ref: number; last: number; worst: number } {
  let ref = frames[0].time;
  let worst = frames[0].time;
  let worstD = -1;
  for (const f of frames) {
    if (Math.abs(f.time - refTime) < Math.abs(ref - refTime)) ref = f.time;
    const p = applyH(f.H, pivot);
    const d = p ? Math.hypot(p[0] - pivot[0], p[1] - pivot[1]) : 0;
    if (d > worstD) {
      worstD = d;
      worst = f.time;
    }
  }
  return { first: frames[0].time, ref, last: frames[frames.length - 1].time, worst };
}

/** n times spread evenly over `times` (both ends included), as a sorted unique list. */
export function evenSamples(times: number[], n: number): number[] {
  if (times.length <= n) return [...times];
  const out = new Set<number>();
  for (let i = 0; i < n; i++) out.add(times[Math.round((i * (times.length - 1)) / Math.max(1, n - 1))]);
  return [...out].sort((x, y) => x - y);
}

// ---------- residual motion on the stabilized render ----------

export interface ResidualInput {
  /** Image pixels per comp pixel (the snapshots are half size). */
  scale: number;
  /** The reference render and where each point sits in it (comp px). */
  ref: { image: GrayImage; expected: Vec2[] };
  /** Renders at other times, with where each point should sit (comp px; null = the track lost it there). */
  samples: Array<{ time: number; image: GrayImage; expected: Array<Vec2 | null> }>;
  /** Pattern side in comp px. Default 31. */
  patchComp?: number;
  /** Search radius in comp px. Default 8. */
  radiusComp?: number;
  /** A match below this score is not counted. Default 0.5. */
  minScore?: number;
}

export interface Residual {
  /** Points (0-based) with a usable pattern. */
  points_used: number[];
  per_frame: Array<{ time: number; rms_px: number | null; points: number; unmatched: number }>;
  rms_px: number | null;
  max_px: number | null;
  frames_measured: number;
  unmatched: number;
}

/**
 * Finds every point again on the stabilized renders with normalized cross-
 * correlation (the pattern comes from the stabilized reference render, so a
 * zoom or an effect does not matter) and measures the distance, in comp
 * pixels, between where it is found and where the stabilizing says it should
 * be. Sub-pixel by the tracker's parabola; the half-size renders limit it to a
 * fraction of a pixel.
 */
export function measureResidual(a: ResidualInput): Residual {
  const s = a.scale;
  const size = Math.max(9, Math.round((a.patchComp ?? 31) * s) | 1);
  const radius = Math.max(2, Math.ceil((a.radiusComp ?? 8) * s));
  const minScore = a.minScore ?? 0.5;
  // Each pattern is cut at the whole pixel nearest the point, and `delta` is how far the point is from that
  // pixel: a pattern cut at a fraction of a pixel is blurred by the interpolation and would bias the match.
  const deltas: Vec2[] = [];
  const templates = a.ref.expected.map((p) => {
    const cx = p[0] * s - 0.5;
    const cy = p[1] * s - 0.5;
    const ix = Math.round(cx);
    const iy = Math.round(cy);
    deltas.push([cx - ix, cy - iy]);
    const patch = extractPatch(a.ref.image, ix, iy, size);
    if (!patch) return null;
    const t = makeTemplate(patch);
    return t.std >= 3 ? t : null;
  });
  const used = templates.map((t, i) => (t ? i : -1)).filter((i) => i >= 0);
  const perFrame: Residual["per_frame"] = [];
  let sq = 0;
  let count = 0;
  let max = 0;
  let unmatched = 0;
  for (const smp of a.samples) {
    let fsq = 0;
    let fcount = 0;
    let fun = 0;
    for (const i of used) {
      const exp = smp.expected[i];
      const tpl = templates[i];
      if (!exp || !tpl) continue;
      const m = matchTemplate(smp.image, tpl, exp[0] * s - 0.5, exp[1] * s - 0.5, radius);
      if (!m || m.score < minScore) {
        fun++;
        continue;
      }
      const found: Vec2 = [(m.x + deltas[i][0] + 0.5) / s, (m.y + deltas[i][1] + 0.5) / s];
      const d = Math.hypot(found[0] - exp[0], found[1] - exp[1]);
      fsq += d * d;
      fcount++;
      max = Math.max(max, d);
    }
    unmatched += fun;
    sq += fsq;
    count += fcount;
    perFrame.push({ time: smp.time, rms_px: fcount ? r4(Math.sqrt(fsq / fcount)) : null, points: fcount, unmatched: fun });
  }
  return {
    points_used: used,
    per_frame: perFrame,
    rms_px: count ? r4(Math.sqrt(sq / count)) : null,
    max_px: count ? r4(max) : null,
    frames_measured: perFrame.filter((f) => f.rms_px !== null).length,
    unmatched,
  };
}

// ---------- contact sheets ----------

export interface SheetTile {
  image: RgbaImage;
  label: string;
  /** Crosses, in comp px. */
  marks?: Vec2[];
  /** A closed outline, in comp px (the test patch of the roundtrip). */
  outline?: Vec2[] | null;
}

/** Tiles side by side, each shrunk to `maxTile`, with the marks (cyan crosses) and the outline (green). */
export function drawStabSheet(tiles: SheetTile[], compSize: Vec2, maxTile = 480): PNG {
  const cyan: [number, number, number, number] = [0, 220, 255, 255];
  const green: [number, number, number, number] = [80, 255, 120, 255];
  const drawn: PNG[] = tiles.map((t) => {
    const fit = fitWithin(t.image.width, t.image.height, maxTile);
    const img = resizeArea(t.image, fit.width, fit.height);
    const k = fit.width / compSize[0];
    for (const m of t.marks ?? []) drawCross(img, m[0] * k, m[1] * k, 5, 1, cyan);
    if (t.outline && t.outline.length >= 3) drawPolygon(img, t.outline.map((c) => [c[0] * k, c[1] * k] as [number, number]), 2, green);
    drawLabel(img, t.label, 3, 3, 1, [16, 16, 16, 255], [255, 214, 0, 255], 2);
    return img;
  });
  const gap = 4;
  const width = drawn.reduce((s, d) => s + d.width, 0) + gap * Math.max(0, drawn.length - 1);
  const height = Math.max(...drawn.map((d) => d.height));
  const sheet = createCanvas(width, height, [24, 24, 24, 255]);
  let x = 0;
  for (const d of drawn) {
    blit(sheet, d, x, 0);
    x += d.width + gap;
  }
  return sheet;
}

function writeSheet(dir: string, tag: string, png: PNG): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `stabilize_${tag}.png`);
  fs.writeFileSync(file, encodePng(png));
  return file;
}

/** Mean absolute luma difference (0..255) between two same-size renders; null when the sizes differ. */
export function meanAbsDiff(a: GrayImage, b: GrayImage): number | null {
  if (a.width !== b.width || a.height !== b.height) return null;
  let sum = 0;
  for (let i = 0; i < a.data.length; i++) sum += Math.abs(a.data[i] - b.data[i]);
  return r4(sum / a.data.length);
}

// ---------- the plan for ae_stabilize ----------

/** What stabilizeInspect returns. */
export interface Inspect {
  comp: { id: number; name: string; width: number; height: number; pixel_aspect: number; fps: number; frame_duration: number; duration: number; motion_blur: boolean; num_layers: number };
  layer: {
    index: number;
    id: number;
    name: string;
    locked: boolean;
    three_d: boolean;
    parent: { index: number; id: number; name: string } | null;
    has_video: boolean;
    width: number | null;
    height: number | null;
    source_id: number | null;
    source_pixel_aspect: number;
    time_remap: boolean;
    start_time: number | null;
    in_point: number;
    out_point: number;
    stretch: number | null;
    num_masks: number;
    guide: boolean;
    motion_blur: boolean;
    bicubic: boolean;
    separated_position: boolean;
    /** Auto-Orient Along Path is on; absent from an older host. */
    auto_orient?: boolean;
  };
  transform: { anchor: Vec2; position: Vec2; scale: Vec2; rotation: number } | null;
  keys: Record<string, number>;
  expressions: string[];
  effects: Array<{ index: number; name: string; matchName: string }>;
  effects_truncated: boolean;
  num_effects: number;
}

export interface PlanArgs {
  mode: StabMode;
  smooth_frames: number;
  pivot?: Vec2;
  target: StabTarget;
  edges: StabEdges;
  max_zoom: number;
  range?: { start: number; end: number };
}

export interface StabilizePlan {
  target: StabTarget;
  mode: StabMode;
  ref_time: number;
  pivot: Vec2;
  /** The frames that get a key, with the correction as written (zoom folded in). */
  frames: Array<{ time: number; H: Mat3; D: Mat3 }>;
  not_ok: number[];
  skipped: number[];
  zoom: number | null;
  tile: { output_w_pct: number; output_h_pct: number; extents: TileExtents } | null;
  transform?: TransformKeys;
  pin?: LayerKeys;
  max_fit_px: number;
  notes: string[];
}

/** The layer's ref-time placement as a LayerSample (no parents: parented plates are refused). */
export function plateSample(ins: Inspect, time: number): LayerSample {
  const t = ins.transform!;
  const full = layerMatrix({ anchor: t.anchor, position: t.position, scale_pct: t.scale, rotation_deg: t.rotation });
  return { time, anchor: t.anchor, position: t.position, scale_pct: t.scale, rotation_deg: t.rotation, parents: [1, 0, 0, 0, 1, 0, 0, 0, 1], full };
}

/** Refusals that can be seen before anything is written. Throws a PlanarError. */
export function checkPlate(ins: Inspect, a: { target: StabTarget; replace_keys?: boolean; compSize: Vec2; rig?: boolean; tile?: boolean }): void {
  const l = ins.layer;
  const name = `Layer "${l.name}"`;
  if (l.locked) throw new PlanarError("refused", `${name} is locked.`);
  if (l.three_d) throw new PlanarError("refused", `${name} is a 3D layer; stabilizing works in 2D only.`);
  if (l.parent) throw new PlanarError("refused", `${name} has a parent ("${l.parent.name}"); unparent it first, the stabilizing keys would be in the parent's space.`);
  if (!l.has_video) throw new PlanarError("refused", `${name} has no video.`);
  if (!(Number(ins.comp.pixel_aspect) > 0) || Math.abs(Number(ins.comp.pixel_aspect) - 1) > 1e-6) {
    throw new PlanarError("refused", `The comp's pixel aspect is ${ins.comp.pixel_aspect}, not 1. Stabilizing works on square pixels only.`);
  }
  if (Math.abs(l.source_pixel_aspect - 1) > 1e-6) {
    throw new PlanarError("refused", `${name}'s footage has a pixel aspect of ${l.source_pixel_aspect}, not 1; Anchor Point is not safe on non-square pixels. Interpret the footage as square first.`);
  }
  if (ins.comp.width !== a.compSize[0] || ins.comp.height !== a.compSize[1]) {
    throw new PlanarError("refused", `The track was made in a ${a.compSize[0]}x${a.compSize[1]} comp and comp ${ins.comp.id} is ${ins.comp.width}x${ins.comp.height}: the points are in comp pixels, so the sizes must match.`);
  }
  if (!ins.transform) throw new PlanarError("not_found", `${name} has no Transform group.`);
  if (!(l.width && l.height && l.width > 0 && l.height > 0)) {
    throw new PlanarError("refused", `${name} has no width and height (it is not a footage, solid or comp layer), so its bounds are unknown.`);
  }
  if (a.target === "layer_transform") {
    if (l.auto_orient === true) throw new PlanarError("refused", `${name} has Auto-Orient on, which would turn the plate along the written Position keys on top of the Rotation keys; set Auto-Orient to Off first.`);
    if (l.separated_position) throw new PlanarError("refused", `${name} has separated Position dimensions; join them (Separate Dimensions off) first.`);
    const keyed = Object.entries(ins.keys).filter(([, n]) => n > 0);
    if (keyed.length > 0 && !a.replace_keys) {
      throw new PlanarError("refused", `${name} already has keys on ${keyed.map(([k]) => k).join(", ")}. Pass replace_keys to replace them, or use target transform_effect to leave its own transform alone.`);
    }
    if (ins.expressions.length > 0) {
      throw new PlanarError("refused", `${name} has expressions on ${ins.expressions.join(", ")}, which would override the keys. Remove them first, or use target transform_effect.`);
    }
  }
  if (a.target !== "layer_transform" && !a.rig) {
    // The track measured the rendered motion, which includes the layer's own animation; these targets assume the plate sits still.
    const keyed = Object.entries(ins.keys).filter(([, n]) => n > 0);
    if (keyed.length > 0) {
      throw new PlanarError("refused", `${name} has keys on ${keyed.map(([k]) => k).join(", ")}; the track measured that animation too, so the correction would be wrong on every frame where the layer has moved. Remove or bake the keys first (after an earlier ae_stabilize on layer_transform: undo it).`);
    }
    if (ins.expressions.length > 0) {
      throw new PlanarError("refused", `${name} has expressions on ${ins.expressions.join(", ")}; the track measured that motion too, so the correction would be wrong. Remove the expressions first.`);
    }
  }
  if (a.target === "corner_pin" && !a.rig && ins.effects.some((e) => e.matchName === "ADBE Corner Pin")) {
    throw new PlanarError("refused", `${name} already has a Corner Pin; ae_stabilize would key over it, or double a pin it wrote earlier. Remove it first, or use target transform_effect.`);
  }
  if (a.target === "transform_effect" && !a.rig && ins.effects.some((e) => e.matchName === "ADBE Geometry2" && /^Stabilize Transform/.test(e.name))) {
    throw new PlanarError("refused", `${name} already has a "Stabilize Transform" effect from an earlier ae_stabilize; a second one would double the correction. Remove it (or undo) first.`);
  }
  if (a.tile && !a.rig && ins.effects.some((e) => e.matchName === "ADBE Tile" && /^Stabilize Tile/.test(e.name))) {
    throw new PlanarError("refused", `${name} already has a "Stabilize Tile" effect from an earlier ae_stabilize; a second one would stack. Remove it (or undo) first.`);
  }
  if (a.target === "transform_effect") {
    const s = ins.transform.scale;
    if (Math.abs(s[0] - s[1]) > 1e-4 * Math.max(1, Math.abs(s[0]))) {
      throw new PlanarError("refused", `${name} has a non-uniform Scale (${r2(s[0])}, ${r2(s[1])}); the Transform effect would need a skew. Use target layer_transform.`);
    }
  }
}

/**
 * Everything ae_stabilize writes, worked out without touching AE. `track` is
 * relative to the reference (identity there); `ins` is the plate as read.
 */
export function planStabilize(track: PlanarTrack, ins: Inspect, a: PlanArgs): StabilizePlan {
  const comp: Vec2 = [track.comp_size[0], track.comp_size[1]];
  const layerSize: Vec2 = [ins.layer.width as number, ins.layer.height as number];
  const ref = plateSample(ins, track.ref_time);
  const base = ref.full;
  if (!invertH(base)) throw new PlanarError("refused", `Layer "${ins.layer.name}" has a Scale of 0, so it has no placement to stabilize.`);
  const pivot = a.pivot ?? pivotOf(track);
  const notes: string[] = [];
  const corr = correctionFrames({ track, mode: a.mode, smoothFrames: a.smooth_frames, pivot, range: a.range });
  if (corr.frames.length === 0) throw new PlanarError("bad_args", "No frame of the track is usable in that range, so there is nothing to write.");
  if (corr.frames.length > MAX_KEYS) {
    throw new PlanarError("bad_args", `The track has ${corr.frames.length} frames to write, over the ${MAX_KEYS} keys per property one call writes. Narrow it with range: {start, end} to a part of the shot; a shot this long cannot be stabilized whole, because a later call cannot add a second range (the layer already holds keys, a Stabilize Transform or a Corner Pin from the first, and replace_keys would wipe it).`);
  }
  if (a.mode === "smooth" && corr.frames.length < 3) notes.push("smooth needs a track of some length; with so few frames it barely changes anything.");

  let frames = corr.frames.map((f) => ({ ...f }));
  let zoom: number | null = null;
  let tile: StabilizePlan["tile"] = null;
  if (a.edges === "scale_to_fill") {
    const fz = fillZoom(frames, base, layerSize, comp);
    if (!fz.coverable) {
      throw new PlanarError("refused", "No zoom about the comp centre keeps the comp covered: on some frame the stabilized plate no longer reaches the centre. Use edges motion_tile, or smooth instead of lock.");
    }
    if (fz.zoom > a.max_zoom) {
      throw new PlanarError("refused", `Stabilizing needs a zoom of ${fz.zoom}x to keep the comp filled, over max_zoom ${a.max_zoom}. Raise max_zoom, use smooth, or use edges motion_tile.`);
    }
    zoom = fz.zoom;
    if (fz.zoom > 1) {
      const Z = zoomAbout(fz.zoom, [comp[0] / 2, comp[1] / 2]);
      frames = frames.map((f) => ({ ...f, D: mulH(Z, f.D) }));
      notes.push(`scale_to_fill: the plate is zoomed ${fz.zoom}x about the comp centre (folded into the keys) so no edge shows.`);
    } else {
      notes.push("scale_to_fill: the stabilized plate already covers the comp on every frame; no zoom was needed.");
    }
  } else if (a.edges === "motion_tile") {
    const ext = tileExtents(frames, base, layerSize, comp);
    if (ext && ext.needed) {
      const pct = tileOutputPct(layerSize, ext);
      tile = { output_w_pct: pct.w, output_h_pct: pct.h, extents: ext };
      notes.push(`motion_tile: the plate is extended to ${pct.w}% x ${pct.h}% with Mirror Edges on, in front of the stabilizing, to cover the largest offset (${r2(Math.max(ext.left, ext.right, ext.top, ext.bottom))} px).`);
    } else {
      notes.push("motion_tile: no offset reaches past the plate's edges, so no Motion Tile was added.");
    }
  }

  const plan: StabilizePlan = {
    target: a.target,
    mode: a.mode,
    ref_time: track.ref_time,
    pivot,
    frames: frames.map((f) => ({ time: f.time, H: f.H, D: f.D })),
    not_ok: corr.not_ok,
    skipped: [],
    zoom,
    tile,
    max_fit_px: 0,
    notes,
  };
  const exactModel = track.model === "translate" || track.model === "similarity" || a.mode === "position_only";
  const rawPivot = (f: { H: Mat3 }): Vec2 => applyH(f.H, pivot) ?? pivot;

  if (a.target === "layer_transform") {
    const keys = buildTransformKeys({
      base,
      frames: frames.map((f) => ({ time: f.time, F: f.D, pivot: rawPivot(f) })),
      anchorMode: "pivot",
      size: layerSize,
      fitCorners: exactModel ? undefined : rectQuad(comp[0], comp[1]),
    });
    plan.transform = keys;
    plan.skipped = keys.skipped;
    plan.max_fit_px = keys.max_fit_px;
    if (!exactModel) notes.push(`The ${track.model} track was fitted with a similarity for the layer transform (largest corner deviation ${keys.max_fit_px} px). Use target corner_pin for the full perspective.`);
  } else if (a.target === "transform_effect") {
    const bInv = invertH(base) as Mat3;
    const layerCorners = rectQuad(layerSize[0], layerSize[1]);
    const keys = buildTransformKeys({
      base: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      frames: frames.map((f) => ({ time: f.time, F: mulH(bInv, mulH(f.D, base)), pivot: applyH(bInv, rawPivot(f)) ?? pivot })),
      anchorMode: "pivot",
      size: layerSize,
      fitCorners: exactModel ? undefined : layerCorners,
    });
    plan.transform = keys;
    plan.skipped = keys.skipped;
    plan.max_fit_px = keys.max_fit_px;
    if (!exactModel) notes.push(`The ${track.model} track was fitted with a similarity for the Transform effect (largest corner deviation ${keys.max_fit_px} px). Use target corner_pin for the full perspective.`);
  } else {
    const pinFrames: PlanarFrame[] = frames.map((f) => ({ time: f.time, ok: true, H: f.D, points: [], confidence: [], rms_px: 0, inliers: 0 }));
    const keys = buildLayerKeys({ mode: "corner_pin", frames: pinFrames, ref, samples: pinFrames.map(() => ref), size: layerSize });
    if (keys.times.length === 0) throw new PlanarError("bad_args", "No frame could be turned into Corner Pin keys (every frame was degenerate).");
    plan.pin = keys;
    plan.skipped = keys.skipped;
    notes.push("Corner Pin animation gets no layer motion blur. The whole plate is resampled once by the pin.");
  }
  return plan;
}

// ---------- ae_stabilize: schema ----------

export const AeStabilizeSchema = z
  .object({
    comp_id: z.number().int(),
    layer: LayerSelectorSchema.describe("The plate layer to stabilize. Must not be 3D, locked or parented."),
    track: TrackSourceSchema.describe("The motion of the plate: a stored track_id from ae_track_multi / ae_track_read, or any source ae_track_read takes (nulls, corner_pin, tracker, transform)."),
    mode: z
      .enum(["lock", "smooth", "position_only"])
      .default("lock")
      .describe(
        "lock: the reference frame's framing is held (the plate gets the inverse of the track). smooth: only the jitter goes; the plate keeps the track smoothed with a Gaussian of smooth_frames (S . H^-1). position_only: only the pivot's translation is taken out, even from a similarity track."
      ),
    smooth_frames: z.number().min(1).max(300).default(15).describe("smooth: the Gaussian sigma in frames. Default 15. The ends of the shot are mirror-padded so they do not drift."),
    ref_time: z.number().min(0).optional().describe("The frame whose framing is kept (seconds). Default: the track's own reference frame."),
    pivot: z.array(z.number()).length(2).optional().describe("[x, y] comp px at ref_time where the stabilizing is pinned (the Anchor Point follows it). Default: the centroid of the track's points."),
    target: z
      .enum(["layer_transform", "transform_effect", "corner_pin"])
      .optional()
      .describe(
        "Where the keys go. layer_transform (default for translate/similarity/affine tracks): Anchor Point, Position, Rotation, Scale of the layer, how AE's own Stabilize writes them; refused on a layer with keys unless replace_keys. transform_effect: the 'Transform' effect, for when the layer's own transform must stay free (its Shutter Angle gives motion blur). corner_pin (default for perspective tracks): the inverse homography as Corner Pin keys in the layer's own space."
      ),
    edges: z
      .enum(["none", "scale_to_fill", "motion_tile"])
      .default("none")
      .describe(
        "none: the stabilized plate shows its edges. scale_to_fill: the smallest uniform zoom about the comp centre that keeps the comp covered on every frame is found and folded into the keys. motion_tile: a Motion Tile (Mirror Edges on) in front of the stabilizing extends the plate to cover the largest offset."
      ),
    max_zoom: z.number().min(1.01).max(10).default(2).describe("scale_to_fill: refuse when the zoom needed is above this. Default 2."),
    range: z
      .object({ start: z.number().min(0), end: z.number().min(0) })
      .optional()
      .describe("Write only the frames in this time range (seconds). One call writes at most 3000 frames, and a later call cannot add a second range to the same layer (it would be refused, or with replace_keys wipe the first), so a shot over 3000 frames cannot be stabilized whole: pick the part you need."),
    replace_keys: z.boolean().optional().describe("layer_transform: replace keys already on Anchor Point, Position, Rotation and Scale. Without it existing keys refuse the write. Expressions always refuse."),
    bicubic: z.boolean().default(true).describe("Set the layer's sampling quality to Bicubic and, for target transform_effect, the effect's own Sampling popup to Bicubic (the layer switch does not reach the effect; the popup value 2 = Bicubic is unmeasured, and the result says whether it was set). A Corner Pin has no sampling switch of its own. Default true."),
    motion_blur: z.boolean().optional().describe("layer_transform: switch the layer's motion blur on and the comp's Enable Motion Blur. Only when asked: it blurs along the correction, not along the original shake."),
    shutter_angle: z.number().min(0).max(720).optional().describe("transform_effect: the effect's own Shutter Angle for motion blur (turns off 'Use Composition's Shutter Angle'). The comp's range 0..720 is accepted here; the Transform effect's own limit (possibly 360, unmeasured) applies when it is written, and a value over it is refused after the effect was added, which is then taken out again, leaving nothing behind."),
    verify: z.boolean().default(true).describe("Render the stabilized comp at verify_frames sample frames and measure the residual motion at the track's points by normalized cross-correlation (lock aims for under 0.5 px rms). Default true."),
    verify_frames: z.number().int().min(2).max(16).default(8).describe("How many sample frames the residual check uses. Default 8."),
    sheets: z.boolean().default(true).describe("Write before/after contact sheets (first, reference, last and worst-motion frame). Default true."),
    max_renders: z.number().int().min(1).max(60).default(24).describe("The render budget: most renders in one call (the before sheet, the after frames). Default 24."),
    max_seconds: z.number().min(5).max(300).default(90).describe("The render budget: most seconds of rendering in one call. Default 90."),
    expect: ExpectSchema,
  })
  .refine((v) => v.shutter_angle === undefined || v.target === "transform_effect", { message: "shutter_angle applies to target transform_effect only." })
  .refine((v) => !(v.mode === "position_only" && v.target === "corner_pin"), { message: "position_only moves the plate by a translation: use layer_transform or transform_effect." })
  .refine((v) => v.motion_blur === undefined || v.target === undefined || v.target === "layer_transform", { message: "motion_blur applies to target layer_transform only (a Corner Pin gets no layer motion blur; the Transform effect has shutter_angle)." });

export type AeStabilizeArgs = z.infer<typeof AeStabilizeSchema>;

// ---------- ae_stabilize: the receipt ----------

type Expected = Parameters<typeof keyMismatches>[0][number];
type HostWritten = Parameters<typeof keyMismatches>[1];
type KeysRead = NonNullable<Parameters<typeof keyMismatches>[2]>;

const sampleIdx = (n: number): number[] => Array.from(new Set([0, Math.floor((n - 1) / 2), n - 1])).filter((i) => i >= 0 && i < n);
const sampleTimes = (times: number[]) => sampleIdx(times.length).map((i) => times[i]);

function expectedFor(layerId: number, role: string, times: number[], values: Array<number | number[]>): Expected {
  return { layerId, kind: "transform", role, keys: times.length, samples: sampleIdx(times.length).map((i) => ({ time: times[i], value: values[i] })) };
}

interface StabWritten {
  layer_index?: number;
  layer_id?: number;
  target?: string;
  written?: HostWritten["written"];
  tile?: { name: string; index: number; output_w_pct: number; output_h_pct: number; clamped: boolean; mirror_edges: boolean; param_table?: ParamRow[] } | null;
  effect?: { name: string; index: number; uniform_scale_on: boolean; sampling?: { set: boolean; value: number } | null; shutter: { set: boolean; angle: number } | null; param_table?: ParamRow[] } | null;
  order?: { checked: boolean; ok: boolean; moved: boolean } | null;
  flags?: { bicubic: boolean | null; motion_blur: boolean | null; comp_motion_blur: boolean | null } | null;
  [k: string]: unknown;
}

interface StabRead extends KeysRead {
  flags?: { bicubic: boolean | null; motion_blur: boolean | null; comp_motion_blur: boolean | null } | null;
  tile?: { found: boolean; index: number; output_w_pct?: number; output_h_pct?: number; mirror_edges?: unknown } | null;
  /** Every effect on the layer, in order, from the separate read-back call. */
  effects?: Array<{ index: number; name: string; matchName: string }>;
  /** The Transform effect's Sampling popup value (2 = Bicubic). */
  sampling?: number | null;
}

/** Key counts and values, the flags, the Motion Tile and the effect order, against what the write meant to do. */
export function stabilizeMismatches(
  a: { expected: Expected[]; bicubic: boolean; motionBlur: boolean | undefined; tile: StabilizePlan["tile"]; target?: StabTarget; shutterAngle?: number },
  written: StabWritten,
  after: StabRead | null
): ReceiptMismatch[] {
  const m = keyMismatches(a.expected, { nulls: [], written: written.written ?? [] }, after);
  if (after?.flags) {
    if (a.bicubic) expectThat(m, after.flags.bicubic !== false, "flags.bicubic", true, after.flags.bicubic, "The layer's sampling quality is not Bicubic");
    if (a.motionBlur) {
      expectThat(m, after.flags.motion_blur !== false, "flags.motion_blur", true, after.flags.motion_blur, "The layer's motion blur is off");
      expectThat(m, after.flags.comp_motion_blur !== false, "flags.comp_motion_blur", true, after.flags.comp_motion_blur, "The comp's Enable Motion Blur is off");
    }
  }
  if (a.target === "transform_effect") {
    const fx = written.effect;
    if (fx && fx.uniform_scale_on === false) expectThat(m, false, "effect.uniform_scale_on", true, false, "Uniform Scale was not switched on, so the scale keys drive Scale Height only and the correction is non-uniform");
    if (a.shutterAngle !== undefined && fx?.shutter) expectThat(m, fx.shutter.set === true, "effect.shutter", a.shutterAngle, fx.shutter, "The effect's shutter parameters were not found, so the Shutter Angle was not set");
    if (a.bicubic && fx?.sampling) {
      expectThat(m, fx.sampling.set === true, "effect.sampling", "Bicubic", fx.sampling, "The Transform effect's Sampling popup was not found, so it resamples bilinear");
      if (typeof after?.sampling === "number") expectThat(m, after.sampling === 2, "effect.sampling.value", 2, after.sampling, "The Transform effect's Sampling popup is not Bicubic");
    }
  }
  if (a.tile) {
    expectThat(m, written.tile != null, "tile", "a Motion Tile", written.tile ?? null, "The host reported no Motion Tile");
    if (written.tile && written.tile.mirror_edges === false) expectThat(m, false, "tile.mirror_edges", true, false, "Mirror Edges was not switched on (its parameter was not found), so the tiled edges will show seams");
    if (after?.tile && after.tile.mirror_edges !== undefined && after.tile.mirror_edges !== null && written.tile?.mirror_edges === true) {
      expectThat(m, Number(after.tile.mirror_edges) === 1, "tile.mirror_edges.read", 1, after.tile.mirror_edges, "Mirror Edges is off in the read-back");
    }
    if (after?.tile) {
      expectThat(m, after.tile.found === true, "tile.found", true, after.tile.found, "The Motion Tile is not at the index the write reported");
      const w = written.tile?.output_w_pct;
      if (typeof after.tile.output_w_pct === "number" && typeof w === "number") {
        expectThat(m, Math.abs(after.tile.output_w_pct - w) < 0.05, "tile.output_w_pct", w, after.tile.output_w_pct, "Output Width differs");
      }
      const h = written.tile?.output_h_pct;
      if (typeof after.tile.output_h_pct === "number" && typeof h === "number") {
        expectThat(m, Math.abs(after.tile.output_h_pct - h) < 0.05, "tile.output_h_pct", h, after.tile.output_h_pct, "Output Height differs");
      }
    }
    if (written.order?.checked) expectThat(m, written.order.ok === true, "effect_order", "the Motion Tile in front of the stabilizing", written.order, "The Motion Tile does not sit in front of the stabilizing effect: move it up by hand");
    // The order again, from the separate read-back (the host's own order check ran in the same script as the move).
    if (after?.effects && written.tile) {
      const tileFx = after.effects.find((e) => e.matchName === "ADBE Tile" && e.name === written.tile?.name);
      let mainFx: { index: number } | undefined;
      if (a.target === "transform_effect") mainFx = after.effects.find((e) => e.matchName === "ADBE Geometry2" && e.name === written.effect?.name);
      else if (a.target === "corner_pin") mainFx = after.effects.find((e) => e.matchName === "ADBE Corner Pin");
      if (tileFx && mainFx) expectThat(m, tileFx.index < mainFx.index, "effects.order", "the Motion Tile above the stabilizing effect", { tile: tileFx.index, main: mainFx.index }, "In the read-back the Motion Tile sits behind the stabilizing effect: move it up by hand");
    }
  }
  return m;
}

// ---------- ae_stabilize: the run ----------

interface Shot {
  time: number;
  gray: GrayImage;
  image: RgbaImage;
}

async function renderShot(ctx: ToolContext, opId: string, compId: number, time: number, index: number, framesDir: string, toolName: string): Promise<Shot> {
  const s = await captureCompFrame({ ctx, opId, compId, time, frameIndex: index, framesDir, toolName });
  try {
    const png = decodePngFile(s.path);
    return { time, gray: toGray(png), image: png };
  } finally {
    fs.rmSync(s.path, { force: true });
  }
}

const uniqSorted = (xs: number[]) => [...new Set(xs)].sort((a, b) => a - b);

async function stabilize(ctx: ToolContext, args: AeStabilizeArgs): Promise<Record<string, unknown>> {
  const toolName = "ae_stabilize";
  const opId = ctx.bridge.newOpId();
  const label = `ae_stabilize(${args.comp_id})`;
  const framesDir = defaultFramesDir();
  const budget = createRenderBudget({ maxRenders: args.max_renders, maxSeconds: args.max_seconds });
  const wantImages = args.sheets || args.verify;

  const prep = await queued(ctx, label, opId, async () => {
    const { track, info } = await resolveTrackSourceWithInfo(ctx, opId, args.comp_id, args.track);
    if (!args.track.track_id) saveTrack(track);
    const refTime = args.ref_time ?? track.ref_time;
    const based = relativeTo(track, refTime);
    const refFrame = frameAt(based, refTime);
    if (!refFrame || !refFrame.ok || !refFrame.H) {
      throw new PlanarError("bad_args", `The reference frame at ${r2(refTime)} s has no solved motion, so it cannot be the frame whose framing is kept. Pass a ref_time where the track is ok.`);
    }
    const ins = await hostRead<Inspect>(ctx, opId, "inspect", "stabilizeInspect", { comp_id: args.comp_id, layer: args.layer, ref_time: refTime }, toolName);
    // position_only is a translation, so it never defaults to a Corner Pin.
    let target: StabTarget;
    if (args.target) target = args.target;
    else if (args.mode === "position_only") target = "layer_transform";
    else if (based.model === "perspective") target = "corner_pin";
    else target = "layer_transform";
    if (args.motion_blur === true && target !== "layer_transform") {
      throw new PlanarError("bad_args", `motion_blur applies to target layer_transform only; this track resolves to target ${target}. Pass target layer_transform, or drop motion_blur.`);
    }
    if (args.mode === "position_only" && target === "corner_pin") {
      throw new PlanarError("bad_args", "position_only moves the plate by a translation: use layer_transform or transform_effect.");
    }
    checkPlate(ins, { target, replace_keys: args.replace_keys, compSize: based.comp_size, tile: args.edges === "motion_tile" });
    const plan = planStabilize(based, ins, {
      mode: args.mode,
      smooth_frames: args.smooth_frames,
      pivot: args.pivot as Vec2 | undefined,
      target,
      edges: args.edges,
      max_zoom: args.max_zoom,
      range: args.range,
    });
    // Before sheet: the original comp, rendered while the plate is untouched.
    const times = pickSheetTimes(plan.frames, plan.pivot, refTime);
    const sheetTimes = uniqSorted([times.first, times.ref, times.worst, times.last]);
    const before: Shot[] = [];
    let beforeError: string | undefined;
    if (args.sheets) {
      try {
        for (const t of sheetTimes) {
          if (budget.exhausted()) break;
          before.push(await renderShot(ctx, opId, args.comp_id, t, before.length, framesDir, toolName));
          budget.spend();
          await yieldLoop();
        }
      } catch (err) {
        beforeError = errMessage(err);
      }
    }
    return { track: based, info, refTime, ins, target, plan, times, sheetTimes, before, beforeError };
  });

  const { track, ins, plan, target, refTime } = prep;
  const keyTimes = target === "corner_pin" ? (plan.pin as LayerKeys).times : (plan.transform as TransformKeys).times;
  const layerRef = { index: ins.layer.index, id: ins.layer.id };
  const expected: Expected[] = [];
  let values: Record<string, unknown>;
  if (target === "corner_pin") {
    const pin = plan.pin as LayerKeys & { pin: NonNullable<LayerKeys["pin"]> };
    values = { ul: pin.pin.ul, ur: pin.pin.ur, ll: pin.pin.ll, lr: pin.pin.lr };
    for (const role of ["ul", "ur", "ll", "lr"] as const) expected.push(expectedFor(ins.layer.id, role, keyTimes, pin.pin[role]));
  } else {
    const k = plan.transform as TransformKeys;
    values = { anchor: k.anchor, position: k.position, rotation: k.rotation, scale: k.scale };
    expected.push(expectedFor(ins.layer.id, "anchor", keyTimes, k.anchor));
    expected.push(expectedFor(ins.layer.id, "position", keyTimes, k.position));
    expected.push(expectedFor(ins.layer.id, "rotation", keyTimes, k.rotation));
    // The Transform effect has one Scale value (Uniform Scale on); the layer has [x, y].
    expected.push(expectedFor(ins.layer.id, "scale", keyTimes, target === "transform_effect" ? k.scale.map((s) => s[0]) : k.scale));
  }
  const motionBlur = args.motion_blur === true;
  const readKind = target;
  const expect: ExpectGuard = { project_path: args.expect.project_path, comp_id: args.expect.comp_id ?? args.comp_id };

  const result = await runGuardedWrite<StabWritten>(ctx, {
    toolName,
    label,
    expect,
    compId: args.comp_id,
    read: (phase, written) => {
      if (phase === "before") {
        // A Transform effect does not exist yet; the other targets have a before state to count keys on.
        if (target === "transform_effect") return null;
        return { host: "stabilizeReadBack", args: { comp_id: args.comp_id, layer_id: ins.layer.id, kind: readKind, times: [] } };
      }
      const w = written as StabWritten | undefined;
      const main = w?.written?.[0] as { effect_index?: number } | undefined;
      return {
        host: "stabilizeReadBack",
        args: {
          comp_id: args.comp_id,
          layer_id: ins.layer.id,
          kind: readKind,
          times: sampleTimes(keyTimes),
          ...(main?.effect_index !== undefined ? { effect_index: main.effect_index } : {}),
          ...(target === "transform_effect" ? { effect_wanted: TRANSFORM_FX_PARAMS } : {}),
          ...(w?.tile ? { tile_index: w.tile.index, tile_wanted: TILE_FX_PARAMS } : {}),
        },
      };
    },
    write: {
      host: "stabilizeApply",
      args: {
        comp_id: args.comp_id,
        layer: layerRef,
        target,
        replace_keys: args.replace_keys === true,
        times: keyTimes,
        values,
        ...(target === "transform_effect" ? { effect_wanted: TRANSFORM_FX_PARAMS, ...(args.shutter_angle !== undefined ? { shutter_angle: args.shutter_angle } : {}) } : {}),
        ...(plan.tile ? { tile: { output_w_pct: plan.tile.output_w_pct, output_h_pct: plan.tile.output_h_pct, wanted: TILE_FX_PARAMS } } : {}),
        bicubic: args.bicubic,
        motion_blur: motionBlur,
        comp_motion_blur: motionBlur,
      },
      timeoutMs: SLOW_TIMEOUT_MS,
    },
    check: (_before, after, written) => stabilizeMismatches({ expected, bicubic: args.bicubic, motionBlur: motionBlur || undefined, tile: plan.tile, target, shutterAngle: args.shutter_angle }, written, after as StabRead | null),
  });

  const written = result as unknown as StabWritten & { checkpoint: unknown; receipt: unknown; op_id: string; user_changed?: unknown };
  const notes = [...plan.notes];
  const skipped = uniqSorted([...plan.not_ok, ...plan.skipped]);
  if (skipped.length > 0) notes.push(`${skipped.length} frame(s) got no key (the track did not solve them, or the correction was degenerate); AE interpolates across them.`);
  if (target === "layer_transform" && args.replace_keys === true && Object.values(ins.keys).some((n) => n > 0)) {
    notes.push("replace_keys: the existing keys were replaced, and the plate's placement was taken as its value at the reference time. That is only right if those keys held the still placement there (true after a lock run, not after a smooth run): check the result against the before sheet.");
  }
  if (motionBlur) notes.push(`The comp's Enable Motion Blur was ${ins.comp.motion_blur ? "already on" : "off and is now on"}; it applies to every layer in the comp that has its motion blur switch on.`);
  notes.push("Stabilizing resamples the whole plate once. To fix something on a moving shot (a wire, a logo, dirt) without softening the plate twice, use ae_stabilize_roundtrip: only the patch is resampled there.");
  if (target === "transform_effect" && written.effect?.param_table && !paramTableAgrees(written.effect.param_table, TRANSFORM_FX_PARAMS)) {
    notes.push("The host's Transform-effect parameter table does not match resolveEffectParams on the same table: check param_tables before trusting the keys.");
  }
  if (target === "transform_effect") notes.push("The Transform effect's parameters were mapped by display name with an index fallback: check param_tables once on this AE.");
  if (written.tile) notes.push("The Motion Tile's parameters were mapped by display name with an index fallback; whether its larger output keeps the layer's pixel coordinates is unmeasured: look at the after sheet.");
  if (written.tile?.clamped) notes.push("Motion Tile's Output size hit the property's limit and was clamped: the edges may still show.");
  if (written.order && written.order.checked && !written.order.ok) notes.push("The Motion Tile could not be put in front of the stabilizing effect: move it up by hand.");
  if (target === "transform_effect" && written.effect) {
    if (written.effect.uniform_scale_on === false) notes.push("Uniform Scale was not switched on (its parameter was not found): only Scale Height got the keys, so the scale correction is non-uniform. Check param_tables.");
    if (args.shutter_angle !== undefined && written.effect.shutter && !written.effect.shutter.set) notes.push(`shutter_angle ${args.shutter_angle} was NOT applied: the effect's shutter parameters were not found. Check param_tables and set it by hand.`);
    if (args.bicubic && written.effect.sampling && !written.effect.sampling.set) notes.push("The Transform effect's Sampling popup was not found, so it resamples bilinear; the layer's bicubic switch does not reach it. Check param_tables and set it by hand.");
  }
  if (written.tile && written.tile.mirror_edges === false) notes.push("Mirror Edges was NOT switched on (the parameter was not found): the extended edges are transparent or show seams. Check param_tables and tick it by hand.");
  if (motionBlur && written.flags && written.flags.comp_motion_blur === false) notes.push("The comp's Enable Motion Blur could not be switched on; the layer's motion blur will not show until it is.");
  if (ins.layer.in_point > 0 || ins.layer.start_time) notes.push("The plate does not start at 0; keys are at comp times, as the track's frames are.");

  // The after renders: the residual check and the after sheet. Nothing here may throw: the write is in.
  let residual: (Residual & { target_px: number | null; meets_target: boolean | null; render_scale: number }) | null = null;
  let verifyError: string | undefined;
  let beforeSheet: string | undefined;
  let afterSheet: string | undefined;
  let sheetError: string | undefined = prep.beforeError;
  let afterRenders = 0;
  if (wantImages) {
    try {
      const afterOp = ctx.bridge.newOpId();
      const verifyTimes = args.verify ? evenSamples(plan.frames.map((f) => f.time), args.verify_frames) : [];
      const sheetTimes = args.sheets ? prep.sheetTimes : [];
      const refShot = plan.frames.reduce((best, f) => (Math.abs(f.time - refTime) < Math.abs(best - refTime) ? f.time : best), plan.frames[0].time);
      const wanted = uniqSorted([...sheetTimes, ...verifyTimes, ...(args.verify ? [refShot] : [])]);
      // The reference first: the residual check takes its patterns from it.
      wanted.sort((x, y) => Math.abs(x - refShot) - Math.abs(y - refShot));
      const shots = await queued(ctx, `${label} after`, afterOp, async () => {
        const got: Shot[] = [];
        for (const t of wanted) {
          if (budget.exhausted()) break;
          try {
            got.push(await renderShot(ctx, afterOp, args.comp_id, t, 500 + got.length, framesDir, toolName));
            budget.spend();
            afterRenders++;
          } catch (err) {
            verifyError = errMessage(err);
            break;
          }
          await yieldLoop();
        }
        return got;
      });
      const byTime = new Map(shots.map((s) => [s.time, s]));
      const frameByTime = new Map(plan.frames.map((f) => [f.time, f]));
      const trackFrameAt = (t: number): PlanarFrame | null => frameAt(track, t);
      // Where each tracked point should sit on the stabilized render at time t.
      const expectedAt = (t: number): Array<Vec2 | null> => {
        const f = frameByTime.get(t);
        const tf = trackFrameAt(t);
        return track.ref_points.map((q, i) => {
          if (!f || !tf) return null;
          if (t !== refTime && tf.points[i] === null) return null;
          const raw = applyH(f.H, q);
          return raw ? applyH(f.D, raw) : null;
        });
      };
      const refShotImg = byTime.get(refShot);
      if (args.verify) {
        if (!refShotImg) {
          verifyError ??= "The reference frame could not be rendered inside the render budget, so the residual could not be measured. Raise max_renders.";
        } else {
          const scale = refShotImg.image.width / track.comp_size[0];
          const refExpected = expectedAt(refShot).map((p, i) => p ?? track.ref_points[i]);
          const samples = verifyTimes
            .filter((t) => t !== refShot && byTime.has(t))
            .map((t) => ({ time: t, image: (byTime.get(t) as Shot).gray, expected: expectedAt(t) }));
          const res = measureResidual({ scale, ref: { image: refShotImg.gray, expected: refExpected }, samples });
          const lock = plan.mode === "lock";
          residual = {
            ...res,
            target_px: lock ? RESIDUAL_TARGET_PX : null,
            meets_target: lock && res.rms_px !== null ? res.rms_px < RESIDUAL_TARGET_PX : null,
            render_scale: r4(scale),
          };
          if (res.rms_px === null) verifyError ??= "No point had a usable pattern on the stabilized reference render (flat, or off the frame), so the residual could not be measured.";
        }
      }
      if (args.sheets) {
        try {
          const comp: Vec2 = track.comp_size;
          const tiles = (list: Shot[], mark: (t: number) => Array<Vec2 | null>, prefix: string): SheetTile[] =>
            list.map((s) => ({ image: s.image, label: `${prefix} t=${r2(s.time)}`, marks: mark(s.time).filter((p): p is Vec2 => p !== null) }));
          if (prep.before.length > 0) {
            const raw = (t: number) => {
              const tf = trackFrameAt(t);
              return track.ref_points.map((q) => (tf && tf.H ? applyH(tf.H, q) : null));
            };
            beforeSheet = writeSheet(framesDir, `${opId}_before`, drawStabSheet(tiles(prep.before, raw, "before"), comp));
          }
          const sheetShots = prep.sheetTimes.map((t) => byTime.get(t)).filter((s): s is Shot => !!s);
          if (sheetShots.length > 0) afterSheet = writeSheet(framesDir, `${opId}_after`, drawStabSheet(tiles(sheetShots, expectedAt, "after"), comp));
          if (sheetShots.length < prep.sheetTimes.length || prep.before.length < prep.sheetTimes.length) sheetError ??= "The render budget ran out before every sheet frame was rendered; raise max_renders.";
        } catch (err) {
          sheetError ??= errMessage(err);
        }
      }
    } catch (err) {
      verifyError ??= errMessage(err);
    }
  }
  if (residual && residual.rms_px !== null) {
    if (residual.meets_target === false) notes.push(`The residual motion is ${residual.rms_px} px rms, over the ${RESIDUAL_TARGET_PX} px target: the track may be loose (check its rms_px), the points may not lie on one plane, or the plate has parallax.`);
    notes.push(`The residual was measured on half-size renders (sub-pixel by the matcher): a value of a few tenths of a pixel is at the measure's limit. Layers above the plate that move on their own are part of what is measured: hide them for a clean number.`);
  }

  return {
    ok: true,
    op_id: written.op_id,
    applied: true,
    target,
    mode: plan.mode,
    edges: args.edges,
    track_id: track.track_id,
    track_model: track.model,
    ref_time: r4(refTime),
    pivot: [r2(plan.pivot[0]), r2(plan.pivot[1])],
    layer: { index: ins.layer.index, id: ins.layer.id, name: ins.layer.name },
    frames_written: keyTimes.length,
    ...(skipped.length ? { frames_skipped: skipped.slice(0, 100).map(r4), frames_skipped_total: skipped.length } : {}),
    ...(plan.zoom !== null ? { zoom: plan.zoom } : {}),
    ...(plan.tile ? { motion_tile: { ...written.tile, extents_px: { left: r2(plan.tile.extents.left), right: r2(plan.tile.extents.right), top: r2(plan.tile.extents.top), bottom: r2(plan.tile.extents.bottom) } } } : {}),
    max_fit_px: plan.max_fit_px,
    written: written.written ?? [],
    param_tables: {
      ...(written.effect?.param_table ? { transform_effect: written.effect.param_table } : {}),
      ...(written.tile?.param_table ? { motion_tile: written.tile.param_table } : {}),
    },
    flags: written.flags ?? null,
    ...(residual ? { residual } : {}),
    ...(verifyError ? { verify_error: verifyError } : {}),
    ...(beforeSheet ? { before_sheet_path: beforeSheet } : {}),
    ...(afterSheet ? { after_sheet_path: afterSheet } : {}),
    ...(sheetError ? { sheet_error: sheetError } : {}),
    budget: { max_renders: args.max_renders, max_seconds: args.max_seconds, renders_used: budget.used.renders, after_renders: afterRenders },
    notes,
    checkpoint: written.checkpoint,
    receipt: written.receipt,
    ...(written.user_changed ? { user_changed: written.user_changed } : {}),
  };
}

// ---------- ae_stabilize_roundtrip: schema ----------

export const AeStabilizeRoundtripSchema = z
  .object({
    comp_id: z.number().int(),
    action: z.enum(["build", "remove"]).default("build").describe("build (default): make the rig. remove: take a rig this tool made out again."),
    plate: LayerSelectorSchema.optional().describe("build: the plate layer in comp_id. Must not be 3D, locked, parented, time-remapped or keyed."),
    track: TrackSourceSchema.optional().describe("build: the plate's motion, a stored track_id or any source ae_track_read takes."),
    ref_time: z.number().min(0).optional().describe("build: the frame the work comp's steady image is taken from (seconds). Default: the track's reference frame."),
    pad_px: z.number().int().min(0).max(4000).optional().describe("build: pixels added on each side of the work comp, so a patch near the edge is not cropped. Default 10% of the comp's longer side."),
    name: z.string().min(1).max(200).optional().describe("build: the work comp's name. Default '<plate> STAB'."),
    copy_effects: z.boolean().optional().describe("build: the plate has effects or masks: copy the layer with them (Layer.copyToComp). AE has crashed when undoing copyToComp on a layer with effects, so it is off by default and the tool refuses such a plate without it."),
    guide_mode: z
      .enum(["guide_layer", "opacity_switch"])
      .default("guide_layer")
      .describe("build: guide_layer (default) marks the plate copy as a guide layer, which a nested comp leaves out of the parent. If your AE still renders it, use opacity_switch: the copy's opacity follows a 'Show Stabilized Plate' checkbox on the rig layer (off by default; tick it to see the steady plate while you work)."),
    motion_blur: z.boolean().default(true).describe("build: switch the rig layer's motion blur on when the rig is a layer transform (not for perspective tracks). Default true. It shows only while the comp's Enable Motion Blur is on; see comp_motion_blur."),
    comp_motion_blur: z.boolean().default(false).describe("build: also turn the shot comp's Enable Motion Blur on. Off by default because it changes the render of every other layer that has its motion blur switch on. The result says what state the comp switch is in."),
    sheet: z.boolean().default(true).describe("build: write a before/after contact sheet of the shot comp (first, reference and last frame) with a test patch outline, and measure how far the rig moved the picture. Default true."),
    max_renders: z.number().int().min(1).max(30).default(8).describe("build: the render budget, most renders in one call. Default 8."),
    max_seconds: z.number().min(5).max(300).default(60).describe("build: the render budget, most seconds of rendering. Default 60."),
    rig_layer: LayerSelectorSchema.optional().describe("remove: the rig layer (the work comp's layer in comp_id)."),
    work_comp_id: z.number().int().optional().describe("remove: the work comp's id, instead of rig_layer."),
    delete_patches: z.boolean().optional().describe("remove: delete the rig although its work comp holds layers besides the guide plate (patches) or is used in other comps."),
    expect: ExpectSchema,
  })
  .refine((v) => v.action !== "build" || (v.plate !== undefined && v.track !== undefined), { message: "build needs `plate` and `track`." })
  .refine((v) => v.action !== "remove" || v.rig_layer !== undefined || v.work_comp_id !== undefined, { message: "remove needs `rig_layer` or `work_comp_id`." });

export type AeStabilizeRoundtripArgs = z.infer<typeof AeStabilizeRoundtripSchema>;

// ---------- ae_stabilize_roundtrip: the plan ----------

export interface RigPlan {
  pad: number;
  work: { width: number; height: number };
  /** transform keys for a similarity rig, Corner Pin keys otherwise. */
  kind: "transform" | "corner_pin";
  frames: Array<{ time: number; H: Mat3 }>;
  not_ok: number[];
  inner: { target: "transform" | "corner_pin"; times: number[]; values: Record<string, unknown>; static_transform: StaticTransform };
  outer: { target: "transform" | "corner_pin"; times: number[]; values: Record<string, unknown>; static_transform: StaticTransform };
  /** Worst distance (px) between outer . inner and the plate's own placement; null for Corner Pin rigs. */
  roundtrip_error_px: number | null;
  max_fit_px: number;
  skipped: number[];
  notes: string[];
}

interface StaticTransform {
  anchor: Vec2;
  position: Vec2;
  scale: Vec2;
  rotation: number;
}

/** 10% of the longer side. */
export const defaultPad = (comp: Vec2): number => Math.round(Math.max(comp[0], comp[1]) * 0.1);

const pad3 = (m: Mat3, p: number): Mat3 => mulH(translationH(p, p), m);

/**
 * The keys of both halves of a rig. Inside the work comp (the plate copy at
 * +pad) the plate gets T(pad) . H^-1 . T(-pad) . (T(pad) . M); the work comp's
 * layer in the shot comp gets H . T(-pad) . (anchor fixed at the work comp's
 * centre). Their product is H . H^-1 . M = M, so the plate comes back exactly.
 */
export function planRig(track: PlanarTrack, ins: Inspect, a: { pad: number }): RigPlan {
  const comp: Vec2 = [track.comp_size[0], track.comp_size[1]];
  const layerSize: Vec2 = [ins.layer.width as number, ins.layer.height as number];
  const ref = plateSample(ins, track.ref_time);
  const pivot = pivotOf(track);
  const corr = correctionFrames({ track, mode: "lock", smoothFrames: 0, pivot });
  if (corr.frames.length === 0) throw new PlanarError("bad_args", "No frame of the track is ok, so there is nothing to build the rig from.");
  if (corr.frames.length > MAX_KEYS) {
    throw new PlanarError("bad_args", `The track has ${corr.frames.length} usable frames, over the ${MAX_KEYS} keys per property one call writes. Shots this long are not supported by the rig.`);
  }
  const p = a.pad;
  const W = comp[0] + 2 * p;
  const Hh = comp[1] + 2 * p;
  if (W > 30000 || Hh > 30000) throw new PlanarError("bad_args", `The work comp would be ${W}x${Hh}, over After Effects' 30000 px limit. Use a smaller pad_px.`);
  const notes: string[] = [];
  const perspective = track.model === "perspective" || track.model === "affine";
  const Mref = ref.full;
  const Tp = translationH(p, p);
  const Tn = translationH(-p, -p);
  const Min = mulH(Tp, Mref);
  // The outer layer's still placement: the work comp's centre on the shot comp's centre.
  const outerStatic: StaticTransform = { anchor: [W / 2, Hh / 2], position: [comp[0] / 2, comp[1] / 2], scale: [100, 100], rotation: 0 };
  const Mo = layerMatrix({ anchor: outerStatic.anchor, position: outerStatic.position, scale_pct: outerStatic.scale, rotation_deg: 0 });
  const innerStatic: StaticTransform = {
    anchor: ins.transform!.anchor,
    position: [ins.transform!.position[0] + p, ins.transform!.position[1] + p],
    scale: ins.transform!.scale,
    rotation: ins.transform!.rotation,
  };
  const Finner = (f: CorrFrame): Mat3 => mulH(Tp, mulH(f.D, Tn));

  if (!perspective) {
    const inner = buildTransformKeys({
      base: Min,
      frames: corr.frames.map((f) => ({ time: f.time, F: Finner(f), pivot: applyH(Tp, applyH(f.H, pivot) ?? pivot) ?? pivot })),
      anchorMode: "pivot",
      size: layerSize,
    });
    const outer = buildTransformKeys({
      base: Mo,
      frames: corr.frames.map((f) => ({ time: f.time, F: f.H, pivot })),
      anchorMode: "fixed",
      fixedAnchor: outerStatic.anchor,
      size: [W, Hh],
    });
    // Both halves must share the same frames: a frame either half dropped is dropped from both.
    const common = inner.times.filter((t) => outer.times.some((u) => Math.abs(u - t) < 1e-9));
    const take = <T>(keys: TransformKeys, pick: (k: TransformKeys) => T[]): T[] => pick(keys).filter((_, i) => common.some((t) => Math.abs(t - keys.times[i]) < 1e-9));
    const trim = (k: TransformKeys): TransformKeys => ({
      ...k,
      times: common,
      anchor: take(k, (x) => x.anchor),
      position: take(k, (x) => x.position),
      rotation: take(k, (x) => x.rotation),
      scale: take(k, (x) => x.scale),
    });
    const ti = trim(inner);
    const to = trim(outer);
    if (common.length === 0) throw new PlanarError("bad_args", "No frame could be turned into rig keys (every frame was degenerate).");
    const err = roundtripError(ti, to, Mref, layerSize);
    return {
      pad: p,
      work: { width: W, height: Hh },
      kind: "transform",
      frames: corr.frames.map((f) => ({ time: f.time, H: f.H })),
      not_ok: corr.not_ok,
      inner: { target: "transform", times: common, values: { anchor: ti.anchor, position: ti.position, rotation: ti.rotation, scale: ti.scale }, static_transform: innerStatic },
      outer: { target: "transform", times: common, values: { anchor: to.anchor, position: to.position, rotation: to.rotation, scale: to.scale }, static_transform: outerStatic },
      roundtrip_error_px: r4(err),
      max_fit_px: Math.max(inner.max_fit_px, outer.max_fit_px),
      skipped: uniqSorted([...inner.skipped, ...outer.skipped, ...corr.degenerate]),
      notes,
    };
  }

  // A perspective (or affine) track: two Corner Pins. The plate is resampled twice at the pins; the patch rides the second.
  const innerFrames: PlanarFrame[] = corr.frames.map((f) => ({ time: f.time, ok: true, H: Finner(f), points: [], confidence: [], rms_px: 0, inliers: 0 }));
  const outerFrames: PlanarFrame[] = corr.frames.map((f) => ({ time: f.time, ok: true, H: f.H, points: [], confidence: [], rms_px: 0, inliers: 0 }));
  const innerSample: LayerSample = { ...ref, position: [innerStatic.position[0], innerStatic.position[1]], full: Min };
  const outerSample: LayerSample = {
    time: ref.time,
    anchor: outerStatic.anchor,
    position: outerStatic.position,
    scale_pct: outerStatic.scale,
    rotation_deg: 0,
    parents: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    full: Mo,
  };
  const ik = buildLayerKeys({ mode: "corner_pin", frames: innerFrames, ref: innerSample, samples: innerFrames.map(() => innerSample), size: layerSize });
  const ok = buildLayerKeys({ mode: "corner_pin", frames: outerFrames, ref: outerSample, samples: outerFrames.map(() => outerSample), size: [W, Hh] });
  const common = ik.times.filter((t) => ok.times.some((u) => Math.abs(u - t) < 1e-9));
  if (common.length === 0) throw new PlanarError("bad_args", "No frame could be turned into Corner Pin rig keys (every frame was degenerate).");
  const pick = (keys: LayerKeys, role: "ul" | "ur" | "ll" | "lr"): Vec2[] => (keys.pin as NonNullable<LayerKeys["pin"]>)[role].filter((_, i) => common.some((t) => Math.abs(t - keys.times[i]) < 1e-9));
  notes.push(`The ${track.model} track needs two Corner Pins (one steadying the plate copy, one putting the motion back), so a patch is resampled twice and gets no layer motion blur.`);
  return {
    pad: p,
    work: { width: W, height: Hh },
    kind: "corner_pin",
    frames: corr.frames.map((f) => ({ time: f.time, H: f.H })),
    not_ok: corr.not_ok,
    inner: { target: "corner_pin", times: common, values: { ul: pick(ik, "ul"), ur: pick(ik, "ur"), ll: pick(ik, "ll"), lr: pick(ik, "lr") }, static_transform: innerStatic },
    outer: { target: "corner_pin", times: common, values: { ul: pick(ok, "ul"), ur: pick(ok, "ur"), ll: pick(ok, "ll"), lr: pick(ok, "lr") }, static_transform: outerStatic },
    roundtrip_error_px: null,
    max_fit_px: 0,
    skipped: uniqSorted([...ik.skipped, ...ok.skipped, ...corr.degenerate]),
    notes,
  };
}

/** A frame away from the reference whose render changed by more than this (mean absolute luma, 0..255) after the rig was built. */
export const GUIDE_DIFF_THRESHOLD = 0.3;

/** True when the rig changed the picture at a frame away from the reference: the guide plate renders in the parent. */
export function guidePlateRenders(diff: Array<{ time: number; mean_abs_diff: number | null }>, refTime: number, tol = 1e-6): boolean {
  return diff.some((d) => Math.abs(d.time - refTime) > tol && d.mean_abs_diff !== null && d.mean_abs_diff > GUIDE_DIFF_THRESHOLD);
}

/** Refusals for the plate of a rig, before anything is written. Throws a PlanarError. */
export function checkRigPlate(ins: Inspect, a: { copy_effects?: boolean; compSize: Vec2; kind?: "transform" | "corner_pin" }): void {
  checkPlate(ins, { target: "corner_pin", compSize: a.compSize, rig: true });
  const l = ins.layer;
  const name = `Layer "${l.name}"`;
  if (l.source_id === null) throw new PlanarError("refused", `${name} has no source (it is a text, shape, null or camera layer), so a copy of it cannot be placed in a work comp.`);
  if (l.time_remap) throw new PlanarError("refused", `${name} uses Time Remap, which the copy cannot mirror; precompose or bake it first.`);
  if (Object.values(ins.keys).some((n) => n > 0) || ins.expressions.length > 0) {
    throw new PlanarError("refused", `${name} has keys or expressions on its transform; the rig takes a plate with a still transform (the track carries the motion).`);
  }
  const hasFx = ins.num_effects > 0;
  if ((hasFx || l.num_masks > 0) && !a.copy_effects) {
    throw new PlanarError("refused", `${name} has ${hasFx ? "effects" : "masks"} that a plain copy would leave behind. Pass copy_effects (AE has crashed when undoing copyToComp on a layer with effects) or clear them first.`);
  }
  if (a.kind === "transform" && a.copy_effects && l.auto_orient === true) {
    throw new PlanarError("refused", `${name} has Auto-Orient on, which copy_effects would carry onto the copy, where it would turn the plate along the written Position keys; set Auto-Orient to Off first.`);
  }
  if (a.copy_effects && l.separated_position) {
    throw new PlanarError("refused", `${name} has separated Position dimensions, which copy_effects would carry onto the copy where its Position could not be written; join them (Separate Dimensions off) first.`);
  }
  if (a.kind === "corner_pin" && a.copy_effects && ins.effects.some((e) => e.matchName === "ADBE Corner Pin")) {
    throw new PlanarError("refused", `${name} already has a Corner Pin, which a perspective rig would key over; remove it or use a similarity track.`);
  }
}

// ---------- ae_stabilize_roundtrip: the receipt ----------

interface RigRead {
  comp: { id: number; num_layers: number; motion_blur: boolean };
  outer: { found: boolean; index?: number; id?: number; name?: string; source_id?: number | null; marker_ok?: boolean; motion_blur?: boolean; bicubic?: boolean | null; frame_blending_off?: boolean | null } | null;
  plate?: { found: boolean; index?: number; id?: number; name?: string } | null;
  work?: { found: boolean; id: number; name?: string; width?: number; height?: number; num_layers?: number; layers?: Array<{ index: number; id: number; name: string; guide: boolean; audio?: boolean; marker: string | null }> } | null;
  keys?: Array<{ tag: string; items: KeysRead["items"] }>;
  truncated?: boolean;
}

interface RigWritten {
  work_comp?: { id: number; name: string; width: number; height: number; duration: number; fps: number } | null;
  inner?: { layer_id: number; layer_index: number; written: HostWritten["written"]; guide: boolean } | null;
  outer?: { layer_id: number; layer_index: number; written: HostWritten["written"] } | null;
  plate?: { id: number; index: number } | null;
  flags?: { bicubic: boolean | null; frame_blending_off: boolean | null; motion_blur: boolean | null; comp_motion_blur: boolean | null; opacity_switch?: boolean; guide_audio_off?: boolean } | null;
  guide_mode?: string;
  order_ok?: boolean;
  [k: string]: unknown;
}

function rigKeyExpected(layerId: number, half: RigPlan["inner"]): Expected[] {
  const out: Expected[] = [];
  const v = half.values as Record<string, Array<number | number[]>>;
  const roles = half.target === "corner_pin" ? ["ul", "ur", "ll", "lr"] : ["anchor", "position", "rotation", "scale"];
  for (const role of roles) out.push(expectedFor(layerId, role, half.times, v[role]));
  return out;
}

export function rigMismatches(plan: RigPlan, args: { guide_mode: string; work: { width: number; height: number } }, before: RigRead | null, after: RigRead | null, w: RigWritten): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  if (!after) return m;
  const out = after.outer;
  expectThat(m, out?.found === true, "outer.found", true, out?.found, "The rig layer is not in the read-back");
  if (out?.found) {
    expectThat(m, out.source_id === w.work_comp?.id, "outer.source_id", w.work_comp?.id, out.source_id, "The rig layer does not hold the work comp");
    expectThat(m, out.marker_ok === true, "outer.marker", true, out.marker_ok, "The rig layer lost its marker comment");
    if (after.plate?.found && typeof out.index === "number" && typeof after.plate.index === "number") {
      expectThat(m, out.index === after.plate.index - 1, "outer.index", after.plate.index - 1, out.index, "The rig layer is not directly above the plate");
    }
    if (w.flags?.bicubic) expectThat(m, out.bicubic !== false, "outer.bicubic", true, out.bicubic, "The rig layer's sampling quality is not Bicubic");
    if (w.flags?.frame_blending_off) expectThat(m, out.frame_blending_off !== false, "outer.frame_blending", "off", out.frame_blending_off, "The rig layer's frame blending is on");
    if (w.flags?.motion_blur) expectThat(m, out.motion_blur === true, "outer.motion_blur", true, out.motion_blur, "The rig layer's motion blur is off");
  }
  if (before) expectThat(m, after.comp.num_layers === before.comp.num_layers + 1, "comp.num_layers", before.comp.num_layers + 1, after.comp.num_layers, "The shot comp's layer count did not grow by one");
  const work = after.work;
  expectThat(m, work?.found === true, "work.found", true, work?.found, "The work comp is not in the read-back");
  if (work?.found) {
    expectThat(m, work.width === args.work.width && work.height === args.work.height, "work.size", `${args.work.width}x${args.work.height}`, `${work.width}x${work.height}`, "The work comp's size differs");
    const guide = work.layers?.find((l) => l.id === w.inner?.layer_id);
    expectThat(m, guide !== undefined, "work.guide_plate", w.inner?.layer_id, undefined, "The plate copy is not in the work comp");
    if (guide && args.guide_mode === "guide_layer") expectThat(m, guide.guide === true, "work.guide_plate.guide", true, guide.guide, "The plate copy is not a guide layer");
    // The copy's audio is muted (a guide layer is not rendered, an opacity-0 layer still plays): else the plate's sound plays twice.
    if (guide && w.flags?.guide_audio_off === true) expectThat(m, guide.audio !== true, "work.guide_plate.audio", false, guide.audio, "The plate copy's audio is still on, so the footage's sound plays twice through the rig layer");
  }
  for (const [tag, half, layerId, written] of [
    ["inner", plan.inner, w.inner?.layer_id, w.inner?.written],
    ["outer", plan.outer, w.outer?.layer_id, w.outer?.written],
  ] as const) {
    if (layerId === undefined) continue;
    const items = after.keys?.find((k) => k.tag === tag)?.items ?? null;
    const km = keyMismatches(rigKeyExpected(layerId, half), { nulls: [], written: written ?? [] }, items ? { items } : null);
    for (const x of km) m.push({ ...x, path: `${tag}.${x.path}` });
  }
  return m;
}

// ---------- ae_stabilize_roundtrip: the run ----------

const patchOutline = (comp: Vec2): Vec2[] => {
  const w = comp[0] * 0.18;
  const h = comp[1] * 0.18;
  return rectQuad(w, h, comp[0] / 2 - w / 2, comp[1] / 2 - h / 2);
};

async function roundtripBuild(ctx: ToolContext, args: AeStabilizeRoundtripArgs): Promise<Record<string, unknown>> {
  const toolName = "ae_stabilize_roundtrip";
  const opId = ctx.bridge.newOpId();
  const label = `ae_stabilize_roundtrip(${args.comp_id})`;
  const framesDir = defaultFramesDir();
  const budget = createRenderBudget({ maxRenders: args.max_renders, maxSeconds: args.max_seconds });

  const prep = await queued(ctx, label, opId, async () => {
    const { track, info } = await resolveTrackSourceWithInfo(ctx, opId, args.comp_id, args.track as NonNullable<typeof args.track>);
    if (!(args.track as { track_id?: string }).track_id) saveTrack(track);
    const refTime = args.ref_time ?? track.ref_time;
    const based = relativeTo(track, refTime);
    const refFrame = frameAt(based, refTime);
    if (!refFrame || !refFrame.ok || !refFrame.H) {
      throw new PlanarError("bad_args", `The reference frame at ${r2(refTime)} s has no solved motion, so the steady image cannot be taken from it. Pass a ref_time where the track is ok.`);
    }
    const ins = await hostRead<Inspect>(ctx, opId, "inspect", "stabilizeInspect", { comp_id: args.comp_id, layer: args.plate, ref_time: refTime }, toolName);
    const kind = based.model === "perspective" || based.model === "affine" ? "corner_pin" : "transform";
    checkRigPlate(ins, { copy_effects: args.copy_effects, compSize: based.comp_size, kind });
    const pad = args.pad_px ?? defaultPad(based.comp_size);
    const plan = planRig(based, ins, { pad });
    const times = pickSheetTimes(plan.frames, pivotOf(based), refTime);
    const sheetTimes = uniqSorted([times.first, times.ref, times.last]);
    const before: Shot[] = [];
    let beforeError: string | undefined;
    if (args.sheet) {
      try {
        for (const t of sheetTimes) {
          if (budget.exhausted()) break;
          before.push(await renderShot(ctx, opId, args.comp_id, t, before.length, framesDir, toolName));
          budget.spend();
          await yieldLoop();
        }
      } catch (err) {
        beforeError = errMessage(err);
      }
    }
    return { track: based, info, refTime, ins, plan, pad, sheetTimes, before, beforeError };
  });

  const { track, ins, plan, refTime, pad } = prep;
  const workName = args.name ?? `${ins.layer.name} STAB`;
  const expect: ExpectGuard = { project_path: args.expect.project_path, comp_id: args.expect.comp_id ?? args.comp_id };
  const motionBlur = args.motion_blur && plan.kind === "transform";
  const plateRef = { index: ins.layer.index, id: ins.layer.id };

  const result = await runGuardedWrite<RigWritten>(ctx, {
    toolName,
    label,
    expect,
    compId: args.comp_id,
    read: (phase, written) => {
      if (phase === "before") return { host: "stabilizeRigRead", args: { comp_id: args.comp_id, plate_id: ins.layer.id } };
      const w = written as RigWritten | undefined;
      const keyItem = (tag: string, compId: number | undefined, layerId: number | undefined, half: RigPlan["inner"], effectIndex: number | undefined) =>
        compId === undefined || layerId === undefined
          ? []
          : [{ tag, comp_id: compId, layer_id: layerId, kind: half.target === "corner_pin" ? "corner_pin" : "transform", times: sampleTimes(half.times), ...(effectIndex !== undefined ? { effect_index: effectIndex } : {}) }];
      const innerFx = (w?.inner?.written?.[0] as { effect_index?: number } | undefined)?.effect_index;
      const outerFx = (w?.outer?.written?.[0] as { effect_index?: number } | undefined)?.effect_index;
      return {
        host: "stabilizeRigRead",
        args: {
          comp_id: args.comp_id,
          plate_id: ins.layer.id,
          ...(w?.outer ? { outer: { id: w.outer.layer_id } } : {}),
          ...(w?.work_comp ? { work_comp_id: w.work_comp.id } : {}),
          keys: [...keyItem("inner", w?.work_comp?.id, w?.inner?.layer_id, plan.inner, innerFx), ...keyItem("outer", args.comp_id, w?.outer?.layer_id, plan.outer, outerFx)],
        },
      };
    },
    write: {
      host: "stabilizeRigBuild",
      args: {
        comp_id: args.comp_id,
        plate: plateRef,
        name: workName,
        layer_name: workName,
        width: plan.work.width,
        height: plan.work.height,
        copy_effects: args.copy_effects === true,
        guide_mode: args.guide_mode,
        motion_blur: motionBlur,
        comp_motion_blur: motionBlur && args.comp_motion_blur === true,
        marker: { pad, ref_time: refTime, track_id: track.track_id },
        inner: plan.inner,
        outer: plan.outer,
      },
      timeoutMs: SLOW_TIMEOUT_MS,
    },
    check: (before, after, written) => rigMismatches(plan, { guide_mode: args.guide_mode, work: plan.work }, before as RigRead | null, after as RigRead | null, written),
  });

  const written = result as unknown as RigWritten & { checkpoint: unknown; receipt: unknown; op_id: string; user_changed?: unknown };
  const notes = [...plan.notes];
  if (plan.not_ok.length + plan.skipped.length > 0) notes.push(`${uniqSorted([...plan.not_ok, ...plan.skipped]).length} frame(s) got no key (not ok in the track, or degenerate); AE interpolates across them.`);
  if (plan.roundtrip_error_px !== null && plan.roundtrip_error_px > 0.05) notes.push(`The keys bring the plate back to within ${plan.roundtrip_error_px} px, not exactly: the layer's own transform has a shear the keys cannot hold (non-uniform scale with a rotation).`);
  if (motionBlur) {
    const compBlur = ins.comp.motion_blur ? "already on" : args.comp_motion_blur ? "off and turned on by this call" : "off and left off (pass comp_motion_blur to turn it on)";
    notes.push(`The rig layer's motion blur switch is on (a layer transform blurs): a patch blurs with the shot's motion. The comp's Enable Motion Blur was ${compBlur}.`);
  }
  notes.push(`LIVE CHECK: that a guide layer inside a nested comp is left out of the parent's render and of saveFrameToPng is unmeasured on this AE. The rig is an exact inverse, so a guide plate that DID render in the parent would land exactly on the original plate and never look doubled; the signal is picture_change: it must be 0 at every frame. A mean_abs_diff above ${GUIDE_DIFF_THRESHOLD} at a frame away from the reference sets guide_plate_renders_suspected: the guide plate probably renders in the parent (a slightly softer picture away from ref_time), so remove the rig and build it with guide_mode opacity_switch. A smaller nonzero value is worth a look but is not proof.`);
  if (written.flags?.guide_audio_off === false) notes.push("The plate copy's audio could not be muted: if the footage has sound, it plays a second time through the rig layer in guide_mode opacity_switch. Mute the copy inside the work comp by hand.");
  if (written.guide_mode === "opacity_switch") notes.push(`guide_mode opacity_switch finds its checkbox by the shot comp's name ("${ins.comp.name}") and the rig layer's name ("${workName}"): renaming either breaks the switch silently.`);
  if (written.guide_mode === "opacity_switch") notes.push("guide_mode opacity_switch: the steady plate in the work comp is invisible until you tick 'Show Stabilized Plate' on the rig layer's effect (and untick it again before rendering).");

  // After sheet and how far the rig moved the picture. Nothing here may throw: the write is in.
  let beforeSheet: string | undefined;
  let afterSheet: string | undefined;
  let sheetError: string | undefined = prep.beforeError;
  let pictureDiff: Array<{ time: number; mean_abs_diff: number | null }> | undefined;
  let guideSuspected: boolean | undefined;
  // The budget (its clock started before the queue wait and the track resolve) can run out before the first before frame.
  if (args.sheet && prep.before.length === 0) sheetError ??= "The render budget ran out before the first sheet frame was rendered; raise max_renders or max_seconds.";
  if (args.sheet && prep.before.length > 0) {
    try {
      const afterOp = ctx.bridge.newOpId();
      const shots = await queued(ctx, `${label} after`, afterOp, async () => {
        const got: Shot[] = [];
        for (const b of prep.before) {
          if (budget.exhausted()) break;
          got.push(await renderShot(ctx, afterOp, args.comp_id, b.time, 500 + got.length, framesDir, toolName));
          budget.spend();
          await yieldLoop();
        }
        return got;
      });
      const outline = patchOutline(track.comp_size);
      const frameByTime = new Map(plan.frames.map((f) => [f.time, f]));
      const moved = (t: number): Vec2[] | null => {
        const f = frameByTime.get(t);
        const out = f ? outline.map((c) => applyH(f.H, c)) : null;
        return out && out.every((c) => c !== null) ? (out as Vec2[]) : null;
      };
      const tiles = (list: Shot[], prefix: string): SheetTile[] => list.map((s) => ({ image: s.image, label: `${prefix} t=${r2(s.time)}`, outline: moved(s.time) }));
      beforeSheet = writeSheet(framesDir, `${opId}_rig_before`, drawStabSheet(tiles(prep.before, "before"), track.comp_size));
      if (shots.length > 0) afterSheet = writeSheet(framesDir, `${opId}_rig_after`, drawStabSheet(tiles(shots, "after"), track.comp_size));
      pictureDiff = shots.map((s) => {
        const b = prep.before.find((x) => x.time === s.time);
        return { time: s.time, mean_abs_diff: b ? meanAbsDiff(b.gray, s.gray) : null };
      });
      if (shots.length < prep.before.length) sheetError ??= "The render budget ran out before every after frame was rendered; raise max_renders.";
      const refFrameTime = plan.frames.reduce((best, f) => (Math.abs(f.time - refTime) < Math.abs(best - refTime) ? f.time : best), plan.frames[0].time);
      const measured = pictureDiff.some((d) => Math.abs(d.time - refFrameTime) > 1e-6 && d.mean_abs_diff !== null);
      if (measured) guideSuspected = guidePlateRenders(pictureDiff, refFrameTime);
      if (guideSuspected) notes.push(`picture_change is above ${GUIDE_DIFF_THRESHOLD} at a frame away from the reference: the guide plate probably renders in the shot comp (the rig should leave the picture unchanged). Remove the rig and build it again with guide_mode opacity_switch.`);
    } catch (err) {
      sheetError ??= errMessage(err);
    }
  }
  // Every way out that leaves the flag unset says so: the budget ran out, a before or an after render failed, or the frames could not be read.
  if (args.sheet && guideSuspected === undefined) notes.push("The guide-plate check was not measured: no frame away from the reference was compared (the render budget ran out, a sheet render failed, or the frames could not be read); raise max_renders and run again.");

  return {
    ok: true,
    op_id: written.op_id,
    applied: true,
    action: "build",
    scope: RIG_SCOPE,
    track_id: track.track_id,
    track_model: track.model,
    ref_time: r4(refTime),
    pad_px: pad,
    rig_kind: plan.kind,
    plate: { index: ins.layer.index, id: ins.layer.id, name: ins.layer.name },
    work_comp: written.work_comp ?? null,
    inner_layer: written.inner ? { id: written.inner.layer_id, guide: written.inner.guide } : null,
    outer_layer: written.outer ? { id: written.outer.layer_id, index: written.outer.layer_index, name: workName } : null,
    frames_written: plan.inner.times.length,
    roundtrip_error_px: plan.roundtrip_error_px,
    max_fit_px: plan.max_fit_px,
    flags: written.flags ?? null,
    ...(pictureDiff ? { picture_change: pictureDiff } : {}),
    ...(guideSuspected !== undefined ? { guide_plate_renders_suspected: guideSuspected } : {}),
    ...(beforeSheet ? { before_sheet_path: beforeSheet } : {}),
    ...(afterSheet ? { after_sheet_path: afterSheet } : {}),
    ...(sheetError ? { sheet_error: sheetError } : {}),
    how_to_use: [
      `Open the work comp "${workName}" (id ${written.work_comp?.id}): the plate is steady there, ${pad} px of padding on each side. Frame ${r2(refTime)} s is the reference.`,
      "Add patch layers inside the work comp as SEPARATE layers above the guide plate. Paint or masks on the guide plate itself never reach the shot comp, because a guide layer is not rendered there.",
      `Or run ae_cleanplate_setup (comp_id ${written.work_comp?.id}, plate {id: ${written.inner?.layer_id}}, no track) or ae_inpaint_plate (comp_id ${written.work_comp?.id}, plate_layer {id: ${written.inner?.layer_id}}, place_in_comp {comp_id: ${written.work_comp?.id}}: masked and centred, which matches the symmetric pad) on the work comp. Both render the plate copy, which must be visible there: with guide_mode guide_layer it is a guide layer and may render empty (unverified), with opacity_switch tick 'Show Stabilized Plate' on the rig layer first.`,
      `The rig layer sits directly above the plate in comp ${args.comp_id}; its comment holds pad_px ${pad}, ref_time ${r4(refTime)} and the track id, so other tools can place patches at the right offset.`,
      "Take the rig out again with action remove.",
    ],
    budget: { max_renders: args.max_renders, max_seconds: args.max_seconds, renders_used: budget.used.renders },
    notes,
    checkpoint: written.checkpoint,
    receipt: written.receipt,
    ...(written.user_changed ? { user_changed: written.user_changed } : {}),
  };
}

interface RemoveWritten {
  outer_id?: number;
  outer_name?: string;
  work_comp_id?: number;
  work_comp_name?: string;
  layers_deleted?: number;
  patches?: number;
  no_op?: boolean;
  [k: string]: unknown;
}

async function roundtripRemove(ctx: ToolContext, args: AeStabilizeRoundtripArgs): Promise<Record<string, unknown>> {
  const toolName = "ae_stabilize_roundtrip";
  const target = { ...(args.rig_layer ? { outer: args.rig_layer } : {}), ...(args.work_comp_id !== undefined ? { work_comp_id: args.work_comp_id } : {}) };
  const expect: ExpectGuard = { project_path: args.expect.project_path, comp_id: args.expect.comp_id ?? args.comp_id };
  const result = await runGuardedWrite<RemoveWritten>(ctx, {
    toolName,
    label: `ae_stabilize_roundtrip remove(${args.comp_id})`,
    expect,
    compId: args.comp_id,
    read: (phase, written) => {
      if (phase === "before") return { host: "stabilizeRigRead", args: { comp_id: args.comp_id, ...target } };
      const w = written as RemoveWritten | undefined;
      return { host: "stabilizeRigRead", args: { comp_id: args.comp_id, ...(w?.outer_id !== undefined ? { outer: { id: w.outer_id } } : {}), ...(w?.work_comp_id !== undefined ? { work_comp_id: w.work_comp_id } : {}) } };
    },
    write: { host: "stabilizeRigRemove", args: { comp_id: args.comp_id, ...target, delete_patches: args.delete_patches === true } },
    check: (before, after, written) => {
      const m: ReceiptMismatch[] = [];
      const a = after as RigRead | null;
      if (!a) return m;
      expectThat(m, a.outer?.found !== true, "outer.found", false, a.outer?.found, "The rig layer is still in the shot comp");
      expectThat(m, a.work?.found !== true, "work.found", false, a.work?.found, "The work comp is still in the project");
      const b = before as RigRead | null;
      if (b) expectThat(m, a.comp.num_layers === b.comp.num_layers - 1, "comp.num_layers", b.comp.num_layers - 1, a.comp.num_layers, "The shot comp's layer count did not drop by one");
      void written;
      return m;
    },
  });
  const w = result as unknown as RemoveWritten & { checkpoint: unknown; receipt: unknown; op_id: string; user_changed?: unknown };
  return {
    ok: true,
    op_id: w.op_id,
    applied: true,
    action: "remove",
    removed: { rig_layer: { id: w.outer_id, name: w.outer_name }, work_comp: { id: w.work_comp_id, name: w.work_comp_name }, layers_deleted_with_it: w.layers_deleted, patches: w.patches },
    notes: ["The plate itself was not touched."],
    checkpoint: w.checkpoint,
    receipt: w.receipt,
    ...(w.user_changed ? { user_changed: w.user_changed } : {}),
  };
}

// ---------- tools ----------

export const stabilizeTools: ToolDefinition<any>[] = [
  {
    name: "ae_stabilize",
    description:
      "Stabilize a plate layer from a track (a stored track_id from ae_track_multi / ae_track_read, or any source ae_track_read takes), inside the MCP and After Effects: no Warp Stabilizer analysis, no Tracker panel. " +
      "Modes: `lock` (the reference frame's framing is held: the plate gets the inverse of the track), `smooth` (only the jitter goes: the plate keeps the track smoothed with a Gaussian of `smooth_frames`, ends mirror-padded) and `position_only` (the pivot's translation only, even from a similarity track). " +
      "Targets: `layer_transform` (Anchor Point = the tracked pivot in layer space, Position, Rotation, Scale: how AE's own Stabilize writes them; refused on parented, 3D, locked, Auto-Orient (it would turn the plate along the written Position keys) or already keyed layers unless replace_keys), `transform_effect` (the 'Transform' effect, for when the layer's own transform must stay free; its Shutter Angle gives motion blur) and `corner_pin` (perspective tracks: the inverse homography as Corner Pin keys). " +
      "Edges: `scale_to_fill` finds the smallest zoom about the comp centre that keeps the comp covered on every frame and folds it into the keys (refused over max_zoom); `motion_tile` adds a Motion Tile with Mirror Edges on in front of the stabilizing. " +
      "Sets the layer to bicubic sampling (and, for transform_effect, the effect's own Sampling popup, which the layer switch does not reach). Not measured: whether the effect's shutter parameters, Uniform Scale, Sampling and a Motion Tile's Mirror Edges were found on this AE; the receipt and notes say when one was not. Frames the track did not solve get no key (listed). Keys are linear, one per ok frame; at most 3000 frames in one call and no second range afterwards, so longer shots are not supported whole (use range for a part). " +
      "Renders are budgeted (max_renders, max_seconds): before/after contact sheets (first, reference, last and worst-motion frame; paths in the result) and, with `verify`, the residual motion measured by normalized cross-correlation at the track's points on the stabilized render (lock aims under 0.5 px rms). Stabilizing resamples the whole plate: to fix something on a moving shot without softening it twice, use ae_stabilize_roundtrip. " +
      "Effect parameter names (Transform, Motion Tile) are mapped at run time and the table used is returned in `param_tables`. Guarded, checkpointed, one undo step, read back in a separate call. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeStabilizeSchema,
    handler: async (args: AeStabilizeArgs, ctx: ToolContext) => {
      try {
        return await stabilize(ctx, args);
      } catch (err) {
        if (err instanceof PlanarError) return fail(err);
        throw err;
      }
    },
  },
  {
    name: "ae_stabilize_roundtrip",
    description:
      "Build the 'stabilize, fix, unstabilize' rig in one undo step, without resampling the original plate. " +
      "build: (1) a work comp '<plate> STAB' (comp size + `pad_px` on each side, default 10% of the longer side) holding a copy of the plate stabilized from the track (lock, relative to ref_time), marked as a guide layer; (2) that work comp placed in the shot comp directly above the plate, with the exact inverse motion as keys, so anything placed in the work comp rides the moving shot while the guide plate does not render there; (3) the rig layer set to bicubic sampling, frame blending off and (for a similarity track) motion blur on. " +
      "Perspective and affine tracks use a Corner Pin in each half (a patch is resampled twice, with a warning). Padding is compensated in the keys: the result reports the worst distance (roundtrip_error_px) between the two halves' product and the plate's own placement, which is 0 for an exact inverse. " +
      "Refuses a plate that is 3D, locked, parented, time-remapped, keyed, has no source, or has effects or masks (unless copy_effects, which uses copyToComp; AE has crashed when undoing that). " +
      "Returns the ids, a before/after contact sheet with a test patch outline, how far the rig moved the picture, and a how-to list: add patch layers inside the work comp as SEPARATE layers above the guide plate (paint or masks on the guide plate itself never reach the shot comp). The rig layer's comment stores pad_px, ref_time and the track id. " +
      "LIVE CHECK: whether a guide layer inside a nested comp stays out of the parent's render and of snapshots is unmeasured; picture_change (before/after mean_abs_diff) must be 0 at every frame, a value above 0.3 away from the reference sets guide_plate_renders_suspected (any nonzero value is still worth a look; the flag is left out when no frame away from the reference was compared) (the rig is an exact inverse, so a rendering guide plate never looks doubled); guide_mode opacity_switch is the fallback. The plate copy's audio is muted in the work comp (it is the plate's own sound that plays), so it does not play twice. opacity_switch needs a unique shot comp name and rig layer name. A plate with separated Position under copy_effects is refused, and so is Auto-Orient on a plate for a transform rig with copy_effects (the copy carries it; without copy_effects the copy is a fresh layer). " +
      "remove: deletes a rig this tool made (rig_layer or work_comp_id), refusing when its work comp holds patches unless delete_patches. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeStabilizeRoundtripSchema,
    handler: async (args: AeStabilizeRoundtripArgs, ctx: ToolContext) => {
      try {
        if (args.action === "remove") return await roundtripRemove(ctx, args);
        return await roundtripBuild(ctx, args);
      } catch (err) {
        if (err instanceof PlanarError) return fail(err);
        throw err;
      }
    },
  },
];

// A layer selector re-exported for callers that build calls to these tools.
export type { LayerSelector };
