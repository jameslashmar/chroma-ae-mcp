/**
 * server/src/tools/ext/explain.ts
 *
 * Explain tools: "why isn't this layer showing, or why does it look wrong".
 * - ae_explain_layer: read-only. A layer at a time, or a pixel on the frame,
 *   checked against every cause the DOM can show (switches, in/out, solo,
 *   opacity, mattes, masks, scale 0, expression errors, missing footage, time
 *   remap, off canvas, behind the camera, adjustment layers above, the precomp
 *   it plays), ranked and backed by evidence.
 * - ae_explain_layer_proof: opt-in pixel proof. Duplicates the comp, undoes the
 *   suspect in the copy, renders both, diffs them, and removes the copy. It
 *   writes to the project (a guarded write with a receipt), in two undo groups:
 *   the renders sit between them.
 *
 * Not built, because AE has no API for them: a parent's opacity (parenting
 * passes transform, never opacity), a camera clipping plane, a failing
 * effect or missing plug-in (only effect switches and expressionError are
 * readable), and shy as a cause of "not rendering" (it only hides the layer in
 * the Timeline panel, so it is reported as info).
 */

import * as fs from "node:fs";
import { z } from "zod";
import { BridgeError } from "../../host.js";
import { buildJsxCall } from "../../jsx.js";
import { QueueWaitError } from "../../queue.js";
import { buildReceipt, type ReceiptMismatch } from "../../receipts.js";
import {
  AGENT_SAFETY_GUIDANCE,
  ExpectSchema,
  LayerSelectorSchema,
  type ToolContext,
  type ToolDefinition,
} from "../common.js";
import { autoCheckpoint, verifyTargetGuard } from "../mutate.js";
import { readAfterWrite } from "../read-back.js";
import { defaultFramesDir } from "../render.js";
import { compareDecodedFrames, captureCompFrame, decodePngFile } from "./frames.js";
import { beginInflight, endInflight, noteAfterWrite, noteBeforeWrite } from "./session.js";
import { expectThat } from "./write-runner.js";

// ---------- schemas ----------

export const SUSPECTS = ["enabled", "solo", "opacity", "track_matte", "masks", "layers_above", "adjustment_above"] as const;
export type Suspect = (typeof SUSPECTS)[number];

export const AeExplainLayerSchema = z
  .object({
    comp_id: z.number().int().describe("The composition the layer (or the pixel) is in."),
    layer: LayerSelectorSchema.optional().describe("The layer that does not show, or looks wrong. Give this, a point, or both."),
    point: z
      .array(z.number())
      .length(2)
      .optional()
      .describe(
        "A pixel [x, y] in comp pixels. Without a layer, lists the layers whose box holds it (top to bottom) and the first that renders. 3D layers are counted, not located, because their position depends on the camera."
      ),
    time: z
      .number()
      .min(0)
      .optional()
      .describe("Comp time in seconds to explain. Default: the comp's current time. Read without moving the time indicator."),
    inside: z
      .boolean()
      .optional()
      .describe("For a precomp layer, also check what is inside the nested comp at the time it plays (default true). The cause is often in there."),
  })
  .refine((v) => v.layer !== undefined || v.point !== undefined, { message: "Give a layer, a point, or both." });

export const AeExplainLayerProofSchema = z.object({
  comp_id: z.number().int().describe("The composition the layer is in."),
  layer: LayerSelectorSchema.describe("The layer that does not show."),
  suspect: z
    .enum(SUSPECTS)
    .describe(
      "The cause to test, undone in a COPY of the comp: enabled (video switch on), solo (solo the target in the copy too; the other layers keep their solo), opacity (a plain 0% to 100%), " +
        "track_matte (remove it), masks (all to None), layers_above (switch off every layer above, to test 'covered'), adjustment_above (switch off adjustment layers above). " +
        "Only the comp's top-level layers are changed: a duplicated comp shares its nested precomps with the original."
    ),
  time: z.number().min(0).optional().describe("Comp time in seconds to render. Default: the comp's current time."),
  threshold: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("A pixel counts as changed when a channel differs by more than this (0..1, default 0.02)."),
  expect: ExpectSchema,
});

