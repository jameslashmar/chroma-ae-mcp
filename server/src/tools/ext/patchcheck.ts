/**
 * server/src/tools/ext/patchcheck.ts
 *
 * Measuring a patch, removal or insert the way a compositor checks it, from
 * rendered frames:
 * - ae_patch_check: renders the comp and a temporary copy with the patch layers
 *   OFF (the plate) at sampled frames and measures, inside the patch region
 *   (moved per frame by an optional track) and in a ring around it: change
 *   outside the region (leakage), the visibility of the seam, flicker, pops and
 *   drift of patch-minus-ring brightness, frozen grain, slip of the patch
 *   against the plate and sharpness. It returns a verdict per check with the
 *   numbers, the worst frames, the tool that fixes each finding, the per-frame
 *   series (and the full series as a JSON file) and a contact sheet: A/B pairs,
 *   a difference view and +2 stop crops of the seam.
 *   It writes to the project: the temporary comp is made and removed again (two
 *   undo groups), a guarded write with a receipt. The original is never changed.
 * - ae_region_stats: measures rect, ellipse, polygon or ring regions over time
 *   (optionally moved by a track): mean, spread, percentiles, clipping, noise,
 *   sharpness, frame-to-frame change, and per region drift, flicker and pops,
 *   with a graph and the regions drawn on a frame. Read only, unless
 *   `hide_layers` is given: then it measures a temporary copy with those
 *   layers off, which is the same guarded write as ae_patch_check.
 *
 * Not built, because the agent cannot watch AE: real-time looped playback. The
 * motion problems are measured from sampled frames instead; loop-play the
 * region for a final look.
 *
 * Unmeasured on AE 26 (the figures assume the defaults below):
 * - the colour space of saveFrameToPng (taken as sRGB display values; with
 *   "Blend colors using 1.0 gamma" the composite looks different, and the
 *   project's flag is read and reported);
 * - whether a render of a fresh duplicate can come back cached;
 * - how the footprint of a patch layer relates to its visible pixels (it is the
 *   layer's source rectangle moved through its transforms and parents, or the
 *   outline of its Add-mode masks when it has some, grown by the mask's expansion
 *   with its feather allowed for; a Corner Pin or CC Power Pin on the layer moves
 *   it to the pinned quad; other geometry effects and 3D layers are not followed,
 *   so those need an explicit `region`);
 * - whether a guide layer renders in the snapshot (it is treated as not shown).
 * The thresholds (seam 1.5, pop 3x the ring's own jitter, frozen 0.5, slip 0.5
 * px) are first guesses and are options.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { PNG } from "pngjs";
import { z } from "zod";
import { BridgeError, SLOW_TIMEOUT_MS } from "../../host.js";
import { buildJsxCall } from "../../jsx.js";
import { QueueWaitError } from "../../queue.js";
import { buildReceipt, type ReceiptMismatch } from "../../receipts.js";
import {
  AGENT_SAFETY_GUIDANCE,
  ExpectSchema,
  LayerSelectorSchema,
  type ToolContext,
  type ToolDefinition,
} from "../common.js";
import { autoCheckpoint, verifyTargetGuard } from "../mutate.js";
import { readAfterWrite } from "../read-back.js";
import { defaultFramesDir } from "../render.js";
import { captureCompFrame, decodePngFile } from "./frames.js";
import {
  blit,
  createCanvas,
  cropImage,
  drawLabel,
  drawLine,
  drawPolygon,
  encodePng,
  fillRect,
  fitWithin,
  resizeArea,
  scaleNearest,
  type Rgba,
  type RgbaImage,
} from "./png-utils.js";
import {
  cropToBounds,
  laplacianEnergy,
  linearToSrgb,
  maskedStats,
  noiseSigma,
  lumaPercentiles,
  offsetPolygon,
  polygonArea,
  polygonBounds,
  polygonSignedArea,
  rasterizePolygon,
  regionToPolygon,
  ringMask,
  seamScore,
  signedDistance,
  srgbToLinear,
  temporalNoise,
  warpPolygon,
  type Bounds,
  type Pt,
  type RegionSpec,
} from "./region-math.js";
import { applyH, goodFeatures, ransacModel, type Mat3, type PlanarTrack } from "./planar-math.js";
import { createRenderBudget, PlanarError, resolveTrackSource, TrackSourceSchema } from "./planar.js";
import { beginInflight, endInflight, noteAfterWrite, noteBeforeWrite } from "./session.js";
import { PointTracker, toGray, type GrayImage } from "./track.js";
import { expectThat } from "./write-runner.js";

// ---------- schemas ----------

const MAX_SAMPLES = 60;

const Num = z.number().finite();
const PtSchema = z.tuple([Num, Num]);

export const RegionShapeSchema = z
  .union([
    z
      .object({ kind: z.literal("rect"), rect: z.tuple([Num, Num, Num, Num]).describe("[x0, y0, x1, y1] in comp pixels, x1 > x0 and y1 > y0.") })
      .refine((r) => r.rect[2] > r.rect[0] && r.rect[3] > r.rect[1], { message: "A rect needs x1 > x0 and y1 > y0." }),
    z.object({
      kind: z.literal("ellipse"),
      center: PtSchema.describe("[x, y] in comp pixels."),
      radius: z.tuple([Num.positive(), Num.positive()]).describe("[rx, ry] in comp pixels."),
    }),
    z.object({
      kind: z.literal("polygon"),
      points: z.array(PtSchema).min(3).max(200).describe("Corner points [x, y] in comp pixels, in order."),
    }),
  ])
  .describe("A region in comp pixels (x right, y down, the comp's top-left corner is [0, 0]): a rect, an ellipse or a polygon.");

const HomographySchema = z.array(Num).length(9).describe("Row-major 3x3 matrix h0..h8: (x, y) -> ((h0 x + h1 y + h2) / w, (h3 x + h4 y + h5) / w) with w = h6 x + h7 y + h8.");

export const RegionTrackSchema = z
  .array(z.object({ time: z.number().min(0).describe("Comp time in seconds."), homography: HomographySchema }))
  .min(1)
  .max(1000)
  .describe(
    "How the region moves: per time, the homography that takes the region AS GIVEN to its place at that time (the identity where it is where you drew it). Between entries the matrix is interpolated, outside them the nearest entry is held. Without it the region stays put."
  );

/** Raw homographies, or a track source planar knows (a stored track_id, nulls, a Corner Pin, tracker points, a layer's own transform). */
export const RegionTrackInputSchema = z
  .union([RegionTrackSchema, TrackSourceSchema])
  .describe(
    "How the region moves: either a list of { time, homography } entries, or a track source (track_id from ae_track_multi / ae_track_read, nulls, corner_pin, tracker or transform) that is resolved to the same thing. " +
      "A track source's motion is reference frame -> frame, so the region must be given AS IT LOOKS AT THE TRACK'S REFERENCE FRAME (the track's ref_time; the result reports it)."
  );

const budgetFields = (renders: number) => ({
  max_renders: z.number().int().min(2).max(400).default(renders).describe(`The most renders this call starts (each captured frame is one; a pair is only started when two are left, but a stale-frame retry or a time-mismatch re-render can add one or two), default ${renders}. When it is used up the remaining sampled times are left unmeasured and reported as 'sampled N of M frames'.`),
  max_seconds: z.number().min(5).max(540).default(90).describe("The most seconds the renders may take (the whole call holds the AE queue). Default 90. When it runs out the remaining sampled times are left unmeasured."),
});

const timesField = z
  .array(z.number().min(0))
  .min(1)
  .max(MAX_SAMPLES)
  .optional()
  .describe(`Comp times in seconds to sample (up to ${MAX_SAMPLES}), snapped to frames and clamped to the last frame. At most \`max_samples\` (default 24) are used: more are thinned evenly (the first and last kept where max_samples allows; a ref_time takes one slot), and the result reports how many were dropped. Without it the tool samples the first frame, the reference frame, the last frame and every Nth frame between.`);

const SamplingFields = {
  times: timesField,
  start: z.number().min(0).optional().describe("First time of the range to sample, seconds. Default the work area's start."),
  end: z.number().min(0).optional().describe("Last time of the range to sample, seconds. Default the work area's end."),
  every_n: z
    .number()
    .int()
    .min(1)
    .max(100000)
    .optional()
    .describe("Sample every Nth frame of the range. Default: as many as `max_samples` allows. Pops and flicker between samples that are not neighbours can't be told from drift, so use 1 around a suspect stretch."),
  max_samples: z
    .number()
    .int()
    .min(2)
    .max(MAX_SAMPLES)
    .default(24)
    .describe(`The most frames to sample, up to ${MAX_SAMPLES}. Each one costs two renders in ae_patch_check, so a long range is reported as 'sampled N of M frames'. It also caps explicit \`times\`: more than this are thinned evenly (the first and last kept where max_samples allows; a ref_time takes one slot) and the result says how many were dropped. Default 24.`),
  ref_time: z.number().min(0).optional().describe("The reference frame that is always sampled and shown on the contact sheet. Default the first sampled frame."),
};

const LumaSpace = z.enum(["encoded", "linear"]).default("encoded").describe("Brightness of regions as the PNG's encoded values, or in linear light (sRGB decoded first), which is what compares like light. Default encoded.");

export const AePatchCheckSchema = z
  .object({
    comp_id: z.number().int().describe("The composition that holds the patch."),
    patch_layers: z
      .array(LayerSelectorSchema)
      .min(1)
      .max(50)
      .describe("The layers that make the patch (a clean-plate patch, a removal comp, an insert). They are switched OFF in a temporary copy to get the plate; the original is not touched."),
    region: RegionShapeSchema.optional().describe(
      "Where the patch is, in comp pixels. Default: the footprint of the patch layers (a layer's source rectangle moved through its transforms and parents at each sampled time; several layers give their bounding box). A Corner Pin or CC Power Pin on the layer is followed, and a mask's expansion and feather are allowed for. Give it when the layer has another geometry effect (Transform, Motion Tile, a warp), is 3D, or moves by a track."
    ),
    region_track: RegionTrackInputSchema.optional(),
    ring_px: z.number().min(2).max(400).default(24).describe("Width in comp pixels of the ring around the region that the patch is compared with. Default 24."),
    ring_gap_px: z.number().min(0).max(100).default(2).describe("Gap in comp pixels between the region's edge and the ring, so the seam itself is not part of either. Default 2."),
    ...SamplingFields,
    grain_probes: z
      .number()
      .int()
      .min(0)
      .max(6)
      .default(3)
      .describe("Frozen-grain needs two neighbouring frames: this many sampled times (spread over the range) also render the next frame. 0 skips the check. Default 3."),
    seam_max: z.number().min(1).max(20).default(1.5).describe("Seam score above which a seam is visible (1 is plain texture). Default 1.5, a first guess."),
    pop_factor: z.number().min(1.5).max(50).default(3).describe("A pop is a jump of patch-minus-ring brightness between neighbouring samples bigger than this many times the ring's own frame-to-frame jitter. Default 3."),
    frozen_ratio: z.number().min(0.05).max(1).default(0.5).describe("Temporal noise inside the patch over the ring's, below which the grain is frozen. Default 0.5."),
    slip_px: z.number().min(0.05).max(50).default(0.5).describe("Drift of the patch against the plate, in comp pixels, above which it swims. Default 0.5."),
    leak_threshold: z.number().min(0.002).max(0.5).default(0.03).describe("A pixel outside the region counts as changed by the patch when a colour channel differs by more than this (0..1). Default 0.03."),
    leak_min_pixels: z.number().int().min(1).max(100000).default(16).describe("Changed pixels outside the region below which no leakage is reported (feathered edges, antialiasing). Counted in comp pixels, whatever the comp's resolution factor. Default 16."),
    drift_max: z.number().min(0.001).max(1).default(0.02).describe("Slow drift of patch-minus-ring brightness over the range (0..1, encoded or linear per `luma_space`) above which it is reported. Default 0.02."),
    flicker_max: z.number().min(0.0005).max(1).default(0.008).describe("Standard deviation of the detrended patch-minus-ring brightness above which the patch flickers. Default 0.008 (about 2 of 255)."),
    sharpness_min: z.number().min(0.05).max(1).default(0.6).describe("Patch detail over the ring's below which the patch is too soft. Default 0.6."),
    sharpness_max: z.number().min(1).max(20).default(1.6).describe("Patch detail over the ring's above which the patch is too sharp or noisy. Default 1.6."),
    luma_space: LumaSpace,
    contact_sheet: z.boolean().default(true).describe("Write the contact sheet PNG: first, reference, last and the worst frames as rows of A (composite), B (plate), difference x4 and a +2 stop crop of the seam. Default true."),
    sheet_max_size: z.number().int().min(400).max(4096).default(1800).describe("Longest edge of the contact sheet in pixels. Default 1800."),
    ...budgetFields(160),
    expect: ExpectSchema,
  })
  .refine((v) => v.region_track === undefined || v.region !== undefined, { message: "region_track moves the `region` you give: add region too." });

const RegionDefSchema = z.object({
  name: z.string().min(1).max(60).optional().describe("A label for the region. Default 'region N'."),
  shape: RegionShapeSchema,
  ring: z
    .object({
      inner_px: z.number().min(-200).max(2000).describe("Distance in comp pixels from the shape's edge where the band starts. Negative reaches inside the shape."),
      outer_px: z.number().min(-200).max(2000).describe("Distance in comp pixels from the edge where the band ends, more than inner_px."),
    })
    .refine((r) => r.outer_px > r.inner_px, { message: "outer_px must be more than inner_px." })
    .optional()
    .describe("Measure the band between inner_px and outer_px outside the shape's edge instead of the shape itself."),
  track: RegionTrackInputSchema.optional(),
});

export const AeRegionStatsSchema = z
  .object({
    comp_id: z.number().int().describe("The composition to measure."),
    regions: z.array(RegionDefSchema).min(1).max(8).describe("Up to 8 regions to measure. Each is a shape, or a ring around a shape, optionally moved by a track."),
    ...SamplingFields,
    pop_factor: z.number().min(1.5).max(50).default(3).describe("A pop is a jump of a region's brightness between neighbouring samples bigger than this many times its own jitter. Default 3."),
    luma_space: LumaSpace,
    hide_layers: z
      .array(LayerSelectorSchema)
      .min(1)
      .max(50)
      .optional()
      .describe("Measure the comp with these layers switched OFF (in a temporary copy that is removed again). This is the opposite of `isolate_layers` in ae_track_multi and ae_screen_corners, which render ONLY the layers they list: do not pass their plate list here. This writes to the project (two undo groups) and needs `expect`. Without it the comp is measured as is and nothing is touched."),
    graph: z.boolean().default(true).describe("Write a PNG graph of each region's mean brightness over time. Default true."),
    draw_regions: z.boolean().default(true).describe("Write a PNG of the first sampled frame with the regions drawn on it. Default true."),
    max_size: z.number().int().min(200).max(4096).default(1280).describe("Longest edge of the drawn-regions PNG in pixels. Default 1280."),
    ...budgetFields(100),
    expect: ExpectSchema.optional().describe("Target guard. Required with `hide_layers`, ignored without it."),
  })
  .refine((v) => v.hide_layers === undefined || v.expect !== undefined, { message: "hide_layers writes a temporary comp: give `expect` (project_path and optionally comp_id)." });

export type AePatchCheckArgs = z.infer<typeof AePatchCheckSchema>;
export type AeRegionStatsArgs = z.infer<typeof AeRegionStatsSchema>;

// ---------- small helpers ----------

const r2 = (v: number): number => Math.round(v * 100) / 100;
const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const r4 = (v: number): number => Math.round(v * 10000) / 10000;
const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const OUT_CAP = 500;
/** Lets the panel's event loop run between heavy steps (decoding, full-frame passes). */
const yieldLoop = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

