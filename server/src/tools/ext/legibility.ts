/**
 * server/src/tools/ext/legibility.ts
 *
 * Legibility tools: can the text be read against what is behind it?
 * - ae_check_text_overlap (read only): text boxes that overlap other text, from
 *   the DOM alone (no render). Cheap, and the part ae_house_style_check lacks.
 * - ae_estimate_legibility (read only): contrast of each text layer against the
 *   pixels AROUND its box in one normal render, using the fill colour the DOM
 *   reports. A weak estimate (the DOM colour ignores animators, effects, layer
 *   styles and blend modes), flagged as one. Nothing in the project is touched.
 * - ae_check_legibility: the exact check. Duplicates the comp, switches the
 *   tested text layers OFF in the copy, renders the original and the copy at
 *   the same times and diffs them: the changed pixels are the glyphs, their
 *   colour is the text as rendered (animators, effects and layer styles
 *   included), and the copy's pixels at those positions are the background
 *   (grades, vignettes and layers above included). The copy is removed again.
 *   It writes to the project (a guarded write with a receipt), in two undo
 *   groups: the renders sit between them.
 *
 * All three return WCAG contrast ratios per text layer and time, boxes that
 * overlap other text, an annotated PNG (failing boxes in red with the ratio
 * printed) and, for failures, suggested fixes. Fixes are numbers and ready
 * ae_create_layer arguments: nothing is applied.
 *
 * Not built, because AE has no API for them: per-glyph boxes (the DOM gives
 * the whole layer's rect), text inside precomps (a duplicated comp shares its
 * nested comps with the original) and boxes of 3D text. Text inside a precomp
 * is not seen at all (only the comp's own text layers are listed); 3D and
 * empty text are listed as not checkable, with the reason.
 *
 * Unmeasured on AE 26: the colour space saveFrameToPng writes (the ratios
 * assume sRGB display values), whether a render of a fresh duplicate can come
 * back cached, and how antialiasing, motion blur and grain move the diff mask.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { PNG } from "pngjs";
import { z } from "zod";
import { BridgeError, SLOW_TIMEOUT_MS } from "../../host.js";
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
import { captureCompFrame, decodePngFile } from "./frames.js";
import {
  drawLabel,
  encodePng,
  fillRect,
  fitWithin,
  flattenOnChecker,
  hasTransparency,
  resizeArea,
  strokeRect,
  textWidth,
  GLYPH_HEIGHT,
  type Rgba,
  type RgbaImage,
} from "./png-utils.js";
import { beginInflight, endInflight, noteAfterWrite, noteBeforeWrite } from "./session.js";
import { expectThat } from "./write-runner.js";

// ---------- schemas ----------

const MAX_CHECK_TIMES = 6;
const MAX_OVERLAP_TIMES = 12;

const CompId = z.number().int().describe("The composition holding the text layers.");

const Layers = z
  .array(LayerSelectorSchema)
  .min(1)
  .max(200)
  .optional()
  .describe("Only these text layers (by id, index or a unique name). Default: every text layer in the comp. A selector that is not a text layer is refused.");

const timesField = (max: number) =>
  z
    .array(z.number().min(0))
    .min(1)
    .max(max)
    .optional()
    .describe(
      `Comp times in seconds to check (up to ${max}), clamped to the last frame. Default: the comp's current time, read without moving the time indicator. Text changes over time (animators, fades, a moving background), so check the times that matter, such as the end of each title's fade-in.`
    );

const Level = z
  .enum(["AA", "AAA"])
  .default("AA")
  .describe("WCAG 2.x level: AA needs 4.5:1 (3:1 for large text), AAA needs 7:1 (4.5:1 for large text). Default AA. These are web standards; use `min_ratio` for a house rule.");

const MinRatio = z
  .number()
  .min(1)
  .max(21)
  .optional()
  .describe("Contrast ratio to require of every text layer, whatever its size. Overrides `level`.");

const LargeTextPx = z
  .number()
  .positive()
  .max(2000)
  .default(24)
  .describe("Font size in comp pixels, as it lands on the frame (scale and parents included), from which text counts as large (WCAG's 18 pt = 24 px). Bold text counts from 78% of this. Default 24.");

const Tolerance = z
  .number()
  .min(0)
  .max(0.5)
  .default(0.1)
  .describe("Share of a layer's solid text pixels allowed below the required ratio before it fails. Default 0.1 (a layer passes when 90% of its pixels reach the ratio). Antialiased edges are left out, except for thin type, where they are counted too.");

const Annotate = z.boolean().default(true).describe("Write an annotated PNG per time: text boxes green (pass), red (fail, ratio printed) or amber (not conclusive), overlaps in magenta. Default true.");

const MaxSize = z.number().int().min(200).max(4096).default(1600).describe("Longest edge of the annotated PNG in pixels. Default 1600.");

const MinOverlap = z
  .number()
  .min(0)
  .max(1)
  .default(0.02)
  .describe("Two text boxes overlap when their intersection is at least this share of the smaller box. Default 0.02.");

export const AeCheckTextOverlapSchema = z.object({
  comp_id: CompId,
  times: timesField(MAX_OVERLAP_TIMES),
  layers: Layers,
  min_overlap: MinOverlap,
});

export const AeEstimateLegibilitySchema = z.object({
  comp_id: CompId,
  times: timesField(MAX_CHECK_TIMES),
  layers: Layers,
  level: Level,
  min_ratio: MinRatio,
  large_text_px: LargeTextPx,
  tolerance: Tolerance,
  min_overlap: MinOverlap,
  annotate: Annotate,
  max_size: MaxSize,
});

export const AeCheckLegibilitySchema = z.object({
  comp_id: CompId,
  times: timesField(MAX_CHECK_TIMES),
  layers: Layers,
  level: Level,
  min_ratio: MinRatio,
  large_text_px: LargeTextPx,
  tolerance: Tolerance,
  min_overlap: MinOverlap,
  sensitivity: z
    .number()
    .min(0.005)
    .max(0.25)
    .default(0.02)
    .describe(
      "A pixel belongs to the text when a colour channel differs by more than this (0..1) between the render with the text on and with it off. Default 0.02. Lower finds fainter text (and shadows or glow, which are part of the layer); text closer to its background than this cannot be told apart and counts as not visible."
    ),
  fixes: z.boolean().default(true).describe("Suggest fixes for failing layers (a text colour, a scrim behind the text). Nothing is applied. Default true."),
  annotate: Annotate,
  max_size: MaxSize,
  expect: ExpectSchema,
});

export type AeCheckTextOverlapArgs = z.infer<typeof AeCheckTextOverlapSchema>;
export type AeEstimateLegibilityArgs = z.infer<typeof AeEstimateLegibilitySchema>;
export type AeCheckLegibilityArgs = z.infer<typeof AeCheckLegibilitySchema>;

// ---------- the host's answer ----------

/** [left, top, right, bottom] in comp pixels. */
export type Box = [number, number, number, number];

export interface HostSample {
  time: number;
  visible: boolean;
  /** True for a guide layer: it is not part of the render. */
  guide?: boolean;
  opacity: number | null;
  box: Box | null;
  box_reason: string | null;
  screen_font_px: number | null;
  font_size: number | null;
  bold: boolean;
  apply_fill: boolean | null;
  fill_rgb: [number, number, number] | null;
  apply_stroke: boolean | null;
  stroke_rgb: [number, number, number] | null;
  mixed_fill: boolean | null;
  text: string;
}

export interface HostTextLayer {
  index: number;
  id: number;
  name: string;
  enabled: boolean;
  in_point: number;
  out_point: number;
  parent_id: number | null;
  animators: number;
  effects: number;
  layer_styles: boolean | null;
  track_matte: string | null;
  is_track_matte: boolean;
  samples: HostSample[];
}

export interface HostRead {
  comp: {
    id: number;
    name: string;
    width: number;
    height: number;
    duration: number;
    frame_duration: number;
    pixel_aspect: number;
    resolution_factor: number[] | null;
  };
  times: number[];
  layers: HostTextLayer[];
  total_layers: number;
  text_layers: number;
  truncated: boolean;
  solo_active: boolean;
}

// ---------- colour and contrast ----------

const LIN = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance of an sRGB colour given as 0..255 channels. */
export function relativeLuminance(r: number, g: number, b: number): number {
  const q = (v: number) => LIN[Math.max(0, Math.min(255, Math.round(v)))];
  return 0.2126 * q(r) + 0.7152 * q(g) + 0.0722 * q(b);
}

/** WCAG contrast ratio of two relative luminances, 1..21. */
export function contrastRatio(l1: number, l2: number): number {
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

export const hex = (rgb: ArrayLike<number>): string =>
  "#" + [0, 1, 2].map((i) => Math.max(0, Math.min(255, Math.round(rgb[i]))).toString(16).padStart(2, "0")).join("");

const r2 = (v: number): number => Math.round(v * 100) / 100;
const r3 = (v: number): number => Math.round(v * 1000) / 1000;

/** The ratio a layer must reach: `min_ratio` if given, else by level and size. */
export function requiredRatio(o: {
  level: "AA" | "AAA";
  minRatio?: number;
  fontPx: number | null;
  bold: boolean;
  largeTextPx: number;
}): { ratio: number; large: boolean } {
  const large = o.fontPx !== null && (o.fontPx >= o.largeTextPx || (o.bold && o.fontPx >= o.largeTextPx * 0.78));
  if (o.minRatio !== undefined) return { ratio: o.minRatio, large };
  if (o.level === "AAA") return { ratio: large ? 4.5 : 7, large };
  return { ratio: large ? 3 : 4.5, large };
}

// ---------- boxes and overlaps ----------

export const boxArea = (b: Box): number => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);

