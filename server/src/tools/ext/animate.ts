/**
 * server/src/tools/ext/animate.ts
 *
 * Guarded mutating tools for Task G3 "animate":
 * - ae_set_keyframe_ease
 * - ae_set_text
 * - ae_import_footage
 * - ae_replace_footage
 *
 * Wave 5 adds, without a new tool: typography, paragraph, box and font checks in ae_set_text; import_as, range and
 * placeholders in ae_import_footage; per-key extras in ae_set_keyframe_ease; action 'reload' in ae_replace_footage.
 *
 * Credits:
 * - Adapted from Engine-Room-Games/after-effects-mcp (MIT License):
 *   reference/engine-room keyframes.jsx, text.jsx, footage.jsx, and docs/fragile-areas-ae.md.
 */

import { z } from "zod";
import { BridgeError, SLOW_TIMEOUT_MS } from "../../host.js";
import { buildJsxCall, normalizeGuardPath } from "../../jsx.js";
import { QueueWaitError } from "../../queue.js";
import { buildReceipt, type ReceiptMismatch } from "../../receipts.js";
import {
  AGENT_SAFETY_GUIDANCE,
  ExpectSchema,
  LayerSelectorSchema,
  type ExpectGuard,
  type ToolDefinition,
} from "../common.js";
import { autoCheckpoint, verifyTargetGuard } from "../mutate.js";
import { checkAfterWrite, readAfterWrite } from "../read-back.js";

// ---------- 1. ae_set_keyframe_ease ----------

export const KeyframeEaseEndSchema = z.object({
  speed: z
    .number()
    .describe(
      "Temporal ease speed (units per second; typically 0 for smooth ease)."
    ),
  influence: z
    .number()
    .min(0)
    .max(100)
    .describe(
      "Temporal ease influence percentage (0.1 to 100; values below 0.1 are clamped to 0.1 in After Effects)."
    ),
});

export const KeyframeEasePairSchema = z.object({
  in: KeyframeEaseEndSchema.describe(
    "Incoming temporal ease {speed, influence}."
  ),
  out: KeyframeEaseEndSchema.describe(
    "Outgoing temporal ease {speed, influence}."
  ),
});

export const KeyframeEasePresetSchema = z.enum([
  "easy_ease",
  "linear",
  "hold",
]);

/**
 * curveToSides() below floors x1 and caps x2 to this distance from 0/1 (AE
 * keyframe handles can't sit exactly on the segment's start/end). Validation
 * uses the same bound so a curve with x1 (or 1 - x2) closer to the edge than
 * this is rejected up front, instead of being accepted, stored (e.g. as a
 * taste/preference elsewhere), and then silently clamped to a different
 * value whenever it's actually applied.
 */
export const MIN_HANDLE = 0.001;

export const EASE_CURVE_ARRAY_SCHEMA = z
  .array(z.number())
  .length(4)
  // Matches curveToSides()'s own clamp exactly: x1 (handle influence on the
  // out side) can't be 0, x2 (1 - influence on the in side) can't be 1 --
  // AE's influence floor is 0.1%, so a handle can't sit exactly on its key.
  // x1 = 1 and x2 = 0 are both fine (no clamp applies to those ends).
  .refine((c) => c[0] >= MIN_HANDLE && c[0] <= 1 && c[2] >= 0 && c[2] <= 1 - MIN_HANDLE, {
    message: `curve x1 must be within ${MIN_HANDLE}..1 and x2 within 0..${1 - MIN_HANDLE}`,
  })
  .describe(
    "cubic-bezier [x1, y1, x2, y2] as in CSS: x is time and y is progress across one segment, both 0..1. y may leave 0..1 for anticipation or overshoot (not on spatial properties such as Position, whose speed cannot go negative)."
  );

export const KeyframeEaseCurveSchema = z.object({
  curve: EASE_CURVE_ARRAY_SCHEMA,
});

export const KeyframeEaseInputSchema = z
  .union([KeyframeEasePresetSchema, KeyframeEasePairSchema, KeyframeEaseCurveSchema])
  .describe(
    'A preset ("easy_ease", "linear", or "hold"), an explicit `{ in: { speed, influence }, out: { speed, influence } }` object, or `{ curve: [x1, y1, x2, y2] }`. ' +
      "A curve shapes each segment between neighbouring keys in `keys` (all keys by default): it sets the out ease of the segment's first key and the in ease of its last, from that segment's duration and distance, and leaves every other side alone."
  );

export type KeyframeEaseInput = z.infer<typeof KeyframeEaseInputSchema>;

export const KeyInterpolationSchema = z.enum(["linear", "bezier", "hold"]);

const KeyTangentSchema = z.array(z.number()).min(2).max(3);

/** The per-key settings beyond the ease itself (same names as ae_get_keyframes reads). */
export const KEY_EXTRA_FIELDS = [
  "in_interp",
  "out_interp",
  "in_tangent",
  "out_tangent",
  "spatial_continuous",
  "spatial_auto_bezier",
  "temporal_continuous",
  "temporal_auto_bezier",
  "roving",
  "label",
] as const;

export const KeyExtrasShape = {
  in_interp: KeyInterpolationSchema.optional().describe(
    "Interpolation going INTO each key ('linear', 'bezier' or 'hold'), different from the out side. Without `ease` it is set per side (setInterpolationTypeAtKey); with `ease` it can only repeat the interpolation the ease sets. Refused up front when the property does not accept it (hold-only properties such as Source Text and checkboxes)."
  ),
  out_interp: KeyInterpolationSchema.optional().describe("Interpolation going OUT of each key ('linear', 'bezier' or 'hold'); see in_interp."),
  in_tangent: KeyTangentSchema.optional().describe(
    "Spatial in tangent [x, y] or [x, y, z] (a motion-path handle, relative to the key's value), for Position and other spatial properties only; the array length must match the property (2D or 3D). Auto bezier is switched off first, then the tangent is set."
  ),
  out_tangent: KeyTangentSchema.optional().describe("Spatial out tangent [x, y] or [x, y, z]; see in_tangent."),
  spatial_continuous: z.boolean().optional().describe("Spatial continuous (the motion path stays smooth through the key). Spatial properties only."),
  spatial_auto_bezier: z.boolean().optional().describe("Spatial auto bezier (AE computes the path handles). true implies continuous; can't be combined with tangents. Spatial properties only."),
  temporal_continuous: z.boolean().optional().describe("Temporal continuous (in and out ease stay matched). Any keyframed property."),
  temporal_auto_bezier: z.boolean().optional().describe("Temporal auto bezier (AE computes the ease). true implies continuous. Any keyframed property."),
  roving: z
    .boolean()
    .optional()
    .describe(
      "Make the listed keys roving (true) or fixed in time (false), applied last. Spatial properties only; the first and last keys of the property can't rove. Use rove_between to rove everything between two keys."
    ),
  label: z
    .number()
    .int()
    .min(0)
    .max(16)
    .optional()
    .describe("Key label colour 0 (none) to 16 (After Effects 22.6+; refused before the write on older AE)."),
};

export type KeyExtras = {
  in_interp?: z.infer<typeof KeyInterpolationSchema>;
  out_interp?: z.infer<typeof KeyInterpolationSchema>;
  in_tangent?: number[];
  out_tangent?: number[];
  spatial_continuous?: boolean;
  spatial_auto_bezier?: boolean;
  temporal_continuous?: boolean;
  temporal_auto_bezier?: boolean;
  roving?: boolean;
  label?: number;
};

export function pickKeyExtras(args: Record<string, unknown>): KeyExtras | undefined {
  const out: Record<string, unknown> = {};
  for (const k of KEY_EXTRA_FIELDS) if (args[k] !== undefined) out[k] = args[k];
  return Object.keys(out).length > 0 ? (out as KeyExtras) : undefined;
}

export const AeSetKeyframeEaseSchema = z
  .object({
    comp_id: z.number().int().describe("Target CompItem ID."),
    layer: LayerSelectorSchema,
    path: z
      .array(z.union([z.string().min(1), z.number().int().positive()]))
      .min(1)
      .describe(
        "Property path from the layer root (e.g. ['ADBE Transform Group', 'ADBE Position'] or ['Transform', 'Opacity']). " +
          "A step may be a 1-based positional index instead of a name for a sibling inside an indexed group " +
          "(effects, masks, shape layer contents), where siblings can share a display name."
      ),
    keys: z
      .union([z.array(z.number().int().positive()), z.literal("selected")])
      .optional()
      .describe(
        "Optional 1-based keyframe indices to update, or \"selected\" for the keys currently selected in the timeline (read from Property.selectedKeys; refused when none are). Defaults to all keyframes on the property."
      ),
    ease: KeyframeEaseInputSchema.optional().describe(
      "The ease to set (preset, explicit `{in, out}` or `{curve}`). Optional when per-key settings (in_interp, out_interp, in_tangent, out_tangent, spatial_continuous, spatial_auto_bezier, temporal_continuous, temporal_auto_bezier, roving, label) are given instead; give at least one of the two."
    ),
    rove_between: z
      .boolean()
      .optional()
      .describe(
        "Make the keys strictly between the first and last of `keys` roving (Keyframe > Rove Across Time), so a move eased at its ends keeps one smooth speed through them. " +
          "Spatial properties only (Position, Anchor Point); not with a curve or hold. Roving keys are left out of the ease check, since AE sets their ease."
      ),
    ...KeyExtrasShape,
    expect: ExpectSchema,
  })
  .refine((v) => v.ease !== undefined || pickKeyExtras(v) !== undefined, {
    message: "ae_set_keyframe_ease needs `ease`, or at least one per-key setting (in_interp, out_interp, in_tangent, out_tangent, spatial_continuous, spatial_auto_bezier, temporal_continuous, temporal_auto_bezier, roving, label).",
  });

/** Keys that should have gone roving but read back fixed in time. */
export function rovingMismatches(roving: unknown, afterSnapshot: unknown): ReceiptMismatch[] {
  const want = Array.isArray(roving) ? (roving as number[]) : [];
  const keys = ((afterSnapshot as { keyframes?: Array<{ keyIndex: number; roving?: boolean }> } | null)?.keyframes ?? []);
  return want
    .filter((i) => keys.find((k) => k.keyIndex === i)?.roving !== true)
    .map((i) => ({ path: `keyframes[${i}].roving`, expected: true, actual: keys.find((k) => k.keyIndex === i)?.roving, message: `Key ${i} is not roving` }));
}

/** Keys that roving made roving (rove_between and the per-key roving): AE sets their ease, so the ease check leaves them out. */
export function rovingSkipKeys(result: unknown): number[] {
  const r = (result ?? {}) as { roving?: unknown; extras?: { roving?: unknown } };
  const nums = (v: unknown) => (Array.isArray(v) ? (v as unknown[]).filter((n): n is number => typeof n === "number") : []);
  return [...new Set([...nums(r.roving), ...nums(r.extras?.roving)])];
}

export function clampInfluenceValue(influence: number): number {
  if (influence < 0.1) return 0.1;
  if (influence > 100) return 100;
  return influence;
}

