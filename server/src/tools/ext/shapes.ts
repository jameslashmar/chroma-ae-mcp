/**
 * server/src/tools/ext/shapes.ts
 *
 * ae_shape: add groups to a shape layer (rectangle, ellipse, star, polygon or
 * a free path, each with an optional fill, stroke, gradient fill or gradient
 * stroke), remove top-level contents, duplicate them or move them in the
 * stack, in one undo group, with a read-back of the layer's contents.
 * Existing shape properties are edited with ae_set_property on their path
 * (e.g. ['ADBE Root Vectors Group', 'Card', 'ADBE Vectors Group', 'ADBE Vector Shape - Rect', 'ADBE Vector Rect Size']).
 */

import { z } from "zod";
import type { ReceiptMismatch } from "../../receipts.js";
import { compareValues } from "../../receipts.js";
import { AGENT_SAFETY_GUIDANCE, ExpectSchema, LayerSelectorSchema, type ToolDefinition } from "../common.js";
import { expectThat, runGuardedWrite } from "./write-runner.js";

const Vec2 = z.array(z.number()).length(2);
const Color = z.array(z.number().min(0).max(1)).min(3).max(4);

const TaperSchema = z
  .object({
    start_length: z.number().min(0).max(100).optional().describe("Percent of the path the start taper covers."),
    end_length: z.number().min(0).max(100).optional().describe("Percent of the path the end taper covers."),
    start_width: z.number().min(0).max(100).optional().describe("Percent of the stroke width at the very start."),
    end_width: z.number().min(0).max(100).optional().describe("Percent of the stroke width at the very end."),
    start_ease: z.number().min(0).max(100).optional(),
    end_ease: z.number().min(0).max(100).optional(),
  })
  .describe("Stroke Taper (AE 17.1.1+; refused on older AE).");

const WaveSchema = z
  .object({
    amount: z.number().optional(),
    wavelength: z.number().optional(),
    phase: z.number().optional().describe("Degrees."),
  })
  .describe("Stroke Wave (AE 17.1.1+; refused on older AE).");

/** Stroke settings shared by a plain stroke and a gradient stroke. */
const StrokeDetails = {
  line_cap: z.enum(["butt", "round", "projecting"]).optional(),
  line_join: z.enum(["miter", "round", "bevel"]).optional(),
  miter_limit: z.number().min(1).max(100).optional(),
  dashes: z
    .array(z.object({ dash: z.number().min(0), gap: z.number().min(0) }))
    .min(1)
    .max(3)
    .optional()
    .describe("Up to three dash and gap pairs, in pixels (AE adds the Dash, Gap children one by one)."),
  dash_offset: z.number().optional().describe("Where the dash pattern starts. Goes with dashes."),
  taper: TaperSchema.optional(),
  wave: WaveSchema.optional(),
};

const FillRule = z.enum(["non_zero", "even_odd"]);

const GradientBase = {
  type: z.enum(["linear", "radial"]),
  start_point: Vec2.optional().describe("In the group's space."),
  end_point: Vec2.optional(),
  highlight_length: z.number().optional().describe("Radial gradients: percent."),
  highlight_angle: z.number().optional().describe("Radial gradients: degrees."),
};

