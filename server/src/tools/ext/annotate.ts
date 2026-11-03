/**
 * server/src/tools/ext/annotate.ts
 *
 * ae_annotate_frame (read only): a rendered frame with each layer's outline,
 * a number and name tag, an anchor cross and the safe areas drawn on it, an
 * index from number to layer, and optional zoom, pixel grid, rulers,
 * side-by-side A/B and per-region colour numbers.
 *
 * Everything is drawn here in Node. After Effects is asked for two things,
 * in separate evalScripts: the layers' transform values at the time
 * (annotateRead), then one saveFrameToPng render (snapshotFrame, with the
 * stale-frame guard). The box corners come from sourceRectAtTime and the
 * parent chain, projected through the camera for 3D layers. Nothing in the
 * comp is touched: not its time, resolution, selection or solo, because any
 * of those would land on the undo stack.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { PNG } from "pngjs";
import { z } from "zod";
import { BridgeError, SLOW_TIMEOUT_MS } from "../../host.js";
import { buildJsxCall } from "../../jsx.js";
import { QueueWaitError } from "../../queue.js";
import { AGENT_SAFETY_GUIDANCE, type ToolContext, type ToolDefinition } from "../common.js";
import { defaultFramesDir } from "../render.js";
import { captureCompFrame, decodePngFile } from "./frames.js";
import {
  blit,
  createCanvas,
  cropImage,
  drawCross,
  drawLabel,
  drawPolygon,
  encodePng,
  fillRect,
  flattenOnChecker,
  hasTransparency,
  regionStats,
  resizeArea,
  scaleNearest,
  strokeRect,
  textWidth,
  GLYPH_HEIGHT,
  type Rgba,
  type RegionStats,
} from "./png-utils.js";

const TOOL = "ae_annotate_frame";

// ---------- schema ----------

export const AeAnnotateFrameSchema = z.object({
  comp_id: z.number().int().describe("CompItem ID of the composition to render and annotate."),
  time: z.number().min(0).describe("Composition time in seconds. Clamped to the last frame."),
  time_b: z
    .number()
    .min(0)
    .optional()
    .describe(
      "A second time in seconds. Gives a pair: the frame at `time` (A) beside the frame at `time_b` (B), each with its own outlines. Needs two renders."
    ),
  layers: z
    .enum(["visible", "selected", "all"])
    .default("visible")
    .describe(
      "Which layers to outline and list: `visible` (enabled, in range at that time, honouring solo; cameras, lights, nulls and guide layers excluded because they draw no pixels), `selected` (the layers selected in the comp, which is only read), or `all`."
    ),
  layer_ids: z
    .array(z.number().int())
    .max(200)
    .optional()
    .describe("Only these layer ids, on top of `layers`. Take the ids from this tool's index or ae_get_comp."),
  outlines: z.boolean().default(true).describe("Draw each layer's outline (a rotated box, not just a rectangle). Default true."),
  tags: z.boolean().default(true).describe("Draw a `<number> <NAME>` tag by each outline. The number is the layer's index in the comp. Default true."),
  anchors: z.boolean().default(true).describe("Draw a cross at each layer's anchor point. Default true."),
  safe_areas: z.boolean().default(true).describe("Draw the action-safe and title-safe rectangles. Default true."),
  action_safe: z
    .number()
    .min(0)
    .max(0.5)
    .default(0.1)
    .describe("Action-safe margin as a share of width and height, both sides together. Default 0.1 (AE's 5% per side)."),
  title_safe: z
    .number()
    .min(0)
    .max(0.5)
    .default(0.2)
    .describe("Title-safe margin as a share of width and height, both sides together. Default 0.2 (AE's 10% per side)."),
  include_3d: z
    .boolean()
    .default(false)
    .describe(
      "EXPERIMENTAL and UNMEASURED. Draw boxes for 3D layers by projecting them through the active camera (or AE's default camera). The projection maths has not been checked against a render: X/Y rotation signs and the rotation order are guesses, so a box can be wrong. Default false: 3D layers are listed with `box: null` and a reason."
    ),
  include_extents: z
    .boolean()
    .default(false)
    .describe(
      "Pass `includeExtents` to sourceRectAtTime: shape layers then include stroke and path extents. Default false."
    ),
  zoom: z
    .object({
      x: z.number().describe("Left edge in comp pixels."),
      y: z.number().describe("Top edge in comp pixels."),
      width: z.number().positive().describe("Width in comp pixels."),
      height: z.number().positive().describe("Height in comp pixels."),
    })
    .optional()
    .describe(
      "A region of the comp (comp pixels) to crop from the full-size render and enlarge up to 8x with crisp pixels. Outlines, tags and the grid are drawn on the crop. Clipped to the comp."
    ),
  grid: z
    .number()
    .int()
    .min(1)
    .max(4000)
    .optional()
    .describe(
      "Draw grid lines every this many comp pixels. When lines would be closer than 6 output pixels, the spacing is raised to a multiple and `grid_spacing` says what was used."
    ),
  rulers: z
    .boolean()
    .default(true)
    .describe("With `grid`: label the grid lines with their comp-pixel coordinates along the top and left edges. Default true."),
  checkerboard: z
    .boolean()
    .default(true)
    .describe("Show transparent areas of the render as a checkerboard (only when the render has any). Default true."),
  stats: z
    .boolean()
    .default(true)
    .describe("Return the mean colour and luma per region of the view (a grid of `stats_cols` x `stats_rows` cells). Default true."),
  stats_cols: z.number().int().min(1).max(8).default(2).describe("Columns of the stats grid. Default 2 (quadrants)."),
  stats_rows: z.number().int().min(1).max(8).default(2).describe("Rows of the stats grid. Default 2 (quadrants)."),
  max_size: z
    .number()
    .int()
    .min(200)
    .max(4096)
    .default(1600)
    .describe("Longest edge of the output image in pixels. The frame is shrunk before drawing so the tags stay sharp. Default 1600."),
});

export type AeAnnotateFrameArgs = z.infer<typeof AeAnnotateFrameSchema>;

// ---------- host data ----------

export interface HostTransform {
  anchor: number[];
  position: number[];
  scale: number[];
  rotation_z: number;
  orientation: number[];
  rotation_x: number;
  rotation_y: number;
  point_of_interest: number[] | null;
}

export interface HostLayer {
  index: number;
  id: number;
  name: string;
  kind: string;
  enabled: boolean;
  solo: boolean;
  selected: boolean;
  three_d: boolean;
  parent_id: number | null;
  /** True when Auto-Orient is on for a layer that is not a camera or light. Absent in reads from older hosts. */
  auto_orient_active?: boolean;
  in_point: number;
  out_point: number;
  visible: boolean;
  /** Guide layers do not render. Absent in reads from older hosts. */
  guide?: boolean;
  active_at_time: boolean | null;
  rect: { left: number; top: number; width: number; height: number } | null;
  skip_reason: string | null;
  transform: HostTransform | null;
  camera?: { zoom: number | null; two_node: boolean };
}

