/**
 * server/src/tools/ext/timing.ts
 *
 * ae_timing_check (read only): the timeline checks of the motion review
 * (docs/MOTION-RESEARCH.md item 4), judged against the project's motion spec
 * (the brief's `motion` field, see motion-spec.ts and loadMotionSpec).
 *
 * - unread_lines: each visible text line's on-screen time against
 *   readingTimeS(). A line is one Source Text value (each key starts a new
 *   line); on screen = layer in to out, narrowed to where Opacity is above 5 %.
 * - dead_stretches: spans longer than dead_stretch_s where nothing changes. Data
 *   only, no render: a change is a keyframe segment whose values differ, a hold
 *   key, a Source Text change, a layer appearing or disappearing, an expression,
 *   playing video footage, or a precomp that animates. Stills and solids don't count.
 * - first_frame: renders the first frame of the range and flags it when it is
 *   blank (uniform, black or transparent), reusing the blank-frame detection of
 *   ae_compare_frames and its stale-frame guard.
 * - silent_film: a range over 15 s with no audio layer that is on and not muted.
 * - facts: when the spec lists approved facts, every number and every
 *   Capitalised multi-word name in the visible text that no fact covers.
 *
 * The range is the work area by default (that is what a render delivers); pass
 * start_s and end_s to look at less. Nothing in the project is touched.
 */

import * as fs from "node:fs";
import { z } from "zod";
import { BridgeError, SLOW_TIMEOUT_MS } from "../../host.js";
import { QueueWaitError } from "../../queue.js";
import { readingTimeS, type ResolvedMotionSpec } from "../../motion-spec.js";
import type { ToolContext, ToolDefinition } from "../common.js";
import { defaultFramesDir } from "../render.js";
import { loadMotionSpec } from "./brief.js";
import { analyzeDecodedFrame, captureCompFrame, compareDecodedFrames, decodePngFile, type FrameAnalysis } from "./frames.js";

// ---------- constants and schema ----------

export const TIMING_CHECKS = ["unread_lines", "dead_stretches", "first_frame", "silent_film", "facts"] as const;
export type TimingCheck = (typeof TIMING_CHECKS)[number];

/** Opacity (%) at or below which a layer is taken as not showing. */
export const MIN_VISIBLE_OPACITY = 5;
/** A range longer than this with no audio is a silent film. */
export const SILENT_AFTER_S = 15;
const MAX_CONFIRM_STRETCHES = 3;
const MAX_LINES_LISTED = 60;
const EPS = 1e-6;

export const AeTimingCheckSchema = z
  .object({
    comp_id: z.number().int().optional().describe("The comp to check. Default: the active comp."),
    checks: z
      .array(z.enum(TIMING_CHECKS))
      .min(1)
      .max(TIMING_CHECKS.length)
      .optional()
      .describe("Which checks to run: unread_lines, dead_stretches, first_frame, silent_film, facts. Default: all."),
    start_s: z.number().min(0).optional().describe("Start of the range to check, in seconds. Default: the work area start."),
    end_s: z.number().min(0).optional().describe("End of the range to check, in seconds. Default: the work area end."),
    confirm_with_frames: z
      .boolean()
      .default(false)
      .describe("Also render three frames inside each dead stretch (the first three stretches) and diff them, to confirm nothing moves. A stretch whose frames differ is downgraded to P2. Costs renders; default false."),
  })
  .refine((v) => v.start_s === undefined || v.end_s === undefined || v.end_s > v.start_s, { message: "end_s must be after start_s", path: ["end_s"] });

export type AeTimingCheckArgs = z.infer<typeof AeTimingCheckSchema>;

// ---------- host data ----------

export interface HostOpacity {
  value: number;
  keys: Array<{ t: number; v: number }> | null;
}

export interface HostTimingLayer {
  id: number;
  index: number;
  name: string;
  kind: "text" | "shape" | "camera" | "light" | "null" | "adjustment" | "precomp" | "solid" | "footage" | "audio" | "other";
  enabled: boolean;
  solo: boolean;
  guide: boolean;
  in_s: number;
  out_s: number;
  has_audio: boolean;
  audio_enabled: boolean;
  audio_muted: boolean;
  video_playing: boolean;
  expression: boolean;
  /** Set when the layer was read in part: from this time to the out point it counts as changing. */
  change_from_s?: number | null;
  spans: Array<[number, number]>;
  points: number[];
  opacity: HostOpacity;
  text: string | null;
  text_keys: Array<{ t: number; text: string }> | null;
  truncated: boolean;
}

export interface HostTiming {
  comp: {
    id: number;
    name: string;
    duration_s: number;
    frame_rate: number;
    width: number;
    height: number;
    work_area_start_s: number;
    work_area_duration_s: number;
  };
  solo_any: boolean;
  layer_count: number;
  layers: HostTimingLayer[];
  /** Layers past the host's cap were not read. */
  truncated: boolean;
  /** The host's total key cap was hit; later properties and layers were read in part. */
  keys_truncated?: boolean;
}

// ---------- findings ----------

export type Severity = "P0" | "P1" | "P2";

export interface LayerRef {
  id: number;
  index: number;
  name: string;
}

export interface TimingFinding {
  check: TimingCheck;
  severity: Severity;
  start_s: number;
  end_s: number;
  start_frame: number;
  end_frame: number;
  layers: LayerRef[];
  message: string;
  fix: string;
  detail?: Record<string, unknown>;
}

const SEVERITY_RANK: Record<Severity, number> = { P0: 0, P1: 1, P2: 2 };

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const ref = (l: HostTimingLayer): LayerRef => ({ id: l.id, index: l.index, name: l.name });

