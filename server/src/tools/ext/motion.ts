import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { PNG } from "pngjs";
import { z } from "zod";
import { BridgeError } from "../../host.js";
import { buildJsxCall } from "../../jsx.js";
import { QueueWaitError } from "../../queue.js";
import {
  AGENT_SAFETY_GUIDANCE,
  LayerSelectorSchema,
  type ToolContext,
  type ToolDefinition,
} from "../common.js";
import { defaultFramesDir } from "../render.js";
import { analyzeDecodedFrame, captureCompFrame, decodePngFile, type FrameFlag } from "./frames.js";
import {
  blit,
  createCanvas,
  drawLine,
  drawText,
  encodePng,
  fillRect,
  fitWithin,
  flattenOnChecker,
  GLYPH_HEIGHT,
  resizeArea,
  type Rgba,
  strokeRect,
  textWidth,
} from "./png-utils.js";

/**
 * Motion preview tools: let the agent see how a comp moves over time, not
 * just one frame. Read-only: frames come from `snapshotFrame` (saveFrameToPng
 * at full resolution), property values from `sampleProperty` (valueAtTime,
 * which leaves the comp's time alone), and every resize, composite or graph
 * is drawn on the Node side.
 */

export const MAX_SHEET_FRAMES = 24;
export const MAX_SHEET_EDGE = 2400;
const SHEET_GAP = 6;
const SHEET_BG: [number, number, number, number] = [24, 24, 24, 255];
const FLAG_COLOUR: [number, number, number, number] = [230, 40, 40, 255];

export const AeContactSheetSchema = z
  .object({
    comp_id: z.number().int().describe("CompItem ID to sample."),
    times: z
      .array(z.number().min(0))
      .min(2)
      .max(MAX_SHEET_FRAMES)
      .optional()
      .describe(
        `Explicit comp times in seconds (2 to ${MAX_SHEET_FRAMES}). Mutually exclusive with start/end/count.`
      ),
    start: z
      .number()
      .min(0)
      .optional()
      .describe("Range start in comp seconds. Default: the work area start."),
    end: z
      .number()
      .min(0)
      .optional()
      .describe("Range end in comp seconds (exclusive, like the work area end). Default: the work area end."),
    count: z
      .number()
      .int()
      .min(2)
      .max(MAX_SHEET_FRAMES)
      .optional()
      .describe(
        `How many frames to sample evenly across the range, first and last frame included (2 to ${MAX_SHEET_FRAMES}, default 12).`
      ),
    tile_size: z
      .number()
      .int()
      .min(64)
      .max(768)
      .optional()
      .describe(
        `Long edge in pixels of each tile (default 320). Tiles shrink further if the sheet would exceed ${MAX_SHEET_EDGE} px.`
      ),
    columns: z
      .number()
      .int()
      .min(1)
      .max(12)
      .optional()
      .describe("Number of columns. Default: chosen so the sheet is roughly 16:9."),
    labels: z
      .boolean()
      .optional()
      .describe("Draw the frame number and time on each tile (default true)."),
  })
  .superRefine((val, ctx) => {
    if (
      val.times !== undefined &&
      (val.start !== undefined || val.end !== undefined || val.count !== undefined)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["times"],
        message: "Give either `times`, or a range (`start`/`end`/`count`), not both.",
      });
    }
    if (val.start !== undefined && val.end !== undefined && val.end <= val.start) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["end"],
        message: "`end` must be after `start`.",
      });
    }
  });

export type AeContactSheetArgs = z.infer<typeof AeContactSheetSchema>;

export interface CompTiming {
  fps: number;
  duration: number;
  workAreaStart: number;
  workAreaDuration: number;
}

export interface SampledTime {
  time: number;
  frame: number;
}

/**
 * Picks the frames for a contact sheet. A range samples `count` frames evenly
 * on the comp's frame grid, first and last included; `end` is exclusive, so
 * the last frame is the one before it. Duplicates are dropped when the range
 * holds fewer frames than `count`.
 */
