import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PNG } from "pngjs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import { saveTrack, type PlanarFrame, type PlanarTrack } from "../src/tools/ext/planar.js";
import { applyH, identityH, invertH, layerMatrix, mulH, solveModel, translationH, type Mat3, type Vec2 } from "../src/tools/ext/planar-math.js";
import {
  AeStabilizeRoundtripSchema,
  AeStabilizeSchema,
  buildTransformKeys,
  checkPlate,
  checkRigPlate,
  correctionFrames,
  coversComp,
  defaultPad,
  drawStabSheet,
  evenSamples,
  fillZoom,
  guidePlateRenders,
  GUIDE_DIFF_THRESHOLD,
  measureResidual,
  meanAbsDiff,
  paramTableAgrees,
  pickSheetTimes,
  pivotOf,
  planRig,
  planStabilize,
  plateSample,
  roundtripError,
  smoothWithMirror,
  stabilizeMismatches,
  stabilizeTools,
  tileExtents,
  tileOutputPct,
  TILE_FX_PARAMS,
  TRANSFORM_FX_PARAMS,
  transformKeysMatrix,
  zoomAbout,
  type Inspect,
} from "../src/tools/ext/stabilize.js";
import { toGray, type GrayImage } from "../src/tools/ext/track.js";
import { FakeGroup, FakeLayer, FakeProject, FakeProperty, GUARD, loadHost, PropertyType, PropertyValueType, type FakeComp } from "./support/fake-ae.js";

// The track store and the frame folder live under the data dir: keep them out of the real one.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-stabilize-"));
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

const tool = (name: string) => stabilizeTools.find((t) => t.name === name)!;
const expectArg = { project_path: "<unsaved>" };
const close = (a: ArrayLike<number>, b: ArrayLike<number>, tol = 1e-6) => {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) expect(Math.abs(a[i] - b[i])).toBeLessThan(tol);
};
const rot = (deg: number, s: number, tx: number, ty: number): Mat3 => {
  const r = (deg * Math.PI) / 180;
  return [s * Math.cos(r), -s * Math.sin(r), tx, s * Math.sin(r), s * Math.cos(r), ty, 0, 0, 1];
};
const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// ---------- a plane under a known motion ----------

const W = 240;
const H = 160;
const tex = (u: number, v: number): number =>
  128 + 45 * Math.sin(0.31 * u) * Math.cos(0.27 * v) + 30 * Math.sin(0.11 * u + 0.17 * v) + 25 * Math.sin(0.53 * u - 0.41 * v + 1) + 15 * Math.sin(0.9 * u) * Math.sin(0.8 * v);
/** The plane's motion at frame k (frame 5 is the reference: identity). */
const motion = (k: number): Mat3 => rot(1.2 * (k - 5), 1 + 0.004 * (k - 5), 2 * (k - 5), 1 * (k - 5));
const POINTS: Vec2[] = [
  [60, 40],
  [180, 45],
  [190, 120],
  [55, 115],
  [120, 80],
];

function makeTrack(id: string, model: PlanarTrack["model"] = "similarity", ks = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]): PlanarTrack {
  const frames: PlanarFrame[] = ks.map((k) => ({
    time: k / 10,
    ok: true,
    H: motion(k),
    points: POINTS.map((p) => applyH(motion(k), p)),
    confidence: POINTS.map(() => 1),
    rms_px: 0,
    inliers: POINTS.length,
  }));
  const t: PlanarTrack = { version: 1, track_id: id, comp_id: 1, comp_size: [W, H], fps: 10, ref_time: 0.5, model, ref_points: POINTS, frames, source: "test", created: "c" };
  saveTrack(t);
  return t;
}

/** A bare track from a function of the frame index (no points). */
function bareTrack(n: number, hOf: (k: number) => Mat3, opts: Partial<PlanarTrack> = {}): PlanarTrack {
  const frames: PlanarFrame[] = Array.from({ length: n }, (_, k) => ({ time: k / 10, ok: true, H: hOf(k), points: [], confidence: [], rms_px: 0, inliers: 0 }));
  return { version: 1, track_id: "bare", comp_id: 1, comp_size: [200, 100], fps: 10, ref_time: 0, model: "translate", ref_points: [[100, 50]], frames, source: "test", created: "c", ...opts };
}

const inspectOf = (over: Record<string, unknown> = {}, layerOver: Record<string, unknown> = {}): Inspect =>
  ({
    comp: { id: 1, name: "Main", width: W, height: H, pixel_aspect: 1, fps: 10, frame_duration: 0.1, duration: 1, motion_blur: false, num_layers: 1 },
    layer: {
      index: 1,
      id: 100,
      name: "Plate",
      locked: false,
      three_d: false,
      parent: null,
      has_video: true,
      width: W,
      height: H,
      source_id: 7,
      source_pixel_aspect: 1,
      time_remap: false,
      start_time: 0,
      in_point: 0,
      out_point: 1,
      stretch: 100,
      num_masks: 0,
      guide: false,
      motion_blur: false,
      bicubic: false,
      separated_position: false,
      ...layerOver,
    },
    transform: { anchor: [0, 0], position: [0, 0], scale: [100, 100], rotation: 0 },
    keys: { anchor: 0, position: 0, scale: 0, rotation: 0 },
    expressions: [],
    effects: [],
    effects_truncated: false,
    num_effects: 0,
    ...over,
  }) as Inspect;

// ---------- the pure maths ----------

describe("pivot and correction", () => {
  it("pins the centroid of the track's points, else the comp centre", () => {
    expect(pivotOf(makeTrack("trk_stab_pivot"))).toEqual([121, 80]);
    expect(pivotOf(bareTrack(3, () => identityH(), { ref_points: [] }))).toEqual([100, 50]);
  });

  it("lock gives the inverse of the track; applied to the track it is the identity", () => {
    const t = makeTrack("trk_stab_lock");
    const c = correctionFrames({ track: t, mode: "lock", smoothFrames: 15, pivot: pivotOf(t) });
    expect(c.frames).toHaveLength(10);
    for (const f of c.frames) close(mulH(f.D, f.H), identityH(), 1e-9);
  });

  it("position_only takes out the pivot's displacement and nothing else", () => {
    const t = makeTrack("trk_stab_pos");
    const pivot = pivotOf(t);
    const c = correctionFrames({ track: t, mode: "position_only", smoothFrames: 15, pivot });
    for (const f of c.frames) {
      const moved = applyH(f.H, pivot) as Vec2;
      close(applyH(f.D, moved) as Vec2, pivot, 1e-9);
      // A pure translation: the linear part stays the identity.
      close([f.D[0], f.D[1], f.D[3], f.D[4]], [1, 0, 0, 1], 1e-12);
    }
  });

  it("smooth keeps a smoothed path and loses the jitter", () => {
    const jitter = (k: number) => 3 * Math.sin(k * 2.3) + 2 * Math.cos(k * 3.7);
    const t = bareTrack(40, (k) => translationH(2 * k + jitter(k) - jitter(0), 0.5 * k));
    const pivot: Vec2 = [100, 50];
    const c = correctionFrames({ track: t, mode: "smooth", smoothFrames: 4, pivot });
    const path = c.frames.map((f) => applyH(mulH(f.D, f.H), pivot) as Vec2);
    const raw = c.frames.map((f) => applyH(f.H, pivot) as Vec2);
    const accel = (pts: Vec2[]) => Math.max(...pts.slice(2).map((p, i) => Math.abs(p[0] - 2 * pts[i + 1][0] + pts[i][0])));
    expect(accel(raw)).toBeGreaterThan(5);
    expect(accel(path)).toBeLessThan(1);
    // The reference frame stays where it was.
    close(path[0], raw[0], 0.5);
  });

  it("lists frames the track did not solve, and frames outside a range", () => {
    const t = makeTrack("trk_stab_notok");
    t.frames[2] = { ...t.frames[2], ok: false, H: null };
    const c = correctionFrames({ track: t, mode: "lock", smoothFrames: 15, pivot: pivotOf(t), range: { start: 0.1, end: 0.7 } });
    expect(c.not_ok).toEqual([0.2]);
    expect(c.frames.map((f) => f.time)).toEqual([0.1, 0.3, 0.4, 0.5, 0.6, 0.7]);
  });
});

describe("smoothWithMirror", () => {
  it("does not drift at the ends of a steady drift, where a plain Gaussian does", () => {
    const t = bareTrack(30, (k) => translationH(3 * k, 0));
    const mirrored = smoothWithMirror(t, 4);
    const plain = smoothFrames2(t, 4);
    const last = (tr: PlanarTrack) => (tr.frames[tr.frames.length - 1].H as Mat3)[2];
    expect(Math.abs(last(mirrored) - 87)).toBeLessThan(0.05);
    expect(Math.abs(last(plain) - 87)).toBeGreaterThan(2);
    // Inside the shot both agree.
    expect(Math.abs((mirrored.frames[15].H as Mat3)[2] - 45)).toBeLessThan(0.05);
    expect(mirrored.frames).toHaveLength(30);
  });
});

// smoothFrames, imported late so the test above reads in the order of the argument.
import { smoothFrames as smoothFrames2 } from "../src/tools/ext/planar-math.js";

describe("scale to fill and motion tile", () => {
  const layer: Vec2 = [200, 100];
  const comp: Vec2 = [200, 100];
  const shift = (dx: number, dy = 0): { D: Mat3 } => ({ D: translationH(-dx, -dy) });

  it("finds the smallest zoom that keeps the comp covered", () => {
    const frames = [shift(-10), shift(0), shift(10)];
    const r = fillZoom(frames, identityH(), layer, comp);
    // (W/2) / (W/2 - |dx|) = 100 / 90
    expect(r.coverable).toBe(true);
    expect(r.zoom).toBeGreaterThan(1.109);
    expect(r.zoom).toBeLessThan(1.113);
    expect(coversComp(frames, identityH(), layer, comp, r.zoom)).toBe(true);
    expect(coversComp(frames, identityH(), layer, comp, r.zoom - 0.01)).toBe(false);
  });

  it("needs no zoom when nothing moves, and says so when no zoom can cover", () => {
    expect(fillZoom([shift(0)], identityH(), layer, comp)).toEqual({ zoom: 1, coverable: true });
    expect(fillZoom([shift(150)], identityH(), layer, comp).coverable).toBe(false);
  });

  it("covers a rotated plate too", () => {
    const frames = [{ D: rot(3, 1, 0, 0) }, { D: rot(-3, 1, 0, 0) }];
    // Rotation about the origin, not the centre: a bigger zoom, still found.
    const r = fillZoom(frames, identityH(), layer, comp);
    expect(r.coverable).toBe(true);
    expect(coversComp(frames, identityH(), layer, comp, r.zoom)).toBe(true);
  });

  it("measures how far the comp reaches past the plate, and sizes the tile for it", () => {
    const ext = tileExtents([shift(-10), shift(0), shift(10)], identityH(), layer, comp)!;
    expect(ext.needed).toBe(true);
    expect(ext.left).toBeCloseTo(10, 6);
    expect(ext.right).toBeCloseTo(10, 6);
    expect(ext.top).toBe(0);
    // 200 + 2 * (10 + 2 margin) = 224 px = 112 %; the height only gets the margin.
    expect(tileOutputPct(layer, ext)).toEqual({ w: 112, h: 104 });
    expect(tileExtents([shift(0)], identityH(), layer, comp)!.needed).toBe(false);
  });

  it("zooms about the comp centre", () => {
    expect(applyH(zoomAbout(2, [100, 50]), [100, 50])).toEqual([100, 50]);
    expect(applyH(zoomAbout(2, [100, 50]), [110, 50])).toEqual([120, 50]);
  });
});

describe("buildTransformKeys", () => {
  it("writes AE's own Stabilize: the pivot as Anchor, Position held, Rotation -d, Scale 100/k", () => {
    const pivot: Vec2 = [120, 70];
    const hOf = (deg: number, k: number, d: Vec2): Mat3 => mulH(translationH(pivot[0] + d[0], pivot[1] + d[1]), mulH(rot(deg, k, 0, 0), translationH(-pivot[0], -pivot[1])));
    const cases: Array<[number, number, Vec2]> = [
      [0, 1, [0, 0]],
      [4, 1.05, [6, -3]],
      [-7, 0.96, [-9, 5]],
    ];
    const frames = cases.map(([deg, k, d], i) => {
      const Hm = hOf(deg, k, d);
      return { time: i / 10, F: invertH(Hm) as Mat3, pivot: applyH(Hm, pivot) as Vec2 };
    });
    const keys = buildTransformKeys({ base: identityH(), frames, anchorMode: "pivot", size: [240, 160] });
    expect(keys.skipped).toEqual([]);
    expect(keys.max_fit_px).toBeLessThan(0.01);
    cases.forEach(([deg, k, d], i) => {
      close(keys.position[i], pivot, 1e-3);
      expect(keys.rotation[i]).toBeCloseTo(-deg, 3);
      expect(keys.scale[i][0]).toBeCloseTo(100 / k, 2);
      close(keys.anchor[i], [pivot[0] + d[0], pivot[1] + d[1]], 1e-3);
    });
  });

  it("reproduces the exact matrix for a plate that is itself placed, scaled and rotated", () => {
    const base = layerMatrix({ anchor: [50, 40], position: [120, 90], scale_pct: [120, 120], rotation_deg: 8 });
    const Hm = rot(3, 1.02, 5, -4);
    const F = invertH(Hm) as Mat3;
    const keys = buildTransformKeys({ base, frames: [{ time: 0, F, pivot: applyH(Hm, [100, 80]) as Vec2 }], anchorMode: "pivot", size: [100, 80] });
    const want = mulH(F, base);
    const got = transformKeysMatrix(keys, 0);
    for (const c of [[0, 0], [100, 0], [0, 80], [100, 80]] as Vec2[]) close(applyH(got, c) as Vec2, applyH(want, c) as Vec2, 0.01);
  });

  it("fits a similarity to an affine correction and reports how far off it is", () => {
    const affine: Mat3 = [1.1, 0.05, 3, 0, 0.9, -2, 0, 0, 1];
    const keys = buildTransformKeys({ base: identityH(), frames: [{ time: 0, F: affine, pivot: [100, 50] }], anchorMode: "pivot", size: [200, 100], fitCorners: [[0, 0], [200, 0], [200, 100], [0, 100]] });
    expect(keys.times).toEqual([0]);
    expect(keys.max_fit_px).toBeGreaterThan(1);
  });

  it("keeps the rotation continuous across 180 degrees and skips a frame it cannot map", () => {
    const frames = [175, 179, -178, -174].map((deg, i) => ({ time: i / 10, F: rot(deg, 1, 0, 0), pivot: [50, 50] as Vec2 }));
    const keys = buildTransformKeys({ base: identityH(), frames, anchorMode: "fixed", fixedAnchor: [0, 0], size: [100, 100] });
    expect(keys.rotation).toEqual([175, 179, 182, 186]);
    const bad = buildTransformKeys({ base: identityH(), frames: [{ time: 0, F: identityH(), pivot: [0, 0] }], anchorMode: "pivot", size: [10, 10] });
    expect(bad.times).toEqual([0]);
    const singular = buildTransformKeys({ base: [0, 0, 0, 0, 0, 0, 0, 0, 1], frames: [{ time: 0, F: identityH(), pivot: [0, 0] }], anchorMode: "pivot", size: [10, 10] });
    expect(singular.skipped).toEqual([0]);
  });
});

