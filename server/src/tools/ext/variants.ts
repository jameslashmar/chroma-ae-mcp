/**
 * server/src/tools/ext/variants.ts
 *
 * Variants: try several versions of a change as comp copies and keep the one
 * the user picks, so the user's comp isn't touched until they choose.
 * - ae_variants: duplicates the comp once per variant into a "chroma variants"
 *   folder, applies that variant's ops to the copy (all in one undo group),
 *   renders a few frames of each, tiles them into labelled contact sheets and
 *   (by default) asks the user through ae_ask_user with a picture per option.
 *   `dry_run` only checks the ops against the comp.
 * - ae_variants_pick: replays the chosen variant's ops on the original as one
 *   undo step, after a digest check that the comp didn't change while the user
 *   chose, then removes or parks the copies and logs the pick.
 * - ae_variants_discard: removes or parks the copies without applying any.
 *
 * Ops are data (color, set_value, offset, shift_time, ease, comp_duration), so
 * the spec that built a copy is replayed on the original; keys are never
 * copied back from a copy. An op only touches the layers of one comp: the
 * contents of a nested precomp are shared with the duplicate and are never
 * edited. The pick log (variant-picks.jsonl) sits in the data folder, apart
 * from ae_taste's preferences, which change only on the user's word.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { ReceiptMismatch } from "../../receipts.js";
import { AGENT_SAFETY_GUIDANCE, dataDirOf, ExpectSchema, LayerSelectorSchema, type ToolContext, type ToolDefinition } from "../common.js";
import { EASE_CURVE_ARRAY_SCHEMA } from "./animate.js";
import { AeAskUserSchema, askTools } from "./ask.js";
import { analyzeDecodedFrame, captureCompFrame, decodePngFile, type FrameFlag } from "./frames.js";
import { buildContactSheet, sheetLayout, type SheetTile } from "./motion.js";
import { encodePng, resizeArea } from "./png-utils.js";
import { expectThat, runGuardedWrite } from "./write-runner.js";

export const VARIANTS_FOLDER = "chroma variants";
const MAX_TARGETS = 500;
/** The host reads at most this many keys per property. */
const MAX_PROBE_KEYS = 500;

// ---------- ease presets ----------

/** Named curves for the ease op (cubic-bezier [x1, y1, x2, y2]). A curve of the user's own can be given instead. */
export const EASE_PRESETS = {
  easy_ease: [0.333, 0, 0.667, 1],
  gentle: [0.25, 0.1, 0.25, 1],
  snappy: [0.2, 0, 0, 1],
  expo_out: [0.16, 1, 0.3, 1],
  ease_in: [0.42, 0, 0.99, 1],
  overshoot: [0.34, 1.56, 0.64, 1],
  anticipate: [0.6, -0.28, 0.74, 0.05],
} as const satisfies Record<string, readonly [number, number, number, number]>;

// ---------- schemas ----------

const Layers = z.array(LayerSelectorSchema).min(1).max(50).describe("The layers to change, picked in the original comp (id, index or a unique name). Their position in this list is what `stagger` and `cumulative` count.");
const PropertyPath = z
  .array(z.string().min(1))
  .min(1)
  .max(8)
  .describe('Match-name path to the property, such as ["ADBE Transform Group", "ADBE Opacity"] or ["ADBE Effect Parade", "ADBE Fill", "ADBE Fill-0002"]. Find paths with the property tools.');

const ColorOp = z
  .object({
    op: z.literal("color"),
    layers: Layers,
    path: PropertyPath,
    color: z.array(z.number().min(0).max(1)).min(3).max(4).describe("[r, g, b] or [r, g, b, a], each 0..1. A keyframed colour gets this value on every key."),
  })
  .describe("Set a colour property (a fill, a stroke, an effect colour) on each layer.");

const SetValueOp = z
  .object({
    op: z.literal("set_value"),
    layers: Layers,
    path: PropertyPath,
    value: z.union([z.number(), z.array(z.number()).min(2).max(3)]).describe("A number, or [x, y(, z)] for a vector. Dimensions you leave out keep their value."),
  })
  .describe("Set a number or vector property (opacity, scale, an effect amount). Refused on a keyframed property or one with an expression; checked against the property's own limits.");

const OffsetOp = z
  .object({
    op: z.literal("offset"),
    layers: Layers,
    delta: z.array(z.number()).min(2).max(3).describe("[dx, dy(, dz)] added to the property."),
    path: PropertyPath.optional().describe("Default Transform > Position. Any 2D or 3D property."),
    cumulative: z.boolean().optional().describe("Layer n in `layers` (counting from 0) moves by delta x n, for a fanned-out layout. Default false: every layer moves by delta."),
  })
  .describe("Move a position-like property by an amount. A keyframed property moves every key by it.");

const ShiftTimeOp = z
  .object({
    op: z.literal("shift_time"),
    layers: Layers,
    offset: z.number().optional().describe("Seconds added to every layer's start time."),
    stagger: z.number().optional().describe("Extra seconds per layer: layer n in `layers` (from 0) starts stagger x n later."),
  })
  .describe("Shift when layers start, with an optional stagger. Offset and stagger are each 0 or at least one frame of the comp. Only one shift_time per layer in a variant.");

const EaseOp = z
  .object({
    op: z.literal("ease"),
    layers: Layers,
    path: PropertyPath.optional().describe("The animated property (a number, vector or colour with two or more keyframes). Default: every Transform property of each layer that has two or more keyframes, Position and Anchor Point included. A spatial property (Position, Anchor Point) refuses overshoot, anticipate and any curve with y1 below 0 or y2 above 1, so give such a curve an explicit non-spatial path."),
    ease: z
      .union([z.enum(Object.keys(EASE_PRESETS) as [keyof typeof EASE_PRESETS, ...Array<keyof typeof EASE_PRESETS>]), EASE_CURVE_ARRAY_SCHEMA])
      .describe(
        `A preset (${Object.keys(EASE_PRESETS).join(", ")}) or your own cubic-bezier [x1, y1, x2, y2], such as the user's preferred_ease from ae_taste. ` +
          "It shapes every segment between neighbouring keys. Overshoot, anticipate and other curves that leave 0..1 are refused as a whole when they meet a keyed Position or Anchor Point. Speeds come from each segment's duration and straight-line distance, so on a curved motion path they are approximate."
      ),
  })
  .describe("Re-ease the keyframes of animated properties with a curve.");

