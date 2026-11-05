/**
 * server/src/tools/ext/stagger.ts
 *
 * Stagger tools, each a guarded write with a read-back in a separate evalScript:
 * - ae_stagger: offsets layers in time (a fixed step, an ease curve, centre-out,
 *   ends-in or a seeded random order), or shifts / copies one property's keys
 *   across layers with the same pattern. AE has no call that moves a key, so
 *   the host rebuilds each key (value, interpolation, ease, tangents,
 *   continuity, roving, label) and the read-back compares every field.
 *   dry_run returns the planned times without touching AE.
 * - ae_stagger_layout: lays layers out on a grid or a circle in the same orders.
 *
 * The plan is worked out here (pure functions below) from a read, then handed
 * to the host as explicit times. The host refuses when the layers or keys
 * moved since the read.
 */

import { z } from "zod";
import type { ReceiptMismatch } from "../../receipts.js";
import { AGENT_SAFETY_GUIDANCE, ExpectSchema, LayerSelectorSchema, type LayerSelector, type ToolContext, type ToolDefinition } from "../common.js";
import { verifyTargetGuard } from "../mutate.js";
import { expectThat, runGuardedWrite } from "./write-runner.js";

// ---------- pure logic ----------

export const ORDERS = ["stack", "reverse", "center_out", "ends_in", "random"] as const;
export const EASES = ["linear", "ease_in", "ease_out", "ease_in_out"] as const;
export type StaggerOrder = (typeof ORDERS)[number];
export type StaggerEase = (typeof EASES)[number];

/** A small seeded generator (mulberry32): the same seed gives the same sequence. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The rank of each of n items, in the order the items were given: 0 goes first.
 * stack: 0..n-1; reverse: n-1..0; center_out: the middle item(s) first, equal
 * distance from the middle ties; ends_in: the ends first; random: a seeded
 * permutation (Fisher-Yates over mulberry32).
 */
export function orderRanks(n: number, order: StaggerOrder, seed = 1): number[] {
  const pos = Array.from({ length: n }, (_, i) => i);
  if (order === "stack") return pos;
  if (order === "reverse") return pos.map((i) => n - 1 - i);
  if (order === "center_out" || order === "ends_in") {
    // An even count has two middle items, both at rank 0.
    const centre = (n - 1) / 2;
    const out = pos.map((i) => Math.round(Math.abs(i - centre) - (n % 2 === 0 ? 0.5 : 0)));
    if (order === "center_out") return out;
    const max = Math.max(...out);
    return out.map((r) => max - r);
  }
  const rand = mulberry32(seed);
  const perm = pos.slice();
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  return perm;
}

/** An ease curve on 0..1. */
export function easeCurve(ease: StaggerEase, t: number): number {
  if (ease === "ease_in") return t * t;
  if (ease === "ease_out") return 1 - (1 - t) * (1 - t);
  if (ease === "ease_in_out") return t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
  return t;
}

/** Rounds a time to a whole number of frames (cleaned of float noise). */
export function snapToFrame(t: number, frameDuration: number): number {
  if (!(frameDuration > 0)) return t;
  return Number((Math.round(t / frameDuration) * frameDuration).toFixed(9));
}

export interface OffsetOptions {
  order: StaggerOrder;
  seed?: number;
  /** Seconds between neighbouring ranks (the whole spread is step * highest rank). */
  step?: number;
  /** The whole spread in seconds, from the first to the last rank. */
  total?: number;
  ease?: StaggerEase;
  /** Seconds added to every offset. */
  delay?: number;
  /** Snaps offsets to whole frames when given. */
  frameDuration?: number;
}

/** Each item's time offset in seconds, in the order the items were given. */
export function computeOffsets(n: number, o: OffsetOptions): number[] {
  const ranks = orderRanks(n, o.order, o.seed ?? 1);
  const maxRank = Math.max(0, ...ranks);
  const spread = o.total !== undefined ? o.total : (o.step ?? 0) * maxRank;
  const ease = o.ease ?? "linear";
  return ranks.map((r) => {
    const t = maxRank === 0 ? 0 : r / maxRank;
    const raw = (o.delay ?? 0) + spread * easeCurve(ease, t);
    return o.frameDuration ? snapToFrame(raw, o.frameDuration) : raw;
  });
}