describe("sheet times and samples", () => {
  const frames = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((k) => ({ time: k / 10, H: motion(k) }));
  it("picks the first, reference, last and worst-motion frames", () => {
    const t = pickSheetTimes(frames, [121, 80], 0.5);
    expect(t).toMatchObject({ first: 0, ref: 0.5, last: 0.9 });
    expect(t.worst).toBe(0);
  });
  it("spreads samples over the ok frames, ends included", () => {
    expect(evenSamples([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 4)).toEqual([0, 3, 6, 9]);
    expect(evenSamples([0, 1], 8)).toEqual([0, 1]);
  });
});

// ---------- the residual measure ----------

function grayOf(w: number, h: number, f: (x: number, y: number) => number): GrayImage {
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = f(x + 0.5, y + 0.5);
  return { width: w, height: h, data };
}

describe("measureResidual", () => {
  const pts: Vec2[] = [[70, 50], [160, 60], [100, 110]];
  const ref = grayOf(W, H, tex);

  it("finds nothing to correct on an image that did not move", () => {
    const r = measureResidual({ scale: 1, ref: { image: ref, expected: pts }, samples: [{ time: 0.1, image: ref, expected: pts }] });
    expect(r.points_used).toEqual([0, 1, 2]);
    expect(r.rms_px).toBeLessThan(0.1);
    expect(r.frames_measured).toBe(1);
  });

  it("measures a shift of a pixel and a half, in comp pixels, at half scale too", () => {
    const shifted = grayOf(W, H, (x, y) => tex(x - 1.5, y));
    const r = measureResidual({ scale: 1, ref: { image: ref, expected: pts }, samples: [{ time: 0.1, image: shifted, expected: pts }] });
    expect(r.rms_px).toBeGreaterThan(1.3);
    expect(r.rms_px).toBeLessThan(1.7);
    const half = grayOf(W / 2, H / 2, (x, y) => tex(x * 2 - 1.5, y * 2));
    const refHalf = grayOf(W / 2, H / 2, (x, y) => tex(x * 2, y * 2));
    const rh = measureResidual({ scale: 0.5, ref: { image: refHalf, expected: pts }, samples: [{ time: 0.1, image: half, expected: pts }] });
    expect(rh.rms_px).toBeGreaterThan(1.1);
    expect(rh.rms_px).toBeLessThan(1.9);
  });

  it("skips a point the track lost, a flat pattern and a pattern that does not match", () => {
    const flatRef = grayOf(W, H, (x, y) => (x > 140 ? 100 : tex(x, y)));
    const r = measureResidual({ scale: 1, ref: { image: flatRef, expected: pts }, samples: [{ time: 0.1, image: flatRef, expected: [pts[0], null, pts[2]] }] });
    expect(r.points_used).toEqual([0, 2]);
    expect(r.rms_px).toBeLessThan(0.1);
    const noise = grayOf(W, H, (x, y) => 128 + 90 * Math.sin(x * 1.7) * Math.cos(y * 2.3));
    const other = measureResidual({ scale: 1, ref: { image: ref, expected: pts }, samples: [{ time: 0.1, image: noise, expected: pts }] });
    expect(other.unmatched).toBeGreaterThan(0);
  });

  it("reports no rms when no point has a pattern", () => {
    const flat = grayOf(W, H, () => 100);
    const r = measureResidual({ scale: 1, ref: { image: flat, expected: pts }, samples: [{ time: 0.1, image: flat, expected: pts }] });
    expect(r.rms_px).toBeNull();
    expect(r.points_used).toEqual([]);
  });
});

describe("guide plate detection", () => {
  it("is suspected only when a frame away from the reference changed", () => {
    expect(GUIDE_DIFF_THRESHOLD).toBe(0.3);
    expect(guidePlateRenders([{ time: 0, mean_abs_diff: 0 }, { time: 0.5, mean_abs_diff: 0 }, { time: 0.9, mean_abs_diff: 0 }], 0.5)).toBe(false);
    expect(guidePlateRenders([{ time: 0, mean_abs_diff: 2.1 }, { time: 0.5, mean_abs_diff: 0 }], 0.5)).toBe(true);
    // The reference frame itself is pixel identical even when the guide renders (identity correction).
    expect(guidePlateRenders([{ time: 0.5, mean_abs_diff: 5 }], 0.5)).toBe(false);
    expect(guidePlateRenders([{ time: 0, mean_abs_diff: null }, { time: 0.1, mean_abs_diff: 0.29 }], 0.5)).toBe(false);
  });
});

describe("small helpers", () => {
  it("compares two renders and refuses different sizes", () => {
    const a = grayOf(4, 4, () => 10);
    const b = grayOf(4, 4, () => 14);
    expect(meanAbsDiff(a, b)).toBe(4);
    expect(meanAbsDiff(a, grayOf(2, 2, () => 0))).toBeNull();
  });

  it("checks the host's parameter table against resolveEffectParams", () => {
    const table = [
      { index: 1, name: "Anchor Point", matchName: "x1", type: "TwoD", role: "anchor" },
      { index: 2, name: "Position", matchName: "x2", type: "TwoD", role: "position" },
      { index: 4, name: "Scale Height", matchName: "x4", type: "OneD", role: "scaleH" },
      { index: 8, name: "Rotation", matchName: "x8", type: "OneD", role: "rotation" },
    ];
    expect(paramTableAgrees(table, { anchor: { names: ["Anchor Point"] }, position: { names: ["Position"] }, scaleH: { names: ["Scale Height"] }, rotation: { names: ["Rotation"] } })).toBe(true);
    expect(paramTableAgrees(table.map((r) => (r.role === "rotation" ? { ...r, role: "" } : r)), { rotation: { names: ["Rotation"] } })).toBe(false);
    expect(paramTableAgrees(undefined, TRANSFORM_FX_PARAMS)).toBe(true);
  });

  it("draws a sheet of marks and an outline", () => {
    const img = grayOf(W, H, tex);
    const rgba = { width: W, height: H, data: Buffer.alloc(W * H * 4, 200) };
    void img;
    const sheet = drawStabSheet([{ image: rgba, label: "a", marks: [[10, 10]], outline: [[20, 20], [60, 20], [60, 60], [20, 60]] }, { image: rgba, label: "b" }], [W, H], 120);
    expect(sheet.width).toBe(120 * 2 + 4);
    expect(sheet.height).toBe(80);
  });
});

// ---------- the plan ----------

describe("planStabilize", () => {
  const args = { mode: "lock" as const, smooth_frames: 15, target: "layer_transform" as const, edges: "none" as const, max_zoom: 2 };

  it("holds the pivot's Position for lock and gives Rotation/Scale that undo the track", () => {
    const t = makeTrack("trk_stab_plan");
    const plan = planStabilize(t, inspectOf(), args);
    const pivot = pivotOf(t);
    expect(plan.transform!.times).toHaveLength(10);
    for (const p of plan.transform!.position) close(p, pivot, 0.01);
    plan.frames.forEach((f, i) => {
      // The layer's matrix is exactly the correction.
      const got = transformKeysMatrix(plan.transform!, i);
      for (const c of [[0, 0], [W, 0], [0, H], [W, H]] as Vec2[]) close(applyH(got, c) as Vec2, applyH(f.D, c) as Vec2, 0.01);
    });
    expect(plan.transform!.rotation[0]).toBeCloseTo(6, 1);
    expect(plan.max_fit_px).toBeLessThan(0.01);
  });

  it("folds the fill zoom into the keys and lists what a Motion Tile would need", () => {
    const t = makeTrack("trk_stab_edges");
    // A pivot away from the comp centre, so the zoom about the centre moves it.
    const fill = planStabilize(t, inspectOf(), { ...args, edges: "scale_to_fill", pivot: [20, 20] });
    expect(fill.zoom).toBeGreaterThan(1.05);
    for (const p of fill.transform!.position) expect(dist(p, [20, 20])).toBeGreaterThan(5);
    expect(coversComp(fill.frames, plateSample(inspectOf(), 0.5).full, [W, H], [W, H], 1)).toBe(true);
    expect(fill.notes.join(" ")).toMatch(/zoomed/);
    const tile = planStabilize(t, inspectOf(), { ...args, edges: "motion_tile" });
    expect(tile.tile!.output_w_pct).toBeGreaterThan(100);
    expect(tile.zoom).toBeNull();
    expect(planStabilize(bareTrackFor(), inspectOf(), { ...args, edges: "motion_tile" }).tile).toBeNull();
  });

  it("refuses a zoom over max_zoom and a comp no zoom can cover", () => {
    const t = makeTrack("trk_stab_zoom");
    expect(() => planStabilize(t, inspectOf(), { ...args, edges: "scale_to_fill", max_zoom: 1.02 })).toThrow(/over max_zoom/);
    const far = bareTrack(3, (k) => translationH(300 * k, 0), { comp_size: [W, H], ref_time: 0 });
    expect(() => planStabilize(far, inspectOf(), { ...args, edges: "scale_to_fill" })).toThrow(/No zoom/);
  });

  it("plans a Transform effect in layer space, and refuses a non-uniform layer", () => {
    const t = makeTrack("trk_stab_fx");
    const plan = planStabilize(t, inspectOf({}, {}), { ...args, target: "transform_effect" });
    expect(plan.transform!.times).toHaveLength(10);
    for (const p of plan.transform!.position) close(p, pivotOf(t), 0.01);
    expect(() => checkPlate(inspectOf({ transform: { anchor: [0, 0], position: [0, 0], scale: [100, 80], rotation: 0 } }), { target: "transform_effect", compSize: [W, H] })).toThrow(/non-uniform/);
  });

  describe("a plate that is itself placed (anchor, position, scale and rotation not identity)", () => {
    const placed = inspectOf({ transform: { anchor: [100, 70], position: [150, 90], scale: [120, 120], rotation: 4 } });
    const corners: Vec2[] = [[0, 0], [W, 0], [0, H], [W, H]];
    const baseOf = () => plateSample(placed, 0.5).full;
    const sameAt = (a: Mat3, b: Mat3, tol = 0.02) => {
      for (const c of corners) close(applyH(a, c) as Vec2, applyH(b, c) as Vec2, tol);
    };

    it("layer_transform: the keys' matrix is the correction composed with the plate's own placement (F = D . base)", () => {
      const plan = planStabilize(makeTrack("trk_placed_lt"), placed, args);
      const base = baseOf();
      plan.frames.forEach((f, i) => sameAt(transformKeysMatrix(plan.transform!, i), mulH(f.D, base)));
    });

    it("transform_effect: base . effect matrix = D . base, so the effect is the correction conjugated into layer space", () => {
      const plan = planStabilize(makeTrack("trk_placed_fx"), placed, { ...args, target: "transform_effect" });
      const base = baseOf();
      plan.frames.forEach((f, i) => sameAt(mulH(base, transformKeysMatrix(plan.transform!, i)), mulH(f.D, base)));
      // Using the comp-space correction D as the effect's matrix (no conjugation) lands elsewhere for this plate.
      const worst = Math.max(...plan.frames.map((f) => dist(applyH(mulH(base, f.D), [W, H]) as Vec2, applyH(mulH(f.D, base), [W, H]) as Vec2)));
      expect(worst).toBeGreaterThan(1);
    });

    it("corner_pin: base . (the pin's homography) = D . base, the pins are in layer space", () => {
      const plan = planStabilize(makeTrack("trk_placed_pin", "perspective"), placed, { ...args, target: "corner_pin" });
      const base = baseOf();
      const pin = plan.pin!.pin!;
      plan.pin!.times.forEach((t, i) => {
        const f = plan.frames.find((x) => Math.abs(x.time - t) < 1e-9)!;
        const sol = solveModel("perspective", corners, [pin.ul[i], pin.ur[i], pin.ll[i], pin.lr[i]]);
        expect(sol).not.toBeNull();
        sameAt(mulH(base, (sol as { H: Mat3 }).H), mulH(f.D, base), 0.05);
      });
    });
  });

  it("refuses a shot over 3000 frames and says a second range cannot follow", () => {
    const long = bareTrack(3001, (k) => translationH(0.01 * k, 0), { comp_size: [W, H], ref_time: 0, ref_points: [[120, 80]], fps: 25 });
    expect(() => planStabilize(long, inspectOf(), args)).toThrow(/cannot be stabilized whole/);
    expect(() => planStabilize(long, inspectOf(), { ...args, range: { start: 0, end: 10 } })).not.toThrow();
  });

  it("plans Corner Pin keys for a perspective target and fits a similarity for a layer transform", () => {
    const t = makeTrack("trk_stab_pin", "perspective");
    const pin = planStabilize(t, inspectOf(), { ...args, target: "corner_pin" });
    expect(pin.pin!.times).toHaveLength(10);
    // At the reference frame the pin leaves the corners where they are.
    const at = pin.pin!.times.indexOf(0.5);
    expect(pin.pin!.pin!.ul[at]).toEqual([0, 0]);
    expect(pin.pin!.pin!.lr[at]).toEqual([W, H]);
    const fitted = planStabilize(t, inspectOf(), args);
    expect(fitted.notes.join(" ")).toMatch(/fitted with a similarity/);
  });

  it("counts frames the track did not solve", () => {
    const t = makeTrack("trk_stab_skip");
    t.frames[3] = { ...t.frames[3], ok: false, H: null };
    const plan = planStabilize(t, inspectOf(), args);
    expect(plan.not_ok).toEqual([0.3]);
    expect(plan.transform!.times).toHaveLength(9);
  });

  it("refuses a plate that cannot be stabilized, before anything is written", () => {
    const base = { target: "layer_transform" as const, compSize: [W, H] as Vec2 };
    expect(() => checkPlate(inspectOf({}, { locked: true }), base)).toThrow(/locked/);
    expect(() => checkPlate(inspectOf({}, { three_d: true }), base)).toThrow(/3D/);
    expect(() => checkPlate(inspectOf({}, { parent: { index: 2, id: 9, name: "Rig" } }), base)).toThrow(/parent/);
    expect(() => checkPlate(inspectOf({}, { source_pixel_aspect: 2 }), base)).toThrow(/pixel aspect/);
    expect(() => checkPlate(inspectOf({}, { width: null }), base)).toThrow(/no width and height/);
    expect(() => checkPlate(inspectOf(), { ...base, compSize: [100, 100] })).toThrow(/sizes must match/);
    expect(() => checkPlate(inspectOf({ keys: { anchor: 0, position: 3, scale: 0, rotation: 0 } }), base)).toThrow(/already has keys on position/);
    expect(() => checkPlate(inspectOf({ keys: { anchor: 0, position: 3, scale: 0, rotation: 0 } }), { ...base, replace_keys: true })).not.toThrow();
    expect(() => checkPlate(inspectOf({ expressions: ["scale"] }), base)).toThrow(/expressions/);
    // The other targets read the plate as sitting still: animation makes the correction wrong.
    const keyed = inspectOf({ keys: { anchor: 0, position: 3, scale: 0, rotation: 0 } });
    expect(() => checkPlate(keyed, { ...base, target: "transform_effect" })).toThrow(/keys on position/);
    expect(() => checkPlate(keyed, { ...base, target: "corner_pin" })).toThrow(/keys on position/);
    expect(() => checkPlate(inspectOf({ expressions: ["rotation"] }), { ...base, target: "transform_effect" })).toThrow(/expressions/);
  });

  it("refuses a plate with Auto-Orient on only where Position keys land on that layer", () => {
    const base = { compSize: [W, H] as Vec2 };
    const oriented = inspectOf({}, { auto_orient: true });
    expect(() => checkPlate(oriented, { ...base, target: "layer_transform" })).toThrow(/Auto-Orient/);
    for (const target of ["transform_effect", "corner_pin"] as const) expect(() => checkPlate(oriented, { ...base, target })).not.toThrow();
    expect(() => checkRigPlate(oriented, { ...base, kind: "transform", copy_effects: true })).toThrow(/Auto-Orient/);
    expect(() => checkRigPlate(oriented, { ...base, kind: "transform" })).not.toThrow();
    expect(() => checkRigPlate(oriented, { ...base, kind: "corner_pin", copy_effects: true })).not.toThrow();
    expect(() => checkPlate(inspectOf({}, { auto_orient: false }), { ...base, target: "layer_transform" })).not.toThrow();
  });

  it("refuses a rig with copy_effects on a plate with separated Position, before anything is built", () => {
    const base = { compSize: [W, H] as Vec2 };
    const sep = inspectOf({ num_effects: 1 }, { separated_position: true });
    expect(() => checkRigPlate(sep, { ...base, copy_effects: true })).toThrow(/separated Position/);
    // A plain copy is a fresh layer with a joined Position.
    expect(() => checkRigPlate(inspectOf({}, { separated_position: true }), base)).not.toThrow();
  });

  it("refuses a plate that already carries a stabilizing effect or a Corner Pin", () => {
    const base = { compSize: [W, H] as Vec2 };
    const fx = (name: string, matchName: string) => inspectOf({ num_effects: 1, effects: [{ index: 1, name, matchName }] });
    expect(() => checkPlate(fx("Stabilize Transform", "ADBE Geometry2"), { ...base, target: "transform_effect" })).toThrow(/double the correction/);
    expect(() => checkPlate(fx("Stabilize Tile", "ADBE Tile"), { ...base, target: "layer_transform", tile: true })).toThrow(/Stabilize Tile/);
    expect(() => checkPlate(fx("Stabilize Tile", "ADBE Tile"), { ...base, target: "layer_transform" })).not.toThrow();
    expect(() => checkPlate(fx("Corner Pin", "ADBE Corner Pin"), { ...base, target: "corner_pin" })).toThrow(/already has a Corner Pin/);
    expect(() => checkPlate(fx("Corner Pin", "ADBE Corner Pin"), { ...base, target: "transform_effect" })).not.toThrow();
  });
});

function bareTrackFor(): PlanarTrack {
  // Hardly any motion: the stabilized plate never reaches past its edges... within a pixel.
  return bareTrack(3, (k) => translationH(0.001 * k, 0), { comp_size: [W, H], ref_time: 0, ref_points: [[120, 80]] });
}

// ---------- the rig plan ----------

describe("planRig", () => {
  const ins = inspectOf({ transform: { anchor: [100, 70], position: [150, 90], scale: [120, 120], rotation: 4 } });

  it("makes two halves whose product is the plate's own placement, within 0.01 px", () => {
    const t = makeTrack("trk_rig_plan");
    const plan = planRig(t, ins, { pad: 24 });
    expect(plan.kind).toBe("transform");
    expect(plan.work).toEqual({ width: W + 48, height: H + 48 });
    expect(plan.roundtrip_error_px).toBeLessThan(0.01);
    expect(plan.inner.times).toEqual(plan.outer.times);
    expect(plan.inner.static_transform.position).toEqual([174, 114]);
    expect(plan.outer.static_transform).toMatchObject({ anchor: [(W + 48) / 2, (H + 48) / 2], position: [W / 2, H / 2], scale: [100, 100], rotation: 0 });
  });

  it("makes a patch placed on the steady image ride the moving shot", () => {
    const t = makeTrack("trk_rig_ride");
    const pad = 20;
    const plan = planRig(t, inspectOf(), { pad });
    const toKeys = (half: typeof plan.inner) => {
      const v = half.values as { anchor: Vec2[]; position: Vec2[]; rotation: number[]; scale: Vec2[] };
      return { times: half.times, anchor: v.anchor, position: v.position, rotation: v.rotation, scale: v.scale, skipped: [], max_fit_px: 0 };
    };
    const inner = toKeys(plan.inner);
    const outer = toKeys(plan.outer);
    // A feature at q in the reference sits at H(t) q in the plate; steady in the work comp at q + pad.
    plan.inner.times.forEach((time, i) => {
      const k = Math.round(time * 10);
      for (const q of POINTS) {
        const feature = applyH(motion(k), q) as Vec2;
        // The plate layer is static (identity), so the feature is at layer point `feature`.
        const work = applyH(transformKeysMatrix(inner, i), feature) as Vec2;
        close(work, [q[0] + pad, q[1] + pad], 0.01);
        const back = applyH(transformKeysMatrix(outer, i), work) as Vec2;
        close(back, feature, 0.01);
      }
    });
  });

  it("uses a Corner Pin in each half for a perspective track, identity at the reference", () => {
    const t = makeTrack("trk_rig_pin", "perspective");
    const plan = planRig(t, inspectOf(), { pad: 10 });
    expect(plan.kind).toBe("corner_pin");
    expect(plan.roundtrip_error_px).toBeNull();
    const at = plan.inner.times.indexOf(0.5);
    const iv = plan.inner.values as { ul: Vec2[]; lr: Vec2[] };
    const ov = plan.outer.values as { ul: Vec2[]; lr: Vec2[] };
    expect(iv.ul[at]).toEqual([0, 0]);
    expect(iv.lr[at]).toEqual([W, H]);
    expect(ov.ul[at]).toEqual([0, 0]);
    expect(ov.lr[at]).toEqual([W + 20, H + 20]);
    expect(plan.notes.join(" ")).toMatch(/two Corner Pins/);
  });

  it("defaults the padding to 10% of the longer side and refuses a work comp over AE's limit", () => {
    expect(defaultPad([1920, 1080])).toBe(192);
    expect(() => planRig(makeTrack("trk_rig_big"), ins, { pad: 20000 })).toThrow(/30000/);
  });

  it("refuses a plate the rig cannot copy faithfully", () => {
    const base = { compSize: [W, H] as Vec2 };
    expect(() => checkRigPlate(inspectOf({}, { source_id: null }), base)).toThrow(/no source/);
    expect(() => checkRigPlate(inspectOf({}, { time_remap: true }), base)).toThrow(/Time Remap/);
    expect(() => checkRigPlate(inspectOf({ keys: { anchor: 0, position: 2, scale: 0, rotation: 0 } }), base)).toThrow(/still transform/);
    expect(() => checkRigPlate(inspectOf({ num_effects: 1 }), base)).toThrow(/copy_effects/);
    expect(() => checkRigPlate(inspectOf({ num_effects: 1 }), { ...base, copy_effects: true })).not.toThrow();
    expect(() => checkRigPlate(inspectOf({}, { num_masks: 1 }), base)).toThrow(/masks/);
    expect(() => checkRigPlate(inspectOf({ num_effects: 1, effects: [{ index: 1, name: "Corner Pin", matchName: "ADBE Corner Pin" }] }), { ...base, copy_effects: true, kind: "corner_pin" })).toThrow(/Corner Pin/);
  });

  it("roundtripError sees a wrong inverse", () => {
    const t = makeTrack("trk_rig_err");
    const plan = planRig(t, inspectOf(), { pad: 10 });
    const v = plan.outer.values as { anchor: Vec2[]; position: Vec2[]; rotation: number[]; scale: Vec2[] };
    const keys = (half: typeof plan.inner) => {
      const x = half.values as { anchor: Vec2[]; position: Vec2[]; rotation: number[]; scale: Vec2[] };
      return { times: half.times, ...x, skipped: [], max_fit_px: 0 };
    };
    const inner = keys(plan.inner);
    const outer = keys(plan.outer);
    expect(roundtripError(inner, outer, identityH(), [W, H])).toBeLessThan(0.01);
    const broken = { ...outer, position: v.position.map((p) => [p[0] + 1, p[1]] as Vec2) };
    expect(roundtripError(inner, broken, identityH(), [W, H])).toBeGreaterThan(0.9);
  });
});

// ---------- schemas ----------

describe("schemas", () => {
  const base = { comp_id: 1, layer: { index: 1 }, track: { track_id: "trk_a" }, expect: expectArg };

  it("ae_stabilize fills in the defaults", () => {
    const p = AeStabilizeSchema.parse(base);
    expect(p).toMatchObject({ mode: "lock", smooth_frames: 15, edges: "none", max_zoom: 2, bicubic: true, verify: true, verify_frames: 8, sheets: true, max_renders: 24, max_seconds: 90 });
    expect(p.target).toBeUndefined();
  });

  it("ae_stabilize needs expect, a layer and a track, and refuses combinations that mean nothing", () => {
    expect(AeStabilizeSchema.safeParse({ ...base, expect: undefined }).success).toBe(false);
    expect(AeStabilizeSchema.safeParse({ ...base, layer: undefined }).success).toBe(false);
    expect(AeStabilizeSchema.safeParse({ ...base, track: {} }).success).toBe(false);
    expect(AeStabilizeSchema.safeParse({ ...base, mode: "wobble" }).success).toBe(false);
    expect(AeStabilizeSchema.safeParse({ ...base, shutter_angle: 90 }).success).toBe(false);
    expect(AeStabilizeSchema.safeParse({ ...base, shutter_angle: 90, target: "transform_effect" }).success).toBe(true);
    expect(AeStabilizeSchema.safeParse({ ...base, shutter_angle: 900, target: "transform_effect" }).success).toBe(false);
    expect(AeStabilizeSchema.safeParse({ ...base, mode: "position_only", target: "corner_pin" }).success).toBe(false);
    expect(AeStabilizeSchema.safeParse({ ...base, motion_blur: true, target: "corner_pin" }).success).toBe(false);
    expect(AeStabilizeSchema.safeParse({ ...base, motion_blur: true, target: "layer_transform" }).success).toBe(true);
    expect(AeStabilizeSchema.safeParse({ ...base, smooth_frames: 0 }).success).toBe(false);
    expect(AeStabilizeSchema.safeParse({ ...base, max_zoom: 1 }).success).toBe(false);
    expect(AeStabilizeSchema.safeParse({ ...base, pivot: [1, 2, 3] }).success).toBe(false);
    expect(AeStabilizeSchema.safeParse({ ...base, edges: "stretch" }).success).toBe(false);
  });

  it("ae_stabilize_roundtrip takes plate and track to build, and a rig to remove", () => {
    const rt = { comp_id: 1, expect: expectArg };
    expect(AeStabilizeRoundtripSchema.safeParse({ ...rt, plate: { index: 1 }, track: { track_id: "a" } }).success).toBe(true);
    expect(AeStabilizeRoundtripSchema.safeParse({ ...rt }).success).toBe(false);
    expect(AeStabilizeRoundtripSchema.safeParse({ ...rt, plate: { index: 1 } }).success).toBe(false);
    expect(AeStabilizeRoundtripSchema.safeParse({ ...rt, action: "remove" }).success).toBe(false);
    expect(AeStabilizeRoundtripSchema.safeParse({ ...rt, action: "remove", work_comp_id: 5 }).success).toBe(true);
    expect(AeStabilizeRoundtripSchema.safeParse({ ...rt, action: "remove", rig_layer: { name: "Plate STAB" } }).success).toBe(true);
    expect(AeStabilizeRoundtripSchema.safeParse({ ...rt, plate: { index: 1 }, track: { track_id: "a" }, pad_px: -1 }).success).toBe(false);
    const p = AeStabilizeRoundtripSchema.parse({ ...rt, plate: { index: 1 }, track: { track_id: "a" } });
    expect(p).toMatchObject({ action: "build", guide_mode: "guide_layer", motion_blur: true, sheet: true, max_renders: 8 });
  });

  it("both tools carry the safety guidance", () => {
    expect(stabilizeTools.map((t) => t.name)).toEqual(["ae_stabilize", "ae_stabilize_roundtrip"]);
    for (const t of stabilizeTools) expect(t.description).toContain("Jay may be editing live");
  });
});

// ---------- the tools against a fake AE ----------

interface Call {
  fn: string;
  args: any;
}

interface AeOpts {
  inspect?: Record<string, unknown>;
  layer?: Record<string, unknown>;
  failRenders?: boolean;
  breakKeys?: boolean;
  failAfterRead?: boolean;
  tileIndex?: number;
  noSheetsAfter?: boolean;
  /** The Transform effect's Sampling, Uniform Scale and shutter and the tile's Mirror Edges were not found. */
  paramsMissing?: boolean;
  /** The read-back lists the Motion Tile behind the stabilizing effect. */
  tileBehind?: boolean;
  /** The guide plate renders in the parent: frames away from the reference change. */
  guideRenders?: boolean;
  /** The plate copy's audio could not be muted. */
  audioStays?: boolean;
  /** A render of the shot comp throws before the rig is built ("before") or after it ("after"). */
  failRigRenders?: "before" | "after";
  /** Called when the plate is inspected: the first call of a build, before any render. */
  onInspect?: () => void;
}

const WORK_ID = 900;

/** Layer transform keys -> the matrix, from what a write left (anchor, position, rotation, scale per key). */
function keyMatrix(v: any, i: number): Mat3 {
  return layerMatrix({ anchor: v.anchor[i], position: v.position[i], scale_pct: Array.isArray(v.scale[i]) ? v.scale[i] : [v.scale[i], v.scale[i]], rotation_deg: v.rotation[i] });
}

function fakeAe(opts: AeOpts = {}) {
  const calls: Call[] = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-stabilize-q-"));
  tmpDirs.push(dir);
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
  let applied: any = null;
  let rig: any = null;
  let removed = false;

  /** What the comp shows at frame k: the plane under its motion, with the written correction applied to the plate. */
  const render = (k: number): PNG => {
    const png = new PNG({ width: W, height: H });
    const invMotion = invertH(motion(k)) as Mat3;
    let N: Mat3 | null = null;
    if (applied) {
      const i = applied.times.findIndex((t: number) => Math.abs(t - k / 10) < 1e-6);
      const j = i >= 0 ? i : 0;
      if (applied.target === "corner_pin") {
        const v = applied.values;
        const corners: Vec2[] = [[0, 0], [W, 0], [0, H], [W, H]];
        N = solveModel("perspective", corners, [v.ul[j], v.ur[j], v.ll[j], v.lr[j]])?.H ?? null;
      } else {
        N = keyMatrix(applied.values, j);
      }
    }
    const nInv = N ? invertH(N) : null;
    const bump = opts.guideRenders && rig && k !== 5 ? 20 : 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let p = applyH(invMotion, [x + 0.5, y + 0.5]) as Vec2;
        let v: number;
        if (nInv) {
          const l = applyH(nInv, [x + 0.5, y + 0.5]) as Vec2;
          v = l[0] < 0 || l[0] > W || l[1] < 0 || l[1] > H ? 0 : tex(...(applyH(invMotion, l) as Vec2));
        } else {
          v = tex(p[0], p[1]);
        }
        void p;
        p = [0, 0];
        const i = (y * W + x) * 4;
        png.data[i] = png.data[i + 1] = png.data[i + 2] = Math.max(0, Math.min(255, Math.round(v + bump)));
        png.data[i + 3] = 255;
      }
    }
    return png;
  };

  const inspect = () => ({
    comp: { id: 1, name: "Main", width: W, height: H, pixel_aspect: 1, fps: 10, frame_duration: 0.1, duration: 1, motion_blur: false, num_layers: 1 },
    layer: inspectOf({}, opts.layer).layer,
    transform: { anchor: [0, 0], position: [0, 0], scale: [100, 100], rotation: 0 },
    keys: { anchor: 0, position: 0, scale: 0, rotation: 0 },
    expressions: [],
    effects: [],
    effects_truncated: false,
    num_effects: 0,
    ...opts.inspect,
  });

  const propsOf = (target: string, values: any, times: number[]) => {
    const roles = target === "corner_pin" ? ["ul", "ur", "ll", "lr"] : ["anchor", "position", "rotation", "scale"];
    return roles.map((r) => ({ role: r, name: r, numKeys: times.length - (opts.breakKeys && r === "rotation" ? 1 : 0) }));
  };

  const host = new PanelHost({
    evalScript: async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      const args = JSON.parse(script.slice(script.indexOf("(") + 1, script.lastIndexOf(")")));
      calls.push({ fn, args });
      const ok = (result: unknown) => ({ ok: true, result, durationMs: 1 });
      if (fn === "checkGuard") return ok({ ok: true, project_path: "<unsaved>", comp_id: 1, comp_is_valid: true });
      if (fn === "stabilizeInspect") {
        opts.onInspect?.();
        return ok(inspect());
      }
      if (fn === "snapshotFrame") {
        if (opts.failRenders && applied) throw new Error("render failed");
        if (opts.failRigRenders === "before" && !rig) throw new Error("before render failed");
        if (opts.failRigRenders === "after" && rig) throw new Error("after render failed");
        const k = Math.round(args.time * 10);
        fs.mkdirSync(path.dirname(args.output_path), { recursive: true });
        fs.writeFileSync(args.output_path, PNG.sync.write(render(k)));
        return ok({ path: args.output_path, time: args.time });
      }
      if (fn === "stabilizeApply") {
        applied = { target: args.target, times: args.times, values: args.values, tile: args.tile ?? null, args };
        const props = propsOf(args.target, args.values, args.times);
        const tile = args.tile ? { name: "Stabilize Tile", index: opts.tileIndex ?? 1, output_w_pct: args.tile.output_w_pct, output_h_pct: args.tile.output_h_pct, clamped: false, mirror_edges: !opts.paramsMissing, param_table: [] } : null;
        const mainIndex = tile ? 2 : 1;
        const written =
          args.target === "layer_transform"
            ? [{ layer_index: args.layer.index, layer_id: args.layer.id, target: "transform", props }]
            : [{ layer_index: args.layer.index, layer_id: args.layer.id, target: args.target === "corner_pin" ? "corner_pin" : "transform_effect", effect_index: mainIndex, props }];
        return ok({
          layer_index: args.layer.index,
          layer_id: args.layer.id,
          target: args.target,
          written,
          tile,
          effect: args.target === "transform_effect" ? { name: "Stabilize Transform", index: mainIndex, uniform_scale_on: !opts.paramsMissing, sampling: args.bicubic ? { set: !opts.paramsMissing, value: 2 } : null, shutter: args.shutter_angle !== undefined ? { set: !opts.paramsMissing, angle: args.shutter_angle } : null, props, param_table: [] } : null,
          order: tile ? { checked: true, ok: true, moved: false } : null,
          flags: { bicubic: args.bicubic ? true : null, motion_blur: args.motion_blur ? true : null, comp_motion_blur: args.comp_motion_blur ? true : null },
        });
      }
      if (fn === "stabilizeReadBack") {
        if (opts.failAfterRead && applied) throw new Error("AE stopped answering");
        if (!applied) return ok({ items: [{ layer_id: args.layer_id, found: true, props: [] }], flags: null, tile: null, effects: [] });
        const v = applied.values;
        const props = Object.keys(v).map((role) => ({
          role,
          numKeys: applied.times.length - (opts.breakKeys && role === "rotation" ? 1 : 0),
          samples: args.times.map((t: number) => {
            const i = applied.times.findIndex((x: number) => Math.abs(x - t) < 1e-6);
            const val = v[role][i];
            return { time: t, value: role === "scale" && applied.target === "transform_effect" ? val[0] : val };
          }),
        }));
        return ok({
          items: [{ layer_id: args.layer_id, found: true, props }],
          flags: { bicubic: applied.args.bicubic ? true : null, motion_blur: applied.args.motion_blur ? true : null, comp_motion_blur: null },
          tile: applied.tile ? { found: true, index: opts.tileIndex ?? 1, output_w_pct: applied.tile.output_w_pct, output_h_pct: applied.tile.output_h_pct, mirror_edges: 1 } : null,
          sampling: applied.target === "transform_effect" && applied.args.bicubic ? 2 : null,
          effects: applied.tile
            ? opts.tileBehind
              ? [{ index: 1, name: "Stabilize Transform", matchName: "ADBE Geometry2" }, { index: 2, name: "Stabilize Tile", matchName: "ADBE Tile" }]
              : [{ index: 1, name: "Stabilize Tile", matchName: "ADBE Tile" }, { index: 2, name: "Stabilize Transform", matchName: applied.target === "corner_pin" ? "ADBE Corner Pin" : "ADBE Geometry2" }]
            : [],
        });
      }
      if (fn === "stabilizeRigBuild") {
        rig = args;
        const inner = args.inner;
        const outer = args.outer;
        const mk = (half: any, layerId: number) => ({
          layer_id: layerId,
          layer_index: 1,
          target: half.target,
          ...(half.target === "corner_pin" ? { effect_index: 1 } : {}),
          props: propsOf(half.target, half.values, half.times),
        });
        return ok({
          work_comp: { id: WORK_ID, name: args.name, width: args.width, height: args.height, duration: 1, fps: 10 },
          inner: { layer_id: 1, layer_index: 1, written: [mk(inner, 1)], guide: args.guide_mode === "guide_layer" },
          outer: { layer_id: 201, layer_index: 1, written: [mk(outer, 201)] },
          plate: { id: args.plate.id, index: 2 },
          flags: { bicubic: true, frame_blending_off: true, motion_blur: args.motion_blur ? true : null, comp_motion_blur: args.comp_motion_blur ? true : null, guide_audio_off: !opts.audioStays },
          guide_mode: args.guide_mode,
          order_ok: true,
        });
      }
      if (fn === "stabilizeRigRead") {
        const built = rig && !removed;
        const keyItems = (half: any, layerId: number, times: number[]) => {
          const v = half.values;
          return [
            {
              layer_id: layerId,
              found: true,
              props: Object.keys(v).map((role) => ({
                role,
                numKeys: half.times.length,
                samples: times.map((t) => ({ time: t, value: v[role][half.times.findIndex((x: number) => Math.abs(x - t) < 1e-6)] })),
              })),
            },
          ];
        };
        return ok({
          comp: { id: 1, num_layers: built ? 2 : 1, motion_blur: false },
          outer: built ? { found: true, index: 1, id: 201, name: rig.layer_name, source_id: WORK_ID, marker_ok: true, motion_blur: true, bicubic: true, frame_blending_off: true } : { found: false },
          plate: { found: true, index: built ? 2 : 1, id: 100, name: "Plate" },
          work: built
            ? { found: true, id: WORK_ID, name: rig.name, width: rig.width, height: rig.height, num_layers: 1, layers: [{ index: 1, id: 1, name: "Plate", guide: rig.guide_mode === "guide_layer", audio: !!opts.audioStays, marker: "guide" }] }
            : args.work_comp_id !== undefined
              ? { found: false, id: args.work_comp_id }
              : null,
          keys: (args.keys ?? []).map((k: any) => ({ tag: k.tag, items: keyItems(k.tag === "inner" ? rig.inner : rig.outer, k.layer_id, k.times) })),
        });
      }
      if (fn === "stabilizeRigRemove") {
        removed = true;
        return ok({ outer_id: 201, outer_name: "Plate STAB", work_comp_id: WORK_ID, work_comp_name: "Plate STAB", layers_deleted: 1, patches: 0 });
      }
      throw new Error(`Unexpected script: ${script}`);
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge: host, queue, quarantine };
  return { ctx, calls, fns: () => calls.map((c) => c.fn), getApplied: () => applied, getRig: () => rig, markBuilt: () => (rig = { name: "Plate STAB", layer_name: "Plate STAB", width: 1, height: 1, guide_mode: "guide_layer" }) };
}

