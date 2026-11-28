import { describe, expect, it } from "vitest";
import { applyH, invertH, mulH, type Mat3, type Vec2 } from "../src/tools/ext/planar-math.js";
import { compToImgH, imgToCompH, pyrDown, RegionAligner, RegionTracker, verdict } from "../src/tools/ext/region-track.js";
import type { GrayImage } from "../src/tools/ext/track.js";

// ---------- a textured plane under a known perspective motion ----------

const W = 320;
const H = 240;
/** The plane, at the reference frame (image px). */
const QUAD: Vec2[] = [[70, 50], [250, 55], [255, 190], [65, 185]];

const tex = (u: number, v: number): number =>
  128 + 40 * Math.sin(0.23 * u) * Math.cos(0.19 * v) + 30 * Math.sin(0.07 * u + 0.13 * v) + 25 * Math.sin(0.41 * u - 0.37 * v + 1) + 15 * Math.sin(0.83 * u) * Math.sin(0.71 * v);
const bg = (x: number, y: number): number => 90 + 50 * Math.sin(x * 0.9) * Math.cos(y * 1.3);

const inside = (q: Vec2[], p: Vec2) => {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const c = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    const s = Math.sign(c);
    if (s === 0) continue;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
};

/** Perspective motion at frame k (k = 0 is the reference). */
const motion = (k: number): Mat3 => {
  const r = (0.6 * k * Math.PI) / 180;
  const s = 1 + 0.006 * k;
  const c = [160, 120];
  // Rotate and scale about the centre, shift, and tilt a little.
  const R: Mat3 = [s * Math.cos(r), -s * Math.sin(r), 0, s * Math.sin(r), s * Math.cos(r), 0, 0, 0, 1];
  const T1: Mat3 = [1, 0, -c[0], 0, 1, -c[1], 0, 0, 1];
  const T2: Mat3 = [1, 0, c[0] + 2.3 * k, 0, 1, c[1] + 1.1 * k, 0, 0, 1];
  const P: Mat3 = [1, 0, 0, 0, 1, 0, 0.00004 * k, -0.00003 * k, 1];
  return mulH(T2, mulH(P, mulH(R, T1)));
};

interface Draw {
  cover?: { x: number; y: number; w: number; h: number };
}

function render(k: number, d: Draw = {}, Hk: Mat3 = motion(k)): GrayImage {
  const inv = invertH(Hk)!;
  const data = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = applyH(inv, [x, y]) as Vec2;
      let v = inside(QUAD, p) ? tex(p[0], p[1]) : bg(x, y);
      if (d.cover && x >= d.cover.x && x < d.cover.x + d.cover.w && y >= d.cover.y && y < d.cover.y + d.cover.h) v = 30 + 20 * Math.sin(x * 0.5);
      data[y * W + x] = v;
    }
  }
  return { width: W, height: H, data };
}

function maskOf(q: Vec2[]): Float32Array {
  const m = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (inside(q, [x, y])) m[y * W + x] = 1;
  return m;
}

/** Mean distance of the quad's corners under two motions, px. */
const cornerErr = (a: Mat3, b: Mat3) => QUAD.reduce((s, c) => s + Math.hypot(...((applyH(a, c) as Vec2).map((v, i) => v - (applyH(b, c) as Vec2)[i]) as [number, number])), 0) / 4;

const shrink = (q: Vec2[], k: number): Vec2[] => {
  const cx = q.reduce((s, p) => s + p[0], 0) / 4;
  const cy = q.reduce((s, p) => s + p[1], 0) / 4;
  return q.map((p) => [cx + (p[0] - cx) * k, cy + (p[1] - cy) * k] as Vec2);
};

describe("pyrDown", () => {
  it("halves the size, rounding up, and keeps a constant image constant", () => {
    const img: GrayImage = { width: 7, height: 5, data: new Float32Array(35).fill(42) };
    const d = pyrDown(img);
    expect([d.width, d.height]).toEqual([4, 3]);
    expect(Array.from(d.data).every((v) => Math.abs(v - 42) < 1e-4)).toBe(true);
  });
});

