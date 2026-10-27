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
import { buildReceipt } from "../../receipts.js";
import {
  AGENT_SAFETY_GUIDANCE,
  ExpectSchema,
  LayerSelectorSchema,
  type ExpectGuard,
  type ToolDefinition,
} from "../common.js";
import { verifyTargetGuard } from "../mutate.js";

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

export const KeyframeEaseInputSchema = z
  .union([KeyframeEasePresetSchema, KeyframeEasePairSchema])
  .describe(
    'Either a preset ("easy_ease", "linear", or "hold") or an explicit `{ in: { speed, influence }, out: { speed, influence } }` object.'
  );

export type KeyframeEaseInput = z.infer<typeof KeyframeEaseInputSchema>;

export const AeSetKeyframeEaseSchema = z.object({
  comp_id: z.number().int().describe("Target CompItem ID."),
  layer: LayerSelectorSchema,
  path: z
    .array(z.string().min(1))
    .min(1)
    .describe(
      "Property path from the layer root (e.g. ['ADBE Transform Group', 'ADBE Position'] or ['Transform', 'Opacity'])."
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
  if (!afterSnapshot || typeof afterSnapshot !== "object") {
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
      "Supports presets ('easy_ease', 'linear', 'hold') or explicit `{ in: { speed, influence }, out: { speed, influence } }`, automatically matching the property's temporal ease dimension count. " +
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

          await verifyTargetGuard(ctx, effectiveExpect, opId);

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

          const writeResp = await ctx.bridge.evalRaw<Record<string, unknown>>({
            id: opId,
            script: buildJsxCall("setKeyframeEase", {
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
          });

          return {
            op_id: opId,
            applied: true as const,
            result: writeResp.result,
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

          await verifyTargetGuard(ctx, effectiveExpect, opId);

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

          await verifyTargetGuard(ctx, args.expect, opId);

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

          await verifyTargetGuard(ctx, args.expect, opId);

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