function finding(fps: number, f: Omit<TimingFinding, "start_frame" | "end_frame">): TimingFinding {
  return { ...f, start_s: r3(f.start_s), end_s: r3(f.end_s), start_frame: Math.round(f.start_s * fps), end_frame: Math.round(f.end_s * fps) };
}

export function sortFindings(list: TimingFinding[]): TimingFinding[] {
  return [...list].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.start_s - b.start_s || a.check.localeCompare(b.check));
}

// ---------- intervals ----------

export type Interval = [number, number];

export function mergeIntervals(list: Interval[], gap = EPS): Interval[] {
  const s = list.filter((i) => i[1] >= i[0]).map((i) => [i[0], i[1]] as Interval).sort((a, b) => a[0] - b[0]);
  const out: Interval[] = [];
  for (const i of s) {
    const last = out[out.length - 1];
    if (last && i[0] <= last[1] + gap) {
      if (i[1] > last[1]) last[1] = i[1];
    } else out.push(i);
  }
  return out;
}

export function intersectIntervals(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const x of a) {
    for (const y of b) {
      const lo = Math.max(x[0], y[0]);
      const hi = Math.min(x[1], y[1]);
      if (hi > lo + EPS) out.push([lo, hi]);
    }
  }
  return mergeIntervals(out);
}

const total = (list: Interval[]) => list.reduce((n, i) => n + (i[1] - i[0]), 0);

/** Opacity (%) at a time: piecewise linear between keys, held outside them. Hold keys are not modelled. */
export function opacityAt(o: HostOpacity, t: number): number {
  const ks = o.keys;
  if (!ks || ks.length === 0) return o.value;
  if (t <= ks[0].t) return ks[0].v;
  const last = ks[ks.length - 1];
  if (t >= last.t) return last.v;
  for (let i = 0; i + 1 < ks.length; i++) {
    const a = ks[i];
    const b = ks[i + 1];
    if (t >= a.t && t <= b.t) return b.t === a.t ? b.v : a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
  }
  return last.v;
}

/** Times in [a, b] where Opacity is above the visible floor. */
export function opacityVisible(o: HostOpacity, a: number, b: number): Interval[] {
  if (b <= a) return [];
  const marks = [a, b, ...(o.keys ?? []).map((k) => k.t).filter((t) => t > a && t < b)].sort((x, y) => x - y);
  const out: Interval[] = [];
  for (let i = 0; i + 1 < marks.length; i++) {
    const s = marks[i];
    const e = marks[i + 1];
    if (e <= s) continue;
    const vs = opacityAt(o, s);
    const ve = opacityAt(o, e);
    const sOn = vs > MIN_VISIBLE_OPACITY;
    const eOn = ve > MIN_VISIBLE_OPACITY;
    if (sOn && eOn) out.push([s, e]);
    else if (sOn || eOn) {
      const tc = s + ((MIN_VISIBLE_OPACITY - vs) / (ve - vs)) * (e - s);
      out.push(sOn ? [s, tc] : [tc, e]);
    }
  }
  return mergeIntervals(out);
}

const CONTROLLERS = new Set(["null", "camera", "light"]);

/**
 * When a layer shows: its in to out, narrowed by Opacity. Switched-off, guide and
 * non-soloed layers never show; audio-only layers aren't seen. Nulls, cameras and
 * lights aren't seen either, but their animation moves what is, so they count as
 * present for the whole in to out.
 */
export function presence(l: HostTimingLayer, soloAny: boolean): Interval[] {
  if (!l.enabled || l.guide) return [];
  if (l.out_s <= l.in_s) return [];
  if (CONTROLLERS.has(l.kind)) return [[l.in_s, l.out_s]];
  if (l.kind === "audio") return [];
  if (soloAny && !l.solo) return [];
  return opacityVisible(l.opacity, l.in_s, l.out_s);
}

// ---------- unread lines ----------

export interface TextLine {
  layer: HostTimingLayer;
  text: string;
  /** Where this text value is current, in comp time. */
  window: Interval;
  /** Where it is current and visible. */
  visible: Interval[];
  visible_s: number;
  start_s: number;
  end_s: number;
}

const normText = (s: string) => String(s).replace(/\s+/g, " ").trim();

/** One line per Source Text value: each key opens a new window, the last runs to the out point. */
export function textLines(layers: HostTimingLayer[], soloAny: boolean): TextLine[] {
  const out: TextLine[] = [];
  for (const l of layers) {
    if (l.kind !== "text") continue;
    const pres = presence(l, soloAny);
    if (pres.length === 0) continue;
    const keys = l.text_keys && l.text_keys.length > 0 ? [...l.text_keys].sort((a, b) => a.t - b.t) : null;
    const windows: Array<{ text: string; w: Interval }> = [];
    if (!keys) windows.push({ text: l.text ?? "", w: [l.in_s, l.out_s] });
    else {
      for (let i = 0; i < keys.length; i++) {
        const start = i === 0 ? l.in_s : Math.max(keys[i].t, l.in_s);
        const end = i + 1 < keys.length ? Math.min(keys[i + 1].t, l.out_s) : l.out_s;
        if (end > start + EPS) windows.push({ text: keys[i].text, w: [start, end] });
      }
    }
    // Neighbouring windows with the same text are one line.
    const merged: Array<{ text: string; w: Interval }> = [];
    for (const w of windows) {
      const prev = merged[merged.length - 1];
      if (prev && normText(prev.text) === normText(w.text) && w.w[0] <= prev.w[1] + EPS) prev.w = [prev.w[0], w.w[1]];
      else merged.push({ text: w.text, w: [w.w[0], w.w[1]] });
    }
    for (const m of merged) {
      const text = normText(m.text);
      if (!text) continue;
      const visible = intersectIntervals([m.w], pres);
      if (visible.length === 0) continue;
      out.push({ layer: l, text, window: m.w, visible, visible_s: total(visible), start_s: visible[0][0], end_s: visible[visible.length - 1][1] });
    }
  }
  return out;
}

