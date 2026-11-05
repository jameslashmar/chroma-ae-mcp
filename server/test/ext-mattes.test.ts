import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import {
  AeCafPrepSchema,
  AeGarbageMatteSchema,
  AeMaskFollowSchema,
  cafInstructions,
  decimateKeys,
  followMismatches,
  followShapes,
  checkWriteSize,
  garbageMismatches,
  MAX_WRITE_POINTS,
  mattesTools,
  snapKeyTimes,
  snapToFrame,
  toPatchRegion,
  regionToShape,
  shapeVector,
  spreadIndexes,
  type FollowExpect,
  type GarbageExpect,
} from "../src/tools/ext/mattes.js";
import { saveTrack } from "../src/tools/ext/planar.js";
import { identityH, translationH, type Mat3, type PlanarFrame, type PlanarTrack, type ShapeData } from "../src/tools/ext/planar-math.js";
import { FakeGroup, FakeProject, FakeProperty, GUARD, loadHost, PropertyValueType, Shape, TrackMatteType, type FakeComp, type FakeLayer } from "./support/fake-ae.js";

// The track store lives under the data dir: keep it out of the real one.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-mattes-"));
const saved = { LOCALAPPDATA: process.env.LOCALAPPDATA, HOME: process.env.HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME };
beforeAll(() => {
  process.env.LOCALAPPDATA = dataDir;
  process.env.HOME = dataDir;
  process.env.XDG_DATA_HOME = dataDir;
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const tool = (name: string) => mattesTools.find((t) => t.name === name)!;
const expectArg = { project_path: "<unsaved>" };

const W = 640;
const H = 360;

/** A translate track: +dx px per frame at 10 fps, the reference frame at t = 0. */
function mkTrack(id: string, frames = 7, dx = 10): PlanarTrack {
  const fr: PlanarFrame[] = Array.from({ length: frames }, (_, i) => ({
    time: i / 10,
    ok: true,
    H: translationH(dx * i, 0),
    points: [[100 + dx * i, 100]],
    confidence: [1],
    rms_px: 0,
    inliers: 1,
  }));
  return { version: 1, track_id: id, comp_id: 1, comp_size: [W, H], fps: 10, ref_time: 0, model: "translate", ref_points: [[100, 100]], frames: fr, source: "test", created: "now" };
}

const square: ShapeData = {
  vertices: [[100, 100], [200, 100], [200, 200], [100, 200]],
  inTangents: [[0, 0], [0, 0], [0, 0], [0, 0]],
  outTangents: [[0, 0], [0, 0], [0, 0], [0, 0]],
  closed: true,
};

// ---------- schemas ----------

describe("mattes schemas", () => {
  const track = { track_id: "trk_x" };
  it("ae_mask_follow takes exactly one of mask and new_mask", () => {
    const base = { comp_id: 1, layer: { index: 1 }, track, expect: expectArg };
    expect(AeMaskFollowSchema.safeParse(base).success).toBe(false);
    expect(AeMaskFollowSchema.safeParse({ ...base, mask: { index: 1 }, new_mask: { region: { rect: [0, 0, 10, 10] } } }).success).toBe(false);
    expect(AeMaskFollowSchema.safeParse({ ...base, mask: { index: 1 } }).success).toBe(true);
    expect(AeMaskFollowSchema.safeParse({ ...base, new_mask: { region: { ellipse: [50, 50, 20, 10] } } }).success).toBe(true);
    expect(AeMaskFollowSchema.safeParse({ ...base, mask: { index: 1, name: "a" } }).success).toBe(false);
  });

  it("ae_mask_follow defaults decimate_px to 0.25 and bounds the numbers", () => {
    const ok = AeMaskFollowSchema.parse({ comp_id: 1, layer: { index: 1 }, track, mask: { name: "Hole" }, expect: expectArg });
    expect(ok.decimate_px).toBe(0.25);
    const bad = { comp_id: 1, layer: { index: 1 }, track, mask: { index: 1 }, expect: expectArg };
    expect(AeMaskFollowSchema.safeParse({ ...bad, feather: -1 }).success).toBe(false);
    expect(AeMaskFollowSchema.safeParse({ ...bad, feather: [1, 2, 3] }).success).toBe(false);
    expect(AeMaskFollowSchema.safeParse({ ...bad, feather: [4, 8] }).success).toBe(true);
    expect(AeMaskFollowSchema.safeParse({ ...bad, mask_opacity: 101 }).success).toBe(false);
    expect(AeMaskFollowSchema.safeParse({ ...bad, range: { start: 2, end: 1 } }).success).toBe(false);
    expect(AeMaskFollowSchema.safeParse({ ...bad, mode: "multiply" }).success).toBe(false);
    expect(AeMaskFollowSchema.safeParse({ ...bad, expect: undefined }).success).toBe(false);
  });

  it("ae_garbage_matte takes a region or a matte layer, and track options only with a region", () => {
    const base = { comp_id: 1, targets: [{ index: 2 }], expect: expectArg };
    expect(AeGarbageMatteSchema.safeParse(base).success).toBe(false);
    expect(AeGarbageMatteSchema.safeParse({ ...base, region: { rect: [0, 0, 50, 50] }, matte_layer: { index: 1 } }).success).toBe(false);
    const ok = AeGarbageMatteSchema.parse({ ...base, region: { polygon: [[0, 0], [10, 0], [10, 10]] } });
    expect(ok.matte_type).toBe("alpha");
    expect(AeGarbageMatteSchema.safeParse({ ...base, matte_layer: { index: 1 }, feather: 4 }).success).toBe(false);
    expect(AeGarbageMatteSchema.safeParse({ ...base, matte_layer: { index: 1 }, matte_type: "luma_inverted" }).success).toBe(true);
    expect(AeGarbageMatteSchema.safeParse({ ...base, region: { rect: [0, 0, 5, 5] }, ref_time: 1 }).success).toBe(false);
    expect(AeGarbageMatteSchema.safeParse({ ...base, region: { rect: [0, 0, 5, 5] }, track, ref_time: 1 }).success).toBe(true);
    expect(AeGarbageMatteSchema.safeParse({ ...base, region: { rect: [0, 0, 5, 5] }, choke: 200 }).success).toBe(false);
    expect(AeGarbageMatteSchema.safeParse({ ...base, targets: [], region: { rect: [0, 0, 5, 5] } }).success).toBe(false);
  });

  it("ae_caf_prep needs expect and a mask unless find_fill", () => {
    expect(AeCafPrepSchema.safeParse({ comp_id: 1, layer: { index: 1 }, find_fill: true }).success).toBe(true);
    expect(AeCafPrepSchema.safeParse({ comp_id: 1, layer: { index: 1 }, new_mask: { region: { rect: [0, 0, 5, 5] } } }).success).toBe(false);
    expect(AeCafPrepSchema.safeParse({ comp_id: 1, layer: { index: 1 }, expect: expectArg }).success).toBe(false);
    const ok = AeCafPrepSchema.parse({ comp_id: 1, layer: { index: 1 }, new_mask: { region: { rect: [0, 0, 5, 5] } }, expect: expectArg });
    expect(ok.mask_mode).toBe("subtract");
    expect(ok.set_work_area).toBe(true);
    expect(AeCafPrepSchema.safeParse({ comp_id: 1, layer: { index: 1 }, mask: { index: 1 }, new_mask: { region: { rect: [0, 0, 5, 5] } }, expect: expectArg }).success).toBe(false);
    expect(AeCafPrepSchema.safeParse({ comp_id: 1, layer: { index: 1 }, mask: { index: 1 }, mask_mode: "add", expect: expectArg }).success).toBe(false);
    expect(AeCafPrepSchema.safeParse({ comp_id: 1, layer: { index: 1 }, mask: { index: 1 }, work_area: { start: 2, end: 1 }, expect: expectArg }).success).toBe(false);
  });

  it("the tools name themselves, mutate through expect, and end with the safety guidance", () => {
    expect(mattesTools.map((t) => t.name)).toEqual(["ae_mask_follow", "ae_garbage_matte", "ae_caf_prep"]);
    for (const t of mattesTools) expect(t.description).toContain("IMPORTANT");
  });
});

// ---------- pure logic ----------

describe("regionToShape", () => {
  it("makes a rect, an ellipse with curved tangents, and a polygon", () => {
    const r = regionToShape({ rect: [10, 20, 100, 50] });
    expect(r.vertices).toEqual([[10, 20], [110, 20], [110, 70], [10, 70]]);
    const e = regionToShape({ ellipse: [100, 100, 40, 20] });
    expect(e.vertices).toEqual([[100, 80], [140, 100], [100, 120], [60, 100]]);
    expect(e.outTangents[0][0]).toBeCloseTo(40 * 0.5522847498, 6);
    expect(e.inTangents[1][1]).toBeCloseTo(-20 * 0.5522847498, 6);
    const p = regionToShape({ polygon: [[0, 0], [10, 0], [5, 8]] });
    expect(p.vertices).toHaveLength(3);
    expect(p.inTangents.every((t) => t[0] === 0 && t[1] === 0)).toBe(true);
  });

  it("refuses an empty rect, a flat ellipse and collinear polygon points", () => {
    expect(() => regionToShape({ rect: [0, 0, 0, 10] })).toThrow(/positive width and height/);
    expect(() => regionToShape({ ellipse: [0, 0, 5, -1] })).toThrow(/positive radii/);
    expect(() => regionToShape({ polygon: [[0, 0], [5, 5], [10, 10]] })).toThrow(/no area/);
    expect(() => regionToShape({ rect: [0, 0, Number.NaN, 10] })).toThrow();
  });
});

describe("decimateKeys", () => {
  it("keeps only the ends of a straight line, and the corner of a bent one", () => {
    const times = [0, 1, 2, 3, 4, 5, 6];
    const line = times.map((t) => [t * 10, 5]);
    expect(decimateKeys(times, line, 0.25)).toEqual([0, 6]);
    const bent = times.map((t) => [t <= 3 ? t * 10 : 30 + (t - 3) * 30, 5]);
    expect(decimateKeys(times, bent, 0.25)).toEqual([0, 3, 6]);
  });

  it("keeps everything at tolerance 0 and for one or two keys, and honours uneven times", () => {
    expect(decimateKeys([0, 1, 2], [[0], [5], [1]], 0)).toEqual([0, 1, 2]);
    expect(decimateKeys([0, 1], [[0], [5]], 1)).toEqual([0, 1]);
    // Linear in time even with a gap: t = 0, 1, 4 on y = 2t is a straight line.
    expect(decimateKeys([0, 1, 4], [[0], [2], [8]], 0.01)).toEqual([0, 2]);
    // The middle key sits 3 off the line.
    expect(decimateKeys([0, 1, 4], [[0], [5], [8]], 0.01)).toEqual([0, 1, 2]);
  });

  it("keeps a key when any single coordinate strays", () => {
    const times = [0, 1, 2];
    expect(decimateKeys(times, [[0, 0, 0], [1, 1, 1.5], [2, 2, 2]], 0.25)).toEqual([0, 1, 2]);
    expect(decimateKeys(times, [[0, 0, 0], [1, 1, 1.1], [2, 2, 2]], 0.25)).toEqual([0, 2]);
  });
});

describe("spreadIndexes", () => {
  it("spreads up to the count with the ends included", () => {
    expect(spreadIndexes(0, 5)).toEqual([]);
    expect(spreadIndexes(3, 5)).toEqual([0, 1, 2]);
    expect(spreadIndexes(100, 5)).toEqual([0, 25, 50, 74, 99].map((v, i) => (i === 3 ? 74 : v)));
    expect(spreadIndexes(2, 1)).toEqual([0]);
    expect(spreadIndexes(2, 5)).toEqual([0, 1]);
  });
});

describe("followShapes", () => {
  const frame = (time: number, H: Mat3 | null): PlanarFrame => ({ time, ok: H !== null, H, points: [], confidence: [], rms_px: 0, inliers: 1 });

  it("moves a shape by the track when the layer is the comp", () => {
    const frames = [frame(0, identityH()), frame(0.1, translationH(10, 5)), frame(0.2, translationH(20, 10))];
    const out = followShapes({ shape: square, frames, refM: identityH(), frameMs: frames.map(() => identityH()) });
    expect(out.skipped).toEqual([]);
    expect(out.maxErrorPx).toBe(0);
    expect(out.frames[2].shape.vertices[0]).toEqual([120, 110]);
    expect(out.frames[2].scale).toBeCloseTo(1, 9);
    expect(shapeVector(out.frames[1].shape)).toHaveLength(24);
  });

  it("works in the layer's own space: a layer that moves and scales on its own is compensated", () => {
    // The layer sits at (300, 0) at the reference frame and scales to 200 % about its origin later.
    const M0 = [1, 0, 300, 0, 1, 0, 0, 0, 1];
    const Mt = [2, 0, 300, 0, 2, 0, 0, 0, 1];
    // Layer-space shape; the track moves it +10 px in comp space.
    const local: ShapeData = { ...square, vertices: [[0, 0], [10, 0], [10, 10], [0, 10]] };
    const out = followShapes({ shape: local, frames: [frame(0.1, translationH(10, 0))], refM: M0, frameMs: [Mt] });
    // Comp point of vertex 0 at the reference: 300; +10 = 310; back through the scaled layer: (310 - 300) / 2 = 5.
    expect(out.frames[0].shape.vertices[0]).toEqual([5, 0]);
    expect(out.frames[0].shape.vertices[1]).toEqual([5 + 5, 0]);
  });

  it("scales tangents with a zoom and reports the zoom factor", () => {
    const zoom: Mat3 = [2, 0, 0, 0, 2, 0, 0, 0, 1];
    const round = regionToShape({ ellipse: [100, 100, 40, 20] });
    const out = followShapes({ shape: round, frames: [frame(0.1, zoom)], refM: identityH(), frameMs: [identityH()] });
    expect(out.frames[0].scale).toBeCloseTo(2, 9);
    expect(out.frames[0].shape.outTangents[0][0]).toBeCloseTo(round.outTangents[0][0] * 2, 9);
    expect(out.maxErrorPx).toBe(0);
  });

  it("reports a perspective error and skips frames it cannot map", () => {
    const persp: Mat3 = [1, 0, 0, 0, 1, 0, 0.002, 0, 1];
    const round = regionToShape({ ellipse: [100, 100, 40, 20] });
    const behind: Mat3 = [1, 0, 0, 0, 1, 0, -1, 0, 0.1];
    const out = followShapes({
      shape: round,
      frames: [frame(0.1, persp), frame(0.2, null), frame(0.3, behind)],
      refM: identityH(),
      frameMs: [identityH(), identityH(), identityH()],
    });
    expect(out.frames.map((f) => f.time)).toEqual([0.1]);
    expect(out.skipped).toEqual([0.2, 0.3]);
    expect(out.maxErrorPx).toBeGreaterThan(0);
    // A singular layer matrix skips the frame too.
    const sing = followShapes({ shape: square, frames: [frame(0.1, identityH())], refM: identityH(), frameMs: [[0, 0, 0, 0, 0, 0, 0, 0, 1]] });
    expect(sing.skipped).toEqual([0.1]);
  });
});

describe("followMismatches", () => {
  const read = (mask: any, wa = { work_area_start: 0, work_area_duration: 3 }): any => ({ comp: { ...wa }, mask });
  const exp: FollowExpect = {
    keys: 2,
    vertexCount: 4,
    sampleTimes: [0, 0.6],
    sampleVertices: [square.vertices, square.vertices.map((p) => [p[0] + 60, p[1]] as [number, number])],
    mode: "subtract",
    expansion: 4,
    feather: [2, 2],
    frameDuration: 0.1,
  };
  const good = {
    mode: "subtract",
    inverted: false,
    expansion: 4,
    feather: [2, 2],
    shape_keys: 2,
    feather_keys: 0,
    vertices: 4,
    samples: [
      { time: 0, vertices: square.vertices, feather_points: 0 },
      { time: 0.6, vertices: square.vertices.map((p) => [p[0] + 60.01, p[1]]), feather_points: 0 },
    ],
  };

  it("passes a faithful read-back", () => {
    expect(followMismatches(exp, read(good))).toEqual([]);
    expect(followMismatches(exp, null)).toEqual([]);
  });

  it("names each thing that differs", () => {
    const paths = (m: any[]) => m.map((x) => x.path);
    expect(paths(followMismatches(exp, read(null)))).toEqual(["mask"]);
    expect(paths(followMismatches(exp, read({ ...good, shape_keys: 1 })))).toEqual(["mask.shape_keys"]);
    expect(paths(followMismatches(exp, read({ ...good, mode: "add", expansion: 0, feather: [0, 0] })))).toEqual(["mask.mode", "mask.expansion", "mask.feather"]);
    const moved = { ...good, samples: [good.samples[0], { time: 0.6, vertices: square.vertices, feather_points: 0 }] };
    expect(paths(followMismatches(exp, read(moved)))).toEqual(["mask.path@0.6"]);
    expect(paths(followMismatches(exp, read(good, { work_area_start: 0, work_area_duration: 3 })))).toEqual([]);
  });

  it("checks the work area within a frame, and that a scaled feather was keyed", () => {
    const e = { ...exp, workArea: { start: 0.5, duration: 1 }, featherKeyed: true, feather: undefined };
    const m = followMismatches(e, read(good, { work_area_start: 0.5, work_area_duration: 1.05 }));
    expect(m.map((x) => x.path)).toEqual(["mask.feather_keys"]);
    const off = followMismatches({ ...e, featherKeyed: false }, read(good, { work_area_start: 0, work_area_duration: 3 }));
    expect(off.map((x) => x.path)).toEqual(["comp.work_area_start", "comp.work_area_duration"]);
  });

  it("does not judge the path when it was not written", () => {
    expect(followMismatches({ ...exp, keys: null, sampleTimes: [], sampleVertices: [] }, read({ ...good, shape_keys: 9 }))).toEqual([]);
  });
});

describe("garbageMismatches", () => {
  const exp = { matteType: "alpha", hide: true, created: true, keys: 0, vertexCount: 4, sampleTimes: [], sampleVertices: [], name: "BG MATTE" };
  const written = { matte: { index: 1, id: 50, name: "BG MATTE" }, targets: [{ index: 2, id: 10, name: "BG" }], top_target_index_before: 1 };
  const before: any = { comp: { num_layers: 1 }, layers: [] };
  const after = (over: any = {}): any => ({
    comp: { num_layers: 2 },
    layers: [{ found: true, id: 10, matte_type: "alpha", matte_layer: { id: 50, index: 1, name: "BG MATTE" } }],
    matte: { found: true, id: 50, index: 1, name: "BG MATTE", enabled: false, is_solid: true, mask: { mode: "add", shape_keys: 0, vertices: 4, feather: [0, 0], expansion: 0 } },
    ...over,
  });

  it("passes the expected result", () => {
    expect(garbageMismatches(exp, before, after(), written)).toEqual([]);
  });

  it("flags a wrong matte type, a matte left visible, a wrong place and a missing mask", () => {
    const wrongType = after({ layers: [{ found: true, id: 10, matte_type: "luma", matte_layer: { id: 51 } }] });
    expect(garbageMismatches(exp, before, wrongType, written).map((m) => m.path)).toEqual(["targets[10].matte_type", "targets[10].matte_layer"]);
    const shown = after();
    shown.matte.enabled = true;
    shown.matte.index = 3;
    expect(garbageMismatches(exp, before, shown, written).map((m) => m.path)).toEqual(["matte.enabled", "matte.index"]);
    const noMask = after();
    noMask.matte.mask = null;
    expect(garbageMismatches(exp, before, noMask, written).map((m) => m.path)).toEqual(["matte.mask"]);
    expect(garbageMismatches(exp, before, after({ comp: { num_layers: 1 } }), written).map((m) => m.path)).toEqual(["comp.num_layers"]);
    expect(garbageMismatches(exp, before, after({ matte: null }), written).map((m) => m.path)).toEqual(["matte"]);
  });

  it("checks an applied choke and, for an existing matte layer, only the wiring", () => {
    const withChoke = after();
    withChoke.matte.choke = 3;
    expect(garbageMismatches(exp, before, withChoke, { ...written, choke: { applied: true, value: 5 } }).map((m) => m.path)).toEqual(["matte.choke"]);
    expect(garbageMismatches(exp, before, after(), { ...written, choke: { applied: false, value: 5, error: "x" } })).toEqual([]);
    const existing = { ...exp, created: false };
    const noMask = after();
    noMask.matte.mask = null;
    expect(garbageMismatches(existing, before, noMask, written)).toEqual([]);
  });
});

describe("cafInstructions", () => {
  it("lists the panel steps in order and names the plate, the range and the next call", () => {
    const steps = cafInstructions({ plateName: "Plate", workArea: { start: 1, end: 3.5 }, maskMode: "subtract", compId: 7 });
    expect(steps).toHaveLength(8);
    expect(steps[0]).toContain('"Plate"');
    expect(steps[1]).toContain("allow_toggle: true");
    expect(steps[2]).toMatch(/Object.*Surface.*Edge Blend/);
    expect(steps[3]).toContain("Strong");
    expect(steps[4]).toContain("1 s to 3.5 s");
    expect(steps[6]).toContain("Generate Fill Layer");
    expect(steps[6]).toContain("hole");
    expect(steps[7]).toContain("find_fill: true (comp_id 7)");
    expect(cafInstructions({ plateName: "P", workArea: null, maskMode: "none", compId: 1 })[6]).toContain("mode none");
  });
});

// ---------- the guarded flows with a fake bridge ----------

interface Call {
  fn: string;
  args: any;
}

interface AeOpts {
  /** Overrides for the mask the plate layer holds. */
  mask?: Record<string, unknown>;
  noMask?: boolean;
  layer?: Record<string, unknown>;
  comp?: Record<string, unknown>;
  pinEffects?: string[];
  matteLayers?: any[];
  fill?: any;
  /** Make mattesFollowApply / mattesGarbageApply return this instead of the echo. */
  writeResult?: Record<string, unknown>;
  /** Make the after-read differ from what was written. */
  breakAfter?: boolean;
  failAfter?: boolean;
  /** Variable-feather points the after-read reports on every sample. */
  afterFeatherPoints?: number;
  /** Move every sampled vertex by this many px in the after-read. */
  shiftAfter?: number;
  /** The layer's own transform at every sample (default: identity). */
  layerSample?: Record<string, unknown>;
  /** Path keys the mask keeps from before (a ranged write). */
  keptKeys?: number;
}

function fakeAe(opts: AeOpts = {}) {
  const calls: Call[] = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-mattes-q-"));
  tmpDirs.push(dir);
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
  const layer = { index: 1, id: 10, name: "Plate", locked: false, enabled: true, three_d: false, ...opts.layer };
  const comp = { id: 1, name: "Main", width: W, height: H, pixel_aspect: 1, fps: 10, duration: 3, work_area_start: 0, work_area_duration: 3, num_layers: 2, ...opts.comp };
  let lastWrite: any = null;
  let lastGarbage: any = null;
  const host = new PanelHost({
    evalScript: async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      const args = JSON.parse(script.slice(script.indexOf("(") + 1, script.lastIndexOf(")")));
      calls.push({ fn, args });
      const ok = (result: unknown) => ({ ok: true, result, durationMs: 1 });
      if (fn === "checkGuard") return ok({ ok: true, project_path: "<unsaved>", comp_id: 1, comp_is_valid: true });
      if (fn === "planarLayerSpace") {
        return ok({
          layer,
          width: W,
          height: H,
          samples: args.times.map((t: number) => ({ time: t, anchor: [0, 0], position: [0, 0], scale: [100, 100], rotation: 0, parent_chain: [], three_d: false, ...opts.layerSample })),
        });
      }
      if (fn === "mattesMaskRead") {
        const isAfter = lastWrite !== null;
        const base: any = { comp: { ...comp }, layer, can_hold_masks: !opts.noMask, mask_count: 1, pin_effects: opts.pinEffects ?? [], mask: null };
        if (opts.failAfter && isAfter) throw new Error("read-back died");
        if (!args.mask) return ok(base);
        if (!isAfter) {
          base.mask = {
            index: args.mask.index ?? 1,
            name: "Hole",
            mode: "add",
            inverted: false,
            motion_blur: null,
            roto_bezier: false,
            locked: false,
            feather: [0, 0],
            expansion: 0,
            opacity: 100,
            shape_keys: 0,
            shape_expression: false,
            feather_keys: 0,
            expansion_keys: 0,
            opacity_keys: 0,
            ...(args.with_shape ? { shape: { ...square, feather_points: 0, feather_radii: [] } } : { vertices: 4 }),
            ...opts.mask,
          };
          return ok(base);
        }
        const w = lastWrite;
        const times: number[] = args.times ?? [];
        base.comp = { ...comp, work_area_start: w.work_area?.start ?? comp.work_area_start, work_area_duration: w.work_area?.duration ?? comp.work_area_duration };
        base.mask = {
          index: args.mask.index,
          name: "Hole",
          mode: w.mode ?? "add",
          inverted: w.inverted ?? false,
          feather: w.feather ?? [0, 0],
          expansion: w.expansion ?? 0,
          shape_keys: w.times?.length ? w.times.length + (opts.keptKeys ?? 0) + (opts.breakAfter ? 1 : 0) : 0,
          feather_keys: w.feather_scales ? w.times.length : 0,
          vertices: (w.shapes?.[0] ?? w.static_shape ?? square).vertices.length,
          samples: times.map((t) => {
            const i = w.times.findIndex((x: number) => Math.abs(x - t) < 1e-6);
            const verts = w.shapes ? w.shapes[i].vertices : w.static_shape.vertices;
            const sh = opts.shiftAfter ?? 0;
            return { time: t, vertices: verts.map((p: number[]) => [p[0] + sh, p[1]]), feather_points: opts.afterFeatherPoints ?? 0 };
          }),
        };
        return ok(base);
      }
      if (fn === "mattesFollowApply") {
        lastWrite = args;
        return ok({
          layer: { index: layer.index, id: layer.id, name: layer.name },
          created: !args.mask,
          replaced_keys: 0,
          kept_keys: opts.keptKeys ?? 0,
          keys: args.times.length || (args.static_shape ? 0 : undefined),
          mask: { index: args.mask?.index ?? 2, name: args.name ?? "Hole" },
          vertices: (args.shapes?.[0] ?? args.static_shape ?? square).vertices.length,
          mode: args.mode ?? "add",
          ...(args.work_area ? { work_area: args.work_area } : {}),
          ...opts.writeResult,
        });
      }
      if (fn === "mattesGarbageRead") {
        const layers = (args.layer_ids ?? []).map((id: number) => ({ found: true, id, index: id === 10 ? 2 : 3, name: id === 10 ? "BG" : "FG", enabled: true, locked: false, matte_type: lastGarbage ? lastGarbage.matte_type : "none", matte_layer: lastGarbage ? { index: 1, id: 50, name: "BG MATTE" } : null }));
        for (const sel of args.layers ?? []) {
          const l = (opts.matteLayers ?? [{ index: 2, id: 10, name: "BG" }]).find((x: any) => x.index === sel.index || x.id === sel.id);
          layers.push(l ? { found: true, enabled: true, locked: false, matte_type: "none", matte_layer: null, ...l } : { found: false, selector: sel, message: "No layer with that index" });
        }
        const out: any = { comp: { ...comp, num_layers: lastGarbage ? 3 : 2 }, layers, matte: null };
        if (lastGarbage && args.matte_id !== undefined) {
          const g = lastGarbage;
          out.matte = {
            found: true,
            id: 50,
            index: 2,
            name: g.name ?? "BG MATTE",
            enabled: opts.breakAfter === true,
            is_solid: true,
            choke: g.choke ?? null,
            mask: {
              mode: "add",
              shape_keys: g.times.length,
              vertices: (g.shapes?.[0] ?? g.static_shape).vertices.length,
              feather: g.feather ?? [0, 0],
              expansion: g.expansion ?? 0,
              samples: (args.times ?? []).map((t: number) => ({
                time: t,
                vertices: g.shapes ? g.shapes[g.times.findIndex((x: number) => Math.abs(x - t) < 1e-6)].vertices : g.static_shape.vertices.map((p: number[]) => [p[0] + (opts.shiftAfter ?? 0), p[1]]),
                feather_points: 0,
              })),
            },
          };
        } else if (args.matte) out.matte = { found: true, id: 99, index: 1, name: "Roto", enabled: true, locked: false, matte_type: "none", matte_layer: null };
        return ok(out);
      }
      if (fn === "mattesGarbageApply") {
        lastGarbage = args;
        const created = !args.matte_layer;
        return ok({
          created,
          api: "setTrackMatte",
          targets: args.targets.map((t: any) => ({ index: t.id === 10 ? 3 : 4, id: t.id, name: t.id === 10 ? "BG" : "FG" })),
          keys: args.times.length,
          mask: created ? { index: 1 } : undefined,
          matte: { index: 2, id: created ? 50 : 99, name: created ? args.name ?? "BG MATTE" : "Roto" },
          hidden: args.hide_matte !== false,
          top_target_index_before: 2,
          ...(args.choke ? { choke: { applied: false, value: args.choke, error: "no Simple Choker" } } : {}),
          ...opts.writeResult,
        });
      }
      if (fn === "mattesFindFill") return ok(opts.fill ?? { comp: { ...comp }, plate: layer, fill_folders: [], candidates: [], scanned: 2, truncated: false });
      throw new Error(`Unexpected script: ${script}`);
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge: host, queue, quarantine };
  return { ctx, calls };
}

describe("ae_mask_follow flow", () => {
  it("plans against the track, guards, writes the keys and reads back in a separate call", async () => {
    saveTrack(mkTrack("trk_follow_1"));
    const { ctx, calls } = fakeAe();
    const args = AeMaskFollowSchema.parse({
      comp_id: 1,
      layer: { index: 1 },
      mask: { index: 1 },
      track: { track_id: "trk_follow_1" },
      decimate_px: 0,
      mode: "subtract",
      expansion: 4,
      expect: expectArg,
    });
    const out = await tool("ae_mask_follow").handler(args, ctx);
    expect(calls.map((c) => c.fn)).toEqual(["mattesMaskRead", "planarLayerSpace", "checkGuard", "mattesMaskRead", "mattesFollowApply", "mattesMaskRead"]);
    const write = calls.find((c) => c.fn === "mattesFollowApply")!.args;
    expect(write.times).toHaveLength(7);
    expect(write.mask).toEqual({ index: 1 });
    expect(write.layer).toEqual({ index: 1, id: 10 });
    expect(write.shapes[6].vertices[0]).toEqual([160, 100]);
    expect(write.expect).toMatchObject(expectArg);
    expect(write.mode).toBe("subtract");
    expect(write.expansion).toBe(4);
    // The after read asks for sampled paths; the before read does not.
    expect(calls[3].args.times).toBeUndefined();
    expect(calls[5].args.times).toHaveLength(5);
    expect(out.ok).toBe(true);
    expect(out.applied).toBe(true);
    expect(out.receipt.matches).toBe(true);
    expect(out.frames).toMatchObject({ solved: 7, keyed: 7, dropped_by_decimation: 0 });
    expect(out.track_id).toBe("trk_follow_1");
  });

  it("drops keys a straight line reproduces and says so", async () => {
    saveTrack(mkTrack("trk_follow_2"));
    const { ctx, calls } = fakeAe();
    const args = AeMaskFollowSchema.parse({ comp_id: 1, layer: { index: 1 }, mask: { index: 1 }, track: { track_id: "trk_follow_2" }, expect: expectArg });
    const out = await tool("ae_mask_follow").handler(args, ctx);
    const write = calls.find((c) => c.fn === "mattesFollowApply")!.args;
    expect(write.times).toEqual([0, 0.6]);
    expect(out.frames).toMatchObject({ solved: 7, keyed: 2, dropped_by_decimation: 5 });
    expect(out.notes.join(" ")).toContain("5 of 7 keys were dropped");
    expect(out.receipt.matches).toBe(true);
  });

  it("brings a new comp-space region into the layer's space and creates the mask", async () => {
    saveTrack(mkTrack("trk_follow_3"));
    const { ctx, calls } = fakeAe();
    const args = AeMaskFollowSchema.parse({
      comp_id: 1,
      layer: { index: 1 },
      new_mask: { region: { rect: [100, 100, 100, 100] }, name: "Garbage" },
      track: { track_id: "trk_follow_3" },
      range: { start: 0.2, end: 0.4 },
      decimate_px: 0,
      expect: expectArg,
    });
    const out = await tool("ae_mask_follow").handler(args, ctx);
    const write = calls.find((c) => c.fn === "mattesFollowApply")!.args;
    expect(write.mask).toBeNull();
    expect(write.name).toBe("Garbage");
    expect(write.times).toEqual([0.2, 0.3, 0.4]);
    expect(write.shapes[0].vertices[0]).toEqual([120, 100]);
    expect(calls.find((c) => c.fn === "mattesMaskRead")!.args.mask).toBeNull();
    // The reference time and the three frames are read in one planarLayerSpace call.
    expect(calls.find((c) => c.fn === "planarLayerSpace")!.args.times).toEqual([0, 0.2, 0.3, 0.4]);
    expect(out.mask).toMatchObject({ index: 2 });
    expect(out.created).toBe(true);
    expect(out.receipt.matches).toBe(true);
  });

  it("refuses before touching AE: a locked layer, existing keys, a 3D layer, a layer without masks, a wrong-size comp", async () => {
    saveTrack(mkTrack("trk_follow_4"));
    const args = AeMaskFollowSchema.parse({ comp_id: 1, layer: { index: 1 }, mask: { index: 1 }, track: { track_id: "trk_follow_4" }, expect: expectArg });
    const cases: Array<[AeOpts, RegExp]> = [
      [{ layer: { locked: true } }, /locked/],
      [{ layer: { three_d: true } }, /3D/],
      [{ noMask: true }, /can't hold masks/],
      [{ mask: { shape_keys: 3 } }, /already has 3 keys/],
      [{ mask: { shape_expression: true } }, /expression/],
      [{ mask: { locked: true } }, /locked/],
      [{ comp: { width: 1920 } }, /sizes must match/],
      [{ comp: { pixel_aspect: 1.5 } }, /pixel aspect/],
    ];
    for (const [opts, re] of cases) {
      const { ctx, calls } = fakeAe(opts);
      const out = await tool("ae_mask_follow").handler(args, ctx);
      expect(out.ok).toBe(false);
      expect(out.message).toMatch(re);
      expect(calls.some((c) => c.fn === "mattesFollowApply" || c.fn === "checkGuard")).toBe(false);
    }
    // replace_keys lets existing keys through.
    const { ctx } = fakeAe({ mask: { shape_keys: 3 } });
    const replaced = await tool("ae_mask_follow").handler({ ...args, replace_keys: true }, ctx);
    expect(replaced.ok).toBe(true);
  });

  it("refuses a missing track and a track whose reference frame is not solved", async () => {
    const { ctx } = fakeAe();
    const missing = await tool("ae_mask_follow").handler(AeMaskFollowSchema.parse({ comp_id: 1, layer: { index: 1 }, mask: { index: 1 }, track: { track_id: "nope" }, expect: expectArg }), ctx);
    expect(missing).toMatchObject({ ok: false, error: "not_found" });
    const t = mkTrack("trk_follow_5");
    t.frames[0] = { ...t.frames[0], ok: false, H: null };
    saveTrack(t);
    const unsolved = await tool("ae_mask_follow").handler(AeMaskFollowSchema.parse({ comp_id: 1, layer: { index: 1 }, mask: { index: 1 }, track: { track_id: "trk_follow_5" }, expect: expectArg }), ctx);
    expect(unsolved).toMatchObject({ ok: false, error: "bad_args" });
    expect(unsolved.message).toContain("reference frame");
    const empty = await tool("ae_mask_follow").handler(
      AeMaskFollowSchema.parse({ comp_id: 1, layer: { index: 1 }, mask: { index: 1 }, track: { track_id: "trk_follow_4" }, range: { start: 50, end: 60 }, expect: expectArg }),
      fakeAe().ctx
    );
    expect(empty).toMatchObject({ ok: false, error: "bad_args" });
    expect(empty.message).toContain("No frame of the track is ok");
  });

  it("refuses more frames than one call keys, and says to use ranges", async () => {
    saveTrack(mkTrack("trk_follow_long", 3001, 0.1));
    const { ctx, calls } = fakeAe();
    const out = await tool("ae_mask_follow").handler(AeMaskFollowSchema.parse({ comp_id: 1, layer: { index: 1 }, mask: { index: 1 }, track: { track_id: "trk_follow_long" }, expect: expectArg }), ctx);
    expect(out).toMatchObject({ ok: false, error: "bad_args" });
    expect(out.message).toContain("range");
    expect(calls.some((c) => c.fn === "mattesFollowApply")).toBe(false);
  });

  it("warns about a pin effect, a perspective bend and skipped frames", async () => {
    const t = mkTrack("trk_follow_6", 5);
    t.model = "perspective";
    t.frames[2] = { ...t.frames[2], H: [1, 0, 0, 0, 1, 0, 0.002, 0, 1] };
    t.frames[3] = { ...t.frames[3], ok: false, H: null };
    saveTrack(t);
    const { ctx } = fakeAe({ pinEffects: ["Corner Pin"] });
    const out = await tool("ae_mask_follow").handler(
      AeMaskFollowSchema.parse({ comp_id: 1, layer: { index: 1 }, new_mask: { region: { ellipse: [300, 150, 120, 60] } }, track: { track_id: "trk_follow_6" }, decimate_px: 0, expect: expectArg }),
      ctx
    );
    expect(out.ok).toBe(true);
    const notes = out.notes.join("\n");
    expect(notes).toContain("already follows the pin");
    expect(notes).toContain("bends the mask's curves");
    expect(notes).toContain("1 frame(s) were not keyed");
    expect(out.max_bezier_error_px).toBeGreaterThan(0.5);
    expect(out.frames_not_keyed).toEqual([0.3]);
  });

  it("scale_feather keys the feather from the base and passes per-key scales", async () => {
    const t = mkTrack("trk_follow_7", 3);
    t.frames[1] = { ...t.frames[1], H: [2, 0, 0, 0, 2, 0, 0, 0, 1] };
    t.frames[2] = { ...t.frames[2], H: [3, 0, 0, 0, 3, 0, 0, 0, 1] };
    saveTrack(t);
    const { ctx, calls } = fakeAe({ mask: { feather: [10, 20] } });
    const out = await tool("ae_mask_follow").handler(
      AeMaskFollowSchema.parse({ comp_id: 1, layer: { index: 1 }, mask: { index: 1 }, track: { track_id: "trk_follow_7" }, decimate_px: 0, scale_feather: true, expect: expectArg }),
      ctx
    );
    const write = calls.find((c) => c.fn === "mattesFollowApply")!.args;
    expect(write.feather_scales).toEqual([1, 2, 3]);
    expect(write.base_feather).toEqual([10, 20]);
    expect(write.feather).toBeUndefined();
    expect(out.feather_scaled).toBe(true);
    expect(out.receipt.matches).toBe(true);
    // Nothing to scale on a mask with no feather and no radii.
    const plain = fakeAe();
    const none = await tool("ae_mask_follow").handler(
      AeMaskFollowSchema.parse({ comp_id: 1, layer: { index: 1 }, mask: { index: 1 }, track: { track_id: "trk_follow_7" }, scale_feather: true, expect: expectArg }),
      plain.ctx
    );
    expect(plain.calls.find((c) => c.fn === "mattesFollowApply")!.args.feather_scales).toBeUndefined();
    expect(none.notes.join(" ")).toContain("nothing to scale");
  });

  it("puts a wrong read-back in the receipt and never throws once the write has returned", async () => {
    saveTrack(mkTrack("trk_follow_8"));
    const a = () => AeMaskFollowSchema.parse({ comp_id: 1, layer: { index: 1 }, mask: { index: 1 }, track: { track_id: "trk_follow_8" }, decimate_px: 0, expect: expectArg });
    const wrong = await tool("ae_mask_follow").handler(a(), fakeAe({ breakAfter: true }).ctx);
    expect(wrong.ok).toBe(true);
    expect(wrong.receipt.matches).toBe(false);
    expect(wrong.receipt.mismatches.map((m: any) => m.path)).toContain("mask.shape_keys");
    const dead = await tool("ae_mask_follow").handler(a(), fakeAe({ failAfter: true }).ctx);
    expect(dead.applied).toBe(true);
    expect(dead.receipt.matches).toBe(false);
  });
});

describe("ae_garbage_matte flow", () => {
  it("makes a static matte for a target: read, guard, write, separate read-back", async () => {
    const { ctx, calls } = fakeAe();
    const out = await tool("ae_garbage_matte").handler(
      AeGarbageMatteSchema.parse({ comp_id: 1, targets: [{ index: 2 }], region: { rect: [50, 50, 200, 100] }, feather: 6, expect: expectArg }),
      ctx
    );
    expect(calls.map((c) => c.fn)).toEqual(["mattesGarbageRead", "checkGuard", "mattesGarbageRead", "mattesGarbageApply", "mattesGarbageRead"]);
    const w = calls.find((c) => c.fn === "mattesGarbageApply")!.args;
    expect(w.targets).toEqual([{ id: 10 }]);
    expect(w.matte_type).toBe("alpha");
    expect(w.static_shape.vertices).toEqual([[50, 50], [250, 50], [250, 150], [50, 150]]);
    expect(w.times).toEqual([]);
    expect(w.feather).toEqual([6, 6]);
    expect(w.expect).toMatchObject(expectArg);
    expect(calls[4].args.matte_id).toBe(50);
    expect(out.ok).toBe(true);
    expect(out.receipt.matches).toBe(true);
    expect(out.matte).toMatchObject({ id: 50, name: "BG MATTE" });
    expect(out.notes.join(" ")).toContain("solid item was added");
  });

  it("follows a track: keyed region, decimated, identity layer space", async () => {
    saveTrack(mkTrack("trk_gm_1"));
    const { ctx, calls } = fakeAe();
    const out = await tool("ae_garbage_matte").handler(
      AeGarbageMatteSchema.parse({
        comp_id: 1,
        targets: [{ index: 2 }],
        region: { polygon: [[100, 100], [200, 100], [150, 200]] },
        track: { track_id: "trk_gm_1" },
        matte_type: "alpha_inverted",
        name: "Holdout",
        decimate_px: 0,
        expect: expectArg,
      }),
      ctx
    );
    // No planarLayerSpace call: the matte solid's layer space is comp space.
    expect(calls.some((c) => c.fn === "planarLayerSpace")).toBe(false);
    const w = calls.find((c) => c.fn === "mattesGarbageApply")!.args;
    expect(w.times).toHaveLength(7);
    expect(w.shapes[6].vertices[2]).toEqual([210, 200]);
    expect(w.name).toBe("Holdout");
    expect(out.track_id).toBe("trk_gm_1");
    expect(out.frames).toMatchObject({ solved: 7, keyed: 7 });
    expect(out.notes.join(" ")).toContain("holdout");
  });

  it("wires several targets and an existing matte layer without making a solid", async () => {
    const { ctx, calls } = fakeAe({ matteLayers: [{ index: 2, id: 10, name: "BG" }, { index: 3, id: 11, name: "FG" }] });
    const out = await tool("ae_garbage_matte").handler(
      AeGarbageMatteSchema.parse({ comp_id: 1, targets: [{ index: 2 }, { index: 3 }], matte_layer: { name: "Roto" }, matte_type: "alpha", expect: expectArg }),
      ctx
    );
    const w = calls.find((c) => c.fn === "mattesGarbageApply")!.args;
    expect(w.matte_layer).toEqual({ name: "Roto" });
    expect(w.targets).toEqual([{ id: 10 }, { id: 11 }]);
    expect(w.static_shape).toBeUndefined();
    expect(out.created).toBe(false);
  });

  it("refuses a target that is not there and reports a choker that could not be added", async () => {
    const missing = await tool("ae_garbage_matte").handler(
      AeGarbageMatteSchema.parse({ comp_id: 1, targets: [{ index: 9 }], region: { rect: [0, 0, 10, 10] }, expect: expectArg }),
      fakeAe().ctx
    );
    expect(missing).toMatchObject({ ok: false, error: "not_found" });
    const { ctx } = fakeAe();
    const out = await tool("ae_garbage_matte").handler(
      AeGarbageMatteSchema.parse({ comp_id: 1, targets: [{ index: 2 }], region: { rect: [0, 0, 10, 10] }, choke: 5, expect: expectArg }),
      ctx
    );
    expect(out.ok).toBe(true);
    expect(out.notes.join(" ")).toContain("Simple Choker was not applied: no Simple Choker");
    const flat = await tool("ae_garbage_matte").handler(
      AeGarbageMatteSchema.parse({ comp_id: 1, targets: [{ index: 2 }], region: { rect: [0, 0, 0, 10] }, expect: expectArg }),
      fakeAe().ctx
    );
    expect(flat).toMatchObject({ ok: false, error: "bad_args" });
  });

  it("reports a matte left visible in the receipt", async () => {
    const { ctx } = fakeAe({ breakAfter: true });
    const out = await tool("ae_garbage_matte").handler(
      AeGarbageMatteSchema.parse({ comp_id: 1, targets: [{ index: 2 }], region: { rect: [0, 0, 10, 10] }, expect: expectArg }),
      ctx
    );
    expect(out.applied).toBe(true);
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches.map((m: any) => m.path)).toContain("matte.enabled");
  });
});

describe("ae_caf_prep flow", () => {
  it("sets a tracked Subtract mask and the work area, and returns the panel steps", async () => {
    saveTrack(mkTrack("trk_caf_1"));
    const { ctx, calls } = fakeAe();
    const out = await tool("ae_caf_prep").handler(
      AeCafPrepSchema.parse({
        comp_id: 1,
        layer: { index: 1 },
        new_mask: { region: { ellipse: [150, 150, 40, 30] } },
        track: { track_id: "trk_caf_1" },
        expansion: 6,
        range: { start: 0.1, end: 0.5 },
        expect: expectArg,
      }),
      ctx
    );
    const w = calls.find((c) => c.fn === "mattesFollowApply")!.args;
    expect(w.mode).toBe("subtract");
    expect(w.expansion).toBe(6);
    expect(w.name).toBe("CAF hole");
    expect(w.work_area).toEqual({ start: 0.1, duration: 0.5 });
    expect(out.ok).toBe(true);
    expect(out.receipt.matches).toBe(true);
    expect(out.instructions).toHaveLength(8);
    expect(out.instructions[4]).toContain("0.1 s to 0.6 s");
    expect(out.open_panel).toMatchObject({ tool: "ae_open_panel", args: { name: "Content-Aware Fill", allow_toggle: true } });
    expect(out.after_generate.args.find_fill).toBe(true);
    expect(out.notes.join(" ")).toContain("hole");
    // Never touches the Window menu or the panel itself.
    expect(calls.every((c) => !/executeCommand|openPanel/i.test(JSON.stringify(c)))).toBe(true);
  });

  it("leaves the work area alone without a track or a work_area, and says why", async () => {
    const { ctx, calls } = fakeAe();
    const out = await tool("ae_caf_prep").handler(
      AeCafPrepSchema.parse({ comp_id: 1, layer: { index: 1 }, new_mask: { region: { rect: [10, 10, 50, 50] } }, mask_mode: "none", expect: expectArg }),
      ctx
    );
    const w = calls.find((c) => c.fn === "mattesFollowApply")!.args;
    expect(w.work_area).toBeUndefined();
    expect(w.times).toEqual([]);
    expect(w.static_shape.vertices).toHaveLength(4);
    expect(w.mode).toBe("none");
    expect(out.notes.join(" ")).toContain("work area was not changed");
    expect(out.notes.join(" ")).toContain("No expansion was set");
    expect(out.receipt.matches).toBe(true);
  });

  it("find_fill is read only: no guard, no write, candidates ranked, a next call for the best", async () => {
    const cand = (over: any) => ({
      layer: { index: 1, id: 30, name: "Fill 1" },
      enabled: true,
      source: { id: 5, name: "fill.[0001-0050].png", folder: "Fill" },
      in_point: 0,
      out_point: 3,
      in_fill_folder: true,
      name_matches: true,
      above_plate: true,
      matches_work_area: true,
      ...over,
    });
    const { ctx, calls } = fakeAe({
      fill: {
        comp: { id: 1, work_area_start: 0, work_area_duration: 3 },
        plate: { index: 2, id: 10, name: "Plate" },
        fill_folders: ["Fill"],
        candidates: [cand({ layer: { index: 4, id: 31, name: "fill copy" }, in_fill_folder: false, above_plate: false, matches_work_area: false }), cand({})],
        scanned: 4,
        truncated: false,
      },
    });
    const out = await tool("ae_caf_prep").handler(AeCafPrepSchema.parse({ comp_id: 1, layer: { index: 2 }, find_fill: true }), ctx);
    expect(calls.map((c) => c.fn)).toEqual(["mattesFindFill"]);
    expect(out.candidates[0].layer.id).toBe(30);
    expect(out.best.layer.id).toBe(30);
    expect(out.next).toMatchObject({ tool: "ae_patch_check", args: { comp_id: 1, patch_layers: [{ id: 30 }] } });
    expect(out.notes.join(" ")).toContain("loose");
    const none = await tool("ae_caf_prep").handler(AeCafPrepSchema.parse({ comp_id: 1, layer: { index: 2 }, find_fill: true }), fakeAe().ctx);
    expect(none.best).toBeNull();
    expect(none.next).toBeNull();
    expect(none.notes.join(" ")).toContain("No footage layer looks like");
  });
});

// ---------- the host functions under node:vm ----------

function setup(modernMattes = true) {
  const project = new FakeProject();
  const comp = project.addComp("Main", W, H, 3);
  comp.modernMattes = modernMattes;
  const host = loadHost(project, ["mattes.jsx"]);
  host.G.MaskMotionBlur = { SAME_AS_LAYER: 7012, ON: 7013, OFF: 7014 };
  return { project, comp, ...host };
}

const addPlate = (comp: FakeComp, name = "Plate"): FakeLayer => {
  const item = comp.project.addFootage(name, W, H);
  return comp.layers.add(item) as FakeLayer;
};

const addMask = (layer: FakeLayer, shape?: Record<string, unknown>) => {
  const parade = layer.group.property("ADBE Mask Parade") as FakeGroup;
  const mask = parade.addProperty("ADBE Mask Atom") as FakeGroup;
  if (shape) {
    const s = new Shape();
    Object.assign(s, shape);
    (mask.property("ADBE Mask Shape") as FakeProperty).setValue(s);
  }
  return mask;
};

const shapeAt = (v: number): any => ({
  vertices: [[v, 0], [v + 100, 0], [v + 100, 50], [v, 50]],
  inTangents: [[0, 0], [0, 0], [0, 0], [0, 0]],
  outTangents: [[0, 0], [0, 0], [0, 0], [0, 0]],
});

describe("mattesMaskRead (host)", () => {
  it("describes a mask, its path at a time and sampled paths, and changes nothing", () => {
    const { A, comp, undo } = setup();
    const layer = addPlate(comp);
    const mask = addMask(layer, { ...shapeAt(10), featherSegLocs: [0, 2], featherRadii: [5, 6] });
    mask.maskMode = 6814;
    (mask.property("ADBE Mask Offset") as FakeProperty).setValue(3);
    layer.group.property("ADBE Effect Parade")!;
    const r = A.mattesMaskRead({ comp_id: comp.id, layer: { index: 1 }, mask: { index: 1 }, ref_time: 0, with_shape: true, times: [0, 1] });
    expect(r.can_hold_masks).toBe(true);
    expect(r.mask_count).toBe(1);
    expect(r.mask).toMatchObject({ index: 1, mode: "subtract", inverted: false, expansion: 3, shape_keys: 0, feather_keys: 0, locked: false });
    expect(r.mask.shape.vertices[0]).toEqual([10, 0]);
    expect(r.mask.shape.feather_points).toBe(2);
    expect(r.mask.shape.feather_radii).toEqual([5, 6]);
    expect(r.mask.samples).toHaveLength(2);
    expect(r.comp).toMatchObject({ width: W, height: H, fps: 25 });
    expect(r.layer).toMatchObject({ locked: false, three_d: false });
    expect(undo.begun).toBe(0);
    expect(A.mattesMaskRead({ comp_id: comp.id, layer: { index: 1 }, mask: { name: "Mask 1" } }).mask.vertices).toBe(4);
    expect(() => A.mattesMaskRead({ comp_id: comp.id, layer: { index: 1 }, mask: { index: 4 } })).toThrow(/out of range/);
    expect(() => A.mattesMaskRead({ comp_id: comp.id, layer: { index: 1 }, mask: { name: "Nope" } })).toThrow(/No mask named/);
  });

  it("lists the pin effects on the layer, and says when a layer can't hold masks", () => {
    const { A, comp } = setup();
    const layer = addPlate(comp);
    const fx = layer.group.property("ADBE Effect Parade") as FakeGroup;
    fx.props.push(new FakeGroup("Corner Pin", "ADBE Corner Pin", []), new FakeGroup("Glow", "ADBE Glo2", []));
    expect(A.mattesMaskRead({ comp_id: comp.id, layer: { index: 1 } }).pin_effects).toEqual(["Corner Pin"]);
    layer.group.props = layer.group.props.filter((p) => p.matchName !== "ADBE Mask Parade");
    expect(A.mattesMaskRead({ comp_id: comp.id, layer: { index: 1 } }).can_hold_masks).toBe(false);
  });
});

describe("mattesFollowApply (host)", () => {
  const base = (comp: FakeComp, layer: FakeLayer, over: Record<string, unknown> = {}) => ({
    comp_id: comp.id,
    layer: { index: layer.index, id: layer.id },
    mask: { index: 1 },
    closed: true,
    ref_time: 0,
    times: [0, 0.5, 1],
    shapes: [shapeAt(10), shapeAt(30), shapeAt(50)],
    expect: GUARD,
    ...over,
  });

  it("keys an existing mask's path in one undo group, keeps its feather arrays, and sets linear keys", () => {
    const { A, comp, undo } = setup();
    const layer = addPlate(comp);
    const mask = addMask(layer, { ...shapeAt(10), featherSegLocs: [0, 2], featherRelSegLocs: [0.5, 0.5], featherRadii: [5, 6], featherTypes: [1, 1] });
    const out = A.mattesFollowApply(base(comp, layer, { mode: "subtract", inverted: true, expansion: 4, feather: [3, 3] }));
    expect(out.created).toBe(false);
    expect(out.keys).toBe(3);
    expect(out.mask).toMatchObject({ index: 1 });
    expect(undo).toEqual({ begun: 1, ended: 1 });
    const sp = mask.property("ADBE Mask Shape") as FakeProperty;
    expect(sp.numKeys).toBe(3);
    const mid = sp.valueAtTime(0.5, false) as any;
    expect(mid.vertices[0]).toEqual([30, 0]);
    expect(mid.featherSegLocs).toEqual([0, 2]);
    expect(mid.featherRelSegLocs).toEqual([0.5, 0.5]);
    expect(mid.featherRadii).toEqual([5, 6]);
    expect(mid.featherTypes).toEqual([1, 1]);
    for (let k = 1; k <= 3; k++) expect(sp.keyInInterpolationType(k)).toBe(6612);
    expect((mask as any).maskMode).toBe(6814);
    expect((mask as any).inverted).toBe(true);
    expect((mask.property("ADBE Mask Offset") as FakeProperty).value).toBe(4);
    expect((mask.property("ADBE Mask Feather") as FakeProperty).value).toEqual([3, 3]);
  });

  it("scales the feather and the radii per key and keys Mask Feather", () => {
    const { A, comp } = setup();
    const layer = addPlate(comp);
    const mask = addMask(layer, { ...shapeAt(10), featherSegLocs: [0], featherRadii: [10] });
    const out = A.mattesFollowApply(base(comp, layer, { base_feather: [10, 20], feather_scales: [1, 2, 3] }));
    expect(out.keys).toBe(3);
    const sp = mask.property("ADBE Mask Shape") as FakeProperty;
    expect((sp.valueAtTime(1, false) as any).featherRadii).toEqual([30]);
    expect((sp.valueAtTime(0.5, false) as any).featherRadii).toEqual([20]);
    const fp = mask.property("ADBE Mask Feather") as FakeProperty;
    expect(fp.numKeys).toBe(3);
    expect(fp.valueAtTime(0.5, false)).toEqual([20, 40]);
    expect(fp.keyInInterpolationType(2)).toBe(6612);
  });

  it("creates a new mask with a name, mode, motion blur and a static shape, and sets the work area", () => {
    const { A, comp, undo } = setup();
    const layer = addPlate(comp);
    const out = A.mattesFollowApply(
      base(comp, layer, { mask: null, name: "Hole", mode: "subtract", motion_blur: "on", times: [], shapes: undefined, static_shape: shapeAt(20), work_area: { start: 0.5, duration: 1 } })
    );
    expect(out.created).toBe(true);
    expect(out.mask).toEqual({ index: 1, name: "Hole" });
    expect(out.keys).toBe(0);
    expect(out.work_area.start).toBeCloseTo(0.5, 9);
    expect(comp.workAreaDuration).toBeCloseTo(1, 9);
    expect(undo).toEqual({ begun: 1, ended: 1 });
    const mask = (layer.group.property("ADBE Mask Parade") as FakeGroup).property(1) as any;
    expect(mask.name).toBe("Hole");
    expect(mask.maskMode).toBe(6814);
    expect(mask.maskMotionBlur).toBe(7013);
    expect((mask.property("ADBE Mask Shape") as FakeProperty).value.vertices[1]).toEqual([120, 0]);
  });

  it("replaces existing keys only with replace_keys, and refuses without it before opening an undo group", () => {
    const { A, comp, undo } = setup();
    const layer = addPlate(comp);
    const mask = addMask(layer, shapeAt(10));
    const sp = mask.property("ADBE Mask Shape") as FakeProperty;
    const s = new Shape();
    Object.assign(s, shapeAt(0));
    sp.setValueAtTime(5, s);
    sp.setValueAtTime(6, s);
    expect(() => A.mattesFollowApply(base(comp, layer))).toThrow(/already has 2 keyframes/);
    expect(undo.begun).toBe(0);
    const out = A.mattesFollowApply(base(comp, layer, { replace_keys: true }));
    expect(out.replaced_keys).toBe(2);
    expect(sp.numKeys).toBe(3);
    expect(sp.keyTime(1)).toBe(0);
  });

  it("validates everything before the undo group: locked layers and masks, expressions, vertex count, times, work area, guard", () => {
    const { A, comp, undo } = setup();
    const layer = addPlate(comp);
    const mask = addMask(layer, shapeAt(10));
    const sp = mask.property("ADBE Mask Shape") as FakeProperty;
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ mode: "multiply" }, /Unknown mask mode/],
      [{ times: [0, 0.5, 0.4] }, /ascend/],
      [{ times: [0, 0.5, -1] }, /not a time/],
      [{ shapes: [shapeAt(10), shapeAt(30)] }, /one shape per time/],
      [{ shapes: [shapeAt(10), { ...shapeAt(30), vertices: [[0, 0], [1, 1]], inTangents: [[0, 0], [0, 0]], outTangents: [[0, 0], [0, 0]] }, shapeAt(50)] }, /vertex count changes between keys/],
      [{ shapes: [{ ...shapeAt(1), vertices: [[0, 0], [1, 1]], inTangents: [[0, 0], [0, 0]], outTangents: [[0, 0], [0, 0]] }].concat([shapeAt(1)].slice(0, 0)), times: [0] }, /has 4 vertices and the shapes have 2/],
      [{ shapes: [shapeAt(1), { ...shapeAt(2), inTangents: [[0, 0]] }, shapeAt(3)] }, /inTangents needs 4/],
      [{ work_area: { start: 2.5, duration: 1 } }, /past the comp's end/],
      [{ work_area: { start: 0, duration: 0 } }, /at least one frame/],
      [{ feather: [1] }, /feather must be \[x, y\]/],
      [{ feather_scales: [1, 2] }, /one number per time/],
      [{ expansion: "a" }, /expansion must be a number/],
      [{ static_shape: shapeAt(1) }, /not both/],
    ];
    for (const [over, re] of cases) expect(() => A.mattesFollowApply(base(comp, layer, over))).toThrow(re);
    expect(() => A.mattesFollowApply({ ...base(comp, layer), expect: undefined })).toThrow(/no expect/);
    expect(() => A.mattesFollowApply({ ...base(comp, layer), expect: { project_path: "C:/other.aep" } })).toThrow(/guard/i);
    expect(() => A.mattesFollowApply(base(comp, layer, { layer: { index: 1, id: 9999 } }))).toThrow(/stack changed/);
    sp.expression = "x";
    sp.expressionEnabled = true;
    expect(() => A.mattesFollowApply(base(comp, layer))).toThrow(/expression/);
    sp.expressionEnabled = false;
    layer.locked = true;
    expect(() => A.mattesFollowApply(base(comp, layer))).toThrow(/locked/);
    layer.locked = false;
    (mask as any).locked = true;
    expect(() => A.mattesFollowApply(base(comp, layer))).toThrow(/mask 1 is locked/);
    expect(undo.begun).toBe(0);
    expect(sp.numKeys).toBe(0);
  });

  it("refuses properties with keys or out-of-range values before writing, and mask motion blur on an AE without the enum", () => {
    const { A, comp, undo, G } = setup();
    const layer = addPlate(comp);
    const mask = addMask(layer, shapeAt(10));
    const fp = mask.property("ADBE Mask Feather") as FakeProperty;
    fp.setValueAtTime(1, [1, 1]);
    expect(() => A.mattesFollowApply(base(comp, layer, { feather: [2, 2] }))).toThrow(/feather already has 1 keyframes/);
    (fp as any).hasMin = true;
    (fp as any).minValue = [0, 0];
    fp.keys = [];
    expect(() => A.mattesFollowApply(base(comp, layer, { feather: [-5, 2] }))).toThrow(/below the property's minimum 0/);
    delete G.MaskMotionBlur;
    expect(() => A.mattesFollowApply(base(comp, layer, { motion_blur: "on" }))).toThrow(/no MaskMotionBlur/);
    expect(undo.begun).toBe(0);
  });

  it("changes only props when no path is given, and a work-area-only call needs no mask path", () => {
    const { A, comp } = setup();
    const layer = addPlate(comp);
    const mask = addMask(layer, shapeAt(10));
    const out = A.mattesFollowApply(base(comp, layer, { times: [], shapes: undefined, mode: "subtract", expansion: 7, work_area: { start: 1, duration: 1 } }));
    expect(out.keys).toBeUndefined();
    expect((mask.property("ADBE Mask Offset") as FakeProperty).value).toBe(7);
    expect((mask.property("ADBE Mask Shape") as FakeProperty).numKeys).toBe(0);
    expect(comp.workAreaStart).toBeCloseTo(1, 9);
  });
});

describe("mattesGarbageApply (host)", () => {
  const withTargets = (modern = true) => {
    const s = setup(modern);
    const bg = addPlate(s.comp, "BG");
    const fg = addPlate(s.comp, "FG");
    return { ...s, bg, fg };
  };
  const args = (comp: FakeComp, over: Record<string, unknown> = {}) => ({
    comp_id: comp.id,
    targets: [{ name: "BG" }],
    matte_type: "alpha",
    closed: true,
    times: [],
    static_shape: shapeAt(10),
    expect: GUARD,
    ...over,
  });

  it("adds a hidden comp-size solid above the target, masks it and sets the matte, in one undo group", () => {
    const { A, comp, bg, undo } = withTargets();
    expect(bg.index).toBe(2);
    const out = A.mattesGarbageApply(args(comp, { feather: [4, 4], expansion: 2 }));
    expect(undo).toEqual({ begun: 1, ended: 1 });
    expect(out.created).toBe(true);
    expect(out.api).toBe("setTrackMatte");
    expect(out.matte).toMatchObject({ name: "BG MATTE", index: 2 });
    expect(out.top_target_index_before).toBe(2);
    expect(out.hidden).toBe(true);
    const matte = comp.layer(2) as FakeLayer;
    expect(matte.name).toBe("BG MATTE");
    expect(matte.enabled).toBe(false);
    expect(matte.rect).toMatchObject({ width: W, height: H });
    expect((comp.layer(3) as FakeLayer).name).toBe("BG");
    expect(bg.trackMatteLayer).toBe(matte);
    expect(bg.trackMatteType).toBe(TrackMatteType.ALPHA);
    const mask = (matte.group.property("ADBE Mask Parade") as FakeGroup).property(1) as any;
    expect(mask.maskMode).toBe(6813);
    expect((mask.property("ADBE Mask Shape") as FakeProperty).value.vertices[2]).toEqual([110, 50]);
    expect((mask.property("ADBE Mask Feather") as FakeProperty).value).toEqual([4, 4]);
    expect((mask.property("ADBE Mask Offset") as FakeProperty).value).toBe(2);
  });

  it("feeds several targets with one matte placed above the topmost, keys the mask, and can leave it visible", () => {
    const { A, comp, bg, fg } = withTargets();
    // The stack is FG (1), BG (2): the topmost target is FG.
    const out = A.mattesGarbageApply(
      args(comp, { targets: [{ name: "BG" }, { name: "FG" }], matte_type: "alpha_inverted", name: "Hold", times: [0, 1], shapes: [shapeAt(0), shapeAt(20)], static_shape: undefined, hide_matte: false })
    );
    expect(out.matte).toMatchObject({ name: "Hold", index: 1 });
    expect(out.keys).toBe(2);
    expect(out.hidden).toBe(false);
    const matte = comp.layer(1) as FakeLayer;
    expect(matte.enabled).toBe(true);
    expect(fg.trackMatteLayer).toBe(matte);
    expect(bg.trackMatteLayer).toBe(matte);
    expect(bg.trackMatteType).toBe(TrackMatteType.ALPHA_INVERTED);
    const sp = ((matte.group.property("ADBE Mask Parade") as FakeGroup).property(1) as FakeGroup).property("ADBE Mask Shape") as FakeProperty;
    expect(sp.numKeys).toBe(2);
    expect(sp.keyInInterpolationType(1)).toBe(6612);
  });

  it("wires an existing layer as the matte without adding anything, and hides it", () => {
    const { A, comp, bg, fg } = withTargets();
    const roto = addPlate(comp, "Roto");
    const before = comp.numLayers;
    const out = A.mattesGarbageApply({ comp_id: comp.id, targets: [{ name: "BG" }, { name: "FG" }], matte_layer: { name: "Roto" }, matte_type: "luma", expect: GUARD });
    expect(out.created).toBe(false);
    expect(comp.numLayers).toBe(before);
    expect(roto.enabled).toBe(false);
    expect(bg.trackMatteLayer).toBe(roto);
    expect(fg.trackMatteType).toBe(TrackMatteType.LUMA);
  });

  it("refuses before the undo group: bad targets, an existing matte, duplicates, locked layers, a layer as its own matte, no region", () => {
    const { A, comp, bg, fg, undo } = withTargets();
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ targets: [{ name: "Missing" }] }, /No layer named/],
      [{ targets: [{ name: "BG" }, { index: 2 }] }, /listed twice/],
      [{ matte_type: "multiply" }, /Unknown track matte type/],
      [{ times: [0, 1], shapes: [shapeAt(0)], static_shape: undefined }, /one shape per time/],
      [{ static_shape: undefined }, /needs a region/],
      [{ static_shape: { ...shapeAt(1), vertices: [[0, 0]], inTangents: [[0, 0]], outTangents: [[0, 0]] } }, /2-500 vertices/],
      [{ feather: [1, 2, 3] }, /feather must be/],
      [{ choke: "x" }, /choke must be a number/],
      [{ matte_layer: { name: "BG" }, static_shape: undefined }, /its own track matte/],
    ];
    for (const [over, re] of cases) expect(() => A.mattesGarbageApply(args(comp, over))).toThrow(re);
    fg.trackMatteType = TrackMatteType.ALPHA;
    expect(() => A.mattesGarbageApply(args(comp, { targets: [{ name: "FG" }] }))).toThrow(/already has a alpha track matte/);
    expect(A.mattesGarbageApply(args(comp, { targets: [{ name: "FG" }], replace_existing_matte: true })).targets).toHaveLength(1);
    bg.locked = true;
    expect(() => A.mattesGarbageApply(args(comp))).toThrow(/is locked/);
    expect(undo.begun).toBe(1);
  });

  it("refuses cameras and lights as targets or matte", () => {
    const { A, comp } = withTargets();
    comp.layers.addCamera("Cam");
    expect(() => A.mattesGarbageApply(args(comp, { targets: [{ name: "Cam" }] }))).toThrow(/AV layers only/);
    expect(() => A.mattesGarbageApply({ comp_id: comp.id, targets: [{ name: "BG" }], matte_layer: { name: "Cam" }, matte_type: "alpha", expect: GUARD })).toThrow(/can't be a track matte/);
  });

  it("on an AE before 23 serves one target with the layer directly above, and refuses several", () => {
    const { A, comp, bg } = withTargets(false);
    expect(() => A.mattesGarbageApply(args(comp, { targets: [{ name: "BG" }, { name: "FG" }] }))).toThrow(/before 23/);
    const out = A.mattesGarbageApply(args(comp));
    expect(out.api).toBe("legacy");
    expect(bg.trackMatteType).toBe(TrackMatteType.ALPHA);
    expect((comp.layer(bg.index - 1) as FakeLayer).name).toBe("BG MATTE");
  });

  it("adds a Simple Choker when AE has one, and reports it when it does not", () => {
    const { A, comp } = withTargets();
    const out = A.mattesGarbageApply(args(comp, { choke: 5 }));
    expect(out.choke.applied).toBe(false);
    expect(out.choke.error).toMatch(/Can't add/);
    expect(out.created).toBe(true);
    // A host that knows the effect: patch the fake group to add it.
    const proto = FakeGroup.prototype as any;
    const original = proto.addProperty;
    proto.addProperty = function (this: FakeGroup, matchName: string) {
      if (matchName !== "ADBE Simple Choker") return original.call(this, matchName);
      const fx = new FakeGroup("Simple Choker", "ADBE Simple Choker", [
        new FakeProperty("View", "ADBE Simple Choker-0001", PropertyValueType.OneD, 1),
        new FakeProperty("Choke Matte", "ADBE Simple Choker-0002", PropertyValueType.OneD, 0),
      ]);
      fx.parentProperty = this;
      this.props.push(fx);
      return fx;
    };
    try {
      const s = withTargets();
      const ok = s.A.mattesGarbageApply(args(s.comp, { choke: 7 }));
      expect(ok.choke).toEqual({ applied: true, value: 7 });
      const read = s.A.mattesGarbageRead({ comp_id: s.comp.id, layers: [], matte_id: ok.matte.id });
      expect(read.matte.choke).toBe(7);
      expect(read.matte.effects[0]).toContain("ADBE Simple Choker");
    } finally {
      proto.addProperty = original;
    }
  });

  it("refuses a choke when app.effects says AE has no Simple Choker", () => {
    const project = new FakeProject();
    const comp = project.addComp("Main", W, H, 3);
    const { A } = loadHost(project, ["mattes.jsx"], { effects: [{ matchName: "ADBE Gaussian Blur 2" }] });
    addPlate(comp, "BG");
    expect(() => A.mattesGarbageApply(args(comp, { targets: [{ name: "BG" }], choke: 4 }))).toThrow(/no Simple Choker/);
  });
});

describe("mattesGarbageRead (host)", () => {
  it("reads targets by selector or id, tolerates a missing one, and describes the matte and its mask", () => {
    const { A, comp, undo } = setup();
    const bg = addPlate(comp, "BG");
    const out = A.mattesGarbageApply({ comp_id: comp.id, targets: [{ name: "BG" }], matte_type: "alpha", closed: true, times: [0, 1], shapes: [shapeAt(0), shapeAt(20)], expect: GUARD });
    const read = A.mattesGarbageRead({ comp_id: comp.id, layers: [{ name: "BG" }, { index: 99 }], layer_ids: [bg.id, 12345], matte_id: out.matte.id, times: [0, 1] });
    expect(read.layers[0]).toMatchObject({ found: true, name: "BG", matte_type: "alpha", matte_layer: { name: "BG MATTE" } });
    expect(read.layers[1].found).toBe(false);
    expect(read.layers[2].id).toBe(bg.id);
    expect(read.layers[3].found).toBe(false);
    expect(read.matte).toMatchObject({ name: "BG MATTE", enabled: false, is_solid: true, mask_count: 1 });
    expect(read.matte.mask).toMatchObject({ mode: "add", shape_keys: 2 });
    expect(read.matte.mask.samples).toHaveLength(2);
    expect(read.matte.mask.samples[1].vertices[0]).toEqual([20, 0]);
    expect(read.comp.num_layers).toBe(2);
    expect(undo.begun).toBe(1);
  });
});

describe("mattesFindFill (host)", () => {
  it("finds footage layers from a Fill folder, ranks nothing itself, and changes nothing", () => {
    const { A, comp, project, undo } = setup();
    const plate = addPlate(comp, "Plate");
    const folder = project.addFolder("Fill");
    const item = project.addFootage("fill_[0001-0075].png", W, H, undefined, folder);
    const fill = comp.layers.add(item) as FakeLayer;
    fill.inPoint = 0.5;
    fill.outPoint = 2.5;
    comp.workAreaStart = 0.5;
    comp.workAreaDuration = 2;
    const other = project.addFootage("music.wav", 0, 0);
    comp.layers.add(other);
    const out = A.mattesFindFill({ comp_id: comp.id, plate: { id: plate.id } });
    expect(out.fill_folders).toEqual(["Fill"]);
    expect(out.plate).toMatchObject({ name: "Plate" });
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0]).toMatchObject({
      layer: { name: "fill_[0001-0075].png" },
      in_fill_folder: true,
      name_matches: true,
      above_plate: true,
      matches_work_area: true,
      source: { folder: "Fill" },
    });
    // Moving the fill below the plate flips above_plate.
    fill.moveAfter(plate);
    expect(A.mattesFindFill({ comp_id: comp.id, plate: { id: plate.id } }).candidates[0].above_plate).toBe(false);
    expect(A.mattesFindFill({ comp_id: comp.id }).candidates[0].above_plate).toBeNull();
    expect(undo.begun).toBe(0);
    expect(comp.workAreaStart).toBe(0.5);
  });

  it("reports no candidates and a work area that does not match", () => {
    const { A, comp, project } = setup();
    addPlate(comp);
    expect(A.mattesFindFill({ comp_id: comp.id }).candidates).toEqual([]);
    const item = project.addFootage("generated fill.png", W, H);
    const l = comp.layers.add(item) as FakeLayer;
    l.inPoint = 1;
    const c = A.mattesFindFill({ comp_id: comp.id }).candidates[0];
    expect(c).toMatchObject({ in_fill_folder: false, name_matches: true, matches_work_area: false });
  });
});


