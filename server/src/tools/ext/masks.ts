/**
 * server/src/tools/ext/masks.ts
 *
 * - ae_mask: add (rectangle, ellipse, free path), change, duplicate, reorder
 *   and remove a layer's masks: mode, inversion, feather, opacity, expansion,
 *   feather falloff, motion blur, colour, lock and RotoBezier
 * - ae_text_animator: add a text animator with any animator property, range,
 *   wiggly and expression selectors, variable font axes (AE 26) and More
 *   Options grouping, and optionally a keyframed reveal of a range selector
 * Both are guarded writes with a read-back in a separate evalScript.
 */

import { z } from "zod";
import type { ReceiptMismatch } from "../../receipts.js";
import { compareValues } from "../../receipts.js";
import { AGENT_SAFETY_GUIDANCE, ExpectSchema, LayerSelectorSchema, type ToolDefinition } from "../common.js";
import { expectThat, runGuardedWrite } from "./write-runner.js";

const Vec2 = z.array(z.number()).length(2);
const MODES = ["add", "subtract", "intersect", "lighten", "darken", "difference", "none"] as const;

const MaskFields = {
  name: z.string().min(1).max(200).optional(),
  shape: z.enum(["rect", "ellipse", "path"]).optional().describe("A new path: a rectangle or ellipse in `box`, or a free path."),
  box: z.array(z.number()).length(4).optional().describe("rect and ellipse: [left, top, width, height] in layer pixels."),
  vertices: z.array(Vec2).min(2).max(1000).optional().describe("path: the points in layer pixels."),
  in_tangents: z.array(Vec2).optional(),
  out_tangents: z.array(Vec2).optional(),
  closed: z.boolean().optional(),
  mode: z.enum(MODES).optional().describe("Default for a new mask: add."),
  inverted: z.boolean().optional(),
  feather: Vec2.optional().describe("[x, y] in pixels."),
  opacity: z.number().min(0).max(100).optional(),
  expansion: z.number().optional().describe("Pixels; negative shrinks."),
  feather_falloff: z.enum(["linear", "smooth"]).optional().describe("Feather falloff: smooth or linear (MaskPropertyGroup.maskFeatherFalloff). Reported in `unsupported` when this After Effects has no such member."),
  motion_blur: z.enum(["same_as_layer", "on", "off"]).optional().describe("The mask's motion blur setting (MaskPropertyGroup.maskMotionBlur)."),
  color: z.array(z.number().min(0).max(1)).length(3).optional().describe("The mask outline colour in the comp view, [r, g, b] 0 to 1."),
  locked: z.boolean().optional().describe("Lock the mask. In a change, `locked: false` unlocks it before the other edits and `true` locks it after them; a locked mask is unlocked for the edit and locked again afterwards."),
  roto_bezier: z.boolean().optional().describe("RotoBezier on or off. Turning it on makes After Effects recompute the tangents from the vertices (a warning says so)."),
};

function shapeRules<T extends { shape?: string; box?: number[]; vertices?: unknown[]; in_tangents?: unknown[]; out_tangents?: unknown[] }>(v: T, ctx: z.RefinementCtx) {
  const need = (ok: boolean, message: string) => ok || ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if (v.shape === "rect" || v.shape === "ellipse") need(v.box !== undefined, `${v.shape} needs box.`);
  if (v.shape === "path") need(v.vertices !== undefined, "path needs vertices.");
  const n = v.vertices?.length ?? 0;
  need(v.in_tangents === undefined || v.in_tangents.length === n, "in_tangents needs one entry per vertex.");
  need(v.out_tangents === undefined || v.out_tangents.length === n, "out_tangents needs one entry per vertex.");
}

// A change to an existing mask: the path fields mean nothing without a shape, and the host would drop them.
function setRules(v: { shape?: string; box?: number[]; vertices?: unknown[]; in_tangents?: unknown[]; out_tangents?: unknown[]; closed?: boolean }, ctx: z.RefinementCtx) {
  shapeRules(v, ctx);
  if (!v.shape && (v.box !== undefined || v.vertices !== undefined || v.in_tangents !== undefined || v.out_tangents !== undefined || v.closed !== undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "box, vertices, tangents and closed change a mask's path only together with shape (rect, ellipse or path)." });
  }
}

const MaskSelector = z
  .object({ index: z.number().int().positive().optional(), name: z.string().min(1).optional() })
  .refine((s) => s.index !== undefined || s.name !== undefined, { message: "Mask selector needs index or name." });

