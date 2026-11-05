/**
 * server/src/tools/ext/cleanplate.ts
 *
 * Removing something from a shot with a patch ("freeze a frame, fix it, track
 * it back"), inside the MCP and After Effects (no outside tools):
 * - ae_cleanplate_pick: suggests the reference frame for a removal and the
 *   best clone sources. AE renders sampled frames (saveFrameToPng, as the frame
 *   tools do); the server scores each for sharpness, motion, track quality,
 *   coverage and, for a moving occluder, how clean the hole area is, and
 *   searches the ring around the hole for spatial clone offsets. Read only
 *   unless `isolate` is on (a temporary copy of the comp, removed again).
 * - ae_cleanplate_setup: builds the patch rig in one undo step: a freeze, a
 *   rendered still or an offset clone (compensated for the region centre's translation only) of the plate in a
 *   comp-size patch precomp, masked from the region with the expansion at
 *   least half the feather, tracked back onto the shot from the reference
 *   frame (planar's A.planarWriteRaw), optional holdout matte; with a
 *   before/after contact sheet. `action: "reload"` reloads a painted still.
 *
 * The end-to-end "remove something" chain (put in the tool descriptions):
 *  1. ae_snapshot_frame to look at the shot.
 *  2. ae_track_multi on the isolated plate with auto_points around the object
 *     (exclude = the object region) and a provisional ref_time; continue_track_id
 *     until done (ae_track_read instead when the user tracked in AE or Mocha AE).
 *  3. ae_cleanplate_pick: the recommended ref_time and clone sources.
 *  4. Clean pixels for the hole: a clean frame (moving occluder) -> source
 *     freeze with clean_frame; a static object -> ae_inpaint_plate, or source
 *     still + the user paints it + action reload, or clone_offset; a wire or
 *     blemish on a hard move -> ae_stabilize_roundtrip, then patch in the work comp.
 *  5. ae_cleanplate_setup: patch precomp, mask (expansion >= feather/2),
 *     tracked back from ref_time, holdout if something crosses in front.
 *  6. ae_patch_color_match, ae_patch_grain, ae_patch_finish.
 *  7. ae_patch_check; fix what it reports and check again; loop-play the region.
 *  Alternative at steps 4-5 when AE's own fill is wanted: ae_caf_prep.
 *
 * Not built, because AE has no API for it: clone-stamp or paint strokes by
 * script (scripts can add brush strokes only, never Clone strokes), and the
 * Layer > Time > Freeze Frame menu command (the freeze is rebuilt through the
 * DOM: time remap with one hold key, which is what the command does).
 *
 * Unmeasured on AE 26 (the code works either way and says what it did):
 * - precomposing a time-remapped duplicate keeps the hold;
 * - importFile of the PNG gets the sRGB interpretation (saveFrameToPng is
 *   taken as sRGB display values);
 * - the motion-compensated time clone stays aligned on a pan (only the shift
 *   of the region centre is compensated, not rotation or zoom);
 * - a precomp layer made by precompose is centred (anchor and position at the
 *   comp centre) so the keys computed on the server line up; the host checks;
 * - the hard limits of Mask Feather and Mask Expansion (validated server side
 *   against 0..500 px; AE's own limit may be tighter);
 * - the Laplacian/NSSD thresholds of the pick scoring, and the occluded/clean
 *   cleanliness limits of the temporal clone sources, are first guesses;
 * - the plate copy a work comp from ae_stabilize_roundtrip shows (a guide
 *   layer, perhaps) may render empty through saveFrameToPng (still source,
 *   before/after sheets): the work comp must have its plate copy visible, and
 *   the sheet or still is checked for a blank frame by eye.
 */

import * as fs from "node:fs";
import * as path from "node:path";
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
  type ToolContext,
  type ToolDefinition,
} from "../common.js";
import { autoCheckpoint, verifyTargetGuard } from "../mutate.js";
import { defaultFramesDir } from "../render.js";
import { captureCompFrame, decodePngFile } from "./frames.js";
import {
  applyH,
  frameAt,
  relativeTo,
  transformShape,
  type Mat3,
  type PlanarFrame,
  type PlanarTrack,
  type ShapeData,
  type Vec2,
} from "./planar-math.js";
import {
  buildLayerKeys,
  createRenderBudget,
  layerSampleOf,
  MAX_TRACK_FRAMES,
  PlanarError,
  platesFolderFor,
  RegionSchema,
  resolveTrackSource,
  TrackSourceSchema,
  withIsolatedPlate,
  type LayerKeys,
  type Region,
} from "./planar.js";
import { blit, createCanvas, drawLabel, drawPolygon, encodePng, fitWithin, resizeArea, type RgbaImage } from "./png-utils.js";
import {
  cropToBounds,
  gaussianBlurGray,
  laplacianEnergy,
  polygonArea,
  polygonBounds,
  rasterizePolygon,
  regionToPolygon,
  ringMask,
  warpPolygon,
  type Bounds,
  type Pt,
  type RegionSpec,
} from "./region-math.js";
import { noteAfterWrite, noteBeforeWrite, type WriteInfo } from "./session.js";
import { toGray, type GrayImage } from "./track.js";
import { expectThat, runGuardedWrite } from "./write-runner.js";

// ---------- small helpers ----------

const r2 = (v: number): number => Math.round(v * 100) / 100;
const r4 = (v: number): number => Math.round(v * 10000) / 10000;
const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const yieldLoop = (): Promise<void> => new Promise<void>((r) => setImmediate(r));
const failOut = (e: unknown) => ({ ok: false as const, error: (e as PlanarError).code, message: (e as Error).message });
const badArgs = (message: string) => new PlanarError("bad_args", message);

/** Entries a list in the result may hold (BUILDERS: bound every list, say so). */
const OUT_CAP = 500;
/** Frames one clone write keys (mask paths and positions); more must use `range`. */
const MAX_CLONE_FRAMES = 1000;
/** Numbers (3 per mask vertex per frame) a tracked clone sends in one write; more must use `range`. */
const MAX_CLONE_POINTS = 200_000;
/** Mask feather and expansion, px: validated here because AE throws "out of range" mid-write. */
const MAX_MASK_PX = 500;
const MAX_REGIONS = 16;
const SHEET_TILE = 480;

// ---------- regions ----------

/** The planar region (rect as x, y, w, h) as region-math's spec (rect as x0, y0, x1, y1). */
export function toSpec(r: Region): RegionSpec {
  if ("rect" in r) {
    const [x, y, w, h] = r.rect;
    return { kind: "rect", rect: [x, y, x + w, y + h] };
  }
  if ("ellipse" in r) return { kind: "ellipse", center: [r.ellipse[0], r.ellipse[1]], radius: [r.ellipse[2], r.ellipse[3]] };
  return { kind: "polygon", points: r.polygon.map((p) => [p[0], p[1]] as Pt) };
}

/** Throws a PlanarError for a region the host could not make a mask of. */
export function checkRegion(r: Region, label = "region"): void {
  const finite = (a: number[]) => a.every((v) => Number.isFinite(v));
  if ("rect" in r) {
    if (!finite(r.rect) || !(r.rect[2] > 0) || !(r.rect[3] > 0)) throw badArgs(`${label}: a rect needs a width and height above 0.`);
  } else if ("ellipse" in r) {
    if (!finite(r.ellipse) || !(r.ellipse[2] > 0) || !(r.ellipse[3] > 0)) throw badArgs(`${label}: an ellipse needs radii above 0.`);
  } else if (!r.polygon.every((p) => finite(p)) || polygonArea(r.polygon.map((p) => [p[0], p[1]] as Pt)) < 1) {
    throw badArgs(`${label}: a polygon needs finite corners and an area of at least 1 px^2.`);
  }
}

const KAPPA = 0.5522847498;

/** The region as a bezier mask shape: a rect or polygon as straight segments, an ellipse as four curved ones. */
export function regionToShape(r: Region): ShapeData {
  if ("ellipse" in r) {
    const [cx, cy, rx, ry] = r.ellipse;
    return {
      vertices: [[cx, cy - ry], [cx + rx, cy], [cx, cy + ry], [cx - rx, cy]],
      outTangents: [[KAPPA * rx, 0], [0, KAPPA * ry], [-KAPPA * rx, 0], [0, -KAPPA * ry]],
      inTangents: [[-KAPPA * rx, 0], [0, -KAPPA * ry], [KAPPA * rx, 0], [0, KAPPA * ry]],
      closed: true,
    };
  }
  const pts = regionToPolygon(toSpec(r));
  const zeros = pts.map(() => [0, 0] as Vec2);
  return { vertices: pts.map((p) => [p[0], p[1]] as Vec2), inTangents: zeros, outTangents: zeros.map((z) => [z[0], z[1]] as Vec2), closed: true };
}

/** Diagonal of the box around all regions, comp px. */
export function regionsDiagonal(regions: Region[]): number {
  const all: Pt[] = regions.flatMap((r) => regionToPolygon(toSpec(r)));
  if (all.length === 0) return 0;
  const b = polygonBounds(all);
  return Math.hypot(b[2] - b[0], b[3] - b[1]);
}

/**
 * Feather and expansion of the patch mask. Feather defaults to 2% of the
 * regions' diagonal; expansion is never less than half the feather, so the
 * object's edge cannot show through the soft rim (raised, and said so).
 */
export function maskParams(o: { diagonal: number; feather?: number; expansion?: number }): { feather: number; expansion: number; raised: boolean } {
  const feather = r2(o.feather !== undefined ? o.feather : Math.max(0.5, o.diagonal * 0.02));
  const wanted = o.expansion !== undefined ? o.expansion : feather / 2;
  const floor = feather / 2;
  return { feather, expansion: r2(Math.max(wanted, floor)), raised: o.expansion !== undefined && o.expansion < floor };
}

// ---------- track keys ----------

/** translate and similarity tracks drive the layer transform (layer motion blur works); affine and perspective add a Corner Pin for the rest. */
export function patchTrackMode(model: PlanarTrack["model"]): "transform" | "transform_pin" {
  return model === "translate" || model === "similarity" ? "transform" : "transform_pin";
}

/**
 * Keys that carry a patch precomp (comp size, centred, no parents: identity in
 * comp space) along the track. `track` has the reference frame as identity.
 */
export function patchTrackKeys(track: PlanarTrack, size: Vec2, range?: { start: number; end: number }): { mode: "transform" | "transform_pin"; keys: LayerKeys; not_ok: number[] } {
  const mode = patchTrackMode(track.model);
  const half = 0.5 / (track.fps > 0 ? track.fps : 25);
  const inRange = track.frames.filter((f) => !range || (f.time >= range.start - half && f.time <= range.end + half));
  const frames = inRange.filter((f) => f.ok && f.H !== null);
  if (frames.length === 0) throw badArgs("No frame of the track is ok inside that range, so there is nothing to track the patch with.");
  const c: Vec2 = [size[0] / 2, size[1] / 2];
  const base = { time: 0, anchor: c, position: c, scale: [100, 100] as Vec2, rotation: 0, parent_chain: [], three_d: false };
  const ref = layerSampleOf(base);
  const keys = buildLayerKeys({ mode, frames, ref, samples: frames.map((f) => layerSampleOf({ ...base, time: f.time })), size });
  return { mode, keys, not_ok: inRange.filter((f) => !(f.ok && f.H !== null)).map((f) => f.time) };
}

export interface CloneOffset {
  dx: number;
  dy: number;
  frames: number;
}

/**
 * Where the clone layer sits, per frame, relative to where it would sit
 * without an offset. The region centre c is at H(t)c at frame t; the content
 * that belongs there is at H(t+k)(c + (dx, dy)) in the frame k later, so the
 * clone moves by H(t)c - H(t+k)(c + o). Without a track (H = identity) that is
 * -(dx, dy): pixels from (dx, dy) away land on the hole. Frames where the track
 * has no H at t or t+k are left out (the keys interpolate across them).
 */
export function cloneShifts(a: { track: PlanarTrack; centre: Vec2; offset: CloneOffset; frames: PlanarFrame[] }): { times: number[]; shifts: Vec2[]; skipped: number[] } {
  const times: number[] = [];
  const shifts: Vec2[] = [];
  const skipped: number[] = [];
  const fps = a.track.fps > 0 ? a.track.fps : 25;
  const src: Vec2 = [a.centre[0] + a.offset.dx, a.centre[1] + a.offset.dy];
  for (const f of a.frames) {
    if (!f.ok || !f.H) {
      skipped.push(f.time);
      continue;
    }
    let Hk: Mat3 | null = f.H;
    if (a.offset.frames !== 0) {
      const g = frameAt(a.track, f.time + a.offset.frames / fps);
      Hk = g && g.ok && g.H ? g.H : null;
    }
    const p = applyH(f.H, a.centre);
    const q = Hk ? applyH(Hk, src) : null;
    if (!p || !q) {
      skipped.push(f.time);
      continue;
    }
    times.push(f.time);
    shifts.push([r4(p[0] - q[0]), r4(p[1] - q[1])]);
  }
  return { times, shifts, skipped };
}

/** The region shapes moved by the track at each ok frame (clone mode, where the patch layer itself stays put and its mask follows the shot). */
export function maskKeysFor(shapes: ShapeData[], frames: PlanarFrame[]): Array<{ times: number[]; shapes: ShapeData[] }> {
  const out = shapes.map(() => ({ times: [] as number[], shapes: [] as ShapeData[] }));
  for (const f of frames) {
    if (!f.ok || !f.H) continue;
    const moved: ShapeData[] = [];
    try {
      for (const s of shapes) {
        const t = transformShape(s, f.H);
        moved.push({ vertices: t.vertices, inTangents: t.inTangents, outTangents: t.outTangents, closed: true });
      }
    } catch {
      continue;
    }
    moved.forEach((m, i) => {
      out[i].times.push(f.time);
      out[i].shapes.push(m);
    });
  }
  return out;
}

// ---------- pick: scoring ----------

export interface RawFrameRow {
  time: number;
  /** False when the frame cannot be judged (no track data, region off the frame ...). */
  usable: boolean;
  reason?: string;
  /** sqrt of the Laplacian energy of the 1 px blurred gray in region + ring. */
  sharpness: number;
  /** Track speed in px per frame since the previous sample; null without a track. */
  speed: number | null;
  confidence: number | null;
  rms_px: number | null;
  coverage: number;
  /** Mean gray-level distance of the aligned hole area from the temporal median; null when not measured. */
  distance: number | null;
}

export interface ScoredFrame extends RawFrameRow {
  score: number;
  cleanliness: number | null;
  reasons: string[];
}

/** Share of the region that has to lie inside the frame for a frame to count. */
const MIN_COVERAGE = 0.9;
/** Gray levels of distance over the best frame's that halve the cleanliness. */
const CLEAN_SCALE = 6;