// ---------- fixes found in review ----------

describe("snapping and the write size cap", () => {
  it("snaps times to the frame grid and drops a key that lands on the same frame", () => {
    expect(snapToFrame(0.0334, 29.97)).toBeCloseTo(1 / 29.97, 12);
    const r = snapKeyTimes([0, 0.0334, 0.0335, 0.07], 29.97);
    expect(r.idx).toEqual([0, 1, 3]);
    expect(r.times[1]).toBeCloseTo(1 / 29.97, 12);
    for (let i = 1; i < r.times.length; i++) expect(r.times[i]).toBeGreaterThan(r.times[i - 1]);
  });

  it("refuses more points than one evalScript string should carry, and says what to do", () => {
    expect(() => checkWriteSize(100, 4)).not.toThrow();
    expect(() => checkWriteSize(2999, 500)).toThrow(/range.*decimate_px/);
    expect(() => checkWriteSize(MAX_WRITE_POINTS / 3 + 1, 1)).toThrow(/over the/);
  });
});

describe("feather points and static paths in the receipt", () => {
  const read = (mask: any): any => ({ comp: { work_area_start: 0, work_area_duration: 3 }, mask });
  const exp: FollowExpect = { keys: 2, vertexCount: 4, sampleTimes: [0, 0.6], sampleVertices: [square.vertices, square.vertices], featherPoints: 2, frameDuration: 0.1 };
  const good = {
    shape_keys: 2,
    vertices: 4,
    samples: [
      { time: 0, vertices: square.vertices, feather_points: 2 },
      { time: 0.6, vertices: square.vertices, feather_points: 2 },
    ],
    feather_keys: 0,
  };

  it("flags a path whose variable-feather points AE dropped", () => {
    expect(followMismatches(exp, read(good))).toEqual([]);
    const lost = { ...good, samples: good.samples.map((x) => ({ ...x, feather_points: 0 })) };
    expect(followMismatches(exp, read(lost)).map((x) => x.path)).toEqual(["mask.feather_points@0", "mask.feather_points@0.6"]);
    // A new mask has no feather points to compare.
    expect(followMismatches({ ...exp, featherPoints: undefined }, read(lost))).toEqual([]);
  });

  it("checks a static path at ref_time: a mask in the wrong place no longer passes", () => {
    const staticExp: FollowExpect = { keys: 0, vertexCount: 4, sampleTimes: [0], sampleVertices: [square.vertices], frameDuration: 0.1 };
    const at = (dx: number) => read({ shape_keys: 0, vertices: 4, samples: [{ time: 0, vertices: square.vertices.map((p) => [p[0] + dx, p[1]]), feather_points: 0 }], feather_keys: 0 });
    expect(followMismatches(staticExp, at(0))).toEqual([]);
    expect(followMismatches(staticExp, at(9)).map((x) => x.path)).toEqual(["mask.path@0"]);
  });

  it("ae_caf_prep without a track samples the static path once and notices a wrong place", async () => {
    const good = fakeAe();
    const ok = await tool("ae_caf_prep").handler(
      AeCafPrepSchema.parse({ comp_id: 1, layer: { index: 1 }, new_mask: { region: { rect: [10, 10, 50, 50] } }, expect: expectArg }),
      good.ctx
    );
    expect(ok.receipt.matches).toBe(true);
    const afterCall = good.calls.filter((c) => c.fn === "mattesMaskRead").pop()!;
    expect(afterCall.args.times).toEqual([0]);
    const bad = fakeAe({ shiftAfter: 7 });
    const out = await tool("ae_caf_prep").handler(
      AeCafPrepSchema.parse({ comp_id: 1, layer: { index: 1 }, new_mask: { region: { rect: [10, 10, 50, 50] } }, expect: expectArg }),
      bad.ctx
    );
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches.map((m: any) => m.path)).toContain("mask.path@0");
  });

  it("ae_garbage_matte samples a static matte path once", async () => {
    const bad = fakeAe({ shiftAfter: 7 });
    const out = await tool("ae_garbage_matte").handler(
      AeGarbageMatteSchema.parse({ comp_id: 1, targets: [{ index: 2 }], region: { rect: [10, 10, 50, 50] }, expect: expectArg }),
      bad.ctx
    );
    expect(out.receipt.mismatches.map((m: any) => m.path)).toContain("matte.mask.path@0");
  });
});

