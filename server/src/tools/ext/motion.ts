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
  // A range narrower than one frame would otherwise silently collapse to a
  // single-tile "sheet", breaking the 2-to-24-frame contract this tool
  // promises (and its own schema's `count` minimum of 2).
  if (span === 0) {
    throw new Error(
      `Range ${start}s to ${end}s covers only one frame at ${fps}fps; widen it to sample at least 2 frames.`
    );
  }
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
      .array(z.union([z.string().min(1), z.number().int().positive()]))
      .min(1)
      .describe(
        "Property path from the layer, by match name or display name, e.g. ['ADBE Transform Group', 'ADBE Position'] or ['Effects', 'Gaussian Blur', 'Blurriness']. The property must hold a number, vector or colour. " +
          "A step may be a 1-based positional index instead of a name for a sibling inside an indexed group (effects, masks, shape layer contents), where siblings can share a display name."
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
  /** Roving: AE times the key for an even speed, often between frames. */
  roving?: boolean;
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
    samples_capped: boolean;
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
    // Only intervals wholly between the two keys. One that straddles a key
    // (a key between frames) blends both segments' speeds, so it counts for
    // neither: measured on AE 26.2.1, a 160 then 240 px/s linear move gave a
    // 200 px/s straddling interval that made the first segment look uneven.
    const inside: Array<{ speed: number; time: number; dt: number }> = [];
    speeds.forEach((sp, i) => {
      if (sp.speed === null || s.times[i] < a.time - 1e-6 || s.times[i + 1] > b.time + 1e-6) return;
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

  // The speed panel's top always maps to speedMax (not necessarily the real
  // peak: when nothing moves, peak is 0 but speedMax falls back to 1 so the
  // panel has a scale to draw against) - label it with what the axis top
  // actually represents, or "peak 0" would be drawn at a position that isn't 0.
  const yLabels = [formatNumber(vmax), formatNumber(vmin), formatNumber(speedMax), "0"];
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

// ---------- Motion review ----------

/** A step may be a match/display name, or a 1-based positional index for a
 * sibling inside an indexed group (effects, masks, shape contents) where
 * siblings can share a name - see listAnimatedProperties in motion.jsx. */
export type PropertyPath = Array<string | number>;

export type FindingKind =
  | "linear"
  | "abrupt_start"
  | "abrupt_stop"
  | "speed_jump"
  | "overshoot"
  | "subframe_key"
  | "cut_off"
  | "outside_safe";
export type FindingSeverity = "medium" | "low" | "info";

export interface MotionFinding {
  severity: FindingSeverity;
  kind: FindingKind;
  layer: { index: number; id: number; name: string };
  property: { name: string; path: PropertyPath };
  keys: number[];
  time: number;
  message: string;
  /** A ready-to-run ae_set_keyframe_ease call. Apply it only after the user agrees. */
  fix?: { tool: "ae_set_keyframe_ease"; args: Record<string, unknown> };
  /** Frame and safe-area findings: the layer's box in comp pixels [left, top, right, bottom]. */
  bounds?: [number, number, number, number];
  /** Frame and safe-area findings: how far to move the layer, in comp pixels, to bring it inside. */
  suggested_shift?: [number, number];
}

// Properties where constant-speed timing reads as mechanical. Elsewhere
// (opacity fades, effect parameters) linear keys are often deliberate, so
// those findings are low severity.
const MOTION_MATCH_NAMES = new Set([
  "ADBE Position",
  "ADBE Position_0",
  "ADBE Position_1",
  "ADBE Position_2",
  "ADBE Anchor Point",
  "ADBE Scale",
  "ADBE Rotate Z",
  "ADBE Rotate X",
  "ADBE Rotate Y",
  "ADBE Orientation",
]);

const SEVERITY_ORDER: Record<FindingSeverity, number> = { medium: 0, low: 1, info: 2 };

/** Where the fix calls point: the comp and the guard they must pass. */
export interface ReviewTarget {
  comp_id: number;
  project_path: string;
}

const isMoving = (g: MotionSegment) => g.profile !== "hold" && g.profile !== "static";

/** The parts of the user's taste (ae_taste) the review follows. */
export interface ReviewTaste {
  preferred_ease?: number[] | null;
  allow_linear_non_motion?: boolean;
  avoid_overshoot?: boolean;
}

/**
 * The ease a fix applies at the keys where a move starts or stops: easy
 * ease, or the handle lengths of the user's preferred curve. Speed stays 0
 * either way, since those keys begin or end the move.
 */
export function fixEase(taste: ReviewTaste | undefined): { ease: unknown; name: string } {
  const c = taste?.preferred_ease;
  if (!c || c.length !== 4) return { ease: "easy_ease", name: "Easy ease" };
  const influence = (v: number) => Math.min(100, Math.max(0.1, Math.round(v * 1000) / 10));
  return {
    ease: { in: { speed: 0, influence: influence(1 - c[2]) }, out: { speed: 0, influence: influence(c[0]) } },
    name: "Your preferred ease",
  };
}

/**
 * Finds what an animator would flag in one property, from its samples and
 * their analysis. Thresholds are relative to each segment's own peak speed,
 * so they work the same for pixels, degrees and percent.
 */
export function reviewProperty(
  s: PropertySamples,
  analysis: MotionAnalysis,
  speeds: SpeedSample[],
  path: PropertyPath,
  target: ReviewTarget,
  taste?: ReviewTaste
): MotionFinding[] {
  const findings: MotionFinding[] = [];
  const motion = MOTION_MATCH_NAMES.has(s.property.matchName);
  // The user said linear timing off position, scale and rotation is on purpose.
  const timingOk = !motion && taste?.allow_linear_non_motion === true;
  const unit = s.property.spatial ? "px/s" : "/s";
  const base = {
    layer: s.layer,
    property: { name: s.property.name, path },
  };
  const { ease: easeArg, name: easeName } = fixEase(taste);
  const fix = (keys: number[], extra: Record<string, unknown> = {}) => ({
    tool: "ae_set_keyframe_ease" as const,
    args: {
      comp_id: target.comp_id,
      layer: { id: s.layer.id },
      path,
      keys,
      ease: easeArg,
      ...extra,
      expect: { project_path: target.project_path, comp_id: target.comp_id },
    },
  });
  const segs = analysis.segments;
  const propPeak = analysis.speed.peak;
  // Samples past the last key exist only for expression-driven properties
  // (see ae_motion_review); motion there means the key is not a dead stop.
  const keepsMovingAfter = (time: number, speed: number) => {
    const next = speeds.find((sp) => sp.time > time + 1e-6 && sp.speed !== null);
    return next !== undefined && (next.speed as number) > 0.3 * speed;
  };

  // Constant-speed runs. Neighbouring linear segments at about the same
  // speed are one move, so they become one finding whose fix eases only the
  // ends and keeps the move continuous through the keys in between.
  for (let i = 0; i < segs.length; i++) {
    if (timingOk || segs[i].profile !== "constant") continue;
    let j = i;
    while (
      j + 1 < segs.length &&
      segs[j + 1].profile === "constant" &&
      Math.min(segs[j].peak_speed, segs[j + 1].peak_speed) / Math.max(segs[j].peak_speed, segs[j + 1].peak_speed) > 0.75
    ) {
      j++;
    }
    const from = segs[i].from_key;
    const to = segs[j].to_key;
    // Measured on AE 26.2.1: the keys in between keep their linear speed, so
    // the eased move dips there (about 15% for one middle key). Roving them
    // gives one smooth curve; AE allows roving on spatial properties only.
    const many = j - i > 1;
    const rove = j > i && s.property.spatial;
    let middle = "";
    if (rove) {
      middle = ` The fix also makes the key${many ? "s" : ""} in between roving, so the move keeps one smooth speed through ${many ? "them" : "it"} (AE retimes ${many ? "them" : "it"}).`;
    } else if (j > i) {
      middle = ` The key${many ? "s" : ""} in between keep${many ? "" : "s"} ${many ? "their" : "its"} linear speed, which leaves a slight dip there; ${s.property.name} isn't spatial, so AE can't rove ${many ? "them" : "it"}. Match the speeds there in the graph editor if the dip shows.`;
    }
    findings.push({
      ...base,
      severity: motion ? "medium" : "low",
      kind: "linear",
      keys: [from, to],
      time: segs[i].start,
      message: `${s.property.name} runs at one constant speed (${formatNumber(segs[i].peak_speed)} ${unit}) from key ${from} to key ${to} (${segs[i].start}s to ${segs[j].end}s), so it starts and stops abruptly and reads as mechanical. ${easeName} on keys ${from} and ${to} softens both ends.${middle}`,
      fix: fix([from, to], rove ? { rove_between: true } : {}),
    });
    i = j;
  }

  for (let i = 0; i < segs.length; i++) {
    const g = segs[i];
    if (timingOk || !isMoving(g) || g.profile === "constant" || g.peak_speed <= 0) continue;
    const startsHere = i === 0 || !isMoving(segs[i - 1]) || segs[i - 1].to_key !== g.from_key;
    const endsHere = i === segs.length - 1 || !isMoving(segs[i + 1]) || segs[i + 1].from_key !== g.to_key;
    if (startsHere && g.start_speed / g.peak_speed > 0.5) {
      findings.push({
        ...base,
        severity: motion ? "medium" : "low",
        kind: "abrupt_start",
        keys: [g.from_key],
        time: g.start,
        message: `${s.property.name} starts moving at ${Math.round((g.start_speed / g.peak_speed) * 100)}% of its top speed at key ${g.from_key} (${g.start}s), with no acceleration. ${easeName} on key ${g.from_key} eases it in.`,
        fix: fix([g.from_key]),
      });
    }
    if (endsHere && g.end_speed / g.peak_speed > 0.5 && !keepsMovingAfter(g.end, g.end_speed)) {
      findings.push({
        ...base,
        severity: motion ? "medium" : "low",
        kind: "abrupt_stop",
        keys: [g.to_key],
        time: g.end,
        message: `${s.property.name} stops dead at key ${g.to_key} (${g.end}s), arriving at ${Math.round((g.end_speed / g.peak_speed) * 100)}% of its top speed. ${easeName} on key ${g.to_key} lets it settle.`,
        fix: fix([g.to_key]),
      });
    }
  }

  // A jolt where one segment hands over to the next at a very different speed.
  for (let i = 0; i + 1 < segs.length; i++) {
    const a = segs[i];
    const b = segs[i + 1];
    if (!isMoving(a) || !isMoving(b) || a.to_key !== b.from_key) continue;
    const hi = Math.max(a.end_speed, b.start_speed);
    const lo = Math.min(a.end_speed, b.start_speed);
    if (hi < 0.25 * propPeak || lo > 0.3 * hi) continue;
    // From (nearly) stopped to fast, easing the key smooths it without
    // changing the move. Between two fast speeds it would add a stop, so no fix.
    const nearlyStopped = lo < 0.1 * hi;
    findings.push({
      ...base,
      severity: "medium",
      kind: "speed_jump",
      keys: [a.to_key],
      time: a.end,
      message:
        `${s.property.name} changes speed abruptly at key ${a.to_key} (${a.end}s): ${formatNumber(a.end_speed)} ${unit} in, ${formatNumber(b.start_speed)} ${unit} out.` +
        (nearlyStopped
          ? ` ${easeName} on key ${a.to_key} smooths the hand-over.`
          : " Match the speeds on both sides of the key (in the graph editor, or with an explicit ease)."),
      ...(nearlyStopped ? { fix: fix([a.to_key]) } : {}),
    });
  }

  for (const o of analysis.overshoot) {
    const d = o.dimension;
    const past = o.above_keys_by >= o.below_keys_by;
    let at = 0;
    for (let i = 1; i < s.values.length; i++) {
      if (past ? s.values[i][d] > s.values[at][d] : s.values[i][d] < s.values[at][d]) at = i;
    }
    const unwanted = taste?.avoid_overshoot === true;
    findings.push({
      ...base,
      severity: unwanted ? "low" : "info",
      kind: "overshoot",
      keys: [],
      time: r3(s.times[at]),
      message:
        `${s.property.name}${s.values[0].length > 1 ? ` (dimension ${d})` : ""} goes ${formatNumber(Math.max(o.above_keys_by, o.below_keys_by))} past its keyframe values around ${r3(s.times[at])}s. ` +
        (unwanted ? "The user prefers no overshoot." : "Fine for a bounce or settle; a mistake otherwise."),
    });
  }

  // One finding per property, however many of its keys are off the frame grid.
  const fps = s.comp.fps > 0 ? s.comp.fps : 25;
  const offGrid = s.keys
    .filter((k) => !k.roving)
    .map((k) => ({ index: k.index, time: k.time, frame: k.time * fps }))
    .filter((k) => Math.abs(k.frame - Math.round(k.frame)) > 0.01);
  if (offGrid.length > 0) {
    const list = (items: string[]) =>
      items.length === 1 ? items[0] : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
    const many = offGrid.length > 1;
    findings.push({
      ...base,
      severity: "low",
      kind: "subframe_key",
      keys: offGrid.map((k) => k.index),
      time: r3(offGrid[0].time),
      message:
        `${many ? "Keys" : "Key"} ${list(offGrid.map((k) => String(k.index)))} of ${s.property.name} ${many ? "sit" : "sits"} between frames ` +
        `(frame ${list(offGrid.map((k) => formatNumber(k.frame)))}), so no rendered frame lands on ${many ? "them" : "it"}. ` +
        `Move ${many ? "them" : "it"} to frame ${list(offGrid.map((k) => String(Math.round(k.frame))))}.`,
    });
  }
  return findings;
}

export function sortFindings(findings: MotionFinding[]): MotionFinding[] {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.layer.index - b.layer.index ||
      a.time - b.time
  );
}

// ---------- frame and safe areas ----------

/** What `layerBoundsAt` in motion.jsx returns. */
export interface LayerBounds {
  layer: { index: number; id: number; name: string };
  kind: "av" | "text" | "shape";
  checkable: boolean;
  reason: string | null;
  samples: Array<{ time: number; visible: boolean; rect: [number, number, number, number] | null }>;
}

export interface SafeAreas {
  /** Share of the width and height left as margin, both sides together (AE's default 10%). */
  action: number;
  /** For text (AE's default 20%). */
  title: number;
}

const TRANSFORM_MATCH_NAMES = new Set([
  "ADBE Position",
  "ADBE Position_0",
  "ADBE Position_1",
  "ADBE Anchor Point",
  "ADBE Scale",
  "ADBE Rotate Z",
]);

/**
 * When a layer is at rest: inside a hold or a still stretch between keys,
 * or after its last transform key (unless an expression keeps it moving),
 * and no transform property is moving then. `ancestors` are the sampled
 * properties of the layer's parents: layerBoundsAt composes their transforms,
 * so a time while a parent still moves is not rest. At most 10, the latest kept.
 */
export function restTimes(
  props: Array<{ samples: PropertySamples; analysis: MotionAnalysis }>,
  fps: number,
  ancestors: Array<{ samples: PropertySamples; analysis: MotionAnalysis }> = []
): number[] {
  const transform = props.filter((p) => TRANSFORM_MATCH_NAMES.has(p.samples.property.matchName));
  if (!transform.length) return [];
  const candidates: number[] = [];
  const moving: Array<[number, number]> = [];
  for (const p of transform) {
    for (const g of p.analysis.segments) {
      if (g.profile === "hold" || g.profile === "static") candidates.push((g.start + g.end) / 2);
      else moving.push([g.start, g.end]);
    }
    const keys = p.samples.keys;
    if (keys.length && !p.samples.property.expression) candidates.push(keys[keys.length - 1].time);
  }
  // Where the whole chain has stopped: a parent's last key or still stretch
  // after the layer's own last transform key, if no parent moves then.
  let ownLast = -Infinity;
  for (const p of transform) {
    const k = p.samples.keys;
    if (k.length) ownLast = Math.max(ownLast, k[k.length - 1].time);
  }
  for (const p of ancestors) {
    if (!TRANSFORM_MATCH_NAMES.has(p.samples.property.matchName)) continue;
    for (const g of p.analysis.segments) {
      if (g.profile === "hold" || g.profile === "static") {
        const mid = (g.start + g.end) / 2;
        if (mid > ownLast) candidates.push(mid);
      } else {
        moving.push([g.start, g.end]);
      }
    }
    const k = p.samples.keys;
    if (k.length && !p.samples.property.expression) {
      const t = k[k.length - 1].time;
      if (t > ownLast) candidates.push(t);
    }
  }
  const eps = 0.5 / (fps > 0 ? fps : 25);
  const still = candidates
    .filter((t) => !moving.some(([a, b]) => t > a + eps && t < b - eps))
    .sort((a, b) => a - b)
    .filter((t, i, a) => i === 0 || t - a[i - 1] > 2 * eps);
  return still.slice(-10).map((t) => r3(t));
}

const r1 = (x: number) => Math.round(x * 10) / 10;

/** The move that brings `rect` inside `box` (centred on an axis where it can't fit). */
export function shiftInto(rect: [number, number, number, number], box: [number, number, number, number]): [number, number] {
  const axis = (lo: number, hi: number, blo: number, bhi: number) => {
    if (hi - lo > bhi - blo) return (blo + bhi) / 2 - (lo + hi) / 2;
    if (lo < blo) return blo - lo;
    if (hi > bhi) return bhi - hi;
    return 0;
  };
  return [r1(axis(rect[0], rect[2], box[0], box[2])), r1(axis(rect[1], rect[3], box[1], box[3]))];
}

function edgesPast(rect: [number, number, number, number], box: [number, number, number, number]): string[] {
  const out: string[] = [];
  if (rect[0] < box[0] - 0.5) out.push(`left by ${Math.round(box[0] - rect[0])} px`);
  if (rect[2] > box[2] + 0.5) out.push(`right by ${Math.round(rect[2] - box[2])} px`);
  if (rect[1] < box[1] - 0.5) out.push(`top by ${Math.round(box[1] - rect[1])} px`);
  if (rect[3] > box[3] + 0.5) out.push(`bottom by ${Math.round(rect[3] - box[3])} px`);
  return out;
}

/**
 * Frame and safe-area findings for one layer at its rest times. Layers that
 * fill most of the frame (backgrounds) and layers parked fully off-frame
 * (an exit) are left alone; a partly cut-off layer at rest is low, a text
 * layer past title safe is low, anything else past action safe is info.
 */
export function reviewBounds(b: LayerBounds, comp: { width: number; height: number }, safe: SafeAreas): MotionFinding[] {
  if (!b.checkable) return [];
  const W = comp.width;
  const H = comp.height;
  const frame: [number, number, number, number] = [0, 0, W, H];
  const isText = b.kind === "text";
  const share = isText ? safe.title : safe.action;
  const safeBox: [number, number, number, number] = [(W * share) / 2, (H * share) / 2, W - (W * share) / 2, H - (H * share) / 2];
  const base = { layer: b.layer, property: { name: "Transform", path: ["ADBE Transform Group"] as PropertyPath }, keys: [] as number[] };
  let cut: MotionFinding | null = null;
  let outside: MotionFinding | null = null;
  let cutTimes = 0;
  let outsideTimes = 0;
  for (const s of b.samples) {
    if (!s.visible || !s.rect) continue;
    const [l, t, r, bt] = s.rect;
    const area = (r - l) * (bt - t);
    if (area <= 0 || area >= 0.8 * W * H) continue;
    const iw = Math.max(0, Math.min(r, W) - Math.max(l, 0));
    const ih = Math.max(0, Math.min(bt, H) - Math.max(t, 0));
    const visible = (iw * ih) / area;
    if (visible <= 0.001) continue;
    const rect: [number, number, number, number] = [r1(l), r1(t), r1(r), r1(bt)];
    if (visible < 0.98) {
      cutTimes++;
      cut ??= {
        ...base,
        severity: "low",
        kind: "cut_off",
        time: r3(s.time),
        message:
          `${b.layer.name} comes to rest partly outside the frame at ${r3(s.time)}s: ${Math.round((1 - visible) * 100)}% of it is cut off ` +
          `(past the ${edgesPast(rect, frame).join(", ")}). Fine for a deliberate bleed; otherwise move it by the suggested shift.`,
        bounds: rect,
        suggested_shift: shiftInto(rect, safeBox),
      };
      continue;
    }
    const past = edgesPast(rect, safeBox);
    if (past.length) {
      outsideTimes++;
      outside ??= {
        ...base,
        severity: isText ? "low" : "info",
        kind: "outside_safe",
        time: r3(s.time),
        message:
          `${b.layer.name} rests outside the ${isText ? "title" : "action"}-safe area (${Math.round(share * 100)}%) at ${r3(s.time)}s: past it on the ${past.join(", ")}. ` +
          `${isText ? "Text there can be cropped on some screens." : "Fine for decoration; keep key content inside."}`,
        bounds: rect,
        suggested_shift: shiftInto(rect, safeBox),
      };
    }
  }
  const more = (f: MotionFinding | null, n: number) => (f && n > 1 ? { ...f, message: `${f.message} Seen at ${n} rest points.` } : f);
  return [more(cut, cutTimes), more(outside, outsideTimes)].filter((f): f is MotionFinding => f !== null);
}

export const AeMotionReviewSchema = z.object({
  comp_id: z.number().int().describe("CompItem ID to review."),
  layers: z
    .array(LayerSelectorSchema)
    .max(50)
    .optional()
    .describe("Only review these layers. Default: every layer in the comp."),
  include_info: z
    .boolean()
    .optional()
    .describe("Include info findings (overshoot past keyframe values). Default true."),
  max_findings: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Return at most this many findings, most severe first (default 50)."),
  bounds: z
    .boolean()
    .optional()
    .describe("Check where animated layers come to rest against the frame and the safe areas. Default true. 2D layers only; effects that move pixels (Transform, masks) are not followed. A parented layer counts its parents' transform motion when deciding it is at rest; a layer with no transform keys of its own is not checked."),
  action_safe: z.number().min(0).max(0.5).optional().describe("Action-safe margin as a share of width and height, both sides together. Default 0.1, AE's."),
  title_safe: z.number().min(0).max(0.5).optional().describe("Title-safe margin for text layers. Default 0.2, AE's."),
});

export type AeMotionReviewArgs = z.infer<typeof AeMotionReviewSchema>;

interface AnimatedPropertyList {
  comp: { id: number; name: string; fps: number; width: number; height: number; workAreaStart: number; workAreaDuration: number };
  project_path: string;
  layers_scanned: number;
  ancestors_scanned?: number;
  ancestors_truncated?: boolean;
  properties: Array<{
    layer: { index: number; id: number; name: string; parents?: number[] };
    ancestor_only?: boolean;
    path: PropertyPath;
    name: string;
    matchName: string;
    num_keys: number;
    first_key_time: number;
    last_key_time: number;
    expression: boolean;
  }>;
  truncated: boolean;
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
  {
    name: "ae_motion_review",
    description:
      "READ-ONLY. Reviews a comp's animation the way an animator would, and lists what to fix. Every keyframed property (up to 200) is sampled once per frame with expressions applied, and checked for: " +
      "constant-speed (linear) moves; motion that starts or stops at full speed; abrupt speed changes at a key; overshoot past the keyframe values (info: fine for a bounce); keys that sit between frames. " +
      "Findings are sorted most severe first. Medium means motion properties (position, scale, rotation); linear opacity or effect keys are low, since they are often deliberate. Each finding names the layer, property, keys and time. " +
      "Most carry `fix`: a ready ae_set_keyframe_ease call with easy_ease, or with the handle lengths of the user's preferred ease when ae_taste has one. The review also follows ae_taste on linear opacity and effect timing and on overshoot; `taste` in the result shows what applied. " +
      "Show the findings to the user and apply fixes only once they agree, then run ae_motion_review again to confirm. ae_motion_graph shows any one property in detail. The comp is never modified. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeMotionReviewSchema,
    handler: async (args: AeMotionReviewArgs, ctx: ToolContext) => {
      const opId = ctx.bridge.newOpId();
      const label = `ae_motion_review(${args.comp_id})`;
      const scanned = await runQueued(ctx, label, opId, async () => {
        const listResp = await ctx.bridge.evalRaw<AnimatedPropertyList>({
          id: `${opId}_list`,
          script: buildJsxCall("listAnimatedProperties", { comp_id: args.comp_id, layers: args.layers }),
          label: `${label} list`,
          mutates: false,
          toolName: "ae_motion_review",
        });
        const list = listResp.result;
        const workAreaEnd = Number(list.comp.workAreaStart) + Number(list.comp.workAreaDuration);
        // One evalScript per property, so AE's UI gets a breath between them.
        const sampled: Array<{ path: PropertyPath; samples: PropertySamples; speeds: SpeedSample[]; analysis: MotionAnalysis; parents: number[]; ancestorOnly: boolean }> = [];
        for (let i = 0; i < list.properties.length; i++) {
          const p = list.properties[i];
          // Keys alone stop at the last key; an expression can keep moving
          // (a settle or a bounce), so sample those to the work area end.
          const end = p.expression && workAreaEnd > p.last_key_time + 1e-6 ? workAreaEnd : undefined;
          const resp = await ctx.bridge.evalRaw<PropertySamples>({
            id: `${opId}_p${i}`,
            script: buildJsxCall("sampleProperty", { comp_id: args.comp_id, layer: { id: p.layer.id }, path: p.path, end }),
            label: `${label} ${p.layer.name} > ${p.name}`,
            mutates: false,
            toolName: "ae_motion_review",
          });
          const speeds = sampleSpeeds(resp.result);
          sampled.push({ path: p.path, samples: resp.result, speeds, analysis: analyzeMotion(resp.result, speeds), parents: p.layer.parents ?? [], ancestorOnly: p.ancestor_only === true });
        }
        // Where each animated layer comes to rest, then its box there: one evalScript per layer.
        const bounds: LayerBounds[] = [];
        if (args.bounds !== false) {
          const byLayer = new Map<number, typeof sampled>();
          for (const s of sampled) byLayer.set(s.samples.layer.id, [...(byLayer.get(s.samples.layer.id) ?? []), s]);
          for (const [layerId, props] of byLayer) {
            if (props.every((s) => s.ancestorOnly)) continue;
            // With the listing cut short, a parent missing here may be one whose motion was never
            // sampled: don't judge where the layer rests on half the chain.
            if (list.ancestors_truncated && props[0].parents.some((id) => !byLayer.has(id))) {
              const l = props[0].samples.layer;
              bounds.push({ layer: { index: l.index, id: l.id, name: l.name }, kind: "av", checkable: false, reason: "a parent's motion was not fully scanned (listing cut short)", samples: [] });
              continue;
            }
            const ancestors = props[0].parents.flatMap((id) => byLayer.get(id) ?? []);
            const times = restTimes(props, Number(list.comp.fps), ancestors);
            if (!times.length) continue;
            const resp = await ctx.bridge.evalRaw<LayerBounds>({
              id: `${opId}_b${layerId}`,
              script: buildJsxCall("layerBoundsAt", { comp_id: args.comp_id, layer: { id: layerId }, times }),
              label: `${label} bounds ${props[0].samples.layer.name}`,
              mutates: false,
              toolName: "ae_motion_review",
            });
            bounds.push(resp.result);
          }
        }
        return { list, sampled, bounds };
      });

      const target: ReviewTarget = { comp_id: args.comp_id, project_path: scanned.list.project_path };
      const taste = ctx.settings?.get().taste;
      let findings: MotionFinding[] = [];
      for (const { path: propPath, samples, speeds, analysis, ancestorOnly } of scanned.sampled) {
        if (ancestorOnly) continue;
        findings.push(...reviewProperty(samples, analysis, speeds, propPath, target, taste));
      }
      const safe: SafeAreas = { action: args.action_safe ?? 0.1, title: args.title_safe ?? 0.2 };
      for (const b of scanned.bounds) findings.push(...reviewBounds(b, scanned.list.comp, safe));
      const unchecked = scanned.bounds.filter((b) => !b.checkable).map((b) => ({ layer: b.layer.name, reason: b.reason }));
      if (args.include_info === false) findings = findings.filter((f) => f.severity !== "info");
      findings = sortFindings(findings);

      const counts = { medium: 0, low: 0, info: 0 };
      const byKind: Record<string, number> = {};
      for (const f of findings) {
        counts[f.severity]++;
        byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
      }
      const max = args.max_findings ?? 50;
      return {
        ok: true,
        comp: scanned.list.comp,
        project_path: scanned.list.project_path,
        layers_scanned: scanned.list.layers_scanned,
        ...(scanned.list.ancestors_scanned ? { ancestors_scanned: scanned.list.ancestors_scanned } : {}),
        properties_scanned: scanned.sampled.filter((s) => !s.ancestorOnly).length,
        properties_truncated: scanned.list.truncated,
        ...(scanned.list.ancestors_truncated ? { ancestors_truncated: true } : {}),
        clean: counts.medium === 0 && counts.low === 0,
        counts,
        by_kind: byKind,
        findings: findings.slice(0, max),
        findings_truncated: findings.length > max,
        ...(args.bounds !== false ? { bounds_checked: scanned.bounds.length - unchecked.length, ...(unchecked.length ? { bounds_unchecked: unchecked } : {}) } : {}),
        ...(taste &&
        (taste.preferred_ease || taste.allow_linear_non_motion || taste.avoid_overshoot)
          ? {
              taste: {
                preferred_ease: taste.preferred_ease,
                allow_linear_non_motion: taste.allow_linear_non_motion,
                avoid_overshoot: taste.avoid_overshoot,
              },
            }
          : {}),
      };
    },
  },
];