/**
 * Scores the sampled frames, 0..1, higher is better: sharpness (relative to the
 * sharpest frame), little motion, a solid track, coverage and, in
 * `moving_occluder` mode, cleanliness; frames near the middle of the range win
 * ties (drift splits both ways). Weights are first guesses.
 */
export function scoreFrames(rows: RawFrameRow[], o: { moving: boolean; start: number; end: number }): ScoredFrame[] {
  const usable = rows.filter((r) => r.usable && r.coverage >= MIN_COVERAGE);
  const maxSharp = Math.max(1e-9, ...usable.map((r) => r.sharpness));
  const dists = usable.map((r) => r.distance).filter((d): d is number => d !== null);
  const dMin = dists.length ? Math.min(...dists) : 0;
  const mid = (o.start + o.end) / 2;
  const half = Math.max(1e-6, (o.end - o.start) / 2);
  const w = o.moving ? { sharp: 0.25, motion: 0.2, track: 0.15, cover: 0.1, clean: 0.3 } : { sharp: 0.35, motion: 0.3, track: 0.2, cover: 0.15, clean: 0 };
  return rows.map((r) => {
    if (!r.usable) return { ...r, score: 0, cleanliness: null, reasons: [r.reason ?? "not usable"] };
    if (r.coverage < MIN_COVERAGE) return { ...r, score: 0, cleanliness: null, reasons: [`only ${Math.round(r.coverage * 100)}% of the region is inside the frame`] };
    const sharpN = r.sharpness / maxSharp;
    const motionN = r.speed === null ? 1 : 1 / (1 + r.speed / 2);
    const trackN = (r.confidence ?? 1) * (r.rms_px === null ? 1 : 1 / (1 + r.rms_px / 3));
    const coverN = Math.pow(r.coverage, 4);
    const cleanN = r.distance === null ? null : 1 / (1 + Math.max(0, r.distance - dMin) / CLEAN_SCALE);
    let total = w.sharp * sharpN + w.motion * motionN + w.track * trackN + w.cover * coverN;
    if (o.moving) total += w.clean * (cleanN ?? 0.5);
    const midFactor = 0.9 + 0.1 * (1 - Math.min(1, Math.abs(r.time - mid) / half));
    const reasons: string[] = [];
    if (sharpN >= 0.9) reasons.push("sharp");
    else if (sharpN < 0.5) reasons.push("soft (motion blur or defocus)");
    if (r.speed !== null) reasons.push(r.speed <= 0.5 ? "little motion" : r.speed > 3 ? `fast motion (${r2(r.speed)} px/frame): motion blur likely` : `${r2(r.speed)} px/frame`);
    if (r.confidence !== null) reasons.push(r.confidence >= 0.9 ? "track confident" : `track confidence ${r2(r.confidence)}`);
    if (cleanN !== null) reasons.push(cleanN >= 0.9 ? "hole area is clean" : cleanN < 0.5 ? "something else is in the hole area" : "hole area partly differs from the median");
    if (r.coverage < 0.999) reasons.push(`${Math.round(r.coverage * 100)}% of the region in frame`);
    return { ...r, score: r4(total * midFactor), cleanliness: cleanN === null ? null : r4(cleanN), reasons };
  });
}

/** The frame times to render: every Nth in the range, spread evenly down to `maxRenders` when that is more. */
export function planPickFrames(o: { fps: number; start: number; end: number; everyN: number; maxRenders: number }): { times: number[]; total: number; step: number } {
  const fps = o.fps > 0 ? o.fps : 24;
  const f0 = Math.round(o.start * fps);
  const f1 = Math.max(f0, Math.round(o.end * fps));
  const total = f1 - f0 + 1;
  let step = Math.max(1, o.everyN);
  const count = (s: number) => Math.floor((f1 - f0) / s) + 1;
  while (count(step) > o.maxRenders) step++;
  const times: number[] = [];
  for (let f = f0; f <= f1; f += step) times.push(f / fps);
  return { times, total, step };
}

// ---------- pick: aligned samples and the temporal median ----------

export interface AlignGrid {
  /** Top-left corner in the reference frame's comp px, and the size of one grid cell in comp px. */
  x0: number;
  y0: number;
  w: number;
  h: number;
  cell: number;
}

/** A grid over the polygon's box (plus a margin), at most `maxSide` cells on a side. */
export function alignGridFor(poly: Pt[], maxSide = 96, margin = 2): AlignGrid {
  const b = polygonBounds(poly);
  const bw = b[2] - b[0] + 2 * margin;
  const bh = b[3] - b[1] + 2 * margin;
  const cell = Math.max(1, Math.ceil(Math.max(bw, bh) / maxSide));
  return { x0: b[0] - margin, y0: b[1] - margin, w: Math.max(1, Math.ceil(bw / cell)), h: Math.max(1, Math.ceil(bh / cell)), cell };
}

function sampleGray(g: GrayImage, x: number, y: number): number {
  if (x < 0 || y < 0 || x > g.width - 1 || y > g.height - 1 || g.width < 2 || g.height < 2) return NaN;
  const x0 = Math.min(g.width - 2, Math.floor(x));
  const y0 = Math.min(g.height - 2, Math.floor(y));
  const fx = x - x0;
  const fy = y - y0;
  const i = y0 * g.width + x0;
  const top = g.data[i] * (1 - fx) + g.data[i + 1] * fx;
  const bottom = g.data[i + g.width] * (1 - fx) + g.data[i + g.width + 1] * fx;
  return top * (1 - fy) + bottom * fy;
}

/** The frame sampled on the reference grid: each cell's centre goes through H (reference -> this frame) and into the image. NaN where it falls outside. `origin` is the image px position of `gray`'s top-left corner when it is a crop. */
export function alignedSample(gray: GrayImage, scale: number, H: Mat3 | null, grid: AlignGrid, origin: Vec2 = [0, 0]): Float32Array {
  const out = new Float32Array(grid.w * grid.h).fill(NaN);
  if (!H) return out;
  for (let gy = 0; gy < grid.h; gy++) {
    for (let gx = 0; gx < grid.w; gx++) {
      const p = applyH(H, [grid.x0 + (gx + 0.5) * grid.cell, grid.y0 + (gy + 0.5) * grid.cell]);
      if (p) out[gy * grid.w + gx] = sampleGray(gray, p[0] * scale - 0.5 - origin[0], p[1] * scale - 0.5 - origin[1]);
    }
  }
  return out;
}

/** Per cell median over the samples that have a value there (NaN with fewer than 3). */
export function medianSample(samples: Float32Array[], size: number): Float32Array {
  const out = new Float32Array(size).fill(NaN);
  const vals: number[] = [];
  for (let i = 0; i < size; i++) {
    vals.length = 0;
    for (const s of samples) if (Number.isFinite(s[i])) vals.push(s[i]);
    if (vals.length < 3) continue;
    vals.sort((a, b) => a - b);
    const m = vals.length >> 1;
    out[i] = vals.length % 2 ? vals[m] : (vals[m - 1] + vals[m]) / 2;
  }
  return out;
}

/** Mean absolute gray-level distance of a sample from the median under a mask; null with fewer than 20 shared cells. */
export function medianDistance(sample: Float32Array, median: Float32Array, mask: Float32Array): number | null {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < sample.length; i++) {
    if (mask[i] < 0.5 || !Number.isFinite(sample[i]) || !Number.isFinite(median[i])) continue;
    sum += Math.abs(sample[i] - median[i]);
    n++;
  }
  return n >= 20 ? sum / n : null;
}

// ---------- pick: clone sources ----------

export interface SpatialSource {
  dx: number;
  dy: number;
  /** 1 - normalized cross-correlation of the ring with the shifted ring: 0 is a perfect match. */
  nssd: number;
}

/**
 * Spatial clone offsets (comp px): shifts whose ring-shaped neighbourhood has
 * the texture of the ring around the hole, found by normalized cross-correlation
 * over a window of `windowFactor` times the hole's size. Shifted holes must lie
 * in the frame and not touch the real hole. `poly` is the hole in comp px.
 */
export function findSpatialSources(
  gray: GrayImage,
  scale: number,
  poly: Pt[],
  o: { ringPx: number; windowFactor?: number; count?: number; maxCandidates?: number; clearancePx?: number }
): SpatialSource[] {
  const win = o.windowFactor ?? 3;
  const polyI: Pt[] = poly.map((p) => [p[0] * scale, p[1] * scale] as Pt);
  const b = polygonBounds(polyI);
  const bw = b[2] - b[0];
  const bh = b[3] - b[1];
  const ringI = Math.max(3, Math.round(o.ringPx * scale));
  // The patch mask covers hole + expansion + feather/2: the shifted hole must clear that rim too.
  const clr = Math.ceil(Math.max(2, o.clearancePx ?? 0) * scale);
  const margin = Math.ceil(win * Math.max(bw, bh) + ringI + 2);
  // The crop box, worked out arithmetically (no full-frame image is allocated for it).
  const x0 = Math.max(0, Math.floor(b[0] - margin));
  const y0 = Math.max(0, Math.floor(b[1] - margin));
  const x1 = Math.min(gray.width, Math.ceil(b[2] + margin));
  const y1 = Math.min(gray.height, Math.ceil(b[3] + margin));
  if (x1 <= x0 || y1 <= y0) return [];
  const cw = x1 - x0;
  const ch = y1 - y0;
  const sub: GrayImage = { width: cw, height: ch, data: new Float32Array(cw * ch) };
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) sub.data[y * cw + x] = gray.data[(y0 + y) * gray.width + x0 + x];
  const blurred = gaussianBlurGray(sub, 1);
  const local: Pt[] = polyI.map((p) => [p[0] - x0, p[1] - y0] as Pt);
  const ring = ringMask(cw, ch, local, 1, ringI);
  const hole = ringMask(cw, ch, local, -1e6, 1);
  const pts: number[] = [];
  for (let i = 0; i < ring.length; i++) if (ring[i] > 0) pts.push(i);
  if (pts.length < 40) return [];
  const stride = Math.max(1, Math.ceil(pts.length / 1500));
  const idx = pts.filter((_, i) => i % stride === 0);
  const a = idx.map((i) => blurred.data[i]);
  const meanA = a.reduce((s, v) => s + v, 0) / a.length;
  const varA = a.reduce((s, v) => s + (v - meanA) * (v - meanA), 0);
  if (varA < 1e-6) return [];
  const lb: Bounds = [b[0] - x0, b[1] - y0, b[2] - x0, b[3] - y0];
  const wx = Math.round(win * bw);
  const wy = Math.round(win * bh);
  let step = Math.max(1, Math.round(ringI / 4));
  const cands = (s: number) => (Math.floor((2 * wx) / s) + 1) * (Math.floor((2 * wy) / s) + 1);
  const cap = o.maxCandidates ?? 6000;
  while (cands(step) > cap) step++;
  const found: SpatialSource[] = [];
  const bvals = new Float32Array(idx.length);
  for (let dy = -wy; dy <= wy; dy += step) {
    for (let dx = -wx; dx <= wx; dx += step) {
      // The shifted hole's box must clear the real one and the mask rim around it (no object pixels in the source).
      if (Math.abs(dx) < bw + clr && Math.abs(dy) < bh + clr) continue;
      if (lb[0] + dx < 1 || lb[1] + dy < 1 || lb[2] + dx > cw - 2 || lb[3] + dy > ch - 2) continue;
      let ok = true;
      let sumB = 0;
      for (let k = 0; k < idx.length; k++) {
        const x = (idx[k] % cw) + dx;
        const y = Math.floor(idx[k] / cw) + dy;
        if (x < 0 || y < 0 || x >= cw || y >= ch || hole[y * cw + x] > 0) {
          ok = false;
          break;
        }
        bvals[k] = blurred.data[y * cw + x];
        sumB += bvals[k];
      }
      if (!ok) continue;
      const meanB = sumB / idx.length;
      let cov = 0;
      let varB = 0;
      for (let k = 0; k < idx.length; k++) {
        cov += (a[k] - meanA) * (bvals[k] - meanB);
        varB += (bvals[k] - meanB) * (bvals[k] - meanB);
      }
      if (varB < 1e-6) continue;
      found.push({ dx: r2(dx / scale), dy: r2(dy / scale), nssd: r4(1 - cov / Math.sqrt(varA * varB)) });
    }
  }
  found.sort((p, q) => p.nssd - q.nssd);
  const out: SpatialSource[] = [];
  const sep = Math.max(bw, bh) / scale / 2;
  for (const f of found) {
    if (out.length >= (o.count ?? 3)) break;
    if (out.some((s) => Math.hypot(s.dx - f.dx, s.dy - f.dy) < sep)) continue;
    out.push(f);
  }
  return out;
}

export interface TemporalSource {
  /** The frame offset k of clone_offset: at every time t the clone shows frame t + k. */
  frames: number;
  /** Occluded samples t whose t + k sample is clean. */
  covers: number;
  /** Occluded samples in all. */
  occluded: number;
  /** Clean samples t whose t + k sample is occluded: a clone live on those frames shows the occluder again. */
  contaminates: number;
  /** In point and out point (seconds; the out point is exclusive) that cover the occluded samples and the frames between samples around them: trim the patch layer to this span when contaminates > 0. */
  span: { start: number; end: number };
  coverage: number;
  /** Mean cleanliness of the frames the offset lands on. */
  cleanliness: number;
}

/** Cleanliness (0..1) under which a sample counts as occluded, and from which one counts as clean. First guesses. */
const OCCLUDED_BELOW = 0.6;
const CLEAN_FROM = 0.8;

/**
 * Constant frame offsets k for clone_offset. A clone with frames k shows frame
 * t + k at every time t, so what counts is whether t + k is clean for each
 * sampled t whose own hole area is occluded; but the clone is live on EVERY frame,
 * so a clean sample t whose t + k is occluded gets the occluder put back in
 * (`contaminates`). Candidates are multiples of the sampling step, ranked by
 * covers minus contaminates (then more covers, then smaller |k|). When
 * contaminates > 0 the patch layer must be trimmed to `span`, the occluded
 * stretch. Returns nothing when no sample is occluded or no offset covers any.
 */
