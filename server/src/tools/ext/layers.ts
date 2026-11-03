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
  parent: number | null;
  threeD?: boolean;
  adjustment?: boolean;
  sourceId?: number;
  lightType?: string;
  text?: string;
  trackMatte?: { type: string; layer: { index: number; id: number; name: string } | null };
  isTrackMatte?: boolean;
}

export interface LayerStack {
  comp_id: number;
  name: string;
  numLayers: number;
  layers: StackLayer[];
  with_comp?: LayerStack;
}

const stackOf = (v: unknown): LayerStack | null => (v && typeof v === "object" ? (v as LayerStack) : null);
const byId = (stack: LayerStack | null, id: unknown) => stack?.layers.find((l) => l.id === id);

/** Finds a selector's layer in a stack read before the write. */
export function resolveInStack(stack: LayerStack | null, sel: LayerSelector | undefined): StackLayer | undefined {
  if (!stack || !sel) return undefined;
  if (sel.id !== undefined) return stack.layers.find((l) => l.id === sel.id);
  if (sel.index !== undefined) return stack.layers.find((l) => l.index === sel.index);
  const named = stack.layers.filter((l) => l.name === sel.name);
  return named.length === 1 ? named[0] : undefined;
}

// ---------- schemas ----------

const LAYER_TYPES = ["solid", "null", "adjustment", "text", "shape", "camera", "light", "footage", "precomp"] as const;
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
    light_type: z.enum(["parallel", "spot", "point", "ambient"]).optional(),
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
  if (type === "footage") return ["footage", "audio", "solid"];
  return [type];
}

export function createLayerMismatches(args: CreateArgs, beforeRaw: unknown, afterRaw: unknown, written: Record<string, unknown>): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const before = stackOf(beforeRaw);
  const after = stackOf(afterRaw);
  if (!before || !after) return m;
  expectThat(m, after.numLayers === before.numLayers + 1, "numLayers", before.numLayers + 1, after.numLayers, "Layer count did not grow by one");
  const made = byId(after, written.id);
  if (!made) {
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
  if (args.light_type) expectThat(m, made.lightType === args.light_type, "layer.lightType", args.light_type, made.lightType, "Light type differs");
  if (args.parent) {
    const parent = resolveInStack(before, args.parent);
    const parentNow = parent ? byId(after, parent.id) : undefined;
    expectThat(m, parentNow !== undefined && made.parent === parentNow.index, "layer.parent", parentNow?.index, made.parent, "Parent differs");
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
  expectThat(m, precompLayer !== undefined && precompLayer.index === top, "precomp_layer.index", top, precompLayer?.index, "The precomp layer is not where the topmost precomposed layer was");
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
    m.push({ path: "layer", expected: written.layer, actual: undefined, message: "The layer is not in the read-back" });
    return m;
  }
  expectThat(m, target.trackMatte?.type === args.type, "layer.trackMatte.type", args.type, target.trackMatte?.type, "Track matte type differs");
  if (args.type === "none") {
    const prev = written.previous_matte as { id?: number } | undefined;
    if (args.show_matte && prev?.id !== undefined) {
      const prevNow = byId(after, prev.id);
      expectThat(m, prevNow?.enabled === true, "previous_matte.enabled", true, prevNow?.enabled, "The old matte layer is still hidden");
    }
    return m;
  }
  const matteId = (written.matte as { id?: number } | undefined)?.id;
  expectThat(m, target.trackMatte?.layer?.id === matteId, "layer.trackMatte.layer", matteId, target.trackMatte?.layer?.id, "Track matte layer differs");
  const matte = byId(after, matteId);
  if (args.hide_matte !== false) {
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

const stackRead = (compId: number, withComp?: number) => ({
  host: "layerStack",
  args: withComp === undefined ? { comp_id: compId } : { comp_id: compId, with_comp_id: withComp },
});

export const layersTools: ToolDefinition<any>[] = [
  {
    name: "ae_create_layer",
    description:
      "Create a layer in a comp: solid, null, adjustment, text (point or box), shape (empty), camera, light, footage or precomp (from a project item), " +
      "with a name, length, start time, 3D switch, parent and place in the stack, in one undo group guarded by `expect`. " +
      "The read-back (a separate evalScript) checks the layer count, kind, name, text, parent and index. Solids add a solid item to the project, as in AE. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeCreateLayerSchema,
    handler: (args: CreateArgs, ctx) =>
      runGuardedWrite(ctx, {
        toolName: "ae_create_layer",
        label: `ae_create_layer(${args.type}${args.name ? ` "${args.name}"` : ""})`,
        expect: args.expect,
        compId: args.comp_id,
        read: () => stackRead(args.comp_id),
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
        present: (_before, after, w) => ({ layer: byId(stackOf(after), w.id) ?? w }),
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
        read: (phase, w) => stackRead(args.comp_id, phase === "after" ? (w?.new_comp_id as number | undefined) : undefined),
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
        read: () => stackRead(args.comp_id),
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