type Out = Record<string, any>;
const stab = (extra: Record<string, unknown> = {}) =>
  AeStabilizeSchema.parse({ comp_id: 1, layer: { index: 1 }, track: { track_id: "trk_tool" }, expect: expectArg, ...extra });

describe("ae_stabilize", () => {
  beforeAll(() => {
    makeTrack("trk_tool");
    makeTrack("trk_tool_pin", "perspective");
  });

  it("locks the plate: guard, before sheet, write, separate read-back, residual under half a pixel", async () => {
    const { ctx, calls, fns, getApplied } = fakeAe();
    const out = (await tool("ae_stabilize").handler(stab(), ctx)) as Out;
    expect(out.ok).toBe(true);
    expect(out.applied).toBe(true);
    expect(out.target).toBe("layer_transform");
    expect(out.mode).toBe("lock");
    expect(out.frames_written).toBe(10);
    expect(out.ref_time).toBe(0.5);
    // inspect, the before sheet's renders, guard, before read, write, after read, then the after renders.
    const order = fns();
    expect(order[0]).toBe("stabilizeInspect");
    expect(order.indexOf("snapshotFrame")).toBeLessThan(order.indexOf("checkGuard"));
    expect(order.indexOf("checkGuard")).toBeLessThan(order.indexOf("stabilizeApply"));
    const apply = order.indexOf("stabilizeApply");
    expect(order[apply - 1]).toBe("stabilizeReadBack");
    expect(order[apply + 1]).toBe("stabilizeReadBack");
    expect(order.slice(apply + 2).every((f) => f === "snapshotFrame")).toBe(true);
    expect(out.receipt.mismatches).toEqual([]);
    expect(out.receipt.matches).toBe(true);
    // The pivot's Position is held on every key; the keys went to the layer, linear, with bicubic.
    const w = calls.find((c) => c.fn === "stabilizeApply")!.args;
    expect(w).toMatchObject({ target: "layer_transform", layer: { index: 1, id: 100 }, replace_keys: false, bicubic: true, motion_blur: false });
    for (const p of w.values.position) close(p, [121, 80], 0.01);
    expect(w.expect).toMatchObject(expectArg);
    expect(getApplied().times).toHaveLength(10);
    // The correction really steadies the picture: found again on the stabilized renders within half a pixel.
    expect(out.residual.rms_px).toBeLessThan(0.5);
    expect(out.residual.meets_target).toBe(true);
    expect(out.residual.points_used).toHaveLength(5);
    expect(out.residual.frames_measured).toBeGreaterThanOrEqual(6);
    expect(out.residual.target_px).toBe(0.5);
    expect(fs.existsSync(out.before_sheet_path)).toBe(true);
    expect(fs.existsSync(out.after_sheet_path)).toBe(true);
    expect(out.notes.join(" ")).toMatch(/ae_stabilize_roundtrip/);
    // The track was stored for the next tool.
    expect(out.track_id).toBe("trk_tool");
  }, 60000);

  it("smooth keeps the shot's motion; the residual is measured against the smoothed path", async () => {
    const { ctx } = fakeAe();
    const out = (await tool("ae_stabilize").handler(stab({ mode: "smooth", smooth_frames: 2 }), ctx)) as Out;
    expect(out.ok).toBe(true);
    expect(out.mode).toBe("smooth");
    expect(out.residual.rms_px).toBeLessThan(0.7);
    expect(out.residual.target_px).toBeNull();
    expect(out.residual.meets_target).toBeNull();
    expect(out.receipt.matches).toBe(true);
  }, 60000);

  it("position_only takes out the pivot's translation only", async () => {
    const { ctx, calls } = fakeAe();
    const out = (await tool("ae_stabilize").handler(stab({ mode: "position_only", verify: false, sheets: false }), ctx)) as Out;
    expect(out.ok).toBe(true);
    const w = calls.find((c) => c.fn === "stabilizeApply")!.args;
    for (const r of w.values.rotation) expect(r).toBeCloseTo(0, 6);
    for (const s of w.values.scale) close(s, [100, 100], 1e-6);
    expect(calls.some((c) => c.fn === "snapshotFrame")).toBe(false);
    expect(out.residual).toBeUndefined();
  });

  it("scale_to_fill folds the zoom in, and the picture is still steady", async () => {
    const { ctx, calls } = fakeAe();
    const out = (await tool("ae_stabilize").handler(stab({ edges: "scale_to_fill", pivot: [20, 20] }), ctx)) as Out;
    expect(out.ok).toBe(true);
    expect(out.zoom).toBeGreaterThan(1.05);
    expect(out.residual.rms_px).toBeLessThan(0.5);
    const w = calls.find((c) => c.fn === "stabilizeApply")!.args;
    expect(w.tile).toBeUndefined();
    // Position is no longer the pivot itself: it is zoomed about the comp centre.
    expect(dist(w.values.position[0], [20, 20])).toBeGreaterThan(5);
    // And the zoomed plate does cover the comp.
    expect(out.notes.join(" ")).toMatch(/zoomed/);
  }, 60000);

  it("motion_tile adds the tile before the stabilizing and checks it in the receipt", async () => {
    const { ctx, calls } = fakeAe();
    const out = (await tool("ae_stabilize").handler(stab({ edges: "motion_tile", verify: false, sheets: false, target: "transform_effect" }), ctx)) as Out;
    expect(out.ok).toBe(true);
    const w = calls.find((c) => c.fn === "stabilizeApply")!.args;
    expect(w.tile.output_w_pct).toBeGreaterThan(100);
    expect(w.tile.wanted).toEqual(TILE_FX_PARAMS);
    expect(w.effect_wanted).toEqual(TRANSFORM_FX_PARAMS);
    expect(out.motion_tile.name).toBe("Stabilize Tile");
    expect(out.motion_tile.extents_px.left).toBeGreaterThanOrEqual(0);
    expect(out.receipt.matches).toBe(true);
    expect(out.notes.join(" ")).toMatch(/Motion Tile's parameters/);
    // The read-back asked for the tile and the effect by the indexes the write reported.
    const after = calls.filter((c) => c.fn === "stabilizeReadBack").pop()!.args;
    expect(after).toMatchObject({ kind: "transform_effect", effect_index: 2, tile_index: 1 });
  });

  it("transform_effect: no before read (the effect does not exist), the shutter angle goes through", async () => {
    const { ctx, calls, fns } = fakeAe();
    const out = (await tool("ae_stabilize").handler(stab({ target: "transform_effect", shutter_angle: 180, verify: false, sheets: false }), ctx)) as Out;
    expect(out.ok).toBe(true);
    expect(fns().filter((f) => f === "stabilizeReadBack")).toHaveLength(1);
    expect(calls.find((c) => c.fn === "stabilizeApply")!.args.shutter_angle).toBe(180);
    expect(out.receipt.matches).toBe(true);
    expect(out.written[0]).toMatchObject({ target: "transform_effect" });
  });

  it("corner_pin for a perspective track, and the picture is steady through the pin", async () => {
    const { ctx, calls } = fakeAe();
    const out = (await tool("ae_stabilize").handler(stab({ track: { track_id: "trk_tool_pin" } }), ctx)) as Out;
    expect(out.ok).toBe(true);
    expect(out.target).toBe("corner_pin");
    const w = calls.find((c) => c.fn === "stabilizeApply")!.args;
    expect(Object.keys(w.values).sort()).toEqual(["ll", "lr", "ul", "ur"]);
    expect(out.residual.rms_px).toBeLessThan(0.6);
    expect(out.receipt.matches).toBe(true);
    expect(out.notes.join(" ")).toMatch(/no layer motion blur/);
  }, 60000);

  it("refuses before the guard when the plate cannot be stabilized", async () => {
    for (const [layer, re] of [
      [{ locked: true }, /locked/],
      [{ parent: { index: 2, id: 9, name: "Rig" } }, /parent/],
      [{ three_d: true }, /3D/],
    ] as const) {
      const ae = fakeAe({ layer });
      const out = (await tool("ae_stabilize").handler(stab(), ae.ctx)) as Out;
      expect(out).toMatchObject({ ok: false, error: "refused" });
      expect(out.message).toMatch(re);
      expect(ae.fns()).not.toContain("checkGuard");
      expect(ae.fns()).not.toContain("stabilizeApply");
    }
    const keyed = fakeAe({ inspect: { keys: { anchor: 0, position: 4, scale: 0, rotation: 0 } } });
    expect(await tool("ae_stabilize").handler(stab(), keyed.ctx)).toMatchObject({ ok: false, error: "refused" });
    const replaced = (await tool("ae_stabilize").handler(stab({ replace_keys: true, verify: false, sheets: false }), keyed.ctx)) as Out;
    expect(replaced.ok).toBe(true);
    expect(keyed.calls.find((c) => c.fn === "stabilizeApply")!.args.replace_keys).toBe(true);
  });

  it("refuses a zoom over max_zoom, a missing track and a reference frame the track did not solve", async () => {
    const ae = fakeAe();
    expect(await tool("ae_stabilize").handler(stab({ edges: "scale_to_fill", max_zoom: 1.02 }), ae.ctx)).toMatchObject({ ok: false, error: "refused" });
    expect(await tool("ae_stabilize").handler(stab({ track: { track_id: "trk_missing" } }), ae.ctx)).toMatchObject({ ok: false, error: "not_found" });
    const t = makeTrack("trk_tool_holey");
    t.frames[5] = { ...t.frames[5], ok: false, H: null };
    saveTrack(t);
    expect(await tool("ae_stabilize").handler(stab({ track: { track_id: "trk_tool_holey" } }), ae.ctx)).toMatchObject({ ok: false, error: "bad_args" });
    expect(ae.fns()).not.toContain("stabilizeApply");
  });

  it("re-bases to ref_time", async () => {
    const { ctx, calls } = fakeAe();
    const out = (await tool("ae_stabilize").handler(stab({ ref_time: 0.2, verify: false, sheets: false }), ctx)) as Out;
    expect(out.ref_time).toBe(0.2);
    expect(calls.find((c) => c.fn === "stabilizeInspect")!.args.ref_time).toBe(0.2);
    const w = calls.find((c) => c.fn === "stabilizeApply")!.args;
    // At the new reference the correction is the identity: Position is the pivot, Rotation 0.
    const i = w.times.indexOf(0.2);
    expect(w.values.rotation[i]).toBeCloseTo(0, 6);
  });

  it("a range writes only those frames; the rest are not counted as skipped", async () => {
    const { ctx, calls } = fakeAe();
    const out = (await tool("ae_stabilize").handler(stab({ range: { start: 0.3, end: 0.6 }, verify: false, sheets: false }), ctx)) as Out;
    expect(calls.find((c) => c.fn === "stabilizeApply")!.args.times).toEqual([0.3, 0.4, 0.5, 0.6]);
    expect(out.frames_skipped).toBeUndefined();
  });

  it("puts a key count the host disagrees with into the receipt, never an error", async () => {
    const { ctx } = fakeAe({ breakKeys: true });
    const out = (await tool("ae_stabilize").handler(stab({ verify: false, sheets: false }), ctx)) as Out;
    expect(out.applied).toBe(true);
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches.map((m: any) => m.path)).toContain("100.rotation.numKeys");
  });

  it("keeps a failed read-back out of the error path once the write is in", async () => {
    const { ctx } = fakeAe({ failAfterRead: true });
    const out = (await tool("ae_stabilize").handler(stab({ verify: false, sheets: false }), ctx)) as Out;
    expect(out.applied).toBe(true);
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches[0].message).toMatch(/Do not resend/);
  });

  it("a render that fails after the write leaves the result intact and says why", async () => {
    const { ctx } = fakeAe({ failRenders: true });
    const out = (await tool("ae_stabilize").handler(stab(), ctx)) as Out;
    expect(out.applied).toBe(true);
    expect(out.receipt.matches).toBe(true);
    expect(out.verify_error).toMatch(/render failed/);
    expect(out.residual).toBeUndefined();
  }, 60000);

  it("stops at the render budget and says what it could not do", async () => {
    const { ctx, calls } = fakeAe();
    const out = (await tool("ae_stabilize").handler(stab({ max_renders: 3 }), ctx)) as Out;
    expect(out.applied).toBe(true);
    expect(out.budget.renders_used).toBe(3);
    expect(calls.filter((c) => c.fn === "snapshotFrame")).toHaveLength(3);
    // The reference frame did not fit in the budget, or the sheet is partial: either way it says so.
    expect(out.verify_error ?? out.sheet_error).toMatch(/max_renders|budget/);
  }, 60000);

  it("transform_effect: the effect's own Sampling is asked for and read back as Bicubic", async () => {
    const { ctx, calls } = fakeAe();
    const out = (await tool("ae_stabilize").handler(stab({ target: "transform_effect", verify: false, sheets: false }), ctx)) as Out;
    expect(calls.find((c) => c.fn === "stabilizeApply")!.args.effect_wanted.sampling).toEqual({ names: ["Sampling"], index: 12 });
    expect(out.receipt.matches).toBe(true);
    expect(out.notes.join(" ")).not.toMatch(/Sampling popup was not found/);
  });

  it("says so, in the receipt and the notes, when the host could not set what was asked for", async () => {
    const ae = fakeAe({ paramsMissing: true });
    const out = (await tool("ae_stabilize").handler(stab({ target: "transform_effect", shutter_angle: 180, edges: "motion_tile", verify: false, sheets: false }), ae.ctx)) as Out;
    expect(out.applied).toBe(true);
    expect(out.receipt.matches).toBe(false);
    const paths = out.receipt.mismatches.map((m: any) => m.path);
    expect(paths).toEqual(expect.arrayContaining(["effect.uniform_scale_on", "effect.shutter", "effect.sampling", "tile.mirror_edges"]));
    const notes = out.notes.join(" ");
    expect(notes).toMatch(/Uniform Scale was not switched on/);
    expect(notes).toMatch(/shutter_angle 180 was NOT applied/);
    expect(notes).toMatch(/Sampling popup was not found/);
    expect(notes).toMatch(/Mirror Edges was NOT switched on/);
  });

  it("checks the effect order from the read-back, not only from the host's own check", async () => {
    const ok = (await tool("ae_stabilize").handler(stab({ target: "transform_effect", edges: "motion_tile", verify: false, sheets: false }), fakeAe().ctx)) as Out;
    expect(ok.receipt.mismatches.map((m: any) => m.path)).not.toContain("effects.order");
    const bad = (await tool("ae_stabilize").handler(stab({ target: "transform_effect", edges: "motion_tile", verify: false, sheets: false }), fakeAe({ tileBehind: true }).ctx)) as Out;
    expect(bad.applied).toBe(true);
    expect(bad.receipt.mismatches.map((m: any) => m.path)).toContain("effects.order");
  });

  it("changes nothing in AE before the guard: the reads are reads", async () => {
    const { ctx, calls } = fakeAe();
    await tool("ae_stabilize").handler(stab({ verify: false, sheets: false }), ctx);
    const beforeWrite = calls.slice(0, calls.findIndex((c) => c.fn === "stabilizeApply"));
    expect(beforeWrite.map((c) => c.fn)).toEqual(["stabilizeInspect", "checkGuard", "stabilizeReadBack"]);
  });
});

