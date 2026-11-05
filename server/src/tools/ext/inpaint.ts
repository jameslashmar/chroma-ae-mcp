/**
 * server/src/tools/ext/inpaint.ts
 *
 * ae_inpaint_plate: a clean plate made in the MCP's own Node, the scriptable
 * stand-in for Content-Aware Fill. AE renders the frames (saveFrameToPng, as
 * the frame tools do, of a temporary copy of the comp that shows only the
 * plate layer), the planar track carries each frame into the reference frame,
 * and the hole is filled from the other frames (a per-pixel median of the
 * samples that show background, each matched to the reference's exposure in
 * the ring around the hole) and, for what no frame reveals, by diffusion or an
 * exemplar fill (inpaint-math.ts). The result is the reference frame with the
 * hole filled, written as a PNG to the project's plates folder (never over an
 * existing file), imported as a still in one undo step, and optionally put
 * into a patch comp.
 *
 * Two phases. First, in one queue lease: read, guard and render (the temporary
 * plate copy, when used, is made and removed here, two undo groups, and nothing
 * else in the project changes); then, with the lease released, the fill in Node
 * and the PNG write. Then a guarded write
 * through runGuardedWrite imports the PNG and places it, with a receipt.
 *
 * Not built, because AE has no API for it: driving AE's own Content-Aware
 * Fill (a panel with no scripting access; ae_caf_prep prepares its inputs), and
 * generative or ML fills (no outside models or tools).
 *
 * Unmeasured on AE 26 (see the tool description for how each is handled):
 * - run time on the panel's Node 17.7.2 for 1080p and 4K holes (the fills yield
 *   to the event loop, and the render budget caps the number of frames);
 * - how importFile reads the PNG (sRGB, no premultiply surprise);
 * - the names a rig from ae_cleanplate_setup uses: `auto` placement treats a
 *   comp whose name has the word PATCH (as "<plate> PATCH f<frame>") as a PATCH precomp (unmasked), any
 *   other as a work comp (masked); `mode` overrides the guess, and
 *   `offset_px` places the still in a padded comp.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PNG } from "pngjs";
import { z } from "zod";
import { BridgeError } from "../../host.js";
import { buildJsxCall } from "../../jsx.js";
import { QueueWaitError } from "../../queue.js";
import type { ReceiptMismatch } from "../../receipts.js";
import { AGENT_SAFETY_GUIDANCE, ExpectSchema, LayerSelectorSchema, type ExpectGuard, type ToolContext, type ToolDefinition } from "../common.js";
import { autoCheckpoint, verifyTargetGuard } from "../mutate.js";
import { defaultFramesDir } from "../render.js";
import { captureCompFrame, decodePngFile } from "./frames.js";
import { CLS, fillFromGathered, gatherSamples, InpaintError, MAX_HOLE_SHARE, prepareHole, spreadPick, type FillInput, type FillResult, type Gathered } from "./inpaint-math.js";
import { relativeTo, frameAt, type Mat3, type PlanarTrack } from "./planar-math.js";
import { createRenderBudget, platesFolderFor, PlanarError, RegionSchema, resolveTrackSource, TrackSourceSchema, withIsolatedPlate, type Region } from "./planar.js";
import { blit, createCanvas, drawLabel, encodePng, fitWithin, resizeArea, type RgbaImage } from "./png-utils.js";
import { regionToPolygon, type Pt, type RegionSpec } from "./region-math.js";
import { noteAfterWrite, noteBeforeWrite, type WriteInfo } from "./session.js";
import { expectThat, runGuardedWrite } from "./write-runner.js";

// ---------- schemas ----------

const PlaceSchema = z
  .object({
    comp_id: z.number().int().describe("The comp that gets the still, usually the PATCH precomp of a clean-plate rig or a work comp."),
    mode: z
      .enum(["auto", "unmasked", "masked"])
      .default("auto")
      .describe(
        "unmasked: the still goes on top of the comp as it is (in a PATCH precomp the outer patch layer's mask limits it). " +
          "masked: the still gets one feathered mask per hole region, because it is a whole frame and unmasked it would freeze the whole shot. " +
          "auto (default): unmasked when the comp's name has the word PATCH in it (ae_cleanplate_setup names its precomp '<plate> PATCH f<frame>'), else masked; the name is the only thing checked, and the result says which and why."
      ),
    offset_px: z
      .array(z.number())
      .length(2)
      .optional()
      .describe("[x, y]: where the still's top-left corner lands in that comp, in its pixels (a padded work comp). Default: centred, as AE adds a layer."),
    feather_px: z.number().min(0).max(200).default(12).describe("Mask feather in pixels (masked mode). The mask expansion is grow_px + feather_px / 2, so the feather stays outside the hole. Default 12."),
    layer_name: z.string().min(1).max(200).optional().describe("Name of the new layer. Default the still's file name."),
  })
  .describe("Put the still on top of a comp, in the same undo step as the import.");

export const AeInpaintPlateSchema = z.object({
  comp_id: z.number().int().describe("The comp that holds the footage."),
  plate_layer: LayerSelectorSchema.describe("The footage layer to clean. It is rendered alone (see isolate_plate), so overlays and earlier patches above it do not end up in the fill."),
  regions: z
    .array(RegionSchema)
    .min(1)
    .max(16)
    .describe("The hole, up to 16 regions in comp pixels AT ref_time: { rect: [x, y, w, h] }, { ellipse: [cx, cy, rx, ry] } or { polygon: [[x, y], ...] }. The union is filled, at most 25% of the frame."),
  grow_px: z.number().min(0).max(200).default(4).describe("Grow the hole by this many comp pixels so the fill covers the object's soft edge and shadow. Default 4."),
  ref_time: z
    .number()
    .min(0)
    .optional()
    .describe("The reference frame in seconds: the fill is made for this frame and the regions are drawn on it. Default: the track's reference frame, else the work area start."),
  track: TrackSourceSchema.optional().describe(
    "The motion of the plane behind the object (a track_id from ae_track_multi / ae_track_read, or any source they take). It carries every sampled frame into the reference frame. Without it the shot is treated as locked off, which only helps when the object moves."
  ),
  method: z
    .enum(["temporal", "spatial", "auto"])
    .default("auto")
    .describe("temporal: other frames only (pixels never revealed stay as they are). spatial: diffusion or exemplar fill only, no extra renders. auto (default): temporal first, spatial for what is left."),
  spatial: z
    .enum(["diffuse", "patch"])
    .default("diffuse")
    .describe("The spatial fill. diffuse (default): harmonic fill, exact on gradients, best for thin wires, rigs and blemishes; texture inside the hole comes out smooth. patch: a bounded PatchMatch exemplar fill from the ring and the rest of the crop, for logos and larger objects on texture; it can repeat a pattern."),
  object_moves: z
    .boolean()
    .default(false)
    .describe(
      "True when the object moves against the plane (a person walking past): any sampled frame may show what is behind it. " +
        "False (default) when it sits on the plane or the camera moves past it (parallax reveals the background): a sample that still shows the reference pixel is the object and does not vote, and a pixel whose voting samples have a median still near the reference is taken as the object and left for the spatial fill."
    ),
  max_frames: z.number().int().min(2).max(120).default(60).describe("Most frames sampled, spread across the range (one render each). Default 60."),
  max_seconds: z.number().min(5).max(300).default(90).describe("Most seconds of rendering. When it runs out the fill uses the samples it has and reports how many. Default 90."),
  start: z.number().min(0).optional().describe("First time to sample, seconds. Default the track's start, else the work area's."),
  end: z.number().min(0).optional().describe("Last time to sample, seconds. Default the track's end, else the work area's."),
  min_samples: z.number().int().min(2).max(30).default(3).describe("Fewest background samples a pixel needs to be filled temporally. Default 3."),
  max_spread: z.number().min(1).max(100).default(12).describe("Spread of the samples at a pixel (gray levels, a sigma) above which it is flagged low confidence (red in the preview): parallax, a moving object or a loose track. Default 12."),
  object_tolerance: z.number().min(1).max(80).default(10).describe("With object_moves false: a sample within this many gray levels of the reference pixel counts as the object itself and does not vote; a pixel whose voting samples have a median within 1.5 times this (or 2.5 times their robust spread, the median absolute deviation, if larger) of the reference is also left to the spatial fill. Raise it for grainy footage: about 3 times the grain's sigma (grain of sigma 8 wants about 24 to 30) keeps the temporal fill; too low and part of the background is judged to be the object and filled spatially. Objects within about 1.5 times this value of the background (15 gray levels at the default, so raising the tolerance raises this limit too) cannot be told from it and are filled spatially. With few samples (under about 20, a low max_frames) the object check is weaker and grain leaks more, so use more frames. Default 10."),
  match_color: z.boolean().default(true).describe("Match each sample's exposure to the reference in the ring around the hole (gain and offset per channel) before taking the median. Default true."),
  isolate_plate: z
    .boolean()
    .default(true)
    .describe("Render a temporary copy of the comp that shows only plate_layer (two undo steps, the copy is removed in the same call). False renders the comp as it is, which is right when it holds nothing but the plate. Default true."),
  place_in_comp: PlaceSchema.optional(),
  preview: z.boolean().default(true).describe("Write a preview PNG next to the still: the reference crop, the fill, and the confidence map (green temporal, yellow spatial, red low-confidence temporal, magenta unfilled). Default true."),
  expect: ExpectSchema,
});
export type AeInpaintPlateArgs = z.infer<typeof AeInpaintPlateSchema>;

// ---------- small helpers ----------

const r2 = (v: number): number => Math.round(v * 100) / 100;
const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const yieldLoop = (): Promise<void> => new Promise<void>((r) => setImmediate(r));
const refuse = (code: string, message: string) => ({ ok: false as const, error: code, message });

/** A region as the polygon region-math draws; throws InpaintError for a shape with no area. */
export function regionPolygon(r: Region): Pt[] {
  let spec: RegionSpec;
  if ("rect" in r) {
    const [x, y, w, h] = r.rect;
    if (![x, y, w, h].every(Number.isFinite) || !(w > 0) || !(h > 0)) throw new InpaintError("bad_args", "A rect needs a finite [x, y, width, height] with width and height above 0.");
    spec = { kind: "rect", rect: [x, y, x + w, y + h] };
  } else if ("ellipse" in r) {
    const [cx, cy, rx, ry] = r.ellipse;
    if (![cx, cy, rx, ry].every(Number.isFinite) || !(rx > 0) || !(ry > 0)) throw new InpaintError("bad_args", "An ellipse needs a finite [cx, cy, rx, ry] with radii above 0.");
    spec = { kind: "ellipse", center: [cx, cy], radius: [rx, ry] };
  } else {
    if (!r.polygon.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))) throw new InpaintError("bad_args", "A polygon point is not finite.");
    spec = { kind: "polygon", points: r.polygon.map((p) => [p[0], p[1]] as Pt) };
  }
  return regionToPolygon(spec);
}