function medianOf(a: number[]): number {
  if (a.length === 0) return 0;
  const s = Float64Array.from(a).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** MAD about the median, scaled to a Gaussian sigma. */
function madSigmaOf(a: number[]): number {
  if (a.length === 0) return 0;
  const m = medianOf(a);
  return 1.4826 * medianOf(a.map((v) => Math.abs(v - m)));
}

export type Box = [number, number, number, number];

// ---------- the host's answer ----------

export interface HostFootprint {
  time: number;
  visible: boolean;
  polygon: Pt[] | null;
  /** The outline of the layer's Add-mode masks in comp pixels (the part that really shows), when it has any. Preferred over `polygon`. */
  mask_polygon?: Pt[] | null;
  /** The Add mask's expansion (signed: negative chokes; the largest, never below 0, for several masks) and the largest feather at this time, in comp pixels (the path is the unexpanded, unfeathered outline). */
  mask_expand_px?: number;
  mask_feather_px?: number;
  reason: string | null;
}

export interface HostLayer {
  index: number;
  id: number;
  name: string;
  kind: string;
  enabled: boolean;
  locked: boolean;
  guide: boolean;
  three_d: boolean;
  in_point: number;
  out_point: number;
  parent_id: number | null;
  footprints: HostFootprint[];
}

export interface HostComp {
  id: number;
  name: string;
  width: number;
  height: number;
  duration: number;
  frame_duration: number;
  frame_rate: number;
  work_area_start: number;
  work_area_duration: number;
  pixel_aspect: number;
  resolution_factor: number[] | null;
}

export interface HostRead {
  comp: HostComp;
  linear_blending: boolean | null;
  solo_active: boolean;
  times: number[] | null;
  layers: HostLayer[];
  total_layers: number;
}

const head = (l: { index: number; id: number; name: string }) => ({ index: l.index, id: l.id, name: l.name });

// ---------- sampling ----------

export interface SamplePlan {
  /** Sampled comp times, ascending, on the frame grid. */
  times: number[];
  /** Frames in the range that was to be sampled. */
  total_frames: number;
  every_n: number;
  ref_time: number;
  range: [number, number];
  /** True when `max_samples` forced a larger step than asked for, or dropped some of the explicit times. */
  capped: boolean;
  /** Explicit times only: how many of the frames asked for were left out to fit `max_samples`. */
  times_dropped?: number;
}

/** What to tell the caller when `max_samples` cut the plan, or null. */
export function cappedNote(plan: SamplePlan): string | null {
  if (!plan.capped) return null;
  if (plan.times_dropped !== undefined) {
    const kept = (t: number) => plan.times.some((x) => Math.abs(x - t) < 1e-3);
    const firstKept = kept(plan.range[0]);
    const lastKept = kept(plan.range[1]);
    let ends = "the first and last included";
    if (!firstKept && !lastKept) ends = "neither the first nor the last time asked for fit";
    else if (!firstKept) ends = "the first time asked for did not fit";
    else if (!lastKept) ends = "the last time asked for did not fit";
    return `${plan.times_dropped} of the frames given in \`times\` were dropped to fit max_samples (the kept ones are spread evenly across them, ${ends}): raise max_samples (up to ${MAX_SAMPLES}) or sample fewer times`;
  }
  return "max_samples forced a larger step than every_n";
}

/**
 * Which frames to render: the first, the reference, the last and every Nth in
 * between, never more than `maxSamples`. With explicit times, those (snapped
 * to frames). All times are on the comp's frame grid.
 */
export function planSamples(o: {
  fps: number;
  duration: number;
  workStart: number;
  workDuration: number;
  times?: number[];
  start?: number;
  end?: number;
  everyN?: number;
  maxSamples: number;
  refTime?: number;
}): SamplePlan {
  const fps = o.fps > 0 ? o.fps : 24;
  const last = Math.max(0, Math.round(o.duration * fps) - 1);
  const clampF = (f: number) => Math.max(0, Math.min(last, f));
  const wf0 = clampF(Math.round(o.workStart * fps));
  const wf1 = Math.max(wf0, clampF(Math.round((o.workStart + o.workDuration) * fps) - 1));
  const f0 = o.start !== undefined ? clampF(Math.round(o.start * fps)) : wf0;
  const f1 = Math.max(f0, o.end !== undefined ? clampF(Math.round(o.end * fps)) : wf1);
  const refFrame = o.refTime !== undefined ? clampF(Math.round(o.refTime * fps)) : undefined;
  const total = f1 - f0 + 1;
  const range: [number, number] = [r4(f0 / fps), r4(f1 / fps)];
  if (o.times && o.times.length > 0) {
    const cap = Math.max(1, Math.min(o.maxSamples, MAX_SAMPLES));
    const asked = [...new Set<number>(o.times.map((t) => clampF(Math.round(t * fps))))].sort((a, b) => a - b);
    // The reference frame is always kept; the other times give way to it (they are thinned evenly, below).
    let keep = asked.slice();
    if (refFrame !== undefined && !keep.includes(refFrame)) keep.push(refFrame);
    const wanted = keep.length;
    if (keep.length > cap) {
      // Thin evenly (first and last kept when m is 2 or more; with m of 1 only the first) rather than cutting the tail off.
      const others = keep.filter((f) => f !== refFrame).sort((a, b) => a - b);
      const m = refFrame !== undefined ? cap - 1 : cap;
      const rest: number[] = [];
      if (m === 1) rest.push(others[0]);
      else for (let i = 0; i < m; i++) rest.push(others[Math.round((i * (others.length - 1)) / (m - 1))]);
      keep = refFrame !== undefined ? [...rest, refFrame] : rest;
    }
    const frames = keep.sort((a, b) => a - b);
    // "M" is the span of the times asked for, not the work area.
    const span = asked.length > 0 ? asked[asked.length - 1] - asked[0] + 1 : total;
    return { times: frames.map((f) => f / fps), total_frames: span, every_n: 0, ref_time: (refFrame ?? frames[0]) / fps, range: [r4(asked[0] / fps), r4(asked[asked.length - 1] / fps)], capped: frames.length < wanted, ...(frames.length < wanted ? { times_dropped: wanted - frames.length } : {}) };
  }
  const refF = refFrame ?? f0;
  let n = o.everyN ?? Math.max(1, Math.ceil(total / Math.max(2, o.maxSamples)));
  const asked = n;
  const build = (step: number): number[] => {
    const set = new Set<number>([f0, f1, refF]);
    for (let f = f0; f <= f1; f += step) set.add(f);
    return [...set].sort((a, b) => a - b);
  };
  let frames = build(n);
  while (frames.length > o.maxSamples && n < total) {
    n++;
    frames = build(n);
  }
  return { times: frames.map((f) => f / fps), total_frames: total, every_n: n, ref_time: refF / fps, range, capped: n !== asked && o.everyN !== undefined };
}

// ---------- the region over time ----------

export interface TrackEntry {
  time: number;
  homography: number[];
}

/** The homography at time `t`: the entry before and after, linearly mixed (the entries normalised so h8 is 1), the nearest held outside. */
export function homographyAt(track: TrackEntry[], t: number): number[] {
  const sorted = [...track].sort((a, b) => a.time - b.time);
  const norm = (h: number[]) => (Math.abs(h[8]) > 1e-12 ? h.map((v) => v / h[8]) : h.slice());
  if (t <= sorted[0].time) return norm(sorted[0].homography);
  const lastE = sorted[sorted.length - 1];
  if (t >= lastE.time) return norm(lastE.homography);
  let i = 1;
  while (sorted[i].time < t) i++;
  const a = sorted[i - 1];
  const b = sorted[i];
  const k = (t - a.time) / (b.time - a.time);
  const ha = norm(a.homography);
  const hb = norm(b.homography);
  return ha.map((v, j) => v + (hb[j] - v) * k);
}

/** A region's track, ready to use: homographies, plus the times the track lost the plate. */
export interface ResolvedTrack {
  entries: TrackEntry[];
  /** Times of track frames that could not be solved. */
  lost: number[];
  /** Half a frame, the distance within which a lost frame counts as the sampled time. */
  tol: number;
  info: Record<string, unknown>;
}

/** The track's solved frames as homographies (reference frame -> frame), the unsolved ones as lost times. */
export function trackEntriesOf(track: PlanarTrack): ResolvedTrack {
  const entries: TrackEntry[] = [];
  const lost: number[] = [];
  for (const f of track.frames) {
    if (f.ok && f.H && f.H.length === 9 && f.H.every(Number.isFinite)) entries.push({ time: f.time, homography: f.H });
    else lost.push(f.time);
  }
  return {
    entries,
    lost,
    tol: 0.5 / (track.fps > 0 ? track.fps : 24),
    info: { source: "track", track_id: track.track_id, model: track.model, ref_time: r4(track.ref_time), frames: track.frames.length, solved_frames: entries.length, lost_frames: lost.length, from: track.source },
  };
}

/** Raw homographies as they are, or a track source resolved inside the queue lease (read only). Throws PlanarError for what the caller can fix. */
async function resolveRegionTrack(ctx: ToolContext, opId: string, comp: { id: number; width: number; height: number }, input: unknown): Promise<ResolvedTrack | undefined> {
  if (input === undefined || input === null) return undefined;
  if (Array.isArray(input)) return { entries: input as TrackEntry[], lost: [], tol: 0, info: { source: "homographies", entries: input.length } };
  const track = await resolveTrackSource(ctx, opId, comp.id, input as Parameters<typeof resolveTrackSource>[3]);
  if (Math.abs(track.comp_size[0] - comp.width) > 0.5 || Math.abs(track.comp_size[1] - comp.height) > 0.5) {
    throw new PlanarError("refused", `The track was made in a ${track.comp_size[0]}x${track.comp_size[1]} comp and this one is ${comp.width}x${comp.height}: the points are in comp pixels, so the sizes must match.`);
  }
  const rt = trackEntriesOf(track);
  if (rt.entries.length === 0) throw new PlanarError("bad_args", "No frame of that track is solved, so the region can't be placed.");
  return rt;
}

/** The region at `t`: moved by the track, or null with the reason (behind the horizon, or the track lost the plate there). */
export function placedAt(shape: RegionSpec, rt: ResolvedTrack | undefined, t: number): { polygon: Pt[] | null; reason: string | null } {
  if (rt && rt.lost.some((l) => Math.abs(l - t) <= rt.tol)) return { polygon: null, reason: "the track lost the plate at this time" };
  const polygon = polygonAt(shape, rt?.entries, t);
  return { polygon, reason: polygon ? null : "the track puts the region behind the horizon" };
}

/**
 * Whether the region leaves room for a ring: measured on a small raster of the
 * frame. A region that covers nearly the whole frame (a full-frame clean plate
 * masked to a small area, a removal precomp at comp size) has nothing to be
 * compared with.
 */
export function regionRoom(poly: Pt[], comp: { width: number; height: number }, o: { ringPx: number; gapPx: number }): { coverage: number; ring_pixels: number; fills: boolean } {
  // The raster covers the region's box plus the gap and the ring (clipped to the frame), at a scale where that window is
  // at most 160 px on its long edge: a 10 px blemish in a UHD frame gets 1 raster px per comp px, not a fraction of one.
  const b = polygonBounds(poly);
  const pad = o.gapPx + o.ringPx + 2;
  const wx0 = Math.max(0, Math.floor(b[0] - pad));
  const wy0 = Math.max(0, Math.floor(b[1] - pad));
  const wx1 = Math.min(comp.width, Math.ceil(b[2] + pad));
  const wy1 = Math.min(comp.height, Math.ceil(b[3] + pad));
  const ww = wx1 - wx0;
  const wh = wy1 - wy0;
  if (ww < 1 || wh < 1) return { coverage: 0, ring_pixels: 0, fills: true };
  const s = Math.min(1, 160 / Math.max(ww, wh));
  const w = Math.max(4, Math.round(ww * s));
  const h = Math.max(4, Math.round(wh * s));
  const sx = w / ww;
  const sy = h / wh;
  const local: Pt[] = poly.map((p) => [(p[0] - wx0) * sx, (p[1] - wy0) * sy] as Pt);
  const cov = rasterizePolygon(w, h, local);
  let covered = 0;
  for (let i = 0; i < cov.length; i++) if (cov[i] >= 0.5) covered++;
  const sd = signedDistance(cov, w, h);
  const sAvg = (sx + sy) / 2;
  const gap = o.gapPx * sAvg;
  const ring = o.ringPx * sAvg;
  let ringPx = 0;
  for (let i = 0; i < sd.length; i++) if (sd[i] >= gap && sd[i] <= gap + ring) ringPx++;
  // Coverage of the whole frame, from the window's raster (the part of the region inside the frame).
  const coverage = Math.round((covered / (sx * sy) / (comp.width * comp.height)) * 1e6) / 1e6;
  const ring_pixels = Math.round(ringPx / (sx * sy));
  // Fills only when the region really is big, or when a raster that did see the region finds no ring room.
  return { coverage, ring_pixels, fills: coverage > 0.9 || (covered > 0 && ring_pixels < 50) };
}

/** The region as a polygon at time `t` (comp pixels), or null when the track throws it behind the horizon. */
export function polygonAt(shape: RegionSpec, track: TrackEntry[] | undefined, t: number): Pt[] | null {
  const poly = regionToPolygon(shape);
  if (!track || track.length === 0) return poly;
  return warpPolygon(poly, homographyAt(track, t));
}

/** Even-odd test of a point against a polygon. */
function pointInPolygon(poly: Pt[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/** Distance from (x, y) to the polygon's outline. */
function distToOutline(poly: Pt[], x: number, y: number): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const l2 = ex * ex + ey * ey;
    const k = l2 > 1e-12 ? Math.max(0, Math.min(1, ((x - a[0]) * ex + (y - a[1]) * ey) / l2)) : 0;
    best = Math.min(best, Math.hypot(x - (a[0] + k * ex), y - (a[1] + k * ey)));
  }
  return best;
}

/**
 * Whether a mask pulled in by `d` (negative) is gone. Two cheap tests first: what is left is under a pixel, or no edge runs
 * backwards (the outline did not turn inside out; an edge test, not a bounding box one, so a rotated mask is caught too).
 * When an edge does reverse, that is either the whole outline collapsing or a swallowtail at a tight corner of a finely
 * sampled curve, so the mask is gone only when no point inside it lies as far as the choke from its outline.
 */
function chokedToNothing(shape: Pt[], grown: Pt[], d: number): boolean {
  const sb = polygonBounds(shape);
  if (Math.min(sb[2] - sb[0], sb[3] - sb[1]) + 2 * d <= 1 || Math.abs(polygonSignedArea(grown)) < 1) return true;
  const n = shape.length;
  if (grown.length !== n) return false;
  let reversed = false;
  for (let i = 0; i < n && !reversed; i++) {
    const a = shape[i];
    const b = shape[(i + 1) % n];
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    if (Math.hypot(ex, ey) < 1e-9) continue;
    const j = (i + 1) % n;
    if (ex * (grown[j][0] - grown[i][0]) + ey * (grown[j][1] - grown[i][1]) <= 0) reversed = true;
  }
  if (!reversed) return false;
  const G = 24;
  const need = Math.abs(d);
  for (let gy = 0; gy < G; gy++) {
    for (let gx = 0; gx < G; gx++) {
      const x = sb[0] + ((gx + 0.5) / G) * (sb[2] - sb[0]);
      const y = sb[1] + ((gy + 0.5) / G) * (sb[3] - sb[1]);
      if (!pointInPolygon(shape, x, y)) continue;
      if (distToOutline(shape, x, y) >= need) return false;
    }
  }
  return true;
}

/** The patch layers' footprint at sample `ti`: the one layer's quad, or the bounding box of several. */
export function footprintPolygon(layers: HostLayer[], ti: number): { polygon: Pt[] | null; reason: string | null; feather_px: number } {
  const polys: Pt[][] = [];
  let reason: string | null = null;
  let feather = 0;
  for (const l of layers) {
    const f = l.footprints[ti];
    if (!f) continue;
    const masked = !!(f.mask_polygon && f.mask_polygon.length >= 3);
    let shape: Pt[] | null | undefined = masked ? f.mask_polygon : f.polygon;
    if (f.visible && shape) {
      // A mask grows by its expansion; its feather straddles the grown edge (the caller allows for half of it each side).
      if (masked && typeof f.mask_expand_px === "number" && f.mask_expand_px !== 0) {
        const grown = offsetPolygon(shape, f.mask_expand_px);
        // A choke past the mask's half width turns the outline inside out. That layer shows nothing, so it is skipped like one that is not visible.
        if (f.mask_expand_px < 0 && chokedToNothing(shape, grown, f.mask_expand_px)) {
          if (reason === null) reason = `${l.name}: the mask's negative expansion chokes it to nothing`;
          continue;
        }
        shape = grown;
      }
      if (masked && typeof f.mask_feather_px === "number" && f.mask_feather_px > feather) feather = f.mask_feather_px;
      polys.push(shape);
    } else if (f.visible) {
      // A layer that shows but has no outline we can compute (Motion Tile, Transform, Mesh Warp, a 3D layer...): part of the patch is somewhere unknown, so the region is unknown too, not the other layers' alone.
      return { polygon: null, reason: `${l.name}: ${f.reason ?? "no footprint"}`, feather_px: 0 };
    } else if (reason === null) reason = `${l.name}: ${f.reason ?? "no footprint"}`;
  }
  if (polys.length === 0) return { polygon: null, reason: reason ?? "no patch layer shows at this time", feather_px: 0 };
  if (polys.length === 1) return { polygon: polys[0], reason: null, feather_px: feather };
  const all = polys.flat();
  const b = polygonBounds(all);
  return {
    polygon: [
      [b[0], b[1]],
      [b[2], b[1]],
      [b[2], b[3]],
      [b[0], b[3]],
    ],
    reason: null,
    feather_px: feather,
  };
}

// ---------- series: drift, flicker, pops ----------

export interface SeriesPop {
  from_time: number;
  to_time: number;
  jump: number;
  gap_frames: number;
}

export interface SeriesStats {
  n: number;
  /** Least squares slope per second. */
  slope_per_s: number;
  /** The trend's change over the sampled span. */
  total_drift: number;
  /** Standard deviation of the detrended values. */
  flicker: number;
  /** The series' own frame-to-frame jitter (robust, MAD based), or the reference series'. */
  jitter: number;
  /** The jump a pop must exceed. */
  pop_threshold: number;
  /** Jumps between neighbouring samples (a few frames apart). */
  pops: SeriesPop[];
  /** Jumps between samples further apart: they may be drift or a cut, not a pop. */
  steps: SeriesPop[];
  /** Pairs of consecutive samples at most `max_pop_gap_frames` apart: the only pairs a pop can be found in. 0 means pops can't be measured. */
  neighbour_pairs: number;
  max_pop_gap_frames: number;
}

export const MIN_POP_JUMP = 0.004;

/**
 * Drift, flicker and pops of a series sampled at `times`. A pop is a jump,
 * between neighbouring samples, bigger than `popFactor` times the jitter and at least
 * `minJump`, between samples at most `maxPopGapFrames` frames apart; the same
 * jump over a longer gap is a step. The jitter is the MAD of the successive
 * differences of `jitterFrom` (the ring's brightness) or, without it, of the
 * series itself.
 */
export function seriesStats(
  times: number[],
  values: number[],
  o: { fps: number; popFactor: number; minJump?: number; maxPopGapFrames?: number; jitterFrom?: number[] }
): SeriesStats {
  const n = Math.min(times.length, values.length);
  const empty: SeriesStats = { n, slope_per_s: 0, total_drift: 0, flicker: 0, jitter: 0, pop_threshold: o.minJump ?? MIN_POP_JUMP, pops: [], steps: [], neighbour_pairs: 0, max_pop_gap_frames: o.maxPopGapFrames ?? 3 };
  if (n < 2) return empty;
  const t = times.slice(0, n);
  const v = values.slice(0, n);
  // Drift and flicker: the least squares line and the spread around it.
  const mt = t.reduce((s, x) => s + x, 0) / n;
  const mv = v.reduce((s, x) => s + x, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (t[i] - mt) * (v[i] - mv);
    den += (t[i] - mt) ** 2;
  }
  const slope = den > 1e-12 ? num / den : 0;
  const flicker = Math.sqrt(v.reduce((s, x, i) => s + (x - (mv + slope * (t[i] - mt))) ** 2, 0) / n);
  // Pops: the jump between neighbouring samples, against the jitter of the reference series' own successive differences (their MAD about the median, so one pop doesn't inflate it). A trend is far too slow to matter between samples a few frames apart.
  const ref = o.jitterFrom && o.jitterFrom.length >= 2 ? o.jitterFrom.slice(0, n) : v;
  const diffs: number[] = [];
  for (let i = 1; i < ref.length; i++) diffs.push(ref[i] - ref[i - 1]);
  const jitter = madSigmaOf(diffs);
  const threshold = Math.max(o.popFactor * jitter, o.minJump ?? MIN_POP_JUMP);
  const pops: SeriesPop[] = [];
  const steps: SeriesPop[] = [];
  const maxGap = o.maxPopGapFrames ?? 3;
  // A steady ramp (a fade) is not a string of pops: when 70% or more of the successive changes go the same way, their median rate is expected and only what departs from it counts. Alternating or scattered changes expect none.
  const own: number[] = [];
  const rates: number[] = [];
  for (let i = 1; i < n; i++) {
    own.push(v[i] - v[i - 1]);
    rates.push((v[i] - v[i - 1]) / Math.max(1e-9, t[i] - t[i - 1]));
  }
  const up = own.filter((d) => d > 0).length;
  const down = own.filter((d) => d < 0).length;
  const rate = own.length >= 3 && Math.max(up, down) / own.length >= 0.7 ? medianOf(rates) : 0;
  let neighbourPairs = 0;
  for (let i = 1; i < n; i++) {
    const jump = Math.abs(v[i] - v[i - 1] - rate * (t[i] - t[i - 1]));
    const gap = Math.max(1, Math.round((t[i] - t[i - 1]) * o.fps));
    if (gap <= maxGap) neighbourPairs++;
    if (jump <= threshold) continue;
    const entry = { from_time: r4(t[i - 1]), to_time: r4(t[i]), jump: r4(jump), gap_frames: gap };
    if (gap <= maxGap) pops.push(entry);
    else steps.push(entry);
  }
  return {
    n,
    slope_per_s: slope,
    total_drift: slope * (t[n - 1] - t[0]),
    flicker,
    jitter,
    pop_threshold: threshold,
    pops,
    steps,
    neighbour_pairs: neighbourPairs,
    max_pop_gap_frames: maxGap,
  };
}

// ---------- analysing one frame ----------

export interface FrameOptions {
  /** Ring width and gap in comp pixels. */
  ringPx: number;
  gapPx: number;
  leakThreshold: number;
  /** Comp pixels beyond the region's edge that are not judged as outside (feathering). */
  leakMarginPx: number;
  linear: boolean;
}

export interface FrameMetrics {
  time: number;
  usable: boolean;
  reason?: string;
  region?: { bounds: Box; area_px: number; frame_share: number };
  difference?: {
    inside_mean: number;
    inside_max: number;
    outside_mean: number;
    outside_pixels: number;
    leaked_pixels: number;
    leaked_share: number;
    leak_bbox: Box | null;
  };
  seam?: { score: number; worst_segment: { from: Pt; to: Pt; score: number } | null; chunks: number };
  patch?: { luma: number; rgb: [number, number, number]; pixels: number };
  ring?: { luma: number; rgb: [number, number, number]; pixels: number };
  delta_luma?: number;
  delta_rgb?: [number, number, number];
  sharpness?: { patch: number; ring: number; ratio: number | null };
  noise?: { patch_sigma: number; ring_sigma: number };
  grain?: { patch_tn: number; ring_tn: number; ratio: number | null; valid: boolean; reason?: string };
}

const unusable = (time: number, reason: string): FrameMetrics => ({ time, usable: false, reason });

/** Pixel size of a region's polygon in the frame, scaled from comp pixels. */
const scalePoly = (poly: Pt[], sx: number, sy: number): Pt[] => poly.map((p) => [p[0] * sx, p[1] * sy] as Pt);

/**
 * Measures a patch at one frame. `composite` is the render with the patch on,
 * `plate` the same frame with it off, `polyComp` the region in comp pixels. The
 * images may be at another scale than the comp (a lower resolution factor): the
 * polygon is scaled by image width over comp width. `neighbour` is the next
 * frame's composite, for the frozen-grain check.
 */
export function analyseFrame(inp: {
  time: number;
  composite: RgbaImage;
  plate: RgbaImage;
  neighbour?: RgbaImage | null;
  polyComp: Pt[];
  comp: { width: number; height: number };
  opts: FrameOptions;
  /** The mask feather at the region's edge in comp pixels: half of it each side of the edge is neither patch nor plate, so it widens the gap, the leak margin and the inset. */
  featherPx?: number;
}): FrameMetrics {
  const { composite, plate, opts } = inp;
  if (composite.width !== plate.width || composite.height !== plate.height) {
    return unusable(inp.time, `the renders differ in size (${composite.width}x${composite.height} and ${plate.width}x${plate.height})`);
  }
  const sx = composite.width / inp.comp.width;
  const sy = composite.height / inp.comp.height;
  const sAvg = (sx + sy) / 2;
  const poly = scalePoly(inp.polyComp, sx, sy);
  const area = polygonArea(poly);
  if (area < 4) return unusable(inp.time, "the region is smaller than 4 pixels in the render");
  const bb = polygonBounds(poly);
  const ringImg = opts.ringPx * sAvg;
  const halfFeather = Math.max(0, inp.featherPx ?? 0) / 2;
  const gapImg = (opts.gapPx + halfFeather) * sAvg;
  const leakImg = (opts.leakMarginPx + halfFeather) * sAvg;
  const margin = Math.ceil(gapImg + ringImg + leakImg) + 4;
  const crop = cropToBounds(composite, bb, margin);
  const cropPlate = cropToBounds(plate, bb, margin);
  if (!crop || !cropPlate) return unusable(inp.time, "the region is outside the frame");
  const { x0, y0 } = crop;
  const cw = crop.img.width;
  const ch = crop.img.height;
  const local: Pt[] = poly.map((p) => [p[0] - x0, p[1] - y0] as Pt);
  const cov = rasterizePolygon(cw, ch, local);
  let covSum = 0;
  for (let i = 0; i < cov.length; i++) covSum += cov[i];
  const frameShare = Math.min(1, covSum / area);
  if (frameShare < 0.05) return unusable(inp.time, "less than 5% of the region is inside the frame");
  const sd = signedDistance(cov, cw, ch);
  const inset = Math.max(0.5, Math.min(2, 0.1 * Math.sqrt(area)), halfFeather * sAvg);
  const patchMask = new Float32Array(cw * ch);
  const ringM = new Float32Array(cw * ch);
  const leakMask = new Uint8Array(cw * ch);
  let patchPx = 0;
  let ringPxCount = 0;
  for (let i = 0; i < sd.length; i++) {
    if (sd[i] <= -inset) {
      patchMask[i] = 1;
      patchPx++;
    }
    if (sd[i] >= gapImg && sd[i] <= gapImg + ringImg) {
      ringM[i] = 1;
      ringPxCount++;
    }
    if (sd[i] >= leakImg) leakMask[i] = 1;
  }
  if (patchPx < 20) return unusable(inp.time, "the region leaves fewer than 20 pixels to measure");
  if (ringPxCount < 20) return unusable(inp.time, "the ring around the region has fewer than 20 pixels (the region fills the frame)");

  // Difference between the composite and the plate: per pixel, the largest channel difference (0..1).
  const dc = crop.img.data;
  const dp = cropPlate.img.data;
  let inSum = 0;
  let inMax = 0;
  let outSum = 0;
  let outCount = 0;
  let leaked = 0;
  let lx0 = Infinity;
  let ly0 = Infinity;
  let lx1 = -Infinity;
  let ly1 = -Infinity;
  const pixelDiff = (a: ArrayLike<number>, b: ArrayLike<number>, i: number) =>
    Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])) / 255;
  const noteLeak = (x: number, y: number) => {
    leaked++;
    if (x < lx0) lx0 = x;
    if (y < ly0) ly0 = y;
    if (x > lx1) lx1 = x;
    if (y > ly1) ly1 = y;
  };
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const k = y * cw + x;
      const d = pixelDiff(dc, dp, k * 4);
      if (patchMask[k] > 0) {
        inSum += d;
        if (d > inMax) inMax = d;
      } else if (leakMask[k]) {
        outSum += d;
        outCount++;
        if (d > opts.leakThreshold) noteLeak(x + x0, y + y0);
      }
    }
  }
  // Everything outside the crop is outside the region (and its margin) too.
  const fc = composite.data;
  const fp = plate.data;
  for (let y = 0; y < composite.height; y++) {
    const inRows = y >= y0 && y < y0 + ch;
    const xa = inRows ? x0 : composite.width;
    const scan = (from: number, to: number) => {
      for (let x = from; x < to; x++) {
        const d = pixelDiff(fc, fp, (y * composite.width + x) * 4);
        outSum += d;
        outCount++;
        if (d > opts.leakThreshold) noteLeak(x, y);
      }
    };
    scan(0, xa);
    if (inRows) scan(x0 + cw, composite.width);
  }

  const grayC = toGray(crop.img);
  const seam = seamScore(grayC, local, Math.max(6, ringImg));
  const ps = maskedStats(crop.img, patchMask, 0.5, { linear: opts.linear });
  const rs = maskedStats(crop.img, ringM, 0.5, { linear: opts.linear });
  const lapP = Math.sqrt(laplacianEnergy(grayC, patchMask));
  const lapR = Math.sqrt(laplacianEnergy(grayC, ringM));
  const sigP = noiseSigma(grayC, patchMask);
  const sigR = noiseSigma(grayC, ringM);

  let grain: FrameMetrics["grain"];
  if (inp.neighbour) {
    const nb = cropToBounds(inp.neighbour, bb, margin);
    if (nb && nb.img.width === cw && nb.img.height === ch) {
      const grayN = toGray(nb.img);
      const tnP = temporalNoise(grayC, grayN, patchMask);
      const tnR = temporalNoise(grayC, grayN, ringM);
      // Real grain shows the same sigma in time as in space. A ring that is much noisier in time than in space moved between the frames; one without noise has nothing to compare.
      let valid = true;
      let reason: string | undefined;
      if (sigR < 0.6 || tnR < 0.3) {
        valid = false;
        reason = "the ring has no grain to compare with";
      } else if (tnR / sigR > 2.5 || tnR / sigR < 0.4) {
        valid = false;
        reason = "the ring changed between the two frames by more than grain (the shot moves), so temporal noise is not measurable here";
      }
      grain = { patch_tn: r3(tnP), ring_tn: r3(tnR), ratio: valid && tnR > 0 ? r3(tnP / tnR) : null, valid, ...(reason ? { reason } : {}) };
    }
  }

  const lb = (v: number) => r4(v);
  return {
    time: inp.time,
    usable: true,
    region: {
      bounds: [r2(inp.polyComp.reduce((m, p) => Math.min(m, p[0]), Infinity)), r2(inp.polyComp.reduce((m, p) => Math.min(m, p[1]), Infinity)), r2(inp.polyComp.reduce((m, p) => Math.max(m, p[0]), -Infinity)), r2(inp.polyComp.reduce((m, p) => Math.max(m, p[1]), -Infinity))],
      area_px: r2(polygonArea(inp.polyComp)),
      frame_share: r3(frameShare),
    },
    difference: {
      inside_mean: lb(patchPx > 0 ? inSum / patchPx : 0),
      inside_max: lb(inMax),
      outside_mean: lb(outCount > 0 ? outSum / outCount : 0),
      // Counted in comp pixels: a render at Half resolution has a quarter of the pixels, and the limits are set in comp pixels.
      outside_pixels: Math.round(outCount / (sx * sy)),
      leaked_pixels: Math.round(leaked / (sx * sy)),
      leaked_share: r4(outCount > 0 ? leaked / outCount : 0),
      leak_bbox: leaked > 0 ? [r2(lx0 / sx), r2(ly0 / sy), r2((lx1 + 1) / sx), r2((ly1 + 1) / sy)] : null,
    },
    seam: { score: r3(seam.score), worst_segment: seam.worst_segment ? { from: [r2((seam.worst_segment.from[0] + x0) / sx), r2((seam.worst_segment.from[1] + y0) / sy)], to: [r2((seam.worst_segment.to[0] + x0) / sx), r2((seam.worst_segment.to[1] + y0) / sy)], score: r3(seam.worst_segment.score) } : null, chunks: seam.chunks },
    patch: { luma: lb(ps.luma_mean), rgb: ps.mean_rgb.map(lb) as [number, number, number], pixels: ps.pixels },
    ring: { luma: lb(rs.luma_mean), rgb: rs.mean_rgb.map(lb) as [number, number, number], pixels: rs.pixels },
    delta_luma: lb(ps.luma_mean - rs.luma_mean),
    delta_rgb: [lb(ps.mean_rgb[0] - rs.mean_rgb[0]), lb(ps.mean_rgb[1] - rs.mean_rgb[1]), lb(ps.mean_rgb[2] - rs.mean_rgb[2])],
    sharpness: { patch: r3(lapP), ring: r3(lapR), ratio: lapR > 1e-3 ? r3(lapP / lapR) : null },
    noise: { patch_sigma: r3(sigP), ring_sigma: r3(sigR) },
    ...(grain ? { grain } : {}),
  };
}