export interface LineReport {
  layer: LayerRef;
  text: string;
  start_s: number;
  end_s: number;
  on_screen_s: number;
  needed_s: number;
  is_last: boolean;
  ok: boolean;
}

/** Lines overlapping [rs, re] and whether each is read; the last-ending line is the "last line". */
export function readingReport(lines: TextLine[], spec: ResolvedMotionSpec, range: Interval, fps: number): LineReport[] {
  const inRange = lines.filter((x) => x.end_s > range[0] + EPS && x.start_s < range[1] - EPS);
  let last: TextLine | null = null;
  for (const x of inRange) {
    if (!last || x.end_s > last.end_s + EPS || (Math.abs(x.end_s - last.end_s) <= EPS && x.start_s > last.start_s)) last = x;
  }
  const tol = 0.5 / Math.max(fps, 1);
  return inRange.map((x) => {
    const isLast = x === last;
    const needed = readingTimeS(x.text, spec.reading, isLast);
    return {
      layer: ref(x.layer),
      text: x.text,
      start_s: r3(x.start_s),
      end_s: r3(x.end_s),
      on_screen_s: r3(x.visible_s),
      needed_s: r3(needed),
      is_last: isLast,
      ok: x.visible_s + tol >= needed,
    };
  });
}

export function unreadFindings(reports: LineReport[], fps: number): TimingFinding[] {
  const out: TimingFinding[] = [];
  const seen = new Map<string, TimingFinding>();
  for (const r of reports) {
    if (r.ok) continue;
    const words = r.text.split(/\s+/).filter(Boolean).length;
    const short = r.needed_s - r.on_screen_s;
    const key = `${r.text}|${r.start_s}|${r.end_s}`;
    const dup = seen.get(key);
    if (dup) {
      dup.layers.push(r.layer);
      continue;
    }
    const f = finding(fps, {
      check: "unread_lines",
      severity: r.on_screen_s < r.needed_s / 2 ? "P0" : "P1",
      start_s: r.start_s,
      end_s: r.end_s,
      layers: [r.layer],
      message: `"${r.text.length > 80 ? r.text.slice(0, 77) + "..." : r.text}" (${words} word${words === 1 ? "" : "s"}${r.is_last ? ", the last line" : ""}) is on screen ${r.on_screen_s} s; reading needs ${r.needed_s} s`,
      fix: `Hold it ${r3(short)} s longer (out point to ${r3(r.end_s + short)} s), or cut the copy to fit ${r.on_screen_s} s`,
      detail: { on_screen_s: r.on_screen_s, needed_s: r.needed_s, words, is_last: r.is_last },
    });
    seen.set(key, f);
    out.push(f);
  }
  return out;
}

// ---------- dead stretches ----------

export interface DeadStretch {
  start_s: number;
  end_s: number;
  length_s: number;
  layers: LayerRef[];
}

/** Everything that counts as change, as intervals (a single moment is a zero-length interval). */
export function changeIntervals(layers: HostTimingLayer[], soloAny: boolean): Interval[] {
  const out: Interval[] = [];
  for (const l of layers) {
    const pres = presence(l, soloAny);
    if (pres.length === 0) continue;
    for (const p of pres) out.push([p[0], p[0]], [p[1], p[1]]);
    for (const s of l.spans) out.push(...intersectIntervals([[s[0], s[1]]], pres));
    const moments = [...l.points, ...(l.text_keys ?? []).map((k) => k.t)];
    for (const t of moments) if (pres.some((p) => t >= p[0] - EPS && t <= p[1] + EPS)) out.push([t, t]);
    if (l.expression || l.video_playing) out.push(...pres);
    // Read in part (spans or properties cut off): the unread tail must not look dead.
    if (l.truncated) out.push(...intersectIntervals([[l.change_from_s ?? l.in_s, l.out_s]], pres));
  }
  return mergeIntervals(out);
}

/** Layers the host read in part (properties, keys or spans cut off at its caps). */
export function partialLayers(host: HostTiming): HostTimingLayer[] {
  return host.layers.filter((l) => l.truncated && presence(l, host.solo_any).length > 0);
}

export function deadStretches(layers: HostTimingLayer[], soloAny: boolean, range: Interval, limit: number): DeadStretch[] {
  const changes = changeIntervals(layers, soloAny)
    .map((i) => [Math.max(i[0], range[0]), Math.min(i[1], range[1])] as Interval)
    .filter((i) => i[1] >= i[0]);
  const gaps: Interval[] = [];
  let cursor = range[0];
  for (const c of mergeIntervals(changes)) {
    if (c[0] > cursor) gaps.push([cursor, c[0]]);
    cursor = Math.max(cursor, c[1]);
  }
  if (cursor < range[1]) gaps.push([cursor, range[1]]);
  return gaps
    .filter((g) => g[1] - g[0] > limit + EPS)
    .map((g) => {
      const here = layers.filter((l) => {
        const p = intersectIntervals(presence(l, soloAny), [g]);
        return total(p) >= (g[1] - g[0]) * 0.5 && l.kind !== "null" && l.kind !== "camera" && l.kind !== "light";
      });
      return { start_s: g[0], end_s: g[1], length_s: g[1] - g[0], layers: here.slice(0, 8).map(ref) };
    });
}

