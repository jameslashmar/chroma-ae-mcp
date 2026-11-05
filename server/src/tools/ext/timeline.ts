/**
 * server/src/tools/ext/timeline.ts
 *
 * Timeline tools:
 * - ae_keyframes_transform: shift, scale, reverse, move or copy keyframes (also
 *   the keys selected in the timeline) with every attribute kept: value,
 *   interpolation, ease per dimension, tangents, continuity, roving, label
 * - ae_detect_cuts: After Effects' Scene Edit Detection on a footage layer:
 *   list the cut times, or add markers, split, or split and pre-compose
 *
 * Host side: panel/host/ext/timeline.jsx (needs ext/stagger.jsx's key helpers).
 */

import { z } from "zod";
import { SLOW_TIMEOUT_MS } from "../../host.js";
import type { ReceiptMismatch } from "../../receipts.js";
import { AGENT_SAFETY_GUIDANCE, ExpectSchema, LayerSelectorSchema, type ToolDefinition } from "../common.js";
import { indexMapFromStack, indexReferenceWarnings, type ExpressionWarning, type OpsStack } from "./layerops.js";
import type { MarkerList } from "./markers.js";
import { verifyTargetGuard } from "../mutate.js";
import { expectThat, runGuardedWrite } from "./write-runner.js";

/** Key times read back within this of what was planned count as the same. */
const TIME_TOLERANCE = 0.0015;
const MAX_MISMATCHES = 50;

const PathSchema = z
  .array(z.union([z.string().min(1), z.number().int().positive()]))
  .min(1)
  .describe("Property path from the layer, by match names or names (e.g. ['ADBE Transform Group', 'ADBE Position']); a 1-based index for a sibling in an indexed group.");

// ---------- ae_keyframes_transform: schema ----------

export const TransformTargetSchema = z.object({
  layer: LayerSelectorSchema,
  path: PathSchema,
});

export const KeyFilterSchema = z
  .object({
    from: z.number().optional().describe("Only keys at or after this time (comp seconds)."),
    to: z.number().optional().describe("Only keys at or before this time."),
    indexes: z.array(z.number().int().positive()).max(500).optional().describe("Only these 1-based key indexes."),
  })
  .describe("Which keys of each target the operation moves. Default: every key (with keys: 'selected', every selected key).");

export const TransformOperationSchema = z
  .discriminatedUnion("type", [
  z.object({
    type: z.literal("shift"),
    by: z.number().finite().optional().describe("Seconds to move the keys (negative = earlier)."),
    frames: z.number().finite().optional().describe("Frames to move the keys, instead of seconds."),
  }),
  z.object({
    type: z.literal("scale"),
    factor: z.number().positive().finite().describe("Time scale: 2 makes the keys twice as far apart (slower), 0.5 half as far (faster)."),
    pivot: z
      .enum(["first_key", "time", "playhead"])
      .optional()
      .describe("The time that stays put: the first moved key (default), pivot_time, or the comp's current time."),
    pivot_time: z.number().optional().describe("Comp seconds, for pivot 'time'."),
  }),
  z.object({ type: z.literal("reverse") }),
  z.object({
    type: z.literal("move_to"),
    time: z.number().describe("Comp seconds where the first moved key lands; the others keep their spacing."),
  }),
  z.object({
    type: z.literal("copy_to"),
    layer: LayerSelectorSchema.describe("Destination layer."),
    path: PathSchema.describe("Destination property (same kind as the source)."),
    relative_value: z
      .boolean()
      .optional()
      .describe("Add the difference between the destination's value and the first copied key's value to every copied key, so the copy starts from where the destination is. Numeric properties only. Default false."),
    at_time: z.number().optional().describe("Comp seconds where the first copied key lands. Default: keep the source times."),
  }),
])
  .describe(
    "What to do to the keys, an object with type: " +
      "{type:'shift', by?: seconds | frames?: frames (exactly one)}; " +
      "{type:'scale', factor: >0, pivot?: 'first_key'|'time'|'playhead', pivot_time?: comp seconds (with pivot 'time' only)}; " +
      "{type:'reverse'}; " +
      "{type:'move_to', time: comp seconds}; " +
      "{type:'copy_to', layer: layer selector, path: property path, relative_value?: boolean, at_time?: comp seconds}."
  );

