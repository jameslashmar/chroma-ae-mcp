/**
 * server/src/tools/ext/mattes.ts
 *
 * Mattes that follow a planar track, built from After Effects' own DOM with
 * nothing outside it:
 * - ae_mask_follow: keys an existing mask, or a new one drawn from a region,
 *   so it rides a track. Each vertex and tangent end point is mapped by
 *   P(t) = M(t)^-1 . H(t) . M(ref) (layer space -> comp space at the reference
 *   frame, through the track's motion, back into layer space at t), written
 *   with one setValuesAtTimes in one undo group. Variable-feather arrays stay
 *   on their segments; keys a straight line would reproduce are dropped.
 * - ae_garbage_matte: a hidden comp-size matte solid whose mask comes from a
 *   region (static or tracked), set as the track matte of one or more layers
 *   (alpha / luma, normal or inverted) in one undo group.
 * - ae_caf_prep: everything Content-Aware Fill needs that a script can set (a
 *   tracked Subtract mask, its expansion, the work area) and the exact panel
 *   steps for the one click only the user can make; afterwards `find_fill`
 *   (read only) finds the fill layer CAF generated.
 *
 * The vertex mapper is planar-math's transformShape; the track sources, layer
 * matrices and the 3000-frame limit are planar's. Nothing here is exported for
 * other groups to use.
 *
 * Not built, because AE has no API for it: AE's Track Mask and Roto Brush
 * (strokes, propagation, Freeze) and the Content-Aware Fill panel itself
 * (method, lighting correction, range, Generate). The mask follows planar
 * motion, not deforming shapes like a hand or a person: a holdout for a moving
 * person needs the user's own roto layer (`matte_layer`).
 *
 * Unmeasured on AE 26: setValuesAtTimes with ~1000 Shape objects (speed,
 * memory) and whether the feather arrays survive it, that a matte layer with
 * its video switch off still mattes (documented for 23.0+), the Simple
 * Choker's property match names, assigning featherTypes on a Shape, whether
 * a script-set work area snaps as expected, and the naming of the layer and
 * folder CAF generates (find_fill matches loosely).
 */

import { z } from "zod";
import { BridgeError, SLOW_TIMEOUT_MS } from "../../host.js";
import { buildJsxCall } from "../../jsx.js";
import { QueueWaitError } from "../../queue.js";
import type { ReceiptMismatch } from "../../receipts.js";
import {
  AGENT_SAFETY_GUIDANCE,
  ExpectSchema,
  LayerSelectorSchema,
  type ExpectGuard,
  type LayerSelector,
  type ToolContext,
  type ToolDefinition,
} from "../common.js";
import { frameAt, identityH, invertH, jacobianAt, mulH, relativeTo, transformShape, type Mat3, type PlanarFrame, type PlanarTrack, type ShapeData, type Vec2 } from "./planar-math.js";
import { layerSpaceMatrices, MAX_TRACK_FRAMES, PlanarError, RegionSchema, resolveTrackSourceWithInfo, TrackSourceSchema, type Region, type TrackSource } from "./planar.js";
import { polygonArea } from "./region-math.js";
import { expectThat, runGuardedWrite } from "./write-runner.js";

// ---------- small helpers ----------

const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const r4 = (v: number): number => Math.round(v * 10000) / 10000;
const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const fail = (e: unknown) => ({ ok: false as const, error: (e as PlanarError).code, message: (e as Error).message });

/** Frames one call can key: planar's cap, less the reference frame the layer-space read also takes. */
const MAX_FRAMES = MAX_TRACK_FRAMES - 1;
/** Bezier error (px) above which a perspective track gets a warning. */
const BEZIER_WARN_PX = 0.5;
/** How far a read-back vertex may differ from what was written (AE stores single-precision floats). */
const VERTEX_TOL = 0.05;
const KAPPA = 0.5522847498;
/** The most [x, y] points (vertices and both tangents, times keys) one write sends in a single evalScript string. */
export const MAX_WRITE_POINTS = 300000;

/** Snaps a time to the frame grid, so keys land on frames. */
export const snapToFrame = (t: number, fps: number): number => Math.round(t * fps) / fps;

/** Snapped key times, with the indexes of the keys that stay when two land on the same frame (the first of them wins). */
export function snapKeyTimes(times: number[], fps: number): { times: number[]; idx: number[] } {
  const out: number[] = [];
  const idx: number[] = [];
  times.forEach((t, i) => {
    const st = snapToFrame(t, fps);
    if (out.length === 0 || st > out[out.length - 1]) {
      out.push(st);
      idx.push(i);
    }
  });
  return { times: out, idx };
}

/** Refuses a write that would put too many points into one evalScript string. */
export function checkWriteSize(keys: number, vertices: number, hint = "Key a shorter stretch with `range`, or use a larger decimate_px to drop more keys."): void {
  const points = keys * vertices * 3;
  if (points > MAX_WRITE_POINTS) {
    throw new PlanarError(
      "bad_args",
      `${keys} keys x ${vertices} vertices is ${points} points (vertices and tangents), over the ${MAX_WRITE_POINTS} one call writes. ${hint}`
    );
  }
}

async function queued<T>(ctx: ToolContext, label: string, opId: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await ctx.queue.run(label, fn);
  } catch (err) {
    if (err instanceof QueueWaitError) throw new BridgeError({ kind: "queued", op_id: opId, message: err.message });
    throw err;
  }
}

/** A read-only host call inside a queue lease the caller already holds. */
async function hostRead<T>(ctx: ToolContext, opId: string, tag: string, host: string, args: unknown, toolName: string): Promise<T> {
  const res = await ctx.bridge.evalRaw<T>({
    id: `${opId}_${tag}`,
    script: buildJsxCall(host, args),
    label: `${toolName} ${tag}`,
    mutates: false,
    toolName,
  });
  return res.result;
}

// ---------- schemas ----------

const MASK_MODES = ["add", "subtract", "intersect", "lighten", "darken", "difference", "none"] as const;
const MATTE_TYPES = ["alpha", "alpha_inverted", "luma", "luma_inverted"] as const;

export const MaskRefSchema = z
  .object({
    index: z.number().int().positive().optional().describe("1-based index of the mask on the layer."),
    name: z.string().min(1).optional().describe("The mask's name."),
  })
  .refine((m) => (m.index !== undefined) !== (m.name !== undefined), { message: "Give the mask's index or its name, not both." });

const RangeSchema = z
  .object({ start: z.number().min(0), end: z.number().min(0) })
  .refine((r) => r.end > r.start, { message: "range.end must be after range.start." });

const FeatherSchema = z
  .union([z.number().min(0).max(2000), z.array(z.number().min(0).max(2000)).length(2)])
  .describe("Mask Feather in pixels: one number for both directions or [x, y].");

const TRACK_FIELDS = {
  track: TrackSourceSchema.describe("The motion to follow: a stored track_id (ae_track_multi / ae_track_read) or any source ae_track_read takes."),
  ref_time: z
    .number()
    .min(0)
    .optional()
    .describe("The frame where the mask / region is right, in seconds: the track is re-based so this frame is the identity. Default: the track's own reference frame."),
  range: RangeSchema.optional().describe(
    "Key only the frames inside this time range (seconds). Keys of the path (and of a scaled feather) outside the range are kept, so a long track is done in several calls, one range each; keys already inside the range refuse the write unless replace_keys, which then removes only those. Keys inside the range become linear; kept keys keep their interpolation. Do the range that holds ref_time first: once the path has keys, a ranged call is refused when ref_time lies outside the keyed stretch (the shape there would be a held, already moved key). With scale_feather you may repeat feather for each range. Expansion, opacity and a fixed feather are single values and are replaced as a whole. At most 2999 frames per call."
  ),
  decimate_px: z
    .number()
    .min(0)
    .max(50)
    .default(0.25)
    .describe("Drop keys that linear interpolation between their neighbours reproduces within this many pixels on every coordinate. Default 0.25; 0 keeps a key on every frame."),
  replace_keys: z.boolean().optional().describe("Replace keys already on the written properties. Without it existing keys refuse the write. Expressions always refuse."),
};

export const AeMaskFollowSchema = z
  .object({
    comp_id: z.number().int(),
    layer: LayerSelectorSchema.describe("The layer that carries the mask. Must not be 3D or locked."),
    mask: MaskRefSchema.optional().describe("An existing mask on the layer, as it looks at ref_time. Its vertices (and feather points) are followed."),
    new_mask: z
      .object({
        region: RegionSchema.describe("The shape in comp pixels at ref_time: rect [x, y, w, h], ellipse [cx, cy, rx, ry] or polygon."),
        name: z.string().min(1).max(200).optional().describe("Name of the new mask."),
      })
      .optional()
      .describe("Make a new mask from a region (comp pixels at ref_time) instead of following an existing one."),
    ...TRACK_FIELDS,
    mode: z.enum(MASK_MODES).optional().describe("Mask mode. A new mask is Add."),
    inverted: z.boolean().optional(),
    expansion: z.number().min(-1000).max(1000).optional().describe("Mask Expansion in pixels."),
    feather: FeatherSchema.optional(),
    mask_motion_blur: z.enum(["same_as_layer", "on", "off"]).optional().describe("The mask's own motion blur setting."),
    mask_opacity: z.number().min(0).max(100).optional(),
    scale_feather: z
      .boolean()
      .optional()
      .describe("Scale Mask Feather and the variable-feather radii by the track's zoom at each key (the feather is then keyed too). Default false: feather is copied unchanged."),
    expect: ExpectSchema,
  })
  .refine((v) => (v.mask !== undefined) !== (v.new_mask !== undefined), { message: "Give exactly one of mask (follow an existing mask) or new_mask (draw one from a region)." });

