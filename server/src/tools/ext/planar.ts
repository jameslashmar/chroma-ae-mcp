/**
 * server/src/tools/ext/planar.ts
 *
 * The planar tools: following a surface through a shot with several points,
 * and carrying things along with it. Everything runs inside the MCP and
 * After Effects (no outside tools): AE renders the frames (saveFrameToPng,
 * as the frame tools do), the server follows the points by normalized cross-
 * correlation (track.ts) and solves a motion model per frame (planar-math.ts).
 * - ae_track_multi: forwards and backwards from a reference frame, by a region's
 *   pixels (region-track.ts), a green or blue screen's key outline
 *   (screen-track.ts), or 1-8 points (translate / similarity / affine /
 *   perspective, lost points re-acquired); every frame checked against the
 *   surface; long shots followed in chunks that resume exactly
 * - ae_track_read: a track that already exists in the project (nulls, Corner
 *   Pin / CC Power Pin keys from Mocha or AE, AE Tracker points, transform
 *   keys) into the same track format. Read only.
 * - ae_track_apply: writes a track as nulls, Corner Pin / CC Power Pin keys in
 *   the target layer's own space, layer transform keys, or a motion-blur
 *   friendly transform + residual pin, in one guarded undo step
 *
 * The tracks live in the MCP's own store (JSON files, newest 200 kept) and are
 * addressed by `track_id`, so the other wave-4 tools can use them. This file
 * also holds what those tools share: loadTrack/saveTrack, resolveTrackSource,
 * withIsolatedPlate, resolveEffectParams, blurrinessFromSigma,
 * platesFolderFor, createRenderBudget and layerSpaceMatrices.
 *
 * Not built, because AE has no API for it: running AE's own Tracker, Track
 * Mask, Mocha AE or the 3D Camera Tracker (their results are read with
 * ae_track_read once the user has made them), and reading Mocha's project
 * data or the Warp Stabilizer solve. Points must lie on one plane, or the
 * pattern slides (parallax). Comps with non-square pixels are refused.
 *
 * Unmeasured on AE 26: the Tracker's property match names and whether
 * Feature Center is in layer space, Corner Pin point order (-0003 = Lower
 * Left) and CC Power Pin's point names, whether Property.moveTo takes the
 * index as written, whether setValuesAtTimes wants [x, y] or [x, y, 0] for a
 * 2D layer, and how fast 1080p/4K tracking is. There is no pyramid for large
 * search radii (the radius is capped at 100 instead).
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
import {
  applyH,
  boundingQuad,
  expectedError,
  quadGrid,
  decomposeLayerMatrix,
  decomposeSimilarity,
  frameAt,
  goodFeatures,
  identityH,
  invertH,
  jacobianAt,
  layerMatrix,
  mulH,
  MODEL_MIN_POINTS,
  quadCheck,
  ransacModel,
  rectQuad,
  refitFrames,
  relativeTo,
  smoothFrames,
  solveModel,
  unwrapDegrees,
  type Mat3,
  type MotionModel,
  type PlanarFrame,
  type PlanarTrack,
  type TrackingDirection,
  type TrackingState,
  type Vec2,
} from "./planar-math.js";
import { blit, createCanvas, drawCross, drawLabel, drawPolygon, encodePng, fitWithin, resizeArea, strokeRect, type RgbaImage } from "./png-utils.js";
import { checkPaths, type PathCheckResult } from "./path-check.js";
import { compToImgH, imgToCompH, pyramid, RegionAligner, RegionTracker, verdict, verdictWhy } from "./region-track.js";
import { fitScreenQuad, keyStrength, sampleKey, ScreenTracker, type ScreenKey } from "./screen-track.js";
import { beginInflight, endInflight, noteAfterWrite, noteBeforeWrite, type WriteInfo } from "./session.js";
import { boxBlurGray, makeWarpedTemplate, PointTracker, toGray, trackTimes, type GrayImage, type Template } from "./track.js";
import { expectThat, runGuardedWrite } from "./write-runner.js";

export type { MotionModel, PlanarFrame, PlanarTrack, Vec2, Mat3 } from "./planar-math.js";

// ---------- errors ----------

/** A refusal with a reason the caller can act on; the tools turn it into { ok: false, error, message }. */
export class PlanarError extends Error {
  constructor(readonly code: "bad_args" | "not_found" | "refused", message: string) {
    super(message);
    this.name = "PlanarError";
  }
}

const fail = (e: unknown) => ({ ok: false as const, error: (e as PlanarError).code, message: (e as Error).message });

const errMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
const r2 = (v: number): number => Math.round(v * 100) / 100;
const r4 = (v: number): number => Math.round(v * 10000) / 10000;
const yieldLoop = () => new Promise<void>((r) => setImmediate(r));

// ---------- the track store ----------

const TRACK_ID = /^[A-Za-z0-9_-]{1,80}$/;
const KEEP_TRACKS = 200;
/** Frames per track, in total. */
export const MAX_TRACK_FRAMES = 3000;
/** Keys per property one apply call writes. */
const MAX_KEYS = 3000;

export function tracksDir(): string {
  return path.join(path.dirname(defaultFramesDir()), "tracks");
}

export function newTrackId(): string {
  return `trk_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
}

/** Writes the track as <track_id>.json and drops all but the newest 200. Returns the file path. */
export function saveTrack(track: PlanarTrack): string {
  if (!TRACK_ID.test(track.track_id)) throw new Error(`Bad track id "${track.track_id}"`);
  const dir = tracksDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${track.track_id}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(track));
  fs.renameSync(tmp, file);
  try {
    const entries = fs
      .readdirSync(dir)
      .filter((n) => n.endsWith(".json"))
      .map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const old of entries.slice(KEEP_TRACKS)) fs.rmSync(path.join(dir, old.n), { force: true });
  } catch {
    // Pruning is housekeeping; a failure must not lose the track just saved.
  }
  return file;
}

export function loadTrack(trackId: string): PlanarTrack | null {
  if (!TRACK_ID.test(trackId)) return null;
  try {
    const t = JSON.parse(fs.readFileSync(path.join(tracksDir(), `${trackId}.json`), "utf8")) as PlanarTrack;
    if (t.version !== 1 || !Array.isArray(t.frames) || !Array.isArray(t.ref_points)) return null;
    return t;
  } catch {
    return null;
  }
}

export const trackFilePath = (trackId: string): string => path.join(tracksDir(), `${trackId}.json`);

// ---------- helpers other groups share ----------

/**
 * Maps undocumented effect parameters by their English display name, with an
 * index fallback. `params` is what the host listed for the effect. Each wanted
 * key gives the parameter index it resolved to, or null.
 */
export function resolveEffectParams(
  params: Array<{ index: number; name: string; matchName: string; type: string }>,
  wanted: Record<string, { names: string[]; index?: number }>
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  const norm = (s: string) => s.trim().toLowerCase();
  for (const [key, w] of Object.entries(wanted)) {
    const hit = params.find((p) => w.names.some((n) => norm(n) === norm(p.name)));
    if (hit) {
      out[key] = hit.index;
    } else if (w.index !== undefined && params.some((p) => p.index === w.index)) {
      out[key] = w.index;
    } else {
      out[key] = null;
    }
  }
  return out;
}

/** First estimate of Gaussian Blur's Blurriness for a Gaussian sigma in pixels; calibrate live and freeze it here. */
export const BLURRINESS_PER_SIGMA = 2.5;
export const blurrinessFromSigma = (sigmaPx: number): number => sigmaPx * BLURRINESS_PER_SIGMA;
export const sigmaFromBlurriness = (blurriness: number): number => blurriness / BLURRINESS_PER_SIGMA;

/** '<project folder>/<project name> chroma plates/', with a trailing separator. Refuses an unsaved project. */
export function platesFolderFor(projectPath: string): string {
  if (!projectPath || projectPath === "<unsaved>") {
    throw new PlanarError("refused", "The project has not been saved, so there is no folder to put plates next to. Save it first.");
  }
  const dir = path.dirname(projectPath);
  const name = path.basename(projectPath, path.extname(projectPath));
  return path.join(dir, `${name} chroma plates`) + path.sep;
}

/** At most `maxRenders` renders and `maxSeconds` per call, so no tool holds the queue for minutes. */
export function createRenderBudget(opts: { maxRenders: number; maxSeconds: number }): {
  spend(): void;
  exhausted(): boolean;
  readonly used: { renders: number; seconds: number };
} {
  const started = Date.now();
  let renders = 0;
  return {
    spend() {
      renders++;
    },
    exhausted() {
      return renders >= opts.maxRenders || (Date.now() - started) / 1000 >= opts.maxSeconds;
    },
    get used() {
      return { renders, seconds: r2((Date.now() - started) / 1000) };
    },
  };
}

// ---------- schemas ----------

const Point = z.array(z.number()).length(2);

export const RegionSchema = z.union([
  z.object({ rect: z.array(z.number()).length(4).describe("[x, y, width, height] in comp pixels.") }).strict(),
  z.object({ ellipse: z.array(z.number()).length(4).describe("[centre x, centre y, radius x, radius y] in comp pixels.") }).strict(),
  z.object({ polygon: z.array(Point).min(3).max(64).describe("Corners [[x, y], ...] in comp pixels.") }).strict(),
]);
export type Region = z.infer<typeof RegionSchema>;

const ModelEnum = z.enum(["translate", "similarity", "affine", "perspective"]);

export const TrackSourceSchema = z
  .object({
    track_id: z.string().min(1).max(80).optional().describe("A track from ae_track_multi or ae_track_read."),
    nulls: z.array(LayerSelectorSchema).min(1).max(8).optional().describe("1-8 layers (nulls from ae_track_point included) whose Position keys are the points. Parents are taken into account."),
    corner_pin: z
      .object({
        layer: LayerSelectorSchema,
        effect_index: z.number().int().min(1).optional().describe("1-based index of the effect. Default: the layer's first Corner Pin, else its first CC Power Pin."),
        effect: z.enum(["corner_pin", "power_pin"]).optional().describe("Which kind to look for. Default: either."),
      })
      .optional()
      .describe("The four points of a Corner Pin or CC Power Pin on this layer (what Mocha AE's 'Create Track Data' and AE's Perspective Corner Pin tracker leave), converted from the layer's own space to comp pixels."),
    tracker: z
      .object({
        layer: LayerSelectorSchema,
        tracker: z.string().optional().describe("Name of the tracker (default: the first)."),
        points: z.array(z.string()).max(8).optional().describe("Names of the track points to use (default: all, up to 8)."),
      })
      .optional()
      .describe("Track points the AE Tracker made on this layer (Feature Center keys), converted to comp pixels."),
    transform: z.object({ layer: LayerSelectorSchema }).optional().describe("The layer's own Position / Rotation / Scale keys (and its parents') as a similarity track of its four corners."),
    model: ModelEnum.optional().describe("Motion model to solve per frame. Default: translate for one point, similarity for more; perspective for a Corner Pin source."),
    ref_time: z.number().min(0).optional().describe("The reference frame (identity), in seconds. Default: a stored track (track_id) keeps its own ref_time; a source read from the project uses its first frame."),
    start: z.number().min(0).optional().describe("Read from this time. Default: the first key."),
    end: z.number().min(0).optional().describe("Read up to this time. Default: the last key."),
  })
  .refine((s) => [s.track_id, s.nulls, s.corner_pin, s.tracker, s.transform].filter((v) => v !== undefined).length === 1, {
    message: "Give exactly one of track_id, nulls, corner_pin, tracker or transform.",
  });
export type TrackSource = z.infer<typeof TrackSourceSchema>;

const APPLY_MODES = ["nulls", "corner_pin", "power_pin", "transform", "transform_pin"] as const;
export type ApplyMode = (typeof APPLY_MODES)[number];

const ApplyFields = {
  mode: z
    .enum(APPLY_MODES)
    .describe(
      "nulls: one null per tracked point (Position keys), plus one 'solved' null (Position, Rotation, Scale) with solved_null. " +
        "corner_pin / power_pin: add (or use) the effect on `layer` and key its four points in the layer's own space; layer motion blur does not apply to pin effects. " +
        "transform: Position / Rotation / Scale keys on `layer` so a similarity track drives the layer itself (layer motion blur works). " +
        "transform_pin: the similarity part on the layer transform plus the residual perspective in a Corner Pin, the scriptable version of Mocha's 'Corner Pin (Supports Motion Blur)'."
    ),
  layer: LayerSelectorSchema.optional().describe("The layer that gets the track. Needed for every mode but nulls. Must not be 3D or locked."),
  effect_index: z.number().int().min(1).optional().describe("Use this existing pin effect (1-based index) instead of the layer's first one."),
  add_effect: z.boolean().optional().describe("Add the pin effect when the layer has none. Default true. The effect is placed after colour, grain and blur effects added by other tools."),
  null_prefix: z.string().min(1).max(100).optional().describe("Name prefix of the new nulls. Default 'Track'."),
  solved_null: z.boolean().optional().describe("Nulls mode: also make one null with the solved Position, Rotation and Scale, for parenting. The tool never parents anything."),
  replace_keys: z.boolean().optional().describe("Replace keys already on the written properties. Without it existing keys refuse the write. Expressions always refuse."),
  range: z
    .object({ start: z.number().min(0), end: z.number().min(0) })
    .optional()
    .describe("Write only the frames in this time range (seconds). One call writes one span: keys already on the written properties refuse the write, and replace_keys removes ALL keys on them, not only the span's. A track holds at most 3000 frames."),
  refit_model: ModelEnum.optional().describe(
    "Solve every frame again from the tracked points with this model before writing, without tracking again. A model with fewer parameters holds a surface the points cover only partly much more steadily (perspective on points in a thin band swings the corners by tens of px); the track summary's model_advice says when and which. The adjusted track is saved under a new track_id (track_adjusted)."
  ),
  smooth_frames: z
    .number()
    .min(0)
    .max(30)
    .optional()
    .describe("Smooth the surface's motion before writing: a Gaussian of this many frames (sigma) over the corner paths, then each frame is solved again. 1-2 takes out frame-to-frame shake and keeps the motion; more lags fast moves. Per-point nulls keep their tracked positions. Saved under a new track_id like refit_model."),
};

export const ApplyTargetSchema = z.object(ApplyFields).refine((v) => v.mode === "nulls" || v.layer !== undefined, { message: "Give `layer` for every mode but nulls." });
export type ApplyTarget = z.infer<typeof ApplyTargetSchema>;

export const AeTrackApplySchema = z
  .object({
    comp_id: z.number().int(),
    track: TrackSourceSchema.describe("The track to write: a stored track_id or any source ae_track_read takes."),
    ref_time: z.number().min(0).optional().describe("The frame where the target looks right (seconds): the track is re-based so this frame is the identity. Default: the track's own reference frame."),
    ...ApplyFields,
    expect: ExpectSchema,
  })
  .refine((v) => v.mode === "nulls" || v.layer !== undefined, { message: "Give `layer` for every mode but nulls." });

export const AeTrackReadSchema = z.object({
  comp_id: z.number().int(),
  source: TrackSourceSchema.describe("Where the track is. A source of type track_id just loads a stored track."),
  preview: z.boolean().default(true).describe("Write a contact sheet of the first, reference and last frame with the point paths. Default true."),
});

export const AeTrackMultiSchema = z
  .object({
    comp_id: z.number().int(),
    points: z.array(Point).min(1).max(8).optional().describe("1-8 features to follow, [x, y] in comp pixels at ref_time. Corners and marks, not flat areas, and all on ONE plane or the pattern slides (parallax)."),
    auto_points: z
      .object({
        region: RegionSchema.describe("Where to look for points."),
        exclude: z.array(RegionSchema).max(8).optional().describe("Regions to keep points out of, such as the object being removed (grown by the pattern size)."),
        count: z.number().int().min(1).max(8).default(6).describe("How many points. Default 6."),
        min_distance_px: z.number().min(4).max(4000).optional().describe("Least distance between points in comp pixels. Default: a tenth of the region's longer side."),
      })
      .optional()
      .describe("Let the tool pick the points: Shi-Tomasi corners on the slightly blurred reference frame inside `region` minus `exclude`, spread out, each passing the tracker's contrast test. The chosen points are returned."),
    region: z
      .object({
        area: RegionSchema.describe("The flat surface to follow, in comp pixels at ref_time: all of it (a sign, a wall, a painting, a phone or laptop screen with its bezel), not a few spots on it. A polygon [UL, UR, LR, LL] is also the quad written by ae_track_apply."),
        exclude: z.array(RegionSchema).max(8).optional().describe("Parts of the area that do not move with it: a reflection, a hole, something attached that moves on its own. People and objects crossing in front need no exclude."),
      })
      .optional()
      .describe(
        "Follow the surface by all of its textured pixels instead of a few points (the default choice for a textured planar surface): every frame is aligned to the reference frame's area (perspective, no drift); anything crossing in front is pushed out of the fit and remembered on the next frame. Every frame is checked against the surface and one that does not line up is reported, not keyed. Refused on a flat area (a plain green screen): use points on its markers or corners."
      ),
    screen: z
      .object({
        corners: z.array(Point).length(4).describe("The screen's corners [UL, UR, LR, LL] in comp pixels at ref_time, where the key colour ends. A few pixels off is fine: they are snapped to the key edge first (the snapped ones come back)."),
      })
      .optional()
      .describe(
        "Follow a keyable screen (a green or blue phone, laptop, monitor or board) by its outline: the key colour is read inside the corners at ref_time, and every frame each side's key edge is fitted as a line (sub-pixel; a hand crossing a side takes out only its own stretch) and the corners are where the lines meet. For a plain screen with nothing inside to track. Refused when the inside is not one saturated colour."
      ),
    continue_track_id: z.string().min(1).max(80).optional().describe("Resume a track that returned `next`: the tool carries on from the stored state."),
    ref_time: z.number().min(0).optional().describe("The reference frame in seconds, where `points` / `auto_points` apply. Default: the comp's current time if it is inside the range, else the middle of the work area."),
    start: z.number().min(0).optional().describe("First time to track back to. Default: the work area start."),
    end: z.number().min(0).optional().describe("Last time to track to. Default: the work area end."),
    model: ModelEnum.optional().describe("Motion model solved per frame from the surviving points: translate (1+ points), similarity (2+: position, rotation, uniform scale), affine (3+), perspective (4+; 5-8 points on one plane give redundancy, RANSAC from 6). Default: translate for one point, similarity otherwise."),
    pattern_size: z.number().int().min(9).max(201).default(31).describe("Side of each point's square pattern in comp pixels. Default 31."),
    search_radius: z.number().int().min(2).max(100).default(40).describe("How far (px) from the predicted position to look each frame. Default 40; raise it for fast motion (cost grows with its square)."),
    min_confidence: z.number().min(0).max(1).default(0.6).describe("Below this match score (0..1) a point counts as lost for the frame. Default 0.6."),
    warp_patterns: z.boolean().optional().describe("Re-sample each pattern through the local affine of the motion so far, so rotation and zoom do not kill the match. Default on for similarity, affine and perspective."),
    pre_blur: z.number().int().min(0).max(3).optional().describe("Box blur radius (px) on the gray frame, for grainy plates. Default 0."),
    channel: z.enum(["luma", "red", "green", "blue", "saturation"]).default("luma").describe("Which channel to track. Default luma."),
    quad: z.array(Point).length(4).optional().describe("The surface's corners [UL, UR, LR, LL] in comp pixels at ref_time, drawn in the preview as it moves. Default: the bounding box of the points."),
    isolate_layers: z
      .array(LayerSelectorSchema)
      .min(1)
      .max(100)
      .optional()
      .describe("Track only these layers (the plate): a temporary copy of the comp with every other layer off is rendered, so patches and overlays above the plate cannot corrupt the track. The copy is removed in the same call (two undo entries). Needs `expect`."),
    max_frames: z.number().int().min(1).max(1000).default(250).describe("Most frames (renders) in one call. Default 250. When it runs out the result has `next` and `continue_track_id`. After a panel restart a continued call first renders the reference frame again; that one render is not counted here and is reported as `budget.rebuild_renders`."),
    max_seconds: z.number().min(5).max(300).default(90).describe("Most seconds of rendering in one call. Default 90. A continued call that had to rebuild its reference frame still tracks at least one frame, even if that rebuild used up this limit."),
    preview: z.boolean().default(true).describe("Write a contact sheet of the first, reference and last frame of this call with point paths, pattern boxes and the surface quad. Default true."),
    apply: ApplyTargetSchema.optional().describe("Write the finished track like ae_track_apply, once the last chunk is done. Needs `expect`."),
    expect: ExpectSchema.optional().describe("Needed with isolate_layers or apply."),
  })
  .refine((v) => [v.points, v.auto_points, v.region, v.screen, v.continue_track_id].filter((x) => x !== undefined).length === 1, {
    message: "Give exactly one of points, auto_points, region, screen or continue_track_id.",
  })
  .refine((v) => (v.isolate_layers === undefined && v.apply === undefined) || v.expect !== undefined, {
    message: "isolate_layers and apply write to the project, so `expect` is required.",
  });

export type AeTrackMultiArgs = z.infer<typeof AeTrackMultiSchema>;
export type AeTrackApplyArgs = z.infer<typeof AeTrackApplySchema>;
export type AeTrackReadArgs = z.infer<typeof AeTrackReadSchema>;

// ---------- queue and host plumbing ----------

async function queued<T>(ctx: ToolContext, label: string, opId: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await ctx.queue.run(label, fn);
  } catch (err) {
    if (err instanceof QueueWaitError) throw new BridgeError({ kind: "queued", op_id: opId, message: err.message });
    throw err;
  }
}

interface CompInfo {
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
  layers: Array<{ index: number; id: number; name: string; locked: boolean; enabled: boolean; three_d: boolean }>;
}

/** A read-only host call inside a queue lease the caller already holds. */
async function read<T>(ctx: ToolContext, opId: string, tag: string, host: string, args: unknown, toolName: string, slow = false): Promise<T> {
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

async function readComp(ctx: ToolContext, opId: string, compId: number, layers: LayerSelector[] | undefined, toolName: string): Promise<CompInfo> {
  const info = await read<CompInfo>(ctx, opId, "comp", "planarComp", { comp_id: compId, ...(layers ? { layers } : {}) }, toolName);
  if (Number(info.pixel_aspect) > 0 && Math.abs(Number(info.pixel_aspect) - 1) > 1e-6) {
    throw new PlanarError("refused", `The comp's pixel aspect is ${info.pixel_aspect}, not 1. Planar tracking works on square pixels only.`);
  }
  return info;
}