/** A file name part: letters, digits, dot, dash, underscore; at most 60 characters. */
export function safeName(name: string): string {
  const s = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return (s || "plate").slice(0, 60);
}

/** `<stem><ext>`, or `<stem>_2<ext>`, ... : the first name that does not exist in `dir`. */
export function uniquePath(dir: string, stem: string, ext: string): string {
  let target = path.join(dir, `${stem}${ext}`);
  for (let n = 2; fs.existsSync(target); n++) target = path.join(dir, `${stem}_${n}${ext}`);
  return target;
}

export interface SamplePick {
  time: number;
  H: Mat3;
}

/**
 * The frames to sample, spread evenly over the range, the reference frame left
 * out. With a track, its solved frames in range and their homographies; without
 * one the frames of the range with the identity (a locked-off shot).
 */
export function planSamples(o: { fps: number; duration: number; refTime: number; start: number; end: number; max: number; track?: PlanarTrack | null }): SamplePick[] {
  const fps = o.fps > 0 ? o.fps : 24;
  const half = 0.5 / fps;
  const lastTime = Math.max(0, o.duration - 1 / fps);
  const lo = Math.max(0, o.start) - 1e-9;
  const hi = Math.min(lastTime, o.end) + 1e-9;
  let cands: SamplePick[];
  if (o.track) {
    cands = o.track.frames.filter((f) => f.ok && f.H && f.time >= lo && f.time <= hi && Math.abs(f.time - o.refTime) > half).map((f) => ({ time: f.time, H: f.H as Mat3 }));
  } else {
    const f0 = Math.max(0, Math.ceil(lo * fps - 1e-6));
    const f1 = Math.min(f0 + 200000, Math.floor(hi * fps + 1e-6));
    const refF = Math.round(o.refTime * fps);
    const frames: number[] = [];
    for (let f = f0; f <= f1; f++) if (f !== refF) frames.push(f);
    cands = frames.map((f) => ({ time: f / fps, H: [1, 0, 0, 0, 1, 0, 0, 0, 1] }));
  }
  return spreadPick(cands, o.max);
}

