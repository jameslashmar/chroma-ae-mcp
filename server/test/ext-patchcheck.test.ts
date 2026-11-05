/**
 * The patch-check group: region-math (pure, on synthetic images), the sampling,
 * series, frame, slip and verdict logic, the schemas, the guarded flow of
 * ae_patch_check and ae_region_stats against a fake bridge (real PNGs written
 * where AE would render them), and patchcheck.jsx run under node:vm against the
 * simulated AE DOM.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Each render waits on the file poll (100 ms steps), so the flows take a few seconds.
vi.setConfig({ testTimeout: 60000 });

// A stale first render is hard to make with real files (the freshness poll waits 10 s), so a test can ask for the retry's outcome: the frame comes back at the nudged time.
const staleHook = vi.hoisted(() => ({ nudgeFirst: false }));
vi.mock("../src/tools/ext/frames.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/tools/ext/frames.js")>();
  return {
    ...real,
    captureCompFrame: async (p: Parameters<typeof real.captureCompFrame>[0]) => {
      const snap = await real.captureCompFrame(p);
      if (staleHook.nudgeFirst) {
        staleHook.nudgeFirst = false;
        return { ...snap, time: p.time + 0.001 };
      }
      return snap;
    },
  };
});
import { BridgeError } from "../src/host.js";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import {
  slipCropFits,
  regionRoom,
  AePatchCheckSchema,
  AeRegionStatsSchema,
  analyseFrame,
  buildContactSheet,
  cappedNote,
  copyMismatches,
  differenceImage,
  drawRegionsOverlay,
  drawSeriesGraph,
  exposurePush,
  footprintPolygon,
  homographyAt,
  judgePatch,
  measureSlip,
  patchcheckTools,
  planSamples,
  polygonAt,
  regionFrameStats,
  seriesStats,
  type FrameMetrics,
  type FrameOptions,
  type HostLayer,
  type SlipResult,
  type Thresholds,
} from "../src/tools/ext/patchcheck.js";
import {
  cropToBounds,
  fitGainOffset,
  gaussianBlurGray,
  laplacianEnergy,
  lumaPercentiles,
  maskedStats,
  noiseSigma,
  offsetPolygon,
  polygonArea,
  polygonBounds,
  rasterizePolygon,
  regionToPolygon,
  ringMask,
  seamScore,
  signedDistance,
  srgbToLinear,
  linearToSrgb,
  temporalNoise,
  warpPolygon,
  type Pt,
} from "../src/tools/ext/region-math.js";
import { goodFeatures } from "../src/tools/ext/planar-math.js";
import { toGray, type GrayImage } from "../src/tools/ext/track.js";
import { saveTrack } from "../src/tools/ext/planar.js";
import type { PlanarTrack } from "../src/tools/ext/planar-math.js";
import { FakeGroup, FakeLayer, FakeProject, FakeProperty, GUARD, loadHost, PropertyValueType, type FakeComp } from "./support/fake-ae.js";

const tool = (name: string) => patchcheckTools.find((t) => t.name === name)!;
const expectArg = { project_path: "<unsaved>" };

// ---------- helpers ----------

type Px = [number, number, number, number];

function image(width: number, height: number, fn: (x: number, y: number) => Px) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = fn(x, y);
      const i = (y * width + x) * 4;
      data[i] = p[0];
      data[i + 1] = p[1];
      data[i + 2] = p[2];
      data[i + 3] = p[3];
    }
  }
  return { width, height, data };
}

const grey = (v: number): Px => {
  const c = Math.max(0, Math.min(255, Math.round(v)));
  return [c, c, c, 255];
};

function writePng(file: string, img: { width: number; height: number; data: Buffer }) {
  const png = new PNG({ width: img.width, height: img.height });
  img.data.copy(png.data);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, PNG.sync.write(png));
}

/** A deterministic uniform [0, 1) from three integers. */
function hash01(x: number, y: number, seed: number): number {
  let h = (Math.imul(x + 1, 73856093) ^ Math.imul(y + 1, 19349663) ^ Math.imul(seed + 1, 83492791)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 3266489917) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Roughly Gaussian noise of standard deviation `sigma` (three uniforms summed). */
function noise(x: number, y: number, seed: number, sigma: number): number {
  return (hash01(x, y, seed) + hash01(x, y, seed + 1000) + hash01(x, y, seed + 2000) - 1.5) * (sigma / 0.5);
}

const grayOf = (img: { width: number; height: number; data: Buffer }): GrayImage => toGray(img);
const full = (w: number, h: number) => new Float32Array(w * h).fill(1);
const sum = (a: Float32Array) => a.reduce((s, v) => s + v, 0);

// ---------- region-math ----------

describe("region-math: polygons", () => {
  it("makes polygons from rects, ellipses and polygons, and warps them through a homography", () => {
    expect(regionToPolygon({ kind: "rect", rect: [1, 2, 5, 8] })).toEqual([[1, 2], [5, 2], [5, 8], [1, 8]]);
    expect(regionToPolygon({ kind: "ellipse", center: [10, 10], radius: [4, 2] }, 16)).toHaveLength(16);
    const tri: Pt[] = [[0, 0], [4, 0], [0, 4]];
    expect(regionToPolygon({ kind: "polygon", points: tri })).toEqual(tri);
    expect(polygonBounds(tri)).toEqual([0, 0, 4, 4]);
    expect(polygonArea(tri)).toBeCloseTo(8, 6);
  });

  it("round-trips a polygon through a homography and its inverse, and refuses a point behind the horizon", () => {
    const poly: Pt[] = [[10, 10], [60, 12], [58, 50], [8, 48]];
    const H = [1.05, 0.02, 7, -0.01, 0.98, -3, 0.0004, 0.0002, 1];
    const warped = warpPolygon(poly, H)!;
    expect(warped).not.toBeNull();
    // Inverse by the adjugate (any scalar multiple of the inverse does).
    const [a, b, c, d, e, f, g, h, i] = H;
    const inv = [e * i - f * h, c * h - b * i, b * f - c * e, f * g - d * i, a * i - c * g, c * d - a * f, d * h - e * g, b * g - a * h, a * e - b * d];
    const back = warpPolygon(warped, inv)!;
    back.forEach((p, k) => {
      expect(p[0]).toBeCloseTo(poly[k][0], 5);
      expect(p[1]).toBeCloseTo(poly[k][1], 5);
    });
    expect(warpPolygon(poly, [1, 0, 0, 0, 1, 0, -0.1, 0, 1])).toBeNull();
  });
});

describe("region-math: rasterizing and distance", () => {
  it("covers a whole-pixel rect exactly, a half-pixel edge by half, and an ellipse by about its area", () => {
    const rect = rasterizePolygon(40, 40, regionToPolygon({ kind: "rect", rect: [10, 10, 30, 30] }));
    expect(sum(rect)).toBeCloseTo(400, 6);
    expect(rect[15 * 40 + 15]).toBe(1);
    expect(rect[15 * 40 + 9]).toBe(0);
    const half = rasterizePolygon(40, 40, regionToPolygon({ kind: "rect", rect: [10.5, 10, 30, 30] }));
    expect(half[15 * 40 + 10]).toBeCloseTo(0.5, 6);
    const ell = rasterizePolygon(80, 80, regionToPolygon({ kind: "ellipse", center: [40, 40], radius: [20, 12] }, 96));
    expect(sum(ell)).toBeGreaterThan(Math.PI * 20 * 12 * 0.98);
    expect(sum(ell)).toBeLessThan(Math.PI * 20 * 12 * 1.02);
    // Nothing is drawn for a polygon outside the grid, and a polygon is clipped to it.
    expect(sum(rasterizePolygon(10, 10, regionToPolygon({ kind: "rect", rect: [20, 20, 30, 30] })))).toBe(0);
    expect(sum(rasterizePolygon(10, 10, regionToPolygon({ kind: "rect", rect: [5, 5, 30, 30] })))).toBeCloseTo(25, 6);
  });

  it("feathers the coverage over the given width", () => {
    const f = rasterizePolygon(60, 60, regionToPolygon({ kind: "rect", rect: [20, 20, 40, 40] }), 6);
    expect(f[30 * 60 + 30]).toBe(1);
    expect(f[30 * 60 + 19]).toBeGreaterThan(0);
    expect(f[30 * 60 + 19]).toBeLessThan(0.5);
    expect(f[30 * 60 + 10]).toBe(0);
  });

  it("measures signed distance from the edge: negative inside, 0.5 at the first pixel on either side", () => {
    const mask = rasterizePolygon(40, 40, regionToPolygon({ kind: "rect", rect: [10, 10, 30, 30] }));
    const sd = signedDistance(mask, 40, 40);
    expect(sd[20 * 40 + 10]).toBeCloseTo(-0.5, 6);
    expect(sd[20 * 40 + 9]).toBeCloseTo(0.5, 6);
    expect(sd[20 * 40 + 15]).toBeCloseTo(-5.5, 6);
    expect(sd[20 * 40 + 4]).toBeCloseTo(5.5, 6);
    // Diagonal distance is Euclidean.
    expect(sd[5 * 40 + 5]).toBeCloseTo(Math.hypot(5, 5) - 0.5, 4);
    // No inside pixel at all: everything is far.
    expect(signedDistance(new Float32Array(100), 10, 10)[0]).toBeGreaterThan(1000);
  });

  it("counts ring pixels: a band outside a 20x20 rect, one that straddles the edge, and an empty one", () => {
    const poly = regionToPolygon({ kind: "rect", rect: [40, 40, 60, 60] });
    const ring = ringMask(100, 100, poly, 0, 5);
    // 4 sides of 20x5 plus four quarter discs of radius 5.
    expect(sum(ring)).toBeGreaterThan(478.5 * 0.92);
    expect(sum(ring)).toBeLessThan(478.5 * 1.08);
    expect(ring[50 * 100 + 30]).toBe(0);
    expect(ring[50 * 100 + 50]).toBe(0);
    const straddle = ringMask(100, 100, poly, -3, 3);
    expect(straddle[50 * 100 + 41]).toBe(1);
    expect(straddle[50 * 100 + 38]).toBe(1);
    expect(straddle[50 * 100 + 50]).toBe(0);
    expect(sum(ringMask(100, 100, poly, 10, 12))).toBeGreaterThan(0);
  });
});

describe("region-math: statistics", () => {
  it("measures mean, spread, percentiles, clipping and the visible share under a mask", () => {
    const img = image(10, 10, (x) => (x < 5 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    const st = maskedStats(img, full(10, 10));
    expect(st.pixels).toBe(100);
    expect(st.visible_share).toBe(1);
    expect(st.mean_rgb[0]).toBeCloseTo(0.5, 6);
    expect(st.std_rgb[0]).toBeCloseTo(0.5, 6);
    expect(st.clipped_low).toBeCloseTo(0.5, 6);
    expect(st.clipped_high).toBeCloseTo(0.5, 6);
    expect(st.p05_rgb[0]).toBe(0);
    expect(st.p95_rgb[0]).toBe(1);
    expect(st.luma_mean).toBeCloseTo(0.5, 3);
    // A mask picks pixels; transparent ones lower the visible share.
    const mask = new Float32Array(100);
    for (let y = 0; y < 10; y++) for (let x = 5; x < 10; x++) mask[y * 10 + x] = 1;
    expect(maskedStats(img, mask).mean_rgb[0]).toBe(1);
    const half = image(10, 10, (x) => [100, 100, 100, x < 5 ? 255 : 0]);
    expect(maskedStats(half, full(10, 10)).visible_share).toBeCloseTo(0.5, 6);
    expect(maskedStats(img, new Float32Array(100)).pixels).toBe(0);
    expect(lumaPercentiles(img, full(10, 10)).p50).toBeGreaterThanOrEqual(0);
  });

  it("takes luma in linear light on request", () => {
    const img = image(4, 4, (x) => (x < 2 ? grey(0) : grey(255)));
    const enc = maskedStats(img, full(4, 4)).luma_mean;
    const lin = maskedStats(img, full(4, 4), 0.5, { linear: true }).luma_mean;
    expect(enc).toBeCloseTo(0.5, 3);
    expect(lin).toBeCloseTo(0.5, 3);
    const mid = image(4, 4, () => grey(128));
    expect(maskedStats(mid, full(4, 4), 0.5, { linear: true }).luma_mean).toBeCloseTo(srgbToLinear(128 / 255), 3);
    expect(linearToSrgb(srgbToLinear(0.37))).toBeCloseTo(0.37, 6);
  });

  it("estimates noise sigma within 10% on flat and on ramped images, and is 0 for a clean one or a tiny mask", () => {
    const w = 80;
    const h = 80;
    for (const sigma of [2, 5, 9]) {
      const flat = grayOf(image(w, h, (x, y) => grey(128 + noise(x, y, 7, sigma))));
      const est = noiseSigma(flat, full(w, h));
      expect(est).toBeGreaterThan(sigma * 0.9);
      expect(est).toBeLessThan(sigma * 1.1);
      const ramp = grayOf(image(w, h, (x, y) => grey(60 + x * 1.5 + y * 0.5 + noise(x, y, 11, sigma))));
      const est2 = noiseSigma(ramp, full(w, h));
      expect(est2).toBeGreaterThan(sigma * 0.88);
      expect(est2).toBeLessThan(sigma * 1.12);
    }
    expect(noiseSigma(grayOf(image(w, h, () => grey(100))), full(w, h))).toBe(0);
    expect(noiseSigma(grayOf(image(w, h, (x, y) => grey(128 + noise(x, y, 7, 5)))), new Float32Array(w * h))).toBe(0);
  });

  it("measures temporal noise between aligned frames: sigma for fresh grain, 0 for frozen grain", () => {
    const w = 80;
    const h = 80;
    const a = grayOf(image(w, h, (x, y) => grey(128 + noise(x, y, 1, 4))));
    const b = grayOf(image(w, h, (x, y) => grey(128 + noise(x, y, 2, 4))));
    const est = temporalNoise(a, b, full(w, h));
    expect(est).toBeGreaterThan(3.6);
    expect(est).toBeLessThan(4.4);
    expect(temporalNoise(a, a, full(w, h))).toBe(0);
    // A few pixels that moved do not move the estimate.
    const moved = grayOf(image(w, h, (x, y) => grey(128 + noise(x, y, 2, 4) + (x < 4 ? 80 : 0))));
    expect(temporalNoise(a, moved, full(w, h))).toBeLessThan(4.6);
  });

  it("measures fine detail by Laplacian energy and blurs separably", () => {
    const flat = grayOf(image(20, 20, () => grey(90)));
    const checker = grayOf(image(20, 20, (x, y) => grey((x + y) % 2 ? 200 : 20)));
    expect(laplacianEnergy(flat, full(20, 20))).toBe(0);
    expect(laplacianEnergy(checker, full(20, 20))).toBeGreaterThan(1000);
    const impulse: GrayImage = { width: 21, height: 21, data: new Float32Array(441) };
    impulse.data[10 * 21 + 10] = 100;
    const blurred = gaussianBlurGray(impulse, 2);
    expect(blurred.data.reduce((s, v) => s + v, 0)).toBeCloseTo(100, 3);
    expect(blurred.data[10 * 21 + 10]).toBeLessThan(100);
    expect(blurred.data[10 * 21 + 10]).toBeGreaterThan(blurred.data[10 * 21 + 13]);
    expect(laplacianEnergy(blurred, full(21, 21))).toBeLessThan(laplacianEnergy(impulse, full(21, 21)));
    expect(gaussianBlurGray(impulse, 0).data[10 * 21 + 10]).toBe(100);
  });

  it("crops to bounds with a margin, clipped to the image", () => {
    const img = image(30, 20, (x, y) => [x, y, 0, 255]);
    const c = cropToBounds(img, [10, 5, 20, 12], 2)!;
    expect([c.x0, c.y0, c.img.width, c.img.height]).toEqual([8, 3, 14, 11]);
    expect(c.img.data[0]).toBe(8);
    expect(c.img.data[1]).toBe(3);
    const edge = cropToBounds(img, [-5, -5, 3, 3], 1)!;
    expect([edge.x0, edge.y0]).toEqual([0, 0]);
    expect(cropToBounds(img, [100, 100, 110, 110], 2)).toBeNull();
  });
});

describe("region-math: colour fit, seams and features", () => {
  it("recovers a gain and offset per channel, trims outliers and leaves out clipped pixels", () => {
    const w = 30;
    const h = 30;
    const src = image(w, h, (x, y) => [40 + x * 4, 50 + y * 4, 60 + ((x + y) % 10) * 8, 255]);
    const ref = image(w, h, (x, y) => {
      const i = (y * w + x) * 4;
      return [src.data[i] * 1.2 + 10, src.data[i + 1] * 0.9 - 5, src.data[i + 2] + 15, 255].map((v) => Math.round(v)) as Px;
    });
    const fit = fitGainOffset(ref, src, full(w, h), { trimPct: 0, excludeClipped: false });
    expect(fit.gain[0]).toBeCloseTo(1.2, 2);
    expect(fit.gain[1]).toBeCloseTo(0.9, 2);
    expect(fit.gain[2]).toBeCloseTo(1, 2);
    expect(fit.offset[0]).toBeCloseTo(10 / 255, 2);
    expect(fit.offset[1]).toBeCloseTo(-5 / 255, 2);
    expect(fit.rms).toBeLessThan(0.01);
    expect(fit.pixels).toBe(900);
    // Outliers: a corner of the reference is wrong; trimming ignores it.
    const bad = image(w, h, (x, y) => (x < 4 && y < 4 ? [255, 0, 255, 255] : ([ref.data[(y * w + x) * 4], ref.data[(y * w + x) * 4 + 1], ref.data[(y * w + x) * 4 + 2], 255] as Px)));
    const raw = fitGainOffset(bad, src, full(w, h), { trimPct: 0, excludeClipped: false });
    const trimmed = fitGainOffset(bad, src, full(w, h), { trimPct: 5, excludeClipped: false });
    expect(Math.abs(trimmed.gain[0] - 1.2)).toBeLessThan(Math.abs(raw.gain[0] - 1.2));
    // Clipped pixels are excluded.
    const clipped = image(w, h, (x) => (x < 5 ? [255, 255, 255, 255] : [100, 100, 100, 255]));
    expect(fitGainOffset(clipped, clipped, full(w, h), { trimPct: 0, excludeClipped: true }).pixels).toBe(25 * h);
    // Flat input: gain 1 and the mean difference.
    const flat = fitGainOffset(image(10, 10, () => grey(150)), image(10, 10, () => grey(100)), full(10, 10), { trimPct: 0, excludeClipped: false });
    expect(flat.gain[0]).toBe(1);
    expect(flat.offset[0]).toBeCloseTo(50 / 255, 3);
    expect(fitGainOffset(ref, src, new Float32Array(w * h), { trimPct: 0, excludeClipped: false }).pixels).toBe(0);
  });

  const W = 120;
  const H = 120;
  const tex = (x: number, y: number) => 70 + 60 * lattice(x, y, 8, 5);
  const SEAM_POLY = regionToPolygon({ kind: "rect", rect: [40, 40, 80, 80] });

  it("scores a clean noisy plate near 1 and a level step across the outline above 1.5, and finds the worst stretch", () => {
    const clean = grayOf(image(W, H, (x, y) => grey(tex(x, y) + noise(x, y, 3, 2.5))));
    const a = seamScore(clean, SEAM_POLY, 12);
    expect(a.chunks).toBeGreaterThan(3);
    expect(a.score).toBeGreaterThan(0.6);
    expect(a.score).toBeLessThan(1.4);
    const stepped = grayOf(image(W, H, (x, y) => grey(tex(x, y) + noise(x, y, 3, 2.5) + (x >= 40 && x < 80 && y >= 40 && y < 80 ? 25 : 0))));
    const b = seamScore(stepped, SEAM_POLY, 12);
    expect(b.score).toBeGreaterThan(1.5);
    expect(b.worst_segment).not.toBeNull();
    // Only the bottom edge has a step: the worst stretch lies on it.
    const bottom = grayOf(image(W, H, (x, y) => grey(tex(x, y) + noise(x, y, 3, 2.5) + (y >= 78 && x >= 40 && x < 80 && y < 80 ? 35 : 0))));
    const c = seamScore(bottom, SEAM_POLY, 12);
    expect(c.worst_segment!.from[1]).toBeGreaterThan(70);
    expect(seamScore(clean, [[1, 1], [2, 2]], 12)).toMatchObject({ score: 0, chunks: 0 });
    // The winding of the polygon does not change the answer.
    const reversed = seamScore(stepped, [...SEAM_POLY].reverse(), 12);
    expect(reversed.score).toBeGreaterThan(1.5);
  });

  it("picks trackable features inside the mask and none on a flat area", () => {
    const img = grayOf(image(W, H, (x, y) => grey(tex(x, y) + (((x >> 4) + (y >> 4)) % 2) * 40)));
    const mask = new Float32Array(W * H);
    for (let y = 30; y < 90; y++) for (let x = 30; x < 90; x++) mask[y * W + x] = 1;
    const feats = goodFeatures(img, mask, { count: 6, minDistancePx: 12, patchSize: 15 });
    expect(feats.length).toBeGreaterThanOrEqual(3);
    for (const f of feats) {
      expect(f.x).toBeGreaterThanOrEqual(30);
      expect(f.x).toBeLessThan(90);
      expect(f.y).toBeGreaterThanOrEqual(30);
    }
    for (let i = 0; i < feats.length; i++) for (let j = i + 1; j < feats.length; j++) expect(Math.hypot(feats[i].x - feats[j].x, feats[i].y - feats[j].y)).toBeGreaterThanOrEqual(12);
    expect(feats[0].score).toBeGreaterThanOrEqual(feats[feats.length - 1].score);
    expect(goodFeatures(grayOf(image(W, H, () => grey(100))), mask, { count: 6, minDistancePx: 12, patchSize: 15 })).toEqual([]);
  });
});

// ---------- sampling, region over time, series ----------

describe("planSamples", () => {
  const base = { fps: 25, duration: 10, workStart: 0, workDuration: 10, maxSamples: 24 };

  it("samples the first, the reference, the last and every Nth frame within the cap, on the frame grid", () => {
    const p = planSamples({ ...base, refTime: 3.33 });
    expect(p.total_frames).toBe(250);
    expect(p.times[0]).toBe(0);
    expect(p.times[p.times.length - 1]).toBeCloseTo(249 / 25, 9);
    expect(p.times.length).toBeLessThanOrEqual(24);
    expect(p.times).toContain(Math.round(3.33 * 25) / 25);
    expect(p.ref_time).toBeCloseTo(Math.round(3.33 * 25) / 25, 9);
    expect(p.every_n).toBeGreaterThan(1);
    for (const t of p.times) expect(Math.abs(t * 25 - Math.round(t * 25))).toBeLessThan(1e-6);
    expect([...p.times].sort((a, b) => a - b)).toEqual(p.times);
  });

  it("samples every frame of a short range, honours every_n and a range, and widens the step to fit the cap", () => {
    const short = planSamples({ ...base, duration: 0.4, workDuration: 0.4 });
    expect(short.times).toHaveLength(10);
    expect(short.every_n).toBe(1);
    const stepped = planSamples({ ...base, everyN: 10, start: 2, end: 4 });
    expect(stepped.times[0]).toBe(2);
    expect(stepped.times[stepped.times.length - 1]).toBeCloseTo(4, 9);
    expect(stepped.total_frames).toBe(51);
    const capped = planSamples({ ...base, everyN: 1, maxSamples: 10 });
    expect(capped.times.length).toBeLessThanOrEqual(10);
    expect(capped.capped).toBe(true);
    expect(capped.every_n).toBeGreaterThan(1);
  });

  it("uses the work area by default and clamps times past the end", () => {
    const wa = planSamples({ ...base, workStart: 2, workDuration: 1 });
    expect(wa.times[0]).toBe(2);
    expect(wa.times[wa.times.length - 1]).toBeCloseTo(2.96, 9);
    const t = planSamples({ ...base, times: [0.48, 0.48, 99, 0] });
    expect(t.times).toEqual([0, 0.48, 249 / 25]);
    expect(t.every_n).toBe(0);
  });
});

describe("the region over time", () => {
  const track = [
    { time: 0, homography: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
    { time: 2, homography: [1, 0, 20, 0, 1, 10, 0, 0, 1] },
  ];

  it("interpolates the homography between entries and holds the nearest outside them", () => {
    expect(homographyAt(track, 1)).toEqual([1, 0, 10, 0, 1, 5, 0, 0, 1]);
    expect(homographyAt(track, -1)).toEqual(track[0].homography);
    expect(homographyAt(track, 9)).toEqual(track[1].homography);
    // Entries are normalised so the last element is 1.
    expect(homographyAt([{ time: 0, homography: [2, 0, 0, 0, 2, 0, 0, 0, 2] }], 0)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it("places the region per time, unchanged without a track and null behind the horizon", () => {
    const rect = { kind: "rect" as const, rect: [10, 10, 30, 20] as [number, number, number, number] };
    expect(polygonAt(rect, undefined, 1)![0]).toEqual([10, 10]);
    expect(polygonAt(rect, track, 1)![0]).toEqual([20, 15]);
    expect(polygonAt(rect, [{ time: 0, homography: [1, 0, 0, 0, 1, 0, -0.1, 0, 1] }], 0)).toBeNull();
  });

  it("takes the footprint of one patch layer, the bounding box of several, and explains a missing one", () => {
    const layer = (id: number, polygon: Pt[] | null, visible = true, reason: string | null = null): HostLayer => ({
      index: id, id, name: `L${id}`, kind: "AVLayer", enabled: true, locked: false, guide: false, three_d: false, in_point: 0, out_point: 5, parent_id: null,
      footprints: [{ time: 0, visible, polygon, reason }],
    });
    const quad = (x0: number, y0: number, x1: number, y1: number): Pt[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    expect(footprintPolygon([layer(1, quad(0, 0, 10, 10))], 0).polygon).toEqual(quad(0, 0, 10, 10));
    expect(footprintPolygon([layer(1, quad(0, 0, 10, 10)), layer(2, quad(20, 5, 30, 40))], 0).polygon).toEqual(quad(0, 0, 30, 40));
    const none = footprintPolygon([layer(1, null, false, "the layer's opacity is 0")], 0);
    expect(none.polygon).toBeNull();
    expect(none.reason).toContain("opacity");
  });

  it("refuses to guess a region when a visible patch layer has no outline, whatever the other layers show", () => {
    const layer = (id: number, polygon: Pt[] | null, visible = true, reason: string | null = null): HostLayer => ({
      index: id, id, name: `L${id}`, kind: "AVLayer", enabled: true, locked: false, guide: false, three_d: false, in_point: 0, out_point: 5, parent_id: null,
      footprints: [{ time: 0, visible, polygon, reason }],
    });
    const quad = (x0: number, y0: number, x1: number, y1: number): Pt[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    const tile = layer(1, null, true, "the layer has a Motion Tile effect that moves or warps it: give region");
    const alone = footprintPolygon([tile], 0);
    expect(alone.polygon).toBeNull();
    expect(alone.reason).toContain("Motion Tile");
    for (const layers of [[tile, layer(2, quad(0, 0, 10, 10))], [layer(2, quad(0, 0, 10, 10)), tile]]) {
      const both = footprintPolygon(layers, 0);
      expect(both.polygon).toBeNull();
      expect(both.reason).toContain("Motion Tile");
    }
    // A layer that is simply not showing at this time is skipped.
    const off = footprintPolygon([layer(1, null, false, "the layer's opacity is 0"), layer(2, quad(0, 0, 10, 10))], 0);
    expect(off.polygon).toEqual(quad(0, 0, 10, 10));
  });

  it("follows a negative mask expansion (a choke) and gives up on one bigger than the mask", () => {
    const layer = (expand: number): HostLayer => ({
      index: 1, id: 1, name: "P", kind: "AVLayer", enabled: true, locked: false, guide: false, three_d: false, in_point: 0, out_point: 4, parent_id: null,
      footprints: [{ time: 0, visible: true, polygon: [[0, 0], [200, 0], [200, 130], [0, 130]], mask_polygon: [[60, 25], [140, 25], [140, 105], [60, 105]], mask_expand_px: expand, reason: null }],
    });
    expect(polygonBounds(footprintPolygon([layer(-5)], 0).polygon!)).toEqual([65, 30, 135, 100]);
    const gone = footprintPolygon([layer(-60)], 0);
    expect(gone.polygon).toBeNull();
    expect(gone.reason).toContain("chokes");
    expect(gone.reason).toContain("P: ");
  });

  it("catches a choke that turns a rotated or diagonal mask inside out, which a bounding box test lets through", () => {
    const layer = (id: number, mask: Pt[], expand: number): HostLayer => ({
      index: id, id, name: `M${id}`, kind: "AVLayer", enabled: true, locked: false, guide: false, three_d: false, in_point: 0, out_point: 4, parent_id: null,
      footprints: [{ time: 0, visible: true, polygon: [[0, 0], [400, 0], [400, 400], [0, 400]], mask_polygon: mask, mask_expand_px: expand, reason: null }],
    });
    // A 100x100 square turned 45 degrees (half width 50): -60 and -65 invert it (a point reflection keeps the winding).
    const diamond: Pt[] = [[50, 0], [100, 50], [50, 100], [0, 50]];
    expect(footprintPolygon([layer(1, diamond, -20)], 0).polygon).not.toBeNull();
    for (const d of [-60, -65]) {
      const gone = footprintPolygon([layer(1, diamond, d)], 0);
      expect(gone.polygon).toBeNull();
      expect(gone.reason).toContain("chokes");
    }
    // A 200x4 sliver on the diagonal (half width 2): -3 flips it, and the signed area alone does not say so.
    const k = Math.SQRT1_2;
    const along: Pt = [200 * k, 200 * k];
    const across: Pt = [-2 * k, 2 * k];
    const sliver: Pt[] = [[0, 0], [along[0], along[1]], [along[0] + 2 * across[0], along[1] + 2 * across[1]], [2 * across[0], 2 * across[1]]];
    expect(footprintPolygon([layer(1, sliver, -1)], 0).polygon).not.toBeNull();
    expect(footprintPolygon([layer(1, sliver, -3)], 0).polygon).toBeNull();
  });

  it("skips a layer whose mask is choked to nothing, like one that is not showing, and keeps the others", () => {
    const quad = (x0: number, y0: number, x1: number, y1: number): Pt[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    const choked: HostLayer = {
      index: 1, id: 1, name: "Gone", kind: "AVLayer", enabled: true, locked: false, guide: false, three_d: false, in_point: 0, out_point: 4, parent_id: null,
      footprints: [{ time: 0, visible: true, polygon: quad(0, 0, 400, 400), mask_polygon: quad(10, 10, 50, 50), mask_expand_px: -30, mask_feather_px: 9, reason: null }],
    };
    const plain: HostLayer = {
      index: 2, id: 2, name: "Stays", kind: "AVLayer", enabled: true, locked: false, guide: false, three_d: false, in_point: 0, out_point: 4, parent_id: null,
      footprints: [{ time: 0, visible: true, polygon: quad(100, 100, 160, 140), reason: null }],
    };
    const both = footprintPolygon([choked, plain], 0);
    expect(both.polygon).toEqual(quad(100, 100, 160, 140));
    // The skipped layer's feather does not widen the ring gap.
    expect(both.feather_px).toBe(0);
    // Alone it leaves nothing, and the reason names the layer.
    const alone = footprintPolygon([choked], 0);
    expect(alone.polygon).toBeNull();
    expect(alone.reason).toContain("Gone: ");
  });

  it("does not take a swallowtail at a tight corner of a finely sampled mask for a collapse", () => {
    // A 200x120 rounded rectangle with a 6 px corner radius, sampled every ~1.5 px on the arcs, choked 10 px: the corners' short edges
    // reverse, but there is plenty of mask left.
    const pts: Pt[] = [];
    const r = 6;
    const corner = (cx: number, cy: number, a0: number) => {
      for (let i = 0; i <= 6; i++) {
        const a = a0 + (i / 6) * (Math.PI / 2);
        pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
      }
    };
    corner(194, 114, 0);
    corner(6, 114, Math.PI / 2);
    corner(6, 6, Math.PI);
    corner(194, 6, 1.5 * Math.PI);
    const layer: HostLayer = {
      index: 1, id: 1, name: "R", kind: "AVLayer", enabled: true, locked: false, guide: false, three_d: false, in_point: 0, out_point: 4, parent_id: null,
      footprints: [{ time: 0, visible: true, polygon: [[0, 0], [400, 0], [400, 400], [0, 400]], mask_polygon: pts, mask_expand_px: -10, reason: null }],
    };
    expect(footprintPolygon([layer], 0).polygon).not.toBeNull();
  });
});

describe("seriesStats", () => {
  const times = Array.from({ length: 12 }, (_, i) => i / 25);

  it("finds drift and flicker of a series and no pops in a smooth one", () => {
    const ramp = times.map((t) => 0.2 + 0.5 * t);
    const s = seriesStats(times, ramp, { fps: 25, popFactor: 3 });
    expect(s.slope_per_s).toBeCloseTo(0.5, 6);
    expect(s.total_drift).toBeCloseTo(0.5 * times[times.length - 1], 6);
    expect(s.flicker).toBeCloseTo(0, 6);
    expect(s.pops).toEqual([]);
    const flicker = times.map((_, i) => 0.3 + (i % 2 ? 0.02 : -0.02));
    expect(seriesStats(times, flicker, { fps: 25, popFactor: 3 }).flicker).toBeCloseTo(0.02, 2);
  });

  it("calls a jump between neighbouring samples a pop and the same jump over a long gap a step", () => {
    const ring = times.map((_, i) => 0.4 + (i % 2 ? 0.001 : -0.001));
    const v = times.map((_, i) => 0.1 + (i >= 6 ? 0.08 : 0) + (i % 2 ? 0.001 : -0.001));
    const s = seriesStats(times, v, { fps: 25, popFactor: 3, jitterFrom: ring });
    expect(s.pops).toHaveLength(1);
    expect(s.pops[0]).toMatchObject({ from_time: 0.2, to_time: 0.24, gap_frames: 1 });
    expect(s.pops[0].jump).toBeGreaterThan(0.05);
    // The same series sampled every 10 frames: a step, not a pop.
    const sparse = times.map((_, i) => i * 0.4);
    const t = seriesStats(sparse, v, { fps: 25, popFactor: 3, jitterFrom: ring });
    expect(t.pops).toEqual([]);
    expect(t.steps.length).toBeGreaterThan(0);
    // The jump must also clear the floor, so a flat series is not all pops.
    expect(seriesStats(times, times.map(() => 0.5), { fps: 25, popFactor: 3 }).pops).toEqual([]);
    expect(seriesStats([0], [1], { fps: 25, popFactor: 3 })).toMatchObject({ n: 1, pops: [] });
  });
});

// ---------- one frame ----------

const FOPTS: FrameOptions = { ringPx: 12, gapPx: 2, leakThreshold: 0.03, leakMarginPx: 3, linear: false };
const COMP = { width: 200, height: 130 };
const REGION = regionToPolygon({ kind: "rect", rect: [60, 25, 140, 105] });
/** Smooth value noise on a lattice, 0..1: a texture without a regular phase, like footage. */
function lattice(x: number, y: number, cell: number, seed: number): number {
  const gx = Math.floor(x / cell);
  const gy = Math.floor(y / cell);
  const sm = (t: number) => t * t * (3 - 2 * t);
  const u = sm(x / cell - gx);
  const w = sm(y / cell - gy);
  const a = hash01(gx, gy, seed);
  const b = hash01(gx + 1, gy, seed);
  const c = hash01(gx, gy + 1, seed);
  const d = hash01(gx + 1, gy + 1, seed);
  return (a * (1 - u) + b * u) * (1 - w) + (c * (1 - u) + d * u) * w;
}
const texA = (x: number, y: number) => 70 + 60 * lattice(x, y, 8, 42);
const inRegion = (x: number, y: number) => x >= 60 && x < 140 && y >= 25 && y < 105;

interface SceneOpts {
  /** Patch brightness offset over the plate. */
  delta?: number;
  /** The patch's grain does not change from frame to frame. */
  frozen?: boolean;
  /** Extra pixels outside the region changed by the patch. */
  leak?: boolean;
  /** The patch is a flat fill. */
  flat?: boolean;
  /** The patch shows exactly the plate. */
  same?: boolean;
  /** Patch texture shifted by this many pixels in x (slip). */
  shift?: number;
  sigma?: number;
  /** A softer patch: its texture is blurred by averaging. */
  soft?: boolean;
}

/** The plate (patch off) at a time. */
function plateImage(time: number, o: SceneOpts = {}) {
  const seed = Math.round(time * 100) + 1;
  const s = o.sigma ?? 2.5;
  return image(COMP.width, COMP.height, (x, y) => grey(texA(x, y) + noise(x, y, seed, s)));
}

/** The composite (patch on) at a time. */
function compositeImage(time: number, o: SceneOpts = {}) {
  const seed = Math.round(time * 100) + 1;
  const s = o.sigma ?? 2.5;
  return image(COMP.width, COMP.height, (x, y) => {
    if (inRegion(x, y)) {
      if (o.same) return grey(texA(x, y) + noise(x, y, seed, s));
      const grainSeed = o.frozen ? 5 : seed + 777;
      if (o.flat) return grey(120 + (o.delta ?? 0) + noise(x, y, grainSeed, s));
      let t = texA(x - (o.shift ?? 0), y);
      if (o.soft) t = (texA(x - 2, y) + texA(x + 2, y) + texA(x, y - 2) + texA(x, y + 2)) / 4;
      return grey(t + (o.delta ?? 0) + noise(x, y, grainSeed, o.soft ? s * 0.2 : s));
    }
    if (o.leak && x >= 140 && x < 148 && y >= 25 && y < 105) return grey(texA(x, y) + 40 + noise(x, y, seed, s));
    return grey(texA(x, y) + noise(x, y, seed, s));
  });
}

describe("analyseFrame", () => {
  const measure = (o: SceneOpts, neighbour = false, t = 0.4) =>
    analyseFrame({
      time: t,
      composite: compositeImage(t, o),
      plate: plateImage(t, o),
      neighbour: neighbour ? compositeImage(t + 0.04, o) : null,
      polyComp: REGION,
      comp: COMP,
      opts: FOPTS,
    });

  it("measures a clean patch: the difference stays inside, the seam is invisible, level and detail match the ring", () => {
    const m = measure({ delta: 0 });
    expect(m.usable).toBe(true);
    expect(m.region).toMatchObject({ area_px: 6400, frame_share: 1 });
    expect(m.difference!.leaked_pixels).toBe(0);
    expect(m.difference!.inside_mean).toBeGreaterThan(0.002);
    expect(m.difference!.outside_mean).toBe(0);
    expect(m.difference!.leak_bbox).toBeNull();
    expect(m.seam!.score).toBeLessThan(1.4);
    expect(Math.abs(m.delta_luma!)).toBeLessThan(0.03);
    expect(m.sharpness!.ratio).toBeGreaterThan(0.6);
    expect(m.sharpness!.ratio).toBeLessThan(1.6);
    expect(m.noise!.patch_sigma).toBeGreaterThan(1.5);
  });

  it("reports a level step as a seam and a brightness offset, and a spill outside the region with its bounding box", () => {
    const step = measure({ delta: 18 });
    expect(step.seam!.score).toBeGreaterThan(1.5);
    expect(step.delta_luma!).toBeGreaterThan(0.05);
    expect(step.delta_rgb![0]).toBeGreaterThan(0.05);
    const leaky = measure({ delta: 0, leak: true });
    expect(leaky.difference!.leaked_pixels).toBeGreaterThan(100);
    const box = leaky.difference!.leak_bbox!;
    expect(box[0]).toBeGreaterThanOrEqual(143);
    expect(box[2]).toBeLessThanOrEqual(149);
    expect(box[1]).toBeGreaterThanOrEqual(25);
    expect(box[3]).toBeLessThanOrEqual(105);
    // The three-pixel margin keeps a feathered edge from counting.
    expect(measure({ delta: 0 }).difference!.leaked_pixels).toBe(0);
  });

  it("sees a patch that changes nothing, and a soft patch", () => {
    expect(measure({ same: true }).difference!.inside_mean).toBe(0);
    const soft = measure({ delta: 0, soft: true });
    expect(soft.sharpness!.ratio!).toBeLessThan(0.6);
  });

  it("tells frozen grain from moving grain with a neighbouring frame, and gives no verdict where the ring itself has no grain or moves", () => {
    const live = measure({ delta: 0 }, true);
    expect(live.grain).toMatchObject({ valid: true });
    expect(live.grain!.ratio).toBeGreaterThan(0.7);
    const frozen = measure({ delta: 0, frozen: true }, true);
    expect(frozen.grain!.valid).toBe(true);
    expect(frozen.grain!.ratio).toBeLessThan(0.3);
    const clean = analyseFrame({ time: 0, composite: compositeImage(0, { sigma: 0.01 }), plate: plateImage(0, { sigma: 0.01 }), neighbour: compositeImage(0.04, { sigma: 0.01 }), polyComp: REGION, comp: COMP, opts: FOPTS });
    expect(clean.grain).toMatchObject({ valid: false });
    expect(clean.grain!.reason).toContain("no grain");
    // A ring that moved between the frames is not grain.
    const moved = analyseFrame({
      time: 0,
      composite: compositeImage(0),
      plate: plateImage(0),
      neighbour: image(COMP.width, COMP.height, (x, y) => grey(texA(x - 9, y) + noise(x, y, 99, 2.5))),
      polyComp: REGION,
      comp: COMP,
      opts: FOPTS,
    });
    expect(moved.grain!.valid).toBe(false);
  });

  it("scales a polygon to a lower-resolution render and refuses what it cannot measure", () => {
    const half = (img: ReturnType<typeof image>) => image(100, 65, (x, y) => [img.data[((y * 2) * img.width + x * 2) * 4], img.data[((y * 2) * img.width + x * 2) * 4 + 1], img.data[((y * 2) * img.width + x * 2) * 4 + 2], 255]);
    const m = analyseFrame({ time: 0, composite: half(compositeImage(0, { delta: 0, leak: true })), plate: half(plateImage(0)), polyComp: REGION, comp: COMP, opts: FOPTS });
    expect(m.usable).toBe(true);
    expect(m.region!.area_px).toBe(6400);
    expect(m.difference!.leak_bbox![0]).toBeGreaterThan(130);
    const mismatch = analyseFrame({ time: 0, composite: compositeImage(0), plate: image(10, 10, () => grey(0)), polyComp: REGION, comp: COMP, opts: FOPTS });
    expect(mismatch).toMatchObject({ usable: false });
    expect(mismatch.reason).toContain("differ in size");
    const off = analyseFrame({ time: 0, composite: compositeImage(0), plate: plateImage(0), polyComp: regionToPolygon({ kind: "rect", rect: [300, 300, 340, 340] }), comp: COMP, opts: FOPTS });
    expect(off.usable).toBe(false);
    const tiny = analyseFrame({ time: 0, composite: compositeImage(0), plate: plateImage(0), polyComp: regionToPolygon({ kind: "rect", rect: [10, 10, 11, 11] }), comp: COMP, opts: FOPTS });
    expect(tiny.reason).toContain("smaller than 4");
    const partly = analyseFrame({ time: 0, composite: compositeImage(0), plate: plateImage(0), polyComp: regionToPolygon({ kind: "rect", rect: [150, 60, 260, 100] }), comp: COMP, opts: FOPTS });
    expect(partly.usable).toBe(true);
    expect(partly.region!.frame_share).toBeLessThan(0.6);
    const sliver = analyseFrame({ time: 0, composite: compositeImage(0), plate: plateImage(0), polyComp: regionToPolygon({ kind: "rect", rect: [199, 60, 400, 100] }), comp: COMP, opts: FOPTS });
    expect(sliver.usable).toBe(false);
  });
});

// ---------- slip ----------

describe("measureSlip", () => {
  const crop = (c: ReturnType<typeof image>) => grayOf(c);
  const frames = (shifts: number[], o: SceneOpts = {}) =>
    shifts.map((s, i) => {
      const t = i * 0.04;
      return { time: t, composite: crop(compositeImage(t, { ...o, shift: s, delta: 0 })), plate: crop(plateImage(t)) };
    });
  const opts = { patchSize: 15, searchPx: 12, features: 8, scale: 1, gapPx: 2, ringPx: 12 };

  it("reads the patch drifting against the plate in comp pixels and the largest slip", () => {
    const r = measureSlip(frames([0, 1, 2, 3]), REGION, opts);
    expect(r.status).toBe("ok");
    expect(r.patch_features).toBeGreaterThanOrEqual(3);
    expect(r.ring_features).toBeGreaterThanOrEqual(3);
    expect(r.series).toHaveLength(3);
    expect(r.max_slip_px!).toBeGreaterThan(2);
    expect(r.max_slip_px!).toBeLessThan(4);
    expect(r.series[0].slip_px!).toBeGreaterThan(0.6);
    expect(r.series[2].slip_px!).toBeGreaterThan(r.series[0].slip_px!);
  });

  it("measures 0 for a patch that stays on the plate, and divides by the image scale", () => {
    const still = measureSlip(frames([0, 0, 0]), REGION, opts);
    expect(still.status).toBe("ok");
    expect(still.max_slip_px!).toBeLessThan(0.5);
    const scaled = measureSlip(frames([0, 2, 4]), REGION, { ...opts, scale: 2 });
    expect(scaled.max_slip_px!).toBeGreaterThan(1.6);
    expect(scaled.max_slip_px!).toBeLessThan(2.4);
  });

  it("says not measurable for a flat patch, too few frames and an empty ring, never 0", () => {
    const flat = measureSlip(frames([0, 0, 0], { flat: true }), REGION, opts);
    expect(flat.status).toBe("not_measurable");
    expect(flat.reason).toContain("no texture");
    expect(flat.max_slip_px).toBeNull();
    expect(measureSlip(frames([0]), REGION, opts)).toMatchObject({ status: "not_measurable" });
    const lone = measureSlip(frames([0, 0]), regionToPolygon({ kind: "rect", rect: [0, 0, 200, 130] }), opts);
    expect(lone.status).toBe("not_measurable");
    expect(lone.reason).toContain("ring");
  });

  it("reports frames where the features were lost", () => {
    // The patch turns into a flat fill after the first frame: its features are gone, so every later row is null (never a number) and the reason says they were lost.
    const gone = [0, 0.04, 0.08].map((t, i) => ({ time: t, composite: crop(compositeImage(t, { delta: 0, flat: i > 0 })), plate: crop(plateImage(t)) }));
    const r = measureSlip(gone, REGION, { ...opts, searchPx: 4 });
    expect(r.status).toBe("not_measurable");
    expect(r.reason).toContain("lost");
    expect(r.max_slip_px).toBeNull();
    expect(r.series).toHaveLength(2);
    for (const row of r.series) {
      expect(row.slip_px).toBeNull();
      expect(row.patch_live).toBe(0);
    }
    // A 40 px jump of the patch texture with a 4 px search never reports a slip beyond the search.
    const far = measureSlip(frames([0, 40, 40]), REGION, { ...opts, searchPx: 4 });
    for (const row of far.series) expect(row.slip_px === null || row.slip_px <= 4 * 1.5).toBe(true);
  });
});

// ---------- the verdicts ----------

const THRESH: Thresholds = {
  seam_max: 1.5,
  pop_factor: 3,
  frozen_ratio: 0.5,
  slip_px: 0.5,
  leak_threshold: 0.03,
  leak_min_pixels: 16,
  drift_max: 0.02,
  flicker_max: 0.008,
  sharpness_min: 0.6,
  sharpness_max: 1.6,
};

function metrics(time: number, o: { delta?: number; ring?: number; leaked?: number; seam?: number; inside?: number; sharp?: number | null; grain?: { ratio: number | null; valid: boolean; reason?: string } } = {}): FrameMetrics {
  const ring = o.ring ?? 0.4;
  return {
    time,
    usable: true,
    region: { bounds: [0, 0, 10, 10], area_px: 100, frame_share: 1 },
    difference: { inside_mean: o.inside ?? 0.02, inside_max: 0.1, outside_mean: 0, outside_pixels: 10000, leaked_pixels: o.leaked ?? 0, leaked_share: 0, leak_bbox: o.leaked ? [1, 2, 3, 4] : null },
    seam: { score: o.seam ?? 1, worst_segment: { from: [0, 0], to: [5, 0], score: o.seam ?? 1 }, chunks: 4 },
    patch: { luma: ring + (o.delta ?? 0), rgb: [0.4, 0.4, 0.4], pixels: 500 },
    ring: { luma: ring, rgb: [0.4, 0.4, 0.4], pixels: 500 },
    delta_luma: o.delta ?? 0,
    delta_rgb: [0, 0, 0],
    sharpness: { patch: 1, ring: 1, ratio: o.sharp === undefined ? 1 : o.sharp },
    noise: { patch_sigma: 2, ring_sigma: 2 },
    ...(o.grain ? { grain: { patch_tn: 1, ring_tn: 2, ...o.grain } } : {}),
  };
}

const okSlip: SlipResult = { status: "ok", patch_features: 6, ring_features: 6, start_time: 0, series: [{ time: 0.04, slip_px: 0.1, patch_live: 6, ring_live: 6 }], max_slip_px: 0.1 };
const checkOf = (j: ReturnType<typeof judgePatch>, name: string) => j.checks.find((c) => c.check === name)!;
const judge = (frames: FrameMetrics[], slip: SlipResult | null = okSlip, grain = true) => judgePatch(frames, slip, { thresholds: THRESH, fps: 25, grainRequested: grain });

describe("judgePatch", () => {
  const steady = (n: number, f: (i: number) => Parameters<typeof metrics>[1] = () => ({})) => Array.from({ length: n }, (_, i) => metrics(i * 0.04, { ring: 0.4 + (i % 2 ? 0.0005 : -0.0005), ...f(i) }));

  it("passes a clean patch with every check ok", () => {
    const j = judge(steady(8, () => ({ grain: { ratio: 0.95, valid: true } })));
    expect(j.verdict).toBe("ok");
    for (const c of j.checks) expect(["ok", "not_measurable"]).toContain(c.verdict);
    expect(checkOf(j, "slip").verdict).toBe("ok");
    expect(checkOf(j, "frozen_grain").verdict).toBe("ok");
    expect(j.worst_frames.every((w) => w.score < 1)).toBe(true);
  });

  it("flags leakage with a bounding box and the tool that fixes it, warn for a few pixels and fail for many", () => {
    const warn = judge(steady(6, (i) => ({ leaked: i === 2 ? 20 : 0 })));
    expect(checkOf(warn, "leakage")).toMatchObject({ verdict: "warn" });
    const fail = judge(steady(6, (i) => ({ leaked: i === 2 ? 400 : 0 })));
    const c = checkOf(fail, "leakage");
    expect(c.verdict).toBe("fail");
    expect(c.summary).toContain("[1,2,3,4]");
    expect(c.fixes[0].tool).toBe("ae_patch_finish");
    expect(c.worst_times[0]).toBeCloseTo(0.08, 6);
    expect(fail.verdict).toBe("fail");
    expect(fail.worst_frames[0].time).toBeCloseTo(0.08, 6);
    expect(fail.worst_frames[0].reasons.join(" ")).toContain("400 pixels");
    expect(checkOf(judge(steady(6, () => ({ leaked: 5 }))), "leakage").verdict).toBe("ok");
  });

  it("flags a patch that changes nothing", () => {
    expect(checkOf(judge(steady(5, () => ({ inside: 0 }))), "effect").verdict).toBe("fail");
    expect(checkOf(judge(steady(5, (i) => ({ inside: i === 1 ? 0 : 0.02 }))), "effect").verdict).toBe("warn");
  });

  it("flags a seam above the limit (warn) and above twice the limit (fail)", () => {
    expect(checkOf(judge(steady(5, (i) => ({ seam: i === 3 ? 2 : 1 }))), "seam").verdict).toBe("warn");
    const j = judge(steady(5, (i) => ({ seam: i === 3 ? 3.5 : 1 })));
    expect(checkOf(j, "seam").verdict).toBe("fail");
    expect(checkOf(j, "seam").fixes.map((f) => f.tool)).toEqual(["ae_patch_finish", "ae_patch_color_match"]);
  });

  it("flags a pop, a drift and a flicker of patch-minus-ring brightness, each with ae_patch_color_match", () => {
    const pop = judge(steady(10, (i) => ({ delta: i >= 5 ? 0.06 : 0 })));
    expect(checkOf(pop, "pops").verdict).not.toBe("ok");
    expect(checkOf(pop, "pops").fixes[0].tool).toBe("ae_patch_color_match");
    expect(checkOf(pop, "pops").worst_times[0]).toBeCloseTo(0.2, 6);
    const drift = judge(steady(10, (i) => ({ delta: i * 0.01 })));
    expect(checkOf(drift, "drift").verdict).not.toBe("ok");
    expect(checkOf(drift, "drift").summary).toContain("brighter");
    const flicker = judge(steady(10, (i) => ({ delta: i % 2 ? 0.03 : -0.03 })));
    expect(checkOf(flicker, "flicker").verdict).toBe("fail");
    const calm = judge(steady(10));
    expect(checkOf(calm, "flicker").verdict).toBe("ok");
    expect(checkOf(calm, "drift").verdict).toBe("ok");
  });

  it("needs enough frames for flicker and drift, but still finds pops from two", () => {
    const two = judge([metrics(0), metrics(0.04, { delta: 0.1 })]);
    expect(checkOf(two, "flicker").verdict).toBe("not_measurable");
    expect(checkOf(two, "drift").verdict).toBe("not_measurable");
    expect(checkOf(two, "pops").verdict).not.toBe("ok");
    expect(checkOf(judge([metrics(0)]), "pops").verdict).toBe("not_measurable");
  });

  it("judges frozen grain from valid probes and explains one that is not measurable", () => {
    const frozen = judge(steady(6, (i) => ({ grain: i === 1 ? { ratio: 0.1, valid: true } : undefined })));
    expect(checkOf(frozen, "frozen_grain").verdict).toBe("fail");
    expect(checkOf(frozen, "frozen_grain").fixes[0].tool).toBe("ae_patch_grain");
    const border = judge(steady(6, (i) => ({ grain: i === 1 ? { ratio: 0.6, valid: true } : undefined })));
    expect(checkOf(border, "frozen_grain").verdict).toBe("warn");
    const moving = judge(steady(6, (i) => ({ grain: i === 1 ? { ratio: null, valid: false, reason: "the shot moves" } : undefined })));
    expect(checkOf(moving, "frozen_grain")).toMatchObject({ verdict: "not_measurable" });
    expect(checkOf(moving, "frozen_grain").summary).toContain("the shot moves");
    expect(checkOf(judge(steady(6), okSlip, false), "frozen_grain").summary).toContain("grain_probes");
    expect(checkOf(judge(steady(6)), "frozen_grain").verdict).toBe("not_measurable");
  });

  it("judges slip: warn over the limit, fail over twice it, not measurable without texture", () => {
    const slip = (max: number): SlipResult => ({ ...okSlip, series: [{ time: 0.12, slip_px: max, patch_live: 5, ring_live: 5 }], max_slip_px: max });
    expect(checkOf(judge(steady(6), slip(0.7)), "slip").verdict).toBe("warn");
    const bad = judge(steady(6), slip(1.4));
    expect(checkOf(bad, "slip").verdict).toBe("fail");
    expect(checkOf(bad, "slip").fixes[0].tool).toBe("ae_track_multi");
    const flat: SlipResult = { status: "not_measurable", reason: "the patch has no texture to follow", patch_features: 0, ring_features: 0, start_time: 0, series: [], max_slip_px: null };
    expect(checkOf(judge(steady(6), flat), "slip")).toMatchObject({ verdict: "not_measurable", summary: expect.stringContaining("no texture") });
    expect(checkOf(judge(steady(6), null), "slip").verdict).toBe("not_measurable");
  });

  it("judges sharpness on the median ratio", () => {
    expect(checkOf(judge(steady(6, () => ({ sharp: 0.4 }))), "sharpness")).toMatchObject({ verdict: "warn", summary: expect.stringContaining("softer") });
    expect(checkOf(judge(steady(6, () => ({ sharp: 0.2 }))), "sharpness").verdict).toBe("fail");
    expect(checkOf(judge(steady(6, () => ({ sharp: 2.5 }))), "sharpness").summary).toContain("sharper");
    expect(checkOf(judge(steady(6, () => ({ sharp: null }))), "sharpness").verdict).toBe("not_measurable");
  });

  it("is inconclusive when no frame could be measured, and the verdict is the worst measured check", () => {
    const j = judge([{ time: 0, usable: false, reason: "the region is outside the frame" }]);
    expect(j.verdict).toBe("inconclusive");
    expect(j.checks.every((c) => c.verdict === "not_measurable")).toBe(true);
    expect(j.checks[0].summary).toContain("outside the frame");
    expect(judge([]).verdict).toBe("inconclusive");
    // Thresholds are options: a looser seam limit turns a warn into ok.
    const loose = judgePatch(steady(5, (i) => ({ seam: i === 3 ? 2 : 1 })), okSlip, { thresholds: { ...THRESH, seam_max: 3 }, fps: 25, grainRequested: true });
    expect(checkOf(loose, "seam").verdict).toBe("ok");
  });
});

// ---------- pictures ----------

describe("pictures", () => {
  it("pushes exposure in linear light: +2 stops quadruples linear values and clips", () => {
    const img = image(2, 1, (x) => (x === 0 ? grey(60) : grey(200)));
    const up = exposurePush(img, 2);
    const lin = srgbToLinear(60 / 255) * 4;
    expect(up.data[0]).toBe(Math.round(linearToSrgb(lin) * 255));
    expect(up.data[4]).toBe(255);
    expect(up.data[3]).toBe(255);
    expect(exposurePush(img, 0).data[0]).toBe(60);
  });

  it("builds a difference view scaled and clipped", () => {
    const a = image(2, 1, () => grey(100));
    const b = image(2, 1, (x) => grey(x === 0 ? 100 : 110));
    const d = differenceImage(a, b, 4);
    expect(d.data[0]).toBe(0);
    expect(d.data[4]).toBe(40);
    expect(differenceImage(a, image(2, 1, () => grey(200)), 4).data[0]).toBe(255);
  });

  let dir = "";
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-patchcheck-pic-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("builds a contact sheet with a row per frame, skips a frame it cannot read, and returns null for none", () => {
    const o = { delta: 18 };
    const files = [0, 0.4].map((t, i) => {
      const a = path.join(dir, `a${i}.png`);
      const b = path.join(dir, `b${i}.png`);
      writePng(a, compositeImage(t, o));
      writePng(b, plateImage(t));
      return { a, b, t };
    });
    const frame = (i: number, label: string) => ({ label, time: files[i].t, composite: files[i].a, plate: files[i].b, polygon: REGION, seam: { from: [60, 40] as Pt, to: [60, 80] as Pt } });
    const sheet = buildContactSheet([frame(0, "FIRST"), frame(1, "LAST"), { ...frame(0, "BAD"), composite: path.join(dir, "missing.png") }], COMP, { ringPx: 12, maxSize: 1200 })!;
    expect(sheet).not.toBeNull();
    // Two rows of four cells.
    expect(sheet.width).toBeLessThanOrEqual(1200);
    const one = buildContactSheet([frame(0, "FIRST")], COMP, { ringPx: 12, maxSize: 1200 })!;
    expect(sheet.height).toBeGreaterThan(one.height * 1.9);
    expect(buildContactSheet([{ ...frame(0, "BAD"), plate: path.join(dir, "missing.png") }], COMP, { ringPx: 12, maxSize: 1200 })).toBeNull();
    expect(buildContactSheet([], COMP, { ringPx: 12, maxSize: 1200 })).toBeNull();
    // The seam crop of a patch with a step is brighter than the plain crop would be: the sheet is not blank.
    expect(PNG.sync.write(sheet).length).toBeGreaterThan(1000);
  });

  it("draws a graph and the regions overlay", () => {
    const g = drawSeriesGraph([{ name: "a", times: [0, 1, 2], values: [0.1, 0.5, 0.3] }, { name: "b", times: [0, 1, 2], values: [0.2, 0.2, 0.2] }]);
    expect([g.width, g.height]).toEqual([720, 320]);
    const empty = drawSeriesGraph([]);
    expect(empty.width).toBe(720);
    const flat = drawSeriesGraph([{ name: "flat", times: [1], values: [0.5] }]);
    expect(flat.height).toBe(320);
    const frame = compositeImage(0);
    const o = drawRegionsOverlay(frame, COMP, [{ name: "patch", polygon: REGION }, { name: "ring", polygon: REGION, ring: { inner_px: 2, outer_px: 10 } }], 100);
    expect(o.width).toBe(100);
    expect(o.height).toBe(65);
  });
});

// ---------- one region ----------

describe("regionFrameStats", () => {
  const img = image(200, 130, (x, y) => (x < 100 ? grey(60 + noise(x, y, 1, 3)) : grey(200)));

  it("measures a rect: pixels, colour, spread, percentiles, noise, and the change since the previous frame", () => {
    const poly = regionToPolygon({ kind: "rect", rect: [10, 10, 60, 60] });
    const r = regionFrameStats({ time: 1, img, comp: COMP, polyComp: poly, linear: false });
    expect(r.usable).toBe(true);
    expect(r.pixels).toBe(2500);
    expect(r.frame_share).toBe(1);
    expect(r.mean_rgb![0]).toBeCloseTo(60 / 255, 1);
    expect(r.luma!.p05).toBeLessThanOrEqual(r.luma!.p50);
    expect(r.luma!.p50).toBeLessThanOrEqual(r.luma!.p95);
    expect(r.noise_sigma!).toBeGreaterThan(2.5);
    expect(r.noise_sigma!).toBeLessThan(3.5);
    expect(r.change).toBeNull();
    const next = image(200, 130, (x, y) => (x < 100 ? grey(80 + noise(x, y, 1, 3)) : grey(200)));
    const r2 = regionFrameStats({ time: 2, img: next, prev: img, comp: COMP, polyComp: poly, linear: false });
    expect(r2.change!).toBeCloseTo(20 / 255, 2);
  });

  it("measures a ring around a shape, reports how much of a region the frame cuts off, and refuses an empty one", () => {
    const poly = regionToPolygon({ kind: "rect", rect: [110, 20, 150, 60] });
    const ring = regionFrameStats({ time: 1, img, comp: COMP, polyComp: poly, ring: { inner_px: 0, outer_px: 8 }, linear: false });
    expect(ring.usable).toBe(true);
    expect(ring.pixels!).toBeGreaterThan(600);
    expect(ring.mean_rgb![0]).toBeGreaterThan(0.7);
    const cut = regionFrameStats({ time: 1, img, comp: COMP, polyComp: regionToPolygon({ kind: "rect", rect: [150, 60, 250, 100] }), linear: false });
    expect(cut.usable).toBe(true);
    expect(cut.frame_share!).toBeCloseTo(0.5, 1);
    const edge = regionFrameStats({ time: 1, img, comp: COMP, polyComp: regionToPolygon({ kind: "rect", rect: [190, 60, 230, 100] }), ring: { inner_px: 0, outer_px: 30 }, linear: false });
    expect(edge.usable).toBe(true);
    expect(edge.frame_share!).toBeLessThan(1);
    expect(regionFrameStats({ time: 1, img, comp: COMP, polyComp: regionToPolygon({ kind: "rect", rect: [400, 400, 440, 440] }), linear: false }).usable).toBe(false);
    expect(regionFrameStats({ time: 1, img, comp: COMP, polyComp: regionToPolygon({ kind: "rect", rect: [5, 5, 5.5, 5.5] }), linear: false }).reason).toContain("smaller than a pixel");
    const lin = regionFrameStats({ time: 1, img, comp: COMP, polyComp: poly0(), linear: true });
    expect(lin.luma!.mean).toBeCloseTo(srgbToLinear(60 / 255), 1);
  });
});

function poly0(): Pt[] {
  return regionToPolygon({ kind: "rect", rect: [10, 10, 60, 60] });
}

// ---------- schemas ----------

describe("schemas", () => {
  const patch = { comp_id: 1, patch_layers: [{ name: "Patch" }], expect: expectArg };

  it("fills ae_patch_check's defaults and takes a region, a track and tuned thresholds", () => {
    const a = AePatchCheckSchema.parse(patch);
    expect(a).toMatchObject({ ring_px: 24, ring_gap_px: 2, max_samples: 24, grain_probes: 3, seam_max: 1.5, pop_factor: 3, frozen_ratio: 0.5, slip_px: 0.5, luma_space: "encoded", contact_sheet: true });
    const b = AePatchCheckSchema.parse({
      ...patch,
      region: { kind: "polygon", points: [[0, 0], [10, 0], [10, 10]] },
      region_track: [{ time: 0, homography: [1, 0, 0, 0, 1, 0, 0, 0, 1] }],
      seam_max: 2.5,
      times: [0, 1],
    });
    expect(b.seam_max).toBe(2.5);
  });

  it("refuses bad ae_patch_check arguments", () => {
    expect(() => AePatchCheckSchema.parse({ comp_id: 1, patch_layers: [{ name: "x" }] })).toThrow();
    expect(() => AePatchCheckSchema.parse({ ...patch, patch_layers: [] })).toThrow();
    expect(() => AePatchCheckSchema.parse({ ...patch, patch_layers: [{}] })).toThrow();
    expect(() => AePatchCheckSchema.parse({ ...patch, max_samples: 61 })).toThrow();
    expect(() => AePatchCheckSchema.parse({ ...patch, times: Array.from({ length: 61 }, (_, i) => i) })).toThrow();
    expect(() => AePatchCheckSchema.parse({ ...patch, region: { kind: "rect", rect: [10, 10, 5, 5] } })).toThrow(/x1 > x0/);
    expect(() => AePatchCheckSchema.parse({ ...patch, region: { kind: "polygon", points: [[0, 0], [1, 1]] } })).toThrow();
    expect(() => AePatchCheckSchema.parse({ ...patch, region: { kind: "blob" } })).toThrow();
    expect(() => AePatchCheckSchema.parse({ ...patch, region_track: [{ time: 0, homography: [1, 0, 0, 0, 1, 0, 0, 0, 1] }] })).toThrow(/add region too/);
    expect(() => AePatchCheckSchema.parse({ ...patch, region: { kind: "rect", rect: [0, 0, 1, 1] }, region_track: [{ time: 0, homography: [1, 2, 3] }] })).toThrow();
    expect(() => AePatchCheckSchema.parse({ ...patch, grain_probes: 7 })).toThrow();
    expect(() => AePatchCheckSchema.parse({ ...patch, slip_px: 0 })).toThrow();
    expect(() => AePatchCheckSchema.parse({ ...patch, region: { kind: "ellipse", center: [0, 0], radius: [0, 5] } })).toThrow();
  });

  it("takes ae_region_stats regions of every kind and needs expect only with hide_layers", () => {
    const base = { comp_id: 1, regions: [{ shape: { kind: "rect", rect: [0, 0, 10, 10] } }] };
    const a = AeRegionStatsSchema.parse(base);
    expect(a).toMatchObject({ max_samples: 24, pop_factor: 3, graph: true, draw_regions: true, luma_space: "encoded" });
    expect(a.expect).toBeUndefined();
    AeRegionStatsSchema.parse({ comp_id: 1, regions: [{ name: "ring", shape: { kind: "ellipse", center: [5, 5], radius: [3, 3] }, ring: { inner_px: 2, outer_px: 9 }, track: [{ time: 0, homography: [1, 0, 0, 0, 1, 0, 0, 0, 1] }] }, { shape: { kind: "polygon", points: [[0, 0], [5, 0], [5, 5]] } }] });
    expect(() => AeRegionStatsSchema.parse({ ...base, hide_layers: [{ name: "Patch" }] })).toThrow(/give `expect`/);
    AeRegionStatsSchema.parse({ ...base, hide_layers: [{ name: "Patch" }], expect: expectArg });
    expect(() => AeRegionStatsSchema.parse({ comp_id: 1, regions: [] })).toThrow();
    expect(() => AeRegionStatsSchema.parse({ comp_id: 1, regions: Array.from({ length: 9 }, () => base.regions[0]) })).toThrow();
    expect(() => AeRegionStatsSchema.parse({ comp_id: 1, regions: [{ shape: base.regions[0].shape, ring: { inner_px: 5, outer_px: 5 } }] })).toThrow(/more than inner_px/);
  });

  it("describes every argument and ends the mutating descriptions with the safety guidance", () => {
    for (const t of patchcheckTools) {
      expect(t.description).toContain("IMPORTANT: (1) Always re-read project/comp state before writing.");
      const shape = (t.schema as any)._def.schema?._def?.shape?.() ?? (t.schema as any)._def.shape?.();
      for (const [key, field] of Object.entries<any>(shape)) {
        expect(field.description ?? field._def.innerType?.description ?? field._def.innerType?._def?.innerType?.description, `${t.name}.${key}`).toBeTruthy();
      }
    }
    expect(patchcheckTools.map((t) => t.name)).toEqual(["ae_patch_check", "ae_region_stats"]);
  });
});

// ---------- the tools against a fake bridge ----------

const tmpDirs: string[] = [];
const origLocalAppData = process.env.LOCALAPPDATA;

beforeEach(() => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-patchcheck-"));
  tmpDirs.push(d);
  process.env.LOCALAPPDATA = d;
});

afterEach(() => {
  if (origLocalAppData === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = origLocalAppData;
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const COPY_ID = 77;

interface AeOpts {
  scene?: SceneOpts | ((time: number) => SceneOpts);
  failRemove?: boolean;
  failBegin?: boolean;
  failAfter?: boolean;
  corruptCopy?: boolean;
  noCopyId?: boolean;
  /** The nth render (1-based) and every one after it times out. */
  renderTimesOutFrom?: number;
  linearBlending?: boolean | null;
  /** The patch layer is hidden at every time (no footprint). */
  hidden?: boolean;
  olderCopies?: number;
  duration?: number;
  frameRate?: number;
  originalOffAfter?: boolean;
  /** The comp read fails. */
  failRead?: boolean;
  /** The patch layer's footprint polygon (default the region), and the outline of its masks. */
  footprint?: Array<[number, number]>;
  mask?: Array<[number, number]>;
  /** The patch layer's mask feather, comp pixels (the mask outline is the footprint). */
  feather?: number;
}

function fakeAe(opts: AeOpts = {}) {
  const calls: Array<{ fn: string; script: string; args: any }> = [];
  let renders = 0;
  let states = 0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-patchcheck-q-"));
  tmpDirs.push(dir);
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
  const sceneAt = (t: number): SceneOpts => (typeof opts.scene === "function" ? opts.scene(t) : (opts.scene ?? {}));
  const comp = { id: 1, name: "Main", ...COMP, duration: opts.duration ?? 2, frame_duration: 1 / (opts.frameRate ?? 25), frame_rate: opts.frameRate ?? 25, work_area_start: 0, work_area_duration: opts.duration ?? 2, pixel_aspect: 1, resolution_factor: [1, 1] };
  const host = new PanelHost({
    evalScript: async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      const args = JSON.parse(script.slice(script.indexOf("(") + 1, script.lastIndexOf(")")) || "null");
      calls.push({ fn, script, args });
      const ok = (result: unknown) => ({ ok: true, result, durationMs: 1 });
      if (fn === "checkGuard") return ok({ ok: true, project_path: "<unsaved>", comp_id: 1, comp_is_valid: true });
      if (fn === "patchcheckRead") {
        if (opts.failRead) throw new Error("No layer named \"Patch\"");
        const layers = args.layers
          ? [
              {
                index: 2, id: 10, name: "Patch", kind: "AVLayer", enabled: true, locked: false, guide: false, three_d: false, in_point: 0, out_point: comp.duration, parent_id: null,
                footprints: (args.times ?? []).map((time: number) => ({
                  time,
                  visible: !opts.hidden,
                  polygon: opts.hidden ? null : (opts.footprint ?? REGION),
                  ...(opts.mask && !opts.hidden ? { mask_polygon: opts.mask } : {}),
                  ...(opts.feather && !opts.hidden ? { mask_polygon: opts.mask ?? opts.footprint ?? REGION, mask_feather_px: opts.feather } : {}),
                  reason: opts.hidden ? "the layer's opacity is 0" : null,
                })),
              },
            ]
          : [];
        return ok({ comp, linear_blending: opts.linearBlending === undefined ? false : opts.linearBlending, solo_active: false, times: args.times ?? null, layers, total_layers: 3 });
      }
      if (fn === "patchcheckState") {
        states++;
        if (states === 2 && opts.failAfter) throw new Error("read failed");
        const state: Record<string, unknown> = { num_items: 4, comps: 2, temp_comps: opts.olderCopies ?? 0 };
        if (script.includes("layer_ids")) state.layers = [{ id: 10, enabled: !(states > 1 && opts.originalOffAfter) }];
        return ok(state);
      }
      if (fn === "patchcheckBegin") {
        if (opts.failBegin) throw new Error("Layer 2 is not the layer read earlier");
        const res: Record<string, unknown> = { copy_name: "chroma-patchcheck-copy Main", switched_off: 1, comp_size: [COMP.width, COMP.height] };
        if (!opts.noCopyId) res.copy_id = COPY_ID;
        return ok(res);
      }
      if (fn === "snapshotFrame") {
        renders += 1;
        if (opts.renderTimesOutFrom !== undefined && renders >= opts.renderTimesOutFrom) throw new BridgeError({ kind: "timeout", message: "AE did not answer" });
        const isCopy = args.comp_id === COPY_ID;
        const sc = sceneAt(args.time);
        const out = args.output_path as string;
        if (isCopy && opts.corruptCopy) {
          fs.mkdirSync(path.dirname(out), { recursive: true });
          fs.writeFileSync(out, "not a png at all");
        } else {
          writePng(out, isCopy ? plateImage(args.time, sc) : compositeImage(args.time, sc));
        }
        return ok({ path: out });
      }
      if (fn === "patchcheckEnd") {
        if (opts.failRemove) throw new Error("item is locked");
        return ok({ removed: true, copy_id: COPY_ID });
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
const checkArgs = (extra: Record<string, unknown> = {}) =>
  AePatchCheckSchema.parse({ comp_id: 1, patch_layers: [{ name: "Patch" }], expect: expectArg, max_samples: 6, ring_px: 12, contact_sheet: false, ...extra });
const FRAME_TIMES = { times: [0, 0.04, 0.08, 0.12, 0.16, 0.2] };
const verdictOf = (out: Out, name: string) => (out.checks as Array<{ check: string; verdict: string }>).find((c) => c.check === name)!.verdict;

describe("ae_patch_check flow", () => {
  it("reads, guards, copies, renders both comps per frame, removes the copy and reads back in a separate call, in that order", async () => {
    const { ctx, fns } = fakeAe();
    const out = (await tool("ae_patch_check").handler(checkArgs(FRAME_TIMES), ctx)) as Out;
    const f = fns();
    expect(f.slice(0, 6)).toEqual(["patchcheckRead", "patchcheckRead", "checkGuard", "patchcheckState", "patchcheckBegin", "snapshotFrame"]);
    expect(f.slice(-2)).toEqual(["patchcheckEnd", "patchcheckState"]);
    expect(f.indexOf("patchcheckEnd")).toBeGreaterThan(f.lastIndexOf("snapshotFrame"));
    expect(f.filter((x) => x === "snapshotFrame").length).toBeGreaterThanOrEqual(12);
    expect(out).toMatchObject({ applied: true, mode: "patch_check", region_source: "patch layer footprints" });
    expect(out.temp_comp).toMatchObject({ copy_removed: true, switched_off: 1 });
    expect(out.receipt.matches).toBe(true);
    expect(out.sampled).toMatchObject({ frames_sampled: 6, frames_measured: 6 });
  });

  it("passes a clean patch: every measurable check is ok, no slip, and the series is complete", async () => {
    const { ctx } = fakeAe({ scene: { delta: 0 } });
    const out = (await tool("ae_patch_check").handler(checkArgs(FRAME_TIMES), ctx)) as Out;
    expect(out.verdict, JSON.stringify(out.checks.filter((c: any) => c.verdict !== "ok").map((c: any) => [c.check, c.verdict, c.summary]))).toBe("ok");
    for (const c of ["leakage", "effect", "seam", "flicker", "pops", "drift", "slip", "sharpness"]) expect(verdictOf(out, c), c).toBe("ok");
    expect(verdictOf(out, "frozen_grain")).toBe("ok");
    expect(out.checks.find((c: any) => c.check === "slip").numbers.max_slip_px).toBeLessThan(0.5);
    expect(out.series).toHaveLength(6);
    expect(out.series[0]).toMatchObject({ usable: true, leaked_pixels: 0 });
    expect(out.worst_frames).toHaveLength(5);
    expect(fs.existsSync(out.series_path)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(out.series_path, "utf8"));
    expect(saved.series).toHaveLength(6);
    expect(out.notes.join(" ")).toContain("looped playback");
    expect(out.thresholds).toMatchObject({ seam_max: 1.5, slip_px: 0.5 });
  });

  it("finds leakage, a seam and frozen grain in a bad patch, with fixes and a contact sheet", async () => {
    const { ctx } = fakeAe({ scene: { delta: 20, leak: true, frozen: true } });
    const out = (await tool("ae_patch_check").handler(checkArgs({ ...FRAME_TIMES, contact_sheet: true, sheet_max_size: 900 }), ctx)) as Out;
    expect(out.verdict).toBe("fail");
    expect(verdictOf(out, "leakage")).toBe("fail");
    expect(verdictOf(out, "seam")).not.toBe("ok");
    expect(verdictOf(out, "frozen_grain")).toBe("fail");
    const fixes = out.checks.flatMap((c: any) => c.fixes.map((f: any) => f.tool));
    expect(fixes).toEqual(expect.arrayContaining(["ae_patch_finish", "ae_patch_grain"]));
    expect(out.checks.find((c: any) => c.check === "leakage").numbers.worst_bbox).toBeTruthy();
    expect(out.worst_frames[0].score).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(out.contact_sheet.path)).toBe(true);
    const sheet = PNG.sync.read(fs.readFileSync(out.contact_sheet.path));
    expect(sheet.width).toBeLessThanOrEqual(900);
    expect(out.contact_sheet.frames.map((f: any) => f.label)).toEqual(expect.arrayContaining(["FIRST", "LAST"]));
  });

  it("finds slip of a patch that swims against the plate, with the tool that fixes it", async () => {
    const { ctx } = fakeAe({ scene: (t) => ({ delta: 0, shift: Math.round(t * 25 * 0.8) }) });
    const out = (await tool("ae_patch_check").handler(checkArgs({ ...FRAME_TIMES, grain_probes: 0 }), ctx)) as Out;
    expect(["warn", "fail"]).toContain(verdictOf(out, "slip"));
    const slip = out.checks.find((c: any) => c.check === "slip");
    expect(slip.numbers.max_slip_px).toBeGreaterThan(1.5);
    expect(slip.fixes[0].tool).toBe("ae_track_multi");
    expect(out.series.at(-1).slip_px).toBeGreaterThan(1.5);
  });

  it("finds a pop between neighbouring frames and drift over a longer range", async () => {
    const pop = fakeAe({ scene: (t) => ({ delta: t >= 0.1 ? 14 : 0 }) });
    const out = (await tool("ae_patch_check").handler(checkArgs(FRAME_TIMES), pop.ctx)) as Out;
    expect(verdictOf(out, "pops")).not.toBe("ok");
    const popCheck = out.checks.find((c: any) => c.check === "pops");
    expect(popCheck.numbers.pops[0]).toMatchObject({ from_time: 0.08, to_time: 0.12, gap_frames: 1 });
    expect(popCheck.worst_times).toEqual([0.12]);
    const drift = fakeAe({ scene: (t) => ({ delta: Math.round(t * 20) }) });
    const d = (await tool("ae_patch_check").handler(checkArgs({ times: [0, 0.4, 0.8, 1.2, 1.6, 1.96] }), drift.ctx)) as Out;
    expect(["warn", "fail"]).toContain(verdictOf(d, "drift"));
  });

  it("reports slip as not measurable on a flat patch instead of 0, and no effect when the patch shows the plate", async () => {
    const flat = fakeAe({ scene: { flat: true, delta: 5 } });
    const a = (await tool("ae_patch_check").handler(checkArgs(FRAME_TIMES), flat.ctx)) as Out;
    expect(verdictOf(a, "slip")).toBe("not_measurable");
    expect(a.checks.find((c: any) => c.check === "slip").summary).toContain("no texture");
    const same = fakeAe({ scene: { same: true } });
    const b = (await tool("ae_patch_check").handler(checkArgs(FRAME_TIMES), same.ctx)) as Out;
    expect(verdictOf(b, "effect")).toBe("fail");
    expect(b.checks.find((c: any) => c.check === "effect").summary).toContain("changes (almost) nothing");
  });

  it("renders the next frame for the grain probes only, and skips them with grain_probes 0", async () => {
    const a = fakeAe();
    await tool("ae_patch_check").handler(checkArgs({ ...FRAME_TIMES, grain_probes: 2 }), a.ctx);
    // 6 pairs plus 2 probes.
    expect(a.fns().filter((f) => f === "snapshotFrame")).toHaveLength(14);
    const b = fakeAe();
    const out = (await tool("ae_patch_check").handler(checkArgs({ ...FRAME_TIMES, grain_probes: 0 }), b.ctx)) as Out;
    expect(b.fns().filter((f) => f === "snapshotFrame")).toHaveLength(12);
    expect(verdictOf(out, "frozen_grain")).toBe("not_measurable");
  });

  it("uses an explicit region over the footprint, and follows a track", async () => {
    const { ctx, calls } = fakeAe({ scene: { delta: 0 } });
    const out = (await tool("ae_patch_check").handler(checkArgs({ ...FRAME_TIMES, region: { kind: "rect", rect: [60, 25, 140, 105] }, region_track: [{ time: 0, homography: [1, 0, 0, 0, 1, 0, 0, 0, 1] }] }), ctx)) as Out;
    expect(out.region_source).toBe("region");
    expect(out.checks.find((c: any) => c.check === "leakage").verdict).toBe("ok");
    expect(calls.find((c) => c.fn === "patchcheckRead" && c.args.times)!.args.layers).toEqual([{ name: "Patch" }]);
    // A track that moves the region off the patch makes the patch change things outside it.
    const moved = fakeAe({ scene: { delta: 12 } });
    const m = (await tool("ae_patch_check").handler(checkArgs({ ...FRAME_TIMES, region: { kind: "rect", rect: [60, 25, 140, 105] }, region_track: [{ time: 0, homography: [1, 0, 30, 0, 1, 0, 0, 0, 1] }] }), moved.ctx)) as Out;
    expect(verdictOf(m, "leakage")).toBe("fail");
  });

  it("samples the default range within max_samples and says 'sampled N of M frames'", async () => {
    const { ctx } = fakeAe({ duration: 4 });
    const out = (await tool("ae_patch_check").handler(checkArgs({ max_samples: 5, grain_probes: 0 }), ctx)) as Out;
    expect(out.sampled.frames_in_range).toBe(100);
    expect(out.sampled.frames_sampled).toBeLessThanOrEqual(5);
    expect(out.sampled.note).toMatch(/^sampled \d+ of 100 frames$/);
    expect(out.sampled.times[0]).toBe(0);
    expect(out.sampled.times.at(-1)).toBeCloseTo(3.96, 4);
  });

  it("refuses before the checkpoint when no patch layer has a footprint and no region is given", async () => {
    const { ctx, fns } = fakeAe({ hidden: true });
    const out = (await tool("ae_patch_check").handler(checkArgs(FRAME_TIMES), ctx)) as Out;
    expect(out).toMatchObject({ ok: false, error: "nothing_to_check" });
    expect(out.message).toContain("opacity is 0");
    expect(out.message).toContain("region");
    // The refusal names the layer it means and does not claim a footprint is what is missing.
    expect(out.message).toContain("Patch: ");
    expect(out.message).toContain("no usable region");
    expect(fns()).toEqual(["patchcheckRead", "patchcheckRead"]);
  });

  it("lets a bad selector fail in the read, before anything is guarded or written", async () => {
    const { ctx, fns } = fakeAe({ failRead: true });
    await expect(tool("ae_patch_check").handler(checkArgs(FRAME_TIMES), ctx)).rejects.toThrow(/No layer named/);
    expect(fns()).toEqual(["patchcheckRead"]);
  });

  it("stops at a failed begin without rendering or removing anything", async () => {
    const { ctx, fns } = fakeAe({ failBegin: true });
    await expect(tool("ae_patch_check").handler(checkArgs(FRAME_TIMES), ctx)).rejects.toThrow(/not the layer read earlier/);
    expect(fns()).not.toContain("snapshotFrame");
    expect(fns()).not.toContain("patchcheckEnd");
  });

  it("marks a time inconclusive when its plate cannot be read, still removes the copy and keeps the receipt clean", async () => {
    const { ctx, fns } = fakeAe({ corruptCopy: true });
    const out = (await tool("ae_patch_check").handler(checkArgs(FRAME_TIMES), ctx)) as Out;
    expect(fns().slice(-2)).toEqual(["patchcheckEnd", "patchcheckState"]);
    expect(out.verdict).toBe("inconclusive");
    expect(out.unmeasured_frames).toHaveLength(6);
    expect(out.unmeasured_frames[0].reason).toContain("could not be measured");
    expect(out.temp_comp.copy_removed).toBe(true);
    expect(out.receipt.matches).toBe(true);
  });

  it("reports a copy that could not be removed in the receipt instead of throwing", async () => {
    const { ctx } = fakeAe({ failRemove: true });
    const out = (await tool("ae_patch_check").handler(checkArgs(FRAME_TIMES), ctx)) as Out;
    expect(out.applied).toBe(true);
    expect(out.temp_comp.copy_removed).toBe(false);
    expect(out.receipt.matches).toBe(false);
    expect(JSON.stringify(out.receipt)).toContain("chroma-patchcheck-copy");
  });

  it("reports a failed read-back without throwing, and flags a patch layer of the original left switched off", async () => {
    const failed = fakeAe({ failAfter: true });
    const a = (await tool("ae_patch_check").handler(checkArgs(FRAME_TIMES), failed.ctx)) as Out;
    expect(a.applied).toBe(true);
    expect(a.receipt.matches).toBe(false);
    expect(JSON.stringify(a.receipt)).toContain("Do not resend");
    const off = fakeAe({ originalOffAfter: true });
    const b = (await tool("ae_patch_check").handler(checkArgs(FRAME_TIMES), off.ctx)) as Out;
    expect(off.calls.filter((c) => c.fn === "patchcheckState").every((c) => c.script.includes("layer_ids"))).toBe(true);
    expect(b.receipt.matches).toBe(false);
    expect(JSON.stringify(b.receipt)).toContain("layers.10.enabled");
  });

  it("stops rendering after a timeout, marks the rest unmeasured, still removes the copy and says AE is blocked", async () => {
    const { ctx, fns } = fakeAe({ renderTimesOutFrom: 3 });
    const out = (await tool("ae_patch_check").handler(checkArgs(FRAME_TIMES), ctx)) as Out;
    expect(fns().filter((f) => f === "snapshotFrame")).toHaveLength(3);
    expect(fns().slice(-2)).toEqual(["patchcheckEnd", "patchcheckState"]);
    expect(out.ae_blocked).toContain("ae_dialogs");
    expect(out.temp_comp.copy_removed).toBe(true);
    expect(out.unmeasured_frames.length).toBeGreaterThanOrEqual(5);
  });

  it("does not render when AE gives no id for the copy, and says so", async () => {
    const { ctx, fns } = fakeAe({ noCopyId: true });
    const out = (await tool("ae_patch_check").handler(checkArgs(FRAME_TIMES), ctx)) as Out;
    expect(fns()).not.toContain("snapshotFrame");
    expect(out).toMatchObject({ ok: false, error: "check_failed" });
    expect(out.message).toContain("no id for the temporary comp");
    expect(out.receipt.matches).toBe(false);
  });

  it("notes an older copy in the project and the linear-blending flag", async () => {
    const { ctx } = fakeAe({ olderCopies: 1, linearBlending: true });
    const out = (await tool("ae_patch_check").handler(checkArgs(FRAME_TIMES), ctx)) as Out;
    expect(out.receipt.matches).toBe(true);
    expect(out.linear_blending).toBe(true);
    expect(out.notes.join(" ")).toContain("already had 1 comp(s)");
    expect(out.notes.join(" ")).toContain("linear blending");
  });

  it("compares the copy bookkeeping: a copy that was already there is not a mismatch", () => {
    const before = { num_items: 5, comps: 3, temp_comps: 1 };
    expect(copyMismatches(before, { ...before }, null, 9)).toEqual([]);
    expect(copyMismatches(before, { num_items: 5, comps: 3, temp_comps: 2 }, null, 9).map((x) => x.path)).toEqual(["temp_comps"]);
    expect(copyMismatches(null, null, "boom", 9)[0].message).toContain("Delete it in the Project panel");
  });
});

describe("ae_region_stats flow", () => {
  const args = (extra: Record<string, unknown> = {}) =>
    AeRegionStatsSchema.parse({
      comp_id: 1,
      regions: [{ name: "patch", shape: { kind: "rect", rect: [60, 25, 140, 105] } }, { name: "ring", shape: { kind: "rect", rect: [60, 25, 140, 105] }, ring: { inner_px: 2, outer_px: 12 } }],
      times: [0, 0.04, 0.08, 0.12, 0.16, 0.2],
      ...extra,
    });

  it("is read only by default: one read for the comp, one render per frame, no guard, no write", async () => {
    const { ctx, fns } = fakeAe({ scene: (t) => ({ delta: t >= 0.1 ? 25 : 0 }) });
    const out = (await tool("ae_region_stats").handler(args(), ctx)) as Out;
    expect(fns()).toEqual(["patchcheckRead", ...Array(6).fill("snapshotFrame")]);
    expect(out).toMatchObject({ ok: true, read_only: true, mode: "region_stats" });
    expect(out.regions).toHaveLength(2);
    const patch = out.regions[0];
    expect(patch.frames).toHaveLength(6);
    expect(patch.frames[0]).toMatchObject({ usable: true, pixels: 6400 });
    expect(patch.summary.frames_measured).toBe(6);
    expect(patch.summary.pops.length).toBeGreaterThan(0);
    expect(patch.summary.pops[0]).toMatchObject({ from_time: 0.08, to_time: 0.12 });
    expect(out.regions[1].frames[0].pixels).toBeGreaterThan(1000);
    for (const f of [out.series_path, out.graph_path, out.regions_png]) expect(fs.existsSync(f)).toBe(true);
    expect(PNG.sync.read(fs.readFileSync(out.graph_path)).width).toBe(720);
    expect(out.notes.join(" ")).toContain("nothing in the project was touched");
  });

  it("follows a track and reports a region the track throws away", async () => {
    const { ctx } = fakeAe();
    const out = (await tool("ae_region_stats").handler(
      args({
        regions: [
          { name: "moving", shape: { kind: "rect", rect: [10, 10, 40, 40] }, track: [{ time: 0, homography: [1, 0, 0, 0, 1, 0, 0, 0, 1] }, { time: 0.2, homography: [1, 0, 100, 0, 1, 50, 0, 0, 1] }] },
          { name: "gone", shape: { kind: "rect", rect: [10, 10, 40, 40] }, track: [{ time: 0, homography: [1, 0, 0, 0, 1, 0, -0.5, 0, 1] }] },
        ],
        graph: false,
        draw_regions: false,
      }),
      ctx
    )) as Out;
    expect(out.regions[0].frames.every((f: any) => f.usable)).toBe(true);
    expect(out.regions[1].frames[0]).toMatchObject({ usable: false });
    expect(out.regions[1].frames[0].reason).toContain("horizon");
    expect(out.graph_path).toBeUndefined();
    expect(out.regions_png).toBeUndefined();
    expect(out.regions[1].summary.frames_measured).toBe(0);
  });

  it("caps the rows it returns while the full series goes to the file", async () => {
    const { ctx } = fakeAe({ duration: 4 });
    const out = (await tool("ae_region_stats").handler(args({ times: undefined, max_samples: 12 }), ctx)) as Out;
    expect(out.sampled.frames_sampled).toBeLessThanOrEqual(12);
    expect(out.sampled.note).toMatch(/^sampled \d+ of 100 frames$/);
    const rows = out.regions.reduce((n: number, r: any) => n + r.frames.length, 0);
    expect(rows).toBeLessThanOrEqual(500);
    const saved = JSON.parse(fs.readFileSync(out.series_path, "utf8"));
    expect(saved.regions[0].rows.length).toBe(out.sampled.frames_sampled);
    expect(saved.regions[0].summary.frames_measured).toBe(out.sampled.frames_sampled);
  });

  it("with hide_layers it is a guarded write on a temporary copy that renders the copy only", async () => {
    const { ctx, fns, calls } = fakeAe();
    const out = (await tool("ae_region_stats").handler(args({ hide_layers: [{ name: "Patch" }], expect: expectArg }), ctx)) as Out;
    const f = fns();
    expect(f.slice(0, 5)).toEqual(["patchcheckRead", "checkGuard", "patchcheckState", "patchcheckBegin", "snapshotFrame"]);
    expect(f).toContain("patchcheckEnd");
    expect(calls.filter((c) => c.fn === "snapshotFrame").every((c) => c.args.comp_id === COPY_ID)).toBe(true);
    expect(out).toMatchObject({ applied: true, mode: "region_stats" });
    expect(out.temp_comp.copy_removed).toBe(true);
    expect(out.receipt.matches).toBe(true);
    expect(out.regions[0].frames[0].usable).toBe(true);
  });

  it("reports a time that cannot be measured, stops after a timeout and marks the rest", async () => {
    const bad = fakeAe({ renderTimesOutFrom: 2 });
    const out = (await tool("ae_region_stats").handler(args(), bad.ctx)) as Out;
    expect(out.ae_blocked).toContain("ae_dialogs");
    expect(out.regions[0].frames.filter((f: any) => f.usable)).toHaveLength(1);
    expect(bad.fns().filter((f) => f === "snapshotFrame")).toHaveLength(2);
    const iso = fakeAe({ corruptCopy: true });
    const o2 = (await tool("ae_region_stats").handler(args({ hide_layers: [{ name: "Patch" }], expect: expectArg }), iso.ctx)) as Out;
    expect(o2.regions[0].frames.every((f: any) => !f.usable)).toBe(true);
    expect(o2.temp_comp.copy_removed).toBe(true);
    expect(o2.receipt.matches).toBe(true);
  });

  it("tells the caller when isolating could not start", async () => {
    const { ctx, fns } = fakeAe({ noCopyId: true });
    const out = (await tool("ae_region_stats").handler(args({ hide_layers: [{ name: "Patch" }], expect: expectArg }), ctx)) as Out;
    expect(fns()).not.toContain("snapshotFrame");
    expect(out).toMatchObject({ ok: false, error: "check_failed" });
  });
});

// ---------- the host functions under node:vm ----------

function scene() {
  const project = new FakeProject();
  const comp = project.addComp("Main", 640, 360, 4);
  const layer = (name: string, rect = { left: 0, top: 0, width: 100, height: 50 }) => {
    const l = comp.layers.addSolid([1, 1, 1], name, rect.width, rect.height, 1) as FakeLayer;
    l.rect = rect;
    return l;
  };
  return { project, comp, layer };
}

function allowDuplicate(project: FakeProject, comp: FakeComp, o: { renameLayers?: boolean } = {}) {
  (comp as any).duplicate = () => {
    const copy = project.addComp(`${comp.name} 2`, comp.width, comp.height, comp.duration);
    for (const l of comp.stack) {
      const c = new FakeLayer(copy, o.renameLayers ? `${l.name} x` : l.name, l.reflect.name);
      c.rect = { ...l.rect };
      let on = l.enabled;
      c.locked = l.locked;
      Object.defineProperty(c, "enabled", {
        get: () => on,
        set: (v: boolean) => {
          if (c.locked) throw new Error("layer is locked");
          on = v;
        },
      });
      copy.stack.push(c);
    }
    return copy;
  };
}

const want = (l: FakeLayer) => ({ index: l.index, id: l.id, name: l.name });

describe("patchcheck.jsx reads", () => {
  it("returns the comp's timing alone when no layers are asked for, and refuses an empty list", () => {
    const { project, comp } = scene();
    (project as any).linearBlending = true;
    const { A, undo } = loadHost(project, ["patchcheck.jsx"]);
    const out = A.patchcheckRead({ comp_id: comp.id });
    expect(out.comp).toMatchObject({ id: comp.id, name: "Main", width: 640, height: 360, duration: 4, frame_rate: 25, work_area_start: 0, work_area_duration: 4 });
    expect(out.comp.frame_duration).toBeCloseTo(0.04, 9);
    expect(out.layers).toEqual([]);
    expect(out.times).toBeNull();
    expect(out.linear_blending).toBe(true);
    expect(() => A.patchcheckRead({ comp_id: comp.id, layers: [] })).toThrow(/at least one layer/);
    expect(() => A.patchcheckRead({ comp_id: 9999 })).toThrow(/No CompItem/);
    expect(undo.begun).toBe(0);
  });

  it("gives a layer's footprint as a quad through its transforms and parents, with flags", () => {
    const { project, comp, layer } = scene();
    const patch = layer("Patch", { left: 0, top: 0, width: 100, height: 50 });
    patch.transform("ADBE Position").setValue([200, 100, 0]);
    patch.transform("ADBE Scale").setValue([200, 200, 100]);
    patch.transform("ADBE Anchor Point").setValue([50, 25, 0]);
    const rig = comp.layers.addNull() as FakeLayer;
    rig.transform("ADBE Position").setValue([10, 20, 0]);
    patch.parent = rig;
    const { A } = loadHost(project, ["patchcheck.jsx"]);
    const out = A.patchcheckRead({ comp_id: comp.id, layers: [{ name: "Patch" }], times: [1] });
    const l = out.layers[0];
    expect(l).toMatchObject({ name: "Patch", enabled: true, locked: false, guide: false, three_d: false, parent_id: rig.id, kind: "AVLayer" });
    const fp = l.footprints[0];
    expect(fp).toMatchObject({ time: 1, visible: true, reason: null });
    // Anchor (50, 25) at position (200, 100) with scale 200%, under a parent at (10, 20) whose own anchor is 0 and position (10, 20).
    expect(fp.polygon).toEqual([[110, 70], [310, 70], [310, 170], [110, 170]]);
  });

  it("marks hidden, out-of-range, transparent, guide, 3D and soloed layers as not showing, with the reason", () => {
    const { project, comp, layer } = scene();
    const off = layer("Off");
    off.enabled = false;
    const early = layer("Early");
    early.inPoint = 2;
    const clear = layer("Clear");
    clear.transform("ADBE Opacity").setValue(0);
    const guide = layer("Guide");
    guide.guideLayer = true;
    const solid3d = layer("Floating");
    solid3d.threeDLayer = true;
    const { A } = loadHost(project, ["patchcheck.jsx"]);
    const sel = ["Off", "Early", "Clear", "Guide", "Floating"].map((name) => ({ name }));
    const out = A.patchcheckRead({ comp_id: comp.id, layers: sel, times: [1] });
    const by = (n: string) => out.layers.find((l: any) => l.name === n).footprints[0];
    expect(by("Off")).toMatchObject({ visible: false, reason: expect.stringContaining("switch is off") });
    expect(by("Early")).toMatchObject({ visible: false, reason: expect.stringContaining("outside") });
    expect(by("Clear")).toMatchObject({ visible: false, reason: expect.stringContaining("opacity") });
    expect(by("Guide")).toMatchObject({ visible: false, reason: expect.stringContaining("guide") });
    expect(by("Floating")).toMatchObject({ polygon: null, reason: expect.stringContaining("3D") });
    expect(A.patchcheckRead({ comp_id: comp.id, layers: [{ name: "Early" }], times: [2.5] }).layers[0].footprints[0].visible).toBe(true);
    const solo = layer("Solo");
    (solo as any).solo = true;
    const r2 = A.patchcheckRead({ comp_id: comp.id, layers: [{ name: "Solo" }, { name: "Early" }], times: [2.5] });
    expect(r2.solo_active).toBe(true);
    expect(r2.layers[0].footprints[0].visible).toBe(true);
    expect(r2.layers[1].footprints[0].visible).toBe(false);
  });

  it("clamps times, validates them and the selectors, and refuses duplicates and over-long lists", () => {
    const { project, comp, layer } = scene();
    layer("A");
    const { A } = loadHost(project, ["patchcheck.jsx"]);
    const t = A.patchcheckRead({ comp_id: comp.id, layers: [{ name: "A" }], times: [0, 100] }).times;
    expect(t[0]).toBe(0);
    expect(t[1]).toBeCloseTo(3.96, 6);
    expect(() => A.patchcheckRead({ comp_id: comp.id, layers: [{ name: "A" }], times: [-1] })).toThrow(/seconds/);
    expect(() => A.patchcheckRead({ comp_id: comp.id, layers: [{ name: "A" }], times: Array.from({ length: 121 }, () => 1) })).toThrow(/At most 120/);
    expect(() => A.patchcheckRead({ comp_id: comp.id, layers: [{ name: "Nope" }] })).toThrow(/No layer named/);
    expect(() => A.patchcheckRead({ comp_id: comp.id, layers: [{ name: "A" }, { index: 1 }] })).toThrow(/listed twice/);
    expect(() => A.patchcheckRead({ comp_id: comp.id, layers: Array.from({ length: 51 }, () => ({ index: 1 })) })).toThrow(/At most 50/);
  });
});

describe("patchcheck.jsx writes", () => {
  it("duplicates the comp, switches the listed layers off in the copy only, and removes it again, each in its own undo group", () => {
    const { project, comp, layer } = scene();
    const a = layer("A");
    const b = layer("B");
    allowDuplicate(project, comp);
    const { A, undo } = loadHost(project, ["patchcheck.jsx"]);
    expect(A.patchcheckState().temp_comps).toBe(0);
    const made = A.patchcheckBegin({ comp_id: comp.id, layers: [want(a)], expect: GUARD });
    expect(made).toMatchObject({ switched_off: 1, original_id: comp.id, comp_size: [640, 360] });
    expect(made.copy_name).toBe("chroma-patchcheck-copy Main");
    const copy = project.itemByID(made.copy_id) as FakeComp;
    expect(copy.layer(a.index)!.enabled).toBe(false);
    expect(copy.layer(b.index)!.enabled).toBe(true);
    expect(a.enabled).toBe(true);
    expect(undo).toMatchObject({ begun: 1, ended: 1 });
    const st = A.patchcheckState({ comp_id: comp.id, layer_ids: [a.id, b.id] });
    expect(st.temp_comps).toBe(1);
    expect(st.layers).toHaveLength(2);
    expect(st.layers).toEqual(expect.arrayContaining([{ id: a.id, enabled: true }, { id: b.id, enabled: true }]));
    expect(() => A.patchcheckEnd({ copy_id: comp.id, expect: GUARD })).toThrow(/not a patch-check copy/);
    expect(project.itemByID(comp.id)).toBe(comp);
    expect(A.patchcheckEnd({ copy_id: made.copy_id, expect: GUARD })).toEqual({ removed: true, copy_id: made.copy_id });
    expect(project.itemByID(made.copy_id)).toBeNull();
    expect(A.patchcheckEnd({ copy_id: made.copy_id, expect: GUARD })).toMatchObject({ removed: false, already_gone: true });
    expect(undo).toMatchObject({ begun: 2, ended: 2 });
    expect(A.patchcheckState().temp_comps).toBe(0);
  });

  it("validates before duplicating anything: guard, stale id, duplicates, empty and over-long lists", () => {
    const { project, comp, layer } = scene();
    const a = layer("A");
    allowDuplicate(project, comp);
    const { A, undo } = loadHost(project, ["patchcheck.jsx"]);
    const items = project.numItems;
    expect(() => A.patchcheckBegin({ comp_id: comp.id, layers: [want(a)], expect: { project_path: "C:/other.aep" } })).toThrow(/guard refused/);
    expect(() => A.patchcheckBegin({ comp_id: comp.id, layers: [want(a)] })).toThrow(/no expect/);
    expect(() => A.patchcheckBegin({ comp_id: comp.id, layers: [{ index: a.index, id: a.id + 500, name: "A" }], expect: GUARD })).toThrow(/not the layer read earlier/);
    expect(() => A.patchcheckBegin({ comp_id: comp.id, layers: [want(a), want(a)], expect: GUARD })).toThrow(/listed twice/);
    expect(() => A.patchcheckBegin({ comp_id: comp.id, layers: [], expect: GUARD })).toThrow(/No layers/);
    expect(() => A.patchcheckBegin({ comp_id: comp.id, layers: [{ index: 99, id: 1, name: "x" }], expect: GUARD })).toThrow(/out of range/);
    expect(() => A.patchcheckBegin({ comp_id: comp.id, layers: [{ index: 1 }], expect: GUARD })).toThrow(/index and an id/);
    expect(() => A.patchcheckBegin({ comp_id: comp.id, layers: Array.from({ length: 51 }, (_, i) => ({ index: i + 1, id: i, name: "x" })), expect: GUARD })).toThrow(/At most 50/);
    expect(project.numItems).toBe(items);
    expect(undo.begun).toBe(0);
  });

  it("unlocks the copy's layer before switching it off and leaves the original's lock alone", () => {
    const { project, comp, layer } = scene();
    const a = layer("A");
    a.locked = true;
    allowDuplicate(project, comp);
    const { A } = loadHost(project, ["patchcheck.jsx"]);
    const out = A.patchcheckBegin({ comp_id: comp.id, layers: [want(a)], expect: GUARD });
    const copy = project.itemByID(out.copy_id) as FakeComp;
    expect(copy.layer(a.index)!.enabled).toBe(false);
    expect(a.locked).toBe(true);
    expect(a.enabled).toBe(true);
  });

  it("removes a half-made copy when the copy does not match the original", () => {
    const { project, comp, layer } = scene();
    const a = layer("A");
    allowDuplicate(project, comp, { renameLayers: true });
    const { A, undo } = loadHost(project, ["patchcheck.jsx"]);
    const items = project.numItems;
    expect(() => A.patchcheckBegin({ comp_id: comp.id, layers: [want(a)], expect: GUARD })).toThrow(/not the layer it should be/);
    expect(project.numItems).toBe(items);
    expect(a.enabled).toBe(true);
    expect(undo).toMatchObject({ begun: 1, ended: 1 });
  });
});

// ---------- the review fixes ----------

describe("pops are not 'ok' when no two samples are neighbours", () => {
  const spaced = (n: number, gapS: number, f: (i: number) => Parameters<typeof metrics>[1] = () => ({})) =>
    Array.from({ length: n }, (_, i) => metrics(i * gapS, { ring: 0.4 + (i % 2 ? 0.0005 : -0.0005), ...f(i) }));

  it("counts the neighbouring pairs in seriesStats", () => {
    const wide = seriesStats([0, 0.5, 1, 1.5], [0, 0, 0, 0], { fps: 25, popFactor: 3 });
    expect(wide.neighbour_pairs).toBe(0);
    const close = seriesStats([0, 0.04, 0.5, 0.54], [0, 0, 0, 0], { fps: 25, popFactor: 3 });
    expect(close.neighbour_pairs).toBe(2);
  });

  it("reports not_measurable, with the pointer to every_n 1, for samples 12 frames apart, and keeps it out of the verdict", () => {
    const j = judge(spaced(8, 0.48, (i) => ({ delta: i === 4 ? 0.2 : 0 })), okSlip, false);
    const pops = checkOf(j, "pops");
    expect(pops.verdict).toBe("not_measurable");
    expect(pops.summary).toContain("every_n 1");
    expect(pops.numbers).toMatchObject({ neighbour_pairs: 0 });
    // The big jump is still seen as a step, and the overall verdict is not a false ok built on the pops check.
    expect(j.verdict).not.toBe("ok");
    const calm = judge(spaced(8, 0.48), okSlip, false);
    expect(checkOf(calm, "pops").verdict).toBe("not_measurable");
    expect(calm.verdict).toBe("ok");
  });

  it("still finds a pop once two samples are neighbours", () => {
    const frames = spaced(8, 0.04, (i) => ({ delta: i >= 4 ? 0.2 : 0 }));
    const pops = checkOf(judge(frames, okSlip, false), "pops");
    expect(pops.verdict).not.toBe("ok");
    expect(pops.verdict).not.toBe("not_measurable");
  });
});

describe("colour channels in flicker, pops and drift", () => {
  const rgbFrames = (n: number, deltaRgb: (i: number) => [number, number, number]) =>
    Array.from({ length: n }, (_, i) => ({ ...metrics(i * 0.04, { ring: 0.4 + (i % 2 ? 0.0005 : -0.0005) }), delta_rgb: deltaRgb(i) }));

  it("sees a colour-only flicker at constant luma", () => {
    const j = judge(rgbFrames(10, (i) => [i % 2 ? 0.03 : -0.03, 0, i % 2 ? -0.03 : 0.03]), okSlip, false);
    const f = checkOf(j, "flicker");
    expect(f.verdict).toBe("fail");
    expect(["red", "blue"]).toContain(f.numbers.worst_channel);
    expect(f.numbers.per_channel).toMatchObject({ luma: 0, green: 0 });
    expect(f.summary).toContain("channel");
    const pops = checkOf(j, "pops");
    expect(pops.verdict).not.toBe("ok");
    expect((pops.numbers.pops as Array<{ channel: string }>)[0].channel).toMatch(/red|blue/);
  });

  it("sees a hue drift at constant luma", () => {
    const j = judge(rgbFrames(10, (i) => [i * 0.01, 0, -i * 0.01]), okSlip, false);
    const d = checkOf(j, "drift");
    expect(d.verdict).not.toBe("ok");
    expect(d.summary).toMatch(/red|blue/);
    expect(j.series_stats.delta_rgb).toBeDefined();
  });

  it("is quiet when the channels hold steady", () => {
    const j = judge(rgbFrames(10, () => [0, 0, 0]), okSlip, false);
    expect(checkOf(j, "flicker").verdict).toBe("ok");
    expect(checkOf(j, "drift").verdict).toBe("ok");
  });
});

describe("measureSlip under a zoom", () => {
  const W = COMP.width;
  const H = COMP.height;
  const cx = W / 2;
  const cy = H / 2;
  const box = (x: number, y: number) => x >= 75 && x < 125 && y >= 40 && y < 90;
  const zoomed = (k: number, shift = 0) => {
    const sc = 1 + 0.02 * k;
    const plate = image(W, H, (x, y) => grey(texA(cx + (x - cx) / sc, cy + (y - cy) / sc)));
    // The patch is locked to the plate (it zooms with it), 10 levels brighter; "shift" moves the patch's own texture.
    const comp = image(W, H, (x, y) => grey(texA(cx + (x - cx) / sc - (box(x, y) ? shift * k : 0), cy + (y - cy) / sc) + (box(x, y) ? 10 : 0)));
    return { time: k * 0.04, composite: grayOf(comp), plate: grayOf(plate) };
  };
  const poly: Pt[] = regionToPolygon({ kind: "rect", rect: [75, 40, 125, 90] });
  const opts = { patchSize: 15, searchPx: 12, features: 8, scale: 1, gapPx: 2, ringPx: 12 };

  it("does not call a zoom of the shot slip, and uses a similarity fitted to the ring", () => {
    const r = measureSlip([0, 1, 2, 3].map((k) => zoomed(k)), poly, opts);
    expect(r.status).toBe("ok");
    expect(r.ring_model!.similarity).toBeGreaterThan(0);
    expect(r.max_slip_px!).toBeLessThan(0.5);
  });

  it("still reads a patch that really swims during the zoom", () => {
    const r = measureSlip([0, 1, 2, 3].map((k) => zoomed(k, 1.5)), poly, opts);
    expect(r.status).toBe("ok");
    expect(r.max_slip_px!).toBeGreaterThan(2);
  });
});

describe("the render budget", () => {
  it("stops ae_patch_check at max_renders, says 'sampled N of M', lists the rest as unmeasured and still removes the copy", async () => {
    const { ctx, fns } = fakeAe();
    const out = (await tool("ae_patch_check").handler(checkArgs({ ...FRAME_TIMES, grain_probes: 0, max_renders: 6 }), ctx)) as Out;
    expect(fns().filter((f) => f === "snapshotFrame")).toHaveLength(6);
    expect(out.render_budget).toMatchObject({ max_renders: 6, cut: true });
    expect(out.render_budget.used.renders).toBe(6);
    expect(out.sampled.note).toMatch(/^sampled 3 of \d+ frames$/);
    expect(out.sampled.frames_measured).toBe(3);
    expect(out.unmeasured_frames).toHaveLength(3);
    expect(out.unmeasured_frames[0].reason).toBe("render budget reached");
    expect(out.notes.some((n: string) => n.startsWith("Render budget reached"))).toBe(true);
    expect(out.temp_comp.copy_removed).toBe(true);
    expect(out.receipt.matches).toBe(true);
    expect(fns().at(-2)).toBe("patchcheckEnd");
  });

  it("does not report a cut when everything fits", async () => {
    const { ctx } = fakeAe();
    const out = (await tool("ae_patch_check").handler(checkArgs({ ...FRAME_TIMES, grain_probes: 0 }), ctx)) as Out;
    expect(out.render_budget).toMatchObject({ cut: false, max_seconds: 90 });
    expect(out.notes.some((n: string) => n.startsWith("Render budget reached"))).toBe(false);
  });

  it("stops ae_region_stats at max_renders too", async () => {
    const { ctx, fns } = fakeAe();
    const args = AeRegionStatsSchema.parse({ comp_id: 1, regions: [{ shape: { kind: "rect", rect: [60, 25, 140, 105] } }], times: [0, 0.04, 0.08, 0.12, 0.16, 0.2], max_renders: 3 });
    const out = (await tool("ae_region_stats").handler(args, ctx)) as Out;
    expect(fns().filter((f) => f === "snapshotFrame")).toHaveLength(3);
    expect(out.render_budget).toMatchObject({ cut: true });
    expect(out.sampled.note).toMatch(/^sampled 3 of \d+ frames$/);
    expect(out.regions[0].frames.filter((f: any) => !f.usable && f.reason === "render budget reached")).toHaveLength(3);
  });
});

describe("a region that fills the frame", () => {
  it("refuses before the guard, the checkpoint and the copy when the footprint is the whole comp", async () => {
    const { ctx, fns } = fakeAe({ footprint: [[0, 0], [200, 0], [200, 130], [0, 130]] });
    const out = (await tool("ae_patch_check").handler(checkArgs(FRAME_TIMES), ctx)) as Out;
    expect(out).toMatchObject({ ok: false, error: "region_fills_frame" });
    expect(out.message).toContain("region");
    expect(fns()).toEqual(["patchcheckRead", "patchcheckRead"]);
  });

  it("refuses an explicit region that leaves no ring", async () => {
    const { ctx, fns } = fakeAe();
    const out = (await tool("ae_patch_check").handler(checkArgs({ ...FRAME_TIMES, region: { kind: "rect", rect: [-5, -5, 205, 135] } }), ctx)) as Out;
    expect(out).toMatchObject({ ok: false, error: "region_fills_frame" });
    expect(fns()).not.toContain("patchcheckBegin");
  });

  it("measures the Add-mask outline of a full-frame layer instead", async () => {
    const { ctx, fns } = fakeAe({ footprint: [[0, 0], [200, 0], [200, 130], [0, 130]], mask: REGION });
    const out = (await tool("ae_patch_check").handler(checkArgs(FRAME_TIMES), ctx)) as Out;
    expect(out.region_source).toBe("patch layer masks");
    expect(fns()).toContain("patchcheckBegin");
    expect(out.sampled.frames_measured).toBe(6);
    expect(out.notes.some((n: string) => n.includes("Add-mode masks"))).toBe(true);
  });
});

describe("a track source for the region", () => {
  const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const frame = (time: number, H: number[] | null) => ({ time, ok: H !== null, H, points: [], confidence: [], rms_px: 0, inliers: 4 });
  const track = (id: string, frames: ReturnType<typeof frame>[], size: [number, number] = [COMP.width, COMP.height]): PlanarTrack => ({
    version: 1,
    track_id: id,
    comp_id: 1,
    comp_size: size,
    fps: 25,
    ref_time: 0,
    model: "translate",
    ref_points: [[100, 65]],
    frames,
    source: "test",
    created: "2026-01-01T00:00:00.000Z",
  });
  const region = { kind: "rect", rect: [60, 25, 140, 105] };

  it("resolves a stored track_id, follows it, and marks the times it lost as unmeasured", async () => {
    saveTrack(track("trk_patch_a", [frame(0, I), frame(0.04, I), frame(0.08, null), frame(0.12, I), frame(0.16, I), frame(0.2, I)]));
    const { ctx } = fakeAe({ scene: { delta: 0 } });
    const out = (await tool("ae_patch_check").handler(checkArgs({ ...FRAME_TIMES, region, region_track: { track_id: "trk_patch_a" } }), ctx)) as Out;
    expect(out.region_track).toMatchObject({ source: "track", track_id: "trk_patch_a", solved_frames: 5, lost_frames: 1, ref_time: 0 });
    const lost = out.unmeasured_frames.find((f: any) => Math.abs(f.time - 0.08) < 1e-6);
    expect(lost.reason).toContain("track lost");
    expect(out.sampled.frames_measured).toBe(5);
  });

  it("moves the region with the track's homographies", async () => {
    saveTrack(track("trk_patch_b", [frame(0, [1, 0, 30, 0, 1, 0, 0, 0, 1])]));
    const { ctx } = fakeAe({ scene: { delta: 12 } });
    const out = (await tool("ae_patch_check").handler(checkArgs({ ...FRAME_TIMES, region, region_track: { track_id: "trk_patch_b" } }), ctx)) as Out;
    expect(verdictOf(out, "leakage")).toBe("fail");
  });

  it("refuses an unknown track and a track from a comp of another size, before anything is written", async () => {
    saveTrack(track("trk_patch_c", [frame(0, I)], [640, 360]));
    for (const [id, error] of [["trk_nope", "not_found"], ["trk_patch_c", "refused"]] as const) {
      const { ctx, fns } = fakeAe();
      const out = (await tool("ae_patch_check").handler(checkArgs({ ...FRAME_TIMES, region, region_track: { track_id: id } }), ctx)) as Out;
      expect(out).toMatchObject({ ok: false, error });
      expect(fns()).not.toContain("patchcheckBegin");
      expect(fns()).not.toContain("checkGuard");
    }
  });

  it("works for ae_region_stats regions too, read only", async () => {
    saveTrack(track("trk_patch_d", [frame(0, I), frame(0.04, I), frame(0.08, null), frame(0.12, I), frame(0.16, I), frame(0.2, I)]));
    const { ctx, fns } = fakeAe();
    const args = AeRegionStatsSchema.parse({ comp_id: 1, regions: [{ shape: region, track: { track_id: "trk_patch_d" } }], times: [0, 0.04, 0.08, 0.12, 0.16, 0.2] });
    const out = (await tool("ae_region_stats").handler(args, ctx)) as Out;
    expect(out).toMatchObject({ ok: true, read_only: true });
    expect(out.regions[0]).toMatchObject({ tracked: true, track: { source: "track", track_id: "trk_patch_d" } });
    expect(out.regions[0].frames.filter((f: any) => !f.usable)).toHaveLength(1);
    expect(fns()).not.toContain("checkGuard");
    const bad = AeRegionStatsSchema.parse({ comp_id: 1, regions: [{ shape: region, track: { track_id: "trk_nope" } }], times: [0] });
    const refused = (await tool("ae_region_stats").handler(bad, fakeAe().ctx)) as Out;
    expect(refused).toMatchObject({ ok: false, error: "not_found" });
  });

  it("still accepts raw homographies and rejects a track source without a region", () => {
    expect(AePatchCheckSchema.safeParse({ comp_id: 1, patch_layers: [{ name: "P" }], expect: expectArg, region, region_track: [{ time: 0, homography: I }] }).success).toBe(true);
    expect(AePatchCheckSchema.safeParse({ comp_id: 1, patch_layers: [{ name: "P" }], expect: expectArg, region, region_track: { track_id: "t" } }).success).toBe(true);
    expect(AePatchCheckSchema.safeParse({ comp_id: 1, patch_layers: [{ name: "P" }], expect: expectArg, region_track: { track_id: "t" } }).success).toBe(false);
  });
});

describe("patchcheck.jsx mask outline", () => {
  const maskGroup = (layer: FakeLayer, o: { mode?: number; inverted?: boolean; verts: number[][]; inT?: number[][]; outT?: number[][] }) => {
    const shape = { vertices: o.verts, inTangents: o.inT ?? o.verts.map(() => [0, 0]), outTangents: o.outT ?? o.verts.map(() => [0, 0]), closed: true };
    const g: any = new FakeGroup("Mask 1", "ADBE Mask Atom", [new FakeProperty("Mask Path", "ADBE Mask Shape", PropertyValueType.SHAPE, shape)]);
    g.maskMode = o.mode ?? 6813;
    g.inverted = o.inverted === true;
    (layer.group.property("ADBE Mask Parade") as FakeGroup).props.push(g);
    g.parentProperty = layer.group.property("ADBE Mask Parade");
  };

  it("returns the outline of an Add mask through the layer's transform, next to the footprint", () => {
    const { project, comp, layer } = scene();
    const patch = layer("Patch", { left: 0, top: 0, width: 640, height: 360 });
    patch.transform("ADBE Position").setValue([0, 0, 0]);
    maskGroup(patch, { verts: [[100, 100], [200, 100], [200, 160], [100, 160]] });
    const { A } = loadHost(project, ["patchcheck.jsx"]);
    const fp = A.patchcheckRead({ comp_id: comp.id, layers: [{ name: "Patch" }], times: [1] }).layers[0].footprints[0];
    expect(fp.polygon).toEqual([[0, 0], [640, 0], [640, 360], [0, 360]]);
    expect(fp.mask_polygon.length).toBe(4 * 8);
    const xs = fp.mask_polygon.map((q: number[]) => q[0]);
    const ys = fp.mask_polygon.map((q: number[]) => q[1]);
    expect([Math.min(...xs), Math.max(...xs)]).toEqual([100, 200]);
    expect([Math.min(...ys), Math.max(...ys)]).toEqual([100, 160]);
  });

  it("samples a curved mask along its bezier, not just its vertices", () => {
    const { project, comp, layer } = scene();
    const patch = layer("Patch", { left: 0, top: 0, width: 640, height: 360 });
    patch.transform("ADBE Position").setValue([0, 0, 0]);
    // A circle of radius 50 as four bezier vertices (kappa 0.5523).
    const k = 50 * 0.5523;
    maskGroup(patch, {
      verts: [[150, 100], [200, 150], [150, 200], [100, 150]],
      outT: [[k, 0], [0, k], [-k, 0], [0, -k]],
      inT: [[0, -k], [k, 0], [0, k], [-k, 0]],
    });
    const { A } = loadHost(project, ["patchcheck.jsx"]);
    const poly = A.patchcheckRead({ comp_id: comp.id, layers: [{ name: "Patch" }], times: [1] }).layers[0].footprints[0].mask_polygon;
    // A point on the 45 degree arc is near the circle, not on the chord between vertices.
    const onArc = poly.some((q: number[]) => Math.abs(Math.hypot(q[0] - 150, q[1] - 150) - 50) < 1.5 && q[0] > 175 && q[1] < 125);
    expect(onArc).toBe(true);
  });

  it("gives none for no mask, a subtract mask or an inverted one", () => {
    const { project, comp, layer } = scene();
    layer("Plain");
    const sub = layer("Sub");
    maskGroup(sub, { mode: 6814, verts: [[0, 0], [10, 0], [10, 10]] });
    const inv = layer("Inv");
    maskGroup(inv, { inverted: true, verts: [[0, 0], [10, 0], [10, 10]] });
    const { A } = loadHost(project, ["patchcheck.jsx"]);
    const out = A.patchcheckRead({ comp_id: comp.id, layers: [{ name: "Plain" }, { name: "Sub" }, { name: "Inv" }], times: [1] });
    for (const l of out.layers) expect(l.footprints[0].mask_polygon).toBeUndefined();
  });
});

// ---------- wave 4 review fixes ----------

describe("patchcheck review fixes: server side", () => {
  it("regionRoom does not call a small region a full frame", () => {
    const uhd = { width: 3840, height: 2160 };
    for (const side of [10, 20]) {
      const room = regionRoom(regionToPolygon({ kind: "rect", rect: [1000, 800, 1000 + side, 800 + side] }), uhd, { ringPx: 24, gapPx: 2 });
      expect(room.fills).toBe(false);
      expect(room.coverage).toBeGreaterThan(0);
      expect(room.ring_pixels).toBeGreaterThan(500);
    }
    const hd = regionRoom(regionToPolygon({ kind: "rect", rect: [100, 100, 110, 110] }), { width: 1920, height: 1080 }, { ringPx: 24, gapPx: 2 });
    expect(hd.fills).toBe(false);
    // A real full-frame region still fills it.
    const all = regionRoom(regionToPolygon({ kind: "rect", rect: [0, 0, 1920, 1080] }), { width: 1920, height: 1080 }, { ringPx: 24, gapPx: 2 });
    expect(all.fills).toBe(true);
    expect(all.coverage).toBeGreaterThan(0.9);
  });

  it("offsetPolygon grows a rectangle exactly and a negative offset shrinks it", () => {
    const rect = regionToPolygon({ kind: "rect", rect: [10, 10, 30, 20] });
    const grown = offsetPolygon(rect, 4);
    expect(polygonBounds(grown)).toEqual([6, 6, 34, 24]);
    expect(polygonBounds(offsetPolygon(rect, -2))).toEqual([12, 12, 28, 18]);
    // The same result for the other winding.
    expect(polygonBounds(offsetPolygon([...rect].reverse(), 4))).toEqual([6, 6, 34, 24]);
  });

  it("footprintPolygon grows a mask by its expansion and returns its feather", () => {
    const layer = (mask: Pt[], expand: number, feather: number): HostLayer => ({
      index: 1, id: 1, name: "P", kind: "AVLayer", enabled: true, locked: false, guide: false, three_d: false, in_point: 0, out_point: 4, parent_id: null,
      footprints: [{ time: 0, visible: true, polygon: [[0, 0], [200, 0], [200, 130], [0, 130]], mask_polygon: mask, mask_expand_px: expand, mask_feather_px: feather, reason: null }],
    });
    const f = footprintPolygon([layer([[60, 25], [140, 25], [140, 105], [60, 105]], 5, 10)], 0);
    expect(polygonBounds(f.polygon!)).toEqual([55, 20, 145, 110]);
    expect(f.feather_px).toBe(10);
    // Without a mask the layer's own quad is untouched and there is no feather.
    const plain = footprintPolygon(
      [{ ...layer([], 5, 10), footprints: [{ time: 0, visible: true, polygon: [[0, 0], [10, 0], [10, 10], [0, 10]], reason: null }] }],
      0
    );
    expect(plain.feather_px).toBe(0);
    expect(plain.polygon).toEqual([[0, 0], [10, 0], [10, 10], [0, 10]]);
  });

  it("a feathered mask edge does not read as leakage when the feather is given, and does when it is not", () => {
    const t = 0.4;
    const base = compositeImage(t, { delta: 0 });
    // The patch also changes a 4 px band outside the region: AE's feather, centred on the edge.
    const withBand = image(COMP.width, COMP.height, (x, y) => {
      const i = (y * COMP.width + x) * 4;
      const band = x >= 56 && x < 144 && y >= 21 && y < 109 && !inRegion(x, y);
      return band ? grey(base.data[i] + 40) : [base.data[i], base.data[i + 1], base.data[i + 2], 255];
    });
    const run = (featherPx?: number) => analyseFrame({ time: t, composite: withBand, plate: plateImage(t), polyComp: REGION, comp: COMP, opts: FOPTS, featherPx });
    expect(run().difference!.leaked_pixels).toBeGreaterThan(16);
    expect(run(10).difference!.leaked_pixels).toBe(0);
    // The ring starts beyond the feather: its brightness is the plate's, not the patch's band.
    expect(Math.abs(run(10).delta_luma!)).toBeLessThan(0.03);
  });

  it("counts leaked pixels in comp pixels, whatever the render resolution", () => {
    const half = (img: ReturnType<typeof image>) => image(100, 65, (x, y) => [img.data[(y * 2 * img.width + x * 2) * 4], img.data[(y * 2 * img.width + x * 2) * 4 + 1], img.data[(y * 2 * img.width + x * 2) * 4 + 2], 255]);
    const full1 = analyseFrame({ time: 0, composite: compositeImage(0, { delta: 0, leak: true }), plate: plateImage(0), polyComp: REGION, comp: COMP, opts: FOPTS });
    const half1 = analyseFrame({ time: 0, composite: half(compositeImage(0, { delta: 0, leak: true })), plate: half(plateImage(0)), polyComp: REGION, comp: COMP, opts: FOPTS });
    expect(half1.difference!.leaked_pixels).toBeGreaterThan(full1.difference!.leaked_pixels * 0.7);
    expect(half1.difference!.leaked_pixels).toBeLessThan(full1.difference!.leaked_pixels * 1.3);
  });

  it("planSamples with explicit times honours max_samples, keeps the reference frame and counts M over the times asked for", () => {
    const base = { fps: 25, duration: 10, workStart: 0, workDuration: 10, maxSamples: 24 };
    const times = Array.from({ length: 40 }, (_, i) => i * 0.04);
    const p = planSamples({ ...base, times, maxSamples: 10, refTime: 9 });
    expect(p.times).toHaveLength(10);
    expect(p.times).toContain(9);
    expect(p.ref_time).toBe(9);
    expect(p.capped).toBe(true);
    expect(p.total_frames).toBe(40);
    expect(p.range[0]).toBe(0);
    const few = planSamples({ ...base, times: [1, 2], maxSamples: 10 });
    expect(few.times).toEqual([1, 2]);
    expect(few.total_frames).toBe(26);
    expect(few.capped).toBe(false);
  });

  it("planSamples thins explicit times evenly, keeping the first and last, and says how many were dropped", () => {
    const base = { fps: 25, duration: 25, workStart: 0, workDuration: 25, maxSamples: 24 };
    const times = Array.from({ length: 40 }, (_, i) => i * 0.5);
    const p = planSamples({ ...base, times });
    expect(p.times).toHaveLength(24);
    expect(p.times[0]).toBe(0);
    expect(p.times.at(-1)).toBeCloseTo(19.5, 1);
    expect(p.capped).toBe(true);
    expect(p.times_dropped).toBe(16);
    expect(cappedNote(p)).toMatch(/16 of the frames given in `times` were dropped/);
    const one = planSamples({ ...base, times, maxSamples: 2, refTime: 7 });
    expect(one.times).toHaveLength(2);
    expect(one.times).toContain(7);
    expect(cappedNote(planSamples({ ...base, everyN: 1, maxSamples: 10 }))).toBe("max_samples forced a larger step than every_n");
    expect(cappedNote(planSamples({ ...base, times: [1, 2] }))).toBeNull();
    // The note claims the first and last only when both were kept: here the reference took the second slot.
    expect(one.times[0]).toBe(0);
    expect(cappedNote(one)).toContain("the last time asked for did not fit");
    expect(cappedNote(one)).not.toContain("first and last included");
    expect(cappedNote(p)).toContain("the first and last included");
    // A reference before everything asked for, and one slot only: the first time asked for gives way.
    const neither = planSamples({ ...base, times: [5, 6, 7, 8], maxSamples: 1, refTime: 2 });
    expect(neither.times).toEqual([2]);
    expect(cappedNote(neither)).toContain("neither the first nor the last time asked for fit");
  });

  it("slipCropFits keeps the gray crops under the memory cap", () => {
    expect(slipCropFits(0, 4_000_000)).toBe(true);
    expect(slipCropFits(240_000_000, 4_000_000)).toBe(false);
    expect(slipCropFits(100, 1000, 8100)).toBe(true);
    expect(slipCropFits(100, 1000, 8099)).toBe(false);
  });

  it("linear luma percentiles are in linear light like the mean", () => {
    const grey128 = image(10, 10, () => grey(128));
    const enc = lumaPercentiles(grey128, full(10, 10));
    const lin = lumaPercentiles(grey128, full(10, 10), 0.5, { linear: true });
    expect(enc.p50).toBeCloseTo(128 / 255, 2);
    expect(lin.p50).toBeCloseTo(srgbToLinear(128 / 255), 2);
    const stats = regionFrameStats({ time: 0, img: image(200, 130, () => grey(128)), comp: COMP, polyComp: poly0(), linear: true });
    expect(stats.luma!.mean).toBeCloseTo(srgbToLinear(128 / 255), 2);
    expect(stats.luma!.p50).toBeCloseTo(stats.luma!.mean, 1);
  });

  it("starts no pair with one render left", async () => {
    const { ctx, fns } = fakeAe();
    const out = (await tool("ae_patch_check").handler(checkArgs({ ...FRAME_TIMES, grain_probes: 0, max_renders: 5 }), ctx)) as Out;
    const renders = fns().filter((f) => f === "snapshotFrame").length;
    expect(renders).toBeLessThanOrEqual(5);
    expect(out.render_budget.used.renders).toBe(renders);
    expect(out.render_budget.cut).toBe(true);
    expect(out.sampled.frames_measured).toBe(2);
  });

  it("counts a stale-frame retry as a render in ae_region_stats", async () => {
    const run = async (stale: boolean) => {
      const { ctx } = fakeAe();
      staleHook.nudgeFirst = stale;
      const args = AeRegionStatsSchema.parse({ comp_id: 1, regions: [{ shape: { kind: "rect", rect: [60, 25, 140, 105] } }], times: [0, 0.04, 0.08], max_renders: 10 });
      const out = (await tool("ae_region_stats").handler(args, ctx)) as Out;
      staleHook.nudgeFirst = false;
      return out.render_budget.used.renders as number;
    };
    expect(await run(false)).toBe(3);
    expect(await run(true)).toBe(4);
  });

  it("says when max_samples dropped some of the explicit times, in both tools", async () => {
    const times = Array.from({ length: 12 }, (_, i) => i * 0.04);
    const a = fakeAe();
    const out = (await tool("ae_patch_check").handler(checkArgs({ times, max_samples: 6, grain_probes: 0 }), a.ctx)) as Out;
    expect(out.sampled.capped).toMatch(/6 of the frames given in `times` were dropped/);
    expect(out.sampled.times[0]).toBe(0);
    expect(out.sampled.times.at(-1)).toBeCloseTo(0.44, 4);
    const b = fakeAe();
    const stats = (await tool("ae_region_stats").handler(AeRegionStatsSchema.parse({ comp_id: 1, regions: [{ shape: { kind: "rect", rect: [60, 25, 140, 105] } }], times, max_samples: 4 }), b.ctx)) as Out;
    expect(stats.sampled.capped).toMatch(/8 of the frames given in `times` were dropped/);
    expect(stats.sampled.frames_sampled).toBe(4);
  });

  it("allows for the mask feather in the ring pre-check: a feather that pushes the ring off the frame refuses before the copy", async () => {
    const footprint: Array<[number, number]> = [[25, 0], [200, 0], [200, 130], [25, 130]];
    const plain = fakeAe({ footprint });
    const ok = (await tool("ae_patch_check").handler(checkArgs({ ...FRAME_TIMES, grain_probes: 0 }), plain.ctx)) as Out;
    expect(ok.error).not.toBe("region_fills_frame");
    const soft = fakeAe({ footprint, feather: 60 });
    const out = (await tool("ae_patch_check").handler(checkArgs(FRAME_TIMES), soft.ctx)) as Out;
    expect(out).toMatchObject({ ok: false, error: "region_fills_frame" });
    expect(soft.fns()).toEqual(["patchcheckRead", "patchcheckRead"]);
  });

  it("names the opposite meaning of isolate_layers on ae_region_stats' hide_layers", () => {
    const def = patchcheckTools.find((t) => t.name === "ae_region_stats")!;
    expect(def.description).toContain("isolate_layers");
    expect(def.description).toContain("switched off");
    expect(() => AeRegionStatsSchema.parse({ comp_id: 1, regions: [{ shape: { kind: "rect", rect: [1, 1, 9, 9] } }], hide_layers: [{ name: "P" }] })).toThrow(/give `expect`/);
  });
});

describe("patchcheck.jsx review fixes: pins, mask grow, open paths, thinning, pixel aspect", () => {
  const addEffect = (layer: FakeLayer, matchName: string, name: string, pts?: number[][], enabled = true) => {
    const props = pts
      ? pts.map((v, i) => new FakeProperty(["Upper Left", "Upper Right", "Lower Left", "Lower Right"][i], matchName === "ADBE Corner Pin" ? `ADBE Corner Pin-000${i + 1}` : `p${i}`, PropertyValueType.TwoD_SPATIAL, v))
      : [];
    const fx: any = new FakeGroup(name, matchName, props);
    fx.enabled = enabled;
    (layer.group.property("ADBE Effect Parade") as FakeGroup).props.push(fx);
    fx.parentProperty = layer.group.property("ADBE Effect Parade");
    return fx;
  };
  const addMask = (layer: FakeLayer, o: { verts: number[][]; closed?: boolean; expand?: number; feather?: number[] }) => {
    const shape = { vertices: o.verts, inTangents: o.verts.map(() => [0, 0]), outTangents: o.verts.map(() => [0, 0]), closed: o.closed !== false };
    const props = [new FakeProperty("Mask Path", "ADBE Mask Shape", PropertyValueType.SHAPE, shape)];
    if (o.expand !== undefined) props.push(new FakeProperty("Mask Expansion", "ADBE Mask Offset", PropertyValueType.OneD, o.expand));
    if (o.feather) props.push(new FakeProperty("Mask Feather", "ADBE Mask Feather", PropertyValueType.TwoD, o.feather));
    const g: any = new FakeGroup("Mask 1", "ADBE Mask Atom", props);
    g.maskMode = 6813;
    g.inverted = false;
    (layer.group.property("ADBE Mask Parade") as FakeGroup).props.push(g);
    g.parentProperty = layer.group.property("ADBE Mask Parade");
  };
  const read = (project: FakeProject, comp: FakeComp, name = "Patch") => {
    const { A } = loadHost(project, ["patchcheck.jsx"]);
    return A.patchcheckRead({ comp_id: comp.id, layers: [{ name }], times: [1] }).layers[0].footprints[0];
  };

  it("follows a Corner Pin: the footprint is the pinned quad, and a mask is warped with it", () => {
    const { project, comp, layer } = scene();
    const patch = layer("Patch", { left: 0, top: 0, width: 100, height: 50 });
    patch.transform("ADBE Position").setValue([0, 0, 0]);
    // Upper left, upper right, lower left, lower right: an axis-aligned quad 200 wide at (300, 100).
    addEffect(patch, "ADBE Corner Pin", "Corner Pin", [[300, 100], [500, 100], [300, 200], [500, 200]]);
    const fp = read(project, comp);
    expect(fp.polygon).toEqual([[300, 100], [500, 100], [500, 200], [300, 200]]);
    expect(fp.visible).toBe(true);
    addMask(patch, { verts: [[0, 0], [50, 0], [50, 25], [0, 25]] });
    const fm = read(project, comp);
    const xs = fm.mask_polygon.map((q: number[]) => q[0]);
    const ys = fm.mask_polygon.map((q: number[]) => q[1]);
    // The left half, top half of the layer lands on the left half, top half of the quad.
    expect([Math.min(...xs), Math.max(...xs)]).toEqual([300, 400]);
    expect([Math.min(...ys), Math.max(...ys)]).toEqual([100, 150]);
  });

  it("follows a perspective Corner Pin and a disabled one is ignored", () => {
    const { project, comp, layer } = scene();
    const patch = layer("Patch", { left: 0, top: 0, width: 100, height: 50 });
    patch.transform("ADBE Position").setValue([0, 0, 0]);
    const fx = addEffect(patch, "ADBE Corner Pin", "Corner Pin", [[310, 100], [490, 100], [300, 200], [500, 200]]);
    expect(read(project, comp).polygon).toEqual([[310, 100], [490, 100], [500, 200], [300, 200]]);
    fx.enabled = false;
    expect(read(project, comp).polygon).toEqual([[0, 0], [100, 0], [100, 50], [0, 50]]);
  });

  it("gives no footprint, with the reason, for a Transform or Motion Tile effect", () => {
    const { project, comp, layer } = scene();
    const patch = layer("Patch");
    addEffect(patch, "ADBE Geometry2", "Transform");
    const fp = read(project, comp);
    expect(fp.polygon).toBeNull();
    expect(fp.reason).toMatch(/Transform effect.*give region/);
    const other = layer("Other");
    addEffect(other, "ADBE Tile", "Motion Tile");
    expect(read(project, comp, "Other").reason).toMatch(/Motion Tile/);
  });

  it("returns a mask's expansion and feather in comp pixels", () => {
    const { project, comp, layer } = scene();
    const patch = layer("Patch", { left: 0, top: 0, width: 640, height: 360 });
    patch.transform("ADBE Position").setValue([0, 0, 0]);
    patch.transform("ADBE Scale").setValue([200, 200, 100]);
    addMask(patch, { verts: [[10, 10], [60, 10], [60, 40], [10, 40]], expand: 3, feather: [4, 8] });
    const fp = read(project, comp);
    expect(fp.mask_expand_px).toBe(6);
    expect(fp.mask_feather_px).toBe(16);
  });

  it("returns a negative mask expansion (a choke) as it is, and several masks never shrink the box", () => {
    const { project, comp, layer } = scene();
    const patch = layer("Patch", { left: 0, top: 0, width: 640, height: 360 });
    patch.transform("ADBE Position").setValue([0, 0, 0]);
    patch.transform("ADBE Scale").setValue([200, 200, 100]);
    addMask(patch, { verts: [[10, 10], [60, 10], [60, 40], [10, 40]], expand: -3 });
    expect(read(project, comp).mask_expand_px).toBe(-6);
    addMask(patch, { verts: [[70, 10], [90, 10], [90, 40], [70, 40]], expand: -2 });
    expect(read(project, comp).mask_expand_px).toBeUndefined();
  });

  it("reads CC Power Pin points by display name, like ae_track_apply, whatever their order", () => {
    const { project, comp, layer } = scene();
    const patch = layer("Patch", { left: 0, top: 0, width: 100, height: 50 });
    patch.transform("ADBE Position").setValue([0, 0, 0]);
    const mk = (name: string, v: number[], i: number) => new FakeProperty(name, `p${i}`, PropertyValueType.TwoD_SPATIAL, v);
    const fx: any = new FakeGroup("CC Power Pin", "CC Power Pin", [
      mk("Top Left", [300, 100], 0),
      mk("Top Right", [500, 100], 1),
      mk("Bottom Left", [300, 200], 2),
      mk("Bottom Right", [500, 200], 3),
      mk("Unpin", [0, 0], 4),
    ]);
    fx.enabled = true;
    (patch.group.property("ADBE Effect Parade") as FakeGroup).props.push(fx);
    expect(read(project, comp).polygon).toEqual([[300, 100], [500, 100], [500, 200], [300, 200]]);
    // The same points listed in another order are still found by name.
    fx.props = [fx.props[3], fx.props[1], fx.props[2], fx.props[0], fx.props[4]];
    expect(read(project, comp).polygon).toEqual([[300, 100], [500, 100], [500, 200], [300, 200]]);
  });

  it("maps a pinned layer's mask through the layer's own rectangle, not the content box", () => {
    const { project, comp, layer } = scene();
    // A text-like layer: comp-size layer (width 640 x 360) whose content box is only 100 x 50 at (20, 10).
    const patch = layer("Patch", { left: 20, top: 10, width: 100, height: 50 });
    (patch as any).width = 640;
    (patch as any).height = 360;
    patch.transform("ADBE Position").setValue([0, 0, 0]);
    addEffect(patch, "ADBE Corner Pin", "Corner Pin", [[0, 0], [1280, 0], [0, 720], [1280, 720]]);
    addMask(patch, { verts: [[0, 0], [320, 0], [320, 180], [0, 180]], expand: 1 });
    const fp = read(project, comp);
    const xs = fp.mask_polygon.map((q: number[]) => q[0]);
    // The pin doubles the layer: the left half of the 640 px layer ends at x = 640 and the expansion is doubled.
    expect(Math.max(...xs)).toBeCloseTo(640, 0);
    expect(fp.mask_expand_px).toBe(2);
  });

  it("skips an open mask path", () => {
    const { project, comp, layer } = scene();
    const patch = layer("Patch", { left: 0, top: 0, width: 640, height: 360 });
    patch.transform("ADBE Position").setValue([0, 0, 0]);
    addMask(patch, { verts: [[10, 10], [60, 10], [60, 40]], closed: false });
    expect(read(project, comp).mask_polygon).toBeUndefined();
  });

  it("thins a mask with more than 160 vertices to at most 160 points", () => {
    const { project, comp, layer } = scene();
    const patch = layer("Patch", { left: 0, top: 0, width: 640, height: 360 });
    patch.transform("ADBE Position").setValue([0, 0, 0]);
    const verts: number[][] = [];
    for (let i = 0; i < 1000; i++) verts.push([200 + 80 * Math.cos((i / 1000) * 2 * Math.PI), 150 + 80 * Math.sin((i / 1000) * 2 * Math.PI)]);
    addMask(patch, { verts });
    const poly = read(project, comp).mask_polygon;
    expect(poly.length).toBeLessThanOrEqual(160);
    expect(poly.length).toBeGreaterThan(50);
  });

  it("stretches the footprint by the source pixel aspect over the comp's", () => {
    const { project, comp, layer } = scene();
    const patch = layer("Patch", { left: 0, top: 0, width: 100, height: 50 });
    patch.transform("ADBE Position").setValue([0, 0, 0]);
    (patch as any).source = { pixelAspect: 2 };
    (comp as any).pixelAspect = 1;
    expect(read(project, comp).polygon).toEqual([[0, 0], [200, 0], [200, 50], [0, 50]]);
  });
});