export function contactSheetTimes(
  comp: CompTiming,
  opts: { times?: number[]; start?: number; end?: number; count?: number }
): SampledTime[] {
  const fps = comp.fps > 0 ? comp.fps : 25;
  if (opts.times !== undefined) {
    return opts.times.map((t) => {
      if (t > comp.duration) {
        throw new Error(`Time ${t}s is past the comp's duration (${comp.duration}s).`);
      }
      return { time: t, frame: Math.round(t * fps) };
    });
  }

  const start = opts.start ?? comp.workAreaStart;
  const end = Math.min(opts.end ?? comp.workAreaStart + comp.workAreaDuration, comp.duration);
  if (end <= start) {
    throw new Error(`Empty range: start ${start}s, end ${end}s (comp duration ${comp.duration}s).`);
  }
  const firstFrame = Math.round(start * fps);
  const lastFrame = Math.max(firstFrame, Math.ceil(end * fps - 1e-6) - 1);
  const span = lastFrame - firstFrame;
  const count = Math.min(opts.count ?? 12, span + 1);

  const frames: number[] = [];
  for (let i = 0; i < count; i++) {
    const f = count === 1 ? firstFrame : Math.round(firstFrame + (i * span) / (count - 1));
    if (frames[frames.length - 1] !== f) frames.push(f);
  }
  return frames.map((frame) => ({ frame, time: frame / fps }));
}

/** Columns that make a sheet of `n` tiles roughly 16:9. */
export function chooseColumns(n: number, tileWidth: number, tileHeight: number): number {
  const cols = Math.round(Math.sqrt((n * (16 / 9) * tileHeight) / tileWidth));
  return Math.max(1, Math.min(n, cols));
}

export interface SheetLayout {
  tileWidth: number;
  tileHeight: number;
  /** Height of the label strip under each tile (0 without labels). */
  labelHeight: number;
  textScale: number;
  columns: number;
  rows: number;
  width: number;
  height: number;
}

function labelMetrics(tileHeight: number, labels: boolean): { labelHeight: number; textScale: number } {
  const textScale = tileHeight >= 90 ? 2 : 1;
  return { labelHeight: labels ? GLYPH_HEIGHT * textScale + 4 * textScale : 0, textScale };
}

/**
 * Tile size, columns and rows for a sheet, shrinking tiles to keep it under
 * MAX_SHEET_EDGE. Labels get their own strip under each tile, so they never
 * cover the bottom of the frame (where lower thirds and subtitles live).
 */
export function sheetLayout(
  n: number,
  compWidth: number,
  compHeight: number,
  tileSize: number,
  columns?: number,
  labels: boolean = true
): SheetLayout {
  let tile = fitWithin(compWidth, compHeight, tileSize);
  const cols = Math.max(1, Math.min(n, columns ?? chooseColumns(n, tile.width, tile.height)));
  const rows = Math.ceil(n / cols);
  const sheetW = (t: { width: number }) => cols * t.width + (cols + 1) * SHEET_GAP;
  const sheetH = (t: { height: number }) =>
    rows * (t.height + labelMetrics(t.height, labels).labelHeight) + (rows + 1) * SHEET_GAP;

  let longest = Math.max(sheetW(tile), sheetH(tile));
  for (let size = Math.max(tile.width, tile.height); longest > MAX_SHEET_EDGE && size > 16; ) {
    size = Math.max(16, Math.floor((size * MAX_SHEET_EDGE) / longest) - 1);
    tile = fitWithin(compWidth, compHeight, size);
    longest = Math.max(sheetW(tile), sheetH(tile));
  }
  const { labelHeight, textScale } = labelMetrics(tile.height, labels);
  return {
    tileWidth: tile.width,
    tileHeight: tile.height,
    labelHeight,
    textScale,
    columns: cols,
    rows,
    width: sheetW(tile),
    height: sheetH(tile),
  };
}

export interface SheetTile {
  image: PNG;
  label?: string;
  flagged: boolean;
}