export const AeGarbageMatteSchema = z
  .object({
    comp_id: z.number().int(),
    targets: z.array(LayerSelectorSchema).min(1).max(50).describe("The layers the matte applies to. One matte can feed several layers on AE 23+."),
    matte_type: z
      .enum(MATTE_TYPES)
      .default("alpha")
      .describe("alpha keeps what is inside the region (a garbage matte); alpha_inverted removes it (a holdout area); luma / luma_inverted use the matte's brightness (the solid is white, so luma behaves like alpha)."),
    region: RegionSchema.optional().describe("The matte shape in comp pixels at ref_time."),
    matte_layer: LayerSelectorSchema.optional().describe(
      "Use this existing layer as the matte instead of making one (for example your own roto layer, which a planar track cannot replace for a person or a hand). Then region, track and the mask options do not apply."
    ),
    track: TrackSourceSchema.optional().describe("Make the region follow this motion (a track_id or any source ae_track_read takes). Without it the matte is static."),
    ref_time: TRACK_FIELDS.ref_time,
    range: RangeSchema.optional().describe(
      "Key only the frames inside this time range (seconds), at most 2999 frames. The matte is a new layer on every call, so ranges cannot be joined here: for a longer track make the matte static (no track), then key its mask with ae_mask_follow in ranges (layer = the matte, mask index 1), which keeps the keys of the other ranges."
    ),
    decimate_px: TRACK_FIELDS.decimate_px,
    name: z.string().min(1).max(200).optional().describe("Name of the matte layer. Default '<first target> MATTE'."),
    feather: FeatherSchema.optional(),
    expansion: z.number().min(-1000).max(1000).optional().describe("Mask Expansion in pixels."),
    choke: z.number().min(-100).max(100).optional().describe("Add a Simple Choker to the matte with this Choke Matte amount. Reported, not guaranteed: if the effect or its property is not found the matte is still made."),
    hide_matte: z.boolean().optional().describe("Switch the matte layer's video off, as AE's UI does. Default true."),
    replace_existing_matte: z.boolean().optional().describe("Targets that already have a track matte are refused unless this is true."),
    expect: ExpectSchema,
  })
  .refine((v) => (v.region !== undefined) !== (v.matte_layer !== undefined), { message: "Give exactly one of region (make a matte) or matte_layer (use an existing layer)." })
  .refine((v) => v.matte_layer === undefined || (v.track === undefined && v.feather === undefined && v.expansion === undefined && v.choke === undefined), {
    message: "track, feather, expansion and choke belong to a matte made from a region; they do not apply to matte_layer.",
  })
  .refine((v) => v.track !== undefined || (v.ref_time === undefined && v.range === undefined), { message: "ref_time and range need a track." });

export const AeCafPrepSchema = z
  .object({
    comp_id: z.number().int(),
    layer: LayerSelectorSchema.describe("The plate layer Content-Aware Fill will work on."),
    find_fill: z
      .boolean()
      .optional()
      .describe("Read only: look for the fill layer Content-Aware Fill generated (a footage layer, usually above the plate, whose source sits in a folder named like 'Fill') and report the candidates. Nothing else is needed or changed."),
    mask: MaskRefSchema.optional().describe("An existing mask around the object, as it looks at ref_time."),
    new_mask: z
      .object({
        region: RegionSchema.describe("The shape in comp pixels at ref_time."),
        name: z.string().min(1).max(200).optional().describe("Name of the new mask. Default 'CAF hole'."),
      })
      .optional()
      .describe("Draw the hole as a new mask from a region."),
    track: TRACK_FIELDS.track.optional().describe("Make the mask follow this motion. Without it the mask stays where it is."),
    ref_time: TRACK_FIELDS.ref_time,
    range: TRACK_FIELDS.range,
    decimate_px: TRACK_FIELDS.decimate_px,
    replace_keys: TRACK_FIELDS.replace_keys,
    mask_mode: z
      .enum(["subtract", "none"])
      .default("subtract")
      .describe("subtract (default) cuts the hole Content-Aware Fill fills; the plate shows that hole until the fill exists. none keeps the mask for reference only, for plates whose hole you give CAF another way."),
    expansion: z.number().min(-1000).max(1000).optional().describe("Mask Expansion in pixels. A loose mask (several px past the object's edge, shadow included) fills better than a tight one."),
    set_work_area: z
      .boolean()
      .default(true)
      .describe("Set the comp's work area to the frames the track covers inside `range` (or to `work_area`), because CAF's range option 'Work Area' fills exactly that. Needs a track or `work_area`. Default true."),
    work_area: z
      .object({ start: z.number().min(0), end: z.number().min(0) })
      .refine((r) => r.end > r.start, { message: "work_area.end must be after work_area.start." })
      .optional()
      .describe("The fill range in seconds, overriding the one taken from the track."),
    patch_region: RegionSchema.optional().describe(
      "find_fill only: the hole the fill covers, in comp pixels (as it looks at the track's reference frame), grown by the Expansion and Feather you gave the hole mask (the plate's Subtract mask cuts that bigger area; this tool does not read it back). It is passed on to the ready ae_patch_check call as its `region`: the fill layer is a full-frame footage layer, so ae_patch_check's default footprint (the whole layer) would miss the hole."
    ),
    patch_region_track: TrackSourceSchema.optional().describe("find_fill only: how patch_region moves, passed on to ae_patch_check as `region_track` (needs patch_region)."),
    expect: ExpectSchema.optional().describe("Needed unless find_fill is true."),
  })
  .refine((v) => v.find_fill === true || v.expect !== undefined, { message: "expect is required unless find_fill is true (the tool then changes nothing)." })
  .refine((v) => v.find_fill === true || (v.mask !== undefined) !== (v.new_mask !== undefined), { message: "Give exactly one of mask or new_mask (unless find_fill is true)." })
  .refine((v) => v.find_fill === true || v.track !== undefined || (v.ref_time === undefined && v.range === undefined), { message: "ref_time and range need a track." })
  .refine((v) => v.patch_region_track === undefined || v.patch_region !== undefined, { message: "patch_region_track moves the patch_region you give: add patch_region too." })
  .refine((v) => v.find_fill === true || (v.patch_region === undefined && v.patch_region_track === undefined), { message: "patch_region and patch_region_track belong to find_fill." });

export type AeMaskFollowArgs = z.infer<typeof AeMaskFollowSchema>;
export type AeGarbageMatteArgs = z.infer<typeof AeGarbageMatteSchema>;
export type AeCafPrepArgs = z.infer<typeof AeCafPrepSchema>;

// ---------- pure logic ----------

/** A region as a bezier shape in comp pixels: rect and polygon with straight edges, ellipse with four curved vertices. */
export function regionToShape(region: Region): ShapeData {
  const finite = (v: number[]) => v.every((n) => Number.isFinite(n));
  const zeros = (n: number): Vec2[] => Array.from({ length: n }, () => [0, 0] as Vec2);
  if ("rect" in region) {
    const [x, y, w, h] = region.rect;
    if (!finite(region.rect) || !(w > 0) || !(h > 0)) throw new PlanarError("bad_args", "The rect region needs a positive width and height: [x, y, width, height].");
    return { vertices: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], inTangents: zeros(4), outTangents: zeros(4), closed: true };
  }
  if ("ellipse" in region) {
    const [cx, cy, rx, ry] = region.ellipse;
    if (!finite(region.ellipse) || !(rx > 0) || !(ry > 0)) throw new PlanarError("bad_args", "The ellipse region needs positive radii: [centre x, centre y, radius x, radius y].");
    const ox = rx * KAPPA;
    const oy = ry * KAPPA;
    // Top, right, bottom, left: the order AE's own ellipse tool and ae_mask use.
    return {
      vertices: [[cx, cy - ry], [cx + rx, cy], [cx, cy + ry], [cx - rx, cy]],
      inTangents: [[-ox, 0], [0, -oy], [ox, 0], [0, oy]],
      outTangents: [[ox, 0], [0, oy], [-ox, 0], [0, -oy]],
      closed: true,
    };
  }
  const pts = region.polygon.map((p) => [p[0], p[1]] as Vec2);
  if (!pts.every((p) => finite(p))) throw new PlanarError("bad_args", "The polygon region has a point that is not a finite [x, y].");
  if (polygonArea(pts) < 1e-6) throw new PlanarError("bad_args", "The polygon region encloses no area (its points are collinear).");
  return { vertices: pts, inTangents: zeros(pts.length), outTangents: zeros(pts.length), closed: true };
}

/** A region in ae_patch_check's format (rect as corners). */
export function toPatchRegion(region: Region): Record<string, unknown> {
  if ("rect" in region) {
    const [x, y, w, h] = region.rect;
    return { kind: "rect", rect: [x, y, x + w, y + h] };
  }
  if ("ellipse" in region) {
    const [cx, cy, rx, ry] = region.ellipse;
    return { kind: "ellipse", center: [cx, cy], radius: [rx, ry] };
  }
  return { kind: "polygon", points: region.polygon.map((p) => [p[0], p[1]]) };
}

const stripShape = (s: ShapeData): ShapeData => ({
  vertices: s.vertices.map((p) => [p[0], p[1]] as Vec2),
  inTangents: s.inTangents.map((p) => [p[0], p[1]] as Vec2),
  outTangents: s.outTangents.map((p) => [p[0], p[1]] as Vec2),
  closed: s.closed !== false,
});

const roundShape = (s: ShapeData): ShapeData => ({
  vertices: s.vertices.map((p) => [r3(p[0]), r3(p[1])] as Vec2),
  inTangents: s.inTangents.map((p) => [r3(p[0]), r3(p[1])] as Vec2),
  outTangents: s.outTangents.map((p) => [r3(p[0]), r3(p[1])] as Vec2),
  closed: s.closed,
});

/** Every coordinate of a shape in one flat vector, with `extra` numbers (feather) appended. */
export function shapeVector(s: ShapeData, extra: number[] = []): number[] {
  const v: number[] = [];
  for (const list of [s.vertices, s.inTangents, s.outTangents]) for (const p of list) v.push(p[0], p[1]);
  return [...v, ...extra];
}

export interface FollowedFrame {
  time: number;
  shape: ShapeData;
  /** The track's zoom at the shape's centre (sqrt of the Jacobian's determinant): 1 for a pure move. */
  scale: number;
}

export interface FollowResult {
  frames: FollowedFrame[];
  /** Frame times that could not be mapped (a point behind the plane, a singular matrix). */
  skipped: number[];
  /** Largest distance between a perspective-mapped bezier and the one written, from 8 samples per segment. */
  maxErrorPx: number;
}

