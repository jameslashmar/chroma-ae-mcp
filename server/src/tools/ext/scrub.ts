/**
 * server/src/tools/ext/scrub.ts
 *
 * ae_scrub_check: looks for motion problems that single snapshots and
 * metadata checks can't see. It takes frame PAIRS (a frame and the next one)
 * spread across a comp's work area or a rendered file, and in Node checks:
 * - black, transparent and blank (one colour) stretches, the last frames included
 * - frozen runs (identical frames at every sample point)
 * - pops (a frame-to-frame jump far above the shot's usual change, away from
 *   markers and layer in/out points) and flicker (brightness jumping up and
 *   down)
 * - content touching some edges but not others (a heuristic for cut-off)
 * - clipped highlights ("RGB extremes"; AE hands over full-range RGB, so
 *   video levels 16-235 can't be judged from its PNGs)
 * - missing numbers in an image sequence, wrong size and non-square pixels
 * It returns pass, warn or fail with times, a contact sheet of each suspect
 * frame beside its neighbour, and the frame-difference curve as a chart.
 *
 * Comp mode changes nothing. File mode imports the render and builds a
 * temporary comp to grab frames from (a guarded write with an automatic
 * checkpoint), then removes both again and reads back that they are gone.
 * Not built: the silent-audio-tail check on movies (the audio decoder reads
 * WAV and AIFF only; ae_audio_analyze covers a comp's sound).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { PNG } from "pngjs";
import { z } from "zod";
import { BridgeError } from "../../host.js";
import { buildJsxCall } from "../../jsx.js";
import { QueueWaitError } from "../../queue.js";
import type { ReceiptMismatch } from "../../receipts.js";
import { AGENT_SAFETY_GUIDANCE, ExpectSchema, type ToolContext, type ToolDefinition } from "../common.js";
import { autoCheckpoint, verifyTargetGuard } from "../mutate.js";
import { readBackMismatch } from "../read-back.js";
import { defaultFramesDir } from "../render.js";
import {
  analyzeDecodedFrame,
  captureCompFrame,
  compareDecodedFrames,
  decodePngFile,
  type FrameFlag,
} from "./frames.js";
import { buildContactSheet, sheetLayout, type SheetTile } from "./motion.js";
import {
  createCanvas,
  drawLine,
  drawText,
  encodePng,
  fillRect,
  resizeArea,
  textWidth,
  type Rgba,
} from "./png-utils.js";
import { looksLikeSequence } from "./verify.js";

// ---------- schema ----------

export const SCRUB_MAX_SAMPLES = 60;
const MAX_LIST = 500;
/** Where inside a frame the sample time lands, so rounding either way picks that frame. */
const SAMPLE_PHASE = 0.25;

export const ScrubThresholdsSchema = z
  .object({
    pop_min_diff: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("A frame-to-frame change (mean absolute pixel difference, 0..1) must exceed this to count as a pop. Default 0.03."),
    pop_factor: z
      .number()
      .min(1)
      .max(100)
      .optional()
      .describe("...and exceed this many times the shot's median frame-to-frame change. Default 6."),
    flicker_luma: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("A brightness change (mean luma, 0..1) between a frame and the next one of at least this is a swing; flicker needs several swings that alternate up and down. Default 0.04."),
    frozen_min_seconds: z
      .number()
      .min(0)
      .max(3600)
      .optional()
      .describe("Identical frames at every sample point for at least this long are a frozen run. Default 0.5."),
    clip_pct: z
      .number()
      .min(0)
      .max(100)
      .optional()
      .describe("Percent of opaque pixels with a channel at 254 or 255 above which a frame counts as clipped. Default 5."),
    black_min_seconds: z
      .number()
      .min(0)
      .max(3600)
      .optional()
      .describe("A black or transparent stretch at the start or end of the range fails only when it lasts at least this long (a fade from or to black is normal); a shorter one is a warning. Default 0.4."),
    edge_min_pct: z
      .number()
      .min(0)
      .max(100)
      .optional()
      .describe("Percent of an edge band (the outer 1.5%) holding visible content for the edge to count as touched. Default 3."),
  })
  .describe("Detection thresholds. The defaults suit typical motion design; raise them if holds and fast cuts are reported.");

export type ScrubThresholds = Required<z.infer<typeof ScrubThresholdsSchema>>;

export const DEFAULT_THRESHOLDS: ScrubThresholds = {
  pop_min_diff: 0.03,
  pop_factor: 6,
  flicker_luma: 0.04,
  frozen_min_seconds: 0.5,
  black_min_seconds: 0.4,
  clip_pct: 5,
  edge_min_pct: 3,
};

export const AeScrubCheckSchema = z
  .object({
    comp_id: z
      .number()
      .int()
      .optional()
      .describe("Check this comp (read-only: nothing in the project changes). Give comp_id or path."),
    path: z
      .string()
      .min(1)
      .max(20000)
      .optional()
      .describe(
        "Or check a finished render: the absolute path of a movie, or of one frame of an image sequence. AE imports it, a temporary comp is built to grab frames from, and both are removed again (needs `expect`)."
      ),
    sequence: z
      .boolean()
      .optional()
      .describe("With path: import as an image sequence. Default: yes when numbered frames with the same pattern sit beside the file."),
    fps: z
      .number()
      .min(1)
      .max(999)
      .optional()
      .describe("With an image sequence: the frame rate to import it at. Default: AE's sequence import rate."),
    start: z
      .number()
      .min(0)
      .optional()
      .describe("First second to check. Default: the comp's work area start, or 0 for a file."),
    end: z
      .number()
      .min(0)
      .optional()
      .describe("End of the checked range in seconds. Default: the work area end, or the file's end."),
    samples: z
      .number()
      .int()
      .min(2)
      .max(SCRUB_MAX_SAMPLES)
      .optional()
      .describe(
        `How many frame pairs to render (2 to ${SCRUB_MAX_SAMPLES}, default 24), spread evenly and always including the first and the last pair. Every frame is a render, so heavy comps take a while. Shots short enough are checked frame by frame. Pops and freezes between sample points can be missed: raise this or narrow start/end to look closer.`
      ),
    cut_times: z
      .array(z.number().min(0))
      .max(200)
      .optional()
      .describe("Extra times in seconds where a hard change is intended and must not be reported as a pop."),
    use_markers_as_cuts: z
      .boolean()
      .optional()
      .describe("Comp mode: treat comp markers and the in/out points of visible layers as intended cuts. Default true."),
    expected_size: z
      .array(z.number().int().positive())
      .length(2)
      .optional()
      .describe("[width, height] the comp or file should have; a different size or aspect fails."),
    thresholds: ScrubThresholdsSchema.optional(),
    max_suspects: z
      .number()
      .int()
      .min(1)
      .max(8)
      .optional()
      .describe("How many suspect frames (each beside its neighbour) go on the contact sheet. Default 6."),
    keep_frames: z
      .boolean()
      .optional()
      .describe("Keep every sampled frame's PNG on disk. Default false: only the suspects' frames are kept."),
    expect: ExpectSchema.optional().describe("Required with path (the render is imported into the project); not used with comp_id."),
  })
  .refine((v) => (v.comp_id === undefined) !== (v.path === undefined), { message: "Give comp_id or path, not both." })
  .refine((v) => v.path === undefined || v.expect !== undefined, { message: "Checking a render file imports it into the project, so it needs `expect`." })
  .refine((v) => v.start === undefined || v.end === undefined || v.end > v.start, { message: "end must be after start." });

