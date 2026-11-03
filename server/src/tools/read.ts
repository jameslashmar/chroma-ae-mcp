import { z } from "zod";
import {
  AGENT_SAFETY_GUIDANCE,
  LayerSelectorSchema,
  type ToolDefinition,
} from "./common.js";

export const AeStatusSchema = z.object({});

export const AeGetProjectSchema = z.object({
  folder_id: z
    .number()
    .int()
    .optional()
    .describe("Optional folder item ID to start traversal from (defaults to root)."),
  depth: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(3)
    .optional()
    .describe("Maximum folder traversal depth (default: 3)."),
  type: z
    .enum(["comp", "footage", "solid", "folder", "placeholder"])
    .optional()
    .describe("Only items of this kind (a flat, paged list). Footage excludes solids and placeholders."),
  name_contains: z.string().min(1).optional().describe("Only items whose name contains this (case-insensitive)."),
  missing_only: z.boolean().optional().describe("Only footage whose file is missing."),
  sort: z.enum(["tree", "name", "id"]).optional().describe("Order of a filtered or paged list. Default tree (the folder walk)."),
  offset: z.number().int().min(0).optional().describe("Skip this many matches (paging; see next_offset)."),
  limit: z.number().int().min(1).max(500).optional().describe("At most this many items (default and maximum 500)."),
});

const PagingFields = {
  offset: z.number().int().min(0).optional().describe("Skip this many layers (paging; see next_offset)."),
  limit: z.number().int().min(1).max(500).optional().describe("At most this many layers (default and maximum 500)."),
};

export const AeGetCompSchema = z.object({
  comp_id: z
    .number()
    .int()
    .describe("The CompItem ID to inspect."),
  name_contains: z.string().min(1).optional().describe("Only layers whose name contains this (case-insensitive)."),
  ...PagingFields,
});

export const AeGetLayerPropsSchema = z.object({
  comp_id: z
    .number()
    .int()
    .describe("The CompItem ID containing the layer."),
  layer: LayerSelectorSchema,
  path: z
    .array(z.string())
    .optional()
    .describe(
      "Optional property group path (e.g. ['ADBE Transform Group', 'ADBE Opacity'] or ['Transform', 'Opacity'])."
    ),
  depth: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(2)
    .optional()
    .describe("Depth of property tree traversal (default: 2)."),
});

export const readTools: ToolDefinition<any>[] = [
  {
    name: "ae_status",
    description:
      "Read panel health (/health), AE version, current project path (or '<unsaved>'), dirty flag, active comp {id, name}, selected layers, and the server quarantine list. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeStatusSchema,
    handler: async (_args, ctx) => {
      const health = ctx.bridge.health
        ? await ctx.bridge.health()
        : { ok: true, transport: "panel" as const };
      const hostStatus = await ctx.bridge.callHost<Record<string, unknown>>(
        "status",
        {},
        {
          label: "ae_status",
          mutates: false,
          toolName: "ae_status",
        }
      );
      return {
        health,
        ...(hostStatus.result ?? {}),
        quarantine: ctx.quarantine.list(),
      };
    },
  },
  {
    name: "ae_get_project",
    description:
      "Read the project item tree: id, name, typeName, parent folder id; compositions include width, height, fps, duration; footage items include file path and missing: true when the file is gone. " +
      "For big projects, filter by kind, name or missing footage, sort, and page with offset/limit: the result then has total and next_offset. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeGetProjectSchema,
    handler: async (args, ctx) => {
      const depth = args.depth ?? 3;
      const res = await ctx.bridge.callHost(
        "getProject",
        {
          folder_id: args.folder_id,
          depth: args.type || args.name_contains || args.missing_only ? args.depth ?? 20 : depth,
          type: args.type,
          name_contains: args.name_contains,
          missing_only: args.missing_only,
          sort: args.sort === "tree" ? undefined : args.sort,
          offset: args.offset,
          limit: args.limit,
        },
        {
          label: "ae_get_project",
          mutates: false,
          toolName: "ae_get_project",
        }
      );
      return res.result;
    },
  },
  {
    name: "ae_get_comp",
    description:
      "Read composition settings, work area, and layers (index, name, id, type, in/out, parent, enabled, solo, locked, label, 3D, blending mode, track matte). " +
      "Comps with more than 500 layers page with offset/limit (next_offset says where to continue); name_contains filters the layers. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeGetCompSchema,
    handler: async (args, ctx) => {
      const res = await ctx.bridge.callHost(
        "getComp",
        { comp_id: args.comp_id, name_contains: args.name_contains, offset: args.offset, limit: args.limit },
        {
          label: `ae_get_comp(${args.comp_id})`,
          mutates: false,
          toolName: "ae_get_comp",
        }
      );
      return res.result;
    },
  },
  {
    name: "ae_get_layer_props",
    description:
      "Read a layer's property tree with matchName, name, value (serialised), numKeys, expression, and expressionEnabled. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeGetLayerPropsSchema,
    handler: async (args, ctx) => {
      const depth = args.depth ?? 2;
      const res = await ctx.bridge.callHost(
        "getLayerProps",
        {
          comp_id: args.comp_id,
          layer: args.layer,
          path: args.path,
          depth,
        },
        {
          label: `ae_get_layer_props(${args.comp_id})`,
          mutates: false,
          toolName: "ae_get_layer_props",
        }
      );
      return res.result;
    },
  },
];
