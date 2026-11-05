/**
 * server/src/tools/ext/timeremap.ts
 *
 * Time remapping:
 * - ae_get_time_remap: a layer's remap state (read only)
 * - ae_time_remap: enable, disable, freeze a frame, reverse, constant speed,
 *   speed ramps, hold the last frame and loop, built from the DOM (After
 *   Effects' Freeze Frame and Time-Reverse menu commands do nothing through
 *   CEP)
 *
 * The maths runs here, in Node: the source time a layer shows at a comp time,
 * the integral of a {time, speed} ramp, the mirrored keys of a reverse. The
 * plan that comes out (keys, stretch, expression, in and out points) goes to
 * the host function timeremapApply, which checks it against the layer and
 * writes it in one undo group. The read-back (a separate evalScript) compares
 * the keys and sampled values with the plan.
 *
 * Units. Time Remap values are seconds of source; key times are comp seconds.
 * A ramp's speed is a percent (100 = normal). Bezier ramps assume the ease
 * speed on Time Remap is source seconds per comp second (1 = 100%), which
 * the Scripting Guide doesn't state; the read-back samples valueAtTime along
 * the ramp and flags a mismatch if After Effects reads it differently, and
 * method "per_frame" (one linear key per frame) doesn't depend on it.
 *
 * What the maths can't know without the layer playing: with remapping off and
 * a stretch other than 100, how stretch maps to source time is not
 * documented, so those cases ask for "enable" first, and After Effects' own
 * keys then give the mapping.
 */

import { z } from "zod";
import type { ReceiptMismatch } from "../../receipts.js";
import { AGENT_SAFETY_GUIDANCE, ExpectSchema, LayerSelectorSchema, type ToolDefinition } from "../common.js";
import { expectThat, runGuardedWrite } from "./write-runner.js";

// ---------- read shape ----------

export interface RemapEase {
  speed: number;
  influence: number;
}

export interface RemapKey {
  index: number;
  time: number;
  value: number;
  in_interp: string;
  out_interp: string;
  in_ease?: RemapEase[];
  out_ease?: RemapEase[];
}

export interface RemapInfo {
  comp_id: number;
  comp_name?: string;
  comp_duration: number;
  comp_frame_duration: number;
  layer: { index: number; id: number; name: string };
  kind?: string;
  eligible: boolean;
  ineligible_reason: string | null;
  remap_enabled: boolean;
  can_set_remap?: boolean | null;
  in_point: number;
  out_point: number;
  start_time: number;
  stretch: number;
  source: { id: number; name: string; duration: number; frame_duration: number; is_comp: boolean } | null;
  keys: RemapKey[];
  num_keys: number;
  keys_truncated: boolean;
  expression: string | null;
  expression_enabled: boolean;
  samples: Array<{ time: number; value: number | null }>;
}

// ---------- schemas ----------

const OPERATIONS = ["enable", "disable", "freeze", "reverse", "speed", "ramp", "hold_last_frame", "loop"] as const;

export const RampPointSchema = z.object({
  time: z.number().min(-10800).max(10800).describe("Comp time in seconds."),
  speed: z.number().min(-10000).max(10000).describe("Playback speed at that time, in percent: 100 = normal, 200 = double, 0 = still, negative = backwards."),
});

export const AeGetTimeRemapSchema = z.object({
  comp_id: z.number().int(),
  layer: LayerSelectorSchema,
  sample_times: z
    .array(z.number())
    .max(100)
    .optional()
    .describe("Comp times (up to 100) at which to read the source time the layer shows (valueAtTime). Only while remapping is on."),
});

/** Which parameters each operation takes; anything else is refused. */
const PARAMS: Record<(typeof OPERATIONS)[number], string[]> = {
  enable: [],
  disable: [],
  freeze: ["at_time", "source_time"],
  reverse: [],
  speed: ["speed_percent"],
  ramp: ["points", "method", "outside", "start_source_time"],
  hold_last_frame: ["until"],
  loop: ["loop_type", "until"],
};
const OPTIONAL_PARAMS = ["at_time", "source_time", "speed_percent", "points", "method", "outside", "start_source_time", "until", "loop_type"] as const;