export function deadStretchFindings(stretches: DeadStretch[], limit: number, fps: number): TimingFinding[] {
  return stretches.map((s) =>
    finding(fps, {
      check: "dead_stretches",
      severity: s.length_s > limit * 2 ? "P0" : "P1",
      start_s: s.start_s,
      end_s: s.end_s,
      layers: s.layers,
      message: `Nothing changes for ${r3(s.length_s)} s (limit ${limit} s): no keyframe moves, no layer comes or goes, no footage or precomp plays`,
      fix: `Give ${r3(s.start_s)}-${r3(s.end_s)} s a reason to look: a move, a cut, a reveal or a new line, or cut ${r3(s.length_s - limit)} s from the hold`,
      detail: { length_s: r3(s.length_s), limit_s: limit },
    })
  );
}

// ---------- silent film ----------

export function silentFilmFindings(layers: HostTimingLayer[], range: Interval, fps: number): { findings: TimingFinding[]; audio_layers: number } {
  // Only audio that plays inside the checked range counts.
  const carriers = layers.filter(
    (l) => l.has_audio && l.audio_enabled && !l.audio_muted && l.out_s > l.in_s && l.out_s > range[0] + EPS && l.in_s < range[1] - EPS
  );
  const length = range[1] - range[0];
  if (length <= SILENT_AFTER_S + EPS) return { findings: [], audio_layers: carriers.length };
  const covered = mergeIntervals(carriers.map((l) => [Math.max(l.in_s, range[0]), Math.min(l.out_s, range[1])] as Interval));
  const gaps: Interval[] = [];
  let cursor = range[0];
  for (const c of covered) {
    if (c[0] > cursor + EPS) gaps.push([cursor, c[0]]);
    cursor = Math.max(cursor, c[1]);
  }
  if (cursor < range[1] - EPS) gaps.push([cursor, range[1]]);
  const findings = gaps
    .filter((g) => g[1] - g[0] > SILENT_AFTER_S + EPS)
    .map((g) => {
      const whole = carriers.length === 0;
      return finding(fps, {
        check: "silent_film",
        severity: "P1",
        start_s: g[0],
        end_s: g[1],
        layers: [],
        message: whole
          ? `${r3(g[1] - g[0])} s with no audio layer that is on and not muted (limit ${SILENT_AFTER_S} s)`
          : `${r3(g[1] - g[0])} s (${r3(g[0])}-${r3(g[1])} s) with no audio playing: the audio layers that are on do not cover it (limit ${SILENT_AFTER_S} s)`,
        fix: whole
          ? "Add a music bed, voice-over or sound design, or tell the client the film is silent on purpose"
          : `Extend or loop the audio over ${r3(g[0])}-${r3(g[1])} s, or tell the client that stretch is silent on purpose`,
        detail: { length_s: r3(g[1] - g[0]), limit_s: SILENT_AFTER_S, audio_layers: carriers.length },
      });
    });
  return { findings, audio_layers: carriers.length };
}

// ---------- facts ----------

export interface FactToken {
  text: string;
  kind: "number" | "name";
}

const NUM_RE = /([£$€])?(\d[\d,]*(?:\.\d+)?)(%|bn|m|k)?/gi;

/** The numeric value as a comparable string ("1,000.50" and "1000.5" are one number). */
function numKey(core: string): string {
  const n = Number(core.replace(/,/g, ""));
  return Number.isFinite(n) ? String(n) : core;
}

const MONTHS = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

/**
 * Tokens that look like numbers but are not claims: times, ratios and fractions ("24/7"),
 * phone-like digit groups, "#1", day-month dates and years 1900-2099. Masked out before
 * numbers are read, so "10:30" is not 10 and 30. A currency sign or % keeps a number real
 * ("£1,999"), and a four-digit year with a decimal or comma is not a year.
 */
