import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PNG } from "pngjs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import {
  alignGridFor,
  alignedSample,
  AeCleanplatePickSchema,
  AeCleanplateSetupSchema,
  checkRegion,
  cleanplateTools,
  cloneShifts,
  drawSheet,
  findSpatialSources,
  maskKeysFor,
  maskParams,
  medianDistance,
  medianSample,
  patchTrackKeys,
  patchTrackMode,
  planPickFrames,
  planSetup,
  regionToShape,
  regionsDiagonal,
  scoreFrames,
  setupMismatches,
  sheetTimes,
  temporalSources,
  toSpec,
  uniqueStillPath,
  type HostInspect,
  type RawFrameRow,
  type ScoredFrame,
} from "../src/tools/ext/cleanplate.js";
import { AePatchCheckSchema } from "../src/tools/ext/patchcheck.js";
import { AePatchColorMatchSchema, AePatchFinishSchema, AePatchGrainSchema } from "../src/tools/ext/patchfit.js";
import { saveTrack, trackFromSeries } from "../src/tools/ext/planar.js";
import { getSessionTracker, installSessionTracking, resetSessionTracking } from "../src/tools/ext/session.js";
import { identityH, type PlanarTrack, type Vec2 } from "../src/tools/ext/planar-math.js";
import { FakeFile, FakeGroup, FakeLayer, FakeProject, FakeProperty, GUARD, KeyframeInterpolationType, loadHost, PropertyValueType, TrackMatteType, type FakeComp } from "./support/fake-ae.js";

// The track store, the frames folder and the plates live under temp dirs, not the real ones.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-cleanplate-"));
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

const tool = (name: string) => cleanplateTools.find((t) => t.name === name)!;
const expectArg = { project_path: "<unsaved>" };
const W = 240;
const H = 160;

// ---------- frames ----------

/** Deterministic texture in 0..1. */
const hash = (x: number, y: number): number => {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return (((h ^ (h >>> 16)) >>> 0) % 1000) / 1000;
};

function frame(o: { amp?: number; occlude?: boolean; period?: number }): PNG {
  const png = new PNG({ width: W, height: H });
  const amp = o.amp ?? 0.8;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const tx = o.period ? x % o.period : x;
      let v = 128 + (hash(tx, y) - 0.5) * 200 * amp;
      if (o.occlude && x >= 96 && x < 144 && y >= 56 && y < 94) v = 250;
      const i = (y * W + x) * 4;
      png.data[i] = png.data[i + 1] = png.data[i + 2] = Math.max(0, Math.min(255, Math.round(v)));
      png.data[i + 3] = 255;
    }
  }
  return png;
}

// ---------- the pure logic ----------

describe("regions and masks", () => {
  it("converts the planar region forms and builds mask shapes", () => {
    expect(toSpec({ rect: [10, 20, 30, 40] })).toEqual({ kind: "rect", rect: [10, 20, 40, 60] });
    expect(toSpec({ ellipse: [5, 6, 7, 8] })).toEqual({ kind: "ellipse", center: [5, 6], radius: [7, 8] });
    const rect = regionToShape({ rect: [10, 20, 30, 40] });
    expect(rect.vertices).toEqual([[10, 20], [40, 20], [40, 60], [10, 60]]);
    expect(rect.inTangents.every((t) => t[0] === 0 && t[1] === 0)).toBe(true);
    const ell = regionToShape({ ellipse: [100, 100, 20, 10] });
    expect(ell.vertices).toHaveLength(4);
    expect(ell.outTangents[0][0]).toBeCloseTo(0.5523 * 20, 3);
    expect(ell.inTangents[1][1]).toBeCloseTo(-0.5523 * 10, 3);
    expect(regionsDiagonal([{ rect: [0, 0, 30, 40] }])).toBeCloseTo(50, 6);
  });

  it("refuses regions with no size", () => {
    expect(() => checkRegion({ rect: [0, 0, 0, 10] })).toThrow(/width and height/);
    expect(() => checkRegion({ ellipse: [0, 0, 5, -1] })).toThrow(/radii/);
    expect(() => checkRegion({ polygon: [[0, 0], [10, 0], [20, 0]] })).toThrow(/area/);
    expect(() => checkRegion({ rect: [0, 0, 5, 5] })).not.toThrow();
  });

  it("keeps the expansion at least half the feather and defaults the feather to 2% of the diagonal", () => {
    expect(maskParams({ diagonal: 500 })).toEqual({ feather: 10, expansion: 5, raised: false });
    expect(maskParams({ diagonal: 500, feather: 8, expansion: 1 })).toEqual({ feather: 8, expansion: 4, raised: true });
    expect(maskParams({ diagonal: 500, feather: 8, expansion: 6 })).toEqual({ feather: 8, expansion: 6, raised: false });
    expect(maskParams({ diagonal: 10, feather: 0 })).toEqual({ feather: 0, expansion: 0, raised: false });
  });
});

function shiftTrack(n = 10, model: PlanarTrack["model"] = "translate", refTime = 0): PlanarTrack {
  const times = Array.from({ length: n }, (_, i) => i / 10);
  const series: Vec2[][] = times.map((_, i) => [[100 + 3 * i, 80 + i], [180 + 3 * i, 90 + i], [120 + 3 * i, 30 + i], [60 + 3 * i, 120 + i]]);
  return trackFromSeries({ compId: 1, compSize: [W, H], fps: 10, times, series, model, refTime, source: "test", trackId: "trk_cp_fixture" });
}

describe("track keys for the patch layer", () => {
  it("keys the transform for translate, adds a pin for perspective", () => {
    expect(patchTrackMode("translate")).toBe("transform");
    expect(patchTrackMode("similarity")).toBe("transform");
    expect(patchTrackMode("affine")).toBe("transform_pin");
    expect(patchTrackMode("perspective")).toBe("transform_pin");
    const t = patchTrackKeys(shiftTrack(10, "translate"), [W, H]);
    expect(t.mode).toBe("transform");
    expect(t.keys.times).toHaveLength(10);
    expect(t.keys.pin).toBeUndefined();
    // The patch layer starts centred, so its position follows the track's shift: 3 px right and 1 px down per frame.
    expect(t.keys.transform!.position[0]).toEqual([W / 2, H / 2]);
    expect(t.keys.transform!.position[5][0]).toBeCloseTo(W / 2 + 15, 3);
    expect(t.keys.transform!.position[5][1]).toBeCloseTo(H / 2 + 5, 3);
    const p = patchTrackKeys(shiftTrack(10, "perspective"), [W, H]);
    expect(p.mode).toBe("transform_pin");
    expect(p.keys.pin).toBeDefined();
    expect(p.keys.pin!.ul).toHaveLength(10);
  });

  it("respects a range and refuses an empty one", () => {
    const t = patchTrackKeys(shiftTrack(10), [W, H], { start: 0.2, end: 0.4 });
    expect(t.keys.times).toEqual([0.2, 0.3, 0.4]);
    expect(() => patchTrackKeys(shiftTrack(10), [W, H], { start: 5, end: 6 })).toThrow(/No frame/);
  });
});

describe("the clone shift", () => {
  const c: Vec2 = [120, 80];
  it("is -(dx, dy) when nothing moves, and follows the shot with a track", () => {
    const track = shiftTrack(10);
    const still = cloneShifts({ track: { ...track, frames: track.frames.map((f) => ({ ...f, H: identityH() })) }, centre: c, offset: { dx: 50, dy: 0, frames: 0 }, frames: track.frames });
    expect(still.shifts[3]).toEqual([-50, 0]);
    const moving = cloneShifts({ track, centre: c, offset: { dx: 50, dy: 0, frames: 0 }, frames: track.frames });
    // A pure translation shifts the hole and its source alike: the compensation is the same -50.
    expect(moving.shifts.every((s) => Math.abs(s[0] + 50) < 1e-6 && Math.abs(s[1]) < 1e-6)).toBe(true);
  });

  it("compensates a time offset by the motion between the two frames", () => {
    const track = shiftTrack(10);
    const r = cloneShifts({ track, centre: c, offset: { dx: 0, dy: 0, frames: 2 }, frames: track.frames });
    // 2 frames later the shot is 6 px right and 2 px down: pulling that frame back onto this one moves it -6, -2.
    expect(r.shifts[0]).toEqual([-6, -2]);
    // The last two frames have no data 2 frames later.
    expect(r.times).toHaveLength(8);
    expect(r.skipped).toHaveLength(2);
  });

  it("moves the mask shapes with the track", () => {
    const track = shiftTrack(10);
    const keys = maskKeysFor([regionToShape({ rect: [100, 60, 40, 30] })], track.frames);
    expect(keys[0].times).toHaveLength(10);
    expect(keys[0].shapes[4].vertices[0]).toEqual([112, 64]);
  });

  it("plans the setup: static, compensated, and the refusals", () => {
    const args = AeCleanplateSetupSchema.parse({ comp_id: 1, plate: { index: 1 }, ref_time: 0, region: { rect: [100, 60, 40, 30] }, source: "clone_offset", offset: { dx: 60, dy: 0, frames: 0 }, expect: expectArg });
    const shapes = [regionToShape({ rect: [100, 60, 40, 30] })];
    const noTrack = planSetup({ args, track: null, size: [W, H], shapes, centre: c });
    expect(noTrack.clone).toMatchObject({ static_shift: [-60, -0] });
    const tracked = planSetup({ args, track: shiftTrack(10), size: [W, H], shapes, centre: c });
    expect(tracked.cloneInfo).toMatchObject({ position_keys: 10, mask_keys: 10 });
    expect(tracked.maskKeys).toHaveLength(1);
    const freeze = planSetup({ args: { ...args, source: "freeze", offset: undefined }, track: shiftTrack(10, "perspective"), size: [W, H], shapes, centre: c });
    expect(freeze.mode).toBe("transform_pin");
    expect(freeze.writes.map((w) => w.target)).toEqual(["transform", "corner_pin"]);
    const long = shiftTrack(10);
    long.frames = Array.from({ length: 1100 }, (_, i) => ({ ...long.frames[i % 10], time: i / 10 }));
    expect(() => planSetup({ args, track: long, size: [W, H], shapes, centre: c })).toThrow(/limit is 1000/);
  });

  it("bounds the mask points a tracked clone sends in one write, and records the keyed span", () => {
    const args = AeCleanplateSetupSchema.parse({ comp_id: 1, plate: { index: 1 }, ref_time: 0, region: { rect: [100, 60, 40, 30] }, source: "clone_offset", offset: { dx: 90, dy: 0, frames: 0 }, expect: expectArg });
    const poly = Array.from({ length: 64 }, (_, i) => [100 + 20 * Math.cos((i / 64) * 2 * Math.PI), 70 + 20 * Math.sin((i / 64) * 2 * Math.PI)] as Vec2);
    const shape = { vertices: poly, inTangents: poly.map(() => [0, 0] as Vec2), outTangents: poly.map(() => [0, 0] as Vec2), closed: true };
    const long = shiftTrack(10);
    long.frames = Array.from({ length: 1000 }, (_, i) => ({ ...long.frames[i % 10], time: i / 10 }));
    // 4 regions x 64 vertices x 3 x 1000 frames is far over 200000 numbers.
    expect(() => planSetup({ args, track: long, size: [W, H], shapes: [shape, shape, shape, shape], centre: c })).toThrow(/limit is 200000.*range/);
    const ok = planSetup({ args, track: shiftTrack(10), size: [W, H], shapes: [shape], centre: c });
    expect(ok.span).toEqual({ start: 0, end: 0.9 });
  });
});

describe("pick scoring", () => {
  const row = (time: number, o: Partial<RawFrameRow> = {}): RawFrameRow => ({ time, usable: true, sharpness: 10, speed: 0, confidence: 1, rms_px: 0, coverage: 1, distance: null, ...o });

  it("ranks sharp, calm, confident, covered frames first and explains why", () => {
    const rows = [row(0, { sharpness: 4, speed: 5 }), row(0.5, { sharpness: 10, speed: 0.2 }), row(1, { sharpness: 10, speed: 0.2, confidence: 0.5 })];
    const s = scoreFrames(rows, { moving: false, start: 0, end: 1 });
    expect(s[1].score).toBeGreaterThan(s[2].score);
    expect(s[2].score).toBeGreaterThan(s[0].score);
    expect(s[1].reasons).toContain("sharp");
    expect(s[0].reasons.join(" ")).toMatch(/fast motion/);
  });

  it("drops frames where less than 90% of the region is in the frame, or that cannot be judged", () => {
    const s = scoreFrames([row(0, { coverage: 0.5 }), row(0.5), row(1, { usable: false, reason: "the track lost the plate" })], { moving: false, start: 0, end: 1 });
    expect(s[0].score).toBe(0);
    expect(s[0].reasons[0]).toMatch(/50%/);
    expect(s[2].reasons[0]).toBe("the track lost the plate");
    expect(s[1].score).toBeGreaterThan(0);
  });

  it("in moving_occluder mode, a frame far from the median loses", () => {
    const s = scoreFrames([row(0, { distance: 2 }), row(0.5, { distance: 40 }), row(1, { distance: 3 })], { moving: true, start: 0, end: 1 });
    expect(s[0].cleanliness).toBeGreaterThan(0.9);
    expect(s[1].cleanliness!).toBeLessThan(0.2);
    expect(s[1].score).toBeLessThan(s[0].score);
    expect(s[1].reasons.join(" ")).toMatch(/something else/);
  });

  it("prefers the middle of the range on a tie", () => {
    const s = scoreFrames([row(0), row(0.5), row(1)], { moving: false, start: 0, end: 1 });
    expect(s[1].score).toBeGreaterThan(s[0].score);
    expect(s[1].score).toBeGreaterThan(s[2].score);
  });

  it("plans frames: every Nth, spread down to the render budget", () => {
    expect(planPickFrames({ fps: 10, start: 0, end: 0.9, everyN: 2, maxRenders: 80 }).times).toEqual([0, 0.2, 0.4, 0.6, 0.8]);
    const capped = planPickFrames({ fps: 10, start: 0, end: 0.9, everyN: 1, maxRenders: 4 });
    expect(capped.times.length).toBeLessThanOrEqual(4);
    expect(capped.total).toBe(10);
    expect(capped.step).toBeGreaterThan(1);
  });
});

