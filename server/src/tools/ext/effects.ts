/**
 * server/src/tools/ext/effects.ts
 *
 * Effect tools:
 * - ae_add_effect, ae_set_effect, ae_remove_effect: guarded writes with a
 *   read-back of the layer's effects in a separate evalScript
 * - ae_apply_preset: applies an animation preset (.ffx) to one layer
 * - ae_list_presets: finds .ffx presets in AE's and the user's preset folders
 *
 * Parameters that hold arbitrary data (Colorama's Output Cycle, the Curves
 * curve) can't be set by scripts; the listing marks them `settable: false`,
 * and the way to get them in is a preset saved from AE.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { BridgeError } from "../../host.js";
import { buildJsxCall } from "../../jsx.js";
import { QueueWaitError } from "../../queue.js";
import { buildReceipt, compareValues, type ReceiptMismatch } from "../../receipts.js";
import {
  AGENT_SAFETY_GUIDANCE,
  ExpectSchema,
  LayerSelectorSchema,
  type ExpectGuard,
  type ToolContext,
  type ToolDefinition,
} from "../common.js";
import { autoCheckpoint, verifyTargetGuard } from "../mutate.js";

// ---------- schemas ----------

export const EffectSelectorSchema = z
  .object({
    index: z.number().int().positive().optional().describe("1-based position in the layer's Effects."),
    name: z.string().min(1).optional().describe("Effect name as shown on the layer (refused if several share it)."),
  })
  .refine((v) => v.index !== undefined || v.name !== undefined, {
    message: "Effect selector needs index or name.",
  })
  .describe("Which effect on the layer, by index or name.");

export const EffectParamSchema = z.object({
  param: z
    .union([z.string().min(1), z.number().int().positive()])
    .describe("Parameter display name (e.g. 'Blurriness'), match name, or 1-based index."),
  value: z
    .union([z.number(), z.boolean(), z.array(z.number())])
    .describe(
      "Number, boolean (checkboxes), or array (points, colors as [r, g, b] or [r, g, b, a] in 0..1). Popups take their 1-based item number; layer pickers take a layer index (0 for none)."
    ),
});

const ParamsSchema = z
  .array(EffectParamSchema)
  .max(100)
  .optional()
  .describe(
    "Static values to set. An animated parameter gets the value at the comp's current time; for keyframes or expressions use ae_set_property with the path ['ADBE Effect Parade', <effect name>, <param>]."
  );

export const AeAddEffectSchema = z.object({
  comp_id: z.number().int(),
  layer: LayerSelectorSchema,
  effect: z
    .string()
    .min(1)
    .describe("Match name (e.g. 'ADBE Gaussian Blur 2', 'APC Colorama') or display name. Look it up with ae_list_effects."),
  name: z.string().min(1).max(200).optional().describe("Rename the new effect."),
  params: ParamsSchema,
  expect: ExpectSchema,
});

export const AeSetEffectSchema = z
  .object({
    comp_id: z.number().int(),
    layer: LayerSelectorSchema,
    effect: EffectSelectorSchema,
    enabled: z.boolean().optional().describe("Turn the effect on or off (the fx switch)."),
    name: z.string().min(1).max(200).optional().describe("Rename the effect."),
    params: ParamsSchema,
    expect: ExpectSchema,
  })
  .refine((v) => v.enabled !== undefined || v.name !== undefined || (v.params?.length ?? 0) > 0, {
    message: "Give at least one of enabled, name, or params.",
  });

export const AeRemoveEffectSchema = z.object({
  comp_id: z.number().int(),
  layer: LayerSelectorSchema,
  effect: EffectSelectorSchema,
  expect: ExpectSchema,
});

export const AeApplyPresetSchema = z.object({
  comp_id: z.number().int(),
  layer: LayerSelectorSchema,
  preset_path: z.string().min(1).describe("Absolute path of the .ffx animation preset (see ae_list_presets)."),
  expect: ExpectSchema,
});

export const AeListPresetsSchema = z.object({
  filter: z
    .string()
    .optional()
    .describe("Case-insensitive text to match in the preset's folder and file name, e.g. 'glow' or 'Transitions - Wipes'."),
  source: z.enum(["all", "user", "app"]).optional().describe("'user' is the user's own User Presets folders. Default all."),
  limit: z.number().int().min(1).max(500).optional().describe("Default 100."),
});

// ---------- read-back checks ----------

interface ParamSnapshot {
  index: number;
  name: string;
  matchName: string;
  path: string[];
  type: string;
  settable: boolean;
  value?: unknown;
}

interface EffectSnapshot {
  index: number;
  name: string;
  matchName: string;
  enabled: boolean;
  params: ParamSnapshot[];
}

interface LayerEffects {
  effects: EffectSnapshot[];
}

type ParamInput = z.infer<typeof EffectParamSchema>;

function findParamSnapshot(effect: EffectSnapshot | undefined, key: string | number): ParamSnapshot | undefined {
  if (!effect) return undefined;
  if (typeof key === "number") return effect.params.find((p) => p.path.length === 1 && p.index === key);
  return effect.params.find((p) => p.name === key || p.matchName === key);
}

/** The value AE reports after setting `value` on a parameter of `type`. */
export function expectedParamValue(type: string, value: ParamInput["value"]): unknown {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (type === "color" && Array.isArray(value) && value.length === 3) return [...value, 1];
  return value;
}