const COMPOSITE_RES: RegExp[] = [
  /\d{1,2}:\d{2}(?::\d{2})?(?:\s?[ap]\.?m\.?)?/gi,
  /\d+\/\d+(?:\/\d+)?/g,
  /#\s?\d+/g,
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:${MONTHS})\\b\\.?(?:\\s+(?:19|20)\\d{2})?`, "gi"),
  new RegExp(`\\b(?:${MONTHS})\\b\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+(?:19|20)\\d{2})?\\b`, "gi"),
  /(?<![£$€\d.,])\b(?:19|20)\d{2}\b(?![\d%]|[.,]\d)/g,
];
const PHONE_RE = /\+?\(?\d{2,5}\)?(?:[ -]\d{2,5}){2,}/g;

function maskComposites(text: string): string {
  let t = text;
  const blank = (m: string) => " ".repeat(m.length);
  t = t.replace(PHONE_RE, (m) => (m.replace(/\D/g, "").length >= 8 ? blank(m) : m));
  for (const re of COMPOSITE_RES) t = t.replace(re, blank);
  return t;
}

/**
 * Numbers in text: digits with an optional currency sign, thousands commas, decimals and %,
 * and bn/m/k after a currency sign. Digits glued to letters ("3D", "4K", "H264", "2nd") are not numbers.
 * With `skipComposite` (the default) times, ratios, phone numbers, "#n", dates and years are
 * not numbers either.
 */
export function extractNumbers(text: string, skipComposite = true): Array<{ text: string; key: string }> {
  const out: Array<{ text: string; key: string }> = [];
  if (skipComposite) text = maskComposites(text);
  const re = new RegExp(NUM_RE.source, NUM_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const start = m.index;
    const currency = m[1];
    let core = m[2];
    let suffix = m[3] ?? "";
    let end = start + m[0].length;
    if (/,$/.test(core)) {
      core = core.replace(/,+$/, "");
      end -= m[2].length - core.length;
    }
    if (start > 0 && /[\p{L}0-9]/u.test(text[start - 1])) continue;
    if (suffix && suffix !== "%" && !currency) {
      suffix = "";
      end -= (m[3] ?? "").length;
    }
    if (end < text.length && /\p{L}/u.test(text[end])) continue;
    out.push({ text: text.slice(start, end), key: numKey(core) });
  }
  return out;
}

const NAME_WORD = /^\p{Lu}[\p{L}'’&-]*$/u;
const LEAD_STOP = new Set(["the", "a", "an", "our", "your", "my", "this", "that", "these", "those", "new", "introducing", "meet", "why", "how", "what", "when", "get", "buy", "shop", "try", "join", "see", "watch", "discover", "free", "now", "and", "or", "but", "with", "for", "from", "in", "on", "at", "to", "by", "it", "its", "we", "you"]);
const CONNECT = new Set(["of", "the", "de", "van", "von", "du", "la", "le", "&"]);

/**
 * Capitalised multi-word runs ("Aurora Pro", "Bank of America"). Conservative: all-caps text
 * is skipped (shouted copy has no case to go by), so is a Title Case line of four words or
 * more (a headline), and common lead-in words ("Introducing", "The", "New") are stripped
 * before a run is judged. A run ends at punctuation. Letters are Unicode ("Zürich Airport").
 */
export function extractNames(text: string): string[] {
  const out: string[] = [];
  for (const segment of text.split(/[\r\n]+/)) {
    const seg = segment.trim();
    if (!seg || !/\p{Ll}/u.test(seg)) continue;
    const words = seg.split(/\s+/);
    const alpha = words.filter((w) => /\p{L}/u.test(w));
    if (alpha.length >= 4 && alpha.every((w) => /^\p{Lu}/u.test(w))) continue;
    let run: string[] = [];
    const flush = () => {
      while (run.length && LEAD_STOP.has(run[0].toLowerCase())) run.shift();
      while (run.length && CONNECT.has(run[run.length - 1].toLowerCase())) run.pop();
      const caps = run.filter((w) => NAME_WORD.test(w));
      if (caps.length >= 2) out.push(run.join(" "));
      run = [];
    };
    for (let i = 0; i < words.length; i++) {
      const raw = words[i];
      const endsPunct = /[,.:;!?)\]"”]$/.test(raw);
      const w = raw.replace(/^[("“]+/, "").replace(/[,.:;!?)\]"”]+$/, "");
      if (NAME_WORD.test(w)) {
        run.push(w);
        if (endsPunct) flush();
      } else if (CONNECT.has(w.toLowerCase()) && run.length > 0 && i + 1 < words.length && NAME_WORD.test(words[i + 1].replace(/^[("“]+/, ""))) {
        run.push(w);
      } else flush();
    }
    flush();
  }
  return out;
}

const normName = (s: string) => ` ${s.toLowerCase().replace(/[^\p{L}\p{N}&]+/gu, " ").trim()} `;

/**
 * Words of ordinary call-to-action and marketing copy. A Capitalised run that contains any of
 * them ("Learn More", "Sign Up Today", "Black Friday") is a phrase, not a name.
 */
export const COMMON_COPY_WORDS = new Set([
  "learn", "more", "sign", "up", "today", "visit", "our", "store", "shop", "now", "get", "started", "buy", "free", "new", "black", "friday",
  "built", "different", "discover", "find", "out", "see", "how", "why", "what", "the", "a", "an", "and", "of", "for", "with", "your", "you", "we",
  // Further everyday copy words, days and months.
  "product", "products", "launch", "event", "events", "collection", "sale", "offer", "offers", "limited", "edition", "special", "best", "top", "big", "great",
  "welcome", "thank", "thanks", "join", "call", "book", "contact", "order", "download", "watch", "read", "view", "start", "tomorrow", "tonight", "cyber", "monday",
  "tuesday", "wednesday", "thursday", "saturday", "sunday", "january", "february", "march", "april", "may", "june", "july", "august", "september", "october",
  "november", "december", "all", "this", "that", "only", "save", "off", "pre", "available", "coming", "soon", "next", "last", "first", "online", "in", "on", "at", "to", "by",
]);

const nameWords = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/**
 * Whether an uncovered Capitalised run is worth flagging. Not when it contains a common copy word.
 * Otherwise yes when it shares a word with a fact (a near-miss of an approved name, the real
 * risk) or contains a capitalised word that is not common copy (a proper noun nobody approved).
 */
function isLikelyUnapprovedName(name: string, facts: string[]): boolean {
  const caps = name.split(/\s+/).filter((w) => NAME_WORD.test(w)).flatMap(nameWords);
  if (caps.some((w) => COMMON_COPY_WORDS.has(w))) return false;
  const factWords = new Set(facts.flatMap(nameWords));
  if (caps.some((w) => factWords.has(w))) return true;
  return caps.some((w) => w.length >= 2 && !COMMON_COPY_WORDS.has(w));
}

/** Text tokens no fact covers. Numbers match on value alone (a fact "£4.99" covers "4.99"); a name is covered when it contains a fact or a fact contains it. */
export function unapprovedTokens(text: string, facts: string[]): FactToken[] {
  const factNums = new Set<string>();
  for (const f of facts) for (const n of extractNumbers(f, false)) factNums.add(n.key);
  const factNames = facts.map(normName).filter((f) => f.trim().length >= 2);
  const out: FactToken[] = [];
  const seen = new Set<string>();
  for (const n of extractNumbers(text)) {
    if (factNums.has(n.key) || seen.has("n" + n.text)) continue;
    seen.add("n" + n.text);
    out.push({ text: n.text, kind: "number" });
  }
  for (const name of extractNames(text)) {
    const nn = normName(name);
    if (factNames.some((f) => nn.includes(f) || f.includes(nn)) || seen.has("w" + nn)) continue;
    if (!isLikelyUnapprovedName(name, facts)) continue;
    seen.add("w" + nn);
    out.push({ text: name, kind: "name" });
  }
  return out;
}

/** A price or a percentage that no fact covers is a wrong claim until shown otherwise (P0); everything else is a prompt to check (P1). */
const isMoneyOrPercent = (t: FactToken) => t.kind === "number" && (/^[£$€]/.test(t.text) || /%$/.test(t.text));

export function factsFindings(lines: TextLine[], facts: string[], range: Interval, fps: number): TimingFinding[] {
  if (facts.length === 0) return [];
  const out: TimingFinding[] = [];
  const seen = new Set<string>();
  for (const x of lines) {
    if (x.end_s <= range[0] + EPS || x.start_s >= range[1] - EPS) continue;
    const key = `${x.text}|${r3(x.start_s)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const bad = unapprovedTokens(x.text, facts);
    if (bad.length === 0) continue;
    out.push(
      finding(fps, {
        check: "facts",
        severity: bad.some(isMoneyOrPercent) ? "P0" : "P1",
        start_s: x.start_s,
        end_s: x.end_s,
        layers: [ref(x.layer)],
        message: `Not in the approved facts: ${bad.map((b) => `${b.kind} "${b.text}"`).join(", ")}, in "${x.text.length > 80 ? x.text.slice(0, 77) + "..." : x.text}"`,
        fix: "Check each against the client's source. If it is right, add it to the brief's motion.facts; if not, correct the text",
        detail: { unapproved: bad },
      })
    );
  }
  return out;
}

