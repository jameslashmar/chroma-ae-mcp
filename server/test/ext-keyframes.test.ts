import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import { AeSetKeyframeEaseSchema, animateTools, rovingMismatches } from "../src/tools/ext/animate.js";
import {
  AeRemoveKeyframesSchema,
  describeKey,
  easeSideName,
  keyframesTools,
  removeKeysMismatches,
  selectKeys,
} from "../src/tools/ext/keyframes.js";
import { AUTO_CHECKPOINT_TOOLS } from "../src/tools/ext/receipts.js";
import { ALL_TOOLS } from "../src/tools/registry.js";
import { FakeProject, loadHost } from "./support/fake-ae.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function fakeAe(results: Record<string, unknown[]>) {
  const calls: Array<{ fn: string; script: string }> = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-kf-q-"));
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

const tool = (name: string) => keyframesTools.find((t) => t.name === name)!;
const base = { comp_id: 1, layer: { name: "Ball" }, path: ["ADBE Transform Group", "ADBE Opacity"], expect: { project_path: "<unsaved>" } };
const snap = (keys: Array<[number, number]>, value: unknown = null) => ({
  numKeys: keys.length,
  keys: keys.map(([time, v], i) => ({ index: i + 1, time, value: v })),
  truncated: false,
  value,
});

describe("keyframe tools", () => {
  it("are registered; removal takes an automatic checkpoint", () => {
    expect(ALL_TOOLS.some((t) => t.name === "ae_get_keyframes")).toBe(true);
    expect(ALL_TOOLS.some((t) => t.name === "ae_remove_keyframes")).toBe(true);
    expect(AUTO_CHECKPOINT_TOOLS).toContain("ae_remove_keyframes");
  });

  it("names each side of a key's ease", () => {
    expect(easeSideName("linear", [])).toBe("linear");
    expect(easeSideName("hold", [])).toBe("hold");
    expect(easeSideName("bezier", [{ speed: 0, influence: 33.333333 }])).toBe("easy ease");
    expect(easeSideName("bezier", [{ speed: 0, influence: 75 }])).toBe("bezier");
  });

  it("ae_get_keyframes describes keys and filters by time", async () => {
    const entry = (keyIndex: number, time: number) => ({
      keyIndex,
      time,
      value: 100,
      inInterp: "bezier",
      outInterp: "linear",
      easeIn: [{ speed: 0, influence: 33.333333 }],
      easeOut: [{ speed: 0, influence: 16.666 }],
    });
    const { ctx } = fakeAe({ getKeyframeEase: [{ name: "Opacity", matchName: "ADBE Opacity", isSpatial: false, numKeys: 2, keyframes: [entry(1, 0), entry(2, 2)] }] });
    const out = await tool("ae_get_keyframes").handler({ comp_id: 1, layer: { name: "Ball" }, path: base.path, start: 1 }, ctx);
    expect(out.numKeys).toBe(2);
    expect(out.keys).toHaveLength(1);
    expect(out.keys[0]).toMatchObject({ index: 2, in: { name: "easy ease" }, out: { name: "linear" } });
    expect(describeKey({ ...entry(1, 0), roving: true, inTangent: [1, 2], outTangent: [3, 4] })).toMatchObject({ roving: true, in_tangent: [1, 2] });
  });

  it("ae_remove_keyframes removes, reads back separately, and checks the kept value", async () => {
    const { ctx, calls } = fakeAe({
      keysSnapshot: [snap([[0, 0], [1, 100]])],
      keysSnapshotStatic: [snap([[0, 0], [1, 100]]), snap([], 60)],
      removeKeys: [{ removed: [{ index: 1, time: 0, value: 0 }, { index: 2, time: 1, value: 100 }], numKeys: 0, static_value: 60, static_value_at: 0.6 }],
    });
    const out = await tool("ae_remove_keyframes").handler(AeRemoveKeyframesSchema.parse({ ...base, all: true, static_value_at: 0.6 }), ctx);
    expect(calls.map((c) => c.fn)).toEqual(["checkGuard", "keysSnapshot", "checkGuard", "keysSnapshotStatic", "removeKeys", "keysSnapshotStatic"]);
    expect(out.receipt.matches).toBe(true);
    expect(out).toMatchObject({ numKeys: 0, static_value: 60, static_value_at: 0.6 });
  });

  it("ae_remove_keyframes dry run lists the keys without writing", async () => {
    const { ctx, calls } = fakeAe({ keysSnapshot: [snap([[0, 0], [1, 50], [2, 100]])] });
    const out = await tool("ae_remove_keyframes").handler(AeRemoveKeyframesSchema.parse({ ...base, start: 0.5, dry_run: true }), ctx);
    expect(calls.map((c) => c.fn)).toEqual(["keysSnapshot"]);
    expect(out).toMatchObject({ dry_run: true, count: 2, all_keys: false });
  });

  it("selects like the host and flags keys left behind", () => {
    const keys = [{ index: 1, time: 0 }, { index: 2, time: 1 }, { index: 3, time: 2 }];
    const sel = (a: object) => selectKeys(keys, AeRemoveKeyframesSchema.parse({ ...base, ...a })).map((k) => k.index);
    expect(sel({ keys: [3, 1] })).toEqual([1, 3]);
    expect(sel({ end: 1 })).toEqual([1, 2]);
    expect(AeRemoveKeyframesSchema.safeParse(base).success).toBe(false);
    const m = removeKeysMismatches(snap([[0, 0], [1, 1]]), snap([[0, 0], [1, 1]]), { removed: [{ time: 1 }] });
    expect(m.map((x) => x.path)).toEqual(["numKeys", "keys@1"]);
  });
});