export function intersectBoxes(a: Box, b: Box): Box | null {
  const x0 = Math.max(a[0], b[0]);
  const y0 = Math.max(a[1], b[1]);
  const x1 = Math.min(a[2], b[2]);
  const y1 = Math.min(a[3], b[3]);
  return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : null;
}

export interface BoxItem {
  index: number;
  id: number;
  name: string;
  box: Box;
}

export interface OverlapPair {
  a: { index: number; id: number; name: string };
  b: { index: number; id: number; name: string };
  rect: Box;
  area: number;
  /** Intersection over the smaller box, 0..1. */
  share_of_smaller: number;
}

const MAX_OVERLAPS = 200;

/** Pairs of boxes that overlap by at least `minShare` of the smaller one, largest overlap first. */
export function findOverlaps(items: BoxItem[], minShare: number): { pairs: OverlapPair[]; truncated: boolean } {
  const pairs: OverlapPair[] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const rect = intersectBoxes(items[i].box, items[j].box);
      if (!rect) continue;
      const area = boxArea(rect);
      const smaller = Math.min(boxArea(items[i].box), boxArea(items[j].box));
      if (smaller <= 0) continue;
      const share = area / smaller;
      if (share < minShare) continue;
      pairs.push({
        a: { index: items[i].index, id: items[i].id, name: items[i].name },
        b: { index: items[j].index, id: items[j].id, name: items[j].name },
        rect: rect.map(r2) as Box,
        area: r2(area),
        share_of_smaller: r3(share),
      });
    }
  }
  pairs.sort((x, y) => y.share_of_smaller - x.share_of_smaller);
  return { pairs: pairs.slice(0, MAX_OVERLAPS), truncated: pairs.length > MAX_OVERLAPS };
}

/** A box in image pixels, [x0, x1) by [y0, y1). */
export interface PixelRegion {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A comp-pixel box, grown by `pad` comp pixels, as image pixels inside the frame. Null when nothing is left. */
export function boxToRegion(box: Box, comp: { width: number; height: number }, img: { width: number; height: number }, pad = 0): PixelRegion | null {
  const sx = img.width / comp.width;
  const sy = img.height / comp.height;
  const x0 = Math.max(0, Math.floor((box[0] - pad) * sx));
  const y0 = Math.max(0, Math.floor((box[1] - pad) * sy));
  const x1 = Math.min(img.width, Math.ceil((box[2] + pad) * sx));
  const y1 = Math.min(img.height, Math.ceil((box[3] + pad) * sy));
  return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null;
}

const inAny = (list: PixelRegion[] | undefined, x: number, y: number): boolean => {
  if (!list) return false;
  for (const r of list) if (x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1) return true;
  return false;
};

// ---------- pixel analysis ----------

const MIN_PIXELS = 6;
/** Pixels within this many levels (of 255) of the text colour count as the text itself, not as antialiasing. */
const COLOUR_TOL = 26;

export interface PixelAnalysis {
  status: "ok" | "no_glyph" | "transparent" | "no_background";
  /** Pixels the diff says belong to the text layer (fill, stroke, shadow and edges). */
  glyph_pixels: number;
  /** Pixels the ratio was measured on. */
  core_pixels: number;
  /** Too few solid pixels were found, so antialiased ones were used too. */
  thin: boolean;
  text_rgb: [number, number, number] | null;
  bg_mean: [number, number, number] | null;
  transparent_pixels: number;
  excluded_pixels: number;
  /** Ratios, ascending. */
  ratios: Float32Array;
  /** The background colour (r, g, b) behind each ratio, same order. */
  bg: Uint8Array;
  /** Image-pixel bounds of the pixels below the required ratio. */
  fail_bounds: [number, number, number, number] | null;
  /** Estimate only: share of the box's pixels that have the layer's fill colour. */
  fill_seen_share?: number;
  /**
   * Exact only: share of the solid glyph pixels that are neither the dominant
   * colour nor a blend of it with the background (a second fill colour, a
   * stroke). Those pixels are not judged, so a high share means part of the
   * text was not measured.
   */
  foreign_share?: number;
}

const emptyAnalysis = (status: PixelAnalysis["status"], extra: Partial<PixelAnalysis> = {}): PixelAnalysis => ({
  status,
  glyph_pixels: 0,
  core_pixels: 0,
  thin: false,
  text_rgb: null,
  bg_mean: null,
  transparent_pixels: 0,
  excluded_pixels: 0,
  ratios: new Float32Array(0),
  bg: new Uint8Array(0),
  fail_bounds: null,
  ...extra,
});

/** Sorts ratios ascending, carrying each one's background colour along. */
function sortPaired(ratios: number[], bg: number[]): { ratios: Float32Array; bg: Uint8Array } {
  const order = ratios.map((_, i) => i).sort((a, b) => ratios[a] - ratios[b]);
  const outR = new Float32Array(order.length);
  const outB = new Uint8Array(order.length * 3);
  order.forEach((from, to) => {
    outR[to] = ratios[from];
    outB[to * 3] = bg[from * 3];
    outB[to * 3 + 1] = bg[from * 3 + 1];
    outB[to * 3 + 2] = bg[from * 3 + 2];
  });
  return { ratios: outR, bg: outB };
}

function meanRgb(bg: Uint8Array): [number, number, number] | null {
  const n = bg.length / 3;
  if (n === 0) return null;
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < bg.length; i += 3) {
    r += bg[i];
    g += bg[i + 1];
    b += bg[i + 2];
  }
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

/**
 * The exact analysis. `orig` is the render with the text on, `copy` the same
 * frame with the text layer off: pixels that differ are the glyphs. The text
 * colour is the dominant colour of the glyph interior (so a shadow, glow or
 * stroke is not mistaken for it), and each solid text pixel is judged against
 * the copy's pixel at the same position: the real background behind it.
 */
export function analyzeGlyphs(
  orig: RgbaImage,
  copy: RgbaImage,
  region: PixelRegion,
  o: { sensitivity: number; required: number; exclude?: PixelRegion[] }
): PixelAnalysis {
  const w = region.x1 - region.x0;
  const h = region.y1 - region.y0;
  const mask = new Uint8Array(w * h);
  const limit = o.sensitivity * 255;
  let glyph = 0;
  let excluded = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gx = region.x0 + x;
      const gy = region.y0 + y;
      if (inAny(o.exclude, gx, gy)) {
        excluded++;
        continue;
      }
      const i = (gy * orig.width + gx) * 4;
      const d = Math.max(
        Math.abs(orig.data[i] - copy.data[i]),
        Math.abs(orig.data[i + 1] - copy.data[i + 1]),
        Math.abs(orig.data[i + 2] - copy.data[i + 2]),
        Math.abs(orig.data[i + 3] - copy.data[i + 3])
      );
      if (d > limit) {
        mask[y * w + x] = 1;
        glyph++;
      }
    }
  }
  if (glyph < MIN_PIXELS) return emptyAnalysis("no_glyph", { glyph_pixels: glyph, excluded_pixels: excluded });

  // The interior: glyph pixels whose four neighbours are glyph pixels too.
  const interior: number[] = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const k = y * w + x;
      if (mask[k] && mask[k - 1] && mask[k + 1] && mask[k - w] && mask[k + w]) interior.push(k);
    }
  }
  const seeds: number[] = interior.length >= MIN_PIXELS ? interior : maskIndexes(mask);

  // The dominant colour among the seeds, in 16 levels per channel.
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (const k of seeds) {
    const i = ((region.y0 + Math.floor(k / w)) * orig.width + region.x0 + (k % w)) * 4;
    if (orig.data[i + 3] < 250) continue;
    const key = ((orig.data[i] >> 4) << 8) | ((orig.data[i + 1] >> 4) << 4) | (orig.data[i + 2] >> 4);
    const e = bins.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    e.n++;
    e.r += orig.data[i];
    e.g += orig.data[i + 1];
    e.b += orig.data[i + 2];
    bins.set(key, e);
  }
  let best: { n: number; r: number; g: number; b: number } | null = null;
  for (const e of bins.values()) if (!best || e.n > best.n) best = e;
  if (!best) return emptyAnalysis("transparent", { glyph_pixels: glyph, excluded_pixels: excluded });
  const text: [number, number, number] = [best.r / best.n, best.g / best.n, best.b / best.n];
  const textLum = relativeLuminance(text[0], text[1], text[2]);

  const collect = (colourMatch: boolean) => {
    const ratios: number[] = [];
    const bg: number[] = [];
    let transparent = 0;
    let foreign = 0;
    let own = 0;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!mask[y * w + x]) continue;
        const i = ((region.y0 + y) * orig.width + region.x0 + x) * 4;
        const isOwn =
          Math.abs(orig.data[i] - text[0]) <= COLOUR_TOL &&
          Math.abs(orig.data[i + 1] - text[1]) <= COLOUR_TOL &&
          Math.abs(orig.data[i + 2] - text[2]) <= COLOUR_TOL;
        if (orig.data[i + 3] >= 250 && copy.data[i + 3] >= 250) {
          if (isOwn) own++;
          else if (!onBlendLine(orig.data, copy.data, i, text)) foreign++;
        }
        if (colourMatch && !isOwn) continue;
        if (orig.data[i + 3] < 250 || copy.data[i + 3] < 250) {
          transparent++;
          continue;
        }
        const ratio = contrastRatio(textLum, relativeLuminance(copy.data[i], copy.data[i + 1], copy.data[i + 2]));
        ratios.push(ratio);
        bg.push(copy.data[i], copy.data[i + 1], copy.data[i + 2]);
        if (ratio < o.required) {
          const gx = region.x0 + x;
          const gy = region.y0 + y;
          if (gx < minX) minX = gx;
          if (gy < minY) minY = gy;
          if (gx > maxX) maxX = gx;
          if (gy > maxY) maxY = gy;
        }
      }
    }
    const fail_bounds: [number, number, number, number] | null = maxX >= minX ? [minX, minY, maxX + 1, maxY + 1] : null;
    return { ratios, bg, transparent, fail_bounds, foreign_share: own + foreign > 0 ? foreign / (own + foreign) : 0 };
  };

  let thin = false;
  let got = collect(true);
  if (got.ratios.length < MIN_PIXELS) {
    // Gradient fills, tiny type: no flat colour to match, so every glyph pixel counts.
    thin = true;
    got = collect(false);
  }
  if (got.ratios.length === 0) {
    return emptyAnalysis(got.transparent > 0 ? "transparent" : "no_glyph", {
      glyph_pixels: glyph,
      transparent_pixels: got.transparent,
      excluded_pixels: excluded,
      text_rgb: text.map(Math.round) as [number, number, number],
    });
  }
  const sorted = sortPaired(got.ratios, got.bg);
  return {
    status: "ok",
    glyph_pixels: glyph,
    core_pixels: sorted.ratios.length,
    thin,
    text_rgb: text.map(Math.round) as [number, number, number],
    bg_mean: meanRgb(sorted.bg),
    transparent_pixels: got.transparent,
    excluded_pixels: excluded,
    ratios: sorted.ratios,
    bg: sorted.bg,
    fail_bounds: got.fail_bounds,
    foreign_share: r3(got.foreign_share),
  };
}