// ---------- host reads ----------

interface HostInfo {
  comp: { id: number; name: string; width: number; height: number; pixel_aspect: number; fps: number; frame_duration: number; duration: number; time: number; work_area_start: number; work_area_duration: number; num_layers: number };
  plate: { index: number; id: number; name: string; enabled: boolean; locked: boolean; has_video: boolean; three_d: boolean; opacity_at?: number | null } | null;
  plate_error?: { kind: string; message: string };
  place: { id: number; name: string; width: number; height: number; duration: number; num_layers: number } | null;
  place_error?: { kind: string; message: string };
  project: { path: string | null; bits_per_channel: number | null; linear_blending: boolean | null };
}

interface HostState {
  num_items: number;
  scanned: number;
  imported: Array<{ id: number; name: string; width: number; height: number }>;
  place: { id: number; num_layers: number; top: Array<{ index: number; id: number; name: string; enabled: boolean; source_id: number | null; mask_count: number; position?: [number, number] | null; masks?: Array<{ feather: number; expansion: number }> }> } | null;
}

async function readHost<T>(ctx: ToolContext, opId: string, tag: string, host: string, args: unknown, toolName: string): Promise<T> {
  const res = await ctx.bridge.evalRaw<T>({ id: `${opId}_${tag}`, script: buildJsxCall(host, args), label: `${toolName} ${tag}`, mutates: false, toolName });
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

// ---------- pictures ----------

function toPng(img: RgbaImage): PNG {
  const png = new PNG({ width: img.width, height: img.height });
  Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength).copy(png.data);
  return png;
}

const CLASS_COLORS: Record<number, [number, number, number]> = {
  [CLS.TEMPORAL]: [60, 200, 90],
  [CLS.TEMPORAL_LOW]: [230, 60, 60],
  [CLS.SPATIAL]: [240, 210, 60],
  [CLS.UNFILLED]: [220, 60, 220],
};

