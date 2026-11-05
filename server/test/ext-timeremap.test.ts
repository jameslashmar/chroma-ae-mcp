import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import { AGENT_SAFETY_GUIDANCE, type ToolContext } from "../src/tools/common.js";
import {
  AeGetTimeRemapSchema,
  AeTimeRemapSchema,
  integrateRamp,
  planTimeRemap,
  rampExtremes,
  rampSourceAt,
  remapFingerprint,
  remapMismatches,
  sampleTimesFor,
  sourceTimeAt,
  THIRD_INFLUENCE,
  timeremapTools,
  type RemapInfo,
  type RemapPlan,
} from "../src/tools/ext/timeremap.js";
import {
  FakeFile,
  FakeProperty,
  FakeProject,
  GUARD,
  ImportOptions,
  KeyframeInterpolationType,
  loadHost,
  PropertyValueType,
  type FakeComp,
  type FakeLayer,
} from "./support/fake-ae.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const tool = (name: string) => timeremapTools.find((t) => t.name === name)!;
const expectArg = { project_path: "<unsaved>" };
const parse = (input: Record<string, unknown>) =>
  AeTimeRemapSchema.parse({ comp_id: 1, layer: { index: 1 }, expect: expectArg, ...input });

/** A PanelHost whose AE answers from a script of results, recording each call. */
function fakeAe(results: Record<string, unknown[]>) {
  const calls: Array<{ fn: string; script: string }> = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-remap-q-"));
  tmpDirs.push(dir);
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
  const host = new PanelHost({
    evalScript: async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      calls.push({ fn, script });
      if (fn === "checkGuard") {
        return { ok: true, result: { ok: true, project_path: "<unsaved>", comp_id: 1, comp_is_valid: true }, durationMs: 1 };
      }
      const next = results[fn]?.shift();
      if (next === undefined) throw new Error(`Unexpected script: ${script}`);
      return { ok: true, result: next, durationMs: 1 };
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge: host, queue, quarantine };
  return { ctx, calls };
}

/** A 25 fps comp, a 4 s clip on a 4 s layer. */
const INFO: RemapInfo = {
  comp_id: 1,
  comp_duration: 4,
  comp_frame_duration: 0.04,
  layer: { index: 1, id: 7, name: "Clip" },
  eligible: true,
  ineligible_reason: null,
  remap_enabled: false,
  in_point: 0,
  out_point: 4,
  start_time: 0,
  stretch: 100,
  source: { id: 5, name: "clip.mov", duration: 4, frame_duration: 0.04, is_comp: false },
  keys: [],
  num_keys: 0,
  keys_truncated: false,
  expression: null,
  expression_enabled: false,
  samples: [],
};
const info = (over: Partial<RemapInfo> = {}): RemapInfo => ({ ...INFO, ...over });
const key = (index: number, time: number, value: number, over: Record<string, unknown> = {}) => ({
  index,
  time,
  value,
  in_interp: "linear",
  out_interp: "linear",
  ...over,
});
/** What AE adds when remapping is switched on: a key at the in and out points. */
const ENABLED = info({ remap_enabled: true, num_keys: 2, keys: [key(1, 0, 0), key(2, 4, 4)] });

const planOf = (input: Record<string, unknown>, i: RemapInfo = INFO): RemapPlan => {
  const r = planTimeRemap(parse(input), i);
  if (!r.ok) throw new Error(r.message);
  return r.plan;
};
const refusal = (input: Record<string, unknown>, i: RemapInfo = INFO): string => {
  const r = planTimeRemap(parse(input), i);
  if (r.ok) throw new Error("expected a refusal");
  return r.message;
};

describe("tool definitions", () => {
  it("exports both tools, and the write ends with the safety guidance", () => {
    expect(timeremapTools.map((t) => t.name)).toEqual(["ae_get_time_remap", "ae_time_remap"]);
    expect(tool("ae_time_remap").description.endsWith(AGENT_SAFETY_GUIDANCE)).toBe(true);
    expect(tool("ae_get_time_remap").description).not.toContain(AGENT_SAFETY_GUIDANCE);
  });
});

describe("schemas", () => {
  const base = { comp_id: 1, layer: { index: 1 }, expect: expectArg };

  it("freeze takes exactly one of at_time and source_time", () => {
    expect(AeTimeRemapSchema.safeParse({ ...base, operation: "freeze" }).success).toBe(false);
    expect(AeTimeRemapSchema.safeParse({ ...base, operation: "freeze", at_time: 1, source_time: 1 }).success).toBe(false);
    expect(AeTimeRemapSchema.safeParse({ ...base, operation: "freeze", at_time: 1 }).success).toBe(true);
    expect(AeTimeRemapSchema.safeParse({ ...base, operation: "freeze", source_time: 1 }).success).toBe(true);
  });

  it("speed and ramp need their parameters, and other operations refuse them", () => {
    expect(AeTimeRemapSchema.safeParse({ ...base, operation: "speed" }).success).toBe(false);
    expect(AeTimeRemapSchema.safeParse({ ...base, operation: "speed", speed_percent: 200 }).success).toBe(true);
    expect(AeTimeRemapSchema.safeParse({ ...base, operation: "ramp" }).success).toBe(false);
    const points = [{ time: 0, speed: 100 }, { time: 1, speed: 50 }];
    expect(AeTimeRemapSchema.safeParse({ ...base, operation: "ramp", points }).success).toBe(true);
    expect(AeTimeRemapSchema.safeParse({ ...base, operation: "reverse", speed_percent: 100 }).success).toBe(false);
    expect(AeTimeRemapSchema.safeParse({ ...base, operation: "enable", until: 3 }).success).toBe(false);
    expect(AeTimeRemapSchema.safeParse({ ...base, operation: "loop", until: 3, loop_type: "pingpong" }).success).toBe(true);
  });

  it("bounds ramps and refuses loop types that run past the source", () => {
    const one = [{ time: 0, speed: 100 }];
    expect(AeTimeRemapSchema.safeParse({ ...base, operation: "ramp", points: one }).success).toBe(false);
    expect(AeTimeRemapSchema.safeParse({ ...base, operation: "loop", loop_type: "offset" }).success).toBe(false);
    expect(AeTimeRemapSchema.safeParse({ ...base, operation: "reverse" }).success).toBe(true);
    expect(AeTimeRemapSchema.safeParse({ comp_id: 1, layer: { index: 1 }, operation: "reverse" }).success).toBe(false);
    expect(AeGetTimeRemapSchema.safeParse({ comp_id: 1, layer: { name: "Clip" }, sample_times: [0, 1] }).success).toBe(true);
    expect(AeGetTimeRemapSchema.safeParse({ comp_id: 1, layer: {} }).success).toBe(false);
  });
});

describe("ramp maths", () => {
  const pts = [
    { time: 0, speed: 1 },
    { time: 2, speed: 0 },
    { time: 4, speed: 2 },
  ];

  it("integrates linear speed segments from an anchor, both ways", () => {
    expect(integrateRamp(pts, 0, 0)).toEqual([0, 1, 3]);
    expect(integrateRamp(pts, 1, 5)).toEqual([4, 5, 7]);
  });

  it("samples the quadratic inside a segment and holds outside", () => {
    const v = integrateRamp(pts, 0, 0);
    expect(rampSourceAt(pts, v, 1)).toBeCloseTo(0.75, 9);
    expect(rampSourceAt(pts, v, 3)).toBeCloseTo(1.5, 9);
    expect(rampSourceAt(pts, v, -1)).toBe(0);
    expect(rampSourceAt(pts, v, 9)).toBe(3);
  });

  it("finds a turning point inside a segment where the speed changes sign", () => {
    const back = [
      { time: 0, speed: 1 },
      { time: 2, speed: -1 },
    ];
    const v = integrateRamp(back, 0, 1);
    expect(v).toEqual([1, 1]);
    const r = rampExtremes(back, v);
    expect(r.max).toBeCloseTo(1.5, 9);
    expect(r.maxAt).toBeCloseTo(1, 9);
    expect(r.min).toBe(1);
  });
});

describe("sourceTimeAt", () => {
  it("is t - startTime at stretch 100 and asks for enable otherwise", () => {
    expect(sourceTimeAt(info({ start_time: 0.5 }), 1)).toEqual({ value: 0.5 });
    expect(sourceTimeAt(info({ stretch: 50 }), 1)).toMatchObject({ error: expect.stringContaining('operation "enable"') });
  });

  it("uses AE's own sample while remapping is on", () => {
    const on = info({ remap_enabled: true, samples: [{ time: 1, value: 2.5 }] });
    expect(sourceTimeAt(on, 1)).toEqual({ value: 2.5 });
    expect(sourceTimeAt(on, 2)).toHaveProperty("error");
  });
});

describe("planTimeRemap", () => {
  it("refuses layers that can't be remapped", () => {
    const solid = info({ eligible: false, ineligible_reason: "the layer's source is a still or a solid (duration 0), so it has no time to remap" });
    expect(refusal({ operation: "enable" }, solid)).toContain("still or a solid");
  });

  it("enable and disable check the current state", () => {
    expect(planOf({ operation: "enable" }).enable).toBe(true);
    expect(refusal({ operation: "enable" }, ENABLED)).toContain("already on");
    const off = planOf({ operation: "disable" }, ENABLED);
    expect(off).toMatchObject({ disable: true, expect_remap_enabled: false });
    expect(refusal({ operation: "disable" })).toContain("already off");
  });

  it("freeze holds one frame, floored to the source frame that contains the time", () => {
    const p = planOf({ operation: "freeze", at_time: 1.51 });
    expect(p.keys).toEqual([{ time: 0, value: 1.48, in_interp: "hold", out_interp: "hold" }]);
    expect(p.enable).toBe(true);
    expect(planOf({ operation: "freeze", source_time: 2 }, ENABLED).enable).toBe(false);
  });

  it("freeze uses the remapped source time and refuses frames outside the layer or the source", () => {
    const on = info({ ...ENABLED, samples: [{ time: 1, value: 3 }] });
    expect(planOf({ operation: "freeze", at_time: 1 }, on).keys?.[0].value).toBe(3);
    expect(refusal({ operation: "freeze", at_time: 5 })).toContain("outside the layer");
    expect(refusal({ operation: "freeze", source_time: 4 })).toContain("last frame starts at 3.96s");
    expect(refusal({ operation: "freeze", at_time: 1 }, info({ stretch: 200 }))).toContain("enable");
  });

  it("reverse writes two keys from the last shown frame back to the first", () => {
    const p = planOf({ operation: "reverse" });
    expect(p.keys?.map((k) => [k.time, k.value])).toEqual([
      [0, 3.96],
      [3.96, 0],
    ]);
  });

  it("reverse mirrors existing keys in time, swapping the sides and negating their ease speeds", () => {
    const eased = info({
      ...ENABLED,
      keys: [
        key(1, 0, 0, { in_interp: "bezier", out_interp: "bezier", in_ease: [{ speed: 0, influence: 20 }], out_ease: [{ speed: 1.5, influence: 30 }] }),
        key(2, 4, 4),
      ],
    });
    const p = planOf({ operation: "reverse" }, eased);
    // The key at the source's full length (4 s) shows nothing, so it is pulled back to the last frame.
    expect(p.keys?.map((k) => [k.time, k.value])).toEqual([
      [0, 3.96],
      [4, 0],
    ]);
    expect(p.keys?.[0].ease).toBeUndefined();
    expect(p.keys?.[1].ease).toEqual({ in_speed: -1.5, in_influence: 30, out_speed: -0, out_influence: 20 });
    expect(p.notes.join(" ")).toContain("pulled back");
    expect(refusal({ operation: "reverse" }, info({ ...ENABLED, keys: [key(1, 0, 2)], num_keys: 1 }))).toContain("at least two");
    expect(refusal({ operation: "reverse" }, info({ ...ENABLED, keys_truncated: true, num_keys: 900 }))).toContain("at most");
  });

  it("reverse plays a non-linear remap backwards instead of mirroring its values", () => {
    const ramp = info({ ...ENABLED, num_keys: 3, keys: [key(1, 0, 0), key(2, 2, 1), key(3, 4, 3)] });
    const p = planOf({ operation: "reverse" }, ramp);
    // 50% then 100% becomes 100% backwards then 50% backwards.
    expect(p.keys?.map((k) => [k.time, k.value])).toEqual([
      [0, 3],
      [2, 1],
      [4, 0],
    ]);
    const held = info({ ...ENABLED, keys: [key(1, 0, 0), key(2, 4, 3, { in_interp: "hold" })] });
    expect(refusal({ operation: "reverse" }, held)).toContain("hold interpolation");
  });

  it("reverse keeps a Bezier side's ease when the other side is linear", () => {
    const mixed = info({
      ...ENABLED,
      keys: [key(1, 0, 0, { out_interp: "bezier", out_ease: [{ speed: 1, influence: 30 }] }), key(2, 4, 3)],
    });
    const p = planOf({ operation: "reverse" }, mixed);
    expect(p.keys?.[1]).toMatchObject({ time: 4, in_interp: "bezier", out_interp: "linear", ease: { in_speed: -1, in_influence: 30 } });
    expect(p.keys?.[1].ease).not.toHaveProperty("out_speed");
  });

  it("freeze, ramp, reverse and hold_last_frame clear a Time Remap expression and say so; loop notes the one it replaces", () => {
    const looped = info({ ...ENABLED, comp_duration: 6, expression: 'loopOut("cycle")', expression_enabled: true, samples: [{ time: 1, value: 1 }] });
    const frozen = planOf({ operation: "freeze", at_time: 1 }, looped);
    expect(frozen.expression).toBe("");
    expect(frozen.notes.join(" ")).toContain("Cleared");
    expect(planOf({ operation: "reverse" }, looped).expression).toBe("");
    expect(planOf({ operation: "hold_last_frame" }, looped).expression).toBe("");
    const ramp = planOf({ operation: "ramp", points: [{ time: 0, speed: 100 }, { time: 1, speed: 100 }] }, { ...looped, samples: [{ time: 0, value: 0 }] });
    expect(ramp.expression).toBe("");
    // Nothing else to hold, but the expression still stops the hold.
    const fine = info({ ...ENABLED, keys: [key(1, 0, 0), key(2, 3, 3)], expression: 'loopOut("cycle")' });
    expect(planOf({ operation: "hold_last_frame", until: 3.5 }, fine).expression).toBe("");
    // No expression: left alone.
    expect(planOf({ operation: "reverse" }).expression).toBeUndefined();
    expect(planOf({ operation: "reverse" }, ENABLED).expression).toBeUndefined();
    const lp = planOf({ operation: "loop", loop_type: "pingpong" }, looped);
    expect(lp.notes.join(" ")).toContain("Replaced the layer's existing Time Remap expression");
  });

  it("speed becomes a stretch within AE's limits, and not while remapping is on", () => {
    expect(planOf({ operation: "speed", speed_percent: 200 })).toMatchObject({ stretch: 50, keep_in_point: true, expect_remap_enabled: false });
    expect(planOf({ operation: "speed", speed_percent: -100 }).stretch).toBe(-100);
    expect(refusal({ operation: "speed", speed_percent: 0.5 })).toContain("1 to 9900");
    expect(refusal({ operation: "speed", speed_percent: 20000 })).toContain("1 to 9900");
    expect(refusal({ operation: "speed", speed_percent: 100 })).toContain("already");
    expect(refusal({ operation: "speed", speed_percent: 200 }, ENABLED)).toContain("remapping is on");
  });

  it("a per-frame ramp integrates the speed curve into one key per frame", () => {
    const p = planOf({ operation: "ramp", points: [{ time: 0, speed: 100 }, { time: 2, speed: 0 }] });
    // Extended at speed 0 out to the last shown frame (3.96 s).
    expect(p.per_frame?.times.length).toBe(100);
    expect(p.per_frame?.times[0]).toBe(0);
    expect(p.per_frame?.times[99]).toBe(3.96);
    expect(p.per_frame?.values[50]).toBeCloseTo(1, 9);
    expect(p.per_frame?.values[25]).toBeCloseTo(0.75, 9);
    expect(p.per_frame?.values[99]).toBeCloseTo(1, 9);
    expect(p.keys).toBeUndefined();
  });

  it("a bezier ramp writes one eased key per point and plans the samples to compare", () => {
    const p = planOf({ operation: "ramp", method: "bezier", points: [{ time: 0, speed: 100 }, { time: 2, speed: 0 }] });
    expect(p.keys?.map((k) => [k.time, k.value])).toEqual([
      [0, 0],
      [2, 1],
      [3.96, 1],
    ]);
    expect(p.keys?.[0].ease).toEqual({ in_speed: 1, in_influence: THIRD_INFLUENCE, out_speed: 1, out_influence: THIRD_INFLUENCE });
    expect(p.sample_times).toEqual([0, 1, 2, 2.98, 3.96]);
    expect(p.expected_samples[1].value).toBeCloseTo(0.75, 9);
  });

  it("a ramp anchors at start_source_time, extends to the in point, and trims on request", () => {
    const mid = info({ in_point: 0, out_point: 4 });
    const p = planOf({ operation: "ramp", method: "bezier", start_source_time: 1, points: [{ time: 1, speed: 100 }, { time: 2, speed: 100 }], outside: "extend" }, mid);
    // Prepended point at the in point, the same 100% going back to 0.
    expect(p.keys?.[0]).toMatchObject({ time: 0, value: 0 });
    expect(p.keys?.[1]).toMatchObject({ time: 1, value: 1 });
    const t = planOf({ operation: "ramp", method: "bezier", outside: "trim", points: [{ time: 1, speed: 100 }, { time: 2, speed: 100 }] }, mid);
    expect(t.keys?.length).toBe(2);
    expect(t).toMatchObject({ in_point: 1, out_point: 2.04 });
    const h = planOf({ operation: "ramp", method: "bezier", outside: "hold", points: [{ time: 1, speed: 100 }, { time: 2, speed: 100 }] }, mid);
    expect(h.keys?.length).toBe(2);
    expect(h.in_point).toBeUndefined();
  });

  // A 30 fps comp over 24 fps footage: the last shown comp frame (3.9667 s) is later than where
  // the source's last frame starts (3.9583 s) but still inside it.
  const MIXED = info({
    comp_frame_duration: 1 / 30,
    source: { id: 5, name: "clip.mov", duration: 4, frame_duration: 1 / 24, is_comp: false },
  });

  it("accepts a full-length layer when the comp's frames are shorter than the source's", () => {
    const rev = planOf({ operation: "reverse" }, MIXED);
    expect(rev.keys?.[0].value).toBeCloseTo(4 - 1 / 30, 6);
    expect(rev.keys?.[1].value).toBe(0);
    const unit = planOf({ operation: "ramp", method: "bezier", points: [{ time: 0, speed: 100 }, { time: 2, speed: 100 }] }, MIXED);
    expect(unit.keys?.[unit.keys.length - 1].value).toBeCloseTo(4 - 1 / 30, 6);
    // A last point at the out point is a frame that is never shown.
    expect(() => planOf({ operation: "ramp", outside: "hold", points: [{ time: 0, speed: 100 }, { time: 4, speed: 100 }] }, MIXED)).not.toThrow();
    expect(() => planOf({ operation: "loop", until: 10 }, MIXED)).not.toThrow();
  });

  it("still refuses a shown source time at or past the end of the source", () => {
    expect(refusal({ operation: "ramp", points: [{ time: 0, speed: 100 }, { time: 1, speed: 101 }] }, MIXED)).toContain("source ends at 4s");
    expect(refusal({ operation: "reverse" }, info({ ...MIXED, start_time: -0.1 }))).toContain("source ends at 4s");
  });

  it("freeze takes the frame on screen, not the nearest one, when the frame rates differ", () => {
    // Comp frame 1 (1/30 s) is inside source frame 0 (0 to 1/24 s).
    expect(planOf({ operation: "freeze", at_time: 1 / 30 }, MIXED).keys?.[0].value).toBe(0);
    expect(planOf({ operation: "freeze", at_time: 29 / 30 }, MIXED).keys?.[0].value).toBeCloseTo(23 / 24, 6);
  });

  it("refuses a ramp that runs past the source or before it, and bad points", () => {
    const fast = [{ time: 0, speed: 100 }, { time: 2, speed: 300 }];
    expect(refusal({ operation: "ramp", points: fast })).toContain("last frame starts at 3.96s");
    // outside hold only checks the ramp itself: 0 -> 4 s of source.
    expect(refusal({ operation: "ramp", outside: "hold", points: fast })).toContain("3.96");
    expect(refusal({ operation: "ramp", outside: "hold", points: [{ time: 0, speed: 100 }, { time: 2, speed: -300 }] })).toContain("before the first frame");
    expect(refusal({ operation: "ramp", points: [{ time: 1, speed: 100 }, { time: 1.01, speed: 100 }] })).toContain("one frame");
    expect(refusal({ operation: "ramp", points: [{ time: 0, speed: 100 }, { time: 9, speed: 100 }] })).toContain("outside the layer");
    expect(refusal({ operation: "ramp", points: [{ time: 0, speed: 100 }, { time: 1, speed: 100 }] }, info({ stretch: 50 }))).toContain("enable");
  });

  it("a long per-frame ramp is refused with a pointer to bezier", () => {
    const long = info({ comp_duration: 4000, out_point: 4000, source: { id: 5, name: "x", duration: 5000, frame_duration: 0.04, is_comp: false } });
    expect(refusal({ operation: "ramp", outside: "hold", points: [{ time: 0, speed: 100 }, { time: 3900, speed: 100 }] }, long)).toContain("bezier");
  });

  it("hold_last_frame keys the run to the last frame and extends the out point", () => {
    const long = info({ comp_duration: 6 });
    const p = planOf({ operation: "hold_last_frame" }, long);
    expect(p.keys?.map((k) => [k.time, k.value])).toEqual([
      [0, 0],
      [3.96, 3.96],
    ]);
    expect(p.out_point).toBe(6);
    expect(refusal({ operation: "hold_last_frame", until: 3.5 }, long)).toContain("last frame shows at 3.96s");
  });

  it("hold_last_frame on a remapped layer clamps a last key at the full length", () => {
    const over = info({ ...ENABLED, comp_duration: 6 });
    const p = planOf({ operation: "hold_last_frame" }, over);
    expect(p.keys?.map((k) => k.value)).toEqual([0, 3.96]);
    expect(p.out_point).toBe(6);
    const fine = info({ ...ENABLED, comp_duration: 6, keys: [key(1, 0, 0), key(2, 3, 3)] });
    expect(planOf({ operation: "hold_last_frame" }, fine).keys).toBeUndefined();
    expect(refusal({ operation: "hold_last_frame" }, ENABLED)).toContain("nothing to hold");
    expect(refusal({ operation: "hold_last_frame", until: 3.5 }, fine)).toContain("Nothing to change");
  });

  it("loop sets loopOut, writing the keys itself when remapping is off", () => {
    const p = planOf({ operation: "loop", until: 10 });
    expect(p.expression).toBe('loopOut("cycle")');
    // Like AE's own keys: in point to out point, so a repeat is the whole clip.
    expect(p.keys?.map((k) => [k.time, k.value])).toEqual([
      [0, 0],
      [4, 4],
    ]);
    expect(p.out_point).toBe(10);
    const pp = planOf({ operation: "loop", loop_type: "pingpong", until: 10 });
    expect(pp.keys?.map((k) => [k.time, k.value])).toEqual([
      [0, 0],
      [3.96, 3.96],
    ]);
    const on = planOf({ operation: "loop", loop_type: "pingpong" }, ENABLED);
    expect(on.expression).toBe('loopOut("pingpong")');
    expect(on.keys).toBeUndefined();
    expect(refusal({ operation: "loop" }, info({ ...ENABLED, keys: [key(1, 0, 0)], num_keys: 1 }))).toContain("two Time Remap keys");
  });

  it("a looped cycle drops no frame at the seam", () => {
    for (const i of [INFO, MIXED]) {
      const p = planOf({ operation: "loop", until: 10 }, i);
      const [k0, k1] = p.keys!;
      const period = k1.time - k0.time;
      expect(period).toBeCloseTo(i.out_point - i.in_point, 9);
      // loopOut("cycle") repeats the span between the first and last key.
      const at = (t: number) => k0.value + (((t - k0.time) % period) / period) * (k1.value - k0.value);
      const cfd = i.comp_frame_duration;
      const sfd = i.source!.frame_duration;
      const n = Math.round(period / cfd);
      const shown: number[] = [];
      for (let f = 0; f < n * 2; f++) shown.push(Math.floor(at(f * cfd + 1e-9) / sfd + 1e-6));
      // The second pass shows the same frames as the first, starting again at frame 0.
      expect(shown.slice(n)).toEqual(shown.slice(0, n));
      expect(shown[0]).toBe(0);
      expect(shown[n - 1]).toBe(Math.floor((period - cfd) / sfd + 1e-6));
    }
  });

  it("the plan's snapshot carries the remap keys' fingerprint, and it changes with the keys, expression and source", () => {
    const a = remapFingerprint(ENABLED);
    expect(planOf({ operation: "reverse" }, ENABLED).snapshot).toMatchObject({ num_keys: 2, fingerprint: a });
    expect(remapFingerprint(info({ ...ENABLED, keys: [key(1, 0, 0), key(2, 4, 3)] }))).not.toBe(a);
    expect(remapFingerprint(info({ ...ENABLED, expression: "x" }))).not.toBe(a);
    expect(remapFingerprint(info({ ...ENABLED, source: { ...INFO.source!, id: 9 } }))).not.toBe(a);
    expect(remapFingerprint(ENABLED)).toBe(a);
  });

  it("asks for samples only where the source time has to be read", () => {
    expect(sampleTimesFor(parse({ operation: "freeze", at_time: 1.5 }), INFO)).toEqual([1.5]);
    expect(sampleTimesFor(parse({ operation: "ramp", points: [{ time: 0.51, speed: 100 }, { time: 1, speed: 100 }] }), INFO)).toEqual([0.52]);
    expect(sampleTimesFor(parse({ operation: "reverse" }), INFO)).toEqual([]);
  });
});

describe("remapMismatches", () => {
  const frozen = planOf({ operation: "freeze", source_time: 2 });
  const after = (over: Partial<RemapInfo> = {}) => info({ remap_enabled: true, num_keys: 1, keys: [key(1, 0, 2, { in_interp: "hold", out_interp: "hold" })], ...over });

  it("accepts what the plan says", () => {
    expect(remapMismatches(frozen, INFO, after())).toEqual([]);
  });

  it("flags remapping left off, a missing key, a wrong value and a wrong interpolation", () => {
    expect(remapMismatches(frozen, INFO, after({ remap_enabled: false })).map((m) => m.path)).toEqual(["remap_enabled"]);
    expect(remapMismatches(frozen, INFO, after({ num_keys: 2 })).map((m) => m.path)).toEqual(["num_keys"]);
    expect(remapMismatches(frozen, INFO, after({ keys: [key(1, 0, 2.5, { in_interp: "hold", out_interp: "hold" })] })).map((m) => m.path)).toEqual(["keys[1]"]);
    expect(remapMismatches(frozen, INFO, after({ keys: [key(1, 0, 2)] })).map((m) => m.path)).toEqual(["keys[1].interpolation"]);
  });

  it("flags a Bezier curve that doesn't match the integral, naming the fallback", () => {
    const plan = planOf({ operation: "ramp", method: "bezier", points: [{ time: 0, speed: 100 }, { time: 2, speed: 0 }] });
    const good = plan.expected_samples.map((s) => ({ time: s.time, value: s.value }));
    const on = (samples: typeof good) =>
      info({ remap_enabled: true, num_keys: 3, keys: plan.keys!.map((k, i) => key(i + 1, k.time, k.value, { in_interp: "bezier", out_interp: "bezier", in_ease: [{ speed: k.ease!.in_speed, influence: k.ease!.in_influence }], out_ease: [{ speed: k.ease!.out_speed, influence: k.ease!.out_influence }] })), samples });
    expect(remapMismatches(plan, INFO, on(good))).toEqual([]);
    const off = good.map((s, i) => (i === 1 ? { ...s, value: s.value * 100 } : s));
    const m = remapMismatches(plan, INFO, on(off));
    expect(m.map((x) => x.path)).toEqual(["samples@1"]);
    expect(m[0].message).toContain("per_frame");
    expect(remapMismatches(plan, INFO, on([])).map((x) => x.path)).toEqual(["samples@0"]);
  });

  it("checks stretch, a kept in point, in and out points and the expression", () => {
    const speed = planOf({ operation: "speed", speed_percent: 200 });
    expect(remapMismatches(speed, INFO, info({ stretch: 50 }))).toEqual([]);
    expect(remapMismatches(speed, INFO, info({ stretch: 50, in_point: 1 })).map((m) => m.path)).toEqual(["in_point"]);
    expect(remapMismatches(speed, INFO, info({ stretch: 100 })).map((m) => m.path)).toEqual(["stretch"]);
    const loop = planOf({ operation: "loop", until: 10 }, ENABLED);
    const looped = (over: Partial<RemapInfo>) => info({ ...ENABLED, expression: 'loopOut("cycle")', out_point: 10, ...over });
    expect(remapMismatches(loop, ENABLED, looped({}))).toEqual([]);
    expect(remapMismatches(loop, ENABLED, looped({ out_point: 4, expression: "" })).map((m) => m.path)).toEqual(["out_point", "expression"]);
  });

  it("checks a per_frame ramp past the 500 keys the read returns, by sampling", () => {
    const long = planOf({ operation: "ramp", points: [{ time: 0, speed: 100 }, { time: 40, speed: 100 }] }, info({ comp_duration: 60, out_point: 60, source: { ...INFO.source!, duration: 100 } }));
    expect(long.per_frame!.times.length).toBeGreaterThan(500);
    expect(long.expected_samples.length).toBeLessThanOrEqual(100);
    expect(long.sample_times[long.sample_times.length - 1]).toBe(long.per_frame!.times[long.per_frame!.times.length - 1]);
    const good = long.expected_samples.map((e) => ({ time: e.time, value: e.value }));
    const keys = long.per_frame!.times.slice(0, 500).map((t, i) => key(i + 1, t, long.per_frame!.values[i]));
    const on = (samples: typeof good) => info({ remap_enabled: true, num_keys: long.per_frame!.times.length, keys, samples });
    expect(remapMismatches(long, INFO, on(good))).toEqual([]);
    const bad = good.map((g, i) => (i === good.length - 1 ? { ...g, value: g.value + 1 } : g));
    const m = remapMismatches(long, INFO, on(bad));
    expect(m).toHaveLength(1);
    expect(m[0].message).toContain("per_frame");
  });

  it("flags a Bezier key whose ease After Effects dropped or changed", () => {
    const plan = planOf({ operation: "ramp", method: "bezier", points: [{ time: 0, speed: 100 }, { time: 2, speed: 0 }] });
    const good = plan.expected_samples.map((s) => ({ time: s.time, value: s.value }));
    const keysWith = (ease: (i: number) => Record<string, unknown>) =>
      plan.keys!.map((k, i) => key(i + 1, k.time, k.value, { in_interp: "bezier", out_interp: "bezier", ...ease(i) }));
    const on = (keys: ReturnType<typeof keysWith>) => info({ remap_enabled: true, num_keys: 3, keys, samples: good });
    const exact = (i: number) => ({
      in_ease: [{ speed: plan.keys![i].ease!.in_speed, influence: plan.keys![i].ease!.in_influence }],
      out_ease: [{ speed: plan.keys![i].ease!.out_speed, influence: plan.keys![i].ease!.out_influence }],
    });
    expect(remapMismatches(plan, INFO, on(keysWith(exact)))).toEqual([]);
    const reset = remapMismatches(plan, INFO, on(keysWith((i) => (i === 1 ? { in_ease: [{ speed: 0, influence: 16.67 }], out_ease: exact(i).out_ease } : exact(i)))));
    expect(reset.map((x) => x.path)).toEqual(["keys[2].ease"]);
    const dropped = remapMismatches(plan, INFO, on(keysWith((i) => (i === 0 ? {} : exact(i)))));
    expect(dropped.map((x) => x.path)).toEqual(["keys[1].ease", "keys[1].ease"]);
  });

  it("refuses to freeze at the layer's out point and reports the requested time", () => {
    const r = planTimeRemap(parse({ operation: "freeze", at_time: 4 }), INFO);
    expect(r.ok).toBe(false);
    const r2 = planTimeRemap(parse({ operation: "freeze", at_time: 3.96 }), INFO);
    expect(r2.ok).toBe(true);
    const far = planTimeRemap(parse({ operation: "freeze", at_time: 3.5 }), info({ source: { ...INFO.source!, duration: 1 } }));
    expect(far.ok).toBe(false);
    if (!far.ok) expect(far.message).toContain("comp time 3.5s");
  });

  it("does nothing without a read-back", () => {
    expect(remapMismatches(frozen, INFO, null)).toEqual([]);
  });
});

describe("ae_time_remap flow", () => {
  it("plans from a read, then guards, reads, writes and reads back in separate calls", async () => {
    const afterInfo = info({ remap_enabled: true, num_keys: 1, keys: [key(1, 0, 1.48, { in_interp: "hold", out_interp: "hold" })] });
    const { ctx, calls } = fakeAe({
      timeremapRead: [INFO, INFO, afterInfo],
      timeremapApply: [{ layer: { index: 1, id: 7, name: "Clip" }, operation: "freeze", enabled_here: true, keys_written: 1 }],
    });
    const out: any = await tool("ae_time_remap").handler(parse({ operation: "freeze", at_time: 1.51 }), ctx);
    expect(calls.map((c) => c.fn)).toEqual(["timeremapRead", "checkGuard", "timeremapRead", "timeremapApply", "timeremapRead"]);
    expect(calls[3].script).toContain('"layer_id":7');
    expect(calls[3].script).toContain('"expect"');
    expect(calls[4].script).toContain('"id":7');
    expect(out.receipt.matches).toBe(true);
    expect(out.before).toMatchObject({ remap_enabled: false, stretch: 100, source_duration: 4, layer_length: 4 });
    expect(out.after).toMatchObject({ remap_enabled: true, num_keys: 1 });
    expect(out.enabled_here).toBe(true);
  });

  it("reads the remapped source time first when the plan needs it", async () => {
    const withSample = info({ ...ENABLED, samples: [{ time: 1.5, value: 2 }] });
    const { ctx, calls } = fakeAe({
      timeremapRead: [ENABLED, withSample, withSample, withSample],
      timeremapApply: [{ enabled_here: false }],
    });
    const out: any = await tool("ae_time_remap").handler(parse({ operation: "freeze", at_time: 1.5 }), ctx);
    expect(calls.map((c) => c.fn)).toEqual(["timeremapRead", "timeremapRead", "checkGuard", "timeremapRead", "timeremapApply", "timeremapRead"]);
    expect(calls[1].script).toContain("[1.5]");
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches.map((m: { path: string }) => m.path)).toContain("num_keys");
  });

  it("refuses before touching AE when the plan can't be made", async () => {
    const { ctx, calls } = fakeAe({ timeremapRead: [INFO] });
    const out: any = await tool("ae_time_remap").handler(parse({ operation: "ramp", points: [{ time: 0, speed: 100 }, { time: 2, speed: 300 }] }), ctx);
    expect(out).toMatchObject({ ok: false, error: "bad_args" });
    expect(out.message).toContain("last frame");
    expect(calls.map((c) => c.fn)).toEqual(["timeremapRead"]);
  });

  it("reports a failed read-back in the receipt instead of throwing", async () => {
    const results: Record<string, unknown[]> = { timeremapRead: [INFO, INFO], timeremapApply: [{ enabled_here: true }] };
    const { ctx } = fakeAe(results);
    const out: any = await tool("ae_time_remap").handler(parse({ operation: "freeze", source_time: 1 }), ctx);
    expect(out.applied).toBe(true);
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches[0].path).toBe("read_back");
  });

  it("ae_get_time_remap reads through the host and changes nothing", async () => {
    const { ctx, calls } = fakeAe({ timeremapRead: [ENABLED] });
    const out: any = await tool("ae_get_time_remap").handler(AeGetTimeRemapSchema.parse({ comp_id: 1, layer: { index: 1 }, sample_times: [1] }), ctx);
    expect(calls.map((c) => c.fn)).toEqual(["timeremapRead"]);
    expect(out).toMatchObject({ ok: true, remap_enabled: true, num_keys: 2 });
  });
});

