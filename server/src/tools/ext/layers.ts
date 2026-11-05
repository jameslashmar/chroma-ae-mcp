/**
 * server/src/tools/ext/layers.ts
 *
 * Layer tools, each a guarded write with a read-back of the layer stack in a
 * separate evalScript:
 * - ae_create_layer: solid, null, adjustment, text, shape, camera, light,
 *   footage or precomp layer, named, parented and placed in the stack
 * - ae_precompose: comp.layers.precompose, with AE's one-layer rule for
 *   leaving attributes behind checked before AE is touched
 * - ae_set_track_matte: AE 23+ layer-based mattes (setTrackMatte); on older
 *   AE the matte must be the layer directly above, which the tool checks
 */

import { z } from "zod";
import type { ReceiptMismatch } from "../../receipts.js";
import {
  AGENT_SAFETY_GUIDANCE,
  ExpectSchema,
  LayerSelectorSchema,
  type LayerSelector,
  type ToolDefinition,
} from "../common.js";
import { expectThat, runGuardedWrite } from "./write-runner.js";

// ---------- read-back shape ----------

export interface StackLayer {
  index: number;
  id: number;
  name: string;
  kind: string;
  enabled: boolean;
  inPoint?: number;
  outPoint?: number;
  parent: number | null;
  threeD?: boolean;
  adjustment?: boolean;
  sourceId?: number;
  lightType?: string;
  /** An environment light's source layer (null when it has none). */
  lightSource?: { index: number; id: number; name: string } | null;
  /** A light's options as read: intensity, color, cone_angle, cone_feather, casts_shadows, shadow_darkness, shadow_diffusion (the ones the light has). */
  lightOptions?: Record<string, number | boolean | number[]>;
  /** A parametric mesh layer's type, options and bevel options as read. */
  mesh?: { type: string | null; options: Record<string, number | boolean>; bevel: Record<string, number | boolean> };
  text?: string;
  /** A text layer's PostScript font name and whether AE substitutes it. */
  font?: string;
  fontIsSubstitute?: boolean;
  trackMatte?: { type: string; layer: { index: number; id: number; name: string } | null };
  isTrackMatte?: boolean;
}

export interface LayerStack {
  comp_id: number;
  name: string;
  numLayers: number;
  frameDuration?: number;
  /** True when the host listed fewer layers than the comp has (its cap is 500). */
  truncated?: boolean;
  layers: StackLayer[];
  with_comp?: LayerStack;
}

const stackOf = (v: unknown): LayerStack | null => (v && typeof v === "object" ? (v as LayerStack) : null);
const byId = (stack: LayerStack | null, id: unknown) => stack?.layers.find((l) => l.id === id);

/** The host lists the first 500 layers plus any asked for by id or index; a layer outside the list can't be judged. */
const capped = (stack: LayerStack | null) => !!stack && (stack.truncated === true || stack.numLayers > stack.layers.length);

/** Finds a selector's layer in a stack read before the write. */
export function resolveInStack(stack: LayerStack | null, sel: LayerSelector | undefined): StackLayer | undefined {
  if (!stack || !sel) return undefined;
  if (sel.id !== undefined) return stack.layers.find((l) => l.id === sel.id);
  if (sel.index !== undefined) return stack.layers.find((l) => l.index === sel.index);
  const named = stack.layers.filter((l) => l.name === sel.name);
  return named.length === 1 ? named[0] : undefined;
}

// ---------- schemas ----------

const LAYER_TYPES = ["solid", "null", "adjustment", "text", "shape", "camera", "light", "footage", "precomp", "mesh"] as const;
const LIGHT_TYPES = ["parallel", "spot", "point", "ambient", "environment"] as const;
export const MESH_TYPES = ["cube", "sphere", "plane", "torus", "cone", "cylinder"] as const;
const MATTE_TYPES = ["alpha", "alpha_inverted", "luma", "luma_inverted", "none"] as const;

export const PlacementSchema = z
  .object({
    above: LayerSelectorSchema.optional().describe("Put the new layer directly above this one."),
    below: LayerSelectorSchema.optional().describe("Put the new layer directly below this one."),
    index: z.number().int().positive().optional().describe("The 1-based index the new layer should end up at."),
    bottom: z.boolean().optional().describe("Put the new layer at the bottom of the stack."),
  })
  .refine((p) => [p.above, p.below, p.index, p.bottom ? true : undefined].filter((v) => v !== undefined).length === 1, {
    message: "Placement takes exactly one of above, below, index or bottom.",
  })
  .describe("Where the layer goes. Default: the top of the stack, as in AE.");

const Color = z.array(z.number().min(0).max(1)).length(3);

// ---------- parametric meshes (AE 26.3) ----------