export const ShapeSpecSchema = z
  .object({
    type: z.enum(["rect", "ellipse", "star", "polygon", "path"]),
    name: z.string().min(1).max(200).optional().describe("The group's name. Default '<type> <n>'."),
    size: Vec2.optional().describe("rect and ellipse: [width, height]."),
    position: Vec2.optional().describe("The shape's centre inside its group (rect, ellipse, star, polygon)."),
    roundness: z.number().min(0).optional().describe("rect: corner radius."),
    points: z.number().int().min(3).max(100).optional().describe("star and polygon: number of points or sides."),
    outer_radius: z.number().positive().optional().describe("star and polygon."),
    inner_radius: z.number().positive().optional().describe("star only."),
    rotation: z.number().optional().describe("star and polygon: degrees."),
    vertices: z.array(Vec2).min(2).max(1000).optional().describe("path: the points, in layer pixels."),
    in_tangents: z.array(Vec2).optional().describe("path: one per vertex, relative to it. Default straight lines."),
    out_tangents: z.array(Vec2).optional(),
    closed: z.boolean().optional().describe("path: default true."),
    fill: z
      .object({
        color: Color,
        opacity: z.number().min(0).max(100).optional(),
        rule: FillRule.optional().describe("non_zero or even_odd (how overlapping paths in the group fill)."),
      })
      .optional(),
    stroke: z
      .object({ color: Color, width: z.number().min(0), opacity: z.number().min(0).max(100).optional(), ...StrokeDetails })
      .optional()
      .describe("A flat stroke: colour, width, caps, joins, dashes, and on AE 17.1.1+ taper and wave."),
    gradient_fill: z
      .object({ ...GradientBase, opacity: z.number().min(0).max(100).optional(), rule: FillRule.optional() })
      .optional()
      .describe(
        "A gradient fill instead of `fill`: type, start and end points, highlight. The colour stops are left at AE's default ramp: they are not written by script (not through setValue as far as is known), so for custom stops save the look as a preset in AE and use ae_apply_preset."
      ),
    gradient_stroke: z
      .object({ ...GradientBase, width: z.number().min(0), opacity: z.number().min(0).max(100).optional(), ...StrokeDetails })
      .optional()
      .describe("A gradient stroke instead of `stroke` (same stroke details; colour stops at AE's default ramp)."),
    group_position: Vec2.optional().describe("The group's own Transform position."),
  })
  .superRefine((s, ctx) => {
    const need = (ok: boolean, message: string) => ok || ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if (s.type === "rect" || s.type === "ellipse") need(s.size !== undefined, `${s.type} needs size.`);
    if (s.type === "star" || s.type === "polygon") need(s.points !== undefined && s.outer_radius !== undefined, `${s.type} needs points and outer_radius.`);
    if (s.type === "star") need(s.inner_radius !== undefined, "star needs inner_radius.");
    if (s.type === "path") {
      need(s.vertices !== undefined, "path needs vertices.");
      const n = s.vertices?.length ?? 0;
      need(s.in_tangents === undefined || s.in_tangents.length === n, "in_tangents needs one entry per vertex.");
      need(s.out_tangents === undefined || s.out_tangents.length === n, "out_tangents needs one entry per vertex.");
    }
    need(s.fill === undefined || s.gradient_fill === undefined, "Give fill or gradient_fill, not both.");
    need(s.stroke === undefined || s.gradient_stroke === undefined, "Give stroke or gradient_stroke, not both.");
    for (const st of [s.stroke, s.gradient_stroke]) {
      if (st) need(st.dash_offset === undefined || st.dashes !== undefined, "dash_offset goes with dashes.");
    }
  });

const ContentSelector = z
  .object({ index: z.number().int().positive().optional(), name: z.string().min(1).optional() })
  .refine((r) => r.index !== undefined || r.name !== undefined, { message: "Give index or name." });

