import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PNG } from "pngjs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import {
  AeTrackApplySchema,
  AeTrackMultiSchema,
  AeTrackReadSchema,
  blurrinessFromSigma,
  buildLayerKeys,
  buildNullKeys,
  channelGray,
  createRenderBudget,
  keyMismatches,
  layerSampleOf,
  loadTrack,
  MultiTracker,
  planarTools,
  platesFolderFor,
  regionLongerSide,
  regionMask,
  resolveEffectParams,
  saveTrack,
  sigmaFromBlurriness,
  trackFromSeries,
  trackSummary,
  tracksDir,
  TrackSourceSchema,
  type MultiTrackOptions,
  type LayerSample,
} from "../src/tools/ext/planar.js";
import { applyH, identityH, invertH, mulH, type Mat3, type PlanarFrame, type PlanarTrack, type Vec2 } from "../src/tools/ext/planar-math.js";
import { installSessionTracking, resetSessionTracking } from "../src/tools/ext/session.js";
import { toGray } from "../src/tools/ext/track.js";
import { FakeGroup, FakeLayer, FakeProject, FakeProperty, GUARD, loadHost, PropertyType, PropertyValueType, type FakeComp } from "./support/fake-ae.js";

// The track store and the frame folder live under the data dir: keep them out of the real one.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-planar-"));
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

const tool = (name: string) => planarTools.find((t) => t.name === name)!;
const expectArg = { project_path: "<unsaved>" };
const close = (a: ArrayLike<number>, b: ArrayLike<number>, tol = 1e-6) => {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) expect(Math.abs(a[i] - b[i])).toBeLessThan(tol);
};
const rot = (deg: number, s: number, tx: number, ty: number): Mat3 => {
  const r = (deg * Math.PI) / 180;
  return [s * Math.cos(r), -s * Math.sin(r), tx, s * Math.sin(r), s * Math.cos(r), ty, 0, 0, 1];
};

// ---------- a textured plane, drawn under a known motion ----------

const W = 240;
const H = 160;

const tex = (u: number, v: number): number =>
  128 + 45 * Math.sin(0.31 * u) * Math.cos(0.27 * v) + 30 * Math.sin(0.11 * u + 0.17 * v) + 25 * Math.sin(0.53 * u - 0.41 * v + 1) + 15 * Math.sin(0.9 * u) * Math.sin(0.8 * v);

/** The plane's motion at frame k (frame 5 is the reference: identity). */
const motion = (k: number): Mat3 => rot(1.2 * (k - 5), 1 + 0.004 * (k - 5), 2 * (k - 5), 1 * (k - 5));

interface Draw {
  flat?: [number, number, number, number];
  cover?: { x: number; y: number; size: number };
  other?: boolean;
}

function frameAtK(k: number, d: Draw = {}): PNG {
  const inv = invertH(motion(k))!;
  const png = new PNG({ width: W, height: H });
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = applyH(inv, [x + 0.5, y + 0.5]) as Vec2;
      let v = d.other ? 90 + 70 * Math.sin(x * 1.7) * Math.cos(y * 2.3) : tex(p[0], p[1]);
      if (d.flat && p[0] >= d.flat[0] && p[0] < d.flat[2] && p[1] >= d.flat[1] && p[1] < d.flat[3]) v = 100;
      if (d.cover && Math.abs(x - d.cover.x) < d.cover.size / 2 && Math.abs(y - d.cover.y) < d.cover.size / 2) v = 20;
      const i = (y * W + x) * 4;
      png.data[i] = png.data[i + 1] = png.data[i + 2] = Math.max(0, Math.min(255, Math.round(v)));
      png.data[i + 3] = 255;
    }
  }
  return png;
}

const POINTS: Vec2[] = [
  [60, 40],
  [180, 45],
  [190, 120],
  [55, 115],
  [120, 80],
];

const OPTS: MultiTrackOptions = { model: "similarity", patchSize: 21, searchRadius: 14, minConfidence: 0.6, warpPatterns: true, ransacPx: 2, seed: 5 };
const QUAD: Vec2[] = [[50, 30], [190, 30], [190, 130], [50, 130]];
const grayOf = (k: number, d: Draw = {}) => toGray(frameAtK(k, d));

/** The plane drawn at `s` times the resolution (frame k's motion in comp px). */
function frameScaled(k: number, s: number): PNG {
  const inv = invertH(motion(k))!;
  const png = new PNG({ width: W * s, height: H * s });
  for (let y = 0; y < H * s; y++) {
    for (let x = 0; x < W * s; x++) {
      const p = applyH(inv, [(x + 0.5) / s, (y + 0.5) / s]) as Vec2;
      const i = (y * W * s + x) * 4;
      png.data[i] = png.data[i + 1] = png.data[i + 2] = Math.max(0, Math.min(255, Math.round(tex(p[0], p[1]))));
      png.data[i + 3] = 255;
    }
  }
  return png;
}

describe("MultiTracker", () => {
  it("tracks on a decoded image twice the comp size and answers in comp px", () => {
    const mt = new MultiTracker(toGray(frameScaled(5, 2)), POINTS, 2, OPTS, QUAD);
    expect(mt.alive).toBe(5);
    expect(mt.toImg([60, 40])).toEqual([119.5, 79.5]);
    expect(mt.toComp(119.5, 79.5)).toEqual([60, 40]);
    const f = mt.step(toGray(frameScaled(6, 2)), 0.6).frame!;
    expect(f.ok).toBe(true);
    expect(f.inliers).toBe(5);
    for (let i = 0; i < POINTS.length; i++) {
      const want = applyH(motion(6), POINTS[i]) as Vec2;
      // Comp px, not image px: a scale ignored anywhere would put these twice as far out.
      expect(Math.hypot(f.points[i]![0] - want[0], f.points[i]![1] - want[1])).toBeLessThan(0.6);
    }
  });

  it("steps a point the fit voted out again from where it stood, so its velocity stays the frame-to-frame motion", () => {
    const mt = new MultiTracker(grayOf(5), POINTS, 1, OPTS, QUAD);
    const tr = (mt as any).trackers[4];
    const prev = tr.motion;
    const orig = tr.step.bind(tr);
    let n = 0;
    // The first pass finds the point 15 px off (an outlier); the second pass is honest.
    tr.step = (g: any, pred: any, tpl: any) => {
      const r = orig(g, pred, tpl);
      if (n++ === 0 && r) {
        tr.restoreMotion({ x: r.x + 15, y: r.y, vx: r.x + 15 - prev.x, vy: r.y - prev.y });
        return { ...r, x: r.x + 15 };
      }
      return r;
    };
    const res = mt.step(grayOf(6), 0.6);
    expect(res.reacquired).toContain(4);
    const want = applyH(motion(6), POINTS[4]) as Vec2;
    const m = tr.motion;
    // Velocity = new position - the position BEFORE the frame (about 2 px here), not new - outlier (about -13 px).
    expect(Math.abs(m.vx - (want[0] - 0.5 - prev.x))).toBeLessThan(1);
    expect(Math.abs(m.vx)).toBeLessThan(6);
  });

  it("solves the plane's motion on every frame from several points", () => {
    const mt = new MultiTracker(grayOf(5), POINTS, 1, OPTS, QUAD);
    expect(mt.alive).toBe(5);
    for (let k = 6; k <= 9; k++) {
      const r = mt.step(grayOf(k), k / 10);
      const f = r.frame!;
      expect(f.ok).toBe(true);
      expect(f.inliers).toBe(5);
      for (const p of POINTS) {
        const want = applyH(motion(k), p) as Vec2;
        const got = applyH(f.H!, p) as Vec2;
        expect(Math.hypot(want[0] - got[0], want[1] - got[1])).toBeLessThan(0.4);
      }
      expect(f.rms_px!).toBeLessThan(0.5);
    }
  });

  it("tracks backwards from the reference just the same", () => {
    const mt = new MultiTracker(grayOf(5), POINTS, 1, OPTS, QUAD);
    let last: PlanarFrame | null = null;
    for (let k = 4; k >= 1; k--) last = mt.step(grayOf(k), k / 10).frame;
    const want = applyH(motion(1), POINTS[0]) as Vec2;
    const got = applyH(last!.H!, POINTS[0]) as Vec2;
    expect(Math.hypot(want[0] - got[0], want[1] - got[1])).toBeLessThan(0.6);
  });

  it("carries on past a point that is covered, and finds it again", () => {
    const mt = new MultiTracker(grayOf(5), POINTS, 1, OPTS, QUAD);
    mt.step(grayOf(6), 0.6);
    const at7 = applyH(motion(7), POINTS[0]) as Vec2;
    const covered = mt.step(grayOf(7, { cover: { x: at7[0], y: at7[1], size: 36 } }), 0.7);
    expect(covered.lost).toEqual([0]);
    expect(covered.frame!.ok).toBe(true);
    expect(covered.frame!.points[0]).toBeNull();
    expect(covered.frame!.inliers).toBe(4);
    const want = applyH(motion(7), POINTS[2]) as Vec2;
    expect(Math.hypot(applyH(covered.frame!.H!, POINTS[2])![0] - want[0], applyH(covered.frame!.H!, POINTS[2])![1] - want[1])).toBeLessThan(0.5);
    const again = mt.step(grayOf(8), 0.8);
    expect(again.frame!.points[0]).not.toBeNull();
    expect(again.frame!.inliers).toBe(5);
  });

  it("re-acquires a point that the solved motion places where its pattern still is", () => {
    // A tight search radius loses the fast point on the first pass; the other four predict where it went.
    const mt = new MultiTracker(grayOf(5), POINTS, 1, { ...OPTS, searchRadius: 4 }, QUAD);
    mt.step(grayOf(6), 0.6);
    const r = mt.step(grayOf(7), 0.7);
    expect(r.frame).not.toBeNull();
    expect(r.frame!.ok).toBe(true);
  });

  it("stops with 'cut' when most points vanish at once, and 'lost' when too few remain", () => {
    const mt = new MultiTracker(grayOf(5), POINTS, 1, OPTS, QUAD);
    mt.step(grayOf(6), 0.6);
    const cut = mt.step(grayOf(7, { other: true }), 0.7);
    expect(cut.stop).toBe("cut");
    expect(cut.frame).toBeNull();
    const two = new MultiTracker(grayOf(5), POINTS.slice(0, 2), 1, OPTS, QUAD);
    const at = applyH(motion(6), POINTS[0]) as Vec2;
    const lost = two.step(grayOf(6, { cover: { x: at[0], y: at[1], size: 40 } }), 0.6);
    expect(lost.stop).toBe("lost");
  });

  it("drops a point with nothing to follow and reports why", () => {
    const g = grayOf(5, { flat: [100, 60, 140, 100] });
    const mt = new MultiTracker(g, POINTS, 1, OPTS, QUAD);
    expect(mt.dropped.map((d) => d.index)).toEqual([4]);
    expect(mt.dropped[0].reason).toMatch(/flat/);
    expect(mt.alive).toBe(4);
    const f = mt.step(grayOf(6), 0.6).frame!;
    expect(f.points[4]).toBeNull();
    expect(f.ok).toBe(true);
  });

  it("marks a frame not ok instead of writing a folded quad", () => {
    const mt = new MultiTracker(grayOf(5), POINTS, 1, OPTS, [[50, 30], [190, 30], [190, 130], [50, 130]]);
    // A quad that already is degenerate in the reference can never pass.
    const flatQuad = new MultiTracker(grayOf(5), POINTS, 1, OPTS, [[50, 30], [60, 30], [70, 30], [80, 30]]);
    const r = flatQuad.step(grayOf(6), 0.6).frame!;
    expect(r.ok).toBe(false);
    expect(r.H).toBeNull();
    expect(r.note).toMatch(/degenerate/);
    expect(mt.step(grayOf(6), 0.6).frame!.ok).toBe(true);
  });

  it("a chunk resumed from stored state follows the same path as one long run", () => {
    const whole = new MultiTracker(grayOf(5), POINTS, 1, OPTS, QUAD);
    const wholeH: Mat3[] = [];
    for (let k = 6; k <= 9; k++) wholeH.push(whole.step(grayOf(k), k / 10).frame!.H!);
    const first = new MultiTracker(grayOf(5), POINTS, 1, OPTS, QUAD);
    let last: PlanarFrame | null = null;
    for (let k = 6; k <= 7; k++) last = first.step(grayOf(k), k / 10).frame;
    // After a restart only the stored positions and H remain.
    const resumed = new MultiTracker(grayOf(5), POINTS, 1, OPTS, QUAD);
    resumed.restore(last!.points, first.lastH);
    for (let k = 8; k <= 9; k++) {
      const h = resumed.step(grayOf(k), k / 10).frame!.H!;
      close(h, wholeH[k - 6], 0.05);
    }
    // The same instance, carried on, matches exactly.
    for (let k = 8; k <= 9; k++) expect(first.step(grayOf(k), k / 10).frame!.H).toEqual(wholeH[k - 6]);
  });

  it("maps comp pixels onto a larger decoded image", () => {
    const mt = new MultiTracker(grayOf(5), POINTS, 1, OPTS, QUAD);
    expect(mt.toComp(59.5, 39.5)).toEqual([60, 40]);
    expect(mt.toImg([60, 40])).toEqual([59.5, 39.5]);
  });
});

// ---------- schemas and helpers ----------