const CompDurationOp = z
  .object({
    op: z.literal("comp_duration"),
    seconds: z.number().positive().max(10800).describe("The comp's new duration in seconds. Layers keep their own length."),
  })
  .describe("Change the comp's duration.");

export const VariantOpSchema = z.discriminatedUnion("op", [ColorOp, SetValueOp, OffsetOp, ShiftTimeOp, EaseOp, CompDurationOp]);
export type VariantOp = z.infer<typeof VariantOpSchema>;

const VariantSchema = z.object({
  id: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,40}$/, "id: letters, digits, _ and - only, up to 40")
    .describe("Short id (it names the copy and is what the user's pick returns), such as 'a' or 'warm'."),
  label: z.string().min(1).max(120).describe("What the user sees on the button, such as 'Snappy ease, warm palette'."),
  ops: z.array(VariantOpSchema).min(1).max(20),
});
export type Variant = z.infer<typeof VariantSchema>;

const CleanupSchema = z
  .enum(["delete", "park"])
  .describe("'delete' (default) removes the copies; 'park' leaves them in the 'chroma variants' folder. Only comps in that folder that no other comp uses are ever removed.");

const SetIdSchema = z.string().regex(/^vs_[0-9a-f]{8}$/, "set_id comes from ae_variants").describe("The set_id ae_variants returned.");

export function countTargets(ops: VariantOp[]): number {
  return ops.reduce((n, op) => n + ("layers" in op ? op.layers.length : 1), 0);
}

/**
 * Two ops of one variant on the same target (a layer's property, a layer's
 * start time, the comp duration) would overwrite each other, since every op is
 * worked out against the unmodified comp. Finds the first repeat among the
 * selectors that can be compared here; the host also checks resolved layers.
 */
export function findOverlap(ops: VariantOp[]): { index: number; message: string } | null {
  const seen = new Map<string, number>();
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const keys: Array<{ key: string; what: string }> = [];
    if (op.op === "comp_duration") {
      keys.push({ key: "comp_duration", what: "the comp duration" });
    } else {
      let propPath: string[] | null = null;
      if (op.op === "offset") propPath = op.path ?? ["ADBE Transform Group", "ADBE Position"];
      else if (op.op === "color" || op.op === "set_value" || op.op === "ease") propPath = op.path ?? null;
      // An ease without a path covers every keyed Transform property: not comparable here.
      if (op.op !== "shift_time" && !propPath) continue;
      for (const sel of op.layers) {
        let who: string | null = null;
        if (sel.id !== undefined) who = `id ${sel.id}`;
        else if (sel.index !== undefined) who = `index ${sel.index}`;
        else if (sel.name !== undefined) who = `name ${sel.name}`;
        if (!who) continue;
        const where = `${op.op === "shift_time" ? "the start time" : propPath!.join(" > ")} of layer (${who})`;
        if (op.op === "shift_time") {
          keys.push({ key: `start|${who}`, what: where });
        } else if (op.op === "ease") {
          // An ease only clashes with another ease or a colour/value write; it sits fine beside an offset.
          keys.push({ key: `ease ${propPath!.join(">")}|${who}`, what: where });
        } else if (op.op === "offset") {
          keys.push({ key: `prop ${propPath!.join(">")}|${who}`, what: where });
        } else {
          keys.push({ key: `prop ${propPath!.join(">")}|${who}`, what: where });
          keys.push({ key: `ease ${propPath!.join(">")}|${who}`, what: where });
        }
      }
    }
    for (const k of keys) {
      const first = seen.get(k.key);
      if (first !== undefined) return { index: i, message: `op ${i + 1} (${op.op}) changes ${k.what}, which op ${first + 1} already changes in this variant; combine them into one op or use separate variants.` };
    }
    for (const k of keys) seen.set(k.key, i);
  }
  return null;
}

export const AeVariantsSchema = z
  .object({
    comp_id: z.number().int().describe("The comp to make variants of. It is left untouched; variants are copies."),
    variants: z.array(VariantSchema).min(2).max(6).describe("2 to 6 versions of the change, 3 to 6 is typical. Each is a list of ops applied to its own copy of the comp."),
    times: z
      .array(z.number().min(0))
      .min(1)
      .max(3)
      .optional()
      .describe("Comp times (seconds) to render of each variant, 1 to 3. Default: the middle of the work area. Pick moments that show the change."),
    ask: z.boolean().optional().describe("Ask the user which variant through ae_ask_user, with a picture per option (default true). Needs the panel; without it the result says so and you ask in the chat."),
    question: z.string().min(1).max(500).optional().describe("The question to ask. Default names the comp."),
    wait_seconds: z.number().int().min(0).max(600).optional().describe("How long to wait for the user's answer (default 120). On a timeout the ask_id comes back for ae_ask_user."),
    tile_size: z.number().int().min(64).max(800).optional().describe("Longest edge in pixels of each rendered frame on the sheets. Default 360."),
    dry_run: z.boolean().optional().describe("Only check the ops against the comp and list what each variant would change. Creates and renders nothing."),
    folder_name: z.string().min(1).max(80).optional().describe(`Project folder for the copies. Default '${VARIANTS_FOLDER}'.`),
    expect: ExpectSchema,
  })
  .superRefine((v, ctx) => {
    const ids = v.variants.map((x) => x.id);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Variant ids must be unique.", path: ["variants"] });
    const total = v.variants.reduce((n, x) => n + countTargets(x.ops), 0);
    if (total > MAX_TARGETS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `At most ${MAX_TARGETS} layer changes across all variants (this has ${total}).`, path: ["variants"] });
    }
    v.variants.forEach((x, vi) => {
      x.ops.forEach((op, oi) => {
        if (op.op === "shift_time" && !op.offset && !op.stagger) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "shift_time needs a non-zero offset or stagger.", path: ["variants", vi, "ops", oi] });
        }
      });
      const clash = findOverlap(x.ops);
      if (clash) ctx.addIssue({ code: z.ZodIssueCode.custom, message: clash.message, path: ["variants", vi, "ops", clash.index] });
    });
  });

