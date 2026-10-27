// explore.ts: Read-only layer/comp/effect exploration and expression validation tools.
//
// Credits:
// - ae_get_layer_full and ae_find_layers ideas adapted from reference/engine-room/packages/jsx/explore.jsx
//   (Engine-Room-Games/after-effects-mcp, MIT License).

import { z } from "zod";
import {
  AGENT_SAFETY_GUIDANCE,
  LayerSelectorSchema,
  type ToolDefinition,
} from "../common.js";

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
      "Layer type filter (e.g. 'text', 'shape', 'camera', 'light', 'null', 'adjustment', 'precomp', 'solid', 'av', 'audio', or AE class names like 'TextLayer', 'ShapeLayer', 'AVLayer')."
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

export const AeValidateExpressionsSchema = z.object({
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
});

export const exploreTools: ToolDefinition<any>[] = [
  {
    name: "ae_get_layer_full",
    description:
      "Read everything about a layer in one bounded call: layer metadata plus optional sections (transform, effects, masks, text, shapes, expressions, keyframes, markers). " +
      "Read-only: never modifies project or composition state. " +
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
      "Search one composition or all compositions in the project for layers matching filters (name_contains, type, has_effect_match_name, has_expression, source_id), up to `limit` (default 200). " +
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
      AGENT_SAFETY_GUIDANCE,
    schema: AeValidateExpressionsSchema,
    handler: async (args, ctx) => {
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
    },
  },
];