/** Cell centres of a grid, `columns` wide, centred on `origin`, in row-major order (cell 0 first). */
export function gridPositions(n: number, columns: number, spacing: [number, number], origin: [number, number]): Array<[number, number]> {
  const cols = Math.min(columns, n);
  const rows = Math.ceil(n / cols);
  return Array.from({ length: n }, (_, i) => [
    origin[0] + ((i % cols) - (cols - 1) / 2) * spacing[0],
    origin[1] + (Math.floor(i / cols) - (rows - 1) / 2) * spacing[1],
  ]);
}

/**
 * Points on a circle. Angles run clockwise from 12 o'clock (screen y points
 * down). A full circle spreads the points evenly round it; a partial sweep
 * puts the first point at the start and the last at start + sweep.
 */
export function radialPositions(n: number, centre: [number, number], radius: number, startAngle: number, sweep: number): Array<[number, number]> {
  return Array.from({ length: n }, (_, i) => {
    const frac = Math.abs(sweep) >= 360 || n === 1 ? i / n : i / (n - 1);
    const a = ((startAngle + sweep * frac) * Math.PI) / 180;
    return [centre[0] + radius * Math.sin(a), centre[1] - radius * Math.cos(a)];
  });
}

// ---------- host read shapes ----------

export interface KeyState {
  time: number;
  value: unknown;
  inInterp?: string;
  outInterp?: string;
  easeIn?: Array<{ speed: number; influence: number }>;
  easeOut?: Array<{ speed: number; influence: number }>;
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

export interface PropInfo {
  found: boolean;
  reason?: string;
  matchName?: string;
  valueType?: number;
  numKeys?: number;
  isSpatial?: boolean;
  expression?: boolean;
  separationLeader?: boolean;
  truncated?: boolean;
  times?: number[];
  keys?: KeyState[];
}

export interface StaggerLayer {
  index: number;
  id: number;
  name: string;
  startTime: number;
  inPoint: number;
  outPoint: number;
  stretch?: number;
  locked?: boolean;
  property?: PropInfo;
}

export interface StaggerRead {
  comp_id: number;
  name: string;
  frameDuration: number;
  duration: number;
  numLayers: number;
  truncated?: boolean;
  layers: StaggerLayer[];
  source?: StaggerLayer;
}

export interface LayoutLayer {
  index: number;
  id: number;
  name: string;
  parent: number | null;
  locked?: boolean;
  threeD?: boolean;
  state: "static" | "keyed" | "expression" | "missing";
  separated?: boolean;
  position?: number[];
}

export interface LayoutRead {
  comp_id: number;
  name: string;
  width: number;
  height: number;
  truncated?: boolean;
  layers: LayoutLayer[];
}

const readOf = <T>(v: unknown): T | null => (v && typeof v === "object" ? (v as T) : null);

// ---------- schemas ----------

const PropertyPath = z
  .array(z.string().min(1))
  .min(1)
  .max(12)
  .describe("Property path from the layer: names or match names, e.g. ['ADBE Transform Group', 'ADBE Position'] or ['Transform', 'Opacity'].");

const LayersField = z
  .array(LayerSelectorSchema)
  .min(1)
  .max(500)
  .optional()
  .describe("The layers in sequence order (the first goes first). Omit to use the layers selected in the comp, top to bottom. Each layer counts once.");

export const AeStaggerSchema = z
  .object({
    comp_id: z.number().int(),
    mode: z
      .enum(["layers", "keys", "copy_keys"])
      .default("layers")
      .describe(
        "layers: move each layer in time (its keys, markers and in/out go with it). " +
          "keys: shift the keys of one property on each layer, leaving the layer where it is. " +
          "copy_keys: copy a property's keys from `source` onto the layers, each with its own time offset."
      ),
    layers: LayersField,
    property_path: PropertyPath.optional().describe("keys and copy_keys: the property whose keys move or are copied."),
    source: LayerSelectorSchema.optional().describe("copy_keys: the layer to copy the keys from. It is not changed and can't be one of the targets."),
    replace_existing: z.boolean().optional().describe("copy_keys: overwrite keys a target already has on that property. Default false: a target with keys is refused."),
    skip_missing: z.boolean().optional().describe("keys: skip layers that have no keys on the property, instead of refusing. Skipped layers are listed and don't take a slot in the sequence."),
    order: z
      .enum(ORDERS)
      .default("stack")
      .describe("Who goes first: stack (the given order), reverse, center_out (the middle first), ends_in (the ends first) or random (seeded, see `seed`)."),
    step: z.number().min(0).max(3600).optional().describe("Seconds between neighbouring places in the sequence. Give `step` or `total`."),
    total: z.number().min(0).max(3600).optional().describe("Seconds from the first to the last place. Give `step` or `total`."),
    ease: z.enum(EASES).default("linear").describe("Shapes the spread: linear is an even step; ease_in starts slow and speeds up, ease_out the reverse."),
    seed: z.number().int().min(0).max(4294967295).default(1).describe("Seed for order 'random'. The same seed gives the same order."),
    delay: z.number().min(-3600).max(3600).optional().describe("Seconds added to every layer, so the sequence starts later (or earlier). Default 0."),
    snap_to_frames: z.boolean().default(true).describe("Round each offset to a whole number of frames (default true)."),
    trim: z
      .enum(["keep_duration", "keep_out", "to_comp_end"])
      .optional()
      .describe(
        "layers mode, what happens to the out point: keep_duration (default; each layer keeps its length, so its out point follows), " +
          "keep_out (the out point stays where it was, so a later layer gets shorter; a video layer can't be made longer than its source), " +
          "to_comp_end (every out point goes to the comp's end)."
      ),
    dry_run: z.boolean().optional().describe("Return the planned times without touching AE."),
    expect: ExpectSchema,
  })
  .refine((v) => (v.step === undefined) !== (v.total === undefined), { message: "Give exactly one of step and total." })
  .refine((v) => v.mode === "layers" || v.property_path !== undefined, { message: "keys and copy_keys need property_path." })
  .refine((v) => v.mode === "layers" || v.trim === undefined, { message: "trim applies to layers mode only." })
  .refine((v) => (v.mode === "copy_keys") === (v.source !== undefined), { message: "source is for copy_keys, and copy_keys needs it." })
  .refine((v) => v.mode === "copy_keys" || v.replace_existing === undefined, { message: "replace_existing applies to copy_keys only." })
  .refine((v) => v.mode === "keys" || v.skip_missing === undefined, { message: "skip_missing applies to keys mode only." });

export const AeStaggerLayoutSchema = z
  .object({
    comp_id: z.number().int(),
    pattern: z.enum(["grid", "radial"]).describe("grid: rows and columns centred on `origin`; radial: points on a circle."),
    layers: LayersField,
    order: z.enum(["stack", "reverse", "random"]).default("stack").describe("Which layer takes which place (grid cells fill left to right, top to bottom; radial places run clockwise)."),
    seed: z.number().int().min(0).max(4294967295).default(1).describe("Seed for order 'random'."),
    columns: z.number().int().min(1).max(500).optional().describe("grid: cells per row."),
    spacing: z.tuple([z.number(), z.number()]).optional().describe("grid: [x, y] distance between cell centres in pixels."),
    origin: z.tuple([z.number(), z.number()]).optional().describe("The centre of the grid or circle in the layers' own coordinates (the comp's, for an unparented layer). Default the comp's centre."),
    radius: z.number().positive().max(100000).optional().describe("radial: circle radius in pixels."),
    start_angle: z.number().min(-360).max(360).default(0).describe("radial: angle of the first place in degrees, 0 at 12 o'clock, clockwise."),
    sweep: z.number().min(-360).max(360).default(360).describe("radial: degrees to spread the places over. 360 is the full circle."),
    dry_run: z.boolean().optional().describe("Return the planned positions without touching AE."),
    expect: ExpectSchema,
  })
  .refine((v) => v.pattern !== "grid" || (v.columns !== undefined && v.spacing !== undefined), { message: "grid needs columns and spacing." })
  .refine((v) => v.pattern !== "radial" || v.radius !== undefined, { message: "radial needs radius." })
  .refine((v) => v.pattern === "grid" || (v.columns === undefined && v.spacing === undefined), { message: "columns and spacing apply to grid only." })
  .refine((v) => v.pattern === "radial" || v.radius === undefined, { message: "radius applies to radial only." });

type StaggerArgs = z.infer<typeof AeStaggerSchema>;
type LayoutArgs = z.infer<typeof AeStaggerLayoutSchema>;

// ---------- planning ----------

export interface PlanEntry {
  id: number;
  index: number;
  name: string;
  /** Seconds added (to the layer's start, or to each key). */
  offset: number;
  /** layers: the start time now and after. */
  from?: number;
  to?: number;
  /** keys: the property's key count and first key time now. */
  num_keys?: number;
  first_time?: number;
}

export interface Plan {
  entries: PlanEntry[];
  skipped: Array<{ id: number; name: string; reason: string }>;
  frameDuration: number;
}

type PlanResult = { ok: true; plan: Plan } | { ok: false; error: string; message: string };

const MAX_KEYS_TOTAL = 1000;

/** Works out the planned times from the host's read; refuses what the host would refuse. */
export function planStagger(args: StaggerArgs, read: StaggerRead): PlanResult {
  const bad = (message: string): PlanResult => ({ ok: false, error: "bad_args", message });
  if (read.truncated) return bad("More than 500 layers were given or selected; split them into batches.");
  const skipped: Plan["skipped"] = [];
  let layers = read.layers;
  const lockedOnes = layers.filter((l) => l.locked === true);
  if (lockedOnes.length) return bad(`"${lockedOnes[0].name}" is locked${lockedOnes.length > 1 ? ` (and ${lockedOnes.length - 1} more)` : ""}; unlock it first.`);
  if (args.mode !== "layers") {
    const prop = (l: StaggerLayer) => l.property;
    const missing = layers.filter((l) => !prop(l)?.found);
    if (missing.length) {
      return bad(`${missing.length} layer(s) have no property ${args.property_path?.join(" > ")}: ${missing.slice(0, 5).map((l) => `"${l.name}"`).join(", ")}${missing.length > 5 ? ", ..." : ""}.`);
    }
    const sepLeaders = layers.filter((l) => prop(l)?.separationLeader);
    if (sepLeaders.length) return bad(`"${sepLeaders[0].name}": that Position has separated dimensions; its keys are on X Position / Y Position (ADBE Position_0, ADBE Position_1).`);
    if (args.mode === "keys") {
      const keyless = layers.filter((l) => !(prop(l)?.numKeys && prop(l)!.numKeys! > 0));
      if (keyless.length && !args.skip_missing) {
        return bad(
          `${keyless.length} layer(s) have no keys on that property: ${keyless.slice(0, 5).map((l) => `"${l.name}"`).join(", ")}${keyless.length > 5 ? ", ..." : ""}. ` +
            "Pass skip_missing to leave them out, or use mode copy_keys."
        );
      }
      for (const l of keyless) skipped.push({ id: l.id, name: l.name, reason: "no keys on the property" });
      layers = layers.filter((l) => (prop(l)?.numKeys ?? 0) > 0);
      const total = layers.reduce((s, l) => s + (prop(l)?.numKeys ?? 0), 0);
      if (total > MAX_KEYS_TOTAL) return bad(`${total} keys would be rebuilt; at most ${MAX_KEYS_TOTAL} per call. Split the layers into batches.`);
    }
    if (args.mode === "copy_keys") {
      const src = read.source;
      if (!src?.property?.found || !(src.property.numKeys && src.property.numKeys > 0)) return bad("The source layer has no keys on that property.");
      if (layers.some((l) => l.id === src.id)) return bad("The source layer can't also be a target.");
      if (src.property.separationLeader) return bad("That Position has separated dimensions; copy X Position / Y Position instead.");
      if (!args.replace_existing) {
        const has = layers.filter((l) => (prop(l)?.numKeys ?? 0) > 0);
        if (has.length) return bad(`${has.length} target layer(s) already have keys on that property (${has.slice(0, 5).map((l) => `"${l.name}"`).join(", ")}); pass replace_existing to overwrite them.`);
      }
      // The before and after reads also cover every existing key a target loses to replace_existing.
      const existing = layers.reduce((s, l) => s + (prop(l)?.numKeys ?? 0), 0);
      const total = (src.property.numKeys ?? 0) * layers.length + existing;
      if (total > MAX_KEYS_TOTAL) return bad(`${total} keys would be written; at most ${MAX_KEYS_TOTAL} per call. Split the layers into batches.`);
    }
  }
  if (layers.length === 0) return bad("No layers left to stagger.");
  const frameDuration = read.frameDuration;
  const offsets = computeOffsets(layers.length, {
    order: args.order,
    seed: args.seed,
    step: args.step,
    total: args.total,
    ease: args.ease,
    delay: args.delay,
    frameDuration: args.snap_to_frames ? frameDuration : undefined,
  });
  const entries: PlanEntry[] = layers.map((l, i) => {
    const e: PlanEntry = { id: l.id, index: l.index, name: l.name, offset: offsets[i] };
    if (args.mode === "layers") {
      e.from = l.startTime;
      e.to = Number((l.startTime + offsets[i]).toFixed(9));
    } else {
      // In copy_keys the keys that land are the source's; the target's own keys are only replaced.
      const p = args.mode === "copy_keys" ? read.source?.property : l.property;
      e.num_keys = p?.numKeys;
      e.first_time = p?.times?.[0];
    }
    return e;
  });
  return { ok: true, plan: { entries, skipped, frameDuration } };
}

export interface LayoutEntry {
  id: number;
  index: number;
  name: string;
  position: [number, number];
  from: number[] | undefined;
}

type LayoutPlanResult = { ok: true; entries: LayoutEntry[]; warnings: string[] } | { ok: false; error: string; message: string };

export function planLayout(args: LayoutArgs, read: LayoutRead): LayoutPlanResult {
  const bad = (message: string): LayoutPlanResult => ({ ok: false, error: "bad_args", message });
  if (read.truncated) return bad("More than 500 layers were given or selected; split them into batches.");
  const layers = read.layers;
  const lockedOnes = layers.filter((l) => l.locked === true);
  if (lockedOnes.length) return bad(`"${lockedOnes[0].name}" is locked${lockedOnes.length > 1 ? ` (and ${lockedOnes.length - 1} more)` : ""}; unlock it first.`);
  const stuck = layers.filter((l) => l.state !== "static");
  if (stuck.length) {
    const why = (l: LayoutLayer) => (l.state === "keyed" ? "has Position keyframes" : l.state === "expression" ? "has a Position expression" : "has no Position");
    return bad(`${stuck.length} layer(s) can't be placed: ${stuck.slice(0, 5).map((l) => `"${l.name}" ${why(l)}`).join("; ")}.`);
  }
  const origin: [number, number] = args.origin ?? [read.width / 2, read.height / 2];
  const cells =
    args.pattern === "grid"
      ? gridPositions(layers.length, args.columns ?? 1, args.spacing ?? [0, 0], origin)
      : radialPositions(layers.length, origin, args.radius ?? 0, args.start_angle, args.sweep);
  // Order picks which layer takes which cell: layer i takes cell rank[i].
  const ranks = orderRanks(layers.length, args.order, args.seed);
  const entries: LayoutEntry[] = layers.map((l, i) => {
    const cell = cells[ranks[i]];
    return { id: l.id, index: l.index, name: l.name, position: [Number(cell[0].toFixed(4)), Number(cell[1].toFixed(4))], from: l.position };
  });
  const warnings: string[] = [];
  const parented = layers.filter((l) => l.parent !== null);
  if (parented.length) warnings.push(`${parented.length} layer(s) have a parent; Position is in the parent's space, so they land relative to it.`);
  return { ok: true, entries, warnings };
}

// ---------- read-back checks ----------

const TIME_TOL = 1e-6;
const MAX_MISMATCHES = 40;

const numClose = (a: number, b: number, abs: number, rel = 1e-5) => Math.abs(a - b) <= abs + rel * Math.max(Math.abs(a), Math.abs(b));

/** Deep comparison with a tolerance on numbers (AE stores floats). */
export function closeEnough(a: unknown, b: unknown, abs = 1e-4): boolean {
  if (typeof a === "number" && typeof b === "number") return numClose(a, b, abs);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => closeEnough(x, b[i], abs));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    return ka.length === kb.length && ka.every((k) => closeEnough((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], abs));
  }
  return a === b;
}