/**
 * The shape at every frame: P(t) = M(t)^-1 . H(t) . M(ref) maps layer space at
 * the reference frame to layer space at t, where `H` is the track's re-based
 * motion (comp px, identity at the reference frame) and `M` is layer -> comp
 * (the layer's own animated transform and its parents'). `shape` is in layer
 * space at the reference frame. Vertices and tangent end points are mapped and
 * the tangents rebuilt as differences (transformShape), exact for translate /
 * similarity / affine and approximate for perspective.
 */
export function followShapes(a: { shape: ShapeData; frames: PlanarFrame[]; refM: Mat3; frameMs: Mat3[] }): FollowResult {
  const frames: FollowedFrame[] = [];
  const skipped: number[] = [];
  let maxErrorPx = 0;
  const n = a.shape.vertices.length;
  const centre: Vec2 = [a.shape.vertices.reduce((s, p) => s + p[0], 0) / n, a.shape.vertices.reduce((s, p) => s + p[1], 0) / n];
  a.frames.forEach((f, i) => {
    const M = a.frameMs[i];
    const mInv = M ? invertH(M) : null;
    if (!f.H || !mInv) {
      skipped.push(f.time);
      return;
    }
    const P = mulH(mInv, mulH(f.H, a.refM));
    const J = jacobianAt(P, centre);
    if (!J) {
      skipped.push(f.time);
      return;
    }
    try {
      const t = transformShape(a.shape, P);
      maxErrorPx = Math.max(maxErrorPx, t.maxErrorPx);
      frames.push({ time: f.time, shape: { vertices: t.vertices, inTangents: t.inTangents, outTangents: t.outTangents, closed: t.closed }, scale: Math.sqrt(Math.abs(J[0] * J[3] - J[1] * J[2])) });
    } catch {
      skipped.push(f.time);
    }
  });
  return { frames, skipped, maxErrorPx };
}

/**
 * Indexes of the keys to keep (ascending, first and last always): a key goes
 * when linear interpolation between the kept keys either side of it
 * reproduces its vector within `tol` on every component (Ramer-Douglas-Peucker
 * in time). tol <= 0 keeps everything.
 */