export const AeKeyframesTransformSchema = z
  .object({
    comp_id: z.number().int(),
    targets: z.array(TransformTargetSchema).min(1).max(50).optional().describe("The properties whose keys move, each {layer, path} as in ae_set_property."),
    keys: z
      .literal("selected")
      .optional()
      .describe("Instead of targets: the keys selected in the timeline right now (read from AE, resolved to explicit properties and key indexes, and checked against the keys again at the write)."),
    filter: KeyFilterSchema.optional(),
    operation: TransformOperationSchema,
    snap: z.boolean().optional().describe("Snap every moved key to a whole frame. Default true; false keeps sub-frame times."),
    dry_run: z.boolean().optional().describe("Return the planned key times without touching AE."),
    expect: ExpectSchema.optional().describe((ExpectSchema.description ?? "") + " Required unless dry_run."),
  })
  .superRefine((v, ctx) => {
    if ((v.targets === undefined) === (v.keys === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Give targets, or keys: 'selected', not both and not neither." });
    }
    if (v.dry_run !== true && v.expect === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Transforming needs expect; pass dry_run to only preview." });
    }
    const op = v.operation;
    if (op.type === "shift" && (op.by === undefined) === (op.frames === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "shift needs by (seconds) or frames, not both and not neither." });
    }
    if (op.type === "scale" && op.pivot === "time" && op.pivot_time === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "pivot 'time' needs pivot_time." });
    }
    if (op.type === "scale" && op.pivot !== "time" && op.pivot_time !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "pivot_time only goes with pivot 'time'." });
    }
  });

export type TransformOperation = z.infer<typeof TransformOperationSchema>;

// ---------- ae_keyframes_transform: read-back shapes ----------

interface EaseSide {
  speed: number;
  influence: number;
}

/** One key as timelineKeysRead reports it (stagger.jsx describeKeys). */
export interface ReadKey {
  time: number;
  value: unknown;
  inInterp?: string;
  outInterp?: string;
  easeIn?: EaseSide[];
  easeOut?: EaseSide[];
  temporalContinuous?: boolean;
  temporalAutoBezier?: boolean;
  tangentIn?: number[];
  tangentOut?: number[];
  spatialContinuous?: boolean;
  spatialAutoBezier?: boolean;
  roving?: boolean;
  label?: number;
  selected?: boolean;
}

export interface ReadProperty {
  layer_id: number;
  path: Array<string | number>;
  follower: number | null;
  name: string;
  numKeys: number;
  spatial: boolean;
  /** Whether each dimension of the ease has a signed speed (OneD / TwoD / ThreeD, not spatial). Older reads omit it. */
  signed_speed?: boolean;
  keys: ReadKey[];
  truncated?: boolean;
}

export interface KeysRead {
  comp_id: number;
  frameDuration: number;
  properties: ReadProperty[];
}

export interface KeyMove {
  from_index: number;
  new_index: number;
  from: number;
  to: number;
}

export interface PlanTarget {
  role: "edited" | "source" | "destination";
  layer_id: number;
  layer_index: number;
  layer_name: string;
  path: Array<string | number>;
  follower: number | null;
  property: string;
  num_keys: number;
  indexes: number[];
  moves: KeyMove[];
}

export interface TransformPlan {
  operation: string;
  snap: boolean;
  frame_duration: number;
  span: { from: number; to: number };
  keys_selected: number;
  changed: boolean;
  targets: PlanTarget[];
  warnings: string[];
  by?: number;
  target_time?: number;
  factor?: number;
  pivot?: number;
  pivot_mode?: string;
  reverse?: boolean;
  delta?: number | number[];
  at_time?: number | null;
  dry_run?: boolean;
  no_op?: boolean;
}

// ---------- ae_keyframes_transform: pure logic ----------

const readOf = (v: unknown): KeysRead | null => (v && typeof v === "object" && Array.isArray((v as KeysRead).properties) ? (v as KeysRead) : null);

/** Where a key at `from` should land under the operation (what the host plans, worked out again here). */
export function expectedTime(
  op: TransformOperation,
  ctx: { snap: boolean; frame_duration: number; span: { from: number; to: number }; pivot?: number },
  from: number
): number {
  let t = from;
  switch (op.type) {
    case "shift":
      t = from + (op.by !== undefined ? op.by : (op.frames ?? 0) * ctx.frame_duration);
      break;
    case "move_to":
      t = from + (op.time - ctx.span.from);
      break;
    case "scale": {
      let pivot = ctx.span.from;
      if (op.pivot === "time") pivot = op.pivot_time ?? pivot;
      else if (op.pivot === "playhead") pivot = ctx.pivot ?? pivot;
      t = pivot + (from - pivot) * op.factor;
      break;
    }
    case "reverse":
      t = ctx.span.from + ctx.span.to - from;
      break;
    case "copy_to":
      t = from + (op.at_time !== undefined ? op.at_time - ctx.span.from : 0);
      break;
  }
  if (ctx.snap && ctx.frame_duration > 0) return Math.round(t / ctx.frame_duration) * ctx.frame_duration;
  return t;
}