describe("aligned samples and the temporal median", () => {
  it("samples the frame on the reference grid through H and finds the odd one out", () => {
    const poly = [[100, 60], [140, 60], [140, 90], [100, 90]] as Array<[number, number]>;
    const grid = alignGridFor(poly);
    const gray = (png: PNG) => ({ width: W, height: H, data: Float32Array.from({ length: W * H }, (_, i) => png.data[i * 4]) });
    const clean = alignedSample(gray(frame({})), 1, identityH(), grid);
    const moved = alignedSample(gray(frame({})), 1, [1, 0, 3, 0, 1, 0, 0, 0, 1], grid);
    // A shifted H samples elsewhere: different values, same shape.
    expect(clean).toHaveLength(grid.w * grid.h);
    expect(moved[10]).not.toBe(clean[10]);
    const off = alignedSample(gray(frame({ occlude: true })), 1, identityH(), grid);
    const median = medianSample([clean, clean, clean, off], grid.w * grid.h);
    const mask = new Float32Array(grid.w * grid.h).fill(1);
    expect(medianDistance(clean, median, mask)).toBeCloseTo(0, 6);
    expect(medianDistance(off, median, mask)!).toBeGreaterThan(20);
    expect(medianDistance(clean, median, new Float32Array(grid.w * grid.h))).toBeNull();
  });
});

describe("temporal clone sources", () => {
  const scored = (clean: Record<number, number>, n = 10): ScoredFrame[] =>
    Array.from({ length: n }, (_, f) => ({
      time: f / 10,
      usable: true,
      sharpness: 1,
      speed: null,
      confidence: null,
      rms_px: null,
      coverage: 1,
      distance: null,
      score: 0.5,
      cleanliness: clean[f] ?? 1,
      reasons: [],
    }));

  it("proposes the offset k that maps the occluded frames onto clean ones, and reports the coverage", () => {
    // Frames 2 and 3 have someone in the hole. frames: k shows frame t + k at time t.
    const out = temporalSources(scored({ 2: 0.1, 3: 0.1 }), { fps: 10, step: 1, count: 30 });
    // k = 4 puts frames 2, 3 onto 6, 7 (clean) and no clean frame onto an occluded one. (k = -2 covers as many but puts frames 4, 5 onto the occluder.)
    expect(out[0]).toMatchObject({ frames: 4, covers: 2, occluded: 2, contaminates: 0, coverage: 1 });
    const dirty = new Set([2, 3]);
    for (const o of out.filter((x) => x.coverage === 1)) for (const f of dirty) expect(dirty.has(f + o.frames), `k=${o.frames}`).toBe(false);
    // k = 1 would put frame 2 onto the occluded frame 3: it covers only one of the two.
    expect(out.find((o) => o.frames === 1)).toMatchObject({ covers: 1, coverage: 0.5 });
  });

  it("counts the clean frames an offset would put the occluder back into, ranks by covers minus those, and names the span to trim to", () => {
    const out = temporalSources(scored({ 2: 0.1, 3: 0.1 }), { fps: 10, step: 1, count: 30 });
    const back = out.find((o) => o.frames === -2)!;
    // Frames 4 and 5 are clean, and 4 - 2, 5 - 2 are the occluded frames 2 and 3.
    expect(back).toMatchObject({ covers: 2, contaminates: 2 });
    // The out point is exclusive: the layer must run through the last occluded frame (3), so it ends at frame 4.
    expect(back.span).toEqual({ start: 0.2, end: 0.4 });
    // Samples 2 frames apart: the occluder can be up to 1 frame before the first and after the last occluded sample; clamped to the sampled range (frames 0 to 9, out point at most 10).
    const coarse = temporalSources(scored({ 2: 0.1, 4: 0.1 }), { fps: 10, step: 2, count: 30 });
    expect(coarse[0].span).toEqual({ start: 0.1, end: 0.6 });
    const edge = temporalSources(scored({ 0: 0.1, 9: 0.1 }), { fps: 10, step: 2, count: 30 });
    expect(edge[0].span).toEqual({ start: 0, end: 1 });
    const net = (o: (typeof out)[number]) => o.covers - o.contaminates;
    for (let i = 1; i < out.length; i++) expect(net(out[i - 1])).toBeGreaterThanOrEqual(net(out[i]));
    expect(out.indexOf(back)).toBeGreaterThan(0);
    // The recommended offset leaves every clean sample on a clean frame.
    const clean = [0, 1, 4, 5, 6, 7, 8, 9];
    expect(clean.filter((f) => [2, 3].includes(f + out[0].frames))).toEqual([]);
  });

  it("does not credit an offset whose target frame is occluded", () => {
    // Occluded: 2..5. k = 2 puts t=2,3 onto 4,5 (dirty) and t=4,5 onto 6,7 (clean): half the cover.
    const out = temporalSources(scored({ 2: 0.1, 3: 0.1, 4: 0.1, 5: 0.1 }), { fps: 10, step: 1, count: 20 });
    expect(out.find((o) => o.frames === 2)).toMatchObject({ covers: 2, occluded: 4, coverage: 0.5 });
    expect(out[0].covers).toBe(4);
    expect(out[0].frames).toBe(4);
  });

  it("returns nothing when no sample is occluded", () => {
    expect(temporalSources(scored({}), { fps: 10, step: 1 })).toEqual([]);
  });
});

describe("spatial clone sources", () => {
  it("finds a shift whose ring has the hole's neighbourhood texture", () => {
    const png = frame({ period: 36 });
    const gray = { width: W, height: H, data: Float32Array.from({ length: W * H }, (_, i) => png.data[i * 4]) };
    const hole: Array<[number, number]> = [[100, 60], [120, 60], [120, 80], [100, 80]];
    const found = findSpatialSources(gray, 1, hole, { ringPx: 10, count: 3 });
    expect(found.length).toBeGreaterThan(0);
    expect(Math.abs(found[0].dx) % 36).toBe(0);
    expect(found[0].dy).toBe(0);
    expect(found[0].nssd).toBeLessThan(0.05);
    // Sources are apart from each other.
    for (let i = 1; i < found.length; i++) expect(Math.hypot(found[i].dx - found[0].dx, found[i].dy - found[0].dy)).toBeGreaterThan(5);
  });

  it("keeps the shifted hole clear of the mask rim as well as the hole", () => {
    const png = frame({ period: 36 });
    const gray = { width: W, height: H, data: Float32Array.from({ length: W * H }, (_, i) => png.data[i * 4]) };
    const hole: Array<[number, number]> = [[100, 60], [120, 60], [120, 80], [100, 80]];
    const near = findSpatialSources(gray, 1, hole, { ringPx: 10, count: 6 });
    expect(near.some((c) => Math.abs(c.dx) === 36 && c.dy === 0)).toBe(true);
    // A 30 px rim: 36 px is less than the 20 px hole plus the rim.
    const wide = findSpatialSources(gray, 1, hole, { ringPx: 10, count: 6, clearancePx: 30 });
    expect(wide.length).toBeGreaterThan(0);
    for (const c of wide) expect(Math.abs(c.dx) >= 50 || Math.abs(c.dy) >= 50, `${c.dx},${c.dy}`).toBe(true);
  });

  it("finds nothing in a flat image", () => {
    const flat = { width: W, height: H, data: new Float32Array(W * H).fill(100) };
    expect(findSpatialSources(flat, 1, [[100, 60], [120, 60], [120, 80], [100, 80]], { ringPx: 10 })).toEqual([]);
  });
});

describe("files and sheets", () => {
  it("never overwrites a still", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-cp-plates-"));
    tmpDirs.push(dir);
    const first = uniqueStillPath(dir, "My: Plate?", 12);
    expect(path.basename(first)).toBe("My_ Plate_ still f12.png");
    fs.writeFileSync(first, "x");
    expect(path.basename(uniqueStillPath(dir, "My: Plate?", 12))).toBe("My_ Plate_ still f12 2.png");
  });

  it("refuses instead of returning a name that exists when 999 are taken", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-cp-full-"));
    tmpDirs.push(dir);
    fs.writeFileSync(path.join(dir, "P still f1.png"), "x");
    for (let n = 2; n < 1000; n++) fs.writeFileSync(path.join(dir, `P still f1 ${n}.png`), "x");
    expect(() => uniqueStillPath(dir, "P", 1)).toThrow(/nothing was overwritten/);
  });

  it("picks the first, reference and last frame once each", () => {
    expect(sheetTimes({ ref: 0.4, first: 0, last: 0.9, fps: 10 })).toEqual([0, 0.4, 0.9]);
    expect(sheetTimes({ ref: 0, first: 0, last: 0.9, fps: 10 })).toEqual([0, 0.9]);
  });

  it("lays tiles out in rows with the outline and a label", () => {
    const img = { width: W, height: H, data: Buffer.alloc(W * H * 4, 90) };
    const sheet = drawSheet(
      [0, 1, 2, 3].map((i) => ({ image: img, poly: [[100, 60], [140, 60], [140, 90], [100, 90]] as Array<[number, number]>, label: `t${i}` })),
      { cols: 2, compSize: [W, H], tile: 120 }
    );
    expect(sheet.width).toBe(2 * 120 + 4);
    expect(sheet.height).toBe(2 * 80 + 4);
  });
});

// ---------- schemas ----------

describe("schemas", () => {
  const base = { comp_id: 1, plate: { index: 1 }, ref_time: 0.4, region: { rect: [100, 60, 40, 30] }, expect: expectArg };
  it("setup needs a plate, a ref_time and exactly one of region/regions in build", () => {
    expect(AeCleanplateSetupSchema.safeParse(base).success).toBe(true);
    expect(AeCleanplateSetupSchema.safeParse({ ...base, plate: undefined }).success).toBe(false);
    expect(AeCleanplateSetupSchema.safeParse({ ...base, ref_time: undefined }).success).toBe(false);
    expect(AeCleanplateSetupSchema.safeParse({ ...base, regions: [{ rect: [0, 0, 5, 5] }] }).success).toBe(false);
    expect(AeCleanplateSetupSchema.safeParse({ ...base, region: undefined, regions: Array.from({ length: 17 }, () => ({ rect: [0, 0, 5, 5] })) }).success).toBe(false);
    expect(AeCleanplateSetupSchema.safeParse({ ...base, region: undefined, regions: [{ rect: [0, 0, 5, 5] }, { ellipse: [9, 9, 3, 3] }] }).success).toBe(true);
  });

  it("ties the source to its options", () => {
    expect(AeCleanplateSetupSchema.safeParse({ ...base, source: "clone_offset" }).success).toBe(false);
    expect(AeCleanplateSetupSchema.safeParse({ ...base, source: "clone_offset", offset: { dx: 0, dy: 0, frames: 0 } }).success).toBe(false);
    expect(AeCleanplateSetupSchema.safeParse({ ...base, source: "clone_offset", offset: { dx: 40 } }).success).toBe(true);
    expect(AeCleanplateSetupSchema.safeParse({ ...base, offset: { dx: 40 } }).success).toBe(false);
    expect(AeCleanplateSetupSchema.safeParse({ ...base, still_footage_id: 5 }).success).toBe(false);
    expect(AeCleanplateSetupSchema.safeParse({ ...base, source: "still", still_footage_id: 5 }).success).toBe(true);
  });

  it("reload needs one footage_id or patch_comp_id, and no expect-less call", () => {
    expect(AeCleanplateSetupSchema.safeParse({ comp_id: 1, action: "reload", footage_id: 9, expect: expectArg }).success).toBe(true);
    expect(AeCleanplateSetupSchema.safeParse({ comp_id: 1, action: "reload", expect: expectArg }).success).toBe(false);
    expect(AeCleanplateSetupSchema.safeParse({ comp_id: 1, action: "reload", footage_id: 9, patch_comp_id: 8, expect: expectArg }).success).toBe(false);
    expect(AeCleanplateSetupSchema.safeParse({ ...base, expect: undefined }).success).toBe(false);
    expect(AeCleanplateSetupSchema.safeParse({ ...base, feather_px: 900 }).success).toBe(false);
  });

  it("pick needs plate and expect to isolate", () => {
    const p = { comp_id: 1, region: { ellipse: [120, 75, 20, 15] } };
    expect(AeCleanplatePickSchema.safeParse(p).success).toBe(true);
    expect(AeCleanplatePickSchema.safeParse({ ...p, isolate: true }).success).toBe(false);
    expect(AeCleanplatePickSchema.safeParse({ ...p, isolate: true, plate: { index: 1 }, expect: expectArg }).success).toBe(true);
    expect(AeCleanplatePickSchema.safeParse({ ...p, max_renders: 500 }).success).toBe(false);
    expect(AeCleanplatePickSchema.parse(p)).toMatchObject({ mode: "static", every_n: 2, max_renders: 80, isolate: false });
  });

  it("describes both tools, the mutating one ends with the safety guidance", () => {
    const setup = tool("ae_cleanplate_setup");
    expect(setup.description.endsWith("target guard failure (kind: 'guard') means STOP and re-read state—do NOT retry with stale expectations.")).toBe(true);
    expect(setup.description).toMatch(/needs_fix/);
    expect(tool("ae_cleanplate_pick").description).toMatch(/recommended ref_time/);
  });
});

