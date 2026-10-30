/**
 * server/src/tools/ext/track.ts
 *
 * ae_track_point: a point tracker that runs inside the MCP, on AE's own
 * Node. AE renders each frame (saveFrameToPng, as the frame tools do), the
 * server follows a pattern from frame to frame by normalized cross-
 * correlation with sub-pixel refinement, and the path can be written to a
 * new null in one undo step. Like AE's tracker, the pattern adapts when
 * confidence drops below 80%, and tracking stops when the point is lost.
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
import { AGENT_SAFETY_GUIDANCE, ExpectSchema, type ExpectGuard, type ToolContext, type ToolDefinition } from "../common.js";
import { autoCheckpoint, verifyTargetGuard } from "../mutate.js";
import { captureCompFrame, decodePngFile } from "./frames.js";
import { drawLine, encodePng, fitWithin, resizeArea, strokeRect, type RgbaImage } from "./png-utils.js";

// ---------- tracking core (pure) ----------

export interface GrayImage {
  width: number;
  height: number;
  data: Float32Array;
}

export function toGray(img: RgbaImage): GrayImage {
  const n = img.width * img.height;
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const j = i * 4;
    data[i] = 0.2126 * img.data[j] + 0.7152 * img.data[j + 1] + 0.0722 * img.data[j + 2];
  }
  return { width: img.width, height: img.height, data };
}

/**
 * A size x size patch centred on (cx, cy), sampled bilinearly, in pixel-index
 * coordinates (pixel i's centre is at i). Null when it leaves the image.
 */
export function extractPatch(img: GrayImage, cx: number, cy: number, size: number): GrayImage | null {
  const h = (size - 1) / 2;
  if (cx - h < 0 || cy - h < 0 || cx + h > img.width - 1 || cy + h > img.height - 1) return null;
  const data = new Float32Array(size * size);
  for (let py = 0; py < size; py++) {
    const y = cy - h + py;
    const y0 = Math.min(img.height - 2, Math.floor(y));
    const fy = y - y0;
    for (let px = 0; px < size; px++) {
      const x = cx - h + px;
      const x0 = Math.min(img.width - 2, Math.floor(x));
      const fx = x - x0;
      const i = y0 * img.width + x0;
      const top = img.data[i] * (1 - fx) + img.data[i + 1] * fx;
      const bottom = img.data[i + img.width] * (1 - fx) + img.data[i + img.width + 1] * fx;
      data[py * size + px] = top * (1 - fy) + bottom * fy;
    }
  }
  return { width: size, height: size, data };
}

export interface Template {
  size: number;
  /** Values minus their mean. */
  centred: Float32Array;
  norm: number;
  std: number;
}

export function makeTemplate(patch: GrayImage): Template {
  const n = patch.data.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += patch.data[i];
  const mean = sum / n;
  const centred = new Float32Array(n);
  let sq = 0;
  for (let i = 0; i < n; i++) {
    centred[i] = patch.data[i] - mean;
    sq += centred[i] * centred[i];
  }
  return { size: patch.width, centred, norm: Math.sqrt(sq), std: Math.sqrt(sq / n) };
}

/** Parabola vertex offset through three scores, clamped to half a pixel. */
function subPixel(a: number, b: number, c: number): number {
  const denom = a - 2 * b + c;
  if (!(denom < 0)) return 0;
  return Math.max(-0.5, Math.min(0.5, (a - c) / (2 * denom)));
}

/**
 * Best normalized cross-correlation of `tpl` around (cx, cy), over integer
 * centres within `radius`, then refined to sub-pixel. Null if no candidate
 * window fits in the image.
 */
