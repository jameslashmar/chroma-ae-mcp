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
import { checkAfterWrite, readAfterWrite } from "../read-back.js";

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

export const InputLayerValueSchema = z
  .object({
    layer: z.union([z.literal(0), LayerSelectorSchema]).describe("The layer in this comp to use as the input: a selector (id, index or name), or 0 for none."),
    stage: z
      .enum(["source", "masks", "effects"])
      .optional()
      .describe(
        "After Effects 26.5+ only: which stage of that layer to take: 'source' (before masks and effects), 'masks' (after masks only) or 'effects' (after masks and all effects). " +
          "Refused on older AE and when it would make a cycle (the layer the effect sits on, any stage but source). Leave out to pick the layer only, which works on every version."
      ),
  })
  .describe("A layer picker's input: a layer and, on AE 26.5+, the stage of that layer.");

export type InputLayerValue = z.infer<typeof InputLayerValueSchema>;

export const EffectParamSchema = z.object({
  param: z
    .union([z.string().min(1), z.number().int().positive()])
    .describe("Parameter display name (e.g. 'Blurriness'), match name, or 1-based index."),
  value: z
    .union([z.number(), z.boolean(), z.string().min(1).max(200), z.array(z.number()), InputLayerValueSchema])
    .describe(
      "Number, boolean (checkboxes), or array (points, colors as [r, g, b] or [r, g, b, a] in 0..1). " +
        "Popups take their 1-based item number, or the item's label as text (AE 26.0+, where the parameter lists 'options' in the effect read-back; matched case-insensitively; a popup that reports no labels needs the number). " +
        "Layer pickers take a layer index (0 for none) or {layer, stage?} (stage needs AE 26.5+)."
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
    move_to: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Move the effect to this 1-based position in the layer's stack (effects apply top to bottom, so order changes the look). Refused on a locked layer."),
    duplicate: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .describe("Make this many copies of the effect, with its current values (params given in the same call are applied first). Cannot be combined with move_to. Refused on a locked layer."),
    expect: ExpectSchema,
  })
  .refine((v) => v.enabled !== undefined || v.name !== undefined || (v.params?.length ?? 0) > 0 || v.move_to !== undefined || v.duplicate !== undefined, {
    message: "Give at least one of enabled, name, params, move_to or duplicate.",
  })
  .refine((v) => v.move_to === undefined || v.duplicate === undefined, {
    message: "Give move_to or duplicate, not both.",
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
  /** Popups (AE 26.0+, when AE reports them). */
  options?: string[];
  value_text?: string;
  /** Layer pickers (AE 26.5+). */
  input_stage_supported?: boolean;
  input_layer?: number;
  input_stage?: string;
}

/** What the host reports for each parameter it wrote. */
interface WrittenParam {
  param?: string;
  how?: string;
  resolved_value?: unknown;
  stage?: string;
  label?: string;
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
  truncated?: boolean;
  layer_styles?: { slot: string; enabled: boolean | null }[];
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
  if (typeof value === "string" || isInputLayer(value)) return value;
  if (type === "color" && Array.isArray(value) && value.length === 3) return [...value, 1];
  return value;
}

function isInputLayer(v: unknown): v is InputLayerValue {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function paramMismatches(
  effect: EffectSnapshot | undefined,
  params: ParamInput[] | undefined,
  written: WrittenParam[] | undefined
): ReceiptMismatch[] {
  const mismatches: ReceiptMismatch[] = [];
  (params ?? []).forEach((p, i) => {
    const wr = written?.[i];
    // Animated parameters were set at the comp's current time; their value elsewhere differs.
    if (wr?.how === "value_at_current_time") return;
    const snap = findParamSnapshot(effect, p.param);
    if (!snap) {
      mismatches.push({ path: `params.${p.param}`, expected: p.value, actual: undefined, message: `Parameter ${p.param} not found in read-back` });
      return;
    }
    const at = `params.${snap.name}`;
    if (wr?.resolved_value !== undefined) {
      // A menu label or a layer pick: the host says which number it wrote.
      compareValues(wr.resolved_value, snap.value, at, mismatches);
    } else if (typeof p.value === "string" || isInputLayer(p.value)) {
      mismatches.push({ path: at, expected: p.value, actual: snap.value, message: `Parameter ${snap.name} was given a label or layer pick but the host did not report what it wrote` });
    } else {
      compareValues(expectedParamValue(snap.type, p.value), snap.value, at, mismatches);
    }
    if (wr?.stage !== undefined) {
      if (snap.input_stage === undefined) {
        mismatches.push({ path: `${at}.input_stage`, expected: wr.stage, actual: undefined, message: `The read-back reports no input stage for ${snap.name}, so the stage was not verified` });
      } else {
        compareValues(wr.stage, snap.input_stage, `${at}.input_stage`, mismatches);
      }
    }
  });
  return mismatches;
}

/** The effect stack after moving the item at 1-based `from` to 1-based `to`. */
export function reorderStack<T>(stack: T[], from: number, to: number): T[] {
  const out = stack.slice();
  if (from < 1 || from > out.length || to < 1 || to > out.length) return out;
  const [item] = out.splice(from - 1, 1);
  out.splice(to - 1, 0, item);
  return out;
}

const stackKey = (e: { name: string; matchName: string }) => `${e.matchName}|${e.name}`;

/** Layer style names ae_add_effect tries on 'ADBE Layer Styles' (not yet probed on a live AE). */
export const LAYER_STYLE_NAMES = ["dropShadow", "innerShadow", "outerGlow", "innerGlow", "bevelEmboss", "chromeFX", "solidFill", "gradientFill", "patternFill", "frameFX"];

/** Checks of a set_effect move and duplicate against the stack read before and after. */
export function stackMismatches(
  args: { name?: string; move_to?: number; duplicate?: number },
  beforeRaw: unknown,
  afterRaw: unknown,
  w: Record<string, unknown>
): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const before = ((beforeRaw as LayerEffects | null)?.effects ?? []).map((e) => ({ name: e.name, matchName: e.matchName }));
  const after = ((afterRaw as LayerEffects | null)?.effects ?? []).map((e) => stackKey(e));
  const whole = (beforeRaw as LayerEffects | null)?.truncated !== true && (afterRaw as LayerEffects | null)?.truncated !== true;
  const mv = w.move as { from?: number; to?: number } | undefined;
  // A list cut at 100 effects shows only its first 100: a move whose two ends are both inside them leaves the rest alone and is
  // still checked (on the listed part); a move reaching past the cut cannot be seen, so its order is not checked.
  const listed = Math.min(before.length, after.length);
  const seen = whole || (mv !== undefined && typeof mv.from === "number" && typeof mv.to === "number" && mv.from <= listed && mv.to <= listed);
  if (args.move_to !== undefined && seen && mv && typeof mv.from === "number" && typeof mv.to === "number") {
    const renamed = before.map((e, i) => (i === mv.from! - 1 && args.name ? { ...e, name: args.name } : e));
    const expected = reorderStack(renamed.map(stackKey), mv.from, mv.to);
    compareValues(whole ? expected : expected.slice(0, listed), whole ? after : after.slice(0, listed), "effects.order", m);
  }
  if (args.duplicate !== undefined) {
    // The host refuses a duplicate that would pass 100 effects, so a duplicate never meets a cut list; the guard is only defensive.
    if (whole && after.length !== before.length + args.duplicate) {
      m.push({ path: "effects.length", expected: before.length + args.duplicate, actual: after.length, message: "Effect count did not grow by the number of copies" });
    }
    if (w.duplicate_located === false) {
      m.push({ path: "duplicates", expected: args.duplicate, actual: w.duplicate_made, message: "AE did not report where the copies went, so they were not located" });
    }
    const copies = (w.duplicates as Array<{ index: number; matchName: string }> | undefined) ?? [];
    for (const c of copies) {
      const got = (afterRaw as LayerEffects | null)?.effects.find((e) => e.index === c.index);
      if (got?.matchName !== c.matchName) m.push({ path: `effects[${c.index}]`, expected: c.matchName, actual: got?.matchName, message: "A copy is not at the index the host reported" });
    }
  }
  return m;
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
      // Separate evalScript for the read-back. The write is applied from here
      // on, so a failed read or check is reported, never thrown.
      const afterRead = await readAfterWrite(opId, () => readEffects("after"));
      const written = write.result ?? {};
      if (afterRead.failure) {
        return {
          op_id: opId,
          applied: true as const,
          ...written,
          checkpoint,
          receipt: buildReceipt({ before: before.result, after: null, customMismatches: [afterRead.failure] }),
        };
      }
      const after = afterRead.value!;
      const { mismatches, shown } = checkAfterWrite(
        opId,
        () => ({
          mismatches: spec.check(args, before.result, after.result, written),
          shown: spec.present(args, before.result, after.result, written),
        }),
        (failure) => ({ mismatches: [failure], shown: written })
      );
      const receipt = buildReceipt({ before: before.result, after: after.result, customMismatches: mismatches });
      return {
        op_id: opId,
        applied: true as const,
        ...shown,
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
const PRESET_CACHE_TTL_MS = 5000;

interface InternalPresetEntry extends PresetEntry {
  matchKey: string;
}

let presetCache: { key: string; at: number; all: InternalPresetEntry[]; scanned: number } | null = null;

/** The disk walk only, unfiltered by text — same (folders, source) skip/cap logic as before. */
function walkPresetsUnfiltered(
  folders: Array<{ kind: string; path: string }>,
  source: "all" | "user" | "app"
): { all: InternalPresetEntry[]; scanned: number } {
  const all: InternalPresetEntry[] = [];
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
          const rawCategory = path.relative(folder.path, dir).split(path.sep).join("/");
          const name = e.name.replace(/\.ffx$/i, "");
          all.push({
            name,
            path: full,
            category: rawCategory || path.basename(folder.path),
            matchKey: `${rawCategory}/${name}`.toLowerCase(),
            source: kind,
          });
        }
      }
    };
    walk(folder.path, 0);
  }
  return { all, scanned };
}

