import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PNG } from "pngjs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import { applyH, identityH, layerMatrix, mulH, type Mat3, type PlanarFrame, type PlanarTrack, type Vec2 } from "../src/tools/ext/planar-math.js";
import { saveTrack } from "../src/tools/ext/planar.js";
import {
  AeScreenCornersSchema,
  AeScreenReplaceSchema,
  buildInsertKeys,
  cornerExcursions,
  cornerPeak,
  drawBeforeAfterSheet,
  estimateAspect,
  fitLine,
  insertCompSize,
  intersectLines,
  lumaQuantiles,
  nearestCommonRatio,
  pickSheetFrames,
  planLevels,
  planSampleTimes,
  quadEdgeSigma,
  quadMetrics,
  replaceMismatches,
  scaleQuad,
  scanSide,
  screenrepTools,
  snapQuad,
  sobel,
  suggestPoints,
  type ReplacePlan,
} from "../src/tools/ext/screenrep.js";
import { toGray } from "../src/tools/ext/track.js";
import { polygonArea } from "../src/tools/ext/region-math.js";
import { FakeGroup, FakeLayer, FakeProject, FakeProperty, GUARD, loadHost, PropertyValueType, type FakeComp } from "./support/fake-ae.js";

// The track store and the frame folder live under the data dir: keep them out of the real one.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-screenrep-"));
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

const tool = (name: string) => screenrepTools.find((t) => t.name === name)!;
const expectArg = { project_path: "<unsaved>" };
type Out = Record<string, any>;
const dist = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// ---------- synthetic pictures ----------

/** Standard normal CDF (Abramowitz and Stegun 7.1.26). */
function phi(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/** Signed distance to a convex quad (positive inside), exact near the edges, a lower bound far away. */
function quadDistance(q: Vec2[], x: number, y: number): number {
  const area = q.reduce((s, p, i) => s + (p[0] * q[(i + 1) % 4][1] - q[(i + 1) % 4][0] * p[1]), 0);
  const sgn = area > 0 ? 1 : -1;
  let d = Infinity;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    d = Math.min(d, (sgn * ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]))) / len);
  }
  return d;
}

interface SceneOpts {
  /** Edge softness (Gaussian sigma, px) of the outer edge. */
  sigma?: number;
  outside?: number;
  inside?: (x: number, y: number) => number;
  /** A second, inner edge this many px inside the first, whose inside is `innerValue`. */
  inner?: { inset: number; value: number };
  roundedCorners?: number;
}

function scene(w: number, h: number, quad: Vec2[], o: SceneOpts = {}): PNG {
  const png = new PNG({ width: w, height: h });
  const sigma = Math.max(0.05, o.sigma ?? 0.4);
  const out = o.outside ?? 40;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let d = quadDistance(quad, x + 0.5, y + 0.5);
      // A rounded corner takes a bite out of the quad's corner region only.
      if (o.roundedCorners) {
        for (const c of quad) {
          const dc = Math.hypot(c[0] - (x + 0.5), c[1] - (y + 0.5));
          if (dc < o.roundedCorners * 1.5 && d > -2) d = Math.min(d, dc - o.roundedCorners * 0.3);
        }
      }
      const inner = o.inner ? o.inner.value : (o.inside ? o.inside(x, y) : 120);
      const innerBase = o.inside ? o.inside(x, y) : 120;
      let v = out + (innerBase - out) * phi(d / sigma);
      if (o.inner) {
        const e = d - o.inner.inset;
        v = v + (inner - innerBase) * phi(e / sigma);
        // the inner edge must not light up outside the quad
        if (d < 0) v = out + (innerBase - out) * phi(d / sigma);
      }
      const i = (y * w + x) * 4;
      png.data[i] = png.data[i + 1] = png.data[i + 2] = Math.max(0, Math.min(255, Math.round(v)));
      png.data[i + 3] = 255;
    }
  }
  return png;
}

const W = 320;
const H = 200;
// A screen seen from a slight angle (UL, UR, LR, LL).
const SCREEN: Vec2[] = [
  [80, 50],
  [240, 56],
  [236, 150],
  [84, 146],
];
/** Content with some texture, so the pattern test has something to read. */
const content = (x: number, y: number): number => 90 + 60 * Math.sin(x * 0.21) * Math.cos(y * 0.17) + 20 * Math.sin(x * 0.07 + y * 0.11);

// ---------- pure: edges and corners ----------

describe("edge scan, line fit and snapping", () => {
  const png = scene(W, H, SCREEN, { sigma: 0.6 });
  const gray = toGray(png);

  it("finds the edge along a side, within a pixel, preferring the outer one", () => {
    const gr = sobel(gray);
    // The top side: UL -> UR, outward is up (negative y); guessed 3 px too low.
    const a: Vec2 = [80, 53];
    const b: Vec2 = [240, 59];
    const scan = scanSide(gr, a, b, [0.0, -1], { searchPx: 10, prefer: "outer" });
    expect(scan.found).toBeGreaterThan(scan.expected * 0.8);
    const line = fitLine(scan.points)!;
    expect(line).not.toBeNull();
    expect(line.inliers).toBeGreaterThan(scan.found * 0.9);
    expect(line.rms).toBeLessThan(0.3);
    // The true top edge passes (80, 50) and (240, 56); pixel-index coordinates are edge coordinates minus 0.5.
    const at = (x: number) => 50 + (6 * (x - 80)) / 160 - 0.5;
    const yAtX160 = line.c[1] + ((160 - line.c[0]) / line.dir[0]) * line.dir[1];
    expect(Math.abs(yAtX160 - at(160))).toBeLessThan(0.7);
  });

  it("fits a line through outliers", () => {
    const pts: Vec2[] = [];
    for (let i = 0; i < 40; i++) pts.push([i * 3, 10 + i * 0.5]);
    pts[5] = [15, 40];
    pts[17] = [51, -20];
    pts[30] = [90, 70];
    const line = fitLine(pts)!;
    expect(line.inliers).toBe(37);
    expect(line.rms).toBeLessThan(1e-6);
    expect(Math.abs(line.dir[1] / line.dir[0] - 1 / 6)).toBeLessThan(1e-9);
    expect(fitLine(pts.slice(0, 5))).toBeNull();
  });

  it("intersects lines, and refuses near-parallel ones", () => {
    const h = { c: [0, 5] as Vec2, dir: [1, 0] as Vec2, inliers: 10, total: 10, rms: 0 };
    const v = { c: [7, 0] as Vec2, dir: [0, 1] as Vec2, inliers: 10, total: 10, rms: 0 };
    expect(intersectLines(h, v)).toEqual([7, 5]);
    const flat = { c: [0, 6] as Vec2, dir: [Math.cos(0.1), Math.sin(0.1)] as Vec2, inliers: 10, total: 10, rms: 0 };
    expect(intersectLines(h, flat)).toBeNull();
  });

  it("snaps corner guesses a few pixels off to the real corners", () => {
    const guesses: Vec2[] = [
      [84, 46],
      [236, 60],
      [240, 146],
      [80, 150],
    ];
    const guessImg = guesses.map((p) => [p[0] - 0.5, p[1] - 0.5] as Vec2);
    const { corners } = snapQuad(gray, guessImg, { searchPx: 12, prefer: "outer", patchSize: 15 });
    corners.forEach((c, i) => {
      expect(c.method).toBe("edge_intersection");
      // Edge coordinates are the true corner: index coordinates + 0.5.
      expect(dist([c.snapped[0] + 0.5, c.snapped[1] + 0.5], SCREEN[i])).toBeLessThan(0.8);
      expect(c.confidence).toBeGreaterThan(0.6);
      expect(c.shift_px).toBeGreaterThan(2);
    });
  });

  it("snaps on rounded bezels, where the corner itself is not a feature", () => {
    const rounded = scene(W, H, SCREEN, { sigma: 0.6, roundedCorners: 14 });
    const g = toGray(rounded);
    const guessImg = SCREEN.map((p, i) => [p[0] - 0.5 + (i % 2 ? -4 : 4), p[1] - 0.5 + (i < 2 ? 3 : -3)] as Vec2);
    const { corners } = snapQuad(g, guessImg, { searchPx: 12, prefer: "outer", patchSize: 15 });
    corners.forEach((c, i) => {
      expect(c.method).toBe("edge_intersection");
      expect(dist([c.snapped[0] + 0.5, c.snapped[1] + 0.5], SCREEN[i])).toBeLessThan(1.2);
    });
  });

  it("takes the outer of two competing edges, the inner one on request, and lowers the confidence", () => {
    const two = scene(W, H, SCREEN, { sigma: 0.6, inner: { inset: 7, value: 200 } });
    const g = toGray(two);
    const guessImg = SCREEN.map((p) => [p[0] - 0.5, p[1] - 0.5] as Vec2);
    const outer = snapQuad(g, guessImg, { searchPx: 14, prefer: "outer", patchSize: 15 });
    const inner = snapQuad(g, guessImg, { searchPx: 14, prefer: "inner", patchSize: 15 });
    expect(dist([outer.corners[0].snapped[0] + 0.5, outer.corners[0].snapped[1] + 0.5], SCREEN[0])).toBeLessThan(1.2);
    expect(dist(inner.corners[0].snapped, outer.corners[0].snapped)).toBeGreaterThan(4);
    expect(outer.corners[0].competing_share).toBeGreaterThan(0.5);
    const clean = snapQuad(gray, guessImg, { searchPx: 14, prefer: "outer", patchSize: 15 });
    expect(outer.corners[0].confidence).toBeLessThan(clean.corners[0].confidence);
  });

  it("falls back to the corner response, and leaves a flat area unchanged", () => {
    // A bright block with a corner but a side too short for a line.
    const png2 = new PNG({ width: 100, height: 100 });
    for (let i = 0; i < 100 * 100; i++) png2.data.set([30, 30, 30, 255], i * 4);
    for (let y = 40; y < 100; y++) for (let x = 40; x < 100; x++) png2.data.set([200, 200, 200, 255], (y * 100 + x) * 4);
    const gr = sobel(toGray(png2));
    const peak = cornerPeak(gr, 44, 44, 8)!;
    expect(dist([peak.x, peak.y], [39.5, 39.5])).toBeLessThan(2.5);
    const flat = new PNG({ width: 60, height: 60 });
    for (let i = 0; i < 3600; i++) flat.data.set([90, 90, 90, 255], i * 4);
    expect(cornerPeak(sobel(toGray(flat)), 30, 30, 10)).toBeNull();
    const out = snapQuad(toGray(flat), [[10, 10], [50, 10], [50, 50], [10, 50]], { searchPx: 6, prefer: "outer", patchSize: 9 });
    out.corners.forEach((c) => {
      expect(c.method).toBe("unchanged");
      expect(c.shift_px).toBe(0);
      expect(c.confidence).toBeLessThan(0.2);
      expect(c.trackable).toBe(false);
    });
  });

  it("reports trackability from the template contrast", () => {
    const textured = scene(W, H, SCREEN, { sigma: 0.6, inside: content });
    const flat = scene(W, H, SCREEN, { sigma: 0.6 });
    const guessImg = SCREEN.map((p) => [p[0] - 0.5, p[1] - 0.5] as Vec2);
    const t = snapQuad(toGray(textured), guessImg, { searchPx: 8, prefer: "outer", patchSize: 21 });
    expect(t.corners.every((c) => c.trackable && (c.template_std ?? 0) >= 3)).toBe(true);
    // A patch fully in a flat area (inside the screen) is not trackable: shrink the quad's corners inward.
    const f = snapQuad(toGray(flat), SCREEN.map((p) => [p[0] - 0.5 + (p[0] < 160 ? 40 : -40), p[1] - 0.5 + (p[1] < 100 ? 25 : -25)] as Vec2), { searchPx: 4, prefer: "outer", patchSize: 9 });
    expect(f.corners.every((c) => c.method === "unchanged" || c.method === "corner_response")).toBe(true);
  });
});

// ---------- pure: aspect ratio ----------

