/**
 * ae_inpaint_plate: the schema, the pure fills on synthetic images, the whole
 * job on synthetic frames, the two-phase flow against a fake bridge (frames are
 * PNGs the fake AE writes), and inpaint.jsx under node:vm against the fake AE DOM.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import {
  CLS,
  fillFromFrames,
  fillFromGathered,
  gatherSamples,
  laplaceFill,
  matchColor,
  medianStack,
  patchMatchFill,
  planeFromRgba,
  prepareHole,
  spreadPick,
  warpCrop,
  type Plane,
  type Pt,
} from "../src/tools/ext/inpaint-math.js";
import { getSessionTracker, installSessionTracking, resetSessionTracking } from "../src/tools/ext/session.js";
import {
  AeInpaintPlateSchema,
  confidenceImage,
  inpaintMismatches,
  inpaintTools,
  planPlacement,
  planSamples,
  regionPolygon,
  safeName,
  uniquePath,
} from "../src/tools/ext/inpaint.js";
import type { RgbaImage } from "../src/tools/ext/png-utils.js";
import { FakeProject, GUARD, loadHost } from "./support/fake-ae.js";

const tmpDirs: string[] = [];
const origLocalAppData = process.env.LOCALAPPDATA;

beforeEach(() => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-inpaint-"));
  tmpDirs.push(d);
  process.env.LOCALAPPDATA = d;
});

afterEach(() => {
  if (origLocalAppData === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = origLocalAppData;
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const tool = inpaintTools[0];
const expectArg = { project_path: "C:/proj/shot.aep" };

// ---------- synthetic images ----------

const IDENT = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** Deterministic noise per integer position: a texture with no repeat, so a wrong lookup is always visible. */
function noise(x: number, y: number, c: number): number {
  let h = Math.imul(x + 1013, 374761393) ^ Math.imul(y + 2029, 668265263) ^ Math.imul(c + 7, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return 40 + ((h >>> 0) % 176);
}

function makeImage(w: number, h: number, f: (x: number, y: number) => [number, number, number]): RgbaImage {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = f(x, y);
      data.set([r, g, b, 255], (y * w + x) * 4);
    }
  }
  return { width: w, height: h, data };
}

const world = (x: number, y: number): [number, number, number] => [noise(x, y, 0), noise(x, y, 1), noise(x, y, 2)];
const RED: [number, number, number] = [220, 10, 10];
const W = 96;
const H = 64;
const SQUARE: Pt[] = [
  [40, 24],
  [56, 24],
  [56, 40],
  [40, 40],
];
const inSquare = (x: number, y: number, grow = 0) => x >= 40 - grow && x < 56 + grow && y >= 24 - grow && y < 40 + grow;

/** The world with a red square (the object) at object-x offset `ox` (0 = in the hole). */
const frameWithObject = (ox: number) => makeImage(W, H, (x, y) => (x >= 40 + ox && x < 56 + ox && y >= 24 && y < 40 ? RED : world(x, y)));

const maxErr = (a: RgbaImage, b: RgbaImage, test: (x: number, y: number) => boolean) => {
  let worst = 0;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      if (!test(x, y)) continue;
      for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(a.data[(y * a.width + x) * 4 + c] - b.data[(y * a.width + x) * 4 + c]));
    }
  }
  return worst;
};

const baseInput = (over: Partial<Parameters<typeof fillFromFrames>[0]> = {}): Parameters<typeof fillFromFrames>[0] => ({
  ref: frameWithObject(0),
  comp: { width: W, height: H },
  polygons: [SQUARE],
  growPx: 2,
  method: "auto",
  spatial: "diffuse",
  objectMoves: true,
  samples: [],
  getFrame: async () => null,
  minSamples: 3,
  maxSpread: 12,
  objectTol: 10,
  ringPx: 12,
  ringGapPx: 2,
  matchColor: true,
  ...over,
});

// ---------- schema ----------

describe("AeInpaintPlateSchema", () => {
  const ok = { comp_id: 1, plate_layer: { index: 1 }, regions: [{ rect: [10, 10, 20, 20] }], expect: expectArg };

  it("takes the minimal call and fills the defaults", () => {
    const v = AeInpaintPlateSchema.parse(ok);
    expect(v).toMatchObject({ grow_px: 4, method: "auto", spatial: "diffuse", object_moves: false, max_frames: 60, isolate_plate: true, match_color: true, preview: true });
  });

  it("needs expect, a plate layer and 1 to 16 regions", () => {
    expect(AeInpaintPlateSchema.safeParse({ ...ok, expect: undefined }).success).toBe(false);
    expect(AeInpaintPlateSchema.safeParse({ ...ok, plate_layer: {} }).success).toBe(false);
    expect(AeInpaintPlateSchema.safeParse({ ...ok, regions: [] }).success).toBe(false);
    expect(AeInpaintPlateSchema.safeParse({ ...ok, regions: Array.from({ length: 17 }, () => ({ rect: [0, 0, 5, 5] })) }).success).toBe(false);
    expect(AeInpaintPlateSchema.safeParse({ ...ok, regions: Array.from({ length: 16 }, () => ({ rect: [0, 0, 5, 5] })) }).success).toBe(true);
  });

  it("bounds the budget and the options", () => {
    expect(AeInpaintPlateSchema.safeParse({ ...ok, max_frames: 121 }).success).toBe(false);
    expect(AeInpaintPlateSchema.safeParse({ ...ok, max_frames: 1 }).success).toBe(false);
    expect(AeInpaintPlateSchema.safeParse({ ...ok, grow_px: 201 }).success).toBe(false);
    expect(AeInpaintPlateSchema.safeParse({ ...ok, method: "magic" }).success).toBe(false);
    expect(AeInpaintPlateSchema.safeParse({ ...ok, spatial: "ml" }).success).toBe(false);
    expect(AeInpaintPlateSchema.safeParse({ ...ok, place_in_comp: { comp_id: 2, offset_px: [1] } }).success).toBe(false);
    expect(AeInpaintPlateSchema.safeParse({ ...ok, place_in_comp: { comp_id: 2, mode: "masked", offset_px: [10, 20] } }).success).toBe(true);
  });

  it("takes a track source", () => {
    expect(AeInpaintPlateSchema.safeParse({ ...ok, track: { track_id: "trk_x" } }).success).toBe(true);
    expect(AeInpaintPlateSchema.safeParse({ ...ok, track: {} }).success).toBe(false);
  });

  it("describes the tool and ends with the safety guidance", () => {
    expect(inpaintTools.map((t) => t.name)).toEqual(["ae_inpaint_plate"]);
    expect(tool.description).toMatch(/IMPORTANT: \(1\)/);
    expect(tool.description).toMatch(/Content-Aware Fill/);
  });

  it("tells the agent how to raise object_tolerance for grain, and how the object test judges a pixel", () => {
    const d = (AeInpaintPlateSchema.shape.object_tolerance as any).description as string;
    expect(d).toMatch(/3 times the grain/);
    expect(d).toMatch(/median absolute deviation/);
    expect(tool.description).toMatch(/3 times the grain/);
    // The warning goes both ways: grain can leak the object's colour, and the preview is the check.
    expect(tool.description).toMatch(/static object can also leak/);
    expect(tool.description).toMatch(/before\/after preview/);
    expect(tool.description).toMatch(/under about 20 samples/);
    // The limit follows the tolerance.
    expect(d).toMatch(/1\.5 times this value/);
    expect(d).not.toMatch(/within about 15 gray levels/);
  });
});

// ---------- small helpers ----------