describe("schemas", () => {
  it("ae_track_multi takes exactly one way to name the points, and expect with isolate or apply", () => {
    const base = { comp_id: 1 };
    expect(AeTrackMultiSchema.safeParse({ ...base }).success).toBe(false);
    expect(AeTrackMultiSchema.safeParse({ ...base, points: [[1, 2]] }).success).toBe(true);
    expect(AeTrackMultiSchema.safeParse({ ...base, points: [[1, 2]], auto_points: { region: { rect: [0, 0, 10, 10] } } }).success).toBe(false);
    expect(AeTrackMultiSchema.safeParse({ ...base, continue_track_id: "trk_a" }).success).toBe(true);
    expect(AeTrackMultiSchema.safeParse({ ...base, points: [[1, 2]], isolate_layers: [{ index: 1 }] }).success).toBe(false);
    expect(AeTrackMultiSchema.safeParse({ ...base, points: [[1, 2]], isolate_layers: [{ index: 1 }], expect: expectArg }).success).toBe(true);
    expect(AeTrackMultiSchema.safeParse({ ...base, points: [[1, 2]], apply: { mode: "nulls" } }).success).toBe(false);
    expect(AeTrackMultiSchema.safeParse({ ...base, points: new Array(9).fill([1, 2]) }).success).toBe(false);
    expect(AeTrackMultiSchema.safeParse({ ...base, points: [[1, 2, 3]] }).success).toBe(false);
    expect(AeTrackMultiSchema.safeParse({ ...base, points: [[1, 2]], search_radius: 500 }).success).toBe(false);
  });

  it("ae_track_multi fills in the defaults and accepts every region shape", () => {
    const p = AeTrackMultiSchema.parse({ comp_id: 1, points: [[1, 2]] });
    expect(p).toMatchObject({ pattern_size: 31, search_radius: 40, min_confidence: 0.6, max_frames: 250, max_seconds: 90, channel: "luma", preview: true });
    for (const region of [{ rect: [0, 0, 5, 5] }, { ellipse: [5, 5, 3, 3] }, { polygon: [[0, 0], [5, 0], [5, 5]] }]) {
      expect(AeTrackMultiSchema.safeParse({ comp_id: 1, auto_points: { region, exclude: [region] } }).success).toBe(true);
    }
    expect(AeTrackMultiSchema.safeParse({ comp_id: 1, auto_points: { region: { rect: [0, 0, 5] } } }).success).toBe(false);
    expect(AeTrackMultiSchema.parse({ comp_id: 1, auto_points: { region: { rect: [0, 0, 5, 5] } } }).auto_points!.count).toBe(6);
  });

  it("a track source names exactly one place", () => {
    expect(TrackSourceSchema.safeParse({ track_id: "a" }).success).toBe(true);
    expect(TrackSourceSchema.safeParse({ nulls: [{ index: 1 }], model: "translate" }).success).toBe(true);
    expect(TrackSourceSchema.safeParse({ nulls: [] }).success).toBe(false);
    expect(TrackSourceSchema.safeParse({ nulls: new Array(9).fill({ index: 1 }) }).success).toBe(false);
    expect(TrackSourceSchema.safeParse({}).success).toBe(false);
    expect(TrackSourceSchema.safeParse({ track_id: "a", transform: { layer: { index: 1 } } }).success).toBe(false);
    expect(TrackSourceSchema.safeParse({ corner_pin: { layer: { index: 2 } } }).success).toBe(true);
    expect(TrackSourceSchema.safeParse({ tracker: { layer: { name: "Plate" }, points: ["Track Point 1"] } }).success).toBe(true);
  });

  it("ae_track_apply needs a layer for every mode but nulls, and expect", () => {
    const base = { comp_id: 1, track: { track_id: "a" }, expect: expectArg };
    expect(AeTrackApplySchema.safeParse({ ...base, mode: "nulls" }).success).toBe(true);
    expect(AeTrackApplySchema.safeParse({ ...base, mode: "corner_pin" }).success).toBe(false);
    expect(AeTrackApplySchema.safeParse({ ...base, mode: "corner_pin", layer: { index: 1 } }).success).toBe(true);
    expect(AeTrackApplySchema.safeParse({ ...base, mode: "wobble", layer: { index: 1 } }).success).toBe(false);
    expect(AeTrackApplySchema.safeParse({ comp_id: 1, track: { track_id: "a" }, mode: "nulls" }).success).toBe(false);
  });

  it("ae_track_read previews by default", () => {
    expect(AeTrackReadSchema.parse({ comp_id: 1, source: { track_id: "a" } }).preview).toBe(true);
  });

  it("the mutating tools say so in their descriptions", () => {
    expect(planarTools.map((t) => t.name)).toEqual(["ae_track_multi", "ae_track_read", "ae_track_apply"]);
    for (const name of ["ae_track_multi", "ae_track_apply"]) expect(tool(name).description).toContain("Jay may be editing live");
    expect(tool("ae_track_read").description).not.toContain("Jay may be editing live");
  });
});

