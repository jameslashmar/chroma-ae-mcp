/**
 * Regression tests for the animation review fixes: ae_get_keyframes ranges
 * before the 500-key cap, ae_remove_keyframes dry runs and no-match stops,
 * the pre-expression read-back, roving keys left out of the ease check,
 * defensive roving, and parent motion in the rest times.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import { AeSetKeyframeEaseSchema, animateTools, extractKeyframeEaseCheck } from "../src/tools/ext/animate.js";
import { AeRemoveKeyframesSchema, keyframesTools, removeKeysMismatches } from "../src/tools/ext/keyframes.js";
import { AeMotionReviewSchema, analyzeMotion, motionTools, restTimes, sampleSpeeds, type PropertyKey, type PropertySamples } from "../src/tools/ext/motion.js";
import { FakeProject, GUARD, loadHost } from "./support/fake-ae.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function fakeAe(results: Record<string, unknown[]>) {
  const calls: Array<{ fn: string; script: string }> = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-fixanim-"));
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

const remove = keyframesTools.find((t) => t.name === "ae_remove_keyframes")!;
const get = keyframesTools.find((t) => t.name === "ae_get_keyframes")!;
const ease = animateTools.find((t) => t.name === "ae_set_keyframe_ease")!;
const base = { comp_id: 1, layer: { name: "Ball" }, path: ["ADBE Transform Group", "ADBE Opacity"], expect: { project_path: "<unsaved>" } };
const snap = (n: number, numKeys = n, truncated = false) => ({
  numKeys,
  keys: Array.from({ length: n }, (_, i) => ({ index: i + 1, time: i, value: i })),
  truncated,
  value: null,
});

describe("host: keys past 500, empty selections, pre-expression value, roving", () => {
  function animated() {
    const project = new FakeProject();
    const comp = project.addComp("Main", 640, 360, 4);
    const { A, undo } = loadHost(project, ["layers.jsx", "keyframes.jsx", "audio.jsx", "animate.jsx", "motion.jsx"]);
    A.createLayer({ comp_id: comp.id, type: "solid", name: "Ball", expect: GUARD });
    const ball = comp.layer("Ball")!;
    return { project, comp, A, undo, ball, opacity: ball.transform("ADBE Opacity") as any, pos: ball.transform("ADBE Position") as any };
  }
  const L = { name: "Ball" };
  const OPACITY = ["ADBE Transform Group", "ADBE Opacity"];
  const POSITION = ["ADBE Transform Group", "ADBE Position"];

  it("getKeyframeEase applies start/end before the 500-key cap", () => {
    const { comp, A, opacity } = animated();
    const times = Array.from({ length: 600 }, (_, i) => i);
    opacity.setValuesAtTimes(times, times.map((t) => t % 100));
    const all = A.getKeyframeEase({ comp_id: comp.id, layer: L, path: OPACITY });
    expect(all.keyframes).toHaveLength(500);
    expect(all.truncated).toBe(true);
    const late = A.getKeyframeEase({ comp_id: comp.id, layer: L, path: OPACITY, start: 550, end: 560 });
    expect(late.keyframes.map((k: any) => k.keyIndex)).toEqual([551, 552, 553, 554, 555, 556, 557, 558, 559, 560, 561]);
    expect(late.keyframes[0].time).toBe(550);
    expect(late.truncated).toBeUndefined();
    expect(late.numKeys).toBe(600);
  });

  it("removeKeys stops on a selection that matches no key", () => {
    const { comp, A, opacity } = animated();
    opacity.setValuesAtTimes([0, 1], [0, 100]);
    expect(() => A.removeKeys({ comp_id: comp.id, layer: L, path: OPACITY, start: 10, end: 11, expect: GUARD })).toThrow(/No keys match/);
    expect(opacity.numKeys).toBe(2);
  });

  it("keysSnapshotStatic reads the value before expressions, as removeKeys wrote it", () => {
    const { comp, A, opacity } = animated();
    opacity.setValuesAtTimes([0, 1], [20, 60]);
    opacity.expressionEnabled = true;
    // The fake has no expressions: make `value` the evaluated one and valueAtTime(t, true) the keyframed one.
    const staticOf = opacity.valueAtTime.bind(opacity);
    Object.defineProperty(opacity, "value", { get: () => (opacity.numKeys ? 0 : 99) });
    opacity.valueAtTime = (t: number, pre: boolean) => (opacity.numKeys || pre ? staticOf(t, pre) : 99);
    const w = A.removeKeys({ comp_id: comp.id, layer: L, path: OPACITY, all: true, static_value_at: 1, expect: GUARD });
    expect(w.static_value).toBe(60);
    expect(A.keysSnapshot({ comp_id: comp.id, layer: L, path: OPACITY }).value).toBe(99);
    const after = A.keysSnapshotStatic({ comp_id: comp.id, layer: L, path: OPACITY });
    expect(after.value).toBe(60);
    expect(removeKeysMismatches({ numKeys: 2, keys: [] }, after, w)).toEqual([]);
  });

  it("removeKeys does not report a static value it cannot compare", () => {
    const { comp, A, opacity } = animated();
    opacity.setValuesAtTimes([0, 1], [0, 100]);
    opacity.valueAtTime = () => ({ not: "a number" });
    const w = A.removeKeys({ comp_id: comp.id, layer: L, path: OPACITY, all: true, expect: GUARD });
    expect(w.numKeys).toBe(0);
    expect(w.static_value).toBeUndefined();
    expect(w.static_value_at).toBeUndefined();
  });

  it("setKeyframeEase reports a key that will not rove instead of throwing, and refuses hold with roving", () => {
    const { comp, A, undo, pos } = animated();
    pos.setValuesAtTimes([0, 1, 2, 3], [[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0]]);
    const real = pos.setRovingAtKey.bind(pos);
    pos.setRovingAtKey = (i: number, on: boolean) => {
      if (i === 3) throw new Error("no roving here");
      real(i, on);
    };
    const r = A.setKeyframeEase({ comp_id: comp.id, layer: L, path: POSITION, keys: [1, 4], ease: "easy_ease", rove_between: true, expect: GUARD });
    expect(r.roving).toEqual([2, 3]);
    expect(r.roving_failed).toEqual([3]);
    expect(pos.keyRoving(2)).toBe(true);
    expect(undo.begun).toBe(undo.ended);
    expect(() => A.setKeyframeEase({ comp_id: comp.id, layer: L, path: POSITION, keys: [1, 4], ease: "hold", rove_between: true, expect: GUARD })).toThrow(/hold/);
  });

  it("listAnimatedProperties lists each layer's parent chain and scans parents of a narrowed list", () => {
    const { comp, A } = animated();
    A.createLayer({ comp_id: comp.id, type: "null", name: "Rig", expect: GUARD });
    const ball = comp.layer("Ball")!;
    const rig = comp.layer("Rig")!;
    ball.parent = rig;
    (ball.transform("ADBE Position") as any).setValuesAtTimes([0, 1], [[0, 0, 0], [10, 0, 0]]);
    (rig.transform("ADBE Position") as any).setValuesAtTimes([0, 3], [[0, 0, 0], [30, 0, 0]]);
    const all = A.listAnimatedProperties({ comp_id: comp.id });
    const ballEntry = all.properties.find((p: any) => p.layer.name === "Ball");
    expect(ballEntry.layer.parents).toEqual([rig.id]);
    expect(all.properties.some((p: any) => p.ancestor_only)).toBe(false);
    const narrowed = A.listAnimatedProperties({ comp_id: comp.id, layers: [L] });
    expect(narrowed.properties.map((p: any) => [p.layer.name, p.ancestor_only === true])).toEqual([
      ["Ball", false],
      ["Rig", true],
    ]);
  });
});

describe("ae_get_keyframes", () => {
  it("sends start and end to the host", async () => {
    const { ctx, calls } = fakeAe({ getKeyframeEase: [{ name: "Opacity", matchName: "ADBE Opacity", isSpatial: false, numKeys: 0, keyframes: [] }] });
    await get.handler({ comp_id: 1, layer: { name: "Ball" }, path: base.path, start: 40, end: 45 }, ctx);
    expect(calls[0].script).toContain('"start":40');
    expect(calls[0].script).toContain('"end":45');
  });
});

describe("ae_remove_keyframes dry run and empty selections", () => {
  const run = (args: object, ctx: ToolContext) => remove.handler(AeRemoveKeyframesSchema.parse({ ...base, ...args }), ctx);

  it("counts all keys from numKeys when the snapshot is capped, and says so", async () => {
    const { ctx } = fakeAe({ keysSnapshot: [snap(500, 800, true)] });
    const out = await run({ all: true, dry_run: true }, ctx);
    expect(out).toMatchObject({ ok: true, count: 800, all_keys: true, truncated: true });
    expect(out.keys).toHaveLength(500);
    expect(out.note).toMatch(/500/);
  });

  it("sends a time range to the host so the cap applies in range", async () => {
    const { ctx, calls } = fakeAe({ keysSnapshot: [snap(3)] });
    const out = await run({ start: 1, end: 2, dry_run: true }, ctx);
    expect(calls[0].script).toContain('"start":1');
    expect(out).toMatchObject({ count: 2, all_keys: false, truncated: false });
    expect(out.note).toBeUndefined();
  });

  it("rejects an index past the last key, as the write would", async () => {
    const { ctx } = fakeAe({ keysSnapshot: [snap(5)] });
    expect(await run({ keys: [900], dry_run: true }, ctx)).toMatchObject({ ok: false, error: "bad_args" });
  });

  it("does not call an empty property all_keys", async () => {
    const { ctx } = fakeAe({ keysSnapshot: [snap(0)] });
    expect(await run({ all: true, dry_run: true }, ctx)).toMatchObject({ count: 0, all_keys: false });
  });

  it("stops before the checkpoint and the write when a range matches no keys", async () => {
    const { ctx, calls } = fakeAe({ keysSnapshot: [snap(3)] });
    const out = await run({ start: 10, end: 11 }, ctx);
    expect(out).toMatchObject({ ok: false, error: "no_match", numKeys: 3 });
    expect(calls.map((c) => c.fn)).toEqual(["checkGuard", "keysSnapshot"]);
  });

  it("stops on a bad index before the write, and on all:true with no keys", async () => {
    const a = fakeAe({ keysSnapshot: [snap(5)] });
    expect(await run({ keys: [900] }, a.ctx)).toMatchObject({ ok: false, error: "bad_args" });
    expect(a.calls.map((c) => c.fn)).toEqual(["checkGuard", "keysSnapshot"]);
    const b = fakeAe({ keysSnapshot: [snap(0)] });
    expect(await run({ all: true }, b.ctx)).toMatchObject({ ok: false, error: "no_match" });
  });

  it("fails with the guard error, before reading the selection, when another project is open", async () => {
    const { ctx, calls } = fakeAe({ keysSnapshot: [snap(3)] });
    await expect(run({ expect: { project_path: "C:/jobs/Other.aep" }, all: true }, ctx)).rejects.toThrow(/Target guard refused/);
    expect(calls.map((c) => c.fn)).toEqual(["checkGuard"]);
  });

  it("still writes an index past the capped snapshot, with the pre-expression read-backs", async () => {
    const { ctx, calls } = fakeAe({
      keysSnapshot: [snap(500, 800, true)],
      keysSnapshotStatic: [snap(500, 800, true), snap(500, 799, true)],
      removeKeys: [{ removed: [{ index: 600, time: 600, value: 0 }], numKeys: 799 }],
    });
    const out = await run({ keys: [600] }, ctx);
    expect(out.applied).toBe(true);
    expect(calls.map((c) => c.fn)).toEqual(["checkGuard", "keysSnapshot", "checkGuard", "keysSnapshotStatic", "removeKeys", "keysSnapshotStatic"]);
  });
});

describe("ae_set_keyframe_ease with rove_between", () => {
  const kf = (keyIndex: number, speed: number, roving: boolean) => ({
    keyIndex,
    time: keyIndex - 1,
    value: [0, 0],
    inInterp: "bezier",
    outInterp: "bezier",
    easeIn: [{ speed, influence: speed === 0 ? 33.333333 : 61 }],
    easeOut: [{ speed, influence: speed === 0 ? 33.333333 : 61 }],
    roving,
  });
  const position = ["ADBE Transform Group", "ADBE Position"];

  it("leaves roving keys out of the ease check when keys is omitted", async () => {
    const { ctx } = fakeAe({
      getKeyframeEase: [
        { name: "Position", isSpatial: true, numKeys: 4, keyframes: [kf(1, 0, false), kf(2, 0, false), kf(3, 0, false), kf(4, 0, false)] },
        { name: "Position", isSpatial: true, numKeys: 4, keyframes: [kf(1, 0, false), kf(2, 140, true), kf(3, 140, true), kf(4, 0, false)] },
      ],
      setKeyframeEase: [{ keysUpdated: [1, 2, 3, 4], roving: [2, 3], roving_failed: [], mode: "easy_ease" }],
    });
    const out = await ease.handler(AeSetKeyframeEaseSchema.parse({ ...base, path: position, ease: "easy_ease", rove_between: true }), ctx);
    expect(out.receipt.mismatches).toEqual([]);
    expect(out.receipt.matches).toBe(true);
  });

  it("still flags a roving key that did not rove, and an end key with the wrong ease", async () => {
    const { ctx } = fakeAe({
      getKeyframeEase: [
        { name: "Position", isSpatial: true, numKeys: 3, keyframes: [kf(1, 0, false), kf(2, 0, false), kf(3, 0, false)] },
        { name: "Position", isSpatial: true, numKeys: 3, keyframes: [kf(1, 0, false), kf(2, 0, false), kf(3, 50, false)] },
      ],
      setKeyframeEase: [{ keysUpdated: [1, 2, 3], roving: [2], roving_failed: [2], mode: "easy_ease" }],
    });
    const out = await ease.handler(AeSetKeyframeEaseSchema.parse({ ...base, path: position, ease: "easy_ease", rove_between: true }), ctx);
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches.some((m: { path: string }) => m.path.includes("keyframes[2].roving"))).toBe(true);
    expect(out.receipt.mismatches.some((m: { path: string }) => m.path.startsWith("expected.keyframes[1]"))).toBe(true);
  });

  it("skips the listed keys in extractKeyframeEaseCheck", () => {
    const after = { keyframes: [kf(1, 0, false), kf(2, 140, true), kf(3, 0, false)] };
    const check = extractKeyframeEaseCheck("easy_ease", [1, 2, 3], after, [2]) as { expected: { keyframes: Array<{ keyIndex: number }> } };
    expect(check.expected.keyframes.map((k) => k.keyIndex)).toEqual([1, 3]);
    expect(extractKeyframeEaseCheck("easy_ease", [2], after, [2])).toBeNull();
  });

  it("refuses hold with rove_between before AE is touched", async () => {
    const { ctx, calls } = fakeAe({});
    const out = await ease.handler(AeSetKeyframeEaseSchema.parse({ ...base, path: position, ease: "hold", rove_between: true }), ctx);
    expect(out).toMatchObject({ ok: false, error: "bad_args" });
    expect(calls).toEqual([]);
  });
});

describe("restTimes with a moving parent", () => {
  function samples(matchName: string, layerId: number, keys: PropertyKey[]): { samples: PropertySamples; analysis: ReturnType<typeof analyzeMotion> } {
    const fps = 25;
    const start = keys[0].time;
    const end = keys[keys.length - 1].time;
    const times: number[] = [];
    for (let i = 0; start + i / fps <= end + 1e-9; i++) times.push(start + i / fps);
    const a = keys[0].value[0];
    const b = keys[1].value[0];
    const values = times.map((t) => [a + ((b - a) * (t - start)) / (end - start), 0]);
    const s: PropertySamples = {
      comp: { id: 7, name: "Shot", fps },
      layer: { index: 1, id: layerId, name: "L" + layerId },
      property: { name: "Position", matchName, value_type: "TwoD_SPATIAL", spatial: true, dimensions: 2, num_keys: 2, keys_truncated: false, samples_capped: false, expression: false },
      start,
      end,
      step: 1 / fps,
      times,
      values,
      keys,
    };
    return { samples: s, analysis: analyzeMotion(s, sampleSpeeds(s)) };
  }
  const k = (index: number, time: number, x: number): PropertyKey => ({ index, time, value: [x, 0], in_interp: "linear", out_interp: "linear" });

  it("drops a time at which a parent is still moving", () => {
    const child = samples("ADBE Position", 11, [k(1, 0, 0), k(2, 2, 100)]);
    const parent = samples("ADBE Position", 12, [k(1, 0, 0), k(2, 5, 500)]);
    expect(restTimes([child], 25)).toEqual([2]);
    // The child's own stop is inside the parent's move; the chain stops at 5.
    expect(restTimes([child], 25, [parent])).toEqual([5]);
  });

  it("keeps a time after the parent has stopped", () => {
    const child = samples("ADBE Position", 11, [k(1, 0, 0), k(2, 4, 100)]);
    const parent = samples("ADBE Position", 12, [k(1, 0, 0), k(2, 1, 500)]);
    expect(restTimes([child], 25, [parent])).toEqual([4]);
  });
  it("ae_motion_review checks a child where its moving parent stops, without reviewing the parent", async () => {
    const child = samples("ADBE Position", 11, [k(1, 0, 0), k(2, 2, 100)]);
    const parent = samples("ADBE Position", 12, [k(1, 0, 0), k(2, 5, 500)]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-fixanim-mr-"));
    tmpDirs.push(dir);
    const queue = new SingleWriterQueue();
    const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
    const scripts: string[] = [];
    const entry = (sm: typeof child, id: number, extra: Record<string, unknown>) => ({
      layer: { index: 1, id, name: "L" + id, parents: id === 11 ? [12] : [] },
      path: ["ADBE Transform Group", "ADBE Position"],
      name: "Position",
      matchName: "ADBE Position",
      num_keys: 2,
      first_key_time: 0,
      last_key_time: sm.samples.end,
      expression: false,
      ...extra,
    });
    const host = new PanelHost({
      evalScript: async (script) => {
        scripts.push(script);
        if (script.includes("listAnimatedProperties(")) {
          return {
            ok: true,
            durationMs: 1,
            result: {
              comp: { id: 7, name: "Shot", fps: 25, width: 1920, height: 1080, workAreaStart: 0, workAreaDuration: 6 },
              project_path: "C:/jobs/Shot.aep",
              layers_scanned: 1,
              ancestors_scanned: 1,
              truncated: false,
              properties: [entry(child, 11, {}), entry(parent, 12, { ancestor_only: true })],
            },
          };
        }
        if (script.includes("layerBoundsAt(")) {
          return {
            ok: true,
            durationMs: 1,
            result: { layer: { index: 1, id: 11, name: "L11", is_text: false }, comp: { width: 1920, height: 1080 }, checkable: true, samples: [] },
          };
        }
        return { ok: true, durationMs: 1, result: script.includes('"id":12') ? parent.samples : child.samples };
      },
      queue,
      quarantine,
    });
    const tool = motionTools.find((t) => t.name === "ae_motion_review")!;
    const res = (await tool.handler(AeMotionReviewSchema.parse({ comp_id: 7, layers: [{ id: 11 }] }), { bridge: host, queue, quarantine })) as Record<string, any>;
    expect(res.properties_scanned).toBe(1);
    expect(res.layers_scanned).toBe(1);
    expect(res.ancestors_scanned).toBe(1);
    expect((res.findings as Array<{ layer?: { id: number } }>).every((f) => f.layer?.id !== 12)).toBe(true);
    expect(scripts.find((x) => x.includes("layerBoundsAt("))).toContain('"times":[5]');
  });
});
