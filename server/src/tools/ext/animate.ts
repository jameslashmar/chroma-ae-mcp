/**
 * server/src/tools/ext/animate.ts
 *
 * Guarded mutating tools for Task G3 "animate":
 * - ae_set_keyframe_ease
 * - ae_set_text
 * - ae_import_footage
 * - ae_replace_footage
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
  BezierCurveSchema,
  ExpectSchema,
  LayerSelectorSchema,
  type ExpectGuard,
  type ToolDefinition,
} from "../common.js";
import { autoCheckpoint, verifyTargetGuard } from "../mutate.js";

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

export const KeyframeEaseCurveSchema = z.object({
  curve: BezierCurveSchema.describe(
    "cubic-bezier [x1, y1, x2, y2] as in CSS: x is time and y is progress across one segment, both 0..1. y may leave 0..1 for anticipation or overshoot (not on spatial properties such as Position, whose speed cannot go negative)."
  ),
});

export const KeyframeEaseInputSchema = z
  .union([KeyframeEasePresetSchema, KeyframeEasePairSchema, KeyframeEaseCurveSchema])
  .describe(
    'A preset ("easy_ease", "linear", or "hold"), an explicit `{ in: { speed, influence }, out: { speed, influence } }` object, or `{ curve: [x1, y1, x2, y2] }`. ' +
      "A curve shapes each segment between neighbouring keys in `keys` (all keys by default): it sets the out ease of the segment's first key and the in ease of its last, from that segment's duration and distance, and leaves every other side alone."
  );

export type KeyframeEaseInput = z.infer<typeof KeyframeEaseInputSchema>;

export const AeSetKeyframeEaseSchema = z.object({
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
    .array(z.number().int().positive())
    .optional()
    .describe(
      "Optional 1-based keyframe indices to update. Defaults to all keyframes on the property."
    ),
  ease: KeyframeEaseInputSchema,
  expect: ExpectSchema,
});

export function clampInfluenceValue(influence: number): number {
  if (influence < 0.1) return 0.1;
  if (influence > 100) return 100;
  return influence;
}

export function extractKeyframeEaseCheck(
  ease: KeyframeEaseInput,
  requestedKeys: number[] | undefined,
  afterSnapshot: unknown
): { expected: unknown; actual: unknown } | null {
  if (!afterSnapshot || typeof afterSnapshot !== "object" || isCurveEase(ease)) {
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
  const targeted = keySet
    ? rawKeys.filter(
        (kf) => typeof kf.keyIndex === "number" && keySet.has(kf.keyIndex)
      )
    : rawKeys;

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
const MIN_HANDLE = 0.001;

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

export const TextStyleSchema = z
  .object({
    font: z
      .string()
      .min(1)
      .optional()
      .describe("PostScript font name (e.g. 'Inter-Bold' or 'ArialMT')."),
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
      .describe("Line leading in pixels."),
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
      "Paragraph justification: 'left', 'center', or 'right'."
    ),
  })
  .describe("Optional TextDocument styling properties to update.");

export type TextStyleInput = z.infer<typeof TextStyleSchema>;

function hasAnyStyleField(style: TextStyleInput | undefined): boolean {
  if (!style) return false;
  return (
    style.font !== undefined ||
    style.fontSize !== undefined ||
    style.tracking !== undefined ||
    style.leading !== undefined ||
    style.fillColor !== undefined ||
    style.strokeColor !== undefined ||
    style.strokeWidth !== undefined ||
    style.applyFill !== undefined ||
    style.applyStroke !== undefined ||
    style.justification !== undefined
  );
}

export const AeSetTextSchema = z
  .object({
    comp_id: z.number().int().describe("Target CompItem ID."),
    layer: LayerSelectorSchema,
    text: z
      .string()
      .optional()
      .describe("New text string to set on the TextLayer's Source Text."),
    style: TextStyleSchema.optional(),
    expect: ExpectSchema,
  })
  .refine((val) => val.text !== undefined || hasAnyStyleField(val.style), {
    message:
      "ae_set_text requires at least `text` or one defined property in `style`.",
  });

// ---------- 3. ae_import_footage ----------

export const AeImportFootageSchema = z.object({
  paths: z
    .array(z.string().min(1))
    .min(1)
    .max(500)
    .describe("Absolute file paths of footage files to import."),
  sequence: z
    .boolean()
    .optional()
    .describe(
      "If true, import as an image sequence with ImportOptions.forceAlphabetical = true."
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
      "Optional FolderItem ID in the project to place the imported items into."
    ),
  expect: ExpectSchema,
});

// ---------- 4. ae_replace_footage ----------

export const AeReplaceFootageSchema = z.object({
  item_id: z
    .number()
    .int()
    .describe("Project FootageItem ID to replace."),
  path: z
    .string()
    .min(1)
    .describe(
      "Absolute file path to the replacement footage file (or first frame of a sequence)."
    ),
  sequence: z
    .boolean()
    .optional()
    .describe(
      "If true, use FootageItem.replaceWithSequence(file, true); otherwise use FootageItem.replace(file)."
    ),
  expect: ExpectSchema,
});

// ---------- Tool definitions ----------

export const animateTools: ToolDefinition<any>[] = [
  {
    name: "ae_set_keyframe_ease",
    description:
      "Set temporal keyframe easing and interpolation on a keyframed layer property within a single undo group, guarded by `expect`, and verified by a separate read-back evalScript receipt. " +
      "Supports presets ('easy_ease', 'linear', 'hold'), explicit `{ in: { speed, influence }, out: { speed, influence } }` (matched to the property's temporal ease dimension count), or `{ curve: [x1, y1, x2, y2] }`, a CSS-style cubic-bezier applied to each segment between neighbouring keys, such as one the user picked with ae_ask_user. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeSetKeyframeEaseSchema,
    handler: async (args, ctx) => {
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

          // A curve becomes per-key sides here, from the keys' times and values.
          const curvePlan = isCurveEase(args.ease)
            ? curveToSides(beforeSnap.result, args.keys, args.ease.curve)
            : null;

          const writeResp = await ctx.bridge.evalRaw<Record<string, unknown>>({
            id: opId,
            script: curvePlan
              ? buildJsxCall("setKeyframeEaseSides", {
                  comp_id: args.comp_id,
                  layer: args.layer,
                  path: args.path,
                  sides: curvePlan.sides,
                  expect: effectiveExpect,
                })
              : buildJsxCall("setKeyframeEase", {
                  comp_id: args.comp_id,
                  layer: args.layer,
                  path: args.path,
                  keys: args.keys,
                  ease: args.ease,
                  expect: effectiveExpect,
                }),
            label,
            mutates: true,
            toolName: "ae_set_keyframe_ease",
          });

          // Separate evalScript for read-back
          const afterSnap = await ctx.bridge.evalRaw<Record<string, unknown>>({
            id: `${opId}_after`,
            script: buildJsxCall("getKeyframeEase", {
              comp_id: args.comp_id,
              layer: args.layer,
              path: args.path,
            }),
            label: `${label} (after)`,
            mutates: false,
            toolName: "ae_set_keyframe_ease",
          });

          const easeCheck = extractKeyframeEaseCheck(
            args.ease,
            args.keys,
            afterSnap.result
          );

          const receipt = buildReceipt({
            before: beforeSnap.result,
            after: afterSnap.result,
            expected: easeCheck?.expected,
            actualForExpected: easeCheck?.actual,
            customMismatches: curvePlan
              ? curveEaseMismatches(curvePlan.sides, afterSnap.result)
              : undefined,
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
      AGENT_SAFETY_GUIDANCE,
    schema: AeSetTextSchema,
    handler: async (args, ctx) => {
      ctx.quarantine.assertClear();
      const opId = ctx.bridge.newOpId();
      const label = `ae_set_text(comp ${args.comp_id})`;
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
              expect: effectiveExpect,
            }),
            label,
            mutates: true,
            toolName: "ae_set_text",
          });

          // Separate evalScript for read-back
          const afterSnap = await ctx.bridge.evalRaw<Record<string, unknown>>({
            id: `${opId}_after`,
            script: buildJsxCall("getTextDocument", {
              comp_id: args.comp_id,
              layer: args.layer,
            }),
            label: `${label} (after)`,
            mutates: false,
            toolName: "ae_set_text",
          });

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
            for (const key of styleKeys) {
              if (args.style[key] !== undefined) {
                expectedCheck[key] = args.style[key];
                actualCheck[key] = afterDoc[key];
              }
            }
          }

          // If justification was not explicitly changed, verify the round-trip preserved existing justification
          if (
            expectedCheck.justification === undefined &&
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
          });

          return {
            op_id: opId,
            applied: true as const,
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
    name: "ae_import_footage",
    description:
      "Import one or more footage files (or an image sequence with `ImportOptions.forceAlphabetical = true`) into the project and optional target folder, guarded by `expect`, within one undo group, returning the new project `item_ids` and a separate read-back receipt. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeImportFootageSchema,
    handler: async (args, ctx) => {
      ctx.quarantine.assertClear();
      const opId = ctx.bridge.newOpId();
      const label = `ae_import_footage(${args.paths.length} file${
        args.paths.length === 1 ? "" : "s"
      })`;

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

          // Separate evalScript for read-back
          const afterSnap = await ctx.bridge.evalRaw<Record<string, unknown>>({
            id: `${opId}_after`,
            script: buildJsxCall("getFootageItems", {
              item_ids: itemIds,
            }),
            label: `${label} (after)`,
            mutates: false,
            toolName: "ae_import_footage",
          });

          const afterIds: number[] = Array.isArray(afterSnap.result?.item_ids)
            ? (afterSnap.result.item_ids as number[])
            : [];

          const receipt = buildReceipt({
            before: beforeSnap.result,
            after: afterSnap.result,
            expected: {
              count: args.paths.length,
              item_ids: itemIds,
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
      AGENT_SAFETY_GUIDANCE,
    schema: AeReplaceFootageSchema,
    handler: async (args, ctx) => {
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

          // Separate evalScript for read-back
          const afterSnap = await ctx.bridge.evalRaw<Record<string, unknown>>({
            id: `${opId}_after`,
            script: buildJsxCall("getFootageItem", {
              item_id: args.item_id,
            }),
            label: `${label} (after)`,
            mutates: false,
            toolName: "ae_replace_footage",
          });

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