export const AeMaskSchema = z
  .object({
    comp_id: z.number().int(),
    layer: LayerSelectorSchema,
    add: z.array(z.object(MaskFields).superRefine((v, ctx) => {
      shapeRules(v, ctx);
      if (!v.shape) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A new mask needs a shape." });
    })).max(50).optional(),
    set: z.array(z.object({ mask: MaskSelector, ...MaskFields }).superRefine(setRules)).max(50).optional().describe("Change existing masks."),
    remove: z.array(MaskSelector).max(50).optional(),
    duplicate: z
      .array(z.object({ mask: MaskSelector, count: z.number().int().min(1).max(50).default(1).describe("How many copies. Default 1.") }))
      .max(20)
      .optional()
      .describe("Copy masks (PropertyBase.duplicate). Selectors mean the masks as they are before the call; the result's `duplicated` lists where each copy landed and its name."),
    move_to: z
      .array(z.object({ mask: MaskSelector, index: z.number().int().positive().describe("The new position, 1 is the top of the mask list.") }))
      .max(50)
      .optional()
      .describe("Reorder masks (PropertyBase.moveTo), after removals and copies and before new masks are added. Masks stack in list order."),
    expect: ExpectSchema,
  })
  .refine((v) => (v.add?.length ?? 0) + (v.set?.length ?? 0) + (v.remove?.length ?? 0) + (v.duplicate?.length ?? 0) + (v.move_to?.length ?? 0) > 0, {
    message: "Give masks to add, set, remove, duplicate or move_to.",
  });

// ---------- text animator schema ----------

type ValueKind = "num" | "vec2" | "vec3" | "color" | "any";

interface AnimProp {
  /** The documented match name (the host tries fallbacks for the few the Guide leaves unclear). */
  match: string;
  kind: ValueKind;
  min?: number;
  max?: number;
  text: string;
}

// Every animator property the tool writes, by key. The match names come from the Guide's text match-name table (live probe: Track Type and Character Change Type).
const ANIM_PROPS: Record<string, AnimProp> = {
  anchor_point: { match: "ADBE Text Anchor Point 3D", kind: "vec3", text: "[x, y] or [x, y, z]." },
  position: { match: "ADBE Text Position 3D", kind: "vec3", text: "[x, y] or [x, y, z] offset in pixels." },
  scale: { match: "ADBE Text Scale 3D", kind: "vec3", text: "[x, y] or [x, y, z] in percent." },
  skew: { match: "ADBE Text Skew", kind: "num", text: "Degrees." },
  skew_axis: { match: "ADBE Text Skew Axis", kind: "num", text: "Degrees." },
  rotation_x: { match: "ADBE Text Rotation X", kind: "num", text: "X rotation in degrees (per-character 3D)." },
  rotation_y: { match: "ADBE Text Rotation Y", kind: "num", text: "Y rotation in degrees (per-character 3D)." },
  rotation: { match: "ADBE Text Rotation", kind: "num", text: "Z rotation in degrees." },
  opacity: { match: "ADBE Text Opacity", kind: "num", min: 0, max: 100, text: "Percent." },
  fill_opacity: { match: "ADBE Text Fill Opacity", kind: "num", min: 0, max: 100, text: "Percent." },
  fill_color: { match: "ADBE Text Fill Color", kind: "color", text: "[r, g, b] or [r, g, b, a], 0 to 1." },
  fill_hue: { match: "ADBE Text Fill Hue", kind: "num", text: "Degrees." },
  fill_saturation: { match: "ADBE Text Fill Saturation", kind: "num", text: "Percent offset." },
  fill_brightness: { match: "ADBE Text Fill Brightness", kind: "num", text: "Percent offset." },
  stroke_opacity: { match: "ADBE Text Stroke Opacity", kind: "num", min: 0, max: 100, text: "Percent." },
  stroke_color: { match: "ADBE Text Stroke Color", kind: "color", text: "[r, g, b] or [r, g, b, a], 0 to 1." },
  stroke_hue: { match: "ADBE Text Stroke Hue", kind: "num", text: "Degrees." },
  stroke_saturation: { match: "ADBE Text Stroke Saturation", kind: "num", text: "Percent offset." },
  stroke_brightness: { match: "ADBE Text Stroke Brightness", kind: "num", text: "Percent offset." },
  stroke_width: { match: "ADBE Text Stroke Width", kind: "num", text: "Pixels." },
  tracking_type: { match: "ADBE Text Track Type", kind: "num", text: "The Tracking Type menu index as in After Effects (1 is Before & After); the host falls back to ADBE Text Tracking Type." },
  tracking: { match: "ADBE Text Tracking Amount", kind: "num", text: "Tracking amount." },
  line_anchor: { match: "ADBE Text Line Anchor", kind: "num", text: "Percent." },
  line_spacing: { match: "ADBE Text Line Spacing", kind: "vec2", text: "[x, y] in pixels." },
  character_alignment: { match: "ADBE Text Character Change Type", kind: "any", text: "Character Alignment (a number or [x, y]); the host tries ADBE Text Character Change Type, then two older guesses." },
  character_range: { match: "ADBE Text Character Range", kind: "any", text: "Character Range menu index; match name unconfirmed, the host tries two names." },
  character_value: { match: "ADBE Text Character Replace", kind: "any", text: "Character Value (a Unicode value)." },
  character_offset: { match: "ADBE Text Character Offset", kind: "any", text: "Character Offset (steps through the character set)." },
  variable_font_spacing: { match: "ADBE Text Variable Font Spacing", kind: "num", text: "Variable Font Spacing." },
  blur: { match: "ADBE Text Blur", kind: "vec2", text: "[x, y] in pixels." },
};