describe("stabilizeMismatches", () => {
  const expected = [{ layerId: 7, kind: "transform" as const, role: "position", keys: 2, samples: [{ time: 0, value: [10, 20] }, { time: 0.1, value: [11, 21] }] }];
  const written = { written: [{ layer_index: 1, layer_id: 7, target: "transform", props: [{ role: "position", name: "Position", numKeys: 2 }] }] };
  const after = { items: [{ layer_id: 7, found: true, props: [{ role: "position", numKeys: 2, samples: [{ time: 0, value: [10, 20, 0] }, { time: 0.1, value: [11, 21, 0] }] }] }], flags: { bicubic: false, motion_blur: false, comp_motion_blur: null } };

  it("flags a layer left on the wrong sampling, a motion blur that is off, and a tile out of place", () => {
    const m = stabilizeMismatches({ expected, bicubic: true, motionBlur: true, tile: null }, written as any, after as any);
    expect(m.map((x) => x.path)).toEqual(["flags.bicubic", "flags.motion_blur"]);
    const tileMiss = stabilizeMismatches(
      { expected, bicubic: false, motionBlur: undefined, tile: { output_w_pct: 112, output_h_pct: 104, extents: { left: 1, right: 1, top: 0, bottom: 0, needed: true } } },
      { ...written, tile: { name: "t", index: 1, output_w_pct: 112, output_h_pct: 104, clamped: false, mirror_edges: true }, order: { checked: true, ok: false, moved: true } } as any,
      { ...after, tile: { found: true, index: 1, output_w_pct: 100, output_h_pct: 104 } } as any
    );
    expect(tileMiss.map((x) => x.path)).toEqual(["tile.output_w_pct", "effect_order"]);
  });

  it("checks the effect order, Sampling, Uniform Scale, shutter, Mirror Edges and the comp's motion blur against the read-back", () => {
    const tile = { output_w_pct: 112, output_h_pct: 104, extents: { left: 1, right: 1, top: 0, bottom: 0, needed: true } };
    const w = {
      ...written,
      tile: { name: "Stabilize Tile", index: 1, output_w_pct: 112, output_h_pct: 104, clamped: false, mirror_edges: true },
      effect: { name: "Stabilize Transform", index: 2, uniform_scale_on: true, sampling: { set: true, value: 2 }, shutter: { set: true, angle: 90 } },
      order: { checked: true, ok: true, moved: false },
    };
    const read = (over: Record<string, unknown>) => ({
      ...after,
      flags: { bicubic: true, motion_blur: true, comp_motion_blur: true },
      tile: { found: true, index: 1, output_w_pct: 112, output_h_pct: 104, mirror_edges: 1 },
      sampling: 2,
      effects: [
        { index: 1, name: "Stabilize Tile", matchName: "ADBE Tile" },
        { index: 2, name: "Stabilize Transform", matchName: "ADBE Geometry2" },
      ],
      ...over,
    });
    const run = (writtenOver: Record<string, unknown>, readOver: Record<string, unknown>) =>
      stabilizeMismatches({ expected, bicubic: true, motionBlur: true, tile, target: "transform_effect", shutterAngle: 90 }, { ...w, ...writtenOver } as any, read(readOver) as any).map((x) => x.path);
    expect(run({}, {})).toEqual([]);
    expect(
      run({}, {
        effects: [
          { index: 1, name: "Stabilize Transform", matchName: "ADBE Geometry2" },
          { index: 2, name: "Stabilize Tile", matchName: "ADBE Tile" },
        ],
      })
    ).toEqual(["effects.order"]);
    expect(run({}, { sampling: 1 })).toEqual(["effect.sampling.value"]);
    expect(run({}, { flags: { bicubic: true, motion_blur: true, comp_motion_blur: false } })).toEqual(["flags.comp_motion_blur"]);
    expect(run({}, { tile: { found: true, index: 1, output_w_pct: 112, output_h_pct: 104, mirror_edges: 0 } })).toEqual(["tile.mirror_edges.read"]);
    expect(run({ effect: { ...w.effect, uniform_scale_on: false } }, {})).toEqual(["effect.uniform_scale_on"]);
    expect(run({ effect: { ...w.effect, shutter: { set: false, angle: 90 } } }, {})).toEqual(["effect.shutter"]);
    expect(run({ effect: { ...w.effect, sampling: { set: false, value: 2 } } }, {})).toEqual(["effect.sampling"]);
    expect(run({ tile: { ...w.tile, mirror_edges: false } }, {})).toEqual(["tile.mirror_edges"]);
    // A Corner Pin is the main effect for that target.
    const pinOrder = stabilizeMismatches(
      { expected, bicubic: false, motionBlur: undefined, tile, target: "corner_pin" },
      { ...w, effect: null } as any,
      read({
        effects: [
          { index: 1, name: "Corner Pin", matchName: "ADBE Corner Pin" },
          { index: 2, name: "Stabilize Tile", matchName: "ADBE Tile" },
        ],
        flags: undefined,
      }) as any
    ).map((x) => x.path);
    expect(pinOrder).toEqual(["effects.order"]);
  });

  it("is quiet when everything matches, and when the read-back is missing", () => {
    expect(stabilizeMismatches({ expected, bicubic: false, motionBlur: undefined, tile: null }, written as any, after as any)).toEqual([]);
    expect(stabilizeMismatches({ expected, bicubic: true, motionBlur: true, tile: null }, written as any, null)).toEqual([]);
  });
});