export function paramMismatches(
  effect: EffectSnapshot | undefined,
  params: ParamInput[] | undefined,
  written: Array<{ param: string; how: string }> | undefined
): ReceiptMismatch[] {
  const mismatches: ReceiptMismatch[] = [];
  (params ?? []).forEach((p, i) => {
    // Animated parameters were set at the comp's current time; their value elsewhere differs.
    if (written?.[i]?.how === "value_at_current_time") return;
    const snap = findParamSnapshot(effect, p.param);
    if (!snap) {
      mismatches.push({ path: `params.${p.param}`, expected: p.value, actual: undefined, message: `Parameter ${p.param} not found in read-back` });
      return;
    }
    compareValues(expectedParamValue(snap.type, p.value), snap.value, `params.${snap.name}`, mismatches);
  });
  return mismatches;
}

function effectAt(snapshot: unknown, index: number | undefined): EffectSnapshot | undefined {
  const effects = (snapshot as LayerEffects | null)?.effects ?? [];
  return effects.find((e) => e.index === index);
}

function effectCount(snapshot: unknown): number {
  return ((snapshot as LayerEffects | null)?.effects ?? []).length;
}

// ---------- shared write runner ----------

interface WriteSpec<A> {
  toolName: string;
  label: string;
  host: string;
  hostArgs: (args: A, expect: ExpectGuard) => Record<string, unknown>;
  check: (args: A, before: unknown, after: unknown, written: Record<string, unknown>) => ReceiptMismatch[];
  present: (args: A, before: unknown, after: unknown, written: Record<string, unknown>) => Record<string, unknown>;
}

async function runEffectWrite<A extends { comp_id: number; layer: unknown; expect: ExpectGuard }>(
  args: A,
  ctx: ToolContext,
  spec: WriteSpec<A>
) {
  ctx.quarantine.assertClear();
  const opId = ctx.bridge.newOpId();
  const effectiveExpect: ExpectGuard = {
    project_path: args.expect.project_path,
    comp_id: args.expect.comp_id ?? args.comp_id,
  };
  const readEffects = (suffix: string) =>
    ctx.bridge.evalRaw({
      id: `${opId}_${suffix}`,
      script: buildJsxCall("listLayerEffects", { comp_id: args.comp_id, layer: args.layer }),
      label: `${spec.label} (${suffix})`,
      mutates: false,
      toolName: spec.toolName,
    });

  try {
    return await ctx.queue.run(spec.label, async () => {
      ctx.quarantine.assertClear();
      const guard = await verifyTargetGuard(ctx, effectiveExpect, opId);
      const checkpoint = await autoCheckpoint(ctx, guard, spec.toolName);
      const before = await readEffects("before");
      const write = await ctx.bridge.evalRaw<Record<string, unknown>>({
        id: opId,
        script: buildJsxCall(spec.host, spec.hostArgs(args, effectiveExpect)),
        label: spec.label,
        mutates: true,
        toolName: spec.toolName,
      });
      // Separate evalScript for the read-back.
      const after = await readEffects("after");
      const written = write.result ?? {};
      const receipt = buildReceipt({
        before: before.result,
        after: after.result,
        customMismatches: spec.check(args, before.result, after.result, written),
      });
      return {
        op_id: opId,
        applied: true as const,
        ...spec.present(args, before.result, after.result, written),
        checkpoint,
        receipt,
      };
    });
  } catch (err) {
    if (err instanceof QueueWaitError) {
      throw new BridgeError({ kind: "queued", op_id: opId, message: err.message });
    }
    throw err;
  }
}

// ---------- presets on disk ----------

export interface PresetEntry {
  name: string;
  path: string;
  category: string;
  source: "user" | "app";
}

const MAX_PRESET_FILES = 20000;
const MAX_PRESET_DEPTH = 8;

