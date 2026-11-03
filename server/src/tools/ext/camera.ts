/**
 * server/src/tools/ext/camera.ts
 *
 * Camera tools:
 * - ae_camera_rig: a one- or two-node camera, a controller null whose sliders
 *   drive it by expression (push-in, dolly, orbit, parallax), depth of field
 *   focused on a layer, and "make these layers 3D with a Z spread". A guarded
 *   write, read back in a separate evalScript.
 * - ae_scene_3d_report (read only): the 3D layers sorted by camera-space
 *   depth, which are behind the camera or outside the frame, cameras that are
 *   not active, and depth of field with no target.
 *
 * ExtendScript has no toWorld/fromWorld, so the report's world positions are
 * worked out here in Node from each layer's transform at the time, with the
 * same matrix maths ae_annotate_frame uses (annotate.ts). The camera's X/Y
 * rotation signs there are unmeasured; so is a parented two-node camera's
 * point of interest.
 */

import { z } from "zod";
import type { ReceiptMismatch } from "../../receipts.js";
import { AGENT_SAFETY_GUIDANCE, ExpectSchema, LayerSelectorSchema, type ToolDefinition } from "../common.js";
import {
  cameraModel,
  chainMatrix,
  layerMap,
  transformPoint,
  type HostLayer,
  type HostRead,
  type Vec3,
} from "./annotate.js";
import { expectThat, runGuardedWrite } from "./write-runner.js";

// ---------- lens maths ----------

export interface Lens {
  zoom?: number;
  angle_of_view?: number;
  focal_length?: number;
  film_size?: number;
}

/** AE's default lens: 50 mm on a 36 mm film back. */
export const DEFAULT_FOCAL_LENGTH = 50;
export const DEFAULT_FILM_SIZE = 36;

/** Camera Zoom in pixels: (comp width / 2) / tan(angle of view / 2). */
export function zoomFromLens(compWidth: number, lens?: Lens): number {
  const dflt = (compWidth * DEFAULT_FOCAL_LENGTH) / DEFAULT_FILM_SIZE;
  if (!lens) return dflt;
  if (lens.zoom !== undefined) return lens.zoom;
  const film = lens.film_size ?? DEFAULT_FILM_SIZE;
  let aov: number;
  if (lens.angle_of_view !== undefined) aov = (lens.angle_of_view * Math.PI) / 180;
  else if (lens.focal_length !== undefined) aov = 2 * Math.atan(film / (2 * lens.focal_length));
  else return dflt;
  return compWidth / 2 / Math.tan(aov / 2);
}

/** The horizontal angle of view in degrees for a zoom. */
export function angleOfViewFromZoom(compWidth: number, zoom: number): number {
  return ((2 * Math.atan(compWidth / 2 / zoom)) * 180) / Math.PI;
}

/** The Z of each of n layers, evenly from near (the first) to far (the last). */
export function spreadZs(near: number, far: number, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(n > 1 ? near + ((far - near) * i) / (n - 1) : near);
  return out;
}

// ---------- schemas ----------

export const PRESETS = ["static", "push_in", "dolly", "orbit", "parallax"] as const;

const LensSchema = z
  .object({
    zoom: z.number().positive().max(1e6).optional().describe("Camera Zoom in pixels, set as given."),
    angle_of_view: z.number().gt(0).lt(180).optional().describe("Horizontal angle of view in degrees. Zoom = (comp width / 2) / tan(angle / 2)."),
    focal_length: z.number().positive().max(10000).optional().describe("Focal length in mm on the film size below (default 36 mm, AE's). 50 mm is AE's default camera."),
    film_size: z.number().positive().max(1000).optional().describe("Film size in mm, only with focal_length. Default 36."),
  })
  .refine((l) => [l.zoom, l.angle_of_view, l.focal_length].filter((v) => v !== undefined).length <= 1, {
    message: "Give one of zoom, angle_of_view or focal_length.",
  })
  .refine((l) => l.film_size === undefined || l.focal_length !== undefined, { message: "film_size applies with focal_length only." })
  .describe("The lens. Default: AE's 50 mm camera.");