describe("ae_stabilize_roundtrip", () => {
  const rt = (extra: Record<string, unknown> = {}) =>
    AeStabilizeRoundtripSchema.parse({ comp_id: 1, plate: { index: 1 }, track: { track_id: "trk_tool" }, expect: expectArg, pad_px: 20, ...extra });

  it("builds the rig: guard, before sheet, write, separate read-back, an exact inverse and an after sheet", async () => {
    const { ctx, calls, fns } = fakeAe();
    const out = (await tool("ae_stabilize_roundtrip").handler(rt(), ctx)) as Out;
    expect(out.ok).toBe(true);
    expect(out.applied).toBe(true);
    expect(out.action).toBe("build");
    const order = fns();
    expect(order[0]).toBe("stabilizeInspect");
    expect(order.indexOf("snapshotFrame")).toBeLessThan(order.indexOf("checkGuard"));
    const build = order.indexOf("stabilizeRigBuild");
    expect(order[build - 1]).toBe("stabilizeRigRead");
    expect(order[build + 1]).toBe("stabilizeRigRead");
    expect(order.slice(build + 2).every((f) => f === "snapshotFrame")).toBe(true);
    expect(out.receipt.mismatches).toEqual([]);
    expect(out.receipt.matches).toBe(true);
    expect(out.rig_kind).toBe("transform");
    expect(out.roundtrip_error_px).toBeLessThan(0.01);
    expect(out.pad_px).toBe(20);
    expect(out.work_comp).toMatchObject({ id: WORK_ID, name: "Plate STAB", width: W + 40, height: H + 40 });
    const w = calls.find((c) => c.fn === "stabilizeRigBuild")!.args;
    expect(w).toMatchObject({ comp_id: 1, plate: { index: 1, id: 100 }, name: "Plate STAB", layer_name: "Plate STAB", width: W + 40, height: H + 40, copy_effects: false, guide_mode: "guide_layer", motion_blur: true, comp_motion_blur: false });
    expect(w.marker).toEqual({ pad: 20, ref_time: 0.5, track_id: "trk_tool" });
    expect(w.inner.times).toEqual(w.outer.times);
    expect(w.inner.times).toHaveLength(10);
    expect(w.expect).toMatchObject(expectArg);
    // The guide plate must not change the picture: the after frames equal the before frames.
    expect(out.picture_change.every((p: any) => p.mean_abs_diff === 0)).toBe(true);
    expect(fs.existsSync(out.before_sheet_path)).toBe(true);
    expect(fs.existsSync(out.after_sheet_path)).toBe(true);
    expect(out.how_to_use.join(" ")).toMatch(/SEPARATE layers above the guide plate/);
    expect(out.notes.join(" ")).toMatch(/LIVE CHECK/);
    // The marker holds what other tools need.
    expect(out.outer_layer).toMatchObject({ id: 201 });
  }, 60000);

  it("reads picture_change as the guide-plate signal: 0 everywhere is fine, a change away from the reference is flagged", async () => {
    const good = (await tool("ae_stabilize_roundtrip").handler(rt(), fakeAe().ctx)) as Out;
    expect(good.guide_plate_renders_suspected).toBe(false);
    expect(good.notes.join(" ")).toMatch(/picture_change[^.]*must be 0 at every frame/);
    expect(good.notes.join(" ")).not.toMatch(/the plate shows doubled/);
    const bad = (await tool("ae_stabilize_roundtrip").handler(rt(), fakeAe({ guideRenders: true }).ctx)) as Out;
    expect(bad.applied).toBe(true);
    expect(bad.guide_plate_renders_suspected).toBe(true);
    expect(bad.notes.join(" ")).toMatch(/guide plate probably renders[\s\S]*opacity_switch/);
    // The reference frame itself stays identical, as the identity correction does.
    expect(bad.picture_change.find((p: any) => p.time === 0.5).mean_abs_diff).toBe(0);
    // A budget too small to render any frame away from the reference leaves the flag out and says it was not measured.
    for (const max_renders of [3, 4]) {
      const tiny = (await tool("ae_stabilize_roundtrip").handler(rt({ max_renders }), fakeAe({ guideRenders: true }).ctx)) as Out;
      if (tiny.guide_plate_renders_suspected !== undefined) expect(tiny.picture_change.some((p: any) => p.time !== 0.5 && p.mean_abs_diff !== null)).toBe(true);
      else expect(tiny.notes.join(" ")).toMatch(/guide-plate check was not measured/);
    }
    const tiny3 = (await tool("ae_stabilize_roundtrip").handler(rt({ max_renders: 3 }), fakeAe().ctx)) as Out;
    expect(tiny3.guide_plate_renders_suspected).toBeUndefined();
    const noSheet = (await tool("ae_stabilize_roundtrip").handler(rt({ sheet: false }), fakeAe().ctx)) as Out;
    expect(noSheet.guide_plate_renders_suspected).toBeUndefined();
  }, 60000);

  it("the LIVE CHECK note agrees with the flag's threshold: a small nonzero change is not called proof", async () => {
    const out = (await tool("ae_stabilize_roundtrip").handler(rt({ sheet: false }), fakeAe().ctx)) as Out;
    const note = out.notes.find((n: string) => n.startsWith("LIVE CHECK")) as string;
    expect(note).toContain(`above ${GUIDE_DIFF_THRESHOLD}`);
    expect(note).toMatch(/guide_plate_renders_suspected/);
    expect(note).toMatch(/smaller nonzero value[^.]*not proof/);
    expect(note).not.toMatch(/nonzero mean_abs_diff at a frame away from the reference means/);
  });

  it("says the guide-plate check was not measured whenever the flag is left out, not only when the after frames were compared", async () => {
    const notMeasured = /guide-plate check was not measured/;
    // A before render that throws.
    const beforeFail = (await tool("ae_stabilize_roundtrip").handler(rt(), fakeAe({ failRigRenders: "before" }).ctx)) as Out;
    expect(beforeFail.applied).toBe(true);
    expect(beforeFail.sheet_error).toMatch(/before render failed/);
    expect(beforeFail.guide_plate_renders_suspected).toBeUndefined();
    expect(beforeFail.notes.join(" ")).toMatch(notMeasured);
    // An after render that throws.
    const afterFail = (await tool("ae_stabilize_roundtrip").handler(rt(), fakeAe({ failRigRenders: "after" }).ctx)) as Out;
    expect(afterFail.applied).toBe(true);
    expect(afterFail.sheet_error).toMatch(/after render failed/);
    expect(afterFail.guide_plate_renders_suspected).toBeUndefined();
    expect(afterFail.notes.join(" ")).toMatch(notMeasured);
    // A budget whose seconds ran out before the first before frame: no frame at all, and the result says why.
    const realNow = Date.now.bind(Date);
    let skew = 0;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew);
    try {
      const ae = fakeAe({ onInspect: () => (skew = 1_000_000) });
      const spent = (await tool("ae_stabilize_roundtrip").handler(rt(), ae.ctx)) as Out;
      expect(spent.applied).toBe(true);
      expect(ae.calls.filter((c) => c.fn === "snapshotFrame")).toHaveLength(0);
      expect(spent.picture_change).toBeUndefined();
      expect(spent.guide_plate_renders_suspected).toBeUndefined();
      expect(spent.sheet_error).toMatch(/budget ran out before the first sheet frame/);
      expect(spent.notes.join(" ")).toMatch(notMeasured);
    } finally {
      spy.mockRestore();
    }
    // With the sheet off the check was never asked for: no note.
    const noSheet = (await tool("ae_stabilize_roundtrip").handler(rt({ sheet: false }), fakeAe().ctx)) as Out;
    expect(noSheet.notes.join(" ")).not.toMatch(notMeasured);
    // A clean run measures it and says nothing of the kind.
    const clean = (await tool("ae_stabilize_roundtrip").handler(rt(), fakeAe().ctx)) as Out;
    expect(clean.notes.join(" ")).not.toMatch(notMeasured);
  }, 60000);

  it("how_to_use names the real arguments of ae_cleanplate_setup and ae_inpaint_plate, with the work comp's ids", async () => {
    const out = (await tool("ae_stabilize_roundtrip").handler(rt({ sheet: false }), fakeAe().ctx)) as Out;
    const how = out.how_to_use.join(" ");
    expect(how).not.toMatch(/target_comp/);
    expect(how).toContain("ae_cleanplate_setup (comp_id " + WORK_ID + ", plate {id: 1}");
    expect(how).toContain("place_in_comp {comp_id: " + WORK_ID + "}");
    expect(how).toMatch(/Show Stabilized Plate/);
  });

  it("puts a plate copy whose audio is still on into the receipt, and says when it could not be muted", async () => {
    const stays = (await tool("ae_stabilize_roundtrip").handler(rt({ sheet: false }), fakeAe({ audioStays: true }).ctx)) as Out;
    expect(stays.notes.join(" ")).toMatch(/audio could not be muted/);
    const ae = fakeAe();
    const host = ae.ctx.bridge as any;
    const orig = host.evalRaw.bind(host);
    host.evalRaw = async (p: any) => {
      const res = await orig(p);
      if (p.script.includes("stabilizeRigRead") && p.script.includes('"keys"') && res.result?.work?.layers) res.result.work.layers[0].audio = true;
      return res;
    };
    const out = (await tool("ae_stabilize_roundtrip").handler(rt({ sheet: false }), ae.ctx)) as Out;
    expect(out.receipt.mismatches.map((m: any) => m.path)).toContain("work.guide_plate.audio");
  });

  it("a perspective track gets two Corner Pins and a warning, no motion blur", async () => {
    const { ctx, calls } = fakeAe();
    const out = (await tool("ae_stabilize_roundtrip").handler(rt({ track: { track_id: "trk_tool_pin" }, sheet: false }), ctx)) as Out;
    expect(out.rig_kind).toBe("corner_pin");
    expect(out.roundtrip_error_px).toBeNull();
    expect(out.receipt.matches).toBe(true);
    const w = calls.find((c) => c.fn === "stabilizeRigBuild")!.args;
    expect(w.inner.target).toBe("corner_pin");
    expect(w.outer.target).toBe("corner_pin");
    expect(w.motion_blur).toBe(false);
    expect(out.notes.join(" ")).toMatch(/two Corner Pins/);
  });

  it("passes the options on: name, copy_effects, opacity_switch, motion blur off", async () => {
    const { ctx, calls } = fakeAe({ inspect: { num_effects: 1, effects: [{ index: 1, name: "Curves", matchName: "ADBE CurvesCustom" }] } });
    const out = (await tool("ae_stabilize_roundtrip").handler(rt({ name: "Shot A STAB", copy_effects: true, guide_mode: "opacity_switch", motion_blur: false, sheet: false }), ctx)) as Out;
    expect(out.ok).toBe(true);
    const w = calls.find((c) => c.fn === "stabilizeRigBuild")!.args;
    expect(w).toMatchObject({ name: "Shot A STAB", copy_effects: true, guide_mode: "opacity_switch", motion_blur: false });
    expect(out.notes.join(" ")).toMatch(/Show Stabilized Plate/);
    expect(out.receipt.matches).toBe(true);
  });

  it("refuses a plate with effects, a time remap or keys before the guard", async () => {
    for (const [opts, re] of [
      [{ inspect: { num_effects: 1 } }, /copy_effects/],
      [{ layer: { time_remap: true } }, /Time Remap/],
      [{ inspect: { keys: { anchor: 0, position: 2, scale: 0, rotation: 0 } } }, /still transform/],
      [{ layer: { source_id: null } }, /no source/],
    ] as const) {
      const ae = fakeAe(opts as AeOpts);
      const out = (await tool("ae_stabilize_roundtrip").handler(rt({ sheet: false }), ae.ctx)) as Out;
      expect(out).toMatchObject({ ok: false, error: "refused" });
      expect(out.message).toMatch(re);
      expect(ae.fns()).not.toContain("checkGuard");
    }
  });

  it("puts a work comp that is not what was asked for into the receipt", async () => {
    const ae = fakeAe();
    const host = ae.ctx.bridge as any;
    const orig = host.evalRaw.bind(host);
    host.evalRaw = async (p: any) => {
      const res = await orig(p);
      if (p.script.includes("stabilizeRigRead") && p.script.includes('"keys"') && res.result?.work) res.result.work.width = 1;
      return res;
    };
    const out = (await tool("ae_stabilize_roundtrip").handler(rt({ sheet: false }), ae.ctx)) as Out;
    expect(out.applied).toBe(true);
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches.map((m: any) => m.path)).toContain("work.size");
  });

  it("removes a rig: guard, read, write, read, and a receipt that the layer and comp are gone", async () => {
    const ae = fakeAe();
    ae.markBuilt();
    const out = (await tool("ae_stabilize_roundtrip").handler(
      AeStabilizeRoundtripSchema.parse({ comp_id: 1, action: "remove", rig_layer: { name: "Plate STAB" }, expect: expectArg }),
      ae.ctx
    )) as Out;
    expect(ae.fns()).toEqual(["checkGuard", "stabilizeRigRead", "stabilizeRigRemove", "stabilizeRigRead"]);
    expect(out.action).toBe("remove");
    expect(out.removed).toMatchObject({ rig_layer: { id: 201 }, work_comp: { id: WORK_ID } });
    expect(out.receipt.mismatches).toEqual([]);
    expect(ae.calls.find((c) => c.fn === "stabilizeRigRemove")!.args).toMatchObject({ outer: { name: "Plate STAB" }, delete_patches: false });
  });
});