export const AeTimeRemapSchema = z
  .object({
    comp_id: z.number().int(),
    layer: LayerSelectorSchema.describe("A footage or precomp layer. Stills, solids, text, shapes, nulls, cameras and lights can't be time remapped."),
    operation: z
      .enum(OPERATIONS)
      .describe(
        "enable: switch Time Remap on (AE adds its own keys, and a Time Remap expression left from before is cleared). disable: switch it off (its keys go; AE keeps the expression text). " +
          "freeze: hold one frame for the whole layer (at_time or source_time). reverse: play the layer backwards. " +
          "speed: constant speed through layer.stretch (speed_percent; not while remapping is on). " +
          "ramp: a speed ramp through points of {time, speed}. hold_last_frame: keep the last source frame on screen until `until`. " +
          "loop: loopOut on Time Remap (loop_type)."
      ),
    at_time: z.number().optional().describe("freeze: the comp time of the frame to hold. Must lie inside the layer."),
    source_time: z.number().min(0).optional().describe("freeze: the frame to hold as seconds into the source, instead of at_time."),
    speed_percent: z
      .number()
      .optional()
      .describe("speed: 100 = normal, 200 = twice as fast, 50 = half; negative plays backwards. Becomes layer.stretch = 10000 / speed_percent, which AE limits to 1..9900 percent."),
    points: z
      .array(RampPointSchema)
      .min(2)
      .max(40)
      .optional()
      .describe("ramp: speed points in ascending comp time, inside the layer. Speed changes linearly between points; the source time is the integral."),
    method: z
      .enum(["per_frame", "bezier"])
      .optional()
      .describe(
        "ramp: per_frame (default) writes one linear key per comp frame, exact whatever the ease units are. " +
          "bezier writes one key per point with Bezier ease (speed, 33.3% influence): smooth and tidy in the graph editor, and checked by sampling in the read-back."
      ),
    outside: z
      .enum(["extend", "hold", "trim"])
      .optional()
      .describe(
        "ramp: what the layer does before the first point and after the last. extend (default) keeps the end speeds up to the layer's in and out. " +
          "hold freezes the first and last frame. trim moves the layer's in and out points to the first and last point."
      ),
    start_source_time: z
      .number()
      .min(0)
      .optional()
      .describe("ramp: seconds into the source at the first point. Default: the frame the layer shows there now."),
    until: z
      .number()
      .optional()
      .describe("hold_last_frame and loop: extend the layer's out point to this comp time. Default for hold_last_frame: the comp's end."),
    loop_type: z.enum(["cycle", "pingpong"]).optional().describe("loop: loopOut type. Default cycle. (offset and continue run past the source, so they aren't offered.)"),
    expect: ExpectSchema,
  })
  .superRefine((v, ctx) => {
    const allowed = PARAMS[v.operation];
    for (const key of OPTIONAL_PARAMS) {
      if (v[key] !== undefined && !allowed.includes(key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${key} doesn't apply to ${v.operation}.`, path: [key] });
      }
    }
    if (v.operation === "freeze" && (v.at_time === undefined) === (v.source_time === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "freeze takes exactly one of at_time and source_time.", path: ["at_time"] });
    }
    if (v.operation === "speed" && v.speed_percent === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "speed needs speed_percent.", path: ["speed_percent"] });
    }
    if (v.operation === "ramp" && v.points === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "ramp needs points.", path: ["points"] });
    }
  });

type TimeRemapArgs = z.infer<typeof AeTimeRemapSchema>;

// ---------- plan ----------

export interface PlanKey {
  time: number;
  value: number;
  in_interp: "linear" | "bezier" | "hold";
  out_interp: "linear" | "bezier" | "hold";
  /** Each side's ease is present only when that side is Bezier. */
  ease?: { in_speed?: number; in_influence?: number; out_speed?: number; out_influence?: number };
}

export interface RemapPlan {
  operation: string;
  /** What the layer looked like when planned; the host refuses if it changed. */
  snapshot: {
    in_point: number;
    out_point: number;
    start_time: number;
    stretch: number;
    remap_enabled: boolean;
    /** Remap key count, and a fingerprint of the keys, expression and source; the host compares them when set. */
    num_keys?: number;
    fingerprint?: string;
  };
  enable?: boolean;
  disable?: boolean;
  stretch?: number;
  keep_in_point?: boolean;
  keys?: PlanKey[];
  per_frame?: { times: number[]; values: number[] };
  expression?: string;
  in_point?: number;
  out_point?: number;
  expect_remap_enabled: boolean;
  /** Comp times the read-back samples (valueAtTime) to compare with expected_samples. */
  sample_times: number[];
  expected_samples: Array<{ time: number; value: number }>;
  notes: string[];
}

export type PlanResult = { ok: true; plan: RemapPlan } | { ok: false; error: string; message: string };

const EPS = 1e-6;
/** One third: Bezier handles at a third of the segment make the time axis linear. */
export const THIRD_INFLUENCE = 100 / 3;
/** The host writes at most this many keys. */
export const MAX_PLAN_KEYS = 3000;
const MAX_PLAN_SAMPLES = 100;

const bad = (message: string): PlanResult => ({ ok: false, error: "bad_args", message });
const fix = (n: number) => Math.round(n * 1e9) / 1e9;

type Value = { value: number } | { error: string };

/**
 * The source time (seconds into the source) the layer shows at comp time t.
 * With remapping on this is After Effects' own answer (a sample read from the
 * host). With it off and stretch 100 it is t - startTime. With another stretch
 * it isn't known, so the caller is told to enable remapping first.
 */
export function sourceTimeAt(info: RemapInfo, t: number): Value {
  if (info.remap_enabled) {
    const s = info.samples.find((x) => Math.abs(x.time - t) < 1e-9);
    if (s && typeof s.value === "number") return { value: s.value };
    return { error: `The layer's remapped source time at ${t}s wasn't read.` };
  }
  if (Math.abs(info.stretch - 100) > 1e-9) {
    return {
      error:
        `The layer is stretched to ${info.stretch}% and time remapping is off. How stretch maps to source time isn't documented, ` +
        `so run operation "enable" first (After Effects' own remap keys then give the mapping), or reset the stretch to 100.`,
    };
  }
  return { value: t - info.start_time };
}

/** Comp times whose source time the planner needs while remapping is on. */
export function sampleTimesFor(args: TimeRemapArgs, info: RemapInfo): number[] {
  const fd = info.comp_frame_duration;
  if (args.operation === "freeze" && args.at_time !== undefined) return [args.at_time];
  if (args.operation === "ramp" && args.points && args.start_source_time === undefined && fd > 0) {
    return [snapTo(args.points[0].time, fd)];
  }
  return [];
}

const snapTo = (t: number, step: number) => fix(Math.round(t / step) * step);