describe("helpers", () => {
  it("regionPolygon turns the three shapes into polygons and refuses empty ones", () => {
    expect(regionPolygon({ rect: [10, 20, 30, 40] })).toEqual([
      [10, 20],
      [40, 20],
      [40, 60],
      [10, 60],
    ]);
    expect(regionPolygon({ ellipse: [50, 50, 10, 5] }).length).toBeGreaterThanOrEqual(8);
    expect(regionPolygon({ polygon: [[0, 0], [5, 0], [5, 5]] })).toHaveLength(3);
    expect(() => regionPolygon({ rect: [0, 0, 0, 5] })).toThrow(/width and height above 0/);
    expect(() => regionPolygon({ ellipse: [0, 0, 3, -1] })).toThrow(/radii/);
    expect(() => regionPolygon({ polygon: [[0, 0], [NaN, 1], [2, 2]] })).toThrow(/not finite/);
  });

  it("safeName keeps file names safe and short", () => {
    expect(safeName("Plate A / v2: final?")).toBe("Plate_A_v2_final");
    expect(safeName("???")).toBe("plate");
    expect(safeName("x".repeat(200))).toHaveLength(60);
  });

  it("uniquePath never returns an existing file", () => {
    const dir = tmpDirs[0];
    expect(path.basename(uniquePath(dir, "a_inpaint", ".png"))).toBe("a_inpaint.png");
    fs.writeFileSync(path.join(dir, "a_inpaint.png"), "x");
    expect(path.basename(uniquePath(dir, "a_inpaint", ".png"))).toBe("a_inpaint_2.png");
    fs.writeFileSync(path.join(dir, "a_inpaint_2.png"), "x");
    expect(path.basename(uniquePath(dir, "a_inpaint", ".png"))).toBe("a_inpaint_3.png");
  });

  it("spreadPick spreads evenly, first and last included", () => {
    expect(spreadPick([1, 2, 3], 5)).toEqual([1, 2, 3]);
    expect(spreadPick([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 4)).toEqual([0, 3, 6, 9]);
    expect(spreadPick([1, 2, 3, 4, 5], 1)).toEqual([3]);
  });

  it("planSamples leaves out the reference frame and honours the range and the track", () => {
    const no = planSamples({ fps: 10, duration: 2, refTime: 0.5, start: 0, end: 2, max: 100 });
    expect(no).toHaveLength(19);
    expect(no.some((s) => Math.abs(s.time - 0.5) < 1e-9)).toBe(false);
    expect(no[0].H).toEqual(IDENT);
    expect(Math.max(...no.map((s) => s.time))).toBeCloseTo(1.9, 6);
    expect(planSamples({ fps: 10, duration: 2, refTime: 0, start: 0, end: 2, max: 5 })).toHaveLength(5);
    const track = {
      version: 1 as const,
      track_id: "t",
      comp_id: 1,
      comp_size: [W, H] as [number, number],
      fps: 10,
      ref_time: 0.5,
      model: "translate" as const,
      ref_points: [[1, 1]] as [number, number][],
      source: "test",
      created: "now",
      frames: [0, 0.1, 0.2, 0.5, 0.8].map((t, i) => ({ time: t, ok: i !== 2, H: i !== 2 ? [1, 0, t, 0, 1, 0, 0, 0, 1] : null, points: [], confidence: [], rms_px: 0, inliers: 1 })),
    };
    const picked = planSamples({ fps: 10, duration: 2, refTime: 0.5, start: 0, end: 2, max: 10, track });
    expect(picked.map((s) => s.time)).toEqual([0, 0.1, 0.8]);
    expect(picked[2].H[2]).toBeCloseTo(0.8, 9);
  });

  it("planPlacement guesses masked or unmasked from the comp's name, and mode overrides", () => {
    const polys: Pt[][] = [SQUARE];
    const auto = AeInpaintPlateSchema.parse({ comp_id: 1, plate_layer: { index: 1 }, regions: [{ rect: [0, 0, 1, 1] }], place_in_comp: { comp_id: 9 }, expect: expectArg }).place_in_comp!;
    expect(planPlacement(auto, { name: "PATCH Shot_01" }, polys, 4, 1).placement.mode).toBe("unmasked");
    expect(planPlacement(auto, { name: "_patch" }, polys, 4, 1).placement.mode).toBe("unmasked");
    // The name ae_cleanplate_setup really gives its precomp.
    expect(planPlacement(auto, { name: "Plate A PATCH f12" }, polys, 4, 1).placement.mode).toBe("unmasked");
    expect(planPlacement(auto, { name: "Plate A PATCH f12" }, polys, 4, 1).why).toMatch(/has PATCH in its name/);
    expect(planPlacement(auto, { name: "Dispatch" }, polys, 4, 1).placement.mode).toBe("masked");
    const masked = planPlacement(auto, { name: "STAB work" }, polys, 4, 2);
    expect(masked.placement.mode).toBe("masked");
    expect(masked.placement.regions[0][0]).toEqual([80, 48]);
    expect(masked.placement.expansion_px).toBe(4 * 2 + 12 / 2);
    expect(masked.why).toMatch(/has no PATCH in its name/);
    const forced = planPlacement({ ...auto, mode: "masked" }, { name: "PATCH x" }, polys, 0, 1);
    expect(forced.placement.mode).toBe("masked");
    expect(planPlacement({ ...auto, mode: "unmasked" }, { name: "Work" }, polys, 0, 1).placement.regions).toEqual([]);
  });

  it("confidenceImage colours the hole classes and dims the rest", () => {
    const refCrop = makeImage(3, 1, () => [200, 200, 200]);
    const img = confidenceImage({ refCrop, classes: Uint8Array.from([CLS.OUTSIDE, CLS.TEMPORAL, CLS.SPATIAL]) });
    expect(img.data[0]).toBeLessThan(120);
    expect([img.data[4], img.data[5], img.data[6]]).toEqual([60, 200, 90]);
    expect([img.data[8], img.data[9], img.data[10]]).toEqual([240, 210, 60]);
  });
});

// ---------- the pixel maths ----------

describe("warpCrop", () => {
  it("reproduces a source exactly through an integer translation and marks what falls outside", () => {
    const src = makeImage(40, 30, world);
    const out = warpCrop(src, [1, 0, 5, 0, 1, -3, 0, 0, 1], [10, 10, 20, 20]);
    expect(out.width).toBe(10);
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 10; x++) {
        const o = (y * 10 + x) * 4;
        expect(out.data[o + 3]).toBe(255);
        expect([out.data[o], out.data[o + 1], out.data[o + 2]]).toEqual(world(10 + x + 5, 10 + y - 3));
      }
    }
    const off = warpCrop(src, [1, 0, 100, 0, 1, 0, 0, 0, 1], [0, 0, 5, 5]);
    expect(off.data[3]).toBe(0);
    const behind = warpCrop(src, [1, 0, 0, 0, 1, 0, 0, 0, -1], [0, 0, 5, 5]);
    expect(behind.data[3]).toBe(0);
  });

  it("interpolates half a pixel and honours the image scale", () => {
    const src = makeImage(10, 4, (x) => [x * 10, 0, 0]);
    const half = warpCrop(src, [1, 0, 0.5, 0, 1, 0, 0, 0, 1], [2, 1, 3, 2]);
    expect(half.data[0]).toBe(25);
    // A 10-px-wide image of a 5-px comp: scale 2, comp point (1.5, 1) is image pixel (3, 2) edge: identity H gives the same pixel.
    const scaled = warpCrop(src, IDENT, [3, 1, 4, 2], 2);
    expect(scaled.data[0]).toBe(30);
  });

  it("treats transparent source pixels as invalid", () => {
    const src = makeImage(8, 8, world);
    for (let i = 0; i < 64; i++) if (i % 8 >= 4) src.data[i * 4 + 3] = 0;
    const out = warpCrop(src, IDENT, [0, 0, 8, 1]);
    expect([0, 1, 2, 3].every((x) => out.data[x * 4 + 3] === 255)).toBe(true);
    expect(out.data[6 * 4 + 3]).toBe(0);
  });
});

describe("prepareHole", () => {
  it("grows the union by the grow, rings it, and reports the share", () => {
    const h0 = prepareHole(W, H, { width: W, height: H }, [SQUARE], 0, 2, 8);
    expect(h0.holePixels).toBe(256);
    const h3 = prepareHole(W, H, { width: W, height: H }, [SQUARE], 3, 2, 8);
    // Euclidean growth: the four corner pixels of the 22 x 22 square are more than 3 px from the original.
    expect(h3.holePixels).toBe(22 * 22 - 4);
    expect(h3.share).toBeCloseTo((22 * 22 - 4) / (W * H), 6);
    const { x0, y0, w } = h3.crop;
    const at = (a: Uint8Array, x: number, y: number) => a[(y - y0) * w + (x - x0)];
    expect(at(h3.hole, 37, 24)).toBe(1);
    expect(at(h3.hole, 36, 24)).toBe(0);
    // The ring starts 2 px beyond the grown edge and is 8 px wide.
    expect(at(h3.ring, 36, 30)).toBe(0);
    expect(at(h3.ring, 34, 30)).toBe(1);
    expect(at(h3.ring, 26, 30)).toBe(0);
    expect(at(h3.ring, 45, 30)).toBe(0);
  });

  it("refuses a hole outside the frame", () => {
    expect(() => prepareHole(W, H, { width: W, height: H }, [[[500, 500], [510, 500], [510, 510]]], 0, 2, 8)).toThrow(/outside the frame/);
  });
});

describe("matchColor", () => {
  it("recovers a gain and offset on the ring and leaves invalid pixels alone", () => {
    const ref = makeImage(30, 30, world);
    const sample = makeImage(30, 30, (x, y) => world(x, y).map((v) => Math.round(v * 0.9 + 12)) as [number, number, number]);
    const ring = new Uint8Array(900).fill(1);
    sample.data[3] = 0;
    sample.data[0] = 5;
    const m = matchColor(sample, ref, ring);
    expect(m.applied).toBe(true);
    expect(m.gain[0]).toBeGreaterThan(1.05);
    const diff = Math.abs(sample.data[(10 * 30 + 10) * 4] - ref.data[(10 * 30 + 10) * 4]);
    expect(diff).toBeLessThanOrEqual(3);
    expect(sample.data[0]).toBe(5);
  });

  it("does not apply a fit from too few pixels", () => {
    const ref = makeImage(10, 10, world);
    const sample = makeImage(10, 10, world);
    const m = matchColor(sample, ref, new Uint8Array(100));
    expect(m.applied).toBe(false);
    expect(m.reason).toMatch(/fewer than 50/);
  });
});