// ---------- the receipt check ----------

describe("setupMismatches", () => {
  const args = AeCleanplateSetupSchema.parse({ comp_id: 1, plate: { index: 1 }, ref_time: 0.4, region: { rect: [100, 60, 40, 30] }, expect: expectArg });
  const written = { patch_layer: { index: 1, id: 901, name: "P" }, patch_comp: { id: 900, name: "P", width: W, height: H }, source: "freeze", masks: 1 };
  const before = { numLayers: 1, layers: [{ index: 1, id: 100, enabled: true }] };
  const good: HostInspect = {
    num_layers: 2,
    plate: { index: 2, id: 100, enabled: true },
    patch: { found: true, index: 1, id: 901, source_id: 900, masks: [{ mode: "add", feather: [4, 4], expansion: 2, num_keys_path: 0 }], effects: [], position_keys: 10 },
    inner: { layers: 1, first: { name: "x", kind: "footage", time_remap_enabled: true, time_remap_keys: 1, position_keys: 0 } },
    holdout: null,
  };
  const expected = { regions: 1, feather: 4, expansion: 2, keys: 10, pin: false, holdout: false, cloneMaskKeys: null };

  it("checks the patch layer's in/out against the requested trim, within half a frame", () => {
    const withIo = (in_point?: number, out_point?: number): HostInspect => ({ ...good, patch: { ...good.patch!, in_point, out_point } });
    const exp = { ...expected, trim: { start: 0, end: 0.6, tol: 0.05 } };
    expect(setupMismatches({ args, plateId: 100, before, inspect: withIo(0, 0.6), written, expected: exp })).toEqual([]);
    expect(setupMismatches({ args, plateId: 100, before, inspect: withIo(0.02, 0.58), written, expected: exp })).toEqual([]);
    expect(setupMismatches({ args, plateId: 100, before, inspect: withIo(0, 1), written, expected: exp }).map((m) => m.path)).toEqual(["patch_layer.trim"]);
    expect(setupMismatches({ args, plateId: 100, before, inspect: withIo(0.3, 0.6), written, expected: exp }).map((m) => m.path)).toEqual(["patch_layer.trim"]);
    expect(setupMismatches({ args, plateId: 100, before, inspect: withIo(undefined, undefined), written, expected: exp }).map((m) => m.path)).toEqual(["patch_layer.trim"]);
    // No trim asked for: in/out are not looked at.
    expect(setupMismatches({ args, plateId: 100, before, inspect: withIo(0, 1), written, expected })).toEqual([]);
  });

  it("accepts what was asked for and flags each way it can differ", () => {
    expect(setupMismatches({ args, plateId: 100, before, inspect: good, written, expected })).toEqual([]);
    const bad = (patch: Partial<NonNullable<HostInspect["patch"]>>) => setupMismatches({ args, plateId: 100, before, inspect: { ...good, patch: { ...good.patch!, ...patch } }, written, expected });
    expect(bad({ masks: [] }).map((m) => m.path)).toContain("masks.count");
    expect(bad({ masks: [{ mode: "add", feather: [9, 9], expansion: 2, num_keys_path: 0 }] }).map((m) => m.path)).toContain("masks[0].feather");
    expect(bad({ masks: [{ mode: "add", feather: [4, 4], expansion: 0, num_keys_path: 0 }] }).map((m) => m.path)).toContain("masks[0].expansion");
    expect(bad({ position_keys: 3 }).map((m) => m.path)).toContain("patch_layer.position_keys");
    expect(bad({ index: 3 }).map((m) => m.path)).toContain("patch_layer.index");
    expect(setupMismatches({ args, plateId: 100, before, inspect: { ...good, num_layers: 5 }, written, expected }).map((m) => m.path)).toContain("numLayers");
    expect(setupMismatches({ args, plateId: 100, before, inspect: { ...good, patch: { found: false } }, written, expected }).map((m) => m.path)).toEqual(["patch_layer"]);
    expect(setupMismatches({ args, plateId: 100, before, inspect: { ...good, inner: { layers: 1, first: { ...good.inner!.first!, time_remap_keys: 3 } } }, written, expected }).map((m) => m.path)).toContain("inner.time_remap_keys");
    expect(setupMismatches({ args, plateId: 100, before, inspect: good, written, expected: { ...expected, holdout: true } }).map((m) => m.path)).toContain("patch_layer.matte.type");
    // No read-back is not a pass.
    expect(setupMismatches({ args, plateId: 100, before, inspect: null, written, expected }).map((m) => m.path)).toEqual(["read_back"]);
  });

  it("checks the holdout's matte layer and that its video was switched off", () => {
    const hold = { ...expected, holdout: true, holdoutId: 300, holdoutHidden: true };
    const withHold = (matte: { type: string; layer_id: number | null }, enabled: boolean): HostInspect => ({ ...good, patch: { ...good.patch!, matte }, holdout: { id: 300, enabled } });
    expect(setupMismatches({ args, plateId: 100, before, inspect: withHold({ type: "alpha_inverted", layer_id: 300 }, false), written, expected: hold })).toEqual([]);
    expect(setupMismatches({ args, plateId: 100, before, inspect: withHold({ type: "alpha_inverted", layer_id: 301 }, false), written, expected: hold }).map((m) => m.path)).toContain("patch_layer.matte.layer_id");
    expect(setupMismatches({ args, plateId: 100, before, inspect: withHold({ type: "alpha_inverted", layer_id: 300 }, true), written, expected: hold }).map((m) => m.path)).toContain("holdout.enabled");
  });

  it("checks the clone's compensation keys inside the patch comp", () => {
    const cloneArgs = AeCleanplateSetupSchema.parse({ comp_id: 1, plate: { index: 1 }, ref_time: 0.4, region: { rect: [100, 60, 40, 30] }, source: "clone_offset", offset: { dx: 90, dy: 0, frames: 0 }, expect: expectArg });
    const exp = { ...expected, keys: null, cloneMaskKeys: 1, clonePositionKeys: 10 };
    const masks = [{ mode: "add", feather: [4, 4], expansion: 2, num_keys_path: 10 }];
    const ok: HostInspect = { ...good, patch: { ...good.patch!, masks }, inner: { layers: 1, first: { name: "c", kind: "footage", time_remap_enabled: false, time_remap_keys: 0, position_keys: 10 } } };
    expect(setupMismatches({ args: cloneArgs, plateId: 100, before, inspect: ok, written: { ...written, source: "clone_offset" }, expected: exp })).toEqual([]);
    const short: HostInspect = { ...ok, inner: { layers: 1, first: { ...ok.inner!.first!, position_keys: 0 } } };
    expect(setupMismatches({ args: cloneArgs, plateId: 100, before, inspect: short, written: { ...written, source: "clone_offset" }, expected: exp }).map((m) => m.path)).toContain("inner.position_keys");
  });
});

// ---------- the tools with a fake AE ----------

interface Call {
  fn: string;
  args: any;
}
interface AeOpts {
  plate?: Record<string, unknown>;
  holdout?: Record<string, unknown> | null;
  comp?: Record<string, unknown>;
  project?: Record<string, unknown>;
  inspect?: (build: any) => Record<string, unknown>;
  failSnapshotAfter?: number;
  frameFor?: (t: number, compId: number) => PNG;
  projectPath?: string;
  /** The project AE says is open (checkGuard); default: whatever the call expects. */
  guardPath?: string;
}

const COPY_ID = 777;
const PLATE = { index: 1, id: 100, name: "Plate", kind: "footage", locked: false, three_d: false, has_video: true, enabled: true, parent_id: null, start_time: 0, stretch: 100, in_point: 0, out_point: 1, width: W, height: H, source_id: 5, source_is_still: false, can_time_remap: true, time_remap_enabled: false, modern_matte_api: true, transform_animated: [], position_separated: false, position: [120, 80] };

