/**
 * server/src/tools/ext/paths.ts
 *
 * Path tools for shape and mask paths:
 * - ae_path_read: a free path or mask path as vertices and tangents (the JSON
 *   ae_path_write takes back), with its keys, expression and direction, and
 *   optionally the operators in its shape group
 * - ae_path_write: write a path back as a value or a key, from JSON, or
 *   resampled by arc length, smoothed (Chaikin or Catmull-Rom), mirrored or
 *   reversed. The path maths is plain TypeScript below; AE only gets the result
 * - ae_path_operator: add Trim Paths (with an eased draw-on preset), Offset
 *   Paths or a Repeater (or a two-Repeater grid) to a shape group
 * - ae_path_link: link one path to another by expression, or unlink
 * - ae_path_connector: a shape layer whose path follows two layers
 *
 * Only free paths and masks have vertices; rectangle, ellipse and star shapes
 * are parametric and are refused. Each write is one undo group inside the host
 * function with its read-back in a separate evalScript.
 */

import { z } from "zod";
import { compareValues, type ReceiptMismatch } from "../../receipts.js";
import { AGENT_SAFETY_GUIDANCE, ExpectSchema, LayerSelectorSchema, type ToolContext, type ToolDefinition } from "../common.js";
import { expectThat, runGuardedWrite } from "./write-runner.js";

// ---------- path maths (pure) ----------

export type Pt = number[];

export interface PathData {
  vertices: Pt[];
  inTangents: Pt[];
  outTangents: Pt[];
  closed: boolean;
}

/** The most vertices a path read, written or produced here has. */
export const MAX_PATH_VERTICES = 500;

/** Subdivisions per Bezier segment when a path is flattened to measure it. */
const FLATTEN_STEPS = 24;

/** A path a request can't be done on; becomes a bad_args answer. */
export class PathMathError extends Error {}

const zero = (): Pt => [0, 0];

/** Fills missing tangents with straight-line zeros and the closed flag with true. */
export function toPathData(p: { vertices: Pt[]; inTangents?: Pt[]; outTangents?: Pt[]; closed?: boolean }): PathData {
  return {
    vertices: p.vertices.map((v) => [v[0], v[1]]),
    inTangents: p.inTangents ? p.inTangents.map((v) => [v[0], v[1]]) : p.vertices.map(zero),
    outTangents: p.outTangents ? p.outTangents.map((v) => [v[0], v[1]]) : p.vertices.map(zero),
    closed: p.closed !== false,
  };
}

const segmentCount = (p: PathData) => (p.closed ? p.vertices.length : p.vertices.length - 1);

/** The four control points of the segment leaving vertex i. */
function controlPoints(p: PathData, i: number): [Pt, Pt, Pt, Pt] {
  const n = p.vertices.length;
  const j = (i + 1) % n;
  const a = p.vertices[i];
  const b = p.vertices[j];
  return [a, [a[0] + p.outTangents[i][0], a[1] + p.outTangents[i][1]], [b[0] + p.inTangents[j][0], b[1] + p.inTangents[j][1]], b];
}

function bezierAt(c: [Pt, Pt, Pt, Pt], t: number): Pt {
  const u = 1 - t;
  const w0 = u * u * u;
  const w1 = 3 * u * u * t;
  const w2 = 3 * u * t * t;
  const w3 = t * t * t;
  return [w0 * c[0][0] + w1 * c[1][0] + w2 * c[2][0] + w3 * c[3][0], w0 * c[0][1] + w1 * c[1][1] + w2 * c[2][1] + w3 * c[3][1]];
}

export interface Flattened {
  points: Pt[];
  /** Cumulative length at each point; cum[0] is 0. */
  cum: number[];
  length: number;
}

/** The path as a polyline, with the length up to each point. */
export function flatten(p: PathData): Flattened {
  const points: Pt[] = [[p.vertices[0][0], p.vertices[0][1]]];
  const cum: number[] = [0];
  const segs = segmentCount(p);
  for (let i = 0; i < segs; i++) {
    const c = controlPoints(p, i);
    for (let s = 1; s <= FLATTEN_STEPS; s++) {
      const q = bezierAt(c, s / FLATTEN_STEPS);
      const last = points[points.length - 1];
      points.push(q);
      cum.push(cum[cum.length - 1] + Math.hypot(q[0] - last[0], q[1] - last[1]));
    }
  }
  return { points, cum, length: cum[cum.length - 1] };
}

/** The point at arc length d along a flattened path. */
function pointAtLength(f: Flattened, d: number): Pt {
  if (d <= 0) return [f.points[0][0], f.points[0][1]];
  if (d >= f.length) {
    const last = f.points[f.points.length - 1];
    return [last[0], last[1]];
  }
  let lo = 0;
  let hi = f.cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (f.cum[mid] <= d) lo = mid;
    else hi = mid;
  }
  const span = f.cum[hi] - f.cum[lo];
  const u = span > 0 ? (d - f.cum[lo]) / span : 0;
  return [f.points[lo][0] + (f.points[hi][0] - f.points[lo][0]) * u, f.points[lo][1] + (f.points[hi][1] - f.points[lo][1]) * u];
}

export const pathLength = (p: PathData): number => flatten(p).length;

const hasCurves = (p: PathData) => p.inTangents.some((t) => t[0] !== 0 || t[1] !== 0) || p.outTangents.some((t) => t[0] !== 0 || t[1] !== 0);

/**
 * Bezier handles that run a Catmull-Rom spline through the points: a third of
 * the slope between the neighbours, scaled by `tension` (1 is Catmull-Rom,
 * 0 is straight lines). The ends of an open path use the one-sided slope.
 */
export function catmullRomTangents(points: Pt[], closed: boolean, tension = 1): { inTangents: Pt[]; outTangents: Pt[] } {
  const n = points.length;
  const inTangents: Pt[] = [];
  const outTangents: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const prev = closed ? (i - 1 + n) % n : Math.max(i - 1, 0);
    const next = closed ? (i + 1) % n : Math.min(i + 1, n - 1);
    const divisor = prev === i || next === i ? 3 : 6;
    const tx = ((points[next][0] - points[prev][0]) * tension) / divisor;
    const ty = ((points[next][1] - points[prev][1]) * tension) / divisor;
    outTangents.push([tx, ty]);
    inTangents.push([-tx, -ty]);
  }
  return { inTangents, outTangents };
}

