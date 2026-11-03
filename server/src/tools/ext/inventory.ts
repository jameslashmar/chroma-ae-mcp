/**
 * server/src/tools/ext/inventory.ts
 *
 * Read-only project inventory:
 * - ae_comp_tree: which comps nest which, where a comp is used, top-level and
 *   unused comps (render queue membership included)
 * - ae_fonts: the fonts text layers use (keyframed source text too), who uses
 *   them, and which are missing or substituted (AE 24+; `missing_known`
 *   says when AE couldn't tell)
 */

import { z } from "zod";
import type { ToolDefinition } from "../common.js";

export const AeCompTreeSchema = z.object({
  comp_id: z
    .number()
    .int()
    .optional()
    .describe("Show this comp's tree: what it contains, down, and where it is used, up. Default: an overview of every comp."),
  depth: z.number().int().min(1).max(50).optional().describe("How many levels to follow (default 10)."),
});

export const AeFontsSchema = z.object({
  comp_id: z.number().int().optional().describe("Only this comp's text layers. Default: the whole project."),
  missing_only: z.boolean().optional().describe("List only missing or substituted fonts."),
});

export const inventoryTools: ToolDefinition<any>[] = [
  {
    name: "ae_comp_tree",
    description:
      "Read how comps nest. Without comp_id: every comp with how many comps use it, how many it contains, its nesting depth and whether it is in the render queue, " +
      "plus the top-level comps (used nowhere, but rendered or containing others) and the unused ones (used nowhere, containing nothing, not queued). " +
      "With comp_id: what that comp contains, level by level (with the layers that hold each precomp), and where it is used, up to the top. Read-only.",
    schema: AeCompTreeSchema,
    handler: async (args: z.infer<typeof AeCompTreeSchema>, ctx) => {
      const res = await ctx.bridge.callHost("compTree", { comp_id: args.comp_id, depth: args.depth }, {
        label: "ae_comp_tree",
        mutates: false,
        toolName: "ae_comp_tree",
      });
      return res.result;
    },
  },
  {
    name: "ae_fonts",
    description:
      "List the fonts the project's text layers use (each keyframe of animated source text counts), with the family, style, file location, how many uses and which layers, " +
      "and whether AE is substituting the font because it is missing (AE 24+; missing_known is false when AE couldn't say). Read-only. " +
      "Check them against the brief's fonts (ae_brief) before a delivery.",
    schema: AeFontsSchema,
    handler: async (args: z.infer<typeof AeFontsSchema>, ctx) => {
      const res = await ctx.bridge.callHost<{ fonts: Array<{ missing: boolean | null }>; [k: string]: unknown }>(
        "fontsInUse",
        { comp_id: args.comp_id },
        { label: "ae_fonts", mutates: false, toolName: "ae_fonts" }
      );
      const r = res.result;
      return args.missing_only ? { ...r, fonts: r.fonts.filter((f) => f.missing === true) } : r;
    },
  },
];