/** The reference crop dimmed to gray, with every hole pixel in its class colour. */
export function confidenceImage(res: Pick<FillResult, "refCrop" | "classes">): RgbaImage {
  const { width, height } = res.refCrop;
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const col = CLASS_COLORS[res.classes[i]];
    if (col) {
      data[i * 4] = col[0];
      data[i * 4 + 1] = col[1];
      data[i * 4 + 2] = col[2];
    } else {
      const g = Math.round((0.3 * res.refCrop.data[i * 4] + 0.59 * res.refCrop.data[i * 4 + 1] + 0.11 * res.refCrop.data[i * 4 + 2]) * 0.45);
      data[i * 4] = g;
      data[i * 4 + 1] = g;
      data[i * 4 + 2] = g;
    }
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

function previewSheet(res: FillResult, maxTile = 420): PNG {
  const tiles: Array<{ img: RgbaImage; label: string }> = [
    { img: res.refCrop, label: "reference" },
    { img: res.fillCrop, label: "fill" },
    { img: confidenceImage(res), label: "confidence" },
  ];
  const drawn = tiles.map((t) => {
    const fit = fitWithin(t.img.width, t.img.height, maxTile);
    const png = resizeArea(t.img, fit.width, fit.height);
    drawLabel(png, t.label, 3, 3, 1, [16, 16, 16, 255], [255, 214, 0, 255], 2);
    return png;
  });
  const gap = 4;
  const width = drawn.reduce((s, d) => s + d.width, 0) + gap * (drawn.length - 1);
  const height = Math.max(...drawn.map((d) => d.height));
  const sheet = createCanvas(width, height, [24, 24, 24, 255]);
  let x = 0;
  for (const d of drawn) {
    blit(sheet, d, x, 0);
    x += d.width + gap;
  }
  return sheet;
}

// ---------- phase 1: the plate ----------

interface Placement {
  comp_id: number;
  mode: "masked" | "unmasked";
  offset: [number, number] | null;
  regions: Array<Array<[number, number]>>;
  feather_px: number;
  expansion_px: number;
  layer_name: string | null;
}

/** What phase 1 has done so far, so the handler can report it when something fails. */
interface Phase1State {
  pastGuard: boolean;
  checkpoint: string | null;
  temp: { copy_id: number; removed: boolean; error?: string } | null;
  /** What the user changed since the last write, found before the plate copy was made (reported on every result after it). */
  sessionFields: { user_changed?: string };
}

/** Records the writes of a finished isolate as the agent's own (session tracker); never throws. */
async function noteWritten(ctx: ToolContext, note: WriteInfo): Promise<void> {
  try {
    await noteAfterWrite(ctx, note, { addStep: true });
  } catch {
    // reporting only
  }
}

/** The user_changed text of phase 1 and, if the import write found its own, that too. */
function mergeSession(first: { user_changed?: string }, later: unknown): { user_changed?: string } {
  const b = later && typeof later === "object" ? (later as { user_changed?: unknown }).user_changed : undefined;
  const parts: string[] = [];
  if (first.user_changed) parts.push(first.user_changed);
  if (typeof b === "string" && b && b !== first.user_changed) parts.push(b);
  return parts.length ? { user_changed: parts.join(" ") } : {};
}

/**
 * The most memory the warped samples of ONE call may take together (N x crop x 4 bytes).
 * It is per call, not global: the samples stay held while the fill runs outside the queue lease,
 * so a second call can gather its own meanwhile and parallel calls add up to a multiple of this.
 */
export const SAMPLE_MEMORY_BUDGET = 512 * 1024 * 1024;

/** What the queue lease hands back: the render half is done, the CPU fill is still to run (outside the lease). */
interface Staged {
  refused?: undefined;
  finish: () => Promise<Built>;
}

interface Built {
  refused?: undefined;
  finish?: undefined;
  pngPath: string;
  frame: number;
  report: Record<string, unknown>;
  placement: Placement | null;
  placementWhy: string | null;
  stillSize: [number, number];
}

/** The word PATCH set off by spaces, underscores, dots, dashes or the ends of the name: "Plate A PATCH f42", "PATCH Shot_01", "_patch". */
export const PATCH_NAME = /(^|[\s_.-])patch($|[\s_.-])/i;

/** Decides masked or unmasked, and the polygons in the still's pixels. */
export function planPlacement(
  p: z.infer<typeof PlaceSchema>,
  place: { name: string },
  polys: Pt[][],
  growPx: number,
  imageScale: number
): { placement: Placement; why: string } {
  let mode: "masked" | "unmasked";
  let why: string;
  if (p.mode === "auto") {
    const patchLike = PATCH_NAME.test(place.name);
    mode = patchLike ? "unmasked" : "masked";
    why = patchLike ? `comp "${place.name}" has PATCH in its name, so the still goes on unmasked (the name is all that was checked)` : `comp "${place.name}" has no PATCH in its name, so the still is masked to the hole`;
  } else {
    mode = p.mode;
    why = `mode ${p.mode} was asked for`;
  }
  return {
    placement: {
      comp_id: p.comp_id,
      mode,
      offset: p.offset_px ? [p.offset_px[0], p.offset_px[1]] : null,
      regions: mode === "masked" ? polys.map((poly) => poly.map(([x, y]) => [x * imageScale, y * imageScale] as [number, number])) : [],
      feather_px: p.feather_px,
      expansion_px: growPx * imageScale + p.feather_px / 2,
      layer_name: p.layer_name ?? null,
    },
    why,
  };
}

async function buildPlate(ctx: ToolContext, opId: string, args: AeInpaintPlateArgs, expect: ExpectGuard, polys: Pt[][], toolName: string, label: string, state: Phase1State): Promise<Staged | { refused: Record<string, unknown> }> {
  const guard = await verifyTargetGuard(ctx, expect, opId);
  state.pastGuard = true;
  const projectPath = guard.project_path ?? "<unsaved>";
  const folder = platesFolderFor(projectPath);
  const info = await readHost<HostInfo>(ctx, opId, "info", "inpaintRead", { comp_id: args.comp_id, plate: args.plate_layer, place_comp_id: args.place_in_comp?.comp_id ?? null }, toolName);
  const comp = info.comp;
  const plate = info.plate;
  if (!plate) return { refused: refuse(info.plate_error?.kind === "bad_args" ? "bad_args" : "not_found", info.plate_error?.message ?? "The plate layer was not found.") };
  if (Number(comp.pixel_aspect) > 0 && Math.abs(Number(comp.pixel_aspect) - 1) > 1e-6) {
    return { refused: refuse("refused", `The comp's pixel aspect is ${comp.pixel_aspect}, not 1. The fill works on square pixels only.`) };
  }
  if (!plate.has_video) return { refused: refuse("bad_args", `Layer "${plate.name}" has no video, so there is nothing to render.`) };
  if (args.place_in_comp && !info.place) return { refused: refuse("not_found", info.place_error?.message ?? `No comp ${args.place_in_comp.comp_id} to put the still in.`) };
  const fps = comp.fps > 0 ? comp.fps : 24;
  const snap = (t: number) => Math.round(t * fps) / fps;
  const lastTime = Math.max(0, comp.duration - comp.frame_duration);

  // The cap on the hole is checked before anything is written or rendered.
  const holeCheck = prepareHole(comp.width, comp.height, comp, polys, args.grow_px, 2, 24);
  if (holeCheck.share > MAX_HOLE_SHARE) {
    return { refused: refuse("refused", `The hole covers ${r2(holeCheck.share * 100)}% of the frame; the limit is ${MAX_HOLE_SHARE * 100}%. Fill it in parts.`) };
  }

  // The plane's track, re-based to the reference frame.
  let track: PlanarTrack | null = null;
  let refTime = args.ref_time;
  if (args.track && args.method !== "spatial") {
    let t = await resolveTrackSource(ctx, opId, args.comp_id, args.track);
    if (Math.abs(t.comp_size[0] - comp.width) > 0.5 || Math.abs(t.comp_size[1] - comp.height) > 0.5) {
      return { refused: refuse("refused", `The track was made in a ${t.comp_size[0]}x${t.comp_size[1]} comp and this one is ${comp.width}x${comp.height}: the points are in comp pixels, so the sizes must match.`) };
    }
    if (refTime === undefined) refTime = t.ref_time;
    refTime = snap(Math.min(lastTime, refTime));
    if (Math.abs(t.ref_time - refTime) > 0.5 / fps) t = relativeTo(t, refTime);
    const refFrame = frameAt(t, refTime);
    if (!refFrame || !refFrame.ok || !refFrame.H) {
      return { refused: refuse("bad_args", `The track has no solved frame at ref_time ${refTime}s, so it cannot be re-based to that frame. Give a ref_time inside the track.`) };
    }
    track = t;
  }
  if (args.track && args.method === "spatial" && refTime === undefined) {
    // No sampling, so the track is not needed beyond its reference frame, which is the default ref_time.
    refTime = (await resolveTrackSource(ctx, opId, args.comp_id, args.track)).ref_time;
  }
  const ref_time = snap(Math.min(lastTime, refTime ?? comp.work_area_start));
  const frame = Math.round(ref_time * fps);
  if (args.isolate_plate) {
    // The temporary copy shows the plate at its own opacity: an opacity-switch work comp would render it blank.
    const at = await readHost<HostInfo>(ctx, opId, "opacity", "inpaintRead", { comp_id: args.comp_id, plate: args.plate_layer, place_comp_id: null, at_time: ref_time }, toolName);
    const op = at.plate?.opacity_at;
    if (typeof op === "number" && op <= 0) {
      return { refused: refuse("refused", `Layer "${plate.name}" has opacity 0 at ref_time ${ref_time}s, so the isolated copy would render blank. If a rig switch hides it (the opacity switch ae_stabilize makes), tick 'Show Stabilized Plate' on the rig layer first; if its opacity is keyed, pick a ref_time where it shows. Set isolate_plate false only for a comp where other layers really show the picture.`) };
    }
  }

  const notes: string[] = [];
  let samples: SamplePick[] = [];
  if (args.method !== "spatial") {
    const start = args.start ?? (track && track.frames.length ? track.frames[0].time : comp.work_area_start);
    const end = args.end ?? (track && track.frames.length ? track.frames[track.frames.length - 1].time : comp.work_area_start + comp.work_area_duration);
    samples = planSamples({ fps, duration: comp.duration, refTime: ref_time, start, end, max: args.max_frames, track });
    if (samples.length === 0) {
      if (args.method === "temporal") return { refused: refuse("bad_args", "No other solved frame in range to sample from. Widen start and end, or use method auto or spatial.") };
      notes.push("No other solved frame in range, so the whole hole is filled spatially.");
    }
    if (!track) notes.push("No track was given: the shot is treated as locked off, so other frames only help where the object moves.");
  }
  // Memory is bounded by the crop (all regions' bounding box plus margin), not by the hole: cap the samples to fit.
  if (samples.length > 0) {
    const cropPixels = Math.max(1, holeCheck.crop.w * holeCheck.crop.h);
    const fit = Math.floor(SAMPLE_MEMORY_BUDGET / (cropPixels * 4));
    if (samples.length > fit) {
      if (fit < 2) {
        if (args.method === "temporal") {
          return { refused: refuse("refused", `The regions span a ${holeCheck.crop.w}x${holeCheck.crop.h} area, too large to hold even 2 warped samples in memory (budget ${SAMPLE_MEMORY_BUDGET / 1048576} MB). Fill the regions in separate calls.`) };
        }
        notes.push(`The regions span a ${holeCheck.crop.w}x${holeCheck.crop.h} area, too large to hold sample frames in memory, so the whole hole is filled spatially. Fill the regions in separate calls for a temporal fill.`);
        samples = [];
      } else {
        notes.push(`The regions span a ${holeCheck.crop.w}x${holeCheck.crop.h} area, so the samples were cut from ${samples.length} to ${fit} to stay within ${SAMPLE_MEMORY_BUDGET / 1048576} MB. Fill distant regions in separate calls for more.`);
        samples = spreadPick(samples, fit);
      }
    }
  }
  if (info.project.bits_per_channel !== null && info.project.bits_per_channel > 8) {
    notes.push(`The project is ${info.project.bits_per_channel} bpc; saveFrameToPng writes 8-bit sRGB, so the still is 8-bit.`);
  }
  if (info.project.linear_blending) notes.push("The project blends colours in linear light; the still is made from the 8-bit display values the render gives.");

  // Render the samples. The plate copy, when used, is a write: checkpoint first, registered with the session tracker.
  const framesDir = defaultFramesDir();
  const budget = createRenderBudget({ maxRenders: args.max_frames + 2, maxSeconds: args.max_seconds });
  let renderIndex = 0;
  let failures = 0;
  let consecutive = 0;
  let lastFailure: string | null = null;
  const render = async (renderCompId: number, time: number): Promise<RgbaImage> => {
    renderIndex++;
    const snapped = await captureCompFrame({ ctx, opId, compId: renderCompId, time, frameIndex: renderIndex, framesDir, toolName });
    budget.spend();
    const png = decodePngFile(snapped.path);
    try {
      fs.rmSync(snapped.path, { force: true });
    } catch {
      // A frame left in the frames folder is harmless.
    }
    await yieldLoop();
    return png;
  };
  let fillInput: FillInput | null = null;
  // Inside the lease: renders and warps only. The CPU fill runs in finish(), after the lease is released.
  const work = async (renderCompId: number): Promise<Gathered> => {
    const ref = await render(renderCompId, ref_time);
    if (ref.width !== comp.width || ref.height !== comp.height) {
      throw new InpaintError("refused", `The render is ${ref.width}x${ref.height} but the comp is ${comp.width}x${comp.height}. The masks and the placement work in comp pixels, so the fill needs a full-resolution render. Set the comp's resolution to Full and try again.`);
    }
    const input: FillInput = {
      ref,
      comp: { width: comp.width, height: comp.height },
      polygons: polys,
      growPx: args.grow_px,
      method: args.method,
      spatial: args.spatial,
      objectMoves: args.object_moves,
      samples,
      getFrame: async (t) => {
        try {
          const img = await render(renderCompId, t);
          consecutive = 0;
          return img;
        } catch (err) {
          failures++;
          consecutive++;
          lastFailure = errMessage(err);
          return null;
        }
      },
      shouldStop: () => {
        if (budget.exhausted()) return "budget";
        if (consecutive >= 2) return "render_failures";
        return false;
      },
      minSamples: args.min_samples,
      maxSpread: args.max_spread,
      objectTol: args.object_tolerance,
      ringPx: 24,
      ringGapPx: 2,
      matchColor: args.match_color,
      tick: yieldLoop,
    };
    fillInput = input;
    return gatherSamples(input);
  };

  let gathered: Gathered;
  let temp: { copy_id: number; removed: boolean; error?: string } | null = null;
  if (args.isolate_plate) {
    const checkpoint = await autoCheckpoint(ctx, guard, toolName);
    state.checkpoint = checkpoint?.path ?? null;
    const note: WriteInfo = { opId, toolName, label, expect, checkpoint: checkpoint?.path ?? null };
    state.sessionFields = await noteBeforeWrite(ctx, note);
    let run: Awaited<ReturnType<typeof withIsolatedPlate<Gathered>>>;
    try {
      run = await withIsolatedPlate(ctx, opId, { compId: args.comp_id, showLayers: [{ index: plate.index, id: plate.id }], expect, toolName, note }, work);
    } catch (err) {
      // The copy was made (and maybe removed again): those undo entries are ours.
      if ((err as { plateTemp?: unknown } | null)?.plateTemp) await noteWritten(ctx, note);
      throw err;
    }
    await noteWritten(ctx, note);
    gathered = run.value;
    temp = run.temp;
    state.temp = temp;
  } else {
    gathered = await work(args.comp_id);
  }
  // The lease ends here: the caller runs finish() after queue.run returns, with the plate copy gone.
  const finish = async (): Promise<Built> => {
  // The median and the spatial fill, in Node, without the AE queue.
  const fill: FillResult = await fillFromGathered(fillInput as unknown as FillInput, gathered);

  // The files: only in the plates folder, never over an existing one.
  fs.mkdirSync(folder, { recursive: true });
  const stem = `${safeName(plate.name)}_f${frame}_inpaint`;
  const pngPath = uniquePath(folder, stem, ".png");
  fs.writeFileSync(pngPath, encodePng(toPng(fill.image)), { flag: "wx" });
  let previewPath: string | null = null;
  if (args.preview) {
    try {
      previewPath = uniquePath(folder, `${stem}_preview`, ".png");
      fs.writeFileSync(previewPath, encodePng(previewSheet(fill)), { flag: "wx" });
    } catch (err) {
      previewPath = null;
      notes.push(`The preview could not be written: ${errMessage(err)}`);
    }
  }

  let placement: Placement | null = null;
  let placementWhy: string | null = null;
  if (args.place_in_comp && info.place) {
    const planned = planPlacement(args.place_in_comp, info.place, polys, args.grow_px, fill.image.width / comp.width);
    placement = planned.placement;
    placementWhy = planned.why;
  }
  if (fill.stats.stopped_by === "render_failures") {
    notes.push(`Sampling stopped after 2 failed renders in a row${lastFailure ? ` (last: ${lastFailure})` : ""}; ${fill.stats.samples_not_rendered} planned sample(s) were not rendered. The fill uses the ${fill.stats.samples_used} it got.`);
  } else if (failures > 0) notes.push(`${failures} sample render(s) failed${lastFailure ? ` (last: ${lastFailure})` : ""}; the fill uses the others.`);
  if (fill.stats.stopped_by === "budget") notes.push(`The render budget ran out: ${fill.stats.samples_not_rendered} planned sample(s) were not rendered.`);
  const s = fill.stats;
  const spatialOnly = args.method === "spatial";
  const noTemporal = s.temporal_share === 0;
  const mostlyObject = !args.object_moves && s.unrevealed_share > 0.5;
  if (!spatialOnly && s.samples_used > 0 && (noTemporal || mostlyObject)) {
    const grainHint = `grain can do that: raise object_tolerance, now ${args.object_tolerance}, to about 3 times the grain's sigma, or set object_moves true if the object moves`;
    let rest: string;
    if (args.method === "temporal") rest = "The hole is left unfilled (method temporal): use method auto for a spatial fill.";
    else if (noTemporal) rest = "Everything is spatial. Keep the hole small and thin, or use the patch fill.";
    else rest = `${r2(s.spatial_share * 100)}% of the hole goes to the spatial fill, so keep the hole small and thin, or use the patch fill.`;
    if (noTemporal) {
      notes.push(
        "No hole pixel was filled from the sampled frames: either none showed the background there (a static object on a locked-off or purely panning shot is never revealed)" +
          (args.object_moves ? "" : `, or the samples looked like the object (${grainHint})`) +
          `. ${rest}`
      );
    } else {
      notes.push(
        `${r2(s.unrevealed_share * 100)}% of the hole was judged to be the object in the sampled frames and got no background from them: either the background is never revealed there, or the samples looked like the object (${grainHint}). ${rest}`
      );
    }
  }
  if (s.temporal_low_confidence_share > 0.1) notes.push(`${r2(s.temporal_low_confidence_share * 100)}% of the hole is temporal but low confidence (red in the preview): parallax, a moving object or a loose track. Check the track or shrink the range.`);
  if (s.unfilled_share > 0) notes.push(`${r2(s.unfilled_share * 100)}% of the hole was not filled (method temporal). Use method auto for a spatial fill of the rest.`);
  notes.push(...fill.notes);

  const report: Record<string, unknown> = {
    png_path: pngPath,
    preview_path: previewPath,
    frame,
    ref_time,
    size: [fill.image.width, fill.image.height],
    plate: { index: plate.index, id: plate.id, name: plate.name },
    hole: { regions: polys.length, grow_px: args.grow_px, pixels: s.hole_pixels, share: s.hole_share, crop: fill.crop },
    filled: {
      temporal_share: s.temporal_share,
      temporal_low_confidence_share: s.temporal_low_confidence_share,
      spatial_share: s.spatial_share,
      unfilled_share: s.unfilled_share,
    },
    method: args.method,
    spatial_method: s.spatial_method,
    spatial_iterations: s.spatial_iterations,
    object_moves: args.object_moves,
    samples: {
      planned: samples.length,
      used: s.samples_used,
      skipped: s.samples_skipped,
      color_matched: s.samples_color_matched,
      color_skipped: s.samples_color_skipped,
      color_rejected: s.samples_color_rejected,
      stopped_by_budget: s.stopped_by_budget,
      stopped_by: s.stopped_by,
      not_rendered: s.samples_not_rendered,
      per_pixel: s.sample_count,
      spread_mean: s.spread_mean,
      unrevealed_share: s.unrevealed_share,
    },
    budget: { ...budget.used, max_renders: args.max_frames + 2, max_seconds: args.max_seconds },
    track: track ? { track_id: track.track_id, model: track.model, ref_time: track.ref_time, frames: track.frames.length } : null,
    plate_copy: temp,
    plate_checkpoint: state.checkpoint,
    confidence_legend: "green temporal, red low-confidence temporal, yellow spatial, magenta unfilled",
    notes,
  };
  return { pngPath, frame, report, placement, placementWhy, stillSize: [fill.image.width, fill.image.height] };
  };
  return { finish };
}

// ---------- the receipt checks ----------

/** What the write was asked to set, to check against the read-back (all in the still's pixels). */
export interface InpaintExpectation {
  still_size: [number, number];
  /** The layer position the offset implies, or null when the layer was left where AE put it. */
  position: [number, number] | null;
  /** Masked placement only. */
  feather_px: number | null;
  expansion_px: number | null;
}

export function inpaintMismatches(beforeRaw: unknown, afterRaw: unknown, written: Record<string, unknown>, placed: boolean, want?: InpaintExpectation): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const before = beforeRaw as HostState | null;
  const after = afterRaw as HostState | null;
  if (!before || !after) return m;
  const item = written.item as { id?: number } | undefined;
  // A project past the host's item cap can't be searched for the new item.
  if (after.scanned >= after.num_items) {
    expectThat(m, item !== undefined && after.imported.some((i) => i.id === item.id), "imported", item?.id, after.imported.map((i) => i.id), "The still is not among the project's footage after the import");
  }
  const made = item !== undefined ? after.imported.find((i) => i.id === item.id) : undefined;
  if (want && made) {
    expectThat(m, made.width === want.still_size[0] && made.height === want.still_size[1], "imported.size", want.still_size, [made.width, made.height], "The imported still is not the size of the fill image (the PNG was read at another size)");
  }
  expectThat(m, after.num_items === before.num_items + 1, "num_items", before.num_items + 1, after.num_items, "The project did not grow by exactly the still");
  if (placed) {
    const layer = written.layer as { id?: number } | undefined;
    expectThat(m, !!before.place && !!after.place && after.place.num_layers === before.place.num_layers + 1, "place.num_layers", before.place ? before.place.num_layers + 1 : undefined, after.place?.num_layers, "The target comp did not gain exactly one layer");
    const top = after.place?.top[0];
    expectThat(m, !!top && layer !== undefined && top.id === layer.id, "place.top.id", layer?.id, top?.id, "The new layer is not on top of the target comp");
    expectThat(m, !!top && item !== undefined && top.source_id === item.id, "place.top.source_id", item?.id, top?.source_id, "The top layer is not the imported still");
    const masks = typeof written.masks === "number" ? written.masks : 0;
    expectThat(m, !!top && top.mask_count === masks, "place.top.mask_count", masks, top?.mask_count, "The mask count differs");
    if (want && top) {
      if (want.position && top.position) {
        expectThat(m, Math.abs(top.position[0] - want.position[0]) < 0.05 && Math.abs(top.position[1] - want.position[1]) < 0.05, "place.top.position", want.position, top.position, "The layer is not at the position offset_px asks for");
      }
      if (want.feather_px !== null && want.expansion_px !== null && top.masks) {
        const f = want.feather_px;
        const e = want.expansion_px;
        const bad = top.masks.filter((k) => Math.abs(k.feather - f) > 0.05 || Math.abs(k.expansion - e) > 0.05);
        expectThat(m, top.masks.length === masks && bad.length === 0, "place.top.masks", { feather: f, expansion: e, count: masks }, top.masks, "A mask's feather or expansion differs from what was asked");
      }
    }
  }
  return m;
}