// ---------- slip ----------

export interface SlipFrame {
  time: number;
  /** Gray crops (0..255) of the composite and of the plate, at the same crop in every frame. */
  composite: GrayImage;
  plate: GrayImage;
}

export interface SlipResult {
  status: "ok" | "not_measurable";
  reason?: string;
  patch_features: number;
  ring_features: number;
  start_time: number | null;
  /** How the ring's motion was modelled when the patch's features were compared with it: frames per model. A similarity (shift, turn, zoom) copes with a zooming or turning shot; a plain shift is the fallback with few ring features. */
  ring_model?: { similarity: number; translate: number };
  /** Slip in comp pixels per frame after the first, null where too few features were still followed. */
  series: Array<{ time: number; slip_px: number | null; patch_live: number; ring_live: number }>;
  max_slip_px: number | null;
}

interface Follower {
  x0: number;
  y0: number;
  tracker: PointTracker;
  dx: number | null;
  dy: number | null;
  lost: boolean;
}

/**
 * The patch's drift against the plate. At the first frame, features inside the
 * patch are picked on the composite and features in the ring on the plate; each
 * is followed (normalised cross-correlation, as ae_track_point does) through the
 * later frames. The ring's motion is fitted with a similarity (a plain shift
 * with few features) and the slip is how far the patch's features are from where
 * that fit puts them, in comp pixels (`scale` is image pixels per comp pixel), so
 * a zoom, turn or shift of the shot is not counted as the patch swimming. A patch with nothing to
 * follow (a flat fill) is reported as not measurable, never as 0.
 */
export function measureSlip(
  frames: SlipFrame[],
  poly0: Pt[],
  o: { patchSize: number; searchPx: number; features: number; scale: number; gapPx: number; ringPx: number }
): SlipResult {
  const base: SlipResult = { status: "not_measurable", patch_features: 0, ring_features: 0, start_time: frames.length > 0 ? frames[0].time : null, series: [], max_slip_px: null };
  if (frames.length < 2) return { ...base, reason: "fewer than two frames were rendered" };
  const f0 = frames[0];
  const { width: w, height: h } = f0.composite;
  const half = Math.floor(o.patchSize / 2);
  const sd = signedDistance(rasterizePolygon(w, h, poly0), w, h);
  const inner = new Float32Array(w * h);
  const outer = new Float32Array(w * h);
  const ringEdge = half + 1 + o.gapPx;
  for (let i = 0; i < sd.length; i++) {
    if (sd[i] <= -(half + 1)) inner[i] = 1;
    if (sd[i] >= ringEdge && sd[i] <= ringEdge + Math.max(o.patchSize * 2, o.ringPx)) outer[i] = 1;
  }
  const topts = { patchSize: o.patchSize, searchRadius: Math.max(2, Math.round(o.searchPx)), minConfidence: 0.6, adaptBelow: 0.8 };
  const follow = (gray: GrayImage, mask: Float32Array): Follower[] => {
    const out: Follower[] = [];
    for (const f of goodFeatures(gray, mask, { count: o.features * 3, minDistancePx: o.patchSize, patchSize: o.patchSize })) {
      try {
        out.push({ x0: f.x, y0: f.y, tracker: new PointTracker(gray, f.x, f.y, topts), dx: 0, dy: 0, lost: false });
      } catch {
        // A flat pattern: nothing to follow at this point.
      }
      if (out.length >= o.features) break;
    }
    return out;
  };
  const patch = follow(f0.composite, inner);
  const ring = follow(f0.plate, outer);
  const result: SlipResult = { ...base, patch_features: patch.length, ring_features: ring.length };
  if (patch.length < 3) {
    return { ...result, reason: "the patch has no texture to follow (a flat or nearly flat fill, or a region too small for a pattern), so slip can't be measured; it is not 0" };
  }
  if (ring.length < 3) return { ...result, reason: "the ring around the patch has no texture to follow, so slip can't be measured" };
  const liveOf = (list: Follower[]) => list.filter((f) => !f.lost && f.dx !== null && f.dy !== null);
  const modelFrames = { similarity: 0, translate: 0 };
  /**
   * Where the ring's motion says a point at (x, y) should be now. With enough ring features a similarity is fitted (robustly), so a zoom or a turn of the
   * shot, which moves features near the ring and features inside the patch by different amounts, is not mistaken for the patch swimming; otherwise the
   * ring's median shift.
   */
  const ringPredictor = (rl: Follower[]): { predict: (f: Follower) => [number, number]; model: "similarity" | "translate" } => {
    const mdx = medianOf(rl.map((f) => f.dx as number));
    const mdy = medianOf(rl.map((f) => f.dy as number));
    const shift = { predict: (f: Follower): [number, number] => [f.x0 + mdx, f.y0 + mdy], model: "translate" as const };
    if (rl.length < 4) return shift;
    const from: Array<[number, number]> = rl.map((f) => [f.x0, f.y0]);
    const to: Array<[number, number]> = rl.map((f) => [f.x0 + (f.dx as number), f.y0 + (f.dy as number)]);
    const fit = ransacModel("similarity", from, to, { thresholdPx: 1.5, iterations: 60, seed: 7 });
    if (!fit) return shift;
    const inl = fit.inliers.filter(Boolean).length;
    const zoom = Math.hypot(fit.H[0], fit.H[3]);
    if (inl < Math.max(3, Math.ceil(rl.length * 0.6)) || !(zoom > 0.7 && zoom < 1.4)) return shift;
    const H: Mat3 = fit.H;
    return {
      model: "similarity",
      predict: (f) => {
        const q = applyH(H, [f.x0, f.y0]);
        return q ? [q[0], q[1]] : [f.x0 + mdx, f.y0 + mdy];
      },
    };
  };
  let maxSlip = 0;
  let measured = 0;
  for (let i = 1; i < frames.length; i++) {
    const fr = frames[i];
    for (const f of patch) {
      if (f.lost) continue;
      const step = f.tracker.step(fr.composite);
      if (!step) f.lost = true;
      else {
        f.dx = step.x - f.x0;
        f.dy = step.y - f.y0;
      }
    }
    for (const f of ring) {
      if (f.lost) continue;
      const step = f.tracker.step(fr.plate);
      if (!step) f.lost = true;
      else {
        f.dx = step.x - f.x0;
        f.dy = step.y - f.y0;
      }
    }
    const pl = liveOf(patch);
    const rl = liveOf(ring);
    if (pl.length >= 2 && rl.length >= 2) {
      // The patch's own motion minus the motion the ring's fit predicts at the patch's features: zero for a patch that is locked to the plate.
      const pred = ringPredictor(rl);
      modelFrames[pred.model]++;
      const rx = pl.map((f) => f.x0 + (f.dx as number) - pred.predict(f)[0]);
      const ry = pl.map((f) => f.y0 + (f.dy as number) - pred.predict(f)[1]);
      const slip = Math.hypot(medianOf(rx), medianOf(ry)) / o.scale;
      result.series.push({ time: fr.time, slip_px: r3(slip), patch_live: pl.length, ring_live: rl.length });
      if (slip > maxSlip) maxSlip = slip;
      measured++;
    } else {
      result.series.push({ time: fr.time, slip_px: null, patch_live: pl.length, ring_live: rl.length });
    }
  }
  result.ring_model = modelFrames;
  if (measured === 0) return { ...result, reason: "the features were lost in every later frame (the shot moves more than the search distance between samples, or the frames are too far apart): sample closer frames" };
  return { ...result, status: "ok", max_slip_px: r3(maxSlip) };
}