export const AeVariantsPickSchema = z.object({
  comp_id: z.number().int().describe("The original comp the variants were made from."),
  set_id: SetIdSchema,
  variant_id: z.string().min(1).describe("The id of the variant the user chose (the ae_ask_user answer, or `chosen_variant_id`)."),
  cleanup: CleanupSchema.optional(),
  expect: ExpectSchema,
});

export const AeVariantsDiscardSchema = z.object({
  comp_id: z.number().int().describe("The original comp the variants were made from."),
  set_id: SetIdSchema,
  cleanup: CleanupSchema.optional(),
  expect: ExpectSchema,
});

// ---------- pure helpers ----------

export type HostOp = Record<string, unknown>;

/** The ops as the host takes them: an ease preset becomes its curve. */
export function toHostOps(ops: VariantOp[]): HostOp[] {
  return ops.map((op) => {
    if (op.op !== "ease") return { ...op };
    const curve = typeof op.ease === "string" ? [...EASE_PRESETS[op.ease]] : op.ease;
    return { op: "ease", layers: op.layers, ...(op.path ? { path: op.path } : {}), curve };
  });
}

/** One line per op, for the button description. */
export function summariseOps(ops: VariantOp[]): string {
  const parts = ops.map((op) => {
    if (op.op === "comp_duration") return `duration ${op.seconds}s`;
    const n = op.layers.length;
    const on = `${n} layer${n === 1 ? "" : "s"}`;
    if (op.op === "color") return `colour on ${on}`;
    if (op.op === "set_value") return `set value on ${on}`;
    if (op.op === "offset") return `move ${on} by [${op.delta.join(", ")}]${op.cumulative ? " (fanned)" : ""}`;
    if (op.op === "shift_time") return `shift ${on}${op.offset ? ` by ${op.offset}s` : ""}${op.stagger ? ` staggered ${op.stagger}s` : ""}`;
    return `ease ${typeof op.ease === "string" ? op.ease : `[${op.ease.join(", ")}]`} on ${on}`;
  });
  const text = parts.join("; ");
  return text.length > 380 ? `${text.slice(0, 377)}...` : text;
}

/** The frame times to render when the caller gave none: the middle of the work area. */
export function defaultTimes(original: { workAreaStart?: number; workAreaDuration?: number; duration?: number }): number[] {
  const start = original.workAreaStart ?? 0;
  const span = original.workAreaDuration ?? original.duration ?? 0;
  return [Math.round((start + span / 2) * 1000) / 1000];
}

// ---------- what the host returns ----------

interface Probe {
  comp_id: number;
  kind: "values" | "start_time" | "comp_duration" | "ease";
  layer_index?: number;
  path?: string[];
  expected?: unknown;
  keys?: Array<{ key: number; in_influence?: number; out_influence?: number; in_speed?: number; out_speed?: number }>;
}

interface WrittenCopy {
  variant_id: string;
  label: string;
  comp_id: number;
  name: string;
  duration: number;
  changes: unknown[];
  probes: Probe[];
}

interface OriginalInfo {
  comp_id: number;
  name: string;
  width: number;
  height: number;
  fps: number;
  duration: number;
  workAreaStart: number;
  workAreaDuration: number;
  numLayers: number;
  digest?: string;
  digest_basis?: string;
  digest_truncated?: boolean;
}

interface ReadBack {
  /** null when the read was made without a comp_id (discard). */
  original: OriginalInfo | null;
  copies: Array<{ comp_id: number; exists: boolean; name?: string; numLayers?: number; in_folder?: boolean }>;
  probes: Array<{ ok: boolean; kind: string; error?: string; actual?: unknown }>;
  probes_truncated?: boolean;
}

/** How many written probes the after read did not cover (the host reads at most 500). */
export function unverifiedProbes(afterRaw: unknown, written: number): number {
  const after = asRead(afterRaw);
  if (!after) return 0;
  return Math.max(0, written - (Array.isArray(after.probes) ? after.probes.length : 0));
}

const asRead = (v: unknown): ReadBack | null => (v && typeof v === "object" ? (v as ReadBack) : null);

// ---------- checks ----------

const near = (a: number, b: number, tol = 1e-3) => Math.abs(a - b) <= tol + 1e-6 * Math.max(Math.abs(a), Math.abs(b));