// ---------- the host functions under node:vm ----------

/** Gives a fake layer a Time Remap property that appears and disappears with the switch, as in AE. */
function remapable(layer: FakeLayer, duration: number, opts: { failExpression?: boolean } = {}) {
  let enabled = false;
  const prop = new FakeProperty("Time Remap", "ADBE Time Remapping", PropertyValueType.OneD, 0);
  if (opts.failExpression) {
    Object.defineProperty(prop, "expression", {
      get: () => "",
      set: () => {
        throw new Error("expression engine refused");
      },
    });
  }
  // Real AE (26.2.1, probed): removing the last key of Time Remap switches the layer's remapping
  // off and hides the property; a hidden property refuses every write until the switch is cycled.
  // The expression text survives a disable and comes back with the next enable.
  let hidden = false;
  const hiddenError = (what: string) =>
    new Error(`After Effects error: Can not “${what}” with this property, because the property or a parent property is hidden.`);
  const baseSet = prop.setValueAtTime.bind(prop);
  const baseRemove = prop.removeKey.bind(prop);
  prop.setValueAtTime = (t: number, raw: unknown) => {
    if (hidden) throw hiddenError("set value at time");
    baseSet(t, raw);
  };
  prop.setValuesAtTimes = (ts: number[], vs: unknown[]) => {
    if (hidden) throw hiddenError("set value at times");
    ts.forEach((t, i) => baseSet(t, vs[i]));
  };
  prop.removeKey = (i: number) => {
    baseRemove(i);
    if (prop.numKeys === 0) {
      hidden = true;
      enabled = false;
    }
  };
  Object.defineProperty(layer, "timeRemapEnabled", {
    get: () => enabled,
    set: (on: boolean) => {
      enabled = on;
      layer.group.props = layer.group.props.filter((p) => p !== prop);
      prop.keys = [];
      hidden = false;
      if (on) {
        layer.group.props.push(prop);
        prop.parentProperty = layer.group;
        prop.setValueAtTime(layer.inPoint, 0);
        prop.setValueAtTime(layer.outPoint, duration);
      }
    },
  });
  Object.assign(layer, { canSetTimeRemapEnabled: true });
  return prop;
}