const easeClose = (a: KeyState["easeIn"], b: KeyState["easeIn"]) =>
  !!a && !!b && a.length === b.length && a.every((e, i) => numClose(e.speed, b[i].speed, 1e-3, 1e-3) && numClose(e.influence, b[i].influence, 0.01, 1e-3));

/**
 * Compares a property's keys after a rebuild with the keys before, shifted by
 * dt. A roving key's time and tangents belong to AE, so they are not asserted.
 * Ease is compared on a side only when that side's interpolation is bezier.
 */
export function compareKeys(before: KeyState[], after: KeyState[], dt: number, timeTol: number, where: string): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  if (before.length !== after.length) {
    m.push({ path: `${where}.numKeys`, expected: before.length, actual: after.length, message: "The key count differs" });
    return m;
  }
  for (let i = 0; i < before.length; i++) {
    const b = before[i];
    const a = after[i];
    const at = `${where}.keys[${i + 1}]`;
    const roving = b.roving === true || a.roving === true;
    if (!roving) expectThat(m, Math.abs(a.time - (b.time + dt)) <= timeTol + TIME_TOL, `${at}.time`, b.time + dt, a.time, "Key time differs");
    expectThat(m, closeEnough(b.value, a.value), `${at}.value`, b.value, a.value, "Key value differs");
    const same = (field: keyof KeyState, msg: string) => {
      if (b[field] === undefined) return;
      expectThat(m, closeEnough(b[field], a[field]), `${at}.${field}`, b[field], a[field], msg);
    };
    same("inInterp", "In interpolation differs");
    same("outInterp", "Out interpolation differs");
    if (b.easeIn && b.inInterp === "bezier") expectThat(m, easeClose(b.easeIn, a.easeIn), `${at}.easeIn`, b.easeIn, a.easeIn, "In ease differs");
    if (b.easeOut && b.outInterp === "bezier") expectThat(m, easeClose(b.easeOut, a.easeOut), `${at}.easeOut`, b.easeOut, a.easeOut, "Out ease differs");
    same("temporalContinuous", "Temporal continuity differs");
    same("temporalAutoBezier", "Temporal auto-bezier differs");
    same("spatialContinuous", "Spatial continuity differs");
    same("spatialAutoBezier", "Spatial auto-bezier differs");
    same("roving", "Roving differs");
    same("label", "Key label differs");
    if (!roving) {
      same("tangentIn", "In spatial tangent differs");
      same("tangentOut", "Out spatial tangent differs");
    }
    if (m.length >= MAX_MISMATCHES) {
      m.push({ path: where, expected: undefined, actual: undefined, message: `More than ${MAX_MISMATCHES} differences; the rest are not listed` });
      return m;
    }
  }
  return m;
}