describe("helpers other groups share", () => {
  it("resolves effect parameters by English name, then by index", () => {
    const params = [
      { index: 1, name: "Blurriness", matchName: "ADBE Gaussian Blur 2-0001", type: "OneD" },
      { index: 2, name: "Blur Dimensions", matchName: "ADBE Gaussian Blur 2-0002", type: "OneD" },
      { index: 3, name: "Parametre", matchName: "x", type: "OneD" },
    ];
    expect(resolveEffectParams(params, { blur: { names: ["blurriness"], index: 9 }, dims: { names: ["Dimensions"], index: 2 }, gone: { names: ["Nope"], index: 9 }, none: { names: ["Nope"] } })).toEqual({
      blur: 1,
      dims: 2,
      gone: null,
      none: null,
    });
  });

  it("converts Gaussian sigma and Blurriness both ways", () => {
    expect(blurrinessFromSigma(4)).toBe(10);
    expect(sigmaFromBlurriness(blurrinessFromSigma(7.3))).toBeCloseTo(7.3, 9);
  });

  it("names the plates folder next to the project and refuses an unsaved one", () => {
    const p = path.join("D:", "jobs", "spot.aep");
    expect(platesFolderFor(p)).toBe(path.join("D:", "jobs", "spot chroma plates") + path.sep);
    expect(() => platesFolderFor("<unsaved>")).toThrow(/not been saved/);
    expect(() => platesFolderFor("")).toThrow();
  });

  it("a render budget runs out by renders or by seconds", () => {
    const b = createRenderBudget({ maxRenders: 2, maxSeconds: 60 });
    expect(b.exhausted()).toBe(false);
    b.spend();
    b.spend();
    expect(b.exhausted()).toBe(true);
    expect(b.used.renders).toBe(2);
    vi.useFakeTimers();
    try {
      const t = createRenderBudget({ maxRenders: 100, maxSeconds: 5 });
      vi.setSystemTime(Date.now() + 6000);
      expect(t.exhausted()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sizes the default point spacing from the region's own bounding box", () => {
    expect(regionLongerSide({ rect: [0, 0, 80, 200] })).toBe(200);
    expect(regionLongerSide({ ellipse: [50, 50, 30, 10] })).toBe(60);
    expect(regionLongerSide({ polygon: [[10, 10], [210, 40], [100, 90]] })).toBe(200);
  });

  it("keeps the perspective terms of H at full relative precision in the summary rows", () => {
    const t: PlanarTrack = {
      version: 1,
      track_id: "trk_prec",
      comp_id: 1,
      comp_size: [W, H],
      fps: 10,
      ref_time: 0,
      model: "perspective",
      ref_points: [[1, 1]],
      frames: [{ time: 0, ok: true, H: [1, 0, 0, 0, 1, 0, 0.0000123456789, 0.0000234567891, 1], points: [[1, 1]], confidence: [1], rms_px: 0, inliers: 1 }],
      source: "s",
      created: "c",
    };
    const row = (trackSummary(t).frame_rows as any[])[0];
    expect(row[4][6]).toBeCloseTo(0.0000123456789, 12);
    expect(row[4][7]).toBeCloseTo(0.0000234567891, 12);
  });

  it("builds a region mask with an excluded area grown by a margin", () => {
    const mask = regionMask(100, 100, 1, { rect: [10, 10, 80, 80] }, [{ ellipse: [50, 50, 10, 10] }], 5);
    expect(mask[5 * 100 + 5]).toBe(0);
    expect(mask[20 * 100 + 20]).toBe(1);
    expect(mask[50 * 100 + 50]).toBe(0);
    expect(mask[50 * 100 + 63]).toBe(0);
    expect(mask[50 * 100 + 70]).toBe(1);
    const poly = regionMask(60, 60, 2, { polygon: [[0, 0], [30, 0], [0, 30]] }, [], 0);
    expect(poly[10 * 60 + 10]).toBe(1);
    expect(poly[50 * 60 + 50]).toBe(0);
  });

  it("reads other channels", () => {
    const png = new PNG({ width: 1, height: 1 });
    png.data.set([200, 100, 50, 255]);
    expect(channelGray(png, "red").data[0]).toBe(200);
    expect(channelGray(png, "green").data[0]).toBe(100);
    expect(channelGray(png, "blue").data[0]).toBe(50);
    expect(channelGray(png, "saturation").data[0]).toBeCloseTo(191.25, 3);
  });
});

describe("the track store", () => {
  const mk = (id: string): PlanarTrack => ({
    version: 1,
    track_id: id,
    comp_id: 1,
    comp_size: [W, H],
    fps: 10,
    ref_time: 0,
    model: "translate",
    ref_points: [[1, 2]],
    frames: [{ time: 0, ok: true, H: identityH(), points: [[1, 2]], confidence: [1], rms_px: 0, inliers: 1 }],
    source: "test",
    created: "now",
  });

  it("saves under the tracks folder and loads it back", () => {
    const file = saveTrack(mk("trk_store_1"));
    expect(path.dirname(file)).toBe(tracksDir());
    expect(tracksDir().startsWith(dataDir)).toBe(true);
    expect(loadTrack("trk_store_1")?.ref_points).toEqual([[1, 2]]);
    expect(fs.readdirSync(tracksDir()).some((n) => n.endsWith(".tmp"))).toBe(false);
  });

  it("refuses ids that could leave the folder, and files that are not tracks", () => {
    expect(loadTrack("../quarantine")).toBeNull();
    expect(loadTrack("a/b")).toBeNull();
    expect(loadTrack("nope_not_there")).toBeNull();
    expect(() => saveTrack(mk("../x"))).toThrow(/Bad track id/);
    fs.writeFileSync(path.join(tracksDir(), "junk.json"), "{ not json");
    expect(loadTrack("junk")).toBeNull();
    fs.writeFileSync(path.join(tracksDir(), "other.json"), JSON.stringify({ version: 2 }));
    expect(loadTrack("other")).toBeNull();
  });
});

// ---------- tracks from sampled points ----------

describe("trackFromSeries", () => {
  const times = [0, 0.1, 0.2, 0.3];
  const ref: Vec2[] = [[100, 100], [300, 100], [300, 250], [100, 250]];
  const moved = (h: Mat3) => ref.map((p) => applyH(h, p) as Vec2);

  it("solves H per frame from the reference frame's points", () => {
    const hs = [identityH(), rot(0, 1, 10, 0), rot(5, 1, 10, 4), rot(0, 1, 0, 0)];
    const t = trackFromSeries({ compId: 1, compSize: [640, 360], fps: 10, times, series: hs.map(moved), model: "similarity", source: "read:nulls" });
    expect(t.ref_time).toBe(0);
    close(t.frames[2].H!, rot(5, 1, 10, 4), 1e-6);
    expect(t.frames.every((f) => f.ok)).toBe(true);
    expect(t.track_id).toMatch(/^trk_/);
  });

  it("uses the requested frame as the identity and keeps it exact", () => {
    const hs = [identityH(), rot(0, 1, 10, 0), rot(0, 1, 20, 0), rot(0, 1, 30, 0)];
    const t = trackFromSeries({ compId: 1, compSize: [640, 360], fps: 10, times, series: hs.map(moved), model: "translate", refTime: 0.2, source: "s" });
    expect(t.ref_time).toBe(0.2);
    expect(t.frames[2].H).toEqual(identityH());
    close(t.frames[0].H!, rot(0, 1, -20, 0));
  });

  it("flags a frame whose points collapse and refuses a model with too few points", () => {
    const series = [moved(identityH()), ref.map(() => [100, 100] as Vec2)];
    const t = trackFromSeries({ compId: 1, compSize: [640, 360], fps: 10, times: [0, 0.1], series, model: "similarity", source: "s" });
    expect(t.frames[1].ok).toBe(false);
    expect(t.frames[1].H).toBeNull();
    expect(() => trackFromSeries({ compId: 1, compSize: [640, 360], fps: 10, times: [0], series: [[[1, 1]]], model: "affine", source: "s" })).toThrow(/at least 3/);
    expect(() => trackFromSeries({ compId: 1, compSize: [640, 360], fps: 10, times: [], series: [], model: "translate", source: "s" })).toThrow(/no frames/);
  });

  it("scales a tracker's 0-100 confidence to 0..1", () => {
    const t = trackFromSeries({
      compId: 1,
      compSize: [640, 360],
      fps: 10,
      times: [0, 0.1],
      series: [[[1, 1]], [[2, 1]]],
      confidence: [[100], [80]],
      model: "translate",
      source: "s",
    });
    expect(t.frames[1].confidence).toEqual([0.8]);
  });
});

// ---------- what gets written ----------

const sample = (o: Partial<{ anchor: Vec2; position: Vec2; scale: Vec2; rotation: number; parent: Mat3 | null }> = {}): LayerSample => {
  const s = layerSampleOf({ time: 0, anchor: o.anchor ?? [0, 0], position: o.position ?? [0, 0], scale: o.scale ?? [100, 100], rotation: o.rotation ?? 0, parent_chain: [], three_d: false });
  if (o.parent) {
    return { ...s, parents: o.parent, full: mulH(o.parent, mulH(s.parents, s.full)) };
  }
  return s;
};

const okFrame = (time: number, H: Mat3): PlanarFrame => ({ time, ok: true, H, points: [null], confidence: [null], rms_px: 0, inliers: 1 });

describe("buildLayerKeys", () => {
  const ref = sample({ position: [200, 100], anchor: [50, 50], scale: [50, 50] });
  const frames = [okFrame(0.1, rot(0, 1, 12, -4)), okFrame(0.2, rot(10, 1, 30, 8)), okFrame(0.3, [1, 0, 5, 0, 1, 5, 0.0002, 0, 1])];
  const same = (time: number) => sample({ position: [200, 100], anchor: [50, 50], scale: [50, 50] });

  it("a corner pin lands the layer's corners where the track moved them", () => {
    const k = buildLayerKeys({ mode: "corner_pin", frames, ref, samples: frames.map((f) => same(f.time)), size: [100, 100] });
    expect(k.skipped).toEqual([]);
    expect(k.times).toEqual([0.1, 0.2, 0.3]);
    frames.forEach((f, i) => {
      const M = ref.full;
      const pin: Vec2[] = [k.pin!.ul[i], k.pin!.ur[i], k.pin!.ll[i], k.pin!.lr[i]];
      const corners: Vec2[] = [[0, 0], [100, 0], [0, 100], [100, 100]];
      corners.forEach((c, j) => {
        // The pin corner, drawn through the layer's own transform, must be at H . M(ref) . corner.
        const got = applyH(M, pin[j]) as Vec2;
        const want = applyH(mulH(f.H!, M), c) as Vec2;
        expect(Math.hypot(got[0] - want[0], got[1] - want[1])).toBeLessThan(0.01);
      });
    });
  });

  it("a corner pin takes the layer's own animated transform at each frame into account", () => {
    const moving = frames.map((f, i) => sample({ position: [200 + i * 10, 100], anchor: [50, 50], scale: [50, 50], rotation: i * 3 }));
    const k = buildLayerKeys({ mode: "corner_pin", frames, ref, samples: moving, size: [100, 100] });
    frames.forEach((f, i) => {
      const pin: Vec2 = k.pin!.ul[i];
      const got = applyH(moving[i].full, pin) as Vec2;
      const want = applyH(mulH(f.H!, ref.full), [0, 0]) as Vec2;
      expect(Math.hypot(got[0] - want[0], got[1] - want[1])).toBeLessThan(0.01);
    });
  });

  it("transform keys follow a similarity track: position, rotation and scale about the kept anchor", () => {
    const track = [okFrame(0.1, rot(0, 1, 12, -4)), okFrame(0.2, rot(30, 2, 0, 0))];
    const k = buildLayerKeys({ mode: "transform", frames: track, ref, samples: track.map((f) => same(f.time)), size: [100, 100] });
    expect(k.pin).toBeUndefined();
    expect(k.max_fit_px).toBeLessThan(0.01);
    close(k.transform!.position[0], [212, 96], 0.01);
    expect(k.transform!.rotation[0]).toBeCloseTo(0, 6);
    close(k.transform!.scale[0], [50, 50], 0.01);
    expect(k.transform!.rotation[1]).toBeCloseTo(30, 4);
    close(k.transform!.scale[1], [100, 100], 0.01);
  });

  it("transform_pin splits the track: similarity on the transform, the rest in the pin", () => {
    const k = buildLayerKeys({ mode: "transform_pin", frames: [frames[2]], ref, samples: [same(0.3)], size: [100, 100] });
    expect(k.transform).toBeDefined();
    expect(k.pin).toBeDefined();
    expect(k.max_fit_px).toBeGreaterThan(0);
    // Transform plus pin together still land the corners on the full track.
    const t = k.transform!;
    const M = mulH(identityH(), (() => {
      const s = sample({ position: t.position[0], anchor: [50, 50], scale: t.scale[0], rotation: t.rotation[0] });
      return s.full;
    })());
    const corners: Vec2[] = [[0, 0], [100, 0], [0, 100], [100, 100]];
    const pin: Vec2[] = [k.pin!.ul[0], k.pin!.ur[0], k.pin!.ll[0], k.pin!.lr[0]];
    corners.forEach((c, j) => {
      const got = applyH(M, pin[j]) as Vec2;
      const want = applyH(mulH(frames[2].H!, ref.full), c) as Vec2;
      expect(Math.hypot(got[0] - want[0], got[1] - want[1])).toBeLessThan(0.01);
    });
  });

  it("unwraps rotation across the 180 degree seam and skips frames it cannot convert", () => {
    const spin = [okFrame(0.1, rot(170, 1, 0, 0)), okFrame(0.2, rot(190, 1, 0, 0)), { ...okFrame(0.3, rot(0, 1, 0, 0)), H: null, ok: false }];
    const k = buildLayerKeys({ mode: "transform", frames: spin, ref: sample({}), samples: spin.map(() => sample({})), size: [100, 100] });
    expect(k.transform!.rotation[0]).toBeCloseTo(170, 4);
    expect(k.transform!.rotation[1]).toBeCloseTo(190, 4);
    expect(k.skipped).toEqual([0.3]);
  });

  it("carries an existing pin's placement at ref_time instead of the layer's plain rectangle", () => {
    const placed: Vec2[] = [[10, 20], [90, 15], [8, 85], [95, 90]];
    const fr = [okFrame(0.1, rot(0, 1, 12, -4))];
    const plain = buildLayerKeys({ mode: "corner_pin", frames: fr, ref, samples: [same(0.1)], size: [100, 100] });
    const withPin = buildLayerKeys({ mode: "corner_pin", frames: fr, ref, samples: [same(0.1)], size: [100, 100], refPin: placed });
    // A pure translation of the comp moves each placed point by the same layer-space shift as the rectangle's corners.
    const shift = [plain.pin!.ul[0][0] - 0, plain.pin!.ul[0][1] - 0];
    expect(withPin.pin!.ul[0][0]).toBeCloseTo(10 + shift[0], 3);
    expect(withPin.pin!.lr[0][1]).toBeCloseTo(90 + shift[1], 3);
    expect(withPin.pin!.ur[0]).not.toEqual(plain.pin!.ur[0]);
    // At the reference frame itself the placement comes back unchanged.
    const atRef = buildLayerKeys({ mode: "corner_pin", frames: [okFrame(0, identityH())], ref, samples: [same(0)], size: [100, 100], refPin: placed });
    expect(atRef.pin!.ul[0]).toEqual([10, 20]);
    expect(atRef.pin!.lr[0]).toEqual([95, 90]);
  });

  it("follows an animated Anchor Point: the position is solved around the anchor of that frame", () => {
    const r = sample({ position: [100, 100], anchor: [0, 0] });
    const moved = sample({ position: [100, 100], anchor: [10, 0] });
    const k = buildLayerKeys({ mode: "transform", frames: [okFrame(0.1, identityH())], ref: r, samples: [moved], size: [100, 100] });
    // The layer must not move on an identity track: with the anchor now at x=10 the position has to move with it.
    expect(k.transform!.position[0]).toEqual([110, 100]);
  });

  it("skips a frame whose pin corner lands behind the plane", () => {
    const bad = okFrame(0.1, [1, 0, 0, 0, 1, 0, -0.05, 0, 1]);
    const k = buildLayerKeys({ mode: "corner_pin", frames: [bad, okFrame(0.2, identityH())], ref: sample({}), samples: [sample({}), sample({})], size: [100, 100] });
    expect(k.skipped).toEqual([0.1]);
    expect(k.times).toEqual([0.2]);
  });
});

describe("buildNullKeys", () => {
  const track: PlanarTrack = {
    version: 1,
    track_id: "t",
    comp_id: 1,
    comp_size: [W, H],
    fps: 10,
    ref_time: 0,
    model: "similarity",
    ref_points: [[100, 100], [200, 100]],
    frames: [],
    source: "s",
    created: "c",
  };
  const frames: PlanarFrame[] = [
    { time: 0, ok: true, H: identityH(), points: [[100, 100], [200, 100]], confidence: [1, 1], rms_px: 0, inliers: 2 },
    { time: 0.1, ok: true, H: rot(170, 1, 0, 0), points: [null, [210, 100]], confidence: [null, 1], rms_px: 0, inliers: 1 },
    { time: 0.2, ok: true, H: rot(190, 1, 0, 0), points: [[100, 100], [200, 100]], confidence: [1, 1], rms_px: 0, inliers: 2 },
  ];

  it("makes a null per point, falling back to H for a missing position", () => {
    const n = buildNullKeys({ track, frames, prefix: "Plate", solved: false });
    expect(n.map((x) => x.name)).toEqual(["Plate 1", "Plate 2"]);
    close(n[0].position[1], applyH(rot(170, 1, 0, 0), [100, 100]) as Vec2, 1e-2);
    expect(n[1].position[1]).toEqual([210, 100]);
  });

  it("adds a solved null with unwrapped rotation", () => {
    const n = buildNullKeys({ track, frames, prefix: "Plate", solved: true });
    const solved = n[2];
    expect(solved.name).toBe("Plate solved");
    expect(solved.rotation![0]).toBeCloseTo(0, 6);
    expect(solved.rotation![1]).toBeCloseTo(170, 4);
    expect(solved.rotation![2]).toBeCloseTo(190, 4);
    expect(solved.scale![1]).toEqual([100, 100]);
  });
});

describe("keyMismatches", () => {
  const expected = [
    { layerId: 7, kind: "transform" as const, role: "position", keys: 2, samples: [{ time: 0, value: [10, 20] }, { time: 0.1, value: [11, 21] }] },
  ];
  const written = { nulls: [], written: [{ layer_index: 1, layer_id: 7, target: "transform", props: [{ role: "position", name: "Position", numKeys: 2 }] }] };
  const after = { items: [{ layer_id: 7, found: true, props: [{ role: "position", numKeys: 2, samples: [{ time: 0, value: [10, 20, 0] }, { time: 0.1, value: [11, 21, 0] }] }] }] };

  it("accepts a matching read-back (3-vectors included)", () => {
    expect(keyMismatches(expected, written, after)).toEqual([]);
  });

  it("flags a wrong count, a wrong value and a missing property", () => {
    const wrongCount = { ...written, written: [{ ...written.written[0], props: [{ role: "position", name: "Position", numKeys: 1 }] }] };
    expect(keyMismatches(expected, wrongCount, after).map((m) => m.path)).toEqual(["7.position.numKeys"]);
    const wrongValue = { items: [{ layer_id: 7, found: true, props: [{ role: "position", numKeys: 2, samples: [{ time: 0, value: [10, 20, 0] }, { time: 0.1, value: [12, 21, 0] }] }] }] };
    expect(keyMismatches(expected, written, wrongValue).map((m) => m.path)).toEqual(["7.position@0.1"]);
    expect(keyMismatches(expected, written, { items: [] }).map((m) => m.path)).toEqual(["7.position"]);
    expect(keyMismatches(expected, written, null)).toEqual([]);
  });
});

// ---------- the tools against a fake AE ----------

interface Call {
  fn: string;
  args: any;
  script: string;
}

const COPY_ID = 900;

interface AeOpts {
  comp?: Record<string, unknown>;
  failRenders?: boolean;
  failRendersOnCopy?: boolean;
  failEnd?: boolean;
  layers?: Array<{ index: number; id: number; name: string; locked?: boolean; three_d?: boolean }>;
  read?: Record<string, unknown>;
  layerWidth?: number;
  breakWrite?: boolean;
  noAfter?: boolean;
  /** An existing pin's four points at ref_time, returned by the read before the write. */
  refPin?: Record<"ul" | "ur" | "ll" | "lr", number[]>;
  /** planarItemExists answers true: the copy is still there after its removal. */
  copyStays?: boolean;
}

function fakeAe(opts: AeOpts = {}) {
  const calls: Call[] = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-planar-q-"));
  tmpDirs.push(dir);
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
  const layers = opts.layers ?? [{ index: 1, id: 100, name: "Plate" }];
  let lastWrite: any = null;
  const host = new PanelHost({
    evalScript: async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      const args = JSON.parse(script.slice(script.indexOf("(") + 1, script.lastIndexOf(")")));
      calls.push({ fn, args, script });
      const ok = (result: unknown) => ({ ok: true, result, durationMs: 1 });
      if (fn === "checkGuard") return ok({ ok: true, project_path: "<unsaved>", comp_id: 1, comp_is_valid: true });
      if (fn === "planarComp") {
        const wanted = (args.layers ?? []).map((sel: any) => layers.find((l) => (sel.index !== undefined ? l.index === sel.index : l.id === sel.id)) ?? layers[0]);
        return ok({
          id: 1,
          name: "Main",
          width: W,
          height: H,
          pixel_aspect: 1,
          fps: 10,
          frame_duration: 0.1,
          duration: 1,
          time: 0.5,
          work_area_start: 0,
          work_area_duration: 1,
          num_layers: layers.length,
          layers: wanted.map((l: any) => ({ locked: false, enabled: true, three_d: false, ...l })),
          ...opts.comp,
        });
      }
      if (fn === "snapshotFrame") {
        if (opts.failRenders || (opts.failRendersOnCopy && args.comp_id === COPY_ID)) throw new Error("render failed");
        const k = Math.round(args.time * 10);
        fs.mkdirSync(path.dirname(args.output_path), { recursive: true });
        fs.writeFileSync(args.output_path, PNG.sync.write(frameAtK(k)));
        return ok({ path: args.output_path, time: args.time });
      }
      if (fn === "planarIsolateBegin") return ok({ copy_id: COPY_ID, copy_name: "_chroma_plate_Main", original_id: 1 });
      if (fn === "planarIsolateEnd") {
        if (opts.failEnd) throw new Error("item is locked");
        return ok({ removed: true, copy_id: COPY_ID });
      }
      if (fn === "planarRead") return ok(opts.read);
      if (fn === "planarItemExists") return ok({ exists: opts.copyStays === true, item_id: args.item_id });
      if (fn === "planarLayerSpace") {
        return ok({
          layer: layers[0],
          width: opts.layerWidth ?? 100,
          height: opts.layerWidth ?? 100,
          samples: args.times.map((t: number) => ({ time: t, anchor: [0, 0], position: [0, 0], scale: [100, 100], rotation: 0, parent_chain: [], three_d: false })),
        });
      }
      if (fn === "planarApply") {
        lastWrite = args;
        const nulls = (args.new_nulls ?? []).map((n: any, i: number) => ({
          layer_id: 500 + i,
          layer_index: 1,
          name: n.name,
          props: ["position", "rotation", "scale"].filter((r) => n[r]).map((r) => ({ role: r, name: r, numKeys: n[r].length })),
        }));
        const written = args.writes.map((w: any) => ({
          layer_index: w.layer_index,
          layer_id: w.layer_id,
          target: w.target,
          effect_index: 2,
          effect_added: w.target === "corner_pin" || w.target === "power_pin",
          slot_moved: false,
          slot_wanted: 2,
          props: Object.keys(w.values).map((r) => ({ role: r, name: r, numKeys: w.values[r].length - (opts.breakWrite && r === "ul" ? 1 : 0) })),
        }));
        return ok({ nulls, written });
      }
      if (fn === "planarKeys") {
        if (opts.refPin && !calls.some((c) => c.fn === "planarApply")) {
          return ok({
            items: args.items.map((it: any) => ({
              layer_id: it.layer_id,
              found: true,
              effect_found: true,
              props: (["ul", "ur", "ll", "lr"] as const).map((r) => ({ role: r, numKeys: 0, samples: it.times.map((t: number) => ({ time: t, value: opts.refPin![r] })) })),
            })),
          });
        }
        if (opts.noAfter && !calls.some((c) => c.fn === "planarApply")) return ok({ items: [] });
        const items = args.items.map((it: any) => {
          const w = lastWrite?.writes?.find((x: any) => x.layer_id === it.layer_id && (it.kind === "transform" ? x.target === "transform" : x.target === it.kind));
          const n = lastWrite?.new_nulls?.[it.layer_id - 500];
          const src = n ?? w?.values;
          const times = n ? n.times : w?.times;
          if (!src) return { layer_id: it.layer_id, found: true, props: [] };
          return {
            layer_id: it.layer_id,
            found: true,
            props: Object.keys(src)
              .filter((r) => Array.isArray(src[r]) && r !== "times" && r !== "name")
              .map((r) => ({
                role: r,
                numKeys: src[r].length,
                samples: it.times.map((t: number) => {
                  const i = times.findIndex((x: number) => Math.abs(x - t) < 1e-6);
                  const v = src[r][i];
                  return { time: t, value: Array.isArray(v) ? [...v, 0].slice(0, Math.max(2, v.length)) : v };
                }),
              })),
          };
        });
        return ok({ items });
      }
      throw new Error(`Unexpected script: ${script}`);
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge: host, queue, quarantine };
  return { ctx, calls, fns: () => calls.map((c) => c.fn) };
}

type Out = Record<string, any>;
const multi = (extra: Record<string, unknown>) => AeTrackMultiSchema.parse({ comp_id: 1, points: POINTS, preview: false, ...extra });

describe("ae_track_multi", () => {
  it("tracks both ways from the reference, writes the track, and reports a preview", async () => {
    const { ctx, calls } = fakeAe();
    const out = (await tool("ae_track_multi").handler(multi({ preview: true }), ctx)) as Out;
    expect(out.ok).toBe(true);
    expect(out.complete).toBe(true);
    expect(out.ref_time).toBe(0.5);
    expect(out.model).toBe("similarity");
    expect(out.frames).toBe(10);
    expect(out.frames_ok).toBe(10);
    expect(out.first_time).toBe(0);
    expect(out.last_time).toBe(0.9);
    expect(out.rms_px.max).toBeLessThan(0.6);
    expect(out.directions.forward.stop.reason).toBe("end");
    expect(out.directions.backward.stop.reason).toBe("end");
    expect(fs.existsSync(out.preview_path)).toBe(true);
    expect(fs.existsSync(out.track_path)).toBe(true);
    expect(out.frame_rows).toHaveLength(10);
    // Read-only: no write host was called, and the frames were rendered from the comp itself.
    expect(calls.filter((c) => c.fn === "snapshotFrame").every((c) => c.args.comp_id === 1)).toBe(true);
    expect(calls.some((c) => /Isolate|Apply|Write/.test(c.fn))).toBe(false);
    const stored = loadTrack(out.track_id)!;
    const last = stored.frames[stored.frames.length - 1];
    const want = applyH(motion(9), POINTS[1]) as Vec2;
    const got = applyH(last.H!, POINTS[1]) as Vec2;
    expect(Math.hypot(want[0] - got[0], want[1] - got[1])).toBeLessThan(0.5);
    expect(stored.frames.find((f) => f.time === 0.5)?.H).toEqual(identityH());
  }, 30000);

  it("stops at the render budget with next/continue, resumes exactly, and a restart rebuilds from disk", async () => {
    const whole = (await tool("ae_track_multi").handler(multi({}), fakeAe().ctx)) as Out;
    const { ctx, calls } = fakeAe();
    const a = (await tool("ae_track_multi").handler(multi({ max_frames: 3 }), ctx)) as Out;
    expect(a.complete).toBe(false);
    expect(a.next).toEqual({ direction: "forward", time: 0.8 });
    expect(a.continue_track_id).toBe(a.track_id);
    expect(a.frames).toBe(3);
    expect(a.budget.renders_this_call).toBe(3);
    const before = calls.filter((c) => c.fn === "snapshotFrame").length;
    const b = (await tool("ae_track_multi").handler(AeTrackMultiSchema.parse({ comp_id: 1, continue_track_id: a.track_id, preview: false }), ctx)) as Out;
    expect(b.complete).toBe(true);
    // The live trackers were kept: the reference frame was not rendered again.
    expect(calls.filter((c) => c.fn === "snapshotFrame").length - before).toBe(7);
    const x = loadTrack(whole.track_id)!;
    const y = loadTrack(b.track_id)!;
    expect(y.frames.map((f) => f.H)).toEqual(x.frames.map((f) => f.H));

    // A panel restart empties the cache: the same job rebuilds its trackers from the file.
    const c1 = (await tool("ae_track_multi").handler(multi({ max_frames: 4 }), fakeAe().ctx)) as Out;
    vi.resetModules();
    const fresh = await import("../src/tools/ext/planar.js");
    const freshCtx = fakeAe();
    const c2 = (await fresh.planarTools[0].handler(fresh.AeTrackMultiSchema.parse({ comp_id: 1, continue_track_id: c1.track_id, preview: false }), freshCtx.ctx)) as Out;
    expect(c2.complete).toBe(true);
    expect(freshCtx.calls.filter((c) => c.fn === "snapshotFrame").length).toBe(1 + 6);
    const z = loadTrack(c1.track_id)!;
    z.frames.forEach((f, i) => close(f.H!, x.frames[i].H!, 0.05));
  }, 60000);

  it("cuts a long range around ref_time, never moving the reference frame", async () => {
    const { ctx } = fakeAe({ comp: { duration: 400, work_area_start: 0, work_area_duration: 400, time: 0 } });
    const out = (await tool("ae_track_multi").handler(multi({ ref_time: 300, max_frames: 1 }), ctx)) as Out;
    expect(out.ok).toBe(true);
    expect(out.ref_time).toBe(300);
    const t = loadTrack(out.track_id)!;
    expect(t.ref_time).toBe(300);
    const range = t.tracking!.range;
    expect(range.start).toBeLessThanOrEqual(300);
    expect(range.end).toBeGreaterThanOrEqual(300);
    expect(Math.round((range.end - range.start) * 10) + 1).toBeLessThanOrEqual(3000);
    expect(out.notes.join(" ")).toMatch(/around ref_time 300/);
  }, 30000);

  it("a continued track after a restart does not spend its budget on the rebuilt reference frame", async () => {
    const first = (await tool("ae_track_multi").handler(multi({ max_frames: 3 }), fakeAe().ctx)) as Out;
    vi.resetModules();
    const fresh = await import("../src/tools/ext/planar.js");
    const ae = fakeAe();
    const next = (await fresh.planarTools[0].handler(fresh.AeTrackMultiSchema.parse({ comp_id: 1, continue_track_id: first.track_id, max_frames: 1, preview: false }), ae.ctx)) as Out;
    expect(next.ok).toBe(true);
    // One render for the reference frame (not charged) and one tracked frame.
    expect(ae.calls.filter((c) => c.fn === "snapshotFrame").length).toBe(2);
    expect(next.budget.renders_this_call).toBe(1);
    expect(next.budget.rebuild_renders).toBe(1);
    expect(next.frames).toBe(first.frames + 1);
  }, 30000);

  it("a rebuilt continued call still tracks one frame when the rebuild render used up max_seconds", async () => {
    const first = (await tool("ae_track_multi").handler(multi({ max_frames: 3 }), fakeAe().ctx)) as Out;
    expect(first.complete).toBe(false);
    vi.resetModules();
    const fresh = await import("../src/tools/ext/planar.js");
    const ae = fakeAe();
    const host = ae.ctx.bridge as any;
    const orig = host.evalRaw.bind(host);
    // Only the budget's clock jumps: the rebuild render is "slow" (10 s against max_seconds 5), and the PNG it wrote is dated to match so the stale-frame check still passes.
    const realNow = Date.now.bind(Date);
    let skew = 0;
    host.evalRaw = async (p: any) => {
      const res = await orig(p);
      if (typeof p.script === "string" && p.script.startsWith("__chromaAe.snapshotFrame(")) {
        const a = JSON.parse(p.script.slice(p.script.indexOf("(") + 1, p.script.lastIndexOf(")")));
        if (skew === 0) skew = 10000;
        const when = (realNow() + skew) / 1000;
        fs.utimesSync(a.output_path, when, when);
      }
      return res;
    };
    const spy = vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew);
    try {
      const next = (await fresh.planarTools[0].handler(
        fresh.AeTrackMultiSchema.parse({ comp_id: 1, continue_track_id: first.track_id, max_seconds: 5, preview: false }),
        ae.ctx
      )) as Out;
      expect(next.ok).toBe(true);
      expect(next.budget.rebuild_renders).toBe(1);
      // The old loop saw an exhausted budget at once and returned the same `next` for ever.
      expect(next.frames).toBe(first.frames + 1);
      expect(next.next).not.toEqual(first.next);
      expect(next.complete).toBe(false);
    } finally {
      spy.mockRestore();
    }
  }, 30000);

  it("registers each isolate write under its own id, so the session hook leaves them alone, and reads the copy's removal back", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-planar-sess-"));
    tmpDirs.push(dir);
    const tracker = installSessionTracking({ dataDir: dir });
    try {
      const ae = fakeAe();
      const host = ae.ctx.bridge as any;
      const orig = host.evalRaw.bind(host);
      const seen: Record<string, boolean> = {};
      host.evalRaw = (p: any) => {
        if (/_isolate$|_unisolate$/.test(p.id)) seen[p.id.replace(/^.*_(un)?isolate$/, "$1isolate")] = tracker.isInflight(p.id);
        return orig(p);
      };
      const out = (await tool("ae_track_multi").handler(multi({ isolate_layers: [{ index: 1 }], expect: expectArg, start: 0.4, end: 0.6 }), ae.ctx)) as Out;
      expect(out.ok).toBe(true);
      expect(seen).toEqual({ isolate: true, unisolate: true });
      const order = ae.fns();
      expect(order.indexOf("planarItemExists")).toBeGreaterThan(order.indexOf("planarIsolateEnd"));
      expect(out.temp_comp).toEqual({ copy_removed: true });
    } finally {
      resetSessionTracking();
    }
  }, 30000);

  it("takes the temp comp as removed only when a separate read agrees", async () => {
    const stays = fakeAe({ copyStays: true });
    const out = (await tool("ae_track_multi").handler(multi({ isolate_layers: [{ index: 1 }], expect: expectArg, start: 0.4, end: 0.6 }), stays.ctx)) as Out;
    expect(out.temp_comp.copy_removed).toBe(false);
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches[0].message).toMatch(/_chroma_plate_/);
  }, 30000);

  it("picks the points itself and says which", async () => {
    const { ctx } = fakeAe();
    const out = (await tool("ae_track_multi").handler(
      multi({ points: undefined, auto_points: { region: { rect: [30, 20, 180, 120] }, exclude: [{ ellipse: [120, 80, 30, 30] }], count: 5, min_distance_px: 25 }, start: 0.4, end: 0.6 }),
      ctx
    )) as Out;
    expect(out.ok).toBe(true);
    expect(out.points.length).toBeGreaterThanOrEqual(3);
    for (const p of out.points) {
      expect(p.auto).toBe(true);
      expect(Math.hypot(p.x - 120, p.y - 80)).toBeGreaterThan(30);
    }
    expect(out.frames).toBe(3);
  }, 30000);

  it("refuses a comp with non-square pixels, a bad reference time, and too few usable points, before rendering", async () => {
    const odd = fakeAe({ comp: { pixel_aspect: 2 } });
    expect(await tool("ae_track_multi").handler(multi({}), odd.ctx)).toMatchObject({ ok: false, error: "refused" });
    expect(odd.fns()).not.toContain("snapshotFrame");
    const late = fakeAe();
    expect(await tool("ae_track_multi").handler(multi({ ref_time: 5 }), late.ctx)).toMatchObject({ ok: false, error: "bad_args" });
    expect(late.fns()).not.toContain("snapshotFrame");
    const flat = fakeAe();
    const one = (await tool("ae_track_multi").handler(multi({ points: [[300, 300]], model: "similarity" }), flat.ctx)) as Out;
    expect(one.ok).toBe(false);
    const missing = await tool("ae_track_multi").handler(AeTrackMultiSchema.parse({ comp_id: 1, continue_track_id: "trk_missing", preview: false }), flat.ctx);
    expect(missing).toMatchObject({ ok: false, error: "not_found" });
  });

  it("with isolate_layers: guards, renders the plate copy, removes it, and reports it", async () => {
    const { ctx, calls, fns } = fakeAe({ layers: [{ index: 2, id: 101, name: "Plate" }] });
    const out = (await tool("ae_track_multi").handler(multi({ isolate_layers: [{ index: 2 }], expect: expectArg, start: 0.4, end: 0.6 }), ctx)) as Out;
    expect(out.complete).toBe(true);
    const order = fns();
    expect(order.indexOf("checkGuard")).toBeLessThan(order.indexOf("planarIsolateBegin"));
    expect(order.indexOf("planarIsolateBegin")).toBeLessThan(order.indexOf("snapshotFrame"));
    expect(order.lastIndexOf("snapshotFrame")).toBeLessThan(order.indexOf("planarIsolateEnd"));
    expect(calls.find((c) => c.fn === "planarIsolateBegin")!.args.show_layers).toEqual([{ index: 2, id: 101 }]);
    expect(calls.find((c) => c.fn === "planarIsolateBegin")!.args.expect).toMatchObject(expectArg);
    expect(calls.filter((c) => c.fn === "snapshotFrame").every((c) => c.args.comp_id === COPY_ID)).toBe(true);
    expect(out.temp_comp).toEqual({ copy_removed: true });
    expect(out.receipt.matches).toBe(true);
    expect(out.notes.join(" ")).toMatch(/two undo entries/);
  }, 30000);

  it("removes the plate copy even when the renders fail, and reports a copy it could not remove", async () => {
    const failing = fakeAe({ failRendersOnCopy: true });
    // The copy exists, so the failure comes back as a result with the receipt, never as a throw.
    const failed = (await tool("ae_track_multi").handler(multi({ isolate_layers: [{ index: 1 }], expect: expectArg }), failing.ctx)) as Out;
    expect(failed.ok).toBe(false);
    expect(failed.message).toMatch(/render failed/);
    expect(failed.temp_comp.copy_removed).toBe(true);
    expect(failed.receipt.matches).toBe(true);
    expect(failing.fns()).toContain("planarIsolateEnd");

    const stuck = fakeAe({ failEnd: true, copyStays: true });
    const out = (await tool("ae_track_multi").handler(multi({ isolate_layers: [{ index: 1 }], expect: expectArg, start: 0.4, end: 0.6 }), stuck.ctx)) as Out;
    expect(out.temp_comp.copy_removed).toBe(false);
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches[0].message).toMatch(/_chroma_plate_/);
  }, 30000);

  it("a render that fails mid-track keeps what it has and says where to continue", async () => {
    let n = 0;
    const ae = fakeAe();
    const host = ae.ctx.bridge as any;
    const orig = host.evalRaw.bind(host);
    host.evalRaw = (p: any) => {
      if (p.script.includes("snapshotFrame") && ++n === 4) throw new Error("AE said no");
      return orig(p);
    };
    const out = (await tool("ae_track_multi").handler(multi({}), ae.ctx)) as Out;
    expect(out.ok).toBe(true);
    expect(out.complete).toBe(false);
    expect(out.render_error).toMatch(/AE said no/);
    expect(out.continue_track_id).toBe(out.track_id);
    expect(out.frames).toBeGreaterThanOrEqual(3);
  }, 30000);
});