export interface ResampleOptions {
  /** Number of vertices to end up with. */
  count?: number;
  /** Distance between vertices; the count follows from the length. */
  spacing?: number;
  /** Fit a smooth curve through the new vertices when the source had curves. Default true. */
  keep_curves?: boolean;
}

/**
 * Evenly spaced vertices by arc length. Equal spacing doesn't keep corners:
 * a sharp corner between two samples is cut.
 */
export function resamplePath(p: PathData, opts: ResampleOptions): PathData {
  const f = flatten(p);
  if (!(f.length > 1e-9)) throw new PathMathError("The path has no length to resample.");
  let n: number;
  if (opts.count !== undefined) n = opts.count;
  else if (opts.spacing !== undefined) n = Math.round(f.length / opts.spacing) + (p.closed ? 0 : 1);
  else throw new PathMathError("Give count or spacing.");
  const min = p.closed ? 3 : 2;
  n = Math.max(min, n);
  if (n > MAX_PATH_VERTICES) throw new PathMathError(`That is ${n} vertices; a path has at most ${MAX_PATH_VERTICES}. Use a larger spacing or a smaller count.`);
  const vertices: Pt[] = [];
  for (let k = 0; k < n; k++) vertices.push(pointAtLength(f, p.closed ? (k * f.length) / n : (k * f.length) / (n - 1)));
  if (opts.keep_curves !== false && hasCurves(p)) {
    const t = catmullRomTangents(vertices, p.closed);
    return { vertices, ...t, closed: p.closed };
  }
  return { vertices, inTangents: vertices.map(zero), outTangents: vertices.map(zero), closed: p.closed };
}

export interface SmoothOptions {
  method: "chaikin" | "catmull_rom";
  /** Chaikin: rounds of corner cutting, 1..4. Default 1. */
  iterations?: number;
  /** Catmull-Rom: handle length, 0 (straight) to 2. Default 1. */
  tension?: number;
}

/**
 * chaikin: cuts the corners of the vertex polygon (tangents are dropped), which
 * doubles the vertex count each round; the ends of an open path stay put.
 * catmull_rom: keeps the vertices and sets the tangents to a Catmull-Rom spline.
 */
export function smoothPath(p: PathData, opts: SmoothOptions): PathData {
  if (opts.method === "catmull_rom") {
    const t = catmullRomTangents(p.vertices, p.closed, opts.tension ?? 1);
    return { vertices: p.vertices.map((v) => [v[0], v[1]]), ...t, closed: p.closed };
  }
  let pts: Pt[] = p.vertices.map((v) => [v[0], v[1]]);
  const rounds = opts.iterations ?? 1;
  for (let r = 0; r < rounds; r++) {
    const m = p.closed ? pts.length : pts.length - 1;
    const out: Pt[] = [];
    for (let i = 0; i < m; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const q: Pt = [0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]];
      const s: Pt = [0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]];
      if (p.closed) {
        out.push(q, s);
      } else {
        out.push(i === 0 ? [a[0], a[1]] : q, i === m - 1 ? [b[0], b[1]] : s);
      }
    }
    pts = out;
    if (pts.length > MAX_PATH_VERTICES) throw new PathMathError(`Chaikin with ${rounds} rounds gives more than ${MAX_PATH_VERTICES} vertices. Use fewer rounds.`);
  }
  return { vertices: pts, inTangents: pts.map(zero), outTangents: pts.map(zero), closed: p.closed };
}

/**
 * The same path walked the other way. A closed path keeps its first vertex as
 * the start; Trim Paths and the direction of a draw-on follow the vertex order.
 */
export function reversePath(p: PathData): PathData {
  const n = p.vertices.length;
  const order: number[] = [];
  if (p.closed) {
    order.push(0);
    for (let i = n - 1; i >= 1; i--) order.push(i);
  } else {
    for (let i = n - 1; i >= 0; i--) order.push(i);
  }
  return {
    vertices: order.map((i) => [p.vertices[i][0], p.vertices[i][1]]),
    // Walking backwards swaps which handle leads and which trails.
    inTangents: order.map((i) => [p.outTangents[i][0], p.outTangents[i][1]]),
    outTangents: order.map((i) => [p.inTangents[i][0], p.inTangents[i][1]]),
    closed: p.closed,
  };
}

export interface MirrorOptions {
  /** x flips left to right (across a vertical line); y flips top to bottom. */
  axis: "x" | "y";
  /** The line to flip across, in the path's own space. Default the middle of the path's bounds. */
  about?: number;
  /** Also walk the mirrored path the other way round, so it keeps the original winding. Default false. */
  reverse_direction?: boolean;
}

/** The path flipped across a vertical (axis x) or horizontal (axis y) line. */
export function mirrorPath(p: PathData, opts: MirrorOptions): PathData {
  const k = opts.axis === "x" ? 0 : 1;
  let c = opts.about;
  if (c === undefined) {
    const f = flatten(p);
    let lo = Infinity;
    let hi = -Infinity;
    for (const q of f.points) {
      lo = Math.min(lo, q[k]);
      hi = Math.max(hi, q[k]);
    }
    c = (lo + hi) / 2;
  }
  const flip = (v: Pt): Pt => (k === 0 ? [2 * (c as number) - v[0], v[1]] : [v[0], 2 * (c as number) - v[1]]);
  const flipT = (v: Pt): Pt => (k === 0 ? [-v[0], v[1]] : [v[0], -v[1]]);
  const out: PathData = {
    vertices: p.vertices.map(flip),
    inTangents: p.inTangents.map(flipT),
    outTangents: p.outTangents.map(flipT),
    closed: p.closed,
  };
  return opts.reverse_direction ? reversePath(out) : out;
}

/** A number that changes when any coordinate does; the host computes the same, to catch a path edited in between. */
export function pathChecksum(p: { vertices: Pt[]; inTangents: Pt[]; outTangents: Pt[] }): number {
  let sum = 0;
  for (const list of [p.vertices, p.inTangents, p.outTangents]) {
    list.forEach((v, i) => {
      sum += v[0] * (1 + (i % 7)) + v[1] * (2 + (i % 5));
    });
  }
  return Math.round(sum * 1000) / 1000;
}