describe("estimateAspect", () => {
  /** Project a w x h rectangle seen by a pinhole camera of focal f at an angle. */
  function project(w: number, h: number, f: number, yaw: number, pitch: number, size: Vec2): Vec2[] {
    const world: Array<[number, number, number]> = [
      [-w / 2, -h / 2, 0],
      [w / 2, -h / 2, 0],
      [w / 2, h / 2, 0],
      [-w / 2, h / 2, 0],
    ];
    return world.map(([x, y, z]) => {
      const x1 = Math.cos(yaw) * x + Math.sin(yaw) * z;
      const z1 = -Math.sin(yaw) * x + Math.cos(yaw) * z;
      const y2 = Math.cos(pitch) * y - Math.sin(pitch) * z1;
      const z2 = Math.sin(pitch) * y + Math.cos(pitch) * z1 + 2400;
      return [(f * x1) / z2 + size[0] / 2, (f * y2) / z2 + size[1] / 2] as Vec2;
    });
  }

  it("recovers the true aspect and the focal length from a view in perspective", () => {
    for (const [w, h, yaw, pitch] of [
      [1600, 900, 0.5, 0.2],
      [1000, 1000, -0.4, 0.3],
      [900, 1600, 0.35, -0.25],
      [2390, 1000, 0.6, 0.1],
    ] as Array<[number, number, number, number]>) {
      const quad = project(w, h, 1000, yaw, pitch, [1000, 600]);
      const est = estimateAspect(quad, [500, 300]);
      expect(est.method).toBe("perspective");
      expect(Math.abs(est.aspect / (w / h) - 1)).toBeLessThan(0.01);
      expect(Math.abs((est.focal_px as number) / 1000 - 1)).toBeLessThan(0.02);
      expect(est.range[0]).toBeLessThanOrEqual(est.aspect + 1e-9);
      expect(est.range[1]).toBeGreaterThanOrEqual(est.aspect - 1e-9);
    }
  });

  it("falls back to the edge lengths without perspective, and finds the familiar ratio", () => {
    const est = estimateAspect([[100, 100], [260, 100], [260, 190], [100, 190]], [320, 200]);
    expect(est.method).toBe("edge_lengths");
    expect(est.aspect).toBeCloseTo(160 / 90, 6);
    expect(est.range[0]).toBe(est.range[1]);
    expect(est.focal_px).toBeNull();
    expect(est.common_ratio?.name).toBe("16:9");
    expect(nearestCommonRatio(1.3)?.name).toBe("4:3");
    expect(nearestCommonRatio(1.7)).toBeNull();
    expect(nearestCommonRatio(0.5625)?.name).toBe("9:16");
  });

  it("a yaw-only view (one vanishing point at infinity) is not read as 'no perspective'", () => {
    const truth = 16 / 9;
    const quad = project(1600, 900, 1500, 0.6, 0, [1920, 1080]);
    const est = estimateAspect(quad, [960, 540]);
    expect(est.method).toBe("assumed_focal");
    expect(est.range[1] - est.range[0]).toBeGreaterThan(0.05);
    expect(est.range[0]).toBeLessThanOrEqual(truth);
    expect(est.range[1]).toBeGreaterThanOrEqual(truth);
    // The same view with corner noise: the focal length solves to nonsense, the range still holds the truth.
    const patterns: number[][][] = [
      [[0.4, -0.3], [-0.3, 0.5], [0.5, 0.3], [-0.4, -0.5]],
      [[0.3, 0.4], [0.3, -0.4], [-0.3, 0.4], [-0.3, -0.4]],
      [[0.4, 0.3], [-0.3, -0.5], [0.5, -0.3], [-0.4, 0.5]],
    ];
    let seed = 12345;
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    for (let k = 0; k < 60; k++) patterns.push([0, 1, 2, 3].map(() => [(rnd() - 0.5) * 0.8, (rnd() - 0.5) * 0.8]));
    for (const noise of patterns) {
      const noisy = quad.map((c, i) => [c[0] + noise[i][0], c[1] + noise[i][1]] as Vec2);
      const en = estimateAspect(noisy, [960, 540]);
      expect(en.range[0]).toBeLessThanOrEqual(truth);
      expect(en.range[1]).toBeGreaterThanOrEqual(truth);
      expect(en.range[1] - en.range[0]).toBeGreaterThan(0.02);
    }
  });

  it("gives a wider range the more the focal length matters", () => {
    const quad = project(1600, 900, 1000, 0.5, 0.2, [1000, 600]);
    const est = estimateAspect(quad, [500, 300]);
    expect(est.range[1] - est.range[0]).toBeGreaterThan(0);
  });
});

// ---------- pure: measuring ----------

describe("measurements", () => {
  it("reads the softness of an edge", () => {
    const rect: Vec2[] = [
      [60, 40],
      [260, 40],
      [260, 160],
      [60, 160],
    ];
    const sharp = scene(W, H, rect, { sigma: 0.15 });
    const soft = scene(W, H, rect, { sigma: 1.6 });
    const quadImg = rect.map((p) => [p[0] - 0.5, p[1] - 0.5] as Vec2);
    const s1 = quadEdgeSigma(toGray(sharp), quadImg, 1);
    const s2 = quadEdgeSigma(toGray(soft), quadImg, 1);
    expect(s1.sigma_px).not.toBeNull();
    expect(s2.sigma_px).not.toBeNull();
    expect(s1.sigma_px as number).toBeLessThan(0.5);
    expect(Math.abs((s2.sigma_measured_px as number) / 1.6 - 1)).toBeLessThan(0.2);
    // The half-resolution snapshot's own softening is taken out.
    const s3 = quadEdgeSigma(toGray(soft), quadImg, 0.5);
    expect(s3.sigma_px as number).toBeLessThan(s3.sigma_measured_px as number);
  });

  it("says why an edge could not be read", () => {
    const rect: Vec2[] = [[60, 40], [260, 40], [260, 160], [60, 160]];
    const faint = scene(W, H, rect, { sigma: 0.5, outside: 118, inside: () => 121 });
    const r = quadEdgeSigma(toGray(faint), rect, 1);
    expect(r.sigma_px).toBeNull();
    expect(r.reason).toMatch(/under 6 gray levels|too few/);
    const edge = quadEdgeSigma(toGray(faint), [[2, 2], [30, 2], [30, 30], [2, 30]], 1);
    expect(edge.sigma_px).toBeNull();
  });

  it("takes luma quantiles under a mask", () => {
    const img = new PNG({ width: 10, height: 10 });
    for (let i = 0; i < 100; i++) img.data.set([i * 2, i * 2, i * 2, i < 90 ? 255 : 0], i * 4);
    const mask = new Float32Array(100).fill(1);
    const q = lumaQuantiles(img, mask, [0.02, 0.5, 0.98]);
    expect(q.pixels).toBe(100);
    expect(q.values[0]).toBeLessThan(0.03);
    expect(q.values[1]).toBeCloseTo(100 / 255, 1);
    expect(q.values[2]).toBeGreaterThan(0.75);
    expect(lumaQuantiles(img, mask, [0.98], { minAlpha: 250 }).pixels).toBe(90);
    expect(lumaQuantiles(img, new Float32Array(100), [0.5]).values[0]).toBe(0);
  });

  it("plans Levels from the measurements", () => {
    const p = planLevels({ plateBlack: 0.06, plateWhite: 0.7, insertBlack: 0.02, insertWhite: 0.98, whiteMode: "keep", linear: false });
    expect(p.skip).toBe(false);
    expect(p.out_black).toBeCloseTo(0.06, 9);
    expect(p.in_black).toBeCloseTo(0.02, 9);
    expect(p.in_white).toBeCloseTo(0.98, 9);
    expect(p.out_white).toBe(1);
    expect(planLevels({ plateBlack: 0.06, plateWhite: 0.7, insertBlack: 0, insertWhite: 1, whiteMode: "match", linear: false }).out_white).toBeCloseTo(0.7, 9);
    const lin = planLevels({ plateBlack: 0.2, plateWhite: 0.7, insertBlack: 0, insertWhite: 1, whiteMode: "keep", linear: true });
    expect(lin.out_black).toBeCloseTo(0.0331, 3);
    expect(lin.notes.join(" ")).toMatch(/linear/i);
    const high = planLevels({ plateBlack: 0.8, plateWhite: 0.9, insertBlack: 0, insertWhite: 1, whiteMode: "keep", linear: false });
    expect(high.out_black).toBe(0.5);
    expect(high.notes.join(" ")).toMatch(/capped/);
    const nothing = planLevels({ plateBlack: 0.001, plateWhite: 1, insertBlack: 0, insertWhite: 1, whiteMode: "keep", linear: false });
    expect(nothing.skip).toBe(true);
    // A silly input white falls back to white.
    expect(planLevels({ plateBlack: 0.05, plateWhite: 0.5, insertBlack: 0.3, insertWhite: 0.4, whiteMode: "keep", linear: false }).in_white).toBe(1);
  });

  it("sizes the insert comp so the source stays at 100%", () => {
    // 16:9 source into a 4:3 screen: fill crops the sides, fit letterboxes.
    expect(insertCompSize({ width: 1920, height: 1080 }, 4 / 3, "fill")).toEqual([1440, 1080]);
    expect(insertCompSize({ width: 1920, height: 1080 }, 4 / 3, "fit")).toEqual([1920, 1440]);
    // 4:3 source into a 16:9 screen.
    expect(insertCompSize({ width: 1600, height: 1200 }, 16 / 9, "fill")).toEqual([1600, 900]);
    expect(insertCompSize({ width: 1600, height: 1200 }, 16 / 9, "fit")).toEqual([2133, 1200]);
    expect(insertCompSize({ width: 100, height: 100 }, 1, "fit")).toEqual([100, 100]);
    expect(insertCompSize({ width: 20, height: 4000 }, 10, "fill")[0]).toBeGreaterThanOrEqual(4);
  });

  it("suggests spread-out points on the plane, inside and on the bezel", () => {
    const img = scene(W, H, SCREEN, { sigma: 0.6, inside: content });
    const pts = suggestPoints(toGray(img), SCREEN, { scale: 1, count: 6, patchSize: 21 });
    expect(pts.length).toBeGreaterThanOrEqual(4);
    expect(pts.every((p) => p.contrast >= 3)).toBe(true);
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) expect(dist([pts[i].x, pts[i].y], [pts[j].x, pts[j].y])).toBeGreaterThanOrEqual(21 - 1e-6);
    }
    // All of them near the quad (it is grown 6%).
    const grown = scaleQuad(SCREEN, 1.06);
    const xs = grown.map((p) => p[0]);
    const ys = grown.map((p) => p[1]);
    expect(pts.every((p) => p.x >= Math.min(...xs) - 1 && p.x <= Math.max(...xs) + 1 && p.y >= Math.min(...ys) - 1 && p.y <= Math.max(...ys) + 1)).toBe(true);
    // A flat screen has nothing to track but its own corners.
    const flat = suggestPoints(toGray(scene(W, H, SCREEN)), SCREEN, { scale: 1, count: 6, patchSize: 21 });
    expect(flat.every((p) => SCREEN.some((c) => dist([p.x, p.y], c) < 6))).toBe(true);
  });

  it("describes a quad", () => {
    const m = quadMetrics(SCREEN);
    expect(m.ok).toBe(true);
    expect(m.area_px).toBeGreaterThan(14000);
    expect(m.edge_lengths_px).toHaveLength(4);
    expect(quadMetrics([SCREEN[0], SCREEN[2], SCREEN[1], SCREEN[3]]).ok).toBe(false);
  });
});

// ---------- pure: keys ----------

const trackOf = (frames: Array<{ t: number; H: Mat3 | null }>, extra: Partial<PlanarTrack> = {}): PlanarTrack => ({
  version: 1,
  track_id: "trk_screenrep_test",
  comp_id: 1,
  comp_size: [W, H],
  fps: 10,
  ref_time: 0,
  model: "similarity",
  ref_points: [[100, 80], [200, 120]],
  frames: frames.map(
    (f) => ({ time: f.t, ok: f.H !== null, H: f.H, points: [], confidence: [], rms_px: f.H ? 0 : null, inliers: f.H ? 2 : 0 }) as PlanarFrame
  ),
  source: "test",
  created: "2026-01-01T00:00:00.000Z",
  ...extra,
});

const rotH = (deg: number, s: number, tx: number, ty: number, about: Vec2 = [160, 100]): Mat3 => {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r) * s;
  const si = Math.sin(r) * s;
  return [c, -si, about[0] - c * about[0] + si * about[1] + tx, si, c, about[1] - si * about[0] - c * about[1] + ty, 0, 0, 1];
};

const persH: Mat3 = [1, 0.02, 3, -0.01, 1, 1, 0.0004, 0.0002, 1];

describe("buildInsertKeys", () => {
  const RECT: Vec2[] = [[80, 50], [240, 50], [240, 140], [80, 140]];
  const INSERT: Vec2 = [160, 90];
  const COMP: Vec2 = [W, H];
  const frames = (hs: Mat3[]) => hs.map((H, i) => ({ time: i / 10, ok: true, H, points: [], confidence: [], rms_px: 0, inliers: 4 }) as PlanarFrame);

  it("puts the pin points where the track puts the corners, in the layer's own space", () => {
    const hs = [identityH(), rotH(2, 1.01, 5, -3), persH];
    const keys = buildInsertKeys({ frames: frames(hs), refCorners: RECT, compSize: COMP, insertSize: INSERT, expansionPct: 0, transform: false });
    expect(keys.times).toEqual([0, 0.1, 0.2]);
    // The default layer: anchor at the insert's centre, position at the comp's centre.
    const M0 = layerMatrix({ anchor: [80, 45], position: [160, 100], scale_pct: [100, 100], rotation_deg: 0 });
    const roles = ["ul", "ur", "lr", "ll"] as const;
    hs.forEach((H, t) => {
      RECT.forEach((c, k) => {
        const moved = applyH(H, c) as Vec2;
        const back = applyH(M0, keys.exact[roles[k]][t]) as Vec2;
        expect(dist(back, moved)).toBeLessThan(0.01);
      });
    });
    // At the reference frame the insert's own corners land on the screen quad.
    expect(keys.exact.ul[0]).toEqual([0, -5]);
    expect(keys.exact.lr[0]).toEqual([160, 85]);
    // Without expansion the expanded set is the same.
    expect(keys.expanded.ul).toEqual(keys.exact.ul);
    expect(keys.transform).toBeUndefined();
    expect(keys.max_fit_px).toBe(0);
  });

  it("pushes the corners out from the quad's centre by the expansion", () => {
    const keys = buildInsertKeys({ frames: frames([identityH()]), refCorners: RECT, compSize: COMP, insertSize: INSERT, expansionPct: 10, transform: false });
    // Screen 160 x 90 centred at (160, 95); the layer sits 80 px left of and 55 px above the comp's origin.
    // 10% is 8 px and 4.5 px per side.
    expect(keys.expanded.ul[0][0]).toBeCloseTo(-8, 3);
    expect(keys.expanded.ul[0][1]).toBeCloseTo(-9.5, 3);
    expect(keys.expanded.lr[0][0]).toBeCloseTo(168, 3);
    expect(keys.exact.ul[0]).toEqual([0, -5]);
  });

  it("splits the motion into a layer transform and a residual pin that agree with the track", () => {
    const hs = [identityH(), rotH(8, 1.05, 12, -6), mulH(rotH(-5, 0.97, -9, 4), persH)];
    const keys = buildInsertKeys({ frames: frames(hs), refCorners: RECT, compSize: COMP, insertSize: INSERT, expansionPct: 0, transform: true });
    expect(keys.transform).toBeDefined();
    const roles = ["ul", "ur", "lr", "ll"] as const;
    hs.forEach((H, t) => {
      const tr = keys.transform!;
      const M = layerMatrix({ anchor: [80, 45], position: tr.position[t], scale_pct: tr.scale[t], rotation_deg: tr.rotation[t] });
      RECT.forEach((c, k) => {
        const moved = applyH(H, c) as Vec2;
        expect(dist(applyH(M, keys.exact[roles[k]][t]) as Vec2, moved)).toBeLessThan(0.02);
      });
    });
    // At the reference frame the transform is the default one.
    expect(keys.transform!.position[0][0]).toBeCloseTo(160, 3);
    expect(keys.transform!.position[0][1]).toBeCloseTo(100, 3);
    expect(keys.transform!.scale[0][0]).toBeCloseTo(100, 3);
    expect(keys.transform!.rotation[0]).toBeCloseTo(0, 3);
    // A pure similarity leaves nothing for the pin: its points stay where they were.
    const pure = buildInsertKeys({ frames: frames([identityH(), rotH(8, 1.05, 12, -6)]), refCorners: RECT, compSize: COMP, insertSize: INSERT, expansionPct: 0, transform: true });
    expect(dist(pure.exact.ul[1], pure.exact.ul[0])).toBeLessThan(0.02);
    expect(pure.max_fit_px).toBeLessThan(1e-6);
    expect(keys.max_fit_px).toBeGreaterThan(0.01);
  });

  it("keeps rotation continuous across 180 degrees", () => {
    const hs = [identityH(), rotH(170, 1, 0, 0), rotH(-175, 1, 0, 0)];
    const keys = buildInsertKeys({ frames: frames(hs), refCorners: RECT, compSize: COMP, insertSize: INSERT, expansionPct: 0, transform: true });
    expect(keys.transform!.rotation[2]).toBeCloseTo(185, 2);
  });

  it("skips frames without motion or with a corner behind the plane", () => {
    const behind: Mat3 = [1, 0, 0, 0, 1, 0, 0.1, 0, -40];
    const fr = frames([identityH(), identityH(), behind]);
    fr[1].ok = false;
    fr[1].H = null;
    const keys = buildInsertKeys({ frames: fr, refCorners: RECT, compSize: COMP, insertSize: INSERT, expansionPct: 0, transform: false });
    expect(keys.times).toEqual([0]);
    expect(keys.skipped).toEqual([0.1, 0.2]);
  });
});

