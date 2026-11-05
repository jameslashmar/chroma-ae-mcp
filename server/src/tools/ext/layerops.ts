/**
 * server/src/tools/ext/layerops.ts
 *
 * ae_layer_ops: the everyday layer edits in one typed, guarded call, with a
 * dry run first and the layer stack before and after:
 * - parent / unparent (keeping the on-screen position, or jumping on request)
 * - reorder (to the beginning or end, before or after a layer) and sort
 * - duplicate (in place, or copyToComp into another comp) and delete
 * - trim in and out points, or move the start time
 * - rename by find and replace, or by a template with a counter
 * - layer switches: shy, solo, lock, guide, video, collapse, 3D, motion blur,
 *   quality, sampling quality, blend mode, label, effects, preserve
 *   transparency, adjustment, audio, frame blending, per-character 3D,
 *   environment layer, auto-orient, comment and time stretch
 * - replace_source (AVLayer.replaceSource), separate_dimensions (Position),
 *   split (duplicate + in/out points) and solid_settings (colour, size, name
 *   of a solid, for the item or copy-on-write for the selected layers)
 *
 * AE does not rewrite layer(3) in an expression when the stack changes, and
 * the expression never errors: it silently points at another layer. So the
 * structural actions read every expression in the comp before and after (in
 * separate evalScript calls) and warn about the references that moved. The
 * scan is a static one on the expression text, done here in Node.
 */

import { z } from "zod";
import type { ReceiptMismatch } from "../../receipts.js";
import {
  AGENT_SAFETY_GUIDANCE,
  ExpectSchema,
  LayerSelectorSchema,
  type LayerSelector,
  type ToolContext,
  type ToolDefinition,
} from "../common.js";
import { SLOW_TIMEOUT_MS } from "../../host.js";
import { expectThat, runGuardedWrite } from "./write-runner.js";

// ---------- read-back shape ----------

export interface OpsLayer {
  index: number;
  id: number;
  name: string;
  kind: string;
  enabled: boolean;
  inPoint?: number;
  outPoint?: number;
  startTime?: number;
  parent: number | null;
  parent_id?: number | null;
  shy?: boolean;
  solo?: boolean;
  locked?: boolean;
  guide?: boolean;
  label?: number;
  threeD?: boolean;
  motionBlur?: boolean;
  collapse?: boolean;
  quality?: string;
  samplingQuality?: string;
  blendMode?: string;
  effectsActive?: boolean;
  preserveTransparency?: boolean;
  adjustment?: boolean;
  audioEnabled?: boolean;
  frameBlending?: string;
  threeDPerChar?: boolean;
  environment?: boolean;
  autoOrient?: string;
  comment?: string;
  stretch?: number;
  /** The layer's source item, when it has one. */
  sourceId?: number;
  sourceName?: string;
  sourceWidth?: number;
  sourceHeight?: number;
  /** A solid source's colour [r, g, b]. */
  solidColor?: number[];
  /** Whether Position is separated, and the key count of each follower when it is. */
  positionSeparated?: boolean;
  followerKeys?: number[];
}

export interface OpsExpression {
  layer_id: number;
  layer_index: number;
  layer_name: string;
  path: string;
  text: string;
  enabled: boolean;
  /** True when the host cut the text at its string bound: a scan of it is partial. */
  text_truncated?: boolean;
  text_length?: number;
}

export interface OpsStack {
  comp_id: number;
  name: string;
  numLayers: number;
  frameDuration?: number;
  /** True when the host listed fewer layers than the comp has (its cap is 500). */
  truncated?: boolean;
  layers: OpsLayer[];
  expressions?: OpsExpression[];
  expressions_truncated?: boolean;
  with_comp?: OpsStack;
}

const stackOf = (v: unknown): OpsStack | null => (v && typeof v === "object" && Array.isArray((v as OpsStack).layers) ? (v as OpsStack) : null);
const byId = (stack: OpsStack | null, id: unknown) => stack?.layers.find((l) => l.id === id);

/** The host lists the first 500 layers plus any asked for by id or index; a layer outside the list can't be judged. */
const capped = (stack: OpsStack | null) => !!stack && (stack.truncated === true || stack.numLayers > stack.layers.length);

// ---------- schemas ----------

export const OPS_ACTIONS = [
  "parent", "reorder", "sort", "duplicate", "delete", "trim", "rename", "switches",
  "replace_source", "separate_dimensions", "split", "solid_settings",
] as const;
export const BLEND_MODES = [
  "normal", "dissolve", "dancing_dissolve", "darken", "multiply", "color_burn", "classic_color_burn", "linear_burn", "darker_color",
  "add", "lighten", "screen", "color_dodge", "classic_color_dodge", "linear_dodge", "lighter_color", "overlay", "soft_light",
  "hard_light", "linear_light", "vivid_light", "pin_light", "hard_mix", "difference", "classic_difference", "exclusion",
  "subtract", "divide", "hue", "saturation", "color", "luminosity", "stencil_alpha", "stencil_luma", "silhouette_alpha",
  "silhouette_luma", "alpha_add", "luminescent_premul",
] as const;
const LAYER_KINDS = ["solid", "null", "adjustment", "text", "shape", "camera", "light", "footage", "precomp", "audio", "model_3d", "parametric_mesh"] as const;
const FRAME_BLENDING = ["none", "frame_mix", "pixel_motion"] as const;
const AUTO_ORIENT = ["off", "along_path", "towards_camera", "characters_toward_camera"] as const;

export const WhereSchema = z
  .object({
    label: z.number().int().min(0).max(16).optional().describe("Label colour index 0-16 (0 is none)."),
    kind: z.enum(LAYER_KINDS).optional().describe("Layer kind. model_3d (3D model layer, AE 24.4+) and parametric_mesh (AE 26.3+) only match on those versions."),
    name_contains: z.string().min(1).optional().describe("Case-insensitive part of the layer name."),
    shy: z.boolean().optional(),
    locked: z.boolean().optional(),
    enabled: z.boolean().optional().describe("The video (eye) switch."),
    has_parent: z.boolean().optional(),
    effects_active: z.boolean().optional().describe("The effects (fx) switch."),
    preserve_transparency: z.boolean().optional(),
    adjustment: z.boolean().optional().describe("The adjustment layer switch."),
    audio_enabled: z.boolean().optional().describe("The audio switch."),
    three_d: z.boolean().optional().describe("The 3D switch."),
    three_d_per_char: z.boolean().optional().describe("Per-character 3D (text layers)."),
    environment: z.boolean().optional().describe("Environment layer switch (does not render in a Classic 3D comp; warns there)."),
    frame_blending: z.enum(FRAME_BLENDING).optional(),
    auto_orient: z.enum(AUTO_ORIENT).optional(),
    comment_contains: z.string().min(1).optional().describe("Case-insensitive part of the layer comment."),
  })
  .describe("Narrows the layers (or, with no `layers`, the whole stack) to those that match every field given.");