export function temporalSources(rows: ScoredFrame[], o: { fps: number; step: number; count?: number }): TemporalSource[] {
  const fps = o.fps > 0 ? o.fps : 24;
  const byFrame = new Map<number, ScoredFrame>();
  for (const r of rows) if (r.usable && r.score > 0 && r.cleanliness !== null) byFrame.set(Math.round(r.time * fps), r);
  const occluded = [...byFrame.entries()].filter(([, r]) => (r.cleanliness as number) < OCCLUDED_BELOW);
  if (occluded.length === 0) return [];
  const frames = [...byFrame.keys()];
  const span = Math.max(...frames) - Math.min(...frames);
  const occFrames = occluded.map(([f]) => f);
  const step = Math.max(1, o.step);
  // Samples are `step` frames apart, so the occluder can be there up to step-1 frames before the first and after the last occluded sample; the out point is exclusive, so it sits one frame past the last frame to cover.
  const spanOcc = {
    start: r4(Math.max(Math.min(...occFrames) - (step - 1), Math.min(...frames)) / fps),
    end: r4(Math.min(Math.max(...occFrames) + step, Math.max(...frames) + 1) / fps)
  };
  const cleanFrames = [...byFrame.entries()].filter(([, r]) => (r.cleanliness as number) >= OCCLUDED_BELOW).map(([f]) => f);
  const found: TemporalSource[] = [];
  for (let k = -span; k <= span; k += step) {
    if (k === 0) continue;
    let covers = 0;
    let clean = 0;
    for (const [f] of occluded) {
      const target = byFrame.get(f + k);
      if (target && (target.cleanliness as number) >= CLEAN_FROM) {
        covers++;
        clean += target.cleanliness as number;
      }
    }
    if (covers === 0) continue;
    let contaminates = 0;
    for (const f of cleanFrames) {
      const target = byFrame.get(f + k);
      if (target && (target.cleanliness as number) < OCCLUDED_BELOW) contaminates++;
    }
    found.push({ frames: k, covers, occluded: occluded.length, contaminates, span: spanOcc, coverage: r4(covers / occluded.length), cleanliness: r4(clean / covers) });
  }
  found.sort((a, b) => b.covers - b.contaminates - (a.covers - a.contaminates) || b.covers - a.covers || Math.abs(a.frames) - Math.abs(b.frames));
  return found.slice(0, o.count ?? 3);
}

// ---------- contact sheets ----------

export interface SheetTile {
  image: RgbaImage;
  /** The region outline in comp px, or null. */
  poly: Pt[] | null;
  label: string;
}

/** Tiles in rows of `cols`, each shrunk to `tile` px (long edge) with the region outlined (yellow) and labelled. */
export function drawSheet(tiles: SheetTile[], o: { cols: number; compSize: Vec2; tile?: number }) {
  const tile = o.tile ?? SHEET_TILE;
  const drawn = tiles.map((t) => {
    const fit = fitWithin(t.image.width, t.image.height, tile);
    const img = resizeArea(t.image, fit.width, fit.height);
    const k = fit.width / o.compSize[0];
    if (t.poly) {
      drawPolygon(img, t.poly.map((p) => [p[0] * k, p[1] * k] as [number, number]), 1, [255, 214, 0, 255]);
    }
    drawLabel(img, t.label, 3, 3, 1, [16, 16, 16, 255], [255, 214, 0, 255], 2);
    return img;
  });
  const gap = 4;
  const cols = Math.max(1, Math.min(o.cols, drawn.length));
  const rows = Math.ceil(drawn.length / cols);
  const cw = Math.max(...drawn.map((d) => d.width));
  const chh = Math.max(...drawn.map((d) => d.height));
  const sheet = createCanvas(cols * cw + (cols - 1) * gap, rows * chh + (rows - 1) * gap, [24, 24, 24, 255]);
  drawn.forEach((d, i) => blit(sheet, d, (i % cols) * (cw + gap), Math.floor(i / cols) * (chh + gap)));
  return sheet;
}

function writeSheetFile(dir: string, tag: string, sheet: ReturnType<typeof drawSheet>): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `cleanplate_${tag}.png`);
  fs.writeFileSync(file, encodePng(sheet));
  return file;
}

// ---------- plumbing ----------

async function queued<T>(ctx: ToolContext, label: string, opId: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await ctx.queue.run(label, fn);
  } catch (err) {
    if (err instanceof QueueWaitError) throw new BridgeError({ kind: "queued", op_id: opId, message: err.message });
    throw err;
  }
}

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

export interface HostLayerInfo {
  index: number;
  id: number;
  name: string;
  kind: string;
  locked: boolean;
  three_d: boolean;
  has_video: boolean;
  enabled: boolean;
  parent_id: number | null;
  start_time: number;
  stretch: number;
  in_point: number;
  out_point: number;
  width: number;
  height: number;
  source_id: number | null;
  source_is_still: boolean;
  can_time_remap: boolean | null;
  time_remap_enabled: boolean;
  modern_matte_api: boolean;
  /** Which of Anchor, Position, Scale, Rotation have keys or an expression. */
  transform_animated: string[];
  /** Opacity has keys or an expression. */
  opacity_animated?: boolean;
  /** Effects with a keyed or expression-driven parameter (Corner Pin, Transform ...). */
  effects_animated?: string[];
  position_separated: boolean;
  position: Vec2;
}

export interface HostCleanplateRead {
  comp: {
    id: number;
    name: string;
    width: number;
    height: number;
    pixel_aspect: number;
    fps: number;
    frame_duration: number;
    duration: number;
    work_area_start: number;
    work_area_duration: number;
    motion_blur: boolean | null;
    resolution_factor: number[] | null;
  };
  project: { path: string; bits_per_channel: number | null; linear_blending: boolean | null };
  plate: HostLayerInfo | null;
  holdout: HostLayerInfo | null;
  num_layers: number;
}

function checkComp(info: HostCleanplateRead): void {
  const pa = Number(info.comp.pixel_aspect);
  if (pa > 0 && Math.abs(pa - 1) > 1e-6) throw new PlanarError("refused", `The comp's pixel aspect is ${pa}, not 1. The patch tools work on square pixels only.`);
}

const snapFrame = (t: number, fps: number): number => Math.round(t * fps) / fps;

/** Records the writes of a finished isolate as the agent's own (session tracker); never throws. */
async function noteWritten(ctx: ToolContext, note: WriteInfo): Promise<void> {
  try {
    await noteAfterWrite(ctx, note, { addStep: true });
  } catch {
    // reporting only
  }
}

// ---------- schemas ----------

const RegionTimeField = z.number().min(0).optional();

export const AeCleanplatePickSchema = z
  .object({
    comp_id: z.number().int().describe("The composition that holds the shot."),
    region: RegionSchema.describe("The thing to remove, in comp pixels at `region_time`: { rect: [x, y, w, h] }, { ellipse: [cx, cy, rx, ry] } or { polygon: [[x, y], ...] }."),
    region_time: RegionTimeField.describe("The time (seconds) the region is drawn at. Default: the track's reference frame, else the middle of the range."),
    track: TrackSourceSchema.optional().describe(
      "How the shot moves, so the region follows it: a track_id from ae_track_multi / ae_track_read, or any source they take. Without it the region is taken as static in comp space, which is right only for a locked-off shot (the result says so)."
    ),
    mode: z
      .enum(["static", "moving_occluder"])
      .default("static")
      .describe("static: the object stays in the hole all shot (look for a sharp, calm frame). moving_occluder: something passes through the hole area (a person walking past): frames where the aligned hole area matches the temporal median of all samples are clean, and time-offset clone sources are proposed. Default static."),
    plate: LayerSelectorSchema.optional().describe("The plate layer. With `isolate` the renders show only this layer, so patches and overlays above it do not count."),
    isolate: z.boolean().default(false).describe("Render a temporary copy of the comp with only `plate` on (removed again in the same call: two undo entries; needs `expect` and `plate`). Default false: the comp is rendered as it is and nothing in the project is touched."),
    start: z.number().min(0).optional().describe("First time to sample, seconds. Default the work area start."),
    end: z.number().min(0).optional().describe("Last time to sample, seconds. Default the work area end."),
    every_n: z.number().int().min(1).max(1000).default(2).describe("Sample every Nth frame. Default 2. Raised automatically when max_renders would be exceeded."),
    max_renders: z.number().int().min(4).max(120).default(80).describe("Most renders this call makes, the re-render of the best frame included. Default 80. When the range needs more, frames are spread evenly and the result says 'sampled N of M'."),
    max_seconds: z.number().min(5).max(540).default(120).describe("Most seconds of rendering. When it runs out the frames scored so far are used ('sampled N of M')."),
    ring_px: z.number().min(4).max(400).optional().describe("Width in comp pixels of the ring around the hole whose texture clone sources must match. Default a quarter of the hole's longer side, at least 8."),
    contact_sheet: z.boolean().default(true).describe("Write a contact sheet of the top 5 frames with the region outlined. Default true."),
    expect: ExpectSchema.optional().describe("Needed with `isolate`, ignored without it."),
  })
  .refine((v) => !v.isolate || (v.expect !== undefined && v.plate !== undefined), { message: "isolate writes a temporary comp: give `plate` and `expect`." });
export type AeCleanplatePickArgs = z.infer<typeof AeCleanplatePickSchema>;

const OffsetSchema = z.object({
  dx: z.number().min(-10000).max(10000).default(0).describe("Take pixels from this far to the right of the hole (comp px, negative: left)."),
  dy: z.number().min(-10000).max(10000).default(0).describe("Take pixels from this far below the hole (comp px, negative: above)."),
  frames: z.number().int().min(-1000).max(1000).default(0).describe("Take pixels from this many frames later (negative: earlier). With a track the shift is compensated per frame for the translation of the region centre only (not rotation, zoom or perspective)."),
});

export const AeCleanplateSetupSchema = z
  .object({
    comp_id: z.number().int().describe("The composition that holds the shot (for a steady shot, the work comp from ae_stabilize_roundtrip: pass it here and omit `track`)."),
    action: z.enum(["build", "reload"]).default("build").describe("build: make the patch rig. reload: reload a painted still (FootageItem.mainSource.reload(), no dialog) and re-render the before/after sheet."),
    plate: LayerSelectorSchema.optional().describe("build: the plate layer the patch goes above."),
    source: z
      .enum(["freeze", "still", "clone_offset"])
      .default("freeze")
      .describe(
        "freeze: duplicate the plate and time-remap one hold key at ref_time (the plate's own transform keys are replaced by their value at ref_time). " +
          "still: render the isolated plate at ref_time to a PNG in '<project> chroma plates/' next to the saved project and import it (paint it in Photoshop, then action 'reload'), or place `still_footage_id`. 8-bit sRGB: in 16/32 bpc or linear projects prefer freeze. " +
          "clone_offset: duplicate the plate shifted by `offset` (a live clone that moves with the shot; with a track the shift is compensated per frame for the translation of the region centre only (not rotation, zoom or perspective))."
      ),
    ref_time: z.number().min(0).optional().describe("build: the reference frame in seconds: the freeze/still frame, and the frame `region` is drawn at (the track is re-based so this frame is the identity). Snapped to the comp's frame grid (the result says so) and must lie inside the plate layer's in/out. After ae_cleanplate_pick use its setup_args: the region there is drawn at the recommended frame."),
    region: RegionSchema.optional().describe("build: the thing to cover, in comp pixels at ref_time. One shape."),
    regions: z.array(RegionSchema).min(1).max(MAX_REGIONS).optional().describe(`build: up to ${MAX_REGIONS} shapes as separate Add masks on the same patch layer (a row of tracking markers on one wall).`),
    track: TrackSourceSchema.optional().describe("build: how the shot moves (track_id from ae_track_multi / ae_track_read, or a source they take). Without it the patch stays put: right for a locked-off shot or a steady work comp. translate/similarity tracks key the patch layer's transform (layer motion blur works); affine/perspective add a Corner Pin; the mask rides the pin because masks render before effects."),
    feather_px: z.number().min(0).max(MAX_MASK_PX).optional().describe("build: mask feather in px. Default 2% of the regions' diagonal."),
    expansion_px: z.number().min(0).max(MAX_MASK_PX).optional().describe("build: mask expansion in px. Never less than half the feather (raised if lower), so the object's edge cannot show through."),
    clean_frame: z.boolean().optional().describe("build, freeze/still: say true when the frozen frame is already clean in the hole (a moving occluder seen before or after it passes; ae_cleanplate_pick's cleanliness says so). clone_offset: say true when the frame offset lands on frames where the hole is clean (pick's temporal sources); a clone whose spatial offset does not clear the hole is otherwise flagged. Otherwise the result has needs_fix: true."),
    still_footage_id: z.number().int().optional().describe("build, source still: use this footage item (a PNG made by ae_inpaint_plate, comp-sized) instead of rendering one."),
    offset: OffsetSchema.optional().describe("build, source clone_offset: where the clone's pixels come from."),
    holdout: LayerSelectorSchema.optional().describe("build: a layer (a roto of an actor crossing the patch) used as an inverted alpha track matte on the patch, so the patch never covers it. AE 23+. Its video is switched off, as AE's UI does."),
    name: z.string().min(1).max(100).optional().describe("build: base name of the patch layer and comp. Default '<plate> PATCH f<frame>'."),
    range: z.object({ start: z.number().min(0), end: z.number().min(0) }).optional().describe("build: write track keys only for frames in this range (seconds). Needed when the track has more than 3000 frames (1000 for clone_offset)."),
    footage_id: z.number().int().optional().describe("reload: the footage item to reload."),
    patch_comp_id: z.number().int().optional().describe("reload: a patch precomp; the first still image (file footage with a still source) in it is reloaded. A freeze or clone patch holds the plate's movie, not a still, and is refused."),
    expect: ExpectSchema,
  })
  .refine((v) => v.action !== "build" || v.plate !== undefined, { message: "build needs `plate`." })
  .refine((v) => v.action !== "build" || v.ref_time !== undefined, { message: "build needs `ref_time`." })
  .refine((v) => v.action !== "build" || [v.region, v.regions].filter((x) => x !== undefined).length === 1, { message: "build needs exactly one of `region` or `regions`." })
  .refine((v) => v.action !== "reload" || [v.footage_id, v.patch_comp_id].filter((x) => x !== undefined).length === 1, { message: "reload needs exactly one of `footage_id` or `patch_comp_id`." })
  .refine((v) => v.still_footage_id === undefined || v.source === "still", { message: "still_footage_id belongs to source 'still'." })
  .refine((v) => (v.source === "clone_offset") === (v.offset !== undefined) || v.action === "reload", { message: "offset is needed for source 'clone_offset' and belongs to it only." })
  .refine((v) => v.source !== "clone_offset" || v.offset === undefined || v.offset.dx !== 0 || v.offset.dy !== 0 || v.offset.frames !== 0, { message: "offset moves nothing: give dx, dy or frames." });
export type AeCleanplateSetupArgs = z.infer<typeof AeCleanplateSetupSchema>;

// ---------- ae_cleanplate_pick ----------

