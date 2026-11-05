import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { zodToJsonSchema } from "../src/schema.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import {
  AeDetectCutsSchema,
  AeKeyframesTransformSchema,
  detectCutsMismatches,
  expectedEase,
  expectedTime,
  timelineTools,
  transformMismatches,
  valuesClose,
  writeTargetsOf,
  readTargetsOf,
  type TransformOperation,
  type TransformPlan,
} from "../src/tools/ext/timeline.js";
import {
  FakeProject,
  GUARD,
  KeyframeEase,
  KeyframeInterpolationType,
  PropertyValueType,
  loadHost,
  type FakeComp,
  type FakeLayer,
  type FakeProperty,
} from "./support/fake-ae.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const tool = (name: string) => timelineTools.find((t) => t.name === name)!;
const expectArg = { project_path: "<unsaved>" };
const fromJson = <T = any>(v: unknown): T => JSON.parse(JSON.stringify(v));

function mkCtx(evalScript: (script: string, label: string) => Promise<any>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-timeline-q-"));
  tmpDirs.push(dir);
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
  const host = new PanelHost({ evalScript, queue, quarantine });
  const ctx: ToolContext = { bridge: host, queue, quarantine };
  return ctx;
}

/** A PanelHost whose AE answers from a script of results, recording each call. */
function fakeAe(results: Record<string, unknown[]>) {
  const calls: Array<{ fn: string; script: string }> = [];
  const ctx = mkCtx(async (script) => {
    const fn = script.slice("__chromaAe.".length, script.indexOf("("));
    calls.push({ fn, script });
    if (fn === "checkGuard") return { ok: true, result: { ok: true, project_path: "<unsaved>", comp_id: 1, comp_is_valid: true }, durationMs: 1 };
    const next = results[fn]?.shift();
    if (next === undefined) throw new Error(`Unexpected script: ${script}`);
    return { ok: true, result: next, durationMs: 1 };
  });
  return { ctx, calls };
}

// ---------- the host under node:vm ----------

/** inPoint and outPoint follow startTime, as in AE (the fake keeps them apart). */
function linkTiming(l: FakeLayer) {
  let inOff = 0;
  let outOff = l.outPoint;
  Object.defineProperty(l, "inPoint", { get: () => l.startTime + inOff, set: (v: number) => (inOff = v - l.startTime), configurable: true });
  Object.defineProperty(l, "outPoint", { get: () => l.startTime + outOff, set: (v: number) => (outOff = v - l.startTime), configurable: true });
}

/** Per-key state the fake lacks: continuity, auto-bezier, tangents, label, selection, selectedKeys. */
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
  Object.defineProperty(x, "selectedKeys", {
    get: () => x.keys.map((k: any, i: number) => (k.selected ? i + 1 : 0)).filter((i: number) => i > 0),
    configurable: true,
  });
}

/** Property depths, so A.propertyPath stops at the layer. */
function depths(l: FakeLayer) {
  const g = l.group as any;
  Object.defineProperty(g, "propertyDepth", { value: 0, configurable: true });
  for (const sub of g.props) {
    Object.defineProperty(sub, "propertyDepth", { value: 1, configurable: true });
    for (const leaf of sub.props ?? []) Object.defineProperty(leaf, "propertyDepth", { value: 2, configurable: true });
  }
}

function scene(n = 2) {
  const project = new FakeProject();
  const comp = project.addComp("Main", 640, 360, 4);
  comp.frameRate = 25;
  for (let i = n; i >= 1; i--) comp.layers.addSolid([1, 1, 1], `L${i}`, 100, 100, 1, 4);
  for (const l of comp.stack) {
    linkTiming(l);
    depths(l);
  }
  const { A, undo, G } = loadHost(project, ["stagger.jsx", "layerops.jsx", "markers.jsx", "timeline.jsx"]);
  return { project, comp, A, undo, G };
}

const OPACITY = ["ADBE Transform Group", "ADBE Opacity"];
const POS = ["ADBE Transform Group", "ADBE Position"];
const prop = (l: FakeLayer, name: string) => l.transform(name);
const times = (p: FakeProperty) => p.keys.map((k) => Math.round(k.time * 1e6) / 1e6);
const values = (p: FakeProperty) => p.keys.map((k) => k.value);

/** Opacity keys at 1, 2, 3 s with distinct values, interpolation and eases, so a lost attribute shows. */
function keyOpacity(l: FakeLayer, ts = [1, 2, 3], vs = [0, 50, 100]) {
  const p = prop(l, "Opacity");
  enhance(p);
  ts.forEach((t, i) => p.setValueAtTime(t, vs[i]));
  const B = KeyframeInterpolationType.BEZIER;
  const L = KeyframeInterpolationType.LINEAR;
  p.setInterpolationTypeAtKey(1, L, B);
  p.setTemporalEaseAtKey(1, [new KeyframeEase(0, 20)], [new KeyframeEase(20, 40)]);
  p.setInterpolationTypeAtKey(2, B, B);
  p.setTemporalEaseAtKey(2, [new KeyframeEase(10, 30)], [new KeyframeEase(12, 55)]);
  p.setInterpolationTypeAtKey(3, B, L);
  p.setTemporalEaseAtKey(3, [new KeyframeEase(30, 60)], [new KeyframeEase(0, 10)]);
  (p as any).keys[1].label = 5;
  return p;
}

const target = (l: FakeLayer, p = OPACITY) => ({ layer: { id: l.id }, path: p });

describe("timeline schemas", () => {
  const base = { comp_id: 1, targets: [{ layer: { index: 1 }, path: OPACITY }], operation: { type: "shift", frames: 5 }, expect: expectArg };

  it("needs targets or keys: 'selected', exactly one", () => {
    expect(AeKeyframesTransformSchema.safeParse(base).success).toBe(true);
    expect(AeKeyframesTransformSchema.safeParse({ ...base, targets: undefined, keys: "selected" }).success).toBe(true);
    expect(AeKeyframesTransformSchema.safeParse({ ...base, keys: "selected" }).success).toBe(false);
    expect(AeKeyframesTransformSchema.safeParse({ ...base, targets: undefined }).success).toBe(false);
    expect(AeKeyframesTransformSchema.safeParse({ ...base, targets: undefined, keys: "all" }).success).toBe(false);
  });

  it("needs expect unless dry_run", () => {
    expect(AeKeyframesTransformSchema.safeParse({ ...base, expect: undefined }).success).toBe(false);
    expect(AeKeyframesTransformSchema.safeParse({ ...base, expect: undefined, dry_run: true }).success).toBe(true);
  });

  it("checks each operation's own fields", () => {
    const op = (o: object) => AeKeyframesTransformSchema.safeParse({ ...base, operation: o }).success;
    expect(op({ type: "shift" })).toBe(false);
    expect(op({ type: "shift", by: 1, frames: 2 })).toBe(false);
    expect(op({ type: "shift", by: -0.5 })).toBe(true);
    expect(op({ type: "scale", factor: 2 })).toBe(true);
    expect(op({ type: "scale", factor: 0 })).toBe(false);
    expect(op({ type: "scale", factor: 2, pivot: "time" })).toBe(false);
    expect(op({ type: "scale", factor: 2, pivot: "time", pivot_time: 1 })).toBe(true);
    expect(op({ type: "scale", factor: 2, pivot_time: 1 })).toBe(false);
    expect(op({ type: "reverse" })).toBe(true);
    expect(op({ type: "move_to", time: 3 })).toBe(true);
    expect(op({ type: "move_to" })).toBe(false);
    expect(op({ type: "copy_to", layer: { index: 2 }, path: OPACITY })).toBe(true);
    expect(op({ type: "copy_to", path: OPACITY })).toBe(false);
    expect(op({ type: "spin" })).toBe(false);
  });

  it("ae_detect_cuts needs expect for everything but list", () => {
    expect(AeDetectCutsSchema.safeParse({ comp_id: 1, layer: { index: 1 } }).success).toBe(true);
    expect(AeDetectCutsSchema.safeParse({ comp_id: 1, layer: { index: 1 }, mode: "split" }).success).toBe(false);
    expect(AeDetectCutsSchema.safeParse({ comp_id: 1, layer: { index: 1 }, mode: "split", expect: expectArg }).success).toBe(true);
    expect(AeDetectCutsSchema.safeParse({ comp_id: 1, layer: { index: 1 }, mode: "slice", expect: expectArg }).success).toBe(false);
  });

  it("descriptions of the writes end with the safety guidance", () => {
    for (const t of timelineTools) expect(t.description.endsWith("target guard failure (kind: 'guard') means STOP and re-read state—do NOT retry with stale expectations.")).toBe(true);
  });
});