export function decimateKeys(times: number[], vectors: number[][], tol: number): number[] {
  const n = times.length;
  if (n <= 2 || !(tol > 0)) return times.map((_, i) => i);
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop() as [number, number];
    if (b - a < 2) continue;
    let worst = -1;
    let at = -1;
    const span = times[b] - times[a];
    for (let i = a + 1; i < b; i++) {
      const u = span > 0 ? (times[i] - times[a]) / span : 0;
      let err = 0;
      for (let j = 0; j < vectors[i].length; j++) {
        const lerp = vectors[a][j] + (vectors[b][j] - vectors[a][j]) * u;
        err = Math.max(err, Math.abs(vectors[i][j] - lerp));
      }
      if (err > worst) {
        worst = err;
        at = i;
      }
    }
    if (worst > tol) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

const pick = <T>(list: T[], idx: number[]): T[] => idx.map((i) => list[i]);

/** Up to `count` indexes spread over 0..n-1, first and last included. */
export function spreadIndexes(n: number, count: number): number[] {
  if (n <= 0) return [];
  if (n <= count) return Array.from({ length: n }, (_, i) => i);
  if (count < 2) return [0];
  const out = new Set<number>();
  for (let k = 0; k < count; k++) out.add(Math.round((k * (n - 1)) / (count - 1)));
  return [...out].sort((x, y) => x - y);
}

// ---------- host shapes ----------

interface MaskShapeRead {
  vertices: Vec2[];
  inTangents: Vec2[];
  outTangents: Vec2[];
  closed: boolean;
  feather_points: number;
  feather_radii: number[];
}

interface MaskDetail {
  index: number;
  name: string;
  mode: string | null;
  inverted: boolean;
  motion_blur: string | null;
  roto_bezier: boolean;
  locked: boolean;
  feather: [number, number] | null;
  expansion: number | null;
  opacity: number | null;
  shape_keys: number;
  shape_expression: boolean;
  feather_keys: number;
  /** First and last time of the path's keys, seconds (host reports it when the path has keys). */
  shape_key_span?: [number, number];
  expansion_keys: number;
  opacity_keys: number;
  vertices?: number;
  shape?: MaskShapeRead;
  samples?: Array<{ time: number; vertices: Vec2[]; feather_points: number }>;
}

interface CompBrief {
  id: number;
  name: string;
  width: number;
  height: number;
  pixel_aspect: number;
  fps: number;
  duration: number;
  work_area_start: number;
  work_area_duration: number;
  num_layers: number;
}

interface LayerBrief {
  index: number;
  id: number;
  name: string;
  locked: boolean;
  enabled: boolean;
  three_d: boolean;
}

interface MaskRead {
  comp: CompBrief;
  layer: LayerBrief;
  can_hold_masks: boolean;
  mask_count: number;
  pin_effects: string[];
  mask: MaskDetail | null;
}

// ---------- the follow plan (shared by ae_mask_follow, ae_garbage_matte and ae_caf_prep) ----------

interface TrackInput {
  track?: TrackSource;
  refTime?: number;
  range?: { start: number; end: number };
  decimatePx: number;
}

/** The frames of a re-based track a call writes: ok, with a solved H, inside the range. */
function framesToWrite(
  based: PlanarTrack,
  range: { start: number; end: number } | undefined,
  what: string,
  hint = "Do it in ranges (range: {start, end})."
): { frames: PlanarFrame[]; notOk: number[] } {
  const half = 0.5 / (based.fps || 25);
  const inRange = based.frames.filter((f) => !range || (f.time >= range.start - half && f.time <= range.end + half));
  const frames = inRange.filter((f) => f.ok && f.H !== null);
  const notOk = inRange.filter((f) => !(f.ok && f.H !== null)).map((f) => f.time);
  if (frames.length === 0) throw new PlanarError("bad_args", `No frame of the track is ok inside that range, so there is nothing to ${what}.`);
  if (frames.length > MAX_FRAMES) {
    throw new PlanarError("bad_args", `The track has ${frames.length} frames to key, over the ${MAX_FRAMES} one call handles. ${hint}`);
  }
  return { frames, notOk };
}

/** The track re-based on its reference frame, which must have a solved H. */
async function loadBased(ctx: ToolContext, opId: string, compId: number, a: TrackInput): Promise<{ based: PlanarTrack; refTime: number; sourceInfo: Record<string, unknown> | null }> {
  if (!a.track) throw new PlanarError("bad_args", "A track is needed.");
  const got = await resolveTrackSourceWithInfo(ctx, opId, compId, a.track);
  const asked = a.refTime ?? got.track.ref_time;
  const based = relativeTo(got.track, asked);
  // relativeTo rebases on the frame within half a frame of the asked time: that frame is the identity, so it is the reference for every read and write.
  const refTime = based.ref_time;
  const refFrame = frameAt(based, refTime);
  if (!refFrame || !refFrame.ok || !refFrame.H) {
    throw new PlanarError("bad_args", `The reference frame at ${r4(asked)} s has no solved motion, so it cannot be the frame the shape is right at. Pass a ref_time where the track is ok.`);
  }
  return { based, refTime, sourceInfo: got.info };
}

function checkCompMatchesTrack(info: MaskRead, based: PlanarTrack | null, compId: number, notes?: string[]): void {
  if (Number(info.comp.pixel_aspect) > 0 && Math.abs(Number(info.comp.pixel_aspect) - 1) > 1e-6) {
    throw new PlanarError("refused", `The comp's pixel aspect is ${info.comp.pixel_aspect}, not 1. Planar tracking works on square pixels only.`);
  }
  if (based && (info.comp.width !== based.comp_size[0] || info.comp.height !== based.comp_size[1])) {
    throw new PlanarError(
      "refused",
      `The track was made in a ${based.comp_size[0]}x${based.comp_size[1]} comp and comp ${compId} is ${info.comp.width}x${info.comp.height}: the points are in comp pixels, so the sizes must match.`
    );
  }
  if (based && notes) noteTrackOrigin(based, info.comp, compId, notes);
}

/** The track came from another comp or frame rate: say so, the keys are re-timed onto this comp's frames. */
function noteTrackOrigin(based: PlanarTrack, comp: { fps: number }, compId: number, notes: string[]): void {
  if (based.comp_id !== compId) {
    notes.push(`The track was made in comp ${based.comp_id}, not comp ${compId}: it is applied here because the sizes match. Check that both comps show the same footage in the same place.`);
  }
  if (based.fps > 0 && comp.fps > 0 && Math.abs(based.fps - comp.fps) > 1e-6) {
    notes.push(`The track is ${r3(based.fps)} fps and this comp is ${r3(comp.fps)} fps: key times are snapped onto this comp's frames, up to half a frame off.`);
  }
}

interface FollowInput extends TrackInput {
  toolName: string;
  compId: number;
  layer: LayerSelector;
  mask?: { index?: number; name?: string };
  newMask?: { region: Region; name?: string };
  replaceKeys: boolean;
  scaleFeather: boolean;
  props: { name?: string; mode?: string; inverted?: boolean; expansion?: number; feather?: [number, number]; motionBlur?: string; opacity?: number };
  /** "track": the frames the track covers inside the range; an object: those seconds; null: leave the work area alone. */
  workArea: "track" | { start: number; end: number } | null;
}

interface FollowPlan {
  layer: LayerBrief;
  info: MaskRead;
  maskIndex: number | null;
  refTime: number;
  keyed: boolean;
  times: number[];
  shapes: ShapeData[];
  staticShape: ShapeData | null;
  closed: boolean;
  featherScales: number[] | null;
  baseFeather: [number, number] | null;
  staticFeather: [number, number] | null;
  workArea: { start: number; duration: number } | null;
  frameCount: number;
  keptCount: number;
  skipped: number[];
  notOk: number[];
  maxErrorPx: number;
  track: PlanarTrack | null;
  sourceInfo: Record<string, unknown> | null;
  notes: string[];
  vertexCount: number;
  /** Set when `range` is given: only path (and scaled-feather) keys inside it are replaced; keys outside stay. */
  keyRange: { start: number; end: number } | null;
}

/**
 * Reads what the follow needs and computes every key. Read-only; call it
 * before runGuardedWrite. Refusals are PlanarErrors.
 */
async function planFollow(ctx: ToolContext, a: FollowInput): Promise<FollowPlan> {
  const opId = ctx.bridge.newOpId();
  return queued(ctx, `${a.toolName} plan(${a.compId})`, opId, async () => {
    const notes: string[] = [];
    let based: PlanarTrack | null = null;
    let refTime = a.refTime ?? 0;
    let sourceInfo: Record<string, unknown> | null = null;
    if (a.track) {
      const got = await loadBased(ctx, opId, a.compId, a);
      based = got.based;
      refTime = got.refTime;
      sourceInfo = got.sourceInfo;
    }
    const info = await hostRead<MaskRead>(
      ctx,
      opId,
      "maskread",
      "mattesMaskRead",
      { comp_id: a.compId, layer: a.layer, mask: a.mask ?? null, ref_time: refTime, with_shape: a.mask !== undefined },
      a.toolName
    );
    checkCompMatchesTrack(info, based, a.compId, notes);
    if (!info.can_hold_masks) throw new PlanarError("refused", `Layer "${info.layer.name}" can't hold masks.`);
    if (info.layer.locked) throw new PlanarError("refused", `Layer "${info.layer.name}" is locked.`);
    if (info.layer.three_d) throw new PlanarError("refused", `Layer "${info.layer.name}" is a 3D layer; planar tracks work in 2D only.`);
    const mask = info.mask;
    if (a.mask && !mask) throw new PlanarError("not_found", "The mask was not found.");
    if (mask) {
      if (mask.locked) throw new PlanarError("refused", `Mask ${mask.index} ("${mask.name}") is locked.`);
      if (mask.shape_expression) throw new PlanarError("refused", `Mask ${mask.index}'s path has an expression, which would override the keys; remove the expression first (ae_path_link with unlink).`);
      if (based && mask.shape_keys > 0 && !a.replaceKeys && !a.range) {
        throw new PlanarError("refused", `Mask ${mask.index}'s path already has ${mask.shape_keys} keys; pass replace_keys to replace them (the shape at ref_time is the one followed).`);
      }
      if (based && a.range && mask.shape_keys > 0 && mask.shape_key_span) {
        // The path read at ref_time is the base shape: outside the keys AE holds the end key, which has already moved.
        // Half a frame of the coarser grid: the track's frames and the comp's frames (the keys sit on the comp's) can differ.
        const slack = Math.max(0.5 / (based.fps || 25), 0.5 / (info.comp.fps || 25));
        if (refTime < mask.shape_key_span[0] - slack || refTime > mask.shape_key_span[1] + slack) {
          throw new PlanarError(
            "refused",
            `Mask ${mask.index}'s path has keys from ${r4(mask.shape_key_span[0])} s to ${r4(mask.shape_key_span[1])} s and ref_time ${r4(refTime)} s is outside them, so the shape read there is a held, already moved key and the motion would be applied twice. Do the range that holds ref_time first, then the others. The keys already written cannot be extended from another stretch: undo them (Ctrl+Z in AE) or remove them from the mask, then start again with the range that holds ref_time.`
          );
        }
      }
      if (!a.replaceKeys) {
        const keyed = (n: number, what: string) => `Mask ${mask.index}'s ${what} already has ${n} keys; pass replace_keys to replace them.`;
        const rangedFeather = a.range !== undefined && a.scaleFeather && a.props.feather !== undefined && (a.props.feather[0] > 0 || a.props.feather[1] > 0);
        if (a.props.feather !== undefined && mask.feather_keys > 0 && !rangedFeather) throw new PlanarError("refused", keyed(mask.feather_keys, "feather"));
        if (a.props.expansion !== undefined && mask.expansion_keys > 0) throw new PlanarError("refused", keyed(mask.expansion_keys, "expansion"));
        if (a.props.opacity !== undefined && mask.opacity_keys > 0) throw new PlanarError("refused", keyed(mask.opacity_keys, "opacity"));
      }
      if (mask.roto_bezier) notes.push("The mask is a RotoBezier mask: AE ignores its tangents, only the vertices are moved.");
    }
    if (info.pin_effects.length > 0) {
      notes.push(
        `Layer "${info.layer.name}" has a pin effect (${info.pin_effects.join(", ")}). Masks render before effects, so a mask on a pinned layer already follows the pin; keying this mask with the same track would double the motion.`
      );
    }

    let frames: PlanarFrame[] = [];
    let notOk: number[] = [];
    if (based) {
      const picked = framesToWrite(based, a.range, "key");
      frames = picked.frames;
      notOk = picked.notOk;
    }

    // Layer-space matrices: needed to bring a region into layer space and to follow the layer's own motion.
    const layerRef = { index: info.layer.index, id: info.layer.id };
    let refM: Mat3 = identityH();
    let frameMs: Mat3[] = [];
    if (based || a.newMask) {
      const ms = await layerSpaceMatrices(ctx, opId, a.compId, layerRef, [refTime, ...frames.map((f) => f.time)]);
      refM = ms[0];
      frameMs = ms.slice(1);
    }

    // The shape at the reference frame, in layer space.
    let shape: ShapeData | null = null;
    if (mask?.shape) {
      shape = stripShape({ vertices: mask.shape.vertices, inTangents: mask.shape.inTangents, outTangents: mask.shape.outTangents, closed: mask.shape.closed });
    } else if (a.newMask) {
      const inv = invertH(refM);
      if (!inv) throw new PlanarError("refused", `Layer "${info.layer.name}" has a singular transform at ${r4(refTime)} s, so a comp-space region cannot be brought into its space.`);
      try {
        shape = stripShape(transformShape(regionToShape(a.newMask.region), inv));
      } catch (err) {
        if (err instanceof PlanarError) throw err;
        throw new PlanarError("refused", errMessage(err));
      }
    }

    const plan: FollowPlan = {
      layer: info.layer,
      info,
      maskIndex: mask ? mask.index : null,
      refTime,
      keyed: false,
      times: [],
      shapes: [],
      staticShape: null,
      closed: shape ? shape.closed !== false : true,
      featherScales: null,
      baseFeather: null,
      staticFeather: a.props.feather ?? null,
      workArea: null,
      frameCount: frames.length,
      keptCount: 0,
      skipped: [],
      notOk,
      maxErrorPx: 0,
      track: based,
      sourceInfo,
      notes,
      vertexCount: shape ? shape.vertices.length : 0,
      keyRange: null,
    };
    // A range merges: keys outside it stay, keys inside it need replace_keys (the host checks, before it changes anything).
    if (based && a.range) {
      const half = 0.5 / (based.fps || 25);
      plan.keyRange = { start: a.range.start - half, end: a.range.end + half };
      const compHalf = 0.5 / (info.comp.fps || 25);
      const slackOut = Math.max(half, compHalf);
      if ((!mask || mask.shape_keys === 0) && (refTime < a.range.start - slackOut || refTime > a.range.end + slackOut)) {
        notes.push(
          `range: ref_time ${r4(refTime)} s lies outside this call's range (${r4(a.range.start)} s to ${r4(a.range.end)} s). The keys written now do not hold the shape at ref_time, so a later ranged call on this mask will be refused. The range that holds ref_time should have come first; to start over, undo this call (Ctrl+Z in AE) or remove the mask's keys, then begin with the range that holds ref_time.`
        );
      }
      if (mask && (mask.shape_keys > 0 || mask.feather_keys > 0)) {
        notes.push("range: keys of the path (and of a scaled feather) outside the range are kept; keys inside it are replaced only with replace_keys.");
      }
    }

    if (based && shape) {
      const followed = followShapes({ shape, frames, refM, frameMs });
      if (followed.frames.length === 0) throw new PlanarError("bad_args", "No frame could be converted into a mask path (every frame was degenerate).");
      plan.skipped = followed.skipped;
      plan.maxErrorPx = followed.maxErrorPx;
      // Feather scaling: only when there is something to scale.
      const baseFeather: [number, number] = a.props.feather ?? mask?.feather ?? [0, 0];
      const radii = mask?.shape?.feather_radii ?? [];
      const scaleOn = a.scaleFeather && (baseFeather[0] > 0 || baseFeather[1] > 0 || radii.length > 0);
      if (a.scaleFeather && !scaleOn) notes.push("scale_feather had nothing to scale: the mask has no feather and no variable-feather points.");
      if (scaleOn && mask && mask.feather_keys > 0 && !a.replaceKeys && !a.range) {
        throw new PlanarError("refused", `Mask ${mask.index}'s feather already has ${mask.feather_keys} keys; pass replace_keys to replace them.`);
      }
      const times = followed.frames.map((f) => f.time);
      const vectors = followed.frames.map((f) => shapeVector(f.shape, scaleOn ? [baseFeather[0] * f.scale, baseFeather[1] * f.scale, ...radii.map((r) => r * f.scale)] : []));
      const keep = decimateKeys(times, vectors, a.decimatePx);
      plan.keyed = true;
      const kept = pick(followed.frames, keep);
      const snapped = snapKeyTimes(kept.map((f) => f.time), info.comp.fps || 25);
      const keptSnapped = snapped.idx.map((i) => kept[i]);
      checkWriteSize(keptSnapped.length, shape.vertices.length);
      plan.times = snapped.times;
      // Keys snap to the comp's frame grid: cover them, whatever the track's rate.
      if (plan.keyRange && snapped.times.length > 0) {
        plan.keyRange = {
          start: Math.min(plan.keyRange.start, snapped.times[0] - 1e-6),
          end: Math.max(plan.keyRange.end, snapped.times[snapped.times.length - 1] + 1e-6),
        };
      }
      plan.shapes = keptSnapped.map((f) => roundShape(f.shape));
      plan.keptCount = keptSnapped.length;
      if (scaleOn) {
        plan.featherScales = keptSnapped.map((f) => r4(f.scale));
        plan.baseFeather = baseFeather;
        plan.staticFeather = null;
      }
      if (followed.maxErrorPx > BEZIER_WARN_PX) {
        notes.push(
          `The perspective motion bends the mask's curves: the rebuilt beziers stray up to ${r3(followed.maxErrorPx)} px from the true image (over ${BEZIER_WARN_PX} px). Vertices are exact; add vertices to curved segments for a closer fit, or use an affine / similarity track.`
        );
      }
      if (plan.skipped.length + notOk.length > 0) {
        notes.push(`${plan.skipped.length + notOk.length} frame(s) were not keyed (not ok in the track, or degenerate for this layer); the keys interpolate across them.`);
      }
      if (a.decimatePx > 0 && plan.keptCount < followed.frames.length) {
        notes.push(`${followed.frames.length - plan.keptCount} of ${followed.frames.length} keys were dropped because linear interpolation reproduces them within ${a.decimatePx} px.`);
      }
      if (based.model === "perspective" && based.ref_points.length === 4) notes.push("Perspective from exactly 4 points has no redundancy.");
    } else if (a.newMask && shape) {
      plan.staticShape = roundShape(shape);
    }

    // The work area: start and end on the frame grid, never past the comp's end, so start + duration fits exactly.
    const fps = info.comp.fps || 25;
    const compEnd = info.comp.duration;
    let waStart: number | null = null;
    let waEnd: number | null = null;
    if (a.workArea === "track") {
      if (frames.length > 0) {
        waStart = snapToFrame(Math.max(0, frames[0].time), fps);
        waEnd = snapToFrame(frames[frames.length - 1].time + 1 / fps, fps);
      }
    } else if (a.workArea) {
      waStart = snapToFrame(a.workArea.start, fps);
      waEnd = snapToFrame(a.workArea.end, fps);
    }
    if (waStart !== null && waEnd !== null) {
      waEnd = Math.min(waEnd, compEnd);
      if (waEnd > waStart + 0.5 / fps) {
        plan.workArea = { start: waStart, duration: waEnd - waStart };
      } else if (a.workArea !== "track") {
        throw new PlanarError("bad_args", `The work area from ${waStart} s to ${waEnd} s is shorter than one frame once snapped to the frame grid and kept inside the comp (${compEnd} s).`);
      }
    }
    return plan;
  });
}

/** The host call that writes a plan. */
function followWriteArgs(a: FollowInput, plan: FollowPlan, label: string): Record<string, unknown> {
  return {
    comp_id: a.compId,
    layer: { index: plan.layer.index, id: plan.layer.id },
    mask: plan.maskIndex !== null ? { index: plan.maskIndex } : null,
    name: a.props.name ?? a.newMask?.name,
    mode: a.props.mode,
    inverted: a.props.inverted,
    motion_blur: a.props.motionBlur,
    opacity: a.props.opacity,
    expansion: a.props.expansion,
    feather: plan.staticFeather ?? undefined,
    base_feather: plan.baseFeather ?? undefined,
    feather_scales: plan.featherScales ?? undefined,
    ref_time: plan.refTime,
    closed: plan.closed,
    times: plan.times,
    shapes: plan.keyed ? plan.shapes : undefined,
    static_shape: plan.staticShape ?? undefined,
    replace_keys: a.replaceKeys,
    key_range: plan.keyRange ?? undefined,
    work_area: plan.workArea ?? undefined,
    label,
  };
}

// ---------- receipt checks ----------

export interface FollowExpect {
  /** Keys the path should have, or null when the path was not written. */
  keys: number | null;
  vertexCount: number;
  sampleTimes: number[];
  sampleVertices: Vec2[][];
  mode?: string;
  inverted?: boolean;
  expansion?: number;
  feather?: [number, number];
  featherKeyed?: boolean;
  /** Variable-feather points every sampled path should still have (the mask's own count); leave out for a new mask. */
  featherPoints?: number;
  workArea?: { start: number; duration: number };
  frameDuration: number;
}

const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol;

/** Compares the mask read back after a write with what the write was meant to leave. `after` is a mattesMaskRead result. */
export function followMismatches(exp: FollowExpect, afterRaw: unknown): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const after = afterRaw && typeof afterRaw === "object" ? (afterRaw as MaskRead) : null;
  if (!after) return m;
  const mask = after.mask;
  if (!mask) {
    m.push({ path: "mask", expected: "present", actual: undefined, message: "The mask is not in the read-back" });
    return m;
  }
  if (exp.keys !== null) {
    expectThat(m, mask.shape_keys === exp.keys, "mask.shape_keys", exp.keys, mask.shape_keys, "Key count of the mask path differs");
    const count = mask.vertices ?? mask.samples?.[0]?.vertices.length;
    if (count !== undefined) expectThat(m, count === exp.vertexCount, "mask.vertices", exp.vertexCount, count, "Vertex count differs");
    exp.sampleTimes.forEach((t, i) => {
      const got = mask.samples?.find((s) => near(s.time, t, 1e-6)) ?? mask.samples?.[i];
      const want = exp.sampleVertices[i];
      const ok = !!got && !!want && got.vertices.length === want.length && want.every((p, k) => near(got.vertices[k][0], p[0], VERTEX_TOL) && near(got.vertices[k][1], p[1], VERTEX_TOL));
      expectThat(m, ok, `mask.path@${t}`, want, got?.vertices, "The path at this key differs from what was written");
      if (exp.featherPoints !== undefined && got) {
        expectThat(m, got.feather_points === exp.featherPoints, `mask.feather_points@${t}`, exp.featherPoints, got.feather_points, "The variable-feather points of the path were lost or changed");
      }
    });
  }
  if (exp.mode !== undefined) expectThat(m, mask.mode === exp.mode, "mask.mode", exp.mode, mask.mode, "Mask mode differs");
  if (exp.inverted !== undefined) expectThat(m, mask.inverted === exp.inverted, "mask.inverted", exp.inverted, mask.inverted, "Mask inversion differs");
  if (exp.expansion !== undefined) expectThat(m, mask.expansion !== null && near(mask.expansion, exp.expansion, 1e-3), "mask.expansion", exp.expansion, mask.expansion, "Mask expansion differs");
  if (exp.feather) {
    const f = mask.feather;
    expectThat(m, !!f && near(f[0], exp.feather[0], 1e-3) && near(f[1], exp.feather[1], 1e-3), "mask.feather", exp.feather, f, "Mask feather differs");
  }
  if (exp.featherKeyed) expectThat(m, mask.feather_keys > 0, "mask.feather_keys", ">0", mask.feather_keys, "The feather was not keyed");
  if (exp.workArea) {
    const tol = exp.frameDuration * 1.01 + 1e-6;
    expectThat(m, near(after.comp.work_area_start, exp.workArea.start, tol), "comp.work_area_start", exp.workArea.start, after.comp.work_area_start, "Work area start differs");
    expectThat(m, near(after.comp.work_area_duration, exp.workArea.duration, tol), "comp.work_area_duration", exp.workArea.duration, after.comp.work_area_duration, "Work area length differs");
  }
  return m;
}