// Field names exactly as the ParametricMeshLayer page spells them. Value ranges
// and units are not documented (smoothingAngle and slice* are probably degrees):
// the read-back shows what AE took.
const MeshNum = z.number().min(-1e6).max(1e6);
const MeshCount = z.number().int().min(1).max(100000);
const MeshFlag = z.boolean();

const CubeOptions = z.object({ width: MeshNum, height: MeshNum, depth: MeshNum, smoothingAngle: MeshNum }).partial().strict();
const SphereOptions = z.object({ radius: MeshNum, sides: MeshCount, sliceCaps: MeshFlag, sliceStart: MeshNum, sliceEnd: MeshNum, smoothingAngle: MeshNum }).partial().strict();
const PlaneOptions = z.object({ width: MeshNum, length: MeshNum, cornerRadius: MeshNum, cornerSides: MeshCount }).partial().strict();
const TorusOptions = z
  .object({ ringRadius: MeshNum, pipeRadius: MeshNum, ringSides: MeshCount, pipeSides: MeshCount, caps: MeshFlag, sliceStart: MeshNum, sliceEnd: MeshNum, smoothingAngle: MeshNum })
  .partial()
  .strict();
const ConeOptions = z
  .object({ topRadius: MeshNum, bottomRadius: MeshNum, height: MeshNum, sides: MeshCount, topCap: MeshFlag, bottomCap: MeshFlag, sliceCaps: MeshFlag, sliceStart: MeshNum, sliceEnd: MeshNum, smoothingAngle: MeshNum })
  .partial()
  .strict();
const CylinderOptions = z
  .object({ radius: MeshNum, height: MeshNum, sides: MeshCount, topCap: MeshFlag, bottomCap: MeshFlag, sliceCaps: MeshFlag, sliceStart: MeshNum, sliceEnd: MeshNum, smoothingAngle: MeshNum })
  .partial()
  .strict();
const CubeBevel = z.object({ radius: MeshNum, sides: MeshCount }).partial().strict();
const ConeBevel = z.object({ topRadius: MeshNum, topSides: MeshCount, bottomRadius: MeshNum, bottomSides: MeshCount }).partial().strict();
const CylinderBevel = z.object({ radius: MeshNum, sides: MeshCount }).partial().strict();

/**
 * The mesh part of a create request, discriminated by mesh_type: each type
 * takes only its own fields, and only a cube, cone or cylinder has bevel
 * options (a sphere, plane or torus given any is refused here, before AE).
 */
export const MeshSpecSchema = z.discriminatedUnion("mesh_type", [
  z.object({ mesh_type: z.literal("cube"), mesh_options: CubeOptions.optional(), bevel_options: CubeBevel.optional() }).strict(),
  z.object({ mesh_type: z.literal("sphere"), mesh_options: SphereOptions.optional() }).strict(),
  z.object({ mesh_type: z.literal("plane"), mesh_options: PlaneOptions.optional() }).strict(),
  z.object({ mesh_type: z.literal("torus"), mesh_options: TorusOptions.optional() }).strict(),
  z.object({ mesh_type: z.literal("cone"), mesh_options: ConeOptions.optional(), bevel_options: ConeBevel.optional() }).strict(),
  z.object({ mesh_type: z.literal("cylinder"), mesh_options: CylinderOptions.optional(), bevel_options: CylinderBevel.optional() }).strict(),
]);

export const LightOptionsSchema = z
  .object({
    intensity: z.number().min(-10000).max(10000).optional().describe("Intensity in percent."),
    color: Color.optional().describe("Light colour [r, g, b] in 0..1."),
    cone_angle: z.number().min(0).max(180).optional().describe("Spot lights only: cone angle in degrees."),
    cone_feather: z.number().min(0).max(100).optional().describe("Spot lights only: cone feather in percent."),
    casts_shadows: z.boolean().optional().describe("Spot, point, parallel and environment lights only."),
    shadow_darkness: z.number().min(0).max(100).optional().describe("Casts-shadows lights only: shadow darkness in percent."),
    shadow_diffusion: z.number().min(0).max(10000).optional().describe("Casts-shadows lights only: shadow diffusion in pixels."),
  })
  .strict()
  .refine((o) => Object.values(o).some((v) => v !== undefined), { message: "light_options needs at least one option." })
  .describe(
    "Light Options set when the light is created, through 'ADBE Light Options Group'. Cone options are for spot lights; shadow options for spot, point, parallel and environment lights (an ambient light has none, and is refused; an option AE does not expose on the light is skipped with a warning). " +
      "An option the light does not expose is skipped and named in `warnings`."
  );

