/**
 * server/src/tools/ext/learntaste.ts
 *
 * Learning the user's taste from what they change after the agent finishes:
 * - ae_taste_baseline: after the agent's work, keeps a compact snapshot of the
 *   comp (layer timing, transform values and keys with their temporal ease,
 *   text size and colour) in learn-taste.json next to settings.json.
 * - ae_learn_taste: reads the comp again, diffs it against that baseline,
 *   classifies the edits (ease influence, durations, timing, margins, font
 *   size, colour, overshoot) and proposes rules with a confidence level. It
 *   hands back a ready-made ae_ask_user question and saves nothing.
 * - ae_taste_rules: lists the proposals and the saved rules, saves the ones the
 *   user confirmed (into settings.json, taste.rules, and for an ease or
 *   overshoot rule the existing preferred_ease / avoid_overshoot), or forgets.
 *
 * What this cannot know: After Effects does not say who made a change. A
 * diff mixes the user's edits with other tools, expressions (only stored
 * values are read) and an undo of the agent's own write, so nothing is saved
 * without the user's yes, and a rule needs several edits, and for "high"
 * several reviews, before it is called more than "low". Project.revision
 * (documented, behaviour unmeasured) is used only as a hint that the project
 * was reopened or reverted.
 *
 * Nothing here changes After Effects: the only host call is the read-only
 * learntasteRead, so there is no target guard, undo group or checkpoint. The
 * two files it writes are the MCP's own (learn-taste.json, settings.json).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { normalizeGuardPath } from "../../jsx.js";
import {
  MAX_TASTE_RULES,
  type TasteConfidence,
  type TasteRule,
  type TasteRuleKind,
} from "../../settings.js";
import { getSessionTracker } from "./session.js";
import { dataDirOf, LayerSelectorSchema, type ToolContext, type ToolDefinition } from "../common.js";

// ---------- snapshot shape (what learntasteRead returns) ----------

export type Vec = number | number[] | null;

export interface SnapKey {
  t: number | null;
  v: Vec;
  /** Temporal ease in and out, one entry per dimension: speed and influence. */
  inE: Array<{ s: number | null; i: number | null }>;
  outE: Array<{ s: number | null; i: number | null }>;
  inT: string;
  outT: string;
}

export interface SnapProp {
  kind: string;
  value: Vec;
  keys: SnapKey[];
  expr?: boolean;
  truncated?: boolean;
  /** Dimensions are separated: the host reads no value or keys (a value would follow the playhead). */
  separated?: boolean;
}

export interface SnapLayer {
  id: number;
  index: number;
  name: string;
  kind: string;
  inPoint: number;
  outPoint: number;
  startTime: number;
  props: Record<string, SnapProp>;
  /** Has a parent layer: its position is in the parent's space, not the comp's. */
  parented?: boolean;
  threeD?: boolean;
  text: { fontSize: number | null; fillColor: number[] | null; text: string } | null;
}

export interface TasteSnapshot {
  project_path: string;
  revision: number | null;
  comp_id: number;
  name: string;
  width: number;
  height: number;
  fps: number | null;
  duration: number | null;
  numLayers: number;
  truncated: boolean;
  layers: SnapLayer[];
  /** Only on a read that named layers by id: the ids that matched no layer (deleted). */
  missing?: number[];
}

// ---------- pure logic: diffing ----------

export type ObservationKind =
  | "ease_out_influence"
  | "ease_in_influence"
  | "interp_changed"
  | "layer_duration"
  | "start_offset"
  | "animation_timing"
  | "animation_offset"
  | "keys_added"
  | "keys_removed"
  | "overshoot_removed"
  | "overshoot_added"
  | "edge_margin"
  | "position_nudge"
  | "font_size"
  | "fill_color"
  | "value_changed"
  | "layer_removed"
  | "layer_added";

export interface Observation {
  kind: ObservationKind;
  layer_id: number;
  layer_name: string;
  layer_kind: string;
  prop?: string;
  before: unknown;
  after: unknown;
  /** after / before for the kinds that are a scale (duration, timing, font size). */
  ratio?: number;
  detail: string;
}

export interface TasteDiff {
  observations: Observation[];
  compared_layers: number;
  /** Counts by kind, for the one-line summary. */
  counts: Record<string, number>;
}

const round = (n: number, places = 3) => Math.round(n * 10 ** places) / 10 ** places;

export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Half a frame: AE snaps times to frames, so anything smaller is not an edit. */
function timeEps(fps: number | null | undefined): number {
  return fps && fps > 0 ? 0.5 / fps : 0.02;
}

function numsDiffer(a: Vec, b: Vec): boolean {
  if (a === null || b === null) return a !== b;
  const x = Array.isArray(a) ? a : [a];
  const y = Array.isArray(b) ? b : [b];
  if (x.length !== y.length) return true;
  return x.some((v, i) => Math.abs(v - y[i]) > Math.max(1e-3, 1e-3 * Math.abs(v)));
}

function dim(v: Vec, i: number): number | null {
  if (v === null) return null;
  const x = Array.isArray(v) ? v[i] : i === 0 ? v : undefined;
  return typeof x === "number" ? x : null;
}

/**
 * Whether any move in a run of keys goes past its target and settles back (a bounce or overshoot), in any
 * dimension. Judged per move: key i is an overshoot when the segment into it and the segment out of it
 * run in opposite directions, the way back is between 2% and 50% of the way in, and the animation then
 * rests there or keeps settling (the next move goes the original way and is no longer than the way back).
 * A move in and back out (0 -> 500 -> 100) is not an overshoot. Needs three keys.
 */
export function hasOvershoot(keys: SnapKey[]): boolean {
  if (keys.length < 3) return false;
  let dims = 1;
  for (const k of keys) if (Array.isArray(k.v)) dims = Math.max(dims, k.v.length);
  for (let d = 0; d < dims; d++) {
    const v = keys.map((k) => dim(k.v, d));
    for (let i = 1; i < keys.length - 1; i++) {
      const p = v[i - 1];
      const c = v[i];
      const n = v[i + 1];
      if (p === null || c === null || n === null) continue;
      const into = c - p;
      const back = n - c;
      if (Math.abs(into) < 1e-6 || into * back >= 0) continue;
      const share = Math.abs(back) / Math.abs(into);
      if (share < 0.02 || share > 0.5) continue;
      if (i + 2 >= keys.length) return true;
      const after = v[i + 2];
      if (after === null) continue;
      const next = after - n;
      const rests = Math.abs(next) < 0.02 * Math.abs(into);
      const settling = next * into > 0 && Math.abs(next) <= Math.abs(back);
      if (rests || settling) return true;
    }
  }
  return false;
}

/** Distance from the nearest comp edge as a share of the short side; null when the point is off the comp. */
export function marginShare(pos: Vec, width: number, height: number): number | null {
  const x = dim(pos, 0);
  const y = dim(pos, 1);
  if (x === null || y === null || width <= 0 || height <= 0) return null;
  if (x < 0 || y < 0 || x > width || y > height) return null;
  return Math.min(x, width - x, y, height - y) / Math.min(width, height);
}