export const AeShapeSchema = z
  .object({
    comp_id: z.number().int(),
    layer: LayerSelectorSchema.describe("A shape layer (ae_create_layer type 'shape' makes an empty one)."),
    add: z.array(ShapeSpecSchema).max(200).optional().describe("Groups to add, in order, each at the bottom of the contents."),
    remove: z
      .array(ContentSelector)
      .max(200)
      .optional()
      .describe("Top-level contents to remove, by index or name (removed before anything is added). Cannot be combined with duplicate or move."),
    duplicate: z
      .array(
        z
          .object({ index: z.number().int().positive().optional(), name: z.string().min(1).optional(), count: z.number().int().min(1).max(50).optional().describe("Copies of this content. Default 1.") })
          .refine((r) => r.index !== undefined || r.name !== undefined, { message: "Give index or name." })
      )
      .max(50)
      .optional()
      .describe(
        "Duplicate top-level contents (groups), by index or name as they are before the call. Each entry is listed once, with a count. The result lists where each copy landed. " +
          "Cannot be combined with remove or move."
      ),
    move: z
      .array(
        z
          .object({ index: z.number().int().positive().optional(), name: z.string().min(1).optional(), to: z.number().int().positive().describe("New 1-based position in the contents.") })
          .refine((r) => r.index !== undefined || r.name !== undefined, { message: "Give index or name." })
      )
      .max(50)
      .optional()
      .describe("Move top-level contents to a new position, one entry after another in the order given (a later entry's index is the position after the earlier moves; names are stable). Cannot be combined with remove or duplicate."),
    expect: ExpectSchema,
  })
  .refine((v) => (v.add?.length ?? 0) + (v.remove?.length ?? 0) + (v.duplicate?.length ?? 0) + (v.move?.length ?? 0) > 0, {
    message: "Give shapes to add, contents to remove, duplicate or move.",
  })
  .refine((v) => !((v.duplicate?.length ?? 0) > 0 && ((v.remove?.length ?? 0) > 0 || (v.move?.length ?? 0) > 0)), {
    message: "duplicate can't be combined with remove or move in one call.",
  })
  .refine((v) => !((v.move?.length ?? 0) > 0 && (v.remove?.length ?? 0) > 0), {
    message: "move can't be combined with remove in one call.",
  })
  .refine((v) => !((v.add?.length ?? 0) > 0 && ((v.duplicate?.length ?? 0) > 0 || (v.move?.length ?? 0) > 0)), {
    message: "add can't be combined with duplicate or move in one call.",
  });

// ---------- read-back ----------

interface ContentItem {
  index?: number;
  name: string;
  matchName?: string;
  kind: string;
  size?: number[] | null;
  points?: number | null;
  outer_radius?: number | null;
  color?: number[] | null;
  width?: number | null;
  opacity?: number | null;
  rule?: number | null;
  line_cap?: number | null;
  line_join?: number | null;
  miter_limit?: number | null;
  dashes?: Array<{ matchName: string; value: number | null }>;
  taper?: Record<string, number | null>;
  wave?: Record<string, number | null>;
  gradient_type?: number | null;
  start_point?: number[] | null;
  end_point?: number[] | null;
  highlight_length?: number | null;
  highlight_angle?: number | null;
  vertices?: number;
  items?: ContentItem[];
}

interface ShapeContents {
  count: number;
  contents: ContentItem[];
  truncated: boolean;
}

type Spec = z.infer<typeof ShapeSpecSchema>;
type StrokeLike = {
  line_cap?: string;
  line_join?: string;
  miter_limit?: number;
  dashes?: Array<{ dash: number; gap: number }>;
  dash_offset?: number;
  taper?: Record<string, number | undefined>;
  wave?: Record<string, number | undefined>;
};

const kindOf = (t: Spec["type"]) => (t === "polygon" ? "star" : t);

const LINE_CAP: Record<string, number> = { butt: 1, round: 2, projecting: 3 };
const LINE_JOIN: Record<string, number> = { miter: 1, round: 2, bevel: 3 };
const FILL_RULE: Record<string, number> = { non_zero: 1, even_odd: 2 };
const GRAD_TYPE: Record<string, number> = { linear: 1, radial: 2 };
const DASH_NAMES = [
  "ADBE Vector Stroke Dash 1",
  "ADBE Vector Stroke Gap 1",
  "ADBE Vector Stroke Dash 2",
  "ADBE Vector Stroke Gap 2",
  "ADBE Vector Stroke Dash 3",
  "ADBE Vector Stroke Gap 3",
];
const TAPER_NAMES: Record<string, string> = {
  start_length: "ADBE Vector Taper Start Length",
  end_length: "ADBE Vector Taper End Length",
  start_width: "ADBE Vector Taper Start Width",
  end_width: "ADBE Vector Taper End Width",
  start_ease: "ADBE Vector Taper Start Ease",
  end_ease: "ADBE Vector Taper End Ease",
};

