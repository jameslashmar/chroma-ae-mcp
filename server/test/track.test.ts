import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import {
  AeTrackPointSchema,
  drawTrackPreview,
  extractPatch,
  makeTemplate,
  matchTemplate,
  PointTracker,
  toGray,
  trackTimes,
  type GrayImage,
  type TrackOptions,
} from "../src/tools/ext/track.js";
import { ALL_TOOLS } from "../src/tools/registry.js";

const W = 320;
const H = 200;

// Deterministic noise, so the background has texture but no pattern.
function noise(x: number, y: number): number {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return (s - Math.floor(s)) * 40;
}

/** A textured disc of radius 24 centred at (cx, cy), drawn analytically so sub-pixel motion is real. */
function frameWithDisc(cx: number, cy: number, opts: { hidden?: boolean } = {}): GrayImage {
  const data = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const inside = !opts.hidden && dx * dx + dy * dy < 24 * 24;
      data[y * W + x] = inside ? 128 + 70 * Math.sin(dx * 0.35) * Math.cos(dy * 0.3) + 20 * Math.sin((dx + dy) * 0.2) : 60 + noise(x, y);
    }
  }
  return { width: W, height: H, data };
}

const OPTS: TrackOptions = { patchSize: 21, searchRadius: 12, minConfidence: 0.6, adaptBelow: 0.8 };

describe("tracking core", () => {
  it("is registered", () => {
    expect(ALL_TOOLS.some((t) => t.name === "ae_track_point")).toBe(true);
  });

  it("converts RGBA to luminance", () => {
    const png = new PNG({ width: 2, height: 1 });
    png.data.set([255, 255, 255, 255, 0, 255, 0, 255]);
    const g = toGray(png);
    expect(g.data[0]).toBeCloseTo(255, 3);
    expect(g.data[1]).toBeCloseTo(0.7152 * 255, 3);
  });

  it("finds a pattern at a sub-pixel offset", () => {
    const a = frameWithDisc(150, 100);
    const b = frameWithDisc(153.4, 98.3);
    const tpl = makeTemplate(extractPatch(a, 150, 100, 21)!);
    const m = matchTemplate(b, tpl, 150, 100, 8)!;
    expect(m.x).toBeCloseTo(153.4, 0);
    expect(Math.abs(m.x - 153.4)).toBeLessThan(0.25);
    expect(Math.abs(m.y - 98.3)).toBeLessThan(0.25);
    expect(m.score).toBeGreaterThan(0.95);
  });

  it("follows a curved, accelerating path to within a quarter pixel", () => {
    const pathAt = (i: number) => ({ x: 80 + 6 * i + 0.15 * i * i, y: 100 + 30 * Math.sin(i * 0.2) });
    const p0 = pathAt(0);
    const tracker = new PointTracker(frameWithDisc(p0.x, p0.y), p0.x, p0.y, OPTS);
    let worst = 0;
    for (let i = 1; i <= 20; i++) {
      const p = pathAt(i);
      const s = tracker.step(frameWithDisc(p.x, p.y))!;
      expect(s).not.toBeNull();
      worst = Math.max(worst, Math.hypot(s.x - p.x, s.y - p.y));
    }
    expect(worst).toBeLessThan(0.25);
  });

  it("reports the point lost when it disappears", () => {
    const tracker = new PointTracker(frameWithDisc(150, 100), 150, 100, OPTS);
    expect(tracker.step(frameWithDisc(152, 100))).not.toBeNull();
    expect(tracker.step(frameWithDisc(154, 100, { hidden: true }))).toBeNull();
  });

  it("refuses a flat pattern and one that leaves the frame", () => {
    const flat: GrayImage = { width: W, height: H, data: new Float32Array(W * H).fill(90) };
    expect(() => new PointTracker(flat, 150, 100, OPTS)).toThrow(/almost flat/);
    expect(() => new PointTracker(frameWithDisc(150, 100), 3, 100, OPTS)).toThrow(/outside the frame/);
  });

  it("lists one time per frame, forwards or backwards, capped", () => {
    expect(trackTimes(0, 0.2, 25, 100)).toEqual([0, 0.04, 0.08, 0.12, 0.16, 0.2]);
    expect(trackTimes(0.2, 0.1, 25, 100)).toEqual([0.2, 0.16, 0.12]);
    expect(trackTimes(0, 10, 25, 7)).toHaveLength(7);
  });

  it("draws a preview at most 960 px wide", () => {
    const png = new PNG({ width: 1920, height: 1080 });
    const img = drawTrackPreview(png, [{ x: 100, y: 100 }, { x: 400, y: 300 }], 31, false);
    expect(img.width).toBe(960);
    expect(img.height).toBe(540);
  });

  it("validates its arguments", () => {
    expect(AeTrackPointSchema.safeParse({ comp_id: 1, point: [10, 10] }).success).toBe(true);
    expect(AeTrackPointSchema.safeParse({ comp_id: 1, point: [10] }).success).toBe(false);
    expect(AeTrackPointSchema.safeParse({ comp_id: 1, point: [10, 10], apply: { null_name: "T" } }).success).toBe(false);
  });
});