/** Compares what a probe read back against what the write set. Dimensions the op didn't set are not compared. */
export function probeMismatches(where: string, probes: Probe[], read: ReadBack["probes"], fps: number, probesTruncated = false): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const frame = (fps > 0 ? 1 / fps : 0.05) * 1.01 + 1e-6;
  // A start time is not frame-snapped, and the host refuses shifts under a frame: half a frame tells a write from none.
  const halfFrame = (fps > 0 ? 1 / fps : 0.05) * 0.5;
  probes.forEach((p, i) => {
    const got = read[i];
    const name = `${where}.${p.kind}[${i}]${p.layer_index ? ` layer ${p.layer_index}` : ""}${p.path ? ` ${p.path[p.path.length - 1]}` : ""}`;
    if (!got) {
      // The host reads at most 500 probes; a probe past that can't be judged.
      if (!probesTruncated) m.push({ path: name, expected: p.expected, actual: undefined, message: "The property was not read back" });
      return;
    }
    if (!got.ok) {
      m.push({ path: name, expected: p.expected, actual: got.error, message: `The property could not be read back: ${got.error ?? "unknown error"}` });
      return;
    }
    if (p.kind === "start_time" || p.kind === "comp_duration") {
      expectThat(m, typeof got.actual === "number" && near(got.actual, p.expected as number, p.kind === "start_time" ? halfFrame : frame), name, p.expected, got.actual, p.kind === "start_time" ? "Start time differs" : "Duration differs");
    } else if (p.kind === "values") {
      // The host reads at most MAX_PROBE_KEYS keys: compare no more than it could return.
      const want = (p.expected as number[][]).slice(0, MAX_PROBE_KEYS);
      const have = got.actual as number[][];
      expectThat(m, Array.isArray(have) && have.length === want.length, name, want.length, Array.isArray(have) ? have.length : have, "Number of values (keys) differs");
      if (!Array.isArray(have) || have.length !== want.length) return;
      want.forEach((w, k) => {
        const h = have[k] ?? [];
        // A scalar expected value is a one-element list; a vector is compared on the dimensions given.
        const wv = Array.isArray(w) ? w : [w as unknown as number];
        expectThat(m, wv.every((x, d) => typeof h[d] === "number" && near(h[d], x)), `${name}[${k}]`, wv, h, "Value differs");
      });
    } else if (p.kind === "ease") {
      const have = got.actual as Array<{ key: number; in_influence: number | null; out_influence: number | null; in_speed?: number | null; out_speed?: number | null; in_interp: string; out_interp: string }>;
      // Speeds compare with a relative tolerance: AE rounds them.
      const speedNear = (a: number, b: number) => Math.abs(a - b) <= 1e-3 + 0.02 * Math.abs(b);
      for (const w of p.keys ?? []) {
        const h = Array.isArray(have) ? have.find((x) => x.key === w.key) : undefined;
        if (!h) {
          m.push({ path: `${name} key ${w.key}`, expected: w, actual: undefined, message: "Key not read back" });
          continue;
        }
        if (w.in_influence !== undefined) expectThat(m, h.in_influence !== null && near(h.in_influence, w.in_influence, 1), `${name} key ${w.key} in`, w.in_influence, h.in_influence, "In influence differs");
        if (w.out_influence !== undefined) expectThat(m, h.out_influence !== null && near(h.out_influence, w.out_influence, 1), `${name} key ${w.key} out`, w.out_influence, h.out_influence, "Out influence differs");
        if (w.in_speed !== undefined) expectThat(m, typeof h.in_speed === "number" && speedNear(h.in_speed, w.in_speed), `${name} key ${w.key} in speed`, w.in_speed, h.in_speed, "In speed differs");
        if (w.out_speed !== undefined) expectThat(m, typeof h.out_speed === "number" && speedNear(h.out_speed, w.out_speed), `${name} key ${w.key} out speed`, w.out_speed, h.out_speed, "Out speed differs");
        expectThat(m, h.in_interp === "bezier" && h.out_interp === "bezier", `${name} key ${w.key} interpolation`, "bezier", `${h.in_interp}/${h.out_interp}`, "Key is not bezier");
      }
    }
  });
  return m;
}

/** The checks for ae_variants: copies exist and line up with the original, their values are what the ops set, and the original is untouched. */
export function createMismatches(variants: Variant[], beforeRaw: unknown, afterRaw: unknown, written: { copies?: WrittenCopy[]; original?: OriginalInfo }): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const before = asRead(beforeRaw);
  const after = asRead(afterRaw);
  if (!after || !after.original) return m;
  const afterOriginal = after.original;
  const copies = written.copies ?? [];
  expectThat(m, copies.length === variants.length, "copies", variants.length, copies.length, "Number of copies differs from the number of variants");
  if (before?.original?.digest && afterOriginal.digest) {
    expectThat(m, before.original.digest === afterOriginal.digest, "original.digest", before.original.digest, afterOriginal.digest, "The original comp changed while the copies were made");
  }
  expectThat(m, afterOriginal.numLayers === (before?.original?.numLayers ?? afterOriginal.numLayers), "original.numLayers", before?.original?.numLayers, afterOriginal.numLayers, "The original comp's layer count changed");
  for (const c of copies) {
    const seen = after.copies.find((x) => x.comp_id === c.comp_id);
    expectThat(m, !!seen && seen.exists, `copies[${c.variant_id}]`, "exists", seen?.exists ? "exists" : "missing", "A variant copy is not in the project");
    if (!seen || !seen.exists) continue;
    expectThat(m, seen.numLayers === afterOriginal.numLayers, `copies[${c.variant_id}].numLayers`, afterOriginal.numLayers, seen.numLayers, "The copy's layer count differs from the original's");
    expectThat(m, seen.in_folder === true, `copies[${c.variant_id}].folder`, true, seen.in_folder, "The copy is not in the variants folder");
  }
  const all = copies.flatMap((c) => c.probes);
  m.push(...probeMismatches("variants", all, after.probes, afterOriginal.fps, after.probes_truncated === true));
  return m;
}

interface PromoteWritten extends Record<string, unknown> {
  changes?: unknown[];
  probes?: Probe[];
  cleanup?: { removed: number[]; parked: number[]; skipped: Array<{ comp_id: number; reason: string }>; folder_removed: boolean };
  original?: OriginalInfo;
}