/** One side of a key's ease after the operation: reversed time flips the slope (only where the speed has a sign: OneD / TwoD / ThreeD, not spatial, Color or Shape), scaled time divides it. */
export function expectedEase(side: EaseSide[] | undefined, op: TransformOperation, unsigned: boolean): EaseSide[] | undefined {
  if (!side) return side;
  if (op.type === "reverse") return side.map((e) => ({ speed: unsigned || e.speed === 0 ? e.speed : -e.speed, influence: e.influence }));
  if (op.type === "scale") return side.map((e) => ({ speed: e.speed / op.factor, influence: e.influence }));
  return side;
}

const closeNumber = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));

export function valuesClose(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return closeNumber(a, b, 1e-4);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => valuesClose(x, b[i]));
  if (a === null || b === null || a === undefined || b === undefined) return a === b;
  if (typeof a === "object" && typeof b === "object") return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}

function addDelta(v: unknown, delta: number | number[] | undefined): unknown {
  if (delta === undefined) return v;
  if (typeof v === "number" && typeof delta === "number") return v + delta;
  if (Array.isArray(v) && Array.isArray(delta)) return v.map((x, i) => (x as number) + (delta[i] ?? 0));
  return v;
}

function easeMismatch(want: EaseSide[] | undefined, got: EaseSide[] | undefined): boolean {
  if (!want || !got) return false;
  const n = Math.min(want.length, got.length);
  for (let i = 0; i < n; i++) {
    if (!closeNumber(want[i].speed, got[i].speed, 1e-3)) return true;
    if (Math.abs(want[i].influence - got[i].influence) > 0.1) return true;
  }
  return false;
}

function tangentMismatch(want: number[] | undefined, got: number[] | undefined): boolean {
  if (!want || !got) return false;
  const n = Math.min(want.length, got.length);
  for (let i = 0; i < n; i++) if (!closeNumber(want[i], got[i], 1e-3)) return true;
  return false;
}

const keyOf = (layerId: number, path: Array<string | number>, follower: number | null) => `${layerId}|${path.join("\u0001")}|${follower ?? ""}`;

interface Expected {
  time: number;
  moved: boolean;
  move?: KeyMove;
  key: ReadKey;
  srcKey?: ReadKey;
}

/**
 * Compares the keys read before and after with what the plan says happened:
 * every moved key at its planned time (roving keys excepted, AE retimes those) carrying its value, interpolation, eases
 * and tangents (swapped and sign-flipped for a reverse, speeds divided for a
 * scale); every other key where it was; the count; and that the times the host
 * reports are the ones the operation gives.
 */
