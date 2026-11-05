/**
 * server/src/tools/ext/describe.ts
 *
 * Read-only comp description:
 * - ae_describe_comp: a plain-language map of a comp that reads in ten
 *   seconds: format and length, the layers by role and stack, a beat-by-beat
 *   timeline clustered from keyframe segments, expressions, precomp nesting,
 *   markers and open concerns; optionally the timeline as a Gantt PNG.
 *
 * One host read (describeRead) gathers the facts; everything that turns them
 * into sentences, beats, concerns and the chart is pure Node code here.
 * Nothing in this file changes the project, the time or the selection.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { PNG } from "pngjs";
import { z } from "zod";
import type { ToolDefinition } from "../common.js";
import { defaultFramesDir } from "../render.js";
import { analyzeMotion, sampleSpeeds, type PropertySamples } from "./motion.js";
import { createCanvas, drawLine, drawText, encodePng, fillRect, strokeRect, type Rgba } from "./png-utils.js";

// ---------- host result shape ----------

export interface DescribeLayer {
  index: number;
  id: number;
  name: string;
  role: string;
  enabled: boolean;
  in_point: number;
  out_point: number;
  start?: number;
  shy?: boolean;
  guide?: boolean;
  solo?: boolean;
  three_d?: boolean;
  locked?: boolean;
  audio?: boolean;
  /** An effect's layer parameter (Displacement Map, Set Matte ...) points at this layer. */
  is_referenced?: boolean;
  parent: number | null;
  matte: { type: string; layer: number | null } | null;
  is_parent: boolean;
  is_matte: boolean;
  comment?: string;
  text?: string;
  source?: { kind: string; name?: string; id?: number; layers?: number; duration?: number; still?: boolean; missing?: boolean };
  expressions: { count: number; props: string[]; refs: string[]; errors: number; refs_truncated?: boolean };
  animated: { props: number; keys: number };
  markers: Array<{ time: number; comment: string; duration?: number }>;
  marker_count?: number;
  segments_truncated?: boolean;
}

export interface DescribeSegment {
  layer: number;
  /** Display name of the property (localized); only for the label. */
  prop: string;
  /** matchName of the property: verbs are chosen from this, not from the localized name. */
  match?: string;
  kind: string;
  start: number;
  end: number;
  from?: number[];
  to?: number[];
  /** Values at evenly spaced times strictly between the two keys (for the overshoot check). */
  samples?: number[][];
  overshoot?: boolean;
  hold?: boolean;
  expression?: boolean;
  /** Expression-driven motion found by sampling valueAtTime, not by keys. */
  sampled?: boolean;
}

export interface NestNode {
  id: number;
  name: string;
  layers?: number;
  duration?: number;
  cycle?: boolean;
  children?: NestNode[];
}

export interface DescribeRaw {
  comp: {
    id: number;
    name: string;
    width: number;
    height: number;
    pixel_aspect: number;
    frame_rate: number;
    duration: number;
    work_area: { start: number; duration: number };
    num_layers: number;
  };
  range: { from: number; to: number; complete: boolean; next_from_layer: number | null; layers_over_cap: boolean };
  layers: DescribeLayer[];
  segments: DescribeSegment[];
  segments_truncated: boolean;
  /** The valueAtTime budget ran out, so some overshoot / expression sampling was skipped. */
  samples_truncated?: boolean;
  walk_truncated: boolean;
  markers: { count: number; list: Array<{ time: number; comment: string; duration?: number }>; truncated: boolean };
  nesting: NestNode;
  nesting_truncated: boolean;
  properties_visited: number;
}

// ---------- schema ----------

export const AeDescribeCompSchema = z.object({
  comp_id: z.number().int().describe("The comp to describe."),
  from_layer: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("First layer (1-based) of the page to read. Default 1. Use next_from_layer from a previous result to continue on a big comp."),
  max_layers: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe("How many layers to read in this call (default 200, at most 500). Beats, expressions and concerns cover the layers read; 'unused layer' is only judged when the whole comp was read."),
  max_beats: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("How many beats of the timeline to put in the summary text (default 12). The beats array holds up to 50 (beats_truncated says if more were found)."),
  include_layers: z
    .boolean()
    .optional()
    .describe("Also return one compact row per layer (index, id, name, role, in/out, parent, matte, flags). Default false: the stack runs and the summary are usually enough and far smaller."),
  gantt: z
    .boolean()
    .optional()
    .describe("Also draw the timeline as a PNG Gantt chart (layer bars by role, keyframe ticks, comp markers in red) and return its path. Default false."),
});

export type AeDescribeCompArgs = z.infer<typeof AeDescribeCompSchema>;

// ---------- pure logic ----------

const r1 = (x: number) => Math.round(x * 10) / 10;
const fmtTime = (t: number) => r1(t).toFixed(1);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Roles in the order the summary lists them. */
const ROLE_ORDER = ["text", "shape", "solid", "footage", "precomp", "model_3d", "parametric_mesh", "adjustment", "null", "camera", "light", "audio"];

