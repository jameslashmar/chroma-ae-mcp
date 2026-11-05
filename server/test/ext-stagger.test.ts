import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import {
  AeStaggerLayoutSchema,
  AeStaggerSchema,
  compareKeys,
  computeOffsets,
  easeCurve,
  gridPositions,
  keysMismatches,
  layersMismatches,
  layoutMismatches,
  mulberry32,
  orderRanks,
  planLayout,
  planStagger,
  radialPositions,
  snapToFrame,
  staggerTools,
  type KeyState,
  type LayoutRead,
  type Plan,
  type StaggerLayer,
  type StaggerRead,
} from "../src/tools/ext/stagger.js";
import { FakeProject, GUARD, KeyframeInterpolationType, loadHost, type FakeComp, type FakeLayer, type FakeProperty } from "./support/fake-ae.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const tool = (name: string) => staggerTools.find((t) => t.name === name)!;
const expectArg = { project_path: "<unsaved>" };

/** A PanelHost whose AE answers from a script of results, recording each call. */
function fakeAe(results: Record<string, unknown[]>) {
  const calls: Array<{ fn: string; script: string }> = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-stagger-q-"));
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

// ---------- shapes ----------

const SL = (index: number, id: number, name: string, extra: Partial<StaggerLayer> = {}): StaggerLayer => ({
  index,
  id,
  name,
  startTime: 0,
  inPoint: 0,
  outPoint: 4,
  ...extra,
});

const readOf = (layers: StaggerLayer[], extra: Partial<StaggerRead> = {}): StaggerRead => ({
  comp_id: 1,
  name: "Main",
  frameDuration: 0.04,
  duration: 4,
  numLayers: layers.length,
  layers,
  ...extra,
});

const K = (time: number, value: unknown, extra: Partial<KeyState> = {}): KeyState => ({ time, value, ...extra });

const parseStagger = (o: Record<string, unknown>) => AeStaggerSchema.parse({ comp_id: 1, expect: expectArg, ...o });

// ---------- schemas ----------

describe("stagger schemas", () => {
  it("need exactly one of step and total", () => {
    expect(AeStaggerSchema.safeParse({ comp_id: 1, expect: expectArg }).success).toBe(false);
    expect(AeStaggerSchema.safeParse({ comp_id: 1, step: 0.1, total: 1, expect: expectArg }).success).toBe(false);
    expect(AeStaggerSchema.safeParse({ comp_id: 1, step: 0.1, expect: expectArg }).success).toBe(true);
    expect(AeStaggerSchema.safeParse({ comp_id: 1, total: 1, expect: expectArg }).success).toBe(true);
  });

  it("applies defaults", () => {
    const a = parseStagger({ step: 0.1 });
    expect(a).toMatchObject({ mode: "layers", order: "stack", ease: "linear", seed: 1, snap_to_frames: true });
  });

  it("keeps each mode's options to that mode", () => {
    const path = ["ADBE Transform Group", "ADBE Position"];
    expect(AeStaggerSchema.safeParse({ comp_id: 1, mode: "keys", step: 0.1, expect: expectArg }).success).toBe(false);
    expect(AeStaggerSchema.safeParse({ comp_id: 1, mode: "keys", property_path: path, step: 0.1, expect: expectArg }).success).toBe(true);
    expect(AeStaggerSchema.safeParse({ comp_id: 1, mode: "keys", property_path: path, trim: "keep_out", step: 0.1, expect: expectArg }).success).toBe(false);
    expect(AeStaggerSchema.safeParse({ comp_id: 1, mode: "copy_keys", property_path: path, step: 0.1, expect: expectArg }).success).toBe(false);
    expect(AeStaggerSchema.safeParse({ comp_id: 1, mode: "copy_keys", property_path: path, source: { index: 1 }, step: 0.1, expect: expectArg }).success).toBe(true);
    expect(AeStaggerSchema.safeParse({ comp_id: 1, source: { index: 1 }, step: 0.1, expect: expectArg }).success).toBe(false);
    expect(AeStaggerSchema.safeParse({ comp_id: 1, replace_existing: true, step: 0.1, expect: expectArg }).success).toBe(false);
    expect(AeStaggerSchema.safeParse({ comp_id: 1, skip_missing: true, step: 0.1, expect: expectArg }).success).toBe(false);
    expect(AeStaggerSchema.safeParse({ comp_id: 1, step: 0.1, order: "spiral", expect: expectArg }).success).toBe(false);
  });

  it("layout needs the options of its pattern", () => {
    const ok = { comp_id: 1, expect: expectArg };
    expect(AeStaggerLayoutSchema.safeParse({ ...ok, pattern: "grid" }).success).toBe(false);
    expect(AeStaggerLayoutSchema.safeParse({ ...ok, pattern: "grid", columns: 3, spacing: [100, 80] }).success).toBe(true);
    expect(AeStaggerLayoutSchema.safeParse({ ...ok, pattern: "radial" }).success).toBe(false);
    expect(AeStaggerLayoutSchema.safeParse({ ...ok, pattern: "radial", radius: 200 }).success).toBe(true);
    expect(AeStaggerLayoutSchema.safeParse({ ...ok, pattern: "radial", radius: 200, columns: 2 }).success).toBe(false);
    expect(AeStaggerLayoutSchema.safeParse({ ...ok, pattern: "grid", columns: 3, spacing: [1, 1], radius: 5 }).success).toBe(false);
  });

  it("both tools end their description with the safety guidance", () => {
    for (const t of staggerTools) expect(t.description).toMatch(/Jay may be editing live/);
  });
});

// ---------- pure logic ----------

describe("order ranks and offsets", () => {
  it("ranks each order", () => {
    expect(orderRanks(4, "stack")).toEqual([0, 1, 2, 3]);
    expect(orderRanks(4, "reverse")).toEqual([3, 2, 1, 0]);
    expect(orderRanks(4, "center_out")).toEqual([1, 0, 0, 1]);
    expect(orderRanks(5, "center_out")).toEqual([2, 1, 0, 1, 2]);
    expect(orderRanks(4, "ends_in")).toEqual([0, 1, 1, 0]);
    expect(orderRanks(5, "ends_in")).toEqual([0, 1, 2, 1, 0]);
    expect(orderRanks(1, "center_out")).toEqual([0]);
  });

  it("random is a seeded permutation: repeatable, and different seeds differ", () => {
    const a = orderRanks(12, "random", 7);
    expect(orderRanks(12, "random", 7)).toEqual(a);
    expect([...a].sort((x, y) => x - y)).toEqual(Array.from({ length: 12 }, (_, i) => i));
    expect(orderRanks(12, "random", 8)).not.toEqual(a);
  });

  it("mulberry32 stays in [0, 1) and repeats", () => {
    const r = mulberry32(42);
    const first = Array.from({ length: 5 }, () => r());
    expect(first.every((v) => v >= 0 && v < 1)).toBe(true);
    const r2 = mulberry32(42);
    expect(Array.from({ length: 5 }, () => r2())).toEqual(first);
  });

  it("ease curves hit 0 and 1 and bend between", () => {
    for (const e of ["linear", "ease_in", "ease_out", "ease_in_out"] as const) {
      expect(easeCurve(e, 0)).toBe(0);
      expect(easeCurve(e, 1)).toBe(1);
    }
    expect(easeCurve("ease_in", 0.5)).toBeLessThan(0.5);
    expect(easeCurve("ease_out", 0.5)).toBeGreaterThan(0.5);
    expect(easeCurve("ease_in_out", 0.5)).toBe(0.5);
  });

  it("step spreads evenly; total fits the spread; delay shifts all", () => {
    expect(computeOffsets(4, { order: "stack", step: 0.2 })).toEqual([0, 0.2, 0.4, 0.6000000000000001]);
    expect(computeOffsets(4, { order: "stack", total: 3 })).toEqual([0, 1, 2, 3]);
    expect(computeOffsets(3, { order: "reverse", step: 1, delay: 0.5 })).toEqual([2.5, 1.5, 0.5]);
    expect(computeOffsets(1, { order: "stack", step: 1 })).toEqual([0]);
    expect(computeOffsets(3, { order: "stack", total: 2, ease: "ease_in" })).toEqual([0, 0.5, 2]);
  });

  it("snaps offsets to whole frames", () => {
    expect(snapToFrame(0.1, 0.04)).toBeCloseTo(0.12, 9);
    expect(computeOffsets(3, { order: "stack", step: 0.1, frameDuration: 1 / 24 }).map((t) => Math.round(t * 24 * 1e6) / 1e6)).toEqual([0, 2, 5]);
  });
});

describe("layout maths", () => {
  it("centres a grid on its origin", () => {
    const p = gridPositions(4, 2, [100, 50], [200, 100]);
    expect(p).toEqual([
      [150, 75],
      [250, 75],
      [150, 125],
      [250, 125],
    ]);
    // Fewer layers than columns centre on the layers there are.
    expect(gridPositions(2, 5, [100, 50], [200, 100])).toEqual([
      [150, 100],
      [250, 100],
    ]);
  });

  it("puts a full circle's places evenly round, first at 12 o'clock", () => {
    const p = radialPositions(4, [0, 0], 100, 0, 360);
    expect(p[0][0]).toBeCloseTo(0);
    expect(p[0][1]).toBeCloseTo(-100);
    expect(p[1][0]).toBeCloseTo(100);
    expect(p[1][1]).toBeCloseTo(0);
    expect(p[2][1]).toBeCloseTo(100);
  });

  it("a partial sweep ends on its last angle", () => {
    const p = radialPositions(3, [0, 0], 100, 0, 180);
    expect(p[2][0]).toBeCloseTo(0);
    expect(p[2][1]).toBeCloseTo(100);
  });
});

describe("planStagger", () => {
  const layers = [SL(1, 10, "A", { startTime: 1 }), SL(2, 11, "B", { startTime: 1 }), SL(3, 12, "C", { startTime: 1 })];

  it("plans start times from a step", () => {
    const r = planStagger(parseStagger({ step: 0.2 }), readOf(layers));
    expect(r.ok && r.plan.entries.map((e) => [e.id, e.from, e.to])).toEqual([
      [10, 1, 1],
      [11, 1, 1.2],
      [12, 1, 1.4],
    ]);
  });

  it("refuses layers without the property or the keys, and skips keyless ones on request", () => {
    const path = ["ADBE Transform Group", "ADBE Opacity"];
    const withProp = (n: number, extra: Partial<StaggerLayer["property"] & object> = {}) => ({ found: true, numKeys: n, times: n ? [1] : undefined, ...extra });
    const args = parseStagger({ mode: "keys", property_path: path, step: 0.1 });
    const lost = planStagger(args, readOf([SL(1, 10, "A", { property: { found: false } })]));
    expect(lost).toMatchObject({ ok: false, error: "bad_args" });
    const mixed = readOf([SL(1, 10, "A", { property: withProp(2) }), SL(2, 11, "B", { property: withProp(0) }), SL(3, 12, "C", { property: withProp(3) })]);
    expect(planStagger(args, mixed)).toMatchObject({ ok: false });
    const skip = planStagger(parseStagger({ mode: "keys", property_path: path, step: 0.1, skip_missing: true }), mixed);
    expect(skip.ok && skip.plan.skipped.map((s) => s.id)).toEqual([11]);
    // B takes no slot: C gets the second place.
    expect(skip.ok && skip.plan.entries.map((e) => e.offset)).toEqual([0, 0.12]);
    const leader = readOf([SL(1, 10, "A", { property: withProp(2, { separationLeader: true }) })]);
    expect(planStagger(args, leader)).toMatchObject({ ok: false });
    // A separated leader without keys gets the separated hint, not the "no keys" message, even with skip_missing.
    const keylessLeader = readOf([SL(1, 10, "A", { property: withProp(0, { separationLeader: true }) })]);
    const skipArgs = parseStagger({ mode: "keys", property_path: path, step: 0.1, skip_missing: true });
    expect(planStagger(skipArgs, keylessLeader)).toMatchObject({ ok: false, message: expect.stringMatching(/separated/) });
    expect(planStagger(args, readOf([SL(1, 10, "A", { locked: true, property: withProp(2) })]))).toMatchObject({ ok: false, message: expect.stringMatching(/locked/) });
    const big = readOf([SL(1, 10, "A", { property: withProp(600, { times: [0] }) }), SL(2, 11, "B", { property: withProp(600, { times: [0] }) })]);
    expect(planStagger(args, big)).toMatchObject({ ok: false });
  });

  it("copy_keys refuses a target that is the source, or has keys without replace_existing", () => {
    const path = ["ADBE Transform Group", "ADBE Opacity"];
    const src = SL(1, 10, "Src", { property: { found: true, numKeys: 2, times: [0, 1] } });
    const args = parseStagger({ mode: "copy_keys", property_path: path, source: { id: 10 }, step: 0.5 });
    const target = (n: number, id = 11) => SL(2, id, "T", { property: { found: true, numKeys: n, times: n ? [0] : undefined } });
    expect(planStagger(args, readOf([target(0)], { source: src })).ok).toBe(true);
    expect(planStagger(args, readOf([target(2)], { source: src }))).toMatchObject({ ok: false });
    expect(planStagger(parseStagger({ mode: "copy_keys", property_path: path, source: { id: 10 }, step: 0.5, replace_existing: true }), readOf([target(2)], { source: src })).ok).toBe(true);
    expect(planStagger(args, readOf([target(0, 10)], { source: src }))).toMatchObject({ ok: false });
  });

  it("copy_keys plans the source's key count and first time, not the target's own", () => {
    const path = ["ADBE Transform Group", "ADBE Opacity"];
    const src = SL(1, 10, "Src", { property: { found: true, numKeys: 2, times: [0.5, 1] } });
    const keyless = SL(2, 11, "T", { property: { found: true, numKeys: 0 } });
    const keyed = SL(3, 12, "U", { property: { found: true, numKeys: 4, times: [9] } });
    const r = planStagger(parseStagger({ mode: "copy_keys", property_path: path, source: { id: 10 }, step: 0.5, replace_existing: true }), readOf([keyless, keyed], { source: src }));
    expect(r.ok && r.plan.entries.map((e) => [e.num_keys, e.first_time])).toEqual([
      [2, 0.5],
      [2, 0.5],
    ]);
    // first_key_to in the summary is first_time + offset: the source's first key plus the offset.
    expect(r.ok && r.plan.entries.map((e) => Number((e.first_time! + e.offset).toFixed(9)))).toEqual(r.ok ? r.plan.entries.map((e) => Number((0.5 + e.offset).toFixed(9))) : []);
  });

  it("refuses locked layers in layers mode too", () => {
    const r = planStagger(parseStagger({ step: 0.2 }), readOf([SL(1, 10, "A", { locked: true }), SL(2, 11, "B")]));
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/locked/) });
  });
});