function sourceLimits(info: RemapInfo) {
  const dur = info.source?.duration ?? 0;
  const sfd = info.source?.frame_duration ?? info.comp_frame_duration;
  return { dur, sfd, maxSrc: Math.max(0, dur - sfd) };
}

/** Speed ramp maths. Speeds are source seconds per comp second here (1 = normal). */
export interface RampPoint {
  time: number;
  speed: number;
}

/** Source time at each point, integrating the (linear between points) speed from one anchored point. */
export function integrateRamp(points: RampPoint[], anchorIndex: number, anchorValue: number): number[] {
  const s = new Array<number>(points.length).fill(0);
  s[anchorIndex] = anchorValue;
  for (let i = anchorIndex; i + 1 < points.length; i++) {
    s[i + 1] = s[i] + ((points[i].speed + points[i + 1].speed) / 2) * (points[i + 1].time - points[i].time);
  }
  for (let i = anchorIndex; i - 1 >= 0; i--) {
    s[i - 1] = s[i] - ((points[i - 1].speed + points[i].speed) / 2) * (points[i].time - points[i - 1].time);
  }
  return s;
}

/** Source time at comp time t on the ramp (quadratic inside a segment); holds the end values outside it. */
export function rampSourceAt(points: RampPoint[], values: number[], t: number): number {
  if (t <= points[0].time) return values[0];
  const last = points.length - 1;
  if (t >= points[last].time) return values[last];
  for (let i = 0; i < last; i++) {
    if (t <= points[i + 1].time) {
      const T = points[i + 1].time - points[i].time;
      const u = t - points[i].time;
      return values[i] + points[i].speed * u + ((points[i + 1].speed - points[i].speed) / (2 * T)) * u * u;
    }
  }
  return values[last];
}

/** The lowest and highest source time the ramp reaches, including a turning point inside a segment. */
export function rampExtremes(points: RampPoint[], values: number[], tEnd = Infinity): { min: number; max: number; minAt: number; maxAt: number } {
  let min = Infinity;
  let max = -Infinity;
  let minAt = points[0].time;
  let maxAt = points[0].time;
  const note = (v: number, at: number) => {
    if (v < min) {
      min = v;
      minAt = at;
    }
    if (v > max) {
      max = v;
      maxAt = at;
    }
  };
  for (let i = 0; i < points.length; i++) {
    if (points[i].time > tEnd) break;
    note(values[i], points[i].time);
    if (i + 1 < points.length) {
      const a = points[i].speed;
      const b = points[i + 1].speed;
      if ((a > 0 && b < 0) || (a < 0 && b > 0)) {
        const T = points[i + 1].time - points[i].time;
        const u = (a / (a - b)) * T;
        if (points[i].time + u <= tEnd) note(rampSourceAt(points, values, points[i].time + u), points[i].time + u);
      }
    }
  }
  // The ramp is only seen up to tEnd: a segment crossing it ends there.
  if (Number.isFinite(tEnd) && tEnd > points[0].time && tEnd < points[points.length - 1].time) note(rampSourceAt(points, values, tEnd), tEnd);
  return { min, max, minAt, maxAt };
}

function easeOf(k: RemapKey, flip: boolean): PlanKey["ease"] {
  const ie = k.in_interp === "bezier" ? k.in_ease?.[0] : undefined;
  const oe = k.out_interp === "bezier" ? k.out_ease?.[0] : undefined;
  if (!ie && !oe) return undefined;
  const e: NonNullable<PlanKey["ease"]> = {};
  // Reversing time swaps the sides and flips the sign of the speeds.
  const sign = flip ? -1 : 1;
  const inSide = flip ? oe : ie;
  const outSide = flip ? ie : oe;
  if (inSide) {
    e.in_speed = sign * inSide.speed;
    e.in_influence = inSide.influence;
  }
  if (outSide) {
    e.out_speed = sign * outSide.speed;
    e.out_influence = outSide.influence;
  }
  return e;
}

function toPlanKey(k: RemapKey): PlanKey {
  const out: PlanKey = { time: k.time, value: k.value, in_interp: k.in_interp as PlanKey["in_interp"], out_interp: k.out_interp as PlanKey["out_interp"] };
  const ease = easeOf(k, false);
  if (ease) out.ease = ease;
  return out;
}

/** The key as it plays when time runs backwards: same value, sides swapped, eases negated. */
function toReversedKey(k: RemapKey, time: number, value: number): PlanKey {
  const out: PlanKey = { time, value, in_interp: k.out_interp as PlanKey["in_interp"], out_interp: k.in_interp as PlanKey["out_interp"] };
  const ease = easeOf(k, true);
  if (ease) out.ease = ease;
  return out;
}

/**
 * A short hash of what the plan may depend on: the remap keys (time and value to 1e-6),
 * the expression and the source's id and length. The host computes the same string.
 */
export function remapFingerprint(info: RemapInfo): string {
  const r6 = (n: number) => Math.round(n * 1e6);
  let text = String(info.num_keys) + "#";
  for (const k of info.keys) text += r6(k.time) + ":" + r6(k.value) + "|";
  text += "#" + (info.expression ?? "") + "#" + (info.source ? info.source.id + ":" + r6(info.source.duration) : "none");
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = (h * 33 + text.charCodeAt(i)) % 4294967296;
  return String(h);
}

const snapshotOf = (info: RemapInfo): RemapPlan["snapshot"] => ({
  in_point: info.in_point,
  out_point: info.out_point,
  start_time: info.start_time,
  stretch: info.stretch,
  remap_enabled: info.remap_enabled,
  num_keys: info.num_keys,
  fingerprint: remapFingerprint(info),
});