function expectOf(a: FollowInput, plan: FollowPlan): FollowExpect {
  const idx = spreadIndexes(plan.times.length, 5);
  const exp: FollowExpect = {
    keys: plan.keyed ? plan.times.length : plan.staticShape ? 0 : null,
    vertexCount: plan.vertexCount,
    sampleTimes: plan.keyed ? idx.map((i) => plan.times[i]) : plan.staticShape ? [plan.refTime] : [],
    sampleVertices: plan.keyed ? idx.map((i) => plan.shapes[i].vertices) : plan.staticShape ? [plan.staticShape.vertices] : [],
    frameDuration: 1 / (plan.info.comp.fps || 25),
  };
  const fpts = plan.info.mask?.shape?.feather_points;
  if ((plan.keyed || plan.staticShape) && fpts !== undefined) exp.featherPoints = fpts;
  if (a.props.mode !== undefined) exp.mode = a.props.mode;
  else if (!plan.maskIndex) exp.mode = "add";
  if (a.props.inverted !== undefined) exp.inverted = a.props.inverted;
  if (a.props.expansion !== undefined) exp.expansion = a.props.expansion;
  if (plan.staticFeather) exp.feather = plan.staticFeather;
  if (plan.featherScales) exp.featherKeyed = true;
  if (plan.workArea) exp.workArea = plan.workArea;
  return exp;
}

// ---------- ae_mask_follow / ae_caf_prep write ----------

interface FollowWritten extends Record<string, unknown> {
  mask?: { index: number; name: string };
  created?: boolean;
  keys?: number;
  replaced_keys?: number;
  /** Path keys left outside a `range` (kept from before). */
  kept_keys?: number;
  work_area?: { start: number; duration: number };
}

async function writeFollow(ctx: ToolContext, a: FollowInput, plan: FollowPlan, expect: ExpectGuard, label: string): Promise<{ result: Record<string, unknown>; exp: FollowExpect }> {
  const exp = expectOf(a, plan);
  const layerRef = { index: plan.layer.index, id: plan.layer.id };
  const sampleTimes = exp.sampleTimes;
  const result = await runGuardedWrite<FollowWritten>(ctx, {
    toolName: a.toolName,
    label,
    expect,
    compId: a.compId,
    read: (phase, written) => {
      const index = phase === "after" ? written?.mask?.index : plan.maskIndex;
      return {
        host: "mattesMaskRead",
        args: { comp_id: a.compId, layer: layerRef, mask: index ? { index } : null, ref_time: plan.refTime, times: phase === "after" ? sampleTimes : undefined },
      };
    },
    write: { host: "mattesFollowApply", args: followWriteArgs(a, plan, a.toolName === "ae_caf_prep" ? "CAF prep" : "Mask follow"), timeoutMs: SLOW_TIMEOUT_MS },
    check: (_before, after, written) => {
      // With a range the path also holds the keys kept from before.
      const total = exp.keys !== null && plan.keyRange ? { ...exp, keys: exp.keys + Number(written?.kept_keys ?? 0) } : exp;
      return followMismatches(total, after);
    },
  });
  return { result, exp };
}

/** What the host reports it had to work around, as notes. */
function writeOutcomeNotes(result: Record<string, unknown>, notes: string[]): void {
  if (result.feather_fallback) {
    notes.push(
      `AE rejected the path with its variable-feather arrays (${errMessage(result.feather_error)}), so it was written again without them: ${String(result.feather_points_dropped)} feather point(s) were dropped. Re-create the variable feather by hand or with ae_path_write.`
    );
  }
  if (result.path_error) notes.push(`The path could not be written: ${errMessage(result.path_error)}. The mask exists; the receipt shows what it holds.`);
  if (result.interpolation_error) notes.push(`The keys were written but could not be set to linear: ${errMessage(result.interpolation_error)}.`);
  if (result.work_area_error) notes.push(`The work area could not be set (${errMessage(result.work_area_error)}); it was put back as it was. Set it by hand.`);
}