describe("timeline pure logic", () => {
  const ctx = { snap: true, frame_duration: 0.04, span: { from: 1, to: 3 } };

  it("works out where a key lands", () => {
    expect(expectedTime({ type: "shift", by: 0.48 }, ctx, 1)).toBeCloseTo(1.48, 9);
    expect(expectedTime({ type: "shift", frames: 5 }, ctx, 1)).toBeCloseTo(1.2, 9);
    expect(expectedTime({ type: "move_to", time: 5 }, ctx, 2)).toBeCloseTo(6, 9);
    expect(expectedTime({ type: "scale", factor: 2 }, ctx, 3)).toBeCloseTo(5, 9);
    expect(expectedTime({ type: "scale", factor: 2, pivot: "time", pivot_time: 0 }, ctx, 3)).toBeCloseTo(6, 9);
    expect(expectedTime({ type: "scale", factor: 2, pivot: "playhead" }, { ...ctx, pivot: 2 }, 3)).toBeCloseTo(4, 9);
    expect(expectedTime({ type: "reverse" }, ctx, 1)).toBeCloseTo(3, 9);
    expect(expectedTime({ type: "copy_to", layer: { index: 1 }, path: OPACITY, at_time: 10 }, ctx, 2)).toBeCloseTo(11, 9);
  });

  it("snaps to frames unless told not to", () => {
    expect(expectedTime({ type: "shift", by: 0.013 }, ctx, 1)).toBeCloseTo(1, 9);
    expect(expectedTime({ type: "shift", by: 0.013 }, { ...ctx, snap: false }, 1)).toBeCloseTo(1.013, 9);
  });

  it("flips ease speed for a reverse (not on a spatial path) and divides it for a scale", () => {
    const side = [{ speed: 10, influence: 30 }];
    expect(expectedEase(side, { type: "reverse" }, false)).toEqual([{ speed: -10, influence: 30 }]);
    expect(expectedEase(side, { type: "reverse" }, true)).toEqual(side);
    expect(expectedEase([{ speed: 0, influence: 50 }], { type: "reverse" }, false)[0].speed).toBe(0);
    expect(expectedEase(side, { type: "scale", factor: 2 }, false)).toEqual([{ speed: 5, influence: 30 }]);
    expect(expectedEase(side, { type: "shift", by: 1 }, false)).toBe(side);
  });

  it("compares values loosely for numbers and strictly for the rest", () => {
    expect(valuesClose(100, 100.00001)).toBe(true);
    expect(valuesClose([1, 2, 3], [1, 2, 3.5])).toBe(false);
    expect(valuesClose({ text: "a" }, { text: "a" })).toBe(true);
    expect(valuesClose(null, 0)).toBe(false);
  });

  const key = (time: number, value: number, extra: object = {}) => ({
    time,
    value,
    inInterp: "bezier",
    outInterp: "bezier",
    easeIn: [{ speed: 0, influence: 33 }],
    easeOut: [{ speed: 0, influence: 33 }],
    ...extra,
  });
  const read = (keys: object[]) => ({ comp_id: 1, frameDuration: 0.04, properties: [{ layer_id: 10, path: OPACITY, follower: null, name: "Opacity", numKeys: keys.length, spatial: false, keys }] });
  const written = (moves: object[], extra: object = {}) => ({
    operation: "shift",
    snap: true,
    frame_duration: 0.04,
    span: { from: 1, to: 2 },
    changed: true,
    targets: [{ role: "edited", layer_id: 10, layer_name: "L", path: OPACITY, follower: null, property: "Opacity", num_keys: 2, indexes: [1, 2], moves }],
    ...extra,
  });
  const op: TransformOperation = { type: "shift", by: 1 };
  const moves = [
    { from_index: 1, new_index: 1, from: 1, to: 2 },
    { from_index: 2, new_index: 2, from: 2, to: 3 },
  ];

  it("passes a faithful move", () => {
    const before = read([key(1, 0), key(2, 100)]);
    const after = read([key(2, 0), key(3, 100)]);
    expect(transformMismatches(op, before, after, written(moves))).toEqual([]);
  });

  it("flags a wrong time, a lost value, a changed ease, and a wrong count", () => {
    const before = read([key(1, 0), key(2, 100)]);
    const m = transformMismatches(op, before, read([key(2.5, 0), key(3, 100)]), written(moves));
    expect(m.map((x) => x.path)).toEqual(["L.Opacity.keys[1].time"]);
    expect(transformMismatches(op, before, read([key(2, 0), key(3, 90)]), written(moves)).map((x) => x.path)).toEqual(["L.Opacity.keys[2].value"]);
    const eased = read([key(2, 0, { easeOut: [{ speed: 5, influence: 33 }] }), key(3, 100)]);
    expect(transformMismatches(op, before, eased, written(moves)).map((x) => x.path)).toEqual(["L.Opacity.keys[1].easeOut"]);
    expect(transformMismatches(op, before, read([key(2, 0)]), written(moves)).map((x) => x.path)).toEqual(["L.Opacity.numKeys"]);
  });

  it("does not hold a moved roving key to the snapped time: AE retimes it", () => {
    const before = read([key(0, 0), key(1.2345, 50, { roving: true }), key(3, 100)]);
    const mv = [
      { from_index: 1, new_index: 1, from: 0, to: 0.04 },
      { from_index: 2, new_index: 2, from: 1.2345, to: 1.28 },
      { from_index: 3, new_index: 3, from: 3, to: 3.04 },
    ];
    const w = written(mv, { targets: [{ role: "edited", layer_id: 10, layer_name: "L", path: OPACITY, follower: null, property: "Opacity", num_keys: 3, indexes: [1, 2, 3], moves: mv }] });
    const shift: TransformOperation = { type: "shift", frames: 1 };
    // AE put the roving key at 1.2745 itself.
    const after = read([key(0.04, 0), key(1.2745, 50, { roving: true }), key(3.04, 100)]);
    expect(transformMismatches(shift, before, after, w)).toEqual([]);
    // A key that is not roving is still held to its time.
    const plain = read([key(0, 0), key(1.2345, 50), key(3, 100)]);
    expect(transformMismatches(shift, plain, read([key(0.04, 0), key(1.2745, 50), key(3.04, 100)]), w).map((x) => x.path)).toEqual(["L.Opacity.keys[2].time"]);
  });

  it("flips ease speed on a reverse only where speed has a sign (not Color or Shape)", () => {
    const rev: TransformOperation = { type: "reverse" };
    const k1 = key(1, 0, { inInterp: "linear", outInterp: "bezier", easeIn: [{ speed: 0, influence: 10 }], easeOut: [{ speed: 20, influence: 40 }] });
    const k2 = key(2, 100, { inInterp: "bezier", outInterp: "linear", easeIn: [{ speed: 30, influence: 60 }], easeOut: [{ speed: 0, influence: 10 }] });
    const mv = [
      { from_index: 1, new_index: 2, from: 1, to: 2 },
      { from_index: 2, new_index: 1, from: 2, to: 1 },
    ];
    const w = written(mv, { span: { from: 1, to: 2 }, snap: false });
    const flipped = { ...k2, time: 1, value: 100, inInterp: "linear", outInterp: "bezier", easeIn: [{ speed: 0, influence: 10 }], easeOut: [{ speed: -30, influence: 60 }] };
    const kept = { ...flipped, easeOut: [{ speed: 30, influence: 60 }] };
    const last = { ...k1, time: 2, value: 0, inInterp: "bezier", outInterp: "linear", easeIn: [{ speed: -20, influence: 40 }], easeOut: [{ speed: 0, influence: 10 }] };
    const lastKept = { ...last, easeIn: [{ speed: 20, influence: 40 }] };
    const rd = (extra: object, keys: unknown[]) => ({ comp_id: 1, frameDuration: 0.04, properties: [{ layer_id: 10, path: OPACITY, follower: null, name: "Opacity", numKeys: 2, spatial: false, keys, ...extra }] });
    // A signed property flips; a Color-like one (signed_speed false) does not.
    expect(transformMismatches(rev, rd({}, [k1, k2]), rd({ signed_speed: true }, [flipped, last]), w)).toEqual([]);
    expect(transformMismatches(rev, rd({}, [k1, k2]), rd({ signed_speed: true }, [kept, lastKept]), w).length).toBeGreaterThan(0);
    expect(transformMismatches(rev, rd({ signed_speed: false }, [k1, k2]), rd({ signed_speed: false }, [kept, lastKept]), w)).toEqual([]);
    expect(transformMismatches(rev, rd({ signed_speed: false }, [k1, k2]), rd({ signed_speed: false }, [flipped, last]), w).length).toBeGreaterThan(0);
  });

  it("holds unmoved keys to their before eases", () => {
    const before = read([key(1, 0), key(2, 100), key(3, 50)]);
    const mv = [{ from_index: 1, new_index: 1, from: 1, to: 1.4 }];
    const w = written(mv, { targets: [{ role: "edited", layer_id: 10, layer_name: "L", path: OPACITY, follower: null, property: "Opacity", num_keys: 3, indexes: [1], moves: mv }] });
    const shift: TransformOperation = { type: "shift", by: 0.4 };
    expect(transformMismatches(shift, before, read([key(1.4, 0), key(2, 100), key(3, 50)]), w)).toEqual([]);
    const lost = read([key(1, 0), key(2, 100, { easeIn: [{ speed: 9, influence: 33 }] }), key(3, 50)]);
    expect(transformMismatches(shift, before, lost, w).map((x) => x.path)).toContain("L.Opacity.keys[2].easeIn");
  });

  it("flags a host that moved a key somewhere the operation does not", () => {
    const before = read([key(1, 0), key(2, 100)]);
    const bad = [{ from_index: 1, new_index: 1, from: 1, to: 2.4 }, moves[1]];
    const m = transformMismatches(op, before, read([key(2.4, 0), key(3, 100)]), written(bad));
    expect(m.some((x) => /the operation gives/.test(x.message))).toBe(true);
  });

  it("expects a reverse to swap the two sides of a key", () => {
    const rev: TransformOperation = { type: "reverse" };
    const k1 = key(1, 0, { inInterp: "linear", outInterp: "bezier", easeIn: [{ speed: 0, influence: 10 }], easeOut: [{ speed: 20, influence: 40 }] });
    const k2 = key(2, 100, { inInterp: "bezier", outInterp: "linear", easeIn: [{ speed: 30, influence: 60 }], easeOut: [{ speed: 0, influence: 10 }] });
    const before = read([k1, k2]);
    const swapped = [
      { from_index: 2, new_index: 1, from: 2, to: 1 },
      { from_index: 1, new_index: 2, from: 1, to: 2 },
    ];
    // The old last key comes first: its in side is the old out side, its out side the old in side, speeds negated.
    const first = key(1, 100, { inInterp: "linear", outInterp: "bezier", easeIn: [{ speed: 0, influence: 10 }], easeOut: [{ speed: -30, influence: 60 }] });
    const second = key(2, 0, { inInterp: "bezier", outInterp: "linear", easeIn: [{ speed: -20, influence: 40 }], easeOut: [{ speed: 0, influence: 10 }] });
    expect(transformMismatches(rev, before, read([first, second]), written(swapped, { operation: "reverse", reverse: true }))).toEqual([]);
    // Times swapped but sides left alone is wrong.
    const plain = read([key(1, 100, k2), key(2, 0, k1)]);
    expect(transformMismatches(rev, before, plain, written(swapped, { operation: "reverse" })).length).toBeGreaterThan(0);
  });

  it("builds read and write target lists from a plan", () => {
    const t = (role: string, indexes: number[]) => ({ role, layer_id: 10, layer_index: 1, layer_name: "L", path: OPACITY, follower: null, property: "Opacity", num_keys: 3, indexes, moves: [] });
    const plan = { targets: [t("edited", [1]), t("edited", []), t("source", [1, 2]), t("destination", [])] } as unknown as TransformPlan;
    expect(readTargetsOf(plan)).toHaveLength(3);
    expect(writeTargetsOf(plan).map((x) => x.indexes)).toEqual([[1], [1, 2]]);
  });

  it("detectCutsMismatches judges markers and layers from the reads", () => {
    const markers = (n: number) => ({ target: "layer", numMarkers: n, markers: [], truncated: false });
    expect(detectCutsMismatches("markers", markers(0), markers(3), { cuts_known: true, cut_count: 3 })).toEqual([]);
    expect(detectCutsMismatches("markers", markers(0), markers(0), { cuts_known: true, cut_count: 3 })).toHaveLength(1);
    const stack = (n: number) => ({ comp_id: 1, name: "M", numLayers: n, layers: [] });
    expect(detectCutsMismatches("split", stack(1), stack(4), { cuts_known: true, cut_count: 3 })).toEqual([]);
    expect(detectCutsMismatches("split", stack(1), stack(1), { cuts_known: true, cut_count: 3 })).toHaveLength(1);
    expect(detectCutsMismatches("split", stack(1), stack(1), { cuts_known: false })).toEqual([]);
  });
});