describe("work area on the frame grid", () => {
  it("snaps a given work area and keeps start + duration inside the comp", async () => {
    const { ctx, calls } = fakeAe({ comp: { fps: 29.97, duration: 3.003 } });
    await tool("ae_caf_prep").handler(
      AeCafPrepSchema.parse({ comp_id: 1, layer: { index: 1 }, new_mask: { region: { rect: [10, 10, 50, 50] } }, work_area: { start: 0.1001, end: 3.0034 }, expect: expectArg }),
      ctx
    );
    const wa = calls.find((c) => c.fn === "mattesFollowApply")!.args.work_area;
    expect(wa.start).toBeCloseTo(3 / 29.97, 12);
    expect(wa.start + wa.duration).toBeLessThanOrEqual(3.003 + 1e-9);
    expect(wa.start + wa.duration).toBeCloseTo(3.003, 6);
  });

  it("refuses a work area shorter than one frame once snapped", async () => {
    const { ctx, calls } = fakeAe();
    const out = await tool("ae_caf_prep").handler(
      AeCafPrepSchema.parse({ comp_id: 1, layer: { index: 1 }, new_mask: { region: { rect: [10, 10, 50, 50] } }, work_area: { start: 1.01, end: 1.04 }, expect: expectArg }),
      ctx
    );
    expect(out.ok).toBe(false);
    expect(calls.some((c) => c.fn === "mattesFollowApply")).toBe(false);
  });

  it("keys land on the comp's frames", async () => {
    const t = mkTrack("trk_snap", 4, 10);
    saveTrack({ ...t, fps: 30, frames: t.frames.map((f, i) => ({ ...f, time: i * 0.0334 })) });
    const { ctx, calls } = fakeAe({ comp: { fps: 30 } });
    await tool("ae_mask_follow").handler(
      AeMaskFollowSchema.parse({ comp_id: 1, layer: { index: 1 }, mask: { index: 1 }, track: { track_id: "trk_snap" }, ref_time: 0, decimate_px: 0, expect: expectArg }),
      ctx
    );
    const times: number[] = calls.find((c) => c.fn === "mattesFollowApply")!.args.times;
    times.forEach((x) => expect(Math.abs(x * 30 - Math.round(x * 30))).toBeLessThan(1e-9));
  });
});