export interface HostRead {
  comp: {
    id: number;
    name: string;
    width: number;
    height: number;
    pixel_aspect: number;
    fps: number;
    duration: number;
    resolution_factor: number[] | null;
  };
  time: number;
  layers: HostLayer[];
  total_layers: number;
  truncated: boolean;
  active_camera_id: number | null;
  comp_active_camera_id: number | null;
  solo_active: boolean;
}

// ---------- 4x4 maths (row-major, column vectors) ----------

export type Mat4 = number[];
export type Vec3 = [number, number, number];

// How AE's X and Y Rotation signs map to the right-hand rule in a y-down, z-away
// frame. Z matches the 2D code that is already measured (positive is clockwise
// on screen); X and Y are unmeasured, so a live check can flip them here.
const ROT_SIGN = { x: 1, y: 1, z: 1 };

export function mat4Identity(): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

export function mat4Mul(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16).fill(0);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[r * 4 + k] * b[k * 4 + c];
      out[r * 4 + c] = s;
    }
  }
  return out;
}

function translation(x: number, y: number, z: number): Mat4 {
  return [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1];
}

function scaling(x: number, y: number, z: number): Mat4 {
  return [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];
}

function rotationX(deg: number): Mat4 {
  const a = (ROT_SIGN.x * deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1];
}

function rotationY(deg: number): Mat4 {
  const a = (ROT_SIGN.y * deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1];
}