export function extractKeyframeEaseCheck(
  ease: KeyframeEaseInput | undefined,
  requestedKeys: number[] | undefined,
  afterSnapshot: unknown,
  skipKeys?: unknown
): { expected: unknown; actual: unknown } | null {
  if (ease === undefined || !afterSnapshot || typeof afterSnapshot !== "object" || isCurveEase(ease)) {
    return null;
  }
  const afterObj = afterSnapshot as Record<string, unknown>;
  if (!Array.isArray(afterObj.keyframes)) {
    return null;
  }
  const rawKeys = afterObj.keyframes as Array<Record<string, unknown>>;
  const keySet =
    requestedKeys && requestedKeys.length > 0
      ? new Set(requestedKeys)
      : null;
  // Roving keys are left out: AE retimes and re-eases them, and rovingMismatches checks them.
  const skip = new Set(Array.isArray(skipKeys) ? (skipKeys as number[]) : []);
  const targeted = (keySet
    ? rawKeys.filter(
        (kf) => typeof kf.keyIndex === "number" && keySet.has(kf.keyIndex)
      )
    : rawKeys
  ).filter((kf) => !(typeof kf.keyIndex === "number" && skip.has(kf.keyIndex)));

  if (targeted.length === 0) {
    return null;
  }

  if (ease === "hold" || ease === "linear") {
    const expectedInterp = ease;
    return {
      expected: {
        keyframes: targeted.map((kf) => ({
          keyIndex: kf.keyIndex,
          inInterp: expectedInterp,
          outInterp: expectedInterp,
        })),
      },
      actual: {
        keyframes: targeted.map((kf) => ({
          keyIndex: kf.keyIndex,
          inInterp: kf.inInterp,
          outInterp: kf.outInterp,
        })),
      },
    };
  }

  const targetIn =
    ease === "easy_ease"
      ? { speed: 0, influence: 33.333333 }
      : {
          speed: ease.in.speed,
          influence: clampInfluenceValue(ease.in.influence),
        };
  const targetOut =
    ease === "easy_ease"
      ? { speed: 0, influence: 33.333333 }
      : {
          speed: ease.out.speed,
          influence: clampInfluenceValue(ease.out.influence),
        };

  return {
    expected: {
      keyframes: targeted.map((kf) => {
        const dims =
          Array.isArray(kf.easeIn) && kf.easeIn.length > 0
            ? kf.easeIn.length
            : 1;
        return {
          keyIndex: kf.keyIndex,
          inInterp: "bezier",
          outInterp: "bezier",
          easeIn: Array.from({ length: dims }, () => ({ ...targetIn })),
          easeOut: Array.from({ length: dims }, () => ({ ...targetOut })),
        };
      }),
    },
    actual: {
      keyframes: targeted.map((kf) => ({
        keyIndex: kf.keyIndex,
        inInterp: kf.inInterp,
        outInterp: kf.outInterp,
        easeIn: kf.easeIn,
        easeOut: kf.easeOut,
      })),
    },
  };
}

// ---------- 1a. Per-key extras ----------

/** The interpolation an ease sets on the keys it touches (a curve, easy ease and explicit eases are bezier). */
export function easeInterpolationName(ease: KeyframeEaseInput): "linear" | "hold" | "bezier" {
  if (ease === "linear") return "linear";
  if (ease === "hold") return "hold";
  return "bezier";
}

/** Why a call's ease and per-key settings contradict each other, or null. Checked before anything is sent. */
export function keyExtrasConflict(
  ease: KeyframeEaseInput | undefined,
  extras: KeyExtras | undefined,
  roveBetween: boolean | undefined
): string | null {
  if (!extras) return null;
  if (roveBetween && extras.roving !== undefined) return "rove_between and roving both set roving; give one of them.";
  if (ease !== undefined) {
    const name = easeInterpolationName(ease);
    for (const side of ["in_interp", "out_interp"] as const) {
      const v = extras[side];
      if (v !== undefined && v !== name) {
        return `${side} "${v}" differs from the interpolation \`ease\` sets (${name}); for a mixed in / out interpolation leave \`ease\` out.`;
      }
    }
  }
  if (extras.spatial_auto_bezier === true && (extras.in_tangent !== undefined || extras.out_tangent !== undefined)) {
    return "Tangents can't be set while spatial_auto_bezier is true (auto bezier recomputes them).";
  }
  if (extras.spatial_auto_bezier === true && extras.spatial_continuous === false) return "spatial_auto_bezier true implies spatial_continuous true.";
  if (extras.temporal_auto_bezier === true && extras.temporal_continuous === false) return "temporal_auto_bezier true implies temporal_continuous true.";
  return null;
}

/** True when the extras move the temporal ease of the keys they touch (so an ease check would be wrong). */
export function extrasRecomputeEase(extras: KeyExtras | undefined): boolean {
  return !!extras && (extras.temporal_continuous === true || extras.temporal_auto_bezier === true);
}

function sameVector(a: unknown, b: number[]): boolean | undefined {
  if (!Array.isArray(a)) return undefined;
  if (a.length !== b.length) return false;
  return b.every((n, i) => typeof a[i] === "number" && Math.abs((a[i] as number) - n) <= Math.max(1e-3, Math.abs(n) * 1e-3));
}

/**
 * Read-back check for the per-key settings. A value the read-back could not read
 * (undefined) is unverified, never a mismatch.
 */
export function keyExtrasMismatches(
  extras: KeyExtras | undefined,
  keys: number[],
  afterSnapshot: unknown
): { mismatches: ReceiptMismatch[]; unverified: string[] } {
  const mismatches: ReceiptMismatch[] = [];
  const unverified: string[] = [];
  if (!extras) return { mismatches, unverified };
  const kfs = ((afterSnapshot as { keyframes?: Array<Record<string, unknown>> } | null)?.keyframes ?? []) as Array<Record<string, unknown>>;
  const truncated = (afterSnapshot as { truncated?: unknown } | null)?.truncated === true;
  const compare = (key: number, field: string, want: unknown, got: unknown, same: boolean | undefined) => {
    const path = `keyframes[${key}].${field}`;
    if (same === undefined || got === undefined) {
      unverified.push(path);
      return;
    }
    if (!same) mismatches.push({ path, expected: want, actual: got, message: `Expected ${path} to be ${JSON.stringify(want)}, got ${JSON.stringify(got)}` });
  };
  const flags: Array<[keyof KeyExtras, string]> = [
    ["spatial_continuous", "spatialContinuous"],
    ["spatial_auto_bezier", "spatialAutoBezier"],
    ["temporal_continuous", "temporalContinuous"],
    ["temporal_auto_bezier", "temporalAutoBezier"],
    ["roving", "roving"],
  ];
  for (const key of keys) {
    const kf = kfs.find((k) => k.keyIndex === key);
    if (!kf) {
      // A read capped at 500 keys can't show a later key: that is unverified, not a mismatch.
      if (truncated) {
        unverified.push(`keyframes[${key}]`);
        continue;
      }
      mismatches.push({ path: `keyframes[${key}]`, expected: "present", actual: undefined, message: `Key ${key} was not in the read-back` });
      continue;
    }
    if (extras.in_interp !== undefined) {
      compare(key, "inInterp", extras.in_interp, kf.inInterp, typeof kf.inInterp === "string" ? kf.inInterp === extras.in_interp : undefined);
    }
    if (extras.out_interp !== undefined) {
      compare(key, "outInterp", extras.out_interp, kf.outInterp, typeof kf.outInterp === "string" ? kf.outInterp === extras.out_interp : undefined);
    }
    if (extras.in_tangent !== undefined) compare(key, "inTangent", extras.in_tangent, kf.inTangent, sameVector(kf.inTangent, extras.in_tangent));
    if (extras.out_tangent !== undefined) compare(key, "outTangent", extras.out_tangent, kf.outTangent, sameVector(kf.outTangent, extras.out_tangent));
    for (const [arg, field] of flags) {
      const want = extras[arg];
      if (want === undefined) continue;
      const got = kf[field];
      compare(key, field, want, got, typeof got === "boolean" ? got === want : undefined);
    }
    if (extras.label !== undefined) {
      const got = kf.label;
      compare(key, "label", extras.label, got, typeof got === "number" ? got === extras.label : undefined);
    }
  }
  return { mismatches, unverified };
}

/** The keys a call targets: the numbers it gave, the timeline selection, or every key. */
export function resolveTargetKeys(
  keys: number[] | "selected" | undefined,
  snapshot: unknown
): { keys: number[] | undefined } | { error: string } {
  if (keys !== "selected") return { keys };
  const kfs = (snapshot as { keyframes?: Array<{ keyIndex: number; selected?: boolean }> } | null)?.keyframes ?? [];
  if (!kfs.some((k) => typeof k.selected === "boolean")) {
    return { error: "This After Effects did not report which keys are selected (Property.selectedKeys); give the key numbers in `keys`." };
  }
  const picked = kfs.filter((k) => k.selected === true).map((k) => k.keyIndex);
  if (picked.length === 0) {
    return { error: "No keys are selected on that property in the timeline; select them in After Effects or give the key numbers in `keys`." };
  }
  return { keys: picked };
}

// ---------- 1b. Curve easing ----------

export type BezierCurve = [number, number, number, number];

export interface EaseEnd {
  speed: number;
  influence: number;
}

export interface EaseSides {
  key: number;
  in?: EaseEnd[];
  out?: EaseEnd[];
}

interface KeySnapshot {
  keyIndex: number;
  time: number;
  value: unknown;
  easeIn?: EaseEnd[];
  easeOut?: EaseEnd[];
  inTangent?: unknown;
  outTangent?: unknown;
  inInterp?: string;
  outInterp?: string;
}

interface PropertySnapshot {
  isSpatial?: boolean;
  truncated?: boolean;
  keyframes: KeySnapshot[];
}

// AE's influence floor is 0.1%, so a handle can't sit exactly on its key.
// (MIN_HANDLE itself is declared above, next to KeyframeEaseCurveSchema, so
// the one bound governs both validation and clamping.)

export function isCurveEase(ease: KeyframeEaseInput): ease is { curve: number[] } {
  return typeof ease === "object" && ease !== null && "curve" in ease;
}

function asVector(v: unknown): number[] | null {
  if (typeof v === "number") return [v];
  if (Array.isArray(v) && v.every((n) => typeof n === "number")) return v as number[];
  return null;
}

/** Length of a spatial segment's motion path (cubic Bezier through the tangents). */
export function pathLength(from: number[], outTangent: number[] | null, inTangent: number[] | null, to: number[]): number {
  const dims = Math.min(from.length, to.length);
  const p1 = from.slice(0, dims).map((v, d) => v + (outTangent?.[d] ?? 0));
  const p2 = to.slice(0, dims).map((v, d) => v + (inTangent?.[d] ?? 0));
  const steps = 200;
  let length = 0;
  let prev = from.slice(0, dims);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    const point = from.slice(0, dims).map(
      (v, d) => u * u * u * v + 3 * u * u * t * p1[d] + 3 * u * t * t * p2[d] + t * t * t * to[d]
    );
    length += Math.hypot(...point.map((v, d) => v - prev[d]));
    prev = point;
  }
  return length;
}

/**
 * Turns a cubic-bezier into AE temporal ease for each segment between
 * neighbouring selected keys. On a segment of duration T and distance D
 * (signed per dimension, or path length for spatial properties), the out
 * handle of its first key gets influence x1 and speed (y1 / x1) * D / T, and
 * the in handle of its last key gets influence 1 - x2 and speed
 * ((1 - y2) / (1 - x2)) * D / T.
 */