/** Where the layer's position rests; with separated dimensions, from the X and Y follower properties. */
function restPosition(props: Record<string, SnapProp>): Vec {
  const p = props.position;
  if (p && !p.separated) return restValue(p);
  if (p && p.separated) {
    const x = restValue(props.position_x);
    const y = restValue(props.position_y);
    if (typeof x === "number" && typeof y === "number") return [x, y];
  }
  return null;
}

/** Where a property rests: its static value, or its last key. */
function restValue(p: SnapProp | undefined): Vec {
  if (!p || p.separated) return null;
  if (p.keys.length > 0) return p.keys[p.keys.length - 1].v;
  return p.value;
}

function push(out: Observation[], layer: SnapLayer, o: Omit<Observation, "layer_id" | "layer_name" | "layer_kind">): void {
  out.push({ layer_id: layer.id, layer_name: layer.name, layer_kind: layer.kind, ...o });
}

function diffEase(out: Observation[], layer: SnapLayer, name: string, b: SnapProp, n: SnapProp): void {
  for (let k = 0; k < b.keys.length; k++) {
    const bk = b.keys[k];
    const nk = n.keys[k];
    if (bk.inT !== nk.inT || bk.outT !== nk.outT) {
      push(out, layer, {
        kind: "interp_changed",
        prop: name,
        before: { in: bk.inT, out: bk.outT },
        after: { in: nk.inT, out: nk.outT },
        detail: `key ${k + 1} of ${name}: interpolation ${bk.inT}/${bk.outT} -> ${nk.inT}/${nk.outT}`,
      });
    }
    // Influence only means something on a bezier side. A side that went from linear (or hold) to bezier
    // is an ease the user added ("the agent's ease was too linear"): its new influence counts, and the
    // old one is null (AE reports about 16.67% for a linear side, which means nothing).
    // The incoming side of the first key and the outgoing side of the last key have no segment: they do
    // nothing to the motion (select-all + Easy Ease changes them anyway), so they are not samples.
    const sides = [
      { kind: "ease_out_influence" as const, label: "outgoing", bT: bk.outT, nT: nk.outT, b: bk.outE[0]?.i, n: nk.outE[0]?.i, live: k < b.keys.length - 1 },
      { kind: "ease_in_influence" as const, label: "incoming", bT: bk.inT, nT: nk.inT, b: bk.inE[0]?.i, n: nk.inE[0]?.i, live: k > 0 },
    ];
    for (const side of sides) {
      if (!side.live) continue;
      if (side.nT !== "bezier" || typeof side.n !== "number") continue;
      if (side.bT === "bezier") {
        if (typeof side.b !== "number" || Math.abs(side.n - side.b) <= 1) continue;
        push(out, layer, {
          kind: side.kind,
          prop: name,
          before: side.b,
          after: side.n,
          detail: `key ${k + 1} of ${name}: ${side.label} influence ${round(side.b, 1)}% -> ${round(side.n, 1)}%`,
        });
      } else {
        push(out, layer, {
          kind: side.kind,
          prop: name,
          before: null,
          after: side.n,
          detail: `key ${k + 1} of ${name}: ${side.label} side went from ${side.bT} to bezier, influence ${round(side.n, 1)}%`,
        });
      }
    }
  }
}

/** How many changed key values one observation lists; the detail line carries the full count. */
const MAX_LISTED_VALUES = 20;

function diffKeyed(out: Observation[], layer: SnapLayer, name: string, b: SnapProp, n: SnapProp, eps: number): void {
  if (hasOvershoot(b.keys) !== hasOvershoot(n.keys)) {
    const removed = hasOvershoot(b.keys);
    push(out, layer, {
      kind: removed ? "overshoot_removed" : "overshoot_added",
      prop: name,
      before: removed,
      after: !removed,
      detail: removed ? `${name}: the overshoot past the last value is gone` : `${name}: an overshoot past the last value was added`,
    });
  }
  if (b.keys.length !== n.keys.length) {
    const grew = n.keys.length > b.keys.length;
    push(out, layer, {
      kind: grew ? "keys_added" : "keys_removed",
      prop: name,
      before: b.keys.length,
      after: n.keys.length,
      detail: `${name}: ${b.keys.length} keys -> ${n.keys.length}`,
    });
    return;
  }
  const bt = b.keys.map((k) => k.t);
  const nt = n.keys.map((k) => k.t);
  const bFirst = bt[0];
  const bLast = bt[bt.length - 1];
  const nFirst = nt[0];
  const nLast = nt[nt.length - 1];
  if (typeof bFirst === "number" && typeof bLast === "number" && typeof nFirst === "number" && typeof nLast === "number") {
    const bSpan = bLast - bFirst;
    const nSpan = nLast - nFirst;
    let respaced = false;
    if (b.keys.length >= 2 && bSpan > eps && Math.abs(nSpan - bSpan) > eps && Math.abs(nSpan / bSpan - 1) > 0.02) {
      respaced = true;
      push(out, layer, {
        kind: "animation_timing",
        prop: name,
        before: round(bSpan),
        after: round(nSpan),
        ratio: round(nSpan / bSpan),
        detail: `${name}: the animation lasts ${round(bSpan)} s -> ${round(nSpan)} s`,
      });
    }
    if (!respaced && Math.abs(nFirst - bFirst) > eps) {
      push(out, layer, {
        kind: "animation_offset",
        prop: name,
        before: bFirst,
        after: nFirst,
        detail: `${name}: the animation starts ${round(nFirst - bFirst)} s ${nFirst > bFirst ? "later" : "earlier"}`,
      });
    }
  }
  diffEase(out, layer, name, b, n);
  const changed: number[] = [];
  for (let k = 0; k < b.keys.length; k++) if (numsDiffer(b.keys[k].v, n.keys[k].v)) changed.push(k);
  if (changed.length > 0) {
    const kind: ObservationKind = name === "position" || name === "position_x" || name === "position_y" ? "position_nudge" : "value_changed";
    push(out, layer, {
      kind,
      prop: name,
      before: changed.slice(0, MAX_LISTED_VALUES).map((k) => b.keys[k].v),
      after: changed.slice(0, MAX_LISTED_VALUES).map((k) => n.keys[k].v),
      detail: `${name}: ${changed.length} of ${b.keys.length} key values changed`,
    });
  }
}