const snapFrame = (t: number, fps: number): number => Math.round(t * fps) / fps;

// ---------- layer space ----------

interface HostLayerSample {
  time: number;
  anchor: Vec2;
  position: Vec2;
  scale: Vec2;
  rotation: number;
  parent_chain: Array<{ anchor: Vec2; position: Vec2; scale: Vec2; rotation: number }>;
  three_d: boolean;
}

export interface LayerSample {
  time: number;
  anchor: Vec2;
  position: Vec2;
  scale_pct: Vec2;
  rotation_deg: number;
  /** Parent px -> comp px (identity without parents). */
  parents: Mat3;
  /** Layer px -> comp px. */
  full: Mat3;
}

export function layerSampleOf(raw: HostLayerSample): LayerSample {
  const own = layerMatrix({ anchor: raw.anchor, position: raw.position, scale_pct: raw.scale, rotation_deg: raw.rotation });
  let parents = identityH();
  // The chain lists the parent first, then its parent: each one applies after the last.
  for (const p of raw.parent_chain) parents = mulH(layerMatrix({ anchor: p.anchor, position: p.position, scale_pct: p.scale, rotation_deg: p.rotation }), parents);
  return { time: raw.time, anchor: raw.anchor, position: raw.position, scale_pct: raw.scale, rotation_deg: raw.rotation, parents, full: mulH(parents, own) };
}

async function readLayerSpace(
  ctx: ToolContext,
  opId: string,
  tag: string,
  compId: number,
  layer: { index: number; id: number },
  times: number[],
  toolName: string
): Promise<{ samples: LayerSample[]; width: number; height: number }> {
  try {
    const res = await read<{ samples: HostLayerSample[]; width?: number; height?: number }>(
      ctx,
      opId,
      tag,
      "planarLayerSpace",
      { comp_id: compId, layer: { index: layer.index, id: layer.id }, times },
      toolName,
      times.length > 200
    );
    if (res.samples.some((s) => s.three_d)) {
      throw new BridgeError({ kind: "guard", op_id: opId, message: "The layer is a 3D layer; planar tracks work in 2D only." });
    }
    return { samples: res.samples.map(layerSampleOf), width: Number(res.width), height: Number(res.height) };
  } catch (err) {
    if (err instanceof BridgeError && err.kind !== "guard" && /3D layer/.test(err.message)) {
      throw new BridgeError({ kind: "guard", op_id: opId, message: err.message });
    }
    throw err;
  }
}

/** Layer px -> comp px per time, parents included. Call inside a queue lease. Throws a guard-kind BridgeError for 3D layers. */
export async function layerSpaceMatrices(ctx: ToolContext, opId: string, compId: number, layer: { index: number; id: number }, times: number[]): Promise<Mat3[]> {
  const got = await readLayerSpace(ctx, opId, "layerspace", compId, layer, times, "layerSpaceMatrices");
  return got.samples.map((s) => s.full);
}

// ---------- isolating the plate ----------

/**
 * Runs `fn` against a temporary copy of the comp in which only `showLayers`
 * are on, and removes the copy afterwards, in a finally: it never stays behind,
 * and a failed removal is reported. With showLayers null the comp itself is
 * used and nothing is made. Call it inside a queue lease, after the guard and
 * checkpoint (the host checks the guard again). `note` registers the write with
 * the session tracker while the copy exists (so the hook skips the two writes); a caller
 * passing `note` must itself call noteBeforeWrite(ctx, note) before and
 * noteAfterWrite(ctx, note, { addStep: true }) after, or the writes are never logged.
 */
export async function withIsolatedPlate<T>(
  ctx: ToolContext,
  opId: string,
  a: { compId: number; showLayers: Array<{ index: number; id: number }> | null; expect: ExpectGuard; toolName?: string; note?: WriteInfo },
  fn: (renderCompId: number) => Promise<T>
): Promise<{ value: T; temp: { copy_id: number; removed: boolean; error?: string } | null }> {
  if (!a.showLayers) return { value: await fn(a.compId), temp: null };
  const toolName = a.toolName ?? "planar";
  if (a.note) beginInflight(a.note);
  // Each evalScript that writes is registered under its own id: the session hook then leaves it alone
  // (it would otherwise snapshot around it, log an unguarded agent write and re-report the user's changes).
  const isolateId = `${opId}_isolate`;
  const unisolateId = `${opId}_unisolate`;
  let copyId: number | undefined;
  let value: T | undefined;
  let thrown: unknown = null;
  let failed = false;
  try {
    if (a.note) beginInflight({ ...a.note, opId: isolateId });
    let begin: Awaited<ReturnType<typeof ctx.bridge.evalRaw<{ copy_id?: number }>>>;
    try {
      begin = await ctx.bridge.evalRaw<{ copy_id?: number }>({
        id: isolateId,
        script: buildJsxCall("planarIsolateBegin", { comp_id: a.compId, show_layers: a.showLayers, expect: a.expect }),
        label: `${toolName} isolate plate`,
        mutates: true,
        toolName,
      });
    } finally {
      if (a.note) endInflight(isolateId);
    }
    copyId = begin.result?.copy_id;
    if (typeof copyId !== "number") throw new Error("AE returned no id for the temporary comp, so nothing was rendered");
    value = await fn(copyId);
  } catch (err) {
    failed = true;
    thrown = err;
  }
  let removed = false;
  let error: string | undefined;
  if (typeof copyId === "number") {
    if (a.note) beginInflight({ ...a.note, opId: unisolateId });
    try {
      const end = await ctx.bridge.evalRaw<{ removed?: boolean }>({
        id: unisolateId,
        script: buildJsxCall("planarIsolateEnd", { copy_id: copyId, expect: a.expect }),
        label: `${toolName} remove plate copy`,
        mutates: true,
        mustSend: true,
        toolName,
      });
      removed = end.result?.removed === true;
    } catch (err) {
      error = errMessage(err);
    } finally {
      if (a.note) endInflight(unisolateId);
    }
  }
  if (a.note) endInflight(a.note.opId);
  if (failed) {
    if (error && thrown instanceof Error) thrown.message += ` (The temporary comp ${copyId} could not be removed either: ${error}. Delete it in the Project panel; its name starts with "_chroma_plate_".)`;
    // Whoever catches this needs to know whether the copy was made and whether it is gone.
    if (typeof copyId === "number" && thrown && typeof thrown === "object") {
      (thrown as { plateTemp?: unknown }).plateTemp = { copy_id: copyId, removed, ...(error ? { error } : {}) };
    }
    throw thrown;
  }
  return { value: value as T, temp: { copy_id: copyId as number, removed, ...(error ? { error } : {}) } };
}

/**
 * Reads, in a call of its own, whether the temporary comp is gone, and corrects
 * `temp` when the project still holds it. Call it inside the queue lease, after
 * withIsolatedPlate. Changes nothing in the project. When the read fails, `temp`
 * is returned as it was, with read_back false.
 */
export async function verifyPlateGone(
  ctx: ToolContext,
  opId: string,
  temp: { copy_id: number; removed: boolean; error?: string },
  toolName: string
): Promise<{ copy_id: number; removed: boolean; error?: string; read_back: boolean }> {
  try {
    const res = await read<{ exists?: boolean }>(ctx, opId, "platecheck", "planarItemExists", { item_id: temp.copy_id }, toolName);
    if (res.exists === true) {
      return { ...temp, removed: false, error: temp.error ?? "the temporary comp is still in the project after its removal", read_back: true };
    }
    return { copy_id: temp.copy_id, removed: true, read_back: true };
  } catch {
    return { ...temp, read_back: false };
  }
}

// ---------- tracks from sampled points ----------

function defaultModel(kind: string, n: number): MotionModel {
  if (kind === "corner_pin" || kind === "power_pin") return "perspective";
  if (kind === "transform") return "similarity";
  return n <= 1 ? "translate" : "similarity";
}

/**
 * Builds a track from per-time point positions in comp px: H(t) solves
 * the model from the reference frame's points to the frame's. The reference
 * frame is the identity by definition.
 */
export function trackFromSeries(a: {
  compId: number;
  compSize: Vec2;
  fps: number;
  times: number[];
  series: Vec2[][];
  confidence?: Array<Array<number | null>>;
  model: MotionModel;
  refTime?: number;
  source: string;
  trackId?: string;
}): PlanarTrack {
  const n = a.series[0]?.length ?? 0;
  if (a.times.length === 0 || n === 0) throw new PlanarError("not_found", "The source has no frames or no points.");
  if (n < MODEL_MIN_POINTS[a.model]) {
    throw new PlanarError("bad_args", `The ${a.model} model needs at least ${MODEL_MIN_POINTS[a.model]} points and the source has ${n}. Choose a simpler model.`);
  }
  let refIdx = 0;
  if (a.refTime !== undefined) {
    let best = Infinity;
    a.times.forEach((t, i) => {
      if (Math.abs(t - a.refTime!) < best) {
        best = Math.abs(t - a.refTime!);
        refIdx = i;
      }
    });
  }
  const refPoints = a.series[refIdx];
  let confMax = 0;
  for (const row of a.confidence ?? []) for (const v of row) if (v !== null && v > confMax) confMax = v;
  const confScale = confMax > 1.5 ? 100 : 1;
  const frames: PlanarFrame[] = a.times.map((t, i) => {
    const pts = a.series[i];
    const conf = pts.map((_, k) => {
      const v = a.confidence?.[i]?.[k];
      return v === null || v === undefined ? null : Math.min(1, Math.max(0, v / confScale));
    });
    if (i === refIdx) return { time: t, ok: true, H: identityH(), points: pts, confidence: conf, rms_px: 0, expected_px: 0, inliers: n };
    const sol = solveModel(a.model, refPoints, pts);
    if (!sol) return { time: t, ok: false, H: null, points: pts, confidence: conf, rms_px: null, inliers: 0, note: "the points are degenerate at this frame (coincident or collinear)" };
    const ex = expectedError(a.model, sol.H, refPoints, pts, quadGrid(boundingQuad(refPoints)));
    return { time: t, ok: true, H: sol.H, points: pts, confidence: conf, rms_px: r4(sol.rms_px), expected_px: ex ? r4(ex.mean_px) : null, inliers: n };
  });
  return {
    version: 1,
    track_id: a.trackId ?? newTrackId(),
    comp_id: a.compId,
    comp_size: a.compSize,
    fps: a.fps,
    ref_time: a.times[refIdx],
    model: a.model,
    ref_points: refPoints,
    frames,
    source: a.source,
    created: new Date().toISOString(),
  };
}

interface HostReadResult {
  kind: string;
  comp: { width: number; height: number; fps: number };
  names: string[];
  times: number[];
  series: Vec2[][];
  confidence?: Array<Array<number | null>>;
  truncated: boolean;
  keyed_frames: number;
  interpolated_frames: number;
  off_grid_keys: number;
  expression_driven: string[];
  param_table?: unknown;
  effect?: unknown;
  layer?: unknown;
}

/** What the host needs to read a source, and a label for the track. */
function hostSourceOf(src: TrackSource): { source: Record<string, unknown>; label: string } {
  const span = { ...(src.start !== undefined ? { start: src.start } : {}), ...(src.end !== undefined ? { end: src.end } : {}) };
  if (src.nulls) return { source: { kind: "nulls", layers: src.nulls, ...span }, label: "nulls" };
  if (src.corner_pin) return { source: { kind: "corner_pin", ...src.corner_pin, ...span }, label: "corner_pin" };
  if (src.tracker) return { source: { kind: "tracker", ...src.tracker, ...span }, label: "tracker" };
  return { source: { kind: "transform", ...src.transform, ...span }, label: "transform" };
}

/**
 * Turns a track source into a PlanarTrack (not saved). A stored track is
 * loaded; anything else is read from the project, read-only, sampled on the
 * frame grid and solved with the requested model. Call it INSIDE ctx.queue.run.
 */
export async function resolveTrackSource(ctx: ToolContext, opId: string, compId: number, src: TrackSource): Promise<PlanarTrack> {
  return (await resolveTrackSourceWithInfo(ctx, opId, compId, src)).track;
}

/** resolveTrackSource, plus what the read found (interpolated frames, off-grid keys, the pin parameter table). */
export async function resolveTrackSourceWithInfo(
  ctx: ToolContext,
  opId: string,
  compId: number,
  src: TrackSource
): Promise<{ track: PlanarTrack; info: Record<string, unknown> | null }> {
  if (src.track_id) {
    const t = loadTrack(src.track_id);
    if (!t) throw new PlanarError("not_found", `No stored track "${src.track_id}" (the store keeps the newest ${KEEP_TRACKS}).`);
    return { track: src.ref_time !== undefined ? relativeTo(t, src.ref_time) : t, info: null };
  }
  const { source, label } = hostSourceOf(src);
  const got = await read<HostReadResult>(ctx, opId, "trackread", "planarRead", { comp_id: compId, source }, "ae_track_read", true);
  const n = got.series[0]?.length ?? 0;
  const model = src.model ?? defaultModel(got.kind, n);
  const track = trackFromSeries({
    compId,
    compSize: [got.comp.width, got.comp.height],
    fps: got.comp.fps,
    times: got.times,
    series: got.series,
    confidence: got.confidence,
    model,
    refTime: src.ref_time,
    source: `read:${label}`,
  });
  return { track, info: readInfo(got) };
}