export type AeScrubCheckArgs = z.infer<typeof AeScrubCheckSchema>;

// ---------- sample planning ----------

export interface SamplePlan {
  /** Frame numbers (0-based from the range start) to render, ascending. */
  indexes: number[];
  /** The pairs, as positions into `indexes`. */
  pairs: Array<[number, number]>;
  /** True when every frame is checked, not a spread of pairs. */
  dense: boolean;
}

/** Frames in a range (0 when it is shorter than one frame). */
export function framesInRange(start: number, end: number, frameDuration: number): number {
  if (!(frameDuration > 0) || !(end > start)) return 0;
  return Math.max(0, Math.floor((end - start) / frameDuration + 1e-6));
}

/**
 * Pairs of neighbouring frames spread evenly over `frames` frames, always
 * with the first pair and the last. A range of at most `count + 1` frames is
 * checked frame by frame. Pairs that share a frame render it once.
 */
export function planSamples(frames: number, count: number): SamplePlan {
  if (frames < 2) return { indexes: [], pairs: [], dense: false };
  const n = Math.max(2, Math.floor(count));
  if (frames - 1 <= n) {
    const indexes = Array.from({ length: frames }, (_, i) => i);
    const pairs: Array<[number, number]> = [];
    for (let i = 0; i < frames - 1; i++) pairs.push([i, i + 1]);
    return { indexes, pairs, dense: true };
  }
  const lastPair = frames - 2;
  const starts = new Set<number>();
  for (let i = 0; i < n; i++) starts.add(Math.round((i * lastPair) / (n - 1)));
  const sortedStarts = [...starts].sort((a, b) => a - b);
  const frameSet = new Set<number>();
  for (const k of sortedStarts) {
    frameSet.add(k);
    frameSet.add(k + 1);
  }
  const indexes = [...frameSet].sort((a, b) => a - b);
  const pos = new Map(indexes.map((k, i) => [k, i]));
  const pairs = sortedStarts.map((k): [number, number] => [pos.get(k) as number, pos.get(k + 1) as number]);
  return { indexes, pairs, dense: false };
}

// ---------- image sequence gaps ----------

export interface SequenceGaps {
  pattern: string;
  first: number;
  last: number;
  present: number;
  missing: number[];
  /** True when more than 500 numbers are missing and the list stops there. */
  truncated: boolean;
}

/**
 * Missing frame numbers in the sequence `firstName` belongs to, judged from
 * the file names in its folder: same prefix, extension and number width.
 */