function diffLayer(out: Observation[], b: SnapLayer, n: SnapLayer, comp: TasteSnapshot, eps: number): void {
  const bLen = b.outPoint - b.inPoint;
  const nLen = n.outPoint - n.inPoint;
  if (bLen > eps && Math.abs(nLen - bLen) > eps) {
    push(out, n, {
      kind: "layer_duration",
      before: round(bLen),
      after: round(nLen),
      ratio: round(nLen / bLen),
      detail: `layer length ${round(bLen)} s -> ${round(nLen)} s`,
    });
  }
  if (Math.abs(n.inPoint - b.inPoint) > eps) {
    push(out, n, {
      kind: "start_offset",
      before: b.inPoint,
      after: n.inPoint,
      detail: `layer starts ${round(n.inPoint - b.inPoint)} s ${n.inPoint > b.inPoint ? "later" : "earlier"}`,
    });
  }
  for (const name of Object.keys(b.props)) {
    const bp = b.props[name];
    const np = n.props[name];
    if (!np) continue;
    // Separated dimensions carry no value or keys; a truncated key list cannot be matched key by key.
    if (bp.separated || np.separated || bp.truncated || np.truncated) continue;
    if (bp.keys.length > 0 && np.keys.length > 0) {
      diffKeyed(out, n, name, bp, np, eps);
    } else if (bp.keys.length !== np.keys.length) {
      // Animation added to, or taken off, a static property.
      const grew = np.keys.length > 0;
      push(out, n, {
        kind: grew ? "keys_added" : "keys_removed",
        prop: name,
        before: bp.keys.length,
        after: np.keys.length,
        detail: `${name}: ${bp.keys.length} keys -> ${np.keys.length}`,
      });
    } else if (!bp.expr && !np.expr && numsDiffer(bp.value, np.value)) {
      push(out, n, {
        kind: name === "position" || name === "position_x" || name === "position_y" ? "position_nudge" : "value_changed",
        prop: name,
        before: bp.value,
        after: np.value,
        detail: `${name}: ${JSON.stringify(bp.value)} -> ${JSON.stringify(np.value)}`,
      });
    }
  }
  // A title's distance from the comp edge, from where its position rests.
  // A parented or 3D layer's position is not in comp space, so a margin from it means nothing.
  if (n.kind === "text" && !n.parented && !b.parented && !n.threeD && !b.threeD) {
    const bRest = restPosition(b.props);
    const nRest = restPosition(n.props);
    if (bRest !== null && nRest !== null && numsDiffer(bRest, nRest)) {
      const mb = marginShare(bRest, comp.width, comp.height);
      const mn = marginShare(nRest, comp.width, comp.height);
      if (mb !== null && mn !== null && Math.abs(mn - mb) > 0.005) {
        push(out, n, {
          kind: "edge_margin",
          prop: "position",
          before: round(mb),
          after: round(mn),
          detail: `distance from the nearest edge ${round(mb * 100, 1)}% -> ${round(mn * 100, 1)}% of the short side (from the layer's position, not its bounds)`,
        });
      }
    }
  }
  if (b.text && n.text) {
    if (b.text.fontSize && n.text.fontSize && Math.abs(n.text.fontSize / b.text.fontSize - 1) > 0.01) {
      push(out, n, {
        kind: "font_size",
        before: b.text.fontSize,
        after: n.text.fontSize,
        ratio: round(n.text.fontSize / b.text.fontSize),
        detail: `font size ${b.text.fontSize} -> ${n.text.fontSize}`,
      });
    }
    if (b.text.fillColor && n.text.fillColor && b.text.fillColor.some((c, i) => Math.abs(c - (n.text!.fillColor as number[])[i]) > 0.01)) {
      push(out, n, {
        kind: "fill_color",
        before: b.text.fillColor,
        after: n.text.fillColor,
        detail: `fill colour ${hex(b.text.fillColor)} -> ${hex(n.text.fillColor)}`,
      });
    }
  }
}

export function hex(c: number[]): string {
  const h = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, "0");
  return `#${h(c[0] ?? 0)}${h(c[1] ?? 0)}${h(c[2] ?? 0)}`;
}

/**
 * What differs between the baseline and the comp now, matched by layer id.
 * `trackedIds` limits the diff to the layers the baseline was taken for; a
 * layer in it that is gone is reported as removed (not when the live read was
 * capped, since it may just be past the cap).
 */
export function diffTasteSnapshots(before: TasteSnapshot, now: TasteSnapshot, trackedIds: number[] | null = null): TasteDiff {
  const out: Observation[] = [];
  const eps = timeEps(now.fps ?? before.fps);
  const tracked = trackedIds ? new Set(trackedIds) : null;
  const nowById = new Map(now.layers.map((l) => [l.id, l]));
  const beforeIds = new Set(before.layers.map((l) => l.id));
  let compared = 0;
  for (const b of before.layers) {
    if (tracked && !tracked.has(b.id)) continue;
    const n = nowById.get(b.id);
    if (!n) {
      // A read that named layers by id lists the ones it did not find; otherwise absence only counts when the read was not capped.
      const gone = now.missing ? now.missing.includes(b.id) : !now.truncated;
      if (gone) {
        push(out, b, { kind: "layer_removed", before: b.name, after: null, detail: `layer "${b.name}" was deleted` });
      }
      continue;
    }
    compared += 1;
    diffLayer(out, b, n, now, eps);
  }
  if (!tracked && !before.truncated && !now.truncated) {
    for (const n of now.layers) {
      if (!beforeIds.has(n.id)) push(out, n, { kind: "layer_added", before: null, after: n.name, detail: `layer "${n.name}" was added` });
    }
  }
  const counts: Record<string, number> = {};
  for (const o of out) counts[o.kind] = (counts[o.kind] ?? 0) + 1;
  return { observations: out, compared_layers: compared, counts };
}

// ---------- pure logic: samples, confidence, rules ----------

/** One measured edit: a ratio, a [before, after] pair, a colour or 1. */
export type Sample = number | Array<number | null>;

export const SERIES = [
  "ease_out",
  "ease_in",
  "overshoot_removed",
  "overshoot_added",
  "layer_duration",
  "animation_timing",
  "edge_margin",
  "font_size",
  "fill_color",
] as const;
export type SeriesName = (typeof SERIES)[number];

/** The sample series each proposed rule rests on, so forgetting a rule can clear its evidence. */
export const RULE_SERIES: Record<string, SeriesName[]> = {
  ease_influence: ["ease_out", "ease_in"],
  overshoot: ["overshoot_removed", "overshoot_added"],
  layer_duration: ["layer_duration"],
  animation_timing: ["animation_timing"],
  edge_margin: ["edge_margin"],
  font_size: ["font_size"],
  fill_color: ["fill_color"],
};

const MAX_SAMPLES_PER_SERIES = 200;

/** The numbers a diff yields for each series. */
export function samplesFromObservations(obs: Observation[]): Partial<Record<SeriesName, Sample[]>> {
  const s: Partial<Record<SeriesName, Sample[]>> = {};
  const add = (name: SeriesName, v: Sample) => {
    (s[name] ??= []).push(v);
  };
  for (const o of obs) {
    if (o.kind === "ease_out_influence") add("ease_out", [o.before as number | null, o.after as number]);
    else if (o.kind === "ease_in_influence") add("ease_in", [o.before as number | null, o.after as number]);
    else if (o.kind === "overshoot_removed") add("overshoot_removed", 1);
    else if (o.kind === "overshoot_added") add("overshoot_added", 1);
    else if (o.kind === "layer_duration" && o.ratio !== undefined) add("layer_duration", o.ratio);
    else if (o.kind === "animation_timing" && o.ratio !== undefined) add("animation_timing", o.ratio);
    else if (o.kind === "edge_margin") add("edge_margin", [o.before as number, o.after as number]);
    else if (o.kind === "font_size" && o.ratio !== undefined) add("font_size", o.ratio);
    else if (o.kind === "fill_color") add("fill_color", o.after as number[]);
  }
  return s;
}

/**
 * How far to trust a rule. Needs several edits that agree; "high" also needs
 * them from more than one review, since one session's edits may all answer
 * the same piece. Anything under two edits is "low".
 */
