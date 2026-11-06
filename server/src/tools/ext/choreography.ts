/**
 * Choreography checks for ae_motion_review: what makes motion look generated or crowded rather
 * than badly eased. Everything is computed from the keyframe data the review already reads
 * (keys, ease influence and speed, layer in/out points, parents, transform expressions); no
 * render. Thresholds come from the motion spec (motion-spec.ts); see
 * docs/MOTION-RESEARCH.md item 3 and the chroma-motion-director skill's review.md.
 *
 * Severities use the review's existing tiers: medium, low, info.
 */
import type { ResolvedMotionSpec } from "../../motion-spec.js";
import type { MotionAnalysis, MotionFinding, MotionSegment, PropertyKey, PropertyPath, PropertySamples } from "./motion.js";

export const CHOREOGRAPHY_CHECKS = [
  "ease_monotony",
  "direction",
  "exit_ratio",
  "frame_zero",
  "overshoot",
  "stagger",
  "density",
  "landed_text",
  "long_tween",
] as const;
export type ChoreographyCheck = (typeof CHOREOGRAPHY_CHECKS)[number];

/** What listAnimatedProperties returns per layer. */
export interface LayerInfo {
  index: number;
  id: number;
  name: string;
  kind: "av" | "text" | "shape" | "camera" | "light" | "null";
  in_point: number | null;
  out_point: number | null;
  width: number | null;
  height: number | null;
  parent: number | null;
  transform_expressions: Array<{ name: string; text: string }>;
}

export interface ChoreoProp {
  path: PropertyPath;
  samples: PropertySamples;
  analysis: MotionAnalysis;
  effect_name?: string;
}

export interface ChoreoInput {
  comp: { width: number; height: number; fps: number };
  layers: LayerInfo[];
  props: ChoreoProp[];
}

type TweenClass = "move" | "opacity" | "color" | "other";