describe("medianStack", () => {
  const stackOpts = { minSamples: 3, maxSpread: 12, objectTol: 10, objectMoves: true };
  const hole = new Uint8Array(16).fill(1);
  const ref = makeImage(4, 4, () => RED);

  it("takes the per-channel median and counts the votes", async () => {
    const vals = [10, 20, 30, 200, 25];
    const samples = vals.map((v) => makeImage(4, 4, () => [v, v, v]));
    const res = await medianStack(samples, hole, ref, stackOpts);
    expect(res.filled[5]).toBe(1);
    expect(res.count[5]).toBe(5);
    expect([res.rgb[15], res.rgb[16], res.rgb[17]]).toEqual([25, 25, 25]);
    expect(res.spread[5]).toBeGreaterThan(0);
  });

  it("leaves a pixel with too few votes unfilled and flags a disagreeing one", async () => {
    const two = [makeImage(4, 4, () => [10, 10, 10]), makeImage(4, 4, () => [12, 12, 12])];
    expect((await medianStack(two, hole, ref, stackOpts)).filled[0]).toBe(0);
    const split = [0, 255, 0, 255, 0].map((v) => makeImage(4, 4, () => [v, v, v]));
    const res = await medianStack(split, hole, ref, stackOpts);
    expect(res.lowConfidence[0]).toBe(1);
  });

  it("with the object on the plane, samples that still show the reference do not vote", async () => {
    const samples = [RED, RED, RED, [0, 100, 0], [0, 110, 0], [0, 120, 0]].map((c) => makeImage(4, 4, () => c as [number, number, number]));
    const moving = await medianStack(samples, hole, ref, stackOpts);
    expect(moving.count[0]).toBe(6);
    const onPlane = await medianStack(samples, hole, ref, { ...stackOpts, objectMoves: false });
    expect(onPlane.count[0]).toBe(3);
    expect(onPlane.rgb[1]).toBe(110);
    const allObject = await medianStack(samples.slice(0, 3), hole, ref, { ...stackOpts, objectMoves: false });
    expect(allObject.filled[0]).toBe(0);
    expect(allObject.unrevealed).toBe(16);
  });

  it("with the object on the plane, grain does not throw the revealed background away (robust spread)", async () => {
    // A seeded gaussian grain; object and background 110 gray levels apart; the reference carries grain too.
    const gauss = (() => {
      let a = 0x9e3779b9;
      const u = () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      return () => Math.sqrt(-2 * Math.log(1 - u())) * Math.cos(2 * Math.PI * u());
    })();
    const OBJ = 200;
    const BG = 90;
    const grainy = (level: number, sigma: number) => makeImage(40, 40, () => [0, 1, 2].map(() => Math.max(0, Math.min(255, Math.round(level + sigma * gauss())))) as [number, number, number]);
    const hole1600 = new Uint8Array(1600).fill(1);
    const run = async (sigma: number, objectShare: number, tol: number) => {
      const withObject = Math.round(60 * objectShare);
      const samples = Array.from({ length: 60 }, (_, i) => grainy(i < withObject ? OBJ : BG, sigma));
      const res = await medianStack(samples, hole1600, grainy(OBJ, sigma), { minSamples: 3, maxSpread: 12, objectTol: tol, objectMoves: false });
      let good = 0;
      let objectColour = 0;
      for (let p = 0; p < 1600; p++) {
        if (!res.filled[p]) continue;
        if (Math.abs(res.rgb[p * 3] - BG) < 25) good++;
        else if (Math.abs(res.rgb[p * 3] - OBJ) < 25) objectColour++;
      }
      return { good: good / 1600, objectColour: objectColour / 1600, unrevealed: res.unrevealed / 1600 };
    };
    // The background shows in 70% of the samples: sigma 6 is not "very heavy" grain, so most of the hole is filled from it.
    const a = await run(6, 0.3, 10);
    expect(a.good).toBeGreaterThan(0.9);
    expect(a.objectColour).toBe(0);
    // It shows in 45%: still mostly filled (the interquartile rule of the earlier round gave under 10% here).
    const b = await run(6, 0.55, 10);
    expect(b.good).toBeGreaterThan(0.7);
    expect(b.objectColour).toBe(0);
    // Raising the tolerance to about 3 sigma restores the fill at heavier grain, as the schema text promises.
    const c = await run(8, 0.55, 30);
    expect(c.good).toBeGreaterThan(0.9);
    // A static object (in every sample) still leaks only a few percent of its pixels, the grain outliers.
    const d = await run(6, 1, 10);
    expect(d.objectColour).toBeLessThan(0.1);
    expect(d.good).toBeLessThan(0.1);
    expect(d.unrevealed).toBeGreaterThan(0.85);
  });

  it("ignores invalid samples", async () => {
    const bad = makeImage(4, 4, () => [1, 1, 1]);
    for (let i = 0; i < 16; i++) bad.data[i * 4 + 3] = 0;
    const res = await medianStack([bad, bad, bad], hole, ref, stackOpts);
    expect(res.count[0]).toBe(0);
  });
});

describe("laplaceFill", () => {
  it("returns a gradient with a square hole within 2/255", async () => {
    const grad = makeImage(60, 50, (x, y) => [x * 3, y * 4, 50 + x + y]);
    const unknown = new Uint8Array(60 * 50);
    for (let y = 15; y < 35; y++) for (let x = 20; x < 42; x++) unknown[y * 60 + x] = 1;
    const plane = planeFromRgba(grad);
    for (let i = 0; i < unknown.length; i++) if (unknown[i]) plane.data.fill(0, i * 3, i * 3 + 3);
    const res = await laplaceFill(plane, unknown);
    expect(res.ok).toBe(true);
    let worst = 0;
    for (let i = 0; i < unknown.length; i++) for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(res.plane.data[i * 3 + c] - grad.data[i * 4 + c]));
    expect(worst).toBeLessThan(2);
    expect(res.iterations).toBeGreaterThan(0);
    // The input plane is not touched.
    expect(plane.data[(20 * 60 + 30) * 3]).toBe(0);
  });

  it("is a no-op without unknown pixels and reports a plane with nothing known", async () => {
    const plane: Plane = { width: 4, height: 4, data: new Float32Array(48).fill(7) };
    expect((await laplaceFill(plane, new Uint8Array(16))).filled).toBe(0);
    const none = await laplaceFill(plane, new Uint8Array(16).fill(1));
    expect(none.ok).toBe(false);
  });
});

describe("patchMatchFill", () => {
  it("fills a periodic texture from the rest of the crop", async () => {
    const tex = makeImage(64, 64, (x, y) => [((x >> 2) & 1) * 180 + 30, ((y >> 2) & 1) * 150 + 40, (((x >> 2) + (y >> 2)) & 1) * 100 + 60]);
    const unknown = new Uint8Array(64 * 64);
    for (let y = 24; y < 40; y++) for (let x = 24; x < 40; x++) unknown[y * 64 + x] = 1;
    const plane = planeFromRgba(tex);
    for (let i = 0; i < unknown.length; i++) if (unknown[i]) plane.data.fill(128, i * 3, i * 3 + 3);
    const res = await patchMatchFill(plane, unknown, { seed: 3 });
    expect(res.fallback).toBe(false);
    expect(res.levels).toBe(2);
    expect(res.sourcePatches).toBeGreaterThan(100);
    let err = 0;
    let n = 0;
    for (let i = 0; i < unknown.length; i++) {
      if (!unknown[i]) continue;
      for (let c = 0; c < 3; c++) err += Math.abs(res.plane.data[i * 3 + c] - tex.data[i * 4 + c]);
      n += 3;
    }
    expect(err / n).toBeLessThan(20);
    // Known pixels are untouched.
    expect(res.plane.data[5 * 3]).toBe(tex.data[5 * 4]);
  });

  it("falls back to the diffusion fill when the crop has nothing to copy", async () => {
    const plane: Plane = { width: 12, height: 12, data: new Float32Array(12 * 12 * 3).fill(90) };
    const unknown = new Uint8Array(144).fill(1);
    unknown[0] = 0;
    const res = await patchMatchFill(plane, unknown, { levels: 1 });
    expect(res.fallback).toBe(true);
  });
});

// ---------- the whole job on synthetic frames ----------