export function confidenceOf(samples: number, consistency: number, reviews: number): TasteConfidence {
  if (samples < 2 || consistency < 0.6) return "low";
  if (samples >= 6 && consistency >= 0.8 && reviews >= 2) return "high";
  if (samples >= 3 && consistency >= 0.7) return "medium";
  return "low";
}

export interface ProposedRule {
  id: string;
  kind: TasteRuleKind;
  text: string;
  value: number | number[] | null;
  confidence: TasteConfidence;
  samples: number;
  reviews: number;
  /** Share of the samples that agree with the rule's value. */
  consistency: number;
}

/** Share of values within `tol` of `target`. */
function shareWithin(values: number[], target: number, tol: number): number {
  if (values.length === 0) return 0;
  return values.filter((v) => Math.abs(v - target) <= tol).length / values.length;
}

const pct = (x: number) => Math.round(x * 100);
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const pairs = (list: Sample[] | undefined) => (list ?? []).filter((s): s is number[] => Array.isArray(s) && s.length >= 2 && s.every((v) => typeof v === "number"));
/** Ease samples: [influence before or null (the side was not bezier), influence after]. */
const easePairs = (list: Sample[] | undefined) =>
  (list ?? []).filter((s): s is [number | null, number] => Array.isArray(s) && s.length >= 2 && typeof s[1] === "number" && (s[0] === null || typeof s[0] === "number"));
/** What the agent used, as text: a percentage from the bezier sides, or linear keys when none were bezier. */
function agentUsed(list: Array<[number | null, number]>): string {
  const was = list.map((p) => p[0]).filter((v): v is number => typeof v === "number");
  if (was.length === 0) return "the agent used linear keys";
  return `the agent used about ${Math.round(median(was))}%`;
}
const numbers = (list: Sample[] | undefined) => (list ?? []).filter((s): s is number => typeof s === "number");

/**
 * Turns the samples gathered so far into proposed rules. `reviews` is how
 * many separate reviews contributed to each series.
 */
export function buildRules(series: Partial<Record<SeriesName, Sample[]>>, reviews: Partial<Record<SeriesName, number>>): ProposedRule[] {
  const rules: ProposedRule[] = [];
  const rev = (...names: SeriesName[]) => Math.max(0, ...names.map((n) => reviews[n] ?? 0));

  // Ease influence: where the user puts the outgoing and incoming handles.
  const outs = easePairs(series.ease_out);
  const ins = easePairs(series.ease_in);
  if (outs.length > 0 || ins.length > 0) {
    const outMed = outs.length ? median(outs.map((p) => p[1])) : NaN;
    const inMed = ins.length ? median(ins.map((p) => p[1])) : NaN;
    const shares: number[] = [];
    if (outs.length) shares.push(shareWithin(outs.map((p) => p[1]), outMed, 15));
    if (ins.length) shares.push(shareWithin(ins.map((p) => p[1]), inMed, 15));
    const consistency = Math.min(...shares);
    const n = Math.max(outs.length, ins.length);
    const parts: string[] = [];
    if (outs.length) parts.push(`outgoing influence about ${Math.round(outMed)}% (${agentUsed(outs)})`);
    if (ins.length) parts.push(`incoming influence about ${Math.round(inMed)}% (${agentUsed(ins)})`);
    let value: number | number[];
    let text = `The user sets ${parts.join(" and ")} on their keyframes.`;
    if (outs.length && ins.length) {
      const curve = [round(clamp(outMed / 100, 0.001, 1)), 0, round(clamp(1 - inMed / 100, 0, 0.999)), 1];
      value = curve;
      text += ` As a cubic-bezier: [${curve.join(", ")}].`;
    } else {
      value = outs.length ? outMed : inMed;
    }
    rules.push({
      id: "ease_influence",
      kind: "ease_influence",
      text,
      value,
      confidence: confidenceOf(n, consistency, rev("ease_out", "ease_in")),
      samples: n,
      reviews: rev("ease_out", "ease_in"),
      consistency: round(consistency, 2),
    });
  }

  // Overshoot: removed more often than added means the user does not want it.
  const removed = numbers(series.overshoot_removed).length;
  const added = numbers(series.overshoot_added).length;
  if (removed > 0 && removed > added) {
    const total = removed + added;
    const consistency = removed / total;
    rules.push({
      id: "overshoot",
      kind: "overshoot",
      text: `The user removes overshoot (animations that travel past their last value): ${removed} of ${total} changes took it out.`,
      value: null,
      confidence: confidenceOf(total, consistency, rev("overshoot_removed", "overshoot_added")),
      samples: total,
      reviews: rev("overshoot_removed", "overshoot_added"),
      consistency: round(consistency, 2),
    });
  }

  const ratioRule = (id: "layer_duration" | "animation_timing" | "font_size", name: SeriesName, noun: string, unit: string) => {
    const ratios = numbers(series[name]);
    if (ratios.length === 0) return;
    const med = median(ratios);
    if (Math.abs(med - 1) < 0.05) return;
    const consistency = shareWithin(ratios, med, 0.1);
    const dir = med < 1 ? "smaller" : "larger";
    let text: string;
    if (id === "font_size") text = `The user makes text ${dir}: to about ${pct(med)}% of the size the agent set.`;
    else text = `The user makes ${noun} ${med < 1 ? "shorter" : "longer"}: to about ${pct(med)}% of ${unit} the agent set.`;
    rules.push({
      id,
      kind: id,
      text,
      value: round(med),
      confidence: confidenceOf(ratios.length, consistency, rev(name)),
      samples: ratios.length,
      reviews: rev(name),
      consistency: round(consistency, 2),
    });
  };
  ratioRule("layer_duration", "layer_duration", "layers", "the length");
  ratioRule("animation_timing", "animation_timing", "animations", "the duration");
  ratioRule("font_size", "font_size", "text", "the size");

  // Margins: titles pulled in from the edge.
  const margins = pairs(series.edge_margin);
  if (margins.length > 0) {
    const pulledIn = margins.filter((p) => p[1] > p[0]);
    if (pulledIn.length > margins.length / 2) {
      const afters = pulledIn.map((p) => p[1]);
      const med = median(afters);
      const consistency = (pulledIn.length / margins.length) * shareWithin(afters, med, 0.03);
      rules.push({
        id: "edge_margin",
        kind: "edge_margin",
        text: `The user pulls titles in from the edge: keep text at least about ${pct(med)}% of the comp's short side from the nearest edge (the agent left about ${pct(median(pulledIn.map((p) => p[0])))}%). Judged from layer positions, not text bounds.`,
        value: round(med),
        confidence: confidenceOf(margins.length, consistency, rev("edge_margin")),
        samples: margins.length,
        reviews: rev("edge_margin"),
        consistency: round(consistency, 2),
      });
    }
  }

  // Colour: the same new fill colour on several text layers.
  const colours = (series.fill_color ?? []).filter((s): s is number[] => Array.isArray(s) && s.length >= 3);
  if (colours.length > 0) {
    let best: number[] = colours[0];
    let bestN = 0;
    for (const c of colours) {
      const same = colours.filter((o) => o.every((v, i) => Math.abs(v - c[i]) <= 0.03)).length;
      if (same > bestN) {
        best = c;
        bestN = same;
      }
    }
    if (bestN >= 2) {
      const consistency = bestN / colours.length;
      rules.push({
        id: "fill_color",
        kind: "fill_color",
        text: `The user changes text fill to ${hex(best)} (${bestN} of ${colours.length} colour changes).`,
        value: best.slice(0, 3).map((v) => round(v)),
        confidence: confidenceOf(bestN, consistency, rev("fill_color")),
        samples: bestN,
        reviews: rev("fill_color"),
        consistency: round(consistency, 2),
      });
    }
  }
  return rules;
}