export type ExplainArgs = z.infer<typeof AeExplainLayerSchema>;
export type ProofArgs = z.infer<typeof AeExplainLayerProofSchema>;

// ---------- the host's answer ----------

export type Severity = "blocks" | "likely" | "possible" | "info";

export interface ExplainFinding {
  id: string;
  severity: Severity;
  /** Ranks within a severity; lower first. */
  order: number;
  title: string;
  detail: string;
  evidence?: unknown;
  /** Added here: what to change. */
  fix?: string;
}

export interface PointCandidate {
  index: number;
  id: number;
  name: string;
  renders: boolean;
  reasons: string[];
}

export interface ExplainRaw {
  comp?: { id: number; name: string; width: number; height: number };
  time?: number;
  layer?: { index: number; id: number; name: string };
  facts?: Record<string, unknown>;
  findings?: ExplainFinding[];
  unchecked?: string[];
  inside?: Record<string, unknown>;
  at_point?: {
    point?: number[];
    candidates?: PointCandidate[];
    topmost_rendering?: number | null;
    unlocated_3d?: number;
    layer_covers_point?: boolean;
  };
  limits?: string[];
  [k: string]: unknown;
}

// ---------- ranking (pure) ----------

const SEVERITY_RANK: Record<Severity, number> = { blocks: 0, likely: 1, possible: 2, info: 3 };

/** What to change for each finding id, in plain words. */
export const FIX_HINTS: Record<string, string> = {
  no_picture: "Look at the layers this camera or light affects instead.",
  null_layer: "Null layers never render; parent the layer you expect to see, or use a solid or shape layer.",
  audio_only: "Use a layer with video.",
  disabled: "Switch the layer's video (eyeball) on.",
  outside_in_out: "Move the layer's in/out points or start time so the time falls inside them, or look at a time inside.",
  solo_elsewhere: "Clear the solo on the other layers, or solo this one.",
  opacity_zero: "Raise the layer's opacity (check keyframes and expressions on it).",
  opacity_low: "Raise the layer's opacity.",
  scale_zero: "Fix the Scale of the named layer (this layer or a parent).",
  guide_layer: "Turn off Guide Layer if it should render.",
  matte_empty: "Fix the matte layer (its in/out points and opacity), invert the matte, or remove it.",
  track_matte: "Check what the matte layer covers, or remove the matte.",
  blend_stencil: "Change the blend mode to Normal.",
  blend_mode: "Set the blend mode to Normal to see the layer plainly.",
  mask_empty: "Fix or delete the mask, or set it to None.",
  mask_opacity_zero: "Raise the mask opacity.",
  mask_inverted: "Un-invert the mask if the layer should show inside its shape.",
  effects_switch_off: "Turn the layer's fx switch on.",
  effect_disabled: "Switch the listed effects on.",
  expression_error: "Fix the expression (see ae_validate_expressions) or disable it.",
  footage_missing: "Relink the footage item.",
  time_remap_out_of_range: "Fix the Time Remap keyframes so they stay inside the source's length.",
  adjustment_above: "Disable or move the adjustment layer above, or limit it with a matte.",
  stencil_above: "Change the blend mode of the layer above, or move this layer above it.",
  covered_guess: "Move the covering layer, hide it, or confirm with ae_explain_layer_proof (suspect layers_above).",
  no_extent: "Give the layer something to draw (text, shape contents or a sized source).",
  off_canvas: "Move the layer into the frame (its Position or its parent's).",
  behind_camera: "Move the layer or the camera so the layer is in front of the lens.",
  precomp_time_outside: "Extend the nested comp, or change the precomp layer's start time or time remap.",
  precomp_empty: "Add layers to the nested comp, or use another comp.",
  precomp_nothing_active: "Open the nested comp: the listed layers are off, soloed away, or outside their in/out points at that time.",
  precomp_missing_footage: "Relink the missing footage inside the nested comp.",
};