export function sequenceGaps(names: string[], firstName: string): SequenceGaps | null {
  const m = /^(.*?)(\d+)(\.[^.]+)$/.exec(firstName);
  if (!m) return null;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${esc(m[1])}(\\d{${m[2].length}})${esc(m[3])}$`, "i");
  const have = new Set<number>();
  for (const n of names) {
    const hit = re.exec(n);
    if (hit) have.add(Number(hit[1]));
  }
  if (have.size === 0) return null;
  const nums = [...have];
  const first = Math.min(...nums);
  const last = Math.max(...nums);
  const missing: number[] = [];
  let truncated = false;
  for (let i = first; i <= last; i++) {
    if (have.has(i)) continue;
    if (missing.length >= MAX_LIST) {
      truncated = true;
      break;
    }
    missing.push(i);
  }
  return { pattern: `${m[1]}${"#".repeat(m[2].length)}${m[3]}`, first, last, present: have.size, missing, truncated };
}

/** Collapses [3,4,5,9] into "3-5, 9" for messages. */
export function describeRanges(nums: number[]): string {
  const parts: string[] = [];
  let i = 0;
  while (i < nums.length) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    parts.push(j > i ? `${nums[i]}-${nums[j]}` : String(nums[i]));
    i = j + 1;
  }
  return parts.join(", ");
}

// ---------- per-frame measurements ----------

export type FrameKind = "transparent" | "black" | "blank";

export interface EdgeContent {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface FrameMeasure {
  hash: string;
  kind: FrameKind | null;
  flags: FrameFlag[];
  /** Mean Rec. 709 luma of the encoded colour, weighted by alpha, 0..1. */
  mean_luma: number;
  /** Share of pixels that are opaque with a channel at 254 or more, 0..1. */
  clip_frac: number;
  /** Share of each outer band (1.5% of the frame) that holds visible content, 0..1. */
  edges: EdgeContent;
  width: number;
  height: number;
}

const EDGE_BAND = 0.015;

/** Hash, kind, brightness, clipped highlights and edge content of a decoded frame, in one pass over the pixels. */
export function measureFrame(png: { width: number; height: number; data: Buffer | Uint8Array }, index = 0): FrameMeasure {
  const { width: w, height: h, data } = png;
  const analysis = analyzeDecodedFrame(png, { index, path: "" });
  let kind: FrameKind | null = null;
  if (analysis.is_transparent) kind = "transparent";
  else if (analysis.is_black) kind = "black";
  else if (analysis.is_blank) kind = "blank";

  const bx = Math.max(2, Math.round(w * EDGE_BAND));
  const by = Math.max(2, Math.round(h * EDGE_BAND));
  let lumaSum = 0;
  let clip = 0;
  let top = 0;
  let bottom = 0;
  let left = 0;
  let right = 0;
  for (let y = 0; y < h; y++) {
    const inTop = y < by;
    const inBottom = y >= h - by;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      lumaSum += (luma * a) / 255;
      if (a >= 250 && (r >= 254 || g >= 254 || b >= 254)) clip++;
      const inLeft = x < bx;
      const inRight = x >= w - bx;
      if (inTop || inBottom || inLeft || inRight) {
        // Visible content: not (nearly) transparent and not (nearly) black.
        const content = a >= 32 && luma >= 12;
        if (content) {
          if (inTop) top++;
          if (inBottom) bottom++;
          if (inLeft) left++;
          if (inRight) right++;
        }
      }
    }
  }
  const total = Math.max(1, w * h);
  const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
  return {
    hash: crypto.createHash("md5").update(data).digest("hex"),
    kind,
    flags: analysis.flags,
    mean_luma: round4(lumaSum / (255 * total)),
    clip_frac: round4(clip / total),
    edges: {
      top: round4(top / Math.max(1, by * w)),
      bottom: round4(bottom / Math.max(1, by * w)),
      left: round4(left / Math.max(1, bx * h)),
      right: round4(right / Math.max(1, bx * h)),
    },
    width: w,
    height: h,
  };
}

/** One sampled pair: a frame, the next one, and how they differ. */
export interface PairMeasure {
  index: number;
  /** Positions in the capture list, for finding the PNGs. */
  a_pos: number;
  b_pos: number;
  /** Frame times in comp seconds (frame-aligned, not the sample phase). */
  a_time: number;
  b_time: number;
  a: FrameMeasure;
  b: FrameMeasure;
  /** Mean absolute pixel difference between the two frames, 0..1. */
  mean_abs_diff: number;
  pct_changed: number;
  /** b's mean luma minus a's. */
  luma_delta: number;
}

export interface Captured {
  pos: number;
  /** Frame number from the range start. */
  k: number;
  frame_time: number;
  path: string;
}

/** Decodes the captured frames pair by pair (a frame is decoded once, and dropped after its last pair). */
export function measurePairs(
  captured: Array<Captured | null>,
  pairs: Array<[number, number]>,
  pixelThreshold = 0.02
): { pairs: PairMeasure[]; errors: Array<{ time: number; message: string }> } {
  const lastUse = new Map<number, number>();
  pairs.forEach(([a, b], i) => {
    lastUse.set(a, i);
    lastUse.set(b, i);
  });
  const pngs = new Map<number, PNG>();
  const measures = new Map<number, FrameMeasure>();
  const out: PairMeasure[] = [];
  const errors: Array<{ time: number; message: string }> = [];
  const load = (pos: number, cap: Captured) => {
    let png = pngs.get(pos);
    if (!png) {
      png = decodePngFile(cap.path);
      pngs.set(pos, png);
    }
    if (!measures.has(pos)) measures.set(pos, measureFrame(png, pos));
    return { png, measure: measures.get(pos) as FrameMeasure };
  };
  pairs.forEach(([pa, pb], i) => {
    const ca = captured[pa];
    const cb = captured[pb];
    if (ca && cb) {
      try {
        const a = load(pa, ca);
        const b = load(pb, cb);
        const cmp = compareDecodedFrames(a.png, b.png, { threshold: pixelThreshold });
        out.push({
          index: out.length,
          a_pos: pa,
          b_pos: pb,
          a_time: ca.frame_time,
          b_time: cb.frame_time,
          a: a.measure,
          b: b.measure,
          mean_abs_diff: cmp.mean_abs_diff,
          pct_changed: cmp.pct_pixels_changed,
          luma_delta: Math.round((b.measure.mean_luma - a.measure.mean_luma) * 10_000) / 10_000,
        });
      } catch (err) {
        errors.push({ time: ca.frame_time, message: err instanceof Error ? err.message : String(err) });
      }
    }
    for (const pos of [pa, pb]) {
      if ((lastUse.get(pos) ?? -1) <= i) {
        pngs.delete(pos);
      }
    }
  });
  return { pairs: out, errors };
}

// ---------- findings ----------

export type FindingKind =
  | "black"
  | "transparent"
  | "blank"
  | "frozen"
  | "pop"
  | "flicker"
  | "edge_clip"
  | "rgb_extremes"
  | "sequence_gap"
  | "size"
  | "aspect"
  | "capture_failed";

export type Severity = "fail" | "warn" | "info";

export interface ScrubFinding {
  kind: FindingKind;
  severity: Severity;
  message: string;
  /** Comp time in seconds where it starts, and where it ends for a stretch. */
  time?: number;
  end_time?: number;
  times?: number[];
  value?: number;
  /** Capture positions of the frames to show on the contact sheet: first, then the one to compare with. */
  tiles?: [number, number];
}

const SEVERITY_ORDER: Record<Severity, number> = { fail: 0, warn: 1, info: 2 };

export const secs = (t: number): string => `${(Math.round(t * 100) / 100).toFixed(2)} s`;

const median = (v: number[]): number => {
  if (v.length === 0) return 0;
  const s = [...v].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

export interface AnalysisContext {
  frameDuration: number;
  rangeStart: number;
  rangeEnd: number;
  /** Times of intended hard changes (markers, layer in/out points, the caller's list). */
  cuts: number[];
  thresholds: ScrubThresholds;
}

/** True when an intended cut falls between the pair's frames, give or take a frame. */
export function nearCut(pair: { a_time: number; b_time: number }, cuts: number[], frameDuration: number): boolean {
  const eps = 1e-6;
  return cuts.some((c) => c >= pair.a_time - frameDuration - eps && c <= pair.b_time + frameDuration + eps);
}

const pairKind = (p: PairMeasure): FrameKind | null => p.a.kind ?? p.b.kind;

/** Runs of consecutive pairs for which `key` gives the same non-null value. */
function runsOf<K>(pairs: PairMeasure[], key: (p: PairMeasure) => K | null): Array<{ key: K; from: number; to: number }> {
  const runs: Array<{ key: K; from: number; to: number }> = [];
  let i = 0;
  while (i < pairs.length) {
    const k = key(pairs[i]);
    if (k === null) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < pairs.length && key(pairs[j + 1]) === k) j++;
    runs.push({ key: k, from: i, to: j });
    i = j + 1;
  }
  return runs;
}

const KIND_TEXT: Record<FrameKind, string> = {
  transparent: "fully transparent",
  black: "black",
  blank: "a single flat colour",
};

/** The pure checks on measured pairs: blank stretches, frozen runs, pops, flicker, edges, clipped highlights. */
export function analyzePairs(pairs: PairMeasure[], ctx: AnalysisContext): ScrubFinding[] {
  const out: ScrubFinding[] = [];
  const th = ctx.thresholds;
  const fd = ctx.frameDuration;
  const n = pairs.length;
  if (n === 0) return out;
  const rangeLen = Math.max(fd, ctx.rangeEnd - ctx.rangeStart);

  // Black, transparent and flat-colour stretches. At either end of the range
  // they usually mean a bad render; in the middle they may be a fade.
  for (const run of runsOf(pairs, pairKind)) {
    const first = pairs[run.from];
    const last = pairs[run.to];
    const atEnd = run.from === 0 || run.to === n - 1;
    const count = run.to - run.from + 1;
    let severity: Severity;
    const whole = run.from === 0 && run.to === n - 1;
    const span = last.b_time + fd - first.a_time;
    if (run.key === "blank") severity = atEnd ? "warn" : "info";
    else if (!atEnd) severity = "warn";
    else if (whole) severity = "fail";
    else if (run.from === 0 && run.key === "transparent") severity = "warn"; // elements animating in
    else severity = span >= th.black_min_seconds ? "fail" : "warn";
    let where = `from ${secs(first.a_time)} to ${secs(last.b_time)}`;
    if (whole) where = "across the whole checked range";
    else if (run.to === n - 1) where = `from ${secs(first.a_time)} to the end of the range`;
    else if (run.from === 0) where = `from the start of the range to ${secs(last.b_time)}`;
    out.push({
      kind: run.key,
      severity,
      time: first.a_time,
      end_time: last.b_time + fd,
      message: `Frames are ${KIND_TEXT[run.key]} ${where} (${count} sample point${count === 1 ? "" : "s"}).`,
      tiles: [first.a_pos, last.b_pos],
    });
  }

  // Frozen: the same frame at every sample point of a run. Flat-colour frames are reported above.
  const frozenHash = (p: PairMeasure): string | null => (pairKind(p) === null && p.a.hash === p.b.hash ? p.a.hash : null);
  for (const run of runsOf(pairs, frozenHash)) {
    if (run.to === run.from) continue;
    const first = pairs[run.from];
    const last = pairs[run.to];
    const span = last.b_time + fd - first.a_time;
    if (span < th.frozen_min_seconds) continue;
    const toEnd = run.to === n - 1;
    const whole = span >= 0.9 * rangeLen;
    let severity: Severity = "info";
    if (toEnd || whole) severity = "warn";
    let where = `from ${secs(first.a_time)} to ${secs(last.b_time + fd)}`;
    if (whole) where = "across almost the whole checked range";
    else if (toEnd) where = `from ${secs(first.a_time)} to the end of the range`;
    out.push({
      kind: "frozen",
      severity,
      time: first.a_time,
      end_time: last.b_time + fd,
      value: Math.round(span * 100) / 100,
      message: `The picture does not change ${where} (${secs(span)}). A deliberate hold is fine; a render that stopped is not.`,
      tiles: [first.a_pos, last.b_pos],
    });
  }

  // Pops: far above the shot's usual change, and not at an intended cut.
  const eligible = pairs.filter((p) => !nearCut(p, ctx.cuts, fd));
  const typical = median(eligible.map((p) => p.mean_abs_diff));
  const limit = Math.max(th.pop_min_diff, th.pop_factor * Math.max(typical, 0.002));
  const pops = eligible.filter((p) => p.mean_abs_diff > limit);
  pops.sort((a, b) => b.mean_abs_diff - a.mean_abs_diff);
  for (const p of pops.slice(0, 20)) {
    out.push({
      kind: "pop",
      severity: "warn",
      time: p.a_time,
      end_time: p.b_time,
      value: p.mean_abs_diff,
      message: `The picture jumps between ${secs(p.a_time)} and ${secs(p.b_time)}: ${(p.mean_abs_diff * 100).toFixed(1)}% mean change from one frame to the next, where the shot's usual is ${(typical * 100).toFixed(2)}% and no marker or layer edge is there.`,
      tiles: [p.a_pos, p.b_pos],
    });
  }

  // Flicker: brightness swings that keep changing direction (a fade swings one way).
  const swings = eligible.filter((p) => Math.abs(p.luma_delta) >= th.flicker_luma);
  if (swings.length >= 3) {
    let changes = 0;
    for (let i = 1; i < swings.length; i++) {
      if (Math.sign(swings[i].luma_delta) !== Math.sign(swings[i - 1].luma_delta)) changes++;
    }
    if (changes >= 2 && changes >= 0.4 * (swings.length - 1)) {
      out.push({
        kind: "flicker",
        severity: "warn",
        time: swings[0].a_time,
        end_time: swings[swings.length - 1].b_time,
        times: swings.slice(0, 20).map((p) => p.a_time),
        value: swings.length,
        message: `Brightness jumps up and down from one frame to the next at ${swings.length} of ${n} sample points (first at ${secs(swings[0].a_time)}).`,
        tiles: [swings[0].a_pos, swings[0].b_pos],
      });
    }
  }

  // Edges: content on some edges in some frames but not others hints at an element cut off.
  const frames = pairs.map((p) => ({ time: p.a_time, m: p.a }));
  frames.push({ time: pairs[n - 1].b_time, m: pairs[n - 1].b });
  const need = th.edge_min_pct / 100;
  for (const edge of ["top", "bottom", "left", "right"] as const) {
    const hit = frames.filter((f) => f.m.edges[edge] >= need);
    if (hit.length > 0 && hit.length < frames.length) {
      out.push({
        kind: "edge_clip",
        severity: "info",
        time: hit[0].time,
        times: hit.slice(0, 10).map((f) => f.time),
        value: hit.length,
        message: `Visible content reaches the ${edge} edge in ${hit.length} of ${frames.length} sampled frames (first at ${secs(hit[0].time)}) and not in the others: check that nothing is cut off there. A heuristic: it can't tell an element leaving the frame on purpose.`,
      });
    }
  }

  // Clipped highlights. AE gives full-range RGB, so this is not the 16-235 broadcast check.
  const clipped = frames.filter((f) => f.m.clip_frac * 100 >= th.clip_pct);
  if (clipped.length > 0) {
    const worst = clipped.reduce((a, b) => (b.m.clip_frac > a.m.clip_frac ? b : a));
    out.push({
      kind: "rgb_extremes",
      severity: "info",
      time: clipped[0].time,
      times: clipped.slice(0, 10).map((f) => f.time),
      value: worst.m.clip_frac,
      message: `${clipped.length} of ${frames.length} sampled frames have ${th.clip_pct}% or more of their pixels at the top of the RGB range (worst ${(worst.m.clip_frac * 100).toFixed(1)}% at ${secs(worst.time)}). A heuristic for blown highlights: AE hands over full-range RGB, so the 16-235 broadcast range can't be judged from it.`,
    });
  }

  out.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (a.time ?? 0) - (b.time ?? 0));
  return out;
}