// ---------- the host functions against a fake AE ----------

const P1 = (name: string, matchName: string, v: unknown) => new FakeProperty(name, matchName, PropertyValueType.OneD, v);
const P2 = (name: string, matchName: string, v: number[]) => new FakeProperty(name, matchName, PropertyValueType.TwoD, v);

function makeEffect(matchName: string, o: { dropRotation?: boolean } = {}): FakeGroup {
  if (matchName === "ADBE Corner Pin") {
    return new FakeGroup("Corner Pin", matchName, [
      P2("Upper Left", "ADBE Corner Pin-0001", [0, 0]),
      P2("Upper Right", "ADBE Corner Pin-0002", [100, 0]),
      P2("Lower Left", "ADBE Corner Pin-0003", [0, 100]),
      P2("Lower Right", "ADBE Corner Pin-0004", [100, 100]),
    ]);
  }
  if (matchName === "ADBE Geometry2") {
    const params = [
      P2("Anchor Point", "ADBE Geometry2-0001", [0, 0]),
      P2("Position", "ADBE Geometry2-0002", [0, 0]),
      P1("Uniform Scale", "ADBE Geometry2-0003", 0),
      P1("Scale Height", "ADBE Geometry2-0004", 100),
      P1("Scale Width", "ADBE Geometry2-0005", 100),
      P1("Skew", "ADBE Geometry2-0006", 0),
      P1("Skew Axis", "ADBE Geometry2-0007", 0),
      P1("Rotation", "ADBE Geometry2-0008", 0),
      P1("Opacity", "ADBE Geometry2-0009", 100),
      P1("Use Composition's Shutter Angle", "ADBE Geometry2-0010", 1),
      P1("Shutter Angle", "ADBE Geometry2-0011", 0),
      P1("Sampling", "ADBE Geometry2-0012", 1),
    ];
    return new FakeGroup("Transform", matchName, o.dropRotation ? params.filter((p) => p.name !== "Rotation") : params);
  }
  if (matchName === "ADBE Tile") {
    return new FakeGroup("Motion Tile", matchName, [
      P2("Tile Center", "ADBE Tile-0001", [0, 0]),
      P1("Tile Width", "ADBE Tile-0002", 100),
      P1("Tile Height", "ADBE Tile-0003", 100),
      P1("Output Width", "ADBE Tile-0004", 100),
      P1("Output Height", "ADBE Tile-0005", 100),
      P1("Mirror Edges", "ADBE Tile-0006", 0),
      P1("Phase", "ADBE Tile-0007", 0),
      P1("Horizontal Phase Shift", "ADBE Tile-0008", 0),
    ]);
  }
  if (matchName === "ADBE Checkbox Control") return new FakeGroup("Checkbox Control", matchName, [P1("Checkbox", "ADBE Checkbox Control-0001", 1)]);
  return new FakeGroup(matchName, matchName, []);
}

/** Effects that can be added: appended, or inserted on top (the order AE gives is unmeasured), with an index and moveTo like AE's. */
function withEffects(layer: FakeLayer, o: { top?: boolean; dropRotation?: boolean } = {}): FakeGroup {
  const fx = layer.property("ADBE Effect Parade") as any;
  fx.addProperty = (mn: string) => {
    const g = makeEffect(mn, o) as any;
    g.parentProperty = fx;
    if (o.top) fx.props.unshift(g);
    else fx.props.push(g);
    Object.defineProperty(g, "propertyIndex", { get: () => fx.props.indexOf(g) + 1 });
    g.moveTo = (i: number) => {
      fx.props.splice(fx.props.indexOf(g), 1);
      fx.props.splice(i - 1, 0, g);
    };
    g.remove = () => {
      fx.props.splice(fx.props.indexOf(g), 1);
    };
    return g;
  };
  return fx;
}

function scene() {
  const project = new FakeProject();
  const comp = project.addComp("Main", 640, 360, 4);
  comp.frameRate = 25;
  (project as any).items = {
    addComp: (name: string, w: number, h: number, _pa: number, dur: number, fps: number) => {
      const c = project.addComp(name, w, h, dur);
      c.frameRate = fps;
      return c;
    },
  };
  const layer = (name: string, w = 640, h = 360) => {
    const l = comp.layers.addSolid([1, 1, 1], name, w, h, 1) as FakeLayer;
    (l as any).width = w;
    (l as any).height = h;
    // Layers sit with anchor and position at the same point, as footage laid into a comp does.
    l.transform("ADBE Anchor Point").setValue([w / 2, h / 2, 0]);
    l.transform("ADBE Position").setValue([w / 2, h / 2, 0]);
    return l;
  };
  return { project, comp, layer };
}

const loadAll = (project: FakeProject) => {
  const h = loadHost(project, ["planar.jsx", "stabilize.jsx"]);
  h.G.LayerSamplingQuality = { BICUBIC: 2, BILINEAR: 1 };
  h.G.FrameBlendingType = { NO_FRAME_BLEND: 1 };
  return h;
};

const pos = (l: FakeLayer) => l.transform("ADBE Position");
const times3 = [0, 0.04, 0.08];
const tvals = (n = 3) => ({
  anchor: Array.from({ length: n }, (_, i) => [320 + i, 180]),
  position: Array.from({ length: n }, () => [320, 180]),
  rotation: Array.from({ length: n }, (_, i) => -i),
  scale: Array.from({ length: n }, (_, i) => [100 + i, 100 + i]),
});
const pinVals = (n = 3) => ({
  ul: Array.from({ length: n }, (_, i) => [i, 0]),
  ur: Array.from({ length: n }, (_, i) => [640 + i, 0]),
  ll: Array.from({ length: n }, (_, i) => [i, 360]),
  lr: Array.from({ length: n }, (_, i) => [640 + i, 360]),
});

describe("stabilize.jsx: inspect", () => {
  it("reports the plate, its transform at a time, its keys and its effects, changing nothing", () => {
    const { project, comp, layer } = scene();
    const plate = layer("Plate");
    pos(plate).setValueAtTime(0, [300, 180, 0]);
    pos(plate).setValueAtTime(1, [340, 180, 0]);
    const fx = withEffects(plate);
    fx.addProperty("ADBE Geometry2");
    const { A, undo } = loadAll(project);
    const r = A.stabilizeInspect({ comp_id: comp.id, layer: { name: "Plate" }, ref_time: 0.5 });
    expect(r.comp).toMatchObject({ width: 640, height: 360, fps: 25, num_layers: 1 });
    expect(r.layer).toMatchObject({ index: 1, locked: false, three_d: false, parent: null, width: 640, height: 360, time_remap: false, num_masks: 0 });
    expect(r.layer.source_id).toBe((plate.source as any).id);
    expect(r.transform.position).toEqual([320, 180]);
    expect(r.transform.scale).toEqual([100, 100]);
    expect(r.keys).toMatchObject({ position: 2, anchor: 0 });
    expect(r.effects).toEqual([{ index: 1, name: "Transform", matchName: "ADBE Geometry2" }]);
    expect(r.num_effects).toBe(1);
    expect(undo.begun).toBe(0);
  });

  it("tells a parent, expressions and a locked layer", () => {
    const { project, comp, layer } = scene();
    const parent = layer("Rig");
    const plate = layer("Plate");
    plate.parent = parent;
    plate.locked = true;
    (pos(plate) as any).expressionEnabled = true;
    const { A } = loadAll(project);
    const r = A.stabilizeInspect({ comp_id: comp.id, layer: { name: "Plate" }, ref_time: 0 });
    expect(r.layer.parent).toMatchObject({ name: "Rig" });
    expect(r.layer.locked).toBe(true);
    expect(r.expressions).toEqual(["position"]);
  });
});

