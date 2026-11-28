/** The offset clone as a Corner Pin (cleanplate.ts clonePins): the cloned content lands on the hole under rotation, zoom and a time offset. */
import { describe, expect, it } from "vitest";
import { clonePins } from "../src/tools/ext/cleanplate.js";
import { applyH, invertH, mulH, solveModel, type Mat3, type PlanarFrame, type PlanarTrack, type Vec2 } from "../src/tools/ext/planar-math.js";

/** A shot that pans, turns 0.4 degrees and zooms 0.5% per frame about the frame centre. */
function sim(i: number): Mat3 {
  const th = (0.4 * i * Math.PI) / 180;
  const s = 1 + 0.005 * i;
  const c = [480, 270];
  const R: Mat3 = [s * Math.cos(th), -s * Math.sin(th), 0, s * Math.sin(th), s * Math.cos(th), 0, 0, 0, 1];
  return mulH([1, 0, c[0] + 3 * i, 0, 1, c[1] + i, 0, 0, 1], mulH(R, [1, 0, -c[0], 0, 1, -c[1], 0, 0, 1]));
}

describe("clone pins", () => {
  const frames: PlanarFrame[] = Array.from({ length: 30 }, (_, i) => ({ time: i / 25, ok: true, H: sim(i), points: [], confidence: [], rms_px: 0, inliers: 4 }));
  const track = { version: 1, track_id: "t", comp_id: 1, comp_size: [960, 540], fps: 25, ref_time: 0, model: "similarity", ref_points: [], frames, source: "test", created: "" } as unknown as PlanarTrack;
  // The plate layer: 1920 x 1080 footage scaled 50% into the comp (layer -> comp).
  const L: Mat3 = [0.5, 0, 0, 0, 0.5, 0, 0, 0, 1];
  const offset = { dx: 120, dy: -40, frames: 6 };

  it("carries the content of y + offset at frame t + k onto y at frame t, for every point", () => {
    const r = clonePins({ track, offset, frames, L, layerSize: [1920, 1080] });
    expect(r.skipped.length).toBe(6); // the last 6 frames have no frame t + 6
    const corners: Vec2[] = [[0, 0], [1920, 0], [0, 1080], [1920, 1080]];
    for (const i of [0, 10, 23]) {
      const pin = [r.pins.ul[i], r.pins.ur[i], r.pins.ll[i], r.pins.lr[i]];
      const CP = solveModel("perspective", corners, pin)!.H;
      for (const y of [[400, 250], [520, 300], [450, 200]] as Vec2[]) {
        // Where the content of ref point y + o sits in the copy's layer space at frame t + k ...
        const q = applyH(invertH(L)!, applyH(sim(i + 6), [y[0] + 120, y[1] - 40])!)!;
        // ... the pin moves it to, shown through the layer's transform:
        const shown = applyH(L, applyH(CP, q)!)!;
        const want = applyH(sim(i), y)!;
        expect(Math.hypot(shown[0] - want[0], shown[1] - want[1])).toBeLessThan(0.01);
      }
    }
  });
});