// ---------- persistence: baselines and evidence ----------

export interface StoredBaseline {
  id: string;
  /** Project path and comp id, normalised: one baseline per comp. */
  key: string;
  taken_at: string;
  note?: string;
  /** The layer ids the baseline was taken for; null means every layer. */
  tracked_ids: number[] | null;
  reviewed_at?: string;
  snapshot: TasteSnapshot;
}

export interface EvidenceEntry {
  review_id: string;
  at: string;
  values: Sample[];
}

export interface Ledger {
  version: 1;
  baselines: StoredBaseline[];
  evidence: Partial<Record<SeriesName, EvidenceEntry[]>>;
  /** The rules proposed by the latest review, by id, for ae_taste_rules to save from. */
  proposals: Record<string, ProposedRule>;
  /** What saving a rule set in the taste settings besides the rule, so forgetting it can undo that. */
  applied: {
    ease_influence?: { set: number[]; previous: number[] | null };
    overshoot?: { previous: boolean };
  };
}

const MAX_BASELINES = 20;
const MAX_ENTRIES_PER_SERIES = 60;

export function emptyLedger(): Ledger {
  return { version: 1, baselines: [], evidence: {}, proposals: {}, applied: {} };
}

export function ledgerPath(ctx: ToolContext): string {
  return path.join(dataDirOf(ctx), "learn-taste.json");
}

export function loadLedger(file: string): Ledger {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Ledger>;
    const base = emptyLedger();
    if (Array.isArray(parsed.baselines)) base.baselines = parsed.baselines.filter((b) => b && typeof b.id === "string" && b.snapshot && Array.isArray(b.snapshot.layers)).slice(-MAX_BASELINES);
    if (parsed.evidence && typeof parsed.evidence === "object") {
      for (const name of SERIES) {
        const list = (parsed.evidence as Record<string, unknown>)[name];
        if (Array.isArray(list)) base.evidence[name] = list.filter((e) => e && typeof e.review_id === "string" && Array.isArray(e.values)).slice(-MAX_ENTRIES_PER_SERIES);
      }
    }
    if (parsed.proposals && typeof parsed.proposals === "object") base.proposals = parsed.proposals as Record<string, ProposedRule>;
    if (parsed.applied && typeof parsed.applied === "object") base.applied = parsed.applied;
    return base;
  } catch {
    return emptyLedger();
  }
}

export function saveLedger(file: string, ledger: Ledger): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(ledger), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function baselineKey(projectPath: string, compId: number): string {
  return `${normalizeGuardPath(projectPath)}|${compId}`;
}

/** Puts a review's samples into the evidence, replacing what the same review put there before. */
export function recordEvidence(
  evidence: Ledger["evidence"],
  reviewId: string,
  at: string,
  samples: Partial<Record<SeriesName, Sample[]>>
): void {
  for (const name of SERIES) {
    const kept = (evidence[name] ?? []).filter((e) => e.review_id !== reviewId);
    const values = samples[name];
    if (values && values.length > 0) kept.push({ review_id: reviewId, at, values: values.slice(0, MAX_SAMPLES_PER_SERIES) });
    if (kept.length > 0) evidence[name] = kept.slice(-MAX_ENTRIES_PER_SERIES);
    else delete evidence[name];
  }
}

/** All samples per series, newest last and capped, and how many reviews each series came from. */
export function collectSeries(evidence: Ledger["evidence"]) {
  const series: Partial<Record<SeriesName, Sample[]>> = {};
  const reviews: Partial<Record<SeriesName, number>> = {};
  for (const name of SERIES) {
    const entries = evidence[name];
    if (!entries || entries.length === 0) continue;
    series[name] = entries.flatMap((e) => e.values).slice(-MAX_SAMPLES_PER_SERIES);
    reviews[name] = new Set(entries.map((e) => e.review_id)).size;
  }
  return { series, reviews };
}

// ---------- reading the comp ----------

/** The read goes through callHost, so it waits its turn in the queue behind any other tool's evals. */
async function readComp(
  ctx: ToolContext,
  toolName: string,
  compId: number,
  opts: { layers?: unknown[]; tolerateMissing?: boolean; headerOnly?: boolean } = {}
): Promise<TasteSnapshot> {
  const res = await ctx.bridge.callHost<TasteSnapshot>(
    "learntasteRead",
    {
      comp_id: compId,
      ...(opts.layers && opts.layers.length > 0 ? { layers: opts.layers } : {}),
      ...(opts.tolerateMissing ? { tolerate_missing: true } : {}),
      ...(opts.headerOnly ? { header_only: true } : {}),
    },
    { label: `${toolName}(${compId})`, mutates: false, toolName }
  );
  return res.result;
}

// ---------- schemas ----------

export const AeTasteBaselineSchema = z.object({
  comp_id: z.number().int().describe("The comp the agent just worked in."),
  layers: z
    .array(LayerSelectorSchema)
    .max(500)
    .optional()
    .describe("Only these layers (the ones the agent made or changed), by id, index or unique name. Default: every layer in the comp, which also reports layers the user adds or deletes."),
  note: z.string().max(200).optional().describe("One line on what was just done, kept with the baseline."),
});

export const AeLearnTasteSchema = z.object({
  comp_id: z.number().int().describe("The comp to review: it must have a baseline from ae_taste_baseline."),
  baseline_id: z.string().min(1).max(80).optional().describe("A specific baseline. Default: the latest one for this comp in this project."),
  record: z
    .boolean()
    .optional()
    .describe("Default true: remember what this review found, so rules gain confidence across reviews. False reviews without remembering. The same baseline reviewed again replaces its earlier samples, never adds to them."),
  max_observations: z.number().int().min(1).max(500).optional().describe("How many of the individual changes to list (default 100). Counts and rules always cover all of them."),
});

export const AeTasteRulesSchema = z
  .object({
    action: z
      .enum(["list", "save", "forget"])
      .describe("'list' shows the proposals from the latest review and the saved rules. 'save' keeps the confirmed ones. 'forget' removes saved rules and the evidence behind them."),
    rule_ids: z.array(z.string().min(1).max(80)).min(1).max(20).optional().describe("The rules to save or forget (the ids ae_learn_taste returned)."),
    ask_id: z
      .string()
      .min(1)
      .optional()
      .describe("For 'save': the ask_id of the answered ae_ask_user question built from ae_learn_taste's `ask`. Each rule_id must be among the options the user chose."),
    confirmed_in_chat: z
      .boolean()
      .optional()
      .describe("For 'save' when the question could not go through ae_ask_user: true only if the user said yes to exactly these rules in the chat."),
  })
  .refine((v) => v.action === "list" || (v.rule_ids !== undefined && v.rule_ids.length > 0), { message: "save and forget need rule_ids." })
  .refine((v) => v.action !== "save" || v.ask_id !== undefined || v.confirmed_in_chat === true, {
    message: "Saving needs the user's yes: pass the answered ask_id, or confirmed_in_chat: true.",
  });