export function findPresets(
  folders: Array<{ kind: string; path: string }>,
  filter: string | undefined,
  source: "all" | "user" | "app"
): { presets: PresetEntry[]; scanned: number } {
  const key = source + "|" + folders.map((f) => `${f.kind}:${f.path}`).join("|");
  const now = Date.now();
  // ae_list_presets is commonly called repeatedly in quick succession (narrowing a
  // text filter) with the same folders/source; re-walking AE's whole Presets tree
  // from disk synchronously on every call blocks the single-threaded server for the
  // full walk each time. Cache the unfiltered walk briefly and just re-filter/re-sort
  // the cached list by text instead of hitting the disk again.
  let cached: { all: InternalPresetEntry[]; scanned: number };
  if (presetCache && presetCache.key === key && now - presetCache.at < PRESET_CACHE_TTL_MS) {
    cached = presetCache;
  } else {
    cached = walkPresetsUnfiltered(folders, source);
    presetCache = { key, at: now, ...cached };
  }
  const needle = filter?.trim().toLowerCase() ?? "";
  const matched = needle ? cached.all.filter((p) => p.matchKey.includes(needle)) : cached.all.slice();
  matched.sort((a, b) => (a.source === b.source ? a.path.localeCompare(b.path) : a.source === "user" ? -1 : 1));
  const presets: PresetEntry[] = matched.map(({ matchKey, ...rest }) => rest);
  return { presets, scanned: cached.scanned };
}