describe("ae_track_read", () => {
  const cornerRead = {
    kind: "corner_pin",
    comp: { width: 640, height: 360, fps: 10 },
    names: ["ul", "ur", "lr", "ll"],
    times: [0, 0.1, 0.2],
    series: [0, 10, 20].map((dx) => [[100 + dx, 100], [300 + dx, 100], [300 + dx, 250], [100 + dx, 250]]),
    truncated: false,
    keyed_frames: 2,
    interpolated_frames: 1,
    off_grid_keys: 1,
    expression_driven: ["pin ul"],
    param_table: [{ role: "ul", name: "Upper Left", matchName: "ADBE Corner Pin-0001", how: "name" }],
    effect: { index: 1, name: "Corner Pin", matchName: "ADBE Corner Pin" },
  };

  it("turns a Corner Pin into a stored perspective track and says what it found", async () => {
    const { ctx, calls } = fakeAe({ read: cornerRead, comp: { width: 640, height: 360 } });
    const out = (await tool("ae_track_read").handler(AeTrackReadSchema.parse({ comp_id: 1, source: { corner_pin: { layer: { index: 1 } } }, preview: false }), ctx)) as Out;
    expect(out.ok).toBe(true);
    expect(out.model).toBe("perspective");
    expect(out.source).toBe("read:corner_pin");
    expect(out.frames).toBe(3);
    expect(calls[calls.length - 1].fn).toBe("planarRead");
    expect(calls[0].args.source).toMatchObject({ kind: "corner_pin", layer: { index: 1 } });
    const stored = loadTrack(out.track_id)!;
    close(stored.frames[2].H!, [1, 0, 20, 0, 1, 0, 0, 0, 1], 1e-6);
    expect(stored).not.toHaveProperty("read_info");
    expect(out.notes.join(" ")).toMatch(/interpolated/);
    expect(out.notes.join(" ")).toMatch(/off the frame grid/);
    expect(out.notes.join(" ")).toMatch(/Expression-driven: pin ul/);
    expect(out.notes.join(" ")).toMatch(/unverified/);
    expect(out.notes.join(" ")).toMatch(/exactly 4 points/);
    expect(out.source_info.param_table[0].how).toBe("name");
  });

  it("changes nothing: reads only, renders the preview from the comp, and writes no project call", async () => {
    const { ctx, calls } = fakeAe({ read: cornerRead, comp: { width: W, height: H } });
    const out = (await tool("ae_track_read").handler(AeTrackReadSchema.parse({ comp_id: 1, source: { corner_pin: { layer: { index: 1 } } } }), ctx)) as Out;
    expect(fs.existsSync(out.preview_path)).toBe(true);
    expect(calls.map((c) => c.fn).filter((f) => f !== "snapshotFrame")).toEqual(["planarRead"]);
  }, 30000);

  it("loads a stored track by id and says when there is none", async () => {
    const { ctx } = fakeAe();
    const made = (await tool("ae_track_read").handler(AeTrackReadSchema.parse({ comp_id: 1, source: { nulls: [{ index: 1 }] }, preview: false }), fakeAe({ read: { ...cornerRead, kind: "nulls", series: cornerRead.series.map((s) => s.slice(0, 1)) } }).ctx)) as Out;
    expect(made.model).toBe("translate");
    const again = (await tool("ae_track_read").handler(AeTrackReadSchema.parse({ comp_id: 1, source: { track_id: made.track_id }, preview: false }), ctx)) as Out;
    expect(again.track_id).toBe(made.track_id);
    expect(await tool("ae_track_read").handler(AeTrackReadSchema.parse({ comp_id: 1, source: { track_id: "trk_nope" }, preview: false }), ctx)).toMatchObject({ ok: false, error: "not_found" });
  });

  it("re-basing a stored track on another ref_time gives it a new id and leaves the stored one as it was", async () => {
    const t: PlanarTrack = {
      version: 1,
      track_id: "trk_rebase_src",
      comp_id: 1,
      comp_size: [W, H],
      fps: 10,
      ref_time: 0,
      model: "translate",
      ref_points: [[100, 100]],
      frames: [0, 1, 2].map((k) => ({ time: k / 10, ok: true, H: rot(0, 1, 10 * k, 0), points: [[100 + 10 * k, 100]], confidence: [1], rms_px: 0, inliers: 1 })),
      source: "ae_track_multi",
      created: "c",
    };
    saveTrack(t);
    const { ctx } = fakeAe();
    const out = (await tool("ae_track_read").handler(AeTrackReadSchema.parse({ comp_id: 1, source: { track_id: "trk_rebase_src", ref_time: 0.1 }, preview: false }), ctx)) as Out;
    expect(out.ok).toBe(true);
    expect(out.track_id).not.toBe("trk_rebase_src");
    expect(out.ref_time).toBe(0.1);
    expect(loadTrack(out.track_id)!.ref_time).toBe(0.1);
    expect(loadTrack("trk_rebase_src")!.ref_time).toBe(0);
    const same = (await tool("ae_track_read").handler(AeTrackReadSchema.parse({ comp_id: 1, source: { track_id: "trk_rebase_src" }, preview: false }), ctx)) as Out;
    expect(same.track_id).toBe("trk_rebase_src");
  });

  it("refuses a model with more points than the source has", async () => {
    const { ctx } = fakeAe({ read: { ...cornerRead, kind: "nulls", series: cornerRead.series.map((s) => s.slice(0, 1)) } });
    expect(await tool("ae_track_read").handler(AeTrackReadSchema.parse({ comp_id: 1, source: { nulls: [{ index: 1 }], model: "affine" }, preview: false }), ctx)).toMatchObject({ ok: false, error: "bad_args" });
  });
});