// ---------- judging ----------

export type Verdict = "ok" | "warn" | "fail" | "not_measurable";

export interface Thresholds {
  seam_max: number;
  pop_factor: number;
  frozen_ratio: number;
  slip_px: number;
  leak_threshold: number;
  leak_min_pixels: number;
  drift_max: number;
  flicker_max: number;
  sharpness_min: number;
  sharpness_max: number;
}

export interface Fix {
  tool: string;
  why: string;
}

export interface CheckResult {
  check: "leakage" | "effect" | "seam" | "flicker" | "pops" | "drift" | "frozen_grain" | "slip" | "sharpness";
  verdict: Verdict;
  summary: string;
  numbers: Record<string, unknown>;
  /** The sampled times that are worst for this check. */
  worst_times: number[];
  fixes: Fix[];
}

export interface FrameScore {
  time: number;
  /** The largest finding-over-threshold ratio at this frame; 1 or more means a threshold was passed. */
  score: number;
  reasons: string[];
}

const severity = (v: Verdict): number => (v === "fail" ? 2 : v === "warn" ? 1 : 0);

function worseOf(a: Verdict, b: Verdict): Verdict {
  return severity(b) > severity(a) ? b : a;
}

const topTimes = (rows: Array<{ time: number; v: number }>, n = 3): number[] =>
  [...rows]
    .sort((a, b) => b.v - a.v)
    .slice(0, n)
    .map((r) => r.time);

export interface JudgeResult {
  verdict: Verdict | "inconclusive";
  checks: CheckResult[];
  frame_scores: FrameScore[];
  worst_frames: FrameScore[];
  series_stats: { delta_luma: SeriesStats | null; delta_rgb?: Record<"red" | "green" | "blue", SeriesStats> };
}

/**
 * Turns the per-frame measurements into a verdict per check. Each check has
 * ok, warn, fail or not_measurable, with the numbers behind it and the tool
 * that would fix it; the frames are ranked by their worst finding over its
 * threshold.
 */
export function judgePatch(frames: FrameMetrics[], slip: SlipResult | null, o: { thresholds: Thresholds; fps: number; grainRequested: boolean }): JudgeResult {
  const t = o.thresholds;
  const use = frames.filter((f) => f.usable);
  const checks: CheckResult[] = [];
  const scores = new Map<number, { score: number; reasons: string[] }>();
  const note = (time: number, ratio: number, reason: string) => {
    if (!Number.isFinite(ratio) || ratio <= 0) return;
    const cur = scores.get(time) ?? { score: 0, reasons: [] };
    if (ratio > cur.score) cur.score = ratio;
    if (ratio >= 1) cur.reasons.push(reason);
    scores.set(time, cur);
  };
  for (const f of use) scores.set(f.time, scores.get(f.time) ?? { score: 0, reasons: [] });
  const none = (check: CheckResult["check"], why: string): CheckResult => ({ check, verdict: "not_measurable", summary: why, numbers: {}, worst_times: [], fixes: [] });

  if (use.length === 0) {
    const reason = frames.length > 0 ? `no frame could be measured: ${frames[0].reason ?? "unknown"}` : "no frame was rendered";
    for (const c of ["leakage", "effect", "seam", "flicker", "pops", "drift", "frozen_grain", "slip", "sharpness"] as const) checks.push(none(c, reason));
    return { verdict: "inconclusive", checks, frame_scores: [], worst_frames: [], series_stats: { delta_luma: null } };
  }

  // leakage: the patch changing pixels outside the region.
  {
    const failPx = Math.max(t.leak_min_pixels * 8, 0);
    let verdict: Verdict = "ok";
    const rows = use.map((f) => ({ time: f.time, v: f.difference!.leaked_pixels }));
    for (const f of use) {
      const lp = f.difference!.leaked_pixels;
      const share = f.difference!.outside_pixels > 0 ? lp / f.difference!.outside_pixels : 0;
      if (lp >= failPx && share >= 0.001) verdict = worseOf(verdict, "fail");
      else if (lp >= t.leak_min_pixels) verdict = worseOf(verdict, "warn");
      note(f.time, lp / Math.max(1, t.leak_min_pixels), `${lp} pixels changed outside the region`);
    }
    const worst = use.reduce((a, b) => (b.difference!.leaked_pixels > a.difference!.leaked_pixels ? b : a));
    checks.push({
      check: "leakage",
      verdict,
      summary:
        verdict === "ok"
          ? "The patch changes nothing outside the region."
          : `The patch changes pixels outside the region (up to ${worst.difference!.leaked_pixels} at ${worst.time}s, inside ${JSON.stringify(worst.difference!.leak_bbox)}). Either the region is drawn too tight or the patch spills past it.`,
      numbers: {
        max_leaked_pixels: worst.difference!.leaked_pixels,
        max_leaked_share: worst.difference!.leaked_share,
        worst_bbox: worst.difference!.leak_bbox,
        threshold: t.leak_threshold,
        min_pixels: t.leak_min_pixels,
      },
      worst_times: topTimes(rows),
      fixes: verdict === "ok" ? [] : [{ tool: "ae_patch_finish", why: "Tighten or feather the patch's edge so it stops at the region." }],
    });
  }

  // effect: the patch must change something inside the region.
  {
    const quiet = use.filter((f) => f.difference!.inside_mean < 0.002);
    let verdict: Verdict = "ok";
    if (quiet.length === use.length) verdict = "fail";
    else if (quiet.length > 0) verdict = "warn";
    checks.push({
      check: "effect",
      verdict,
      summary:
        verdict === "ok"
          ? "The patch changes the picture inside the region."
          : quiet.length === use.length
            ? "Switching the patch layers off changes (almost) nothing inside the region at any sampled frame: the wrong layers, the wrong region, or a patch that is not showing."
            : `The patch changes nothing inside the region at ${quiet.length} of ${use.length} sampled frames (${quiet.slice(0, 5).map((f) => f.time).join(", ")}s).`,
      numbers: { frames_without_effect: quiet.length, mean_difference_inside: r4(use.reduce((s, f) => s + f.difference!.inside_mean, 0) / use.length) },
      worst_times: quiet.slice(0, 3).map((f) => f.time),
      fixes: [],
    });
  }

  // seam
  {
    const rows = use.filter((f) => f.seam && f.seam.chunks > 0).map((f) => ({ time: f.time, v: f.seam!.score }));
    if (rows.length === 0) checks.push(none("seam", "The outline could not be sampled (the region is at the frame's edge or too small)."));
    else {
      let verdict: Verdict = "ok";
      for (const r of rows) {
        if (r.v > t.seam_max * 2) verdict = worseOf(verdict, "fail");
        else if (r.v > t.seam_max) verdict = worseOf(verdict, "warn");
        note(r.time, r.v / t.seam_max, `seam score ${r.v}`);
      }
      const worst = rows.reduce((a, b) => (b.v > a.v ? b : a));
      checks.push({
        check: "seam",
        verdict,
        summary: verdict === "ok" ? `No visible seam (worst score ${worst.v}, limit ${t.seam_max}).` : `A visible edge along the patch outline: score ${worst.v} at ${worst.time}s (plain texture is 1, limit ${t.seam_max}).`,
        numbers: { worst_score: worst.v, limit: t.seam_max, frames_over: rows.filter((r) => r.v > t.seam_max).length },
        worst_times: topTimes(rows),
        fixes: verdict === "ok" ? [] : [{ tool: "ae_patch_finish", why: "Feather or blend the edge." }, { tool: "ae_patch_color_match", why: "A seam is often a level mismatch: match the patch to the ring." }],
      });
    }
  }

  // flicker, pops, drift: patch-minus-ring brightness (luma, and each of R, G, B) over time. A colour-only flicker or a hue drift at constant luma shows in a channel.
  const times = use.map((f) => f.time);
  const delta = use.map((f) => f.delta_luma!);
  const ringSeries = use.map((f) => f.ring!.luma);
  const sopts = { fps: o.fps, popFactor: t.pop_factor };
  const stats = use.length >= 2 ? seriesStats(times, delta, { ...sopts, jitterFrom: ringSeries }) : null;
  const hasRgb = use.every((f) => Array.isArray(f.delta_rgb) && f.ring && Array.isArray(f.ring.rgb));
  const CH = ["red", "green", "blue"] as const;
  const chanStats =
    stats && hasRgb
      ? CH.map((name, k) => ({
          name: name as string,
          values: use.map((f) => f.delta_rgb![k]),
          stats: seriesStats(times, use.map((f) => f.delta_rgb![k]), { ...sopts, jitterFrom: use.map((f) => f.ring!.rgb[k]) }),
        }))
      : [];
  const allSeries = stats ? [{ name: "luma", values: delta, stats }, ...chanStats] : [];
  if (!stats || use.length < 4) {
    const why = `Needs at least 4 usable sampled frames (got ${use.length}).`;
    checks.push(none("flicker", why));
    if (stats && use.length >= 2) {
      // Pops can be found from two frames on.
      checks.push(popCheck(allSeries, o, note));
    } else checks.push(none("pops", "Needs at least 2 usable sampled frames."));
    checks.push(none("drift", why));
  } else {
    const perChannel = (pick: (s: SeriesStats) => number) => Object.fromEntries(allSeries.map((x) => [x.name, r4(pick(x.stats))]));
    const worstBy = (pick: (s: SeriesStats) => number) => allSeries.reduce((a, b) => (pick(b.stats) > pick(a.stats) ? b : a));
    const flickerOf = (s: SeriesStats) => s.flicker;
    const wf = worstBy(flickerOf);
    let flickerV: Verdict = "ok";
    if (wf.stats.flicker > t.flicker_max * 2.5) flickerV = "fail";
    else if (wf.stats.flicker > t.flicker_max) flickerV = "warn";
    const wfName = wf.name === "luma" ? "brightness" : `the ${wf.name} channel`;
    const meanOf = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
    checks.push({
      check: "flicker",
      verdict: flickerV,
      summary:
        flickerV === "ok"
          ? `The patch holds its level against the ring (flicker ${r4(wf.stats.flicker)} at worst, limit ${t.flicker_max}).`
          : `Patch-minus-ring ${wfName} flickers: standard deviation ${r4(wf.stats.flicker)} after removing the trend (limit ${t.flicker_max}).`,
      numbers: { flicker: r4(wf.stats.flicker), worst_channel: wf.name, per_channel: perChannel(flickerOf), limit: t.flicker_max, ring_jitter: r4(wf.stats.jitter) },
      worst_times: topTimes(use.map((f, i) => ({ time: f.time, v: Math.abs(wf.values[i] - meanOf(wf.values)) }))),
      fixes: flickerV === "ok" ? [] : [{ tool: "ae_patch_color_match", why: "Match the patch's level to the ring frame by frame (animated gain/offset)." }],
    });
    checks.push(popCheck(allSeries, o, note));
    const driftOf = (s: SeriesStats) => Math.abs(s.total_drift);
    const wd = worstBy(driftOf);
    let driftV: Verdict = "ok";
    const drift = driftOf(wd.stats);
    if (drift > t.drift_max * 2.5) driftV = "fail";
    else if (drift > t.drift_max) driftV = "warn";
    const wdName = wd.name === "luma" ? "" : ` in the ${wd.name} channel`;
    checks.push({
      check: "drift",
      verdict: driftV,
      summary:
        driftV === "ok"
          ? `No slow drift against the ring (${r4(wd.stats.total_drift)} over the range at worst, limit ${t.drift_max}).`
          : `The patch drifts ${wd.stats.total_drift > 0 ? "brighter" : "darker"}${wdName} against the ring by ${r4(drift)} over the range (limit ${t.drift_max}).`,
      numbers: {
        total_drift: r4(wd.stats.total_drift),
        worst_channel: wd.name,
        per_channel: Object.fromEntries(allSeries.map((x) => [x.name, r4(x.stats.total_drift)])),
        slope_per_second: r4(wd.stats.slope_per_s),
        limit: t.drift_max,
      },
      worst_times: [times[0], times[times.length - 1]],
      fixes: driftV === "ok" ? [] : [{ tool: "ae_patch_color_match", why: "Animate the match so the patch follows the ring's light." }],
    });
  }

  // frozen grain
  {
    if (!o.grainRequested) checks.push(none("frozen_grain", "Skipped: grain_probes is 0."));
    else {
      const withGrain = use.filter((f) => f.grain);
      const valid = withGrain.filter((f) => f.grain!.valid && f.grain!.ratio !== null);
      if (valid.length === 0) {
        const why = withGrain.length > 0 ? withGrain[0].grain!.reason ?? "no valid probe" : "no probe frame could be rendered";
        checks.push(none("frozen_grain", `Not measurable: ${why}.`));
      } else {
        let verdict: Verdict = "ok";
        const rows = valid.map((f) => ({ time: f.time, v: f.grain!.ratio as number }));
        for (const r of rows) {
          if (r.v < t.frozen_ratio) verdict = worseOf(verdict, "fail");
          else if (r.v < t.frozen_ratio * 1.4) verdict = worseOf(verdict, "warn");
          note(r.time, t.frozen_ratio / Math.max(r.v, 0.01), `grain ratio ${r.v}`);
        }
        const worst = rows.reduce((a, b) => (b.v < a.v ? b : a));
        checks.push({
          check: "frozen_grain",
          verdict,
          summary: verdict === "ok" ? `The patch's grain moves like the plate's (temporal noise ratio ${worst.v}, limit ${t.frozen_ratio}).` : `The patch's grain barely changes from frame to frame: temporal noise is ${worst.v} of the ring's at ${worst.time}s (limit ${t.frozen_ratio}).`,
          numbers: { lowest_ratio: worst.v, limit: t.frozen_ratio, probes: valid.length, probes_not_measurable: withGrain.length - valid.length },
          worst_times: [worst.time],
          fixes: verdict === "ok" ? [] : [{ tool: "ae_patch_grain", why: "Add grain that changes every frame, matched to the plate's." }],
        });
      }
    }
  }

  // slip
  {
    if (!slip) checks.push(none("slip", "Slip was not measured."));
    else if (slip.status !== "ok" || slip.max_slip_px === null) checks.push(none("slip", slip.reason ?? "Slip could not be measured."));
    else {
      let verdict: Verdict = "ok";
      if (slip.max_slip_px > t.slip_px * 2) verdict = "fail";
      else if (slip.max_slip_px > t.slip_px) verdict = "warn";
      for (const r of slip.series) if (r.slip_px !== null) note(r.time, r.slip_px / t.slip_px, `slip ${r.slip_px}px`);
      const worst = slip.series.filter((r) => r.slip_px !== null).reduce((a, b) => ((b.slip_px as number) > (a.slip_px as number) ? b : a));
      checks.push({
        check: "slip",
        verdict,
        summary: verdict === "ok" ? `The patch stays on the plate (largest slip ${slip.max_slip_px}px, limit ${t.slip_px}px).` : `The patch swims against the plate by up to ${slip.max_slip_px}px at ${worst.time}s (limit ${t.slip_px}px).`,
        numbers: { max_slip_px: slip.max_slip_px, limit_px: t.slip_px, patch_features: slip.patch_features, ring_features: slip.ring_features, from_time: slip.start_time },
        worst_times: [worst.time],
        fixes: verdict === "ok" ? [] : [{ tool: "ae_track_multi", why: "Track the patch with more points (or a planar track) so it holds to the plate." }],
      });
    }
  }

  // sharpness
  {
    const rows = use.filter((f) => f.sharpness && f.sharpness.ratio !== null).map((f) => ({ time: f.time, v: f.sharpness!.ratio as number }));
    if (rows.length === 0) checks.push(none("sharpness", "The ring holds no fine detail to compare with."));
    else {
      const med = medianOf(rows.map((r) => r.v));
      let verdict: Verdict = "ok";
      if (med < t.sharpness_min * 0.5 || med > t.sharpness_max * 2) verdict = "fail";
      else if (med < t.sharpness_min || med > t.sharpness_max) verdict = "warn";
      for (const r of rows) note(r.time, Math.max(r.v / t.sharpness_max, t.sharpness_min / Math.max(r.v, 0.01)), `sharpness ratio ${r.v}`);
      checks.push({
        check: "sharpness",
        verdict,
        summary: verdict === "ok" ? `The patch is as detailed as its surround (ratio ${r3(med)}).` : med < t.sharpness_min ? `The patch is softer than its surround: ${r3(med)} of the ring's detail (limit ${t.sharpness_min}).` : `The patch is sharper or noisier than its surround: ${r3(med)} times the ring's detail (limit ${t.sharpness_max}).`,
        numbers: { median_ratio: r3(med), min: t.sharpness_min, max: t.sharpness_max },
        worst_times: topTimes(rows.map((r) => ({ time: r.time, v: Math.max(r.v / t.sharpness_max, t.sharpness_min / Math.max(r.v, 0.01)) }))),
        fixes: verdict === "ok" ? [] : [{ tool: "ae_patch_finish", why: "Match the patch's blur or sharpening to the plate." }, { tool: "ae_patch_grain", why: "Grain adds the fine detail a soft patch lacks." }],
      });
    }
  }

  const measured = checks.filter((c) => c.verdict !== "not_measurable");
  const verdict: JudgeResult["verdict"] = measured.length === 0 ? "inconclusive" : measured.reduce<Verdict>((v, c) => worseOf(v, c.verdict), "ok");
  const frameScores: FrameScore[] = [...scores.entries()].map(([time, s]) => ({ time, score: r3(s.score), reasons: [...new Set(s.reasons)] })).sort((a, b) => a.time - b.time);
  const worstFrames = [...frameScores].sort((a, b) => b.score - a.score).slice(0, 5);
  // A pop belongs to the later frame of its pair.
  return {
    verdict,
    checks,
    frame_scores: frameScores,
    worst_frames: worstFrames,
    series_stats: { delta_luma: stats, ...(chanStats.length === 3 ? { delta_rgb: { red: chanStats[0].stats, green: chanStats[1].stats, blue: chanStats[2].stats } } : {}) },
  };
}