// ---------- tools ----------

const PRESET_HINT =
  "Parameters marked settable: false (custom data such as Colorama's Output Cycle or the Curves curve) can't be read or set by script; AE refuses it. Measured routes, all inside AE: " +
  "(1) link it by expression to the same parameter of an effect the user set up by hand (ae_set_property on the path ['ADBE Effect Parade', <effect name>, <param matchName>], since a section header can share the param's display name, with an expression such as thisComp.layer(\"Look\").effect(\"Colorama\")(\"Output Cycle\"); `linkable_by_expression` says when this works); " +
  "(2) apply an animation preset saved from AE (Animation > Save Animation Preset) with ae_apply_preset; " +
  "(3) the effect's own preset menu, if any (Colorama's 'Use Preset Palette' is an ordinary settable popup).";

const LAYER_STYLES_HINT =
  "LAYER STYLES (route not yet probed on a live AE; treat as a best-known path): Layer Styles live in the layer's 'ADBE Layer Styles' group (dropShadow, innerShadow, outerGlow, innerGlow, bevelEmboss, chromeFX, solidFill, gradientFill, patternFill, frameFX; plus 'ADBE Blend Options Group'). " +
  "They are not effects: 'Drop Shadow' as an effect is 'ADBE Drop Shadow', a different thing. Once a style exists on a layer, set its parameters with ae_set_property on paths under ['ADBE Layer Styles', '<style>/enabled', ...], e.g. ['ADBE Layer Styles', 'dropShadow/enabled', ...] (the slots' match names end in '/enabled'; ae_get_layer_full lists them). " +
  "Adding a style is probably menu-only (the style slots usually report canAddProperty false and menu commands do not run through the panel), so the add route is an .ffx animation preset saved from AE with the style on it, applied with ae_apply_preset. " +
  "ae_add_effect with one of the style names above tries addProperty('<style>/enabled') on 'ADBE Layer Styles' and, if AE refuses, says 'not addable by script, use a preset'.";