describe("fillFromFrames", () => {
  it("fills the hole exactly from frames in which the object has moved away", async () => {
    const got: number[] = [];
    const out = await fillFromFrames(
      baseInput({
        matchColor: false,
        samples: [1, 2, 3, 4, 5].map((t) => ({ time: t, H: IDENT })),
        getFrame: async (t) => {
          got.push(t);
          return frameWithObject(-30 + t);
        },
      })
    );
    expect(got).toEqual([1, 2, 3, 4, 5]);
    expect(out.stats.samples_used).toBe(5);
    expect(out.stats.temporal_share).toBe(1);
    expect(out.stats.spatial_share).toBe(0);
    expect(maxErr(out.image, makeImage(W, H, world), (x, y) => inSquare(x, y, 2))).toBe(0);
    // Outside the grown hole the frame is the reference.
    expect(maxErr(out.image, frameWithObject(0), (x, y) => !inSquare(x, y, 2))).toBe(0);
    expect(out.stats.sample_count).toMatchObject({ min: 5, max: 5 });
    expect(out.classes.filter((c) => c === CLS.TEMPORAL).length).toBe(out.stats.hole_pixels);
  });

  it("fills exactly from frames shifted by a known homography", async () => {
    // Frame at shift s shows world(x + s, y); the reference point (x, y) is at (x - s, y) there.
    const shifted = (s: number, ox: number) => makeImage(W, H, (x, y) => (x + s >= 40 + ox && x + s < 56 + ox && y >= 24 && y < 40 ? RED : world(x + s, y)));
    const out = await fillFromFrames(
      baseInput({
        growPx: 0,
        matchColor: false,
        samples: [3, -3, 6, -6].map((s, i) => ({ time: i, H: [1, 0, -s, 0, 1, 0, 0, 0, 1] })),
        getFrame: async (t) => {
          const s = [3, -3, 6, -6][t];
          return shifted(s, 40 - 40 + 30);
        },
        minSamples: 3,
      })
    );
    expect(out.stats.temporal_share).toBe(1);
    expect(maxErr(out.image, makeImage(W, H, world), (x, y) => inSquare(x, y))).toBe(0);
  });

  it("matches a sample's exposure to the reference before the median", async () => {
    const dim = (ox: number) => makeImage(W, H, (x, y) => (x >= 40 + ox && x < 56 + ox && y >= 24 && y < 40 ? RED : (world(x, y).map((v) => Math.round(v * 0.8 + 20)) as [number, number, number])));
    const out = await fillFromFrames(baseInput({ samples: [1, 2, 3].map((t) => ({ time: t, H: IDENT })), getFrame: async (t) => dim(-30 + t) }));
    expect(out.stats.samples_color_matched).toBe(3);
    expect(maxErr(out.image, makeImage(W, H, world), (x, y) => inSquare(x, y, 2))).toBeLessThanOrEqual(3);
    const raw = await fillFromFrames(baseInput({ matchColor: false, samples: [1, 2, 3].map((t) => ({ time: t, H: IDENT })), getFrame: async (t) => dim(-30 + t) }));
    expect(maxErr(raw.image, makeImage(W, H, world), (x, y) => inSquare(x, y, 2))).toBeGreaterThan(20);
  });

  it("hands what no frame reveals to the spatial fill, and leaves it with method temporal", async () => {
    const same = { samples: [1, 2, 3].map((t) => ({ time: t, H: IDENT })), getFrame: async () => frameWithObject(0), objectMoves: false };
    const auto = await fillFromFrames(baseInput(same));
    expect(auto.stats.temporal_share).toBe(0);
    expect(auto.stats.spatial_share).toBe(1);
    expect(auto.stats.unrevealed_share).toBeGreaterThan(0.9);
    expect(auto.stats.spatial_method).toBe("diffuse");
    expect(maxErr(auto.image, frameWithObject(0), (x, y) => inSquare(x, y, 2) && x > 42 && x < 52)).toBeGreaterThan(30);
    const only = await fillFromFrames(baseInput({ ...same, method: "temporal" }));
    expect(only.stats.unfilled_share).toBe(1);
    expect(maxErr(only.image, frameWithObject(0), () => true)).toBe(0);
    expect(only.notes.join(" ")).toMatch(/never revealed/);
  });

  it("a static object with grain does not vote for itself: a pixel whose voters' median sits at the reference goes to the spatial fill", async () => {
    // Per-frame grain on top of the red object, the reference's included; no frame ever shows the background.
    const grain = (seed: number, sigma: number) =>
      makeImage(W, H, (x, y) => {
        const base = inSquare(x, y) ? RED : world(x, y);
        return [0, 1, 2].map((c) => {
          const g = ((noise(x, y, c + 3 * seed) - 127.5) / 50.8) * sigma;
          return Math.max(0, Math.min(255, Math.round(base[c] + g)));
        }) as [number, number, number];
      });
    for (const sigma of [4, 6, 10]) {
      const out = await fillFromFrames(
        baseInput({
          ref: grain(0, sigma),
          growPx: 0,
          matchColor: false,
          objectMoves: false,
          minSamples: 3,
          samples: Array.from({ length: 60 }, (_, i) => ({ time: i + 1, H: IDENT })),
          getFrame: async (t) => grain(t, sigma),
        })
      );
      expect(out.stats.temporal_share).toBeLessThan(0.05);
      expect(out.stats.unrevealed_share).toBeGreaterThan(0.9);
      expect(out.stats.spatial_share).toBeGreaterThan(0.9);
    }
  });

  it("a flat object in about 65% of grainy samples still lets the other samples fill the hole temporally", async () => {
    const sigma = 3;
    const frame = (seed: number, objectHere: boolean) =>
      makeImage(W, H, (x, y) => {
        const base = objectHere && inSquare(x, y) ? RED : world(x, y);
        return [0, 1, 2].map((c) => {
          const g = ((noise(x, y, c + 3 * seed) - 127.5) / 50.8) * sigma;
          return Math.max(0, Math.min(255, Math.round(base[c] + g)));
        }) as [number, number, number];
      });
    const shows = (t: number) => (t * 7) % 20 < 13;
    const out = await fillFromFrames(
      baseInput({
        ref: frame(0, true),
        growPx: 0,
        matchColor: false,
        objectMoves: false,
        minSamples: 3,
        samples: Array.from({ length: 60 }, (_, i) => ({ time: i + 1, H: IDENT })),
        getFrame: async (t) => frame(t, shows(t)),
      })
    );
    expect(out.stats.temporal_share).toBeGreaterThan(0.9);
    expect(out.stats.unrevealed_share).toBeLessThan(0.1);
  });

  it("gatherSamples needs the renders and fillFromGathered none: the two halves equal fillFromFrames", async () => {
    const input = baseInput({ samples: [1, 2, 3].map((t) => ({ time: t, H: IDENT })), getFrame: async (t) => frameWithObject(-30 + t) });
    const gathered = await gatherSamples(input);
    expect(gathered.samples).toHaveLength(3);
    expect(gathered.stopped).toBeNull();
    const second = await fillFromGathered({ ...input, getFrame: async () => { throw new Error("no render wanted"); } }, gathered);
    const whole = await fillFromFrames(input);
    expect(Buffer.from(second.image.data).equals(Buffer.from(whole.image.data))).toBe(true);
  });

  it("says why sampling stopped and how many planned samples were not rendered", async () => {
    let n = 0;
    const input = baseInput({ samples: [1, 2, 3, 4, 5].map((t) => ({ time: t, H: IDENT })), getFrame: async (t) => frameWithObject(-30 + t), shouldStop: () => (++n > 2 ? "render_failures" : false) });
    const out = await fillFromFrames(input);
    expect(out.stats.stopped_by).toBe("render_failures");
    expect(out.stats.stopped_by_budget).toBe(false);
    expect(out.stats.samples_not_rendered).toBe(3);
    n = 0;
    const budget = await fillFromFrames({ ...input, shouldStop: () => (++n > 1 ? true : false) });
    expect(budget.stats.stopped_by).toBe("budget");
    expect(budget.stats.stopped_by_budget).toBe(true);
    expect(budget.stats.samples_not_rendered).toBe(4);
  });

  it("fills a gradient with a hole spatially within 2/255, without rendering a sample", async () => {
    const grad = (x: number, y: number): [number, number, number] => [x * 2, y * 3, 80];
    const ref = makeImage(W, H, (x, y) => (inSquare(x, y) ? [255, 255, 255] : grad(x, y)));
    const out = await fillFromFrames(baseInput({ ref, method: "spatial", growPx: 0, getFrame: async () => { throw new Error("no render wanted"); } }));
    expect(out.stats.spatial_share).toBe(1);
    expect(maxErr(out.image, makeImage(W, H, grad), (x, y) => inSquare(x, y))).toBeLessThanOrEqual(2);
  });

  it("fills with the patch method too", async () => {
    const tex = (x: number, y: number): [number, number, number] => [((x >> 2) & 1) * 180 + 30, ((y >> 2) & 1) * 150 + 40, 90];
    const ref = makeImage(W, H, (x, y) => (inSquare(x, y) ? [0, 0, 0] : tex(x, y)));
    const out = await fillFromFrames(baseInput({ ref, method: "spatial", spatial: "patch", growPx: 0 }));
    expect(out.stats.spatial_method).toBe("patch");
    let sum = 0;
    let n = 0;
    for (let y = 24; y < 40; y++) {
      for (let x = 40; x < 56; x++) {
        for (let c = 0; c < 3; c++) {
          sum += Math.abs(out.image.data[(y * W + x) * 4 + c] - tex(x, y)[c]);
          n++;
        }
      }
    }
    expect(sum / n).toBeLessThan(25);
  });

  it("uses the samples it got when the budget runs out, and skips failed and non-overlapping frames", async () => {
    let calls = 0;
    const out = await fillFromFrames(
      baseInput({
        samples: [1, 2, 3, 4, 5, 6].map((t) => ({ time: t, H: t === 2 ? [1, 0, 500, 0, 1, 0, 0, 0, 1] : IDENT })),
        getFrame: async (t) => {
          calls++;
          return t === 3 ? null : frameWithObject(-30 + t);
        },
        shouldStop: () => calls >= 5,
        minSamples: 2,
      })
    );
    expect(out.stats.stopped_by_budget).toBe(true);
    expect(calls).toBe(5);
    expect(out.stats.samples_used).toBe(3);
    expect(out.stats.samples_skipped).toBe(2);
    expect(out.stats.temporal_share).toBe(1);
  });

  it("fills a hole of more than 150k pixels temporally without overflowing the stack", async () => {
    const BW = 1200;
    const BH = 700;
    const grey = (hole: boolean) => makeImage(BW, BH, (x, y) => (hole && x >= 100 && x < 520 && y >= 100 && y < 520 ? RED : [90, 100, 110]));
    const out = await fillFromFrames(
      baseInput({
        ref: grey(true),
        comp: { width: BW, height: BH },
        polygons: [[[100, 100], [520, 100], [520, 520], [100, 520]]],
        growPx: 0,
        matchColor: false,
        samples: [1, 2, 3].map((t) => ({ time: t, H: IDENT })),
        getFrame: async () => grey(false),
        ringPx: 12,
      })
    );
    expect(out.stats.hole_pixels).toBeGreaterThan(150000);
    expect(out.stats.temporal_share).toBe(1);
    expect(out.stats.sample_count).toMatchObject({ min: 3, mean: 3, max: 3 });
  });

  it("leaves out a sample whose ring fit is refused for a gain out of range", async () => {
    const dark = (ox: number) => makeImage(W, H, (x, y) => (x >= 40 + ox && x < 56 + ox && y >= 24 && y < 40 ? RED : (world(x, y).map((v) => Math.round(v * 0.3)) as [number, number, number])));
    const out = await fillFromFrames(baseInput({ samples: [1, 2, 3].map((t) => ({ time: t, H: IDENT })), getFrame: async (t) => dark(-30 + t) }));
    expect(out.stats.samples_color_rejected).toBe(3);
    expect(out.stats.samples_used).toBe(0);
    expect(out.notes.join(" ")).toMatch(/left out/);
  });

  it("refuses a hole over a quarter of the frame", async () => {
    await expect(fillFromFrames(baseInput({ polygons: [[[0, 0], [60, 0], [60, 40], [0, 40]]] }))).rejects.toThrow(/limit is 25%/);
  });
});