describe("timelineKeysTransform under node:vm", () => {
  const run = (A: any, comp: FakeComp, layer: FakeLayer, operation: object, extra: object = {}) =>
    fromJson(A.timelineKeysTransform({ comp_id: comp.id, targets: [{ layer: { id: layer.id }, path: OPACITY }], operation, expect: GUARD, ...extra }));

  it("shifts by frames, keeping value, interpolation, ease and label of every key", () => {
    const { comp, A, undo } = scene(1);
    const l = comp.layer(1)!;
    const p = keyOpacity(l);
    const out = run(A, comp, l, { type: "shift", frames: 5 });
    expect(times(p)).toEqual([1.2, 2.2, 3.2]);
    expect(values(p)).toEqual([0, 50, 100]);
    const k = (p as any).keys;
    expect([k[0].inI, k[0].outI]).toEqual([KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.BEZIER]);
    expect(k[0].outEase[0]).toMatchObject({ speed: 20, influence: 40 });
    expect(k[1].inEase[0]).toMatchObject({ speed: 10, influence: 30 });
    expect(k[1].outEase[0]).toMatchObject({ speed: 12, influence: 55 });
    expect(k[1].label).toBe(5);
    expect(undo.begun).toBe(1);
    expect(undo.ended).toBe(1);
    expect(out).toMatchObject({ operation: "shift", changed: true, keys_selected: 3 });
    expect(out.targets[0].moves).toHaveLength(3);
    expect(out.targets[0].moves[0]).toMatchObject({ from_index: 1, new_index: 1, from: 1 });
  });

  it("dry run plans without opening an undo group or checking the guard", () => {
    const { comp, A, undo } = scene(1);
    const l = comp.layer(1)!;
    const p = keyOpacity(l);
    const out = fromJson(A.timelineKeysTransform({ comp_id: comp.id, targets: [target(l)], operation: { type: "shift", by: 1 }, dry_run: true }));
    expect(out).toMatchObject({ dry_run: true, changed: true });
    expect(out.targets[0].moves.map((m: { to: number }) => m.to)).toEqual([2, 3, 4]);
    expect(times(p)).toEqual([1, 2, 3]);
    expect(undo.begun).toBe(0);
  });

  it("returns no_op for a zero shift and opens no undo group", () => {
    const { comp, A, undo } = scene(1);
    const l = comp.layer(1)!;
    keyOpacity(l);
    const out = run(A, comp, l, { type: "shift", by: 0 });
    expect(out.no_op).toBe(true);
    expect(undo.begun).toBe(0);
  });

  it("scales time around the first key and divides ease speed by the factor", () => {
    const { comp, A } = scene(1);
    const l = comp.layer(1)!;
    const p = keyOpacity(l);
    run(A, comp, l, { type: "scale", factor: 2 });
    expect(times(p)).toEqual([1, 3, 5]);
    const k = (p as any).keys;
    expect(k[1].inEase[0]).toMatchObject({ speed: 5, influence: 30 });
    expect(k[0].outEase[0]).toMatchObject({ speed: 10, influence: 40 });
    expect(values(p)).toEqual([0, 50, 100]);
  });

  it("scales around the playhead and around a given time", () => {
    const { comp, A } = scene(2);
    const [a, b] = [comp.layer(1)!, comp.layer(2)!];
    const pa = keyOpacity(a);
    const pb = keyOpacity(b);
    comp.time = 2;
    run(A, comp, a, { type: "scale", factor: 0.5, pivot: "playhead" }, { snap: false });
    expect(times(pa)).toEqual([1.5, 2, 2.5]);
    run(A, comp, b, { type: "scale", factor: 2, pivot: "time", pivot_time: 0 });
    expect(times(pb)).toEqual([2, 4, 6]);
  });

  it("reverses the span: values travel with the keys, in and out swap, speed flips sign", () => {
    const { comp, A } = scene(1);
    const l = comp.layer(1)!;
    const p = keyOpacity(l);
    const out = run(A, comp, l, { type: "reverse" });
    expect(times(p)).toEqual([1, 2, 3]);
    expect(values(p)).toEqual([100, 50, 0]);
    const k = (p as any).keys;
    // The old last key (in bezier speed 30/60, out linear) is now first: in linear, out bezier with the old in ease negated.
    expect([k[0].inI, k[0].outI]).toEqual([KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.BEZIER]);
    expect(k[0].outEase[0]).toMatchObject({ speed: -30, influence: 60 });
    expect(k[1].inEase[0]).toMatchObject({ speed: -12, influence: 55 });
    expect(k[1].outEase[0]).toMatchObject({ speed: -10, influence: 30 });
    expect(k[2].inEase[0]).toMatchObject({ speed: -20, influence: 40 });
    expect(out.targets[0].moves.map((m: { from_index: number; new_index: number }) => [m.from_index, m.new_index])).toEqual([[3, 1], [2, 2], [1, 3]]);
  });

  it("does not flip the sign of a Color property's speed, and reports signed_speed on the read", () => {
    const { comp, A } = scene(1);
    const l = comp.layer(1)!;
    const p = keyOpacity(l);
    (p as any).propertyValueType = PropertyValueType.COLOR;
    const read = fromJson(A.timelineKeysRead({ comp_id: comp.id, targets: [target(l)] }));
    expect(read.properties[0].signed_speed).toBe(false);
    run(A, comp, l, { type: "reverse" });
    const k = (p as any).keys;
    expect(k[0].outEase[0]).toMatchObject({ speed: 30, influence: 60 });
    expect(k[2].inEase[0]).toMatchObject({ speed: 20, influence: 40 });
  });

  it("reads signed_speed true for a plain numeric property and false for a spatial one", () => {
    const { comp, A } = scene(1);
    const l = comp.layer(1)!;
    keyOpacity(l);
    const pos = prop(l, "Position");
    enhance(pos);
    pos.setValueAtTime(1, [0, 0, 0]);
    pos.setValueAtTime(2, [1, 1, 0]);
    const read = fromJson(A.timelineKeysRead({ comp_id: comp.id, targets: [target(l), target(l, POS)] }));
    expect(read.properties.map((x: { signed_speed: boolean }) => x.signed_speed)).toEqual([true, false]);
  });

  it("does not flip the sign of a spatial path's speed", () => {
    const { comp, A } = scene(1);
    const l = comp.layer(1)!;
    const p = prop(l, "Position");
    enhance(p);
    p.setValueAtTime(1, [0, 0, 0]);
    p.setValueAtTime(2, [100, 0, 0]);
    p.setInterpolationTypeAtKey(1, KeyframeInterpolationType.BEZIER);
    p.setInterpolationTypeAtKey(2, KeyframeInterpolationType.BEZIER);
    p.setTemporalEaseAtKey(1, [new KeyframeEase(0, 10)], [new KeyframeEase(50, 70)]);
    p.setTemporalEaseAtKey(2, [new KeyframeEase(40, 20)], [new KeyframeEase(0, 10)]);
    (p as any).keys[0].outTan = [30, 0, 0];
    (p as any).keys[1].inTan = [-30, 0, 0];
    A.timelineKeysTransform({ comp_id: comp.id, targets: [target(l, POS)], operation: { type: "reverse" }, expect: GUARD });
    const k = (p as any).keys;
    expect(values(p)).toEqual([[100, 0, 0], [0, 0, 0]]);
    expect(k[0].outEase[0]).toMatchObject({ speed: 40, influence: 20 });
    expect(k[0].outTan).toEqual([-30, 0, 0]);
  });

  it("move_to puts the earliest key at the time; a filter leaves the others alone", () => {
    const { comp, A } = scene(1);
    const l = comp.layer(1)!;
    const p = keyOpacity(l);
    run(A, comp, l, { type: "move_to", time: 2.48 }, { filter: { indexes: [1] } });
    expect(times(p)).toEqual([2, 2.48, 3]);
    expect(values(p)).toEqual([50, 0, 100]);
    const k = (p as any).keys;
    // The moved key kept its own ease; the others kept theirs.
    expect(k[1].outEase[0]).toMatchObject({ speed: 20, influence: 40 });
    expect(k[0].outEase[0]).toMatchObject({ speed: 12, influence: 55 });
  });

  it("filters by time range", () => {
    const { comp, A } = scene(1);
    const l = comp.layer(1)!;
    const p = keyOpacity(l);
    run(A, comp, l, { type: "shift", by: 0.48 }, { filter: { from: 1.5 } });
    expect(times(p)).toEqual([1, 2.48, 3.48]);
  });

  it("refuses two keys on one frame before changing anything", () => {
    const { comp, A, undo } = scene(1);
    const l = comp.layer(1)!;
    const p = keyOpacity(l, [1, 1.04, 3]);
    expect(() => run(A, comp, l, { type: "scale", factor: 0.25 })).toThrow(/same frame/);
    expect(times(p)).toEqual([1, 1.04, 3]);
    expect(undo.begun).toBe(0);
    // Without snapping the keys stay apart.
    run(A, comp, l, { type: "scale", factor: 0.25 }, { snap: false });
    expect(times(p)).toEqual([1, 1.01, 1.5]);
  });

  it("refuses a locked layer, a missing guard match, no keys, a group and a bad target", () => {
    const { comp, A, undo } = scene(2);
    const [a, b] = [comp.layer(1)!, comp.layer(2)!];
    keyOpacity(a);
    a.locked = true;
    expect(() => run(A, comp, a, { type: "shift", by: 1 })).toThrow(/locked/);
    a.locked = false;
    expect(() => run(A, comp, b, { type: "shift", by: 1 })).toThrow(/no keys/);
    expect(() => run(A, comp, a, { type: "shift", by: 1 }, { expect: { project_path: "C:/other.aep" } })).toThrow(/Target guard refused/);
    expect(() => A.timelineKeysTransform({ comp_id: comp.id, targets: [{ layer: { id: a.id }, path: ["ADBE Transform Group"] }], operation: { type: "shift", by: 1 }, expect: GUARD })).toThrow(/group/);
    expect(() => run(A, comp, a, { type: "shift", by: 1 }, { filter: { indexes: [9] } })).toThrow(/out of range/);
    expect(() => run(A, comp, a, { type: "shift", by: 99999 })).toThrow(/outside AE's range/);
    expect(() => run(A, comp, a, { type: "scale", factor: -1 })).toThrow(/factor/);
    expect(() => run(A, comp, a, { type: "shift", by: 1 }, { filter: { from: 50 } })).toThrow(/No keys match/);
    expect(() => A.timelineKeysTransform({ comp_id: comp.id, targets: [target(a), target(a)], operation: { type: "shift", by: 1 }, expect: GUARD })).toThrow(/listed twice/);
    expect(undo.begun).toBe(0);
  });

  it("moves several properties together as one block", () => {
    const { comp, A } = scene(2);
    const [a, b] = [comp.layer(1)!, comp.layer(2)!];
    const pa = keyOpacity(a, [1, 2, 3]);
    const pb = keyOpacity(b, [2, 3, 4]);
    A.timelineKeysTransform({ comp_id: comp.id, targets: [target(a), target(b)], operation: { type: "move_to", time: 0 }, expect: GUARD });
    expect(times(pa)).toEqual([0, 1, 2]);
    expect(times(pb)).toEqual([1, 2, 3]);
    const flip = fromJson(A.timelineKeysTransform({ comp_id: comp.id, targets: [target(a), target(b)], operation: { type: "reverse" }, expect: GUARD, dry_run: true }));
    expect(flip.span).toEqual({ from: 0, to: 3 });
    expect(flip.targets[0].moves.map((m: { from_index: number }) => m.from_index)).toEqual([3, 2, 1]);
  });

  it("warns about key expressions, roving keys and keys outside the comp", () => {
    const { comp, A } = scene(1);
    const l = comp.layer(1)!;
    const p = keyOpacity(l);
    p.expressionEnabled = true;
    p.expression = "value + key(2).value";
    (p as any).keys[1].roving = true;
    const out = fromJson(A.timelineKeysTransform({ comp_id: comp.id, targets: [target(l)], operation: { type: "shift", by: 5 }, dry_run: true }));
    expect(out.warnings.some((w: string) => /key\(n\)/.test(w))).toBe(true);
    expect(out.warnings.some((w: string) => /outside the comp/.test(w))).toBe(true);
    const spatial = prop(l, "Position");
    enhance(spatial);
    spatial.setValueAtTime(1, [0, 0, 0]);
    spatial.setValueAtTime(2, [1, 1, 0]);
    spatial.setValueAtTime(3, [2, 2, 0]);
    (spatial as any).keys[1].roving = true;
    const out2 = fromJson(A.timelineKeysTransform({ comp_id: comp.id, targets: [target(l, POS)], operation: { type: "shift", by: 1 }, dry_run: true }));
    expect(out2.warnings.some((w: string) => /roving/.test(w))).toBe(true);
  });

  it("puts the original keys back when a write fails, and says when it can't", () => {
    const attempt = (refuseRestore: boolean) => {
      const { comp, A } = scene(2);
      const [a, b] = [comp.layer(1)!, comp.layer(2)!];
      const pa = keyOpacity(a);
      const pb = keyOpacity(b);
      const orig = (pb as any).setValueAtTime.bind(pb);
      let calls = 0;
      (pb as any).setValueAtTime = (t: number, v: unknown) => {
        calls++;
        if (calls === 2 || (refuseRestore && calls > 2)) throw new Error("AE said no");
        return orig(t, v);
      };
      let msg = "";
      try {
        A.timelineKeysTransform({ comp_id: comp.id, targets: [target(a), target(b)], operation: { type: "shift", by: 1 }, expect: GUARD });
      } catch (e) {
        msg = (e as Error).message;
      }
      return { msg, pa, pb };
    };
    const ok = attempt(false);
    expect(ok.msg).toMatch(/AE said no/);
    expect(ok.msg).not.toMatch(/ReferenceError|not defined/);
    expect(times(ok.pa)).toEqual([1, 2, 3]);
    expect(times(ok.pb)).toEqual([1, 2, 3]);
    expect(attempt(true).msg).toMatch(/rollback was incomplete/);
  });

  it("copies keys to another layer, relative to its value, at a time", () => {
    const { comp, A } = scene(2);
    const [src, dest] = [comp.layer(1)!, comp.layer(2)!];
    keyOpacity(src, [1, 2, 3], [10, 20, 30]);
    const dp = prop(dest, "Opacity");
    enhance(dp);
    const out = fromJson(
      A.timelineKeysTransform({
        comp_id: comp.id,
        targets: [target(src)],
        operation: { type: "copy_to", layer: { id: dest.id }, path: OPACITY, relative_value: true, at_time: 0 },
        expect: GUARD,
      })
    );
    expect(times(dp)).toEqual([0, 1, 2]);
    expect(values(dp)).toEqual([100, 110, 120]);
    expect((dp as any).keys[0].outEase[0]).toMatchObject({ speed: 20, influence: 40 });
    expect(out.delta).toBe(90);
    expect(out.targets.map((t: { role: string }) => t.role)).toEqual(["source", "destination"]);
    expect(times(prop(src, "Opacity"))).toEqual([1, 2, 3]);
  });

  it("copy_to relative_value on a keyless destination reads its value before the expression", () => {
    const { comp, A } = scene(2);
    const [src, dest] = [comp.layer(1)!, comp.layer(2)!];
    keyOpacity(src, [1, 2, 3], [10, 20, 30]);
    const dp = prop(dest, "Opacity");
    enhance(dp);
    const base = dp.value as number;
    // .value is the expression's output (a wiggle sample); valueAtTime(t, true) is the value before it.
    Object.defineProperty(dp, "value", { get: () => base + 37, configurable: true });
    const out = fromJson(
      A.timelineKeysTransform({
        comp_id: comp.id,
        targets: [target(src)],
        operation: { type: "copy_to", layer: { id: dest.id }, path: OPACITY, relative_value: true, at_time: 0 },
        dry_run: true,
      })
    );
    expect(out.delta).toBe(base - 10);
  });

  it("copy_to rollback on a keyless destination puts back the value before the expression", () => {
    const { comp, A } = scene(2);
    const [src, dest] = [comp.layer(1)!, comp.layer(2)!];
    keyOpacity(src, [1, 2, 3], [10, 20, 30]);
    const dp = prop(dest, "Opacity");
    enhance(dp);
    const base = dp.value as number;
    Object.defineProperty(dp, "value", { get: () => base + 37, configurable: true });
    const origSet = (dp as any).setValueAtTime.bind(dp);
    let calls = 0;
    (dp as any).setValueAtTime = (t: number, v: unknown) => {
      calls++;
      if (calls === 2) throw new Error("AE said no");
      return origSet(t, v);
    };
    const setValues: unknown[] = [];
    const origSetValue = (dp as any).setValue.bind(dp);
    (dp as any).setValue = (v: unknown) => {
      setValues.push(v);
      return origSetValue(v);
    };
    let msg = "";
    try {
      A.timelineKeysTransform({
        comp_id: comp.id,
        targets: [target(src)],
        operation: { type: "copy_to", layer: { id: dest.id }, path: OPACITY, relative_value: true, at_time: 0 },
        expect: GUARD,
      });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/AE said no/);
    expect(setValues).toEqual([base]);
    expect((dp as any).keys.length).toBe(0);
    expect((dp as any).staticValue).toBe(base);
  });

  it("copy_to keeps the destination's own keys and refuses a clash, a kind mismatch and the source itself", () => {
    const { comp, A } = scene(2);
    const [src, dest] = [comp.layer(1)!, comp.layer(2)!];
    keyOpacity(src, [1, 2, 3], [10, 20, 30]);
    const dp = prop(dest, "Opacity");
    enhance(dp);
    dp.setValueAtTime(0, 5);
    dp.setValueAtTime(2, 7);
    const copy = (extra: object) =>
      A.timelineKeysTransform({ comp_id: comp.id, targets: [target(src)], operation: { type: "copy_to", layer: { id: dest.id }, path: OPACITY, ...extra }, expect: GUARD });
    expect(() => copy({})).toThrow(/same frame/);
    copy({ at_time: 10 });
    expect(times(dp)).toEqual([0, 2, 10, 11, 12]);
    expect(values(dp)).toEqual([5, 7, 10, 20, 30]);
    expect(() => A.timelineKeysTransform({ comp_id: comp.id, targets: [target(src)], operation: { type: "copy_to", layer: { id: dest.id }, path: POS }, expect: GUARD })).toThrow(/different kind/);
    expect(() => A.timelineKeysTransform({ comp_id: comp.id, targets: [target(src)], operation: { type: "copy_to", layer: { id: src.id }, path: OPACITY }, expect: GUARD })).toThrow(/source property/);
  });

  it("moves a separated Position per dimension", () => {
    const { comp, A } = scene(1);
    const l = comp.layer(1)!;
    const pos = prop(l, "Position") as any;
    const g = l.group.property("ADBE Transform Group") as any;
    const mk = (n: string, mn: string) => {
      const q = new (pos.constructor as any)(n, mn, 6417, 0);
      q.parentProperty = g;
      g.props.push(q);
      enhance(q);
      return q as FakeProperty;
    };
    const x = mk("X Position", "ADBE Position_0");
    const y = mk("Y Position", "ADBE Position_1");
    x.setValueAtTime(1, 10);
    x.setValueAtTime(2, 20);
    y.setValueAtTime(1.04, 1);
    pos.dimensionsSeparated = true;
    pos.getSeparationFollower = (d: number) => [x, y][d] ?? null;
    const out = fromJson(A.timelineKeysTransform({ comp_id: comp.id, targets: [target(l, POS)], operation: { type: "shift", frames: 25 }, expect: GUARD }));
    expect(times(x)).toEqual([2, 3]);
    expect(times(y)).toEqual([2.04]);
    expect(out.targets.map((t: { follower: number }) => t.follower)).toEqual([0, 1]);
  });

  it("skips unkeyed followers of a separated Position, and refuses when none has keys", () => {
    const { comp, A } = scene(1);
    const l = comp.layer(1)!;
    const pos = prop(l, "Position") as any;
    const g = l.group.property("ADBE Transform Group") as any;
    const mk = (n: string, mn: string) => {
      const q = new (pos.constructor as any)(n, mn, 6417, 0);
      q.parentProperty = g;
      g.props.push(q);
      enhance(q);
      return q as FakeProperty;
    };
    const x = mk("X Position", "ADBE Position_0");
    const y = mk("Y Position", "ADBE Position_1");
    const z = mk("Z Position", "ADBE Position_2");
    x.setValueAtTime(1, 10);
    x.setValueAtTime(2, 20);
    pos.dimensionsSeparated = true;
    pos.getSeparationFollower = (d: number) => [x, y, z][d] ?? null;
    const out = fromJson(A.timelineKeysTransform({ comp_id: comp.id, targets: [target(l, POS)], operation: { type: "shift", frames: 25 }, expect: GUARD }));
    expect(times(x)).toEqual([2, 3]);
    expect(out.targets.map((t: { follower: number }) => t.follower)).toEqual([0]);
    // An explicit follower with no keys is still refused.
    expect(() => A.timelineKeysTransform({ comp_id: comp.id, targets: [{ ...target(l, POS), follower: 1 }], operation: { type: "shift", frames: 25 }, expect: GUARD })).toThrow(/has no keys/);
    // All followers unkeyed: refused.
    x.removeKey(2);
    x.removeKey(1);
    expect(() => A.timelineKeysTransform({ comp_id: comp.id, targets: [target(l, POS)], operation: { type: "shift", frames: 25 }, expect: GUARD })).toThrow(/has no keys/);
  });

  it("reads the keys selected in the timeline, as explicit properties and indexes", () => {
    const { comp, A } = scene(2);
    const [a, b] = [comp.layer(1)!, comp.layer(2)!];
    const pa = keyOpacity(a);
    (pa as any).keys[0].selected = true;
    (pa as any).keys[2].selected = true;
    (a as any).selectedProperties = [pa, a.group.property("ADBE Transform Group")];
    (b as any).selectedProperties = [];
    const sel = fromJson(A.timelineSelection({ comp_id: comp.id }));
    expect(sel.targets).toHaveLength(1);
    expect(sel.targets[0]).toMatchObject({ layer_id: a.id, path: OPACITY, num_keys: 3, indexes: [1, 3], times: [1, 3] });
    // The selected keys go back in the same selection afterwards.
    A.timelineKeysTransform({ comp_id: comp.id, targets: [{ layer: { id: a.id }, path: sel.targets[0].path, indexes: [1, 3], num_keys: 3 }], operation: { type: "shift", by: 0.48 }, expect: GUARD });
    expect(times(pa)).toEqual([1.48, 2, 3.48]);
    expect((pa as any).keys.map((k: any) => k.selected === true)).toEqual([true, false, true]);
    // Keys edited since the selection was read are refused.
    expect(() =>
      A.timelineKeysTransform({ comp_id: comp.id, targets: [{ layer: { id: a.id }, path: sel.targets[0].path, indexes: [1], num_keys: 5 }], operation: { type: "shift", by: 0.48 }, expect: GUARD })
    ).toThrow(/changed since the selection/);
  });

  it("reads keys back with every field, in the order asked", () => {
    const { comp, A } = scene(2);
    const [a, b] = [comp.layer(1)!, comp.layer(2)!];
    keyOpacity(a);
    keyOpacity(b);
    const r = fromJson(A.timelineKeysRead({ comp_id: comp.id, targets: [target(b), target(a)] }));
    expect(r.properties.map((p: { layer_id: number }) => p.layer_id)).toEqual([b.id, a.id]);
    expect(r.properties[0].keys[0]).toMatchObject({ time: 1, value: 0, inInterp: "linear", outInterp: "bezier", label: 0 });
    expect(r.properties[0].keys[1].easeOut).toEqual([{ speed: 12, influence: 55 }]);
  });

  it("refuses when stagger.jsx's helpers are not loaded", () => {
    const project = new FakeProject();
    const comp = project.addComp("Main", 640, 360, 4);
    const l = comp.layers.addSolid([1, 1, 1], "L1", 100, 100, 1, 4);
    keyOpacity(l);
    const { A } = loadHost(project, ["timeline.jsx"]);
    expect(() => A.timelineKeysTransform({ comp_id: comp.id, targets: [target(l)], operation: { type: "shift", by: 1 }, dry_run: true })).toThrow(/stagger\.jsx/);
  });
});

describe("ae_keyframes_transform against the host", () => {
  /** A bridge that runs each script in the vm host. */
  function liveCtx(G: Record<string, any>, calls: string[]) {
    return mkCtx(async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      calls.push(fn);
      try {
        const result = vm.runInContext(script, G);
        return { ok: true, result: result === undefined ? null : JSON.parse(JSON.stringify(result)), durationMs: 1 };
      } catch (e) {
        const err = e as Error & { __kind?: string };
        return { ok: false, error: { message: err.message, kind: err.__kind ?? "runtime" }, durationMs: 1 };
      }
    });
  }
  const handler = tool("ae_keyframes_transform").handler;

  it("shift: plans, guards, reads, writes, reads back, and the receipt matches", async () => {
    const { comp, G } = scene(1);
    const l = comp.layer(1)!;
    const p = keyOpacity(l);
    const calls: string[] = [];
    const ctx = liveCtx(G, calls);
    const args = AeKeyframesTransformSchema.parse({ comp_id: comp.id, targets: [{ layer: { id: l.id }, path: OPACITY }], operation: { type: "shift", frames: 10 }, expect: GUARD });
    const out: any = await handler(args, ctx);
    // Guard first, then the plan, then the guarded write (which checks again).
    expect(calls).toEqual(["checkGuard", "timelineKeysTransform", "checkGuard", "timelineKeysRead", "timelineKeysTransform", "timelineKeysRead"]);
    expect(out.applied).toBe(true);
    expect(out.receipt.matches).toBe(true);
    expect(out.receipt.mismatches ?? []).toEqual([]);
    expect(times(p)).toEqual([1.4, 2.4, 3.4]);
  });

  it("reverse, scale, move_to and copy_to all pass their own read-back", async () => {
    for (const operation of [{ type: "reverse" }, { type: "scale", factor: 1.5 }, { type: "move_to", time: 0.2 }, { type: "shift", frames: -3 }] as const) {
      const { comp, G } = scene(1);
      const l = comp.layer(1)!;
      keyOpacity(l);
      const ctx = liveCtx(G, []);
      const out: any = await handler(AeKeyframesTransformSchema.parse({ comp_id: comp.id, targets: [{ layer: { id: l.id }, path: OPACITY }], operation, expect: GUARD }), ctx);
      expect(out.receipt.mismatches ?? [], JSON.stringify(operation)).toEqual([]);
      expect(out.receipt.matches).toBe(true);
    }
    const { comp, G } = scene(2);
    const [src, dest] = [comp.layer(1)!, comp.layer(2)!];
    keyOpacity(src, [1, 2, 3], [10, 20, 30]);
    enhance(prop(dest, "Opacity"));
    const out: any = await handler(
      AeKeyframesTransformSchema.parse({
        comp_id: comp.id,
        targets: [{ layer: { id: src.id }, path: OPACITY }],
        operation: { type: "copy_to", layer: { id: dest.id }, path: OPACITY, relative_value: true, at_time: 0.5 },
        expect: GUARD,
      }),
      liveCtx(G, [])
    );
    expect(out.receipt.mismatches ?? []).toEqual([]);
    expect(values(prop(dest, "Opacity"))).toEqual([100, 110, 120]);
  });

  it("keys: 'selected' resolves the selection, and the dry run shows the explicit keys", async () => {
    const { comp, G } = scene(1);
    const l = comp.layer(1)!;
    const p = keyOpacity(l);
    (p as any).keys[1].selected = true;
    (l as any).selectedProperties = [p];
    const calls: string[] = [];
    const out: any = await handler(
      AeKeyframesTransformSchema.parse({ comp_id: comp.id, keys: "selected", operation: { type: "shift", by: 0.48 }, dry_run: true }),
      liveCtx(G, calls)
    );
    expect(calls).toEqual(["timelineSelection", "timelineKeysTransform"]);
    expect(out).toMatchObject({ ok: true, dry_run: true, selection: { properties: 1 } });
    expect(out.targets[0].indexes).toEqual([2]);
    expect(out.targets[0].moves[0]).toMatchObject({ from: 2, to: 2.48 });
    expect(times(p)).toEqual([1, 2, 3]);
    const real: any = await handler(AeKeyframesTransformSchema.parse({ comp_id: comp.id, keys: "selected", operation: { type: "shift", by: 0.48 }, expect: GUARD }), liveCtx(G, []));
    expect(real.receipt.matches).toBe(true);
    expect(times(p)).toEqual([1, 2.48, 3]);
  });

  it("a wrong project fails with the guard error before the selection or the plan is read", async () => {
    const { comp, G } = scene(1);
    const l = comp.layer(1)!;
    const p = keyOpacity(l);
    (p as any).keys[1].selected = true;
    (l as any).selectedProperties = [p];
    const wrong = { project_path: "C:/other.aep" };
    for (const body of [{ keys: "selected" }, { targets: [{ layer: { id: l.id }, path: OPACITY }] }]) {
      const calls: string[] = [];
      let err: any;
      let out: any;
      try {
        out = await handler(AeKeyframesTransformSchema.parse({ comp_id: comp.id, ...body, operation: { type: "shift", by: 0.48 }, expect: wrong }), liveCtx(G, calls));
      } catch (e) {
        err = e;
      }
      expect(calls).toEqual(["checkGuard"]);
      expect(JSON.stringify(err ?? out) + String(err)).toMatch(/guard/i);
      expect(JSON.stringify(err ?? out)).not.toMatch(/no_match|not_found|bad_args/);
    }
    expect(times(p)).toEqual([1, 2, 3]);
  });

  it("reports nothing selected without touching AE further", async () => {
    const { comp, G } = scene(1);
    (comp.layer(1) as any).selectedProperties = [];
    const calls: string[] = [];
    const out: any = await handler(AeKeyframesTransformSchema.parse({ comp_id: comp.id, keys: "selected", operation: { type: "reverse" }, expect: GUARD }), liveCtx(G, calls));
    expect(out).toMatchObject({ ok: false, error: "no_match" });
    expect(calls).toEqual(["checkGuard", "timelineSelection"]);
  });

  it("a no-op plan skips the write and the second guard", async () => {
    const { comp, G, undo } = scene(1);
    const l = comp.layer(1)!;
    keyOpacity(l);
    const calls: string[] = [];
    const out: any = await handler(AeKeyframesTransformSchema.parse({ comp_id: comp.id, targets: [{ layer: { id: l.id }, path: OPACITY }], operation: { type: "shift", by: 0 }, expect: GUARD }), liveCtx(G, calls));
    expect(out).toMatchObject({ ok: true, no_op: true });
    expect(calls).toEqual(["checkGuard", "timelineKeysTransform"]);
    expect(undo.begun).toBe(0);
  });

  it("flags a read-back that disagrees with the plan", async () => {
    const { ctx } = fakeAe({
      timelineKeysTransform: [
        {
          operation: "shift",
          snap: true,
          frame_duration: 0.04,
          span: { from: 1, to: 1 },
          keys_selected: 1,
          changed: true,
          warnings: [],
          targets: [{ role: "edited", layer_id: 10, layer_index: 1, layer_name: "L", path: OPACITY, follower: null, property: "Opacity", num_keys: 1, indexes: [1], moves: [{ from_index: 1, new_index: 1, from: 1, to: 2 }] }],
        },
        {
          operation: "shift",
          snap: true,
          frame_duration: 0.04,
          span: { from: 1, to: 1 },
          changed: true,
          warnings: [],
          targets: [{ role: "edited", layer_id: 10, layer_index: 1, layer_name: "L", path: OPACITY, follower: null, property: "Opacity", num_keys: 1, indexes: [1], moves: [{ from_index: 1, new_index: 1, from: 1, to: 2 }] }],
        },
      ],
      timelineKeysRead: [
        { properties: [{ layer_id: 10, path: OPACITY, follower: null, name: "Opacity", numKeys: 1, spatial: false, keys: [{ time: 1, value: 5 }] }] },
        { properties: [{ layer_id: 10, path: OPACITY, follower: null, name: "Opacity", numKeys: 1, spatial: false, keys: [{ time: 1, value: 5 }] }] },
      ],
    });
    const out: any = await tool("ae_keyframes_transform").handler(
      AeKeyframesTransformSchema.parse({ comp_id: 1, targets: [{ layer: { id: 10 }, path: OPACITY }], operation: { type: "shift", by: 1 }, expect: expectArg }),
      ctx
    );
    expect(out.applied).toBe(true);
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches.map((x: { path: string }) => x.path)).toEqual(["L.Opacity.keys[1].time"]);
  });
});