/**
 * Lays tiles out on a dark sheet. Each tile is flattened over a mid-grey
 * checkerboard so transparency stays visible and white and black elements
 * both stand out; flagged tiles (blank, black, transparent) get a red border;
 * labels sit in their own strip under each tile.
 */
export function buildContactSheet(tiles: SheetTile[], layout: SheetLayout): PNG {
  const sheet = createCanvas(layout.width, layout.height, SHEET_BG);
  const pad = 2 * layout.textScale;

  tiles.forEach((tile, i) => {
    const col = i % layout.columns;
    const row = Math.floor(i / layout.columns);
    const x = SHEET_GAP + col * (layout.tileWidth + SHEET_GAP);
    const y = SHEET_GAP + row * (layout.tileHeight + layout.labelHeight + SHEET_GAP);

    const small =
      tile.image.width === layout.tileWidth && tile.image.height === layout.tileHeight
        ? tile.image
        : resizeArea(tile.image, layout.tileWidth, layout.tileHeight);
    blit(sheet, flattenOnChecker(small, 8, 112, 88), x, y);

    if (tile.label && layout.labelHeight > 0) {
      fillRect(sheet, x, y + layout.tileHeight, layout.tileWidth, layout.labelHeight, [0, 0, 0, 255]);
      drawText(sheet, tile.label, x + pad, y + layout.tileHeight + pad, layout.textScale, [255, 255, 255, 255]);
    }
    if (tile.flagged) {
      strokeRect(sheet, x, y, layout.tileWidth, layout.tileHeight, 3, FLAG_COLOUR);
    }
  });
  return sheet;
}

export function frameLabel(sample: SampledTime): string {
  return `f${sample.frame} ${sample.time.toFixed(2)}s`;
}

// ---------- Motion graph ----------

const DIM_COLOURS: Rgba[] = [
  [235, 80, 80, 255],
  [90, 200, 90, 255],
  [90, 150, 255, 255],
  [200, 200, 200, 255],
];
const SPEED_COLOUR: Rgba = [240, 240, 240, 255];
const KEY_COLOUR: Rgba = [255, 200, 60, 255];
const KEY_LINE: Rgba = [255, 200, 60, 90];
const PANEL_BG: Rgba = [40, 40, 40, 255];
const GRID_COLOUR: Rgba = [62, 62, 62, 255];
const AXIS_LABEL: Rgba = [200, 200, 200, 255];

export const AeMotionGraphSchema = z
  .object({
    comp_id: z.number().int().describe("CompItem ID that holds the layer."),
    layer: LayerSelectorSchema,
    path: z
      .array(z.string().min(1))
      .min(1)
      .describe(
        "Property path from the layer, by match name or display name, e.g. ['ADBE Transform Group', 'ADBE Position'] or ['Effects', 'Gaussian Blur', 'Blurriness']. The property must hold a number, vector or colour."
      ),
    start: z
      .number()
      .min(0)
      .optional()
      .describe("Range start in comp seconds. Default: the first keyframe, or the work area start without keyframes."),
    end: z
      .number()
      .min(0)
      .optional()
      .describe("Range end in comp seconds. Default: the last keyframe, or the work area end without keyframes."),
    step: z
      .number()
      .positive()
      .optional()
      .describe("Seconds between samples. Default: one comp frame. Capped at 1000 samples by widening the step."),
    width: z.number().int().min(320).max(2048).optional().describe("Graph width in pixels (default 960)."),
    height: z.number().int().min(200).max(2048).optional().describe("Graph height in pixels (default 540)."),
    include_samples: z
      .boolean()
      .optional()
      .describe("Also return every sample as `sample_table` (default false; the graph and summary are usually enough)."),
  })
  .superRefine((val, ctx) => {
    if (val.start !== undefined && val.end !== undefined && val.end <= val.start) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["end"],
        message: "`end` must be after `start`.",
      });
    }
  });

export type AeMotionGraphArgs = z.infer<typeof AeMotionGraphSchema>;

