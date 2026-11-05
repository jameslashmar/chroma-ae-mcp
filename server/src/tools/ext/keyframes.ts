/**
 * server/src/tools/ext/keyframes.ts
 *
 * Keyframe tools:
 * - ae_get_keyframes: a property's keys with their values, interpolation,
 *   temporal ease (speed and influence per side, named when it is a common
 *   one), spatial tangents, continuity and auto-bezier flags, roving, and
 *   (where the host reports them) selection and label (read-only)
 * - ae_remove_keyframes: all keys, some by index, the selected keys, or those
 *   in a time range, in one undo group, with a dry run
 */

import { z } from "zod";
import type { ReceiptMismatch } from "../../receipts.js";
import { compareValues } from "../../receipts.js";
import { AGENT_SAFETY_GUIDANCE, ExpectSchema, LayerSelectorSchema, type ToolDefinition } from "../common.js";
import { verifyTargetGuard } from "../mutate.js";
import { expectThat, runGuardedWrite } from "./write-runner.js";

const PathSchema = z
  .array(z.union([z.string().min(1), z.number().int().positive()]))
  .min(1)
  .describe("Property path from the layer, by match names or names (e.g. ['ADBE Transform Group', 'ADBE Position']); a 1-based index for a sibling in an indexed group.");

export const AeGetKeyframesSchema = z.object({
  comp_id: z.number().int(),
  layer: LayerSelectorSchema,
  path: PathSchema,
  start: z.number().optional().describe("Only keys at or after this time (comp seconds)."),
  end: z.number().optional().describe("Only keys at or before this time."),
});

export const AeRemoveKeyframesSchema = z
  .object({
    comp_id: z.number().int(),
    layer: LayerSelectorSchema,
    path: PathSchema,
    all: z.boolean().optional().describe("Remove every key."),
    keys: z
      .union([z.array(z.number().int().positive()).max(500), z.literal("selected")])
      .optional()
      .describe(
        "1-based key indexes to remove, or the string 'selected' for the keys selected in the timeline right now (read from AE and resolved to explicit indexes, so the dry run shows exactly which go)."
      ),
    start: z.number().optional().describe("Remove keys at or after this time (comp seconds)."),
    end: z.number().optional().describe("Remove keys at or before this time."),
    static_value_at: z
      .number()
      .optional()
      .describe("When every key goes: keep the value the property had at this time. Default the comp's current time, as AE's stopwatch does."),
    dry_run: z.boolean().optional().describe("List the keys that would go without touching AE."),
    expect: ExpectSchema,
  })
  .refine((v) => v.all === true || v.keys === "selected" || (Array.isArray(v.keys) && v.keys.length > 0) || v.start !== undefined || v.end !== undefined, {
    message: "Say which keys: all, keys, or start/end.",
  });

/** The remove arguments once keys: 'selected' is resolved into indexes. */
export type RemoveKeysArgs = Omit<z.infer<typeof AeRemoveKeyframesSchema>, "keys"> & { keys?: number[] };

// ---------- reading ----------

export interface EaseSide {
  speed: number;
  influence: number;
}

export interface KeyframeEntry {
  keyIndex: number;
  time: number;
  value: unknown;
  inInterp: string | null;
  outInterp: string | null;
  easeIn: EaseSide[];
  easeOut: EaseSide[];
  roving?: boolean;
  inTangent?: number[];
  outTangent?: number[];
  /** Reported by the host for a spatial property (animate.jsx), in camelCase. */
  spatialContinuous?: boolean;
  spatialAutoBezier?: boolean;
  temporalContinuous?: boolean;
  temporalAutoBezier?: boolean;
  /** Reported once the host has them (keySelected; keyLabel on AE 22.6+). */
  selected?: boolean;
  label?: number;
}

/** A short name for one side of a key: linear, hold, easy ease, or bezier. */
export function easeSideName(interp: string | null, ease: EaseSide[] | undefined): string {
  if (interp === "linear") return "linear";
  if (interp === "hold") return "hold";
  if (interp !== "bezier" || !ease || !ease.length) return interp ?? "unknown";
  const easy = ease.every((e) => Math.abs(e.speed) < 1e-6 && Math.abs(e.influence - 100 / 3) < 0.05);
  return easy ? "easy ease" : "bezier";
}

export function describeKey(k: KeyframeEntry): Record<string, unknown> {
  return {
    index: k.keyIndex,
    time: k.time,
    value: k.value,
    in: { interpolation: k.inInterp, name: easeSideName(k.inInterp, k.easeIn), ease: k.easeIn },
    out: { interpolation: k.outInterp, name: easeSideName(k.outInterp, k.easeOut), ease: k.easeOut },
    ...(k.roving !== undefined ? { roving: k.roving } : {}),
    ...(k.inTangent ? { in_tangent: k.inTangent, out_tangent: k.outTangent } : {}),
    ...(k.spatialContinuous !== undefined ? { spatial_continuous: k.spatialContinuous } : {}),
    ...(k.spatialAutoBezier !== undefined ? { spatial_auto_bezier: k.spatialAutoBezier } : {}),
    ...(k.temporalContinuous !== undefined ? { temporal_continuous: k.temporalContinuous } : {}),
    ...(k.temporalAutoBezier !== undefined ? { temporal_auto_bezier: k.temporalAutoBezier } : {}),
    ...(k.selected !== undefined ? { selected: k.selected } : {}),
    ...(k.label !== undefined ? { label: k.label } : {}),
  };
}