/** The contents' names after the moves, applied one after another (1-based from and to). */
export function applyMoves(names: string[], moves: Array<{ from: number; to: number }>): string[] {
  const out = names.slice();
  for (const m of moves) {
    if (m.from < 1 || m.from > out.length || m.to < 1 || m.to > out.length) continue;
    const [item] = out.splice(m.from - 1, 1);
    out.splice(m.to - 1, 0, item);
  }
  return out;
}

function strokeDetailMismatches(at: string, spec: StrokeLike, item: ContentItem, m: ReceiptMismatch[]): void {
  if (spec.line_cap) compareValues(LINE_CAP[spec.line_cap], item.line_cap, `${at}.line_cap`, m);
  if (spec.line_join) compareValues(LINE_JOIN[spec.line_join], item.line_join, `${at}.line_join`, m);
  if (spec.miter_limit !== undefined) compareValues(spec.miter_limit, item.miter_limit, `${at}.miter_limit`, m);
  if (spec.dashes) {
    const got = new Map((item.dashes ?? []).map((d) => [d.matchName, d.value]));
    spec.dashes.forEach((d, i) => {
      compareValues(d.dash, got.get(DASH_NAMES[i * 2]), `${at}.dashes[${i}].dash`, m);
      compareValues(d.gap, got.get(DASH_NAMES[i * 2 + 1]), `${at}.dashes[${i}].gap`, m);
    });
    if (spec.dash_offset !== undefined) compareValues(spec.dash_offset, got.get("ADBE Vector Stroke Offset"), `${at}.dash_offset`, m);
  }
  for (const [field, v] of Object.entries(spec.taper ?? {})) {
    if (v !== undefined && TAPER_NAMES[field]) compareValues(v, item.taper?.[field], `${at}.taper.${field}`, m);
  }
  for (const [field, v] of Object.entries(spec.wave ?? {})) {
    if (v !== undefined) compareValues(v, item.wave?.[field], `${at}.wave.${field}`, m);
  }
}

function gradientMismatches(
  at: string,
  spec: { type: string; start_point?: number[]; end_point?: number[]; highlight_length?: number; highlight_angle?: number },
  item: ContentItem,
  m: ReceiptMismatch[]
): void {
  compareValues(GRAD_TYPE[spec.type], item.gradient_type, `${at}.type`, m);
  if (spec.start_point) compareValues(spec.start_point, item.start_point, `${at}.start_point`, m);
  if (spec.end_point) compareValues(spec.end_point, item.end_point, `${at}.end_point`, m);
  if (spec.highlight_length !== undefined) compareValues(spec.highlight_length, item.highlight_length, `${at}.highlight_length`, m);
  if (spec.highlight_angle !== undefined) compareValues(spec.highlight_angle, item.highlight_angle, `${at}.highlight_angle`, m);
}

interface DuplicateRecord {
  source_index: number;
  copies: Array<{ index: number; name: string }>;
  requested: number;
}