const hasExpression = (info: RemapInfo): boolean => info.remap_enabled && typeof info.expression === "string" && info.expression.trim() !== "";
const short = (s: string) => (s.length > 120 ? s.slice(0, 120) + "..." : s);

/** Clears a Time Remap expression that would fight the new keys, and says so. */
function clearExpression(plan: RemapPlan, info: RemapInfo): void {
  if (!hasExpression(info)) return;
  plan.expression = "";
  plan.notes.push(`Cleared the layer's existing Time Remap expression (${short(info.expression as string)}) so it doesn't act on the new keys.`);
}

function basePlan(operation: string, info: RemapInfo): RemapPlan {
  return {
    operation,
    snapshot: snapshotOf(info),
    expect_remap_enabled: true,
    sample_times: [],
    expected_samples: [],
    notes: [],
  };
}

const tooFar = (what: string, value: number, at: number, info: RemapInfo): string => {
  const { dur, maxSrc } = sourceLimits(info);
  return value >= 0
    ? `${what} would reach ${fix(value)}s into the source at comp time ${fix(at)}s, but the source ends at ${fix(dur)}s (its last frame starts at ${fix(maxSrc)}s).`
    : `${what} would go back to ${fix(value)}s into the source at comp time ${fix(at)}s, before the first frame.`;
};