function readInfo(got: HostReadResult): Record<string, unknown> {
  return {
    names: got.names,
    truncated: got.truncated,
    keyed_frames: got.keyed_frames,
    interpolated_frames: got.interpolated_frames,
    off_grid_keys: got.off_grid_keys,
    expression_driven: got.expression_driven,
    ...(got.param_table ? { param_table: got.param_table } : {}),
    ...(got.effect ? { effect: got.effect } : {}),
    ...(got.layer ? { layer: got.layer } : {}),
  };
}

// ---------- the multi-point tracker (pure given frames) ----------

export interface MultiTrackOptions {
  model: MotionModel;
  /** Pattern side in comp px. */
  patchSize: number;
  /** Search radius in comp px. */
  searchRadius: number;
  minConfidence: number;
  warpPatterns: boolean;
  /** RANSAC inlier distance in comp px. */
  ransacPx: number;
  seed: number;
}

export interface StepResult {
  frame: PlanarFrame | null;
  stop: "lost" | "cut" | null;
  lost: number[];
  reacquired: number[];
}

/**
 * Steps every point on the SAME decoded frame (one render per frame), solves
 * the model from the survivors, and re-acquires lost or outlying points with
 * their reference pattern around where the solved motion puts them. Points are
 * in comp px; `scale` maps them onto the decoded image (image px per comp px).
 */
export class MultiTracker {
  readonly dropped: Array<{ index: number; reason: string }> = [];
  private readonly trackers: Array<PointTracker | null> = [];
  private readonly imgRef: Vec2[];
  private readonly patchImg: number;
  lastH: Mat3 = identityH();
  readonly prevH: Mat3 | null = null;
  /** Per point: was it found on the previous frame? A cut is judged on these only. */
  private readonly prevFound: boolean[] = [];

  constructor(
    private readonly refGray: GrayImage,
    readonly refPoints: Vec2[],
    readonly scale: number,
    private readonly opts: MultiTrackOptions,
    private readonly quad: Vec2[]
  ) {
    this.patchImg = Math.max(9, Math.round(opts.patchSize * scale) | 1);
    this.imgRef = refPoints.map((p) => this.toImg(p));
    this.prevFound = refPoints.map(() => true);
    refPoints.forEach((_, i) => {
      try {
        this.trackers.push(
          new PointTracker(refGray, this.imgRef[i][0], this.imgRef[i][1], {
            patchSize: this.patchImg,
            searchRadius: Math.max(2, Math.round(opts.searchRadius * scale)),
            minConfidence: opts.minConfidence,
            adaptBelow: 0.8,
          })
        );
      } catch (err) {
        this.trackers.push(null);
        this.dropped.push({ index: i, reason: errMessage(err) });
      }
    });
  }

  toImg(p: Vec2): Vec2 {
    return [p[0] * this.scale - 0.5, p[1] * this.scale - 0.5];
  }

  toComp(x: number, y: number): Vec2 {
    return [(x + 0.5) / this.scale, (y + 0.5) / this.scale];
  }

  get alive(): number {
    return this.trackers.filter((t) => t !== null).length;
  }

  /** Puts the trackers back where an earlier chunk left them (after a restart or when moving on). */
  restore(lastPoints: Array<Vec2 | null>, lastH: Mat3): void {
    lastPoints.forEach((p, i) => {
      this.prevFound[i] = p !== null;
      const t = this.trackers[i];
      if (t && p) {
        const q = this.toImg(p);
        t.relocate(q[0], q[1]);
      }
    });
    this.lastH = lastH;
  }

  private warped(i: number): Template | undefined {
    if (!this.opts.warpPatterns || this.opts.model === "translate") return undefined;
    const j = jacobianAt(this.lastH, this.refPoints[i]);
    if (!j) return undefined;
    const dev = Math.max(Math.abs(j[0] - 1), Math.abs(j[1]), Math.abs(j[2]), Math.abs(j[3] - 1));
    if (dev < 0.03) return undefined;
    const tpl = makeWarpedTemplate(this.refGray, this.imgRef[i][0], this.imgRef[i][1], this.patchImg, [j[0], j[1], 0, j[2], j[3], 0]);
    return tpl && tpl.std >= 3 ? tpl : undefined;
  }

  private solve(idx: number[], pos: Array<Vec2 | null>): { H: Mat3; inliers: boolean[]; rms_px: number } | null {
    const model = this.opts.model;
    const m = MODEL_MIN_POINTS[model];
    const from = idx.map((i) => this.refPoints[i]);
    const to = idx.map((i) => pos[i] as Vec2);
    if (idx.length >= m + 2) return ransacModel(model, from, to, { thresholdPx: this.opts.ransacPx, iterations: 60, seed: this.opts.seed });
    const s = solveModel(model, from, to);
    return s ? { H: s.H, inliers: idx.map(() => true), rms_px: s.rms_px } : null;
  }

  step(gray: GrayImage, time: number): StepResult {
    const n = this.refPoints.length;
    const pos: Array<Vec2 | null> = new Array<Vec2 | null>(n).fill(null);
    const conf: Array<number | null> = new Array<number | null>(n).fill(null);
    const alive: number[] = [];
    this.trackers.forEach((t, i) => {
      if (t) alive.push(i);
    });
    const lost: number[] = [];
    // Where each tracker stood before this frame: a point the fit votes out is stepped again from there, so its velocity stays the frame-to-frame motion.
    const before = new Map<number, { x: number; y: number; vx: number; vy: number }>();
    for (const i of alive) before.set(i, this.trackers[i]!.motion);
    for (const i of alive) {
      const s = this.trackers[i]!.step(gray, undefined, this.warped(i));
      if (s) {
        pos[i] = this.toComp(s.x, s.y);
        conf[i] = s.confidence;
      } else {
        lost.push(i);
      }
    }
    // Most of the points that were found on the last frame gone on this one: a cut, not an occlusion.
    // Points already lost on earlier frames do not count (an occluder covering them one by one is not a cut).
    const wasFound = alive.filter((i) => this.prevFound[i]);
    const freshLost = lost.filter((i) => this.prevFound[i]);
    if (wasFound.length >= 2 && freshLost.length >= Math.ceil(wasFound.length * 0.75)) return { frame: null, stop: "cut", lost, reacquired: [] };
    const survivors = alive.filter((i) => pos[i] !== null);
    if (survivors.length < MODEL_MIN_POINTS[this.opts.model]) return { frame: null, stop: "lost", lost, reacquired: [] };

    let sol = this.solve(survivors, pos);
    if (!sol) {
      return {
        frame: { time, ok: false, H: null, points: pos, confidence: conf, rms_px: null, inliers: 0, note: "the model could not be solved (points collinear, coincident or inconsistent)" },
        stop: null,
        lost,
        reacquired: [],
      };
    }
    // Points that were lost, or that the robust fit voted out, get another try where the motion says they are.
    const redo = [...lost, ...survivors.filter((_, k) => !sol!.inliers[k])];
    const reacquired: number[] = [];
    for (const i of redo) {
      const pred = applyH(sol.H, this.refPoints[i]);
      if (!pred) continue;
      const ip = this.toImg(pred);
      if (pos[i] !== null) this.trackers[i]!.restoreMotion(before.get(i)!);
      const s = this.trackers[i]!.step(gray, { x: ip[0], y: ip[1] }, this.warped(i));
      if (s) {
        pos[i] = this.toComp(s.x, s.y);
        conf[i] = s.confidence;
        reacquired.push(i);
      } else {
        pos[i] = null;
        conf[i] = null;
        this.trackers[i]!.relocate(ip[0], ip[1]);
      }
    }
    if (redo.length > 0) {
      const now = alive.filter((i) => pos[i] !== null);
      if (now.length >= MODEL_MIN_POINTS[this.opts.model]) {
        const again = this.solve(now, pos);
        if (again) {
          sol = again;
          survivors.length = 0;
          survivors.push(...now);
        }
      }
    }
    for (const i of alive) this.prevFound[i] = pos[i] !== null;
    const inliers = sol.inliers.filter(Boolean).length;
    // The surface quad must stay a quad: convex, not folded, not collapsed.
    let ok = true;
    let note: string | undefined;
    const warped = this.quad.map((p) => applyH(sol!.H, p));
    if (warped.some((p) => p === null)) {
      ok = false;
      note = "the surface quad lands behind the plane at infinity";
    } else {
      const q = quadCheck(warped as Vec2[]);
      if (!q.ok) {
        ok = false;
        note = `the surface quad is degenerate: ${q.reason}`;
      }
    }
    if (ok) this.lastH = sol.H;
    const fit = survivors.filter((_, k) => sol!.inliers[k]);
    const ex = expectedError(this.opts.model, sol.H, fit.map((i) => this.refPoints[i]), fit.map((i) => pos[i] as Vec2), quadGrid(this.quad));
    return {
      frame: { time, ok, H: ok ? sol.H : null, points: pos, confidence: conf, rms_px: r4(sol.rms_px), expected_px: ex ? r4(ex.mean_px) : null, inliers, ...(note ? { note } : {}) },
      stop: null,
      lost: alive.filter((i) => pos[i] === null),
      reacquired,
    };
  }
}

// ---------- one direction of a track, by points or by region ----------

/** What ae_track_multi steps through a chunk: a point tracker or a region tracker, in comp px. */
export interface DirectionTracker {
  /** `rgba` is the frame as rendered (the screen tracker keys its colour). */
  step(gray: GrayImage, time: number, rgba?: RgbaImage): StepResult;
  /** The last good motion, comp px. */
  readonly lastH: Mat3;
  /** The good motion before it, when the tracker keeps one (a region track's speed). */
  readonly prevH: Mat3 | null;
}

/** Unverified (or unaligned) frames in a row after which a direction stops as lost: two seconds, at least 12 frames. */
export const maxMissesFor = (fps: number): number => Math.max(12, Math.round(2 * (fps > 0 ? fps : 25)));

/**
 * A region track as a direction: RegionTracker in image px, frames in comp px. The quad's corners are the
 * track's points (what the nulls mode writes); confidence is the frame's correlation.
 */
export class RegionDirection implements DirectionTracker {
  private readonly rt: RegionTracker;

  constructor(
    aligner: RegionAligner,
    private readonly quad: Vec2[],
    private readonly scale: number,
    private readonly maxMisses: number
  ) {
    this.rt = new RegionTracker(
      aligner,
      quad.map((p) => [p[0] * scale - 0.5, p[1] * scale - 0.5] as Vec2)
    );
  }

  get lastH(): Mat3 {
    return imgToCompH(this.rt.Hprev, this.scale);
  }

  get prevH(): Mat3 | null {
    return imgToCompH(this.rt.Hprev2, this.scale);
  }

  restore(last: Mat3, prev: Mat3 | null): void {
    this.rt.restore(compToImgH(last, this.scale), prev ? compToImgH(prev, this.scale) : null);
  }

  step(gray: GrayImage, time: number): StepResult {
    const r = this.rt.step(gray);
    if (!r.ok && r.misses >= this.maxMisses) return { frame: null, stop: "lost", lost: [], reacquired: [] };
    const H = r.ok ? imgToCompH(r.H, this.scale) : null;
    const points = this.quad.map((p) => (H ? applyH(H, p) : null));
    const conf = r.ok && r.ncc !== null ? r4(r.ncc) : null;
    return {
      frame: {
        time,
        ok: r.ok,
        H,
        points,
        confidence: points.map(() => conf),
        rms_px: null,
        expected_px: r.ok && r.expected_px !== null ? r4(r.expected_px / this.scale) : null,
        inliers: r.ok ? this.quad.length : 0,
        ncc: r.ncc === null ? null : r4(r.ncc),
        coverage: r.coverage === null ? null : r4(r.coverage),
        ...(r.ok ? {} : { note: r.note ?? "the region could not be aligned" }),
      },
      stop: null,
      lost: [],
      reacquired: [],
    };
  }
}

/**
 * The point tracker with every solved frame checked against the surface (`aligner`'s area): the frame's
 * motion is the start of a short region alignment (from the second pyramid level), and a frame that does
 * not line up is reported (ok false, a note) instead of being written: the points can all agree on a wrong
 * place (a person walking through a truck's lettering took 6 of 8 points with her). With a perspective
 * model the aligned motion replaces the points' one, which is closer (0.15 px against 0.35 on a licence
 * plate); with fewer parameters the points' motion stays and the check is only a check.
 */
export class VerifiedPoints implements DirectionTracker {
  private prior: Float32Array[] | null = null;
  misses = 0;
  readonly prevH = null;

  constructor(
    readonly mt: MultiTracker,
    private readonly aligner: RegionAligner,
    private readonly scale: number,
    private readonly refine: boolean,
    private readonly maxMisses: number
  ) {}

  get lastH(): Mat3 {
    return this.mt.lastH;
  }

  step(gray: GrayImage, time: number): StepResult {
    const before = this.mt.lastH;
    const res = this.mt.step(gray, time);
    const f = res.frame;
    if (res.stop || !f || !f.ok || !f.H) return res;
    const pyr = pyramid(gray, this.aligner.levels.length);
    const a = this.aligner.align(pyr, compToImgH(f.H, this.scale), this.prior, Math.min(1, this.aligner.levels.length - 1));
    if ("failed" in a || !verdict(a)) {
      this.mt.lastH = before;
      f.ok = false;
      f.H = null;
      f.note = `unverified: ${"failed" in a ? a.failed : verdictWhy(a)}`;
      if (!("failed" in a)) {
        f.ncc = r4(a.ncc);
        f.coverage = r4(a.coverage);
      }
      this.misses++;
      if (this.misses >= this.maxMisses) return { frame: null, stop: "lost", lost: res.lost, reacquired: res.reacquired };
      return res;
    }
    this.misses = 0;
    this.prior = a.weights;
    f.ncc = r4(a.ncc);
    f.coverage = r4(a.coverage);
    if (this.refine) {
      const Hr = imgToCompH(a.H, this.scale);
      f.H = Hr;
      this.mt.lastH = Hr;
    }
    return res;
  }
}

/** A screen track as a direction: ScreenTracker in image px, frames in comp px; the screen's corners are the points. */
export class ScreenDirection implements DirectionTracker {
  private readonly st: ScreenTracker;

  constructor(
    key: ScreenKey,
    private readonly quad: Vec2[],
    private readonly scale: number,
    private readonly maxMisses: number
  ) {
    this.st = new ScreenTracker(
      key,
      quad.map((p) => [p[0] * scale - 0.5, p[1] * scale - 0.5] as Vec2),
      Math.max(6, Math.round(12 * scale))
    );
  }

  get lastH(): Mat3 {
    return imgToCompH(this.st.Hprev, this.scale);
  }

  get prevH(): Mat3 | null {
    return imgToCompH(this.st.Hprev2, this.scale);
  }

  restore(last: Mat3, prev: Mat3 | null): void {
    this.st.restore(compToImgH(last, this.scale), prev ? compToImgH(prev, this.scale) : null);
  }

  step(_gray: GrayImage, time: number, rgba?: RgbaImage): StepResult {
    if (!rgba) throw new Error("the screen tracker needs the frame's colours");
    const r = this.st.step(rgba);
    if (!r.ok && r.misses >= this.maxMisses) return { frame: null, stop: "lost", lost: [], reacquired: [] };
    const H = r.ok ? imgToCompH(r.H, this.scale) : null;
    const points = this.quad.map((p) => (H ? applyH(H, p) : null));
    const conf = r.ok && r.support !== null ? r4(Math.min(1, r.support)) : null;
    return {
      frame: {
        time,
        ok: r.ok,
        H,
        points,
        confidence: points.map(() => conf),
        rms_px: null,
        expected_px: r.ok && r.expected_px !== null ? r4(r.expected_px / this.scale) : null,
        inliers: r.ok ? 4 : 0,
        coverage: r.coverage === null ? null : r4(r.coverage),
        ...(r.ok ? {} : { note: r.note ?? "the outline was not found" }),
      },
      stop: null,
      lost: [],
      reacquired: [],
    };
  }
}

/** The quad a region stands for: a 4-corner polygon as given when it is a proper quad, else its bounding rectangle. */
export function quadOfRegion(r: Region): Vec2[] {
  if ("polygon" in r && r.polygon.length === 4) {
    const q = r.polygon.map((p) => [p[0], p[1]] as Vec2);
    if (quadCheck(q).ok) return q;
  }
  if ("rect" in r) return rectQuad(r.rect[2], r.rect[3], r.rect[0], r.rect[1]);
  if ("ellipse" in r) return rectQuad(2 * r.ellipse[2], 2 * r.ellipse[3], r.ellipse[0] - r.ellipse[2], r.ellipse[1] - r.ellipse[3]);
  const xs = r.polygon.map((p) => p[0]);
  const ys = r.polygon.map((p) => p[1]);
  return rectQuad(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), Math.min(...xs), Math.min(...ys));
}