describe("planLayout", () => {
  const read: LayoutRead = {
    comp_id: 1,
    name: "Main",
    width: 640,
    height: 360,
    layers: [
      { index: 1, id: 10, name: "A", parent: null, state: "static", position: [0, 0, 0] },
      { index: 2, id: 11, name: "B", parent: 1, state: "static", position: [0, 0, 0] },
    ],
  };

  it("defaults the origin to the comp centre and warns about parents", () => {
    const r = planLayout(AeStaggerLayoutSchema.parse({ comp_id: 1, pattern: "grid", columns: 2, spacing: [100, 100], expect: expectArg }), read);
    expect(r.ok && r.entries.map((e) => e.position)).toEqual([
      [270, 180],
      [370, 180],
    ]);
    expect(r.ok && r.warnings.length).toBe(1);
  });

  it("order reverse swaps the places", () => {
    const r = planLayout(AeStaggerLayoutSchema.parse({ comp_id: 1, pattern: "grid", columns: 2, spacing: [100, 100], order: "reverse", expect: expectArg }), read);
    expect(r.ok && r.entries.map((e) => e.position[0])).toEqual([370, 270]);
  });

  it("refuses keyed or expression-driven positions", () => {
    const keyed: LayoutRead = { ...read, layers: [{ ...read.layers[0], state: "keyed" }, read.layers[1]] };
    expect(planLayout(AeStaggerLayoutSchema.parse({ comp_id: 1, pattern: "radial", radius: 50, expect: expectArg }), keyed)).toMatchObject({ ok: false });
  });
});