describe("frames to render and the sheet", () => {
  const RECT: Vec2[] = [[80, 50], [240, 50], [240, 140], [80, 140]];

  it("picks the first, reference, last and the fastest frame", () => {
    const hs: Mat3[] = [0, 1, 2, 3, 30, 33, 36].map((tx) => rotH(0, 1, tx, 0));
    const t = trackOf(hs.map((H, i) => ({ t: i / 10, H })), { ref_time: 0.2 });
    // A reference time outside the track snaps to the nearest solved frame, so the sheet keeps its reference column.
    const far = pickSheetFrames(t, RECT, 9);
    expect(far.find((p) => p.label === "reference")!.time).toBeCloseTo(0.6, 6);
    const picks = pickSheetFrames(t, RECT, 0.2);
    expect(picks.map((p) => p.label)).toEqual(["first", "reference", "last", "fastest"]);
    expect(picks.find((p) => p.label === "fastest")!.time).toBeCloseTo(0.4, 6);
    // A one-frame track gives one pick.
    expect(pickSheetFrames(trackOf([{ t: 0, H: identityH() }]), RECT, 0)).toHaveLength(1);
    expect(pickSheetFrames(trackOf([{ t: 0, H: null }]), RECT, 0)).toEqual([]);
  });

  it("plans sample times: spread evenly, sheet frames kept, never over the render limit", () => {
    const all = Array.from({ length: 50 }, (_, i) => i / 10);
    const plan = planSampleTimes({ times: all, refTime: 2.5, sheet: [0, 2.5, 4.9, 3.1], maxSamples: 8, maxRenders: 20 });
    expect(plan.times.length).toBeLessThanOrEqual(20);
    for (const t of [0, 2.5, 4.9, 3.1]) expect(plan.times).toContain(t);
    expect([...plan.times].sort((a, b) => a - b)).toEqual(plan.times);
    const tight = planSampleTimes({ times: all, refTime: 2.5, sheet: [0, 4.9, 3.1], maxSamples: 24, maxRenders: 5 });
    expect(tight.times).toHaveLength(5);
    expect(tight.trimmed).toBe(true);
    for (const t of [0, 2.5, 4.9, 3.1]) expect(tight.times).toContain(t);
    expect(planSampleTimes({ times: [], refTime: 0, sheet: [], maxSamples: 4, maxRenders: 4 }).times).toEqual([]);
  });

  it("finds where the corners leave the frame and where the quad folds", () => {
    const hs: Mat3[] = [identityH(), rotH(0, 1, 90, 0), rotH(0, 1, 200, 0), rotH(0, 1, 0, 0)];
    const t = trackOf([...hs.map((H, i) => ({ t: i / 10, H })), { t: 0.4, H: null }]);
    const ex = cornerExcursions(t, RECT, [W, H]);
    expect(ex.frames_checked).toBe(4);
    expect(ex.frames_unsolved).toBe(1);
    expect(ex.frames_outside).toBe(2);
    expect(ex.first_outside_time).toBeCloseTo(0.1, 6);
    expect(ex.last_outside_time).toBeCloseTo(0.2, 6);
    expect(ex.per_corner[1]).toBe(2);
    expect(ex.min_margin_px).toBeLessThan(0);
    const fold = cornerExcursions(trackOf([{ t: 0, H: [1, 0, 0, 0, -1, 200, 0, 0, 1] }]), RECT, [W, H]);
    expect(fold.frames_folded).toBe(0);
  });

  it("lays out the before / after sheet", () => {
    const tile = (v: number) => {
      const p = new PNG({ width: 40, height: 30 });
      for (let i = 0; i < 1200; i++) p.data.set([v, v, v, 255], i * 4);
      return p;
    };
    const shots = (v: number) => [0, 1, 2].map((i) => ({ label: `f${i}`, time: i / 10, image: tile(v) }));
    const sheet = drawBeforeAfterSheet(shots(60), shots(160), 40)!;
    expect(sheet.width).toBe(3 * 40 + 2 * 4);
    expect(sheet.height).toBe(30 + 30 + 4);
    expect(drawBeforeAfterSheet([], shots(1), 40)).toBeNull();
  });
});

// ---------- schemas ----------

describe("schemas", () => {
  const corners = SCREEN;
  it("ae_screen_corners takes a quad and needs expect only to isolate", () => {
    const a = AeScreenCornersSchema.parse({ comp_id: 1, corners });
    expect(a).toMatchObject({ search_px: 24, edge: "outer", point_count: 6, pattern_size: 31, preview: true });
    expect(AeScreenCornersSchema.safeParse({ comp_id: 1, corners: corners.slice(0, 3) }).success).toBe(false);
    expect(AeScreenCornersSchema.safeParse({ comp_id: 1, corners, search_px: 1 }).success).toBe(false);
    expect(AeScreenCornersSchema.safeParse({ comp_id: 1, corners, point_count: 9 }).success).toBe(false);
    expect(AeScreenCornersSchema.safeParse({ comp_id: 1, corners, edge: "middle" }).success).toBe(false);
    expect(AeScreenCornersSchema.safeParse({ comp_id: 1, corners, isolate_layers: [{ index: 1 }] }).success).toBe(false);
    expect(AeScreenCornersSchema.safeParse({ comp_id: 1, corners, isolate_layers: [{ index: 1 }], expect: expectArg }).success).toBe(true);
    expect(AeScreenCornersSchema.safeParse({ comp_id: 1, corners, track: { track_id: "t" } }).success).toBe(true);
    expect(AeScreenCornersSchema.safeParse({ comp_id: 1, corners, track: { track_id: "t", nulls: [{ index: 1 }] } }).success).toBe(false);
  });

  it("ae_screen_replace has its defaults, one insert, a plate for reflections, and an expect", () => {
    const base = { comp_id: 1, corners, track: { track_id: "t" }, insert: { item_id: 5 }, expect: expectArg };
    const a = AeScreenReplaceSchema.parse(base);
    expect(a).toMatchObject({ fit: "fill", pin: "power_pin", expansion_pct: 2, motion_blur: "none", match_look: true, white_mode: "keep", reflections: false, reflection_opacity: 100, max_samples: 8, switch_off_source_layer: true, contact_sheet: true });
    expect(AeScreenReplaceSchema.safeParse({ ...base, insert: {} }).success).toBe(false);
    expect(AeScreenReplaceSchema.safeParse({ ...base, insert: { item_id: 5, layer: { index: 1 } } }).success).toBe(false);
    expect(AeScreenReplaceSchema.safeParse({ ...base, insert: { layer: { name: "Clip" } } }).success).toBe(true);
    expect(AeScreenReplaceSchema.safeParse({ ...base, reflections: true }).success).toBe(false);
    expect(AeScreenReplaceSchema.safeParse({ ...base, reflections: true, plate: { name: "Plate" } }).success).toBe(true);
    expect(AeScreenReplaceSchema.safeParse({ ...base, expect: undefined }).success).toBe(false);
    expect(AeScreenReplaceSchema.safeParse({ ...base, expansion_pct: 20 }).success).toBe(false);
    expect(AeScreenReplaceSchema.safeParse({ ...base, motion_blur: "yes" }).success).toBe(false);
    expect(AeScreenReplaceSchema.safeParse({ ...base, insert_aspect: 0 }).success).toBe(false);
    expect(AeScreenReplaceSchema.safeParse({ ...base, range: { start: 2, end: 1 } }).success).toBe(false);
    expect(AeScreenReplaceSchema.safeParse({ ...base, track: {} }).success).toBe(false);
  });

  it("describes every field and ends the writer's description with the safety guidance", () => {
    const shape = (AeScreenReplaceSchema as any)._def.schema._def.schema.shape ?? (AeScreenReplaceSchema as any)._def.schema.shape;
    expect(Object.keys(shape)).toContain("expansion_pct");
    expect(tool("ae_screen_replace").description).toMatch(/Jay may be editing live/);
    expect(tool("ae_screen_corners").description).not.toMatch(/Jay may be editing live/);
    expect(screenrepTools.map((t) => t.name)).toEqual(["ae_screen_corners", "ae_screen_replace"]);
  });
});

// ---------- the host functions, under node:vm ----------

const P1 = (name: string, matchName: string, v: number) => new FakeProperty(name, matchName, PropertyValueType.OneD, v);
const P2 = (name: string, matchName: string, v: number[]) => new FakeProperty(name, matchName, PropertyValueType.TwoD, v);

interface FxOpts {
  /** Levels' full-white value: 1 for 0..1, 255 for 8-bit. */
  unit?: number;
  expansion?: boolean;
  levelsParams?: boolean;
  blurParams?: boolean;
  /** Output Black cannot go below this. */
  levelsMin?: number;
  /** CC Power Pin cannot be added on this AE. */
  noPowerPin?: boolean;
}

function makeEffect(matchName: string, o: FxOpts): FakeGroup {
  const unit = o.unit ?? 1;
  if (matchName === "ADBE Corner Pin") {
    return new FakeGroup("Corner Pin", matchName, [
      P2("Upper Left", "ADBE Corner Pin-0001", [0, 0]),
      P2("Upper Right", "ADBE Corner Pin-0002", [100, 0]),
      P2("Lower Left", "ADBE Corner Pin-0003", [0, 100]),
      P2("Lower Right", "ADBE Corner Pin-0004", [100, 100]),
    ]);
  }
  if (matchName === "CC Power Pin") {
    if (o.noPowerPin) throw new Error("Can not add property CC Power Pin");
    const props = [P2("Top Left", "x1", [0, 0]), P2("Top Right", "x2", [100, 0]), P2("Bottom Left", "x3", [0, 100]), P2("Bottom Right", "x4", [100, 100])];
    if (o.expansion) props.push(P1("Expansion", "x5", 0));
    return new FakeGroup("Power Pin", matchName, props);
  }
  if (matchName === "ADBE Pro Levels2" || matchName === "ADBE Easy Levels2") {
    if (o.levelsParams === false) return new FakeGroup("Levels", matchName, [P1("Strange", "s1", 0)]);
    const props = [P1("Input Black", "l1", 0), P1("Input White", "l2", unit), P1("Gamma", "l3", 1), P1("Output Black", "l4", 0), P1("Output White", "l5", unit)];
    // A limit like AE's: nothing below zero.
    (props[3] as any).hasMin = true;
    (props[3] as any).minValue = o.levelsMin ?? 0;
    return new FakeGroup("Levels", matchName, props);
  }
  if (matchName === "ADBE Gaussian Blur 2") {
    if (o.blurParams === false) return new FakeGroup("Gaussian Blur", matchName, []);
    return new FakeGroup("Gaussian Blur", matchName, [P1("Blurriness", "g1", 0), P1("Blur Dimensions", "g2", 1)]);
  }
  return new FakeGroup(matchName, matchName, []);
}

function decorate(g: any, fx: any) {
  Object.defineProperty(g, "propertyIndex", { get: () => fx.props.indexOf(g) + 1 });
  g.moveTo = (i: number) => {
    fx.props.splice(fx.props.indexOf(g), 1);
    fx.props.splice(i - 1, 0, g);
  };
  g.remove = () => {
    fx.props.splice(fx.props.indexOf(g), 1);
  };
  return g;
}