export function matchTemplate(
  img: GrayImage,
  tpl: Template,
  cx: number,
  cy: number,
  radius: number
): { x: number; y: number; score: number } | null {
  const size = tpl.size;
  const h = (size - 1) / 2;
  const n = size * size;
  const icx = Math.round(cx);
  const icy = Math.round(cy);
  const side = 2 * radius + 1;
  const scores = new Float32Array(side * side).fill(-2);
  let best = -2;
  let bx = 0;
  let by = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    const top = icy + dy - h;
    if (top < 0 || top + size > img.height) continue;
    for (let dx = -radius; dx <= radius; dx++) {
      const left = icx + dx - h;
      if (left < 0 || left + size > img.width) continue;
      let sum = 0;
      let sq = 0;
      let cross = 0;
      for (let py = 0; py < size; py++) {
        const row = (top + py) * img.width + left;
        const trow = py * size;
        for (let px = 0; px < size; px++) {
          const v = img.data[row + px];
          sum += v;
          sq += v * v;
          cross += v * tpl.centred[trow + px];
        }
      }
      const variance = sq - (sum * sum) / n;
      const score = variance > 1e-6 && tpl.norm > 0 ? cross / (Math.sqrt(variance) * tpl.norm) : 0;
      scores[(dy + radius) * side + dx + radius] = score;
      if (score > best) {
        best = score;
        bx = dx;
        by = dy;
      }
    }
  }
  if (best <= -2) return null;
  const at = (dx: number, dy: number) => {
    if (Math.abs(dx) > radius || Math.abs(dy) > radius) return NaN;
    const s = scores[(dy + radius) * side + dx + radius];
    return s <= -2 ? NaN : s;
  };
  const sx = [at(bx - 1, by), best, at(bx + 1, by)];
  const sy = [at(bx, by - 1), best, at(bx, by + 1)];
  const offX = sx.every(Number.isFinite) ? subPixel(sx[0], sx[1], sx[2]) : 0;
  const offY = sy.every(Number.isFinite) ? subPixel(sy[0], sy[1], sy[2]) : 0;
  return { x: icx + bx + offX, y: icy + by + offY, score: best };
}

export interface TrackOptions {
  patchSize: number;
  searchRadius: number;
  minConfidence: number;
  /** Below this confidence against the first pattern, the previous frame's pattern is tried (AE's default is 80%). */
  adaptBelow: number;
}

export interface TrackStep {
  x: number;
  y: number;
  confidence: number;
  adapted: boolean;
}

// A pattern this flat (gray levels, 0-255) has nothing to lock onto.
const MIN_PATTERN_STD = 3;

export class PointTracker {
  private readonly first: Template;
  private current: Template;
  private last: { x: number; y: number };
  private velocity = { x: 0, y: 0 };

  constructor(frame: GrayImage, x: number, y: number, private readonly opts: TrackOptions) {
    const patch = extractPatch(frame, x, y, opts.patchSize);
    if (!patch) throw new Error("The pattern around that point reaches outside the frame; pick a point further in or use a smaller pattern_size.");
    this.first = makeTemplate(patch);
    if (this.first.std < MIN_PATTERN_STD) {
      throw new Error(
        `The pattern at that point is almost flat (contrast ${this.first.std.toFixed(1)} of 255), so there is nothing to follow. Pick a corner, a mark or an edge crossing, or use a larger pattern_size.`
      );
    }
    this.current = this.first;
    this.last = { x, y };
  }

  get contrast(): number {
    return this.first.std;
  }

  /** The next frame's position, or null when the point is lost. */
  step(frame: GrayImage): TrackStep | null {
    const px = this.last.x + this.velocity.x;
    const py = this.last.y + this.velocity.y;
    const r = this.opts.searchRadius;
    let pick = matchTemplate(frame, this.first, px, py, r);
    let adapted = false;
    if (!pick || pick.score < this.opts.adaptBelow) {
      const alt = this.current === this.first ? null : matchTemplate(frame, this.current, px, py, r);
      if (alt && (!pick || alt.score > pick.score)) {
        pick = alt;
        adapted = true;
      }
    }
    if (!pick || pick.score < this.opts.minConfidence) return null;
    this.velocity = { x: pick.x - this.last.x, y: pick.y - this.last.y };
    this.last = { x: pick.x, y: pick.y };
    const next = extractPatch(frame, pick.x, pick.y, this.opts.patchSize);
    if (next && pick.score < this.opts.adaptBelow) {
      const t = makeTemplate(next);
      if (t.std >= MIN_PATTERN_STD) this.current = t;
    }
    return { x: pick.x, y: pick.y, confidence: pick.score, adapted };
  }
}