function valueSchema(def: AnimProp): z.ZodTypeAny {
  if (def.kind === "num") {
    let n = z.number();
    if (def.min !== undefined) n = n.min(def.min);
    if (def.max !== undefined) n = n.max(def.max);
    return n;
  }
  if (def.kind === "vec2") return Vec2;
  if (def.kind === "vec3") return z.array(z.number()).min(2).max(3);
  if (def.kind === "color") return z.array(z.number().min(0).max(1)).min(3).max(4);
  return z.union([z.number(), z.array(z.number()).min(1).max(4)]);
}

const AnimatorProperties = z.object(
  Object.fromEntries(Object.entries(ANIM_PROPS).map(([key, def]) => [key, valueSchema(def).optional().describe(def.text)]))
);

const BASED_ON: Record<string, number> = { characters: 1, characters_excluding_spaces: 2, words: 3, lines: 4 };
const SHAPES: Record<string, number> = { square: 1, ramp_up: 2, ramp_down: 3, triangle: 4, round: 5, smooth: 6 };
const SEL_MODES: Record<string, number> = { add: 1, subtract: 2, intersect: 3, min: 4, max: 5, difference: 6 };
const SEL_UNITS: Record<string, number> = { percentage: 1, index: 2 };
const GROUPING: Record<string, number> = { character: 1, word: 2, line: 3, all: 4 };
const ENUMS: Record<string, Record<string, number>> = { based_on: BASED_ON, shape: SHAPES, mode: SEL_MODES, units: SEL_UNITS };

const BASED_ON_ENUM = z.enum(["characters", "characters_excluding_spaces", "words", "lines"]);
const SEL_MODE_ENUM = z.enum(["add", "subtract", "intersect", "min", "max", "difference"]);

const SELECTOR_KEYS = {
  range: ["start", "end", "offset", "units", "based_on", "mode", "amount", "shape", "smoothness", "ease_high", "ease_low", "randomize", "random_seed"],
  wiggly: ["mode", "max_amount", "min_amount", "based_on", "wiggles_per_second", "correlation", "temporal_phase", "spatial_phase", "lock_dimensions", "random_seed"],
  expression: ["based_on", "expression"],
} as const;

const SelectorBase = z.object({
  type: z.enum(["range", "wiggly", "expression"]).optional().describe("range (default), wiggly or expression. Each type takes its own fields."),
  // range
  start: z.number().min(0).optional().describe("range: percent (or an index with units index)."),
  end: z.number().min(0).optional().describe("range: percent (or an index with units index)."),
  offset: z.number().optional().describe("range: -100 to 100 percent (or index steps with units index)."),
  units: z.enum(["percentage", "index"]).optional().describe("range: whether start, end and offset are percent (default) or character/word/line indexes."),
  based_on: BASED_ON_ENUM.optional().describe("range, wiggly, expression: what the selector counts."),
  mode: SEL_MODE_ENUM.optional().describe("range and wiggly: how this selector combines with the ones above it."),
  amount: z.number().min(-100).max(100).optional().describe("range: Amount, percent."),
  shape: z.enum(["square", "ramp_up", "ramp_down", "triangle", "round", "smooth"]).optional().describe("range: the falloff shape."),
  smoothness: z.number().min(0).max(100).optional().describe("range: Smoothness, percent (square shape)."),
  ease_high: z.number().min(-100).max(100).optional(),
  ease_low: z.number().min(-100).max(100).optional(),
  randomize: z.boolean().optional().describe("range: Randomize Order."),
  random_seed: z.number().int().optional().describe("range (needs randomize: true) and wiggly: Random Seed."),
  // wiggly
  max_amount: z.number().min(-100).max(100).optional().describe("wiggly: Max Amount, percent."),
  min_amount: z.number().min(-100).max(100).optional().describe("wiggly: Min Amount, percent."),
  wiggles_per_second: z.number().min(0).optional().describe("wiggly: Wiggles/Second."),
  correlation: z.number().min(0).max(100).optional().describe("wiggly: Correlation, percent."),
  temporal_phase: z.number().optional().describe("wiggly: Temporal Phase, degrees."),
  spatial_phase: z.number().optional().describe("wiggly: Spatial Phase, degrees."),
  lock_dimensions: z.boolean().optional().describe("wiggly: Lock Dimensions."),
  // expression
  expression: z.string().min(1).max(20000).optional().describe("expression: the Amount expression (textIndex, textTotal, selectorValue are available)."),
});

type SelectorInput = z.infer<typeof SelectorBase>;