/** True when pixel `i` of `orig` is the text colour blended into the copy's pixel there (an antialiased edge), within the colour tolerance. */
function onBlendLine(orig: ArrayLike<number>, copy: ArrayLike<number>, i: number, text: [number, number, number]): boolean {
  const d0 = text[0] - copy[i];
  const d1 = text[1] - copy[i + 1];
  const d2 = text[2] - copy[i + 2];
  const len2 = d0 * d0 + d1 * d1 + d2 * d2;
  if (len2 < 1) return true;
  const p0 = orig[i] - copy[i];
  const p1 = orig[i + 1] - copy[i + 1];
  const p2 = orig[i + 2] - copy[i + 2];
  const t = Math.min(1, Math.max(0, (p0 * d0 + p1 * d1 + p2 * d2) / len2));
  return Math.abs(p0 - t * d0) <= COLOUR_TOL && Math.abs(p1 - t * d1) <= COLOUR_TOL && Math.abs(p2 - t * d2) <= COLOUR_TOL;
}

function maskIndexes(mask: Uint8Array): number[] {
  const out: number[] = [];
  for (let k = 0; k < mask.length; k++) if (mask[k]) out.push(k);
  return out;
}

/**
 * The estimate: the DOM's fill colour against the ring of pixels around the
 * text box in one normal render. The ring is outside every glyph, so it is
 * background (or another layer), but it is not what is behind the glyphs.
 */