export function transformMismatches(op: TransformOperation, beforeRaw: unknown, afterRaw: unknown, written: Record<string, unknown>): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const before = readOf(beforeRaw);
  const after = readOf(afterRaw);
  const w = written as unknown as TransformPlan;
  if (!before || !after || !Array.isArray(w.targets) || w.no_op) return m;
  const find = (r: KeysRead, t: { layer_id: number; path: Array<string | number>; follower: number | null }) =>
    r.properties.find((p) => keyOf(p.layer_id, p.path, p.follower) === keyOf(t.layer_id, t.path, t.follower));
  const ctx = { snap: w.snap, frame_duration: w.frame_duration, span: w.span, pivot: w.pivot };
  const push = (path: string, expected: unknown, actual: unknown, message: string) => {
    if (m.length < MAX_MISMATCHES) m.push({ path, expected, actual, message });
  };
  const source = w.targets.find((t) => t.role === "source");
  for (const t of w.targets) {
    if (t.role === "source") continue;
    const label = `${t.layer_name}.${t.property}`;
    const b = find(before, t);
    const a = find(after, t);
    if (!b || !a) {
      push(label, "property", undefined, `${label} could not be read back`);
      continue;
    }
    if (b.truncated || a.truncated) continue;
    const spatial = a.spatial === true;
    // Speed has a sign only on OneD / TwoD / ThreeD; a read without the flag falls back to "not spatial".
    const unsignedSpeed = a.signed_speed === undefined ? spatial : a.signed_speed !== true;
    const srcB = source ? find(before, source) : undefined;
    const entries: Expected[] = [];
    if (t.role === "destination") {
      b.keys.forEach((k) => entries.push({ time: k.time, moved: false, key: k }));
      for (const mv of t.moves) {
        const sk = srcB?.keys[mv.from_index - 1];
        if (!sk) {
          push(`${label}.moves`, "a source key", undefined, `Source key ${mv.from_index} was not in the before read`);
          continue;
        }
        entries.push({ time: mv.to, moved: true, move: mv, key: sk, srcKey: sk });
      }
    } else {
      const byFrom = new Map(t.moves.map((mv) => [mv.from_index, mv]));
      b.keys.forEach((k, i) => {
        const mv = byFrom.get(i + 1);
        entries.push({ time: mv ? mv.to : k.time, moved: !!mv, move: mv, key: k });
      });
    }
    const wantCount = entries.length;
    expectThat(m, a.numKeys === wantCount, `${label}.numKeys`, wantCount, a.numKeys, "Key count is not what the operation gives");
    if (a.numKeys !== wantCount) continue;
    // The times the host reports must be the ones the operation gives.
    for (const e of entries) {
      if (!e.moved || !e.move) continue;
      const want = expectedTime(op, ctx, e.move.from);
      if (Math.abs(want - e.move.to) > 1e-6) push(`${label}.keys[${e.move.from_index}]`, want, e.move.to, `The host moved a key from ${e.move.from}s to ${e.move.to}s; the operation gives ${want}s`);
    }
    const order = entries.map((e, i) => ({ e, i })).sort((x, y) => x.e.time - y.e.time);
    order.forEach(({ e }, rank) => {
      const got = a.keys[rank];
      const at = `${label}.keys[${rank + 1}]`;
      if (!got) return;
      if (e.move) expectThat(m, e.move.new_index === rank + 1, `${at}.index`, rank + 1, e.move.new_index, "The host's new key index is not the key's rank in time");
      // AE retimes roving keys itself (writeKeys turns roving back on once every key exists), so their times are not held to the plan, moved or not.
      const roving = e.key.roving === true;
      if (!roving) expectThat(m, Math.abs(got.time - e.time) <= TIME_TOLERANCE, `${at}.time`, e.time, got.time, `Key is at ${got.time}s, not ${e.time}s`);
      const delta = t.role === "destination" ? w.delta : undefined;
      const wantValue = e.moved ? addDelta(e.key.value, delta) : e.key.value;
      expectThat(m, valuesClose(wantValue, got.value), `${at}.value`, wantValue, got.value, "Key value changed");
      const reverse = op.type === "reverse" && e.moved;
      const wantIn = reverse ? e.key.outInterp : e.key.inInterp;
      const wantOut = reverse ? e.key.inInterp : e.key.outInterp;
      if (wantIn !== undefined && got.inInterp !== undefined) expectThat(m, got.inInterp === wantIn, `${at}.inInterp`, wantIn, got.inInterp, "In interpolation changed");
      if (wantOut !== undefined && got.outInterp !== undefined) expectThat(m, got.outInterp === wantOut, `${at}.outInterp`, wantOut, got.outInterp, "Out interpolation changed");
      // Unmoved keys are rebuilt too, so their eases and tangents are held to the before read unchanged.
      const bezierIn = wantIn === "bezier" && e.key.temporalAutoBezier !== true;
      const bezierOut = wantOut === "bezier" && e.key.temporalAutoBezier !== true;
      const easeIn = e.moved ? expectedEase(reverse ? e.key.easeOut : e.key.easeIn, op, unsignedSpeed) : e.key.easeIn;
      const easeOut = e.moved ? expectedEase(reverse ? e.key.easeIn : e.key.easeOut, op, unsignedSpeed) : e.key.easeOut;
      if (bezierIn && easeMismatch(easeIn, got.easeIn)) push(`${at}.easeIn`, easeIn, got.easeIn, "In ease changed");
      if (bezierOut && easeMismatch(easeOut, got.easeOut)) push(`${at}.easeOut`, easeOut, got.easeOut, "Out ease changed");
      if (spatial && e.key.spatialAutoBezier !== true) {
        const tin = reverse ? e.key.tangentOut : e.key.tangentIn;
        const tout = reverse ? e.key.tangentIn : e.key.tangentOut;
        if (tangentMismatch(tin, got.tangentIn)) push(`${at}.tangentIn`, tin, got.tangentIn, "In tangent changed");
        if (tangentMismatch(tout, got.tangentOut)) push(`${at}.tangentOut`, tout, got.tangentOut, "Out tangent changed");
      }
    });
  }
  return m;
}