// ---------- the tool ----------

export const inpaintTools: ToolDefinition<any>[] = [
  {
    name: "ae_inpaint_plate",
    description:
      "Remove something from a shot by making a clean plate in the MCP's own Node, the scriptable stand-in for Content-Aware Fill (which has no scripting API). " +
      "Give the plate layer, the hole (up to 16 rect / ellipse / polygon regions in comp pixels at ref_time, grown by grow_px) and, for a moving camera, the plane's track (track_id from ae_track_multi / ae_track_read). " +
      "TEMPORAL: renders up to max_frames frames spread across the shot (of a temporary copy of the comp that shows only the plate layer), carries each into the reference frame through the track, matches its exposure to the reference in the ring around the hole, and takes for every hole pixel the median of the samples that show background (with object_moves false, samples that still look like the object do not vote, and a pixel where the voters' median still sits near the reference is judged to be the object and left to the spatial fill; grain much above a third of object_tolerance can make background pixels look like the object and send them to the spatial fill, and under grain a static object can also leak, so a few percent of the hole may keep the object's colour and still count as temporal fill. Raise object_tolerance to about 3 times the grain's sigma to fix both, use enough frames (the object check is weaker under about 20 samples), and look at the before/after preview to check the fill for leftover object colour; objects close in colour to the background are not measured and may be filled spatially or leave object colour). " +
      "SPATIAL, for pixels no frame reveals: `diffuse` (harmonic fill: wires, rigs, blemishes) or `patch` (exemplar fill from the ring: logos and larger objects on texture). method auto does temporal first, spatial for the rest. " +
      "The result is the reference frame with the hole filled, an 8-bit sRGB PNG in '<project> chroma plates/' (the project must be saved; a file is never overwritten), imported as a still in one undo step and, with place_in_comp, put on top of a patch comp: unmasked in a comp whose name has the word PATCH (the precomp ae_cleanplate_setup makes), else with one feathered mask per hole region and positioned by offset_px. " +
      "To build a new rig around it, import with this tool, then call ae_cleanplate_setup with still_footage_id set to the returned item id. " +
      "It reports how much of the hole was filled temporally, spatially and with low confidence, the samples per pixel, a preview (reference, fill, confidence map) and notes. A static object on a locked-off or purely panning shot is never revealed, so everything is spatial and only small or thin holes come out well: read the temporal share. " +
      "Limits: the hole is at most 25% of the frame; the render budget (max_frames, max_seconds) holds the AE queue only while the frames are rendered (the median, the spatial fill and the PNG write run afterwards in Node, with the queue released, and are not counted in max_seconds), and when it runs out the fill uses the samples it got; a plate at opacity 0 at ref_time is refused when isolate_plate is on; 16/32 bpc projects get an 8-bit still. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeInpaintPlateSchema,
    handler: async (args: AeInpaintPlateArgs, ctx) => {
      ctx.quarantine.assertClear();
      let polys: Pt[][];
      try {
        polys = args.regions.map(regionPolygon);
      } catch (err) {
        return refuse((err as InpaintError).code ?? "bad_args", errMessage(err));
      }
      const toolName = "ae_inpaint_plate";
      const opId = ctx.bridge.newOpId();
      const label = `ae_inpaint_plate(comp ${args.comp_id})`;
      const expect: ExpectGuard = { project_path: args.expect.project_path, comp_id: args.expect.comp_id ?? args.comp_id };

      // Phase 1: the plate (renders in one queue lease, then the fill without it). Nothing in the project changes except the temporary plate copy, which is removed again.
      let built: Built;
      const state: Phase1State = { pastGuard: false, checkpoint: null, temp: null, sessionFields: {} };
      try {
        const got = await queued(ctx, label, opId, () => buildPlate(ctx, opId, args, expect, polys, toolName, label, state));
        if (got.refused) return got.refused;
        // The lease is released; the CPU fill, the PNG and the report run here.
        built = await got.finish();
      } catch (err) {
        // Before the guard passed nothing was written: let it throw. After it, say what happened to the temporary comp.
        if (!state.pastGuard) {
          if (err instanceof PlanarError || err instanceof InpaintError) return refuse(err.code, err.message);
          throw err;
        }
        const made = (err as { plateTemp?: { copy_id: number; removed: boolean; error?: string } } | null)?.plateTemp;
        const code = err instanceof PlanarError || err instanceof InpaintError ? err.code : "failed";
        return { ...refuse(code, errMessage(err)), plate_copy: made ?? state.temp, plate_checkpoint: state.checkpoint, ...state.sessionFields };
      }

      // Phase 2: import and place, a guarded write with a receipt.
      const place = built.placement;
      try {
        const applied = await runGuardedWrite(ctx, {
          toolName,
          label: `${label} import`,
          expect: args.expect,
          compId: args.comp_id,
          read: () => ({ host: "inpaintState", args: { png_path: built.pngPath, place_comp_id: place ? place.comp_id : null } }),
          write: {
            host: "inpaintApply",
            args: {
              png_path: built.pngPath,
              place: place
                ? { comp_id: place.comp_id, mode: place.mode, offset: place.offset, regions: place.regions, feather_px: place.feather_px, expansion_px: place.expansion_px, layer_name: place.layer_name }
                : null,
            },
          },
          check: (before, after, w) =>
            inpaintMismatches(before, after, w, place !== null, {
              still_size: built.stillSize,
              position: place && place.offset ? [place.offset[0] + built.stillSize[0] / 2, place.offset[1] + built.stillSize[1] / 2] : null,
              feather_px: place && place.mode === "masked" ? place.feather_px : null,
              expansion_px: place && place.mode === "masked" ? place.expansion_px : null,
            }),
          present: (_before, _after, w) => ({ item: w.item, layer: w.layer, placed_in: w.placed_in, mode: w.mode, masks: w.masks, png_path: w.png_path }),
        });
        return { ...applied, ...mergeSession(state.sessionFields, applied), fill: built.report, ...(built.placementWhy ? { placement_why: built.placementWhy } : {}) };
      } catch (err) {
        // Phase 1 already wrote (a checkpoint, the plate copy and its removal), so answer with what happened instead of throwing.
        const unsure = err instanceof BridgeError && err.kind === "timeout";
        const code = err instanceof BridgeError ? err.kind : err instanceof PlanarError || err instanceof InpaintError ? err.code : "failed";
        return {
          ok: false,
          applied: false,
          error: code,
          message: `The fill was made but the still was not imported: ${errMessage(err)}${unsure ? " AE did not answer in time, so the import may still have run: look in the Project panel before trying again." : ""} The fill image was saved at ${built.pngPath}; import it by hand or call the tool again.`,
          ...(unsure ? { write_state: "unknown" } : {}),
          png_path: built.pngPath,
          fill: built.report,
          plate_copy: built.report.plate_copy ?? null,
          plate_checkpoint: built.report.plate_checkpoint ?? null,
          ...state.sessionFields,
        };
      }
    },
  },
];