export interface Tween {
  layer: { index: number; id: number; name: string };
  prop: ChoreoProp;
  cls: TweenClass;
  /** Position, scale or rotation (what the viewer reads as a move). */
  transform: boolean;
  start: number;
  end: number;
  duration: number;
  segment: MotionSegment;
  out_influence: number | null;
  in_influence: number | null;
  /** Bezier on both sides of the tween (linear and hold are other checks' business). */
  eased: boolean;
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const MOVE_NAMES = new Set(["ADBE Position", "ADBE Position_0", "ADBE Position_1", "ADBE Position_2", "ADBE Scale"]);
const TRANSFORM_NAMES = new Set([...MOVE_NAMES, "ADBE Rotate Z", "ADBE Rotate X", "ADBE Rotate Y", "ADBE Orientation"]);
const COUNT_WORDS = /count|number|num\b|value|stat|total|percent|amount|price|score|figure/i;

/** Opacity, colour and counting numbers never overshoot (timing-and-easing.md). */
export function overshootKind(prop: { samples: PropertySamples; effect_name?: string }): "opacity" | "colour" | "number" | "motion" | "other" {
  const m = prop.samples.property.matchName;
  if (m === "ADBE Opacity") return "opacity";
  if (prop.samples.property.value_type === "COLOR") return "colour";
  if (m === "ADBE Slider Control-0001" && COUNT_WORDS.test(`${prop.effect_name ?? ""} ${prop.samples.property.name}`)) return "number";
  if (MOVE_NAMES.has(m)) return "motion";
  return "other";
}

/** Overshoot as a share of the property's keyframe span, in percent (100 when the keys do not differ). */
export function overshootPct(s: PropertySamples, o: { dimension: number; below_keys_by: number; above_keys_by: number }): number {
  const vals = s.keys.map((k) => k.value[o.dimension]).filter((v) => typeof v === "number");
  const span = vals.length ? Math.max(...vals) - Math.min(...vals) : 0;
  const past = Math.max(o.above_keys_by, o.below_keys_by);
  return span > 1e-9 ? (past / span) * 100 : 100;
}

/** A return smaller than this share of the move before it reads as a settle, not a deliberate move back. */
const KEYED_SETTLE_MAX_RETURN = 0.35;

/**
 * Overshoot built from keyframes (0 -> 115 -> 100): a key past where the move settles, then a
 * short return to the resting key. The sampled curve never leaves the key range here, so the
 * curve check cannot see it. Out-and-back moves (0 -> 100 -> 0) return too far to count.
 */
export function keyedOvershoots(
  s: PropertySamples,
): Array<{ dimension: number; key: number; time: number; past: number; pct: number }> {
  const out: Array<{ dimension: number; key: number; time: number; past: number; pct: number }> = [];
  const keys = s.keys;
  if (keys.length < 3) return out;
  const dims = keys[0].value.length;
  for (let d = 0; d < dims; d++) {
    const vals = keys.map((k) => k.value[d]);
    const span = Math.max(...vals) - Math.min(...vals);
    const tol = Math.max(1e-3, span * 1e-3);
    for (let i = 1; i + 1 < keys.length; i++) {
      const rise = vals[i] - vals[i - 1];
      const ret = vals[i + 1] - vals[i];
      if (Math.abs(rise) <= tol || Math.abs(ret) <= tol) continue;
      if (Math.sign(rise) === Math.sign(ret)) continue;
      if (Math.abs(ret) > KEYED_SETTLE_MAX_RETURN * Math.abs(rise)) continue;
      const travel = Math.abs(vals[i + 1] - vals[i - 1]);
      const pct = travel > 1e-9 ? (Math.abs(ret) / travel) * 100 : 100;
      out.push({ dimension: d, key: keys[i].index, time: keys[i].time, past: Math.abs(ret), pct });
    }
  }
  return out;
}

function influence(list: PropertyKey["in_ease"]): number | null {
  return list && list.length ? list[0].influence : null;
}

/** One tween per moving segment of every keyframed property (ancestors excluded by the caller). */
export function extractTweens(props: ChoreoProp[]): Tween[] {
  const out: Tween[] = [];
  for (const p of props) {
    const m = p.samples.property.matchName;
    let cls: TweenClass = "other";
    if (m === "ADBE Opacity") cls = "opacity";
    else if (p.samples.property.value_type === "COLOR") cls = "color";
    else if (TRANSFORM_NAMES.has(m)) cls = "move";
    const keyAt = new Map<number, PropertyKey>(p.samples.keys.map((k) => [k.index, k]));
    for (const g of p.analysis.segments) {
      if (g.profile === "hold" || g.profile === "static") continue;
      const a = keyAt.get(g.from_key);
      const b = keyAt.get(g.to_key);
      if (!a || !b) continue;
      out.push({
        layer: p.samples.layer,
        prop: p,
        cls,
        transform: TRANSFORM_NAMES.has(m),
        start: g.start,
        end: g.end,
        duration: r2(g.end - g.start),
        segment: g,
        out_influence: influence(a.out_ease),
        in_influence: influence(b.in_ease),
        eased: a.out_interp === "bezier" && b.in_interp === "bezier" && g.profile !== "constant",
      });
    }
  }
  return out;
}

/** Same ease shape: same profile and, where AE reported them, influences within 5 points. */
export function sameEase(a: Tween, b: Tween): boolean {
  if (a.segment.profile !== b.segment.profile) return false;
  const close = (x: number | null, y: number | null) => x === null || y === null || Math.abs(x - y) <= 5;
  return close(a.out_influence, b.out_influence) && close(a.in_influence, b.in_influence);
}

const layerLabel = (t: Tween) => t.layer.name;
const propLabel = (t: Tween) => t.prop.samples.property.name;

function finding(t: Tween, severity: MotionFinding["severity"], kind: MotionFinding["kind"], message: string, time = t.start): MotionFinding {
  return {
    severity,
    kind,
    layer: t.layer,
    property: { name: t.prop.samples.property.name, path: t.prop.path },
    keys: [t.segment.from_key, t.segment.to_key],
    time,
    message,
  };
}

function list(names: string[], max = 8): string {
  const uniq = Array.from(new Set(names));
  return uniq.length <= max ? uniq.join(", ") : `${uniq.slice(0, max).join(", ")} and ${uniq.length - max} more`;
}

/** Collapses a layer's simultaneous tweens (position + opacity of one entrance) into one move. */
function moves(tweens: Tween[], frame: number): Tween[] {
  const kept: Tween[] = [];
  for (const t of tweens) {
    if (!t.eased) continue;
    const dup = kept.find((k) => k.layer.id === t.layer.id && Math.abs(k.start - t.start) <= frame && Math.abs(k.duration - t.duration) <= frame);
    if (!dup) kept.push(t);
  }
  return kept;
}

// ---------- the checks ----------

function easeMonotony(tweens: Tween[], infos: Map<number, LayerInfo>, spec: ResolvedMotionSpec, frame: number): MotionFinding[] {
  // Hand-made looks hold keys and repeat a beat on purpose.
  if (spec.register === "handmade") return [];
  // A staggered group shares one ease by design (one gesture, offset starts): it counts as one
  // tween here, so a well-made stagger is not reported as monotony.
  const staggerExtras = new Set<Tween>();
  for (const run of staggerRuns(tweens, infos, spec, frame)) {
    [...run.members].sort((a, b) => a.start - b.start).slice(1).forEach((t) => staggerExtras.add(t));
  }
  const pool = moves(tweens, frame).filter((t) => !staggerExtras.has(t));
  const used = new Set<Tween>();
  const out: MotionFinding[] = [];
  for (const seed of pool) {
    if (used.has(seed)) continue;
    const group = pool.filter((t) => !used.has(t) && Math.abs(t.duration - seed.duration) <= frame && sameEase(seed, t));
    group.forEach((t) => used.add(t));
    if (group.length <= spec.max_same_ease) continue;
    const ease = `${seed.segment.profile}${seed.out_influence !== null && seed.in_influence !== null ? `, influence ${Math.round(seed.out_influence)}% out / ${Math.round(seed.in_influence)}% in` : ""}`;
    out.push(
      finding(
        group[0],
        "low",
        "ease_monotony",
        `${group.length} tweens share one ease (${ease}) and one duration (${seed.duration}s): ${list(group.map((t) => `${layerLabel(t)} > ${propLabel(t)}`))}. More than ${spec.max_same_ease} identical tweens in a comp is the generated tell; vary the duration across the three-tier palette or the ease family by role (hero, supporting, exit).`
      )
    );
  }
  return out;
}

function perLayer(tweens: Tween[]): Map<number, Tween[]> {
  const by = new Map<number, Tween[]>();
  for (const t of tweens) by.set(t.layer.id, [...(by.get(t.layer.id) ?? []), t].sort((a, b) => a.start - b.start));
  return by;
}

/** A layer's entrance and exit tweens, from where they fall against its in and out points. */
export function entranceExit(layerTweens: Tween[], info: LayerInfo | undefined, frame: number): { entrance?: Tween; exit?: Tween } {
  const mt = layerTweens.filter((t) => (t.cls === "move" && MOVE_NAMES.has(t.prop.samples.property.matchName)) || t.cls === "opacity");
  if (!mt.length) return {};
  const inP = info?.in_point ?? null;
  const outP = info?.out_point ?? null;
  const near = 0.5;
  let entrance = mt.find((t) => {
    if (inP !== null && t.start <= inP + near) return true;
    // A fade up from nothing is an entrance wherever the layer starts.
    return t.cls === "opacity" && (t.prop.samples.values[0]?.[0] ?? 100) <= 5 && t === mt[0];
  });
  let exit: Tween | undefined;
  for (let i = mt.length - 1; i >= 0; i--) {
    const t = mt[i];
    const fadesOut = t.cls === "opacity" && (t.prop.samples.values[t.prop.samples.values.length - 1]?.[0] ?? 100) <= 5;
    if ((outP !== null && t.end >= outP - near) || fadesOut) {
      exit = t;
      break;
    }
  }
  if (entrance && exit && (entrance === exit || Math.abs(entrance.start - exit.start) <= frame)) {
    // One tween cannot be both; call it the entrance when it starts at the in point.
    if (inP !== null && entrance.start <= inP + near) exit = undefined;
    else entrance = undefined;
  }
  return { entrance, exit };
}

function direction(tweens: Tween[], infos: Map<number, LayerInfo>, frame: number): MotionFinding[] {
  const out: MotionFinding[] = [];
  for (const [id, lt] of perLayer(tweens)) {
    const { entrance, exit } = entranceExit(lt, infos.get(id), frame);
    if (entrance && entrance.segment.profile === "speeds up" && (entrance.segment.peak_at ?? 0) >= 0.6) {
      out.push(
        finding(
          entrance,
          entrance.cls === "move" ? "medium" : "low",
          "wrong_direction",
          `${layerLabel(entrance)} enters with ${propLabel(entrance)} easing in only (key ${entrance.segment.from_key} to ${entrance.segment.to_key}, ${entrance.start}s): it starts slowly and arrives at ${Math.round((entrance.segment.end_speed / Math.max(entrance.segment.peak_speed, 1e-9)) * 100)}% of top speed. Heuristic: the layer's first position, scale or opacity tween starts within 0.5 s of its in point (or fades up from 0) and only accelerates. An entrance should decelerate into place (ease out).`
        )
      );
    }
    if (exit && exit.segment.profile === "slows down" && (exit.segment.peak_at ?? 1) <= 0.4) {
      out.push(
        finding(
          exit,
          exit.cls === "move" ? "medium" : "low",
          "wrong_direction",
          `${layerLabel(exit)} exits with ${propLabel(exit)} easing out only (key ${exit.segment.from_key} to ${exit.segment.to_key}, ${exit.start}s): it leaves at full speed and drifts to a stop. Heuristic: the layer's last position, scale or opacity tween ends within 0.5 s of its out point (or fades to 0) and only decelerates. An exit should accelerate away (ease in).`
        )
      );
    }
  }
  return out;
}

function exitRatio(tweens: Tween[], infos: Map<number, LayerInfo>, spec: ResolvedMotionSpec, frame: number): MotionFinding[] {
  const out: MotionFinding[] = [];
  for (const [id, lt] of perLayer(tweens)) {
    const { entrance, exit } = entranceExit(lt, infos.get(id), frame);
    if (!entrance || !exit || entrance.duration < 0.2) continue;
    const ratio = exit.duration / entrance.duration;
    const lo = spec.exit_ratio.min * entrance.duration - frame;
    const hi = spec.exit_ratio.max * entrance.duration + frame;
    if (exit.duration >= lo && exit.duration <= hi) continue;
    const longer = exit.duration > hi;
    let severity: MotionFinding["severity"] = "info";
    if (longer) severity = exit.duration >= entrance.duration ? "medium" : "low";
    out.push(
      finding(
        exit,
        severity,
        "exit_ratio",
        `${layerLabel(exit)} exits in ${exit.duration}s after entering in ${entrance.duration}s (${r2(ratio)}x); the spec wants ${spec.exit_ratio.min}x to ${spec.exit_ratio.max}x, about ${r2(spec.exit_ratio.min * entrance.duration)}s to ${r2(spec.exit_ratio.max * entrance.duration)}s. ${longer ? "A leaving element should go faster than it arrived." : "This exit is abrupt next to the entrance."}`
      )
    );
  }
  return out;
}

function frameZero(tweens: Tween[], infos: Map<number, LayerInfo>, fps: number): MotionFinding[] {
  const out: MotionFinding[] = [];
  const half = 0.5 / fps;
  for (const [id, lt] of perLayer(tweens)) {
    const info = infos.get(id);
    const first = lt.find((t) => t.cls === "move" || t.cls === "opacity");
    if (!first || !info || info.in_point === null) continue;
    if (Math.abs(first.start - info.in_point) > half) continue;
    out.push(
      finding(
        first,
        "info",
        "first_frame_move",
        `${layerLabel(first)} starts moving on its very first frame (${propLabel(first)} at ${first.start}s, the layer's in point). The viewer meets it already in motion; start a few frames in (or hold the first frame) unless the cut is meant to land mid-move.`
      )
    );
  }
  return out;
}

interface SiblingRun {
  parent: number | null;
  matchName: string;
  members: Tween[];
}

/** Layers next to each other in the stack, same parent, same animated property, similar-length first move. */
function siblingRuns(tweens: Tween[], infos: Map<number, LayerInfo>, frame: number): SiblingRun[] {
  const firsts = new Map<string, Tween[]>();
  for (const [id, lt] of perLayer(tweens)) {
    const first = lt.find((t) => t.eased && (t.cls === "move" || t.cls === "opacity"));
    if (!first) continue;
    const parent = infos.get(id)?.parent ?? null;
    const key = `${parent}|${first.prop.samples.property.matchName}`;
    firsts.set(key, [...(firsts.get(key) ?? []), first]);
  }
  const runs: SiblingRun[] = [];
  for (const [key, list_] of firsts) {
    const sorted = [...list_].sort((a, b) => a.layer.index - b.layer.index);
    let cur: Tween[] = [];
    const flush = () => {
      if (cur.length >= 3) {
        const [p, m] = key.split("|");
        runs.push({ parent: p === "null" ? null : Number(p), matchName: m, members: cur });
      }
      cur = [];
    };
    for (const t of sorted) {
      const prev = cur[cur.length - 1];
      const similar = prev && Math.abs(prev.duration - t.duration) <= Math.max(frame, 0.2 * prev.duration);
      if (prev && (t.layer.index - prev.layer.index > 1 || !similar)) flush();
      cur.push(t);
    }
    flush();
  }
  return runs;
}

/**
 * Sibling runs that are a real stagger: offset starts within twice the group budget (stagger
 * reports the slow ones). Siblings seconds apart are separate gestures and are not included.
 */
function staggerRuns(tweens: Tween[], infos: Map<number, LayerInfo>, spec: ResolvedMotionSpec, frame: number): SiblingRun[] {
  return siblingRuns(tweens, infos, frame).filter((run) => {
    const starts = run.members.map((t) => t.start);
    const spread = Math.max(...starts) - Math.min(...starts);
    return spread > frame && spread <= (2 * spec.stagger_ms.group_total_max) / 1000;
  });
}

function stagger(tweens: Tween[], infos: Map<number, LayerInfo>, spec: ResolvedMotionSpec, frame: number): MotionFinding[] {
  const out: MotionFinding[] = [];
  for (const run of siblingRuns(tweens, infos, frame)) {
    const byStart = [...run.members].sort((a, b) => a.start - b.start);
    const starts = byStart.map((t) => t.start);
    const spread = starts[starts.length - 1] - starts[0];
    // All at once is not a stagger: density covers that.
    if (spread <= frame) continue;
    const gaps = starts.slice(1).map((s, i) => s - starts[i]);
    const mean = spread / gaps.length;
    const names = list(byStart.map(layerLabel));
    const limit = spec.stagger_ms.group_total_max / 1000;
    if (spread > limit + 1e-6) {
      out.push(
        finding(byStart[0], spread > 2 * limit ? "medium" : "low", "stagger_spread", `Siblings ${names} (${propLabel(byStart[0])}) start over ${r2(spread)}s; the ${spec.register} stagger budget is ${limit}s for the group. The last items arrive after the viewer has stopped waiting; shorten the offset to about ${Math.round(limit / (run.members.length - 1) * 1000)} ms.`)
      );
    }
    if (Math.max(...gaps) - Math.min(...gaps) > Math.max(frame, 0.35 * mean)) {
      out.push(
        finding(byStart[0], "low", "stagger_irregular", `Siblings ${names} (${propLabel(byStart[0])}) start at uneven offsets (${gaps.map((g) => `${Math.round(g * 1000)} ms`).join(", ")}). A stagger reads as a rhythm only when the offsets are the same.`)
      );
    }
  }
  return out;
}

function isBackground(info: LayerInfo, comp: ChoreoInput["comp"]): boolean {
  const n = info.name.trim();
  if (/^(bg|background|backdrop)(?![a-z0-9])/i.test(n) || /(?<![a-z0-9])(bg|background|backdrop)$/i.test(n)) return true;
  if (info.kind === "text" || info.width === null || info.height === null) return false;
  return info.width * info.height >= 0.9 * comp.width * comp.height;
}

function density(tweens: Tween[], input: ChoreoInput, infos: Map<number, LayerInfo>, spec: ResolvedMotionSpec, frame: number): MotionFinding[] {
  const out: MotionFinding[] = [];
  const mt = tweens.filter((t) => t.eased && (t.cls === "move" || t.cls === "opacity"));
  const byParent = new Map<number | null, LayerInfo[]>();
  for (const l of input.layers) {
    if (l.kind === "camera" || l.kind === "light" || l.kind === "null" || isBackground(l, input.comp)) continue;
    byParent.set(l.parent, [...(byParent.get(l.parent) ?? []), l]);
  }
  // A stagger run counts as one moving element, keyed by its first member's layer id.
  const elementOf = new Map<number, number>();
  const runSize = new Map<number, number>();
  for (const run of staggerRuns(tweens, infos, spec, frame)) {
    const lead = run.members[0].layer.id;
    run.members.forEach((t) => elementOf.set(t.layer.id, lead));
    runSize.set(lead, run.members.length);
  }
  const elem = (t: Tween) => elementOf.get(t.layer.id) ?? t.layer.id;
  for (const [parent, group] of byParent) {
    if (group.length < 3) continue;
    const ids = new Set(group.map((l) => l.id));
    const nameOf = new Map(group.map((l) => [l.id, l.name]));
    const gt = mt.filter((t) => ids.has(t.layer.id));
    let worst: { t: number; moving: number[]; onScreen: number } | null = null;
    for (const at of gt.map((t) => t.start + frame / 2)) {
      const onScreen = group.filter((l) => (l.in_point === null || l.in_point <= at + 1e-6) && (l.out_point === null || l.out_point > at));
      if (onScreen.length < 3) continue;
      const moving = [...new Set(gt.filter((t) => t.start <= at && t.end > at).map(elem))];
      if (moving.length / onScreen.length > 1 / 3 && moving.length >= 2 && (!worst || moving.length / onScreen.length > worst.moving.length / worst.onScreen)) {
        worst = { t: at, moving, onScreen: onScreen.length };
      }
    }
    if (!worst) continue;
    const share = worst.moving.length / worst.onScreen;
    const first = gt.find((t) => worst!.moving.includes(elem(t)))!;
    const names = worst.moving.map((id) => {
      const n = runSize.get(id) ?? 1;
      return n > 1 ? `${nameOf.get(id) ?? id} and ${n - 1} more in a stagger` : (nameOf.get(id) ?? String(id));
    });
    out.push(
      finding(
        first,
        share >= 2 / 3 && worst.onScreen >= 4 ? "medium" : "low",
        "density",
        `${worst.moving.length} of ${worst.onScreen} sibling layers${parent === null ? "" : " under one parent"} are moving at ${r2(worst.t)}s (${Math.round(share * 100)}%): ${names.join(", ")}. More than a third moving at once reads as noise; stagger them or let one lead and the rest hold.`,
        r2(worst.t)
      )
    );
  }
  return out;
}

function landedText(tweens: Tween[], input: ChoreoInput, infos: Map<number, LayerInfo>, frame: number): MotionFinding[] {
  const out: MotionFinding[] = [];
  const by = perLayer(tweens.filter((t) => t.transform));
  for (const info of input.layers) {
    if (info.kind !== "text") continue;
    const expr = info.transform_expressions.find((e) => /\b(wiggle|loopOut|loopIn)\s*\(/.test(e.text));
    const lt = by.get(info.id) ?? [];
    const any = lt[0] ?? tweens.find((t) => t.layer.id === info.id);
    if (expr) {
      const anchor = any ?? ({ layer: { index: info.index, id: info.id, name: info.name }, prop: { path: ["ADBE Transform Group"], samples: { property: { name: expr.name } } }, segment: { from_key: 0, to_key: 0 }, start: 0 } as unknown as Tween);
      const f = finding(anchor, "medium", "landed_text_moving", `Text layer ${info.name} has an expression on ${expr.name} using ${/wiggle/.test(expr.text) ? "wiggle" : "loopOut/loopIn"}, so it keeps moving after it has landed. Text should be still once read; remove it or limit it to the entrance.`, 0);
      f.property = { name: expr.name, path: ["ADBE Transform Group"] };
      f.keys = [];
      out.push(f);
    }
    if (lt.length < 2) continue;
    // The entrance settles when the first cluster of overlapping transform tweens ends.
    let settle = lt[0].end;
    for (const t of lt) if (t.start <= settle + frame) settle = Math.max(settle, t.end);
    const { exit } = entranceExit(lt, infos.get(info.id), frame);
    const later = lt.filter((t) => t.start > settle + 0.3 && t !== exit && !(exit && Math.abs(t.start - exit.start) <= frame));
    if (!later.length) continue;
    const t = later[0];
    out.push(
      finding(t, "low", "landed_text_moving", `Text layer ${layerLabel(t)} moves again (${propLabel(t)}, ${t.start}s to ${t.end}s) after it landed at ${r2(settle)}s and before its exit. Text that has been read should hold still; keep any later move deliberate (a handover to the next line) rather than a drift.`)
    );
  }
  return out;
}

function longTween(tweens: Tween[], input: ChoreoInput, spec: ResolvedMotionSpec): MotionFinding[] {
  const infos = new Map(input.layers.map((l) => [l.id, l]));
  const out: MotionFinding[] = [];
  for (const t of tweens) {
    if (!t.prop.samples.property.spatial || t.duration <= spec.long_tween_s) continue;
    const info = infos.get(t.layer.id);
    if (info && (info.kind === "camera" || info.kind === "light" || isBackground(info, input.comp))) continue;
    out.push(
      finding(
        t,
        t.duration > 2 * spec.long_tween_s ? "medium" : "low",
        "long_tween",
        `${layerLabel(t)} ${propLabel(t)} travels for ${t.duration}s (key ${t.segment.from_key} to ${t.segment.to_key}); the ${spec.register} register allows ${spec.long_tween_s}s for a move. It will feel slow unless it is an ambient drift; shorten it or make it a camera or background move.`
      )
    );
  }
  return out;
}

export function reviewChoreography(input: ChoreoInput, spec: ResolvedMotionSpec, checks: readonly ChoreographyCheck[] = CHOREOGRAPHY_CHECKS): MotionFinding[] {
  const on = new Set(checks);
  const frame = 1 / (input.comp.fps > 0 ? input.comp.fps : 25);
  const infos = new Map(input.layers.map((l) => [l.id, l]));
  const tweens = extractTweens(input.props);
  // Cameras, lights and nulls are not drawn elements: entrance, exit and first-frame rules skip them.
  const drawn = tweens.filter((t) => {
    const k = infos.get(t.layer.id)?.kind;
    return k !== "camera" && k !== "light" && k !== "null";
  });
  const out: MotionFinding[] = [];
  if (on.has("ease_monotony")) out.push(...easeMonotony(tweens, infos, spec, frame));
  if (on.has("direction")) out.push(...direction(drawn, infos, frame));
  if (on.has("exit_ratio")) out.push(...exitRatio(drawn, infos, spec, frame));
  if (on.has("frame_zero")) out.push(...frameZero(drawn, infos, input.comp.fps > 0 ? input.comp.fps : 25));
  if (on.has("stagger")) out.push(...stagger(tweens, infos, spec, frame));
  if (on.has("density")) out.push(...density(tweens, input, infos, spec, frame));
  if (on.has("landed_text")) out.push(...landedText(tweens, input, infos, frame));
  if (on.has("long_tween")) out.push(...longTween(tweens, input, spec));
  return out;
}