// ---------- ae_keyframes_transform: tool ----------

interface SelectionTarget {
  layer_id: number;
  layer_name: string;
  path: Array<string | number>;
  property: string;
  num_keys: number;
  indexes: number[];
  times: number[];
}

interface SelectionRead {
  targets: SelectionTarget[];
  truncated: boolean;
  truncated_reason?: "properties" | "layers";
}

interface HostTarget {
  layer: { id?: number; index?: number; name?: string };
  path: Array<string | number>;
  follower?: number | null;
  indexes?: number[];
  num_keys?: number;
}

export function readTargetsOf(plan: TransformPlan) {
  return plan.targets.filter((t) => t.role !== "edited" || t.indexes.length > 0).map((t) => ({ layer: { id: t.layer_id }, path: t.path, follower: t.follower }));
}

export function writeTargetsOf(plan: TransformPlan): HostTarget[] {
  return plan.targets
    .filter((t) => t.role !== "destination" && t.indexes.length > 0)
    .map((t) => ({ layer: { id: t.layer_id }, path: t.path, follower: t.follower, indexes: t.indexes, num_keys: t.num_keys }));
}

const transformTool: ToolDefinition<any> = {
  name: "ae_keyframes_transform",
  description:
    "Retime keyframes without losing anything: shift (seconds or frames), scale time around a pivot, reverse, move so the first key lands at a time, or copy to another property (optionally relative to its value). " +
    "Targets are {layer, path} pairs, or keys: 'selected' for the keys selected in the timeline (resolved to explicit properties and indexes; check them in the dry run). A filter narrows to a time range or key indexes. " +
    "All moved keys move together as one block (a reverse mirrors the whole span, move_to puts the earliest key at the time), across every target. " +
    "AE has no move-key call, so each property's keys are rebuilt: value, in and out interpolation, ease per dimension, spatial tangents, continuity, auto-bezier, roving, label and selection are kept; " +
    "a reverse swaps in and out (and flips the sign of ease speed on non-spatial one-, two- and three-dimensional properties; spatial, Color and Shape speeds have no sign and stay as they are), a scale divides ease speed by the factor and keeps influence. " +
    "Moved keys snap to whole frames unless snap is false. Two keys landing on one frame, a locked layer, a keyframe-less target or a property with over 500 keys are refused before anything changes. " +
    "A separated Position (X/Y/Z) moves per dimension. Warns about expressions that read key(n) / nearestKey, roving keys (AE retimes those), and keys landing outside the comp. " +
    "dry_run returns the planned times per key. The read-back (a separate evalScript) compares each key's time (roving keys excepted: AE retimes those), value, interpolation, eases and tangents. expect is required unless dry_run. " +
    AGENT_SAFETY_GUIDANCE,
  schema: AeKeyframesTransformSchema,
  handler: async (args: z.infer<typeof AeKeyframesTransformSchema>, ctx) => {
    const toolName = "ae_keyframes_transform";
    let targets: HostTarget[];
    let selection: { source: string; properties: number } | undefined;
    if (args.dry_run !== true) {
      // Guard before the selection read and the plan, so a wrong project fails with the guard error and not a misleading not_found / bad_args / no_match from another project's ids.
      ctx.quarantine.assertClear();
      await verifyTargetGuard(ctx, { project_path: args.expect!.project_path, comp_id: args.expect!.comp_id ?? args.comp_id }, ctx.bridge.newOpId());
    }
    if (args.keys === "selected") {
      const res = await ctx.bridge.callHost<SelectionRead>("timelineSelection", { comp_id: args.comp_id }, { label: `${toolName} (selection)`, mutates: false, toolName });
      const sel = res.result;
      if (sel.truncated) {
        const message =
          sel.truncated_reason === "layers"
            ? "The comp has more than 500 layers; only the first 500 were searched for selected keys. Pass targets instead."
            : "Keys are selected on more than 50 properties; select fewer, or pass targets.";
        return { ok: false, error: "bad_args", message };
      }
      if (!sel.targets.length) return { ok: false, error: "no_match", message: "No keys are selected in the timeline; nothing was changed." };
      targets = sel.targets.map((t) => ({ layer: { id: t.layer_id }, path: t.path, indexes: t.indexes, num_keys: t.num_keys }));
      selection = { source: "selected keys", properties: sel.targets.length };
    } else {
      targets = args.targets!.map((t) => ({ layer: t.layer, path: t.path }));
    }
    const planned = await ctx.bridge.callHost<TransformPlan>(
      "timelineKeysTransform",
      { comp_id: args.comp_id, targets, filter: args.filter, operation: args.operation, snap: args.snap, dry_run: true },
      { label: `${toolName} (plan)`, mutates: false, toolName }
    );
    const plan = planned.result;
    if (args.dry_run) return { ok: true, ...plan, dry_run: true, ...(selection ? { selection } : {}) };
    if (!plan.changed) {
      return { ok: true, ...plan, dry_run: undefined, no_op: true, message: "The operation leaves every key where it is; nothing was changed.", ...(selection ? { selection } : {}) };
    }
    const readTargets = readTargetsOf(plan);
    return runGuardedWrite(ctx, {
      toolName,
      label: `${toolName}(${args.operation.type})`,
      expect: args.expect!,
      compId: args.comp_id,
      read: () => ({ host: "timelineKeysRead", args: { comp_id: args.comp_id, targets: readTargets } }),
      write: {
        host: "timelineKeysTransform",
        // The plan's own targets and key indexes: the host plans again from them and refuses if the keys changed.
        args: { comp_id: args.comp_id, targets: writeTargetsOf(plan), operation: args.operation, snap: args.snap, label: `Transform keyframes (${args.operation.type})` },
        timeoutMs: SLOW_TIMEOUT_MS,
      },
      check: (before, after, w) => transformMismatches(args.operation, before, after, w),
      present: (_before, _after, w) => ({ ...w, ...(selection ? { selection } : {}) }),
    });
  },
};