describe("timelineDetectCuts under node:vm", () => {
  function cutScene() {
    const { project, comp, A, undo, G } = scene(0);
    const clip = project.addFootage("clip.mov", 640, 360);
    (clip as any).duration = 12.5;
    const layer = comp.layers.add(clip, 4);
    linkTiming(layer);
    G.AVLayer = class {
      static [Symbol.hasInstance](o: any) {
        return !!o && o.reflect?.name === "AVLayer";
      }
    };
    G.SceneEditDetectionMode = { NONE: 1, MARKERS: 2, SPLIT: 3, SPLIT_PRECOMP: 4 };
    const modes: number[] = [];
    (layer as any).doSceneEditDetection = (m: number) => {
      modes.push(m);
      return [1.5, 3];
    };
    return { comp, layer, A, undo, modes, G };
  }

  it("lists the cuts with no undo group and states the clip duration", () => {
    const { comp, layer, A, undo, modes } = cutScene();
    const out = fromJson(A.timelineDetectCuts({ comp_id: comp.id, layer: { id: layer.id }, mode: "list" }));
    expect(out).toMatchObject({ mode: "list", cuts: [1.5, 3], cut_count: 2, cuts_known: true, clip_duration: 12.5, layer_name: "clip.mov" });
    expect(modes).toEqual([1]);
    expect(undo.begun).toBe(0);
  });

  it("runs the write modes inside one undo group, behind the guard", () => {
    const { comp, layer, A, undo, modes } = cutScene();
    const out = fromJson(A.timelineDetectCuts({ comp_id: comp.id, layer: { id: layer.id }, mode: "split_precomp", expect: GUARD }));
    expect(modes).toEqual([4]);
    expect(undo.begun).toBe(1);
    expect(undo.ended).toBe(1);
    expect(out).toMatchObject({ cut_count: 2, num_layers_before: 1 });
    expect(() => A.timelineDetectCuts({ comp_id: comp.id, layer: { id: layer.id }, mode: "markers", expect: { project_path: "C:/other.aep" } })).toThrow(/Target guard refused/);
    expect(() => A.timelineDetectCuts({ comp_id: comp.id, layer: { id: layer.id }, mode: "split" })).toThrow(/no expect/);
  });

  it("does not report no_op when no cut is found (the undo group was opened)", () => {
    const { comp, layer, A } = cutScene();
    (layer as any).doSceneEditDetection = () => [];
    expect(fromJson(A.timelineDetectCuts({ comp_id: comp.id, layer: { id: layer.id }, mode: "markers", expect: GUARD })).no_op).toBeUndefined();
  });

  it("refuses before anything runs: time remapping, no video, a solid, a locked layer, an old AE", () => {
    const { comp, layer, A, undo, modes, G } = cutScene();
    const args = { comp_id: comp.id, layer: { id: layer.id }, mode: "split", expect: GUARD };
    (layer as any).timeRemapEnabled = true;
    expect(() => A.timelineDetectCuts(args)).toThrow(/time remapping/);
    (layer as any).timeRemapEnabled = false;
    layer.hasVideo = false;
    expect(() => A.timelineDetectCuts(args)).toThrow(/no video/);
    layer.hasVideo = true;
    layer.locked = true;
    expect(() => A.timelineDetectCuts(args)).toThrow(/locked/);
    expect(fromJson(A.timelineDetectCuts({ ...args, mode: "list" })).cut_count).toBe(2);
    layer.locked = false;
    const solid = comp.layers.addSolid([1, 1, 1], "Solid", 10, 10, 1, 4);
    expect(() => A.timelineDetectCuts({ ...args, layer: { id: solid.id } })).toThrow(/solid/);
    const saved = (layer as any).doSceneEditDetection;
    (layer as any).doSceneEditDetection = undefined;
    expect(() => A.timelineDetectCuts(args)).toThrow(/22\.3/);
    (layer as any).doSceneEditDetection = saved;
    delete G.SceneEditDetectionMode;
    expect(() => A.timelineDetectCuts(args)).toThrow(/SceneEditDetectionMode/);
    expect(undo.begun).toBe(0);
    expect(modes).toEqual([1]);
  });

  it("refuses a bad mode", () => {
    const { comp, layer, A } = cutScene();
    expect(() => A.timelineDetectCuts({ comp_id: comp.id, layer: { id: layer.id }, mode: "slice" })).toThrow(/Unknown mode/);
  });
});