const FontSchema = z
  .union([
    z.string().min(1).max(200).describe("A PostScript name, e.g. 'ArialMT'."),
    z.object({ family: z.string().min(1).max(200), style: z.string().min(1).max(200) }).strict().describe("A family and style, e.g. {family: 'Arial', style: 'Bold'}."),
  ])
  .describe("The text layer's font. Checked against the installed fonts first: an unknown or substituted font is refused with near matches, instead of silently falling back.");

export const AeCreateLayerSchema = z
  .object({
    comp_id: z.number().int(),
    type: z.enum(LAYER_TYPES),
    name: z.string().min(1).max(200).optional().describe("Layer name. Text layers are named after their text by default."),
    color: Color.optional().describe("Solid colour [r, g, b] in 0..1 (solid and adjustment). Default white."),
    width: z.number().int().min(1).max(30000).optional().describe("Solid width in pixels. Default the comp's."),
    height: z.number().int().min(1).max(30000).optional().describe("Solid height in pixels. Default the comp's."),
    text: z.string().max(20000).optional().describe("Text layer content."),
    box_size: z.array(z.number().positive()).length(2).optional().describe("Paragraph (box) text of [width, height] instead of point text."),
    light_type: z
      .enum(LIGHT_TYPES)
      .optional()
      .describe("Light type. Left out, a plain light keeps the type After Effects makes; when light_options is given without a type the light is made a point light. 'environment' (AE 24.3+) lights a scene (3D models, Advanced 3D renderer) from the image in `light_source`."),
    light_source: LayerSelectorSchema.optional().describe(
      "Environment lights only: the layer whose picture lights the scene. It must be a 2D layer in the same comp (a 3D layer is refused: AE answers 'Invalid light source specified'). " +
        "On AE 24.3 to 25.1 only an HDR or EXR footage layer works; from 25.2 any 2D video, still or precomp layer. Left out, the light has no image and a warning says so."
    ),
    light_options: LightOptionsSchema.optional(),
    mesh_type: z.enum(MESH_TYPES).optional().describe("Mesh layers (AE 26.3): the primitive. Required for type 'mesh'."),
    mesh_options: z
      .record(z.union([z.number(), z.boolean()]))
      .optional()
      .describe(
        "Mesh layers: the primitive's fields, exactly the Guide's names. cube: width, height, depth, smoothingAngle. sphere: radius, sides, sliceCaps, sliceStart, sliceEnd, smoothingAngle. plane: width, length, cornerRadius, cornerSides. " +
          "torus: ringRadius, pipeRadius, ringSides, pipeSides, caps, sliceStart, sliceEnd, smoothingAngle. cone: topRadius, bottomRadius, height, sides, topCap, bottomCap, sliceCaps, sliceStart, sliceEnd, smoothingAngle. " +
          "cylinder: radius, height, sides, topCap, bottomCap, sliceCaps, sliceStart, sliceEnd, smoothingAngle. Units and ranges are not documented; the read-back shows what AE took."
      ),
    bevel_options: z
      .record(z.union([z.number(), z.boolean()]))
      .optional()
      .describe("Mesh layers: bevel fields. cube: radius, sides. cone: topRadius, topSides, bottomRadius, bottomSides. cylinder: radius, sides. Sphere, plane and torus have no bevel and are refused."),
    orientation: z.enum(["horizontal", "vertical"]).optional().describe("Text layers: 'vertical' makes vertical text (AE 24.2+; with box_size, vertical box text). Default horizontal."),
    font: FontSchema.optional(),
    item_id: z.number().int().optional().describe("Project item for footage (a FootageItem) or precomp (a CompItem) layers."),
    duration: z.number().positive().optional().describe("Layer length in seconds. Default the comp's."),
    start_time: z.number().optional().describe("Layer start time in comp seconds. Default 0."),
    three_d: z.boolean().optional().describe("Make it a 3D layer (cameras and lights always are)."),
    parent: LayerSelectorSchema.optional().describe("Parent the new layer to this layer."),
    placement: PlacementSchema.optional(),
    expect: ExpectSchema,
  })
  .refine((v) => (v.type === "footage" || v.type === "precomp" ? v.item_id !== undefined : true), {
    message: "footage and precomp layers need item_id.",
  })
  .refine((v) => v.item_id === undefined || v.type === "footage" || v.type === "precomp", {
    message: "item_id applies to footage and precomp layers only.",
  })
  .refine((v) => v.light_type === undefined || v.type === "light", { message: "light_type applies to light layers only." })
  .refine((v) => (v.text === undefined && v.box_size === undefined) || v.type === "text", {
    message: "text and box_size apply to text layers only.",
  })
  .refine(
    (v) => (v.color === undefined && v.width === undefined && v.height === undefined) || v.type === "solid" || v.type === "adjustment",
    { message: "color, width and height apply to solid and adjustment layers only." }
  )
  .refine((v) => v.type !== "mesh" || v.mesh_type !== undefined, { message: "mesh layers need mesh_type." })
  .refine((v) => v.type === "mesh" || (v.mesh_type === undefined && v.mesh_options === undefined && v.bevel_options === undefined), {
    message: "mesh_type, mesh_options and bevel_options apply to mesh layers only.",
  })
  .refine((v) => v.type === "light" || (v.light_source === undefined && v.light_options === undefined), {
    message: "light_source and light_options apply to light layers only.",
  })
  .refine((v) => v.light_source === undefined || v.light_type === "environment", { message: "light_source applies to environment lights only (light_type 'environment')." })
  .refine((v) => v.type === "text" || (v.orientation === undefined && v.font === undefined), { message: "orientation and font apply to text layers only." })
  .superRefine((v, ctx) => {
    if (v.type === "light" && v.light_options) {
      const o = v.light_options;
      const lt = v.light_type ?? "point";
      if ((o.cone_angle !== undefined || o.cone_feather !== undefined) && lt !== "spot") {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["light_options"], message: `cone_angle and cone_feather apply to spot lights only (this is a ${lt} light).` });
      }
      if ((o.casts_shadows !== undefined || o.shadow_darkness !== undefined || o.shadow_diffusion !== undefined) && !["spot", "point", "parallel", "environment"].includes(lt)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["light_options"], message: `Shadow options apply to spot, point, parallel and environment lights only (this is a ${lt} light).` });
      }
    }
    if (v.type === "mesh" && v.mesh_type !== undefined) {
      // strict() flags a key that is present even when undefined, so only pass the ones given.
      const spec: Record<string, unknown> = { mesh_type: v.mesh_type };
      if (v.mesh_options !== undefined) spec.mesh_options = v.mesh_options;
      if (v.bevel_options !== undefined) spec.bevel_options = v.bevel_options;
      const r = MeshSpecSchema.safeParse(spec);
      if (!r.success) {
        for (const issue of r.error.issues) {
          const key = String(issue.path[0] ?? "mesh_options");
          const hint = issue.code === "unrecognized_keys" ? ` (not a field of a ${v.mesh_type}; a sphere, plane or torus has no bevel_options)` : "";
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key, ...issue.path.slice(1)], message: `${issue.message}${hint}` });
        }
      }
    }
  });