// ---------- read-back checks ----------

describe("compareKeys", () => {
  const ease = [{ speed: 0, influence: 33.3 }];
  const b1 = K(1, [0, 0, 0], { inInterp: "bezier", outInterp: "bezier", easeIn: ease, easeOut: ease, temporalContinuous: true, roving: false });
  const b2 = K(2, [100, 0, 0], { inInterp: "linear", outInterp: "linear", easeIn: ease, easeOut: ease });

  it("accepts the same keys shifted", () => {
    const a = [{ ...b1, time: 1.5 }, { ...b2, time: 2.5 }];
    expect(compareKeys([b1, b2], a, 0.5, 0.02, "w")).toEqual([]);
  });

  it("flags a lost ease, a wrong time and a changed continuity", () => {
    const a = [
      { ...b1, time: 1.5, easeOut: [{ speed: 5, influence: 10 }], temporalContinuous: false },
      { ...b2, time: 2.8 },
    ];
    const paths = compareKeys([b1, b2], a, 0.5, 0.02, "w").map((m) => m.path);
    expect(paths).toEqual(["w.keys[1].easeOut", "w.keys[1].temporalContinuous", "w.keys[2].time"]);
  });

  it("does not assert a roving key's time, nor ease on a linear side", () => {
    const rb = K(1.5, [5, 0, 0], { roving: true, inInterp: "linear", outInterp: "linear", easeIn: ease });
    const ra = K(1.9, [5, 0, 0], { roving: true, inInterp: "linear", outInterp: "linear", easeIn: [{ speed: 9, influence: 9 }] });
    expect(compareKeys([rb], [ra], 0.5, 0.02, "w")).toEqual([]);
  });

  it("flags a different key count", () => {
    expect(compareKeys([b1, b2], [b1], 0, 0.02, "w").map((m) => m.path)).toEqual(["w.numKeys"]);
  });
});

describe("layersMismatches", () => {
  const plan: Plan = {
    frameDuration: 0.04,
    skipped: [],
    entries: [{ id: 10, index: 1, name: "A", offset: 1, from: 0, to: 1 }],
  };
  const before = readOf([SL(1, 10, "A")]);

  it("accepts a layer whose out point followed", () => {
    expect(layersMismatches(parseStagger({ step: 1 }), plan, before, readOf([SL(1, 10, "A", { startTime: 1, inPoint: 1, outPoint: 5 })]))).toEqual([]);
  });

  it("flags a start that didn't take and an out point that stayed under keep_duration", () => {
    const m = layersMismatches(parseStagger({ step: 1 }), plan, before, readOf([SL(1, 10, "A", { startTime: 0.5, outPoint: 4 })]));
    expect(m.map((x) => x.path)).toEqual(["layers[1].startTime", "layers[1].outPoint"]);
  });

  it("checks keep_out and to_comp_end", () => {
    const keepOut = parseStagger({ step: 1, trim: "keep_out" });
    expect(layersMismatches(keepOut, plan, before, readOf([SL(1, 10, "A", { startTime: 1, outPoint: 4 })]))).toEqual([]);
    expect(layersMismatches(keepOut, plan, before, readOf([SL(1, 10, "A", { startTime: 1, outPoint: 3 })])).length).toBe(1);
    const toEnd = parseStagger({ step: 1, trim: "to_comp_end" });
    expect(layersMismatches(toEnd, plan, before, readOf([SL(1, 10, "A", { startTime: 1, outPoint: 4 })]))).toEqual([]);
  });
});

describe("keysMismatches", () => {
  const path = ["ADBE Transform Group", "ADBE Opacity"];
  const plan: Plan = { frameDuration: 0.04, skipped: [], entries: [{ id: 10, index: 1, name: "A", offset: 0.5, num_keys: 2, first_time: 1 }] };
  const withKeys = (keys: KeyState[]) => readOf([SL(1, 10, "A", { property: { found: true, numKeys: keys.length, keys } })]);

  it("compares each layer's keys with its own offset", () => {
    const args = parseStagger({ mode: "keys", property_path: path, step: 0.5 });
    const ok = keysMismatches(args, plan, withKeys([K(1, 0), K(2, 100)]), withKeys([K(1.5, 0), K(2.5, 100)]));
    expect(ok).toEqual([]);
    const bad = keysMismatches(args, plan, withKeys([K(1, 0), K(2, 100)]), withKeys([K(1, 0), K(2.5, 100)]));
    expect(bad.map((m) => m.path)).toEqual(["layers[1].keys[1].time"]);
  });

  it("copy_keys compares the source's keys with the target's, and the source with itself", () => {
    const args = parseStagger({ mode: "copy_keys", property_path: path, source: { id: 5 }, step: 0.5 });
    const src = (keys: KeyState[]) => ({ source: SL(9, 5, "Src", { property: { found: true, numKeys: keys.length, keys } }) });
    const before = { ...withKeys([]), ...src([K(0, 1), K(1, 2)]) };
    const after = { ...withKeys([K(0.5, 1), K(1.5, 2)]), ...src([K(0, 1), K(1, 2)]) };
    expect(keysMismatches(args, plan, before, after)).toEqual([]);
    const moved = { ...withKeys([K(0.5, 1), K(1.5, 2)]), ...src([K(0.5, 1), K(1, 2)]) };
    expect(keysMismatches(args, plan, before, moved).map((m) => m.path)).toEqual(["source.keys[1].time"]);
  });
});