function withEffects(layer: FakeLayer, o: FxOpts, existing: string[] = []): FakeGroup {
  const fx = layer.property("ADBE Effect Parade") as any;
  const add = (mn: string) => {
    const g = makeEffect(mn, o);
    g.parentProperty = fx;
    fx.props.push(g);
    return decorate(g, fx);
  };
  fx.addProperty = add;
  for (const mn of existing) add(mn);
  return fx;
}

function hostScene(o: FxOpts & { modernMattes?: boolean } = {}) {
  const project = new FakeProject();
  /** Every layer of a comp can take effects and be duplicated, as in AE. */
  const prep = (c: FakeComp): FakeComp => {
    const wrap = (l: FakeLayer) => {
      withEffects(l, o);
      (l as any).duplicate = () => {
        const d = new FakeLayer(l.comp, l.name);
        d.source = l.source;
        l.comp.stack.splice(l.comp.stack.indexOf(l), 0, d);
        withEffects(d, o);
        (d as any).duplicate = (l as any).duplicate;
        return d;
      };
      return l;
    };
    for (const k of ["add", "addSolid", "addNull"]) {
      const orig = c.layers[k];
      c.layers[k] = (...a: any[]) => wrap(orig(...a));
    }
    return c;
  };
  const comp = prep(project.addComp("Main", W, H, 4));
  comp.frameRate = 10;
  comp.modernMattes = o.modernMattes !== false;
  (project as any).items = {
    addComp: (name: string, w: number, h: number, pa: number, dur: number, fps: number) => {
      const c = prep(project.addComp(name, w, h, dur));
      c.pixelAspect = pa;
      c.frameRate = fps;
      return c;
    },
  };
  const solid = (name: string, w = W, h = H) => comp.layers.addSolid([0.2, 0.2, 0.2], name, w, h, 1) as FakeLayer;
  const plate = solid("Plate");
  const clip = project.addFootage("Clip.mov", 1920, 1080);
  (clip as any).duration = 10;
  const clipLayer = comp.layers.add(clip) as FakeLayer;
  clipLayer.name = "Clip";
  const hostLoad = () => {
    const h = loadHost(project, ["planar.jsx", "screenrep.jsx"]);
    h.G.BlendingMode = { SCREEN: 5220, NORMAL: 5212 };
    return h;
  };
  return { project, comp: comp as FakeComp, plate, clip, clipLayer, solid, hostLoad };
}

/** The args the server sends to screenrepApply, for a 3-frame track. */
function applyArgs(s: ReturnType<typeof hostScene>, over: Record<string, unknown> = {}) {
  const RECT: Vec2[] = [[80, 50], [240, 50], [240, 140], [80, 140]];
  const hs = [identityH(), rotH(2, 1.01, 5, -3), persH];
  const frames = hs.map((Hm, i) => ({ time: i / 10, ok: true, H: Hm, points: [], confidence: [], rms_px: 0, inliers: 4 }) as PlanarFrame);
  const keys = buildInsertKeys({ frames, refCorners: RECT, compSize: [W, H], insertSize: [160, 90], expansionPct: 2, transform: false });
  return {
    comp_id: s.comp.id,
    name: "Phone",
    insert: { item_id: s.clip.id },
    insert_size: [160, 90],
    insert_start: 0,
    plate: { index: s.plate.index, id: s.plate.id },
    pin: "power_pin",
    expansion_pct: 2,
    times: keys.times,
    exact: keys.exact,
    expanded: keys.expanded,
    motion_blur: "none",
    look: {},
    switch_off_source: false,
    expect: GUARD,
    ...over,
  };
}

const fxNames = (l: FakeLayer) => (l.property("ADBE Effect Parade") as any).props.map((g: any) => g.matchName);
const fxByMatch = (l: FakeLayer, mn: string) => (l.property("ADBE Effect Parade") as any).props.find((g: any) => g.matchName === mn);
const paramOf = (fx: any, name: string) => fx.props.find((p: any) => p.name === name);