/** The parameters each action takes besides the common ones. Anything else is refused, so a wrong guess is not silently ignored. */
const ACTION_FIELDS: Record<(typeof OPS_ACTIONS)[number], readonly string[]> = {
  parent: ["parent", "unparent", "keep_position"],
  reorder: ["move_to", "relative_to"],
  sort: ["sort_by", "descending"],
  duplicate: ["count", "to_comp_id"],
  delete: [],
  trim: ["in_point", "out_point", "start_time"],
  rename: ["find", "replace", "case_sensitive", "template", "start_number", "number_pad", "fix_name_references"],
  switches: [
    "shy", "solo", "locked", "guide", "enabled", "collapse_transformations", "three_d", "motion_blur",
    "quality", "sampling_quality", "blend_mode", "label_color",
    "effects_active", "preserve_transparency", "adjustment", "audio_enabled", "frame_blending", "three_d_per_char",
    "environment", "auto_orient", "comment", "stretch",
  ],
  replace_source: ["item_id", "fix_expressions", "keep_size"],
  separate_dimensions: ["enable"],
  split: ["time", "times", "name_suffix"],
  solid_settings: ["color", "width", "height", "name", "scope"],
};
const ALL_ACTION_FIELDS = [...new Set(Object.values(ACTION_FIELDS).flat())];
const SWITCH_FIELDS = ACTION_FIELDS.switches;

const BaseObject = z.object({
  action: z.enum(OPS_ACTIONS).describe("What to do. Each action takes its own parameters below; parameters of other actions are refused."),
  comp_id: z.number().int(),
  layers: z.array(LayerSelectorSchema).min(1).max(500).optional().describe("The layers to work on, by id, index or unique name. Every action but sort needs `layers` or `where`; sort defaults to the whole stack."),
  where: WhereSchema.optional(),
  dry_run: z
    .boolean()
    .optional()
    .describe("Plan only: returns what would change (and the layer(index) expressions that would break) and writes nothing, no undo step, no checkpoint. Do this first."),
  unlock_locked: z
    .boolean()
    .optional()
    .describe("Locked layers refuse edits. false (default): the call is refused when a locked layer would be edited. true: unlock them, edit, and lock them again in the same undo group."),

  // parent
  parent: LayerSelectorSchema.optional().describe("parent: the new parent layer."),
  unparent: z.boolean().optional().describe("parent: remove the parent instead."),
  keep_position: z
    .boolean()
    .optional()
    .describe("parent: default true: assigning layer.parent, AE offsets the child's transform so nothing moves on screen. false: setParentWithJump keeps the child's own values, so it jumps."),

  // reorder
  move_to: z.enum(["beginning", "end", "before", "after"]).optional().describe("reorder: where the layers go. They keep their order among themselves."),
  relative_to: LayerSelectorSchema.optional().describe("reorder: the layer to go before or after (move_to before or after)."),

  // sort
  sort_by: z.enum(["name", "start_time", "in_point", "out_point", "z", "label", "index"]).optional().describe("sort: the key. name is natural and case-insensitive (Layer 2 before Layer 10); z is the Position z at the current time. The sorted layers fill the slots the selection held, smallest key on top."),
  descending: z.boolean().optional().describe("sort: largest key first."),

  // duplicate
  count: z.number().int().min(1).max(50).optional().describe("duplicate: copies of each layer, in the same comp. Default 1."),
  to_comp_id: z.number().int().optional().describe("duplicate: copy the layers into this comp with copyToComp (one copy each, on top there) instead of in place."),

  // trim
  in_point: z.number().min(-36000).max(36000).optional().describe("trim: the layer's new in point, in comp seconds."),
  out_point: z.number().min(-36000).max(36000).optional().describe("trim: the layer's new out point, in comp seconds."),
  start_time: z.number().min(-36000).max(36000).optional().describe("trim: move the layer so its start time is this, in comp seconds. In and out move with it, then in_point and out_point apply."),

  // rename
  find: z.string().min(1).max(200).optional().describe("rename: text to find in each name (literal, every occurrence)."),
  replace: z.string().max(200).optional().describe("rename: what to put instead. Default empty."),
  case_sensitive: z.boolean().optional().describe("rename: match case in find. Default false."),
  template: z.string().min(1).max(200).optional().describe("rename: the new name, with {name} (the name after find/replace), {n} (a counter over the selected layers in stack order) and {index} (the layer's index)."),
  start_number: z.number().int().min(0).max(1000000).optional().describe("rename: where {n} starts. Default 1."),
  number_pad: z.number().int().min(0).max(8).optional().describe("rename: digits {n} and {index} are padded to with zeros. Default 0."),
  fix_name_references: z
    .boolean()
    .optional()
    .describe("rename: afterwards run Project.autoFixExpressions for each old name, which repairs name references in expressions that now error. It works on the whole project and only touches broken expressions."),

  // switches
  shy: z.boolean().optional(),
  solo: z.boolean().optional(),
  locked: z.boolean().optional().describe("switches: lock or unlock the layers."),
  guide: z.boolean().optional().describe("switches: guide layer."),
  enabled: z.boolean().optional().describe("switches: the video (eye) switch."),
  collapse_transformations: z.boolean().optional().describe("switches: collapse transformations / continuously rasterize. Precomp and vector layers only; others are skipped."),
  three_d: z.boolean().optional().describe("switches: the 3D switch. Cameras, lights and audio-only layers are skipped."),
  motion_blur: z.boolean().optional(),
  quality: z.enum(["best", "draft", "wireframe"]).optional(),
  sampling_quality: z.enum(["bilinear", "bicubic"]).optional(),
  blend_mode: z.enum(BLEND_MODES).optional(),
  label_color: z.number().int().min(0).max(16).optional().describe("switches: label colour index 0-16 (AE's custom label colours can't be set by script)."),
  effects_active: z.boolean().optional().describe("switches: the effects (fx) switch; off disables every effect on the layer. Cameras and lights are skipped."),
  preserve_transparency: z.boolean().optional().describe("switches: preserve underlying transparency. Layers with video only."),
  adjustment: z.boolean().optional().describe("switches: turn an existing layer into an adjustment layer or back. Nulls, cameras, lights and audio-only layers are skipped."),
  audio_enabled: z.boolean().optional().describe("switches: the audio switch. Only layers that have audio; others are skipped."),
  frame_blending: z
    .enum(FRAME_BLENDING)
    .optional()
    .describe("switches: frame blending mode of a layer with video: none, frame_mix or pixel_motion. It is written even when the comp's own Frame Blending switch is off, but shows nothing then; the result warns."),
  three_d_per_char: z.boolean().optional().describe("switches: per-character 3D. Text layers only; others are skipped."),
  environment: z
    .boolean()
    .optional()
    .describe("switches: environment layer (AVLayer.environmentLayer). Turns the 3D switch on too. Does not render in a Classic 3D comp (warns there); skipped with a reason on an AE without the member."),
  auto_orient: z
    .enum(AUTO_ORIENT)
    .optional()
    .describe("switches: auto-orient: off, along_path, towards_camera (camera or point of interest), characters_toward_camera (text layers with per-character 3D; skipped where this AE lacks it)."),
  comment: z.string().max(1000).optional().describe("switches: the layer comment (empty string clears it)."),
  stretch: z
    .number()
    .min(-9900)
    .max(9900)
    .optional()
    .describe("switches: time stretch in percent: 100 is no stretch, 200 is twice as slow, negative plays backwards. Scales the layer's keyframes and markers and moves its out point; needs no time remap. Values between -1 and 1 (including 0) are refused: AE would silently turn them into 1 or -1."),

  // replace_source
  item_id: z.number().int().optional().describe("replace_source: id of the footage or comp project item that becomes the layers' source (the Alt-drag replace; keeps keys, effects, masks and timing)."),
  fix_expressions: z.boolean().optional().describe("replace_source: let AE rewrite expressions that name the old source. Default true."),
  keep_size: z.boolean().optional().describe("replace_source: when the new source has another size, scale the layer by old size / new size so it keeps its on-screen size, and scale a plain Anchor Point by new size / old size so the content stays in place. A layer with keyframed or expression-driven Scale is not compensated; a keyframed or expression-driven Anchor Point keeps its numbers with a warning. Default false."),

  // separate_dimensions
  enable: z.boolean().optional().describe("separate_dimensions: true separates Position into X, Y (and Z) properties, false unifies them again."),

  // split
  time: z.number().min(-36000).max(36000).optional().describe("split: the comp time (seconds) to cut at. Snapped to the comp's frames."),
  times: z.array(z.number().min(-36000).max(36000)).min(1).max(50).optional().describe("split: several cut times in comp seconds, instead of time."),
  name_suffix: z.string().min(1).max(100).optional().describe("split: name the later parts as the original name plus this text; {n} is the part number (2 for the first new part). Default: AE's own copy names."),

  // solid_settings
  color: z.array(z.number().min(0).max(1)).length(3).optional().describe("solid_settings: the solid's colour [r, g, b], each 0-1."),
  width: z.number().int().min(1).max(30000).optional().describe("solid_settings: the solid's width in pixels."),
  height: z.number().int().min(1).max(30000).optional().describe("solid_settings: the solid's height in pixels."),
  name: z.string().min(1).max(200).optional().describe("solid_settings: the solid item's name (not the layer's; use the rename action for that)."),
  scope: z
    .enum(["item", "layer_only"])
    .optional()
    .describe("solid_settings: item changes the solid item itself, so every layer in every comp that uses it changes too. layer_only makes a new solid item for the selected layers and swaps them onto it. Required when the solid is also used by layers outside the selection (a dry run lists them)."),

  expect: ExpectSchema,
});