export const AePrecomposeSchema = z.object({
  comp_id: z.number().int(),
  layers: z.array(LayerSelectorSchema).min(1).max(500).describe("The layers to move into the new comp."),
  name: z.string().min(1).max(200).optional().describe("Name of the new comp. Default 'Pre-comp N'."),
  move_all_attributes: z
    .boolean()
    .optional()
    .describe(
      "Default true: the new comp takes the comp's size and length, and the layers keep their effects and keyframes inside it. " +
        "False leaves effects, masks and transforms on the precomp layer in this comp, and the new comp takes the layer's source size; AE allows it for one layer only."
    ),
  expect: ExpectSchema,
});

export const AeSetTrackMatteSchema = z
  .object({
    comp_id: z.number().int(),
    layer: LayerSelectorSchema.describe("The layer the matte applies to."),
    type: z.enum(MATTE_TYPES).describe("'none' removes the matte."),
    matte: LayerSelectorSchema.optional().describe("The matte layer. Any layer in the comp on AE 23+; the layer directly above on older AE."),
    hide_matte: z.boolean().optional().describe("Turn off the matte layer's video, as AE's UI does. Default true."),
    show_matte: z.boolean().optional().describe("With type 'none': turn the old matte layer's video back on."),
    expect: ExpectSchema,
  })
  .refine((v) => v.type === "none" || v.matte !== undefined, { message: "Give the matte layer, or type 'none' to remove it." });

// ---------- checks ----------

type CreateArgs = z.infer<typeof AeCreateLayerSchema>;

/** The layer kinds layerStack can report for each created type. */
function kindsFor(type: CreateArgs["type"]): string[] {
  // A GLB / glTF / OBJ item placed as footage becomes a 3D model layer (AE 24.4).
  if (type === "footage") return ["footage", "audio", "solid", "model_3d"];
  if (type === "mesh") return ["parametric_mesh"];
  return [type];
}

const closeTo = (a: unknown, b: unknown) => typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= 0.01 + Math.abs(b) * 1e-6;