/** Turns the request and the layer's state into a plan, or refuses with the reason. Pure. */
export function planTimeRemap(args: TimeRemapArgs, info: RemapInfo): PlanResult {
  if (!info.eligible || !info.source) {
    return bad(`"${info.layer.name}" can't be time remapped: ${info.ineligible_reason ?? "it has no usable source"}.`);
  }
  const cfd = info.comp_frame_duration;
  if (!(cfd > 0)) return bad("The comp's frame duration couldn't be read.");
  const { dur, maxSrc } = sourceLimits(info);
  const lenFrames = (info.out_point - info.in_point) / cfd;

  switch (args.operation) {
    case "enable": {
      if (info.remap_enabled) return bad("Time remapping is already on.");
      return { ok: true, plan: { ...basePlan("enable", info), enable: true, notes: ["After Effects added its own keys; read them with ae_get_time_remap."] } };
    }
    case "disable": {
      if (!info.remap_enabled) return bad("Time remapping is already off.");
      return { ok: true, plan: { ...basePlan("disable", info), disable: true, expect_remap_enabled: false } };
    }
    case "freeze": {
      let src: number;
      let reportAt = info.in_point;
      if (args.source_time !== undefined) {
        src = args.source_time;
      } else {
        const at = args.at_time as number;
        reportAt = at;
        // The last frame the layer shows starts one comp frame before the out point.
        if (at < info.in_point - EPS || at >= info.out_point - EPS) {
          return bad(`at_time ${at}s is outside the layer (${fix(info.in_point)}s to ${fix(info.out_point)}s).`);
        }
        const found = sourceTimeAt(info, at);
        if ("error" in found) return bad(found.error);
        src = found.value;
      }
      const sfd = info.source.frame_duration;
      // AE shows the source frame that contains the time, so floor to the frame start.
      if (sfd > 0) src = fix(Math.floor(src / sfd + 1e-6) * sfd);
      if (src < -EPS || src > maxSrc + EPS) return bad(tooFar("The frozen frame", src, reportAt, info));
      src = Math.min(Math.max(src, 0), maxSrc);
      const plan = basePlan("freeze", info);
      plan.enable = !info.remap_enabled;
      clearExpression(plan, info);
      plan.keys = [{ time: info.in_point, value: src, in_interp: "hold", out_interp: "hold" }];
      plan.notes.push(`Held the frame at ${fix(src)}s of the source for the whole layer.`);
      return { ok: true, plan };
    }
    case "reverse": {
      const plan = basePlan("reverse", info);
      plan.enable = !info.remap_enabled;
      if (info.remap_enabled) {
        if (info.keys_truncated) return bad(`The layer has ${info.num_keys} remap keys; reverse reads at most ${info.keys.length} of them.`);
        if (info.keys.length < 2) return bad("Reverse needs at least two Time Remap keys; a single key is a freeze.");
        if (info.keys.some((k) => k.in_interp === "hold" || k.out_interp === "hold")) {
          return bad("Reverse can't mirror Time Remap keys with hold interpolation (the hold would move to the wrong side of the key). Change them to linear first.");
        }
        // Mirror the keys in time: the first key's time becomes the last's.
        const t0 = info.keys[0].time;
        const t1 = info.keys[info.keys.length - 1].time;
        let clamped = false;
        plan.keys = info.keys
          .slice()
          .reverse()
          .map((k) => {
            let v = k.value;
            if (v > maxSrc + EPS) {
              v = maxSrc;
              clamped = true;
            }
            return toReversedKey(k, fix(t0 + t1 - k.time), v);
          });
        clearExpression(plan, info);
        plan.notes.push("Mirrored the remap keys in time: the last key becomes the first, with its sides and ease speeds swapped.");
        if (clamped) plan.notes.push(`A key at the source's full length (${fix(sourceLimits(info).dur)}s) shows nothing; it was pulled back to the last frame (${fix(maxSrc)}s).`);
        return { ok: true, plan };
      }
      if (lenFrames < 2) return bad("The layer is shorter than two frames; there is nothing to reverse.");
      const lastShown = info.out_point - cfd;
      const a = sourceTimeAt(info, info.in_point);
      const b = sourceTimeAt(info, lastShown);
      if ("error" in a) return bad(a.error);
      if ("error" in b) return bad(b.error);
      if (a.value < -EPS || b.value < -EPS || Math.max(a.value, b.value) > dur - EPS) {
        return bad(tooFar("The layer's source range", Math.max(b.value, a.value), lastShown, info));
      }
      plan.keys = [
        { time: info.in_point, value: Math.min(Math.max(b.value, 0), dur), in_interp: "linear", out_interp: "linear" },
        { time: lastShown, value: Math.min(Math.max(a.value, 0), dur), in_interp: "linear", out_interp: "linear" },
      ];
      plan.notes.push("Two linear keys, from the layer's last frame back to its first.");
      return { ok: true, plan };
    }
    case "speed": {
      if (info.remap_enabled) return bad("Time remapping is on, so layer.stretch can't change speed. Use operation ramp, or disable remapping first.");
      const pct = args.speed_percent as number;
      if (pct === 0) return bad("speed_percent can't be 0; use freeze.");
      const stretch = 10000 / pct;
      if (Math.abs(stretch) < 1 || Math.abs(stretch) > 9900) {
        return bad(`speed_percent ${pct} gives a stretch of ${fix(stretch)}%; After Effects allows 1 to 9900 percent (speed ${fix(10000 / 9900)}% to 10000%).`);
      }
      if (Math.abs(stretch - info.stretch) < 1e-9) return bad(`The layer is already at ${pct}% speed.`);
      return {
        ok: true,
        plan: {
          ...basePlan("speed", info),
          stretch: fix(stretch),
          keep_in_point: true,
          expect_remap_enabled: false,
          notes: ["layer.stretch changed; the start time was moved so the in point stays put (checked in the read-back)."],
        },
      };
    }
    case "ramp":
      return planRamp(args, info, cfd);
    case "hold_last_frame": {
      const until = args.until ?? info.comp_duration;
      const plan = basePlan("hold_last_frame", info);
      plan.enable = !info.remap_enabled;
      if (until > info.out_point + EPS) plan.out_point = until;
      if (!info.remap_enabled) {
        const a = sourceTimeAt(info, info.in_point);
        if ("error" in a) return bad(a.error);
        const tEnd = fix(info.start_time + maxSrc);
        if (until <= tEnd + EPS) return bad(`The source doesn't run out before ${fix(until)}s: its last frame shows at ${tEnd}s. Pick a later until.`);
        if (a.value < -EPS || a.value > maxSrc + EPS) return bad(tooFar("The layer's first frame", a.value, info.in_point, info));
        const lead = fix(tEnd - info.in_point);
        if (lead < cfd - EPS) {
          plan.keys = [{ time: info.in_point, value: maxSrc, in_interp: "hold", out_interp: "hold" }];
        } else {
          plan.keys = [
            { time: info.in_point, value: Math.max(a.value, 0), in_interp: "linear", out_interp: "linear" },
            { time: tEnd, value: maxSrc, in_interp: "linear", out_interp: "linear" },
          ];
        }
        plan.notes.push(`The last source frame (${fix(maxSrc)}s) shows from ${tEnd}s and holds to ${fix(until)}s.`);
        return { ok: true, plan };
      }
      if (info.keys_truncated) return bad(`The layer has ${info.num_keys} remap keys; hold_last_frame reads at most ${info.keys.length} of them.`);
      const lastKey = info.keys[info.keys.length - 1];
      if (!lastKey) return bad("Time remapping is on but has no keys to hold; give it keys first.");
      if (until <= lastKey.time + EPS && until <= info.out_point + EPS && !hasExpression(info)) {
        return bad(`The last remap key is at ${fix(lastKey.time)}s and the layer already runs to ${fix(info.out_point)}s; nothing to hold.`);
      }
      clearExpression(plan, info);
      if (lastKey.value > maxSrc + EPS) {
        // A last key at the source's full length may show nothing: pull it back to the last frame.
        plan.keys = info.keys.map((k, i) => {
          const pk = toPlanKey(k);
          return i === info.keys.length - 1 ? { ...pk, value: maxSrc } : pk;
        });
        plan.notes.push(`The last key sat at ${fix(lastKey.value)}s, past the last frame; moved to ${fix(maxSrc)}s.`);
      }
      if (plan.keys === undefined && plan.out_point === undefined && plan.expression === undefined) {
        return bad(`Nothing to change: the remap already holds its last key and the layer already runs to ${fix(info.out_point)}s. Pass until to extend it.`);
      }
      plan.notes.push(`The remap holds the last key's value after ${fix(lastKey.time)}s.`);
      return { ok: true, plan };
    }
    case "loop": {
      const plan = basePlan("loop", info);
      plan.enable = !info.remap_enabled;
      plan.expression = `loopOut("${args.loop_type ?? "cycle"}")`;
      if (args.until !== undefined && args.until > info.out_point + EPS) plan.out_point = args.until;
      if (hasExpression(info) && info.expression !== plan.expression) {
        plan.notes.push(`Replaced the layer's existing Time Remap expression: ${short(info.expression as string)}`);
      }
      if (info.remap_enabled) {
        if (info.num_keys < 2) return bad("loopOut needs at least two Time Remap keys to repeat.");
      } else {
        if (lenFrames < 2) return bad("The layer is shorter than two frames; there is nothing to loop.");
        const lastShown = info.out_point - cfd;
        const a = sourceTimeAt(info, info.in_point);
        const b = sourceTimeAt(info, lastShown);
        if ("error" in a) return bad(a.error);
        if ("error" in b) return bad(b.error);
        if (a.value < -EPS || b.value < -EPS || Math.max(a.value, b.value) > dur - EPS) {
          return bad(tooFar("The layer's source range", Math.max(b.value, a.value), lastShown, info));
        }
        if (args.loop_type === "pingpong") {
          plan.keys = [
            { time: info.in_point, value: Math.max(a.value, 0), in_interp: "linear", out_interp: "linear" },
            { time: lastShown, value: Math.max(b.value, 0), in_interp: "linear", out_interp: "linear" },
          ];
        } else {
          // loopOut repeats the span between the first and last key. Like AE's own keys, end at the
          // out point, with the source time just past the last shown frame, so the span is the whole
          // clip and no frame is dropped at the seam.
          const end = fix(b.value + cfd);
          if (end > dur + EPS) return bad(tooFar("The loop's end", end, info.out_point, info));
          plan.keys = [
            { time: info.in_point, value: Math.max(a.value, 0), in_interp: "linear", out_interp: "linear" },
            { time: info.out_point, value: Math.min(end, dur), in_interp: "linear", out_interp: "linear" },
          ];
          plan.notes.push("Keys run from the in point to the out point, like AE's own, so each repeat is the whole clip.");
        }
      }
      plan.notes.push("Whether the seam repeats a frame wasn't measured in After Effects; check the loop point.");
      if (plan.out_point === undefined && !args.until) plan.notes.push("The loop only shows once the layer runs past its last key; pass until to extend the layer.");
      return { ok: true, plan };
    }
  }
}