export interface SizeInfo {
  width: number;
  height: number;
  pixelAspect: number;
}

/** Size, aspect and pixel-aspect checks against what the caller expects. */
export function sizeFindings(info: SizeInfo, expected: number[] | undefined, isFile: boolean): ScrubFinding[] {
  const out: ScrubFinding[] = [];
  if (expected && expected.length === 2 && (info.width !== expected[0] || info.height !== expected[1])) {
    const sameAspect = Math.abs(info.width / info.height - expected[0] / expected[1]) < 0.005;
    if (sameAspect) {
      out.push({
        kind: "size",
        severity: "fail",
        message: `The size is ${info.width}x${info.height}, not ${expected[0]}x${expected[1]} (same aspect ratio, different scale).`,
      });
    } else {
      out.push({
        kind: "aspect",
        severity: "fail",
        message: `The aspect is wrong: ${info.width}x${info.height} is ${(info.width / info.height).toFixed(3)}:1, not ${(expected[0] / expected[1]).toFixed(3)}:1 (${expected[0]}x${expected[1]}).`,
      });
    }
  }
  if (Math.abs(info.pixelAspect - 1) > 0.001) {
    out.push({
      kind: "aspect",
      severity: isFile ? "warn" : "info",
      message: `Pixels are not square (pixel aspect ${info.pixelAspect}), so the picture is shown ${info.width}x${info.height} stretched to ${Math.round(info.width * info.pixelAspect)} wide.`,
    });
  }
  return out;
}

export function verdictOf(findings: ScrubFinding[]): "pass" | "warn" | "fail" {
  if (findings.some((f) => f.severity === "fail")) return "fail";
  if (findings.some((f) => f.severity === "warn")) return "warn";
  return "pass";
}

/** Intended cut times inside the range: comp markers, visible layers' in/out points, and the caller's list. */
export function intendedCuts(
  info: { markers?: Array<{ time: number }>; layer_edges?: Array<{ time: number }> } | null,
  extra: number[] | undefined,
  useComp: boolean,
  range: { start: number; end: number }
): number[] {
  const all: number[] = [...(extra ?? [])];
  if (info && useComp) {
    for (const m of info.markers ?? []) all.push(m.time);
    for (const e of info.layer_edges ?? []) all.push(e.time);
  }
  const inside = all.filter((t) => Number.isFinite(t) && t > range.start && t < range.end);
  return [...new Set(inside.map((t) => Math.round(t * 1e6) / 1e6))].sort((a, b) => a - b);
}