export function curveToSides(
  snapshot: unknown,
  keys: number[] | undefined,
  curve: number[]
): { sides: EaseSides[]; segments: Array<[number, number]>; warnings: string[] } {
  const snap = snapshot as PropertySnapshot | null;
  if (!snap || !Array.isArray(snap.keyframes)) {
    throw new Error("Could not read the property's keyframes");
  }
  const byIndex = new Map(snap.keyframes.map((k) => [k.keyIndex, k]));
  const selected = (keys && keys.length > 0 ? [...new Set(keys)] : snap.keyframes.map((k) => k.keyIndex)).sort(
    (a, b) => a - b
  );
  const segments: Array<[number, number]> = [];
  for (let i = 0; i + 1 < selected.length; i++) {
    if (selected[i + 1] === selected[i] + 1) segments.push([selected[i], selected[i + 1]]);
  }
  if (segments.length === 0) {
    throw new Error("A curve needs at least two neighbouring keys (for example keys [1, 2]).");
  }

  const x1 = Math.min(1, Math.max(MIN_HANDLE, curve[0]));
  const x2 = Math.min(1 - MIN_HANDLE, Math.max(0, curve[2]));
  const y1 = curve[1];
  const y2 = curve[3];
  const warnings: string[] = [];
  const sides = new Map<number, EaseSides>();
  const sideFor = (key: number) => {
    let s = sides.get(key);
    if (!s) {
      s = { key };
      sides.set(key, s);
    }
    return s;
  };

  for (const [ai, bi] of segments) {
    const a = byIndex.get(ai);
    const b = byIndex.get(bi);
    if (!a || !b) {
      throw new Error(`Keyframe ${a ? bi : ai} was not read (the property has too many keys)`);
    }
    const duration = b.time - a.time;
    if (!(duration > 0)) throw new Error(`Keys ${ai} and ${bi} share a time`);
    const from = asVector(a.value);
    const to = asVector(b.value);
    if (!from || !to) throw new Error(`Keys ${ai} and ${bi} do not hold numeric values`);
    // Prefer the vector read off the keyframe's actual value: it reflects the property's
    // real dimensionality even when one side's ease read failed or came back empty (the
    // JSX host swallows that read error), whereas trusting a.easeOut alone silently falls
    // back to 1 and produces an ease array too short for b's "in" side.
    const dims = Math.max(1, from.length, to.length, a.easeOut?.length ?? 0, b.easeIn?.length ?? 0);

    let distances: number[];
    if (snap.isSpatial) {
      distances = [pathLength(from, asVector(a.outTangent), asVector(b.inTangent), to)];
    } else if (dims === 1) {
      distances = [to[0] - from[0]];
    } else {
      distances = Array.from({ length: dims }, (_, d) => (to[d] ?? 0) - (from[d] ?? 0));
    }

    const speeds = (factor: number) =>
      distances.map((dist) => {
        const speed = (factor * dist) / duration;
        if (snap.isSpatial && speed < 0) {
          warnings.push(`Keys ${ai}-${bi}: a spatial speed can't go negative, so the anticipation was dropped.`);
          return 0;
        }
        return speed === 0 ? 0 : speed; // no -0
      });
    const outSpeeds = speeds(y1 / x1);
    const inSpeeds = speeds((1 - y2) / (1 - x2));
    sideFor(ai).out = outSpeeds.map((speed) => ({ speed, influence: x1 * 100 }));
    sideFor(bi).in = inSpeeds.map((speed) => ({ speed, influence: (1 - x2) * 100 }));
  }

  return {
    sides: [...sides.values()].sort((p, q) => p.key - q.key),
    segments,
    warnings: [...new Set(warnings)],
  };
}

function easeMatches(expected: EaseEnd, actual: EaseEnd | undefined): boolean {
  if (!actual) return false;
  const speedTol = Math.max(1e-3, Math.abs(expected.speed) * 1e-3);
  return (
    Math.abs(expected.speed - actual.speed) <= speedTol &&
    Math.abs(clampInfluenceValue(expected.influence) - actual.influence) <= 0.01
  );
}

/** Read-back check for curve easing, with a relative tolerance on speed. */
export function curveEaseMismatches(sides: EaseSides[], afterSnapshot: unknown): ReceiptMismatch[] {
  const snap = afterSnapshot as PropertySnapshot | null;
  const mismatches: ReceiptMismatch[] = [];
  const byIndex = new Map((snap?.keyframes ?? []).map((k) => [k.keyIndex, k]));
  for (const side of sides) {
    const kf = byIndex.get(side.key);
    for (const which of ["in", "out"] as const) {
      const expected = side[which];
      if (!expected) continue;
      const actualList = which === "in" ? kf?.easeIn : kf?.easeOut;
      const interp = which === "in" ? kf?.inInterp : kf?.outInterp;
      const path = `keyframes[${side.key}].${which === "in" ? "easeIn" : "easeOut"}`;
      const ok = interp === "bezier" && expected.every((e, d) => easeMatches(e, actualList?.[d]));
      if (!ok) {
        mismatches.push({
          path,
          expected: { interp: "bezier", ease: expected },
          actual: { interp, ease: actualList },
          message: `Expected ${path} to be bezier ${JSON.stringify(expected)}, got ${interp} ${JSON.stringify(actualList)}`,
        });
      }
    }
  }
  return mismatches;
}

// ---------- 2. ae_set_text ----------

export const TextJustificationSchema = z.enum(["left", "center", "right"]);

export const RgbColorSchema = z
  .array(z.number().min(0).max(1))
  .length(3)
  .describe("RGB color array [r, g, b] with components in 0..1.");

/** A font as a PostScript name, `{ postscript }` or `{ family, style }` (looked up in app.fonts on AE 24+). */
export const FontInputSchema = z
  .union([
    z.string().min(1),
    z.object({ postscript: z.string().min(1) }),
    z.object({ family: z.string().min(1), style: z.string().min(1) }),
  ])
  .describe(
    "A PostScript name ('Inter-Bold', 'ArialMT'), `{ postscript }` or `{ family: 'Inter', style: 'Bold' }`. On AE 24+ the font is looked up in the installed fonts before anything is written: an unknown name is refused with the near matches (pass allow_substitute: true to write the name anyway), and a font After Effects would substitute is flagged on the receipt."
  );

export const TextCapsSchema = z.enum(["normal", "small", "all", "all_small"]);
export const TextBaselineSchema = z.enum(["normal", "superscript", "subscript"]);
export const TextKerningSchema = z.union([z.enum(["metrics", "optical", "none"]), z.number().min(-10000).max(10000)]);
export const TextLineJoinSchema = z.enum(["miter", "round", "bevel"]);
export const TextLineOrientationSchema = z.enum(["horizontal", "vertical_rtl", "vertical_ltr"]);
export const TextJustifyFullSchema = z.enum(["left", "center", "right", "full_left", "full_center", "full_right", "full"]);

export const TextStyleSchema = z
  .object({
    font: FontInputSchema.optional(),
    fontSize: z
      .number()
      .positive()
      .optional()
      .describe("Font size in pixels."),
    tracking: z
      .number()
      .optional()
      .describe("Character tracking value."),
    leading: z
      .number()
      .optional()
      .describe("Line leading in pixels. Setting it switches auto leading off."),
    fillColor: RgbColorSchema.optional().describe(
      "Fill color [r, g, b] in 0..1."
    ),
    strokeColor: RgbColorSchema.optional().describe(
      "Stroke color [r, g, b] in 0..1."
    ),
    strokeWidth: z
      .number()
      .min(0)
      .optional()
      .describe("Stroke width in pixels."),
    applyFill: z
      .boolean()
      .optional()
      .describe("Whether fill is enabled on the text layer."),
    applyStroke: z
      .boolean()
      .optional()
      .describe("Whether stroke is enabled on the text layer."),
    justification: TextJustificationSchema.optional().describe(
      "Paragraph justification: 'left', 'center', or 'right'. The full-justify variants are `paragraph.justify`."
    ),
    caps: TextCapsSchema.optional().describe("Capitalisation: 'normal', 'small' (small caps), 'all' (all caps) or 'all_small' (AE 24.0+, fontCapsOption)."),
    baseline: TextBaselineSchema.optional().describe("Baseline position: 'normal', 'superscript' or 'subscript' (AE 24.0+, fontBaselineOption)."),
    kerning: TextKerningSchema.optional().describe(
      "Kerning: 'metrics', 'optical' or 'none' (the auto-kern mode), or a number in 1/1000 em. A number switches automatic kerning off (the result says so)."
    ),
    ligature: z.boolean().optional().describe("Standard ligatures on or off."),
    no_break: z.boolean().optional().describe("No Break: keep the text together at line ends."),
    horizontal_scale: z.number().min(0).max(1000).optional().describe("Horizontal glyph scale, sent as given (1 = 100% in After Effects' scripting; the read-back shows how this build reads it)."),
    vertical_scale: z.number().min(0).max(1000).optional().describe("Vertical glyph scale; see horizontal_scale."),
    tsume: z.number().min(0).max(100).optional().describe("Tsume (CJK character tightening). The scripting guide gives both 0-1 and 0-100 for it; the value is sent as given and the read-back shows which one this build uses."),
    stroke_over_fill: z.boolean().optional().describe("Stroke draws over the fill (true) or under it (false). A layer-level 'All Fills/Strokes First' setting can override it."),
    line_join: TextLineJoinSchema.optional().describe("Stroke corner style: 'miter', 'round' or 'bevel'."),
    auto_leading: z.boolean().optional().describe("Auto leading on or off. Can't be true together with `leading`."),
    digit_set: z.string().min(1).max(40).optional().describe("Digit set by name as After Effects spells it (for example 'default', 'hindi', 'arabic_digits'); an exact name wins, a partial name must match one member only, and a name this build lacks is refused with the ones it has."),
    baseline_direction: z.string().min(1).max(40).optional().describe("Baseline direction for vertical text, by name as After Effects spells it; a name this build lacks is refused with the ones it has."),
    line_orientation: TextLineOrientationSchema.optional().describe("Line orientation: 'horizontal', 'vertical_rtl' or 'vertical_ltr' (AE 24.2+)."),
    faux_bold: z.boolean().optional().describe("Faux bold for the whole text (per word: ranges[].style.fauxBold)."),
    faux_italic: z.boolean().optional().describe("Faux italic for the whole text (per word: ranges[].style.fauxItalic)."),
  })
  .describe(
    "Optional TextDocument styling properties to update. The character options from `caps` on are AE 24.0+ (24.2 for line_orientation); an AE without the member refuses before anything is written."
  );

export type TextStyleInput = z.infer<typeof TextStyleSchema>;

function hasAnyStyleField(style: TextStyleInput | undefined): boolean {
  if (!style) return false;
  return Object.values(style).some((v) => v !== undefined);
}

export const TextParagraphSchema = z
  .object({
    justify: TextJustifyFullSchema.optional().describe(
      "Justification including the full-justify variants: 'left', 'center', 'right', 'full_left', 'full_center', 'full_right' (last line left, centred, right) and 'full' (last line justified too). Not together with style.justification."
    ),
    space_before: z.number().min(-10000).max(10000).optional().describe("Space before each paragraph, in pixels."),
    space_after: z.number().min(-10000).max(10000).optional().describe("Space after each paragraph, in pixels."),
    first_line_indent: z.number().min(-10000).max(10000).optional().describe("First line indent, in pixels (negative for a hanging indent)."),
    start_indent: z.number().min(-10000).max(10000).optional().describe("Left (start) indent, in pixels."),
    end_indent: z.number().min(-10000).max(10000).optional().describe("Right (end) indent, in pixels."),
    every_line_composer: z.boolean().optional().describe("Every-line composer (true) or single-line composer (false)."),
    hanging_roman: z.boolean().optional().describe("Roman hanging punctuation."),
    auto_hyphenate: z.boolean().optional().describe("Automatic hyphenation."),
    leading_type: z.enum(["roman", "japanese"]).optional().describe("Leading type: 'roman' or 'japanese'."),
    direction: z.enum(["ltr", "rtl"]).optional().describe("Paragraph direction: 'ltr' or 'rtl' (right-to-left titles)."),
    composer: z.enum(["universal"]).optional().describe("Composer engine. Only 'universal' is accepted by After Effects, and the change is one-way."),
  })
  .describe(
    "Paragraph options, applied to the whole text document (AE 24.0+). Whether these can be set for a single paragraph is undocumented, so they are not per paragraph; use `paragraphs` for per-paragraph character styles."
  );