function popCheck(series: Array<{ name: string; stats: SeriesStats }>, o: { thresholds: Thresholds }, note: (time: number, ratio: number, reason: string) => void): CheckResult {
  const stats = series[0].stats;
  for (const s of stats.steps) note(s.to_time, (s.jump / stats.pop_threshold) * 0.5, `a step of ${s.jump}`);
  // A pop is a jump between frames a few apart. With samples that are all further apart than that, no pop could be seen, so "ok" would be false.
  if (stats.neighbour_pairs === 0) {
    return {
      check: "pops",
      verdict: "not_measurable",
      summary: `Pops can't be measured: none of the ${Math.max(0, stats.n - 1)} pairs of sampled frames are neighbours (at most ${stats.max_pop_gap_frames} frames apart), so a one-frame jump can't be told from drift. Sample neighbouring frames: every_n 1 (around a suspect stretch with start and end), or give explicit times that are consecutive frames.`,
      numbers: { neighbour_pairs: 0, sampled_pairs: Math.max(0, stats.n - 1), max_gap_frames: stats.max_pop_gap_frames, steps: stats.steps.slice(0, 20) },
      worst_times: [],
      fixes: [],
    };
  }
  let verdict: Verdict = "ok";
  const found: Array<{ channel: string; from_time: number; to_time: number; jump: number; gap_frames: number; threshold: number }> = [];
  for (const sr of series) {
    for (const p of sr.stats.pops) {
      found.push({ channel: sr.name, ...p, threshold: sr.stats.pop_threshold });
      note(p.to_time, p.jump / sr.stats.pop_threshold, `a pop of ${p.jump} in patch-minus-ring ${sr.name === "luma" ? "brightness" : sr.name}`);
      verdict = worseOf(verdict, p.jump > sr.stats.pop_threshold * 2 ? "fail" : "warn");
    }
  }
  found.sort((a, b) => b.jump / b.threshold - a.jump / a.threshold);
  const first = found[0];
  return {
    check: "pops",
    verdict,
    summary:
      verdict === "ok"
        ? `No pops between neighbouring samples (${stats.neighbour_pairs} neighbouring pair(s) checked, threshold ${r4(stats.pop_threshold)}, ${o.thresholds.pop_factor}x the ring's jitter ${r4(stats.jitter)}).${stats.steps.length > 0 ? ` ${stats.steps.length} larger jump(s) between samples that are not neighbours: check them with every_n 1.` : ""}`
        : `${found.length} pop(s) in patch-minus-ring ${first.channel === "luma" ? "brightness" : `${first.channel} channel`}, the largest between ${first.from_time}s and ${first.to_time}s (jump ${first.jump}, threshold ${r4(first.threshold)}).`,
    numbers: { neighbour_pairs: stats.neighbour_pairs, pops: found.slice(0, 20), steps: stats.steps.slice(0, 20), threshold: r4(stats.pop_threshold), ring_jitter: r4(stats.jitter), pop_factor: o.thresholds.pop_factor },
    worst_times: [...new Set(found.map((p) => p.to_time))].slice(0, 3),
    fixes: verdict === "ok" ? [] : [{ tool: "ae_patch_color_match", why: "A pop is a level jump: match the patch to the ring at that frame, or find the cut in the patch's source." }],
  };
}

// ---------- pictures ----------

const CELL_BG: Rgba = [28, 28, 32, 255];
const INK: Rgba = [255, 255, 255, 255];
const LABEL_BG: Rgba = [20, 20, 24, 220];

/** A render pushed up by `stops` in linear light (what the viewer's exposure control does), as a new RGBA image. */
export function exposurePush(img: RgbaImage, stops: number): { width: number; height: number; data: Buffer } {
  const gain = Math.pow(2, stops);
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) lut[i] = Math.max(0, Math.min(255, Math.round(linearToSrgb(srgbToLinear(i / 255) * gain) * 255)));
  const data = Buffer.alloc(img.width * img.height * 4);
  for (let i = 0; i < img.width * img.height * 4; i += 4) {
    data[i] = lut[img.data[i]];
    data[i + 1] = lut[img.data[i + 1]];
    data[i + 2] = lut[img.data[i + 2]];
    data[i + 3] = 255;
  }
  return { width: img.width, height: img.height, data };
}

/** |a - b| times `gain` per channel, opaque. */
export function differenceImage(a: RgbaImage, b: RgbaImage, gain: number): { width: number; height: number; data: Buffer } {
  const data = Buffer.alloc(a.width * a.height * 4);
  for (let i = 0; i < a.width * a.height * 4; i += 4) {
    data[i] = Math.min(255, Math.abs(a.data[i] - b.data[i]) * gain);
    data[i + 1] = Math.min(255, Math.abs(a.data[i + 1] - b.data[i + 1]) * gain);
    data[i + 2] = Math.min(255, Math.abs(a.data[i + 2] - b.data[i + 2]) * gain);
    data[i + 3] = 255;
  }
  return { width: a.width, height: a.height, data };
}

/** `src` fitted into a cell of cellW x cellH on a dark ground, centred, upscaled up to 6x with hard pixels. */
function fitCell(src: RgbaImage, cellW: number, cellH: number): PNG {
  const cell = createCanvas(cellW, cellH, CELL_BG);
  const k = Math.min(cellW / src.width, cellH / src.height);
  const w = Math.max(1, Math.round(src.width * Math.min(k, 6)));
  const h = Math.max(1, Math.round(src.height * Math.min(k, 6)));
  const scaled = k < 1 ? resizeArea(src, w, h) : scaleNearest(src, w, h);
  blit(cell, scaled, Math.floor((cellW - scaled.width) / 2), Math.floor((cellH - scaled.height) / 2));
  return cell;
}

export interface SheetFrame {
  label: string;
  time: number;
  composite: string;
  plate: string;
  /** The region in comp pixels. */
  polygon: Pt[];
  /** The worst seam stretch in comp pixels, when measured. */
  seam: { from: Pt; to: Pt } | null;
}

/**
 * The contact sheet: one row per frame of A (the composite), B (the plate with
 * the patch off), the difference times 4 and a +2 stops crop of the seam,
 * all cropped to the region and its surround. Returns the PNG, or null when no
 * row could be built.
 */
export function buildContactSheet(frames: SheetFrame[], comp: { width: number; height: number }, o: { ringPx: number; maxSize: number }): PNG | null {
  const rows: PNG[] = [];
  const cols = 4;
  const gap = 4;
  const cellW = Math.max(60, Math.floor((o.maxSize - gap * (cols - 1)) / cols));
  const cellH = Math.round(cellW * 0.75);
  for (const f of frames) {
    try {
      const a = decodePngFile(f.composite);
      const b = decodePngFile(f.plate);
      if (a.width !== b.width || a.height !== b.height) continue;
      const sx = a.width / comp.width;
      const sy = a.height / comp.height;
      const poly = scalePoly(f.polygon, sx, sy);
      const bb = polygonBounds(poly);
      const pad = Math.max(8, o.ringPx * ((sx + sy) / 2));
      const ca = cropToBounds(a, bb, pad);
      const cb = cropToBounds(b, bb, pad);
      if (!ca || !cb) continue;
      let seamCrop: { a: RgbaImage; b: RgbaImage } = { a: ca.img, b: cb.img };
      if (f.seam) {
        const mx = ((f.seam.from[0] + f.seam.to[0]) / 2) * sx;
        const my = ((f.seam.from[1] + f.seam.to[1]) / 2) * sy;
        const half = Math.max(16, o.ringPx * ((sx + sy) / 2));
        const sa = cropToBounds(a, [mx, my, mx, my], half);
        if (sa) seamCrop = { a: sa.img, b: sa.img };
      }
      const row = createCanvas(cols * cellW + (cols - 1) * gap, cellH, CELL_BG);
      const cells = [fitCell(ca.img, cellW, cellH), fitCell(cb.img, cellW, cellH), fitCell(differenceImage(ca.img, cb.img, 4), cellW, cellH), fitCell(exposurePush(seamCrop.a, 2), cellW, cellH)];
      const names = ["A COMPOSITE", "B PLATE", "DIFF X4", "SEAM +2 STOPS"];
      cells.forEach((c, i) => {
        drawLabel(c, names[i], 3, 3, 1, INK, LABEL_BG, 2);
        blit(row, c, i * (cellW + gap), 0);
      });
      drawLabel(row, `${f.label} ${f.time.toFixed(2)}S`.toUpperCase(), 3, cellH - 13, 1, INK, LABEL_BG, 2);
      rows.push(row);
    } catch {
      // A frame that can't be read leaves its row out of the sheet.
    }
  }
  if (rows.length === 0) return null;
  const sheet = createCanvas(rows[0].width, rows.length * cellH + (rows.length - 1) * gap, [8, 8, 10, 255]);
  rows.forEach((r, i) => blit(sheet, r, 0, i * (cellH + gap)));
  return sheet;
}

const LINE_COLOURS: Rgba[] = [
  [255, 99, 71, 255],
  [64, 200, 255, 255],
  [120, 230, 120, 255],
  [255, 200, 40, 255],
  [220, 120, 255, 255],
  [255, 140, 200, 255],
  [160, 160, 255, 255],
  [200, 200, 200, 255],
];

/** A line graph of several series over time, with the time and value range printed. Returns a PNG. */
export function drawSeriesGraph(series: Array<{ name: string; times: number[]; values: number[] }>, o: { width?: number; height?: number } = {}): PNG {
  const W = o.width ?? 720;
  const H = o.height ?? 320;
  const img = createCanvas(W, H, [18, 18, 22, 255]);
  const L = 58;
  const R = 12;
  const T = 16;
  const B = 34;
  const all = series.flatMap((s) => s.values.map((v, i) => ({ t: s.times[i], v })));
  if (all.length === 0) return img;
  let t0 = Math.min(...all.map((p) => p.t));
  let t1 = Math.max(...all.map((p) => p.t));
  let v0 = Math.min(...all.map((p) => p.v));
  let v1 = Math.max(...all.map((p) => p.v));
  if (t1 - t0 < 1e-9) t1 = t0 + 1;
  if (v1 - v0 < 1e-6) {
    v0 -= 0.05;
    v1 += 0.05;
  }
  const px = (t: number) => L + ((t - t0) / (t1 - t0)) * (W - L - R);
  const py = (v: number) => T + (1 - (v - v0) / (v1 - v0)) * (H - T - B);
  const axis: Rgba = [90, 90, 100, 255];
  drawLine(img, L, T, L, H - B, 1, axis);
  drawLine(img, L, H - B, W - R, H - B, 1, axis);
  const fmt = (v: number) => v.toFixed(Math.abs(v) < 1 ? 3 : 1);
  drawLabel(img, fmt(v1), 2, T - 2, 1, INK, CELL_BG, 1);
  drawLabel(img, fmt(v0), 2, H - B - 8, 1, INK, CELL_BG, 1);
  drawLabel(img, `${t0.toFixed(2)}S`, L, H - B + 6, 1, INK, CELL_BG, 1);
  drawLabel(img, `${t1.toFixed(2)}S`, W - R - 48, H - B + 6, 1, INK, CELL_BG, 1);
  series.forEach((s, si) => {
    const colour = LINE_COLOURS[si % LINE_COLOURS.length];
    for (let i = 1; i < s.values.length; i++) drawLine(img, px(s.times[i - 1]), py(s.values[i - 1]), px(s.times[i]), py(s.values[i]), 2, colour);
    for (let i = 0; i < s.values.length; i++) fillRect(img, Math.round(px(s.times[i])) - 2, Math.round(py(s.values[i])) - 2, 4, 4, colour);
    fillRect(img, L + 8 + si * 96, H - 14, 8, 8, colour);
    drawLabel(img, s.name.toUpperCase().slice(0, 12), L + 20 + si * 96, H - 15, 1, INK, CELL_BG, 1);
  });
  return img;
}

// ---------- plumbing: the temporary comp ----------

const runQueued = async <T>(ctx: ToolContext, label: string, opId: string, fn: () => Promise<T>): Promise<T> => {
  try {
    return await ctx.queue.run(label, fn);
  } catch (err) {
    if (err instanceof QueueWaitError) throw new BridgeError({ kind: "queued", op_id: opId, message: err.message });
    throw err;
  }
};

/** AE stopped answering (a timeout, or a wait behind a stuck call): rendering more frames would only queue behind the same block. */
function isAeBlocked(err: unknown): boolean {
  return err instanceof BridgeError && (err.kind === "timeout" || err.kind === "queued");
}

const BLOCKED_NOTE = "AE stopped responding during a render (often a modal dialog); the remaining frames were not rendered. Check ae_dialogs, then run again.";

async function readHost(ctx: ToolContext, opId: string, tool: string, label: string, tag: string, args: { comp_id: number; layers?: unknown[]; times?: number[] }): Promise<HostRead> {
  const res = await ctx.bridge.evalRaw<HostRead>({
    id: `${opId}_${tag}`,
    script: buildJsxCall("patchcheckRead", args),
    label: `${label} (read)`,
    timeoutMs: SLOW_TIMEOUT_MS,
    mutates: false,
    toolName: tool,
  });
  return res.result;
}

interface CopyState {
  num_items: number;
  comps: number;
  temp_comps: number;
  layers?: Array<{ id: number; enabled: boolean }>;
}

/** The receipt's checks: the temporary comp must be gone and the original's layers still on. */
export function copyMismatches(before: unknown, after: unknown, cleanupError: string | null, copyId: number | undefined): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  if (cleanupError) {
    m.push({
      path: "temp_comp",
      expected: "the temporary comp removed",
      actual: copyId,
      message: `The temporary comp (id ${copyId}) was not removed: ${cleanupError}. Delete it in the Project panel; its name starts with "chroma-patchcheck-copy".`,
    });
  }
  const b = before as CopyState | null;
  const a = after as CopyState | null;
  if (b && a) {
    expectThat(m, a.temp_comps <= b.temp_comps, "temp_comps", b.temp_comps, a.temp_comps, "A temporary patch-check comp is still in the project");
    if (Array.isArray(b.layers) && Array.isArray(a.layers)) {
      const now = new Map(a.layers.map((l) => [l.id, l.enabled]));
      for (const l of b.layers) {
        if (l.enabled && now.get(l.id) !== true) {
          expectThat(m, false, `layers.${l.id}.enabled`, true, now.get(l.id), `Layer ${l.id} of the original comp was switched off (or is gone); the check should only have changed its copy`);
        }
      }
    }
  }
  return m;
}

interface PlateCopySpec<P, T> {
  toolName: string;
  label: string;
  compId: number;
  expect: { project_path: string; comp_id?: number };
  framesDir: string;
  /** Read-only work before anything is written. Return `refuse` to stop with that answer and no checkpoint, copy or undo step. */
  prepare: (opId: string) => Promise<{ refuse: Record<string, unknown> } | { layers: Array<{ index: number; id: number; name: string }>; prep: P }>;
  /** The renders and measuring, with the copy in place. Throwing is caught: the copy is removed either way. */
  body: (copyId: number, prep: P, opId: string) => Promise<T>;
}

type PlateCopyRun<T> =
  | { refused: Record<string, unknown> }
  | {
      refused?: undefined;
      opId: string;
      value: T | null;
      bodyError: string | null;
      begun: Record<string, unknown>;
      removed: boolean;
      olderCopies: number;
      checkpoint: unknown;
      receipt: unknown;
      sessionFields: Record<string, unknown>;
    };

/**
 * The guarded flow around a temporary plate copy, in one queue lease: read,
 * guard, automatic checkpoint, before state, duplicate with the layers off
 * (one undo group), the body's renders, removal of the copy (another undo
 * group), after state in a separate evalScript, receipt. Once the copy exists
 * nothing throws: failures go into the receipt and `bodyError`.
 */