describe("layoutMismatches", () => {
  const entries = [{ id: 10, index: 1, name: "A", position: [100, 50] as [number, number], from: [0, 0, 7] }];
  const after = (position: number[]): LayoutRead => ({ comp_id: 1, name: "M", width: 1, height: 1, layers: [{ index: 1, id: 10, name: "A", parent: null, state: "static", position }] });
  it("checks X, Y and that Z stayed", () => {
    expect(layoutMismatches(entries, after([100, 50.01, 7]))).toEqual([]);
    expect(layoutMismatches(entries, after([90, 50, 7])).length).toBe(1);
    expect(layoutMismatches(entries, after([100, 50, 0])).map((m) => m.path)).toEqual(["layers[1].position[2]"]);
  });
});

// ---------- the guarded flow ----------

describe("ae_stagger flow", () => {
  const stagger = tool("ae_stagger");
  const layerRead = (starts: number[], extra: Partial<StaggerRead> = {}) =>
    readOf(
      starts.map((s, i) => SL(i + 1, 10 + i, `L${i + 1}`, { startTime: s, inPoint: s, outPoint: 4 + s })),
      extra
    );

  it("a dry run reads once and writes nothing", async () => {
    const { ctx, calls } = fakeAe({ staggerRead: [layerRead([0, 0, 0])] });
    const out = await stagger.handler(parseStagger({ step: 0.2, dry_run: true }), ctx);
    expect(calls.map((c) => c.fn)).toEqual(["staggerRead"]);
    expect(out).toMatchObject({ ok: true, dry_run: true });
    expect(out.layers.map((l: { to: number }) => l.to)).toEqual([0, 0.2, 0.4]);
  });

  it("guards, plans, writes explicit times and reads back in a separate call", async () => {
    const { ctx, calls } = fakeAe({
      staggerRead: [layerRead([0, 0]), layerRead([0, 0]), layerRead([0, 0.2])],
      staggerApply: [{ mode: "layers", layers: [], warnings: [] }],
    });
    const out = await stagger.handler(parseStagger({ layers: [{ index: 1 }, { index: 2 }], step: 0.2 }), ctx);
    expect(calls.map((c) => c.fn)).toEqual(["checkGuard", "staggerRead", "checkGuard", "staggerRead", "staggerApply", "staggerRead"]);
    expect(calls[4].script).toContain('"expect"');
    expect(calls[4].script).toContain('"to":0.2');
    // The reads after name the layers by id.
    expect(calls[5].script).toContain('"id":11');
    expect(out.applied).toBe(true);
    expect(out.receipt.matches).toBe(true);
  });

  it("puts a read-back that shows the wrong time into the receipt", async () => {
    const { ctx } = fakeAe({
      staggerRead: [layerRead([0, 0]), layerRead([0, 0]), layerRead([0, 0])],
      staggerApply: [{ mode: "layers", layers: [], warnings: [] }],
    });
    const out = await stagger.handler(parseStagger({ step: 0.2 }), ctx);
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches[0].path).toBe("layers[2].startTime");
  });

  it("never throws once the write is applied: a failed read-back lands in the receipt", async () => {
    const { ctx } = fakeAe({
      staggerRead: [layerRead([0, 0]), layerRead([0, 0])],
      staggerApply: [{ mode: "layers", layers: [], warnings: [] }],
    });
    const out = await stagger.handler(parseStagger({ step: 0.2 }), ctx);
    expect(out.applied).toBe(true);
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches[0].path).toBe("read_back");
  });

  it("returns bad_args from the plan before any write", async () => {
    const { ctx, calls } = fakeAe({ staggerRead: [readOf([SL(1, 10, "A", { property: { found: false } })])] });
    const out = await stagger.handler(parseStagger({ mode: "keys", property_path: ["ADBE Transform Group", "ADBE Opacity"], step: 0.1 }), ctx);
    expect(out).toMatchObject({ ok: false, error: "bad_args" });
    expect(calls.some((c) => c.fn === "staggerApply")).toBe(false);
  });

  it("the layout tool plans from a read and checks the positions after", async () => {
    const layout = tool("ae_stagger_layout");
    const read = (pos: number[][]): LayoutRead => ({
      comp_id: 1,
      name: "M",
      width: 640,
      height: 360,
      layers: pos.map((p, i) => ({ index: i + 1, id: 10 + i, name: `L${i + 1}`, parent: null, state: "static" as const, position: p })),
    });
    const { ctx, calls } = fakeAe({
      staggerLayoutRead: [read([[0, 0, 0], [0, 0, 0]]), read([[0, 0, 0], [0, 0, 0]]), read([[270, 180, 0], [370, 180, 0]])],
      staggerLayoutApply: [{ layers: [] }],
    });
    const args = AeStaggerLayoutSchema.parse({ comp_id: 1, pattern: "grid", columns: 2, spacing: [100, 100], expect: expectArg });
    const out = await layout.handler(args, ctx);
    expect(calls.map((c) => c.fn)).toEqual(["checkGuard", "staggerLayoutRead", "checkGuard", "staggerLayoutRead", "staggerLayoutApply", "staggerLayoutRead"]);
    expect(out.receipt.matches).toBe(true);
    expect(out.layers.map((l: { to: number[] }) => l.to)).toEqual([
      [270, 180],
      [370, 180],
    ]);
  });
});

// ---------- the host functions under node:vm ----------

/** inPoint and outPoint follow startTime, as in AE (the fake keeps them apart). */
function linkTiming(l: FakeLayer) {
  let inOff = 0;
  let outOff = l.outPoint;
  Object.defineProperty(l, "inPoint", { get: () => l.startTime + inOff, set: (v: number) => (inOff = v - l.startTime), configurable: true });
  Object.defineProperty(l, "outPoint", { get: () => l.startTime + outOff, set: (v: number) => (outOff = v - l.startTime), configurable: true });
}

/** Per-key state the fake lacks: continuity, auto-bezier, spatial tangents, label, selection. */
function enhance(p: FakeProperty) {
  const x = p as any;
  const key = (i: number) => x.keys[i - 1];
  const flag = (field: string, getter: string, setter: string) => {
    x[getter] = (i: number) => key(i)[field] ?? false;
    x[setter] = (i: number, v: boolean) => {
      key(i)[field] = v;
    };
  };
  flag("tCont", "keyTemporalContinuous", "setTemporalContinuousAtKey");
  flag("tAuto", "keyTemporalAutoBezier", "setTemporalAutoBezierAtKey");
  flag("sCont", "keySpatialContinuous", "setSpatialContinuousAtKey");
  flag("sAuto", "keySpatialAutoBezier", "setSpatialAutoBezierAtKey");
  flag("selected", "keySelected", "setSelectedAtKey");
  x.keyLabel = (i: number) => key(i).label ?? 0;
  x.setLabelAtKey = (i: number, v: number) => {
    key(i).label = v;
  };
  x.keyInSpatialTangent = (i: number) => key(i).inTan ?? [0, 0, 0];
  x.keyOutSpatialTangent = (i: number) => key(i).outTan ?? [0, 0, 0];
  x.setSpatialTangentsAtKey = (i: number, a: number[], b: number[]) => {
    key(i).inTan = a;
    key(i).outTan = b;
  };
}