// ---------- first frame ----------

export function firstFrameFinding(a: FrameAnalysis, time: number, fps: number): TimingFinding | null {
  if (!a.is_blank) return null;
  const what = a.is_transparent ? "fully transparent" : a.is_black ? "black" : "one flat colour";
  return finding(fps, {
    check: "first_frame",
    severity: "P0",
    start_s: time,
    end_s: time,
    layers: [],
    message: `The first frame (${r3(time)} s) is ${what}`,
    fix: "Start the first element on frame 1, or move the work area start to the first frame with something in it. Posters, thumbnails and autoplay previews use this frame",
    detail: { flags: a.flags, mean_rgba: a.mean_rgba },
  });
}

// ---------- the handler ----------

const errMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function runQueued<T>(ctx: ToolContext, label: string, opId: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await ctx.queue.run(label, fn);
  } catch (err) {
    if (err instanceof QueueWaitError) throw new BridgeError({ kind: "queued", op_id: opId, message: err.message });
    throw err;
  }
}

interface FrameStage {
  first_frame?: { time_s: number; path?: string; flags?: string[]; mean_rgba?: number[]; error?: string };
  finding?: TimingFinding;
  confirmations: Map<number, { identical: boolean; max_mean_abs_diff: number; frames: string[] } | { error: string }>;
}

export function analyzeTiming(host: HostTiming, spec: ResolvedMotionSpec, checks: Set<TimingCheck>, range: Interval) {
  const fps = host.comp.frame_rate;
  const findings: TimingFinding[] = [];
  const lines = textLines(host.layers, host.solo_any);
  let reports: LineReport[] = [];
  let stretches: DeadStretch[] = [];
  if (checks.has("unread_lines")) {
    reports = readingReport(lines, spec, range, fps);
    findings.push(...unreadFindings(reports, fps));
  }
  let deadSkipped = false;
  const partial = partialLayers(host);
  if (checks.has("dead_stretches")) {
    if (host.truncated) {
      // Layers past the host's cap were never read: any gap could be filled by one of them.
      deadSkipped = true;
      findings.push(
        finding(fps, {
          check: "dead_stretches",
          severity: "P2",
          start_s: range[0],
          end_s: range[1],
          layers: [],
          message: `dead_stretches skipped: only the first ${host.layers.length} of ${host.layer_count} layers were read, so a gap could be filled by a layer that was not read`,
          fix: "Run it on a comp with fewer layers (pre-compose groups), or check the timeline by eye",
          detail: { layers_read: host.layers.length, layer_count: host.layer_count },
        })
      );
    } else {
      stretches = deadStretches(host.layers, host.solo_any, range, spec.dead_stretch_s);
      findings.push(...deadStretchFindings(stretches, spec.dead_stretch_s, fps));
      if (partial.length > 0) {
        // Properties or keys were cut off at the host's caps: those layers count as changing from
        // the cut-off on, so stretches they cover are not reported, and may be missed.
        const from = Math.min(...partial.map((l) => l.change_from_s ?? l.in_s));
        findings.push(
          finding(fps, {
            check: "dead_stretches",
            severity: "P2",
            start_s: Math.max(range[0], from),
            end_s: range[1],
            layers: partial.slice(0, 8).map(ref),
            message: `${partial.length} layer${partial.length === 1 ? " was" : "s were"} read in part (too many properties or keys), so they count as changing from where the read stopped and dead stretches there can be missed`,
            fix: "Check that stretch by eye or with confirm_with_frames",
            detail: { layers: partial.length, keys_truncated: host.keys_truncated === true },
          })
        );
      }
    }
  }
  let audioLayers: number | undefined;
  if (checks.has("silent_film")) {
    const s = silentFilmFindings(host.layers, range, fps);
    audioLayers = s.audio_layers;
    findings.push(...s.findings);
  }
  if (checks.has("facts")) findings.push(...factsFindings(lines, spec.facts, range, fps));
  return { findings, lines, reports, stretches, audioLayers, deadSkipped, partial: partial.length };
}

