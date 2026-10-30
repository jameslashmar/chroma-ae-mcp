/**
 * server/src/tools/ext/key.ts
 *
 * ae_key_greenscreen: keys a green (or blue) screen plate with AE's own
 * Keylight, Key Cleaner and Advanced Spill Suppressor, then checks the key.
 * Frames rendered before the key tell screen from subject; frames rendered
 * after it are measured: screen left behind, holes in the subject, and spill.
 * Problems come back with ready ae_set_effect calls, as ae_motion_review's do.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PNG } from "pngjs";
import { z } from "zod";
import { BridgeError } from "../../host.js";
import { buildJsxCall } from "../../jsx.js";
import { QueueWaitError } from "../../queue.js";
import { buildReceipt, compareValues, type ReceiptMismatch } from "../../receipts.js";
import { defaultFramesDir } from "../render.js";
import {
  AGENT_SAFETY_GUIDANCE,
  ExpectSchema,
  LayerSelectorSchema,
  type ExpectGuard,
  type ToolContext,
  type ToolDefinition,
} from "../common.js";
import { autoCheckpoint, verifyTargetGuard } from "../mutate.js";
import { captureCompFrame, decodePngFile } from "./frames.js";
import { blit, createCanvas, encodePng, fitWithin, flattenOnChecker, resizeArea, type RgbaImage } from "./png-utils.js";

// ---------- analysis (pure) ----------

export type Rgb = [number, number, number];

/** How strongly a pixel leans to the screen's dominant channel, 0..1 of the screen's own lean. */
function screenLean(r: number, g: number, b: number, dominant: 1 | 2, screenLeanValue: number): number {
  const lean = dominant === 1 ? g - Math.max(r, b) : b - Math.max(r, g);
  return screenLeanValue > 0 ? lean / screenLeanValue : 0;
}

/**
 * The screen colour of a plate: the median of the pixels that lean hardest to
 * green (or blue, whichever covers more of the frame). Null when neither
 * covers at least `minCoverage` of the frame.
 */