function selectorRules(sel: SelectorInput, ctx: z.RefinementCtx, where: string) {
  const type = sel.type ?? "range";
  const allowed: readonly string[] = SELECTOR_KEYS[type];
  const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  for (const [key, value] of Object.entries(sel)) {
    if (key === "type" || value === undefined) continue;
    if (!allowed.includes(key)) issue(`${where}: "${key}" does not belong to a ${type} selector (it takes ${allowed.join(", ")}).`);
  }
  if (type === "expression" && sel.expression === undefined) issue(`${where}: an expression selector needs \`expression\`.`);
  if (type === "range" && sel.random_seed !== undefined && sel.randomize !== true) issue(`${where}: random_seed needs randomize: true (After Effects hides Random Seed while Randomize Order is off).`);
  if (type === "range" && sel.units !== "index") {
    if (sel.start !== undefined && sel.start > 100) issue(`${where}: start is a percent (0 to 100) unless units is index.`);
    if (sel.end !== undefined && sel.end > 100) issue(`${where}: end is a percent (0 to 100) unless units is index.`);
    if (sel.offset !== undefined && (sel.offset < -100 || sel.offset > 100)) issue(`${where}: offset is -100 to 100 percent unless units is index.`);
  }
}

const SelectorSchema = SelectorBase.superRefine((v, ctx) => selectorRules(v, ctx, "selector"));

const GroupingSchema = z
  .object({
    anchor_point_grouping: z.enum(["character", "word", "line", "all"]).optional().describe("More Options > Anchor Point Grouping."),
    grouping_alignment: Vec2.optional().describe("More Options > Grouping Alignment, [x, y] in percent."),
    fill_and_stroke: z.number().int().min(1).max(3).optional().describe("More Options > Fill & Stroke, as the menu index (1 is Per Character Palette)."),
    inter_character_blending: z.number().int().min(1).max(40).optional().describe("More Options > Inter-Character Blending, as the menu index (1 is Normal)."),
  })
  .refine((g) => Object.values(g).some((v) => v !== undefined), { message: "Give at least one grouping field." });

const AxisSchema = z.object({
  tag: z.string().length(4).describe("The axis tag: wght, wdth, slnt, ital, opsz or a custom UPPERCASE tag. Checked against the layer's font."),
  value: z.number().describe("The axis value; checked against the font's axis range."),
});

export const AeTextAnimatorSchema = z
  .object({
    comp_id: z.number().int(),
    layer: LayerSelectorSchema.describe("A text layer."),
    name: z.string().min(1).max(200).optional(),
    properties: AnimatorProperties.optional().describe("What the animator does to the selected characters (offsets from their normal look): any of the text animator properties."),
    variable_axes: z
      .array(AxisSchema)
      .max(10)
      .optional()
      .describe("Variable font axes to animate (After Effects 26.0+). Each becomes an axis property on this animator. An axis the layer's font lacks is refused; with mixed fonts it applies only where the font has it, and the result says which."),
    selector: SelectorSchema.optional().describe("The first selector: a range selector by default, or type wiggly / expression. Without any selector a default range selector is added."),
    more_selectors: z.array(SelectorSchema).max(4).optional().describe("More selectors, added after `selector` (for example a wiggly selector on top of a range selector)."),
    grouping: GroupingSchema.optional().describe("The text layer's More Options (anchor point grouping, grouping alignment, fill & stroke, inter-character blending). These belong to the layer, not the animator."),
    reveal: z
      .object({
        property: z.enum(["start", "end", "offset"]).optional().describe("Default start."),
        from: z.number(),
        to: z.number(),
        start_time: z.number().min(0),
        duration: z.number().positive(),
      })
      .optional()
      .describe("Keyframe the first range selector over time, e.g. start 0 -> 100 for a character-by-character reveal with opacity 0."),
    expect: ExpectSchema,
  })
  .superRefine((v, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    const hasProps = v.properties !== undefined && Object.values(v.properties).some((x) => x !== undefined);
    if (!hasProps && (v.variable_axes?.length ?? 0) === 0) issue("Give at least one animator property.");
    const tags = (v.variable_axes ?? []).map((a) => a.tag);
    if (new Set(tags).size !== tags.length) issue("variable_axes lists a tag twice.");
    const selectors = [...(v.selector ? [v.selector] : []), ...(v.more_selectors ?? [])];
    if (v.reveal && selectors.length > 0 && !selectors.some((s) => (s.type ?? "range") === "range")) issue("reveal keys a range selector, and none was given.");
  });

// ---------- checks ----------

interface MaskState {
  count: number;
  truncated?: boolean;
  masks: Array<{
    index: number;
    name: string;
    mode: string | null;
    inverted: boolean;
    feather: number[] | null;
    opacity: number | null;
    expansion: number | null;
    vertices: number;
    closed?: boolean;
    box: number[] | null;
    feather_falloff?: string | null;
    motion_blur?: string | null;
    color?: number[] | null;
    locked?: boolean | null;
    roto_bezier?: boolean | null;
  }>;
}