function fakeAe(opts: AeOpts = {}) {
  const calls: Call[] = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-cleanplate-q-"));
  tmpDirs.push(dir);
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
  let build: any = null;
  let snaps = 0;
  const host = new PanelHost({
    evalScript: async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      const args = JSON.parse(script.slice(script.indexOf("(") + 1, script.lastIndexOf(")")));
      calls.push({ fn, args });
      const ok = (result: unknown) => ({ ok: true, result, durationMs: 1 });
      if (fn === "checkGuard") return ok({ ok: true, project_path: opts.guardPath ?? args.expect.project_path, comp_id: 1, comp_is_valid: true });
      if (fn === "cleanplateRead") {
        return ok({
          comp: { id: 1, name: "Main", width: W, height: H, pixel_aspect: 1, fps: 10, frame_duration: 0.1, duration: 1, work_area_start: 0, work_area_duration: 1, motion_blur: true, resolution_factor: [1, 1], ...opts.comp },
          project: { path: opts.projectPath ?? "<unsaved>", bits_per_channel: 8, linear_blending: false, ...opts.project },
          plate: args.plate ? { ...PLATE, ...opts.plate } : null,
          holdout: args.holdout && opts.holdout !== null ? { ...PLATE, index: 3, id: 300, name: "Roto", ...opts.holdout } : null,
          num_layers: 3,
        });
      }
      if (fn === "planarRead") {
        const times = Array.from({ length: 10 }, (_, i) => i / 10);
        return ok({ kind: "nulls", comp: { width: W, height: H, fps: 10 }, names: ["Null 1"], times, series: times.map((_, i) => [[100 + 3 * i, 60 + i]]), truncated: false, keyed_frames: 10, interpolated_frames: 0, off_grid_keys: 0, expression_driven: [] });
      }
      if (fn === "snapshotFrame") {
        snaps++;
        if (opts.failSnapshotAfter !== undefined && snaps > opts.failSnapshotAfter) throw new Error("render failed");
        fs.mkdirSync(path.dirname(args.output_path), { recursive: true });
        fs.writeFileSync(args.output_path, PNG.sync.write(opts.frameFor ? opts.frameFor(args.time, args.comp_id) : frame({})));
        return ok({ path: args.output_path, time: args.time });
      }
      if (fn === "planarIsolateBegin") return ok({ copy_id: COPY_ID, copy_name: "_chroma_plate_Main", original_id: 1 });
      if (fn === "planarIsolateEnd") return ok({ removed: true, copy_id: COPY_ID });
      if (fn === "layerStack") return ok({ comp_id: 1, name: "Main", numLayers: 3, layers: [{ index: 1, id: 300, enabled: true }, { index: 2, id: 100, enabled: true }, { index: 3, id: 50, enabled: true }] });
      if (fn === "cleanplateBuild") {
        build = args;
        return ok({
          patch_layer: { index: 2, id: 901, name: args.name },
          patch_comp: { id: 900, name: args.name, width: W, height: H },
          source: args.source,
          masks: args.regions.length,
          notes: ["host note"],
          ...(args.source === "still" ? { imported_item: { id: 55, name: "still.png" } } : {}),
          ...(args.holdout ? { holdout: { id: 300, name: "Roto", hidden: true } } : {}),
        });
      }
      if (fn === "cleanplateInspect") {
        if (opts.inspect) return ok(opts.inspect(build));
        const hasPin = build.writes.some((w: any) => w.target === "corner_pin");
        return ok({
          num_layers: 4,
          plate: { index: 3, id: 100, enabled: true },
          patch: {
            found: true,
            index: 2,
            id: 901,
            name: build.name,
            source_id: 900,
            enabled: true,
            in_point: build.trim ? build.trim.start : 0,
            out_point: build.trim ? build.trim.end : 1,
            matte: build.holdout ? { type: "alpha_inverted", layer_id: 300 } : { type: "none", layer_id: null },
            masks: build.regions.map((r: any) => ({ mode: "add", feather: [build.feather, build.feather], expansion: build.expansion, num_keys_path: r.keys ? r.keys.times.length : 0 })),
            effects: hasPin ? ["ADBE Corner Pin"] : [],
            position_keys: build.writes.find((w: any) => w.target === "transform")?.times.length ?? 0,
          },
          inner: { layers: 1, first: { name: "Plate (frozen)", kind: "footage", time_remap_enabled: build.source === "freeze", time_remap_keys: build.source === "freeze" ? 1 : 0, position_keys: build.clone?.position?.times.length ?? 0 } },
          holdout: build.holdout ? { id: 300, enabled: false } : null,
        });
      }
      if (fn === "cleanplateFootage") return ok({ found: true, id: args.footage_id, name: "still.png", path: "x.png", missing: false, width: W, height: H });
      if (fn === "cleanplateReload") return ok({ no_op: true, reloaded: true, footage: { id: args.footage_id ?? 55, name: "still.png", path: "x.png" } });
      throw new Error(`Unexpected script: ${script}`);
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge: host, queue, quarantine };
  return { ctx, calls, fns: () => calls.map((c) => c.fn), dir };
}

const setupArgs = (extra: Record<string, unknown> = {}) =>
  AeCleanplateSetupSchema.parse({ comp_id: 1, plate: { index: 1 }, ref_time: 0.4, region: { rect: [100, 60, 40, 30] }, expect: expectArg, ...extra });

describe("ae_cleanplate_setup (build)", () => {
  it("freeze: reads, renders before, guards, builds, reads back separately, renders after, and says it needs a fix", async () => {
    saveTrack(shiftTrack(10, "similarity", 0));
    const { ctx, calls, fns } = fakeAe();
    const out: any = await tool("ae_cleanplate_setup").handler(setupArgs({ track: { track_id: "trk_cp_fixture" } }), ctx);
    expect(out.ok).toBe(true);
    // Reads and the before frames come first, in their own lease; the write is guarded.
    const order = fns();
    expect(order.slice(0, 4)).toEqual(["cleanplateRead", "snapshotFrame", "snapshotFrame", "snapshotFrame"]);
    expect(order.slice(4, 8)).toEqual(["checkGuard", "layerStack", "cleanplateBuild", "cleanplateInspect"]);
    expect(order.slice(8)).toEqual(["snapshotFrame", "snapshotFrame", "snapshotFrame"]);
    const b = calls.find((c) => c.fn === "cleanplateBuild")!.args;
    expect(b).toMatchObject({ source: "freeze", ref_time: 0.4, plate_id: 100, plate_index: 1, motion_blur: true, name: "Plate PATCH f4" });
    expect(b.expect).toMatchObject(expectArg);
    expect(b.writes).toHaveLength(1);
    expect(b.writes[0]).toMatchObject({ target: "transform" });
    // Re-based on ref_time 0.4: the identity at 0.4, so the key there is the centre.
    const i = b.writes[0].times.findIndex((t: number) => Math.abs(t - 0.4) < 1e-6);
    expect(b.writes[0].values.position[i][0]).toBeCloseTo(W / 2, 3);
    expect(b.regions[0].shape.vertices).toEqual([[100, 60], [140, 60], [140, 90], [100, 90]]);
    expect(b.expansion).toBeGreaterThanOrEqual(b.feather / 2);
    expect(out.receipt.matches).toBe(true);
    expect(out.needs_fix).toBe(true);
    expect(out.fixes_in_order.length).toBeGreaterThanOrEqual(3);
    expect(out.tracked).toMatchObject({ mode: "transform", track_id: "trk_cp_fixture" });
    expect(out.notes).toContain("host note");
    expect(JSON.stringify(out.next_steps)).toMatch(/ae_patch_grain/);
    expect(fs.existsSync(out.before_after_sheet)).toBe(true);
    const sheet = PNG.sync.read(fs.readFileSync(out.before_after_sheet));
    expect(sheet.width).toBeGreaterThan(sheet.height);
  }, 30000);

  it("clean_frame clears needs_fix; perspective tracks add the pin write", async () => {
    saveTrack({ ...shiftTrack(10, "perspective", 0), track_id: "trk_cp_persp" });
    const { ctx, calls } = fakeAe();
    const out: any = await tool("ae_cleanplate_setup").handler(setupArgs({ track: { track_id: "trk_cp_persp" }, clean_frame: true }), ctx);
    expect(out.needs_fix).toBe(false);
    expect(out.fixes_in_order).toBeUndefined();
    const b = calls.find((c) => c.fn === "cleanplateBuild")!.args;
    expect(b.writes.map((w: any) => w.target)).toEqual(["transform", "corner_pin"]);
    expect(b.writes[1].add_effect).toBe(true);
    expect(out.receipt.matches).toBe(true);
  }, 30000);

  it("regions become separate masks; the holdout is passed; clone_offset with no track is static and needs no fix", async () => {
    const { ctx, calls } = fakeAe();
    const out: any = await tool("ae_cleanplate_setup").handler(
      setupArgs({ region: undefined, regions: [{ rect: [100, 60, 40, 30] }, { ellipse: [60, 40, 10, 8] }], holdout: { index: 3 }, source: "clone_offset", offset: { dx: 120, dy: 0, frames: 0 } }),
      ctx
    );
    expect(out.ok).toBe(true);
    const b = calls.find((c) => c.fn === "cleanplateBuild")!.args;
    expect(b.regions).toHaveLength(2);
    expect(b.regions[1].shape.vertices).toHaveLength(4);
    expect(b.holdout).toEqual({ id: 300 });
    expect(b.clone).toMatchObject({ frames: 0, static_shift: [-120, 0] });
    expect(b.motion_blur).toBe(false);
    expect(out.needs_fix).toBe(false);
    expect(out.holdout).toMatchObject({ id: 300, hidden: true });
    expect(out.receipt.matches).toBe(true);
    expect(out.notes.join(" ")).toMatch(/locked-off/);
    // The note names the three tools that take one region; ae_patch_check runs once and reads every mask.
    const regionNote = out.notes.find((n: string) => /2 regions/.test(n));
    expect(regionNote).toMatch(/ae_patch_color_match, ae_patch_grain and ae_patch_finish take one region at a time/);
    expect(regionNote).toMatch(/ae_patch_check runs once/);
    expect(regionNote).not.toMatch(/repeat the calls/);
    expect(out.next_steps.find((n: any) => n.tool === "ae_patch_check").args.region).toBeUndefined();
  }, 30000);

  it("raises an expansion below half the feather and says so", async () => {
    const { ctx, calls } = fakeAe();
    const out: any = await tool("ae_cleanplate_setup").handler(setupArgs({ feather_px: 10, expansion_px: 1 }), ctx);
    expect(calls.find((c) => c.fn === "cleanplateBuild")!.args).toMatchObject({ feather: 10, expansion: 5 });
    expect(out.notes.join(" ")).toMatch(/raised to 5/);
    expect(out.receipt.matches).toBe(true);
  }, 30000);

  it("puts a read-back mismatch into the receipt without throwing", async () => {
    const { ctx } = fakeAe({ inspect: () => ({ num_layers: 4, plate: { index: 3, id: 100, enabled: true }, patch: { found: true, index: 2, id: 901, source_id: 900, masks: [], effects: [], position_keys: 0 }, inner: null, holdout: null }) });
    const out: any = await tool("ae_cleanplate_setup").handler(setupArgs(), ctx);
    expect(out.applied).toBe(true);
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches.map((m: any) => m.path)).toContain("masks.count");
  }, 30000);

  it("keeps the write's result when the after render fails", async () => {
    const { ctx } = fakeAe({ failSnapshotAfter: 3 });
    const out: any = await tool("ae_cleanplate_setup").handler(setupArgs(), ctx);
    expect(out.applied).toBe(true);
    expect(out.before_after_sheet).toBeUndefined();
    expect(out.sheet_error).toMatch(/render failed/);
    expect(out.receipt.matches).toBe(true);
  }, 30000);

  it("refuses before the write: locked, 3D, parented, missing time remap, bad holdout, bad track, odd pixels", async () => {
    const cases: Array<[AeOpts, Record<string, unknown>, RegExp]> = [
      [{ plate: { locked: true } }, {}, /locked/],
      [{ plate: { three_d: true } }, {}, /3D/],
      [{ plate: { parent_id: 7 } }, {}, /parent/],
      [{ plate: { can_time_remap: false } }, {}, /time-remapped/],
      [{ plate: { transform_animated: ["position"] } }, { source: "clone_offset", offset: { dx: 50 } }, /animated/],
      [{ plate: { modern_matte_api: false } }, { holdout: { index: 3 } }, /AE 23/],
      [{ holdout: null }, { holdout: { index: 3 } }, /holdout layer was not found/],
      [{ comp: { pixel_aspect: 2 } }, {}, /pixel aspect/],
      [{}, { track: { track_id: "trk_missing" } }, /No stored track/],
      [{}, { region: { rect: [0, 0, 0, 5] } }, /width and height/],
      [{}, { region: { rect: [500, 500, 10, 10] } }, /outside the comp/],
      [{ comp: { resolution_factor: [2, 2] } }, { source: "still" }, /Full/],
      [{ holdout: { locked: true } }, { holdout: { index: 3 } }, /holdout layer .* is locked/],
      [{ plate: { position_separated: true, transform_animated: [] } }, {}, /separated/],
      [{ plate: { position_separated: true } }, { source: "clone_offset", offset: { dx: 50 } }, /separated/],
      [{}, { ref_time: 1 }, /end of the comp/],
    ];
    for (const [opts, extra, msg] of cases) {
      const { ctx, fns } = fakeAe(opts);
      const out: any = await tool("ae_cleanplate_setup").handler(setupArgs(extra), ctx);
      expect(out.ok, msg.source).toBe(false);
      expect(out.message).toMatch(msg);
      expect(fns()).not.toContain("cleanplateBuild");
    }
    // A track with no solved motion at ref_time.
    const t = shiftTrack(10, "translate", 0);
    t.frames[4] = { ...t.frames[4], ok: false, H: null };
    saveTrack({ ...t, track_id: "trk_cp_hole" });
    const { ctx, fns } = fakeAe();
    const out: any = await tool("ae_cleanplate_setup").handler(setupArgs({ track: { track_id: "trk_cp_hole" } }), ctx);
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/no solved motion at ref_time/);
    expect(fns()).not.toContain("cleanplateBuild");
  }, 30000);

  it("a clone offset smaller than the hole still contains the object: needs_fix, with a fix list for the offset", async () => {
    const { ctx } = fakeAe();
    const small: any = await tool("ae_cleanplate_setup").handler(setupArgs({ source: "clone_offset", offset: { dx: 10, dy: 0, frames: 0 } }), ctx);
    expect(small.ok).toBe(true);
    expect(small.needs_fix).toBe(true);
    expect(small.needs_fix_message).toMatch(/smaller than the hole/);
    expect(small.fixes_in_order[0]).toMatch(/offset/);
    // A time-only clone shows the same scene point at another frame: the object is back unless that frame is clean.
    const timed: any = await tool("ae_cleanplate_setup").handler(setupArgs({ source: "clone_offset", offset: { dx: 10, dy: 0, frames: 3 } }), fakeAe().ctx);
    expect(timed.needs_fix).toBe(true);
    expect(timed.needs_fix_message).toMatch(/shifted in time only/);
    expect(timed.fixes_in_order[0]).toMatch(/clean_frame: true/);
    const stated: any = await tool("ae_cleanplate_setup").handler(setupArgs({ source: "clone_offset", offset: { dx: 10, dy: 0, frames: 3 }, clean_frame: true }), fakeAe().ctx);
    expect(stated.needs_fix).toBe(false);
    // A spatial offset that clears the hole needs no statement, with or without a frame offset.
    const cleared: any = await tool("ae_cleanplate_setup").handler(setupArgs({ source: "clone_offset", offset: { dx: 90, dy: 0, frames: 3 } }), fakeAe().ctx);
    expect(cleared.needs_fix).toBe(false);
  }, 30000);

  it("a clone offset must clear the hole plus the mask rim, not just the hole", async () => {
    // 40 px wide hole, feather 1 + expansion 0.5: the rim is 1 px, so 40 px is not enough.
    const tight: any = await tool("ae_cleanplate_setup").handler(setupArgs({ source: "clone_offset", offset: { dx: 40, dy: 0, frames: 0 } }), fakeAe().ctx);
    expect(tight.needs_fix).toBe(true);
    expect(tight.notes.join(" ")).toMatch(/mask rim/);
    const clear: any = await tool("ae_cleanplate_setup").handler(setupArgs({ source: "clone_offset", offset: { dx: 42, dy: 0, frames: 0 } }), fakeAe().ctx);
    expect(clear.needs_fix).toBe(false);
  }, 30000);

  it("snaps ref_time to the frame grid once and uses it for the hold, the track re-base and the name", async () => {
    saveTrack({ ...shiftTrack(10, "similarity", 0), track_id: "trk_cp_snap" });
    const { ctx, calls } = fakeAe();
    // 10 fps: 0.47 s is between frames 4 and 5; the nearest is frame 5.
    const out: any = await tool("ae_cleanplate_setup").handler(setupArgs({ ref_time: 0.47, track: { track_id: "trk_cp_snap" } }), ctx);
    expect(out.ok).toBe(true);
    const b = calls.find((c) => c.fn === "cleanplateBuild")!.args;
    expect(b.ref_time).toBe(0.5);
    expect(b.name).toBe("Plate PATCH f5");
    expect(calls.find((c) => c.fn === "cleanplateInspect")!.args.time).toBe(0.5);
    const i = b.writes[0].times.findIndex((t: number) => Math.abs(t - 0.5) < 1e-6);
    expect(b.writes[0].values.position[i][0]).toBeCloseTo(W / 2, 3);
    expect(out.tracked.ref_time).toBe(0.5);
    expect(out.notes.join(" ")).toMatch(/snapped to the frame grid: 0\.5/);
  }, 30000);

  it("refuses a ref_time outside the plate layer's in/out, and a holdout with no video, before the write", async () => {
    const cases: Array<[AeOpts, Record<string, unknown>, RegExp]> = [
      [{ plate: { in_point: 0.5, out_point: 1 } }, {}, /plate layer's in\/out/],
      [{ plate: { in_point: 0, out_point: 0.3 } }, {}, /plate layer's in\/out/],
      [{ plate: { in_point: 0, out_point: 0.4 } }, {}, /plate layer's in\/out/],
      [{ holdout: { has_video: false } }, { holdout: { index: 3 } }, /has no video/],
    ];
    for (const [opts, extra, msg] of cases) {
      const { ctx, fns } = fakeAe(opts);
      const out: any = await tool("ae_cleanplate_setup").handler(setupArgs(extra), ctx);
      expect(out.ok, msg.source).toBe(false);
      expect(out.message).toMatch(msg);
      expect(fns()).not.toContain("cleanplateBuild");
    }
  }, 30000);

  it("trims the patch layer to the keyed span and reports the uncovered ranges when the track stops early", async () => {
    saveTrack({ ...shiftTrack(6, "similarity", 0), track_id: "trk_cp_part" });
    const { ctx, calls } = fakeAe();
    const out: any = await tool("ae_cleanplate_setup").handler(setupArgs({ ref_time: 0.2, track: { track_id: "trk_cp_part" } }), ctx);
    expect(out.ok).toBe(true);
    const b = calls.find((c) => c.fn === "cleanplateBuild")!.args;
    // Keyed 0 to 0.5, the last key holds one frame: the layer runs 0 to 0.6 of the plate's 0 to 1.
    expect(b.trim.start).toBe(0);
    expect(b.trim.end).toBeCloseTo(0.6, 6);
    expect(out.uncovered_ranges).toEqual([{ start: 0.6, end: 1 }]);
    expect(out.notes.join(" ")).toMatch(/show the plate WITHOUT the patch/);
    // The trim counts only when the separate read-back shows it.
    expect(out.trim_confirmed).toBe(true);
    expect(out.patch_trimmed).toEqual({ in_point: 0, out_point: b.trim.end });
    expect(out.notes.join(" ")).toMatch(/confirmed by the read-back/);
    expect(out.receipt.matches).toBe(true);
    // A trim the read-back does not show is a receipt mismatch and is not claimed.
    const lost = fakeAe({ inspect: (build) => ({ num_layers: 4, plate: { index: 3, id: 100, enabled: true }, patch: { found: true, index: 2, id: 901, name: build.name, source_id: 900, enabled: true, in_point: 0, out_point: 1, matte: { type: "none", layer_id: null }, masks: build.regions.map(() => ({ mode: "add", feather: [build.feather, build.feather], expansion: build.expansion, num_keys_path: 0 })), effects: [], position_keys: build.writes.find((w: any) => w.target === "transform")?.times.length ?? 0 }, inner: { layers: 1, first: { name: "Plate (frozen)", kind: "footage", time_remap_enabled: true, time_remap_keys: 1, position_keys: 0 } }, holdout: null }) });
    const lostOut: any = await tool("ae_cleanplate_setup").handler(setupArgs({ ref_time: 0.2, track: { track_id: "trk_cp_part" } }), lost.ctx);
    expect(lostOut.receipt.matches).toBe(false);
    expect(lostOut.trim_confirmed).toBe(false);
    expect(lostOut.patch_trimmed).toBeNull();
    expect(lostOut.notes.join(" ")).toMatch(/NOT confirmed/);
    expect(JSON.stringify(lostOut.receipt)).toMatch(/patch_layer\.trim/);
    // A full track needs no trim.
    saveTrack({ ...shiftTrack(10, "similarity", 0), track_id: "trk_cp_full" });
    const full = fakeAe();
    const ok: any = await tool("ae_cleanplate_setup").handler(setupArgs({ track: { track_id: "trk_cp_full" } }), full.ctx);
    expect(full.calls.find((c) => c.fn === "cleanplateBuild")!.args.trim).toBeUndefined();
    expect(ok.uncovered_ranges).toBeUndefined();
  }, 30000);

  it("counts only the part of the plate inside the comp: footage longer than the comp, tracked over the whole comp, needs no trim", async () => {
    saveTrack({ ...shiftTrack(10, "similarity", 0), track_id: "trk_cp_long" });
    const long = fakeAe({ plate: { in_point: 0, out_point: 30 } });
    const out: any = await tool("ae_cleanplate_setup").handler(setupArgs({ track: { track_id: "trk_cp_long" } }), long.ctx);
    expect(out.ok).toBe(true);
    expect(long.calls.find((c) => c.fn === "cleanplateBuild")!.args.trim).toBeUndefined();
    expect(out.uncovered_ranges).toBeUndefined();
    // A slid layer (negative in point) is clamped at 0 on the left too.
    const slid = fakeAe({ plate: { in_point: -5, out_point: 30 } });
    const out2: any = await tool("ae_cleanplate_setup").handler(setupArgs({ track: { track_id: "trk_cp_long" } }), slid.ctx);
    expect(slid.calls.find((c) => c.fn === "cleanplateBuild")!.args.trim).toBeUndefined();
    expect(out2.uncovered_ranges).toBeUndefined();
    // A short track on a long plate is still cut at the comp's end, not the plate's.
    saveTrack({ ...shiftTrack(6, "similarity", 0), track_id: "trk_cp_long_part" });
    const part = fakeAe({ plate: { in_point: 0, out_point: 30 } });
    const out3: any = await tool("ae_cleanplate_setup").handler(setupArgs({ ref_time: 0.2, track: { track_id: "trk_cp_long_part" } }), part.ctx);
    expect(out3.uncovered_ranges).toEqual([{ start: 0.6, end: 1 }]);
  }, 30000);

  it("tells the agent what a freeze does to the plate copy's animated effects and opacity", async () => {
    const { ctx } = fakeAe({ plate: { effects_animated: ["Corner Pin"], opacity_animated: true } });
    const out: any = await tool("ae_cleanplate_setup").handler(setupArgs(), ctx);
    const text = out.notes.join(" ");
    expect(text).toMatch(/Corner Pin/);
    expect(text).toMatch(/Opacity/);
  }, 30000);

  it("hands over ready-to-call argument blocks for the patch tools, in their own region format", async () => {
    saveTrack({ ...shiftTrack(10, "similarity", 0), track_id: "trk_cp_chain" });
    const { ctx } = fakeAe();
    const out: any = await tool("ae_cleanplate_setup").handler(setupArgs({ ref_time: 0.4, track: { track_id: "trk_cp_chain" } }), ctx);
    const step = (name: string) => out.next_steps.find((n: any) => n.tool === name).args;
    // ae_patch_check takes no region: the raw hole would count the mask rim as leakage; the default footprint is the patch layer's masks with expansion and feather.
    expect(step("ae_patch_check")).toMatchObject({ comp_id: 1, patch_layers: [{ id: 901 }], ref_time: 0.4 });
    expect(step("ae_patch_check").region).toBeUndefined();
    expect(step("ae_patch_check").region_track).toBeUndefined();
    expect(step("ae_patch_color_match")).toMatchObject({ layer: { id: 901 }, region: { kind: "rect", rect: [100, 60, 140, 90] }, track: { track_id: "trk_cp_chain" }, ref_time: 0.4 });
    for (const [sc, nm] of [[AePatchCheckSchema, "ae_patch_check"], [AePatchColorMatchSchema, "ae_patch_color_match"], [AePatchGrainSchema, "ae_patch_grain"], [AePatchFinishSchema, "ae_patch_finish"]] as const) {
      const r = (sc as any).safeParse(step(nm));
      expect(r.success, nm + " " + JSON.stringify(r.error?.issues)).toBe(true);
    }
    expect(out.patch_regions).toEqual([{ kind: "rect", rect: [100, 60, 140, 90] }]);
  }, 30000);

  it("passes an inline track source on as given: its generated track_id is never stored", async () => {
    const { ctx, fns } = fakeAe();
    const inline = { nulls: [{ index: 2 }] };
    const out: any = await tool("ae_cleanplate_setup").handler(setupArgs({ ref_time: 0.4, track: inline }), ctx);
    expect(out.ok).toBe(true);
    expect(fns()).toContain("planarRead");
    const step = (name: string) => out.next_steps.find((n: any) => n.tool === name).args;
    for (const [sc, nm] of [[AePatchColorMatchSchema, "ae_patch_color_match"], [AePatchGrainSchema, "ae_patch_grain"], [AePatchFinishSchema, "ae_patch_finish"], [AePatchCheckSchema, "ae_patch_check"]] as const) {
      const r = (sc as any).safeParse(step(nm));
      expect(r.success, nm + " " + JSON.stringify(r.error?.issues)).toBe(true);
    }
    expect(step("ae_patch_color_match").track).toEqual(inline);
    expect(step("ae_patch_grain").track).toEqual(inline);
    expect(JSON.stringify(out.next_steps)).not.toMatch(/track_id/);
    // The result does not report the generated id either: an agent reusing it would get not_found.
    expect(out.tracked).toBeTruthy();
    expect(out.tracked.track_id).toBeUndefined();
  }, 30000);

  it("warns when a tracked clone's source area leaves the frame", async () => {
    saveTrack(shiftTrack(10, "translate", 0));
    const { ctx } = fakeAe();
    const out: any = await tool("ae_cleanplate_setup").handler(setupArgs({ ref_time: 0, track: { track_id: "trk_cp_fixture" }, source: "clone_offset", offset: { dx: 90, dy: 0, frames: 0 } }), ctx);
    expect(out.ok).toBe(true);
    expect(out.notes.join(" ")).toMatch(/source area leaves the frame on \d+ tracked frame/);
  }, 30000);

  it("still: an isolate that fails after the copy returns a receipt instead of throwing, and the session counts the writes", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-cp-sess-"));
    tmpDirs.push(dir);
    const proj = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "chroma-cp-proj-")), "Fail.aep");
    tmpDirs.push(path.dirname(proj));
    try {
      installSessionTracking({ dataDir: dir });
      // Three before-frames render; the fourth, inside the isolated copy, fails.
      const { ctx, fns } = fakeAe({ projectPath: proj, failSnapshotAfter: 3 });
      const args = AeCleanplateSetupSchema.parse({ comp_id: 1, plate: { index: 1 }, ref_time: 0.4, region: { rect: [100, 60, 40, 30] }, source: "still", expect: { project_path: proj } });
      const out: any = await tool("ae_cleanplate_setup").handler(args, ctx);
      expect(out.ok).toBe(false);
      expect(out.message).toMatch(/render failed/);
      expect(out.temp_comp).toEqual({ copy_removed: true });
      expect(out.receipt.matches).toBe(true);
      expect(fns()).not.toContain("cleanplateBuild");
      expect(getSessionTracker()!.agentWritesSince(proj, null).length).toBeGreaterThan(0);
    } finally {
      resetSessionTracking();
    }
  }, 60000);

  it("still: a wrong expect.project_path is refused before any plates folder is made", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-cp-wrong-"));
    tmpDirs.push(root);
    const wrong = path.join(root, "Wrong.aep");
    const { ctx } = fakeAe({ projectPath: wrong, guardPath: path.join(root, "Other.aep") });
    const args = AeCleanplateSetupSchema.parse({ comp_id: 1, plate: { index: 1 }, ref_time: 0.4, region: { rect: [100, 60, 40, 30] }, source: "still", expect: { project_path: wrong } });
    await expect(tool("ae_cleanplate_setup").handler(args, ctx)).rejects.toThrow(/guard/i);
    expect(fs.readdirSync(root)).toEqual([]);
  }, 30000);

  it("still: refuses an unsaved project, else renders the isolated plate into the plates folder and imports it", async () => {
    const unsaved = fakeAe();
    const refused: any = await tool("ae_cleanplate_setup").handler(setupArgs({ source: "still" }), unsaved.ctx);
    expect(refused).toMatchObject({ ok: false, error: "refused" });
    expect(refused.message).toMatch(/Save it first/);
    expect(unsaved.fns()).not.toContain("cleanplateBuild");

    const proj = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "chroma-cp-proj-")), "Shot.aep");
    tmpDirs.push(path.dirname(proj));
    const { ctx, calls, fns } = fakeAe({ projectPath: proj });
    const args = AeCleanplateSetupSchema.parse({ comp_id: 1, plate: { index: 1 }, ref_time: 0.4, region: { rect: [100, 60, 40, 30] }, source: "still", expect: { project_path: proj } });
    const out: any = await tool("ae_cleanplate_setup").handler(args, ctx);
    expect(out.ok).toBe(true);
    const order = fns();
    expect(order.indexOf("planarIsolateBegin")).toBeLessThan(order.indexOf("cleanplateBuild"));
    expect(order.indexOf("planarIsolateEnd")).toBeLessThan(order.indexOf("cleanplateBuild"));
    const iso = calls.find((c) => c.fn === "planarIsolateBegin")!.args;
    expect(iso.show_layers).toEqual([{ index: 1, id: 100 }]);
    const snap = calls.filter((c) => c.fn === "snapshotFrame").find((c) => c.args.comp_id === COPY_ID)!.args;
    const plates = path.join(path.dirname(proj), "Shot chroma plates");
    // Rendered into the scratch frames folder, then copied: a stale first attempt can never be left among the stills.
    expect(path.dirname(snap.output_path)).not.toBe(plates);
    expect(fs.existsSync(snap.output_path)).toBe(false);
    const still = path.join(plates, "Plate still f4.png");
    expect(out.still_path).toBe(still);
    expect(fs.existsSync(still)).toBe(true);
    expect(fs.readdirSync(plates)).toEqual(["Plate still f4.png"]);
    expect(calls.find((c) => c.fn === "cleanplateBuild")!.args.still_path).toBe(still);
    expect(out.imported_item).toMatchObject({ id: 55 });
    expect(out.temp_comp).toEqual({ copy_removed: true });
    expect(out.needs_fix).toBe(true);
    expect(out.fixes_in_order[2]).toMatch(/Photoshop/);
    // A second still of the same frame gets a new name.
    const again: any = await tool("ae_cleanplate_setup").handler(args, fakeAe({ projectPath: proj }).ctx);
    expect(again.still_path).toBe(path.join(plates, "Plate still f4 2.png"));
  }, 60000);

  it("still: warns about depth in 16 bpc, and a placed still_footage_id needs no render and no fix", async () => {
    const proj = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "chroma-cp-proj-")), "Deep.aep");
    tmpDirs.push(path.dirname(proj));
    const { ctx, fns } = fakeAe({ projectPath: proj, project: { bits_per_channel: 16 } });
    const out: any = await tool("ae_cleanplate_setup").handler(AeCleanplateSetupSchema.parse({ comp_id: 1, plate: { index: 1 }, ref_time: 0.4, region: { rect: [100, 60, 40, 30] }, source: "still", still_footage_id: 12, expect: { project_path: proj } }), ctx);
    expect(out.needs_fix).toBe(false);
    expect(fns()).not.toContain("planarIsolateBegin");
    const w = await tool("ae_cleanplate_setup").handler(AeCleanplateSetupSchema.parse({ comp_id: 1, plate: { index: 1 }, ref_time: 0.4, region: { rect: [100, 60, 40, 30] }, source: "still", expect: { project_path: proj } }), fakeAe({ projectPath: proj, project: { bits_per_channel: 16 } }).ctx);
    expect((w as any).notes.join(" ")).toMatch(/16 bpc/);
  }, 60000);

  it("reload: guards, reloads without an undo step, re-renders the sheet", async () => {
    const { ctx, calls, fns } = fakeAe();
    const out: any = await tool("ae_cleanplate_setup").handler(AeCleanplateSetupSchema.parse({ comp_id: 1, action: "reload", footage_id: 55, expect: expectArg }), ctx);
    expect(out.ok).toBe(true);
    expect(out.reloaded).toBe(true);
    expect(fns()).toContain("checkGuard");
    expect(fns().indexOf("checkGuard")).toBeLessThan(fns().indexOf("cleanplateReload"));
    expect(calls.find((c) => c.fn === "cleanplateReload")!.args).toMatchObject({ footage_id: 55 });
    expect(fns().filter((f) => f === "snapshotFrame").length).toBeGreaterThanOrEqual(4);
    expect(fs.existsSync(out.before_after_sheet)).toBe(true);
    expect(out.receipt.matches).toBe(true);
    expect(fns()).not.toContain("cleanplateBuild");
  }, 30000);
});