/** Roles that draw something in the comp (so they have an entrance and exit worth narrating). */
const VISIBLE_ROLES = new Set(["text", "shape", "solid", "footage", "precomp", "model_3d", "parametric_mesh", "adjustment"]);

/**
 * Beat clustering works on start times only, so one long action cannot swallow
 * what starts after it: an action joins the current beat when it starts within
 * BEAT_JOIN_GAP of the previous action's start and within MAX_BEAT_SPAN of the
 * beat's first start. Actions that run most of the comp are listed apart as
 * "throughout".
 */
const BEAT_JOIN_GAP = 0.3;
const MAX_BEAT_SPAN = 1.5;
const LONG_ACTION_MIN = 2;
const LONG_ACTION_SHARE = 0.4;
/** Actions on the same layer with the same verb that sit this close are one action. */
const MERGE_GAP = 0.25;

export function roleCounts(layers: DescribeLayer[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of layers) out[l.role] = (out[l.role] ?? 0) + 1;
  return out;
}

function countsText(counts: Record<string, number>): string {
  const keys = Object.keys(counts).sort((a, b) => {
    const ia = ROLE_ORDER.indexOf(a);
    const ib = ROLE_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  return keys.map((k) => `${counts[k]} ${k}`).join(", ");
}

export interface StackRun {
  role: string;
  from: number;
  to: number;
  count: number;
  names: string[];
}

/** The layer stack, top to bottom, as runs of the same role. */
export function stackRuns(layers: DescribeLayer[]): StackRun[] {
  const runs: StackRun[] = [];
  for (const l of layers) {
    const last = runs[runs.length - 1];
    if (last && last.role === l.role && l.index === last.to + 1) {
      last.to = l.index;
      last.count++;
      if (last.names.length < 4) last.names.push(l.name);
    } else {
      runs.push({ role: l.role, from: l.index, to: l.index, count: 1, names: [l.name] });
    }
  }
  return runs;
}

type PropKind = "opacity" | "scale" | "position" | "position_x" | "position_y" | "rotation" | "anchor" | "other";

const MATCH_KIND: Record<string, PropKind> = {
  "ADBE Opacity": "opacity",
  "ADBE Scale": "scale",
  "ADBE Position": "position",
  "ADBE Position_0": "position_x",
  "ADBE Position_1": "position_y",
  "ADBE Rotate Z": "rotation",
  "ADBE Rotate X": "rotation",
  "ADBE Rotate Y": "rotation",
  "ADBE Orientation": "rotation",
  "ADBE Anchor Point": "anchor",
};

/** What a segment's property is, from its matchName. Without one (older data) the English display name is the fallback. */
function propKind(seg: DescribeSegment): PropKind {
  if (seg.match) return MATCH_KIND[seg.match] ?? "other";
  const prop = seg.prop;
  if (prop === "Opacity") return "opacity";
  if (prop === "Scale") return "scale";
  if (prop === "Position") return "position";
  if (prop === "Anchor Point") return "anchor";
  if (/rotation|orientation/i.test(prop)) return "rotation";
  return "other";
}

/** Verb for expression-driven motion that was sampled (no keys to read a direction from). */
function sampledVerb(seg: DescribeSegment): string {
  const k = propKind(seg);
  if (seg.kind === "color") return "changes color (expression)";
  if (k === "position" || k === "position_x" || k === "position_y") return "moves (expression)";
  if (k === "scale") return "scales (expression)";
  if (k === "rotation") return "rotates (expression)";
  if (k === "opacity") return "changes opacity (expression)";
  if (k === "anchor") return "shifts its anchor point (expression)";
  return `animates ${seg.prop} (expression)`;
}

/** First-order verb for a keyframed segment: "fades in", "scales up", "slides right" ... */
export function verbFor(seg: DescribeSegment): string {
  if (seg.sampled) return sampledVerb(seg);
  const prop = seg.prop;
  const k = propKind(seg);
  const from = seg.from ?? [];
  const to = seg.to ?? [];
  let verb: string;
  const delta = (i: number) => (to[i] ?? 0) - (from[i] ?? 0);
  if (seg.kind === "text") {
    verb = "changes its text";
  } else if (seg.kind === "shape") {
    verb = "morphs its path";
  } else if (seg.kind === "color") {
    verb = "changes color";
  } else if (k === "opacity" && seg.hold) {
    verb = delta(0) > 0 ? "appears" : "disappears";
  } else if (k === "opacity") {
    verb = delta(0) > 0 ? "fades in" : "fades out";
  } else if (seg.hold) {
    verb = `steps ${prop}`;
  } else if (k === "scale") {
    const sum = delta(0) + (to.length > 1 ? delta(1) : 0);
    verb = sum > 0 ? "scales up" : "scales down";
  } else if (k === "position_x") {
    verb = delta(0) > 0 ? "slides right" : "slides left";
  } else if (k === "position_y") {
    // AE's y grows downward.
    verb = delta(0) > 0 ? "moves down" : "moves up";
  } else if (k === "position") {
    const dx = delta(0);
    const dy = delta(1);
    if (Math.abs(dy) <= Math.abs(dx) * 0.2) {
      verb = dx > 0 ? "slides right" : "slides left";
    } else if (Math.abs(dx) <= Math.abs(dy) * 0.2) {
      verb = dy > 0 ? "moves down" : "moves up";
    } else {
      verb = "moves";
    }
  } else if (k === "rotation") {
    verb = "rotates";
  } else if (k === "anchor") {
    verb = "shifts its anchor point";
  } else {
    verb = `animates ${prop}`;
  }
  if (seg.overshoot && !seg.expression) verb += " with overshoot";
  return verb;
}

/**
 * Overshoot of one keyframe pair, decided by motion.ts's analyzeMotion (the
 * rule ae_motion_review uses): the sampled values between the two keys are
 * compared with the keys' own range, per dimension, with its tolerance.
 * It sees fewer samples than ae_motion_review's frame grid, so a brief
 * overshoot between samples can be missed; what is flagged agrees with it.
 */
export function overshootFromSamples(seg: DescribeSegment): boolean {
  if (!seg.samples || seg.samples.length === 0 || !seg.from || !seg.to) return false;
  const n = seg.samples.length;
  const times = [seg.start];
  for (let i = 1; i <= n; i++) times.push(seg.start + ((seg.end - seg.start) * i) / (n + 1));
  times.push(seg.end);
  const values = [seg.from, ...seg.samples, seg.to];
  const key = (index: number, time: number, value: number[]) => ({ index, time, value, in_interp: "bezier", out_interp: seg.hold ? "hold" : "bezier" });
  const s = { times, values, keys: [key(1, seg.start, seg.from), key(2, seg.end, seg.to)] } as unknown as PropertySamples;
  try {
    return analyzeMotion(s, sampleSpeeds(s)).overshoot.length > 0;
  } catch {
    return false;
  }
}

/** "fades in" to "fade in" (the verb for several layers). */
function pluralVerb(verb: string): string {
  const sp = verb.indexOf(" ");
  const first = sp < 0 ? verb : verb.slice(0, sp);
  const rest = sp < 0 ? "" : verb.slice(sp);
  if (first.endsWith("s") && first.length > 1) return first.slice(0, -1) + rest;
  return verb;
}

export interface Action {
  layer: number;
  name: string;
  verb: string;
  start: number;
  end: number;
}

/** Actions from keyframed segments (merged per layer and verb) plus each layer's entrance and exit. */
export function buildActions(raw: DescribeRaw): Action[] {
  const byIndex = new Map(raw.layers.map((l) => [l.index, l]));
  const actions: Action[] = [];
  const eff = (s: { hold?: boolean; start: number; end: number }): number => (s.hold ? s.end : s.start);
  const sorted = [...raw.segments].sort((a, b) => eff(a) - eff(b));
  const open = new Map<string, Action>();
  for (const seg0 of sorted) {
    const layer = byIndex.get(seg0.layer);
    if (!layer) continue;
    const s = seg0.overshoot === undefined && seg0.samples ? { ...seg0, overshoot: overshootFromSamples(seg0) } : seg0;
    const verb = verbFor(s);
    const key = `${s.layer}|${verb}`;
    const cur = open.get(key);
    // A hold key only changes the value at the second key, so the action is that instant.
    const aStart = s.hold ? s.end : s.start;
    if (cur && aStart <= cur.end + MERGE_GAP) {
      cur.start = Math.min(cur.start, aStart);
      cur.end = Math.max(cur.end, s.end);
    } else {
      const a: Action = { layer: s.layer, name: layer.name, verb, start: aStart, end: s.end };
      open.set(key, a);
      actions.push(a);
    }
  }
  const dur = raw.comp.duration;
  for (const l of raw.layers) {
    if (!l.enabled || !VISIBLE_ROLES.has(l.role)) continue;
    const near = (t: number) => actions.some((a) => a.layer === l.index && (Math.abs(a.start - t) <= 0.1 || Math.abs(a.end - t) <= 0.1));
    if (l.in_point > 0.05 && l.in_point < dur && !near(l.in_point)) {
      actions.push({ layer: l.index, name: l.name, verb: "enters", start: l.in_point, end: l.in_point });
    }
    if (l.out_point < dur - 0.05 && l.out_point > 0 && !near(l.out_point)) {
      actions.push({ layer: l.index, name: l.name, verb: "leaves", start: l.out_point, end: l.out_point });
    }
  }
  return actions.sort((a, b) => a.start - b.start || a.layer - b.layer);
}

export interface Beat {
  start: number;
  end: number;
  text: string;
  actions: number;
}

const NAME_CLIP = 60;
const clipName = (n: string): string => (n.length > NAME_CLIP ? `${n.slice(0, NAME_CLIP)}...` : n);
const MAX_SUMMARY = 20000;
/** Room for the Timeline beat lines; the concerns and notes after them must still fit. */
const BEAT_TEXT_BUDGET = 14000;

const quoteList = (names: string[]): string => {
  const q = names.map((n) => `"${n}"`);
  if (q.length <= 1) return q.join("");
  return `${q.slice(0, -1).join(", ")} and ${q[q.length - 1]}`;
};

function beatText(group: Action[]): string {
  const byVerb = new Map<string, string[]>();
  for (const a of group) {
    const names = byVerb.get(a.verb) ?? [];
    const nm = clipName(a.name);
    if (!names.includes(nm)) names.push(nm);
    byVerb.set(a.verb, names);
  }
  const parts: string[] = [];
  let hidden = 0;
  for (const [verb, names] of byVerb) {
    if (parts.length >= 4) {
      hidden += names.length;
      continue;
    }
    const shown = names.slice(0, 3);
    const more = names.length - shown.length;
    let who = quoteList(shown);
    if (more > 0) who = `${shown.map((n) => `"${n}"`).join(", ")} and ${more} more`;
    parts.push(`${who} ${names.length === 1 ? verb : pluralVerb(verb)}`);
  }
  if (hidden > 0) parts.push(`${hidden} more`);
  return parts.join("; ");
}

/** An action that runs most of the comp (listed as "throughout", not as a beat). */
export function isLongAction(a: Action, compDuration: number): boolean {
  const len = a.end - a.start;
  return len >= LONG_ACTION_MIN && len > LONG_ACTION_SHARE * compDuration;
}

/**
 * Clusters actions into beats by start time: an action joins the current beat
 * when it starts within BEAT_JOIN_GAP of the previous action's start and
 * within MAX_BEAT_SPAN of the beat's first start. Long actions (see
 * isLongAction) are left out; the caller lists them as "throughout".
 */
export function buildBeats(actions: Action[], compDuration = Number.POSITIVE_INFINITY): Beat[] {
  const groups: Action[][] = [];
  let firstStart = 0;
  let lastStart = 0;
  for (const a of actions) {
    if (isLongAction(a, compDuration)) continue;
    if (groups.length > 0 && a.start - lastStart <= BEAT_JOIN_GAP && a.start - firstStart <= MAX_BEAT_SPAN) {
      groups[groups.length - 1].push(a);
      lastStart = a.start;
    } else {
      groups.push([a]);
      firstStart = a.start;
      lastStart = a.start;
    }
  }
  return groups.map((g) => {
    const start = Math.min(...g.map((a) => a.start));
    const end = Math.max(...g.map((a) => a.end));
    return { start, end, text: beatText(g), actions: g.length };
  });
}

function beatLine(b: Beat): string {
  const span = b.end - b.start < 0.05 ? `${fmtTime(b.start)} s` : `${fmtTime(b.start)}-${fmtTime(b.end)} s`;
  return `${span}: ${b.text}`;
}

export interface Concern {
  kind: string;
  severity: "warn" | "info";
  message: string;
  layers: Array<{ index: number; name: string }>;
}

const ref = (l: DescribeLayer) => ({ index: l.index, name: l.name });

function listNames(layers: DescribeLayer[], max = 6): string {
  const shown = layers.slice(0, max).map((l) => `#${l.index} "${clipName(l.name)}"`);
  const more = layers.length - shown.length;
  return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
}

/**
 * Open concerns. "Unused" is a definition made here, not an AE concept: a
 * layer that is switched off (with no audio), is no layer's track matte or
 * parent, is not picked by an effect's layer parameter, and whose name no
 * layer("...") in an expression mentions. The name scan is a heuristic and
 * layer(index) in expressions is not seen.
 */
export function findConcerns(raw: DescribeRaw): Concern[] {
  const out: Concern[] = [];
  const fps = raw.comp.frame_rate || 25;
  const dur = raw.comp.duration;
  const add = (kind: string, severity: "warn" | "info", message: string, layers: DescribeLayer[]) => {
    if (layers.length === 0) return;
    out.push({ kind, severity, message: `${message}: ${listNames(layers)}`, layers: layers.slice(0, 20).map(ref) });
  };

  const referenced = new Set<string>();
  for (const l of raw.layers) for (const n of l.expressions.refs) referenced.add(n);
  // "Unused" needs every layer read and every reference seen.
  const reasons: string[] = [];
  if (!raw.range.complete) reasons.push("only part of the comp was read");
  if (raw.range.layers_over_cap) reasons.push("the comp is too big to cross-reference every layer");
  if (raw.walk_truncated) reasons.push("the property scan was cut short (visit cap or very deeply nested groups), so some expressions were not read");
  if (raw.layers.some((l) => l.expressions.refs_truncated)) reasons.push("some expressions name more layers than were recorded");
  const complete = reasons.length === 0;

  const off = raw.layers.filter((l) => !l.enabled && !l.is_matte);
  // Video off but audio on is still heard: not "unused".
  const audible = off.filter((l) => l.audio === true);
  const silent = off.filter((l) => l.audio !== true);
  add("video_off_audio_on", "info", "Video switched off but audio on (still heard)", audible);
  const isUsed = (l: DescribeLayer) => l.is_parent || l.is_referenced === true || referenced.has(l.name);
  if (complete) {
    add("unused_layers", "warn", "Switched off, not a matte or parent, and nothing names them: no expression with layer(\"...\") and no effect layer parameter (a heuristic)", silent.filter((l) => !isUsed(l)));
    add("switched_off", "info", "Switched off but still used as a parent, named in an expression or picked by an effect", silent.filter(isUsed));
  } else {
    add("switched_off", "info", `Switched off (use is not judged: ${reasons.join("; ")})`, silent);
  }

  const solos = raw.layers.filter((l) => l.solo);
  add("solo_active", "warn", "Solo is on, so the other layers do not render", solos);

  const short = raw.layers.filter((l) => l.enabled && !["null", "camera", "light"].includes(l.role) && l.out_point - l.in_point < Math.max(3 / fps, 0.1) && l.out_point > l.in_point);
  add("very_short", "warn", "Very short (under 3 frames or 0.1 s)", short);

  const outside = raw.layers.filter((l) => l.enabled && (l.out_point <= 0 || l.in_point >= dur));
  add("outside_comp_time", "warn", `Never visible: their in/out lie outside 0-${fmtTime(dur)} s`, outside);

  add("missing_footage", "warn", "Missing footage", raw.layers.filter((l) => l.source?.missing === true));
  add("expression_errors", "warn", "Expression errors", raw.layers.filter((l) => l.expressions.errors > 0));
  return out;
}

export interface Description {
  summary: string;
  format: { width: number; height: number; pixel_aspect: number; frame_rate: number; duration: number; frames: number };
  roles: Record<string, number>;
  stack: StackRun[];
  stack_truncated?: boolean;
  beats: Beat[];
  beats_truncated?: boolean;
  /** Long actions (most of the comp) kept out of the beats. */
  throughout: string[];
  throughout_truncated?: boolean;
  summary_truncated?: boolean;
  expressions: Array<{ layer: number; name: string; count: number; props: string[]; refs: string[]; errors: number }>;
  precomps: Array<{ layer: number; name: string; comp_id: number; comp_name: string; comp_layers?: number }>;
  nesting: NestNode;
  markers: { count: number; list: Array<{ time: number; comment: string; duration?: number }>; layer_markers: Array<{ layer: number; time: number; comment: string }> };
  concerns: Concern[];
}

const MAX_STACK_RUNS = 40;
const MAX_BEATS = 50;
const MAX_THROUGHOUT = 20;

/** Turns the host's facts into the description the tool returns. Pure. */
export function describeFromRaw(raw: DescribeRaw, maxBeats = 12): Description {
  const c = raw.comp;
  const frames = Math.round(c.duration * c.frame_rate);
  const roles = roleCounts(raw.layers);
  let runs = stackRuns(raw.layers);
  const stackTruncated = runs.length > MAX_STACK_RUNS;
  if (stackTruncated) runs = runs.slice(0, MAX_STACK_RUNS);
  const actions = buildActions(raw);
  const allBeats = buildBeats(actions, c.duration);
  const beatsTruncated = allBeats.length > MAX_BEATS;
  const beats = allBeats.slice(0, MAX_BEATS);
  const longActions = actions.filter((a) => isLongAction(a, c.duration));
  const throughoutTruncated = longActions.length > MAX_THROUGHOUT;
  const throughout = longActions.slice(0, MAX_THROUGHOUT).map((a) => `"${clipName(a.name)}" ${a.verb} (${fmtTime(a.start)}-${fmtTime(a.end)} s)`);
  const concerns = findConcerns(raw);

  const expressions = raw.layers
    .filter((l) => l.expressions.count > 0)
    .map((l) => ({ layer: l.index, name: l.name, count: l.expressions.count, props: l.expressions.props, refs: l.expressions.refs, errors: l.expressions.errors }));
  const precomps = raw.layers
    .filter((l) => l.role === "precomp" && l.source?.kind === "comp" && l.source.id !== undefined)
    .map((l) => ({ layer: l.index, name: l.name, comp_id: l.source!.id as number, comp_name: l.source!.name ?? "", comp_layers: l.source!.layers }));
  const layerMarkers = raw.layers.flatMap((l) => l.markers.map((m) => ({ layer: l.index, time: m.time, comment: m.comment })));

  const lines: string[] = [];
  const pa = c.pixel_aspect !== 1 ? `, pixel aspect ${c.pixel_aspect}` : "";
  lines.push(`"${c.name}": ${c.width}x${c.height}${pa}, ${c.frame_rate} fps, ${fmtTime(c.duration)} s (${plural(frames, "frame")}), ${plural(c.num_layers, "layer")}.`);
  if (raw.layers.length > 0) lines.push(`Layers${raw.range.complete ? "" : ` ${raw.range.from}-${raw.range.to}`}: ${countsText(roles)}.`);
  if (runs.length > 0) {
    const shown = runs.slice(0, 8).map((r) => {
      const where = r.from === r.to ? `#${r.from}` : `#${r.from}-${r.to}`;
      const names = r.names.slice(0, 3).map((n) => `"${n}"`).join(", ");
      return `${where} ${r.role} (${names}${r.count > 3 ? ", ..." : ""})`;
    });
    lines.push(`Stack, top to bottom: ${shown.join("; ")}${runs.length > 8 ? `; and ${runs.length - 8} more runs` : ""}.`);
  }
  if (beats.length > 0) {
    lines.push("Timeline:");
    let used = 0;
    let shownBeats = 0;
    for (const b of beats.slice(0, maxBeats)) {
      const text = `  ${beatLine(b)}`;
      if (shownBeats > 0 && used + text.length > BEAT_TEXT_BUDGET) break;
      lines.push(text);
      used += text.length + 1;
      shownBeats++;
    }
    if (beats.length > shownBeats) lines.push(`  ... ${beats.length - shownBeats} more beats (see beats).`);
  } else if (raw.layers.length > 0 && throughout.length === 0) {
    lines.push("Timeline: no keyframed motion, sampled expression motion or layer entrances and exits found.");
  }
  if (throughout.length > 0) {
    lines.push(`Throughout (long moves, not in the beats): ${throughout.slice(0, 5).join("; ")}${throughout.length > 5 ? `; and ${throughout.length - 5} more` : ""}.`);
  }
  if (expressions.length > 0) {
    const total = expressions.reduce((s, e) => s + e.count, 0);
    const names = expressions.slice(0, 5).map((e) => `"${e.name}" (${e.count})`).join(", ");
    lines.push(`Expressions: ${plural(total, "property", "properties")} on ${plural(expressions.length, "layer")}: ${names}${expressions.length > 5 ? ", ..." : ""}. Expression-driven motion is sampled at a few times (not read from keys): it shows as "moves (expression)" and can miss quick changes.`);
  }
  if (precomps.length > 0) {
    const names = precomps.slice(0, 5).map((p) => `"${p.name}" -> "${p.comp_name}"`).join(", ");
    lines.push(`Precomps: ${precomps.length}: ${names}${precomps.length > 5 ? ", ..." : ""}.`);
  }
  const nested = (raw.nesting.children ?? []).filter((n) => (n.children ?? []).length > 0);
  if (nested.length > 0) {
    lines.push(`Nesting goes deeper in: ${nested.slice(0, 4).map((n) => `"${n.name}" (${(n.children ?? []).map((k) => `"${k.name}"`).slice(0, 3).join(", ")})`).join("; ")}.`);
  }
  if (raw.markers.count > 0 || layerMarkers.length > 0) {
    const first = raw.markers.list.slice(0, 3).map((m) => `${fmtTime(m.time)} s${m.comment ? ` "${m.comment}"` : ""}`).join(", ");
    const lm = layerMarkers.length > 0 ? `; ${plural(layerMarkers.length, "layer marker")}` : "";
    lines.push(`Markers: ${plural(raw.markers.count, "comp marker")}${first ? ` (${first}${raw.markers.count > 3 ? ", ..." : ""})` : ""}${lm}.`);
  }
  if (concerns.length > 0) {
    lines.push("Concerns:");
    for (const k of concerns) lines.push(`  ${k.severity === "warn" ? "!" : "-"} ${k.message}`);
  }
  const notes: string[] = [];
  if (!raw.range.complete) {
    notes.push(`Only layers ${raw.range.from}-${raw.range.to} of ${c.num_layers} were read${raw.range.next_from_layer ? `; continue with from_layer ${raw.range.next_from_layer}` : ""}.`);
  }
  if (raw.range.layers_over_cap) notes.push("The comp has more than 2000 layers; parent and matte links are only known for the first 2000.");
  if (raw.samples_truncated) notes.push("The sampling budget ran out; some overshoot and expression-motion checks were skipped.");
  if (beatsTruncated) notes.push(`More than ${MAX_BEATS} beats; the rest are left out.`);
  if (raw.segments_truncated) notes.push("Some keyframed motion was left out (per-layer or total segment cap), so the timeline may be incomplete.");
  if (raw.walk_truncated) notes.push("The property scan was cut short (visit cap or very deeply nested groups); some animation and expressions may be missing.");
  if (notes.length > 0) lines.push(...notes);
  let summaryText = lines.join("\n");
  let summaryTruncated = false;
  if (summaryText.length > MAX_SUMMARY) {
    summaryText = `${summaryText.slice(0, MAX_SUMMARY - 60)}\n... summary cut at the length limit.`;
    summaryTruncated = true;
  }

  return {
    summary: summaryText,
    format: { width: c.width, height: c.height, pixel_aspect: c.pixel_aspect, frame_rate: c.frame_rate, duration: c.duration, frames },
    roles,
    stack: runs,
    ...(stackTruncated ? { stack_truncated: true } : {}),
    beats,
    ...(beatsTruncated ? { beats_truncated: true } : {}),
    throughout,
    ...(throughoutTruncated ? { throughout_truncated: true } : {}),
    ...(summaryTruncated ? { summary_truncated: true } : {}),
    expressions,
    precomps,
    nesting: raw.nesting,
    markers: { count: raw.markers.count, list: raw.markers.list, layer_markers: layerMarkers.slice(0, 200) },
    concerns,
  };
}

// ---------- Gantt chart ----------

const ROLE_COLORS: Record<string, Rgba> = {
  text: [90, 160, 235, 255],
  shape: [120, 200, 120, 255],
  solid: [190, 150, 90, 255],
  footage: [170, 120, 200, 255],
  precomp: [230, 130, 150, 255],
  model_3d: [110, 190, 200, 255],
  parametric_mesh: [110, 170, 220, 255],
  adjustment: [200, 200, 100, 255],
  null: [150, 150, 150, 255],
  camera: [100, 190, 190, 255],
  light: [240, 190, 80, 255],
  audio: [110, 140, 110, 255],
};

const MAX_GANTT_ROWS = 150;
const TICK_STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

/** Upper case, and only characters the tiny bitmap font has. */
function glyphSafe(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9 .:\-#_/?]/g, " ");
}

export interface GanttInfo {
  width: number;
  height: number;
  rows: number;
  rows_truncated: boolean;
}

/** Draws the timeline: a bar per layer (by role), keyframe ticks, comp markers in red, layer markers as dots. */
export function drawGantt(raw: DescribeRaw): { png: PNG; info: GanttInfo } {
  const layers = raw.layers.slice(0, MAX_GANTT_ROWS);
  const scale = layers.length <= 40 ? 2 : 1;
  const rowH = scale === 2 ? 20 : 11;
  const labelChars = scale === 2 ? 24 : 44;
  const labelW = labelChars * 6 * scale + 8;
  const chartW = 1100;
  const headerH = 30;
  const width = labelW + chartW + 20;
  const height = headerH + layers.length * rowH + 10;
  const dur = Math.max(raw.comp.duration, 0.001);
  const xOf = (t: number) => labelW + Math.round((Math.min(Math.max(t, 0), dur) / dur) * chartW);

  const png = createCanvas(width, height, [24, 24, 28, 255]);
  const ink: Rgba = [225, 225, 225, 255];
  const dim: Rgba = [110, 110, 120, 255];

  // Time ruler with a tick at a round step.
  const step = TICK_STEPS.find((s) => s >= dur / 10) ?? TICK_STEPS[TICK_STEPS.length - 1];
  drawText(png, "SECONDS", 6, 4, 1, dim);
  for (let t = 0; t <= dur + 1e-6; t += step) {
    const x = xOf(t);
    fillRect(png, x, headerH - 8, 1, 8 + layers.length * rowH + 4, [60, 60, 68, 255]);
    const label = String(Math.round(t * 100) / 100);
    drawText(png, label, x + 3, 14, 1, ink);
  }

  const segByLayer = new Map<number, number[]>();
  for (const s of raw.segments) {
    const list = segByLayer.get(s.layer) ?? [];
    list.push(s.start, s.end);
    segByLayer.set(s.layer, list);
  }

  layers.forEach((l, i) => {
    const y = headerH + i * rowH;
    if (i % 2 === 1) fillRect(png, 0, y, width, rowH, [255, 255, 255, 10]);
    drawText(png, glyphSafe(`${l.index} ${l.name}`).slice(0, labelChars), 6, y + Math.floor((rowH - 7 * scale) / 2), scale, l.enabled ? ink : dim);
    const color = ROLE_COLORS[l.role] ?? [150, 150, 150, 255];
    const x0 = xOf(l.in_point);
    const x1 = Math.max(x0 + 2, xOf(l.out_point));
    const barY = y + 2;
    const barH = rowH - 4;
    if (l.enabled) {
      fillRect(png, x0, barY, x1 - x0, barH, color);
    } else {
      // Switched-off layers: dim fill and an outline.
      fillRect(png, x0, barY, x1 - x0, barH, [color[0], color[1], color[2], 70]);
      strokeRect(png, x0, barY, x1 - x0, barH, 1, color);
    }
    const times = segByLayer.get(l.index) ?? [];
    for (const t of times) {
      const x = xOf(t);
      if (x >= x0 && x <= x1) fillRect(png, x, barY, 1, barH, [20, 20, 24, 255]);
    }
    for (const m of l.markers) fillRect(png, xOf(m.time) - 1, y, 3, 3, [255, 235, 90, 255]);
  });

  for (const m of raw.markers.list) {
    const x = xOf(m.time);
    drawLine(png, x, headerH - 8, x, height - 6, 1, [235, 70, 70, 255]);
  }
  return { png, info: { width, height, rows: layers.length, rows_truncated: raw.layers.length > layers.length } };
}

// ---------- tool ----------

export const describeTools: ToolDefinition<any>[] = [
  {
    name: "ae_describe_comp",
    description:
      "Read a plain-language map of a comp that takes ten seconds to read, before you edit it or to check you understood a file: " +
      "format and length, the layers by role (text, shape, solid, footage, precomp, model_3d, parametric_mesh, adjustment, null, camera, light, audio) and the stack as runs of a role, " +
      "a beat-by-beat timeline built from keyframes (e.g. '0.5-2.0 s: \"Logo\" scales up with overshoot'), which layers carry expressions, which precomps nest where, the comp and layer markers, and open concerns " +
      "(unused, very short, never visible, missing footage, expression errors, solo on). " +
      "Roles come from layer flags and sources, not from AE's class names. Beats cluster keyframe segments by time and use simple wording rules: they are a reading aid, not AE's own data. " +
      "Overshoot is found by sampling between keys (not for position paths) and judged with the same rule as ae_motion_review. Moves that run most of the comp are listed under 'throughout', not as beats. " +
      "Expression-driven motion (wiggle, loopOut, rigs) is sampled at a few times and shows as 'moves (expression)'; quick changes between samples can be missed. " +
      "'Unused' is a definition made here (switched off with no audio, no matte, no parent, not picked by an effect's layer parameter, and no expression names it with layer(\"...\")); it is only judged when the whole comp was read and every expression was scanned. " +
      "Pages big comps (from_layer, max_layers up to 500). With gantt:true it also draws the timeline as a PNG and returns its path. " +
      "Smaller than ae_get_comp + ae_comp_tree + ae_get_markers together; use those for exact values. Read-only: changes no time, selection or setting.",
    schema: AeDescribeCompSchema,
    handler: async (args: AeDescribeCompArgs, ctx) => {
      const res = await ctx.bridge.callHost<DescribeRaw>(
        "describeRead",
        { comp_id: args.comp_id, from_layer: args.from_layer, max_layers: args.max_layers },
        { label: `ae_describe_comp(${args.comp_id})`, mutates: false, toolName: "ae_describe_comp" }
      );
      const raw = res.result;
      const desc = describeFromRaw(raw, args.max_beats ?? 12);
      const out: Record<string, unknown> = {
        ok: true,
        read_only: true,
        comp: raw.comp,
        range: raw.range,
        ...desc,
        truncated:
          raw.segments_truncated ||
          raw.walk_truncated ||
          raw.markers.truncated ||
          raw.nesting_truncated ||
          raw.range.layers_over_cap ||
          raw.samples_truncated === true ||
          desc.stack_truncated === true ||
          desc.beats_truncated === true ||
          desc.throughout_truncated === true ||
          desc.summary_truncated === true,
      };
      if (args.include_layers) {
        out.layers = raw.layers.map((l) => ({
          index: l.index,
          id: l.id,
          name: l.name,
          role: l.role,
          enabled: l.enabled,
          in: l.in_point,
          out: l.out_point,
          parent: l.parent,
          matte: l.matte,
          ...(l.text !== undefined ? { text: l.text } : {}),
          ...(l.source ? { source: l.source } : {}),
          ...(l.shy ? { shy: true } : {}),
          ...(l.guide ? { guide: true } : {}),
          ...(l.solo ? { solo: true } : {}),
          ...(l.three_d ? { three_d: true } : {}),
          ...(l.is_parent ? { is_parent: true } : {}),
          ...(l.is_matte ? { is_matte: true } : {}),
        }));
      }
      if (args.gantt) {
        try {
          const { png, info } = drawGantt(raw);
          const dir = defaultFramesDir();
          fs.mkdirSync(dir, { recursive: true });
          const file = path.join(dir, `describe_c${raw.comp.id}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.png`);
          fs.writeFileSync(file, encodePng(png));
          out.gantt = { path: file, ...info };
          if (info.rows_truncated) out.truncated = true;
        } catch (e) {
          // The facts are good; only the picture failed.
          out.gantt_error = e instanceof Error ? e.message : String(e);
        }
      }
      return out;
    },
  },
];