export function analyzeEstimate(
  frame: RgbaImage,
  box: PixelRegion,
  ringWidth: number,
  fill: [number, number, number],
  o: { required: number; exclude?: PixelRegion[] }
): PixelAnalysis {
  const outer: PixelRegion = {
    x0: Math.max(0, box.x0 - ringWidth),
    y0: Math.max(0, box.y0 - ringWidth),
    x1: Math.min(frame.width, box.x1 + ringWidth),
    y1: Math.min(frame.height, box.y1 + ringWidth),
  };
  const fillLum = relativeLuminance(fill[0], fill[1], fill[2]);
  const ratios: number[] = [];
  const bg: number[] = [];
  let excluded = 0;
  let transparent = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let inBox = 0;
  let fillSeen = 0;
  for (let y = outer.y0; y < outer.y1; y++) {
    for (let x = outer.x0; x < outer.x1; x++) {
      const i = (y * frame.width + x) * 4;
      const insideBox = x >= box.x0 && x < box.x1 && y >= box.y0 && y < box.y1;
      if (insideBox) {
        inBox++;
        if (
          frame.data[i + 3] >= 250 &&
          Math.abs(frame.data[i] - fill[0]) <= COLOUR_TOL &&
          Math.abs(frame.data[i + 1] - fill[1]) <= COLOUR_TOL &&
          Math.abs(frame.data[i + 2] - fill[2]) <= COLOUR_TOL
        ) {
          fillSeen++;
        }
        continue;
      }
      if (inAny(o.exclude, x, y)) {
        excluded++;
        continue;
      }
      if (frame.data[i + 3] < 250) {
        transparent++;
        continue;
      }
      const ratio = contrastRatio(fillLum, relativeLuminance(frame.data[i], frame.data[i + 1], frame.data[i + 2]));
      ratios.push(ratio);
      bg.push(frame.data[i], frame.data[i + 1], frame.data[i + 2]);
      if (ratio < o.required) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  const fill_seen_share = inBox > 0 ? fillSeen / inBox : 0;
  if (ratios.length < MIN_PIXELS) {
    return emptyAnalysis(transparent > 0 ? "transparent" : "no_background", {
      excluded_pixels: excluded,
      transparent_pixels: transparent,
      text_rgb: fill,
      fill_seen_share,
    });
  }
  const sorted = sortPaired(ratios, bg);
  return {
    status: "ok",
    glyph_pixels: fillSeen,
    core_pixels: sorted.ratios.length,
    thin: false,
    text_rgb: fill,
    bg_mean: meanRgb(sorted.bg),
    transparent_pixels: transparent,
    excluded_pixels: excluded,
    ratios: sorted.ratios,
    bg: sorted.bg,
    fail_bounds: maxX >= minX ? [minX, minY, maxX + 1, maxY + 1] : null,
    fill_seen_share,
  };
}

export interface RatioStats {
  min: number;
  /** The ratio reached by (1 - tolerance) of the pixels. */
  low: number;
  median: number;
  fail_share: number;
  pass: boolean;
}

/** Statistics of ascending ratios against the required one. */
export function ratioStats(sorted: Float32Array, required: number, tolerance: number): RatioStats {
  const n = sorted.length;
  if (n === 0) return { min: 0, low: 0, median: 0, fail_share: 1, pass: false };
  let below = 0;
  while (below < n && sorted[below] < required) below++;
  const q = Math.min(n - 1, Math.floor(tolerance * n));
  const share = below / n;
  return {
    min: r2(sorted[0]),
    low: r2(sorted[q]),
    median: r2(sorted[Math.floor((n - 1) / 2)]),
    fail_share: r3(share),
    pass: share <= tolerance,
  };
}

// ---------- fixes ----------

export interface LegibilityFix {
  kind: "text_colour" | "scrim";
  /** What to do, in a sentence. */
  summary: string;
  /** Whether the fix gets the layer to the required ratio (by the tool's own maths). */
  reaches_ratio: boolean;
  /** text_colour: the colour 0..1 and its hex. */
  rgb?: [number, number, number];
  hex?: string;
  expected_fail_share?: number;
  /** scrim: colour 0..1, opacity in percent, and the comp-pixel rectangle behind the text. */
  colour?: [number, number, number];
  opacity_percent?: number;
  rect?: Box;
  /** scrim: arguments for ae_create_layer (add `expect`), which makes the solid below the text. */
  create_layer_args?: Record<string, unknown>;
  /** scrim: what to do after the solid exists. */
  then?: string[];
}

const mixRgb = (a: ArrayLike<number>, b: ArrayLike<number>, t: number): [number, number, number] => [
  b[0] * t + a[0] * (1 - t),
  b[1] * t + a[1] * (1 - t),
  b[2] * t + a[2] * (1 - t),
];

/** The smallest scrim opacity (percent, steps of 1) that lifts text over `bg` to `required`, or null. Blending is done in encoded sRGB. */
export function scrimOpacity(text: ArrayLike<number>, bg: ArrayLike<number>, scrim: ArrayLike<number>, required: number): number | null {
  const textLum = relativeLuminance(text[0], text[1], text[2]);
  const want = required * 1.03;
  for (let a = 0; a <= 90; a++) {
    const m = mixRgb(bg, scrim, a / 100);
    if (contrastRatio(textLum, relativeLuminance(m[0], m[1], m[2])) >= want) return a;
  }
  return null;
}

/**
 * The smallest scrim opacity (percent, steps of 5) at which no more than
 * `tolerance` of the background pixels miss `required` once the scrim is
 * blended over every one of them, or null. A scrim moves pixels both ways (a
 * black one first pulls a light background toward mid-tone text), so each
 * candidate opacity is judged on all pixels, not on one boundary pixel.
 */
export function scrimOpacityOver(text: ArrayLike<number>, bg: Uint8Array, scrim: ArrayLike<number>, required: number, tolerance: number): number | null {
  const n = bg.length / 3;
  if (n === 0) return null;
  const textLum = relativeLuminance(text[0], text[1], text[2]);
  const want = required * 1.03;
  const stride = Math.max(1, Math.ceil(n / 20000));
  for (let pct = 5; pct <= 90; pct += 5) {
    const t = pct / 100;
    let below = 0;
    let seen = 0;
    for (let k = 0; k < n; k += stride) {
      const m = mixRgb([bg[k * 3], bg[k * 3 + 1], bg[k * 3 + 2]], scrim, t);
      seen++;
      if (contrastRatio(textLum, relativeLuminance(m[0], m[1], m[2])) < want) below++;
    }
    if (below / seen <= tolerance) return pct;
  }
  return null;
}

function failShareWith(text: ArrayLike<number>, bg: Uint8Array, required: number): number {
  const n = bg.length / 3;
  if (n === 0) return 1;
  const lum = relativeLuminance(text[0], text[1], text[2]);
  let below = 0;
  for (let i = 0; i < bg.length; i += 3) {
    if (contrastRatio(lum, relativeLuminance(bg[i], bg[i + 1], bg[i + 2])) < required) below++;
  }
  return below / n;
}

export function suggestFixes(a: {
  compId: number;
  layer: { index: number; id: number; name: string };
  textRgb: [number, number, number];
  analysis: Pick<PixelAnalysis, "ratios" | "bg">;
  required: number;
  tolerance: number;
  box: Box;
  fontPx: number | null;
  comp: { width: number; height: number };
}): LegibilityFix[] {
  const fixes: LegibilityFix[] = [];
  const n = a.analysis.ratios.length;
  if (n === 0) return fixes;

  // 1. A text colour: white or black, whichever leaves fewer failing pixels.
  const white: [number, number, number] = [255, 255, 255];
  const black: [number, number, number] = [0, 0, 0];
  const wShare = failShareWith(white, a.analysis.bg, a.required);
  const bShare = failShareWith(black, a.analysis.bg, a.required);
  const pick = wShare <= bShare ? white : black;
  const share = Math.min(wShare, bShare);
  fixes.push({
    kind: "text_colour",
    summary: `Make the text ${pick === white ? "white" : "black"} (${hex(pick)}): ${r3(share * 100)}% of its pixels would still miss ${a.required}:1${share <= a.tolerance ? ", within the tolerance" : ", so a colour change alone is not enough"}.`,
    reaches_ratio: share <= a.tolerance,
    rgb: [pick[0] / 255, pick[1] / 255, pick[2] / 255],
    hex: hex(pick),
    expected_fail_share: r3(share),
  });

  // 2. A scrim: black behind light text, white behind dark text, as faint as will do.
  const options = [black, white]
    .map((s) => ({ s, pct: scrimOpacityOver(a.textRgb, a.analysis.bg, s, a.required, a.tolerance) }))
    .filter((o): o is { s: [number, number, number]; pct: number } => o.pct !== null)
    .sort((x, y) => x.pct - y.pct);
  const pad = Math.max(8, Math.round((a.fontPx ?? Math.max(8, a.box[3] - a.box[1])) * 0.35));
  const rect: Box = [
    Math.max(0, Math.round(a.box[0] - pad)),
    Math.max(0, Math.round(a.box[1] - pad)),
    Math.min(a.comp.width, Math.round(a.box[2] + pad)),
    Math.min(a.comp.height, Math.round(a.box[3] + pad)),
  ];
  const w = Math.max(1, rect[2] - rect[0]);
  const h = Math.max(1, rect[3] - rect[1]);
  const cx = Math.round((rect[0] + rect[2]) / 2);
  const cy = Math.round((rect[1] + rect[3]) / 2);
  const chosen = options[0];
  let colour: [number, number, number] = chosen ? chosen.s : white;
  // With no scrim that works, name the colour that would help most: dark behind light text.
  if (!chosen && a.textRgb.reduce((sum, v) => sum + v, 0) / 3 > 127) colour = black;
  const pct = chosen ? chosen.pct : 90;
  fixes.push({
    kind: "scrim",
    summary: chosen
      ? `Put a ${colour === black ? "black" : "white"} solid at ${pct}% opacity directly below the text, covering ${w}x${h} px around it.`
      : `A ${colour === black ? "black" : "white"} scrim does not reach ${a.required}:1 even at 90% over the worst part of this background: change the text colour or the footage.`,
    reaches_ratio: !!chosen,
    colour: [colour[0] / 255, colour[1] / 255, colour[2] / 255],
    opacity_percent: pct,
    rect,
    create_layer_args: {
      comp_id: a.compId,
      type: "solid",
      name: `Scrim: ${a.layer.name}`.slice(0, 200),
      color: [colour[0] / 255, colour[1] / 255, colour[2] / 255],
      width: Math.min(30000, Math.max(1, Math.ceil(w))),
      height: Math.min(30000, Math.max(1, Math.ceil(h))),
      placement: { below: { id: a.layer.id } },
    },
    then: [`Set the solid's Position to [${cx}, ${cy}] (ae_set_property).`, `Set its Opacity to ${pct} (ae_set_property).`],
  });
  return fixes;
}

// ---------- judging one layer at one time ----------

export type EntryStatus = "pass" | "fail" | "inconclusive" | "not_visible" | "not_checkable";

export interface LegibilityEntry {
  layer: { index: number; id: number; name: string };
  time: number;
  status: EntryStatus;
  measured: "pixels" | "estimate" | "none";
  reason?: string;
  text?: string;
  box?: Box;
  required_ratio?: number;
  large_text?: boolean;
  font_px?: number | null;
  ratio?: { min: number; low: number; median: number };
  fail_share?: number;
  text_colour?: string;
  background_mean?: string;
  glyph_pixels?: number;
  measured_pixels?: number;
  /** The DOM's fill colour is not the colour the render shows. */
  dom_fill_differs?: boolean;
  /** Comp-pixel bounds of the pixels below the required ratio. */
  fail_box?: Box;
  fixes?: LegibilityFix[];
  notes?: string[];
}

export interface Judging {
  required: { level: "AA" | "AAA"; minRatio?: number; largeTextPx: number };
  tolerance: number;
}

const head = (l: HostTextLayer) => ({ index: l.index, id: l.id, name: l.name });

/** Why a layer is not on the frame at this sample. */
export function hiddenReason(l: HostTextLayer, s: HostSample): string {
  if (!l.enabled) return "the layer's video switch is off";
  if (s.time < l.in_point || s.time >= l.out_point) return "the time is outside the layer's in and out points";
  if (s.guide === true) return "the layer is a guide layer (not rendered)";
  if (s.opacity !== null && s.opacity <= 0) return "the layer's opacity is 0";
  return "another layer is soloed";
}

/** The entry for a sample that cannot be measured, or null when it can. */
export function skippedEntry(l: HostTextLayer, s: HostSample): LegibilityEntry | null {
  if (!s.visible) {
    return { layer: head(l), time: s.time, status: "not_visible", measured: "none", reason: hiddenReason(l, s) };
  }
  if (!s.box) {
    return { layer: head(l), time: s.time, status: "not_checkable", measured: "none", reason: s.box_reason ?? "no box" };
  }
  return null;
}

/** Above this share of glyph pixels in another colour, a pass for the dominant colour is not trusted. */
const FOREIGN_LIMIT = 0.3;

const colourDistance = (a: ArrayLike<number>, b: ArrayLike<number>): number => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));

/** Things that make the DOM's own fill colour unreliable for this layer, as notes. */
export function domCaveats(l: HostTextLayer, s: HostSample): string[] {
  const out: string[] = [];
  if (l.animators > 0) out.push(`${l.animators} text animator(s): they can change the colour per character`);
  if (l.effects > 0) out.push(`${l.effects} effect(s) on the layer can change its colour`);
  if (l.layer_styles === true) out.push("layer styles are on");
  if (s.mixed_fill === true) out.push("the characters have different fill colours");
  if (l.track_matte) out.push(`the layer has a ${l.track_matte} track matte`);
  if (l.is_track_matte) out.push("the layer is a track matte for another layer");
  return out;
}

/** The common head of an entry that has pixels behind it. */
function measuredEntry(l: HostTextLayer, s: HostSample, j: Judging, measured: "pixels" | "estimate") {
  const req = requiredRatio({ level: j.required.level, minRatio: j.required.minRatio, fontPx: s.screen_font_px, bold: s.bold, largeTextPx: j.required.largeTextPx });
  const entry: LegibilityEntry = {
    layer: head(l),
    time: s.time,
    status: "inconclusive",
    measured,
    ...(s.text ? { text: s.text.length > 60 ? s.text.slice(0, 59) + "…" : s.text } : {}),
    box: s.box!,
    required_ratio: req.ratio,
    large_text: req.large,
    font_px: s.screen_font_px,
  };
  return { entry, req };
}