describe("ae_cleanplate_pick", () => {
  const region = { rect: [96, 56, 48, 38] };
  const sharpAt4 = (t: number) => frame({ amp: Math.abs(t - 0.4) < 1e-6 ? 1 : 0.4 });

  it("recommends the sharpest frame, changes nothing and writes a contact sheet", async () => {
    const { ctx, fns, calls } = fakeAe({ frameFor: sharpAt4 });
    const out: any = await tool("ae_cleanplate_pick").handler(AeCleanplatePickSchema.parse({ comp_id: 1, region }), ctx);
    expect(out.ok).toBe(true);
    expect(out.recommended_ref_time).toBe(0.4);
    expect(out.recommended_frame).toBe(4);
    expect(out.sampled).toBe("sampled 5 of 5");
    expect(out.frames[0]).toMatchObject({ time: 0.4, frame: 4 });
    expect(out.frames[0].reasons).toContain("sharp");
    expect(out.notes.join(" ")).toMatch(/locked-off/);
    expect(fs.existsSync(out.contact_sheet_path)).toBe(true);
    // Read only: no guard, no write host, only the comp itself rendered.
    expect(fns().some((f) => /Build|Isolate|checkGuard/.test(f))).toBe(false);
    expect(calls.filter((c) => c.fn === "snapshotFrame").every((c) => c.args.comp_id === 1)).toBe(true);
    // 5 sampled frames plus one re-render of the best for the clone search.
    expect(fns().filter((f) => f === "snapshotFrame")).toHaveLength(6);
    expect(out.budget.renders_this_call).toBe(6);
  }, 60000);

  it("stays inside the render budget and says how many frames it sampled", async () => {
    const { ctx, fns } = fakeAe({ frameFor: sharpAt4 });
    const out: any = await tool("ae_cleanplate_pick").handler(AeCleanplatePickSchema.parse({ comp_id: 1, region, every_n: 1, max_renders: 5 }), ctx);
    expect(out.sampled).toMatch(/^sampled \d of 4$/);
    expect(fns().filter((f) => f === "snapshotFrame").length).toBeLessThanOrEqual(5);
    expect(out.notes.join(" ")).toMatch(/Every \d+th frame was sampled/);
  }, 60000);

  it("moving_occluder: frames with someone in the hole score low and a clean time offset is proposed", async () => {
    const occluded = (t: number) => frame({ occlude: Math.abs(t - 0.2) < 1e-6 || Math.abs(t - 0.3) < 1e-6 });
    const { ctx } = fakeAe({ frameFor: occluded });
    const out: any = await tool("ae_cleanplate_pick").handler(AeCleanplatePickSchema.parse({ comp_id: 1, region, mode: "moving_occluder", every_n: 1 }), ctx);
    expect(out.ok).toBe(true);
    expect([0.2, 0.3]).not.toContain(out.recommended_ref_time);
    const dirty = out.frames.filter((f: any) => f.time === 0.2 || f.time === 0.3);
    expect(dirty.length).toBe(2);
    for (const f of dirty) {
      expect(f.cleanliness).toBeLessThan(0.5);
      expect(f.reasons.join(" ")).toMatch(/something else/);
    }
    expect(out.frames.find((f: any) => f.time === out.recommended_ref_time).cleanliness).toBeGreaterThan(0.9);
    expect(out.clone_sources.temporal.length).toBeGreaterThan(0);
    expect(out.clone_sources.temporal[0].use).toMatch(/offset \{ frames: -?\d+ \}/);
    expect(out.clone_sources.temporal[0].contaminates_frames).toBeTypeOf("number");
    expect(out.clone_sources.temporal[0].occluded_span).toEqual({ start: 0.2, end: 0.4 });
    // Offsets that put the occluder back into clean frames say to trim the patch layer.
    for (const t of out.clone_sources.temporal) if (t.contaminates_frames > 0) expect(t.use).toMatch(/in point to 0\.2 s and its out point to 0\.4 s/);
  }, 60000);

  it("returns the region as it lies at the recommended frame, ready for setup", async () => {
    saveTrack({ ...shiftTrack(10, "translate", 0), track_id: "trk_cp_region" });
    const { ctx } = fakeAe({ frameFor: sharpAt4 });
    const out: any = await tool("ae_cleanplate_pick").handler(AeCleanplatePickSchema.parse({ comp_id: 1, region, every_n: 1, track: { track_id: "trk_cp_region" } }), ctx);
    expect(out.recommended_ref_time).toBe(0.4);
    expect(out.region_time).toBe(0);
    // The track moves the corner (96, 56) by (12, 4) between frame 0 and frame 4.
    const poly = out.region_at_recommended.polygon;
    expect(poly[0][0]).toBeCloseTo(108, 0);
    expect(poly[0][1]).toBeCloseTo(60, 0);
    expect(out.setup_args).toMatchObject({ comp_id: 1, ref_time: 0.4, region: out.region_at_recommended, track: { track_id: "trk_cp_region" } });
    expect(AeCleanplateSetupSchema.safeParse({ ...out.setup_args, plate: { index: 1 }, expect: expectArg }).success).toBe(true);
    expect(out.next).toMatch(/setup_args/);
    expect(out.next).toMatch(/`expect`/);
    // A plate given to pick is carried; one not given is left for the caller to add (build refuses without it).
    expect(out.setup_args.plate).toBeUndefined();
    const withPlate: any = await tool("ae_cleanplate_pick").handler(AeCleanplatePickSchema.parse({ comp_id: 1, region, every_n: 1, plate: { index: 1 }, track: { track_id: "trk_cp_region" } }), fakeAe({ frameFor: sharpAt4 }).ctx);
    expect(withPlate.setup_args.plate).toEqual({ index: 1 });
  }, 60000);

  it("does not spend renders on frames the track already cannot judge", async () => {
    const t = shiftTrack(10, "translate", 0);
    t.frames[6] = { ...t.frames[6], ok: false, H: null, note: "lost" };
    t.frames[7] = { ...t.frames[7], ok: false, H: null, note: "lost" };
    saveTrack({ ...t, track_id: "trk_cp_skip" });
    const { ctx, fns } = fakeAe({ frameFor: sharpAt4 });
    const out: any = await tool("ae_cleanplate_pick").handler(AeCleanplatePickSchema.parse({ comp_id: 1, region, every_n: 1, track: { track_id: "trk_cp_skip" } }), ctx);
    expect(out.frames_unusable.map((f: any) => f.time)).toEqual(expect.arrayContaining([0.6, 0.7]));
    // 8 usable frames plus the re-render of the best one; the old code rendered all 10.
    expect(fns().filter((f) => f === "snapshotFrame")).toHaveLength(9);
    expect(out.budget.renders_this_call).toBe(9);
  }, 60000);

  it("refuses a bad range or an unsolved region_time before an isolate makes its temporary copy", async () => {
    const isolated = (extra: Record<string, unknown>) => AeCleanplatePickSchema.parse({ comp_id: 1, region, plate: { index: 1 }, isolate: true, expect: expectArg, ...extra });
    const cases: Array<[Record<string, unknown>, string | null]> = [
      [{ start: 0.5, end: 0.2 }, null],
      // Only start is given: snapped past the work area's end, known after the read.
      [{ start: 0.95 }, null],
      [{ track: { track_id: "trk_cp_unsolved" } }, "no solved motion"],
    ];
    const t = shiftTrack(10, "translate", 0);
    t.frames[0] = { ...t.frames[0], ok: false, H: null, note: "lost" };
    saveTrack({ ...t, track_id: "trk_cp_unsolved" });
    for (const [extra, msg] of cases) {
      const { ctx, fns } = fakeAe();
      const out: any = await tool("ae_cleanplate_pick").handler(isolated(extra), ctx);
      expect(out, JSON.stringify(extra)).toMatchObject({ ok: false, error: "bad_args" });
      expect(out.message).toMatch(msg ?? /end is before start/);
      for (const bad of ["checkGuard", "planarIsolateBegin", "planarIsolateEnd", "snapshotFrame"]) expect(fns(), bad).not.toContain(bad);
    }
  }, 60000);

  it("proposes spatial clone sources on a periodic plate", async () => {
    const { ctx } = fakeAe({ frameFor: () => frame({ period: 36 }) });
    const out: any = await tool("ae_cleanplate_pick").handler(AeCleanplatePickSchema.parse({ comp_id: 1, region: { rect: [100, 60, 20, 20] }, ring_px: 10 }), ctx);
    expect(out.clone_sources.spatial.length).toBeGreaterThan(0);
    expect(Math.abs(out.clone_sources.spatial[0].dx) % 36).toBe(0);
    expect(out.clone_sources.spatial[0].nssd).toBeLessThan(0.05);
    expect(out.clone_sources.spatial[0].use).toMatch(/clone_offset/);
  }, 60000);

  it("follows a track: the region moves with it and track data gates the frames", async () => {
    const t = shiftTrack(10, "translate", 0);
    t.frames[6] = { ...t.frames[6], ok: false, H: null, note: "lost" };
    saveTrack({ ...t, track_id: "trk_cp_pick" });
    const { ctx } = fakeAe({ frameFor: sharpAt4 });
    const out: any = await tool("ae_cleanplate_pick").handler(AeCleanplatePickSchema.parse({ comp_id: 1, region, every_n: 1, track: { track_id: "trk_cp_pick" } }), ctx);
    expect(out.ok).toBe(true);
    expect(out.recommended_ref_time).toBe(0.4);
    expect(out.region_time).toBe(0);
    expect(out.frames_unusable.find((f: any) => f.time === 0.6)?.reason).toBe("lost");
    expect(out.frames[0].motion_px_per_frame).toBeGreaterThan(0);
    // The first sample is judged too: measured against the next one, not given a free 0.
    expect(out.frames.find((f: any) => f.time === 0).motion_px_per_frame).toBeGreaterThan(0);
    expect(out.frames[0].track_confidence).not.toBeUndefined();
    expect(out.notes[0]).toMatch(/trk_cp_fixture|trk_cp_pick/);
  }, 60000);

  it("isolate: guards, renders the plate-only copy, removes it and reports the receipt", async () => {
    const { ctx, calls, fns } = fakeAe({ frameFor: sharpAt4 });
    const out: any = await tool("ae_cleanplate_pick").handler(AeCleanplatePickSchema.parse({ comp_id: 1, region, plate: { index: 1 }, isolate: true, expect: expectArg }), ctx);
    expect(out.ok).toBe(true);
    const order = fns();
    expect(order.indexOf("checkGuard")).toBeLessThan(order.indexOf("planarIsolateBegin"));
    expect(order.indexOf("planarIsolateBegin")).toBeLessThan(order.indexOf("snapshotFrame"));
    expect(order.lastIndexOf("snapshotFrame")).toBeLessThan(order.indexOf("planarIsolateEnd"));
    expect(calls.filter((c) => c.fn === "snapshotFrame").every((c) => c.args.comp_id === COPY_ID)).toBe(true);
    expect(out.temp_comp).toEqual({ copy_removed: true });
    expect(out.receipt.matches).toBe(true);
    expect(out.recommended_ref_time).toBe(0.4);
  }, 60000);

  it("isolate: the copy's two undo entries are recorded as the agent's own writes", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-cp-sess-"));
    tmpDirs.push(dir);
    try {
      installSessionTracking({ dataDir: dir });
      const { ctx } = fakeAe({ frameFor: sharpAt4 });
      const out: any = await tool("ae_cleanplate_pick").handler(AeCleanplatePickSchema.parse({ comp_id: 1, region, plate: { index: 1 }, isolate: true, expect: expectArg }), ctx);
      expect(out.ok).toBe(true);
      expect(getSessionTracker()!.agentWritesSince(expectArg.project_path, null).some((w) => w.tool === "ae_cleanplate_pick")).toBe(true);
    } finally {
      resetSessionTracking();
    }
  }, 60000);

  it("reports a render failure after isolating without leaving the copy behind", async () => {
    const { ctx, fns } = fakeAe({ failSnapshotAfter: 0 });
    const out: any = await tool("ae_cleanplate_pick").handler(AeCleanplatePickSchema.parse({ comp_id: 1, region, plate: { index: 1 }, isolate: true, expect: expectArg }), ctx);
    // Renders fail inside the copy: the pick still returns, with nothing to rank, and the copy is removed.
    expect(fns()).toContain("planarIsolateEnd");
    expect(out.temp_comp).toEqual({ copy_removed: true });
    expect(out.recommended_ref_time).toBeNull();
    expect(out.notes.join(" ")).toMatch(/render failed/);
  }, 60000);

  it("refuses an empty region and odd pixels before rendering", async () => {
    const a = fakeAe();
    expect(await tool("ae_cleanplate_pick").handler(AeCleanplatePickSchema.parse({ comp_id: 1, region: { rect: [0, 0, 0, 5] } }), a.ctx)).toMatchObject({ ok: false, error: "bad_args" });
    const b = fakeAe({ comp: { pixel_aspect: 2 } });
    expect(await tool("ae_cleanplate_pick").handler(AeCleanplatePickSchema.parse({ comp_id: 1, region }), b.ctx)).toMatchObject({ ok: false, error: "refused" });
    expect(b.fns()).not.toContain("snapshotFrame");
  });
});