// ---------- removing ----------

interface KeysSnapshot {
  numKeys: number;
  keys: Array<{ index: number; time: number; value: unknown }>;
  truncated: boolean;
  value: unknown;
}

/** The keys removeKeys would take (mirrors keyframes.jsx), for the dry run. */
export function selectKeys(keys: Array<{ index: number; time: number }>, args: RemoveKeysArgs) {
  return keys.filter((k) => {
    if (args.all) return true;
    if (args.keys?.length) return args.keys.includes(k.index);
    return (args.start === undefined || k.time >= args.start - 0.0005) && (args.end === undefined || k.time <= args.end + 0.0005);
  });
}

/**
 * How many keys removeKeys would take. `all` and an index list are known
 * from numKeys alone; a time range is counted in the snapshot (the host
 * applies the range before its 500-key cap, so 500 means "at least 500").
 */
export function selectionCount(snap: KeysSnapshot, args: RemoveKeysArgs): number {
  if (args.all) return snap.numKeys;
  if (args.keys?.length) return new Set(args.keys).size;
  return selectKeys(snap.keys, args).length;
}

export function removeKeysMismatches(beforeRaw: unknown, afterRaw: unknown, written: Record<string, unknown>): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const before = beforeRaw as KeysSnapshot | null;
  const after = afterRaw as KeysSnapshot | null;
  if (!before || !after) return m;
  const removed = (written.removed as Array<{ time: number }> | undefined) ?? [];
  const want = before.numKeys - removed.length;
  expectThat(m, after.numKeys === want, "numKeys", want, after.numKeys, "Key count did not drop by the number removed");
  for (const r of removed) {
    if (after.keys.some((k) => Math.abs(k.time - r.time) < 0.0005)) {
      m.push({ path: `keys@${r.time}`, expected: "removed", actual: "present", message: `A key at ${r.time}s is still there` });
    }
  }
  if (written.static_value !== undefined && after.numKeys === 0) compareValues(written.static_value, after.value, "value", m);
  return m;
}

// ---------- tools ----------