async function runWithPlateCopy<P, T>(ctx: ToolContext, spec: PlateCopySpec<P, T>): Promise<PlateCopyRun<T>> {
  ctx.quarantine.assertClear();
  const opId = ctx.bridge.newOpId();
  const expect = { project_path: spec.expect.project_path, comp_id: spec.expect.comp_id ?? spec.compId };
  let proofIds: number[] = [];
  const state = async (phase: string) => {
    const res = await ctx.bridge.evalRaw({
      id: `${opId}_${phase}`,
      script: buildJsxCall("patchcheckState", proofIds.length > 0 ? { comp_id: spec.compId, layer_ids: proofIds } : {}),
      label: `${spec.label} (${phase})`,
      mutates: false,
      toolName: spec.toolName,
    });
    return res.result ?? null;
  };
  return runQueued(ctx, spec.label, opId, async () => {
    ctx.quarantine.assertClear();
    const prepared = await spec.prepare(opId);
    if ("refuse" in prepared) return { refused: prepared.refuse };
    const guard = await verifyTargetGuard(ctx, expect, opId);
    const checkpoint = await autoCheckpoint(ctx, guard, spec.toolName);
    const note = { opId, toolName: spec.toolName, label: spec.label, expect, checkpoint: checkpoint?.path ?? null };
    const sessionFields = await noteBeforeWrite(ctx, note);
    proofIds = prepared.layers.map((l) => l.id);
    const before = await state("before");
    fs.mkdirSync(spec.framesDir, { recursive: true });

    // The record lives from the duplicate to the removal; if AE dies in between, it is still there at the next start.
    beginInflight(note);
    let begun: Record<string, unknown>;
    try {
      const begin = await ctx.bridge.evalRaw<Record<string, unknown>>({
        id: opId,
        script: buildJsxCall("patchcheckBegin", { comp_id: spec.compId, layers: prepared.layers.map(head), expect }),
        label: spec.label,
        mutates: true,
        toolName: spec.toolName,
      });
      begun = (begin.result ?? {}) as Record<string, unknown>;
    } catch (err) {
      endInflight(opId);
      throw err;
    }

    // From here the copy exists: nothing below may throw before it is removed.
    const copyId = begun.copy_id as number | undefined;
    let value: T | null = null;
    let bodyError: string | null = null;
    try {
      if (typeof copyId !== "number") throw new Error("AE returned no id for the temporary comp, so nothing was rendered");
      value = await spec.body(copyId, prepared.prep, opId);
    } catch (err) {
      bodyError = errMessage(err);
    }

    let cleanupError: string | null = null;
    let removed = false;
    // The removal is a write of its own: registered, so the session hook leaves it alone and does not report the temp comp as the user's change.
    const removeId = `${opId}_remove`;
    beginInflight({ ...note, opId: removeId });
    try {
      if (typeof copyId !== "number") throw new Error("AE returned no id for the temporary comp, so it could not be removed by id");
      const end = await ctx.bridge.evalRaw<Record<string, unknown>>({
        id: removeId,
        script: buildJsxCall("patchcheckEnd", { copy_id: copyId, expect }),
        label: `${spec.label} (remove copy)`,
        mutates: true,
        toolName: spec.toolName,
      });
      removed = (end.result as { removed?: boolean } | undefined)?.removed === true;
    } catch (err) {
      cleanupError = errMessage(err);
    } finally {
      endInflight(removeId);
      endInflight(opId);
    }

    const { value: after, failure } = await readAfterWrite(opId, () => state("after"));
    const custom = [...(failure ? [failure] : []), ...copyMismatches(before, failure ? null : after, cleanupError, copyId)];
    const receipt = buildReceipt({ before, after, customMismatches: custom });
    await noteAfterWrite(ctx, note, { skipRead: !!failure });
    return {
      opId,
      value,
      bodyError,
      begun,
      removed,
      olderCopies: (before as CopyState | null)?.temp_comps ?? 0,
      checkpoint,
      receipt,
      sessionFields: sessionFields as Record<string, unknown>,
    };
  });
}

/** Renders the comp and the copy at the same time. A stale-frame retry may have nudged one: the other is brought to it. `spend` counts each render against the budget. */
async function matchedPair(p: { ctx: ToolContext; opId: string; compId: number; copyId: number; time: number; index: number; framesDir: string; toolName: string; spend?: () => void }): Promise<{ original: string; copy: string; time: number }> {
  const { ctx, opId, compId, copyId, time, index, framesDir, toolName } = p;
  const spend = p.spend ?? (() => {});
  // captureCompFrame renders twice when its first write was stale (it nudges the time): count that too.
  let a = await captureCompFrame({ ctx, opId, compId, time, frameIndex: index * 6, framesDir, toolName });
  spend();
  if (a.time !== time) spend();
  let b = await captureCompFrame({ ctx, opId, compId: copyId, time, frameIndex: index * 6 + 1, framesDir, toolName });
  spend();
  if (b.time !== time) spend();
  if (a.time !== b.time) {
    const later = Math.max(a.time, b.time);
    let redone: { time: number };
    if (a.time < later) {
      a = await captureCompFrame({ ctx, opId, compId, time: later, frameIndex: index * 6 + 2, framesDir, toolName });
      redone = a;
    } else {
      b = await captureCompFrame({ ctx, opId, compId: copyId, time: later, frameIndex: index * 6 + 3, framesDir, toolName });
      redone = b;
    }
    spend();
    if (redone.time !== later) spend();
    if (a.time !== b.time) throw new Error(`the original and the copy rendered at different times (${a.time}s and ${b.time}s)`);
  }
  return { original: a.path, copy: b.path, time: a.time };
}

const writeJson = (framesDir: string, tag: string, compId: number, data: unknown): string => {
  const file = path.join(framesDir, `${tag}_c${compId}_${crypto.randomBytes(4).toString("hex")}.json`);
  fs.writeFileSync(file, JSON.stringify(data));
  return file;
};

const writePngFile = (framesDir: string, tag: string, compId: number, png: PNG): string => {
  const file = path.join(framesDir, `${tag}_c${compId}_${crypto.randomBytes(4).toString("hex")}.png`);
  fs.writeFileSync(file, encodePng(png));
  return file;
};

function sampledNote(plan: SamplePlan, got: number): string {
  return got < plan.total_frames ? `sampled ${got} of ${plan.total_frames} frames` : `sampled all ${got} frames`;
}

// ---------- ae_patch_check ----------

interface PatchPrep {
  info: HostRead;
  plan: SamplePlan;
  polys: Array<Pt[] | null>;
  reasons: Array<string | null>;
  /** Mask feather at each sampled time in comp pixels (0 for a given region). */
  feathers: number[];
  regionSource: "region" | "patch layer footprints" | "patch layer masks";
  track?: ResolvedTrack;
}

interface PatchBody {
  info: HostRead;
  plan: SamplePlan;
  polys: Array<Pt[] | null>;
  regionSource: PatchPrep["regionSource"];
  frames: FrameMetrics[];
  slip: SlipResult | null;
  rendered: Array<{ ti: number; time: number; original: string; copy: string }>;
  blocked: boolean;
  notes: string[];
  track?: ResolvedTrack;
  budget: RenderBudgetReport;
  /** Sampled times left unrendered because the budget ran out. */
  budgetSkipped: number;
}

export interface RenderBudgetReport {
  max_renders: number;
  max_seconds: number;
  used: { renders: number; seconds: number };
  /** True when the budget cut the run short: some sampled times were not rendered. */
  cut: boolean;
}

function budgetReport(b: ReturnType<typeof createRenderBudget>, max: { renders: number; seconds: number }, skipped: number): RenderBudgetReport {
  return { max_renders: max.renders, max_seconds: max.seconds, used: b.used, cut: skipped > 0 };
}

const BUDGET_SKIP = "render budget reached";

function budgetNote(r: RenderBudgetReport, skipped: number, planned: number): string[] {
  if (!r.cut) return [];
  return [
    `Render budget reached (${r.used.renders} of ${r.max_renders} renders, ${r.used.seconds}s of ${r.max_seconds}s): ${skipped} of ${planned} sampled times were not rendered and are listed as unmeasured ("${BUDGET_SKIP}"). Run again with start / end or times for the rest, or raise max_renders / max_seconds.`,
  ];
}

const PATCH_SIZE = 15;
/** Bytes the slip gray crops (two Float32 images per measured frame) may take together. */
const SLIP_MEMORY_CAP = 256_000_000;

/** Whether one more pair of gray crops of `cropPx` pixels fits under the slip memory cap, given the bytes already kept. */
export function slipCropFits(usedBytes: number, cropPx: number, capBytes = SLIP_MEMORY_CAP): boolean {
  return usedBytes + cropPx * 8 <= capBytes;
}
const PROBE_NOTE = "Frozen grain compares two neighbouring frames (grain_probes of the sampled times also render the next frame) and is only measurable where the shot barely moves.";

function probeIndexes(n: number, probes: number): Set<number> {
  const out = new Set<number>();
  if (probes <= 0 || n === 0) return out;
  if (probes === 1) out.add(Math.floor(n / 2));
  else for (let k = 0; k < probes; k++) out.add(Math.round((k * (n - 1)) / (probes - 1)));
  return out;
}

async function patchCheckHandler(args: AePatchCheckArgs, ctx: ToolContext) {
  const toolName = "ae_patch_check";
  const label = `ae_patch_check(${args.comp_id})`;
  const framesDir = defaultFramesDir();
  const thresholds: Thresholds = {
    seam_max: args.seam_max,
    pop_factor: args.pop_factor,
    frozen_ratio: args.frozen_ratio,
    slip_px: args.slip_px,
    leak_threshold: args.leak_threshold,
    leak_min_pixels: args.leak_min_pixels,
    drift_max: args.drift_max,
    flicker_max: args.flicker_max,
    sharpness_min: args.sharpness_min,
    sharpness_max: args.sharpness_max,
  };
  const fopts: FrameOptions = { ringPx: args.ring_px, gapPx: args.ring_gap_px, leakThreshold: args.leak_threshold, leakMarginPx: 3, linear: args.luma_space === "linear" };

  const run = await runWithPlateCopy<PatchPrep, PatchBody>(ctx, {
    toolName,
    label,
    compId: args.comp_id,
    expect: { project_path: args.expect.project_path, comp_id: args.expect.comp_id },
    framesDir,
    prepare: async (opId) => {
      const first = await readHost(ctx, opId, toolName, label, "info", { comp_id: args.comp_id, layers: args.patch_layers });
      const c = first.comp;
      const plan = planSamples({
        fps: c.frame_rate,
        duration: c.duration,
        workStart: c.work_area_start,
        workDuration: c.work_area_duration,
        times: args.times,
        start: args.start,
        end: args.end,
        everyN: args.every_n,
        maxSamples: args.max_samples,
        refTime: args.ref_time,
      });
      const info = await readHost(ctx, opId, toolName, label, "foot", { comp_id: args.comp_id, layers: args.patch_layers, times: plan.times });
      const polys: Array<Pt[] | null> = [];
      const reasons: Array<string | null> = [];
      const feathers: number[] = [];
      let track: ResolvedTrack | undefined;
      try {
        track = await resolveRegionTrack(ctx, opId, c, args.region_track);
      } catch (err) {
        if (err instanceof PlanarError) return { refuse: { ok: false, error: err.code, message: err.message, comp: { id: c.id, name: c.name, width: c.width, height: c.height } } };
        throw err;
      }
      plan.times.forEach((time, ti) => {
        if (args.region) {
          const pl = placedAt(args.region as RegionSpec, track, time);
          polys.push(pl.polygon);
          reasons.push(pl.reason);
          feathers.push(0);
        } else {
          const f = footprintPolygon(info.layers, ti);
          polys.push(f.polygon);
          reasons.push(f.reason);
          feathers.push(f.feather_px);
        }
      });
      if (!polys.some((p) => p !== null)) {
        return {
          refuse: {
            ok: false,
            error: "nothing_to_check",
            message: args.region
              ? "The region could not be placed at any sampled time."
              : `The patch layers have no usable region at any sampled time (${reasons.find((r) => r) ?? "none shows"}). Give \`region\` in comp pixels.`,
            sampled_times: plan.times,
            comp: { id: c.id, name: c.name, width: c.width, height: c.height },
          },
        };
      }
      // A region that fills the frame leaves no ring to compare with: say so now, before the checkpoint, the copy and up to 120 renders.
      // The ring starts past half the mask's feather (analyseFrame keeps that band out), so the check allows for it too.
      const rooms: Array<ReturnType<typeof regionRoom>> = [];
      polys.forEach((q, ti) => {
        if (q) rooms.push(regionRoom(q, c, { ringPx: args.ring_px, gapPx: args.ring_gap_px + (feathers[ti] ?? 0) / 2 }));
      });
      if (rooms.length > 0 && rooms.every((r) => r.fills)) {
        const worst = rooms.reduce((a, b) => (b.coverage > a.coverage ? b : a));
        return {
          refuse: {
            ok: false,
            error: "region_fills_frame",
            message:
              `The region (${args.region ? "the \`region\` you gave" : "the patch layers' footprint"}) covers ${Math.round(worst.coverage * 100)}% of the ${c.width}x${c.height} frame and leaves about ${worst.ring_pixels} pixels for the ${args.ring_px}px ring, so there is nothing to compare the patch with. ` +
              (args.region
                ? "Give a region that covers just the patched area."
                : "A full-frame clean-plate layer masked to a small area, or a removal precomp at comp size, has a full-frame footprint (a mask is used when the layer has Add-mode masks, but this one gave none). Give \`region\` (and \`region_track\` if it moves) around the patched area."),
            region_coverage: worst.coverage,
            ring_pixels: worst.ring_pixels,
            sampled_times: plan.times,
            comp: { id: c.id, name: c.name, width: c.width, height: c.height },
          },
        };
      }
      const maskUsed = !args.region && info.layers.some((l) => l.footprints.some((f) => f.mask_polygon && f.mask_polygon.length >= 3));
      const regionSource: PatchPrep["regionSource"] = args.region ? "region" : maskUsed ? "patch layer masks" : "patch layer footprints";
      return { layers: info.layers.map(head), prep: { info, plan, polys, reasons, feathers, regionSource, track } };
    },
    body: async (copyId, prep, opId) => {
      const { info, plan, polys, reasons, feathers } = prep;
      const comp = info.comp;
      const frames: FrameMetrics[] = [];
      const rendered: PatchBody["rendered"] = [];
      const notes: string[] = [];
      const slipFrames: SlipFrame[] = [];
      let slipPoly0: Pt[] | null = null;
      let slipBytes = 0;
      let blocked = false;
      let imgScale = 1;
      const probes = probeIndexes(plan.times.length, args.grain_probes);
      const budget = createRenderBudget({ maxRenders: args.max_renders, maxSeconds: args.max_seconds });
      const spend = () => budget.spend();
      let budgetSkipped = 0;
      // Union of the region over the sampled times, for the slip crops.
      const usable = polys.filter((p): p is Pt[] => p !== null);
      const unionBounds: Bounds = polygonBounds(usable.flat());
      // The ring (and the slip features taken from it) start past half of the widest feather.
      const halfFeather = Math.max(0, ...feathers) / 2;
      const fd = comp.frame_duration > 0 ? comp.frame_duration : 1 / (comp.frame_rate || 24);
      for (let ti = 0; ti < plan.times.length; ti++) {
        const time = plan.times[ti];
        const poly = polys[ti];
        if (!poly) {
          frames.push(unusable(time, reasons[ti] ?? "no region at this time"));
          continue;
        }
        if (blocked) {
          frames.push(unusable(time, "not rendered: AE stopped responding"));
          continue;
        }
        // A pair is two renders: do not start one with fewer than two left.
        if (budget.exhausted() || budget.used.renders + 2 > args.max_renders) {
          budgetSkipped++;
          frames.push(unusable(time, BUDGET_SKIP));
          continue;
        }
        try {
          const pair = await matchedPair({ ctx, opId, compId: args.comp_id, copyId, time, index: ti, framesDir, toolName, spend });
          const orig = decodePngFile(pair.original);
          await yieldLoop();
          const plate = decodePngFile(pair.copy);
          await yieldLoop();
          rendered.push({ ti, time: pair.time, original: pair.original, copy: pair.copy });
          let neighbour: RgbaImage | null = null;
          if (probes.has(ti) && !budget.exhausted() && budget.used.renders + 1 <= args.max_renders) {
            try {
              const nt = time + fd < comp.duration - fd * 0.5 ? time + fd : Math.max(0, time - fd);
              const snap = await captureCompFrame({ ctx, opId, compId: args.comp_id, time: nt, frameIndex: ti * 6 + 4, framesDir, toolName });
              spend();
              if (snap.time !== nt) spend();
              neighbour = decodePngFile(snap.path);
              await yieldLoop();
            } catch (err) {
              if (isAeBlocked(err)) blocked = true;
              notes.push(`The probe frame next to ${time}s could not be rendered: ${errMessage(err)}`);
            }
          }
          const metrics = analyseFrame({ time: pair.time, composite: orig, plate, neighbour, polyComp: poly, comp, opts: fopts, featherPx: feathers[ti] });
          await yieldLoop();
          frames.push(metrics);
          if (metrics.usable && orig.width === plate.width && orig.height === plate.height) {
            // Gray crops of the whole travel of the region, the same in every frame, for slip.
            const sx = orig.width / comp.width;
            const sy = orig.height / comp.height;
            const sAvg = (sx + sy) / 2;
            imgScale = sAvg;
            const margin = (args.ring_gap_px + halfFeather + args.ring_px) * sAvg + 24 + PATCH_SIZE;
            const ub: Bounds = [unionBounds[0] * sx, unionBounds[1] * sy, unionBounds[2] * sx, unionBounds[3] * sy];
            const ca = cropToBounds(orig, ub, margin);
            const cb = cropToBounds(plate, ub, margin);
            const cropPx = ca ? ca.img.width * ca.img.height : 0;
            if (ca && cb && cropPx <= 4_000_000 && !slipCropFits(slipBytes, cropPx)) {
              if (!notes.some((n) => n.startsWith("Slip"))) notes.push(`Slip uses the first ${slipFrames.length} measured frames only: keeping more gray crops would pass ${SLIP_MEMORY_CAP / 1_000_000} MB. Give a smaller range, fewer samples or a lower resolution factor for the rest.`);
            } else if (ca && cb && cropPx <= 4_000_000) {
              slipBytes += cropPx * 8;
              slipFrames.push({ time: pair.time, composite: toGray(ca.img), plate: toGray(cb.img) });
              await yieldLoop();
              if (!slipPoly0) slipPoly0 = scalePoly(poly, sx, sy).map((p) => [p[0] - ca.x0, p[1] - ca.y0] as Pt);
            } else if (ca && ca.img.width * ca.img.height > 4_000_000 && !notes.some((n) => n.startsWith("Slip"))) {
              notes.push("Slip was skipped: the region travels over more than 4 million pixels of the render. Give a smaller range or a lower resolution factor.");
            }
          }
        } catch (err) {
          if (isAeBlocked(err)) blocked = true;
          frames.push(unusable(time, `this time could not be measured: ${errMessage(err)}`));
        }
      }
      let slip: SlipResult | null = null;
      if (slipFrames.length >= 2 && slipPoly0) {
        try {
          await yieldLoop();
          slip = measureSlip(slipFrames, slipPoly0, { patchSize: PATCH_SIZE, searchPx: 16, features: 8, scale: imgScale, gapPx: (args.ring_gap_px + halfFeather) * imgScale, ringPx: args.ring_px * imgScale });
          await yieldLoop();
        } catch (err) {
          slip = { status: "not_measurable", reason: `slip failed: ${errMessage(err)}`, patch_features: 0, ring_features: 0, start_time: null, series: [], max_slip_px: null };
        }
      } else if (!notes.some((n) => n.startsWith("Slip"))) {
        slip = { status: "not_measurable", reason: "fewer than two frames could be measured", patch_features: 0, ring_features: 0, start_time: null, series: [], max_slip_px: null };
      }
      return { info, plan, polys, regionSource: prep.regionSource, frames, slip, rendered, blocked, notes, track: prep.track, budget: budgetReport(budget, { renders: args.max_renders, seconds: args.max_seconds }, budgetSkipped), budgetSkipped };
    },
  });

  if (run.refused) return run.refused;
  return finishPatchCheck(args, run, thresholds, fopts, framesDir);
}