// ---------- drawing ----------

const CHART_BG: Rgba = [24, 24, 24, 255];
const CHART_GRID: Rgba = [64, 64, 64, 255];
const CHART_DIFF: Rgba = [240, 240, 240, 255];
const CHART_LUMA: Rgba = [90, 160, 255, 255];
const CHART_CUT: Rgba = [230, 190, 40, 255];
const CHART_BAD: Rgba = [230, 40, 40, 255];

export interface CurvePoint {
  time: number;
  diff: number;
  luma: number;
}

/**
 * The frame-to-frame difference curve (white) over the checked range, with
 * mean brightness (blue), intended cuts (yellow ticks) and findings (red
 * ticks). One point per sampled pair, so a sparse check is a coarse curve.
 */
export function drawScrubChart(
  points: CurvePoint[],
  range: { start: number; end: number },
  cuts: number[],
  badTimes: number[],
  width = 960,
  height = 320
): PNG {
  const img = createCanvas(width, height, CHART_BG);
  const left = 8;
  const right = width - 8;
  const top = 22;
  const bottom = height - 22;
  const span = Math.max(1e-6, range.end - range.start);
  const x = (t: number) => Math.round(left + ((Math.min(range.end, Math.max(range.start, t)) - range.start) / span) * (right - left));
  for (let g = 0; g <= 4; g++) {
    const gy = Math.round(top + ((bottom - top) * g) / 4);
    fillRect(img, left, gy, right - left, 1, CHART_GRID);
  }
  for (const c of cuts) fillRect(img, x(c), top, 1, bottom - top, CHART_CUT);
  const maxDiff = Math.max(0.02, ...points.map((p) => p.diff)) * 1.1;
  const yDiff = (v: number) => Math.round(bottom - (Math.min(v, maxDiff) / maxDiff) * (bottom - top));
  const yLuma = (v: number) => Math.round(bottom - Math.min(1, Math.max(0, v)) * (bottom - top));
  for (let i = 1; i < points.length; i++) {
    drawLine(img, x(points[i - 1].time), yLuma(points[i - 1].luma), x(points[i].time), yLuma(points[i].luma), 1, CHART_LUMA);
  }
  for (let i = 1; i < points.length; i++) {
    drawLine(img, x(points[i - 1].time), yDiff(points[i - 1].diff), x(points[i].time), yDiff(points[i].diff), 2, CHART_DIFF);
  }
  for (const p of points) fillRect(img, x(p.time) - 2, yDiff(p.diff) - 2, 5, 5, CHART_DIFF);
  for (const t of badTimes) fillRect(img, x(t) - 1, top, 3, bottom - top, [CHART_BAD[0], CHART_BAD[1], CHART_BAD[2], 140]);
  drawText(img, `DIFF MAX ${(maxDiff * 100).toFixed(1)}`, left + 2, 6, 1, CHART_DIFF);
  const lumaLabel = "LUMA";
  drawText(img, lumaLabel, left + 2 + textWidth("DIFF MAX 100.0", 1) + 16, 6, 1, CHART_LUMA);
  for (const [t, anchor] of [
    [range.start, 0],
    [(range.start + range.end) / 2, 0.5],
    [range.end, 1],
  ] as Array<[number, number]>) {
    const label = `${t.toFixed(2)}s`;
    const lx = Math.round(x(t) - anchor * textWidth(label, 1));
    drawText(img, label, Math.max(2, Math.min(width - textWidth(label, 1) - 2, lx)), height - 14, 1, CHART_DIFF);
  }
  return img;
}

const labelText = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9_ ]/g, " ");

/** Each suspect frame beside its neighbour (or the end of its stretch), two tiles to a row, labelled. */
export function buildSuspectSheet(
  captured: Array<Captured | null>,
  findings: ScrubFinding[],
  maxSuspects: number,
  frameSize: { width: number; height: number }
): { png: PNG; shown: Array<{ kind: FindingKind; time: number | undefined; paths: [string, string] }> } | null {
  const picks = findings.filter((f) => f.tiles && f.severity !== "info").slice(0, maxSuspects);
  const tiles: SheetTile[] = [];
  const shown: Array<{ kind: FindingKind; time: number | undefined; paths: [string, string] }> = [];
  const layout = sheetLayout(Math.max(1, picks.length * 2), frameSize.width, frameSize.height, 320, 2, true);
  for (const f of picks) {
    const [pa, pb] = f.tiles as [number, number];
    const ca = captured[pa];
    const cb = captured[pb];
    if (!ca || !cb) continue;
    const label = labelText(f.kind);
    for (const [tileCap, text, flagged] of [
      [ca, `${label} ${ca.frame_time.toFixed(2)}s`, true],
      [cb, `${pb === pa ? "SAME" : "NEXT"} ${cb.frame_time.toFixed(2)}s`, false],
    ] as Array<[Captured, string, boolean]>) {
      const full = decodePngFile(tileCap.path);
      tiles.push({ image: resizeArea(full, layout.tileWidth, layout.tileHeight), label: text, flagged });
    }
    shown.push({ kind: f.kind, time: f.time, paths: [ca.path, cb.path] });
  }
  if (tiles.length === 0) return null;
  return { png: buildContactSheet(tiles, layout), shown };
}

// ---------- host calls and capture ----------

interface CompInfo {
  comp_id: number;
  name: string;
  width: number;
  height: number;
  pixelAspect: number;
  frameRate: number;
  frameDuration: number;
  duration: number;
  workAreaStart: number;
  workAreaDuration: number;
  numLayers: number;
  markers: Array<{ time: number; comment?: string }>;
  markers_truncated: boolean;
  layer_edges: Array<{ time: number; edge: string; layer: string }>;
  layer_edges_truncated: boolean;
}

interface ImportedInfo {
  item_id: number;
  comp_id: number;
  name: string;
  width: number;
  height: number;
  pixelAspect: number;
  frameRate: number;
  frameDuration: number;
  duration: number;
  sequence: boolean;
}

interface ScrubState {
  item: { id: number; name: string; frameRate?: number; duration?: number } | null;
  comp: { id: number; name: string; numLayers: number; frameRate?: number; duration?: number } | null;
}

async function runQueued<T>(ctx: ToolContext, label: string, opId: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await ctx.queue.run(label, fn);
  } catch (err) {
    if (err instanceof QueueWaitError) throw new BridgeError({ kind: "queued", op_id: opId, message: err.message });
    throw err;
  }
}

interface CaptureResult {
  captured: Array<Captured | null>;
  failures: Array<{ time: number; message: string }>;
  /** True when AE stopped answering (timeout or lost bridge): the rest was not sampled and nothing more is sent. */
  aborted: boolean;
}