export const keyframesTools: ToolDefinition<any>[] = [
  {
    name: "ae_get_keyframes",
    description:
      "Read a property's keyframes: time, value, in and out interpolation, temporal ease per side (speed, influence; named 'easy ease', 'linear', 'hold' or 'bezier'), " +
      "spatial tangents, spatial/temporal continuous and auto-bezier flags, roving, and selected / label (AE 22.6+) when the panel reports them. Read-only; at most 500 keys in the start/end range (`truncated` means more keys in range exist).",
    schema: AeGetKeyframesSchema,
    handler: async (args: z.infer<typeof AeGetKeyframesSchema>, ctx) => {
      const res = await ctx.bridge.callHost<{ name: string; matchName: string; isSpatial: boolean; numKeys: number; keyframes: KeyframeEntry[]; truncated?: boolean }>(
        "getKeyframeEase",
        { comp_id: args.comp_id, layer: args.layer, path: args.path, start: args.start, end: args.end },
        { label: "ae_get_keyframes", mutates: false, toolName: "ae_get_keyframes" }
      );
      const r = res.result;
      const inRange = (t: number) => (args.start === undefined || t >= args.start - 0.0005) && (args.end === undefined || t <= args.end + 0.0005);
      const keys = r.keyframes.filter((k) => inRange(k.time)).map(describeKey);
      return { property: { name: r.name, matchName: r.matchName, spatial: r.isSpatial }, numKeys: r.numKeys, keys, truncated: r.truncated === true };
    },
  },
  {
    name: "ae_remove_keyframes",
    description:
      "Remove a property's keyframes in one undo group guarded by `expect`: all of them, some by index, the keys selected in the timeline (keys: 'selected'; the selection is read from AE and resolved to explicit indexes, and the dry run shows them), or those in a time range. " +
      "When every key goes, the property keeps the value it had at static_value_at (default: the comp's current time, as AE's stopwatch does). " +
      "dry_run lists what would go without touching AE. The read-back (a separate evalScript) checks the count, that the keys are gone, and the kept value. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeRemoveKeyframesSchema,
    handler: async (rawArgs: z.infer<typeof AeRemoveKeyframesSchema>, ctx) => {
      // keys: 'selected' becomes explicit indexes first, so the dry run, the checkpoint and the write all name the same keys.
      let args: RemoveKeysArgs = { ...rawArgs, keys: Array.isArray(rawArgs.keys) ? rawArgs.keys : undefined };
      let resolvedFromSelection: { keys: number[]; times: number[] } | undefined;
      let guarded = false;
      let selectedNumKeys: number | undefined;
      if (rawArgs.keys === "selected") {
        if (!rawArgs.dry_run) {
          // Guard before the selection read, so a wrong project fails with the guard error.
          ctx.quarantine.assertClear();
          await verifyTargetGuard(ctx, { project_path: rawArgs.expect.project_path, comp_id: rawArgs.expect.comp_id ?? rawArgs.comp_id }, ctx.bridge.newOpId());
          guarded = true;
        }
        const sel = await ctx.bridge.callHost<{ numKeys: number; selected_keys: number[]; times: number[]; truncated?: boolean }>(
          "keyframesSelection",
          { comp_id: rawArgs.comp_id, layer: rawArgs.layer, path: rawArgs.path },
          { label: "ae_remove_keyframes (selection)", mutates: false, toolName: "ae_remove_keyframes" }
        );
        const picked = sel.result;
        if (picked.truncated) {
          return { ok: false, error: "bad_args", message: "More than 500 keys are selected; select fewer, or pass explicit indexes." };
        }
        if (!picked.selected_keys.length) {
          return { ok: false, error: "no_match", message: `No keys are selected on that property (it has ${picked.numKeys} key(s)); nothing was removed.`, numKeys: picked.numKeys };
        }
        args = { ...rawArgs, keys: picked.selected_keys };
        resolvedFromSelection = { keys: picked.selected_keys, times: picked.times };
        selectedNumKeys = picked.numKeys;
      }
      // The write's own read-backs: `value` is the one before any expression.
      const snapshot = { host: "keysSnapshotStatic", args: { comp_id: args.comp_id, layer: args.layer, path: args.path } };
      // A time range goes to the host so the 500-key cap applies to the keys in range.
      const rangeOnly = args.all !== true && !(args.keys?.length ?? 0);
      const selectionArgs = { ...snapshot.args, ...(rangeOnly ? { start: args.start, end: args.end } : {}) };
      const readSelection = (label: string) =>
        ctx.bridge.callHost<KeysSnapshot>("keysSnapshot", selectionArgs, { label, mutates: false, toolName: "ae_remove_keyframes" });
      const badIndex = (snap: KeysSnapshot) => (args.keys ?? []).find((i) => i > snap.numKeys);
      if (args.dry_run) {
        const snap = (await readSelection("ae_remove_keyframes (dry run)")).result;
        const bad = badIndex(snap);
        if (bad !== undefined) return { ok: false, error: "bad_args", message: `Key ${bad} out of range (1..${snap.numKeys})` };
        const would = selectKeys(snap.keys, args);
        const count = selectionCount(snap, args);
        const truncated = snap.truncated === true;
        return {
          ok: true,
          dry_run: true,
          ...(resolvedFromSelection ? { selected: resolvedFromSelection } : {}),
          count,
          keys: would,
          all_keys: snap.numKeys > 0 && count === snap.numKeys,
          truncated,
          ...(truncated || would.length < count
            ? { note: `Only the first 500 keys are listed${rangeOnly ? "; the count is a lower bound" : ""}. The real removal is not capped.` }
            : {}),
        };
      }
      // A selection that matches nothing stops here, before the checkpoint and the undo group.
      // Guard first, so a wrong project fails with the guard error and not a
      // misleading not_found / bad_args / no_match from another project's ids.
      if (!guarded) {
        ctx.quarantine.assertClear();
        await verifyTargetGuard(ctx, { project_path: args.expect.project_path, comp_id: args.expect.comp_id ?? args.comp_id }, ctx.bridge.newOpId());
      }
      const pre = (await readSelection("ae_remove_keyframes (match)")).result;
      if (selectedNumKeys !== undefined && pre.numKeys !== selectedNumKeys) {
        return {
          ok: false,
          error: "bad_args",
          message: `The property's keys changed since the selection was read (${selectedNumKeys} then, ${pre.numKeys} now); nothing was removed. Select the keys again.`,
          numKeys: pre.numKeys,
        };
      }
      const preBad = badIndex(pre);
      if (preBad !== undefined) return { ok: false, error: "bad_args", message: `Key ${preBad} out of range (1..${pre.numKeys})` };
      if (selectionCount(pre, args) === 0) {
        return { ok: false, error: "no_match", message: `No keys match that selection; nothing was removed. The property has ${pre.numKeys} key(s).`, numKeys: pre.numKeys };
      }
      return runGuardedWrite(ctx, {
        toolName: "ae_remove_keyframes",
        label: `ae_remove_keyframes(${args.path.join(".")})`,
        expect: args.expect,
        compId: args.comp_id,
        read: () => snapshot,
        write: {
          host: "removeKeys",
          args: {
            comp_id: args.comp_id,
            layer: args.layer,
            path: args.path,
            all: args.all,
            keys: args.keys,
            start: args.start,
            end: args.end,
            static_value_at: args.static_value_at,
            label: "Remove keyframes",
          },
        },
        check: removeKeysMismatches,
        present: (_before, after, w) => ({
          ...(resolvedFromSelection ? { selected: resolvedFromSelection } : {}),
          removed: w.removed,
          numKeys: (after as KeysSnapshot | null)?.numKeys,
          ...(w.static_value !== undefined ? { static_value: w.static_value, static_value_at: w.static_value_at } : {}),
        }),
      });
    },
  },
];