describe("ae_detect_cuts flow", () => {
  const handler = tool("ae_detect_cuts").handler;
  const cuts = (extra: object = {}) => ({
    mode: "markers",
    layer_id: 7,
    layer_index: 1,
    layer_name: "clip",
    source_name: "clip.mov",
    clip_duration: 30,
    layer_duration: 30,
    cuts: [1, 2],
    cut_count: 2,
    cuts_truncated: false,
    cuts_known: true,
    num_layers_before: 1,
    ...extra,
  });

  it("list is a read: no guard, no checkpoint, the clip duration in the note", async () => {
    const { ctx, calls } = fakeAe({ timelineDetectCuts: [cuts({ mode: "list" })] });
    const out: any = await handler(AeDetectCutsSchema.parse({ comp_id: 1, layer: { index: 1 } }), ctx);
    expect(calls.map((c) => c.fn)).toEqual(["timelineDetectCuts"]);
    expect(out).toMatchObject({ ok: true, cut_count: 2 });
    expect(out.note).toMatch(/30s long/);
    expect(out.note).toMatch(/never abort/);
  });

  it("markers: guard, marker count before, write, marker count after", async () => {
    const list = (n: number) => ({ target: "layer", numMarkers: n, markers: [], truncated: false });
    const { ctx, calls } = fakeAe({ listMarkers: [list(0), list(2)], timelineDetectCuts: [cuts()] });
    const out: any = await handler(AeDetectCutsSchema.parse({ comp_id: 1, layer: { name: "clip" }, mode: "markers", expect: expectArg }), ctx);
    expect(calls.map((c) => c.fn)).toEqual(["checkGuard", "listMarkers", "timelineDetectCuts", "listMarkers"]);
    expect(calls[3].script).toContain('"id":7');
    expect(out.receipt.matches).toBe(true);
    expect(out).toMatchObject({ markers_before: 0, markers_after: 2 });
  });

  it("split: reads the stack before and after and warns about layer(n) expressions that moved", async () => {
    const layer = (index: number, id: number, name: string) => ({ index, id, name, kind: "footage", enabled: true, parent: null });
    const before = {
      comp_id: 1,
      name: "M",
      numLayers: 2,
      layers: [layer(1, 10, "clip"), layer(2, 11, "Ctrl")],
      expressions: [{ layer_id: 11, layer_index: 2, layer_name: "Ctrl", path: "Transform > Position", text: "thisComp.layer(1).position", enabled: true }],
    };
    const after = { comp_id: 1, name: "M", numLayers: 4, layers: [layer(1, 12, "clip 3"), layer(2, 13, "clip 2"), layer(3, 10, "clip"), layer(4, 11, "Ctrl")] };
    const { ctx, calls } = fakeAe({ layeropsRead: [before, after], timelineDetectCuts: [cuts({ mode: "split" })] });
    const out: any = await handler(AeDetectCutsSchema.parse({ comp_id: 1, layer: { index: 1 }, mode: "split", expect: expectArg }), ctx);
    expect(calls.map((c) => c.fn)).toEqual(["checkGuard", "layeropsRead", "timelineDetectCuts", "layeropsRead"]);
    expect(calls[1].script).toContain('"scan_expressions":true');
    expect(out).toMatchObject({ layers_before: 2, layers_after: 4 });
    expect(out.receipt.matches).toBe(true);
    expect(out.expression_warnings.length).toBeGreaterThan(0);
  });

  it("flags a split that added no layer although cuts were found", async () => {
    const stack = { comp_id: 1, name: "M", numLayers: 1, layers: [{ index: 1, id: 10, name: "clip", kind: "footage", enabled: true, parent: null }] };
    const { ctx } = fakeAe({ layeropsRead: [stack, stack], timelineDetectCuts: [cuts({ mode: "split" })] });
    const out: any = await handler(AeDetectCutsSchema.parse({ comp_id: 1, layer: { index: 1 }, mode: "split", expect: expectArg }), ctx);
    expect(out.receipt.matches).toBe(false);
  });
});

void (null as unknown as FakeComp);

describe("timeline tools as registered", () => {
  it("export two tools whose schemas convert to JSON schema", () => {
    expect(timelineTools.map((t) => t.name)).toEqual(["ae_keyframes_transform", "ae_detect_cuts"]);
    for (const t of timelineTools) {
      const js = zodToJsonSchema(t.schema) as { properties?: Record<string, unknown> };
      expect(Object.keys(js.properties ?? {})).toContain("comp_id");
    }
  });

  it("advertises the operation's shape in tools/list", () => {
    const js = zodToJsonSchema(tool("ae_keyframes_transform").schema) as { properties: Record<string, { description?: string }> };
    const d = js.properties.operation.description ?? "";
    for (const w of ["shift", "frames", "scale", "factor", "pivot_time", "reverse", "move_to", "copy_to", "relative_value", "at_time"]) expect(d).toContain(w);
  });
});