describe("ae_track_apply", () => {
  const stored = (id: string, dx = 8): PlanarTrack => {
    const frames: PlanarFrame[] = [0, 1, 2, 3].map((k) => ({
      time: k / 10,
      ok: k !== 2,
      H: k === 2 ? null : rot(0, 1, dx * k, k),
      points: [[100 + dx * k, 100 + k], [200 + dx * k, 100 + k]],
      confidence: [1, 1],
      rms_px: 0,
      inliers: 2,
    }));
    const t: PlanarTrack = { version: 1, track_id: id, comp_id: 1, comp_size: [W, H], fps: 10, ref_time: 0, model: "similarity", ref_points: [[100, 100], [200, 100]], frames, source: "ae_track_multi", created: "c" };
    saveTrack(t);
    return t;
  };

  it("an existing pin keeps its placement at ref_time: the write starts from the pin's own points", async () => {
    stored("trk_apply_exist");
    const refPin = { ul: [10, 20], ur: [90, 15], ll: [8, 85], lr: [95, 90] };
    const { ctx, calls } = fakeAe({ refPin });
    const out = (await tool("ae_track_apply").handler(
      AeTrackApplySchema.parse({ comp_id: 1, track: { track_id: "trk_apply_exist" }, mode: "corner_pin", layer: { index: 1 }, effect_index: 2, add_effect: false, expect: expectArg }),
      ctx
    )) as Out;
    expect(out.ok).toBe(true);
    const read = calls.find((c) => c.fn === "planarKeys")!;
    expect(read.args.items[0]).toMatchObject({ kind: "corner_pin", effect_index: 2, times: [0] });
    const write = calls.find((c) => c.fn === "planarApply")!.args.writes[0];
    expect(write.values.ul[0]).toEqual([10, 20]);
    expect(write.values.lr[0]).toEqual([95, 90]);
    expect(out.notes.join(" ")).toMatch(/already on the layer was used as the placement/);
  });

  it("pins a layer: guard, read, write, separate read-back, and a receipt that matches", async () => {
    stored("trk_apply_pin");
    const { ctx, fns, calls } = fakeAe();
    const out = (await tool("ae_track_apply").handler(
      AeTrackApplySchema.parse({ comp_id: 1, track: { track_id: "trk_apply_pin" }, mode: "corner_pin", layer: { index: 1 }, expect: expectArg }),
      ctx
    )) as Out;
    // The existing pin's points at ref_time are read (read-only) before the guard.
    expect(fns()).toEqual(["planarComp", "planarLayerSpace", "planarLayerSpace", "planarKeys", "checkGuard", "planarKeys", "planarApply", "planarKeys"]);
    expect(out.ok).toBe(true);
    expect(out.applied).toBe(true);
    expect(out.receipt.mismatches).toEqual([]);
    expect(out.receipt.matches).toBe(true);
    expect(out.frames_written).toBe(3);
    expect(out.frames_skipped).toEqual([0.2]);
    expect(out.notes.join(" ")).toMatch(/no layer motion blur/);
    const write = calls.find((c) => c.fn === "planarApply")!.args;
    expect(write.writes[0]).toMatchObject({ target: "corner_pin", layer_index: 1, layer_id: 100, add_effect: true, replace_keys: false });
    expect(write.writes[0].times).toEqual([0, 0.1, 0.3]);
    // A layer at the origin: the corners move with the track.
    expect(write.writes[0].values.ul).toEqual([[0, 0], [8, 1], [24, 3]]);
    expect(write.writes[0].values.lr).toEqual([[100, 100], [108, 101], [124, 103]]);
    expect(write.expect).toMatchObject(expectArg);
  });

  it("re-bases to ref_time", async () => {
    stored("trk_apply_ref");
    const { ctx, calls } = fakeAe();
    await tool("ae_track_apply").handler(
      AeTrackApplySchema.parse({ comp_id: 1, track: { track_id: "trk_apply_ref" }, ref_time: 0.1, mode: "transform", layer: { index: 1 }, expect: expectArg }),
      ctx
    );
    const w = calls.find((c) => c.fn === "planarApply")!.args.writes[0];
    expect(w.target).toBe("transform");
    expect(w.times).toEqual([0, 0.1, 0.3]);
    expect(w.values.position[1]).toEqual([0, 0]);
    expect(w.values.position[0]).toEqual([-8, -1]);
    expect(calls.filter((c) => c.fn === "planarLayerSpace")[0].args.times).toEqual([0.1]);
  });

  it("makes nulls without a layer, and a solved one on request", async () => {
    stored("trk_apply_nulls");
    const { ctx, fns, calls } = fakeAe();
    const out = (await tool("ae_track_apply").handler(
      AeTrackApplySchema.parse({ comp_id: 1, track: { track_id: "trk_apply_nulls" }, mode: "nulls", solved_null: true, null_prefix: "Plate", expect: expectArg }),
      ctx
    )) as Out;
    expect(fns()).toEqual(["planarComp", "checkGuard", "planarApply", "planarKeys"]);
    expect(out.nulls.map((n: any) => n.name)).toEqual(["Plate 1", "Plate 2", "Plate solved"]);
    expect(out.receipt.matches).toBe(true);
    const w = calls.find((c) => c.fn === "planarApply")!.args;
    expect(w.writes).toEqual([]);
    expect(w.new_nulls[0].position[1]).toEqual([108, 101]);
    expect(w.new_nulls[2].rotation).toHaveLength(3);
  });

  it("puts what the host's read-back disagrees with into the receipt, never an error", async () => {
    stored("trk_apply_bad");
    const { ctx } = fakeAe({ breakWrite: true });
    const out = (await tool("ae_track_apply").handler(
      AeTrackApplySchema.parse({ comp_id: 1, track: { track_id: "trk_apply_bad" }, mode: "corner_pin", layer: { index: 1 }, expect: expectArg }),
      ctx
    )) as Out;
    expect(out.applied).toBe(true);
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches.map((m: any) => m.path)).toContain("100.ul.numKeys");
  });

  it("keeps a failed read-back out of the error path once the write is in", async () => {
    stored("trk_apply_rb");
    const ae = fakeAe();
    const host = ae.ctx.bridge as any;
    const orig = host.evalRaw.bind(host);
    let applied = false;
    host.evalRaw = (p: any) => {
      if (p.script.includes("planarApply")) applied = true;
      else if (applied && p.script.includes("planarKeys")) throw new Error("AE stopped answering");
      return orig(p);
    };
    const out = (await tool("ae_track_apply").handler(
      AeTrackApplySchema.parse({ comp_id: 1, track: { track_id: "trk_apply_rb" }, mode: "transform", layer: { index: 1 }, expect: expectArg }),
      ae.ctx
    )) as Out;
    expect(out.applied).toBe(true);
    expect(out.receipt.mismatches[0].message).toMatch(/Do not resend/);
  });

  it("refuses before the guard, with nothing written: locked, 3D, size mismatch, no frames, too long", async () => {
    stored("trk_apply_no");
    const base = { comp_id: 1, track: { track_id: "trk_apply_no" }, expect: expectArg };
    const run = async (opts: AeOpts, extra: Record<string, unknown>) => {
      const ae = fakeAe(opts);
      const out = await tool("ae_track_apply").handler(AeTrackApplySchema.parse({ ...base, mode: "corner_pin", layer: { index: 1 }, ...extra }), ae.ctx);
      expect(ae.fns()).not.toContain("planarApply");
      expect(ae.fns()).not.toContain("checkGuard");
      return out;
    };
    expect(await run({ layers: [{ index: 1, id: 100, name: "L", locked: true }] }, {})).toMatchObject({ ok: false, error: "refused", message: expect.stringMatching(/locked/) });
    expect(await run({ layers: [{ index: 1, id: 100, name: "L", three_d: true }] }, {})).toMatchObject({ ok: false, message: expect.stringMatching(/3D/) });
    expect(await run({ comp: { width: 1920, height: 1080 } }, {})).toMatchObject({ ok: false, message: expect.stringMatching(/sizes must match/) });
    expect(await run({}, { range: { start: 5, end: 6 } })).toMatchObject({ ok: false, error: "bad_args" });
    expect(await run({ layerWidth: 0 }, {})).toMatchObject({ ok: false, message: expect.stringMatching(/no width and height/) });
    expect(await run({}, { ref_time: 0.2 })).toMatchObject({ ok: false, message: expect.stringMatching(/reference frame/) });

    const long: PlanarTrack = { ...stored("trk_apply_long"), track_id: "trk_apply_long" };
    long.frames = Array.from({ length: 3001 }, (_, k) => ({ time: k / 10, ok: true, H: identityH(), points: [null, null], confidence: [null, null], rms_px: 0, inliers: 2 }));
    saveTrack(long);
    const ae = fakeAe();
    expect(await tool("ae_track_apply").handler(AeTrackApplySchema.parse({ ...base, track: { track_id: "trk_apply_long" }, mode: "nulls" }), ae.ctx)).toMatchObject({ ok: false, message: expect.stringMatching(/Narrow the write/) });
    const ranged = await tool("ae_track_apply").handler(AeTrackApplySchema.parse({ ...base, track: { track_id: "trk_apply_long" }, mode: "nulls", range: { start: 0, end: 100 } }), fakeAe().ctx);
    expect((ranged as Out).ok).toBe(true);
  });

  it("takes any source: nulls are read inside the same lease before the write", async () => {
    const { ctx, fns } = fakeAe({
      read: {
        kind: "nulls",
        comp: { width: W, height: H, fps: 10 },
        names: ["a"],
        times: [0, 0.1],
        series: [[[10, 10]], [[20, 12]]],
        truncated: false,
        keyed_frames: 2,
        interpolated_frames: 0,
        off_grid_keys: 0,
        expression_driven: [],
      },
    });
    const out = (await tool("ae_track_apply").handler(AeTrackApplySchema.parse({ comp_id: 1, track: { nulls: [{ index: 1 }] }, mode: "nulls", expect: expectArg }), ctx)) as Out;
    expect(fns().slice(0, 2)).toEqual(["planarRead", "planarComp"]);
    expect(out.track_source).toBe("read:nulls");
    expect(out.ok).toBe(true);
  });
});