/** The convex hull of points (Andrew's monotone chain), counter-clockwise in screen coordinates. */
function convexHull(points: Vec2[]): Vec2[] {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Vec2[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Vec2[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/**
 * Where a points track is checked: the surface quad when one was given, else the auto_points region, else
 * the points' hull grown by half a pattern. Null for fewer than 3 points with neither (nothing to check).
 */
export function verifyAreaFor(a: { quad?: Vec2[]; autoRegion?: Region; points: Vec2[]; patternSize: number }): Region | null {
  if (a.quad) return { polygon: a.quad.map((p) => [p[0], p[1]]) };
  if (a.autoRegion) return a.autoRegion;
  if (a.points.length < 3) return null;
  const hull = convexHull(a.points);
  if (hull.length < 3) return null;
  const c: Vec2 = [hull.reduce((t, p) => t + p[0], 0) / hull.length, hull.reduce((t, p) => t + p[1], 0) / hull.length];
  const grow = a.patternSize / 2;
  return {
    polygon: hull.map((p) => {
      const d = Math.hypot(p[0] - c[0], p[1] - c[1]) || 1;
      return [p[0] + ((p[0] - c[0]) / d) * grow, p[1] + ((p[1] - c[1]) / d) * grow];
    }),
  };
}

// ---------- regions, channels ----------

function inRegion(r: Region, x: number, y: number, grow: number): boolean {
  if ("rect" in r) {
    const [rx, ry, rw, rh] = r.rect;
    return x >= rx - grow && x <= rx + rw + grow && y >= ry - grow && y <= ry + rh + grow;
  }
  if ("ellipse" in r) {
    const [cx, cy, ex, ey] = r.ellipse;
    const a = ex + grow;
    const b = ey + grow;
    return a > 0 && b > 0 && ((x - cx) / a) ** 2 + ((y - cy) / b) ** 2 <= 1;
  }
  const pts = r.polygon;
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  if (inside || grow <= 0) return inside;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [ax, ay] = pts[j];
    const [bx, by] = pts[i];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
    if (Math.hypot(x - (ax + t * dx), y - (ay + t * dy)) <= grow) return true;
  }
  return false;
}

/** The longer side of a region's bounding box, comp px. */
export function regionLongerSide(r: Region): number {
  if ("rect" in r) return Math.max(Math.abs(r.rect[2]), Math.abs(r.rect[3]));
  if ("ellipse" in r) return 2 * Math.max(Math.abs(r.ellipse[2]), Math.abs(r.ellipse[3]));
  const xs = r.polygon.map((p) => p[0]);
  const ys = r.polygon.map((p) => p[1]);
  return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
}

/** 1 where points may be: inside `region`, outside every `exclude` (grown by `growPx` comp px). Image pixels, `scale` image px per comp px. */
export function regionMask(width: number, height: number, scale: number, region: Region, exclude: Region[], growPx: number): Float32Array {
  const mask = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const cy = (y + 0.5) / scale;
    for (let x = 0; x < width; x++) {
      const cx = (x + 0.5) / scale;
      if (!inRegion(region, cx, cy, 0)) continue;
      if (exclude.some((e) => inRegion(e, cx, cy, growPx))) continue;
      mask[y * width + x] = 1;
    }
  }
  return mask;
}

/** The mask shrunk by `r` px: 1 only where the whole (2r + 1) square around the pixel is 1. */
export function erodeMask(mask: Float32Array, width: number, height: number, r: number): Float32Array {
  if (!(r > 0)) return mask;
  const W1 = width + 1;
  const sum = new Float64Array(W1 * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      row += mask[y * width + x] > 0 ? 1 : 0;
      sum[(y + 1) * W1 + x + 1] = sum[y * W1 + x + 1] + row;
    }
  }
  const out = new Float32Array(width * height);
  const full = (2 * r + 1) ** 2;
  for (let y = r; y < height - r; y++) {
    for (let x = r; x < width - r; x++) {
      const s = sum[(y + r + 1) * W1 + x + r + 1] - sum[(y - r) * W1 + x + r + 1] - sum[(y + r + 1) * W1 + x - r] + sum[(y - r) * W1 + x - r];
      if (s >= full) out[y * width + x] = 1;
    }
  }
  return out;
}

export type Channel = "luma" | "red" | "green" | "blue" | "saturation";

export function channelGray(img: RgbaImage, channel: Channel): GrayImage {
  if (channel === "luma") return toGray(img);
  const n = img.width * img.height;
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const j = i * 4;
    const r = img.data[j];
    const g = img.data[j + 1];
    const b = img.data[j + 2];
    if (channel === "red") data[i] = r;
    else if (channel === "green") data[i] = g;
    else if (channel === "blue") data[i] = b;
    else {
      const mx = Math.max(r, g, b);
      data[i] = mx > 0 ? ((mx - Math.min(r, g, b)) / mx) * 255 : 0;
    }
  }
  return { width: img.width, height: img.height, data };
}

// ---------- the track summary and preview ----------

/**
 * Lens distortion seen through a track: a lens that bends straight lines moves points near the frame's
 * edge away from where one plane's homography puts them, radially, and more the further out they are.
 * A one-parameter radial model about the frame centre, p_d = c + (p_u - c)(1 + k r^2) with r over the
 * half diagonal, is fitted to the tracked points (the fit's inliers, as the tracker uses them): when
 * taking it out lowers the fit residual by a quarter or more (and 0.1 px or more) and moves a frame
 * corner over 5 px, the plate is distorted. Calibrated on AE's Optics Compensation: field of view 40
 * (a corner about 35 px) and 80 (about 160 px) were caught, a straight lens was not. `edge_px` is how far the model moves a frame
 * corner. Null when the points do not reach out from the centre (they must span at least half the
 * half-diagonal) or there are too few to say.
 */
export function lensCheck(track: PlanarTrack): { k: number; edge_px: number; residual_px: number; residual_without_px: number; distorted: boolean } | null {
  const [w, h] = track.comp_size;
  const c: Vec2 = [w / 2, h / 2];
  const half = Math.hypot(w / 2, h / 2);
  const reach = Math.max(...track.ref_points.map((p) => Math.hypot(p[0] - c[0], p[1] - c[1]) / half));
  if (track.ref_points.length < 6 || !(reach >= 0.5)) return null;
  const model: MotionModel = track.ref_points.length >= 5 ? "perspective" : track.model;
  const solved = track.frames.filter((f) => f.ok && f.H && f.time !== track.ref_time);
  const step = Math.max(1, Math.ceil(solved.length / 30));
  const frames = solved.filter((_, i) => i % step === 0);
  if (frames.length < 3) return null;
  // The exact inverse of p_d = c + u (1 + k |u|^2 / half^2), by fixed-point iteration on |u|.
  const undistort = (p: Vec2, k: number): Vec2 => {
    const dx = p[0] - c[0];
    const dy = p[1] - c[1];
    const rd2 = (dx * dx + dy * dy) / (half * half);
    let f = 1 + k * rd2;
    for (let it = 0; it < 8; it++) {
      if (!(f > 0.2)) break;
      const ru2 = rd2 / (f * f);
      f = 1 + k * ru2;
    }
    if (!(f > 0.2)) f = 1;
    return [c[0] + dx / f, c[1] + dy / f];
  };
  const cost = (k: number): number => {
    let sq = 0;
    let n = 0;
    for (const f of frames) {
      const idx = f.points.map((p, i) => (p ? i : -1)).filter((i) => i >= 0);
      if (idx.length < 6) continue;
      const from = idx.map((i) => undistort(track.ref_points[i], k));
      const to = idx.map((i) => undistort(f.points[i] as Vec2, k));
      // Robust, as the tracker is: points the fit votes out (off the plane, at a frame edge) do not count.
      const fit = ransacModel(model, from, to, { thresholdPx: 3, iterations: 40, seed: 1 });
      if (!fit) continue;
      const inl = fit.inliers.filter(Boolean).length;
      if (inl < 6) continue;
      sq += fit.rms_px * fit.rms_px * inl;
      n += inl;
    }
    return n ? Math.sqrt(sq / n) : Infinity;
  };
  // A coarse scan, then golden section around the best.
  let bestK = 0;
  let bestC = cost(0);
  const base = bestC;
  if (!Number.isFinite(base)) return null;
  for (let k = -0.3; k <= 0.3001; k += 0.03) {
    const v = cost(k);
    if (v < bestC) {
      bestC = v;
      bestK = k;
    }
  }
  let lo = bestK - 0.03;
  let hi = bestK + 0.03;
  const g = (Math.sqrt(5) - 1) / 2;
  for (let it = 0; it < 30; it++) {
    const a = hi - g * (hi - lo);
    const b = lo + g * (hi - lo);
    if (cost(a) < cost(b)) hi = b;
    else lo = a;
  }
  const k = (lo + hi) / 2;
  const kc = cost(k);
  if (kc < bestC) {
    bestC = kc;
    bestK = k;
  }
  const edge = Math.abs(bestK) * half;
  return { k: r4(bestK), edge_px: r2(edge), residual_px: r4(bestC), residual_without_px: r4(base), distorted: base - bestC > 0.1 && bestC < base * 0.75 && edge > 5 };
}

/**
 * Once a track is finished: a frame whose expected error is far above the track's own typical one
 * (8x its median and over 2 px) got a wild fit, usually from too few inliers or a point off the plane
 * voting with the rest. Seen on a parallax shot: such frames were 20-120 px off while marked ok. They
 * become not ok with a note, so ae_track_apply interpolates across them instead of writing the jump.
 */
export function flagUnreliableFrames(track: PlanarTrack): number[] {
  const ex = track.frames
    .filter((f) => f.ok && typeof f.expected_px === "number" && f.time !== track.ref_time)
    .map((f) => f.expected_px as number)
    .sort((a, b) => a - b);
  if (ex.length < 5) return [];
  const typical = ex[Math.floor(ex.length / 2)];
  const limit = Math.max(2, 8 * typical);
  const flagged: number[] = [];
  for (const f of track.frames) {
    if (f.ok && typeof f.expected_px === "number" && f.expected_px > limit) {
      f.ok = false;
      f.note = `unreliable fit: expected error ${r2(f.expected_px)} px against a typical ${r2(typical)} px (too few points agreeing, or points off the plane)`;
      flagged.push(f.time);
    }
  }
  return flagged;
}

const CORNER_NAMES = ["UL", "UR", "LR", "LL"];
const cornerName = (k: number, n: number) => (n === 4 ? CORNER_NAMES[k] : `point ${k + 1}`);

/** The corners' paths of a track's solved frames (path-check.ts), comp px. */
function pathCheckOf(track: PlanarTrack): { res: PathCheckResult | null; quad: Vec2[] } {
  const quad = track.tracking?.quad ?? boundingQuad(track.ref_points);
  const samples = track.frames
    .filter((f) => f.ok && f.H)
    .map((f) => ({ frame: Math.round(f.time * track.fps), points: quad.map((p) => applyH(f.H as Mat3, p)) }))
    .filter((x) => x.points.every((p) => p !== null)) as Array<{ frame: number; points: Vec2[] }>;
  return { res: checkPaths(samples, { compHeight: track.comp_size[1] }), quad };
}

/** The bounded report of a path check. */
function pathReport(res: PathCheckResult, nCorners: number, flagged: number | null): Record<string, unknown> {
  const per: Record<string, unknown> = {};
  res.per_corner.forEach((c, k) => {
    per[cornerName(k, nCorners)] = { worst_jump_px: c.worst_jump_px, worst_jump_frame: c.worst_jump_frame, jumps: c.jumps, worst_off_px: c.worst_off_px, worst_off_frame: c.worst_off_frame, off_frames: c.off_frames };
  });
  return {
    frames_checked: res.frames_checked,
    corner_noise_px: res.corner_sigma_px,
    jump_limit_px: res.jump_limit_px,
    off_limit_px: res.off_limit_px,
    ...(flagged !== null ? { frames_flagged: flagged } : { frames_over: new Set(res.flags.map((f) => f.frame)).size }),
    per_corner: per,
    worst: res.flags.slice(0, 8).map((f) => ({ frame: f.frame, kind: f.kind, px: f.px })),
    sharpest_move: res.whole,
  };
}

const PATH_CHECK_NOTE =
  "path_check: every corner's path was checked once the track was finished, whatever made it. A camera shake moves, turns and scales the whole surface at once; what it hardly changes from frame to frame is the surface's shape. So each corner's place in that shape is compared with a robust fit through the frames around it: a jump is a frame off the fit through its 3 neighbours each side (over jump_limit_px: a tick the eye sees), off its path is off the fit through 12 each side (over off_limit_px: an edge dragged away for several frames, such as by a hand's edge taken for the surface's). Taking the camera's move out takes part of a wrong move with it: one edge moving by d alone shows as about 0.4 d, so the px here run below how far the edge moved. Those frames are not ok and not written; AE interpolates across them. sharpest_move is the whole surface's sharpest move off its smooth path (a footstep's jolt, or a jump): reported only, a path alone cannot tell the two apart.";

/**
 * Once a track is finished: every corner's path checked for jumps (path-check.ts), whatever made the
 * track, and the frames where a corner jumped or left its path become not ok with a note, so they are
 * never written (AE interpolates across them). The reference frame is never flagged. The report is
 * kept on the track (tracking.path_check).
 */
export function flagPathJumps(track: PlanarTrack): number[] {
  const { res, quad } = pathCheckOf(track);
  if (!res) return [];
  const byFrame = new Map(res.flags.map((fl) => [fl.frame, fl]));
  const flagged: number[] = [];
  for (const f of track.frames) {
    if (!f.ok || Math.abs(f.time - track.ref_time) < 1e-6) continue;
    const fl = byFrame.get(Math.round(f.time * track.fps));
    if (!fl) continue;
    f.ok = false;
    const what = fl.kind === "jump" ? `jumps ${fl.px} px against the frames on either side` : `is ${fl.px} px off the path of the frames around it`;
    f.note = `the surface's shape (its corners against each other, the camera's move taken out) ${what} (limit ${fl.limit_px} px): the track bent it on its own (an occluder's edge taken for the surface's, a second parallel edge, a reflection); not written`;
    flagged.push(f.time);
  }
  if (track.tracking) track.tracking.path_check = pathReport(res, quad.length, flagged.length);
  return flagged;
}

/**
 * Points that do not move with the plane the others define: per point, how far it sits from where
 * the solved motion puts it, frame by frame. A point on the plane stays within the trackers' noise;
 * one off the plane (parallax), on a moving object or in a reflection drifts away, and the robust fit
 * votes it out more and more often.
 */
export function slidingPoints(track: PlanarTrack): Array<{ index: number; median_px: number; frames_off_plane: number; frames: number }> {
  const solved = track.frames.filter((f) => f.ok && f.H && f.time !== track.ref_time);
  if (solved.length < 5) return [];
  const per: number[][] = track.ref_points.map(() => []);
  for (const f of solved) {
    track.ref_points.forEach((rp, k) => {
      const p = f.points[k];
      const q = applyH(f.H!, rp);
      if (p && q) per[k].push(Math.hypot(p[0] - q[0], p[1] - q[1]));
    });
  }
  const median = (xs: number[]) => {
    const v = xs.slice().sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : 0;
  };
  // The noise floor: the median residual over every point and frame, as a robust sigma.
  const all = per.flat();
  const noise = Math.max(0.15, median(all) * 1.4826);
  const limit = Math.max(1.5, 5 * noise);
  const out: Array<{ index: number; median_px: number; frames_off_plane: number; frames: number }> = [];
  per.forEach((res, k) => {
    if (res.length < 5) return;
    // The later half carries parallax: it grows with the motion since the reference frame.
    const late = res.slice(Math.floor(res.length / 2));
    const off = res.filter((e) => e > limit).length;
    if (median(late) > limit || off >= Math.max(3, res.length * 0.25)) out.push({ index: k, median_px: r2(median(res)), frames_off_plane: off, frames: res.length });
  });
  return out;
}

/**
 * Frame-to-frame shake of the surface corners that the motion does not explain, px: third differences
 * of each corner's path (smooth motion, even accelerating, leaves almost none; white noise of sigma
 * leaves sqrt(20) sigma), as a robust sigma. The largest corner's.
 */
export function cornerJitter(track: PlanarTrack, quad: Vec2[]): number | null {
  const frames = track.frames.filter((f) => f.ok && f.H);
  if (frames.length < 8) return null;
  let worst = 0;
  for (const corner of quad) {
    const path = frames.map((f) => applyH(f.H!, corner));
    const d3: number[] = [];
    for (let i = 3; i < path.length; i++) {
      const [a, b, c, d] = [path[i - 3], path[i - 2], path[i - 1], path[i]];
      if (!a || !b || !c || !d) continue;
      d3.push(Math.hypot(d[0] - 3 * c[0] + 3 * b[0] - a[0], d[1] - 3 * c[1] + 3 * b[1] - a[1]));
    }
    if (d3.length < 4) continue;
    d3.sort((x, y) => x - y);
    // |d3| of 2-D white noise is Rayleigh with scale sqrt(20) sigma; its median is 1.1774 times that.
    const sigma = d3[Math.floor(d3.length / 2)] / (1.1774 * Math.sqrt(20));
    if (sigma > worst) worst = sigma;
  }
  return r2(worst);
}

const EXPECTED_ERROR_NOTE =
  "expected_error_px is how far the solved surface (the quad) is likely to be from the true motion, per frame: point noise from the residuals, carried through the fit to the whole quad (on AE shots with known motion the true error was 0.7-1.0x this). rms_px only says how well the points agree with each other and runs 3-5x below the true error. expected_error_px is null for frames without spare points: give more points than the model needs (perspective 5+, similarity 3+).";

function lensSummary(track: PlanarTrack): Record<string, unknown> {
  const l = lensCheck(track);
  if (!l) return {};
  // A straight lens leaves the cost flat in k, so its k means nothing: only the residuals are given.
  if (!l.distorted) return { lens: { distorted: false, residual_px: l.residual_px, residual_without_px: l.residual_without_px } };
  return {
    lens: { ...l },
    lens_note: `The points bend the way a lens does (radial k ${l.k}; a frame corner moves about ${l.edge_px} px): one plane's motion leaves ${l.residual_without_px} px of fit residual that a lens model brings to ${l.residual_px} px. A 2D track and anything pinned to it will slide near the edges. Undistort the plate first (Optics Compensation, or the lens profile from the camera), track and composite on it, then put the distortion back; or keep the points and the insert near the middle of the frame.`,
  };
}