function scene(opts: { compSeconds?: number; layerOut?: number; failExpression?: boolean } = {}) {
  const project = new FakeProject();
  const comp = project.addComp("Main", 640, 360, opts.compSeconds ?? 4);
  const footage = project.importFile(new ImportOptions(new FakeFile("C:/clips/640x360_25fps_100f.mov") as never));
  const layer = comp.layers.add(footage, opts.layerOut) as FakeLayer;
  const prop = remapable(layer, footage.duration, { failExpression: opts.failExpression });
  const { A, undo } = loadHost(project, ["timeremap.jsx", "keyframes.jsx"]);
  const read = (times: number[] = []): RemapInfo => A.timeremapRead({ comp_id: comp.id, layer: { id: layer.id }, sample_times: times });
  const run = (input: Record<string, unknown>, label = "") => {
    let i = read();
    const args = parse({ comp_id: comp.id, layer: { id: layer.id }, ...input });
    const times = sampleTimesFor(args, i);
    if (i.remap_enabled && times.length) i = read(times);
    const planned = planTimeRemap(args, i);
    if (!planned.ok) throw new Error(`${label}${planned.message}`);
    return { plan: planned.plan, apply: (extra: Record<string, unknown> = {}) => A.timeremapApply({ comp_id: comp.id, layer_id: layer.id, plan: planned.plan, expect: GUARD, ...extra }) };
  };
  return { project, comp: comp as FakeComp, footage, layer, prop, A, undo, read, run };
}