/** Frame times from `start` to `end` inclusive, one per frame. */
export function trackTimes(start: number, end: number, fps: number, maxFrames: number): number[] {
  const times: number[] = [];
  const first = Math.round(start * fps);
  const last = Math.round(end * fps);
  const step = last >= first ? 1 : -1;
  for (let f = first; step > 0 ? f <= last : f >= last; f += step) {
    times.push(f / fps);
    if (times.length >= maxFrames) break;
  }
  return times;
}

/** The first frame, shrunk, with the tracked path, the pattern box and where tracking stopped. */
export function drawTrackPreview(
  frame: RgbaImage,
  points: Array<{ x: number; y: number }>,
  patchSize: number,
  lost: boolean,
  maxSize = 960
): PNG {
  const fit = fitWithin(frame.width, frame.height, maxSize);
  const img = resizeArea(frame, fit.width, fit.height);
  const k = fit.width / frame.width;
  const yellow: [number, number, number, number] = [255, 214, 0, 255];
  for (let i = 1; i < points.length; i++) {
    drawLine(img, points[i - 1].x * k, points[i - 1].y * k, points[i].x * k, points[i].y * k, 2, yellow);
  }
  const box = Math.max(4, Math.round(patchSize * k));
  const p0 = points[0];
  strokeRect(img, Math.round(p0.x * k - box / 2), Math.round(p0.y * k - box / 2), box, box, 2, [0, 220, 255, 255]);
  const end = points[points.length - 1];
  const mark = Math.max(6, Math.round(box / 2));
  strokeRect(img, Math.round(end.x * k - mark / 2), Math.round(end.y * k - mark / 2), mark, mark, 2, lost ? [255, 60, 60, 255] : [80, 255, 120, 255]);
  return img;
}

// ---------- tool ----------

export const AeTrackPointSchema = z.object({
  comp_id: z.number().int(),
  point: z
    .array(z.number())
    .length(2)
    .describe("The feature to follow, [x, y] in comp pixels at the start time. Pick a corner, a mark or an edge crossing, not a flat area."),
  start: z.number().min(0).optional().describe("Seconds. Default: the work area start."),
  end: z.number().min(0).optional().describe("Seconds. Default: the work area end. An end before the start tracks backwards."),
  pattern_size: z.number().int().min(9).max(201).optional().describe("Side of the square pattern in comp pixels (odd). Default 31."),
  search_radius: z
    .number()
    .int()
    .min(2)
    .max(300)
    .optional()
    .describe("How far (px) from the predicted position to look each frame. Default 40; raise it for fast motion."),
  min_confidence: z.number().min(0).max(1).optional().describe("Below this match score (0..1) the point counts as lost and tracking stops. Default 0.6."),
  apply: z
    .object({
      null_name: z.string().min(1).max(200).describe("Name of the new null layer that gets the track as Position keys, one per frame."),
      expect: ExpectSchema,
    })
    .optional()
    .describe("Write the track to a new null, in one undo step guarded by `expect`. Without it the tool only measures."),
});

export type AeTrackPointArgs = z.infer<typeof AeTrackPointSchema>;

const MAX_TRACK_FRAMES = 1000;

interface CompInfo {
  width: number;
  height: number;
  fps: number;
  duration: number;
  workAreaStart: number;
  workAreaDuration: number;
}

async function queued<T>(ctx: ToolContext, label: string, opId: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await ctx.queue.run(label, fn);
  } catch (err) {
    if (err instanceof QueueWaitError) throw new BridgeError({ kind: "queued", op_id: opId, message: err.message });
    throw err;
  }
}