type MaskSpec = Partial<z.infer<typeof AeMaskSchema>["add"] extends Array<infer T> | undefined ? T : never>;

const COLOR_TOLERANCE = 0.01;

function checkMask(m: ReceiptMismatch[], label: string, spec: MaskSpec, got: MaskState["masks"][number] | undefined) {
  if (!got) {
    m.push({ path: label, expected: spec.name ?? "mask", actual: undefined, message: `${label} is not in the read-back` });
    return;
  }
  if (spec.name) expectThat(m, got.name === spec.name, `${label}.name`, spec.name, got.name, "Mask name differs");
  if (spec.mode) expectThat(m, got.mode === spec.mode, `${label}.mode`, spec.mode, got.mode, "Mask mode differs");
  if (spec.inverted !== undefined) expectThat(m, got.inverted === spec.inverted, `${label}.inverted`, spec.inverted, got.inverted, "Inversion differs");
  if (spec.feather) compareValues(spec.feather, got.feather, `${label}.feather`, m);
  if (spec.opacity !== undefined) compareValues(spec.opacity, got.opacity, `${label}.opacity`, m);
  if (spec.expansion !== undefined) compareValues(spec.expansion, got.expansion, `${label}.expansion`, m);
  // The attributes below read null when this After Effects has no such member (the write reports them in `unsupported`).
  if (spec.feather_falloff && got.feather_falloff != null) expectThat(m, got.feather_falloff === spec.feather_falloff, `${label}.feather_falloff`, spec.feather_falloff, got.feather_falloff, "Feather falloff differs");
  if (spec.motion_blur && got.motion_blur != null) expectThat(m, got.motion_blur === spec.motion_blur, `${label}.motion_blur`, spec.motion_blur, got.motion_blur, "Mask motion blur differs");
  if (spec.locked !== undefined && got.locked != null) expectThat(m, got.locked === spec.locked, `${label}.locked`, spec.locked, got.locked, "Lock state differs");
  if (spec.roto_bezier !== undefined && got.roto_bezier != null) expectThat(m, got.roto_bezier === spec.roto_bezier, `${label}.roto_bezier`, spec.roto_bezier, got.roto_bezier, "RotoBezier differs");
  if (spec.color && Array.isArray(got.color)) {
    const off = spec.color.some((c, i) => !(Math.abs(c - (got.color as number[])[i]) <= COLOR_TOLERANCE));
    expectThat(m, !off, `${label}.color`, spec.color, got.color, "Mask colour differs");
  }
  if (spec.shape === "rect" || spec.shape === "ellipse") {
    const [l, t, w, h] = spec.box as number[];
    compareValues([l, t, l + w, t + h], got.box, `${label}.box`, m);
  }
  if (spec.shape === "path" && spec.vertices) {
    compareValues(spec.vertices.length, got.vertices, `${label}.vertices`, m);
    // The read-back box is the min/max of the vertices, so a moved point shows here. Tangents are not read back.
    const xs = spec.vertices.map((v) => v[0]);
    const ys = spec.vertices.map((v) => v[1]);
    compareValues([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], got.box, `${label}.box`, m);
    if (got.closed !== undefined) expectThat(m, got.closed === (spec.closed !== false), `${label}.closed`, spec.closed !== false, got.closed, "Mask closed state differs");
  }
}

export function maskMismatches(args: z.infer<typeof AeMaskSchema>, beforeRaw: unknown, afterRaw: unknown, written: Record<string, unknown>): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const before = beforeRaw as MaskState | null;
  const after = afterRaw as MaskState | null;
  if (!before || !after) return m;
  // A capped read (truncated) cannot show masks past its end: those are skipped, not flagged.
  const seen = (index: number) => !(after.truncated === true && index > after.masks.length);
  const added = (written.added as Array<{ index: number }>) ?? [];
  const removed = (written.removed as unknown[]) ?? [];
  const duplicated = (written.duplicated as Array<{ index: number; name: string }>) ?? [];
  const moved = (written.moved as Array<{ from: number; to: number; name: string; name_at_target?: string }>) ?? [];
  const want = before.count - removed.length + duplicated.length + added.length;
  expectThat(m, after.count === want, "count", want, after.count, "Mask count is not what the edit should leave");
  added.forEach((a, i) => {
    if (seen(a.index)) checkMask(m, `masks[${a.index}]`, args.add![i], after.masks.find((x) => x.index === a.index));
  });
  // Changes ran before removals, copies and moves; the host says where each changed mask ended up (final_index), else find it by name.
  const changed = (written.changed as Array<{ index: number; name: string; final_index?: number }>) ?? [];
  changed.forEach((c, i) => {
    const spec = args.set![i];
    if (c.final_index !== undefined && !seen(c.final_index)) return;
    const got = c.final_index !== undefined ? after.masks.find((x) => x.index === c.final_index) : after.masks.find((x) => x.name === (spec.name ?? c.name));
    checkMask(m, `masks[${spec.name ?? c.name}]`, spec, got);
  });
  // The expected order comes from the plan (the host's token list: original starting indexes, copies by their source) and the
  // names read before the write, not from names the host read inside the write's own script. A copy's name is made by After
  // Effects, so only its place is checked. The in-script `order` and `name_at_target` are information only.
  const plan = written.plan_order as Array<{ original?: number; copy_of?: number }> | undefined;
  if (plan && (moved.length > 0 || duplicated.length > 0) && before.truncated !== true && plan.length <= after.masks.length) {
    const renamed = new Map<number, string>();
    changed.forEach((c, i) => {
      const nm = args.set?.[i]?.name;
      if (nm) renamed.set(c.index, nm);
    });
    const nameOf = (idx: number) => renamed.get(idx) ?? before.masks.find((x) => x.index === idx)?.name;
    const wantOrder: Array<string | undefined> = plan.map((e) => (e.original !== undefined ? nameOf(e.original) : undefined));
    const now = after.masks.slice(0, plan.length).map((x) => x.name);
    const bad = wantOrder.some((n, i) => n !== undefined && n !== now[i]);
    expectThat(m, !bad, "order", wantOrder.map((n) => n ?? "(copy)"), now, "The mask order in the read-back is not the order the edit planned");
  }
  return m;
}