/** Environment light source and options, mesh fields and font, against what the separate read-back found. */
function checkThreeDExtras(m: ReceiptMismatch[], args: CreateArgs, made: StackLayer, written: Record<string, unknown>): void {
  if (args.type === "light") {
    if (args.light_type === "environment" && args.light_source !== undefined && typeof written.light_source_id === "number") {
      expectThat(m, made.lightSource?.id === written.light_source_id, "layer.lightSource", written.light_source_id, made.lightSource?.id, "Environment light source differs");
    }
    const skipped = new Set(((written.light_options_skipped as string[] | undefined) ?? []).map(String));
    const opts = (args.light_options ?? {}) as Record<string, unknown>;
    for (const [key, want] of Object.entries(opts)) {
      if (want === undefined || skipped.has(key)) continue;
      const got = made.lightOptions?.[key];
      if (key === "color") {
        const c = got as number[] | undefined;
        const w = want as number[];
        expectThat(m, Array.isArray(c) && w.every((x, i) => closeTo(c[i], x)), "layer.lightOptions.color", w, c, "Light colour differs");
      } else if (key === "casts_shadows") {
        expectThat(m, got === want, "layer.lightOptions.casts_shadows", want, got, "Casts Shadows differs");
      } else {
        expectThat(m, closeTo(got, want), `layer.lightOptions.${key}`, want, got, `Light option ${key} differs`);
      }
    }
  }
  if (args.type === "mesh") {
    expectThat(m, made.mesh?.type === args.mesh_type, "layer.mesh.type", args.mesh_type, made.mesh?.type, "Mesh type differs");
    const groups: Array<[string, Record<string, unknown> | undefined, Record<string, number | boolean> | undefined]> = [
      ["options", args.mesh_options as Record<string, unknown> | undefined, made.mesh?.options],
      ["bevel", args.bevel_options as Record<string, unknown> | undefined, made.mesh?.bevel],
    ];
    for (const [label, want, got] of groups) {
      for (const [key, w] of Object.entries(want ?? {})) {
        const g = got?.[key];
        if (typeof w === "boolean") expectThat(m, g === w, `layer.mesh.${label}.${key}`, w, g, `Mesh ${key} differs (or was not in the read-back)`);
        else expectThat(m, closeTo(g, w), `layer.mesh.${label}.${key}`, w, g, `Mesh ${key} differs (or was not in the read-back); units and ranges are not documented`);
      }
    }
  }
  if (args.type === "text" && args.font !== undefined) {
    const ps = (written.font as { postscript?: string } | undefined)?.postscript;
    if (ps !== undefined && made.font !== undefined) expectThat(m, made.font === ps, "layer.font", ps, made.font, "Font differs");
    if (made.fontIsSubstitute !== undefined) expectThat(m, made.fontIsSubstitute === false, "layer.fontIsSubstitute", false, made.fontIsSubstitute, "After Effects substitutes this font");
  }
}

export function createLayerMismatches(args: CreateArgs, beforeRaw: unknown, afterRaw: unknown, written: Record<string, unknown>): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const before = stackOf(beforeRaw);
  const after = stackOf(afterRaw);
  if (!before || !after) return m;
  expectThat(m, after.numLayers === before.numLayers + 1, "numLayers", before.numLayers + 1, after.numLayers, "Layer count did not grow by one");
  const made = byId(after, written.id);
  if (!made) {
    // A layer outside the host's list (a huge comp) can't be judged here.
    if (capped(after)) return m;
    m.push({ path: "layer", expected: written.id, actual: undefined, message: "The new layer is not in the read-back" });
    return m;
  }
  expectThat(m, kindsFor(args.type).includes(made.kind), "layer.kind", args.type, made.kind, "The new layer is of another kind");
  if (args.name) expectThat(m, made.name === args.name, "layer.name", args.name, made.name, "Name differs");
  if (args.type === "text" && args.text !== undefined && made.text !== undefined && args.text.length <= 200) {
    // AE stores line breaks as \r.
    const norm = (s: string) => s.replace(/\r\n?|\n/g, "\n");
    expectThat(m, norm(made.text) === norm(args.text), "layer.text", args.text, made.text, "Text differs");
  }
  if (args.three_d && args.type !== "camera" && args.type !== "light") {
    expectThat(m, made.threeD === true, "layer.threeD", true, made.threeD, "Layer is not 3D");
  }
  if (args.type === "adjustment") expectThat(m, made.adjustment === true, "layer.adjustment", true, made.adjustment, "Not an adjustment layer");
  if (args.type === "light") {
    const wantType = args.light_type ?? (args.light_options ? "point" : undefined);
    if (wantType) expectThat(m, made.lightType === wantType, "layer.lightType", wantType, made.lightType, "Light type differs");
  }
  checkThreeDExtras(m, args, made, written);
  // Layer start and length, within a frame (AE snaps times to frames).
  const tol = (after.frameDuration ?? 0.05) * 1.01 + 1e-6;
  if (args.start_time !== undefined && made.inPoint !== undefined) {
    expectThat(m, Math.abs(made.inPoint - args.start_time) <= tol, "layer.inPoint", args.start_time, made.inPoint, "Start time differs");
  }
  if (args.duration !== undefined && made.inPoint !== undefined && made.outPoint !== undefined) {
    const len = made.outPoint - made.inPoint;
    expectThat(m, Math.abs(len - args.duration) <= tol, "layer.duration", args.duration, len, "Layer length differs (a video or comp layer can't be longer than its source)");
  }
  if (args.parent) {
    const parent = resolveInStack(before, args.parent);
    const parentNow = parent ? byId(after, parent.id) : undefined;
    // A parent past the list's cap can't be judged.
    if (parentNow !== undefined || !(capped(before) || capped(after))) {
      expectThat(m, parentNow !== undefined && made.parent === parentNow.index, "layer.parent", parentNow?.index, made.parent, "Parent differs");
    }
  }
  const p = args.placement;
  if (p?.index !== undefined) {
    const want = Math.min(p.index, after.numLayers);
    expectThat(m, made.index === want, "layer.index", want, made.index, "Layer is not at the requested index");
  } else if (p?.bottom) {
    expectThat(m, made.index === after.numLayers, "layer.index", after.numLayers, made.index, "Layer is not at the bottom");
  } else if (p?.above || p?.below) {
    const ref = resolveInStack(before, p.above ?? p.below);
    const refNow = ref ? byId(after, ref.id) : undefined;
    const want = refNow ? (p.above ? refNow.index - 1 : refNow.index + 1) : undefined;
    if (want === undefined && (capped(before) || capped(after))) return m;
    expectThat(m, want !== undefined && made.index === want, "layer.index", want, made.index, p.above ? "Layer is not directly above its reference" : "Layer is not directly below its reference");
  } else {
    expectThat(m, made.index === 1, "layer.index", 1, made.index, "Layer is not at the top");
  }
  return m;
}

