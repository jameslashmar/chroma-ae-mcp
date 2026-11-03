/**
 * server/src/tools/ext/keyframes.ts
 *
 * Keyframe tools:
 * - ae_get_keyframes: a property's keys with their values, interpolation,
 *   temporal ease (speed and influence per side, named when it is a common
 *   one), spatial tangents, roving and auto-bezier flags (read-only)
 * - ae_remove_keyframes: all keys, some by index, or those in a time range,
 *   in one undo group, with a dry run
 */

import { z } from "zod";
import type { ReceiptMismatch } from "../../receipts.js";
import { compareValues } from "../../receipts.js";
import { AGENT_SAFETY_GUIDANCE, ExpectSchema, LayerSelectorSchema, type ToolDefinition } from "../common.js";
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
    keys: z.array(z.number().int().positive()).max(500).optional().describe("1-based key indexes to remove."),
    start: z.number().optional().describe("Remove keys at or after this time (comp seconds)."),
    end: z.number().optional().describe("Remove keys at or before this time."),
    static_value_at: z
      .number()
      .optional()
      .describe("When every key goes: keep the value the property had at this time. Default the comp's current time, as AE's stopwatch does."),
    dry_run: z.boolean().optional().describe("List the keys that would go without touching AE."),
    expect: ExpectSchema,
  })
  .refine((v) => v.all === true || (v.keys?.length ?? 0) > 0 || v.start !== undefined || v.end !== undefined, {
    message: "Say which keys: all, keys, or start/end.",
  });

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
export function selectKeys(keys: Array<{ index: number; time: number }>, args: z.infer<typeof AeRemoveKeyframesSchema>) {
  return keys.filter((k) => {
    if (args.all) return true;
    if (args.keys?.length) return args.keys.includes(k.index);
    return (args.start === undefined || k.time >= args.start - 0.0005) && (args.end === undefined || k.time <= args.end + 0.0005);
  });
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
      "spatial tangents, roving and auto-bezier flags. Read-only; at most 500 keys.",
    schema: AeGetKeyframesSchema,
    handler: async (args: z.infer<typeof AeGetKeyframesSchema>, ctx) => {
      const res = await ctx.bridge.callHost<{ name: string; matchName: string; isSpatial: boolean; numKeys: number; keyframes: KeyframeEntry[]; truncated?: boolean }>(
        "getKeyframeEase",
        { comp_id: args.comp_id, layer: args.layer, path: args.path },
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
      "Remove a property's keyframes in one undo group guarded by `expect`: all of them, some by index, or those in a time range. " +
      "When every key goes, the property keeps the value it had at static_value_at (default: the comp's current time, as AE's stopwatch does). " +
      "dry_run lists what would go without touching AE. The read-back (a separate evalScript) checks the count, that the keys are gone, and the kept value. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeRemoveKeyframesSchema,
    handler: async (args: z.infer<typeof AeRemoveKeyframesSchema>, ctx) => {
      const snapshot = { host: "keysSnapshot", args: { comp_id: args.comp_id, layer: args.layer, path: args.path } };
      if (args.dry_run) {
        const res = await ctx.bridge.callHost<KeysSnapshot>(snapshot.host, snapshot.args, {
          label: "ae_remove_keyframes (dry run)",
          mutates: false,
          toolName: "ae_remove_keyframes",
        });
        const would = selectKeys(res.result.keys, args);
        return { ok: true, dry_run: true, count: would.length, keys: would, all_keys: would.length === res.result.numKeys };
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
          removed: w.removed,
          numKeys: (after as KeysSnapshot | null)?.numKeys,
          ...(w.static_value !== undefined ? { static_value: w.static_value, static_value_at: w.static_value_at } : {}),
        }),
      });
    },
  },
];
