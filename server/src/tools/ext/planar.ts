/**
 * server/src/tools/ext/planar.ts
 *
 * The planar tools: following a surface through a shot with several points,
 * and carrying things along with it. Everything runs inside the MCP and
 * After Effects (no outside tools): AE renders the frames (saveFrameToPng,
 * as the frame tools do), the server follows the points by normalized cross-
 * correlation (track.ts) and solves a motion model per frame (planar-math.ts).
 * - ae_track_multi: 1-8 points, forwards and backwards from a reference frame,
 *   translate / similarity / affine / perspective, lost points re-acquired,
 *   long shots followed in chunks that resume exactly
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
  relativeTo,
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
  .refine((v) => [v.points, v.auto_points, v.continue_track_id].filter((x) => x !== undefined).length === 1, {
    message: "Give exactly one of points, auto_points or continue_track_id.",
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
    if (i === refIdx) return { time: t, ok: true, H: identityH(), points: pts, confidence: conf, rms_px: 0, inliers: n };
    const sol = solveModel(a.model, refPoints, pts);
    if (!sol) return { time: t, ok: false, H: null, points: pts, confidence: conf, rms_px: null, inliers: 0, note: "the points are degenerate at this frame (coincident or collinear)" };
    return { time: t, ok: true, H: sol.H, points: pts, confidence: conf, rms_px: r4(sol.rms_px), inliers: n };
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
    return {
      frame: { time, ok, H: ok ? sol.H : null, points: pos, confidence: conf, rms_px: r4(sol.rms_px), inliers, ...(note ? { note } : {}) },
      stop: null,
      lost: alive.filter((i) => pos[i] === null),
      reacquired,
    };
  }
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

export function trackSummary(track: PlanarTrack, maxFrames = 500): Record<string, unknown> {
  const ok = track.frames.filter((f) => f.ok);
  const rms = ok.map((f) => f.rms_px).filter((v): v is number => v !== null);
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
    frames_lost_per_point: lostPer,
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
  const based = relativeTo(a.track, refTime);
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
    written: w.written ?? [],
    nulls: (w.nulls ?? []).map((n) => ({ id: n.layer_id, index: n.layer_index, name: n.name, keys: n.props.map((p) => `${p.role}:${p.numKeys}`).join(" ") })),
    notes,
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
}

interface LiveTrack {
  forward: MultiTracker | null;
  backward: MultiTracker | null;
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
        };
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
        if (cached?.forward) scale = cached.forward.scale;
        else if (cached?.backward) scale = cached.backward.scale;
      } else if (args.points) {
        refPoints = args.points as Vec2[];
      } else {
        const ap = args.auto_points!;
        const patchImg = Math.max(9, Math.round(o.pattern_size * scale) | 1);
        const longer = regionLongerSide(ap.region);
        const minDist = (ap.min_distance_px ?? Math.max(o.pattern_size, longer / 10)) * scale;
        const mask = regionMask(refPng!.width, refPng!.height, scale, ap.region, ap.exclude ?? [], o.pattern_size);
        chosen = goodFeatures(boxBlurGray(toGray(refPng!), 1), mask, { count: ap.count, minDistancePx: minDist, patchSize: patchImg });
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
      const quad: Vec2[] = stored ? stored.tracking!.quad : ((args.quad as Vec2[] | undefined) ?? boundingQuad(refPoints));
      let fwd: MultiTracker | null = cached?.forward ?? null;
      let bwd: MultiTracker | null = cached?.backward ?? null;
      let dropped: Array<{ index: number; reason: string }>;
      if (!stored) {
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
      const fresh = (): MultiTracker => new MultiTracker(refGray!, refPoints, scale, opts, quad);
      if (!state.forward.done && !fwd) {
        fwd = fresh();
        if (stored) fwd.restore(state.forward.last_points, state.forward.last_H);
      }
      if (!state.backward.done && !bwd) {
        bwd = fresh();
        if (stored) bwd.restore(state.backward.last_points, state.backward.last_H);
      }

      // The reference frame itself.
      const aliveRef = refPoints.map((_, i) => !dropped.some((d) => d.index === i));
      const refFrame: PlanarFrame = {
        time: refTime,
        ok: true,
        H: identityH(),
        points: refPoints.map((p, i) => (aliveRef[i] ? p : null)),
        confidence: refPoints.map((_, i) => (aliveRef[i] ? 1 : null)),
        rms_px: 0,
        inliers: aliveRef.filter(Boolean).length,
      };

      const added: PlanarFrame[] = [refFrame];
      type End = { png: PNG; frame: PlanarFrame } | null;
      const ends = { forward: null as End, backward: null as End };
      const run_ = { renderError: null as string | null, blocked: false, reacquired: 0 };

      const run = async (dir: "forward" | "backward", mt: MultiTracker | null) => {
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
          const res = mt.step(prep(png), times[i]);
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
      remember(track.track_id, { forward: fwd, backward: bwd });
      track.tracking!.options = o as unknown as Record<string, unknown>;
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
  notes.push("Points must lie on one plane: a point on a different depth slides against the others and the fit gets worse (see rms_px).");
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
      "Give `points`, or `auto_points` {region, exclude, count} to let the tool pick Shi-Tomasi corners inside a region and outside the object you are removing; the chosen points come back. Points must lie on ONE plane. " +
      "`isolate_layers` renders a temporary copy of the comp with only the plate on, so patches and overlays above it cannot corrupt the track (the copy is removed in the same call; needs `expect`). " +
      "Long shots are chunked (`max_frames`, `max_seconds`): while `complete` is false, call again with `continue_track_id`. The result is a summary with at most 500 sampled frames; the full track is stored under `track_id` for ae_track_apply and the other planar tools. " +
      "`preview_path` is a contact sheet of the first, reference and last frame of the call with the points (cyan, lost ones red) and the surface quad (green): look at it before trusting the track. `apply` writes the finished track like ae_track_apply. Every frame is a render. " +
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
      "Returns the same bounded summary and (with `preview`) contact sheet as ae_track_multi. Mocha's project data and the Warp Stabilizer / 3D Camera Tracker solves cannot be read; only keyframes made from them can.",
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