describe("ae_track_multi apply", () => {
  it("writes the finished track at the end, and waits when it is not finished", async () => {
    const part = fakeAe();
    const a = (await tool("ae_track_multi").handler(multi({ max_frames: 3, apply: { mode: "nulls" }, expect: expectArg }), part.ctx)) as Out;
    expect(a.apply.applied).toBe(false);
    expect(part.fns()).not.toContain("planarApply");
    const done = fakeAe();
    const b = (await tool("ae_track_multi").handler(multi({ start: 0.4, end: 0.6, apply: { mode: "nulls", null_prefix: "P" }, expect: expectArg }), done.ctx)) as Out;
    expect(b.apply.applied).toBe(true);
    expect(b.apply.nulls.map((n: any) => n.name)).toEqual(["P 1", "P 2", "P 3", "P 4", "P 5"]);
    expect(done.fns().indexOf("planarApply")).toBeGreaterThan(done.fns().lastIndexOf("snapshotFrame"));
  }, 60000);
});

// ---------- planar.jsx under node:vm ----------

const P2 = (name: string, matchName: string, v: number[]) => new FakeProperty(name, matchName, PropertyValueType.TwoD, v);

function decorate(g: any, fx: any) {
  Object.defineProperty(g, "propertyIndex", { get: () => fx.props.indexOf(g) + 1 });
  g.moveTo = (i: number) => {
    fx.props.splice(fx.props.indexOf(g), 1);
    fx.props.splice(i - 1, 0, g);
  };
  return g;
}

function makeEffect(matchName: string): FakeGroup {
  if (matchName === "ADBE Corner Pin") {
    return new FakeGroup("Corner Pin", matchName, [
      P2("Upper Left", "ADBE Corner Pin-0001", [0, 0]),
      P2("Upper Right", "ADBE Corner Pin-0002", [100, 0]),
      P2("Lower Left", "ADBE Corner Pin-0003", [0, 100]),
      P2("Lower Right", "ADBE Corner Pin-0004", [100, 100]),
    ]);
  }
  if (matchName === "CC Power Pin") {
    return new FakeGroup("Power Pin", matchName, [P2("Top Left", "x1", [0, 0]), P2("Top Right", "x2", [100, 0]), P2("Bottom Left", "x3", [0, 100]), P2("Bottom Right", "x4", [100, 100])]);
  }
  return new FakeGroup(matchName, matchName, []);
}

/** Lets a fake layer's Effects group add effects, with an index and moveTo like AE's. */
function withEffects(layer: FakeLayer, existing: string[] = []): FakeGroup {
  const fx = layer.property("ADBE Effect Parade") as any;
  const add = (mn: string) => {
    const g = makeEffect(mn);
    g.parentProperty = fx;
    fx.props.push(g);
    return decorate(g, fx);
  };
  fx.addProperty = add;
  for (const mn of existing) add(mn);
  return fx;
}

function scene() {
  const project = new FakeProject();
  const comp = project.addComp("Main", 640, 360, 4);
  const layer = (name: string, w = 100, h = 100) => {
    const l = comp.layers.addSolid([1, 1, 1], name, w, h, 1) as FakeLayer;
    (l as any).width = w;
    (l as any).height = h;
    return l;
  };
  return { project, comp, layer };
}

const pos = (l: FakeLayer) => l.transform("ADBE Position");