// ---------- schemas ----------

const Vec2 = z.array(z.number().finite()).length(2);

export const PathDataSchema = z
  .object({
    vertices: z.array(Vec2).min(2).max(MAX_PATH_VERTICES).describe("The points [x, y]: in the layer's pixels for a mask, in the group's space for a shape path."),
    inTangents: z.array(Vec2).optional().describe("One [x, y] per vertex, relative to it, for the curve arriving there. Default straight lines."),
    outTangents: z.array(Vec2).optional().describe("One [x, y] per vertex, relative to it, for the curve leaving there. Default straight lines."),
    closed: z.boolean().optional().describe("Default true."),
  })
  .superRefine((p, ctx) => {
    const n = p.vertices.length;
    if (p.inTangents && p.inTangents.length !== n) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "inTangents needs one entry per vertex." });
    if (p.outTangents && p.outTangents.length !== n) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "outTangents needs one entry per vertex." });
  })
  .describe("A path in AE's Shape form (the same keys ae_path_read and ae_get_layer_full return).");

const IndexOrName = z
  .object({
    index: z.number().int().positive().optional().describe("1-based position."),
    name: z.string().min(1).optional().describe("Name; it must be the only one."),
  })
  .refine((v) => v.index !== undefined || v.name !== undefined, { message: "Give index or name." });

export const PathRefSchema = z
  .object({
    layer: LayerSelectorSchema,
    mask: IndexOrName.optional().describe("A mask on the layer (index in the layer's Masks group)."),
    shape: z
      .object({
        group: IndexOrName.optional().describe("A top-level group in the shape layer's Contents (its content index, as ae_shape numbers them). Omit when the layer has one group."),
        path: IndexOrName.optional().describe("A free path inside the group (its content index in the group). Omit when the group has one. Rectangles, ellipses and stars have no vertices."),
      })
      .optional()
      .describe("A free path ('ADBE Vector Shape - Group') in a shape layer."),
  })
  .refine((v) => (v.mask !== undefined) !== (v.shape !== undefined), { message: "Give exactly one of mask or shape." })
  .describe("One path: a mask on a layer, or a free path in a shape layer's group.");

export type PathRef = z.infer<typeof PathRefSchema>;

const TimeField = z.number().finite().optional();

export const AePathReadSchema = z.object({
  comp_id: z.number().int(),
  target: PathRefSchema,
  time: TimeField.describe("Comp time in seconds for a keyframed path. Default the comp's current time (read, not changed)."),
  include_operators: z.boolean().optional().describe("Shape paths: also list the group's contents with Trim Paths, Offset Paths and Repeater values and keys."),
});

const RESAMPLE = z
  .object({
    count: z.number().int().min(2).max(MAX_PATH_VERTICES).optional().describe("Vertices to end up with."),
    spacing: z.number().positive().optional().describe("Distance between vertices; the count follows from the path's length."),
    keep_curves: z.boolean().optional().describe("Fit a smooth curve through the new vertices when the path had curves. Default true; false gives straight segments."),
  })
  .refine((v) => (v.count !== undefined) !== (v.spacing !== undefined), { message: "Give exactly one of count or spacing." });

const SMOOTH = z.object({
  method: z.enum(["chaikin", "catmull_rom"]).describe("chaikin cuts corners of the vertex polygon and doubles the vertex count per round (tangents are dropped); catmull_rom keeps the vertices and sets the tangents."),
  iterations: z.number().int().min(1).max(4).optional().describe("chaikin: rounds, default 1."),
  tension: z.number().min(0).max(2).optional().describe("catmull_rom: handle length, 1 is a Catmull-Rom spline, 0 straight lines. Default 1."),
});

const MIRROR = z.object({
  axis: z.enum(["x", "y"]).describe("x flips left to right; y flips top to bottom."),
  about: z.number().finite().optional().describe("The line to flip across, in the path's own space. Default the middle of the path's bounds."),
  reverse_direction: z.boolean().optional().describe("Also reverse the vertex order so the mirror keeps the winding. Default false: the vertex order is kept, so a Trim Paths draw-on starts at the mirrored start point."),
});

const WRITE_OPS = ["set", "resample", "smooth", "mirror", "reverse"] as const;

export const AePathWriteSchema = z
  .object({
    comp_id: z.number().int(),
    target: PathRefSchema,
    operation: z.enum(WRITE_OPS).describe("set writes `path`; resample, smooth, mirror and reverse change the path as it is now."),
    path: PathDataSchema.optional().describe("operation 'set': the path to write."),
    resample: RESAMPLE.optional(),
    smooth: SMOOTH.optional(),
    mirror: MIRROR.optional(),
    time: TimeField.describe(
      "Write a key at this comp time instead of a value. Needed when the path already has keys; on a path without keys it adds the first key (add a second with another call to morph)."
    ),
    allow_vertex_count_change: z.boolean().optional().describe("Allow a key whose vertex count differs from the path's other keys. That breaks the morph between keys, so it is off by default."),
    allow_feather_loss: z.boolean().optional().describe("Allow a vertex count change on a mask with feather points; AE can't keep them on the right segments, so they are cleared."),
    dry_run: z.boolean().optional().describe("Compute the new path and return it without writing anything (no guard, checkpoint or undo entry)."),
    expect: ExpectSchema,
  })
  .superRefine((v, ctx) => {
    const need = (ok: boolean, message: string) => ok || ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    need((v.operation === "set") === (v.path !== undefined), "`path` goes with operation 'set', and only with it.");
    need((v.operation === "resample") === (v.resample !== undefined), "`resample` goes with operation 'resample', and only with it.");
    need((v.operation === "smooth") === (v.smooth !== undefined), "`smooth` goes with operation 'smooth', and only with it.");
    need((v.operation === "mirror") === (v.mirror !== undefined), "`mirror` goes with operation 'mirror', and only with it.");
  });