/** Renders the planned frames, in the caller's queue lease. A frame that fails is skipped and reported. */
async function captureFrames(
  ctx: ToolContext,
  opId: string,
  compId: number,
  plan: SamplePlan,
  range: { start: number; frameDuration: number; duration: number },
  framesDir: string
): Promise<CaptureResult> {
  const captured: Array<Captured | null> = [];
  const failures: Array<{ time: number; message: string }> = [];
  let aborted = false;
  for (let pos = 0; pos < plan.indexes.length; pos++) {
    const k = plan.indexes[pos];
    const frameTime = range.start + k * range.frameDuration;
    if (aborted) {
      captured.push(null);
      continue;
    }
    // Land inside the frame, not on its edge, so either rounding picks it.
    const sampleTime = Math.min(range.duration, frameTime + SAMPLE_PHASE * range.frameDuration);
    try {
      const snap = await captureCompFrame({ ctx, opId, compId, time: sampleTime, frameIndex: k, framesDir, toolName: "ae_scrub_check" });
      captured.push({ pos, k, frame_time: frameTime, path: snap.path });
    } catch (err) {
      captured.push(null);
      failures.push({ time: frameTime, message: err instanceof Error ? err.message : String(err) });
      if (err instanceof BridgeError && (err.kind === "timeout" || err.kind === "unreachable")) aborted = true;
    }
  }
  return { captured, failures, aborted };
}

// ---------- the tool ----------

const round2 = (n: number) => Math.round(n * 100) / 100;

interface Prepared {
  mode: "comp" | "file";
  /** Range in comp seconds and its frame length. */
  start: number;
  end: number;
  frameDuration: number;
  fps: number;
  size: SizeInfo;
  cuts: number[];
  cutSources: { markers: number; layer_edges: number; given: number };
  subject: Record<string, unknown>;
}