function followSummary(plan: FollowPlan, result: Record<string, unknown>): Record<string, unknown> {
  const t = plan.track;
  return {
    layer: { index: plan.layer.index, id: plan.layer.id, name: plan.layer.name },
    ...(t ? { track_id: t.track_id, track_model: t.model } : {}),
    ref_time: r4(plan.refTime),
    ...(t
      ? {
          frames: {
            solved: plan.frameCount,
            keyed: plan.keyed ? plan.keptCount : 0,
            dropped_by_decimation: plan.keyed ? plan.frameCount - plan.skipped.length - plan.keptCount : 0,
            not_keyed: [...plan.notOk, ...plan.skipped].length,
          },
          max_bezier_error_px: r3(plan.maxErrorPx),
          ...(plan.notOk.length + plan.skipped.length > 0 ? { frames_not_keyed: [...plan.notOk, ...plan.skipped].sort((x, y) => x - y).slice(0, 100).map(r4) } : {}),
        }
      : {}),
    ...(plan.featherScales ? { feather_scaled: true } : {}),
    ...(plan.sourceInfo ? { source_info: plan.sourceInfo } : {}),
    mask: result.mask,
  };
}

// ---------- ae_mask_follow ----------

async function maskFollow(ctx: ToolContext, args: AeMaskFollowArgs): Promise<Record<string, unknown>> {
  const input: FollowInput = {
    toolName: "ae_mask_follow",
    compId: args.comp_id,
    layer: args.layer,
    mask: args.mask,
    newMask: args.new_mask,
    track: args.track,
    refTime: args.ref_time,
    range: args.range,
    decimatePx: args.decimate_px,
    replaceKeys: args.replace_keys === true,
    scaleFeather: args.scale_feather === true,
    props: {
      mode: args.mode,
      inverted: args.inverted,
      expansion: args.expansion,
      feather: args.feather === undefined ? undefined : Array.isArray(args.feather) ? ([args.feather[0], args.feather[1]] as [number, number]) : [args.feather, args.feather],
      motionBlur: args.mask_motion_blur,
      opacity: args.mask_opacity,
    },
    workArea: null,
  };
  const plan = await planFollow(ctx, input);
  const { result } = await writeFollow(ctx, input, plan, args.expect, `ae_mask_follow(${plan.layer.name})`);
  writeOutcomeNotes(result, plan.notes);
  return {
    ok: true,
    ...result,
    ...followSummary(plan, result),
    notes: plan.notes,
  };
}

// ---------- ae_garbage_matte ----------

interface GarbageLayerEntry {
  found: boolean;
  id?: number;
  index?: number;
  name?: string;
  enabled?: boolean;
  locked?: boolean;
  matte_type?: string;
  matte_layer?: { index: number; id: number; name: string } | null;
  is_track_matte?: boolean;
  message?: string;
}

interface GarbageRead {
  comp: CompBrief;
  layers: GarbageLayerEntry[];
  matte: (GarbageLayerEntry & { is_solid?: boolean; effects?: string[]; choke?: number | null; mask_count?: number; mask?: MaskDetail | null }) | null;
}

interface GarbageWritten extends Record<string, unknown> {
  created?: boolean;
  api?: string;
  targets?: Array<{ index: number; id: number; name: string; previous_matte?: unknown; error?: string }>;
  enabled_error?: string;
  keys?: number;
  mask?: { index: number };
  choke?: { applied: boolean; value: number; error?: string };
  matte?: { index: number; id: number; name: string };
  hidden?: boolean;
  top_target_index_before?: number;
}

export interface GarbageExpect {
  matteType: string;
  hide: boolean;
  created: boolean;
  keys: number | null;
  vertexCount: number;
  sampleTimes: number[];
  sampleVertices: Vec2[][];
  feather?: [number, number];
  expansion?: number;
  name?: string;
}

export function garbageMismatches(exp: GarbageExpect, beforeRaw: unknown, afterRaw: unknown, written: GarbageWritten): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const before = beforeRaw && typeof beforeRaw === "object" ? (beforeRaw as GarbageRead) : null;
  const after = afterRaw && typeof afterRaw === "object" ? (afterRaw as GarbageRead) : null;
  if (!after) return m;
  const matteId = written.matte?.id;
  for (const t of written.targets ?? []) {
    const got = after.layers.find((l) => l.found && l.id === t.id);
    if (!got) {
      m.push({ path: `targets[${t.id}]`, expected: "present", actual: undefined, message: `Target "${t.name}" is not in the read-back` });
      continue;
    }
    expectThat(m, got.matte_type === exp.matteType, `targets[${t.id}].matte_type`, exp.matteType, got.matte_type, `Track matte type of "${t.name}" differs`);
    if (written.api === "legacy") {
      // Before AE 23 there is no Layer.trackMatteLayer: the matte is the layer directly above the target.
      const above = got.matte_layer ? got.matte_layer.id === matteId : after.matte !== null && after.matte !== undefined && got.index !== undefined && after.matte.index === got.index - 1 && after.matte.id === matteId;
      expectThat(m, above, `targets[${t.id}].matte_layer`, matteId, got.matte_layer?.id ?? "not the layer above", `The layer above "${t.name}" is not the matte`);
    } else {
      expectThat(m, got.matte_layer?.id === matteId, `targets[${t.id}].matte_layer`, matteId, got.matte_layer?.id, `Track matte layer of "${t.name}" differs`);
    }
  }
  const matte = after.matte;
  if (!matte) {
    m.push({ path: "matte", expected: matteId, actual: undefined, message: "The matte layer is not in the read-back" });
    return m;
  }
  expectThat(m, matte.enabled === !exp.hide, "matte.enabled", !exp.hide, matte.enabled, exp.hide ? "The matte layer's video is still on" : "The matte layer's video is off");
  if (!exp.created) return m;
  if (before) expectThat(m, after.comp.num_layers === before.comp.num_layers + 1, "comp.num_layers", before.comp.num_layers + 1, after.comp.num_layers, "Layer count did not grow by one");
  if (exp.name) expectThat(m, matte.name === exp.name, "matte.name", exp.name, matte.name, "Matte layer name differs");
  if (written.top_target_index_before !== undefined) {
    expectThat(m, matte.index === written.top_target_index_before, "matte.index", written.top_target_index_before, matte.index, "The matte is not directly above the topmost target");
  }
  expectThat(m, matte.is_solid === true, "matte.is_solid", true, matte.is_solid, "The matte layer is not a solid");
  const mask = matte.mask;
  if (!mask) {
    m.push({ path: "matte.mask", expected: "present", actual: undefined, message: "The matte layer has no mask" });
    return m;
  }
  expectThat(m, mask.mode === "add", "matte.mask.mode", "add", mask.mode, "Matte mask mode differs");
  if (exp.keys !== null) {
    expectThat(m, mask.shape_keys === exp.keys, "matte.mask.shape_keys", exp.keys, mask.shape_keys, "Key count of the matte path differs");
    const count = mask.vertices ?? mask.samples?.[0]?.vertices.length;
    if (count !== undefined) expectThat(m, count === exp.vertexCount, "matte.mask.vertices", exp.vertexCount, count, "Vertex count differs");
    exp.sampleTimes.forEach((t, i) => {
      const got = mask.samples?.find((s) => near(s.time, t, 1e-6)) ?? mask.samples?.[i];
      const want = exp.sampleVertices[i];
      const ok = !!got && !!want && got.vertices.length === want.length && want.every((p, k) => near(got.vertices[k][0], p[0], VERTEX_TOL) && near(got.vertices[k][1], p[1], VERTEX_TOL));
      expectThat(m, ok, `matte.mask.path@${t}`, want, got?.vertices, "The matte path at this key differs from what was written");
    });
  }
  if (exp.feather) expectThat(m, !!mask.feather && near(mask.feather[0], exp.feather[0], 1e-3) && near(mask.feather[1], exp.feather[1], 1e-3), "matte.mask.feather", exp.feather, mask.feather, "Matte feather differs");
  if (exp.expansion !== undefined) expectThat(m, mask.expansion !== null && near(mask.expansion, exp.expansion, 1e-3), "matte.mask.expansion", exp.expansion, mask.expansion, "Matte expansion differs");
  if (written.choke?.applied) {
    expectThat(m, matte.choke !== null && matte.choke !== undefined && near(matte.choke, written.choke.value, 1e-3), "matte.choke", written.choke.value, matte.choke, "Choke amount differs");
  }
  return m;
}

const toPair = (f: number | number[] | undefined): [number, number] | undefined => (f === undefined ? undefined : Array.isArray(f) ? [f[0], f[1]] : [f, f]);