// ---------- the host under node:vm ----------

/** What the shared fake does not model yet: layer.duplicate, time remap, layer switches. */
function extendFake(): void {
  const proto = FakeLayer.prototype as any;
  if (proto.__cleanplate) return;
  proto.__cleanplate = true;
  proto.duplicate = function (this: FakeLayer) {
    const copy = new FakeLayer(this.comp, this.name, this.reflect.name);
    copy.source = this.source;
    copy.rect = { ...this.rect };
    copy.outPoint = this.outPoint;
    copy.startTime = this.startTime;
    const cloneProp = (p: any, q: any) => {
      q.staticValue = Array.isArray(p.staticValue) ? [...p.staticValue] : p.staticValue;
      q.keys = p.keys.map((k: any) => ({ ...k }));
      q.expression = p.expression;
      q.expressionEnabled = p.expressionEnabled;
    };
    for (const n of ["ADBE Anchor Point", "ADBE Position", "ADBE Scale", "ADBE Rotate Z", "ADBE Opacity"]) {
      const from = this.group.property("ADBE Transform Group") as any;
      const to = copy.group.property("ADBE Transform Group") as any;
      cloneProp(from.property(n), to.property(n));
    }
    const toFx = copy.group.property("ADBE Effect Parade") as any;
    for (const fx of (this.group.property("ADBE Effect Parade") as any).props) {
      const made = new FakeGroup(fx.name, fx.matchName, fx.props.map((p: any) => {
        const q = new FakeProperty(p.name, p.matchName, p.propertyValueType, p.staticValue);
        cloneProp(p, q);
        return q;
      }));
      made.parentProperty = toFx;
      toFx.props.push(made);
    }
    this.comp.stack.splice(this.comp.stack.indexOf(this), 0, copy);
    this.comp.stack.splice(this.comp.stack.lastIndexOf(copy), 1);
    this.comp.stack.splice(this.comp.stack.indexOf(this), 0, copy);
    return copy;
  };
  Object.defineProperty(proto, "canSetTimeRemapEnabled", { get: () => true, configurable: true });
  Object.defineProperty(proto, "timeRemapEnabled", {
    configurable: true,
    get(this: any) {
      return this.__trm === true;
    },
    set(this: any, on: boolean) {
      if (on && !this.__trm) {
        const p = new FakeProperty("Time Remap", "ADBE Time Remapping", PropertyValueType.OneD, 0);
        this.group.props.push(p);
        p.parentProperty = this.group;
        p.setValueAtTime(this.inPoint, this.inPoint - this.startTime);
        p.setValueAtTime(this.outPoint, this.outPoint - this.startTime);
      }
      this.__trm = on;
    },
  });
}