export function findPresets(
  folders: Array<{ kind: string; path: string }>,
  filter: string | undefined,
  source: "all" | "user" | "app"
): { presets: PresetEntry[]; scanned: number } {
  const needle = filter?.trim().toLowerCase() ?? "";
  const presets: PresetEntry[] = [];
  let scanned = 0;
  for (const folder of folders) {
    const kind = folder.kind === "user" ? "user" : "app";
    if (source !== "all" && source !== kind) continue;
    const walk = (dir: string, depth: number) => {
      if (depth > MAX_PRESET_DEPTH || scanned >= MAX_PRESET_FILES) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(full, depth + 1);
        } else if (/\.ffx$/i.test(e.name)) {
          scanned++;
          const category = path.relative(folder.path, dir).split(path.sep).join("/");
          const name = e.name.replace(/\.ffx$/i, "");
          if (!needle || `${category}/${name}`.toLowerCase().includes(needle)) {
            presets.push({ name, path: full, category: category || path.basename(folder.path), source: kind });
          }
        }
      }
    };
    walk(folder.path, 0);
  }
  presets.sort((a, b) => (a.source === b.source ? a.path.localeCompare(b.path) : a.source === "user" ? -1 : 1));
  return { presets, scanned };
}

// ---------- tools ----------

const PRESET_HINT =
  "Parameters marked settable: false (custom data such as Colorama's Output Cycle or the Curves curve) can't be read or set by script; AE refuses it. Measured routes, all inside AE: " +
  "(1) link it by expression to the same parameter of an effect the user set up by hand (ae_set_property on the path ['ADBE Effect Parade', <effect name>, <param matchName>], since a section header can share the param's display name, with an expression such as thisComp.layer(\"Look\").effect(\"Colorama\")(\"Output Cycle\"); `linkable_by_expression` says when this works); " +
  "(2) apply an animation preset saved from AE (Animation > Save Animation Preset) with ae_apply_preset; " +
  "(3) the effect's own preset menu, if any (Colorama's 'Use Preset Palette' is an ordinary settable popup).";