/** Everything after the frames are rendered: decode, analyze, draw, tidy the files, build the result. */
function finish(
  args: AeScrubCheckArgs,
  prep: Prepared,
  plan: SamplePlan,
  cap: CaptureResult,
  extraFindings: ScrubFinding[],
  framesDir: string
): Record<string, unknown> {
  const thresholds: ScrubThresholds = { ...DEFAULT_THRESHOLDS, ...(args.thresholds ?? {}) };
  const measured = measurePairs(cap.captured, plan.pairs);
  const findings: ScrubFinding[] = [...extraFindings];
  for (const f of cap.failures) {
    findings.push({ kind: "capture_failed", severity: "warn", time: f.time, message: `The frame at ${secs(f.time)} could not be rendered: ${f.message}` });
  }
  for (const e of measured.errors) {
    findings.push({ kind: "capture_failed", severity: "warn", time: e.time, message: `The frame pair at ${secs(e.time)} could not be compared: ${e.message}` });
  }
  if (cap.aborted) {
    findings.push({
      kind: "capture_failed",
      severity: "warn",
      message: "After Effects stopped answering during the check, so the later frames were not sampled. The result covers only the frames before that.",
    });
  }
  findings.push(
    ...analyzePairs(measured.pairs, {
      frameDuration: prep.frameDuration,
      rangeStart: prep.start,
      rangeEnd: prep.end,
      cuts: prep.cuts,
      thresholds,
    })
  );
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (a.time ?? 0) - (b.time ?? 0));
  const verdict = verdictOf(findings);

  const curve: CurvePoint[] = measured.pairs.map((p) => ({ time: p.a_time, diff: p.mean_abs_diff, luma: p.a.mean_luma }));
  const bad = findings.filter((f) => f.severity !== "info" && f.time !== undefined).map((f) => f.time as number);

  fs.mkdirSync(framesDir, { recursive: true });
  const stamp = `${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const frameSize = measured.pairs[0] ? { width: measured.pairs[0].a.width, height: measured.pairs[0].a.height } : { width: prep.size.width, height: prep.size.height };

  let chart: Record<string, unknown> | null = null;
  let sheet: Record<string, unknown> | null = null;
  let shown: Array<{ kind: FindingKind; time: number | undefined; paths: [string, string] }> = [];
  const kept = new Set<string>();
  const notes: string[] = [];
  try {
    if (curve.length > 0) {
      const png = drawScrubChart(curve, { start: prep.start, end: prep.end }, prep.cuts.slice(0, MAX_LIST), bad);
      const chartPath = path.join(framesDir, `scrub_chart_${stamp}.png`);
      fs.writeFileSync(chartPath, encodePng(png));
      chart = { path: chartPath, width: png.width, height: png.height };
    }
  } catch (err) {
    notes.push(`The difference chart could not be drawn: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const built = buildSuspectSheet(cap.captured, findings, args.max_suspects ?? 6, frameSize);
    if (built) {
      const sheetPath = path.join(framesDir, `scrub_suspects_${stamp}.png`);
      fs.writeFileSync(sheetPath, encodePng(built.png));
      sheet = { path: sheetPath, width: built.png.width, height: built.png.height, suspects: built.shown.length };
      shown = built.shown;
      for (const s of built.shown) for (const p of s.paths) kept.add(p);
    }
  } catch (err) {
    notes.push(`The contact sheet could not be built: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Only the suspects' frames stay on disk, unless asked.
  if (!args.keep_frames) {
    for (const c of cap.captured) {
      if (c && !kept.has(c.path)) {
        try {
          fs.unlinkSync(c.path);
        } catch {
          // already gone
        }
      }
    }
  }

  const count = (s: Severity) => findings.filter((f) => f.severity === s).length;
  const frameCount = framesInRange(prep.start, prep.end, prep.frameDuration);
  const spacing = plan.pairs.length > 1 ? (prep.end - prep.start) / plan.pairs.length : prep.end - prep.start;
  return {
    ok: true,
    mode: prep.mode,
    verdict,
    summary:
      verdict === "pass"
        ? `No problems found in ${measured.pairs.length} sampled frame pair${measured.pairs.length === 1 ? "" : "s"}.`
        : `${count("fail")} failure${count("fail") === 1 ? "" : "s"}, ${count("warn")} warning${count("warn") === 1 ? "" : "s"}, ${count("info")} note${count("info") === 1 ? "" : "s"} in ${measured.pairs.length} sampled frame pair${measured.pairs.length === 1 ? "" : "s"}.`,
    ...prep.subject,
    range: { start: prep.start, end: prep.end, frames: frameCount, frame_duration: prep.frameDuration, fps: round2(prep.fps) },
    coverage: {
      sample_points: measured.pairs.length,
      frames_rendered: cap.captured.filter((c) => c !== null).length,
      dense: plan.dense,
      spacing_seconds: plan.dense ? prep.frameDuration : Math.round(spacing * 1000) / 1000,
      note: plan.dense
        ? "Every frame in the range was checked."
        : "Frame pairs spread over the range: a pop or freeze between sample points can be missed. Raise samples or narrow start/end to look closer.",
    },
    cuts: { count: prep.cuts.length, ...prep.cutSources },
    findings: findings.map(({ tiles: _tiles, ...rest }) => rest),
    curve: curve.slice(0, MAX_LIST).map((p) => ({ time: p.time, diff: p.diff, luma: p.luma })),
    chart,
    contact_sheet: sheet,
    suspect_frames: shown.map((s) => ({ kind: s.kind, time: s.time, frame: s.paths[0], next: s.paths[1] })),
    ...(notes.length ? { notes } : {}),
  };
}

function resolveRange(args: AeScrubCheckArgs, base: { start: number; end: number; duration: number }) {
  const start = Math.max(0, args.start ?? base.start);
  const end = Math.min(base.duration, args.end ?? base.end);
  return { start, end };
}

async function scrubComp(args: AeScrubCheckArgs, ctx: ToolContext) {
  const compId = args.comp_id as number;
  const framesDir = defaultFramesDir();
  fs.mkdirSync(framesDir, { recursive: true });
  const opId = ctx.bridge.newOpId();

  const run = await runQueued(ctx, `ae_scrub_check(${compId})`, opId, async () => {
    const infoResp = await ctx.bridge.evalRaw<CompInfo>({
      id: `${opId}_info`,
      script: buildJsxCall("scrubInfo", { comp_id: compId }),
      label: `ae_scrub_check(${compId}) info`,
      mutates: false,
      toolName: "ae_scrub_check",
    });
    const info = infoResp.result;
    const { start, end } = resolveRange(args, { start: info.workAreaStart, end: info.workAreaStart + info.workAreaDuration, duration: info.duration });
    const frames = framesInRange(start, end, info.frameDuration);
    if (frames < 2) return { info, start, end, plan: null as SamplePlan | null, cap: null as CaptureResult | null };
    const plan = planSamples(frames, args.samples ?? 24);
    const cap = await captureFrames(ctx, opId, compId, plan, { start, frameDuration: info.frameDuration, duration: info.duration }, framesDir);
    return { info, start, end, plan, cap };
  });

  const { info, start, end, plan, cap } = run;
  if (!plan || !cap) {
    return { ok: false, error: "range_too_short", message: `The range ${secs(start)} to ${secs(end)} is shorter than two frames (frame length ${info.frameDuration} s). Nothing was sampled.` };
  }
  const useComp = args.use_markers_as_cuts !== false;
  const cuts = intendedCuts(info, args.cut_times, useComp, { start, end });
  const prep: Prepared = {
    mode: "comp",
    start,
    end,
    frameDuration: info.frameDuration,
    fps: info.frameRate,
    size: { width: info.width, height: info.height, pixelAspect: info.pixelAspect },
    cuts,
    cutSources: { markers: useComp ? info.markers.length : 0, layer_edges: useComp ? info.layer_edges.length : 0, given: args.cut_times?.length ?? 0 },
    subject: {
      comp: { id: info.comp_id, name: info.name, width: info.width, height: info.height, fps: round2(info.frameRate), duration: info.duration },
      ...(info.markers_truncated || info.layer_edges_truncated ? { cuts_truncated: true } : {}),
    },
  };
  return finish(args, prep, plan, cap, sizeFindings(prep.size, args.expected_size, false), framesDir);
}

const STILL_FILE = /\.(png|jpe?g|tiff?|exr|dpx|tga|psd|bmp|cin|hdr|webp)$/i;

async function scrubFile(args: AeScrubCheckArgs, ctx: ToolContext) {
  const file = args.path as string;
  if (!path.isAbsolute(file) || !fs.existsSync(file)) return { ok: false, error: "bad_path", message: `Not an existing absolute path: ${file}` };
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size === 0) return { ok: false, error: "empty", message: `${file} is not a file with content.` };
  // Only stills are numbered frames; a numbered movie is just a movie.
  const sequence = STILL_FILE.test(file) && (args.sequence ?? looksLikeSequence(file));
  const jsxPath = file.replace(/\\/g, "/");

  // Missing numbers need no After Effects: they come from the folder.
  const extra: ScrubFinding[] = [];
  let sequenceInfo: SequenceGaps | null = null;
  if (sequence) {
    try {
      sequenceInfo = sequenceGaps(fs.readdirSync(path.dirname(file)), path.basename(file));
    } catch {
      sequenceInfo = null;
    }
    if (sequenceInfo && sequenceInfo.missing.length > 0) {
      const list = describeRanges(sequenceInfo.missing);
      extra.push({
        kind: "sequence_gap",
        severity: "fail",
        value: sequenceInfo.missing.length,
        message: `${sequenceInfo.missing.length}${sequenceInfo.truncated ? "+" : ""} frame number${sequenceInfo.missing.length === 1 ? " is" : "s are"} missing from ${sequenceInfo.pattern} between ${sequenceInfo.first} and ${sequenceInfo.last}: ${list}.`,
      });
    }
  }

  const framesDir = defaultFramesDir();
  fs.mkdirSync(framesDir, { recursive: true });
  ctx.quarantine.assertClear();
  const opId = ctx.bridge.newOpId();
  const expect = { project_path: (args.expect as NonNullable<typeof args.expect>).project_path, comp_id: args.expect?.comp_id };
  const call = <T,>(suffix: string, fn: string, a: Record<string, unknown>, mutates: boolean, mustSend = false) =>
    ctx.bridge.evalRaw<T>({ id: `${opId}_${suffix}`, script: buildJsxCall(fn, a), label: `ae_scrub_check (${suffix})`, mutates, mustSend, toolName: "ae_scrub_check" });

  const run = await runQueued(ctx, "ae_scrub_check", opId, async () => {
    ctx.quarantine.assertClear();
    const guard = await verifyTargetGuard(ctx, expect, opId);
    const checkpoint = await autoCheckpoint(ctx, guard, "ae_scrub_check");
    const imported = (await call<ImportedInfo>("import", "scrubImport", { path: jsxPath, sequence, fps: args.fps, expect, label: "Scrub check: import" }, true)).result;

    // The render and the temporary comp are in the project from here on: nothing
    // below throws. Trouble goes into `problems` with what became of both.
    const problems: ReceiptMismatch[] = [];
    const notesOut: string[] = [];
    let timing = { frameDuration: imported.frameDuration, duration: imported.duration, frameRate: imported.frameRate };
    // Read back in a separate evalScript: the import call took rate and length in the same script as the conform.
    let importMissing = false;
    try {
      const st = (await call<ScrubState>("verify", "scrubState", { item_id: imported.item_id, comp_id: imported.comp_id }, false)).result;
      const itemFps = st.item?.frameRate;
      const itemDur = st.item?.duration;
      const compFps = st.comp?.frameRate;
      const compDur = st.comp?.duration;
      if (!st.item || !st.comp) {
        importMissing = true;
        problems.push({
          path: "import",
          expected: { item: imported.item_id, comp: imported.comp_id },
          actual: { item: st.item?.id ?? null, comp: st.comp?.id ?? null },
          message: "The imported render or its temporary comp was not found in a separate read after the import; nothing was sampled.",
        });
      }
      if (typeof itemFps === "number" && typeof itemDur === "number" && itemFps > 0 && itemDur > 0) {
        const off = (typeof compFps === "number" && Math.abs(1 / compFps - 1 / itemFps) > 1e-6) || (typeof compDur === "number" && Math.abs(compDur - itemDur) > 0.5 / itemFps);
        const importDiffers = Math.abs(1 / itemFps - 1 / imported.frameRate) > 1e-6 || Math.abs(itemDur - imported.duration) > 0.5 / itemFps;
        // Sample with the item's own values when they differ from what the import call reported.
        if (importDiffers) timing = { frameRate: itemFps, frameDuration: 1 / itemFps, duration: itemDur };
        if (off || importDiffers) {
          notesOut.push(
            "The frame rate or length from the import call (" + round2(imported.frameRate) + " fps, " + imported.duration + " s) differs from a separate read (item " + round2(itemFps) + " fps, " + itemDur + " s; temporary comp " + (typeof compFps === "number" ? round2(compFps) : "?") + " fps, " + (compDur ?? "?") + " s). Sampled with the item's values; frames near the end may be missing or transparent."
          );
        }
      }
    } catch (err) {
      problems.push(readBackMismatch(opId, "reading back the imported render's frame rate and length failed", err));
    }
    let plan: SamplePlan | null = null;
    let cap: CaptureResult | null = null;
    let range = { start: 0, end: 0 };
    try {
      range = resolveRange(args, { start: 0, end: timing.duration, duration: timing.duration });
      const frames = framesInRange(range.start, range.end, timing.frameDuration);
      if (frames >= 2 && !importMissing) {
        plan = planSamples(frames, args.samples ?? 24);
        cap = await captureFrames(ctx, opId, imported.comp_id, plan, { start: range.start, frameDuration: timing.frameDuration, duration: timing.duration }, framesDir);
      }
    } catch (err) {
      problems.push(readBackMismatch(opId, "sampling the imported render failed", err));
    }

    // Remove the comp and the item, then read in a separate evalScript that both are gone.
    // The removal is sent even after a timeout or a lost bridge (mustSend): it waits for AE and then takes the temporary comp
    // out, as the other cleanups do. The only reason to skip it was that it used to queue behind a blocked eval.
    let state: "removed" | "left" | "unknown" | "kept_in_use" = "removed";
    let keptInUse = false;
    {
      try {
        const rm = (await call<{ item_kept?: boolean }>("remove", "scrubRemove", { item_id: imported.item_id, comp_id: imported.comp_id, expect, label: "Scrub check: remove" }, true, true)).result;
        keptInUse = rm?.item_kept === true;
      } catch (err) {
        // A timed-out removal is still queued behind AE's eval and runs when AE is free: its outcome is not "left".
        state = err instanceof BridgeError && err.kind === "timeout" ? "unknown" : "left";
        problems.push(readBackMismatch(opId, `removing the temporary comp (${imported.comp_id}) and the imported render (item ${imported.item_id}) failed`, err));
      }
    }
    if (state === "removed") {
      try {
        const left = (await call<ScrubState>("gone", "scrubState", { item_id: imported.item_id, comp_id: imported.comp_id }, false)).result;
        if (left.comp || (left.item && !keptInUse)) {
          state = "left";
          problems.push({
            path: "cleanup",
            expected: "removed",
            actual: { item: left.item?.id ?? null, comp: left.comp?.id ?? null },
            message: "The imported render or its temporary comp is still in the project after the removal.",
          });
        } else if (keptInUse) {
          state = "kept_in_use";
          notesOut.push("The imported render is used by another comp, so it was left in the project; only the temporary comp was removed.");
        }
      } catch (err) {
        state = "unknown";
        problems.push(readBackMismatch(opId, "the check that the temporary comp and the imported render are gone failed", err));
      }
    }
    return { checkpoint, imported, problems, plan, cap, range, state, timing, notesOut };
  });

  const { checkpoint, imported, problems, plan, cap, range, state, timing, notesOut } = run;
  let leftover: { item_id: number; comp_id?: number } | null = null;
  if (state === "kept_in_use") leftover = { item_id: imported.item_id };
  else if (state !== "removed") leftover = { item_id: imported.item_id, comp_id: imported.comp_id };
  const project = {
    project_changed: true,
    imported_state: state,
    left_in_project: leftover,
    checkpoint,
    ...(problems.length ? { problems } : {}),
    ...(notesOut.length ? { notes: notesOut } : {}),
  };
  if (!plan || !cap) {
    return {
      ok: false,
      error: problems.length ? "sampling_failed" : "range_too_short",
      applied: true,
      message: problems.length
        ? `The render was imported but could not be sampled (temporary items: ${state}). Do not run this again before checking the project.`
        : `The range ${secs(range.start)} to ${secs(range.end)} is shorter than two frames. Nothing was sampled (temporary items: ${state}).`,
      ...(extra.length ? { findings: extra } : {}),
      ...project,
    };
  }
  const prep: Prepared = {
    mode: "file",
    start: range.start,
    end: range.end,
    frameDuration: timing.frameDuration,
    fps: timing.frameRate,
    size: { width: imported.width, height: imported.height, pixelAspect: imported.pixelAspect },
    cuts: intendedCuts(null, args.cut_times, false, range),
    cutSources: { markers: 0, layer_edges: 0, given: args.cut_times?.length ?? 0 },
    subject: {
      file: { path: file, size: stat.size, modified: stat.mtime.toISOString(), sequence, width: imported.width, height: imported.height, fps: round2(timing.frameRate), duration: timing.duration },
      ...(sequenceInfo ? { sequence_check: { pattern: sequenceInfo.pattern, first: sequenceInfo.first, last: sequenceInfo.last, present: sequenceInfo.present, missing: sequenceInfo.missing, truncated: sequenceInfo.truncated } } : {}),
    },
  };
  const result = finish(args, prep, plan, cap, [...extra, ...sizeFindings(prep.size, args.expected_size, true)], framesDir);
  return { ...result, ...project };
}

export const scrubTools: ToolDefinition<any>[] = [
  {
    name: "ae_scrub_check",
    description:
      "Look for motion problems between frames, which single snapshots and metadata checks miss. Renders frame PAIRS (a frame and the next) spread across a comp's work area (comp_id) or a finished render (path), " +
      "and checks them in Node for: black, transparent or one-colour stretches (the last frames included), frozen runs, pops (a jump far above the shot's usual change, away from markers and layer in/out points), flicker, " +
      "content touching only some edges (a cut-off heuristic), clipped highlights (an 'RGB extremes' heuristic: AE gives full-range RGB, so the 16-235 broadcast range can't be judged), missing numbers in an image sequence, wrong size or aspect, and non-square pixels. " +
      "Returns pass, warn or fail with times, a contact sheet of each suspect frame next to its neighbour, and the frame-difference curve as a chart PNG (look at both). " +
      "Samples are pairs spread over the range, so a pop or freeze between them can be missed: raise `samples` or narrow `start`/`end` to look closer; short ranges are checked frame by frame. Every frame is a render, so heavy comps take a while. " +
      "Comp mode is read-only: the comp, its time and the project are not touched. Path mode (a movie, or one frame of a numbered sequence) imports the render and builds a temporary comp to grab frames from, in one undo group guarded by `expect`, " +
      "with an automatic checkpoint; both are removed again afterwards in a second one (two undo steps in all) and a separate read confirms they are gone. The project is marked changed. " +
      "Not included: a silent-audio-tail check on movies (use ae_audio_analyze for a comp's sound). " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeScrubCheckSchema,
    handler: (args: AeScrubCheckArgs, ctx: ToolContext) => (args.path !== undefined ? scrubFile(args, ctx) : scrubComp(args, ctx)),
  },
];