function scene() {
  extendFake();
  const project = new FakeProject();
  const comp = project.addComp("Main", W, H, 4);
  const bg = comp.layers.addSolid([0, 0, 0], "BG", W, H, 1, 4);
  const plate = comp.layers.addSolid([0.5, 0.5, 0.5], "Plate", W, H, 1, 4);
  const roto = comp.layers.addSolid([1, 1, 1], "Roto", W, H, 1, 4);
  roto.moveToEnd();
  roto.moveBefore(plate);
  return { project, comp, bg, plate, roto };
}

const region = (x = 100, y = 60, w = 40, h = 30) => ({
  shape: { vertices: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], inTangents: [[0, 0], [0, 0], [0, 0], [0, 0]], outTangents: [[0, 0], [0, 0], [0, 0], [0, 0]], closed: true },
  keys: null,
});

function buildArgs(s: ReturnType<typeof scene>, extra: Record<string, unknown> = {}) {
  return {
    comp_id: s.comp.id,
    plate_index: s.plate.index,
    plate_id: s.plate.id,
    source: "freeze",
    ref_time: 1,
    name: "Plate PATCH f10",
    regions: [region()],
    feather: 4,
    expansion: 2,
    writes: [] as unknown[],
    clone: null,
    holdout: null,
    hide_holdout: true,
    motion_blur: false,
    expect: GUARD,
    ...extra,
  };
}

const keyedWrite = () => {
  const times = [0, 0.5, 1, 1.5];
  return { target: "transform", replace_keys: false, times, values: { position: times.map((t) => [W / 2 + 10 * t, H / 2]), rotation: times.map(() => 0), scale: times.map(() => [100, 100]) } };
};