// ---------- ae_detect_cuts ----------

export const AeDetectCutsSchema = z
  .object({
    comp_id: z.number().int(),
    layer: LayerSelectorSchema,
    mode: z
      .enum(["list", "markers", "split", "split_precomp"])
      .optional()
      .describe("list (default): only report the cut times. markers: add a layer marker at each cut. split: split the layer at each cut. split_precomp: split and pre-compose each shot."),
    expect: ExpectSchema.optional().describe((ExpectSchema.description ?? "") + " Required unless mode is 'list'."),
  })
  .refine((v) => (v.mode ?? "list") === "list" || v.expect !== undefined, { message: "markers, split and split_precomp change the comp and need expect; mode 'list' does not." });

export interface CutsResult {
  mode: string;
  layer_id: number;
  layer_index: number;
  layer_name: string;
  source_name: string;
  clip_duration: number | null;
  layer_duration: number;
  cuts: number[];
  cut_count: number;
  cuts_truncated: boolean;
  cuts_known: boolean;
  num_layers_before: number;
  no_op?: boolean;
}

const LONG_CLIP_NOTE =
  "Scene Edit Detection analyses the whole clip inside one evalScript: a long clip keeps After Effects busy until it finishes (never abort it). ";

/** What markers / split / split_precomp should have changed, judged from the reads before and after. */
export function detectCutsMismatches(mode: string, beforeRaw: unknown, afterRaw: unknown, w: Written): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const cuts = typeof w.cut_count === "number" ? w.cut_count : undefined;
  const known = w.cuts_known === true && cuts !== undefined;
  if (mode === "markers") {
    const before = beforeRaw as MarkerList | null;
    const after = afterRaw as MarkerList | null;
    if (!before || !after || before.truncated || after.truncated) return m;
    expectThat(m, after.numMarkers >= before.numMarkers, "numMarkers", `>= ${before.numMarkers}`, after.numMarkers, "Layer markers were lost");
    if (known && cuts! > 0) expectThat(m, after.numMarkers > before.numMarkers, "numMarkers", `> ${before.numMarkers}`, after.numMarkers, `${cuts} cut(s) were found but no marker was added`);
    if (known && cuts === 0) expectThat(m, after.numMarkers === before.numMarkers, "numMarkers", before.numMarkers, after.numMarkers, "No cut was found but the markers changed");
    return m;
  }
  const before = beforeRaw as OpsStack | null;
  const after = afterRaw as OpsStack | null;
  if (!before || !after) return m;
  if (known && cuts! > 0) expectThat(m, after.numLayers > before.numLayers, "numLayers", `> ${before.numLayers}`, after.numLayers, `${cuts} cut(s) were found but the layer count did not grow`);
  if (known && cuts === 0) expectThat(m, after.numLayers === before.numLayers, "numLayers", before.numLayers, after.numLayers, "No cut was found but the layer count changed");
  expectThat(m, after.numLayers >= before.numLayers - 1, "numLayers", `>= ${before.numLayers - 1}`, after.numLayers, "Layers were lost");
  return m;
}