interface PickRun {
  rows: ScoredFrame[];
  best: ScoredFrame | null;
  spatial: SpatialSource[];
  temporal: TemporalSource[];
  sheet: string | undefined;
  sheetError: string | undefined;
  sampled: number;
  total: number;
  step: number;
  rendersUsed: number;
  renderError: string | undefined;
  fps: number;
  regionTime: number;
  trackNote: string;
  ringPx: number;
  /** The region as it lies at the best frame (the track's motion applied), comp px; null without a best frame. */
  bestPoly: Pt[] | null;
}

async function pickCore(ctx: ToolContext, args: AeCleanplatePickArgs, opId: string, info: HostCleanplateRead, renderCompId: number, track: PlanarTrack | null, regionTime: number, framesDir: string, budget: ReturnType<typeof createRenderBudget>): Promise<PickRun> {
  const toolName = "ae_cleanplate_pick";
  const fps = info.comp.fps > 0 ? info.comp.fps : 25;
  const compSize: Vec2 = [info.comp.width, info.comp.height];
  const start = snapFrame(args.start ?? info.comp.work_area_start, fps);
  const end = snapFrame(args.end ?? info.comp.work_area_start + info.comp.work_area_duration - 1 / fps, fps);
  if (end < start) throw badArgs("end is before start.");
  const plan = planPickFrames({ fps, start, end, everyN: args.every_n, maxRenders: Math.max(1, args.max_renders - 1) });
  const poly0 = regionToPolygon(toSpec(args.region));
  const b0 = polygonBounds(poly0);
  const longSide = Math.max(b0[2] - b0[0], b0[3] - b0[1]);
  const ringPx = args.ring_px ?? Math.max(8, Math.round(longSide / 4));
  const moving = args.mode === "moving_occluder";
  const based = track ? relativeTo(track, regionTime) : null;
  const grid = alignGridFor(poly0);
  const gridMask = rasterizePolygon(grid.w, grid.h, poly0.map((p) => [(p[0] - grid.x0) / grid.cell, (p[1] - grid.y0) / grid.cell] as Pt));
  const thumbs: Array<RgbaImage | null> = [];
  const polys: Array<Pt[] | null> = [];
  const aligned: Array<Float32Array | null> = [];
  const raw: RawFrameRow[] = [];
  const centres: Array<Pt | null> = [];
  let scale = 1;
  let renderError: string | undefined;
  let rendered = 0;

  const snap = async (time: number, idx: number): Promise<ReturnType<typeof decodePngFile>> => {
    const s = await captureCompFrame({ ctx, opId, compId: renderCompId, time, frameIndex: idx, framesDir, toolName });
    budget.spend();
    try {
      return decodePngFile(s.path);
    } finally {
      fs.rmSync(s.path, { force: true });
    }
  };

  for (let i = 0; i < plan.times.length; i++) {
    if (budget.exhausted()) break;
    const t = plan.times[i];
    let frame: PlanarFrame | null = null;
    let H: Mat3 | null = null;
    let unusable: string | undefined;
    if (based) {
      frame = frameAt(based, t);
      if (!frame) unusable = "the track has no data at this time";
      else if (!frame.ok || !frame.H) unusable = frame.note ?? "the track did not solve this frame";
      else H = frame.H;
    }
    const poly = H ? warpPolygon(poly0, H) : unusable ? null : poly0;
    if (!poly && !unusable) unusable = "the track puts the region behind the horizon";
    if (!poly) {
      // Known to be unusable without a render: no frame is spent on it.
      thumbs.push(null);
      polys.push(null);
      aligned.push(null);
      centres.push(null);
      raw.push({ time: t, usable: false, reason: unusable, sharpness: 0, speed: null, confidence: null, rms_px: null, coverage: 0, distance: null });
      continue;
    }
    let png;
    try {
      png = await snap(t, i);
    } catch (err) {
      renderError = errMessage(err);
      break;
    }
    rendered++;
    scale = png.width / compSize[0];
    const tf = fitWithin(png.width, png.height, 360);
    thumbs.push(resizeArea(png, tf.width, tf.height));
    polys.push(poly);
    // Sharpness in the region plus its ring, on a 1 px pre-blurred gray (grain would inflate the Laplacian).
    const polyI = poly.map((p) => [p[0] * scale, p[1] * scale] as Pt);
    const bb = polygonBounds(polyI);
    const ringI = ringPx * scale;
    const crop = cropToBounds(png, bb, Math.ceil(ringI) + 4);
    let sharp = 0;
    if (crop) {
      const local = polyI.map((p) => [p[0] - crop.x0, p[1] - crop.y0] as Pt);
      const gray = gaussianBlurGray(toGray(crop.img), 1);
      sharp = Math.sqrt(laplacianEnergy(gray, ringMask(crop.img.width, crop.img.height, local, -1e6, ringI)));
    }
    // Coverage: the share of the region inside the frame, on a coarse raster.
    const k = Math.min(1, 160 / Math.max(compSize[0], compSize[1]));
    const cw = Math.max(4, Math.round(compSize[0] * k));
    const chh = Math.max(4, Math.round(compSize[1] * k));
    const cov = rasterizePolygon(cw, chh, poly.map((p) => [p[0] * k, p[1] * k] as Pt));
    let covered = 0;
    for (let q = 0; q < cov.length; q++) covered += cov[q];
    const area = polygonArea(poly.map((p) => [p[0] * k, p[1] * k] as Pt));
    const coverage = area > 1e-9 ? Math.min(1, covered / area) : 0;
    // Motion: the region centre's speed, filled in after the loop (every frame is judged against a neighbour).
    centres.push([(bb[0] + bb[2]) / 2 / scale, (bb[1] + bb[3]) / 2 / scale]);
    const conf = frame ? frame.confidence.filter((c): c is number => c !== null) : [];
    if (moving) {
      // Only the part of the frame the grid lands on is turned to gray and blurred (not the whole render).
      const Hm: Mat3 = H ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
      const box: Pt[] = [[grid.x0, grid.y0], [grid.x0 + grid.w * grid.cell, grid.y0], [grid.x0 + grid.w * grid.cell, grid.y0 + grid.h * grid.cell], [grid.x0, grid.y0 + grid.h * grid.cell]];
      const moved = warpPolygon(box, Hm);
      const gc = moved ? cropToBounds(png, polygonBounds(moved.map((q) => [q[0] * scale, q[1] * scale] as Pt)), 4) : null;
      aligned.push(gc ? alignedSample(gaussianBlurGray(toGray(gc.img), 1), scale, Hm, grid, [gc.x0, gc.y0]) : null);
    } else aligned.push(null);
    raw.push({
      time: t,
      usable: true,
      sharpness: r4(sharp),
      speed: null,
      confidence: frame ? (conf.length ? r4(conf.reduce((s, c) => s + c, 0) / conf.length) : null) : null,
      rms_px: frame && frame.rms_px !== null ? frame.rms_px : null,
      coverage: r4(coverage),
      distance: null,
    });
    await yieldLoop();
  }

  // Motion in px per frame, from the previous usable sample (the first one from the next), so every frame is judged.
  if (based) {
    const idx = raw.map((_, i) => i).filter((i) => centres[i] !== null);
    idx.forEach((i, n) => {
      const j = n > 0 ? idx[n - 1] : idx[n + 1];
      if (j === undefined) return;
      const a = centres[i] as Pt;
      const bC = centres[j] as Pt;
      const gap = Math.max(1, Math.round(Math.abs(raw[i].time - raw[j].time) * fps));
      raw[i].speed = r4(Math.hypot(a[0] - bC[0], a[1] - bC[1]) / gap);
    });
  }

  // Cleanliness: the aligned hole area against the median of all aligned samples.
  if (moving) {
    const have = aligned.filter((a): a is Float32Array => a !== null);
    const med = medianSample(have, grid.w * grid.h);
    raw.forEach((r, i) => {
      const a = aligned[i];
      if (r.usable && a) r.distance = medianDistance(a, med, gridMask);
    });
  }
  const scored = scoreFrames(raw, { moving, start, end });
  const ranked = scored.filter((r) => r.usable && r.score > 0).sort((a, b) => b.score - a.score);
  const best = ranked[0] ?? null;

  // Clone sources, from the best frame (re-rendered: only crops and thumbnails were kept).
  let spatial: SpatialSource[] = [];
  const temporal: PickRun["temporal"] = [];
  const bestPoly = best ? polys[scored.indexOf(best)] ?? null : null;
  if (best && !budget.exhausted()) {
    try {
      const bPoly = bestPoly;
      const png = await snap(best.time, 9000);
      rendered++;
      if (bPoly) {
        // The mask rim (expansion + feather/2) is part of what the clone must clear.
        const bb2 = polygonBounds(bPoly);
        const mp = maskParams({ diagonal: Math.hypot(bb2[2] - bb2[0], bb2[3] - bb2[1]) });
        spatial = findSpatialSources(toGray(png), png.width / compSize[0], bPoly, { ringPx, count: 3, clearancePx: mp.expansion + mp.feather / 2 });
      }
    } catch (err) {
      renderError = renderError ?? errMessage(err);
    }
  }
  if (moving && best) temporal.push(...temporalSources(scored, { fps, step: plan.step, count: 3 }));

  let sheet: string | undefined;
  let sheetError: string | undefined;
  if (args.contact_sheet && ranked.length > 0) {
    try {
      const tiles: SheetTile[] = ranked.slice(0, 5).map((r, n) => {
        const i = scored.indexOf(r);
        return { image: thumbs[i] as RgbaImage, poly: polys[i], label: `#${n + 1} t=${r2(r.time)} s=${r.score}` };
      });
      // The thumbnails are smaller than the comp: the outline is scaled to them, so give drawSheet the comp size.
      sheet = writeSheetFile(framesDir, `pick_${opId}`, drawSheet(tiles, { cols: 3, compSize }));
    } catch (err) {
      sheetError = errMessage(err);
    }
  }
  return {
    rows: scored,
    best,
    spatial,
    temporal,
    sheet,
    sheetError,
    sampled: rendered > 0 ? raw.length : 0,
    total: plan.times.length,
    step: plan.step,
    rendersUsed: budget.used.renders,
    renderError,
    fps,
    regionTime,
    trackNote: track ? `Region moved by track ${track.track_id} (${track.model}).` : "No track: the region is taken as static in comp space, which is right only for a locked-off shot.",
    ringPx,
    bestPoly,
  };
}