// ---------- handlers ----------

const CAVEATS = [
  "After Effects cannot say who made a change: edits by other tools, an expression, or an undo of the agent's own write look the same as the user's edits. Treat every rule as a guess until the user confirms it.",
  "Only stored values are compared (an expression's result is not), and a layer's position stands in for its bounds.",
];

function newBaselineId(ledger: Ledger): string {
  const n = ledger.baselines.length;
  return `base_${Date.now().toString(36)}_${n}`;
}

async function baselineHandler(args: z.infer<typeof AeTasteBaselineSchema>, ctx: ToolContext) {
  const snapshot = await readComp(ctx, "ae_taste_baseline", args.comp_id, { layers: args.layers });
  const file = ledgerPath(ctx);
  const ledger = loadLedger(file);
  const key = baselineKey(snapshot.project_path, snapshot.comp_id);
  const baseline: StoredBaseline = {
    id: newBaselineId(ledger),
    key,
    taken_at: new Date().toISOString(),
    ...(args.note ? { note: args.note } : {}),
    tracked_ids: args.layers && args.layers.length > 0 ? snapshot.layers.map((l) => l.id) : null,
    snapshot,
  };
  // One baseline per comp: a new one replaces the old.
  ledger.baselines = [...ledger.baselines.filter((b) => b.key !== key), baseline].slice(-MAX_BASELINES);
  saveLedger(file, ledger);
  const keyed = snapshot.layers.reduce((n, l) => n + Object.values(l.props).filter((p) => p.keys.length > 0).length, 0);
  return {
    ok: true,
    baseline_id: baseline.id,
    comp_id: snapshot.comp_id,
    comp_name: snapshot.name,
    project_path: snapshot.project_path,
    layers: snapshot.layers.length,
    animated_properties: keyed,
    tracked: baseline.tracked_ids ? "the layers you named" : "every layer",
    truncated: snapshot.truncated,
    ledger_path: file,
    next: "Hand the comp back to the user. When they say they have edited it, call ae_learn_taste for this comp.",
  };
}

function reviewOverlap(base: TasteSnapshot, now: TasteSnapshot, tracked: number[] | null): number {
  const ids = (tracked ?? base.layers.map((l) => l.id)).filter((id) => base.layers.some((l) => l.id === id));
  if (ids.length === 0) return 1;
  const present = new Set(now.layers.map((l) => l.id));
  return ids.filter((id) => present.has(id)).length / ids.length;
}

function ruleLabel(r: ProposedRule): string {
  const v = r.value;
  if (r.kind === "ease_influence") {
    if (Array.isArray(v) && v.length === 4) return `Ease: out ${pct(v[0])}% / in ${pct(1 - v[2])}%`;
    if (typeof v === "number") return `Ease: influence about ${Math.round(v)}%`;
    return "Ease influence";
  }
  if (r.kind === "overshoot") return "No overshoot";
  if (r.kind === "layer_duration" && typeof v === "number") return `Layer length: ${pct(v)}% of mine`;
  if (r.kind === "animation_timing" && typeof v === "number") return `Animation time: ${pct(v)}% of mine`;
  if (r.kind === "font_size" && typeof v === "number") return `Font size: ${pct(v)}% of mine`;
  if (r.kind === "edge_margin" && typeof v === "number") return `Edge margin: ${pct(v)}% of short side`;
  if (r.kind === "fill_color" && Array.isArray(v)) return `Text fill: ${hex(v)}`;
  return r.kind.replace(/_/g, " ");
}

/**
 * The ask_user option for a proposed rule: a short label, and the whole rule text with its confidence in
 * the description (ae_ask_user takes 400 characters). ae_taste_rules rebuilds it from the stored proposal
 * and compares it with the answered question, so a rule is saved only as the user saw it.
 */
export function askOptionOf(r: ProposedRule): { id: string; label: string; description: string } {
  return {
    id: r.id,
    label: ruleLabel(r),
    description: `${r.text.slice(0, 330)} (${r.confidence} confidence: ${r.samples} edit${r.samples === 1 ? "" : "s"} in ${r.reviews} review${r.reviews === 1 ? "" : "s"})`,
  };
}