function rotationZ(deg: number): Mat4 {
  const a = (ROT_SIGN.z * deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

/** Inverse of a general 4x4 (Gauss-Jordan with pivoting), or null when singular. */
export function mat4Invert(m: Mat4): Mat4 | null {
  const a: number[][] = [];
  for (let r = 0; r < 4; r++) {
    a.push([m[r * 4], m[r * 4 + 1], m[r * 4 + 2], m[r * 4 + 3], r === 0 ? 1 : 0, r === 1 ? 1 : 0, r === 2 ? 1 : 0, r === 3 ? 1 : 0]);
  }
  for (let col = 0; col < 4; col++) {
    let pivot = col;
    for (let r = col + 1; r < 4; r++) {
      if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    }
    if (Math.abs(a[pivot][col]) < 1e-12) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const div = a[col][col];
    for (let c = 0; c < 8; c++) a[col][c] /= div;
    for (let r = 0; r < 4; r++) {
      if (r === col) continue;
      const f = a[r][col];
      if (f === 0) continue;
      for (let c = 0; c < 8; c++) a[r][c] -= f * a[col][c];
    }
  }
  const out: Mat4 = [];
  for (let r = 0; r < 4; r++) out.push(a[r][4], a[r][5], a[r][6], a[r][7]);
  return out;
}

export function transformPoint(m: Mat4, p: Vec3): Vec3 {
  return [
    m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
    m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
    m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
  ];
}

const num = (v: number[] | undefined, i: number, fill: number): number => {
  const x = v?.[i];
  return typeof x === "number" && Number.isFinite(x) ? x : fill;
};

/** Rotation of a 3D layer: orientation first, then X, Y and Z Rotation. */
function layerRotation(t: HostTransform): Mat4 {
  const ori = mat4Mul(rotationZ(num(t.orientation, 2, 0)), mat4Mul(rotationY(num(t.orientation, 1, 0)), rotationX(num(t.orientation, 0, 0))));
  return mat4Mul(rotationZ(t.rotation_z), mat4Mul(rotationY(t.rotation_y), mat4Mul(rotationX(t.rotation_x), ori)));
}

/**
 * A layer's own transform, layer space to parent space:
 * position * rotation * scale * (-anchor). A 2D layer ignores the z values and
 * the X/Y rotation and orientation.
 */
export function layerLocalMatrix(t: HostTransform, threeD: boolean): Mat4 {
  const ax = num(t.anchor, 0, 0);
  const ay = num(t.anchor, 1, 0);
  const az = threeD ? num(t.anchor, 2, 0) : 0;
  const px = num(t.position, 0, 0);
  const py = num(t.position, 1, 0);
  const pz = threeD ? num(t.position, 2, 0) : 0;
  const sx = num(t.scale, 0, 100) / 100;
  const sy = num(t.scale, 1, 100) / 100;
  const sz = threeD ? num(t.scale, 2, 100) / 100 : 1;
  const rot = threeD ? layerRotation(t) : rotationZ(t.rotation_z);
  return mat4Mul(translation(px, py, pz), mat4Mul(rot, mat4Mul(scaling(sx, sy, sz), translation(-ax, -ay, -az))));
}

const MAX_PARENT_DEPTH = 20;

export type LayerMap = Map<number, HostLayer>;

export function layerMap(layers: HostLayer[]): LayerMap {
  const map: LayerMap = new Map();
  for (const l of layers) map.set(l.id, l);
  return map;
}

export interface Chain {
  matrix: Mat4 | null;
  reason: string | null;
  /** True when a layer above this one in the parent chain is 3D. */
  has3dAncestor: boolean;
}

/**
 * The layer-space to comp(world)-space matrix through the whole parent chain.
 * Each layer in the chain contributes its own 2D or 3D transform.
 */
export function chainMatrix(layer: HostLayer, byId: LayerMap): Chain {
  const nodes: HostLayer[] = [];
  let cur: HostLayer | undefined = layer;
  let has3dAncestor = false;
  while (cur) {
    if (nodes.length >= MAX_PARENT_DEPTH) return { matrix: null, reason: "parent chain is deeper than 20 layers", has3dAncestor };
    if (!cur.transform) return { matrix: null, reason: `layer ${cur.index} has no transform group`, has3dAncestor };
    if (cur.auto_orient_active === true) {
      return { matrix: null, reason: `layer ${cur.index} has Auto-Orient on, which is not modelled`, has3dAncestor };
    }
    nodes.push(cur);
    if (cur !== layer && cur.three_d) has3dAncestor = true;
    if (cur.parent_id === null) break;
    cur = byId.get(cur.parent_id);
    if (!cur) return { matrix: null, reason: "a parent is not in the list read (the comp has more than 500 layers)", has3dAncestor };
  }
  let m = mat4Identity();
  for (let k = nodes.length - 1; k >= 0; k--) {
    m = mat4Mul(m, nodes[k].kind === "camera" ? cameraLocalMatrix(nodes[k]) : layerLocalMatrix(nodes[k].transform!, nodes[k].three_d));
  }
  return { matrix: m, reason: null, has3dAncestor };
}

// ---------- camera ----------

/** A camera layer's own transform: position * aim (two-node, at its point of interest) * rotation. */
function cameraLocalMatrix(cam: HostLayer): Mat4 {
  const t = cam.transform!;
  const pos: Vec3 = [num(t.position, 0, 0), num(t.position, 1, 0), num(t.position, 2, 0)];
  let aim = mat4Identity();
  if (cam.camera?.two_node && t.point_of_interest) {
    aim = lookAtRotation(pos, [num(t.point_of_interest, 0, 0), num(t.point_of_interest, 1, 0), num(t.point_of_interest, 2, 0)]);
  }
  return mat4Mul(translation(pos[0], pos[1], pos[2]), mat4Mul(aim, layerRotation(t)));
}

export interface CameraModel {
  /** World (comp) space to camera space. */
  view: Mat4;
  /** Focal length in comp pixels. */
  zoom: number;
  source: "layer" | "default";
  name?: string;
  note?: string;
}

/** AE's default comp camera: a 50 mm lens on a 36 mm film back, so zoom is 50/36 of the width. */
export function defaultCamera(width: number, height: number, note?: string): CameraModel {
  const zoom = (width * 50) / 36;
  const world = translation(width / 2, height / 2, -zoom);
  return { view: mat4Invert(world)!, zoom, source: "default", ...(note ? { note } : {}) };
}

function lookAtRotation(from: Vec3, to: Vec3): Mat4 {
  let f: Vec3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  const len = Math.hypot(f[0], f[1], f[2]);
  if (len < 1e-9) return mat4Identity();
  f = [f[0] / len, f[1] / len, f[2] / len];
  // "Down" is +y in comp space, so x = cross(down, forward) = (f2, 0, -f0) and y = cross(forward, x).
  let x: Vec3 = [f[2], 0, -f[0]];
  const xl = Math.hypot(x[0], x[1], x[2]);
  if (xl < 1e-9) x = [1, 0, 0];
  else x = [x[0] / xl, x[1] / xl, x[2] / xl];
  // y = cross(f, x)
  const y: Vec3 = [f[1] * x[2] - f[2] * x[1], f[2] * x[0] - f[0] * x[2], f[0] * x[1] - f[1] * x[0]];
  return [x[0], y[0], f[0], 0, x[1], y[1], f[1], 0, x[2], y[2], f[2], 0, 0, 0, 0, 1];
}

/**
 * The camera 3D layers are drawn through at the read's time: the front-most
 * enabled camera layer, else AE's default comp camera. A two-node camera
 * looks at its point of interest, with the rotation values applied on top.
 */
export function cameraModel(read: HostRead, byId: LayerMap): CameraModel {
  const { width, height } = read.comp;
  const cam = read.active_camera_id === null ? undefined : byId.get(read.active_camera_id);
  if (!cam) {
    if (read.active_camera_id !== null) {
      return defaultCamera(width, height, `the active camera (id ${read.active_camera_id}) is past the 500 layers read; the default camera was used`);
    }
    return defaultCamera(width, height);
  }
  const t = cam.transform;
  if (!t) return defaultCamera(width, height, `camera "${cam.name}" has no transform group; the default camera was used`);
  let parent: Chain;
  if (cam.parent_id === null) {
    parent = { matrix: mat4Identity(), reason: null, has3dAncestor: false };
  } else {
    const p = byId.get(cam.parent_id);
    parent = p ? chainMatrix(p, byId) : { matrix: null, reason: "its parent is not in the list read", has3dAncestor: false };
  }
  if (!parent.matrix) return defaultCamera(width, height, `camera "${cam.name}": ${parent.reason}; the default camera was used`);
  const local = cameraLocalMatrix(cam);
  const view = mat4Invert(mat4Mul(parent.matrix, local));
  if (!view) return defaultCamera(width, height, `camera "${cam.name}" has a singular transform; the default camera was used`);
  const zoomOk = typeof cam.camera?.zoom === "number" && cam.camera.zoom > 0;
  const zoom = zoomOk ? (cam.camera!.zoom as number) : (width * 50) / 36;
  return {
    view,
    zoom,
    source: "layer",
    name: cam.name,
    ...(zoomOk ? {} : { note: `camera "${cam.name}": zoom could not be read; AE's default zoom was used` }),
  };
}

function project(cam: CameraModel, comp: { width: number; height: number }, world: Vec3): [number, number] | null {
  const p = transformPoint(cam.view, world);
  if (p[2] <= 1e-6) return null;
  return [comp.width / 2 + (p[0] / p[2]) * cam.zoom, comp.height / 2 + (p[1] / p[2]) * cam.zoom];
}

// ---------- boxes ----------

export interface LayerBox {
  /** Corners in comp pixels, clockwise from the top-left of the layer's content rect. */
  quad: Array<[number, number]>;
  /** [left, top, right, bottom] of the quad. */
  bbox: [number, number, number, number];
  anchor: [number, number] | null;
  projection: "2d" | "3d-estimated";
}

export const NO_3D_REASON = "3D: needs a live check of the projection";

const r2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * The outline of a layer's content at the read's time. Null (with the reason)
 * for layers with no picture, 3D layers whose corners fall behind the camera,
 * and 2D layers under a 3D parent, which is not modelled.
 */
export function layerBox(
  layer: HostLayer,
  byId: LayerMap,
  cam: CameraModel,
  comp: { width: number; height: number },
  include3d = false
): { box: LayerBox | null; reason: string | null } {
  if (layer.skip_reason) return { box: null, reason: layer.skip_reason };
  if (!layer.rect) return { box: null, reason: "no content rect" };
  if (layer.three_d && !include3d) return { box: null, reason: NO_3D_REASON };
  const chain = chainMatrix(layer, byId);
  if (!chain.matrix) return { box: null, reason: chain.reason };
  if (!layer.three_d && chain.has3dAncestor) {
    return { box: null, reason: "2D layer parented to a 3D layer: its box is not modelled" };
  }
  const { left, top, width, height } = layer.rect;
  const corners: Vec3[] = [
    [left, top, 0],
    [left + width, top, 0],
    [left + width, top + height, 0],
    [left, top + height, 0],
  ];
  const quad: Array<[number, number]> = [];
  for (const c of corners) {
    const w = transformPoint(chain.matrix, c);
    if (layer.three_d) {
      const s = project(cam, comp, w);
      if (!s) return { box: null, reason: "3D layer crosses or lies behind the camera plane" };
      quad.push([s[0], s[1]]);
    } else {
      quad.push([w[0], w[1]]);
    }
  }
  const a = layer.transform!.anchor;
  const aw = transformPoint(chain.matrix, [num(a, 0, 0), num(a, 1, 0), layer.three_d ? num(a, 2, 0) : 0]);
  let anchor: [number, number] | null;
  if (layer.three_d) anchor = project(cam, comp, aw);
  else anchor = [aw[0], aw[1]];
  const xs = quad.map((q) => q[0]);
  const ys = quad.map((q) => q[1]);
  return {
    box: {
      quad: quad.map((q) => [r2(q[0]), r2(q[1])] as [number, number]),
      bbox: [r2(Math.min(...xs)), r2(Math.min(...ys)), r2(Math.max(...xs)), r2(Math.max(...ys))],
      anchor: anchor ? [r2(anchor[0]), r2(anchor[1])] : null,
      projection: layer.three_d ? "3d-estimated" : "2d",
    },
    reason: null,
  };
}

// ---------- layer selection and the index ----------

export function chooseLayers(layers: HostLayer[], mode: "visible" | "selected" | "all", ids?: number[]): HostLayer[] {
  let out = layers;
  if (mode === "visible") out = layers.filter((l) => l.visible && l.guide !== true && l.kind !== "camera" && l.kind !== "light" && l.kind !== "null");
  else if (mode === "selected") out = layers.filter((l) => l.selected);
  if (ids && ids.length > 0) {
    const want = new Set(ids);
    out = out.filter((l) => want.has(l.id));
  }
  return out;
}

export interface MissingLayerId {
  id: number;
  reason: "filtered_out_by_layers" | "not_in_comp" | "not_read_layer_cap_or_not_in_comp";
}

/** The requested layer_ids that did not end up in the index, each with why. */
export function missingLayerIds(read: HostRead, picked: HostLayer[], mode: string, ids?: number[]): MissingLayerId[] {
  if (!ids || ids.length === 0) return [];
  const got = new Set(picked.map((l) => l.id));
  const known = new Set(read.layers.map((l) => l.id));
  const out: MissingLayerId[] = [];
  for (const id of new Set(ids)) {
    if (got.has(id)) continue;
    if (known.has(id)) out.push({ id, reason: "filtered_out_by_layers" });
    else if (read.truncated) out.push({ id, reason: "not_read_layer_cap_or_not_in_comp" });
    else out.push({ id, reason: "not_in_comp" });
  }
  return out;
}

export interface IndexEntry {
  n: number;
  id: number;
  name: string;
  kind: string;
  visible: boolean;
  selected: boolean;
  three_d: boolean;
  parent: number | null;
  box: LayerBox | null;
  reason: string | null;
  /** True when the box is entirely outside the comp frame. */
  offscreen: boolean;
  /** False when the box is null or entirely outside the view. */
  drawn: boolean;
  color: string;
}

export const LAYER_COLORS: Rgba[] = [
  [255, 64, 64, 255],
  [255, 176, 0, 255],
  [64, 224, 64, 255],
  [0, 200, 255, 255],
  [170, 110, 255, 255],
  [255, 80, 200, 255],
  [255, 255, 64, 255],
  [255, 128, 64, 255],
];

export const colorFor = (index: number): Rgba => LAYER_COLORS[Math.abs(index) % LAYER_COLORS.length];
const hex = (c: Rgba): string => "#" + c.slice(0, 3).map((v) => v.toString(16).padStart(2, "0")).join("");

/** Builds the index of picked layers, with each one's outline. */
export function buildIndex(read: HostRead, picked: HostLayer[], include3d = false): IndexEntry[] {
  const byId = layerMap(read.layers);
  const cam = cameraModel(read, byId);
  const comp = read.comp;
  return picked
    .map((l) => {
      const { box, reason } = layerBox(l, byId, cam, comp, include3d);
      const parent = l.parent_id === null ? null : (byId.get(l.parent_id)?.index ?? null);
      const offscreen = box ? box.bbox[2] <= 0 || box.bbox[3] <= 0 || box.bbox[0] >= comp.width || box.bbox[1] >= comp.height : false;
      return {
        n: l.index,
        id: l.id,
        name: l.name,
        kind: l.kind,
        visible: l.visible,
        selected: l.selected,
        three_d: l.three_d,
        parent,
        box,
        reason,
        offscreen,
        drawn: false,
        color: hex(colorFor(l.index)),
      };
    })
    .sort((a, b) => a.n - b.n);
}

// ---------- view: which part of the render, at what size ----------

export interface View {
  /** The region shown, in comp pixels. */
  region: { x0: number; y0: number; x1: number; y1: number };
  /** Output pixels per rendered-image pixel. */
  k: number;
  /** Rendered-image pixels per comp pixel (differs from 1 under a lower resolution setting). */
  isx: number;
  isy: number;
  cropX: number;
  cropY: number;
  cropW: number;
  cropH: number;
  outW: number;
  outH: number;
}

const MAX_ZOOM = 8;

/** Throws when the zoom region has no pixels inside the comp. Cheap, so it runs before any render. */
export function checkZoom(
  comp: { width: number; height: number },
  zoom: { x: number; y: number; width: number; height: number }
): void {
  const x0 = Math.max(0, Math.floor(zoom.x));
  const y0 = Math.max(0, Math.floor(zoom.y));
  const x1 = Math.min(comp.width, Math.ceil(zoom.x + zoom.width));
  const y1 = Math.min(comp.height, Math.ceil(zoom.y + zoom.height));
  if (x1 - x0 < 1 || y1 - y0 < 1) {
    throw new Error(`The zoom region lies outside the ${comp.width}x${comp.height} comp.`);
  }
}

/**
 * Maps comp pixels to the output. The render's size may not equal the comp's
 * (resolution setting, pixel aspect), so the scale between them comes from
 * the decoded image, not from an assumption.
 */
export function makeView(
  comp: { width: number; height: number },
  img: { width: number; height: number },
  zoom: { x: number; y: number; width: number; height: number } | undefined,
  budget: number
): View {
  const isx = img.width / comp.width;
  const isy = img.height / comp.height;
  if (zoom) checkZoom(comp, zoom);
  let x0 = 0;
  let y0 = 0;
  let x1 = comp.width;
  let y1 = comp.height;
  if (zoom) {
    x0 = Math.max(0, Math.floor(zoom.x));
    y0 = Math.max(0, Math.floor(zoom.y));
    x1 = Math.min(comp.width, Math.ceil(zoom.x + zoom.width));
    y1 = Math.min(comp.height, Math.ceil(zoom.y + zoom.height));
    if (x1 - x0 < 1 || y1 - y0 < 1) {
      throw new Error(`The zoom region lies outside the ${comp.width}x${comp.height} comp.`);
    }
  }
  const cropX = Math.min(img.width - 1, Math.round(x0 * isx));
  const cropY = Math.min(img.height - 1, Math.round(y0 * isy));
  const cropW = Math.max(1, Math.min(img.width - cropX, Math.round((x1 - x0) * isx)));
  const cropH = Math.max(1, Math.min(img.height - cropY, Math.round((y1 - y0) * isy)));
  const fit = budget / Math.max(cropW, cropH);
  const k = zoom ? Math.min(MAX_ZOOM, fit) : Math.min(1, fit);
  return {
    region: { x0, y0, x1, y1 },
    k,
    isx,
    isy,
    cropX,
    cropY,
    cropW,
    cropH,
    outW: Math.max(1, Math.round(cropW * k)),
    outH: Math.max(1, Math.round(cropH * k)),
  };
}

export function toOutput(view: View, x: number, y: number): [number, number] {
  return [(x * view.isx - view.cropX) * view.k, (y * view.isy - view.cropY) * view.k];
}

// ---------- drawing ----------

export interface DrawOptions {
  outlines: boolean;
  tags: boolean;
  anchors: boolean;
  safeAreas: boolean;
  actionSafe: number;
  titleSafe: number;
  grid?: number;
  rulers: boolean;
  checkerboard: boolean;
}

const WHITE: Rgba = [255, 255, 255, 255];
const INK: Rgba = [16, 16, 16, 255];
const SHADE: Rgba = [0, 0, 0, 170];
const MAX_TAG_NAME = 20;

function textScaleFor(view: View): number {
  return Math.max(1, Math.min(3, Math.round(Math.max(view.outW, view.outH) / 700)));
}

/** The base image for a view: the crop from the render, resized and, where it has alpha, on a checkerboard. */
export function renderBase(img: PNG, view: View, checkerboard: boolean): PNG {
  const crop = cropImage(img, view.cropX, view.cropY, view.cropW, view.cropH);
  let base: PNG;
  if (view.outW < crop.width || view.outH < crop.height) base = resizeArea(crop, view.outW, view.outH);
  else if (view.outW > crop.width || view.outH > crop.height) base = scaleNearest(crop, view.outW, view.outH);
  else base = crop;
  return checkerboard && hasTransparency(base) ? flattenOnChecker(base, 8) : base;
}

/** Grid spacing in comp pixels that keeps lines at least 6 output pixels apart. */
export function effectiveGridSpacing(requested: number, view: View): number {
  const px = requested * view.isx * view.k;
  if (px >= 6) return requested;
  return requested * Math.ceil(6 / Math.max(px, 1e-6));
}

function drawGrid(dst: PNG, view: View, spacing: number, rulers: boolean, scale: number): void {
  const { x0, y0, x1, y1 } = view.region;
  const line: Rgba = [255, 255, 255, 80];
  const strong: Rgba = [255, 255, 255, 130];
  const labelGap = 4;
  let nextLabelX = 0;
  let nextLabelY = 0;
  for (let gx = Math.ceil(x0 / spacing) * spacing; gx <= x1; gx += spacing) {
    const ox = Math.round(toOutput(view, gx, 0)[0]);
    const label = rulers && ox >= nextLabelX;
    fillRect(dst, ox, 0, 1, dst.height, label ? strong : line);
    if (label) {
      const text = String(gx);
      const box = drawLabel(dst, text, ox + 2, 2, scale, WHITE, SHADE, 2);
      nextLabelX = box.x + box.w + labelGap;
    }
  }
  for (let gy = Math.ceil(y0 / spacing) * spacing; gy <= y1; gy += spacing) {
    const oy = Math.round(toOutput(view, 0, gy)[1]);
    const label = rulers && oy >= nextLabelY;
    fillRect(dst, 0, oy, dst.width, 1, label ? strong : line);
    if (label) {
      const text = String(gy);
      const box = drawLabel(dst, text, 2, oy + 2, scale, WHITE, SHADE, 2);
      nextLabelY = box.y + box.h + labelGap;
    }
  }
}

function drawSafeArea(dst: PNG, view: View, comp: { width: number; height: number }, margin: number, color: Rgba, name: string, scale: number): void {
  const mx = (comp.width * margin) / 2;
  const my = (comp.height * margin) / 2;
  const [ax, ay] = toOutput(view, mx, my);
  const [bx, by] = toOutput(view, comp.width - mx, comp.height - my);
  strokeRect(dst, Math.round(ax), Math.round(ay), Math.round(bx - ax), Math.round(by - ay), 1, color);
  drawLabel(dst, name, Math.round(ax) + 2, Math.round(ay) + 2, scale, INK, color, 1);
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Tag text: the layer number and its name in capitals, cut to 20 characters. */
export function tagText(n: number, name: string): string {
  const clean = name.toUpperCase().replace(/[^A-Z0-9 _.:/#-]/g, "?");
  return `${n} ${clean.length > MAX_TAG_NAME ? clean.slice(0, MAX_TAG_NAME - 1) + "." : clean}`;
}

/**
 * Draws the safe areas, grid and picked layers onto `base`, and marks `drawn`
 * on each index entry whose box falls in the view.
 */
export function drawAnnotations(
  base: PNG,
  view: View,
  comp: { width: number; height: number },
  index: IndexEntry[],
  opts: DrawOptions
): void {
  const scale = textScaleFor(view);
  const thick = Math.max(1, Math.round(Math.max(view.outW, view.outH) / 800));

  if (opts.safeAreas) {
    drawSafeArea(base, view, comp, opts.actionSafe, [64, 224, 64, 255], "ACTION", scale);
    drawSafeArea(base, view, comp, opts.titleSafe, [0, 200, 255, 255], "TITLE", scale);
  }
  if (opts.grid !== undefined) {
    drawGrid(base, view, effectiveGridSpacing(opts.grid, view), opts.rulers, scale);
  }

  const { x0, y0, x1, y1 } = view.region;
  const placed: Rect[] = [];
  for (const e of index) {
    if (!e.box) continue;
    const [bx0, by0, bx1, by1] = e.box.bbox;
    if (bx1 <= x0 || by1 <= y0 || bx0 >= x1 || by0 >= y1) continue;
    e.drawn = true;
    const color = colorFor(e.n);
    const pts = e.box.quad.map((q) => toOutput(view, q[0], q[1]));
    if (opts.outlines) drawPolygon(base, pts, thick, color);
    if (opts.anchors && e.box.anchor) {
      const [ax, ay] = toOutput(view, e.box.anchor[0], e.box.anchor[1]);
      drawCross(base, ax, ay, 6 * scale, thick + 2, INK);
      drawCross(base, ax, ay, 6 * scale, thick, color);
    }
    if (opts.tags) {
      const text = tagText(e.n, e.name);
      const [ox0, oy0] = toOutput(view, bx0, by0);
      const w = textWidth(text, scale) + 4;
      const h = GLYPH_HEIGHT * scale + 4;
      let rect: Rect = {
        x: Math.round(Math.min(Math.max(0, ox0), Math.max(0, base.width - w))),
        y: Math.round(oy0 - h >= 0 ? oy0 - h : Math.max(0, oy0)),
        w,
        h,
      };
      // Step down past tags already placed there, a few times at most.
      for (let tries = 0; tries < 12 && placed.some((p) => overlaps(rect, p)); tries++) {
        rect = { ...rect, y: rect.y + h + 1 };
      }
      if (rect.y + rect.h > base.height) rect = { ...rect, y: Math.max(0, base.height - rect.h) };
      drawLabel(base, text, rect.x, rect.y, scale, INK, color, 2);
      placed.push(rect);
    }
  }
}

// ---------- region stats ----------

export interface CellStats extends RegionStats {
  col: number;
  row: number;
  /** The cell in comp pixels: [left, top, right, bottom]. */
  rect: [number, number, number, number];
}

/** Mean colour and luma per cell of a cols x rows grid over the view, from the render itself (before any drawing). */
export function gridStats(img: PNG, view: View, cols: number, rows: number): CellStats[] {
  const out: CellStats[] = [];
  const { x0, y0, x1, y1 } = view.region;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const px0 = view.cropX + Math.floor((c * view.cropW) / cols);
      const px1 = view.cropX + Math.floor(((c + 1) * view.cropW) / cols);
      const py0 = view.cropY + Math.floor((r * view.cropH) / rows);
      const py1 = view.cropY + Math.floor(((r + 1) * view.cropH) / rows);
      const s = regionStats(img, px0, py0, Math.max(px1, px0 + 1), Math.max(py1, py0 + 1));
      out.push({
        col: c,
        row: r,
        rect: [
          r2(x0 + ((x1 - x0) * c) / cols),
          r2(y0 + ((y1 - y0) * r) / rows),
          r2(x0 + ((x1 - x0) * (c + 1)) / cols),
          r2(y0 + ((y1 - y0) * (r + 1)) / rows),
        ],
        ...s,
      });
    }
  }
  return out;
}

// ---------- pair layout ----------

const PAIR_GAP = 8;

/** Two annotated images side by side under a header band that names them. */
export function composePair(a: PNG, b: PNG, labelA: string, labelB: string): PNG {
  const scale = Math.max(1, Math.min(3, Math.round(Math.max(a.width, b.width) / 700)));
  const header = GLYPH_HEIGHT * scale + 8;
  const w = Math.max(a.width, b.width);
  const h = Math.max(a.height, b.height);
  const out = createCanvas(w * 2 + PAIR_GAP, h + header, [24, 24, 24, 255]);
  blit(out, a, 0, header);
  blit(out, b, w + PAIR_GAP, header);
  drawLabel(out, labelA, 4, 2, scale, WHITE, [24, 24, 24, 255], 2);
  drawLabel(out, labelB, w + PAIR_GAP + 4, 2, scale, WHITE, [24, 24, 24, 255], 2);
  return out;
}

export const timeLabel = (prefix: string, t: number): string => `${prefix} ${t.toFixed(2)}s`;

// ---------- the tool ----------

async function runQueued<T>(ctx: ToolContext, label: string, opId: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await ctx.queue.run(label, fn);
  } catch (err) {
    if (err instanceof QueueWaitError) {
      throw new BridgeError({ kind: "queued", op_id: opId, message: err.message });
    }
    throw err;
  }
}

export const ANNOTATE_NOTES = [
  "Outlines are each layer's content rect (sourceRectAtTime) moved through its transforms and parents. Effects that move or grow pixels, masks, track mattes and motion blur are not in them, so a box can disagree with the pixels.",
  "Tag numbers are layer indexes in the comp; `index` maps each to the layer id and name. Names are drawn in capitals, cut to 20 characters.",
];

export const NOTE_3D =
  "3D boxes are projected through the active camera (or AE's default camera) by the tool's own maths. This is an estimate until checked against the render: X/Y rotation signs and the rotation order are unmeasured.";

interface Shot {
  read: HostRead;
  path: string;
}

export const annotateTools: ToolDefinition<any>[] = [
  {
    name: TOOL,
    description:
      "READ-ONLY. Renders one frame and draws on it what After Effects does not show an agent: each layer's outline (a rotated box), a `<number> <NAME>` tag, an anchor cross and the action/title-safe rectangles, so you and the user can point at the same 'Shape Layer 12'. " +
      "Returns `path` (the annotated PNG, shrunk to `max_size` before drawing so tags stay sharp) and `frames[].layers`, the index from tag number (= layer index) to layer id, name, kind, parent, box corners and anchor in comp pixels, and why a layer has no box. " +
      "Options: `layers` filters to visible, selected or all layers (and `layer_ids`); `zoom` crops a comp-pixel region from the full-size render and enlarges it up to 8x; `grid` and `rulers` add a coordinate grid; `time_b` makes a pair, A beside B; `stats` returns mean colour and luma per quadrant or grid cell (a brand colour, a fade) as numbers. Transparency shows as a checkerboard. " +
      "Boxes are content rects: effects, masks, mattes and motion blur are not in them. 3D layers come back with `box: null` unless `include_3d: true`, which projects them through the camera by an unmeasured, experimental estimate (`projection: '3d-estimated'`). " +
      "Strictly read-only: the comp's time, resolution, selection and solo are not touched, and nothing lands on the undo stack. Each frame is a render, so heavy comps take a while. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeAnnotateFrameSchema,
    handler: async (args: AeAnnotateFrameArgs, ctx: ToolContext) => {
      const framesDir = defaultFramesDir();
      fs.mkdirSync(framesDir, { recursive: true });
      const opId = ctx.bridge.newOpId();
      const times = args.time_b === undefined ? [args.time] : [args.time, args.time_b];
      const label = `${TOOL}(${args.comp_id} @ ${times.join("s, ")}s)`;

      const shots = await runQueued(ctx, label, opId, async () => {
        const got: Shot[] = [];
        for (let i = 0; i < times.length; i++) {
          // The transform read and the render are separate evalScripts, and the
          // render uses the time the read settled on (clamped to the last frame).
          const res = await ctx.bridge.evalRaw<HostRead>({
            id: `${opId}_read${i}`,
            script: buildJsxCall("annotateRead", {
              comp_id: args.comp_id,
              time: times[i],
              include_extents: args.include_extents,
            }),
            label: `${label} read`,
            timeoutMs: SLOW_TIMEOUT_MS,
            mutates: false,
            toolName: TOOL,
          });
          const read = res.result;
          if (args.zoom) checkZoom(read.comp, args.zoom);
          const snap = await captureCompFrame({
            ctx,
            opId,
            compId: args.comp_id,
            time: read.time,
            frameIndex: i,
            framesDir,
            toolName: TOOL,
          });
          got.push({ read, path: snap.path });
        }
        return got;
      });

      const comp = shots[0].read.comp;
      const pair = shots.length === 2;
      const budget = pair ? Math.floor((args.max_size - PAIR_GAP) / 2) : args.max_size;
      const draw: DrawOptions = {
        outlines: args.outlines,
        tags: args.tags,
        anchors: args.anchors,
        safeAreas: args.safe_areas,
        actionSafe: args.action_safe,
        titleSafe: args.title_safe,
        grid: args.grid,
        rulers: args.rulers,
        checkerboard: args.checkerboard,
      };

      const images: PNG[] = [];
      const frames: Array<Record<string, unknown>> = [];
      let gridSpacing: number | undefined;
      let viewInfo: Record<string, unknown> = {};
      shots.forEach((shot, i) => {
        // One frame decoded at a time; the base is built from it, then it is dropped.
        const img = decodePngFile(shot.path);
        const view = makeView(comp, img, args.zoom, budget);
        const picked = chooseLayers(shot.read.layers, args.layers, args.layer_ids);
        const index = buildIndex(shot.read, picked, args.include_3d);
        const missing = missingLayerIds(shot.read, picked, args.layers, args.layer_ids);
        const base = renderBase(img, view, args.checkerboard);
        drawAnnotations(base, view, comp, index, draw);
        images.push(base);
        if (args.grid !== undefined) gridSpacing = effectiveGridSpacing(args.grid, view);
        viewInfo = {
          region: [view.region.x0, view.region.y0, view.region.x1, view.region.y1],
          scale: r2(view.k),
          render_size: [img.width, img.height],
          render_scale: [r2(view.isx), r2(view.isy)],
        };
        const notes: string[] = [];
        if (picked.length === 0) notes.push(`No layers matched \`layers: ${args.layers}\`${args.layer_ids ? " and layer_ids" : ""}.`);
        if (index.some((e) => e.three_d && e.box)) {
          const cam = cameraModel(shot.read, layerMap(shot.read.layers));
          if (cam.source === "layer") notes.push(`3D layers use camera "${cam.name}".`);
          else if (!cam.note) notes.push("3D layers use AE's default comp camera.");
          if (cam.note) notes.push(cam.note);
        }
        if (shot.read.truncated) notes.push(`Only the first 500 of ${shot.read.total_layers} layers were read.`);
        if (missing.length > 0) notes.push(`${missing.length} requested layer_ids are not in the index; see missing_layer_ids.`);
        frames.push({
          ...(pair ? { label: i === 0 ? "A" : "B" } : {}),
          time: shot.read.time,
          full_path: shot.path,
          layers: index,
          layer_count: index.length,
          total_layers: shot.read.total_layers,
          truncated: shot.read.truncated,
          ...(missing.length > 0 ? { missing_layer_ids: missing } : {}),
          drawn_count: index.filter((e) => e.drawn).length,
          ...(args.stats ? { stats: gridStats(img, view, args.stats_cols, args.stats_rows) } : {}),
          ...(notes.length > 0 ? { notes } : {}),
        });
      });

      const final = pair
        ? composePair(images[0], images[1], timeLabel("A", shots[0].read.time), timeLabel("B", shots[1].read.time))
        : images[0];
      const outPath = path.join(
        framesDir,
        `annotated_c${args.comp_id}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.png`
      );
      fs.writeFileSync(outPath, encodePng(final));

      const notes = [...ANNOTATE_NOTES];
      if (frames.some((f) => (f.layers as IndexEntry[]).some((e) => e.box?.projection === "3d-estimated"))) notes.push(NOTE_3D);
      return {
        ok: true,
        read_only: true,
        path: outPath,
        width: final.width,
        height: final.height,
        mode: pair ? "pair" : "single",
        truncated: frames.some((f) => f.truncated === true),
        comp: {
          id: comp.id,
          name: comp.name,
          width: comp.width,
          height: comp.height,
          pixel_aspect: comp.pixel_aspect,
          resolution_factor: comp.resolution_factor,
        },
        view: viewInfo,
        ...(gridSpacing !== undefined ? { grid_spacing: gridSpacing } : {}),
        frames,
        notes,
      };
    },
  },
];