export interface PropertyKey {
  index: number;
  time: number;
  value: number[];
  in_interp: string;
  out_interp: string;
  in_ease?: Array<{ speed: number; influence: number }>;
  out_ease?: Array<{ speed: number; influence: number }>;
}

/** What `sampleProperty` in motion.jsx returns. */
export interface PropertySamples {
  comp: { id: number; name: string; fps: number };
  layer: { index: number; id: number; name: string };
  property: {
    name: string;
    matchName: string;
    value_type: string;
    spatial: boolean;
    dimensions: number;
    num_keys: number;
    keys_truncated: boolean;
    expression: boolean;
  };
  start: number;
  end: number;
  step: number;
  times: number[];
  values: number[][];
  keys: PropertyKey[];
}

/** Speed over the interval between sample i and i + 1, at its midpoint. */
export interface SpeedSample {
  time: number;
  speed: number | null;
}

function distanceBetween(a: number[], b: number[]): number {
  let sum = 0;
  for (let d = 0; d < Math.min(a.length, b.length); d++) sum += (b[d] - a[d]) ** 2;
  return Math.sqrt(sum);
}

/**
 * Speed between consecutive samples: the length of the change across all
 * dimensions per second (px/s for position). A hold keyframe keeps its value
 * until the next key and then jumps; the interval holding that jump is not
 * motion, so its speed is null. A key that lands on a sample (within float
 * error) jumps in the interval ending there: AE gives the new value at the
 * key's own time.
 */
export function sampleSpeeds(s: Pick<PropertySamples, "times" | "values" | "keys">): SpeedSample[] {
  const jumps = s.keys.filter((_k, i) => i > 0 && s.keys[i - 1].out_interp === "hold").map((k) => k.time);
  const out: SpeedSample[] = [];
  for (let i = 0; i + 1 < s.times.length; i++) {
    const t0 = s.times[i];
    const t1 = s.times[i + 1];
    const isJump = jumps.some((t) => t > t0 + 1e-6 && t <= t1 + 1e-6);
    out.push({
      time: (t0 + t1) / 2,
      speed: isJump || t1 <= t0 ? null : distanceBetween(s.values[i], s.values[i + 1]) / (t1 - t0),
    });
  }
  return out;
}

export type SegmentProfile =
  | "hold"
  | "static"
  | "constant"
  | "ease in-out"
  | "speeds up"
  | "slows down"
  | "uneven";

export interface MotionSegment {
  from_key: number;
  to_key: number;
  start: number;
  end: number;
  distance: number;
  start_speed: number;
  end_speed: number;
  peak_speed: number;
  /** Where the peak falls, from 0 (first key) to 1 (second key); null when nothing moves. */
  peak_at: number | null;
  profile: SegmentProfile;
}

/**
 * Names how speed changes between two keys. "Slow" means under half the
 * segment's peak: an Easy Ease starts and ends near zero, while linear keys
 * keep one speed throughout.
 */
export function segmentProfile(startSpeed: number, endSpeed: number, peak: number, hold: boolean): SegmentProfile {
  if (hold) return "hold";
  if (peak < 1e-6) return "static";
  const s = startSpeed / peak;
  const e = endSpeed / peak;
  if (s > 0.8 && e > 0.8) return "constant";
  if (s < 0.5 && e < 0.5) return "ease in-out";
  if (s < 0.5 && e > 0.8) return "speeds up";
  if (s > 0.8 && e < 0.5) return "slows down";
  return "uneven";
}