type DoneRun<T> = Exclude<PlateCopyRun<T>, { refused: Record<string, unknown> }>;

const COLOUR_NOTE =
  "Measurements are on the 8-bit PNG AE writes, taken as sRGB display values. Whether that stays true with colour management on (OCIO, 16/32 bpc) is unmeasured.";

function linearBlendingNote(flag: boolean | null): string[] {
  if (flag === true) return ["The project blends colours with 1.0 gamma (linear blending): composites look different from a gamma-encoded blend, and so does the difference between composite and plate. The renders are measured as AE writes them."];
  if (flag === null) return ["Whether the project uses linear blending could not be read."];
  return [];
}

async function finishPatchCheck(args: AePatchCheckArgs, run: DoneRun<PatchBody>, thresholds: Thresholds, fopts: FrameOptions, framesDir: string) {
  const tail = {
    temp_comp: { copy_removed: run.removed, switched_off: run.begun.switched_off },
    checkpoint: run.checkpoint,
    receipt: run.receipt,
    ...run.sessionFields,
  };
  const body = run.value;
  if (!body) {
    return { op_id: run.opId, applied: true as const, ok: false, error: "check_failed", message: run.bodyError ?? "the check did not run", ...tail };
  }
  const comp = body.info.comp;
  const fps = comp.frame_rate > 0 ? comp.frame_rate : 24;
  const judged = judgePatch(body.frames, body.slip, { thresholds, fps, grainRequested: args.grain_probes > 0 });
  const measuredFrames = body.frames.filter((f) => f.usable).length;

  // The per-frame series, in sampled order.
  const slipAt = new Map((body.slip?.series ?? []).map((r) => [r.time, r.slip_px]));
  const scoreAt = new Map(judged.frame_scores.map((s) => [s.time, s]));
  const series = body.frames.map((f) => {
    if (!f.usable) return { time: f.time, usable: false, reason: f.reason };
    return {
      time: f.time,
      usable: true,
      delta_luma: f.delta_luma,
      delta_rgb: f.delta_rgb,
      patch_luma: f.patch!.luma,
      ring_luma: f.ring!.luma,
      leaked_pixels: f.difference!.leaked_pixels,
      inside_difference: f.difference!.inside_mean,
      seam: f.seam!.score,
      sharpness_ratio: f.sharpness!.ratio,
      grain_ratio: f.grain ? f.grain.ratio : null,
      slip_px: slipAt.has(f.time) ? slipAt.get(f.time) : null,
      score: scoreAt.get(f.time)?.score ?? 0,
    };
  });
  let seriesPath: string | undefined;
  let seriesError: string | undefined;
  try {
    fs.mkdirSync(framesDir, { recursive: true });
    seriesPath = writeJson(framesDir, "patchcheck", comp.id, { comp: head({ index: 0, id: comp.id, name: comp.name }), sampled: body.plan, thresholds, frames: body.frames, slip: body.slip, checks: judged.checks, series });
  } catch (err) {
    seriesError = errMessage(err);
  }

  // The contact sheet: first, reference, last and the two worst frames.
  let sheet: { path: string; frames: Array<{ label: string; time: number }> } | undefined;
  let sheetError: string | undefined;
  if (args.contact_sheet && body.rendered.length > 0) {
    try {
      const usableRendered = body.rendered.filter((r) => body.frames.find((f) => f.usable && Math.abs(f.time - r.time) < 1e-6));
      const want: Array<{ label: string; time: number }> = [];
      if (usableRendered.length > 0) {
        want.push({ label: "FIRST", time: usableRendered[0].time });
        const ref = usableRendered.find((r) => Math.abs(r.time - body.plan.ref_time) < 1e-3);
        if (ref) want.push({ label: "REF", time: ref.time });
        want.push({ label: "LAST", time: usableRendered[usableRendered.length - 1].time });
        for (const w of judged.worst_frames.filter((s) => s.score >= 1).slice(0, 2)) want.push({ label: "WORST", time: w.time });
      }
      const seen = new Set<number>();
      const items: SheetFrame[] = [];
      for (const w of want) {
        if (seen.has(w.time)) continue;
        seen.add(w.time);
        const r = usableRendered.find((x) => Math.abs(x.time - w.time) < 1e-6);
        const poly = r ? body.polys[r.ti] : null;
        if (!r || !poly) continue;
        const m = body.frames.find((f) => f.usable && Math.abs(f.time - w.time) < 1e-6);
        items.push({ label: w.label, time: w.time, composite: r.original, plate: r.copy, polygon: poly, seam: m?.seam?.worst_segment ? { from: m.seam.worst_segment.from, to: m.seam.worst_segment.to } : null });
      }
      const png = buildContactSheet(items, comp, { ringPx: args.ring_px, maxSize: args.sheet_max_size });
      if (png) {
        const fit = fitWithin(png.width, png.height, args.sheet_max_size);
        const out = fit.width < png.width ? resizeArea(png, fit.width, fit.height) : png;
        sheet = { path: writePngFile(framesDir, "patchcheck_sheet", comp.id, out), frames: items.map((i) => ({ label: i.label, time: r2(i.time) })) };
      } else sheetError = "no frame could be drawn";
    } catch (err) {
      sheetError = errMessage(err);
    }
  }

  const notes = [
    "EXACT where it can be: each frame is rendered with the patch on and, in a temporary copy, with the patch layers off (the plate). The difference between the two is what the patch does; the ring around the region is measured on the composite.",
    COLOUR_NOTE,
    ...linearBlendingNote(body.info.linear_blending),
    PROBE_NOTE,
    "Slip follows textured features inside the patch (on the composite) and in the ring (on the plate) from the first sampled frame; it needs texture in both and frames not too far apart. A flat fill is reported as not measurable, never as 0.",
    "Pops and flicker between samples that are not neighbouring frames can't be told from drift: pops are only called between samples at most 3 frames apart, longer jumps are listed as steps, and when no two samples are that close pops are reported not_measurable (never ok). Sample closer frames (every_n 1, or consecutive times) around a suspect stretch. Flicker, pops and drift are judged on luma and on each of R, G and B (patch minus ring), the worst one counts.",
    "Slip is the patch's features against where a similarity fitted to the ring's features puts them (a plain shift with fewer than 4 ring features), so a zoom or turn of the shot is not counted as swimming; a patch that moves differently from the plate on purpose (parallax, a different depth) will read as slip.",
    "The thresholds are first guesses (see `thresholds`) and are options: tune them after looking at a few shots you know.",
    "Not measured: real-time looped playback. Loop-play the region once for a final look.",
    ...body.notes,
    ...budgetNote(body.budget, body.budgetSkipped, body.plan.times.length),
    ...(run.olderCopies > 0 ? [`The project already had ${run.olderCopies} comp(s) named 'chroma-patchcheck-copy ...' before this run (left by an earlier run, or made by hand). They were not touched; delete them if they are not wanted.`] : []),
  ];
  if (args.region === undefined) {
    if (body.regionSource === "patch layer masks") {
      notes.push("The region is the outline of the patch layers' Add-mode masks (sampled along their curves, through the layers' transforms and parents; several masks give their bounding box). The mask's expansion grows (or, when negative, chokes) the outline and half of its feather is kept out of the patch, the ring and the leak count (read at each sampled time; the scale is the layer's, not a pin's local stretch). A 3D layer, a geometry effect other than a Corner Pin or CC Power Pin, or a track is not followed. Give `region` (and `region_track`) for those.");
    } else {
      notes.push("The region is the patch layers' footprint (each layer's source rectangle through its transforms and parents; a layer with Add-mode masks uses the masks' outline instead; a Corner Pin or CC Power Pin moves it to the pinned quad); a 3D layer, another geometry effect (Transform, Motion Tile, warps) or a track is not followed. Give `region` (and `region_track`) for those.");
    }
  }
  if (body.track && body.track.info.source === "track") {
    notes.push("The region follows a track: it is taken as drawn at the track's reference frame (ref_time in region_track) and moved by the track's reference-frame-to-frame motion. Frames the track lost are unmeasured.");
  }
  return {
    op_id: run.opId,
    applied: true as const,
    mode: "patch_check",
    comp: { id: comp.id, name: comp.name, width: comp.width, height: comp.height, frame_rate: comp.frame_rate },
    linear_blending: body.info.linear_blending,
    verdict: judged.verdict,
    region_source: body.regionSource,
    ...(body.track ? { region_track: body.track.info } : {}),
    render_budget: body.budget,
    sampled: {
      note: sampledNote(body.plan, body.plan.times.length - body.budgetSkipped),
      frames_sampled: body.plan.times.length,
      frames_measured: measuredFrames,
      frames_in_range: body.plan.total_frames,
      every_n: body.plan.every_n,
      range: body.plan.range,
      ref_time: r2(body.plan.ref_time),
      times: body.plan.times.map(r4),
      ...(body.plan.capped ? { capped: cappedNote(body.plan) } : {}),
    },
    ring: { width_px: fopts.ringPx, gap_px: fopts.gapPx },
    thresholds,
    checks: judged.checks,
    worst_frames: judged.worst_frames,
    unmeasured_frames: body.frames.filter((f) => !f.usable).map((f) => ({ time: f.time, reason: f.reason })).slice(0, 100),
    series: series.slice(0, OUT_CAP),
    ...(series.length > OUT_CAP ? { series_truncated: true } : {}),
    ...(seriesPath ? { series_path: seriesPath } : {}),
    ...(seriesError ? { series_error: seriesError } : {}),
    ...(sheet ? { contact_sheet: sheet } : {}),
    ...(sheetError ? { contact_sheet_error: sheetError } : {}),
    ...(body.blocked ? { ae_blocked: BLOCKED_NOTE } : {}),
    ...(run.bodyError ? { error: run.bodyError } : {}),
    notes,
    ...tail,
  };
}

// ---------- ae_region_stats ----------

export interface RegionRow {
  time: number;
  usable: boolean;
  reason?: string;
  pixels?: number;
  /** Share of the region that lies in the frame. */
  frame_share?: number;
  mean_rgb?: [number, number, number];
  std_rgb?: [number, number, number];
  p05_rgb?: [number, number, number];
  p50_rgb?: [number, number, number];
  p95_rgb?: [number, number, number];
  luma?: { mean: number; std: number; p05: number; p50: number; p95: number };
  clipped_low?: number;
  clipped_high?: number;
  noise_sigma?: number;
  /** Root of the Laplacian energy: fine detail (grain adds to it). */
  sharpness?: number;
  /** Mean absolute colour change against the previous sampled frame under this frame's mask, 0..1. */
  change?: number | null;
}

/** Measures one region at one frame: statistics under its mask, noise, detail and the change since the previous sampled frame. */
export function regionFrameStats(inp: {
  time: number;
  img: RgbaImage;
  prev?: RgbaImage | null;
  comp: { width: number; height: number };
  polyComp: Pt[];
  ring?: { inner_px: number; outer_px: number };
  linear: boolean;
}): RegionRow {
  const { img } = inp;
  const sx = img.width / inp.comp.width;
  const sy = img.height / inp.comp.height;
  const sAvg = (sx + sy) / 2;
  const poly = scalePoly(inp.polyComp, sx, sy);
  const area = polygonArea(poly);
  if (area < 1) return { time: inp.time, usable: false, reason: "the region is smaller than a pixel in the render" };
  const bb = polygonBounds(poly);
  const reach = inp.ring ? Math.ceil(Math.max(0, inp.ring.outer_px) * sAvg) : 0;
  const crop = cropToBounds(img, bb, reach + 3);
  if (!crop) return { time: inp.time, usable: false, reason: "the region is outside the frame" };
  const cw = crop.img.width;
  const ch = crop.img.height;
  const local: Pt[] = poly.map((p) => [p[0] - crop.x0, p[1] - crop.y0] as Pt);
  let mask: Float32Array;
  let share = 1;
  if (inp.ring) {
    mask = ringMask(cw, ch, local, inp.ring.inner_px * sAvg, inp.ring.outer_px * sAvg);
    let n = 0;
    for (let i = 0; i < mask.length; i++) n += mask[i];
    const touches = bb[0] - reach < 0 || bb[1] - reach < 0 || bb[2] + reach > img.width || bb[3] + reach > img.height;
    if (touches) {
      // The same band on a canvas that holds all of it: how much of it the frame cuts off.
      const m = reach + 3;
      const bw = Math.ceil(bb[2] - bb[0]) + 2 * m;
      const bh = Math.ceil(bb[3] - bb[1]) + 2 * m;
      if (bw * bh <= 16_000_000) {
        const shifted = poly.map((p) => [p[0] - bb[0] + m, p[1] - bb[1] + m] as Pt);
        const full = ringMask(bw, bh, shifted, inp.ring.inner_px * sAvg, inp.ring.outer_px * sAvg);
        let total = 0;
        for (let i = 0; i < full.length; i++) total += full[i];
        share = total > 0 ? Math.min(1, n / total) : 1;
      }
    }
  } else {
    mask = rasterizePolygon(cw, ch, local);
    let n = 0;
    for (let i = 0; i < mask.length; i++) n += mask[i];
    share = Math.min(1, n / area);
  }
  const st = maskedStats(crop.img, mask, 0.5, { linear: inp.linear });
  if (st.pixels === 0 || share < 0.02) {
    return { time: inp.time, usable: false, reason: st.pixels === 0 ? "the region covers no pixel in the render" : "less than 2% of the region is inside the frame" };
  }
  const gray = toGray(crop.img);
  const lp = lumaPercentiles(crop.img, mask, 0.5, { linear: inp.linear });
  let change: number | null = null;
  if (inp.prev && inp.prev.width === img.width && inp.prev.height === img.height) {
    const pc = cropToBounds(inp.prev, bb, reach + 3);
    if (pc && pc.img.width === cw && pc.img.height === ch) {
      let sum = 0;
      let n = 0;
      for (let k = 0; k < cw * ch; k++) {
        if (mask[k] < 0.5) continue;
        const i = k * 4;
        sum += (Math.abs(crop.img.data[i] - pc.img.data[i]) + Math.abs(crop.img.data[i + 1] - pc.img.data[i + 1]) + Math.abs(crop.img.data[i + 2] - pc.img.data[i + 2])) / 3 / 255;
        n++;
      }
      change = n > 0 ? r4(sum / n) : null;
    }
  }
  const t3 = (v: [number, number, number]): [number, number, number] => [r4(v[0]), r4(v[1]), r4(v[2])];
  return {
    time: inp.time,
    usable: true,
    pixels: st.pixels,
    frame_share: r3(share),
    mean_rgb: t3(st.mean_rgb),
    std_rgb: t3(st.std_rgb),
    p05_rgb: t3(st.p05_rgb),
    p50_rgb: t3(st.p50_rgb),
    p95_rgb: t3(st.p95_rgb),
    luma: { mean: r4(st.luma_mean), std: r4(st.luma_std), p05: r4(lp.p05), p50: r4(lp.p50), p95: r4(lp.p95) },
    clipped_low: r4(st.clipped_low),
    clipped_high: r4(st.clipped_high),
    noise_sigma: r3(noiseSigma(gray, mask)),
    sharpness: r3(Math.sqrt(laplacianEnergy(gray, mask))),
    change,
  };
}

const REGION_COLOURS: Rgba[] = [
  [255, 64, 64, 255],
  [64, 200, 255, 255],
  [96, 230, 96, 255],
  [255, 200, 40, 255],
  [220, 120, 255, 255],
  [255, 140, 200, 255],
  [160, 160, 255, 255],
  [255, 255, 255, 255],
];

/** A shrunk render with the regions drawn on it; rings are tinted. */
export function drawRegionsOverlay(frame: RgbaImage, comp: { width: number; height: number }, regions: Array<{ name: string; polygon: Pt[]; ring?: { inner_px: number; outer_px: number } }>, maxSize: number): PNG {
  const size = fitWithin(frame.width, frame.height, maxSize);
  const base = resizeArea(frame, size.width, size.height);
  const sx = base.width / comp.width;
  const sy = base.height / comp.height;
  regions.forEach((r, i) => {
    const colour = REGION_COLOURS[i % REGION_COLOURS.length];
    const poly = scalePoly(r.polygon, sx, sy);
    if (r.ring) {
      const m = ringMask(base.width, base.height, poly, r.ring.inner_px * sx, r.ring.outer_px * sx);
      for (let k = 0; k < m.length; k++) {
        if (m[k] < 0.5) continue;
        const o = k * 4;
        base.data[o] = Math.round(base.data[o] * 0.6 + colour[0] * 0.4);
        base.data[o + 1] = Math.round(base.data[o + 1] * 0.6 + colour[1] * 0.4);
        base.data[o + 2] = Math.round(base.data[o + 2] * 0.6 + colour[2] * 0.4);
      }
    }
    drawPolygon(base, poly, 2, colour);
    const b = polygonBounds(poly);
    drawLabel(base, r.name.toUpperCase().slice(0, 16), Math.max(0, Math.round(b[0])), Math.max(0, Math.round(b[1]) - 14), 1, [16, 16, 16, 255], colour, 2);
  });
  return base;
}

interface StatsRegion {
  name: string;
  shape: RegionSpec;
  ring?: { inner_px: number; outer_px: number };
  /** Filled in inside the queue lease from the region's `track` argument. */
  track?: ResolvedTrack;
}