const DRAW_ON = z.object({
  start_time: z.number().min(0).finite().describe("Comp time the draw starts, in seconds."),
  duration: z.number().positive().finite().describe("Seconds the draw takes."),
  direction: z
    .enum(["forward", "reverse", "center"])
    .optional()
    .describe("forward grows from the path's first vertex (End 0 to 100); reverse grows back from the end (Start 100 to 0); center grows both ways from the middle. Default forward. The path's own direction decides where 'first' is (see ae_path_write reverse)."),
  ease: z.enum(["easy", "linear"]).optional().describe("easy: Easy Ease on both keys (speed 0, influence 33.3%). Default easy."),
});

const TRIM = z.object({
  start: z.number().min(0).max(100).optional().describe("Percent."),
  end: z.number().min(0).max(100).optional().describe("Percent."),
  offset: z.number().finite().optional().describe("Degrees."),
  type: z.enum(["simultaneously", "individually"]).optional().describe("Trim Multiple Shapes."),
  draw_on: DRAW_ON.optional().describe("Animate the trim from nothing to the whole path. Don't combine with start or end."),
});

const OFFSET = z.object({
  amount: z.number().finite().optional(),
  line_join: z.enum(["miter", "round", "bevel"]).optional(),
  miter_limit: z.number().min(1).max(100).optional(),
  copies: z.number().int().min(1).max(100).optional().describe("AE 17.1.1+."),
  copy_offset: z.number().finite().optional().describe("AE 17.1.1+."),
});

const REPEATER = z.object({
  copies: z.number().int().min(0).max(500).optional(),
  offset: z.number().finite().optional(),
  order: z.enum(["below", "above"]).optional().describe("Whether copies stack below or above the original."),
  position: Vec2.optional().describe("Offset between copies, [x, y]."),
  scale: Vec2.optional().describe("Percent, [x, y]."),
  rotation: z.number().finite().optional().describe("Degrees per copy."),
  anchor: Vec2.optional(),
  start_opacity: z.number().min(0).max(100).optional(),
  end_opacity: z.number().min(0).max(100).optional(),
  grid: z
    .object({
      columns: z.number().int().min(1).max(500),
      rows: z.number().int().min(1).max(500),
      spacing: Vec2.describe("[dx, dy] between cells."),
    })
    .optional()
    .describe("Build a grid with two Repeaters (copies along X, then that row along Y). Replaces copies and position."),
});

export const AePathOperatorSchema = z
  .object({
    comp_id: z.number().int(),
    layer: LayerSelectorSchema.describe("A shape layer."),
    group: IndexOrName.describe("The top-level group to add the operator to (content index or name). Operators act on the paths above them in the group; the new one goes last."),
    operator: z.enum(["trim", "offset", "repeater"]),
    trim: TRIM.optional(),
    offset: OFFSET.optional(),
    repeater: REPEATER.optional(),
    name: z.string().min(1).max(200).optional().describe("Operator name. A grid names its two Repeaters '<name> X' and '<name> Y'."),
    expect: ExpectSchema,
  })
  .superRefine((v, ctx) => {
    const need = (ok: boolean, message: string) => ok || ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    need(v.operator === "offset" || v.offset === undefined, "`offset` goes with operator 'offset'.");
    need(v.operator === "repeater" || v.repeater === undefined, "`repeater` goes with operator 'repeater'.");
    need(v.operator === "trim" || v.trim === undefined, "`trim` goes with operator 'trim'.");
    if (v.trim?.draw_on && (v.trim.start !== undefined || v.trim.end !== undefined)) need(false, "draw_on animates Start or End; don't also set trim.start or trim.end.");
    if (v.repeater?.grid && (v.repeater.copies !== undefined || v.repeater.position !== undefined)) need(false, "grid sets the copies and position itself.");
    if (v.repeater?.grid && v.repeater.grid.columns * v.repeater.grid.rows > 10000) need(false, "A grid of more than 10000 cells would freeze After Effects.");
  });

export const AePathLinkSchema = z
  .object({
    comp_id: z.number().int(),
    target: PathRefSchema.describe("The path that follows (it gets the expression)."),
    source: PathRefSchema.optional().describe("The path to follow. Same comp."),
    unlink: z.boolean().optional().describe("Remove the target's expression instead of adding one."),
    bake: z.boolean().optional().describe("With unlink: keep the path as it looks now as a plain value (not for keyframed paths)."),
    allow_feather_loss: z.boolean().optional().describe("With bake: allow baking a mask whose feather points belong to a path with another vertex count than the linked one; the feather points are dropped."),
    time_offset: z.number().finite().optional().describe("Follow the source this many seconds late (positive) or early (negative)."),
    expect: ExpectSchema,
  })
  .refine((v) => (v.unlink === true) === (v.source === undefined), { message: "Give `source` to link, or `unlink: true` (with no source) to remove the link." })
  .refine((v) => v.unlink === true || v.bake === undefined, { message: "bake goes with unlink." })
  .refine((v) => v.bake === true || v.allow_feather_loss === undefined, { message: "allow_feather_loss goes with bake." })
  .refine((v) => v.unlink !== true || v.time_offset === undefined, { message: "time_offset goes with linking." });

const Endpoint = z.object({
  layer: LayerSelectorSchema,
  point: Vec2.optional().describe("A point in that layer's own space. Default its anchor point."),
});

export const AePathConnectorSchema = z.object({
  comp_id: z.number().int(),
  from: Endpoint,
  to: Endpoint,
  name: z.string().min(1).max(200).optional().describe("Default 'Connector <from> - <to>'."),
  style: z.enum(["straight", "curve_h", "curve_v"]).optional().describe("straight line, or an S-curve with horizontal (curve_h) or vertical (curve_v) handles. Default straight."),
  curve: z.number().min(-5).max(5).optional().describe("Handle length as a share of the distance on the curve axis. Default 0.5."),
  color: z.array(z.number().min(0).max(1)).length(3).optional().describe("Stroke [r, g, b] in 0..1. Default white."),
  width: z.number().min(0).max(1000).optional().describe("Stroke width in pixels. Default 4."),
  behind: z.boolean().optional().describe("Put the connector directly below the lower of the two layers. Default true; false leaves it on top."),
  expect: ExpectSchema,
});