async function frameStage(
  ctx: ToolContext,
  compId: number,
  fps: number,
  range: Interval,
  wantFirst: boolean,
  confirm: DeadStretch[]
): Promise<FrameStage> {
  const stage: FrameStage = { confirmations: new Map() };
  const framesDir = defaultFramesDir();
  fs.mkdirSync(framesDir, { recursive: true });
  const opId = ctx.bridge.newOpId();
  const tool = "ae_timing_check";
  let blocked = false;
  let idx = 0;
  await runQueued(ctx, `${tool}(${compId})`, opId, async () => {
    if (wantFirst) {
      try {
        const snap = await captureCompFrame({ ctx, opId, compId, time: range[0], frameIndex: idx++, framesDir, toolName: tool });
        const a = analyzeDecodedFrame(decodePngFile(snap.path), { index: 0, path: snap.path, time: snap.time });
        stage.first_frame = { time_s: r3(range[0]), path: snap.path, flags: a.flags, mean_rgba: a.mean_rgba };
        const f = firstFrameFinding(a, range[0], fps);
        if (f) stage.finding = f;
      } catch (err) {
        stage.first_frame = { time_s: r3(range[0]), error: errMessage(err) };
        if (err instanceof BridgeError && (err.kind === "timeout" || err.kind === "queued")) blocked = true;
      }
    }
    const frame = 1 / Math.max(fps, 1);
    for (let si = 0; si < confirm.length && !blocked; si++) {
      const s = confirm[si];
      const span = s.end_s - s.start_s;
      const times = [0.1, 0.5, 0.9].map((u) => Math.min(Math.max(s.start_s + span * u, s.start_s + frame), s.end_s - frame));
      try {
        const paths: string[] = [];
        for (const t of times) paths.push((await captureCompFrame({ ctx, opId, compId, time: t, frameIndex: idx++, framesDir, toolName: tool })).path);
        const pngs = paths.map(decodePngFile);
        let worst = 0;
        let identical = true;
        for (let i = 0; i + 1 < pngs.length; i++) {
          const c = compareDecodedFrames(pngs[i], pngs[i + 1], { threshold: 0.02 });
          worst = Math.max(worst, c.mean_abs_diff);
          if (!c.identical) identical = false;
        }
        stage.confirmations.set(si, { identical, max_mean_abs_diff: Math.round(worst * 1e6) / 1e6, frames: paths });
      } catch (err) {
        stage.confirmations.set(si, { error: errMessage(err) });
        if (err instanceof BridgeError && (err.kind === "timeout" || err.kind === "queued")) blocked = true;
      }
    }
  });
  return stage;
}