function scene(n = 3) {
  const project = new FakeProject();
  const comp = project.addComp("Main", 640, 360, 4);
  comp.frameRate = 25;
  // addSolid puts each new layer on top: the last made is index 1.
  for (let i = n; i >= 1; i--) comp.layers.addSolid([1, 1, 1], `L${i}`, 100, 100, 1, 4);
  for (const l of comp.stack) linkTiming(l);
  const { A, undo } = loadHost(project, ["stagger.jsx"]);
  return { project, comp, A, undo };
}

const POS = ["ADBE Transform Group", "ADBE Position"];
const OPACITY = ["ADBE Transform Group", "ADBE Opacity"];
const prop = (l: FakeLayer, name: string) => l.transform(name);
const times = (p: FakeProperty) => p.keys.map((k) => Math.round(k.time * 1e6) / 1e6);
const fromJson = (v: unknown) => JSON.parse(JSON.stringify(v));

describe("stagger.jsx: staggerRead", () => {
  it("reads selected layers in stack order without changing the comp", () => {
    const { comp, A } = scene();
    (comp as any).selectedLayers = [comp.layer(3), comp.layer(1)];
    const r = fromJson(A.staggerRead({ comp_id: comp.id }));
    expect(r.layers.map((l: { name: string }) => l.name)).toEqual(["L1", "L3"]);
    expect(r).toMatchObject({ frameDuration: 0.04, duration: 4 });
    expect((comp as any).selectedLayers.length).toBe(2);
  });

  it("refuses when nothing is given or selected", () => {
    const { comp, A } = scene();
    (comp as any).selectedLayers = [];
    expect(() => A.staggerRead({ comp_id: comp.id })).toThrow(/none selected/);
  });

  it("reports the property's key times or every key field, and a missing property", () => {
    const { comp, A } = scene(2);
    const p = prop(comp.layer(1)!, "Opacity");
    p.setValueAtTime(1, 0);
    p.setValueAtTime(2, 100);
    p.setInterpolationTypeAtKey(1, KeyframeInterpolationType.BEZIER);
    const times_ = fromJson(A.staggerRead({ comp_id: comp.id, layers: [{ index: 1 }, { index: 2 }], property_path: OPACITY, detail: "times" }));
    expect(times_.layers[0].property).toMatchObject({ found: true, numKeys: 2, times: [1, 2] });
    expect(times_.layers[1].property).toMatchObject({ found: true, numKeys: 0 });
    const full = fromJson(A.staggerRead({ comp_id: comp.id, layers: [{ index: 1 }], property_path: OPACITY, detail: "full" }));
    expect(full.layers[0].property.keys[0]).toMatchObject({ time: 1, value: 0, inInterp: "bezier", outInterp: "bezier" });
    const none = fromJson(A.staggerRead({ comp_id: comp.id, layers: [{ index: 1 }], property_path: ["ADBE Transform Group", "ADBE Nope"] }));
    expect(none.layers[0].property.found).toBe(false);
  });
});