// ---------- read-back shapes ----------

export interface PathReadout {
  kind: string;
  layer: { index: number; id: number; name: string };
  mask?: { index: number; name: string };
  group?: { index: number; name: string };
  path_item?: { index: number; name: string };
  path: { closed: boolean; vertexCount: number; vertices: Pt[]; inTangents: Pt[]; outTangents: Pt[]; truncated: boolean };
  feather_points: number;
  numKeys: number;
  key_times: number[];
  time?: number;
  expression: { enabled: boolean; text: string; error: string };
  direction?: number;
}

interface OperatorItem {
  index: number;
  name: string;
  matchName: string;
  kind: string;
  [key: string]: unknown;
}

export interface OperatorsReadout {
  group: { index: number; name: string };
  count: number;
  items: OperatorItem[];
  truncated: boolean;
}

const asReadout = (v: unknown): PathReadout | null => (v && typeof v === "object" && (v as PathReadout).path ? (v as PathReadout) : null);

/** Per-coordinate tolerance when a written path is compared with what AE reports. */
const PATH_TOLERANCE = 0.01;

function comparePoints(expected: Pt[], actual: Pt[], path: string, m: ReceiptMismatch[]): void {
  for (let i = 0; i < expected.length; i++) {
    const a = actual[i];
    const e = expected[i];
    if (!a || Math.abs(a[0] - e[0]) > PATH_TOLERANCE || Math.abs(a[1] - e[1]) > PATH_TOLERANCE) {
      m.push({ path: `${path}[${i}]`, expected: e, actual: a, message: `${path} differs from what was written at vertex ${i + 1}` });
      return;
    }
  }
}

/** Checks that the path AE reports is the one that was written. */
export function pathWriteMismatches(expected: PathData, afterRaw: unknown, args: { time?: number }, written: Record<string, unknown>): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const after = asReadout(afterRaw);
  if (!after) return m;
  const p = after.path;
  expectThat(m, p.vertexCount === expected.vertices.length, "path.vertexCount", expected.vertices.length, p.vertexCount, "Vertex count differs from what was written");
  expectThat(m, p.closed === expected.closed, "path.closed", expected.closed, p.closed, "Closed flag differs from what was written");
  if (p.truncated) return m;
  if (p.vertexCount === expected.vertices.length) {
    comparePoints(expected.vertices, p.vertices, "path.vertices", m);
    comparePoints(expected.inTangents, p.inTangents, "path.inTangents", m);
    comparePoints(expected.outTangents, p.outTangents, "path.outTangents", m);
  }
  if (args.time !== undefined) {
    expectThat(m, after.numKeys >= 1, "numKeys", ">= 1", after.numKeys, "No key was written");
    if (written.replaced_key === true && written.ease_restored === false) {
      m.push({ path: "key.ease", expected: "interpolation and ease kept", actual: "not restored", message: "The key was replaced and its interpolation and ease could not be put back; check it with ae_get_layer_full" });
    }
  }
  expectThat(m, after.expression.enabled !== true, "expression.enabled", false, after.expression.enabled, "An expression is on the path and overrides the written value");
  return m;
}

function describeWrite(args: z.infer<typeof AePathWriteSchema>): string {
  return args.time === undefined ? args.operation : `${args.operation}@${args.time}s`;
}

/** Applies a non-`set` operation to a path read from AE. Throws PathMathError. */
export function applyPathOperation(args: z.infer<typeof AePathWriteSchema>, current: PathData): PathData {
  switch (args.operation) {
    case "set":
      return toPathData(args.path!);
    case "resample":
      return resamplePath(current, args.resample!);
    case "smooth":
      return smoothPath(current, args.smooth!);
    case "mirror":
      return mirrorPath(current, args.mirror!);
    case "reverse":
      return reversePath(current);
  }
}

// ---------- operator checks ----------

const LINE_JOIN: Record<string, number> = { miter: 1, round: 2, bevel: 3 };
const TRIM_TYPE: Record<string, number> = { simultaneously: 1, individually: 2 };
const REPEATER_ORDER: Record<string, number> = { below: 1, above: 2 };
/** Tolerance in seconds for key times (AE snaps them to frames). */
const KEY_TIME_TOLERANCE = 0.05;

type OperatorArgs = z.infer<typeof AePathOperatorSchema>;

interface WrittenOperator {
  index: number;
  name: string;
  matchName: string;
  role?: string;
}

/** The Transform child a Repeater read-back lists for a field. */
function repeaterChild(item: OperatorItem, field: string): unknown {
  const wanted: Record<string, string[]> = {
    anchor: ["anchor", "anchor point"],
    position: ["position"],
    scale: ["scale"],
    rotation: ["rotation"],
    start_opacity: ["start opacity", "opacity 1"],
    end_opacity: ["end opacity", "opacity 2"],
  };
  const list = (item.transform as Array<{ name: string; matchName: string; value: unknown }> | undefined) ?? [];
  const hit = list.find((c) => wanted[field].some((w) => c.name.toLowerCase() === w || c.matchName.toLowerCase().endsWith(w)));
  return hit?.value;
}

