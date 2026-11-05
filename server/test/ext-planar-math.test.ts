import { describe, expect, it } from "vitest";
import {
  applyH,
  boundingQuad,
  decomposeLayerMatrix,
  decomposeSimilarity,
  frameAt,
  goodFeatures,
  identityH,
  invertH,
  jacobianAt,
  layerMatrix,
  mulH,
  quadCheck,
  ransacModel,
  rectQuad,
  relativeTo,
  smoothFrames,
  solveModel,
  transformShape,
  unwrapDegrees,
  type Mat3,
  type PlanarFrame,
  type PlanarTrack,
  type Vec2,
} from "../src/tools/ext/planar-math.js";

const close = (a: ArrayLike<number>, b: ArrayLike<number>, tol = 1e-6) => {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) expect(Math.abs(a[i] - b[i])).toBeLessThan(tol);
};

const rot = (deg: number, s: number, tx: number, ty: number): Mat3 => {
  const r = (deg * Math.PI) / 180;
  return [s * Math.cos(r), -s * Math.sin(r), tx, s * Math.sin(r), s * Math.cos(r), ty, 0, 0, 1];
};

const SQUARE: Vec2[] = [
  [100, 80],
  [400, 90],
  [380, 300],
  [90, 280],
  [250, 190],
  [150, 150],
];

const mapAll = (h: Mat3, pts: Vec2[]) => pts.map((p) => applyH(h, p) as Vec2);

describe("matrices", () => {
  it("multiplies right to left, inverts and applies", () => {
    const a = rot(30, 1.2, 10, -5);
    const b: Mat3 = [1, 0, 7, 0, 1, 3, 0, 0, 1];
    const p: Vec2 = [20, 40];
    close(applyH(mulH(a, b), p) as Vec2, applyH(a, applyH(b, p) as Vec2) as Vec2);
    close(mulH(a, invertH(a)!), identityH());
    const persp: Mat3 = [1.1, 0.05, 3, -0.02, 0.95, 4, 0.0004, 0.0002, 1];
    close(mulH(persp, invertH(persp)!), identityH(), 1e-9);
  });

  it("refuses a singular matrix and a point behind the plane", () => {
    expect(invertH([1, 2, 3, 2, 4, 6, 0, 0, 1])).toBeNull();
    // A small scale far from the origin is well conditioned: the translation must not make it look singular.
    const small: Mat3 = [0.12, 0, 2769.6, 0, 0.12, 1370.4, 0, 0, 1];
    const inv = invertH(small);
    expect(inv).not.toBeNull();
    close(mulH(small, inv!), identityH(), 1e-9);
    // Still singular when the linear part collapses, however far away the translation is.
    expect(invertH([0, 0, 2769.6, 0, 0, 1370.4, 0, 0, 1])).toBeNull();
    expect(invertH([1, 2, 5000, 2, 4, 5000, 0, 0, 1])).toBeNull();
    expect(applyH([1, 0, 0, 0, 1, 0, 0, 0, 0], [1, 1])).toBeNull();
    expect(applyH([1, 0, 0, 0, 1, 0, -0.01, 0, 1], [200, 0])).toBeNull();
  });
});