/** Copies are gone when removed, still in the folder when parked, and the original has what the pick set. */
export function cleanupMismatches(beforeRaw: unknown, afterRaw: unknown, written: PromoteWritten): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const before = asRead(beforeRaw);
  const after = asRead(afterRaw);
  if (!after) return m;
  const cleanup = written.cleanup;
  for (const id of cleanup?.removed ?? []) {
    const seen = after.copies.find((x) => x.comp_id === id);
    expectThat(m, !seen || !seen.exists, `copies[${id}]`, "removed", "still in the project", "A copy that was removed is still in the project");
  }
  for (const id of cleanup?.parked ?? []) {
    const seen = after.copies.find((x) => x.comp_id === id);
    expectThat(m, !!seen && seen.exists && seen.in_folder === true, `copies[${id}]`, "parked in the folder", seen?.exists ? "elsewhere" : "missing", "A parked copy is not in the variants folder");
  }
  if (before?.original && after.original) {  // null on a read made without a comp_id
    expectThat(m, after.original.numLayers === before.original.numLayers, "original.numLayers", before.original.numLayers, after.original.numLayers, "The original's layer count changed");
  }
  return m;
}

export function promoteMismatches(beforeRaw: unknown, afterRaw: unknown, written: PromoteWritten): ReceiptMismatch[] {
  const after = asRead(afterRaw);
  if (!after) return [];
  return [...probeMismatches("pick", written.probes ?? [], after.probes, after.original?.fps ?? 0, after.probes_truncated === true), ...cleanupMismatches(beforeRaw, afterRaw, written)];
}

// ---------- the set record and the pick log ----------

export interface SetRecord {
  set_id: string;
  created_at: string;
  project_path: string;
  folder_name: string;
  original: { comp_id: number; name: string; digest?: string; digest_basis?: string };
  times: number[];
  variants: Array<{ id: string; label: string; ops: VariantOp[]; copy_comp_id: number; copy_name: string }>;
}

const setsDir = (ctx: ToolContext) => path.join(dataDirOf(ctx), "variants");
const setFile = (ctx: ToolContext, id: string) => path.join(setsDir(ctx), `${id}.json`);