describe("timeremap.jsx", () => {
  it("reads without changing anything, and says why a layer can't be remapped", () => {
    const s = scene();
    const solid = s.comp.layers.addSolid([1, 0, 0], "BG", 640, 360, 1, 4);
    const nul = s.comp.layers.addNull(4);
    const i = s.read();
    expect(i).toMatchObject({ eligible: true, remap_enabled: false, in_point: 0, out_point: 4, stretch: 100, comp_frame_duration: 0.04 });
    expect(i.source).toMatchObject({ duration: 4, frame_duration: 0.04, is_comp: false });
    const asSolid = s.A.timeremapRead({ comp_id: s.comp.id, layer: { id: solid.id } });
    expect(asSolid.eligible).toBe(false);
    expect(asSolid.ineligible_reason).toContain("still or a solid");
    expect(s.A.timeremapRead({ comp_id: s.comp.id, layer: { id: nul.id } }).ineligible_reason).toContain("no footage or comp source");
    expect(s.layer.timeRemapEnabled).toBe(false);
    expect(s.undo.begun).toBe(0);
  });

  it("freezes a frame: remap on, one hold key", () => {
    const s = scene();
    const out = s.run({ operation: "freeze", at_time: 1.52 }).apply();
    expect(out).toMatchObject({ operation: "freeze", enabled_here: true, keys_written: 1 });
    expect(s.layer.timeRemapEnabled).toBe(true);
    expect(s.prop.numKeys).toBe(1);
    expect(s.prop.keyValue(1)).toBe(1.52);
    expect(s.prop.keyOutInterpolationType(1)).toBe(KeyframeInterpolationType.HOLD);
    expect(s.prop.valueAtTime(3, false)).toBe(1.52);
    expect(s.undo).toEqual({ begun: 1, ended: 1 });
    const back = s.read([2]);
    expect(back).toMatchObject({ remap_enabled: true, num_keys: 1 });
    expect(back.samples[0]).toEqual({ time: 2, value: 1.52 });
  });

  it("freezes the frame an already remapped layer shows, replacing its keys", () => {
    const s = scene();
    s.run({ operation: "enable" }).apply();
    expect(s.prop.numKeys).toBe(2);
    s.run({ operation: "freeze", at_time: 2 }).apply();
    expect(s.prop.numKeys).toBe(1);
    expect(s.prop.keyValue(1)).toBe(2);
  });

  it("replaces the keys of a remapped layer without ever emptying Time Remap (AE hides it at zero keys)", () => {
    const s = scene();
    s.run({ operation: "enable" }).apply();
    expect(s.prop.numKeys).toBe(2);
    // freeze: one key, neither of the two AE made at 0 and 4
    expect(() => s.run({ operation: "freeze", at_time: 1.52 }).apply()).not.toThrow();
    expect(s.prop.numKeys).toBe(1);
    expect(s.prop.keyTime(1)).toBe(0);
    // a per-frame ramp over a single-key layer, then a Bezier one
    expect(() => s.run({ operation: "ramp", method: "per_frame", points: [{ time: 0, speed: 100 }, { time: 2, speed: 0 }] }).apply()).not.toThrow();
    expect(s.prop.numKeys).toBeGreaterThan(2);
    expect(() => s.run({ operation: "ramp", method: "bezier", points: [{ time: 0, speed: 100 }, { time: 2, speed: 0 }] }).apply()).not.toThrow();
    expect(() => s.run({ operation: "reverse" }).apply()).not.toThrow();
    expect(() => s.run({ operation: "loop", loop_type: "cycle" }).apply()).not.toThrow();
    expect(s.prop.numKeys).toBeGreaterThan(0);
    expect(() => s.run({ operation: "disable" }).apply()).not.toThrow();
    expect(s.layer.timeRemapEnabled).toBe(false);
  });

  it("a Time Remap expression that AE kept through a disable does not act on the keys of a later enable", () => {
    const s = scene();
    s.run({ operation: "loop", loop_type: "cycle" }).apply();
    expect(s.prop.expression).toBe('loopOut("cycle")');
    s.run({ operation: "disable" }).apply();
    expect(s.layer.timeRemapEnabled).toBe(false);
    // AE keeps the text while remapping is off (probed): the next enable has to start clean.
    expect(s.prop.expression).toBe('loopOut("cycle")');
    s.run({ operation: "reverse" }).apply();
    expect(s.layer.timeRemapEnabled).toBe(true);
    expect(s.prop.expression).toBe("");
    s.run({ operation: "disable" }).apply();
    s.run({ operation: "enable" }).apply();
    expect(s.prop.expression).toBe("");
  });

  it("ae_remove_keyframes refuses to take the last Time Remap key, which would switch remapping off", () => {
    const s = scene();
    s.run({ operation: "enable" }).apply();
    const args = { comp_id: s.comp.id, layer: { id: s.layer.id }, path: ["ADBE Time Remapping"], expect: GUARD };
    const undoBefore = { ...s.undo };
    // Every key, by all, by index and by range, is the same removal.
    expect(() => s.A.removeKeys({ ...args, all: true })).toThrow(/switch time remapping off/);
    expect(() => s.A.removeKeys({ ...args, keys: [1, 2] })).toThrow(/ae_time_remap with operation disable/);
    expect(() => s.A.removeKeys({ ...args, start: 0, end: 10 })).toThrow(/switch time remapping off/);
    expect(s.prop.numKeys).toBe(2);
    expect(s.layer.timeRemapEnabled).toBe(true);
    expect(s.undo).toEqual(undoBefore);
    // One key left is fine, and the property stays writable.
    const w = s.A.removeKeys({ ...args, keys: [2] });
    expect(w.numKeys).toBe(1);
    expect(s.layer.timeRemapEnabled).toBe(true);
    expect(() => s.run({ operation: "freeze", source_time: 1 }).apply()).not.toThrow();
  });

  it("ae_remove_keyframes reports a property that refuses setValue once its keys are gone, instead of throwing after the removal", () => {
    const s = scene();
    const opacity = s.layer.transform("ADBE Opacity") as any;
    opacity.setValuesAtTimes([0, 1], [20, 60]);
    opacity.setValue = () => {
      throw new Error("After Effects error: Can not “set value” with this property, because the property or a parent property is hidden.");
    };
    const w = s.A.removeKeys({ comp_id: s.comp.id, layer: { id: s.layer.id }, path: ["ADBE Transform Group", "ADBE Opacity"], all: true, expect: GUARD });
    expect(w.numKeys).toBe(0);
    expect(w.removed).toHaveLength(2);
    expect(w.static_value_error).toContain("hidden");
    expect(w.static_value).toBeUndefined();
    expect(s.undo).toEqual({ begun: 1, ended: 1 });
  });

  it("reverses with two linear keys, and mirrors an already remapped layer", () => {
    const s = scene();
    s.run({ operation: "reverse" }).apply();
    expect([s.prop.keyTime(1), s.prop.keyValue(1), s.prop.keyTime(2), s.prop.keyValue(2)]).toEqual([0, 3.96, 3.96, 0]);
    expect(s.prop.valueAtTime(1.98, false)).toBeCloseTo(1.98, 9);
    // Mirrored again: forwards.
    s.run({ operation: "reverse" }).apply();
    expect([s.prop.keyValue(1), s.prop.keyValue(2)]).toEqual([0, 3.96]);
    expect(s.undo).toEqual({ begun: 2, ended: 2 });
  });

  it("changes the speed with layer.stretch and keeps the in point without reading it back inside the write", () => {
    const s = scene();
    let stretch = 100;
    // A stale buffer: the stretch write changes nothing that can be read in the same script.
    Object.defineProperty(s.layer, "stretch", { get: () => stretch, set: (v: number) => (stretch = v) });
    s.layer.startTime = 0.25;
    s.run({ operation: "speed", speed_percent: 200 }).apply();
    expect(s.layer.stretch).toBe(50);
    // in 0 = start + 100/100 * a  =>  a = -0.25;  new start = 0 - 0.5 * -0.25
    expect(s.layer.startTime).toBeCloseTo(0.125, 9);
    expect(s.layer.timeRemapEnabled).toBe(false);
  });

  it("refuses a slow speed whose kept in point would put the start time out of range, before writing", () => {
    const s = scene({ compSeconds: 200, layerOut: 130 });
    s.layer.inPoint = 111;
    const planned = s.run({ operation: "speed", speed_percent: 1.0102 });
    expect(() => planned.apply()).toThrow(/outside \+\/-10800/);
    expect(s.layer.stretch).toBe(100);
    expect(s.undo.begun).toBe(0);
  });

  it("writes a per-frame ramp with exact values", () => {
    const s = scene();
    const out = s.run({ operation: "ramp", points: [{ time: 0, speed: 100 }, { time: 2, speed: 0 }] }).apply();
    expect(out.keys_written).toBe(100);
    expect(s.prop.numKeys).toBe(100);
    expect(s.prop.valueAtTime(1, false)).toBeCloseTo(0.75, 9);
    expect(s.prop.valueAtTime(2, false)).toBeCloseTo(1, 9);
    expect(s.prop.valueAtTime(3.9, false)).toBeCloseTo(1, 9);
    expect(s.prop.keyOutInterpolationType(10)).toBe(KeyframeInterpolationType.LINEAR);
  });

  it("writes a Bezier ramp with the planned eases", () => {
    const s = scene();
    s.run({ operation: "ramp", method: "bezier", points: [{ time: 0, speed: 100 }, { time: 2, speed: 0 }] }).apply();
    expect(s.prop.numKeys).toBe(3);
    expect(s.prop.keyOutInterpolationType(2)).toBe(KeyframeInterpolationType.BEZIER);
    const out1 = s.prop.keyOutTemporalEase(1)[0];
    const in2 = s.prop.keyInTemporalEase(2)[0];
    expect([out1.speed, out1.influence]).toEqual([1, THIRD_INFLUENCE]);
    expect([in2.speed, in2.influence]).toEqual([0, THIRD_INFLUENCE]);
  });

  it("trims the layer to the ramp when asked", () => {
    const s = scene();
    s.run({ operation: "ramp", method: "bezier", outside: "trim", points: [{ time: 1, speed: 100 }, { time: 2, speed: 100 }] }).apply();
    expect(s.layer.inPoint).toBe(1);
    expect(s.layer.outPoint).toBeCloseTo(2.04, 9);
    expect(s.prop.numKeys).toBe(2);
  });

  it("holds the last frame by keying the run and extending the layer", () => {
    const s = scene({ compSeconds: 6, layerOut: 4 });
    s.run({ operation: "hold_last_frame" }).apply();
    expect(s.layer.outPoint).toBe(6);
    expect([s.prop.keyTime(2), s.prop.keyValue(2)]).toEqual([3.96, 3.96]);
    expect(s.prop.valueAtTime(5, false)).toBe(3.96);
  });

  it("loops with an expression and extends the layer", () => {
    const s = scene({ compSeconds: 10, layerOut: 4 });
    s.run({ operation: "loop", loop_type: "pingpong", until: 10 }).apply();
    expect(s.prop.expression).toBe('loopOut("pingpong")');
    expect(s.layer.outPoint).toBe(10);
    expect(s.prop.numKeys).toBe(2);
  });

  it("disables remapping", () => {
    const s = scene();
    s.run({ operation: "enable" }).apply();
    s.run({ operation: "disable" }).apply();
    expect(s.layer.timeRemapEnabled).toBe(false);
  });

  it("refuses a plan made from remap keys that were edited since, before an undo group opens", () => {
    const s = scene();
    s.run({ operation: "enable" }).apply();
    const planned = s.run({ operation: "reverse" });
    expect(planned.plan.snapshot.fingerprint).toBeTruthy();
    s.prop.setValueAtTime(2, 1);
    const begun = s.undo.begun;
    let err: any;
    try {
      planned.apply();
    } catch (e) {
      err = e;
    }
    expect(err.__kind).toBe("stale");
    expect(err.message).toContain("keys, expression or source");
    expect(s.undo.begun).toBe(begun);
  });

  it("makes the same fingerprint as the server, so an unchanged remapped layer passes", () => {
    const s = scene();
    s.run({ operation: "enable" }).apply();
    expect(() => s.run({ operation: "reverse" }).apply()).not.toThrow();
    expect(s.read().remap_enabled).toBe(true);
  });

  it("reverses a non-linear remap in time", () => {
    const s = scene();
    s.run({ operation: "enable" }).apply();
    s.prop.setValueAtTime(0, 0);
    s.prop.setValueAtTime(2, 1);
    s.prop.setValueAtTime(3.96, 3);
    s.prop.removeKey(4);
    s.run({ operation: "reverse" }).apply();
    expect([1, 2, 3].map((i) => s.prop.keyValue(i))).toEqual([3, 1, 0]);
    expect([1, 2, 3].map((i) => s.prop.keyTime(i))).toEqual([0, 1.96, 3.96]);
  });

  it("keeps a Bezier side's ease and the other side's interpolation on a mixed key", () => {
    const s = scene();
    s.run({ operation: "enable" }).apply();
    const base = s.run({ operation: "reverse" }).plan;
    const keys = [
      { time: 0, value: 0, in_interp: "linear", out_interp: "bezier", ease: { out_speed: 1, out_influence: 40 } },
      { time: 2, value: 2, in_interp: "linear", out_interp: "linear" },
    ];
    s.A.timeremapApply({ comp_id: s.comp.id, layer_id: s.layer.id, plan: { ...base, keys }, expect: GUARD });
    expect(s.prop.numKeys).toBe(2);
    expect(s.prop.keyInInterpolationType(1)).toBe(KeyframeInterpolationType.LINEAR);
    expect(s.prop.keyOutInterpolationType(1)).toBe(KeyframeInterpolationType.BEZIER);
    const ease = s.prop.keyOutTemporalEase(1)[0];
    expect([ease.speed, ease.influence]).toEqual([1, 40]);
    const read = s.read();
    expect(read.keys[0].out_ease?.[0]).toMatchObject({ speed: 1, influence: 40 });
    expect(read.keys[0].in_ease).toBeUndefined();
  });

  it("refuses keys that land on one comp frame before opening an undo group", () => {
    const s = scene();
    const base = s.run({ operation: "freeze", at_time: 1 }).plan;
    const keys = [
      { time: 1, value: 1, in_interp: "linear", out_interp: "linear" },
      { time: 1.01, value: 2, in_interp: "linear", out_interp: "linear" },
    ];
    expect(() => s.A.timeremapApply({ comp_id: s.comp.id, layer_id: s.layer.id, plan: { ...base, keys }, expect: GUARD })).toThrow(/same comp frame/);
    expect(s.undo.begun).toBe(0);
  });

  it("reports a key count AE did not keep instead of throwing after the keys were removed", () => {
    const s = scene();
    s.run({ operation: "enable" }).apply();
    const planned = s.run({ operation: "ramp", points: [{ time: 0, speed: 100 }, { time: 2, speed: 0 }] });
    (s.prop as any).setValuesAtTimes = function (this: any, times: number[], values: number[]) {
      this.setValueAtTime(times[0], values[0]);
    };
    const out = planned.apply();
    expect(out.keys_written).toBe(1);
    expect(s.undo.begun).toBe(s.undo.ended);
    expect(remapMismatches(planned.plan, null, s.read()).map((m) => m.path)).toContain("num_keys");
  });

  it("refuses a layer that changed since it was planned, before an undo group opens", () => {
    const s = scene();
    const planned = s.run({ operation: "freeze", at_time: 1 });
    s.layer.inPoint = 0.5;
    let err: any;
    try {
      planned.apply();
    } catch (e) {
      err = e;
    }
    expect(err.__kind).toBe("stale");
    expect(err.message).toContain("changed since");
    expect(s.layer.timeRemapEnabled).toBe(false);
    expect(s.undo.begun).toBe(0);
  });

  it("refuses the wrong project and plans AE would reject, without touching the layer", () => {
    const s = scene();
    const planned = s.run({ operation: "freeze", at_time: 1 });
    expect(() => planned.apply({ expect: { project_path: "C:/other.aep" } })).toThrow(/Target guard refused/);
    const base = planned.plan;
    const attempt = (over: Record<string, unknown>) =>
      s.A.timeremapApply({ comp_id: s.comp.id, layer_id: s.layer.id, plan: { ...base, ...over }, expect: GUARD });
    expect(() => attempt({ keys: [{ time: 0, value: 9, in_interp: "hold", out_interp: "hold" }] })).toThrow(/outside the source/);
    expect(() => attempt({ keys: [{ time: 0, value: 1, in_interp: "bezier", out_interp: "bezier", ease: { in_speed: 1, in_influence: 0, out_speed: 1, out_influence: 50 } }] })).toThrow(/influence/);
    expect(() => attempt({ keys: [{ time: 1, value: 1, in_interp: "hold", out_interp: "hold" }, { time: 1, value: 2, in_interp: "hold", out_interp: "hold" }] })).toThrow(/ascending/);
    expect(() => attempt({ keys: undefined, enable: false })).toThrow(/changes nothing/);
    expect(() => attempt({ enable: false })).toThrow(/doesn't enable it/);
    expect(() => attempt({ keys: undefined, stretch: 9999 })).toThrow(/stretch must be/);
    expect(() => attempt({ keys: undefined, in_point: 3, out_point: 2 })).toThrow(/after in_point/);
    expect(s.layer.timeRemapEnabled).toBe(false);
    expect(s.undo.begun).toBe(0);
  });

  it("refuses stretch while remapping is on and a layer with no source", () => {
    const s = scene();
    s.run({ operation: "enable" }).apply();
    const snapshot = s.read();
    const plan = { operation: "speed", snapshot: { in_point: 0, out_point: 4, start_time: 0, stretch: 100, remap_enabled: true }, stretch: 50 };
    expect(snapshot.remap_enabled).toBe(true);
    expect(() => s.A.timeremapApply({ comp_id: s.comp.id, layer_id: s.layer.id, plan, expect: GUARD })).toThrow(/stretch can't be changed/);
    const nul = s.comp.layers.addNull(4);
    const nplan = { operation: "enable", snapshot: { in_point: 0, out_point: 4, start_time: 0, stretch: 100, remap_enabled: false }, enable: true };
    expect(() => s.A.timeremapApply({ comp_id: s.comp.id, layer_id: nul.id, plan: nplan, expect: GUARD })).toThrow(/no footage or comp source/);
  });

  it("puts remapping back off when a step fails after enabling it", () => {
    const s = scene({ compSeconds: 10, layerOut: 4, failExpression: true });
    const planned = s.run({ operation: "loop", until: 10 });
    expect(() => planned.apply()).toThrow(/expression engine refused/);
    expect(s.layer.timeRemapEnabled).toBe(false);
    expect(s.undo.begun).toBe(s.undo.ended);
  });
});