describe("ae_mask_follow refuses keyed properties before the guard", () => {
  it("expansion, opacity and feather keys refuse without replace_keys", async () => {
    saveTrack(mkTrack("trk_keys"));
    const base = { comp_id: 1, layer: { index: 1 }, mask: { index: 1 }, track: { track_id: "trk_keys" }, expect: expectArg };
    const cases: Array<[Record<string, unknown>, Record<string, unknown>, RegExp]> = [
      [{ expansion_keys: 2 }, { expansion: 3 }, /expansion already has 2 keys/],
      [{ opacity_keys: 2 }, { mask_opacity: 50 }, /opacity already has 2 keys/],
      [{ feather_keys: 2 }, { feather: 4 }, /feather already has 2 keys/],
    ];
    for (const [maskOver, extra, re] of cases) {
      const { ctx, calls } = fakeAe({ mask: maskOver });
      const out = await tool("ae_mask_follow").handler(AeMaskFollowSchema.parse({ ...base, ...extra }), ctx);
      expect(out.ok).toBe(false);
      expect(out.message).toMatch(re);
      expect(calls.map((c) => c.fn)).not.toContain("checkGuard");
      expect(calls.map((c) => c.fn)).not.toContain("mattesFollowApply");
    }
    const { ctx } = fakeAe({ mask: { expansion_keys: 2 } });
    expect((await tool("ae_mask_follow").handler(AeMaskFollowSchema.parse({ ...base, expansion: 3, replace_keys: true }), ctx)).ok).toBe(true);
  });
});

