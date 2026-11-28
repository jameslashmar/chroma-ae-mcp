import { describe, expect, it } from "vitest";
import { checkPaths, CORNER_JUMP_PX, CORNER_OFF_PX, type PathSample } from "../src/tools/ext/path-check.js";
import type { Vec2 } from "../src/tools/ext/planar-math.js";

// A 16:10 screen, 600 px wide, moved by a camera: a slow pan and zoom, a turn, a slowly changing
// perspective, and (when `shake`) footstep jolts of the whole surface every 20 frames.
const BASE: Vec2[] = [
  [-300, -187.5],
  [300, -187.5],
  [300, 187.5],
  [-300, 187.5],
];

function corners(i: number, shake: boolean): Vec2[] {
  const jolt = shake ? Math.exp(-(((i % 20) - 3) ** 2) / 2) : 0;
  const tx = 960 + 2.5 * i + 22 * jolt;
  const ty = 540 + 0.8 * i - 15 * jolt;
  const s = 1 + 0.002 * i + 0.01 * jolt;
  const a = 0.002 * i + 0.004 * jolt;
  const persp = 0.00004 * Math.sin(i / 30);
  return BASE.map(([x, y]) => {
    const w = 1 + persp * x;
    const xr = (Math.cos(a) * x - Math.sin(a) * y) * s;
    const yr = (Math.sin(a) * x + Math.cos(a) * y) * s;
    return [tx + xr / w, ty + yr / w] as Vec2;
  });
}

const run = (n: number, shake: boolean, bend?: (i: number, p: Vec2[]) => Vec2[]): PathSample[] =>
  Array.from({ length: n }, (_, i) => {
    const p = corners(i, shake);
    return { frame: i, points: bend ? bend(i, p) : p };
  });

describe("checkPaths", () => {
  it("leaves a smooth track alone, footstep jolts of the whole surface included", () => {
    const res = checkPaths(run(120, true))!;
    expect(res.frames_checked).toBe(120);
    expect(res.flags).toEqual([]);
    // The jolts are there, and reported as the sharpest move only.
    expect(res.whole.worst_px).toBeGreaterThan(5);
  });

  it("flags one corner that jumps for one frame, at that frame only", () => {
    const res = checkPaths(run(120, true, (i, p) => (i === 60 ? p.map((q, k) => (k === 1 ? ([q[0], q[1] - 2] as Vec2) : q)) : p)))!;
    expect(res.flags.length).toBeGreaterThan(0);
    expect(res.flags.map((f) => f.frame)).toEqual([60]);
    expect(res.flags[0].kind).toBe("jump");
    expect(res.flags[0].px).toBeGreaterThan(CORNER_JUMP_PX);
  });

  it("flags a top edge flicking between two parallel edges 2 px apart", () => {
    const res = checkPaths(run(120, false, (i, p) => (i >= 40 && i < 80 && i % 3 === 0 ? p.map((q, k) => (k < 2 ? ([q[0], q[1] - 2] as Vec2) : q)) : p)))!;
    const frames = new Set(res.flags.map((f) => f.frame));
    for (let i = 42; i < 78; i += 3) expect(frames.has(i)).toBe(true);
    expect([...frames].every((f) => f >= 40 && f < 80 && f % 3 === 0)).toBe(true);
  });

  it("flags an edge dragged 12 px in over 8 frames and back, as off its path", () => {
    // A hand's edge taken for the screen's: the right edge eases in and out.
    const pull = (i: number) => (i >= 70 && i < 78 ? 12 * Math.sin(((i - 69) / 9) * Math.PI) : 0);
    const res = checkPaths(run(150, true, (i, p) => p.map((q, k) => (k === 1 || k === 2 ? ([q[0] - pull(i), q[1]] as Vec2) : q))))!;
    const frames = new Set(res.flags.map((f) => f.frame));
    for (let i = 72; i <= 75; i++) expect(frames.has(i)).toBe(true);
    expect([...frames].every((f) => f >= 69 && f <= 78)).toBe(true);
    expect(res.flags.find((f) => f.frame === 73)!.kind).toBe("off_path");
    expect(res.per_corner[1].worst_off_px).toBeGreaterThan(CORNER_OFF_PX);
  });

  it("does not flag a board turned edge-on and back in the hand, and reports those frames as too fast to check", () => {
    // A 400 x 500 board held up and turned about its vertical axis: 60 degrees away and back within 24
    // frames (its width 400 -> 200 -> 400), with the near side growing in perspective, and a slow sway.
    const W = 200;
    const H = 250;
    const turnAt = (i: number) => (Math.abs(i - 60) < 12 ? (Math.PI / 3) * 0.5 * (1 + Math.cos((Math.PI * (i - 60)) / 12)) : 0);
    const samples: PathSample[] = Array.from({ length: 140 }, (_, i) => {
      const th = turnAt(i);
      const pts: Vec2[] = [
        [-W, -H],
        [W, -H],
        [W, H],
        [-W, H],
      ].map(([x, y]) => {
        const z = 1500 + Math.sin(th) * x;
        const f = 1500;
        return [640 + 3 * Math.sin(i / 15) + (f * Math.cos(th) * x) / z, 400 + (f * y) / z] as Vec2;
      });
      return { frame: i, points: pts };
    });
    const res = checkPaths(samples)!;
    expect(res.flags).toEqual([]);
    expect(res.fast_frames).toBeGreaterThan(5);
    expect(res.fast_ranges.every(([a, b]) => a >= 40 && b <= 80)).toBe(true);
    // The same path with the drag of the test above, on a steady stretch: still found.
    const pull = (i: number) => (i >= 100 && i < 108 ? 12 * Math.sin(((i - 99) / 9) * Math.PI) : 0);
    const bent = checkPaths(samples.map((s) => ({ frame: s.frame, points: s.points.map((q, k) => (k === 1 || k === 2 ? ([q[0] - pull(s.frame), q[1]] as Vec2) : q)) })))!;
    expect(bent.flags.some((fl) => fl.frame >= 102 && fl.frame <= 105)).toBe(true);
  });

  it("raises its limits on a shot whose corners are noisy throughout, instead of flagging every frame", () => {
    let seed = 3;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
    const res = checkPaths(run(150, false, (_i, p) => p.map((q) => [q[0] + 1.2 * rnd(), q[1] + 1.2 * rnd()] as Vec2)))!;
    expect(res.jump_limit_px).toBeGreaterThan(CORNER_JUMP_PX);
    expect(res.flags.length).toBeLessThan(8);
  });

  it("scales its limits with the comp, and needs 9 frames", () => {
    expect(checkPaths(run(8, false))).toBeNull();
    const res = checkPaths(run(60, false), { compHeight: 2160 })!;
    expect(res.jump_limit_px).toBeCloseTo(2 * CORNER_JUMP_PX, 5);
    expect(res.off_limit_px).toBeCloseTo(2 * CORNER_OFF_PX, 5);
  });
});