describe("pattern size against sliding", () => {
  /** A dark 22 x 42 marker (a strip of tape) on a noisy green-grey cloth, centred at (cx, cy). */
  function markerFrame(cx: number, cy: number): GrayImage {
    const data = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        // Coverage of the pixel by the marker, for sub-pixel motion.
        const cov = (a: number, lo: number, hi: number) => Math.max(0, Math.min(a + 0.5, hi) - Math.max(a - 0.5, lo));
        const m = cov(x, cx - 11, cx + 11) * cov(y, cy - 21, cy + 21);
        data[y * W + x] = 150 + 0.15 * noise(x, y) - 100 * m;
      }
    }
    return { width: W, height: H, data };
  }

  it("grows a pattern shorter than the mark it sits on, and keeps a given size with a note", async () => {
    const { choosePatternSize, patternIsotropy, MIN_PATTERN_ISOTROPY } = await import("../src/tools/ext/track.js");
    const f = markerFrame(160, 100);
    expect(patternIsotropy(f, 160, 100, 31)!).toBeLessThan(MIN_PATTERN_ISOTROPY);
    const auto = choosePatternSize(f, 160, 100, 31, false);
    expect(auto.size).toBeGreaterThan(31);
    expect(auto.isotropy!).toBeGreaterThanOrEqual(MIN_PATTERN_ISOTROPY);
    expect(auto.note).toMatch(/slide/);
    const given = choosePatternSize(f, 160, 100, 31, true);
    expect(given.size).toBe(31);
    expect(given.note).toMatch(/larger pattern_size/);
    // A textured disc holds at once: no note.
    expect(choosePatternSize(frameWithDisc(160, 100), 160, 100, 31, false)).toMatchObject({ size: 31 });
    expect(choosePatternSize(frameWithDisc(160, 100), 160, 100, 31, false).note).toBeUndefined();
  });

  it("follows the marker within half a pixel with the size it chose", async () => {
    const { choosePatternSize } = await import("../src/tools/ext/track.js");
    const f0 = markerFrame(160, 100);
    const size = choosePatternSize(f0, 160, 100, 31, false).size;
    const tr = new PointTracker(f0, 160, 100, { patchSize: size, searchRadius: 12, minConfidence: 0.6, adaptBelow: 0.8 });
    let worst = 0;
    for (let i = 1; i <= 20; i++) {
      const cx = 160 + 0.7 * i;
      const cy = 100 + 1.3 * Math.sin(i / 3) + 0.4 * i;
      const s = tr.step(markerFrame(cx, cy))!;
      worst = Math.max(worst, Math.hypot(s.x - cx, s.y - cy));
    }
    expect(worst).toBeLessThan(0.5);
  });
});