const layerOf = (read: StaggerRead | null, id: number) => read?.layers.find((l) => l.id === id);

export function layersMismatches(args: StaggerArgs, plan: Plan, beforeRaw: unknown, afterRaw: unknown): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const before = readOf<StaggerRead>(beforeRaw);
  const after = readOf<StaggerRead>(afterRaw);
  if (!before || !after) return m;
  const tol = after.frameDuration * 0.5 + TIME_TOL;
  const trim = args.trim ?? "keep_duration";
  for (const e of plan.entries) {
    const b = layerOf(before, e.id);
    const a = layerOf(after, e.id);
    if (!a) {
      m.push({ path: `layers[${e.id}]`, expected: e.name, actual: undefined, message: "The layer is not in the read-back" });
      continue;
    }
    expectThat(m, Math.abs(a.startTime - (e.to as number)) <= tol, `layers[${e.index}].startTime`, e.to, a.startTime, `"${e.name}" start time differs`);
    if (!b) continue;
    if (trim === "keep_duration") {
      const want = b.outPoint + ((e.to as number) - b.startTime);
      expectThat(m, Math.abs(a.outPoint - want) <= tol, `layers[${e.index}].outPoint`, want, a.outPoint, `"${e.name}" out point did not follow its start`);
    } else if (trim === "keep_out") {
      expectThat(m, Math.abs(a.outPoint - b.outPoint) <= tol, `layers[${e.index}].outPoint`, b.outPoint, a.outPoint, `"${e.name}" out point moved (a layer can't run past its source)`);
    } else {
      expectThat(m, Math.abs(a.outPoint - after.duration) <= tol, `layers[${e.index}].outPoint`, after.duration, a.outPoint, `"${e.name}" out point is not at the comp's end (a layer can't run past its source)`);
    }
  }
  return m;
}