async function garbageMatte(ctx: ToolContext, args: AeGarbageMatteArgs): Promise<Record<string, unknown>> {
  const toolName = "ae_garbage_matte";
  const opId = ctx.bridge.newOpId();
  const notes: string[] = [];

  const prep = await queued(ctx, `${toolName} plan(${args.comp_id})`, opId, async () => {
    const pre = await hostRead<GarbageRead>(ctx, opId, "pre", "mattesGarbageRead", { comp_id: args.comp_id, layers: args.targets, matte: args.matte_layer }, toolName);
    for (const l of pre.layers) {
      if (!l.found) throw new PlanarError("not_found", l.message ?? "A target layer was not found.");
    }
    if (args.matte_layer && !pre.matte) throw new PlanarError("not_found", "The matte layer was not found.");
    if (Number(pre.comp.pixel_aspect) > 0 && Math.abs(Number(pre.comp.pixel_aspect) - 1) > 1e-6 && args.track) {
      throw new PlanarError("refused", `The comp's pixel aspect is ${pre.comp.pixel_aspect}, not 1. Planar tracking works on square pixels only.`);
    }
    const out = {
      pre,
      times: [] as number[],
      shapes: [] as ShapeData[],
      staticShape: null as ShapeData | null,
      refTime: args.ref_time ?? 0,
      frames: 0,
      kept: 0,
      skipped: [] as number[],
      notOk: [] as number[],
      maxErrorPx: 0,
      trackId: null as string | null,
    };
    if (!args.region) return out;
    const shape = stripShape(regionToShape(args.region));
    if (!args.track) {
      out.staticShape = roundShape(shape);
      return out;
    }
    const got = await loadBased(ctx, opId, args.comp_id, { track: args.track, refTime: args.ref_time, range: args.range, decimatePx: args.decimate_px });
    if (pre.comp.width !== got.based.comp_size[0] || pre.comp.height !== got.based.comp_size[1]) {
      throw new PlanarError("refused", `The track was made in a ${got.based.comp_size[0]}x${got.based.comp_size[1]} comp and comp ${args.comp_id} is ${pre.comp.width}x${pre.comp.height}: the points are in comp pixels, so the sizes must match.`);
    }
    noteTrackOrigin(got.based, pre.comp, args.comp_id, notes);
    const matteHint = "A matte cannot be keyed in ranges (each call makes a new layer): make the matte static (no track), then key its mask with ae_mask_follow in ranges, or use a larger decimate_px.";
    const picked = framesToWrite(got.based, args.range, "key", matteHint);
    // The matte solid has an identity transform, so its layer space is comp space.
    const followed = followShapes({ shape, frames: picked.frames, refM: identityH(), frameMs: picked.frames.map(() => identityH()) });
    if (followed.frames.length === 0) throw new PlanarError("bad_args", "No frame could be converted into a matte path (every frame was degenerate).");
    const times = followed.frames.map((f) => f.time);
    const keep = decimateKeys(times, followed.frames.map((f) => shapeVector(f.shape)), args.decimate_px);
    const kept = pick(followed.frames, keep);
    const snapped = snapKeyTimes(kept.map((f) => f.time), pre.comp.fps || 25);
    const keptSnapped = snapped.idx.map((i) => kept[i]);
    checkWriteSize(keptSnapped.length, shape.vertices.length, "Use a larger decimate_px to drop more keys, or make the matte static and key its mask with ae_mask_follow in ranges.");
    out.times = snapped.times;
    out.shapes = keptSnapped.map((f) => roundShape(f.shape));
    out.refTime = got.refTime;
    out.frames = picked.frames.length;
    out.kept = keptSnapped.length;
    out.skipped = followed.skipped;
    out.notOk = picked.notOk;
    out.maxErrorPx = followed.maxErrorPx;
    out.trackId = got.based.track_id;
    if (followed.maxErrorPx > BEZIER_WARN_PX) {
      notes.push(`The perspective motion bends the matte's curves: up to ${r3(followed.maxErrorPx)} px from the true image. Use a polygon region (straight edges are exact) or an affine / similarity track.`);
    }
    if (followed.skipped.length + picked.notOk.length > 0) notes.push(`${followed.skipped.length + picked.notOk.length} frame(s) were not keyed; the keys interpolate across them.`);
    if (args.decimate_px > 0 && keptSnapped.length < followed.frames.length) notes.push(`${followed.frames.length - keptSnapped.length} of ${followed.frames.length} keys were dropped (linear interpolation reproduces them within ${args.decimate_px} px).`);
    return out;
  });

  const targetIds = prep.pre.layers.map((l) => l.id as number);
  const feather = toPair(args.feather);
  const idx = spreadIndexes(prep.times.length, 5);
  const created = args.region !== undefined;
  const exp: GarbageExpect = {
    matteType: args.matte_type,
    hide: args.hide_matte !== false,
    created,
    keys: !created ? null : prep.times.length > 0 ? prep.times.length : 0,
    vertexCount: prep.times.length > 0 ? prep.shapes[0].vertices.length : prep.staticShape ? prep.staticShape.vertices.length : 0,
    sampleTimes: prep.times.length > 0 ? idx.map((i) => prep.times[i]) : prep.staticShape ? [prep.refTime] : [],
    sampleVertices: prep.times.length > 0 ? idx.map((i) => prep.shapes[i].vertices) : prep.staticShape ? [prep.staticShape.vertices] : [],
    feather,
    expansion: args.expansion,
    name: args.name ?? (created ? `${prep.pre.layers[0].name} MATTE` : undefined),
  };
  const result = await runGuardedWrite<GarbageWritten>(ctx, {
    toolName,
    label: `${toolName}(${targetIds.length} layer${targetIds.length === 1 ? "" : "s"})`,
    expect: args.expect,
    compId: args.comp_id,
    read: (phase, written) => {
      const readArgs: Record<string, unknown> = { comp_id: args.comp_id, layer_ids: targetIds };
      if (phase === "before") {
        if (args.matte_layer) readArgs.matte = args.matte_layer;
      } else {
        const id = written?.matte?.id;
        if (id !== undefined) readArgs.matte_id = id;
        readArgs.times = exp.sampleTimes;
      }
      return { host: "mattesGarbageRead", args: readArgs };
    },
    write: {
      host: "mattesGarbageApply",
      args: {
        comp_id: args.comp_id,
        targets: prep.pre.layers.map((l) => ({ id: l.id })),
        matte_type: args.matte_type,
        matte_layer: args.matte_layer,
        name: args.name,
        closed: true,
        times: prep.times,
        shapes: prep.times.length > 0 ? prep.shapes : undefined,
        static_shape: prep.staticShape ?? undefined,
        ref_time: prep.refTime,
        feather,
        expansion: args.expansion,
        choke: args.choke,
        hide_matte: args.hide_matte,
        replace_existing_matte: args.replace_existing_matte,
        label: "Garbage matte",
      },
      timeoutMs: SLOW_TIMEOUT_MS,
    },
    check: (before, after, w) => garbageMismatches(exp, before, after, w),
  });

  const written = result as unknown as GarbageWritten;
  for (const t of written.targets ?? []) {
    if (t.error) notes.push(`AE refused the track matte on "${t.name}" (${t.error}); the other targets were wired. Undo the step or fix that layer and call again.`);
  }
  if (written.enabled_error) notes.push(`The matte layer's video switch could not be set (${written.enabled_error}); set it by hand.`);
  const choke = written.choke;
  if (choke && !choke.applied) {
    notes.push(`The Simple Choker was not applied: ${choke.error ?? "unknown reason"}. The matte itself is in place; add the choke by hand (Effect > Matte > Simple Choker).`);
  }
  if (args.hide_matte !== false) {
    notes.push("The matte layer's video is switched off, as AE's UI does. A layer-based track matte keeps working with it off (AE 23+); the read-back shows the matte on the targets.");
  }
  if (created) {
    notes.push("The matte is a comp-size white solid, so a solid item was added to the project (Solids folder), as in AE.");
  }
  if (created && args.matte_type !== "alpha" && args.matte_type !== "alpha_inverted") {
    notes.push("The matte is a white solid with a mask: luma types use its brightness (white inside the mask), so they match the alpha types here.");
  }
  if (args.matte_type === "alpha_inverted" || args.matte_type === "luma_inverted") {
    notes.push("Inverted: the region is cut out of the targets (a holdout area). A holdout for a moving person or hand needs a deforming roto, which this cannot make: pass your own roto layer as matte_layer.");
  }
  return {
    ok: true,
    ...result,
    ...(prep.trackId ? { track_id: prep.trackId } : {}),
    ...(prep.times.length > 0
      ? {
          frames: { solved: prep.frames, keyed: prep.kept, not_keyed: prep.skipped.length + prep.notOk.length },
          max_bezier_error_px: r3(prep.maxErrorPx),
        }
      : {}),
    notes,
  };
}

// ---------- ae_caf_prep ----------

interface FillCandidate {
  layer: { index: number; id: number; name: string };
  enabled: boolean;
  source: { id: number; name: string; folder: string; file?: string };
  in_point: number;
  out_point: number;
  in_fill_folder: boolean;
  name_matches: boolean;
  above_plate: boolean | null;
  matches_work_area: boolean;
}

interface FillRead {
  comp: CompBrief;
  plate: LayerBrief | null;
  fill_folders: string[];
  candidates: FillCandidate[];
  scanned: number;
  truncated: boolean;
}

/** The steps for the one thing only the user can do, in order. */
export function cafInstructions(a: { plateName: string; workArea: { start: number; end: number } | null; maskMode: string; compId: number; partialRange?: boolean }): string[] {
  const range = a.workArea ? ` (${r3(a.workArea.start)} s to ${r3(a.workArea.end)} s)` : "";
  return [
    `Select the layer "${a.plateName}" in the timeline: Content-Aware Fill works on the selected layer.`,
    "Open Window > Content-Aware Fill. Window-menu commands toggle, so check with ae_ui_screenshot that it is closed first, then call ae_open_panel with name 'Content-Aware Fill' and allow_toggle: true.",
    "Fill Method: Object for a moving object (moving camera included); Surface for a flat, static surface; Edge Blend for textureless areas.",
    "Lighting Correction: start at Strong; lower it when the texture flickers (grass, sand, water).",
    a.workArea
      ? a.partialRange
        ? `Range: Work Area${range}. This tool set the work area to this call's range only, which may be part of the hole's frames: set it to the whole fill range before generating.`
        : `Range: Work Area${range}. The work area was set to the fill range by this tool.`
      : "Range: Work Area, after you set the work area to the frames to fill (this tool did not change it): move the work area's ends in the timeline, or press B at the first frame and N at the last.",
    "Optional: make a reference frame (clean one frame with ae_inpaint_plate or in Photoshop and use 'Create Reference Frame' in the panel) for textured or changing backgrounds.",
    `Click Generate Fill Layer and wait; AE renders it into a new footage layer above the plate. ${a.maskMode === "subtract" ? "Until then the plate shows the hole the Subtract mask cuts." : "The mask only marks the object (mode none), so tell CAF the hole another way."}`,
    `Then call ae_caf_prep with find_fill: true (comp_id ${a.compId}) to find the generated layer, and ae_patch_check on it.`,
  ];
}