type OpsArgs = z.infer<typeof BaseObject>;

export const AeLayerOpsSchema = BaseObject.superRefine((v, ctx) => {
  const bad = (message: string, path?: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: path ? [path] : undefined });
  const allowed = new Set(ACTION_FIELDS[v.action]);
  for (const key of ALL_ACTION_FIELDS) {
    if (!allowed.has(key) && (v as Record<string, unknown>)[key] !== undefined) bad(`${key} does not apply to the ${v.action} action.`, key);
  }
  if (v.action !== "sort" && v.layers === undefined && v.where === undefined) bad(`${v.action} needs layers or where.`, "layers");
  if (v.where !== undefined && Object.values(v.where).every((x) => x === undefined)) bad("where is empty; give at least one field.", "where");
  if (v.action === "parent") {
    if (v.unparent && v.parent) bad("Give parent or unparent, not both.", "parent");
    if (!v.unparent && !v.parent) bad("parent needs the new parent layer, or unparent: true.", "parent");
    if (v.unparent && v.keep_position === false) bad("keep_position false needs a new parent; unparent: true keeps the position.", "keep_position");
  }
  if (v.action === "reorder") {
    if (!v.move_to) bad("reorder needs move_to.", "move_to");
    if ((v.move_to === "before" || v.move_to === "after") && !v.relative_to) bad(`move_to ${v.move_to} needs relative_to.`, "relative_to");
    if ((v.move_to === "beginning" || v.move_to === "end") && v.relative_to) bad("relative_to goes with move_to before or after.", "relative_to");
  }
  if (v.action === "sort" && !v.sort_by) bad("sort needs sort_by.", "sort_by");
  if (v.action === "duplicate" && v.to_comp_id !== undefined) {
    if (v.to_comp_id === v.comp_id) bad("to_comp_id is the same comp; leave it out to duplicate in place.", "to_comp_id");
    if (v.count !== undefined && v.count > 1) bad("count above 1 works for duplicates in the same comp only.", "count");
  }
  if (v.action === "trim") {
    if (v.in_point === undefined && v.out_point === undefined && v.start_time === undefined) bad("trim needs in_point, out_point or start_time.", "in_point");
    if (v.in_point !== undefined && v.out_point !== undefined && v.in_point >= v.out_point) bad("in_point must be before out_point.", "in_point");
  }
  if (v.action === "rename") {
    if (v.find === undefined && v.template === undefined) bad("rename needs find (with replace) or template.", "find");
    if (v.replace !== undefined && v.find === undefined) bad("replace goes with find.", "replace");
  }
  if (v.action === "switches" && SWITCH_FIELDS.every((k) => (v as Record<string, unknown>)[k] === undefined)) {
    bad(`switches needs at least one of: ${SWITCH_FIELDS.join(", ")}.`, "shy");
  }
  if (v.action === "switches") {
    if (v.stretch !== undefined && Math.abs(v.stretch) < 1) {
      bad("stretch must be at least 1 or at most -1 in size: AE turns values from 0 to 1 into 1 and from -1 to 0 into -1. 100 is no stretch.", "stretch");
    }
    if (v.environment === true && v.three_d === false) bad("An environment layer must be 3D: drop three_d false.", "three_d");
    if (v.auto_orient === "characters_toward_camera" && v.three_d_per_char === false) {
      bad("characters_toward_camera needs per-character 3D: drop three_d_per_char false.", "three_d_per_char");
    }
  }
  if (v.action === "replace_source" && v.item_id === undefined) bad("replace_source needs item_id.", "item_id");
  if (v.action === "separate_dimensions" && v.enable === undefined) bad("separate_dimensions needs enable (true to separate, false to unify).", "enable");
  if (v.action === "split") {
    if (v.time === undefined && v.times === undefined) bad("split needs time or times.", "time");
    if (v.time !== undefined && v.times !== undefined) bad("Give time or times, not both.", "times");
  }
  if (v.action === "solid_settings" && v.color === undefined && v.width === undefined && v.height === undefined && v.name === undefined) {
    bad("solid_settings needs at least one of color, width, height, name.", "color");
  }
});

// ---------- expression scan (static text, in Node) ----------

/** Comments blanked (strings kept), and a second copy with string contents blanked as well. Same length, so offsets line up. */
function maskExpression(text: string): { noComments: string; codeOnly: string } {
  let noComments = "";
  let codeOnly = "";
  let i = 0;
  let quote = "";
  while (i < text.length) {
    const c = text[i]!;
    const next = text[i + 1];
    if (quote) {
      if (c === "\\" && i + 1 < text.length) {
        noComments += c + next!;
        codeOnly += "  ";
        i += 2;
        continue;
      }
      const closing = c === quote;
      if (closing) quote = "";
      noComments += c;
      codeOnly += closing ? c : " ";
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      noComments += c;
      codeOnly += c;
      i++;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n" && text[i] !== "\r") {
        noComments += " ";
        codeOnly += " ";
        i++;
      }
      continue;
    }
    if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      for (; i < stop; i++) {
        const blank = text[i] === "\n" || text[i] === "\r" ? text[i]! : " ";
        noComments += blank;
        codeOnly += blank;
      }
      continue;
    }
    noComments += c;
    codeOnly += c;
    i++;
  }
  return { noComments, codeOnly };
}