describe("ae_caf_prep honesty about the work area", () => {
  it("does not claim a work area change when none was made", async () => {
    const { ctx } = fakeAe();
    const out = await tool("ae_caf_prep").handler(
      AeCafPrepSchema.parse({ comp_id: 1, layer: { index: 1 }, new_mask: { region: { rect: [10, 10, 50, 50] } }, expect: expectArg }),
      ctx
    );
    expect(out.notes.join(" ")).not.toContain("Changing the work area");
    expect(out.instructions[4]).not.toContain("set to the fill range by this tool");
    expect(out.instructions[4]).toContain("did not change it");
  });

  it("says so when it did change it", async () => {
    const { ctx } = fakeAe();
    const out = await tool("ae_caf_prep").handler(
      AeCafPrepSchema.parse({ comp_id: 1, layer: { index: 1 }, new_mask: { region: { rect: [10, 10, 50, 50] } }, work_area: { start: 0.5, end: 1.5 }, expect: expectArg }),
      ctx
    );
    expect(out.notes.join(" ")).toContain("Changing the work area");
    expect(out.instructions[4]).toContain("was set to the fill range by this tool");
  });

  it("range and ref_time need a track", () => {
    const base = { comp_id: 1, layer: { index: 1 }, new_mask: { region: { rect: [1, 1, 5, 5] } }, expect: expectArg };
    expect(AeCafPrepSchema.safeParse({ ...base, range: { start: 0, end: 1 } }).success).toBe(false);
    expect(AeCafPrepSchema.safeParse({ ...base, ref_time: 1 }).success).toBe(false);
    expect(AeCafPrepSchema.safeParse({ ...base, track: { track_id: "t" }, ref_time: 1 }).success).toBe(true);
  });

  it("find_fill hands patch_region and its track on to ae_patch_check and says expect is needed", async () => {
    const fillRead = {
      comp: { id: 1, work_area_start: 0, work_area_duration: 3 },
      plate: { index: 2, id: 10, name: "Plate" },
      fill_folders: ["Fill"],
      candidates: [
        {
          layer: { index: 1, id: 30, name: "Fill 1" },
          enabled: true,
          source: { id: 5, name: "fill.png", folder: "Fill" },
          in_point: 0,
          out_point: 3,
          in_fill_folder: true,
          name_matches: true,
          above_plate: true,
          matches_work_area: true,
        },
      ],
      scanned: 2,
      truncated: false,
    };
    const plain = await tool("ae_caf_prep").handler(AeCafPrepSchema.parse({ comp_id: 1, layer: { index: 2 }, find_fill: true }), fakeAe({ fill: fillRead }).ctx);
    expect(plain.next.args.region).toBeUndefined();
    expect(plain.next.note).toContain("expect");
    expect(plain.notes.join(" ")).toContain("`region`");
    const withRegion = await tool("ae_caf_prep").handler(
      AeCafPrepSchema.parse({ comp_id: 1, layer: { index: 2 }, find_fill: true, patch_region: { rect: [10, 20, 30, 40] }, patch_region_track: { track_id: "trk_x" }, expect: expectArg }),
      fakeAe({ fill: fillRead }).ctx
    );
    expect(withRegion.next.args).toMatchObject({ region: { kind: "rect", rect: [10, 20, 40, 60] }, region_track: { track_id: "trk_x" }, expect: expectArg });
    expect(AeCafPrepSchema.safeParse({ comp_id: 1, layer: { index: 2 }, find_fill: true, patch_region_track: { track_id: "t" } }).success).toBe(false);
    expect(AeCafPrepSchema.safeParse({ comp_id: 1, layer: { index: 2 }, new_mask: { region: { rect: [1, 1, 5, 5] } }, patch_region: { rect: [1, 1, 5, 5] }, expect: expectArg }).success).toBe(false);
  });

  it("converts a region to ae_patch_check's format", () => {
    expect(toPatchRegion({ ellipse: [5, 6, 7, 8] })).toEqual({ kind: "ellipse", center: [5, 6], radius: [7, 8] });
    expect(toPatchRegion({ polygon: [[0, 0], [4, 0], [4, 4]] })).toEqual({ kind: "polygon", points: [[0, 0], [4, 0], [4, 4]] });
  });
});