const MotionSchema = z
  .object({
    amount: z
      .number()
      .min(-1e6)
      .max(1e6)
      .describe("Where the preset's main control ends: Push in pixels toward the subject, Truck in pixels to the right, Orbit Angle in degrees (positive swings the camera right)."),
    start_time: z.number().min(0).optional().describe("Seconds in the comp where the move starts. Default 0."),
    duration: z.number().positive().optional().describe("Seconds the move takes. Default 2."),
    ease: z.boolean().optional().describe("Easy-ease both keyframes. Default true."),
  })
  .describe("Keyframes the main control from 0 to `amount`. Leave it out to rig only; the controller's sliders stay free to animate.");

const FocusSchema = z
  .object({
    layer: LayerSelectorSchema.optional().describe("Keep this layer in focus: Focus Distance gets an expression reading the layer's depth in camera space. Its name must be unique."),
    distance: z.number().min(0).optional().describe("A fixed focus distance in pixels instead of a layer."),
    aperture: z.number().min(0).optional().describe("Camera Aperture in pixels (smaller is deeper focus)."),
    blur_level: z.number().min(0).max(1000).optional().describe("Camera Blur Level in percent."),
  })
  .refine((f) => !(f.layer !== undefined && f.distance !== undefined), { message: "Give a focus layer or a distance, not both." })
  .refine((f) => f.layer !== undefined || f.distance !== undefined || f.aperture !== undefined || f.blur_level !== undefined, {
    message: "focus needs at least one of layer, distance, aperture, blur_level.",
  })
  .describe("Turns depth of field on. Iris and highlight options differ per renderer and are left alone.");

const SpreadSchema = z
  .object({
    layers: z.array(LayerSelectorSchema).min(1).max(200).describe("Picture layers to make 3D, nearest first."),
    near: z.number().describe("Z in pixels of the first layer (0 is the comp plane; positive is away from the camera)."),
    far: z.number().describe("Z of the last layer. The others sit evenly between."),
    keep_size: z.boolean().optional().describe("Scale each layer by (distance + z) / distance so it looks the same size from the camera. Default true. Needs a Scale that is not keyframed."),
  })
  .describe("Make layers 3D and place them at different depths. Their Position must not be keyframed or driven by an expression.");

export const AeCameraRigSchema = z
  .object({
    comp_id: z.number().int(),
    name: z.string().min(1).max(200).optional().describe("Camera name. Default 'Camera'."),
    nodes: z.enum(["one", "two"]).optional().describe("'two' (default) aims at a point of interest; 'one' has none and points along its own rotation."),
    preset: z
      .enum(PRESETS)
      .optional()
      .describe(
        "static (default): a camera only. push_in: a controller null with Distance and Push sliders. dolly and parallax: Distance and Truck sliders (the camera slides sideways; parallax is for layers spread in depth). " +
          "orbit: Distance, Orbit Angle and Tilt sliders, swinging the camera around the comp's centre (two nodes)."
      ),
    lens: LensSchema.optional(),
    distance: z
      .number()
      .positive()
      .max(1e6)
      .optional()
      .describe("Camera distance from the comp plane in pixels (the Distance slider). Default the lens's zoom, which frames the comp as it looks with no camera."),
    controller_name: z.string().min(1).max(200).optional().describe("Name of the controller null. Default '<camera name> Controller'. It must not match an existing layer."),
    motion: MotionSchema.optional(),
    focus: FocusSchema.optional(),
    spread: SpreadSchema.optional(),
    expect: ExpectSchema,
  })
  .refine((v) => v.preset !== "orbit" || v.nodes !== "one", { message: "The orbit preset aims at the point of interest, so it needs two nodes." })
  .refine((v) => v.motion === undefined || (v.preset !== undefined && v.preset !== "static"), { message: "motion needs a preset other than static." });

export const AeScene3dReportSchema = z.object({
  comp_id: z.number().int(),
  time: z.number().min(0).optional().describe("Seconds in the comp to read. Default the comp's current time (read, not moved)."),
  camera: LayerSelectorSchema.optional().describe("Look through this camera layer instead of the front-most enabled one."),
});

// ---------- read-back shapes ----------

export interface CameraInfo {
  id: number;
  index: number;
  name: string;
  enabled: boolean;
  two_node: boolean;
  zoom: number | null;
  angle_of_view: number | null;
  dof: boolean;
  focus_distance: number | null;
  aperture: number | null;
  blur_level: number | null;
  parent_id: number | null;
  in_point?: number;
  out_point?: number;
  is_active: boolean;
  expressions: Record<string, string>;
  expression_errors: Array<{ property: string; error: string }>;
}