/** Turns a pixel analysis into an entry: status, numbers, notes and, for failures, fixes. */
export function judgeAnalysis(
  l: HostTextLayer,
  s: HostSample,
  a: PixelAnalysis,
  j: Judging,
  o: { measured: "pixels" | "estimate"; compId: number; comp: { width: number; height: number }; img: { width: number; height: number }; fixes: boolean; frameChanged?: boolean }
): LegibilityEntry {
  const { entry, req } = measuredEntry(l, s, j, o.measured);
  const notes: string[] = [];
  const toComp = (b: [number, number, number, number]): Box =>
    [b[0] * (o.comp.width / o.img.width), b[1] * (o.comp.height / o.img.height), b[2] * (o.comp.width / o.img.width), b[3] * (o.comp.height / o.img.height)].map(r2) as Box;
  entry.glyph_pixels = a.glyph_pixels;

  if (o.measured === "estimate") {
    notes.push("An estimate: the fill colour is the DOM's and the background is the ring of pixels around the box, not what is behind the glyphs. Use ae_check_legibility for the exact figure.");
    if (!s.fill_rgb) {
      entry.reason = s.apply_fill === false ? "the layer has no fill (stroke only), so there is no fill colour to compare" : "the DOM gave no fill colour";
      entry.notes = notes;
      return entry;
    }
    const caveats = domCaveats(l, s);
    if (caveats.length > 0) notes.push(`The DOM colour may not be what shows: ${caveats.join("; ")}.`);
    if (a.status === "ok" && (a.fill_seen_share ?? 0) < 0.002) {
      entry.reason = "no pixel in the box has the layer's fill colour (animators, effects, layer styles, opacity or a blend mode change it, or the text is covered), so the estimate does not apply";
      entry.notes = notes;
      return entry;
    }
  } else {
    if (a.status === "no_glyph" && a.excluded_pixels > 0) {
      entry.reason = "the pixels in its box are shared with another text layer's box, so nothing was left to measure; see the overlaps";
      entry.notes = notes;
      return entry;
    }
    if (a.status === "no_glyph") {
      entry.reason = o.frameChanged === false
        ? "switching the text off changed no pixel anywhere in the frame: the text is invisible here, or AE returned a cached frame for the copy"
        : "switching the text off changed (almost) no pixel in its box: the text is the colour of its background, covered by another layer, masked out or transparent";
      // A render that works elsewhere in the frame and shows nothing here is a legibility failure,
      // unless animators or effects can hide or move the characters at this time.
      const mayBeHidden = l.animators > 0 || l.effects > 0;
      if (o.frameChanged !== false && mayBeHidden) {
        entry.reason +=
          "; the layer has " +
          (l.animators > 0 ? "text animators" : "effects") +
          " that may hide or move the characters at this time (a typewriter or opacity animator at 0%, a position animator), so this is not counted as a failure";
      }
      entry.status = o.frameChanged === false || mayBeHidden ? "inconclusive" : "fail";
      entry.notes = notes;
      return entry;
    }
  }
  if (a.status !== "ok") {
    entry.reason =
      a.status === "transparent"
        ? "the pixels behind the text are transparent, so the contrast depends on what the comp is placed over"
        : "no background pixels could be read around the box";
    entry.notes = notes;
    return entry;
  }

  const stats = ratioStats(a.ratios, req.ratio, j.tolerance);
  entry.status = stats.pass ? "pass" : "fail";
  entry.ratio = { min: stats.min, low: stats.low, median: stats.median };
  entry.fail_share = stats.fail_share;
  entry.measured_pixels = a.core_pixels;
  if (a.text_rgb) entry.text_colour = hex(a.text_rgb);
  if (a.bg_mean) entry.background_mean = hex(a.bg_mean);
  if (a.fail_bounds) entry.fail_box = toComp(a.fail_bounds);
  const foreign = a.foreign_share ?? 0;
  if (o.measured === "pixels" && stats.pass && (foreign > FOREIGN_LIMIT || (s.mixed_fill === true && foreign > 0.05))) {
    entry.status = "inconclusive";
    entry.reason =
      Math.round(foreign * 100) +
      "% of the glyph pixels are a different colour from the dominant text colour " +
      (a.text_rgb ? hex(a.text_rgb) : "") +
      " (a second fill colour, a highlighted word or a coloured stroke) and were not measured, so a pass for the dominant colour does not show that all the text is legible";
    notes.push("Only the dominant text colour was judged. Check the other colour separately.");
  } else if (o.measured === "pixels" && stats.pass && s.mixed_fill === true && a.thin) {
    entry.status = "inconclusive";
    entry.reason = "the characters have different fill colours and no flat colour was found, so the whole glyph mask was judged as one";
  }
  if (a.thin) notes.push("Few solid pixels were found (small type or a gradient fill), so antialiased pixels are counted too: the ratio reads a little low.");
  if (a.excluded_pixels > 0) notes.push(`${a.excluded_pixels} pixels shared with another text box were left out.`);
  if (a.transparent_pixels > 0) notes.push(`${a.transparent_pixels} text pixels over a transparent background were not measured.`);
  if (o.measured === "pixels" && s.fill_rgb && a.text_rgb) {
    const dom = s.fill_rgb.map((v) => v * 255);
    if (colourDistance(dom, a.text_rgb) > 30) {
      entry.dom_fill_differs = true;
      notes.push(`The render shows ${hex(a.text_rgb)} but the layer's fill is ${hex(dom)}: animators, effects, layer styles or opacity change it. The measured colour is the one used.`);
    }
  }
  if (!stats.pass && o.fixes && a.text_rgb && a.core_pixels > 0) {
    entry.fixes = suggestFixes({
      compId: o.compId,
      layer: head(l),
      textRgb: a.text_rgb,
      analysis: a,
      required: req.ratio,
      tolerance: j.tolerance,
      box: s.box!,
      fontPx: s.screen_font_px,
      comp: o.comp,
    });
  }
  if (notes.length > 0) entry.notes = notes;
  return entry;
}

// ---------- the annotated PNG ----------

const GREEN: Rgba = [64, 224, 64, 255];
const RED: Rgba = [255, 48, 48, 255];
const AMBER: Rgba = [255, 176, 0, 255];
const INK: Rgba = [16, 16, 16, 255];
const MAGENTA: Rgba = [255, 0, 255, 96];

export function overlayLabel(e: LegibilityEntry): string {
  if (e.ratio) return `${e.layer.index} ${e.ratio.low.toFixed(1)}:1`;
  return `${e.layer.index} ?`;
}

/** Draws the checked boxes and the overlaps on a shrunk copy of the render. */
export function drawLegibilityOverlay(
  frame: PNG,
  comp: { width: number; height: number },
  entries: LegibilityEntry[],
  overlaps: OverlapPair[],
  maxSize: number
): PNG {
  const size = fitWithin(frame.width, frame.height, maxSize);
  let base: PNG = resizeArea(frame, size.width, size.height);
  if (hasTransparency(base)) base = flattenOnChecker(base, 8);
  const sx = base.width / comp.width;
  const sy = base.height / comp.height;
  const scale = Math.max(1, Math.min(3, Math.round(Math.max(base.width, base.height) / 700)));
  for (const o of overlaps) {
    fillRect(base, Math.round(o.rect[0] * sx), Math.round(o.rect[1] * sy), Math.round((o.rect[2] - o.rect[0]) * sx), Math.round((o.rect[3] - o.rect[1]) * sy), MAGENTA);
  }
  const placed: Array<{ x: number; y: number; w: number; h: number }> = [];
  for (const e of entries) {
    if (!e.box || e.status === "not_visible" || e.status === "not_checkable") continue;
    const colour = e.status === "pass" ? GREEN : e.status === "fail" ? RED : AMBER;
    const x = Math.round(e.box[0] * sx);
    const y = Math.round(e.box[1] * sy);
    const w = Math.max(2, Math.round((e.box[2] - e.box[0]) * sx));
    const h = Math.max(2, Math.round((e.box[3] - e.box[1]) * sy));
    strokeRect(base, x, y, w, h, e.status === "fail" ? 3 : 2, colour);
    if (e.fail_box) {
      const fx = Math.round(e.fail_box[0] * sx);
      const fy = Math.round(e.fail_box[1] * sy);
      strokeRect(base, fx, fy, Math.max(2, Math.round((e.fail_box[2] - e.fail_box[0]) * sx)), Math.max(2, Math.round((e.fail_box[3] - e.fail_box[1]) * sy)), 1, [255, 255, 255, 255]);
    }
    const text = overlayLabel(e);
    const lw = textWidth(text, scale) + 4;
    const lh = GLYPH_HEIGHT * scale + 4;
    let ly = y - lh >= 0 ? y - lh : y;
    // Step past labels already placed there.
    for (let tries = 0; tries < 12 && placed.some((p) => x < p.x + p.w && p.x < x + lw && ly < p.y + p.h && p.y < ly + lh); tries++) ly += lh + 1;
    ly = Math.min(Math.max(0, ly), Math.max(0, base.height - lh));
    drawLabel(base, text, Math.min(Math.max(0, x), Math.max(0, base.width - lw)), ly, scale, INK, colour, 2);
    placed.push({ x, y: ly, w: lw, h: lh });
  }
  return base;
}

// ---------- shared plumbing ----------

const errMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

const NOTES_COMMON = [
  "Boxes are each text layer's sourceRectAtTime moved through its transforms and parents: the whole layer, not single glyphs. Text inside precomps, 3D text and text parented to a 3D layer are not checked (listed as not checkable).",
  "Ratios are WCAG 2.x contrast ratios on the PNG's pixel values taken as sRGB. Whether AE writes sRGB with colour management on (OCIO, linear blending, 16/32 bpc) is unmeasured: in a wide-gamut or linear-light project the figures can be off.",
];

const SKIPPED_CAP = 100;

function layerSummary(read: HostRead) {
  return {
    comp: { id: read.comp.id, name: read.comp.name, width: read.comp.width, height: read.comp.height },
    times: read.times,
    text_layers: read.text_layers,
    truncated: read.truncated,
  };
}

/** Overlap pairs among the layers that show with a box at sample `ti`. */
export function overlapsAt(read: HostRead, ti: number, minShare: number): { pairs: OverlapPair[]; truncated: boolean } {
  const items: BoxItem[] = [];
  for (const l of read.layers) {
    const s = l.samples[ti];
    if (s && s.visible && s.box) items.push({ ...head(l), box: s.box });
  }
  return findOverlaps(items, minShare);
}