async function learnHandler(args: z.infer<typeof AeLearnTasteSchema>, ctx: ToolContext) {
  // A first read of the comp's header says which project this is; the baseline then says which layers to read.
  const head = await readComp(ctx, "ae_learn_taste", args.comp_id, { headerOnly: true });
  const file = ledgerPath(ctx);
  const ledger = loadLedger(file);
  const key = baselineKey(head.project_path, head.comp_id);
  const baseline = args.baseline_id ? ledger.baselines.find((b) => b.id === args.baseline_id) : ledger.baselines.find((b) => b.key === key);
  if (!baseline) {
    return {
      ok: false,
      error: "no_baseline",
      message: args.baseline_id
        ? `No baseline ${args.baseline_id}. At most ${MAX_BASELINES} are kept, one per comp.`
        : "No baseline for this comp in this project. A baseline has to be taken (ae_taste_baseline) after the agent's work, before the user edits; without it there is nothing to compare.",
      baselines: ledger.baselines.map((b) => ({ baseline_id: b.id, comp_id: b.snapshot.comp_id, comp_name: b.snapshot.name, project_path: b.snapshot.project_path, taken_at: b.taken_at })),
    };
  }
  if (baseline.key !== key) {
    return { ok: false, error: "wrong_comp", message: `Baseline ${baseline.id} was taken in ${baseline.snapshot.project_path} (comp ${baseline.snapshot.comp_id}), not here.` };
  }
  // Tracked layers are read by id (a deleted one comes back in `missing`), so a comp past 500 layers does not hide them.
  const tracked = baseline.tracked_ids && baseline.tracked_ids.length > 0 ? baseline.tracked_ids : null;
  const now = await readComp(
    ctx,
    "ae_learn_taste",
    args.comp_id,
    tracked ? { layers: tracked.map((id) => ({ id })), tolerateMissing: true } : {}
  );
  if (!now.truncated && reviewOverlap(baseline.snapshot, now, baseline.tracked_ids) < 0.5) {
    return {
      ok: false,
      error: "baseline_mismatch",
      message: "Fewer than half of the baseline's layers are in this comp now. It looks like another project (unsaved projects share one path) or a rebuilt comp, so no edits were attributed. Take a new baseline.",
    };
  }

  const diff = diffTasteSnapshots(baseline.snapshot, now, baseline.tracked_ids);
  // The agent's own writes after the baseline look like the user's edits, so a review that finds any does not learn from them.
  const baselineAt = Date.parse(baseline.taken_at);
  // The tracker logs every agent write per project, guarded or not (ae_set_keyframe_ease, ae_set_text, effects, imports...);
  // undo steps add the guarded ones it may have missed.
  const tracker = getSessionTracker();
  const agentSteps = (tracker?.steps() ?? []).filter(
    (st) => normalizeGuardPath(st.project_path) === normalizeGuardPath(now.project_path) && Date.parse(st.at) > baselineAt
  );
  const loggedWrites = tracker?.agentWritesSince(now.project_path, baseline.taken_at) ?? [];
  const agentWrote = agentSteps.length > 0 || loggedWrites.length > 0;
  const agentTools = [...new Set([...loggedWrites.map((w) => w.tool), ...agentSteps.map((st) => st.tool)])];
  const revisionBack = now.revision !== null && baseline.snapshot.revision !== null && now.revision < baseline.snapshot.revision;
  const record = args.record !== false;
  const samples = samplesFromObservations(diff.observations);
  const hasSamples = Object.keys(samples).length > 0;

  // Rules come from the stored evidence plus this review (replacing its earlier samples), whether or not it is kept.
  const evidence: Ledger["evidence"] = JSON.parse(JSON.stringify(ledger.evidence));
  const useSamples = !revisionBack && !agentWrote;
  // A review that cannot attribute the changes to the user leaves the evidence as it was.
  if (useSamples) recordEvidence(evidence, baseline.id, new Date().toISOString(), samples);
  const gathered = collectSeries(evidence);
  const rules = buildRules(gathered.series, gathered.reviews);
  const saved = new Map((ctx.settings?.get().taste.rules ?? []).map((r) => [r.id, r]));

  if (record && useSamples) {
    ledger.evidence = evidence;
    ledger.proposals = Object.fromEntries(rules.map((r) => [r.id, r]));
    baseline.reviewed_at = new Date().toISOString();
    saveLedger(file, ledger);
  }

  const max = args.max_observations ?? 100;
  const proposals = rules.map((r) => ({ ...r, already_saved: saved.has(r.id), worth_asking: r.confidence !== "low" && !saved.has(r.id) }));
  // The rules in `ask` must be the ones ae_taste_rules can save later, which come from the ledger: only a recorded review stores them.
  const askable = record && useSamples ? proposals.filter((r) => r.worth_asking) : [];
  let next: string;
  if (agentWrote) {
    next = "The agent wrote after the baseline, so nothing was recorded or put to the user. Take a new baseline now, and review again after the user's next edits.";
  } else if (revisionBack) {
    next = "The project looks reopened or reverted, so nothing was counted. Take a new baseline.";
  } else if (!record && proposals.some((r) => r.worth_asking)) {
    next = "This review was not recorded (record false), so its rules cannot be saved. Review again with record true, then ask the user.";
  } else if (askable.length > 0) {
    next = "Pass `ask` to ae_ask_user. Then save the chosen rules with ae_taste_rules { action: 'save', rule_ids, ask_id }. Do not save anything the user did not choose.";
  } else {
    next = "No rule is confident enough to ask about yet. Rules marked low are kept as evidence and gain confidence when more reviews agree. Don't act on them.";
  }
  const notes: string[] = [...CAVEATS];
  if (revisionBack) {
    notes.push("The project revision went back since the baseline: the project was probably reopened or reverted (or the agent's write undone). The changes below are shown but not counted as the user's taste.");
  }
  if (agentWrote) {
    notes.push(
      `The agent wrote to this project after the baseline (${agentTools.join(", ")}), and those writes are indistinguishable from the user's edits, so none of the changes below were counted as taste. Take a new baseline (ae_taste_baseline) after your own writes, and review once the user has edited.`
    );
  }
  if (tracked && diff.compared_layers === 0) {
    notes.push("None of the layers the baseline tracks were found in the comp now, so nothing could be compared.");
  }
  if (diff.observations.length === 0) notes.push("Nothing the review tracks has changed since the baseline.");
  if (now.truncated || baseline.snapshot.truncated) notes.push("A read hit a cap (500 layers, 200 keys per property or 3000 properties), so some layers or keys were not compared.");
  if (!hasSamples && diff.observations.length > 0) notes.push("The changes found are not the kind that make a rule (deleted or added layers, value tweaks).");

  return {
    ok: true,
    baseline_id: baseline.id,
    comp_id: now.comp_id,
    comp_name: now.name,
    baseline_taken_at: baseline.taken_at,
    compared_layers: diff.compared_layers,
    changed: diff.observations.length > 0,
    suspected_undo_or_reopen: revisionBack,
    agent_wrote_since_baseline: agentWrote,
    recorded: record && useSamples,
    counts: diff.counts,
    observations: diff.observations.slice(0, max),
    observations_truncated: diff.observations.length > max,
    proposals,
    ask:
      askable.length > 0
        ? {
            question: "I noticed patterns in how you changed my work. Which should I keep as your defaults?",
            kind: "choice",
            multi_select: true,
            allow_other: false,
            context: "Nothing is saved until you pick.",
            options: [
              ...askable.map(askOptionOf),
              { id: "none", label: "None of these" },
            ],
          }
        : null,
    next,
    notes,
  };
}

function toTasteRule(p: ProposedRule, now: string): TasteRule {
  return { id: p.id, kind: p.kind, text: p.text, value: p.value, confidence: p.confidence, samples: p.samples, reviews: p.reviews, saved_at: now };
}

