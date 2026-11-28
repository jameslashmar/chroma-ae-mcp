import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { applyH, invertH, mulH, type Mat3, type Vec2 } from "../src/tools/ext/planar-math.js";
import { fitScreenQuad, keyAlpha, keyStrength, ransacLine, redetectQuad, sampleKey, ScreenTracker } from "../src/tools/ext/screen-track.js";

// ---------- a green laptop screen in a dark bezel, under a known perspective motion ----------

const W = 360;
const H = 260;
/** The screen at the reference frame (image px), [UL, UR, LR, LL]. */
const SCREEN: Vec2[] = [[90.3, 60.6], [270.2, 70.4], [262.7, 190.1], [95.5, 182.8]];

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

const grow = (q: Vec2[], px: number): Vec2[] => {
  const cx = q.reduce((s, p) => s + p[0], 0) / 4;
  const cy = q.reduce((s, p) => s + p[1], 0) / 4;
  return q.map((p) => {
    const d = Math.hypot(p[0] - cx, p[1] - cy);
    return [p[0] + ((p[0] - cx) / d) * px, p[1] + ((p[1] - cy) / d) * px] as Vec2;
  });
};
const BEZEL = grow(SCREEN, 14);

const motion = (k: number): Mat3 => {
  const r = (0.8 * k * Math.PI) / 180;
  const c = [180, 125];
  const R: Mat3 = [Math.cos(r), -Math.sin(r), 0, Math.sin(r), Math.cos(r), 0, 0, 0, 1];
  const T1: Mat3 = [1, 0, -c[0], 0, 1, -c[1], 0, 0, 1];
  const T2: Mat3 = [1, 0, c[0] + 3.1 * k, 0, 1, c[1] - 1.7 * k, 0, 0, 1];
  const P: Mat3 = [1 + 0.004 * k, 0, 0, 0, 1, 0, 0.00005 * k, 0.00002 * k, 1];
  return mulH(T2, mulH(P, mulH(R, T1)));
};

/** 4x supersampled, so the edges are anti-aliased like a real render. `hand`: a skin-coloured block over the frame. */
function render(k: number, o: { hand?: { x: number; y: number; w: number; h: number }; picture?: boolean } = {}): PNG {
  const inv = invertH(motion(k))!;
  const png = new PNG({ width: W, height: H });
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const px = x - 0.375 + sx * 0.25;
          const py = y - 0.375 + sy * 0.25;
          const p = applyH(inv, [px, py]) as Vec2;
          let c: [number, number, number];
          if (o.hand && px >= o.hand.x && px < o.hand.x + o.hand.w && py >= o.hand.y && py < o.hand.y + o.hand.h) c = [205, 150, 120];
          else if (inside(SCREEN, p)) c = o.picture ? [120 + 80 * Math.sin(p[0] * 0.2), 110 + 70 * Math.cos(p[1] * 0.17), 100] : [40 + 0.1 * p[0], 170 - 0.05 * p[1], 50];
          else if (inside(BEZEL, p)) c = [28, 30, 32];
          else c = [150 + 40 * Math.sin(px * 0.05), 140, 130 + 30 * Math.cos(py * 0.07)];
          r += c[0];
          g += c[1];
          b += c[2];
        }
      }
      const i = (y * W + x) * 4;
      png.data[i] = Math.round(r / 16);
      png.data[i + 1] = Math.round(g / 16);
      png.data[i + 2] = Math.round(b / 16);
      png.data[i + 3] = 255;
    }
  }
  return png;
}

const cornerErr = (q: Vec2[], truth: Vec2[]) => Math.max(...q.map((p, i) => Math.hypot(p[0] - truth[i][0], p[1] - truth[i][1])));
const truthAt = (k: number) => SCREEN.map((p) => applyH(motion(k), p) as Vec2);

describe("screen key", () => {
  const ref = render(0);

  it("reads a green screen's key and refuses a screen showing a picture", () => {
    const key = sampleKey(ref, SCREEN);
    expect(key).not.toBeNull();
    expect(key!.chroma[1]).toBeGreaterThan(0.5);
    expect(sampleKey(render(0, { picture: true }), SCREEN)).toBeNull();
  });

  it("snaps rough corners to the key edge to a fraction of a pixel", () => {
    const key = sampleKey(ref, SCREEN)!;
    const rough = SCREEN.map((p, i) => [p[0] + (i % 2 ? 4 : -3), p[1] + (i < 2 ? -3 : 4)] as Vec2);
    const fit = fitScreenQuad(keyStrength(ref, key, [0, 0, W, H]), rough, 12);
    expect(fit.ok).toBe(true);
    expect(cornerErr(fit.corners, SCREEN)).toBeLessThan(0.3);
    expect(fit.expected_px).toBeGreaterThan(0);
  });

  it("finds a line through outliers", () => {
    const pts: Vec2[] = [];
    for (let i = 0; i < 40; i++) pts.push([i * 5, 10 + 0.2 * i * 5 + (i % 2 ? 0.1 : -0.1)]);
    for (let i = 0; i < 15; i++) pts.push([i * 7, 60 + i]);
    const line = ransacLine(pts)!;
    expect(line.inliers).toBeGreaterThanOrEqual(38);
    expect(Math.abs(line.dir[1] / line.dir[0] - 0.2)).toBeLessThan(0.01);
  });
});

describe("ScreenTracker", () => {
  const ref = render(0);
  const key = sampleKey(ref, SCREEN)!;

  it("follows the screen with a hand across one side, corners within 0.3 px", () => {
    const tr = new ScreenTracker(key, SCREEN);
    for (let k = 1; k <= 10; k++) {
      // A hand covers the middle of the right side from frame 4 on.
      const t = truthAt(k);
      const hand = k >= 4 ? { x: (t[1][0] + t[2][0]) / 2 - 20, y: (t[1][1] + t[2][1]) / 2 - 22, w: 60, h: 44 } : undefined;
      const s = tr.step(render(k, { hand }));
      expect(s.ok).toBe(true);
      expect(cornerErr(s.corners!, t)).toBeLessThan(0.3);
      expect(s.support).toBeGreaterThan(0.25);
    }
  });

  it("reports a frame without the screen, and finds it again", () => {
    const tr = new ScreenTracker(key, SCREEN);
    for (let k = 1; k <= 3; k++) expect(tr.step(render(k)).ok).toBe(true);
    const blank = new PNG({ width: W, height: H });
    blank.data.fill(90);
    const a = tr.step(blank);
    expect(a.ok).toBe(false);
    expect(a.note).toMatch(/edge was not found|not found/);
    const back = tr.step(render(5));
    expect(back.ok).toBe(true);
    expect(cornerErr(back.corners!, truthAt(5))).toBeLessThan(0.5);
  });

  it("re-detects the screen from the keyed area when the prediction is far off", () => {
    const alpha = keyAlpha(render(6), key, [0, 0, W, H]);
    const q = redetectQuad(alpha, SCREEN);
    expect(q).not.toBeNull();
    expect(cornerErr(q!, truthAt(6))).toBeLessThan(4);
  });
});