export type Verdict = "hidden" | "probably_hidden_or_wrong" | "visible_with_possible_causes" | "no_cause_found" | "point_only";

export interface Ranked extends ExplainRaw {
  verdict: Verdict;
  headline: string;
  counts: Record<Severity, number>;
  findings: ExplainFinding[];
}

/** Sorts the host's findings by severity then order, adds the fix text, and writes the headline. */
export function rankExplanation(raw: ExplainRaw): Ranked {
  const list = Array.isArray(raw.findings) ? raw.findings : [];
  const findings = list
    .map((f) => ({ ...f, fix: FIX_HINTS[f.id] }))
    .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) || a.order - b.order);
  const counts: Record<Severity, number> = { blocks: 0, likely: 0, possible: 0, info: 0 };
  for (const f of findings) if (f.severity in counts) counts[f.severity]++;

  let verdict: Verdict;
  let headline: string;
  if (raw.layer === undefined) {
    verdict = "point_only";
    const at = raw.at_point;
    const top = at?.candidates?.find((c) => c.index === at.topmost_rendering);
    headline = top
      ? `The topmost layer that renders at that point is ${top.index} (${top.name}).`
      : (at?.candidates?.length ?? 0) > 0
        ? "Layers sit under that point, but none of them renders at this time."
        : "No 2D layer's box holds that point at this time.";
  } else if (counts.blocks > 0) {
    verdict = "hidden";
    headline = `Hidden: ${findings[0].title}.`;
  } else if (counts.likely > 0) {
    verdict = "probably_hidden_or_wrong";
    headline = `Probably the cause: ${findings[0].title}.`;
  } else if (counts.possible > 0) {
    verdict = "visible_with_possible_causes";
    headline = `Nothing stops it from rendering; it may look wrong because: ${findings[0].title}.`;
  } else {
    verdict = "no_cause_found";
    headline = "No cause found in the DOM. If it still does not show, confirm with ae_explain_layer_proof or look at the frame with ae_snapshot_frame.";
  }
  return { ...raw, verdict, headline, counts, findings };
}

// ---------- the proof (pure parts) ----------

export interface ProofDiff {
  changed_pixels: number;
  total_pixels: number;
  pct_pixels_changed: number;
  mean_abs_diff: number;
  max_diff: number;
  identical: boolean;
}

export type ProofVerdict = "confirmed" | "not_confirmed" | "inconclusive";

/** Suspects that change other layers' pixels too, so their diff is limited to the target's box. */
export const BOX_SUSPECTS: readonly Suspect[] = ["layers_above", "adjustment_above"];

export interface Region {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The target's comp-space box as pixel bounds in a rendered frame, or null when it has no area. */
export function regionToPixels(region: number[] | null | undefined, compSize: number[] | undefined, frame: { width: number; height: number }): Region | null {
  if (!region || region.length < 4 || !compSize || compSize.length < 2 || compSize[0] <= 0 || compSize[1] <= 0) return null;
  const sx = frame.width / compSize[0];
  const sy = frame.height / compSize[1];
  const x0 = Math.max(0, Math.floor(region[0] * sx));
  const y0 = Math.max(0, Math.floor(region[1] * sy));
  const x1 = Math.min(frame.width, Math.ceil(region[2] * sx));
  const y1 = Math.min(frame.height, Math.ceil(region[3] * sy));
  if (x1 <= x0 || y1 <= y0) return null;
  return { x0, y0, x1, y1 };
}

/** A copy of the part of an RGBA frame inside the region. */
export function cropFrame(png: { width: number; height: number; data: Buffer | Uint8Array }, r: Region): { width: number; height: number; data: Buffer } {
  const width = r.x1 - r.x0;
  const height = r.y1 - r.y0;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const from = ((r.y0 + y) * png.width + r.x0) * 4;
    Buffer.from(png.data.buffer, png.data.byteOffset + from, width * 4).copy(data, y * width * 4);
  }
  return { width, height, data };
}

