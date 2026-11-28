import { describe, expect, it } from "vitest";
import { normalizeLight, PointTracker, type GrayImage } from "../src/tools/ext/track.js";

function gray(w: number, h: number, f: (x: number, y: number) => number): GrayImage {
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = f(x, y);
  return { width: w, height: h, data };
}

/** A plus-shaped mark, 7 px across, at (cx, cy); `smudge` lowers its contrast and adds a blot beside it. */
function mark(x: number, y: number, cx: number, cy: number, smudge = false): number {
  const dx = Math.abs(x - cx);
  const dy = Math.abs(y - cy);
  if ((dx <= 3 && dy <= 0) || (dy <= 3 && dx <= 0)) return smudge ? 80 : 30;
  if (smudge && x - cx === 2 && y - cy === 2) return 20;
  return -1;
}

/** Two marks: A at x = a and its look-alike B at x = b, which has a dot of its own (no two real marks are identical). */
function twoMarks(w: number, h: number, a: number, b: number, smudgeA = false): GrayImage {
  return gray(w, h, (x, y) => {
    const ma = mark(x, y, a, 30, smudgeA);
    if (ma >= 0) return ma;
    const mb = mark(x, y, b, 30);
    if (mb >= 0) return mb;
    if (x === b - 2 && y === 28) return 120;
    return 200 + ((x * 7 + y * 13) % 5);
  });
}

describe("forward-backward check (point tracker)", () => {
  // Frame 0: the tracked mark A at x 40 and a look-alike B at x 28. Frame 1: both moved +6, A smudged.
  const f0 = twoMarks(90, 60, 40, 28);
  const f1 = twoMarks(90, 60, 46, 34, true);
  const opts = { patchSize: 11, searchRadius: 10, minConfidence: 0.6, adaptBelow: 0.8 };

  it("follows the look-alike without the check", () => {
    const t = new PointTracker(f0, 40, 30, opts);
    const s = t.step(f1)!;
    expect(s).not.toBeNull();
    expect(s.x).toBeCloseTo(34, 0);
  });

  it("calls the point lost when the match, searched back, lands on the other mark", () => {
    const t = new PointTracker(f0, 40, 30, { ...opts, fbMaxPx: 2 });
    expect(t.step(f1)).toBeNull();
    expect(t.lastFb).toBeCloseTo(12, 0);
    expect(t.lastScore).toBeGreaterThan(0.9);
  });

  it("passes a true match and reports its round trip", () => {
    const g1 = twoMarks(90, 60, 46, 34);
    const t = new PointTracker(f0, 40, 30, { ...opts, fbMaxPx: 2 });
    const s = t.step(g1)!;
    expect(s.x).toBeCloseTo(46, 0);
    expect(s.fb_px).toBeLessThan(0.5);
  });

  it("does not check a step taken from a predicted position (nothing was measured there)", () => {
    const t = new PointTracker(f0, 40, 30, { ...opts, fbMaxPx: 2 });
    t.relocate(34, 30);
    const s = t.step(f1, { x: 34, y: 30 });
    expect(s).not.toBeNull();
    expect(s!.fb_px).toBeUndefined();
  });

  it("restores the frame with the motion, so a point stepped again on the same frame is still checked", () => {
    const t = new PointTracker(f0, 40, 30, { ...opts, fbMaxPx: 2 });
    const m = t.motion;
    expect(t.step(f1)).toBeNull();
    t.restoreMotion(m);
    expect(t.step(f1)).toBeNull();
    expect(t.lastFb).toBeCloseTo(12, 0);
  });
});

describe("light normalisation (local contrast)", () => {
  it("evens out light that adds and light that multiplies, and keeps the texture", () => {
    const w = 160;
    const h = 40;
    // A fine checker of +-10 on a slow ramp of light, and under a shadow over the right half that halves everything.
    const img = gray(w, h, (x, y) => {
      const lit = 80 + x * 0.6 + ((((x >> 1) + (y >> 1)) % 2) ? 10 : -10);
      return x >= 80 ? lit * 0.5 : lit;
    });
    const out = normalizeLight(img, 6);
    const stats = (x0: number, x1: number) => {
      let mean = 0;
      let dev = 0;
      let n = 0;
      for (let y = 14; y < 26; y++) {
        for (let x = x0; x < x1; x++) {
          const v = out.data[y * w + x];
          mean += v;
          dev += Math.abs(v - 128);
          n++;
        }
      }
      return { mean: mean / n, dev: dev / n };
    };
    const bright = stats(20, 60);
    const shade = stats(100, 140);
    expect(bright.mean).toBeCloseTo(128, 0);
    expect(shade.mean).toBeCloseTo(128, 0);
    // The texture comes out nearly as strong in the shadow as in the light (a plain high-pass would leave it at
    // half; the 4-level floor that keeps flat noise down leaves a half-contrast texture about 16% weaker here).
    expect(bright.dev).toBeGreaterThan(25);
    expect(Math.abs(shade.dev - bright.dev) / bright.dev).toBeLessThan(0.25);
    // Off, or under 1 px: the frame as it is; a flat frame is all mid-grey.
    expect(normalizeLight(img, 0)).toBe(img);
    expect(normalizeLight(img, 0.4)).toBe(img);
    expect(Array.from(normalizeLight(gray(20, 20, () => 77), 3).data).every((v) => Math.abs(v - 128) < 1e-3)).toBe(true);
  });
});