export function precomposeMismatches(beforeRaw: unknown, afterRaw: unknown, written: Record<string, unknown>): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const before = stackOf(beforeRaw);
  const after = stackOf(afterRaw);
  if (!before || !after) return m;
  const indexes = (written.layer_indexes as number[] | undefined) ?? [];
  const names = (written.layer_names as string[] | undefined) ?? [];
  const want = before.numLayers - indexes.length + 1;
  expectThat(m, after.numLayers === want, "numLayers", want, after.numLayers, "Layer count is not what precomposing should leave");
  const precompLayer = after.layers.find((l) => l.sourceId === written.new_comp_id);
  const top = indexes.length ? Math.min(...indexes) : undefined;
  if (precompLayer !== undefined || !capped(after)) {
    expectThat(m, precompLayer !== undefined && precompLayer.index === top, "precomp_layer.index", top, precompLayer?.index, "The precomp layer is not where the topmost precomposed layer was");
  }
  const inner = after.with_comp;
  if (!inner) {
    m.push({ path: "new_comp", expected: written.new_comp_id, actual: undefined, message: "The new comp could not be read back" });
    return m;
  }
  const innerNames = inner.layers.map((l) => l.name);
  expectThat(m, JSON.stringify(innerNames) === JSON.stringify(names), "new_comp.layers", names, innerNames, "The new comp does not hold the precomposed layers in order");
  return m;
}

type MatteArgs = z.infer<typeof AeSetTrackMatteSchema>;

export function trackMatteMismatches(args: MatteArgs, beforeRaw: unknown, afterRaw: unknown, written: Record<string, unknown>): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const after = stackOf(afterRaw);
  if (!after) return m;
  const target = byId(after, (written.layer as { id?: number } | undefined)?.id);
  if (!target) {
    if (capped(after)) return m;
    m.push({ path: "layer", expected: written.layer, actual: undefined, message: "The layer is not in the read-back" });
    return m;
  }
  expectThat(m, target.trackMatte?.type === args.type, "layer.trackMatte.type", args.type, target.trackMatte?.type, "Track matte type differs");
  if (args.type === "none") {
    const prev = written.previous_matte as { id?: number } | undefined;
    if (args.show_matte && prev?.id !== undefined) {
      const prevNow = byId(after, prev.id);
      if (prevNow !== undefined || !capped(after)) {
        expectThat(m, prevNow?.enabled === true, "previous_matte.enabled", true, prevNow?.enabled, "The old matte layer is still hidden");
      }
    }
    return m;
  }
  const matteId = (written.matte as { id?: number } | undefined)?.id;
  expectThat(m, target.trackMatte?.layer?.id === matteId, "layer.trackMatte.layer", matteId, target.trackMatte?.layer?.id, "Track matte layer differs");
  const matte = byId(after, matteId);
  if (args.hide_matte !== false && (matte !== undefined || !capped(after))) {
    expectThat(m, matte?.enabled === false, "matte.enabled", false, matte?.enabled, "The matte layer's video is still on");
  }
  // Mattes changed between the reads only on this layer.
  const before = stackOf(beforeRaw);
  for (const l of after.layers) {
    if (l.id === target.id) continue;
    const was = byId(before, l.id);
    if (was && JSON.stringify(was.trackMatte) !== JSON.stringify(l.trackMatte) && was.index === l.index) {
      m.push({ path: `layers[${l.index}].trackMatte`, expected: was.trackMatte, actual: l.trackMatte, message: `The matte on "${l.name}" changed too` });
    }
  }
  return m;
}