describe("RegionAligner", () => {
  const ref = render(0);
  const mask = maskOf(shrink(QUAD, 0.97));
  const al = new RegionAligner(ref, mask, { maxSamples: 6000 });

  it("finds a perspective motion to a few hundredths of a pixel from 8 px away", () => {
    const pyr = [render(6)];
    for (let l = 1; l < al.levels.length; l++) pyr.push(pyrDown(pyr[l - 1]));
    const truth = motion(6);
    const start = mulH([1, 0, 6, 0, 1, -5, 0, 0, 1], truth);
    const r = al.align(pyr, start);
    if ("failed" in r) throw new Error(r.failed);
    expect(cornerErr(r.H, truth)).toBeLessThan(0.05);
    expect(r.ncc).toBeGreaterThan(0.99);
    expect(r.coverage).toBeGreaterThan(0.9);
    expect(verdict(r)).toBe(true);
    const ex = al.expectedError(r, QUAD);
    expect(ex).not.toBeNull();
    expect(ex!).toBeGreaterThanOrEqual(0);
  });

  it("gives a frame that is not the surface a failing verdict", () => {
    const other = render(0, {}, [1, 0, 140, 0, 1, 90, 0, 0, 1]);
    const pyr = [other];
    for (let l = 1; l < al.levels.length; l++) pyr.push(pyrDown(pyr[l - 1]));
    const r = al.align(pyr, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect("failed" in r ? false : verdict(r)).toBe(false);
  });

  it("refuses a flat region", () => {
    const flat: GrayImage = { width: W, height: H, data: new Float32Array(W * H).fill(120) };
    expect(() => new RegionAligner(flat, mask)).toThrow(/flat|usable/);
  });

  it("converts between image and comp pixels both ways", () => {
    const h = motion(4);
    const c = imgToCompH(h, 2);
    const back = compToImgH(c, 2);
    for (let i = 0; i < 9; i++) expect(back[i]).toBeCloseTo(h[i] / h[8], 9);
    // A comp point p is image point p * 2 - 0.5.
    const p: Vec2 = [37.25, 81.5];
    const viaComp = applyH(c, p) as Vec2;
    const viaImg = applyH(h, [p[0] * 2 - 0.5, p[1] * 2 - 0.5]) as Vec2;
    expect(viaComp[0]).toBeCloseTo((viaImg[0] + 0.5) / 2, 9);
    expect(viaComp[1]).toBeCloseTo((viaImg[1] + 0.5) / 2, 9);
  });
});

describe("RegionTracker", () => {
  const ref = render(0);
  const mask = maskOf(shrink(QUAD, 0.97));

  it("follows the plane through an occluder that crosses it, and stays under 0.1 px", () => {
    const tr = new RegionTracker(new RegionAligner(ref, mask, { maxSamples: 6000 }), QUAD);
    let worst = 0;
    for (let k = 1; k <= 12; k++) {
      // A dark block slides across a third of the plane from frame 4 on.
      const cover = k >= 4 ? { x: 40 + 12 * (k - 4), y: 70, w: 70, h: 110 } : undefined;
      const s = tr.step(render(k, { cover }));
      expect(s.ok).toBe(true);
      worst = Math.max(worst, cornerErr(s.H, motion(k)));
    }
    expect(worst).toBeLessThan(0.1);
  });

  it("reports frames where the plane is gone, holds the last motion, and picks it up again", () => {
    const tr = new RegionTracker(new RegionAligner(ref, mask, { maxSamples: 6000 }), QUAD);
    for (let k = 1; k <= 3; k++) expect(tr.step(render(k)).ok).toBe(true);
    // Two frames of something else entirely (a cut away and back).
    const away = render(0, {}, [1, 0, 150, 0, 1, 100, 0, 0, 1]);
    const a = tr.step(away);
    expect(a.ok).toBe(false);
    expect(a.note).toMatch(/does not match|degenerate|aligned|out of/);
    expect(tr.step(away).misses).toBe(2);
    // The plane is back near where it was.
    const back = tr.step(render(4));
    expect(back.ok).toBe(true);
    expect(cornerErr(back.H, motion(4))).toBeLessThan(0.1);
  });
});