/** Entries for every sample that can't be measured, capped. */
function skippedEntries(read: HostRead, only?: Set<number>): { skipped: LegibilityEntry[]; total: number } {
  const all: LegibilityEntry[] = [];
  for (const l of read.layers) {
    for (const s of l.samples) {
      const e = skippedEntry(l, s);
      if (e && (!only || only.has(l.id))) all.push(e);
    }
  }
  return { skipped: all.slice(0, SKIPPED_CAP), total: all.length };
}

/** AE stopped answering (a timeout, or a wait behind a stuck call): rendering more times would only queue behind the same block. */
export function isAeBlocked(err: unknown): boolean {
  return err instanceof BridgeError && (err.kind === "timeout" || err.kind === "queued");
}

const BLOCKED_NOTE = "AE stopped responding during a render (often a modal dialog); the remaining times were not rendered. Check ae_dialogs, then run again.";

/** Skipped entries plus the ones the render stage found (a box outside the frame), capped. */
function withExtra(sk: { skipped: LegibilityEntry[]; total: number }, extra: LegibilityEntry[]): { skipped: LegibilityEntry[]; total: number } {
  return { skipped: [...sk.skipped, ...extra].slice(0, SKIPPED_CAP), total: sk.total + extra.length };
}

const OFF_FRAME = "its box is outside the frame at this time";

const runQueued = async <T>(ctx: ToolContext, label: string, opId: string, fn: () => Promise<T>): Promise<T> => {
  try {
    return await ctx.queue.run(label, fn);
  } catch (err) {
    if (err instanceof QueueWaitError) throw new BridgeError({ kind: "queued", op_id: opId, message: err.message });
    throw err;
  }
};

async function readText(ctx: ToolContext, opId: string, tool: string, label: string, args: { comp_id: number; times?: number[]; layers?: unknown[] }): Promise<HostRead> {
  const res = await ctx.bridge.evalRaw<HostRead>({
    id: `${opId}_read`,
    script: buildJsxCall("legibilityRead", { comp_id: args.comp_id, times: args.times, layers: args.layers }),
    label: `${label} (read)`,
    timeoutMs: SLOW_TIMEOUT_MS,
    mutates: false,
    toolName: tool,
  });
  return res.result;
}

function summarise(entries: LegibilityEntry[]) {
  const count = (s: EntryStatus) => entries.filter((e) => e.status === s).length;
  const failed = entries.filter((e) => e.status === "fail");
  let verdict: "pass" | "fail" | "inconclusive" = "pass";
  if (failed.length > 0) verdict = "fail";
  else if (entries.length === 0 || entries.some((e) => e.status === "inconclusive")) verdict = "inconclusive";
  const worst = failed
    .filter((e) => e.ratio)
    .sort((a, b) => a.ratio!.low - b.ratio!.low)
    .slice(0, 5)
    .map((e) => ({ layer: e.layer, time: e.time, ratio_low: e.ratio!.low, required: e.required_ratio }));
  return { verdict, checked: entries.length, pass: count("pass"), fail: failed.length, inconclusive: count("inconclusive"), worst };
}

function writeOverlay(framesDir: string, compId: number, time: number, png: PNG): string {
  const file = path.join(framesDir, `legibility_c${compId}_${Math.round(time * 1000)}_${crypto.randomBytes(4).toString("hex")}.png`);
  fs.writeFileSync(file, encodePng(png));
  return file;
}

// ---------- ae_check_text_overlap ----------

export function overlapReport(read: HostRead, minShare: number) {
  const perTime = read.times.map((time, ti) => {
    const { pairs, truncated } = overlapsAt(read, ti, minShare);
    return { time, overlaps: pairs, ...(truncated ? { truncated: true } : {}) };
  });
  const { skipped, total } = skippedEntries(read);
  return {
    ...layerSummary(read),
    min_overlap: minShare,
    overlap_count: perTime.reduce((n, t) => n + t.overlaps.length, 0),
    times_checked: perTime,
    skipped,
    ...(total > skipped.length ? { skipped_truncated: true, skipped_total: total } : {}),
    notes: [NOTES_COMMON[0], "Only the layers' boxes are compared (DOM only, no render): two lines of text in the same layer never count, and glyphs that don't fill their box may not really collide."],
  };
}

// ---------- ae_estimate_legibility ----------

const RING_SHARE = 0.3;

async function estimateHandler(args: AeEstimateLegibilityArgs, ctx: ToolContext) {
  const tool = "ae_estimate_legibility";
  const framesDir = defaultFramesDir();
  fs.mkdirSync(framesDir, { recursive: true });
  const opId = ctx.bridge.newOpId();
  const label = `${tool}(${args.comp_id})`;
  const judging: Judging = { required: { level: args.level, minRatio: args.min_ratio, largeTextPx: args.large_text_px }, tolerance: args.tolerance };

  const got = await runQueued(ctx, label, opId, async () => {
    const read = await readText(ctx, opId, tool, label, args);
    const frames: Array<{ path: string; time: number } | { error: string }> = [];
    let blocked = false;
    for (let ti = 0; ti < read.times.length; ti++) {
      // Only frames of times where something shows are rendered.
      const needed = read.layers.some((l) => l.samples[ti].visible && l.samples[ti].box);
      if (!needed) {
        frames.push({ error: "no text layer shows with a box at this time" });
        continue;
      }
      if (blocked) {
        frames.push({ error: BLOCKED_NOTE });
        continue;
      }
      try {
        const snap = await captureCompFrame({ ctx, opId, compId: args.comp_id, time: read.times[ti], frameIndex: ti, framesDir, toolName: tool });
        frames.push(snap);
      } catch (err) {
        frames.push({ error: errMessage(err) });
        if (isAeBlocked(err)) blocked = true;
      }
    }
    return { read, frames, blocked };
  });

  const { read } = got;
  const comp = read.comp;
  const entries: LegibilityEntry[] = [];
  const offFrame: LegibilityEntry[] = [];
  const timeResults = read.times.map((time, ti) => {
    const frame = got.frames[ti];
    const timeEntries: LegibilityEntry[] = [];
    let overlays: OverlapPair[] = [];
    let annotated: string | undefined;
    let timeError: string | undefined;
    let annotateError: string | undefined;
    if ("error" in frame) {
      const unrendered = read.layers.filter((l) => l.samples[ti].visible && l.samples[ti].box);
      if (unrendered.length > 0) timeError = frame.error;
      for (const l of unrendered) {
        timeEntries.push({ layer: head(l), time, status: "inconclusive", measured: "none", reason: `this time could not be rendered: ${frame.error}` });
      }
    } else {
      const pendingOff: LegibilityEntry[] = [];
      const items = read.layers.filter((l) => l.samples[ti].visible && l.samples[ti].box);
      try {
        const img = decodePngFile(frame.path);
        const regions = new Map<number, PixelRegion>();
        for (const l of items) {
          const r = boxToRegion(l.samples[ti].box!, comp, img);
          if (r) regions.set(l.id, r);
        }
        for (const l of items) {
          const s = l.samples[ti];
          const box = regions.get(l.id);
          if (!box) {
            pendingOff.push({ layer: head(l), time: s.time, status: "not_checkable", measured: "none", reason: OFF_FRAME });
            continue;
          }
          const exclude = [...regions.entries()].filter(([id]) => id !== l.id).map(([, r]) => r);
          const ring = Math.max(4, Math.round((box.y1 - box.y0) * RING_SHARE));
          const fill = s.fill_rgb ? (s.fill_rgb.map((v) => v * 255) as [number, number, number]) : null;
          const analysis = fill
            ? analyzeEstimate(img, box, ring, fill, { required: requiredRatio({ level: args.level, minRatio: args.min_ratio, fontPx: s.screen_font_px, bold: s.bold, largeTextPx: args.large_text_px }).ratio, exclude })
            : emptyAnalysis("no_background");
          timeEntries.push(judgeAnalysis(l, s, analysis, judging, { measured: "estimate", compId: comp.id, comp, img, fixes: false }));
        }
        overlays = overlapsAt(read, ti, args.min_overlap).pairs;
        offFrame.push(...pendingOff);
        if (args.annotate) {
          try {
            annotated = writeOverlay(framesDir, comp.id, time, drawLegibilityOverlay(img, comp, timeEntries, overlays, args.max_size));
          } catch (err) {
            annotateError = errMessage(err);
          }
        }
      } catch (err) {
        // A frame that cannot be decoded or judged leaves no pass behind: every layer showing at this time is inconclusive.
        timeError = errMessage(err);
        timeEntries.length = 0;
        overlays = [];
        for (const l of items) {
          timeEntries.push({ layer: head(l), time, status: "inconclusive", measured: "none", reason: `this time could not be measured: ${timeError}` });
        }
      }
    }
    entries.push(...timeEntries);
    return {
      time,
      ...(annotated ? { annotated_path: annotated } : {}),
      ...(timeError ? { error: timeError } : {}),
      ...(annotateError ? { annotate_error: annotateError } : {}),
      layers: timeEntries,
      overlaps: overlays,
    };
  });

  const { skipped, total } = withExtra(skippedEntries(read), offFrame);
  return {
    ok: true,
    read_only: true,
    mode: "estimate",
    ...(got.blocked ? { ae_blocked: BLOCKED_NOTE } : {}),
    ...layerSummary(read),
    required: { level: args.level, ...(args.min_ratio !== undefined ? { min_ratio: args.min_ratio } : {}), large_text_px: args.large_text_px, tolerance: args.tolerance },
    ...summarise(entries),
    times_checked: timeResults,
    skipped,
    ...(total > skipped.length ? { skipped_truncated: true, skipped_total: total } : {}),
    notes: [
      "ESTIMATE. The fill colour is the one the DOM reports for the first character, which ignores animators, effects, layer styles, opacity and blend modes, and the background is the ring of pixels around each box, not what is behind the glyphs. Treat a pass as 'probably fine' and any figure as approximate; ae_check_legibility measures the real glyph pixels.",
      ...NOTES_COMMON,
    ],
  };
}

