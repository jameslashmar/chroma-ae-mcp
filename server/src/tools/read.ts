import { z } from "zod";
import {
  AGENT_SAFETY_GUIDANCE,
  LayerSelectorSchema,
  type ToolDefinition,
} from "./common.js";

export const AeStatusSchema = z.object({
  detail: z
    .boolean()
    .optional()
    .describe(
      "Also read what the user is working with and the environment, under `detail`: the active item of any kind, the Project panel selection, the active comp's time and frame, the selected properties (each with a path ae_set_property accepts, and its selected keys), the viewer, tool, build, UI language, GPU, OS, project revision and whether rendering is disabled. Default false: the reply is then unchanged."
    ),
});

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
    .optional()
    .describe("Maximum folder traversal depth. Default 3 for the tree; 20 (every level) for a filtered, sorted or paged list."),
  type: z
    .enum(["comp", "footage", "solid", "folder", "placeholder"])
    .optional()
    .describe("Only items of this kind (a flat, paged list). Footage excludes solids and placeholders."),
  name_contains: z.string().min(1).optional().describe("Only items whose name contains this (case-insensitive)."),
  missing_only: z.boolean().optional().describe("Only footage whose file is missing (placeholders are not included; use type placeholder)."),
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
    .array(z.union([z.string(), z.number().int().min(1)]))
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
  meta: z
    .boolean()
    .optional()
    .describe(
      "Add `meta` to every property: value_type, units, min and max, spatial, can_vary, can_expression, is_modified, separation (is_leader, dimensions_separated, is_follower, followers), and on AE 26 the dropdown items and value_text. Also gives Shape and MarkerValue values as data, and the full TextDocument (every attribute, with `mixed` listing the ones that read as mixed). Default false: payloads stay small."
    ),
  shape_values: z
    .boolean()
    .optional()
    .describe(
      "Give mask/shape path values (vertices, inTangents, outTangents, closed; at most 500 vertices, with the feather point count) and marker values (comment, duration, chapter, url, frameTarget, cuePointName, label, protectedRegion, params) as data instead of '[Shape]' / '[MarkerValue]'. Default false."
    ),
});

export const readTools: ToolDefinition<any>[] = [
  {
    name: "ae_status",
    description:
      "Read panel health (/health), AE version, current project path (or '<unsaved>'), dirty flag, active comp {id, name}, selected layers, and the server quarantine list. " +
      "With `detail: true` it adds `detail`: the active item of any kind (a footage or folder too), the Project panel selection, the active comp's time and frame and work area, the selected properties as {layer_id, layer_index, path, name, match_name, is_group, selected_keys} (path is the format ae_set_property takes), the viewer, tool, build, UI language, GPU, OS and project revision, plus warnings (rendering disabled makes ae_snapshot_frame, ae_contact_sheet and ae_ui_screenshot show stale or blank frames) and `missing` (members this AE version does not have). Selection can change between this read and a write: act on explicit ids and indexes with `expect`. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeStatusSchema,
    handler: async (args, ctx) => {
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
      let detail: Record<string, unknown> | undefined;
      if (args.detail === true) {
        // A second, separate read; the base reply must not depend on it.
        try {
          const d = await ctx.bridge.callHost<Record<string, unknown>>(
            "statusDetail",
            {},
            { label: "ae_status (detail)", mutates: false, toolName: "ae_status" }
          );
          detail = d.result ?? {};
        } catch (err) {
          detail = { error: err instanceof Error ? err.message : String(err) };
        }
      }
      return {
        health,
        ...(hostStatus.result ?? {}),
        quarantine: ctx.quarantine.list(),
        ...(detail ? { detail } : {}),
      };
    },
  },
  {
    name: "ae_get_project",
    description:
      "Read the project item tree: id, name, typeName, parent folder id; compositions include width, height, fps, duration; footage items include file path and missing: true when the file is gone (a placeholder has placeholder: true instead). " +
      "For big projects, filter by kind, name or missing footage, sort, and page with offset/limit: the result then has total and next_offset (and walks every folder level unless depth is given). " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeGetProjectSchema,
    handler: async (args, ctx) => {
      const sort = args.sort === "tree" ? undefined : args.sort;
      // Same test as the host: any filter, sort or paging gives the flat list, which walks every level.
      const flat = !!(args.type || args.name_contains || args.missing_only || sort || args.offset !== undefined || args.limit !== undefined);
      const res = await ctx.bridge.callHost(
        "getProject",
        {
          folder_id: args.folder_id,
          depth: flat ? args.depth ?? 20 : args.depth ?? 3,
          type: args.type,
          name_contains: args.name_contains,
          missing_only: args.missing_only,
          sort,
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
      "`meta: true` adds what each property accepts (value type, units, min/max, spatial, separation, dropdown items), full text documents and path/marker values; `shape_values: true` gives just the path and marker values. " +
      "Mask and shape path keys are written with ae_set_property as { vertices, inTangents?, outTangents?, closed? } (ae_path_write keeps feather points and can change the vertex count). " +
      "Text path options live under 'ADBE Text Path Options' (Path is a mask-index dropdown, 0 = none, the mask must be on the same text layer; also Reverse Path, Perpendicular To Path, Force Alignment, First Margin, Last Margin): check the exact child match names with meta before writing. " +
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
          meta: args.meta,
          shape_values: args.shape_values,
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