type Written = Record<string, unknown>;

const detectTool: ToolDefinition<any> = {
  name: "ae_detect_cuts",
  description:
    "Run After Effects' Scene Edit Detection on a footage or pre-comp layer to find the cuts in a flattened edit or reference reel. " +
    "mode 'list' (default) only reports the cut times (read-only; no expect needed); 'markers' adds a layer marker at each cut; 'split' splits the layer at each cut; 'split_precomp' also pre-composes every shot (many new project items, one big undo step). " +
    "Works only on a video AV layer with a footage or pre-comp source and time remapping off (checked before anything runs); needs AE 22.3+. " +
    LONG_CLIP_NOTE +
    "The reply states the clip duration. Cut times are composition time per the Scripting Guide. " +
    "For split modes the layer stack is read before and after (a separate evalScript), and layer(n) references in expressions that now point at another layer come back as expression_warnings. " +
    AGENT_SAFETY_GUIDANCE,
  schema: AeDetectCutsSchema,
  handler: async (args: z.infer<typeof AeDetectCutsSchema>, ctx) => {
    const toolName = "ae_detect_cuts";
    const mode = args.mode ?? "list";
    if (mode === "list") {
      const res = await ctx.bridge.callHost<CutsResult>(
        "timelineDetectCuts",
        { comp_id: args.comp_id, layer: args.layer, mode },
        { label: `${toolName} (list)`, mutates: false, toolName, timeoutMs: SLOW_TIMEOUT_MS }
      );
      return {
        ok: true,
        ...res.result,
        note: `${LONG_CLIP_NOTE}The clip is ${res.result.clip_duration ?? "of unknown length"}s long. Cut times are composition time per the Scripting Guide.`,
      };
    }
    const readCall = (phase: "before" | "after", written?: Written) => {
      if (mode === "markers") {
        const layer = phase === "after" && typeof written?.layer_id === "number" ? { id: written.layer_id } : args.layer;
        return { host: "listMarkers", args: { comp_id: args.comp_id, layer } };
      }
      return { host: "layeropsRead", args: { comp_id: args.comp_id, scan_expressions: true } };
    };
    return runGuardedWrite(ctx, {
      toolName,
      label: `${toolName}(${mode})`,
      expect: args.expect!,
      compId: args.comp_id,
      read: readCall,
      write: {
        host: "timelineDetectCuts",
        args: { comp_id: args.comp_id, layer: args.layer, mode, label: `Scene edit detection (${mode})` },
        timeoutMs: SLOW_TIMEOUT_MS,
      },
      check: (before, after, w) => detectCutsMismatches(mode, before, after, w),
      present: (before, after, w) => {
        const out: Record<string, unknown> = {
          ...w,
          note: `${LONG_CLIP_NOTE}The clip is ${w.clip_duration ?? "of unknown length"}s long.`,
        };
        if (mode === "markers") {
          out.markers_before = (before as MarkerList | null)?.numMarkers;
          out.markers_after = (after as MarkerList | null)?.numMarkers;
          return out;
        }
        const b = before as OpsStack | null;
        const a = after as OpsStack | null;
        out.layers_before = b?.numLayers;
        out.layers_after = a?.numLayers;
        let warnings: ExpressionWarning[] = [];
        if (b && a && !w.no_op) {
          const map = indexMapFromStack(b, a);
          const byIndex = new Map(a.layers.map((l) => [l.index, l]));
          warnings = indexReferenceWarnings(b, map, (index) => {
            const l = byIndex.get(index);
            return l ? { layer_id: l.id, layer_name: l.name } : undefined;
          });
        }
        out.expression_warnings = warnings;
        return out;
      },
    });
  },
};

export const timelineTools: ToolDefinition<any>[] = [transformTool, detectTool];