describe("solveModel", () => {
  it("fits a translation", () => {
    const sol = solveModel("translate", SQUARE, SQUARE.map((p) => [p[0] + 12.5, p[1] - 4] as Vec2))!;
    close(sol.H, [1, 0, 12.5, 0, 1, -4, 0, 0, 1]);
    expect(sol.rms_px).toBeLessThan(1e-9);
  });

  it("fits a similarity from two points and from many", () => {
    const truth = rot(17, 1.15, 30, -12);
    for (const n of [2, 3, 6]) {
      const sol = solveModel("similarity", SQUARE.slice(0, n), mapAll(truth, SQUARE.slice(0, n)))!;
      close(sol.H, truth, 1e-6);
    }
  });

  it("fits an affine and a perspective, exactly with four points and by least squares with more", () => {
    const aff: Mat3 = [1.1, 0.2, 5, -0.1, 0.9, -3, 0, 0, 1];
    close(solveModel("affine", SQUARE, mapAll(aff, SQUARE))!.H, aff, 1e-6);
    const persp: Mat3 = [1.05, 0.04, 8, -0.03, 0.98, -6, 0.0003, -0.0001, 1];
    close(solveModel("perspective", SQUARE.slice(0, 4), mapAll(persp, SQUARE.slice(0, 4)))!.H, persp, 1e-6);
    const six = solveModel("perspective", SQUARE, mapAll(persp, SQUARE))!;
    close(six.H, persp, 1e-6);
    expect(six.rms_px).toBeLessThan(1e-6);
  });

  it("reports the residual of a noisy fit", () => {
    const noisy = SQUARE.map((p, i) => [p[0] + (i % 2 ? 1.5 : -1.5), p[1]] as Vec2);
    const sol = solveModel("affine", SQUARE, noisy)!;
    expect(sol.rms_px).toBeGreaterThan(0.1);
    expect(sol.max_px).toBeGreaterThanOrEqual(sol.rms_px);
  });

  it("returns null for too few, coincident or collinear points", () => {
    expect(solveModel("similarity", [[1, 1]], [[2, 2]])).toBeNull();
    expect(solveModel("similarity", [[5, 5], [5, 5]], [[1, 1], [9, 9]])).toBeNull();
    const line: Vec2[] = [[0, 0], [10, 10], [20, 20], [30, 30]];
    expect(solveModel("affine", line.slice(0, 3), line.slice(0, 3))).toBeNull();
    expect(solveModel("perspective", line, line)).toBeNull();
    expect(solveModel("translate", [[1, 1], [NaN, 2]], [[1, 1], [2, 2]])).toBeNull();
  });
});

describe("ransacModel", () => {
  it("votes an outlier out and is repeatable", () => {
    const truth = rot(5, 1, 20, 10);
    const from = [...SQUARE, [300, 50] as Vec2, [60, 200] as Vec2];
    const to = mapAll(truth, from);
    to[2] = [to[2][0] + 60, to[2][1] - 40];
    const a = ransacModel("similarity", from, to, { thresholdPx: 2, iterations: 80, seed: 7 })!;
    expect(a.inliers.filter((v) => !v)).toHaveLength(1);
    expect(a.inliers[2]).toBe(false);
    close(a.H, truth, 1e-6);
    const b = ransacModel("similarity", from, to, { thresholdPx: 2, iterations: 80, seed: 7 })!;
    expect(b.H).toEqual(a.H);
  });

  it("is a plain fit when there are only as many points as the model needs", () => {
    const truth = rot(3, 1, 1, 2);
    const r = ransacModel("perspective", SQUARE.slice(0, 4), mapAll(truth, SQUARE.slice(0, 4)), { thresholdPx: 1, iterations: 10, seed: 1 })!;
    expect(r.inliers).toEqual([true, true, true, true]);
    expect(ransacModel("affine", SQUARE.slice(0, 2), SQUARE.slice(0, 2), { thresholdPx: 1, iterations: 5, seed: 1 })).toBeNull();
  });
});

describe("layer transforms", () => {
  it("layerMatrix follows AE: position + R S (p - anchor), clockwise rotation", () => {
    const m = layerMatrix({ anchor: [50, 50], position: [200, 100], scale_pct: [200, 100], rotation_deg: 90 });
    close(applyH(m, [50, 50]) as Vec2, [200, 100]);
    // The point 10 px right of the anchor: scaled x2 -> 20, rotated 90 deg clockwise (y down) -> 20 px below.
    close(applyH(m, [60, 50]) as Vec2, [200, 120], 1e-9);
  });

  it("decomposeLayerMatrix undoes layerMatrix, mirrored scale included", () => {
    for (const t of [
      { anchor: [10, 20] as Vec2, position: [100, 60] as Vec2, scale_pct: [80, 120] as Vec2, rotation_deg: -35 },
      { anchor: [0, 0] as Vec2, position: [5, 5] as Vec2, scale_pct: [100, -100] as Vec2, rotation_deg: 20 },
    ]) {
      const d = decomposeLayerMatrix(layerMatrix(t), t.anchor);
      close(d.position, t.position, 1e-9);
      close(d.scale_pct, t.scale_pct, 1e-9);
      expect(d.rotation_deg).toBeCloseTo(t.rotation_deg, 9);
    }
  });

  it("decomposeSimilarity gives position, rotation and scale about a pivot", () => {
    const h = rot(25, 1.3, 40, -20);
    const d = decomposeSimilarity(h, [100, 100]);
    close(d.position, applyH(h, [100, 100]) as Vec2, 1e-9);
    expect(d.rotation_deg).toBeCloseTo(25, 6);
    expect(d.scale_pct).toBeCloseTo(130, 6);
    expect(decomposeSimilarity([1, 0, 0, 0, 1, 0, 0, 0, 0], [3, 4]).scale_pct).toBe(100);
  });

  it("measures the local derivative of a perspective map", () => {
    const j = jacobianAt(rot(0, 2, 5, 5), [10, 10])!;
    close(j, [2, 0, 0, 2]);
    expect(jacobianAt([1, 0, 0, 0, 1, 0, 0, 0, 0], [0, 0])).toBeNull();
  });

  it("unwraps angles across the 180 degree seam", () => {
    close(unwrapDegrees([170, -175, -170, 179, -179]), [170, 185, 190, 179, 181]);
  });
});