function planRamp(args: TimeRemapArgs, info: RemapInfo, cfd: number): PlanResult {
  const method = args.method ?? "per_frame";
  const outside = args.outside ?? "extend";
  const user: RampPoint[] = [];
  for (const p of args.points ?? []) {
    const t = snapTo(p.time, cfd);
    if (t < info.in_point - cfd * 0.5 - EPS || t > info.out_point + EPS) {
      return bad(`Ramp point at ${p.time}s is outside the layer (${fix(info.in_point)}s to ${fix(info.out_point)}s).`);
    }
    if (user.length && !(t > user[user.length - 1].time + cfd * 0.5)) {
      return bad(`Ramp points must be at least one frame (${fix(cfd)}s) apart and ascending; ${p.time}s lands on ${t}s.`);
    }
    user.push({ time: t, speed: p.speed / 100 });
  }
  let start: number;
  if (args.start_source_time !== undefined) {
    start = args.start_source_time;
  } else {
    const found = sourceTimeAt(info, user[0].time);
    if ("error" in found) return bad(found.error);
    start = found.value;
  }

  // Extend: keep the end speeds going out to the layer's first and last shown frame.
  const points = user.slice();
  let anchor = 0;
  if (outside === "extend") {
    const lastShown = info.out_point - cfd;
    if (user[0].time - info.in_point >= cfd - EPS) {
      points.unshift({ time: info.in_point, speed: user[0].speed });
      anchor = 1;
    }
    const tail = user[user.length - 1];
    if (lastShown - tail.time >= cfd - EPS) points.push({ time: lastShown, speed: tail.speed });
  }
  const values = integrateRamp(points, anchor, start);
  // Only the frames the layer shows count, and a source time is fine up to the end of the
  // source (it lies inside the last source frame), not just up to where that frame starts.
  const range = rampExtremes(points, values, info.out_point - cfd + EPS);
  const { dur } = sourceLimits(info);
  const hint = outside === "extend" ? " Lower the speeds, shorten the layer, or use outside \"hold\" or \"trim\"." : " Lower the speeds or end the ramp earlier.";
  if (range.max > dur - EPS) return bad(tooFar("The ramp", range.max, range.maxAt, info) + hint);
  if (range.min < -EPS) return bad(tooFar("The ramp", range.min, range.minAt, info) + hint);
  if (method === "bezier") {
    // Every key's value has to be a valid Time Remap value, shown or not.
    for (let i = 0; i < points.length; i++) {
      if (values[i] > dur + EPS || values[i] < -EPS) return bad(tooFar("The ramp", values[i], points[i].time, info) + hint);
    }
  }

  const plan = basePlan("ramp", info);
  plan.enable = !info.remap_enabled;
  clearExpression(plan, info);
  const first = points[0].time;
  const lastT = points[points.length - 1].time;
  if (method === "bezier") {
    plan.keys = points.map((p, i) => ({
      time: p.time,
      value: Math.min(Math.max(values[i], 0), dur),
      in_interp: "bezier",
      out_interp: "bezier",
      ease: { in_speed: p.speed, in_influence: THIRD_INFLUENCE, out_speed: p.speed, out_influence: THIRD_INFLUENCE },
    }));
    // Read-back samples: every point and the middle of every segment.
    const times: number[] = [];
    for (let i = 0; i < points.length; i++) {
      times.push(points[i].time);
      if (i + 1 < points.length) times.push(fix((points[i].time + points[i + 1].time) / 2));
    }
    plan.sample_times = times;
    plan.expected_samples = times.map((t) => ({ time: t, value: rampSourceAt(points, values, t) }));
    plan.notes.push("Bezier keys assume the ease speed is source seconds per comp second; the read-back samples the curve against the integral.");
  } else {
    const times: number[] = [first];
    for (let k = 1; first + k * cfd < lastT - cfd * 0.5 + EPS; k++) times.push(fix(first + k * cfd));
    times.push(lastT);
    if (times.length > MAX_PLAN_KEYS) {
      return bad(`A per_frame ramp over ${times.length} frames is more than ${MAX_PLAN_KEYS} keys; use method "bezier" or a shorter ramp.`);
    }
    plan.per_frame = { times, values: times.map((t) => Math.min(Math.max(rampSourceAt(points, values, t), 0), dur)) };
    // The key read-back is capped, so check up to 100 evenly spaced keys by sampling, the last one included.
    const picks = Math.min(times.length, MAX_PLAN_SAMPLES);
    const seen = new Set<number>();
    for (let n = 0; n < picks; n++) {
      const idx = picks === 1 ? 0 : Math.round((n * (times.length - 1)) / (picks - 1));
      if (seen.has(idx)) continue;
      seen.add(idx);
      plan.sample_times.push(times[idx]);
      plan.expected_samples.push({ time: times[idx], value: plan.per_frame.values[idx] });
    }
    plan.notes.push(`${times.length} linear keys, one per frame.`);
  }
  if (outside === "trim") {
    plan.in_point = Math.max(first, info.in_point);
    plan.out_point = Math.min(lastT + cfd, info.out_point);
    plan.notes.push("In and out points moved to the first and last ramp point.");
  }
  const spans = fix(values[values.length - 1] - values[0]);
  plan.notes.push(`Source time runs ${fix(values[0])}s to ${fix(values[values.length - 1])}s (${spans}s) over the ramp.`);
  return { ok: true, plan };
}