export function keysMismatches(args: StaggerArgs, plan: Plan, beforeRaw: unknown, afterRaw: unknown): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const before = readOf<StaggerRead>(beforeRaw);
  const after = readOf<StaggerRead>(afterRaw);
  if (!before || !after) return m;
  // Half a frame: the shift is a whole number of frames when snapped, and AE may round key times.
  const tol = after.frameDuration * 0.5;
  const copy = args.mode === "copy_keys";
  const srcBefore = before.source?.property?.keys;
  if (copy) {
    const srcAfter = after.source?.property?.keys;
    if (!srcBefore || !srcAfter) m.push({ path: "source", expected: "keys", actual: undefined, message: "The source's keys could not be read back" });
    else m.push(...compareKeys(srcBefore, srcAfter, 0, tol, "source"));
  }
  for (const e of plan.entries) {
    const a = layerOf(after, e.id);
    const b = layerOf(before, e.id);
    const where = `layers[${e.index}]`;
    const afterKeys = a?.property?.keys;
    const beforeKeys = copy ? srcBefore : b?.property?.keys;
    if (!afterKeys || !beforeKeys) {
      if (a?.property?.truncated || b?.property?.truncated) continue;
      m.push({ path: where, expected: "keys", actual: afterKeys ? undefined : "no keys", message: `"${e.name}": the keys could not be read back` });
      continue;
    }
    for (const x of compareKeys(beforeKeys, afterKeys, e.offset, tol, where)) m.push({ ...x, message: `"${e.name}": ${x.message}` });
    if (m.length >= MAX_MISMATCHES) break;
  }
  return m;
}