// ---------- tools ----------

/** Layers past the host's 500 cap to list as well, so a read-back can find them. */
interface Include {
  ids?: number[];
  indexes?: number[];
}

const uniq = (v: Array<number | undefined>): number[] => [...new Set(v.filter((n): n is number => typeof n === "number"))].slice(0, 50);

const stackRead = (compId: number, withComp?: number, include?: Include) => {
  const args: Record<string, unknown> = { comp_id: compId };
  if (withComp !== undefined) args.with_comp_id = withComp;
  const ids = uniq(include?.ids ?? []);
  const indexes = uniq(include?.indexes ?? []);
  if (ids.length) args.include_ids = ids;
  if (indexes.length) args.include_indexes = indexes;
  return { host: "layerStack", args };
};

/** Ids and indexes the selectors name; the before stack turns an index or name into an id for the read after (indexes shift). */
function selectorRefs(sels: Array<LayerSelector | undefined>, before?: unknown): Include {
  const stack = stackOf(before);
  const ids: Array<number | undefined> = [];
  const indexes: Array<number | undefined> = [];
  for (const sel of sels) {
    if (!sel) continue;
    ids.push(sel.id);
    indexes.push(sel.index);
    if (stack) ids.push(resolveInStack(stack, sel)?.id);
  }
  return { ids: uniq(ids), indexes: uniq(indexes) };
}