describe("screenrep.jsx", () => {
  it("reports the comp, the plate and the insert, changing nothing", () => {
    const s = hostScene();
    const { A, undo } = s.hostLoad();
    const info = A.screenrepInfo({ comp_id: s.comp.id, plate: { name: "Plate" }, insert: { item_id: s.clip.id } });
    expect(info.comp).toMatchObject({ width: W, height: H, fps: 10, num_layers: 2 });
    expect(info.plate).toMatchObject({ name: "Plate", locked: false });
    expect(info.insert).toMatchObject({ kind: "footage", width: 1920, height: 1080, has_video: true, name: "Clip.mov" });
    expect(info.can_set_track_matte).toBe(true);
    expect(info.linear_blending).toBe(false);
    const viaLayer = A.screenrepInfo({ comp_id: s.comp.id, insert: { layer: { name: "Clip" } } });
    expect(viaLayer.insert.from_layer).toMatchObject({ name: "Clip" });
    expect(() => A.screenrepInfo({ comp_id: s.comp.id, insert: { layer: { name: "Plate" } } })).not.toThrow();
    expect(() => A.screenrepInfo({ comp_id: s.comp.id, insert: { item_id: 99999 } })).toThrow(/No project item/);
    expect(undo.begun).toBe(0);
    const old = hostScene({ modernMattes: false });
    expect(old.hostLoad().A.screenrepInfo({ comp_id: old.comp.id, plate: { name: "Plate" } }).can_set_track_matte).toBe(false);
  });

  it("makes the insert comp and layer above the plate, with the pin keyed, in one undo group", () => {
    const s = hostScene();
    const { A, undo } = s.hostLoad();
    const before = s.project.numItems;
    const r = A.screenrepApply(applyArgs(s));
    expect(undo.begun).toBe(1);
    expect(undo.ended).toBe(1);
    expect(s.project.numItems).toBe(before + 1);
    const inner = s.project.itemByID(r.insert_comp.id) as FakeComp;
    expect(inner.name).toBe("Phone INSERT");
    expect([inner.width, inner.height, inner.frameRate, inner.duration]).toEqual([160, 90, 10, 4]);
    expect(inner.numLayers).toBe(1);
    expect(inner.layer(1)!.name).toBe("Clip.mov");
    // The insert layer sits directly above the plate.
    const ins = s.comp.layer(r.insert_layer.index)!;
    expect(ins.name).toBe("Phone INSERT");
    expect(s.comp.layer(ins.index + 1)).toBe(s.plate);
    expect((ins.transform("ADBE Anchor Point").value as number[]).slice(0, 2)).toEqual([80, 45]);
    expect((ins.transform("ADBE Position").value as number[]).slice(0, 2)).toEqual([160, 100]);
    // No Expansion parameter on this Power Pin: the expanded corners were written.
    expect(r.pin).toMatchObject({ kind: "power_pin", values_used: "expanded", expansion: { mode: "values" } });
    expect(r.look_skipped.map((x: any) => x.step)).toContain("power_pin_expansion");
    const pin = fxByMatch(ins, "CC Power Pin");
    const tl = paramOf(pin, "Top Left");
    expect(tl.numKeys).toBe(3);
    const args = applyArgs(s);
    expect((tl.keyValue(1) as number[]).slice(0, 2)).toEqual(args.expanded.ul[0]);
    expect((paramOf(pin, "Bottom Right").keyValue(3) as number[]).slice(0, 2)).toEqual(args.expanded.lr[2]);
    expect(r.written[0]).toMatchObject({ target: "power_pin" });
    expect(r.keys).toBe(3);
    // The plate is untouched.
    expect(s.plate.enabled).toBe(true);
    expect(fxNames(s.plate)).toEqual([]);
  });

  it("uses CC Power Pin's Expansion parameter when it exists, and keeps the corners exact", () => {
    const s = hostScene({ expansion: true });
    const { A } = s.hostLoad();
    const r = A.screenrepApply(applyArgs(s));
    expect(r.pin).toMatchObject({ values_used: "exact", expansion: { mode: "param", value: 2 } });
    expect(r.look_skipped).toEqual([]);
    const pin = fxByMatch(s.comp.layer(r.insert_layer.index)!, "CC Power Pin");
    expect(paramOf(pin, "Expansion").value).toBe(2);
    expect((paramOf(pin, "Top Left").keyValue(1) as number[]).slice(0, 2)).toEqual(applyArgs(s).exact.ul[0]);
  });

  it("falls back to a Corner Pin when CC Power Pin cannot be used, in the same undo group", () => {
    const s = hostScene({ noPowerPin: true });
    const { A, undo } = s.hostLoad();
    const r = A.screenrepApply(applyArgs(s));
    expect(undo.begun).toBe(1);
    expect(r.pin).toMatchObject({ kind: "corner_pin" });
    expect(r.pin_fallback).toMatch(/Corner Pin was built instead/);
    const ins = s.comp.layer(r.insert_layer.index)!;
    expect(fxNames(ins)).toEqual(["ADBE Corner Pin"]);
    expect(paramOf(fxByMatch(ins, "ADBE Corner Pin"), "Upper Left").numKeys).toBe(3);
  });

  it("refuses an insert that is the plate or the target comp before the undo group", () => {
    const s = hostScene();
    const { A, undo } = s.hostLoad();
    expect(() => A.screenrepApply(applyArgs(s, { insert: { layer: { index: s.plate.index, id: s.plate.id } } }))).toThrow(/plate layer/);
    expect(() => A.screenrepApply(applyArgs(s, { insert: { item_id: s.comp.id } }))).toThrow(/itself/);
    expect(undo.begun).toBe(0);
    expect(s.comp.numLayers).toBe(2);
  });

  it("writes a Corner Pin with the expanded corners, and exact ones with no expansion", () => {
    const s = hostScene();
    const { A } = s.hostLoad();
    const r = A.screenrepApply(applyArgs(s, { pin: "corner_pin" }));
    expect(r.pin).toMatchObject({ kind: "corner_pin", values_used: "expanded" });
    const ins = s.comp.layer(r.insert_layer.index)!;
    expect((paramOf(fxByMatch(ins, "ADBE Corner Pin"), "Upper Left").keyValue(2) as number[]).slice(0, 2)).toEqual(applyArgs(s).expanded.ul[1]);
    const s2 = hostScene();
    const r2 = s2.hostLoad().A.screenrepApply(applyArgs(s2, { pin: "corner_pin", expansion_pct: 0 }));
    expect(r2.pin.values_used).toBe("exact");
    expect(r2.pin.expansion).toEqual({ mode: "none" });
  });

  it("adds Levels and blur in the shared effect order, with values in the effect's own unit", () => {
    for (const unit of [1, 255]) {
      const s = hostScene({ unit, expansion: true });
      const { A } = s.hostLoad();
      const r = A.screenrepApply(applyArgs(s, { look: { levels: { in_black: 0.02, in_white: 0.96, out_black: 0.05, out_white: 1 }, blurriness: 3 }, motion_blur: "force" }));
      const ins = s.comp.layer(r.insert_layer.index)!;
      expect(fxNames(ins)).toEqual(["ADBE Pro Levels2", "ADBE Gaussian Blur 2", "CC Power Pin", "CC Force Motion Blur"]);
      const lv = fxByMatch(ins, "ADBE Pro Levels2");
      expect(paramOf(lv, "Output Black").value).toBeCloseTo(0.05 * unit, 9);
      expect(paramOf(lv, "Input Black").value).toBeCloseTo(0.02 * unit, 9);
      expect(paramOf(lv, "Input White").value).toBeCloseTo(0.96 * unit, 9);
      expect(paramOf(lv, "Output White").value).toBeCloseTo(unit, 9);
      expect(paramOf(fxByMatch(ins, "ADBE Gaussian Blur 2"), "Blurriness").value).toBe(3);
      expect(r.look.levels).toMatchObject({ effect_index: 1, unit, unit_assumed: false });
      expect(r.look.levels.wrote.map((w: any) => w.role).sort()).toEqual(["in_black", "in_white", "out_black", "out_white"]);
      expect(r.look.blur).toMatchObject({ effect_index: 2 });
      expect(r.pin.effect_index).toBe(3);
      expect(r.motion_blur).toMatchObject({ mode: "force", force_effect_index: 4 });
    }
  });

  it("clamps a Levels value to the parameter's limits", () => {
    const s = hostScene({ levelsMin: 0.1 });
    const { A } = s.hostLoad();
    const r = A.screenrepApply(applyArgs(s, { look: { levels: { out_black: 0.05 } } }));
    expect(r.look.levels.wrote[0]).toMatchObject({ role: "out_black", value: 0.1 });
    expect(() => A.screenrepApply(applyArgs(s, { look: { levels: { out_black: -0.2 } } }))).toThrow(/not a number >= 0/);
  });

  it("skips a look step whose parameters it cannot find, undoes that effect, and still builds the core", () => {
    const s = hostScene({ levelsParams: false, blurParams: false });
    const { A, undo } = s.hostLoad();
    const r = A.screenrepApply(applyArgs(s, { look: { levels: { out_black: 0.05 }, blurriness: 2 } }));
    const ins = s.comp.layer(r.insert_layer.index)!;
    expect(fxNames(ins)).toEqual(["CC Power Pin"]);
    expect(r.look).toEqual({});
    expect(r.look_skipped.map((x: any) => x.step)).toEqual(expect.arrayContaining(["levels", "blur"]));
    expect(r.look_skipped.find((x: any) => x.step === "levels").param_table).toEqual([{ index: 1, name: "Strange", matchName: "s1" }]);
    expect(paramOf(fxByMatch(ins, "CC Power Pin"), "Top Left").numKeys).toBe(3);
    expect(undo.begun).toBe(1);
    expect(undo.ended).toBe(1);
  });

  it("writes the transform and sets the motion blur switches for transform_pin", () => {
    const s = hostScene({ expansion: true });
    const { A } = s.hostLoad();
    const RECT: Vec2[] = [[80, 50], [240, 50], [240, 140], [80, 140]];
    const hs = [identityH(), rotH(8, 1.05, 12, -6), mulH(rotH(-5, 0.97, -9, 4), persH)];
    const frames = hs.map((Hm, i) => ({ time: i / 10, ok: true, H: Hm, points: [], confidence: [], rms_px: 0, inliers: 4 }) as PlanarFrame);
    const keys = buildInsertKeys({ frames, refCorners: RECT, compSize: [W, H], insertSize: [160, 90], expansionPct: 2, transform: true });
    expect(s.comp as any).not.toHaveProperty("motionBlur");
    const r = A.screenrepApply(applyArgs(s, { motion_blur: "transform_pin", transform: keys.transform, exact: keys.exact, expanded: keys.expanded, times: keys.times }));
    const ins = s.comp.layer(r.insert_layer.index)!;
    expect((ins as any).motionBlur).toBe(true);
    expect((s.comp as any).motionBlur).toBe(true);
    expect(r.motion_blur).toMatchObject({ mode: "transform_pin", layer_switch: true, comp_switch_was_on: false, comp_switch_turned_on: true });
    expect(ins.transform("ADBE Position").numKeys).toBe(3);
    expect((ins.transform("ADBE Rotate Z").keyValue(2) as number)).toBeCloseTo(keys.transform!.rotation[1], 4);
    expect(r.written.map((w: any) => w.target)).toEqual(["power_pin", "transform"]);
    // Transform keys with another mode, and the mode without keys, are refused.
    const s2 = hostScene();
    const h2 = s2.hostLoad();
    expect(() => h2.A.screenrepApply(applyArgs(s2, { transform: keys.transform, times: keys.times, exact: keys.exact, expanded: keys.expanded }))).toThrow(/Transform keys are only written/);
    expect(() => h2.A.screenrepApply(applyArgs(s2, { motion_blur: "transform_pin" }))).toThrow(/needs the transform keys/);
    expect(h2.undo.begun).toBe(0);
  });

  it("adds the reflection layer: a Screen duplicate of the plate above the insert, keeping highlights, matted by the insert", () => {
    const s = hostScene();
    (s.plate as any).audioEnabled = true;
    const { A } = s.hostLoad();
    const r = A.screenrepApply(applyArgs(s, { reflections: { threshold: 0.8, opacity: 60 } }));
    const ins = s.comp.layer(r.insert_layer.index)!;
    const refl = s.comp.layer(r.look.reflections.layer_id === ins.id ? 0 : ins.index - 1)!;
    expect(refl.id).toBe(r.look.reflections.layer_id);
    expect(refl.name).toBe("Phone reflections");
    expect(refl.index).toBe(ins.index - 1);
    expect(s.comp.layer(ins.index + 1)).toBe(s.plate);
    expect((refl as any).blendingMode).toBe(5220);
    expect((refl as any).audioEnabled).toBe(false);
    expect(refl.trackMatteLayer).toBe(ins);
    expect(refl.trackMatteType).toBe(5013);
    expect(paramOf(fxByMatch(refl, "ADBE Pro Levels2"), "Input Black").value).toBeCloseTo(0.8, 9);
    expect(refl.transform("ADBE Opacity").value).toBe(60);
    expect(r.look.reflections).toMatchObject({ blending_mode: 5220, track_matte_type: 5013, matte_layer_id: ins.id, opacity: 60 });
    // The plate keeps its own state.
    expect(s.plate.enabled).toBe(true);
    expect(s.plate.trackMatteLayer).toBeNull();
  });

  it("keeps the insert switched on when AE hides the layer that becomes the reflection's matte", () => {
    // Seen live in AE 26.2.1 (probe): setTrackMatte switches the matte layer off (enabled read false right after). The insert is the picture, so it must stay visible.
    const s = hostScene();
    const { A } = s.hostLoad();
    const dupOf = (s.plate as any).duplicate;
    (s.plate as any).duplicate = () => {
      const d = dupOf();
      const set = d.setTrackMatte;
      d.setTrackMatte = (matte: any, type: number) => {
        set(matte, type);
        matte.enabled = false;
      };
      return d;
    };
    const r = A.screenrepApply(applyArgs(s, { reflections: { threshold: 0.8, opacity: 60 } }));
    const ins = s.comp.layer(r.insert_layer.index)!;
    const refl = s.comp.layer(r.look.reflections.layer_id === ins.id ? 0 : ins.index - 1)!;
    expect(refl.trackMatteLayer).toBe(ins);
    expect(ins.enabled).toBe(true);
    expect((r.look_skipped ?? []).filter((x: any) => x.step === "reflections")).toEqual([]);
  });

  it("takes the reflection back, and says so, when it cannot be finished", () => {
    const s = hostScene({ levelsParams: false });
    const { A } = s.hostLoad();
    const n = s.comp.numLayers;
    const r = A.screenrepApply(applyArgs(s, { reflections: { threshold: 0.8, opacity: 100 } }));
    expect(s.comp.numLayers).toBe(n + 1);
    expect(r.look.reflections).toBeUndefined();
    expect(r.look_skipped.find((x: any) => x.step === "reflections").reason).toMatch(/Levels/);
  });

  it("sets the reflection opacity when the plate's opacity is not 100, is keyed or is driven by an expression", () => {
    const plateWith = (shape: (op: any) => void) => {
      const s = hostScene();
      const orig = (s.plate as any).duplicate;
      (s.plate as any).duplicate = () => {
        const d = orig();
        shape(d.transform("ADBE Opacity"));
        return d;
      };
      return s;
    };
    const run = (s: ReturnType<typeof hostScene>) => {
      const r = s.hostLoad().A.screenrepApply(applyArgs(s, { reflections: { threshold: 0.8, opacity: 60 } }));
      return s.comp.layer(r.insert_layer.index - 1)!.transform("ADBE Opacity") as any;
    };
    const plain = run(plateWith((op) => op.setValue(80)));
    expect(plain.value).toBe(60);
    const keyed = run(plateWith((op) => {
      op.setValueAtTime(0, 80);
      op.setValueAtTime(1, 30);
    }));
    expect(keyed.numKeys).toBe(0);
    expect(keyed.value).toBe(60);
    const driven = run(plateWith((op) => {
      op.setValue(100);
      op.expression = "50";
      op.expressionEnabled = true;
    }));
    expect(driven.expression).toBe("");
    expect(driven.value).toBe(60);
  });

  it("switches off the original layer when the insert came from one", () => {
    const s = hostScene();
    const { A } = s.hostLoad();
    const r = A.screenrepApply(applyArgs(s, { insert: { layer: { index: s.clipLayer.index, id: s.clipLayer.id } }, switch_off_source: true }));
    expect(s.clipLayer.enabled).toBe(false);
    expect(r.source_layer).toMatchObject({ id: s.clipLayer.id, was_enabled: true });
    expect((s.project.itemByID(r.insert_comp.id) as FakeComp).layer(1)!.source).toBe(s.clip);
    // A locked original cannot be switched off: refused before anything is made.
    const t = hostScene();
    t.clipLayer.locked = true;
    const h = t.hostLoad();
    const items = t.project.numItems;
    expect(() => h.A.screenrepApply(applyArgs(t, { insert: { layer: { index: t.clipLayer.index, id: t.clipLayer.id } }, switch_off_source: true }))).toThrow(/locked/);
    expect(t.project.numItems).toBe(items);
    expect(h.undo.begun).toBe(0);
  });

  it("starts the insert at insert_start", () => {
    const s = hostScene();
    const { A } = s.hostLoad();
    const r = A.screenrepApply(applyArgs(s, { insert_start: 0.5 }));
    expect(s.comp.layer(r.insert_layer.index)!.startTime).toBe(0.5);
  });

  it("sets the insert start even when it is 0 and the layer was added at the current time", () => {
    const s = hostScene();
    const orig = s.comp.layers.add;
    // Create Layers at Composition Start Time off: layers.add puts the layer at the CTI.
    s.comp.layers.add = (...a: any[]) => {
      const l = orig(...a);
      l.startTime = 3;
      return l;
    };
    const { A } = s.hostLoad();
    const r = A.screenrepApply(applyArgs(s, { insert_start: 0 }));
    expect(s.comp.layer(r.insert_layer.index)!.startTime).toBe(0);
  });

  it("lengthens the insert comp for a negative insert_start so it still covers the whole shot", () => {
    const s = hostScene();
    const { A } = s.hostLoad();
    const r = A.screenrepApply(applyArgs(s, { insert_start: -2 }));
    expect(s.comp.layer(r.insert_layer.index)!.startTime).toBe(-2);
    expect(r.insert_comp.duration).toBeCloseTo(s.comp.duration + 2, 6);
    const plain = hostScene();
    const r0 = plain.hostLoad().A.screenrepApply(applyArgs(plain));
    expect(r0.insert_comp.duration).toBeCloseTo(plain.comp.duration, 6);
  });

  it("cuts the insert layer to its keys for a range write", () => {
    const s = hostScene();
    const { A } = s.hostLoad();
    const a = applyArgs(s, { trim_to_keys: true, times: [1, 1.1, 1.2] }) as any;
    const r = A.screenrepApply(a);
    const l = s.comp.layer(r.insert_layer.index)!;
    expect(l.inPoint).toBeCloseTo(1, 6);
    expect(l.outPoint).toBeCloseTo(1.3, 6);
    const whole = hostScene();
    const r2 = whole.hostLoad().A.screenrepApply(applyArgs(whole));
    expect(whole.comp.layer(r2.insert_layer.index)!.outPoint).toBe(whole.comp.duration);
  });

  it("refuses bad input before opening an undo group or making anything", () => {
    const s = hostScene();
    const { A, undo } = s.hostLoad();
    const items = s.project.numItems;
    const layers = s.comp.numLayers;
    const a = applyArgs(s);
    const refuse = (over: Record<string, unknown>, re: RegExp) => expect(() => A.screenrepApply({ ...a, ...over })).toThrow(re);
    refuse({ expect: { project_path: "C:/other.aep" } }, /Target guard refused/);
    refuse({ expect: undefined }, /no expect.project_path/);
    refuse({ insert_size: [160.5, 90] }, /whole numbers/);
    refuse({ insert_size: [3, 90] }, /between 4 and 30000/);
    refuse({ name: "" }, /name of 1 to 190/);
    refuse({ pin: "mocha_pin" }, /pin must be/);
    refuse({ times: [0, 0.1] }, /needs 2 values|needs 3 values|one per time/);
    refuse({ times: [0.2, 0.1, 0.3] }, /times must ascend/);
    refuse({ motion_blur: "blurry" }, /motion_blur must be/);
    refuse({ plate: { index: 1, id: s.plate.id } }, /stack changed/);
    refuse({ insert: { item_id: 99999 } }, /No project item/);
    refuse({ look: { levels: { out_black: "x" } } }, /out_black is not a number/);
    refuse({ look: { blurriness: -1 } }, /blurriness/);
    refuse({ insert_start: -10800 }, /too far before the comp start/);
    refuse({ insert_start: -10797, trim_to_keys: true }, /too far before the comp start/);
    refuse({ insert_start: 10801 }, /within [+]-10800/);
    refuse({ trim_to_keys: true, times: [0.5, 0.6, 0.7], insert_start: 0.9 }, /at or after the end of the keys/);
    refuse({ reflections: { threshold: 2, opacity: 100 } }, /threshold must be 0..1/);
    refuse({ reflections: { threshold: 0.5, opacity: 100 }, plate: undefined }, /need the plate layer/);
    s.plate.locked = true;
    refuse({ reflections: { threshold: 0.5, opacity: 100 } }, /is locked/);
    s.plate.locked = false;
    const bad = applyArgs(s);
    (bad.exact as any).ul[1] = [1, "x"];
    expect(() => A.screenrepApply(bad)).toThrow(/is not a number/);
    expect(undo.begun).toBe(0);
    expect(s.project.numItems).toBe(items);
    expect(s.comp.numLayers).toBe(layers);
  });

  it("refuses an insert layer that has no source", () => {
    const s = hostScene();
    const nul = s.comp.layers.addNull() as FakeLayer;
    const { A, undo } = s.hostLoad();
    const items = s.project.numItems;
    expect(() => A.screenrepApply(applyArgs(s, { plate: { index: s.plate.index, id: s.plate.id }, insert: { layer: { index: nul.index, id: nul.id } } }))).toThrow(/no source item/);
    expect(s.project.numItems).toBe(items);
    expect(undo.begun).toBe(0);
  });

  it("refuses reflections on an AE without layer-based track mattes", () => {
    const s = hostScene({ modernMattes: false });
    const { A, undo } = s.hostLoad();
    expect(() => A.screenrepApply(applyArgs(s, { reflections: { threshold: 0.5, opacity: 100 } }))).toThrow(/After Effects 23/);
    expect(undo.begun).toBe(0);
  });

  it("refuses a comp with non-square pixels", () => {
    const s = hostScene();
    s.comp.pixelAspect = 1.5;
    const { A, undo } = s.hostLoad();
    expect(() => A.screenrepApply(applyArgs(s))).toThrow(/pixel aspect/);
    expect(() => A.screenrepInfo({ comp_id: s.comp.id })).not.toThrow();
    expect(undo.begun).toBe(0);
  });

  it("removes everything it made if the core fails midway, and closes the undo group", () => {
    const s = hostScene();
    const { A, undo } = s.hostLoad();
    const items = s.project.numItems;
    const layers = s.comp.numLayers;
    A.planarWriteRaw = () => {
      throw new Error("AE said no");
    };
    expect(() => A.screenrepApply(applyArgs(s, { look: { levels: { out_black: 0.05 } }, reflections: { threshold: 0.5, opacity: 100 } }))).toThrow(/AE said no/);
    expect(s.project.numItems).toBe(items);
    expect(s.comp.numLayers).toBe(layers);
    expect(undo.begun).toBe(1);
    expect(undo.ended).toBe(1);
    expect(fxNames(s.plate)).toEqual([]);
  });

  it("reads back the layers, their effects and parameter values, the insert comp and the keys", () => {
    const s = hostScene({ expansion: true });
    const { A, undo } = s.hostLoad();
    const w = A.screenrepApply(applyArgs(s, { look: { levels: { out_black: 0.05 } }, reflections: { threshold: 0.8, opacity: 100 } }));
    const begun = undo.begun;
    const times = [0, 0.2];
    const read = A.screenrepRead({
      comp_id: s.comp.id,
      layer_ids: [w.insert_layer.id, w.look.reflections.layer_id],
      insert_comp_id: w.insert_comp.id,
      keys: [{ layer_id: w.insert_layer.id, kind: "power_pin", effect_index: w.pin.effect_index, times }],
    });
    expect(undo.begun).toBe(begun);
    expect(read.num_layers).toBe(4);
    expect(read.layers.map((l: any) => l.name)).toEqual(["Clip", "Phone reflections", "Phone INSERT", "Plate"]);
    const ins = read.details.find((d: any) => d.id === w.insert_layer.id);
    expect(ins.effects.map((e: any) => e.matchName)).toEqual(["ADBE Pro Levels2", "CC Power Pin"]);
    expect(ins.effects[0].params.find((p: any) => p.name === "Output Black").value).toBeCloseTo(0.05, 9);
    const refl = read.details.find((d: any) => d.id === w.look.reflections.layer_id);
    expect(refl).toMatchObject({ blending_mode: 5220, track_matte_type: 5013, matte_layer_id: w.insert_layer.id });
    expect(read.insert_comp).toMatchObject({ width: 160, height: 90, num_layers: 1, layer_names: ["Clip.mov"] });
    expect(read.keys.items[0].props.map((p: any) => [p.role, p.numKeys])).toEqual([["ul", 3], ["ur", 3], ["ll", 3], ["lr", 3]]);
    expect(read.keys.items[0].props[0].samples).toHaveLength(2);
  });

  it("passes its own read-back through the receipt check", () => {
    const s = hostScene({ expansion: true });
    const { A } = s.hostLoad();
    const args = applyArgs(s, { look: { levels: { in_black: 0.02, out_black: 0.05 }, blurriness: 3 } });
    const before = A.screenrepRead({ comp_id: s.comp.id });
    const w = A.screenrepApply(args);
    const after = A.screenrepRead({
      comp_id: s.comp.id,
      layer_ids: [w.insert_layer.id],
      insert_comp_id: w.insert_comp.id,
      keys: [{ layer_id: w.insert_layer.id, kind: w.pin.kind, effect_index: w.pin.effect_index, times: [0, 0.1, 0.2] }],
    });
    const frames = args.times.map((t: number) => t);
    const keysPlan = { times: frames, exact: args.exact, expanded: args.expanded, skipped: [], max_fit_px: 0 };
    const plan: ReplacePlan = {
      name: "Phone",
      pin: "power_pin",
      insertSize: [160, 90],
      times: frames,
      keys: keysPlan as any,
      expansionPct: 2,
      motionBlur: "none",
      levels: null,
      blurriness: 3,
      reflections: null,
      insertStart: 0,
      plateId: s.plate.id,
      sourceLayerId: null,
      switchOffSource: false,
      fps: 10,
    };
    expect(replaceMismatches(plan, before, after, w)).toEqual([]);
    // A value that did not stick, a plate that moved, a wrong comp size and a missing layer are each reported.
    const broken = JSON.parse(JSON.stringify(after));
    broken.details[0].effects[0].params.find((p: any) => p.name === "Output Black").value = 0.5;
    broken.insert_comp.width = 161;
    broken.keys.items[0].props[0].numKeys = 2;
    const paths = replaceMismatches(plan, before, broken, w).map((m) => m.path);
    expect(paths).toEqual(expect.arrayContaining(["levels.out_black", "insert_comp.size", "keys.ul.numKeys"]));
    // CC Power Pin's Expansion that did not stick is caught.
    const exp = JSON.parse(JSON.stringify(after));
    exp.details[0].effects.find((e: any) => e.matchName === "CC Power Pin").params.find((p: any) => /Expansion/.test(p.name)).value = 77;
    expect(replaceMismatches(plan, before, exp, w).map((m) => m.path)).toContain("pin.expansion");
    const gone = JSON.parse(JSON.stringify(after));
    gone.details = [];
    expect(replaceMismatches(plan, before, gone, w)[0].path).toBe("insert_layer");
    expect(replaceMismatches(plan, before, null, w)).toEqual([]);
  });
});