export function operatorMismatches(args: OperatorArgs, beforeRaw: unknown, afterRaw: unknown, written: Record<string, unknown>): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const before = beforeRaw as OperatorsReadout | null;
  const after = afterRaw as OperatorsReadout | null;
  if (!before || !after) return m;
  const added = (written.added as WrittenOperator[] | undefined) ?? [];
  expectThat(m, after.count === before.count + added.length, "count", before.count + added.length, after.count, "Group item count is not what the edit should leave");
  // Operators act on what is above them, so the last one added has to be last in the group.
  if (added.length > 0) {
    const lastAdded = added[added.length - 1];
    expectThat(m, lastAdded.index === after.count, "added.last.index", after.count, lastAdded.index, "The new operator is not last in the group, so it does not act on all the paths above it");
  }
  for (const a of added) {
    const item = after.items.find((i) => i.index === a.index);
    if (!item) {
      if (after.truncated) continue;
      m.push({ path: `items[${a.index}]`, expected: a.name, actual: undefined, message: `The new ${a.matchName} is not in the read-back` });
      continue;
    }
    expectThat(m, item.matchName === a.matchName, `items[${a.index}].matchName`, a.matchName, item.matchName, "The item at this index is not the new operator");
    if (args.name && args.operator !== "repeater") expectThat(m, item.name === args.name, `items[${a.index}].name`, args.name, item.name, "Operator name differs");
    const at = `items[${a.index}]`;
    if (args.operator === "trim") {
      const t = args.trim ?? {};
      if (t.start !== undefined) compareValues(t.start, item.start, `${at}.start`, m);
      if (t.end !== undefined) compareValues(t.end, item.end, `${at}.end`, m);
      if (t.offset !== undefined) compareValues(t.offset, item.offset, `${at}.offset`, m);
      if (t.type !== undefined) compareValues(TRIM_TYPE[t.type], item.trim_type, `${at}.trim_type`, m);
      if (t.draw_on) {
        const d = t.draw_on;
        const dir = d.direction ?? "forward";
        const t1 = d.start_time + d.duration;
        const animated = dir === "reverse" ? "start" : "end";
        const times = (item[`${animated}_key_times`] as number[] | undefined) ?? [];
        const values = (item[`${animated}_key_values`] as number[] | undefined) ?? [];
        const wantValues = dir === "reverse" ? [100, 0] : dir === "center" ? [50, 100] : [0, 100];
        expectThat(m, times.length === 2, `${at}.${animated}_key_times`, 2, times.length, "The draw-on needs two keys");
        if (times.length === 2) {
          expectThat(m, Math.abs(times[0] - d.start_time) <= KEY_TIME_TOLERANCE && Math.abs(times[1] - t1) <= KEY_TIME_TOLERANCE, `${at}.${animated}_key_times`, [d.start_time, t1], times, "Draw-on key times differ");
          compareValues(wantValues, values, `${at}.${animated}_key_values`, m);
        }
        if (dir === "center") {
          const sTimes = (item.start_key_times as number[] | undefined) ?? [];
          const sValues = (item.start_key_values as number[] | undefined) ?? [];
          expectThat(m, sTimes.length === 2, `${at}.start_key_times`, 2, sTimes.length, "The centre draw-on needs two Start keys as well");
          compareValues([50, 0], sValues, `${at}.start_key_values`, m);
        }
        if (dir === "reverse") compareValues(100, item.end, `${at}.end`, m);
        if (written.eased === false) {
          m.push({ path: `${at}.ease`, expected: "easy ease on both keys", actual: "linear/bezier default", message: "Easy Ease could not be applied to the draw-on keys; use ae_set_keyframe_ease" });
        }
      }
    } else if (args.operator === "offset") {
      const o = args.offset ?? {};
      if (o.amount !== undefined) compareValues(o.amount, item.amount, `${at}.amount`, m);
      if (o.line_join !== undefined) compareValues(LINE_JOIN[o.line_join], item.line_join, `${at}.line_join`, m);
      if (o.miter_limit !== undefined) compareValues(o.miter_limit, item.miter_limit, `${at}.miter_limit`, m);
      if (o.copies !== undefined) compareValues(o.copies, item.copies, `${at}.copies`, m);
      if (o.copy_offset !== undefined) compareValues(o.copy_offset, item.copy_offset, `${at}.copy_offset`, m);
    } else {
      const r = args.repeater ?? {};
      const grid = r.grid;
      const want: Record<string, unknown> = {};
      if (grid && a.role === "columns") {
        want.copies = grid.columns;
        want.position = [grid.spacing[0], 0];
      } else if (grid && a.role === "rows") {
        want.copies = grid.rows;
        want.position = [0, grid.spacing[1]];
      } else {
        want.copies = r.copies;
        want.position = r.position;
      }
      if (!grid || a.role === "columns") {
        want.offset = r.offset;
        want.scale = r.scale;
        want.rotation = r.rotation;
        want.anchor = r.anchor;
        want.start_opacity = r.start_opacity;
        want.end_opacity = r.end_opacity;
      }
      if (r.order !== undefined) compareValues(REPEATER_ORDER[r.order], item.order, `${at}.order`, m);
      if (want.copies !== undefined) compareValues(want.copies, item.copies, `${at}.copies`, m);
      if (want.offset !== undefined) compareValues(want.offset, item.offset, `${at}.offset`, m);
      for (const f of ["position", "scale", "rotation", "anchor", "start_opacity", "end_opacity"]) {
        if (want[f] === undefined) continue;
        const got = repeaterChild(item, f);
        if (got === undefined) {
          m.push({ path: `${at}.${f}`, expected: want[f], actual: undefined, message: `The Repeater's Transform group lists no ${f} in the read-back` });
        } else {
          compareValues(want[f], got, `${at}.${f}`, m);
        }
      }
    }
  }
  return m;
}

// ---------- link and connector checks ----------

interface LinkState {
  target: PathReadout | null;
  source: PathReadout | null;
}

type LinkArgs = z.infer<typeof AePathLinkSchema>;

export function linkMismatches(args: LinkArgs, beforeRaw: unknown, afterRaw: unknown, written: Record<string, unknown>): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const after = afterRaw as LinkState | null;
  const before = beforeRaw as LinkState | null;
  const target = after?.target;
  if (!target) return m;
  if (args.unlink) {
    expectThat(m, target.expression.enabled === false, "expression.enabled", false, target.expression.enabled, "The expression is still on");
    expectThat(m, target.expression.text === "", "expression.text", "", target.expression.text, "The expression text is still there");
    if (written.baked === true && before?.target) {
      expectThat(m, target.path.vertexCount === before.target.path.vertexCount, "path.vertexCount", before.target.path.vertexCount, target.path.vertexCount, "The baked path has another vertex count than the linked one");
      if (!target.path.truncated && target.path.vertexCount === before.target.path.vertexCount) comparePoints(before.target.path.vertices, target.path.vertices, "path.vertices", m);
    }
    return m;
  }
  expectThat(m, target.expression.enabled === true, "expression.enabled", true, target.expression.enabled, "The expression is not on");
  expectThat(m, target.expression.text === written.expression, "expression.text", written.expression, target.expression.text, "The expression text differs");
  expectThat(m, target.expression.error === "", "expression.error", "", target.expression.error, "After Effects reports an expression error");
  const source = after?.source;
  if (source && target.expression.error === "" && !args.time_offset && source.numKeys === 0 && source.expression.enabled !== true) {
    expectThat(m, target.path.vertexCount === source.path.vertexCount, "path.vertexCount", source.path.vertexCount, target.path.vertexCount, "The linked path has another vertex count than its source");
    expectThat(m, target.path.closed === source.path.closed, "path.closed", source.path.closed, target.path.closed, "The linked path is open or closed differently from its source");
  }
  return m;
}