describe("planar.jsx", () => {
  it("reports the comp and the layers asked for, changing nothing", () => {
    const { project, comp, layer } = scene();
    layer("Plate");
    const { A, undo } = loadHost(project, ["planar.jsx"]);
    const c = A.planarComp({ comp_id: comp.id, layers: [{ name: "Plate" }] });
    expect(c).toMatchObject({ width: 640, height: 360, fps: 25, num_layers: 1 });
    expect(c.layers[0]).toMatchObject({ name: "Plate", locked: false, three_d: false });
    expect(undo.begun).toBe(0);
  });

  it("isolates the plate in a copy, keeps the original as it was, and only removes its own copy", () => {
    const { project, comp, layer } = scene();
    layer("Patch");
    const plate = layer("Plate");
    layer("Overlay").locked = true;
    (comp as any).duplicate = () => {
      const c = project.addComp("tmp", comp.width, comp.height, comp.duration);
      for (const l of comp.stack) {
        const nl = new FakeLayer(c, l.name);
        nl.locked = l.locked;
        nl.enabled = l.enabled;
        c.stack.push(nl);
      }
      return c;
    };
    const { A, undo } = loadHost(project, ["planar.jsx"]);
    const made = A.planarIsolateBegin({ comp_id: comp.id, show_layers: [{ index: plate.index, id: plate.id }], expect: GUARD });
    const copy = project.itemByID(made.copy_id) as FakeComp;
    expect(copy.name).toBe("_chroma_plate_Main");
    expect(copy.stack.map((l) => [l.name, l.enabled, l.locked])).toEqual([
      ["Overlay", false, false],
      ["Plate", true, false],
      ["Patch", false, false],
    ]);
    expect(comp.stack.every((l) => l.enabled)).toBe(true);
    expect(comp.layer("Overlay")!.locked).toBe(true);
    expect(() => A.planarIsolateEnd({ copy_id: comp.id, expect: GUARD })).toThrow(/not a plate copy/);
    expect(A.planarIsolateEnd({ copy_id: made.copy_id, expect: GUARD })).toEqual({ removed: true, copy_id: made.copy_id });
    expect(project.itemByID(made.copy_id)).toBeNull();
    expect(A.planarIsolateEnd({ copy_id: made.copy_id, expect: GUARD })).toMatchObject({ removed: false, already_gone: true });
    expect(undo.begun).toBe(2);
    expect(undo.ended).toBe(2);
  });

  it("switches solo off in the copy, so a soloed layer in the original cannot blank the plate", () => {
    const { project, comp, layer } = scene();
    const plate = layer("Plate");
    const overlay = layer("Overlay");
    (overlay as any).solo = true;
    (comp as any).duplicate = () => {
      const c = project.addComp("tmp", comp.width, comp.height, comp.duration);
      for (const l of comp.stack) {
        const nl = new FakeLayer(c, l.name);
        nl.enabled = l.enabled;
        (nl as any).solo = (l as any).solo === true;
        c.stack.push(nl);
      }
      return c;
    };
    const { A } = loadHost(project, ["planar.jsx"]);
    const made = A.planarIsolateBegin({ comp_id: comp.id, show_layers: [{ index: plate.index, id: plate.id }], expect: GUARD });
    const copy = project.itemByID(made.copy_id) as FakeComp;
    expect(copy.stack.map((l) => [l.name, l.enabled, (l as any).solo === true])).toEqual([
      ["Overlay", false, false],
      ["Plate", true, false],
    ]);
    // The original keeps its solo.
    expect((overlay as any).solo).toBe(true);
  });

  it("reports whether an item is still in the project, changing nothing", () => {
    const { project, comp } = scene();
    const { A, undo } = loadHost(project, ["planar.jsx"]);
    expect(A.planarItemExists({ item_id: comp.id })).toEqual({ exists: true, item_id: comp.id });
    expect(A.planarItemExists({ item_id: 987654 })).toEqual({ exists: false, item_id: 987654 });
    expect(undo.begun).toBe(0);
  });

  it("refuses an isolation that names a stale layer, or runs under the wrong guard, before making a copy", () => {
    const { project, comp, layer } = scene();
    const plate = layer("Plate");
    const { A, undo } = loadHost(project, ["planar.jsx"]);
    const before = project.numItems;
    expect(() => A.planarIsolateBegin({ comp_id: comp.id, show_layers: [{ index: 1, id: plate.id + 1 }], expect: GUARD })).toThrow(/stack changed/);
    expect(() => A.planarIsolateBegin({ comp_id: comp.id, show_layers: [], expect: GUARD })).toThrow(/No plate layers/);
    expect(() => A.planarIsolateBegin({ comp_id: comp.id, show_layers: [{ index: 1, id: plate.id }], expect: { project_path: "C:/other.aep" } })).toThrow(/Target guard refused/);
    expect(project.numItems).toBe(before);
    expect(undo.begun).toBe(0);
  });

  it("gives a layer's transform and its parents' at each time, and refuses 3D", () => {
    const { project, comp, layer } = scene();
    const parent = layer("Parent");
    const child = layer("Child");
    child.parent = parent;
    pos(parent).setValue([50, 20, 0]);
    pos(child).setValueAtTime(0, [10, 10, 0]);
    pos(child).setValueAtTime(1, [30, 10, 0]);
    const { A } = loadHost(project, ["planar.jsx"]);
    const s = A.planarLayerSpace({ comp_id: comp.id, layer: { index: child.index, id: child.id }, times: [0, 0.5, 1] });
    expect(s.width).toBe(100);
    expect(s.samples.map((x: any) => x.position[0])).toEqual([10, 20, 30]);
    expect(s.samples[0].parent_chain[0].position).toEqual([50, 20]);
    child.threeDLayer = true;
    expect(() => A.planarLayerSpace({ comp_id: comp.id, layer: { index: child.index, id: child.id }, times: [0] })).toThrow(/3D layer/);
    child.threeDLayer = false;
    parent.threeDLayer = true;
    expect(() => A.planarLayerSpace({ comp_id: comp.id, layer: { index: child.index, id: child.id }, times: [0] })).toThrow(/3D layer/);
  });

  describe("planarRead", () => {
    it("reads nulls' Position keys in comp pixels, parents included, on the frame grid", () => {
      const { project, comp, layer } = scene();
      const parent = layer("Rig");
      pos(parent).setValue([50, 20, 0]);
      const a = layer("A");
      const b = layer("B");
      a.parent = parent;
      pos(a).setValueAtTime(0, [10, 10, 0]);
      pos(a).setValueAtTime(0.4, [30, 10, 0]);
      pos(b).setValueAtTime(0, [100, 100, 0]);
      pos(b).setValueAtTime(0.4, [100, 140, 0]);
      const { A, undo } = loadHost(project, ["planar.jsx"]);
      const r = A.planarRead({ comp_id: comp.id, source: { kind: "nulls", layers: [{ name: "A" }, { name: "B" }] } });
      expect(r.times).toHaveLength(11);
      expect(r.times[10]).toBeCloseTo(0.4, 9);
      expect(r.series[0]).toEqual([[60, 30], [100, 100]]);
      expect(r.series[10]).toEqual([[80, 30], [100, 140]]);
      expect(r.series[5][1][1]).toBeCloseTo(120, 6);
      expect(r.keyed_frames).toBe(2);
      expect(r.interpolated_frames).toBe(9);
      expect(r.off_grid_keys).toBe(0);
      expect(r.names).toEqual(["A", "B"]);
      expect(undo.begun).toBe(0);
    });

    it("counts off-grid keys, notices expressions, and refuses a layer with no keys unless a range is given", () => {
      const { project, comp, layer } = scene();
      const a = layer("A");
      pos(a).setValueAtTime(0.013, [10, 10, 0]);
      pos(a).setValueAtTime(0.4, [30, 10, 0]);
      const idle = layer("Idle");
      const { A } = loadHost(project, ["planar.jsx"]);
      expect(A.planarRead({ comp_id: comp.id, source: { kind: "nulls", layers: [{ name: "A" }] } }).off_grid_keys).toBe(1);
      expect(() => A.planarRead({ comp_id: comp.id, source: { kind: "nulls", layers: [{ name: "Idle" }] } })).toThrow(/no Position keys/);
      (pos(idle) as any).expressionEnabled = true;
      const r = A.planarRead({ comp_id: comp.id, source: { kind: "nulls", layers: [{ name: "Idle" }], start: 0, end: 0.2 } });
      expect(r.expression_driven).toEqual(["Idle Position"]);
      expect(r.times).toHaveLength(6);
    });

    it("reads a Corner Pin in the layer's own space as comp pixels, UL UR LR LL, with the table it used", () => {
      const { project, comp, layer } = scene();
      const l = layer("Insert");
      const fx = withEffects(l, ["ADBE Corner Pin"]);
      const pin = fx.property(1) as FakeGroup;
      (pin.property("ADBE Corner Pin-0001") as FakeProperty).setValueAtTime(0, [0, 0]);
      (pin.property("ADBE Corner Pin-0001") as FakeProperty).setValueAtTime(0.4, [20, 0]);
      for (const mn of ["ADBE Corner Pin-0002", "ADBE Corner Pin-0003", "ADBE Corner Pin-0004"]) {
        const p = pin.property(mn) as FakeProperty;
        const v = p.staticValue as number[];
        p.setValueAtTime(0, v);
        p.setValueAtTime(0.4, v);
      }
      pos(l).setValue([320, 180, 0]);
      const { A } = loadHost(project, ["planar.jsx"]);
      const r = A.planarRead({ comp_id: comp.id, source: { kind: "corner_pin", layer: { name: "Insert" } } });
      expect(r.kind).toBe("corner_pin");
      expect(r.names).toEqual(["ul", "ur", "lr", "ll"]);
      expect(r.series[0]).toEqual([[320, 180], [420, 180], [420, 280], [320, 280]]);
      expect(r.series[10][0]).toEqual([340, 180]);
      expect(r.param_table.map((x: any) => [x.role, x.name, x.how])).toEqual([["ul", "Upper Left", "match"], ["ur", "Upper Right", "match"], ["ll", "Lower Left", "match"], ["lr", "Lower Right", "match"]]);
      expect(r.effect.matchName).toBe("ADBE Corner Pin");
    });

    it("falls back to match names and positions when display names are not English, and lists what is there when nothing fits", () => {
      const { project, comp, layer } = scene();
      const l = layer("Insert");
      const fx = withEffects(l);
      const g = new FakeGroup("Coin", "ADBE Corner Pin", [
        P2("Haut gauche", "ADBE Corner Pin-0001", [0, 0]),
        P2("Haut droit", "ADBE Corner Pin-0002", [100, 0]),
        P2("Bas gauche", "ADBE Corner Pin-0003", [0, 100]),
        P2("Bas droit", "ADBE Corner Pin-0004", [100, 100]),
      ]);
      g.parentProperty = fx;
      fx.props.push(g);
      decorate(g, fx);
      for (const p of g.props as FakeProperty[]) p.setValueAtTime(0, p.staticValue as number[]);
      const { A } = loadHost(project, ["planar.jsx"]);
      const r = A.planarRead({ comp_id: comp.id, source: { kind: "corner_pin", layer: { name: "Insert" }, start: 0, end: 0 } });
      expect(r.param_table.map((x: any) => x.how)).toEqual(["match", "match", "match", "match"]);
      const none = layer("Bare");
      expect(() => A.planarRead({ comp_id: comp.id, source: { kind: "corner_pin", layer: { name: "Bare" } } })).toThrow(/no Corner Pin or CC Power Pin/);
      void none;
    });

    it("reads AE Tracker points (Feature Center, confidence) and says what the layer has when there are none", () => {
      const { project, comp, layer } = scene();
      const l = layer("Footage");
      pos(l).setValue([320, 180, 0]);
      const fc = P2("Feature Center", "ADBE MTracker Pt Feature Center", [10, 10]);
      const conf = new FakeProperty("Confidence", "ADBE MTracker Pt Confidence", PropertyValueType.OneD, 80);
      fc.setValueAtTime(0, [10, 10]);
      fc.setValueAtTime(0.2, [20, 10]);
      const trackers = new FakeGroup("Trackers", "ADBE MTrackers", [new FakeGroup("Tracker 1", "ADBE MTracker", [new FakeGroup("Track Point 1", "ADBE MTracker Pt", [fc, conf])])]);
      l.group.props.push(trackers);
      trackers.parentProperty = l.group;
      const { A } = loadHost(project, ["planar.jsx"]);
      const r = A.planarRead({ comp_id: comp.id, source: { kind: "tracker", layer: { name: "Footage" } } });
      expect(r.names).toEqual(["Track Point 1"]);
      expect(r.series[0]).toEqual([[330, 190]]);
      expect(r.series[5]).toEqual([[340, 190]]);
      expect(r.confidence[0]).toEqual([80]);
      expect(() => A.planarRead({ comp_id: comp.id, source: { kind: "tracker", layer: { name: "Footage" }, tracker: "Nope" } })).toThrow(/No tracker named/);
      layer("Plain");
      expect(() => A.planarRead({ comp_id: comp.id, source: { kind: "tracker", layer: { name: "Plain" } } })).toThrow(/no AE Tracker data/);
    });

    it("reads a layer's transform keys as the track of its corners", () => {
      const { project, comp, layer } = scene();
      const l = layer("Card");
      (l.transform("ADBE Anchor Point") as FakeProperty).setValue([50, 50, 0]);
      pos(l).setValueAtTime(0, [100, 100, 0]);
      pos(l).setValueAtTime(0.4, [140, 100, 0]);
      const { A } = loadHost(project, ["planar.jsx"]);
      const r = A.planarRead({ comp_id: comp.id, source: { kind: "transform", layer: { name: "Card" } } });
      expect(r.series[0]).toEqual([[50, 50], [150, 50], [150, 150], [50, 150]]);
      expect(r.series[10][0]).toEqual([90, 50]);
      expect(r.layer_size).toEqual([100, 100]);
      l.threeDLayer = true;
      expect(() => A.planarRead({ comp_id: comp.id, source: { kind: "transform", layer: { name: "Card" } } })).toThrow(/3D layer/);
    });

    it("refuses non-square pixels and an unknown source", () => {
      const { project, comp, layer } = scene();
      layer("A");
      const { A } = loadHost(project, ["planar.jsx"]);
      expect(() => A.planarRead({ comp_id: comp.id, source: { kind: "wobble" } })).toThrow(/Unknown source kind/);
      comp.pixelAspect = 2;
      expect(() => A.planarRead({ comp_id: comp.id, source: { kind: "nulls", layers: [{ name: "A" }] } })).toThrow(/pixel aspect/);
    });
  });

  describe("planarEffectSlot", () => {
    it("orders colour < degrain < blur < pin < motion blur, with unknown effects in front", () => {
      const { project, comp, layer } = scene();
      const l = layer("Patch");
      withEffects(l, ["ADBE Pro Levels2", "ADBE Gaussian Blur 2", "ADBE Drop Shadow"]);
      const { A } = loadHost(project, ["planar.jsx"]);
      const ask = (category: string, extra: Record<string, unknown> = {}) => A.planarEffectSlot({ comp_id: comp.id, layer_index: l.index, layer_id: l.id, category, ...extra });
      // Existing: Levels, Blur, then Drop Shadow (other). Only unknown effects in front of the first tool effect count as in front.
      expect(ask("color")).toBe(2);
      expect(ask("degrain")).toBe(2);
      expect(ask("blur")).toBe(3);
      expect(ask("pin")).toBe(3);
      expect(ask("motion_blur")).toBe(3);
      // An unknown effect in front does count.
      const l3 = layer("Patch 3");
      withEffects(l3, ["ADBE Drop Shadow", "ADBE Gaussian Blur 2"]);
      expect(A.planarEffectSlot({ comp_id: comp.id, layer_index: l3.index, layer_id: l3.id, category: "pin" })).toBe(3);
      expect(() => ask("nonsense")).toThrow(/Unknown effect category/);
      // The effect just added is left out of the count: Levels, Blur, then the new pin at index 3.
      const l2 = layer("Patch 2");
      withEffects(l2, ["ADBE Pro Levels2", "ADBE Gaussian Blur 2", "ADBE Corner Pin"]);
      expect(A.planarEffectSlot({ comp_id: comp.id, layer_index: l2.index, layer_id: l2.id, category: "pin", new_index: 3 })).toBe(3);
      expect(A.planarEffectSlot({ comp_id: comp.id, layer_index: l2.index, layer_id: l2.id, category: "color", new_index: 3 })).toBe(2);
    });

    it("keeps an effect the tools did not add where it is, between two tool effects", () => {
      const { project, comp, layer } = scene();
      const { A } = loadHost(project, ["planar.jsx"]);
      // Levels (tool), Drop Shadow (user), Gaussian Blur (tool), the new Corner Pin at index 4: it belongs after the blur.
      const l = layer("Patch");
      withEffects(l, ["ADBE Pro Levels2", "ADBE Drop Shadow", "ADBE Gaussian Blur 2", "ADBE Corner Pin"]);
      expect(A.planarEffectSlot({ comp_id: comp.id, layer_index: l.index, layer_id: l.id, category: "pin", new_index: 4 })).toBe(4);
      // Levels, a user effect, Corner Pin; a new Force Motion Blur at index 4 goes after the pin.
      const m = layer("Patch 2");
      withEffects(m, ["ADBE Pro Levels2", "ADBE Drop Shadow", "ADBE Corner Pin", "CC Force Motion Blur"]);
      expect(A.planarEffectSlot({ comp_id: comp.id, layer_index: m.index, layer_id: m.id, category: "motion_blur", new_index: 4 })).toBe(4);
      // A new colour effect stays in front of the pin, behind nothing but the leading user effects.
      const n = layer("Patch 3");
      withEffects(n, ["ADBE Drop Shadow", "ADBE Pro Levels2", "ADBE Drop Shadow", "ADBE Corner Pin", "ADBE Exposure2"]);
      expect(A.planarEffectSlot({ comp_id: comp.id, layer_index: n.index, layer_id: n.id, category: "color", new_index: 5 })).toBe(3);
    });
  });

  describe("writing", () => {
    const times = [0, 0.04, 0.08];
    const pinValues = {
      ul: [[0, 0], [2, 1], [4, 2]],
      ur: [[100, 0], [102, 1], [104, 2]],
      ll: [[0, 100], [2, 101], [4, 102]],
      lr: [[100, 100], [102, 101], [104, 102]],
    };

    it("adds a Corner Pin at its slot and keys the four points linearly, in one undo group", () => {
      const { project, comp, layer } = scene();
      const l = layer("Insert");
      const fx = withEffects(l, ["ADBE Pro Levels2", "CC Force Motion Blur"]);
      const { A, undo } = loadHost(project, ["planar.jsx"]);
      const out = A.planarApply({
        comp_id: comp.id,
        writes: [{ layer_index: l.index, layer_id: l.id, target: "corner_pin", add_effect: true, times, values: pinValues }],
        expect: GUARD,
      });
      expect(undo.begun).toBe(1);
      expect(undo.ended).toBe(1);
      // Levels, then the pin, then Force Motion Blur.
      expect((fx.props as FakeGroup[]).map((e) => e.matchName)).toEqual(["ADBE Pro Levels2", "ADBE Corner Pin", "CC Force Motion Blur"]);
      expect(out.written[0]).toMatchObject({ effect_added: true, effect_index: 2, slot_moved: true });
      expect(out.written[0].props.map((p: any) => p.numKeys)).toEqual([3, 3, 3, 3]);
      const pin = fx.property(2) as FakeGroup;
      const ul = pin.property("ADBE Corner Pin-0001") as FakeProperty;
      expect(ul.numKeys).toBe(3);
      expect(ul.keyValue(2)).toEqual([2, 1]);
      expect(ul.keyInInterpolationType(2)).toBe(6612);
      expect((pin.property("ADBE Corner Pin-0004") as FakeProperty).keyValue(3)).toEqual([104, 102]);
    });

    it("refuses to add a pin the layer cannot take, before any undo group or write", () => {
      const { project, comp, layer } = scene();
      const l = layer("Insert");
      const fx = withEffects(l, ["ADBE Pro Levels2"]);
      (fx as any).canAddProperty = (mn: string) => mn !== "ADBE Corner Pin";
      const { A, undo } = loadHost(project, ["planar.jsx"]);
      expect(() =>
        A.planarApply({ comp_id: comp.id, writes: [{ layer_index: l.index, layer_id: l.id, target: "corner_pin", add_effect: true, times, values: pinValues }], expect: GUARD })
      ).toThrow(/cannot take ADBE Corner Pin/);
      expect(undo.begun).toBe(0);
      expect(fx.numProperties).toBe(1);
      // A raw write (the other groups call it inside their own undo group) refuses the same way, with nothing touched.
      expect(() => A.planarWriteRaw({ comp_id: comp.id, writes: [{ layer_index: l.index, layer_id: l.id, target: "corner_pin", add_effect: true, times, values: pinValues }] })).toThrow(/cannot take/);
      expect(fx.numProperties).toBe(1);
    });

    it("makes the keys of a spatial property straight: linear in time, zero tangents, no auto-bezier", () => {
      const { project, comp, layer } = scene();
      const l = layer("Card");
      const p = pos(l) as any;
      p.isSpatial = true;
      const log: string[] = [];
      p.setSpatialAutoBezierAtKey = (k: number, v: boolean) => log.push(`ab${k}=${v}`);
      p.setSpatialContinuousAtKey = (k: number, v: boolean) => log.push(`ct${k}=${v}`);
      p.setSpatialTangentsAtKey = (k: number, a: number[], b: number[]) => log.push(`tg${k}=${a.join(",")}|${b.join(",")}`);
      const { A } = loadHost(project, ["planar.jsx"]);
      A.planarApply({ comp_id: comp.id, writes: [{ layer_index: l.index, layer_id: l.id, target: "position", times: [0, 0.04], values: { position: [[1, 2], [3, 4]] } }], expect: GUARD });
      const zeros = (n: number) => new Array(n).fill(0).join(",");
      const dims = (p.valueAtTime(0, false) as number[]).length;
      expect(log).toEqual(["ab1=false", "ct1=false", `tg1=${zeros(dims)}|${zeros(dims)}`, "ab2=false", "ct2=false", `tg2=${zeros(dims)}|${zeros(dims)}`]);
      expect(p.keyInInterpolationType(1)).toBe(6612);
    });

    it("writes transform keys, padding a 3-vector Position and Scale with the current z", () => {
      const { project, comp, layer } = scene();
      const l = layer("Card");
      const { A } = loadHost(project, ["planar.jsx"]);
      A.planarApply({
        comp_id: comp.id,
        writes: [{ layer_index: l.index, layer_id: l.id, target: "transform", times, values: { position: [[1, 2], [3, 4], [5, 6]], rotation: [0, 5, 10], scale: [[100, 100], [110, 110], [120, 120]] } }],
        expect: GUARD,
      });
      expect(pos(l).keyValue(2)).toEqual([3, 4, 0]);
      expect((l.transform("ADBE Rotate Z") as FakeProperty).keyValue(3)).toBe(10);
      expect((l.transform("ADBE Scale") as FakeProperty).keyValue(2)).toEqual([110, 110, 100]);
      expect((l.transform("ADBE Anchor Point") as FakeProperty).numKeys).toBe(0);
    });

    it("makes nulls with their keys in the same group", () => {
      const { project, comp } = scene();
      const { A, undo } = loadHost(project, ["planar.jsx"]);
      const out = A.planarApply({
        comp_id: comp.id,
        new_nulls: [{ name: "Track 1", times, position: [[1, 1], [2, 2], [3, 3]] }, { name: "Track solved", times, position: [[1, 1], [2, 2], [3, 3]], rotation: [0, 1, 2], scale: [[100, 100], [100, 100], [100, 100]] }],
        writes: [],
        expect: GUARD,
      });
      expect(undo.begun).toBe(1);
      expect(out.nulls.map((n: any) => n.name)).toEqual(["Track 1", "Track solved"]);
      expect(comp.numLayers).toBe(2);
      expect(comp.layer("Track solved")!.transform("ADBE Rotate Z").numKeys).toBe(3);
    });

    it("refuses every bad write before anything changes: locked, 3D, keys, expression, limits, bad numbers, stale layer", () => {
      const { project, comp, layer } = scene();
      const l = layer("Card");
      const { A, undo } = loadHost(project, ["planar.jsx"]);
      const base = { layer_index: l.index, layer_id: l.id, target: "transform", times, values: { position: [[1, 2], [3, 4], [5, 6]] } };
      const run = (w: Record<string, unknown>, extra: Record<string, unknown> = {}) => A.planarApply({ comp_id: comp.id, writes: [{ ...base, ...w }], expect: GUARD, ...extra });
      const untouched = () => {
        expect(undo.begun).toBe(0);
        expect(comp.numLayers).toBe(1);
        expect(pos(l).numKeys).toBe(0);
      };
      l.locked = true;
      expect(() => run({})).toThrow(/is locked/);
      l.locked = false;
      l.threeDLayer = true;
      expect(() => run({})).toThrow(/3D layer/);
      l.threeDLayer = false;
      expect(() => run({ layer_id: l.id + 1 })).toThrow(/stack changed/);
      expect(() => run({ times: [0, 0.1, 0.05] })).toThrow(/ascend/);
      expect(() => run({ times: [0, 0.1] })).toThrow(/needs 2 values/);
      expect(() => run({ values: { position: [[1, 2], [3, "x"], [5, 6]] } })).toThrow(/not a number/);
      expect(() => run({ values: {} })).toThrow(/no position, rotation, scale or anchor/);
      expect(() => run({ target: "wobble" })).toThrow(/Unknown write target/);
      expect(() => run({ target: "position", values: { position: base.values.position, rotation: [0, 0, 0] } })).toThrow(/position only/);
      expect(() => A.planarApply({ comp_id: comp.id, writes: [], new_nulls: [], expect: GUARD })).toThrow(/Nothing to write/);
      expect(() => A.planarApply({ comp_id: comp.id, writes: [base, base], expect: GUARD })).toThrow(/same layer/);
      expect(() => A.planarApply({ comp_id: comp.id, new_nulls: [{ name: "", times, position: [[1, 1], [1, 1], [1, 1]] }], writes: [], expect: GUARD })).toThrow(/needs a name/);
      expect(() => A.planarApply({ comp_id: comp.id, writes: [{ ...base, target: "corner_pin", values: pinValues }], expect: GUARD })).toThrow(/pass add_effect/);
      untouched();
      // A property's hard limits.
      const rotProp = l.transform("ADBE Rotate Z") as any;
      rotProp.hasMin = true;
      rotProp.minValue = -100;
      expect(() => run({ values: { rotation: [0, -500, 0] } })).toThrow(/below the property's minimum/);
      rotProp.hasMax = true;
      rotProp.maxValue = 100;
      expect(() => run({ values: { rotation: [0, 500, 0] } })).toThrow(/above the property's maximum/);
      untouched();
      // Existing keys, an expression.
      pos(l).setValueAtTime(1, [9, 9, 0]);
      expect(() => run({})).toThrow(/already has 1 keyframes/);
      expect(() => A.planarApply({ comp_id: comp.id, writes: [base], replace_keys: true, expect: GUARD })).not.toThrow();
      expect(pos(l).numKeys).toBe(3);
      (pos(l) as any).expressionEnabled = true;
      expect(() => run({ replace_keys: true })).toThrow(/has an expression/);
      // The guard comes first.
      expect(() => A.planarApply({ comp_id: comp.id, writes: [base], expect: { project_path: "C:/other.aep" } })).toThrow(/Target guard refused/);
    });

    it("a refused write in a batch leaves the nulls and the good writes undone", () => {
      const { project, comp, layer } = scene();
      const l = layer("Card");
      const locked = layer("Locked");
      locked.locked = true;
      const { A, undo } = loadHost(project, ["planar.jsx"]);
      expect(() =>
        A.planarApply({
          comp_id: comp.id,
          new_nulls: [{ name: "N", times, position: [[1, 1], [2, 2], [3, 3]] }],
          writes: [
            { layer_index: l.index, layer_id: l.id, target: "position", times, values: { position: [[1, 2], [3, 4], [5, 6]] } },
            { layer_index: locked.index, layer_id: locked.id, target: "position", times, values: { position: [[1, 2], [3, 4], [5, 6]] } },
          ],
          expect: GUARD,
        })
      ).toThrow(/locked/);
      expect(undo.begun).toBe(0);
      expect(comp.numLayers).toBe(2);
      expect(pos(l).numKeys).toBe(0);
    });

    it("planarWriteRaw validates and writes but opens no undo group (the caller wraps it)", () => {
      const { project, comp, layer } = scene();
      const l = layer("Card");
      const { A, undo } = loadHost(project, ["planar.jsx"]);
      const out = A.planarWriteRaw({ comp_id: comp.id, writes: [{ layer_index: l.index, layer_id: l.id, target: "position", times, values: { position: [[1, 2], [3, 4], [5, 6]] } }] });
      expect(out.written[0].props[0].numKeys).toBe(3);
      expect(undo.begun).toBe(0);
      expect(() => A.planarWriteRaw({ comp_id: comp.id, writes: [{ layer_index: l.index, layer_id: l.id, target: "position", times, values: { position: [[1, 2], [3, 4], [5, 6]] } }] })).toThrow(/already has/);
    });

    it("keys an existing CC Power Pin by its index and refuses one that is not a pin", () => {
      const { project, comp, layer } = scene();
      const l = layer("Insert");
      const fx = withEffects(l, ["ADBE Pro Levels2", "CC Power Pin"]);
      const { A } = loadHost(project, ["planar.jsx"]);
      const w = { layer_index: l.index, layer_id: l.id, target: "power_pin", times, values: pinValues };
      expect(() => A.planarWriteRaw({ comp_id: comp.id, writes: [{ ...w, effect_index: 1 }] })).toThrow(/not a CC Power Pin|is "ADBE Pro Levels2"|ADBE Pro Levels2/);
      const out = A.planarWriteRaw({ comp_id: comp.id, writes: [w] });
      expect(out.written[0]).toMatchObject({ effect_added: false, effect_index: 2 });
      expect((fx.property(2) as FakeGroup).property("Top Left")).toBeTruthy();
      expect(((fx.property(2) as FakeGroup).property("Bottom Right") as FakeProperty).numKeys).toBe(3);
    });
  });

  describe("planarKeys", () => {
    it("reports key counts and values at the sample times, changing nothing", () => {
      const { project, comp, layer } = scene();
      const l = layer("Card");
      const fx = withEffects(l, ["ADBE Corner Pin"]);
      const { A, undo } = loadHost(project, ["planar.jsx"]);
      A.planarWriteRaw({
        comp_id: comp.id,
        writes: [
          { layer_index: l.index, layer_id: l.id, target: "transform", times: [0, 0.08], values: { position: [[1, 2], [3, 4]] } },
          { layer_index: l.index, layer_id: l.id, target: "corner_pin", times: [0, 0.08], values: { ul: [[0, 0], [8, 8]], ur: [[1, 1], [1, 1]], ll: [[2, 2], [2, 2]], lr: [[3, 3], [3, 3]] } },
        ],
      });
      const r = A.planarKeys({
        comp_id: comp.id,
        items: [
          { layer_id: l.id, kind: "transform", times: [0, 0.08] },
          { layer_id: l.id, kind: "corner_pin", times: [0.04] },
          { layer_id: 424242, kind: "transform", times: [] },
        ],
      });
      const position = r.items[0].props.find((p: any) => p.role === "position");
      expect(position.numKeys).toBe(2);
      expect(position.samples[1].value).toEqual([3, 4, 0]);
      const ul = r.items[1].props.find((p: any) => p.role === "ul");
      expect(ul.samples[0].value).toEqual([4, 4]);
      expect(r.items[2]).toMatchObject({ found: false });
      expect(fx.numProperties).toBe(1);
      expect(undo.begun).toBe(0);
    });
  });
});