export function detectScreenColor(img: RgbaImage, minCoverage = 0.1): { color: Rgb; kind: "green" | "blue"; coverage: number } | null {
  const n = img.width * img.height;
  const pick = (dominant: 1 | 2) => {
    const rs: number[] = [];
    const gs: number[] = [];
    const bs: number[] = [];
    for (let i = 0; i < n; i++) {
      const j = i * 4;
      if (img.data[j + 3] < 250) continue;
      const r = img.data[j] / 255;
      const g = img.data[j + 1] / 255;
      const b = img.data[j + 2] / 255;
      const lean = dominant === 1 ? g - Math.max(r, b) : b - Math.max(r, g);
      if (lean > 0.15) {
        rs.push(r);
        gs.push(g);
        bs.push(b);
      }
    }
    return { rs, gs, bs, coverage: rs.length / n };
  };
  const green = pick(1);
  const blue = pick(2);
  const best = green.coverage >= blue.coverage ? { ...green, kind: "green" as const } : { ...blue, kind: "blue" as const };
  if (best.coverage < minCoverage) return null;
  const median = (v: number[]) => {
    const s = [...v].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  const round = (v: number) => Math.round(v * 1000) / 1000;
  return { color: [round(median(best.rs)), round(median(best.gs)), round(median(best.bs))], kind: best.kind, coverage: round(best.coverage) };
}

export interface KeyMetrics {
  screen_pixels_pct: number;
  subject_pixels_pct: number;
  /** Share of screen pixels still more than 5% opaque after the key. */
  screen_left_pct: number;
  /** Mean alpha left on screen pixels (0 is a clean key). */
  screen_residual_alpha: number;
  /** Share of subject pixels (away from the screen edge) less than 95% opaque. */
  holes_pct: number;
  /** Mean green (or blue) lean on subject pixels before and after the key, 0..1. */
  spill_before: number;
  spill_after: number;
  /** Mean RGB distance (0..1 per channel, averaged) between the subject before and after: how much the key recoloured it. */
  subject_color_shift: number;
  /** Share of the subject where some channel moved by more than 0.12: catches a recoloured prop the mean hides. */
  recoloured_pct: number;
}

/**
 * Compares a plate before and after keying. Screen pixels lean to the screen
 * colour at least 70% as much as the screen does; subject pixels lean less
 * than 20% and are more than `edge` px from any screen pixel.
 */
export function measureKey(before: RgbaImage, after: RgbaImage, screen: Rgb, edge = 3): KeyMetrics {
  const { width: w, height: h } = before;
  if (after.width !== w || after.height !== h) throw new Error("Before and after frames differ in size");
  const dominant: 1 | 2 = screen[1] >= screen[2] ? 1 : 2;
  const sLean = dominant === 1 ? screen[1] - Math.max(screen[0], screen[2]) : screen[2] - Math.max(screen[0], screen[1]);
  const n = w * h;
  const cls = new Uint8Array(n); // 1 screen, 2 subject
  const leanBefore = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const j = i * 4;
    const lean = screenLean(before.data[j] / 255, before.data[j + 1] / 255, before.data[j + 2] / 255, dominant, sLean);
    leanBefore[i] = lean;
    if (lean >= 0.7) cls[i] = 1;
    else if (lean < 0.2 && before.data[j + 3] > 250) cls[i] = 2;
  }
  // Pixels near the screen are edges (hair, blur), allowed to be partly transparent.
  const nearScreen = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (cls[y * w + x] !== 1) continue;
      for (let dy = -edge; dy <= edge; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -edge; dx <= edge; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < w) nearScreen[yy * w + xx] = 1;
        }
      }
    }
  }
  let screenCount = 0;
  let screenLeft = 0;
  let residual = 0;
  let subject = 0;
  let holes = 0;
  let spillB = 0;
  let spillA = 0;
  let spillN = 0;
  let shift = 0;
  let recoloured = 0;
  for (let i = 0; i < n; i++) {
    const j = i * 4;
    const a = after.data[j + 3] / 255;
    if (cls[i] === 1) {
      screenCount++;
      residual += a;
      if (a > 0.05) screenLeft++;
    } else if (cls[i] === 2 && !nearScreen[i]) {
      subject++;
      if (a < 0.95) holes++;
      if (a > 0.5) {
        spillB += Math.max(0, leanBefore[i] * sLean);
        spillA += Math.max(0, screenLean(after.data[j] / 255, after.data[j + 1] / 255, after.data[j + 2] / 255, dominant, 1));
        const dr = Math.abs(after.data[j] - before.data[j]);
        const dg = Math.abs(after.data[j + 1] - before.data[j + 1]);
        const db = Math.abs(after.data[j + 2] - before.data[j + 2]);
        shift += (dr + dg + db) / (3 * 255);
        // Despill moves one channel (green out of olive, blue out of navy), so judge by the largest.
        if (Math.max(dr, dg, db) / 255 > 0.12) recoloured++;
        spillN++;
      }
    }
  }
  const pct = (v: number, of: number) => (of > 0 ? Math.round((v / of) * 10000) / 100 : 0);
  const r4 = (v: number) => Math.round(v * 10000) / 10000;
  return {
    screen_pixels_pct: pct(screenCount, n),
    subject_pixels_pct: pct(subject, n),
    screen_left_pct: pct(screenLeft, screenCount),
    screen_residual_alpha: screenCount ? r4(residual / screenCount) : 0,
    holes_pct: pct(holes, subject),
    spill_before: spillN ? r4(spillB / spillN) : 0,
    spill_after: spillN ? r4(spillA / spillN) : 0,
    subject_color_shift: spillN ? r4(shift / spillN) : 0,
    recoloured_pct: pct(recoloured, spillN),
  };
}