describe("ae_set_keyframe_ease rove_between", () => {
  const ease = animateTools.find((t) => t.name === "ae_set_keyframe_ease")!;

  it("is refused with a curve before AE is touched", async () => {
    const { ctx, calls } = fakeAe({});
    const args = AeSetKeyframeEaseSchema.parse({ ...base, path: ["ADBE Transform Group", "ADBE Position"], keys: [1, 3], ease: { curve: [0.42, 0, 0.58, 1] }, rove_between: true });
    expect(await ease.handler(args, ctx)).toMatchObject({ ok: false, error: "bad_args" });
    expect(calls).toEqual([]);
  });

  it("passes rove_between to AE and checks the middle keys went roving", async () => {
    const kf = (keyIndex: number, roving: boolean) => ({ keyIndex, time: keyIndex - 1, value: [0, 0], inInterp: "bezier", outInterp: "bezier", easeIn: [{ speed: 0, influence: 33.333333 }], easeOut: [{ speed: 0, influence: 33.333333 }], roving });
    const { ctx, calls } = fakeAe({
      getKeyframeEase: [
        { name: "Position", isSpatial: true, numKeys: 3, keyframes: [kf(1, false), kf(2, false), kf(3, false)] },
        { name: "Position", isSpatial: true, numKeys: 3, keyframes: [kf(1, false), kf(2, true), kf(3, false)] },
      ],
      setKeyframeEase: [{ keysUpdated: [1, 3], roving: [2], mode: "easy_ease" }],
    });
    const args = AeSetKeyframeEaseSchema.parse({ ...base, path: ["ADBE Transform Group", "ADBE Position"], keys: [1, 3], ease: "easy_ease", rove_between: true });
    const out = await ease.handler(args, ctx);
    expect(calls.find((c) => c.fn === "setKeyframeEase")?.script).toContain('"rove_between":true');
    expect(out.receipt.mismatches.filter((m: { path: string }) => m.path.includes("roving"))).toEqual([]);
    expect(rovingMismatches([2], { keyframes: [kf(2, false)] })[0].message).toBe("Key 2 is not roving");
  });
});

describe("ae_get_keyframes extra fields", () => {
  const entry = {
    keyIndex: 2,
    time: 1,
    value: [0, 0],
    inInterp: "bezier",
    outInterp: "bezier",
    easeIn: [{ speed: 0, influence: 33.333333 }],
    easeOut: [{ speed: 0, influence: 33.333333 }],
  };

  it("surfaces continuity and auto-bezier flags, selection and label in snake_case when the host reports them", () => {
    const d = describeKey({
      ...entry,
      spatialContinuous: true,
      spatialAutoBezier: false,
      temporalContinuous: false,
      temporalAutoBezier: true,
      selected: true,
      label: 3,
      roving: false,
      inTangent: [1, 2],
      outTangent: [3, 4],
    });
    expect(d).toMatchObject({
      spatial_continuous: true,
      spatial_auto_bezier: false,
      temporal_continuous: false,
      temporal_auto_bezier: true,
      selected: true,
      label: 3,
      roving: false,
      in_tangent: [1, 2],
    });
  });

  it("leaves a field out when the host does not report it, and keeps every old field", () => {
    const d = describeKey(entry);
    expect(Object.keys(d).sort()).toEqual(["in", "index", "out", "time", "value"]);
    expect(d).toMatchObject({ index: 2, time: 1, in: { interpolation: "bezier", name: "easy ease" } });
  });

  it("passes the new fields through the tool", async () => {
    const { ctx } = fakeAe({
      getKeyframeEase: [{ name: "Position", matchName: "ADBE Position", isSpatial: true, numKeys: 1, keyframes: [{ ...entry, keyIndex: 1, spatialAutoBezier: true, selected: false, label: 0 }] }],
    });
    const out = await tool("ae_get_keyframes").handler({ comp_id: 1, layer: { name: "Ball" }, path: base.path }, ctx);
    expect(out.keys[0]).toMatchObject({ spatial_auto_bezier: true, selected: false, label: 0 });
  });
});