export async function timingCheckHandler(args: AeTimingCheckArgs, ctx: ToolContext) {
  const tool = "ae_timing_check";
  const spec = await loadMotionSpec(ctx);
  const res = await ctx.bridge.callHost<HostTiming>(
    "timingRead",
    { comp_id: args.comp_id },
    { label: `${tool}(${args.comp_id ?? "active"})`, mutates: false, toolName: tool, timeoutMs: SLOW_TIMEOUT_MS }
  );
  const host = res.result as HostTiming;
  const c = host.comp;
  const checks = new Set<TimingCheck>(args.checks ?? TIMING_CHECKS);
  const waStart = c.work_area_start_s;
  const waEnd = Math.min(c.duration_s, waStart + c.work_area_duration_s);
  const rs = Math.max(0, args.start_s ?? waStart);
  const re = Math.min(c.duration_s, args.end_s ?? waEnd);
  if (re <= rs) {
    return { ok: false, error: "empty_range", message: `The range ${rs}-${re} s is empty (comp is ${c.duration_s} s long).` };
  }
  const range: Interval = [rs, re];

  const a = analyzeTiming(host, spec, checks, range);
  let findings = a.findings;

  let frames: FrameStage | null = null;
  const wantFirst = checks.has("first_frame");
  const toConfirm = args.confirm_with_frames ? a.stretches.slice(0, MAX_CONFIRM_STRETCHES) : [];
  if (wantFirst || toConfirm.length > 0) {
    frames = await frameStage(ctx, c.id, c.frame_rate, range, wantFirst, toConfirm);
    if (frames.finding) findings.push(frames.finding);
    if (frames.confirmations.size > 0) {
      // Match each confirmed stretch to its finding by start time.
      findings = findings.map((f) => {
        if (f.check !== "dead_stretches") return f;
        const si = a.stretches.findIndex((s) => Math.abs(s.start_s - f.start_s) < 0.002);
        const conf = frames!.confirmations.get(si);
        if (!conf) return f;
        if ("error" in conf) return { ...f, detail: { ...f.detail, frames_confirm: { error: conf.error } } };
        if (conf.identical) return { ...f, detail: { ...f.detail, frames_confirm: conf } };
        return {
          ...f,
          severity: "P2" as const,
          message: f.message + "; but rendered frames inside it differ, so something moves that the keyframes and layers don't show",
          fix: "Probably an effect or expression driving the change: if that is the intended motion, leave it",
          detail: { ...f.detail, frames_confirm: conf },
        };
      });
    }
  }

  findings = sortFindings(findings);
  const counts = { P0: 0, P1: 0, P2: 0 };
  for (const f of findings) counts[f.severity]++;
  const notes = [
    "Read only: nothing in the project is changed.",
    `Range ${r3(rs)}-${r3(re)} s (${args.start_s === undefined && args.end_s === undefined ? "the work area" : "as asked"}). Lines are judged on their whole on-screen span even when it crosses the range edge.`,
    `On screen means in to out point with Opacity above ${MIN_VISIBLE_OPACITY} %; hold keys on Opacity, animator opacity, mattes and blend modes are not modelled.`,
    "Text inside precomps is not read (a precomp only counts as playing or still). Effects that move by themselves with no keys or expression are not seen as change; use confirm_with_frames to check a stretch.",
    "Expressions: any enabled expression marks its whole layer as changing, even if it produces no visible movement (a known false negative for dead_stretches).",
    "facts: a price or percentage no fact covers is P0; other numbers and names are P1. Numbers match on value alone; times, ratios, phone numbers, dates, years and #n are not read as numbers; a name is covered when it contains a fact or a fact contains it; all-caps text, Title Case lines of 4+ words and common call-to-action phrases (\"Learn More\", \"Black Friday\") are skipped.",
    "silent_film: only audio layers that overlap the range count, and an audio-free stretch over 15 s is flagged.",
  ];
  if (host.truncated) notes.push(`Only the first ${host.layers.length} of ${host.layer_count} layers were read.`);
  if (a.deadSkipped) notes.push("dead_stretches was skipped because layers were not read (see the P2 finding).");
  else if (a.partial > 0) notes.push(`${a.partial} layer(s) with very many properties or keyframes were read in part; they count as changing from where the read stopped, so dead stretches there can be missed.`);
  if (checks.has("facts") && spec.facts.length === 0) notes.push("The brief has no motion.facts list, so the facts check had nothing to compare against.");
  if (checks.has("first_frame") && !wantFirst) notes.push("first_frame was not run.");

  return {
    ok: true,
    read_only: true,
    comp: { id: c.id, name: c.name, duration_s: c.duration_s, fps: c.frame_rate, work_area: [r3(waStart), r3(waEnd)] },
    range_s: [r3(rs), r3(re)],
    spec: {
      register: spec.register,
      from_brief: spec.from_brief,
      brief_path: spec.brief_path,
      ...(spec.warning ? { warning: spec.warning } : {}),
      thresholds: {
        reading: spec.reading,
        dead_stretch_s: spec.dead_stretch_s,
        silent_film_after_s: SILENT_AFTER_S,
        min_visible_opacity_pct: MIN_VISIBLE_OPACITY,
        facts: spec.facts.length,
      },
    },
    checks_run: [...checks],
    verdict: counts.P0 + counts.P1 === 0 ? "clean" : "issues",
    counts,
    findings,
    ...(checks.has("unread_lines")
      ? { lines_checked: a.reports.length, lines: a.reports.slice(0, MAX_LINES_LISTED), ...(a.reports.length > MAX_LINES_LISTED ? { lines_truncated: true } : {}) }
      : {}),
    ...(checks.has("silent_film") ? { audio_layers: a.audioLayers } : {}),
    ...(frames?.first_frame ? { first_frame: frames.first_frame } : {}),
    notes,
  };
}

// ---------- tool ----------

export const timingTools: ToolDefinition<any>[] = [
  {
    name: "ae_timing_check",
    description:
      "READ-ONLY timeline review against the project's motion spec (the brief's `motion` field; defaults come from its register). Checks: " +
      "(1) unread_lines: each text line's on-screen time (in to out, narrowed where Opacity is under 5 %, one line per Source Text key) against reading time = base + per-word, the last line at least last_line_s (defaults 0.5 s + 0.3 s per word, 2 s); " +
      "(2) dead_stretches: spans over dead_stretch_s (default 3 s) where no keyframe segment moves, no layer comes or goes, no video footage or animated precomp plays (stills and solids don't count), computed from layer data with no render (`confirm_with_frames` also diffs three rendered frames in each of the first three stretches); " +
      "(3) first_frame: renders the first frame of the range (the work area start by default) and flags it when blank, black or transparent; " +
      "(4) silent_film: only audio layers that overlap the range and are on and unmuted count; an audio-free stretch over 15 s inside a range over 15 s is flagged (P1) with its start and end; " +
      "(5) facts: with `motion.facts` in the brief, numbers and Capitalised multi-word names in visible text that no fact covers; a price or percentage is P0, anything else P1; times, dates, phone numbers, ratios and ordinary call-to-action phrases (Learn More, Black Friday) are ignored. " +
      "Known limits: any enabled expression marks its whole layer as changing (so a layer with a dead expression hides a dead stretch); layers or properties beyond the host's read caps are marked, and dead_stretches is skipped (P2) when layers were not read. " +
      "Returns `spec` (register, which fields came from the brief, thresholds used) and `findings` sorted P0 first, each with start/end in seconds and frames, layers, a message and a one-line fix. " +
      "Range: the work area, or start_s/end_s. Only the first-frame check (and confirm_with_frames) renders; the time indicator and project are not touched. Text in precomps is not read.",
    schema: AeTimingCheckSchema,
    handler: timingCheckHandler,
  },
];