/** Worst of several frames' metrics: the key is only as good as its worst frame. */
export function worstMetrics(all: KeyMetrics[]): KeyMetrics {
  const max = (k: keyof KeyMetrics) => Math.max(...all.map((m) => m[k]));
  return {
    screen_pixels_pct: Math.min(...all.map((m) => m.screen_pixels_pct)),
    subject_pixels_pct: Math.min(...all.map((m) => m.subject_pixels_pct)),
    screen_left_pct: max("screen_left_pct"),
    screen_residual_alpha: max("screen_residual_alpha"),
    holes_pct: max("holes_pct"),
    spill_before: max("spill_before"),
    spill_after: max("spill_after"),
    subject_color_shift: max("subject_color_shift"),
    recoloured_pct: max("recoloured_pct"),
  };
}

export interface KeylightSettings {
  index: number;
  clip_black: number;
  clip_white: number;
  screen_gain: number;
}

/** Plain-language findings and ready ae_set_effect calls for the worst frame's metrics. */
export function keyAdvice(
  m: KeyMetrics,
  kl: KeylightSettings,
  target: { comp_id: number; layer_id: number; expect: ExpectGuard }
): { verdict: "clean" | "needs_work"; findings: Array<{ issue: string; message: string; fix?: Record<string, unknown> }> } {
  const findings: Array<{ issue: string; message: string; fix?: Record<string, unknown> }> = [];
  const fix = (param: string, value: number) => ({
    tool: "ae_set_effect",
    args: {
      comp_id: target.comp_id,
      layer: { id: target.layer_id },
      effect: { index: kl.index },
      params: [{ param, value: Math.round(value * 10) / 10 }],
      expect: target.expect,
    },
  });
  if (m.screen_left_pct >= 0.5) {
    // Clamp above clip_black so the suggestion always actually raises it (and the
    // message stays true), and below clip_white so the range doesn't invert when
    // the two clips already sit close together.
    const next = Math.max(kl.clip_black + 1, Math.min(kl.clip_white - 1, kl.clip_black + (m.screen_left_pct > 5 ? 20 : 10)));
    findings.push({
      issue: "screen_left",
      message: `${m.screen_left_pct}% of the screen is still visible (mean alpha ${m.screen_residual_alpha}). Raising Clip Black from ${kl.clip_black} to ${next} pushes it out.`,
      fix: fix("Keylight 906-0012", next),
    });
  }
  if (m.holes_pct >= 0.5) {
    // Clamp below clip_white so the suggestion always actually lowers it, and above
    // clip_black for the same reason as above.
    const next = Math.min(kl.clip_white - 1, Math.max(kl.clip_black + 1, kl.clip_white - (m.holes_pct > 5 ? 20 : 10)));
    findings.push({
      issue: "holes",
      message: `${m.holes_pct}% of the subject is see-through. Lowering Clip White from ${kl.clip_white} to ${next} fills it in; if the subject itself is greenish, lower Screen Gain instead.`,
      fix: fix("Keylight 906-0013", next),
    });
  }
  if (m.spill_after > 0.05) {
    findings.push({
      issue: "spill",
      message: `The subject still leans to the screen colour (spill ${m.spill_after}, ${m.spill_before} before). Raise Suppression on Advanced Spill Suppressor.`,
    });
  }
  if (m.subject_color_shift > 0.06 || m.recoloured_pct > 2) {
    findings.push({
      issue: "color_shift",
      message: `The key recoloured ${m.recoloured_pct}% of the subject (mean shift ${m.subject_color_shift} per channel). Despill takes the screen colour out of anything greenish (or bluish) on the subject; compare in the preview, and if a prop or costume changed, set Keylight's Despill Bias to that colour or mask the area.`,
    });
  }
  return { verdict: findings.length === 0 ? "clean" : "needs_work", findings };
}