describe("ae_remove_keyframes keys: 'selected'", () => {
  const sel = (selected: number[], numKeys = 3) => ({ numKeys, selected_keys: selected, times: selected.map((i) => i - 1), source: "selectedKeys" });

  it("accepts 'selected' or an index list, nothing else", () => {
    expect(AeRemoveKeyframesSchema.safeParse({ ...base, keys: "selected" }).success).toBe(true);
    expect(AeRemoveKeyframesSchema.safeParse({ ...base, keys: [1, 2] }).success).toBe(true);
    expect(AeRemoveKeyframesSchema.safeParse({ ...base, keys: "all" }).success).toBe(false);
    expect(AeRemoveKeyframesSchema.safeParse({ ...base, keys: [] }).success).toBe(false);
  });

  it("dry run resolves the selection into explicit indexes and writes nothing", async () => {
    const { ctx, calls } = fakeAe({ keyframesSelection: [sel([1, 3])], keysSnapshot: [snap([[0, 0], [1, 50], [2, 100]])] });
    const out = await tool("ae_remove_keyframes").handler(AeRemoveKeyframesSchema.parse({ ...base, keys: "selected", dry_run: true }), ctx);
    expect(calls.map((c) => c.fn)).toEqual(["keyframesSelection", "keysSnapshot"]);
    expect(out).toMatchObject({ dry_run: true, count: 2, selected: { keys: [1, 3] } });
    expect(out.keys.map((k: { index: number }) => k.index)).toEqual([1, 3]);
  });

  it("removes the selected keys with the explicit indexes in the write", async () => {
    const { ctx, calls } = fakeAe({
      keyframesSelection: [sel([2])],
      keysSnapshot: [snap([[0, 0], [1, 50], [2, 100]])],
      keysSnapshotStatic: [snap([[0, 0], [1, 50], [2, 100]]), snap([[0, 0], [2, 100]])],
      removeKeys: [{ removed: [{ index: 2, time: 1, value: 50 }], numKeys: 2 }],
    });
    const out = await tool("ae_remove_keyframes").handler(AeRemoveKeyframesSchema.parse({ ...base, keys: "selected" }), ctx);
    expect(calls.map((c) => c.fn)).toEqual(["checkGuard", "keyframesSelection", "keysSnapshot", "checkGuard", "keysSnapshotStatic", "removeKeys", "keysSnapshotStatic"]);
    expect(calls.find((c) => c.fn === "removeKeys")!.script).toContain('"keys":[2]');
    expect(out.receipt.matches).toBe(true);
    expect(out).toMatchObject({ selected: { keys: [2] }, numKeys: 2 });
  });

  it("refuses when the property's key count changed after the selection was read", async () => {
    const { ctx, calls } = fakeAe({ keyframesSelection: [sel([2], 3)], keysSnapshot: [snap([[0, 0], [1, 50], [2, 100], [3, 100]])] });
    const out = await tool("ae_remove_keyframes").handler(AeRemoveKeyframesSchema.parse({ ...base, keys: "selected" }), ctx);
    expect(out).toMatchObject({ ok: false, error: "bad_args" });
    expect(calls.some((c) => c.fn === "removeKeys")).toBe(false);
  });

  it("stops after the guard when nothing is selected, or too much", async () => {
    const none = fakeAe({ keyframesSelection: [sel([])] });
    expect(await tool("ae_remove_keyframes").handler(AeRemoveKeyframesSchema.parse({ ...base, keys: "selected" }), none.ctx)).toMatchObject({ ok: false, error: "no_match" });
    expect(none.calls.map((c) => c.fn)).toEqual(["checkGuard", "keyframesSelection"]);
    const many = fakeAe({ keyframesSelection: [{ ...sel([1]), truncated: true }] });
    expect(await tool("ae_remove_keyframes").handler(AeRemoveKeyframesSchema.parse({ ...base, keys: "selected" }), many.ctx)).toMatchObject({ ok: false, error: "bad_args" });
  });
});

