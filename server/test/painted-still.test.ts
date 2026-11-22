/** The reload check of a painted still (ae_cleanplate_setup action reload): paint, colour shift, offset, size. */
import { describe, expect, it } from "vitest";
import { checkPaintedStill } from "../src/tools/ext/cleanplate.js";

const W = 200;
const H = 150;
let seed = 11;
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
function texture(w = W, h = H) {
  const data = new Uint8Array(w * h * 4);
  // Smooth-ish texture: sums of a few sines plus noise, so a shift is measurable.
  const fx = [rnd() * 0.3, rnd() * 0.3, rnd() * 0.3];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = 128 + 50 * Math.sin(x * fx[0] + y * fx[1]) + 40 * Math.sin(x * fx[2] * 0.7 - y * 0.21) + (rnd() - 0.5) * 20;
    const k = (y * w + x) * 4;
    data[k] = data[k + 1] = data[k + 2] = Math.max(0, Math.min(255, Math.round(v)));
    data[k + 3] = 255;
  }
  return { width: w, height: h, data };
}
const copy = (img: ReturnType<typeof texture>) => ({ ...img, data: Uint8Array.from(img.data) });

describe("painted still check", () => {
  const orig = texture();

  it("paint in one area is fine, and where it is comes back", () => {
    const p = copy(orig);
    for (let y = 60; y < 90; y++) for (let x = 80; x < 120; x++) for (let c = 0; c < 3; c++) p.data[(y * W + x) * 4 + c] = 30;
    const r = checkPaintedStill(orig, p);
    expect(r.verdict).toBe("ok");
    expect(r.offset_px).toBeNull();
    expect(r.changed_bbox![0]).toBeGreaterThanOrEqual(78);
    expect(r.changed_bbox![2]).toBeLessThanOrEqual(122);
  });

  it("a colour shift everywhere is caught", () => {
    const p = copy(orig);
    for (let k = 0; k < p.data.length; k += 4) p.data[k] = Math.min(255, p.data[k] + 5);
    const r = checkPaintedStill(orig, p);
    expect(r.verdict).toBe("check");
    expect(r.colour_shift_levels![0]).toBeGreaterThan(4);
  });

  it("the whole picture moved is caught with the offset", () => {
    const p = copy(orig);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const sx = Math.max(0, Math.min(W - 1, x - 2));
      const sy = Math.max(0, Math.min(H - 1, y - 1));
      for (let c = 0; c < 4; c++) p.data[(y * W + x) * 4 + c] = orig.data[(sy * W + sx) * 4 + c];
    }
    const r = checkPaintedStill(orig, p);
    expect(r.verdict).toBe("check");
    expect(r.offset_px).toEqual([2, 1]);
  });

  it("a resized still and an untouched one are both flagged", () => {
    expect(checkPaintedStill(orig, texture(W + 10, H)).findings[0]).toMatch(/resized/);
    expect(checkPaintedStill(orig, copy(orig)).findings.join(" ")).toMatch(/Nothing changed/);
  });
});