export interface MotionAnalysis {
  speed: { peak: number; peak_time: number | null; mean: number };
  distance: number;
  value: { start: number[]; end: number[]; min: number[]; max: number[] };
  /** Dimensions whose sampled value goes past the range of the keyframe values. */
  overshoot: Array<{ dimension: number; below_keys_by: number; above_keys_by: number }>;
  segments: MotionSegment[];
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

export function analyzeMotion(s: PropertySamples, speeds: SpeedSample[]): MotionAnalysis {
  const dims = s.values[0]?.length ?? 0;
  const min: number[] = [];
  const max: number[] = [];
  for (let d = 0; d < dims; d++) {
    min.push(Math.min(...s.values.map((v) => v[d])));
    max.push(Math.max(...s.values.map((v) => v[d])));
  }

  let peak = 0;
  let peakTime: number | null = null;
  let distance = 0;
  let movingTime = 0;
  speeds.forEach((sp, i) => {
    if (sp.speed === null) return;
    const dt = s.times[i + 1] - s.times[i];
    distance += sp.speed * dt;
    movingTime += dt;
    if (sp.speed > peak) {
      peak = sp.speed;
      peakTime = sp.time;
    }
  });

  const overshoot: MotionAnalysis["overshoot"] = [];
  if (s.keys.length >= 2) {
    for (let d = 0; d < dims; d++) {
      const keyMin = Math.min(...s.keys.map((k) => k.value[d]));
      const keyMax = Math.max(...s.keys.map((k) => k.value[d]));
      const tol = Math.max(1e-3, (keyMax - keyMin) * 1e-3);
      const below = keyMin - min[d] > tol ? keyMin - min[d] : 0;
      const above = max[d] - keyMax > tol ? max[d] - keyMax : 0;
      if (below > 0 || above > 0) {
        overshoot.push({ dimension: d, below_keys_by: r3(below), above_keys_by: r3(above) });
      }
    }
  }

  const segments: MotionSegment[] = [];
  for (let k = 0; k + 1 < s.keys.length; k++) {
    const a = s.keys[k];
    const b = s.keys[k + 1];
    const inside: Array<{ speed: number; time: number; dt: number }> = [];
    speeds.forEach((sp, i) => {
      if (sp.speed === null || sp.time < a.time || sp.time > b.time) return;
      inside.push({ speed: sp.speed, time: sp.time, dt: s.times[i + 1] - s.times[i] });
    });
    if (inside.length === 0) continue;
    let segPeak = inside[0];
    for (const p of inside) if (p.speed > segPeak.speed) segPeak = p;
    const startSpeed = inside[0].speed;
    const endSpeed = inside[inside.length - 1].speed;
    segments.push({
      from_key: a.index,
      to_key: b.index,
      start: r3(a.time),
      end: r3(b.time),
      distance: r3(inside.reduce((sum, p) => sum + p.speed * p.dt, 0)),
      start_speed: r3(startSpeed),
      end_speed: r3(endSpeed),
      peak_speed: r3(segPeak.speed),
      peak_at: segPeak.speed < 1e-6 ? null : Math.round(((segPeak.time - a.time) / (b.time - a.time)) * 100) / 100,
      profile: segmentProfile(startSpeed, endSpeed, segPeak.speed, a.out_interp === "hold"),
    });
  }

  return {
    speed: { peak: r3(peak), peak_time: peakTime === null ? null : r3(peakTime), mean: movingTime > 0 ? r3(distance / movingTime) : 0 },
    distance: r3(distance),
    value: {
      start: (s.values[0] ?? []).map(r3),
      end: (s.values[s.values.length - 1] ?? []).map(r3),
      min: min.map(r3),
      max: max.map(r3),
    },
    overshoot,
    segments,
  };
}

/** Short axis label: fewer decimals for bigger numbers, never exponent notation. */
export function formatNumber(v: number): string {
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 100) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  return v.toFixed(3);
}

/**
 * Draws the graph: values per dimension on top (red, green, blue, grey for
 * X, Y, Z, W), speed underneath, keyframes as yellow lines labelled #n with a
 * dot on each key value. The speed line breaks at hold jumps.
 */