export function shapeMismatches(adds: Spec[], beforeRaw: unknown, afterRaw: unknown, written: Record<string, unknown>): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const before = beforeRaw as ShapeContents | null;
  const after = afterRaw as ShapeContents | null;
  if (!before || !after) return m;
  const removed = ((written.removed as unknown[]) ?? []).length;
  const added = (written.added as Array<{ index: number; name: string }>) ?? [];
  const duplicated = (written.duplicated as DuplicateRecord[] | undefined) ?? [];
  const copies = duplicated.reduce((n, d) => n + d.copies.length, 0);
  const want = before.count - removed + copies + added.length;
  expectThat(m, after.count === want, "count", want, after.count, "Content count is not what the edit should leave");

  if (written.duplicate_located === false) {
    m.push({ path: "duplicated", expected: "every copy located", actual: "unknown", message: "AE did not report where a copy went, so the copies were not located; check the contents list" });
  }
  for (const d of duplicated) {
    if (d.copies.length !== d.requested) {
      m.push({ path: `duplicated[${d.source_index}]`, expected: d.requested, actual: d.copies.length, message: `Content ${d.source_index} got ${d.copies.length} of ${d.requested} copies` });
    }
    const src = before.contents.find((c) => c.index === d.source_index);
    for (const c of d.copies) {
      const got = after.contents.find((x) => x.index === c.index);
      if (!got) {
        if (!after.truncated) m.push({ path: `contents[${c.index}]`, expected: c.name, actual: undefined, message: `The copy at index ${c.index} is not in the read-back` });
        continue;
      }
      if (src?.matchName && got.matchName !== src.matchName) {
        m.push({ path: `contents[${c.index}].matchName`, expected: src.matchName, actual: got.matchName, message: `The item at index ${c.index} is not a copy of "${src.name}"` });
      }
    }
  }

  const moved = (written.moved as Array<{ from: number; to: number }> | undefined) ?? [];
  if (moved.length > 0 && !before.truncated && !after.truncated) {
    const expectedOrder = applyMoves(before.contents.map((c) => c.name), moved);
    compareValues(expectedOrder, after.contents.slice(0, expectedOrder.length).map((c) => c.name), "contents.order", m);
  }

  added.forEach((a, i) => {
    const spec = adds[i];
    const got = after.contents.find((c) => c.index === a.index);
    // New groups sit at the end, so on a long layer they fall past the read-back: say so, don't pass them.
    if (!got && after.truncated) {
      m.push({ path: `contents[${a.index}]`, expected: a.name, actual: "not read", message: `Group "${a.name}" was not verified: the read-back stops at ${after.contents.length} items` });
      return;
    }
    if (!got || got.name !== a.name) {
      m.push({ path: `contents[${a.index}]`, expected: a.name, actual: got?.name, message: `Group "${a.name}" is not at index ${a.index}` });
      return;
    }
    const items = got.items ?? [];
    const shape = items.find((x) => x.kind === kindOf(spec.type));
    expectThat(m, shape !== undefined, `${a.name}.shape`, kindOf(spec.type), items.map((x) => x.kind), `Group "${a.name}" has no ${spec.type}`);
    if (shape && spec.size) compareValues(spec.size, shape.size, `${a.name}.size`, m);
    if (shape && spec.points !== undefined) compareValues(spec.points, shape.points, `${a.name}.points`, m);
    if (shape && spec.vertices) compareValues(spec.vertices.length, shape.vertices, `${a.name}.vertices`, m);
    const fill = items.find((x) => x.kind === "fill");
    if (spec.fill) {
      expectThat(m, fill !== undefined, `${a.name}.fill`, "fill", undefined, `Group "${a.name}" has no fill`);
      if (fill) {
        compareValues(spec.fill.color.slice(0, 3), fill.color?.slice(0, 3), `${a.name}.fill.color`, m);
        if (spec.fill.rule) compareValues(FILL_RULE[spec.fill.rule], fill.rule, `${a.name}.fill.rule`, m);
      }
    }
    const stroke = items.find((x) => x.kind === "stroke");
    if (spec.stroke) {
      expectThat(m, stroke !== undefined, `${a.name}.stroke`, "stroke", undefined, `Group "${a.name}" has no stroke`);
      if (stroke) {
        compareValues(spec.stroke.width, stroke.width, `${a.name}.stroke.width`, m);
        strokeDetailMismatches(`${a.name}.stroke`, spec.stroke, stroke, m);
      }
    }
    const gfill = items.find((x) => x.kind === "gradient_fill");
    if (spec.gradient_fill) {
      expectThat(m, gfill !== undefined, `${a.name}.gradient_fill`, "gradient_fill", undefined, `Group "${a.name}" has no gradient fill`);
      if (gfill) {
        gradientMismatches(`${a.name}.gradient_fill`, spec.gradient_fill, gfill, m);
        if (spec.gradient_fill.rule) compareValues(FILL_RULE[spec.gradient_fill.rule], gfill.rule, `${a.name}.gradient_fill.rule`, m);
      }
    }
    const gstroke = items.find((x) => x.kind === "gradient_stroke");
    if (spec.gradient_stroke) {
      expectThat(m, gstroke !== undefined, `${a.name}.gradient_stroke`, "gradient_stroke", undefined, `Group "${a.name}" has no gradient stroke`);
      if (gstroke) {
        gradientMismatches(`${a.name}.gradient_stroke`, spec.gradient_stroke, gstroke, m);
        compareValues(spec.gradient_stroke.width, gstroke.width, `${a.name}.gradient_stroke.width`, m);
        strokeDetailMismatches(`${a.name}.gradient_stroke`, spec.gradient_stroke, gstroke, m);
      }
    }
  });
  return m;
}