interface SelectorState {
  index?: number;
  type?: string;
  start?: number;
  end?: number;
  offset?: number;
  start_keys?: number;
  end_keys?: number;
  offset_keys?: number;
  children?: Array<{ name: string; matchName: string; value: unknown; keys?: number; expression?: string; expression_error?: string }>;
}

interface AnimatorState {
  count: number;
  animators: Array<{
    index: number;
    name: string;
    properties: Array<{ matchName: string; name?: string; value: unknown }>;
    selectors: SelectorState[];
  }>;
  more_options?: Record<string, unknown> | null;
}

interface WrittenSelector {
  index: number;
  type: string;
  fields?: Record<string, { match_name: string; name: string }>;
}

const PROP_MATCH: Record<string, string> = Object.fromEntries(Object.entries(ANIM_PROPS).map(([key, def]) => [key, def.match]));

// The value a selector field should read back as: enums are menu numbers, switches are 1 or 0.
function expectedSelectorValue(field: string, v: unknown): unknown {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string" && ENUMS[field]) return ENUMS[field][v];
  return v;
}

function checkSelectorChildren(m: ReceiptMismatch[], label: string, spec: SelectorInput, entry: SelectorState, info: WrittenSelector, skipField: string | undefined) {
  for (const [field, value] of Object.entries(spec)) {
    if (field === "type" || value === undefined || field === skipField) continue;
    const f = info.fields?.[field];
    if (!f) continue;
    const child = entry.children?.find((c) => c.matchName === f.match_name && c.name === f.name) ?? entry.children?.find((c) => c.matchName === f.match_name);
    if (!child) {
      m.push({ path: `${label}.${field}`, expected: value, actual: undefined, message: `The selector's ${field} (${f.match_name}) is not in the read-back` });
      continue;
    }
    if (field === "expression") {
      expectThat(m, child.expression === value, `${label}.expression`, value, child.expression, "The selector expression differs");
      if (child.expression_error) m.push({ path: `${label}.expression_error`, expected: "", actual: child.expression_error, message: `The selector expression has an error: ${child.expression_error}` });
      continue;
    }
    const got = typeof child.value === "boolean" ? Number(child.value) : child.value;
    compareValues(expectedSelectorValue(field, value), got, `${label}.${field}`, m);
  }
}