export const effectsTools: ToolDefinition<any>[] = [
  {
    name: "ae_add_effect",
    description:
      "Add an effect to a layer, optionally renamed and with static parameter values, in one undo group guarded by `expect`. " +
      "Returns the effect's index and every parameter (name, match name, type, value, settable; popups list their labels as `options` on AE 26.0+ and layer pickers report `input_layer` and `input_stage` on 26.5+), read back in a separate evalScript. " +
      "Find the effect's match name with ae_list_effects; display names vary by AE language. " +
      "A value that AE refuses takes the half-made effect back out in the same undo group. " +
      LAYER_STYLES_HINT +
      " " +
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
          if (LAYER_STYLE_NAMES.includes(a.effect)) {
            if (w.layer_style !== true) mismatches.push({ path: "layer_style", expected: true, actual: w.layer_style, message: "The host did not report adding the layer style" });
            const slots = (after as LayerEffects | null)?.layer_styles;
            const slot = `${a.effect}/enabled`;
            const found = slots?.find((x) => x.slot === slot);
            if (found?.enabled !== true) {
              mismatches.push({ path: `layer_styles.${slot}.enabled`, expected: true, actual: found?.enabled ?? null, message: "The read-back does not show the layer style slot enabled" });
            }
            return mismatches;
          }
          if (effectCount(after) !== effectCount(before) + 1) {
            mismatches.push({ path: "effects.length", expected: effectCount(before) + 1, actual: effectCount(after), message: "Effect count did not grow by one" });
          }
          const fx = effectAt(after, w.index as number);
          compareValues(w.matchName, fx?.matchName, "effect.matchName", mismatches);
          if (a.name) compareValues(a.name, fx?.name, "effect.name", mismatches);
          return [...mismatches, ...paramMismatches(fx, a.params, w.params_set as any)];
        },
        present: (_a, _before, after, w) => (w.layer_style === true ? { layer_style: w } : { effect: effectAt(after, w.index as number) ?? w }),
      }),
  },
  {
    name: "ae_set_effect",
    description:
      "Change an effect on a layer: turn it on or off, rename it, set static parameter values, move it to another place in the stack (move_to) or duplicate it (duplicate), in one undo group guarded by `expect`, with a read-back in a separate evalScript. " +
      "What can be checked is refused before the undo group opens (a menu label that does not exist, a stage on an older AE, a locked layer, a bad position). If AE itself still refuses a stage inside the group (for example a cycle through another layer), the stage picks, enabled and name this call already made are put back before the error is returned; values already written by then are not (Edit > Undo). " +
      "Popups: give the 1-based item number, or the label as text on AE 26.0+ (read the effect first: popups that report their labels list them as `options`, with `value_text`). " +
      "Layer pickers: a layer index (0 none) or {layer, stage?}; on AE 26.5+ stage 'source' | 'masks' | 'effects' picks which stage of that layer feeds the effect, with AE's cycle-safe limit read right before the write and reported as cycle_safe_limit (informational only: AE itself refuses a cycle); below 26.5 a stage is refused and the layer alone is set. " +
      "move_to and duplicate re-find the effect by position after each step (AE invalidates sibling references) and the receipt compares the stack order with what the move should give (a stack lists at most 100 effects: a move reaching past the 100th is not order-checked, and an effect past the 100th has no enabled, name or parameter read-back). " +
      "Expressions that read an effect by position (effect(2)) silently point at a different effect after a move or duplicate: the result lists them as `expression_warnings` (this layer's, and other layers' in the same comp that mention this layer, up to 300 layers; expressions in other comps that reach this layer through comp(\"X\").layer(...).effect(n) are not scanned, and `expression_scan_scope` says so; fix them with ae_set_property). " +
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
        hostArgs: (a, expect) => ({
          comp_id: a.comp_id,
          layer: a.layer,
          effect: a.effect,
          enabled: a.enabled,
          name: a.name,
          params: a.params,
          move_to: a.move_to,
          duplicate: a.duplicate,
          expect,
        }),
        check: (a, before, after, w) => {
          const mismatches: ReceiptMismatch[] = [];
          const fx = effectAt(after, w.index as number);
          // An effect past the 100 listed cannot be read back: its enabled, name and parameter checks are skipped.
          const unlisted = !fx && (after as LayerEffects | null)?.truncated === true;
          if (a.enabled !== undefined && !unlisted) compareValues(a.enabled, fx?.enabled, "effect.enabled", mismatches);
          if (a.name && !unlisted) compareValues(a.name, fx?.name, "effect.name", mismatches);
          return [...mismatches, ...(unlisted ? [] : paramMismatches(fx, a.params, w.params_set as any)), ...stackMismatches(a, before, after, w)];
        },
        present: (_a, _before, after, w) => {
          const out: Record<string, unknown> = { effect: effectAt(after, w.index as number) ?? w };
          for (const k of ["no_op", "note", "move", "duplicates", "duplicate_made", "duplicate_located", "expression_warnings", "expression_scan_truncated", "expression_scan_scope"]) {
            if (w[k] !== undefined) out[k] = w[k];
          }
          if (w.move !== undefined) out.stack = ((after as LayerEffects | null)?.effects ?? []).map((e) => ({ index: e.index, name: e.name, matchName: e.matchName }));
          return out;
        },
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
      "This is how custom-data parameters such as Colorama's Output Cycle get in, and (best-known route, not yet probed live) how Layer Styles get onto a layer: save the layer with the style as an .ffx preset in AE, apply it here, then edit the style with ae_set_property on ['ADBE Layer Styles', '<style>/enabled', ...]. " +
      "Find presets with ae_list_presets. " +
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
