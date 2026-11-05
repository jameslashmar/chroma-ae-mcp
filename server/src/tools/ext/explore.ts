// explore.ts: Read-only layer/comp/effect exploration and expression validation tools.
//
// Credits:
// - ae_get_layer_full and ae_find_layers ideas adapted from reference/engine-room/packages/jsx/explore.jsx
//   (Engine-Room-Games/after-effects-mcp, MIT License).

import { z } from "zod";
import type { ReceiptMismatch } from "../../receipts.js";
import {
  AGENT_SAFETY_GUIDANCE,
  ExpectSchema,
  LayerSelectorSchema,
  type ToolDefinition,
} from "../common.js";
import { SLOW_TIMEOUT_MS } from "../../host.js";
import { expectThat, runGuardedWrite } from "./write-runner.js";

export const LAYER_INCLUDE_SECTIONS = [
  "transform",
  "effects",
  "masks",
  "text",
  "shapes",
  "expressions",
  "keyframes",
  "markers",
] as const;

export const LayerIncludeSectionSchema = z.enum(LAYER_INCLUDE_SECTIONS);

export const AeGetLayerFullSchema = z.object({
  comp_id: z
    .number()
    .int()
    .describe("The CompItem ID containing the target layer."),
  layer: LayerSelectorSchema,
  include: z
    .array(LayerIncludeSectionSchema)
    .optional()
    .describe(
      "Optional subset of sections to include (defaults to all: transform, effects, masks, text, shapes, expressions, keyframes, markers)."
    ),
  max_keyframes: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(100)
    .describe(
      "Maximum number of keyframes to return per animated property (default: 100, max: 500)."
    ),
  shape_depth: z
    .number()
    .int()
    .min(1)
    .max(12)
    .default(4)
    .describe(
      "Maximum recursion depth into shape layer vector groups (default: 4, max: 12)."
    ),
  meta: z
    .boolean()
    .optional()
    .describe(
      "Opt in to what each property accepts and how its expression is doing: per property `meta` (value_type, units, min/max, spatial, can_vary, can_expression, is_modified, separation, and the items of a dropdown on AE 26), " +
        "a fresh `expressionError` (the expression is evaluated once with valueAtTime(t, false); nothing changes), and Shape values with num_vertices. Makes the reply larger; default false."
    ),
  text_full: z
    .boolean()
    .optional()
    .describe(
      "Opt in to the whole TextDocument in the text section (every attribute AE gives, with `mixed` naming the ones that differ across the text), added next to the fields that are always returned. Default false."
    ),
  bounds: z
    .object({
      time: z.number().optional().describe("When to read sourceRectAtTime, seconds. Default the comp's current time."),
      corners: z.boolean().optional().describe("Include the four corners of the source rectangle in comp space (default true)."),
      points_to_comp: z
        .array(z.tuple([z.number(), z.number()]))
        .max(100)
        .optional()
        .describe("Layer-space [x, y] points to convert to comp space (AVLayer.sourcePointToComp)."),
      points_to_layer: z
        .array(z.tuple([z.number(), z.number()]))
        .max(100)
        .optional()
        .describe("Comp-space [x, y] points to convert to layer space (AVLayer.compPointToSource)."),
    })
    .optional()
    .describe(
      "Opt in to the layer's box: sourceRectAtTime, width, height, the four corners in comp space and optional point conversions, all through After Effects' own parent-chain maths. " +
        "The conversion methods take no time: they use the comp's current time, and the reply warns when `time` differs. On text layers they reflect only the first character (a warning says so)."
    ),
});

export const AeFindLayersSchema = z.object({
  comp_id: z
    .number()
    .int()
    .optional()
    .describe(
      "Optional CompItem ID to search within. If omitted, searches across all compositions in the project."
    ),
  name_contains: z
    .string()
    .min(1)
    .optional()
    .describe("Case-insensitive substring match against layer name."),
  type: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Layer type filter (e.g. 'text', 'shape', 'camera', 'light', 'null', 'adjustment', 'precomp', 'solid', 'av', 'audio', 'model_3d' (3D model layers), 'parametric_mesh', or AE class names like 'TextLayer', 'ShapeLayer', 'AVLayer')."
    ),
  has_effect_match_name: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Match layers that have an applied effect matching this matchName (or display name), case-insensitively."
    ),
  has_expression: z
    .boolean()
    .optional()
    .describe(
      "If true, only layers with at least one expression; if false, only layers with no expressions."
    ),
  source_id: z
    .number()
    .int()
    .optional()
    .describe("Match layers whose source item has this project item ID."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(200)
    .describe("Maximum number of matching layers to return (default: 200, max: 500)."),
});

export const AeListEffectsSchema = z.object({
  filter: z
    .string()
    .optional()
    .describe(
      "Optional case-insensitive substring filter matched against displayName, matchName, or category."
    ),
});