describe("what the host had to work around reaches the notes", () => {
  it("reports a feather fallback and a work area it could not set", async () => {
    const { ctx } = fakeAe({ writeResult: { feather_fallback: true, feather_error: "bad feather", feather_points_dropped: 3, work_area_error: "no", path_error: "oops" } });
    const out = await tool("ae_caf_prep").handler(
      AeCafPrepSchema.parse({ comp_id: 1, layer: { index: 1 }, new_mask: { region: { rect: [10, 10, 50, 50] } }, work_area: { start: 0.5, end: 1.5 }, expect: expectArg }),
      ctx
    );
    const notes = out.notes.join(" ");
    expect(notes).toContain("3 feather point(s) were dropped");
    expect(notes).toContain("The path could not be written");
    expect(notes).toContain("work area could not be set");
  });
});

describe("mattesFollowApply feather fallback and the work area (host)", () => {
  const base = (comp: FakeComp, layer: FakeLayer, over: Record<string, unknown> = {}) => ({
    comp_id: comp.id,
    layer: { index: layer.index, id: layer.id },
    mask: { index: 1 },
    closed: true,
    ref_time: 0,
    times: [0, 0.5, 1],
    shapes: [shapeAt(10), shapeAt(30), shapeAt(50)],
    expect: GUARD,
    ...over,
  });
  /** Makes the path property refuse a Shape that carries feather arrays, as AE might. */
  const rejectFeather = (sp: FakeProperty, always = false) => {
    const orig = sp.setValuesAtTimes.bind(sp);
    (sp as any).setValuesAtTimes = (times: number[], vals: any[]) => {
      if (always || vals.some((v) => v.featherTypes !== undefined || (v.featherSegLocs && v.featherSegLocs.length))) throw new Error("feather data rejected");
      return orig(times, vals);
    };
  };

  it("writes the path again without feather arrays when AE rejects them, and says so instead of throwing", () => {
    const { A, comp } = setup();
    const layer = addPlate(comp);
    const mask = addMask(layer, { ...shapeAt(10), featherSegLocs: [0, 2], featherRadii: [5, 6], featherTypes: [1, 1] });
    const sp = mask.property("ADBE Mask Shape") as FakeProperty;
    rejectFeather(sp);
    const out = A.mattesFollowApply(base(comp, layer, { mode: "subtract" }));
    expect(out.feather_fallback).toBe(true);
    expect(out.feather_points_dropped).toBe(2);
    expect(out.feather_error).toMatch(/rejected/);
    expect(out.keys).toBe(3);
    expect(out.path_error).toBeUndefined();
    expect((mask as any).maskMode).toBe(6814);
    expect((sp.valueAtTime(0.5, false) as any).vertices[0]).toEqual([30, 0]);
  });

  it("writes the path before the other properties, and rethrows when nothing was changed", () => {
    const { A, comp, undo } = setup();
    const layer = addPlate(comp);
    const mask = addMask(layer, shapeAt(10));
    const sp = mask.property("ADBE Mask Shape") as FakeProperty;
    rejectFeather(sp, true);
    expect(() => A.mattesFollowApply(base(comp, layer, { mode: "subtract", expansion: 9 }))).toThrow(/rejected/);
    expect((mask as any).maskMode).not.toBe(6814);
    expect((mask.property("ADBE Mask Offset") as FakeProperty).value).not.toBe(9);
    expect(undo.begun).toBe(undo.ended);
  });

  it("reports instead of throwing when the path fails after a change (replace_keys cleared the old keys)", () => {
    const { A, comp } = setup();
    const layer = addPlate(comp);
    const mask = addMask(layer, shapeAt(10));
    const sp = mask.property("ADBE Mask Shape") as FakeProperty;
    const s = new Shape();
    Object.assign(s, shapeAt(0));
    sp.setValueAtTime(5, s);
    sp.setValueAtTime(6, s);
    rejectFeather(sp, true);
    const out = A.mattesFollowApply(base(comp, layer, { replace_keys: true, mode: "subtract" }));
    expect(out.path_error).toMatch(/rejected/);
    expect(out.keys).toBe(0);
    expect((mask as any).maskMode).toBe(6814);
  });

  it("clamps a work area that ends within float noise of the comp's end, and refuses more", () => {
    const { A, comp } = setup();
    const layer = addPlate(comp);
    addMask(layer, shapeAt(10));
    const out = A.mattesFollowApply(base(comp, layer, { work_area: { start: 1, duration: 2 + 1e-9 } }));
    expect(out.work_area.start + out.work_area.duration).toBeLessThanOrEqual(comp.duration + 1e-12);
    expect(() => A.mattesFollowApply(base(comp, layer, { replace_keys: true, work_area: { start: 1, duration: 2.001 } }))).toThrow(/past the comp's end/);
  });

  it("keeps the mask write and reports when the work area cannot be set", () => {
    const { A, comp } = setup();
    const layer = addPlate(comp);
    const mask = addMask(layer, shapeAt(10));
    let calls = 0;
    Object.defineProperty(comp, "workAreaDuration", {
      configurable: true,
      get: () => 3,
      set: () => {
        calls++;
        if (calls === 2) throw new Error("work area refused");
      },
    });
    const out = A.mattesFollowApply(base(comp, layer, { work_area: { start: 1, duration: 1 } }));
    expect(out.work_area_error).toMatch(/refused/);
    expect(out.keys).toBe(3);
    expect((mask.property("ADBE Mask Shape") as FakeProperty).numKeys).toBe(3);
  });
});

describe("mattesGarbageApply matte layer switches (host)", () => {
  it("refuses a locked existing matte whose video switch would have to change, and sets enabled both ways", () => {
    const { A, comp, undo } = (() => {
      const s = setup();
      addPlate(s.comp, "BG");
      return s;
    })();
    const roto = addPlate(comp, "Roto");
    roto.locked = true;
    const call = (over: Record<string, unknown> = {}) =>
      A.mattesGarbageApply({ comp_id: comp.id, targets: [{ name: "BG" }], matte_layer: { name: "Roto" }, matte_type: "alpha", expect: GUARD, ...over });
    expect(() => call()).toThrow(/locked and its video switch would have to change/);
    expect(undo.begun).toBe(0);
    // Already off, and it is to be hidden: nothing to change, so a locked matte is fine.
    roto.enabled = false;
    expect(call().hidden).toBe(true);
    expect(roto.enabled).toBe(false);
    roto.locked = false;
    // hide_matte: false switches a matte AE turned off back on.
    const out = call({ hide_matte: false, replace_existing_matte: true });
    expect(out.hidden).toBe(false);
    expect(roto.enabled).toBe(true);
  });

  it("switches the video on after setTrackMatte switched it off, when hide_matte is false", () => {
    const { A, comp, bg } = (() => {
      const s = setup();
      const bg = addPlate(s.comp, "BG");
      return { ...s, bg };
    })();
    const orig = bg.setTrackMatte.bind(bg);
    (bg as any).setTrackMatte = (m: FakeLayer, t: number) => {
      orig(m, t);
      m.enabled = false;
    };
    const out = A.mattesGarbageApply({ comp_id: comp.id, targets: [{ name: "BG" }], matte_type: "alpha", closed: true, times: [], static_shape: shapeAt(10), hide_matte: false, expect: GUARD });
    expect(out.hidden).toBe(false);
    expect((comp.layer(2) as FakeLayer).enabled).toBe(true);
  });
});


// ---------- fixes found in review ----------

/** The object shape under a chain of refinements. */
const shapeOf = (schema: any): any => {
  let s = schema;
  while (s._def.schema) s = s._def.schema;
  return s.shape;
};

describe("ranged writes merge with the keys outside the range (server)", () => {
  const follow = (over: Record<string, unknown> = {}) =>
    AeMaskFollowSchema.parse({ comp_id: 1, layer: { index: 1 }, mask: { index: 1 }, track: { track_id: "trk_range_1" }, decimate_px: 0, expect: expectArg, ...over });

  it("a ranged call on a mask that already has keys goes through, sends the range, and the receipt counts the kept keys", async () => {
    saveTrack(mkTrack("trk_range_1", 7));
    const { ctx, calls } = fakeAe({ mask: { shape_keys: 4 }, keptKeys: 4 });
    const out = await tool("ae_mask_follow").handler(follow({ range: { start: 0.3, end: 0.5 } }), ctx);
    expect(out.ok).toBe(true);
    const write = calls.find((c) => c.fn === "mattesFollowApply")!.args;
    expect(write.times).toEqual([0.3, 0.4, 0.5]);
    expect(write.key_range.start).toBeCloseTo(0.25, 6);
    expect(write.key_range.end).toBeCloseTo(0.55, 6);
    expect(write.replace_keys).toBe(false);
    expect(out.receipt.matches).toBe(true);
    expect(out.notes.join(" ")).toContain("outside the range are kept");
  });

  it("the receipt fails when the kept keys were lost", async () => {
    saveTrack(mkTrack("trk_range_1", 7));
    // The host says 4 keys were kept, the read-back finds none of them.
    const { ctx } = fakeAe({ mask: { shape_keys: 4 }, writeResult: { kept_keys: 4 } });
    const out = await tool("ae_mask_follow").handler(follow({ range: { start: 0.3, end: 0.5 } }), ctx);
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches.map((m: any) => m.path)).toContain("mask.shape_keys");
  });

  it("without a range, existing path keys still refuse", async () => {
    saveTrack(mkTrack("trk_range_1", 7));
    const { ctx } = fakeAe({ mask: { shape_keys: 4 } });
    const out = await tool("ae_mask_follow").handler(follow(), ctx);
    expect(out).toMatchObject({ ok: false });
    expect(out.message).toContain("already has 4 keys");
  });

  it("refuses a ranged call whose ref_time is outside the keyed stretch, before writing", async () => {
    saveTrack(mkTrack("trk_range_1", 7));
    const { ctx, calls } = fakeAe({ mask: { shape_keys: 4, shape_key_span: [1, 2] } });
    const out = await tool("ae_mask_follow").handler(follow({ range: { start: 0.3, end: 0.5 } }), ctx);
    expect(out).toMatchObject({ ok: false });
    expect(out.message).toContain("Do the range that holds ref_time first");
    expect(calls.some((c) => c.fn === "mattesFollowApply")).toBe(false);
  });

  it("allows a ranged call whose ref_time lies inside the keyed stretch", async () => {
    saveTrack(mkTrack("trk_range_1", 7));
    const { ctx } = fakeAe({ mask: { shape_keys: 4, shape_key_span: [0, 2] }, keptKeys: 4 });
    const out = await tool("ae_mask_follow").handler(follow({ range: { start: 0.3, end: 0.5 } }), ctx);
    expect(out.ok).toBe(true);
  });

  it("repeats feather with scale_feather for a second range although the feather is keyed", async () => {
    saveTrack(mkTrack("trk_range_1", 7));
    const { ctx } = fakeAe({ mask: { shape_keys: 4, shape_key_span: [0, 2], feather_keys: 3, feather: [4, 4] }, keptKeys: 4 });
    const out = await tool("ae_mask_follow").handler(follow({ range: { start: 0.3, end: 0.5 }, feather: [4, 4], scale_feather: true }), ctx);
    expect(out.ok).not.toBe(false);
  });

  it("widens key_range to the comp-grid times the keys snap to", async () => {
    saveTrack(mkTrack("trk_range_1", 7));
    const { ctx, calls } = fakeAe({ comp: { fps: 4 }, mask: { shape_keys: 4, shape_key_span: [0, 2] }, keptKeys: 4 });
    await tool("ae_mask_follow").handler(follow({ range: { start: 0.3, end: 0.5 } }), ctx);
    const write = calls.find((c) => c.fn === "mattesFollowApply")!.args;
    const first = write.times[0];
    const last = write.times[write.times.length - 1];
    expect(write.key_range.start).toBeLessThanOrEqual(first);
    expect(write.key_range.end).toBeGreaterThanOrEqual(last);
  });

  it("widens key_range to the comp-grid time a faster track's last frame snaps to", async () => {
    // 30 fps track on a 10 fps comp: the frame at 0.4667 s keys at 0.5 s, past range end + half a track frame (0.4867).
    const t = mkTrack("trk_range_30", 30);
    t.fps = 30;
    t.frames = t.frames.map((f, i) => ({ ...f, time: i / 30 }));
    saveTrack(t);
    const { ctx, calls } = fakeAe({ mask: { shape_keys: 4, shape_key_span: [0, 2] }, keptKeys: 4 });
    await tool("ae_mask_follow").handler(
      AeMaskFollowSchema.parse({ comp_id: 1, layer: { index: 1 }, mask: { index: 1 }, track: { track_id: "trk_range_30" }, range: { start: 0, end: 0.47 }, decimate_px: 0, expect: expectArg }),
      ctx
    );
    const write = calls.find((c) => c.fn === "mattesFollowApply")!.args;
    expect(write.times[write.times.length - 1]).toBeCloseTo(0.5, 6);
    expect(write.key_range.end).toBeGreaterThanOrEqual(0.5);
  });

  it("refuses a ranged call whose keyed stretch ends before ref_time", async () => {
    saveTrack(mkTrack("trk_range_1", 15));
    const { ctx, calls } = fakeAe({ mask: { shape_keys: 4, shape_key_span: [0, 0.5] } });
    const out = await tool("ae_mask_follow").handler(follow({ range: { start: 0.3, end: 0.5 }, ref_time: 1 }), ctx);
    expect(out).toMatchObject({ ok: false });
    expect(out.message).toContain("Do the range that holds ref_time first");
    // The way out is named: the keys written have to be undone or removed.
    expect(out.message).toContain("undo them");
    expect(calls.some((c) => c.fn === "mattesFollowApply")).toBe(false);
  });

  it("the ref_time slack covers the comp's grid when the track is faster than the comp", async () => {
    // 30 fps track, 10 fps comp: ref_time 0.4333 is 0.033 s past a key at 0.4 (the comp frame the key snapped to).
    const t = mkTrack("trk_range_slack", 30);
    t.fps = 30;
    t.frames = t.frames.map((f, i) => ({ ...f, time: i / 30 }));
    saveTrack(t);
    const { ctx } = fakeAe({ mask: { shape_keys: 4, shape_key_span: [0, 0.4] }, keptKeys: 4 });
    const out = await tool("ae_mask_follow").handler(
      AeMaskFollowSchema.parse({
        comp_id: 1,
        layer: { index: 1 },
        mask: { index: 1 },
        track: { track_id: "trk_range_slack" },
        ref_time: 13 / 30,
        range: { start: 0.5, end: 0.7 },
        decimate_px: 0,
        expect: expectArg,
      }),
      ctx
    );
    expect(out.ok).not.toBe(false);
  });

  it("a ranged first call that leaves ref_time outside its range says the other range should have come first", async () => {
    saveTrack(mkTrack("trk_range_1", 15));
    const { ctx } = fakeAe({ mask: { shape_keys: 0 } });
    const out = await tool("ae_mask_follow").handler(follow({ range: { start: 0.3, end: 0.5 }, ref_time: 1 }), ctx);
    expect(out.ok).toBe(true);
    const notes = out.notes.join(" ");
    expect(notes).toContain("should have come first");
    expect(notes).toContain("undo this call");
  });

  it("a ranged first call that holds ref_time gets no such note", async () => {
    saveTrack(mkTrack("trk_range_1", 15));
    const { ctx } = fakeAe({ mask: { shape_keys: 0 } });
    const out = await tool("ae_mask_follow").handler(follow({ range: { start: 0.3, end: 0.5 }, ref_time: 0.4 }), ctx);
    expect(out.ok).toBe(true);
    expect(out.notes.join(" ")).not.toContain("should have come first");
  });

  it("the range descriptions no longer promise what the host cannot do", () => {
    expect(tool("ae_mask_follow").description).toContain("keys outside the range stay");
    const garbage = shapeOf(AeGarbageMatteSchema).range.description ?? "";
    expect(garbage).toContain("ae_mask_follow");
    expect(garbage).toContain("cannot be joined");
  });
});