export const layersTools: ToolDefinition<any>[] = [
  {
    name: "ae_create_layer",
    description:
      "Create a layer in a comp: solid, null, adjustment, text (point or box, horizontal or vertical), shape (empty), camera, light, footage or precomp (from a project item), or a parametric mesh, " +
      "with a name, length, start time, 3D switch, parent and place in the stack, in one undo group guarded by `expect`. " +
      "Lights: light_type includes 'environment' (AE 24.3+), which lights 3D scenes from `light_source` (a 2D layer in the same comp; a warning appears when the comp's renderer is not Advanced 3D), and `light_options` set intensity, colour, cone and shadows at creation. " +
      "Meshes (type 'mesh', AE 26.3+): mesh_type cube, sphere, plane, torus, cone or cylinder, with mesh_options and bevel_options named exactly as the Guide names them (a sphere, plane or torus has no bevel); units and ranges are not documented, so check the read-back. " +
      "Text: orientation 'vertical' (AE 24.2+) and `font` (a PostScript name or family and style, checked against the installed fonts: an unknown or substituted font is refused with near matches). " +
      "A member the open AE version lacks is refused before anything changes, saying which version it needs. A GLB / glTF / OBJ item placed as footage reads back as a model_3d layer. " +
      "The read-back (a separate evalScript) checks the layer count, kind, name, text, start time, length, parent and index, and for the options above the light source and options, the mesh type and fields, and the font. A video or precomp layer can only be shortened, not made longer than its source. Solids add a solid item to the project, as in AE. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeCreateLayerSchema,
    handler: (args: CreateArgs, ctx) =>
      runGuardedWrite(ctx, {
        toolName: "ae_create_layer",
        label: `ae_create_layer(${args.type}${args.name ? ` "${args.name}"` : ""})`,
        expect: args.expect,
        compId: args.comp_id,
        read: (phase, w, before) => {
          const refs = selectorRefs([args.parent, args.placement?.above, args.placement?.below], phase === "after" ? before : undefined);
          const indexes = [...(refs.indexes ?? []), args.placement?.index];
          const ids = phase === "after" ? [...(refs.ids ?? []), w?.id as number | undefined] : refs.ids;
          return stackRead(args.comp_id, undefined, { ids: uniq(ids ?? []), indexes: uniq(indexes) });
        },
        write: {
          host: "createLayer",
          args: {
            comp_id: args.comp_id,
            type: args.type,
            name: args.name,
            color: args.color,
            width: args.width,
            height: args.height,
            text: args.text,
            box_size: args.box_size,
            light_type: args.light_type,
            light_source: args.light_source,
            light_options: args.light_options,
            mesh_type: args.mesh_type,
            mesh_options: args.mesh_options,
            bevel_options: args.bevel_options,
            orientation: args.orientation,
            font: args.font,
            item_id: args.item_id,
            duration: args.duration,
            start_time: args.start_time,
            three_d: args.three_d,
            parent: args.parent,
            placement: args.placement,
            label: `Create ${args.type} layer`,
          },
        },
        check: (before, after, w) => createLayerMismatches(args, before, after, w),
        present: (_before, after, w) => {
          const layer = byId(stackOf(after), w.id) ?? w;
          const warnings = w.warnings as string[] | undefined;
          return warnings && warnings.length ? { layer, warnings } : { layer };
        },
      }),
  },
  {
    name: "ae_precompose",
    description:
      "Precompose layers into a new comp (Layer > Pre-compose), in one undo group guarded by `expect`. " +
      "move_all_attributes (default true) moves effects and keyframes into the new comp; false keeps them on the precomp layer and works for one layer only. " +
      "The read-back (a separate evalScript) checks the precomp layer sits where the topmost layer was and the new comp holds the layers in order. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AePrecomposeSchema,
    handler: async (args: z.infer<typeof AePrecomposeSchema>, ctx) => {
      if (args.move_all_attributes === false && args.layers.length > 1) {
        return {
          ok: false,
          error: "bad_args",
          message: "Leaving attributes in the comp works for one layer only (AE's rule). Precompose several layers with move_all_attributes true.",
        };
      }
      return runGuardedWrite(ctx, {
        toolName: "ae_precompose",
        label: `ae_precompose(${args.layers.length} layer${args.layers.length === 1 ? "" : "s"})`,
        expect: args.expect,
        compId: args.comp_id,
        read: (phase, w) => {
          if (phase === "before") return stackRead(args.comp_id);
          const indexes = (w?.layer_indexes as number[] | undefined) ?? [];
          const top = indexes.length ? Math.min(...indexes) : undefined;
          return stackRead(args.comp_id, w?.new_comp_id as number | undefined, { indexes: top === undefined ? [] : [top] });
        },
        write: {
          host: "precomposeLayers",
          args: { comp_id: args.comp_id, layers: args.layers, name: args.name, move_all_attributes: args.move_all_attributes, label: "Pre-compose" },
        },
        check: (before, after, w) => precomposeMismatches(before, after, w),
        present: (_before, after, w) => {
          const stack = stackOf(after);
          const inner = stack?.with_comp;
          return {
            new_comp: { id: w.new_comp_id, name: w.new_comp_name, layers: inner?.layers.map((l) => ({ index: l.index, id: l.id, name: l.name })) },
            precomp_layer: stack?.layers.find((l) => l.sourceId === w.new_comp_id),
            move_all_attributes: w.move_all_attributes,
          };
        },
      });
    },
  },
  {
    name: "ae_set_track_matte",
    description:
      "Set or remove a layer's track matte (alpha, alpha inverted, luma, luma inverted), in one undo group guarded by `expect`. " +
      "On AE 23+ the matte can be any layer in the comp (setTrackMatte); on older AE it must be the layer directly above, and the tool refuses otherwise instead of matting with the wrong layer. " +
      "The matte layer's video is turned off as AE's UI does (hide_matte: false keeps it on). " +
      "The read-back (a separate evalScript) checks the type, the matte layer, its visibility, and that no other layer's matte changed. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeSetTrackMatteSchema,
    handler: (args: MatteArgs, ctx) =>
      runGuardedWrite(ctx, {
        toolName: "ae_set_track_matte",
        label: `ae_set_track_matte(${args.type})`,
        expect: args.expect,
        compId: args.comp_id,
        read: (phase, w, before) => {
          if (phase === "before") return stackRead(args.comp_id, undefined, selectorRefs([args.layer, args.matte]));
          const refs = selectorRefs([args.layer, args.matte], before);
          const ids = [
            ...(refs.ids ?? []),
            (w?.layer as { id?: number } | undefined)?.id,
            (w?.matte as { id?: number } | undefined)?.id,
            (w?.previous_matte as { id?: number } | undefined)?.id,
          ];
          return stackRead(args.comp_id, undefined, { ids: uniq(ids) });
        },
        write: {
          host: "setTrackMatte",
          args: {
            comp_id: args.comp_id,
            layer: args.layer,
            matte: args.matte,
            type: args.type,
            hide_matte: args.hide_matte,
            show_matte: args.show_matte,
            label: args.type === "none" ? "Remove track matte" : "Set track matte",
          },
        },
        check: (before, after, w) => trackMatteMismatches(args, before, after, w),
        present: (_before, after, w) => {
          const stack = stackOf(after);
          const layerId = (w.layer as { id?: number } | undefined)?.id;
          return { layer: byId(stack, layerId), matte: w.matte, previous_matte: w.previous_matte, api: w.api };
        },
      }),
  },
];