export type TextParagraphInput = z.infer<typeof TextParagraphSchema>;

export const TextBoxSchema = z
  .object({
    size: z.tuple([z.number().int().min(1).max(100000), z.number().int().min(1).max(100000)]).optional().describe("Box size [width, height] in pixels (whole numbers). Rewraps the text. Refused together with a height auto_fit, and also when the layer already has a height auto_fit (auto fit resets the height); give auto_fit \"none\" with the size."),
    position: z.tuple([z.number(), z.number()]).optional().describe("Box position [x, y] in layer coordinates."),
    vertical_align: z.enum(["top", "center", "bottom", "justify"]).optional().describe("Vertical alignment of the text in the box."),
    auto_fit: z
      .enum(["none", "height_cursor", "height_precise", "height_baseline"])
      .optional()
      .describe("Auto-fit the box height to the text. Only works with vertical_align 'top' (refused otherwise). A height policy (not none) can't be given together with box.size (the text sets the height)."),
    inset: z
      .union([z.number(), z.array(z.number()).min(1).max(8)])
      .optional()
      .describe("Inset spacing: one number for all sides, or the array in After Effects' own order (its length must match the current value; the read-back shows the current one as box.inset). An After Effects whose inset is a single number takes one number only and refuses every array."),
    first_baseline: z.string().min(1).max(40).optional().describe("First baseline alignment by name as After Effects spells it (for example 'ascent', 'cap_height', 'leading'); a name this build lacks is refused with the ones it has."),
    first_baseline_min: z.number().min(0).max(100000).optional().describe("Minimum first-baseline offset. A non-zero minimum disables first_baseline, so they can't be given together."),
  })
  .describe(
    "Box text options (AE 24.6+). Refused on point text before anything is written: point <-> box conversion is not scriptable. The receipt measures the text again (layout), since a new box size rewraps it."
  );

export type TextBoxInput = z.infer<typeof TextBoxSchema>;

/** The style fields a character range takes (TextDocument.characterRange, AE 24.3+). */
export const RANGE_STYLE_KEYS = [
  "font",
  "fontSize",
  "tracking",
  "baselineShift",
  "fillColor",
  "strokeColor",
  "strokeWidth",
  "applyFill",
  "applyStroke",
  "fauxBold",
  "fauxItalic",
] as const;

export const RangeStyleSchema = z
  .object({
    font: FontInputSchema.optional(),
    fontSize: z.number().min(0.1).max(1296).optional().describe("Font size in pixels for the range."),
    tracking: z.number().optional().describe("Tracking for the range."),
    baselineShift: z.number().optional().describe("Baseline shift in pixels for the range (positive raises)."),
    fillColor: RgbColorSchema.optional().describe("Fill colour [r, g, b] in 0..1 (also turns the fill on)."),
    strokeColor: RgbColorSchema.optional().describe("Stroke colour [r, g, b] in 0..1 (also turns the stroke on)."),
    strokeWidth: z.number().min(0).optional().describe("Stroke width in pixels for the range."),
    applyFill: z.boolean().optional().describe("Turn the fill on or off for the range."),
    applyStroke: z.boolean().optional().describe("Turn the stroke on or off for the range."),
    fauxBold: z.boolean().optional().describe("Faux bold for the range."),
    fauxItalic: z.boolean().optional().describe("Faux italic for the range."),
  })
  .refine((s) => RANGE_STYLE_KEYS.some((k) => s[k] !== undefined), { message: "A range's style needs at least one field." });

export type RangeStyleInput = z.infer<typeof RangeStyleSchema>;

export const TextRangeSchema = z
  .object({
    match: z.string().min(1).max(200).optional().describe("Style this text wherever it occurs (case-sensitive), instead of start/end."),
    occurrence: z.enum(["first", "all"]).optional().describe("With match: the first occurrence or all of them (default all, at most 200)."),
    start: z.number().int().min(0).optional().describe("First character, 0-based."),
    end: z.number().int().min(1).optional().describe("One past the last character. Default: the end of the text."),
    style: RangeStyleSchema,
  })
  .refine((r) => (r.match !== undefined) !== (r.start !== undefined), { message: "A range takes `match`, or `start` (with `end`), not both." })
  .refine((r) => r.end === undefined || r.start !== undefined, { message: "`end` goes with `start`." })
  .refine((r) => r.start === undefined || r.end === undefined || r.end > r.start, { message: "`end` must be above `start`." })
  .refine((r) => r.occurrence === undefined || r.match !== undefined, { message: "`occurrence` goes with `match`." });

export type TextRangeInput = z.infer<typeof TextRangeSchema>;

export const TextParagraphStyleSchema = z
  .object({
    index: z.number().int().min(0).optional().describe("The paragraph, 0-based (paragraphs are separated by a line break)."),
    match: z.string().min(1).max(200).optional().describe("Every paragraph that contains this text (case-sensitive), instead of index."),
    occurrence: z.enum(["first", "all"]).optional().describe("With match: the first such paragraph or all of them (default all)."),
    style: RangeStyleSchema,
  })
  .refine((p) => (p.index !== undefined) !== (p.match !== undefined), { message: "A paragraph entry takes `index` or `match`, not both." })
  .refine((p) => p.occurrence === undefined || p.match !== undefined, { message: "`occurrence` goes with `match`." });

export type TextParagraphStyleInput = z.infer<typeof TextParagraphStyleSchema>;

export const AeSetTextSchema = z
  .object({
    comp_id: z.number().int().describe("Target CompItem ID."),
    layer: LayerSelectorSchema,
    text: z
      .string()
      .optional()
      .describe("New text string to set on the TextLayer's Source Text."),
    style: TextStyleSchema.optional(),
    paragraph: TextParagraphSchema.optional(),
    box: TextBoxSchema.optional(),
    ranges: z
      .array(TextRangeSchema)
      .min(1)
      .max(50)
      .optional()
      .describe(
        "Per-word or per-character styling, applied after `text` and `style`: each range is `match` (a word) or `start`/`end`, with a `style` of font, fontSize, tracking, baselineShift, fillColor, strokeColor, strokeWidth, applyFill, applyStroke, fauxBold, fauxItalic. " +
          "Needs AE 24.3+ (TextDocument.characterRange); refused before anything is written on older AE. Ranges that overlap and set the same field are refused; values are checked before the write. Read back range by range; a range whose values read back as mixed is reported as a mismatch."
      ),
    paragraphs: z
      .array(TextParagraphStyleSchema)
      .min(1)
      .max(50)
      .optional()
      .describe(
        "Character styles for whole paragraphs ('the second paragraph in red', 'every paragraph that contains NOW in bold'): each entry is `index` (0-based) or `match`, with the same `style` fields as a range. The paragraph is turned into a character range on the final text, so it needs AE 24.3+ like `ranges` and follows the same overlap rules. Paragraph-wide attributes (spacing, indents) are not per paragraph: see `paragraph`."
      ),
    allow_substitute: z
      .boolean()
      .optional()
      .describe("Write a PostScript font name even when it is not installed (After Effects then substitutes). Default false: an unknown font is refused with the near matches."),
    expect: ExpectSchema,
  })
  .refine(
    (val) =>
      val.text !== undefined ||
      hasAnyStyleField(val.style) ||
      val.ranges !== undefined ||
      hasAnyStyleField(val.paragraph as TextStyleInput | undefined) ||
      hasAnyStyleField(val.box as TextStyleInput | undefined) ||
      val.paragraphs !== undefined,
    {
      message:
        "ae_set_text requires at least `text`, one defined property in `style`, `paragraph` or `box`, `ranges` or `paragraphs`.",
    }
  )
  .refine((val) => !(val.paragraph?.justify !== undefined && val.style?.justification !== undefined), {
    message: "paragraph.justify and style.justification both set the justification; give one of them.",
  })
  .refine((val) => !(val.style?.leading !== undefined && val.style?.auto_leading === true), {
    message: "style.leading and style.auto_leading true contradict each other (setting leading switches auto leading off).",
  })
  .refine((val) => !(val.box?.first_baseline !== undefined && val.box?.first_baseline_min !== undefined && val.box.first_baseline_min !== 0), {
    message: "A non-zero box.first_baseline_min disables box.first_baseline; give one of them.",
  });

const TYPED_STYLE_KEYS = [
  "caps",
  "baseline",
  "kerning",
  "ligature",
  "no_break",
  "horizontal_scale",
  "vertical_scale",
  "tsume",
  "stroke_over_fill",
  "line_join",
  "auto_leading",
  "digit_set",
  "baseline_direction",
  "line_orientation",
  "faux_bold",
  "faux_italic",
] as const;

/** True when a call uses the typography, paragraph, box or per-paragraph options (which are read back by name). */
export function usesTypedText(args: { style?: Record<string, unknown>; paragraph?: unknown; box?: unknown; paragraphs?: unknown }): boolean {
  if (args.paragraph !== undefined || args.box !== undefined || args.paragraphs !== undefined) return true;
  const st = args.style ?? {};
  return TYPED_STYLE_KEYS.some((k) => st[k] !== undefined);
}

/**
 * What the typed options should read back as, against the typed block of the read-back. A value AE reports
 * as undefined (mixed in the text, or not readable) is unverified, never a mismatch.
 */