// ---------- the tool against a fake bridge ----------

const PROJECT = () => path.join(tmpDirs[0], "shot.aep").replace(/\\/g, "/");
const COPY_ID = 77;
const FPS = 10;

interface AeOpts {
  project?: string;
  comp?: Partial<{ width: number; height: number; pixel_aspect: number; duration: number }>;
  placeName?: string;
  /** The plate's opacity at the time asked for. */
  opacity?: number;
  /** inpaintRead finds no plate / no target comp. */
  noPlate?: boolean;
  noPlace?: boolean;
  /** The sample renders (every time but 0) fail. */
  failSamples?: boolean;
  /** inpaintApply is refused by the host. */
  failApply?: boolean;
  /** The frame at a time; the default has the object in the hole at time 0 and away from it later. */
  frame?: (time: number) => RgbaImage;
}

function fakeAe(opts: AeOpts = {}) {
  const calls: Array<{ fn: string; script: string }> = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-inpaint-q-"));
  tmpDirs.push(dir);
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
  const project = opts.project ?? PROJECT();
  const frameAt = opts.frame ?? ((t: number) => frameWithObject(t < 1e-9 ? 0 : -30 - Math.round(t * FPS)));
  let items = 3;
  let applied: { item: { id: number }; placed: boolean; masks: number; position: [number, number] | null; maskVals: Array<{ feather: number; expansion: number }> } | null = null;
  let layersInPlace = 4;
  const host = new PanelHost({
    evalScript: async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      calls.push({ fn, script });
      const args = JSON.parse(script.slice(script.indexOf("(") + 1, script.lastIndexOf(")")) || "{}");
      const ok = (result: unknown) => ({ ok: true, result, durationMs: 1 });
      if (fn === "checkGuard") return ok({ ok: true, project_path: project, comp_id: 1, comp_is_valid: true, dirty: false });
      if (fn === "inpaintRead") {
        if (opts.noPlate || (opts.noPlace && args.place_comp_id)) {
          return ok({
            comp: { id: 1, name: "Shot", width: W, height: H, pixel_aspect: 1, fps: FPS, frame_duration: 1 / FPS, duration: 2, time: 0, work_area_start: 0, work_area_duration: 2, num_layers: 2 },
            plate: opts.noPlate ? null : { index: 2, id: 41, name: "Plate A", enabled: true, locked: false, has_video: true, three_d: false },
            ...(opts.noPlate ? { plate_error: { kind: "not_found", message: 'No layer named "Plate A"' } } : {}),
            place: null,
            ...(opts.noPlace && args.place_comp_id ? { place_error: { kind: "not_found", message: "No CompItem with id 8" } } : {}),
            project: { path: project, bits_per_channel: 16, linear_blending: false },
          });
        }
        return ok({
          comp: { id: 1, name: "Shot", width: W, height: H, pixel_aspect: 1, fps: FPS, frame_duration: 1 / FPS, duration: 2, time: 0, work_area_start: 0, work_area_duration: 2, num_layers: 2, ...opts.comp },
          plate: { index: 2, id: 41, name: "Plate A", enabled: true, locked: false, has_video: true, three_d: false, opacity_at: args.at_time !== undefined ? opts.opacity ?? 100 : null },
          place: args.place_comp_id ? { id: args.place_comp_id, name: opts.placeName ?? "PATCH Shot", width: W, height: H, duration: 2, num_layers: layersInPlace } : null,
          project: { path: project, bits_per_channel: 16, linear_blending: false },
        });
      }
      if (fn === "planarIsolateBegin") return ok({ copy_id: COPY_ID, copy_name: "_chroma_plate_Shot", original_id: 1 });
      if (fn === "planarIsolateEnd") return ok({ removed: true, copy_id: COPY_ID });
      if (fn === "snapshotFrame") {
        if (opts.failSamples && args.time > 1e-9) return { ok: false, error: { kind: "evalscript_error", message: "render failed" } };
        const img = frameAt(args.time);
        const png = new PNG({ width: img.width, height: img.height });
        Buffer.from(img.data).copy(png.data);
        fs.mkdirSync(path.dirname(args.output_path), { recursive: true });
        fs.writeFileSync(args.output_path, PNG.sync.write(png));
        return ok({ path: args.output_path, time: args.time, width: img.width, height: img.height });
      }
      if (fn === "inpaintState") {
        const done = applied !== null;
        return ok({
          num_items: items,
          scanned: items,
          imported: done ? [{ id: applied!.item.id, name: "x.png", width: W, height: H }] : [],
          place: args.place_comp_id
            ? { id: args.place_comp_id, num_layers: layersInPlace, top: done && applied!.placed ? [{ index: 1, id: 900, name: "x.png", enabled: true, source_id: applied!.item.id, mask_count: applied!.masks, position: applied!.position, masks: applied!.maskVals }] : [] }
            : null,
        });
      }
      if (fn === "inpaintApply") {
        if (opts.failApply) return { ok: false, error: { kind: "evalscript_error", message: "Target comp is busy" } };
        items++;
        const placed = !!args.place;
        if (placed) layersInPlace++;
        const masked = placed && args.place.mode === "masked";
        applied = {
          item: { id: 500 },
          placed,
          masks: masked ? args.place.regions.length : 0,
          position: placed ? (args.place.offset ? [args.place.offset[0] + W / 2, args.place.offset[1] + H / 2] : [W / 2, H / 2]) : null,
          maskVals: masked ? args.place.regions.map(() => ({ feather: args.place.feather_px, expansion: args.place.expansion_px })) : [],
        };
        return ok({ item: { id: 500, name: "x.png", width: W, height: H }, layer: placed ? { index: 1, id: 900, name: "x.png" } : null, placed_in: placed ? args.place.comp_id : null, mode: placed ? args.place.mode : null, masks: placed && args.place.mode === "masked" ? args.place.regions.length : 0, png_path: args.png_path });
      }
      throw new Error(`Unexpected script: ${script}`);
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge: host, queue, quarantine };
  return { ctx, calls };
}

const call = (over: Record<string, unknown> = {}) =>
  AeInpaintPlateSchema.parse({
    comp_id: 1,
    plate_layer: { name: "Plate A" },
    regions: [{ rect: [40, 24, 16, 16] }],
    grow_px: 2,
    object_moves: true,
    max_frames: 4,
    expect: { project_path: PROJECT() },
    ...over,
  });

const readPng = (file: string): RgbaImage => {
  const png = PNG.sync.read(fs.readFileSync(file));
  return { width: png.width, height: png.height, data: png.data };
};

describe("ae_inpaint_plate against a fake bridge", () => {
  it("renders the isolated plate, fills the hole, writes the PNG to the plates folder and imports it", async () => {
    const { ctx, calls } = fakeAe();
    const out: any = await tool.handler(call(), ctx);
    const fns = calls.map((c) => c.fn);
    // The second inpaintRead asks for the plate's opacity at ref_time.
    expect(fns.slice(0, 4)).toEqual(["checkGuard", "inpaintRead", "inpaintRead", "planarIsolateBegin"]);
    // One reference render and four samples, all of the copy, then the copy goes, then the write with its reads.
    expect(fns.filter((f) => f === "snapshotFrame")).toHaveLength(5);
    expect(calls.filter((c) => c.fn === "snapshotFrame").every((c) => c.script.includes(`"comp_id":${COPY_ID}`))).toBe(true);
    expect(fns.slice(fns.indexOf("planarIsolateEnd"))).toEqual(["planarIsolateEnd", "checkGuard", "inpaintState", "inpaintApply", "inpaintState"]);
    expect(out.applied).toBe(true);
    expect(out.receipt.matches).toBe(true);
    expect(out.item).toMatchObject({ id: 500 });
    expect(out.fill.filled.temporal_share).toBe(1);
    expect(out.fill.samples).toMatchObject({ planned: 4, used: 4 });
    expect(out.fill.plate_copy).toMatchObject({ copy_id: COPY_ID, removed: true });
    expect(out.fill.notes.join(" ")).toMatch(/16 bpc/);
    expect(out.fill.notes.join(" ")).toMatch(/locked off/);
    // The still: in '<project> chroma plates/', named after the plate and frame, with the hole filled.
    const folder = path.join(tmpDirs[0], "shot chroma plates");
    expect(path.dirname(out.fill.png_path)).toBe(folder);
    expect(path.basename(out.fill.png_path)).toBe("Plate_A_f0_inpaint.png");
    expect(fs.existsSync(out.fill.preview_path)).toBe(true);
    const still = readPng(out.fill.png_path);
    expect(maxErr(still, makeImage(W, H, world), (x, y) => inSquare(x, y, 2))).toBeLessThanOrEqual(2);
    // The write got the guard, and the path the host will import.
    const write = calls.find((c) => c.fn === "inpaintApply")!;
    expect(write.script).toContain('"expect"');
    expect(JSON.parse(write.script.slice(write.script.indexOf("(") + 1, write.script.lastIndexOf(")"))).png_path).toBe(out.fill.png_path);
  });

  it("frees the AE queue before the CPU fill and the PNG write", async () => {
    const { ctx } = fakeAe();
    const folder = path.join(tmpDirs[0], "shot chroma plates");
    const run = ctx.queue.run.bind(ctx.queue);
    let atLeaseEnd: string[] | null = null;
    let idleAfter = false;
    (ctx.queue as any).run = async (label: string, fn: () => Promise<unknown>) => {
      const v = await run(label, fn);
      if (atLeaseEnd === null) {
        atLeaseEnd = fs.existsSync(folder) ? fs.readdirSync(folder) : [];
        // A second job gets the lease while the fill is still to run.
        await run("probe", async () => {
          idleAfter = true;
        });
      }
      return v;
    };
    const out: any = await tool.handler(call(), ctx);
    expect(out.applied).toBe(true);
    expect(atLeaseEnd).toEqual([]);
    expect(idleAfter).toBe(true);
    expect(fs.existsSync(out.fill.png_path)).toBe(true);
  });

  it("refuses a plate that is at opacity 0 at ref_time before any copy is made", async () => {
    const { ctx, calls } = fakeAe({ opacity: 0 });
    const out: any = await tool.handler(call(), ctx);
    expect(out.ok).toBe(false);
    expect(out.error).toBe("refused");
    expect(out.message).toMatch(/opacity 0/);
    expect(calls.some((c) => c.fn.startsWith("planarIsolate") || c.fn === "snapshotFrame")).toBe(false);
    // With isolate_plate off nothing is refused for it.
    const off: any = await tool.handler(call({ isolate_plate: false }), fakeAe({ opacity: 0 }).ctx);
    expect(off.applied).toBe(true);
  });

  it("refuses by name when the plate layer or the target comp is not found", async () => {
    const noPlate: any = await tool.handler(call(), fakeAe({ noPlate: true }).ctx);
    expect(noPlate).toMatchObject({ ok: false, error: "not_found" });
    expect(noPlate.message).toMatch(/No layer named/);
    const noPlace = fakeAe({ noPlace: true });
    const gone: any = await tool.handler(call({ place_in_comp: { comp_id: 8 } }), noPlace.ctx);
    expect(gone).toMatchObject({ ok: false, error: "not_found" });
    expect(gone.message).toMatch(/No CompItem with id 8/);
    expect(noPlace.calls.some((c) => c.fn.startsWith("planarIsolate"))).toBe(false);
  });

  it("answers with the facts of phase 1 when the import write is refused, instead of throwing", async () => {
    const { ctx, calls } = fakeAe({ failApply: true });
    const out: any = await tool.handler(call(), ctx);
    expect(out.ok).toBe(false);
    expect(out.applied).toBe(false);
    expect(out.message).toMatch(/Target comp is busy/);
    expect(out.message).toMatch(/saved at/);
    expect(fs.existsSync(out.png_path)).toBe(true);
    expect(out.plate_copy).toMatchObject({ copy_id: COPY_ID, removed: true });
    expect(out.fill.samples.used).toBe(4);
    expect(calls.some((c) => c.fn === "planarIsolateEnd")).toBe(true);
  });

  it("reports render failures as such, not as a spent budget", async () => {
    const out: any = await tool.handler(call(), fakeAe({ failSamples: true }).ctx);
    expect(out.applied).toBe(true);
    expect(out.fill.samples).toMatchObject({ planned: 4, used: 0, stopped_by: "render_failures", stopped_by_budget: false, not_rendered: 2 });
    expect(out.fill.notes.join(" ")).toMatch(/stopped after 2 failed renders in a row/);
    expect(out.fill.notes.join(" ")).toMatch(/2 planned sample\(s\) were not rendered/);
  });

  it("never overwrites an earlier still", async () => {
    const first: any = await tool.handler(call(), fakeAe().ctx);
    const second: any = await tool.handler(call(), fakeAe().ctx);
    expect(path.basename(first.fill.png_path)).toBe("Plate_A_f0_inpaint.png");
    expect(path.basename(second.fill.png_path)).toBe("Plate_A_f0_inpaint_2.png");
  });

  it("renders the comp as it is when isolate_plate is off, and makes no copy", async () => {
    const { ctx, calls } = fakeAe();
    const out: any = await tool.handler(call({ isolate_plate: false, preview: false }), ctx);
    expect(calls.some((c) => c.fn.startsWith("planarIsolate"))).toBe(false);
    expect(calls.filter((c) => c.fn === "snapshotFrame").every((c) => c.script.includes('"comp_id":1,'))).toBe(true);
    expect(out.fill.plate_copy).toBeNull();
    expect(out.fill.preview_path).toBeNull();
    expect(out.receipt.matches).toBe(true);
  });

  it("with method spatial renders only the reference frame", async () => {
    const { ctx, calls } = fakeAe();
    const out: any = await tool.handler(call({ method: "spatial", object_moves: false }), ctx);
    expect(calls.filter((c) => c.fn === "snapshotFrame")).toHaveLength(1);
    expect(out.fill.filled.spatial_share).toBe(1);
    expect(out.fill.samples.planned).toBe(0);
  });

  it("puts the still in a PATCH comp unmasked and in another comp with a mask per region", async () => {
    const patch = fakeAe({ placeName: "Plate A PATCH f0" });
    const a: any = await tool.handler(call({ place_in_comp: { comp_id: 8 } }), patch.ctx);
    const wa = patch.calls.find((c) => c.fn === "inpaintApply")!.script;
    expect(wa).toContain('"mode":"unmasked"');
    expect(a.placement_why).toMatch(/has PATCH in its name/);
    expect(a.receipt.matches).toBe(true);
    expect(a.placed_in).toBe(8);

    const work = fakeAe({ placeName: "STAB work" });
    const b: any = await tool.handler(call({ regions: [{ rect: [40, 24, 16, 16] }, { ellipse: [20, 20, 5, 5] }], place_in_comp: { comp_id: 8, offset_px: [10, 20], feather_px: 20 } }), work.ctx);
    const w = work.calls.find((c) => c.fn === "inpaintApply")!.script;
    const args = JSON.parse(w.slice(w.indexOf("(") + 1, w.lastIndexOf(")")));
    expect(args.place).toMatchObject({ comp_id: 8, mode: "masked", offset: [10, 20], feather_px: 20, expansion_px: 12 });
    expect(args.place.regions).toHaveLength(2);
    expect(args.place.regions[0][0]).toEqual([40, 24]);
    expect(b.masks).toBe(2);
  });

  it("refuses an unsaved project before rendering or writing anything", async () => {
    const { ctx, calls } = fakeAe({ project: "<unsaved>" });
    const out: any = await tool.handler(call({ expect: { project_path: "<unsaved>" } }), ctx);
    expect(out).toMatchObject({ ok: false, error: "refused" });
    expect(out.message).toMatch(/not been saved/);
    expect(calls.map((c) => c.fn)).toEqual(["checkGuard"]);
  });

  it("refuses a hole over 25% of the frame, a non-square comp and a bad region, with no write", async () => {
    const big = fakeAe();
    const out: any = await tool.handler(call({ regions: [{ rect: [0, 0, 60, 40] }] }), big.ctx);
    expect(out).toMatchObject({ ok: false, error: "refused" });
    expect(out.message).toMatch(/limit is 25%/);
    expect(big.calls.map((c) => c.fn)).toEqual(["checkGuard", "inpaintRead"]);
    const skew: any = await tool.handler(call(), fakeAe({ comp: { pixel_aspect: 2 } }).ctx);
    expect(skew.message).toMatch(/pixel aspect/);
    const bad: any = await tool.handler(call({ regions: [{ ellipse: [5, 5, 0, 3] }] }), fakeAe().ctx);
    expect(bad).toMatchObject({ ok: false, error: "bad_args" });
  });

  it("reports a temporal-only run with nothing revealed", async () => {
    const still = fakeAe({ frame: () => frameWithObject(0) });
    const out: any = await tool.handler(call({ object_moves: false, method: "temporal" }), still.ctx);
    expect(out.fill.filled.unfilled_share).toBe(1);
    expect(out.fill.notes.join(" ")).toMatch(/not filled|never revealed/);
    const auto: any = await tool.handler(call({ object_moves: false }), still.ctx);
    expect(auto.fill.filled.spatial_share).toBe(1);
    expect(auto.fill.notes.join(" ")).toMatch(/never revealed/);
    // The note does not claim the frames showed nothing: grain can make the background look like the object.
    expect(auto.fill.notes.join(" ")).toMatch(/object_tolerance, now 10, to about 3 times the grain/);
    const moving: any = await tool.handler(call({ object_moves: true }), fakeAe().ctx);
    expect(moving.fill.notes.join(" ")).not.toMatch(/object_tolerance/);
  });

  it("under grain (sigma 6, default tolerance) a static object gets the object_tolerance hint without needing temporal_share to be exactly 0", async () => {
    // The object sits in every frame; per-frame grain on top, the reference's included.
    const grainy = (t: number, sigma: number) =>
      makeImage(W, H, (x, y) => {
        const base = inSquare(x, y) ? RED : world(x, y);
        return [0, 1, 2].map((c) => Math.max(0, Math.min(255, Math.round(base[c] + ((noise(x, y, c + 3 * Math.round(t * FPS)) - 127.5) / 50.8) * sigma)))) as [number, number, number];
      });
    const run = async (over: Record<string, unknown>) => {
      const out: any = await tool.handler(call({ object_moves: false, max_frames: 20, ...over }), fakeAe({ frame: (t) => grainy(t, 6) }).ctx);
      return { out, notes: out.fill.notes.join(" ") as string };
    };
    const auto = await run({});
    expect(auto.out.fill.samples.unrevealed_share).toBeGreaterThan(0.5);
    expect(auto.notes).toMatch(/object_tolerance, now 10, to about 3 times the grain/);
    expect(auto.notes).toMatch(/goes to the spatial fill/);
    expect(auto.notes).not.toMatch(/Everything is spatial/);
    // A moving object is not told about the tolerance.
    const moving = await run({ object_moves: true });
    expect(moving.notes).not.toMatch(/object_tolerance/);
  });

  it("the no-reveal note says what happens per method: spatial fill with auto, an unfilled hole with temporal", async () => {
    const still = fakeAe({ frame: () => frameWithObject(0) });
    const auto: any = await tool.handler(call({ object_moves: false, method: "auto" }), still.ctx);
    const autoNotes = auto.fill.notes.join(" ");
    expect(autoNotes).toMatch(/Everything is spatial/);
    const temporal: any = await tool.handler(call({ object_moves: false, method: "temporal" }), still.ctx);
    const tNotes = temporal.fill.notes.join(" ");
    expect(tNotes).toMatch(/No hole pixel was filled/);
    expect(tNotes).toMatch(/The hole is left unfilled \(method temporal\)/);
    expect(tNotes).not.toMatch(/Everything is spatial/);
    expect(tNotes).not.toMatch(/Keep the hole small/);
  });

  it("logs the plate copy as the agent's own write and reports what the user changed, even when the import is refused", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-inpaint-sess-"));
    tmpDirs.push(dir);
    try {
      installSessionTracking({ dataDir: dir });
      getSessionTracker()!.addPending("Layer Z was moved by the user.");
      const { ctx } = fakeAe({ failApply: true });
      const out: any = await tool.handler(call(), ctx);
      expect(out.applied).toBe(false);
      expect(out.user_changed).toContain("Layer Z was moved by the user.");
      // The copy and its removal (two undo steps) are in the session log although the import never ran.
      expect(getSessionTracker()!.agentWritesSince(PROJECT(), null).some((w) => w.tool === "ae_inpaint_plate")).toBe(true);
    } finally {
      resetSessionTracking();
    }
  });

  it("reports what the user changed once on an applied run, and logs the isolate write", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-inpaint-sess-"));
    tmpDirs.push(dir);
    try {
      installSessionTracking({ dataDir: dir });
      getSessionTracker()!.addPending("Layer Z was moved by the user.");
      const out: any = await tool.handler(call(), fakeAe().ctx);
      expect(out.applied).toBe(true);
      expect(String(out.user_changed).split("Layer Z was moved by the user.")).toHaveLength(2);
      expect(getSessionTracker()!.agentWritesSince(PROJECT(), null).length).toBeGreaterThanOrEqual(2);
    } finally {
      resetSessionTracking();
    }
  });

  it("a fill that fails after the copy was made still logs the copy and carries user_changed", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-inpaint-sess-"));
    tmpDirs.push(dir);
    try {
      installSessionTracking({ dataDir: dir });
      getSessionTracker()!.addPending("Layer Z was moved by the user.");
      // The render comes back at another size than the comp: the fill refuses inside the isolated copy.
      const { ctx } = fakeAe({ frame: () => makeImage(W + 2, H, world) });
      const out: any = await tool.handler(call(), ctx);
      expect(out).toMatchObject({ ok: false, error: "refused" });
      expect(out.plate_copy).toMatchObject({ copy_id: COPY_ID, removed: true });
      expect(out.user_changed).toContain("Layer Z was moved by the user.");
      expect(getSessionTracker()!.agentWritesSince(PROJECT(), null).some((w) => w.tool === "ae_inpaint_plate")).toBe(true);
    } finally {
      resetSessionTracking();
    }
  });
});