/** Whether a layer(...) call at `at` in the masked code reads this comp: bare layer(, or thisComp.layer(. comp("x").layer( and other receivers are other comps. */
function readsThisComp(code: string, at: number): boolean {
  let j = at - 1;
  while (j >= 0 && /\s/.test(code[j]!)) j--;
  if (j < 0) return true;
  if (code[j] === ".") {
    const before = code.slice(0, j).trimEnd();
    return /(?:^|[^\w$.])thisComp$/.test(before);
  }
  return !/[\w$]/.test(code[j]!);
}

export interface IndexReference {
  /** The literal index, or the offset from the layer's own index for relative references. */
  value: number;
  relative: boolean;
  /** For a relative reference: false when the argument is index arithmetic this scan can't evaluate. */
  parsed: boolean;
  start: number;
  end: number;
  text: string;
}

/** layer(3), thisComp.layer(3) and layer(index - 1) in an expression's code. */
export function findIndexReferences(expression: string): IndexReference[] {
  const { codeOnly } = maskExpression(expression);
  const out: IndexReference[] = [];
  const re = /layer\s*\(/g;
  for (let m = re.exec(codeOnly); m !== null; m = re.exec(codeOnly)) {
    if (!readsThisComp(codeOnly, m.index)) continue;
    // Find the matching close paren, so an argument with its own parentheses is read whole.
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let close = -1;
    for (let i = open; i < codeOnly.length; i++) {
      const ch = codeOnly[i];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close === -1) continue;
    const raw = codeOnly.slice(open + 1, close);
    const arg = raw.trim();
    const full = codeOnly.slice(m.index, close + 1);
    const argStart = open + 1;
    if (/^\d+$/.test(arg)) {
      out.push({ value: Number(arg), relative: false, parsed: true, start: argStart, end: argStart + raw.length, text: full });
    } else if (/\bindex\b/.test(arg)) {
      const rel = /^(?:thisLayer\s*\.\s*)?index\s*(?:([+-])\s*(\d+))?$/.exec(arg);
      if (rel) {
        const delta = rel[1] ? (rel[1] === "-" ? -Number(rel[2]) : Number(rel[2])) : 0;
        out.push({ value: delta, relative: true, parsed: true, start: argStart, end: argStart + raw.length, text: full });
      } else {
        out.push({ value: 0, relative: true, parsed: false, start: argStart, end: argStart + raw.length, text: full });
      }
    }
  }
  return out;
}

/** layer("Name") and thisComp.layer('Name') in an expression: the names it refers to. */
export function findNameReferences(expression: string): string[] {
  const { noComments, codeOnly } = maskExpression(expression);
  const out: string[] = [];
  const re = /layer\s*\(\s*(["'])((?:\\.|(?!\1)[^\\])*)\1\s*\)/g;
  for (let m = re.exec(noComments); m !== null; m = re.exec(noComments)) {
    if (!readsThisComp(codeOnly, m.index)) continue;
    out.push(m[2]!.replace(/\\(["'\\])/g, "$1"));
  }
  return out;
}

export interface ExpressionWarning {
  layer_id: number;
  layer_name: string;
  path: string;
  kind: "index" | "relative_index" | "relative_index_unparsed" | "name" | "partial_scan" | "copied_reference";
  reference: string;
  was?: { index: number; layer_id: number; layer_name: string };
  /** What the reference reads after the change: the layer now at that index, or null when there is none. */
  now?: { index: number; layer_id: number; layer_name: string } | null;
  message: string;
  /** The expression with moved index references rewritten to the new indexes. Name references are the sturdier fix: layer("Name"). */
  suggested_expression?: string;
}

/**
 * Where each layer id goes: its new index, or null when it is gone. Ids that are
 * absent are unknown (past the host's list) and are not judged.
 */
export type IndexMap = Map<number, number | null>;

/** The index map of the stack the write left. */
export function indexMapFromStack(before: OpsStack, after: OpsStack): IndexMap {
  const map: IndexMap = new Map();
  const complete = !capped(after);
  for (const l of before.layers) {
    const now = after.layers.find((x) => x.id === l.id);
    if (now) map.set(l.id, now.index);
    else if (complete) map.set(l.id, null);
  }
  return map;
}

/** The index map the planned order gives. null entries are layers the action will add. */
export function indexMapFromOrder(before: OpsStack, order: Array<number | null>, truncated: boolean): IndexMap {
  const map: IndexMap = new Map();
  const at = new Map<number, number>();
  order.forEach((id, i) => {
    if (id !== null) at.set(id, i + 1);
  });
  for (const l of before.layers) {
    const now = at.get(l.id);
    if (now !== undefined) map.set(l.id, now);
    else if (!truncated) map.set(l.id, null);
  }
  return map;
}

const MAX_WARNINGS = 100;

function partialScanWarning(ex: OpsExpression): ExpressionWarning {
  return {
    layer_id: ex.layer_id,
    layer_name: ex.layer_name,
    path: ex.path,
    kind: "partial_scan",
    reference: "",
    message: `The expression on "${ex.layer_name}" (${ex.path}) is ${ex.text_length ?? "longer than the bound"} characters and was read only in part, so layer(index) references past the cut were not checked. No rewrite is suggested for it.`,
  };
}

/**
 * layer(N) references that point at another layer after the change. AE never
 * reports these (the expression still evaluates), so they are found from the
 * expression text and the layer each index meant before.
 * `occupant` names the layer now at an index, when the new stack is known.
 */
export function indexReferenceWarnings(
  before: OpsStack,
  map: IndexMap,
  occupant: (index: number) => { layer_id: number; layer_name: string } | undefined
): ExpressionWarning[] {
  const out: ExpressionWarning[] = [];
  const idAt = new Map<number, OpsLayer>();
  for (const l of before.layers) idAt.set(l.index, l);
  for (const ex of before.expressions ?? []) {
    if (!ex.enabled) continue;
    if (out.length >= MAX_WARNINGS) break;
    if (!map.has(ex.layer_id) || map.get(ex.layer_id) === null) continue; // the owner is gone or unknown
    if (ex.text_truncated) out.push(partialScanWarning(ex));
    const ownerOld = ex.layer_index;
    const ownerNew = map.get(ex.layer_id) as number;
    const edits: Array<{ start: number; end: number; to: number }> = [];
    const found: ExpressionWarning[] = [];
    for (const ref of findIndexReferences(ex.text)) {
      if (ref.relative && !ref.parsed) {
        if (ownerOld !== ownerNew) {
          found.push({
            layer_id: ex.layer_id,
            layer_name: ex.layer_name,
            path: ex.path,
            kind: "relative_index_unparsed",
            reference: ref.text,
            message: `${ref.text} uses index arithmetic this scan can't evaluate, and its layer moved from ${ownerOld} to ${ownerNew}: check what it points at.`,
          });
        }
        continue;
      }
      const oldIndex = ref.relative ? ownerOld + ref.value : ref.value;
      const target = idAt.get(oldIndex);
      if (!target) continue; // pointed past the stack: it already errored or meant nothing
      if (!map.has(target.id)) continue;
      const newTarget = map.get(target.id) as number | null;
      const readsIndex = ref.relative ? ownerNew + ref.value : ref.value;
      const kind = ref.relative ? "relative_index" : "index";
      const was = { index: oldIndex, layer_id: target.id, layer_name: target.name };
      if (newTarget === null) {
        const occ = occupant(readsIndex);
        found.push({
          layer_id: ex.layer_id,
          layer_name: ex.layer_name,
          path: ex.path,
          kind,
          reference: ref.text,
          was,
          now: occ ? { index: readsIndex, ...occ } : null,
          message: `${ref.text} pointed at "${target.name}", which is deleted; it now reads ${occ ? `"${occ.layer_name}"` : "no layer"}.`,
        });
      } else if (newTarget !== readsIndex) {
        const occ = occupant(readsIndex);
        found.push({
          layer_id: ex.layer_id,
          layer_name: ex.layer_name,
          path: ex.path,
          kind,
          reference: ref.text,
          was,
          now: occ ? { index: readsIndex, ...occ } : null,
          message: `${ref.text} pointed at "${target.name}", which is now at index ${newTarget}; it reads ${occ ? `"${occ.layer_name}"` : "index " + readsIndex} instead.`,
        });
        if (!ref.relative) edits.push({ start: ref.start, end: ref.end, to: newTarget });
      }
    }
    if (found.length > 0) {
      let suggestion: string | undefined;
      // A cut expression is never offered as a replacement: applying it would destroy the rest.
      if (edits.length > 0 && !ex.text_truncated) {
        suggestion = ex.text;
        for (const e of [...edits].sort((a, b) => b.start - a.start)) suggestion = suggestion.slice(0, e.start) + String(e.to) + suggestion.slice(e.end);
        for (const f of found) f.suggested_expression = suggestion;
      }
      out.push(...found);
    }
  }
  return out.slice(0, MAX_WARNINGS);
}

/**
 * layer("Old") references to a layer that was renamed and that no layer carries
 * any more. AE may rewrite these itself on rename (not measured); this finds the
 * ones it left.
 */
export function nameReferenceWarnings(after: OpsStack, renames: Array<{ id: number; from: string; to: string }>): ExpressionWarning[] {
  const out: ExpressionWarning[] = [];
  if (capped(after)) return out;
  const names = new Set(after.layers.map((l) => l.name));
  const renamed = new Map(renames.map((r) => [r.from, r.to]));
  for (const ex of after.expressions ?? []) {
    if (!ex.enabled) continue;
    if (ex.text_truncated && out.length < MAX_WARNINGS) out.push(partialScanWarning(ex));
    for (const ref of findNameReferences(ex.text)) {
      if (!renamed.has(ref) || names.has(ref)) continue;
      if (out.length >= MAX_WARNINGS) return out;
      out.push({
        layer_id: ex.layer_id,
        layer_name: ex.layer_name,
        path: ex.path,
        kind: "name",
        reference: `layer("${ref}")`,
        message: `layer("${ref}") refers to a layer renamed to "${renamed.get(ref)}"; no layer has the old name now. Repair it with fix_name_references or ae_batch_set.`,
      });
    }
  }
  return out;
}

// ---------- receipt checks ----------

interface Written extends Record<string, unknown> {
  action?: string;
  targets?: Array<{ id: number }>;
  applied_ids?: number[];
  moved_ids?: number[];
  parent_id?: number | null;
  order_after?: Array<number | null>;
  order_truncated?: boolean;
  duplicates?: Array<{ source_id: number; id: number; name: string }>;
  duplicates_total?: number;
  deleted?: Array<{ id: number; name: string }>;
  deleted_total?: number;
  trims?: Array<{ id: number; start_time: number; in_point: number; out_point: number }>;
  partial_ids?: number[];
  renames?: Array<{ id: number; from: string; to: string }>;
  changes?: Array<{ id: number; key: string; from: unknown; to: unknown }>;
  to_comp_id?: number;
  no_op?: boolean;
  to_item_id?: number;
  replacements?: Array<{ id: number; from_item_id: number; to_item_id: number; size_changed?: boolean; scale_compensated?: boolean; anchor_compensated?: boolean }>;
  separations?: Array<{ id: number; from: boolean; to: boolean; position_keys?: number }>;
  splits?: Array<{
    id: number;
    name?: string;
    original_out?: number;
    first_part_out?: number;
    copies: Array<{ id: number; in_point: number; out_point: number }>;
  }>;
  solid_results?: Array<{
    from_item_id: number;
    item_id?: number;
    scope: string;
    layer_ids: number[];
    width?: number;
    height?: number;
    color?: number[];
    name?: string;
  }>;
  /** Ids unlocked for the edit, and the ids the host relocked afterwards. */
  unlocked?: number[];
  relocked?: number[];
}

/** The switch each `switches` key lands in on a read-back layer. */
const SWITCH_FIELD: Record<string, keyof OpsLayer> = {
  shy: "shy",
  solo: "solo",
  locked: "locked",
  guide: "guide",
  enabled: "enabled",
  collapse_transformations: "collapse",
  three_d: "threeD",
  motion_blur: "motionBlur",
  quality: "quality",
  sampling_quality: "samplingQuality",
  blend_mode: "blendMode",
  label_color: "label",
  effects_active: "effectsActive",
  preserve_transparency: "preserveTransparency",
  adjustment: "adjustment",
  audio_enabled: "audioEnabled",
  frame_blending: "frameBlending",
  three_d_per_char: "threeDPerChar",
  environment: "environment",
  auto_orient: "autoOrient",
  comment: "comment",
  stretch: "stretch",
};

/** The fields of a layer no action here changes by itself: if one differs, the write touched a layer it shouldn't have. */
const BYSTANDER_FIELDS = [
  "name", "enabled", "shy", "solo", "locked", "label", "guide", "threeD", "motionBlur", "blendMode",
  "effectsActive", "preserveTransparency", "adjustment", "audioEnabled", "frameBlending", "threeDPerChar", "environment", "autoOrient", "comment", "stretch",
] as const;

/** Numbers compare with a small tolerance (stretch reads back as 100.00000001), the rest strictly. */
function sameSwitch(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= 1e-3;
  return a === b;
}

export function layerOpsMismatches(args: Pick<OpsArgs, "action" | "locked">, beforeRaw: unknown, afterRaw: unknown, w: Written): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const before = stackOf(beforeRaw);
  const after = stackOf(afterRaw);
  if (!before || !after || w.no_op) return m;
  const complete = !capped(before) && !capped(after);
  const touched = new Set<number>();
  for (const t of w.targets ?? []) touched.add(t.id);
  for (const d of w.duplicates ?? []) touched.add(d.id);
  if (typeof w.parent_id === "number") touched.add(w.parent_id);

  const grew = ((w.action === "duplicate" && w.to_comp_id === undefined) || w.action === "split" ? (w.duplicates_total ?? w.duplicates?.length ?? 0) : 0) - (w.action === "delete" ? (w.deleted_total ?? w.deleted?.length ?? 0) : 0);
  expectThat(m, after.numLayers === before.numLayers + grew, "numLayers", before.numLayers + grew, after.numLayers, "Layer count is not what the action should leave");

  if (args.action === "parent") {
    for (const id of w.applied_ids ?? []) {
      const l = byId(after, id);
      if (!l) {
        if (!complete) continue;
        m.push({ path: `layer[${id}]`, expected: "present", actual: undefined, message: "A re-parented layer is not in the read-back" });
        continue;
      }
      if (w.parent_id === null || w.parent_id === undefined) {
        expectThat(m, l.parent === null, `layer[${l.name}].parent`, null, l.parent, "The layer still has a parent");
      } else {
        const p = byId(after, w.parent_id);
        if (p || complete) expectThat(m, p !== undefined && l.parent === p.index, `layer[${l.name}].parent`, p?.index, l.parent, "Parent differs");
      }
    }
  }

  if (args.action === "reorder" || args.action === "sort") {
    const want = w.order_after ?? [];
    const got = after.layers.map((l) => l.id);
    const n = Math.min(want.length, got.length, 500);
    const same = want.slice(0, n).every((id, i) => id === got[i]);
    expectThat(m, same, "order", want.slice(0, n), got.slice(0, n), "The layer order is not what the action planned");
  }

  if (args.action === "duplicate") {
    const target = w.to_comp_id !== undefined ? after.with_comp : after;
    const targetBefore = w.to_comp_id !== undefined ? before.with_comp : before;
    for (const d of w.duplicates ?? []) {
      const l = byId(target ?? null, d.id);
      if (!l && !capped(target ?? null)) m.push({ path: `duplicate[${d.id}]`, expected: "present", actual: undefined, message: "A copy is not in the read-back" });
    }
    if (w.to_comp_id !== undefined) {
      const want = (targetBefore?.numLayers ?? 0) + (w.duplicates_total ?? w.duplicates?.length ?? 0);
      expectThat(m, target !== undefined && targetBefore !== undefined && target.numLayers === want, "to_comp.numLayers", want, target?.numLayers, "The destination comp did not grow by the copies");
    }
  }

  if (args.action === "delete") {
    for (const d of w.deleted ?? []) {
      if (complete) expectThat(m, byId(after, d.id) === undefined, `deleted[${d.id}]`, "gone", "still there", `"${d.name}" is still in the comp`);
    }
  }

  if (args.action === "trim") {
    const tol = (after.frameDuration ?? 0.05) * 1.01 + 1e-6;
    const near = (a: number | undefined, b: number | undefined) => a !== undefined && b !== undefined && Math.abs(a - b) <= tol;
    for (const t of w.trims ?? []) {
      if (!w.applied_ids?.includes(t.id)) {
        // Skipped or half applied: every time must still be the planned one or the one it had.
        const lb = byId(before, t.id);
        const la = byId(after, t.id);
        if (!la || !lb) continue;
        const pairs: Array<[string, number | undefined, number | undefined, number]> = [
          ["startTime", la.startTime, lb.startTime, t.start_time],
          ["inPoint", la.inPoint, lb.inPoint, t.in_point],
          ["outPoint", la.outPoint, lb.outPoint, t.out_point],
        ];
        for (const [field, got, was, planned] of pairs) {
          if (got === undefined || was === undefined) continue;
          if (!near(got, was) && !near(got, planned)) {
            m.push({ path: `layer[${la.name}].${field}`, expected: was, actual: got, message: `"${la.name}" was reported as not trimmed but its ${field} changed` });
          }
        }
        if (w.partial_ids?.includes(t.id)) {
          m.push({ path: `layer[${la.name}]`, expected: "untouched", actual: "partly trimmed", message: `AE refused part of the trim of "${la.name}" and the layer could not be put back; check its times` });
        }
        continue;
      }
      const l = byId(after, t.id);
      if (!l) continue;
      if (l.startTime !== undefined) expectThat(m, Math.abs(l.startTime - t.start_time) <= tol, `layer[${l.name}].startTime`, t.start_time, l.startTime, "Start time differs (AE did not take it, or clamped it)");
      if (l.inPoint !== undefined) expectThat(m, Math.abs(l.inPoint - t.in_point) <= tol, `layer[${l.name}].inPoint`, t.in_point, l.inPoint, "In point differs (AE clamps it to the source)");
      if (l.outPoint !== undefined) expectThat(m, Math.abs(l.outPoint - t.out_point) <= tol, `layer[${l.name}].outPoint`, t.out_point, l.outPoint, "Out point differs (AE clamps it to the source)");
    }
  }

  if (args.action === "rename") {
    for (const r of w.renames ?? []) {
      if (!w.applied_ids?.includes(r.id)) continue;
      const l = byId(after, r.id);
      if (l) expectThat(m, l.name === r.to, `layer[${r.id}].name`, r.to, l.name, "Name differs");
    }
  }

  if (args.action === "switches") {
    for (const c of w.changes ?? []) {
      const l = byId(after, c.id);
      const field = SWITCH_FIELD[c.key];
      if (!l || !field) continue;
      expectThat(m, sameSwitch(l[field], c.to), `layer[${l.name}].${c.key}`, c.to, l[field], "Switch differs");
    }
  }

  if (args.action === "replace_source") {
    for (const r of w.replacements ?? []) {
      if (!w.applied_ids?.includes(r.id)) continue;
      const l = byId(after, r.id);
      if (l) expectThat(m, l.sourceId === r.to_item_id, `layer[${l.name}].sourceId`, r.to_item_id, l.sourceId, "The layer's source is not the new item");
    }
  }

  if (args.action === "separate_dimensions") {
    for (const s of w.separations ?? []) {
      if (!w.applied_ids?.includes(s.id)) continue;
      const l = byId(after, s.id);
      if (!l) continue;
      expectThat(m, l.positionSeparated === s.to, `layer[${l.name}].positionSeparated`, s.to, l.positionSeparated, "Position is not in the separation state asked for");
      if (s.to && (s.position_keys ?? 0) > 0 && Array.isArray(l.followerKeys) && l.followerKeys.length > 0) {
        expectThat(m, l.followerKeys.some((n) => n > 0), `layer[${l.name}].followerKeys`, "keys on the followers", l.followerKeys, "Position had keyframes but the separated followers hold none");
      }
    }
  }

  if (args.action === "split") {
    const tol = (after.frameDuration ?? 0.05) * 1.01 + 1e-6;
    for (const sp of w.splits ?? []) {
      const orig = byId(after, sp.id);
      if (!orig || sp.copies.length === 0) continue;
      if (sp.first_part_out !== undefined && orig.outPoint !== undefined) {
        expectThat(m, Math.abs(orig.outPoint - sp.first_part_out) <= tol, `layer[${orig.name}].outPoint`, sp.first_part_out, orig.outPoint, "The first part does not end at the first cut");
      }
      for (const c of sp.copies) {
        const copy = byId(after, c.id);
        if (!copy) {
          if (!capped(after)) m.push({ path: `split[${c.id}]`, expected: "present", actual: undefined, message: "A new part is not in the read-back" });
          continue;
        }
        if (copy.inPoint !== undefined) expectThat(m, Math.abs(copy.inPoint - c.in_point) <= tol, `layer[${copy.name}].inPoint`, c.in_point, copy.inPoint, "A new part does not start at its cut");
        if (copy.outPoint !== undefined) expectThat(m, Math.abs(copy.outPoint - c.out_point) <= tol, `layer[${copy.name}].outPoint`, c.out_point, copy.outPoint, "A new part does not end where the next one starts");
        expectThat(m, copy.index < orig.index, `layer[${copy.name}].index`, `above ${orig.index}`, copy.index, "A later part should sit above the original");
      }
    }
  }

  if (args.action === "solid_settings") {
    for (const r of w.solid_results ?? []) {
      for (const id of r.layer_ids) {
        const l = byId(after, id);
        if (!l) continue;
        const where = `layer[${l.name}]`;
        if (r.item_id !== undefined) expectThat(m, l.sourceId === r.item_id, `${where}.sourceId`, r.item_id, l.sourceId, "The layer is not on the expected solid");
        if (r.width !== undefined && l.sourceWidth !== undefined) expectThat(m, l.sourceWidth === r.width, `${where}.sourceWidth`, r.width, l.sourceWidth, "Solid width differs");
        if (r.height !== undefined && l.sourceHeight !== undefined) expectThat(m, l.sourceHeight === r.height, `${where}.sourceHeight`, r.height, l.sourceHeight, "Solid height differs");
        if (r.name !== undefined && l.sourceName !== undefined) expectThat(m, l.sourceName === r.name, `${where}.sourceName`, r.name, l.sourceName, "Solid name differs");
        if (r.color !== undefined && l.solidColor !== undefined) {
          const close = r.color.every((c, i) => Math.abs(c - (l.solidColor?.[i] ?? NaN)) <= 1e-3);
          expectThat(m, close, `${where}.solidColor`, r.color, l.solidColor, "Solid colour differs");
        }
      }
    }
  }

  // Layers unlocked for the edit must be locked again, unless the call asked for them unlocked or they are gone.
  // The exemptions come from the call's args and the full read-back, not from the host's capped report lists.
  if (!(args.action === "switches" && args.locked === false)) {
    const gone = new Set((w.deleted ?? []).map((d) => d.id));
    const MAX_RELOCK_MISMATCHES = 50;
    let reported = 0;
    let more = 0;
    for (const id of w.unlocked ?? []) {
      const l = byId(after, id);
      if (gone.has(id) || (complete && !l)) continue;
      const before = m.length;
      if (!(w.relocked ?? []).includes(id)) {
        m.push({ path: `layer[${id}].locked`, expected: true, actual: "not relocked", message: "A layer unlocked for the edit was not reported as locked again" });
      }
      if (l && l.locked !== undefined) expectThat(m, l.locked === true, `layer[${l.name}].locked`, true, l.locked, "A layer unlocked for the edit is still unlocked");
      if (m.length > before) {
        if (reported >= MAX_RELOCK_MISMATCHES) {
          m.length = before;
          more++;
        } else {
          reported++;
        }
      }
    }
    if (more > 0) m.push({ path: "locked", expected: true, actual: "not relocked", message: `${more} more unlocked layers were not locked again` });
  }

  // Layers the action did not name must come out as they went in.
  // Renaming a shared solid item renames the layers that follow its name, so their name is not compared.
  const renamedItems = new Set<number>();
  for (const r of w.solid_results ?? []) {
    if (r.scope === "item" && r.name !== undefined) renamedItems.add(r.from_item_id);
  }
  if (complete) {
    for (const l of after.layers) {
      if (touched.has(l.id)) continue;
      const was = byId(before, l.id);
      if (!was) continue;
      for (const f of BYSTANDER_FIELDS) {
        if (f === "name" && was.sourceId !== undefined && renamedItems.has(was.sourceId)) continue;
        if (was[f] !== undefined && l[f] !== undefined && was[f] !== l[f]) {
          m.push({ path: `layers[${l.name}].${f}`, expected: was[f], actual: l[f], message: `"${l.name}" was not part of the action but its ${f} changed` });
        }
      }
    }
  }
  return m;
}

// ---------- tool ----------

const STRUCTURAL: ReadonlyArray<OpsArgs["action"]> = ["reorder", "sort", "duplicate", "delete", "rename", "split"];

/** Actions that can take a long time in AE (a replaceSource per layer, a duplicate per cut). The wait is longer; the evalScript is never aborted. */
const SLOW_ACTIONS: ReadonlyArray<OpsArgs["action"]> = ["replace_source", "split", "solid_settings"];

const uniq = (v: Array<number | undefined | null>): number[] => [...new Set(v.filter((n): n is number => typeof n === "number"))].slice(0, 50);

function selectorRefs(sels: Array<LayerSelector | undefined>): { ids: number[]; indexes: number[] } {
  const ids: Array<number | undefined> = [];
  const indexes: Array<number | undefined> = [];
  for (const s of sels) {
    if (!s) continue;
    ids.push(s.id);
    indexes.push(s.index);
  }
  return { ids: uniq(ids), indexes: uniq(indexes) };
}

/** A read of the comp: layers, and the comp's expressions when the action can move layer(index) references. */
function opsRead(args: OpsArgs, extraIds: Array<number | undefined | null> = [], phase: "before" | "after" = "before") {
  const refs = selectorRefs([...(args.layers ?? []), args.parent, args.relative_to]);
  const call: Record<string, unknown> = { comp_id: args.comp_id };
  // The after scan is only used by rename (name references left behind); the other actions judge from the before text.
  if (STRUCTURAL.includes(args.action) && (phase === "before" || args.action === "rename")) call.scan_expressions = true;
  if (args.to_comp_id !== undefined) call.with_comp_id = args.to_comp_id;
  const ids = uniq([...refs.ids, ...extraIds]);
  if (ids.length) call.include_ids = ids;
  if (refs.indexes.length) call.include_indexes = refs.indexes;
  return { host: "layeropsRead", args: call };
}

/** The host's arguments: everything the action takes, without the tool-only flags. */
function hostArgs(args: OpsArgs): Record<string, unknown> {
  const { dry_run: _dry, expect: _expect, ...rest } = args;
  return rest;
}

const compact = (stack: OpsStack | null) =>
  stack && {
    numLayers: stack.numLayers,
    truncated: capped(stack) || undefined,
    layers: stack.layers.map((l) => ({ index: l.index, id: l.id, name: l.name, kind: l.kind, parent: l.parent })),
  };

async function dryRun(args: OpsArgs, ctx: ToolContext) {
  const label = `ae_layer_ops(${args.action}, dry run)`;
  const base = { mutates: false, toolName: "ae_layer_ops" };
  const read = opsRead(args);
  const beforeRes = await ctx.bridge.callHost<OpsStack>(read.host, read.args, { label: `${label} (read)`, ...base });
  const planRes = await ctx.bridge.callHost<Written>("layeropsPlan", hostArgs(args), { label, ...base });
  const plan = planRes.result;
  const before = stackOf(beforeRes.result);
  let would_break: ExpressionWarning[] | undefined;
  if (before && Array.isArray(plan.order_after)) {
    const map = indexMapFromOrder(before, plan.order_after, plan.order_truncated === true);
    const nameOf = new Map(before.layers.map((l) => [l.id, l.name]));
    would_break = indexReferenceWarnings(before, map, (index) => {
      const id = plan.order_after![index - 1];
      return typeof id === "number" ? { layer_id: id, layer_name: nameOf.get(id) ?? "" } : undefined;
    });
  }
  if (before && plan.to_comp_id !== undefined && before.with_comp) {
    // Copies land on top of the destination: every layer there moves down by the number of copies.
    const dest = before.with_comp;
    const copies = Number((plan as { would_change?: unknown }).would_change ?? 0) || 0;
    const skippedIds = new Set(((plan as { skipped?: Array<{ id?: number }> }).skipped ?? []).map((x) => x.id));
    const map: IndexMap = new Map();
    for (const l of dest.layers) map.set(l.id, l.index + copies);
    const byIndex = new Map(dest.layers.map((l) => [l.index + copies, l]));
    would_break = [
      ...indexReferenceWarnings(dest, map, (index) => {
        if (index <= copies) return { layer_id: 0, layer_name: "(a copy)" };
        const l = byIndex.get(index);
        return l ? { layer_id: l.id, layer_name: l.name } : undefined;
      }),
      ...copiedToCompWarnings({ ...before, with_comp: undefined }, before, {
        ...plan,
        duplicates: (plan.targets ?? [])
          .filter((t) => !skippedIds.has(t.id))
          .map((t) => ({ source_id: t.id, id: 0, name: "" })),
      }),
    ].slice(0, MAX_WARNINGS);
  }
  return {
    ...plan,
    dry_run: true,
    stack: compact(before),
    would_break_expressions: would_break,
    expressions_scanned: before?.expressions ? before.expressions.length : undefined,
    expressions_truncated: before?.expressions_truncated || undefined,
    note: "Nothing was changed. Run the same call without dry_run to apply it.",
  };
}

/**
 * duplicate into another comp: the copies land on top there and push every layer
 * down, so the destination's layer(index) references can read another layer; and
 * the copies' own layer(...) references now resolve against the destination.
 */
export function copiedToCompWarnings(before: OpsStack, after: OpsStack, w: Written): ExpressionWarning[] {
  const out: ExpressionWarning[] = [];
  const destBefore = before.with_comp;
  const destAfter = after.with_comp;
  if (destBefore && destAfter) {
    const map = indexMapFromStack(destBefore, destAfter);
    const byIndex = new Map(destAfter.layers.map((l) => [l.index, l]));
    out.push(
      ...indexReferenceWarnings(destBefore, map, (index) => {
        const l = byIndex.get(index);
        return l ? { layer_id: l.id, layer_name: l.name } : undefined;
      })
    );
  }
  const copied = new Set((w.duplicates ?? []).map((d) => d.source_id));
  for (const ex of before.expressions ?? []) {
    if (!copied.has(ex.layer_id) || !ex.enabled) continue;
    if (ex.text_truncated) out.push(partialScanWarning(ex));
    const refs = [...findIndexReferences(ex.text).map((r) => r.text), ...findNameReferences(ex.text).map((n) => `layer("${n}")`)];
    for (const reference of refs) {
      if (out.length >= MAX_WARNINGS) return out;
      out.push({
        layer_id: ex.layer_id,
        layer_name: ex.layer_name,
        path: ex.path,
        kind: "copied_reference",
        reference,
        message: `${reference} on "${ex.layer_name}" was copied to the destination comp, where it reads that comp's layers, not the ones it meant here. Check the copy.`,
      });
    }
  }
  return out.slice(0, MAX_WARNINGS);
}

export const layeropsTools: ToolDefinition<any>[] = [
  {
    name: "ae_layer_ops",
    description:
      "Everyday layer edits in one call: action parent (assigns layer.parent, so the child keeps its on-screen position; keep_position false uses setParentWithJump and the layer jumps), " +
      "reorder (beginning, end, before or after a layer), sort (by name, start time, in or out point, z, label), duplicate (in place, or copyToComp into another comp), delete, " +
      "trim (in point, out point, start time), rename (find and replace, or a template with a padded counter), " +
      "switches (shy, solo, locked, guide, enabled, collapse transformations, 3D, motion blur, quality, sampling quality, blend mode, label colour, " +
      "effects_active, preserve_transparency, adjustment, audio_enabled, frame_blending none/frame_mix/pixel_motion, three_d_per_char, environment, auto_orient, comment, and stretch (time stretch in percent: 100 is none, negative reverses, never between -1 and 1)), " +
      "replace_source (item_id: swap the source of the layers for another footage or comp item, keeping keys, effects, masks and timing; refuses nulls, text, shapes, cameras, lights and comp cycles; keep_size compensates Scale and also scales a plain Anchor Point by new size / old size so the content stays in place (a keyframed or expression-driven Anchor Point keeps its numbers, with a warning); slow on many layers), " +
      "separate_dimensions (enable: separate Position into X/Y/Z or unify; afterwards Position is written through 'ADBE Position_0/_1/_2'), " +
      "split (time or times: cuts each layer in two or more parts the way the Timeline's Split Layer does, with the later part above; warns about time remap, track mattes, children and moved layer(index) references) and " +
      "solid_settings (colour, width, height, name of a solid: scope item changes the shared solid and every layer using it, scope layer_only gives the selected layers a new solid of their own). " +
      "Pick the layers with `layers` and/or `where` (label, kind, name part, switches). Layer types a switch does not fit (cameras and lights have no motion blur, 3D is always on) are skipped and listed, not errors. " +
      "Locked layers are refused unless unlock_locked is true, which unlocks and relocks them in the same undo group. " +
      "dry_run returns the plan with nothing written. " +
      "AE does not rewrite layer(3) in expressions when layers move and never reports it: reorder, sort, duplicate, delete and rename read every expression in the comp before and after and return expression_warnings for index references that now read another layer (and name references left behind by a rename), with a suggested rewrite. " +
      "The write is one undo group guarded by `expect`; the read-back (a separate evalScript) checks parents, order, counts, times, names and switches, and that other layers did not change, and returns the stack before and after. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeLayerOpsSchema,
    handler: async (args: OpsArgs, ctx) => {
      if (args.dry_run) return dryRun(args, ctx);
      return runGuardedWrite<Written>(ctx, {
        toolName: "ae_layer_ops",
        label: `ae_layer_ops(${args.action})`,
        expect: args.expect,
        compId: args.comp_id,
        read: (phase, w) => {
          if (phase === "before") return opsRead(args);
          const ids: Array<number | null | undefined> = [];
          for (const t of w?.targets ?? []) ids.push(t.id);
          for (const d of w?.duplicates ?? []) ids.push(d.id);
          ids.push(w?.parent_id);
          return opsRead(args, ids, "after");
        },
        write: {
          host: "layeropsApply",
          args: { ...hostArgs(args), label: `Layer ops: ${args.action}` },
          timeoutMs: SLOW_ACTIONS.includes(args.action) ? SLOW_TIMEOUT_MS : undefined,
        },
        check: (before, after, w) => layerOpsMismatches(args, before, after, w),
        present: (beforeRaw, afterRaw, w) => {
          const before = stackOf(beforeRaw);
          const after = stackOf(afterRaw);
          let expression_warnings: ExpressionWarning[] = [];
          if (before && after && !w.no_op && STRUCTURAL.includes(args.action)) {
            const map = indexMapFromStack(before, after);
            const byIndex = new Map(after.layers.map((l) => [l.index, l]));
            expression_warnings = indexReferenceWarnings(before, map, (index) => {
              const l = byIndex.get(index);
              return l ? { layer_id: l.id, layer_name: l.name } : undefined;
            });
            if (args.action === "rename") expression_warnings.push(...nameReferenceWarnings(after, w.renames ?? []));
            if (args.action === "duplicate" && args.to_comp_id !== undefined) {
              expression_warnings.push(...copiedToCompWarnings(before, after, w));
            }
          }
          const { order_after: _order, ...rest } = w;
          return {
            ...rest,
            stack_before: compact(before),
            stack_after: compact(after),
            expression_warnings,
            expressions_truncated: before?.expressions_truncated || undefined,
          };
        },
      });
    },
  },
];