export const effectsTools: ToolDefinition<any>[] = [
  {
    name: "ae_add_effect",
    description:
      "Add an effect to a layer, optionally renamed and with static parameter values, in one undo group guarded by `expect`. " +
      "Returns the effect's index and every parameter (name, match name, type, value, settable), read back in a separate evalScript. " +
      "Find the effect's match name with ae_list_effects; display names vary by AE language. " +
      PRESET_HINT +
      " " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeAddEffectSchema,
    handler: (args: z.infer<typeof AeAddEffectSchema>, ctx) =>
      runEffectWrite(args, ctx, {
        toolName: "ae_add_effect",
        label: `ae_add_effect(${args.effect})`,
        host: "addEffect",
        hostArgs: (a, expect) => ({ comp_id: a.comp_id, layer: a.layer, effect: a.effect, name: a.name, params: a.params, expect }),
        check: (a, before, after, w) => {
          const mismatches: ReceiptMismatch[] = [];
          if (effectCount(after) !== effectCount(before) + 1) {
            mismatches.push({ path: "effects.length", expected: effectCount(before) + 1, actual: effectCount(after), message: "Effect count did not grow by one" });
          }
          const fx = effectAt(after, w.index as number);
          compareValues(w.matchName, fx?.matchName, "effect.matchName", mismatches);
          if (a.name) compareValues(a.name, fx?.name, "effect.name", mismatches);
          return [...mismatches, ...paramMismatches(fx, a.params, w.params_set as any)];
        },
        present: (_a, _before, after, w) => ({ effect: effectAt(after, w.index as number) ?? w }),
      }),
  },
  {
    name: "ae_set_effect",
    description:
      "Change an effect on a layer: turn it on or off, rename it, or set static parameter values, in one undo group guarded by `expect`, with a read-back in a separate evalScript. " +
      "For keyframes or expressions on a parameter, use ae_set_property with the path ['ADBE Effect Parade', <effect name>, <param>]. " +
      PRESET_HINT +
      " " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeSetEffectSchema,
    handler: (args: z.infer<typeof AeSetEffectSchema>, ctx) =>
      runEffectWrite(args, ctx, {
        toolName: "ae_set_effect",
        label: `ae_set_effect(${args.effect.name ?? `#${args.effect.index}`})`,
        host: "setEffect",
        hostArgs: (a, expect) => ({ comp_id: a.comp_id, layer: a.layer, effect: a.effect, enabled: a.enabled, name: a.name, params: a.params, expect }),
        check: (a, _before, after, w) => {
          const mismatches: ReceiptMismatch[] = [];
          const fx = effectAt(after, w.index as number);
          if (a.enabled !== undefined) compareValues(a.enabled, fx?.enabled, "effect.enabled", mismatches);
          if (a.name) compareValues(a.name, fx?.name, "effect.name", mismatches);
          return [...mismatches, ...paramMismatches(fx, a.params, w.params_set as any)];
        },
        present: (_a, _before, after, w) => ({ effect: effectAt(after, w.index as number) ?? w }),
      }),
  },
  {
    name: "ae_remove_effect",
    description:
      "Remove one effect from a layer, in one undo group guarded by `expect` (Edit > Undo brings it back). The read-back confirms the layer has one effect fewer. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeRemoveEffectSchema,
    handler: (args: z.infer<typeof AeRemoveEffectSchema>, ctx) =>
      runEffectWrite(args, ctx, {
        toolName: "ae_remove_effect",
        label: `ae_remove_effect(${args.effect.name ?? `#${args.effect.index}`})`,
        host: "removeEffect",
        hostArgs: (a, expect) => ({ comp_id: a.comp_id, layer: a.layer, effect: a.effect, expect }),
        check: (_a, before, after) =>
          effectCount(after) === effectCount(before) - 1
            ? []
            : [{ path: "effects.length", expected: effectCount(before) - 1, actual: effectCount(after), message: "Effect count did not drop by one" }],
        present: (_a, _before, after, w) => ({
          removed: w.removed,
          remaining: ((after as LayerEffects | null)?.effects ?? []).map((e) => ({ index: e.index, name: e.name, matchName: e.matchName })),
        }),
      }),
  },
  {
    name: "ae_apply_preset",
    description:
      "Apply an animation preset (.ffx) to one layer, as Animation > Apply Animation Preset does, in one undo group guarded by `expect`. " +
      "AE applies presets to the selected layers, so the target is selected alone for the call and the user's selection is restored. " +
      "Presets can add effects, keyframes and expressions; the result lists the effects added (read back in a separate evalScript). " +
      "This is how custom-data parameters such as Colorama's Output Cycle get in. Find presets with ae_list_presets. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeApplyPresetSchema,
    handler: async (args: z.infer<typeof AeApplyPresetSchema>, ctx) => {
      if (!path.isAbsolute(args.preset_path) || !/\.ffx$/i.test(args.preset_path) || !fs.existsSync(args.preset_path)) {
        return { ok: false, error: "bad_preset", message: `Not an existing absolute .ffx path: ${args.preset_path}` };
      }
      return runEffectWrite(args, ctx, {
        toolName: "ae_apply_preset",
        label: `ae_apply_preset(${path.basename(args.preset_path)})`,
        host: "applyPreset",
        hostArgs: (a, expect) => ({ comp_id: a.comp_id, layer: a.layer, preset_path: a.preset_path.replace(/\\/g, "/"), expect }),
        check: (_a, before, after) =>
          effectCount(after) >= effectCount(before)
            ? []
            : [{ path: "effects.length", expected: `>= ${effectCount(before)}`, actual: effectCount(after), message: "Applying the preset removed effects" }],
        present: (_a, before, after, w) => ({
          preset: w.preset,
          effects_added: ((after as LayerEffects | null)?.effects ?? [])
            .slice(effectCount(before))
            .map((e) => ({ index: e.index, name: e.name, matchName: e.matchName })),
          layers_added: w.layers_added,
        }),
      });
    },
  },
  {
    name: "ae_list_presets",
    description:
      "List animation presets (.ffx) in the user's User Presets folders (every installed AE version, listed first) and AE's own Presets folder, with a text filter. " +
      "Use the path with ae_apply_preset. Read-only.",
    schema: AeListPresetsSchema,
    handler: async (args: z.infer<typeof AeListPresetsSchema>, ctx) => {
      const res = await ctx.bridge.evalRaw<{ folders: Array<{ kind: string; path: string }> }>({
        id: `${ctx.bridge.newOpId()}_presets`,
        script: buildJsxCall("presetFolders", {}),
        label: "ae_list_presets (folders)",
        mutates: false,
        toolName: "ae_list_presets",
      });
      const folders = res.result?.folders ?? [];
      const { presets, scanned } = findPresets(folders, args.filter, args.source ?? "all");
      const limit = args.limit ?? 100;
      return {
        folders,
        scanned,
        count: presets.length,
        truncated: presets.length > limit,
        presets: presets.slice(0, limit),
      };
    },
  },
];