describe("the reference frame is the frame the track was re-based on (server)", () => {
  it("an unsnapped ref_time is snapped once: layer space, mask read and write all use the frame", async () => {
    saveTrack(mkTrack("trk_snap_1", 7));
    const { ctx, calls } = fakeAe();
    const out = await tool("ae_mask_follow").handler(
      AeMaskFollowSchema.parse({ comp_id: 1, layer: { index: 1 }, new_mask: { region: { rect: [100, 100, 100, 100] } }, track: { track_id: "trk_snap_1" }, ref_time: 0.304, decimate_px: 0, expect: expectArg }),
      ctx
    );
    expect(out.ok).toBe(true);
    expect(calls.find((c) => c.fn === "planarLayerSpace")!.args.times[0]).toBe(0.3);
    expect(calls.find((c) => c.fn === "mattesMaskRead")!.args.ref_time).toBe(0.3);
    expect(calls.find((c) => c.fn === "mattesFollowApply")!.args.ref_time).toBe(0.3);
    expect(out.ref_time).toBe(0.3);
  });
});

describe("a new region is brought into a transformed layer's space (server)", () => {
  it("applies the inverse of the layer matrix: a layer at (300, 50) scaled 200% puts comp (120, 100) at (-90, 25)", async () => {
    saveTrack(mkTrack("trk_inv_1", 7));
    const { ctx, calls } = fakeAe({ layerSample: { position: [300, 50], scale: [200, 200] } });
    const out = await tool("ae_mask_follow").handler(
      AeMaskFollowSchema.parse({
        comp_id: 1,
        layer: { index: 1 },
        new_mask: { region: { rect: [100, 100, 100, 100] } },
        track: { track_id: "trk_inv_1" },
        range: { start: 0.2, end: 0.4 },
        decimate_px: 0,
        expect: expectArg,
      }),
      ctx
    );
    const write = calls.find((c) => c.fn === "mattesFollowApply")!.args;
    expect(write.times).toEqual([0.2, 0.3, 0.4]);
    // At the reference frame the corner is comp (100, 100) = layer (-100, 25); the track moves it 20 comp px, which is 10 layer px.
    expect(write.shapes[0].vertices[0][0]).toBeCloseTo(-90, 3);
    expect(write.shapes[0].vertices[0][1]).toBeCloseTo(25, 3);
    expect(write.shapes[0].vertices[2][0]).toBeCloseTo(-40, 3);
    expect(out.receipt.matches).toBe(true);
  });
});