async function pick(ctx: ToolContext, args: AeCleanplatePickArgs): Promise<Record<string, unknown>> {
  const toolName = "ae_cleanplate_pick";
  const opId = ctx.bridge.newOpId();
  const framesDir = defaultFramesDir();
  fs.mkdirSync(framesDir, { recursive: true });
  const label = `${toolName}(${args.comp_id})`;
  checkRegion(args.region);
  if (args.start !== undefined && args.end !== undefined && args.end < args.start) throw badArgs("end is before start.");
  const expect: ExpectGuard | null = args.isolate && args.expect ? { project_path: args.expect.project_path, comp_id: args.expect.comp_id ?? args.comp_id } : null;
  if (expect) ctx.quarantine.assertClear();
  // The render budget starts when the work does, not while the call waits in the queue.
  const newBudget = () => createRenderBudget({ maxRenders: args.max_renders, maxSeconds: args.max_seconds });

  const ran = await queued(ctx, label, opId, async () => {
    const info = await readHost<HostCleanplateRead>(ctx, opId, "read", "cleanplateRead", { comp_id: args.comp_id, ...(args.plate ? { plate: args.plate } : {}) }, toolName);
    checkComp(info);
    const fps = info.comp.fps > 0 ? info.comp.fps : 25;
    let track: PlanarTrack | null = null;
    if (args.track) {
      track = await resolveTrackSource(ctx, opId, args.comp_id, args.track);
      if (Math.abs(track.comp_size[0] - info.comp.width) > 0.5 || Math.abs(track.comp_size[1] - info.comp.height) > 0.5) {
        throw new PlanarError("refused", `The track was made in a ${track.comp_size[0]}x${track.comp_size[1]} comp and this one is ${info.comp.width}x${info.comp.height}: the points are in comp pixels, so the sizes must match.`);
      }
    }
    const start = snapFrame(args.start ?? info.comp.work_area_start, fps);
    const end = snapFrame(args.end ?? info.comp.work_area_start + info.comp.work_area_duration - 1 / fps, fps);
    // Refused here, before any render and before an isolate makes its temporary copy.
    if (end < start) throw badArgs("end is before start.");
    const regionTime = snapFrame(args.region_time ?? track?.ref_time ?? (start + end) / 2, fps);
    if (track) {
      const rf = frameAt(relativeTo(track, regionTime), regionTime);
      if (!rf || !rf.ok || !rf.H) throw badArgs(`The track has no solved motion at region_time ${r2(regionTime)} s, so the region cannot be moved with it. Give region_time at a frame the track solved (the track's own ref_time is the default).`);
    }
    if (!expect) return { value: await pickCore(ctx, args, opId, info, args.comp_id, track, regionTime, framesDir, newBudget()), temp: null as null | { copy_id: number; removed: boolean; error?: string }, checkpoint: null, sessionFields: {} };

    const plateInfo = info.plate;
    if (!plateInfo) throw new PlanarError("not_found", "The plate layer was not found.");
    ctx.quarantine.assertClear();
    const guard = await verifyTargetGuard(ctx, expect, opId);
    const checkpoint = await autoCheckpoint(ctx, guard, toolName);
    const note: WriteInfo = { opId, toolName, label, expect, checkpoint: checkpoint?.path ?? null };
    const sessionFields = await noteBeforeWrite(ctx, note);
    try {
      const budget = newBudget();
      const iso = await withIsolatedPlate(ctx, opId, { compId: args.comp_id, showLayers: [{ index: plateInfo.index, id: plateInfo.id }], expect, toolName, note }, (copyId) =>
        pickCore(ctx, args, opId, info, copyId, track, regionTime, framesDir, budget)
      );
      await noteWritten(ctx, note);
      return { value: iso.value, temp: iso.temp, checkpoint, sessionFields };
    } catch (err) {
      const temp = (err as { plateTemp?: { copy_id: number; removed: boolean; error?: string } }).plateTemp;
      // The copy was made (and maybe removed again): those undo entries are ours.
      if (temp) await noteWritten(ctx, note);
      if (temp) return { failure: { error: err instanceof PlanarError ? err.code : "failed", message: errMessage(err), temp, checkpoint, sessionFields } };
      throw err;
    }
  });

  if ("failure" in ran && ran.failure) {
    const f = ran.failure;
    return {
      ok: false,
      error: f.error,
      message: `${f.message} (isolate had already made a temporary copy of the comp${f.temp.removed ? " and removed it again: two undo entries" : ""}.)`,
      temp_comp: { copy_removed: f.temp.removed, ...(f.temp.error ? { error: f.temp.error } : {}) },
      checkpoint: f.checkpoint,
      receipt: buildReceipt({ before: null, after: { temp_comp: f.temp }, customMismatches: tempMismatch(f.temp) }),
      ...f.sessionFields,
    };
  }
  const v = (ran as { value: PickRun }).value;
  const temp = (ran as { temp: { copy_id: number; removed: boolean; error?: string } | null }).temp;
  const notes: string[] = [v.trackNote];
  if (v.sampled < v.total) notes.push(`Sampled ${v.sampled} of ${v.total} planned frames (render budget or time ran out).`);
  if (v.step > args.every_n) notes.push(`Every ${v.step}th frame was sampled, not every ${args.every_n}th, to stay inside max_renders.`);
  if (v.renderError) notes.push(`A render failed: ${v.renderError}`);
  if (v.sheetError) notes.push(`The contact sheet could not be written: ${v.sheetError}`);
  if (!args.isolate) notes.push("Rendered the comp as it is: patches and overlays above the plate count in the scores. Use isolate with `plate` to score the plate alone.");
  if (temp) notes.push("isolate made a temporary copy of the comp and removed it again: two undo entries, one for each.");
  if (!v.best) notes.push("No frame could be scored: check the track (frames not ok), the region (inside the frame?) and the range.");
  const visible = v.rows.filter((r) => r.usable).sort((a, b) => b.score - a.score);
  // The region as it lies at the recommended frame: ae_cleanplate_setup reads `region` at ref_time.
  const regionAtBest = v.bestPoly ? { polygon: v.bestPoly.map((p) => [r2(p[0]), r2(p[1])]) } : null;
  const asked = args.track ? { track: args.track } : {};
  return {
    ok: true,
    mode: args.mode,
    recommended_ref_time: v.best ? r4(v.best.time) : null,
    recommended_frame: v.best ? Math.round(v.best.time * v.fps) : null,
    region_time: r4(v.regionTime),
    ...(regionAtBest && v.best ? { region_at_recommended: regionAtBest, setup_args: { comp_id: args.comp_id, ref_time: r4(v.best.time), region: regionAtBest, ...(args.plate ? { plate: args.plate } : {}), ...asked } } : {}),
    ring_px: v.ringPx,
    sampled: `sampled ${v.sampled} of ${v.total}`,
    step_frames: v.step,
    frames: visible.slice(0, 20).map((r) => ({
      time: r4(r.time),
      frame: Math.round(r.time * v.fps),
      score: r.score,
      sharpness: r.sharpness,
      motion_px_per_frame: r.speed,
      track_confidence: r.confidence,
      track_rms_px: r.rms_px,
      coverage: r.coverage,
      cleanliness: r.cleanliness,
      reasons: r.reasons,
    })),
    frames_unusable: v.rows.filter((r) => !r.usable || r.score === 0).slice(0, OUT_CAP).map((r) => ({ time: r4(r.time), reason: r.reasons[0] })),
    clone_sources: {
      spatial: v.spatial.map((s) => ({ dx: s.dx, dy: s.dy, nssd: s.nssd, use: `ae_cleanplate_setup source clone_offset, offset { dx: ${s.dx}, dy: ${s.dy} }` })),
      temporal: v.temporal.map((t) => ({ frames: t.frames, covers_frames: t.covers, of_occluded_frames: t.occluded, coverage: t.coverage, cleanliness: t.cleanliness, contaminates_frames: t.contaminates, occluded_span: t.span, use: `ae_cleanplate_setup source clone_offset, offset { frames: ${t.frames} }, clean_frame: true${t.contaminates > 0 ? `; then trim the patch layer's in point to ${t.span.start} s and its out point to ${t.span.end} s (on ${t.contaminates} other frame(s) this offset shows the occluder, so the clone must only be live where it covers)` : ""}` })),
    },
    ...(v.sheet ? { contact_sheet_path: v.sheet } : {}),
    budget: { max_renders: args.max_renders, max_seconds: args.max_seconds, renders_this_call: v.rendersUsed },
    next: v.best
      ? "Call ae_cleanplate_setup with setup_args plus the arguments it does not carry: `source` and, for clone_offset, `offset`; `expect` (the target guard); and `plate` (the plate layer) if you did not give it to this call. Its ref_time is the recommended frame and its region is the polygon as it lies at that frame (the region you gave was drawn at region_time, which is a different frame on a moving shot). The same track_id is re-based on ref_time by setup: no re-tracking unless that frame is outside the tracked range or not ok. Get clean pixels for the hole first (clone offsets below are measured around the region at the recommended frame)."
      : undefined,
    ...(temp
      ? {
          temp_comp: { copy_removed: temp.removed, ...(temp.error ? { error: temp.error } : {}) },
          checkpoint: (ran as { checkpoint: unknown }).checkpoint,
          receipt: buildReceipt({ before: null, after: { temp_comp: temp }, customMismatches: tempMismatch(temp) }),
          ...(ran as { sessionFields: object }).sessionFields,
        }
      : {}),
    notes,
  };
}

function tempMismatch(temp: { copy_id: number; removed: boolean; error?: string }): ReceiptMismatch[] {
  if (temp.removed) return [];
  return [
    {
      path: "temp_comp",
      expected: "the temporary comp removed",
      actual: temp.error ?? "not removed",
      message: `The temporary comp (id ${temp.copy_id}) was not removed${temp.error ? `: ${temp.error}` : ""}. Delete it in the Project panel; its name starts with "_chroma_plate_".`,
    },
  ];
}

// ---------- ae_cleanplate_setup ----------

/** What cleanplateInspect reads back (a separate evalScript after the write). */
export interface HostInspect {
  num_layers: number;
  plate: { index: number; id: number; enabled: boolean } | null;
  patch: {
    found: boolean;
    index?: number;
    id?: number;
    name?: string;
    source_id?: number | null;
    enabled?: boolean;
    in_point?: number;
    out_point?: number;
    sampling_quality?: string | null;
    motion_blur?: boolean | null;
    matte?: { type: string; layer_id: number | null } | null;
    masks?: Array<{ mode: string; feather: number | number[] | null; expansion: number | null; num_keys_path: number }>;
    effects?: string[];
    position_keys?: number;
    scale_keys?: number;
    rotation_keys?: number;
  } | null;
  inner: { layers: number; first: { name: string; kind: string; time_remap_enabled: boolean; time_remap_keys: number; position_keys: number } | null } | null;
  holdout: { id: number; enabled: boolean } | null;
}

interface BuildWritten {
  patch_layer: { index: number; id: number; name: string };
  patch_comp: { id: number; name: string; width: number; height: number };
  source: string;
  masks: number;
  imported_item?: { id: number; name: string } | null;
  holdout?: { id: number; name: string; hidden: boolean } | null;
  notes?: string[];
  [key: string]: unknown;
}

interface SetupPlan {
  mode: "transform" | "transform_pin" | null;
  keys: LayerKeys | null;
  writes: Array<Record<string, unknown>>;
  cloneInfo: { position_keys: number; mask_keys: number; frames_skipped: number } | null;
  /** First and last key time (seconds) of the track keys; null when nothing is keyed from a track. */
  span: { start: number; end: number } | null;
  clone: Record<string, unknown> | null;
  maskKeys: Array<{ times: number[]; shapes: ShapeData[] }> | null;
  notes: string[];
}

const sanitize = (s: string): string => s.replace(/[\\/:*?"<>|]+/g, "_").trim() || "plate";

/** '<plate> still f<frame>.png' in the plates folder, with ' 2', ' 3' ... when taken: never overwritten. */
export function uniqueStillPath(dir: string, plateName: string, frame: number): string {
  const base = `${sanitize(plateName)} still f${frame}`;
  let file = path.join(dir, `${base}.png`);
  for (let n = 2; fs.existsSync(file) && n < 1000; n++) file = path.join(dir, `${base} ${n}.png`);
  if (fs.existsSync(file)) throw new PlanarError("refused", `Every name '${base} N.png' up to 999 is taken in ${dir}; nothing was overwritten. Move or delete old stills there.`);
  return file;
}

/** Builds the keys and clone data the host writes; pure given the track. Throws PlanarError for what the caller can fix. */
export function planSetup(a: { args: AeCleanplateSetupArgs; track: PlanarTrack | null; size: Vec2; shapes: ShapeData[]; centre: Vec2 }): SetupPlan {
  const { args, track } = a;
  const plan: SetupPlan = { mode: null, keys: null, writes: [], cloneInfo: null, span: null, clone: null, maskKeys: null, notes: [] };
  const cloneMode = args.source === "clone_offset";
  if (cloneMode && args.offset) {
    const off: CloneOffset = { dx: args.offset.dx, dy: args.offset.dy, frames: args.offset.frames };
    if (!track) {
      plan.clone = { frames: off.frames, static_shift: [-off.dx, -off.dy], position: null };
      plan.notes.push("No track: the clone is shifted by a fixed (-dx, -dy); right for a locked-off shot only.");
      return plan;
    }
    const half = 0.5 / (track.fps > 0 ? track.fps : 25);
    const frames = track.frames.filter((f) => !args.range || (f.time >= args.range.start - half && f.time <= args.range.end + half));
    if (frames.length > MAX_CLONE_FRAMES) throw badArgs(`clone_offset with a track keys ${frames.length} frames; the limit is ${MAX_CLONE_FRAMES}. Pass range: {start, end}.`);
    const sh = cloneShifts({ track, centre: a.centre, offset: off, frames });
    if (sh.times.length === 0) throw badArgs("No frame of the track is ok inside that range, so the clone cannot be compensated.");
    // Every region's shape goes in for every frame, in one evalScript string.
    const vertsPerFrame = a.shapes.reduce((n, sh) => n + sh.vertices.length * 3, 0);
    if (vertsPerFrame * sh.times.length > MAX_CLONE_POINTS) throw badArgs(`clone_offset with a track would send ${vertsPerFrame * sh.times.length} mask points (${a.shapes.length} region(s) x ${sh.times.length} frames); the limit is ${MAX_CLONE_POINTS}. Pass range: {start, end} or fewer regions.`);
    const mk = maskKeysFor(a.shapes, frames);
    if (mk.every((m) => m.times.length === 0)) throw badArgs("The track moves every region behind the horizon, so the mask cannot follow it.");
    plan.clone = { frames: off.frames, static_shift: null, position: { times: sh.times, shifts: sh.shifts } };
    plan.maskKeys = mk;
    plan.span = { start: sh.times[0], end: sh.times[sh.times.length - 1] };
    plan.cloneInfo = { position_keys: sh.times.length, mask_keys: Math.max(...mk.map((m) => m.times.length)), frames_skipped: sh.skipped.length };
    plan.notes.push("The clone is motion-compensated by the shift of the region centre only (no rotation or zoom); the patch layer stays put and its mask follows the shot.");
    if (sh.skipped.length) plan.notes.push(`${sh.skipped.length} frame(s) have no solved motion (or none at the offset frame); the keys interpolate across them.`);
    return plan;
  }
  if (!track) return plan;
  if (track.frames.length > MAX_TRACK_FRAMES && !args.range) throw badArgs(`The track has ${track.frames.length} frames; pass range: {start, end} to key part of it.`);
  const t = patchTrackKeys(track, a.size, args.range);
  if (t.keys.times.length > 3000) throw badArgs(`The track has ${t.keys.times.length} frames to write, over the 3000 keys per property one call writes. Pass range: {start, end}.`);
  plan.mode = t.mode;
  plan.keys = t.keys;
  plan.span = { start: t.keys.times[0], end: t.keys.times[t.keys.times.length - 1] };
  plan.writes.push({ target: "transform", replace_keys: false, times: t.keys.times, values: t.keys.transform });
  if (t.keys.pin) plan.writes.push({ target: "corner_pin", add_effect: true, replace_keys: false, times: t.keys.times, values: t.keys.pin });
  if (t.mode === "transform_pin") plan.notes.push(`The ${track.model} track keys the transform (similarity part, layer motion blur works) plus a Corner Pin for the rest; the Corner Pin gets no motion blur.`);
  const skipped = [...t.not_ok, ...t.keys.skipped];
  if (skipped.length) plan.notes.push(`${skipped.length} frame(s) were not keyed (not ok in the track, or degenerate); the keys interpolate across them.`);
  return plan;
}

async function renderTiles(ctx: ToolContext, opId: string, tag: string, compId: number, times: number[], framesDir: string, toolName: string): Promise<Array<{ time: number; image: RgbaImage }>> {
  const out: Array<{ time: number; image: RgbaImage }> = [];
  for (let i = 0; i < times.length; i++) {
    const s = await captureCompFrame({ ctx, opId: `${opId}_${tag}`, compId, time: times[i], frameIndex: i, framesDir, toolName });
    try {
      const png = decodePngFile(s.path);
      const fit = fitWithin(png.width, png.height, 720);
      out.push({ time: times[i], image: resizeArea(png, fit.width, fit.height) });
    } finally {
      fs.rmSync(s.path, { force: true });
    }
    await yieldLoop();
  }
  return out;
}

/** First, reference and last frame times, unique, on the frame grid. */
export function sheetTimes(o: { ref: number; first: number; last: number; fps: number }): number[] {
  const set = new Set<number>([snapFrame(o.first, o.fps), snapFrame(o.ref, o.fps), snapFrame(o.last, o.fps)]);
  return [...set].sort((a, b) => a - b);
}

function outlineAt(polys: Pt[][], track: PlanarTrack | null, t: number): Pt[] | null {
  // One outline per tile: the first region (several regions share the sheet's colour, so the rest follow in the label count).
  const p = polys[0];
  if (!p) return null;
  if (!track) return p;
  const f = frameAt(track, t);
  if (!f || !f.ok || !f.H) return null;
  return warpPolygon(p, f.H);
}

/** True when the read-back patch layer's in and out points are the requested trim, within tol seconds. */
export function trimConfirmed(patch: { in_point?: number; out_point?: number } | null | undefined, t: { start: number; end: number; tol: number }): boolean {
  if (!patch || typeof patch.in_point !== "number" || typeof patch.out_point !== "number") return false;
  return Math.abs(patch.in_point - t.start) <= t.tol && Math.abs(patch.out_point - t.end) <= t.tol;
}

/** Compares what the build left with what it was asked for; pure, used by the receipt. */
export function setupMismatches(a: {
  args: AeCleanplateSetupArgs;
  plateId: number;
  before: { numLayers: number; layers: Array<{ index: number; id: number; enabled: boolean }> } | null;
  inspect: HostInspect | null;
  written: BuildWritten;
  expected: {
    regions: number;
    feather: number;
    expansion: number;
    keys: number | null;
    pin: boolean;
    holdout: boolean;
    cloneMaskKeys: number | null;
    /** The holdout layer's id, and that its video was switched off (the write does both). */
    holdoutId?: number | null;
    holdoutHidden?: boolean;
    /** Position keys of a track-compensated clone layer inside the patch comp. */
    clonePositionKeys?: number | null;
    /** The in/out the patch layer was asked to be trimmed to (seconds); tol is half a frame. */
    trim?: { start: number; end: number; tol: number } | null;
  };
}): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const ins = a.inspect;
  if (!ins) {
    m.push({ path: "read_back", expected: "the patch read back in a separate evalScript", actual: null, message: "The read-back after the write returned nothing, so the patch rig could not be checked" });
    return m;
  }
  const plateBefore = a.before?.layers.find((l) => l.id === a.plateId);
  if (a.before) expectThat(m, ins.num_layers === a.before.numLayers + 1, "numLayers", a.before.numLayers + 1, ins.num_layers, "Layer count did not grow by one");
  const p = ins.patch;
  if (!p || !p.found) {
    m.push({ path: "patch_layer", expected: a.written.patch_layer, actual: undefined, message: "The patch layer is not in the read-back" });
    return m;
  }
  if (plateBefore && ins.plate) {
    expectThat(m, p.index === plateBefore.index, "patch_layer.index", plateBefore.index, p.index, "The patch layer is not where the plate was (directly above it)");
    expectThat(m, ins.plate.index === plateBefore.index + 1, "plate.index", plateBefore.index + 1, ins.plate.index, "The plate did not move down by one");
    expectThat(m, ins.plate.enabled === plateBefore.enabled, "plate.enabled", plateBefore.enabled, ins.plate.enabled, "The plate's visibility changed");
  }
  expectThat(m, p.source_id === a.written.patch_comp.id, "patch_layer.source", a.written.patch_comp.id, p.source_id, "The patch layer does not show the patch comp");
  const masks = p.masks ?? [];
  expectThat(m, masks.length === a.expected.regions, "masks.count", a.expected.regions, masks.length, "Mask count differs");
  masks.forEach((mk, i) => {
    const f = Array.isArray(mk.feather) ? mk.feather[0] : mk.feather;
    if (typeof f === "number") expectThat(m, Math.abs(f - a.expected.feather) <= 0.05, `masks[${i}].feather`, a.expected.feather, f, "Mask feather differs");
    if (typeof mk.expansion === "number") expectThat(m, Math.abs(mk.expansion - a.expected.expansion) <= 0.05, `masks[${i}].expansion`, a.expected.expansion, mk.expansion, "Mask expansion differs");
    expectThat(m, mk.mode === "add", `masks[${i}].mode`, "add", mk.mode, "Mask mode is not Add");
    if (a.expected.cloneMaskKeys !== null) expectThat(m, mk.num_keys_path > 0, `masks[${i}].keys`, ">0", mk.num_keys_path, "The mask path has no keys, so it will not follow the shot");
  });
  if (a.expected.keys !== null) {
    expectThat(m, (p.position_keys ?? 0) === a.expected.keys, "patch_layer.position_keys", a.expected.keys, p.position_keys, "Position key count differs from the frames written");
  }
  if (a.expected.pin) expectThat(m, (p.effects ?? []).some((e) => e === "ADBE Corner Pin"), "patch_layer.effects", "Corner Pin", p.effects, "The Corner Pin effect is missing");
  if (a.expected.holdout) {
    expectThat(m, p.matte?.type === "alpha_inverted", "patch_layer.matte.type", "alpha_inverted", p.matte?.type, "The holdout matte is not an inverted alpha matte");
    expectThat(m, ins.holdout !== null, "holdout", "read back", ins.holdout, "The holdout layer was not found in the read-back");
    if (a.expected.holdoutId !== undefined && a.expected.holdoutId !== null) {
      expectThat(m, p.matte?.layer_id === a.expected.holdoutId, "patch_layer.matte.layer_id", a.expected.holdoutId, p.matte?.layer_id, "The track matte is not the holdout layer");
    }
    if (a.expected.holdoutHidden && ins.holdout) {
      expectThat(m, ins.holdout.enabled === false, "holdout.enabled", false, ins.holdout.enabled, "The holdout layer's video was not switched off");
    }
  }
  if (a.expected.trim) {
    const t = a.expected.trim;
    expectThat(m, trimConfirmed(p, t), "patch_layer.trim", { in_point: t.start, out_point: t.end }, { in_point: p.in_point, out_point: p.out_point }, "The patch layer's in/out are not the keyed span, so it holds its last pose over the uncovered stretch");
  }
  if (a.expected.clonePositionKeys !== undefined && a.expected.clonePositionKeys !== null) {
    expectThat(m, ins.inner?.first?.position_keys === a.expected.clonePositionKeys, "inner.position_keys", a.expected.clonePositionKeys, ins.inner?.first?.position_keys, "The clone's compensation keys inside the patch comp are missing or short");
  }
  if (a.args.source === "freeze" && ins.inner?.first) {
    expectThat(m, ins.inner.first.time_remap_enabled || a.written.freeze_skipped === true, "inner.time_remap", true, ins.inner.first.time_remap_enabled, "The frozen layer inside the patch comp lost its time remap");
    if (ins.inner.first.time_remap_enabled) expectThat(m, ins.inner.first.time_remap_keys === 1, "inner.time_remap_keys", 1, ins.inner.first.time_remap_keys, "The freeze should hold exactly one time remap key");
  }
  return m;
}

function needsFixList(args: AeCleanplateSetupArgs, cloneFix: "small" | "time" | null = null): string[] {
  if (args.source === "clone_offset") {
    return [
      cloneFix === "time"
        ? "Check that the object is not in the hole on the offset frame (ae_cleanplate_pick mode moving_occluder lists clean offsets), then call ae_cleanplate_setup again with clean_frame: true; or use a spatial offset (dx, dy) of at least the hole's size plus the mask rim."
        : "Call ae_cleanplate_setup again with an offset (dx, dy) of at least the hole's size plus the mask rim, or a frame offset (frames) to a frame where the hole area is clean (with clean_frame: true); ae_cleanplate_pick proposes both.",
      "ae_inpaint_plate with place_in_comp = the PATCH precomp (fills the hole from the surrounding pixels).",
    ];
  }
  return [
    "ae_inpaint_plate with place_in_comp = the PATCH precomp (fills the hole from the surrounding pixels).",
    "Paint inside the PATCH precomp in AE: Clone Stamp in the Layer panel on the frozen layer, stroke Duration set to Constant (scripts cannot make clone strokes).",
    args.source === "still"
      ? "Paint the still PNG in Photoshop (the path is in the result), then call ae_cleanplate_setup with action 'reload' and the still's footage_id."
      : "Use source 'still' to get a PNG you can paint outside AE, then action 'reload'.",
    "Use source 'clone_offset' instead (a live clone from a clean part of the shot or a clean frame).",
  ];
}

async function setupBuild(ctx: ToolContext, args: AeCleanplateSetupArgs): Promise<Record<string, unknown>> {
  const toolName = "ae_cleanplate_setup";
  const opId = ctx.bridge.newOpId();
  const framesDir = defaultFramesDir();
  fs.mkdirSync(framesDir, { recursive: true });
  const label = `${toolName}(${args.comp_id})`;
  const regionList: Region[] = args.regions ?? (args.region ? [args.region] : []);
  regionList.forEach((r, i) => checkRegion(r, regionList.length > 1 ? `regions[${i}]` : "region"));
  // Snapped to the comp's frame grid once the fps is known (in lease 1): the hold key, the still, the track re-base and the name all use the same frame.
  let refTime = args.ref_time as number;
  const expectGuard: ExpectGuard = { project_path: args.expect.project_path, comp_id: args.expect.comp_id ?? args.comp_id };
  const shapes = regionList.map(regionToShape);
  const polys = regionList.map((r) => regionToPolygon(toSpec(r)));
  const diag = regionsDiagonal(regionList);
  const mp = maskParams({ diagonal: diag, feather: args.feather_px, expansion: args.expansion_px });
  if (mp.expansion > MAX_MASK_PX) throw badArgs(`The mask expansion would be ${mp.expansion} px, over ${MAX_MASK_PX}.`);
  const all: Pt[] = polys.flat();
  const ub = polygonBounds(all);
  const centre: Vec2 = [(ub[0] + ub[2]) / 2, (ub[1] + ub[3]) / 2];
  const notes: string[] = [];
  if (mp.raised) notes.push(`expansion_px was raised to ${mp.expansion} (half the feather): the object's edge must not show through the soft rim.`);

  // Lease 1: read, resolve the track, render the plate still, render the before frames.
  const prep = await queued(ctx, `${label} prepare`, opId, async () => {
    const info = await readHost<HostCleanplateRead>(ctx, opId, "read", "cleanplateRead", { comp_id: args.comp_id, plate: args.plate, ...(args.holdout ? { holdout: args.holdout } : {}), ref_time: refTime }, toolName);
    checkComp(info);
    const plate = info.plate;
    if (!plate) throw new PlanarError("not_found", "The plate layer was not found.");
    const c = info.comp;
    const fps = c.fps > 0 ? c.fps : 25;
    const askedRef = refTime;
    refTime = snapFrame(refTime, fps);
    if (Math.abs(refTime - askedRef) > 1e-6) notes.push(`ref_time ${r4(askedRef)} s was snapped to the frame grid: ${r4(refTime)} s (frame ${Math.round(refTime * fps)}). The freeze, the still, the track re-base and the patch name all use that frame.`);
    if (refTime >= c.duration - 1e-6) throw badArgs(`ref_time ${r2(refTime)} s is at or past the end of the comp (${r2(c.duration)} s): choose a time inside it.`);
    if (refTime < plate.in_point - 1e-6 || refTime >= plate.out_point - 1e-6) {
      throw badArgs(`ref_time ${r2(refTime)} s is outside the plate layer's in/out (${r2(plate.in_point)} to ${r2(plate.out_point)} s): a freeze would hold the clamped first or last frame and a still would be empty, while the track is re-based at ref_time. Choose a time where the plate is visible.`);
    }
    if (plate.locked) throw new PlanarError("refused", `The plate layer "${plate.name}" is locked.`);
    if (plate.three_d) throw new PlanarError("refused", `The plate layer "${plate.name}" is a 3D layer; the patch tools work in 2D only.`);
    if (!plate.has_video) throw new PlanarError("refused", `The plate layer "${plate.name}" has no video.`);
    if (args.source !== "still") {
      if (plate.parent_id !== null) throw new PlanarError("refused", `The plate layer "${plate.name}" has a parent. A duplicate would lose or double the parent's motion inside the patch comp: unparent it, or use source 'still' (which renders the comp as it looks).`);
      if (plate.position_separated) throw new PlanarError("refused", "The plate's Position has separated dimensions (X and Y Position), which a duplicate cannot freeze or offset reliably. Join them first (Position > Follow Dimensions Together), or use source 'still'.");
    }
    if (args.source === "freeze" && plate.can_time_remap === false && !plate.source_is_still) {
      throw new PlanarError("refused", `The plate layer "${plate.name}" cannot be time-remapped (AE allows it on footage and precomp layers). Use source 'still'.`);
    }
    if (args.source === "clone_offset" && plate.transform_animated.length > 0) {
      throw new PlanarError("refused", `The plate's ${plate.transform_animated.join(", ")} is animated, so an offset clone cannot be keyed relative to it. Use source 'freeze' or 'still', or bake the plate's transform first.`);
    }
    if (args.holdout) {
      if (!info.holdout) throw new PlanarError("not_found", "The holdout layer was not found.");
      if (!plate.modern_matte_api) throw new PlanarError("refused", "Layer-based track mattes need AE 23 or later; this AE has none, so the holdout cannot be set.");
      if (info.holdout.id === plate.id) throw new PlanarError("refused", "The holdout cannot be the plate itself.");
      if (info.holdout.locked) throw new PlanarError("refused", `The holdout layer "${info.holdout.name}" is locked, so its video cannot be switched off. Unlock it first.`);
      if (info.holdout.kind === "camera" || info.holdout.kind === "light") throw new PlanarError("refused", `A ${info.holdout.kind} layer cannot be a track matte.`);
      if (!info.holdout.has_video) throw new PlanarError("refused", `The holdout layer "${info.holdout.name}" has no video, so it cannot be a track matte.`);
    }
    let track: PlanarTrack | null = null;
    if (args.track) {
      track = await resolveTrackSource(ctx, opId, args.comp_id, args.track);
      if (Math.abs(track.comp_size[0] - c.width) > 0.5 || Math.abs(track.comp_size[1] - c.height) > 0.5) {
        throw new PlanarError("refused", `The track was made in a ${track.comp_size[0]}x${track.comp_size[1]} comp and this one is ${c.width}x${c.height}: the points are in comp pixels, so the sizes must match.`);
      }
      track = relativeTo(track, refTime);
      const rf = frameAt(track, refTime);
      if (!rf || !rf.ok || !rf.H) throw badArgs(`The track has no solved motion at ref_time ${r2(refTime)} s, so it cannot be the frame the patch looks right at. Choose a ref_time inside the tracked range (ae_cleanplate_pick recommends one).`);
    }
    const plan = planSetup({ args, track, size: [c.width, c.height], shapes, centre });
    const local: string[] = [];
    let cloneFix: "small" | "time" | null = null;
    if (args.source === "freeze") {
      const fxa = plate.effects_animated ?? [];
      if (fxa.length > 0) local.push(`Keyed or expression-driven effect parameters on the plate copy (${fxa.slice(0, 6).join(", ")}) are replaced by their value at ref_time, so the frozen frame does not keep moving (a stabilize rig's Corner Pin, for one).`);
      if (plate.opacity_animated) local.push("The plate copy's animated Opacity is replaced by its value at ref_time (the stabilize rig's 'Show Stabilized Plate' switch becomes a plain 100).");
    } else if (args.source === "clone_offset") {
      const fxa = plate.effects_animated ?? [];
      if (fxa.length > 0) local.push(`The plate has keyed or expression-driven effects (${fxa.slice(0, 6).join(", ")}); the clone keeps them, shifted with its time offset. Check the patch moves with the shot.`);
    }
    // Region inside the frame (a hole off the frame has nothing to patch).
    if (ub[2] <= 0 || ub[3] <= 0 || ub[0] >= c.width || ub[1] >= c.height) throw badArgs("The region lies outside the comp frame.");
    if (ub[0] < 0 || ub[1] < 0 || ub[2] > c.width || ub[3] > c.height) local.push("The region reaches outside the frame; the mask is clipped there.");
    if (args.source === "clone_offset" && args.offset) {
      const shifted: Bounds = [ub[0] + args.offset.dx, ub[1] + args.offset.dy, ub[2] + args.offset.dx, ub[3] + args.offset.dy];
      if (!track && (shifted[0] < 0 || shifted[1] < 0 || shifted[2] > c.width || shifted[3] > c.height)) local.push("The clone offset reaches outside the frame: the patch shows transparency there. Choose a smaller offset.");
      if (track) {
        // The source area follows the shot: count the solved frames where the shifted region leaves the frame.
        const srcPoly: Pt[] = all.map((p) => [p[0] + (args.offset?.dx ?? 0), p[1] + (args.offset?.dy ?? 0)] as Pt);
        let outside = 0;
        for (const f of track.frames) {
          if (!f.ok || !f.H) continue;
          const moved = warpPolygon(srcPoly, f.H);
          if (!moved) continue;
          const mb = polygonBounds(moved);
          if (mb[0] < 0 || mb[1] < 0 || mb[2] > c.width || mb[3] > c.height) outside++;
        }
        if (outside > 0) local.push(`The clone's source area leaves the frame on ${outside} tracked frame(s): the patch shows transparency there. Choose a smaller offset.`);
      }
      // The mask covers hole + expansion + feather/2, so the offset must clear that rim too.
      const rim = mp.expansion + mp.feather / 2;
      const spatialClear = Math.abs(args.offset.dx) >= ub[2] - ub[0] + rim || Math.abs(args.offset.dy) >= ub[3] - ub[1] + rim;
      if (!spatialClear && args.offset.frames === 0) {
        cloneFix = "small";
        local.push(`The offset is smaller than the hole plus the mask rim (${r2(rim)} px): the clone still contains the object. Move it at least the hole's size plus the rim.`);
      } else if (!spatialClear && args.clean_frame !== true) {
        // A time-only clone shows the same scene point at another frame: clean only if the object is not there then.
        cloneFix = "time";
        local.push("The clone is shifted in time only (the spatial offset does not clear the hole): it removes the object only if the object is not in the hole on the offset frame. A static object, or a locked-off shot where it stays, is shown again. Pass clean_frame: true once you checked that (ae_cleanplate_pick in moving_occluder mode lists clean offsets).");
      }
    }
    // Where the track holds: outside its first and last key AE holds the last key, so the patch would freeze in the last pose while the shot moves on.
    let trim: { start: number; end: number } | null = null;
    const uncovered: Array<{ start: number; end: number }> = [];
    if (plan.span) {
      const fd = c.frame_duration > 0 ? c.frame_duration : 1 / fps;
      const spanEnd = plan.span.end + fd;
      // A layer can run past the comp (footage longer than the comp, or slid to a negative in point): only the part inside the comp can show, and no track can cover the rest.
      const visIn = Math.max(plate.in_point, 0);
      const visOut = Math.min(plate.out_point, c.duration);
      if (plan.span.start - visIn > fd / 2) uncovered.push({ start: r4(visIn), end: r4(plan.span.start) });
      if (visOut - spanEnd > fd / 2) uncovered.push({ start: r4(spanEnd), end: r4(visOut) });
      if (uncovered.length > 0) {
        trim = { start: Math.max(plan.span.start, visIn), end: Math.min(spanEnd, visOut) };
        local.push(
          `The track (or range) keys the patch only from ${r2(plan.span.start)} s to ${r2(spanEnd)} s, but the plate shows in the comp from ${r2(visIn)} to ${r2(visOut)} s. The patch layer is trimmed to the keyed span (the result says whether the read-back confirmed it); ${uncovered.map((u) => `${r2(u.start)}-${r2(u.end)} s`).join(" and ")} show the plate WITHOUT the patch. Continue the track (ae_track_multi continue_track_id) or re-track, then run this again.`
        );
      }
    }
    // Depth: a still is an 8-bit sRGB PNG.
    if (args.source === "still" && ((info.project.bits_per_channel ?? 8) > 8 || info.project.linear_blending === true)) {
      local.push(`The still is an 8-bit sRGB PNG; this project is ${info.project.bits_per_channel ?? "?"} bpc${info.project.linear_blending ? " with linear blending" : ""}, so the patch loses depth (use source 'freeze' to keep it).`);
    }
    if (args.source === "still" && (info.comp.resolution_factor ?? [1, 1]).some((v) => v !== 1)) {
      throw new PlanarError("refused", "The comp's resolution is not Full, so a rendered still would be smaller than the comp. Set the resolution to Full in AE and call again.");
    }

    // The sheet frames, before the write.
    const firstT = track && track.frames.length ? track.frames[0].time : c.work_area_start;
    const lastT = track && track.frames.length ? track.frames[track.frames.length - 1].time : c.work_area_start + c.work_area_duration - 1 / fps;
    const times = sheetTimes({ ref: refTime, first: firstT, last: lastT, fps });
    let before: Array<{ time: number; image: RgbaImage }> = [];
    let beforeError: string | undefined;
    try {
      before = await renderTiles(ctx, opId, "before", args.comp_id, times, framesDir, toolName);
    } catch (err) {
      beforeError = errMessage(err);
    }

    // The still: the isolated plate at ref_time, into the persistent plates folder.
    let stillPath: string | undefined;
    let isolate: Awaited<ReturnType<typeof withIsolatedPlate<void>>>["temp"] = null;
    let sessionFields: { user_changed?: string } = {};
    let checkpoint: Awaited<ReturnType<typeof autoCheckpoint>> | null = null;
    if (args.source === "still" && args.still_footage_id === undefined) {
      ctx.quarantine.assertClear();
      const guard = await verifyTargetGuard(ctx, expectGuard, opId);
      // The folder is made only now: a wrong expect.project_path must not create one.
      const dir = platesFolderFor(guard.project_path ?? args.expect.project_path);
      checkpoint = await autoCheckpoint(ctx, guard, toolName);
      const note: WriteInfo = { opId, toolName, label, expect: expectGuard, checkpoint: checkpoint?.path ?? null };
      sessionFields = await noteBeforeWrite(ctx, note);
      let made = "";
      try {
        fs.mkdirSync(dir, { recursive: true });
        const iso = await withIsolatedPlate(ctx, opId, { compId: args.comp_id, showLayers: [{ index: plate.index, id: plate.id }], expect: expectGuard, toolName, note }, async (copyId) => {
          // Rendered into the scratch frames folder (a stale first attempt stays there, not in the plates folder), then the fresh file is copied over: never onto an existing name.
          const s = await captureCompFrame({ ctx, opId, compId: copyId, time: refTime, frameIndex: 0, framesDir, toolName });
          try {
            const target = uniqueStillPath(dir, plate.name, Math.round(refTime * fps));
            fs.copyFileSync(s.path, target, fs.constants.COPYFILE_EXCL);
            made = target;
          } finally {
            fs.rmSync(s.path, { force: true });
          }
        });
        isolate = iso.temp;
        await noteWritten(ctx, note);
        stillPath = made;
        const png = decodePngFile(stillPath);
        if (png.width !== c.width || png.height !== c.height) {
          fs.rmSync(stillPath, { force: true });
          throw new PlanarError("refused", `The rendered still is ${png.width}x${png.height} and the comp is ${c.width}x${c.height}: the comp's resolution is not Full. Nothing was imported.`);
        }
      } catch (err) {
        const temp = (err as { plateTemp?: { copy_id: number; removed: boolean; error?: string } }).plateTemp ?? isolate;
        // No copy was made: nothing was written to the project, so the error goes up as it is.
        if (!temp) throw err;
        // The copy was made (two undo entries): report it with a receipt instead of throwing.
        if (!isolate) await noteWritten(ctx, note);
        if (made && fs.existsSync(made) && !stillPath) fs.rmSync(made, { force: true });
        return {
          failure: {
            error: err instanceof PlanarError ? err.code : "failed",
            message: errMessage(err),
            temp,
            checkpoint,
            sessionFields,
          },
        };
      }
    }
    return { info, plate, fps, track, plan, times, before, beforeError, stillPath, isolate, checkpoint, sessionFields, local, cloneFix, trim, uncovered };
  });

  if (prep.failure) {
    const f = prep.failure;
    return {
      ok: false,
      error: f.error,
      message: `${f.message} (The still's isolate step had already made a temporary copy of the comp${f.temp.removed ? " and removed it again: two undo entries" : ""}; the patch rig was not built.)`,
      temp_comp: { copy_removed: f.temp.removed, ...(f.temp.error ? { error: f.temp.error } : {}) },
      checkpoint: f.checkpoint,
      receipt: buildReceipt({ before: null, after: { temp_comp: f.temp }, customMismatches: tempMismatch(f.temp) }),
      ...f.sessionFields,
    };
  }

  notes.push(...prep.plan.notes, ...prep.local);
  const c = prep.info.comp;
  const frame = Math.round(refTime * prep.fps);
  const patchName = args.name ?? `${prep.plate.name} PATCH f${frame}`;
  if (c.motion_blur === false && prep.plan.mode) notes.push("The comp's motion blur switch is off: the patch layer's motion blur setting has no effect until it is turned on.");
  if (args.source === "still" && prep.stillPath) notes.push(`The still is ${prep.stillPath}. Paint it outside AE, save over it, then call ae_cleanplate_setup with action 'reload'.`);
  if (args.source === "freeze") notes.push("A freeze carries one moment's light and frozen grain: run ae_patch_color_match and ae_patch_grain on the patch.");

  // Lease 2: the guarded write. The read-back is kept to confirm the trim.
  const kept: { inspect: HostInspect | null } = { inspect: null };
  const trimExpect = prep.trim ? { start: prep.trim.start, end: prep.trim.end, tol: 0.5 * (c.frame_duration > 0 ? c.frame_duration : 1 / prep.fps) } : null;
  const stackRead = (ids: number[]) => ({ host: "layerStack", args: { comp_id: args.comp_id, include_ids: ids } });
  const result = await runGuardedWrite<Record<string, unknown> & Partial<BuildWritten>>(ctx, {
    toolName,
    label,
    expect: expectGuard,
    compId: args.comp_id,
    read: (phase, written) => {
      if (phase === "before") return stackRead([prep.plate.id]);
      return {
        host: "cleanplateInspect",
        args: {
          comp_id: args.comp_id,
          plate_id: prep.plate.id,
          patch_layer_id: written?.patch_layer?.id,
          patch_comp_id: written?.patch_comp?.id,
          holdout_id: prep.info.holdout?.id,
          time: refTime,
        },
      };
    },
    write: {
      host: "cleanplateBuild",
      args: {
        comp_id: args.comp_id,
        plate_index: prep.plate.index,
        plate_id: prep.plate.id,
        source: args.source,
        ref_time: refTime,
        name: patchName,
        still_path: prep.stillPath,
        still_footage_id: args.still_footage_id,
        regions: shapes.map((s, i) => ({ shape: s, keys: prep.plan.maskKeys ? prep.plan.maskKeys[i] : null })),
        feather: mp.feather,
        expansion: mp.expansion,
        writes: prep.plan.writes,
        clone: prep.plan.clone,
        holdout: args.holdout && prep.info.holdout ? { id: prep.info.holdout.id } : null,
        hide_holdout: true,
        motion_blur: prep.plan.mode !== null,
        ...(prep.trim ? { trim: prep.trim } : {}),
        label: "Clean plate patch",
      },
      timeoutMs: SLOW_TIMEOUT_MS,
    },
    check: (beforeRaw, afterRaw, written) => {
      kept.inspect = afterRaw as HostInspect | null;
      return setupMismatches({
        args,
        before: beforeRaw as { numLayers: number; layers: Array<{ index: number; id: number; enabled: boolean }> } | null,
        inspect: kept.inspect,
        plateId: prep.plate.id,
        written: written as BuildWritten,
        expected: {
          regions: shapes.length,
          feather: mp.feather,
          expansion: mp.expansion,
          keys: prep.plan.keys ? prep.plan.keys.times.length : null,
          pin: !!prep.plan.keys?.pin,
          holdout: !!args.holdout,
          cloneMaskKeys: prep.plan.maskKeys ? 1 : null,
          holdoutId: args.holdout && prep.info.holdout ? prep.info.holdout.id : null,
          holdoutHidden: !!args.holdout,
          clonePositionKeys: prep.plan.cloneInfo ? prep.plan.cloneInfo.position_keys : null,
          trim: trimExpect,
        },
      });
    },
  });

  // Lease 3: the same frames again, in a separate evalScript from the write.
  let sheetPath: string | undefined;
  let sheetError: string | undefined = prep.beforeError;
  try {
    const after = await queued(ctx, `${label} after`, opId, () => renderTiles(ctx, opId, "after", args.comp_id, prep.times, framesDir, toolName));
    const tiles: SheetTile[] = [];
    for (const b of prep.before) tiles.push({ image: b.image, poly: outlineAt(polys, prep.track, b.time), label: `BEFORE t=${r2(b.time)}` });
    for (const a of after) tiles.push({ image: a.image, poly: outlineAt(polys, prep.track, a.time), label: `AFTER t=${r2(a.time)}` });
    if (prep.before.length === after.length && after.length > 0) {
      sheetPath = writeSheetFile(framesDir, `setup_${opId}`, drawSheet(tiles, { cols: after.length, compSize: [c.width, c.height] }));
    } else {
      sheetError = sheetError ?? "The before frames could not be rendered, so there is no before/after sheet.";
    }
  } catch (err) {
    sheetError = errMessage(err);
  }

  const w = result as unknown as BuildWritten & { checkpoint: unknown; receipt: unknown; op_id: string; user_changed?: string };
  // The trim counts only when the separate read-back shows the patch layer's in/out at the keyed span.
  const readPatch = kept.inspect?.patch ?? null;
  const trimOk = trimExpect !== null && trimConfirmed(readPatch, trimExpect);
  if (trimExpect) {
    notes.push(
      trimOk
        ? `The patch layer is trimmed to the keyed span (${r2(readPatch?.in_point ?? 0)}-${r2(readPatch?.out_point ?? 0)} s, confirmed by the read-back).`
        : `The trim of the patch layer to the keyed span (${r2(trimExpect.start)}-${r2(trimExpect.end)} s) was NOT confirmed by the read-back: AE holds the last key over the uncovered stretch until you trim the layer's in and out points to that span yourself.`
    );
  }
  const needsFix = ((args.source === "freeze" || args.source === "still") && args.clean_frame !== true && args.still_footage_id === undefined) || (args.source === "clone_offset" && prep.cloneFix !== null);
  const hostNotes = Array.isArray(w.notes) ? (w.notes as string[]) : [];
  // Ready-to-call blocks: the patch tools take their own region format (rect as corners) and the track re-based on THIS ref_time.
  const patchRegions = regionList.map(toSpec);
  const patchLayerId = w.patch_layer?.id;
  // The track as the caller gave it: a resolved inline source (nulls, corner_pin, tracker, transform) gets a fresh id that is never stored, so the id would not resolve in the next call.
  const trackArg = args.track;
  // Reported only when the caller named a stored track: an inline source's id is generated here and never stored, so an agent that reused it would get not_found.
  const storedTrackId = trackArg?.track_id !== undefined ? { track_id: trackArg.track_id } : {};
  const layerArg = { id: patchLayerId };
  const common = { comp_id: args.comp_id, layer: layerArg, region: patchRegions[0], ref_time: refTime, expect: args.expect, ...(trackArg ? { track: trackArg } : {}) };
  const chain = [
    { tool: "ae_patch_color_match", purpose: "match the patch's light to the plate.", args: common },
    { tool: "ae_patch_grain", purpose: "add the plate's grain (a frozen frame has frozen grain).", args: common },
    { tool: "ae_patch_finish", purpose: "final seam work.", args: common },
    {
      tool: "ae_patch_check",
      purpose: "measure leakage, seam, flicker, drift and slip; fix what it reports and check again; loop-play the region.",
      // No region: the default footprint follows the patch layer's Add masks (grown by expansion, minus half the feather), its transform and a Corner Pin, for every region and every frame. A raw hole would count the mask rim as leakage and put part of the ring inside the patch.
      args: { comp_id: args.comp_id, patch_layers: [layerArg], ref_time: refTime, expect: args.expect },
    },
  ];
  if (patchRegions.length > 1) {
    notes.push(
      `${patchRegions.length} regions: ae_patch_color_match, ae_patch_grain and ae_patch_finish take one region at a time. next_steps carries the first; the rest are in patch_regions (repeat those three calls with each). ae_patch_check runs once: it carries no region and reads every mask of the patch layer.`
    );
  }
  return {
    ok: true,
    op_id: w.op_id,
    applied: true,
    action: "build",
    source: args.source,
    patch_layer: w.patch_layer,
    patch_comp: w.patch_comp,
    regions: shapes.length,
    mask: { feather_px: mp.feather, expansion_px: mp.expansion },
    tracked: prep.plan.mode
      ? { mode: prep.plan.mode, model: prep.track?.model, frames_keyed: prep.plan.keys?.times.length, ...storedTrackId, ref_time: r4(refTime) }
      : prep.plan.clone && prep.track
        ? { mode: "clone_compensated", model: prep.track.model, ...prep.plan.cloneInfo, ...storedTrackId }
        : null,
    ...(w.imported_item ? { imported_item: w.imported_item } : {}),
    ...(prep.stillPath ? { still_path: prep.stillPath } : {}),
    ...(w.holdout ? { holdout: w.holdout } : {}),
    needs_fix: needsFix,
    ...(needsFix
      ? {
          needs_fix_message:
            args.source === "clone_offset"
              ? prep.cloneFix === "time"
                ? "The clone is shifted in time only, so it shows the object again wherever the object is in the hole on the offset frame. Do not report the removal as done until you have checked that frame (then pass clean_frame: true) or rebuilt with a spatial offset that clears the hole."
                : "The clone's offset is smaller than the hole plus the mask rim, so the patch still contains the object. Do not report the removal as done: rebuild with an offset of at least the hole's size plus the rim."
              : "The patch still shows the object: a frozen frame is not a fix by itself. Do not report the removal as done until the hole is cleaned.",
          fixes_in_order: needsFixList(args, prep.cloneFix),
        }
      : {}),
    ...(prep.uncovered.length > 0 ? { uncovered_ranges: prep.uncovered, patch_trimmed: trimOk && readPatch ? { in_point: readPatch.in_point, out_point: readPatch.out_point } : null, trim_confirmed: trimOk } : {}),
    next_steps: chain,
    patch_regions: patchRegions,
    ...(sheetPath ? { before_after_sheet: sheetPath } : {}),
    ...(sheetError ? { sheet_error: sheetError } : {}),
    notes: [...notes, ...hostNotes],
    ...(prep.isolate ? { temp_comp: { copy_removed: prep.isolate.removed, ...(prep.isolate.error ? { error: prep.isolate.error } : {}) } } : {}),
    checkpoint: w.checkpoint,
    receipt: w.receipt,
    ...(w.user_changed ? { user_changed: w.user_changed } : {}),
  };
}

async function setupReload(ctx: ToolContext, args: AeCleanplateSetupArgs): Promise<Record<string, unknown>> {
  const toolName = "ae_cleanplate_setup";
  const opId = ctx.bridge.newOpId();
  const framesDir = defaultFramesDir();
  fs.mkdirSync(framesDir, { recursive: true });
  const label = `${toolName} reload(${args.comp_id})`;
  const expectGuard: ExpectGuard = { project_path: args.expect.project_path, comp_id: args.expect.comp_id ?? args.comp_id };
  const prep = await queued(ctx, `${label} prepare`, opId, async () => {
    const info = await readHost<HostCleanplateRead>(ctx, opId, "read", "cleanplateRead", { comp_id: args.comp_id }, toolName);
    const fps = info.comp.fps > 0 ? info.comp.fps : 25;
    const times = sheetTimes({ ref: args.ref_time ?? info.comp.work_area_start, first: info.comp.work_area_start, last: info.comp.work_area_start + info.comp.work_area_duration - 1 / fps, fps });
    let before: Array<{ time: number; image: RgbaImage }> = [];
    let err: string | undefined;
    try {
      before = await renderTiles(ctx, opId, "before", args.comp_id, times, framesDir, toolName);
    } catch (e) {
      err = errMessage(e);
    }
    return { info, times, before, err };
  });
  const result = await runGuardedWrite<Record<string, unknown>>(ctx, {
    toolName,
    label,
    expect: expectGuard,
    compId: args.comp_id,
    // A reload is not an undo step, so the read-back is the item itself: found, and its file there.
    read: (phase, written) => {
      if (phase === "before") return null;
      const id = (written?.footage as { id?: number } | undefined)?.id;
      return typeof id === "number" ? { host: "cleanplateFootage", args: { footage_id: id } } : null;
    },
    write: { host: "cleanplateReload", args: { comp_id: args.comp_id, footage_id: args.footage_id, patch_comp_id: args.patch_comp_id, label: "Reload painted still" } },
    check: (_before, after) => {
      const f = after as { found?: boolean; missing?: boolean; path?: string } | null;
      const m: ReceiptMismatch[] = [];
      expectThat(m, !!f && f.found === true && f.missing !== true, "footage", "found, file present", f, "The footage is missing or not found after the reload");
      return m;
    },
  });
  let sheetPath: string | undefined;
  let sheetError: string | undefined = prep.err;
  try {
    const after = await queued(ctx, `${label} after`, opId, () => renderTiles(ctx, opId, "after", args.comp_id, prep.times, framesDir, toolName));
    if (prep.before.length === after.length && after.length > 0) {
      const size: Vec2 = [prep.info.comp.width, prep.info.comp.height];
      const tiles: SheetTile[] = [
        ...prep.before.map((b) => ({ image: b.image, poly: null, label: `BEFORE t=${r2(b.time)}` })),
        ...after.map((a) => ({ image: a.image, poly: null, label: `AFTER t=${r2(a.time)}` })),
      ];
      sheetPath = writeSheetFile(framesDir, `reload_${opId}`, drawSheet(tiles, { cols: after.length, compSize: size }));
    }
  } catch (e) {
    sheetError = errMessage(e);
  }
  const w = result as Record<string, unknown>;
  return {
    ok: true,
    op_id: w.op_id,
    applied: true,
    action: "reload",
    reloaded: w.reloaded,
    footage: w.footage,
    ...(sheetPath ? { before_after_sheet: sheetPath } : {}),
    ...(sheetError ? { sheet_error: sheetError } : {}),
    notes: ["Reloading is not an undo step, and the earlier pixels are gone unless you kept a copy of the PNG: the file on disk was already saved over.", "If the sheet looks unchanged, check that the PNG was saved over the path in the original result."],
    checkpoint: w.checkpoint,
    receipt: w.receipt,
    ...(w.user_changed ? { user_changed: w.user_changed } : {}),
  };
}

// ---------- tools ----------

const CHAIN_NOTE =
  "The chain for removing something: 1) ae_snapshot_frame to look. 2) ae_track_multi on the isolated plate with auto_points around the object (exclude = the object's region) and a provisional ref_time, continue_track_id until done (ae_track_read when the user tracked in AE or Mocha AE). " +
  "3) ae_cleanplate_pick: the recommended ref_time and clone sources. 4) Clean pixels for the hole: a clean frame of a moving occluder -> source freeze with clean_frame; a static object -> ae_inpaint_plate, or source still + the user paints it + action reload, or clone_offset; a wire or blemish on a hard move -> ae_stabilize_roundtrip, then patch in the work comp. " +
  "5) ae_cleanplate_setup. 6) ae_patch_color_match, ae_patch_grain, ae_patch_finish. 7) ae_patch_check; fix what it reports and check again; loop-play the region. Alternative at 4-5 when AE's own fill is wanted: ae_caf_prep. ";

export const cleanplateTools: ToolDefinition<any>[] = [
  {
    name: "ae_cleanplate_pick",
    description:
      "Suggest the reference frame for a removal and the best clone sources, from rendered frames (nothing to install). Every sampled frame (default every 2nd, at most `max_renders` renders; the result says 'sampled N of M' when the budget runs out) is scored for sharpness (Laplacian energy in the region and its ring, on a 1 px pre-blurred gray so grain does not count), motion (the track's speed in px per frame: less is better, less motion blur), track confidence and rms, coverage (share of the moved region inside the frame) and, with mode 'moving_occluder', cleanliness: the hole area warped back to the reference frame compared with the temporal median of all aligned samples, so frames where nobody walks through the hole score high. " +
      "Returns the ranked frames with reasons, the recommended ref_time (mid-shot wins ties so drift splits both ways), up to 3 spatial clone offsets (dx, dy) whose texture matches the ring around the hole (normalized cross-correlation over a window of 3x the hole's size) and, for a moving occluder, time offsets of clean frames; plus a contact sheet of the top 5 frames with the region outlined. " +
      "The result's setup_args carries the recommended ref_time and the region as it lies at THAT frame (the track's motion applied): pass them to ae_cleanplate_setup, not the region you gave at region_time. Temporal clone sources report contaminates_frames (clean frames that offset would put the occluder back into: trim the patch layer to occluded_span then); nothing measures whether a clone offset's pixels are free of the object beyond the cleanliness samples, and the spatial offsets clear the hole plus the mask rim. " +
      "Without `track` the region is taken as static in comp space: right for a locked-off shot only. Read only, unless `isolate` is on: then a temporary copy of the comp showing only `plate` is rendered and removed again (two undo entries, needs `expect`). " +
      CHAIN_NOTE +
      "Order: the track comes first with a provisional ref_time; pick recommends the real one; ae_cleanplate_setup / ae_track_apply re-base the same track, no re-tracking unless the recommended frame is outside the tracked range or not ok. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeCleanplatePickSchema,
    handler: async (args: AeCleanplatePickArgs, ctx: ToolContext) => {
      try {
        return await pick(ctx, args);
      } catch (err) {
        if (err instanceof PlanarError) return failOut(err);
        throw err;
      }
    },
  },
  {
    name: "ae_cleanplate_setup",
    description:
      "Build the patch rig for a removal in one undo step. `source`: freeze (the plate duplicated with a time remap and one hold key at ref_time, frame blending off), still (the isolated plate rendered at ref_time to a PNG in '<project> chroma plates/' next to the saved project and imported, so it can be painted in Photoshop and reloaded; or `still_footage_id`), clone_offset (the plate duplicated and shifted by `offset` in space and/or frames: a live clone; with a track the shift is compensated per frame for the translation of the region centre only (not rotation, zoom or perspective)). " +
      "The source goes into a comp-size patch precomp '<plate> PATCH f<frame>' (identity transform, so layer space = comp space), where paint, solids or a cleaned PNG can be added. In the shot comp the patch layer sits directly above the plate with a mask from `region` / `regions` (up to 16 Add masks), expansion at least half the feather (enforced), feather default 2% of the diagonal, bicubic sampling, and is tracked back from ref_time: translate/similarity tracks key the transform (motion blur on), affine/perspective add a Corner Pin; the mask rides the pin. `holdout` is an inverted alpha track matte (AE 23+) so the patch never covers something crossing in front. " +
      "A freeze or still shows the object unless the frame is clean in the hole: the result has needs_fix: true with the fixes in order (ae_inpaint_plate into the PATCH precomp, Clone Stamp in the PATCH precomp, paint the PNG and `action: 'reload'`, or clone_offset); never report the removal done while needs_fix is true. Say `clean_frame: true` when the frozen frame is clean. " +
      "ref_time is snapped to the frame grid and must be inside the plate's in/out. A freeze bakes the plate copy's keyed or expression-driven effect parameters (Corner Pin, CC Power Pin, Transform ...) and Opacity to their value at ref_time (a stabilize rig's Corner Pin and 'Show Stabilized Plate' switch would otherwise warp or hide the frozen frame); a clone keeps its effects. Where the track (or range) does not cover the plate's in/out, the patch layer is trimmed to the keyed span and the uncovered ranges are returned (AE would otherwise hold the last key): continue the track or re-track. What is NOT measured: whether the frozen or cloned pixels are clean (needs_fix says so; a clone_offset whose spatial offset does not clear the hole plus the mask rim is flagged unless clean_frame: true), and rotation, zoom or perspective of a tracked clone. next_steps are ready-to-call argument blocks for the patch tools, with your track source as you gave it (ae_patch_check gets no region: it reads the footprint from the patch layer's masks, which includes the expansion and half the feather). The patch layer's trim is reported as confirmed only when a separate read-back shows its in/out points at the keyed span (patch_trimmed, trim_confirmed). " +
      "Renders the reference, first and last frame before the write and again after it (a separate evalScript) and returns a before/after contact sheet. Locked and 3D plates, a locked holdout, plates with separated X/Y Position (freeze, clone), parented plates (freeze, clone), a ref_time past the comp's end and an unsaved project (still) are refused. A still is an 8-bit sRGB PNG: in 16/32 bpc or linear projects prefer freeze. " +
      "action 'reload' reloads a painted still (FootageItem.mainSource.reload(), no dialog; not an undo step) and re-renders the sheet. For a steady shot pass the work comp from ae_stabilize_roundtrip as comp_id and omit `track`; its plate copy must be visible (not a hidden or guide layer), or the still and the before/after sheets render empty. " +
      CHAIN_NOTE +
      AGENT_SAFETY_GUIDANCE,
    schema: AeCleanplateSetupSchema,
    handler: async (args: AeCleanplateSetupArgs, ctx: ToolContext) => {
      try {
        return args.action === "reload" ? await setupReload(ctx, args) : await setupBuild(ctx, args);
      } catch (err) {
        if (err instanceof PlanarError) return failOut(err);
        throw err;
      }
    },
  },
];