export function layoutMismatches(entries: LayoutEntry[], afterRaw: unknown): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const after = readOf<LayoutRead>(afterRaw);
  if (!after) return m;
  for (const e of entries) {
    const a = after.layers.find((l) => l.id === e.id);
    if (!a?.position) {
      m.push({ path: `layers[${e.index}].position`, expected: e.position, actual: undefined, message: `"${e.name}": Position could not be read back` });
      continue;
    }
    expectThat(m, Math.abs(a.position[0] - e.position[0]) <= 0.05 && Math.abs(a.position[1] - e.position[1]) <= 0.05, `layers[${e.index}].position`, e.position, a.position.slice(0, 2), `"${e.name}" is not at the planned position`);
    // Z (and everything else on the layer) stays.
    if (e.from && e.from.length > 2 && a.position.length > 2) expectThat(m, numClose(a.position[2], e.from[2], 0.01), `layers[${e.index}].position[2]`, e.from[2], a.position[2], `"${e.name}": Z changed`);
  }
  return m;
}

// ---------- tools ----------

const selection = (layers: LayerSelector[] | undefined) => (layers ? { layers } : {});

/** The ids of the planned layers, so the reads after a write find the same layers even if their indexes shift. */
const idSelectors = (entries: Array<{ id: number }>): LayerSelector[] => entries.map((e) => ({ id: e.id }));