describe("stagger.jsx: staggerApply (layers)", () => {
  it("moves each layer in one undo group, and the out point follows", () => {
    const { comp, A, undo } = scene();
    const out = A.staggerApply({
      comp_id: comp.id,
      mode: "layers",
      targets: [
        { id: comp.layer(1)!.id, from: 0, to: 0 },
        { id: comp.layer(2)!.id, from: 0, to: 0.2 },
        { id: comp.layer(3)!.id, from: 0, to: 0.4 },
      ],
      expect: GUARD,
    });
    expect([1, 2, 3].map((i) => comp.layer(i)!.startTime)).toEqual([0, 0.2, 0.4]);
    expect(comp.layer(3)!.outPoint).toBeCloseTo(4.4);
    expect(out.layers.map((l: { to: number }) => l.to)).toEqual([0, 0.2, 0.4]);
    expect(undo.begun).toBe(1);
    expect(undo.ended).toBe(1);
  });

  it("keep_out and to_comp_end set the out point afterwards", () => {
    const { comp, A } = scene(2);
    const [a, b] = [comp.layer(1)!, comp.layer(2)!];
    A.staggerApply({ comp_id: comp.id, mode: "layers", trim: "keep_out", targets: [{ id: a.id, from: 0, to: 1 }], expect: GUARD });
    expect([a.startTime, a.outPoint]).toEqual([1, 4]);
    A.staggerApply({ comp_id: comp.id, mode: "layers", trim: "to_comp_end", targets: [{ id: b.id, from: 0, to: 2 }], expect: GUARD });
    expect([b.startTime, b.outPoint]).toEqual([2, 4]);
  });

  it("refuses before touching anything: wrong guard, stale plan, bad time, start past the kept out point", () => {
    const { comp, A, undo } = scene(2);
    const [a, b] = [comp.layer(1)!, comp.layer(2)!];
    const targets = [{ id: a.id, from: 0, to: 1 }];
    expect(() => A.staggerApply({ comp_id: comp.id, mode: "layers", targets, expect: { project_path: "C:/other.aep" } })).toThrow(/Target guard refused/);
    expect(() => A.staggerApply({ comp_id: comp.id, mode: "layers", targets: [{ id: a.id, from: 0.5, to: 1 }], expect: GUARD })).toThrow(/moved since the plan/);
    expect(() => A.staggerApply({ comp_id: comp.id, mode: "layers", targets: [{ id: a.id, from: 0, to: 99999 }], expect: GUARD })).toThrow(/outside AE's range/);
    expect(() => A.staggerApply({ comp_id: comp.id, mode: "layers", trim: "keep_out", targets: [{ id: a.id, from: 0, to: 0 }, { id: b.id, from: 0, to: 5 }], expect: GUARD })).toThrow(/at or after the out point/);
    expect(() => A.staggerApply({ comp_id: comp.id, mode: "layers", trim: "sideways", targets, expect: GUARD })).toThrow(/Unknown trim/);
    expect(() => A.staggerApply({ comp_id: comp.id, mode: "layers", targets: [], expect: GUARD })).toThrow(/No targets/);
    expect([a.startTime, b.startTime]).toEqual([0, 0]);
    expect(undo.begun).toBe(0);
  });

  it("puts back the layers it moved when a later one fails", () => {
    const { comp, A } = scene(3);
    const bad = comp.layer(3)!;
    Object.defineProperty(bad, "startTime", { get: () => 0, set: () => { throw new Error("locked"); }, configurable: true });
    expect(() =>
      A.staggerApply({
        comp_id: comp.id,
        mode: "layers",
        targets: [comp.layer(1)!, comp.layer(2)!, bad].map((l, i) => ({ id: l.id, from: 0, to: i + 1 })),
        expect: GUARD,
      })
    ).toThrow(/locked/);
    expect(comp.layer(1)!.startTime).toBe(0);
    expect(comp.layer(2)!.startTime).toBe(0);
  });
});

/** Position keys with ease, tangents, flags and a roving middle key. */
function keyedPosition(l: FakeLayer, base: number) {
  const p = prop(l, "Position");
  enhance(p);
  const t = [base, base + 1, base + 2];
  p.setValueAtTime(t[0], [0, 0, 0]);
  p.setValueAtTime(t[1], [50, 20, 0]);
  p.setValueAtTime(t[2], [100, 0, 0]);
  p.setInterpolationTypeAtKey(1, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.BEZIER);
  p.setInterpolationTypeAtKey(2, KeyframeInterpolationType.BEZIER);
  p.setInterpolationTypeAtKey(3, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.LINEAR);
  const ease = (s: number, i: number) => [Object.assign(Object.create(null), { speed: s, influence: i })];
  p.setTemporalEaseAtKey(2, ease(4, 70) as any, ease(9, 20) as any);
  (p as any).setSpatialTangentsAtKey(2, [-10, 5, 0], [10, -5, 0]);
  (p as any).setTemporalContinuousAtKey(2, true);
  (p as any).setLabelAtKey(3, 5);
  (p as any).keys[1].roving = true;
  return p;
}

// Spatial tangents and flags the fake never stored read as zero/false, so both sides normalise to that.
const snapKeys = (p: FakeProperty) =>
  p.keys.map((k: any) => fromJson({ ...k, time: undefined, inTan: k.inTan ?? [0, 0, 0], outTan: k.outTan ?? [0, 0, 0], tAuto: k.tAuto ?? false, tCont: k.tCont ?? false, sAuto: k.sAuto ?? false, sCont: k.sCont ?? false }));

describe("stagger.jsx: staggerApply (keys)", () => {
  it("shifts every key field with the keys, leaving the layer where it is", () => {
    const { comp, A, undo } = scene(2);
    const [l1, l2] = [comp.layer(1)!, comp.layer(2)!];
    const p1 = keyedPosition(l1, 1);
    const p2 = keyedPosition(l2, 1);
    const beforeKeys = snapKeys(p2);
    const out = A.staggerApply({
      comp_id: comp.id,
      mode: "keys",
      property_path: POS,
      targets: [
        { id: l1.id, offset: 0, num_keys: 3, first_time: 1 },
        { id: l2.id, offset: 0.52, num_keys: 3, first_time: 1 },
      ],
      expect: GUARD,
    });
    expect(times(p1)).toEqual([1, 2, 3]);
    expect(times(p2)).toEqual([1.52, 2.52, 3.52]);
    expect(snapKeys(p2)).toEqual(beforeKeys);
    expect(l2.startTime).toBe(0);
    expect(out.warnings).toEqual([]);
    expect(out.layers[1]).toMatchObject({ offset: 0.52, numKeys: 3, firstKey: 1.52 });
    expect(undo.begun).toBe(1);
    expect(undo.ended).toBe(1);
    // The host read after agrees with what the server compares.
    const keys = fromJson(A.staggerRead({ comp_id: comp.id, layers: [{ id: l2.id }], property_path: POS, detail: "full" })).layers[0].property.keys;
    expect(keys[1]).toMatchObject({ time: 2.52, inInterp: "bezier", temporalContinuous: true, roving: true, tangentIn: [-10, 5, 0] });
    expect(keys[2].label).toBe(5);
  });

  it("refuses a stale plan and a layer without the property before changing anything", () => {
    const { comp, A } = scene(2);
    const [l1, l2] = [comp.layer(1)!, comp.layer(2)!];
    const p1 = keyedPosition(l1, 1);
    const run = (targets: unknown[]) => A.staggerApply({ comp_id: comp.id, mode: "keys", property_path: POS, targets, expect: GUARD });
    expect(() => run([{ id: l1.id, offset: 1, num_keys: 3, first_time: 2 }])).toThrow(/changed since the plan/);
    expect(() => run([{ id: l1.id, offset: 1, num_keys: 3, first_time: 1 }, { id: l2.id, offset: 1, num_keys: 1, first_time: 1 }])).toThrow(/no keys/);
    expect(() => run([{ id: l1.id, offset: 20000, num_keys: 3, first_time: 1 }])).toThrow(/outside AE's range/);
    expect(times(p1)).toEqual([1, 2, 3]);
  });

  it("restores the original keys when a rebuild fails midway", () => {
    const { comp, A } = scene(2);
    const [l1, l2] = [comp.layer(1)!, comp.layer(2)!];
    const p1 = keyedPosition(l1, 1);
    const p2 = keyedPosition(l2, 1);
    const orig = p2.setValueAtTime.bind(p2);
    // The second layer refuses a key written at its shifted time.
    p2.setValueAtTime = (t: number, v: unknown) => {
      if (Math.abs(t - 2.52) < 1e-6) throw new Error("AE said no");
      orig(t, v);
    };
    expect(() =>
      A.staggerApply({
        comp_id: comp.id,
        mode: "keys",
        property_path: POS,
        targets: [
          { id: l1.id, offset: 1, num_keys: 3, first_time: 1 },
          { id: l2.id, offset: 0.52, num_keys: 3, first_time: 1 },
        ],
        expect: GUARD,
      })
    ).toThrow(/AE said no/);
    expect(times(p1)).toEqual([1, 2, 3]);
    expect(times(p2)).toEqual([1, 2, 3]);
  });

  it("refuses when two keys end up on one time", () => {
    const { comp, A } = scene(1);
    const l = comp.layer(1)!;
    const p = prop(l, "Opacity");
    p.setValueAtTime(1, 0);
    p.setValueAtTime(1.2, 100);
    const orig = p.setValueAtTime.bind(p);
    // AE-like merge: times round to a whole second after the shift.
    p.setValueAtTime = (t: number, v: unknown) => orig(Math.round(t), v);
    expect(() =>
      A.staggerApply({ comp_id: comp.id, mode: "keys", property_path: OPACITY, targets: [{ id: l.id, offset: 0.1, num_keys: 2, first_time: 1 }], expect: GUARD })
    ).toThrow(/same time/);
  });

  it("says so when the rollback could not put the keys back", () => {
    const { comp, A } = scene(2);
    const [l1, l2] = [comp.layer(1)!, comp.layer(2)!];
    const p1 = keyedPosition(l1, 1);
    const p2 = keyedPosition(l2, 1);
    void p2;
    const orig = p1.setValueAtTime.bind(p1);
    let failing = false;
    // The first layer is written fine, then the second fails; restoring the first is refused.
    const p2b = prop(l2, "Position");
    const o2 = p2b.setValueAtTime.bind(p2b);
    p2b.setValueAtTime = (t: number, v: unknown) => {
      if (Math.abs(t - 2.52) < 1e-6) {
        failing = true;
        throw new Error("AE said no");
      }
      o2(t, v);
    };
    p1.setValueAtTime = (t: number, v: unknown) => {
      if (failing) throw new Error("restore refused");
      orig(t, v);
    };
    let message = "";
    try {
      A.staggerApply({
        comp_id: comp.id,
        mode: "keys",
        property_path: POS,
        targets: [
          { id: l1.id, offset: 1, num_keys: 3, first_time: 1 },
          { id: l2.id, offset: 0.52, num_keys: 3, first_time: 1 },
        ],
        expect: GUARD,
      });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/AE said no/);
    expect(message).toMatch(/rollback was incomplete/);
    expect(message).toMatch(/restore refused/);
  });

  it("collects what a setter refuses as warnings and still rebuilds the keys", () => {
    const { comp, A } = scene(1);
    const l = comp.layer(1)!;
    const p = keyedPosition(l, 1);
    (p as any).setLabelAtKey = () => {
      throw new Error("no labels here");
    };
    const out = A.staggerApply({ comp_id: comp.id, mode: "keys", property_path: POS, targets: [{ id: l.id, offset: 1, num_keys: 3, first_time: 1 }], expect: GUARD });
    expect(times(p)).toEqual([2, 3, 4]);
    expect(out.warnings.length).toBe(1);
    expect(out.warnings[0]).toMatch(/label/);
  });
});

describe("stagger.jsx: staggerApply (copy_keys)", () => {
  it("copies the source's keys onto the targets, each shifted, and leaves the source alone", () => {
    const { comp, A } = scene(3);
    const [src, t1, t2] = [comp.layer(1)!, comp.layer(2)!, comp.layer(3)!];
    const ps = keyedPosition(src, 1);
    const p1 = prop(t1, "Position");
    const p2 = prop(t2, "Position");
    enhance(p1);
    enhance(p2);
    const want = snapKeys(ps);
    A.staggerApply({
      comp_id: comp.id,
      mode: "copy_keys",
      property_path: POS,
      source: { id: src.id },
      targets: [
        { id: t1.id, offset: 0.2 },
        { id: t2.id, offset: 0.4 },
      ],
      expect: GUARD,
    });
    expect(times(ps)).toEqual([1, 2, 3]);
    expect(times(p1)).toEqual([1.2, 2.2, 3.2]);
    expect(times(p2)).toEqual([1.4, 2.4, 3.4]);
    expect(snapKeys(p1)).toEqual(want);
    expect(snapKeys(ps)).toEqual(want);
  });

  it("refuses a target that has keys unless replace_existing, and the source as a target", () => {
    const { comp, A } = scene(2);
    const [src, t] = [comp.layer(1)!, comp.layer(2)!];
    keyedPosition(src, 1);
    const pt = prop(t, "Position");
    pt.setValueAtTime(0, [1, 1, 0]);
    const base = { comp_id: comp.id, mode: "copy_keys", property_path: POS, source: { id: src.id }, expect: GUARD };
    expect(() => A.staggerApply({ ...base, targets: [{ id: t.id, offset: 1 }] })).toThrow(/already has 1 keys/);
    expect(() => A.staggerApply({ ...base, targets: [{ id: src.id, offset: 1 }] })).toThrow(/can't also be a target/);
    A.staggerApply({ ...base, replace_existing: true, targets: [{ id: t.id, offset: 1 }] });
    expect(times(pt)).toEqual([2, 3, 4]);
  });

  it("refuses a property of another kind", () => {
    const { comp, A } = scene(2);
    const [src, t] = [comp.layer(1)!, comp.layer(2)!];
    const p = prop(src, "Opacity");
    p.setValueAtTime(0, 0);
    // On the target, the display name "Opacity" belongs to its Position, so the same path reaches a different kind.
    prop(t, "Opacity").name = "Other";
    prop(t, "Position").name = "Opacity";
    expect(() =>
      A.staggerApply({ comp_id: comp.id, mode: "copy_keys", property_path: ["ADBE Transform Group", "Opacity"], source: { id: src.id }, targets: [{ id: t.id, offset: 1 }], expect: GUARD })
    ).toThrow(/different kind/);
  });
});

describe("stagger.jsx: checks before writing", () => {
  it("refuses a locked layer in every apply mode, and a separated Position target", () => {
    const { comp, A, undo } = scene(2);
    const [l1, l2] = [comp.layer(1)!, comp.layer(2)!];
    keyedPosition(l1, 1);
    (l1 as any).locked = true;
    expect(() => A.staggerApply({ comp_id: comp.id, mode: "layers", targets: [{ id: l1.id, from: 0, to: 1 }], expect: GUARD })).toThrow(/locked/);
    expect(() => A.staggerApply({ comp_id: comp.id, mode: "keys", property_path: POS, targets: [{ id: l1.id, offset: 1, num_keys: 3, first_time: 1 }], expect: GUARD })).toThrow(/locked/);
    expect(() => A.staggerLayoutApply({ comp_id: comp.id, targets: [{ id: l1.id, position: [1, 1] }], expect: GUARD })).toThrow(/locked/);
    (l1 as any).locked = false;
    (prop(l2, "Position") as any).dimensionsSeparated = true;
    const src = keyedPosition(l1, 1);
    void src;
    expect(() => A.staggerApply({ comp_id: comp.id, mode: "copy_keys", property_path: POS, source: { id: l1.id }, targets: [{ id: l2.id, offset: 1 }], expect: GUARD })).toThrow(/separated/);
    expect(undo.begun).toBe(0);
  });

  it("refuses two keys landing on one frame before writing anything", () => {
    const { comp, A, undo } = scene(1);
    const l = comp.layer(1)!;
    const p = prop(l, "Opacity");
    p.setValueAtTime(1, 0);
    p.setValueAtTime(1.01, 100);
    expect(() => A.staggerApply({ comp_id: comp.id, mode: "keys", property_path: OPACITY, targets: [{ id: l.id, offset: 0.5, num_keys: 2, first_time: 1 }], expect: GUARD })).toThrow(/same frame/);
    expect(times(p)).toEqual([1, 1.01]);
    expect(undo.begun).toBe(0);
  });

  it("refuses a separated Position with fewer than two follower properties", () => {
    const { comp, A } = scene(1);
    const l = comp.layer(1)!;
    (prop(l, "Position") as any).dimensionsSeparated = true;
    expect(() => A.staggerLayoutApply({ comp_id: comp.id, targets: [{ id: l.id, position: [5, 6] }], expect: GUARD })).toThrow(/separated Position/);
  });

  it("puts back a keyless target's static value when the copy fails", () => {
    const { comp, A } = scene(3);
    const [src, t1, t2] = [comp.layer(1)!, comp.layer(2)!, comp.layer(3)!];
    keyedPosition(src, 1);
    const p1 = prop(t1, "Position");
    const p2 = prop(t2, "Position");
    enhance(p1);
    enhance(p2);
    p1.staticValue = [7, 8, 0];
    const orig = p2.setValueAtTime.bind(p2);
    p2.setValueAtTime = (t: number, v: unknown) => {
      if (Math.abs(t - 2.4) < 1e-6) throw new Error("AE said no");
      orig(t, v);
    };
    expect(() =>
      A.staggerApply({ comp_id: comp.id, mode: "copy_keys", property_path: POS, source: { id: src.id }, targets: [{ id: t1.id, offset: 0.2 }, { id: t2.id, offset: 0.4 }], expect: GUARD })
    ).toThrow(/AE said no/);
    expect(p1.keys.length).toBe(0);
    expect(p1.staticValue).toEqual([7, 8, 0]);
  });
});

describe("stagger.jsx: key write order", () => {
  it("turns auto-bezier off before setting ease, and skips ease on a linear key", () => {
    const { comp, A } = scene(1);
    const l = comp.layer(1)!;
    const p = prop(l, "Opacity");
    enhance(p);
    p.setValueAtTime(1, 0);
    p.setValueAtTime(2, 100);
    p.setInterpolationTypeAtKey(1, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);
    p.setInterpolationTypeAtKey(2, KeyframeInterpolationType.BEZIER);
    (p as any).keys[1].tAuto = false;
    const log: string[] = [];
    for (const m of ["setTemporalAutoBezierAtKey", "setTemporalEaseAtKey", "setTemporalContinuousAtKey"]) {
      const o = (p as any)[m].bind(p);
      (p as any)[m] = (i: number, ...rest: unknown[]) => {
        log.push(`${m}:${i}`);
        return o(i, ...rest);
      };
    }
    A.staggerApply({ comp_id: comp.id, mode: "keys", property_path: OPACITY, targets: [{ id: l.id, offset: 1, num_keys: 2, first_time: 1 }], expect: GUARD });
    // Key 1 is linear/linear: no ease call. Key 2 is bezier: auto-bezier off comes before the ease.
    expect(log.filter((e) => e === "setTemporalEaseAtKey:1")).toEqual([]);
    expect(log.indexOf("setTemporalAutoBezierAtKey:2")).toBeLessThan(log.indexOf("setTemporalEaseAtKey:2"));
  });
});

describe("stagger.jsx: layout", () => {
  it("reads positions and their state, then sets X and Y keeping Z", () => {
    const { comp, A, undo } = scene(3);
    const [a, b, c] = [comp.layer(1)!, comp.layer(2)!, comp.layer(3)!];
    prop(a, "Position").staticValue = [10, 20, 7];
    const r = fromJson(A.staggerLayoutRead({ comp_id: comp.id, layers: [{ index: 1 }, { index: 2 }] }));
    expect(r).toMatchObject({ width: 640, height: 360 });
    expect(r.layers[0]).toMatchObject({ state: "static", position: [10, 20, 7], separated: false });
    A.staggerLayoutApply({
      comp_id: comp.id,
      targets: [
        { id: a.id, position: [100, 50] },
        { id: b.id, position: [200, 50] },
        { id: c.id, position: [300, 50] },
      ],
      expect: GUARD,
    });
    expect(prop(a, "Position").staticValue).toEqual([100, 50, 7]);
    expect(prop(c, "Position").staticValue).toEqual([300, 50, 0]);
    expect(undo.begun).toBe(1);
  });

  it("refuses keyed or expression positions, and a bad position, before changing anything", () => {
    const { comp, A } = scene(3);
    const [a, b, c] = [comp.layer(1)!, comp.layer(2)!, comp.layer(3)!];
    prop(b, "Position").setValueAtTime(0, [1, 1, 0]);
    prop(c, "Position").expressionEnabled = true;
    const run = (targets: unknown[]) => A.staggerLayoutApply({ comp_id: comp.id, targets, expect: GUARD });
    expect(() => run([{ id: a.id, position: [1, 1] }, { id: b.id, position: [1, 1] }])).toThrow(/Position keyframes/);
    expect(() => run([{ id: c.id, position: [1, 1] }])).toThrow(/expression/);
    expect(() => run([{ id: a.id, position: [1, "x"] }])).toThrow(/must be \[x, y\]/);
    expect(prop(a, "Position").staticValue).toEqual([320, 180, 0]);
    expect(fromJson(A.staggerLayoutRead({ comp_id: comp.id, layers: [{ id: b.id }, { id: c.id }] })).layers.map((l: { state: string }) => l.state)).toEqual(["keyed", "expression"]);
  });

  it("puts the Positions back when a later write fails, and says so when a restore is refused", () => {
    const run = (refuseRestore: boolean) => {
      const { comp, A } = scene(2);
      const [a, b] = [comp.layer(1)!, comp.layer(2)!];
      const pa = prop(a, "Position") as any;
      const pb = prop(b, "Position") as any;
      const origA = pa.setValue.bind(pa);
      let calls = 0;
      pa.setValue = (v: unknown) => {
        calls++;
        if (refuseRestore && calls > 1) throw new Error("locked again");
        return origA(v);
      };
      pb.setValue = () => {
        throw new Error("second write refused");
      };
      let msg = "";
      try {
        A.staggerLayoutApply({
          comp_id: comp.id,
          targets: [{ id: a.id, position: [100, 50] }, { id: b.id, position: [200, 50] }],
          expect: GUARD,
        });
      } catch (e) {
        msg = (e as Error).message;
      }
      return { msg, pa };
    };
    const ok = run(false);
    expect(ok.msg).toMatch(/second write refused/);
    expect(ok.msg).not.toMatch(/ReferenceError|not defined/);
    expect(ok.pa.staticValue).toEqual([320, 180, 0]);
    const bad = run(true);
    expect(bad.msg).toMatch(/second write refused/);
    expect(bad.msg).toMatch(/rollback was incomplete/);
  });

  it("sets a separated Position through its X and Y", () => {
    const { comp, A } = scene(1);
    const l = comp.layer(1)!;
    const pos = prop(l, "Position") as any;
    pos.dimensionsSeparated = true;
    const g = (l.group.property("ADBE Transform Group") as any);
    const mk = (n: string, mn: string) => {
      const q = new (pos.constructor as any)(n, mn, 6417, 0);
      q.parentProperty = g;
      g.props.push(q);
      return q;
    };
    const x = mk("X Position", "ADBE Position_0");
    const y = mk("Y Position", "ADBE Position_1");
    A.staggerLayoutApply({ comp_id: comp.id, targets: [{ id: l.id, position: [5, 6] }], expect: GUARD });
    expect([x.staticValue, y.staticValue]).toEqual([5, 6]);
  });
});

// Typing aid: the fake comp type is used by the helpers above.
void (null as unknown as FakeComp);

describe("stagger.jsx: key helpers exposed on A.__keys (for ae_keyframes_transform)", () => {
  it("exposes snapshot, write, collisions and describe, and ae_stagger still works with them there", () => {
    const { comp, A } = scene(1);
    const l = comp.layer(1)!;
    const p = prop(l, "Opacity");
    enhance(p);
    p.setValueAtTime(1, 0);
    p.setValueAtTime(2, 100);
    expect(Object.keys(A.__keys).sort()).toEqual(["collisions", "describe", "snapshot", "write"]);
    expect(A.__keys.snapshot(p, 500).map((k: { time: number }) => k.time)).toEqual([1, 2]);
    expect(fromJson(A.__keys.describe(A.__keys.snapshot(p, 500)))[1]).toMatchObject({ time: 2, value: 100 });
    A.staggerApply({ comp_id: comp.id, mode: "keys", property_path: OPACITY, targets: [{ id: l.id, offset: 1, num_keys: 2, first_time: 1 }], expect: GUARD });
    expect(times(p)).toEqual([2, 3]);
  });

  it("write puts a snapshot back at a new time, and collisions refuses two keys on one frame", () => {
    const { comp, A } = scene(1);
    const p = prop(comp.layer(1)!, "Opacity");
    enhance(p);
    p.setValueAtTime(1, 0);
    p.setValueAtTime(2, 100);
    const snap = A.__keys.snapshot(p, 500);
    const warnings: string[] = [];
    A.__keys.write(p, snap, 0.5, warnings, "test");
    expect(times(p)).toEqual([1.5, 2.5]);
    expect(values(p)).toEqual([0, 100]);
    expect(() => A.__keys.collisions([{ time: 1 }, { time: 1.01 }], 0, 0.04, "x")).toThrow(/same frame/);
    expect(() => A.__keys.collisions([{ time: 1 }, { time: 1.04 }], 0, 0.04, "x")).not.toThrow();
  });
});

function values(p: FakeProperty) {
  return p.keys.map((k) => k.value);
}