describe("stabilize.jsx: stabilizeApply", () => {
  const applyArgs = (comp: FakeComp, plate: FakeLayer, over: Record<string, unknown> = {}) => ({
    comp_id: comp.id,
    layer: { index: plate.index, id: plate.id },
    target: "layer_transform",
    times: times3,
    values: tvals(),
    bicubic: true,
    expect: GUARD,
    ...over,
  });

  it("writes Anchor Point, Position, Rotation and Scale as linear keys in one undo group", () => {
    const { project, comp, layer } = scene();
    const plate = layer("Plate");
    const { A, undo } = loadAll(project);
    const r = A.stabilizeApply(applyArgs(comp, plate));
    expect(undo.begun).toBe(1);
    expect(undo.ended).toBe(1);
    expect(r.written[0].props.map((p: any) => [p.role, p.numKeys])).toEqual([["position", 3], ["rotation", 3], ["scale", 3], ["anchor", 3]]);
    expect(plate.transform("ADBE Anchor Point").keyValue(3)).toEqual([322, 180, 0]);
    expect(plate.transform("ADBE Rotate Z").keyValue(2)).toBe(-1);
    expect(plate.transform("ADBE Scale").keyValue(3)).toEqual([102, 102, 100]);
    expect(plate.transform("ADBE Position").keyInInterpolationType(1)).toBe(6612);
    expect((plate as any).samplingQuality).toBe(2);
    expect(r.flags).toMatchObject({ bicubic: true, motion_blur: null });
  });

  it("refuses, before the undo group, a keyed, parented, locked or 3D plate, and a stale layer", () => {
    const { project, comp, layer } = scene();
    const parent = layer("Rig");
    const plate = layer("Plate");
    const { A, undo } = loadAll(project);
    pos(plate).setValueAtTime(0, [1, 1, 0]);
    expect(() => A.stabilizeApply(applyArgs(comp, plate))).toThrow(/already has 1 keyframes/);
    // replace_keys takes the old key out.
    A.stabilizeApply(applyArgs(comp, plate, { replace_keys: true }));
    expect(pos(plate).numKeys).toBe(3);
    const before = undo.begun;
    const { project: p2, comp: c2, layer: l2 } = scene();
    const rig = l2("Rig");
    const pl = l2("Plate");
    const h2 = loadAll(p2);
    pl.parent = rig;
    expect(() => h2.A.stabilizeApply(applyArgs(c2, pl))).toThrow(/has a parent/);
    pl.parent = null;
    pl.locked = true;
    expect(() => h2.A.stabilizeApply(applyArgs(c2, pl))).toThrow(/locked/);
    pl.locked = false;
    pl.threeDLayer = true;
    expect(() => h2.A.stabilizeApply(applyArgs(c2, pl))).toThrow(/3D/);
    pl.threeDLayer = false;
    expect(() => h2.A.stabilizeApply(applyArgs(c2, pl, { layer: { index: 1, id: pl.id + 1 } }))).toThrow(/stack changed/);
    expect(() => h2.A.stabilizeApply(applyArgs(c2, pl, { expect: { project_path: "C:/other.aep" } }))).toThrow(/Target guard refused/);
    expect(h2.undo.begun).toBe(0);
    expect(undo.begun).toBe(before);
    void parent;
  });

  it("refuses a plate with Auto-Orient on, before the undo group, and reports it when inspecting", () => {
    const { project, comp, layer } = scene();
    const plate = layer("Plate");
    const h = loadAll(project);
    h.G.AutoOrientType = { NO_AUTO_ORIENT: 4212, ALONG_PATH: 4213 };
    (plate as any).autoOrient = 4212;
    expect(h.A.stabilizeInspect({ comp_id: comp.id, layer: { name: "Plate" }, ref_time: 0 }).layer.auto_orient).toBe(false);
    expect(() => h.A.stabilizeApply(applyArgs(comp, plate))).not.toThrow();
    const s2 = scene();
    const p2 = s2.layer("Plate");
    const h2 = loadAll(s2.project);
    h2.G.AutoOrientType = { NO_AUTO_ORIENT: 4212, ALONG_PATH: 4213 };
    (p2 as any).autoOrient = 4213;
    expect(h2.A.stabilizeInspect({ comp_id: s2.comp.id, layer: { name: "Plate" }, ref_time: 0 }).layer.auto_orient).toBe(true);
    expect(() => h2.A.stabilizeApply(applyArgs(s2.comp, p2))).toThrow(/Auto-Orient/);
    expect(h2.undo.begun).toBe(0);
    expect(pos(p2).numKeys).toBe(0);
    // Corner Pin writes no layer Position keys, so Auto-Orient does nothing there.
    expect(() => h2.A.stabilizeApply(applyArgs(s2.comp, p2, { target: "corner_pin", values: pinVals() }))).not.toThrow(/Auto-Orient/);
  });

  it("refuses bad numbers and Position with separated dimensions before writing", () => {
    const { project, comp, layer } = scene();
    const plate = layer("Plate");
    const { A, undo } = loadAll(project);
    expect(() => A.stabilizeApply(applyArgs(comp, plate, { times: [0, 0, 1] }))).toThrow(/ascend/);
    expect(() => A.stabilizeApply(applyArgs(comp, plate, { values: { ...tvals(), rotation: [0, NaN, 1] } }))).toThrow(/not a number/);
    expect(() => A.stabilizeApply(applyArgs(comp, plate, { values: { ...tvals(), scale: [[100, 100]] } }))).toThrow(/needs 3 values/);
    (pos(plate) as any).dimensionsSeparated = true;
    expect(() => A.stabilizeApply(applyArgs(comp, plate))).toThrow(/separated Position/);
    (pos(plate) as any).dimensionsSeparated = false;
    expect(() => A.stabilizeApply(applyArgs(comp, plate, { target: "wobble" }))).toThrow(/Unknown stabilize target/);
    expect(undo.begun).toBe(0);
    expect(pos(plate).numKeys).toBe(0);
  });

  it("motion blur and the comp switch only when asked", () => {
    const { project, comp, layer } = scene();
    const plate = layer("Plate");
    const { A } = loadAll(project);
    A.stabilizeApply(applyArgs(comp, plate, { motion_blur: true, comp_motion_blur: true }));
    expect((plate as any).motionBlur).toBe(true);
    expect((comp as any).motionBlur).toBe(true);
    const s2 = scene();
    const p2 = s2.layer("Plate");
    loadAll(s2.project).A.stabilizeApply(applyArgs(s2.comp, p2));
    expect((p2 as any).motionBlur).toBeUndefined();
    expect((s2.comp as any).motionBlur).toBeUndefined();
  });

  it("writes a Transform effect by display name, uniform scale on, a shutter angle on request", () => {
    const { project, comp, layer } = scene();
    const plate = layer("Plate");
    const fx = withEffects(plate);
    const { A, undo } = loadAll(project);
    const r = A.stabilizeApply(applyArgs(comp, plate, { target: "transform_effect", effect_wanted: TRANSFORM_FX_PARAMS, shutter_angle: 90 }));
    expect(undo.begun).toBe(1);
    const effect = fx.property(1) as FakeGroup;
    expect(effect.name).toBe("Stabilize Transform");
    expect(r.effect).toMatchObject({ name: "Stabilize Transform", index: 1, uniform_scale_on: true, shutter: { set: true, angle: 90 } });
    expect((effect.property("Anchor Point") as FakeProperty).numKeys).toBe(3);
    expect((effect.property("Rotation") as FakeProperty).keyValue(2)).toBe(-1);
    // Scale Height gets the scalar; Uniform Scale is on; the composition's shutter is off.
    expect((effect.property("Scale Height") as FakeProperty).keyValue(3)).toBe(102);
    expect((effect.property("Uniform Scale") as FakeProperty).staticValue).toBe(1);
    expect((effect.property("Use Composition's Shutter Angle") as FakeProperty).staticValue).toBe(0);
    expect((effect.property("Shutter Angle") as FakeProperty).staticValue).toBe(90);
    // The layer's own transform is untouched.
    expect(plate.transform("ADBE Rotate Z").numKeys).toBe(0);
    expect(r.written[0]).toMatchObject({ target: "transform_effect", effect_index: 1 });
    expect(r.effect.param_table.find((x: any) => x.role === "scaleH")).toMatchObject({ name: "Scale Height", index: 4 });
    // The layer-transform check does not apply: a keyed layer is fine for the effect.
    pos(plate).setValueAtTime(0, [1, 1, 0]);
    expect(() => A.stabilizeApply(applyArgs(comp, plate, { target: "transform_effect", effect_wanted: TRANSFORM_FX_PARAMS }))).not.toThrow();
    expect(fx.numProperties).toBe(2);
    expect((fx.property(2) as FakeGroup).name).toBe("Stabilize Transform 2");
  });

  it("sets the Transform effect's own Sampling popup to Bicubic when bicubic is asked, and says when it cannot", () => {
    const { project, comp, layer } = scene();
    const plate = layer("Plate");
    const fx = withEffects(plate);
    const { A } = loadAll(project);
    const r = A.stabilizeApply(applyArgs(comp, plate, { target: "transform_effect", effect_wanted: TRANSFORM_FX_PARAMS }));
    expect(r.effect.sampling).toEqual({ set: true, value: 2 });
    expect(((fx.property(1) as FakeGroup).property("Sampling") as FakeProperty).staticValue).toBe(2);
    expect(r.effect.param_table.find((x: any) => x.role === "sampling")).toMatchObject({ name: "Sampling", index: 12 });
    // Read back in a separate call.
    const back = A.stabilizeReadBack({ comp_id: comp.id, layer_id: plate.id, kind: "transform_effect", effect_index: r.effect.index, effect_wanted: TRANSFORM_FX_PARAMS, times: [0] });
    expect(back.sampling).toBe(2);
    // Not asked for: the popup stays at its default.
    const s2 = scene();
    const p2 = s2.layer("Plate");
    const fx2 = withEffects(p2);
    const r2 = loadAll(s2.project).A.stabilizeApply(applyArgs(s2.comp, p2, { target: "transform_effect", effect_wanted: TRANSFORM_FX_PARAMS, bicubic: false }));
    expect(r2.effect.sampling).toBeNull();
    expect(((fx2.property(1) as FakeGroup).property("Sampling") as FakeProperty).staticValue).toBe(1);
    // An effect without the parameter: reported as not set.
    const s3 = scene();
    const p3 = s3.layer("Plate");
    const fx3 = withEffects(p3);
    const add3 = (fx3 as any).addProperty;
    (fx3 as any).addProperty = (mn: string) => {
      const g = add3(mn);
      g.props = g.props.filter((p: FakeProperty) => p.name !== "Sampling");
      return g;
    };
    const r3 = loadAll(s3.project).A.stabilizeApply(applyArgs(s3.comp, p3, { target: "transform_effect", effect_wanted: TRANSFORM_FX_PARAMS }));
    expect(r3.effect.sampling).toMatchObject({ set: false });
  });

  it("falls back to parameter positions when display names are not English, and says what it used", () => {
    const { project, comp, layer } = scene();
    const plate = layer("Plate");
    const fx = withEffects(plate);
    const add = (fx as any).addProperty;
    (fx as any).addProperty = (mn: string) => {
      const g = add(mn);
      (g.props as FakeProperty[]).forEach((p, i) => (p.name = `Parametre ${i + 1}`));
      return g;
    };
    const { A } = loadAll(project);
    const r = A.stabilizeApply(applyArgs(comp, plate, { target: "transform_effect", effect_wanted: TRANSFORM_FX_PARAMS }));
    expect(r.effect.param_table.find((x: any) => x.role === "rotation")).toMatchObject({ index: 8 });
    expect(r.effect.param_table.find((x: any) => x.role === "anchor")).toMatchObject({ index: 1 });
  });

  it("takes everything back when the effect has no parameter it needs", () => {
    const { project, comp, layer } = scene();
    const plate = layer("Plate");
    const fx = withEffects(plate, { dropRotation: true });
    const { A } = loadAll(project);
    expect(() =>
      A.stabilizeApply(applyArgs(comp, plate, { target: "transform_effect", effect_wanted: { ...TRANSFORM_FX_PARAMS, rotation: { names: ["Rotation"] } }, tile: { output_w_pct: 110, output_h_pct: 105, wanted: TILE_FX_PARAMS } }))
    ).toThrow(/no rotation parameter/);
    // The tile and the half-made Transform effect are both gone again.
    expect(fx.numProperties).toBe(0);
  });

  it("adds a Motion Tile in front, whichever end AE puts new effects at", () => {
    for (const top of [false, true]) {
      const { project, comp, layer } = scene();
      const plate = layer("Plate");
      const fx = withEffects(plate, { top });
      const { A } = loadAll(project);
      const r = A.stabilizeApply(applyArgs(comp, plate, { target: "transform_effect", effect_wanted: TRANSFORM_FX_PARAMS, tile: { output_w_pct: 112, output_h_pct: 104, wanted: TILE_FX_PARAMS } }));
      const names = (fx.props as FakeGroup[]).map((e) => e.name);
      expect(names).toEqual(["Stabilize Tile", "Stabilize Transform"]);
      expect(r.tile).toMatchObject({ name: "Stabilize Tile", output_w_pct: 112, output_h_pct: 104, mirror_edges: true, clamped: false, index: 1 });
      expect(r.effect.index).toBe(2);
      expect(r.written[0].effect_index).toBe(2);
      expect(r.order).toMatchObject({ checked: true, ok: true });
      expect(r.order.moved).toBe(top);
      const tile = fx.property(1) as FakeGroup;
      expect((tile.property("Output Width") as FakeProperty).staticValue).toBe(112);
      expect((tile.property("Mirror Edges") as FakeProperty).staticValue).toBe(1);
    }
  });

  it("clamps a Motion Tile output to the property's limit and says so", () => {
    const { project, comp, layer } = scene();
    const plate = layer("Plate");
    const fx = withEffects(plate);
    const add = (fx as any).addProperty;
    (fx as any).addProperty = (mn: string) => {
      const g = add(mn);
      const w = g.property("Output Width");
      if (w) {
        w.hasMax = true;
        w.maxValue = 108;
      }
      return g;
    };
    const { A } = loadAll(project);
    const r = A.stabilizeApply(applyArgs(comp, plate, { tile: { output_w_pct: 112, output_h_pct: 104, wanted: TILE_FX_PARAMS } }));
    expect(r.tile).toMatchObject({ output_w_pct: 108, clamped: true });
  });

  it("writes Corner Pin keys through the planar writer, with the tile before the pin", () => {
    const { project, comp, layer } = scene();
    const plate = layer("Plate");
    const fx = withEffects(plate, { top: true });
    const { A, undo } = loadAll(project);
    const r = A.stabilizeApply(applyArgs(comp, plate, { target: "corner_pin", values: pinVals(), tile: { output_w_pct: 112, output_h_pct: 104, wanted: TILE_FX_PARAMS } }));
    expect(undo.begun).toBe(1);
    const names = (fx.props as FakeGroup[]).map((e) => e.matchName);
    expect(names).toEqual(["ADBE Tile", "ADBE Corner Pin"]);
    expect(r.written[0]).toMatchObject({ target: "corner_pin" });
    expect(r.written[0].props.map((p: any) => p.role)).toEqual(["ul", "ur", "ll", "lr"]);
    expect(r.order.ok).toBe(true);
    expect(r.tile.index).toBe(1);
    // The pin shifted down when the tile moved in front of it, and the receipt follows it.
    expect(r.written[0].effect_index).toBe(2);
  });

  it("takes back the Corner Pin the planar writer added when its write fails halfway, and the tile with it", () => {
    const { project, comp, layer } = scene();
    const plate = layer("Plate");
    const fx = withEffects(plate, { top: true });
    const { A, undo } = loadAll(project);
    const real = A.planarWriteRaw;
    A.planarWriteRaw = (a: any) => {
      real(a);
      throw new Error("setValuesAtTimes: out of range");
    };
    expect(() => A.stabilizeApply(applyArgs(comp, plate, { target: "corner_pin", values: pinVals(), tile: { output_w_pct: 112, output_h_pct: 104, wanted: TILE_FX_PARAMS } }))).toThrow(/out of range/);
    expect(fx.numProperties).toBe(0);
    expect(undo.begun).toBe(1);
    expect(undo.ended).toBe(1);
    // So the next call is not refused for "already has a Corner Pin".
    A.planarWriteRaw = real;
    expect(() => A.stabilizeApply(applyArgs(comp, plate, { target: "corner_pin", values: pinVals() }))).not.toThrow();
    expect(fx.numProperties).toBe(1);
  });

  it("refuses a Corner Pin target on a plate with a Corner Pin of its own, before the undo group", () => {
    const { project, comp, layer } = scene();
    const plate = layer("Plate");
    withEffects(plate, { top: true });
    const { A, undo } = loadAll(project);
    (plate.property("ADBE Effect Parade") as FakeGroup).addProperty("ADBE Corner Pin");
    expect(() => A.stabilizeApply(applyArgs(comp, plate, { target: "corner_pin", values: pinVals() }))).toThrow(/already has a Corner Pin/);
    expect(undo.begun).toBe(0);
  });

  it("reads back key counts, values, flags, the tile and the effect, changing nothing", () => {
    const { project, comp, layer } = scene();
    const plate = layer("Plate");
    withEffects(plate);
    const { A, undo } = loadAll(project);
    const w = A.stabilizeApply(applyArgs(comp, plate, { target: "transform_effect", effect_wanted: TRANSFORM_FX_PARAMS, tile: { output_w_pct: 112, output_h_pct: 104, wanted: TILE_FX_PARAMS } }));
    const begun = undo.begun;
    const r = A.stabilizeReadBack({ comp_id: comp.id, layer_id: plate.id, kind: "transform_effect", effect_index: w.effect.index, effect_wanted: TRANSFORM_FX_PARAMS, tile_index: w.tile.index, tile_wanted: TILE_FX_PARAMS, times: [0, 0.08] });
    expect(r.items[0].props.map((p: any) => [p.role, p.numKeys])).toEqual([["anchor", 3], ["position", 3], ["rotation", 3], ["scale", 3]]);
    expect(r.items[0].props.find((p: any) => p.role === "scale").samples[1].value).toBe(102);
    expect(r.tile).toMatchObject({ found: true, output_w_pct: 112, output_h_pct: 104, mirror_edges: 1 });
    expect(r.effects.map((e: any) => e.name)).toEqual(["Stabilize Tile", "Stabilize Transform"]);
    expect(undo.begun).toBe(begun);
    // A wrong index finds nothing rather than a different effect.
    expect(A.stabilizeReadBack({ comp_id: comp.id, layer_id: plate.id, kind: "transform_effect", effect_index: 1, effect_wanted: TRANSFORM_FX_PARAMS, times: [] }).items[0].effect_found).toBe(false);
  });

  it("reads layer-transform keys through the planar reader and reports a missing layer", () => {
    const { project, comp, layer } = scene();
    const plate = layer("Plate");
    const { A } = loadAll(project);
    A.stabilizeApply(applyArgs(comp, plate));
    const r = A.stabilizeReadBack({ comp_id: comp.id, layer_id: plate.id, kind: "layer_transform", times: [0.04] });
    expect(r.items[0].props.find((p: any) => p.role === "rotation")).toMatchObject({ numKeys: 3, samples: [{ time: 0.04, value: -1 }] });
    expect(r.flags.bicubic).toBe(true);
    expect(A.stabilizeReadBack({ comp_id: comp.id, layer_id: 99999, kind: "layer_transform", times: [] }).items[0].found).toBe(false);
  });
});