describe("quads", () => {
  it("accepts a convex quad and a perspective one", () => {
    expect(quadCheck(rectQuad(100, 80)).ok).toBe(true);
    expect(quadCheck([[0, 0], [100, 10], [90, 90], [-5, 70]]).ok).toBe(true);
  });

  it("flags folded, collinear, collapsed and non-finite quads", () => {
    expect(quadCheck([[0, 0], [100, 100], [100, 0], [0, 100]]).reason).toMatch(/folded/);
    expect(quadCheck([[0, 0], [10, 0], [20, 0], [30, 0]]).ok).toBe(false);
    expect(quadCheck(rectQuad(3, 3)).reason).toMatch(/16/);
    expect(quadCheck([[0, 0], [1, NaN], [2, 2], [0, 2]]).ok).toBe(false);
    expect(quadCheck([[0, 0], [1, 1]]).ok).toBe(false);
  });

  it("makes a bounding quad with a minimum size", () => {
    expect(boundingQuad([[10, 20], [50, 60]])).toEqual(rectQuad(40, 40, 10, 20));
    const one = boundingQuad([[100, 100]], 10);
    expect(one[0]).toEqual([95, 95]);
    expect(one[2]).toEqual([105, 105]);
  });
});

function trackOf(frames: PlanarFrame[], refTime = 0): PlanarTrack {
  return { version: 1, track_id: "t1", comp_id: 1, comp_size: [640, 360], fps: 10, ref_time: refTime, model: "similarity", ref_points: [[100, 100], [300, 120]], frames, source: "test", created: "now" };
}
const fr = (time: number, H: Mat3 | null, ok = true): PlanarFrame => ({ time, ok, H, points: [null, null], confidence: [null, null], rms_px: 0, inliers: 2 });

describe("track helpers", () => {
  const frames = [fr(0, identityH()), fr(0.1, rot(0, 1, 5, 0)), fr(0.2, rot(0, 1, 10, 0)), fr(0.3, null, false), fr(0.4, rot(0, 1, 20, 0))];

  it("finds a frame within half a frame", () => {
    const t = trackOf(frames);
    expect(frameAt(t, 0.2)?.time).toBe(0.2);
    expect(frameAt(t, 0.204)?.time).toBe(0.2);
    expect(frameAt(t, 0.46)).toBeNull();
    expect(frameAt(t, 0.9)).toBeNull();
  });

  it("re-bases so the new reference frame is the identity", () => {
    const t = relativeTo(trackOf(frames), 0.2);
    expect(t.ref_time).toBe(0.2);
    close(t.frames[2].H!, identityH());
    close(t.frames[0].H!, [1, 0, -10, 0, 1, 0, 0, 0, 1]);
    close(t.frames[4].H!, [1, 0, 10, 0, 1, 0, 0, 0, 1]);
    expect(t.frames[3].ok).toBe(false);
    close(t.ref_points[0], [110, 100]);
  });

  it("nulls every H when the new reference frame is not ok", () => {
    const t = relativeTo(trackOf(frames), 0.3);
    expect(t.frames.every((f) => f.H === null && !f.ok)).toBe(true);
  });

  it("smooths jitter, keeps bad frames bad, and the reference stays the identity", () => {
    const jitter = [0, 1, -1, 1, -1, 1, -1, 0].map((j, i) => fr(i / 10, [1, 0, i * 10 + j * 4, 0, 1, 0, 0, 0, 1]));
    jitter[3] = fr(0.3, null, false);
    const t = trackOf(jitter);
    t.model = "translate";
    const s = smoothFrames(t, 1.5);
    expect(s.frames[3].ok).toBe(false);
    close(s.frames[0].H!, identityH(), 1e-9);
    const raw = jitter[4].H![2] - jitter[5].H![2] + 10;
    const smooth = s.frames[4].H![2] - s.frames[5].H![2] + 10;
    expect(Math.abs(smooth)).toBeLessThan(Math.abs(raw));
    expect(smoothFrames(t, 0)).toBe(t);
  });
});