export interface BriefLayer {
  id: number;
  index: number;
  name: string;
  kind: string;
  enabled: boolean;
  three_d: boolean;
  parent_id: number | null;
  in_point?: number;
  out_point?: number;
  position: number[] | null;
  scale: number[] | null;
  effects: Array<{ name: string; match_name: string; value: number | null; num_keys: number }>;
}

export interface CameraReadBack {
  comp: { id: number; name: string; width: number; height: number; numLayers: number; duration?: number; renderer: string | null };
  time: number;
  cameras: CameraInfo[];
  active_camera_id: number | null;
  layers: BriefLayer[];
  truncated?: boolean;
  /** Ids asked for beyond the host's cap, so never read. */
  ids_dropped?: number;
}

/** What the host's cameraRig returns. */
export interface RigWritten extends Record<string, unknown> {
  camera: { id: number; index: number; name: string };
  controller: { id: number; index: number; name: string } | null;
  preset: string;
  nodes: "one" | "two";
  zoom: number;
  angle_of_view: number;
  distance: number;
  controls: Array<{ name: string; kind: string; value: number }>;
  primary_control: string | null;
  expressions: Record<string, string>;
  spread: Array<{ id: number; name: string; z: number; scale_factor: number }>;
  focus: { layer: { id: number; name: string } | null; distance: number | null; aperture: number | null; blur_level: number | null } | null;
  motion: { control: string; amount: number; start_time: number; duration: number; ease: boolean } | null;
  warnings: string[];
}

type RigArgs = z.infer<typeof AeCameraRigSchema>;

const asRead = (v: unknown): CameraReadBack | null => (v && typeof v === "object" ? (v as CameraReadBack) : null);
const near = (a: number | null | undefined, b: number, tol: number) => typeof a === "number" && Math.abs(a - b) <= tol;

// ---------- the rig's receipt checks ----------

/** The rig's layers must cover the whole comp, whatever the new-layer time preference is. */
function expectSpan(m: ReceiptMismatch[], path: string, l: { in_point?: number; out_point?: number }, duration: number | undefined): void {
  if (typeof l.in_point === "number") expectThat(m, l.in_point <= 0.05, `${path}.in_point`, 0, l.in_point, "Layer starts after the comp's start, so the move partly plays without it");
  if (typeof l.out_point === "number" && typeof duration === "number") {
    expectThat(m, l.out_point >= duration - 0.05, `${path}.out_point`, duration, l.out_point, "Layer ends before the comp's end");
  }
}