describe("stabilize.jsx: the roundtrip rig", () => {
  const rigKeys = (target: "transform" | "corner_pin" = "transform", n = 3) => ({
    target,
    times: times3.slice(0, n),
    values: target === "transform" ? tvals(n) : pinVals(n),
    static_transform: { anchor: [320, 180], position: [320, 180], scale: [100, 100], rotation: 0 },
  });
  const buildArgs = (comp: FakeComp, plate: FakeLayer, over: Record<string, unknown> = {}) => ({
    comp_id: comp.id,
    plate: { index: plate.index, id: plate.id },
    name: "Plate STAB",
    layer_name: "Plate STAB",
    width: 700,
    height: 420,
    copy_effects: false,
    guide_mode: "guide_layer",
    motion_blur: true,
    comp_motion_blur: true,
    marker: { pad: 30, ref_time: 0.5, track_id: "trk_x" },
    inner: rigKeys(),
    outer: rigKeys(),
    expect: GUARD,
    ...over,
  });

  it("builds the work comp, the guide plate and the rig layer above the plate in one undo group", () => {
    const { project, comp, layer } = scene();
    const plate = layer("Plate");
    const bottom = layer("Other");
    void bottom;
    const items = project.numItems;
    const { A, undo } = loadAll(project);
    const r = A.stabilizeRigBuild(buildArgs(comp, plate));
    expect(undo.begun).toBe(1);
    expect(undo.ended).toBe(1);
    expect(project.numItems).toBe(items + 1);
    const work = project.itemByID(r.work_comp.id) as FakeComp;
    expect(work).toMatchObject({ name: "Plate STAB", width: 700, height: 420, frameRate: 25 });
    const inner = work.layer(1) as FakeLayer;
    expect(inner.name).toBe("Plate");
    expect(inner.guideLayer).toBe(true);
    expect(inner.comment).toBe("chroma-ae-mcp:stabilize-roundtrip:guide");
    expect(inner.transform("ADBE Rotate Z").numKeys).toBe(3);
    expect((inner as any).samplingQuality).toBe(2);
    const outer = comp.layer(r.outer.layer_index) as FakeLayer;
    expect(outer.name).toBe("Plate STAB");
    expect(outer.source).toBe(work);
    // Directly above the plate.
    expect(outer.index).toBe(plate.index - 1);
    expect(r.order_ok).toBe(true);
    expect(outer.comment).toBe(`chroma-ae-mcp:stabilize-roundtrip;plate_id=${plate.id};work_comp_id=${work.id};pad=30;ref_time=0.5;track_id=trk_x`);
    expect(outer.transform("ADBE Position").numKeys).toBe(3);
    expect((outer as any).motionBlur).toBe(true);
    expect((comp as any).motionBlur).toBe(true);
    expect((outer as any).samplingQuality).toBe(2);
    expect((outer as any).frameBlendingType).toBe(1);
    expect(r.flags).toMatchObject({ bicubic: true, frame_blending_off: true, motion_blur: true });
    // The plate itself was not touched.
    expect(plate.transform("ADBE Position").numKeys).toBe(0);
    expect(plate.guideLayer).toBe(false);
  });

  it("copies the plate's timing, and a perspective rig puts a Corner Pin on each half", () => {
    const { project, comp, layer } = scene();
    const plate = layer("Plate");
    plate.startTime = 0.5;
    plate.inPoint = 0.5;
    plate.outPoint = 2;
    plate.stretch = 50;
    const { A } = loadAll(project);
    const s = project;
    void s;
    const innerFx: FakeGroup[] = [];
    const orig = (FakeLayer.prototype as any).property;
    void orig;
    // Both layers will need an Effects group that can add a Corner Pin: patch the comps' layers as they appear.
    const patch = (c: FakeComp) => {
      const add = c.layers.add;
      c.layers.add = (item: any, dur?: number) => {
        const l = add(item, dur) as FakeLayer;
        innerFx.push(withEffects(l));
        return l;
      };
    };
    withEffects(plate);
    const addComp = (project as any).items.addComp;
    (project as any).items.addComp = (...a: any[]) => {
      const c = addComp(...a) as FakeComp;
      patch(c);
      return c;
    };
    patch(comp);
    const r = A.stabilizeRigBuild(buildArgs(comp, plate, { inner: rigKeys("corner_pin"), outer: rigKeys("corner_pin") }));
    const work = project.itemByID(r.work_comp.id) as FakeComp;
    const inner = work.layer(1) as FakeLayer;
    expect([inner.startTime, inner.inPoint, inner.outPoint, inner.stretch]).toEqual([0.5, 0.5, 2, 50]);
    expect(((inner.property("ADBE Effect Parade") as FakeGroup).property(1) as FakeGroup).matchName).toBe("ADBE Corner Pin");
    const outer = comp.layer(r.outer.layer_index) as FakeLayer;
    expect(((outer.property("ADBE Effect Parade") as FakeGroup).property(1) as FakeGroup).matchName).toBe("ADBE Corner Pin");
    expect(r.inner.written[0].target).toBe("corner_pin");
  });

  it("opacity_switch: a checkbox on the rig layer drives the copy's opacity, and the copy is not a guide", () => {
    const { project, comp, layer } = scene();
    const plate = layer("Plate");
    const { A } = loadAll(project);
    const addComp = (project as any).items.addComp;
    (project as any).items.addComp = (...a: any[]) => addComp(...a);
    (comp.layers as any).add = ((add) => (item: any, dur?: number) => {
      const l = add(item, dur) as FakeLayer;
      withEffects(l);
      return l;
    })(comp.layers.add);
    const r = A.stabilizeRigBuild(buildArgs(comp, plate, { guide_mode: "opacity_switch" }));
    const work = project.itemByID(r.work_comp.id) as FakeComp;
    const inner = work.layer(1) as FakeLayer;
    expect(inner.guideLayer).toBe(false);
    const expr = (inner.transform("ADBE Opacity") as FakeProperty).expression;
    expect(expr).toBe('comp("Main").layer("Plate STAB").effect("Show Stabilized Plate")("Checkbox")*100;');
    const outer = comp.layer(r.outer.layer_index) as FakeLayer;
    const cb = (outer.property("ADBE Effect Parade") as FakeGroup).property("Show Stabilized Plate") as FakeGroup;
    expect((cb.property(1) as FakeProperty).staticValue).toBe(0);
    expect(r.flags.opacity_switch).toBe(true);
  });

  it("mutes the plate copy's audio so the footage's sound does not play twice, and leaves the plate's own audio alone", () => {
    for (const mode of ["guide_layer", "opacity_switch"]) {
      const { project, comp, layer } = scene();
      const plate = layer("Plate");
      (plate as any).audioEnabled = true;
      const { A } = loadAll(project);
      (comp.layers as any).add = ((add) => (item: any, dur?: number) => {
        const l = add(item, dur) as FakeLayer;
        withEffects(l);
        return l;
      })(comp.layers.add);
      const origAdd = project.itemByID.bind(project);
      void origAdd;
      const addComp = (project as any).items.addComp;
      (project as any).items.addComp = (...a: any[]) => {
        const c = addComp(...a) as FakeComp;
        const ladd = c.layers.add;
        c.layers.add = (item: any, dur?: number) => {
          const l = ladd(item, dur) as FakeLayer;
          (l as any).audioEnabled = true;
          return l;
        };
        return c;
      };
      const r = A.stabilizeRigBuild(buildArgs(comp, plate, { guide_mode: mode }));
      const work = project.itemByID(r.work_comp.id) as FakeComp;
      expect((work.layer(1) as any).audioEnabled).toBe(false);
      expect(r.flags.guide_audio_off).toBe(true);
      expect((plate as any).audioEnabled).toBe(true);
      expect(A.stabilizeRigRead({ comp_id: comp.id, plate_id: plate.id }).work.layers[0].audio).toBe(false);
    }
  });

  it("refuses a plate with Auto-Orient on, or separated Position under copy_effects, before the undo group", () => {
    const { project, comp, layer } = scene();
    const plate = layer("Plate");
    const h = loadAll(project);
    const items = project.numItems;
    h.G.AutoOrientType = { NO_AUTO_ORIENT: 4212, ALONG_PATH: 4213 };
    (plate as any).autoOrient = 4213;
    expect(() => h.A.stabilizeRigBuild(buildArgs(comp, plate, { copy_effects: true }))).toThrow(/Auto-Orient/);
    (plate as any).autoOrient = 4212;
    (pos(plate) as any).dimensionsSeparated = true;
    expect(() => h.A.stabilizeRigBuild(buildArgs(comp, plate, { copy_effects: true }))).toThrow(/separated Position/);
    expect(project.numItems).toBe(items);
    expect(h.undo.begun).toBe(0);
  });

  it("opacity_switch refuses a shot comp name that is not unique and a rig layer name that is taken, before the undo group", () => {
    const { project, comp, layer } = scene();
    const plate = layer("Plate");
    const { A, undo } = loadAll(project);
    const items = project.numItems;
    project.addComp("Main", 100, 100, 1);
    expect(() => A.stabilizeRigBuild(buildArgs(comp, plate, { guide_mode: "opacity_switch" }))).toThrow(/2 comps in the project are named "Main"/);
    // guide_layer does not look the checkbox up by name.
    const s2 = scene();
    const p2 = s2.layer("Plate");
    s2.layer("Plate STAB");
    const h2 = loadAll(s2.project);
    const items2 = s2.project.numItems;
    expect(() => h2.A.stabilizeRigBuild(buildArgs(s2.comp, p2, { guide_mode: "opacity_switch" }))).toThrow(/a layer named "Plate STAB" is already in comp/);
    expect(s2.project.numItems).toBe(items2);
    expect(undo.begun).toBe(0);
    expect(h2.undo.begun).toBe(0);
    expect(project.numItems).toBe(items + 1);
    // The work comp itself would take the shot comp's name.
    const s3 = scene();
    const p3 = s3.layer("Plate");
    const h3 = loadAll(s3.project);
    const items3 = s3.project.numItems;
    expect(() => h3.A.stabilizeRigBuild(buildArgs(s3.comp, p3, { guide_mode: "opacity_switch", name: s3.comp.name }))).toThrow(/pass another name/);
    expect(s3.project.numItems).toBe(items3);
    expect(h3.undo.begun).toBe(0);
  });

  it("uses copyToComp only with copy_effects, and refuses effects or masks without it", () => {
    const { project, comp, layer } = scene();
    const plate = layer("Plate");
    withEffects(plate).addProperty("ADBE Geometry2");
    const { A, undo } = loadAll(project);
    const items = project.numItems;
    expect(() => A.stabilizeRigBuild(buildArgs(comp, plate))).toThrow(/copy_effects/);
    expect(project.numItems).toBe(items);
    expect(undo.begun).toBe(0);
    let copied = 0;
    (plate as any).copyToComp = (into: FakeComp) => {
      copied++;
      const nl = new FakeLayer(into, plate.name);
      nl.source = plate.source;
      into.stack.unshift(nl);
    };
    const r = A.stabilizeRigBuild(buildArgs(comp, plate, { copy_effects: true }));
    expect(copied).toBe(1);
    expect(r.inner.guide).toBe(true);
  });

  it("refuses a plate that is parented, keyed, time-remapped, 3D, locked or without a source, and a second rig", () => {
    const { project, comp, layer } = scene();
    const plate = layer("Plate");
    const { A, undo } = loadAll(project);
    const items = project.numItems;
    pos(plate).setValueAtTime(0, [1, 1, 0]);
    expect(() => A.stabilizeRigBuild(buildArgs(comp, plate))).toThrow(/still transform/);
    pos(plate).removeKey(1);
    (plate as any).timeRemapEnabled = true;
    expect(() => A.stabilizeRigBuild(buildArgs(comp, plate))).toThrow(/Time Remap/);
    (plate as any).timeRemapEnabled = false;
    plate.source = null;
    expect(() => A.stabilizeRigBuild(buildArgs(comp, plate))).toThrow(/no source/);
    expect(project.numItems).toBe(items);
    expect(undo.begun).toBe(0);
    const s = scene();
    const p2 = s.layer("Plate");
    const h = loadAll(s.project);
    expect(() => h.A.stabilizeRigBuild(buildArgs(s.comp, p2, { inner: rigKeys("transform", 2) }))).toThrow(/share the same times/);
    expect(() => h.A.stabilizeRigBuild(buildArgs(s.comp, p2, { guide_mode: "nope" }))).toThrow(/guide_mode/);
    expect(() => h.A.stabilizeRigBuild(buildArgs(s.comp, p2, { width: 0 }))).toThrow(/size/);
    h.A.stabilizeRigBuild(buildArgs(s.comp, p2));
    expect(() => h.A.stabilizeRigBuild(buildArgs(s.comp, p2))).toThrow(/already has a stabilize rig/);
  });

  it("takes back the work comp and the rig layer when a write fails inside the group", () => {
    const { project, comp, layer } = scene();
    const plate = layer("Plate");
    const { A, undo } = loadAll(project);
    const items = project.numItems;
    const layers = comp.numLayers;
    const real = A.planarWriteRaw;
    let calls = 0;
    A.planarWriteRaw = (args: any) => {
      if (++calls === 2) throw new Error("AE said no");
      return real(args);
    };
    expect(() => A.stabilizeRigBuild(buildArgs(comp, plate))).toThrow(/AE said no/);
    expect(project.numItems).toBe(items);
    expect(comp.numLayers).toBe(layers);
    expect(undo.begun).toBe(1);
    expect(undo.ended).toBe(1);
  });

  it("reads a rig, and removes it: refusing patches unless asked, refusing a layer it did not make", () => {
    const { project, comp, layer } = scene();
    const plate = layer("Plate");
    const { A } = loadAll(project);
    const r = A.stabilizeRigBuild(buildArgs(comp, plate));
    const work = project.itemByID(r.work_comp.id) as FakeComp;
    const read = A.stabilizeRigRead({ comp_id: comp.id, plate_id: plate.id, keys: [{ tag: "outer", comp_id: comp.id, layer_id: r.outer.layer_id, kind: "transform", times: [0.04] }] });
    expect(read.outer).toMatchObject({ found: true, id: r.outer.layer_id, source_id: work.id, marker_ok: true, motion_blur: true, bicubic: true, frame_blending_off: true });
    expect(read.plate).toMatchObject({ found: true, id: plate.id });
    expect(read.work).toMatchObject({ found: true, name: "Plate STAB", width: 700, height: 420, num_layers: 1 });
    expect(read.work.layers[0]).toMatchObject({ guide: true, marker: "guide" });
    expect(read.marker).toMatchObject({ plate_id: plate.id, work_comp_id: work.id, pad: 30 });
    expect(read.keys[0].items[0].props.find((p: any) => p.role === "rotation").samples[0].value).toBe(-1);
    // By selector, and a gone layer is no error for a read.
    expect(A.stabilizeRigRead({ comp_id: comp.id, outer: { name: "Nope" } }).outer).toEqual({ found: false });

    // A patch in the work comp stops the removal.
    const patch = new FakeLayer(work, "Patch");
    work.stack.unshift(patch);
    expect(() => A.stabilizeRigRemove({ comp_id: comp.id, work_comp_id: work.id, expect: GUARD })).toThrow(/besides the guide plate/);
    expect(project.itemByID(work.id)).not.toBeNull();
    // A plain layer is never removed.
    expect(() => A.stabilizeRigRemove({ comp_id: comp.id, outer: { id: plate.id }, expect: GUARD })).toThrow(/was not made by ae_stabilize_roundtrip/);
    const gone = A.stabilizeRigRemove({ comp_id: comp.id, work_comp_id: work.id, delete_patches: true, expect: GUARD });
    expect(gone).toMatchObject({ outer_id: r.outer.layer_id, work_comp_id: work.id, patches: 1, layers_deleted: 2 });
    expect(project.itemByID(work.id)).toBeNull();
    expect(comp.layer("Plate STAB")).toBeNull();
    expect(comp.layer("Plate")).toBe(plate);
  });

  it("removes a clean rig without delete_patches, and finds none when there is none", () => {
    const { project, comp, layer } = scene();
    const plate = layer("Plate");
    const { A, undo } = loadAll(project);
    expect(() => A.stabilizeRigRemove({ comp_id: comp.id, plate_id: plate.id, expect: GUARD })).toThrow(/No stabilize rig/);
    A.stabilizeRigBuild(buildArgs(comp, plate));
    const begun = undo.begun;
    const r = A.stabilizeRigRemove({ comp_id: comp.id, plate_id: plate.id, expect: GUARD });
    expect(r.patches).toBe(0);
    expect(undo.begun).toBe(begun + 1);
    expect(comp.numLayers).toBe(1);
  });
});

describe("stabilize.jsx: stays ES3", () => {
  it("has no let, const, arrows, template strings or classes", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../panel/host/ext/stabilize.jsx"), "utf8");
    const code = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toMatch(/\b(let|const|class)\s+[A-Za-z_$]/);
    expect(code).not.toMatch(/=>/);
    expect(code).not.toMatch(/`/);
  });
});

void PropertyType;
void toGray;
void plateSample;
void identityH;