/** One row per time: the plate before (left) and the key over a checkerboard (right). */
export function keyPreview(pairs: Array<{ before: RgbaImage; after: RgbaImage }>, tile = 480): PNG {
  const fit = fitWithin(pairs[0].before.width, pairs[0].before.height, tile);
  const gap = 6;
  const out = createCanvas(fit.width * 2 + gap * 3, (fit.height + gap) * pairs.length + gap, [24, 24, 24, 255]);
  pairs.forEach((p, row) => {
    const y = gap + row * (fit.height + gap);
    blit(out, resizeArea(p.before, fit.width, fit.height), gap, y);
    blit(out, flattenOnChecker(resizeArea(p.after, fit.width, fit.height), 8, 90, 60), gap * 2 + fit.width, y);
  });
  return out;
}

/** Up to three frame times across the layer's visible span within the work area. */
export function keyTimes(info: { comp: { fps: number; workAreaStart: number; workAreaDuration: number }; layer: { inPoint: number; outPoint: number } }): number[] {
  const fps = info.comp.fps > 0 ? info.comp.fps : 25;
  const start = Math.max(info.layer.inPoint, info.comp.workAreaStart);
  const end = Math.min(info.layer.outPoint, info.comp.workAreaStart + info.comp.workAreaDuration) - 1 / fps;
  if (end < start) return [Math.round(start * fps) / fps];
  const snap = (t: number) => Math.round(t * fps) / fps;
  return [...new Set([snap(start), snap((start + end) / 2), snap(end)])];
}

// ---------- tool ----------

export const AeKeyGreenScreenSchema = z
  .object({
    comp_id: z.number().int(),
    layer: LayerSelectorSchema.describe("The plate layer to key."),
    times: z
      .array(z.number().min(0))
      .min(1)
      .max(5)
      .optional()
      .describe("Frames to analyse and check, in seconds. Default: start, middle and end of the layer within the work area."),
    screen_color: z
      .array(z.number().min(0).max(1))
      .length(3)
      .optional()
      .describe("Screen colour [r, g, b] in 0..1. Default: detected from the plate."),
    clip_black: z.number().min(0).max(100).optional().describe("Keylight Clip Black: raise it when screen is left behind."),
    clip_white: z.number().min(0).max(100).optional().describe("Keylight Clip White: lower it when the subject has holes."),
    screen_gain: z.number().min(0).max(200).optional().describe("Keylight Screen Gain (default 100)."),
    screen_balance: z.number().min(0).max(100).optional(),
    screen_softness: z.number().min(0).max(100).optional(),
    screen_shrink_grow: z.number().min(-100).max(100).optional(),
    cleanup: z.boolean().optional().describe("Also add Key Cleaner and Advanced Spill Suppressor (default true)."),
    check_only: z.boolean().optional().describe("Only measure the current key; changes nothing."),
    expect: ExpectSchema.optional().describe("Required unless check_only."),
  })
  .refine((v) => v.check_only === true || v.expect !== undefined, { message: "Keying needs expect; pass check_only to only measure." });

export type AeKeyGreenScreenArgs = z.infer<typeof AeKeyGreenScreenSchema>;

interface KeyInfo {
  project_path: string;
  comp: { id: number; width: number; height: number; fps: number; workAreaStart: number; workAreaDuration: number };
  layer: { id: number; index: number; name: string; inPoint: number; outPoint: number };
  keylight: (KeylightSettings & { name: string; enabled: boolean; screen_colour: number[]; screen_balance: number; screen_softness: number; screen_shrink_grow: number }) | null;
  has_key_cleaner: boolean;
  has_spill_suppressor: boolean;
  layers_below_visible: string[];
}

// Frames rendered before keying, per comp, layer and time, so later checks
// (check_only, or a second pass) can still tell screen from subject.
const beforeFrames = new Map<string, string>();
const beforeKey = (compId: number, layerId: number, t: number) => `${compId}:${layerId}:${t.toFixed(4)}`;

export function clearKeyCache(): void {
  beforeFrames.clear();
}

async function queued<T>(ctx: ToolContext, label: string, opId: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await ctx.queue.run(label, fn);
  } catch (err) {
    if (err instanceof QueueWaitError) throw new BridgeError({ kind: "queued", op_id: opId, message: err.message });
    throw err;
  }
}