export function typedTextChecks(
  set: unknown,
  justify: string | undefined,
  afterObj: Record<string, unknown>,
  coveredPaths: string[] = []
): { expected: Record<string, unknown>; actual: Record<string, unknown>; unverified: string[] } {
  const expected: Record<string, unknown> = {};
  const actual: Record<string, unknown> = {};
  const unverified: string[] = [];
  const mixed = Array.isArray(afterObj.mixed) ? (afterObj.mixed as string[]) : [];
  const wanted = (set ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const want: Record<string, Record<string, unknown>> = {
    typography: { ...(wanted.typography ?? {}) },
    paragraph: { ...(wanted.paragraph ?? {}) },
    box: { ...(wanted.box ?? {}) },
  };
  if (justify !== undefined) want.paragraph.justify = justify;
  for (const group of ["typography", "paragraph", "box"] as const) {
    const got = (afterObj[group] ?? {}) as Record<string, unknown>;
    for (const [key, value] of Object.entries(want[group])) {
      const path = `${group}.${key}`;
      // A path a range starting at 0 also sets is verified by that range's own read-back.
      if (coveredPaths.includes(path) || mixed.includes(path) || got[key] === undefined) {
        unverified.push(path);
        continue;
      }
      expected[path] = value;
      actual[path] = got[key];
    }
  }
  return { expected, actual, unverified };
}

/** Whether the wrap changed between two measurements (the source rect or the composed line count). */
export function layoutChanged(before: unknown, after: unknown): boolean | null {
  const b = before as { source_rect?: Record<string, number>; composed_line_count?: number } | undefined;
  const a = after as { source_rect?: Record<string, number>; composed_line_count?: number } | undefined;
  if (!b || !a) return null;
  if (typeof b.composed_line_count === "number" && typeof a.composed_line_count === "number" && b.composed_line_count !== a.composed_line_count) return true;
  if (b.source_rect && a.source_rect) {
    return (["top", "left", "width", "height"] as const).some((k) => Math.abs((b.source_rect![k] ?? 0) - (a.source_rect![k] ?? 0)) > 0.5);
  }
  return null;
}

/** A range the host styled: offsets (a `match` is resolved there) and the fields it set. */
export interface AppliedRange {
  start: number;
  end: number;
  text?: string;
  style: Partial<RangeStyleInput>;
}

export function resolvedRanges(result: unknown): AppliedRange[] {
  const list = (result as { ranges?: unknown } | null | undefined)?.ranges;
  if (!Array.isArray(list)) return [];
  return list.filter((r): r is AppliedRange => !!r && typeof r.start === "number" && typeof r.end === "number" && !!r.style && typeof r.style === "object");
}

const FILL_GROUP = ["fillColor", "applyFill"];
const STROKE_GROUP = ["strokeColor", "strokeWidth", "applyStroke"];

/** True when an applied range that starts at character 0 sets this whole-document key (fill and stroke keys count as a group). */
export function coveredByFirstRange(key: string, ranges: AppliedRange[]): boolean {
  let group = [key];
  if (FILL_GROUP.includes(key)) group = FILL_GROUP;
  else if (STROKE_GROUP.includes(key)) group = STROKE_GROUP;
  return ranges.some((r) => r.start === 0 && group.some((g) => (r.style as Record<string, unknown>)[g] !== undefined));
}

/** `ranges[i].field` → the value the range was given. */
export function rangeExpectations(ranges: AppliedRange[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  ranges.forEach((r, i) => {
    for (const k of RANGE_STYLE_KEYS) if (r.style[k] !== undefined) out[`ranges[${i}].${k}`] = r.style[k];
  });
  return out;
}

/**
 * The same keys from the read-back. A field that read back mixed (undefined in
 * AE) stays undefined here, so it shows up as a mismatch and is never taken
 * for 0 or false.
 */
export function rangeActuals(ranges: AppliedRange[], afterRanges: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const list = Array.isArray(afterRanges) ? (afterRanges as Array<{ style?: Record<string, unknown> }>) : [];
  ranges.forEach((r, i) => {
    for (const k of RANGE_STYLE_KEYS) if (r.style[k] !== undefined) out[`ranges[${i}].${k}`] = list[i]?.style?.[k];
  });
  return out;
}

// ---------- 3. ae_import_footage ----------

export const ImportAsSchema = z.enum(["footage", "comp", "comp_cropped_layers", "project"]);

export const ImportPlaceholderSchema = z.object({
  name: z.string().min(1).max(255).describe("Placeholder name."),
  width: z.number().int().min(4).max(30000).describe("Width in pixels, 4 to 30000."),
  height: z.number().int().min(4).max(30000).describe("Height in pixels, 4 to 30000."),
  fps: z.number().min(1).max(99).describe("Frame rate, 1 to 99."),
  duration: z.number().min(0).max(10800).describe("Duration in seconds, 0 to 10800."),
});

export const AeImportFootageSchema = z
  .object({
    paths: z
      .array(z.string().min(1))
      .min(1)
      .max(500)
      .optional()
      .describe("Absolute file paths of footage files to import. Optional only when `placeholders` is given."),
    sequence: z
      .boolean()
      .optional()
      .describe(
        "If true, import as an image sequence, numbered frames in order with placeholders for missing ones (Force alphabetical order off, AE's default)."
      ),
    fps: z
      .number()
      .positive()
      .optional()
      .describe(
        "Optional frame rate (conformFrameRate) to assign to imported footage items."
      ),
    target_folder_id: z
      .number()
      .int()
      .optional()
      .describe(
        "Optional FolderItem ID in the project to place the imported items into. With import_as 'comp' / 'comp_cropped_layers' / 'project' it receives the top created items (the comp and the folder AE makes for the layers)."
      ),
    import_as: ImportAsSchema.optional().describe(
      "What to build from a layered file (PSD, AI) or project: 'footage' (default: one flattened footage item or the merged layers), 'comp' (a comp with one layer per file layer), 'comp_cropped_layers' (the same, layers cropped to their content) or 'project' (an After Effects project file, its whole tree). ImportOptions.canImportAs is asked first for every file; a file that cannot be imported that way is refused before anything is imported, listing the types it allows. " +
        "The result lists new_comp_ids, new_folder_ids, main_comp_id and created_folder_id (found by diffing the project's items before and after). Importing a project or an older file can raise After Effects dialogs (missing fonts or footage, conversion): they are never suppressed; read them with ae_dialogs and answer with ae_dialog_respond. Not combined with `sequence`."
    ),
    range: z
      .object({
        start: z.number().int().min(0).describe("First frame number of the sequence to import."),
        end: z.number().int().min(0).describe("Last frame number."),
      })
      .refine((r) => r.end >= r.start, { message: "range.end must be at or above range.start." })
      .optional()
      .describe(
        "With sequence: true, import only frames start..end of a numbered sequence (ImportOptions.rangeStart / rangeEnd, undocumented: probed before the write). Can't be combined with force_alphabetical: true, which makes After Effects throw."
      ),
    force_alphabetical: z
      .boolean()
      .optional()
      .describe("With sequence: true, import in alphabetical rather than numbered order. Default false (numbered order with placeholders for gaps)."),
    placeholders: z
      .array(ImportPlaceholderSchema)
      .min(1)
      .max(100)
      .optional()
      .describe("Placeholders to create for footage that is not there yet (Project.importPlaceholder), each {name, width, height, fps, duration}; their ids are in `placeholder_ids` and at the end of `item_ids`."),
    expect: ExpectSchema,
  })
  .refine((v) => v.paths !== undefined || v.placeholders !== undefined, {
    message: "ae_import_footage needs `paths` or `placeholders`.",
  })
  .refine((v) => v.range === undefined || v.sequence === true, { message: "`range` goes with sequence: true." })
  .refine((v) => v.force_alphabetical === undefined || v.sequence === true, { message: "`force_alphabetical` goes with sequence: true." })
  .refine((v) => !(v.range !== undefined && v.force_alphabetical === true), {
    message: "`range` can't be combined with force_alphabetical: true (After Effects throws on rangeStart / rangeEnd then).",
  })
  .refine((v) => v.import_as === undefined || v.import_as === "footage" || v.sequence !== true, {
    message: "import_as 'comp', 'comp_cropped_layers' and 'project' can't be combined with sequence: true.",
  });

// ---------- 4. ae_replace_footage ----------

export const AeReplaceFootageSchema = z
  .object({
    action: z
      .enum(["replace", "reload"])
      .optional()
      .describe("'replace' (default): relink a footage item to another file. 'reload': reload the main file source of footage items after the files changed on disk."),
    item_id: z
      .number()
      .int()
      .optional()
      .describe("Project FootageItem ID to replace (or, with action 'reload', a single item to reload)."),
    path: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Absolute file path to the replacement footage file (or first frame of a sequence). Required for 'replace'."
      ),
    sequence: z
      .boolean()
      .optional()
      .describe(
        "If true, use FootageItem.replaceWithSequence(file, false) (numbered order, gaps kept as placeholders); otherwise use FootageItem.replace(file)."
      ),
    item_ids: z
      .array(z.number().int())
      .min(1)
      .max(500)
      .optional()
      .describe("With action 'reload': the FootageItem ids to reload. Any item that can't be reloaded (a proxy in use, a solid, a placeholder) refuses the whole call."),
    folder_id: z
      .number()
      .int()
      .optional()
      .describe("With action 'reload': reload every file-based footage item under this folder (nested folders included, at most 500); solids, placeholders and proxy items are skipped and listed under `skipped`."),
    expect: ExpectSchema,
  })
  .superRefine((v, ctx) => {
    const action = v.action ?? "replace";
    if (action === "replace") {
      if (v.item_id === undefined || v.path === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "action 'replace' needs item_id and path." });
      }
      if (v.item_ids !== undefined || v.folder_id !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "item_ids and folder_id go with action 'reload'." });
      }
      return;
    }
    const targets = [v.item_ids !== undefined, v.folder_id !== undefined, v.item_id !== undefined].filter(Boolean).length;
    if (targets !== 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "action 'reload' needs exactly one of item_ids, folder_id or item_id." });
    }
    if (v.path !== undefined || v.sequence !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "path and sequence go with action 'replace'." });
    }
  });

interface ReloadItem {
  item_id: number;
  name?: string;
  width?: number;
  height?: number;
  duration?: number;
  frameRate?: number;
  footageMissing?: boolean;
}

/** Items whose size, duration or frame rate differ between two reads, by item id. */
export function reloadChanges(beforeItems: unknown, afterItems: unknown, ids: number[]): Array<Record<string, unknown>> {
  const list = (v: unknown) => (Array.isArray(v) ? (v as ReloadItem[]) : []);
  const before = new Map(list(beforeItems).map((i) => [i.item_id, i]));
  const after = new Map(list(afterItems).map((i) => [i.item_id, i]));
  const changed: Array<Record<string, unknown>> = [];
  for (const id of ids) {
    const b = before.get(id);
    const a = after.get(id);
    if (!b || !a) continue;
    const fields: string[] = [];
    if (b.width !== a.width) fields.push("width");
    if (b.height !== a.height) fields.push("height");
    if (typeof b.duration === "number" && typeof a.duration === "number" && Math.abs(b.duration - a.duration) > 1e-6) fields.push("duration");
    if (typeof b.frameRate === "number" && typeof a.frameRate === "number" && Math.abs(b.frameRate - a.frameRate) > 1e-4) fields.push("frameRate");
    if (fields.length > 0) {
      changed.push({
        item_id: id,
        name: a.name,
        changed: fields,
        before: { width: b.width, height: b.height, duration: b.duration, frameRate: b.frameRate },
        after: { width: a.width, height: a.height, duration: a.duration, frameRate: a.frameRate },
      });
    }
  }
  return changed;
}

