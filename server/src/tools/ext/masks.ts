/**
 * server/src/tools/ext/masks.ts
 *
 * - ae_mask: add (rectangle, ellipse, free path), change and remove a
 *   layer's masks: mode, inversion, feather, opacity, expansion
 * - ae_text_animator: add a text animator (position, scale, rotation,
 *   opacity, fill colour, tracking, blur) with a range selector, and
 *   optionally a keyframed reveal of its start, end or offset
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
    expect: ExpectSchema,
  })
  .refine((v) => (v.add?.length ?? 0) + (v.set?.length ?? 0) + (v.remove?.length ?? 0) > 0, { message: "Give masks to add, set or remove." });

export const AeTextAnimatorSchema = z.object({
  comp_id: z.number().int(),
  layer: LayerSelectorSchema.describe("A text layer."),
  name: z.string().min(1).max(200).optional(),
  properties: z
    .object({
      position: z.array(z.number()).min(2).max(3).optional(),
      scale: z.array(z.number()).min(2).max(3).optional(),
      rotation: z.number().optional(),
      opacity: z.number().min(0).max(100).optional(),
      fill_color: z.array(z.number().min(0).max(1)).min(3).max(4).optional(),
      tracking: z.number().optional(),
      blur: Vec2.optional(),
    })
    .refine((p) => Object.values(p).some((v) => v !== undefined), { message: "Give at least one animator property." })
    .describe("What the animator does to the selected characters (offsets from their normal look)."),
  selector: z
    .object({
      start: z.number().min(0).max(100).optional(),
      end: z.number().min(0).max(100).optional(),
      offset: z.number().min(-100).max(100).optional(),
      based_on: z.enum(["characters", "characters_excluding_spaces", "words", "lines"]).optional(),
      shape: z.enum(["square", "ramp_up", "ramp_down", "triangle", "round", "smooth"]).optional(),
      ease_high: z.number().min(-100).max(100).optional(),
      ease_low: z.number().min(-100).max(100).optional(),
      randomize: z.boolean().optional(),
    })
    .optional()
    .describe("The range selector: which characters the properties apply to, in percent."),
  reveal: z
    .object({
      property: z.enum(["start", "end", "offset"]).optional().describe("Default start."),
      from: z.number(),
      to: z.number(),
      start_time: z.number().min(0),
      duration: z.number().positive(),
    })
    .optional()
    .describe("Keyframe the selector over time, e.g. start 0 -> 100 for a character-by-character reveal with opacity 0."),
  expect: ExpectSchema,
});

// ---------- checks ----------

interface MaskState {
  count: number;
  masks: Array<{ index: number; name: string; mode: string | null; inverted: boolean; feather: number[] | null; opacity: number | null; expansion: number | null; vertices: number; closed?: boolean; box: number[] | null }>;
}

type MaskSpec = z.infer<typeof AeMaskSchema>["add"] extends Array<infer T> | undefined ? T : never;

function checkMask(m: ReceiptMismatch[], label: string, spec: Partial<MaskSpec>, got: MaskState["masks"][number] | undefined) {
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
  const added = (written.added as Array<{ index: number }>) ?? [];
  const removed = (written.removed as unknown[]) ?? [];
  const want = before.count - removed.length + added.length;
  expectThat(m, after.count === want, "count", want, after.count, "Mask count is not what the edit should leave");
  added.forEach((a, i) => checkMask(m, `masks[${a.index}]`, args.add![i], after.masks.find((x) => x.index === a.index)));
  // Changes ran before removals; find the changed masks by name in the read-back.
  const changed = (written.changed as Array<{ index: number; name: string }>) ?? [];
  changed.forEach((c, i) => checkMask(m, `masks[${c.name}]`, args.set![i], after.masks.find((x) => x.name === (args.set![i].name ?? c.name))));
  return m;
}

interface AnimatorState {
  count: number;
  animators: Array<{
    index: number;
    name: string;
    properties: Array<{ matchName: string; value: unknown }>;
    selectors: Array<{ start?: number; end?: number; offset?: number; start_keys?: number; end_keys?: number; offset_keys?: number }>;
  }>;
}

const PROP_MATCH: Record<string, string> = {
  position: "ADBE Text Position 3D",
  scale: "ADBE Text Scale 3D",
  rotation: "ADBE Text Rotation",
  opacity: "ADBE Text Opacity",
  fill_color: "ADBE Text Fill Color",
  tracking: "ADBE Text Tracking Amount",
  blur: "ADBE Text Blur",
};

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
  for (const [key, value] of Object.entries(args.properties)) {
    if (value === undefined) continue;
    const p = a.properties.find((x) => x.matchName === PROP_MATCH[key]);
    if (!p) {
      m.push({ path: `animator.${key}`, expected: value, actual: undefined, message: `The animator has no ${key}` });
      continue;
    }
    const want = key === "fill_color" && Array.isArray(value) && value.length === 3 ? [...value, 1] : value;
    compareValues(want, Array.isArray(want) && Array.isArray(p.value) ? (p.value as unknown[]).slice(0, want.length) : p.value, `animator.${key}`, m);
  }
  const sel = a.selectors[0];
  const s = args.selector;
  if (!sel) m.push({ path: "animator.selector", expected: "range selector", actual: undefined, message: "The animator has no range selector" });
  else {
    // The property the reveal keys reads back as its value at the current time, not the static one written first.
    const keyed = args.reveal ? (args.reveal.property ?? "start") : undefined;
    if (s?.start !== undefined && keyed !== "start") compareValues(s.start, sel.start, "selector.start", m);
    if (s?.end !== undefined && keyed !== "end") compareValues(s.end, sel.end, "selector.end", m);
    if (s?.offset !== undefined && keyed !== "offset") compareValues(s.offset, sel.offset, "selector.offset", m);
    if (args.reveal) {
      const keys = sel[`${args.reveal.property ?? "start"}_keys` as "start_keys"];
      expectThat(m, keys === 2, "selector.reveal", 2, keys, "The reveal did not get its two keys");
    }
  }
  return m;
}

export const masksTools: ToolDefinition<any>[] = [
  {
    name: "ae_mask",
    description:
      "Add, change and remove a layer's masks in one undo group guarded by `expect`: a rectangle or ellipse in a box, or a free path with tangents; mode (add, subtract, intersect, lighten, darken, difference, none), inversion, feather, opacity and expansion. " +
      "The read-back (a separate evalScript) checks the count and each mask's mode, inversion, feather, opacity, expansion and box (for a path: the box of its points, the vertex count and closed; tangents are not read back). Animate a mask path with ae_set_property on ['ADBE Mask Parade', <mask>, 'ADBE Mask Shape']. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeMaskSchema,
    handler: (args: z.infer<typeof AeMaskSchema>, ctx) =>
      runGuardedWrite(ctx, {
        toolName: "ae_mask",
        label: `ae_mask(+${args.add?.length ?? 0} ~${args.set?.length ?? 0} -${args.remove?.length ?? 0})`,
        expect: args.expect,
        compId: args.comp_id,
        read: () => ({ host: "maskList", args: { comp_id: args.comp_id, layer: args.layer } }),
        write: { host: "maskEdit", args: { comp_id: args.comp_id, layer: args.layer, add: args.add, set: args.set, remove: args.remove, label: "Edit masks" } },
        check: (before, after, w) => maskMismatches(args, before, after, w),
        present: (_before, after, w) => ({ added: w.added, changed: w.changed, removed: w.removed, masks: (after as MaskState | null)?.masks }),
      }),
  },
  {
    name: "ae_text_animator",
    description:
      "Add a text animator to a text layer in one undo group guarded by `expect`: properties (position, scale, rotation, opacity, fill colour, tracking, blur) applied through a range selector " +
      "(start, end, offset in percent; based on characters, words or lines; shape; ease high and low; random order), and optionally a reveal that keyframes the selector's start, end or offset. " +
      "A classic reveal: opacity 0 with a reveal of start from 0 to 100. The read-back (a separate evalScript) checks the animator's properties, its selector and the reveal's keys. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeTextAnimatorSchema,
    handler: (args: z.infer<typeof AeTextAnimatorSchema>, ctx) =>
      runGuardedWrite(ctx, {
        toolName: "ae_text_animator",
        label: `ae_text_animator(${Object.keys(args.properties).join(",")})`,
        expect: args.expect,
        compId: args.comp_id,
        read: () => ({ host: "textAnimators", args: { comp_id: args.comp_id, layer: args.layer } }),
        write: {
          host: "addTextAnimator",
          args: { comp_id: args.comp_id, layer: args.layer, name: args.name, properties: args.properties, selector: args.selector, reveal: args.reveal, label: "Add text animator" },
        },
        check: (before, after, w) => animatorMismatches(args, before, after, w),
        present: (_before, after, w) => ({ animator: (after as AnimatorState | null)?.animators.find((x) => x.index === w.index) ?? w }),
      }),
  },
];