/** Keeps a set so a later pick can replay its spec, even after a restart. Never throws. */
export function saveSet(ctx: ToolContext, rec: SetRecord): boolean {
  try {
    fs.mkdirSync(setsDir(ctx), { recursive: true });
    // Written beside the record and renamed over it, so a failed write never leaves half a record.
    const tmp = `${setFile(ctx, rec.set_id)}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(rec, null, 2));
      fs.renameSync(tmp, setFile(ctx, rec.set_id));
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // Nothing more to do.
      }
      throw err;
    }
    return true;
  } catch {
    return false;
  }
}

export function loadSet(ctx: ToolContext, id: string): SetRecord | null {
  try {
    return JSON.parse(fs.readFileSync(setFile(ctx, id), "utf8")) as SetRecord;
  } catch {
    return null;
  }
}

/** The host guard's path comparison: slashes, no trailing slash, case-insensitive on Windows. */
export function normProjectPath(p: string): string {
  if (p === "<unsaved>") return p;
  let s = p.split("\\").join("/");
  if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  if (process.platform === "win32") s = s.toLowerCase();
  return s;
}

function dropSet(ctx: ToolContext, id: string): void {
  try {
    fs.rmSync(setFile(ctx, id), { force: true });
  } catch {
    // A leftover record is harmless.
  }
}

/** Appends the pick to an append-only log kept apart from ae_taste. Returns the log path, or null when it couldn't be written. */
export function logPick(ctx: ToolContext, rec: SetRecord, pickedId: string, cleanup: string): string | null {
  try {
    const picked = rec.variants.find((v) => v.id === pickedId);
    const entry = {
      at: new Date().toISOString(),
      set_id: rec.set_id,
      project_path: rec.project_path,
      comp: { id: rec.original.comp_id, name: rec.original.name },
      picked: picked ? { id: picked.id, label: picked.label, ops: picked.ops } : { id: pickedId },
      rejected: rec.variants.filter((v) => v.id !== pickedId).map((v) => ({ id: v.id, label: v.label, ops: v.ops })),
      cleanup,
    };
    const file = path.join(dataDirOf(ctx), "variant-picks.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
    return file;
  } catch {
    return null;
  }
}

// ---------- rendering and the ask ----------

/** A copy's duration: its comp_duration op when it has one, else the original's (read before anything changed). */
export function copyDuration(ops: VariantOp[], original: { duration?: number }): number | undefined {
  let d = original.duration;
  for (const op of ops) if (op.op === "comp_duration") d = op.seconds;
  return d;
}

/** The last frame a comp of this length has is duration - 1/fps: a render at the duration itself is past it. */
export function clampRenderTime(time: number, duration: number | undefined, fps: number | undefined): number {
  if (typeof duration !== "number" || !(duration > 0)) return Math.max(0, time);
  const frame = fps && fps > 0 ? 1 / fps : 1 / 30;
  return Math.max(0, Math.min(time, duration - frame));
}

interface RenderedVariant {
  variant_id: string;
  strip_path?: string;
  frames: Array<{ time: number; path: string; flags: FrameFlag[] }>;
}

interface RenderResult {
  times: number[];
  sheet_path?: string;
  variants: RenderedVariant[];
  errors: string[];
}

const upper = (s: string) => s.toUpperCase();

/** Renders the frames of each copy (read-only) and tiles them: one strip per variant and one sheet of all. Never throws. */
export async function renderVariants(
  ctx: ToolContext,
  setId: string,
  original: OriginalInfo,
  copies: WrittenCopy[],
  times: number[],
  tileSize: number
): Promise<RenderResult> {
  const out: RenderResult = { times, variants: [], errors: [] };
  const framesDir = path.join(dataDirOf(ctx), "frames");
  const shots = new Map<string, Array<{ time: number; path: string }>>();
  try {
    fs.mkdirSync(framesDir, { recursive: true });
    const opId = ctx.bridge.newOpId();
    await ctx.queue.run(`ae_variants(${original.comp_id}) frames`, async () => {
      for (const c of copies) {
        const list: Array<{ time: number; path: string }> = [];
        shots.set(c.variant_id, list);
        for (let i = 0; i < times.length; i++) {
          const time = clampRenderTime(times[i], c.duration, original.fps);
          try {
            const snap = await captureCompFrame({ ctx, opId: `${opId}_${c.variant_id}`, compId: c.comp_id, time, frameIndex: i, framesDir, toolName: "ae_variants" });
            list.push({ time: snap.time, path: snap.path });
          } catch (err) {
            out.errors.push(`${c.variant_id} @ ${time}s: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    });
  } catch (err) {
    out.errors.push(`rendering stopped: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const allTiles: SheetTile[] = [];
    let columns = 1;
    for (const c of copies) {
      const list = shots.get(c.variant_id) ?? [];
      const rendered: RenderedVariant = { variant_id: c.variant_id, frames: [] };
      out.variants.push(rendered);
      if (!list.length) continue;
      const layout = sheetLayout(list.length, original.width, original.height, tileSize, list.length, true);
      const tiles: SheetTile[] = list.map((shot, index) => {
        const full = decodePngFile(shot.path);
        const analysis = analyzeDecodedFrame(full, { index, path: shot.path, time: shot.time });
        rendered.frames.push({ time: shot.time, path: shot.path, flags: analysis.flags });
        return { image: resizeArea(full, layout.tileWidth, layout.tileHeight), label: `${upper(c.variant_id)} ${shot.time.toFixed(2)}s`, flagged: analysis.flags.length > 0 };
      });
      const strip = path.join(framesDir, `variant_${setId}_${c.variant_id}_${crypto.randomBytes(3).toString("hex")}.png`);
      fs.writeFileSync(strip, encodePng(buildContactSheet(tiles, layout)));
      rendered.strip_path = strip;
      allTiles.push(...tiles);
      columns = Math.max(columns, list.length);
    }
    // Pad short rows so each variant keeps its own row on the combined sheet.
    if (allTiles.length) {
      const layout = sheetLayout(copies.length * columns, original.width, original.height, tileSize, columns, true);
      const padded: SheetTile[] = [];
      for (const r of out.variants) {
        const own = allTiles.splice(0, r.frames.length);
        for (let i = 0; i < columns; i++) {
          padded.push(own[i] ?? { image: resizeArea({ width: 1, height: 1, data: Buffer.from([24, 24, 24, 255]) }, layout.tileWidth, layout.tileHeight), flagged: false });
        }
      }
      const sheet = path.join(framesDir, `variants_${setId}_${crypto.randomBytes(3).toString("hex")}.png`);
      fs.writeFileSync(sheet, encodePng(buildContactSheet(padded, layout)));
      out.sheet_path = sheet;
    }
  } catch (err) {
    out.errors.push(`building the sheets failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return out;
}

/** Asks which variant, with a picture per option. Never throws. */
export async function askWhich(
  ctx: ToolContext,
  variants: Variant[],
  rendered: RenderResult,
  args: { question?: string; wait_seconds?: number },
  compName: string,
  folderName: string = VARIANTS_FOLDER
): Promise<{ ask: unknown; chosen_variant_id?: string }> {
  try {
    const parsed = AeAskUserSchema.parse({
      question: args.question ?? `Which variant of "${compName}" should I apply?`,
      kind: "choice",
      options: variants.map((v) => {
        const strip = rendered.variants.find((r) => r.variant_id === v.id)?.strip_path;
        return { id: v.id, label: v.label, description: summariseOps(v.ops), ...(strip ? { image_path: strip } : {}) };
      }),
      allow_other: true,
      context: `The copies are in the '${folderName}' folder; your comp is untouched until you pick.`,
      ...(args.wait_seconds !== undefined ? { wait_seconds: args.wait_seconds } : {}),
    });
    const answer = (await askTools[0].handler(parsed, ctx)) as { status?: string; chosen?: Array<{ id: string }> };
    const chosen = answer?.status === "answered" ? answer.chosen?.[0]?.id : undefined;
    return { ask: answer, ...(chosen && variants.some((v) => v.id === chosen) ? { chosen_variant_id: chosen } : {}) };
  } catch (err) {
    return { ask: { ok: false, error: "ask_failed", message: err instanceof Error ? err.message : String(err) } };
  }
}

// ---------- tools ----------

const hostVariants = (variants: Variant[]) => variants.map((v) => ({ id: v.id, label: v.label, ops: toHostOps(v.ops) }));
const probesOf = (copies: WrittenCopy[] | undefined): Probe[] => (copies ?? []).flatMap((c) => c.probes.map((p) => ({ ...p, comp_id: c.comp_id })));

export const variantsTools: ToolDefinition<any>[] = [
  {
    name: "ae_variants",
    description:
      "Try 2 to 6 versions of a change without touching the user's comp, and let them pick. Each variant is a list of ops (colour, set value, offset, shift or stagger start times, re-ease keyframes with a preset or curve, comp duration) applied to its own COPY of the comp, made in one undo group and parked in a 'chroma variants' folder. " +
      "The tool then renders 1 to 3 frames of each copy, tiles them into labelled contact sheets and, by default, asks the user with ae_ask_user (a picture per button). The answer comes back as `chosen_variant_id`; apply it with ae_variants_pick, or throw the copies away with ae_variants_discard. " +
      "Use it when the choice is a matter of taste (an ease, a palette, a layout, a timing) rather than guessing one version. Ops change only the layers of the comp itself: the contents of a nested precomp are shared with the copy and are never edited, and an expression that names another comp keeps pointing at the original (both are listed under `warnings`). " +
      "`dry_run` checks the ops and lists what each variant would change without creating anything. Every frame is a render, so keep `times` to 1 or 2 on heavy comps. The read-back (a separate evalScript) checks the copies exist with the original's layer count, that every property holds what its op set, and that the original is unchanged. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeVariantsSchema,
    handler: async (args: z.infer<typeof AeVariantsSchema>, ctx: ToolContext) => {
      const folder = args.folder_name ?? VARIANTS_FOLDER;
      const variants = hostVariants(args.variants);
      if (args.dry_run) {
        const res = await ctx.bridge.callHost("variantsPlan", { comp_id: args.comp_id, variants, folder_name: folder }, { label: `ae_variants(${args.comp_id}) dry run`, mutates: false, toolName: "ae_variants" });
        return { ok: true, ...(res.result as object) };
      }

      const setId = `vs_${crypto.randomBytes(4).toString("hex")}`;
      let unverified = 0;
      const result = await runGuardedWrite<{ copies?: WrittenCopy[]; original?: OriginalInfo; folder?: unknown; warnings?: unknown }>(ctx, {
        toolName: "ae_variants",
        label: `ae_variants(${args.variants.length} variants of comp ${args.comp_id})`,
        expect: args.expect,
        compId: args.comp_id,
        read: (phase, w) => ({
          host: "variantsRead",
          args: {
            comp_id: args.comp_id,
            folder_name: folder,
            ...(phase === "after" ? { copy_ids: (w?.copies ?? []).map((c) => c.comp_id), probes: probesOf(w?.copies) } : {}),
          },
        }),
        write: { host: "variantsCreate", args: { comp_id: args.comp_id, variants, folder_name: folder, label: "Chroma AE MCP: variants" } },
        check: (before, after, w) => {
          unverified = unverifiedProbes(after, probesOf(w.copies).length);
          return createMismatches(args.variants, before, after, w);
        },
        present: (before, _after, w) => {
          const b = asRead(before);
          // The host took its digest before writing; the before read is the fallback.
          const mine = w.original?.digest ? {} : b?.original?.digest ? { digest: b.original.digest, digest_basis: b.original.digest_basis, digest_truncated: b.original.digest_truncated } : {};
          return {
            set_id: setId,
            original: { ...w.original, ...mine },
            folder: w.folder,
            copies: (w.copies ?? []).map(({ probes: _probes, ...rest }) => rest),
            warnings: w.warnings,
          };
        },
      });

      // From here the copies exist: nothing below may throw.
      // set_id sits outside `present`, so it is there even when the read-back failed.
      const shown = { set_id: setId, ...(result as Record<string, any>) } as Record<string, any>;
      const original = (shown.original && typeof shown.original === "object"
        ? shown.original
        : { comp_id: args.comp_id, name: "", width: 0, height: 0, fps: 30, duration: 0, workAreaStart: 0, workAreaDuration: 0, numLayers: 0 }) as OriginalInfo;
      const copies = (Array.isArray(shown.copies) ? shown.copies : []).map((c: Omit<WrittenCopy, "probes">) => {
        // The host's duration was read in the script that set it: take it from the op instead.
        const v = args.variants.find((x) => x.id === c.variant_id);
        const duration = v ? copyDuration(v.ops, original) : undefined;
        return typeof duration === "number" && duration > 0 ? { ...c, duration } : c;
      }) as Array<Omit<WrittenCopy, "probes">>;
      shown.copies = copies;
      if (unverified > 0) {
        shown.unverified_probes = unverified;
        shown.receipt_note = `${unverified} written properties were not read back (the read-back covers 500 probes); the receipt does not vouch for them.`;
      }
      const times = args.times ?? defaultTimes(original);
      const saved = saveSet(ctx, {
        set_id: setId,
        created_at: new Date().toISOString(),
        project_path: args.expect.project_path,
        folder_name: folder,
        original: { comp_id: original.comp_id, name: original.name, digest: original.digest, digest_basis: original.digest_basis },
        times,
        variants: args.variants.map((v) => {
          const c = copies.find((x) => x.variant_id === v.id);
          return { id: v.id, label: v.label, ops: v.ops, copy_comp_id: c?.comp_id ?? -1, copy_name: c?.name ?? "" };
        }),
      });

      const rendered = await renderVariants(ctx, setId, original, copies as WrittenCopy[], times, args.tile_size ?? 360);
      const asked = args.ask === false ? {} : await askWhich(ctx, args.variants, rendered, args, original.name, folder);
      const picked = (asked as { chosen_variant_id?: string }).chosen_variant_id;
      return {
        ...shown,
        record_saved: saved,
        renders: rendered,
        ...asked,
        next: !saved
          ? `The variant record could not be stored, so ae_variants_pick and ae_variants_discard will not find set ${setId}. The copies exist in the '${folder}' folder: ${copies.map((c) => `${c.name} (comp ${c.comp_id})`).join(", ") || "none listed"}. Tell the user, and have them keep one by hand and delete the rest in After Effects (one undo removes them all).`
          : picked
          ? `The user chose "${picked}". Apply it with ae_variants_pick { comp_id: ${args.comp_id}, set_id: "${setId}", variant_id: "${picked}" }.`
          : `Show the sheet (renders.sheet_path) or ask the user, then ae_variants_pick { comp_id: ${args.comp_id}, set_id: "${setId}", variant_id } to apply one, or ae_variants_discard { comp_id: ${args.comp_id}, set_id: "${setId}" } to drop them all.`,
      };
    },
  },
  {
    name: "ae_variants_pick",
    description:
      "Apply the variant the user chose to the original comp, as ONE undo step, then remove ALL the copies, the chosen one included, since its change now lives on the original (cleanup 'delete', default), or leave them all in the 'chroma variants' folder ('park'). " +
      "It replays the chosen variant's ops on the original; keys are never copied back from the copy. Before it changes anything it checks the original is exactly as it was when the variants were made and refuses if the user edited it in the meantime (make new variants of the current comp). A set made without a digest of the original (its first read failed) is refused as no_digest and can only be discarded. " +
      "The pick is appended to variant-picks.jsonl in the server's data folder (apart from ae_taste). The read-back (a separate evalScript) checks every property holds what the op set and that the copies are gone or parked. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeVariantsPickSchema,
    handler: async (args: z.infer<typeof AeVariantsPickSchema>, ctx: ToolContext) => {
      const rec = loadSet(ctx, args.set_id);
      if (!rec) {
        return { ok: false, error: "unknown_set", message: `No saved variant set ${args.set_id} (it is removed once a variant is picked or discarded). Make new variants with ae_variants.` };
      }
      if (rec.original.comp_id !== args.comp_id) {
        return { ok: false, error: "bad_args", message: `Set ${args.set_id} was made from comp ${rec.original.comp_id} ("${rec.original.name}"), not ${args.comp_id}.` };
      }
      if (normProjectPath(rec.project_path) !== normProjectPath(args.expect.project_path)) {
        return { ok: false, error: "bad_args", message: `Set ${args.set_id} was made in project "${rec.project_path}", not "${args.expect.project_path}". Comp ids only mean something inside one project.` };
      }
      const chosen = rec.variants.find((v) => v.id === args.variant_id);
      if (!chosen) {
        return { ok: false, error: "unknown_variant", message: `No variant "${args.variant_id}" in set ${args.set_id}.`, available: rec.variants.map((v) => ({ id: v.id, label: v.label })) };
      }
      if (typeof rec.original.digest !== "string" || rec.original.digest.length === 0) {
        return {
          ok: false,
          error: "no_digest",
          message: `Set ${args.set_id} has no digest of the original, so there is no way to tell whether the comp was edited while choosing, and offset and shift_time are not safe to replay on an edited comp. Make new variants with ae_variants, or discard this set with ae_variants_discard.`,
        };
      }
      const cleanup = args.cleanup ?? "delete";
      const copyIds = rec.variants.map((v) => v.copy_comp_id).filter((id) => id >= 0);
      let unverified = 0;
      const result = await runGuardedWrite<PromoteWritten>(ctx, {
        toolName: "ae_variants_pick",
        label: `ae_variants_pick(${chosen.id} on comp ${args.comp_id})`,
        expect: args.expect,
        compId: args.comp_id,
        read: (phase, w) => ({
          host: "variantsRead",
          args: { comp_id: args.comp_id, folder_name: rec.folder_name, copy_ids: copyIds, ...(phase === "after" ? { probes: w?.probes ?? [] } : {}) },
        }),
        write: {
          host: "variantsPromote",
          args: { comp_id: args.comp_id, ops: toHostOps(chosen.ops), digest: rec.original.digest, copy_ids: copyIds, cleanup, folder_name: rec.folder_name, label: `Chroma AE MCP: apply variant ${chosen.id}` },
        },
        check: (before, after, w) => {
          unverified = unverifiedProbes(after, (w.probes ?? []).length);
          return promoteMismatches(before, after, w);
        },
        present: (_before, after, w) => {
          // Duration and work area come from the separate read-back: the host's were read in the script that wrote.
          const read = asRead(after);
          const original = read?.original ? { ...w.original, ...read.original } : w.original;
          return { set_id: rec.set_id, applied_variant: { id: chosen.id, label: chosen.label }, changes: w.changes, cleanup: w.cleanup, original };
        },
      });
      // Applied: the bookkeeping below can't fail the call.
      const log = logPick(ctx, rec, chosen.id, cleanup);
      dropSet(ctx, rec.set_id);
      return {
        ...(result as object),
        pick_log: log,
        drift_checked: true,
        ...(unverified > 0 ? { unverified_probes: unverified, receipt_note: `${unverified} written properties were not read back (the read-back covers 500 probes); the receipt does not vouch for them.` } : {}),
      };
    },
  },
  {
    name: "ae_variants_discard",
    description:
      "Throw away a set of variants without applying any: removes the copies (cleanup 'delete', default) or leaves them in the 'chroma variants' folder ('park'), in one undo group. The original comp is not touched. " +
      "Only comps inside that folder which no other comp uses are removed. Use it when the user liked none of them. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeVariantsDiscardSchema,
    handler: async (args: z.infer<typeof AeVariantsDiscardSchema>, ctx: ToolContext) => {
      const rec = loadSet(ctx, args.set_id);
      if (!rec) {
        return { ok: false, error: "unknown_set", message: `No saved variant set ${args.set_id} (it is removed once a variant is picked or discarded).` };
      }
      if (rec.original.comp_id !== args.comp_id) {
        return { ok: false, error: "bad_args", message: `Set ${args.set_id} was made from comp ${rec.original.comp_id} ("${rec.original.name}"), not ${args.comp_id}.` };
      }
      if (normProjectPath(rec.project_path) !== normProjectPath(args.expect.project_path)) {
        return { ok: false, error: "bad_args", message: `Set ${args.set_id} was made in project "${rec.project_path}", not "${args.expect.project_path}".` };
      }
      const cleanup = args.cleanup ?? "delete";
      const copyIds = rec.variants.map((v) => v.copy_comp_id).filter((id) => id >= 0);
      const result = await runGuardedWrite<PromoteWritten>(ctx, {
        toolName: "ae_variants_discard",
        label: `ae_variants_discard(${rec.set_id})`,
        // Guarded on the project only: the copies can be discarded after the original comp is gone.
        expect: { project_path: args.expect.project_path },
        read: () => ({ host: "variantsRead", args: { folder_name: rec.folder_name, copy_ids: copyIds } }),
        write: { host: "variantsDiscard", args: { copy_ids: copyIds, cleanup, folder_name: rec.folder_name, label: "Chroma AE MCP: discard variants" } },
        check: (before, after, w) => cleanupMismatches(before, after, w),
        present: (_before, _after, w) => ({ set_id: rec.set_id, cleanup: w.cleanup }),
      });
      dropSet(ctx, rec.set_id);
      return result;
    },
  },
];