// ---------- checks ----------

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Compares the layer read after the write with the plan. */
export function remapMismatches(plan: RemapPlan, beforeRaw: unknown, afterRaw: unknown): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const before = beforeRaw && typeof beforeRaw === "object" ? (beforeRaw as RemapInfo) : null;
  const after = afterRaw && typeof afterRaw === "object" ? (afterRaw as RemapInfo) : null;
  if (!after) return m;
  const cfd = after.comp_frame_duration > 0 ? after.comp_frame_duration : 0.05;
  const sfd = after.source?.frame_duration ?? cfd;

  expectThat(m, after.remap_enabled === plan.expect_remap_enabled, "remap_enabled", plan.expect_remap_enabled, after.remap_enabled, "Time remapping is not in the expected state");

  const wanted: Array<{ time: number; value: number }> | null = plan.keys
    ? plan.keys.map((k) => ({ time: k.time, value: k.value }))
    : plan.per_frame
      ? plan.per_frame.times.map((t, i) => ({ time: t, value: plan.per_frame!.values[i] }))
      : null;
  if (wanted) {
    expectThat(m, after.num_keys === wanted.length, "num_keys", wanted.length, after.num_keys, "The layer has a different number of remap keys than planned");
    const n = Math.min(wanted.length, after.keys.length);
    let shown = 0;
    for (let i = 0; i < n && shown < 5; i++) {
      const k = after.keys[i];
      const w = wanted[i];
      if (Math.abs(k.time - w.time) > cfd * 0.51 + EPS || Math.abs(k.value - w.value) > 1e-3) {
        shown++;
        m.push({ path: `keys[${i + 1}]`, expected: w, actual: { time: k.time, value: k.value }, message: "A remap key differs from the plan" });
      }
    }
    if (plan.keys) {
      for (let i = 0; i < n && shown < 5; i++) {
        const k = after.keys[i];
        const w = plan.keys[i];
        if (k.in_interp !== w.in_interp || k.out_interp !== w.out_interp) {
          shown++;
          m.push({
            path: `keys[${i + 1}].interpolation`,
            expected: [w.in_interp, w.out_interp],
            actual: [k.in_interp, k.out_interp],
            message: "A remap key's interpolation differs from the plan",
          });
        }
      }
      for (let i = 0; i < n && shown < 5; i++) {
        const e = plan.keys[i].ease;
        if (!e) continue;
        const k = after.keys[i];
        const sides: Array<[string, number | undefined, number | undefined, RemapEase | undefined]> = [
          ["in_ease", e.in_speed, e.in_influence, k.in_ease?.[0]],
          ["out_ease", e.out_speed, e.out_influence, k.out_ease?.[0]],
        ];
        for (const [nm, speed, infl, got] of sides) {
          if (speed === undefined && infl === undefined) continue;
          const bad =
            !got ||
            (speed !== undefined && !(Math.abs(got.speed - speed) <= 1e-3)) ||
            (infl !== undefined && !(Math.abs(got.influence - infl) <= 0.01));
          if (bad && shown < 5) {
            shown++;
            m.push({
              path: `keys[${i + 1}].ease`,
              expected: { side: nm, speed, influence: infl },
              actual: got ?? null,
              message: "A remap key's ease differs from the plan (After Effects may have clamped or reset it)",
            });
          }
        }
      }
    }
  }

  // Sampled values: the Bezier ramp against the integral of the speed curve.
  const tol = Math.max(sfd * 0.25, 1e-3);
  for (const e of plan.expected_samples) {
    const got = after.samples.find((s) => Math.abs(s.time - e.time) < 1e-9);
    if (!got || !num(got.value)) {
      m.push({ path: `samples@${e.time}`, expected: e.value, actual: got?.value ?? null, message: "The ramp couldn't be sampled in the read-back" });
      break;
    }
    if (Math.abs(got.value - e.value) > tol) {
      m.push({
        path: `samples@${e.time}`,
        expected: fix(e.value),
        actual: got.value,
        message: plan.per_frame
          ? "A per_frame ramp key's sampled source time differs from the plan"
          : "The Bezier ramp doesn't match the integrated speed curve (the ease speed unit may differ); redo it with method per_frame",
      });
      break;
    }
  }

  if (plan.stretch !== undefined) {
    expectThat(m, num(after.stretch) && Math.abs(after.stretch - plan.stretch) <= 1e-3, "stretch", plan.stretch, after.stretch, "Stretch differs from the plan");
    if (plan.keep_in_point && before) {
      expectThat(
        m,
        Math.abs(after.in_point - before.in_point) <= cfd * 1.01,
        "in_point",
        before.in_point,
        after.in_point,
        "The layer's in point moved with the stretch"
      );
    }
  }
  if (plan.in_point !== undefined) {
    expectThat(m, Math.abs(after.in_point - plan.in_point) <= cfd * 1.01, "in_point", plan.in_point, after.in_point, "In point differs from the plan");
  }
  if (plan.out_point !== undefined) {
    expectThat(m, Math.abs(after.out_point - plan.out_point) <= cfd * 1.01, "out_point", plan.out_point, after.out_point, "Out point differs from the plan (After Effects may cap it at the source)");
  }
  if (plan.expression !== undefined) {
    expectThat(m, after.expression === plan.expression, "expression", plan.expression, after.expression, "The Time Remap expression differs from the plan");
  }
  return m;
}