export const AeValidateExpressionsSchema = z
  .object({
  comp_id: z
    .number()
    .int()
    .describe("The CompItem ID whose layer expressions should be validated."),
  layer: LayerSelectorSchema.optional().describe(
    "Optional layer selector to restrict validation to a single layer (defaults to all layers in the comp)."
  ),
  time: z
    .number()
    .optional()
    .describe(
      "Optional evaluation time in seconds passed to prop.valueAtTime(t, false) (defaults to comp.time without changing comp.time)."
    ),
  fix: z
    .object({
      find: z.string().min(1).max(2000).describe("The text to replace in broken expressions, e.g. an old layer name inside layer(\"Old\")."),
      replace: z.string().max(2000).describe("The text to put in its place (may be empty)."),
    })
    .optional()
    .describe(
      "Repair broken expressions by find/replace through Project.autoFixExpressions. Without apply it only lists the erroring expressions of the comp that contain `find` (a dry run, read-only). " +
        "autoFixExpressions always acts on the WHOLE PROJECT, never one comp or layer: comp_id and layer only limit what is reported."
    ),
  apply: z.boolean().optional().describe("With fix: run it. Needs expect. A checkpoint is taken first; the result is re-validated in a separate evalScript and reports fixed and still_broken."),
  expect: ExpectSchema.optional(),
  })
  .refine((v) => v.apply !== true || v.fix !== undefined, { message: "apply needs fix." })
  .refine((v) => v.apply !== true || v.expect !== undefined, { message: "apply needs expect." });

// ---------- expression fix ----------

export interface ExpressionScanEntry {
  layer: { index: number; id: number; name: string };
  path: string[];
  expression: string;
  expressionEnabled: boolean;
  error: string;
  contains_find?: boolean;
}

export interface ExpressionScan {
  comp_id: number;
  total_expressions: number;
  error_count: number;
  truncated: boolean;
  results: ExpressionScanEntry[];
  find_matches?: number;
}

export const FIX_SCOPE_NOTE =
  "Project.autoFixExpressions acts on the whole project: every broken expression containing the text is rewritten in every comp, not only the ones listed here (the list is limited to this comp or layer).";

/** The erroring expressions whose full text contains `find` (the host decides on the whole expression, not the preview). */
export function brokenWith(scan: ExpressionScan | null | undefined): ExpressionScanEntry[] {
  return (scan?.results ?? []).filter((r) => r.error !== "" && r.contains_find === true);
}

const entryKey = (e: ExpressionScanEntry) => `${e.layer.id}|${e.path.join(">")}`;

export function fixReport(
  fix: { find: string; replace: string },
  before: ExpressionScan | null,
  after: ExpressionScan | null,
  written: Record<string, unknown>
): Record<string, unknown> {
  const was = brokenWith(before);
  const nowBroken = new Map<string, ExpressionScanEntry>();
  for (const r of after?.results ?? []) if (r.error !== "") nowBroken.set(entryKey(r), r);
  const fixed = was.filter((e) => !nowBroken.has(entryKey(e)));
  const still = was.filter((e) => nowBroken.has(entryKey(e))).map((e) => nowBroken.get(entryKey(e)) as ExpressionScanEntry);
  return {
    fix,
    scope: "project",
    scope_note: FIX_SCOPE_NOTE,
    ...(written.no_op === true ? { no_op: true, note: written.note } : {}),
    matched_in_project: written.matched_before,
    listed_before: was.length,
    fixed_count: fixed.length,
    fixed: fixed.map((e) => ({ layer: e.layer, path: e.path })),
    still_broken_count: still.length,
    still_broken: still,
    broken_remaining_in_comp: after?.error_count,
    ...(written.scan_truncated === true ? { scan_truncated: true } : {}),
  };
}

export function fixMismatches(
  fix: { find: string; replace: string },
  before: ExpressionScan | null,
  after: ExpressionScan | null,
  written: Record<string, unknown>
): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  if (!after || written.no_op === true) return m;
  const was = brokenWith(before);
  const nowKeys = new Set((after.results ?? []).filter((r) => r.error !== "").map(entryKey));
  const left = was.filter((e) => nowKeys.has(entryKey(e)));
  expectThat(
    m,
    left.length === 0,
    "expressions.still_broken",
    0,
    left.length,
    `${left.length} expression${left.length === 1 ? " is" : "s are"} still broken after the repair (replace "${fix.find}" with "${fix.replace}" did not fix them)`
  );
  return m;
}

