import { describe, expect, it } from "vitest";
import { applyH, invertH, mulH, translationH, type Mat3, type Vec2 } from "../src/tools/ext/planar-math.js";
import { MIN_SURFACE_POINTS, SurfacePoints } from "../src/tools/ext/surface-points.js";
import type { GrayImage } from "../src/tools/ext/track.js";

const W = 640;
const H = 480;

// A flat grey wall with noise and dark "+" marks, as a function of wall coordinates.
const noise = (x: number, y: number) => {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return (s - Math.floor(s)) * 6 - 3;
};
function wall(marks: Vec2[]) {
  return (x: number, y: number): number => {
    for (const [cx, cy] of marks) {
      const dx = Math.abs(x - cx);
      const dy = Math.abs(y - cy);
      if ((dx < 11 && dy < 2.5) || (dy < 11 && dx < 2.5)) return 60;
    }
    return 150;
  };
}

/** The wall seen through `Hw` (wall -> image), 2 x 2 supersampled; `extra` marks are drawn where they are in the image, not on the wall. */
function render(Hw: Mat3, marks: Vec2[], extra: Vec2[] = []): GrayImage {
  const inv = invertH(Hw) as Mat3;
  const f = wall(marks);
  const g = wall(extra);
  const data = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = 0;
      for (const [ox, oy] of [[-0.25, -0.25], [0.25, -0.25], [-0.25, 0.25], [0.25, 0.25]]) {
        const p = applyH(inv, [x + ox, y + oy]) as Vec2;
        const a = f(p[0], p[1]);
        v += extra.length && g(x + ox, y + oy) < 100 ? 60 : a;
      }
      data[y * W + x] = v / 4 + noise(x, y);
    }
  }
  return { width: W, height: H, data };
}

const MARKS: Vec2[] = [];
for (let j = 0; j < 3; j++) for (let i = 0; i < 4; i++) MARKS.push([130 + 120 * i + (j % 2) * 30, 120 + 110 * j]);
const fullMask = () => {
  const m = new Float32Array(W * H);
  for (let y = 40; y < H - 40; y++) for (let x = 40; x < W - 40; x++) m[y * W + x] = 1;
  return m;
};
const I: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
// The camera moved: a shift, a little zoom and some perspective.
const MOVED: Mat3 = [1.03, 0.02, 6, -0.01, 1.02, -4, 0.00004, -0.00002, 1];

describe("SurfacePoints: a region track checked against the surface's own marks", () => {
  const ref = render(I, MARKS);
  const sp = new SurfacePoints(ref, fullMask());

  it("finds the marks as its points", () => {
    expect(sp.count).toBeGreaterThanOrEqual(10);
  });

  it("a right track: the marks sit where it puts them", () => {
    const frame = render(MOVED, MARKS);
    const c = sp.check(frame, MOVED)!;
    expect(c.matched).toBeGreaterThanOrEqual(10);
    expect(c.px).toBeLessThan(0.3);
  });

  it("a track 3 px off: measured at about 3 px", () => {
    const frame = render(MOVED, MARKS);
    const c = sp.check(frame, mulH(MOVED, translationH(3, 0)))!;
    expect(c.px).toBeGreaterThan(2.6);
    expect(c.px).toBeLessThan(3.4);
  });

  it("a track whose perspective is wrong (right in the middle, off at the sides) is over the limit", () => {
    const frame = render(MOVED, MARKS);
    const wrong = mulH(MOVED, [1, 0, 0, 0, 1, 0, 0.00003, 0, 1] as Mat3);
    expect(sp.check(frame, wrong)!.px).toBeGreaterThan(1.5);
  });

  it("marks that are not on the wall (a stand in front, moving its own way) are outvoted", () => {
    // At the reference frame two of the marks are on stands in front; in the frame they have moved 9 px against the wall.
    const onStands: Vec2[] = [MARKS[1], MARKS[6]];
    const wallOnly = MARKS.filter((m) => !onStands.includes(m));
    const ref2 = render(I, wallOnly, onStands);
    const sp2 = new SurfacePoints(ref2, fullMask());
    const moved = onStands.map((p) => applyH(MOVED, [p[0] + 9, p[1] - 4]) as Vec2);
    const frame = render(MOVED, wallOnly, moved);
    const c = sp2.check(frame, MOVED)!;
    expect(c.used).toBeLessThan(c.matched);
    expect(c.px).toBeLessThan(0.3);
  });

  it("fewer than 4 marks: no check", () => {
    const few = new SurfacePoints(render(I, MARKS.slice(0, 3)), fullMask());
    expect(few.count).toBeLessThan(MIN_SURFACE_POINTS);
    expect(few.check(render(MOVED, MARKS.slice(0, 3)), MOVED)).toBeNull();
  });
});