// ---------- the tools, against a fake bridge ----------

interface Call {
  fn: string;
  args: any;
  script: string;
}

const COPY_ID = 900;

interface AeOpts {
  /** The plate's picture. */
  picture?: () => PNG;
  failRenders?: boolean;
  failRenderOn?: (n: number) => boolean;
  info?: Record<string, unknown>;
  noAfter?: boolean;
  breakAfter?: (after: any) => void;
  comp?: Record<string, unknown>;
  writeResult?: (args: any) => Record<string, unknown>;
}

function fakeAe(opts: AeOpts = {}) {
  const calls: Call[] = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-screenrep-q-"));
  tmpDirs.push(dir);
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
  const picture = opts.picture ?? (() => scene(W, H, SCREEN, { sigma: 0.7, outside: 36, inside: (x, y) => 14 + (y - 50) * 1.2 + 8 * Math.sin(x * 0.2) }));
  let renders = 0;
  let wrote: any = null;
  const ok = (result: unknown) => ({ ok: true, result, durationMs: 1 });
  const host = new PanelHost({
    evalScript: async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      const args = JSON.parse(script.slice(script.indexOf("(") + 1, script.lastIndexOf(")")));
      calls.push({ fn, args, script });
      if (fn === "checkGuard") return ok({ ok: true, project_path: "<unsaved>", comp_id: 1, comp_is_valid: true });
      if (fn === "planarComp") {
        return ok({
          id: 1,
          name: "Main",
          width: W,
          height: H,
          pixel_aspect: 1,
          fps: 10,
          frame_duration: 0.1,
          duration: 1,
          time: 0,
          work_area_start: 0,
          work_area_duration: 1,
          num_layers: 2,
          layers: (args.layers ?? []).map((sel: any, i: number) => ({ index: sel.index ?? i + 1, id: 100 + i, name: `L${i + 1}`, locked: false, enabled: true, three_d: false })),
          ...opts.comp,
        });
      }
      if (fn === "snapshotFrame") {
        renders++;
        if (opts.failRenders || opts.failRenderOn?.(renders)) throw new Error("render failed");
        fs.mkdirSync(path.dirname(args.output_path), { recursive: true });
        fs.writeFileSync(args.output_path, PNG.sync.write(args.comp_id === 888 ? scene(160, 90, [[-20, -20], [180, -20], [180, 110], [-20, 110]], { outside: 0, inside: (x) => 10 + x }) : picture()));
        return ok({ path: args.output_path, time: args.time });
      }
      if (fn === "planarIsolateBegin") return ok({ copy_id: COPY_ID, copy_name: "_chroma_plate_Main", original_id: 1 });
      if (fn === "planarIsolateEnd") return ok({ removed: true, copy_id: COPY_ID });
      if (fn === "screenrepInfo") {
        return ok({
          comp: { id: 1, name: "Main", width: W, height: H, pixel_aspect: 1, fps: 10, duration: 1, time: 0, work_area_start: 0, work_area_duration: 1, num_layers: 2, motion_blur: false },
          ae_version: "26.2.1",
          linear_blending: false,
          can_set_track_matte: true,
          plate: { index: 2, id: 100, name: "Plate", locked: false, enabled: true, three_d: false },
          insert: { kind: "footage", item_id: 55, name: "Clip.mov", width: 1920, height: 1080, duration: 10, has_video: true, missing: false, pixel_aspect: 1, from_layer: { index: 1, id: 101, name: "Clip", locked: false, enabled: true, three_d: false } },
          ...opts.info,
        });
      }
      if (fn === "screenrepApply") {
        wrote = args;
        const reflect = args.reflections ? { layer_id: 778, blending_mode: 5220, track_matte_type: 5013, matte_layer_id: 777, opacity: args.reflections.opacity, levels: { effect_index: 1, unit: 1, wrote: [{ role: "in_black", name: "Input Black", matchName: "l1", how: "name", value: args.reflections.threshold }] } } : undefined;
        const levels = args.look?.levels
          ? { effect_index: 1, unit: 1, wrote: Object.entries(args.look.levels).map(([role, value]) => ({ role, name: { in_black: "Input Black", in_white: "Input White", out_black: "Output Black", out_white: "Output White" }[role as string], value })) }
          : undefined;
        const blur = args.look?.blurriness ? { effect_index: levels ? 2 : 1, wrote: [{ role: "blurriness", name: "Blurriness", value: args.look.blurriness }] } : undefined;
        return ok({
          insert_comp: { id: 888, name: `${args.name} INSERT`, width: args.insert_size[0], height: args.insert_size[1] },
          insert_layer: { index: reflect ? 3 : 2, id: 777, name: `${args.name} INSERT` },
          source_item: { id: 55, name: "Clip.mov", kind: "footage" },
          pin: { kind: args.pin, effect_index: 3, values_used: args.expansion_pct > 0 ? "expanded" : "exact", expansion: { mode: args.expansion_pct > 0 ? "values" : "none" } },
          written: [{ target: args.pin, props: ["ul", "ur", "ll", "lr"].map((role) => ({ role, numKeys: args.times.length })) }],
          look: { ...(levels ? { levels } : {}), ...(blur ? { blur } : {}), ...(reflect ? { reflections: reflect } : {}) },
          look_skipped: [],
          motion_blur: { mode: args.motion_blur },
          source_layer: args.switch_off_source ? { index: 2, id: 101, name: "Clip", was_enabled: true } : null,
          keys: args.times.length,
          ...opts.writeResult?.(args),
        });
      }
      if (fn === "screenrepRead") {
        if (!wrote) return ok({ comp_id: 1, num_layers: 2, comp_motion_blur: false, layers: [{ index: 1, id: 101, name: "Clip", enabled: true }, { index: 2, id: 100, name: "Plate", enabled: true }], details: [], insert_comp: null, keys: null });
        if (opts.noAfter) throw new Error("AE is busy");
        const a = wrote;
        const reflect = !!a.reflections;
        // Before: Clip, Plate. The insert goes directly above the plate, the reflection directly above the insert.
        const layers = [
          { index: 1, id: 101, name: "Clip", enabled: !a.switch_off_source },
          ...(reflect ? [{ index: 2, id: 778, name: `${a.name} reflections`, enabled: true }] : []),
          { index: reflect ? 3 : 2, id: 777, name: `${a.name} INSERT`, enabled: true },
          { index: reflect ? 4 : 3, id: 100, name: "Plate", enabled: true },
        ];
        const lv = (value: Record<string, number>) => ({ index: 1, name: "Levels", matchName: "ADBE Pro Levels2", params: Object.entries(value).map(([name, v], i) => ({ index: i + 1, name, matchName: `l${i}`, type: "param", value: v })) });
        const lookFx: any[] = [];
        if (a.look?.levels) lookFx.push(lv(Object.fromEntries(Object.entries(a.look.levels).map(([r, v]) => [{ in_black: "Input Black", in_white: "Input White", out_black: "Output Black", out_white: "Output White" }[r as string], v]))));
        if (a.look?.blurriness) lookFx.push({ index: lookFx.length + 1, name: "Gaussian Blur", matchName: "ADBE Gaussian Blur 2", params: [{ index: 1, name: "Blurriness", matchName: "g1", type: "param", value: a.look.blurriness }] });
        const details: any[] = [{ index: layers.find((l) => l.id === 777)!.index, id: 777, name: `${a.name} INSERT`, enabled: true, start_time: a.insert_start, motion_blur: a.motion_blur === "transform_pin", blending_mode: 5212, track_matte_type: 5012, matte_layer_id: null, effects: lookFx }];
        if (reflect) details.push({ index: 2, id: 778, name: `${a.name} reflections`, enabled: true, start_time: 0, motion_blur: false, blending_mode: 5220, track_matte_type: 5013, matte_layer_id: 777, opacity: a.reflections.opacity, effects: [lv({ "Input Black": a.reflections.threshold })] });
        const used = a.expansion_pct > 0 ? a.expanded : a.exact;
        const pick = (i: number) => used;
        void pick;
        const sample = (role: string, t: number) => {
          const i = a.times.findIndex((x: number) => Math.abs(x - t) < 1e-9);
          return { time: t, value: (used as any)[role][i] };
        };
        const out = {
          comp_id: 1,
          num_layers: layers.length,
          comp_motion_blur: a.motion_blur === "transform_pin",
          layers,
          details,
          insert_comp: { id: 888, width: a.insert_size[0], height: a.insert_size[1], num_layers: 1 },
          keys: {
            items: (args.keys ?? []).map((it: any) => ({
              layer_id: it.layer_id,
              found: true,
              props:
                it.kind === "transform"
                  ? ["position", "rotation", "scale"].map((role) => ({
                      role,
                      numKeys: a.times.length,
                      samples: it.times.map((t: number) => ({ time: t, value: a.transform[role][a.times.findIndex((x: number) => Math.abs(x - t) < 1e-9)] })),
                    }))
                  : ["ul", "ur", "ll", "lr"].map((role) => ({ role, numKeys: a.times.length, samples: it.times.map((t: number) => sample(role, t)) })),
            })),
          },
        };
        opts.breakAfter?.(out);
        return ok(out);
      }
      throw new Error(`Unexpected script: ${script}`);
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge: host, queue, quarantine };
  return { ctx, calls, fns: () => calls.map((c) => c.fn) };
}

describe("ae_screen_corners", () => {
  const guesses = (): Vec2[] => [[84, 46], [236, 60], [240, 146], [80, 150]];

  it("snaps the guesses from one render and changes nothing in the project", async () => {
    const { ctx, calls, fns } = fakeAe();
    const args = AeScreenCornersSchema.parse({ comp_id: 1, corners: guesses(), ref_time: 0.3 });
    const out = (await tool("ae_screen_corners").handler(args, ctx)) as Out;
    expect(out.ok).toBe(true);
    expect(out.read_only).toBe(true);
    // Reads only: the comp, then one render of the comp itself.
    expect(fns()).toEqual(["planarComp", "snapshotFrame"]);
    expect(calls[1].args).toMatchObject({ comp_id: 1, time: 0.3 });
    expect(out.ref_time).toBe(0.3);
    expect(out.corners).toHaveLength(4);
    out.corners.forEach((c: Out, i: number) => {
      expect(c.name).toBe(["UL", "UR", "LR", "LL"][i]);
      expect(c.method).toBe("edge_intersection");
      expect(dist(c.snapped, SCREEN[i])).toBeLessThan(1);
      expect(c.guess).toEqual(guesses()[i]);
      expect(c.shift_px).toBeGreaterThan(2);
      expect(c.confidence).toBeGreaterThan(0.5);
    });
    expect(out.quad.convex).toBe(true);
    expect(out.aspect.estimate).toBeGreaterThan(1);
    expect(out.aspect.method).toMatch(/perspective|edge_lengths|assumed_focal/);
    expect(out.aspect.use).toBe(out.aspect.estimate);
    expect(out.suggested_points.length).toBeGreaterThanOrEqual(1);
    expect(out.suggested_points_for_track_multi[0]).toHaveLength(2);
    expect(fs.existsSync(out.preview_path)).toBe(true);
    expect(PNG.sync.read(fs.readFileSync(out.preview_path)).width).toBe(W);
    // The render file was deleted again; only the preview stays.
    expect(fs.readdirSync(path.dirname(out.preview_path)).filter((n) => n.startsWith("frame_c1_"))).toEqual([]);
    expect(out.notes.join(" ")).toMatch(/estimate|plain ratio|focal length/);
  });

  it("uses a given insert_aspect, reports the track excursions, and skips the preview on request", async () => {
    const t = trackOf([0, 1, 2, 3].map((k) => ({ t: k / 10, H: rotH(0, 1, k * 60, 0) })), { track_id: "trk_screen_corners_1" });
    saveTrack(t);
    const { ctx } = fakeAe();
    const args = AeScreenCornersSchema.parse({ comp_id: 1, corners: guesses(), ref_time: 0, insert_aspect: 16 / 9, track: { track_id: t.track_id }, preview: false });
    const out = (await tool("ae_screen_corners").handler(args, ctx)) as Out;
    expect(out.ok).toBe(true);
    expect(out.aspect.given).toBeCloseTo(16 / 9, 9);
    expect(out.aspect.use).toBeCloseTo(16 / 9, 9);
    expect(out.track.frames_checked).toBe(4);
    expect(out.track.frames_outside).toBeGreaterThanOrEqual(1);
    expect(out.notes.join(" ")).toMatch(/leaves the frame/);
    expect(out.preview_path).toBeUndefined();
  });

  it("refuses guesses that are not a quad, a track in another comp size, and a missing stored track", async () => {
    const { ctx, calls } = fakeAe();
    const bad = AeScreenCornersSchema.parse({ comp_id: 1, corners: [[80, 50], [240, 56], [84, 146], [236, 150]] });
    expect(await tool("ae_screen_corners").handler(bad, ctx)).toMatchObject({ ok: false, error: "bad_args" });
    expect(calls.some((c) => c.fn === "snapshotFrame")).toBe(false);
    const other = trackOf([{ t: 0, H: identityH() }], { track_id: "trk_screen_corners_2", comp_size: [100, 100] });
    saveTrack(other);
    const f = fakeAe();
    expect(await tool("ae_screen_corners").handler(AeScreenCornersSchema.parse({ comp_id: 1, corners: guesses(), ref_time: 0, track: { track_id: other.track_id } }), f.ctx)).toMatchObject({ ok: false, error: "refused" });
    expect(await tool("ae_screen_corners").handler(AeScreenCornersSchema.parse({ comp_id: 1, corners: guesses(), ref_time: 0, track: { track_id: "trk_nope" } }), fakeAe().ctx)).toMatchObject({ ok: false, error: "not_found" });
  });

  it("notes when the track has no motion at ref_time", async () => {
    const t = trackOf([{ t: 0.5, H: identityH() }, { t: 0.6, H: null }], { track_id: "trk_screen_corners_3", ref_time: 0.5 });
    saveTrack(t);
    const out = (await tool("ae_screen_corners").handler(AeScreenCornersSchema.parse({ comp_id: 1, corners: guesses(), ref_time: 0.6, track: { track_id: t.track_id } }), fakeAe().ctx)) as Out;
    expect(out.ok).toBe(true);
    expect(out.track).toBeUndefined();
    expect(out.notes.join(" ")).toMatch(/no solved motion/);
  });

  it("with isolate_layers renders a temporary copy, removes it, and returns a receipt", async () => {
    const { ctx, calls, fns } = fakeAe();
    const args = AeScreenCornersSchema.parse({ comp_id: 1, corners: guesses(), ref_time: 0.2, isolate_layers: [{ index: 2 }], expect: expectArg, preview: false });
    const out = (await tool("ae_screen_corners").handler(args, ctx)) as Out;
    expect(out.ok).toBe(true);
    expect(out.read_only).toBeUndefined();
    expect(fns()).toEqual(["planarComp", "checkGuard", "planarIsolateBegin", "snapshotFrame", "planarIsolateEnd"]);
    expect(calls.find((c) => c.fn === "snapshotFrame")!.args.comp_id).toBe(COPY_ID);
    expect(out.temp_comp).toEqual({ copy_removed: true });
    expect(out.receipt.matches).toBe(true);
    expect(out.checkpoint).toBeDefined();
    expect(out.corners[0].method).toBe("edge_intersection");
  });

  it("removes the copy and reports it when the render fails", async () => {
    const { ctx, fns } = fakeAe({ failRenders: true });
    const args = AeScreenCornersSchema.parse({ comp_id: 1, corners: guesses(), ref_time: 0.2, isolate_layers: [{ index: 2 }], expect: expectArg });
    const out = (await tool("ae_screen_corners").handler(args, ctx)) as Out;
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/render failed|did not produce/);
    expect(out.temp_comp.copy_removed).toBe(true);
    expect(fns()).toContain("planarIsolateEnd");
    expect(out.receipt.matches).toBe(true);
  });

  it("with isolate_layers, a wrong-size or missing track fails before any write", async () => {
    const other = trackOf([{ t: 0, H: identityH() }], { track_id: "trk_screen_corners_iso", comp_size: [100, 100] });
    saveTrack(other);
    for (const id of [other.track_id, "trk_nope_iso"]) {
      const f = fakeAe();
      const args = AeScreenCornersSchema.parse({ comp_id: 1, corners: guesses(), ref_time: 0, isolate_layers: [{ index: 2 }], expect: expectArg, track: { track_id: id } });
      const out = (await tool("ae_screen_corners").handler(args, f.ctx)) as Out;
      expect(out.ok).toBe(false);
      expect(f.fns()).not.toContain("planarIsolateBegin");
      expect(f.fns()).not.toContain("checkGuard");
    }
  });

  it("refuses isolate_layers without expect before touching AE", async () => {
    const { ctx, calls } = fakeAe();
    const args = { ...AeScreenCornersSchema.parse({ comp_id: 1, corners: guesses() }), isolate_layers: [{ index: 1 }] };
    expect(await tool("ae_screen_corners").handler(args, ctx)).toMatchObject({ ok: false, error: "bad_args" });
    expect(calls).toEqual([]);
  });
});