export const exploreTools: ToolDefinition<any>[] = [
  {
    name: "ae_get_layer_full",
    description:
      "Read everything about a layer in one bounded call: layer metadata plus optional sections (transform, effects, masks, text, shapes, expressions, keyframes, markers). " +
      "Opt-in extras (they make the reply larger): meta (what every property accepts, plus a fresh expression error and Shape values with vertex counts), text_full (the whole TextDocument) and bounds (source rectangle, width, height, comp-space corners and point conversions). " +
      "layer.kind also says model_3d and parametric_mesh. Read-only: never modifies project or composition state. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeGetLayerFullSchema,
    handler: async (args, ctx) => {
      const max_keyframes = args.max_keyframes ?? 100;
      const shape_depth = args.shape_depth ?? 4;
      const res = await ctx.bridge.callHost(
        "getLayerFull",
        {
          comp_id: args.comp_id,
          layer: args.layer,
          include: args.include,
          max_keyframes,
          shape_depth,
          meta: args.meta,
          text_full: args.text_full,
          bounds: args.bounds,
        },
        {
          label: `ae_get_layer_full(${args.comp_id})`,
          mutates: false,
          toolName: "ae_get_layer_full",
        }
      );
      return res.result;
    },
  },
  {
    name: "ae_find_layers",
    description:
      "Search one composition or all compositions in the project for layers matching filters (name_contains, type including model_3d and parametric_mesh, has_effect_match_name, has_expression, source_id), up to `limit` (default 200). " +
      "Read-only: never modifies project or composition state. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeFindLayersSchema,
    handler: async (args, ctx) => {
      const limit = args.limit ?? 200;
      const res = await ctx.bridge.callHost(
        "findLayers",
        {
          comp_id: args.comp_id,
          name_contains: args.name_contains,
          type: args.type,
          has_effect_match_name: args.has_effect_match_name,
          has_expression: args.has_expression,
          source_id: args.source_id,
          limit,
        },
        {
          label:
            args.comp_id !== undefined
              ? `ae_find_layers(${args.comp_id})`
              : "ae_find_layers(all)",
          mutates: false,
          toolName: "ae_find_layers",
        }
      );
      return res.result;
    },
  },
  {
    name: "ae_list_effects",
    description:
      "List installed After Effects effects from `app.effects` (displayName, matchName, category, version), optionally filtered by substring and bounded to 500 entries. " +
      "Read-only: never modifies project or composition state. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeListEffectsSchema,
    handler: async (args, ctx) => {
      const res = await ctx.bridge.callHost(
        "listEffects",
        {
          filter: args.filter,
        },
        {
          label: args.filter
            ? `ae_list_effects(${args.filter})`
            : "ae_list_effects",
          mutates: false,
          toolName: "ae_list_effects",
        }
      );
      return res.result;
    },
  },
  {
    name: "ae_validate_expressions",
    description:
      "Walk all properties with expressions in a composition (or a single layer), force evaluation via `prop.valueAtTime(t, false)` inside try/catch, and read `prop.expressionError` without ever toggling `expressionEnabled` or mutating `comp.time`. " +
      "Returns `results: [{layer, path, expression, expressionEnabled, error}]` along with counts. " +
      "With `fix: {find, replace}` it lists the erroring expressions that contain `find` (dry run); with `apply` and `expect` it repairs them with Project.autoFixExpressions " +
      "in one undo group after an automatic checkpoint, then validates again in a separate evalScript and reports fixed and still_broken. " +
      "autoFixExpressions works on the WHOLE PROJECT (every broken expression containing the text, in every comp), so comp_id and layer only limit what is listed. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeValidateExpressionsSchema,
    handler: async (args, ctx) => {
      const fix = args.fix as { find: string; replace: string } | undefined;
      if (!fix) {
        const res = await ctx.bridge.callHost(
          "validateExpressions",
          {
            comp_id: args.comp_id,
            layer: args.layer,
            time: args.time,
          },
          {
            label: `ae_validate_expressions(${args.comp_id})`,
            mutates: false,
            toolName: "ae_validate_expressions",
          }
        );
        return res.result;
      }
      const readArgs = { comp_id: args.comp_id, layer: args.layer, time: args.time, find: fix.find };
      if (!args.apply) {
        const res = await ctx.bridge.callHost<ExpressionScan>("validateExpressions", readArgs, {
          label: `ae_validate_expressions(${args.comp_id}, fix dry run)`,
          mutates: false,
          toolName: "ae_validate_expressions",
          timeoutMs: SLOW_TIMEOUT_MS,
        });
        const would = brokenWith(res.result);
        return {
          ...res.result,
          dry_run: true,
          fix,
          would_fix_count: would.length,
          would_fix: would,
          scope_note: FIX_SCOPE_NOTE,
        };
      }
      if (!args.expect) return { ok: false, error: "bad_args", message: "apply needs expect." };
      return runGuardedWrite(ctx, {
        toolName: "ae_validate_expressions",
        label: `ae_validate_expressions(${args.comp_id}, fix)`,
        expect: args.expect,
        compId: args.comp_id,
        read: () => ({ host: "validateExpressions", args: readArgs, timeoutMs: SLOW_TIMEOUT_MS }),
        write: { host: "exploreAutoFixExpressions", args: { find: fix.find, replace: fix.replace, label: "Fix expressions" }, timeoutMs: SLOW_TIMEOUT_MS },
        check: (before, after, written) => fixMismatches(fix, before as ExpressionScan | null, after as ExpressionScan | null, written),
        present: (before, after, written) => fixReport(fix, before as ExpressionScan | null, after as ExpressionScan | null, written),
      });
    },
  },
];