interface ConnectorState {
  num_layers: number;
  from: { index: number; id: number; name: string } | null;
  to: { index: number; id: number; name: string } | null;
  connector: (PathReadout & { layer_position?: number[] | null }) | null;
}

type ConnectorArgs = z.infer<typeof AePathConnectorSchema>;

export function connectorMismatches(args: ConnectorArgs, beforeRaw: unknown, afterRaw: unknown, written: Record<string, unknown>): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const before = beforeRaw as ConnectorState | null;
  const after = afterRaw as ConnectorState | null;
  if (!before || !after) return m;
  expectThat(m, after.num_layers === before.num_layers + 1, "numLayers", before.num_layers + 1, after.num_layers, "Layer count did not grow by one");
  const c = after.connector;
  if (!c) {
    m.push({ path: "connector", expected: written.layer, actual: undefined, message: "The connector layer could not be read back" });
    return m;
  }
  expectThat(m, c.expression.enabled === true, "expression.enabled", true, c.expression.enabled, "The connector's path expression is not on");
  expectThat(m, c.expression.error === "", "expression.error", "", c.expression.error, "After Effects reports an expression error on the connector");
  expectThat(m, c.path.vertexCount === 2, "path.vertexCount", 2, c.path.vertexCount, "The connector path should have two vertices");
  expectThat(m, c.path.closed === false, "path.closed", false, c.path.closed, "The connector path should be open");
  const finite = c.path.vertices.every((v) => Number.isFinite(v[0]) && Number.isFinite(v[1]));
  expectThat(m, finite, "path.vertices", "finite", c.path.vertices, "The connector path has a non-finite point (the expression failed)");
  if (args.behind !== false && after.from && after.to) {
    const lowest = Math.max(after.from.index, after.to.index);
    expectThat(m, c.layer.index === lowest + 1, "layer.index", lowest + 1, c.layer.index, "The connector is not directly below the lower endpoint");
  }
  return m;
}

// ---------- tools ----------

type WriteArgs = z.infer<typeof AePathWriteSchema>;

const badArgs = (message: string) => ({ ok: false, error: "bad_args", message });

const readOpts = (toolName: string, label: string) => ({ label, mutates: false, toolName });

async function readPath(ctx: ToolContext, toolName: string, args: { comp_id: number; target: PathRef; time?: number }): Promise<PathReadout | null> {
  const res = await ctx.bridge.callHost<unknown>("pathsRead", { comp_id: args.comp_id, target: args.target, time: args.time }, readOpts(toolName, `${toolName}(${args.comp_id}) read`));
  return asReadout(res.result);
}

const toData = (r: PathReadout): PathData => ({ vertices: r.path.vertices, inTangents: r.path.inTangents, outTangents: r.path.outTangents, closed: r.path.closed });