describe("keyframes.jsx: keyframesSelection", () => {
  const load = () => {
    const project = new FakeProject();
    const comp = project.addComp("Main", 640, 360, 4);
    const layer = comp.layers.addSolid([1, 1, 1], "Ball", 100, 100, 1, 4);
    const p = layer.transform("Opacity");
    [0, 1, 2].forEach((t) => p.setValueAtTime(t, t * 10));
    const { A } = loadHost(project, ["keyframes.jsx"]);
    return { comp, layer, p, A };
  };
  const args = (comp: { id: number }) => ({ comp_id: comp.id, layer: { name: "Ball" }, path: ["ADBE Transform Group", "ADBE Opacity"] });

  it("reads Property.selectedKeys", () => {
    const { comp, p, A } = load();
    Object.defineProperty(p, "selectedKeys", { value: [3, 1], configurable: true });
    expect(JSON.parse(JSON.stringify(A.keyframesSelection(args(comp))))).toEqual({ numKeys: 3, selected_keys: [1, 3], times: [0, 2], source: "selectedKeys" });
  });

  it("falls back to keySelected per key, and reports an empty selection", () => {
    const { comp, p, A } = load();
    (p as any).keySelected = (i: number) => i === 2;
    const r = JSON.parse(JSON.stringify(A.keyframesSelection(args(comp))));
    expect(r).toMatchObject({ selected_keys: [2], times: [1], source: "keySelected" });
    (p as any).keySelected = () => false;
    expect(JSON.parse(JSON.stringify(A.keyframesSelection(args(comp)))).selected_keys).toEqual([]);
  });

  it("changes nothing and reports none when the AE has neither member", () => {
    const { comp, p, A } = load();
    const r = JSON.parse(JSON.stringify(A.keyframesSelection(args(comp))));
    expect(r).toMatchObject({ numKeys: 3, selected_keys: [], source: "none" });
    expect(p.numKeys).toBe(3);
  });
});

describe("ae_remove_keyframes: Time Remap in the dry run, and a kept value the host could not write", () => {
  const timeRemap = (keys: Array<[number, number]>) => ({ ...snap(keys), match_name: "ADBE Time Remapping" });

  it("the dry run refuses every Time Remap key as the write does, and still lists a partial removal", async () => {
    const { ctx, calls } = fakeAe({ keysSnapshot: [timeRemap([[0, 0], [1, 2]]), timeRemap([[0, 0], [1, 2]])] });
    const tr = { ...base, path: ["ADBE Time Remapping"] };
    const refused = await tool("ae_remove_keyframes").handler(AeRemoveKeyframesSchema.parse({ ...tr, all: true, dry_run: true }), ctx);
    expect(refused).toMatchObject({ ok: false, error: "bad_args" });
    expect(refused.message).toMatch(/switch time remapping off.*ae_time_remap with operation disable/);
    const partial = await tool("ae_remove_keyframes").handler(AeRemoveKeyframesSchema.parse({ ...tr, keys: [2], dry_run: true }), ctx);
    expect(partial).toMatchObject({ ok: true, dry_run: true, count: 1, all_keys: false });
    expect(calls.map((c) => c.fn)).toEqual(["keysSnapshot", "keysSnapshot"]);
  });

  it("the host snapshot reports the property's match name", () => {
    const project = new FakeProject();
    const comp = project.addComp("Main", 640, 360, 4);
    comp.layers.addSolid([1, 1, 1], "Ball", 100, 100, 1, 4).transform("Opacity").setValueAtTime(0, 5);
    const { A } = loadHost(project, ["keyframes.jsx", "audio.jsx"]);
    const r = JSON.parse(JSON.stringify(A.keysSnapshot({ comp_id: comp.id, layer: { name: "Ball" }, path: ["ADBE Transform Group", "ADBE Opacity"] })));
    expect(r.match_name).toBe("ADBE Opacity");
  });

  it("a kept value the host could not write is a receipt mismatch and is returned, not reported as clean", async () => {
    const hidden = "After Effects error: Can not set value with this property, because the property or a parent property is hidden.";
    const { ctx } = fakeAe({
      keysSnapshot: [snap([[0, 0], [1, 100]])],
      keysSnapshotStatic: [snap([[0, 0], [1, 100]]), snap([], 100)],
      removeKeys: [{ removed: [{ index: 1, time: 0, value: 0 }, { index: 2, time: 1, value: 100 }], numKeys: 0, static_value_error: hidden }],
    });
    const out = await tool("ae_remove_keyframes").handler(AeRemoveKeyframesSchema.parse({ ...base, all: true }), ctx);
    expect(out.static_value_error).toBe(hidden);
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches.map((x: { path: string }) => x.path)).toEqual(["static_value"]);
    expect(removeKeysMismatches(snap([[0, 0]]), snap([]), { removed: [{ time: 0 }], static_value_error: "boom" })[0].message).toContain("boom");
    expect(removeKeysMismatches(snap([[0, 0]]), snap([]), { removed: [{ time: 0 }] })).toEqual([]);
  });
});