export function cameraRigMismatches(args: RigArgs, beforeRaw: unknown, afterRaw: unknown, w: RigWritten): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const before = asRead(beforeRaw);
  const after = asRead(afterRaw);
  if (!after) return m;
  const added = w.controller ? 2 : 1;
  if (before) expectThat(m, after.comp.numLayers === before.comp.numLayers + added, "numLayers", before.comp.numLayers + added, after.comp.numLayers, "Layer count did not grow by the camera and controller");
  const cam = after.cameras.find((c) => c.id === w.camera.id);
  if (!cam) {
    m.push({ path: "camera", expected: w.camera.id, actual: undefined, message: "The new camera is not in the read-back" });
  } else {
    expectThat(m, cam.name === w.camera.name, "camera.name", w.camera.name, cam.name, "Camera name differs");
    expectSpan(m, "camera", cam, after.comp.duration);
    expectThat(m, cam.two_node === (w.nodes === "two"), "camera.two_node", w.nodes === "two", cam.two_node, "Camera has the wrong number of nodes");
    // The same lens maths here as in the host: a different zoom means one of them is wrong.
    const wantZoom = zoomFromLens(after.comp.width, args.lens);
    expectThat(m, near(cam.zoom, wantZoom, Math.max(0.01, wantZoom * 1e-4)), "camera.zoom", wantZoom, cam.zoom, "Zoom differs from the lens asked for");
    if (args.focus) {
      expectThat(m, cam.dof === true, "camera.dof", true, cam.dof, "Depth of field is not on");
      if (args.focus.layer) expectThat(m, typeof cam.expressions.focus_distance === "string", "camera.expressions.focus_distance", "an expression", cam.expressions.focus_distance, "Focus Distance has no expression");
      if (args.focus.distance !== undefined) expectThat(m, near(cam.focus_distance, args.focus.distance, 0.01), "camera.focus_distance", args.focus.distance, cam.focus_distance, "Focus distance differs");
      if (args.focus.aperture !== undefined && cam.aperture !== null) expectThat(m, near(cam.aperture, args.focus.aperture, 0.01), "camera.aperture", args.focus.aperture, cam.aperture, "Aperture differs");
      if (args.focus.blur_level !== undefined && cam.blur_level !== null) expectThat(m, near(cam.blur_level, args.focus.blur_level, 0.01), "camera.blur_level", args.focus.blur_level, cam.blur_level, "Blur level differs");
    }
    if (w.preset !== "static") expectThat(m, typeof cam.expressions.position === "string", "camera.expressions.position", "an expression", cam.expressions.position, "Position has no expression");
    for (const e of cam.expression_errors) {
      m.push({ path: `camera.expressions.${e.property}`, expected: "no error", actual: e.error, message: `The ${e.property} expression has an error` });
    }
  }
  if (w.controller) {
    const ctrl = after.layers.find((l) => l.id === w.controller!.id);
    if (!ctrl) {
      m.push({ path: "controller", expected: w.controller.id, actual: undefined, message: "The controller is not in the read-back" });
    } else {
      expectSpan(m, "controller", ctrl, after.comp.duration);
      for (const c of w.controls) {
        const fx = ctrl.effects.find((e) => e.name === c.name);
        if (!fx) m.push({ path: `controller.${c.name}`, expected: c.name, actual: undefined, message: `Control "${c.name}" is missing on the controller` });
        else if (fx.num_keys === 0) expectThat(m, near(fx.value, c.value, 0.01), `controller.${c.name}`, c.value, fx.value, `Control "${c.name}" has another value`);
      }
      if (w.motion) {
        const fx = ctrl.effects.find((e) => e.name === w.motion!.control);
        expectThat(m, fx?.num_keys === 2, `controller.${w.motion.control}.num_keys`, 2, fx?.num_keys, "The move is not keyframed");
      }
    }
  }
  for (const s of w.spread) {
    const l = after.layers.find((x) => x.id === s.id);
    if (!l) {
      const capped = (after.ids_dropped ?? 0) > 0 ? " (the read-back dropped ids past its cap, so this layer could not be checked)" : "";
      m.push({ path: `spread.${s.name}`, expected: s.id, actual: undefined, message: `Layer "${s.name}" is not in the read-back${capped}` });
      continue;
    }
    expectThat(m, l.three_d, `spread.${s.name}.three_d`, true, l.three_d, `Layer "${s.name}" is not 3D`);
    expectThat(m, near(l.position?.[2], s.z, 0.01), `spread.${s.name}.z`, s.z, l.position?.[2], `Layer "${s.name}" is at another depth`);
  }
  return m;
}

// ---------- the scene report ----------

export interface SceneCameraState {
  zoom: number | null;
  two_node: boolean;
  dof?: boolean;
  focus_distance?: number | null;
  focus_expression?: boolean;
  aperture?: number | null;
  blur_level?: number | null;
}

export interface SceneLayer extends HostLayer {
  camera?: SceneCameraState;
}

export interface SceneRead extends HostRead {
  layers: SceneLayer[];
  /** True when the front-most enabled camera sits past the layers that were read. */
  active_camera_beyond_list?: boolean;
  comp: HostRead["comp"] & { renderer?: string | null };
}