/** ae_replace_footage action 'reload': FileSource.reload() on footage items, then a separate read of what changed. */
async function reloadFootage(args: any, ctx: Parameters<ToolDefinition<any>["handler"]>[1]) {
  ctx.quarantine.assertClear();
  const opId = ctx.bridge.newOpId();
  const targets: Record<string, unknown> = {};
  if (args.item_ids !== undefined) targets.item_ids = args.item_ids;
  else if (args.folder_id !== undefined) targets.folder_id = args.folder_id;
  else targets.item_ids = [args.item_id];
  const label = `ae_replace_footage(reload ${args.folder_id !== undefined ? `folder ${args.folder_id}` : `${(targets.item_ids as number[]).length} item(s)`})`;

  try {
    return await ctx.queue.run(label, async () => {
      ctx.quarantine.assertClear();

      const guard = await verifyTargetGuard(ctx, args.expect, opId);
      const checkpoint = await autoCheckpoint(ctx, guard, "ae_replace_footage");

      const beforeSnap = await ctx.bridge.evalRaw<Record<string, unknown>>({
        id: `${opId}_before`,
        script: buildJsxCall("animateReloadTargets", { ...targets, reloadable_only: true }),
        label: `${label} (before)`,
        mutates: false,
        toolName: "ae_replace_footage",
      });

      const writeResp = await ctx.bridge.evalRaw<Record<string, unknown>>({
        id: opId,
        script: buildJsxCall("animateReloadFootage", { ...targets, expect: args.expect }),
        label,
        timeoutMs: SLOW_TIMEOUT_MS,
        mutates: true,
        toolName: "ae_replace_footage",
      });

      const written = (writeResp.result ?? {}) as Record<string, unknown>;
      const ids = Array.isArray(written.item_ids) ? (written.item_ids as number[]) : [];
      const reloaded = Array.isArray(written.reloaded) ? (written.reloaded as number[]) : [];
      const base = {
        action: "reload" as const,
        reloaded,
        skipped: Array.isArray(written.skipped) ? written.skipped : [],
        ...(Array.isArray(written.failed) ? { failed: written.failed } : {}),
        ...(written.truncated ? { truncated: true } : {}),
      };

      // Nothing could be reloaded: the host changed nothing and opened no undo group.
      if (written.no_op === true || ids.length === 0) {
        return {
          op_id: opId,
          applied: true as const,
          no_op: true,
          ...base,
          changed_items: [],
          result: writeResp.result,
          checkpoint,
          receipt: buildReceipt({ before: beforeSnap.result, after: beforeSnap.result }),
        };
      }

      // Separate evalScript for read-back. The write is applied from here on, so a failed read is reported, never thrown.
      const afterRead = await readAfterWrite(opId, () =>
        ctx.bridge.evalRaw<Record<string, unknown>>({
          id: `${opId}_after`,
          script: buildJsxCall("animateReloadTargets", { item_ids: ids }),
          label: `${label} (after)`,
          mutates: false,
          toolName: "ae_replace_footage",
        })
      );
      if (afterRead.failure) {
        return {
          op_id: opId,
          applied: true as const,
          ...base,
          result: writeResp.result,
          checkpoint,
          receipt: buildReceipt({ before: beforeSnap.result, after: null, customMismatches: [afterRead.failure] }),
        };
      }
      const afterSnap = afterRead.value!;

      const beforeItems = (beforeSnap.result as { items?: unknown } | null)?.items;
      // A capped before list can miss reloaded items: their changes are then not reported, and unchanged_count is not claimed.
      const beforePartial = (beforeSnap.result as { truncated?: unknown } | null)?.truncated === true;
      const afterItems = (afterSnap.result as { items?: unknown } | null)?.items;
      const outcome = checkAfterWrite(
        opId,
        () => {
          const mismatches: ReceiptMismatch[] = [];
          for (const item of (Array.isArray(afterItems) ? afterItems : []) as ReloadItem[]) {
            if (reloaded.includes(item.item_id) && item.footageMissing === true) {
              mismatches.push({
                path: `items[${item.item_id}].footageMissing`,
                expected: false,
                actual: true,
                message: `Item ${item.item_id} (${item.name ?? "?"}) is still missing after the reload`,
              });
            }
          }
          for (const failure of (Array.isArray(written.failed) ? written.failed : []) as Array<{ item_id: number; name?: string; error?: string }>) {
            mismatches.push({
              path: `items[${failure.item_id}].reload`,
              expected: "reloaded",
              actual: failure.error ?? "failed",
              message: `Item ${failure.item_id} (${failure.name ?? "?"}) did not reload: ${failure.error ?? "unknown error"}`,
            });
          }
          return { mismatches, changed: reloadChanges(beforeItems, afterItems, reloaded) };
        },
        (failure) => ({ mismatches: [failure], changed: [] as Array<Record<string, unknown>> })
      );

      return {
        op_id: opId,
        applied: true as const,
        ...base,
        changed_items: outcome.changed,
        ...(beforePartial
          ? { changed_partial: true }
          : { unchanged_count: Math.max(0, reloaded.length - outcome.changed.length) }),
        result: writeResp.result,
        checkpoint,
        receipt: buildReceipt({ before: beforeSnap.result, after: afterSnap.result, customMismatches: outcome.mismatches }),
      };
    });
  } catch (err) {
    if (err instanceof QueueWaitError) {
      throw new BridgeError({ kind: "queued", op_id: opId, message: err.message });
    }
    throw err;
  }
}

/** Ids of everything an import_as import created (items, comps, folders), once each and capped at 500. */
export function createdItemIds(result: unknown): number[] {
  const r = (result ?? {}) as Record<string, unknown>;
  const ids = (key: string) => (Array.isArray(r[key]) ? (r[key] as unknown[]).filter((n): n is number => typeof n === "number") : []);
  const comps = ids("new_comp_ids");
  const folders = ids("new_folder_ids");
  if (comps.length === 0 && folders.length === 0) return [];
  return [...new Set([...ids("item_ids"), ...comps, ...folders])].slice(0, 500);
}

/** The ids and notes an import_as import adds to the tool's result, from the host's write result. */
export function importCreatedFields(result: unknown): Record<string, unknown> {
  const r = (result ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of ["new_comp_ids", "new_folder_ids", "main_comp_id", "created_folder_id", "created_item_count", "new_comp_count", "new_folder_count", "created_truncated", "placeholder_ids", "notes"]) {
    if (r[k] !== undefined) out[k] = r[k];
  }
  return out;
}

// ---------- Tool definitions ----------