export const trackTools: ToolDefinition<any>[] = [
  {
    name: "ae_track_point",
    description:
      "Track one point through a comp, inside the MCP (nothing to install): AE renders each frame and the server follows the pattern around `point` by normalized cross-correlation with sub-pixel refinement, adapting the pattern when confidence drops below 80% as AE's own tracker does. " +
      "It tracks the comp's rendered image, so layers above the plate (titles, overlays) can get in the way; track in a comp or precomp that shows the plate. " +
      "Returns the path in comp pixels with a confidence per frame, where the point was lost if it was, and `preview_path`: the first frame with the path drawn (cyan box = pattern, green = end, red = lost). Look at the preview before using the track. " +
      "With `apply`, the path becomes Position keys on a new null in one undo step (guarded, read back); parent layers to it with ae_run_jsx. Every frame is a render, so long shots take a while. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeTrackPointSchema,
    handler: async (args: AeTrackPointArgs, ctx: ToolContext) => {
      const opId = ctx.bridge.newOpId();
      const framesDir = defaultFramesDir();
      fs.mkdirSync(framesDir, { recursive: true });
      const patchSize = (args.pattern_size ?? 31) | 1;
      const opts: TrackOptions = {
        patchSize,
        searchRadius: args.search_radius ?? 40,
        minConfidence: args.min_confidence ?? 0.6,
        adaptBelow: 0.8,
      };
      const label = `ae_track_point(${args.comp_id})`;

      const tracked = await queued(ctx, label, opId, async () => {
        const compResp = await ctx.bridge.evalRaw<CompInfo>({
          id: `${opId}_comp`,
          script: buildJsxCall("getComp", { comp_id: args.comp_id }),
          label: `${label} getComp`,
          mutates: false,
          toolName: "ae_track_point",
        });
        const comp = compResp.result;
        const fps = Number(comp.fps) > 0 ? Number(comp.fps) : 25;
        const start = args.start ?? Number(comp.workAreaStart);
        const end = args.end ?? Number(comp.workAreaStart) + Number(comp.workAreaDuration) - 1 / fps;
        const times = trackTimes(start, end, fps, MAX_TRACK_FRAMES);

        let tracker: PointTracker | null = null;
        let firstFrame: PNG | null = null;
        let scale = 1;
        const points: Array<{ time: number; x: number; y: number; confidence: number; adapted: boolean }> = [];
        let lostAt: { time: number; frame: number } | null = null;

        for (let i = 0; i < times.length; i++) {
          const snap = await captureCompFrame({ ctx, opId, compId: args.comp_id, time: times[i], frameIndex: i, framesDir, toolName: "ae_track_point" });
          const png = decodePngFile(snap.path);
          const gray = toGray(png);
          if (i === 0) {
            firstFrame = png;
            // Frames come back at full resolution; map comp pixels onto them.
            scale = png.width / Number(comp.width);
            tracker = new PointTracker(gray, args.point[0] * scale - 0.5, args.point[1] * scale - 0.5, {
              ...opts,
              patchSize: Math.max(9, Math.round(patchSize * scale) | 1),
              searchRadius: Math.max(2, Math.round(opts.searchRadius * scale)),
            });
            points.push({ time: times[0], x: args.point[0], y: args.point[1], confidence: 1, adapted: false });
          } else {
            const s = tracker!.step(gray);
            if (!s) {
              lostAt = { time: times[i], frame: Math.round(times[i] * fps) };
            } else {
              points.push({ time: times[i], x: (s.x + 0.5) / scale, y: (s.y + 0.5) / scale, confidence: s.confidence, adapted: s.adapted });
            }
          }
          fs.rmSync(snap.path, { force: true });
          if (lostAt) break;
        }
        return { comp, fps, start, end, times, points, lostAt, firstFrame: firstFrame!, scale, contrast: tracker!.contrast };
      });

      const { points, lostAt } = tracked;
      const previewPath = path.join(framesDir, `track_c${args.comp_id}_${opId}.png`);
      fs.writeFileSync(
        previewPath,
        encodePng(
          drawTrackPreview(
            tracked.firstFrame,
            points.map((p) => ({ x: p.x * tracked.scale - 0.5, y: p.y * tracked.scale - 0.5 })),
            patchSize * tracked.scale,
            lostAt !== null
          )
        )
      );
      const conf = points.slice(1).map((p) => p.confidence);
      const r2 = (v: number) => Math.round(v * 100) / 100;
      const result: Record<string, unknown> = {
        ok: true,
        comp_id: args.comp_id,
        start: r2(tracked.start),
        end: r2(tracked.end),
        frames_requested: tracked.times.length,
        frames_tracked: points.length,
        lost_at: lostAt,
        mean_confidence: conf.length ? r2(conf.reduce((a, b) => a + b, 0) / conf.length) : null,
        min_confidence: conf.length ? r2(Math.min(...conf)) : null,
        adapted_frames: points.filter((p) => p.adapted).length,
        pattern_contrast: r2(tracked.contrast),
        preview_path: previewPath,
        path: points.map((p) => [Math.round(p.time * 10000) / 10000, r2(p.x), r2(p.y), r2(p.confidence)]),
        path_format: "[time_s, x_px, y_px, confidence]",
      };

      if (!args.apply) return result;
      if (points.length < 2) {
        return { ...result, applied: false, message: "Fewer than two frames tracked, so no null was made." };
      }

      const expect: ExpectGuard = { project_path: args.apply.expect.project_path, comp_id: args.apply.expect.comp_id ?? args.comp_id };
      const times = points.map((p) => p.time);
      const values = points.map((p) => [p.x, p.y]);
      const write = await queued(ctx, `${label} apply`, opId, async () => {
        const guard = await verifyTargetGuard(ctx, expect, opId);
        const checkpoint = await autoCheckpoint(ctx, guard, "ae_track_point");
        const made = await ctx.bridge.evalRaw<{ layer_id: number; layer_index: number; name: string; numKeys: number }>({
          id: `${opId}_null`,
          script: buildJsxCall("createTrackNull", { comp_id: args.comp_id, name: args.apply!.null_name, times, values, expect }),
          label: `${label} create null`,
          mutates: true,
          toolName: "ae_track_point",
        });
        // Separate evalScript for the read-back.
        const after = await ctx.bridge.evalRaw<{ keyframes: Array<{ time: number; value: unknown }> }>({
          id: `${opId}_after`,
          script: buildJsxCall("getKeyframeEase", {
            comp_id: args.comp_id,
            layer: { id: made.result.layer_id },
            path: ["ADBE Transform Group", "ADBE Position"],
          }),
          label: `${label} (after)`,
          mutates: false,
          toolName: "ae_track_point",
        });
        return { checkpoint, made: made.result, after: after.result };
      });

      const mismatches: ReceiptMismatch[] = [];
      // AE always stores keyframes in ascending time order regardless of insertion order,
      // but `times`/`values` run backward for a backward track (end < start). Re-order the
      // read-back to match `values`' order before zipping index-for-index, or a backward
      // track compares every key against the wrong frame and reports spurious mismatches.
      const backward = times.length > 1 && times[0] > times[times.length - 1];
      const keysRaw = write.after?.keyframes ?? [];
      const keys = backward ? [...keysRaw].reverse() : keysRaw;
      if (write.made.numKeys !== points.length) {
        mismatches.push({ path: "numKeys", expected: points.length, actual: write.made.numKeys, message: "Key count differs from the tracked frames" });
      }
      keys.forEach((k, i) => compareValues(values[i].map(r2), (k.value as number[]).slice(0, 2).map(r2), `keyframes[${i + 1}].value`, mismatches));
      const receipt = buildReceipt({ before: null, after: { null: write.made, keys_read: keys.length }, customMismatches: mismatches });
      return {
        ...result,
        applied: true,
        null: { id: write.made.layer_id, index: write.made.layer_index, name: write.made.name, keys: write.made.numKeys },
        checkpoint: write.checkpoint,
        receipt,
      };
    },
  },
];