export interface DepthEntry {
  index: number;
  id: number;
  name: string;
  kind: string;
  world: number[];
  /** Distance along the camera's view axis; at or below 0 is behind it. */
  depth: number;
  /** Where the anchor lands in comp pixels, null behind the camera. */
  screen: number[] | null;
  /** zoom / depth: how big the layer looks next to its size at the comp plane. */
  size_ratio: number | null;
  behind_camera: boolean;
  center_in_frame: boolean;
  rendered: boolean;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const MIN_DEPTH = 1e-6;

export function analyseScene(read: SceneRead, cameraId?: number) {
  const warnings: string[] = [];
  const notes: string[] = [];
  const byId = layerMap(read.layers);
  const wantId = cameraId ?? read.active_camera_id;
  const model = cameraModel({ ...read, active_camera_id: wantId }, byId);
  if (model.note) warnings.push(model.note);
  const camLayer = (model.source === "layer" && wantId !== null ? byId.get(wantId) : undefined) as SceneLayer | undefined;
  if (model.source === "default") notes.push("No camera layer: depths are measured from AE's default comp camera.");

  const { width, height } = read.comp;
  const entries: DepthEntry[] = [];
  let twoD = 0;
  const unresolved: Array<{ id: number; name: string; reason: string }> = [];
  for (const l of read.layers) {
    if (l.kind === "camera" || l.kind === "light") continue;
    if (!l.three_d) {
      twoD++;
      continue;
    }
    // A layer's own Auto-Orient does not move its anchor; only its ancestors' flags make the chain unresolved.
    const chain = chainMatrix({ ...l, auto_orient_active: false }, byId);
    if (!chain.matrix || !l.transform) {
      unresolved.push({ id: l.id, name: l.name, reason: chain.reason ?? "no transform" });
      continue;
    }
    const a = l.transform.anchor;
    const world = transformPoint(chain.matrix, [a[0] ?? 0, a[1] ?? 0, a[2] ?? 0] as Vec3);
    const cs = transformPoint(model.view, world);
    const depth = cs[2];
    const behind = depth <= MIN_DEPTH;
    const sx = behind ? null : width / 2 + (cs[0] / depth) * model.zoom;
    const sy = behind ? null : height / 2 + (cs[1] / depth) * model.zoom;
    entries.push({
      index: l.index,
      id: l.id,
      name: l.name,
      kind: l.kind,
      world: world.map(r3),
      depth: r3(depth),
      screen: sx === null || sy === null ? null : [r3(sx), r3(sy)],
      size_ratio: behind ? null : r3(model.zoom / depth),
      behind_camera: behind,
      center_in_frame: sx !== null && sy !== null && sx >= 0 && sx <= width && sy >= 0 && sy <= height,
      rendered: l.visible && l.kind !== "null" && l.guide !== true && (!read.solo_active || l.solo === true),
    });
  }
  entries.sort((x, y) => x.depth - y.depth || x.index - y.index);

  // Layers that do not render (off, outside their in and out, guide) are listed but never flagged.
  const behind = entries.filter((e) => e.rendered && e.behind_camera).map((e) => ({ id: e.id, name: e.name, depth: e.depth }));
  const outside = entries.filter((e) => e.rendered && !e.behind_camera && !e.center_in_frame).map((e) => ({ id: e.id, name: e.name, screen: e.screen }));

  const cameras = read.layers.filter((l) => l.kind === "camera");
  const idle = cameras.filter((c) => c.enabled && c.id !== wantId && read.time >= c.in_point && read.time < c.out_point);
  if (idle.length) warnings.push(`${idle.length} other enabled camera(s) at this time are not used: ${idle.map((c) => `"${c.name}"`).join(", ")}`);
  const state = camLayer?.camera;
  if (state?.dof && !state.focus_expression) {
    warnings.push(
      `Depth of field is on for "${camLayer!.name}" with a fixed focus distance${typeof state.focus_distance === "number" ? ` of ${r3(state.focus_distance)} px` : ""}; nothing keeps a subject in focus. ae_camera_rig can tie it to a layer.`
    );
  }
  if (camLayer && camLayer.parent_id !== null) notes.push("The camera is parented: its point of interest and rotation signs are unmeasured through a parent, so treat the depths as approximate.");
  if (camLayer?.camera?.two_node) notes.push("X and Y rotation signs are unmeasured; a two-node camera that also has rotation values may be off.");
  if (read.active_camera_beyond_list) warnings.push("The active camera is past the layers that were read, so depths are measured from AE's default camera instead.");
  if (read.truncated) warnings.push(`The comp has ${read.total_layers} layers; only the first ${read.layers.length} were read.`);
  for (const u of unresolved) warnings.push(`"${u.name}" skipped: ${u.reason}`);

  return {
    time: read.time,
    comp: { id: read.comp.id, name: read.comp.name, width, height, renderer: read.comp.renderer ?? null },
    camera: {
      source: model.source,
      id: camLayer?.id ?? null,
      name: model.name ?? null,
      zoom: r3(model.zoom),
      angle_of_view: r3(angleOfViewFromZoom(width, model.zoom)),
      two_node: camLayer?.camera?.two_node ?? null,
      depth_of_field: state?.dof ?? null,
      focus_distance: state?.focus_distance ?? null,
      focus_follows_layer: state?.focus_expression ?? null,
    },
    counts: { three_d: entries.length, two_d: twoD, cameras: cameras.length },
    layers_by_depth: entries,
    behind_camera: behind,
    outside_frame: outside,
    warnings,
    notes,
    truncated: read.truncated,
  };
}

// ---------- tools ----------

const rigIds = (w?: Record<string, unknown>): number[] => {
  const ids: Array<number | undefined> = [];
  const rig = w as Partial<RigWritten> | undefined;
  ids.push(rig?.camera?.id, rig?.controller?.id);
  for (const s of rig?.spread ?? []) ids.push(s.id);
  return ids.filter((n): n is number => typeof n === "number");
};

export const cameraTools: ToolDefinition<any>[] = [
  {
    name: "ae_camera_rig",
    description:
      "Build a camera in one undo group, guarded by `expect`: a one- or two-node camera with a lens (focal length, angle of view or zoom), and for push_in, dolly, orbit or parallax a controller null " +
      "whose sliders (Distance, Push or Truck, Orbit Angle and Tilt) drive the camera's Position by expression, so the move can be tweaked from one place. `motion` keyframes the main slider. " +
      "`focus` turns depth of field on and ties Focus Distance to a layer's depth in camera space. `spread` makes layers 3D at different depths, scaled to keep their size, for parallax. " +
      "If a later step fails, everything this call made is taken back. The new camera goes on top, so it becomes the active one. " +
      "The read-back (a separate evalScript) checks the camera, its lens, node type, depth of field, expression errors, the controller's sliders and keyframes, and the spread layers' depth. " +
      "Use ae_scene_3d_report to see the result by depth. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeCameraRigSchema,
    handler: (args: RigArgs, ctx) =>
      runGuardedWrite<RigWritten>(ctx, {
        toolName: "ae_camera_rig",
        label: `ae_camera_rig(${args.preset ?? "static"}${args.name ? ` "${args.name}"` : ""})`,
        expect: args.expect,
        compId: args.comp_id,
        read: (phase, w) => ({ host: "cameraRead", args: { comp_id: args.comp_id, ids: phase === "after" ? rigIds(w) : [] } }),
        write: {
          host: "cameraRig",
          args: {
            comp_id: args.comp_id,
            name: args.name,
            nodes: args.nodes,
            preset: args.preset,
            lens: args.lens,
            distance: args.distance,
            controller_name: args.controller_name,
            motion: args.motion,
            focus: args.focus,
            spread: args.spread,
            label: "Camera rig",
          },
        },
        check: (before, after, w) => cameraRigMismatches(args, before, after, w),
        present: (_before, after, w) => {
          const read = asRead(after);
          return {
            ...w,
            camera: read?.cameras.find((c) => c.id === w.camera.id) ?? w.camera,
            is_active_camera: read ? read.active_camera_id === w.camera.id : null,
            controller_layer: read?.layers.find((l) => l.id === w.controller?.id) ?? w.controller,
          };
        },
      }),
  },
  {
    name: "ae_scene_3d_report",
    description:
      "Read-only report on a comp's 3D scene at one time: the 3D layers sorted by depth along the camera's view axis (nearest first) with world position, where they land in the frame and how large they look, " +
      "which rendered layers are behind the camera or whose centre falls outside the frame, other enabled cameras that are not used, and depth of field with a fixed focus that tracks nothing. " +
      "Looks through the front-most enabled camera (or the one named), or AE's default camera when there is none. World positions are computed here from the layers' transforms, parent chains included; " +
      "X/Y rotation signs and a parented camera's point of interest are unmeasured, so rotated or parented cameras give approximate depths. Changes nothing: not time, selection or solo. Lists are capped at 500 layers. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeScene3dReportSchema,
    handler: async (args: z.infer<typeof AeScene3dReportSchema>, ctx) => {
      const res = await ctx.bridge.callHost<SceneRead>(
        "cameraSceneRead",
        { comp_id: args.comp_id, time: args.time },
        { label: "ae_scene_3d_report", mutates: false, toolName: "ae_scene_3d_report" }
      );
      const read = res.result;
      let cameraId: number | undefined;
      if (args.camera) {
        const sel = args.camera;
        const cams = read.layers.filter((l) => l.kind === "camera");
        const hit =
          sel.id !== undefined
            ? cams.find((l) => l.id === sel.id)
            : sel.index !== undefined
              ? cams.find((l) => l.index === sel.index)
              : cams.filter((l) => l.name === sel.name).length === 1
                ? cams.find((l) => l.name === sel.name)
                : undefined;
        if (!hit) {
          return { ok: false, error: "not_found", message: "No single camera layer matches that selector in the first 500 layers." };
        }
        cameraId = hit.id;
      }
      return analyseScene(read, cameraId);
    },
  },
];
