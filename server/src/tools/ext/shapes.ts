/**
 * server/src/tools/ext/shapes.ts
 *
 * ae_shape: add groups to a shape layer (rectangle, ellipse, star, polygon or
 * a free path, each with an optional fill and stroke) and remove top-level
 * contents, in one undo group, with a read-back of the layer's contents.
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
    fill: z.object({ color: Color, opacity: z.number().min(0).max(100).optional() }).optional(),
    stroke: z.object({ color: Color, width: z.number().min(0), opacity: z.number().min(0).max(100).optional() }).optional(),
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
  });

export const AeShapeSchema = z
  .object({
    comp_id: z.number().int(),
    layer: LayerSelectorSchema.describe("A shape layer (ae_create_layer type 'shape' makes an empty one)."),
    add: z.array(ShapeSpecSchema).max(200).optional().describe("Groups to add, in order, each at the bottom of the contents."),
    remove: z
      .array(z.object({ index: z.number().int().positive().optional(), name: z.string().min(1).optional() }).refine((r) => r.index !== undefined || r.name !== undefined))
      .max(200)
      .optional()
      .describe("Top-level contents to remove, by index or name (removed before anything is added)."),
    expect: ExpectSchema,
  })
  .refine((v) => (v.add?.length ?? 0) + (v.remove?.length ?? 0) > 0, { message: "Give shapes to add or contents to remove." });

// ---------- read-back ----------

interface ContentItem {
  index?: number;
  name: string;
  kind: string;
  size?: number[] | null;
  points?: number | null;
  outer_radius?: number | null;
  color?: number[] | null;
  width?: number | null;
  vertices?: number;
  items?: ContentItem[];
}

interface ShapeContents {
  count: number;
  contents: ContentItem[];
  truncated: boolean;
}

type Spec = z.infer<typeof ShapeSpecSchema>;

const kindOf = (t: Spec["type"]) => (t === "polygon" ? "star" : t);

export function shapeMismatches(adds: Spec[], beforeRaw: unknown, afterRaw: unknown, written: Record<string, unknown>): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const before = beforeRaw as ShapeContents | null;
  const after = afterRaw as ShapeContents | null;
  if (!before || !after) return m;
  const removed = ((written.removed as unknown[]) ?? []).length;
  const added = (written.added as Array<{ index: number; name: string }>) ?? [];
  const want = before.count - removed + added.length;
  expectThat(m, after.count === want, "count", want, after.count, "Content count is not what the edit should leave");
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
      if (fill) compareValues(spec.fill.color.slice(0, 3), fill.color?.slice(0, 3), `${a.name}.fill.color`, m);
    }
    const stroke = items.find((x) => x.kind === "stroke");
    if (spec.stroke) {
      expectThat(m, stroke !== undefined, `${a.name}.stroke`, "stroke", undefined, `Group "${a.name}" has no stroke`);
      if (stroke) compareValues(spec.stroke.width, stroke.width, `${a.name}.stroke.width`, m);
    }
  });
  return m;
}

export const shapesTools: ToolDefinition<any>[] = [
  {
    name: "ae_shape",
    description:
      "Build a shape layer's contents: add groups (rectangle, ellipse, star, polygon, or a free path with tangents), each with an optional fill and stroke, and remove top-level contents, " +
      "in one undo group guarded by `expect`. The read-back (a separate evalScript) lists the contents and checks each new group's shape, size, fill colour and stroke width. " +
      "Change existing shape properties (or animate them) with ae_set_property on their path; ae_get_layer_full lists the paths. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeShapeSchema,
    handler: (args: z.infer<typeof AeShapeSchema>, ctx) =>
      runGuardedWrite(ctx, {
        toolName: "ae_shape",
        label: `ae_shape(+${args.add?.length ?? 0} -${args.remove?.length ?? 0})`,
        expect: args.expect,
        compId: args.comp_id,
        read: () => ({ host: "shapeContents", args: { comp_id: args.comp_id, layer: args.layer } }),
        write: { host: "shapeEdit", args: { comp_id: args.comp_id, layer: args.layer, add: args.add, remove: args.remove, label: "Edit shape contents" } },
        check: (before, after, w) => shapeMismatches(args.add ?? [], before, after, w),
        present: (_before, after, w) => ({ added: w.added, removed: w.removed, contents: (after as ShapeContents | null)?.contents }),
      }),
  },
];
