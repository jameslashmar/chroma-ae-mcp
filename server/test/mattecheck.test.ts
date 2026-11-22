/** ae_matte_check's judgement of an alpha: holes, garbage, veil, edge width and chatter. */
import { describe, expect, it } from "vitest";
import { analyseMatte, edgeChatter } from "../src/tools/ext/mattecheck.js";

const W = 200;
const H = 150;
/** A disc of radius r with a linear soft edge `soft` px wide (alpha 1 inside, 0 outside). */
function disc(r: number, soft = 4, cx = 100, cy = 75): Float32Array {
  const a = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
    a[y * W + x] = Math.max(0, Math.min(1, (r + soft / 2 - d) / soft));
  }
  return a;
}
const fill = (a: Float32Array, x0: number, y0: number, s: number, v: number) => {
  for (let y = y0; y < y0 + s; y++) for (let x = x0; x < x0 + s; x++) a[y * W + x] = v;
};

describe("matte check", () => {
  it("finds holes in the subject, garbage outside it and a veil away from it", () => {
    const a = disc(40);
    fill(a, 90, 70, 3, 0); // a small hole
    fill(a, 110, 60, 5, 0); // a bigger one
    fill(a, 10, 10, 3, 1); // three specks of garbage
    fill(a, 180, 20, 4, 1);
    fill(a, 15, 130, 3, 1);
    for (let y = 100; y < 140; y++) for (let x = 150; x < 190; x++) a[y * W + x] = 0.1; // a faint veil
    const m = analyseMatte(a, W, H);
    expect(m.holes.count).toBe(2);
    expect(m.holes.largest[0].px).toBe(25);
    expect(m.garbage.count).toBe(3);
    expect(m.veil_px).toBeGreaterThan(1000);
    // Holes are counted as holes, not as a see-through core.
    expect(m.core_not_solid).toBe(0);
  });

  it("a see-through core (alpha 0.7 inside) is reported as not solid", () => {
    const a = disc(40);
    for (let y = 60; y < 90; y++) for (let x = 85; x < 115; x++) a[y * W + x] = 0.7;
    const m = analyseMatte(a, W, H);
    expect(m.holes.count).toBe(0);
    expect(m.core_not_solid).toBeGreaterThan(0.15);
  });

  it("measures the soft edge's width and a clean matte as clean", () => {
    const hard = analyseMatte(disc(40, 1), W, H);
    const soft = analyseMatte(disc(40, 8), W, H);
    expect(hard.holes.count).toBe(0);
    expect(hard.garbage.count).toBe(0);
    expect(hard.veil_px).toBe(0);
    expect(hard.core_not_solid).toBe(0);
    expect(soft.edge_width_px).toBeGreaterThan(hard.edge_width_px * 3);
    expect(soft.edge_width_px).toBeGreaterThan(5);
    expect(soft.edge_width_px).toBeLessThan(10);
  });

  it("an edge that goes in and out chatters; one that grows steadily does not", () => {
    expect(edgeChatter(disc(40), disc(41.5), disc(40))).toBeGreaterThan(0.2);
    expect(edgeChatter(disc(40), disc(41.5), disc(43))).toBeLessThan(0.02);
  });
});