const KEYLIGHT_ARG_KEYS = ["clip_black", "clip_white", "screen_gain", "screen_balance", "screen_softness", "screen_shrink_grow"] as const;

export const keyTools: ToolDefinition<any>[] = [
  {
    name: "ae_key_greenscreen",
    description:
      "Key a green or blue screen plate with AE's own Keylight (1.2), plus Key Cleaner and Advanced Spill Suppressor, in one undo step guarded by `expect`; then CHECK the key. " +
      "Frames rendered before keying tell screen from subject (the screen colour is detected from them unless given); frames rendered after are measured: `screen_left_pct` (screen still visible), `holes_pct` (see-through subject), `spill_after` (screen colour on the subject). " +
      "The result has `verdict`, `findings` with ready ae_set_effect fixes (apply them with the user's OK, then call again with check_only), and `preview_path`: before and after over a checkerboard, one row per frame. Look at it. " +
      "A layer that already has Keylight is re-tuned, not keyed twice. The check needs the plate to be the lowest visible layer (precomp it otherwise); without frames from before the key (another session, or a key made by hand) only the preview is returned. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeKeyGreenScreenSchema,
    handler: async (args: AeKeyGreenScreenArgs, ctx: ToolContext) => {
      const opId = ctx.bridge.newOpId();
      const framesDir = defaultFramesDir();
      fs.mkdirSync(framesDir, { recursive: true });
      const label = `ae_key_greenscreen(${args.comp_id})`;
      const readInfo = async (times: number[] | undefined, suffix: string) =>
        (
          await ctx.bridge.evalRaw<KeyInfo>({
            id: `${opId}_${suffix}`,
            script: buildJsxCall("keyLayerInfo", { comp_id: args.comp_id, layer: args.layer, times }),
            label: `${label} ${suffix}`,
            mutates: false,
            toolName: "ae_key_greenscreen",
          })
        ).result;
      const capture = async (t: number, i: number) =>
        (await captureCompFrame({ ctx, opId, compId: args.comp_id, time: t, frameIndex: i, framesDir, toolName: "ae_key_greenscreen" })).path;

      const run = await queued(ctx, label, opId, async () => {
        const first = await readInfo(args.times, "info");
        const times = args.times ?? keyTimes(first);
        const info = args.times ? first : await readInfo(times, "info2");
        const layerId = info.layer.id;

        // Plate frames from before any key: render them now if the layer has
        // no Keylight yet, otherwise use the ones kept from an earlier call.
        const before: Array<string | null> = [];
        for (let i = 0; i < times.length; i++) {
          const k = beforeKey(args.comp_id, layerId, times[i]);
          if (!info.keylight && !args.check_only) {
            const p = await capture(times[i], i);
            beforeFrames.set(k, p);
            before.push(p);
          } else {
            before.push(beforeFrames.get(k) ?? null);
          }
        }

        let screen: Rgb | null = (args.screen_color as Rgb | undefined) ?? null;
        let detected: ReturnType<typeof detectScreenColor> = null;
        if (!screen && info.keylight) screen = info.keylight.screen_colour.slice(0, 3) as Rgb;
        if (!screen && before[0]) {
          detected = detectScreenColor(decodePngFile(before[0]));
          screen = detected?.color ?? null;
        }

        let write: { checkpoint: unknown; result: Record<string, unknown>; after: KeyInfo } | null = null;
        if (!args.check_only) {
          if (!screen) {
            return { error: "no_screen" as const, times };
          }
          const expect: ExpectGuard = { project_path: args.expect!.project_path, comp_id: args.expect!.comp_id ?? args.comp_id };
          const guard = await verifyTargetGuard(ctx, expect, opId);
          const checkpoint = await autoCheckpoint(ctx, guard, "ae_key_greenscreen");
          const params: Record<string, number> = {};
          for (const k of KEYLIGHT_ARG_KEYS) if (args[k] !== undefined) params[k] = args[k] as number;
          const res = await ctx.bridge.evalRaw<Record<string, unknown>>({
            id: opId,
            script: buildJsxCall("applyGreenScreenKey", {
              comp_id: args.comp_id,
              layer: { id: layerId },
              screen_color: screen,
              cleanup: args.cleanup ?? true,
              expect,
              ...params,
            }),
            label: `${label} key`,
            mutates: true,
            toolName: "ae_key_greenscreen",
          });
          // Separate evalScript for the read-back.
          const after = await readInfo(times, "after");
          write = { checkpoint, result: res.result, after };
        }

        const after: string[] = [];
        for (let i = 0; i < times.length; i++) after.push(await capture(times[i], times.length + i));
        const finalInfo = write?.after ?? info;
        return { times, before, after, screen, detected, write, info: finalInfo };
      });

      if ("error" in run) {
        return {
          ok: false,
          error: "no_screen",
          message: "No green or blue screen covers at least 10% of the plate. Pass screen_color, or check that the layer is the plate.",
        };
      }

      const kl = run.info.keylight;
      const pairs = run.after.map((a, i) => ({ before: run.before[i] ? decodePngFile(run.before[i]!) : null, after: decodePngFile(a) }));
      const previewPath = path.join(framesDir, `key_c${args.comp_id}_${opId}.png`);
      fs.writeFileSync(previewPath, encodePng(keyPreview(pairs.map((p) => ({ before: p.before ?? p.after, after: p.after })))));

      const below = run.info.layers_below_visible;
      const canMeasure = below.length === 0 && pairs.every((p) => p.before !== null) && run.screen !== null;
      const perFrame = canMeasure ? pairs.map((p) => measureKey(p.before!, p.after, run.screen!)) : [];
      const worst = perFrame.length ? worstMetrics(perFrame) : null;
      const target = {
        comp_id: args.comp_id,
        layer_id: run.info.layer.id,
        expect: { project_path: run.info.project_path, comp_id: args.comp_id },
      };
      const advice = worst && kl ? keyAdvice(worst, kl, target) : null;

      let receipt;
      if (run.write) {
        const mismatches: ReceiptMismatch[] = [];
        if (!kl) {
          mismatches.push({ path: "keylight", expected: "present", actual: null, message: "No Keylight on the layer after keying" });
        } else {
          compareValues([...run.screen!, 1], kl.screen_colour, "keylight.screen_colour", mismatches);
          for (const k of KEYLIGHT_ARG_KEYS) if (args[k] !== undefined) compareValues(args[k], (kl as any)[k], `keylight.${k}`, mismatches);
        }
        if ((args.cleanup ?? true) && !(run.info.has_key_cleaner && run.info.has_spill_suppressor)) {
          mismatches.push({ path: "cleanup", expected: "Key Cleaner and Advanced Spill Suppressor", actual: run.info, message: "Cleanup effects missing after keying" });
        }
        receipt = buildReceipt({ before: null, after: run.info, customMismatches: mismatches });
      }

      let note: string | undefined;
      if (below.length > 0) note = `Layers below the plate show through (${below.join(", ")}), so the alpha can't be measured; precomp the plate or check the preview.`;
      else if (!canMeasure) note = "No frames from before the key are kept for this layer (a key made by hand or in another session), so only the preview is returned.";

      return {
        ok: true,
        applied: run.write !== null,
        layer: run.info.layer,
        times: run.times,
        screen_color: run.screen,
        ...(run.detected ? { screen_detected: { kind: run.detected.kind, coverage: run.detected.coverage } } : {}),
        keylight: kl,
        ...(run.write ? { added: run.write.result.added, checkpoint: run.write.checkpoint, receipt } : {}),
        metrics: worst,
        per_frame: perFrame.length > 1 ? perFrame : undefined,
        verdict: advice?.verdict ?? "unchecked",
        findings: advice?.findings ?? [],
        ...(note ? { note } : {}),
        preview_path: previewPath,
      };
    },
  },
];