async function findFill(ctx: ToolContext, args: AeCafPrepArgs): Promise<Record<string, unknown>> {
  const toolName = "ae_caf_prep";
  const opId = ctx.bridge.newOpId();
  const got = await queued(ctx, `${toolName} find_fill(${args.comp_id})`, opId, () =>
    hostRead<FillRead>(ctx, opId, "findfill", "mattesFindFill", { comp_id: args.comp_id, plate: args.layer }, toolName)
  );
  const rank = (c: FillCandidate) => (c.in_fill_folder ? 4 : 0) + (c.above_plate ? 2 : 0) + (c.matches_work_area ? 1 : 0);
  const candidates = [...got.candidates].sort((x, y) => rank(y) - rank(x));
  const best = candidates.find((c) => c.in_fill_folder && c.above_plate !== false && c.matches_work_area) ?? null;
  const notes: string[] = [];
  const patchArgs: Record<string, unknown> = { comp_id: args.comp_id, patch_layers: best ? [{ id: best.layer.id }] : [] };
  if (args.patch_region) patchArgs.region = toPatchRegion(args.patch_region);
  if (args.patch_region_track) patchArgs.region_track = args.patch_region_track;
  if (args.expect) patchArgs.expect = args.expect;
  if (best) {
    if (args.patch_region) {
      notes.push(
        "patch_region is checked as given. The hole the plate's Subtract mask cut is that region grown by the mask's Expansion and Feather: if you used either, grow patch_region by it, or the band between them shows up as leakage and the ring falls inside the hole."
      );
    }
    notes.push(args.expect ? "The ready ae_patch_check call carries the `expect` you gave." : "The ready ae_patch_check call is missing `expect` (the project_path guard): add it before calling.");
    if (!args.patch_region) {
      notes.push(
        "The fill layer is a full-frame footage layer, so ae_patch_check's default footprint (the whole layer) would miss the hole: pass the hole as `region` (comp pixels), with `region_track` when the hole moves. Giving patch_region (and patch_region_track) to this find_fill call fills them in."
      );
    }
  }
  if (candidates.length === 0) {
    notes.push(
      "No footage layer looks like a Content-Aware Fill result. The fill may not be generated yet, or the layer and its folder are named differently on this AE: look at the Project panel for a footage item made by Generate Fill Layer."
    );
  } else {
    notes.push("The match is loose (names containing 'fill', the folder, the work area): the layer and folder naming of Content-Aware Fill are not verified on AE 26, so check the candidates by eye.");
  }
  if (got.truncated) notes.push("Only the first 500 layers were scanned.");
  return {
    ok: true,
    find_fill: true,
    comp: { id: got.comp.id, work_area_start: got.comp.work_area_start, work_area_duration: got.comp.work_area_duration },
    plate: got.plate,
    fill_folders: got.fill_folders,
    candidates,
    best,
    next: best
      ? {
          tool: "ae_patch_check",
          args: patchArgs,
          note: "Checks the seam, grain and colour of the fill against its surroundings." + (args.expect ? "" : " Add `expect` before calling."),
        }
      : null,
    notes,
  };
}

async function cafPrep(ctx: ToolContext, args: AeCafPrepArgs): Promise<Record<string, unknown>> {
  if (args.find_fill) return findFill(ctx, args);
  const expect = args.expect as ExpectGuard;
  const wantWorkArea = args.set_work_area !== false;
  let workArea: FollowInput["workArea"] = null;
  if (wantWorkArea) {
    if (args.work_area) workArea = args.work_area;
    else if (args.track) workArea = "track";
  }
  const input: FollowInput = {
    toolName: "ae_caf_prep",
    compId: args.comp_id,
    layer: args.layer,
    mask: args.mask,
    newMask: args.new_mask ? { region: args.new_mask.region, name: args.new_mask.name ?? "CAF hole" } : undefined,
    track: args.track,
    refTime: args.ref_time,
    range: args.range,
    decimatePx: args.decimate_px,
    replaceKeys: args.replace_keys === true,
    scaleFeather: false,
    props: { mode: args.mask_mode, expansion: args.expansion },
    workArea,
  };
  const plan = await planFollow(ctx, input);
  if (wantWorkArea && !plan.workArea) {
    plan.notes.push("The work area was not changed: give a track (the fill range is the frames it covers) or work_area.");
  }
  const { result } = await writeFollow(ctx, input, plan, expect, `ae_caf_prep(${plan.layer.name})`);
  writeOutcomeNotes(result, plan.notes);
  const partialRange = args.range !== undefined && !args.work_area && plan.workArea !== null && !result.work_area_error;
  if (partialRange) {
    plan.notes.push("range: the work area now covers this call's range only. When the hole spans more frames (other ranges), pass work_area for the whole fill range, or set it by hand before Content-Aware Fill.");
  }
  const wa = plan.workArea && !result.work_area_error ? { start: plan.workArea.start, end: plan.workArea.start + plan.workArea.duration } : null;
  const maskMode = args.mask_mode;
  if (plan.workArea) plan.notes.push("Changing the work area is an undoable comp change and is part of this write's receipt.");
  if (maskMode === "subtract") {
    plan.notes.push("The Subtract mask cuts a hole in the plate: it stays a hole until the fill layer exists. Use mask_mode 'none' if you would rather keep the plate whole and mark the object another way.");
  }
  if (args.expansion === undefined) {
    plan.notes.push("No expansion was set. A loose mask (several px past the object's edge, shadow included) fills better than a tight one: pass `expansion`.");
  }
  return {
    ok: true,
    ...result,
    ...followSummary(plan, result),
    mask_mode: maskMode,
    work_area: result.work_area_error ? undefined : (result.work_area as { start: number; duration: number } | undefined) ?? plan.workArea ?? undefined,
    instructions: cafInstructions({ plateName: plan.layer.name, workArea: wa, maskMode, compId: args.comp_id, partialRange }),
    open_panel: {
      tool: "ae_open_panel",
      args: { name: "Content-Aware Fill", allow_toggle: true },
      note: "Window-menu commands toggle: verify the panel is closed with ae_ui_screenshot first. This tool never opens it and never presses Generate Fill Layer.",
    },
    after_generate: { tool: "ae_caf_prep", args: { comp_id: args.comp_id, layer: args.layer, find_fill: true } },
    notes: plan.notes,
  };
}

// ---------- tools ----------

export const mattesTools: ToolDefinition<any>[] = [
  {
    name: "ae_mask_follow",
    description:
      "Make a mask ride a planar track (AE's own Track Mask cannot be scripted). Follows an existing mask (`mask`, as it looks at ref_time) or draws a new one from a `new_mask` region in comp pixels, and keys its path on every frame where the track is ok, in one undo group with a single setValuesAtTimes. " +
      "Every vertex and tangent end point is mapped by P(t) = M(t)^-1 . H(t) . M(ref) in the layer's own space (the layer's animated transform and its parents' included), so it is exact for translate / similarity / affine tracks and a close approximation for perspective (the result reports `max_bezier_error_px`; vertices are always exact). " +
      "Variable-feather points stay attached to their segments (their arrays are copied); `scale_feather` scales Mask Feather and the feather radii with the track's zoom. `decimate_px` (default 0.25) drops keys that linear interpolation reproduces within that error. " +
      "Also sets mode, inversion, expansion, feather, opacity and mask motion blur in the same step. Refuses an expression on the path, existing path keys (unless `replace_keys`), locked and 3D layers, and a mask whose vertex count would have to change. " +
      "Follows planar motion only, not deforming shapes like a hand or a person; a mask on a layer that already has a pin from the same track would double the motion (the tool warns). At most 2999 frames per call: do a longer track in several calls with `range` (keys outside the range stay; keys inside it need replace_keys; do the range holding ref_time first; a later call whose ref_time lies outside the already keyed stretch is refused, and then the keys written must be undone or removed to start again). " +
      "The read-back (a separate evalScript) checks the key count, the path at up to five keys, mode, expansion and feather. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeMaskFollowSchema,
    handler: async (args: AeMaskFollowArgs, ctx: ToolContext) => {
      try {
        return await maskFollow(ctx, args);
      } catch (err) {
        if (err instanceof PlanarError) return fail(err);
        throw err;
      }
    },
  },
  {
    name: "ae_garbage_matte",
    description:
      "Build a tracked matte and wire it up in one undo group: a comp-size white solid named '<target> MATTE' holding one mask from `region` (static, or following `track`), placed directly above the topmost target, set as the track matte (alpha, alpha_inverted, luma, luma_inverted; AE 23+ setTrackMatte, so one matte can feed several layers) of every layer in `targets`, with its video switched off. " +
      "Uses: a garbage matte around a keyed subject (alpha keeps the region), a holdout (alpha_inverted cuts the region out so a foreground object can pass in front of a patch), an area limit for a grade or grain adjustment layer. `feather`, `expansion` and `choke` (a Simple Choker on the matte) are set from arguments. " +
      "Or pass `matte_layer` to use an existing layer (your own roto, for a person or a hand a planar track cannot follow). Planar motion only. " +
      "Refuses locked layers, cameras and lights as targets, and targets that already have a track matte unless `replace_existing_matte`. A solid item is added to the project, as in AE. " +
      "The read-back (a separate evalScript) checks each target's matte type and layer, the matte's visibility and place, and its mask path. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeGarbageMatteSchema,
    handler: async (args: AeGarbageMatteArgs, ctx: ToolContext) => {
      try {
        return await garbageMatte(ctx, args);
      } catch (err) {
        if (err instanceof PlanarError) return fail(err);
        throw err;
      }
    },
  },
  {
    name: "ae_caf_prep",
    description:
      "Prepare Content-Aware Fill as far as a script can, then hand the one click to the user. On the plate `layer` it adds (new_mask region) or follows (mask) a hole mask that rides the track (the ae_mask_follow math), sets its mode to Subtract, applies `expansion`, and sets the comp's work area to the fill range (the frames the track covers inside `range`, or `work_area`) in one undo group. " +
      "It returns step-by-step `instructions` for the panel: select the layer, open Window > Content-Aware Fill (a ready `open_panel` call is included; this tool never opens it), fill method (Object / Surface / Edge Blend), lighting correction, Range: Work Area, an optional reference frame, then Generate Fill Layer. " +
      "After the user generated the fill, call again with `find_fill: true` (read only, nothing changes): it looks for the footage layer CAF created (a layer whose source is in a folder named like 'Fill', usually above the plate, in/out matching the work area), lists the candidates loosely because the naming is not verified on AE 26, and points to ae_patch_check. " +
      "The plate shows a hole until the fill exists (`mask_mode: none` avoids that). Pressing Generate Fill Layer and setting the panel's options cannot be scripted. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeCafPrepSchema,
    handler: async (args: AeCafPrepArgs, ctx: ToolContext) => {
      try {
        return await cafPrep(ctx, args);
      } catch (err) {
        if (err instanceof PlanarError) return fail(err);
        throw err;
      }
    },
  },
];