export function animatorMismatches(args: z.infer<typeof AeTextAnimatorSchema>, beforeRaw: unknown, afterRaw: unknown, written: Record<string, unknown>): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const before = beforeRaw as AnimatorState | null;
  const after = afterRaw as AnimatorState | null;
  if (!before || !after) return m;
  expectThat(m, after.count === before.count + 1, "count", before.count + 1, after.count, "The layer did not gain an animator");
  const a = after.animators.find((x) => x.index === written.index);
  if (!a) {
    m.push({ path: "animator", expected: written.index, actual: undefined, message: "The new animator is not in the read-back" });
    return m;
  }
  const matches = (written.property_matches as Record<string, { match_name: string }> | undefined) ?? {};
  for (const [key, value] of Object.entries(args.properties ?? {})) {
    if (value === undefined) continue;
    const matchName = matches[key]?.match_name ?? PROP_MATCH[key];
    const p = a.properties.find((x) => x.matchName === matchName);
    if (!p) {
      m.push({ path: `animator.${key}`, expected: value, actual: undefined, message: `The animator has no ${key}` });
      continue;
    }
    const want = key.endsWith("_color") && Array.isArray(value) && value.length === 3 ? [...value, 1] : value;
    compareValues(want, Array.isArray(want) && Array.isArray(p.value) ? (p.value as unknown[]).slice(0, want.length) : p.value, `animator.${key}`, m);
  }
  for (const ax of (written.variable_axes as Array<{ tag: string; value: number; index: number; name: string; match_name: string }> | undefined) ?? []) {
    const p = a.properties[ax.index - 1];
    if (!p || (p.matchName !== ax.match_name && p.name !== ax.name)) {
      m.push({ path: `animator.axis.${ax.tag}`, expected: ax.match_name, actual: p?.matchName, message: `The variable font axis ${ax.tag} is not in the read-back` });
      continue;
    }
    compareValues(ax.value, p.value, `animator.axis.${ax.tag}`, m);
  }
  // The same list the host builds: the given selectors in order, or one default range selector when none is given.
  const specs: Array<SelectorInput | undefined> = [...(args.selector ? [args.selector] : []), ...(args.more_selectors ?? [])];
  if (specs.length === 0) specs.push(undefined);
  const infos = (written.selectors as WrittenSelector[] | undefined) ?? [];
  const firstRange = specs.findIndex((s) => (s?.type ?? "range") === "range");
  const keyed = args.reveal ? (args.reveal.property ?? "start") : undefined;
  specs.forEach((s, i) => {
    const info = infos[i];
    const entry = (info ? (a.selectors.find((x) => x.index === info.index) ?? a.selectors[info.index - 1]) : undefined) ?? a.selectors[i];
    const type = s?.type ?? "range";
    if (!entry) {
      if (i === 0 && type === "range") m.push({ path: "animator.selector", expected: "range selector", actual: undefined, message: "The animator has no range selector" });
      else m.push({ path: `animator.selectors[${i}]`, expected: `${type} selector`, actual: undefined, message: `The animator has no ${type} selector at position ${i + 1}` });
      return;
    }
    const isReveal = args.reveal !== undefined && i === firstRange;
    if (entry.children && info) {
      if (s) checkSelectorChildren(m, i === 0 ? "selector" : `selectors[${i}]`, s, entry, info, isReveal ? keyed : undefined);
    } else if (i === 0 && type === "range") {
      // The property the reveal keys reads back as its value at the current time, not the static one written first.
      if (s?.start !== undefined && keyed !== "start") compareValues(s.start, entry.start, "selector.start", m);
      if (s?.end !== undefined && keyed !== "end") compareValues(s.end, entry.end, "selector.end", m);
      if (s?.offset !== undefined && keyed !== "offset") compareValues(s.offset, entry.offset, "selector.offset", m);
    }
    if (isReveal && args.reveal) {
      const keys = entry[`${args.reveal.property ?? "start"}_keys` as "start_keys"];
      expectThat(m, keys === 2, "selector.reveal", 2, keys, "The reveal did not get its two keys");
    }
  });
  if (args.grouping) {
    const mo = after.more_options;
    for (const [key, value] of Object.entries(args.grouping)) {
      if (value === undefined) continue;
      if (!mo || mo[key] === undefined) {
        m.push({ path: `grouping.${key}`, expected: value, actual: undefined, message: `More Options ${key} is not in the read-back` });
        continue;
      }
      const want = key === "anchor_point_grouping" ? GROUPING[value as string] : value;
      compareValues(want, mo[key], `grouping.${key}`, m);
    }
  }
  return m;
}

const MASK_DESCRIPTION =
  "Add, change, duplicate, reorder and remove a layer's masks in one undo group guarded by `expect`: a rectangle or ellipse in a box, or a free path with tangents; mode (add, subtract, intersect, lighten, darken, difference, none), inversion, feather, opacity and expansion, " +
  "and the mask attributes feather_falloff (linear, smooth), motion_blur (same_as_layer, on, off), colour, locked and roto_bezier (turning it on makes After Effects recompute the tangents: a warning says so; a member this After Effects lacks is skipped and listed in `unsupported`). " +
  "`duplicate` ({mask, count}) copies masks and `move_to` ({mask, index}) reorders them; selectors mean the masks as they are before the call, copies and moves happen after changes and removals, new masks are added last. " +
  "Each entry of `duplicated` has `index` (where the copy sat when it was made; later copies and moves can shift it) and `final_index` (where it ends up). " +
  "Removing, copying or moving masks changes what expressions that address masks by index (mask(1)) read: the layer's expressions are scanned and a warning lists any such references. " +
  "A locked layer is refused. A change (`set`) to a locked mask unlocks it, applies the edit and locks it again (`locked: false` leaves it unlocked); remove, duplicate and move_to do not check a mask's lock. " +
  "The read-back (a separate evalScript) checks the count, the order after copies and moves (against the planned order and the names read before the write; a copy's own name is After Effects' choice), and each mask's mode, inversion, feather, opacity, expansion, attributes and box (for a path: the box of its points, the vertex count and closed; tangents are not read back). " +
  "To animate a mask path there are two routes: ae_path_write with its `time` (preferred for keyed edits: it keeps feather points and checks vertex counts, and can change the vertex count), or ae_set_property on path ['ADBE Mask Parade', '<mask name>', 'ADBE Mask Shape'] with a Shape value { vertices, inTangents?, outTangents?, closed? } or keyframes of such values (every key needs the same vertex count). " +
  AGENT_SAFETY_GUIDANCE;