export const pathsTools: ToolDefinition<any>[] = [
  {
    name: "ae_path_read",
    description:
      "Read one path as JSON: a mask path or a free path ('ADBE Vector Shape - Group') in a shape layer's top-level group, with vertices, inTangents, outTangents and closed (up to 500 vertices, `truncated` says if more), " +
      "its keyframe times, expression state, feather-point count (masks) and path direction (shapes). include_operators also lists the group's Trim Paths, Offset Paths and Repeater values and keys. " +
      "Rectangles, ellipses and stars have no vertices and are refused. " +
      "Read-only: never changes the time, selection or anything else in the project. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AePathReadSchema,
    handler: async (args: z.infer<typeof AePathReadSchema>, ctx) => {
      const path = await readPath(ctx, "ae_path_read", args);
      if (!args.include_operators || !args.target.shape || !path) return path;
      const ops = await ctx.bridge.callHost<unknown>(
        "pathsOperators",
        { comp_id: args.comp_id, layer: args.target.layer, group: args.target.shape.group ?? { index: path.group?.index } },
        readOpts("ae_path_read", `ae_path_read(${args.comp_id}) operators`)
      );
      return { ...path, operators: ops.result };
    },
  },
  {
    name: "ae_path_write",
    description:
      "Write a path back into a mask or a free shape path (a Shape round trip), as a value or, with `time`, as a key. operation 'set' writes the given vertices and tangents; " +
      "'resample' (even arc-length spacing, by count or spacing), 'smooth' (chaikin or catmull_rom), 'mirror' (across x or y) and 'reverse' compute the new path here from the path as it is now. " +
      "dry_run returns the computed path without writing. Refused before anything is written when: the path is keyframed and no `time` is given; an expression is on the path; a key would get another vertex count than the path's other keys (allow_vertex_count_change); " +
      "a mask with feather points would change vertex count (allow_feather_loss); the path changed since it was read. Replacing an existing key keeps its interpolation and ease where AE allows (the result says if it was restored). " +
      "In one undo group guarded by `expect`; the read-back (a separate evalScript) checks vertex count, closed flag, every vertex and tangent. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AePathWriteSchema,
    handler: async (args: WriteArgs, ctx) => {
      let current: PathReadout | null = null;
      let path: PathData;
      try {
        if (args.operation === "set") {
          path = toPathData(args.path!);
        } else {
          current = await readPath(ctx, "ae_path_write", args);
          if (!current) return badArgs("The path could not be read.");
          if (current.path.truncated) return badArgs(`The path has ${current.path.vertexCount} vertices; only paths of up to ${MAX_PATH_VERTICES} can be changed here.`);
          if (current.numKeys > 0 && args.time === undefined) return badArgs(`The path is keyframed (${current.numKeys} keys); give \`time\` to write a key at that time.`);
          if (current.expression.enabled) return badArgs("The path has an expression, which overrides any value written here; remove it first (ae_path_link with unlink).");
          path = applyPathOperation(args, toData(current));
        }
      } catch (err) {
        if (err instanceof PathMathError) return badArgs(err.message);
        throw err;
      }
      if (args.dry_run) {
        return { ok: true, dry_run: true, operation: args.operation, vertex_count: path.vertices.length, path, source: current?.path };
      }
      const base = current && { count: current.path.vertexCount, checksum: pathChecksum(current.path) };
      return runGuardedWrite(ctx, {
        toolName: "ae_path_write",
        label: `ae_path_write(${describeWrite(args)})`,
        expect: args.expect,
        compId: args.comp_id,
        read: () => ({ host: "pathsRead", args: { comp_id: args.comp_id, target: args.target, time: args.time } }),
        write: {
          host: "pathsApply",
          args: {
            comp_id: args.comp_id,
            target: args.target,
            path,
            time: args.time,
            base,
            allow_vertex_count_change: args.allow_vertex_count_change,
            allow_feather_loss: args.allow_feather_loss,
            operation: args.operation,
            label: `Path ${args.operation}`,
          },
        },
        check: (_before, after, w) => pathWriteMismatches(path, after, args, w),
        present: (_before, after, w) => ({ ...w, path: asReadout(after)?.path, numKeys: asReadout(after)?.numKeys }),
      });
    },
  },
  {
    name: "ae_path_operator",
    description:
      "Add a path operator to a top-level group of a shape layer: Trim Paths (static start/end/offset, or a draw-on preset that keys Start or End with Easy Ease), Offset Paths (amount, line join, miter limit; copies need AE 17.1.1+), " +
      "or a Repeater (copies, offset, order, transform; `grid` builds a columns x rows grid from two Repeaters). The operator goes last in the group so it acts on the paths above it. " +
      "Nothing is half-added: a step AE rejects takes the operator back out in the same undo group. In one undo group guarded by `expect`; the read-back (a separate evalScript) lists the group and checks each new operator's values and keys. " +
      "The Repeater Transform children have no documented match names; the result lists what the group really holds (`transform_children`). " +
      AGENT_SAFETY_GUIDANCE,
    schema: AePathOperatorSchema,
    handler: (args: OperatorArgs, ctx) =>
      runGuardedWrite(ctx, {
        toolName: "ae_path_operator",
        label: `ae_path_operator(${args.operator})`,
        expect: args.expect,
        compId: args.comp_id,
        read: () => ({ host: "pathsOperators", args: { comp_id: args.comp_id, layer: args.layer, group: args.group } }),
        write: {
          host: "pathsOperator",
          args: { comp_id: args.comp_id, layer: args.layer, group: args.group, operator: args.operator, trim: args.trim, offset: args.offset, repeater: args.repeater, name: args.name, label: `Add ${args.operator}` },
        },
        check: (before, after, w) => operatorMismatches(args, before, after, w),
        present: (_before, after, w) => ({ ...w, contents: (after as OperatorsReadout | null)?.items }),
      }),
  },
  {
    name: "ae_path_link",
    description:
      "Link a path to another path in the same comp by expression (the target follows the source, optionally late by `time_offset`), or remove that expression with unlink (bake keeps the current shape as a value). " +
      "Works between masks and free shape paths in any mix. Layers, groups, paths and masks are found by name in the expression, so duplicated names are refused. " +
      "In one undo group guarded by `expect`; the read-back (a separate evalScript) checks the expression is on and error-free and the vertex counts agree. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AePathLinkSchema,
    handler: (args: LinkArgs, ctx) =>
      runGuardedWrite(ctx, {
        toolName: "ae_path_link",
        label: `ae_path_link(${args.unlink ? "unlink" : "link"})`,
        expect: args.expect,
        compId: args.comp_id,
        read: () => ({ host: "pathsLinkState", args: { comp_id: args.comp_id, target: args.target, source: args.source } }),
        write: {
          host: "pathsLink",
          args: { comp_id: args.comp_id, target: args.target, source: args.source, unlink: args.unlink, bake: args.bake, allow_feather_loss: args.allow_feather_loss, time_offset: args.time_offset, label: args.unlink ? "Unlink path" : "Link path" },
        },
        check: (before, after, w) => linkMismatches(args, before, after, w),
        present: (_before, after, w) => ({ ...w, path: (after as LinkState | null)?.target?.path }),
      }),
  },
  {
    name: "ae_path_connector",
    description:
      "Draw a connector line between two layers: a new shape layer with a stroked two-point path whose points follow both layers by expression (each layer's anchor point or a given point, through toComp and fromComp, so parents and 3D layers are followed in 2D). " +
      "straight, or an S-curve with horizontal or vertical handles. Both layers need unique names (the expression finds them by name) and must not be cameras or lights. The connector goes directly below the lower endpoint unless behind is false. " +
      "In one undo group guarded by `expect`; a failed step removes the new layer again. The read-back (a separate evalScript) checks the layer count, the expression is on and error-free, the path has two points and the layer's place. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AePathConnectorSchema,
    handler: (args: ConnectorArgs, ctx) =>
      runGuardedWrite(ctx, {
        toolName: "ae_path_connector",
        label: "ae_path_connector",
        expect: args.expect,
        compId: args.comp_id,
        read: (phase, w) => {
          if (phase === "before") return { host: "pathsConnectorState", args: { comp_id: args.comp_id } };
          const id = (x: unknown) => (x as { id?: number } | undefined)?.id;
          return { host: "pathsConnectorState", args: { comp_id: args.comp_id, layer_id: id(w?.layer), from_id: id(w?.from), to_id: id(w?.to) } };
        },
        write: {
          host: "pathsConnector",
          args: { comp_id: args.comp_id, from: args.from, to: args.to, name: args.name, style: args.style, curve: args.curve, color: args.color, width: args.width, behind: args.behind, label: "Create connector" },
        },
        check: (before, after, w) => connectorMismatches(args, before, after, w),
        present: (_before, after, w) => ({ ...w, path: (after as ConnectorState | null)?.connector?.path }),
      }),
  },
];