export function renderMotionGraph(s: PropertySamples, speeds: SpeedSample[], width: number, height: number): PNG {
  const scale = height >= 300 ? 2 : 1;
  const glyphH = GLYPH_HEIGHT * scale;
  const dims = s.values[0]?.length ?? 0;

  let vmin = Infinity;
  let vmax = -Infinity;
  for (const v of s.values) {
    for (const x of v) {
      vmin = Math.min(vmin, x);
      vmax = Math.max(vmax, x);
    }
  }
  if (!Number.isFinite(vmin)) {
    vmin = 0;
    vmax = 1;
  } else if (vmax - vmin < 1e-9) {
    const pad = Math.max(1, Math.abs(vmin) * 0.1);
    vmin -= pad;
    vmax += pad;
  }
  let peak = 0;
  for (const sp of speeds) if (sp.speed !== null && sp.speed > peak) peak = sp.speed;
  const speedMax = peak > 0 ? peak : 1;

  const yLabels = [formatNumber(vmax), formatNumber(vmin), formatNumber(peak), "0"];
  const left = Math.max(...yLabels.map((l) => textWidth(l, scale))) + 4 * scale + 6;
  const right = 4 * scale + 6;
  const top = glyphH + 8;
  const bottom = glyphH + 8;
  // Room between the panels so the value's min label and the speed's peak label don't touch.
  const gap = glyphH + 8;
  const plotW = Math.max(1, width - left - right);
  const plotH = Math.max(1, Math.floor((height - top - bottom - gap) / 2));
  const valueTop = top;
  const speedTop = top + plotH + gap;
  const span = s.end - s.start > 0 ? s.end - s.start : 1;
  const xOf = (t: number) => left + Math.round(((t - s.start) / span) * (plotW - 1));
  const yValue = (v: number) => valueTop + Math.round((1 - (v - vmin) / (vmax - vmin)) * (plotH - 1));
  const ySpeed = (v: number) => speedTop + Math.round((1 - v / speedMax) * (plotH - 1));

  const img = createCanvas(width, height, SHEET_BG);
  for (const panelTop of [valueTop, speedTop]) {
    fillRect(img, left, panelTop, plotW, plotH, PANEL_BG);
    fillRect(img, left, panelTop + Math.floor(plotH / 2), plotW, 1, GRID_COLOUR);
  }

  const keysInRange = s.keys.filter((k) => k.time >= s.start - 1e-6 && k.time <= s.end + 1e-6);
  let labelRight = -Infinity;
  for (const k of keysInRange) {
    const x = xOf(k.time);
    fillRect(img, x, valueTop, 1, speedTop + plotH - valueTop, KEY_LINE);
    const label = `#${k.index}`;
    const w = textWidth(label, scale);
    const lx = Math.min(Math.max(0, x - Math.floor(w / 2)), width - w);
    if (lx > labelRight + 2 * scale) {
      drawText(img, label, lx, top - glyphH - 4, scale, KEY_COLOUR);
      labelRight = lx + w;
    }
  }

  for (let d = 0; d < dims; d++) {
    const colour = DIM_COLOURS[d % DIM_COLOURS.length];
    for (let i = 0; i + 1 < s.times.length; i++) {
      drawLine(img, xOf(s.times[i]), yValue(s.values[i][d]), xOf(s.times[i + 1]), yValue(s.values[i + 1][d]), 2, colour);
    }
  }
  for (const k of keysInRange) {
    for (let d = 0; d < Math.min(dims, k.value.length); d++) {
      fillRect(img, xOf(k.time) - 2, yValue(k.value[d]) - 2, 5, 5, KEY_COLOUR);
    }
  }

  // Speed through interval midpoints; an interval with no moving neighbour
  // (between two jumps, or the only one) is drawn flat across its span.
  for (let i = 0; i < speeds.length; i++) {
    const sp = speeds[i].speed;
    if (sp === null) continue;
    const next = speeds[i + 1]?.speed ?? null;
    const prev = speeds[i - 1]?.speed ?? null;
    if (next !== null) {
      drawLine(img, xOf(speeds[i].time), ySpeed(sp), xOf(speeds[i + 1].time), ySpeed(next), 2, SPEED_COLOUR);
    } else if (prev === null) {
      drawLine(img, xOf(s.times[i]), ySpeed(sp), xOf(s.times[i + 1]), ySpeed(sp), 2, SPEED_COLOUR);
    }
  }

  const rightAlign = (text: string, x: number, y: number) =>
    drawText(img, text, x - textWidth(text, scale), y, scale, AXIS_LABEL);
  rightAlign(yLabels[0], left - 6, valueTop);
  rightAlign(yLabels[1], left - 6, valueTop + plotH - glyphH);
  rightAlign(yLabels[2], left - 6, speedTop);
  rightAlign(yLabels[3], left - 6, speedTop + plotH - glyphH);
  drawText(img, `${s.start.toFixed(2)}s`, left, height - bottom + 4, scale, AXIS_LABEL);
  rightAlign(`${s.end.toFixed(2)}s`, left + plotW, height - bottom + 4);
  return img;
}