interface StatsBody {
  rows: RegionRow[][];
  firstFrame: string | null;
  firstTime: number | null;
  blocked: boolean;
  notes: string[];
  budget: RenderBudgetReport;
  budgetSkipped: number;
}

/** Resolves each region's track argument (homographies stay as they are, a track source is read), inside the queue lease. */
async function resolveStatsTracks(ctx: ToolContext, opId: string, comp: { id: number; width: number; height: number }, defs: Array<{ track?: unknown }>, regions: StatsRegion[]): Promise<void> {
  for (let i = 0; i < regions.length; i++) regions[i].track = await resolveRegionTrack(ctx, opId, comp, defs[i].track);
}

/** Renders each sampled frame of `compId` and measures every region on it. */
async function collectRegionStats(p: {
  ctx: ToolContext;
  opId: string;
  toolName: string;
  framesDir: string;
  compId: number;
  info: HostRead;
  plan: SamplePlan;
  regions: StatsRegion[];
  linear: boolean;
  maxRenders: number;
  maxSeconds: number;
}): Promise<StatsBody> {
  const { plan, regions, info } = p;
  const budget = createRenderBudget({ maxRenders: p.maxRenders, maxSeconds: p.maxSeconds });
  let budgetSkipped = 0;
  const rows: RegionRow[][] = regions.map(() => []);
  const notes: string[] = [];
  let firstFrame: string | null = null;
  let firstTime: number | null = null;
  let blocked = false;
  let prev: RgbaImage | null = null;
  for (let ti = 0; ti < plan.times.length; ti++) {
    const time = plan.times[ti];
    if (blocked) {
      regions.forEach((_, ri) => rows[ri].push({ time, usable: false, reason: "not rendered: AE stopped responding" }));
      continue;
    }
    if (budget.exhausted()) {
      budgetSkipped++;
      regions.forEach((_, ri) => rows[ri].push({ time, usable: false, reason: BUDGET_SKIP }));
      continue;
    }
    try {
      const snap = await captureCompFrame({ ctx: p.ctx, opId: p.opId, compId: p.compId, time, frameIndex: ti * 2, framesDir: p.framesDir, toolName: p.toolName });
      budget.spend();
      // A stale-frame retry is a second render.
      if (snap.time !== time) budget.spend();
      const img = decodePngFile(snap.path);
      await yieldLoop();
      if (firstFrame === null) {
        firstFrame = snap.path;
        firstTime = snap.time;
      }
      regions.forEach((r, ri) => {
        const placed = placedAt(r.shape, r.track, snap.time);
        if (!placed.polygon) rows[ri].push({ time: snap.time, usable: false, reason: placed.reason ?? "no region at this time" });
        else rows[ri].push(regionFrameStats({ time: snap.time, img, prev, comp: info.comp, polyComp: placed.polygon, ring: r.ring, linear: p.linear }));
      });
      await yieldLoop();
      prev = img;
    } catch (err) {
      if (isAeBlocked(err)) blocked = true;
      regions.forEach((_, ri) => rows[ri].push({ time, usable: false, reason: `this time could not be measured: ${errMessage(err)}` }));
    }
  }
  return { rows, firstFrame, firstTime, blocked, notes, budget: budgetReport(budget, { renders: p.maxRenders, seconds: p.maxSeconds }, budgetSkipped), budgetSkipped };
}

function summariseRegion(rows: RegionRow[], fps: number, popFactor: number) {
  const use = rows.filter((r) => r.usable);
  if (use.length < 2) return { frames_measured: use.length, note: "Drift, flicker and pops need at least 2 measured frames." };
  const s = seriesStats(
    use.map((r) => r.time),
    use.map((r) => r.luma!.mean),
    { fps, popFactor }
  );
  const lumas = use.map((r) => r.luma!.mean);
  return {
    frames_measured: use.length,
    luma_mean: { min: r4(Math.min(...lumas)), max: r4(Math.max(...lumas)), mean: r4(lumas.reduce((a, b) => a + b, 0) / lumas.length) },
    drift: { per_second: r4(s.slope_per_s), total: r4(s.total_drift) },
    flicker: r4(s.flicker),
    jitter: r4(s.jitter),
    pop_threshold: r4(s.pop_threshold),
    pops: s.pops.slice(0, 50),
    steps: s.steps.slice(0, 50),
    neighbour_pairs: s.neighbour_pairs,
    ...(s.neighbour_pairs === 0 ? { pops_note: "Pops not measurable: no two sampled frames are neighbours (at most 3 frames apart). Use every_n 1 or consecutive times." } : {}),
    ...(use.length < 4 ? { note: "Fewer than 4 measured frames: drift and flicker are rough." } : {}),
  };
}

async function regionStatsHandler(args: AeRegionStatsArgs, ctx: ToolContext) {
  const toolName = "ae_region_stats";
  const label = `ae_region_stats(${args.comp_id})`;
  const framesDir = defaultFramesDir();
  const regions: StatsRegion[] = args.regions.map((r, i) => ({ name: r.name ?? `region ${i + 1}`, shape: r.shape as RegionSpec, ring: r.ring }));
  const trackArgs = args.regions.map((r) => ({ track: r.track as unknown }));
  const budgetArgs = { maxRenders: args.max_renders, maxSeconds: args.max_seconds };
  const linear = args.luma_space === "linear";
  const planFor = (c: HostComp) =>
    planSamples({
      fps: c.frame_rate,
      duration: c.duration,
      workStart: c.work_area_start,
      workDuration: c.work_area_duration,
      times: args.times,
      start: args.start,
      end: args.end,
      everyN: args.every_n,
      maxSamples: args.max_samples,
      refTime: args.ref_time,
    });

  let info: HostRead;
  let plan: SamplePlan;
  let stats: StatsBody;
  let copyTail: Record<string, unknown> = {};
  let bodyError: string | null = null;
  let opId: string;

  if (args.hide_layers) {
    const run = await runWithPlateCopy<{ info: HostRead; plan: SamplePlan }, { stats: StatsBody; info: HostRead; plan: SamplePlan }>(ctx, {
      toolName,
      label,
      compId: args.comp_id,
      expect: { project_path: args.expect!.project_path, comp_id: args.expect!.comp_id },
      framesDir,
      prepare: async (id) => {
        const first = await readHost(ctx, id, toolName, label, "info", { comp_id: args.comp_id, layers: args.hide_layers });
        try {
          await resolveStatsTracks(ctx, id, first.comp, trackArgs, regions);
        } catch (err) {
          if (err instanceof PlanarError) return { refuse: { ok: false, error: err.code, message: err.message } };
          throw err;
        }
        return { layers: first.layers.map(head), prep: { info: first, plan: planFor(first.comp) } };
      },
      body: async (copyId, prep, id) => ({
        stats: await collectRegionStats({ ctx, opId: id, toolName, framesDir, compId: copyId, info: prep.info, plan: prep.plan, regions, linear, ...budgetArgs }),
        info: prep.info,
        plan: prep.plan,
      }),
    });
    if (run.refused) return run.refused;
    opId = run.opId;
    bodyError = run.bodyError;
    const fallbackPlan: SamplePlan = { times: [], total_frames: 0, every_n: 0, ref_time: 0, range: [0, 0], capped: false };
    const value = run.value;
    if (!value) {
      return { op_id: run.opId, applied: true as const, ok: false, error: "check_failed", message: run.bodyError ?? "the measurement did not run", temp_comp: { copy_removed: run.removed, switched_off: run.begun.switched_off }, checkpoint: run.checkpoint, receipt: run.receipt, ...run.sessionFields };
    }
    info = value.info;
    plan = value.plan ?? fallbackPlan;
    stats = value.stats;
    copyTail = { temp_comp: { copy_removed: run.removed, switched_off: run.begun.switched_off }, checkpoint: run.checkpoint, receipt: run.receipt, ...run.sessionFields };
  } else {
    opId = ctx.bridge.newOpId();
    const got = await runQueued(ctx, label, opId, async () => {
      const i = await readHost(ctx, opId, toolName, label, "info", { comp_id: args.comp_id });
      const pl = planFor(i.comp);
      try {
        await resolveStatsTracks(ctx, opId, i.comp, trackArgs, regions);
      } catch (err) {
        if (err instanceof PlanarError) return { refused: { ok: false, error: err.code, message: err.message } };
        throw err;
      }
      fs.mkdirSync(framesDir, { recursive: true });
      const s = await collectRegionStats({ ctx, opId, toolName, framesDir, compId: args.comp_id, info: i, plan: pl, regions, linear, ...budgetArgs });
      return { i, pl, s };
    });
    if ("refused" in got) return got.refused;
    info = got.i;
    plan = got.pl;
    stats = got.s;
  }

  const comp = info.comp;
  const fps = comp.frame_rate > 0 ? comp.frame_rate : 24;
  const summaries = regions.map((_, ri) => summariseRegion(stats.rows[ri], fps, args.pop_factor));

  let seriesPath: string | undefined;
  let graphPath: string | undefined;
  let regionsPng: string | undefined;
  const fileErrors: string[] = [];
  try {
    fs.mkdirSync(framesDir, { recursive: true });
    seriesPath = writeJson(framesDir, "regionstats", comp.id, {
      comp: { id: comp.id, name: comp.name },
      sampled: plan,
      regions: regions.map((r, ri) => ({ name: r.name, shape: r.shape, ring: r.ring ?? null, rows: stats.rows[ri], summary: summaries[ri] })),
    });
  } catch (err) {
    fileErrors.push(`series file: ${errMessage(err)}`);
  }
  if (args.graph) {
    try {
      const lines = regions
        .map((r, ri) => {
          const use = stats.rows[ri].filter((x) => x.usable);
          return { name: r.name, times: use.map((x) => x.time), values: use.map((x) => x.luma!.mean) };
        })
        .filter((l) => l.values.length > 0);
      if (lines.length > 0) graphPath = writePngFile(framesDir, "regionstats_graph", comp.id, drawSeriesGraph(lines));
    } catch (err) {
      fileErrors.push(`graph: ${errMessage(err)}`);
    }
  }
  if (args.draw_regions && stats.firstFrame && stats.firstTime !== null) {
    try {
      const frame = decodePngFile(stats.firstFrame);
      const t0 = stats.firstTime;
      const drawn = regions
        .map((r) => ({ name: r.name, polygon: placedAt(r.shape, r.track, t0).polygon, ring: r.ring }))
        .filter((r): r is { name: string; polygon: Pt[]; ring: StatsRegion["ring"] } => r.polygon !== null);
      regionsPng = writePngFile(framesDir, "regionstats_regions", comp.id, drawRegionsOverlay(frame, comp, drawn, args.max_size));
    } catch (err) {
      fileErrors.push(`regions picture: ${errMessage(err)}`);
    }
  }

  const measured = Math.max(0, ...stats.rows.map((r) => r.filter((x) => x.usable).length));
  const notes = [
    COLOUR_NOTE,
    args.luma_space === "linear"
      ? "Brightness is in linear light (each channel through the sRGB decode before the Rec. 709 weights); colour channels stay encoded."
      : "Brightness is on the encoded values (Rec. 709 weights on the PNG's pixels). Use luma_space 'linear' to compare in light terms.",
    ...linearBlendingNote(info.linear_blending),
    "Regions partly outside the frame report the visible share (`frame_share`); a region with under 2% inside is not measured.",
    "Pops are only called between samples at most 3 frames apart, longer jumps are listed as steps (they may be drift or a cut); a region whose samples are all further apart says pops are not measurable. Sample closer frames (every_n 1) around a suspect stretch.",
    "Noise sigma is the MAD of a 3x3 Laplacian on the calmer pixels of the region, in gray levels (0..255); sharpness is the root of the mean squared Laplacian, so grain adds to it.",
    args.hide_layers
      ? "The measured frames are those of a temporary copy of the comp with the hide_layers switched off; the copy was removed again."
      : "The comp was measured as is; nothing in the project was touched.",
    ...stats.notes,
    ...budgetNote(stats.budget, stats.budgetSkipped, plan.times.length),
    ...(regions.some((r) => r.track && r.track.info.source === "track") ? ["A region that follows a track source is taken as drawn at the track's reference frame (ref_time in its `tracks` entry) and moved by the track's reference-frame-to-frame motion; frames the track lost are unmeasured."] : []),
    ...fileErrors,
  ];
  return {
    ...(args.hide_layers ? { op_id: opId, applied: true as const } : { ok: true, read_only: true }),
    mode: "region_stats",
    render_budget: stats.budget,
    comp: { id: comp.id, name: comp.name, width: comp.width, height: comp.height, frame_rate: comp.frame_rate },
    linear_blending: info.linear_blending,
    sampled: {
      note: sampledNote(plan, plan.times.length - stats.budgetSkipped),
      frames_sampled: plan.times.length,
      frames_measured: measured,
      frames_in_range: plan.total_frames,
      every_n: plan.every_n,
      range: plan.range,
      times: plan.times.map(r4),
      ...(plan.capped ? { capped: cappedNote(plan) } : {}),
    },
    regions: regions.map((r, ri) => ({
      name: r.name,
      kind: r.shape.kind,
      ...(r.ring ? { ring: r.ring } : {}),
      tracked: !!r.track,
      ...(r.track ? { track: r.track.info } : {}),
      summary: summaries[ri],
      frames: stats.rows[ri].slice(0, OUT_CAP),
    })),
    ...(seriesPath ? { series_path: seriesPath } : {}),
    ...(graphPath ? { graph_path: graphPath } : {}),
    ...(regionsPng ? { regions_png: regionsPng } : {}),
    ...(stats.blocked ? { ae_blocked: BLOCKED_NOTE } : {}),
    ...(bodyError ? { error: bodyError } : {}),
    notes,
    ...copyTail,
  };
}

// ---------- tools ----------

export const patchcheckTools: ToolDefinition<any>[] = [
  {
    name: "ae_patch_check",
    description:
      "Checks a patch, removal or insert the way a compositor would, from rendered frames, and says which frames are worst and why. " +
      "How: it duplicates the comp, switches the `patch_layers` OFF in the copy (the plate), and renders the comp and the copy at sampled frames (the first, `ref_time`, the last and every Nth, at most `max_samples` and never more than 60: two renders each, reported as 'sampled N of M frames'). The copy is removed again. " +
      "Per sampled frame it measures inside the patch region (the footprint of the patch layers, using their Add-mode masks' outline when they have masks, or `region`, moved by `region_track`: homographies, or a track source such as a track_id from ae_track_multi) and in a ring around it: (1) leakage, the patch changing pixels OUTSIDE the region, with their bounding box; (2) the seam, the step across the region's outline against the texture beside it (a visible edge scores over 1.5, plain texture 1); (3) flicker, pops and slow drift of patch-minus-ring brightness over time (luma and R, G, B; a pop is a jump over 3x the ring's own jitter between neighbouring samples, and pops are not_measurable when no two samples are within 3 frames: use every_n 1 or consecutive times); (4) frozen grain, temporal noise inside over the ring's (under 0.5 is frozen), from a few neighbouring frame pairs; (5) slip, the patch drifting against the plate, from features followed inside the patch and in the ring (a flat fill is 'not measurable', not 0); (6) sharpness against the ring; and whether the patch changes anything at all. " +
      "Returns a verdict per check (ok, warn, fail, not_measurable) with the numbers and the tool that fixes it (ae_patch_color_match, ae_patch_grain, ae_patch_finish, ae_track_multi), the worst frames, the per-frame series (500 rows at most; the full series as a JSON file) and a contact sheet PNG: first, reference, last and worst frames as A/B pairs, a difference view (x4) and +2 stop crops of the seam. " +
      "Measurements are on 8-bit sRGB snapshots; the project's linear-blending flag is reported because it changes how the composite looks. The thresholds (seam 1.5, pop 3x, frozen 0.5, slip 0.5 px) are first guesses and are options. " +
      "It writes to the project: a temporary comp named 'chroma-patchcheck-copy ...' exists for the length of the renders, in two undo groups (add the copy, remove the copy), with an automatic checkpoint first; the receipt checks the copy is gone and the original's patch layers are still on. The original comp is never changed. Refuses before the checkpoint when the region can't be placed at any sampled time, or when it fills the frame so no ring is left (region_fills_frame: give `region`). One call starts at most `max_renders` renders in `max_seconds` (default 160 and 90 s; a stale-frame retry can add one or two to the last pair, and they are counted in render_budget.used); when the budget runs out the remaining times are left unmeasured and the result says 'sampled N of M frames'. " +
      "Real-time looped playback is not measured: loop-play the region once for a final look. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AePatchCheckSchema,
    handler: patchCheckHandler,
  },
  {
    name: "ae_region_stats",
    description:
      "Measures one or more regions of a comp over time: rect, ellipse, polygon, or a ring (a band from `inner_px` to `outer_px` outside a shape's edge), each optionally moved by a track (a homography per time, or a track source such as a track_id from ae_track_multi; the shape is then given as it looks at the track's reference frame). " +
      "Per sampled frame and region: pixel count and visible share, mean, standard deviation and 5th/50th/95th percentile per channel and for luma (encoded, or linear light with `luma_space`), clipped-low and clipped-high share, noise sigma, sharpness (fine detail) and the change since the previous sampled frame. " +
      "Per region it summarises drift (linear trend), flicker (std of the detrended brightness) and pops (jumps over `pop_factor` times its own jitter) with their times. Output is bounded (500 rows; the full series as a JSON file), with a graph PNG of brightness over time and a PNG of the first frame with the regions drawn. " +
      "Use it to see how much a shot flickers before choosing a fix, to compare a region with its surround, to confirm an object is gone, or to measure a screen's black level. " +
      "One call starts at most `max_renders` renders in `max_seconds` (default 100 and 90 s; a stale-frame retry can add one, and it is counted in render_budget.used), then reports 'sampled N of M frames'. READ-ONLY by default: the comp is rendered as it is (one render per sampled frame) and nothing in the project is touched, not time, resolution, selection or solo. " +
      "With `hide_layers` (the layers to switch OFF; the opposite of `isolate_layers` in ae_track_multi and ae_screen_corners, which render only theirs) it measures a temporary copy with those layers switched off instead: that writes to the project (two undo groups, an automatic checkpoint, a receipt) and needs `expect`. " +
      "Measurements are on 8-bit sRGB snapshots (colour-managed values: unmeasured); regions partly outside the frame report the visible share. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeRegionStatsSchema,
    handler: regionStatsHandler,
  },
];