const ANIMATOR_DESCRIPTION =
  "Add a text animator to a text layer in one undo group guarded by `expect`. `properties` takes any animator property: anchor point, position, scale, skew, skew axis, rotation (X, Y, Z), opacity, fill (opacity, colour, hue, saturation, brightness), stroke (opacity, colour, hue, saturation, brightness, width), tracking (type, amount), line anchor, line spacing, character alignment/range/value/offset and blur. " +
  "Selectors: `selector` (and `more_selectors`) is a range selector by default (start, end, offset in percent, or indexes with units: index, in which case they are written to and read from the Index Start/End/Offset properties that After Effects then uses; based_on; mode; amount; shape; smoothness; ease high and low; randomize order; random seed), or type wiggly (mode, max/min amount, based_on, wiggles_per_second, correlation, temporal and spatial phase, lock_dimensions, random_seed) or type expression (an Amount expression plus based_on); fields from another type are refused. " +
  "The Wiggly and Expression selector child match names are not on the Guide's match-name page: the host finds them by match name, then by display name, and a field it cannot find fails with the selector's real children (nothing is left behind). " +
  "`variable_axes` ([{tag, value}], After Effects 26.0+) animates variable font axes, checked against the layer's font (an axis the font lacks is refused; custom uppercase tags are allowed; with mixed fonts it applies only where the font has the axis and the result says so). " +
  "`grouping` sets the layer's More Options (anchor point grouping, grouping alignment, fill & stroke and inter-character blending as menu indexes). `reveal` keyframes the first range selector's start, end or offset. " +
  "A classic reveal: opacity 0 with a reveal of start from 0 to 100. A locked layer is refused. The read-back (a separate evalScript) checks the animator's properties, each selector's fields, the axes, the More Options and the reveal's keys. " +
  AGENT_SAFETY_GUIDANCE;

export const masksTools: ToolDefinition<any>[] = [
  {
    name: "ae_mask",
    description: MASK_DESCRIPTION,
    schema: AeMaskSchema,
    handler: (args: z.infer<typeof AeMaskSchema>, ctx) =>
      runGuardedWrite(ctx, {
        toolName: "ae_mask",
        label: `ae_mask(+${args.add?.length ?? 0} ~${args.set?.length ?? 0} -${args.remove?.length ?? 0})`,
        expect: args.expect,
        compId: args.comp_id,
        read: () => ({ host: "maskList", args: { comp_id: args.comp_id, layer: args.layer } }),
        write: {
          host: "maskEdit",
          args: { comp_id: args.comp_id, layer: args.layer, add: args.add, set: args.set, remove: args.remove, duplicate: args.duplicate, move_to: args.move_to, label: "Edit masks" },
        },
        check: (before, after, w) => maskMismatches(args, before, after, w),
        present: (_before, after, w) => ({
          added: w.added,
          changed: w.changed,
          removed: w.removed,
          duplicated: w.duplicated,
          moved: w.moved,
          unsupported: w.unsupported,
          warnings: w.warnings,
          masks: (after as MaskState | null)?.masks,
        }),
      }),
  },
  {
    name: "ae_text_animator",
    description: ANIMATOR_DESCRIPTION,
    schema: AeTextAnimatorSchema,
    handler: (args: z.infer<typeof AeTextAnimatorSchema>, ctx) =>
      runGuardedWrite(ctx, {
        toolName: "ae_text_animator",
        label: `ae_text_animator(${[...Object.keys(args.properties ?? {}), ...(args.variable_axes?.length ? ["axes"] : [])].join(",")})`,
        expect: args.expect,
        compId: args.comp_id,
        read: () => ({ host: "textAnimators", args: { comp_id: args.comp_id, layer: args.layer } }),
        write: {
          host: "addTextAnimator",
          args: {
            comp_id: args.comp_id,
            layer: args.layer,
            name: args.name,
            properties: args.properties,
            variable_axes: args.variable_axes,
            selector: args.selector,
            more_selectors: args.more_selectors,
            grouping: args.grouping,
            reveal: args.reveal,
            label: "Add text animator",
          },
        },
        check: (before, after, w) => animatorMismatches(args, before, after, w),
        present: (_before, after, w) => ({
          animator: (after as AnimatorState | null)?.animators.find((x) => x.index === w.index) ?? w,
          warnings: w.warnings,
          variable_axes: w.variable_axes,
          selectors: w.selectors,
          grouping: (after as AnimatorState | null)?.more_options ?? w.grouping,
        }),
      }),
  },
];