describe("cleanplate.jsx", () => {
  it("builds a freeze rig in one undo group: hold key, comp-size precomp, mask, track keys, plate untouched", () => {
    const s = scene();
    const { A, undo } = loadHost(s.project, ["planar.jsx", "cleanplate.jsx"]);
    const out = A.cleanplateBuild(buildArgs(s, { writes: [keyedWrite()], motion_blur: true }));
    expect(undo).toEqual({ begun: 1, ended: 1 });
    expect(out).toMatchObject({ source: "freeze", masks: 1, freeze_skipped: false });
    expect(s.comp.numLayers).toBe(4);
    const patch = s.comp.layer(out.patch_layer.index)!;
    expect(patch.name).toBe("Plate PATCH f10");
    expect(patch.index).toBe(2);
    // The plate keeps its look, one slot down; the roto above it is untouched.
    expect(s.plate.index).toBe(3);
    expect(s.plate.enabled).toBe(true);
    const inner = s.project.itemByID(out.patch_comp.id) as FakeComp;
    expect(inner.width).toBe(W);
    expect(inner.numLayers).toBe(1);
    const frozen = inner.layer(1) as any;
    expect(frozen.timeRemapEnabled).toBe(true);
    const trm = frozen.group.property("ADBE Time Remapping") as FakeProperty;
    expect(trm.numKeys).toBe(1);
    expect(trm.keyOutInterpolationType(1)).toBe(KeyframeInterpolationType.HOLD);
    expect(trm.keyTime(1)).toBe(1);
    // Mask: one Add mask with the feather and expansion asked for.
    const masks = patch.property("ADBE Mask Parade") as any;
    expect(masks.numProperties).toBe(1);
    const m = masks.property(1);
    expect(m.property("ADBE Mask Feather").value).toEqual([4, 4]);
    expect(m.property("ADBE Mask Offset").value).toBe(2);
    expect(m.property("ADBE Mask Shape").value.vertices).toEqual(region().shape.vertices);
    // Track keys landed on the patch layer, which was re-centred (the fake precomp starts at anchor 0).
    expect(patch.transform("Position").numKeys).toBe(4);
    expect(patch.transform("Position").keyValue(4)[0]).toBeCloseTo(W / 2 + 15, 6);
    expect(patch.motionBlur).toBe(true);
    expect(out.notes.join(" ")).toMatch(/reset/);
  });


  // A Corner Pin with keys at 0 and 2 s: [0, 0] to [10, 10], so [5, 5] at 1 s.
  function addKeyedCornerPin(layer: FakeLayer): FakeProperty {
    const fxs = layer.group.property("ADBE Effect Parade") as any;
    const ul = new FakeProperty("Upper Left", "ADBE Corner Pin-0001", PropertyValueType.TwoD, [0, 0]);
    ul.setValueAtTime(0, [0, 0]);
    ul.setValueAtTime(2, [10, 10]);
    const pin = new FakeGroup("Corner Pin", "ADBE Corner Pin", [ul]);
    pin.parentProperty = fxs;
    fxs.props.push(pin);
    return ul;
  }

  const SWITCH_EXPR = 'thisComp.layer("Steady").effect("Show Stabilized Plate")("Checkbox")*100';

  it("freeze: bakes keyed effect parameters and the rig's opacity switch on the plate copy, leaves the plate alone", () => {
    const s = scene();
    const ul = addKeyedCornerPin(s.plate);
    const opacity = s.plate.transform("Opacity") as FakeProperty;
    opacity.expression = SWITCH_EXPR;
    opacity.expressionEnabled = true;
    opacity.staticValue = 0;
    const { A, undo } = loadHost(s.project, ["planar.jsx", "cleanplate.jsx"]);
    const info = A.cleanplateRead({ comp_id: s.comp.id, plate: { index: s.plate.index }, ref_time: 1 });
    expect(info.plate.opacity_animated).toBe(true);
    expect(info.plate.effects_animated).toEqual(["Corner Pin"]);
    const out = A.cleanplateBuild(buildArgs(s));
    expect(undo).toEqual({ begun: 1, ended: 1 });
    const copy = (s.project.itemByID(out.patch_comp.id) as FakeComp).layer(1)!;
    const cul = ((copy.group.property("ADBE Effect Parade") as any).property("ADBE Corner Pin") as any).property("ADBE Corner Pin-0001") as FakeProperty;
    expect(cul.numKeys).toBe(0);
    expect(cul.value).toEqual([5, 5]);
    const cop = copy.transform("Opacity") as FakeProperty;
    expect(cop.expressionEnabled).toBe(false);
    expect(cop.numKeys).toBe(0);
    expect(cop.value).toBe(100);
    const text = out.notes.join(" ");
    expect(text).toMatch(/effect parameter/);
    expect(text).toMatch(/Show Stabilized Plate/);
    // The plate keeps its keys and its switch.
    expect(ul.numKeys).toBe(2);
    expect(opacity.expressionEnabled).toBe(true);
  });

  it("freeze: other animated opacity becomes its value at ref_time; clone: the switch is neutralised, effects and other opacity keys stay", () => {
    const s = scene();
    const op = s.plate.transform("Opacity") as FakeProperty;
    op.setValueAtTime(0, 0);
    op.setValueAtTime(2, 100);
    const h = loadHost(s.project, ["planar.jsx", "cleanplate.jsx"]);
    const out = h.A.cleanplateBuild(buildArgs(s));
    const copy = (s.project.itemByID(out.patch_comp.id) as FakeComp).layer(1)!;
    expect((copy.transform("Opacity") as FakeProperty).numKeys).toBe(0);
    expect((copy.transform("Opacity") as FakeProperty).value).toBe(50);

    const c = scene();
    const ul = addKeyedCornerPin(c.plate);
    const cop = c.plate.transform("Opacity") as FakeProperty;
    cop.setValueAtTime(0, 0);
    cop.setValueAtTime(2, 100);
    const hc = loadHost(c.project, ["planar.jsx", "cleanplate.jsx"]);
    const o2 = hc.A.cleanplateBuild(buildArgs(c, { source: "clone_offset", clone: { frames: 0, static_shift: [-60, 0], position: null } }));
    const clone = (c.project.itemByID(o2.patch_comp.id) as FakeComp).layer(1)!;
    expect((clone.transform("Opacity") as FakeProperty).numKeys).toBe(2);
    const cpin = ((clone.group.property("ADBE Effect Parade") as any).property("ADBE Corner Pin") as any).property("ADBE Corner Pin-0001") as FakeProperty;
    expect(cpin.numKeys).toBe(ul.numKeys);

    const d = scene();
    const dop = d.plate.transform("Opacity") as FakeProperty;
    dop.expression = SWITCH_EXPR;
    dop.expressionEnabled = true;
    dop.staticValue = 0;
    const hd = loadHost(d.project, ["planar.jsx", "cleanplate.jsx"]);
    const o3 = hd.A.cleanplateBuild(buildArgs(d, { source: "clone_offset", clone: { frames: 0, static_shift: [-60, 0], position: null } }));
    const clone3 = (d.project.itemByID(o3.patch_comp.id) as FakeComp).layer(1)!;
    expect((clone3.transform("Opacity") as FakeProperty).expressionEnabled).toBe(false);
    expect((clone3.transform("Opacity") as FakeProperty).value).toBe(100);
    expect(o3.notes.join(" ")).toMatch(/Show Stabilized Plate/);
  });

  it("resets a precomp layer whose matrix is the identity but whose anchor and position are not at the comp centre", () => {
    const s = scene();
    const layers = s.comp.layers as any;
    const real = layers.precompose;
    layers.precompose = (indexes: number[], name: string, moveAll: boolean) => {
      const inner = real(indexes, name, moveAll);
      for (let i = 1; i <= s.comp.numLayers; i++) {
        const l = s.comp.layer(i) as FakeLayer;
        if ((l as any).source === inner) (l.transform("Position") as FakeProperty).staticValue = [0, 0, 0];
      }
      return inner;
    };
    const { A } = loadHost(s.project, ["planar.jsx", "cleanplate.jsx"]);
    const out = A.cleanplateBuild(buildArgs(s));
    const patch = s.comp.layer(out.patch_layer.index)!;
    expect(patch.transform("Anchor Point").value.slice(0, 2)).toEqual([W / 2, H / 2]);
    expect(patch.transform("Position").value.slice(0, 2)).toEqual([W / 2, H / 2]);
    expect(out.notes.join(" ")).toMatch(/reset/);
  });

  it("refuses a holdout with no video before the undo group opens, and trims the patch layer to the keyed span", () => {
    const s = scene();
    (s.roto as any).hasVideo = false;
    const h = loadHost(s.project, ["planar.jsx", "cleanplate.jsx"]);
    expect(() => h.A.cleanplateBuild(buildArgs(s, { holdout: { id: s.roto.id } }))).toThrow(/has no video/);
    expect(h.undo.begun).toBe(0);
    expect(s.comp.numLayers).toBe(3);

    const t = scene();
    const ht = loadHost(t.project, ["planar.jsx", "cleanplate.jsx"]);
    expect(() => ht.A.cleanplateBuild(buildArgs(t, { trim: { start: 0.6, end: 0.2 } }))).toThrow(/end after start/);
    expect(ht.undo.begun).toBe(0);
    const out = ht.A.cleanplateBuild(buildArgs(t, { trim: { start: 0.2, end: 0.6 } }));
    const patch = t.comp.layer(out.patch_layer.index)!;
    expect(patch.inPoint).toBeCloseTo(0.2, 6);
    expect(patch.outPoint).toBeCloseTo(0.6, 6);
    expect(out.trimmed).toEqual({ in_point: patch.inPoint, out_point: patch.outPoint });
  });

  it("bakes the plate's animated transform at ref_time and leaves the plate's own keys alone", () => {
    const s = scene();
    const pos = s.plate.transform("Position");
    pos.setValueAtTime(0, [100, 80, 0]);
    pos.setValueAtTime(2, [140, 80, 0]);
    const { A } = loadHost(s.project, ["planar.jsx", "cleanplate.jsx"]);
    const info = A.cleanplateRead({ comp_id: s.comp.id, plate: { index: s.plate.index }, ref_time: 1 });
    expect(info.plate.transform_animated).toEqual(["position"]);
    expect(info.plate.position).toEqual([120, 80]);
    const out = A.cleanplateBuild(buildArgs(s));
    const inner = s.project.itemByID(out.patch_comp.id) as FakeComp;
    const copy = inner.layer(1)!;
    expect(copy.transform("Position").numKeys).toBe(0);
    expect(copy.transform("Position").value).toEqual([120, 80, 0]);
    expect(pos.numKeys).toBe(2);
  });

  it("clone_offset: shifts a static clone, or keys the position and the mask path with a track", () => {
    const s = scene();
    const { A } = loadHost(s.project, ["planar.jsx", "cleanplate.jsx"]);
    const out = A.cleanplateBuild(buildArgs(s, { source: "clone_offset", clone: { frames: 3, static_shift: [-60, 0], position: null } }));
    const copy = (s.project.itemByID(out.patch_comp.id) as FakeComp).layer(1)!;
    expect(copy.transform("Position").value[0]).toBe(W / 2 - 60);
    expect(copy.startTime).toBeCloseTo(-3 / 25, 6);
    expect((copy as any).timeRemapEnabled).toBeFalsy();

    const s2 = scene();
    const h2 = loadHost(s2.project, ["planar.jsx", "cleanplate.jsx"]);
    const times = [0, 0.5, 1];
    const shapes = times.map((t) => ({ ...region(100 + 5 * t).shape }));
    const out2 = h2.A.cleanplateBuild(
      buildArgs(s2, {
        source: "clone_offset",
        clone: { frames: 0, static_shift: null, position: { times, shifts: times.map((t) => [-60 + 5 * t, 0]) } },
        regions: [{ shape: region().shape, keys: { times, shapes } }],
      })
    );
    const clone2 = (s2.project.itemByID(out2.patch_comp.id) as FakeComp).layer(1)!;
    expect(clone2.transform("Position").numKeys).toBe(3);
    expect(clone2.transform("Position").keyValue(1)[0]).toBe(W / 2 - 60);
    const mp = (s2.comp.layer(out2.patch_layer.index)!.property("ADBE Mask Parade") as any).property(1).property("ADBE Mask Shape");
    expect(mp.numKeys).toBe(3);
    expect(mp.keyValue(3).vertices[0][0]).toBe(105);
    expect(s2.comp.layer(out2.patch_layer.index)!.transform("Position").numKeys).toBe(0);
  });

  it("still: imports the PNG above the plate and wraps it in the patch comp; holdout becomes an inverted alpha matte", () => {
    const s = scene();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-cp-still-"));
    tmpDirs.push(dir);
    const file = path.join(dir, `${W}x${H}_25fps_1f.png`);
    fs.writeFileSync(file, "png");
    const { A } = loadHost(s.project, ["planar.jsx", "cleanplate.jsx"]);
    const before = s.project.numItems;
    const out = A.cleanplateBuild(buildArgs(s, { source: "still", still_path: file, holdout: { id: s.roto.id } }));
    expect(out.imported_item.name.endsWith(`${W}x${H}_25fps_1f.png`)).toBe(true);
    expect(s.project.numItems).toBe(before + 2);
    const inner = s.project.itemByID(out.patch_comp.id) as FakeComp;
    expect((inner.layer(1) as any).source.name).toContain("25fps");
    const patch = s.comp.layer(out.patch_layer.index)!;
    expect(patch.trackMatteType).toBe(TrackMatteType.ALPHA_INVERTED);
    expect(patch.trackMatteLayer).toBe(s.roto);
    expect(s.roto.enabled).toBe(false);
    expect(out.holdout).toEqual({ id: s.roto.id, name: "Roto", hidden: true });
    const back = A.cleanplateInspect({ comp_id: s.comp.id, plate_id: s.plate.id, patch_layer_id: out.patch_layer.id, patch_comp_id: out.patch_comp.id, holdout_id: s.roto.id });
    expect(back.patch).toMatchObject({ found: true, source_id: out.patch_comp.id, matte: { type: "alpha_inverted", layer_id: s.roto.id } });
    expect(back.patch.masks).toEqual([{ mode: "add", feather: [4, 4], expansion: 2, num_keys_path: 0 }]);
    expect(back.holdout).toEqual({ id: s.roto.id, enabled: false });
    expect(back.num_layers).toBe(4);
    // The read-back carries the patch layer's in/out so a trim can be confirmed.
    expect(back.patch.in_point).toBe(patch.inPoint);
    expect(back.patch.out_point).toBe(patch.outPoint);
  });

  it("refuses bad input before the undo group opens", () => {
    const cases: Array<[Record<string, unknown>, RegExp, (s: ReturnType<typeof scene>) => void]> = [
      [{}, /locked/, (s) => (s.plate.locked = true)],
      [{}, /3D/, (s) => (s.plate.threeDLayer = true)],
      [{}, /parent/, (s) => (s.plate.parent = s.bg)],
      [{ expansion: 1, feather: 4 }, /half the feather/, () => undefined],
      [{ feather: 900 }, /feather must be/, () => undefined],
      [{ regions: [] }, /1 to 16/, () => undefined],
      [{ source: "still" }, /still_path or still_footage_id/, () => undefined],
      [{ source: "still", still_footage_id: 99999 }, /No footage item/, () => undefined],
      [{ source: "clone_offset" }, /clone description/, () => undefined],
      [{ holdout: { id: 12345 } }, /No holdout layer/, () => undefined],
      [{ writes: [{ target: "transform", times: [1, 0.5], values: {} }] }, /ascend/, () => undefined],
      [{ regions: [{ shape: { vertices: [[0, 0]], inTangents: [[0, 0]], outTangents: [[0, 0]] }, keys: null }] }, /3 to 200 vertices/, () => undefined],
    ];
    for (const [extra, msg, setup] of cases) {
      const s = scene();
      setup(s);
      const { A, undo } = loadHost(s.project, ["planar.jsx", "cleanplate.jsx"]);
      const items = s.project.numItems;
      expect(() => A.cleanplateBuild(buildArgs(s, extra)), msg.source).toThrow(msg);
      expect(undo.begun).toBe(0);
      expect(s.comp.numLayers).toBe(3);
      expect(s.project.numItems).toBe(items);
    }
    const s = scene();
    const { A } = loadHost(s.project, ["planar.jsx", "cleanplate.jsx"]);
    try {
      A.cleanplateBuild({ ...buildArgs(s), expect: { project_path: "/elsewhere.aep" } });
    } catch (e: any) {
      expect(e.__kind).toBe("guard");
    }
  });

  it("refuses a locked holdout and separated Position before the undo group opens", () => {
    const s = scene();
    s.roto.locked = true;
    const h = loadHost(s.project, ["planar.jsx", "cleanplate.jsx"]);
    expect(() => h.A.cleanplateBuild(buildArgs(s, { holdout: { id: s.roto.id } }))).toThrow(/holdout layer .* is locked/);
    expect(h.undo.begun).toBe(0);
    expect(s.roto.enabled).toBe(true);
    expect(s.comp.numLayers).toBe(3);

    const s2 = scene();
    (s2.plate.transform("Position") as any).dimensionsSeparated = true;
    const h2 = loadHost(s2.project, ["planar.jsx", "cleanplate.jsx"]);
    expect(h2.A.cleanplateRead({ comp_id: s2.comp.id, plate: { index: s2.plate.index } }).plate.position_separated).toBe(true);
    expect(() => h2.A.cleanplateBuild(buildArgs(s2))).toThrow(/separated/);
    expect(() => h2.A.cleanplateBuild(buildArgs(s2, { source: "clone_offset", clone: { frames: 0, static_shift: [-60, 0], position: null } }))).toThrow(/separated/);
    expect(h2.undo.begun).toBe(0);
  });

  it("reports animation on separated X/Y Position as animated position", () => {
    const s = scene();
    const pos = s.plate.transform("Position") as any;
    pos.dimensionsSeparated = true;
    const px = new FakeProperty("X Position", "ADBE Position_0", PropertyValueType.OneD, 0);
    px.setValueAtTime(0, 10);
    px.setValueAtTime(1, 20);
    const tg = s.plate.property("ADBE Transform Group") as any;
    tg.props.push(px);
    px.parentProperty = tg;
    const { A } = loadHost(s.project, ["planar.jsx", "cleanplate.jsx"]);
    expect(A.cleanplateRead({ comp_id: s.comp.id, plate: { index: s.plate.index } }).plate.transform_animated).toContain("position");
  });

  it("takes back what it made, in the same undo group, when a step fails", () => {
    const s = scene();
    const { A, undo } = loadHost(s.project, ["planar.jsx", "cleanplate.jsx"]);
    const items = s.project.numItems;
    A.planarWriteRaw = () => {
      throw new Error("boom");
    };
    expect(() => A.cleanplateBuild(buildArgs(s, { writes: [keyedWrite()] }))).toThrow(/boom/);
    expect(undo).toEqual({ begun: 1, ended: 1 });
    expect(s.comp.numLayers).toBe(3);
    expect(s.plate.index).toBe(2);
    expect(s.project.numItems).toBe(items);
    expect(s.comp.layers.add).toBeDefined();
  });

  it("reload: reloads file footage without an undo group, refuses the rest", () => {
    const s = scene();
    const { A, undo } = loadHost(s.project, ["planar.jsx", "cleanplate.jsx"]);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "chroma-cp-rl-")), `${W}x${H}_25fps_1f.png`);
    tmpDirs.push(path.dirname(file));
    fs.writeFileSync(file, "png");
    const item = s.project.importFile({ file: new FakeFile(file), sequence: false } as any) as any;
    item.file = new FakeFile(file);
    let reloaded = 0;
    item.mainSource.reload = () => reloaded++;
    const out = A.cleanplateReload({ footage_id: item.id, expect: GUARD });
    expect(out).toMatchObject({ no_op: true, reloaded: true, footage: { id: item.id } });
    expect(reloaded).toBe(1);
    expect(undo.begun).toBe(0);
    fs.rmSync(file);
    expect(() => A.cleanplateReload({ footage_id: item.id, expect: GUARD })).toThrow(/missing/);
    expect(() => A.cleanplateReload({ footage_id: s.plate.id, expect: GUARD })).toThrow(/No file footage|not file footage/);
    expect(() => A.cleanplateReload({ expect: GUARD })).toThrow(/footage_id or patch_comp_id/);
  });

  it("reload by patch comp: only a still counts, a freeze patch is refused", () => {
    const s = scene();
    const { A, undo } = loadHost(s.project, ["planar.jsx", "cleanplate.jsx"]);
    const built = A.cleanplateBuild(buildArgs(s));
    expect(() => A.cleanplateReload({ patch_comp_id: built.patch_comp.id, expect: GUARD })).toThrow(/no still/);
    expect(undo.begun).toBe(1);
  });

  it("read: describes the comp, project and layers without changing them", () => {
    const s = scene();
    s.comp.time = 1.5;
    const { A, undo } = loadHost(s.project, ["planar.jsx", "cleanplate.jsx"]);
    const out = A.cleanplateRead({ comp_id: s.comp.id, plate: { name: "Plate" }, holdout: { name: "Roto" } });
    expect(out.comp).toMatchObject({ id: s.comp.id, width: W, height: H, fps: 25, motion_blur: false });
    expect(out.project.path).toBe("<unsaved>");
    expect(out.plate).toMatchObject({ id: s.plate.id, kind: "solid", locked: false, parent_id: null, modern_matte_api: true });
    expect(out.holdout.name).toBe("Roto");
    expect(out.num_layers).toBe(3);
    expect(s.comp.time).toBe(1.5);
    expect(undo.begun).toBe(0);
    expect(() => A.cleanplateRead({ comp_id: s.comp.id, plate: { name: "Nope" } })).toThrow(/No layer named/);
  });
});