describe("inpaintMismatches", () => {
  const before = { num_items: 3, scanned: 3, imported: [], place: { id: 8, num_layers: 4, top: [] } };
  const after = (over: Record<string, unknown> = {}) => ({
    num_items: 4,
    scanned: 4,
    imported: [{ id: 500, name: "x.png", width: 1, height: 1 }],
    place: { id: 8, num_layers: 5, top: [{ index: 1, id: 900, name: "x", enabled: true, source_id: 500, mask_count: 2 }] },
    ...over,
  });
  const written = { item: { id: 500 }, layer: { id: 900 }, masks: 2 };

  it("passes a clean import and placement", () => {
    expect(inpaintMismatches(before, after(), written, true)).toEqual([]);
    expect(inpaintMismatches({ ...before, place: null }, after({ place: null }), { item: { id: 500 } }, false)).toEqual([]);
  });

  it("flags a missing item, a missing layer, a wrong source and a wrong mask count", () => {
    expect(inpaintMismatches(before, after({ imported: [] }), written, true).map((m) => m.path)).toContain("imported");
    expect(inpaintMismatches(before, after({ num_items: 3 }), written, true).map((m) => m.path)).toContain("num_items");
    expect(inpaintMismatches(before, after({ place: { id: 8, num_layers: 4, top: [] } }), written, true).map((m) => m.path)).toContain("place.num_layers");
    const wrongTop = { id: 8, num_layers: 5, top: [{ index: 1, id: 901, name: "x", enabled: true, source_id: 12, mask_count: 0 }] };
    const paths = inpaintMismatches(before, after({ place: wrongTop }), written, true).map((m) => m.path);
    expect(paths).toEqual(expect.arrayContaining(["place.top.id", "place.top.source_id", "place.top.mask_count"]));
  });

  it("checks the still's size, the layer's position and each mask's feather and expansion", () => {
    const want = { still_size: [96, 64] as [number, number], position: [58, 52] as [number, number], feather_px: 12, expansion_px: 8 };
    const good = after({
      imported: [{ id: 500, name: "x.png", width: 96, height: 64 }],
      place: { id: 8, num_layers: 5, top: [{ index: 1, id: 900, name: "x", enabled: true, source_id: 500, mask_count: 2, position: [58, 52], masks: [{ feather: 12, expansion: 8 }, { feather: 12, expansion: 8 }] }] },
    });
    expect(inpaintMismatches(before, good, written, true, want)).toEqual([]);
    const paths = (over: Record<string, unknown>, w = want) => inpaintMismatches(before, after(over), written, true, w).map((m) => m.path);
    const top = (o: Record<string, unknown>) => ({ place: { id: 8, num_layers: 5, top: [{ index: 1, id: 900, name: "x", enabled: true, source_id: 500, mask_count: 2, position: [58, 52], masks: [{ feather: 12, expansion: 8 }, { feather: 12, expansion: 8 }], ...o }] } });
    expect(paths({ ...top({ position: [50, 50] }), imported: good.imported })).toContain("place.top.position");
    expect(paths({ ...top({ masks: [{ feather: 0, expansion: 8 }, { feather: 12, expansion: 8 }] }), imported: good.imported })).toContain("place.top.masks");
    expect(paths({ ...top({ masks: [{ feather: 12, expansion: 0 }, { feather: 12, expansion: 8 }] }), imported: good.imported })).toContain("place.top.masks");
    expect(paths({ ...top({}), imported: [{ id: 500, name: "x.png", width: 48, height: 32 }] })).toContain("imported.size");
  });

  it("does not judge the item when the project is bigger than the scan", () => {
    expect(inpaintMismatches({ ...before, place: null }, after({ place: null, imported: [], scanned: 2, num_items: 4 }), written, false)).toEqual([]);
  });

  it("returns nothing when a read failed", () => {
    expect(inpaintMismatches(null, after(), written, true)).toEqual([]);
  });
});