async function rulesHandler(args: z.infer<typeof AeTasteRulesSchema>, ctx: ToolContext) {
  if (!ctx.settings) {
    return { ok: false, error: "no_settings", message: "This server has no settings store, so taste rules can't be kept." };
  }
  const file = ledgerPath(ctx);
  const ledger = loadLedger(file);
  const current = ctx.settings.get().taste.rules ?? [];

  if (args.action === "list") {
    return {
      ok: true,
      saved: current,
      proposals: Object.values(ledger.proposals),
      baselines: ledger.baselines.length,
      ledger_path: file,
      settings_path: ctx.settings.path,
    };
  }

  const ids = [...new Set(args.rule_ids ?? [])];
  if (args.action === "forget") {
    const known = new Set(current.map((r) => r.id));
    const unknown = ids.filter((id) => !known.has(id));
    const patch: Parameters<typeof ctx.settings.updateTaste>[0] = { rules: current.filter((r) => !ids.includes(r.id)) };
    // Undo what saving the rule set besides the rule, if the setting still holds the value the rule put there.
    const cleared: string[] = [];
    const taste = ctx.settings.get().taste;
    const handChanged = { ease: false };
    if (known.has("ease_influence") && ids.includes("ease_influence")) {
      const ruleValue = current.find((r) => r.id === "ease_influence")?.value;
      const set = ledger.applied.ease_influence?.set ?? (Array.isArray(ruleValue) ? ruleValue : null);
      if (set && taste.preferred_ease && JSON.stringify(taste.preferred_ease) === JSON.stringify(set)) {
        patch.preferred_ease = ledger.applied.ease_influence?.previous ?? null;
        cleared.push("preferred_ease");
      } else if (set && taste.preferred_ease) {
        handChanged.ease = true;
      }
    }
    if (known.has("overshoot") && ids.includes("overshoot") && taste.avoid_overshoot) {
      // Only a change counts: if avoid_overshoot was already on before the rule, forgetting leaves it on.
      const previous = ledger.applied.overshoot?.previous ?? false;
      patch.avoid_overshoot = previous;
      if (!previous) cleared.push("avoid_overshoot");
    }
    ctx.settings.updateTaste(patch);
    if (ids.includes("ease_influence")) delete ledger.applied.ease_influence;
    if (ids.includes("overshoot")) delete ledger.applied.overshoot;
    // The evidence goes too, or the next review would propose the same rule again.
    for (const id of ids) for (const s of RULE_SERIES[id] ?? []) delete ledger.evidence[s];
    for (const id of ids) delete ledger.proposals[id];
    saveLedger(file, ledger);
    // Left as they are only when the user changed them by hand: not when they were just put back.
    const stillSet: string[] = [];
    const after = ctx.settings.get().taste;
    if (ids.includes("ease_influence") && known.has("ease_influence") && after.preferred_ease && !cleared.includes("preferred_ease") && handChanged.ease) {
      stillSet.push("preferred_ease");
    }
    return {
      ok: true,
      forgotten: ids.filter((id) => known.has(id)),
      not_saved: unknown,
      also_cleared: cleared,
      ...(stillSet.length > 0
        ? { still_set: stillSet, note: "These settings were changed by hand since the rule was saved, so they were left as they are. Change them with ae_taste." }
        : {}),
      taste: after,
    };
  }

  // save: only rules from the latest review, and only what the user chose.
  const missing = ids.filter((id) => !ledger.proposals[id]);
  if (missing.length > 0) {
    return { ok: false, error: "unknown_rule", message: `No proposed rule ${missing.join(", ")}. Run ae_learn_taste to get current proposals; nothing was saved.` };
  }
  if (args.ask_id !== undefined) {
    const found = ctx.asks?.get(args.ask_id);
    if (!ctx.asks) {
      return { ok: false, error: "no_asks", message: "This server has no question store; ask in the chat and pass confirmed_in_chat: true after the user says yes. Nothing was saved." };
    }
    if (!found || !found.answer) {
      return { ok: false, error: "not_answered", message: "That question has no answer (unknown, expired or still waiting). Nothing was saved." };
    }
    const chosen = new Set(found.answer.status === "answered" ? found.answer.choice_ids : []);
    const notChosen = ids.filter((id) => !chosen.has(id));
    if (notChosen.length > 0) {
      return { ok: false, error: "not_confirmed", message: `The user did not choose ${notChosen.join(", ")}. Nothing was saved.`, chosen: [...chosen] };
    }
    // The question must be the one ae_learn_taste built for these stored proposals: same option id, label and text.
    const options = found.question.options;
    const mismatched = ids.filter((id) => {
      const want = askOptionOf(ledger.proposals[id]);
      const got = options.find((o) => o.id === id);
      return !got || got.label !== want.label || got.description !== want.description;
    });
    if (mismatched.length > 0) {
      return {
        ok: false,
        error: "ask_mismatch",
        message: `The question the user answered does not match the current proposal for ${mismatched.join(", ")} (it was not built from the "ask" ae_learn_taste returned, or a later review changed the rule). Nothing was saved. Run ae_learn_taste with record true and put its "ask" to the user again.`,
      };
    }
  }
  const now = new Date().toISOString();
  const byId = new Map(current.map((r) => [r.id, r]));
  for (const id of ids) byId.set(id, toTasteRule(ledger.proposals[id], now));
  const taste = ctx.settings.get().taste;
  let rules = [...byId.values()];
  if (rules.length > MAX_TASTE_RULES) rules = rules.slice(-MAX_TASTE_RULES);
  const patch: Parameters<typeof ctx.settings.updateTaste>[0] = { rules };
  const applied: string[] = [];
  const ease = ids.includes("ease_influence") ? ledger.proposals.ease_influence : undefined;
  if (ease && Array.isArray(ease.value) && ease.value.length === 4) {
    // Keep the curve from before the first save of this rule, so forgetting it puts the user's own back.
    ledger.applied.ease_influence = { set: ease.value, previous: ledger.applied.ease_influence?.previous ?? taste.preferred_ease };
    patch.preferred_ease = ease.value;
    applied.push("preferred_ease");
  }
  if (ids.includes("overshoot")) {
    ledger.applied.overshoot = { previous: ledger.applied.overshoot?.previous ?? taste.avoid_overshoot };
    patch.avoid_overshoot = true;
    applied.push("avoid_overshoot");
  }
  ctx.settings.updateTaste(patch);
  saveLedger(file, ledger);
  return {
    ok: true,
    saved: ids,
    also_set: applied,
    taste: ctx.settings.get().taste,
    message: "Saved. ae_taste shows them. Only preferred_ease and avoid_overshoot are enforced by ae_motion_review today; the other rules are for you to read before animating.",
  };
}

// ---------- tools ----------

export const learntasteTools: ToolDefinition<any>[] = [
  {
    name: "ae_taste_baseline",
    description:
      "Remember how a comp looked when you finished: layer timing, position, scale, rotation and opacity (every key with its time, value, ease influence and speed, and interpolation), and text size and colour. " +
      "Call it right after you finish a piece of work and hand it back, so ae_learn_taste can later tell what the user changed. One baseline is kept per comp; a new one replaces the old. " +
      "Pass `layers` to track only the layers you made or changed. Position with separated X/Y is read through its X and Y properties. Reads After Effects without changing anything (no undo step, selection or time); the snapshot is kept in learn-taste.json next to settings.json.",
    schema: AeTasteBaselineSchema,
    handler: baselineHandler,
  },
  {
    name: "ae_learn_taste",
    description:
      "Learn from what the user changed after you finished. Compares the comp now with the baseline from ae_taste_baseline and sorts the edits: ease influence (in and out), layer lengths, animation timing, overshoot removed, titles pulled in from the edge, font size, text colour. " +
      "It proposes rules with a confidence (low, medium, high) and returns `ask`, a question for ae_ask_user. Saves nothing: call ae_taste_rules to keep what the user picks. " +
      "Confidence needs several edits that agree, and 'high' several reviews. After Effects cannot say who made a change (other tools, expressions and an undo look the same), so never act on a rule the user did not confirm. " +
      "If you wrote to the project after the baseline (the session ledger shows it), nothing is counted: take a new baseline after your own writes. " +
      "Reads After Effects without changing anything. With record false it also leaves its own files alone, and then returns no `ask` (review again with record true before asking).",
    schema: AeLearnTasteSchema,
    handler: learnHandler,
  },
  {
    name: "ae_taste_rules",
    description:
      "List the taste rules proposed by the last ae_learn_taste and the ones already saved, save the ones the user chose, or forget saved ones. " +
      "Saving needs the user's yes: the ask_id of the answered ae_ask_user question (each rule_id must be among their choices), or confirmed_in_chat true if they agreed in the chat. " +
      "Saved rules go to settings.json under taste.rules (ae_taste shows them); an ease rule with both an in and an out also sets preferred_ease, and the overshoot rule sets avoid_overshoot. Forgetting also clears the evidence so the rule is not proposed again at once, and puts preferred_ease / avoid_overshoot back if the rule had set them. Never touches the AE project.",
    schema: AeTasteRulesSchema,
    handler: rulesHandler,
  },
];