describe("ae_screen_replace", () => {
  const storeTrack = (id: string, extra: Partial<PlanarTrack> = {}) => {
    const t = trackOf([0, 1, 2, 3, 4, 5].map((k) => ({ t: k / 10, H: rotH(0, 1, k * 4, k) })), { track_id: id, ...extra });
    saveTrack(t);
    return t;
  };
  const base = (id: string, extra: Record<string, unknown> = {}) => ({ comp_id: 1, track: { track_id: id }, corners: SCREEN, ref_time: 0, insert: { item_id: 55 }, expect: expectArg, max_samples: 4, ...extra });
  const run = (args: Record<string, unknown>, ae = fakeAe()) => tool("ae_screen_replace").handler(AeScreenReplaceSchema.parse(args), ae.ctx).then((out) => ({ out: out as Out, ae }));

  it("measures the plate, writes in one guarded call, reads back separately, and writes the before / after sheet", async () => {
    storeTrack("trk_sr_1");
    const { out, ae } = await run(base("trk_sr_1"));
    expect(out.ok).toBe(true);
    expect(out.applied).toBe(true);
    // Order: reads and renders, the guard, the before read, the write, the after read, then the sheet's renders.
    const fns = ae.fns();
    const iGuard = fns.indexOf("checkGuard");
    const iWrite = fns.indexOf("screenrepApply");
    // Guard first: a read-only check opens the call, before any plate render.
    expect(fns.slice(0, 3)).toEqual(["checkGuard", "screenrepInfo", "snapshotFrame"]);
    const iGuard2 = fns.lastIndexOf("checkGuard");
    expect(iGuard2).toBeGreaterThan(iGuard);
    expect(fns.slice(iGuard2, iWrite + 2)).toEqual(["checkGuard", "screenrepRead", "screenrepApply", "screenrepRead"]);
    expect(fns.slice(0, iGuard2).every((f) => f === "checkGuard" || f === "screenrepInfo" || f === "snapshotFrame")).toBe(true);
    expect(fns.slice(iWrite + 2).every((f) => f === "snapshotFrame")).toBe(true);
    expect(fns.slice(iWrite + 2).length).toBeGreaterThanOrEqual(2);
    const w = ae.calls[iWrite];
    expect(w.script).toContain('"expect"');
    expect(w.args).toMatchObject({ comp_id: 1, name: "Clip.mov", pin: "power_pin", expansion_pct: 2, motion_blur: "none" });
    expect(w.args.insert).toEqual({ item_id: 55 });
    expect(w.args.plate).toEqual({ index: 2, id: 100 });
    // The source is 1920 x 1080 and filled: the comp has the screen's aspect and one side of the source.
    expect(w.args.insert_size[0] === 1920 || w.args.insert_size[1] === 1080).toBe(true);
    expect(w.args.insert_size[0] / w.args.insert_size[1]).toBeGreaterThan(1.2);
    expect(w.args.times).toHaveLength(6);
    expect(w.args.exact.ul).toHaveLength(6);
    expect(w.args.look.levels.out_black).toBeGreaterThan(0.01);
    expect(out.receipt.mismatches).toEqual([]);
    expect(out.insert).toMatchObject({ comp: { id: 888 }, layer: { id: 777 }, fit: "fill" });
    expect(out.measured.frames_measured).toBeGreaterThanOrEqual(3);
    expect(out.measured.plate_black).toBeGreaterThan(0.02);
    expect(out.measured.plate_black).toBeLessThan(0.2);
    expect(out.measured.insert.source).toBe("assumed");
    expect(out.measured.budget.renders).toBeGreaterThanOrEqual(3);
    expect(out.look.levels_plan.out_black).toBeCloseTo(out.measured.plate_black, 3);
    expect(out.aspect.used).toBeGreaterThan(1);
    expect(out.track).toMatchObject({ track_id: "trk_sr_1", frames_written: 6 });
    expect(out.follow_ups.join(" ")).toMatch(/roto/);
    expect(out.checkpoint).toBeDefined();
    expect(fs.existsSync(out.sheet_path)).toBe(true);
    expect(PNG.sync.read(fs.readFileSync(out.sheet_path)).height).toBeGreaterThan(100);
    // The layer is the insert; the read-back asked for the keys of the insert layer.
    const after = ae.calls[iWrite + 1];
    expect(after.args.layer_ids).toEqual([777]);
    expect(after.args.insert_comp_id).toBe(888);
    expect(after.args.keys[0]).toMatchObject({ layer_id: 777, kind: "power_pin", effect_index: 3 });
  }, 30000);

  it("takes the aspect from insert_aspect and sizes the insert comp from the source", async () => {
    storeTrack("trk_sr_2");
    const { out, ae } = await run(base("trk_sr_2", { insert_aspect: 4 / 3, fit: "fit", match_look: false, contact_sheet: false }));
    expect(out.ok).toBe(true);
    const w = ae.calls.find((c) => c.fn === "screenrepApply")!;
    expect(w.args.insert_size).toEqual([1920, 1440]);
    expect(out.aspect).toMatchObject({ used: 1.333, given: 4 / 3 });
    // No look and no sheet: no renders at all.
    expect(ae.fns()).not.toContain("snapshotFrame");
    expect(w.args.look).toEqual({});
    expect(out.sheet_path).toBeUndefined();
  });

  it("passes a layer insert, switch-off, reflections and transform_pin to the host", async () => {
    storeTrack("trk_sr_3", { model: "perspective", ref_points: [[1, 1], [2, 2], [3, 3], [4, 4]] });
    const { out, ae } = await run(base("trk_sr_3", { insert: { layer: { name: "Clip" } }, plate: { name: "Plate" }, reflections: true, reflection_opacity: 70, motion_blur: "transform_pin", pin: "corner_pin", expansion_pct: 0, contact_sheet: false, white_mode: "match" }));
    expect(out.ok).toBe(true);
    const w = ae.calls.find((c) => c.fn === "screenrepApply")!.args;
    expect(w.insert).toEqual({ layer: { index: 1, id: 101 } });
    expect(w.switch_off_source).toBe(true);
    expect(w.reflections).toMatchObject({ opacity: 70 });
    expect(w.reflections.threshold).toBeGreaterThan(0);
    expect(w.reflections.threshold).toBeLessThanOrEqual(0.98);
    expect(w.pin).toBe("corner_pin");
    expect(w.motion_blur).toBe("transform_pin");
    expect(w.transform.position).toHaveLength(6);
    expect(w.look.levels.out_white).toBeLessThanOrEqual(1);
    expect(out.receipt.mismatches).toEqual([]);
    expect(out.source_layer).toMatchObject({ id: 101 });
    expect(out.notes.join(" ")).toMatch(/duplicate of the plate/);
  });

  it("flags a reflection layer whose opacity in the read-back differs from what was written", async () => {
    storeTrack("trk_sr_4b");
    const args = base("trk_sr_4b", { plate: { name: "Plate" }, reflections: true, reflection_opacity: 70, contact_sheet: false, match_look: false });
    const clean = await run(args);
    expect(clean.out.receipt.mismatches).toEqual([]);
    const ae = fakeAe({
      breakAfter: (after) => {
        after.details.find((d: any) => d.id === 778).opacity = 40;
      },
    });
    const { out } = await run(args, ae);
    expect(out.applied).toBe(true);
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches.map((m: any) => m.path)).toContain("reflection.opacity");
  });

  it("flags a read-back that differs from what was written, without throwing", async () => {
    storeTrack("trk_sr_4");
    const ae = fakeAe({
      breakAfter: (after) => {
        after.insert_comp.width += 1;
        after.keys.items[0].props[1].numKeys -= 1;
      },
    });
    const { out } = await run(base("trk_sr_4", { contact_sheet: false }), ae);
    expect(out.applied).toBe(true);
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches.map((m: any) => m.path)).toEqual(expect.arrayContaining(["insert_comp.size", "keys.ur.numKeys"]));
  });

  it("reports a failed read-back as applied, never as an error", async () => {
    storeTrack("trk_sr_5");
    const { out } = await run(base("trk_sr_5", { contact_sheet: false }), fakeAe({ noAfter: true }));
    expect(out.applied).toBe(true);
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches[0].message).toMatch(/Do not resend/);
  });

  it("copes with renders that fail: no look, no sheet, the write still happens", async () => {
    storeTrack("trk_sr_6");
    const { out, ae } = await run(base("trk_sr_6"), fakeAe({ failRenders: true }));
    expect(out.ok).toBe(true);
    expect(out.applied).toBe(true);
    expect(ae.calls.find((c) => c.fn === "screenrepApply")!.args.look).toEqual({});
    expect(out.measured.frames_measured).toBe(0);
    expect(out.measured.skipped.length).toBeGreaterThan(0);
    expect(out.notes.join(" ")).toMatch(/Levels not added/);
    expect(out.sheet_path).toBeUndefined();
    expect(out.notes.join(" ")).toMatch(/sheet could not be made/);
  });

  it("stops rendering at the budget and says how many frames it measured", async () => {
    storeTrack("trk_sr_7");
    const { out, ae } = await run(base("trk_sr_7", { max_renders: 2, contact_sheet: false, max_samples: 6 }));
    expect(out.ok).toBe(true);
    expect(ae.calls.filter((c) => c.fn === "snapshotFrame").length).toBeLessThanOrEqual(2 + 0);
    expect(out.measured.budget.renders).toBeLessThanOrEqual(2);
    expect(out.measured.trimmed).toBe(true);
  });

  it("uses a given blur and insert levels, converts to linear light, and notes a sharp edge", async () => {
    storeTrack("trk_sr_8");
    const lin = fakeAe({ info: { linear_blending: true, linearize_working_space: true } });
    const { out, ae } = await run(base("trk_sr_8", { blur_px: 1.4, insert_black: 0.03, insert_white: 0.9, contact_sheet: false }), lin);
    const w = ae.calls.find((c) => c.fn === "screenrepApply")!.args;
    // The blur runs before the pin, in the insert's own pixels: 1.4 px on screen is scaled by sqrt(insert area / screen area).
    const pinScale = Math.sqrt((w.insert_size[0] * w.insert_size[1]) / polygonArea(SCREEN));
    expect(pinScale).toBeGreaterThan(1.5);
    expect(w.look.blurriness).toBeCloseTo(2.5 * 1.4 * pinScale, 1);
    expect(out.look.blur_sigma_layer_px).toBeCloseTo(1.4 * pinScale, 1);
    expect(out.measured.insert).toMatchObject({ source: "given", black: 0.03, white: 0.9 });
    expect(w.look.levels.in_black).toBeCloseTo(0.0023, 3);
    expect(out.notes.join(" ")).toMatch(/working space is linearized/);
    const sharp = await run(base("trk_sr_8", { blur_px: 0.2, contact_sheet: false }));
    expect(sharp.out.notes.join(" ")).toMatch(/no blur was added/);
    expect(sharp.ae.calls.find((c) => c.fn === "screenrepApply")!.args.look.blurriness).toBeUndefined();
  });

  it("does not convert to linear light when only the blending is linear", async () => {
    storeTrack("trk_sr_8b");
    const blendOnly = fakeAe({ info: { linear_blending: true, linearize_working_space: false } });
    const { out, ae } = await run(base("trk_sr_8b", { blur_px: 1.4, insert_black: 0.03, insert_white: 0.9, contact_sheet: false }), blendOnly);
    const w = ae.calls.find((c) => c.fn === "screenrepApply")!.args;
    expect(w.look.levels.in_black).toBeCloseTo(0.03, 6);
    expect(out.notes.join(" ")).toMatch(/not linearized/);
  });

  it("refuses an insert layer that is the plate, and an insert that is the target comp, before measuring", async () => {
    storeTrack("trk_sr_8c");
    const samePlate = fakeAe({ info: { insert: { kind: "footage", item_id: 55, name: "Clip.mov", width: 1920, height: 1080, duration: 10, has_video: true, missing: false, pixel_aspect: 1, from_layer: { index: 2, id: 100, name: "Plate", locked: false, enabled: true, three_d: false } } } });
    const a = await run(base("trk_sr_8c", { insert: { layer: { index: 2, id: 100 } }, contact_sheet: false }), samePlate);
    expect(a.out.ok).toBe(false);
    expect(a.out.message).toMatch(/plate layer/);
    expect(a.ae.calls.some((c) => c.fn === "snapshotFrame" || c.fn === "screenrepApply")).toBe(false);
    const selfComp = fakeAe({ info: { insert: { kind: "comp", item_id: 1, name: "Main", width: W, height: H, duration: 1, has_video: true, missing: false, pixel_aspect: 1 } } });
    const b = await run(base("trk_sr_8c", { insert: { item_id: 1 }, contact_sheet: false }), selfComp);
    expect(b.out.ok).toBe(false);
    expect(b.out.message).toMatch(/itself/);
    expect(b.ae.calls.some((c) => c.fn === "snapshotFrame" || c.fn === "screenrepApply")).toBe(false);
  });

  it("measures an insert that is a comp and uses its own black and white as Levels' input", async () => {
    storeTrack("trk_sr_9");
    const comp = fakeAe({ info: { insert: { kind: "comp", item_id: 888, name: "Edit", width: 1920, height: 1080, duration: 10, has_video: true, missing: false, pixel_aspect: 1 } } });
    const { out, ae } = await run(base("trk_sr_9", { insert: { item_id: 888 }, contact_sheet: false, blur_px: 0 }), comp);
    expect(out.measured.insert.source).toBe("measured");
    expect(out.measured.insert.frames).toBe(3);
    expect(ae.calls.filter((c) => c.fn === "snapshotFrame" && c.args.comp_id === 888)).toHaveLength(3);
    // The insert's picture runs from about 10 to 170 gray levels: Input Black and White come from it.
    const w = ae.calls.find((c) => c.fn === "screenrepApply")!.args;
    expect(w.look.levels.in_white).toBeLessThan(0.8);
    expect(w.look.levels.in_white).toBeGreaterThan(0.5);
    expect(w.look.levels.in_black).toBeLessThan(0.1);
    expect(out.measured.insert.black).toBeCloseTo(w.look.levels.in_black, 3);
  });

  it("refuses before the guard when the corners, the track or the layers are wrong", async () => {
    storeTrack("trk_sr_10");
    const refuses = async (args: Record<string, unknown>, ae = fakeAe(), re: RegExp, error?: string) => {
      const { out } = await run(args, ae);
      expect(out.ok).toBe(false);
      if (error) expect(out.error).toBe(error);
      expect(out.message).toMatch(re);
      // Only the read-only pre-check of the guard; no plate render, no second guard, no write.
      expect(ae.fns().filter((f) => f === "checkGuard").length).toBeLessThanOrEqual(1);
      expect(ae.fns()).not.toContain("snapshotFrame");
      expect(ae.fns()).not.toContain("screenrepApply");
    };
    await refuses({ ...base("trk_sr_10"), corners: [SCREEN[0], SCREEN[2], SCREEN[1], SCREEN[3]] }, fakeAe(), /do not make a quad/, "bad_args");
    await refuses(base("trk_sr_10", { ref_time: 5 }), fakeAe(), /no solved motion/, "bad_args");
    await refuses(base("trk_sr_nope"), fakeAe(), /No stored track/, "not_found");
    const small = trackOf([{ t: 0, H: identityH() }], { track_id: "trk_sr_small", comp_size: [100, 100] });
    saveTrack(small);
    await refuses(base("trk_sr_small"), fakeAe(), /comp sizes|sizes must match/, "refused");
    storeTrack("trk_sr_persp", { model: "perspective", ref_points: [[1, 1], [2, 2], [3, 3]] });
    await refuses(base("trk_sr_persp"), fakeAe(), /perspective needs 4 or more/, "refused");
    await refuses(base("trk_sr_10", { reflections: true, plate: { name: "Plate" } }), fakeAe({ info: { can_set_track_matte: false } }), /23 or later/, "refused");
    await refuses(base("trk_sr_10", { reflections: true, plate: { name: "Plate" } }), fakeAe({ info: { plate: { index: 2, id: 100, name: "Plate", locked: true, enabled: true, three_d: false } } }), /is locked/, "refused");
    await refuses(base("trk_sr_10", { insert: { layer: { name: "Clip" } } }), fakeAe({ info: { insert: { kind: "footage", item_id: 55, name: "Clip.mov", width: 1920, height: 1080, duration: 10, has_video: true, missing: false, pixel_aspect: 1, from_layer: { index: 1, id: 101, name: "Clip", locked: true, enabled: true, three_d: false } } } }), /is locked/, "refused");
    await refuses(base("trk_sr_10"), fakeAe({ info: { comp: { id: 1, name: "Main", width: W, height: H, pixel_aspect: 2, fps: 10, duration: 1, time: 0, work_area_start: 0, work_area_duration: 1, num_layers: 2, motion_blur: false } } }), /pixel aspect/, "refused");
    await refuses(base("trk_sr_10", { range: { start: 9, end: 10 } }), fakeAe(), /No frame of the track is ok/, "bad_args");
  });

  it("writes only the track frames in the range", async () => {
    storeTrack("trk_sr_11");
    const { out, ae } = await run(base("trk_sr_11", { range: { start: 0.2, end: 0.4 }, match_look: false, contact_sheet: false }));
    expect(out.ok).toBe(true);
    const wr = ae.calls.find((c) => c.fn === "screenrepApply")!.args;
    expect(wr.times).toEqual([0.2, 0.3, 0.4]);
    expect(wr.trim_to_keys).toBe(true);
    // The note's own wording: /range/ alone also matches the aspect note ("range 1.6-4.1").
    expect(out.notes.join(" ")).toMatch(/cut to its range/);
    const full = await run(base("trk_sr_11", { match_look: false, contact_sheet: false }));
    expect(full.ae.calls.find((c) => c.fn === "screenrepApply")!.args.trim_to_keys).toBeUndefined();
    expect(full.out.notes.join(" ")).not.toMatch(/cut to its range/);
  });

  it("re-bases the track on ref_time: at that frame the insert's corners are on the screen", async () => {
    storeTrack("trk_sr_12");
    const { ae } = await run(base("trk_sr_12", { ref_time: 0.3, match_look: false, contact_sheet: false }));
    const w = ae.calls.find((c) => c.fn === "screenrepApply")!.args;
    const i = w.times.findIndex((t: number) => Math.abs(t - 0.3) < 1e-9);
    const identity = buildInsertKeys({ frames: [{ time: 0, ok: true, H: identityH(), points: [], confidence: [], rms_px: 0, inliers: 4 }], refCorners: SCREEN, compSize: [W, H], insertSize: w.insert_size, expansionPct: 2, transform: false });
    expect(w.expanded.ul[i][0]).toBeCloseTo(identity.expanded.ul[0][0], 2);
    expect(w.expanded.ul[i][1]).toBeCloseTo(identity.expanded.ul[0][1], 2);
  });

  it("sends the host exactly the keys the check will compare against", async () => {
    storeTrack("trk_sr_13");
    const { out, ae } = await run(base("trk_sr_13", { match_look: false, contact_sheet: false, pin: "corner_pin", expansion_pct: 0 }));
    const w = ae.calls.find((c) => c.fn === "screenrepApply")!.args;
    expect(w.exact).toEqual(w.expanded);
    expect(out.pin).toMatchObject({ kind: "corner_pin", values_used: "exact" });
    expect(out.receipt.mismatches).toEqual([]);
  });
});