export const animateTools: ToolDefinition<any>[] = [
  {
    name: "ae_set_keyframe_ease",
    description:
      "Set temporal keyframe easing and interpolation on a keyframed layer property within a single undo group, guarded by `expect`, and verified by a separate read-back evalScript receipt. " +
      "Supports presets ('easy_ease', 'linear', 'hold'), explicit `{ in: { speed, influence }, out: { speed, influence } }` (matched to the property's temporal ease dimension count), or `{ curve: [x1, y1, x2, y2] }`, a CSS-style cubic-bezier applied to each segment between neighbouring keys, such as one the user picked with ae_ask_user. " +
      "Per-key settings (`in_interp` / `out_interp` for a different interpolation in and out, `in_tangent` / `out_tangent` for motion-path handles, `spatial_continuous`, `spatial_auto_bezier`, `temporal_continuous`, `temporal_auto_bezier`, `roving`, `label` 0-16) go with an ease or on their own (leave `ease` out), use the same names as ae_get_keyframes, and are checked against what the property accepts before the undo group opens (hold-only properties, 2D/3D tangent length, first and last keys can't rove). They apply in the order interpolation, ease, tangents and continuity, roving last. " +
      "`keys: \"selected\"` targets the keys selected in the timeline. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeSetKeyframeEaseSchema,
    handler: async (args, ctx) => {
      if (args.rove_between && isCurveEase(args.ease)) {
        return { ok: false, error: "bad_args", message: "rove_between can't be combined with a curve: the curve sets every key's ease, roving keys included." };
      }
      if (args.rove_between && args.ease === "hold") {
        return { ok: false, error: "bad_args", message: "rove_between can't be combined with hold: held keys have no speed for roving to even out." };
      }
      const extras = pickKeyExtras(args);
      const extrasProblem = keyExtrasConflict(args.ease, extras, args.rove_between);
      if (extrasProblem) {
        return { ok: false, error: "bad_args", message: extrasProblem };
      }
      ctx.quarantine.assertClear();
      const opId = ctx.bridge.newOpId();
      const label = `ae_set_keyframe_ease(${args.path.join(".")})`;
      const effectiveExpect: ExpectGuard = {
        project_path: args.expect.project_path,
        comp_id: args.expect.comp_id ?? args.comp_id,
      };

      try {
        return await ctx.queue.run(label, async () => {
          ctx.quarantine.assertClear();

          const guard = await verifyTargetGuard(ctx, effectiveExpect, opId);
          const checkpoint = await autoCheckpoint(ctx, guard, "ae_set_keyframe_ease");

          const beforeSnap = await ctx.bridge.evalRaw({
            id: `${opId}_before`,
            script: buildJsxCall("getKeyframeEase", {
              comp_id: args.comp_id,
              layer: args.layer,
              path: args.path,
            }),
            label: `${label} (before)`,
            mutates: false,
            toolName: "ae_set_keyframe_ease",
          });

          // "selected" becomes the key numbers read off the property just now.
          const keyTarget = resolveTargetKeys(args.keys, beforeSnap.result);
          if ("error" in keyTarget) {
            return { ok: false, error: "bad_args", message: keyTarget.error };
          }
          const targetKeys = keyTarget.keys;

          // A curve becomes per-key sides here, from the keys' times and values.
          const curvePlan =
            args.ease !== undefined && isCurveEase(args.ease) ? curveToSides(beforeSnap.result, targetKeys, args.ease.curve) : null;

          let writeScript: string;
          if (curvePlan) {
            writeScript = buildJsxCall("setKeyframeEaseSides", {
              comp_id: args.comp_id,
              layer: args.layer,
              path: args.path,
              sides: curvePlan.sides,
              ...(extras ? { extras } : {}),
              expect: effectiveExpect,
            });
          } else if (args.ease === undefined) {
            writeScript = buildJsxCall("animateKeyExtras", {
              comp_id: args.comp_id,
              layer: args.layer,
              path: args.path,
              keys: targetKeys,
              extras,
              expect: effectiveExpect,
            });
          } else {
            writeScript = buildJsxCall("setKeyframeEase", {
              comp_id: args.comp_id,
              layer: args.layer,
              path: args.path,
              keys: targetKeys,
              ease: args.ease,
              rove_between: args.rove_between,
              ...(extras ? { extras } : {}),
              expect: effectiveExpect,
            });
          }
          const writeResp = await ctx.bridge.evalRaw<Record<string, unknown>>({
            id: opId,
            script: writeScript,
            label,
            mutates: true,
            toolName: "ae_set_keyframe_ease",
          });

          // Separate evalScript for read-back. The write is applied from here
          // on, so a failed read is reported, never thrown.
          const afterRead = await readAfterWrite(opId, () =>
            ctx.bridge.evalRaw<Record<string, unknown>>({
              id: `${opId}_after`,
              script: buildJsxCall("getKeyframeEase", {
                comp_id: args.comp_id,
                layer: args.layer,
                path: args.path,
              }),
              label: `${label} (after)`,
              mutates: false,
              toolName: "ae_set_keyframe_ease",
            })
          );
          if (afterRead.failure) {
            return {
              op_id: opId,
              applied: true as const,
              result: writeResp.result,
              ...(curvePlan
                ? {
                    curve: args.ease,
                    segments: curvePlan.segments,
                    ...(curvePlan.warnings.length > 0 ? { warnings: curvePlan.warnings } : {}),
                  }
                : {}),
              checkpoint,
              receipt: buildReceipt({ before: beforeSnap.result, after: null, customMismatches: [afterRead.failure] }),
            };
          }
          const afterSnap = afterRead.value!;

          // Temporal continuity recomputes the other side's ease, so an ease check would flag a correct write.
          const skipEaseCheck = extrasRecomputeEase(extras);
          const easeCheck = skipEaseCheck
            ? null
            : extractKeyframeEaseCheck(args.ease, targetKeys, afterSnap.result, rovingSkipKeys(writeResp.result));

          // The keys the per-key settings landed on, from the host (or the sides of a curve).
          const keysUpdated = Array.isArray(writeResp.result?.keysUpdated)
            ? (writeResp.result.keysUpdated as number[])
            : (targetKeys ?? []);
          const extrasCheck = checkAfterWrite(
            opId,
            () => keyExtrasMismatches(extras, keysUpdated, afterSnap.result),
            (failure) => ({ mismatches: [failure], unverified: [] as string[] })
          );
          // A curve combined with temporal continuous / auto bezier is recomputed by AE, so its sides cannot be compared.
          let baseMismatches: ReceiptMismatch[];
          if (curvePlan) {
            baseMismatches = skipEaseCheck
              ? []
              : curveEaseMismatches(
                  curvePlan.sides.filter((s) => !rovingSkipKeys(writeResp.result).includes(s.key)),
                  afterSnap.result
                );
          } else {
            baseMismatches = rovingMismatches(writeResp.result?.roving, afterSnap.result);
          }
          const extrasResult = writeResp.result?.extras as { roving_failed?: number[] } | undefined;
          const rovingFailed = Array.isArray(extrasResult?.roving_failed) ? extrasResult!.roving_failed! : [];
          const notes: string[] = [];
          if (skipEaseCheck && args.ease !== undefined) {
            notes.push("The ease was not checked on the read-back: temporal continuous / auto bezier recompute the other side of each key.");
          }
          if (rovingFailed.length > 0) notes.push(`After Effects would not rove key${rovingFailed.length === 1 ? "" : "s"} ${rovingFailed.join(", ")}.`);

          const receipt = buildReceipt({
            before: beforeSnap.result,
            after: afterSnap.result,
            expected: easeCheck?.expected,
            actualForExpected: easeCheck?.actual,
            customMismatches: [...baseMismatches, ...extrasCheck.mismatches],
          });

          return {
            op_id: opId,
            applied: true as const,
            result: writeResp.result,
            ...(curvePlan
              ? {
                  curve: args.ease,
                  segments: curvePlan.segments,
                  ...(curvePlan.warnings.length > 0 ? { warnings: curvePlan.warnings } : {}),
                }
              : {}),
            ...(args.keys === "selected" ? { keys_resolved: targetKeys } : {}),
            ...(extrasCheck.unverified.length > 0 ? { unverified: extrasCheck.unverified } : {}),
            ...(notes.length > 0 ? { notes } : {}),
            checkpoint,
            receipt,
          };
        });
      } catch (err) {
        if (err instanceof QueueWaitError) {
          throw new BridgeError({
            kind: "queued",
            op_id: opId,
            message: err.message,
          });
        }
        throw err;
      }
    },
  },
  {
    name: "ae_set_text",
    description:
      "Update a text layer's string and/or character/paragraph styling (`font`, `fontSize`, `tracking`, `leading`, `fillColor`, `strokeColor`, `strokeWidth`, `applyFill`, `applyStroke`, `justification`) via a guarded TextDocument round-trip in one undo group, re-asserting justification if AE's TextDocument round-trip drops it, and verifying via a separate read-back evalScript. " +
      "`ranges` styles single words or characters ('make NOW bold and red': `{ match: 'NOW', style: { fauxBold: true, fillColor: [1, 0, 0] } }`) on AE 24.3+, each range read back separately; `paragraphs` does the same for whole paragraphs by index or by a word they contain. " +
      "Typography in `style` (AE 24.0+): `caps` (normal, small, all, all_small), `baseline` (normal, superscript, subscript), `kerning` (metrics, optical, none, or a number that switches auto kerning off), ligature, no_break, horizontal_scale, vertical_scale, tsume, stroke_over_fill, line_join, auto_leading, digit_set, baseline_direction, line_orientation (24.2), faux_bold, faux_italic. " +
      "`paragraph` (whole document): justify including the full-justify variants, space_before, space_after, first_line_indent, start_indent, end_indent, every_line_composer, hanging_roman, auto_hyphenate, leading_type, direction (ltr or rtl), composer. " +
      "`box` (AE 24.6+, box text only; refused on point text): size, position, vertical_align, auto_fit (needs vertical_align top; a height auto_fit can't be combined with size, and a layer that already has a height auto_fit refuses size), inset, first_baseline, first_baseline_min; a new size rewraps the text, so the result's `layout` measures it before and after. " +
      "Every option is checked against the document before the undo group opens, so an older After Effects refuses with the version it needs and nothing is written; the read-back compares each option by name and treats values AE reports as mixed as unknown (listed under `unverified`), never as a mismatch. Reads reflect the first character only. " +
      "`font` takes a PostScript name, {postscript} or {family, style}: on AE 24+ it is looked up first, an unknown font is refused with the near matches (allow_substitute: true writes the name anyway) and a substituted font is a receipt mismatch; glyph coverage of the new text is checked and a missing glyph (Turkish ş ğ ı İ) is a warning. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeSetTextSchema,
    handler: async (args, ctx) => {
      ctx.quarantine.assertClear();
      const opId = ctx.bridge.newOpId();
      const label = `ae_set_text(comp ${args.comp_id})`;
      const rich = usesTypedText(args);
      const effectiveExpect: ExpectGuard = {
        project_path: args.expect.project_path,
        comp_id: args.expect.comp_id ?? args.comp_id,
      };

      try {
        return await ctx.queue.run(label, async () => {
          ctx.quarantine.assertClear();

          const guard = await verifyTargetGuard(ctx, effectiveExpect, opId);
          const checkpoint = await autoCheckpoint(ctx, guard, "ae_set_text");

          const beforeSnap = await ctx.bridge.evalRaw<Record<string, unknown>>({
            id: `${opId}_before`,
            script: buildJsxCall("getTextDocument", {
              comp_id: args.comp_id,
              layer: args.layer,
              ...(rich ? { typography: true, measure: true } : {}),
            }),
            label: `${label} (before)`,
            mutates: false,
            toolName: "ae_set_text",
          });

          const writeResp = await ctx.bridge.evalRaw<Record<string, unknown>>({
            id: opId,
            script: buildJsxCall("setText", {
              comp_id: args.comp_id,
              layer: args.layer,
              text: args.text,
              style: args.style,
              paragraph: args.paragraph,
              box: args.box,
              ranges: args.ranges,
              paragraphs: args.paragraphs,
              allow_substitute: args.allow_substitute,
              expect: effectiveExpect,
            }),
            label,
            mutates: true,
            toolName: "ae_set_text",
          });

          // The ranges the host styled (a `match` becomes offsets there), to read back one by one.
          const appliedRanges = resolvedRanges(writeResp.result);

          // Separate evalScript for read-back. The write is applied from here
          // on, so a failed read is reported, never thrown.
          const afterRead = await readAfterWrite(opId, () =>
            ctx.bridge.evalRaw<Record<string, unknown>>({
              id: `${opId}_after`,
              script: buildJsxCall("getTextDocument", {
                comp_id: args.comp_id,
                layer: args.layer,
                ...(rich ? { typography: true, measure: true } : {}),
                ...(appliedRanges.length > 0 ? { ranges: appliedRanges.map((r) => ({ start: r.start, end: r.end })) } : {}),
              }),
              label: `${label} (after)`,
              mutates: false,
              toolName: "ae_set_text",
            })
          );
          if (afterRead.failure) {
            return {
              op_id: opId,
              applied: true as const,
              result: writeResp.result,
              checkpoint,
              receipt: buildReceipt({ before: beforeSnap.result, after: null, customMismatches: [afterRead.failure] }),
            };
          }
          const afterSnap = afterRead.value!;

          const beforeObj = (beforeSnap.result ?? {}) as Record<string, unknown>;
          const beforeDoc =
            beforeObj.document && typeof beforeObj.document === "object"
              ? (beforeObj.document as Record<string, unknown>)
              : beforeObj;

          const afterObj = (afterSnap.result ?? {}) as Record<string, unknown>;
          const afterDoc =
            afterObj.document && typeof afterObj.document === "object"
              ? (afterObj.document as Record<string, unknown>)
              : afterObj;

          const expectedCheck: Record<string, unknown> = {};
          const actualCheck: Record<string, unknown> = {};

          if (args.text !== undefined) {
            expectedCheck.text = args.text;
            actualCheck.text = afterDoc.text;
          }

          if (args.style) {
            const styleKeys: Array<keyof TextStyleInput> = [
              "font",
              "fontSize",
              "tracking",
              "leading",
              "fillColor",
              "strokeColor",
              "strokeWidth",
              "applyFill",
              "applyStroke",
              "justification",
            ];
            // afterDoc reads the first character; a range starting at 0 that sets the
            // same field (or its fill/stroke group) is verified by its own read-back.
            for (const key of styleKeys) {
              if (args.style[key] !== undefined && !coveredByFirstRange(key as string, appliedRanges)) {
                if (key === "font") {
                  // The name AE was given: the resolved PostScript name (a {family, style} or a mis-cased name resolves).
                  const resolvedFont = (writeResp.result as { fonts?: { document?: { postscript?: unknown } } } | undefined)?.fonts?.document?.postscript;
                  const given = typeof args.style.font === "string" ? args.style.font : undefined;
                  const want = typeof resolvedFont === "string" ? resolvedFont : given;
                  if (want !== undefined) {
                    expectedCheck.font = want;
                    actualCheck.font = afterDoc.font;
                  }
                } else {
                  expectedCheck[key] = args.style[key];
                  actualCheck[key] = afterDoc[key];
                }
              }
            }
          }

          // Typography, paragraph and box options, by name, from the typed block of the read-back.
          const typed = checkAfterWrite(
            opId,
            () => typedTextChecks((writeResp.result as { set?: unknown } | undefined)?.set, args.paragraph?.justify, afterObj, [
                ...(coveredByFirstRange("fauxBold", appliedRanges) ? ["typography.faux_bold"] : []),
                ...(coveredByFirstRange("fauxItalic", appliedRanges) ? ["typography.faux_italic"] : []),
              ]),
            (failure) => ({ expected: {} as Record<string, unknown>, actual: {} as Record<string, unknown>, unverified: [] as string[], failure })
          );
          Object.assign(expectedCheck, typed.expected);
          Object.assign(actualCheck, typed.actual);
          const extraMismatches: ReceiptMismatch[] = [];
          if ("failure" in typed && typed.failure) extraMismatches.push(typed.failure as ReceiptMismatch);

          // A font After Effects substituted passes a plain name check; the fontObject says so.
          const hostWarnings = (writeResp.result as { warnings?: unknown } | undefined)?.warnings;
          const warnings: string[] = Array.isArray(hostWarnings) ? (hostWarnings as string[]).slice() : [];
          const fontObject = afterDoc.fontObject as { is_substitute?: boolean; postscript?: string } | undefined;
          if (args.style?.font !== undefined && fontObject?.is_substitute === true) {
            if (args.allow_substitute) {
              warnings.push(`After Effects substitutes the font (${String(fontObject.postscript ?? "unknown")} is not installed), as allow_substitute allowed.`);
            } else {
              extraMismatches.push({
                path: "font",
                expected: "an installed font",
                actual: "substituted",
                message: "After Effects reports the font as a substitute (fontObject.isSubstitute): it is not installed, so the text renders in a fallback font.",
              });
            }
          }

          // Only the ranges the read-back returned are compared; a shorter list is
          // also a receipt mismatch (below) and counted as unverified.
          const readBackRanges = Array.isArray(afterObj.ranges) ? (afterObj.ranges as unknown[]) : [];
          const verifiedRanges = appliedRanges.slice(0, readBackRanges.length);
          const unverifiedRanges = appliedRanges.length - verifiedRanges.length;
          Object.assign(expectedCheck, rangeExpectations(verifiedRanges));
          Object.assign(actualCheck, rangeActuals(verifiedRanges, afterObj.ranges));

          // If justification was not explicitly changed, verify the round-trip preserved existing justification
          if (
            expectedCheck.justification === undefined &&
            args.paragraph?.justify === undefined &&
            typeof beforeDoc.justification === "string" &&
            typeof afterDoc.justification === "string"
          ) {
            expectedCheck.justification = beforeDoc.justification;
            actualCheck.justification = afterDoc.justification;
          }

          const receipt = buildReceipt({
            before: beforeSnap.result,
            after: afterSnap.result,
            expected:
              Object.keys(expectedCheck).length > 0 ? expectedCheck : undefined,
            actualForExpected:
              Object.keys(expectedCheck).length > 0 ? actualCheck : undefined,
            // The host reads back every range or throws, so a short list is a wrong read-back.
            customMismatches: [
              ...(unverifiedRanges > 0
                ? [
                    {
                      path: "ranges",
                      expected: appliedRanges.length,
                      actual: readBackRanges.length,
                      message: "The read-back returned fewer ranges than were written; the rest were not checked",
                    },
                  ]
                : []),
              ...extraMismatches,
            ],
          });

          const layout = rich ? { before: beforeObj.measure ?? null, after: afterObj.measure ?? null, rewrapped: layoutChanged(beforeObj.measure, afterObj.measure) } : undefined;

          return {
            op_id: opId,
            applied: true as const,
            result: writeResp.result,
            checkpoint,
            receipt,
            ...(unverifiedRanges > 0 ? { unverified_ranges: unverifiedRanges } : {}),
            ...(typed.unverified.length > 0 ? { unverified: typed.unverified } : {}),
            ...(layout ? { layout } : {}),
            ...(warnings.length > 0 ? { warnings } : {}),
          };
        });
      } catch (err) {
        if (err instanceof QueueWaitError) {
          throw new BridgeError({
            kind: "queued",
            op_id: opId,
            message: err.message,
          });
        }
        throw err;
      }
    },
  },
  {
    name: "ae_import_footage",
    description:
      "Import one or more footage files (or an image sequence, in numbered order with placeholders for missing frames) into the project and optional target folder, guarded by `expect`, within one undo group, returning the new project `item_ids` and a separate read-back receipt. " +
      "`import_as` builds a comp from a layered file (PSD, AI): 'comp' or 'comp_cropped_layers', or a whole project ('project'); ImportOptions.canImportAs is checked first and a file that cannot be imported that way is refused, listing what it allows. The result returns new_comp_ids, new_folder_ids, main_comp_id and created_folder_id, and target_folder_id receives the top created items. " +
      "`range` {start, end} imports part of a numbered sequence; `placeholders` [{name, width, height, fps, duration}] create placeholders for missing footage. Importing a project or an older file can raise dialogs (missing fonts or footage, conversion): they are never suppressed, so read them with ae_dialogs. ae_import_assets is a separate importer. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeImportFootageSchema,
    handler: async (args, ctx) => {
      ctx.quarantine.assertClear();
      const opId = ctx.bridge.newOpId();
      const fileCount = (args.paths?.length ?? 0) + (args.placeholders?.length ?? 0);
      const label = `ae_import_footage(${fileCount} file${fileCount === 1 ? "" : "s"})`;

      try {
        return await ctx.queue.run(label, async () => {
          ctx.quarantine.assertClear();

          const guard = await verifyTargetGuard(ctx, args.expect, opId);
          const checkpoint = await autoCheckpoint(ctx, guard, "ae_import_footage");

          const beforeSnap = await ctx.bridge.evalRaw<Record<string, unknown>>({
            id: `${opId}_before`,
            script: buildJsxCall("getFootageItems", {}),
            label: `${label} (before)`,
            mutates: false,
            toolName: "ae_import_footage",
          });

          const writeResp = await ctx.bridge.evalRaw<Record<string, unknown>>({
            id: opId,
            script: buildJsxCall("importFootage", {
              paths: args.paths,
              sequence: Boolean(args.sequence),
              fps: args.fps,
              target_folder_id: args.target_folder_id,
              ...(args.import_as !== undefined ? { import_as: args.import_as } : {}),
              ...(args.range !== undefined ? { range: args.range } : {}),
              ...(args.force_alphabetical !== undefined ? { force_alphabetical: args.force_alphabetical } : {}),
              ...(args.placeholders !== undefined ? { placeholders: args.placeholders } : {}),
              expect: args.expect,
            }),
            label,
            timeoutMs: SLOW_TIMEOUT_MS,
            mutates: true,
            toolName: "ae_import_footage",
          });

          const itemIds: number[] = Array.isArray(writeResp.result?.item_ids)
            ? (writeResp.result.item_ids as number[])
            : [];

          // import_as comp / project also creates comps and folders: those are read back too (capped like every list).
          const createdIds = createdItemIds(writeResp.result);
          const readIds = createdIds.length > 0 ? createdIds : itemIds;
          const createdExtras = importCreatedFields(writeResp.result);

          // Separate evalScript for read-back. The write is applied from here
          // on, so a failed read is reported, never thrown.
          const afterRead = await readAfterWrite(opId, () =>
            ctx.bridge.evalRaw<Record<string, unknown>>({
              id: `${opId}_after`,
              script: buildJsxCall("getFootageItems", {
                item_ids: readIds,
              }),
              label: `${label} (after)`,
              mutates: false,
              toolName: "ae_import_footage",
            })
          );
          if (afterRead.failure) {
            return {
              op_id: opId,
              applied: true as const,
              item_ids: itemIds,
              items: Array.isArray(writeResp.result?.items) ? writeResp.result.items : [],
              ...createdExtras,
              result: writeResp.result,
              checkpoint,
              receipt: buildReceipt({ before: beforeSnap.result, after: null, customMismatches: [afterRead.failure] }),
            };
          }
          const afterSnap = afterRead.value!;

          const afterIds: number[] = Array.isArray(afterSnap.result?.item_ids)
            ? (afterSnap.result.item_ids as number[])
            : [];

          const receipt = buildReceipt({
            before: beforeSnap.result,
            after: afterSnap.result,
            expected: {
              count: createdIds.length > 0 ? readIds.length : fileCount,
              item_ids: readIds,
            },
            actualForExpected: {
              count: afterIds.length,
              item_ids: afterIds,
            },
          });

          return {
            op_id: opId,
            applied: true as const,
            item_ids: itemIds,
            items: Array.isArray(writeResp.result?.items)
              ? writeResp.result.items
              : [],
            ...createdExtras,
            result: writeResp.result,
            checkpoint,
            receipt,
          };
        });
      } catch (err) {
        if (err instanceof QueueWaitError) {
          throw new BridgeError({
            kind: "queued",
            op_id: opId,
            message: err.message,
          });
        }
        throw err;
      }
    },
  },
  {
    name: "ae_replace_footage",
    description:
      "Replace or relink an existing FootageItem using `FootageItem.replace` or `FootageItem.replaceWithSequence` within one undo group, guarded by `expect`, returning the before and after file paths, `footageMissing`, and a separate read-back receipt. " +
      "With `action: 'reload'` (and item_ids, item_id or folder_id) it reloads the main file source of footage items after the files changed on disk (FileSource.reload; proxies in use and non-file sources are refused or skipped) and a separate read-back lists the items whose size, duration or frame rate changed, since content in comps may move. " +
      "Solid colour, size and name changes are ae_layer_ops solid_settings, not this tool. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeReplaceFootageSchema,
    handler: async (args, ctx) => {
      if (args.action === "reload") return reloadFootage(args, ctx);
      ctx.quarantine.assertClear();
      const opId = ctx.bridge.newOpId();
      const label = `ae_replace_footage(${args.item_id})`;

      try {
        return await ctx.queue.run(label, async () => {
          ctx.quarantine.assertClear();

          const guard = await verifyTargetGuard(ctx, args.expect, opId);
          const checkpoint = await autoCheckpoint(ctx, guard, "ae_replace_footage");

          const beforeSnap = await ctx.bridge.evalRaw<Record<string, unknown>>({
            id: `${opId}_before`,
            script: buildJsxCall("getFootageItem", {
              item_id: args.item_id,
            }),
            label: `${label} (before)`,
            mutates: false,
            toolName: "ae_replace_footage",
          });

          const writeResp = await ctx.bridge.evalRaw<Record<string, unknown>>({
            id: opId,
            script: buildJsxCall("replaceFootage", {
              item_id: args.item_id,
              path: args.path,
              sequence: Boolean(args.sequence),
              expect: args.expect,
            }),
            label,
            timeoutMs: SLOW_TIMEOUT_MS,
            mutates: true,
            toolName: "ae_replace_footage",
          });

          // Separate evalScript for read-back. The write is applied from here
          // on, so a failed read is reported, never thrown.
          const afterRead = await readAfterWrite(opId, () =>
            ctx.bridge.evalRaw<Record<string, unknown>>({
              id: `${opId}_after`,
              script: buildJsxCall("getFootageItem", {
                item_id: args.item_id,
              }),
              label: `${label} (after)`,
              mutates: false,
              toolName: "ae_replace_footage",
            })
          );
          if (afterRead.failure) {
            return {
              op_id: opId,
              applied: true as const,
              item_id: args.item_id,
              result: writeResp.result,
              checkpoint,
              receipt: buildReceipt({ before: beforeSnap.result, after: null, customMismatches: [afterRead.failure] }),
            };
          }
          const afterSnap = afterRead.value!;

          const beforeObj = (beforeSnap.result ?? {}) as Record<string, unknown>;
          const writeObj = (writeResp.result ?? {}) as Record<string, unknown>;
          const afterObj = (afterSnap.result ?? {}) as Record<string, unknown>;

          const beforeFile =
            typeof beforeObj.file === "string"
              ? beforeObj.file
              : typeof writeObj.before_file === "string"
              ? writeObj.before_file
              : null;

          const beforeMissing =
            typeof beforeObj.footageMissing === "boolean"
              ? beforeObj.footageMissing
              : typeof writeObj.before_footage_missing === "boolean"
              ? writeObj.before_footage_missing
              : false;

          const afterFile =
            typeof afterObj.file === "string"
              ? afterObj.file
              : typeof writeObj.requested_path === "string"
              ? writeObj.requested_path
              : null;

          const afterMissing =
            typeof afterObj.footageMissing === "boolean"
              ? afterObj.footageMissing
              : false;

          const receipt = buildReceipt({
            before: beforeSnap.result,
            after: afterSnap.result,
            expected: {
              file: normalizeGuardPath(args.path),
              footageMissing: false,
            },
            actualForExpected: {
              file:
                typeof afterFile === "string"
                  ? normalizeGuardPath(afterFile)
                  : null,
              footageMissing: afterMissing,
            },
          });

          return {
            op_id: opId,
            applied: true as const,
            item_id: args.item_id,
            before_path: beforeFile,
            after_path: afterFile,
            before_file: beforeFile,
            after_file: afterFile,
            before_footage_missing: beforeMissing,
            footageMissing: afterMissing,
            result: writeResp.result,
            checkpoint,
            receipt,
          };
        });
      } catch (err) {
        if (err instanceof QueueWaitError) {
          throw new BridgeError({
            kind: "queued",
            op_id: opId,
            message: err.message,
          });
        }
        throw err;
      }
    },
  },
];