async function runQueued<T>(ctx: ToolContext, label: string, opId: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await ctx.queue.run(label, fn);
  } catch (err) {
    if (err instanceof QueueWaitError) {
      throw new BridgeError({ kind: "queued", op_id: opId, message: err.message });
    }
    throw err;
  }
}

export const motionTools: ToolDefinition<any>[] = [
  {
    name: "ae_contact_sheet",
    description:
      "READ-ONLY. Shows how a comp moves over time in ONE image: samples 2 to 24 frames (default 12, evenly across the work area, or a `start`/`end` range, or explicit `times`), renders each at full resolution with saveFrameToPng, shrinks them on the server and tiles them into a single PNG with frame/time labels. " +
      "Transparency shows as a checkerboard; blank, black or fully transparent frames get a red border and are listed in `flagged_frames`. Look at the returned `path` to judge timing, spacing and composition across the shot; each tile's full-resolution PNG is in `frames[].path`. " +
      "Every frame is a render, so heavy comps take a while: start with fewer frames. The comp is never modified. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeContactSheetSchema,
    handler: async (args: AeContactSheetArgs, ctx: ToolContext) => {
      const framesDir = defaultFramesDir();
      fs.mkdirSync(framesDir, { recursive: true });
      const opId = ctx.bridge.newOpId();

      const captured = await runQueued(ctx, `ae_contact_sheet(${args.comp_id})`, opId, async () => {
        const compResp = await ctx.bridge.evalRaw<Record<string, any>>({
          id: `${opId}_comp`,
          script: buildJsxCall("getComp", { comp_id: args.comp_id }),
          label: `ae_contact_sheet(${args.comp_id}) getComp`,
          mutates: false,
          toolName: "ae_contact_sheet",
        });
        const comp = compResp.result;
        const samples = contactSheetTimes(
          {
            fps: Number(comp.fps),
            duration: Number(comp.duration),
            workAreaStart: Number(comp.workAreaStart),
            workAreaDuration: Number(comp.workAreaDuration),
          },
          args
        );

        const shots: Array<SampledTime & { path: string }> = [];
        for (let i = 0; i < samples.length; i++) {
          const snap = await captureCompFrame({
            ctx,
            opId,
            compId: args.comp_id,
            time: samples[i].time,
            frameIndex: i,
            framesDir,
            toolName: "ae_contact_sheet",
          });
          shots.push({ ...samples[i], path: snap.path });
        }
        return { comp, shots };
      });

      const { comp, shots } = captured;
      const showLabels = args.labels ?? true;
      const layout = sheetLayout(
        shots.length,
        Number(comp.width),
        Number(comp.height),
        args.tile_size ?? 320,
        args.columns,
        showLabels
      );

      // Decode one frame at a time and keep only its shrunk tile, so a 4K comp
      // doesn't hold 24 full frames in memory.
      const tiles: SheetTile[] = [];
      const frames: Array<{ index: number; frame: number; time: number; path: string; flags: FrameFlag[] }> = [];
      shots.forEach((shot, index) => {
        const full = decodePngFile(shot.path);
        const analysis = analyzeDecodedFrame(full, { index, path: shot.path, time: shot.time });
        tiles.push({
          image: resizeArea(full, layout.tileWidth, layout.tileHeight),
          label: showLabels ? frameLabel(shot) : undefined,
          flagged: analysis.flags.length > 0,
        });
        frames.push({ index, frame: shot.frame, time: shot.time, path: shot.path, flags: analysis.flags });
      });

      const sheet = buildContactSheet(tiles, layout);
      const sheetPath = path.join(
        framesDir,
        `contact_c${args.comp_id}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.png`
      );
      fs.writeFileSync(sheetPath, encodePng(sheet));

      return {
        ok: true,
        path: sheetPath,
        width: layout.width,
        height: layout.height,
        columns: layout.columns,
        rows: layout.rows,
        tile_width: layout.tileWidth,
        tile_height: layout.tileHeight,
        comp: {
          id: comp.id,
          name: comp.name,
          width: comp.width,
          height: comp.height,
          fps: comp.fps,
          duration: comp.duration,
        },
        frames,
        flagged_frames: frames.filter((f) => f.flags.length > 0).map((f) => ({ index: f.index, time: f.time, flags: f.flags })),
      };
    },
  },
  {
    name: "ae_motion_graph",
    description:
      "READ-ONLY. Graphs how one property changes over time, like AE's graph editor, in one PNG: the value per dimension on top (red, green, blue for X, Y, Z), the speed underneath, and keyframes as yellow lines labelled #1, #2... " +
      "The property is sampled with expressions applied (one sample per frame by default, at most 1000), so the graph shows what the viewer sees. " +
      "Also returns the numbers: peak and mean speed, the value range, `overshoot` past the keyframe values, and per pair of keyframes a `segments[].profile` (constant, ease in-out, speeds up, slows down, hold, static, uneven). " +
      "Use it to check easing and timing, or to compare before and after an ease change. Speed is the change across all dimensions per second (px/s for position). The comp is never modified, not even its current time. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeMotionGraphSchema,
    handler: async (args: AeMotionGraphArgs, ctx: ToolContext) => {
      const res = await ctx.bridge.callHost<PropertySamples>(
        "sampleProperty",
        {
          comp_id: args.comp_id,
          layer: args.layer,
          path: args.path,
          start: args.start,
          end: args.end,
          step: args.step,
        },
        { label: `ae_motion_graph(${args.comp_id})`, mutates: false, toolName: "ae_motion_graph" }
      );
      const samples = res.result;
      const speeds = sampleSpeeds(samples);
      const analysis = analyzeMotion(samples, speeds);

      const width = args.width ?? 960;
      const height = args.height ?? 540;
      const framesDir = defaultFramesDir();
      fs.mkdirSync(framesDir, { recursive: true });
      const graphPath = path.join(
        framesDir,
        `graph_c${args.comp_id}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.png`
      );
      fs.writeFileSync(graphPath, encodePng(renderMotionGraph(samples, speeds, width, height)));

      return {
        ok: true,
        path: graphPath,
        width,
        height,
        comp: samples.comp,
        layer: samples.layer,
        property: samples.property,
        start: r3(samples.start),
        end: r3(samples.end),
        step: Math.round(samples.step * 1e6) / 1e6,
        samples: samples.times.length,
        speed: { unit: samples.property.spatial ? "px/s" : "units/s", ...analysis.speed },
        distance: analysis.distance,
        value: analysis.value,
        overshoot: analysis.overshoot,
        segments: analysis.segments,
        keys: samples.keys.map((k) => ({ ...k, time: r3(k.time), value: k.value.map(r3) })),
        ...(args.include_samples
          ? {
              // speed_after: speed from this sample to the next (null at the last sample and across a hold jump).
              sample_table: samples.times.map((t, i) => ({
                time: r3(t),
                value: samples.values[i].map(r3),
                speed_after: i < speeds.length && speeds[i].speed !== null ? r3(speeds[i].speed as number) : null,
              })),
            }
          : {}),
      };
    },
  },
];