// ---------- ae_check_legibility ----------

export interface ProofState {
  num_items: number;
  comps: number;
  temp_comps: number;
  /** The tested layers of the original comp and whether each is switched on. */
  layers?: Array<{ id: number; enabled: boolean }>;
}

/** The receipt's checks: the temporary comp must be gone. */
export function tempCompMismatches(before: unknown, after: unknown, cleanupError: string | null, copyId: number | undefined): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  if (cleanupError) {
    m.push({
      path: "temp_comp",
      expected: "the temporary comp removed",
      actual: copyId,
      message: `The temporary comp (id ${copyId}) was not removed: ${cleanupError}. Delete it in the Project panel; its name starts with "chroma-legibility-copy".`,
    });
  }
  const b = before as ProofState | null;
  const a = after as ProofState | null;
  if (b && a) {
    // Compared with before: an older copy (a failed cleanup, or a user comp with that name) is not this run's.
    expectThat(m, a.temp_comps <= b.temp_comps, "temp_comps", b.temp_comps, a.temp_comps, "A temporary legibility comp is still in the project");
    // The item count is not asserted: an import or a new comp made by hand during the renders is not this run's doing. temp_comps is the real check.
    // The write must have touched the copy only: every tested layer that was on in the original is still on.
    if (Array.isArray(b.layers) && Array.isArray(a.layers)) {
      const now = new Map(a.layers.map((l) => [l.id, l.enabled]));
      for (const l of b.layers) {
        if (l.enabled && now.get(l.id) !== true) {
          expectThat(m, false, `layers.${l.id}.enabled`, true, now.get(l.id), `Text layer ${l.id} of the original comp was switched off (or is gone); the check should only have changed its copy`);
        }
      }
    }
  }
  return m;
}

const MAX_TEST_LAYERS = 100;

/** The text layers with at least one sample that shows with a box, capped; the rest of the visible ones come back as overflow. */
export function testableLayers(read: HostRead): { tested: HostTextLayer[]; overflow: HostTextLayer[] } {
  const all = read.layers.filter((l) => l.samples.some((s) => s.visible && s.box));
  return { tested: all.slice(0, MAX_TEST_LAYERS), overflow: all.slice(MAX_TEST_LAYERS) };
}

async function matchedPair(p: {
  ctx: ToolContext;
  opId: string;
  compId: number;
  copyId: number;
  time: number;
  index: number;
  framesDir: string;
  toolName: string;
}): Promise<{ original: string; copy: string; time: number }> {
  const { ctx, opId, compId, copyId, time, index, framesDir, toolName } = p;
  let a = await captureCompFrame({ ctx, opId, compId, time, frameIndex: index * 4, framesDir, toolName });
  let b = await captureCompFrame({ ctx, opId, compId: copyId, time, frameIndex: index * 4 + 1, framesDir, toolName });
  // A stale-frame retry may have nudged one render's time: bring the other to it.
  if (a.time !== b.time) {
    const later = Math.max(a.time, b.time);
    if (a.time < later) a = await captureCompFrame({ ctx, opId, compId, time: later, frameIndex: index * 4 + 2, framesDir, toolName });
    else b = await captureCompFrame({ ctx, opId, compId: copyId, time: later, frameIndex: index * 4 + 3, framesDir, toolName });
    if (a.time !== b.time) throw new Error(`the original and the copy rendered at different times (${a.time}s and ${b.time}s)`);
  }
  return { original: a.path, copy: b.path, time: a.time };
}

/** True when any pixel anywhere differs between the two frames by more than the limit. */
export function frameDiffers(a: RgbaImage, b: RgbaImage, sensitivity: number): boolean {
  const limit = sensitivity * 255;
  const n = a.width * a.height * 4;
  for (let i = 0; i < n; i += 4) {
    if (
      Math.abs(a.data[i] - b.data[i]) > limit ||
      Math.abs(a.data[i + 1] - b.data[i + 1]) > limit ||
      Math.abs(a.data[i + 2] - b.data[i + 2]) > limit ||
      Math.abs(a.data[i + 3] - b.data[i + 3]) > limit
    ) {
      return true;
    }
  }
  return false;
}