describe("transformShape", () => {
  const shape = { vertices: [[0, 0], [100, 0], [100, 100], [0, 100]] as Vec2[], inTangents: [[-20, 0], [0, -20], [20, 0], [0, 20]] as Vec2[], outTangents: [[20, 0], [0, 20], [-20, 0], [0, -20]] as Vec2[] };

  it("maps vertices and rebuilds tangents; an affine map has no error", () => {
    const h = rot(90, 2, 10, 10);
    const out = transformShape(shape, h);
    expect(out.maxErrorPx).toBe(0);
    close(out.vertices[1], [10, 210], 1e-9);
    // The out tangent (+20, 0) turns 90 degrees clockwise and doubles: (0, 40).
    close(out.outTangents[0], [0, 40], 1e-9);
    close(out.inTangents[0], [0, -40], 1e-9);
  });

  it("measures how far a perspective map strays from a bezier", () => {
    const out = transformShape(shape, [1, 0, 0, 0, 1, 0, 0.004, 0, 1]);
    expect(out.maxErrorPx).toBeGreaterThan(0);
    expect(out.maxErrorPx).toBeLessThan(20);
    expect(() => transformShape(shape, [1, 0, 0, 0, 1, 0, -0.1, 0, 1])).toThrow(/behind/);
  });
});

describe("goodFeatures", () => {
  const W = 160;
  const H = 120;
  // Two bright squares on a dark, faintly noisy ground: four corners each.
  const data = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const inA = x >= 30 && x < 60 && y >= 30 && y < 60;
      const inB = x >= 100 && x < 130 && y >= 60 && y < 90;
      data[y * W + x] = inA || inB ? 220 : 30 + ((x * 7 + y * 13) % 5);
    }
  }
  const img = { width: W, height: H, data };

  it("finds corners, spread out", () => {
    const f = goodFeatures(img, null, { count: 6, minDistancePx: 12, patchSize: 11 });
    expect(f.length).toBeGreaterThanOrEqual(4);
    for (let i = 0; i < f.length; i++) {
      for (let j = i + 1; j < f.length; j++) expect(Math.hypot(f[i].x - f[j].x, f[i].y - f[j].y)).toBeGreaterThanOrEqual(12);
      expect(f[i].std).toBeGreaterThanOrEqual(3);
    }
    const nearCorner = (p: { x: number; y: number }, cx: number, cy: number) => Math.hypot(p.x - cx, p.y - cy) < 4;
    expect(f.some((p) => nearCorner(p, 30, 30))).toBe(true);
  });

  it("keeps points inside the mask and out of the excluded part", () => {
    const mask = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) mask[y * W + x] = x >= 80 ? 1 : 0;
    const f = goodFeatures(img, mask, { count: 8, minDistancePx: 10, patchSize: 11 });
    expect(f.length).toBeGreaterThan(0);
    expect(f.every((p) => p.x >= 80)).toBe(true);
  });

  it("finds nothing in a flat image", () => {
    expect(goodFeatures({ width: W, height: H, data: new Float32Array(W * H).fill(90) }, null, { count: 4, minDistancePx: 10, patchSize: 11 })).toEqual([]);
  });
});