// ---------- tools ----------

const infoOf = (v: unknown): RemapInfo | null => (v && typeof v === "object" ? (v as RemapInfo) : null);

function summarise(info: RemapInfo | null) {
  if (!info) return null;
  return {
    remap_enabled: info.remap_enabled,
    in_point: info.in_point,
    out_point: info.out_point,
    start_time: info.start_time,
    stretch: info.stretch,
    layer_length: fix(info.out_point - info.in_point),
    source_duration: info.source?.duration ?? null,
    num_keys: info.num_keys,
    expression: info.expression,
  };
}

export const timeremapTools: ToolDefinition<any>[] = [
  {
    name: "ae_get_time_remap",
    description:
      "Read a layer's time remapping: whether it is on, the in, out and start times, stretch, the source's length and frame duration, " +
      "the Time Remap keys (time, source-time value, interpolation, ease) and expression, and the source time shown at the comp times in sample_times. " +
      "Also says why a layer can't be remapped (stills, solids, text, shapes, nulls, cameras, lights). Changes nothing.",
    schema: AeGetTimeRemapSchema,
    handler: async (args: z.infer<typeof AeGetTimeRemapSchema>, ctx) => {
      const res = await ctx.bridge.callHost<RemapInfo>(
        "timeremapRead",
        { comp_id: args.comp_id, layer: args.layer, sample_times: args.sample_times },
        { label: "ae_get_time_remap", mutates: false, toolName: "ae_get_time_remap" }
      );
      return { ok: true, ...res.result };
    },
  },
  {
    name: "ae_time_remap",
    description:
      "Time operations on a footage or precomp layer, in one undo group guarded by `expect`: enable or disable Time Remap, " +
      "freeze a frame, reverse, constant speed (layer.stretch), speed ramps from {time, speed} points, hold the last frame, and loopOut. " +
      "Built from the DOM, since After Effects' Freeze Frame and Time-Reverse commands do nothing through CEP. " +
      "A ramp's source time is integrated in Node and refused if it would run past the source's last frame or before its first; " +
      "method per_frame (default) writes exact linear keys, method bezier writes one eased key per point and is checked by sampling. " +
      "With remapping off and a stretch other than 100, run operation enable first. " +
      "The read-back (a separate evalScript) compares the keys, sampled values, stretch, in and out points and expression with the plan, " +
      "and the result gives the in, out, start, stretch and source length before and after. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeTimeRemapSchema,
    handler: async (args: TimeRemapArgs, ctx) => {
      const readInfo = async (times: number[]) =>
        (
          await ctx.bridge.callHost<RemapInfo>(
            "timeremapRead",
            { comp_id: args.comp_id, layer: args.layer, sample_times: times },
            { label: `ae_time_remap (${args.operation}, plan)`, mutates: false, toolName: "ae_time_remap" }
          )
        ).result;
      let info = await readInfo([]);
      const times = sampleTimesFor(args, info);
      // Source times at comp times only exist while remapping is on.
      if (info.remap_enabled && times.length) info = await readInfo(times);
      const planned = planTimeRemap(args, info);
      if (!planned.ok) return planned;
      const plan = planned.plan;
      const layerId = info.layer.id;
      return runGuardedWrite(ctx, {
        toolName: "ae_time_remap",
        label: `ae_time_remap(${args.operation})`,
        expect: args.expect,
        compId: args.comp_id,
        read: () => ({ host: "timeremapRead", args: { comp_id: args.comp_id, layer: { id: layerId }, sample_times: plan.sample_times } }),
        write: { host: "timeremapApply", args: { comp_id: args.comp_id, layer_id: layerId, plan, label: `Time remap: ${args.operation}` } },
        check: (before, after) => remapMismatches(plan, before, after),
        present: (before, after, w) => {
          const a = infoOf(after);
          return {
            operation: args.operation,
            layer: w.layer ?? info.layer,
            before: summarise(infoOf(before)),
            after: summarise(a),
            keys: a?.keys,
            keys_truncated: a?.keys_truncated,
            enabled_here: w.enabled_here,
            notes: plan.notes,
          };
        },
      });
    },
  },
];