async function checkHandler(args: AeCheckLegibilityArgs, ctx: ToolContext) {
  ctx.quarantine.assertClear();
  const opId = ctx.bridge.newOpId();
  const label = `ae_check_legibility(${args.comp_id})`;
  const toolName = "ae_check_legibility";
  const expect = { project_path: args.expect.project_path, comp_id: args.expect.comp_id ?? args.comp_id };
  const framesDir = defaultFramesDir();
  const judging: Judging = { required: { level: args.level, minRatio: args.min_ratio, largeTextPx: args.large_text_px }, tolerance: args.tolerance };
  let proofLayerIds: number[] = [];
  const state = async (phase: string) => {
    const res = await ctx.bridge.evalRaw({
      id: `${opId}_${phase}`,
      script: buildJsxCall("legibilityState", proofLayerIds.length > 0 ? { comp_id: args.comp_id, layer_ids: proofLayerIds } : {}),
      label: `${label} (${phase})`,
      mutates: false,
      toolName,
    });
    return res.result ?? null;
  };

  try {
    return await ctx.queue.run(label, async () => {
      ctx.quarantine.assertClear();
      // Read-only, before the checkpoint: a comp with nothing to check leaves no trace.
      const read = await readText(ctx, opId, toolName, label, args);
      const { tested, overflow } = testableLayers(read);
      if (tested.length === 0) {
        const { skipped, total } = skippedEntries(read);
        return {
          ok: false,
          error: "nothing_to_check",
          message: read.text_layers === 0 ? "The comp has no text layers." : "No text layer shows with a measurable box at the chosen times.",
          ...layerSummary(read),
          skipped,
          ...(total > skipped.length ? { skipped_truncated: true, skipped_total: total } : {}),
        };
      }
      const guard = await verifyTargetGuard(ctx, expect, opId);
      const checkpoint = await autoCheckpoint(ctx, guard, toolName);
      const note = { opId, toolName, label, expect, checkpoint: checkpoint?.path ?? null };
      const sessionFields = await noteBeforeWrite(ctx, note);
      proofLayerIds = tested.map((l) => l.id);
      const before = await state("before");
      fs.mkdirSync(framesDir, { recursive: true });

      // The record lives from the duplicate to the removal; if AE dies in
      // between, it is still there at the next start.
      beginInflight(note);
      let begun: Record<string, unknown>;
      try {
        const begin = await ctx.bridge.evalRaw<Record<string, unknown>>({
          id: opId,
          script: buildJsxCall("legibilityBegin", { comp_id: args.comp_id, layers: tested.map(head), expect }),
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
      const comp = read.comp;
      const entries: LegibilityEntry[] = [];
      let timeResults: Array<Record<string, unknown>> = [];
      const offFrame: LegibilityEntry[] = [];
      let blocked = false;
      try {
        if (typeof copyId !== "number") throw new Error("AE returned no id for the temporary comp, so nothing was rendered");
        for (let ti = 0; ti < read.times.length; ti++) {
          const time = read.times[ti];
          const rows = tested.filter((l) => l.samples[ti].visible && l.samples[ti].box);
          const overlaps = overlapsAt(read, ti, args.min_overlap).pairs;
          if (rows.length === 0) {
            timeResults.push({ time, layers: [], overlaps, note: "no tested text layer shows with a box at this time" });
            continue;
          }
          const timeEntries: LegibilityEntry[] = [];
          if (blocked) {
            for (const l of rows) {
              timeEntries.push({ layer: head(l), time, status: "inconclusive", measured: "none", reason: "AE stopped responding, so this time was not rendered" });
            }
            timeResults.push({ time, error: "not rendered: AE stopped responding", layers: timeEntries, overlaps });
            entries.push(...timeEntries);
            continue;
          }
          const pendingOff: LegibilityEntry[] = [];
          try {
            const pair = await matchedPair({ ctx, opId, compId: args.comp_id, copyId, time, index: ti, framesDir, toolName });
            const orig = decodePngFile(pair.original);
            const copy = decodePngFile(pair.copy);
            if (orig.width !== copy.width || orig.height !== copy.height) {
              throw new Error(`the renders differ in size (${orig.width}x${orig.height} and ${copy.width}x${copy.height})`);
            }
            const changed = frameDiffers(orig, copy, args.sensitivity);
            const regions = new Map<number, PixelRegion>();
            for (const l of rows) {
              const r = boxToRegion(l.samples[ti].box!, comp, orig, Math.max(2, 0.04 * (l.samples[ti].box![3] - l.samples[ti].box![1])));
              if (r) regions.set(l.id, r);
            }
            for (const l of rows) {
              const s = l.samples[ti];
              const region = regions.get(l.id);
              if (!region) {
                pendingOff.push({ layer: head(l), time: s.time, status: "not_checkable", measured: "none", reason: OFF_FRAME });
                continue;
              }
              // The other tested layers' boxes: their text is off in the copy, so its pixels are not this layer's background.
              const exclude = [...regions.entries()].filter(([id]) => id !== l.id).map(([, r]) => r);
              const required = requiredRatio({ level: args.level, minRatio: args.min_ratio, fontPx: s.screen_font_px, bold: s.bold, largeTextPx: args.large_text_px }).ratio;
              const analysis = analyzeGlyphs(orig, copy, region, { sensitivity: args.sensitivity, required, exclude });
              timeEntries.push(judgeAnalysis(l, s, analysis, judging, { measured: "pixels", compId: comp.id, comp, img: orig, fixes: args.fixes, frameChanged: changed }));
            }
            offFrame.push(...pendingOff);
            let annotated: string | undefined;
            let annotateError: string | undefined;
            if (args.annotate) {
              // A failed drawing must not turn the judged rows into inconclusive duplicates.
              try {
                annotated = writeOverlay(framesDir, comp.id, pair.time, drawLegibilityOverlay(orig, comp, timeEntries, overlaps, args.max_size));
              } catch (err) {
                annotateError = errMessage(err);
              }
            }
            timeResults.push({
              time: pair.time,
              frames: { original: pair.original, copy: pair.copy },
              ...(annotated ? { annotated_path: annotated } : {}),
              ...(annotateError ? { annotate_error: annotateError } : {}),
              frame_changed: changed,
              layers: timeEntries,
              overlaps,
            });
          } catch (err) {
            // One bad time does not stop the others, and the copy still gets removed. A timeout does stop them: every later render would queue behind the same block.
            if (isAeBlocked(err)) blocked = true;
            timeEntries.length = 0;
            for (const l of rows) {
              timeEntries.push({ layer: head(l), time, status: "inconclusive", measured: "none", reason: `this time could not be measured: ${errMessage(err)}` });
            }
            timeResults.push({ time, error: errMessage(err), layers: timeEntries, overlaps });
          }
          entries.push(...timeEntries);
        }
      } catch (err) {
        timeResults = [...timeResults, { error: errMessage(err), layers: [], overlaps: [] }];
      }

      let cleanupError: string | null = null;
      let removed = false;
      // The removal is a write of its own: registered, so the session bridge hook leaves it alone and does not report the temp comp as the user's change.
      const removeId = `${opId}_remove`;
      beginInflight({ ...note, opId: removeId });
      try {
        if (typeof copyId !== "number") {
          throw new Error("AE returned no id for the temporary comp, so it could not be removed by id");
        }
        const end = await ctx.bridge.evalRaw<Record<string, unknown>>({
          id: removeId,
          script: buildJsxCall("legibilityEnd", { copy_id: copyId, expect }),
          label: `${label} (remove copy)`,
          mutates: true,
          toolName,
        });
        // already_gone is not a removal this call made, so it does not count as removed.
        removed = (end.result as { removed?: boolean } | undefined)?.removed === true;
      } catch (err) {
        cleanupError = errMessage(err);
      } finally {
        endInflight(removeId);
        endInflight(opId);
      }

      const { value: after, failure } = await readAfterWrite(opId, () => state("after"));
      const custom = [...(failure ? [failure] : []), ...tempCompMismatches(before, failure ? null : after, cleanupError, copyId)];
      const receipt = buildReceipt({ before, after, customMismatches: custom });
      await noteAfterWrite(ctx, note, { skipRead: !!failure });

      // Layers past the cap are named in the output (and count as inconclusive), not silently dropped.
      const untestedAll: LegibilityEntry[] = [];
      for (const l of overflow) {
        for (const s of l.samples) {
          if (s.visible && s.box) {
            untestedAll.push({ layer: head(l), time: s.time, status: "inconclusive", measured: "none", reason: `only ${MAX_TEST_LAYERS} text layers are tested per call; pass \`layers\` for the rest` });
          }
        }
      }
      entries.push(...untestedAll);
      const untested = untestedAll.slice(0, SKIPPED_CAP);
      const olderCopies = (before as ProofState | null)?.temp_comps ?? 0;
      const { skipped, total } = withExtra(skippedEntries(read), offFrame);
      return {
        op_id: opId,
        applied: true as const,
        mode: "exact",
        ...layerSummary(read),
        required: { level: args.level, ...(args.min_ratio !== undefined ? { min_ratio: args.min_ratio } : {}), large_text_px: args.large_text_px, tolerance: args.tolerance, sensitivity: args.sensitivity },
        ...summarise(entries),
        times_checked: timeResults,
        skipped,
        ...(total > skipped.length ? { skipped_truncated: true, skipped_total: total } : {}),
        ...(untested.length > 0 ? { untested, ...(untestedAll.length > untested.length ? { untested_truncated: true, untested_total: untestedAll.length } : {}) } : {}),
        ...(blocked ? { ae_blocked: BLOCKED_NOTE } : {}),
        temp_comp: { copy_removed: removed, switched_off: begun.switched_off },
        notes: [
          "EXACT. For each time the comp is rendered with the text on and, in a temporary copy, with the tested text layers off. The pixels that differ are the glyphs (so their colour is the text as it renders, animators, effects and layer styles included) and the copy's pixels at those positions are the background (grades and layers above included). Where two tested text boxes overlap, those pixels are left out of both and the overlap is reported.",
          "Text so close to its background that no channel differs by more than `sensitivity` can't be told apart from it: such a layer is reported as a failure when the frame differs elsewhere, and as inconclusive when the frame differs nowhere or the layer has animators/effects that may hide it.",
          "Fixes are suggestions, computed from the background pixels; a scrim's opacity is chosen so that no more than the tolerance of them miss the ratio once blended (in encoded sRGB). Nothing was applied.",
          "Text with a second colour (a highlighted word, a coloured stroke) is judged on its dominant colour only: when the other colour covers a large share of the glyphs, a pass is reported as inconclusive.",
          ...(olderCopies > 0 ? [`The project already had ${olderCopies} comp(s) named 'chroma-legibility-copy ...' before this run (left by an earlier run, or made by hand). They were not touched; delete them if they are not wanted.`] : []),
          ...NOTES_COMMON,
        ],
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
}

// ---------- tools ----------

export const legibilityTools: ToolDefinition<any>[] = [
  {
    name: "ae_check_text_overlap",
    description:
      "READ-ONLY, no render. Finds text layers whose boxes overlap other text at the chosen times (default the comp's current time), from the DOM: each text layer's sourceRectAtTime moved through its transforms and parents. " +
      "Returns the overlapping pairs (layer index, id, name; the intersection rectangle in comp pixels; its share of the smaller box) and the text layers that can't be boxed (switched off, outside their in/out points, 3D, empty). " +
      "Boxes are whole layers, not glyphs: a box can overlap while the glyphs don't touch. Text in precomps is not seen. For contrast against the picture use ae_estimate_legibility or ae_check_legibility. " +
      "Strictly read-only: never moves the time indicator or changes selection, solo or the project.",
    schema: AeCheckTextOverlapSchema,
    handler: async (args: AeCheckTextOverlapArgs, ctx: ToolContext) => {
      const res = await ctx.bridge.callHost<HostRead>(
        "legibilityRead",
        { comp_id: args.comp_id, times: args.times, layers: args.layers },
        { label: `ae_check_text_overlap(${args.comp_id})`, mutates: false, toolName: "ae_check_text_overlap", timeoutMs: SLOW_TIMEOUT_MS }
      );
      return { ok: true, read_only: true, ...overlapReport(res.result as HostRead, args.min_overlap) };
    },
  },
  {
    name: "ae_estimate_legibility",
    description:
      "READ-ONLY estimate of text legibility from one normal render per time: the WCAG contrast ratio between each text layer's fill colour (as the DOM reports it) and the pixels in a ring around its box, plus text boxes that overlap other text, and an annotated PNG (failing boxes red with the ratio printed). " +
      "WEAK by design: the DOM colour ignores animators, effects, layer styles, opacity and blend modes (a layer whose fill colour is not found in its box is reported as not conclusive), and the ring is beside the text, not behind the glyphs. Use it for a quick look that changes nothing in the project; use ae_check_legibility for the real figure. " +
      "Required ratio by WCAG level and text size (`level`, `large_text_px`), or `min_ratio`. Strictly read-only: the comp's time, resolution, selection and solo are not touched, nothing lands on the undo stack. Each time is a render.",
    schema: AeEstimateLegibilitySchema,
    handler: estimateHandler,
  },
  {
    name: "ae_check_legibility",
    description:
      "Exact legibility check: the WCAG contrast ratio of each text layer against the real picture behind it, at chosen times. " +
      "How: it duplicates the comp, switches the tested text layers OFF in the copy, renders the original and the copy at the same times and diffs them. The changed pixels are the glyphs, so the text colour is what actually renders (animators, effects and layer styles included), and the copy's pixels at those positions are the true background (grades and layers above included). The copy is removed again. " +
      "Returns per layer and time: pass/fail, the ratio (min, `low` = the ratio reached by (1 - `tolerance`) of the measured pixels, 90% at the default; median), the required ratio (by `level` and size, or `min_ratio`), the text and mean background colour, the box where it fails, text boxes that overlap other text, and an annotated PNG (failing boxes in red with the ratio printed). " +
      "With `fixes` it suggests, for failures, a text colour and a scrim (colour, opacity, rectangle, and ready ae_create_layer arguments); nothing is applied. " +
      "It writes to the project: a temporary comp named 'chroma-legibility-copy ...' appears in the Project panel for the length of the renders, in two undo groups (add the copy, remove the copy), with an automatic checkpoint first; the receipt checks the copy is gone and the original text layers are still on. Refuses before the checkpoint when no text layer shows at the chosen times. " +
      "Not checked: text in precomps, 3D text. Unmeasured: the colour space of AE's PNG (taken as sRGB). Renders twice per time, so keep `times` few. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeCheckLegibilitySchema,
    handler: checkHandler,
  },
];