// ---------- inpaint.jsx under node:vm ----------

describe("inpaint.jsx", () => {
  function scene() {
    const project = new FakeProject();
    const comp = project.addComp("Shot", W, H, 2);
    const plate = comp.layers.addSolid([0.5, 0.5, 0.5], "Plate A", W, H, 1);
    const patch = project.addComp("PATCH Shot", W, H, 2);
    patch.layers.addSolid([0, 0, 0], "Frozen", W, H, 1);
    const png = path.join(tmpDirs[0], "Plate_A_f0_inpaint.png").replace(/\\/g, "/");
    fs.writeFileSync(png, "png");
    return { project, comp, plate, patch, png };
  }

  it("inpaintRead describes the comp, the plate layer and the target comp without changing anything", () => {
    const { project, comp, plate, patch } = scene();
    const { A, undo } = loadHost(project, ["inpaint.jsx"]);
    const info = A.inpaintRead({ comp_id: comp.id, plate: { name: "Plate A" }, place_comp_id: patch.id });
    expect(info.comp).toMatchObject({ id: comp.id, width: W, height: H, pixel_aspect: 1, num_layers: 1 });
    expect(info.plate).toMatchObject({ id: plate.id, index: 1, name: "Plate A", has_video: true, locked: false });
    expect(info.place).toMatchObject({ id: patch.id, name: "PATCH Shot", num_layers: 1 });
    expect(info.project.path).toBeNull();
    expect(undo.begun).toBe(0);
    expect(A.inpaintRead({ comp_id: comp.id, plate: null, place_comp_id: null }).plate).toBeNull();
    expect(() => A.inpaintRead({ comp_id: 999999, plate: null })).toThrow(/No CompItem/);
    // A plate or a target comp that is not there comes back as data, so the server can refuse by name.
    const noPlate = A.inpaintRead({ comp_id: comp.id, plate: { name: "nope" }, place_comp_id: 987654 });
    expect(noPlate.plate).toBeNull();
    expect(noPlate.plate_error).toMatchObject({ kind: "not_found" });
    expect(noPlate.plate_error.message).toMatch(/No layer named/);
    expect(noPlate.place).toBeNull();
    expect(noPlate.place_error.message).toMatch(/No CompItem/);
    // With at_time the plate's opacity at that time comes back.
    const withOpacity = A.inpaintRead({ comp_id: comp.id, plate: { name: "Plate A" }, place_comp_id: null, at_time: 0.5 });
    expect(withOpacity.plate.opacity_at).toBe(100);
    expect(info.plate.opacity_at).toBeNull();
  });

  it("inpaintApply imports the still alone in one undo group", () => {
    const { project, png } = scene();
    const { A, undo } = loadHost(project, ["inpaint.jsx"]);
    const out = A.inpaintApply({ png_path: png, place: null, expect: GUARD });
    expect(out.item.name).toBeTruthy();
    expect(out.layer).toBeNull();
    expect(undo.begun).toBe(1);
    expect(undo.ended).toBe(1);
    const state = A.inpaintState({ png_path: png, place_comp_id: null });
    expect(state.imported).toHaveLength(1);
    expect(state.imported[0].id).toBe(out.item.id);
    // A path written the other way round, in another case, is the same file.
    expect(A.inpaintState({ png_path: png.replace(/\//g, "\\").toUpperCase(), place_comp_id: null }).imported).toHaveLength(1);
  });

  it("puts the still on top of a PATCH comp unmasked", () => {
    const { project, patch, png } = scene();
    const { A } = loadHost(project, ["inpaint.jsx"]);
    const out = A.inpaintApply({ png_path: png, place: { comp_id: patch.id, mode: "unmasked", offset: null, regions: [], layer_name: "Clean plate" }, expect: GUARD });
    expect(out).toMatchObject({ placed_in: patch.id, mode: "unmasked", masks: 0 });
    expect(patch.layer(1)!.name).toBe("Clean plate");
    expect(patch.numLayers).toBe(2);
    const state = A.inpaintState({ png_path: png, place_comp_id: patch.id });
    expect(state.place.num_layers).toBe(2);
    expect(state.place.top[0]).toMatchObject({ id: patch.layer(1)!.id, source_id: out.item.id, mask_count: 0 });
  });

  it("masks the still per region with feather and expansion and positions it by the offset", () => {
    const { project, patch, png } = scene();
    const { A } = loadHost(project, ["inpaint.jsx"]);
    const regions = [
      [[40, 24], [56, 24], [56, 40], [40, 40]],
      [[5, 5], [15, 5], [10, 15]],
    ];
    const out = A.inpaintApply({ png_path: png, place: { comp_id: patch.id, mode: "masked", offset: [10, 20], regions, feather_px: 12, expansion_px: 8 }, expect: GUARD });
    expect(out.masks).toBe(2);
    const layer = patch.layer(1)!;
    const masks = layer.property("ADBE Mask Parade") as any;
    expect(masks.numProperties).toBe(2);
    const first = masks.property(1);
    expect(first.property("ADBE Mask Feather").value).toEqual([12, 12]);
    expect(first.property("ADBE Mask Offset").value).toBe(8);
    expect(first.property("ADBE Mask Shape").value.vertices).toEqual(regions[0]);
    expect(first.maskMode).toBe(6813);
    // The still is 100 x 100 here (the fake's default), so its top-left corner at (10, 20) puts the centre at (60, 70).
    const pos = (layer.property("ADBE Transform Group") as any).property("ADBE Position").value;
    expect([pos[0], pos[1]]).toEqual([60, 70]);
    // The read-back the receipt compares: position and each mask's feather and expansion.
    const state = A.inpaintState({ png_path: png, place_comp_id: patch.id });
    expect(state.place.top[0].position).toEqual([60, 70]);
    expect(state.place.top[0].masks).toEqual([{ feather: 12, expansion: 8 }, { feather: 12, expansion: 8 }]);
  });

  it("refuses before the undo group: a bad guard, a missing file, bad polygons, bad limits, a missing comp", () => {
    const { project, patch, png } = scene();
    const { A, undo } = loadHost(project, ["inpaint.jsx"]);
    const items0 = project.numItems;
    const masked = (extra: Record<string, unknown>) => ({ comp_id: patch.id, mode: "masked", offset: null, regions: [[[0, 0], [5, 0], [5, 5]]], feather_px: 4, expansion_px: 0, ...extra });
    expect(() => A.inpaintApply({ png_path: png, place: null, expect: { project_path: "C:/other.aep" } })).toThrow(/Target guard refused/);
    expect(() => A.inpaintApply({ png_path: png + ".missing", place: null, expect: GUARD })).toThrow(/not on disk/);
    expect(() => A.inpaintApply({ png_path: png, place: masked({ regions: [] }), expect: GUARD })).toThrow(/at least one region/);
    expect(() => A.inpaintApply({ png_path: png, place: masked({ regions: [[[0, 0], [5, 0]]] }), expect: GUARD })).toThrow(/needs 3 to 200 points/);
    expect(() => A.inpaintApply({ png_path: png, place: masked({ regions: [[[0, 0], [5, 0], [5, "x"]]] }), expect: GUARD })).toThrow(/not a finite/);
    expect(() => A.inpaintApply({ png_path: png, place: masked({ feather_px: 501 }), expect: GUARD })).toThrow(/feather_px/);
    expect(() => A.inpaintApply({ png_path: png, place: masked({ expansion_px: -1001 }), expect: GUARD })).toThrow(/expansion_px/);
    expect(() => A.inpaintApply({ png_path: png, place: masked({ mode: "weird" }), expect: GUARD })).toThrow(/place.mode/);
    expect(() => A.inpaintApply({ png_path: png, place: masked({ offset: [1] }), expect: GUARD })).toThrow(/offset/);
    expect(() => A.inpaintApply({ png_path: png, place: masked({ comp_id: 987654 }), expect: GUARD })).toThrow(/No CompItem/);
    expect(undo.begun).toBe(0);
    expect(project.numItems).toBe(items0);
    expect(patch.numLayers).toBe(1);
  });

  it("removes the imported item when the placement fails", () => {
    const { project, patch, png } = scene();
    const { A, undo } = loadHost(project, ["inpaint.jsx"]);
    patch.layers.add = () => {
      throw new Error("cannot add");
    };
    expect(() => A.inpaintApply({ png_path: png, place: { comp_id: patch.id, mode: "unmasked", offset: null, regions: [] }, expect: GUARD })).toThrow(/cannot add/);
    expect(undo.begun).toBe(1);
    expect(undo.ended).toBe(1);
    expect(A.inpaintState({ png_path: png, place_comp_id: null }).imported).toHaveLength(0);
  });
});