describe("a track from another comp or frame rate is said so (server)", () => {
  it("notes the comp and the fps", async () => {
    const t = mkTrack("trk_origin_1", 7);
    t.comp_id = 5;
    t.fps = 25;
    saveTrack(t);
    const { ctx } = fakeAe();
    const out = await tool("ae_mask_follow").handler(
      AeMaskFollowSchema.parse({ comp_id: 1, layer: { index: 1 }, mask: { index: 1 }, track: { track_id: "trk_origin_1" }, expect: expectArg }),
      ctx
    );
    const notes = out.notes.join(" ");
    expect(notes).toContain("made in comp 5, not comp 1");
    expect(notes).toContain("25 fps and this comp is 10 fps");
  });
});

describe("garbageMismatches on an AE before 23", () => {
  const exp: GarbageExpect = { matteType: "alpha", hide: true, created: false, keys: null, vertexCount: 0, sampleTimes: [], sampleVertices: [] };
  const written = { api: "legacy", targets: [{ index: 3, id: 10, name: "BG" }], matte: { index: 2, id: 50, name: "M" } };
  const after = (over: Record<string, unknown> = {}) => ({
    comp: { num_layers: 3 },
    layers: [{ found: true, id: 10, index: 3, name: "BG", matte_type: "alpha", matte_layer: null, ...over }],
    matte: { found: true, id: 50, index: 2, name: "M", enabled: false },
  });
  it("accepts the matte directly above the target when trackMatteLayer is missing", () => {
    expect(garbageMismatches(exp, null, after(), written as any)).toEqual([]);
  });
  it("still refuses a matte that is not the layer above", () => {
    const m = garbageMismatches(exp, null, { ...after(), matte: { found: true, id: 50, index: 1, name: "M", enabled: false } }, written as any);
    expect(m.map((x) => x.path)).toContain("targets[10].matte_layer");
  });
  it("the modern API still compares the matte layer", () => {
    expect(garbageMismatches(exp, null, after(), { ...written, api: "setTrackMatte" } as any).map((x) => x.path)).toContain("targets[10].matte_layer");
  });
});

describe("ae_caf_prep reports the work area the host left", () => {
  it("does not claim the planned work area when the host could not set it", async () => {
    saveTrack(mkTrack("trk_caf_wa", 7));
    const { ctx } = fakeAe({ writeResult: { work_area_error: "refused", work_area: { start: 0, duration: 3 } } });
    const out = await tool("ae_caf_prep").handler(
      AeCafPrepSchema.parse({ comp_id: 1, layer: { index: 1 }, new_mask: { region: { rect: [100, 100, 100, 100] } }, track: { track_id: "trk_caf_wa" }, expect: expectArg }),
      ctx
    );
    expect(out.work_area).toBeUndefined();
    expect(out.work_area_error).toBe("refused");
  });
});

describe("ae_caf_prep work area text on a ranged call", () => {
  const args = () =>
    AeCafPrepSchema.parse({ comp_id: 1, layer: { index: 1 }, new_mask: { region: { rect: [100, 100, 100, 100] } }, track: { track_id: "trk_caf_range" }, range: { start: 0.2, end: 0.4 }, expect: expectArg });

  it("states a partial work area as its own sentence, with the note", async () => {
    saveTrack(mkTrack("trk_caf_range", 7));
    const { ctx } = fakeAe();
    const out = await tool("ae_caf_prep").handler(args(), ctx);
    expect(out.ok).toBe(true);
    const line = out.instructions.find((l: string) => l.startsWith("Range: Work Area"))!;
    expect(line).toContain("This tool set the work area to this call's range only");
    expect(line).toContain("before generating");
    expect(line).not.toContain("by this tool");
    expect(out.notes.join(" ")).toContain("the work area now covers this call's range only");
  });

  it("does not call the work area partial when the host could not set it", async () => {
    saveTrack(mkTrack("trk_caf_range", 7));
    const { ctx } = fakeAe({ writeResult: { work_area_error: "refused", work_area: { start: 0, duration: 3 } } });
    const out = await tool("ae_caf_prep").handler(args(), ctx);
    expect(out.work_area_error).toBe("refused");
    expect(out.notes.join(" ")).not.toContain("the work area now covers this call's range only");
    expect(out.instructions.find((l: string) => l.startsWith("Range: Work Area"))).toContain("this tool did not change it");
  });
});

describe("find_fill and the mask expansion", () => {
  it("tells the caller to grow patch_region by the mask's expansion and feather", async () => {
    const fill = {
      comp: { id: 1, width: W, height: H, fps: 10, work_area_start: 0, work_area_duration: 3 },
      plate: { index: 2, id: 10, name: "Plate" },
      fill_folders: ["Fill"],
      candidates: [{ layer: { index: 1, id: 77, name: "Fill" }, enabled: true, source: { id: 1, name: "fill", folder: "Fill" }, in_point: 0, out_point: 3, in_fill_folder: true, name_matches: true, above_plate: true, matches_work_area: true }],
      scanned: 2,
      truncated: false,
    };
    const { ctx } = fakeAe({ fill });
    const out = await tool("ae_caf_prep").handler(
      AeCafPrepSchema.parse({ comp_id: 1, layer: { index: 2 }, find_fill: true, patch_region: { rect: [10, 10, 50, 50] }, expect: expectArg }),
      ctx
    );
    expect(out.notes.join(" ")).toContain("grow patch_region by it");
    expect(shapeOf(AeCafPrepSchema).patch_region.description).toContain("Expansion and Feather");
  });
});

describe("mattesFollowApply with key_range (host)", () => {
  const rangeArgs = (comp: FakeComp, layer: FakeLayer, over: Record<string, unknown> = {}) => ({
    comp_id: comp.id,
    layer: { index: layer.index, id: layer.id },
    mask: { index: 1 },
    closed: true,
    ref_time: 0,
    times: [0, 0.5, 1],
    shapes: [shapeAt(10), shapeAt(30), shapeAt(50)],
    key_range: { start: -0.05, end: 1.05 },
    expect: GUARD,
    ...over,
  });
  const keyed = (times: number[]) => {
    const { A, comp, undo } = setup();
    const layer = addPlate(comp);
    const mask = addMask(layer, shapeAt(10));
    const sp = mask.property("ADBE Mask Shape") as FakeProperty;
    for (const t of times) {
      const s = new Shape();
      Object.assign(s, shapeAt(0));
      sp.setValueAtTime(t, s);
    }
    return { A, comp, undo, layer, sp };
  };

  it("keeps the keys outside the range and reports how many", () => {
    const { A, comp, layer, sp, undo } = keyed([5, 6]);
    const out = A.mattesFollowApply(rangeArgs(comp, layer));
    expect(out.kept_keys).toBe(2);
    expect(out.keys).toBe(5);
    expect(sp.numKeys).toBe(5);
    expect(sp.keyTime(4)).toBe(5);
    expect(undo).toEqual({ begun: 1, ended: 1 });
  });

  it("reports only the keys it replaced, and leaves the interpolation of kept keys alone", () => {
    const { A, comp, layer, sp } = keyed([5, 6]);
    const hold = 6614;
    sp.setInterpolationTypeAtKey(2, hold, hold);
    const out = A.mattesFollowApply(rangeArgs(comp, layer));
    expect(out.replaced_keys).toBe(0);
    expect(out.kept_keys).toBe(2);
    expect(sp.keyTime(5)).toBe(6);
    expect(sp.keyOutInterpolationType(5)).toBe(hold);
    expect(sp.keyOutInterpolationType(1)).toBe(6612);
  });

  it("refuses keys inside the range without replace_keys, and with it removes only those", () => {
    const { A, comp, layer, sp, undo } = keyed([0.5, 5]);
    expect(() => A.mattesFollowApply(rangeArgs(comp, layer))).toThrow(/1 keyframes inside that range/);
    expect(undo.begun).toBe(0);
    const out = A.mattesFollowApply(rangeArgs(comp, layer, { replace_keys: true }));
    expect(out.replaced_keys).toBe(1);
    expect(out.kept_keys).toBe(1);
    expect(out.keys).toBe(4);
    expect(sp.keyTime(4)).toBe(5);
  });

  it("two adjacent ranges both survive", () => {
    const { A, comp, layer, sp } = keyed([]);
    A.mattesFollowApply(rangeArgs(comp, layer, { times: [0, 0.5], shapes: [shapeAt(10), shapeAt(30)], key_range: { start: -0.05, end: 0.55 } }));
    const out = A.mattesFollowApply(rangeArgs(comp, layer, { times: [0.6, 1], shapes: [shapeAt(40), shapeAt(50)], key_range: { start: 0.55, end: 1.05 } }));
    expect(out.kept_keys).toBe(2);
    expect(sp.numKeys).toBe(4);
    expect([1, 2, 3, 4].map((k) => sp.keyTime(k))).toEqual([0, 0.5, 0.6, 1]);
  });

  it("refuses a key_range that is not start < end", () => {
    const { A, comp, layer } = keyed([]);
    expect(() => A.mattesFollowApply(rangeArgs(comp, layer, { key_range: { start: 1, end: 1 } }))).toThrow(/key_range/);
  });
});

describe("mattesGarbageApply refusals and failures AE can cause (host)", () => {
  const withTargets = (modern = true) => {
    const s = setup(modern);
    const bg = addPlate(s.comp, "BG");
    const fg = addPlate(s.comp, "FG");
    return { ...s, bg, fg };
  };
  const call = (comp: FakeComp, over: Record<string, unknown> = {}) =>
    ({ comp_id: comp.id, targets: [{ name: "BG" }], matte_type: "alpha", closed: true, times: [], static_shape: shapeAt(10), expect: GUARD, ...over });

  it("refuses an audio-only target and an audio-only matte before the undo group", () => {
    const { A, comp, bg, undo } = withTargets();
    bg.hasVideo = false;
    expect(() => A.mattesGarbageApply(call(comp))).toThrow(/has no video/);
    bg.hasVideo = true;
    const roto = addPlate(comp, "Roto");
    roto.hasVideo = false;
    expect(() => A.mattesGarbageApply(call(comp, { matte_layer: { name: "Roto" } }))).toThrow(/has no video/);
    expect(undo.begun).toBe(0);
  });

  it("refuses an existing matte that is itself matted by a target, directly or through another matte", () => {
    const { A, comp, bg, fg, undo } = withTargets();
    const roto = addPlate(comp, "Roto");
    const mid = addPlate(comp, "Mid");
    roto.trackMatteLayer = bg;
    expect(() => A.mattesGarbageApply(call(comp, { matte_layer: { name: "Roto" } }))).toThrow(/matte loop/);
    roto.trackMatteLayer = mid;
    mid.trackMatteLayer = fg;
    expect(() => A.mattesGarbageApply(call(comp, { targets: [{ name: "FG" }], matte_layer: { name: "Roto" } }))).toThrow(/matte loop/);
    expect(undo.begun).toBe(0);
  });

  it("reports a target AE refuses instead of throwing after the others were wired", () => {
    const { A, comp, bg, fg, undo } = withTargets();
    (fg as any).setTrackMatte = () => {
      throw new Error("AE refused this matte");
    };
    const out = A.mattesGarbageApply(call(comp, { targets: [{ name: "BG" }, { name: "FG" }] }));
    expect(undo).toEqual({ begun: 1, ended: 1 });
    expect(out.targets.find((t: any) => t.name === "BG").error).toBeUndefined();
    expect(out.targets.find((t: any) => t.name === "FG").error).toBe("AE refused this matte");
    expect(bg.trackMatteType).toBe(TrackMatteType.ALPHA);
  });

  it("reports a video switch AE refuses on a locked matte instead of throwing", () => {
    const { A, comp, bg, undo } = withTargets();
    const roto = addPlate(comp, "Roto");
    roto.locked = true;
    let enabled = true;
    Object.defineProperty(roto, "enabled", {
      configurable: true,
      get: () => enabled,
      set: () => {
        throw new Error("layer is locked");
      },
    });
    const orig = bg.setTrackMatte!.bind(bg);
    (bg as any).setTrackMatte = (m: FakeLayer, t: number) => {
      orig(m, t);
      enabled = false;
    };
    const out = A.mattesGarbageApply(call(comp, { matte_layer: { name: "Roto" }, hide_matte: false }));
    expect(out.enabled_error).toBe("layer is locked");
    expect(undo).toEqual({ begun: 1, ended: 1 });
  });

  it("reads the layer above as the matte on an AE before 23", () => {
    const { A, comp, bg } = withTargets(false);
    // The real legacy Layer has no trackMatteLayer property at all.
    delete (bg as any).trackMatteLayer;
    A.mattesGarbageApply(call(comp));
    const r = A.mattesGarbageRead({ comp_id: comp.id, layer_ids: [bg.id] });
    expect(r.layers[0].matte_type).toBe("alpha");
    expect(r.layers[0].matte_layer).toMatchObject({ name: "BG MATTE" });
    expect(r.layers[0].legacy).toBe(true);
  });
});