function slidingSummary(track: PlanarTrack): Record<string, unknown> {
  const sliding = slidingPoints(track);
  if (!sliding.length) return {};
  const many = sliding.length >= 2 && sliding.length >= track.ref_points.length / 4;
  return {
    sliding_points: sliding,
    sliding_note: many
      ? `${sliding.length} of ${track.ref_points.length} points do not move with the plane the others define. Either they are off it (parallax: different depths), on something moving, or the shot is not one plane at all; then a 2D track cannot hold, and the shot needs a 3D camera solve (AE's 3D Camera Tracker, or Mocha with the right plane). Track again with points on one surface only (auto_points.exclude), or check the preview.`
      : `Point ${sliding.map((p) => p.index).join(", ")} does not move with the plane the others define (off the plane, on something moving, or a reflection). The fit votes it out, but the track is safer without it: track again with auto_points.exclude over it, or check the preview.`,
  };
}

/** Models with fewer parameters to try for a track whose surface shakes. */
const LOWER_MODELS: Record<MotionModel, MotionModel[]> = { perspective: ["affine", "similarity"], affine: ["similarity"], similarity: [], translate: [] };

function meanFitRms(track: PlanarTrack): number | null {
  const r = track.frames.filter((f) => f.ok && f.rms_px !== null && f.time !== track.ref_time).map((f) => f.rms_px as number);
  return r.length ? r.reduce((a, b) => a + b, 0) / r.length : null;
}

/** How much of the surface (quad) the points' bounding box spans, in percent of its width and height. */
export function pointsCover(points: Vec2[], quad: Vec2[]): { width_pct: number; height_pct: number } {
  const span = (v: number[]) => Math.max(...v) - Math.min(...v);
  const qw = span(quad.map((p) => p[0]));
  const qh = span(quad.map((p) => p[1]));
  return {
    width_pct: qw > 0 ? Math.round((100 * span(points.map((p) => p[0]))) / qw) : 100,
    height_pct: qh > 0 ? Math.round((100 * span(points.map((p) => p[1]))) / qh) : 100,
  };
}

/**
 * When the surface corners shake (corner_jitter_px of 1 px or more), the same tracked points solved
 * with each model with fewer parameters: the corner shake, how well it still fits the points, and the
 * model to write with (ae_track_apply refit_model), if one halves the shake and still fits (mean fit
 * residual within 1 px, or twice the track's own) on as many frames. Measured on a 4K shot with 8 points
 * in a 1570 x 284 px band under a 2309 x 761 px surface (2026-11-26): perspective moved a corner 35 px
 * in one frame while the points moved under 1 px.
 */
export function modelAdvice(track: PlanarTrack): Record<string, unknown> | null {
  const quad = track.tracking?.quad ?? boundingQuad(track.ref_points);
  const now = cornerJitter(track, quad);
  if (now === null || now < 1 || LOWER_MODELS[track.model].length === 0) return null;
  const okOf = (t: PlanarTrack) => t.frames.filter((f) => f.ok).length;
  const rmsNow = meanFitRms(track);
  const tried = LOWER_MODELS[track.model].map((m) => {
    const alt = refitFrames(track, m);
    const rms = meanFitRms(alt);
    return { model: m, corner_jitter_px: cornerJitter(alt, quad), rms_px: rms === null ? null : r2(rms), frames_ok: okOf(alt) };
  });
  const limit = Math.max(1, 2 * (rmsNow ?? 0));
  const fits = tried
    .filter((t) => t.corner_jitter_px !== null && t.rms_px !== null && t.rms_px <= limit && t.frames_ok >= okOf(track) * 0.95)
    .sort((x, y) => (x.corner_jitter_px as number) - (y.corner_jitter_px as number));
  const best = fits.length && (fits[0].corner_jitter_px as number) <= now / 2 ? fits[0] : null;
  const cover = pointsCover(track.ref_points, quad);
  const why =
    `The surface corners shake ${now} px from frame to frame while the points agree with the fit to ${rmsNow === null ? "?" : r2(rmsNow)} px: ` +
    `the points span ${cover.width_pct}% of the surface's width and ${cover.height_pct}% of its height, and the ${track.model} fit swings the corners outside them. `;
  const note = best
    ? why +
      `Solved again from the same points as ${best.model}, the corners shake ${best.corner_jitter_px} px (fit ${best.rms_px} px). ` +
      `Write it with ae_track_apply refit_model: "${best.model}" (no new tracking), add smooth_frames 1-2 for what is left, or track again with points spread over the whole surface, near its corners.`
    : why + "No model with fewer parameters fits the points well enough: track again with points spread over the whole surface (near its corners), or smooth with ae_track_apply smooth_frames.";
  return { current: { model: track.model, corner_jitter_px: now, rms_px: rmsNow === null ? null : r2(rmsNow) }, tried, recommended: best ? { refit_model: best.model } : null, points_cover: cover, note };
}

/** ae_track_apply's refit_model and smooth_frames: the adjusted track, saved under a new track_id, and what changed. */
export function adjustTrack(track: PlanarTrack, opts: { refit_model?: MotionModel; smooth_frames?: number }): { track: PlanarTrack; info: Record<string, unknown> | null } {
  const refit = opts.refit_model && opts.refit_model !== track.model ? opts.refit_model : null;
  const sigma = typeof opts.smooth_frames === "number" && opts.smooth_frames > 0 ? opts.smooth_frames : 0;
  if (!refit && !sigma) return { track, info: null };
  const quad = track.tracking?.quad ?? boundingQuad(track.ref_points);
  let t = track;
  if (refit) t = refitFrames(t, refit);
  if (sigma) t = smoothFrames(t, sigma);
  const did = [refit ? `refit ${track.model} -> ${refit}` : "", sigma ? `smoothed over ${sigma} frame(s)` : ""].filter(Boolean).join(", ");
  const derived: PlanarTrack = { ...t, track_id: newTrackId(), source: `${track.source} (${did}, from ${track.track_id})`, created: new Date().toISOString() };
  saveTrack(derived);
  const okOf = (x: PlanarTrack) => x.frames.filter((f) => f.ok).length;
  return {
    track: derived,
    info: {
      from_track_id: track.track_id,
      track_id: derived.track_id,
      model: derived.model,
      ...(sigma ? { smooth_frames: sigma } : {}),
      corner_jitter_px: { before: cornerJitter(track, quad), after: cornerJitter(derived, quad) },
      frames_ok: { before: okOf(track), after: okOf(derived) },
      note: `Written from track ${derived.track_id} (${did}); the original ${track.track_id} is unchanged.`,
    },
  };
}

export function trackSummary(track: PlanarTrack, maxFrames = 500): Record<string, unknown> {
  const ok = track.frames.filter((f) => f.ok);
  const rms = ok.map((f) => f.rms_px).filter((v): v is number => v !== null);
  const exp = ok.filter((f) => typeof f.expected_px === "number" && f.time !== track.ref_time);
  const worst = exp.reduce<PlanarFrame | null>((w, f) => (w === null || (f.expected_px as number) > (w.expected_px as number) ? f : w), null);
  const step = Math.max(1, Math.ceil(track.frames.length / maxFrames));
  const sampled = track.frames.filter((_, i) => i % step === 0 || i === track.frames.length - 1).slice(0, maxFrames);
  const lostPer = track.ref_points.map((_, k) => track.frames.filter((f) => f.points[k] === null).length);
  return {
    track_id: track.track_id,
    track_path: trackFilePath(track.track_id),
    comp_id: track.comp_id,
    model: track.model,
    source: track.source,
    ref_time: r4(track.ref_time),
    ref_points: track.ref_points.map((p) => [r2(p[0]), r2(p[1])]),
    frames: track.frames.length,
    frames_ok: ok.length,
    first_time: track.frames.length ? r4(track.frames[0].time) : null,
    last_time: track.frames.length ? r4(track.frames[track.frames.length - 1].time) : null,
    rms_px: rms.length ? { mean: r2(rms.reduce((a, b) => a + b, 0) / rms.length), max: r2(Math.max(...rms)) } : null,
    expected_error_px:
      exp.length && worst
        ? { mean: r2(exp.reduce((a, f) => a + (f.expected_px as number), 0) / exp.length), max: r2(worst.expected_px as number), worst_time: r4(worst.time), frames_without: Math.max(0, ok.length - 1 - exp.length) }
        : null,
    error_note: EXPECTED_ERROR_NOTE,
    corner_jitter_px: cornerJitter(track, track.tracking?.quad ?? boundingQuad(track.ref_points)),
    ...(() => {
      // A finished ae_track_multi track carries the check made before its frames were flagged; any other
      // track (read from the project, or not finished yet) is checked here, for the report only.
      const stored = track.tracking?.path_check;
      if (stored) return { path_check: stored, path_check_note: PATH_CHECK_NOTE };
      const { res, quad } = pathCheckOf(track);
      return res ? { path_check: pathReport(res, quad.length, null), path_check_note: PATH_CHECK_NOTE } : {};
    })(),
    ...(() => {
      const advice = modelAdvice(track);
      return advice ? { model_advice: advice } : {};
    })(),
    ...slidingSummary(track),
    ...lensSummary(track),
    frames_lost_per_point: lostPer,
    ...(() => {
      // Frames that are not ok, with why: the apply tools skip them and interpolate across.
      const notOk = track.frames.filter((f) => !f.ok);
      const checked = track.frames.filter((f) => typeof f.ncc === "number" && f.time !== track.ref_time);
      const okChecked = checked.filter((f) => f.ok);
      return {
        ...(notOk.length ? { frames_not_ok: { count: notOk.length, first: notOk.slice(0, 12).map((f) => ({ time: r4(f.time), note: f.note ?? null })) } } : {}),
        ...(checked.length
          ? {
              surface_check: {
                frames_checked: checked.length,
                frames_failed: checked.length - okChecked.length,
                ncc_min_ok: okChecked.length ? r4(Math.min(...okChecked.map((f) => f.ncc as number))) : null,
                coverage_min_ok: okChecked.length ? r4(Math.min(...okChecked.map((f) => (typeof f.coverage === "number" ? f.coverage : 1)))) : null,
                note: "Each frame was aligned to the reference frame's surface: ncc is the correlation over the pixels that line up, coverage the share of the visible surface that does (lower while something crosses in front). A frame that does not line up is not ok and is not written.",
              },
            }
          : {}),
      };
    })(),
    frame_rows: sampled.map((f) => [r4(f.time), f.ok ? 1 : 0, f.rms_px === null ? null : r2(f.rms_px), f.inliers, f.H ? f.H.map((v) => Number(v.toPrecision(8))) : null]),
    frame_rows_format: "[time_s, ok, rms_px, inliers, H (row-major 3x3, ref comp px -> comp px at time_s; 8 significant digits, the track file has full precision)]",
    ...(step > 1 ? { frame_rows_sampled_every: step } : {}),
    full_data: "The track file holds every frame with per-point positions and confidences.",
  };
}

interface SheetTile {
  image: RgbaImage;
  frame: PlanarFrame | null;
  label: string;
}