/** What the diff of the two renders says about the suspect. `scope` is where the diff was taken. */
export function proofVerdict(
  suspect: Suspect,
  diff: ProofDiff | null,
  error?: string,
  scope: "frame" | "layer_box" = "frame"
): { verdict: ProofVerdict; explanation: string } {
  if (!diff) {
    return { verdict: "inconclusive", explanation: `The frames could not be compared${error ? ` (${error})` : ""}.` };
  }
  const where = scope === "layer_box" ? "inside the layer's box" : "in the frame";
  if (diff.changed_pixels > 0) {
    return {
      verdict: "confirmed",
      explanation: `Undoing "${suspect}" in a copy changes ${diff.pct_pixels_changed}% of the pixels ${where}, so it changes what shows${scope === "layer_box" ? " where the layer is" : ""}.`,
    };
  }
  return {
    verdict: "not_confirmed",
    explanation: `Undoing "${suspect}" in a copy changes no pixels ${where}, so undoing this cause alone does not make the layer show. Other causes may also hide it, or something else covers it (run ae_explain_layer to list them).`,
  };
}

export interface ProofState {
  num_items: number;
  comps: number;
  proof_comps: number;
}

/** The receipt's checks: the temporary comp must be gone and the project back to its item count. */
export function proofMismatches(
  before: unknown,
  after: unknown,
  cleanupError: string | null,
  copyId: number | undefined
): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  if (cleanupError) {
    m.push({
      path: "temp_comp",
      expected: "the temporary comp removed",
      actual: copyId,
      message: `The temporary comp (id ${copyId}) was not removed: ${cleanupError}. Delete it in the Project panel; its name starts with "chroma-explain-proof".`,
    });
  }
  const b = before as ProofState | null;
  const a = after as ProofState | null;
  if (b && a) {
    expectThat(m, a.proof_comps === b.proof_comps, "proof_comps", b.proof_comps, a.proof_comps, "A temporary proof comp is still in the project");
    expectThat(m, a.num_items === b.num_items, "num_items", b.num_items, a.num_items, "The project's item count changed");
  }
  return m;
}

// ---------- tools ----------

const errMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export const explainTools: ToolDefinition<any>[] = [
  {
    name: "ae_explain_layer",
    description:
      "Answer 'why isn't this layer showing, or why does it look wrong' with a ranked, evidence-backed list of causes, in one read. " +
      "Checks the layer at a time (default the comp's current time): video switch, in/out points, solo on other layers, its own opacity, a parent or itself scaled to 0, " +
      "audio-only/null/guide, empty or inverted masks, track mattes (an empty matte hides it), blend mode and stencils above, effect switches, expression errors, " +
      "missing footage, time remap past the source, 2D off-canvas or no extent, 3D behind the active camera, adjustment layers above, and (a guess) a plain opaque solid above. " +
      "For a precomp layer it also checks inside the nested comp at the time it plays. With `point` [x, y] it lists the layers under that pixel and the first that renders. " +
      "Each finding has a severity (blocks, likely, possible, info), evidence and a fix. `verdict` and `headline` summarise. " +
      "Limits, stated in the result: AE passes no opacity from a parent, has no camera clipping plane, and shows no effect or plug-in failure beyond expressionError, so those are not checked; shy only affects the Timeline panel (info). " +
      "Read-only: never moves the time indicator or changes selection, solo or the project. For pixel evidence use ae_explain_layer_proof. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeExplainLayerSchema,
    handler: async (args: ExplainArgs, ctx: ToolContext) => {
      const res = await ctx.bridge.callHost<ExplainRaw>(
        "explainLayer",
        { comp_id: args.comp_id, layer: args.layer, point: args.point, time: args.time, inside: args.inside },
        {
          label: `ae_explain_layer(${args.comp_id})`,
          mutates: false,
          toolName: "ae_explain_layer",
        }
      );
      return rankExplanation((res.result ?? {}) as ExplainRaw);
    },
  },
  {
    name: "ae_explain_layer_proof",
    description:
      "Pixel proof for one suspected cause: duplicate the comp, undo the suspect in the COPY, render the original and the copy at the same time, diff them, and remove the copy. " +
      "`confirmed` means undoing the suspect changes the picture; `not_confirmed` means it does not. " +
      "It writes to the project: a temporary comp named 'chroma-explain-proof ...' appears in the Project panel for the length of the renders, in two undo groups (add the copy, remove the copy), with an automatic checkpoint first. " +
      "The receipt checks the copy is gone and the item count is back. Only the comp's top-level layers are toggled in the copy, because a duplicated comp shares its nested precomps with the original. " +
      "Refuses before the checkpoint and before anything is duplicated when the suspect does not apply (for example 'enabled' on a layer that is already on). 'solo' solos the target in the copy and leaves the other layers' solo; 'layers_above' leaves cameras, lights and track mattes on; 'layers_above' and 'adjustment_above' are judged only inside the layer's own box (inconclusive for 3D layers). Use ae_explain_layer first to pick the suspect. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeExplainLayerProofSchema,
    handler: async (args: ProofArgs, ctx: ToolContext) => {
      ctx.quarantine.assertClear();
      const opId = ctx.bridge.newOpId();
      const label = `ae_explain_layer_proof(${args.suspect})`;
      const toolName = "ae_explain_layer_proof";
      const expect = { project_path: args.expect.project_path, comp_id: args.expect.comp_id ?? args.comp_id };
      const framesDir = defaultFramesDir();
      const read = async (phase: string) => {
        const res = await ctx.bridge.evalRaw({
          id: `${opId}_${phase}`,
          script: buildJsxCall("explainProofState", {}),
          label: `${label} (${phase})`,
          mutates: false,
          toolName,
        });
        return res.result ?? null;
      };

      try {
        return await ctx.queue.run(label, async () => {
          ctx.quarantine.assertClear();
          // Guard first, so a wrong project is refused before anything about its comps is read.
          const guard = await verifyTargetGuard(ctx, expect, opId);
          // Read-only: an inapplicable suspect is refused here, before any checkpoint.
          await ctx.bridge.evalRaw({
            id: `${opId}_plan`,
            script: buildJsxCall("explainProofPlan", { comp_id: args.comp_id, layer: args.layer, suspect: args.suspect, time: args.time }),
            label: `${label} (plan)`,
            mutates: false,
            toolName,
          });
          const checkpoint = await autoCheckpoint(ctx, guard, toolName);
          const note = { opId, toolName, label, expect, checkpoint: checkpoint?.path ?? null };
          const sessionFields = await noteBeforeWrite(ctx, note);
          const before = await read("before");
          fs.mkdirSync(framesDir, { recursive: true });

          // The record lives from the duplicate to the removal; if AE dies in
          // between, it is still there at the next start.
          beginInflight(note);
          let begun: Record<string, unknown>;
          try {
            const begin = await ctx.bridge.evalRaw<Record<string, unknown>>({
              id: opId,
              script: buildJsxCall("explainProofBegin", {
                comp_id: args.comp_id,
                layer: args.layer,
                suspect: args.suspect,
                time: args.time,
                expect,
              }),
              label,
              mutates: true,
              toolName,
            });
            begun = (begin.result ?? {}) as Record<string, unknown>;
          } catch (err) {
            endInflight(opId);
            throw err;
          }

          // From here the copy exists: nothing below may throw before it is removed.
          const copyId = begun.copy_id as number | undefined;
          const time = typeof begun.time === "number" ? begun.time : (args.time ?? 0);
          let diff: ProofDiff | null = null;
          let frames: { original: string; copy: string } | null = null;
          let proofError: string | undefined;
          let scope: "frame" | "layer_box" = "frame";
          try {
            if (typeof copyId !== "number") throw new Error("AE returned no id for the temporary comp, so nothing was rendered");
            let a = await captureCompFrame({ ctx, opId, compId: args.comp_id, time, frameIndex: 0, framesDir, toolName });
            let b = await captureCompFrame({ ctx, opId, compId: copyId as number, time, frameIndex: 1, framesDir, toolName });
            // A stale-frame retry may have nudged one render's time: bring the other to it.
            if (a.time !== b.time) {
              const later = Math.max(a.time, b.time);
              if (a.time < later) a = await captureCompFrame({ ctx, opId, compId: args.comp_id, time: later, frameIndex: 2, framesDir, toolName });
              else b = await captureCompFrame({ ctx, opId, compId: copyId as number, time: later, frameIndex: 3, framesDir, toolName });
              if (a.time !== b.time) throw new Error(`the original and the copy rendered at different times (${a.time}s and ${b.time}s)`);
            }
            frames = { original: a.path, copy: b.path };
            let pa = decodePngFile(a.path) as { width: number; height: number; data: Buffer | Uint8Array };
            let pb = decodePngFile(b.path) as { width: number; height: number; data: Buffer | Uint8Array };
            if (BOX_SUSPECTS.includes(args.suspect)) {
              // These suspects change other layers' pixels too, so only the target's box counts.
              const box = regionToPixels(begun.region as number[] | null, begun.comp_size as number[] | undefined, pa);
              if (!box) {
                throw new Error("the target is 3D, off the canvas or its box can't be read, so the diff can't be limited to the layer");
              }
              pa = cropFrame(pa, box);
              pb = cropFrame(pb, box);
              scope = "layer_box";
            }
            const cmp = compareDecodedFrames(pa, pb, { threshold: args.threshold ?? 0.02 });
            diff = {
              changed_pixels: cmp.changed_pixels,
              total_pixels: cmp.total_pixels,
              pct_pixels_changed: cmp.pct_pixels_changed,
              mean_abs_diff: cmp.mean_abs_diff,
              max_diff: cmp.max_diff,
              identical: cmp.identical,
            };
          } catch (err) {
            proofError = errMessage(err);
          }

          let cleanupError: string | null = null;
          let removed = false;
          try {
            if (typeof copyId !== "number") {
              throw new Error("AE returned no id for the temporary comp, so it could not be removed by id");
            }
            const end = await ctx.bridge.evalRaw<Record<string, unknown>>({
              id: `${opId}_remove`,
              script: buildJsxCall("explainProofEnd", { copy_id: copyId, expect }),
              label: `${label} (remove copy)`,
              mutates: true,
              mustSend: true,
              toolName,
            });
            // already_gone is not a removal this call made, so it does not count as removed.
            removed = (end.result as { removed?: boolean } | undefined)?.removed === true;
          } catch (err) {
            cleanupError = errMessage(err);
          } finally {
            endInflight(opId);
          }

          const { value: after, failure } = await readAfterWrite(opId, () => read("after"));
          const custom = [...(failure ? [failure] : []), ...proofMismatches(before, failure ? null : after, cleanupError, copyId)];
          const receipt = buildReceipt({ before, after, customMismatches: custom });
          await noteAfterWrite(ctx, note, { skipRead: !!failure });
          const verdict = proofVerdict(args.suspect, diff, proofError, scope);
          return {
            op_id: opId,
            applied: true as const,
            proof: {
              suspect: args.suspect,
              what: begun.what,
              layer_index: begun.layer_index,
              layers_changed: begun.layers_changed,
              time,
              copy_removed: removed,
              frames,
              diff,
              diff_scope: scope,
              ...(proofError ? { error: proofError } : {}),
            },
            verdict: verdict.verdict,
            explanation: verdict.explanation,
            checkpoint,
            receipt,
            ...sessionFields,
          };
        });
      } catch (err) {
        if (err instanceof QueueWaitError) {
          throw new BridgeError({ kind: "queued", op_id: opId, message: err.message });
        }
        throw err;
      }
    },
  },
];