export const shapesTools: ToolDefinition<any>[] = [
  {
    name: "ae_shape",
    description:
      "Build a shape layer's contents: add groups (rectangle, ellipse, star, polygon, or a free path with tangents), each with an optional fill and stroke, and remove, duplicate or reorder top-level contents, " +
      "in one undo group guarded by `expect`. " +
      "Stroke details: line_cap (butt, round, projecting), line_join, miter_limit, dashes (up to three dash and gap pairs plus dash_offset), and on AE 17.1.1+ taper (start and end length, width, ease) and wave (amount, wavelength, phase); older AE refuses taper and wave before writing. " +
      "Fill rule non_zero or even_odd. gradient_fill and gradient_stroke take the place of fill and stroke: type linear or radial, start and end points, highlight length and angle. " +
      "Gradient colour stops are left at AE's default ramp (they are not written by script as far as is known; for custom stops apply a preset saved from AE with ae_apply_preset). " +
      "duplicate (index or name, with a count) makes copies of top-level contents and reports where each landed; move puts contents at a new position (one entry after another). " +
      "Expressions that read contents by position (content(2)) silently retarget after a duplicate or move: they are listed as `expression_warnings`. Both are refused on a locked layer, and not combined with remove or add. Only expressions in this comp's layers (up to 300) are scanned; expressions in other comps that reach this layer through comp(\"X\").layer(...).content(n) are not (a note in the result says so). " +
      "Known limits (taper percentages 0..100, highlight length -100..100, miter limit >= 1) are checked before the undo group opens. If AE still refuses an add, the groups added by that call are taken back out in the same undo group; with remove + add the removals made earlier in the call stay (Edit > Undo brings them back), and the call returns an error. " +
      "The read-back (a separate evalScript) lists the contents and checks each new group's shape, size, fill colour, stroke width and the stroke and gradient details, the copies and the new order. " +
      "Change existing shape properties (or animate them) with ae_set_property on their path; ae_get_layer_full lists the paths. Path operators (Trim, Merge, Round Corners, Zig Zag and others) go in with ae_path_operator. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeShapeSchema,
    handler: (args: z.infer<typeof AeShapeSchema>, ctx) =>
      runGuardedWrite(ctx, {
        toolName: "ae_shape",
        label: `ae_shape(+${args.add?.length ?? 0} -${args.remove?.length ?? 0}${args.duplicate ? ` dup${args.duplicate.length}` : ""}${args.move ? ` mv${args.move.length}` : ""})`,
        expect: args.expect,
        compId: args.comp_id,
        read: () => ({ host: "shapeContents", args: { comp_id: args.comp_id, layer: args.layer } }),
        write: {
          host: "shapeEdit",
          args: { comp_id: args.comp_id, layer: args.layer, add: args.add, remove: args.remove, duplicate: args.duplicate, move: args.move, label: "Edit shape contents" },
        },
        check: (before, after, w) => shapeMismatches(args.add ?? [], before, after, w),
        present: (_before, after, w) => {
          const out: Record<string, unknown> = { added: w.added, removed: w.removed, contents: (after as ShapeContents | null)?.contents };
          for (const k of ["no_op", "note", "duplicated", "duplicate_located", "moved", "expression_warnings", "expression_scan_truncated", "expression_scan_scope"]) {
            if (w[k] !== undefined) out[k] = w[k];
          }
          return out;
        },
      }),
  },
];