/** Tiles side by side: each frame shrunk, with the points (cyan, lost ones red), their pattern boxes and the surface quad (green, red when it degenerates). */
export function drawTrackSheet(tiles: SheetTile[], o: { quad: Vec2[]; patchSize: number; compSize: Vec2; maxTile?: number }): PNG {
  const maxTile = o.maxTile ?? 640;
  const drawn: PNG[] = tiles.map((t) => {
    const fit = fitWithin(t.image.width, t.image.height, maxTile);
    const img = resizeArea(t.image, fit.width, fit.height);
    const k = fit.width / o.compSize[0];
    const cyan: [number, number, number, number] = [0, 220, 255, 255];
    const red: [number, number, number, number] = [255, 60, 60, 255];
    const green: [number, number, number, number] = [80, 255, 120, 255];
    if (t.frame) {
      const box = Math.max(4, Math.round(o.patchSize * k));
      t.frame.points.forEach((p) => {
        if (!p) return;
        strokeRect(img, Math.round(p[0] * k - box / 2), Math.round(p[1] * k - box / 2), box, box, 1, cyan);
        drawCross(img, p[0] * k, p[1] * k, 4, 1, cyan);
      });
      if (t.frame.H) {
        const q = o.quad.map((c) => applyH(t.frame!.H as Mat3, c));
        if (q.every((c) => c !== null)) drawPolygon(img, (q as Vec2[]).map((c) => [c[0] * k, c[1] * k] as [number, number]), 2, t.frame.ok ? green : red);
      }
    }
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

function writeSheet(framesDir: string, tag: string, png: PNG): string {
  fs.mkdirSync(framesDir, { recursive: true });
  const file = path.join(framesDir, `track_${tag}.png`);
  fs.writeFileSync(file, encodePng(png));
  return file;
}

// ---------- applying a track: the pure part ----------

export interface LayerKeys {
  times: number[];
  pin?: { ul: Vec2[]; ur: Vec2[]; ll: Vec2[]; lr: Vec2[] };
  transform?: { position: Vec2[]; rotation: number[]; scale: Vec2[] };
  /** Frame times that could not be written (a corner behind the plane, a singular matrix). */
  skipped: number[];
  /** Largest distance between the track's motion and the similarity written (transform and transform_pin). */
  max_fit_px: number;
}

const round2 = (v: Vec2): Vec2 => [r4(v[0]), r4(v[1])];

/**
 * The keys that make a layer follow the track. `track` has the reference
 * frame as identity; `ref` is the layer's transform at that frame and
 * `samples[i]` its transform (and its parents') at frames[i].time.
 * Corner pin: P(t) = M(t)^-1 . H(t) . M(ref) applied to the layer's own corners,
 * where M is layer -> comp. Transform: the same product without the layer's
 * own part gives the layer->parent matrix, decomposed into position, rotation
 * and scale around the anchor the layer keeps. transform_pin: the similarity part
 * as transform keys, and the corner pin takes the residual on top of them.
 */
export function buildLayerKeys(a: {
  mode: "corner_pin" | "power_pin" | "transform" | "transform_pin";
  frames: PlanarFrame[];
  ref: LayerSample;
  samples: LayerSample[];
  size: Vec2;
  /** The pin's four points (UL, UR, LL, LR, layer px) at the reference frame, when an existing pin is used; the layer's own corners otherwise. */
  refPin?: Vec2[];
}): LayerKeys {
  const [w, h] = a.size;
  const rectCorners: Vec2[] = [[0, 0], [w, 0], [0, h], [w, h]];
  const corners: Vec2[] = a.refPin && a.refPin.length === 4 ? a.refPin : rectCorners;
  const refComp = rectQuad(w, h).map((c) => applyH(a.ref.full, c));
  const wantTransform = a.mode === "transform" || a.mode === "transform_pin";
  const wantPin = a.mode !== "transform";
  const times: number[] = [];
  const skipped: number[] = [];
  const pin = { ul: [] as Vec2[], ur: [] as Vec2[], ll: [] as Vec2[], lr: [] as Vec2[] };
  const tr = { position: [] as Vec2[], rotation: [] as number[], scale: [] as Vec2[] };
  let maxFit = 0;
  a.frames.forEach((f, i) => {
    const s = a.samples[i];
    const H = f.H;
    if (!H || !s) {
      skipped.push(f.time);
      return;
    }
    let Hs: Mat3 = H;
    let dec: ReturnType<typeof decomposeLayerMatrix> | null = null;
    let M = s.full;
    if (wantTransform) {
      const to = refComp.map((c) => (c ? applyH(H, c) : null));
      if (refComp.some((c) => c === null) || to.some((c) => c === null)) {
        skipped.push(f.time);
        return;
      }
      const fit = solveModel("similarity", refComp as Vec2[], to as Vec2[]);
      if (!fit) {
        skipped.push(f.time);
        return;
      }
      Hs = fit.H;
      maxFit = Math.max(maxFit, fit.max_px);
      const pInv = invertH(s.parents);
      if (!pInv) {
        skipped.push(f.time);
        return;
      }
      // The anchor at THIS frame: AE composes the layer with the anchor it has at t, so an animated anchor is followed, not frozen at ref_time.
      dec = decomposeLayerMatrix(mulH(pInv, mulH(Hs, a.ref.full)), s.anchor);
      M = mulH(s.parents, layerMatrix({ anchor: s.anchor, position: dec.position, scale_pct: dec.scale_pct, rotation_deg: dec.rotation_deg }));
    }
    let pts: Vec2[] | null = null;
    if (wantPin) {
      const mInv = invertH(M);
      if (!mInv) {
        skipped.push(f.time);
        return;
      }
      const P = mulH(mInv, mulH(H, a.ref.full));
      const mapped = corners.map((c) => applyH(P, c));
      if (mapped.some((c) => c === null)) {
        skipped.push(f.time);
        return;
      }
      pts = mapped as Vec2[];
    }
    times.push(f.time);
    if (pts) {
      pin.ul.push(round2(pts[0]));
      pin.ur.push(round2(pts[1]));
      pin.ll.push(round2(pts[2]));
      pin.lr.push(round2(pts[3]));
    }
    if (dec) {
      tr.position.push(round2(dec.position));
      tr.rotation.push(dec.rotation_deg);
      tr.scale.push(round2(dec.scale_pct));
    }
  });
  const out: LayerKeys = { times, skipped, max_fit_px: r2(maxFit) };
  if (wantPin) out.pin = pin;
  if (wantTransform) out.transform = { position: tr.position, rotation: unwrapDegrees(tr.rotation).map(r4), scale: tr.scale };
  return out;
}

export interface NullKeys {
  name: string;
  times: number[];
  position: Vec2[];
  rotation?: number[];
  scale?: Vec2[];
}

/** One null per tracked point (its position at every ok frame), and optionally a solved similarity null. */
export function buildNullKeys(a: { track: PlanarTrack; frames: PlanarFrame[]; prefix: string; solved: boolean }): NullKeys[] {
  const out: NullKeys[] = [];
  a.track.ref_points.forEach((rp, k) => {
    const times: number[] = [];
    const position: Vec2[] = [];
    for (const f of a.frames) {
      let p: Vec2 | null = f.points[k] ?? null;
      if (!p && f.H) p = applyH(f.H, rp);
      if (!p) continue;
      times.push(f.time);
      position.push(round2(p));
    }
    if (times.length > 0) out.push({ name: `${a.prefix} ${k + 1}`.slice(0, 200), times, position });
  });
  if (a.solved) {
    const pts = a.track.ref_points;
    const pivot: Vec2 = [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
    const times: number[] = [];
    const position: Vec2[] = [];
    const rot: number[] = [];
    const scale: Vec2[] = [];
    for (const f of a.frames) {
      if (!f.H) continue;
      const d = decomposeSimilarity(f.H, pivot);
      times.push(f.time);
      position.push(round2(d.position));
      rot.push(d.rotation_deg);
      scale.push([r4(d.scale_pct), r4(d.scale_pct)]);
    }
    if (times.length > 0) out.push({ name: `${a.prefix} solved`.slice(0, 200), times, position, rotation: unwrapDegrees(rot).map(r4), scale });
  }
  return out;
}

// ---------- applying a track: the guarded write ----------

interface WrittenProp {
  role: string;
  name: string;
  numKeys: number;
}
interface HostWritten {
  nulls: Array<{ layer_id: number; layer_index: number; name: string; props: WrittenProp[] }>;
  written: Array<{ layer_index: number; layer_id: number; target: string; effect_index?: number; effect_added?: boolean; slot_moved?: boolean; slot_wanted?: number; param_table?: unknown; props: WrittenProp[] }>;
}
interface KeysRead {
  items: Array<{ layer_id: number; found: boolean; effect_found?: boolean; props: Array<{ role: string; numKeys: number; samples: Array<{ time: number; value: unknown }> }> }>;
}

interface Expected {
  /** Layer id, or null for a null made by this write (resolved from the host's answer by name). */
  layerId: number | null;
  nullName?: string;
  kind: "transform" | "corner_pin" | "power_pin";
  effectIndex?: number;
  role: string;
  keys: number;
  samples: Array<{ time: number; value: number | number[] }>;
}

const sampleIdx = (n: number): number[] => Array.from(new Set([0, Math.floor((n - 1) / 2), n - 1])).filter((i) => i >= 0 && i < n);

function expectedFor(kind: Expected["kind"], layerId: number | null, role: string, times: number[], values: Array<number | number[]>, extra: Partial<Expected> = {}): Expected {
  return { layerId, kind, role, keys: times.length, samples: sampleIdx(times.length).map((i) => ({ time: times[i], value: values[i] })), ...extra };
}

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

export function keyMismatches(expected: Expected[], written: HostWritten, after: KeysRead | null): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const idOf = (e: Expected) => e.layerId ?? written.nulls.find((n) => n.name === e.nullName)?.layer_id;
  const tag = (e: Expected) => `${e.nullName ?? e.layerId}.${e.role}`;
  // Key counts the host reported (roles never repeat on one layer: pin points and transform properties differ).
  for (const e of expected) {
    const id = idOf(e);
    const got = [...written.written.filter((w) => w.layer_id === id).flatMap((w) => w.props), ...written.nulls.filter((n) => n.layer_id === id).flatMap((n) => n.props)].find((p) => p.role === e.role);
    expectThat(m, got !== undefined && got.numKeys === e.keys, `${tag(e)}.numKeys`, e.keys, got?.numKeys, "Key count differs from the frames written");
  }
  if (!after) return m;
  for (const e of expected) {
    const id = idOf(e);
    const prop = after.items.filter((it) => it.layer_id === id).flatMap((it) => it.props).find((p) => p.role === e.role);
    if (!prop) {
      m.push({ path: tag(e), expected: "read back", actual: undefined, message: "The written property was not found in the read-back" });
      continue;
    }
    expectThat(m, prop.numKeys === e.keys, `${tag(e)}.readback_numKeys`, e.keys, prop.numKeys, "Key count in the read-back differs");
    e.samples.forEach((smp, i) => {
      const got = prop.samples.find((x) => near(x.time, smp.time, 1e-6)) ?? prop.samples[i];
      const gv = got?.value;
      const tol = e.role === "rotation" ? 0.02 : 0.05;
      let same = false;
      if (typeof smp.value === "number") same = typeof gv === "number" && near(gv, smp.value, tol);
      else same = Array.isArray(gv) && (smp.value as number[]).every((v, k) => typeof gv[k] === "number" && near(gv[k] as number, v, tol));
      expectThat(m, same, `${tag(e)}@${smp.time}`, smp.value, gv, "A key's value differs from what was written");
    });
  }
  return m;
}

const MOTION_BLUR_NOTE =
  "Corner Pin and CC Power Pin animation gets no layer motion blur (AE blurs layer transforms only): use mode transform_pin, or add CC Force Motion Blur, if the shot needs it.";

async function applyTrackTo(
  ctx: ToolContext,
  a: { compId: number; track: PlanarTrack; target: ApplyTarget; refTime?: number; expect: ExpectGuard; toolName: string; opId?: string; trackNote?: Record<string, unknown> }
): Promise<Record<string, unknown>> {
  const { target } = a;
  const opId = a.opId ?? ctx.bridge.newOpId();
  const label = `${a.toolName} apply(${a.compId})`;
  const refTime = a.refTime ?? a.track.ref_time;
  // refit_model / smooth_frames: written from an adjusted copy, saved under its own track_id.
  const adjusted = adjustTrack(a.track, { refit_model: target.refit_model, smooth_frames: target.smooth_frames });
  const based = relativeTo(adjusted.track, refTime);
  const refFrame = frameAt(based, refTime);
  if (!refFrame || !refFrame.ok || !refFrame.H) {
    throw new PlanarError("bad_args", `The reference frame at ${r2(refTime)} s has no solved motion, so it cannot be the frame the target looks right at. Pass a ref_time where the track is ok.`);
  }
  const half = 0.5 / (based.fps || 25);
  const inRange = based.frames.filter((f) => !target.range || (f.time >= target.range.start - half && f.time <= target.range.end + half));
  const frames = inRange.filter((f) => f.ok && f.H !== null);
  const notOk = inRange.filter((f) => !(f.ok && f.H !== null)).map((f) => f.time);
  if (frames.length === 0) throw new PlanarError("bad_args", "No frame of the track is ok inside that range, so there is nothing to write.");
  if (frames.length > MAX_KEYS) {
    throw new PlanarError("bad_args", `The track has ${frames.length} frames to write, over the ${MAX_KEYS} keys per property one call writes. Narrow the write with range: {start, end}; each call writes one span, and with replace_keys it replaces ALL keys on the property, not only the span.`);
  }

  let keys: LayerKeys | null = null;
  let nullKeys: NullKeys[] = [];
  let size: Vec2 = [0, 0];

  const prep = await queued(ctx, label, opId, async () => {
    const comp = await readComp(ctx, opId, a.compId, target.layer ? [target.layer] : undefined, a.toolName);
    if (comp.width !== based.comp_size[0] || comp.height !== based.comp_size[1]) {
      throw new PlanarError("refused", `The track was made in a ${based.comp_size[0]}x${based.comp_size[1]} comp and comp ${a.compId} is ${comp.width}x${comp.height}: the points are in comp pixels, so the sizes must match.`);
    }
    if (target.mode === "nulls") return { layer: null, ref: null, samples: null, width: 0, height: 0, refPin: undefined as Vec2[] | undefined };
    const layer = comp.layers[0] ?? null;
    if (!layer) throw new PlanarError("not_found", "The target layer was not found.");
    if (layer.locked) throw new PlanarError("refused", `Layer "${layer.name}" is locked.`);
    if (layer.three_d) throw new PlanarError("refused", `Layer "${layer.name}" is a 3D layer; planar tracks work in 2D only.`);
    const ref = await readLayerSpace(ctx, opId, "refspace", a.compId, layer, [refTime], a.toolName);
    const got = await readLayerSpace(ctx, opId, "space", a.compId, layer, frames.map((f) => f.time), a.toolName);
    // An existing pin already placed on the target: its points at ref_time are the placement to carry, not the layer's plain rectangle.
    let refPin: Vec2[] | undefined;
    if (target.mode === "corner_pin" || target.mode === "power_pin" || target.mode === "transform_pin") {
      const kind = target.mode === "power_pin" ? "power_pin" : "corner_pin";
      const pinRead = await read<KeysRead>(
        ctx,
        opId,
        "refpin",
        "planarKeys",
        { comp_id: a.compId, items: [{ layer_id: layer.id, kind, ...(target.effect_index !== undefined ? { effect_index: target.effect_index } : {}), times: [refTime] }] },
        a.toolName
      );
      const item = pinRead.items?.[0];
      if (item && item.found && item.effect_found !== false) {
        const pts: Vec2[] = [];
        for (const role of ["ul", "ur", "ll", "lr"]) {
          const v = item.props.find((pp) => pp.role === role)?.samples?.[0]?.value;
          if (Array.isArray(v) && typeof v[0] === "number" && typeof v[1] === "number") pts.push([v[0], v[1]]);
        }
        if (pts.length === 4) refPin = pts;
      }
    }
    return { layer, ref: ref.samples[0], samples: got.samples, width: ref.width, height: ref.height, refPin };
  });

  const notes: string[] = [];
  if (typeof based.comp_id === "number" && based.comp_id !== a.compId) {
    notes.push(`The track was made in comp ${based.comp_id} and was applied to comp ${a.compId} (same size, so the points line up only if both comps show the same shot).`);
  }
  const mode = target.mode;
  if (mode === "nulls") {
    nullKeys = buildNullKeys({ track: based, frames, prefix: target.null_prefix ?? "Track", solved: target.solved_null === true });
    if (nullKeys.length === 0) throw new PlanarError("bad_args", "No point has a position in the chosen frames, so no null can be made.");
  } else {
    size = [prep.width, prep.height];
    if (!(size[0] > 0) || !(size[1] > 0)) {
      throw new PlanarError("refused", `Layer "${prep.layer?.name}" has no width and height (it is not a footage, solid or comp layer), so its corners cannot be pinned.`);
    }
    keys = buildLayerKeys({ mode, frames, ref: prep.ref!, samples: prep.samples!, size, refPin: prep.refPin });
    if (prep.refPin) notes.push("The pin effect already on the layer was used as the placement at ref_time: its four points at that frame were carried along the track (not the layer's plain rectangle).");
    if (keys.times.length === 0) throw new PlanarError("bad_args", "No frame could be converted into keys for that layer (every frame was degenerate).");
    if ((mode === "transform" || mode === "transform_pin") && based.model !== "translate" && based.model !== "similarity") {
      notes.push(`The ${based.model} track was fitted with a similarity for the layer transform (largest corner deviation ${keys.max_fit_px} px).${mode === "transform" ? " Use transform_pin for the rest." : ""}`);
    }
    if (mode === "corner_pin" || mode === "power_pin" || mode === "transform_pin") notes.push(MOTION_BLUR_NOTE);
  }

  // What the write is expected to leave behind, for the receipt.
  const expected: Expected[] = [];
  const writes: Array<Record<string, unknown>> = [];
  const pinKind = mode === "power_pin" ? "power_pin" : "corner_pin";
  const lay = prep.layer;
  if (keys && lay) {
    if (keys.pin) {
      writes.push({
        layer_index: lay.index,
        layer_id: lay.id,
        target: pinKind,
        ...(target.effect_index !== undefined ? { effect_index: target.effect_index } : {}),
        add_effect: target.add_effect !== false,
        replace_keys: target.replace_keys === true,
        times: keys.times,
        values: keys.pin,
      });
      for (const role of ["ul", "ur", "ll", "lr"] as const) expected.push(expectedFor(pinKind, lay.id, role, keys.times, keys.pin[role]));
    }
    if (keys.transform) {
      writes.push({
        layer_index: lay.index,
        layer_id: lay.id,
        target: "transform",
        replace_keys: target.replace_keys === true,
        times: keys.times,
        values: keys.transform,
      });
      expected.push(expectedFor("transform", lay.id, "position", keys.times, keys.transform.position));
      expected.push(expectedFor("transform", lay.id, "rotation", keys.times, keys.transform.rotation));
      expected.push(expectedFor("transform", lay.id, "scale", keys.times, keys.transform.scale));
    }
  }
  for (const nk of nullKeys) {
    expected.push(expectedFor("transform", null, "position", nk.times, nk.position, { nullName: nk.name }));
    if (nk.rotation) expected.push(expectedFor("transform", null, "rotation", nk.times, nk.rotation, { nullName: nk.name }));
    if (nk.scale) expected.push(expectedFor("transform", null, "scale", nk.times, nk.scale, { nullName: nk.name }));
  }

  const expect: ExpectGuard = { project_path: a.expect.project_path, comp_id: a.expect.comp_id ?? a.compId };
  const sampleTimes = (times: number[]) => sampleIdx(times.length).map((i) => times[i]);
  const result = await runGuardedWrite<Record<string, unknown> & Partial<HostWritten>>(ctx, {
    toolName: a.toolName,
    label,
    expect,
    compId: a.compId,
    read: (phase, written) => {
      const items: Array<Record<string, unknown>> = [];
      if (lay && keys) {
        if (phase === "before") {
          if (keys.pin) items.push({ layer_id: lay.id, kind: pinKind, ...(target.effect_index !== undefined ? { effect_index: target.effect_index } : {}), times: [] });
          if (keys.transform) items.push({ layer_id: lay.id, kind: "transform", times: [] });
        } else {
          if (keys.pin) {
            const w = (written as HostWritten | undefined)?.written?.find((x) => x.target === pinKind);
            items.push({ layer_id: lay.id, kind: pinKind, ...(w?.effect_index !== undefined ? { effect_index: w.effect_index } : {}), times: sampleTimes(keys.times) });
          }
          if (keys.transform) items.push({ layer_id: lay.id, kind: "transform", times: sampleTimes(keys.times) });
        }
      }
      if (phase === "after") {
        for (const n of (written as HostWritten | undefined)?.nulls ?? []) {
          const nk = nullKeys.find((k) => k.name === n.name);
          items.push({ layer_id: n.layer_id, kind: "transform", times: nk ? sampleTimes(nk.times) : [] });
        }
      }
      return items.length ? { host: "planarKeys", args: { comp_id: a.compId, items } } : null;
    },
    write: {
      host: "planarApply",
      args: { comp_id: a.compId, writes, new_nulls: nullKeys, replace_keys: target.replace_keys === true },
      timeoutMs: SLOW_TIMEOUT_MS,
    },
    check: (_before, after, written) => keyMismatches(expected, written as unknown as HostWritten, after as KeysRead | null),
  });

  const w = result as unknown as { written?: HostWritten["written"]; nulls?: HostWritten["nulls"]; checkpoint: unknown; receipt: unknown; op_id: string };
  const pinWrite = w.written?.find((x) => x.target === pinKind);
  if (pinWrite?.effect_added && pinWrite.slot_moved === false && pinWrite.slot_wanted !== undefined && pinWrite.slot_wanted !== pinWrite.effect_index) {
    notes.push(`The pin effect sits at index ${pinWrite.effect_index}, not at its place (${pinWrite.slot_wanted}) in the patch-layer effect order: this AE build gave no moveTo, so move it by hand.`);
  }
  if (target.replace_keys) notes.push("Existing keys on the written properties were replaced.");
  // Frames the track could not solve, and frames that could not be turned into keys, are not written.
  const skipped = [...notOk, ...(keys ? keys.skipped : [])].sort((x, y) => x - y);
  if (skipped.length > 0) notes.push(`${skipped.length} frame(s) were not written (not ok in the track, or degenerate for this layer); the keys interpolate across them.`);
  return {
    ok: true,
    op_id: w.op_id,
    applied: true,
    mode,
    track_id: based.track_id,
    ref_time: r4(refTime),
    frames_written: keys ? keys.times.length : Math.max(0, ...nullKeys.map((n) => n.times.length)),
    ...(skipped.length ? { frames_skipped: skipped.slice(0, 100).map(r4), frames_skipped_total: skipped.length } : {}),
    ...(lay ? { layer: { index: lay.index, id: lay.id, name: lay.name } } : {}),
    // The keys say where the layer should be; the render says whether it sticks. This call measures slip on renders along the same track.
    ...(lay
      ? {
          verify_with: {
            tool: "ae_patch_check",
            why: "Renders a few frames and measures whether the layer slides against the plate along this track (slip, within 0.1 px on a test insert), plus seam and edge.",
            arguments: { comp_id: a.compId, patch_layers: [{ id: lay.id }], region_track: { track_id: based.track_id }, grain_probes: 0 },
          },
        }
      : {}),
    written: w.written ?? [],
    nulls: (w.nulls ?? []).map((n) => ({ id: n.layer_id, index: n.layer_index, name: n.name, keys: n.props.map((p) => `${p.role}:${p.numKeys}`).join(" ") })),
    notes,
    ...(adjusted.info ? { track_adjusted: adjusted.info } : {}),
    ...(a.trackNote ?? {}),
    checkpoint: w.checkpoint,
    receipt: w.receipt,
    ...(result.user_changed ? { user_changed: result.user_changed } : {}),
  };
}

// ---------- ae_track_multi ----------

interface TrackOptionsStored {
  model: MotionModel;
  pattern_size: number;
  search_radius: number;
  min_confidence: number;
  warp_patterns: boolean;
  pre_blur: number;
  channel: Channel;
  isolate_layers?: LayerSelector[];
  /** points (the default, older tracks have none), region or screen. */
  method?: "points" | "region" | "screen";
  /** screen: the key read at ref_time. */
  screen_key?: ScreenKey;
  /** region: the area followed; points: where frames are checked (null: not checked). */
  area?: Region | null;
  exclude?: Region[];
}

interface LiveTrack {
  forward: DirectionTracker | null;
  backward: DirectionTracker | null;
}

/** Trackers kept between calls so a continued chunk matches a single long call exactly. A cache only: the track file has everything to rebuild them. */
const LIVE = new Map<string, LiveTrack>();
const LIVE_MAX = 20;

function remember(id: string, live: LiveTrack): void {
  LIVE.delete(id);
  LIVE.set(id, live);
  while (LIVE.size > LIVE_MAX) LIVE.delete(LIVE.keys().next().value as string);
}

const emptyDirection = (nextTime: number | null, n: number): TrackingDirection => ({
  done: nextTime === null,
  next_time: nextTime,
  stop: nextTime === null ? { time: 0, reason: "end" } : null,
  last_points: new Array<Vec2 | null>(n).fill(null),
  last_H: identityH(),
});

function mergeFrames(existing: PlanarFrame[], added: PlanarFrame[], fps: number): PlanarFrame[] {
  const byFrame = new Map<number, PlanarFrame>();
  for (const f of existing) byFrame.set(Math.round(f.time * fps), f);
  for (const f of added) byFrame.set(Math.round(f.time * fps), f);
  return [...byFrame.entries()].sort((a, b) => a[0] - b[0]).map(([, f]) => f);
}

const isBlocked = (err: unknown) => err instanceof BridgeError && (err.kind === "timeout" || err.kind === "queued");

async function trackMulti(ctx: ToolContext, args: AeTrackMultiArgs): Promise<Record<string, unknown>> {
  const toolName = "ae_track_multi";
  const opId = ctx.bridge.newOpId();
  const framesDir = defaultFramesDir();
  fs.mkdirSync(framesDir, { recursive: true });
  const label = `ae_track_multi(${args.comp_id})`;
  const budget = createRenderBudget({ maxRenders: args.max_frames, maxSeconds: args.max_seconds });

  let stored: PlanarTrack | null = null;
  if (args.continue_track_id) {
    stored = loadTrack(args.continue_track_id);
    if (!stored || !stored.tracking) throw new PlanarError("not_found", `No stored multi-point track "${args.continue_track_id}" to continue.`);
    if (stored.comp_id !== args.comp_id) throw new PlanarError("bad_args", `Track ${args.continue_track_id} was made in comp ${stored.comp_id}, not ${args.comp_id}.`);
  }
  const storedOpts = stored?.tracking?.options as unknown as TrackOptionsStored | undefined;
  const isolate = args.isolate_layers ?? storedOpts?.isolate_layers;
  if (isolate && !args.expect) throw new PlanarError("bad_args", "isolate_layers writes to the project (a temporary comp), so `expect` is required.");
  const expect: ExpectGuard | null = args.expect ? { project_path: args.expect.project_path, comp_id: args.expect.comp_id ?? args.comp_id } : null;

  // isolate_layers writes (a temporary comp), so it obeys the quarantine like every guarded write.
  if (isolate && expect) ctx.quarantine.assertClear();

  const ran = await queued(ctx, label, opId, async () => {
    const comp = await readComp(ctx, opId, args.comp_id, isolate, toolName);
    const fps = comp.fps > 0 ? comp.fps : 25;
    const compSize: Vec2 = [comp.width, comp.height];

    // Range and reference frame.
    let start: number;
    let end: number;
    let refTime: number;
    if (stored) {
      start = stored.tracking!.range.start;
      end = stored.tracking!.range.end;
      refTime = stored.ref_time;
    } else {
      start = snapFrame(args.start ?? comp.work_area_start, fps);
      end = snapFrame(args.end ?? comp.work_area_start + comp.work_area_duration - 1 / fps, fps);
      if (end < start) throw new PlanarError("bad_args", "end is before start.");
      const dflt = comp.time >= start && comp.time <= end ? comp.time : (start + end) / 2;
      refTime = snapFrame(args.ref_time ?? dflt, fps);
      if (refTime < start - 1e-6 || refTime > end + 1e-6) throw new PlanarError("bad_args", `ref_time ${r2(refTime)} s is outside the range ${r2(start)}-${r2(end)} s.`);
    }
    const notes: string[] = [];
    if (!stored && Math.round((end - start) * fps) + 1 > MAX_TRACK_FRAMES) {
      // Cut the range AROUND the reference frame: `points` are comp px at ref_time, so that frame must not move.
      const span = (MAX_TRACK_FRAMES - 1) / fps;
      const half = Math.floor((MAX_TRACK_FRAMES - 1) / 2) / fps;
      const newStart = snapFrame(Math.max(start, Math.min(refTime - half, end - span)), fps);
      const newEnd = snapFrame(Math.min(end, newStart + span), fps);
      start = newStart;
      end = newEnd;
      notes.push(`The range was cut to ${MAX_TRACK_FRAMES} frames (${r2(start)}-${r2(end)} s, around ref_time ${r2(refTime)} s), the most one track holds.`);
    }

    const o: TrackOptionsStored = stored
      ? (stored.tracking!.options as unknown as TrackOptionsStored)
      : {
          model: args.model ?? "translate",
          pattern_size: args.pattern_size | 1,
          search_radius: args.search_radius,
          min_confidence: args.min_confidence,
          warp_patterns: args.warp_patterns ?? true,
          pre_blur: args.pre_blur ?? 0,
          channel: args.channel,
          ...(args.isolate_layers ? { isolate_layers: args.isolate_layers } : {}),
          method: args.region ? "region" : args.screen ? "screen" : "points",
          ...(args.region ? { area: args.region.area, exclude: args.region.exclude ?? [] } : { exclude: args.auto_points?.exclude ?? [] }),
        };
    if (!stored && (o.method === "region" || o.method === "screen")) {
      if (args.model && args.model !== "perspective") notes.push(`A ${o.method} track is solved in perspective; model "${args.model}" was not used. Write it with ae_track_apply refit_model: "${args.model}" for fewer parameters.`);
      o.model = "perspective";
    }
    const maxMisses = maxMissesFor(fps);
    const prep = (png: RgbaImage): GrayImage => boxBlurGray(channelGray(png, o.channel), o.pre_blur);

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

    // Renders spent rebuilding a continued track's reference frame: not charged to the budget, but still reported.
    let rebuildRenders = 0;
    // A rebuilt continued call always tracks at least one frame, whatever max_seconds says, or it would return the same `next` forever.
    let mustAdvance = false;
    const chunk = async (renderCompId: number) => {
      const snap = async (time: number, index: number, charge = true) => {
        const s = await captureCompFrame({ ctx, opId, compId: renderCompId, time, frameIndex: index, framesDir, toolName });
        if (charge) budget.spend();
        else rebuildRenders++;
        try {
          return decodePngFile(s.path);
        } finally {
          fs.rmSync(s.path, { force: true });
        }
      };

      const cached = stored ? LIVE.get(stored.track_id) : undefined;
      // The reference frame: needed for new tracks, and to rebuild the trackers after a restart.
      let refPng: PNG | null = null;
      let refGray: GrayImage | null = null;
      let scale = 1;
      let refPoints: Vec2[];
      let chosen: Array<{ x: number; y: number; score: number; std: number }> | null = null;
      if (!stored || !cached) {
        // Rebuilding a continued track's trackers is not tracking: it is not charged to max_frames, or a small budget could never move on.
        refPng = await snap(refTime, 0, !stored);
        if (stored) mustAdvance = true;
        await yieldLoop();
        refGray = prep(refPng);
        scale = refPng.width / compSize[0];
      }
      if (stored) {
        refPoints = stored.ref_points;
        if (cached) scale = (cached as LiveTrack & { scale?: number }).scale ?? scale;
      } else if (args.region) {
        refPoints = (args.quad as Vec2[] | undefined) ?? quadOfRegion(args.region.area);
      } else if (args.screen) {
        // The key inside the corners, and the corners snapped to its edge.
        const rough = (args.screen.corners as Vec2[]).map((p) => [p[0] * scale - 0.5, p[1] * scale - 0.5] as Vec2);
        if (!quadCheck(rough).ok) throw new PlanarError("bad_args", "The screen's corners do not make a quad: give them as [UL, UR, LR, LL].");
        const key = sampleKey(refPng!, rough);
        if (!key) throw new PlanarError("bad_args", "The inside of those corners is not one saturated colour (a green or blue screen), so there is no key edge to follow. Use region for a screen showing a picture, or points on its corners and markers.");
        const fit = fitScreenQuad(keyStrength(refPng!, key, [0, 0, refPng!.width, refPng!.height]), rough, Math.max(6, Math.round(12 * scale)));
        if (!fit.ok) throw new PlanarError("bad_args", `The screen's outline was not found near those corners at ref_time: ${fit.why}. Give the corners within about 10 px of where the key colour ends.`);
        o.screen_key = key;
        refPoints = fit.corners.map((p) => [r4((p[0] + 0.5) / scale), r4((p[1] + 0.5) / scale)] as Vec2);
      } else if (args.points) {
        refPoints = args.points as Vec2[];
      } else {
        const ap = args.auto_points!;
        const patchImg = Math.max(9, Math.round(o.pattern_size * scale) | 1);
        const longer = regionLongerSide(ap.region);
        const minDist = (ap.min_distance_px ?? Math.max(o.pattern_size, longer / 10)) * scale;
        const full = regionMask(refPng!.width, refPng!.height, scale, ap.region, ap.exclude ?? [], o.pattern_size);
        // Whole patterns inside the region: a point on its edge carries whatever is behind it (a background, an easel).
        const inner = erodeMask(full, refPng!.width, refPng!.height, Math.floor(patchImg / 2));
        const blurred = boxBlurGray(toGray(refPng!), 1);
        chosen = goodFeatures(blurred, inner, { count: ap.count, minDistancePx: minDist, patchSize: patchImg, spread: true });
        if (chosen.length < Math.min(ap.count, 4)) chosen = goodFeatures(blurred, full, { count: ap.count, minDistancePx: minDist, patchSize: patchImg, spread: true });
        await yieldLoop();
        if (chosen.length === 0) throw new PlanarError("not_found", "No trackable corner was found in that region (it is flat, too small or fully excluded). Widen the region or pick points by hand.");
        refPoints = chosen.map((c) => [r2((c.x + 0.5) / scale), r2((c.y + 0.5) / scale)] as Vec2);
      }

      // Trackers, one per direction.
      const mkOpts = (): MultiTrackOptions => ({
        model: o.model,
        patchSize: o.pattern_size,
        searchRadius: o.search_radius,
        minConfidence: o.min_confidence,
        warpPatterns: o.warp_patterns,
        ransacPx: Math.max(2, o.pattern_size / 10),
        seed: 1234,
      });
      let state: TrackingState;
      const quad: Vec2[] = stored ? stored.tracking!.quad : o.method === "screen" ? refPoints : ((args.quad as Vec2[] | undefined) ?? (o.method === "region" ? refPoints : boundingQuad(refPoints)));
      let fwd: DirectionTracker | null = cached?.forward ?? null;
      let bwd: DirectionTracker | null = cached?.backward ?? null;
      let dropped: Array<{ index: number; reason: string }>;
      if (!stored && (o.method === "region" || o.method === "screen")) {
        dropped = [];
        const fw: number[] = refTime < end - 1e-9 ? trackTimes(refTime + 1 / fps, end, fps, MAX_TRACK_FRAMES) : [];
        const bw: number[] = refTime > start + 1e-9 ? trackTimes(refTime - 1 / fps, start, fps, MAX_TRACK_FRAMES) : [];
        state = {
          options: o as unknown as Record<string, unknown>,
          range: { start, end },
          quad,
          forward: emptyDirection(fw.length ? fw[0] : null, refPoints.length),
          backward: emptyDirection(bw.length ? bw[0] : null, refPoints.length),
          dropped,
        };
      } else if (!stored) {
        o.area = verifyAreaFor({ quad: args.quad as Vec2[] | undefined, autoRegion: args.auto_points?.region, points: refPoints, patternSize: o.pattern_size });
        // Model: translate for one point, similarity for more, unless asked.
        const probe = new MultiTracker(refGray!, refPoints, scale, { ...mkOpts(), model: "translate" }, quad);
        const aliveN = probe.alive;
        if (!args.model) o.model = aliveN <= 1 ? "translate" : "similarity";
        dropped = probe.dropped;
        if (aliveN < MODEL_MIN_POINTS[o.model]) {
          throw new PlanarError(
            "bad_args",
            `Only ${aliveN} of ${refPoints.length} points have a pattern to follow (${dropped.map((d) => `#${d.index + 1}: ${d.reason}`).join(" | ") || "none dropped"}); the ${o.model} model needs ${MODEL_MIN_POINTS[o.model]}. Pick points on corners or marks, or choose a simpler model.`
          );
        }
        const fw: number[] = refTime < end - 1e-9 ? trackTimes(refTime + 1 / fps, end, fps, MAX_TRACK_FRAMES) : [];
        const bw: number[] = refTime > start + 1e-9 ? trackTimes(refTime - 1 / fps, start, fps, MAX_TRACK_FRAMES) : [];
        state = {
          options: o as unknown as Record<string, unknown>,
          range: { start, end },
          quad,
          forward: emptyDirection(fw.length ? fw[0] : null, refPoints.length),
          backward: emptyDirection(bw.length ? bw[0] : null, refPoints.length),
          dropped,
        };
        if (o.model === "perspective" && aliveN === 4) notes.push("Perspective from exactly 4 points has no redundancy: nothing can vote a bad point out. Use 5-8 points on the same plane.");
        if (o.model === "similarity" && aliveN === 2 && Math.hypot(refPoints[0][0] - refPoints[1][0], refPoints[0][1] - refPoints[1][1]) < 100) {
          notes.push("The two points are less than 100 px apart: rotation noise is about position noise divided by that distance. Spread them out.");
        }
      } else {
        state = stored.tracking!;
        dropped = state.dropped;
      }
      const opts = mkOpts();
      // The region (a region track's area, or where a points track is checked), built once when trackers are made.
      let aligner: RegionAligner | null = null;
      if (((!state.forward.done && !fwd) || (!state.backward.done && !bwd)) && o.area) {
        try {
          aligner = new RegionAligner(refGray!, regionMask(refGray!.width, refGray!.height, scale, o.area, o.exclude ?? [], 0));
        } catch (err) {
          if (o.method === "region") {
            throw new PlanarError(
              "bad_args",
              `The region cannot be followed by its pixels: ${errMessage(err)}. A plain surface (a green screen without markers) has nothing to align: track its markers or corners with points, or widen the area to take in its edges and bezel.`
            );
          }
          if (!stored) notes.push(`Frames are not checked against the surface (${errMessage(err)}): judge the track by the preview.`);
        }
      }
      const fresh = (dir: "forward" | "backward"): DirectionTracker => {
        const ds = state[dir];
        if (o.method === "region") {
          const d = new RegionDirection(aligner!, quad, scale, maxMisses);
          if (stored) d.restore(ds.last_H, ds.prev_H ?? null);
          return d;
        }
        if (o.method === "screen") {
          const d = new ScreenDirection(o.screen_key!, quad, scale, maxMisses);
          if (stored) d.restore(ds.last_H, ds.prev_H ?? null);
          return d;
        }
        const mt = new MultiTracker(refGray!, refPoints, scale, opts, quad);
        if (stored) mt.restore(ds.last_points, ds.last_H);
        return aligner ? new VerifiedPoints(mt, aligner, scale, o.model === "perspective", maxMisses) : mt;
      };
      if (!state.forward.done && !fwd) fwd = fresh("forward");
      if (!state.backward.done && !bwd) bwd = fresh("backward");

      // The reference frame itself.
      const aliveRef = refPoints.map((_, i) => !dropped.some((d) => d.index === i));
      const refFrame: PlanarFrame = {
        time: refTime,
        ok: true,
        H: identityH(),
        points: refPoints.map((p, i) => (aliveRef[i] ? p : null)),
        confidence: refPoints.map((_, i) => (aliveRef[i] ? 1 : null)),
        rms_px: 0,
        expected_px: 0,
        inliers: aliveRef.filter(Boolean).length,
      };

      const added: PlanarFrame[] = [refFrame];
      type End = { png: PNG; frame: PlanarFrame } | null;
      const ends = { forward: null as End, backward: null as End };
      const run_ = { renderError: null as string | null, blocked: false, reacquired: 0 };

      const run = async (dir: "forward" | "backward", mt: DirectionTracker | null) => {
        const ds = state[dir];
        if (ds.done || !mt || run_.renderError) return;
        const times = dir === "forward" ? trackTimes(ds.next_time as number, end, fps, MAX_TRACK_FRAMES) : trackTimes(ds.next_time as number, start, fps, MAX_TRACK_FRAMES);
        let i = 0;
        for (; i < times.length; i++) {
          if (!mustAdvance && budget.exhausted()) break;
          let png: PNG;
          try {
            png = await snap(times[i], (dir === "forward" ? 1 : 100001) + i);
            mustAdvance = false;
          } catch (err) {
            run_.renderError = errMessage(err);
            run_.blocked = isBlocked(err);
            break;
          }
          await yieldLoop();
          const res = mt.step(prep(png), times[i], png);
          await yieldLoop();
          if (res.stop) {
            ds.done = true;
            ds.stop = { time: times[i], reason: res.stop };
            ds.next_time = null;
            return;
          }
          const fr = res.frame as PlanarFrame;
          run_.reacquired += res.reacquired.length;
          added.push(fr);
          ds.last_points = fr.points.map((p, k) => p ?? ds.last_points[k] ?? null);
          ds.last_H = mt.lastH;
          if (mt.prevH) ds.prev_H = mt.prevH;
          ends[dir] = { png, frame: fr };
        }
        if (i >= times.length && !run_.renderError) {
          ds.done = true;
          ds.stop = { time: times[times.length - 1] ?? refTime, reason: "end" };
          ds.next_time = null;
        } else if (i < times.length) {
          ds.next_time = times[i];
        }
      };
      await run("forward", fwd);
      await run("backward", bwd);

      // The track, merged with what earlier chunks stored.
      const track: PlanarTrack = stored
        ? { ...stored, frames: mergeFrames(stored.frames, added, fps), tracking: state }
        : {
            version: 1,
            track_id: newTrackId(),
            comp_id: args.comp_id,
            comp_size: compSize,
            fps,
            ref_time: refTime,
            model: o.model,
            ref_points: refPoints,
            frames: mergeFrames([], added, fps),
            source: "ae_track_multi",
            created: new Date().toISOString(),
            tracking: state,
          };
      remember(track.track_id, Object.assign({ forward: fwd, backward: bwd }, { scale }));
      track.tracking!.options = o as unknown as Record<string, unknown>;
      if (track.tracking!.forward.done && track.tracking!.backward.done) {
        flagUnreliableFrames(track);
        flagPathJumps(track);
      }
      saveTrack(track);

      let previewPath: string | undefined;
      let previewError: string | undefined;
      if (args.preview) {
        try {
          const tiles: SheetTile[] = [];
          const lb = ends.backward;
          const lf = ends.forward;
          if (lb) tiles.push({ image: lb.png, frame: lb.frame, label: `t=${r2(lb.frame.time)}` });
          refPng ??= await snap(refTime, 999999);
          tiles.push({ image: refPng, frame: refFrame, label: `ref t=${r2(refTime)}` });
          if (lf) tiles.push({ image: lf.png, frame: lf.frame, label: `t=${r2(lf.frame.time)}` });
          previewPath = writeSheet(framesDir, `${track.track_id}_${opId}`, drawTrackSheet(tiles, { quad, patchSize: o.pattern_size, compSize }));
        } catch (err) {
          previewError = errMessage(err);
        }
      }
      return { track, notes, previewPath, previewError, chosen, scale, renderError: run_.renderError, blocked: run_.blocked, reacquired: run_.reacquired, dropped };
    };

    let value: Awaited<ReturnType<typeof chunk>>;
    let temp: { copy_id: number; removed: boolean; error?: string } | null = null;
    if (showLayers && expect) {
      let wrapped: Awaited<ReturnType<typeof withIsolatedPlate<Awaited<ReturnType<typeof chunk>>>>>;
      try {
        wrapped = await withIsolatedPlate(ctx, opId, { compId: args.comp_id, showLayers, expect, toolName, note }, chunk);
      } catch (err) {
        const plateTemp = (err as { plateTemp?: { copy_id: number; removed: boolean; error?: string } } | null)?.plateTemp;
        // No copy was made: nothing was written, so the error goes up as it is.
        if (!plateTemp) throw err;
        const made = await verifyPlateGone(ctx, opId, plateTemp, toolName);
        // The copy exists (or existed): the write happened, so report it instead of throwing.
        try {
          await noteAfterWrite(ctx, note!, { addStep: true });
        } catch {
          // reporting only
        }
        return {
          failure: {
            error: err instanceof PlanarError ? err.code : "failed",
            message: errMessage(err),
            temp: made,
            checkpoint,
            sessionFields,
          },
        };
      }
      value = wrapped.value;
      temp = wrapped.temp ? await verifyPlateGone(ctx, opId, wrapped.temp, toolName) : null;
      await noteAfterWrite(ctx, note!, { addStep: true });
    } else {
      value = await chunk(args.comp_id);
    }
    return { ...value, temp, checkpoint, sessionFields, fps, rendersUsed: budget.used.renders, rebuildRenders };
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
  const { track } = ran;
  const st = track.tracking!;
  const finished = st.forward.done && st.backward.done;
  const nextDir = !st.forward.done ? "forward" : !st.backward.done ? "backward" : null;
  const nextTime = nextDir === "forward" ? st.forward.next_time : nextDir === "backward" ? st.backward.next_time : null;
  const notes = [...ran.notes];
  const method = (st.options as unknown as TrackOptionsStored).method ?? "points";
  if (method === "screen") notes.push("A screen track follows where the key colour ends: the corners are where its sides' lines meet, so a corner covered by a hand is still placed from its sides. The ref_points are the snapped corners at ref_time.");
  else if (method === "region") notes.push("The area must be one flat surface: whatever in it is at another depth (a frame's edge standing out, a shelf) moves differently and is pushed out of the fit, but a large part of it off the plane pulls the solve.");
  else notes.push("Points must lie on one plane: a point on a different depth slides against the others and the fit gets worse (see rms_px).");
  const lostDir = [st.forward, st.backward].find((d) => d.stop?.reason === "lost");
  if (lostDir && lostDir.stop) notes.push(`A direction stopped at ${r2(lostDir.stop.time)} s: ${maxMissesFor(ran.fps)} frames in a row did not line up with the surface (gone, covered, or out of frame). Frames past it are not in the track; track that part again from a reference frame inside it.`);
  if (ran.temp) notes.push("isolate_layers made a temporary copy of the comp and removed it again: two undo entries, one for each.");
  if (ran.blocked) notes.push("AE stopped responding during a render (often a modal dialog); check ae_dialogs and continue the track.");
  const baseMismatches: ReceiptMismatch[] = [];
  if (ran.temp && !ran.temp.removed) {
    baseMismatches.push({
      path: "temp_comp",
      expected: "the temporary comp removed",
      actual: ran.temp.error ?? "not removed",
      message: `The temporary comp (id ${ran.temp.copy_id}) was not removed${ran.temp.error ? `: ${ran.temp.error}` : ""}. Delete it in the Project panel; its name starts with "_chroma_plate_".`,
    });
  }
  const result: Record<string, unknown> = {
    ok: true,
    ...trackSummary(track),
    complete: finished,
    directions: {
      forward: { done: st.forward.done, stop: st.forward.stop, next_time: st.forward.next_time },
      backward: { done: st.backward.done, stop: st.backward.stop, next_time: st.backward.next_time },
    },
    ...(finished ? {} : { next: { direction: nextDir, time: nextTime }, continue_track_id: track.track_id }),
    points: track.ref_points.map((p, i) => ({
      index: i + 1,
      x: r2(p[0]),
      y: r2(p[1]),
      ...(ran.chosen && ran.chosen[i] ? { score: r2(ran.chosen[i].score), contrast: r2(ran.chosen[i].std), auto: true } : {}),
      ...(st.dropped.some((d) => d.index === i) ? { dropped: st.dropped.find((d) => d.index === i)!.reason } : {}),
    })),
    reacquired_points_this_call: ran.reacquired,
    ...(ran.previewPath ? { preview_path: ran.previewPath } : {}),
    ...(ran.previewError ? { preview_error: ran.previewError } : {}),
    ...(ran.renderError ? { render_error: ran.renderError } : {}),
    ...(ran.temp ? { temp_comp: { copy_removed: ran.temp.removed, ...(ran.temp.error ? { error: ran.temp.error } : {}) } } : {}),
    ...(ran.temp ? { checkpoint: ran.checkpoint, receipt: buildReceipt({ before: null, after: { temp_comp: ran.temp }, customMismatches: baseMismatches }), ...ran.sessionFields } : {}),
    notes,
  };
  result.budget = { max_frames: args.max_frames, max_seconds: args.max_seconds, renders_this_call: ran.rendersUsed, ...(ran.rebuildRenders ? { rebuild_renders: ran.rebuildRenders } : {}) };

  if (args.apply && expect) {
    if (!finished) {
      result.apply = { applied: false, message: "The track is not complete yet. Continue it (continue_track_id) with the same `apply` to write it on the last chunk." };
    } else {
      try {
        result.apply = await applyTrackTo(ctx, { compId: args.comp_id, track, target: args.apply, expect, toolName });
      } catch (err) {
        // The track is saved and the isolate write is done: keep both in the result whatever went wrong.
        result.apply = { applied: false, error: err instanceof PlanarError ? err.code : "failed", message: errMessage(err) };
      }
    }
  }
  return result;
}

// ---------- tools ----------

export const planarTools: ToolDefinition<any>[] = [
  {
    name: "ae_track_multi",
    description:
      "Track 1-8 points together through a comp, inside the MCP (nothing to install): AE renders each frame once and every point is followed on it by normalized cross-correlation, then a motion model is solved per frame (translate, similarity = position+rotation+scale, affine, perspective). " +
      "Runs forwards AND backwards from a reference frame (`ref_time`, where `points` apply), so a frame you cleaned can be tracked back. A lost point is re-acquired where the other points' motion says it should be; the track stops only when too few points survive (reported with the frame and reason: lost, or cut). " +
      "For a textured flat surface (a sign, a wall, a painting, a screen showing a picture) give `region` {area, exclude}: every textured pixel of the area is aligned to the reference frame (perspective), people and objects crossing in front are pushed out of the fit, and it is the most accurate (0.1-0.35 px on real plates, through a person walking in front). Otherwise give `points`, or `auto_points` {region, exclude, count} to let the tool pick Shi-Tomasi corners inside a region and outside the object you are removing; the chosen points come back. Points must lie on ONE plane. " +
      "Every frame is checked against the surface (the region, `quad`, the auto_points region or the points' hull): a frame that does not line up is ok false with a note (frames_not_ok) and is never written as a key; two seconds of such frames in a row stop the direction as lost. " +
      "`isolate_layers` renders a temporary copy of the comp with only the plate on, so patches and overlays above it cannot corrupt the track (the copy is removed in the same call; needs `expect`). " +
      "Long shots are chunked (`max_frames`, `max_seconds`): while `complete` is false, call again with `continue_track_id`. The result is a summary with at most 500 sampled frames; the full track is stored under `track_id` for ae_track_apply and the other planar tools. " +
      "`preview_path` is a contact sheet of the first, reference and last frame of the call with the points (cyan, lost ones red) and the surface quad (green): look at it before trusting the track. Judge the track by `expected_error_px` (how far the surface is likely off, per frame), `corner_jitter_px`, `sliding_points` (points that do not move with the plane) and `lens` (a lens that bends lines, seen when the points reach out towards the frame's edges), not by `rms_px`, which only says how well the points agree. When the corners shake (corner_jitter_px 1 px or more), `model_advice` gives the same points solved with fewer parameters and the model to write with (ae_track_apply refit_model, no new tracking); points that cover only a thin band of the surface make a perspective fit swing its corners. `apply` writes the finished track like ae_track_apply. Every frame is a render. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeTrackMultiSchema,
    handler: async (args: AeTrackMultiArgs, ctx: ToolContext) => {
      try {
        return await trackMulti(ctx, args);
      } catch (err) {
        if (err instanceof PlanarError) return fail(err);
        throw err;
      }
    },
  },
  {
    name: "ae_track_read",
    description:
      "Read a track that already exists in the project into the shared track format, and store it under a new `track_id` for ae_track_apply and the other planar tools. Changes nothing in the project. " +
      "Sources: `nulls` (1-8 layers' Position keys, ae_track_point's nulls included), `corner_pin` (a Corner Pin or CC Power Pin's four points, in the layer's own space converted to comp pixels: what Mocha AE's 'Create Track Data' and AE's Perspective Corner Pin tracker leave), `tracker` (AE Tracker track points on a layer), `transform` (a layer's Position/Rotation/Scale keys as a similarity track of its corners), or an existing `track_id`. " +
      "Keys are sampled on the comp's frame grid: the result says how many frames were interpolated, how many keys are off the grid, and which properties are expression-driven. It returns the parameter table it used for pin effects, because those point names are unverified. 3D layers and non-square pixels are refused. " +
      "Returns the same bounded summary and (with `preview`) contact sheet as ae_track_multi. Mocha's project data and the Warp Stabilizer / 3D Camera Tracker solves cannot be read. Keyframes Mocha or a Warp Stabilizer leave on 2D layers can; the 3D Camera Tracker's nulls and camera are 3D layers, which are refused.",
    schema: AeTrackReadSchema,
    handler: async (args: AeTrackReadArgs, ctx: ToolContext) => {
      const toolName = "ae_track_read";
      const opId = ctx.bridge.newOpId();
      const framesDir = defaultFramesDir();
      try {
        const got = await queued(ctx, `${toolName}(${args.comp_id})`, opId, async () => {
          const resolved = await resolveTrackSourceWithInfo(ctx, opId, args.comp_id, args.source);
          let track = resolved.track;
          const info = resolved.info;
          // A stored track re-based on another ref_time is a different track: it gets its own id and file, the original stays as it was.
          if (!args.source.track_id) saveTrack(track);
          else if (args.source.ref_time !== undefined) {
            const { tracking: _continueState, ...rest } = track;
            track = { ...rest, track_id: newTrackId(), source: `${track.source}+ref_time`, created: new Date().toISOString() };
            saveTrack(track);
          }
          let previewPath: string | undefined;
          let previewError: string | undefined;
          if (args.preview) {
            try {
              const okFrames = track.frames.filter((f) => f.ok);
              const pick = [okFrames[0], frameAt(track, track.ref_time), okFrames[okFrames.length - 1]].filter((f): f is PlanarFrame => !!f);
              const seen = new Set<number>();
              const tiles: SheetTile[] = [];
              let i = 0;
              for (const f of pick) {
                if (seen.has(f.time)) continue;
                seen.add(f.time);
                const s = await captureCompFrame({ ctx, opId, compId: args.comp_id, time: f.time, frameIndex: i++, framesDir, toolName });
                try {
                  tiles.push({ image: decodePngFile(s.path), frame: f, label: `t=${r2(f.time)}` });
                } finally {
                  fs.rmSync(s.path, { force: true });
                }
                await yieldLoop();
              }
              const refPts = track.ref_points;
              previewPath = writeSheet(framesDir, `${track.track_id}_${opId}`, drawTrackSheet(tiles, { quad: boundingQuad(refPts), patchSize: 31, compSize: track.comp_size }));
            } catch (err) {
              previewError = errMessage(err);
            }
          }
          return { track, info, previewPath, previewError };
        });
        const notes: string[] = [];
        const info = got.info ?? {};
        if ((info.interpolated_frames as number) > 0) notes.push(`${info.interpolated_frames} of ${got.track.frames.length} frames had no key on every point and were interpolated by AE.`);
        if ((info.off_grid_keys as number) > 0) notes.push(`${info.off_grid_keys} keys are off the frame grid; the track samples the grid, not the keys.`);
        if (Array.isArray(info.expression_driven) && info.expression_driven.length > 0) notes.push(`Expression-driven: ${(info.expression_driven as string[]).join(", ")} (read with valueAtTime, expressions evaluated).`);
        if (info.truncated) notes.push(`Only the first ${MAX_TRACK_FRAMES} frames were read; use start/end for the rest.`);
        if (info.param_table) notes.push("The pin effect's point names and order are unverified on this AE: check param_table (role UL/UR/LL/LR vs the name and how it was found).");
        if (got.track.model === "perspective" && got.track.ref_points.length === 4) notes.push("Perspective from exactly 4 points has no redundancy.");
        return {
          ok: true,
          ...trackSummary(got.track),
          source_info: info,
          ...(got.previewPath ? { preview_path: got.previewPath } : {}),
          ...(got.previewError ? { preview_error: got.previewError } : {}),
          notes,
        };
      } catch (err) {
        if (err instanceof PlanarError) return fail(err);
        throw err;
      }
    },
  },
  {
    name: "ae_track_apply",
    description:
      "Write a track onto the project in one undo step, relative to `ref_time` (the frame where the target looks right: the track is re-based so that frame is the identity). `track` is a stored track_id (from ae_track_multi / ae_track_read) or any source ae_track_read takes. " +
      "Modes: `nulls` (one null per tracked point, optionally a 'solved' null with Position/Rotation/Scale for parenting; nothing is parented), `corner_pin` / `power_pin` (adds or uses the effect on `layer` and keys its four points in the layer's own space, parents and the layer's own animated transform included; masks drawn on the layer follow, because masks render before effects), `transform` (Position/Rotation/Scale keys so a similarity track drives the layer; layer motion blur works), `transform_pin` (similarity on the transform plus the residual perspective in a Corner Pin: motion blur on the similarity part). " +
      "Corner Pin / CC Power Pin animation gets no layer motion blur. Keys are linear, one per ok frame; frames that are not ok are skipped and listed. Existing keys or expressions on the written properties refuse the write (`replace_keys` replaces keys). Locked and 3D layers are refused. Keys are straight lines in time and space (zero spatial tangents), but a path measured only on ok frames is not re-measured between them. With an existing pin effect (effect_index, or the first one), its four points at ref_time are the placement that follows the track; a new pin starts from the layer's plain rectangle. Transform modes follow an animated Anchor Point (its value at each frame is used). Not measured: motion blur, lens distortion, anything but the track's own frames. " +
      "Guarded, checkpointed and read back in a separate call. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeTrackApplySchema,
    handler: async (args: AeTrackApplyArgs, ctx: ToolContext) => {
      try {
        const opId = ctx.bridge.newOpId();
        const { track, info } = await queued(ctx, `ae_track_apply resolve(${args.comp_id})`, opId, () => resolveTrackSourceWithInfo(ctx, opId, args.comp_id, args.track));
        const target: ApplyTarget = {
          mode: args.mode,
          layer: args.layer,
          effect_index: args.effect_index,
          add_effect: args.add_effect,
          null_prefix: args.null_prefix,
          solved_null: args.solved_null,
          replace_keys: args.replace_keys,
          range: args.range,
          refit_model: args.refit_model,
          smooth_frames: args.smooth_frames,
        };
        return await applyTrackTo(ctx, {
          compId: args.comp_id,
          track,
          target,
          refTime: args.ref_time,
          expect: args.expect,
          toolName: "ae_track_apply",
          trackNote: { track_source: track.source, ...(info ? { source_info: info } : {}) },
        });
      } catch (err) {
        if (err instanceof PlanarError) return fail(err);
        throw err;
      }
    },
  },
];