/** Reads the layers once, outside the write's lease, to plan from; the host checks nothing moved before it writes. */
async function planRead<T>(ctx: ToolContext, host: string, args: Record<string, unknown>, toolName: string, label: string): Promise<T> {
  const res = await ctx.bridge.callHost<T>(host, args, { label, mutates: false, toolName });
  return res.result;
}

function summarise(plan: Plan, mode: StaggerArgs["mode"]) {
  return plan.entries.map((e) =>
    mode === "layers"
      ? { id: e.id, index: e.index, name: e.name, offset: e.offset, from: e.from, to: e.to }
      : { id: e.id, index: e.index, name: e.name, offset: e.offset, num_keys: e.num_keys, first_key_from: e.first_time, first_key_to: e.first_time === undefined ? undefined : Number((e.first_time + e.offset).toFixed(9)) }
  );
}

export const staggerTools: ToolDefinition<any>[] = [
  {
    name: "ae_stagger",
    description:
      "Stagger layers or keys in time, in one undo group guarded by `expect`. mode 'layers' moves each layer (its keys and markers go along) by an offset; " +
      "'keys' shifts one property's keys on each layer, leaving the layer put; 'copy_keys' copies a property's keys from a source layer onto the layers, each shifted. " +
      "Offsets follow a pattern: `step` (seconds between neighbours) or `total` (first to last), an `ease` curve, and an `order` (stack, reverse, center_out, ends_in, or random with a `seed` so the result repeats). " +
      "Offsets are rounded to whole frames. `dry_run` returns the planned times without touching AE. `trim` (layers mode) says what the out point does. " +
      "AE has no call that moves a key, so keys mode removes and re-adds every key of the property; the host restores the original keys if anything fails, and the read-back (a separate evalScript) compares each key's time, value, interpolation, ease, tangents, continuity, auto-bezier, roving and label. " +
      "Roving keys' times belong to AE and are not asserted. Key times are comp time. At most 1000 keys per call; the layers must not have moved since the plan. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeStaggerSchema,
    handler: async (args: StaggerArgs, ctx) => {
      const keyMode = args.mode !== "layers";
      const selectionArgs = {
        comp_id: args.comp_id,
        ...selection(args.layers),
        ...(keyMode ? { property_path: args.property_path, detail: "times", source: args.source } : {}),
      };
      if (!args.dry_run) {
        ctx.quarantine.assertClear();
        // Guard first, so a wrong project fails with the guard error and not a not_found from another project's ids.
        await verifyTargetGuard(ctx, { project_path: args.expect.project_path, comp_id: args.expect.comp_id ?? args.comp_id }, ctx.bridge.newOpId());
      }
      const read = await planRead<StaggerRead>(ctx, "staggerRead", selectionArgs, "ae_stagger", `ae_stagger (${args.dry_run ? "dry run" : "plan"})`);
      const planned = planStagger(args, read);
      if (!planned.ok) return { ok: false, error: planned.error, message: planned.message };
      const plan = planned.plan;
      if (args.dry_run) {
        return { ok: true, dry_run: true, mode: args.mode, order: args.order, frame_duration: plan.frameDuration, layers: summarise(plan, args.mode), skipped: plan.skipped };
      }
      const ids = idSelectors(plan.entries);
      return runGuardedWrite(ctx, {
        toolName: "ae_stagger",
        label: `ae_stagger(${args.mode}, ${plan.entries.length} layer${plan.entries.length === 1 ? "" : "s"})`,
        expect: args.expect,
        compId: args.comp_id,
        read: () => ({
          host: "staggerRead",
          args: { comp_id: args.comp_id, layers: ids, ...(keyMode ? { property_path: args.property_path, detail: "full", source: args.source } : {}) },
        }),
        write: {
          host: "staggerApply",
          args: {
            comp_id: args.comp_id,
            mode: args.mode,
            property_path: args.property_path,
            source: args.source,
            replace_existing: args.replace_existing,
            trim: args.trim,
            targets: plan.entries.map((e) => ({ id: e.id, offset: e.offset, from: e.from, to: e.to, num_keys: e.num_keys, first_time: e.first_time })),
            label: args.mode === "layers" ? "Stagger layers" : args.mode === "keys" ? "Stagger keys" : "Copy keys with offset",
          },
        },
        check: (before, after) => (args.mode === "layers" ? layersMismatches(args, plan, before, after) : keysMismatches(args, plan, before, after)),
        present: (_before, _after, w) => ({
          mode: args.mode,
          order: args.order,
          frame_duration: plan.frameDuration,
          layers: summarise(plan, args.mode),
          skipped: plan.skipped,
          warnings: (w.warnings as string[] | undefined) ?? [],
        }),
      });
    },
  },
  {
    name: "ae_stagger_layout",
    description:
      "Lay layers out on a grid or a circle by setting their Position, in one undo group guarded by `expect`. " +
      "The `order` (stack, reverse or a seeded random) picks which layer takes which place; Z and every other property stay. " +
      "A layer with Position keyframes or an expression is refused, as is a separated Position that has either. Position is in the layer's parent space. " +
      "`dry_run` returns the planned positions without touching AE. The read-back (a separate evalScript) checks each layer's X and Y. " +
      "For an even row or column, use ae_align. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeStaggerLayoutSchema,
    handler: async (args: LayoutArgs, ctx) => {
      if (!args.dry_run) {
        ctx.quarantine.assertClear();
        await verifyTargetGuard(ctx, { project_path: args.expect.project_path, comp_id: args.expect.comp_id ?? args.comp_id }, ctx.bridge.newOpId());
      }
      const read = await planRead<LayoutRead>(ctx, "staggerLayoutRead", { comp_id: args.comp_id, ...selection(args.layers) }, "ae_stagger_layout", `ae_stagger_layout (${args.dry_run ? "dry run" : "plan"})`);
      const planned = planLayout(args, read);
      if (!planned.ok) return { ok: false, error: planned.error, message: planned.message };
      const view = planned.entries.map((e) => ({ id: e.id, index: e.index, name: e.name, from: e.from?.slice(0, 2), to: e.position }));
      if (args.dry_run) return { ok: true, dry_run: true, pattern: args.pattern, layers: view, warnings: planned.warnings };
      const ids = idSelectors(planned.entries);
      return runGuardedWrite(ctx, {
        toolName: "ae_stagger_layout",
        label: `ae_stagger_layout(${args.pattern}, ${planned.entries.length} layer${planned.entries.length === 1 ? "" : "s"})`,
        expect: args.expect,
        compId: args.comp_id,
        read: () => ({ host: "staggerLayoutRead", args: { comp_id: args.comp_id, layers: ids } }),
        write: {
          host: "staggerLayoutApply",
          args: { comp_id: args.comp_id, targets: planned.entries.map((e) => ({ id: e.id, position: e.position })), label: `Stagger layout (${args.pattern})` },
        },
        check: (_before, after) => layoutMismatches(planned.entries, after),
        present: () => ({ pattern: args.pattern, layers: view, warnings: planned.warnings }),
      });
    },
  },
];
